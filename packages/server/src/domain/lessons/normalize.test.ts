import { describe, expect, it } from "vitest";
import { baseNormalizer, normalizeTokens } from "./normalize";

describe("normalizeTokens", () => {
  it("tokenizuje tekst po spacjach", () => {
    expect(normalizeTokens("he plays football")).toEqual(["he", "plays", "football"]);
  });

  it("sprowadza do małych liter niezależnie od locale", () => {
    expect(normalizeTokens("He PLAYS")).toEqual(["he", "plays"]);
  });

  it("ujednolica apostrofy typograficzne do zwykłego", () => {
    expect(normalizeTokens("don\u2019t can\u2018t it\u02bcs a\u00b4b")).toEqual([
      "don't",
      "can't",
      "it's",
      "a'b",
    ]);
  });

  it("zachowuje apostrof wewnątrz słowa", () => {
    expect(normalizeTokens("I don't know")).toEqual(["i", "don't", "know"]);
  });

  it("usuwa interpunkcję poza apostrofem wewnątrz słowa", () => {
    expect(normalizeTokens("Hello, world! (yes) — 'quote'")).toEqual([
      "hello",
      "world",
      "yes",
      "quote",
    ]);
  });

  it("zwija wielokrotne spacje i białe znaki", () => {
    expect(normalizeTokens("  he   \t plays\n football ")).toEqual(["he", "plays", "football"]);
  });

  it("zachowuje polskie znaki diakrytyczne (przedmioty polskojęzyczne)", () => {
    expect(normalizeTokens("Zażółć gęślą jaźń")).toEqual(["zażółć", "gęślą", "jaźń"]);
  });

  it("zachowuje cyfry", () => {
    expect(normalizeTokens("rok 1385")).toEqual(["rok", "1385"]);
  });

  it("zachowuje minus liczby ujemnej (#318): „-5” ≠ „5”", () => {
    expect(normalizeTokens("-5")).toEqual(["-5"]);
    expect(normalizeTokens("5")).toEqual(["5"]);
    expect(normalizeTokens("temperatura -5 stopni")).toEqual(["temperatura", "-5", "stopni"]);
    expect(normalizeTokens("(-12)")).toEqual(["-12"]);
  });

  it("ujednolica minus typograficzny i półpauzę do „-” przed cyfrą", () => {
    expect(normalizeTokens("\u22125")).toEqual(["-5"]);
    expect(normalizeTokens("\u20135")).toEqual(["-5"]);
  });

  it("spacja po minusie na początku odpowiedzi to nadal liczba ujemna", () => {
    expect(normalizeTokens(" - 5")).toEqual(["-5"]);
    expect(normalizeTokens("\u2212 5 stopni")).toEqual(["-5", "stopni"]);
  });

  it("minus przy ułamku dziesiętnym odróżnia liczbę ujemną", () => {
    expect(normalizeTokens("-2,5")).not.toEqual(normalizeTokens("2,5"));
    expect(normalizeTokens("-0.5")).not.toEqual(normalizeTokens("0.5"));
  });

  it("łącznik i odejmowanie w środku tekstu nie są znakiem liczby", () => {
    expect(normalizeTokens("well-known")).toEqual(["well", "known"]);
    expect(normalizeTokens("3-year-old")).toEqual(["3", "year", "old"]);
    expect(normalizeTokens("5-3")).toEqual(["5", "3"]);
    expect(normalizeTokens("5 - 3")).toEqual(["5", "3"]);
    expect(normalizeTokens("x\u22122")).toEqual(["x", "2"]);
    expect(normalizeTokens("a \u2013 b")).toEqual(["a", "b"]);
    expect(normalizeTokens("-ing")).toEqual(["ing"]);
  });

  it("normalizuje do Unicode NFC (zdekomponowane = złożone)", () => {
    const decomposed = "a\u0328"; // a + ogonek → ą
    expect(normalizeTokens(decomposed)).toEqual(normalizeTokens("ą"));
  });

  it("pusty tekst daje pustą listę tokenów", () => {
    expect(normalizeTokens("")).toEqual([]);
    expect(normalizeTokens("   ")).toEqual([]);
  });
});

describe("baseNormalizer", () => {
  it("zwraca jedną sekwencję tokenów", () => {
    expect(baseNormalizer.normalize("He plays")).toEqual([["he", "plays"]]);
  });

  it("pusty tekst → [[]]", () => {
    expect(baseNormalizer.normalize("")).toEqual([[]]);
  });

  it("nie usuwa apostrofu-separatora skrótów (należy do przedmiotu, nie silnika)", () => {
    // Bazowy normalizator nie rozwija skrótów — to robi normalizator przedmiotu.
    expect(baseNormalizer.normalize("doesn't")).toEqual([["doesn't"]]);
  });
});
