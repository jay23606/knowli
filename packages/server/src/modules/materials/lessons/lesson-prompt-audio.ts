import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { LessonCardAudioDto, LessonPromptAudioDto } from "@learning/contracts";
import type { Services } from "../../../config";
import type { Executor, Tx } from "../../../db/client";
import { generationRuns, itemRevisions, lessonCardAssets, mediaAssets, revisionAssets } from "../../../db/schema";
import { AppError } from "../../../errors";
import { reconcileDraftAssetsTx } from "../media-reconciliation";
import { lockVersion } from "../version-ops";

/**
 * Nagrania pytań i kart lekcji w panelu rodzica (spec tonu TTS §2.4, §4.5):
 * stan nagrania w DTO szkicu i „Nagraj ponownie”. Nagranie nie jest decyzją
 * rodzica ani warunkiem publikacji; ponowne nagranie to nowa generacja tego
 * samego fingerprintu, którą odsłuch (najnowsza gotowa generacja) podejmuje we
 * wszystkich wersjach współdzielących tekst. Gotowe zasoby pozostają niezmienne.
 */

/**
 * Stan najnowszej generacji o oczekiwanym fingerprincie (generacje od
 * najnowszej); `assetId` tylko dla gotowej. Trwająca albo nieudana generacja
 * niesie `previousAssetId` najnowszej gotowej: to ujęcie słyszy dziecko
 * (odsłuch bierze najnowszą gotową generację), więc rodzic może je odtworzyć.
 */
function audioDto(generations: readonly { id: string; state: string }[]): LessonPromptAudioDto {
  const newest = generations[0]!;
  if (newest.state === "ready") return { state: "ready", assetId: newest.id };
  const state = newest.state === "failed" ? "failed" : "pending";
  const previous = generations.find((generation) => generation.state === "ready");
  return previous ? { state, previousAssetId: previous.id } : { state };
}

/** Grupuje wiersze po kluczu, zachowując ich kolejność (tu: od najnowszej generacji). */
function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(key(row));
    if (group) group.push(row);
    else groups.set(key(row), [row]);
  }
  return groups;
}

// Generacja anulowana przez workera (zlecenie bez odniesień, np. tekst zmieniono przed
// nagraniem: zasób `failed`, run `superseded`) nie jest próbą nagrania, więc jej nie liczymy —
// inaczej panel pokazałby „Nie udało się nagrać”.
const notCancelled = sql`not exists (select 1 from ${generationRuns} where ${generationRuns.assetId} = ${mediaAssets.id} and ${generationRuns.state} = 'superseded')`;

/**
 * Stan nagrań wersji lekcji: pytania i zdania ćwiczeń słuchowych per rewizja
 * oraz karty w kolejności zagadnień tematu. Wiersz bez żadnej generacji swojego fingerprintu (albo brak wiersza)
 * nie daje wpisu. Jedno zapytanie na rodzaj nagrania dla całej wersji.
 */
