import type { SubjectModule } from "../../../domain/lessons/types";
import type { LoadedExercise } from "./lesson-materialize";

/**
 * Jedna reguła gotowości bodźca „Posłuchaj i wybierz” (`lesson_listen_choice`,
 * spec #198 §7.1): id gotowego nagrania pełnego zdania (`feedback_audio`) albo
 * `null`. Wymaga przedmiotu z nagraniami zdań, trybu treningu (kartkówka nie
 * wydaje zadań słuchowych) i nagrania rozwiązanego przez `loadExercises`
 * (najnowszy gotowy zasób o oczekiwanym fingerprincie). Używają jej i kandydaci
 * selektora (`stimulusAudioReady`), i materializacja — brak = niegotowe.
 */
export function listenStimulusAssetId(
  exercise: LoadedExercise,
  subject: Pick<SubjectModule, "ttsForFeedbackSentence">,
  mode: "training" | "mock_test",
): string | null {
  return subject.ttsForFeedbackSentence && mode === "training" ? exercise.feedbackAudioAssetId ?? null : null;
}
