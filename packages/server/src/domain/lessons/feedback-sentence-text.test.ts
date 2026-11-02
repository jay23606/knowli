import { describe, expect, it } from "vitest";
import { fillCloze } from "./cloze";
import { feedbackSentenceText } from "./feedback-sentence-text";

const items = (...texts: string[]) => texts.map((text, i) => ({ id: `i${i}`, text }));

describe("feedbackSentenceText", () => {
  it("lesson_gap wstawia odpowiedź w lukę", () => {
    expect(feedbackSentenceText({ exerciseType: "lesson_gap", stem: "She ___ football.", answer: "plays" })).toBe("She plays football.");
    expect(feedbackSentenceText({ exerciseType: "lesson_gap", stem: "She ____ football.", answer: "plays" })).toBe("She plays football.");
  });

  it("lesson_gap bez dokładnie jednej luki daje null", () => {
    expect(feedbackSentenceText({ exerciseType: "lesson_gap", stem: "___ ___ football.", answer: "plays" })).toBeNull();
    expect(feedbackSentenceText({ exerciseType: "lesson_gap", stem: "She plays football.", answer: "plays" })).toBeNull();
  });

  it("lesson_choice wstawia tekst poprawnej opcji", () => {
    const options = [{ id: "a", text: "He" }, { id: "b", text: "She" }];
    expect(feedbackSentenceText({ exerciseType: "lesson_choice", stem: "___ is happy.", options, correctOption: "b" })).toBe("She is happy.");
    expect(feedbackSentenceText({ exerciseType: "lesson_choice", stem: "Is happy.", options, correctOption: "b" })).toBeNull();
    expect(feedbackSentenceText({ exerciseType: "lesson_choice", stem: "___ is happy.", options, correctOption: "z" })).toBeNull();
  });

  it("lesson_listen_choice wstawia tekst poprawnej opcji jak lesson_choice", () => {
    const options = [{ id: "a", text: "like" }, { id: "b", text: "doesn't like" }];
    expect(feedbackSentenceText({ exerciseType: "lesson_listen_choice", stem: "She ___ milk.", options, correctOption: "b" })).toBe("She doesn't like milk.");
    expect(feedbackSentenceText({ exerciseType: "lesson_listen_choice", stem: "___ She ___ milk.", options, correctOption: "b" })).toBeNull();
    expect(feedbackSentenceText({ exerciseType: "lesson_listen_choice", stem: `${"a".repeat(200)} ___`, options, correctOption: "b" })).toBeNull();
  });

  it("lesson_order skleja klocki w kolejności kanonicznej", () => {
    expect(feedbackSentenceText({ exerciseType: "lesson_order", items: items("She", "plays", "football", ".") })).toBe("She plays football.");
    expect(feedbackSentenceText({ exerciseType: "lesson_order", items: items("Yes", ",", "I", "am", ".") })).toBe("Yes, I am.");
  });

  it.each(["lesson_error_fix", "lesson_transform", "lesson_open_answer"])("%s czyta odpowiedź", (exerciseType) => {
    expect(feedbackSentenceText({ exerciseType, answer: "  She  plays football every day. " })).toBe("She plays football every day.");
  });

  it.each([
    { exerciseType: "lesson_gap", stem: "He ___ to school." },
    { exerciseType: "lesson_error_fix" },
    { exerciseType: "lesson_transform" },
    { exerciseType: "lesson_open_answer" },
  ])("$exerciseType z pustą odpowiedzią daje null", (source) => {
    expect(feedbackSentenceText({ ...source, answer: "" })).toBeNull();
    expect(feedbackSentenceText({ ...source, answer: "   " })).toBeNull();
  });

  it("lesson_choice z pustym tekstem poprawnej opcji daje null", () => {
    const options = [{ id: "a", text: "  " }, { id: "b", text: "She" }];
    expect(feedbackSentenceText({ exerciseType: "lesson_choice", stem: "___ is happy.", options, correctOption: "a" })).toBeNull();
  });

  it("lesson_order bez klocków albo z pustym klockiem daje null", () => {
    expect(feedbackSentenceText({ exerciseType: "lesson_order", items: [] })).toBeNull();
    expect(feedbackSentenceText({ exerciseType: "lesson_order", items: [{ id: "a", text: "I" }, { id: "b", text: "" }, { id: "c", text: "go" }] })).toBeNull();
  });

  it("lesson_cloze wstawia słowa luk w kolejności — tekst jak w omówieniu (`fillCloze`)", () => {
    const clozeText = "It's ___ today. I'm wearing my ___.";
    const gapAnswers = ["sunny", "T-shirt"];
    expect(feedbackSentenceText({ exerciseType: "lesson_cloze", clozeText, gapAnswers })).toBe("It's sunny today. I'm wearing my T-shirt.");
    expect(feedbackSentenceText({ exerciseType: "lesson_cloze", clozeText, gapAnswers })).toBe(fillCloze(clozeText, gapAnswers));
    // Wspólne zasady: białe znaki i spacja przed interpunkcją jak w pozostałych typach.
    expect(feedbackSentenceText({ exerciseType: "lesson_cloze", clozeText: "  It's ____ today .  I'm wearing my ___. ", gapAnswers }))
      .toBe("It's sunny today. I'm wearing my T-shirt.");
  });

  it("lesson_cloze bez kompletu słów, z nadmiarem słów albo bez luk daje null", () => {
    const clozeText = "It's ___ today. I'm wearing my ___.";
    expect(feedbackSentenceText({ exerciseType: "lesson_cloze", clozeText, gapAnswers: ["sunny"] })).toBeNull();
    expect(feedbackSentenceText({ exerciseType: "lesson_cloze", clozeText, gapAnswers: ["sunny", " "] })).toBeNull();
    expect(feedbackSentenceText({ exerciseType: "lesson_cloze", clozeText, gapAnswers: ["sunny", "T-shirt", "boots"] })).toBeNull();
    expect(feedbackSentenceText({ exerciseType: "lesson_cloze", clozeText, gapAnswers: ["sunny", "", "T-shirt"] })).toBeNull();
    expect(feedbackSentenceText({ exerciseType: "lesson_cloze", clozeText })).toBeNull();
    expect(feedbackSentenceText({ exerciseType: "lesson_cloze", clozeText: "It's sunny today.", gapAnswers: [] })).toBeNull();
    expect(feedbackSentenceText({ exerciseType: "lesson_cloze", gapAnswers: ["sunny"] })).toBeNull();
  });

  it("lesson_cloze dłuższy niż 200 znaków (po wstawieniu słów) daje null", () => {
    const gapAnswers = ["sunny", "windy"];
    // `${filler} sunny and windy.` = długość wypełniacza + 17 znaków.
    expect(feedbackSentenceText({ exerciseType: "lesson_cloze", clozeText: `${"a".repeat(184)} ___ and ___.`, gapAnswers })).toBeNull();
    expect(feedbackSentenceText({ exerciseType: "lesson_cloze", clozeText: `${"a".repeat(183)} ___ and ___.`, gapAnswers })).toHaveLength(200);
  });

  it.each([
    "lesson_card", "lesson_notice", "lesson_short_answer", "lesson_match",
    "lesson_group", "lesson_calculation", "lesson_keywords",
  ])("%s nie ma zdania", (exerciseType) => {
    expect(feedbackSentenceText({ exerciseType, answer: "She plays football." })).toBeNull();
  });

  it("odrzuca zdanie dłuższe niż 200 znaków", () => {
    expect(feedbackSentenceText({ exerciseType: "lesson_error_fix", answer: "a".repeat(201) })).toBeNull();
    expect(feedbackSentenceText({ exerciseType: "lesson_error_fix", answer: "a".repeat(200) })).toBe("a".repeat(200));
  });
});
