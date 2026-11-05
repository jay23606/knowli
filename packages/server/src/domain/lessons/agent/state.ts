import { outsideStagePath, stageOf } from "../stages";
import type { AgentObjective, LessonExerciseDraft, LessonStage, LessonTopic } from "../types";

/** Ćwiczenie puli agenta z deterministycznym identyfikatorem nadanym przez stan (`ex1`, `ex2`…). */
export interface AgentPoolEntry {
  readonly id: string;
  readonly draft: LessonExerciseDraft;
}

/**
 * Niezmienny stan lekcji budowanej przez agenta (spec §3.1). Każda operacja
 * zwraca nowy stan; wejście nigdy nie jest mutowane.
 */
export interface LessonAgentState {
  readonly topic: LessonTopic;
  /** Zagadnienia w kolejności lekcji. */
  readonly objectives: readonly AgentObjective[];
  readonly pools: ReadonlyMap<string, readonly AgentPoolEntry[]>;
  /** Przykłady kart per zagadnienie (z planu albo z `submit`); trafiają do lesson_context.examples. */
  readonly examples: ReadonlyMap<string, readonly string[]>;
  /** Stałe źródła ujawnień per zagadnienie (przykłady szkicu, zdania kart); nigdy nie zapisywane. */
  readonly fixedSources: ReadonlyMap<string, readonly string[]>;
  /** Ćwiczenia szkicu i zagadnień już zapisanych: nietykalne, liczą się do walidacji, ujawnień i statusu. */
  readonly fixed: readonly LessonExerciseDraft[];
  readonly nextId: number;
}

export interface LessonAgentStateInput {
  readonly topic: LessonTopic;
  readonly objectives: readonly AgentObjective[];
  readonly fixed: readonly LessonExerciseDraft[];
  readonly examples: Readonly<Record<string, readonly string[]>>;
  readonly fixedSources: Readonly<Record<string, readonly string[]>>;
}

/** Wpis kolejności lekcji: `id: null` oznacza ćwiczenie `fixed` (poza pulą). */
export interface OrderedLessonEntry {
  readonly objectiveId: string;
  readonly id: string | null;
  readonly draft: LessonExerciseDraft;
}

function toMap(record: Readonly<Record<string, readonly string[]>>): Map<string, readonly string[]> {
  return new Map(Object.entries(record).map(([key, lines]) => [key, [...lines]]));
}

/** Buduje stan początkowy; pule są puste, numeracja identyfikatorów zaczyna się od `ex1`. */
export function createLessonAgentState(input: LessonAgentStateInput): LessonAgentState {
  return {
    topic: input.topic,
    objectives: input.objectives,
    pools: new Map(),
    examples: toMap(input.examples),
    fixedSources: toMap(input.fixedSources),
    fixed: [...input.fixed],
    nextId: 1,
  };
}

/** Pula agenta zagadnienia (bez ćwiczeń `fixed`); brak wpisu = pusta lista. */
export function poolOf(state: LessonAgentState, objectiveId: string): readonly AgentPoolEntry[] {
  return state.pools.get(objectiveId) ?? [];
}

function assertKnownObjective(state: LessonAgentState, objectiveId: string): void {
  if (!state.objectives.some((objective) => objective.id === objectiveId)) {
    throw new Error(`unknown objective ${objectiveId}`);
  }
}

/**
 * Nowy stan z podmienioną pulą zagadnienia. Pule istnieją tylko dla zagadnień
 * z `state.objectives` (inaczej wypadłyby z `orderedLesson`): nieznany
 * identyfikator rzuca `Error("unknown objective <id>")`.
 */
export function withPool(
  state: LessonAgentState,
  objectiveId: string,
  pool: readonly AgentPoolEntry[],
): LessonAgentState {
  assertKnownObjective(state, objectiveId);
  return { ...state, pools: new Map(state.pools).set(objectiveId, [...pool]) };
}

/**
 * Nowy stan z podmienionymi przykładami kart zagadnienia; nieznany
 * identyfikator zagadnienia rzuca `Error("unknown objective <id>")`.
 */
export function withExamples(
  state: LessonAgentState,
  objectiveId: string,
  lines: readonly string[],
): LessonAgentState {
  assertKnownObjective(state, objectiveId);
  return { ...state, examples: new Map(state.examples).set(objectiveId, [...lines]) };
}

/** Przykłady i stałe źródła per zagadnienie, bez duplikatów (dokładne porównanie tekstu). */
export function allExamples(state: LessonAgentState): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const source of [state.examples, state.fixedSources]) {
    for (const [objectiveId, lines] of source) {
      const target = (merged[objectiveId] ??= []);
      for (const line of lines) if (!target.includes(line)) target.push(line);
    }
  }
  return merged;
}

const STAGE_ORDER: readonly LessonStage[] = ["intro", "guided", "productive", "independent"];

/** Ranga etapu: intro < guided < productive < independent < typy poza ścieżką etapów. */
function stageRank(draft: LessonExerciseDraft): number {
  if (outsideStagePath(draft.exerciseType)) return STAGE_ORDER.length;
  return STAGE_ORDER.indexOf(stageOf(draft.exerciseType));
}

/**
 * Kolejność lekcji (spec §3.1): zagadnienia w kolejności planu, w zagadnieniu
 * etapy intro, guided, productive, independent, potem typy poza ścieżką; przy
 * tej samej randze `fixed` przed pulą, w kolejności wejścia (sort stabilny).
 * Ćwiczenia `fixed` zagadnień spoza planu idą na koniec w kolejności wejścia.
 */
export function orderedEntries(state: LessonAgentState): readonly OrderedLessonEntry[] {
  const known = new Set(state.objectives.map((objective) => objective.id));
  const entries: OrderedLessonEntry[] = [];
  for (const objective of state.objectives) {
    const own: OrderedLessonEntry[] = [
      ...state.fixed
        .filter((draft) => draft.objectiveId === objective.id)
        .map((draft) => ({ objectiveId: objective.id, id: null, draft })),
      ...poolOf(state, objective.id).map((entry) => ({
        objectiveId: objective.id,
        id: entry.id,
        draft: entry.draft,
      })),
    ];
    entries.push(...own.sort((a, b) => stageRank(a.draft) - stageRank(b.draft)));
  }
  for (const draft of state.fixed) {
    if (!known.has(draft.objectiveId)) entries.push({ objectiveId: draft.objectiveId, id: null, draft });
  }
  return entries;
}

/** Szkice lekcji w kolejności sesji (`orderedEntries` bez metadanych). */
export function orderedLesson(state: LessonAgentState): readonly LessonExerciseDraft[] {
  return orderedEntries(state).map((entry) => entry.draft);
}

/**
 * Pobiera `n` kolejnych identyfikatorów (`ex1`, `ex2`…) i zwraca stan z
 * przesuniętym licznikiem. `n` musi być nieujemną liczbą całkowitą (inaczej
 * identyfikatory mogłyby się powtórzyć): w przeciwnym razie rzuca błąd.
 */
export function takeIds(state: LessonAgentState, n: number): { ids: string[]; state: LessonAgentState } {
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid id count ${n}`);
  const ids = Array.from({ length: n }, (_, index) => `ex${state.nextId + index}`);
  return { ids, state: { ...state, nextId: state.nextId + n } };
}
