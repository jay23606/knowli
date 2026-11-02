import { createHash } from "node:crypto";
import { z } from "zod";
import { and, asc, eq, inArray, lt, isNotNull, sql } from "drizzle-orm";
import {
  SessionActivityReportSchema,
  SessionActivityReviewRecordSchema,
  SessionActivityReviewVerdictSchema,
  TaskPromptSchema,
  messages,
  sessionActivityAward,
  taskActiveMs,
  type SessionActivityReport,
  type SessionActivityResultDto,
  type SessionActivityReviewRecord,
  type SessionActivityReviewVerdict,
  type TaskPrompt,
  type MeaningVisual,
} from "@learning/contracts";
import type { Services } from "../../config";
import type { Tx } from "../../db/client";
import {
  attempts,
  childProfiles,
  learningEvents,
  learningSessions,
  sessionTasks,
} from "../../db/schema";
import { AppError } from "../../errors";
import { assignmentText } from "../../domain/lessons/evaluate";
import type { SessionActivityReviewTask } from "../../ports/ai";
import { SessionActivityProviderError } from "../../ports/session-activity-error";

/**
 * Ocena aktywności sesji (spec client-reward-time): FE dostarcza JEDEN raport
 * na koniec sesji, serwer dołącza własne zadania i odpowiedzi z bazy, dokładnie
 * raz woła model o listę wykluczonych zadań i wyłącznie kod liczy czas oraz
 * punkty. Szczegółowy JSONB znika po 7 dniach; punkty i krótki wynik zostają.
 *
 * Model nie otrzymuje imion, identyfikatorów ani sekretów — zadania są
 * opisane zerowymi porządkami, a odpowiedzi dziecka są danymi, nie poleceniami.
 */

/** Retencja szczegółowego raportu od pierwszego przyjęcia. */
export const SESSION_ACTIVITY_RETENTION_MS = 7 * 24 * 60 * 60_000;
/**
 * Deadline finalizacji od znacznika rozpoczęcia oceny. Po terminie istniejący
 * odczyt kończy krótki wynik technicznym błędem — bez modelu i bez punktów.
 * Musi przewyższać deadline pojedynczego wywołania modelu (60 s) oraz limity
 * transportu klienta, żeby zwykłe powtórzenie nie tworzyło fałszywego błędu.
 */
export const SESSION_ACTIVITY_REVIEW_DEADLINE_MS = 120_000;
/** Rozmiar porcji czyszczenia przeterminowanych raportów. */
const CLEANUP_BATCH = 500;

export type SessionActivityErrorCode =
  | "model_not_configured"
  | "model_timeout"
  | "model_failed"
  | "invalid_verdict"
  | "review_interrupted"
  | "report_expired";

/** Zrzut zadania z bazy serwera — jedyny opis zadań widoczny dla modelu. */
interface StoredTaskSnapshot {
  taskOrdinal: number;
  taskId: string;
  exerciseType: string;
  instruction: string;
  stimulus: string | null;
  options: string[];
  acceptedAnswers: string[];
  attempts: {
    attemptId: string;
    modality: string;
    text: string | null;
    uncertain: boolean;
    supportDisclosedBefore: boolean;
    receivedAt: string;
  }[];
  processingExcluded: number;
}

export interface StoredReport {
  fe: SessionActivityReport;
  tasks: StoredTaskSnapshot[];
  verdict?: SessionActivityReviewVerdict;
  errorCode?: SessionActivityErrorCode;
}

type AcceptancePlan =
  | { kind: "stored"; review: SessionActivityReviewRecord }
  | { kind: "already_started" }
  | { kind: "expired" }
  | { kind: "fresh"; stored: StoredReport; reviewTasks: SessionActivityReviewTask[]; facts: { durationSeconds: number } };

async function lockSession(tx: Tx, sessionId: string) {
  const [identity] = await tx.select({ childId: learningSessions.childId }).from(learningSessions).where(eq(learningSessions.id, sessionId));
  if (!identity) throw new AppError("not_found");
  await tx.select({ id: childProfiles.id }).from(childProfiles).where(eq(childProfiles.id, identity.childId)).for("key share");
  const session = (await tx.select().from(learningSessions).where(eq(learningSessions.id, sessionId)).for("update"))[0];
  if (!session) throw new AppError("not_found");
  return session;
}

function reportHash(report: SessionActivityReport): string {
  return createHash("sha256").update(JSON.stringify(report)).digest("hex");
}

function reviewRecordDto(review: SessionActivityReviewRecord): SessionActivityResultDto {
  return {
    status: review.status === "error" ? "error" : "evaluated",
    pointsAwarded: review.pointsAwarded,
    approvedSeconds: review.approvedSeconds,
    errorCode: review.errorCode,
  };
}

function errorRecord(
  errorCode: SessionActivityErrorCode,
  facts: { durationSeconds: number; activeSeconds: number },
  now: Date,
): SessionActivityReviewRecord {
  return {
    status: "error",
    durationSeconds: facts.durationSeconds,
    activeSeconds: facts.activeSeconds,
    approvedMilliseconds: null,
    approvedSeconds: null,
    pointsAwarded: 0,
    reason: null,
    evaluatedAt: now.toISOString(),
    errorCode,
  };
}

