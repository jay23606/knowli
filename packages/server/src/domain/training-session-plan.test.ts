import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readLessonTrainingSessionPlan, readTrainingSessionPlan } from "./training-session-plan";

const plan = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  taskBudget: 1,
  slots: [{
    taskId: randomUUID(), itemId: randomUUID(), itemRevisionId: randomUUID(), ordinal: 0,
    exerciseType: "reading", direction: null, assessed: true,
    prompt: { kind: "reading", text: "cat", options: [{ id: randomUUID(), text: "kot" }] },
    answerKey: { target: "cat" }, reason: "new-material", revealsTargetKeys: [], keepsReservations: [],
  }],
  ...overrides,
});

describe("prywatny plan treningu", () => {
  it("odczytuje wyłącznie kompletny, uporządkowany plan wersji 1", () => {
    expect(readTrainingSessionPlan(plan())?.slots).toHaveLength(1);
    expect(() => readTrainingSessionPlan(plan({ version: 2 }))).toThrow("unsupported_training_session_plan_version");
    expect(() => readTrainingSessionPlan(plan({ taskBudget: 0 }))).toThrow("invalid_training_session_plan");
    expect(() => readTrainingSessionPlan(plan({ taskBudget: 1, slots: [{ ...plan().slots[0], assessed: false }] }))).not.toThrow();
    expect(() => readTrainingSessionPlan(plan({ taskBudget: 1, slots: [{ ...plan().slots[0], assessed: true }, { ...plan().slots[0], taskId: randomUUID(), ordinal: 1, assessed: true }] }))).toThrow("invalid_training_session_plan");
    expect(() => readTrainingSessionPlan(plan({ slots: [{ ...plan().slots[0], ordinal: 1 }] }))).toThrow("invalid_training_session_plan");
  });
});

describe("prywatny plan treningu lekcji — sufiks historyjki", () => {
  type Kind = "card" | "support_card" | "exercise" | "story" | "story_question";
  const itemId = randomUUID();
  const revisionId = randomUUID();
  const sentences = ["Sam has a red bike.", "He rides it to school."];
  const options = () => [0, 1, 2].map((i) => ({ id: randomUUID(), text: `opcja ${i}` }));
  const slot = (ordinal: number, taskKind: Kind, overrides: Record<string, unknown> = {}) => {
    const base = {
      taskId: randomUUID(), itemId, itemRevisionId: revisionId, ordinal, direction: null, answerKey: {},
      reason: "lesson", context: {}, revealsTargetKeys: [], taskKind,
    };
    if (taskKind === "story") {
      return { ...base, exerciseType: "lesson_story", assessed: false, prompt: { kind: "lesson_story", story: { sentences } }, ...overrides };
    }
    if (taskKind === "story_question") {
      return {
        ...base, exerciseType: "lesson_story_question", assessed: false,
        prompt: { kind: "lesson_story_question", question: "Kto ma rower?", options: options(), story: { sentences } }, ...overrides,
      };
    }
    if (taskKind === "card" || taskKind === "support_card") {
      return {
        ...base, exerciseType: "lesson_card", assessed: false,
        prompt: { kind: "lesson_card", card: { title: "Czas", body: "She reads.", examples: [] } }, ...overrides,
      };
    }
    return {
      ...base, exerciseType: "lesson_short_answer", assessed: true,
      prompt: { kind: "lesson_short_answer", question: "Pytanie?", options: options() }, ...overrides,
    };
  };
  const lessonPlan = (kinds: Kind[], overrides: Record<string, unknown> = {}) => ({
    version: 1, kind: "lesson", taskBudget: 2, slots: kinds.map((kind, ordinal) => slot(ordinal, kind)), ...overrides,
  });

  it("reads a plan with story slots and does not count them against the assessed budget", () => {
    const parsed = readLessonTrainingSessionPlan(lessonPlan(["card", "exercise", "exercise", "story", "story_question", "story_question"]));
    expect(parsed?.slots.map((s) => s.taskKind)).toEqual(["card", "exercise", "exercise", "story", "story_question", "story_question"]);
    expect(() => readLessonTrainingSessionPlan(lessonPlan(["exercise", "exercise", "story", "story_question"]))).not.toThrow();
    expect(() => readLessonTrainingSessionPlan(lessonPlan(["exercise", "story"]))).not.toThrow();
  });

  it("still reads a plan without a story", () => {
    expect(() => readLessonTrainingSessionPlan(lessonPlan(["card", "exercise", "exercise"]))).not.toThrow();
  });

  it.each<[string, Record<string, unknown>]>([
    ["a story slot flagged assessed", lessonPlan(["exercise", "story"], {
      slots: [slot(0, "exercise"), slot(1, "story", { assessed: true })],
    })],
    ["an exercise slot after the story block", lessonPlan(["exercise", "story", "exercise"])],
    ["a card slot after the story block", lessonPlan(["exercise", "story", "card"])],
    ["two story slots", lessonPlan(["exercise", "story", "story"])],
    ["a question before the story", lessonPlan(["exercise", "story_question", "story"])],
    ["a question without a story", lessonPlan(["exercise", "story_question"])],
    ["story taskKind with a question exercise type", lessonPlan(["exercise", "story"], {
      slots: [slot(0, "exercise"), slot(1, "story", { exerciseType: "lesson_story_question" })],
    })],
    ["story_question taskKind with a story exercise type", lessonPlan(["exercise", "story", "story_question"], {
      slots: [slot(0, "exercise"), slot(1, "story"), slot(2, "story_question", { exerciseType: "lesson_story" })],
    })],
    ["a story slot with a question prompt", lessonPlan(["exercise", "story", "story_question"], {
      slots: [slot(0, "exercise"), slot(1, "story", { prompt: slot(2, "story_question").prompt }), slot(2, "story_question")],
    })],
    ["a question slot with a story prompt", lessonPlan(["exercise", "story", "story_question"], {
      slots: [slot(0, "exercise"), slot(1, "story"), slot(2, "story_question", { prompt: slot(1, "story").prompt })],
    })],
    ["an exercise slot with a story prompt", lessonPlan(["exercise", "exercise"], {
      slots: [slot(0, "exercise"), slot(1, "exercise", { prompt: slot(1, "story").prompt })],
    })],
  ])("rejects %s", (_name, value) => {
    expect(() => readLessonTrainingSessionPlan(value)).toThrow("invalid_training_session_plan");
  });
});
