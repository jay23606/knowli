import { fillCloze } from "../../cloze";
import type { LessonExposureSource } from "../../types";
import { trimTrailing } from "./text";

/**
 * Tekst ekspozycji ćwiczenia rozdziału (design „Angielski — rozdział” §4.5).
 * Lekcja sprawdza użycie słowa w zdaniu, więc dziecko „widzi rozwiązane”
 * całe zdanie, a nie pojedyncze słowo: wybór i luka dają zdanie ze wstawioną
 * odpowiedzią, tekst z lukami — cały uzupełniony tekst, układanka
 * i tłumaczenie — odpowiedź, pary i grupy — złączoną odpowiedź jak dotąd.
 * Wynik jest znormalizowany `normalizeChapterExposureText`, więc „It's
 * snowing.” i „It’s snowing” to ta sama ekspozycja; małe litery dokłada
 * `computeTargetKey`.
 */

/** Luka w zdaniu: ciąg 2+ podkreśleń (ta sama reguła co `cloze.ts` i Kid UI). */
const GAP = /_{2,}/u;
/** Końcowa interpunkcja ekspozycji; białe znaki są już zredukowane do spacji. */
const TRAILING_PUNCTUATION: ReadonlySet<string> = new Set([".", "!", "?", "…", " "]);
/** Typograficzne apostrofy i pojedyncze cudzysłowy → `'`. */
const SINGLE_QUOTES = /[‘’‚‛]/gu;
/** Typograficzne cudzysłowy (także polski „) → `"`. */
const DOUBLE_QUOTES = /[“”„‟]/gu;

/**
 * Normalizacja tekstu ekspozycji przedmiotu (`SubjectModule.normalizeExposureText`):
 * NFC, prosty apostrof i cudzysłów zamiast typograficznych, jedna spacja
 * zamiast białych znaków, bez zewnętrznych spacji i bez końcowej interpunkcji
 * `.!?…`. Ta sama funkcja obsługuje ćwiczenia (`chapterExposureText`) i
 * przykłady kart, więc przykład „I’m wearing a pink coat.” i luka rozwiązana
 * do „I'm wearing a pink coat” mają jeden klucz. Idempotentna. Kontrakt
 * utrwalony w `target_key` — zmiana wymaga decyzji o migracji kluczy.
 */
export function normalizeChapterExposureText(text: string): string {
  const collapsed = text
    .normalize("NFC")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(/\s+/gu, " ")
    .trim();
  return trimTrailing(collapsed, TRAILING_PUNCTUATION);
}

/** Zdanie ze wstawionym słowem w miejscu luki; zdanie bez luki daje samo słowo. */
function fillStem(stem: string | undefined, word: string): string {
  return stem !== undefined && GAP.test(stem) ? stem.replace(GAP, () => word) : word;
}

/** Tekst poprawnej opcji wyboru; bez niej — odpowiedź kanoniczna. */
function correctOptionText(draft: LessonExposureSource): string {
  return draft.options?.find((option) => option.id === draft.correctOption)?.text ?? draft.answer;
}

export function chapterExposureText(draft: LessonExposureSource): string {
  switch (draft.exerciseType) {
    case "lesson_choice":
    case "lesson_listen_choice":
      return normalizeChapterExposureText(fillStem(draft.stem, correctOptionText(draft)));
    case "lesson_gap":
      return normalizeChapterExposureText(fillStem(draft.stem, draft.answer));
    case "lesson_cloze":
      return normalizeChapterExposureText(draft.clozeText === undefined ? draft.answer : fillCloze(draft.clozeText, draft.gapAnswers ?? []));
    default:
      return normalizeChapterExposureText(draft.answer);
  }
}

/**
 * Kolejne podziały linii karty na części: „ — ” i „ / ” (słówko — tłumaczenie /
 * przykład), etykieta „: ” („Na przykład: …”), „; ” i granica zdań po `.?!`
 * (także z cudzysłowem zamykającym za znakiem: „There is a bed.” „I like it.”).
 * Separatory dopasowują sam znak z otoczeniem w lookaroundach (bez `\s+`),
 * więc długi ciąg spacji nie wywołuje nawrotów; spacje części obcina `trim()`.
 */
