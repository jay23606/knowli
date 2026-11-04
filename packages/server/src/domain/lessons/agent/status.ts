import { lessonCoverageGapSources, lessonPoolMinimums } from "../lesson-coverage";
import { outsideStagePath, stageOf } from "../stages";
import type { LessonExerciseDraft, SubjectAgentPolicy } from "../types";
import { snapshotOf, type AgentCheckContext, type ObjectiveAgentLimits } from "./admission";
import { allExamples, orderedEntries, orderedLesson, type LessonAgentState } from "./state";

/**
 * Status zagadnienia, limity i kontrola końcowa (spec §3.5–3.6). Czyste
 * funkcje nad jawnym stanem; bez I/O, czasu i losowości.
 */

/** Przykładów kart na zagadnienie: co najmniej 1, najwyżej 3 (jak w `submitExamples`). */
const MIN_CARD_EXAMPLES = 1;
const MAX_CARD_EXAMPLES = 3;

/** `maxExercises` = `targetCount` + `listenAllowance` + `slack` (§3.5). */
export function objectiveAgentLimits(
  counts: { targetCount: number; listenAllowance: number },
  policy: Pick<SubjectAgentPolicy, "slack">,
): ObjectiveAgentLimits {
  return {
    targetCount: counts.targetCount,
    listenAllowance: counts.listenAllowance,
    maxExercises: counts.targetCount + counts.listenAllowance + policy.slack,
  };
}

/**
 * Surowe liczby ćwiczeń zagadnienia (`fixed` i pula, także ujawnione):
 * `total` nie obejmuje typów poza ścieżką etapów (`outsideStages`).
 */
export interface ObjectiveCounts {
  readonly guided: number;
  readonly productive: number;
  readonly independent: number;
  readonly outsideStages: number;
  readonly total: number;
}

export interface ObjectiveStatus {
  readonly counts: ObjectiveCounts;
  /** Braki dla modelu (angielski); puste = zagadnienie kompletne. */
  readonly missing: string[];
  readonly complete: boolean;
}

const ASSESSED = ["guided", "productive", "independent"] as const;

function countsOf(drafts: readonly LessonExerciseDraft[]): ObjectiveCounts {
  const counts = { guided: 0, productive: 0, independent: 0, outsideStages: 0, total: 0 };
  for (const draft of drafts) {
    if (outsideStagePath(draft.exerciseType)) {
      counts.outsideStages += 1;
      continue;
    }
    counts.total += 1;
    const stage = stageOf(draft.exerciseType);
    if (stage !== "intro") counts[stage] += 1;
  }
  return counts;
}

function limitsOf(ctx: AgentCheckContext, objectiveId: string): ObjectiveAgentLimits {
  const limits = ctx.limits.get(objectiveId);
  if (limits === undefined) throw new Error(`no limits for objective ${objectiveId}`);
  return limits;
}

/**
 * Status zagadnienia na CAŁEJ lekcji (§3.5): pokrycie etapów (ćwiczenia
 * ujawnione się nie liczą; minimum samodzielnych podniesione o
 * `independentReserve`), osobno reguła różnych odpowiedzi otwartych
 * (szkoła: „distinct open answers: n of 2”), liczba ćwiczeń, wymagane
 * typy, przykłady kart i braki przedmiotu. `fixed` zagadnienia liczą się wszędzie.
 */
export function objectiveStatus(state: LessonAgentState, objectiveId: string, ctx: AgentCheckContext): ObjectiveStatus {
  const objective = state.objectives.find((item) => item.id === objectiveId);
  if (objective === undefined) throw new Error(`unknown objective ${objectiveId}`);
  const limits = limitsOf(ctx, objectiveId);
  const { subject, material } = ctx;
  const drafts = orderedEntries(state)
    .filter((entry) => entry.objectiveId === objectiveId)
    .map((entry) => entry.draft);
  const counts = countsOf(drafts);
  const missing: string[] = [];

  const base = lessonPoolMinimums(subject);
  const required = { ...base, independent: base.independent + subject.agentPolicy.independentReserve };
  // Źródła braków osobno: reguła różnych odpowiedzi otwartych (szkoła) ma własny komunikat, bo jako
  // brak etapu samodzielnego zaniżałaby liczbę („independent: 2 of 3” przy trzech ćwiczeniach).
  const gaps = lessonCoverageGapSources({
    subject: { ...subject, poolMinimums: required },
    exercises: orderedLesson(state),
    examples: allExamples(state),
    objectiveIds: state.objectives.map((item) => item.id),
  });
  for (const stage of ASSESSED) {
    const gap = gaps.stages.find((item) => item.objectiveId === objectiveId && item.stage === stage);
    if (gap !== undefined) missing.push(`${stage}: ${gap.actual} of ${gap.required}`);
  }
  const distinct = gaps.distinctOpenAnswers.find((item) => item.objectiveId === objectiveId);
  if (distinct !== undefined) missing.push(`distinct open answers: ${distinct.actual} of ${distinct.required}`);

  if (counts.total < limits.targetCount) missing.push(`exercises: ${counts.total} of ${limits.targetCount}`);

  // Grupy wymaganych typów: rdzeń odfiltrowuje typy, których zagadnienie nie dopuszcza.
  for (const group of subject.agentPolicy.requiredTypes?.(objective) ?? []) {
    const allowed = group.filter((type) => objective.exerciseTypes.includes(type));
    if (allowed.length === 0) continue;
    if (!drafts.some((draft) => allowed.includes(draft.exerciseType))) missing.push(`needs at least one ${allowed.join(" or ")}`);
  }

  const examples = state.examples.get(objectiveId)?.length ?? 0;
  if (examples < MIN_CARD_EXAMPLES || examples > MAX_CARD_EXAMPLES) {
    missing.push(`card examples: ${examples} of ${MIN_CARD_EXAMPLES}-${MAX_CARD_EXAMPLES}`);
  }

  missing.push(...(subject.agentPolicy.objectiveGaps?.(drafts, objective, { material }) ?? []));
  return { counts, missing, complete: missing.length === 0 };
}

/**
 * Bezpiecznik po zakończeniu podagentów (§3.6): `findExposureLeaks` (coverage)
 * i `validatePool`/`validatePoolExtra` całej lekcji. Przy zachowanym
 * niezmienniku przyjmowania pusta lista; inaczej ćwiczenia PULI do usunięcia:
 * ofiary z pul, a dla ofiary `fixed` — źródło ujawnienia, o ile jest z puli
 * (przykład karty i `fixed` nie są do usunięcia). Nigdy nie zwraca `fixed`.
 */
export function lessonInvariantCheck(state: LessonAgentState, ctx: AgentCheckContext): { objectiveId: string; id: string }[] {
  const snapshot = snapshotOf(state, ctx);
  const doomed = new Set<number>();
  snapshot.entries.forEach((entry, index) => {
    if (snapshot.poolRejected.has(entry.draft) || snapshot.extraRejected.has(entry.draft)) doomed.add(index);
  });
  snapshot.entries.forEach((victim, index) => {
    const leak = snapshot.leaked.get(victim.draft);
    if (leak === undefined) return;
    if (victim.id !== null) {
      doomed.add(index);
    } else if (leak.source.kind === "exercise") {
      doomed.add(leak.source.index);
    }
  });
  return [...doomed]
    .sort((a, b) => a - b)
    .flatMap((index) => {
      const entry = snapshot.entries[index]!;
      return entry.id === null ? [] : [{ objectiveId: entry.objectiveId, id: entry.id }];
    });
}
