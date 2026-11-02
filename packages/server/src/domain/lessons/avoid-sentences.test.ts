import { describe, expect, it } from "vitest";
import { AVOID_SENTENCES_MAX_CHARS, AVOID_SENTENCES_MAX_ITEMS, avoidSentencesFor } from "./avoid-sentences";
import { englishChapterSubject } from "./subjects/english-chapter/module";
import type { LessonExerciseDraft } from "./types";

const A = "english_chapter.ddeck.home";

function draft(overrides: Partial<LessonExerciseDraft>): LessonExerciseDraft {
  return { exerciseType: "lesson_open_answer", objectiveId: A, answer: "", acceptedAnswers: [], focus: [], ...overrides };
}

/** Luka rozdziału: tekst ekspozycji to zdanie ze wstawioną odpowiedzią. */
function gap(stem: string, answer: string): LessonExerciseDraft {
  return draft({ exerciseType: "lesson_gap", stem, answer, focus: [answer] });
}

function translation(answer: string): LessonExerciseDraft {
  return draft({ exerciseType: "lesson_open_answer", prompt: "Przetłumacz.", answer });
}

describe("avoidSentencesFor", () => {
  // Rozwiązania ćwiczeń idą w postaci ekspozycji przedmiotu (rozdział: bez końcowej interpunkcji); przykłady kart — jak zapisane.
  it("kolejność priorytetów: przykłady kart, potem niesamodzielne, potem samodzielne (najnowsze pierwsze)", () => {
    const result = avoidSentencesFor({
      examples: { [A]: ["I have the bed."], "english_chapter.ddeck.other": ["I have the lamp."] },
      exercises: [
        translation("We have the sofa."),
        gap("I see the ___.", "table"),
        translation("We have the chair."),
        gap("I see the ___.", "door"),
      ],
      subject: englishChapterSubject,
    });
    expect(result).toEqual([
      "I have the bed.",
      "I have the lamp.",
      "I see the door",
      "I see the table",
      "We have the chair",
      "We have the sofa",
    ]);
  });

  it("deduplikuje po równoważności odpowiedzi („Where's…” i „Where is…”), zachowując pierwsze wystąpienie", () => {
    const result = avoidSentencesFor({
      examples: { [A]: ["Where's the cat?"] },
      exercises: [translation("Where is the cat?"), translation("Where is the dog?")],
      subject: englishChapterSubject,
    });
    expect(result).toEqual(["Where's the cat?", "Where is the dog"]);
  });

  it("pomija puste teksty i kartę (bez rozwiązania)", () => {
    const result = avoidSentencesFor({
      examples: { [A]: ["  ", "I have the bed."] },
      exercises: [draft({ exerciseType: "lesson_card" }), translation("")],
      subject: englishChapterSubject,
    });
    expect(result).toEqual(["I have the bed."]);
  });

  it("limit liczby pozycji", () => {
    const examples = { [A]: Array.from({ length: AVOID_SENTENCES_MAX_ITEMS + 20 }, (_, i) => `Sentence number ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}.`) };
    const result = avoidSentencesFor({ examples, exercises: [], subject: englishChapterSubject });
    expect(result).toHaveLength(AVOID_SENTENCES_MAX_ITEMS);
    expect(result[0]).toBe(examples[A]![0]);
  });

  it("limit znaków łącznie: pozycja przekraczająca limit jest pomijana, krótsza za nią mieści się", () => {
    const long = `${"x".repeat(AVOID_SENTENCES_MAX_CHARS - 10)}`;
    const result = avoidSentencesFor({
      examples: { [A]: [long, "y".repeat(20), "Short one."] },
      exercises: [],
      subject: englishChapterSubject,
    });
    expect(result).toEqual([long, "Short one."]);
    expect(result.join("").length).toBeLessThanOrEqual(AVOID_SENTENCES_MAX_CHARS);
  });

  it("brak wejść → pusta lista", () => {
    expect(avoidSentencesFor({ examples: {}, exercises: [], subject: englishChapterSubject })).toEqual([]);
  });
});
