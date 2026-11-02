import { describe, expect, it } from "vitest";
import { computeTargetKey } from "../../../target-key";
import { lessonExerciseTargetKey, lessonTextTargetKey } from "../../exposure-key";
import type { LessonExerciseDraft } from "../../types";
import { chapterExposureText, normalizeChapterExposureText } from "./exposure";
import { englishChapterSubject } from "./module";

const OBJ = "english_chapter.ddeck.weather";

function draft(overrides: Partial<LessonExerciseDraft>): LessonExerciseDraft {
  return { exerciseType: "lesson_choice", objectiveId: OBJ, answer: "", acceptedAnswers: [], focus: [], ...overrides };
}

const sunnyChoice = draft({
  exerciseType: "lesson_choice",
  instructionPl: "Dziś jest słonecznie. Wybierz słowo.",
  stem: "It's ___ today.",
  options: [
    { id: "a", text: "raining" },
    { id: "b", text: "sunny" },
  ],
  correctOption: "b",
  answer: "sunny",
});

describe("chapterExposureText — ekspozycją jest rozwiązane zdanie", () => {
  it("wybór: zdanie z wstawioną poprawną opcją, bez końcowej interpunkcji", () => {
    expect(chapterExposureText(sunnyChoice)).toBe("It's sunny today");
    // Małe litery dokłada computeTargetKey: klucz = „it's sunny today”.
    expect(lessonExerciseTargetKey(englishChapterSubject, sunnyChoice)).toBe(computeTargetKey("it's sunny today", "en-GB"));
  });

  it("normalizuje białe znaki i końcową interpunkcję .!?…", () => {
    expect(chapterExposureText({ ...sunnyChoice, stem: "  It's   ___\ttoday !?…  " })).toBe("It's sunny today");
  });

  it("wybór bez poprawnej opcji wraca do odpowiedzi kanonicznej", () => {
    expect(chapterExposureText({ ...sunnyChoice, correctOption: "zz" })).toBe("It's sunny today");
    expect(chapterExposureText({ ...sunnyChoice, options: undefined, correctOption: undefined, answer: "sunny" })).toBe("It's sunny today");
  });

  it("wybór ze słuchu: jak wybór — zdanie z wstawioną poprawną opcją", () => {
    expect(chapterExposureText({ ...sunnyChoice, exerciseType: "lesson_listen_choice" })).toBe("It's sunny today");
  });

  it("luka: zdanie z wstawioną odpowiedzią", () => {
    const gap = draft({ exerciseType: "lesson_gap", stem: "I'm wearing a ___.", answer: "coat", focus: ["coat"] });
    expect(chapterExposureText(gap)).toBe("I'm wearing a coat");
  });

  it("zdanie bez znacznika luki daje samą odpowiedź (szkic i tak odrzuci walidacja)", () => {
    const gap = draft({ exerciseType: "lesson_gap", stem: "I'm wearing a coat.", answer: "coat" });
    expect(chapterExposureText(gap)).toBe("coat");
  });

  it("tekst z lukami: cały uzupełniony tekst", () => {
    const cloze = draft({
      exerciseType: "lesson_cloze",
      clozeText: "It's ___ today.  I'm wearing ___.",
      gapAnswers: ["sunny", "a T-shirt"],
      extraWords: ["boots"],
      answer: "sunny, a T-shirt",
    });
    expect(chapterExposureText(cloze)).toBe("It's sunny today. I'm wearing a T-shirt");
  });

  it("układanka i tłumaczenie: odpowiedź bez końcowej interpunkcji", () => {
    expect(chapterExposureText(draft({ exerciseType: "lesson_order", answer: "I'm wearing boots." }))).toBe("I'm wearing boots");
    expect(chapterExposureText(draft({ exerciseType: "lesson_open_answer", answer: " What's the weather like? " }))).toBe("What's the weather like");
    // „It's snowing.” i „It's snowing” to ta sama ekspozycja.
    expect(lessonExerciseTargetKey(englishChapterSubject, draft({ exerciseType: "lesson_open_answer", answer: "It's snowing." })))
      .toBe(lessonExerciseTargetKey(englishChapterSubject, draft({ exerciseType: "lesson_order", answer: "It's snowing" })));
  });

  it("pary i grupy: złączona odpowiedź", () => {
    expect(chapterExposureText(draft({ exerciseType: "lesson_match", answer: "raining, sunny, windy" }))).toBe("raining, sunny, windy");
    expect(chapterExposureText(draft({ exerciseType: "lesson_group", answer: "Ciepło / Zimno" }))).toBe("Ciepło / Zimno");
  });

  it("wynik jest już znormalizowany funkcją przedmiotu (normalizacja nic nie zmienia)", () => {
    const gap = draft({ exerciseType: "lesson_gap", stem: " I’m  wearing a pink ___ . ", answer: "coat" });
    expect(chapterExposureText(gap)).toBe("I'm wearing a pink coat");
    expect(normalizeChapterExposureText(chapterExposureText(gap))).toBe(chapterExposureText(gap));
  });
});

describe("normalizeChapterExposureText — wspólna normalizacja ekspozycji rozdziału", () => {
  it("zwija spacje, ucina końcową interpunkcję .!?… i ujednolica apostrofy oraz cudzysłowy", () => {
    expect(normalizeChapterExposureText("  I’m   wearing\ta pink coat.  ")).toBe("I'm wearing a pink coat");
    expect(normalizeChapterExposureText("It‘s ‚sunny‛ today!?…")).toBe("It's 'sunny' today");
    expect(normalizeChapterExposureText("He said “hi” and „bye” ‟ok”.")).toBe("He said \"hi\" and \"bye\" \"ok\"");
  });

  it("jest idempotentna", () => {
    for (const text of ["I’m wearing a coat.", "  What’s the weather like? ", "„Hi”!"]) {
      const once = normalizeChapterExposureText(text);
      expect(normalizeChapterExposureText(once)).toBe(once);
    }
  });

  it("przedmiot ją udostępnia: przykład karty i zdanie luki mają ten sam klucz mimo kropki i apostrofu", () => {
    expect(englishChapterSubject.normalizeExposureText).toBe(normalizeChapterExposureText);
    const gap = draft({ exerciseType: "lesson_gap", stem: "I'm wearing a pink ___.", answer: "coat", focus: ["coat"] });
    expect(lessonTextTargetKey(englishChapterSubject, "I’m wearing a pink coat.")).toBe(lessonExerciseTargetKey(englishChapterSubject, gap));
  });
});
