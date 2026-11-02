import { exerciseExposureText } from "./exposure-key";
import type { LeakSubject } from "./exposure-leaks";
import { answersEquivalent } from "./pool-validation";
import { stageOf } from "./stages";
import type { LessonExerciseDraft } from "./types";

/**
 * Zdania do unikania w wejściu generatora (spec etapu przeglądu lekcji §5.2):
 * rozwiązania, które dziecko już widziało (przykłady kart, ćwiczenia
 * niesamodzielne) albo które wystąpią w innych ćwiczeniach, nie powinny być
 * rozwiązaniami ćwiczeń samodzielnych. Lista jest tylko podpowiedzią dla
 * modelu — egzekwuje ją reguła twarda po generacji. Czysta funkcja.
 */

/** Maksymalna liczba zdań na liście. */
export const AVOID_SENTENCES_MAX_ITEMS = 60;
/** Maksymalna łączna liczba znaków zdań na liście. */
export const AVOID_SENTENCES_MAX_CHARS = 4000;

export interface AvoidSentencesInput {
  /** Przykłady kart: zagadnienie → teksty (szkic i nowe z tego przebiegu). */
  readonly examples: Readonly<Record<string, readonly string[]>>;
  /** Szkic i wcześniejsze partie przebiegu (już jako szkice ćwiczeń). */
  readonly exercises: readonly LessonExerciseDraft[];
  readonly subject: LeakSubject;
}

/**
 * Priorytet: wszystkie przykłady kart, potem rozwiązania ćwiczeń niesamodzielnych,
 * potem samodzielnych (w obu grupach najnowsze pierwsze); deduplikacja po
 * `answersEquivalent`; limit 60 pozycji i 4000 znaków łącznie (pozycja
 * przekraczająca limit znaków jest pomijana, kolejne krótsze mogą się zmieścić).
 */
export function avoidSentencesFor(input: AvoidSentencesInput): string[] {
  const { subject } = input;
  const norm = (text: string): string => subject.normalizeExposureText?.(text) ?? text;
  const newestFirst = [...input.exercises].reverse();
  const candidates: string[] = [
    ...Object.values(input.examples).flat(),
    ...newestFirst.filter((exercise) => stageOf(exercise.exerciseType) !== "independent").map((exercise) => exerciseExposureText(subject, exercise)),
    ...newestFirst.filter((exercise) => stageOf(exercise.exerciseType) === "independent").map((exercise) => exerciseExposureText(subject, exercise)),
  ];
  const kept: string[] = [];
  let chars = 0;
  for (const raw of candidates) {
    if (kept.length >= AVOID_SENTENCES_MAX_ITEMS) break;
    const text = raw.trim();
    if (text === "" || chars + text.length > AVOID_SENTENCES_MAX_CHARS) continue;
    if (kept.some((other) => answersEquivalent(norm(text), norm(other), subject.normalizer))) continue;
    kept.push(text);
    chars += text.length;
  }
  return kept;
}
