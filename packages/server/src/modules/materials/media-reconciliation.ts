import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { LessonVoiceToneSchema, type MediaPendingDetails } from "@learning/contracts";
import { ttsVoiceFor, type MediaSettings, type Services } from "../../config";
import type { Executor, Tx } from "../../db/client";
import {
  deckVersions,
  generationRuns,
  itemRevisions,
  lessonCardAssets,
  mediaAssets,
  revisionAssets,
} from "../../db/schema";
import { AppError } from "../../errors";
import { imageFingerprint, illustrationPrompt, ttsFingerprint } from "../../domain/media-fingerprint";
import { lessonPromptStyle, type TtsStyle } from "../../domain/tts-style";
import { ttsRequestInstructions } from "../../providers/tts-style-profile";
import { payloadToItem } from "./item-payload";
import { feedbackSentenceText } from "../../domain/lessons/feedback-sentence-text";
import { questionReadText } from "../../domain/lessons/question-read-text";
import { renderCard } from "../../domain/lessons/card";
import { cardReadText } from "../../domain/lessons/card-read-text";
import { resolveLessonTopic } from "../../domain/lessons/topic-resolution";
import type { DynamicTopicData, LessonTopic } from "../../domain/lessons/types";

export type AssetRole = "target_audio" | "example_audio" | "illustration" | "prompt_audio" | "feedback_audio" | "explanation_audio";

interface RequiredAsset {
  role: AssetRole;
  kind: "tts" | "illustration";
  fingerprint: string;
  metadata: Record<string, unknown>;
}

/**
 * Wymagane zasoby karty: audio celu zawsze, audio przykładu gdy istnieje,
 * ilustracja gdy visualType=image (kolory/liczby/sekwencje renderujemy
 * deterministycznie). Fingerprint pokrywa pełne żądanie generacji.
 */
export function requiredAssetsFor(
  item: ReturnType<typeof payloadToItem>,
  settings: MediaSettings,
): RequiredAsset[] {
  const required: RequiredAsset[] = [ttsAsset("target_audio", item.target, item.locales.target, settings)];
  if (item.example !== undefined) {
    required.push(ttsAsset("example_audio", item.example, item.locales.target, settings));
  }
  if (item.visualType === "image") {
    const prompt = illustrationPrompt(item);
    required.push({
      role: "illustration",
      kind: "illustration",
      fingerprint: imageFingerprint({
        prompt,
        provider: settings.image.provider,
        model: settings.image.model,
        size: settings.image.size,
        quality: settings.image.quality,
        format: settings.image.format,
      }),
      // Pełne żądanie w metadanych: executor i fingerprint widzą to samo,
      // także gdy env zmieni się między planowaniem a wykonaniem.
      metadata: {
        kind: "illustration",
        prompt,
        model: settings.image.model,
        size: settings.image.size,
        quality: settings.image.quality,
        format: settings.image.format,
      },
    });
  }
  return required;
}

/**
 * Czy payload rewizji to ćwiczenie lekcji (`lesson_exercise`), rozpoznane po
 * polu `exerciseType`. Payload słówek go nie ma. Pozwala `reconcileDraftAssetsTx`
 * wybrać strategię zasobów per rodzaj elementu bez czytania `learning_items.kind`.
 */
function isLessonExercisePayload(payload: Record<string, unknown>): boolean {
  return typeof payload.exerciseType === "string";
}

/** Flagi mediów przedmiotu lekcji (z rejestru przedmiotów). */
export interface LessonTtsFlags {
  ttsForAnswers: boolean;
  ttsForPrompts: boolean;
  ttsForFeedbackSentence: boolean;
  /** Przedmiot ma wyjaśnienie błędu dla dziecka (`explanationPl`) z nagraniem `explanation_audio`. */
  exerciseExplanations: boolean;
}

/** Locale nagrania pytania: polecenia i pytania przedmiotów szkolnych są po polsku (design szkoły §11.2). */
const PROMPT_AUDIO_LOCALE = "pl-PL";

/**
 * Styl wypowiedzi (spec tonu TTS) przekazują tylko nagrania pytań i kart; słówka
 * i `target_audio` bez stylu, więc ich fingerprinty się nie zmieniają. Sam styl
 * nie trafia do metadanych — wchodzi do `instructions`.
 */
function ttsAsset(role: AssetRole, text: string, locale: string, settings: MediaSettings, style?: TtsStyle): RequiredAsset {
  const voice = ttsVoiceFor(settings.tts, locale);
  const instructions = ttsRequestInstructions(settings.tts, locale, style);
  return {
    role,
    kind: "tts",
    fingerprint: ttsFingerprint({
      text,
      locale,
      provider: settings.tts.provider,
      model: settings.tts.model,
      voice,
      format: settings.tts.format,
      instructions,
    }),
    metadata: {
      kind: "tts",
      text,
      locale,
      voice,
      format: settings.tts.format,
      ...(instructions === undefined ? {} : { instructions }),
    },
  };
}

