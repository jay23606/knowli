import { describe, expect, it } from "vitest";
import { messages } from "@learning/contracts";
import { questionReadText } from "./question-read-text";

describe("questionReadText — tekst nagrania „Posłuchaj pytania” (design szkoły §11.1)", () => {
  it("wybór: polecenie i pytanie, bez opcji", () => {
    expect(questionReadText({
      exerciseType: "lesson_choice",
      instructionPl: "Wybierz odpowiedź",
      stem: "Ile nóg ma pająk?",
    })).toBe("Wybierz odpowiedź. Ile nóg ma pająk?");
  });

  it("luka czytana jako „luka”, wskazówka pominięta", () => {
    expect(questionReadText({
      exerciseType: "lesson_gap",
      instructionPl: "Uzupełnij zdanie:",
      stem: "Rośliny wytwarzają ___ w procesie fotosyntezy",
    })).toBe("Uzupełnij zdanie: Rośliny wytwarzają luka w procesie fotosyntezy.");
    // Dłuższa luka jak w Kid UI (`splitLessonGap`: 2+ podkreśleń) — bez resztek podkreśleń.
    expect(questionReadText({ exerciseType: "lesson_gap", stem: "Stolicą Polski jest ____." })).toBe("Stolicą Polski jest luka.");
  });

  it("odpowiedź otwarta: polecenie i pytanie; bez polecenia w payloadzie samo pytanie", () => {
    expect(questionReadText({ exerciseType: "lesson_open_answer", instructionPl: "Odpowiedz", prompt: "Czym jest  fotosynteza?" }))
      .toBe("Odpowiedz. Czym jest fotosynteza?");
    expect(questionReadText({ exerciseType: "lesson_open_answer", prompt: "Czym jest fotosynteza?" }))
      .toBe("Czym jest fotosynteza?");
  });

  it("„Ułóż” czyta tylko polecenie z payloadu — bez niego brak nagrania", () => {
    expect(questionReadText({ exerciseType: "lesson_order", instructionPl: "Ułóż etapy po kolei" })).toBe("Ułóż etapy po kolei.");
    expect(questionReadText({ exerciseType: "lesson_order" })).toBeNull();
  });

  it("pary i słowa kluczowe: polecenie albo stałe polecenie typu", () => {
    expect(questionReadText({ exerciseType: "lesson_match" })).toBe(`${messages.kid.lessonMatchInstruction}`);
    expect(questionReadText({ exerciseType: "lesson_keywords", instructionPl: "Wybierz najważniejsze pojęcia" }))
      .toBe("Wybierz najważniejsze pojęcia.");
  });

  it("grupy: polecenie i nazwy grup w kolejności materiału", () => {
    expect(questionReadText({
      exerciseType: "lesson_group",
      groups: [{ label: "Ssaki" }, { label: "Ptaki" }],
    })).toBe(`${messages.kid.lessonGroupInstruction} Ssaki. Ptaki.`);
  });

  it("luki z bankiem: polecenie i tekst z „luka” — bez słów z banku", () => {
    expect(questionReadText({
      exerciseType: "lesson_cloze",
      clozeText: "Roślina pobiera ___ z powietrza i ____ z gleby",
    })).toBe(`${messages.kid.lessonClozeInstruction} Roślina pobiera luka z powietrza i luka z gleby.`);
  });

  it("obliczenia i typy gramatyki nie mają nagrania", () => {
    expect(questionReadText({ exerciseType: "lesson_calculation", instructionPl: "Oblicz", prompt: "3/4 + 1/2" })).toBeNull();
    expect(questionReadText({ exerciseType: "lesson_transform", instructionPl: "Zmień", stem: "She plays." })).toBeNull();
  });
});
