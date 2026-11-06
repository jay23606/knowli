import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createChild,
  createLesson,
  createServices,
  executeLessonGeneration,
  nextTask,
  publishLessonDraft,
  readLessonDeck,
  startSession,
  type Services,
} from "@learning/server";
import type { TaskDto } from "@learning/contracts";
import { finishLessonTask, ManualClock, testDatabase, truncateCoreTables } from "./helpers";
import { fakeGeneration } from "./fakes";
import {
  FakeLessonPoolAgent,
  type FakeLessonPoolAgentOptions,
} from "../../packages/server/src/providers/fake-lesson-agent";
import { DEFAULT_LESSON_GENERATION_POLICY } from "../../packages/server/src/modules/materials/lessons/lesson-generation-policy";
import type { LessonAgentToolOutcome } from "../../packages/server/src/ports/ai";
import type { LessonExerciseDraft } from "../../packages/server/src/domain/lessons/types";
import { presentContinuousV1 } from "../../packages/server/src/domain/lessons/subjects/english-grammar/topics/present-continuous";

/**
 * Temat Present Continuous od generowania do sesji dziecka (design „Present Continuous” §11.2) na
 * ścieżce agenta puli (jedyny generator lekcji, #281): fake agenta zgłasza
 * ręcznie napisane ćwiczenia celów 1 i 2 (uniwersalny generator fake tworzy ćwiczenia, które
 * walidator tematu odrzuca), checker niedostępny. Dane fikcyjne.
 */

const { db, pool } = testDatabase();
const cleanup: Array<() => Promise<void>> = [];

const PC = "english_grammar.present_continuous";
const AFFIRMATIVE = `${PC}.affirmative`;
const NOW_OR_USUALLY = `${PC}.now_or_usually`;
/** Luka z czasownikiem w nawiasie (§6.7): zdanie po odpowiedzi czyta lektor. */
const BRACKET_GAP = "Tom ___ (play) football in the garden now.";

const choice = (objectiveId: string, instructionPl: string, stem: string, correct: string, wrong: string): LessonExerciseDraft => ({
  exerciseType: "lesson_choice",
  objectiveId,
  instructionPl,
  stem,
  options: [{ id: "a", text: correct }, { id: "b", text: wrong }],
  correctOption: "a",
  answer: correct,
  acceptedAnswers: [],
  focus: correct.split(" "),
});

const gap = (objectiveId: string, stem: string, answer: string): LessonExerciseDraft => ({
  exerciseType: "lesson_gap",
  objectiveId,
  instructionPl: "Uzupełnij zdanie.",
  stem,
  answer,
  acceptedAnswers: [],
  focus: answer.split(" "),
});

const errorFix = (objectiveId: string, statement: string, answer: string, focus: string[]): LessonExerciseDraft => ({
  exerciseType: "lesson_error_fix",
  objectiveId,
  instructionPl: "Popraw błąd w zdaniu.",
  statement,
  answer,
  acceptedAnswers: [],
  focus,
});

/** Tłumaczenie; klucz z „now” dostaje warianty z „right now” i „at the moment” (`grammar.pc_translation_now_variants`). */
const translation = (objectiveId: string, prompt: string, answer: string, focus: string[]): LessonExerciseDraft => ({
  exerciseType: "lesson_open_answer",
  objectiveId,
  instructionPl: "Przetłumacz na angielski.",
  prompt,
  answer,
  acceptedAnswers: / now\.$/.test(answer) ? ["right now", "at the moment"].map((marker) => answer.replace(/ now\.$/, ` ${marker}.`)) : [],
  focus,
});

/**
 * Cel 1: 3 prowadzone, 4 produktywne, 3 samodzielne — minimum etapów (`lessonPoolMinimums`) z rezerwą
 * samodzielnych agenta i `targetCount` celu przy puli 20 (10 na cel).
 */
const AFFIRMATIVE_EXERCISES: LessonExerciseDraft[] = [
  choice(AFFIRMATIVE, "Wybierz dobrą formę.", "The dogs ___ in the park now.", "are walking", "is walking"),
  choice(AFFIRMATIVE, "Wybierz dobrą formę.", "Look! Mum ___ dinner.", "is cooking", "are cooking"),
  {
    exerciseType: "lesson_order",
    objectiveId: AFFIRMATIVE,
    instructionPl: "Ułóż zdanie.",
    items: [
      { id: "i1", text: "Kasia" },
      { id: "i2", text: "is" },
      { id: "i3", text: "reading" },
      { id: "i4", text: "a book" },
    ],
    answer: "Kasia is reading a book",
    acceptedAnswers: [],
    focus: ["is", "reading"],
  },
  gap(AFFIRMATIVE, BRACKET_GAP, "is playing"),
  gap(AFFIRMATIVE, "The children ___ (paint) in the classroom now.", "are painting"),
  errorFix(AFFIRMATIVE, "Grandma sleeping on the sofa now.", "Grandma is sleeping on the sofa now.", ["is"]),
  errorFix(AFFIRMATIVE, "Look! The cats is jumping.", "Look! The cats are jumping.", ["are"]),
  translation(AFFIRMATIVE, "Tata teraz myje samochód.", "Dad is washing the car now.", ["is", "washing"]),
  translation(AFFIRMATIVE, "Dzieci teraz rysują w ogrodzie.", "The children are drawing in the garden now.", ["are", "drawing"]),
  translation(AFFIRMATIVE, "Ola teraz pije mleko.", "Ola is drinking milk now.", ["is", "drinking"]),
];

