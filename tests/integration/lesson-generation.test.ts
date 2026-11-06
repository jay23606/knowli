import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { messages, type LessonCommand } from "@learning/contracts";
import { countRows, rejectionCodesOf, testDatabase, testDatabaseUrl } from "./helpers";
import { ManualClock } from "./helpers";
import { fakeGeneration, type FakeGeneration } from "./fakes";

import { GenerationProviderError } from "../../packages/server/src/ports/generation-error";
import type { LessonAgentToolOutcome, LessonObjectiveAgentInput } from "../../packages/server/src/ports/ai";
import { lessonExerciseIdentity } from "../../packages/server/src/domain/lessons/exercise-identity";
import { testIssue } from "../../packages/server/src/domain/lessons/testing/test-issue";
import type { LessonExerciseDraft } from "../../packages/server/src/domain/lessons/types";
import { DEFAULT_LESSON_GENERATION_POLICY } from "../../packages/server/src/modules/materials/lessons/lesson-generation-policy";
import type { FakeAgentStep, FakeLessonPoolAgent, FakeLessonPoolAgentOptions } from "../../packages/server/src/providers/fake-lesson-agent";
import { FAKE_EXPLANATION, fakeObjectiveExercises } from "../../packages/server/src/providers/fake-lesson-pool";

const { pool } = testDatabase();

/** Etykiety kodów odrzuceń agenta w `rejectedReasons` szkicu. */
const labels = messages.lessons.agentRejectionReasons;

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

/** Zapis klucza kontekstu lekcji bezpośrednio w bazie (dane sprzed zmiany kodu). */
async function setLessonContextKey(versionId: string, key: string, value: unknown) {
  await pool.query(
    "update learning_app.deck_versions set lesson_context = jsonb_set(lesson_context, $1::text[], $2::jsonb) where id = $3",
    [[key], JSON.stringify(value), versionId],
  );
}

/** „Bez odrzuceń” na ścieżce agenta: żadnego kodu odrzucenia w runie. */
async function expectNoRejections(runId: string): Promise<void> {
  expect(await rejectionCodesOf(runId)).toEqual({});
}

/** Przejściowy błąd dostawcy (ponawialny, kod `provider`). */
const transient = (): FakeAgentStep => ({ throw: new GenerationProviderError("transient") });

interface Gate {
  readonly step: FakeAgentStep;
  readonly reached: Promise<void>;
  open(): void;
}

/** Wywołanie „w locie”: `reached` po dojściu fake'a do kroku, `open()` kończy krok (przerwanie sygnału też). */
function gate(): Gate {
  let open!: () => void;
  let reach!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  return { step: { gate: opened, onReached: reach }, reached, open };
}

/** Wynik narzędzia `submit` z historii wywołań fake'a agenta. */
function outcomeOf(agent: FakeLessonPoolAgent, call: number, step: number): LessonAgentToolOutcome {
  return agent.calls[call]!.outcomes[step] as LessonAgentToolOutcome;
}

