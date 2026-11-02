import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Services } from "../../config";
import type { Executor } from "../../db/client";
import { deckVersions, decks, generationRuns, itemRevisions, lessonCardAssets, mediaAssets, revisionAssets } from "../../db/schema";
import { AppError } from "../../errors";
import { isUiAudioAssetMetadata } from "../../domain/ui-audio-catalog";
import { mp3DurationMs } from "../../providers/audio/mp3-duration";
import { wavDurationMs } from "../../providers/audio/wav";
import { errorCodeOf, MAX_AUTOMATIC_ATTEMPTS, requireGeneration } from "./generation-runtime";

/** Lease zasobu mediów; deck nie ma lease (CHECK generation_runs_deck_without_lease). */
const MEDIA_LEASE_MS = 5 * 60_000;
/** Zwiększa licznik prób runu mediów; lease żyje na media_assets. */
async function claimMediaRun(db: Executor, assetId: string): Promise<number | null> {
  const claimed = await db
    .update(generationRuns)
    .set({ state: "running", attempts: sql`${generationRuns.attempts} + 1`, finishedAt: null })
    .where(
      and(
        eq(generationRuns.assetId, assetId),
        inArray(generationRuns.kind, ["tts", "illustration"]),
        inArray(generationRuns.state, ["queued", "running"]),
      ),
    )
    .returning({ attempts: generationRuns.attempts });
  return claimed[0]?.attempts ?? null;
}

async function failMediaAsset(
  services: Services,
  assetId: string,
  leaseToken: string,
  errorCode: string,
): Promise<void> {
  await services.db.transaction(async (tx) => {
    await tx
      .update(mediaAssets)
      .set({ state: "failed", leaseToken: null, leaseUntil: null })
      .where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.leaseToken, leaseToken)));
    await tx
      .update(generationRuns)
      .set({ state: "failed", errorCode, finishedAt: services.clock.now() })
      .where(
        and(eq(generationRuns.assetId, assetId), inArray(generationRuns.state, ["queued", "running"])),
      );
  });
}

/** Requeue cancellation only while this worker still owns the shared asset lease. */
async function requeueAbortedMediaAsset(services: Services, assetId: string, leaseToken: string): Promise<void> {
  await services.db.transaction(async (tx) => {
    const released = await tx.update(mediaAssets)
      .set({ leaseToken: null, leaseUntil: null })
      .where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.leaseToken, leaseToken)))
      .returning({ id: mediaAssets.id });
    if (released.length === 0) return;
    await tx.update(generationRuns)
      .set({ state: "queued", errorCode: null, finishedAt: null })
      .where(and(eq(generationRuns.assetId, assetId), eq(generationRuns.state, "running")));
  });
}

/**
 * Pending TTS używany wyłącznie przez lekcje z wyłączonym audio (także nagrania
 * kart nauki) nie powinien już wywoływać providera. Wspólny fingerprint zostaje
 * aktywny, jeśli odwołują się do niego słówka lub przedmiot z włączonym TTS.
 */
