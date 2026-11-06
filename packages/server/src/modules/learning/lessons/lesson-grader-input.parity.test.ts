import { describe, expect, it } from "vitest";
import type { Services } from "../../../config";
import { schoolSubject } from "../../../domain/lessons/subjects/school/module";
import type { LessonExerciseDraft } from "../../../domain/lessons/types";
import { lessonGraderInput, lessonInstructionOf, schoolCriteriaOf } from "../../materials";
import { buildGraderInput } from "./lesson-attempts";
import { materializeExercise, type LoadedExercise } from "./lesson-materialize";

/**
 * Zgodność wejścia gradera: dziecko (zadanie zmaterializowane + `buildGraderInput`)
 * i kontrola agenta (pola szkicu + `lessonGraderInput`) muszą dać to samo wejście.
 */

const topic = schoolSubject.buildDynamicTopic!({
  titlePl: "Rzeki Polski",
  objectives: [
    {
      id: "school.ddeck.odra",
      titlePl: "Odra",
      descriptionEn: "The Oder river.",
      cards: [{ title: "Odra", body: "Odra płynie przez Wrocław." }, { title: "Dopływy", body: "Warta jest dopływem Odry." }],
    },
  ],
});

const services = { subjects: { getSubject: (id: string) => (id === schoolSubject.id ? schoolSubject : undefined) } } as unknown as Services;

function draftOf(extra: Partial<LessonExerciseDraft>): LessonExerciseDraft {
  return {
    exerciseType: "lesson_open_answer",
    objectiveId: "school.ddeck.odra",
    prompt: "Która rzeka płynie przez Wrocław?",
    answer: "Odra płynie przez Wrocław.",
    acceptedAnswers: ["Przez Wrocław płynie Odra."],
    focus: ["Odra"],
    questionType: "fact",
    requiredElements: [{ id: "e1", text: "wskazuje Odrę" }],
    supplementaryElements: ["Wrocław"],
    sourceRefs: [{ quote: "Odra płynie przez Wrocław." }],
    ...extra,
  };
}

function childInput(draft: LessonExerciseDraft, childAnswer: string) {
  const exercise: LoadedExercise = {
    revisionId: "rev-1",
    itemId: "item-1",
    position: 0,
    targetKey: "tk-1",
    audioAssetId: null,
    payload: {
      ...draft,
      answer: draft.answer,
      acceptedAnswers: [...draft.acceptedAnswers],
      focus: [...draft.focus],
      requiredElements: draft.requiredElements?.map((el) => ({ ...el })),
      supplementaryElements: draft.supplementaryElements ? [...draft.supplementaryElements] : undefined,
      sourceRefs: draft.sourceRefs?.map((ref) => ({ ...ref })),
      noticeSegments: undefined,
      options: undefined,
      items: undefined,
      answerLocale: schoolSubject.answerLocale,
      promptLocale: schoolSubject.promptLocale,
    } as LoadedExercise["payload"],
  };
  const task = materializeExercise({ independentCheck: true, reason: "independent_check" }, "task-1", exercise, topic, schoolSubject, { shuffleSeed: "seed" });
  type Args = Parameters<typeof buildGraderInput>;
  return buildGraderInput(services, { publicPrompt: task.prompt } as unknown as Args[1], task.answerKey as unknown as Args[2], childAnswer);
}

function agentInput(draft: LessonExerciseDraft, answerText: string) {
  return lessonGraderInput({
    subject: schoolSubject,
    topic,
    objective: topic.objectives.find((o) => o.id === draft.objectiveId)!,
    instruction: lessonInstructionOf(topic, draft),
    stimulus: draft.prompt ?? "",
    answer: draft.answer,
    acceptedAnswers: draft.acceptedAnswers,
    schoolCriteria: schoolCriteriaOf(draft),
    answerText,
  });
}

describe("zgodność wejścia gradera: dziecko i kontrola agenta", () => {
  it("z instructionPl", () => {
    const draft = draftOf({ instructionPl: "Odpowiedz jednym zdaniem." });
    expect(agentInput(draft, "Odra.")).toEqual(childInput(draft, "Odra."));
  });

  it("bez instructionPl (tytuł celu)", () => {
    const draft = draftOf({});
    expect(lessonInstructionOf(topic, draft)).toBe("Odra");
    expect(agentInput(draft, "Odra.")).toEqual(childInput(draft, "Odra."));
  });

  it("z typowymi błędami i oczekiwaną formą", () => {
    const draft = draftOf({ instructionPl: "Odpowiedz.", commonErrors: ["Przez Wrocław płynie Wisła."], expectedForm: "one_sentence" });
    expect(agentInput(draft, "Odra.")).toEqual(childInput(draft, "Odra."));
  });

  it("przycina odpowiedź do 600 znaków", () => {
    const draft = draftOf({ instructionPl: "Odpowiedz." });
    const long = "x".repeat(700);
    expect(agentInput(draft, long)).toEqual(childInput(draft, long));
    expect(agentInput(draft, long).childAnswer).toHaveLength(600);
  });
});