const CARD_PART_SEPARATORS: readonly RegExp[] = [/(?<=\s)[—/](?=\s)/u, /:(?=\s)/u, /;(?=\s)/u, /(?<=[.?!][”“"»]?)(?=\s)/u];
/** Punktor albo numeracja na początku części: „- ”, „• ”, „* ”, „1. ”, „1) ”. */
const CARD_BULLET = /^(?:[-•*]|\d+[.)])\s+/u;
/** Cudzysłowy na początku zdania; na końcu obcina je `trimTrailing` (liniowo, bez `[…]+$`). */
const CARD_LEADING_QUOTES = /^[„“”"«»]+/u;
const CARD_QUOTE_CHARS: ReadonlySet<string> = new Set(["„", "“", "”", "\"", "«", "»"]);
/** Zdanie angielskie: litery ASCII, cyfry („I have 2 cats.”), apostrof, spacje, interpunkcja zdania i łącznik wewnątrz słowa („T-shirt”). */
const CARD_SENTENCE = /^[A-Za-z](?:[A-Za-z0-9' ,.?!]|(?<=[A-Za-z])-(?=[A-Za-z]))*$/u;

/** Części linii po wszystkich separatorach, w kolejności występowania. */
function cardLineParts(line: string): string[] {
  return CARD_PART_SEPARATORS.reduce<string[]>(
    (parts, separator) => parts.flatMap((part) => part.split(separator)),
    [line],
  );
}

/** Część bez punktora, numeracji i cudzysłowów na brzegach; apostrof typograficzny → `'`. */
function cleanCardPart(part: string): string {
  const unbulleted = part.trim().replace(/[’‘]/gu, "'").replace(CARD_BULLET, "");
  return trimTrailing(unbulleted.replace(CARD_LEADING_QUOTES, ""), CARD_QUOTE_CHARS).trim();
}

/**
 * Teksty z treści kart rozdziału, które dziecko widzi jako gotowe rozwiązania
 * (`SubjectModule.cardExposureTexts`): zdania angielskie z przykładów kart.
 * Karta ramy to polskie wyjaśnienie z 1–3 przykładami angielskimi
 * (`objectivesRules`), więc linie dzielą się kolejno po „ — ” i „ / ”, po
 * etykiecie „: ” („Na przykład: …”), po „; ” i na granicach zdań po `.?!`;
 * z każdej części odpada punktor lub numeracja („- ”, „• ”, „* ”, „1. ”, „1) ”)
 * i cudzysłowy na obu brzegach („…”, "…", «…»). Część zostaje, gdy jest
 * zdaniem: bez wielokropka (rama do uzupełnienia), złożona z liter ASCII,
 * apostrofu, spacji i interpunkcji zdania (polska część odpada na znakach
 * diakrytycznych) oraz zakończona `.?!` albo licząca ≥ 3 słowa (samo słówko
 * nie jest zdaniem). Świadomy koszt: polskie zdanie bez znaków diakrytycznych
 * przechodzi. Apostrof typograficzny → `'`, duplikaty usunięte. Używane tylko
 * przy generowaniu.
 */
export function chapterCardExposureTexts(cards: readonly { readonly body: string }[]): string[] {
  const sentences: string[] = [];
  for (const card of cards) {
    for (const rawLine of card.body.split(/\r?\n/u)) {
      for (const part of cardLineParts(rawLine)) {
        const text = cleanCardPart(part);
        if (text === "" || /…|\.\.\./u.test(text) || !CARD_SENTENCE.test(text)) continue;
        if (/[.?!]$/u.test(text) || text.split(/\s+/u).length >= 3) sentences.push(text);
      }
    }
  }
  return [...new Set(sentences)];
}
