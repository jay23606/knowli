import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { AttemptInputSchema, type AttemptDto, type AttemptInput, type FeedbackDto } from "@learning/contracts";
import type { Services } from "../../../config";
import type { Tx } from "../../../db/client";
import { attempts, sessionTasks } from "../../../db/schema";
import { AppError } from "../../../errors";
import { lockTaskWithSession } from "../events";
import { discloseFeedbackEvent, requestHashOf } from "../attempt-shared";

/**
 * Odpowiedź na pytanie do historyjki (design „Historyjka lekcji” §8.3): jedna
 * próba wyboru kończy zadanie, ocena deterministyczna po id opcji. Poza
 * `finalizeLessonAttempt`: bez `assessments`, projekcji celu, cyklu wsparcia,
 * zadania „Skróć”, wywołań modelu i nagrania zdania. Ta sama blokada sesji,
 * idempotencja `clientAttemptId` i zamrożenie `received_at` co pozostałe próby;
 * feedback pieczętuje `feedback_issued` bez ekspozycji — nie ujawnia rozwiązania
 * żadnego ćwiczenia (poprawna opcja dotyczy treści historyjki, której zdania
 * zapieczętowało wydanie zadania).
 */

type TaskRow = typeof sessionTasks.$inferSelect;
type AttemptRow = typeof attempts.$inferSelect;

/** Prywatny klucz pytania (slot planu, `lesson-story-tasks.ts`). */
interface StoryQuestionKey {
  correctOptionId: string;
  optionValues: Record<string, string>;
}

function storyQuestionKeyOf(task: TaskRow): StoryQuestionKey {
  const key = task.answerKey as Partial<StoryQuestionKey>;
  if (typeof key.correctOptionId !== "string" || !key.optionValues || typeof key.optionValues[key.correctOptionId] !== "string") {
    throw new AppError("internal", { message: `story question without answer key: ${task.id}` });
  }
  return { correctOptionId: key.correctOptionId, optionValues: key.optionValues };
}

function dtoOf(attempt: AttemptRow, taskState: string, stepId: string | null): AttemptDto {
  return {
    attemptId: attempt.id,
    taskId: attempt.taskId,
    state: attempt.state as AttemptDto["state"],
    modality: attempt.modality as AttemptDto["modality"],
    feedback: (attempt.feedback as FeedbackDto | null) ?? null,
    taskState: taskState as AttemptDto["taskState"],
    stepId,
    receivedAt: attempt.receivedAt.toISOString(),
    completedAt: attempt.completedAt?.toISOString() ?? null,
  };
}

/** Ponowne ujawnienie zapisanego wyniku: kolejne `feedback_issued` bez ekspozycji. */
async function redisclose(tx: Tx, task: TaskRow, itemId: string, attempt: AttemptRow, now: Date): Promise<AttemptDto> {
  if (attempt.state !== "completed" || !attempt.feedback) return dtoOf(attempt, task.state, null);
  const stepId = await discloseFeedbackEvent(tx, { task, childId: task.childId, itemId, exposures: [], now });
  return dtoOf(attempt, task.state, stepId);
}

export async function answerStoryQuestion(services: Services, input: AttemptInput): Promise<AttemptDto> {
  const valid = AttemptInputSchema.parse(input);
  // Tylko wybór: „Nie pamiętam” liczyłby się jako trudność celu kotwicy, a tekst
  // i pozostałe modalności nie mają tu sensu (§8.3). Odrzucenie bez próby.
  if (valid.modality !== "choice") {
    throw new AppError("validation", { message: "story questions take a choice answer" });
  }
  return services.db.transaction(async (tx) => {
    const { task, session, itemId } = await lockTaskWithSession(tx, valid.taskId);
    if (task.exerciseType !== "lesson_story_question") {
      throw new AppError("validation", { message: "task is not a story question" });
    }
    const now = services.clock.now();
    const requestHash = requestHashOf(valid);

    // Jedno zapytanie: próby zadania i ewentualna próba o tym samym kluczu
    // w dowolnym zadaniu dziecka (unikalny indeks dałby inaczej 500).
    const related = await tx.select().from(attempts).where(or(
      eq(attempts.taskId, task.id),
      and(eq(attempts.childId, task.childId), eq(attempts.clientAttemptId, valid.clientAttemptId)),
    ));
    const existing = related.find((attempt) => attempt.clientAttemptId === valid.clientAttemptId);
    if (existing) {
      if (existing.taskId !== task.id || existing.requestHash !== requestHash) {
        throw new AppError("conflict", { message: "clientAttemptId reused with different answer" });
      }
      return redisclose(tx, task, itemId, existing, now);
    }
    if (session.state !== "active") {
      throw new AppError("conflict", { message: "session is closed" });
    }
    if (task.state !== "issued") {
      throw new AppError("conflict", { message: "task is no longer issued" });
    }
    const key = storyQuestionKeyOf(task);
    const optionText = key.optionValues[valid.optionId];
    if (optionText === undefined) {
      throw new AppError("validation", { message: "unknown option for this question" });
    }
    const feedback: FeedbackDto = valid.optionId === key.correctOptionId
      ? { kind: "great" }
      : { kind: "incorrect", correctText: key.optionValues[key.correctOptionId]! };

    const taskAttempts = related.filter((attempt) => attempt.taskId === task.id);
    const [attempt] = await tx.insert(attempts).values({
      id: randomUUID(),
      childId: task.childId,
      taskId: task.id,
      itemRevisionId: task.itemRevisionId,
      clientAttemptId: valid.clientAttemptId,
      requestHash,
      attemptNumber: taskAttempts.length + 1,
      modality: "choice",
      state: "completed",
      answer: { optionId: valid.optionId, optionText },
      // Kontekst zamrożony przy received_at; znacznik odróżnia próbę od ocenianych.
      context: { receivedAt: now.toISOString(), storyQuestion: true },
      feedback: feedback as unknown as Record<string, unknown>,
      policyId: session.policyId,
      receivedAt: now,
      completedAt: now,
    }).returning();
    await tx.update(sessionTasks).set({ state: "answered" }).where(eq(sessionTasks.id, task.id));
    // Bez wcześniejszych prób zadanie nie miało feedbacku (ujawnienia na żądanie
    // są dla pytań zablokowane) — licznik kroków znany bez zapytania.
    const stepId = await discloseFeedbackEvent(tx, {
      task, childId: task.childId, itemId, exposures: [], now,
      ...(taskAttempts.length === 0 ? { knownPriorCount: 0 } : {}),
    });
    return dtoOf(attempt!, "answered", stepId);
  });
}

/** Odczyt próby pytania (arch §12): ponowne ujawnienie wyniku pod blokadą sesji. */
export async function readStoryQuestionAttempt(services: Services, attempt: AttemptRow): Promise<AttemptDto> {
  return services.db.transaction(async (tx) => {
    const { task, itemId } = await lockTaskWithSession(tx, attempt.taskId);
    const fresh = (await tx.select().from(attempts).where(eq(attempts.id, attempt.id)))[0];
    if (!fresh) throw new AppError("not_found");
    return redisclose(tx, task, itemId, fresh, services.clock.now());
  });
}
