import { findExposureLeaks } from "./exposure-leaks";
import { DEFAULT_LESSON_POLICY, type PoolMinimums } from "./lesson-policy";
import { poolCoverage, type CoverageGap } from "./pool-validation";
import type { LessonExerciseDraft, SubjectModule } from "./types";

/**
 * Pokrycie publikacyjne lekcji z wykluczeniem ujawnionych ćwiczeń samodzielnych
 * (spec etapu przeglądu lekcji §3, §5.3): ćwiczenie, którego rozwiązanie dziecko
 * widziało wcześniej, nie jest niezależnym sprawdzianem, więc nie liczy się do
 * etapu. Czyste funkcje nad jawnymi danymi: bez I/O, czasu i losowości.
 */

/** Publikacja zestawu v3 (szkoła) wymaga tylu różnych pytań otwartych na zagadnienie. */
export const DISTINCT_OPEN_ANSWERS_PER_OBJECTIVE = 2;

/** Minima pokrycia publikacji przedmiotu (fallback: polityka domyślna lekcji). */
export function lessonPoolMinimums(subject: Pick<SubjectModule, "poolMinimums">): PoolMinimums {
  return subject.poolMinimums ?? DEFAULT_LESSON_POLICY.poolMinimums;
}

export interface LessonCoverageInput {
  readonly subject: SubjectModule;
  readonly exercises: readonly LessonExerciseDraft[];
  /** Przykłady kart: zagadnienie → teksty. */
  readonly examples: Readonly<Record<string, readonly string[]>>;
  /** Zagadnienia lekcji w jej kolejności. */
  readonly objectiveIds: readonly string[];
  /**
   * Liczy także ujawnione ćwiczenia samodzielne (pokrycie sprzed reguły ujawnień) — tylko do
   * raportu przed/po dla istniejących szkiców; odczyt i publikacja tego nie ustawiają.
   */
  readonly ignoreExposure?: boolean;
}

/** Braki etapów jednego zagadnienia (wynik `stageDeficits`); runda pod etap zamawia dokładnie je. */
export interface StageDeficits {
  readonly guided: number;
  readonly productive: number;
  readonly independent: number;
}

/**
 * Dodatkowa reguła szkoły: zagadnienie potrzebuje co najmniej dwóch RÓŻNYCH
 * pytań otwartych (różne odpowiedzi wzorcowe), nie jednej rodziny sformułowań.
 * Braki w kształcie CoverageGap (etap independent).
 */
function distinctOpenAnswerGaps(
  subject: SubjectModule,
  exercises: readonly LessonExerciseDraft[],
  objectiveIds: readonly string[],
): CoverageGap[] {
  if (subject.usesV3Payload !== true) {
    return [];
  }
  const gaps: CoverageGap[] = [];
  for (const objectiveId of objectiveIds) {
    const distinct = new Set(
      exercises
        .filter((d) => d.objectiveId === objectiveId && d.exerciseType === "lesson_open_answer")
        .map((d) => (subject.normalizer.normalize(d.answer)[0] ?? []).join(" ")),
    );
    if (distinct.size < DISTINCT_OPEN_ANSWERS_PER_OBJECTIVE) {
      gaps.push({ objectiveId, stage: "independent", required: DISTINCT_OPEN_ANSWERS_PER_OBJECTIVE, actual: distinct.size });
    }
  }
  return gaps;
}

/** Łączy braki obu źródeł: jeden wpis na cel+etap, wygrywa większy brak (przy remisie — pokrycie etapów). */
function mergeGaps(base: readonly CoverageGap[], extra: readonly CoverageGap[]): CoverageGap[] {
  const deficit = (gap: CoverageGap): number => gap.required - gap.actual;
  const merged = [...base];
  for (const gap of extra) {
    const index = merged.findIndex((b) => b.objectiveId === gap.objectiveId && b.stage === gap.stage);
    if (index === -1) {
      merged.push(gap);
    } else if (deficit(gap) > deficit(merged[index]!)) {
      merged[index] = gap;
    }
  }
  return merged;
}

/** Braki pokrycia z podziałem na źródła (przed scaleniem w `lessonCoverageGaps`). */
export interface LessonCoverageGapSources {
  /** `poolCoverage` bez ujawnionych ćwiczeń samodzielnych. */
  readonly stages: CoverageGap[];
  /** Reguła różnych odpowiedzi otwartych (szkoła), też bez ujawnionych; `required` = 2. */
  readonly distinctOpenAnswers: CoverageGap[];
  /** Zagadnienie → liczba wykluczonych ujawnionych ćwiczeń. */
  readonly excludedByObjective: ReadonlyMap<string, number>;
}

/**
 * Braki obu źródeł osobno — dla komunikatu, który ma nazwać właściwą przyczynę
 * (np. agent: „distinct open answers” zamiast zaniżonego etapu samodzielnego).
 */
export function lessonCoverageGapSources(input: LessonCoverageInput): LessonCoverageGapSources {
  const { subject, exercises, examples, objectiveIds } = input;
  const leaks = input.ignoreExposure === true
    ? []
    : findExposureLeaks({ exercises, examples, objectiveOrder: objectiveIds, subject, mode: "coverage" });
  const leakedIndexes = new Set(leaks.map((leak) => leak.index));
  const excludedByObjective = new Map<string, number>();
  for (const index of leakedIndexes) {
    const objectiveId = exercises[index]!.objectiveId;
    excludedByObjective.set(objectiveId, (excludedByObjective.get(objectiveId) ?? 0) + 1);
  }
  const counted = exercises.filter((_, index) => !leakedIndexes.has(index));
  return {
    stages: poolCoverage(counted, objectiveIds, lessonPoolMinimums(subject)),
    distinctOpenAnswers: distinctOpenAnswerGaps(subject, counted, objectiveIds),
    excludedByObjective,
  };
}

/**
 * Braki pokrycia: `poolCoverage` bez ujawnionych ćwiczeń samodzielnych (tryb
 * `coverage`) oraz reguła różnych odpowiedzi otwartych (też bez ujawnionych).
 * `excluded` = liczba wykluczonych ujawnionych ćwiczeń zagadnienia w etapie
 * samodzielnym — tylko gdy > 0.
 */
export function lessonCoverageGaps(input: LessonCoverageInput): (CoverageGap & { readonly excluded?: number })[] {
  const sources = lessonCoverageGapSources(input);
  const excludedByObjective = sources.excludedByObjective;
  const gaps = mergeGaps(sources.stages, sources.distinctOpenAnswers);
  return gaps.map((gap) => {
    const excluded = gap.stage === "independent" ? (excludedByObjective.get(gap.objectiveId) ?? 0) : 0;
    return excluded > 0 ? { ...gap, excluded } : gap;
  });
}

/** Brak per etap zagadnienia = max(required − actual) po obu źródłach braków; 0 gdy pokryte. */
export function stageDeficits(input: LessonCoverageInput, objectiveId: string): StageDeficits {
  const deficits = { guided: 0, productive: 0, independent: 0 };
  for (const gap of lessonCoverageGaps(input)) {
    if (gap.objectiveId === objectiveId && (gap.stage === "guided" || gap.stage === "productive" || gap.stage === "independent")) {
      deficits[gap.stage] = Math.max(deficits[gap.stage], gap.required - gap.actual);
    }
  }
  return deficits;
}