/**
 * Wymagane zasoby ćwiczenia lekcji (design „Generowanie puli”): `target_audio`
 * odpowiedzi kanonicznej w `answerLocale`, gdy przedmiot ma `ttsForAnswers`,
 * oraz `prompt_audio` polecenia i pytania (design szkoły §11), gdy ma
 * `ttsForPrompts` i typ ćwiczenia ma co czytać. Bez ilustracji i bez audio
 * przykładu.
 */
export function requiredAssetsForLessonExercise(
  payload: Record<string, unknown>,
  settings: MediaSettings,
  flags: LessonTtsFlags,
): RequiredAsset[] {
  const required: RequiredAsset[] = [];
  const answer = typeof payload.answer === "string" ? payload.answer : "";
  const answerLocale = typeof payload.answerLocale === "string" ? payload.answerLocale : "";
  if (flags.ttsForAnswers && answer !== "" && answerLocale !== "") {
    required.push(ttsAsset("target_audio", answer, answerLocale, settings));
  }
  const question = flags.ttsForPrompts ? questionReadText(questionSourceOf(payload)) : null;
  if (question !== null) {
    const style = lessonPromptStyle("lesson_question", voiceToneOf(payload.voiceTone), question);
    required.push(ttsAsset("prompt_audio", question, PROMPT_AUDIO_LOCALE, settings, style));
  }
  // Pełne zdanie czytane po odpowiedzi: bez stylu (style dotyczą pl-PL), język z `answerLocale`.
  const sentence = flags.ttsForFeedbackSentence && answerLocale !== "" ? feedbackSentenceText(feedbackSourceOf(payload)) : null;
  if (sentence !== null) {
    required.push(ttsAsset("feedback_audio", sentence, answerLocale, settings));
  }
  // Wyjaśnienie błędu: zawsze po polsku, stały styl roli (ton lektora ćwiczenia go nie dotyczy).
  const explanation = flags.exerciseExplanations && typeof payload.explanationPl === "string" ? payload.explanationPl.trim() : "";
  if (explanation !== "") {
    required.push(ttsAsset("explanation_audio", explanation, PROMPT_AUDIO_LOCALE, settings, "lesson_explanation"));
  }
  return required;
}