/** Instrukcja/bodziec/opcje widoczne dla dziecka — jako dane, nie polecenia. */
export function describeTaskPrompt(p: TaskPrompt): { instruction: string; stimulus: string | null; options: string[] } {
  const options = (items: readonly { text: string }[] | undefined): string[] => items?.map(({ text }) => text) ?? [];
  switch (p.kind) {
    case "exposure":
      return { instruction: "Prezentacja nowego słowa", stimulus: `${p.source} → ${p.target}`, options: [] };
    case "picture_exposure":
      return { instruction: "Prezentacja nowego słowa (obrazek)", stimulus: describeVisual(p.visual), options: [] };
    case "listening":
      return { instruction: "Pytanie słuchowe: wybierz znaczenie", stimulus: null, options: options(p.options) };
    case "picture_listening":
      return { instruction: "Pytanie słuchowe z obrazkami: wybierz znaczenie", stimulus: null, options: p.options.map((option) => option.labelPl) };
    case "reading":
      return { instruction: "Wybierz znaczenie słowa", stimulus: p.text, options: options(p.options) };
    case "reverse_recognition":
      return { instruction: "Wybierz angielskie słowo", stimulus: p.prompt, options: options(p.options) };
    case "picture_recognition":
      return { instruction: "Wybierz słowo pasujące do obrazka", stimulus: `${describeVisual(p.visual)}: ${p.source}`, options: options(p.options) };
    case "recall":
      return { instruction: "Przypomnij angielskie słowo", stimulus: p.prompt, options: [] };
    case "picture_recall":
      return { instruction: "Przypomnij słowo do obrazka", stimulus: describeVisual(p.visual), options: [] };
    case "spelling":
      return { instruction: "Zapisz angielskie słowo", stimulus: p.prompt, options: [] };
    case "letter_completion":
      return { instruction: "Uzupełnij brakujące litery", stimulus: p.prompt, options: [] };
    case "speech":
      return { instruction: "Powiedz słowo na głos", stimulus: p.text, options: [] };
    case "picture_speech":
      return { instruction: "Powiedz słowo do obrazka na głos", stimulus: describeVisual(p.visual), options: [] };
    case "lesson_card": {
      const cardText = [p.card.title, p.card.body, ...p.card.examples].join("\n");
      return { instruction: "Karta lekcji (przeczytanie)", stimulus: cardText, options: [] };
    }
    case "lesson_notice": {
      const sentences = p.segments.map((sentence) => sentence.map(({ text }) => text).join(" "));
      return { instruction: p.instructionPl, stimulus: sentences.join(" | "), options: [] };
    }
    case "lesson_choice":
      return { instruction: p.instructionPl, stimulus: p.stem, options: options(p.options) };
    case "lesson_listen_choice":
      // Polecenie dziecka pochodzi z katalogu komunikatów (prompt nie ma `instructionPl`).
      return { instruction: messages.kid.lessonListenChoiceInstruction, stimulus: p.stem, options: options(p.options) };
    case "lesson_order":
      return { instruction: p.instructionPl, stimulus: null, options: options(p.items) };
    case "lesson_match":
      // Pary: lewa kolumna jako bodziec, prawa jako opcje do przypisania.
      return { instruction: p.instructionPl, stimulus: p.left.map((item) => item.text).join(" | "), options: options(p.right) };
    case "lesson_group":
      return { instruction: p.instructionPl, stimulus: p.groups.map((group) => group.text).join(" | "), options: options(p.items) };
    case "lesson_cloze": {
      // Tekst z numerami luk („[1]”) jak w odpowiedzi „1 → słowo”; bank jako opcje.
      let gap = 0;
      const stimulus = p.segments.map((segment) => ("gapId" in segment ? `[${++gap}]` : segment.text)).join("");
      return { instruction: p.instructionPl, stimulus, options: options(p.words) };
    }
    case "lesson_short_answer":
      return { instruction: "Krótka odpowiedź", stimulus: p.question, options: options(p.options) };
    case "lesson_gap":
      return { instruction: p.instructionPl, stimulus: p.stemWithGap, options: [] };
    case "lesson_error_fix":
      return { instruction: p.instructionPl, stimulus: p.statement, options: [] };
    case "lesson_transform":
      return { instruction: p.instructionPl, stimulus: p.statement, options: [] };
    case "lesson_open_answer":
    case "lesson_calculation":
      return { instruction: p.instructionPl, stimulus: p.prompt, options: [] };
    case "lesson_keywords":
      return { instruction: p.instructionPl, stimulus: p.prompt, options: options(p.options) };
    case "lesson_shorten":
      // Poprawka własnej odpowiedzi: bodźcem jest pytanie i tekst oryginału dziecka.
      return { instruction: p.instructionPl, stimulus: `${p.prompt} | ${p.originalAnswer}`, options: [] };
    default: {
      const exhaustive: never = p;
      return exhaustive;
    }
  }
}

