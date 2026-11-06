import { z } from "zod";
import { DaySchema, InstantSchema, UuidSchema } from "./common";

export const ParentWorkCardQuerySchema = z.object({ childId: UuidSchema, date: DaySchema.optional() }).strict();

const NonNegativeInt = z.number().int().nonnegative();

/** Wykluczenie zadania wskazane przez model; widoczne tylko w retencji 7 dni. */
export const ParentActivityExcludedTaskDtoSchema = z.object({
  taskOrdinal: NonNegativeInt,
  reason: z.string().min(1).max(300),
}).strict();

const ParentActivityTaskDetailSchema = z.object({
  taskOrdinal: NonNegativeInt,
  instruction: z.string(),
  stimulus: z.string().nullable(),
  options: z.array(z.string()),
  acceptedAnswers: z.array(z.string()),
  submittedAnswers: z.array(z.string()),
  activeMilliseconds: NonNegativeInt,
  editCount: NonNegativeInt,
  playbackCount: NonNegativeInt,
  modelNote: z.string().nullable(),
}).strict();

/**
 * Wynik oceny aktywności jednej sesji. `not_delivered` = sesja zakończona bez
 * raportu (systemowo/z innego urządzenia) — to JAWNY brak oceny, nie zero
 * potwierdzonej aktywności.
 */
export const ParentSessionActivityDtoSchema = z.object({
  status: z.enum(["evaluated", "error", "not_delivered"]),
  durationSeconds: NonNegativeInt,
  activeSeconds: NonNegativeInt,
  approvedSeconds: NonNegativeInt,
  pointsAwarded: NonNegativeInt,
  reason: z.string().nullable(),
  errorCode: z.string().nullable(),
  /** Szczegóły wykluczeń znikają po 7 dniach retencji raportu. */
  excludedTasks: z.array(ParentActivityExcludedTaskDtoSchema).nullable(),
  /** Zadaniowy snapshot oceny, dostępny wyłącznie w siedmiodniowej retencji. */
  details: z.object({ modelReason: z.string(), tasks: z.array(ParentActivityTaskDetailSchema) }).strict().nullable(),
}).strict();
export type ParentSessionActivityDto = z.infer<typeof ParentSessionActivityDtoSchema>;

export const ParentWorkCardDtoSchema = z.object({
  childId: UuidSchema,
  date: DaySchema,
  /** Suma zatwierdzonego czasu sesji ocenionych, zakończonych tego dnia. */
  creditedSeconds: NonNegativeInt,
  /** Liczba sesji tego dnia bez oceny aktywności (brak raportu albo błąd). */
  unevaluatedSessions: NonNegativeInt,
  reviewService: z.string().nullable(),
  sessions: z.array(z.object({
    sessionId: UuidSchema,
    mode: z.enum(["training", "mock_test", "daily_round"]),
    state: z.enum(["active", "completed", "ended"]),
    startedAt: InstantSchema,
    endedAt: InstantSchema.nullable(),
    deckTitle: z.string(),
    deckVersionNumber: z.number().int().positive(),
    remainingSteps: NonNegativeInt,
    activity: ParentSessionActivityDtoSchema,
    steps: z.array(z.object({
      taskId: UuidSchema,
      ordinal: NonNegativeInt,
      exerciseType: z.string(),
      state: z.enum(["issued", "answered", "completed", "skipped"]),
      issuedAt: InstantSchema,
      responses: z.array(z.object({
        modality: z.enum(["choice", "text", "audio", "dont_remember", "skip", "sequence", "selection", "assignment"]),
        answerExample: z.string().max(160).nullable(),
        feedbackKind: z.string().nullable(),
        assessment: z.enum(["assessed", "unassessed", "mixed", "none"]).nullable(),
        /**
         * Wynik zapisanych ocen odpowiedzi: wszystkie ocenione umiejętności poprawne,
         * wszystkie błędne albo `partial` — część poprawna (np. treść dobra, pisownia nie)
         * albo ocena „prawie” (wymowa w paśmie „ćwicz”, „prawie” modelu, literówka w lekcji)
         * — także gdy cel lekcji został zaliczony; postęp liczy się z ocen, nie z tego pola.
         * `null` — brak oceny poprawności: pominięcie, „Nie pamiętam”, odpowiedź nieoceniona.
         */
        outcome: z.enum(["correct", "incorrect", "partial"]).nullable(),
        responseSeconds: NonNegativeInt,
      }).strict()),
    }).strict()),
  }).strict()),
}).strict();
export type ParentWorkCardDto = z.infer<typeof ParentWorkCardDtoSchema>;
