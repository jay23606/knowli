import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLesson,
  createLessonDraftFromPublished,
  createLessonFromMaterial,
  createSchoolLesson,
  createServices,
  editLessonDraft,
  executeLessonGeneration,
  lessonCatalog,
  publishLessonDraft,
  readGeneration,
  readLessonDeck,
  regenerateObjective,
  type ReviewerDeps,
  type Services,
} from "@learning/server";
import { LessonExerciseInputSchema, type LessonDraftDto } from "@learning/contracts";
import { stageOf } from "../../packages/server/src/domain/lessons/stages";
import { mergeReviewReport, type LessonReviewReport } from "../../packages/server/src/domain/lessons/review-report";
import { GenerationProviderError } from "../../packages/server/src/ports/generation-error";
import { FakeLessonReviewer } from "../../packages/server/src/providers/fake";
import { exerciseFingerprint } from "../../packages/server/src/modules/materials/lessons/lesson-fingerprint";
import { DEFAULT_LESSON_GENERATION_POLICY, type LessonGenerationPolicy } from "../../packages/server/src/modules/materials/lessons/lesson-generation-policy";
import type { LessonReviewInput } from "../../packages/server/src/ports/ai";
import { fakeGeneration, FakeLlmProvider, routeLessonRound, type FakeGeneration, type LessonPoolRequest } from "./fakes";
import { ManualClock, testDatabase } from "./helpers";

/**
 * Faza przeglądu krytyka w generowaniu lekcji (spec etapu przeglądu §4–§7, PR 2):
 * PostgreSQL, fałszywy generator i fałszywy krytyk wstrzyknięty przez `deps.reviewer`.
 */

const { pool } = testDatabase();

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, params)).rows as T[];
}

const MAIN_BATCH_ONLY: LessonGenerationPolicy = { ...DEFAULT_LESSON_GENERATION_POLICY, stageTopUp: false };
const POLICY: ReviewerDeps["policy"] = { timeoutMs: 60_000, concurrency: 3, maxCallsPerRun: 12, phaseBudgetMs: 240_000 };
const REVIEW_REASON = "odrzucone przez kontrolę jakości";
const EXPOSURE_REASON = "rozwiązanie widoczne wcześniej";

/** Rozdział w trzech zagadnieniach (słowa, słowa, rama). */
const CHAPTER_MATERIAL = [
  "Zagadnienie 1: Ubrania",
  "coat, boots, dress, skirt, t-shirt",
  "Zagadnienie 2: Pogoda",
  "It's raining. It's snowing. What's the weather like?",
  "Zagadnienie 3: Co mam na sobie",
  "I'm wearing a coat. I'm wearing boots.",
].join("\n");
const TWO_OBJECTIVES = CHAPTER_MATERIAL.split("Zagadnienie 3")[0]!;

/** Jedno zagadnienie bez nagłówków — pule sterowane w testach. */
const WEAR_MATERIAL = "I wear a coat. I wear boots. She wears a dress. We wear a skirt.";
const WEAR_TRANSLATION = "We have the coat and the boots";

const SCHOOL_MATERIAL = [
  "Zagadnienie 1: Fotosynteza",
  "Wyjaśnienie: Fotosynteza to proces, w którym roślina z wody i dwutlenku węgla, przy udziale światła, wytwarza cukry. Cukry są pokarmem rośliny.",
  "Zagadnienie 2: Chrzest Polski",
  "Wyjaśnienie: Mieszko I przyjął chrzest w 966 roku. Chrzest włączył państwo do chrześcijańskiej Europy i wzmocnił władzę księcia.",
].join("\n");

type Raw = Record<string, unknown>;

const choice = (objectiveId: string, instructionPl: string, stem: string, answer: string, other: string): Raw => ({
  exerciseType: "lesson_choice", objectiveId, instructionPl, stem,
  options: [{ id: "a", text: answer }, { id: "b", text: other }], correctOption: "a", answer, acceptedAnswers: [], focus: [],
});
const gap = (objectiveId: string, instructionPl: string, stem: string, answer: string): Raw => ({
  exerciseType: "lesson_gap", objectiveId, instructionPl, stem, answer, acceptedAnswers: [], focus: [answer],
});
const translation = (objectiveId: string, prompt: string, answer: string, focus: string): Raw => ({
  exerciseType: "lesson_open_answer", objectiveId, instructionPl: "Przetłumacz na angielski.", prompt, answer, acceptedAnswers: [], focus: [focus],
});

/** Szkic do dogenerowania: wybór, luka i tłumaczenie. */
function wearPool(objectiveId: string): Raw[] {
  return [
    choice(objectiveId, "Mam na sobie płaszcz. Wybierz słowo.", "I wear a ___.", "coat", "dress"),
    gap(objectiveId, "Mam na sobie buty. Wpisz brakujące słowo.", "I wear ___.", "boots"),
    translation(objectiveId, "Mamy płaszcz i buty.", WEAR_TRANSLATION, "coat"),
  ];
}