/** Ton lektora z payloadu rewizji; wartość spoza enumu (np. stary payload) = brak tonu. */
function voiceToneOf(value: unknown) {
  const parsed = LessonVoiceToneSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function feedbackSourceOf(payload: Record<string, unknown>) {
  const entries = (value: unknown) =>
    Array.isArray(value)
      ? value.flatMap((entry: unknown) => {
          const { id, text } = (entry ?? {}) as { id?: unknown; text?: unknown };
          return typeof id === "string" && typeof text === "string" ? [{ id, text }] : [];
        })
      : undefined;
  return {
    exerciseType: optionalText(payload.exerciseType) ?? "",
    stem: optionalText(payload.stem),
    answer: optionalText(payload.answer),
    options: entries(payload.options),
    correctOption: optionalText(payload.correctOption),
    items: entries(payload.items),
    clozeText: optionalText(payload.clozeText),
    gapAnswers: optionalTexts(payload.gapAnswers),
  };
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Lista tekstów albo `undefined`, gdy to nie lista samych tekstów (bez częściowego odczytu). */
function optionalTexts(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function questionSourceOf(payload: Record<string, unknown>) {
  const groups = Array.isArray(payload.groups)
    ? payload.groups.flatMap((group: unknown) => {
        const label = (group as { label?: unknown } | null)?.label;
        return typeof label === "string" ? [{ label }] : [];
      })
    : undefined;
  return {
    exerciseType: optionalText(payload.exerciseType) ?? "",
    instructionPl: optionalText(payload.instructionPl),
    stem: optionalText(payload.stem),
    prompt: optionalText(payload.prompt),
    groups,
    clozeText: optionalText(payload.clozeText),
  };
}

/** Kontekst lekcji potrzebny do nagrań kart (podzbiór `lesson_context`). */
export interface LessonCardContext {
  readonly objectiveIds: readonly string[];
  readonly examples: Readonly<Record<string, readonly string[]>>;
}

/** Wymagane nagranie karty nauki: miejsce karty w temacie i żądanie TTS. */
export interface RequiredCardAsset {
  objectiveId: string;
  cardIndex: number;
  asset: RequiredAsset;
}

/**
 * Nagrania „Posłuchaj karty” (design szkoły §12.2): dla każdej karty zagadnień
 * wersji tekst `cardReadText` z tej samej wyrenderowanej karty, którą dostaje
 * dziecko (`renderCard` z przykładami lekcji). Karta ze wzorem albo za długa
 * nie ma nagrania. Puste, gdy przedmiot nie ma `ttsForPrompts`.
 */
export function requiredAssetsForLessonCards(
  topic: LessonTopic,
  context: LessonCardContext,
  settings: MediaSettings,
  flags: Pick<LessonTtsFlags, "ttsForPrompts">,
): RequiredCardAsset[] {
  if (!flags.ttsForPrompts) return [];
  const required: RequiredCardAsset[] = [];
  for (const objective of topic.objectives) {
    if (!context.objectiveIds.includes(objective.id)) continue;
    objective.cards.forEach((card, cardIndex) => {
      const text = cardReadText(renderCard(card, [...(context.examples[objective.id] ?? [])]));
      if (text !== null) {
        const style = lessonPromptStyle("lesson_card", card.voiceTone, text);
        required.push({ objectiveId: objective.id, cardIndex, asset: ttsAsset("prompt_audio", text, PROMPT_AUDIO_LOCALE, settings, style) });
      }
    });
  }
  return required;
}

/**
 * Zwraca wymagane zasoby rewizji wg rodzaju elementu: ćwiczenie lekcji ma własną
 * strategię (audio odpowiedzi i pytania wg flag przedmiotu), słówko —
 * dotychczasową. Flagi ustala wywołujący z rejestru przedmiotów (dla słówek bez
 * znaczenia). Jedno miejsce rozgałęzienia strategii mediów.
 */
function requiredAssetsForRevision(
  payload: Record<string, unknown>,
  settings: MediaSettings,
  flags: LessonTtsFlags,
): RequiredAsset[] {
  if (isLessonExercisePayload(payload)) {
    return requiredAssetsForLessonExercise(payload, settings, flags);
  }
  return requiredAssetsFor(payloadToItem(payload), settings);
}


async function findOrCreateAsset(
  tx: Tx,
  settings: MediaSettings,
  req: RequiredAsset,
): Promise<{ id: string; state: "pending" | "ready" }> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${req.fingerprint}))`);

  const ready = (
    await tx
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.fingerprint, req.fingerprint), eq(mediaAssets.state, "ready")))
      .orderBy(desc(mediaAssets.generationNumber))
      .limit(1)
  )[0];
  if (ready) {
    return { id: ready.id, state: "ready" };
  }

  const pending = (
    await tx
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.fingerprint, req.fingerprint), eq(mediaAssets.state, "pending")))
      .orderBy(desc(mediaAssets.generationNumber))
      .limit(1)
  )[0];
  if (pending) {
    return { id: pending.id, state: "pending" };
  }

  const counted = (
    await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(mediaAssets)
      .where(eq(mediaAssets.fingerprint, req.fingerprint))
  )[0]!;
  const id = randomUUID();
  await tx.insert(mediaAssets).values({
    id,
    kind: req.kind,
    fingerprint: req.fingerprint,
    generationNumber: counted.count + 1,
    state: "pending",
    provider: req.kind === "tts" ? settings.tts.provider : settings.image.provider,
    model: req.kind === "tts" ? settings.tts.model : settings.image.model,
    metadata: req.metadata,
  });
  await tx.insert(generationRuns).values({
    id: randomUUID(),
    assetId: id,
    kind: req.kind,
    dedupeKey: `asset:${id}`,
    state: "queued",
    input: req.metadata,
  });
  return { id, state: "pending" };
}

/**
 * Uzgadnia powiązania zasobów szkicu w transakcji edycji: zachowuje zgodne,
 * odłącza niezgodne i zleca brakujące. Świadome pominięcie ilustracji trwa
 * przy niezmienionym znaczeniu wizualizacji (niezmienionym fingerprintcie).
 */
export async function reconcileDraftAssetsTx(
  tx: Tx,
  services: Services,
  version: { id: string; state: string },
  options: {
    /**
     * Publikacja nie ponawia nieudanych zasobów: kosztowna regeneracja wymaga
     * jawnej decyzji rodzica (Regeneruj albo pomiń), a walidator zgłasza błąd.
     */
    keepFailed?: boolean;
  } = {},
): Promise<void> {
  const settings = services.media;
  if (!settings) {
    return;
  }
  if (version.state === "published") {
    throw new AppError("immutable");
  }
  await reconcileLessonCardAssetsTx(tx, services, settings, version.id);
  const revisions = await tx
    .select({ id: itemRevisions.id, payload: itemRevisions.payload })
    .from(itemRevisions)
    .where(eq(itemRevisions.deckVersionId, version.id))
    .orderBy(asc(itemRevisions.position));
  if (revisions.length === 0) {
    return;
  }

  // Dla ćwiczeń lekcji strategia zasobów zależy od flag TTS przedmiotu;
  // czytamy je raz z lesson_context tej wersji (słówka ich nie potrzebują).
  const flags: LessonTtsFlags = { ttsForAnswers: false, ttsForPrompts: false, ttsForFeedbackSentence: false, exerciseExplanations: false };
  if (revisions.some((r) => isLessonExercisePayload(r.payload))) {
    const row = (
      await tx
        .select({ lessonContext: deckVersions.lessonContext })
        .from(deckVersions)
        .where(eq(deckVersions.id, version.id))
    )[0];
    const subjectId = (row?.lessonContext as { subjectId?: string } | null)?.subjectId;
    const subject = subjectId ? services.subjects.getSubject(subjectId) : undefined;
    if (subject) {
      flags.ttsForAnswers = subject.ttsForAnswers;
      flags.ttsForPrompts = subject.ttsForPrompts;
      flags.ttsForFeedbackSentence = subject.ttsForFeedbackSentence;
      flags.exerciseExplanations = subject.exerciseExplanations;
    }
  }

  const rows = await tx
    .select()
    .from(revisionAssets)
    .where(inArray(revisionAssets.itemRevisionId, revisions.map((r) => r.id)));
  const rowsByRevision = new Map<string, Map<string, (typeof rows)[number]>>();
  for (const row of rows) {
    const mine = rowsByRevision.get(row.itemRevisionId) ?? new Map();
    mine.set(row.role, row);
    rowsByRevision.set(row.itemRevisionId, mine);
  }

  for (const revision of revisions) {
    const required = requiredAssetsForRevision(revision.payload, settings, flags);
    const mine = rowsByRevision.get(revision.id) ?? new Map();

    // role, których karta już nie wymaga, znikają ze szkicu
    for (const row of mine.values()) {
      if (!required.some((r) => r.role === row.role)) {
        await tx
          .delete(revisionAssets)
          .where(
            and(
              eq(revisionAssets.itemRevisionId, revision.id),
              eq(revisionAssets.role, row.role),
            ),
          );
      }
    }

    for (const req of required) {
      const existing = mine.get(req.role);
      if (existing && existing.expectedFingerprint === req.fingerprint) {
        if (existing.state === "omitted") {
          continue;
        }
        if (existing.assetId !== null) {
          const asset = (
            await tx
              .select({ state: mediaAssets.state, fingerprint: mediaAssets.fingerprint })
              .from(mediaAssets)
              .where(eq(mediaAssets.id, existing.assetId))
          )[0];
          // Nagranie pytania, zdania feedbacku i wyjaśnienia błędu nie jest decyzją rodzica (brak
          // „Regeneruj” w panelu, design szkoły §11.2) i jest tanie: publikacja zleca je ponownie.
          if (asset && asset.fingerprint === req.fingerprint && asset.state === "failed" && options.keepFailed
            && req.role !== "prompt_audio" && req.role !== "feedback_audio" && req.role !== "explanation_audio") {
            continue;
          }
          if (asset && asset.fingerprint === req.fingerprint && asset.state !== "failed") {
            const nextState = asset.state === "ready" ? "approved" : "pending";
            if (existing.state !== nextState) {
              await tx
                .update(revisionAssets)
                .set({ state: nextState })
                .where(
                  and(
                    eq(revisionAssets.itemRevisionId, revision.id),
                    eq(revisionAssets.role, req.role),
                  ),
                );
            }
            continue;
          }
        }
      }
      const asset = await findOrCreateAsset(tx, settings, req);
      const nextState = asset.state === "ready" ? "approved" : "pending";
      if (existing) {
        await tx
          .update(revisionAssets)
          .set({ expectedFingerprint: req.fingerprint, assetId: asset.id, state: nextState })
          .where(
            and(
              eq(revisionAssets.itemRevisionId, revision.id),
              eq(revisionAssets.role, req.role),
            ),
          );
      } else {
        await tx.insert(revisionAssets).values({
          itemRevisionId: revision.id,
          role: req.role,
          assetId: asset.id,
          expectedFingerprint: req.fingerprint,
          state: nextState,
        });
      }
    }
  }
}

/**
 * Uzgadnia nagrania kart nauki szkicu (design szkoły §12.2) w transakcji
 * edycji: zgodne zostają, zmienione dostają nowy zasób (gotowy po fingerprincie
 * albo nowe zlecenie), zbędne znikają. Nieudane nagranie zlecamy ponownie —
 * nie jest decyzją rodzica i nie blokuje publikacji.
 */
async function reconcileLessonCardAssetsTx(
  tx: Tx,
  services: Services,
  settings: MediaSettings,
  versionId: string,
): Promise<void> {
  const row = (
    await tx.select({ lessonContext: deckVersions.lessonContext }).from(deckVersions).where(eq(deckVersions.id, versionId))
  )[0];
  const context = row?.lessonContext as {
    subjectId?: unknown;
    topicId?: unknown;
    topicVersion?: unknown;
    objectiveIds?: unknown;
    examples?: Record<string, string[]>;
    dynamicTopic?: DynamicTopicData;
  } | null | undefined;
  // Zestaw słówek nie ma kontekstu lekcji ani kart nauki.
  if (!context || typeof context.subjectId !== "string" || typeof context.topicId !== "string") return;
  const resolved = resolveLessonTopic(services.subjects, {
    subjectId: context.subjectId,
    topicId: context.topicId,
    topicVersion: typeof context.topicVersion === "number" ? context.topicVersion : 1,
    ...(context.dynamicTopic ? { dynamicTopic: context.dynamicTopic } : {}),
  });
  const required = resolved
    ? requiredAssetsForLessonCards(
        resolved.topic,
        { objectiveIds: Array.isArray(context.objectiveIds) ? context.objectiveIds : [], examples: context.examples ?? {} },
        settings,
        resolved.subject,
      )
    : [];

  const cardKey = (objectiveId: string, cardIndex: number) => `${cardIndex}:${objectiveId}`;
  const existing = await tx.select().from(lessonCardAssets).where(eq(lessonCardAssets.deckVersionId, versionId));
  const existingByKey = new Map(existing.map((card) => [cardKey(card.objectiveId, card.cardIndex), card] as const));
  const requiredKeys = new Set(required.map((card) => cardKey(card.objectiveId, card.cardIndex)));
  for (const card of existing) {
    if (requiredKeys.has(cardKey(card.objectiveId, card.cardIndex))) continue;
    await tx.delete(lessonCardAssets).where(and(
      eq(lessonCardAssets.deckVersionId, versionId),
      eq(lessonCardAssets.objectiveId, card.objectiveId),
      eq(lessonCardAssets.cardIndex, card.cardIndex),
    ));
  }
  for (const card of required) {
    const current = existingByKey.get(cardKey(card.objectiveId, card.cardIndex));
    if (current && current.expectedFingerprint === card.asset.fingerprint && current.assetId !== null) {
      const asset = (
        await tx.select({ state: mediaAssets.state, fingerprint: mediaAssets.fingerprint }).from(mediaAssets).where(eq(mediaAssets.id, current.assetId))
      )[0];
      if (asset && asset.fingerprint === card.asset.fingerprint && asset.state !== "failed") continue;
    }
    const asset = await findOrCreateAsset(tx, settings, card.asset);
    if (current) {
      await tx.update(lessonCardAssets)
        .set({ expectedFingerprint: card.asset.fingerprint, assetId: asset.id })
        .where(and(
          eq(lessonCardAssets.deckVersionId, versionId),
          eq(lessonCardAssets.objectiveId, card.objectiveId),
          eq(lessonCardAssets.cardIndex, card.cardIndex),
        ));
    } else {
      await tx.insert(lessonCardAssets).values({
        deckVersionId: versionId,
        objectiveId: card.objectiveId,
        cardIndex: card.cardIndex,
        assetId: asset.id,
        expectedFingerprint: card.asset.fingerprint,
      });
    }
  }
}

/** Uzgodnienie poza edycją (np. po zapisie wyniku generacji przez rodzica). */
export async function reconcileDraftAssets(services: Services, draftId: string): Promise<void> {
  return services.db.transaction(async (tx) => {
    const version = (
      await tx.select().from(deckVersions).where(eq(deckVersions.id, draftId)).for("update")
    )[0];
    if (!version) {
      throw new AppError("not_found");
    }
    if (version.state === "published") {
      throw new AppError("immutable");
    }
    await reconcileDraftAssetsTx(tx, services, version);
  });
}

/**
 * Pierwszy krok publikacji (issue #106): uzgodnienie mediów w osobnej,
 * zatwierdzanej transakcji, jak przy każdej edycji szkicu. Walidacja gotowości
 * w transakcji publikacji może potem paść na zasobie `pending`, nie zabierając
 * ze sobą świeżo zleconych zasobów i zadań generacji. Gdy wersja jest już
 * opublikowana albo numer edycji się rozjechał, nic nie uzgadnia: właściwy
 * błąd zgłasza transakcja publikacji.
 */
export async function reconcileBeforePublish(
  services: Services,
  versionId: string,
  expectedEditNumber: number,
): Promise<void> {
  await services.db.transaction(async (tx) => {
    const version = (
      await tx.select().from(deckVersions).where(eq(deckVersions.id, versionId)).for("update")
    )[0];
    if (!version || version.state === "published" || version.editNumber !== expectedEditNumber) {
      return;
    }
    await reconcileDraftAssetsTx(tx, services, version, { keepFailed: true });
  });
}

const RegenerateInputSchema = z.object({
  draftId: z.uuid(),
  itemRevisionId: z.uuid(),
  role: z.enum(["target_audio", "example_audio", "illustration"]),
});

const OmitInputSchema = z.object({
  draftId: z.uuid(),
  itemRevisionId: z.uuid(),
});

/**
 * Świadoma decyzja rodzica o pominięciu ilustracji (CHECK: tylko rola
 * illustration może być omitted). Zły obraz przestaje blokować publikację;
 * pominięcie trwa przy niezmienionym fingerprintcie, a jawna regeneracja
 * przywraca stan pending.
 */
export async function omitRevisionAsset(
  services: Services,
  input: z.infer<typeof OmitInputSchema>,
): Promise<void> {
  const valid = OmitInputSchema.parse(input);
  const settings = services.media;
  if (!settings) {
    throw new AppError("internal", { message: "media settings not configured" });
  }
  return services.db.transaction(async (tx) => {
    const version = (
      await tx.select().from(deckVersions).where(eq(deckVersions.id, valid.draftId)).for("update")
    )[0];
    if (!version) {
      throw new AppError("not_found");
    }
    if (version.state === "published") {
      throw new AppError("immutable");
    }
    if (version.vocabularyFormat === "picture") {
      throw new AppError("validation", { message: "Picture vocabulary illustrations cannot be omitted." });
    }
    const revision = (
      await tx
        .select({ payload: itemRevisions.payload })
        .from(itemRevisions)
        .where(
          and(eq(itemRevisions.id, valid.itemRevisionId), eq(itemRevisions.deckVersionId, valid.draftId)),
        )
    )[0];
    if (!revision) {
      throw new AppError("not_found");
    }
    const req = requiredAssetsFor(payloadToItem(revision.payload), settings).find(
      (r) => r.role === "illustration",
    );
    if (!req) {
      throw new AppError("validation", { message: "illustration not required by item" });
    }
    await tx
      .insert(revisionAssets)
      .values({
        itemRevisionId: valid.itemRevisionId,
        role: "illustration",
        assetId: null,
        expectedFingerprint: req.fingerprint,
        state: "omitted",
      })
      .onConflictDoUpdate({
        target: [revisionAssets.itemRevisionId, revisionAssets.role],
        set: { state: "omitted" },
      });
  });
}

/**
 * Świadoma regeneracja: nowy numer generacji i nowy asset_id także dla tych
 * samych ustawień. Zatwierdzone zasoby starej wersji pozostają nietknięte;
 * szkic przechodzi na pending do czasu gotowości nowego zasobu.
 */
export async function regenerateRevisionAsset(
  services: Services,
  input: z.infer<typeof RegenerateInputSchema>,
): Promise<{ assetId: string }> {
  const valid = RegenerateInputSchema.parse(input);
  const settings = services.media;
  if (!settings) {
    throw new AppError("internal", { message: "media settings not configured" });
  }
  return services.db.transaction(async (tx) => {
    const version = (
      await tx.select().from(deckVersions).where(eq(deckVersions.id, valid.draftId)).for("update")
    )[0];
    if (!version) {
      throw new AppError("not_found");
    }
    if (version.state === "published") {
      throw new AppError("immutable");
    }
    const revision = (
      await tx
        .select({ payload: itemRevisions.payload })
        .from(itemRevisions)
        .where(
          and(eq(itemRevisions.id, valid.itemRevisionId), eq(itemRevisions.deckVersionId, valid.draftId)),
        )
    )[0];
    if (!revision) {
      throw new AppError("not_found");
    }
    const req = requiredAssetsFor(payloadToItem(revision.payload), settings).find(
      (r) => r.role === valid.role,
    );
    if (!req) {
      throw new AppError("validation", { message: `role ${valid.role} not required by item` });
    }

    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${req.fingerprint}))`);
    const counted = (
      await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(mediaAssets)
        .where(eq(mediaAssets.fingerprint, req.fingerprint))
    )[0]!;
    const assetId = randomUUID();
    await tx.insert(mediaAssets).values({
      id: assetId,
      kind: req.kind,
      fingerprint: req.fingerprint,
      generationNumber: counted.count + 1,
      state: "pending",
      provider: req.kind === "tts" ? settings.tts.provider : settings.image.provider,
      model: req.kind === "tts" ? settings.tts.model : settings.image.model,
      metadata: req.metadata,
    });
    await tx.insert(generationRuns).values({
      id: randomUUID(),
      assetId,
      kind: req.kind,
      dedupeKey: `asset:${assetId}`,
      state: "queued",
      input: req.metadata,
    });
    await tx
      .insert(revisionAssets)
      .values({
        itemRevisionId: valid.itemRevisionId,
        role: req.role,
        assetId,
        expectedFingerprint: req.fingerprint,
        state: "pending",
      })
      .onConflictDoUpdate({
        target: [revisionAssets.itemRevisionId, revisionAssets.role],
        set: { assetId, expectedFingerprint: req.fingerprint, state: "pending" },
      });
    return { assetId };
  });
}

