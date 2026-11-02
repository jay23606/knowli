import { computeTargetKey } from "../target-key";
import type { LessonExerciseDraft, SubjectModule } from "./types";

/**
 * `target_key` tekstu ujawnianego dziecku w lekcji (np. przykład na karcie):
 * tekst po normalizacji przedmiotu (`normalizeExposureText`, gdy ją ma)
 * i `computeTargetKey` w języku odpowiedzi. Przedmiot bez normalizacji
 * zachowuje dotychczasowy klucz `computeTargetKey(text, answerLocale)`.
 */
export function lessonTextTargetKey(
  subject: Pick<SubjectModule, "answerLocale" | "normalizeExposureText">,
  text: string,
): string {
  return computeTargetKey(subject.normalizeExposureText?.(text) ?? text, subject.answerLocale);
}

/**
 * Tekst ekspozycji ćwiczenia: to, co dziecko widzi rozwiązane (`exposureText`
 * przedmiotu), a bez niego odpowiedź kanoniczna.
 */
export function exerciseExposureText(
  subject: Pick<SubjectModule, "exposureText">,
  draft: LessonExerciseDraft,
): string {
  return subject.exposureText?.(draft) ?? draft.answer;
}

/**
 * `target_key` ćwiczenia lekcji: klucz ekspozycji liczony z tekstu, który
 * dziecko faktycznie widzi rozwiązany. Domyślnie to odpowiedź kanoniczna
 * (przedmioty bez `exposureText` zachowują dotychczasowy klucz); przedmiot
 * może wskazać inny tekst (np. całe zdanie ze wstawioną odpowiedzią). Tekst
 * przechodzi tę samą normalizację co przykłady kart (`lessonTextTargetKey`).
 * Jedno miejsce dla zapisu rewizji z generacji i z edycji rodzica.
 */
export function lessonExerciseTargetKey(
  subject: Pick<SubjectModule, "answerLocale" | "exposureText" | "normalizeExposureText">,
  draft: LessonExerciseDraft,
): string {
  return lessonTextTargetKey(subject, exerciseExposureText(subject, draft));
}
