import { describe, expect, it } from "vitest";
import { NON_ASSESSED_LESSON_TASK_TYPES, isNonAssessedLessonTaskType } from "./session-task-types";

describe("typy zadań lekcji poza oceną", () => {
  it.each(["lesson_card", "lesson_story", "lesson_story_question"])("%s jest nieoceniane", (type) => {
    expect(isNonAssessedLessonTaskType(type)).toBe(true);
  });

  it.each(["lesson_choice", "exposure", "lesson_shorten"])("%s jest oceniane", (type) => {
    expect(isNonAssessedLessonTaskType(type)).toBe(false);
  });

  it("lista ma dokładnie trzy wartości", () => {
    expect([...NON_ASSESSED_LESSON_TASK_TYPES].sort()).toEqual(["lesson_card", "lesson_story", "lesson_story_question"]);
  });
});