/**
 * Wydanie gotowego zasobu do podglądu (GET /api/v1/media/:id). Tylko stan
 * ready; identyfikator jest nieprzejrzysty i nie wyznacza ekspozycji dziecka.
 */
export async function readReadyMedia(
  services: Services,
  assetId: string,
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const parsed = z.uuid().safeParse(assetId);
  if (!parsed.success) {
    return null;
  }
  const id = parsed.data;
  const asset = (
    await services.db
      .select({ state: mediaAssets.state, storageKey: mediaAssets.storageKey, mimeType: mediaAssets.mimeType })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, id))
  )[0];
  if (!asset || asset.state !== "ready" || !asset.storageKey || !services.mediaStore) {
    return null;
  }
  const blob = await services.mediaStore.get(asset.storageKey);
  if (!blob) {
    return null;
  }
  // kopia do własnego ArrayBuffer: BodyInit/BlobPart wymagają Uint8Array<ArrayBuffer>
  return { bytes: new Uint8Array(blob.bytes), mimeType: asset.mimeType ?? blob.mimeType };
}

/** Maksymalny bok ilustracji serwowanej klientowi (wyświetlanie, nie oryginał). */
export const ILLUSTRATION_DISPLAY_MAX_PX = 768;

/**
 * Wariant wyświetlania ilustracji: oryginał generowany 1024×1024 (PNG nawet
 * ~1,7 MB) trafia w aplikacji na kafelki kilkuset px, więc route mediów
 * serwuje przeskalowane WebP — zwykle kilkadziesiąt KB. Magazyn i rekord
 * zasobu pozostają nietknięte; transformacja liczy się w locie i jest
 * cache'owana w procesie. Błąd transformacji degraduje do oryginału.
 */
