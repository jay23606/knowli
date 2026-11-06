import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { GenerationDto } from "@learning/contracts";
import type { Services } from "../../../config";
import type { Executor, Tx } from "../../../db/client";
import { deckVersions, generationRuns, itemRevisions } from "../../../db/schema";
import { AppError } from "../../../errors";
import {
  LESSON_STORY_LIMITS,
  solvedSentencesOf,
  validateLessonStory,
  type LessonStory,
} from "../../../domain/lessons/story";
import { resolveLessonTopic } from "../../../domain/lessons/topic-resolution";
import type { LessonExerciseDraft, LessonTopic, SubjectModule } from "../../../domain/lessons/types";
import type { LessonStoryInput } from "../../../ports/ai";
import {
  claimQueuedRun,
  enqueueGenerationRun,
  isStoryRunInput,
  LESSON_STORY_PURPOSE,
  lessonPoolRunFilter,
  lessonStoryRunFilter,
} from "../generation-runs";
import { MAX_AUTOMATIC_ATTEMPTS, requireGeneration } from "../generation-runtime";
import { reconcileLessonStoryAssetTx } from "../media-reconciliation";
import { classifyLessonGenerationFailure, lessonRetryDelayMs } from "./lesson-generation-errors";
import {
  assertLessonGenerationFinalizationAllowed,
  LessonGenerationCancelledError,
  withLessonGenerationControl,
} from "./lesson-generation-control";
import { DEFAULT_LESSON_GENERATION_POLICY } from "./lesson-generation-policy";
import { toExerciseDraft, type LessonContext, type LessonRunInput } from "./lesson-drafts";

/**
 * Run historyjki lekcji (design „Historyjka lekcji” §6, doprecyzowanie §6.2):
 * run `kind='lesson'` z `input.purpose='story'`. Nie podbija ani nie sprawdza
 * numeru edycji — finalizacja wymaga tylko, by run nadal był `running` z tą
 * samą liczbą prób, wersja nie była opublikowana, a historyjka przeszła
 * walidację wobec BIEŻĄCEJ puli (bariera ekspozycji). Zapis to scalenie klucza
 * `story` w `lesson_context` pod blokadą wersji. Zwykła edycja i dogenerowanie
 * celu go nie anulują; nowy pełny run lekcji i patch historyjki — tak.
 */

export { isStoryRunInput, LESSON_STORY_PURPOSE };

const GeneratedStorySchema = z.object({
  sentences: z.array(z.string()),
  questions: z.array(
    z.object({
      question: z.string(),
      options: z.array(z.string()),
      correctOptionIndex: z.number().int(),
    }),
  ),
});

/** Id opcji w kolejności: `a`, `b`, `c`, … */
function optionId(index: number): string {
  return String.fromCharCode("a".charCodeAt(0) + index);
}

/**
 * Surowy wynik modelu → `LessonStory`: pytania `q1`, `q2`, opcje `a`, `b`, `c`
 * w kolejności, `correctOption` z indeksu. `null` przy złym kształcie albo
 * indeksie spoza opcji. Reguły semantyczne sprawdza `validateLessonStory`.
 */
export function storyFromGenerated(raw: unknown): LessonStory | null {
  const parsed = GeneratedStorySchema.safeParse(raw);
  if (!parsed.success) return null;
  const questions = [];
  for (const [index, question] of parsed.data.questions.entries()) {
    if (question.options.length > 26) return null;
    if (question.correctOptionIndex < 0 || question.correctOptionIndex >= question.options.length) return null;
    questions.push({
      id: `q${index + 1}`,
      question: question.question.trim(),
      options: question.options.map((text, optionIndex) => ({ id: optionId(optionIndex), text: text.trim() })),
      correctOption: optionId(question.correctOptionIndex),
    });
  }
  return { sentences: parsed.data.sentences.map((sentence) => sentence.trim()), questions };
}

/**
 * Zleca run historyjki w transakcji wywołującego (po pełnym runie lekcji albo
 * z przycisku rodzica). `null`, gdy przedmiot kontekstu nie ma `lessonStory`.
 * Gdy run o kluczu `dedupeKey` albo aktywny run historyjki wersji już istnieje,
 * zwraca jego id bez wstawiania (wstawienie duplikatu klucza przerwałoby
 * transakcję wywołującego).
 */
