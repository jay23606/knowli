import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { TaskDto } from "@learning/contracts";
import {
  authorizeDisclosure,
  completePresentation,
  createChild,
  createServices,
  createSubjectRegistry,
  deleteChild,
  endSession,
  englishGrammarSubject,
  FakeAnswerGrader,
  listLessonVerdicts,
  nextTask,
  readAttempt,
  rebuildProgress,
  schoolSubject,
  startSession,
  submitAttempt,
  type Services,
} from "@learning/server";
import { lessonWorld, RICH_KEYS, STORY_FIXTURE, type LessonStoryFixture, type LessonWorldOptions } from "../fixtures/lesson-world";
import { SCHOOL_OBJECTIVE_ID, seedSchoolDeck } from "../fixtures/school-world";
import {
  buildTestServices,
  finishLessonTask,
  ManualClock,
  testDatabase,
  truncateCoreTables,
} from "./helpers";

/**
 * Historyjka na koniec sesji lekcji (design „Historyjka lekcji” §8.2–§8.3):
 * plan treningu przy starcie dokleja na końcu slot historyjki i po jednym slocie
 * na pytanie — poza budżetem ocenianych zadań, z gotowym nagraniem lektora albo
 * bez niego. Bez flagi przedmiotu, bez historyjki i w kartkówce slotów brak.
 * Odpowiedź na pytanie (§8.3) tworzy próbę bez oceny i postępu, a ujawnienia na
 * żądanie są odrzucane dla zadań historyjki i karty (§8.4).
 */

const { db, pool } = testDatabase();
const SESSION_BUDGET = 4;

beforeEach(async () => {
  await truncateCoreTables();
  await pool.query(`truncate learning_app.child_objective_progress, learning_app.lesson_verdicts, learning_app.lesson_story_assets,
    learning_app.revision_assets, learning_app.media_assets, learning_app.item_revision_skills,
    learning_app.item_revisions, learning_app.skill_versions, learning_app.learning_items,
    learning_app.deck_versions, learning_app.decks cascade`);
});
afterAll(() => pool.end());

interface StoredSlot {
  taskKind: string;
  exerciseType: string;
  assessed: boolean;
  prompt: Record<string, unknown>;
}
interface StoredPlan {
  taskBudget: number;
  slots: StoredSlot[];
}

interface StartOptions {
  /** Budżet sesji zestawu (`decks.session_task_budget`); domyślnie `SESSION_BUDGET`. */
  budget?: number;
  /**
   * Cel opanowany z należnym sprawdzeniem: plan bez kart z 7 ocenianymi slotami
   * (przy budżecie ≥ 7) — miejsce na limit czasu przy więcej niż 3 pozostałych.
   */
  dueMastery?: boolean;
}

/** Lekcja z bogatą pulą przypisana nowemu dziecku i budżetem sesji `SESSION_BUDGET`. */
async function startLesson(services: Services, options: LessonWorldOptions = {}, mode?: "mock_test", start: StartOptions = {}) {
  const child = await createChild(services, { displayName: "Historyjka", avatarKey: "owl" });
  const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, ...options });
  await pool.query("update learning_app.decks set session_task_budget = $2 where id = $1", [lesson.deckId, start.budget ?? SESSION_BUDGET]);
  if (start.dueMastery) {
    await pool.query(
      `insert into learning_app.child_objective_progress
         (child_id, subject_id, objective_id, topic_id, status, streak, next_review_at, projection_version)
       values ($1, 'english_grammar', $2, $3, 'mastered', 3, '2000-01-01T00:00:00Z', 'proj-1')`,
      [child.id, lesson.objectiveId, lesson.topicId],
    );
  }
  const session = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false, ...(mode ? { mode } : {}) });
  return { lesson, session };
}

async function storedPlans(sessionId: string): Promise<{ training: StoredPlan | null; mockTest: StoredPlan | null }> {
  const row = (await pool.query<{ training: StoredPlan | null; mockTest: StoredPlan | null }>(
    `select training_plan as training, mock_test_plan as "mockTest" from learning_app.learning_sessions where id = $1`, [sessionId],
  )).rows[0]!;
  return row;
}

const kinds = (plan: StoredPlan): string[] => plan.slots.map((slot) => slot.taskKind);
const isStorySlot = (slot: StoredSlot): boolean => slot.taskKind === "story" || slot.taskKind === "story_question";

