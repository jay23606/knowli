import type { AnswerNormalizer } from "./types";

/** Apostrofy typograficzne ujednolicane do zwykłego `'` (także w zapisie słówek ze źródła). */
export const APOSTROPHE_VARIANTS = /[\u2019\u2018\u02bc\u00b4]/g;

/** Minus typograficzny (U+2212) i półpauza (U+2013) ujednolicane do `-`. */
const MINUS_VARIANTS = /[\u2212\u2013]/g;

/** Minus na początku odpowiedzi, także ze spacją przed liczbą („- 5”). */
const LEADING_SIGN = /^\s*-\s*(?=\p{N})/u;

/**
 * Znak dozwolony w tokenie: litera (z diakrytykami), cyfra, apostrof oraz `-`
 * tuż przed cyfrą i nie po znaku słowa — minus liczby ujemnej (#318: „5” ≠ „-5”);
 * łącznik („well-known”, „5-3”) dalej rozdziela tokeny. Litery i cyfry obejmują
 * alfabety spoza ASCII (przedmioty polskojęzyczne).
 */
const NON_WORD = /(?:[^\p{L}\p{N}'-]|(?<=[\p{L}\p{N}'])-|-(?!\p{N}))+/gu;

/** Zewnętrzne apostrofy tokenu (np. z `'quote'`); wewnętrzne zostają. */
const EDGE_APOSTROPHES = /^'+|'+$/g;

/**
 * Bazowa normalizacja tekstu odpowiedzi (design „Normalizacja”): NFC,
 * przycięcie, ujednolicenie apostrofów, lowercase, usunięcie interpunkcji
 * poza apostrofem wewnątrz słowa i minusem liczby ujemnej, zwinięcie spacji
 * i tokenizacja. Pusty tekst daje pustą listę. Rozwijanie skrótów należy do
 * normalizatora przedmiotu.
 */
export function normalizeTokens(text: string): string[] {
  const prepared = text
    .normalize("NFC")
    .replace(APOSTROPHE_VARIANTS, "'")
    .toLowerCase()
    .replace(MINUS_VARIANTS, "-")
    .replace(LEADING_SIGN, "-")
    .replace(NON_WORD, " ");
  return prepared
    .split(" ")
    .map((token) => token.replace(EDGE_APOSTROPHES, ""))
    .filter((token) => token !== "");
}

/**
 * Bazowy normalizator przedmiotowo-niezależny. Zwraca jedną sekwencję tokenów
 * (silnik nie zakłada wariantów); przedmioty dekorują go o własne rozwinięcia.
 */
export const baseNormalizer: AnswerNormalizer = {
  normalize(text: string): string[][] {
    return [normalizeTokens(text)];
  },
};
