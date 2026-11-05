import { lessonCoverageGapSources, lessonPoolMinimums } from "../lesson-coverage";
import { outsideStagePath, stageOf } from "../stages";
import type { AgentObjective, LessonExerciseDraft, LessonTopic, SubjectAgentPolicy } from "../types";
import { removeExercise, snapshotOf, type AgentCheckContext, type ObjectiveAgentLimits } from "./admission";
import type { AgentCapableSubject } from "./capable";
import {
  allExamples,
  createLessonAgentState,
  orderedEntries,
  orderedLesson,
  poolOf,
  withPool,
  type AgentPoolEntry,
  type LessonAgentState,
} from "./state";

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

/** Braki etapów zagadnienia (wymagane − jest, ≥ 0) — te same, co pozycje etapów w `missing`. */
export interface StageGaps {
  readonly guided: number;
  readonly productive: number;
  readonly independent: number;
}

export interface ObjectiveStatus {
  readonly counts: ObjectiveCounts;
  readonly stageGaps: StageGaps;
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
  const stageGaps = { guided: 0, productive: 0, independent: 0 };

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
    if (gap === undefined) continue;
    missing.push(`${stage}: ${gap.actual} of ${gap.required}`);
    stageGaps[stage] = Math.max(0, gap.required - gap.actual);
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
  return { counts, stageGaps, missing, complete: missing.length === 0 };
}

/** Suma braków etapów zagadnienia (tryb „dodaj N”, spec etapu 2a §6.4). */
export function stageGapOf(status: ObjectiveStatus): number {
  return status.stageGaps.guided + status.stageGaps.productive + status.stageGaps.independent;
}

/**
 * Komplet w trybie „dodaj N” (§6.4): co najmniej `remaining` nowych ćwiczeń i brak braków etapów.
 * Pozostałe braki statusu (liczba ćwiczeń, wymagane typy, przykłady, braki przedmiotu) zostają w
 * `missing` jako wskazówki dla modelu, po pozycji `new exercises: k of N`.
 */
export function addModeStatus(
  status: ObjectiveStatus,
  added: number,
  remaining: number,
): { readonly missing: string[]; readonly complete: boolean } {
  return {
    missing: [`new exercises: ${added} of ${remaining}`, ...status.missing],
    complete: added >= remaining && stageGapOf(status) === 0,
  };
}

/** Nowe ćwiczenia zagadnienia w tym runie: pula (bez `fixed`) na ścieżce etapów, jak `counts.total`. */
export function addedStageExercises(state: LessonAgentState, objectiveId: string): number {
  return orderedEntries(state).filter(
    (entry) => entry.objectiveId === objectiveId && entry.id !== null && !outsideStagePath(entry.draft.exerciseType),
  ).length;
}

/**
 * Status zagadnienia w trybie runu: bez `add` — `objectiveStatus`; z `add` — `missing` i `complete`
 * z `addModeStatus` (wspólne źródło dla narzędzi podagenta i kierownika).
 */
