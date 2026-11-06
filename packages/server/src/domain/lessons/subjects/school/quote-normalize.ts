import { MAX_SOURCE_QUOTE_LENGTH, MIN_SOURCE_QUOTE_LENGTH } from "@learning/contracts";

/**
 * Dopasowanie cytatu `sourceRefs` do materiału rodzica (spec katalogu reguł §5.2).
 * Cytat i materiał porównujemy po normalizacji wyłącznie typograficznej: NFC,
 * bez znaków niewidocznych, cudzysłowy i myślniki do prostych, `…` do `...`,
 * zwinięte białe znaki i małe litery. Słowa, liczby i kolejność muszą się
 * zgadzać, a wielokropek w środku cytatu nie łączy dwóch fragmentów (cytat
 * z „...” pasuje tylko do materiału z tym wielokropkiem). Porównanie treści
 * pytań rodziny ma własną normalizację (`validators.ts`) i się nie zmienia.
 */

/** Znaki niewidoczne usuwane przed porównaniem: miękki dywiz, spacje i łączniki zerowej szerokości, BOM. */
const INVISIBLE = /[\u00AD\u200B-\u200D\uFEFF]/gu;
/** Cudzysłowy podwójne: „ ” “ « » (oraz prosty, który zostaje). */
const DOUBLE_QUOTES = /[„”“«»]/gu;
/** Cudzysłowy pojedyncze: ‚ ‘ ’. */
const SINGLE_QUOTES = /[‚‘’]/gu;
/** Łączniki i myślniki: ‐ ‑ ‒ – — ― −. */
const DASHES = /[‐‑‒–—―−]/gu;
const ELLIPSIS = /…/gu;
const WHITESPACE = /^\s+$/u;
/**
 * Wiodący znacznik listy w cytacie (po normalizacji): `•`, `-` albo `*`, albo numer porządkowy
 * z 1–2 cyfr z `.` lub `)` i spacją. Dłuższa liczba (np. rok „1411.”) to treść cytatu, nie znacznik.
 */
const LIST_MARKER = /^(?:•\s*|[-*]\s+|\d{1,2}[.)]\s+)/u;

const graphemes = new Intl.Segmenter("pl", { granularity: "grapheme" });

interface NormalizedText {
  /** Tekst znormalizowany. */
  readonly text: string;
  /** `map[i]` — indeks w `source` początku grafemu, z którego powstał znak `i` tekstu znormalizowanego. */
  readonly map: number[];
  /** `ends[i]` — indeks w `source` końca tego grafemu (granica wycinka bez ucinania znaków łączących). */
  readonly ends: number[];
  /** Tekst po NFC całości, do którego odnoszą się `map` i `ends`. */
  readonly source: string;
}

function normalizeWithMap(text: string): NormalizedText {
  // NFC całego tekstu przed mapowaniem: składanie znaków nie zależy od podziału na grafemy.
  const source = text.normalize("NFC");
  let out = "";
  const map: number[] = [];
  const ends: number[] = [];
  let pendingSpace: { start: number; end: number } | undefined;
  for (const { segment, index } of graphemes.segment(source)) {
    const end = index + segment.length;
    const visible = segment.replace(INVISIBLE, "");
    if (visible === "") continue;
    if (WHITESPACE.test(visible)) {
      // Zwinięcie: jedna spacja z pierwszego białego znaku serii, bez spacji na początku i na końcu.
      if (out !== "" && pendingSpace === undefined) pendingSpace = { start: index, end };
      continue;
    }
    if (pendingSpace !== undefined) {
      out += " ";
      map.push(pendingSpace.start);
      ends.push(pendingSpace.end);
      pendingSpace = undefined;
    }
    const normalized = visible
      .replace(DOUBLE_QUOTES, "\"")
      .replace(SINGLE_QUOTES, "'")
      .replace(DASHES, "-")
      .replace(ELLIPSIS, "...")
      .toLocaleLowerCase("pl");
    for (let offset = 0; offset < normalized.length; offset += 1) {
      map.push(index);
      ends.push(end);
    }
    out += normalized;
  }
  return { text: out, map, ends, source };
}

