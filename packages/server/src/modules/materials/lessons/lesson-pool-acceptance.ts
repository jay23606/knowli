import { stripListenChoiceExtras } from "../../../domain/lessons/material-creation";
import { withoutRedundantAcceptedVariants } from "../../../domain/lessons/pool-validation";
import type { LessonExerciseDraft, SubjectModule } from "../../../domain/lessons/types";
import {
  scopeFamiliesToRun,
  withoutEmptyOptionalArrays,
  withoutInvalidExplanation,
  withoutVoiceToneUnlessAllowed,
} from "./lesson-drafts";

export interface SanitizedFreshDraft {
  readonly draft: LessonExerciseDraft;
  readonly droppedExplanation: boolean;
  /** Liczba wariantów `acceptedAnswers` porzuconych jako redundantne wobec odpowiedzi kanonicznej. */
  readonly droppedVariants: number;
}

/**
 * Sanityzacja jednego świeżego ćwiczenia z wyjścia modelu (kierownik agenta puli).
 * Kolejność kroków jest częścią kontraktu: ton głosu → wyjaśnienie → puste tablice
 * → dodatki ćwiczenia słuchowego → rodziny runu → warianty redundantne. Bez
 * `stripParentAddedFlags` (woła go wywołujący). Warianty acceptedAnswers redundantne
 * wobec odpowiedzi kanonicznej (np. skrótowa forma przeczenia „to be” przy pełnej)
 * porzucamy — bez tego walidacja fazy 1 odrzucałaby całe ćwiczenie za wpis
 * nieznoszący informacji (odpowiedź kanoniczna jest akceptowana automatycznie).
 * Funkcja czysta.
 */
export function sanitizeFreshLessonDraft(
  draft: LessonExerciseDraft,
  subject: SubjectModule,
  familyScope: string | null,
): SanitizedFreshDraft {
  const toned = withoutVoiceToneUnlessAllowed(draft, subject);
  const explained = withoutInvalidExplanation(toned, subject);
  const droppedExplanation = explained !== toned;
  // Ćwiczenie słuchowe nie ma polecenia, podpowiedzi ani piktogramu: dodatek modelu usuwamy, nie odrzucamy ćwiczenia.
  const stripped = stripListenChoiceExtras(withoutEmptyOptionalArrays(explained));
  const scoped = familyScope === null ? stripped : scopeFamiliesToRun(stripped, familyScope);
  const sanitized = withoutRedundantAcceptedVariants(scoped, subject.normalizer);
  return {
    draft: sanitized,
    droppedExplanation,
    droppedVariants: scoped.acceptedAnswers.length - sanitized.acceptedAnswers.length,
  };
}
