import { describe, expect, it } from "vitest";
import type { LessonStoryDto } from "@learning/contracts";
import {
  addQuestion,
  addSentence,
  emptyStory,
  removeQuestion,
  removeSentence,
  setCorrectOption,
  setOptionText,
  setQuestionText,
  setSentence,
  storyEquals,
  storyAudioView,
  storySentencesUnchanged,
} from "./lesson-story-form";

const story = (): LessonStoryDto => ({
  sentences: ["Sam has a red bike.", "He rides it to the park.", "The bike is fast.", "Sam is happy."],
  questions: [{
    id: "q1",
    question: "Jaki rower ma Sam?",
    options: [{ id: "a", text: "czerwony" }, { id: "b", text: "niebieski" }, { id: "c", text: "zielony" }],
    correctOption: "a",
  }],
});

describe("lesson-story-form", () => {
  it("emptyStory: 4 puste zdania i pytanie q1 z pustymi opcjami a/b/c, poprawna a", () => {
    expect(emptyStory()).toEqual({
      sentences: ["", "", "", ""],
      questions: [{
        id: "q1",
        question: "",
        options: [{ id: "a", text: "" }, { id: "b", text: "" }, { id: "c", text: "" }],
        correctOption: "a",
      }],
    });
  });

  it("addSentence stops at 6", () => {
    let current = story();
    current = addSentence(current);
    current = addSentence(current);
    expect(current.sentences).toHaveLength(6);
    expect(current.sentences[5]).toBe("");
    expect(addSentence(current)).toBe(current);
  });

  it("removeSentence usuwa wskazane zdanie, ale zostawia co najmniej jedno", () => {
    expect(removeSentence(story(), 1).sentences).toEqual(["Sam has a red bike.", "The bike is fast.", "Sam is happy."]);
    const single = { ...story(), sentences: ["Jedno."] };
    expect(removeSentence(single, 0)).toBe(single);
  });

  it("addQuestion creates q2 and stops at 2", () => {
    const two = addQuestion(story());
    expect(two.questions.map((q) => q.id)).toEqual(["q1", "q2"]);
    expect(two.questions[1]).toEqual({
      id: "q2",
      question: "",
      options: [{ id: "a", text: "" }, { id: "b", text: "" }, { id: "c", text: "" }],
      correctOption: "a",
    });
    expect(addQuestion(two)).toBe(two);
    // po usunięciu q1 nowy identyfikator nie koliduje z q2
    expect(addQuestion(removeQuestion(two, "q1")).questions.map((q) => q.id)).toEqual(["q2", "q1"]);
  });

  it("removeQuestion zostawia co najmniej jedno pytanie", () => {
    const one = story();
    expect(removeQuestion(one, "q1")).toBe(one);
    expect(removeQuestion(addQuestion(one), "q2").questions.map((q) => q.id)).toEqual(["q1"]);
  });

  it("setSentence, setQuestionText i setOptionText zmieniają tylko wskazane pole (bez mutacji wejścia)", () => {
    const base = story();
    const next = setOptionText(setQuestionText(setSentence(base, 0, "Sam has a big red bike."), "q1", "Jaki jest rower?"), "q1", "b", "granatowy");
    expect(next.sentences[0]).toBe("Sam has a big red bike.");
    expect(next.sentences.slice(1)).toEqual(base.sentences.slice(1));
    expect(next.questions[0]!.question).toBe("Jaki jest rower?");
    expect(next.questions[0]!.options.map((o) => o.text)).toEqual(["czerwony", "granatowy", "zielony"]);
    expect(base).toEqual(story());
  });

  it("setCorrectOption sets id", () => {
    expect(setCorrectOption(story(), "q1", "c").questions[0]!.correctOption).toBe("c");
  });

  it("storyEquals compares deeply and treats null/undefined equal", () => {
    expect(storyEquals(story(), story())).toBe(true);
    expect(storyEquals(null, undefined)).toBe(true);
    expect(storyEquals(undefined, undefined)).toBe(true);
    expect(storyEquals(null, story())).toBe(false);
    expect(storyEquals(story(), undefined)).toBe(false);
    expect(storyEquals(story(), setSentence(story(), 3, "Sam is sad."))).toBe(false);
    expect(storyEquals(story(), setCorrectOption(story(), "q1", "b"))).toBe(false);
    expect(storyEquals(story(), setOptionText(story(), "q1", "c", "żółty"))).toBe(false);
    expect(storyEquals(story(), addQuestion(story()))).toBe(false);
    expect(storyEquals(story(), addSentence(story()))).toBe(false);
  });
});