describe("generowanie puli lekcji (integracja)", () => {
  const disposers: Array<() => Promise<void>> = [];

  /** Fake'i z agentem puli (pętla generatora; zagadnienia ze scenariuszem wg `agent.objectives`). */
  async function agentFakes(agent?: FakeLessonPoolAgentOptions) {
    const fakes = await fakeGeneration(agent === undefined ? {} : { agent });
    disposers.push(fakes.dispose);
    return fakes;
  }

  async function generatedLessonDraft() {
    const fakes = await agentFakes();
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
    const fakes = await agentFakes();
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
    const fakes = await agentFakes();
    const services = lessonServices(fakes);
    const cmd = command();

    const [a, b] = await Promise.all([createLesson(services, cmd), createLesson(services, cmd)]);
    expect(a).toEqual(b);
    expect(await countRows("decks")).toBe(1);
    expect(await countRows("generation_runs")).toBe(1);
  });

  it("nieznany przedmiot / temat / cel → 400 validation", async () => {
    const fakes = await agentFakes();
    const services = lessonServices(fakes);

    await expect(createLesson(services, command({ subjectId: "nope", clientRequestId: randomUUID() }))).rejects.toMatchObject({ code: "validation" });
    await expect(createLesson(services, command({ topicId: "nope", clientRequestId: randomUUID() }))).rejects.toMatchObject({ code: "validation" });
    await expect(
      createLesson(services, command({ objectiveIds: ["english_grammar.present_simple.nope"], clientRequestId: randomUUID() })),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("wykonanie zapisuje poprawne ćwiczenia z payload_version 2, target_key i umiejętnością objective; wersja w review; examples uzupełnione", async () => {
    const fakes = await agentFakes();
    const services = lessonServices(fakes);

    const { runId, deckId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);

    const run = await readGeneration(services, runId);
    expect(run.state).toBe("succeeded");

    // Profil promptu przedmiotu niesie reguły pól (semantyka hint) do podagenta zagadnienia.
    const agentInput = fakes.agent.calls[0]!.input;
    expect(agentInput.pool.promptProfile.fieldRules).toContain("BASE FORM");
    // Gramatyka nie ma haka zdań kart (#237): pełna generacja nie dostaje zdań do unikania.
    expect(agentInput.pool).not.toHaveProperty("avoidSentences");
    expect(agentInput.cardSentences).toEqual([]);

    const versionId = run.deckVersionId!;
    const [version] = await query<{ state: string; lesson_context: { examples: Record<string, string[]> } }>(
      "select state, lesson_context from learning_app.deck_versions where id = $1",
      [versionId],
    );
    expect(version!.state).toBe("review");
    expect(Object.keys(version!.lesson_context.examples)).toContain("english_grammar.present_simple.third_person_s");
    expect(version!.lesson_context).not.toHaveProperty("review");

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

  it("szkic gramatyki zawiera ćwiczenia wyboru ze słuchu na cel, bez odrzuceń, a podagent dostaje dodatek poza podziałem etapów", async () => {
    const fakes = await agentFakes();
    const services = lessonServices(fakes);

    const { runId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);

    const run = await readGeneration(services, runId);
    expect(run.state).toBe("succeeded");
    expect(fakes.agent.calls[0]!.input.targets.listenAllowance).toBe(2);
    await expectNoRejections(runId);
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
    const fakes = await agentFakes({
      objectives: {
        third_person_s: [{
          submit: {
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
          },
        }],
      },
    });
    const services = lessonServices(fakes);

    const { runId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);

    const run = await readGeneration(services, runId);
    expect(run.state).toBe("succeeded");
    await expectNoRejections(runId);
    const versionId = run.deckVersionId!;
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

  it("wariant acceptedAnswers redundantny wobec odpowiedzi (skrót przeczenia „to be”) jest porzucany, nie zabija ćwiczenia", async () => {
    const objectiveId = "english_grammar.to_be.negative_forms";
    // Incydent prod 2026-10-26: model regularnie podaje wariant skrótowy
    // („They're not…”) przy odpowiedzi kanonicznej „They aren't…” — po
    // normalizacji to ten sam tekst, więc bez sanityzacji walidacja
    // odrzucała CAŁE ćwiczenie i cel tracił ćwiczenia samodzielne.
    const fakes = await agentFakes({
      objectives: {
        negative_forms: [{
          submit: {
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
          },
        }],
      },
    });
    const services = lessonServices(fakes);

    const { runId } = await createLesson(
      services,
      command({
        topicId: "to_be",
        objectiveIds: [objectiveId],
        material: "They aren't in my class. We aren't late.",
        clientRequestId: randomUUID(),
      }),
    );
    await executeLessonGeneration(services, runId);

    const run = await readGeneration(services, runId);
    expect(run.state).toBe("succeeded");
    const revisions = await query<{ payload: { answer: string; acceptedAnswers: string[] } }>(
      "select payload from learning_app.item_revisions where deck_version_id = $1",
      [run.deckVersionId!],
    );
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.payload.answer).toBe("They aren't in my class.");
    expect(revisions[0]!.payload.acceptedAnswers).toEqual([]);
    // Sanityzacja nie jest odrzuceniem: run bez kodów odrzuceń.
    await expectNoRejections(runId);
  });

  it("hak czyszczenia świeżej puli odrzuca przy generowaniu, ale nie działa przy edycji rodzica", async () => {
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
            .map((exercise) => ({ exercise, issues: [testIssue("słowo spoza materiału: banned")] })),
        };
      },
      exposureText: (draft: LessonExerciseDraft) => `Zdanie: ${draft.answer}.`,
    } as typeof englishGrammarSubject;
    const objectiveId = "english_grammar.present_simple.third_person_s";
    const choice = (answer: string, wrong: string, stem: string) => ({
      exerciseType: "lesson_choice", objectiveId, instructionPl: "Wybierz.", stem, answer, acceptedAnswers: [], focus: [],
      options: [{ id: "a", text: answer }, { id: "b", text: wrong }], correctOption: "a",
    });
    const fakes = await agentFakes({
      objectives: {
        third_person_s: [{ submit: { exercises: [
          choice("plays", "play", "She ___ football."),
          choice("banned", "ban", "He ___ it."),
          choice("banned", "ban", "They ___ it?"),
        ] } }],
      },
    });
    const services = createServices({
      db: testDatabase().db,
      clock: new ManualClock(),
      media: fakes.settings,
      generation: fakes.deps,
      subjects: createSubjectRegistry([englishGrammarSubject, refiningSubject, historyLikeSubject].map((subject, index) =>
        index === 1 ? { ...subject, id: "english_grammar_refined" } : subject)),
    });

    const { runId, deckId } = await createLesson(services, command({ subjectId: "english_grammar_refined" }));
    await executeLessonGeneration(services, runId);
    expect((await readGeneration(services, runId)).state).toBe("succeeded");
    // Przy generowaniu hak odrzuca oba ćwiczenia ze słowem spoza materiału (kod `refine`).
    expect(refineCalls.length).toBeGreaterThan(0);
    expect(await rejectionCodesOf(runId)).toEqual({ refine: 2 });
    const first = await readLessonDeck(services, deckId);
    expect(first.draft!.rejectedReasons).toEqual({ [labels.refine!]: 2 });
    expect(first.draft!.exercises.map((exercise) => exercise.answer)).toEqual(["plays"]);
    const [stored] = await query<{ target_key: string }>(
      "select target_key from learning_app.item_revisions where deck_version_id = $1", [first.draft!.id],
    );
    expect(stored!.target_key).toBe(computeTargetKey("Zdanie: plays.", "en-GB"));

    // Edycja rodzica nie przechodzi przez hak: słowo spoza „materiału” zostaje, a klucz ekspozycji liczy exposureText.
    const callsBeforeEdit = refineCalls.length;
    const kept = first.draft!.exercises.map(({ revisionId: _revisionId, ...exercise }) => exercise);
    const edited = await editLessonDraft(services, first.draft!.id, {
      expectedEditNumber: first.draft!.editNumber,
      exercises: [...kept, choice("banned", "ban", "I ___ it.")],
    });
    expect(refineCalls).toHaveLength(callsBeforeEdit);
    expect(edited.exercises.map((exercise) => exercise.answer)).toContain("banned");
    const keys = await query<{ target_key: string }>(
      "select target_key from learning_app.item_revisions where deck_version_id = $1", [edited.id],
    );
    expect(keys.map((row) => row.target_key)).toContain(computeTargetKey("Zdanie: banned.", "en-GB"));
    expect(keys.map((row) => row.target_key)).not.toContain(computeTargetKey("banned", "en-GB"));
    expect(edited.rejectedReasons).toEqual({ [labels.refine!]: 2 });
  });

  it.each(["options", "acceptedAnswers", "focus"])("zły KSZTAŁT %s nie wywraca runu: poprawne zapisane, błędny odrzucony, run terminalny (P2-7)", async (malformedField) => {
    const objectiveId = "english_grammar.present_simple.third_person_s";
    // Jedno poprawne ćwiczenie + jedno o złym kształcie pola tablicowego (null w
    // środku). Strażnik kształtu musi odrzucić błędne, nie rzucać TypeError.
    const fakes = await agentFakes({
      objectives: {
        third_person_s: [{
          submit: {
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
                options: [{ id: "a", text: "watches" }, { id: "b", text: "watch" }],
                correctOption: "b",
                // zły kształt: null w tablicy
                [malformedField]: [null],
              },
            ],
          },
        }],
      },
    });
    const services = lessonServices(fakes);

    const { runId, deckId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);

    const run = await readGeneration(services, runId);
    expect(run.state).toBe("succeeded"); // run terminalny, nie „running”
    const versionId = run.deckVersionId!;
    const [version] = await query<{ state: string }>("select state from learning_app.deck_versions where id = $1", [versionId]);
    expect(version!.state).toBe("review");
    // Błędny kształt policzony jako odrzucenie z kodem i etykietą dla rodzica.
    expect(await rejectionCodesOf(runId)).toEqual({ shape_malformed: 1 });
    expect((await readLessonDeck(services, deckId)).draft!.rejectedReasons).toEqual({ [labels.shape_malformed!]: 1 });
    const rows = await query<{ answer: string }>(
      "select payload->>'answer' as answer from learning_app.item_revisions where deck_version_id = $1",
      [versionId],
    );
    expect(rows.map((r) => r.answer)).toEqual(["plays"]); // tylko poprawne zapisane
  });

  it("nullExerciseDoesNotRetryWholeRun", async () => {
    const objectiveId = "english_grammar.present_simple.third_person_s";
    const fakes = await agentFakes({
      objectives: {
        third_person_s: [{ submit: { exercises: [
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
        ] } }],
      },
    });
    const services = lessonServices(fakes);

    const { runId, deckId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);

    const run = await readGeneration(services, runId);
    expect(run.state).toBe("succeeded");
    expect(run.attempts).toBe(1);
    expect(await rejectionCodesOf(runId)).toEqual({ shape_malformed: 1 });
    expect((await readLessonDeck(services, deckId)).draft!.rejectedReasons).toEqual({ [labels.shape_malformed!]: 1 });
    const rows = await query<{ count: number }>(
      "select count(*)::int as count from learning_app.item_revisions where deck_version_id = $1",
      [run.deckVersionId!],
    );
    expect(rows[0]!.count).toBe(1);
  });

  it("odrzuca wadliwe przykłady, zachowując prawidłowe przykłady i ćwiczenia", async () => {
    const objective = "english_grammar.present_simple.third_person_s";
    const fakes = await agentFakes({
      objectives: {
        third_person_s: [{
          build: (input) => ({
            exercises: fakeObjectiveExercises(input, 0).exercises,
            examples: ["He plays.", null, " ", "x".repeat(121)],
          }),
        }],
      },
    });
    const services = lessonServices(fakes);
    const { runId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);
    const run = await readGeneration(services, runId);
    expect(run.state).toBe("succeeded");
    // Narzędzie przyjmuje jedyny poprawny przykład i odsyła modelowi błąd każdej wadliwej linii.
    expect(outcomeOf(fakes.agent, 0, 0).examples).toMatchObject({ accepted: 1 });
    expect(outcomeOf(fakes.agent, 0, 0).examples!.errors).toHaveLength(3);
    const [row] = await query<{ lesson_context: { examples: Record<string, string[]> } }>("select lesson_context from learning_app.deck_versions where id=$1", [run.deckVersionId]);
    expect(row!.lesson_context.examples).toEqual({ [objective]: ["He plays."] });
    // Wadliwe przykłady nie są odrzuceniami ćwiczeń.
    await expectNoRejections(runId);
  });

  it("wznawia run po przerwaniu workera już po claimie", async () => {
    const fakes = await agentFakes();
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
      expect(fakes.agent.calls.length).toBeGreaterThan(0);
    } finally { await reopened.pool.end(); }
  });

  it("ponowienie żywego runu odcina spóźniony zapis starego workera", async () => {
    const inFlight = gate();
    // Stara próba wisi w „wywołaniu modelu” i zgłasza ćwiczenia dopiero po zapisie nowej (po „Ponów”).
    const fakes = await agentFakes({
      objectives: { third_person_s: { calls: [[inFlight.step, { generate: true }], [{ generate: true }]] } },
    });
    // Długi odstęp sprawdzania bieżącości: starą próbę odcina wyłącznie straż zapisu.
    fakes.deps.lessonExecution = { ...DEFAULT_LESSON_GENERATION_POLICY, cancelPollMs: 60_000 };
    const services = lessonServices(fakes);
    const { runId } = await createLesson(services, command());
    const pending = executeLessonGeneration(services, runId);
    await inFlight.reached;
    let before: unknown[] = [];
    try {
      await retryGeneration(services, runId);
      await executeLessonGeneration(services, runId);
      before = await query("select id, payload from learning_app.item_revisions order by id");
      expect(before.length).toBeGreaterThan(0);
      expect((await readGeneration(services, runId)).state).toBe("succeeded");
    } finally { inFlight.open(); await pending; }
    expect(await query("select id, payload from learning_app.item_revisions order by id")).toEqual(before);
    expect((await readGeneration(services, runId)).state).toBe("succeeded");
  });

  it("stary SELECT przed claimem nie przejmuje nowego wykonania po retry", async () => {
    const fakes = await agentFakes();
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

  it("odpowiedź strict-schema (komplet pól z nullami) przechodzi przez strażnik kształtu do zapisu", async () => {
    // Strict mode zwraca WSZYSTKIE pola schematu; nie dotyczące typu mają null. Adapter AI SDK przekazuje
    // je do `submit` bez zmian — nulle zdejmują `isWellShapedRawExercise` (pola `nullish`) i `toExerciseDraft`.
    const fakes = await agentFakes({
      objectives: {
        third_person_s: [{
          submit: {
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
          },
        }],
      },
    });
    const services = lessonServices(fakes);

    const { runId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);

    const run = await readGeneration(services, runId);
    expect(run.state).toBe("succeeded");
    expect(run.errorCode).toBeNull();
    expect(await rejectionCodesOf(runId)).not.toHaveProperty("shape_malformed");
    const items = await query<{ payload: Record<string, unknown> }>("select payload from learning_app.item_revisions where deck_version_id = $1", [run.deckVersionId!]);
    expect(items).toHaveLength(1);
    expect(items[0]!.payload).toMatchObject({ exerciseType: "lesson_gap", stem: "She ___ tennis.", answer: "plays" });
    for (const field of ["statement", "prompt", "hint", "transformId", "noticeSegments", "options", "correctOption", "items"]) {
      expect(items[0]!.payload).not.toHaveProperty(field);
    }
  });

  it("błąd providera → ponowienie do wyczerpania prób (attempts_exhausted)", async () => {
    const fakes = await agentFakes({ objectives: { third_person_s: { calls: [[transient()], [transient()], [transient()]] } } });
    const clock = new ManualClock();
    const services = lessonServices(fakes, clock);

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
    expect(fakes.agent.calls).toHaveLength(3);
  });

  it("błąd trwały kończy się po jednym żądaniu, a retry ręczny czyści odroczenie", async () => {
    const fakes = await agentFakes({
      objectives: { third_person_s: [{ throw: new GenerationProviderError("configuration", { status: 400 }) }] },
    });
    const clock = new ManualClock();
    const services = lessonServices(fakes, clock);
    const { runId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);
    expect((await readGeneration(services, runId)).errorCode).toBe("provider_configuration");
    expect(fakes.agent.calls).toHaveLength(1);
    await retryGeneration(services, runId);
    expect((await readGeneration(services, runId)).state).toBe("queued");
    expect((await readGeneration(services, runId)).attempts).toBe(0);
  });

  it("odracza transient retry do nextAttemptAt; ręczne retry skraca odroczenie", async () => {
    const fakes = await agentFakes({ objectives: { third_person_s: { calls: [[transient()]] } } });
    const clock = new ManualClock();
    const services = lessonServices(fakes, clock);
    const { runId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);
    const [scheduled] = await query<{ next_attempt_at: Date; attempts: number }>("select next_attempt_at, attempts from learning_app.generation_runs where id=$1", [runId]);
    expect(scheduled!.next_attempt_at.getTime()).toBeGreaterThan(clock.now().getTime());
    expect(scheduled!.attempts).toBe(1);
    // Ponowienie jeszcze niewymagalne: drugie wykonanie nie woła podagenta.
    await executeLessonGeneration(services, runId);
    expect(fakes.agent.calls).toHaveLength(1);
    await retryGeneration(services, runId);
    const [cleared] = await query<{ next_attempt_at: Date | null; attempts: number }>("select next_attempt_at, attempts from learning_app.generation_runs where id=$1", [runId]);
    expect(cleared).toEqual({ next_attempt_at: null, attempts: 0 });
  });

  it("restart procesu workera wykonuje zlecony run lekcji", async () => {
    const fakes = await agentFakes();
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
    expect(fakes.agent.calls.length).toBeGreaterThan(0);
    const [version] = await query<{ state: string }>("select state from learning_app.deck_versions where id = $1", [dto.deckVersionId!]);
    expect(version!.state).toBe("review");
  });

  it("regenerateObjective dopisuje nowe ćwiczenia bez powtórzenia bodźca", async () => {
    const fakes = await agentFakes();
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
    // „+4”: co najmniej cztery nowe ćwiczenia (generator fake'a dopisuje żądaną liczbę).
    expect(after.length).toBeGreaterThanOrEqual(beforeCount + 4);
    const [version] = await query<{ edit_number: number }>("select edit_number from learning_app.deck_versions where id = $1", [versionId]);
    expect(version!.edit_number).toBe(3);
    await expect(editLessonDraft(services, versionId, { expectedEditNumber: 2, title: "stary formularz" })).rejects.toMatchObject({ code: "conflict" });
    // Każde ćwiczenie ma unikalny bodziec w swoim celu; odpowiedź sama w sobie
    // nie jest kluczem deduplikacji dla gramatyki.
    const identities = after.map(({ payload }) => lessonExerciseIdentity(payload));
    expect(new Set(identities).size).toBe(identities.length);
  });

  it("rezerwuje tylko jeden aktywny top-up na szkic i zachowuje idempotencję tego samego żądania", async () => {
    const fakes = await agentFakes();
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
    const fakes = await agentFakes();
    const services = lessonServices(fakes);
    const { runId } = await createLesson(services, command());
    const queued = await readGeneration(services, runId);
    await editLessonDraft(services, queued.deckVersionId!, { expectedEditNumber: 1, title: "Zmiana rodzica" });
    expect((await readGeneration(services, runId)).state).toBe("superseded");
    await executeLessonGeneration(services, runId);
    expect(fakes.agent.calls).toHaveLength(0);
    expect(fakes.agent.planCalls).toHaveLength(0);
    const [version] = await query<{ edit_number: number; title: string }>("select edit_number, title from learning_app.deck_versions where id = $1", [queued.deckVersionId]);
    expect(version).toMatchObject({ edit_number: 2, title: "Zmiana rodzica" });
  });

  it("shutdown oddaje aktualny run do kolejki bez cofania wykorzystanej próby", async () => {
    // Wywołanie „w locie”, które kończy wyłącznie przerwanie sygnału.
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => { reach = resolve; });
    const fakes = await agentFakes({
      objectives: { third_person_s: [{ gate: new Promise<void>(() => undefined), onReached: reach }] },
    });
    const services = lessonServices(fakes);
    const { runId } = await createLesson(services, command());
    const controller = new AbortController();
    const pending = executeLessonGeneration(services, runId, { signal: controller.signal });
    await reached;
    controller.abort();
    await pending;
    const result = await readGeneration(services, runId);
    expect(result.state).toBe("queued");
    expect(result.attempts).toBe(1);
    expect(await query("select id from learning_app.item_revisions where deck_version_id=$1", [result.deckVersionId])).toHaveLength(0);
  });

  it("przedmiot fixture historii (ttsForAnswers=false) przechodzi cały przepływ bez audio", async () => {
    const fakes = await agentFakes();
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
    expect(fakes.agent.calls.map((call) => call.objectiveId)).toEqual(["test_history.piast_origins.chrzest_966"]);
    const [version] = await query<{ state: string }>("select state from learning_app.deck_versions where id = $1", [run.deckVersionId!]);
    expect(version!.state).toBe("review");
    const items = await query<{ count: number }>("select count(*)::int as count from learning_app.item_revisions where deck_version_id = $1", [run.deckVersionId!]);
    expect(items[0]!.count).toBeGreaterThan(0);
    // ttsForAnswers=false → brak zasobów audio
    expect(await countRows("media_assets")).toBe(0);
    expect(await countRows("revision_assets")).toBe(0);
  });

  it("TTS przypadkowo podpięte do lekcji z wyłączonym audio nadal kończy jako superseded", async () => {
    const fakes = await agentFakes();
    const services = lessonServices(fakes);
    const { runId } = await createLesson(services, command({
      subjectId: "test_history",
      topicId: "piast_origins",
      objectiveIds: ["test_history.piast_origins.chrzest_966"],
      material: "Mieszko I przyjął chrzest w 966 roku. Chrzest Polski.",
      clientRequestId: randomUUID(),
    }));
    await executeLessonGeneration(services, runId);
    expect((await readGeneration(services, runId)).state).toBe("succeeded");
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
    const fakes = await agentFakes();
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
  it("gramatyka: fake agenta generuje wyjaśnienia, a rewizje i DTO szkicu je niosą", async () => {
    const fakes = await agentFakes();
    const services = lessonServices(fakes);
    const { runId, deckId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);
    const run = await readGeneration(services, runId);
    expect(run.state).toBe("succeeded");
    expect(fakes.agent.calls[0]!.input.pool.exerciseExplanations).toBe(true);

    const rows = await query<{ payload: { explanationPl?: string } }>(
      "select payload from learning_app.item_revisions where deck_version_id = $1 and payload->>'exerciseType' is not null",
      [run.deckVersionId!],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.payload.explanationPl).toBe(FAKE_EXPLANATION);

    const draft = (await readLessonDeck(services, deckId)).draft!;
    expect(draft.exercises.length).toBe(rows.length);
    for (const exercise of draft.exercises) expect(exercise.explanationPl).toBe(FAKE_EXPLANATION);
  });

  it("gramatyka: wyjaśnienie łamiące reguły jest po cichu usuwane, ćwiczenie zostaje", async () => {
    // Złe wyjaśnienie dostaje ćwiczenie ze środka zgłoszenia; test szuka go potem po treści,
    // nie po pozycji, więc kolejność rewizji szkicu nie ma znaczenia.
    const identity = (exercise: { exerciseType: string; answer: string; stem?: string; prompt?: string }) =>
      JSON.stringify([exercise.exerciseType, exercise.stem ?? null, exercise.prompt ?? null, exercise.answer]);
    let broken: string | undefined;
    const fakes = await agentFakes({
      objectives: {
        third_person_s: [{
          build: (input) => {
            const generated = fakeObjectiveExercises(input, 0);
            const target = Math.floor(generated.exercises.length / 2);
            const exercises = generated.exercises.map((exercise, index) => {
              if (index !== target) return exercise;
              broken = identity(exercise as Parameters<typeof identity>[0]);
              return { ...exercise as Record<string, unknown>, explanationPl: "Pierwsze zdanie. Drugie zdanie." };
            });
            return { exercises, examples: generated.examples };
          },
        }],
      },
    });
    const services = lessonServices(fakes);
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
    for (const exercise of others) expect(exercise.explanationPl).toBe(FAKE_EXPLANATION);
    // Po cichu: wyjaśnienie znika bez odrzucenia ćwiczenia.
    await expectNoRejections(runId);
  });

  it("szkoła: wyjaśnienie z modelu jest odrzucane po cichu (przedmiot bez flagi)", async () => {
    // Zgłoszenie każdego zagadnienia szkoły niesie wyjaśnienia, mimo że przedmiot ich nie zamawia.
    const withExplanation = (): FakeAgentStep => ({
      build: (input) => {
        const generated = fakeObjectiveExercises(input, 0);
        return {
          exercises: generated.exercises.map((exercise) => ({
            ...exercise as Record<string, unknown>, explanationPl: "Roślina robi cukry ze światła.",
          })),
          examples: generated.examples,
        };
      },
    });
    const fakes = await agentFakes({ objectives: { fotosynteza: [withExplanation()] } });
    const { db } = testDatabase();
    const services = createServices({
      db, clock: new ManualClock(), media: fakes.settings, generation: fakes.deps,
      subjects: createSubjectRegistry([schoolSubject]),
    });
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
    expect(fakes.agent.calls.map((call) => call.objectiveId)).toEqual([`school.d${deckId}.fotosynteza`]);
    expect(fakes.agent.calls[0]!.input.pool.exerciseExplanations).toBe(false);
    const exercises = (await readLessonDeck(services, deckId)).draft!.exercises;
    expect(exercises.length).toBeGreaterThan(0);
    for (const exercise of exercises) expect(exercise.explanationPl).toBeUndefined();
  });

  it("zestaw szkolny: generacja wyprowadza zagadnienia z materiału i zapisuje ćwiczenia v3 z cytatami", async () => {
    const fakes = await agentFakes();
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
    // Etap zagadnień szkoły zostaje na LLM; ćwiczenia generuje podagent każdego zagadnienia.
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
    expect(fakes.agent.calls.map((call) => call.objectiveId).sort()).toEqual([...version!.lesson_context.objectiveIds].sort());

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
    const fakes = await agentFakes();
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
    expect((await readGeneration(services, runId)).state).toBe("succeeded");
    expect(fakes.agent.calls.every((call) => call.input.pool.voiceTones === true)).toBe(true);

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
    const material = "Skala mapy pozwala przeliczyć odległość na mapie na odległość w terenie.";
    // Rachunek z modelu niesie same parametry; adapter AI SDK materializuje go przed `submit` — tu robi to scenariusz.
    const rawCalculation = (input: LessonObjectiveAgentInput, overrides: Record<string, unknown> = {}) => ({
      exerciseType: "lesson_calculation", objectiveId: input.objective.id,
      calculation: { kind: "scale_distance", params: { scaleDenominator: 25000, mapDistanceCm: 3 }, unit: "m", templateFamilyId: "map-scale" },
      sourceRefs: [{ quote: material, parentAdded: true }],
      ...overrides,
    });
    const calculation = { kind: "scale_distance", params: { scaleDenominator: 25000, mapDistanceCm: 3 }, unit: "m", templateFamilyId: "map-scale" };
    const fakes = await agentFakes({
      objectives: {
        skala_mapy: {
          calls: [
            // Pula: poprawne ćwiczenia generatora + jeden poprawny rachunek, nieznana metoda i cytat spoza materiału.
            [{
              build: (input) => {
                const generated = fakeObjectiveExercises(input, 0);
                return {
                  exercises: [
                    ...generated.exercises,
                    rawCalculation(input),
                    rawCalculation(input, { calculation: { ...calculation, kind: "unknown" } }),
                    rawCalculation(input, {
                      calculation: { ...calculation, params: { scaleDenominator: 25000, mapDistanceCm: 5 } },
                      sourceRefs: [{ quote: "Ten cytat nie występuje w materiale rodzica.", parentAdded: true }],
                    }),
                  ],
                  examples: generated.examples,
                };
              },
            }],
            // „+2”: ta sama metoda i parametry z inną rodziną nadal są duplikatem istniejącej puli.
            [{
              build: (input) => ({
                exercises: [
                  rawCalculation(input, { calculation: { ...calculation, templateFamilyId: "renamed-family" } }),
                  rawCalculation(input, { calculation: { ...calculation, params: { scaleDenominator: 25000, mapDistanceCm: 4 } } }),
                ],
              }),
            }],
          ],
        },
      },
    });
    const services = createServices({
      db: testDatabase().db, clock: new ManualClock(), media: fakes.settings,
      generation: fakes.deps, subjects: createSubjectRegistry([schoolSubject]),
    });
    const { runId, deckId } = await createSchoolLesson(services, {
      subjectTitlePl: "Geografia", topicTitlePl: "Skala mapy", material,
      poolSize: 40, clientRequestId: randomUUID(),
    });
    const objectiveId = `school.d${deckId}.skala_mapy`;
    await executeLessonGeneration(services, runId);
    expect((await readGeneration(services, runId)).state).toBe("succeeded");
    expect(fakes.agent.calls[0]!.objectiveId).toBe(objectiveId);
    const deck = await readLessonDeck(services, deckId);
    const calculations = deck.draft!.exercises.filter((exercise) => exercise.exerciseType === "lesson_calculation");
    expect(calculations).toHaveLength(1);
    const { templateFamilyId, ...spec } = calculation;
    expect(calculations[0]).toMatchObject({ answer: "750 m", calculation: spec, sourceRefs: [{ quote: material }] });
    // Rodzina szablonu dostaje zakres próby runu (jak `familyId` pytań otwartych).
    expect(calculations[0]!.calculation!.templateFamilyId?.startsWith(`${templateFamilyId}-`)).toBe(true);
    expect(calculations[0]!.sourceRefs![0]).not.toHaveProperty("parentAdded");
    // Dwa wadliwe rekordy odrzucone pojedynczo: nieznana metoda (zły kształt) i cytat spoza materiału (reguła puli szkoły).
    expect(await rejectionCodesOf(runId)).toEqual({ shape_malformed: 1, lesson_extra: 1 });
    expect(deck.draft!.rejectedReasons).toEqual({ [labels.shape_malformed!]: 1, [labels.lesson_extra!]: 1 });
    expect(deck.draft!.coverage).toEqual([]);

    const topUp = await regenerateObjective(services, {
      deckId, objectiveId, count: 2, expectedEditNumber: deck.draft!.editNumber, clientRequestId: randomUUID(),
    });
    await executeLessonGeneration(services, topUp.runId);
    expect((await readGeneration(services, topUp.runId)).state).toBe("succeeded");
    const after = await readLessonDeck(services, deckId);
    const afterCalculations = after.draft!.exercises.filter((exercise) => exercise.exerciseType === "lesson_calculation");
    expect(afterCalculations.map((exercise) => exercise.answer).sort()).toEqual(["1000 m", "750 m"]);
    expect(after.draft!.exercises.length).toBe(deck.draft!.exercises.length + 1);
    // Rachunek z przemianowaną rodziną to duplikat istniejącej puli — jedno odrzucenie z dokładnym kodem.
    expect(await rejectionCodesOf(topUp.runId)).toEqual({ lesson_pool: 1 });
  });

  it("zestaw szkolny: publikacja i sesja dziecka na typach zamkniętych", async () => {
    const fakes = await agentFakes();
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
    expect((await readGeneration(services, runId)).state).toBe("succeeded");

    const deck = await readLessonDeck(services, deckId);
    expect(deck.draft?.dynamicTopic?.objectives).toHaveLength(2);
    expect(deck.draft!.exercises.some((exercise) => exercise.exerciseType === "lesson_choice")).toBe(true);
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
    const fakes = await agentFakes();
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
    expect((await readGeneration(services, runId)).state).toBe("succeeded");
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
    expect(edited.exercises.length).toBeGreaterThan(0);
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
    const SCHOOL_MATERIAL = [
      "Zagadnienie 1: Fotosynteza",
      "Wyjaśnienie: Fotosynteza to proces, w którym roślina z wody i dwutlenku węgla, przy udziale światła, wytwarza cukry. Cukry są pokarmem rośliny.",
      "Zagadnienie 2: Chrzest Polski",
      "Wyjaśnienie: Mieszko I przyjął chrzest w 966 roku. Chrzest włączył państwo do chrześcijańskiej Europy i wzmocnił władzę księcia.",
    ].join("\n");
    /** Kody ujawnień rozwiązań (ofiara i źródło) w kodach odrzuceń runu. */
    const leakCodes = (codes: Record<string, number>) => Object.keys(codes).filter((code) => code.startsWith("leak_"));
    const isOpen = (exercise: unknown) => (exercise as { exerciseType?: string }).exerciseType === "lesson_open_answer";

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
      return { runId, draft: (await readLessonDeck(services, deckId)).draft! };
    }

    it("gramatyka: tłumaczenie równe przykładowi karty nie trafia do szkicu; przykład zostaje, powód w szkicu", async () => {
      const objectiveId = "english_grammar.present_simple.third_person_s";
      const translation = (prompt: string, answer: string, focus: string) => ({
        exerciseType: "lesson_open_answer", objectiveId, instructionPl: "Przetłumacz zdanie na angielski.", prompt,
        answer, acceptedAnswers: [], focus: [focus],
      });
      const fakes = await agentFakes({
        objectives: {
          third_person_s: [{
            submit: {
              exercises: [
                {
                  exerciseType: "lesson_choice", objectiveId, instructionPl: "Wybierz.", stem: "She ___ football.", answer: "plays",
                  acceptedAnswers: [], focus: [], options: [{ id: "a", text: "plays" }, { id: "b", text: "play" }], correctOption: "a",
                },
                translation("On gra w piłkę.", "He plays football.", "plays"),
                translation("Ona ogląda telewizję.", "She watches TV.", "watches"),
              ],
              examples: ["He plays football."],
            },
          }],
        },
      });
      const services = lessonServices(fakes);

      const { runId, deckId } = await createLesson(services, command());
      await executeLessonGeneration(services, runId);
      expect((await readGeneration(services, runId)).state).toBe("succeeded");

      const draft = (await readLessonDeck(services, deckId)).draft!;
      expect(draft.exercises.map((exercise) => exercise.answer).sort()).toEqual(["She watches TV.", "plays"]);
      expect(draft.examples[objectiveId]).toEqual(["He plays football."]);
      expect(await rejectionCodesOf(runId)).toEqual({ leak_victim: 1 });
      expect(draft.rejectedReasons).toEqual({ [labels.leak_victim!]: 1 });
    });

    // Rodzina pytań (ta sama odpowiedź wzorcowa) nie ujawnia rozwiązania samej sobie: przyjęcie agenta
    // stosuje tę samą regułę co ostrzeżenia szkicu (`familyRepeatsAllowed`), a pokrycie liczy rodzinę raz.
    it("szkoła: rodzina trzech pytań otwartych z jedną odpowiedzią zostaje w szkicu, a pokrycie liczy jedno", async () => {
      let independentTarget: number | undefined;
      const fakes = await agentFakes({
        objectives: {
          fotosynteza: [{
            build: (input) => {
              independentTarget = input.pool.stageCounts.independent;
              const generated = fakeObjectiveExercises(input, 0);
              const base = generated.exercises.find(isOpen) as Record<string, unknown>;
              const family = [1, 2, 3].map((n) => ({ ...base, familyId: "fotosynteza-definicja", prompt: `Pytanie rodziny numer ${n}: czym jest fotosynteza?` }));
              return { exercises: [...generated.exercises.filter((exercise) => !isOpen(exercise)), ...family], examples: generated.examples };
            },
          }],
        },
      });
      const services = schoolServices(fakes);

      const { runId, draft } = await generateSchool(services);
      const familyObjectiveId = draft.objectiveIds[0]!;
      expect(familyObjectiveId.endsWith(".fotosynteza")).toBe(true);
      // Rodzina mieści się w etapie samodzielnym zagadnienia.
      expect(independentTarget).toBeGreaterThanOrEqual(3);
      const family = draft.exercises.filter((exercise) => exercise.objectiveId === familyObjectiveId && exercise.exerciseType === "lesson_open_answer");
      expect(family).toHaveLength(3);
      expect(new Set(family.map((exercise) => exercise.answer)).size).toBe(1);
      expect(leakCodes(await rejectionCodesOf(runId))).toEqual([]);
      expect(draft.coverage).toContainEqual(expect.objectContaining({ objectiveId: familyObjectiveId, stage: "independent", actual: 1, required: 2 }));
      // Miękkie powtórzenia wewnątrz rodziny są zamierzone: bez ostrzeżeń, choć pokrycie liczy rodzinę raz.
      expect(draft.exposureLeaks).toBeUndefined();
    });

    it("szkoła: reguła twarda usuwa całą rodzinę pytań otwartych → jej słowa kluczowe poza szkicem, publikacja bez błędu rodziny", async () => {
      const FAMILY = "fotosynteza-rodzina";
      const fakes = await agentFakes({
        objectives: {
          fotosynteza: [
            {
              build: (input) => {
                const generated = fakeObjectiveExercises(input, 0).exercises;
                const base = generated.find(isOpen) as Record<string, unknown>;
                const family = [1, 2].map((n) => ({ ...base, familyId: FAMILY, prompt: `Pytanie rodziny numer ${n}: czym jest fotosynteza?` }));
                const keywords = {
                  exerciseType: "lesson_keywords", objectiveId: input.objective.id, familyId: FAMILY,
                  instructionPl: "Wybierz słowa kluczowe.",
                  keywordOptions: [{ id: "k1", text: "światła" }, { id: "k2", text: "cukry" }, { id: "k3", text: "tlen" }, { id: "k4", text: "korzenie" }],
                  keyOptionIds: ["k1", "k2"], answer: "światła, cukry", acceptedAnswers: [], focus: [], sourceRefs: [{ quote: "wytwarza cukry" }],
                };
                // Przykład karty równy odpowiedzi rodziny: reguła twarda usuwa oba pytania rodziny.
                return {
                  exercises: [...generated.filter((exercise) => exercise !== base), ...family, keywords],
                  examples: [base.answer as string],
                };
              },
            },
            // Kolejny krok domyka etap samodzielny innymi pytaniami (dawna runda pod brakujący etap).
            { build: (input) => ({ exercises: fakeObjectiveExercises(input, 100, { independent: input.pool.stageCounts.independent }).exercises }) },
          ],
        },
      });
      const services = schoolServices(fakes);

      const { runId, draft } = await generateSchool(services);
      expect(draft.exercises.some((exercise) => exercise.exerciseType === "lesson_keywords")).toBe(false);
      expect(draft.exercises.some((exercise) => exercise.familyId?.endsWith(FAMILY))).toBe(false);
      const codes = await rejectionCodesOf(runId);
      // Oba pytania rodziny: ofiary przykładu karty; słowa kluczowe bez rodziny: reguła puli szkoły.
      expect(codes.leak_victim).toBe(2);
      expect(codes.lesson_extra).toBe(1);
      expect(draft.rejectedReasons?.[labels.leak_victim!]).toBe(2);
      expect(draft.rejectedReasons?.[labels.lesson_extra!]).toBe(1);
      expect(draft.coverage).toEqual([]);
      await expect(publishLessonDraft(services, draft.id, draft.editNumber)).resolves.toBeDefined();
    });

    it("domyślna pula fake'a gramatyki i szkoły nie ma ujawnionych rozwiązań", async () => {
      const fakes = await agentFakes();
      const grammar = lessonServices(fakes);
      const { runId, deckId } = await createLesson(grammar, command({ poolSize: 20 }));
      await executeLessonGeneration(grammar, runId);
      expect((await readGeneration(grammar, runId)).state).toBe("succeeded");
      await expectNoRejections(runId);
      const grammarDraft = (await readLessonDeck(grammar, deckId)).draft!;
      expect(grammarDraft.rejectedCount).toBe(0);
      expect(grammarDraft.exposureLeaks).toBeUndefined();
      expect(grammarDraft.coverage).toEqual([]);

      const school = await generateSchool(schoolServices(fakes));
      await expectNoRejections(school.runId);
      expect(school.draft.exposureLeaks).toBeUndefined();
      expect(school.draft.coverage).toEqual([]);
      const gaps = await query<{ gaps: unknown }>(
        "select lesson_context->'generationGaps' as gaps from learning_app.deck_versions where id = any($1::uuid[])",
        [[grammarDraft.id, school.draft.id]],
      );
      expect(gaps).toEqual([{ gaps: null }, { gaps: null }]);
    });
  });
});