export async function queueLessonStoryRunTx(
  tx: Tx,
  services: Services,
  version: { id: string; deckId: string; editNumber: number; lessonContext: Record<string, unknown> | null },
  dedupeKey: string,
): Promise<string | null> {
  const context = version.lessonContext as unknown as LessonContext | null;
  if (!context?.subjectId) return null;
  const subject = services.subjects.getSubject(context.subjectId);
  if (subject?.lessonStory !== true) return null;

  const prior = (await tx.select({ id: generationRuns.id }).from(generationRuns).where(eq(generationRuns.dedupeKey, dedupeKey)))[0];
  if (prior) return prior.id;
  const active = (await tx.select({ id: generationRuns.id }).from(generationRuns).where(and(
    eq(generationRuns.kind, "lesson"),
    eq(generationRuns.deckVersionId, version.id),
    inArray(generationRuns.state, ["queued", "running"]),
    lessonStoryRunFilter(),
  )).limit(1))[0];
  if (active) return active.id;

  const runId = randomUUID();
  const input: LessonRunInput = {
    deckId: version.deckId,
    deckVersionId: version.id,
    subjectId: context.subjectId,
    topicId: context.topicId,
    topicVersion: context.topicVersion,
    objectiveIds: [...(context.objectiveIds ?? [])],
    poolSize: context.poolSize,
    material: context.material,
    ...(context.instruction === undefined ? {} : { instruction: context.instruction }),
    ...(context.subjectTitlePl === undefined ? {} : { subjectTitlePl: context.subjectTitlePl }),
    ...(context.dynamicTopic === undefined ? {} : { dynamicTopic: context.dynamicTopic }),
    purpose: LESSON_STORY_PURPOSE,
  };
  await tx.insert(generationRuns).values({
    id: runId,
    deckVersionId: version.id,
    expectedEditNumber: version.editNumber,
    kind: "lesson",
    dedupeKey,
    state: "queued",
    input: input as unknown as Record<string, unknown>,
  });
  return runId;
}

/** Bieżąca pula ćwiczeń wersji (do bariery ekspozycji historyjki). */
async function poolDraftsOf(db: Executor, versionId: string): Promise<LessonExerciseDraft[]> {
  const rows = await db
    .select({ payload: itemRevisions.payload })
    .from(itemRevisions)
    .where(eq(itemRevisions.deckVersionId, versionId))
    .orderBy(itemRevisions.position);
  return rows.map((row) => toExerciseDraft(row.payload));
}

function storyInput(
  subject: SubjectModule,
  topic: LessonTopic,
  context: LessonContext,
  storyRules: string,
  avoidSentences: readonly string[],
): LessonStoryInput {
  const objectiveIds = new Set(context.objectiveIds ?? []);
  const objectives = topic.objectives.filter((objective) => objectiveIds.size === 0 || objectiveIds.has(objective.id));
  return {
    subjectTitle: context.subjectTitlePl ?? subject.titlePl,
    topicTitle: topic.titlePl,
    answerLocale: subject.answerLocale,
    promptLocale: subject.promptLocale,
    objectives: objectives.map((objective) => ({ id: objective.id, descriptionEn: objective.descriptionEn })),
    material: context.material,
    ...(context.instruction === undefined ? {} : { instruction: context.instruction }),
    generationRole: subject.prompts.generationRole,
    storyRules,
    avoidSentences: avoidSentences.slice(0, LESSON_STORY_LIMITS.avoidSentencesMax),
  };
}