/** Cel 2: ten sam podział etapów; połowa kontekstów to wskaźnik „teraz”, połowa „zwykle”, plus wybór „now / usually”. */
const NOW_OR_USUALLY_EXERCISES: LessonExerciseDraft[] = [
  choice(NOW_OR_USUALLY, "Wybierz dobrą formę.", "Ola ___ comics every day.", "reads", "is reading"),
  choice(NOW_OR_USUALLY, "Cicho! Dziadek śpi. Wybierz dobrą formę.", "Grandpa ___ on the sofa.", "is sleeping", "sleeps"),
  choice(NOW_OR_USUALLY, "Kiedy to się dzieje?", "Ola is reading a comic.", "now", "usually"),
  gap(NOW_OR_USUALLY, "Dad ___ (cook) dinner every day.", "cooks"),
  gap(NOW_OR_USUALLY, "Listen! The birds ___ (sing).", "are singing"),
  errorFix(NOW_OR_USUALLY, "Look! Ola reads.", "Look! Ola is reading.", ["is", "reading"]),
  errorFix(NOW_OR_USUALLY, "Tom is walking to school every day.", "Tom walks to school every day.", ["walks"]),
  translation(NOW_OR_USUALLY, "Mama codziennie gotuje obiad.", "Mum cooks dinner every day.", ["cooks"]),
  translation(NOW_OR_USUALLY, "Ola w tej chwili gra w tenisa.", "Ola is playing tennis now.", ["is", "playing"]),
  translation(NOW_OR_USUALLY, "Tom zwykle pije sok.", "Tom usually drinks juice.", ["drinks"]),
];

/** Scenariusz fake'a agenta: jedno zgłoszenie na cel (klucz = slug celu) z przykładami kart. */
const SCRIPT: FakeLessonPoolAgentOptions = {
  objectives: {
    affirmative: [{ submit: { exercises: AFFIRMATIVE_EXERCISES, examples: ["Tom is jumping now.", "The dogs are playing now."] } }],
    now_or_usually: [{ submit: { exercises: NOW_OR_USUALLY_EXERCISES, examples: ["Mum is singing now.", "Mum sings every day."] } }],
  },
};

beforeEach(async () => {
  await truncateCoreTables();
  await pool.query(`truncate learning_app.child_objective_progress, learning_app.lesson_verdicts,
    learning_app.generation_runs, learning_app.revision_assets, learning_app.media_assets,
    learning_app.item_revision_skills, learning_app.item_revisions, learning_app.skill_versions,
    learning_app.learning_items, learning_app.deck_versions, learning_app.decks cascade`);
});
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});
afterAll(() => pool.end());

interface AgentWorld {
  services: Services;
  agent: FakeLessonPoolAgent;
}

/** Jak `agentWorld` w `lesson-agent-generation.test.ts`: fake agenta ze scenariuszem, checker niedostępny. */
async function agentWorld(agentOptions: FakeLessonPoolAgentOptions): Promise<AgentWorld> {
  const fakes = await fakeGeneration({ agent: agentOptions });
  cleanup.push(fakes.dispose);
  fakes.deps.lessonExecution = { ...DEFAULT_LESSON_GENERATION_POLICY, cancelPollMs: 20 };
  return { services: createServices({ db, clock: new ManualClock(), media: fakes.settings, generation: fakes.deps }), agent: fakes.agent };
}

interface IssuedTask {
  readonly type: string;
  readonly objectiveId: string;
}

async function objectiveOfTask(task: TaskDto): Promise<string> {
  return (await pool.query<{ objectiveId: string }>(
    `select context->>'objectiveId' as "objectiveId" from learning_app.session_tasks where id = $1`, [task.taskId],
  )).rows[0]!.objectiveId;
}

