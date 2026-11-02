import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TaskPrompt } from "@learning/contracts";
import { lessonTextTargetKey } from "../../../domain/lessons/exposure-key";
import type { LessonStory } from "../../../domain/lessons/story";
import { readLessonTrainingSessionPlan, type LessonTrainingSessionSlot } from "../../../domain/training-session-plan";
import { seededShuffle } from "./lesson-materialize";
import { lessonStorySlots, planHasClosingStory } from "./lesson-story-tasks";

/**
 * Sloty historyjki na końcu planu sesji lekcji (design „Historyjka lekcji” §8.2):
 * czysta budowa slotów historyjki i pytań z zatwierdzonej wersji — publiczny
 * prompt bez klucza, świeże id opcji, klucze ekspozycji zdań i kolejne ordinale.
 */

/** Przedmiot testowy (silnik lekcji nie zna przedmiotów z katalogu). */
const SUBJECT = { id: "story_subject", answerLocale: "en-GB" };
const SUBJECT_WITHOUT_LOCALE = { id: "story_subject", answerLocale: "de-DE" };

/** Id z wersji materiału są rozpoznawalne, żeby wykryć ich wyciek do promptu. */
const STORY: LessonStory = {
  sentences: ["  Sam has   a red bike. ", "He rides it to school.", "His sister walks.", "They meet at the park."],
  questions: [
    {
      id: "src-question-1",
      question: "Jaki rower ma Sam?",
      options: [
        { id: "src-option-1a", text: "niebieski" },
        { id: "src-option-1b", text: "czerwony" },
        { id: "src-option-1c", text: "zielony" },
      ],
      correctOption: "src-option-1b",
    },
    {
      id: "src-question-2",
      question: "Gdzie się spotykają?",
      options: [
        { id: "src-option-2a", text: "w parku" },
        { id: "src-option-2b", text: "w szkole" },
        { id: "src-option-2c", text: "w domu" },
      ],
      correctOption: "src-option-2a",
    },
  ],
};
const SQUASHED = ["Sam has a red bike.", "He rides it to school.", "His sister walks.", "They meet at the park."];
const SOURCE_IDS = ["src-question-1", "src-question-2", ...STORY.questions.flatMap((q) => q.options.map((o) => o.id))];

const ANCHOR = { itemId: randomUUID(), revisionId: randomUUID() };
const AUDIO = randomUUID();
const TASK_IDS = [randomUUID(), randomUUID(), randomUUID()];

function build(overrides: Partial<Parameters<typeof lessonStorySlots>[0]> = {}): LessonTrainingSessionSlot[] {
  let next = 0;
  return lessonStorySlots({
    story: STORY,
    subject: SUBJECT,
    anchor: ANCHOR,
    audioAssetId: AUDIO,
    firstOrdinal: 0,
    newTaskId: () => TASK_IDS[next++]!,
    shuffleSeed: (taskId) => `seed:${taskId}`,
    ...overrides,
  });
}

type QuestionPrompt = Extract<TaskPrompt, { kind: "lesson_story_question" }>;

