/**
 * Tekst „Uzupełnij tekst” (`lesson_cloze`, design szkoły §13): luka to ciąg
 * 2+ podkreśleń (`lessonGapParts` z kontraktów, jak ekran dziecka).
 * Czyste funkcje nad tekstem payloadu, bez bazy i zegara.
 */

import { lessonGapCount as clozeGapCount, lessonGapParts as clozeParts } from "@learning/contracts";

export { clozeGapCount, clozeParts };

/** Tekst z wstawionymi słowami w kolejności luk (feedback, omówienie, podgląd rodzica). */
export function fillCloze(text: string, words: readonly string[]): string {
  return clozeParts(text).reduce((filled, part, index) => (index === 0 ? part : `${filled}${words[index - 1] ?? "___"}${part}`), "");
}

/** Kanoniczna odpowiedź `lesson_cloze` (`targetKey`, podgląd): słowa luk złączone „, ”. */
export function clozeAnswer(ex: { readonly gapAnswers?: readonly string[] }): string {
  return (ex.gapAnswers ?? []).join(", ");
}
