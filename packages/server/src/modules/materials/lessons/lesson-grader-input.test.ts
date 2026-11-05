import { describe, expect, it } from "vitest";
import { schoolSubject } from "../../../domain/lessons/subjects/school/module";
import type { LessonTopic, SchoolCriteria } from "../../../domain/lessons/types";
import { lessonCategoryLabels, lessonGraderInput, lessonInstructionOf, schoolCriteriaOf } from "./lesson-grader-input";

const topic: LessonTopic = {
  id: "t",
  version: 1,
  titlePl: "Rzeki Polski",
  extraErrorCategories: [{ code: "topic_only", labelPl: "Tylko temat" }],
  transforms: [{ id: "t1", instructionPl: "Zamień zdanie." }],
  objectives: [
    { id: "o1", titlePl: "Odra", descriptionEn: "The Oder river.", cards: [], errorCategories: ["topic_only"], hints: {}, exerciseTypes: ["lesson_open_answer"] },
  ],
};

const base = { exerciseType: "lesson_open_answer" as const, objectiveId: "o1" };

const criteria: SchoolCriteria = {
  requiredElements: [{ id: "e1", text: "Odra" }],
  supplementaryElements: ["Wisła"],
  commonErrors: ["Odra płynie do Morza Czarnego."],
  sourceQuotes: ["Q"],
};

const args = {
  subject: schoolSubject,
  topic,
  objective: { descriptionEn: "The Oder river.", errorCategories: ["topic_only"] },
  instruction: "Odpowiedz.",
  stimulus: "Która rzeka płynie przez Wrocław?",
  answer: "Odra",
  acceptedAnswers: ["rzeka Odra"],
  schoolCriteria: undefined as SchoolCriteria | undefined,
  answerText: "Odra",
};

describe("lessonInstructionOf", () => {
  it("instruction falls back to transform, then objective title, then empty", () => {
    expect(lessonInstructionOf(topic, { ...base, instructionPl: "Napisz" })).toBe("Napisz");
    expect(lessonInstructionOf(topic, { ...base, exerciseType: "lesson_transform", transformId: "t1" })).toBe(topic.transforms[0]!.instructionPl);
    expect(lessonInstructionOf(topic, base)).toBe(topic.objectives[0]!.titlePl);
    expect(lessonInstructionOf(topic, { ...base, objectiveId: "missing" })).toBe("");
  });

  it("ignores transformId for other exercise types", () => {
    expect(lessonInstructionOf(topic, { ...base, transformId: "t1" })).toBe(topic.objectives[0]!.titlePl);
  });
});

describe("schoolCriteriaOf", () => {
  it("maps fields and returns undefined without required elements", () => {
    expect(schoolCriteriaOf({ ...base, requiredElements: [] })).toBeUndefined();
    expect(schoolCriteriaOf(base)).toBeUndefined();
    expect(schoolCriteriaOf({ ...base, requiredElements: [{ id: "e1", text: "Odra" }], sourceRefs: [{ quote: "Q" }] })).toEqual({
      requiredElements: [{ id: "e1", text: "Odra" }],
      supplementaryElements: [],
      commonErrors: [],
      sourceQuotes: ["Q"],
    });
  });

  it("keeps expectedForm only when present", () => {
    const withForm = schoolCriteriaOf({ ...base, requiredElements: [{ id: "e1", text: "Odra" }], expectedForm: "one_sentence" });
    expect(withForm?.expectedForm).toBe("one_sentence");
  });
});

describe("lessonCategoryLabels", () => {
  it("merges base, subject and topic categories", () => {
    const labels = lessonCategoryLabels(schoolSubject, topic);
    expect(labels.get("topic_only")).toBe("Tylko temat");
    for (const category of schoolSubject.errorCategories) expect(labels.get(category.code)).toBe(category.labelPl);
  });
});

describe("lessonGraderInput", () => {
  it("builds the school path with defaults and 600-char cut", () => {
    const input = lessonGraderInput({ ...args, stimulus: "", schoolCriteria: criteria, answerText: "x".repeat(700) });
    expect(input.school?.question).toBe(""); // stimulus ?? instruction: "" is not nullish
    expect(input.school?.expectedForm).toBe("explanation");
    expect(input.school?.modelAnswer).toBe("Odra");
    expect(input.school?.commonErrors).toEqual(["Odra płynie do Morza Czarnego."]);
    expect(input.childAnswer).toHaveLength(600);
    expect(input.acceptedAnswers).toEqual([args.answer, ...args.acceptedAnswers]);
    expect(input.subjectTitle).toBe(schoolSubject.titlePl);
    expect(input.topicTitle).toBe(topic.titlePl);
    expect(input.objective).toEqual({ description: "The Oder river.", errorCategories: [{ code: "topic_only", label: "Tylko temat" }] });
  });

  it("question falls back to the instruction when the stimulus is null", () => {
    const input = lessonGraderInput({ ...args, stimulus: null, schoolCriteria: criteria });
    expect(input.school?.question).toBe(args.instruction);
  });

  it("without criteria cuts to 200 and has no school block", () => {
    const input = lessonGraderInput({ ...args, schoolCriteria: undefined, answerText: "x".repeat(300) });
    expect(input.school).toBeUndefined();
    expect(input.childAnswer).toHaveLength(200);
  });
});
