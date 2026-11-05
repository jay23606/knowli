import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDatabase,
  completePresentation,
  computeTargetKey,
  createChild,
  createLesson,
  createLessonDraftFromPublished,
  createLessonFromMaterial,
  createSchoolLesson,
  claimQueuedRun,
  createServices,
  executeMediaAsset,
  createSubjectRegistry,
  englishGrammarSubject,
  schoolSubject,
  editLessonDraft,
  executeLessonGeneration,
  historyLikeSubject,
  nextTask,
  publishLessonDraft,
  readGeneration,
  readLessonDeck,
  startSession,
  submitAttempt,
  regenerateObjective,
  runDueGenerationWork,
  retryGeneration,
  type Services,
} from "@learning/server";
import type { LessonCommand } from "@learning/contracts";
import { countRows, testDatabase, testDatabaseUrl } from "./helpers";
import { ManualClock } from "./helpers";
import { fakeGeneration, FakeLlmProvider, routeLessonRound, type FakeGeneration } from "./fakes";

import { GenerationProviderError } from "../../packages/server/src/ports/generation-error";
import { lessonExerciseIdentity, lessonExerciseStimulusRecord } from "../../packages/server/src/domain/lessons/exercise-identity";
import type { LessonExerciseDraft } from "../../packages/server/src/domain/lessons/types";
import { DEFAULT_LESSON_GENERATION_POLICY, type LessonGenerationPolicy } from "../../packages/server/src/modules/materials/lessons/lesson-generation-policy";

/** Bez rundy pod brakujący etap: testy z pulami za małymi do pokrycia sprawdzają samą partię główną. */
const MAIN_BATCH_ONLY = { ...DEFAULT_LESSON_GENERATION_POLICY, stageTopUp: false };

const { pool } = testDatabase();

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

/** Rejestr z przedmiotem produkcyjnym + fixture historii (dowód niezależności). */
function lessonRegistry() {
  return createSubjectRegistry([englishGrammarSubject, historyLikeSubject]);
}

function lessonServices(fakes: FakeGeneration, clock = new ManualClock()): Services {
  const { db } = testDatabase();
  return createServices({
    db,
    clock,
    media: fakes.settings,
    generation: fakes.deps,
    subjects: lessonRegistry(),
  });
}

function command(overrides: Partial<LessonCommand> = {}): LessonCommand {
  return {
    subjectId: "english_grammar",
    topicId: "present_simple",
    objectiveIds: ["english_grammar.present_simple.third_person_s"],
    material: "He plays football. She watches TV. They study English every day.",
    instruction: "Ćwicz -s w 3. osobie.",
    clientRequestId: randomUUID(),
    ...overrides,
  };
}

/** Request puli wisi do przerwania; `entered` mówi, że run już w nim czeka. */
function hangLessonRequests(fakes: FakeGeneration) {
  // Limity z zapasem na obciążony procesor: przerwanie przychodzi z edycji/shutdownu,
  // a request przed nim nie może sam wygasnąć (wcześniej 2 s).
  fakes.deps.lessonExecution = { requestTimeoutMs: 10_000, runTimeoutMs: 15_000, cancelPollMs: 10 };
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let requestSignal!: AbortSignal;
  fakes.deps.llm.generateLessonPool = async (_input, signal) => {
    requestSignal = signal!;
    enter();
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  };
  return { entered, signal: () => requestSignal };
}

/** Zapis klucza kontekstu lekcji bezpośrednio w bazie (dane sprzed zmiany kodu). */
async function setLessonContextKey(versionId: string, key: string, value: unknown) {
  await pool.query(
    "update learning_app.deck_versions set lesson_context = jsonb_set(lesson_context, $1::text[], $2::jsonb) where id = $3",
    [[key], JSON.stringify(value), versionId],
  );
}

