import { and, eq, inArray, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import type { Clock } from "../../config";
import type { Database, Executor, Tx } from "../../db/client";
import { generationRuns } from "../../db/schema";

/**
 * Współdzielony cykl życia wierszy `generationRuns` dla wykonawców słówek,
 * lekcji i mediów: idempotentne zlecanie, atomowe przejęcie (claim CAS),
 * oznaczanie stanu i unieważnianie runów lekcji oraz cel runu lekcji
 * (`input.purpose`: pula ćwiczeń albo historyjka — `LESSON_STORY_PURPOSE`,
 * `isStoryRunInput` i filtry SQL `lessonStoryRunFilter`/`lessonPoolRunFilter`
 * używane przez unieważnianie, ponowienie, przycisk i polling panelu).
 * Wykonawcy treści zależą od
 * tego pliku; on nie zna żadnego z nich ani koordynatora workera, więc
 * moduł lekcji nie musi importować wykonawcy słówek (`generation.ts`).
 */

/**
 * Idempotentne zlecenie runu generacji szkicu pod kluczem `dedupeKey`
 * (`deck:<id>` / `lesson:<id>`). Wspólny szkielet dla słówek i lekcji: jeśli run
 * o tym kluczu istnieje i zna swój `deckId`, zwraca go; inaczej otwiera własną
 * transakcję i woła `create(tx)` (wstawia deck/wersję/run). Przy równoległym
 * duplikacie klucza (`23505`) transakcja przegranego wycofuje się, a zwycięzcę
 * odczytujemy świeżym zapytaniem POZA wycofaną transakcją (w aborted tx nie da
 * się już nic odczytać). Jedna obsługa wyścigu idempotencji — moduł lekcji jej
 * używa zamiast kopiować. `create` zwraca `{ runId, deckId }`.
 */
export async function enqueueGenerationRun(
  db: Database,
  dedupeKey: string,
  create: (tx: Tx) => Promise<{ runId: string; deckId: string }>,
): Promise<{ runId: string; deckId: string }> {
  const found = await findEnqueuedRun(db, dedupeKey);
  if (found) {
    return found;
  }
  try {
    return await db.transaction(async (tx) => create(tx));
  } catch (error) {
    // równoległy duplikat klucza idempotencji: transakcja już wycofana, więc
    // zwycięzcę czytamy świeżym zapytaniem na połączeniu bazowym. Drizzle
    // opakowuje błąd pg, więc kod bywa na error.cause (jak w upsertAssignment).
    const pgCode =
      (error as { code?: string }).code ??
      (error as { cause?: { code?: string } }).cause?.code;
    if (pgCode === "23505") {
      const winner = await findEnqueuedRun(db, dedupeKey);
      if (winner) {
        return winner;
      }
    }
    throw error;
  }
}

/**
 * Odczyt istniejącego runu po kluczu idempotencji, jeśli zna swój `deckId`.
 * Poza `enqueueGenerationRun` korzysta z niego tworzenie zestawu ze źródła
 * (ponowienie po równoległym usunięciu albo zmianie źródła,
 * `committedRetryAfterSourceChange` w `source-materials.ts`).
 */
export async function findEnqueuedRun(
  db: Executor,
  dedupeKey: string,
): Promise<{ runId: string; deckId: string } | null> {
  const existing = (
    await db.select().from(generationRuns).where(eq(generationRuns.dedupeKey, dedupeKey))
  )[0];
  const deckId = (existing?.input as { deckId?: string } | undefined)?.deckId;
  if (existing && deckId) {
    return { runId: existing.id, deckId };
  }
  return null;
}

export async function markRun(
  db: Executor,
  clock: Clock,
  runId: string,
  state: "succeeded" | "failed" | "superseded" | "queued",
  errorCode: string | null,
): Promise<void> {
  await db
    .update(generationRuns)
    .set({
      state,
      errorCode,
      nextAttemptAt: null,
      finishedAt: state === "queued" ? null : clock.now(),
    })
    .where(eq(generationRuns.id, runId));
}

/**
 * Sukces runu `deck` razem z liczbą elementów odrzuconych przy walidacji per
 * element (zestaw słówek ze źródła, design 2026-10-30 §6.2); `null` — run bez
 * takiej walidacji (tryb „z opisu”, wszystko-albo-nic). Pozostałe pola jak
 * `markRun(…, "succeeded", null)`. Wołać w transakcji zapisu wyniku, pod
 * blokadą wersji szkicu — tak jak dotychczasowe oznaczenie sukcesu.
 */
export async function markRunSucceeded(
  db: Executor,
  clock: Clock,
  runId: string,
  rejectedCount: number | null,
): Promise<void> {
  await db
    .update(generationRuns)
    .set({
      state: "succeeded",
      errorCode: null,
      nextAttemptAt: null,
      finishedAt: clock.now(),
      rejectedCount,
    })
    .where(eq(generationRuns.id, runId));
}

/**
 * Porażka runu `deck` ze źródła, gdy żaden element nie przeszedł walidacji per
 * element (`no_source_items`, design 2026-10-30 §6.2), razem z liczbą odrzuceń
 * — panel rodzica pokazuje ją także przy porażce. Szkic zostaje bez zmian.
 * Pozostałe pola jak `markRun(…, "failed", "no_source_items")`.
 */
export async function markRunWithoutSourceItems(
  db: Executor,
  clock: Clock,
  runId: string,
  rejectedCount: number,
): Promise<void> {
  await db
    .update(generationRuns)
    .set({
      state: "failed",
      errorCode: "no_source_items",
      nextAttemptAt: null,
      finishedAt: clock.now(),
      rejectedCount,
    })
    .where(eq(generationRuns.id, runId));
}

/**
 * Cel runu `lesson` zapisany w `generation_runs.input.purpose`: `"story"` to
 * run historyjki lekcji (`lessons/lesson-story-generation.ts`); brak pola
 * oznacza generowanie puli ćwiczeń (pełne albo dogenerowanie celu).
 */
export const LESSON_STORY_PURPOSE = "story";

/** Czy wejście runu `lesson` należy do runu historyjki. */
export function isStoryRunInput(input: unknown): boolean {
  return typeof input === "object" && input !== null && (input as { purpose?: unknown }).purpose === LESSON_STORY_PURPOSE;
}

/** Warunek SQL: run `lesson` jest runem historyjki. */
export function lessonStoryRunFilter(): SQL {
  return sql`coalesce(${generationRuns.input}->>'purpose', 'lesson') = ${LESSON_STORY_PURPOSE}`;
}

/** Warunek SQL: run `lesson` generuje pulę ćwiczeń (nie historyjkę). */
export function lessonPoolRunFilter(): SQL {
  return sql`coalesce(${generationRuns.input}->>'purpose', 'lesson') <> ${LESSON_STORY_PURPOSE}`;
}

/**
 * Called only while the owning deck version is locked. A parent edit or a
 * successful generation makes outstanding runs for that edit stale before
 * they can publish their result. Domyślnie anuluje tylko runy puli ćwiczeń:
 * run historyjki nie zależy od numeru edycji i przeżywa zwykłą edycję oraz
 * dogenerowanie celu. `includeStoryRuns` (nowy pełny run lekcji, patch
 * historyjki) anuluje także runy historyjki.
 */
export async function supersedeLessonRuns(
  db: Executor,
  deckVersionId: string,
  finishedAt: Date,
  exceptRunId?: string,
  options: { includeStoryRuns?: boolean } = {},
): Promise<void> {
  await db.update(generationRuns)
    .set({ state: "superseded", errorCode: null, finishedAt })
    .where(and(
      eq(generationRuns.kind, "lesson"),
      eq(generationRuns.deckVersionId, deckVersionId),
      inArray(generationRuns.state, ["queued", "running"]),
      exceptRunId ? ne(generationRuns.id, exceptRunId) : undefined,
      options.includeStoryRuns === true ? undefined : lessonPoolRunFilter(),
    ));
}

/**
 * Patch historyjki rodzica (obiekt albo `null`) zastępuje porażki runów
 * historyjki wersji: baner „Historyjka nie powstała.” znika, a ponowienie
 * starej porażki nie nadpisze wyboru rodzica. Kod błędu i `finishedAt`
 * zostają jako historia. Wywoływane pod blokadą wersji, w transakcji edycji.
 */
export async function supersedeFailedLessonStoryRuns(db: Executor, deckVersionId: string): Promise<void> {
  await db.update(generationRuns)
    .set({ state: "superseded" })
    .where(and(
      eq(generationRuns.kind, "lesson"),
      eq(generationRuns.deckVersionId, deckVersionId),
      eq(generationRuns.state, "failed"),
      lessonStoryRunFilter(),
    ));
}

/**
 * Claim CAS runu generacji szkicu (deck/lesson): `queued → running` + inkrement
 * prób. Zwraca liczbę prób po claimie, albo `null`, gdy run nie był `queued`
 * (inny worker już go zabrał). Współdzielone przez ścieżkę słówek i lekcji —
 * jedna implementacja atomowego przejęcia zamiast kopii w module lekcji.
 */
export async function claimQueuedRun(db: Executor, runId: string, expectedEditNumber?: number, now?: Date): Promise<number | null> {
  const claimed = await db
    .update(generationRuns)
    .set({ state: "running", attempts: sql`${generationRuns.attempts} + 1` })
    .where(and(
      eq(generationRuns.id, runId),
      eq(generationRuns.state, "queued"),
      expectedEditNumber === undefined ? undefined : eq(generationRuns.expectedEditNumber, expectedEditNumber),
      now === undefined ? undefined : or(isNull(generationRuns.nextAttemptAt), lte(generationRuns.nextAttemptAt, now)),
    ))
    .returning({ attempts: generationRuns.attempts });
  return claimed[0]?.attempts ?? null;
}
