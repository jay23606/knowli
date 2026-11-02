import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { TaskDto } from "@learning/contracts";
import {
  authorizeDisclosure,
  completePresentation,
  createChild,
  createServices,
  createSubjectRegistry,
  englishGrammarSubject,
  nextTask,
  readAttempt,
  schoolSubject,
  startSession,
  submitAttempt,
  type Services,
} from "@learning/server";
import { lessonWorld, STORY_FIXTURE, type LessonWorldOptions } from "../fixtures/lesson-world";
import {
  buildTestServices,
  finishLessonTask,
  issuePlanSlotForTest,
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

/** Lekcja z bogatą pulą przypisana nowemu dziecku i budżetem sesji `SESSION_BUDGET`. */
async function startLesson(services: Services, options: LessonWorldOptions = {}, mode?: "mock_test") {
  const child = await createChild(services, { displayName: "Historyjka", avatarKey: "owl" });
  const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, ...options });
  await pool.query("update learning_app.decks set session_task_budget = $2 where id = $1", [lesson.deckId, SESSION_BUDGET]);
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

const storyLesson = (services: Services) => startLesson(services, { story: { value: STORY_FIXTURE, audio: "ready" } });

describe("historyjka — odpowiedź na pytanie, routing prób i ujawnienia", () => {
  it("story question answer creates an attempt without assessment or progress change", async () => {
    const { services } = buildTestServices();
    const { session } = await storyLesson(services);
    const exercise = await firstExercise(services, session.sessionId);
    await finishLessonTask(services, exercise);
    const progressBefore = await progressSnapshot(session.childId);
    expect(progressBefore.length).toBeGreaterThan(0);
    const graderBefore = await graderCallsOf(session.sessionId);

    const question = await issuePlanSlotForTest(pool, session.sessionId, "story_question");
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
    const question = await issuePlanSlotForTest(pool, session.sessionId, "story_question");
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
    const question = await issuePlanSlotForTest(pool, session.sessionId, "story_question", 1);
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

    const question = await issuePlanSlotForTest(pool, session.sessionId, "story_question");
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
    const question = await issuePlanSlotForTest(pool, session.sessionId, "story_question");
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
    const question = await issuePlanSlotForTest(pool, session.sessionId, "story_question");
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
    const question = await issuePlanSlotForTest(pool, session.sessionId, "story_question");
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
    const story = await issuePlanSlotForTest(pool, session.sessionId, "story");
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
    const story = await issuePlanSlotForTest(pool, session.sessionId, "story");
    const done = await completePresentation(services, { taskId: story.taskId });
    expect(done.state).toBe("completed");
    expect(await taskStateOf(story.taskId)).toBe("completed");
    expect((await eventsOf(story.taskId)).map((event) => event.kind)).toEqual(["presentation_completed"]);
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
    const story = await issuePlanSlotForTest(pool, session.sessionId, "story");
    await check(story.taskId);
    await completePresentation(services, { taskId: story.taskId });
    const question = await issuePlanSlotForTest(pool, session.sessionId, "story_question");
    await check(question.taskId);

    const disclosed = await pool.query<{ count: number }>(
      `select count(*)::int as count from learning_app.learning_events
        where task_id = any($1::uuid[]) and kind in ('hint_issued', 'audio_issued')`,
      [[card!.taskId, story.taskId, question.taskId]],
    );
    expect(disclosed.rows[0]!.count).toBe(0);
  });
});