export async function executeLessonStoryGeneration(
  services: Services,
  runId: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const deps = requireGeneration(services);
  const run = (await services.db.select().from(generationRuns).where(eq(generationRuns.id, runId)))[0];
  if (!run) {
    throw new AppError("not_found");
  }
  if (run.kind !== "lesson" || !isStoryRunInput(run.input)) {
    throw new AppError("internal", { message: "not a lesson story run" });
  }
  if (run.state !== "queued") {
    return;
  }
  if (options.signal?.aborted) return;
  const attempts = await claimQueuedRun(services.db, runId, run.expectedEditNumber ?? undefined, services.clock.now());
  if (attempts === null) {
    return;
  }
  const runStartedAtMs = Date.now();
  const versionId = run.deckVersionId!;
  const markCurrentRun = async (
    db: Executor,
    state: "failed" | "succeeded" | "superseded" | "queued",
    errorCode: string | null,
    nextAttemptAt: Date | null = null,
  ) => {
    const result = await db.update(generationRuns)
      .set({ state, errorCode, nextAttemptAt, finishedAt: state === "queued" ? null : services.clock.now() })
      .where(and(eq(generationRuns.id, runId), eq(generationRuns.state, "running"), eq(generationRuns.attempts, attempts)));
    if ((result as { rowCount?: number }).rowCount !== 0) {
      console.log(
        `[lesson-story] run=${runId} ${state === "queued" ? "ponowienie" : "zakończony"}: state=${state} kod=${errorCode ?? "-"} próba=${attempts}`,
      );
    }
  };
  if (attempts > MAX_AUTOMATIC_ATTEMPTS) {
    await markCurrentRun(services.db, "failed", "attempts_exhausted");
    return;
  }

  // Błąd rozliczany jak błąd providera: przejściowy wraca do kolejki z `nextAttemptAt`,
  // po wyczerpaniu prób albo przy błędzie terminalnym run kończy się `failed`.
  const settleFailure = async (error: unknown): Promise<void> => {
    const failure = classifyLessonGenerationFailure(error);
    if (!failure.retryable) {
      await markCurrentRun(services.db, "failed", failure.errorCode);
    } else if (attempts >= MAX_AUTOMATIC_ATTEMPTS) {
      await markCurrentRun(services.db, "failed", "attempts_exhausted");
    } else {
      const delay = lessonRetryDelayMs(attempts, failure.retryAfterMs, Math.random);
      const nextAttemptAt = new Date(services.clock.now().getTime() + delay);
      await markCurrentRun(services.db, "queued", failure.errorCode, nextAttemptAt);
    }
  };

  // Przygotowanie wejścia po przejęciu runu: wyjątek (np. przejściowy błąd bazy)
  // nie może zostawić runu w `running` bez automatycznego ponowienia.
  const prepare = async (): Promise<{ subject: SubjectModule; input: LessonStoryInput } | null> => {
    const version = (await services.db.select({ state: deckVersions.state, lessonContext: deckVersions.lessonContext })
      .from(deckVersions).where(eq(deckVersions.id, versionId)))[0];
    if (!version) {
      await markCurrentRun(services.db, "failed", "deck_version_gone");
      return null;
    }
    if (version.state === "published") {
      await markCurrentRun(services.db, "superseded", null);
      return null;
    }
    const context = version.lessonContext as unknown as LessonContext | null;
    const resolved = context?.subjectId ? resolveLessonTopic(services.subjects, context) : undefined;
    const storyRules = resolved?.subject.prompts.storyRules?.trim();
    if (!context || !resolved || resolved.subject.lessonStory !== true || !storyRules) {
      await markCurrentRun(services.db, "failed", "validation");
      return null;
    }
    const { subject, topic } = resolved;
    return {
      subject,
      input: storyInput(subject, topic, context, storyRules, solvedSentencesOf(await poolDraftsOf(services.db, versionId))),
    };
  };
  let prepared: Awaited<ReturnType<typeof prepare>>;
  try {
    prepared = await prepare();
  } catch (error) {
    console.error(`[lesson-story] run=${runId} błąd przygotowania wejścia próba=${attempts}`);
    await settleFailure(error);
    return;
  }
  if (!prepared) return;
  const { subject, input } = prepared;

  const executionPolicy = deps.lessonExecution ?? DEFAULT_LESSON_GENERATION_POLICY;
  const runDeadlineAtMs = runStartedAtMs + executionPolicy.runTimeoutMs;
  console.log(
    `[lesson-story] generacja run=${runId} deck=${(run.input as unknown as LessonRunInput).deckId} próba=${attempts} pomijane=${input.avoidSentences.length} model=${deps.llm.model}`,
  );
  let raw: unknown;
  try {
    raw = await withLessonGenerationControl({
      ...executionPolicy,
      signal: options.signal,
      assertCurrent: async () => {
        const [current] = await services.db.select({ state: generationRuns.state, attempts: generationRuns.attempts })
          .from(generationRuns).where(eq(generationRuns.id, runId));
        const [currentVersion] = await services.db.select({ state: deckVersions.state })
          .from(deckVersions).where(eq(deckVersions.id, versionId));
        return current?.state === "running" && current.attempts === attempts &&
          currentVersion !== undefined && currentVersion.state !== "published";
      },
    }, async (control) => (await control.call((signal) => deps.llm.generateLessonStory(input, signal))).story);
  } catch (error) {
    if (error instanceof LessonGenerationCancelledError) {
      if (error.reason === "shutdown") await markCurrentRun(services.db, "queued", null, null);
      // Publikacja w trakcie wywołania modelu: run kończy się jako `superseded`.
      // CAS na `running` + próbie nie rusza runu, który zmienił już ktoś inny.
      else await markCurrentRun(services.db, "superseded", null);
      return;
    }
    const failure = classifyLessonGenerationFailure(error);
    console.error(`[lesson-story] run=${runId} błąd LLM: kod=${failure.errorCode} retryable=${failure.retryable} próba=${attempts}`);
    await settleFailure(error);
    return;
  }

  // Finalizacja w terminalnym try/catch: nieprzewidziany wyjątek rozlicza run,
  // nie zostawia go w stanie running (jak w `executeLessonGeneration`).
  try {
    assertLessonGenerationFinalizationAllowed(runDeadlineAtMs, options.signal);
    await services.db.transaction(async (tx) => {
      const locked = (await tx.select().from(deckVersions).where(eq(deckVersions.id, versionId)).for("update"))[0];
      const current = (await tx.select().from(generationRuns).where(eq(generationRuns.id, runId)).for("update"))[0];
      if (!current || current.state !== "running" || current.attempts !== attempts) return;
      assertLessonGenerationFinalizationAllowed(runDeadlineAtMs, options.signal);
      if (!locked) {
        await markCurrentRun(tx, "failed", "deck_version_gone");
        return;
      }
      if (locked.state === "published") {
        await markCurrentRun(tx, "superseded", null);
        return;
      }
      const story = storyFromGenerated(raw);
      if (!story) {
        console.log(`[lesson-story] run=${runId} odrzucona: zły kształt wyniku`);
        await markCurrentRun(tx, "failed", "story_invalid");
        return;
      }
      // Bariera ekspozycji wobec puli z tej transakcji (rodzic mógł ją zmienić w trakcie runu).
      const solvedSentences = solvedSentencesOf(await poolDraftsOf(tx, versionId));
      const errors = validateLessonStory(story, { normalizer: subject.normalizer, solvedSentences });
      if (errors.length > 0) {
        console.log(`[lesson-story] run=${runId} odrzucona: błędy=${errors.length}`);
        await markCurrentRun(tx, "failed", "story_invalid");
        return;
      }
      const prevContext = (locked.lessonContext ?? {}) as Record<string, unknown>;
      await tx.update(deckVersions)
        .set({ lessonContext: { ...prevContext, story } as unknown as Record<string, unknown> })
        .where(eq(deckVersions.id, versionId));
      // Run zmienia tylko historyjkę, więc uzgadniamy samo jej nagranie (nie cały szkic).
      await reconcileLessonStoryAssetTx(tx, services, locked);
      await markCurrentRun(tx, "succeeded", null);
    });
    console.log(`[lesson-story] run=${runId} durationMs=${Date.now() - runStartedAtMs}`);
  } catch (error) {
    console.error(`[lesson-story] run=${runId} nieprzewidziany błąd walidacji/zapisu`);
    if (error instanceof LessonGenerationCancelledError) {
      if (error.reason === "shutdown") await markCurrentRun(services.db, "queued", null, null);
    } else if (classifyLessonGenerationFailure(error).errorCode === "provider_timeout") {
      await markCurrentRun(services.db, "failed", "provider_timeout");
    } else if (attempts >= MAX_AUTOMATIC_ATTEMPTS) {
      await markCurrentRun(services.db, "failed", "attempts_exhausted");
    } else {
      await markCurrentRun(services.db, "failed", "validation");
    }
  }
}