export async function toDisplayIllustration(bytes: Uint8Array): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  try {
    const out = await sharp(bytes, { failOn: "error" })
      .rotate()
      .resize({ width: ILLUSTRATION_DISPLAY_MAX_PX, height: ILLUSTRATION_DISPLAY_MAX_PX, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    return { bytes: Uint8Array.from(out), mimeType: "image/webp" };
  } catch {
    return null;
  }
}

const DISPLAY_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const displayIllustrationCache = new Map<string, { bytes: Uint8Array; mimeType: string }>();
let displayIllustrationCacheBytes = 0;

function cacheDisplayIllustration(cacheKey: string, variant: { bytes: Uint8Array; mimeType: string }): void {
  const size = variant.bytes.byteLength;
  if (size > DISPLAY_CACHE_MAX_BYTES) return;
  const existing = displayIllustrationCache.get(cacheKey);
  if (existing) {
    displayIllustrationCacheBytes -= existing.bytes.byteLength;
    displayIllustrationCache.delete(cacheKey);
  }
  while (displayIllustrationCacheBytes + size > DISPLAY_CACHE_MAX_BYTES) {
    const oldest = displayIllustrationCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    displayIllustrationCacheBytes -= displayIllustrationCache.get(oldest)!.bytes.byteLength;
    displayIllustrationCache.delete(oldest);
  }
  displayIllustrationCache.set(cacheKey, variant);
  displayIllustrationCacheBytes += size;
}

export interface ReadyMediaStream {
  body: AsyncIterable<Uint8Array>;
  mimeType: string;
  byteCount: number | null;
  /**
   * Czy odpowiedź wolno oznaczyć rocznym cache immutable. Fałsz tylko dla
   * awaryjnego oryginału ilustracji po błędzie transformacji: ten sam URL
   * docelowo zwraca wariant WebP, więc oryginał nie może zostać przypięty
   * w cache klienta na rok (review workflow, zatruwanie cache).
   */
  immutableCache: boolean;
}

async function* singleChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

/**
 * Serwowanie gotowego zasobu klientowi (GET /api/v1/media/:id): audio leci
 * strumieniem z dysku bez ładowania całości do pamięci procesu, ilustracje
 * jako przeskalowany wariant WebP (powyżej). Tylko stan ready, jak
 * `readReadyMedia`; brak strumienia w magazynie degraduje do `get`.
 */
export async function readReadyMediaStream(
  services: Services,
  assetId: string,
): Promise<ReadyMediaStream | null> {
  const parsed = z.uuid().safeParse(assetId);
  if (!parsed.success) {
    return null;
  }
  const id = parsed.data;
  const asset = (
    await services.db
      .select({ state: mediaAssets.state, storageKey: mediaAssets.storageKey, mimeType: mediaAssets.mimeType, kind: mediaAssets.kind, byteCount: mediaAssets.byteCount })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, id))
  )[0];
  if (!asset || asset.state !== "ready" || !asset.storageKey || !services.mediaStore) {
    return null;
  }
  if (asset.kind === "illustration" && (asset.mimeType?.startsWith("image/") ?? false)) {
    // klucz obejmuje storageKey: ponownie użyte id z innymi bajtami (np.
    // odbudowana baza w tym samym procesie) nie serwuje starego wariantu
    const cacheKey = `${id}:${asset.storageKey}`;
    const cached = displayIllustrationCache.get(cacheKey);
    if (cached) {
      return { body: singleChunk(cached.bytes), mimeType: cached.mimeType, byteCount: cached.bytes.byteLength, immutableCache: true };
    }
    const blob = await services.mediaStore.get(asset.storageKey);
    if (!blob) {
      return null;
    }
    const variant = await toDisplayIllustration(blob.bytes);
    if (variant) {
      cacheDisplayIllustration(cacheKey, variant);
      return { body: singleChunk(variant.bytes), mimeType: variant.mimeType, byteCount: variant.bytes.byteLength, immutableCache: true };
    }
    return { body: singleChunk(new Uint8Array(blob.bytes)), mimeType: asset.mimeType ?? blob.mimeType, byteCount: blob.bytes.byteLength, immutableCache: false };
  }
  if (services.mediaStore.getStream) {
    const streamed = await services.mediaStore.getStream(asset.storageKey);
    if (!streamed) {
      return null;
    }
    return { body: streamed.body, mimeType: asset.mimeType ?? streamed.mimeType, byteCount: asset.byteCount ?? streamed.byteCount, immutableCache: true };
  }
  const blob = await services.mediaStore.get(asset.storageKey);
  if (!blob) {
    return null;
  }
  return { body: singleChunk(new Uint8Array(blob.bytes)), mimeType: asset.mimeType ?? blob.mimeType, byteCount: blob.bytes.byteLength, immutableCache: true };
}

