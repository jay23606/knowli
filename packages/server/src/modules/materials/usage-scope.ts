import { eq } from "drizzle-orm";
import type { Executor } from "../../db/client";
import { deckVersions, generationRuns } from "../../db/schema";
import type { UsageScope } from "../../ports/usage";

/**
 * Zakresy kosztów runów generacji (spec 2026-11-02-llm-cost-tracking §4.1, §5.1):
 * koszt runu `deck`/`lesson` należy do talii jego wersji, koszt runu mediów — do
 * talii, której szkic zlecił zasób (`origin_deck_id`). Odczyt poza transakcją
 * runu: zakres nie wpływa na żadną decyzję wykonawcy.
 */

/** `{ generationRunId, deckId }` runu zestawu albo lekcji; talia z `deck_versions.deck_id`. */
export async function runUsageScope(db: Executor, runId: string): Promise<UsageScope> {
  const row = (
    await db
      .select({ deckId: deckVersions.deckId })
      .from(generationRuns)
      .leftJoin(deckVersions, eq(deckVersions.id, generationRuns.deckVersionId))
      .where(eq(generationRuns.id, runId))
  )[0];
  return { generationRunId: runId, ...(row?.deckId ? { deckId: row.deckId } : {}) };
}

/**
 * `{ generationRunId, deckId }` runu mediów zasobu (jeden run na zasób —
 * `one_run_per_asset`); bez `origin_deck_id` (głos UI, runy sprzed migracji)
 * tylko run. Brak runu = pusty zakres (koszt bez przypisania).
 */
export async function mediaRunUsageScope(db: Executor, assetId: string): Promise<UsageScope> {
  const run = (
    await db
      .select({ id: generationRuns.id, originDeckId: generationRuns.originDeckId })
      .from(generationRuns)
      .where(eq(generationRuns.assetId, assetId))
  )[0];
  if (!run) return {};
  return { generationRunId: run.id, ...(run.originDeckId ? { deckId: run.originDeckId } : {}) };
}
