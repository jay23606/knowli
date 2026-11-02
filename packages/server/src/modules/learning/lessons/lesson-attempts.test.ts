import { describe, expect, it } from "vitest";
import { FeedbackDtoSchema, type FeedbackDto } from "@learning/contracts";
import { carriesExerciseExplanation, repairedLessonFeedback, withExerciseExplanation, withFeedbackSentenceAudio } from "./lesson-attempts";

type Key = Parameters<typeof withFeedbackSentenceAudio>[1];

const ASSET = "11111111-1111-4111-8111-111111111111";
const key = (feedbackAudioAssetId?: string, extra: Partial<Key> = {}): Key => ({
  exerciseType: "lesson_gap", answer: "goes", acceptedAnswers: [], focus: ["goes"],
  objectiveId: "o", subjectId: "english_grammar", targetKey: "tk",
  ...(feedbackAudioAssetId ? { feedbackAudioAssetId } : {}),
  ...extra,
}) as Key;

describe("withFeedbackSentenceAudio", () => {
  it.each<FeedbackDto>([
    { kind: "great" },
    { kind: "incorrect", correctText: "goes" },
    { kind: "lesson_almost", correctText: "goes" },
    { kind: "lesson_hint", hintPl: "Dodaj -s.", correctText: "goes" },
  ])("feedback ujawniający rozwiązanie ($kind) dostaje nagranie z klucza", (feedback) => {
    expect(withFeedbackSentenceAudio(feedback, key(ASSET), "answered")).toEqual({ ...feedback, correctAudioAssetId: ASSET });
  });

  it.each<FeedbackDto | null>([
    null,
    { kind: "not_assessed" },
    { kind: "lesson_hint", hintPl: "Dodaj -s." },
    { kind: "lesson_precision_hint", hintPl: "Skróć odpowiedź." },
  ])("bez ujawnienia rozwiązania albo przy ofercie trenera — bez nagrania (%o)", (feedback) => {
    expect(withFeedbackSentenceAudio(feedback, key(ASSET), "answered")).toEqual(feedback);
  });

  it("zadanie zostaje otwarte (issued) — bez nagrania", () => {
    expect(withFeedbackSentenceAudio({ kind: "incorrect", correctText: "goes" }, key(ASSET), "issued")).toEqual({ kind: "incorrect", correctText: "goes" });
  });

  it("klucz bez nagrania (kartkówka, nagranie niegotowe przy wydaniu) zostawia feedback", () => {
    expect(withFeedbackSentenceAudio({ kind: "great" }, key(), "answered")).toEqual({ kind: "great" });
  });

  describe("bramka wariantu: dziecko nie słyszy innego zdania, niż pokazuje omówienie", () => {
    const translation = key(ASSET, {
      exerciseType: "lesson_open_answer", answer: "I'm wearing a coat today.", acceptedAnswers: ["Today I'm wearing a coat."], focus: ["coat"],
      subjectId: "english_chapter",
    });

    it.each<FeedbackDto>([
      { kind: "lesson_almost", correctText: "Today I'm wearing a coat." },
      { kind: "lesson_hint", hintPl: "Sprawdź słowo.", correctText: "Today I'm wearing a coat." },
      { kind: "incorrect", correctText: "Today I'm wearing a coat." },
    ])("$kind z innym zatwierdzonym wariantem niż kanoniczny — bez nagrania", (feedback) => {
      expect(withFeedbackSentenceAudio(feedback, translation, "answered")).toEqual(feedback);
    });

    it("pokazany wariant równy kanonicznemu — z nagraniem; `great` bez correctText — z nagraniem", () => {
      const almost: FeedbackDto = { kind: "lesson_almost", correctText: "I'm wearing a coat today." };
      expect(withFeedbackSentenceAudio(almost, translation, "answered")).toEqual({ ...almost, correctAudioAssetId: ASSET });
      expect(withFeedbackSentenceAudio({ kind: "great" }, translation, "answered")).toEqual({ kind: "great", correctAudioAssetId: ASSET });
    });

    it.each([
      { exerciseType: "lesson_transform", answer: "She plays football.", variant: "Yes, she plays football." },
      { exerciseType: "lesson_error_fix", answer: "He goes to school.", variant: "He goes to school every day." },
    ])("gramatyka ($exerciseType): „prawie” z innym zatwierdzonym wariantem — bez nagrania; z kanoniczną odpowiedzią — z nagraniem", ({ exerciseType, answer, variant }) => {
      const grammar = key(ASSET, { exerciseType, answer, acceptedAnswers: [variant], subjectId: "english_grammar" } as Partial<Key>);
      const shownVariant: FeedbackDto = { kind: "lesson_almost", correctText: variant };
      expect(withFeedbackSentenceAudio(shownVariant, grammar, "answered")).toEqual(shownVariant);
      const shownCanonical: FeedbackDto = { kind: "lesson_almost", correctText: answer };
      expect(withFeedbackSentenceAudio(shownCanonical, grammar, "answered")).toEqual({ ...shownCanonical, correctAudioAssetId: ASSET });
    });

    it("tekst kanoniczny typu zamkniętego to pokazany tekst rozwiązania (opcja, luki z bankiem, klocki)", () => {
      const choice = key(ASSET, { exerciseType: "lesson_choice", answer: "coat", correctOptionId: "o1", optionValues: { o1: "coat", o2: "dress" } });
      expect(withFeedbackSentenceAudio({ kind: "incorrect", correctText: "coat" }, choice, "answered")?.correctAudioAssetId).toBe(ASSET);
      expect(withFeedbackSentenceAudio({ kind: "incorrect", correctText: "dress" }, choice, "answered")?.correctAudioAssetId).toBeUndefined();

      const cloze = key(ASSET, { exerciseType: "lesson_cloze", answer: "coat, boots", filledText: "I'm wearing a coat and boots." });
      expect(withFeedbackSentenceAudio({ kind: "incorrect", correctText: "I'm wearing a coat and boots." }, cloze, "answered")?.correctAudioAssetId).toBe(ASSET);
      expect(withFeedbackSentenceAudio({ kind: "incorrect", correctText: "coat, boots" }, cloze, "answered")?.correctAudioAssetId).toBeUndefined();

      const order = key(ASSET, { exerciseType: "lesson_order", answer: "I'm wearing a coat", itemIds: ["a", "b", "c"], itemValues: { a: "I'm", b: "wearing", c: "a coat" } });
      expect(withFeedbackSentenceAudio({ kind: "incorrect", correctText: "I'm wearing a coat" }, order, "answered")?.correctAudioAssetId).toBe(ASSET);
    });
  });
});