describe("generowanie puli lekcji (integracja)", () => {
  const disposers: Array<() => Promise<void>> = [];

  async function generatedLessonDraft() {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = lessonServices(fakes);
    const { runId, deckId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);
    expect((await readGeneration(services, runId)).state).toBe("succeeded");
    return { services, deckId, draft: (await readLessonDeck(services, deckId)).draft! };
  }

  beforeEach(async () => {
    await pool.query(
      `truncate learning_app.generation_runs, learning_app.revision_assets, learning_app.media_assets,
              learning_app.item_revision_skills, learning_app.item_revisions, learning_app.skill_versions,
              learning_app.learning_items, learning_app.deck_versions, learning_app.decks cascade`,
    );
  });

  afterEach(async () => {
    for (const dispose of disposers.splice(0)) {
      await dispose();
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it("createLesson tworzy deck lekcji, wersję draft i run w jednej transakcji; idempotentnie po clientRequestId", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = lessonServices(fakes);
    const cmd = command();

    const first = await createLesson(services, cmd);
    const second = await createLesson(services, cmd);

    expect(second).toEqual(first);
    expect(await countRows("decks")).toBe(1);
    expect(await countRows("generation_runs")).toBe(1);

    const [deck] = await query<{ kind: string }>("select kind from learning_app.decks where id = $1", [first.deckId]);
    expect(deck!.kind).toBe("lesson");

    const [version] = await query<{ state: string; lesson_context: Record<string, unknown>; source_locale: string; target_locale: string }>(
      "select state, lesson_context, source_locale, target_locale from learning_app.deck_versions where deck_id = $1",
      [first.deckId],
    );
    expect(version!.state).toBe("draft");
    expect(version!.source_locale).toBe("pl-PL");
    expect(version!.target_locale).toBe("en-GB");
    expect(version!.lesson_context).toMatchObject({
      subjectId: "english_grammar",
      topicId: "present_simple",
      topicVersion: 1,
      objectiveIds: ["english_grammar.present_simple.third_person_s"],
      examples: {},
      rejectedCount: 0,
    });

    const run = await readGeneration(services, first.runId);
    expect(run.state).toBe("queued");
    expect(run.deckId).toBe(first.deckId);
  });

  it("równoległe createLesson z tym samym kluczem → jeden run i deck", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = lessonServices(fakes);
    const cmd = command();

    const [a, b] = await Promise.all([createLesson(services, cmd), createLesson(services, cmd)]);
    expect(a).toEqual(b);
    expect(await countRows("decks")).toBe(1);
    expect(await countRows("generation_runs")).toBe(1);
  });

  it("nieznany przedmiot / temat / cel → 400 validation", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = lessonServices(fakes);

    await expect(createLesson(services, command({ subjectId: "nope", clientRequestId: randomUUID() }))).rejects.toMatchObject({ code: "validation" });
    await expect(createLesson(services, command({ topicId: "nope", clientRequestId: randomUUID() }))).rejects.toMatchObject({ code: "validation" });
    await expect(
      createLesson(services, command({ objectiveIds: ["english_grammar.present_simple.nope"], clientRequestId: randomUUID() })),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("wykonanie zapisuje poprawne ćwiczenia z payload_version 2, target_key i umiejętnością objective; wersja w review; examples uzupełnione", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = lessonServices(fakes);

    const { runId, deckId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);

    const run = await readGeneration(services, runId);
    expect(run.state).toBe("succeeded");

    // Profil promptu przedmiotu niesie reguły pól (semantyka hint) do adaptera LLM.
    const llmInput = fakes.llm.lessonRequests[0]!;
    expect(llmInput.promptProfile.fieldRules).toContain("BASE FORM");
    // Gramatyka nie ma haka zdań kart (#237): pierwsza partia pełnej generacji nie dostaje zdań do unikania.
    expect(llmInput).not.toHaveProperty("avoidSentences");

    const versionId = run.deckVersionId!;
    const [version] = await query<{ state: string; lesson_context: { examples: Record<string, string[]> } }>(
      "select state, lesson_context from learning_app.deck_versions where id = $1",
      [versionId],
    );
    expect(version!.state).toBe("review");
    expect(Object.keys(version!.lesson_context.examples)).toContain("english_grammar.present_simple.third_person_s");

    const revisions = await query<{ payload_version: number; payload: Record<string, unknown>; target_key: string; item_id: string }>(
      "select payload_version, payload, target_key, item_id from learning_app.item_revisions where deck_version_id = $1 order by position",
      [versionId],
    );
    expect(revisions.length).toBeGreaterThan(0);
    for (const r of revisions) {
      expect(r.payload_version).toBe(2);
      expect(r.payload).toMatchObject({ answerLocale: "en-GB", promptLocale: "pl-PL" });
      expect(r.target_key).toMatch(/^[0-9a-f]{64}$/);
    }

    const items = await query<{ count: number }>(
      "select count(*)::int as count from learning_app.learning_items where deck_id = $1 and kind = 'lesson_exercise'",
      [deckId],
    );
    expect(items[0]!.count).toBe(revisions.length);

    // umiejętność objective per rewizja (jedna)
    const skills = await query<{ count: number }>(
      `select count(*)::int as count from learning_app.item_revision_skills irs
         join learning_app.item_revisions ir on ir.id = irs.item_revision_id
        where ir.deck_version_id = $1 and irs.skill = 'objective'`,
      [versionId],
    );
    expect(skills[0]!.count).toBe(revisions.length);

    // Gramatyka nie zleca TTS odpowiedzi; przypina wyłącznie nagrania zdań feedbacku i wyjaśnień błędu.
    const roles = await query<{ role: string }>("select distinct role from learning_app.revision_assets order by role");
    expect(roles).toEqual([{ role: "explanation_audio" }, { role: "feedback_audio" }]);
  });

  it("szkic gramatyki zawiera ćwiczenia wyboru ze słuchu na cel, bez odrzuceń, a port dostaje dodatek poza podziałem etapów", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = lessonServices(fakes);

    const { runId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);

    const run = await readGeneration(services, runId);
    expect(run.state).toBe("succeeded");
    expect(fakes.llm.lessonRequests[0]!.listenChoicePerObjective).toBe(2);
    const versionId = run.deckVersionId!;
    const [version] = await query<{ lesson_context: { rejectedCount: number } }>(
      "select lesson_context from learning_app.deck_versions where id = $1",
      [versionId],
    );
    expect(version!.lesson_context.rejectedCount).toBe(0);
    const revisions = await query<{ payload: Record<string, unknown> }>(
      "select payload from learning_app.item_revisions where deck_version_id = $1 and payload->>'exerciseType' = 'lesson_listen_choice'",
      [versionId],
    );
    expect(revisions).toHaveLength(2);
    for (const { payload } of revisions) {
      expect(payload).not.toHaveProperty("instructionPl");
      expect(payload).not.toHaveProperty("hint");
      expect(payload).not.toHaveProperty("visualSubject");
    }
  });

  it("świeże wyjście modelu: polecenie, podpowiedź i piktogram ćwiczenia słuchowego są usuwane zamiast odrzucać ćwiczenie", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    fakes.deps.lessonExecution = MAIN_BATCH_ONLY;
    const services = lessonServices(fakes);
    fakes.llm.queueLesson({
      exercises: [{
        exerciseType: "lesson_listen_choice",
        objectiveId: "english_grammar.present_simple.third_person_s",
        instructionPl: "Wybierz słowo.",
        stem: "He ___ football every day.",
        hint: "play",
        visualSubject: "boy",
        answer: "plays",
        acceptedAnswers: [],
        focus: ["plays"],
        options: [{ id: "a", text: "plays" }, { id: "b", text: "play" }],
        correctOption: "a",
      }],
    });

    const { runId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);

    const run = await readGeneration(services, runId);
    expect(run.state).toBe("succeeded");
    const versionId = run.deckVersionId!;
    const [version] = await query<{ lesson_context: { rejectedCount: number } }>(
      "select lesson_context from learning_app.deck_versions where id = $1",
      [versionId],
    );
    expect(version!.lesson_context.rejectedCount).toBe(0);
    const revisions = await query<{ payload: Record<string, unknown> }>(
      "select payload from learning_app.item_revisions where deck_version_id = $1",
      [versionId],
    );
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.payload).toMatchObject({ exerciseType: "lesson_listen_choice", stem: "He ___ football every day." });
    expect(revisions[0]!.payload).not.toHaveProperty("hint");
    expect(revisions[0]!.payload).not.toHaveProperty("visualSubject");
    expect(revisions[0]!.payload).not.toHaveProperty("instructionPl");
  });

  it("pełna generacja wielocelowa przekazuje bodźce wcześniejszych partii do deduplikacji ćwiczeń", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = lessonServices(fakes);

    // Dwa cele, pula 20 → 2 partie po 10 ćwiczeń podziału etapów plus 2 ćwiczenia
    // wyboru ze słuchu na cel (dodatek poza podziałem). Gramatyka deduplikuje
    // ćwiczenia po bodźcu, więc wcześniejszy kontekst zawiera ich tożsamości,
    // a nie zakaz odpowiedzi takich jak do/does.
    const { runId } = await createLesson(
      services,
      command({
        objectiveIds: [
          "english_grammar.present_simple.affirmative_base",
          "english_grammar.present_simple.third_person_s",
        ],
        poolSize: 20,
        clientRequestId: randomUUID(),
      }),
    );
    await executeLessonGeneration(services, runId);
    expect((await readGeneration(services, runId)).state).toBe("succeeded");

    // Jedna partia na cel; druga zna bodźce z pierwszej partii.
    expect(fakes.llm.lessonRequests).toHaveLength(2);
    const [first, second] = fakes.llm.lessonRequests;
    expect(first!.existingAnswers ?? []).toEqual([]);
    expect(second!.existingAnswers ?? []).toEqual([]);
    expect(second!.existingExercises ?? []).toHaveLength(12);

    const run = await readGeneration(services, runId);
    const revisions = await query<{ payload: LessonExerciseDraft }>(
      "select payload from learning_app.item_revisions where deck_version_id = $1",
      [run.deckVersionId!],
    );
    expect(revisions.length).toBe(24);
    const firstObjectiveExercises = revisions
      .map((row) => row.payload)
      .filter((exercise) => exercise.objectiveId === "english_grammar.present_simple.affirmative_base");
    expect(firstObjectiveExercises).toHaveLength(12);
    expect(second!.existingExercises).toEqual(firstObjectiveExercises.map((exercise) => lessonExerciseStimulusRecord(exercise)));
    expect(new Set(revisions.map(({ payload }) => lessonExerciseIdentity(payload))).size).toBe(24);
  });

  it("wariant acceptedAnswers redundantny wobec odpowiedzi (skrót przeczenia „to be”) jest porzucany, nie zabija ćwiczenia", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    fakes.deps.lessonExecution = MAIN_BATCH_ONLY;
    const services = lessonServices(fakes);
    const objectiveId = "english_grammar.to_be.negative_forms";
    // Incydent prod 2026-10-26: model regularnie podaje wariant skrótowy
    // („They're not…”) przy odpowiedzi kanonicznej „They aren't…” — po
    // normalizacji to ten sam tekst, więc bez sanityzacji walidacja fazy 1
    // odrzucała CAŁE ćwiczenie i cel tracił ćwiczenia samodzielne.
    fakes.llm.queueLesson({
      exercises: [
        {
          exerciseType: "lesson_open_answer",
          objectiveId,
          instructionPl: "Przetłumacz zdanie na angielski.",
          prompt: "Oni nie są w mojej klasie.",
          answer: "They aren't in my class.",
          acceptedAnswers: ["They're not in my class.", "They are not in my class."],
          focus: ["aren't"],
        },
      ],
    });

    const { runId } = await createLesson(
      services,
      command({
        topicId: "to_be",
        objectiveIds: [objectiveId],
        material: "They aren't in my class. We aren't late.",
        clientRequestId: randomUUID(),
      }),
    );
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      await executeLessonGeneration(services, runId);
    } finally {
      spy.mockRestore();
    }

    const run = await readGeneration(services, runId);
    expect(run.state).toBe("succeeded");
    const revisions = await query<{ payload: { answer: string; acceptedAnswers: string[] } }>(
      "select payload from learning_app.item_revisions where deck_version_id = $1",
      [run.deckVersionId!],
    );
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.payload.answer).toBe("They aren't in my class.");
    expect(revisions[0]!.payload.acceptedAnswers).toEqual([]);
    // Sanityzacja nie jest odrzuceniem — licznik pozostaje zerowy…
    const [version] = await query<{ lesson_context: { rejectedCount: number } }>(
      "select lesson_context from learning_app.deck_versions where id = $1",
      [run.deckVersionId!],
    );
    expect(version!.lesson_context.rejectedCount).toBe(0);
    // …ale zostawia licznik w logach workera (bez treści wariantów).
    expect(logs.filter((line) => line.includes("[lesson]")).join("\n")).toMatch(/sanityzacja wariantów: porzucone=2/);
  });

  it("częściowe odrzucenia: niepoprawne ćwiczenia odrzucone pojedynczo, licznik dostępny", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = lessonServices(fakes);
    fakes.llm.queueLesson({ invalid: true });

    const { runId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);

    const run = await readGeneration(services, runId);
    expect(run.state).toBe("succeeded");
    const versionId = run.deckVersionId!;
    const [version] = await query<{ lesson_context: { rejectedCount: number } }>(
      "select lesson_context from learning_app.deck_versions where id = $1",
      [versionId],
    );
    expect(version!.lesson_context.rejectedCount).toBeGreaterThan(0);
    const items = await query<{ count: number }>(
      "select count(*)::int as count from learning_app.item_revisions where deck_version_id = $1",
      [versionId],
    );
    expect(items[0]!.count).toBeGreaterThan(0);
  });

  it("czyszczenie świeżej puli: odrzucenia z powodami sumują się w kontekście, a hak nie działa przy edycji rodzica", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    fakes.deps.lessonExecution = MAIN_BATCH_ONLY;
    const refineCalls: number[] = [];
    const refiningSubject = {
      ...englishGrammarSubject,
      refineGeneratedPool: (drafts: readonly LessonExerciseDraft[], ctx: { material: string }) => {
        refineCalls.push(drafts.length);
        expect(ctx.material).toContain("plays football");
        const kept = drafts.filter((draft) => draft.answer !== "banned");
        return {
          kept,
          rejected: drafts.filter((draft) => draft.answer === "banned")
            .map((exercise) => ({ exercise, reason: "słowo spoza materiału: banned" })),
        };
      },
      exposureText: (draft: LessonExerciseDraft) => `Zdanie: ${draft.answer}.`,
    } as typeof englishGrammarSubject;
    const services = createServices({
      db: testDatabase().db,
      clock: new ManualClock(),
      media: fakes.settings,
      generation: fakes.deps,
      subjects: createSubjectRegistry([englishGrammarSubject, refiningSubject, historyLikeSubject].map((subject, index) =>
        index === 1 ? { ...subject, id: "english_grammar_refined" } : subject)),
    });
    const objectiveId = "english_grammar.present_simple.third_person_s";
    const choice = (answer: string, wrong: string, stem: string) => ({
      exerciseType: "lesson_choice", objectiveId, instructionPl: "Wybierz.", stem, answer, acceptedAnswers: [], focus: [],
      options: [{ id: "a", text: answer }, { id: "b", text: wrong }], correctOption: "a",
    });
    fakes.llm.queueLesson({ exercises: [
      choice("plays", "play", "She ___ football."),
      choice("banned", "ban", "He ___ it."),
      choice("banned", "ban", "They ___ it?"),
    ] });

    const { runId, deckId } = await createLesson(services, command({ subjectId: "english_grammar_refined" }));
    await executeLessonGeneration(services, runId);
    expect((await readGeneration(services, runId)).state).toBe("succeeded");
    expect(refineCalls).toEqual([3]);
    const first = await readLessonDeck(services, deckId);
    expect(first.draft!.rejectedCount).toBe(2);
    expect(first.draft!.rejectedReasons).toEqual({ "słowo spoza materiału: banned": 2 });
    expect(first.draft!.exercises.map((exercise) => exercise.answer)).toEqual(["plays"]);
    const [stored] = await query<{ target_key: string }>(
      "select target_key from learning_app.item_revisions where deck_version_id = $1", [first.draft!.id],
    );
    expect(stored!.target_key).toBe(computeTargetKey("Zdanie: plays.", "en-GB"));

    // Dogenerowanie też czyści świeże wyjście i sumuje powody z poprzednim kontekstem.
    fakes.llm.queueLesson({ exercises: [
      choice("banned", "ban", "We ___ it."),
      choice("works", "work", "She ___ hard."),
    ] });
    const topUp = await regenerateObjective(services, {
      deckId, objectiveId, count: 2, expectedEditNumber: first.draft!.editNumber, clientRequestId: randomUUID(),
    });
    await executeLessonGeneration(services, topUp.runId);
    expect((await readGeneration(services, topUp.runId)).state).toBe("succeeded");
    expect(refineCalls).toEqual([3, 2]);
    const second = await readLessonDeck(services, deckId);
    expect(second.draft!.rejectedCount).toBe(3);
    expect(second.draft!.rejectedReasons).toEqual({ "słowo spoza materiału: banned": 3 });
    expect(second.draft!.exercises.map((exercise) => exercise.answer).sort()).toEqual(["plays", "works"]);

    // Edycja rodzica nie przechodzi przez hak: słowo spoza „materiału” zostaje, a klucz ekspozycji liczy exposureText.
    const kept = second.draft!.exercises.map(({ revisionId: _revisionId, ...exercise }) => exercise);
    const edited = await editLessonDraft(services, second.draft!.id, {
      expectedEditNumber: second.draft!.editNumber,
      exercises: [...kept, choice("banned", "ban", "I ___ it.")],
    });
    expect(refineCalls).toEqual([3, 2]);
    expect(edited.exercises.map((exercise) => exercise.answer)).toContain("banned");
    const keys = await query<{ target_key: string }>(
      "select target_key from learning_app.item_revisions where deck_version_id = $1", [edited.id],
    );
    expect(keys.map((row) => row.target_key)).toContain(computeTargetKey("Zdanie: banned.", "en-GB"));
    expect(keys.map((row) => row.target_key)).not.toContain(computeTargetKey("banned", "en-GB"));
    expect(edited.rejectedReasons).toEqual({ "słowo spoza materiału: banned": 3 });
  });

  it.each(["options", "acceptedAnswers", "focus"])("zły KSZTAŁT %s nie wywraca runu: poprawne zapisane, błędny odrzucony, run terminalny (P2-7)", async (malformedField) => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    fakes.deps.lessonExecution = MAIN_BATCH_ONLY;
    const services = lessonServices(fakes);
    const objectiveId = "english_grammar.present_simple.third_person_s";
    // Jedno poprawne ćwiczenie + jedno o złym kształcie tablicy opcji (null w
    // środku). Walidacja kształtu musi odrzucić błędne, nie rzucać TypeError.
    fakes.llm.queueLesson({
      exercises: [
        {
          exerciseType: "lesson_choice",
          objectiveId,
          instructionPl: "Wybierz.",
          stem: "She ___ football.",
          answer: "plays",
          acceptedAnswers: [],
          focus: [],
          options: [
            { id: "a", text: "plays" },
            { id: "b", text: "play" },
          ],
          correctOption: "a",
        },
        {
          exerciseType: "lesson_choice",
          objectiveId,
          instructionPl: "Wybierz.",
          stem: "She ___ TV.",
          answer: "watches",
          acceptedAnswers: [],
          focus: [],
          // zły kształt: null w tablicy opcji
          options: [{ id: "a", text: "watches" }, { id: "b", text: "watch" }],
          correctOption: "b",
          [malformedField]: [null],
        },
      ],
    });

    const { runId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);

    const run = await readGeneration(services, runId);
    expect(run.state).toBe("succeeded"); // run terminalny, nie „running”
    const versionId = run.deckVersionId!;
    const [version] = await query<{ state: string; lesson_context: { rejectedCount: number } }>(
      "select state, lesson_context from learning_app.deck_versions where id = $1",
      [versionId],
    );
    expect(version!.state).toBe("review");
    expect(version!.lesson_context.rejectedCount).toBeGreaterThanOrEqual(1); // błędny kształt policzony
    const rows = await query<{ answer: string }>(
      "select payload->>'answer' as answer from learning_app.item_revisions where deck_version_id = $1",
      [versionId],
    );
    expect(rows.map((r) => r.answer)).toEqual(["plays"]); // tylko poprawne zapisane
  });

  it("nullExerciseDoesNotRetryWholeRun", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    fakes.deps.lessonExecution = MAIN_BATCH_ONLY;
    const services = lessonServices(fakes);
    const objectiveId = "english_grammar.present_simple.third_person_s";
    fakes.llm.queueLesson({ exercises: [
      {
        exerciseType: "lesson_choice",
        objectiveId,
        instructionPl: "Wybierz.",
        stem: "She ___ football.",
        answer: "plays",
        acceptedAnswers: [],
        focus: [],
        options: [{ id: "a", text: "plays" }, { id: "b", text: "play" }],
        correctOption: "a",
      },
      null,
    ] });

    const { runId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);

    const run = await readGeneration(services, runId);
    expect(run.state).toBe("succeeded");
    expect(run.attempts).toBe(1);
    const [version] = await query<{ lesson_context: { rejectedCount: number } }>(
      "select lesson_context from learning_app.deck_versions where id = $1",
      [run.deckVersionId!],
    );
    expect(version!.lesson_context.rejectedCount).toBe(1);
    const rows = await query<{ count: number }>(
      "select count(*)::int as count from learning_app.item_revisions where deck_version_id = $1",
      [run.deckVersionId!],
    );
    expect(rows[0]!.count).toBe(1);
  });

  it("odrzuca wadliwe przykłady, zachowując prawidłowe przykłady i ćwiczenia", async () => {
    const fakes = await fakeGeneration(); disposers.push(fakes.dispose);
    const services = lessonServices(fakes);
    const generate = fakes.llm.generateLessonPool.bind(fakes.llm);
    const objective = "english_grammar.present_simple.third_person_s";
    fakes.llm.generateLessonPool = async (...args) => ({ ...await generate(...args), examples: {
      [objective]: ["He plays.", null, " ", "x".repeat(121)], unknown: ["Wrong objective."],
    } as unknown as Record<string, string[]> });
    const { runId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);
    const run = await readGeneration(services, runId);
    expect(run.state).toBe("succeeded");
    const [row] = await query<{ lesson_context: { examples: Record<string, string[]> } }>("select lesson_context from learning_app.deck_versions where id=$1", [run.deckVersionId]);
    expect(row!.lesson_context.examples).toEqual({ [objective]: ["He plays."] });
  });

  it("wznawia run po przerwaniu workera już po claimie", async () => {
    const fakes = await fakeGeneration(); disposers.push(fakes.dispose);
    const services = lessonServices(fakes);
    const { runId } = await createLesson(services, command());
    await claimQueuedRun(services.db, runId);
    expect((await readGeneration(services, runId)).state).toBe("running");
    const reopened = createDatabase(testDatabaseUrl());
    try {
      const restarted = createServices({ db: reopened.db, clock: services.clock, media: fakes.settings, generation: fakes.deps });
      const oldEdit = (await query<{ expected_edit_number: number }>("select expected_edit_number from learning_app.generation_runs where id=$1", [runId]))[0]!.expected_edit_number;
      await retryGeneration(restarted, runId);
      const edit = (await query<{ expected_edit_number: number }>("select expected_edit_number from learning_app.generation_runs where id=$1", [runId]))[0]!.expected_edit_number;
      expect(edit).toBe(oldEdit + 1);
      await runDueGenerationWork(restarted);
      expect((await readGeneration(restarted, runId)).state).toBe("succeeded");
    } finally { await reopened.pool.end(); }
  });

  it("ponowienie żywego runu odcina spóźniony zapis starego workera", async () => {
    const fakes = await fakeGeneration(); disposers.push(fakes.dispose);
    const services = lessonServices(fakes);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const generate = fakes.llm.generateLessonPool.bind(fakes.llm);
    let first = true;
    fakes.llm.generateLessonPool = async (...args) => {
      const result = await generate(...args);
      if (first) { first = false; enter(); await released; }
      return result;
    };
    const { runId } = await createLesson(services, command());
    const pending = executeLessonGeneration(services, runId);
    await entered;
    let before: unknown[] = [];
    try {
      await retryGeneration(services, runId);
      await executeLessonGeneration(services, runId);
      before = await query("select id, payload from learning_app.item_revisions order by id");
      expect((await readGeneration(services, runId)).state).toBe("succeeded");
    } finally { release(); await pending; }
    expect(await query("select id, payload from learning_app.item_revisions order by id")).toEqual(before);
    expect((await readGeneration(services, runId)).state).toBe("succeeded");
  });

  it("stary SELECT przed claimem nie przejmuje nowego wykonania po retry", async () => {
    const fakes = await fakeGeneration(); disposers.push(fakes.dispose);
    const services = lessonServices(fakes);
    const isolated = createDatabase(testDatabaseUrl());
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const original = isolated.pool.query.bind(isolated.pool);
    let paused = false;
    isolated.pool.query = (async (...args: unknown[]) => {
      const result = await (original as (...values: unknown[]) => Promise<unknown>)(...args);
      const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text ?? "";
      if (!paused && /^select/i.test(sql) && sql.includes("generation_runs")) { paused = true; enter(); await released; }
      return result;
    }) as typeof isolated.pool.query;
    const staleServices = createServices({ db: isolated.db, clock: services.clock, media: fakes.settings, generation: fakes.deps });
    const { runId } = await createLesson(services, command());
    const stale = executeLessonGeneration(staleServices, runId);
    await entered;
    try {
      await claimQueuedRun(services.db, runId);
      await retryGeneration(services, runId);
      release();
      await stale;
      expect((await readGeneration(services, runId)).state).toBe("queued");
      await executeLessonGeneration(services, runId);
      expect((await readGeneration(services, runId)).state).toBe("succeeded");
    } finally { release(); await stale; await isolated.pool.end(); }
  });

  it("0 poprawnych → failed/validation; wersja nadal draft; brak elementów", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    fakes.deps.lessonExecution = MAIN_BATCH_ONLY;
    const services = lessonServices(fakes);
    fakes.llm.queueLesson({ exercises: [{ exerciseType: "lesson_gap", objectiveId: "english_grammar.present_simple.third_person_s", answer: "a b c d", acceptedAnswers: [], focus: [], stem: "no marker" }] });

    const { runId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);

    const run = await readGeneration(services, runId);
    expect(run.state).toBe("failed");
    expect(run.errorCode).toBe("validation");
    const [version] = await query<{ state: string }>("select state from learning_app.deck_versions where id = $1", [run.deckVersionId!]);
    expect(version!.state).toBe("draft");
    const items = await query<{ count: number }>("select count(*)::int as count from learning_app.item_revisions where deck_version_id = $1", [run.deckVersionId!]);
    expect(items[0]!.count).toBe(0);
  });

  it("loguje [lesson] podsumowanie walidacji z powodami odrzuceń i wynik terminalny", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    fakes.deps.lessonExecution = MAIN_BATCH_ONLY;
    const services = lessonServices(fakes);
    fakes.llm.queueLesson({
      exercises: [
        // Wariant „plays” równoważny odpowiedzi kanonicznej jest porzucany
        // przez sanityzację przyjęcia puli, więc regułę acceptedAnswers
        // wyzwala dopiero pusty wariant obok niego.
        { exerciseType: "lesson_gap", objectiveId: "english_grammar.present_simple.third_person_s", answer: "plays", acceptedAnswers: ["plays", "   "], focus: ["plays"], stem: "She ___ tennis." },
        { exerciseType: "lesson_choice", objectiveId: "english_grammar.present_simple.third_person_s", answer: "runs", acceptedAnswers: [], focus: ["runs"], stem: "He ___ fast.", options: [{ id: "a", text: "runs" }, { id: "b", text: "run" }, { id: "c", text: "running" }, { id: "d", text: "ran" }, { id: "e", text: "to run" }], correctOption: "a" },
      ],
    });

    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      const { runId } = await createLesson(services, command());
      await executeLessonGeneration(services, runId);
      const run = await readGeneration(services, runId);
      expect(run.state).toBe("failed");
      expect(run.errorCode).toBe("validation");
    } finally {
      spy.mockRestore();
    }

    const lessonLogs = logs.filter((line) => line.includes("[lesson]")).join("\n");
    // Start runu z kontekstem (identyfikowalność w logach workera), łącznie
    // z modelem LLM (A/B generacji po logach, UMIEM_LLM_MODEL).
    expect(lessonLogs).toMatch(/generacja run=\S+ .*cel[ie]=.*model=\S+/);
    // Podsumowanie walidacji: tylko liczniki i kody reguł, bez treści ćwiczeń.
    expect(lessonLogs).toMatch(/walidacja puli: surowe=\d+ zły_kształt=\d+ obcy_cel=\d+ odrzucone=\d+ ważne=\d+/);
    expect(lessonLogs).toContain("acceptedAnswers×1");
    expect(lessonLogs).toContain("options×1");
    // Wynik terminalny runu.
    expect(lessonLogs).toMatch(/zakończony: state=failed kod=validation/);
  });

  it("loguje [lesson] błąd partii LLM i wynik attempts_exhausted", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const clock = new ManualClock();
    const services = lessonServices(fakes, clock);
    fakes.llm.queueLesson({ error: "llm timeout", retryable: true });

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      const { runId } = await createLesson(services, command());
      for (let i = 0; i < 3; i += 1) {
        await executeLessonGeneration(services, runId);
        if (i < 2) {
          const [scheduled] = await query<{ next_attempt_at: Date }>("select next_attempt_at from learning_app.generation_runs where id=$1", [runId]);
          clock.advanceMs(Math.max(0, scheduled!.next_attempt_at.getTime() - clock.now().getTime()));
        }
      }
      const run = await readGeneration(services, runId);
      expect(run.state).toBe("failed");
      expect(run.errorCode).toBe("attempts_exhausted");
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }

    const lessonLogs = logs.filter((line) => line.includes("[lesson]")).join("\n");
    expect(lessonLogs).toMatch(/błąd partii LLM: kod=provider/);
    expect(lessonLogs).not.toContain("llm timeout");
    expect(lessonLogs).toMatch(/zakończony: state=failed kod=attempts_exhausted/);
  });

  it("odpowiedź strict-schema (komplet pól z nullami) przechodzi przez strażnik kształtu do zapisu", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = lessonServices(fakes);
    // Strict mode zwraca WSZYSTKIE pola schematu; nie dotyczące typu mają null.
    fakes.llm.queueLesson({
      exercises: [
        {
          exerciseType: "lesson_gap",
          objectiveId: "english_grammar.present_simple.third_person_s",
          answer: "plays",
          acceptedAnswers: ["play"],
          focus: ["plays"],
          instructionPl: "Uzupełnij lukę.",
          stem: "She ___ tennis.",
          statement: null,
          prompt: null,
          hint: null,
          transformId: null,
          noticeSegments: null,
          options: null,
          correctOption: null,
          items: null,
        },
      ],
      examples: {},
    });

    const { runId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);

    const run = await readGeneration(services, runId);
    expect(run.state).toBe("succeeded");
    expect(run.errorCode).toBeNull();
    const items = await query<{ count: number }>("select count(*)::int as count from learning_app.item_revisions where deck_version_id = $1", [run.deckVersionId!]);
    expect(items[0]!.count).toBeGreaterThanOrEqual(1);
  });

  it("błąd providera → ponowienie do wyczerpania prób (attempts_exhausted)", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const clock = new ManualClock();
    const services = lessonServices(fakes, clock);
    fakes.llm.queueLesson({ error: "llm timeout", retryable: true });

    const { runId } = await createLesson(services, command());
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await executeLessonGeneration(services, runId);
      const dto = await readGeneration(services, runId);
      expect(dto.state).toBe("queued");
      expect(dto.attempts).toBe(attempt);
      const [scheduled] = await query<{ next_attempt_at: Date }>("select next_attempt_at from learning_app.generation_runs where id=$1", [runId]);
      clock.advanceMs(Math.max(0, scheduled!.next_attempt_at.getTime() - clock.now().getTime()));
    }
    await executeLessonGeneration(services, runId);
    const exhausted = await readGeneration(services, runId);
    expect(exhausted.state).toBe("failed");
    expect(exhausted.errorCode).toBe("attempts_exhausted");
  });

  it("błąd trwały kończy się po jednym żądaniu, a retry ręczny czyści odroczenie", async () => {
    const fakes = await fakeGeneration(); disposers.push(fakes.dispose);
    const clock = new ManualClock();
    const services = lessonServices(fakes, clock);
    const originalGenerate = fakes.llm.generateLessonPool.bind(fakes.llm);
    let providerCalls = 0;
    fakes.llm.generateLessonPool = async () => {
      providerCalls += 1;
      throw new GenerationProviderError("configuration", { status: 400 });
    };
    const { runId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);
    expect((await readGeneration(services, runId)).errorCode).toBe("provider_configuration");
    expect(providerCalls).toBe(1);
    await retryGeneration(services, runId);
    expect((await readGeneration(services, runId)).state).toBe("queued");
    expect((await readGeneration(services, runId)).attempts).toBe(0);
    fakes.llm.generateLessonPool = originalGenerate;
  });

  it("odracza transient retry do nextAttemptAt; ręczne retry skraca odroczenie", async () => {
    const fakes = await fakeGeneration(); disposers.push(fakes.dispose);
    const clock = new ManualClock();
    const services = lessonServices(fakes, clock);
    fakes.llm.queueLesson({ error: "temporary", retryable: true });
    const { runId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);
    const [scheduled] = await query<{ next_attempt_at: Date; attempts: number }>("select next_attempt_at, attempts from learning_app.generation_runs where id=$1", [runId]);
    expect(scheduled!.next_attempt_at.getTime()).toBeGreaterThan(clock.now().getTime());
    expect(scheduled!.attempts).toBe(1);
    await executeLessonGeneration(services, runId);
    expect(fakes.llm.lessonRequests).toHaveLength(1);
    await retryGeneration(services, runId);
    const [cleared] = await query<{ next_attempt_at: Date | null; attempts: number }>("select next_attempt_at, attempts from learning_app.generation_runs where id=$1", [runId]);
    expect(cleared).toEqual({ next_attempt_at: null, attempts: 0 });
  });

  it("restart procesu workera wykonuje zlecony run lekcji", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = lessonServices(fakes);

    const { runId } = await createLesson(services, command());
    expect((await readGeneration(services, runId)).state).toBe("queued");

    const restarted = createDatabase(testDatabaseUrl());
    const restartedServices = createServices({
      db: restarted.db,
      clock: new ManualClock(),
      media: fakes.settings,
      generation: fakes.deps,
      subjects: lessonRegistry(),
    });
    try {
      await runDueGenerationWork(restartedServices);
    } finally {
      await restarted.pool.end();
    }

    const dto = await readGeneration(services, runId);
    expect(dto.state).toBe("succeeded");
    const [version] = await query<{ state: string }>("select state from learning_app.deck_versions where id = $1", [dto.deckVersionId!]);
    expect(version!.state).toBe("review");
  });

  it("regenerateObjective dopisuje nowe ćwiczenia bez powtórzenia bodźca", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = lessonServices(fakes);

    const { runId, deckId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);
    const versionId = (await readGeneration(services, runId)).deckVersionId!;
    const before = await query<{ payload: LessonExerciseDraft }>("select payload from learning_app.item_revisions where deck_version_id = $1", [versionId]);
    const beforeCount = before.length;

    const regen = await regenerateObjective(services, {
      deckId,
      objectiveId: "english_grammar.present_simple.third_person_s",
      count: 4,
      expectedEditNumber: 2,
      clientRequestId: randomUUID(),
    });
    await executeLessonGeneration(services, regen.runId);

    const after = await query<{ payload: LessonExerciseDraft }>("select payload from learning_app.item_revisions where deck_version_id = $1", [versionId]);
    expect(after.length).toBeGreaterThan(beforeCount);
    const [version] = await query<{ edit_number: number }>("select edit_number from learning_app.deck_versions where id = $1", [versionId]);
    expect(version!.edit_number).toBe(3);
    await expect(editLessonDraft(services, versionId, { expectedEditNumber: 2, title: "stary formularz" })).rejects.toMatchObject({ code: "conflict" });
    // Każde ćwiczenie ma unikalny bodziec w swoim celu; odpowiedź sama w sobie
    // nie jest kluczem deduplikacji dla gramatyki.
    const identities = after.map(({ payload }) => lessonExerciseIdentity(payload));
    expect(new Set(identities).size).toBe(identities.length);
  });

  it("rezerwuje tylko jeden aktywny top-up na szkic i zachowuje idempotencję tego samego żądania", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = lessonServices(fakes);
    const { runId, deckId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);
    const expectedEditNumber = 2;
    const objectiveId = "english_grammar.present_simple.third_person_s";
    const firstKey = randomUUID();
    const secondKey = randomUUID();
    const [first, competing] = await Promise.allSettled([
      regenerateObjective(services, { deckId, objectiveId, count: 4, expectedEditNumber, clientRequestId: firstKey }),
      regenerateObjective(services, { deckId, objectiveId, count: 4, expectedEditNumber, clientRequestId: secondKey }),
    ]);
    const accepted = first.status === "fulfilled" ? first.value : competing.status === "fulfilled" ? competing.value : null;
    const rejected = first.status === "rejected" ? first.reason : competing.status === "rejected" ? competing.reason : null;
    expect(accepted).not.toBeNull();
    expect(rejected).toMatchObject({ code: "conflict" });
    const repeated = await regenerateObjective(services, {
      deckId, objectiveId, count: 4, expectedEditNumber, clientRequestId: first.status === "fulfilled" ? firstKey : secondKey,
    });
    expect(repeated.runId).toBe(accepted!.runId);
  });

  it("edycja rodzica unieważnia queued run przed wywołaniem providera", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = lessonServices(fakes);
    const { runId } = await createLesson(services, command());
    const queued = await readGeneration(services, runId);
    await editLessonDraft(services, queued.deckVersionId!, { expectedEditNumber: 1, title: "Zmiana rodzica" });
    expect((await readGeneration(services, runId)).state).toBe("superseded");
    await executeLessonGeneration(services, runId);
    expect(fakes.llm.lessonRequests).toHaveLength(0);
    const [version] = await query<{ edit_number: number; title: string }>("select edit_number, title from learning_app.deck_versions where id = $1", [queued.deckVersionId]);
    expect(version).toMatchObject({ edit_number: 2, title: "Zmiana rodzica" });
  });

  it("edycja rodzica przerywa request w toku i nie zapisuje spóźnionego wyniku", async () => {
    const fakes = await fakeGeneration(); disposers.push(fakes.dispose);
    const hang = hangLessonRequests(fakes);
    const services = lessonServices(fakes);
    const { runId } = await createLesson(services, command());
    const run = await readGeneration(services, runId);
    const pending = executeLessonGeneration(services, runId);
    await hang.entered;
    await editLessonDraft(services, run.deckVersionId!, { expectedEditNumber: 1, title: "Nowa treść rodzica" });
    await pending;
    expect(hang.signal().aborted).toBe(true);
    expect((await readGeneration(services, runId)).state).toBe("superseded");
    expect(await query("select id from learning_app.item_revisions where deck_version_id=$1", [run.deckVersionId])).toHaveLength(0);
  });

  it("shutdown oddaje aktualny run do kolejki bez cofania wykorzystanej próby", async () => {
    const fakes = await fakeGeneration(); disposers.push(fakes.dispose);
    const hang = hangLessonRequests(fakes);
    const services = lessonServices(fakes);
    const { runId } = await createLesson(services, command());
    const controller = new AbortController();
    const pending = executeLessonGeneration(services, runId, { signal: controller.signal });
    await hang.entered;
    controller.abort();
    await pending;
    const result = await readGeneration(services, runId);
    expect(hang.signal().aborted).toBe(true);
    expect(result.state).toBe("queued");
    expect(result.attempts).toBe(1);
    expect(await query("select id from learning_app.item_revisions where deck_version_id=$1", [result.deckVersionId])).toHaveLength(0);
  });

  it("przedmiot fixture historii (ttsForAnswers=false) przechodzi cały przepływ bez audio", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = lessonServices(fakes);

    const { runId } = await createLesson(
      services,
      command({
        subjectId: "test_history",
        topicId: "piast_origins",
        objectiveIds: ["test_history.piast_origins.chrzest_966"],
        material: "Mieszko I przyjął chrzest w 966 roku. Chrzest Polski.",
        clientRequestId: randomUUID(),
      }),
    );
    await executeLessonGeneration(services, runId);

    const run = await readGeneration(services, runId);
    expect(run.state).toBe("succeeded");
    const [version] = await query<{ state: string }>("select state from learning_app.deck_versions where id = $1", [run.deckVersionId!]);
    expect(version!.state).toBe("review");
    const items = await query<{ count: number }>("select count(*)::int as count from learning_app.item_revisions where deck_version_id = $1", [run.deckVersionId!]);
    expect(items[0]!.count).toBeGreaterThan(0);
    // ttsForAnswers=false → brak zasobów audio
    expect(await countRows("media_assets")).toBe(0);
    expect(await countRows("revision_assets")).toBe(0);
  });

  it("TTS przypadkowo podpięte do lekcji z wyłączonym audio nadal kończy jako superseded", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = lessonServices(fakes);
    const { runId } = await createLesson(services, command({
      subjectId: "test_history",
      topicId: "piast_origins",
      objectiveIds: ["test_history.piast_origins.chrzest_966"],
      material: "Mieszko I przyjął chrzest w 966 roku. Chrzest Polski.",
      clientRequestId: randomUUID(),
    }));
    await executeLessonGeneration(services, runId);
    const [revision] = await query<{ id: string }>(
      "select id from learning_app.item_revisions where deck_version_id = (select deck_version_id from learning_app.generation_runs where id = $1) limit 1",
      [runId],
    );
    const assetId = randomUUID();
    const fingerprint = `disabled-lesson-${randomUUID()}`;
    await pool.query(
      `insert into learning_app.media_assets(id, kind, fingerprint, generation_number, state, provider, model, metadata)
       values ($1, 'tts', $2, 1, 'pending', $3, $4, $5)`,
      [assetId, fingerprint, fakes.settings.tts.provider, fakes.settings.tts.model,
        { text: "test answer", locale: "en-GB", voice: fakes.settings.tts.voice, format: "mp3" }],
    );
    await pool.query(
      `insert into learning_app.revision_assets(item_revision_id, role, asset_id, expected_fingerprint, state)
       values ($1, 'target_audio', $2, $3, 'pending')`,
      [revision!.id, assetId, fingerprint],
    );
    await pool.query(
      `insert into learning_app.generation_runs(id, asset_id, kind, dedupe_key, state, input)
       values ($1, $2, 'tts', $3, 'queued', $4)`,
      [randomUUID(), assetId, `asset:${assetId}`, { text: "test answer" }],
    );

    await executeMediaAsset(services, assetId);
    const [asset] = await query<{ state: string }>("select state from learning_app.media_assets where id = $1", [assetId]);
    const [mediaRun] = await query<{ state: string }>("select state from learning_app.generation_runs where asset_id = $1", [assetId]);
    expect(asset?.state).toBe("failed");
    expect(mediaRun?.state).toBe("superseded");
    expect(fakes.tts.requests).toHaveLength(0);
  });
  it("rozdział angielskiego: zestaw z materiału ma stały tytuł przedmiotu, bez nazwy od rodzica, i jest idempotentny", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    // rejestr produkcyjny (gramatyka, szkoła, rozdział)
    const services = createServices({ db: testDatabase().db, clock: new ManualClock(), media: fakes.settings, generation: fakes.deps });
    const command = {
      subjectId: "english_chapter",
      topicTitlePl: "Unit 1",
      material: "I like pizza. What do you like?",
      poolSize: 40,
      clientRequestId: randomUUID(),
    };

    const { runId, deckId } = await createLessonFromMaterial(services, command);
    // ponowienie tego samego polecenia nie tworzy drugiego zestawu
    await expect(createLessonFromMaterial(services, command)).resolves.toEqual({ runId, deckId });
    const [created] = await query<{ versions: number; runs: number }>(
      "select (select count(*)::int from learning_app.deck_versions where deck_id = $1) as versions, (select count(*)::int from learning_app.generation_runs where dedupe_key = $2) as runs",
      [deckId, `lesson:${command.clientRequestId}`],
    );
    expect(created).toEqual({ versions: 1, runs: 1 });

    const [deck] = await query<{ title: string; kind: string }>("select title, kind from learning_app.decks where id = $1", [deckId]);
    expect(deck).toEqual({ title: "Angielski — rozdział: Unit 1", kind: "lesson" });
    const [version] = await query<{
      state: string; source_locale: string; target_locale: string;
      lesson_context: Record<string, unknown>;
    }>("select state, source_locale, target_locale, lesson_context from learning_app.deck_versions where deck_id = $1", [deckId]);
    expect(version).toMatchObject({ state: "draft", source_locale: "pl-PL", target_locale: "en-GB" });
    expect(version!.lesson_context).toMatchObject({
      subjectId: "english_chapter", topicId: "dynamic", objectiveIds: [], poolSize: 40, material: command.material, rejectedCount: 0,
    });
    // przedmiot o stałym tytule: nazwy przedmiotu od rodzica nie zapisujemy
    expect(version!.lesson_context).not.toHaveProperty("subjectTitlePl");
    const [run] = await query<{ kind: string; state: string; input: Record<string, unknown> }>(
      "select kind, state, input from learning_app.generation_runs where id = $1", [runId],
    );
    expect(run).toMatchObject({ kind: "lesson", state: "queued" });
    expect(run!.input).toMatchObject({ subjectId: "english_chapter", topicId: "dynamic", topicTitlePl: "Unit 1", poolSize: 40 });
    expect(run!.input).not.toHaveProperty("subjectTitlePl");

    // szkoła i gramatyka nie przechodzą tą ścieżką
    await expect(createLessonFromMaterial(services, { ...command, subjectId: "school", clientRequestId: randomUUID() })).rejects.toMatchObject({ code: "validation" });
    await expect(createLessonFromMaterial(services, { ...command, subjectId: "english_grammar", clientRequestId: randomUUID() })).rejects.toMatchObject({ code: "validation" });
  });
  it("gramatyka: fake provider generuje wyjaśnienia, a rewizje i DTO szkicu je niosą", async () => {
    const fakes = await fakeGeneration(); disposers.push(fakes.dispose);
    const services = lessonServices(fakes);
    const { runId, deckId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);
    const run = await readGeneration(services, runId);
    expect(run.state).toBe("succeeded");

    const rows = await query<{ payload: { explanationPl?: string } }>(
      "select payload from learning_app.item_revisions where deck_version_id = $1 and payload->>'exerciseType' is not null",
      [run.deckVersionId!],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.payload.explanationPl).toBe("Ta reguła mówi, jak zbudować poprawne zdanie.");

    const draft = (await readLessonDeck(services, deckId)).draft!;
    expect(draft.exercises.length).toBe(rows.length);
    for (const exercise of draft.exercises) expect(exercise.explanationPl).toBe("Ta reguła mówi, jak zbudować poprawne zdanie.");
  });

  it("gramatyka: wyjaśnienie łamiące reguły jest po cichu usuwane, ćwiczenie zostaje", async () => {
    const fakes = await fakeGeneration(); disposers.push(fakes.dispose);
    const services = lessonServices(fakes);
    const generate = fakes.llm.generateLessonPool.bind(fakes.llm);
    // Złe wyjaśnienie dostaje ćwiczenie ze środka puli; test szuka go potem po treści,
    // nie po pozycji, więc kolejność rewizji szkicu nie ma znaczenia.
    const identity = (exercise: { exerciseType: string; answer: string; stem?: string; prompt?: string }) =>
      JSON.stringify([exercise.exerciseType, exercise.stem ?? null, exercise.prompt ?? null, exercise.answer]);
    let broken: string | undefined;
    fakes.llm.generateLessonPool = async (...args) => {
      const result = await generate(...args);
      const target = Math.floor(result.exercises.length / 2);
      const exercises = result.exercises.map((exercise, index) => {
        if (index !== target) return exercise;
        broken = identity(exercise as unknown as Parameters<typeof identity>[0]);
        return { ...exercise as Record<string, unknown>, explanationPl: "Pierwsze zdanie. Drugie zdanie." };
      });
      return { ...result, exercises };
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { runId, deckId } = await createLesson(services, command());
      await executeLessonGeneration(services, runId);
      const run = await readGeneration(services, runId);
      expect(run.state).toBe("succeeded");
      const exercises = (await readLessonDeck(services, deckId)).draft!.exercises;
      expect(exercises.length).toBeGreaterThan(1);
      expect(broken).toBeDefined();
      const matching = exercises.filter((exercise) => identity(exercise) === broken);
      expect(matching).toHaveLength(1);
      expect(matching[0]!.explanationPl).toBeUndefined();
      const others = exercises.filter((exercise) => identity(exercise) !== broken);
      for (const exercise of others) expect(exercise.explanationPl).toBe("Ta reguła mówi, jak zbudować poprawne zdanie.");
      expect(log.mock.calls.map((call) => String(call[0]))).toContain(`[lesson] run=${runId} porzucone wyjaśnienia=1`);
      const [version] = await query<{ lesson_context: { rejectedCount: number } }>(
        "select lesson_context from learning_app.deck_versions where id = $1", [run.deckVersionId!]);
      expect(version!.lesson_context.rejectedCount).toBe(0);
    } finally { log.mockRestore(); }
  });

  it("szkoła: wyjaśnienie z modelu jest odrzucane po cichu (przedmiot bez flagi)", async () => {
    const fakes = await fakeGeneration(); disposers.push(fakes.dispose);
    const { db } = testDatabase();
    const services = createServices({
      db, clock: new ManualClock(), media: fakes.settings, generation: fakes.deps,
      subjects: createSubjectRegistry([schoolSubject]),
    });
    const generate = fakes.llm.generateLessonPool.bind(fakes.llm);
    let sawFlag: boolean | undefined;
    fakes.llm.generateLessonPool = async (input, ...rest) => {
      sawFlag = input.exerciseExplanations;
      const result = await generate(input, ...rest);
      return { ...result, exercises: result.exercises.map((exercise) => ({ ...exercise as Record<string, unknown>, explanationPl: "Roślina robi cukry ze światła." })) };
    };
    const { runId, deckId } = await createSchoolLesson(services, {
      subjectTitlePl: "Przyroda", topicTitlePl: "Fotosynteza",
      material: [
        "Zagadnienie 1: Fotosynteza",
        "Wyjaśnienie: Fotosynteza to proces, w którym roślina z wody i dwutlenku węgla, przy udziale światła, wytwarza cukry. Cukry są pokarmem rośliny.",
      ].join("\n"),
      poolSize: 40, clientRequestId: randomUUID(),
    });
    await executeLessonGeneration(services, runId);
    expect((await readGeneration(services, runId)).state).toBe("succeeded");
    expect(sawFlag).toBe(false);
    const exercises = (await readLessonDeck(services, deckId)).draft!.exercises;
    expect(exercises.length).toBeGreaterThan(0);
    for (const exercise of exercises) expect(exercise.explanationPl).toBeUndefined();
  });

  it("zestaw szkolny: generacja wyprowadza zagadnienia z materiału i zapisuje ćwiczenia v3 z cytatami", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const { db } = testDatabase();
    const services = createServices({
      db,
      clock: new ManualClock(),
      media: fakes.settings,
      generation: fakes.deps,
      subjects: createSubjectRegistry([schoolSubject]),
    });
    const material = [
      "Zagadnienie 1: Fotosynteza",
      "Wyjaśnienie: Fotosynteza to proces, w którym roślina z wody i dwutlenku węgla, przy udziale światła, wytwarza cukry. Cukry są pokarmem rośliny.",
      "Zagadnienie 2: Chrzest Polski",
      "Wyjaśnienie: Mieszko I przyjął chrzest w 966 roku. Chrzest włączył państwo do chrześcijańskiej Europy i wzmocnił władzę księcia.",
    ].join("\n");

    const { runId, deckId } = await createSchoolLesson(services, {
      subjectTitlePl: "Przyroda i historia",
      topicTitlePl: "Materiał pilotażowy",
      material,
      poolSize: 40,
      clientRequestId: randomUUID(),
    });
    await executeLessonGeneration(services, runId);

    const run = await readGeneration(services, runId);
    expect(run.state).toBe("succeeded");
    expect(fakes.llm.objectiveRequests).toHaveLength(1);

    const versionId = run.deckVersionId!;
    const [version] = await query<{ state: string; lesson_context: { dynamicTopic?: { objectives: { id: string }[] }; objectiveIds: string[] } }>(
      "select state, lesson_context from learning_app.deck_versions where id = $1",
      [versionId],
    );
    expect(version!.state).toBe("review");
    expect(version!.lesson_context.dynamicTopic?.objectives).toHaveLength(2);
    expect(version!.lesson_context.objectiveIds).toHaveLength(2);
    for (const id of version!.lesson_context.objectiveIds) {
      expect(id.startsWith(`school.d${deckId}.`)).toBe(true);
    }

    const revisions = await query<{ payload_version: number; payload: Record<string, unknown> }>(
      "select payload_version, payload from learning_app.item_revisions where deck_version_id = $1 order by position",
      [versionId],
    );
    expect(revisions.length).toBeGreaterThan(0);
    for (const r of revisions) {
      expect(r.payload_version).toBe(3);
      expect(Array.isArray(r.payload.sourceRefs)).toBe(true);
    }
    const open = revisions.find((r) => r.payload.exerciseType === "lesson_open_answer");
    expect(open).toBeDefined();
    expect(Array.isArray(open!.payload.requiredElements)).toBe(true);
  });

  it("zestaw szkolny: ton lektora z generatora trafia do payloadu rewizji, kontekstu i DTO szkicu", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const { db } = testDatabase();
    const services = createServices({
      db,
      clock: new ManualClock(),
      media: fakes.settings,
      generation: fakes.deps,
      subjects: createSubjectRegistry([schoolSubject]),
    });
    const material = [
      "Zagadnienie 1: Fotosynteza",
      "Wyjaśnienie: Fotosynteza to proces, w którym roślina z wody i dwutlenku węgla, przy udziale światła, wytwarza cukry. Cukry są pokarmem rośliny.",
      "Zagadnienie 2: Chrzest Polski",
      "Wyjaśnienie: Mieszko I przyjął chrzest w 966 roku. Chrzest włączył państwo do chrześcijańskiej Europy i wzmocnił władzę księcia.",
    ].join("\n");
    const { runId, deckId } = await createSchoolLesson(services, {
      subjectTitlePl: "Przyroda i historia",
      topicTitlePl: "Materiał pilotażowy",
      material,
      poolSize: 40,
      clientRequestId: randomUUID(),
    });
    await executeLessonGeneration(services, runId);

    const deck = await readLessonDeck(services, deckId);
    const toned = deck.draft!.exercises.filter((ex) => ex.voiceTone !== undefined);
    expect(toned.length).toBeGreaterThan(0);
    expect(deck.draft!.exercises[0]!.voiceTone).toBe("curious");
    expect(deck.draft!.dynamicTopic!.objectives[0]!.cards[0]!.voiceTone).toBe("cheerful");

    const [version] = await query<{ lesson_context: { dynamicTopic: { objectives: { cards: { voiceTone?: string }[] }[] } } }>(
      "select lesson_context from learning_app.deck_versions where id = $1",
      [deck.draft!.id],
    );
    expect(version!.lesson_context.dynamicTopic.objectives[0]!.cards[0]!.voiceTone).toBe("cheerful");
    const revisions = await query<{ payload: { voiceTone?: string } }>(
      "select payload from learning_app.item_revisions where deck_version_id = $1 and payload ? 'voiceTone'",
      [deck.draft!.id],
    );
    expect(revisions).toHaveLength(toned.length);
  });

  it("rachunki: liczy parametry, odrzuca pojedyncze wadliwe rekordy i nie ufa parentAdded modelu", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = createServices({
      db: testDatabase().db, clock: new ManualClock(), media: fakes.settings,
      generation: fakes.deps, subjects: createSubjectRegistry([schoolSubject]),
    });
    const material = "Skala mapy pozwala przeliczyć odległość na mapie na odległość w terenie.";
    const { runId, deckId } = await createSchoolLesson(services, {
      subjectTitlePl: "Geografia", topicTitlePl: "Skala mapy", material,
      poolSize: 40, clientRequestId: randomUUID(),
    });
    const objectiveId = `school.d${deckId}.skala_mapy`;
    const raw = {
      exerciseType: "lesson_calculation", objectiveId,
      calculation: { kind: "scale_distance", params: { scaleDenominator: 25000, mapDistanceCm: 3 }, unit: "m", templateFamilyId: "map-scale" },
      sourceRefs: [{ quote: material, parentAdded: true }],
    };
    const generate = fakes.llm.generateLessonPool.bind(fakes.llm);
    fakes.deps.llm.generateLessonPool = async (input) => {
      const regular = await new FakeLlmProvider().generateLessonPool(input);
      fakes.llm.queueLesson({ exercises: [
        ...regular.exercises, raw,
        { ...raw, calculation: { ...raw.calculation, kind: "unknown" } },
        { ...raw, calculation: { ...raw.calculation, params: { scaleDenominator: 25000, mapDistanceCm: 5 } },
          sourceRefs: [{ quote: "Ten cytat nie występuje w materiale rodzica.", parentAdded: true }] },
      ] });
      return generate(input);
    };
    await executeLessonGeneration(services, runId);
    expect((await readGeneration(services, runId)).state).toBe("succeeded");
    const deck = await readLessonDeck(services, deckId);
    const calculations = deck.draft!.exercises.filter((exercise) => exercise.exerciseType === "lesson_calculation");
    expect(calculations).toHaveLength(1);
    expect(calculations[0]).toMatchObject({ answer: "750 m", calculation: raw.calculation, sourceRefs: [{ quote: material }] });
    expect(calculations[0]!.sourceRefs![0]).not.toHaveProperty("parentAdded");
    expect(deck.draft!.rejectedCount).toBe(2);
    expect(deck.draft!.coverage).toEqual([]);

    // Ta sama metoda i parametry z inną rodziną nadal są duplikatem istniejącej puli.
    fakes.deps.llm.generateLessonPool = async (input) => {
      fakes.llm.queueLesson({ exercises: [
        { ...raw, calculation: { ...raw.calculation, templateFamilyId: "renamed-family" } },
        { ...raw, calculation: { ...raw.calculation, params: { scaleDenominator: 25000, mapDistanceCm: 4 } } },
      ] });
      return generate(input);
    };
    const topUp = await regenerateObjective(services, {
      deckId, objectiveId, count: 2, expectedEditNumber: deck.draft!.editNumber, clientRequestId: randomUUID(),
    });
    await executeLessonGeneration(services, topUp.runId);
    const after = await readLessonDeck(services, deckId);
    const afterCalculations = after.draft!.exercises.filter((exercise) => exercise.exerciseType === "lesson_calculation");
    expect(afterCalculations.map((exercise) => exercise.answer).sort()).toEqual(["1000 m", "750 m"]);
    expect(after.draft!.exercises.length).toBe(deck.draft!.exercises.length + 1);
  });

  it("zestaw szkolny: publikacja i sesja dziecka na typach zamkniętych", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const { db } = testDatabase();
    const services = createServices({
      db,
      clock: new ManualClock(),
      media: fakes.settings,
      generation: fakes.deps,
      subjects: createSubjectRegistry([schoolSubject]),
    });
    const material = [
      "Zagadnienie 1: Fotosynteza",
      "Wyjaśnienie: Fotosynteza to proces, w którym roślina z wody i dwutlenku węgla, przy udziale światła, wytwarza cukry. Cukry są pokarmem rośliny.",
      "Zagadnienie 2: Chrzest Polski",
      "Wyjaśnienie: Mieszko I przyjął chrzest w 966 roku. Chrzest włączył państwo do chrześcijańskiej Europy i wzmocnił władzę księcia.",
    ].join("\n");

    const { runId, deckId } = await createSchoolLesson(services, {
      subjectTitlePl: "Przyroda i historia",
      topicTitlePl: "Materiał pilotażowy",
      material,
      poolSize: 40,
      clientRequestId: randomUUID(),
    });
    await executeLessonGeneration(services, runId);

    const deck = await readLessonDeck(services, deckId);
    expect(deck.draft?.dynamicTopic?.objectives).toHaveLength(2);
    expect(deck.draft!.exercises.some((exercise) => exercise.exerciseType === "lesson_calculation")).toBe(false);
    expect(deck.draft?.subjectTitlePl).toBe("Przyroda i historia");
    expect(deck.draft?.coverage).toEqual([]);
    await publishLessonDraft(services, deck.draft!.id, deck.draft!.editNumber);

    const child = await createChild(services, { displayName: "Szkolny", avatarKey: "owl" });
    await pool.query(
      "insert into learning_app.assignments (id, child_id, deck_id, test_date, test_goals) values ($1, $2, $3, null, null)",
      [randomUUID(), child.id, deckId],
    );

    const session = await startSession(services, { childId: child.id, deckId, microphoneEnabled: false });
    let answered = false;
    for (let i = 0; i < 20 && !answered; i++) {
      const task = await nextTask(services, session.sessionId);
      if (task === null) break;
      if (task.exerciseType === "lesson_card") {
        await completePresentation(services, { taskId: task.taskId });
        continue;
      }
      if (task.exerciseType !== "lesson_choice") {
        await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "skip" });
        continue;
      }
      const [keyRow] = await query<{ answer_key: { correctOptionId?: string } }>(
        "select answer_key from learning_app.session_tasks where id = $1",
        [task.taskId],
      );
      await submitAttempt(services, {
        taskId: task.taskId,
        clientAttemptId: randomUUID(),
        modality: "choice",
        optionId: keyRow!.answer_key.correctOptionId!,
      });
      answered = true;
    }
    expect(answered).toBe(true);
    const assessments = await query<{ count: number }>(
      "select count(*)::int as count from learning_app.assessments where child_id = $1 and skill = 'objective' and outcome = 'correct'",
      [child.id],
    );
    expect(assessments[0]!.count).toBeGreaterThan(0);
  });

  it("zestaw szkolny: patch dynamicTopic edytuje karty, usuwa zagadnienie; sfałszowany cytat odrzucany", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const { db } = testDatabase();
    const services = createServices({
      db,
      clock: new ManualClock(),
      media: fakes.settings,
      generation: fakes.deps,
      subjects: createSubjectRegistry([schoolSubject]),
    });
    const material = [
      "Zagadnienie 1: Fotosynteza",
      "Wyjaśnienie: Fotosynteza to proces, w którym roślina z wody i dwutlenku węgla, przy udziale światła, wytwarza cukry. Cukry są pokarmem rośliny.",
      "Zagadnienie 2: Chrzest Polski",
      "Wyjaśnienie: Mieszko I przyjął chrzest w 966 roku. Chrzest włączył państwo do chrześcijańskiej Europy i wzmocnił władzę księcia.",
    ].join("\n");
    const { runId, deckId } = await createSchoolLesson(services, {
      subjectTitlePl: "Przyroda i historia",
      topicTitlePl: "Materiał pilotażowy",
      material,
      poolSize: 40,
      clientRequestId: randomUUID(),
    });
    await executeLessonGeneration(services, runId);
    const deck = await readLessonDeck(services, deckId);
    const kept = deck.draft!.dynamicTopic!.objectives[0]!;

    const edited = await editLessonDraft(services, deck.draft!.id, {
      expectedEditNumber: deck.draft!.editNumber,
      dynamicTopic: {
        objectives: [{
          id: kept.id,
          titlePl: "Fotosynteza (poprawiona)",
          cards: [
            { title: kept.cards[0]!.title, body: "Poprawiona treść karty przez rodzica." },
            kept.cards[1]!,
          ],
        }],
      },
    });
    expect(edited.dynamicTopic?.objectives).toHaveLength(1);
    expect(edited.dynamicTopic?.objectives[0]?.cards[0]?.body).toBe("Poprawiona treść karty przez rodzica.");
    expect(edited.objectiveIds).toEqual([kept.id]);
    expect(edited.exercises.every((ex) => ex.objectiveId === kept.id)).toBe(true);

    const forged = edited.exercises.map((ex, i) => {
      const { revisionId: _revisionId, promptAudio: _promptAudio, ...input } = ex;
      return i === 0 ? { ...input, sourceRefs: [{ quote: "tego zdania z pewnością nie ma w materiale źródłowym" }] } : input;
    });
    await expect(
      editLessonDraft(services, edited.id, { expectedEditNumber: edited.editNumber, exercises: forged }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("„Utwórz nową wersję” → kopia bez review i bez generationGaps", async () => {
    const { services, deckId, draft } = await generatedLessonDraft();

    // Dawny raport krytyka i luki agenta tamtej wersji (pola kontekstu).
    await setLessonContextKey(draft.id, "review", { status: "reviewed", objectives: [] });
    await setLessonContextKey(draft.id, "generationGaps", [{ objectiveId: draft.objectiveIds[0], reason: "incomplete" }]);
    await publishLessonDraft(services, draft.id, draft.editNumber);
    const copy = await createLessonDraftFromPublished(services, deckId);

    const contextOf = (id: string) => query<{ review: unknown; gaps: unknown }>(
      "select lesson_context->'review' as review, lesson_context->'generationGaps' as gaps from learning_app.deck_versions where id = $1",
      [id],
    );
    expect(copy.id).not.toBe(draft.id);
    expect(await contextOf(copy.id)).toEqual([{ review: null, gaps: null }]);
    const [source] = await contextOf(draft.id);
    expect(source!.review).not.toBeNull();
    expect(source!.gaps).not.toBeNull();
    expect(copy.examples).toEqual(draft.examples);
    expect(copy).not.toHaveProperty("generationGaps");
  });

  it("DTO szkicu nie ma review mimo starego klucza w kontekście", async () => {
    const { services, deckId, draft } = await generatedLessonDraft();

    await setLessonContextKey(draft.id, "review", {
      status: "reviewed",
      objectives: [{ objectiveId: draft.objectiveIds[0], status: "reviewed" }],
      notes: [], changed: [], dropped: [], machine: [], toppedUp: [],
    });

    expect((await readLessonDeck(services, deckId)).draft).not.toHaveProperty("review");
  });

  describe("reguła twarda: rozwiązanie widoczne wcześniej (spec etapu przeglądu §5.2)", () => {
    const EXPOSURE_REASON = "rozwiązanie widoczne wcześniej";
    const SCHOOL_MATERIAL = [
      "Zagadnienie 1: Fotosynteza",
      "Wyjaśnienie: Fotosynteza to proces, w którym roślina z wody i dwutlenku węgla, przy udziale światła, wytwarza cukry. Cukry są pokarmem rośliny.",
      "Zagadnienie 2: Chrzest Polski",
      "Wyjaśnienie: Mieszko I przyjął chrzest w 966 roku. Chrzest włączył państwo do chrześcijańskiej Europy i wzmocnił władzę księcia.",
    ].join("\n");

    function schoolServices(fakes: FakeGeneration): Services {
      return createServices({
        db: testDatabase().db,
        clock: new ManualClock(),
        media: fakes.settings,
        generation: fakes.deps,
        subjects: createSubjectRegistry([schoolSubject]),
      });
    }

    async function generateSchool(services: Services) {
      const { runId, deckId } = await createSchoolLesson(services, {
        subjectTitlePl: "Przyroda i historia",
        topicTitlePl: "Materiał pilotażowy",
        material: SCHOOL_MATERIAL,
        poolSize: 40,
        clientRequestId: randomUUID(),
      });
      await executeLessonGeneration(services, runId);
      expect((await readGeneration(services, runId)).state).toBe("succeeded");
      return (await readLessonDeck(services, deckId)).draft!;
    }

    it("gramatyka: tłumaczenie równe przykładowi karty nie trafia do szkicu; przykład zostaje, powód i log", async () => {
      const fakes = await fakeGeneration();
      disposers.push(fakes.dispose);
      fakes.deps.lessonExecution = MAIN_BATCH_ONLY;
      const services = lessonServices(fakes);
      const objectiveId = "english_grammar.present_simple.third_person_s";
      const translation = (prompt: string, answer: string, focus: string) => ({
        exerciseType: "lesson_open_answer", objectiveId, instructionPl: "Przetłumacz zdanie na angielski.", prompt,
        answer, acceptedAnswers: [], focus: [focus],
      });
      fakes.llm.queueLesson({
        exercises: [
          {
            exerciseType: "lesson_choice", objectiveId, instructionPl: "Wybierz.", stem: "She ___ football.", answer: "plays",
            acceptedAnswers: [], focus: [], options: [{ id: "a", text: "plays" }, { id: "b", text: "play" }], correctOption: "a",
          },
          translation("On gra w piłkę.", "He plays football.", "plays"),
          translation("Ona ogląda telewizję.", "She watches TV.", "watches"),
        ],
        examples: { [objectiveId]: ["He plays football."] },
      });

      const { runId, deckId } = await createLesson(services, command());
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
      try {
        await executeLessonGeneration(services, runId);
      } finally {
        spy.mockRestore();
      }
      expect((await readGeneration(services, runId)).state).toBe("succeeded");

      const draft = (await readLessonDeck(services, deckId)).draft!;
      expect(draft.exercises.map((exercise) => exercise.answer).sort()).toEqual(["She watches TV.", "plays"]);
      expect(draft.examples[objectiveId]).toEqual(["He plays football."]);
      expect(draft.rejectedCount).toBe(1);
      expect(draft.rejectedReasons?.[EXPOSURE_REASON]).toBe(1);
      expect(logs).toContain(`[lesson] run=${runId} ujawnienia: usunięte=1 przykłady=0`);
    });

    it("szkoła: rodzina trzech pytań otwartych z jedną odpowiedzią zostaje w szkicu, a pokrycie liczy jedno", async () => {
      const fakes = await fakeGeneration();
      disposers.push(fakes.dispose);
      fakes.deps.lessonExecution = MAIN_BATCH_ONLY;
      const services = schoolServices(fakes);
      const regular = fakes.llm.generateLessonPool.bind(fakes.llm);
      const isOpen = (exercise: unknown) => (exercise as { exerciseType?: string }).exerciseType === "lesson_open_answer";
      let familyObjectiveId: string | undefined;
      fakes.deps.llm.generateLessonPool = async (input) => {
        const result = await regular(input);
        if (familyObjectiveId !== undefined) return result;
        familyObjectiveId = input.objectives[0]!.id;
        expect(input.stageCounts.independent).toBeGreaterThanOrEqual(3);
        const base = result.exercises.find(isOpen) as Record<string, unknown>;
        const family = [1, 2, 3].map((n) => ({ ...base, familyId: "fotosynteza-definicja", prompt: `Pytanie rodziny numer ${n}: czym jest fotosynteza?` }));
        return { ...result, exercises: [...result.exercises.filter((exercise) => !isOpen(exercise)), ...family] };
      };

      const draft = await generateSchool(services);
      const family = draft.exercises.filter((exercise) => exercise.objectiveId === familyObjectiveId && exercise.exerciseType === "lesson_open_answer");
      expect(family).toHaveLength(3);
      expect(new Set(family.map((exercise) => exercise.answer)).size).toBe(1);
      expect(draft.rejectedReasons?.[EXPOSURE_REASON]).toBeUndefined();
      expect(draft.coverage).toContainEqual(expect.objectContaining({ objectiveId: familyObjectiveId, stage: "independent", actual: 1, required: 2 }));
      // Miękkie powtórzenia wewnątrz rodziny są zamierzone: bez ostrzeżeń, choć pokrycie liczy rodzinę raz.
      expect(draft.exposureLeaks).toBeUndefined();
    });

    it("szkoła: reguła twarda usuwa całą rodzinę pytań otwartych → jej słowa kluczowe poza szkicem, publikacja bez błędu rodziny", async () => {
      const fakes = await fakeGeneration();
      disposers.push(fakes.dispose);
      const services = schoolServices(fakes);
      const ORPHAN_REASON = "ćwiczenie bez rodziny pytań otwartych";
      const FAMILY = "fotosynteza-rodzina";
      const isOpen = (exercise: unknown) => (exercise as { exerciseType?: string }).exerciseType === "lesson_open_answer";
      let familyObjectiveId: string | undefined;
      routeLessonRound(fakes, async (input) => {
        const result = await new FakeLlmProvider().generateLessonPool(input);
        if (familyObjectiveId !== undefined) return result;
        familyObjectiveId = input.objectives[0]!.id;
        const base = result.exercises.find(isOpen) as Record<string, unknown>;
        const family = [1, 2].map((n) => ({ ...base, familyId: FAMILY, prompt: `Pytanie rodziny numer ${n}: czym jest fotosynteza?` }));
        const keywords = {
          exerciseType: "lesson_keywords", objectiveId: familyObjectiveId, familyId: FAMILY,
          keywordOptions: [{ id: "k1", text: "światła" }, { id: "k2", text: "cukry" }, { id: "k3", text: "tlen" }, { id: "k4", text: "korzenie" }],
          keyOptionIds: ["k1", "k2"], answer: "światła, cukry", acceptedAnswers: [], focus: [], sourceRefs: [{ quote: "wytwarza cukry" }],
        };
        // Przykład karty równy odpowiedzi rodziny: reguła twarda usuwa oba pytania rodziny.
        return {
          exercises: [...result.exercises.filter((exercise) => exercise !== base), ...family, keywords],
          examples: { [familyObjectiveId]: [base.answer as string] },
        };
      });

      const draft = await generateSchool(services);
      expect(draft.exercises.some((exercise) => exercise.exerciseType === "lesson_keywords")).toBe(false);
      expect(draft.exercises.some((exercise) => exercise.familyId === FAMILY)).toBe(false);
      expect(draft.rejectedReasons?.[EXPOSURE_REASON]).toBe(2);
      expect(draft.rejectedReasons?.[ORPHAN_REASON]).toBe(1);
      expect(draft.coverage).toEqual([]);
      await expect(publishLessonDraft(services, draft.id, draft.editNumber)).resolves.toBeDefined();
    });

    it("szkoła, runda włączona: rodzina z jedną odpowiedzią → runda zamawia jedno pytanie samodzielne, inna odpowiedź domyka pokrycie", async () => {
      const fakes = await fakeGeneration();
      disposers.push(fakes.dispose);
      const services = schoolServices(fakes);
      const isOpen = (exercise: unknown) => (exercise as { exerciseType?: string }).exerciseType === "lesson_open_answer";
      let familyObjectiveId: string | undefined;
      routeLessonRound(fakes, async (input) => {
        const result = await new FakeLlmProvider().generateLessonPool(input);
        if (familyObjectiveId !== undefined) return result;
        familyObjectiveId = input.objectives[0]!.id;
        const base = result.exercises.find(isOpen) as Record<string, unknown>;
        const family = [1, 2, 3].map((n) => ({ ...base, familyId: "fotosynteza-definicja", prompt: `Pytanie rodziny numer ${n}: czym jest fotosynteza?` }));
        return { ...result, exercises: [...result.exercises.filter((exercise) => !isOpen(exercise)), ...family] };
      });

      const draft = await generateSchool(services);
      const rounds = fakes.llm.lessonRequests.filter((request) => request.purpose === "stage_top_up");
      expect(rounds).toHaveLength(1);
      expect(rounds[0]!.objectives.map((objective) => objective.id)).toEqual([familyObjectiveId]);
      expect(rounds[0]!.stageCounts).toEqual({ guided: 0, productive: 0, independent: 1 });
      expect(draft.coverage).toEqual([]);
      const open = draft.exercises.filter((exercise) => exercise.objectiveId === familyObjectiveId && exercise.exerciseType === "lesson_open_answer");
      expect(open).toHaveLength(4);
      expect(new Set(open.map((exercise) => exercise.answer)).size).toBe(2);
      // Rodzina w jednym zagadnieniu to zamierzona struktura: bez ostrzeżeń dla rodzica.
      expect(draft.exposureLeaks).toBeUndefined();
    });

    it("domyślna pula fake'a gramatyki i szkoły nie ma ujawnionych rozwiązań", async () => {
      const fakes = await fakeGeneration();
      disposers.push(fakes.dispose);
      const grammar = lessonServices(fakes);
      const { runId, deckId } = await createLesson(grammar, command({ poolSize: 20 }));
      await executeLessonGeneration(grammar, runId);
      expect((await readGeneration(grammar, runId)).state).toBe("succeeded");
      const grammarDraft = (await readLessonDeck(grammar, deckId)).draft!;
      expect(grammarDraft.rejectedReasons?.[EXPOSURE_REASON]).toBeUndefined();
      expect(grammarDraft.rejectedCount).toBe(0);

      const schoolDraft = await generateSchool(schoolServices(fakes));
      expect(schoolDraft.rejectedReasons?.[EXPOSURE_REASON]).toBeUndefined();
    });
  });

  describe("dogenerowanie pod brakujący etap (spec etapu przeglądu lekcji)", () => {
    type PoolInput = Parameters<FakeLlmProvider["generateLessonPool"]>[0];
    const EXPOSURE_REASON = "rozwiązanie widoczne wcześniej";
    const WEAR_MATERIAL = "I wear a coat. I wear boots. She wears a dress. We wear a skirt.";
    const TWO_OBJECTIVES = [
      "Zagadnienie 1: Ubrania",
      "coat, boots, dress, skirt, t-shirt",
      "Zagadnienie 2: Pogoda",
      "It's raining. It's snowing. What's the weather like?",
    ].join("\n");
    const isTranslation = (exercise: unknown) => (exercise as { exerciseType?: string }).exerciseType === "lesson_open_answer";
    const POLICY = { requestTimeoutMs: 2_000, runTimeoutMs: 60_000, cancelPollMs: 10 };

    /** Rozdział na produkcyjnym rejestrze; `topUpRequests` — żądania rundy zapisane przez `fakes.llm`. */
    async function chapterWorld(policy: LessonGenerationPolicy = POLICY) {
      const fakes = await fakeGeneration();
      disposers.push(fakes.dispose);
      fakes.deps.lessonExecution = policy;
      const services = createServices({ db: testDatabase().db, clock: new ManualClock(), media: fakes.settings, generation: fakes.deps });
      return { fakes, services, topUpRequests: () => fakes.llm.lessonRequests.filter((request) => request.purpose === "stage_top_up") };
    }

    /**
     * Partia główna: domyślna pula fake'a z dokładnie dwoma tłumaczeniami (minimum etapu samodzielnego),
     * z których drugie powtarza przykład karty zagadnienia — reguła twarda je usuwa i etap ma brak 1.
     */
    async function leakyMainBatch(input: PoolInput, leak: string) {
      const regular = await new FakeLlmProvider().generateLessonPool(input);
      const objectiveId = input.objectives[0]!.id;
      const translations = regular.exercises.filter(isTranslation);
      expect(translations.length).toBeGreaterThanOrEqual(2);
      return {
        exercises: [
          ...regular.exercises.filter((exercise) => !isTranslation(exercise)),
          translations[0],
          { ...(translations[1] as object), prompt: "Płaszcz i sukienka.", answer: leak, acceptedAnswers: [], focus: [leak.split(" ")[1]!] },
        ],
        examples: { [objectiveId]: [`${leak}.`] },
      };
    }

    const routeRound = routeLessonRound;

    async function startChapter(services: Services, material: string) {
      return createLessonFromMaterial(services, { subjectId: "english_chapter", topicTitlePl: "Ubrania", material, poolSize: 40, clientRequestId: randomUUID() });
    }

    async function withLogs<T>(work: () => Promise<T>): Promise<{ result: T; logs: string }> {
      const lines: string[] = [];
      const capture = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
      const logSpy = vi.spyOn(console, "log").mockImplementation(capture);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(capture);
      try {
        return { result: await work(), logs: lines.join("\n") };
      } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
      }
    }

    function independentCount(exercises: readonly { objectiveId: string; exerciseType: string }[], objectiveId: string) {
      return exercises.filter((exercise) => exercise.objectiveId === objectiveId && exercise.exerciseType === "lesson_open_answer").length;
    }

    it("ujawnione tłumaczenie usunięte → runda dogenerowuje brakujący etap; przykłady z rundy pomijane", async () => {
      const { fakes, services, topUpRequests } = await chapterWorld();
      const LEAK = "The coat and the dress";
      routeRound(fakes, (input) => leakyMainBatch(input, LEAK));
      const { runId, deckId } = await startChapter(services, WEAR_MATERIAL);
      const { logs } = await withLogs(() => executeLessonGeneration(services, runId));

      expect(await readGeneration(services, runId)).toMatchObject({ state: "succeeded", attempts: 1 });
      const draft = (await readLessonDeck(services, deckId)).draft!;
      const objectiveId = draft.objectiveIds[0]!;

      const rounds = topUpRequests();
      expect(rounds).toHaveLength(1);
      expect(rounds[0]!.objectives.map((objective) => objective.id)).toEqual([objectiveId]);
      expect(rounds[0]!.stageCounts).toEqual({ guided: 0, productive: 0, independent: 1 });
      expect(rounds[0]!.countPerObjective).toBe(1);
      expect(rounds[0]!).not.toHaveProperty("listenChoicePerObjective");
      expect(rounds[0]!.avoidSentences).toContain(`${LEAK}.`);

      expect(draft.coverage).toEqual([]);
      expect(independentCount(draft.exercises, objectiveId)).toBe(2);
      expect(draft.exercises.some((exercise) => exercise.answer === LEAK)).toBe(false);
      // Przykłady z odpowiedzi rundy (domyślne „I have the …” fake'a) nie trafiają na karty.
      expect(draft.examples).toEqual({ [objectiveId]: [`${LEAK}.`] });
      expect(draft.rejectedCount).toBe(1);
      expect(draft.rejectedReasons).toEqual({ [EXPOSURE_REASON]: 1 });
      expect(logs).toMatch(new RegExp(`\\[lesson\\] run=${runId} dogenerowanie pod etap: zagadnienie=\\S+ guided=0 productive=0 independent=1 przyjęte=1`));
    });

    it("dwa zagadnienia z brakiem → dwa wywołania rundy, numeracja bez kolizji i bez ujawnień", async () => {
      const { fakes, services, topUpRequests } = await chapterWorld();
      const leaks = ["The coat and the dress", "The boots and the skirt"];
      let batch = 0;
      routeRound(fakes, (input) => leakyMainBatch(input, leaks[batch++]!));
      const { runId, deckId } = await startChapter(services, TWO_OBJECTIVES);
      await executeLessonGeneration(services, runId);

      expect((await readGeneration(services, runId)).state).toBe("succeeded");
      const draft = (await readLessonDeck(services, deckId)).draft!;
      expect(draft.objectiveIds).toHaveLength(2);
      expect(topUpRequests().map((request) => request.objectives[0]!.id)).toEqual(draft.objectiveIds);
      expect(draft.coverage).toEqual([]);
      for (const objectiveId of draft.objectiveIds) expect(independentCount(draft.exercises, objectiveId)).toBe(2);
      const prompts = draft.exercises.filter(isTranslation).map((exercise) => exercise.prompt);
      expect(new Set(prompts).size).toBe(prompts.length);
      expect(draft.rejectedCount).toBe(2);
      expect(draft.rejectedReasons).toEqual({ [EXPOSURE_REASON]: 2 });
    });

    it("wynik rundy sam ujawniający rozwiązanie (tłumaczenie równe przykładowi karty) odpada; powód liczony, brak zostaje", async () => {
      const { fakes, services, topUpRequests } = await chapterWorld();
      const LEAK = "The coat and the dress";
      routeRound(fakes, async (input) => {
        const result = await leakyMainBatch(input, LEAK);
        fakes.llm.queueLessonTopUp({
          exercises: [{
            exerciseType: "lesson_open_answer", objectiveId: input.objectives[0]!.id, instructionPl: "Przetłumacz na angielski.",
            prompt: "Płaszcz i sukienka — jeszcze raz.", answer: LEAK, acceptedAnswers: [], focus: ["coat"],
          }],
          examples: {},
        });
        return result;
      });
      const { runId, deckId } = await startChapter(services, WEAR_MATERIAL);
      await executeLessonGeneration(services, runId);

      expect((await readGeneration(services, runId)).state).toBe("succeeded");
      expect(topUpRequests()).toHaveLength(1);
      const draft = (await readLessonDeck(services, deckId)).draft!;
      expect(draft.exercises.some((exercise) => exercise.answer === LEAK)).toBe(false);
      expect(draft.rejectedCount).toBe(2);
      expect(draft.rejectedReasons).toEqual({ [EXPOSURE_REASON]: 2 });
      expect(draft.coverage).toEqual([expect.objectContaining({ objectiveId: draft.objectiveIds[0], stage: "independent", required: 2, actual: 1 })]);
    });

    it("błąd providera w rundzie: run succeeded w pierwszej próbie, szkic zapisany z brakiem pokrycia", async () => {
      const { fakes, services, topUpRequests } = await chapterWorld();
      routeRound(fakes, (input) => leakyMainBatch(input, "The coat and the dress"));
      fakes.llm.queueLessonTopUp({ error: "provider down", retryable: true });
      const { runId, deckId } = await startChapter(services, WEAR_MATERIAL);
      const { logs } = await withLogs(() => executeLessonGeneration(services, runId));

      expect(await readGeneration(services, runId)).toMatchObject({ state: "succeeded", attempts: 1 });
      expect(topUpRequests()).toHaveLength(1);
      const draft = (await readLessonDeck(services, deckId)).draft!;
      expect(draft.exercises.length).toBeGreaterThan(0);
      expect(draft.coverage).toEqual([expect.objectContaining({ objectiveId: draft.objectiveIds[0], stage: "independent", required: 2, actual: 1 })]);
      expect(logs).toMatch(new RegExp(`^\\[lesson\\] run=${runId} dogenerowanie pod etap: błąd=provider$`, "m"));
      expect(logs).not.toContain("provider down");
    });

    it("runda dłuższa niż limit żądania: przerwana miękko, run succeeded bez dogenerowania", async () => {
      // Limit żądania z zapasem na obciążoną maszynę; runda czeka wyłącznie na przerwanie przez limit.
      const { fakes, services } = await chapterWorld({ requestTimeoutMs: 1_000, runTimeoutMs: 60_000, cancelPollMs: 10 });
      let roundCalls = 0;
      fakes.deps.llm.generateLessonPool = async (input, signal) => {
        if (input.purpose !== "stage_top_up") return leakyMainBatch(input, "The coat and the dress");
        roundCalls += 1;
        return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      };
      const { runId, deckId } = await startChapter(services, WEAR_MATERIAL);
      const { logs } = await withLogs(() => executeLessonGeneration(services, runId));

      expect(await readGeneration(services, runId)).toMatchObject({ state: "succeeded", attempts: 1 });
      expect(roundCalls).toBe(1);
      const draft = (await readLessonDeck(services, deckId)).draft!;
      expect(independentCount(draft.exercises, draft.objectiveIds[0]!)).toBe(1);
      expect(draft.coverage).toHaveLength(1);
      expect(logs).toContain(`[lesson] run=${runId} dogenerowanie pod etap: błąd=provider_timeout`);
    });

    it("bliski deadline przebiegu: runda pominięta z logiem „brak czasu”, run succeeded", async () => {
      const { fakes, services, topUpRequests } = await chapterWorld({ requestTimeoutMs: 2_000, runTimeoutMs: 20_000, cancelPollMs: 10 });
      routeRound(fakes, (input) => leakyMainBatch(input, "The coat and the dress"));
      const { runId } = await startChapter(services, WEAR_MATERIAL);
      const { logs } = await withLogs(() => executeLessonGeneration(services, runId));

      expect((await readGeneration(services, runId)).state).toBe("succeeded");
      expect(topUpRequests()).toHaveLength(0);
      expect(logs).toContain(`[lesson] run=${runId} dogenerowanie pod etap: pominięte: brak czasu`);
    });

    it("edycja rodzica w trakcie rundy → superseded, brak zapisu", async () => {
      const { fakes, services } = await chapterWorld();
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      let roundSignal!: AbortSignal;
      fakes.deps.llm.generateLessonPool = async (input, signal) => {
        if (input.purpose !== "stage_top_up") return leakyMainBatch(input, "The coat and the dress");
        roundSignal = signal!;
        enter();
        return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      };
      const { runId } = await startChapter(services, WEAR_MATERIAL);
      const run = await readGeneration(services, runId);
      const pending = executeLessonGeneration(services, runId);
      await entered;
      await editLessonDraft(services, run.deckVersionId!, { expectedEditNumber: 1, title: "Zmiana rodzica" });
      await pending;

      expect(roundSignal.aborted).toBe(true);
      expect((await readGeneration(services, runId)).state).toBe("superseded");
      expect(await query("select id from learning_app.item_revisions where deck_version_id=$1", [run.deckVersionId])).toHaveLength(0);
    });

    it("shutdown w trakcie rundy oddaje run do kolejki bez zapisu", async () => {
      const { fakes, services } = await chapterWorld();
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      fakes.deps.llm.generateLessonPool = async (input, signal) => {
        if (input.purpose !== "stage_top_up") return leakyMainBatch(input, "The coat and the dress");
        enter();
        return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      };
      const { runId } = await startChapter(services, WEAR_MATERIAL);
      const controller = new AbortController();
      const pending = executeLessonGeneration(services, runId, { signal: controller.signal });
      await entered;
      controller.abort();
      await pending;

      const result = await readGeneration(services, runId);
      expect(result).toMatchObject({ state: "queued", attempts: 1 });
      expect(await query("select id from learning_app.item_revisions where deck_version_id=$1", [result.deckVersionId])).toHaveLength(0);
    });

    it("zagadnienia bez braków → brak wywołania rundy", async () => {
      const { services, topUpRequests } = await chapterWorld();
      const { runId, deckId } = await startChapter(services, TWO_OBJECTIVES);
      await executeLessonGeneration(services, runId);

      expect((await readGeneration(services, runId)).state).toBe("succeeded");
      expect((await readLessonDeck(services, deckId)).draft!.coverage).toEqual([]);
      expect(topUpRequests()).toHaveLength(0);
    });

    /**
     * Szkic z brakiem etapu samodzielnego (partia główna bez rundy), potem ręczne dogenerowanie z rundą,
     * w którym partia główna nie daje żadnego przyjętego ćwiczenia.
     */
    async function regenerateWithEmptyMainBatch() {
      const world = await chapterWorld({ ...POLICY, stageTopUp: false });
      let call = 0;
      routeRound(world.fakes, async (input) => {
        call += 1;
        if (call === 1) return leakyMainBatch(input, "The coat and the dress");
        return {
          exercises: [{ exerciseType: "lesson_gap", objectiveId: input.objectives[0]!.id, answer: "a b c d", acceptedAnswers: [], focus: [], stem: "no marker" }],
          examples: {},
        };
      });
      const { runId, deckId } = await startChapter(world.services, WEAR_MATERIAL);
      await executeLessonGeneration(world.services, runId);
      const draft = (await readLessonDeck(world.services, deckId)).draft!;
      expect(draft.coverage).toEqual([expect.objectContaining({ stage: "independent", required: 2, actual: 1 })]);
      world.fakes.deps.lessonExecution = POLICY;
      const regen = await regenerateObjective(world.services, {
        deckId, objectiveId: draft.objectiveIds[0]!, count: 1, expectedEditNumber: draft.editNumber, clientRequestId: randomUUID(),
      });
      return { ...world, deckId, draft, regenRunId: regen.runId };
    }

    it("ręczne dogenerowanie: partia główna bez przyjętych, runda domyka brak → succeeded", async () => {
      const { services, topUpRequests, deckId, draft, regenRunId } = await regenerateWithEmptyMainBatch();
      await executeLessonGeneration(services, regenRunId);

      expect((await readGeneration(services, regenRunId)).state).toBe("succeeded");
      expect(topUpRequests()).toHaveLength(1);
      expect(topUpRequests()[0]!.stageCounts).toEqual({ guided: 0, productive: 0, independent: 1 });
      const after = (await readLessonDeck(services, deckId)).draft!;
      expect(after.coverage).toEqual([]);
      expect(after.exercises).toHaveLength(draft.exercises.length + 1);
      expect(after.rejectedCount).toBe(draft.rejectedCount + 1);
    });

    it("ręczne dogenerowanie: partia główna i runda bez przyjętych → failed/validation, szkic bez zmian", async () => {
      const { fakes, services, topUpRequests, deckId, draft, regenRunId } = await regenerateWithEmptyMainBatch();
      fakes.llm.queueLessonTopUp({ exercises: [], examples: {} });
      await executeLessonGeneration(services, regenRunId);

      expect(await readGeneration(services, regenRunId)).toMatchObject({ state: "failed", errorCode: "validation" });
      expect(topUpRequests()).toHaveLength(1);
      const after = (await readLessonDeck(services, deckId)).draft!;
      expect(after.exercises).toHaveLength(draft.exercises.length);
      expect(after.rejectedCount).toBe(draft.rejectedCount + 1);
    });

    it("partia główna bez przyjętych ćwiczeń → failed/validation jak dotąd, bez rundy", async () => {
      const { fakes, services, topUpRequests } = await chapterWorld();
      routeRound(fakes, async (input) => ({
        exercises: [{ exerciseType: "lesson_gap", objectiveId: input.objectives[0]!.id, answer: "a b c d", acceptedAnswers: [], focus: [], stem: "no marker" }],
        examples: {},
      }));
      const { runId } = await startChapter(services, WEAR_MATERIAL);
      await executeLessonGeneration(services, runId);

      expect(await readGeneration(services, runId)).toMatchObject({ state: "failed", errorCode: "validation" });
      expect(topUpRequests()).toHaveLength(0);
    });
  });
});

