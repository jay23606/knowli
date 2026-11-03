import { describe, expect, it } from "vitest";
import { letterSegments } from "./letter-segments";

const joined = (segments: readonly { text: string }[]) => segments.map((segment) => segment.text).join("");

describe("letterSegments — zaznaczenie liter w feedbacku lekcji", () => {
  it("zawęża błędne słowo do innej litery w obu odpowiedziach", () => {
    const result = letterSegments([{ text: "hauseboat", state: "pill" }], "houseboat");
    expect(result.answer).toEqual([
      { text: "h", state: "plain" }, { text: "a", state: "pill" }, { text: "useboat", state: "plain" },
    ]);
    expect(result.correct).toEqual([
      { text: "h", state: "plain" }, { text: "o", state: "pill" }, { text: "useboat", state: "plain" },
    ]);
  });

  it("dopasowuje słowo w zdaniu i pomija interpunkcję na jego brzegach", () => {
    const answer = [{ text: "I live in a ", state: "plain" as const }, { text: "hauseboat.", state: "pill" as const }];
    const result = letterSegments(answer, "I live in a houseboat.");
    expect(result.answer).toEqual([
      { text: "I live in a h", state: "plain" }, { text: "a", state: "pill" }, { text: "useboat.", state: "plain" },
    ]);
    expect(result.correct).toEqual([
      { text: "I live in a h", state: "plain" }, { text: "o", state: "pill" }, { text: "useboat.", state: "plain" },
    ]);
  });

  it("brak litery: słowo dziecka zostaje zaznaczone w całości, brakująca litera w poprawnej", () => {
    const result = letterSegments([{ text: "My grandad ", state: "plain" }, { text: "live", state: "pill" }, { text: " here.", state: "plain" }], "My grandad lives here.");
    expect(result.answer).toEqual([
      { text: "My grandad ", state: "plain" }, { text: "live", state: "pill" }, { text: " here.", state: "plain" },
    ]);
    expect(result.correct).toEqual([
      { text: "My grandad live", state: "plain" }, { text: "s", state: "pill" }, { text: " here.", state: "plain" },
    ]);
  });

  it("zbędna litera: zaznaczona tylko u dziecka, poprawna odpowiedź bez zaznaczeń", () => {
    const result = letterSegments([{ text: "shee", state: "pill" }, { text: " plays", state: "plain" }], "she plays");
    // Która z dwóch liter „e” jest zbędna, rozstrzyga wyrównanie — zaznaczona jest jedna.
    expect(joined(result.answer)).toBe("shee plays");
    expect(result.answer.filter((segment) => segment.state === "pill")).toEqual([{ text: "e", state: "pill" }]);
    expect(result.correct).toBeNull();
  });

  it("zamiana kolejności liter to jedno zaznaczenie", () => {
    const result = letterSegments([{ text: "gadren", state: "pill" }], "garden");
    expect(result.correct).toEqual([
      { text: "ga", state: "plain" }, { text: "rd", state: "pill" }, { text: "en", state: "plain" },
    ]);
  });

  it("inne słowo, kilka słów albo sama wielkość liter — bez zmian i bez zaznaczeń poprawnej", () => {
    for (const [answer, correct] of [
      [[{ text: "kitchen", state: "pill" as const }], "garden"],
      [[{ text: "in the", state: "pill" as const }], "on the"],
      [[{ text: "Garden", state: "pill" as const }], "garden"],
    ] as const) {
      const result = letterSegments(answer, correct);
      expect(result.answer).toEqual(answer);
      expect(result.correct).toBeNull();
    }
  });

  it("segmenty „nie na temat” i zwykłe zostają, a teksty składają się bez zmian", () => {
    const answer = [{ text: "Its in the ", state: "plain" as const }, { text: "gardn", state: "pill" as const }, { text: " lol", state: "offtopic" as const }];
    const result = letterSegments(answer, "It's in the garden.");
    expect(joined(result.answer)).toBe("Its in the gardn lol");
    expect(result.answer.at(-1)).toEqual({ text: " lol", state: "offtopic" });
    expect(joined(result.correct!)).toBe("It's in the garden.");
    expect(result.correct).toContainEqual({ text: "e", state: "pill" });
  });

  it("słowo porównuje się ze słowem z tego samego miejsca zdania, nie z najbliższym gdziekolwiek", () => {
    // Regresja z przeglądu: „go” dawało zaznaczenie w „to”, „has” — w „hat”.
    const go = letterSegments([{ text: "She ", state: "plain" }, { text: "go", state: "pill" }, { text: " to school", state: "plain" }], "She goes to school");
    expect(go.answer).toEqual([{ text: "She ", state: "plain" }, { text: "go", state: "pill" }, { text: " to school", state: "plain" }]);
    expect(go.correct).toEqual([{ text: "She go", state: "plain" }, { text: "es", state: "pill" }, { text: " to school", state: "plain" }]);

    const has = letterSegments([{ text: "I ", state: "plain" }, { text: "has", state: "pill" }, { text: " a hat", state: "plain" }], "I have a hat");
    expect(has.answer).toEqual([{ text: "I ha", state: "plain" }, { text: "s", state: "pill" }, { text: " a hat", state: "plain" }]);
    expect(has.correct).toEqual([{ text: "I ha", state: "plain" }, { text: "ve", state: "pill" }, { text: " a hat", state: "plain" }]);

    // Remis odległości rozstrzyga miejsce w zdaniu, nie kolejność słów.
    const tie = letterSegments([{ text: "he can hit the ", state: "plain" }, { text: "cab", state: "pill" }], "he can hit the cap");
    expect(tie.correct).toEqual([{ text: "he can hit the ca", state: "plain" }, { text: "p", state: "pill" }]);
  });

  it("zaznaczenie części słowa i odpowiedź bez pary słów zostają w całości", () => {
    const partial = letterSegments([{ text: "He ", state: "plain" }, { text: "play", state: "pill" }, { text: "s football", state: "plain" }], "He plays football");
    expect(partial.correct).toBeNull();
    expect(partial.answer).toEqual([{ text: "He ", state: "plain" }, { text: "play", state: "pill" }, { text: "s football", state: "plain" }]);
  });

  it("zapis spoza NFC nie dostaje zaznaczenia samego akcentu", () => {
    const result = letterSegments([{ text: "cafe", state: "pill" }], "café");
    expect(result.correct).toBeNull();
    expect(result.answer).toEqual([{ text: "cafe", state: "pill" }]);
  });

  it("ponad limit segmentów Kid DTO obie strony zostają bez zmian", () => {
    const words = Array.from({ length: 17 }, (_, index) => `wor${String.fromCharCode(97 + index)}d`);
    const answer = words.flatMap((word, index) => [
      ...(index > 0 ? [{ text: " ", state: "plain" as const }] : []),
      { text: word.replace("d", "x"), state: "pill" as const },
    ]);
    const result = letterSegments(answer, words.join(" "));
    expect(result.answer).toEqual(answer);
    expect(result.correct).toBeNull();
  });

  it("każde słowo poprawnej odpowiedzi dopasowuje się najwyżej raz", () => {
    const result = letterSegments([{ text: "cat", state: "pill" }, { text: " and ", state: "plain" }, { text: "cat", state: "pill" }], "car and car");
    expect(result.correct).toEqual([
      { text: "ca", state: "plain" }, { text: "r", state: "pill" }, { text: " and ca", state: "plain" }, { text: "r", state: "pill" },
    ]);
  });
});
