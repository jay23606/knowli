import type { Grade } from "./types";
import type { FeedbackDto } from "@learning/contracts";
import { computeTargetKey } from "./target-key";
import { normalizeSpokenAnswerText } from "./spoken-answer";
import type { SpellingComparison, SpellingDiffSegment } from "./spelling-diff";

/**
 * Wybór treści feedbacku dla dziecka na podstawie rzeczywistego wyniku
 * (SPEC §16, §12.8). Domena zwraca rodzaj komunikatu i ewentualne poprawne
 * słowo; polskie teksty pochodzą z katalogu komunikatów po stronie klientów.
 * Nigdy nie chwalimy niepoprawnej odpowiedzi jako poprawnej.
 */
export type FeedbackKind =
  | "great"
  | "capitalization_hint"
  | "almost"
  | "incorrect"
  | "content_matched"
  | "not_assessed"
  | "spelling_hint";

export interface FeedbackChoice {
  kind: FeedbackKind;
  /** Rozwiązanie własnego zadania; feedback nie ujawnia obcych celów (arch §9.3). */
  correctText?: string;
  /** Wiarygodny tekst rozpoznany z odpowiedzi ustnej. */
  heardText?: string;
  /** Fragmenty wymowy (design 2026-10-09) — tylko tekst i werdykt, bez liczb. */
  fragments?: Grade["speechFragments"];
  speech?: Grade["speechFeedback"];
  /** Porównanie pisowni przy literówce w progu diagnozy (issue #9). */
  spellingDiff?: { given: SpellingDiffSegment[]; expected: SpellingDiffSegment[]; capitalizationHint?: boolean };
}

function recognizedAnswer(grade: Grade): Pick<FeedbackChoice, "heardText"> | {} {
  return grade.recognizedText ? { heardText: grade.recognizedText } : {};
}

export function chooseFeedback(grade: Grade, correctText: string, diff?: SpellingComparison | null): FeedbackChoice {
  const speech = grade.speechFeedback ? { speech: grade.speechFeedback } : {};
  const assessed = Object.values(grade.skills).filter((skill) => skill.outcome !== "unevaluated");
  if (assessed.length === 0) {
    // ćwiczenie wymowy: usłyszane właściwe słowo bez oceny wymowy (SPEC §15.4)
    // albo rozbieżna treść — szczery komunikat zamiast udawanej oceny
    if (grade.speechAttempt?.contentMatched) return { kind: "content_matched", ...recognizedAnswer(grade), ...speech };
    if (grade.speechAttempt) return { kind: "incorrect", correctText, ...recognizedAnswer(grade), ...speech };
    return { kind: "not_assessed", ...speech };
  }

  const anyCorrect = assessed.some((skill) => skill.outcome === "correct");
  const allCorrect = assessed.every((skill) => skill.outcome === "correct");
  if (allCorrect)
    return {
      kind: "great",
      ...recognizedAnswer(grade),
      ...speech,
      ...(grade.speechFragments ? { fragments: grade.speechFragments } : {}),
    };

  if (anyCorrect) {
    // „To właściwe słowo! Monday piszemy wielką literą” — jedyny defekt
    // to kapitalizacja (SPEC §12.8); w pozostałych przypadkach „Prawie!”.
    const capitalization = assessed.some(
      (skill) => skill.outcome === "incorrect" && skill.details?.spelling?.capitalizationOnlyDefect,
    );
    return capitalization
      ? { kind: "capitalization_hint", correctText, ...recognizedAnswer(grade), ...speech }
      : {
          kind: "almost",
          ...recognizedAnswer(grade),
          ...speech,
          ...(grade.speechFragments ? { fragments: grade.speechFragments } : {}),
        };
  }
  // wymowa blisko progu — „Prawie! Posłuchaj jeszcze raz” (SPEC §16, §18)
  if (assessed.some((skill) => skill.details?.pronunciation?.band === "partial")) {
    return {
      kind: "almost",
      ...recognizedAnswer(grade),
      ...speech,
      ...(grade.speechFragments ? { fragments: grade.speechFragments } : {}),
    };
  }
  // literówka w progu: wpis i właściwy zapis z zaznaczoną różnicą (issue #9);
  // „prawie” odnosi się wyłącznie do zapisu — znaczenie pozostaje niezaliczone
  if (
    diff?.withinThreshold === true &&
    Object.entries(grade.skills).some(([skill, skillGrade]) => skill === "spelling" && skillGrade.outcome === "incorrect")
  ) {
    return {
      kind: "spelling_hint",
      correctText: diff.variant,
      spellingDiff: {
        given: diff.given,
        expected: diff.expected,
        ...(diff.capitalizationHint ? { capitalizationHint: true } : {}),
      },
      ...recognizedAnswer(grade),
      ...speech,
    };
  }
  return { kind: "incorrect", correctText, ...recognizedAnswer(grade), ...speech };
}

/** Klucze celów faktycznie pokazanych dziecku w odpowiedzi feedbacku. */
export function feedbackExposureKeys(feedback: FeedbackDto, canonicalTargetKey: string, targetLocale: string): string[] {
  const texts = [feedback.speech?.referenceText, feedback.heardText, feedback.correctText].filter(
    (text): text is string => Boolean(text),
  );
  const keys = feedback.kind === "not_assessed" ? [] : [canonicalTargetKey];
  for (const text of texts) keys.push(computeTargetKey(normalizeSpokenAnswerText(text), targetLocale));
  return [...new Set(keys)];
}