describe("faza przeglądu krytyka w generowaniu lekcji (integracja)", () => {
  const disposers: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    await pool.query(
      `truncate learning_app.child_profiles, learning_app.parent_sessions, learning_app.parent_credentials,
              learning_app.integration_tokens, learning_app.generation_runs, learning_app.child_objective_progress,
              learning_app.lesson_verdicts, learning_app.revision_assets, learning_app.media_assets,
              learning_app.item_revision_skills, learning_app.item_revisions, learning_app.skill_versions,
              learning_app.learning_items, learning_app.deck_versions, learning_app.decks cascade`,
    );
  });

  afterEach(async () => {
    for (const dispose of disposers.splice(0)) await dispose();
  });

  afterAll(() => pool.end());

  /** Usługi z produkcyjnym rejestrem; krytyk gotowy (domyślnie „wszystko ok”), chyba że podano inny stan. */
  async function world(options: { reviewer?: ReviewerDeps | null; execution?: LessonGenerationPolicy; policy?: Partial<ReviewerDeps["policy"]>; reviewService?: string } = {}) {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const reviewer = new FakeLessonReviewer();
    if (options.reviewer !== null) {
      fakes.deps.reviewer = options.reviewer ?? { state: "ready", provider: reviewer, policy: { ...POLICY, ...options.policy } };
    }
    if (options.execution) fakes.deps.lessonExecution = options.execution;
    const services = createServices({
      db: testDatabase().db, clock: new ManualClock(), media: fakes.settings, generation: fakes.deps,
      ...(options.reviewService ? { reviewService: options.reviewService } : {}),
    });
    return { fakes, services, reviewer };
  }

  async function generateChapter(services: Services, material = CHAPTER_MATERIAL, topicTitlePl = "Unit 1") {
    const { runId, deckId } = await createLessonFromMaterial(services, {
      subjectId: "english_chapter", topicTitlePl, material, poolSize: 40, clientRequestId: randomUUID(),
    });
    await executeLessonGeneration(services, runId);
    expect((await readGeneration(services, runId)).state).toBe("succeeded");
    return { runId, deckId, draft: (await readLessonDeck(services, deckId)).draft! };
  }

  async function regenerate(services: Services, deckId: string, draft: LessonDraftDto, count: number, objectiveId = draft.objectiveIds[0]!) {
    const regen = await regenerateObjective(services, { deckId, objectiveId, count, expectedEditNumber: draft.editNumber, clientRequestId: randomUUID() });
    await executeLessonGeneration(services, regen.runId);
    return { runId: regen.runId, after: (await readLessonDeck(services, deckId)).draft! };
  }

  async function reportOf(versionId: string): Promise<LessonReviewReport | undefined> {
    const [row] = await query<{ review: LessonReviewReport | null }>(
      "select lesson_context->'review' as review from learning_app.deck_versions where id = $1", [versionId],
    );
    return row?.review ?? undefined;
  }

  /** Odciski payloadów z bazy po identyfikatorze elementu (identyfikator w DTO jest opcjonalny w typie). */
  async function dbFingerprints(versionId: string): Promise<Map<string | undefined, string>> {
    const rows = await query<{ item_id: string; payload: Record<string, unknown> }>(
      "select item_id, payload from learning_app.item_revisions where deck_version_id = $1", [versionId],
    );
    return new Map(rows.map((row) => [row.item_id, exerciseFingerprint(row.payload)]));
  }

  function editInputs(exercises: LessonDraftDto["exercises"]) {
    return exercises.map(({ revisionId: _revisionId, explanationAudio: _explanationAudio, sentenceAudio: _sentenceAudio, ...input }) => LessonExerciseInputSchema.parse(input));
  }

  /** Wynik krytyka dla jednego ćwiczenia, reszta „ok”. */
  function verdictsFor(input: LessonReviewInput, verdicts: Record<number, Raw>): unknown[] {
    return input.exercises.map(({ n }) => verdicts[n] ?? { n, verdict: "ok" });
  }

  const shown = (input: LessonReviewInput, n: number): Raw => ({ ...input.exercises[n - 1]!.exercise });
  const nOf = (input: LessonReviewInput, predicate: (exercise: Raw) => boolean) =>
    input.exercises.find(({ exercise }) => predicate(exercise as Raw))!.n;

  /** Szkic po generacji: krytyk poprawia pierwszy wybór (ambiguous) i daje uwagę luce (too_hard). */
  async function fixedDraft(options: { reviewService?: string } = {}) {
    const { fakes, services, reviewer } = await world(options);
    const FIXED = "Zdanie numer 1 ma jedną lukę. Wybierz słowo.";
    reviewer.behavior = (input) => {
      if (reviewer.inputs.length !== 1) return verdictsFor(input, {});
      const choiceN = nOf(input, (exercise) => exercise.exerciseType === "lesson_choice");
      const gapN = nOf(input, (exercise) => exercise.exerciseType === "lesson_gap");
      return verdictsFor(input, {
        [choiceN]: { n: choiceN, verdict: "fix", category: "ambiguous", reasonPl: "Doprecyzowano.", exercise: { ...shown(input, choiceN), instructionPl: FIXED } },
        [gapN]: { n: gapN, verdict: "note", category: "too_hard", reasonPl: "Trudne słowo." },
      });
    };
    const { deckId, draft } = await generateChapter(services, TWO_OBJECTIVES);
    const fixed = draft.exercises.find((exercise) => exercise.instructionPl === FIXED)!;
    const report = (await reportOf(draft.id))!;
    const noted = draft.exercises.find((exercise) => exercise.id === report.notes[0]!.exerciseId)!;
    return { fakes, services, deckId, draft, fixed, noted, report };
  }

  describe("zgodność z main i stany krytyka", () => {
    /** Ten sam scenariusz: tłumaczenie ujawnione przez kartę, a przy dogenerowaniu nowy przykład ujawniający istniejące tłumaczenie. */
    async function scenario(reviewer: ReviewerDeps | null) {
      const { fakes, services, reviewer: fake } = await world({ reviewer });
      let call = 0;
      routeLessonRound(fakes, async (input: LessonPoolRequest) => {
        const objectiveId = input.objectives[0]!.id;
        call += 1;
        if (call === 1) {
          return {
            exercises: [...wearPool(objectiveId), translation(objectiveId, "Mamy sukienkę i spódnicę.", "We have the dress and the skirt", "dress")],
            examples: { [objectiveId]: ["I wear a coat.", "We have the dress and the skirt."] },
          };
        }
        return {
          exercises: [gap(objectiveId, "Ona ma sukienkę. Wpisz brakujące słowo.", "She wears a ___.", "dress")],
          examples: { [objectiveId]: [`${WEAR_TRANSLATION}.`] },
        };
      });
      const { deckId, draft } = await generateChapter(services, WEAR_MATERIAL, "Ubrania");
      const { after } = await regenerate(services, deckId, draft, 1);
      const normalize = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(deckId, "DECK")) as unknown;
      return {
        exercises: normalize(after.exercises.map(({ id: _id, revisionId: _revisionId, ...exercise }) => exercise)),
        rejectedCount: after.rejectedCount,
        rejectedReasons: after.rejectedReasons,
        examples: normalize(after.examples),
        report: await reportOf(after.id),
        calls: fake.inputs.length,
      };
    }

    it("różnicowy: krytyk niegotowy i krytyk „wszystko ok” dają te same ćwiczenia, odrzucenia i przykłady (raport inny)", async () => {
      const without = await scenario(null);
      const withCritic = await scenario({ state: "ready", provider: new FakeLessonReviewer(), policy: POLICY });
      expect(without.rejectedReasons).toEqual({ [EXPOSURE_REASON]: 1 });
      // Gałąź filtra przykładów zadziałała: nowy przykład dogenerowania ujawniał tłumaczenie ze szkicu.
      expect(JSON.stringify(without.examples)).not.toContain(WEAR_TRANSLATION);
      expect(JSON.stringify(without.examples)).toContain("I wear a coat.");
      expect(without.exercises).toEqual(expect.arrayContaining([expect.objectContaining({ answer: WEAR_TRANSLATION })]));
      expect(withCritic.exercises).toEqual(without.exercises);
      expect(withCritic.rejectedCount).toBe(without.rejectedCount);
      expect(withCritic.rejectedReasons).toEqual(without.rejectedReasons);
      expect(withCritic.examples).toEqual(without.examples);
      expect(without.report?.status).toBe("unreviewed");
      expect(withCritic.report?.status).toBe("reviewed");
      expect(without.calls).toBe(0);
    });

    it("raport odróżnia krytyka wyłączonego od nieskonfigurowanego", async () => {
      const disabled = await world({ reviewer: null });
      const a = await generateChapter(disabled.services, TWO_OBJECTIVES);
      const report = (await reportOf(a.draft.id))!;
      expect(report.status).toBe("unreviewed");
      expect(report.objectives).toEqual(a.draft.objectiveIds.map((objectiveId) => ({ objectiveId, status: "unreviewed", reason: "disabled" })));
      expect(report.machine.every((entry) => !entry.reviewed)).toBe(true);
      expect(report.model).toBeUndefined();

      const notConfigured = await world({ reviewer: { state: "not_configured", policy: POLICY } });
      const b = await generateChapter(notConfigured.services, TWO_OBJECTIVES);
      expect((await reportOf(b.draft.id))!.objectives.map((objective) => objective.reason)).toEqual(["not_configured", "not_configured"]);
    });
  });

  describe("werdykty i walidacja poprawek", () => {
    it("fix(ambiguous) poprawny → zapisana poprawka; changed.exerciseId = itemId, odcisk = odcisk z bazy; machine dla wszystkich", async () => {
      const { services, reviewer } = await world();
      const NEW_INSTRUCTION = "Zdanie numer 1 ma tylko jedną lukę. Wybierz słowo.";
      reviewer.behavior = (input) => {
        if (reviewer.inputs.length !== 1) return verdictsFor(input, {});
        const n = nOf(input, (exercise) => exercise.exerciseType === "lesson_choice");
        return verdictsFor(input, { [n]: { n, verdict: "fix", category: "ambiguous", reasonPl: "Polecenie pasowało do dwóch słów.", exercise: { ...shown(input, n), instructionPl: NEW_INSTRUCTION } } });
      };
      const { deckId, draft } = await generateChapter(services, TWO_OBJECTIVES);
      const fixed = draft.exercises.find((exercise) => exercise.instructionPl === NEW_INSTRUCTION)!;
      expect(fixed).toBeDefined();
      // Identyfikatory zagadnień rozdziału zawierają identyfikator zestawu — krytyk widzi tylko aliasy.
      expect(JSON.stringify(reviewer.inputs)).not.toContain(deckId);
      expect(reviewer.inputs[0]!.objective.id).toBe(draft.objectiveIds[0]!.split(".").at(-1));
      const report = (await reportOf(draft.id))!;
      const fingerprints = await dbFingerprints(draft.id);
      expect(report.changed).toEqual([
        expect.objectContaining({ exerciseId: fixed.id, category: "ambiguous", reasonPl: "Polecenie pasowało do dwóch słów.", addedVariants: [], fingerprint: fingerprints.get(fixed.id) }),
      ]);
      expect(report.changed[0]!.beforePl).toMatch(/^I can see the ___. → /u);
      expect(report.machine.map((entry) => entry.exerciseId).sort()).toEqual(draft.exercises.map((exercise) => exercise.id).sort());
      for (const entry of report.machine) {
        expect(entry.fingerprint).toBe(fingerprints.get(entry.exerciseId));
        expect(entry.reviewed).toBe(true);
      }
      expect(report.model).toBe("fake-reviewer-1");
      expect(draft.rejectedCount).toBe(0);
    });

    it("fix zmieniający typ → twarda kategoria: oryginał odpada z powodem kontroli jakości", async () => {
      const { services, reviewer } = await world();
      let target: Raw | undefined;
      reviewer.behavior = (input) => {
        if (target !== undefined) return verdictsFor(input, {});
        const n = nOf(input, (exercise) => exercise.exerciseType === "lesson_gap");
        target = shown(input, n);
        return verdictsFor(input, { [n]: { n, verdict: "fix", category: "ambiguous", reasonPl: "Dwa słowa pasują.", exercise: { ...target, exerciseType: "lesson_open_answer" } } });
      };
      const { draft } = await generateChapter(services, TWO_OBJECTIVES);
      expect(draft.exercises.some((exercise) => exercise.instructionPl === target!.instructionPl)).toBe(false);
      expect(draft.rejectedReasons?.[REVIEW_REASON]).toBe(1);
      expect(draft.rejectedCount).toBe(1);
      const report = (await reportOf(draft.id))!;
      expect(report.dropped).toEqual([expect.objectContaining({ category: "ambiguous", reasonPl: "Dwa słowa pasują." })]);
    });

    it("fix(unnatural_language) ze słowem spoza materiału → oryginał zostaje z uwagą „poprawka odrzucona”, inne ćwiczenia nienaruszone", async () => {
      const disabled = await world({ reviewer: null });
      const baseline = await generateChapter(disabled.services, TWO_OBJECTIVES);

      const { services, reviewer } = await world();
      let target: Raw | undefined;
      reviewer.behavior = (input) => {
        if (target !== undefined) return verdictsFor(input, {});
        const n = nOf(input, (exercise) => exercise.exerciseType === "lesson_gap");
        target = shown(input, n);
        return verdictsFor(input, { [n]: { n, verdict: "fix", category: "unnatural_language", reasonPl: "Nienaturalne zdanie.", exercise: { ...target, answer: "umbrella", focus: ["umbrella"] } } });
      };
      const { deckId, draft } = await generateChapter(services, TWO_OBJECTIVES);
      const strip = (exercises: LessonDraftDto["exercises"], id: string) =>
        JSON.parse(JSON.stringify(exercises.map(({ id: _i, revisionId: _r, ...exercise }) => exercise)).replaceAll(id, "DECK")) as unknown;
      expect(strip(draft.exercises, deckId)).toEqual(strip(baseline.draft.exercises, baseline.deckId));
      const original = draft.exercises.find((exercise) => exercise.instructionPl === target!.instructionPl && exercise.answer === target!.answer)!;
      const report = (await reportOf(draft.id))!;
      expect(report.notes).toEqual([
        expect.objectContaining({ exerciseId: original.id, category: "unnatural_language", reasonPl: "Nienaturalne zdanie.", fixRejected: true }),
      ]);
      expect(report.notes[0]!.fingerprint).toBe((await dbFingerprints(draft.id)).get(original.id));
      expect(draft.rejectedCount).toBe(0);
    });

    it("fix tworzący duplikat bodźca innego ćwiczenia → poprawka odrzucona", async () => {
      const { services, reviewer } = await world();
      let target: Raw | undefined;
      reviewer.behavior = (input) => {
        if (target !== undefined) return verdictsFor(input, {});
        const gaps = input.exercises.filter(({ exercise }) => (exercise as Raw).exerciseType === "lesson_gap");
        const [first, second] = gaps;
        target = shown(input, second!.n);
        return verdictsFor(input, { [second!.n]: { n: second!.n, verdict: "fix", category: "unclear_instruction", reasonPl: "Niejasne polecenie.", exercise: { ...(first!.exercise as Raw) } } });
      };
      const { draft } = await generateChapter(services, TWO_OBJECTIVES);
      expect(draft.exercises.filter((exercise) => exercise.instructionPl === target!.instructionPl)).toHaveLength(1);
      const report = (await reportOf(draft.id))!;
      expect(report.changed).toEqual([]);
      expect(report.notes).toEqual([expect.objectContaining({ category: "unclear_instruction", fixRejected: true })]);
    });

    it("dwie poprawki w jednej partii zbiegające się w to samo ćwiczenie → zapisana tylko pierwsza, druga z uwagą „poprawka odrzucona”", async () => {
      const { services, reviewer } = await world();
      const SAME = "Zdanie z jedną luką. Wpisz brakujące słowo.";
      reviewer.behavior = (input) => {
        if (reviewer.inputs.indexOf(input) !== 0) return verdictsFor(input, {});
        const [first, second] = input.exercises.filter(({ exercise }) => (exercise as Raw).exerciseType === "lesson_gap");
        const fix = { ...(first!.exercise as Raw), instructionPl: SAME };
        return verdictsFor(input, {
          [first!.n]: { n: first!.n, verdict: "fix", category: "unclear_instruction", reasonPl: "Pierwsza.", exercise: fix },
          [second!.n]: { n: second!.n, verdict: "fix", category: "unclear_instruction", reasonPl: "Druga.", exercise: { ...fix } },
        });
      };
      const { draft } = await generateChapter(services, TWO_OBJECTIVES);
      expect(draft.exercises.filter((exercise) => exercise.instructionPl === SAME)).toHaveLength(1);
      const report = (await reportOf(draft.id))!;
      expect(report.changed).toEqual([expect.objectContaining({ reasonPl: "Pierwsza." })]);
      expect(report.notes).toEqual([expect.objectContaining({ reasonPl: "Druga.", fixRejected: true })]);
      expect(draft.rejectedCount).toBe(0);
    });

    it("fix ćwiczenia „Posłuchaj i wybierz” → replace", async () => {
      const { services, reviewer } = await world();
      let replacedWith: string | undefined;
      reviewer.behavior = (input) => {
        if (replacedWith !== undefined) return verdictsFor(input, {});
        const n = nOf(input, (exercise) => exercise.exerciseType === "lesson_listen_choice");
        const exercise = shown(input, n);
        const options = exercise.options as { id: string; text: string }[];
        const used = new Set(options.map((option) => option.text));
        const words = input.exercises.flatMap(({ exercise: other }) => ((other as Raw).options as { text: string }[] | undefined)?.map((option) => option.text) ?? []);
        replacedWith = words.find((word) => !used.has(word));
        if (replacedWith === undefined) return verdictsFor(input, {});
        return verdictsFor(input, {
          [n]: { n, verdict: "fix", category: "ambiguous", reasonPl: "Dystraktor brzmiał podobnie.", exercise: { ...exercise, options: [options[0], { id: "b", text: replacedWith }] } },
        });
      };
      const { draft } = await generateChapter(services, TWO_OBJECTIVES);
      expect(replacedWith).toBeDefined();
      const listen = draft.exercises.filter((exercise) => exercise.exerciseType === "lesson_listen_choice");
      expect(listen.some((exercise) => exercise.options?.[1]?.text === replacedWith)).toBe(true);
      expect((await reportOf(draft.id))!.changed).toHaveLength(1);
    });

    it("szkoła: fix członka rodziny (ten sam familyId) zapisany — rodzina i słowa kluczowe zostają; zmieniony familyId odrzucony", async () => {
      const FAMILY = "fotosynteza-rodzina";
      async function schoolRun(changeFamily: boolean) {
        const { fakes, services, reviewer } = await world();
        const isOpen = (exercise: unknown) => (exercise as Raw).exerciseType === "lesson_open_answer";
        let familyObjectiveId: string | undefined;
        routeLessonRound(fakes, async (input) => {
          const result = await new FakeLlmProvider().generateLessonPool(input);
          if (familyObjectiveId !== undefined) return result;
          familyObjectiveId = input.objectives[0]!.id;
          const base = result.exercises.find(isOpen) as Raw;
          const family = [1, 2].map((n) => ({ ...base, familyId: FAMILY, prompt: `Pytanie rodziny numer ${n}: czym jest fotosynteza?` }));
          const keywords = {
            exerciseType: "lesson_keywords", objectiveId: familyObjectiveId, familyId: FAMILY,
            keywordOptions: [{ id: "k1", text: "światła" }, { id: "k2", text: "cukry" }, { id: "k3", text: "tlen" }, { id: "k4", text: "korzenie" }],
            keyOptionIds: ["k1", "k2"], answer: "światła, cukry", acceptedAnswers: [], focus: [], sourceRefs: [{ quote: "wytwarza cukry" }],
          };
          return { ...result, exercises: [...result.exercises.filter((exercise) => exercise !== base), ...family, keywords] };
        });
        let done = false;
        reviewer.behavior = (input) => {
          if (done || input.objective.id !== familyObjectiveId?.split(".").at(-1)) return verdictsFor(input, {});
          done = true;
          const n = nOf(input, (exercise) => exercise.familyId !== undefined && exercise.exerciseType === "lesson_open_answer");
          const exercise = shown(input, n);
          return verdictsFor(input, {
            [n]: {
              n, verdict: "fix", category: "unclear_instruction", reasonPl: "Doprecyzowano pytanie.",
              exercise: { ...exercise, prompt: "Pytanie rodziny numer 1: wyjaśnij, czym jest fotosynteza?", ...(changeFamily ? { familyId: "inna-rodzina" } : {}) },
            },
          });
        };
        const { runId, deckId } = await createSchoolLesson(services, {
          subjectTitlePl: "Przyroda i historia", topicTitlePl: "Materiał pilotażowy", material: SCHOOL_MATERIAL, poolSize: 40, clientRequestId: randomUUID(),
        });
        await executeLessonGeneration(services, runId);
        expect((await readGeneration(services, runId)).state).toBe("succeeded");
        const draft = (await readLessonDeck(services, deckId)).draft!;
        return { draft, report: (await reportOf(draft.id))!, familyObjectiveId: familyObjectiveId! };
      }

      const kept = await schoolRun(false);
      const family = kept.draft.exercises.filter((exercise) => exercise.familyId?.startsWith(FAMILY) && exercise.exerciseType === "lesson_open_answer");
      expect(family.map((exercise) => exercise.prompt).sort()).toEqual([
        "Pytanie rodziny numer 1: wyjaśnij, czym jest fotosynteza?",
        "Pytanie rodziny numer 2: czym jest fotosynteza?",
      ]);
      expect(kept.draft.exercises.filter((exercise) => exercise.exerciseType === "lesson_keywords")).toHaveLength(1);
      expect(kept.report.changed).toHaveLength(1);

      const rejected = await schoolRun(true);
      expect(rejected.draft.exercises.some((exercise) => exercise.prompt === "Pytanie rodziny numer 1: wyjaśnij, czym jest fotosynteza?")).toBe(false);
      expect(rejected.draft.exercises.filter((exercise) => exercise.familyId?.startsWith(FAMILY))).toHaveLength(3);
      expect(rejected.report.notes).toEqual([expect.objectContaining({ fixRejected: true })]);
    });

    it("fix miękki, którego zdanie staje się przykładem karty → poprawka odrzucona, oryginał zostaje", async () => {
      const { services, reviewer } = await world();
      let target: Raw | undefined;
      reviewer.behavior = (input) => {
        if (target !== undefined) return verdictsFor(input, {});
        const n = nOf(input, (exercise) => exercise.exerciseType === "lesson_open_answer");
        target = shown(input, n);
        const example = input.cardExamples[input.objective.id]?.[0] ?? "";
        return verdictsFor(input, { [n]: { n, verdict: "fix", category: "unnatural_language", reasonPl: "Sztuczne zdanie.", exercise: { ...target, answer: example.replace(/\.$/u, "") } } });
      };
      const { draft } = await generateChapter(services, TWO_OBJECTIVES);
      const first = reviewer.inputs[0]!;
      expect(first.cardExamples[first.objective.id]?.[0]).toBeTruthy();
      const original = draft.exercises.find((exercise) => exercise.answer === target!.answer)!;
      expect(original).toBeDefined();
      expect((await reportOf(draft.id))!.notes).toEqual([expect.objectContaining({ exerciseId: original.id, fixRejected: true })]);
      expect(draft.rejectedCount).toBe(0);
    });

    describe("tłumaczenie ujawnione przez kartę", () => {
      async function leakedRun(behavior: (input: LessonReviewInput) => unknown[]) {
        const { fakes, services, reviewer } = await world({ execution: MAIN_BATCH_ONLY });
        routeLessonRound(fakes, async (input) => {
          const objectiveId = input.objectives[0]!.id;
          return { exercises: wearPool(objectiveId), examples: { [objectiveId]: [`${WEAR_TRANSLATION}.`] } };
        });
        reviewer.behavior = behavior;
        const { draft } = await generateChapter(services, WEAR_MATERIAL, "Ubrania");
        return { draft, reviewer };
      }

      it("ustalenia zawierają findingText; fix zmieniający zdanie → ćwiczenie zostaje", async () => {
        const FIXED = "We have the dress and the skirt";
        const { draft, reviewer } = await leakedRun((input) => {
          const n = nOf(input, (exercise) => exercise.answer === WEAR_TRANSLATION);
          return verdictsFor(input, { [n]: { n, verdict: "fix", category: "leaked_solution", reasonPl: "Rozwiązanie było na karcie.", exercise: { ...shown(input, n), prompt: "Mamy sukienkę i spódnicę.", answer: FIXED, focus: ["dress"] } } });
        });
        expect(reviewer.inputs[0]!.findings).toEqual([`exercise 3: its solution equals card example "${WEAR_TRANSLATION}."`]);
        expect(draft.exercises.some((exercise) => exercise.answer === FIXED)).toBe(true);
        expect(draft.exercises.some((exercise) => exercise.answer === WEAR_TRANSLATION)).toBe(false);
        expect(draft.rejectedCount).toBe(0);
      });

      it("brak werdyktu → reguła twarda usuwa", async () => {
        const { draft } = await leakedRun(() => []);
        expect(draft.exercises.some((exercise) => exercise.answer === WEAR_TRANSLATION)).toBe(false);
        expect(draft.rejectedReasons).toEqual({ [EXPOSURE_REASON]: 1 });
      });
    });

    it("drop dla 3 z 4 ćwiczeń (bez ujawnień) → zagadnienie suspicious, wszystkie zostają", async () => {
      const { fakes, services, reviewer } = await world({ execution: MAIN_BATCH_ONLY });
      routeLessonRound(fakes, async (input) => {
        const objectiveId = input.objectives[0]!.id;
        return { exercises: [...wearPool(objectiveId), gap(objectiveId, "Ona ma sukienkę. Wpisz brakujące słowo.", "She wears a ___.", "dress")], examples: { [objectiveId]: ["I wear a coat."] } };
      });
      reviewer.behavior = (input) => [1, 2, 3].map((n) => ({ n, verdict: "drop", category: "wrong_answer", reasonPl: "Zła odpowiedź." }));
      const { draft } = await generateChapter(services, WEAR_MATERIAL, "Ubrania");
      expect(draft.exercises).toHaveLength(4);
      const report = (await reportOf(draft.id))!;
      expect(report.objectives).toEqual([{ objectiveId: draft.objectiveIds[0], status: "suspicious" }]);
      expect(report.machine).toHaveLength(4);
      expect(report.machine.every((entry) => !entry.reviewed)).toBe(true);
      expect(report.dropped).toEqual([]);
      expect(draft.rejectedCount).toBe(0);
    });

    it("dogenerowanie 1 ćwiczenia w zagadnieniu z 6 istniejącymi: poprawny fix → replace (bezpiecznik liczy całe zagadnienie)", async () => {
      const { fakes, services, reviewer } = await world({ execution: MAIN_BATCH_ONLY });
      let call = 0;
      routeLessonRound(fakes, async (input) => {
        const objectiveId = input.objectives[0]!.id;
        call += 1;
        if (call === 1) {
          return {
            exercises: [
              ...wearPool(objectiveId),
              gap(objectiveId, "Ona ma sukienkę. Wpisz brakujące słowo.", "She wears a ___.", "dress"),
              gap(objectiveId, "My mamy spódnicę. Wpisz brakujące słowo.", "We wear a ___.", "skirt"),
              choice(objectiveId, "Mam na sobie buty. Wybierz słowo.", "I wear ___.", "boots", "coat"),
            ],
            examples: { [objectiveId]: ["I wear a coat."] },
          };
        }
        return { exercises: [gap(objectiveId, "Ona ma spódnicę. Wpisz brakujące słowo.", "She wears a ___.", "skirt")], examples: {} };
      });
      const { deckId, draft } = await generateChapter(services, WEAR_MATERIAL, "Ubrania");
      expect(draft.exercises).toHaveLength(6);
      const FIXED = "Ona nosi spódnicę. Wpisz brakujące słowo.";
      reviewer.behavior = (input) =>
        verdictsFor(input, { 1: { n: 1, verdict: "fix", category: "unclear_instruction", reasonPl: "Doprecyzowano.", exercise: { ...shown(input, 1), instructionPl: FIXED } } });
      const { after } = await regenerate(services, deckId, draft, 1);
      expect(reviewer.inputs.at(-1)!.existingExercises).toHaveLength(6);
      expect(reviewer.inputs.at(-1)!.exercises).toHaveLength(1);
      expect(after.exercises).toHaveLength(7);
      expect(after.exercises.some((exercise) => exercise.instructionPl === FIXED)).toBe(true);
      const report = (await reportOf(after.id))!;
      expect(report.objectives).toEqual([{ objectiveId: draft.objectiveIds[0], status: "reviewed" }]);
      expect(report.changed).toHaveLength(1);
      // Wpisy machine z obu przebiegów: każde ćwiczenie szkicu ma odcisk.
      expect(report.machine).toHaveLength(7);
    });

    it("mapowanie: reguła twarda usuwa ćwiczenie stojące przed poprawionym — changed.exerciseId wskazuje poprawione", async () => {
      const { fakes, services, reviewer } = await world({ execution: MAIN_BATCH_ONLY });
      routeLessonRound(fakes, async (input) => {
        const objectiveId = input.objectives[0]!.id;
        const [first, second, third] = wearPool(objectiveId);
        return { exercises: [third!, first!, second!], examples: { [objectiveId]: [`${WEAR_TRANSLATION}.`] } };
      });
      const FIXED = "Mam na sobie buty i nic więcej. Wpisz brakujące słowo.";
      reviewer.behavior = (input) => verdictsFor(input, { 3: { n: 3, verdict: "fix", category: "unclear_instruction", reasonPl: "Doprecyzowano.", exercise: { ...shown(input, 3), instructionPl: FIXED } } });
      const { draft } = await generateChapter(services, WEAR_MATERIAL, "Ubrania");
      expect(draft.exercises).toHaveLength(2);
      const fixed = draft.exercises.find((exercise) => exercise.instructionPl === FIXED)!;
      expect((await reportOf(draft.id))!.changed).toEqual([expect.objectContaining({ exerciseId: fixed.id })]);
      expect(draft.rejectedReasons).toEqual({ [EXPOSURE_REASON]: 1 });
    });
  });

  describe("czas, awarie, limity", () => {
    it("timeout jednego zagadnienia → to zagadnienie unreviewed/timeout, raport partial, run succeeded", async () => {
      const { services, reviewer } = await world();
      let calls = 0;
      reviewer.behavior = (input) => {
        calls += 1;
        if (calls === 2) throw new GenerationProviderError("timeout");
        return verdictsFor(input, {});
      };
      const { draft } = await generateChapter(services, TWO_OBJECTIVES);
      const report = (await reportOf(draft.id))!;
      expect(report.status).toBe("partial");
      expect(report.objectives).toEqual([
        { objectiveId: draft.objectiveIds[0], status: "reviewed" },
        { objectiveId: draft.objectiveIds[1], status: "unreviewed", reason: "timeout" },
      ]);
      const reviewedOf = new Map<string | undefined, boolean>(report.machine.map((entry) => [entry.exerciseId, entry.reviewed]));
      for (const exercise of draft.exercises) expect(reviewedOf.get(exercise.id)).toBe(exercise.objectiveId === draft.objectiveIds[0]);
    });

    it("budżet fazy: krytyk wolniejszy niż budżet → zagadnienia unreviewed/timeout, run succeeded, szkic zapisany", async () => {
      // Termin wywołań krytyka = start + runTimeoutMs + phaseBudgetMs − 30 s rezerwy ≈ start + 16,5 s,
      // daleko przed końcem opóźnienia krytyka (60 s) — także na obciążonej maszynie.
      const DELAY_MS = 60_000;
      const { services, reviewer } = await world({
        execution: { ...DEFAULT_LESSON_GENERATION_POLICY, requestTimeoutMs: 2_000, runTimeoutMs: 15_000 },
        policy: { phaseBudgetMs: 31_500, timeoutMs: 120_000 },
      });
      reviewer.delayMs = DELAY_MS;
      const startedAt = Date.now();
      const { draft } = await generateChapter(services, TWO_OBJECTIVES);
      expect(Date.now() - startedAt).toBeLessThan(DELAY_MS);
      expect(draft.exercises.length).toBeGreaterThan(0);
      const report = (await reportOf(draft.id))!;
      expect(report.status).toBe("unreviewed");
      expect(report.objectives.map((objective) => objective.reason)).toEqual(["timeout", "timeout"]);
    }, 90_000);

    it("edycja rodzica wewnątrz wywołania krytyka → run superseded, brak zapisu", async () => {
      const { fakes, services, reviewer } = await world();
      let call = 0;
      routeLessonRound(fakes, async (input) => {
        const objectiveId = input.objectives[0]!.id;
        call += 1;
        if (call > 1) return { exercises: [gap(objectiveId, "Ona ma sukienkę. Wpisz brakujące słowo.", "She wears a ___.", "dress")], examples: {} };
        return { exercises: wearPool(objectiveId), examples: { [objectiveId]: ["I wear a coat."] } };
      });
      fakes.deps.lessonExecution = MAIN_BATCH_ONLY;
      const { deckId, draft } = await generateChapter(services, WEAR_MATERIAL, "Ubrania");
      const regen = await regenerateObjective(services, { deckId, objectiveId: draft.objectiveIds[0]!, count: 2, expectedEditNumber: draft.editNumber, clientRequestId: randomUUID() });
      reviewer.behavior = async (input) => {
        await editLessonDraft(services, draft.id, { expectedEditNumber: draft.editNumber, exercises: editInputs(draft.exercises) });
        return verdictsFor(input, {});
      };
      await executeLessonGeneration(services, regen.runId);
      expect(await readGeneration(services, regen.runId)).toMatchObject({ state: "superseded" });
      const after = (await readLessonDeck(services, deckId)).draft!;
      expect(after.exercises).toHaveLength(draft.exercises.length);
      expect(after.editNumber).toBe(draft.editNumber + 1);
    });

    it("5 zagadnień: pierwsze wywołanie samo, potem najwyżej 3 równolegle", async () => {
      const { services, reviewer } = await world();
      reviewer.delayMs = 50;
      const inFlightAtStart: number[] = [];
      reviewer.behavior = (input) => {
        inFlightAtStart.push(reviewer.inFlight);
        return verdictsFor(input, {});
      };
      const material = ["Ubrania", "Pogoda", "Zwierzęta", "Kolory", "Szkoła"].map((title, index) =>
        `Zagadnienie ${index + 1}: ${title}\n${["coat, boots, dress", "It's raining. It's snowing.", "cat, dog, horse", "red, blue, green", "pen, book, desk"][index]}`,
      ).join("\n");
      const { draft } = await generateChapter(services, material);
      expect(draft.objectiveIds).toHaveLength(5);
      expect(reviewer.inputs).toHaveLength(5);
      expect(inFlightAtStart[0]).toBe(1);
      expect(Math.max(...inFlightAtStart)).toBeLessThanOrEqual(3);
      expect(reviewer.maxInFlight).toBeLessThanOrEqual(3);
      expect(reviewer.maxInFlight).toBeGreaterThan(1);
    });

    it("rezerwa krytyka w bramce rundy pod etap: czasu wystarcza bez rezerwy, ale nie z nią → brak żądania rundy", async () => {
      // Bramka: termin fazy − teraz < requestTimeoutMs + 30 s marginesu + rezerwa (timeoutMs krytyka).
      // Termin fazy ≈ start + 60 s + 30 s budżetu: bez rezerwy (≈ 32 s) runda by poszła, z rezerwą 120 s — nie.
      async function run(reviewerTimeoutMs: number) {
        const { fakes, services } = await world({
          execution: { ...DEFAULT_LESSON_GENERATION_POLICY, requestTimeoutMs: 2_000, runTimeoutMs: 60_000, cancelPollMs: 10 },
          policy: { phaseBudgetMs: 30_000, timeoutMs: reviewerTimeoutMs },
        });
        routeLessonRound(fakes, async (input) => {
          const objectiveId = input.objectives[0]!.id;
          return { exercises: wearPool(objectiveId), examples: { [objectiveId]: ["I wear a coat."] } };
        });
        await generateChapter(services, WEAR_MATERIAL, "Ubrania");
        return fakes.llm.lessonRequests.filter((request) => request.purpose === "stage_top_up").length;
      }
      expect(await run(120_000)).toBe(0);
      // Kontrola: ta sama lekcja z krótką rezerwą dostaje rundę (brak etapu jest, czasu bez rezerwy wystarcza).
      expect(await run(1_000)).toBe(1);
    });

    it("maxCallsPerRun 1 przy dwóch zagadnieniach → drugie unreviewed/limit", async () => {
      const { services, reviewer } = await world({ policy: { maxCallsPerRun: 1 } });
      const { draft } = await generateChapter(services, TWO_OBJECTIVES);
      expect(reviewer.inputs).toHaveLength(1);
      expect((await reportOf(draft.id))!.objectives).toEqual([
        { objectiveId: draft.objectiveIds[0], status: "reviewed" },
        { objectiveId: draft.objectiveIds[1], status: "unreviewed", reason: "limit" },
      ]);
    });

    it("limit zużyty w partii głównej → zagadnienie zostaje reviewed, ćwiczenia rundy pod etap machine.reviewed=false", async () => {
      const { fakes, services, reviewer } = await world({ policy: { maxCallsPerRun: 1 } });
      routeLessonRound(fakes, async (input) => {
        const objectiveId = input.objectives[0]!.id;
        return { exercises: wearPool(objectiveId), examples: { [objectiveId]: ["I wear a coat."] } };
      });
      const { draft } = await generateChapter(services, WEAR_MATERIAL, "Ubrania");
      expect(fakes.llm.lessonRequests.filter((request) => request.purpose === "stage_top_up")).toHaveLength(1);
      expect(reviewer.inputs).toHaveLength(1);
      expect(draft.exercises.length).toBeGreaterThan(3);
      const report = (await reportOf(draft.id))!;
      expect(report.objectives).toEqual([{ objectiveId: draft.objectiveIds[0], status: "reviewed" }]);
      expect(report.status).toBe("reviewed");
      const reviewed = report.machine.filter((entry) => entry.reviewed);
      expect(reviewed).toHaveLength(3);
      expect(report.machine).toHaveLength(draft.exercises.length);
      expect(report.machine.filter((entry) => !entry.reviewed)).toHaveLength(draft.exercises.length - 3);
    });
  });

  it("runda pod etap: ćwiczenia rundy przechodzą krytyka (fix → replace), toppedUp zapisane", async () => {
    const { fakes, services, reviewer } = await world();
    routeLessonRound(fakes, async (input) => {
      const objectiveId = input.objectives[0]!.id;
      return { exercises: wearPool(objectiveId), examples: { [objectiveId]: ["I wear a coat."] } };
    });
    const FIXED = "Poprawione polecenie rundy. Wybierz słowo.";
    reviewer.behavior = (input) => {
      if (reviewer.inputs.length === 1) return verdictsFor(input, {});
      const n = nOf(input, (exercise) => exercise.exerciseType === "lesson_choice");
      return verdictsFor(input, { [n]: { n, verdict: "fix", category: "unclear_instruction", reasonPl: "Doprecyzowano.", exercise: { ...shown(input, n), instructionPl: FIXED } } });
    };
    const { draft } = await generateChapter(services, WEAR_MATERIAL, "Ubrania");
    expect(reviewer.inputs).toHaveLength(2);
    expect(reviewer.inputs[1]!.existingExercises).toHaveLength(3);
    expect(draft.exercises.some((exercise) => exercise.instructionPl === FIXED)).toBe(true);
    expect(draft.coverage).toEqual([]);
    const report = (await reportOf(draft.id))!;
    const objectiveId = draft.objectiveIds[0]!;
    const counts = { guided: 0, productive: 0, independent: 0 };
    for (const exercise of draft.exercises.slice(3)) {
      const stage = stageOf(exercise.exerciseType);
      if (stage === "guided" || stage === "productive" || stage === "independent") counts[stage] += 1;
    }
    expect(report.toppedUp).toEqual([{ objectiveId, ...counts }]);
    expect(counts.guided + counts.productive + counts.independent).toBeGreaterThan(0);
    expect(report.changed).toEqual([expect.objectContaining({ exerciseId: draft.exercises.find((exercise) => exercise.instructionPl === FIXED)!.id })]);
    expect(report.objectives).toEqual([{ objectiveId, status: "reviewed" }]);
    // DTO panelu rodzica: suma dogenerowanych ćwiczeń rundy pod etap
    expect(draft.review!.toppedUp).toBe(counts.guided + counts.productive + counts.independent);
    expect(draft.review!.toppedUp).toBeGreaterThan(0);
  });

  it("krytyk usuwa wszystkie świeże ćwiczenia → run failed/validation, a raport z usunięciami zapisany w kontekście", async () => {
    const { fakes, services, reviewer } = await world({ execution: MAIN_BATCH_ONLY });
    routeLessonRound(fakes, async (input) => {
      const objectiveId = input.objectives[0]!.id;
      // Tłumaczenie ujawnione przez kartę nie liczy się do bezpiecznika, więc dwa usunięcia z dwóch nie są „podejrzane”.
      return {
        exercises: [gap(objectiveId, "Mam na sobie buty. Wpisz brakujące słowo.", "I wear ___.", "boots"), translation(objectiveId, "Mamy płaszcz i buty.", WEAR_TRANSLATION, "coat")],
        examples: { [objectiveId]: [`${WEAR_TRANSLATION}.`] },
      };
    });
    reviewer.behavior = (input) => input.exercises.map(({ n }) => ({ n, verdict: "drop", category: "wrong_answer", reasonPl: `Błąd ${n}.` }));
    const { runId, deckId } = await createLessonFromMaterial(services, {
      subjectId: "english_chapter", topicTitlePl: "Ubrania", material: WEAR_MATERIAL, poolSize: 40, clientRequestId: randomUUID(),
    });
    await executeLessonGeneration(services, runId);
    expect(await readGeneration(services, runId)).toMatchObject({ state: "failed", errorCode: "validation" });
    expect(reviewer.inputs).toHaveLength(1);
    const [version] = await query<{ id: string }>("select id from learning_app.deck_versions where deck_id = $1", [deckId]);
    const report = (await reportOf(version!.id))!;
    expect(report.dropped.map((entry) => [entry.category, entry.reasonPl])).toEqual([["wrong_answer", "Błąd 1."], ["wrong_answer", "Błąd 2."]]);
    expect(report.objectives).toEqual([{ objectiveId: expect.any(String), status: "reviewed" }]);
    expect(report.machine).toEqual([]);
    expect(report.model).toBe("fake-reviewer-1");
    const [context] = await query<{ rejected_reasons: Record<string, number> }>(
      "select lesson_context->'rejectedReasons' as rejected_reasons from learning_app.deck_versions where id = $1", [version!.id],
    );
    expect(context!.rejected_reasons).toEqual({ [REVIEW_REASON]: 2 });
  });

  it("dogenerowanie w szkole: krytyk poprawia członka rodziny → zapisany, rodzina i słowa kluczowe zostają", async () => {
    const FAMILY = "chrzest-rodzina";
    const { fakes, services, reviewer } = await world({ execution: MAIN_BATCH_ONLY });
    const isOpen = (exercise: unknown) => (exercise as Raw).exerciseType === "lesson_open_answer";
    let regenerating = false;
    routeLessonRound(fakes, async (input) => {
      const result = await new FakeLlmProvider().generateLessonPool(input);
      if (!regenerating) return result;
      const objectiveId = input.objectives[0]!.id;
      const base = result.exercises.find(isOpen) as Raw;
      const family = [1, 2].map((n) => ({ ...base, objectiveId, familyId: FAMILY, prompt: `Pytanie dogenerowane numer ${n}: co zmienił chrzest Polski?` }));
      const keywords = {
        exerciseType: "lesson_keywords", objectiveId, familyId: FAMILY,
        keywordOptions: [{ id: "k1", text: "Europy" }, { id: "k2", text: "władzę" }, { id: "k3", text: "cukry" }, { id: "k4", text: "światła" }],
        keyOptionIds: ["k1", "k2"], answer: "Europy, władzę", acceptedAnswers: [], focus: [], sourceRefs: [{ quote: "wzmocnił władzę księcia" }],
      };
      return { exercises: [...family, keywords], examples: {} };
    });
    const { runId, deckId } = await createSchoolLesson(services, {
      subjectTitlePl: "Przyroda i historia", topicTitlePl: "Materiał pilotażowy", material: SCHOOL_MATERIAL, poolSize: 40, clientRequestId: randomUUID(),
    });
    await executeLessonGeneration(services, runId);
    expect((await readGeneration(services, runId)).state).toBe("succeeded");
    const draft = (await readLessonDeck(services, deckId)).draft!;
    const objectiveId = draft.objectiveIds[1]!;

    regenerating = true;
    const FIXED = "Pytanie dogenerowane numer 1: wyjaśnij, co zmienił chrzest Polski?";
    reviewer.behavior = (input) => {
      const n = nOf(input, (exercise) => exercise.familyId !== undefined && exercise.exerciseType === "lesson_open_answer");
      return verdictsFor(input, { [n]: { n, verdict: "fix", category: "unclear_instruction", reasonPl: "Doprecyzowano pytanie.", exercise: { ...shown(input, n), prompt: FIXED } } });
    };
    const callsBefore = reviewer.inputs.length;
    const { runId: regenRunId, after } = await regenerate(services, deckId, draft, 3, objectiveId);
    expect((await readGeneration(services, regenRunId)).state).toBe("succeeded");
    expect(reviewer.inputs.length).toBe(callsBefore + 1);
    // Krytyk widzi rodzinę z zakresem przebiegu dogenerowania i oddaje ją bez zmian.
    const scopedFamily = (reviewer.inputs.at(-1)!.exercises.find(({ exercise }) => isOpen(exercise))!.exercise as Raw).familyId as string;
    expect(scopedFamily).not.toBe(FAMILY);
    expect(scopedFamily.startsWith(FAMILY)).toBe(true);
    const family = after.exercises.filter((exercise) => exercise.familyId === scopedFamily);
    expect(family.filter(isOpen).map((exercise) => exercise.prompt).sort()).toEqual([FIXED, "Pytanie dogenerowane numer 2: co zmienił chrzest Polski?"]);
    expect(family.filter((exercise) => exercise.exerciseType === "lesson_keywords")).toHaveLength(1);
    const report = (await reportOf(after.id))!;
    expect(report.changed).toEqual([expect.objectContaining({ exerciseId: family.find((exercise) => exercise.prompt === FIXED)!.id, reasonPl: "Doprecyzowano pytanie." })]);
  });

  it("DTO po usunięciu zagadnienia: zagadnienia i usunięcia tylko bieżącego tematu, status liczony od nowa", async () => {
    // Wywołania 1 i 2 przy concurrency > 1 biegną równolegle i kolejność ich startu
    // zależy od czasu odpowiedzi bazy; numer wywołania wskazuje zagadnienie tylko
    // przy przeglądzie po kolei.
    const { services, reviewer } = await world({ execution: MAIN_BATCH_ONLY, policy: { concurrency: 1 } });
    reviewer.behavior = (input) => {
      const call = reviewer.inputs.indexOf(input);
      if (call === 1) {
        const n = nOf(input, (exercise) => exercise.exerciseType === "lesson_choice");
        return verdictsFor(input, { [n]: { n, verdict: "drop", category: "wrong_answer", reasonPl: "Błędny klucz." } });
      }
      if (call === 2) throw new GenerationProviderError("timeout");
      return verdictsFor(input, {});
    };
    const { draft } = await generateChapter(services, CHAPTER_MATERIAL);
    expect(draft.objectiveIds).toHaveLength(3);
    const [first, second, third] = draft.objectiveIds as [string, string, string];
    expect(draft.review).toMatchObject({ status: "partial", dropped: [expect.objectContaining({ reasonPl: "Błędny klucz." })] });
    const stored = (await reportOf(draft.id))!;
    expect(stored.objectives.find((objective) => objective.objectiveId === third)).toMatchObject({ status: "unreviewed", reason: "timeout" });

    const kept = draft.dynamicTopic!.objectives.filter((objective) => objective.id === first);
    const edited = await editLessonDraft(services, draft.id, {
      expectedEditNumber: draft.editNumber,
      dynamicTopic: { objectives: kept.map((objective) => ({ id: objective.id, titlePl: objective.titlePl, cards: objective.cards })) },
    });
    expect(edited.objectiveIds).toEqual([first]);
    expect(edited.review).toEqual(expect.objectContaining({
      status: "reviewed",
      objectives: [{ objectiveId: first, title: kept[0]!.titlePl, status: "reviewed" }],
      dropped: [],
    }));
    const shown = JSON.stringify(edited.review);
    expect(shown).not.toContain(second);
    expect(shown).not.toContain(third);
    // Raport w kontekście zostaje nietknięty.
    expect((await reportOf(draft.id))!.objectives).toHaveLength(3);
  });

  it("prywatność: krytyk nie dostaje tematów zdań, imienia ani polecenia rodzica", async () => {
    const { services, reviewer } = await world();
    const { runId, deckId } = await createLesson(services, {
      subjectId: "english_grammar",
      topicId: "present_simple",
      objectiveIds: ["english_grammar.present_simple.third_person_s", "english_grammar.present_simple.negative"],
      material: "He plays football. She watches TV.",
      instruction: "Ćwiczenia dla Zosi Kowalskiej, która lubi konie.",
      interests: ["dinozaury", "kosmiczne rakiety"],
      clientRequestId: randomUUID(),
    });
    await executeLessonGeneration(services, runId);
    expect((await readGeneration(services, runId)).state).toBe("succeeded");
    expect((await readLessonDeck(services, deckId)).draft!.exercises.length).toBeGreaterThan(0);
    expect(reviewer.inputs).toHaveLength(2);
    const sent = JSON.stringify(reviewer.inputs);
    for (const secret of ["Zosi", "Kowalsk", "konie", "dinozaury", "kosmiczne rakiety", "Ćwiczenia dla", deckId, runId]) {
      expect(sent).not.toContain(secret);
    }
  });

  describe("raport przy kolejnych zmianach szkicu", () => {
    it("odciski changed/notes zgodne z bazą; PATCH innego ćwiczenia ich nie zmienia; PATCH poprawionego — wpis zostaje, odcisk różny", async () => {
      const { services, deckId, draft, fixed, noted, report } = await fixedDraft();
      const fingerprints = await dbFingerprints(draft.id);
      expect(report.changed[0]!.fingerprint).toBe(fingerprints.get(fixed.id));
      expect(report.notes[0]!.fingerprint).toBe(fingerprints.get(noted.id));

      const other = draft.exercises.find((exercise) => exercise.id !== fixed.id && exercise.id !== noted.id && exercise.exerciseType === "lesson_choice")!;
      const first = await editLessonDraft(services, draft.id, {
        expectedEditNumber: draft.editNumber,
        exercises: editInputs(draft.exercises.map((exercise) => (exercise.id === other.id ? { ...exercise, instructionPl: `${exercise.instructionPl} Uważaj.` } : exercise))),
      });
      const afterOther = await dbFingerprints(draft.id);
      expect(afterOther.get(fixed.id)).toBe(report.changed[0]!.fingerprint);
      expect((await reportOf(draft.id))).toEqual(report);

      await editLessonDraft(services, draft.id, {
        expectedEditNumber: first.editNumber,
        exercises: editInputs(first.exercises.map((exercise) => (exercise.id === fixed.id ? { ...exercise, instructionPl: "Rodzic zmienił polecenie. Wybierz słowo." } : exercise))),
      });
      const afterFixed = await reportOf(draft.id);
      expect(afterFixed!.changed[0]!.exerciseId).toBe(fixed.id);
      expect(afterFixed!.changed[0]!.fingerprint).not.toBe((await dbFingerprints(draft.id)).get(fixed.id));
      expect((await readLessonDeck(services, deckId)).draft!.exercises.some((exercise) => exercise.id === fixed.id)).toBe(true);
    });

    it("usunięcie poprawionego ćwiczenia → wpis znika przy następnym scaleniu; ponad 200 scaleń nie usuwa wpisu nietkniętego ćwiczenia", async () => {
      const { services, deckId, draft, fixed, noted } = await fixedDraft();
      const edited = await editLessonDraft(services, draft.id, {
        expectedEditNumber: draft.editNumber,
        exercises: editInputs(draft.exercises.filter((exercise) => exercise.id !== noted.id)),
      });
      const { runId, after } = await regenerate(services, deckId, edited, 1, edited.objectiveIds[1]);
      expect((await readGeneration(services, runId)).state).toBe("succeeded");
      const merged = (await reportOf(after.id))!;
      expect(merged.notes).toEqual([]);
      expect(merged.machine.some((entry) => entry.exerciseId === noted.id)).toBe(false);
      expect(merged.changed.map((entry) => entry.exerciseId)).toEqual([fixed.id]);
      expect(merged.machine).toHaveLength(after.exercises.length);

      // Ponad 200 kolejnych scaleń z innymi ćwiczeniami i odrzuceniami: wpis nietkniętego ćwiczenia zostaje.
      const live = new Set(after.exercises.map((exercise) => exercise.id!));
      let report = merged;
      for (let i = 0; i < 205; i++) {
        const otherId = after.exercises[i % after.exercises.length]!.id!;
        report = mergeReviewReport(report, {
          status: "reviewed", objectives: [], notes: [], toppedUp: [{ objectiveId: "x", guided: 1, productive: 0, independent: 0 }],
          changed: otherId === fixed.id ? [] : [{ exerciseId: otherId, fingerprint: "f", category: "other", reasonPl: "r", beforePl: "b", addedVariants: [] }],
          dropped: [{ objectiveId: "x", category: "other", reasonPl: "r", snippet: "s" }],
          machine: [],
        }, live);
      }
      expect(report.changed.find((entry) => entry.exerciseId === fixed.id)).toEqual(merged.changed[0]);
      expect(report.dropped).toHaveLength(200);
    });

    it("„Utwórz nową wersję” → kopia kontekstu bez raportu przeglądu i bez luk generowania agentem", async () => {
      const { services, deckId, draft } = await fixedDraft();
      // Luki z generowania agentem tamtej wersji (pole kontekstu; zapis bezpośrednio w bazie).
      await pool.query(
        "update learning_app.deck_versions set lesson_context = jsonb_set(lesson_context, '{generationGaps}', $1::jsonb) where id = $2",
        [JSON.stringify([{ objectiveId: draft.objectiveIds[0], reason: "incomplete" }]), draft.id],
      );
      await publishLessonDraft(services, draft.id, draft.editNumber);
      const copy = await createLessonDraftFromPublished(services, deckId);
      expect(copy.id).not.toBe(draft.id);
      expect(await reportOf(copy.id)).toBeUndefined();
      expect(await reportOf(draft.id)).toBeDefined();
      expect(copy.examples).toEqual(draft.examples);
      expect(copy).not.toHaveProperty("generationGaps");
      const [row] = await query<{ gaps: unknown }>(
        "select lesson_context->'generationGaps' as gaps from learning_app.deck_versions where id = $1", [copy.id],
      );
      expect(row?.gaps).toBeNull();
    });
  });

  describe("raport w DTO panelu rodzica", () => {
    it("po generacji: zmiany i uwagi istniejących ćwiczeń, tytuły zagadnień, model; bez odcisków", async () => {
      const { draft, fixed, noted, report } = await fixedDraft();
      const titles = draft.dynamicTopic!.objectives.map((objective) => objective.titlePl);
      expect(titles).toEqual(["Ubrania", "Pogoda"]);
      expect(draft.review).toEqual({
        status: "reviewed",
        model: "fake-reviewer-1",
        objectives: draft.objectiveIds.map((objectiveId, i) => ({ objectiveId, title: titles[i], status: "reviewed" })),
        changed: [{ exerciseId: fixed.id, category: "ambiguous", reasonPl: "Doprecyzowano.", beforePl: report.changed[0]!.beforePl, addedVariants: [] }],
        dropped: [],
        notes: [{ exerciseId: noted.id, category: "too_hard", reasonPl: "Trudne słowo.", fixRejected: false }],
        toppedUp: 0,
      });
      expect(JSON.stringify(draft.review)).not.toContain("fingerprint");
    });

    it("wpisy ćwiczeń zmienionych albo usuniętych po kontroli znikają z DTO, choć raport w kontekście zostaje", async () => {
      const { services, deckId, draft, fixed, noted } = await fixedDraft();
      const edited = await editLessonDraft(services, draft.id, {
        expectedEditNumber: draft.editNumber,
        exercises: editInputs(draft.exercises
          .filter((exercise) => exercise.id !== noted.id)
          .map((exercise) => (exercise.id === fixed.id ? { ...exercise, instructionPl: "Rodzic zmienił polecenie. Wybierz słowo." } : exercise))),
      });
      expect(edited.review).toMatchObject({ status: "reviewed", changed: [], notes: [] });
      expect((await readLessonDeck(services, deckId)).draft!.review).toMatchObject({ changed: [], notes: [] });
      const stored = (await reportOf(draft.id))!;
      expect(stored.changed.map((entry) => entry.exerciseId)).toEqual([fixed.id]);
      expect(stored.notes.map((entry) => entry.exerciseId)).toEqual([noted.id]);
    });

    it("wersja opublikowana nie ma raportu w DTO", async () => {
      const { services, deckId, draft } = await fixedDraft();
      await publishLessonDraft(services, draft.id, draft.editNumber);
      const deck = await readLessonDeck(services, deckId);
      expect(deck.draft).toBeNull();
      expect(deck.published!.id).toBe(draft.id);
      expect(deck.published!.review).toBeUndefined();
      expect(await reportOf(draft.id)).toBeDefined();
    });

    it("krytyk wyłączony → brak raportu w DTO; nieskonfigurowany → raport unreviewed z powodem", async () => {
      const disabled = await world({ reviewer: null });
      const a = await generateChapter(disabled.services, TWO_OBJECTIVES);
      expect(await reportOf(a.draft.id)).toBeDefined();
      expect(a.draft.review).toBeUndefined();

      const notConfigured = await world({ reviewer: { state: "not_configured", policy: POLICY } });
      const b = await generateChapter(notConfigured.services, TWO_OBJECTIVES);
      expect(b.draft.review).toMatchObject({
        status: "unreviewed",
        objectives: b.draft.objectiveIds.map((objectiveId) => ({ objectiveId, status: "unreviewed", reason: "not_configured" })),
        changed: [], notes: [], dropped: [],
      });
      expect(b.draft.review).not.toHaveProperty("model");
    });

    it("usunięte ćwiczenia: tytuł zagadnienia zamiast identyfikatora", async () => {
      const { services, reviewer } = await world();
      reviewer.behavior = (input) => {
        if (reviewer.inputs.length !== 1) return verdictsFor(input, {});
        const n = nOf(input, (exercise) => exercise.exerciseType === "lesson_choice");
        return verdictsFor(input, { [n]: { n, verdict: "drop", category: "wrong_answer", reasonPl: "Błędny klucz." } });
      };
      const { draft } = await generateChapter(services, TWO_OBJECTIVES);
      const report = (await reportOf(draft.id))!;
      expect(report.dropped).toHaveLength(1);
      const objectiveIndex = draft.objectiveIds.indexOf(report.dropped[0]!.objectiveId);
      expect(draft.review!.dropped).toEqual([{
        objectiveTitle: draft.dynamicTopic!.objectives[objectiveIndex]!.titlePl,
        category: "wrong_answer", reasonPl: "Błędny klucz.", snippet: report.dropped[0]!.snippet,
      }]);
    });

    it("reviewService w katalogu i w zestawie tylko, gdy usługa jest znana", async () => {
      const SERVICE = "openrouter.ai · anthropic/claude-sonnet-5.5";
      const { services, deckId } = await fixedDraft({ reviewService: SERVICE });
      expect(lessonCatalog(services).reviewService).toBe(SERVICE);
      expect((await readLessonDeck(services, deckId)).reviewService).toBe(SERVICE);
      const plain = await world();
      expect(lessonCatalog(plain.services)).not.toHaveProperty("reviewService");
      const { deckId: plainDeck } = await generateChapter(plain.services, TWO_OBJECTIVES);
      expect(await readLessonDeck(plain.services, plainDeck)).not.toHaveProperty("reviewService");
    });
  });
});