export async function readLessonAudioStates(
  db: Executor,
  versionId: string,
  objectiveOrder: readonly string[],
): Promise<{ prompts: Map<string, LessonPromptAudioDto>; sentences: Map<string, LessonPromptAudioDto>; cards: LessonCardAudioDto[] }> {
  const readRevisionAudio = async (role: "prompt_audio" | "feedback_audio") => {
    const rows = await db
      .select({ itemRevisionId: revisionAssets.itemRevisionId, id: mediaAssets.id, state: mediaAssets.state })
      .from(revisionAssets)
      .innerJoin(itemRevisions, eq(itemRevisions.id, revisionAssets.itemRevisionId))
      .innerJoin(mediaAssets, eq(mediaAssets.fingerprint, revisionAssets.expectedFingerprint))
      .where(and(eq(itemRevisions.deckVersionId, versionId), eq(revisionAssets.role, role), eq(mediaAssets.kind, "tts"), notCancelled))
      .orderBy(desc(mediaAssets.generationNumber));
    const byRevision = new Map<string, LessonPromptAudioDto>();
    for (const [itemRevisionId, generations] of groupBy(rows, (row) => row.itemRevisionId)) {
      byRevision.set(itemRevisionId, audioDto(generations));
    }
    return byRevision;
  };
  const prompts = await readRevisionAudio("prompt_audio");
  // Zdanie ćwiczenia słuchowego (`feedback_audio`): to samo odczytanie stanu co pytanie.
  const sentences = await readRevisionAudio("feedback_audio");

  const cardRows = await db
    .select({ objectiveId: lessonCardAssets.objectiveId, cardIndex: lessonCardAssets.cardIndex, id: mediaAssets.id, state: mediaAssets.state })
    .from(lessonCardAssets)
    .innerJoin(mediaAssets, eq(mediaAssets.fingerprint, lessonCardAssets.expectedFingerprint))
    .where(and(eq(lessonCardAssets.deckVersionId, versionId), eq(mediaAssets.kind, "tts"), notCancelled))
    .orderBy(desc(mediaAssets.generationNumber));
  const cardsByKey = new Map<string, LessonCardAudioDto>();
  for (const [key, generations] of groupBy(cardRows, (row) => `${row.cardIndex}:${row.objectiveId}`)) {
    const { objectiveId, cardIndex } = generations[0]!;
    cardsByKey.set(key, { objectiveId, cardIndex, audio: audioDto(generations) });
  }
  const rank = (objectiveId: string) => {
    const index = objectiveOrder.indexOf(objectiveId);
    return index === -1 ? objectiveOrder.length : index;
  };
  const cards = [...cardsByKey.values()].sort((a, b) =>
    rank(a.objectiveId) - rank(b.objectiveId) || a.objectiveId.localeCompare(b.objectiveId) || a.cardIndex - b.cardIndex);
  return { prompts, sentences, cards };
}

/** Blokada wersji jak przy edycji szkicu; opublikowana wersja jest niezmienna. */
async function lockDraft(tx: Tx, versionId: string): Promise<{ id: string; state: string }> {
  const version = await lockVersion(tx, versionId);
  if (version.state === "published") {
    throw new AppError("immutable");
  }
  return version;
}

/** Bez konfiguracji mediów nie ma czym nagrywać. */
function assertMediaConfigured(services: Services): void {
  if (!services.media) throw new AppError("internal", { message: "media settings not configured" });
}

/**
 * Kolejna generacja fingerprintu (spec tonu TTS §2.4): fingerprint i żądanie
 * (rodzaj, provider, model, metadane) z najnowszego zasobu — bez przeliczania
 * z bieżącej konfiguracji, więc nowe ujęcie odpowiada dokładnie temu samemu
 * tekstowi i instrukcji. Trwająca generacja → jej `assetId` bez nowego wiersza.
 * `durationMs` dopisuje worker po nagraniu, więc nie przechodzi na nowe ujęcie.
 */
