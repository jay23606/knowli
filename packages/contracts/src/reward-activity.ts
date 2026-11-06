import { z } from "zod";
import { InstantSchema, UuidSchema } from "./common";

/**
 * Kontrakty raportu aktywności sesji i prostej oceny punktów (spec
 * client-reward-time). FE zbiera aktywność lokalnie i wysyła JEDEN raport na
 * koniec sesji; serwer dołącza własne zadania/odpowiedzi, jeden raz woła model
 * (lista wykluczonych zadań) i wyłącznie kod liczy czas oraz punkty
 * (1 pkt / 60 s, reszta przechodzi między sesjami).
 */

/** Wersja formatu raportu; zmiana wersji wymaga odświeżenia klienta. */
export const SESSION_ACTIVITY_REPORT_VERSION = 1;

/** Maksymalna liczba skompaktowanych wpisów (przedziały/okna/odsłuchy/pauzy). */
export const SESSION_ACTIVITY_MAX_ENTRIES = 4096;
/** Maksymalna liczba zadań w raporcie (największa wspierana kartkówka + zapas). */
export const SESSION_ACTIVITY_MAX_TASKS = 512;
// Rozłącznych okien aktywności nie da się skompaktować bez zmiany naliczanego
// czasu. Ogranicza je więc istniejący globalny limit wpisów.
export const SESSION_ACTIVITY_MAX_INTERVALS_PER_TASK = SESSION_ACTIVITY_MAX_ENTRIES;
export const SESSION_ACTIVITY_MAX_EDITS_PER_TASK = 256;
export const SESSION_ACTIVITY_MAX_ATTEMPTS_PER_TASK = 64;
export const SESSION_ACTIVITY_MAX_PLAYBACKS_PER_TASK = 128;
export const SESSION_ACTIVITY_MAX_PAUSES_PER_TASK = 128;

/** Twardy sufit rozmiaru raportu przyjmowanego przez serwer (256 KiB). */
export const SESSION_ACTIVITY_REPORT_MAX_BYTES = 256 * 1024;

/** Rodzaje przerw pomiaru; `unobserved` to brak obserwacji (np. odświeżenie). */
export const SessionActivityPauseKindSchema = z.enum([
  "background",
  "blur",
  "offline",
  "idle",
  "technical_wait",
  "unobserved",
]);
export type SessionActivityPauseKind = z.infer<typeof SessionActivityPauseKindSchema>;

/** Przedział aktywności w milisekundach od początku pomiaru [start, koniec]. */
export const SessionActivityIntervalSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);

/** Zagregowane okno edycji: czas początku okna i liczba zmian w oknie. */
export const SessionActivityEditWindowSchema = z.object({
  atMs: z.number().int().nonnegative(),
  count: z.number().int().positive(),
}).strict();

/** Rzeczywisty odsłuch: start/koniec odtwarzania od początku pomiaru. */
export const SessionActivityPlaybackSchema = z.object({
  assetId: UuidSchema,
  fromMs: z.number().int().nonnegative(),
  toMs: z.number().int().nonnegative(),
}).strict();

export const SessionActivityPauseSchema = z.object({
  kind: SessionActivityPauseKindSchema,
  fromMs: z.number().int().nonnegative(),
  toMs: z.number().int().nonnegative(),
}).strict();

/** Aktywność jednego zadania; identyfikatory służą wyłącznie powiązaniu. */
export const SessionActivityTaskReportSchema = z.object({
  taskId: UuidSchema,
  exerciseType: z.string().min(1),
  shownFromMs: z.number().int().nonnegative(),
  shownToMs: z.number().int().nonnegative(),
  activeIntervals: z.array(SessionActivityIntervalSchema).max(SESSION_ACTIVITY_MAX_INTERVALS_PER_TASK),
  editCount: z.number().int().nonnegative(),
  editWindows: z.array(SessionActivityEditWindowSchema).max(SESSION_ACTIVITY_MAX_EDITS_PER_TASK),
  submittedAttempts: z.array(UuidSchema).max(SESSION_ACTIVITY_MAX_ATTEMPTS_PER_TASK),
  playbacks: z.array(SessionActivityPlaybackSchema).max(SESSION_ACTIVITY_MAX_PLAYBACKS_PER_TASK),
  pauses: z.array(SessionActivityPauseSchema).max(SESSION_ACTIVITY_MAX_PAUSES_PER_TASK),
}).strict();
export type SessionActivityTaskReport = z.infer<typeof SessionActivityTaskReportSchema>;

/** Suma długości unii przedziałów (bez nakładania). */
export function unionDurationMs(intervals: readonly (readonly [number, number])[]): number {
  const sorted = [...intervals]
    .filter(([from, to]) => to > from)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let lastEnd = -1;
  for (const [from, to] of sorted) {
    const start = Math.max(from, lastEnd);
    if (to > start) {
      total += to - start;
      lastEnd = to;
    }
  }
  return total;
}

