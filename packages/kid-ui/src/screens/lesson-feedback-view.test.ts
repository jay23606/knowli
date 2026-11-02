import { describe, expect, it } from "vitest";
import type { FeedbackDto } from "@learning/contracts";
import { lessonFeedbackView } from "./lesson-feedback-view";

const segments = [
  { text: "she ", state: "plain" as const },
  { text: "play", state: "pill" as const },
  { text: " football", state: "plain" as const },
];

describe("lessonFeedbackView — mapowanie feedbacku lekcji na model widoku", () => {
  it("lesson_almost: tytuł „Prawie!”, segmenty odpowiedzi dziecka, poprawna odpowiedź, ton wsparcia", () => {
    const dto: FeedbackDto = { kind: "lesson_almost", answerSegments: segments, correctText: "she plays football" };
    const view = lessonFeedbackView(dto);
    expect(view).not.toBeNull();
    expect(view!.title).toBe("Prawie!");
    expect(view!.answerSegments).toEqual(segments);
    expect(view!.correctText).toBe("she plays football");
    expect(view!.hint).toBeNull();
    expect(view!.tone).toBe("retry");
    expect(view!.technical).toBe(false);
  });

  it("lesson_hint: segmenty + podpowiedź hintPl + poprawna odpowiedź", () => {
    const dto: FeedbackDto = {
      kind: "lesson_hint",
      answerSegments: segments,
      hintPl: "W 3. osobie dodaj -s.",
      correctText: "she plays football",
    };
    const view = lessonFeedbackView(dto);
    expect(view!.hint).toBe("W 3. osobie dodaj -s.");
    expect(view!.answerSegments).toEqual(segments);
    expect(view!.correctText).toBe("she plays football");
    expect(view!.tone).toBe("retry");
  });

  it("lesson_precision_hint: pochwała „Świetnie!” + zachęta do skrócenia, ton sukcesu, bez poprawnej odpowiedzi", () => {
    const dto: FeedbackDto = { kind: "lesson_precision_hint", hintPl: "Wiesz to! Teraz spróbuj powiedzieć to krócej, bez dodatkowych historii." };
    const view = lessonFeedbackView(dto);
    expect(view!.title).toBe("Świetnie!");
    expect(view!.tone).toBe("correct");
    expect(view!.hint).toBe("Wiesz to! Teraz spróbuj powiedzieć to krócej, bez dodatkowych historii.");
    expect(view!.answerSegments).toBeNull();
    expect(view!.correctText).toBeNull();
    expect(view!.technical).toBe(false);
  });

  it("not_assessed: komunikat techniczny, bez segmentów i bez sugestii błędu", () => {
    const dto: FeedbackDto = { kind: "not_assessed" };
    const view = lessonFeedbackView(dto);
    expect(view!.technical).toBe(true);
    expect(view!.answerSegments).toBeNull();
    expect(view!.correctText).toBeNull();
    expect(view!.tone).toBe("neutral");
  });

  it("lesson_hint z nagraniem wyjaśnienia: hintPl pokazuje dok, nie treść karty", () => {
    const dto: FeedbackDto = {
      kind: "lesson_hint",
      answerSegments: segments,
      hintPl: "Po she dodajemy -s.",
      correctText: "she plays football",
      explanationAudioAssetId: "abababab-abab-4bab-8bab-abababababab",
    };
    const view = lessonFeedbackView(dto);
    expect(view!.hint).toBeNull();
    expect(view!.answerSegments).toEqual(segments);
    expect(view!.correctText).toBe("she plays football");
  });

  it("incorrect bez hintPl (słówka) zostaje w istniejącym widoku", () => {
    expect(lessonFeedbackView({ kind: "incorrect", correctText: "cat" })).toBeNull();
  });

  it("zwraca null dla rodzajów nie-lekcyjnych (obsługiwanych przez istniejący widok)", () => {
    expect(lessonFeedbackView({ kind: "great" })).toBeNull();
    expect(lessonFeedbackView({ kind: "incorrect", correctText: "cat" })).toBeNull();
    expect(lessonFeedbackView(null)).toBeNull();
  });
});