async function supersedeDisabledLessonTts(services: Services, asset: typeof mediaAssets.$inferSelect): Promise<boolean> {
  if (asset.kind !== "tts") return false;
  if (isUiAudioAssetMetadata(asset.metadata)) return false;
  return services.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${asset.fingerprint}))`);
    const current = (await tx.select().from(mediaAssets).where(eq(mediaAssets.id, asset.id)).for("update"))[0];
    if (current?.state !== "pending") return false;
    const references = await tx.select({ kind: decks.kind, lessonContext: deckVersions.lessonContext, role: revisionAssets.role })
      .from(revisionAssets)
      .innerJoin(itemRevisions, eq(itemRevisions.id, revisionAssets.itemRevisionId))
      .innerJoin(deckVersions, eq(deckVersions.id, itemRevisions.deckVersionId))
      .innerJoin(decks, eq(decks.id, itemRevisions.deckId))
      .where(eq(revisionAssets.assetId, asset.id));
    // Nagranie karty nauki (design szkoły §12.2) zależy od `ttsForPrompts` jak nagranie pytania.
    const cardReferences = await tx.select({ lessonContext: deckVersions.lessonContext })
      .from(lessonCardAssets)
      .innerJoin(deckVersions, eq(deckVersions.id, lessonCardAssets.deckVersionId))
      .where(eq(lessonCardAssets.assetId, asset.id));
    references.push(...cardReferences.map((card) => ({ kind: "lesson", lessonContext: card.lessonContext, role: "prompt_audio" as const })));
    if (references.length > 0 && !references.every(reference => {
      const subjectId = (reference.lessonContext as { subjectId?: string } | null)?.subjectId;
      const subject = typeof subjectId === "string" ? services.subjects.getSubject(subjectId) : undefined;
      if (reference.kind !== "lesson" || !subject) return false;
      // Nagranie pytania zależy od `ttsForPrompts`, zdania feedbacku od
      // `ttsForFeedbackSentence`, wyjaśnienie błędu od `exerciseExplanations`,
      // nagranie odpowiedzi od `ttsForAnswers`.
      if (reference.role === "prompt_audio") return !subject.ttsForPrompts;
      if (reference.role === "feedback_audio") return !subject.ttsForFeedbackSentence;
      if (reference.role === "explanation_audio") return !subject.exerciseExplanations;
      return !subject.ttsForAnswers;
    })) return false;
    await tx.update(mediaAssets).set({ state: "failed", leaseToken: null, leaseUntil: null })
      .where(eq(mediaAssets.id, asset.id));
    await tx.update(generationRuns).set({ state: "superseded", errorCode: null, finishedAt: services.clock.now() })
      .where(and(eq(generationRuns.assetId, asset.id), inArray(generationRuns.state, ["queued", "running"])));
    return true;
  });
}

/**
 * TTS zlecony przy innym providerze lub modelu niż ustawienia tego workera
 * (np. w trakcie przełączania z OpenAI na OpenRouter, design szkoły §11.7)
 * nie trafia do bieżącego endpointu: nowy nie zna starego modelu, a stary
 * worker nie może trwale unieważnić nagrań zleconych już z nową konfiguracją.
 * Zadanie zostaje w kolejce bez zmiany stanu dla workera ze zgodną konfiguracją.
 */
function isForeignTts(services: Services, asset: typeof mediaAssets.$inferSelect): boolean {
  const current = services.media?.tts;
  return asset.kind === "tts" && current !== undefined
    && (asset.provider !== current.provider || asset.model !== current.model);
}

/**
 * Wykonanie zadania zasobu: claim lease CAS, wywołanie providera, zapis
 * content-addressed i finalizeacja CAS w jednej transakcji. Finalizacja
 * aktualizuje wyłącznie globalny asset/run — powiązań szkicu nie rusza.
 */
export async function executeMediaAsset(services: Services, assetId: string, signal?: AbortSignal): Promise<void> {
  const deps = requireGeneration(services);
  if (signal?.aborted) return;
  const asset = (await services.db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)))[0];
  if (!asset) {
    throw new AppError("not_found");
  }
  if (asset.state === "ready") {
    await services.db
      .update(generationRuns)
      .set({ state: "succeeded", finishedAt: services.clock.now() })
      .where(
        and(eq(generationRuns.assetId, assetId), inArray(generationRuns.state, ["queued", "running"])),
      );
    return;
  }
  if (asset.state === "failed") {
    return;
  }
  if (await supersedeDisabledLessonTts(services, asset)) return;
  if (isForeignTts(services, asset)) return;

  const leaseToken = randomUUID();
  const now = services.clock.now();
  const claimed = await services.db
    .update(mediaAssets)
    .set({ leaseToken, leaseUntil: new Date(now.getTime() + MEDIA_LEASE_MS) })
    .where(
      and(
        eq(mediaAssets.id, assetId),
        eq(mediaAssets.state, "pending"),
        or(isNull(mediaAssets.leaseToken), sql`${mediaAssets.leaseUntil} < ${now}`),
      ),
    )
    .returning({ kind: mediaAssets.kind, metadata: mediaAssets.metadata });
  if (claimed.length === 0) {
    return;
  }

  const attempts = await claimMediaRun(services.db, assetId);
  if (attempts !== null && attempts > MAX_AUTOMATIC_ATTEMPTS) {
    await failMediaAsset(services, assetId, leaseToken, "attempts_exhausted");
    return;
  }

  const metadata = claimed[0]!.metadata as {
    text?: string;
    locale?: string;
    voice?: string;
    prompt?: string;
    model?: string;
    size?: string;
    quality?: string;
    format?: string;
    instructions?: string;
  };
  try {
    const result =
      asset.kind === "tts"
        ? await deps.tts.synthesize({
            text: metadata.text!,
            locale: metadata.locale!,
            voice: metadata.voice!,
            // Format, model i instrukcja z rekordu zasobu (wchodzą do jego
            // fingerprintu), nie z bieżącego env — zmiana konfiguracji nie może
            // zapisać nagrania pod starym fingerprintem.
            format: metadata.format === "wav" ? "wav" : "mp3",
            model: asset.model,
            ...(metadata.instructions === undefined ? {} : { instructions: metadata.instructions }),
          }, signal)
        : await deps.image.generate({
            prompt: metadata.prompt!,
            // Starsze zasoby sprzed parametryzacji quality/format: odtwarzamy
            // żądanie zgodne z ich fingerprintem (gpt-image-1, high, png).
            model: metadata.model ?? asset.model,
            size: metadata.size!,
            quality: metadata.quality ?? "high",
            format: metadata.format ?? "png",
          }, signal);
    if (signal?.aborted) {
      await requeueAbortedMediaAsset(services, assetId, leaseToken);
      return;
    }
    const stored = await deps.mediaStore.putImmutable(result.bytes, result.mimeType);
    const durationMs = asset.kind !== "tts" ? null
      : result.mimeType.startsWith("audio/mpeg") ? mp3DurationMs(result.bytes)
      : result.mimeType.startsWith("audio/wav") ? wavDurationMs(result.bytes)
      : null;

    await services.db.transaction(async (tx) => {
      const finalized = await tx
        .update(mediaAssets)
        .set({
          state: "ready",
          storageKey: stored.storageKey,
          contentSha256: stored.contentSha256,
          mimeType: result.mimeType,
          byteCount: stored.byteCount,
          ...(durationMs === null ? {} : { metadata: { ...asset.metadata, durationMs } }),
          leaseToken: null,
          leaseUntil: null,
        })
        .where(
          and(
            eq(mediaAssets.id, assetId),
            eq(mediaAssets.leaseToken, leaseToken),
            ne(mediaAssets.state, "ready"),
          ),
        )
        .returning({ id: mediaAssets.id });

      const done = finalized.length > 0 || (await assetReady(tx, assetId));
      if (done) {
        await tx
          .update(generationRuns)
          .set({ state: "succeeded", finishedAt: services.clock.now() })
          .where(
            and(
              eq(generationRuns.assetId, assetId),
              inArray(generationRuns.state, ["queued", "running"]),
            ),
          );
      }
      // przegrany CAS przy niedokończonym zasobie: nasz blob zostaje osierocony
    });
  } catch (error) {
    // porażka providera wraca do kolejki; wyczerpany budżet zamyka zasób.
    // Do logów trafia wyłącznie kod klasyfikacji i nasz własny kod adaptera
    // (`provider_http_400`, `provider_unexpected_audio`) — dowolny komunikat
    // providera może zawierać treść odpowiedzi HTTP.
    const detail = error instanceof Error && /^provider_[a-z0-9_]+$/.test(error.message) ? `, ${error.message}` : "";
    console.warn(
      `[generation] ${asset.kind} nie udało się (próba ${attempts ?? "?"}/${MAX_AUTOMATIC_ATTEMPTS}, asset ${assetId}, kod=${errorCodeOf(error)}${detail})`,
    );
    if (signal?.aborted) {
      await requeueAbortedMediaAsset(services, assetId, leaseToken);
      return;
    }
    if (attempts !== null && attempts >= MAX_AUTOMATIC_ATTEMPTS) {
      await failMediaAsset(services, assetId, leaseToken, "attempts_exhausted");
      return;
    }
    await services.db
      .update(mediaAssets)
      .set({ leaseToken: null, leaseUntil: null })
      .where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.leaseToken, leaseToken)));
    await services.db
      .update(generationRuns)
      .set({ state: "queued", errorCode: errorCodeOf(error), finishedAt: null })
      .where(and(eq(generationRuns.assetId, assetId), eq(generationRuns.state, "running")));
  }
}

async function assetReady(db: Executor, assetId: string): Promise<boolean> {
  const row = (
    await db.select({ state: mediaAssets.state }).from(mediaAssets).where(eq(mediaAssets.id, assetId))
  )[0];
  return row?.state === "ready";
}