/** Resolves canonical lesson answers from the same answer-key shapes used by materialization. */
export const LessonAnswerSnapshotSchema = z.object({
  answer: z.string().optional(), target: z.string().optional(), acceptedAnswers: z.array(z.string()).optional(),
  correctOptionId: z.string().optional(), correctOptionIds: z.array(z.string()).optional(), optionValues: z.record(z.string(), z.string()).optional(),
  segmentValues: z.record(z.string(), z.string()).optional(), itemIds: z.array(z.string()).optional(),
  itemValues: z.record(z.string(), z.string()).optional(),
  assignments: z.array(z.object({ itemId: z.string(), targetId: z.string() })).optional(),
});
type LessonAnswerSnapshot = z.infer<typeof LessonAnswerSnapshotSchema>;

export function lessonAnswerValues(key: LessonAnswerSnapshot, prompt: TaskPrompt | null): { valuesById: Map<string, string>; acceptedAnswers: string[] } {
  const valuesById = new Map<string, string>();
  if (prompt?.kind === "lesson_choice" || prompt?.kind === "lesson_listen_choice" || prompt?.kind === "lesson_short_answer" || prompt?.kind === "lesson_keywords" || prompt?.kind === "reading" || prompt?.kind === "reverse_recognition") {
    for (const option of prompt.options) valuesById.set(option.id, option.text);
  }
  if (prompt?.kind === "lesson_order") for (const item of prompt.items) valuesById.set(item.id, item.text);
  if (prompt?.kind === "lesson_match") for (const item of [...prompt.left, ...prompt.right]) valuesById.set(item.id, item.text);
  if (prompt?.kind === "lesson_group") for (const item of [...prompt.groups, ...prompt.items]) valuesById.set(item.id, item.text);
  if (prompt?.kind === "lesson_cloze") for (const word of prompt.words) valuesById.set(word.id, word.text);
  if (prompt?.kind === "lesson_notice") for (const sentence of prompt.segments) for (const segment of sentence) valuesById.set(segment.id, segment.text);
  for (const values of [key?.optionValues, key?.segmentValues, key?.itemValues]) {
    for (const [id, value] of Object.entries(values ?? {})) valuesById.set(id, value);
  }
  // Pary i grupy mają `itemIds` (kolejność lewej kolumny/elementów), ale nie są sekwencją.
  const sequence = key?.itemIds && !key.assignments
    ? key.itemIds.map((id) => valuesById.get(id)).filter((value): value is string => Boolean(value))
    : [];
  const acceptedAnswers = [
    // Pary i grupy: `answer` to tylko lewe strony / etykiety (klucz celu), nie odpowiedź.
    ...(key?.answer && !key.assignments ? [key.answer] : []),
    ...(key?.target ? [key.target] : []),
    ...(key?.acceptedAnswers ?? []),
    ...(key?.correctOptionId ? [valuesById.get(key.correctOptionId) ?? ""] : []),
    ...(sequence.length > 0 ? [sequence.join(" ")] : []),
    // Pary i grupy: pełny komplet przypisań w tym samym zapisie co odpowiedź dziecka.
    // Ten sam zapis i limit 200 znaków co odpowiedź dziecka (`answerTextOf`).
    ...(key?.assignments ? [assignmentText(key.assignments, valuesById, { itemOrder: key.itemIds ?? [] }).slice(0, 200)] : []),
    // Słowa kluczowe: wyłącznie pełny zbiór pojęć kluczowych — pojedyncze pojęcie
    // nie jest poprawną odpowiedzią (wybór niepełny nie jest oceniany).
    ...(key?.correctOptionIds && key.correctOptionIds.every((id) => valuesById.has(id))
      ? [key.correctOptionIds.map((id) => valuesById.get(id)!).join(", ")]
      : []),
  ].filter((answer) => answer.length > 0);
  return { valuesById, acceptedAnswers: [...new Set(acceptedAnswers)] };
}

/** Opis widocznej grafiki bez asset ID i bajtów mediów. */
function describeVisual(visual: MeaningVisual): string {
  switch (visual.kind) {
    case "color": return `Kolor ${visual.color}`;
    case "number": return `Liczba elementów: ${visual.count}`;
    case "image": return "Ilustracja obrazkowa";
  }
}