describe("lekcja Present Continuous — generowanie, szkic, publikacja, sesja dziecka", () => {
  it("agent przyjmuje wszystkie ćwiczenia, publikacja przechodzi, sesja wydaje karty celu 1, ćwiczenie celu 2 i zdanie luki bez nawiasu", async () => {
    const { services, agent } = await agentWorld(SCRIPT);
    const { runId, deckId } = await createLesson(services, {
      subjectId: "english_grammar",
      topicId: "present_continuous",
      objectiveIds: [AFFIRMATIVE, NOW_OR_USUALLY],
      material: "Tom is playing football in the garden now. Ola reads comics every day. Look! Mum is cooking dinner.",
      poolSize: 20,
      clientRequestId: randomUUID(),
    });

    await executeLessonGeneration(services, runId);

    // Generowanie: ścieżka agenta, oba cele kompletne, zero odrzuceń.
    const run = (await pool.query<{ state: string; agent_checkpoint: { rejectionCodes: Record<string, number>; objectives: Record<string, { status: string; accepted: number }> } }>(
      "select state, agent_checkpoint from learning_app.generation_runs where id = $1", [runId],
    )).rows[0]!;
    expect(run.state).toBe("succeeded");
    expect(agent.calls.map((call) => call.objectiveId)).toEqual([AFFIRMATIVE, NOW_OR_USUALLY]);
    const outcomes = agent.calls.flatMap((call) => call.outcomes as LessonAgentToolOutcome[]);
    expect(outcomes).toHaveLength(2);
    const errors = outcomes.flatMap((outcome) => [
      ...outcome.results.flatMap((result) => ("errors" in result ? [`#${result.index}: ${result.errors.join("; ")}`] : [])),
      ...(outcome.examples?.errors ?? []),
    ]);
    expect(errors).toEqual([]);
    expect(outcomes.map((outcome) => outcome.results.length)).toEqual([10, 10]);
    expect(outcomes.map((outcome) => ({ complete: outcome.complete, missing: outcome.missing }))).toEqual([
      { complete: true, missing: [] },
      { complete: true, missing: [] },
    ]);
    expect(run.agent_checkpoint.rejectionCodes).toEqual({});
    expect(run.agent_checkpoint.objectives).toEqual({
      [AFFIRMATIVE]: { status: "complete", accepted: 10 },
      [NOW_OR_USUALLY]: { status: "complete", accepted: 10 },
    });

    // Szkic: wszystkie ćwiczenia zapisane, bez usunięć i luk generowania.
    const draft = (await readLessonDeck(services, deckId)).draft!;
    expect(draft.exercises).toHaveLength(20);
    expect(draft.coverage).toEqual([]);
    const context = (await pool.query<{ lesson_context: { rejectedCount?: number; generationGaps?: unknown } }>(
      "select lesson_context from learning_app.deck_versions where id = $1", [draft.id],
    )).rows[0]!.lesson_context;
    expect(context.rejectedCount ?? 0).toBe(0);
    expect(context).not.toHaveProperty("generationGaps");

    await expect(publishLessonDraft(services, draft.id, draft.editNumber)).resolves.toEqual({ deckVersionId: draft.id });

    // Nagranie zdania po odpowiedzi luki (§6.7): odpowiedź wstawiona w lukę, bez czasownika w nawiasie.
    const feedback = (await pool.query<{ stem: string; text: string }>(
      `select ir.payload->>'stem' as stem, ma.metadata->>'text' as text
         from learning_app.revision_assets ra
         join learning_app.item_revisions ir on ir.id = ra.item_revision_id
         join learning_app.media_assets ma on ma.id = ra.asset_id
        where ir.deck_version_id = $1 and ra.role = 'feedback_audio'`,
      [draft.id],
    )).rows;
    expect(feedback.find((row) => row.stem === BRACKET_GAP)?.text).toBe("Tom is playing football in the garden now.");
    expect(feedback.find((row) => row.stem === "Dad ___ (cook) dinner every day.")?.text).toBe("Dad cooks dinner every day.");
    expect(feedback.filter((row) => /\(|\)|___/.test(row.text))).toEqual([]);

    // Sesja dziecka: poprawne odpowiedzi do pierwszego ćwiczenia celu 2.
    const child = await createChild(services, { displayName: "Fikcyjna Ola", avatarKey: "owl" });
    await pool.query(
      "insert into learning_app.assignments (id, child_id, deck_id, test_date, test_goals) values ($1, $2, $3, null, null)",
      [randomUUID(), child.id, deckId],
    );
    const session = await startSession(services, { childId: child.id, deckId, microphoneEnabled: false });
    const issued: IssuedTask[] = [];
    for (let step = 0; step < 40; step += 1) {
      const task = await nextTask(services, session.sessionId);
      if (task === null) break;
      const objectiveId = await objectiveOfTask(task);
      issued.push({ type: task.exerciseType, objectiveId });
      await finishLessonTask(services, task);
      if (objectiveId === NOW_OR_USUALLY && task.exerciseType !== "lesson_card") break;
    }

    const affirmative = issued.filter((task) => task.objectiveId === AFFIRMATIVE);
    const firstAffirmativeExercise = affirmative.findIndex((task) => task.type !== "lesson_card");
    expect(firstAffirmativeExercise).toBeGreaterThan(0);
    // Wszystkie karty celu 1 (z katalogu) przed jego pierwszym ćwiczeniem.
    const affirmativeCards = presentContinuousV1.objectives.find((objective) => objective.id === AFFIRMATIVE)!.cards.length;
    expect(affirmative.slice(0, firstAffirmativeExercise).map((task) => task.type)).toEqual(Array(affirmativeCards).fill("lesson_card"));
    const goal2Exercise = issued.find((task) => task.objectiveId === NOW_OR_USUALLY && task.type !== "lesson_card");
    expect(goal2Exercise, JSON.stringify(issued)).toBeDefined();
    expect(NOW_OR_USUALLY_EXERCISES.map((exercise) => exercise.exerciseType)).toContain(goal2Exercise!.type);
  });
});
