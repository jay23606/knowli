import type { AnswerNormalizer, LessonExerciseDraft } from "../../types";

/**
 * Bramka podpowiedzi pytania otwartego przedmiotów szkolnych (design etapu 1
 * §4.4): podpowiedź ma kierować rozumowaniem, a nie zawierać odpowiedź, jej
 * wariant ani element wymagany. Brak lematyzatora, więc to przybliżenie oparte
 * na wspólnym prefiksie słów; fałszywe odrzucenia mierzy etap 3.
 */

/** Najkrótsze słowo uznawane za treściowe (chyba że zawiera cyfrę) i dopuszczające dopasowanie po prefiksie. */
const MIN_CONTENT_LENGTH = 4;
/** Najkrótszy wspólny prefiks dwóch odmian tego samego słowa. */
const MIN_COMMON_PREFIX = 3;
/** O ile liter krótsze ze słów może być dłuższe od wspólnego prefiksu (końcówka fleksyjna). */
const MAX_ENDING_LENGTH = 3;

const hasDigit = (token: string): boolean => /\p{N}/u.test(token);

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let length = 0;
  while (length < limit && a[length] === b[length]) length += 1;
  return length;
}

/**
 * Czy dwa słowa to to samo słowo w różnych formach: równe albo oba mają co
 * najmniej 4 litery i wspólny prefiks ≥ max(3, krótsze − 3). Liczby (tokeny
 * z cyfrą) pasują tylko przy równości — „1410” i „1411” to różne daty.
 */
export function stemMatches(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left === right) return true;
  if (hasDigit(left) || hasDigit(right)) return false;
  if (left.length < MIN_CONTENT_LENGTH || right.length < MIN_CONTENT_LENGTH) return false;
  return commonPrefixLength(left, right) >= Math.max(MIN_COMMON_PREFIX, Math.min(left.length, right.length) - MAX_ENDING_LENGTH);
}

/** Tokeny po normalizatorze przedmiotu; warianty (np. rozwinięcia skrótów) zlewane w jeden zbiór. */
function tokens(text: string, normalizer: AnswerNormalizer): string[] {
  return normalizer.normalize(text).flat();
}

/** Słowa treściowe frazy; fraza bez takich słów — wszystkie jej tokeny. */
function contentWords(phrase: string, normalizer: AnswerNormalizer): string[] {
  // Fraza (odpowiedź) liczy się po pierwszym, kanonicznym wariancie normalizatora.
  const all = normalizer.normalize(phrase)[0] ?? [];
  const content = all.filter((token) => token.length >= MIN_CONTENT_LENGTH || hasDigit(token));
  return content.length > 0 ? content : all;
}

/** Fraza jest zawarta w podpowiedzi, gdy zgodne słowo ma co najmniej połowa jej słów treściowych (w górę; 1–2 słowa — wszystkie). */
function phraseContained(phrase: string, hintTokens: readonly string[], normalizer: AnswerNormalizer): boolean {
  const words = contentWords(phrase, normalizer);
  if (words.length === 0) return false;
  const matched = words.filter((word) => hintTokens.some((token) => stemMatches(word, token))).length;
  const required = words.length <= 2 ? words.length : Math.ceil(words.length / 2);
  return matched >= required;
}

/** Czy podpowiedź zawiera odpowiedź, któryś wariant odpowiedzi albo element wymagany ćwiczenia. */
export function hintRevealsAnswer(hint: string, draft: LessonExerciseDraft, normalizer: AnswerNormalizer): boolean {
  const hintTokens = tokens(hint, normalizer);
  if (hintTokens.length === 0) return false;
  const phrases = [draft.answer, ...draft.acceptedAnswers, ...(draft.requiredElements ?? []).map((element) => element.text)];
  return phrases.some((phrase) => phraseContained(phrase, hintTokens, normalizer));
}
