import { HARD_REVIEW_CATEGORIES, NOTE_ONLY_REVIEW_CATEGORIES, type ReviewCategory } from "./review-criteria";

/** Werdykt krytyka po sparsowaniu; `fixValid` ustala orchestrator (walidacja poprawionego ćwiczenia). */
export type ParsedVerdict =
  | { n: number; verdict: "ok" }
  | { n: number; verdict: "note" | "drop"; category: ReviewCategory; reasonPl: string }
  | { n: number; verdict: "fix"; category: ReviewCategory; reasonPl: string; fixValid: boolean };

export type ExerciseOutcome =
  | { kind: "keep" }
  | { kind: "keep_with_note"; category: ReviewCategory; reasonPl: string; fixRejected: boolean }
  | { kind: "replace"; category: ReviewCategory; reasonPl: string }
  | { kind: "drop"; category: ReviewCategory; reasonPl: string };

export interface ObjectiveReviewDecision {
  /** Jeden wynik na świeże ćwiczenie, w kolejności (indeks 0-based = n − 1). */
  readonly outcomes: readonly ExerciseOutcome[];
  readonly status: "reviewed" | "suspicious";
  readonly invalidVerdicts: number;
}

function decideOne(verdict: Exclude<ParsedVerdict, { verdict: "ok" }>, isCalculation: boolean): ExerciseOutcome {
  const { category, reasonPl } = verdict;
  const note = (fixRejected: boolean): ExerciseOutcome => ({ kind: "keep_with_note", category, reasonPl, fixRejected });
  const hard = HARD_REVIEW_CATEGORIES.has(category);

  if (verdict.verdict === "note" || NOTE_ONLY_REVIEW_CATEGORIES.has(category)) return note(false);
  if (verdict.verdict === "fix") {
    // Odpowiedzi ćwiczeń obliczeniowych liczy kod — poprawka tekstu nie wchodzi w grę.
    if (isCalculation) return note(false);
    if (verdict.fixValid) return { kind: "replace", category, reasonPl };
    return hard ? { kind: "drop", category, reasonPl } : note(true);
  }
  return hard ? { kind: "drop", category, reasonPl } : note(false);
}

/**
 * Zamienia werdykty krytyka dla jednego zagadnienia na wyniki per świeże ćwiczenie.
 * `freshCount` = liczba świeżych ćwiczeń (n = 1…freshCount); `objectiveTotal` = wszystkie
 * ćwiczenia zagadnienia (istniejące + świeże); `calculationIndexes` i `hardLeakIndexes`
 * to indeksy 0-based świeżych ćwiczeń (usunięcia z twardym ujawnieniem nie liczą się
 * do bezpiecznika). Bezpiecznik: gdy zmian (replace + drop poza hardLeakIndexes) jest
 * więcej niż połowa wszystkich ćwiczeń zagadnienia, krytyk jest podejrzany i wszystko zostaje.
 */
export function decideObjectiveReview(input: {
  readonly freshCount: number;
  readonly objectiveTotal: number;
  readonly verdicts: readonly ParsedVerdict[];
  readonly calculationIndexes: ReadonlySet<number>;
  readonly hardLeakIndexes: ReadonlySet<number>;
}): ObjectiveReviewDecision {
  const { freshCount, objectiveTotal, verdicts, calculationIndexes, hardLeakIndexes } = input;
  const outcomes: ExerciseOutcome[] = Array.from({ length: freshCount }, () => ({ kind: "keep" }));
  const seen = new Set<number>();
  let invalidVerdicts = 0;

  for (const verdict of verdicts) {
    if (!Number.isInteger(verdict.n) || verdict.n < 1 || verdict.n > freshCount || seen.has(verdict.n)) {
      invalidVerdicts += 1;
      continue;
    }
    seen.add(verdict.n);
    if (verdict.verdict === "ok") continue;
    const index = verdict.n - 1;
    outcomes[index] = decideOne(verdict, calculationIndexes.has(index));
  }

  const changes = outcomes.filter(
    (outcome, index) => (outcome.kind === "replace" || outcome.kind === "drop") && !hardLeakIndexes.has(index),
  ).length;
  if (changes > objectiveTotal / 2) {
    return { outcomes: outcomes.map(() => ({ kind: "keep" })), status: "suspicious", invalidVerdicts };
  }
  return { outcomes, status: "reviewed", invalidVerdicts };
}