describe("historyjka w planie sesji lekcji", () => {
  it("plan ends with story slots without changing the budget", async () => {
    const { services } = buildTestServices();
    const withStory = (await storedPlans((await startLesson(services, { story: { value: STORY_FIXTURE } })).session.sessionId)).training!;
    const without = (await storedPlans((await startLesson(services)).session.sessionId)).training!;

    expect(kinds(withStory).slice(-3)).toEqual(["story", "story_question", "story_question"]);
    expect(kinds(without)).not.toContain("story");
    const head = withStory.slots.filter((slot) => !isStorySlot(slot));
    expect(head.map((slot) => [slot.taskKind, slot.exerciseType])).toEqual(without.slots.map((slot) => [slot.taskKind, slot.exerciseType]));
    expect(withStory.taskBudget).toBe(without.taskBudget);
    expect(withStory.slots.filter((slot) => slot.assessed)).toHaveLength(without.slots.filter((slot) => slot.assessed).length);
    expect(withStory.slots.filter(isStorySlot).every((slot) => !slot.assessed)).toBe(true);

    const [story, first, second] = withStory.slots.slice(-3);
    expect(story!.prompt).toEqual({ kind: "lesson_story", story: { sentences: STORY_FIXTURE.sentences }, contentLocale: "en-GB" });
    expect(first!.prompt).toMatchObject({ kind: "lesson_story_question", question: STORY_FIXTURE.questions[0]!.question });
    expect(second!.prompt).toMatchObject({ kind: "lesson_story_question", question: STORY_FIXTURE.questions[1]!.question });
  });

  it("plan uses the ready story recording and omits a pending one", async () => {
    const { services } = buildTestServices();
    const ready = await startLesson(services, { story: { value: STORY_FIXTURE, audio: "ready" } });
    const readyPlan = (await storedPlans(ready.session.sessionId)).training!;
    const readyStorySlots = readyPlan.slots.filter(isStorySlot);
    expect(readyStorySlots).toHaveLength(3);
    for (const slot of readyStorySlots) expect(slot.prompt.questionAudioAssetId).toBe(ready.lesson.storyAudio!.assetId);

    const pending = await startLesson(services, { story: { value: STORY_FIXTURE, audio: "pending" } });
    const pendingStorySlots = (await storedPlans(pending.session.sessionId)).training!.slots.filter(isStorySlot);
    expect(pendingStorySlots).toHaveLength(3);
    for (const slot of pendingStorySlots) expect(slot.prompt).not.toHaveProperty("questionAudioAssetId");
  });

  it("no story slots without lessonStory flag, without a story or in a mock test", async () => {
    const withoutFlag = createServices({
      db,
      clock: new ManualClock(),
      subjects: createSubjectRegistry([{ ...englishGrammarSubject, lessonStory: false }, schoolSubject]),
    });
    const flagless = (await storedPlans((await startLesson(withoutFlag, { story: { value: STORY_FIXTURE, audio: "ready" } })).session.sessionId)).training!;
    expect(flagless.slots.filter(isStorySlot)).toEqual([]);

    const { services } = buildTestServices();
    const storyless = (await storedPlans((await startLesson(services)).session.sessionId)).training!;
    expect(storyless.slots.filter(isStorySlot)).toEqual([]);

    const mock = await startLesson(services, { story: { value: STORY_FIXTURE, audio: "ready" }, testDate: "2026-10-20" }, "mock_test");
    const mockPlans = await storedPlans(mock.session.sessionId);
    expect(mockPlans.training).toBeNull();
    expect(mockPlans.mockTest!.slots.length).toBeGreaterThan(0);
    expect(mockPlans.mockTest!.slots.every((slot) => slot.exerciseType !== "lesson_story" && slot.exerciseType !== "lesson_story_question")).toBe(true);
  });
});

interface StoryKey {
  correctOptionId: string;
  optionValues: Record<string, string>;
}

async function storyKeyOf(taskId: string): Promise<StoryKey> {
  return (await pool.query<{ key: StoryKey }>(`select answer_key as key from learning_app.session_tasks where id = $1`, [taskId])).rows[0]!.key;
}

async function taskStateOf(taskId: string): Promise<string> {
  return (await pool.query<{ state: string }>("select state from learning_app.session_tasks where id = $1", [taskId])).rows[0]!.state;
}

async function attemptsOf(taskId: string): Promise<{ id: string; context: Record<string, unknown>; state: string }[]> {
  return (await pool.query<{ id: string; context: Record<string, unknown>; state: string }>(
    "select id, context, state from learning_app.attempts where task_id = $1", [taskId],
  )).rows;
}

async function assessmentCountOf(taskId: string): Promise<number> {
  return (await pool.query<{ count: number }>(
    `select count(*)::int as count from learning_app.assessments a
       join learning_app.attempts t on t.id = a.attempt_id where t.task_id = $1`, [taskId],
  )).rows[0]!.count;
}

async function eventsOf(taskId: string): Promise<{ id: string; kind: string; sealed: boolean; exposures: number }[]> {
  return (await pool.query<{ id: string; kind: string; sealed: boolean; exposures: number }>(
    `select e.id, e.kind, e.sealed,
            (select count(*)::int from learning_app.event_exposures x where x.event_id = e.id) as exposures
       from learning_app.learning_events e where e.task_id = $1 order by e.occurred_at, e.step_id`, [taskId],
  )).rows;
}

async function progressSnapshot(childId: string): Promise<unknown[]> {
  return (await pool.query("select * from learning_app.child_objective_progress where child_id = $1 order by objective_id", [childId])).rows;
}

async function graderCallsOf(sessionId: string): Promise<unknown> {
  return (await pool.query<{ calls: unknown }>(
    "select context->'graderCalls' as calls from learning_app.learning_sessions where id = $1", [sessionId],
  )).rows[0]!.calls;
}

/** Pierwsze oceniane ćwiczenie sesji (karty po drodze kończy). */
async function firstExercise(services: Services, sessionId: string): Promise<TaskDto> {
  for (let guard = 0; guard < 10; guard += 1) {
    const task = await nextTask(services, sessionId);
    if (!task) throw new Error("sesja skończyła się przed ćwiczeniem");
    if (task.exerciseType !== "lesson_card") return task;
    await finishLessonTask(services, task);
  }
  throw new Error("nie doczekano ćwiczenia");
}