/** Aktywny czas zadania = unia przedziałów aktywności i rzeczywistych odsłuchów. */
export function taskActiveMs(task: Pick<SessionActivityTaskReport, "activeIntervals" | "playbacks">): number {
  return unionDurationMs([
    ...task.activeIntervals,
    ...task.playbacks.map((playback) => [playback.fromMs, playback.toMs] as const),
  ]);
}

export const SessionActivityReportSchema = z
  .object({
    version: z.literal(SESSION_ACTIVITY_REPORT_VERSION),
    /** Czas od pierwszego pokazania zadania do zamrożenia raportu. */
    elapsedMs: z.number().int().positive(),
    /** Suma unii aktywnych przedziałów wszystkich zadań. */
    activeMs: z.number().int().nonnegative(),
    compacted: z.boolean(),
    /** Raport nie mieścił się w limitach pamięci/rozmiaru — jawnie odnotowane. */
    incomplete: z.enum(["storage_unavailable", "size_limit"]).optional(),
    tasks: z.array(SessionActivityTaskReportSchema).max(SESSION_ACTIVITY_MAX_TASKS),
  })
  .strict()
  .superRefine((report, ctx) => {
    let entries = 0;
    const taskUnions: { from: number; to: number }[][] = [];
    const seenTaskIds = new Set<string>();
    for (const [index, task] of report.tasks.entries()) {
      const path = ["tasks", index];
      if (seenTaskIds.has(task.taskId)) {
        ctx.addIssue({ code: "custom", path: [...path, "taskId"], message: "taskId appears more than once in the report" });
      }
      seenTaskIds.add(task.taskId);
      if (task.shownToMs < task.shownFromMs) {
        ctx.addIssue({ code: "custom", path: [...path, "shownToMs"], message: "shownToMs precedes shownFromMs" });
      }
      if (task.shownToMs > report.elapsedMs) {
        ctx.addIssue({ code: "custom", path: [...path, "shownToMs"], message: "task presentation exceeds report elapsed time" });
      }
      for (const [from, to] of [...task.activeIntervals, ...task.playbacks.map((p) => [p.fromMs, p.toMs] as const)]) {
        if (to < from) {
          ctx.addIssue({ code: "custom", path: [...path, "activeIntervals"], message: "interval ends before it starts" });
        }
        if (from < 0 || to > report.elapsedMs) {
          ctx.addIssue({ code: "custom", path: [...path, "activeIntervals"], message: "interval outside report time range" });
        }
      }
      for (const pause of task.pauses) {
        if (pause.toMs < pause.fromMs) {
          ctx.addIssue({ code: "custom", path: [...path, "pauses"], message: "pause ends before it starts" });
        }
        if (pause.fromMs < 0 || pause.toMs > report.elapsedMs) {
          ctx.addIssue({ code: "custom", path: [...path, "pauses"], message: "pause outside report time range" });
        }
      }
      for (const window of task.editWindows) {
        if (window.atMs > report.elapsedMs) {
          ctx.addIssue({ code: "custom", path: [...path, "editWindows"], message: "edit window outside report time range" });
        }
      }
      entries += task.activeIntervals.length + task.editWindows.length
        + task.submittedAttempts.length + task.playbacks.length + task.pauses.length;
      // Unia aktywnego czasu jednego zadania: nakładanie przedziału na odsłuch
      // jest dopuszczalne wewnątrz zadania (B02), nie między zadaniami.
      const union: { from: number; to: number }[] = [];
      for (const span of [...task.activeIntervals, ...task.playbacks.map((p) => [p.fromMs, p.toMs] as const)]
        .filter(([from, to]) => to > from)
        .map(([from, to]) => ({ from, to }))
        .sort((a, b) => a.from - b.from)) {
        const last = union.at(-1);
        if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
        else union.push({ ...span });
      }
      taskUnions.push(union);
    }
    if (entries > SESSION_ACTIVITY_MAX_ENTRIES) {
      ctx.addIssue({ code: "custom", path: ["tasks"], message: "report exceeds the compacted entry limit" });
    }
    // Różne zadania nie mogą nakładać się aktywnym czasem. Po zliczeniu unii
    // per zadanie każde nakładanie na globalnej osi musi być między zadaniami.
    const flat = taskUnions.flat().sort((a, b) => a.from - b.from);
    for (let i = 1; i < flat.length; i += 1) {
      if (flat[i]!.from < flat[i - 1]!.to) {
        ctx.addIssue({ code: "custom", path: ["tasks"], message: "active intervals of different tasks overlap" });
        break;
      }
    }
    const activeMs = report.tasks.reduce((total, task) => total + taskActiveMs(task), 0);
    if (activeMs !== report.activeMs) {
      ctx.addIssue({ code: "custom", path: ["activeMs"], message: "activeMs must equal the union of task intervals" });
    }
    if (report.activeMs > report.elapsedMs) {
      ctx.addIssue({ code: "custom", path: ["activeMs"], message: "activeMs exceeds elapsedMs" });
    }
  });