async function enqueueNextGenerationTx(tx: Tx, fingerprint: string): Promise<string> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${fingerprint}))`);
  const generations = await tx
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.fingerprint, fingerprint))
    .orderBy(desc(mediaAssets.generationNumber));
  const newest = generations[0];
  if (!newest) {
    throw new AppError("not_found");
  }
  const pending = generations.find((generation) => generation.state === "pending");
  if (pending) {
    return pending.id;
  }
  const { durationMs: _previousDuration, ...metadata } = newest.metadata;
  const id = randomUUID();
  await tx.insert(mediaAssets).values({
    id,
    kind: newest.kind,
    fingerprint,
    generationNumber: newest.generationNumber + 1,
    state: "pending",
    provider: newest.provider,
    model: newest.model,
    metadata,
  });
  await tx.insert(generationRuns).values({
    id: randomUUID(),
    assetId: id,
    kind: newest.kind,
    dedupeKey: `asset:${id}`,
    state: "queued",
    input: metadata,
  });
  return id;
}

const PromptAudioInputSchema = z.object({
  lessonDraftId: z.uuid(),
  itemRevisionId: z.uuid(),
});

const CardAudioInputSchema = z.object({
  lessonDraftId: z.uuid(),
  objectiveId: z.string().min(1),
  cardIndex: z.number().int().nonnegative(),
});

/**
 * Przed nowym ujęciem uzgadnia media szkicu jak zapis (`reconcileDraftAssetsTx`)
 * w tej samej transakcji. Gdy od ostatniego zapisu zmieniła się konfiguracja TTS
 * (provider, model, głos, styl), uzgodnienie przepina wiersz na fingerprint
 * bieżącej konfiguracji i jego nagranie (nowe zlecenie albo gotowe, wspólne z inną
 * wersją) wraz ze stanem wiersza — kolejnej generacji nie zlecamy (`rebound`).
 * Bez zmiany konfiguracji uzgodnienie zostawia wiersz bez zmian, a wywołujący
 * wskazuje w nim nową generację.
 */
async function reconcileThenNextTx(
  tx: Tx,
  services: Services,
  version: { id: string; state: string },
  readRow: () => Promise<{ expectedFingerprint: string; assetId: string | null } | undefined>,
): Promise<{ assetId: string; rebound: boolean }> {
  const before = await readRow();
  if (!before) {
    throw new AppError("not_found");
  }
  // `keepFailed`: nieudane zasoby wymagające decyzji rodzica (odpowiedzi, ilustracje) zostają;
  // nieudane nagrania pytań i kart uzgodnienie i tak zleca ponownie (nie są decyzją rodzica).
  await reconcileDraftAssetsTx(tx, services, version, { keepFailed: true });
  const after = await readRow();
  if (!after) {
    throw new AppError("not_found");
  }
  if (after.expectedFingerprint !== before.expectedFingerprint && after.assetId !== null) {
    return { assetId: after.assetId, rebound: true };
  }
  return { assetId: await enqueueNextGenerationTx(tx, after.expectedFingerprint), rebound: false };
}

/**
 * „Nagraj ponownie” pytania ćwiczenia w szkicu lekcji. Brak wersji, rewizji
 * w tej wersji, wiersza nagrania albo zasobu jego fingerprintu → `not_found`;
 * opublikowana wersja → `immutable`. Wiersz szkicu wskazuje nową generację.
 */
export async function regenerateLessonPromptAudio(
  services: Services,
  input: z.infer<typeof PromptAudioInputSchema>,
): Promise<{ assetId: string }> {
  const valid = PromptAudioInputSchema.parse(input);
  assertMediaConfigured(services);
  return services.db.transaction(async (tx) => {
    const version = await lockDraft(tx, valid.lessonDraftId);
    const readRow = async () => (
      await tx
        .select({ expectedFingerprint: revisionAssets.expectedFingerprint, assetId: revisionAssets.assetId })
        .from(revisionAssets)
        .innerJoin(itemRevisions, eq(itemRevisions.id, revisionAssets.itemRevisionId))
        .where(and(
          eq(revisionAssets.itemRevisionId, valid.itemRevisionId),
          eq(itemRevisions.deckVersionId, valid.lessonDraftId),
          eq(revisionAssets.role, "prompt_audio"),
        ))
    )[0];
    const { assetId, rebound } = await reconcileThenNextTx(tx, services, version, readRow);
    if (!rebound) {
      await tx
        .update(revisionAssets)
        .set({ assetId, state: "pending" })
        .where(and(eq(revisionAssets.itemRevisionId, valid.itemRevisionId), eq(revisionAssets.role, "prompt_audio")));
    }
    return { assetId };
  });
}

/**
 * „Nagraj ponownie” karty zagadnienia w szkicu lekcji (miejsce karty w temacie).
 * Brak wersji, wiersza nagrania karty albo zasobu jego fingerprintu →
 * `not_found`; opublikowana wersja → `immutable`.
 */
export async function regenerateLessonCardAudio(
  services: Services,
  input: z.infer<typeof CardAudioInputSchema>,
): Promise<{ assetId: string }> {
  const valid = CardAudioInputSchema.parse(input);
  assertMediaConfigured(services);
  return services.db.transaction(async (tx) => {
    const version = await lockDraft(tx, valid.lessonDraftId);
    const where = and(
      eq(lessonCardAssets.deckVersionId, valid.lessonDraftId),
      eq(lessonCardAssets.objectiveId, valid.objectiveId),
      eq(lessonCardAssets.cardIndex, valid.cardIndex),
    );
    const readRow = async () => (
      await tx.select({ expectedFingerprint: lessonCardAssets.expectedFingerprint, assetId: lessonCardAssets.assetId })
        .from(lessonCardAssets).where(where)
    )[0];
    const { assetId, rebound } = await reconcileThenNextTx(tx, services, version, readRow);
    if (!rebound) await tx.update(lessonCardAssets).set({ assetId }).where(where);
    return { assetId };
  });
}
