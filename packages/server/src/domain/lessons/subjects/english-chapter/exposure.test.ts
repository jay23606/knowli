import { describe, expect, it } from "vitest";
import { computeTargetKey } from "../../../target-key";
import { lessonExerciseTargetKey, lessonTextTargetKey } from "../../exposure-key";
import type { LessonExerciseDraft } from "../../types";
import { chapterCardExposureTexts, chapterExposureText, normalizeChapterExposureText } from "./exposure";
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

describe("chapterCardExposureTexts — zdania z kart widoczne jako gotowe rozwiązania", () => {
  it("zdania z kropką/pytajnikiem albo ≥ 3 słowa", () => {
    expect(chapterCardExposureTexts([{ body: "There is a bed in my room.\nWhere is the lamp?" }])).toEqual([
      "There is a bed in my room.",
      "Where is the lamp?",
    ]);
  });

  it("słówka nie; części po „ — ” i „ / ” osobno; polska część odpada", () => {
    expect(chapterCardExposureTexts([{ body: "living room — salon\nbed — łóżko / I have a big bed.\nPokój — my room is big." }])).toEqual([
      "I have a big bed.",
      "my room is big.",
    ]);
  });

  it("rama z wielokropkiem i zdanie z polskimi znakami odpadają", () => {
    expect(chapterCardExposureTexts([{ body: "There's a … in the …\nTo jest mój pokój.\nIt's ... today" }])).toEqual([]);
  });

  it("części po „: ” i „; ”, kilka zdań w linii, punktory i numeracja, cudzysłowy na brzegach", () => {
    expect(chapterCardExposureTexts([{
      body: [
        "Example: It's sunny.",
        "It's very cold; I'm wearing a coat.",
        "It's raining. Where is my umbrella? I'm wet!",
        "• There is a lamp.",
        "* I like my room.",
        "1. Where is the bed?",
        "2) The bed is big.",
        "\"Where's the box?\"",
        "«I can see it.»",
        "“It's under the bed.”",
        "What's the weather like? It's ...",
      ].join("\n"),
    }])).toEqual([
      "It's sunny.",
      "It's very cold",
      "I'm wearing a coat.",
      "It's raining.",
      "Where is my umbrella?",
      "I'm wet!",
      "There is a lamp.",
      "I like my room.",
      "Where is the bed?",
      "The bed is big.",
      "Where's the box?",
      "I can see it.",
      "It's under the bed.",
      "What's the weather like?",
    ]);
  });

  it("apostrof typograficzny → ', duplikaty usunięte", () => {
    expect(chapterCardExposureTexts([{ body: "There’s a bed." }, { body: "There's a bed." }])).toEqual(["There's a bed."]);
  });

  it("świadomy koszt: polskie zdanie bez znaków diakrytycznych jest uznane za zdanie", () => {
    expect(chapterCardExposureTexts([{ body: "To jest kot." }])).toEqual(["To jest kot."]);
  });

  it("łącznik wewnątrz słowa należy do zdania („T-shirt”), samotny łącznik nie", () => {
    expect(chapterCardExposureTexts([{ body: "I'm wearing a T-shirt.\nIt's a well-known park." }])).toEqual([
      "I'm wearing a T-shirt.",
      "It's a well-known park.",
    ]);
    expect(chapterCardExposureTexts([{ body: "It is - cold." }])).toEqual([]);
  });

  it("zdania zakończone cudzysłowem zamykającym dzielą się na granicy zdania", () => {
    expect(chapterCardExposureTexts([{ body: "„There is a bed.” „I like it.”" }])).toEqual(["There is a bed.", "I like it."]);
    expect(chapterCardExposureTexts([{ body: "\"Where is it?\" \"It is here.\"" }])).toEqual(["Where is it?", "It is here."]);
  });

  it("cyfry wewnątrz zdania należą do zdania", () => {
    expect(chapterCardExposureTexts([{ body: "I have 2 cats.\nThere are 10 books in my room." }])).toEqual([
      "I have 2 cats.",
      "There are 10 books in my room.",
    ]);
  });

  it("długi ciąg spacji i cudzysłowów nie wywołuje nawrotów (czas liniowy)", () => {
    const started = performance.now();
    const result = chapterCardExposureTexts([{ body: `${" ".repeat(50_000)}x${"”".repeat(50_000)}y` }]);
    expect(performance.now() - started).toBeLessThan(500);
    expect(result).toEqual([]);
    expect(chapterCardExposureTexts([{ body: "„There is a bed.”” — „I like it.”" }])).toEqual(["There is a bed.", "I like it."]);
  });

  it("prawdziwa karta ramy (format `objectivesRules`): wzór po polsku, przykłady po etykiecie, punktor, cudzysłów", () => {
    const frameCard = {
      body: [
        "Wzór: I'm wearing (a) … — mówimy, co mamy na sobie.",
        "Na przykład: I'm wearing a red hat. I'm wearing boots.",
        "- It's sunny today.",
        "„What's the weather like?”",
        "weather — pogoda",
      ].join("\n"),
    };
    expect(chapterCardExposureTexts([frameCard])).toEqual([
      "I'm wearing a red hat.",
      "I'm wearing boots.",
      "It's sunny today.",
      "What's the weather like?",
    ]);
  });

  it("bez kropki zdaniem jest część z ≥ 3 słowami (granica: 2 słowa odpadają); linie z \\r\\n", () => {
    expect(chapterCardExposureTexts([{ body: "living room\r\nI like my bed\r\nWhere is it" }])).toEqual(["I like my bed", "Where is it"]);
  });

  it("przedmiot udostępnia hak", () => {
    expect(englishChapterSubject.cardExposureTexts).toBe(chapterCardExposureTexts);
  });
});