// Dowód, że fake LLM implementuje nowy port (bez sieci).
describe("FakeLlmProvider.generateLessonPool", () => {
  it.each(["lesson_gap", "lesson_transform"])("generuje %s i zachowuje kształt promptów oraz existingAnswers", async (productiveType) => {
    const llm = new FakeLlmProvider();
    const result = await llm.generateLessonPool({
      subjectId: "english_grammar",
      subjectTitle: "x",
      answerLocale: "en-GB",
      promptLocale: "pl-PL",
      promptProfile: { generationRole: "", gradingRole: "", almostDefinition: "" },
      exerciseTypes: ["lesson_choice", productiveType, "lesson_open_answer"] as ("lesson_choice" | "lesson_gap" | "lesson_transform" | "lesson_open_answer")[],
      transforms: [{ id: "to_negative", instructionPl: "Zamień na przeczenie" }],
      objectives: [
        {
          id: "english_grammar.present_simple.third_person_s",
          descriptionEn: "x",
          exerciseTypes: ["lesson_choice", productiveType, "lesson_open_answer"] as ("lesson_choice" | "lesson_gap" | "lesson_transform" | "lesson_open_answer")[],
          errorCategories: [],
        },
      ],
      material: "He plays football every day she watches tv",
      countPerObjective: 6,
      stageCounts: { guided: 2, productive: 3, independent: 1 },
      graderAvailable: true,
      existingAnswers: ["he"],
    });
    expect(result.exercises.length).toBeGreaterThan(0);
    const answers = result.exercises.map((e) => (e as { answer: string }).answer.toLowerCase());
    expect(answers).not.toContain("he");
    for (const raw of result.exercises) {
      const ex = raw as Record<string, unknown>;
      if (ex.exerciseType === "lesson_choice") expect(ex.stem).toEqual(expect.any(String));
      if (ex.exerciseType === "lesson_transform") expect(ex.statement).toEqual(expect.any(String));
    }
  });

});
