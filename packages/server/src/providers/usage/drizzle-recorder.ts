import { randomUUID } from "node:crypto";
import type { Clock } from "../../config";
import type { Database } from "../../db/client";
import { providerUsageEvents } from "../../db/schema";
import { currentUsageScope, scopeKindOf, type UsageEvent, type UsageRecorder, type UsageScope } from "../../ports/usage";
import { priceUsage } from "./pricing";
import type { UsagePrices } from "./prices-env";

/**
 * Błędy, po których koszt zapisujemy ponownie bez przypisania: naruszenie klucza
 * obcego (zakres wskazuje zniknięty wiersz) oraz deadlock z równoległym
 * usunięciem profilu (insert trzyma KEY SHARE na sesji i czeka na profil, który
 * kasuje `deleteChild`).
 */
const RETRY_UNSCOPED = new Set(["23503", "40P01"]);

/** Pola szczegółowe zerowane przy ponowieniu wiersza sesji lub dziecka (spec §4.3, §5.3). */
const DETAIL_FIELDS_NULL = {
  operation: null,
  model: null,
  httpStatus: null,
  inputTokens: null,
  outputTokens: null,
  characters: null,
  audioMs: null,
  images: null,
} as const;

/** Kod SQLSTATE błędu bazy; Drizzle opakowuje błąd sterownika w `cause`. */
function sqlState(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current && depth < 3; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function defaultLog(code: string): void {
  console.error("[usage] usage_record_failed", { code });
}

/**
 * Recorder kosztów zapisujący do `provider_usage_events` przez pulę, poza
 * transakcją biznesową (rollback operacji nie cofa kosztu, który już powstał u
 * dostawcy). `record` nigdy nie rzuca — wyjątek zmieniłby wynik biznesowy
 * adaptera (ponowienie runu, „nieocenione") — i nie czeka na zapis; zaległe
 * inserty kończy `flush`. Do logu trafia wyłącznie kod błędu, bez treści.
 */
export function createDrizzleUsageRecorder(input: {
  db: Database;
  clock: Clock;
  prices: UsagePrices;
  log?: (code: string) => void;
}): UsageRecorder {
  const { db, clock, prices } = input;
  const log = input.log ?? defaultLog;
  const pending = new Set<Promise<void>>();

  function safeLog(code: string): void {
    try {
      log(code);
    } catch {
      // Log nie może zmienić wyniku wywołującego.
    }
  }

  async function insert(row: typeof providerUsageEvents.$inferInsert): Promise<void> {
    try {
      await db.insert(providerUsageEvents).values(row);
    } catch (error) {
      const code = sqlState(error);
      if (code === undefined || !RETRY_UNSCOPED.has(code)) {
        safeLog("usage_record_failed");
        return;
      }
      // Zakres wskazuje wiersz, który zniknął albo znika (usunięty profil): koszt zostaje bez przypisania.
      // Wiersz sesji lub dziecka traci też pola szczegółowe, jak przy zgrubieniu profilu
      // (`anonymizeChildUsage`) — kwota i `scope_kind` zostają; `occurred_at` bez zmian.
      const childScoped = row.sessionId != null || row.childId != null;
      try {
        await db.insert(providerUsageEvents).values({
          ...row,
          ...(childScoped ? DETAIL_FIELDS_NULL : {}),
          generationRunId: null,
          deckId: null,
          sessionId: null,
          childId: null,
        });
      } catch {
        safeLog("usage_record_failed");
      }
    }
  }

  function buildRow(event: UsageEvent, scope: UsageScope | undefined, at: Date): typeof providerUsageEvents.$inferInsert {
    const priced = priceUsage(event, prices);
    return {
      id: randomUUID(),
      occurredAt: at,
      feature: event.feature,
      operation: event.operation ?? null,
      provider: event.provider,
      model: event.model ?? null,
      outcome: event.outcome,
      httpStatus: event.httpStatus ?? null,
      inputTokens: event.inputTokens ?? null,
      outputTokens: event.outputTokens ?? null,
      characters: event.characters ?? null,
      audioMs: event.audioMs ?? null,
      images: event.images ?? null,
      costUsd: priced.costUsd,
      costSource: priced.costSource,
      priceRef: priced.priceRef,
      scopeKind: scopeKindOf(scope),
      generationRunId: scope?.generationRunId ?? null,
      deckId: scope?.deckId ?? null,
      sessionId: scope?.sessionId ?? null,
      childId: scope?.childId ?? null,
    };
  }

  return {
    record(event) {
      try {
        const row = buildRow(event, currentUsageScope(), clock.now());
        const task = insert(row).finally(() => pending.delete(task));
        pending.add(task);
      } catch {
        safeLog("usage_record_failed");
      }
    },
    async flush() {
      // Pętla: zapisy dodane w trakcie czekania też muszą się skończyć.
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}