export function objectiveStatusFor(
  state: LessonAgentState,
  objectiveId: string,
  ctx: AgentCheckContext,
  add?: { readonly remaining: number },
): ObjectiveStatus {
  const status = objectiveStatus(state, objectiveId, ctx);
  if (add === undefined) return status;
  return { ...status, ...addModeStatus(status, addedStageExercises(state, objectiveId), add.remaining) };
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

/**
 * Kontrola końcowa na całości przed zapisem do szkicu (spec etapu 2a §10 pkt 2): ćwiczenia `accepted`
 * (wszystkie zagadnienia, także z różnych prób) są pulą, `fixed` (szkic w trybie „dodaj N”) jest
 * nietykalne. `lessonInvariantCheck` + `removeExercise` (z osieroconymi słowami kluczowymi) łapią
 * ujawnienia i duplikaty między próbami oraz migawki sprzed bezpiecznika kierownika. `kept` w kolejności
 * `accepted`; `removed` liczy się do `rejectedCount`.
 */
export function finalLessonCheck(args: {
  readonly subject: AgentCapableSubject;
  readonly topic: LessonTopic;
  readonly objectives: readonly AgentObjective[];
  readonly material: string;
  readonly fixed: readonly LessonExerciseDraft[];
  readonly accepted: readonly { readonly objectiveId: string; readonly draft: LessonExerciseDraft }[];
  readonly examples: Readonly<Record<string, readonly string[]>>;
  readonly limits: ReadonlyMap<string, ObjectiveAgentLimits>;
}): { kept: LessonExerciseDraft[]; removed: number } {
  const ctx: AgentCheckContext = { subject: args.subject, material: args.material, limits: args.limits };
  let state = createLessonAgentState({
    topic: args.topic,
    objectives: args.objectives,
    fixed: args.fixed,
    examples: args.examples,
    fixedSources: {},
  });
  // Pule per zagadnienie w kolejności `accepted`; identyfikatory jak w stanie agenta (`ex1`, `ex2`…).
  const pools = new Map<string, AgentPoolEntry[]>();
  args.accepted.forEach((entry, index) => {
    const pool = pools.get(entry.objectiveId) ?? [];
    pool.push({ id: `ex${index + 1}`, draft: entry.draft });
    pools.set(entry.objectiveId, pool);
  });
  for (const [objectiveId, pool] of pools) state = withPool(state, objectiveId, pool);
  state = { ...state, nextId: args.accepted.length + 1 };

  for (const violation of lessonInvariantCheck(state, ctx)) {
    state = removeExercise(state, violation.objectiveId, violation.id, ctx).state;
  }
  const survivors = new Set(args.objectives.flatMap((objective) => poolOf(state, objective.id).map((entry) => entry.id)));
  const kept = args.accepted.flatMap((entry, index) => (survivors.has(`ex${index + 1}`) ? [entry.draft] : []));
  return { kept, removed: args.accepted.length - kept.length };
}

/**
 * Zagadnienia kompletne na lekcji po zapisie (spec etapu 2a §11): stan jak w `finalLessonCheck` —
 * `fixed` nietykalne, zapisane ćwiczenia jako pule zagadnień w kolejności `written` — i `objectiveStatus`
 * każdego zagadnienia tematu. `examples` (własne przykłady kart zagadnień) i `fixedSources` (pozostałe
 * źródła ujawnień) jak w stanie kierownika, żeby liczba przykładów kart i ujawnienia liczyły się tak samo.
 */
export function completeObjectivesOnLesson(args: {
  readonly subject: AgentCapableSubject;
  readonly topic: LessonTopic;
  readonly objectives: readonly AgentObjective[];
  readonly material: string;
  readonly fixed: readonly LessonExerciseDraft[];
  readonly written: readonly LessonExerciseDraft[];
  readonly examples: Readonly<Record<string, readonly string[]>>;
  readonly fixedSources: Readonly<Record<string, readonly string[]>>;
  readonly limits: ReadonlyMap<string, ObjectiveAgentLimits>;
}): Set<string> {
  const ctx: AgentCheckContext = { subject: args.subject, material: args.material, limits: args.limits };
  let state = createLessonAgentState({
    topic: args.topic,
    objectives: args.objectives,
    fixed: args.fixed,
    examples: args.examples,
    fixedSources: args.fixedSources,
  });
  const pools = new Map<string, AgentPoolEntry[]>();
  args.written.forEach((draft, index) => {
    const pool = pools.get(draft.objectiveId) ?? [];
    pool.push({ id: `ex${index + 1}`, draft });
    pools.set(draft.objectiveId, pool);
  });
  const known = new Set(args.objectives.map((objective) => objective.id));
  for (const [objectiveId, pool] of pools) if (known.has(objectiveId)) state = withPool(state, objectiveId, pool);
  state = { ...state, nextId: args.written.length + 1 };
  return new Set(args.objectives.filter((objective) => objectiveStatus(state, objective.id, ctx).complete).map((objective) => objective.id));
}