function answerTextOf(modality: string, answer: Record<string, unknown> | null, promptOptions: Map<string, string>, itemOrder?: readonly string[]): string | null {
  if (modality === "dont_remember") return "Nie pamiętam";
  if (modality === "skip") return "Pomiń";
  if (modality === "text" && typeof answer?.text === "string") return answer.text.slice(0, 200);
  if (modality === "choice") {
    if (typeof answer?.optionText === "string") return answer.optionText.slice(0, 200);
    if (typeof answer?.optionId === "string") return promptOptions.get(answer.optionId) ?? null;
  }
  if (modality === "sequence" && Array.isArray(answer?.itemIds)) {
    return answer.itemIds.map((id) => (typeof id === "string" ? promptOptions.get(id) ?? "" : "")).filter(Boolean).join(" ").slice(0, 200) || null;
  }
  if (modality === "selection" && Array.isArray(answer?.itemIds)) {
    // Nieznany identyfikator: brak wiarygodnej treści wyboru, zamiast częściowej odpowiedzi.
    const texts = answer.itemIds.map((id) => (typeof id === "string" ? promptOptions.get(id) ?? null : null));
    return texts.length > 0 && texts.every((text) => text !== null) ? texts.join(", ").slice(0, 200) || null : null;
  }
  if (modality === "assignment" && Array.isArray(answer?.assignments)) {
    const entries = answer.assignments.filter((entry): entry is { itemId: string; targetId: string } =>
      typeof entry === "object" && entry !== null && typeof (entry as { itemId?: unknown }).itemId === "string" && typeof (entry as { targetId?: unknown }).targetId === "string");
    return assignmentText(entries, promptOptions, { itemOrder: itemOrder ?? [] }).slice(0, 200) || null;
  }
  if (modality === "audio" && typeof answer?.transcript === "string") return answer.transcript.slice(0, 200);
  return null;
}

function uncertainAttempt(attempt: typeof attempts.$inferSelect): boolean {
  const feedback = attempt.feedback as { speech?: { recognition?: unknown } } | null;
  return feedback?.speech?.recognition === "uncertain" || feedback?.speech?.recognition === "no_speech";
}

/** Buduje zrzut zadań/prób z bazy; wyklucza technicznie niedokończone próby. */
async function buildTaskSnapshot(tx: Tx, sessionId: string, report: SessionActivityReport): Promise<StoredTaskSnapshot[]> {
  const tasks = await tx.select().from(sessionTasks).where(eq(sessionTasks.sessionId, sessionId)).orderBy(asc(sessionTasks.ordinal));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  for (const task of report.tasks) {
    if (!taskById.has(task.taskId)) {
      throw new AppError("validation", { message: "activity report references a task outside this session" });
    }
  }
  const taskIds = tasks.map((task) => task.id);
  const attemptRows = taskIds.length
    ? await tx.select().from(attempts).where(inArray(attempts.taskId, taskIds)).orderBy(asc(attempts.receivedAt), asc(attempts.attemptNumber))
    : [];
  const taskIdOfAttempt = new Map(attemptRows.map((attempt) => [attempt.id, attempt.taskId]));
  for (const task of report.tasks) {
    for (const attemptId of task.submittedAttempts) {
      // Próba musi należeć do sesji ORAZ do zadania, przy którym ją zgłoszono.
      if (!taskIdOfAttempt.has(attemptId)) {
        throw new AppError("validation", { message: "activity report references an attempt outside this session" });
      }
      if (taskIdOfAttempt.get(attemptId) !== task.taskId) {
        throw new AppError("validation", { message: "activity report lists an attempt under a different task" });
      }
    }
  }
  const disclosureRows = taskIds.length
    ? await tx.select({ taskId: learningEvents.taskId, occurredAt: learningEvents.occurredAt, kind: learningEvents.kind })
      .from(learningEvents)
      .where(and(inArray(learningEvents.taskId, taskIds), inArray(learningEvents.kind, ["hint_issued", "audio_issued"])))
    : [];
  const disclosuresByTask = new Map<string, Date[]>();
  for (const row of disclosureRows) {
    const list = disclosuresByTask.get(row.taskId) ?? [];
    list.push(row.occurredAt);
    disclosuresByTask.set(row.taskId, list);
  }
  const snapshots: StoredTaskSnapshot[] = [];
  for (const task of tasks) {
    const publicPrompt = TaskPromptSchema.safeParse(task.publicPrompt);
    const answerSnapshot = LessonAnswerSnapshotSchema.safeParse(task.answerKey);
    const described = publicPrompt.success
      ? describeTaskPrompt(publicPrompt.data)
      : { instruction: `Ćwiczenie typu ${task.exerciseType}`, stimulus: null, options: [] };
    const { valuesById: promptOptions, acceptedAnswers: accepted } = lessonAnswerValues(
      answerSnapshot.success ? answerSnapshot.data : {},
      publicPrompt.success ? publicPrompt.data : null,
    );
    const taskAttempts = attemptRows.filter((attempt) => attempt.taskId === task.id);
    const disclosures = (disclosuresByTask.get(task.id) ?? []).sort((a, b) => a.getTime() - b.getTime());
    snapshots.push({
      taskOrdinal: task.ordinal,
      taskId: task.id,
      exerciseType: task.exerciseType,
      instruction: described.instruction,
      stimulus: described.stimulus,
      options: described.options,
      acceptedAnswers: accepted,
      attempts: taskAttempts
        .filter((attempt) => attempt.state === "completed")
        .map((attempt) => ({
          attemptId: attempt.id,
          modality: attempt.modality,
          text: answerTextOf(attempt.modality, attempt.answer, promptOptions, answerSnapshot.success ? answerSnapshot.data.itemIds : undefined),
          uncertain: uncertainAttempt(attempt),
          supportDisclosedBefore: disclosures.some((occurredAt) => occurredAt.getTime() <= attempt.receivedAt.getTime()),
          receivedAt: attempt.receivedAt.toISOString(),
        })),
      processingExcluded: taskAttempts.filter((attempt) => attempt.state === "processing").length,
    });
  }
  return snapshots;
}

