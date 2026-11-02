import { describe, expect, it } from "vitest";
import { isStoryRunInput, storyFromGenerated } from "./lesson-story-generation";

describe("storyFromGenerated", () => {
  it("mapuje pytania na q1/q2, opcje na a/b/c i poprawną opcję z indeksu", () => {
    const story = storyFromGenerated({
      sentences: [" Sam has a cat. ", "The cat is small."],
      questions: [
        { question: "Kto ma kota?", options: ["Sam", "Tom", "Ann"], correctOptionIndex: 0 },
        { question: "Jaki jest kot?", options: ["duży", "mały", "zły"], correctOptionIndex: 1 },
      ],
    });
    expect(story).toEqual({
      sentences: ["Sam has a cat.", "The cat is small."],
      questions: [
        {
          id: "q1",
          question: "Kto ma kota?",
          options: [{ id: "a", text: "Sam" }, { id: "b", text: "Tom" }, { id: "c", text: "Ann" }],
          correctOption: "a",
        },
        {
          id: "q2",
          question: "Jaki jest kot?",
          options: [{ id: "a", text: "duży" }, { id: "b", text: "mały" }, { id: "c", text: "zły" }],
          correctOption: "b",
        },
      ],
    });
  });

  it.each([
    ["indeks poza zakresem", { sentences: ["A."], questions: [{ question: "?", options: ["x", "y", "z"], correctOptionIndex: 3 }] }],
    ["indeks ujemny", { sentences: ["A."], questions: [{ question: "?", options: ["x", "y", "z"], correctOptionIndex: -1 }] }],
    ["indeks ułamkowy", { sentences: ["A."], questions: [{ question: "?", options: ["x", "y", "z"], correctOptionIndex: 0.5 }] }],
    ["brak pytań w kształcie", { sentences: ["A."] }],
    ["zdanie nie jest tekstem", { sentences: [1], questions: [] }],
    ["null", null],
  ])("zwraca null: %s", (_label, raw) => {
    expect(storyFromGenerated(raw)).toBeNull();
  });
});

describe("isStoryRunInput", () => {
  it("rozpoznaje wyłącznie purpose='story'", () => {
    expect(isStoryRunInput({ purpose: "story" })).toBe(true);
    expect(isStoryRunInput({ purpose: "lesson" })).toBe(false);
    expect(isStoryRunInput({ regenerate: {} })).toBe(false);
    expect(isStoryRunInput(null)).toBe(false);
  });
});