/**
 * Przycisk rodzica „Wygeneruj historyjkę ponownie” (struktura jak
 * `regenerateObjective`): idempotentnie po `clientRequestId`. Wersja
 * opublikowana → `immutable`; inny numer edycji albo aktywny run lekcji
 * (puli lub historyjki) → `conflict`; wersja bez ćwiczeń albo przedmiot bez
 * `lessonStory` → `validation`.
 * Nie podbija numeru edycji.
 */
export async function regenerateLessonStory(
  services: Services,
  args: { deckVersionId: string; expectedEditNumber: number; clientRequestId: string },
): Promise<{ runId: string; deckId: string }> {
  const dedupeKey = `lesson-story:${args.clientRequestId}`;
  return enqueueGenerationRun(services.db, dedupeKey, async (tx) => {
    const version = (await tx.select().from(deckVersions).where(eq(deckVersions.id, args.deckVersionId)).for("update"))[0];
    if (!version) {
      throw new AppError("not_found");
    }
    const prior = (await tx.select({ id: generationRuns.id }).from(generationRuns).where(eq(generationRuns.dedupeKey, dedupeKey)))[0];
    if (prior) return { runId: prior.id, deckId: version.deckId };
    if (version.state === "published") {
      throw new AppError("immutable");
    }
    if (version.editNumber !== args.expectedEditNumber) {
      throw new AppError("conflict");
    }
    const activeRun = (await tx.select({ id: generationRuns.id }).from(generationRuns).where(and(
      eq(generationRuns.kind, "lesson"),
      eq(generationRuns.deckVersionId, version.id),
      inArray(generationRuns.state, ["queued", "running"]),
    )).limit(1))[0];
    if (activeRun) throw new AppError("conflict");
    // Bez puli bariera ekspozycji nie ma czego chronić — historyjka powstaje dopiero do ćwiczeń.
    const exercise = (await tx.select({ id: itemRevisions.id }).from(itemRevisions)
      .where(eq(itemRevisions.deckVersionId, version.id)).limit(1))[0];
    if (!exercise) {
      throw new AppError("validation", { message: "lesson has no exercises" });
    }
    const runId = await queueLessonStoryRunTx(tx, services, version, dedupeKey);
    if (runId === null) {
      throw new AppError("validation", { message: "subject has no lesson story" });
    }
    return { runId, deckId: version.deckId };
  });
}