const storyLesson = (services: Services, start: StartOptions = {}) =>
  startLesson(services, { story: { value: STORY_FIXTURE, audio: "ready" } }, undefined, start);

/** Prawdziwe wydanie `index`-tego pytania: zadania przed historyjką, historyjka i wcześniejsze pytania kończone poprawnie. */
async function issueStoryQuestion(services: Services, sessionId: string, index = 0): Promise<TaskDto> {
  await finishLessonTask(services, await drainToStory(services, sessionId));
  for (let current = 0; ; current += 1) {
    const question = await nextTask(services, sessionId);
    if (question?.exerciseType !== "lesson_story_question") throw new Error(`brak pytania ${index}`);
    if (current === index) return question;
    await finishLessonTask(services, question);
  }
}

describe("historyjka — odpowiedź na pytanie, routing prób i ujawnienia", () => {
  it("story question answer creates an attempt without assessment or progress change", async () => {
    const { services } = buildTestServices();
    const { session } = await storyLesson(services);
    const question = await issueStoryQuestion(services, session.sessionId);
    const progressBefore = await progressSnapshot(session.childId);
    expect(progressBefore.length).toBeGreaterThan(0);
    const graderBefore = await graderCallsOf(session.sessionId);

    const key = await storyKeyOf(question.taskId);
    const attempt = await submitAttempt(services, { taskId: question.taskId, clientAttemptId: randomUUID(), modality: "choice", optionId: key.correctOptionId });

    expect(attempt.feedback).toEqual({ kind: "great" });
    expect(attempt.taskState).toBe("answered");
    expect(attempt.state).toBe("completed");
    const rows = await attemptsOf(question.taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.context.storyQuestion).toBe(true);
    expect(await assessmentCountOf(question.taskId)).toBe(0);
    expect(await progressSnapshot(session.childId)).toEqual(progressBefore);
    expect(await graderCallsOf(session.sessionId)).toEqual(graderBefore);
  });

  it("wrong story answer shows the correct option text", async () => {
    const { services } = buildTestServices();
    const { session } = await storyLesson(services);
    const question = await issueStoryQuestion(services, session.sessionId);
    const key = await storyKeyOf(question.taskId);
    const wrong = Object.keys(key.optionValues).find((id) => id !== key.correctOptionId)!;

    const attempt = await submitAttempt(services, { taskId: question.taskId, clientAttemptId: randomUUID(), modality: "choice", optionId: wrong });
    expect(attempt.feedback).toEqual({ kind: "incorrect", correctText: "czerwony" });
    expect(attempt.taskState).toBe("answered");
    expect(await assessmentCountOf(question.taskId)).toBe(0);
  });

  it("story question feedback is sealed without exercise exposures", async () => {
    const { services } = buildTestServices();
    const { session } = await storyLesson(services);
    const question = await issueStoryQuestion(services, session.sessionId, 1);
    const key = await storyKeyOf(question.taskId);
    const attempt = await submitAttempt(services, { taskId: question.taskId, clientAttemptId: randomUUID(), modality: "choice", optionId: key.correctOptionId });

    expect(attempt.stepId).toBe(`${question.taskId}:f1`);
    const feedback = (await eventsOf(question.taskId)).filter((event) => event.kind === "feedback_issued");
    expect(feedback).toEqual([expect.objectContaining({ sealed: true, exposures: 0 })]);
  });

  it("story answer is idempotent; the same key with another answer or another task conflicts", async () => {
    const { services } = buildTestServices();
    const { session } = await storyLesson(services);
    const exercise = await firstExercise(services, session.sessionId);
    const usedKey = randomUUID();
    // Zwykłe zadanie lekcji odpowiedziane wcześniej tym samym kluczem.
    await submitAttempt(services, { taskId: exercise.taskId, clientAttemptId: usedKey, modality: "dont_remember" });

    const question = await issueStoryQuestion(services, session.sessionId);
    const key = await storyKeyOf(question.taskId);
    const input = { taskId: question.taskId, clientAttemptId: randomUUID(), modality: "choice" as const, optionId: key.correctOptionId };
    const first = await submitAttempt(services, input);
    const again = await submitAttempt(services, input);
    expect(again.attemptId).toBe(first.attemptId);
    expect(again.feedback).toEqual(first.feedback);
    expect(again.taskState).toBe("answered");
    expect(again.stepId).toBe(`${question.taskId}:f2`);
    expect((await eventsOf(question.taskId)).filter((event) => event.kind === "feedback_issued")).toHaveLength(2);

    const other = Object.keys(key.optionValues).find((id) => id !== key.correctOptionId)!;
    await expect(submitAttempt(services, { ...input, optionId: other })).rejects.toMatchObject({ code: "conflict" });
    await expect(submitAttempt(services, { ...input, clientAttemptId: usedKey })).rejects.toMatchObject({ code: "conflict" });
    expect(await attemptsOf(question.taskId)).toHaveLength(1);
  });

  it("reading a story answer re-discloses without exposures", async () => {
    const { services } = buildTestServices();
    const { session } = await storyLesson(services);
    const question = await issueStoryQuestion(services, session.sessionId);
    const key = await storyKeyOf(question.taskId);
    const first = await submitAttempt(services, { taskId: question.taskId, clientAttemptId: randomUUID(), modality: "choice", optionId: key.correctOptionId });

    const read = await readAttempt(services, first.attemptId);
    expect(read).toMatchObject({ attemptId: first.attemptId, feedback: { kind: "great" }, taskState: "answered", stepId: `${question.taskId}:f2` });
    const feedback = (await eventsOf(question.taskId)).filter((event) => event.kind === "feedback_issued");
    expect(feedback).toHaveLength(2);
    expect(feedback.every((event) => event.sealed && event.exposures === 0)).toBe(true);
  });

  it("story question rejects non-choice modalities", async () => {
    const { services } = buildTestServices();
    const { session } = await storyLesson(services);
    const question = await issueStoryQuestion(services, session.sessionId);
    const base = { taskId: question.taskId, clientAttemptId: randomUUID() };
    await expect(submitAttempt(services, { ...base, modality: "dont_remember" })).rejects.toMatchObject({ code: "validation" });
    await expect(submitAttempt(services, { ...base, modality: "skip" })).rejects.toMatchObject({ code: "validation" });
    await expect(submitAttempt(services, { ...base, modality: "text", text: "czerwony" })).rejects.toMatchObject({ code: "validation" });
    expect(await attemptsOf(question.taskId)).toHaveLength(0);
    expect(await taskStateOf(question.taskId)).toBe("issued");
  });

  it("story question rejects an unknown option id", async () => {
    const { services } = buildTestServices();
    const { session } = await storyLesson(services);
    const question = await issueStoryQuestion(services, session.sessionId);
    await expect(submitAttempt(services, { taskId: question.taskId, clientAttemptId: randomUUID(), modality: "choice", optionId: randomUUID() }))
      .rejects.toMatchObject({ code: "validation" });
    expect(await attemptsOf(question.taskId)).toHaveLength(0);
    expect(await taskStateOf(question.taskId)).toBe("issued");
  });

  it("attempts on lesson_card and lesson_story are rejected", async () => {
    const { services } = buildTestServices();
    const { session } = await storyLesson(services);
    const card = await nextTask(services, session.sessionId);
    expect(card?.exerciseType).toBe("lesson_card");
    for (const modality of ["skip", "dont_remember"] as const) {
      await expect(submitAttempt(services, { taskId: card!.taskId, clientAttemptId: randomUUID(), modality })).rejects.toMatchObject({ code: "validation" });
    }
    await completePresentation(services, { taskId: card!.taskId });
    const story = await drainToStory(services, session.sessionId);
    for (const modality of ["skip", "dont_remember"] as const) {
      await expect(submitAttempt(services, { taskId: story.taskId, clientAttemptId: randomUUID(), modality })).rejects.toMatchObject({ code: "validation" });
    }
    for (const taskId of [card!.taskId, story.taskId]) {
      expect(await attemptsOf(taskId)).toHaveLength(0);
      expect(await assessmentCountOf(taskId)).toBe(0);
    }
  });

  it("complete-presentation finishes the story without an attempt", async () => {
    const { services } = buildTestServices();
    const { session } = await storyLesson(services);
    const story = await drainToStory(services, session.sessionId);
    const done = await completePresentation(services, { taskId: story.taskId });
    expect(done.state).toBe("completed");
    expect(await taskStateOf(story.taskId)).toBe("completed");
    // Ten sam czas zegara testu: kolejność zdarzeń bez znaczenia, liczy się komplet.
    expect((await eventsOf(story.taskId)).map((event) => event.kind).sort()).toEqual(["presentation_completed", "prompt_issued"]);
    expect(await attemptsOf(story.taskId)).toHaveLength(0);
  });

  it("disclosures stay rejected for story, story question and card (regression lock)", async () => {
    const { services } = buildTestServices();
    const { session } = await storyLesson(services);
    const card = await nextTask(services, session.sessionId);
    expect(card?.exerciseType).toBe("lesson_card");
    const check = async (taskId: string) => {
      for (const kind of ["hint", "audio"] as const) {
        await expect(authorizeDisclosure(services, { taskId, kind })).rejects.toMatchObject({ code: "conflict" });
      }
    };
    await check(card!.taskId);
    await completePresentation(services, { taskId: card!.taskId });
    const story = await drainToStory(services, session.sessionId);
    await check(story.taskId);
    await completePresentation(services, { taskId: story.taskId });
    const question = (await nextTask(services, session.sessionId))!;
    expect(question.exerciseType).toBe("lesson_story_question");
    await check(question.taskId);

    const disclosed = await pool.query<{ count: number }>(
      `select count(*)::int as count from learning_app.learning_events
        where task_id = any($1::uuid[]) and kind in ('hint_issued', 'audio_issued')`,
      [[card!.taskId, story.taskId, question.taskId]],
    );
    expect(disclosed.rows[0]!.count).toBe(0);
  });

  it("second answer with a new clientAttemptId on an answered story question conflicts", async () => {
    const { services } = buildTestServices();
    const { session } = await storyLesson(services, { budget: 2 });
    await finishLessonTask(services, await drainToStory(services, session.sessionId));
    const question = (await nextTask(services, session.sessionId))!;
    expect(question.exerciseType).toBe("lesson_story_question");
    const key = await storyKeyOf(question.taskId);
    await submitAttempt(services, { taskId: question.taskId, clientAttemptId: randomUUID(), modality: "choice", optionId: key.correctOptionId });
    const other = Object.keys(key.optionValues).find((id) => id !== key.correctOptionId)!;
    await expect(submitAttempt(services, { taskId: question.taskId, clientAttemptId: randomUUID(), modality: "choice", optionId: other }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(await attemptsOf(question.taskId)).toHaveLength(1);
  });

  it("answer after the session closed is rejected as a closed session", async () => {
    const { services } = buildTestServices();
    const { session } = await storyLesson(services, { budget: 2 });
    await finishLessonTask(services, await drainToStory(services, session.sessionId));
    const question = (await nextTask(services, session.sessionId))!;
    expect(question.exerciseType).toBe("lesson_story_question");
    await endSession(services, session.sessionId);
    const key = await storyKeyOf(question.taskId);
    await expect(submitAttempt(services, { taskId: question.taskId, clientAttemptId: randomUUID(), modality: "choice", optionId: key.correctOptionId }))
      .rejects.toMatchObject({ code: "conflict", message: "session is closed" });
    expect(await attemptsOf(question.taskId)).toHaveLength(0);
  });
});

const MINUTE = 60_000;
const isStoryTask = (task: TaskDto): boolean => task.exerciseType === "lesson_story" || task.exerciseType === "lesson_story_question";

/** Kończy kolejne zadania sesji aż do pierwszego `lesson_story` i je zwraca; wcześniejsze zadania dopisuje do `issued`. */
async function drainToStory(services: Services, sessionId: string, issued: TaskDto[] = []): Promise<TaskDto> {
  for (let guard = 0; guard < 40; guard += 1) {
    const task = await nextTask(services, sessionId);
    if (!task) throw new Error("sesja skończyła się bez historyjki");
    if (task.exerciseType === "lesson_story") return task;
    issued.push(task);
    await finishLessonTask(services, task);
  }
  throw new Error("nie doczekano historyjki");
}

/** Wydaje i kończy zadania aż do `null`; zwraca wydane zadania w kolejności. */
async function drainSession(services: Services, sessionId: string): Promise<TaskDto[]> {
  const issued: TaskDto[] = [];
  for (let guard = 0; guard < 40; guard += 1) {
    const task = await nextTask(services, sessionId);
    if (!task) return issued;
    issued.push(task);
    await finishLessonTask(services, task);
  }
  throw new Error("sesja nie skończyła się");
}

async function sessionTaskTypes(sessionId: string): Promise<string[]> {
  return (await pool.query<{ type: string }>(
    "select exercise_type as type from learning_app.session_tasks where session_id = $1 order by ordinal", [sessionId],
  )).rows.map((row) => row.type);
}

const NON_ASSESSED = new Set(["lesson_card", "lesson_story", "lesson_story_question"]);
const assessedCount = (types: string[]): number => types.filter((type) => !NON_ASSESSED.has(type)).length;

interface StoredFullSlot extends StoredSlot { taskId: string; revealsTargetKeys: string[] }

async function storySlotsOf(sessionId: string): Promise<{ regular: StoredFullSlot[]; story: StoredFullSlot[]; taskBudget: number }> {
  const plan = (await storedPlans(sessionId)).training as unknown as { taskBudget: number; slots: StoredFullSlot[] };
  return { regular: plan.slots.filter((slot) => !isStorySlot(slot)), story: plan.slots.filter(isStorySlot), taskBudget: plan.taskBudget };
}

describe("historyjka — wydanie na koniec sesji", () => {
  it("story follows the last assessed task and questions follow the story", async () => {
    const { services } = buildTestServices();
    const { session } = await storyLesson(services, { budget: 2 });
    const { story: storySlots } = await storySlotsOf(session.sessionId);

    const story = await drainToStory(services, session.sessionId);
    expect(story).toMatchObject({ taskId: storySlots[0]!.taskId, prompt: { kind: "lesson_story", story: { sentences: STORY_FIXTURE.sentences } } });
    await finishLessonTask(services, story);
    const first = await nextTask(services, session.sessionId);
    expect(first).toMatchObject({ taskId: storySlots[1]!.taskId, exerciseType: "lesson_story_question", prompt: { question: STORY_FIXTURE.questions[0]!.question } });
    await finishLessonTask(services, first!);
    const second = await nextTask(services, session.sessionId);
    expect(second).toMatchObject({ taskId: storySlots[2]!.taskId, exerciseType: "lesson_story_question", prompt: { question: STORY_FIXTURE.questions[1]!.question } });
    await finishLessonTask(services, second!);
    expect(await nextTask(services, session.sessionId)).toBeNull();
  });

  it("plan shorter than session budget still ends with the story", async () => {
    const { services } = buildTestServices();
    const { session } = await storyLesson(services, { budget: 20 });
    const { regular, story: storySlots, taskBudget } = await storySlotsOf(session.sessionId);
    // Selektor skończył plan przed budżetem zestawu.
    expect(taskBudget).toBeLessThan(20);
    // Budżet sesji większy niż plan (np. sesja sprzed zrównania budżetu z planem):
    // `remaining` nie spada do zera, więc historyjkę wydaje wyłącznie pusty zbiór
    // niewydanych slotów spoza historyjki (ruling 1).
    await pool.query("update learning_app.learning_sessions set task_budget = 20 where id = $1", [session.sessionId]);

    const before: TaskDto[] = [];
    const story = await drainToStory(services, session.sessionId, before);
    expect(before.map((task) => task.taskId)).toEqual(regular.map((slot) => slot.taskId));
    expect(story.taskId).toBe(storySlots[0]!.taskId);
  });

  it("closing story flag on every non-story task", async () => {
    const { services } = buildTestServices();
    const withStory = await drainSession(services, (await storyLesson(services, { budget: 2 })).session.sessionId);
    expect(withStory.filter(isStoryTask)).toHaveLength(3);
    for (const task of withStory.filter((task) => !isStoryTask(task))) expect(task.closingStory).toBe(true);
    for (const task of withStory.filter(isStoryTask)) expect(task).not.toHaveProperty("closingStory");

    const without = await drainSession(services, (await startLesson(services, {}, undefined, { budget: 2 })).session.sessionId);
    expect(without.length).toBeGreaterThan(0);
    for (const task of without) expect(task).not.toHaveProperty("closingStory");
  });

  it("story tasks report remainingAssessed 0", async () => {
    const { services } = buildTestServices();
    const tasks = await drainSession(services, (await storyLesson(services, { budget: 2 })).session.sessionId);
    const story = tasks.filter(isStoryTask);
    expect(story.map((task) => task.exerciseType)).toEqual(["lesson_story", "lesson_story_question", "lesson_story_question"]);
    for (const task of story) expect(task.remainingAssessed).toBe(0);
    const lastAssessed = tasks.filter((task) => !NON_ASSESSED.has(task.exerciseType)).at(-1)!;
    expect(lastAssessed.remainingAssessed).toBe(1);
  });

  it("issued story is re-read with the same counters", async () => {
    const { services } = buildTestServices();
    const { session } = await storyLesson(services, { budget: 2 });
    const story = await drainToStory(services, session.sessionId);
    const again = await nextTask(services, session.sessionId);
    expect(again).toEqual(story);
    expect(again!.remainingAssessed).toBe(0);
    await finishLessonTask(services, story);
    const question = await nextTask(services, session.sessionId);
    expect(await nextTask(services, session.sessionId)).toEqual(question);
    expect(question!.remainingAssessed).toBe(0);
  });

  it("time limit with more than three left issues the story, never the skipped exercise", async () => {
    const { services, clock } = buildTestServices();
    const { session } = await storyLesson(services, { budget: 8, dueMastery: true });
    const { taskBudget } = await storySlotsOf(session.sessionId);
    expect(taskBudget).toBeGreaterThanOrEqual(6);
    const first = (await nextTask(services, session.sessionId))!;
    expect(NON_ASSESSED.has(first.exerciseType)).toBe(false);
    await finishLessonTask(services, first);

    clock.advanceMs(11 * MINUTE);
    const rest = await drainSession(services, session.sessionId);
    expect(rest.map((task) => task.exerciseType)).toEqual(["lesson_story", "lesson_story_question", "lesson_story_question"]);
    expect(assessedCount(await sessionTaskTypes(session.sessionId))).toBe(1);
  });

  it("time limit inside the promise keeps the promised tasks before the story", async () => {
    const { services, clock } = buildTestServices();
    const { session } = await storyLesson(services, { budget: 8, dueMastery: true });
    const { taskBudget } = await storySlotsOf(session.sessionId);
    expect(taskBudget).toBeGreaterThan(3);
    for (let done = 0; done < taskBudget - 3;) {
      const task = (await nextTask(services, session.sessionId))!;
      if (!NON_ASSESSED.has(task.exerciseType)) done += 1;
      await finishLessonTask(services, task);
    }

    clock.advanceMs(11 * MINUTE);
    const rest = await drainSession(services, session.sessionId);
    expect(assessedCount(rest.map((task) => task.exerciseType))).toBe(3);
    expect(rest.slice(-3).map((task) => task.exerciseType)).toEqual(["lesson_story", "lesson_story_question", "lesson_story_question"]);
    expect(assessedCount(await sessionTaskTypes(session.sessionId))).toBe(taskBudget);
  });

  it("stale session ends without the story", async () => {
    const { services, clock } = buildTestServices();
    const { session } = await storyLesson(services, { budget: 8, dueMastery: true });
    await finishLessonTask(services, (await nextTask(services, session.sessionId))!);

    clock.advanceMs(31 * MINUTE);
    expect(await nextTask(services, session.sessionId)).toBeNull();
    const state = (await pool.query<{ state: string }>("select state from learning_app.learning_sessions where id = $1", [session.sessionId])).rows[0]!.state;
    expect(state).toBe("ended");
    expect((await sessionTaskTypes(session.sessionId)).filter((type) => type.startsWith("lesson_story"))).toEqual([]);
  });

  it("legacy session without a plan never issues the story", async () => {
    const { services } = buildTestServices();
    const { session } = await storyLesson(services, { budget: 2 });
    // Sesja sprzed stałego planu (jak `startLegacyTrainingSession`): plan jest niezmienny poza testem.
    await pool.query("alter table learning_app.learning_sessions disable trigger learning_sessions_training_plan_immutable");
    try {
      await pool.query("update learning_app.learning_sessions set training_plan = null where id = $1", [session.sessionId]);
    } finally {
      await pool.query("alter table learning_app.learning_sessions enable trigger learning_sessions_training_plan_immutable");
    }
    const tasks = await drainSession(services, session.sessionId);
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.filter(isStoryTask)).toEqual([]);
    for (const task of tasks) expect(task).not.toHaveProperty("closingStory");
  });

  it("story tasks do not count as contact with the anchor objective", async () => {
    const { services, clock } = buildTestServices();
    const { lesson, session } = await storyLesson(services, { budget: 8, dueMastery: true });
    const assessedAt = clock.now().toISOString();
    await finishLessonTask(services, (await nextTask(services, session.sessionId))!);

    // Po miękkim limicie, w oknie wznowienia: historyjka i pytania.
    clock.advanceMs(20 * MINUTE);
    const rest = await drainSession(services, session.sessionId);
    expect(rest.map((task) => task.exerciseType)).toEqual(["lesson_story", "lesson_story_question", "lesson_story_question"]);

    clock.advanceMs(13 * 60 * MINUTE);
    const next = await startSession(services, { childId: session.childId, deckId: lesson.deckId, microphoneEnabled: false });
    expect(next.sessionId).not.toBe(session.sessionId);
    const context = (await pool.query<{ context: { previousObjectiveContact: Record<string, string> } }>(
      "select context from learning_app.learning_sessions where id = $1", [next.sessionId],
    )).rows[0]!.context;
    expect(context.previousObjectiveContact[lesson.objectiveId]).toBeDefined();
    expect(context.previousObjectiveContact[lesson.objectiveId]! <= assessedAt).toBe(true);
  });

  it("story exposures do not mark exercises as seen", async () => {
    const { services } = buildTestServices();
    const { session } = await storyLesson(services, { budget: 2 });
    const { story: storySlots } = await storySlotsOf(session.sessionId);
    const story = await drainToStory(services, session.sessionId);

    const storyKeys = (await pool.query<{ key: string }>(
      `select x.target_key as key from learning_app.event_exposures x
         join learning_app.learning_events e on e.id = x.event_id where e.task_id = $1 and e.sealed`, [story.taskId],
    )).rows.map((row) => row.key);
    expect([...storyKeys].sort()).toEqual([...storySlots[0]!.revealsTargetKeys].sort());
    const childKeys = new Set((await pool.query<{ key: string }>(
      "select target_key as key from learning_app.event_exposures where child_id = $1", [session.childId],
    )).rows.map((row) => row.key));
    for (const key of storySlots[0]!.revealsTargetKeys) expect(childKeys.has(key)).toBe(true);
    // Ćwiczenia spoza planu z budżetem 2 (luki, przekształcenie) pozostają niewidziane.
    for (const key of [RICH_KEYS.gap, RICH_KEYS.gap2, RICH_KEYS.gap3, RICH_KEYS.transform]) expect(childKeys.has(key)).toBe(false);
    for (const key of Object.values(RICH_KEYS)) expect(storyKeys).not.toContain(key);
  });

  it("session dto and summary exclude cards and story tasks from assessed count", async () => {
    const { services } = buildTestServices();
    const { lesson, session } = await storyLesson(services, { budget: 2 });
    const tasks = await drainSession(services, session.sessionId);
    const types = tasks.map((task) => task.exerciseType);
    expect(types).toContain("lesson_card");
    expect(types).toContain("lesson_story");
    const assessed = assessedCount(types);
    expect(assessed).toBe(2);

    const resumed = await startSession(services, { childId: session.childId, deckId: lesson.deckId, microphoneEnabled: false });
    expect(resumed).toMatchObject({ sessionId: session.sessionId, resumed: true, tasksIssued: tasks.length, assessedTasksIssued: assessed });
    const summary = await endSession(services, session.sessionId);
    expect(summary).toMatchObject({ tasksIssued: tasks.length, assessedTasksIssued: assessed });
  });

  it("deleting the profile removes story tasks, attempts and events but keeps the recording", async () => {
    const { services } = buildTestServices();
    const { lesson, session } = await storyLesson(services, { budget: 2 });
    const tasks = await drainSession(services, session.sessionId);
    expect(tasks.filter(isStoryTask)).toHaveLength(3);

    await deleteChild(services, session.childId);
    for (const table of ["session_tasks", "attempts", "learning_events"]) {
      const count = (await pool.query<{ count: number }>(`select count(*)::int as count from learning_app.${table} where child_id = $1`, [session.childId])).rows[0]!.count;
      expect(count, table).toBe(0);
    }
    const recording = await pool.query("select 1 from learning_app.lesson_story_assets where deck_version_id = $1", [lesson.versionId]);
    expect(recording.rowCount).toBe(1);
    const asset = await pool.query("select state from learning_app.media_assets where id = $1", [lesson.storyAudio!.assetId]);
    expect(asset.rows).toEqual([{ state: "ready" }]);
  });

  it("progress rebuild ignores story attempts", async () => {
    const { services } = buildTestServices();
    const { lesson, session } = await storyLesson(services, { budget: 2 });
    const tasks = await drainSession(services, session.sessionId);
    const questions = tasks.filter((task) => task.exerciseType === "lesson_story_question");
    expect(questions).toHaveLength(2);
    const strip = (rows: unknown[]) => rows.map((row) => {
      const { updated_at: _updated, ...rest } = row as Record<string, unknown>;
      return rest;
    });
    await endSession(services, session.sessionId);
    const before = strip(await progressSnapshot(session.childId));
    expect(before.length).toBeGreaterThan(0);

    await rebuildProgress(services, { childId: session.childId, apply: true });
    expect(strip(await progressSnapshot(session.childId))).toEqual(before);
    // Nadzór werdyktów rodzica nie pokazuje odpowiedzi na pytania historyjki.
    const optionTexts = new Set(STORY_FIXTURE.questions.flatMap((question) => question.options.map((option) => option.text)));
    const verdicts = await listLessonVerdicts(services, lesson.deckId);
    expect(verdicts.filter((verdict) => optionTexts.has(verdict.childAnswer))).toEqual([]);
    for (const question of questions) expect(await assessmentCountOf(question.taskId)).toBe(0);
  });
});

/** Historyjka szkolna: zdania po polsku (język odpowiedzi przedmiotu `school`). */
const SCHOOL_STORY: LessonStoryFixture = {
  sentences: ["Ola ma w domu kwiatek.", "Kwiatek stoi przy oknie.", "Codziennie Ola go podlewa.", "Kwiatek rośnie bardzo szybko."],
  questions: [
    {
      id: "q1",
      question: "Gdzie stoi kwiatek?",
      options: [{ id: "a", text: "przy oknie" }, { id: "b", text: "w szafie" }, { id: "c", text: "pod łóżkiem" }],
      correctOption: "a",
    },
    {
      id: "q2",
      question: "Co robi Ola codziennie?",
      options: [{ id: "a", text: "czyta" }, { id: "b", text: "podlewa kwiatek" }, { id: "c", text: "śpiewa" }],
      correctOption: "b",
    },
  ],
};

describe("historyjka — trener precyzji przed historyjką", () => {
  // Oba elementy trafione, ale z dygresją >200 znaków: fake grader daje precyzję verbose.
  const verboseAnswer =
    "Roślina wytwarza cukry, bo wykorzystuje światło. " +
    "W ogóle rośliny są bardzo ciekawe i rosną w ogrodzie mojej babci, a wczoraj padał deszcz. " +
    "Potem grałem w piłkę z kolegami na podwórku aż do wieczora i było super, naprawdę bardzo fajnie.";
  const shortened = "Roślina wytwarza cukry, bo wykorzystuje światło.";

  it("precision follow-up before the story", async () => {
    const { clock } = buildTestServices();
    const schoolWithStory = { ...schoolSubject, lessonStory: true, prompts: { ...schoolSubject.prompts, storyRules: "Krótka historyjka o roślinach." } };
    const services = createServices({
      db, clock,
      grader: { provider: new FakeAnswerGrader(), maxCallsPerSession: 20, timeoutMs: 8000 },
      subjects: createSubjectRegistry([englishGrammarSubject, schoolWithStory]),
    });
    const child = await createChild(services, { displayName: "Gaduła", avatarKey: "owl" });
    const { deckId } = await seedSchoolDeck(pool, child.id, { secondObjective: true, story: SCHOOL_STORY });
    // Odpowiedź otwarta to należne sprawdzenie celu (jak w lesson-grader-school).
    await pool.query(
      `insert into learning_app.child_objective_progress
         (child_id, subject_id, objective_id, topic_id, status, streak, next_review_at, projection_version)
       values ($1, 'school', $2, 'dynamic', 'needs_confirmation', 3, '2000-01-01T00:00:00Z', 'proj-1')`,
      [child.id, SCHOOL_OBJECTIVE_ID],
    );
    const session = await startSession(services, { childId: child.id, deckId, microphoneEnabled: false });
    const { regular, story: storySlots } = await storySlotsOf(session.sessionId);
    expect(storySlots.map((slot) => slot.taskKind)).toEqual(["story", "story_question", "story_question"]);

    const issued: TaskDto[] = [];
    let open: TaskDto | null = null;
    for (let guard = 0; guard < 40 && !open; guard += 1) {
      const task = await nextTask(services, session.sessionId);
      if (!task) throw new Error("sesja skończyła się przed odpowiedzią otwartą");
      issued.push(task);
      if (task.prompt.kind === "lesson_open_answer") open = task;
      else await finishLessonTask(services, task);
    }
    const result = await submitAttempt(services, { taskId: open!.taskId, clientAttemptId: randomUUID(), modality: "text", text: verboseAnswer });
    expect(result.feedback).toMatchObject({ kind: "lesson_precision_hint" });
    const followUp = (await nextTask(services, session.sessionId))!;
    expect(followUp.prompt.kind).toBe("lesson_shorten");
    expect(followUp.closingStory).toBe(true);
    await submitAttempt(services, { taskId: followUp.taskId, clientAttemptId: randomUUID(), modality: "text", text: shortened });

    const rest = await drainSession(services, session.sessionId);
    const restRegular = rest.filter((task) => !isStoryTask(task));
    // Dalsze zadania planu po kolei, bez przesunięcia o zadanie następcze.
    expect([...issued, ...restRegular].map((task) => task.taskId)).toEqual(regular.map((slot) => slot.taskId));
    expect(rest.filter(isStoryTask).map((task) => task.taskId)).toEqual(storySlots.map((slot) => slot.taskId));
    expect(rest.slice(-3).map((task) => task.exerciseType)).toEqual(["lesson_story", "lesson_story_question", "lesson_story_question"]);
  });
});
