import { describe, expect, it } from "vitest";
import { englishNormalizer, MAX_NORMALIZER_VARIANTS } from "./normalizer";

/** Pomocnik: zbiór znormalizowanych sekwencji jako sortowane łańcuchy (porównanie bez względu na kolejność wariantów). */
function variantStrings(text: string): string[] {
  return englishNormalizer.normalize(text).map((tokens) => tokens.join(" "));
}

/** Czy dwa teksty mają wspólną sekwencję wariantów (równoważność po normalizacji). */
function shareVariant(a: string, b: string): boolean {
  const left = new Set(variantStrings(a));
  return variantStrings(b).some((variant) => left.has(variant));
}

describe("englishNormalizer — kompozycja z baseNormalizer", () => {
  it("słowa bez skrótów nie zmieniają się (jedna sekwencja)", () => {
    expect(englishNormalizer.normalize("he plays football")).toEqual([["he", "plays", "football"]]);
  });

  it("dziedziczy bazową normalizację: wielkość liter i interpunkcja", () => {
    expect(englishNormalizer.normalize("He Plays, football!")).toEqual([["he", "plays", "football"]]);
  });

  it("pusty tekst → [[]] (jak baza)", () => {
    expect(englishNormalizer.normalize("")).toEqual([[]]);
  });
});

describe("englishNormalizer — rozwijanie skrótów jednoznacznych", () => {
  it("doesn't play ≡ does not play ≡ doesnt play", () => {
    expect(shareVariant("doesn't play", "does not play")).toBe(true);
    expect(shareVariant("doesnt play", "does not play")).toBe(true);
    expect(shareVariant("doesn't play", "doesnt play")).toBe(true);
  });

  it("formy bez apostrofu rozwijają się tak samo jak z apostrofem", () => {
    for (const [bare, apostrophe] of [
      ["dont", "don't"],
      ["isnt", "isn't"],
      ["arent", "aren't"],
      ["wasnt", "wasn't"],
      ["werent", "weren't"],
      ["havent", "haven't"],
      ["hasnt", "hasn't"],
      ["didnt", "didn't"],
    ] as const) {
      expect(shareVariant(bare, apostrophe)).toBe(true);
    }
  });

  it("apostrof typograficzny jest traktowany jak zwykły (don’t)", () => {
    expect(shareVariant("don\u2019t stop", "do not stop")).toBe(true);
  });

  it("I'm → I am, you're → you are", () => {
    expect(shareVariant("I'm happy", "i am happy")).toBe(true);
    expect(shareVariant("you're late", "you are late")).toBe(true);
  });
});

describe("englishNormalizer — skróty wieloznaczne (iloczyn wariantów)", () => {
  it("he's → he is | he has (oba warianty obecne)", () => {
    const variants = variantStrings("he's gone");
    expect(variants).toContain("he is gone");
    expect(variants).toContain("he has gone");
  });

  it("can't → cannot | can not", () => {
    const variants = variantStrings("I can't swim");
    expect(variants).toContain("i cannot swim");
    expect(variants).toContain("i can not swim");
  });

  it("I'd → I would | I had", () => {
    const variants = variantStrings("I'd go");
    expect(variants).toContain("i would go");
    expect(variants).toContain("i had go");
  });

  it("where's, there's, what's → … is | … has (ramy z podręcznika)", () => {
    expect(shareVariant("Where's the box?", "where is the box")).toBe(true);
    expect(shareVariant("There's a lamp in the hall.", "there is a lamp in the hall")).toBe(true);
    expect(shareVariant("What's the weather like?", "what is the weather like")).toBe(true);
    expect(variantStrings("there's been")).toContain("there has been");
  });

  it("wont (bez apostrofu) rozwija się do will not — decyzja przedmiotu mimo kolizji z rzeczownikiem", () => {
    expect(shareVariant("he wont stop", "he will not stop")).toBe(true);
  });
});

describe("englishNormalizer — determinizm, brak duplikatów, limit", () => {
  it("wynik nie zawiera duplikatów sekwencji", () => {
    const variants = variantStrings("he plays");
    expect(new Set(variants).size).toBe(variants.length);
  });

  it("wynik jest deterministyczny (ta sama kolejność między wywołaniami)", () => {
    expect(variantStrings("he's and she's here")).toEqual(variantStrings("he's and she's here"));
  });

  it("wiele skrótów wieloznacznych nie przekracza limitu i jest deterministyczne", () => {
    // 6 skrótów dwuznacznych → 2^6 = 64 > limit; musi zostać przycięte.
    const many = "he's she's it's I'd you'd they'd";
    const variants = englishNormalizer.normalize(many);
    expect(variants.length).toBeLessThanOrEqual(MAX_NORMALIZER_VARIANTS);
    expect(variants.length).toBeGreaterThan(0);
    // determinizm przy przekroczeniu limitu
    expect(englishNormalizer.normalize(many)).toEqual(variants);
  });

  it("MAX_NORMALIZER_VARIANTS jest rozsądną nazwaną stałą", () => {
    expect(MAX_NORMALIZER_VARIANTS).toBeGreaterThanOrEqual(8);
  });
});