describe("lessonStorySlots", () => {
  it("story slot shows squashed sentences, story audio and the answer locale", () => {
    const [story] = build();
    expect(story).toMatchObject({
      taskId: TASK_IDS[0], itemId: ANCHOR.itemId, itemRevisionId: ANCHOR.revisionId, ordinal: 0,
      exerciseType: "lesson_story", taskKind: "story", reason: "closing_story", assessed: false, direction: null,
      answerKey: { exerciseType: "lesson_story", subjectId: SUBJECT.id },
      context: { reason: "closing_story" },
    });
    expect(story!.prompt).toEqual({ kind: "lesson_story", story: { sentences: SQUASHED }, contentLocale: "en-GB", questionAudioAssetId: AUDIO });
  });

  it("story without audio has no questionAudioAssetId", () => {
    const slots = build({ audioAssetId: null });
    for (const slot of slots) expect(slot.prompt).not.toHaveProperty("questionAudioAssetId");
    // Język spoza kontraktu Kid DTO: brak pola zamiast błędu planu.
    for (const slot of build({ subject: SUBJECT_WITHOUT_LOCALE })) expect(slot.prompt).not.toHaveProperty("contentLocale");
  });

  it("question slots follow the story in story order with three fresh option ids", () => {
    const [, first, second] = build();
    expect([first!.taskId, second!.taskId]).toEqual([TASK_IDS[1], TASK_IDS[2]]);
    for (const [index, slot] of [first!, second!].entries()) {
      const source = STORY.questions[index]!;
      const prompt = slot.prompt as QuestionPrompt;
      expect(slot).toMatchObject({
        exerciseType: "lesson_story_question", taskKind: "story_question", reason: "closing_story", assessed: false,
        itemId: ANCHOR.itemId, itemRevisionId: ANCHOR.revisionId,
        context: { reason: "closing_story", storyQuestionId: source.id },
      });
      expect(prompt).toMatchObject({
        kind: "lesson_story_question", question: source.question, story: { sentences: SQUASHED },
        contentLocale: "en-GB", questionAudioAssetId: AUDIO,
      });
      expect(prompt.options).toHaveLength(3);
      const ids = prompt.options.map((option) => option.id);
      expect(new Set(ids).size).toBe(3);
      for (const id of ids) {
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
        expect(SOURCE_IDS).not.toContain(id);
      }
      // Kolejność z ziarna planu (nie z samego `taskId`), zamrożona przy budowie.
      const expectedOrder = seededShuffle(source.options.map((option) => option.text), `seed:${slot.taskId}`);
      expect(prompt.options.map((option) => option.text)).toEqual(expectedOrder);
      const key = slot.answerKey as { exerciseType: string; subjectId: string; storyQuestionId: string; correctOptionId: string; optionValues: Record<string, string> };
      expect(key).toMatchObject({ exerciseType: "lesson_story_question", subjectId: SUBJECT.id, storyQuestionId: source.id });
      const correctText = source.options.find((option) => option.id === source.correctOption)!.text;
      expect(prompt.options.find((option) => option.id === key.correctOptionId)?.text).toBe(correctText);
      expect(key.optionValues).toEqual(Object.fromEntries(prompt.options.map((option) => [option.id, option.text])));
    }
  });

  it("public prompts carry no answer key", () => {
    for (const slot of build()) {
      const json = JSON.stringify(slot.prompt);
      expect(json).not.toContain("correctOption");
      expect(json).not.toContain("storyQuestionId");
      expect(json).not.toContain("targetKey");
      for (const id of SOURCE_IDS) expect(json).not.toContain(id);
    }
  });

  it("story and question slots reveal sentence keys only", () => {
    const sentenceKeys = SQUASHED.map((sentence) => lessonTextTargetKey(SUBJECT, sentence));
    const otherKeys = [
      ...STORY.questions.map((q) => lessonTextTargetKey(SUBJECT, q.question)),
      ...STORY.questions.flatMap((q) => q.options.map((o) => lessonTextTargetKey(SUBJECT, o.text))),
    ];
    for (const slot of build()) {
      expect(slot.revealsTargetKeys).toEqual(sentenceKeys);
      for (const key of otherKeys) expect(slot.revealsTargetKeys).not.toContain(key);
    }
    // Powtórzone zdanie daje jeden klucz.
    const repeated = build({ story: { ...STORY, sentences: [...STORY.sentences, "His  sister walks."] } });
    expect(repeated[0]!.revealsTargetKeys).toEqual(sentenceKeys);
  });

  it("slots are non-assessed and do not change ordinals of previous slots", () => {
    const previous = previousSlots();
    const before = structuredClone(previous);
    const slots = build({ firstOrdinal: previous.length });
    expect(previous).toEqual(before);
    expect(slots.map((slot) => slot.ordinal)).toEqual([2, 3, 4]);
    expect(slots.every((slot) => !slot.assessed)).toBe(true);
    expect(slots.map((slot) => slot.taskKind)).toEqual(["story", "story_question", "story_question"]);
  });

  it("each slot parses with readLessonTrainingSessionPlan", () => {
    const previous = previousSlots();
    const plan = { version: 1 as const, kind: "lesson" as const, taskBudget: 1, slots: [...previous, ...build({ firstOrdinal: previous.length })] };
    const read = readLessonTrainingSessionPlan(plan);
    expect(read?.slots.map((slot) => slot.taskKind)).toEqual(["card", "exercise", "story", "story_question", "story_question"]);
    expect(planHasClosingStory(read)).toBe(true);
    expect(planHasClosingStory({ ...plan, slots: previous })).toBe(false);
    expect(planHasClosingStory(null)).toBe(false);
  });
});

/** Karta i jedno oceniane ćwiczenie przed historyjką. */
function previousSlots(): LessonTrainingSessionSlot[] {
  const common = { itemId: ANCHOR.itemId, itemRevisionId: ANCHOR.revisionId, direction: null, answerKey: {}, revealsTargetKeys: [] };
  return [
    {
      ...common, taskId: randomUUID(), ordinal: 0, exerciseType: "lesson_card", assessed: false, reason: "introduce", taskKind: "card",
      prompt: { kind: "lesson_card", card: { title: "Czas", body: "She reads.", examples: [] } }, context: { objectiveId: "objective" },
    },
    {
      ...common, taskId: randomUUID(), ordinal: 1, exerciseType: "lesson_choice", assessed: true, reason: "practice", taskKind: "exercise",
      prompt: { kind: "lesson_choice", instructionPl: "Wybierz.", stem: "She ___.", options: [{ id: randomUUID(), text: "reads" }, { id: randomUUID(), text: "read" }] },
      context: { objectiveId: "objective" },
    },
  ];
}
