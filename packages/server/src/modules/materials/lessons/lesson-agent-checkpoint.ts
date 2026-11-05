import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../../../db/client";
import { deckVersions, generationRuns } from "../../../db/schema";
import type { DynamicTopicData, LessonExerciseDraft } from "../../../domain/lessons/types";
import { isWellShapedRawExercise, toExerciseDraft, type LessonRunIdentity } from "./lesson-drafts";

/**
 * Punkt kontrolny agenta puli lekcji w `generation_runs.agent_checkpoint`
 * (spec etapu 2a §8): postęp próby, z którego kolejna próba runu wznawia pracę
 * (zagadnienia `complete`, temat, przykłady planu, wydatek budżetu), a po
 * zapisie do szkicu — podsumowanie bez treści (trwały histogram kodów
 * odrzuceń). Wspólny materiał lekcji, bez danych dziecka i bez `detail`
 * odrzuceń; nie trafia do DTO, MCP ani logów.
 */

export interface LessonAgentObjectiveProgress {
  readonly status: "complete" | "incomplete" | "failed";
  readonly failureCode?: string;
  /** Ćwiczenia zagadnienia z tej próby (tryb `pool`) albo nowe ćwiczenia (tryb `add`). */
  readonly exercises: LessonExerciseDraft[];
  readonly examples: string[];
}

export type LessonAgentProgress = {
  readonly version: 1;
  readonly kind: "progress";
  readonly dynamicTopic?: DynamicTopicData;
  readonly droppedObjectiveCount?: number;
  readonly planExamples?: Record<string, string[]>;
  readonly objectives: Record<string, LessonAgentObjectiveProgress>;
  /** Wydatek liczony do budżetu runu; zerowany przez „Ponów” rodzica. */
  readonly budgetSpentUsd: number;
  /** Wydatek łączny wszystkich prób (log, podsumowanie). */
  readonly totalSpentUsd: number;
  /** Histogram kodów odrzuceń, bez treści. */
  readonly rejectionCodes: Record<string, number>;
  readonly removedAfterAcceptance: number;
};

export type LessonAgentSummary = {
  readonly version: 1;
  readonly kind: "summary";
  readonly objectives: Record<string, { readonly status: string; readonly accepted: number; readonly failureCode?: string }>;
  readonly totalSpentUsd: number;
  readonly rejectionCodes: Record<string, number>;
  readonly attempts: number;
};

/** Zapis punktu kontrolnego nie przeszedł straży tożsamości próby — rozliczany jak `superseded`. */
export class LessonAgentCheckpointLostError extends Error {
  constructor() {
    super("lesson agent checkpoint lost: run is no longer the current attempt");
    this.name = "LessonAgentCheckpointLostError";
  }
}

const nonNegative = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();

/** Obwiednia tematu dynamicznego; reguły katalogu sprawdza ścieżka przy wznowieniu jak przy pierwszej próbie. */
const dynamicTopicSchema = z.object({
  titlePl: z.string(),
  objectives: z.array(z.object({
    id: z.string(),
    titlePl: z.string(),
    descriptionEn: z.string(),
    cards: z.array(z.object({ title: z.string(), body: z.string() }).passthrough()),
  }).passthrough()),
}).passthrough();

const progressSchema = z.object({
  version: z.literal(1),
  kind: z.literal("progress"),
  dynamicTopic: dynamicTopicSchema.optional(),
  droppedObjectiveCount: count.optional(),
  planExamples: z.record(z.string(), z.array(z.string())).optional(),
  objectives: z.record(z.string(), z.object({
    status: z.enum(["complete", "incomplete", "failed"]),
    failureCode: z.string().optional(),
    // kształt ćwiczeń sprawdza ten sam strażnik co surowe rekordy modelu
    exercises: z.array(z.unknown()),
    examples: z.array(z.string()),
  })),
  budgetSpentUsd: nonNegative,
  totalSpentUsd: nonNegative,
  rejectionCodes: z.record(z.string(), count),
  removedAfterAcceptance: count,
});

/** Pusty postęp pierwszej próby. */
export function emptyLessonAgentProgress(): LessonAgentProgress {
  return {
    version: 1,
    kind: "progress",
    objectives: {},
    budgetSpentUsd: 0,
    totalSpentUsd: 0,
    rejectionCodes: {},
    removedAfterAcceptance: 0,
  };
}

/**
 * Postęp z kolumny runu albo `undefined`: brak wartości i podsumowanie (run po
 * zapisie do szkicu) to brak postępu; uszkodzona obwiednia, inna wersja albo
 * ćwiczenie o złym kształcie — też brak postępu, z logiem bez treści.
 */