describe("withExerciseExplanation (spec 2026-11-01 §4.2)", () => {
  const EXPLANATION = "Po he, she, it dodajemy -s do czasownika.";
  const EXPLANATION_AUDIO = "44444444-4444-4444-8444-444444444444";
  const withExplanation = (audio = true): Key => key(undefined, {
    explanationPl: EXPLANATION,
    explanationExposureKeys: [],
    ...(audio ? { explanationAudioAssetId: EXPLANATION_AUDIO } : {}),
  } as Partial<Key>);
  const segments = [{ text: "go", state: "pill" as const }];

  it("incorrect z correctText dostaje wyjaśnienie i nagranie z klucza", () => {
    const feedback: FeedbackDto = { kind: "incorrect", correctText: "goes" };
    const out = withExerciseExplanation(feedback, withExplanation(), "incorrect", true);
    expect(out).toEqual({ ...feedback, hintPl: EXPLANATION, explanationAudioAssetId: EXPLANATION_AUDIO });
    expect(FeedbackDtoSchema.safeParse(out).success).toBe(true);
  });

  it("klucz bez nagrania (niegotowe przy wydaniu) — wyjaśnienie bez audio", () => {
    expect(withExerciseExplanation({ kind: "incorrect", correctText: "goes" }, withExplanation(false), "incorrect", true))
      .toEqual({ kind: "incorrect", correctText: "goes", hintPl: EXPLANATION });
  });

  it("lesson_hint z szablonem kategorii — szablon wygrywa, bez nagrania", () => {
    const feedback: FeedbackDto = { kind: "lesson_hint", correctText: "goes", hintPl: "Dodaj -s.", answerSegments: segments };
    expect(withExerciseExplanation(feedback, withExplanation(), "incorrect", true)).toEqual(feedback);
  });

  it("lesson_hint bez szablonu z segmentami — dostaje wyjaśnienie, segmenty zostają", () => {
    const feedback = { kind: "lesson_hint", correctText: "goes", answerSegments: segments } as FeedbackDto;
    const out = withExerciseExplanation(feedback, withExplanation(), "incorrect", true);
    expect(out).toEqual({ ...feedback, hintPl: EXPLANATION, explanationAudioAssetId: EXPLANATION_AUDIO });
    expect(FeedbackDtoSchema.safeParse(out).success).toBe(true);
  });

  it("lesson_hint bez szablonu i bez wyjaśnienia — incorrect z correctText, bez segmentów (naprawa kontraktu)", () => {
    const feedback = { kind: "lesson_hint", correctText: "goes", answerSegments: segments } as FeedbackDto;
    const out = withExerciseExplanation(feedback, key(), "incorrect", true);
    expect(out).toEqual({ kind: "incorrect", correctText: "goes" });
    expect(FeedbackDtoSchema.safeParse(out).success).toBe(true);
  });

  it("naprawa lesson_hint bez hintPl działa też, gdy zadanie się nie kończy", () => {
    const feedback = { kind: "lesson_hint", correctText: "goes", answerSegments: segments } as FeedbackDto;
    expect(withExerciseExplanation(feedback, withExplanation(), "incorrect", false)).toEqual({ kind: "incorrect", correctText: "goes" });
  });

  it.each<FeedbackDto | null>([
    null,
    { kind: "great" },
    { kind: "lesson_almost", correctText: "goes" },
    { kind: "not_assessed" },
    { kind: "lesson_precision_hint", hintPl: "Skróć odpowiedź." },
    { kind: "lesson_hint", hintPl: "Sprawdź działanie." },
  ])("bez zmian dla rodzaju bez wyjaśnienia (%o)", (feedback) => {
    expect(withExerciseExplanation(feedback, withExplanation(), "incorrect", true)).toEqual(feedback);
  });

  it("zadanie się nie kończy albo wynik nie jest incorrect — bez doklejenia", () => {
    const feedback: FeedbackDto = { kind: "incorrect", correctText: "goes" };
    expect(withExerciseExplanation(feedback, withExplanation(), "incorrect", false)).toEqual(feedback);
    expect(withExerciseExplanation(feedback, withExplanation(), "unevaluated", true)).toEqual(feedback);
    expect(withExerciseExplanation(feedback, withExplanation(), "correct", true)).toEqual(feedback);
  });

  it("klucz bez wyjaśnienia — bez zmian", () => {
    const feedback: FeedbackDto = { kind: "incorrect", correctText: "goes" };
    expect(withExerciseExplanation(feedback, key(), "incorrect", true)).toEqual(feedback);
  });
});