export type SessionActivityReport = z.infer<typeof SessionActivityReportSchema>;

/** Wejście końca sesji: opcjonalny raport aktywności zebrany przez FE. */
export const SessionEndInputSchema = z.object({
  activityReport: SessionActivityReportSchema.optional(),
}).strict();

// ===== Wynik oceny modelu (wykluczenia zadań) =====

/** Jedno wykluczenie: zadanie bez podstaw do zaliczenia pracy + uzasadnienie. */
export const SessionActivityExcludedTaskSchema = z.object({
  /** Zerowy porządek zadania w sesji (session_tasks.ordinal). */
  taskOrdinal: z.number().int().nonnegative(),
  reason: z.string().min(1).max(300),
}).strict();

/**
 * Ścisły wynik modelu: uzasadnienie ogólne + lista wykluczonych zadań.
 * Model NIGDY nie zwraca sekund, punktów ani procentów — dodatkowe pola
 * oznaczają błąd oceny.
 */
export const SessionActivityReviewVerdictSchema = z.object({
  reason: z.string().min(1).max(500),
  excludedTasks: z.array(SessionActivityExcludedTaskSchema),
}).strict();
export type SessionActivityReviewVerdict = z.infer<typeof SessionActivityReviewVerdictSchema>;

// ===== Wynik publiczny (dziecko) i trwały (rodzic) =====

export const SessionActivityResultStatusSchema = z.enum(["evaluated", "error", "already_started"]);

/**
 * Mały wynik widoczny dla dziecka: punkty, zatwierdzony czas albo jawny brak
 * oceny. Bez uzasadnień modelu i technicznych szczegółów.
 */
export const SessionActivityResultDtoSchema = z.object({
  status: SessionActivityResultStatusSchema,
  pointsAwarded: z.number().int().nonnegative(),
  /** Zatwierdzony czas po ocenie; nullable/optional dla starszych klientów i braku oceny. */
  approvedSeconds: z.number().int().nonnegative().nullable().optional(),
  errorCode: z.string().min(1).nullable(),
});
export type SessionActivityResultDto = z.infer<typeof SessionActivityResultDtoSchema>;

/** Trwały krótki wynik oceny sesji (learning_sessions.activity_review). */
export const SessionActivityReviewRecordSchema = z.object({
  status: z.enum(["evaluated", "error"]),
  /** Czas całkowity od pierwszego wydania zadania do końca sesji (sekundy). */
  durationSeconds: z.number().int().nonnegative(),
  /** Zmierzona aktywność FE (sekundy, obcięta do czasu całkowitego). */
  activeSeconds: z.number().int().nonnegative(),
  /** Zatwierdzony czas po wykluczeniach; null przy błędzie oceny. */
  approvedMilliseconds: z.number().int().nonnegative().nullable(),
  approvedSeconds: z.number().int().nonnegative().nullable(),
  pointsAwarded: z.number().int().nonnegative(),
  /** Krótkie uzasadnienie (model albo opis techniczny); nie przepisuje odpowiedzi. */
  reason: z.string().nullable(),
  evaluatedAt: InstantSchema,
  errorCode: z.string().min(1).nullable(),
}).strict();
export type SessionActivityReviewRecord = z.infer<typeof SessionActivityReviewRecordSchema>;

/** Naliczenie punktów: 1 pkt / 60 s; reszta przechodzi między sesjami. */
export const SESSION_ACTIVITY_POINT_INTERVAL_MS = 60_000;

export function sessionActivityAward(
  approvedMilliseconds: number,
  previousRemainderMs: number,
): { pointsAwarded: number; remainderMs: number } {
  if (!Number.isSafeInteger(approvedMilliseconds) || approvedMilliseconds < 0
    || !Number.isSafeInteger(previousRemainderMs) || previousRemainderMs < 0
    || previousRemainderMs >= SESSION_ACTIVITY_POINT_INTERVAL_MS) {
    throw new RangeError("Invalid approved activity duration");
  }
  const totalMs = previousRemainderMs + approvedMilliseconds;
  return {
    pointsAwarded: Math.floor(totalMs / SESSION_ACTIVITY_POINT_INTERVAL_MS),
    remainderMs: totalMs % SESSION_ACTIVITY_POINT_INTERVAL_MS,
  };
}