describe("storySentencesUnchanged", () => {
  it("is true when there is no form (undefined)", () => {
    expect(storySentencesUnchanged(story(), undefined)).toBe(true);
    expect(storySentencesUnchanged(undefined, undefined)).toBe(true);
  });

  it("is true when only a question changes", () => {
    expect(storySentencesUnchanged(story(), setQuestionText(story(), "q1", "Inne pytanie?"))).toBe(true);
  });

  it("is true when only whitespace in a sentence changes", () => {
    expect(storySentencesUnchanged(story(), setSentence(story(), 0, "  Sam   has a	red bike. "))).toBe(true);
  });

  it("is false when a sentence changes", () => {
    expect(storySentencesUnchanged(story(), setSentence(story(), 1, "He walks to the park."))).toBe(false);
  });

  it("is false when the number of sentences changes", () => {
    expect(storySentencesUnchanged(story(), addSentence(story()))).toBe(false);
    expect(storySentencesUnchanged(story(), removeSentence(story(), 3))).toBe(false);
  });

  it("is false for null when a story is saved", () => {
    expect(storySentencesUnchanged(story(), null)).toBe(false);
    expect(storySentencesUnchanged(undefined, null)).toBe(true);
  });
});

describe("storyAudioView", () => {
  const ready = { state: "ready", assetId: "00000000-0000-4000-8000-000000000001" } as const;
  const failed = { state: "failed" } as const;
  const base = { editable: true, saved: story(), form: story() as LessonStoryDto | null | undefined, storyGenerating: false, audio: ready };

  it("published view shows the recording; the hint only when failed", () => {
    const published = { ...base, editable: false, form: undefined };
    expect(storyAudioView(published)).toEqual({ show: true, publishedFailedHint: false });
    expect(storyAudioView({ ...published, audio: { state: "pending" } })).toEqual({ show: true, publishedFailedHint: false });
    expect(storyAudioView({ ...published, audio: failed })).toEqual({ show: true, publishedFailedHint: true });
  });

  it("published view ignores a running story run", () => {
    expect(storyAudioView({ ...base, editable: false, form: undefined, storyGenerating: true }).show).toBe(true);
  });

  it("draft is hidden while the story run is queued or running", () => {
    expect(storyAudioView({ ...base, storyGenerating: true })).toEqual({ show: false, publishedFailedHint: false });
  });

  it("draft is hidden when a sentence changed", () => {
    expect(storyAudioView({ ...base, form: setSentence(story(), 0, "Sam has a blue bike.") }).show).toBe(false);
    expect(storyAudioView({ ...base, form: null }).show).toBe(false);
  });

  it("draft is shown on a question-only change and with an untouched form", () => {
    expect(storyAudioView({ ...base, form: setQuestionText(story(), "q1", "Inne?") }).show).toBe(true);
    expect(storyAudioView({ ...base, form: undefined }).show).toBe(true);
  });

  it("draft never shows the published hint, even when the recording failed", () => {
    expect(storyAudioView({ ...base, audio: failed })).toEqual({ show: true, publishedFailedHint: false });
  });

  it("nothing is shown without a recording", () => {
    expect(storyAudioView({ ...base, audio: undefined })).toEqual({ show: false, publishedFailedHint: false });
    expect(storyAudioView({ ...base, editable: false, form: undefined, audio: undefined })).toEqual({ show: false, publishedFailedHint: false });
  });
});