export function parseLessonAgentProgress(value: unknown, runId?: string): LessonAgentProgress | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "object" && (value as { version?: unknown; kind?: unknown }).version === 1
    && (value as { kind?: unknown }).kind === "summary") return undefined;
  const parsed = progressSchema.safeParse(value);
  if (!parsed.success || !Object.values(parsed.data.objectives).every((entry) => entry.exercises.every(isWellShapedRawExercise))) {
    console.log(`[lesson-agent] run=${runId ?? "-"} checkpoint=invalid`);
    return undefined;
  }
  const data = parsed.data;
  const objectives: Record<string, LessonAgentObjectiveProgress> = {};
  for (const [objectiveId, entry] of Object.entries(data.objectives)) {
    objectives[objectiveId] = {
      status: entry.status,
      ...(entry.failureCode === undefined ? {} : { failureCode: entry.failureCode }),
      exercises: entry.exercises.map(toExerciseDraft),
      examples: entry.examples,
    };
  }
  return {
    version: 1,
    kind: "progress",
    ...(data.dynamicTopic === undefined ? {} : { dynamicTopic: data.dynamicTopic as DynamicTopicData }),
    ...(data.droppedObjectiveCount === undefined ? {} : { droppedObjectiveCount: data.droppedObjectiveCount }),
    ...(data.planExamples === undefined ? {} : { planExamples: data.planExamples }),
    objectives,
    budgetSpentUsd: data.budgetSpentUsd,
    totalSpentUsd: data.totalSpentUsd,
    rejectionCodes: data.rejectionCodes,
    removedAfterAcceptance: data.removedAfterAcceptance,
  };
}

/**
 * Sam wydatek z wartości, której nie da się użyć jako postępu (uszkodzona obwiednia, zły temat): pusty
 * postęp z `budgetSpentUsd`/`totalSpentUsd`, o ile są nieujemnymi liczbami — start od zera nie zeruje
 * budżetu runu. Podsumowanie, brak wartości albo brak wydatku → `undefined`.
 */
export function salvageLessonAgentSpend(value: unknown): LessonAgentProgress | undefined {
  if (value === null || typeof value !== "object" || (value as { kind?: unknown }).kind === "summary") return undefined;
  const spend = (field: "budgetSpentUsd" | "totalSpentUsd"): number => {
    const parsed = nonNegative.safeParse((value as Record<string, unknown>)[field]);
    return parsed.success ? parsed.data : 0;
  };
  const budgetSpentUsd = spend("budgetSpentUsd");
  // Łącznie nie mniej niż budżet (budżet jest częścią wydatku łącznego).
  const totalSpentUsd = Math.max(spend("totalSpentUsd"), budgetSpentUsd);
  if (totalSpentUsd === 0) return undefined;
  return { ...emptyLessonAgentProgress(), budgetSpentUsd, totalSpentUsd };
}

/** Podsumowanie po zapisie do szkicu: statusy i liczby przyjętych ćwiczeń, bez treści. */
export function summarizeLessonAgentProgress(progress: LessonAgentProgress, attempts: number): LessonAgentSummary {
  const objectives: Record<string, { status: string; accepted: number; failureCode?: string }> = {};
  for (const [objectiveId, entry] of Object.entries(progress.objectives)) {
    objectives[objectiveId] = {
      status: entry.status,
      accepted: entry.exercises.length,
      ...(entry.failureCode === undefined ? {} : { failureCode: entry.failureCode }),
    };
  }
  return {
    version: 1,
    kind: "summary",
    objectives,
    totalSpentUsd: progress.totalSpentUsd,
    rejectionCodes: { ...progress.rejectionCodes },
    attempts,
  };
}

/**
 * Zapis całej wartości postępu bieżącej próby (spec §8.2). Straż: run nadal
 * `running` w tej samej próbie i z tym samym numerem edycji, a wersja szkicu
 * ma ten numer edycji i nie jest opublikowana — nie każda zmiana szkicu
 * anuluje runy (`lesson-supervision.ts`). Zero zmienionych wierszy →
 * `LessonAgentCheckpointLostError`.
 */
export async function saveLessonAgentCheckpoint(db: Executor, run: LessonRunIdentity, value: LessonAgentProgress): Promise<void> {
  const saved = await db.update(generationRuns)
    .set({ agentCheckpoint: value as unknown as Record<string, unknown> })
    .where(and(
      eq(generationRuns.id, run.runId),
      eq(generationRuns.state, "running"),
      eq(generationRuns.attempts, run.attempts),
      eq(generationRuns.expectedEditNumber, run.expectedEditNumber),
      sql`exists (select 1 from ${deckVersions} v where v.id = ${run.deckVersionId} and v.edit_number = ${run.expectedEditNumber} and v.state <> 'published')`,
    ))
    .returning({ id: generationRuns.id });
  if (saved.length === 0) throw new LessonAgentCheckpointLostError();
}