/**
 * Normalizacja cytatu albo materiału do dopasowania. `map[i]` to indeks w
 * `text.normalize("NFC")` (dla tekstu w NFC — w samym tekście) początku
 * grafemu, z którego powstał znak `i` wyniku.
 */
export function normalizeQuote(text: string): { text: string; map: number[] } {
  const { text: normalized, map } = normalizeWithMap(text);
  return { text: normalized, map };
}

/** Ostatni znormalizowany materiał (jeden wpis): walidacja puli porównuje z nim wiele cytatów. */
let lastMaterial: { readonly material: string; readonly normalized: NormalizedText } | undefined;

function normalizedMaterial(material: string): NormalizedText {
  if (lastMaterial?.material !== material) lastMaterial = { material, normalized: normalizeWithMap(material) };
  return lastMaterial.normalized;
}

/** Cytat znormalizowany do wyszukania w materiale: dodatkowo bez wiodącego znacznika listy. */
function quoteKey(quote: string): string {
  return normalizeWithMap(quote).text.replace(LIST_MARKER, "");
}

/** Długość cytatu do reguły minimalnej długości: jak dotąd, po NFC i zwinięciu białych znaków. */
export function groundedQuoteLength(quote: string): number {
  return quote.normalize("NFC").replace(/\s+/g, " ").trim().length;
}

/** Wycinek materiału dla zakresu tekstu znormalizowanego: zwinięte białe znaki, bez znaków niewidocznych. */
function materialSlice(normalized: NormalizedText, from: number, length: number): string {
  const start = normalized.map[from]!;
  const end = normalized.ends[from + length - 1]!;
  return normalized.source.slice(start, end).replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
}

/** Wynik uziemienia jednego cytatu (bez cytatów rodzica — te pomija wołający). */
export type QuoteGrounding =
  | { readonly kind: "ok" }
  | { readonly kind: "too_short"; readonly length: number }
  /** `matchedPrefix` — fragment materiału odpowiadający najdłuższemu pasującemu początkowi cytatu (pusty, gdy brak). */
  | { readonly kind: "not_in_material"; readonly matchedPrefix: string };

/** Najdłuższy początek klucza obecny w materiale (wyszukiwanie binarne po długości: początki są monotoniczne). */
function longestPrefix(key: string, material: NormalizedText): string {
  let low = 0;
  let high = key.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (material.text.includes(key.slice(0, middle))) low = middle;
    else high = middle - 1;
  }
  if (low === 0) return "";
  return materialSlice(material, material.text.indexOf(key.slice(0, low)), low);
}

/** Czy cytat jest uziemiony w materiale: długość minimalna jak dotąd, dopasowanie po normalizacji. */
export function quoteGrounding(quote: string, material: string): QuoteGrounding {
  const length = groundedQuoteLength(quote);
  if (length < MIN_SOURCE_QUOTE_LENGTH) return { kind: "too_short", length };
  const key = quoteKey(quote);
  const normalized = normalizedMaterial(material);
  if (key !== "" && normalized.text.includes(key)) return { kind: "ok" };
  return { kind: "not_in_material", matchedPrefix: longestPrefix(key, normalized) };
}

/**
 * Dokładny fragment materiału, do którego pasuje cytat (do zapisu zamiast
 * cytatu modelu, żeby rodzic i grader widzieli tekst materiału). `null`, gdy
 * cytat nie pasuje albo wycinek sam nie przeszedłby uziemienia lub limitu
 * długości kontraktu — wtedy zostaje cytat modelu.
 */
export function snapQuote(quote: string, material: string): string | null {
  const key = quoteKey(quote);
  if (key === "") return null;
  const normalized = normalizedMaterial(material);
  const from = normalized.text.indexOf(key);
  if (from < 0) return null;
  const snapped = materialSlice(normalized, from, key.length);
  if (snapped.length === 0 || snapped.length > MAX_SOURCE_QUOTE_LENGTH) return null;
  return quoteGrounding(snapped, material).kind === "ok" ? snapped : null;
}