function sessionFacts(session: typeof learningSessions.$inferSelect, firstIssuedAt: Date | null) {
  const endedAt = session.endedAt?.getTime() ?? session.startedAt.getTime();
  const durationMs = firstIssuedAt === null ? 0 : Math.max(0, endedAt - firstIssuedAt.getTime());
  return { durationSeconds: Math.floor(durationMs / 1000) };
}

function reviewTasksOf(stored: StoredReport, feTasksByTaskId: Map<string, SessionActivityReport["tasks"][number]>): SessionActivityReviewTask[] {
  return stored.tasks
    .filter((task) => feTasksByTaskId.has(task.taskId))
    .map((task) => {
      const fe = feTasksByTaskId.get(task.taskId)!;
      return {
        taskOrdinal: task.taskOrdinal,
        instruction: task.instruction,
        stimulus: task.stimulus,
        options: task.options,
        acceptedAnswers: task.acceptedAnswers,
        submittedAnswers: task.attempts.map((attempt) => ({
          modality: attempt.modality,
          text: attempt.text,
          uncertain: attempt.uncertain,
          supportDisclosedBefore: attempt.supportDisclosedBefore,
        })),
        editCount: fe.editCount,
        editWindows: fe.editWindows.map((window) => ({ atMs: window.atMs, count: window.count })),
        playbacks: fe.playbacks.map((playback) => ({ fromMs: playback.fromMs, toMs: playback.toMs })),
        pauses: fe.pauses.map((pause) => ({ kind: pause.kind, fromMs: pause.fromMs, toMs: pause.toMs })),
        activeIntervals: fe.activeIntervals,
      };
    });
}

/**
 * Przyjmuje raport (dokładnie raz) i finalizeuje ocenę. Wywołanie modelu jest
 * poza transakcją; transakcje A i B trzymają blokadę sesji, znacznik jednokrotności
 * i wynik. Powtórka zwraca zapisany wynik/błąd bez ponownego modelu i punktów.
 */
export async function reviewSessionActivity(
  services: Services,
  sessionId: string,
  report: SessionActivityReport,
): Promise<SessionActivityResultDto> {
  const plan = await acceptSessionActivityReview(services, sessionId, report);
  return settleAcceptedSessionActivity(services, sessionId, plan);
}

/**
 * Trwale przyjmuje raport i rozpoczyna jego pojedynczą ocenę poza ścieżką
 * odpowiedzi HTTP. Wynik pozostaje dostępny przez readSessionActivityResult().
 */
export async function beginSessionActivityReview(
  services: Services,
  sessionId: string,
  report: SessionActivityReport,
): Promise<SessionActivityResultDto> {
  const plan = await acceptSessionActivityReview(services, sessionId, report);
  if (plan.kind !== "fresh") return settleAcceptedSessionActivity(services, sessionId, plan);

  // Każdy błąd providera jest zapisywany przez settleAcceptedSessionActivity.
  // Niespodziewany błąd finalizacji nie może zostać nieobsłużonym rejection;
  // trwały marker zostanie domknięty jako review_interrupted przy późniejszym odczycie.
  void settleAcceptedSessionActivity(services, sessionId, plan).catch((error: unknown) => {
    const errorCode = error instanceof AppError ? error.code : error instanceof Error ? error.name : "unexpected";
    console.error(`[session-activity] finalizacja oceny nie powiodła się: ${errorCode}`);
  });
  return { status: "already_started", pointsAwarded: 0, errorCode: null };
}

