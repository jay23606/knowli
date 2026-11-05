import { describe, expect, it } from "vitest";
import { baseNormalizer } from "../../normalize";
import type { LessonExerciseDraft } from "../../types";
import { hintRevealsAnswer, stemMatches } from "./hint-gate";

const norm = baseNormalizer;

const openAnswerFixture: LessonExerciseDraft = {
  exerciseType: "lesson_open_answer",
  objectiveId: "school.dx.geografia",
  stem: "Podaj przykład.",
  answer: "",
  acceptedAnswers: [],
  focus: [],
};

const open = (answer: string, extra: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft => ({ ...openAnswerFixture, answer, ...extra });

describe("stemMatches", () => {
  it("łączy odmiany tego samego słowa", () => {
    expect(stemMatches("Odra", "Odrze")).toBe(true);
    expect(stemMatches("Polska", "Polski")).toBe(true);
    expect(stemMatches("zmniejszony", "zmniejszenie")).toBe(true);
  });

  it("nie łączy krótkich i różnych słów", () => {
    expect(stemMatches("mapa", "mama")).toBe(false);
    expect(stemMatches("kot", "koń")).toBe(false);
  });

  it("końcówka najwyżej 3 litery: wspólne „prze” nie łączy różnych słów (pilnuje MAX_ENDING_LENGTH)", () => {
    // Prefiks 4 < 8 − 3 = 5; przy końcówce 4 litery fałszywie by pasowały.
    expect(stemMatches("przemysł", "przeciwny")).toBe(false);
  });

  it("równe słowa pasują także krótkie, a liczby tylko przy równości", () => {
    expect(stemMatches("kot", "KOT")).toBe(true);
    expect(stemMatches("1410", "1410")).toBe(true);
    expect(stemMatches("1410", "1411")).toBe(false);
  });
});

describe("hintRevealsAnswer", () => {
  it("odrzuca podpowiedź zawierającą odpowiedź", () => {
    expect(hintRevealsAnswer("Przykładem jest Mierzeja Wiślana", open("Mierzeja Wiślana"), norm)).toBe(true);
  });

  it("odrzuca podpowiedź zawierającą element wymagany", () => {
    expect(
      hintRevealsAnswer(
        "Użyj słów: zmniejszony, uproszczony",
        open("Mapa to obraz Ziemi", { requiredElements: [{ id: "a", text: "obraz zmniejszony" }, { id: "b", text: "uproszczony" }] }),
        norm,
      ),
    ).toBe(true);
  });

  it("zostawia podpowiedź kierującą rozumowaniem", () => {
    expect(hintRevealsAnswer("Pomyśl o rzekach w Polsce", open("Wisła i Odra"), norm)).toBe(false);
  });

  it("liczba jest słowem treściowym", () => {
    expect(hintRevealsAnswer("Bitwa była w 1410 roku", open("w 1410"), norm)).toBe(true);
  });

  it("fraza bez słów ≥ 4 liter używa wszystkich tokenów", () => {
    // „ma psa i kot” — brak słów ≥ 4 liter, więc wszystkie 4 tokeny są treściowe, próg = 2 (przy „kota” treściowe byłoby tylko „kota”)
    expect(hintRevealsAnswer("Ma psa", open("ma psa i kot"), norm)).toBe(true);
    expect(hintRevealsAnswer("Pomyśl o zwierzętach", open("ma psa i kot"), norm)).toBe(false);
  });

  it("odrzuca podpowiedź zawierającą wariant odpowiedzi", () => {
    expect(hintRevealsAnswer("Wspomnij o Krakowie", open("Warszawa", { acceptedAnswers: ["Kraków"] }), norm)).toBe(true);
  });

  it("wymaga połowy słów treściowych frazy, zaokrąglając w górę", () => {
    // słowa treściowe „burza”, „morzem”, „bałtyckim” (3) → próg 2
    expect(hintRevealsAnswer("dzieje się nad morzem", open("Burza nad morzem Bałtyckim"), norm)).toBe(false);
    expect(hintRevealsAnswer("burza nad morzem", open("Burza nad morzem Bałtyckim"), norm)).toBe(true);
  });

  it("przy jednym lub dwóch słowach treściowych wymaga wszystkich", () => {
    expect(hintRevealsAnswer("Chodzi o Mierzeję", open("Mierzeja Wiślana"), norm)).toBe(false);
  });

  it("pusta podpowiedź ani pusta fraza nie ujawniają", () => {
    expect(hintRevealsAnswer("", open("Mierzeja Wiślana"), norm)).toBe(false);
    expect(hintRevealsAnswer("Pomyśl o rzekach", open("", { acceptedAnswers: [""] }), norm)).toBe(false);
  });
});
