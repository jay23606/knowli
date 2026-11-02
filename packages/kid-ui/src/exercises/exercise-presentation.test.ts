import { describe, expect, it } from "vitest";
import { getExercisePresentation } from "./exercise-presentation";
import type { TaskDto } from "@learning/contracts";

const task = (kind: TaskDto["prompt"]["kind"]): TaskDto => ({
  taskId: "10000000-0000-4000-8000-000000000004",
  sessionId: "10000000-0000-4000-8000-000000000003",
  ordinal: 0,
  exerciseType: kind as TaskDto["exerciseType"],
  direction: null,
  state: "issued",
  remainingAssessed: 1,
  prompt: kind === "exposure"
    ? { kind, source: "kot", target: "cat", example: null, audioAssetId: null, exampleAudioAssetId: null, imageAssetId: null, visualType: "none" }
    : kind === "listening"
      ? { kind, audioAssetId: "10000000-0000-4000-8000-000000000006", options: [{ id: "10000000-0000-4000-8000-000000000007", text: "kot" }] }
      : kind === "reading"
        ? { kind, text: "cat", options: [{ id: "10000000-0000-4000-8000-000000000007", text: "kot" }] }
        : kind === "reverse_recognition"
          ? { kind, prompt: "kot", options: [{ id: "10000000-0000-4000-8000-000000000007", text: "cat" }] }
          : kind === "recall" || kind === "spelling"
            ? { kind, prompt: "kot" }
            : kind === "letter_completion"
              ? { kind, prompt: "kot", fragment: "c_t" }
              : { kind: "speech" as const, text: "cat", audioAssetId: null, imageAssetId: null, visualType: "none" as const },
});

describe("getExercisePresentation", () => {
  it.each([
    ["exposure", "Poznaj nowe słowo", "sparkles"],
    ["listening", "Posłuchaj i wybierz", "volume"],
    ["reading", "Wybierz znaczenie słowa", "book"],
    ["reverse_recognition", "Wybierz angielskie słowo", "ear"],
    ["recall", "Jak jest po angielsku?", "book"],
    ["spelling", "Napisz po angielsku", "pencil"],
    ["letter_completion", "Uzupełnij litery", "letters"],
    ["speech", "Powiedz na głos", "microphone"],
  ] as const)("maps %s to a fixed instruction without revealing the target", (kind, instruction, icon) => {
    const result = getExercisePresentation(task(kind));
    expect(result).toEqual({ instruction, icon });
    expect(result.instruction).not.toContain("cat");
  });
});

describe("getExercisePresentation — historyjka", () => {
  const base = {
    sessionId: "10000000-0000-4000-8000-000000000003",
    ordinal: 5,
    direction: null,
    state: "issued" as const,
    remainingAssessed: 0,
  };
  const story = { sentences: ["Sam has a red bike."] };

  it("tells the child to read and listen when the story has a recording", () => {
    const result = getExercisePresentation({
      ...base, taskId: "10000000-0000-4000-8000-000000000010", exerciseType: "lesson_story",
      prompt: { kind: "lesson_story", story, questionAudioAssetId: "10000000-0000-4000-8000-000000000011" },
    });
    expect(result).toEqual({ instruction: "Przeczytaj i posłuchaj historyjki.", icon: "book" });
  });

  it("tells the child only to read when there is no recording", () => {
    const result = getExercisePresentation({
      ...base, taskId: "10000000-0000-4000-8000-000000000010", exerciseType: "lesson_story",
      prompt: { kind: "lesson_story", story },
    });
    expect(result).toEqual({ instruction: "Przeczytaj historyjkę.", icon: "book" });
  });

  it("uses the question text as the instruction", () => {
    const result = getExercisePresentation({
      ...base, taskId: "10000000-0000-4000-8000-000000000012", exerciseType: "lesson_story_question",
      prompt: {
        kind: "lesson_story_question", question: "Kto ma rower?", story,
        options: ["a", "b", "c"].map((text, i) => ({ id: `10000000-0000-4000-8000-00000000002${i}`, text })),
      },
    });
    expect(result).toEqual({ instruction: "Kto ma rower?", icon: "book" });
  });
});