async function acceptSessionActivityReview(
  services: Services,
  sessionId: string,
  report: SessionActivityReport,
): Promise<AcceptancePlan> {
  const parsed = SessionActivityReportSchema.parse(report);
  const hash = reportHash(parsed);
  return services.db.transaction(async (tx) => {
    const session = await lockSession(tx, sessionId);
    const now = services.clock.now();
    // Fingerprint pierwszego raportu: identyczne ponowienie dostarczenia jest
    // rozpoznawalne także po retencji; odmienne wejście dostaje konflikt.
    if (session.activityReportHash !== null && session.activityReportHash !== hash) {
      throw new AppError("conflict", { message: "a different activity report was already accepted for this session" });
    }
    if (session.activityReview !== null) {
      const saved = SessionActivityReviewRecordSchema.safeParse(session.activityReview);
      if (!saved.success) throw new AppError("conflict", { message: "stored session activity review is invalid" });
      return { kind: "stored", review: saved.data } as AcceptancePlan;
    }
    if (session.activityReviewStartedAt !== null) {
      const startedAt = session.activityReviewStartedAt.getTime();
      if (now.getTime() - startedAt < SESSION_ACTIVITY_REVIEW_DEADLINE_MS) {
        return { kind: "already_started" } as AcceptancePlan;
      }
      const [firstIssued] = await tx.select({ issuedAt: sessionTasks.issuedAt }).from(sessionTasks)
        .where(eq(sessionTasks.sessionId, sessionId)).orderBy(asc(sessionTasks.issuedAt)).limit(1);
      const facts = sessionFacts(session, firstIssued?.issuedAt ?? null);
      const savedReport = (session.activityReport as { fe?: { activeMs?: unknown } } | null)?.fe;
      const activeSeconds = typeof savedReport?.activeMs === "number"
        ? Math.min(Math.floor(savedReport.activeMs / 1000), facts.durationSeconds)
        : 0;
      const record = errorRecord("review_interrupted", { durationSeconds: facts.durationSeconds, activeSeconds }, now);
      await tx.update(learningSessions).set({ activityReview: record }).where(eq(learningSessions.id, sessionId));
      return { kind: "stored", review: record } as AcceptancePlan;
    }
    if (session.activityReportExpiresAt !== null && session.activityReportExpiresAt.getTime() <= now.getTime()) {
      // Legacy sesja sprzed wdrożenia albo raport po retencji — bez oceny i punktów.
      return { kind: "expired" } as AcceptancePlan;
    }

    const stored: StoredReport = { fe: parsed, tasks: await buildTaskSnapshot(tx, sessionId, parsed) };
    const [firstIssued] = await tx.select({ issuedAt: sessionTasks.issuedAt }).from(sessionTasks)
      .where(eq(sessionTasks.sessionId, sessionId)).orderBy(asc(sessionTasks.issuedAt)).limit(1);
    const facts = sessionFacts(session, firstIssued?.issuedAt ?? null);
    const expiresAt = new Date(now.getTime() + SESSION_ACTIVITY_RETENTION_MS);
    await tx.update(learningSessions).set({
      activityReportHash: hash,
      activityReviewStartedAt: now,
      activityReportExpiresAt: expiresAt,
      ...(parsed.tasks.length > 0 ? { activityReport: stored as unknown as Record<string, unknown> } : {}),
    }).where(eq(learningSessions.id, sessionId));

    if (parsed.tasks.length === 0) {
      // Pusta sesja/anulowana kartkówka przed pierwszym zadaniem: normalny wynik
      // 0 sekund i 0 punktów, bez wywołania modelu.
      const record: SessionActivityReviewRecord = {
        status: "evaluated",
        durationSeconds: facts.durationSeconds,
        activeSeconds: 0,
        approvedMilliseconds: 0,
        approvedSeconds: 0,
        pointsAwarded: 0,
        reason: "Sesja bez zadań.",
        evaluatedAt: now.toISOString(),
        errorCode: null,
      };
      await tx.update(learningSessions).set({ activityReview: record }).where(eq(learningSessions.id, sessionId));
      return { kind: "stored", review: record } as AcceptancePlan;
    }
    return {
      kind: "fresh",
      stored,
      reviewTasks: reviewTasksOf(stored, new Map(parsed.tasks.map((task) => [task.taskId, task]))),
      facts,
    } as AcceptancePlan;
  });
}