describe("carriesExerciseExplanation (spec 2026-11-01 §4.4)", () => {
  const EXPLANATION = "Po he, she, it dodajemy -s do czasownika.";
  const snapshot = (hints: Record<string, string>) => ({
    descriptionEn: "Third person -s.", errorCategories: Object.keys(hints), hints, topicTitlePl: "Present Simple", extraErrorCategories: [],
  });

  it("hintPl równe wyjaśnieniu z klucza niesie wyjaśnienie", () => {
    const k = key(undefined, { explanationPl: EXPLANATION, objectiveSnapshot: snapshot({ missing_s: "Pamiętaj o -s." }) } as Partial<Key>);
    expect(carriesExerciseExplanation({ kind: "lesson_hint", hintPl: EXPLANATION, correctText: "goes" }, k)).toBe(true);
  });

  it("tekst identyczny z szablonem kategorii: wygrywa szablon, bez ekspozycji cytatów", () => {
    const k = key(undefined, { explanationPl: EXPLANATION, objectiveSnapshot: snapshot({ missing_s: EXPLANATION }) } as Partial<Key>);
    expect(carriesExerciseExplanation({ kind: "lesson_hint", hintPl: EXPLANATION, correctText: "goes" }, k)).toBe(false);
  });

  it("inny hintPl albo klucz bez wyjaśnienia — nie", () => {
    const k = key(undefined, { explanationPl: EXPLANATION } as Partial<Key>);
    expect(carriesExerciseExplanation({ kind: "lesson_hint", hintPl: "Pamiętaj o -s.", correctText: "goes" }, k)).toBe(false);
    expect(carriesExerciseExplanation({ kind: "incorrect", correctText: "goes" }, key())).toBe(false);
  });
});

describe("repairedLessonFeedback — zapisane próby sprzed reguły (odczyt i powtórka)", () => {
  it("lesson_hint bez hintPl staje się incorrect z correctText i przechodzi schemat Kid DTO", () => {
    const stored = { kind: "lesson_hint", correctText: "goes", answerSegments: [{ text: "go", state: "pill" }] } as unknown as FeedbackDto;
    const repaired = repairedLessonFeedback(stored);
    expect(repaired).toEqual({ kind: "incorrect", correctText: "goes" });
    expect(FeedbackDtoSchema.safeParse(stored).success).toBe(false);
    expect(FeedbackDtoSchema.safeParse(repaired).success).toBe(true);
  });

  it("lesson_hint bez hintPl i bez correctText staje się samym incorrect", () => {
    expect(repairedLessonFeedback({ kind: "lesson_hint" } as unknown as FeedbackDto)).toEqual({ kind: "incorrect" });
  });

  it("poprawny feedback i null bez zmian", () => {
    const hint: FeedbackDto = { kind: "lesson_hint", hintPl: "Pamiętaj o -s.", correctText: "goes" };
    expect(repairedLessonFeedback(hint)).toBe(hint);
    expect(repairedLessonFeedback(null)).toBeNull();
  });
});