/**
 * Najnowszy run `lesson` wersji o danym celu (polling panelu rodzica): `pool` —
 * generowanie puli (pełne i dogenerowanie), `story` — historyjka.
 */
export async function latestLessonRunOfPurpose(
  db: Executor,
  deckVersionId: string,
  purpose: "pool" | "story",
): Promise<GenerationDto | null> {
  const run = (
    await db
      .select()
      .from(generationRuns)
      .where(and(
        eq(generationRuns.deckVersionId, deckVersionId),
        eq(generationRuns.kind, "lesson"),
        purpose === "story" ? lessonStoryRunFilter() : lessonPoolRunFilter(),
      ))
      .orderBy(desc(generationRuns.createdAt))
      .limit(1)
  )[0];
  if (!run) {
    return null;
  }
  const deckId = (
    await db.select({ deckId: deckVersions.deckId }).from(deckVersions).where(eq(deckVersions.id, deckVersionId))
  )[0]?.deckId ?? null;
  return {
    id: run.id,
    deckId,
    deckVersionId: run.deckVersionId ?? null,
    state: run.state as GenerationDto["state"],
    attempts: run.attempts,
    errorCode: run.errorCode ?? null,
    // Lekcje liczą odrzucenia w `LessonDraftDto.rejectedCount` (z `lesson_context`), nie w runie.
    rejectedCount: null,
  };
}

/** Najnowszy run historyjki wersji (`LessonDeckDto.storyGeneration`, Task 5). */
export async function latestLessonStoryRun(db: Executor, deckVersionId: string): Promise<GenerationDto | null> {
  return latestLessonRunOfPurpose(db, deckVersionId, "story");
}
