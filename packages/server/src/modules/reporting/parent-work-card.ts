import { and, asc, eq, gte, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { ParentWorkCardDtoSchema, ParentWorkCardQuerySchema, SessionActivityReviewRecordSchema, taskActiveMs, type ParentSessionActivityDto, type ParentWorkCardDto } from "@learning/contracts";
import type { Services } from "../../config";
import { localDay } from "../../domain/local-date";
import { validRewardTimezone } from "../../domain/reward-activity";
import { assignmentText } from "../../domain/lessons/evaluate";
import { isNonAssessedLessonTaskType } from "../../domain/lessons/session-task-types";
import { AppError } from "../../errors";
import { attempts, assessments, childProfiles, deckVersions, familySettings, learningSessions, sessionTasks } from "../../db/schema";
import { activityDetailsAvailable, resolveInterruptedSessionActivity, SESSION_ACTIVITY_REVIEW_DEADLINE_MS, type StoredReport } from "../learning";

type ResponseOutcome = ParentWorkCardDto["sessions"][number]["steps"][number]["responses"][number]["outcome"];

/** Zapisana ocena jednej umiejętności odpowiedzi (wiersz `assessments`). */
export interface StoredAssessment {
  skill: string;
  outcome: string;
  details: Record<string, unknown>;
}

/** Werdykty lekcji, po których dziecko usłyszało „prawie” — niezależnie od zapisanego wyniku celu. */
const ALMOST_VERDICTS = new Set(["model_almost", "minor_typo"]);

/**
 * Wynik jednej oceny dla rodzica: „Częściowo” tam, gdzie dziecko usłyszało „prawie”.
 * Zapisany wynik bywa wtedy różny: `incorrect` dla wymowy w paśmie „ćwicz”
 * i odpowiedzi szkolnej „prawie”, `correct` dla gramatyki „prawie” (błąd poza
 * sprawdzaną regułą) i literówki — w obu kierunkach to nie jest ani „Błędnie”,
 * ani „Poprawnie”. Ocena celu i postęp się nie zmieniają.
 */
function assessmentOutcome(row: StoredAssessment): ResponseOutcome {
  if (row.outcome !== "correct" && row.outcome !== "incorrect") return null;
  const pronunciation = row.details.pronunciation as { band?: unknown } | undefined;
  if (row.skill === "pronunciation" && pronunciation?.band === "partial") return "partial";
  if (typeof row.details.verdict === "string" && ALMOST_VERDICTS.has(row.details.verdict)) return "partial";
  return row.outcome;
}

/**
 * Wynik odpowiedzi z jej ocen (po jednej na umiejętność). Oceny `unassessed` nie
 * rozstrzygają poprawności; pominięcie i „Nie pamiętam” nie są odpowiedzią z treścią.
 */
export function responseOutcome(modality: string, rows: readonly StoredAssessment[] | undefined): ResponseOutcome {
  if (modality === "skip" || modality === "dont_remember" || !rows) return null;
  const outcomes = new Set(rows.map(assessmentOutcome).filter((outcome) => outcome !== null));
  if (outcomes.size === 0) return null;
  return outcomes.size === 1 ? [...outcomes][0]! : "partial";
}

/** Read-only, child-scoped work report. The HTTP parent router authenticates before calling this. */
export async function readParentWorkCard(services: Services, input: unknown): Promise<ParentWorkCardDto> {
  const parsed = ParentWorkCardQuerySchema.parse(input);
  const [family] = await services.db.select({ timezone: familySettings.timezone }).from(familySettings).limit(1);
  const query = { ...parsed, date: parsed.date ?? localDay(services.clock.now(), validRewardTimezone(family?.timezone)) };
  const child = await services.db.select({ id: childProfiles.id }).from(childProfiles).where(eq(childProfiles.id, query.childId)).limit(1);
  if (!child.length) throw new AppError("not_found");

  const reviewCutoff = new Date(services.clock.now().getTime() - SESSION_ACTIVITY_REVIEW_DEADLINE_MS);
  const reviewCandidates = await services.db.select({ id: learningSessions.id }).from(learningSessions).where(and(
    eq(learningSessions.childId, query.childId),
    isNull(learningSessions.activityReview),
    lt(learningSessions.activityReviewStartedAt, reviewCutoff),
  ));
  for (const session of reviewCandidates) await resolveInterruptedSessionActivity(services, session.id);

  // Okno UTC z buforem pokrywa żądany dzień lokalny w każdej strefie z kontekstu sesji;
  // dokładny dzień nadal rozstrzygają poniższe filtry localDay w JS.
  const dayUtcMs = new Date(`${query.date}T00:00:00.000Z`).getTime();
  const windowStart = new Date(dayUtcMs - 172_800_000);
  const windowEnd = new Date(dayUtcMs + 259_200_000);
  const sessions = await services.db.select({
    id: learningSessions.id, mode: learningSessions.mode, state: learningSessions.state,
    startedAt: learningSessions.startedAt, endedAt: learningSessions.endedAt,
    context: learningSessions.context, taskBudget: learningSessions.taskBudget,
    activityReview: learningSessions.activityReview, activityReport: learningSessions.activityReport,
    activityReportExpiresAt: learningSessions.activityReportExpiresAt,
    deckTitle: deckVersions.title, deckVersionNumber: deckVersions.versionNumber,
  }).from(learningSessions).innerJoin(deckVersions, eq(deckVersions.id, learningSessions.deckVersionId))
    .where(and(eq(learningSessions.childId, query.childId), lte(learningSessions.startedAt, windowEnd), or(isNull(learningSessions.endedAt), gte(learningSessions.endedAt, windowStart)))).orderBy(asc(learningSessions.startedAt));

  const timezoneOf = (context: unknown): string => validRewardTimezone((context as Record<string, unknown> | null)?.timezone);

  // Nagroda należy do lokalnej daty KOŃCA sesji (design §9) — nie rozbijamy
  // zatwierdzonego czasu na dni i nie odtwarzamy starych podziałów.
  const endedThatDay = sessions.filter((session) => session.endedAt !== null
    && localDay(session.endedAt, timezoneOf(session.context)) === query.date);

  const daySessionIds = new Set<string>(endedThatDay.map((session) => session.id));
  const allAttempts = await services.db.select({ attempt: attempts, sessionId: sessionTasks.sessionId, taskId: sessionTasks.id,
    issuedAt: sessionTasks.issuedAt, context: learningSessions.context })
    .from(attempts).innerJoin(sessionTasks, eq(sessionTasks.id, attempts.taskId))
    .innerJoin(learningSessions, eq(learningSessions.id, sessionTasks.sessionId))
    .where(and(eq(attempts.childId, query.childId), gte(attempts.receivedAt, windowStart), lt(attempts.receivedAt, windowEnd)));
  const attemptsByTask = new Map<string, typeof allAttempts>();
  for (const row of allAttempts) {
    const timezone = timezoneOf(row.context);
    if (localDay(row.attempt.receivedAt, timezone) !== query.date) continue;
    const list = attemptsByTask.get(row.taskId) ?? [];
    list.push(row);
    attemptsByTask.set(row.taskId, list);
    daySessionIds.add(row.sessionId);
  }
  const issuedTasks = await services.db.select({ sessionId: sessionTasks.sessionId, issuedAt: sessionTasks.issuedAt })
    .from(sessionTasks).where(and(eq(sessionTasks.childId, query.childId), gte(sessionTasks.issuedAt, windowStart), lt(sessionTasks.issuedAt, windowEnd)));
  const sessionById = new Map(sessions.map(session => [session.id, session]));
  for (const task of issuedTasks) {
    const session = sessionById.get(task.sessionId);
    if (!session) continue;
    if (localDay(task.issuedAt, timezoneOf(session.context)) === query.date) daySessionIds.add(task.sessionId);
  }
  // Sesja spoza okna mogłaby wejść tu tylko przez anomalną próbę po endedAt; pomiń ją zamiast błędu.
  const sessionIds = [...daySessionIds].filter((sessionId) => sessionById.has(sessionId));
  const tasks = sessionIds.length ? await services.db.select().from(sessionTasks).where(and(
    eq(sessionTasks.childId, query.childId), inArray(sessionTasks.sessionId, sessionIds),
  )).orderBy(asc(sessionTasks.ordinal)) : [];
  const taskIds = tasks.map(task => task.id);
  const assessmentRows = taskIds.length ? await services.db.select({
    attemptId: assessments.attemptId, skill: assessments.skill, outcome: assessments.outcome, details: assessments.details,
  })
    .from(assessments).innerJoin(attempts, eq(attempts.id, assessments.attemptId))
    .where(and(eq(assessments.childId, query.childId), inArray(attempts.taskId, taskIds))) : [];
  const storedByAttempt = new Map<string, StoredAssessment[]>();
  const assessmentByAttempt = new Map<string, Set<string>>();
  for (const row of assessmentRows) {
    storedByAttempt.set(row.attemptId, [...(storedByAttempt.get(row.attemptId) ?? []), row]);
    const values = assessmentByAttempt.get(row.attemptId) ?? new Set<string>();
    values.add(row.outcome);
    assessmentByAttempt.set(row.attemptId, values);
  }

  const now = services.clock.now();
  const reviewOf = (session: typeof sessions[number]): ParentSessionActivityDto => {
    const saved = session.activityReview === null ? null : SessionActivityReviewRecordSchema.safeParse(session.activityReview);
    if (!saved || !saved.success) {
      return {
        status: "not_delivered",
        durationSeconds: 0,
        activeSeconds: 0,
        approvedSeconds: 0,
        pointsAwarded: 0,
        reason: null,
        errorCode: null,
        excludedTasks: null,
        details: null,
      };
    }
    const review = saved.data;
    const retained = activityDetailsAvailable(session, now)
      ? session.activityReport as StoredReport | null
      : null;
    const details = retained ? {
      modelReason: retained.verdict?.reason ?? review.reason ?? "",
      tasks: (retained.tasks ?? []).map((task) => {
        const measured = retained.fe?.tasks?.find((entry) => entry.taskId === task.taskId);
        const excluded = retained.verdict?.excludedTasks?.find((entry) => entry.taskOrdinal === task.taskOrdinal);
        return {
          taskOrdinal: task.taskOrdinal,
          instruction: task.instruction,
          stimulus: task.stimulus,
          options: task.options,
          acceptedAnswers: task.acceptedAnswers,
          submittedAnswers: task.attempts.map((attempt) => attempt.text).filter((answer): answer is string => answer !== null),
          activeMilliseconds: measured ? taskActiveMs(measured) : 0,
          editCount: measured?.editCount ?? 0,
          playbackCount: measured?.playbacks.length ?? 0,
          modelNote: excluded?.reason ?? null,
        };
      }),
    } : null;
    const excludedTasks = retained?.verdict?.excludedTasks ?? null;
    return {
      status: review.status,
      durationSeconds: review.durationSeconds,
      activeSeconds: review.activeSeconds,
      approvedSeconds: review.approvedSeconds ?? 0,
      pointsAwarded: review.pointsAwarded,
      reason: review.reason,
      errorCode: review.errorCode,
      excludedTasks,
      details,
    };
  };

  const reportSessions = sessionIds.map(sessionId => {
    const session = sessionById.get(sessionId)!;
    const zone = timezoneOf(session.context);
    const sessionTasksForDay = tasks.filter(task => task.sessionId === sessionId
      && (localDay(task.issuedAt, zone) === query.date || (attemptsByTask.get(task.id) ?? []).length > 0));
    const steps = sessionTasksForDay.map(task => {
      const relevant = (attemptsByTask.get(task.id) ?? []).sort((a, b) => a.attempt.receivedAt.getTime() - b.attempt.receivedAt.getTime());
      const responses = relevant.map(({ attempt }) => {
        const rawAnswer = attempt.answer as Record<string, unknown> | null;
        const textAnswer = attempt.modality === "text" && typeof rawAnswer?.text === "string" ? rawAnswer.text.trim().slice(0, 160) : null;
        const optionAnswer = attempt.modality === "choice" && typeof rawAnswer?.optionText === "string" ? rawAnswer.optionText.trim().slice(0, 160) : null;
        const itemValues = (task.answerKey as { itemValues?: Record<string, unknown> } | null)?.itemValues;
        const sequenceAnswer = attempt.modality === "sequence" && Array.isArray(rawAnswer?.itemIds)
          ? rawAnswer.itemIds.map(id => typeof id === "string" && typeof itemValues?.[id] === "string" ? itemValues[id] as string : "").filter(Boolean).join(" ").trim().slice(0, 160) || null
          : null;
        const optionValues = (task.answerKey as { optionValues?: Record<string, unknown> } | null)?.optionValues;
        // Wybór z nieznanym identyfikatorem jest nieoceniony: nie pokazujemy go jako częściowej odpowiedzi.
        const selectionTexts = attempt.modality === "selection" && Array.isArray(rawAnswer?.itemIds)
          ? rawAnswer.itemIds.map(id => typeof id === "string" && typeof optionValues?.[id] === "string" ? optionValues[id] as string : null)
          : null;
        const selectionAnswer = selectionTexts && selectionTexts.length > 0 && selectionTexts.every((text): text is string => text !== null)
          ? selectionTexts.join(", ").trim().slice(0, 160) || null
          : null;
        const assignmentKey = task.answerKey as { itemIds?: unknown; targetIds?: unknown } | null;
        const assignmentAnswer = attempt.modality === "assignment" && Array.isArray(rawAnswer?.assignments) && itemValues
          ? assignmentText(
            rawAnswer.assignments.filter((entry): entry is { itemId: string; targetId: string } =>
              typeof entry === "object" && entry !== null && typeof (entry as { itemId?: unknown }).itemId === "string" && typeof (entry as { targetId?: unknown }).targetId === "string"),
            Object.fromEntries(Object.entries(itemValues).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
            {
              grouped: task.exerciseType === "lesson_group",
              ...(Array.isArray(assignmentKey?.targetIds) ? { targetOrder: assignmentKey.targetIds.filter((id): id is string => typeof id === "string") } : {}),
              ...(Array.isArray(assignmentKey?.itemIds) ? { itemOrder: assignmentKey.itemIds.filter((id): id is string => typeof id === "string") } : {}),
            },
          ).trim().slice(0, 160) || null
          : null;
        const feedbackKind = typeof attempt.feedback?.kind === "string" ? attempt.feedback.kind : null;
        const assessment = attempt.modality === "skip" || attempt.modality === "dont_remember" ? "none"
            : assessmentByAttempt.get(attempt.id)?.has("unassessed") && [...assessmentByAttempt.get(attempt.id)!].some(outcome => outcome !== "unassessed") ? "mixed"
              : assessmentByAttempt.get(attempt.id)?.has("unassessed") ? "unassessed"
                : assessmentByAttempt.has(attempt.id) ? "assessed" : "none";
        return {
          modality: attempt.modality as "choice" | "text" | "audio" | "dont_remember" | "skip" | "sequence" | "selection" | "assignment",
          answerExample: attempt.modality === "dont_remember" ? "Nie pamiętam" : textAnswer ?? optionAnswer ?? sequenceAnswer ?? selectionAnswer ?? assignmentAnswer,
          feedbackKind, assessment,
          outcome: responseOutcome(attempt.modality, storedByAttempt.get(attempt.id)),
          responseSeconds: Math.max(0, Math.ceil((attempt.receivedAt.getTime() - task.issuedAt.getTime()) / 1000)),
        };
      });
      return {
        taskId: task.id, ordinal: task.ordinal, exerciseType: task.exerciseType, state: task.state as "issued" | "answered" | "completed" | "skipped",
        issuedAt: task.issuedAt.toISOString(), responses,
      };
    });
    return {
      sessionId, mode: session.mode as "training" | "mock_test" | "daily_round", state: session.state as "active" | "completed" | "ended",
      startedAt: session.startedAt.toISOString(), endedAt: session.endedAt?.toISOString() ?? null,
      deckTitle: session.deckTitle, deckVersionNumber: session.deckVersionNumber,
      // Zadania następcze lekcji („Skróć odpowiedź”), karty i zadania historyjki są poza budżetem sesji.
      remainingSteps: Math.max(0, session.taskBudget - tasks.filter(task => task.sessionId === sessionId &&
        (task.context as { followUpOf?: unknown } | null)?.followUpOf === undefined &&
        (session.mode === "daily_round" || (task.exerciseType !== "exposure" && !isNonAssessedLessonTaskType(task.exerciseType)))).length),
      activity: reviewOf(session),
      steps,
    };
  });
  // Suma zatwierdzonego czasu: tylko ocenione sesje zakończone tego dnia.
  const creditedSeconds = endedThatDay.reduce((total, session) => {
    const saved = session.activityReview === null ? null : SessionActivityReviewRecordSchema.safeParse(session.activityReview);
    return saved?.success && saved.data.status === "evaluated" ? total + (saved.data.approvedSeconds ?? 0) : total;
  }, 0);
  const unevaluatedSessions = endedThatDay.filter((session) => {
    const saved = session.activityReview === null ? null : SessionActivityReviewRecordSchema.safeParse(session.activityReview);
    return !saved?.success || saved.data.status !== "evaluated";
  }).length;
  return ParentWorkCardDtoSchema.parse({
    childId: query.childId, date: query.date, creditedSeconds, unevaluatedSessions,
    reviewService: services.sessionActivity?.publicService ?? null,
    sessions: reportSessions,
  });
}
