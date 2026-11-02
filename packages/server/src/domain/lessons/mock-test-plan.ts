/**
 * Plan próbnej kartkówki z lekcji (design „Kartkówka”, requirements 9.3).
 * Czysta domena: subject-agnostyczna, bez bazy, sieci i zegara.
 *
 * Wybiera porcję ≤ `requestedCount` z puli, rozdzielając zadania między cele
 * proporcjonalnie (różnica liczby zadań między celami ≤ 1, gdy pula pozwala).
 * W obrębie celu preferuje: ćwiczenia niewidziane przed widzianymi, a następnie
 * typy produktywne/samodzielne przed prowadzonymi. Pomija `lesson_notice` i typy
 * spoza ścieżki etapów (`outsideStagePath`).
 * Deterministyczny (tie-break po kolejności w puli). Kolejność wyniku to
 * przeplot celów (round-robin w kolejności `objectiveIds`).
 */

import { outsideStagePath, stageOf } from "./stages";
import type { LessonExerciseType, LessonStage } from "./types";

/** Wpis puli widziany przez planer kartkówki. */
export interface LessonMockPoolEntry {
  readonly itemId: string;
  readonly itemRevisionId: string;
  readonly objectiveId: string;
  readonly exerciseType: LessonExerciseType;
  readonly stage: LessonStage;
  /** Klucz ekspozycji odpowiedzi (`computeTargetKey`) — do rozróżnienia widziane/niewidziane. */
  readonly targetKey: string;
}

/** Wspólne mapowanie z lekkiego odczytu listy i pełnej puli startowej. */
export function toLessonMockPoolEntry(input: {
  itemId: string;
  itemRevisionId: string;
  objectiveId: string;
  exerciseType: LessonExerciseType;
  targetKey: string;
}): LessonMockPoolEntry {
  return { ...input, stage: stageOf(input.exerciseType) };
}

/** Wejście planera kartkówki. */
export interface LessonMockTestInput {
  readonly pool: readonly LessonMockPoolEntry[];
  readonly objectiveIds: readonly string[];
  readonly requestedCount: number;
  readonly exposedTargetKeys: readonly string[];
}

/** Jedna pozycja planu kartkówki. */
export interface LessonMockTestItem {
  readonly itemId: string;
  readonly itemRevisionId: string;
  readonly objectiveId: string;
  readonly exerciseType: LessonExerciseType;
}

/**
 * Ranga etapu przy preferencji: produktywny/samodzielny przed prowadzonym.
 * Niższa wartość = wyższy priorytet. `intro` nigdy nie wchodzi do planu
 * (notice odfiltrowany wcześniej), ale ma najniższy priorytet dla bezpieczeństwa.
 */
const STAGE_PRIORITY: Readonly<Record<LessonStage, number>> = {
  independent: 0,
  productive: 0,
  guided: 1,
  intro: 2,
};

interface RankedEntry {
  readonly entry: LessonMockPoolEntry;
  readonly seen: boolean;
  readonly order: number; // pozycja w puli — tie-break deterministyczny
}

/**
 * Porządkuje kandydatów jednego celu wg preferencji: najpierw niewidziane,
 * potem priorytet etapu (produktywny/samodzielny < prowadzony), na końcu
 * kolejność w puli. Stabilny i deterministyczny.
 */
function orderCandidates(candidates: readonly RankedEntry[]): RankedEntry[] {
  return [...candidates].sort((a, b) => {
    if (a.seen !== b.seen) {
      return a.seen ? 1 : -1; // niewidziane pierwsze
    }
    const stageDiff = STAGE_PRIORITY[a.entry.stage] - STAGE_PRIORITY[b.entry.stage];
    if (stageDiff !== 0) {
      return stageDiff;
    }
    return a.order - b.order; // tie-break po kolejności w puli
  });
}

/**
 * Buduje plan kartkówki. Zwraca ≤ `requestedCount` pozycji; gdy pula ma mniej
 * kwalifikujących się ćwiczeń niż porcja, zwraca mniej.
 */
export function planLessonMockTest(input: LessonMockTestInput): LessonMockTestItem[] {
  const { pool, objectiveIds, requestedCount, exposedTargetKeys } = input;
  if (requestedCount <= 0) {
    return [];
  }
  const exposed = new Set(exposedTargetKeys);
  const inScope = new Set(objectiveIds);

  // Kandydaci per cel, uporządkowani preferencją. Pomijamy notice, typy spoza
  // ścieżki etapów (słowa kluczowe — wsparcie trenera precyzji; zadanie słuchowe —
  // wspomagane nagraniem, #198; żadne nie jest sprawdzeniem) i cele spoza lekcji.
  const byObjective = new Map<string, RankedEntry[]>();
  pool.forEach((entry, order) => {
    if (entry.exerciseType === "lesson_notice" || outsideStagePath(entry.exerciseType) || stageOf(entry.exerciseType) === "intro") {
      return;
    }
    if (!inScope.has(entry.objectiveId)) {
      return;
    }
    const ranked: RankedEntry = { entry, seen: exposed.has(entry.targetKey), order };
    const list = byObjective.get(entry.objectiveId);
    if (list === undefined) {
      byObjective.set(entry.objectiveId, [ranked]);
    } else {
      list.push(ranked);
    }
  });

  // Kolejki per cel w kolejności objectiveIds (round-robin).
  const queues = objectiveIds
    .map((objectiveId) => orderCandidates(byObjective.get(objectiveId) ?? []))
    .map((entries) => ({ entries, index: 0 }));

  const plan: LessonMockTestItem[] = [];
  let progressed = true;
  while (plan.length < requestedCount && progressed) {
    progressed = false;
    for (const queue of queues) {
      if (plan.length >= requestedCount) {
        break;
      }
      if (queue.index < queue.entries.length) {
        const { entry } = queue.entries[queue.index]!;
        queue.index += 1;
        plan.push({
          itemId: entry.itemId,
          itemRevisionId: entry.itemRevisionId,
          objectiveId: entry.objectiveId,
          exerciseType: entry.exerciseType,
        });
        progressed = true;
      }
    }
  }

  return plan;
}