async function settleAcceptedSessionActivity(
  services: Services,
  sessionId: string,
  plan: AcceptancePlan,
): Promise<SessionActivityResultDto> {
  if (plan.kind === "stored") return reviewRecordDto(plan.review);
  if (plan.kind === "already_started") {
    return { status: "already_started", pointsAwarded: 0, errorCode: null };
  }
  if (plan.kind === "expired") {
    return { status: "error", pointsAwarded: 0, errorCode: "report_expired" };
  }

  const finalize = (record: SessionActivityReviewRecord, verdict?: SessionActivityReviewVerdict, errorCode?: SessionActivityErrorCode) =>
    finalizeSessionActivity(services, sessionId, record, verdict, errorCode);

  const facts = { durationSeconds: plan.facts.durationSeconds, activeSeconds: Math.min(Math.floor(plan.stored.fe.activeMs / 1000), plan.facts.durationSeconds) };
  const startedAt = performance.now();
  const fail = async (errorCode: SessionActivityErrorCode, diagnostics: {
    failureKind: string; httpStatus?: number; validationCodes?: string[];
  }) => {
    // Wyłącznie metadane z jawnej listy; bez Error.message, body i szczegółów Zod.
    console.error("[session-activity] ocena nie powiodła się", {
      sessionId, errorCode, taskCount: plan.reviewTasks.length,
      elapsedMs: Math.round(performance.now() - startedAt),
      timeoutMs: services.sessionActivity?.timeoutMs ?? null,
      ...diagnostics,
    });
    return reviewRecordDto(await finalize(errorRecord(errorCode, facts, services.clock.now()), undefined, errorCode));
  };
  if (!services.sessionActivity) {
    return fail("model_not_configured", { failureKind: "not_configured" });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), services.sessionActivity.timeoutMs);
  let raw: unknown;
  try {
    raw = await services.sessionActivity.provider.review({ tasks: plan.reviewTasks }, controller.signal);
  } catch (error) {
    clearTimeout(timer);
    const code: SessionActivityErrorCode = (error as { name?: unknown })?.name === "AbortError" ? "model_timeout" : "model_failed";
    return fail(code, error instanceof SessionActivityProviderError
      ? { failureKind: error.failureKind, ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}) }
      : { failureKind: code === "model_timeout" ? "timeout" : "provider_error" });
  }
  clearTimeout(timer);
  const verdict = SessionActivityReviewVerdictSchema.safeParse(raw);
  if (!verdict.success) {
    return fail("invalid_verdict", { failureKind: "schema_validation", validationCodes: [...new Set(verdict.error.issues.map((issue) => issue.code))] });
  }
  const ordinals = new Set(plan.reviewTasks.map((task) => task.taskOrdinal));
  const excluded = new Set<number>();
  for (const exclusion of verdict.data.excludedTasks) {
    if (!ordinals.has(exclusion.taskOrdinal) || excluded.has(exclusion.taskOrdinal)) {
      return fail("invalid_verdict", { failureKind: ordinals.has(exclusion.taskOrdinal) ? "duplicate_task_ordinal" : "unknown_task_ordinal" });
    }
    excluded.add(exclusion.taskOrdinal);
  }
  // Wyłącznie kod liczy czas: suma unii przedziałów zadań niewykluczonych.
  const ordinalByTaskId = new Map(plan.stored.tasks.map((task) => [task.taskId, task.taskOrdinal]));
  const approvedMilliseconds = plan.stored.fe.tasks
    .filter((task) => !excluded.has(ordinalByTaskId.get(task.taskId) ?? -1))
    .reduce((total, task) => total + taskActiveMs(task), 0);
  const evaluatedAt = services.clock.now().toISOString();
  const record: SessionActivityReviewRecord = {
    status: "evaluated",
    durationSeconds: facts.durationSeconds,
    activeSeconds: facts.activeSeconds,
    approvedMilliseconds,
    approvedSeconds: Math.floor(approvedMilliseconds / 1000),
    pointsAwarded: 0,
    reason: verdict.data.reason,
    evaluatedAt,
    errorCode: null,
  };
  return reviewRecordDto(await finalize(record, verdict.data));
}

/**
 * Transakcja B: zapis wyniku i naliczenie punktów atomowo albo nic.
 * Kolejność blokad: profil (FOR UPDATE) PRZED sesją — transakcje przyjęcia
 * raportu biorą profil tylko FOR KEY SHARE, więc ta kolejność nie tworzy cyklu.
 */
async function finalizeSessionActivity(
  services: Services,
  sessionId: string,
  record: SessionActivityReviewRecord,
  verdict?: SessionActivityReviewVerdict,
  errorCode?: SessionActivityErrorCode,
): Promise<SessionActivityReviewRecord> {
  try {
    return await services.db.transaction(async (tx) => {
      const [identity] = await tx.select({ childId: learningSessions.childId }).from(learningSessions).where(eq(learningSessions.id, sessionId));
      if (!identity) throw new AppError("not_found");
      const profileLock = record.status === "evaluated"
        ? await tx.select({ rewardPoints: childProfiles.rewardPoints, remainder: childProfiles.rewardRemainderMs })
            .from(childProfiles).where(eq(childProfiles.id, identity.childId)).for("update")
        : [];
      const session = (await tx.select().from(learningSessions).where(eq(learningSessions.id, sessionId)).for("update"))[0];
      if (!session) throw new AppError("not_found");
      if (session.activityReview !== null) {
        // Spóźniona odpowiedź modelu nie nadpisuje zapisanego wyniku/błędu.
        const saved = SessionActivityReviewRecordSchema.safeParse(session.activityReview);
        if (!saved.success) throw new AppError("conflict", { message: "stored session activity review is invalid" });
        return saved.data;
      }
      const now = services.clock.now();
      if (session.activityReviewStartedAt !== null
        && now.getTime() - session.activityReviewStartedAt.getTime() >= SESSION_ACTIVITY_REVIEW_DEADLINE_MS) {
        const expired = errorRecord("review_interrupted", { durationSeconds: record.durationSeconds, activeSeconds: record.activeSeconds }, now);
        await tx.update(learningSessions).set({ activityReview: expired }).where(eq(learningSessions.id, sessionId));
        return expired;
      }
      let finalRecord = record;
      if (record.status === "evaluated") {
        const [profile] = profileLock;
        if (!profile) throw new AppError("not_found");
        const approved = record.approvedMilliseconds ?? 0;
        // Arytmetyka punktów wyłącznie z kontraktu (1 pkt / pełna minuta,
        // reszta przenoszona między sesjami) — bez zdublowanej logiki inline.
        const award = sessionActivityAward(approved, profile.remainder);
        const savedActivity = session.activityReport as StoredReport | null;
        const reviewedOrdinals = new Set(savedActivity?.tasks
          .filter((task) => savedActivity.fe.tasks.some((feTask) => feTask.taskId === task.taskId))
          .map((task) => task.taskOrdinal) ?? []);
        const taskCount = reviewedOrdinals.size;
        const excludedCount = verdict?.excludedTasks.length ?? 0;
        finalRecord = {
          ...record,
          pointsAwarded: award.pointsAwarded,
          reason: excludedCount === 0
            ? `Ocena aktywności: zaliczono pracę w ${taskCount} zadaniach.`
            : `Ocena aktywności: zaliczono pracę w ${taskCount - excludedCount} z ${taskCount} zadań; ${excludedCount} wykluczono.`,
        };
        await tx.update(childProfiles).set({
          rewardPoints: profile.rewardPoints + award.pointsAwarded,
          rewardRemainderMs: award.remainderMs,
        }).where(eq(childProfiles.id, session.childId));
      }
      await tx.update(learningSessions).set({
        activityReview: finalRecord,
        ...(session.activityReport !== null && (verdict !== undefined || errorCode !== undefined)
          ? {
              activityReport: {
                ...(session.activityReport as Record<string, unknown>),
                ...(verdict !== undefined ? { verdict } : {}),
                ...(errorCode !== undefined ? { errorCode } : {}),
              },
            }
          : {}),
      }).where(eq(learningSessions.id, sessionId));
      return finalRecord;
    });
  } catch (error) {
    if (error instanceof AppError && error.code === "not_found") {
      // Profil usunięty w trakcie oceny: brak finalizacji i nagrody.
      return errorRecord("review_interrupted", { durationSeconds: record.durationSeconds, activeSeconds: record.activeSeconds }, services.clock.now());
    }
    throw error;
  }
}

