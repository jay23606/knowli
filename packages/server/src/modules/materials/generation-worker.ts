import { and, asc, eq, inArray, isNull, lte, not, notInArray, or, sql } from "drizzle-orm";
import type { Services } from "../../config";
import { generationRuns, mediaAssets } from "../../db/schema";
import { withUsageScope } from "../../ports/usage";
import { executeGeneration } from "./generation";
import { executeMediaAsset } from "./media-generation";
import { errorCodeOf, requireGeneration } from "./generation-runtime";
import { executeLessonGeneration } from "./lessons/lesson-drafts";
import { mediaRunUsageScope, runUsageScope } from "./usage-scope";
import { runWorkerSlots, selectFairWorkerWork, workerAttemptFromKey, workerAttemptKey, workerIdFromAttemptKey, type WorkKind } from "./worker-schedule";

export interface WorkerLimits {
  total?: number;
  deck?: number;
  lesson?: number;
  tts?: number;
  images?: number;
}

/**
 * Jedno przelotne przetworzenie zleconej pracy (poller workera; testy wołają
 * bezpośrednio). Rotuje między kolejkami decków, lekcji, TTS i ilustracji.
 * Domyślnie najwyżej jeden obraz naraz i łącznie dwa równoległe zadania.
 */
export async function runDueGenerationWork(
  services: Services,
  limits: WorkerLimits = {},
  options: { signal?: AbortSignal; onProgress?: () => void } = {},
): Promise<{ processed: number }> {
  requireGeneration(services);
  const maxDeck = limits.deck ?? 2;
  const maxLesson = limits.lesson ?? 2;
  const maxTts = limits.tts ?? 2;
  const maxImages = limits.images ?? 1;
  const maxTotal = limits.total ?? 2;
  if (options.signal?.aborted) return { processed: 0 };
  const concurrencyLimits: Record<WorkKind, number> = { deck: maxDeck, lesson: maxLesson, tts: maxTts, illustration: maxImages };
  const processed = await runWorkerSlots<{ id: string; assetId?: string; attempts: number }>({
    concurrency: maxTotal,
    loadNext: async (active, seenKeys) => {
      if (options.signal?.aborted) return undefined;
      const activeCounts: Record<WorkKind, number> = { deck: 0, lesson: 0, tts: 0, illustration: 0 };
      const activeIds = [...new Set(active.map((item) => item.value.assetId ?? item.value.id))];
      const seenAttempts = [...seenKeys].map((key) => ({ id: workerIdFromAttemptKey(key), attempts: workerAttemptFromKey(key) }));
      const excludeSeenRunAttempts = seenAttempts.length > 0
        ? not(or(...seenAttempts.map(({ id, attempts }) => and(eq(generationRuns.id, id), eq(generationRuns.attempts, attempts))))!)
        : undefined;
      for (const item of active) activeCounts[item.kind] += 1;
      const remaining: Record<WorkKind, number> = {
        deck: Math.max(0, concurrencyLimits.deck - activeCounts.deck),
        lesson: Math.max(0, concurrencyLimits.lesson - activeCounts.lesson),
        tts: Math.max(0, concurrencyLimits.tts - activeCounts.tts),
        illustration: Math.max(0, concurrencyLimits.illustration - activeCounts.illustration),
      };
      const deckRuns = remaining.deck > 0 ? await services.db
        .select({ id: generationRuns.id, attempts: generationRuns.attempts })
        .from(generationRuns)
        .where(and(
          eq(generationRuns.kind, "deck"), eq(generationRuns.state, "queued"),
          or(isNull(generationRuns.nextAttemptAt), lte(generationRuns.nextAttemptAt, services.clock.now())),
          ...(activeIds.length ? [notInArray(generationRuns.id, activeIds)] : []),
          ...(excludeSeenRunAttempts ? [excludeSeenRunAttempts] : []),
        ))
        .orderBy(asc(generationRuns.createdAt))
        .limit(remaining.deck) : [];
      const lessonRuns = remaining.lesson > 0 ? await services.db
        .select({ id: generationRuns.id, attempts: generationRuns.attempts })
        .from(generationRuns)
        .where(and(
          eq(generationRuns.kind, "lesson"),
          eq(generationRuns.state, "queued"),
          or(isNull(generationRuns.nextAttemptAt), lte(generationRuns.nextAttemptAt, services.clock.now())),
          ...(activeIds.length ? [notInArray(generationRuns.id, activeIds)] : []),
          ...(excludeSeenRunAttempts ? [excludeSeenRunAttempts] : []),
        ))
        .orderBy(asc(generationRuns.createdAt))
        .limit(remaining.lesson) : [];
      const dueMedia = remaining.tts > 0 || remaining.illustration > 0 ? await services.db
        .select({ assetId: generationRuns.assetId, kind: generationRuns.kind, attempts: generationRuns.attempts })
        .from(generationRuns)
        .innerJoin(mediaAssets, eq(mediaAssets.id, generationRuns.assetId))
        .where(and(
          inArray(generationRuns.kind, ["tts", "illustration"]),
          inArray(generationRuns.state, ["queued", "running"]),
          eq(mediaAssets.state, "pending"),
          or(isNull(generationRuns.nextAttemptAt), lte(generationRuns.nextAttemptAt, services.clock.now())),
          or(isNull(mediaAssets.leaseToken), sql`${mediaAssets.leaseUntil} < ${services.clock.now()}`),
          // TTS tylko z konfiguracji tego workera (design szkoły §11.7): zadania innego
          // providera/modelu czekają w kolejce na zgodny worker, bez zmiany stanu.
          ...(services.media ? [or(
            not(eq(generationRuns.kind, "tts")),
            and(eq(mediaAssets.provider, services.media.tts.provider), eq(mediaAssets.model, services.media.tts.model)),
          )!] : []),
          ...(activeIds.length ? [notInArray(generationRuns.assetId, activeIds)] : []),
          ...(seenAttempts.length > 0
            ? [not(or(...seenAttempts.map(({ id, attempts }) => and(eq(generationRuns.assetId, id), eq(generationRuns.attempts, attempts))))!)]
            : []),
        ))
        .orderBy(asc(generationRuns.createdAt)) : [];
      const queues: Record<WorkKind, { id: string; assetId?: string; attempts: number }[]> = {
        deck: deckRuns.map((run) => ({ id: run.id, attempts: run.attempts })),
        lesson: lessonRuns.map((run) => ({ id: run.id, attempts: run.attempts })),
        tts: dueMedia.filter((run) => run.kind === "tts" && run.assetId).slice(0, remaining.tts).map((run) => ({ id: run.assetId!, assetId: run.assetId!, attempts: run.attempts })),
        illustration: dueMedia.filter((run) => run.kind === "illustration" && run.assetId).slice(0, remaining.illustration).map((run) => ({ id: run.assetId!, assetId: run.assetId!, attempts: run.attempts })),
      };
      const selected = selectFairWorkerWork(queues, remaining, 1, workerScheduleCursor);
      workerScheduleCursor = selected.nextCursor;
      const next = selected.work[0];
      return next ? { key: workerAttemptKey(next.value.id, next.value.attempts), kind: next.kind, value: next.value } : undefined;
    },
    execute: async ({ kind, value }) => {
      if (options.signal?.aborted) return;
      // Zakres kosztów (spec llm-cost-tracking §4.1): wywołania providerów runu
      // przypisujemy runowi i talii — wersji runu albo talii, która zleciła zasób.
      if (kind === "deck") {
        await withUsageScope(await runUsageScope(services.db, value.id), () => executeGeneration(services, value.id, options.signal));
      } else if (kind === "lesson") {
        await withUsageScope(await runUsageScope(services.db, value.id), () => executeLessonGeneration(services, value.id, { signal: options.signal }));
      } else {
        await withUsageScope(await mediaRunUsageScope(services.db, value.assetId!), () => executeMediaAsset(services, value.assetId!, options.signal));
      }
    },
    onError: (error) => console.error(`[worker] zadanie workera zakończone wyjątkiem: kod=${errorCodeOf(error)}`),
    onProgress: options.onProgress,
  });
  return { processed };
}

let workerScheduleCursor = 0;

/**
 * Liczba oczekujących zadań TTS zleconych przy innym providerze/modelu niż
 * ustawienia tego workera (design szkoły §11.7). Worker ich nie wykonuje,
 * więc niezerowa wartość przy starcie oznacza rozjazd konfiguracji web
 * i workera albo stare zlecenia sprzed przełączenia dostawcy.
 */
export async function countForeignPendingTts(services: Services): Promise<number> {
  const current = services.media?.tts;
  if (!current) return 0;
  const rows = await services.db
    .select({ count: sql<number>`count(*)::int` })
    .from(mediaAssets)
    .where(and(
      eq(mediaAssets.kind, "tts"),
      eq(mediaAssets.state, "pending"),
      not(and(eq(mediaAssets.provider, current.provider), eq(mediaAssets.model, current.model))!),
    ));
  return rows[0]?.count ?? 0;
}
