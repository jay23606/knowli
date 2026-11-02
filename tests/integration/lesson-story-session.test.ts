import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createChild,
  createServices,
  createSubjectRegistry,
  englishGrammarSubject,
  schoolSubject,
  startSession,
  type Services,
} from "@learning/server";
import { lessonWorld, STORY_FIXTURE, type LessonWorldOptions } from "../fixtures/lesson-world";
import { buildTestServices, ManualClock, testDatabase, truncateCoreTables } from "./helpers";

/**
 * Historyjka na koniec sesji lekcji (design „Historyjka lekcji” §8.2–§8.3):
 * plan treningu przy starcie dokleja na końcu slot historyjki i po jednym slocie
 * na pytanie — poza budżetem ocenianych zadań, z gotowym nagraniem lektora albo
 * bez niego. Bez flagi przedmiotu, bez historyjki i w kartkówce slotów brak.
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