/** Wynik zapisany w sesji (do podpięcia do podsumowania bez ponownej oceny). */
export async function readSessionActivityResult(services: Services, sessionId: string): Promise<SessionActivityResultDto | null> {
  await resolveInterruptedSessionActivity(services, sessionId);
  const [row] = await services.db.select({ review: learningSessions.activityReview }).from(learningSessions).where(eq(learningSessions.id, sessionId));
  if (!row?.review) return null;
  const saved = SessionActivityReviewRecordSchema.safeParse(row.review);
  if (!saved.success) return null;
  return reviewRecordDto(saved.data);
}

/** Read/end paths can settle a review abandoned after its single-call deadline. */
export async function resolveInterruptedSessionActivity(services: Services, sessionId: string): Promise<void> {
  await services.db.transaction(async (tx) => {
    const session = await lockSession(tx, sessionId);
    if (session.activityReview !== null || session.activityReviewStartedAt === null
      || services.clock.now().getTime() - session.activityReviewStartedAt.getTime() < SESSION_ACTIVITY_REVIEW_DEADLINE_MS) return;
    const [firstIssued] = await tx.select({ issuedAt: sessionTasks.issuedAt }).from(sessionTasks)
      .where(eq(sessionTasks.sessionId, sessionId)).orderBy(asc(sessionTasks.issuedAt)).limit(1);
    const facts = sessionFacts(session, firstIssued?.issuedAt ?? null);
    const stored = session.activityReport as { fe?: { activeMs?: unknown } } | null;
    const activeSeconds = typeof stored?.fe?.activeMs === "number"
      ? Math.min(Math.floor(stored.fe.activeMs / 1000), facts.durationSeconds) : 0;
    const review = errorRecord("review_interrupted", { durationSeconds: facts.durationSeconds, activeSeconds }, services.clock.now());
    await tx.update(learningSessions).set({ activityReview: review }).where(eq(learningSessions.id, sessionId));
  });
}

/** Czy szczegóły raportu są jeszcze w okresie retencji (widok rodzica). */
export function activityDetailsAvailable(session: { activityReportExpiresAt: Date | null }, now: Date): boolean {
  return session.activityReportExpiresAt !== null && session.activityReportExpiresAt.getTime() > now.getTime();
}

/**
 * Worker: czyści wygasły JSONB raportu w ograniczonych partiach. Zostaje krótki
 * wynik, punkty, fingerprint i znacznik jednokrotności. Nie ocenia i nie woła
 * modelu. Zwraca liczbę oczyszczonych wierszy.
 */
export async function cleanupExpiredActivityReports(services: Services, batchSize = CLEANUP_BATCH): Promise<number> {
  const now = services.clock.now();
  let cleaned = 0;
  for (;;) {
    const rows = await services.db.select({ id: learningSessions.id }).from(learningSessions)
      .where(and(isNotNull(learningSessions.activityReportExpiresAt), lt(learningSessions.activityReportExpiresAt, now), sql`${learningSessions.activityReport} is not null`))
      .limit(batchSize);
    if (rows.length === 0) return cleaned;
    for (const row of rows) {
      await services.db.update(learningSessions)
        .set({ activityReport: null })
        .where(and(eq(learningSessions.id, row.id), isNotNull(learningSessions.activityReportExpiresAt), lt(learningSessions.activityReportExpiresAt, now)));
    }
    cleaned += rows.length;
    if (rows.length < batchSize) return cleaned;
  }
}