/**
 * Publikacja sprawdza gotowość i zgodność fingerprintu powiązanego zasobu.
 * Zasób w generacji zwraca `"pending"` zamiast błędu: wywołujący kończy
 * pozostałe sprawdzenia i dopiero wtedy zgłasza `mediaPendingError`, żeby
 * nieudany zasób na dalszej karcie nie ukrył się za „przygotowują się”.
 * Gotowy zasób z powiązaniem innym niż `approved` też jest `"pending"`:
 * worker mógł go skończyć już po uzgodnieniu w tej transakcji, a sesje
 * wybierają wyłącznie powiązania `approved`. Ponowna publikacja je promuje.
 */
export async function assertAssetPublishable(
  db: Executor,
  input: {
    itemRevisionId: string;
    role: AssetRole;
    assetId: string | null;
    expectedFingerprint: string;
    linkState: "pending" | "approved" | "omitted";
  },
): Promise<"ready" | "pending"> {
  if (input.assetId === null) {
    throw new AppError("validation", {
      message: `${input.role} not linked for revision ${input.itemRevisionId}`,
    });
  }
  const asset = (
    await db
      .select({ state: mediaAssets.state, fingerprint: mediaAssets.fingerprint })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, input.assetId))
  )[0];
  if (asset && asset.state === "pending" && asset.fingerprint === input.expectedFingerprint) {
    return "pending";
  }
  if (!asset || asset.state !== "ready" || asset.fingerprint !== input.expectedFingerprint) {
    throw new AppError("validation", {
      message: `${input.role} not ready for revision ${input.itemRevisionId}`,
    });
  }
  return input.linkState === "approved" ? "ready" : "pending";
}

/** Jedyny błąd publikacji, po którym rodzic czeka: generacja trwa i nic innego nie blokuje. */
export function mediaPendingError(pending: { role: AssetRole; itemRevisionId: string }): AppError {
  return new AppError("validation", {
    message: `${pending.role} pending for revision ${pending.itemRevisionId}`,
    details: { media: "pending" } satisfies MediaPendingDetails,
  });
}
