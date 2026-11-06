import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import {
  LearningOverviewDtoSchema,
  LearningOverviewQuerySchema,
  MockTestReportDtoSchema,
  type LearningOverviewDto,
  type LearningOverviewQuery,
  type ReportSkill,
} from "@learning/contracts";
import type { Services } from "../../config";
import type { Executor } from "../../db/client";
import { AppError } from "../../errors";
import {
  assignments,
  childProfiles,
  decks,
  familySettings,
  itemRevisionSkills,
  itemRevisions,
  learningSessions,
} from "../../db/schema";
import { estimateLearningTime } from "../../domain/learning-time";
import { selectPracticeItems, type PracticeHistoryRecord } from "../../domain/practice-items";
import { addDays, localDay } from "../../domain/local-date";
import { buildReportPeriod } from "../../domain/report-period";
import { CURRENT_POLICY_ID, loadPolicy } from "../../policies/registry";
import { readSkillHistories, skillHistoryKey, type HistoryScope } from "../learning";
import { readPublishedProgress } from "./published-progress";
import { requireLearningReadToken, type IntegrationPrincipal } from "../family";

const ACTIVITY_EVENT_KINDS = ["prompt_issued", "audio_issued", "hint_issued", "presentation_completed"] as const;
const DEFAULT_TIMEZONE = "Europe/Warsaw";
const MAX_STATEMENT_MS = 8_000;

type ChildRow = { id: string; displayName: string; policyId: string | null };
type AssignmentRow = { id: string; childId: string; deckId: string; testDate: string | null; testGoals: string[] | null };
type ActivityRow = {
  childId: string; sessionId: string; deckId: string; deckVersionId: string; deckTitle: string;
  deckVersionNumber: number; at: Date | string; attemptId?: string; state?: string; modality?: string;
};
type AssessmentRow = ActivityRow & {
  skill: string; outcome: "correct" | "incorrect" | "unassessed"; independent: boolean;
};
type ActivityDeck = {
  deckId: string; deckVersionId: string; deckTitle: string; deckVersionNumber: number;
  assessmentCounts: Map<string, { independentCorrect: number; correctNotIndependent: number; incorrect: number; unassessed: number }>;
};
type ActivityDay = {
  date: string; isPartialDay: boolean; hasRecordedActivity: boolean; sessions: Set<string>;
  submittedAttempts: number; pendingAttempts: number; decks: Map<string, ActivityDeck>; mockTests: LearningOverviewDto["children"][number]["dailyActivity"][number]["mockTests"];
};
type PublishedAssignment = { childId: string; deckId: string; deckVersionId: string; deckTitle: string; deckVersionNumber: number; totalItems: number; skills: LearningOverviewDto["children"][number]["currentProgress"][number]["skills"]; practiceItems: LearningOverviewDto["children"][number]["currentProgress"][number]["practiceItems"]; practiceItemsTruncated: boolean };

function instant(value: Date | string): string {
  return new Date(value).toISOString();
}

function activityKey(childId: string, date: string): string {
  return `${childId}:${date}`;
}

export function ensureActivityDeck(day: ActivityDay, row: ActivityRow): ActivityDeck {
  const key = `${row.deckId}:${row.deckVersionId}`;
  const existing = day.decks.get(key);
  if (existing) return existing;
  const created: ActivityDeck = {
    deckId: row.deckId,
    deckVersionId: row.deckVersionId,
    deckTitle: row.deckTitle,
    deckVersionNumber: row.deckVersionNumber,
    assessmentCounts: new Map(),
  };
  day.decks.set(key, created);
  return created;
}

async function currentPracticeItems(
  exec: Executor,
  child: ChildRow,
  published: Awaited<ReturnType<typeof readPublishedProgress>>,
  period: ReturnType<typeof buildReportPeriod>,
  generatedAt: string,
  timezone: string,
): Promise<{ items: PublishedAssignment["practiceItems"]; truncated: boolean }> {
  const revisions = await exec.select({ id: itemRevisions.id, itemId: itemRevisions.itemId, payload: itemRevisions.payload })
    .from(itemRevisions).where(eq(itemRevisions.deckVersionId, published.deckVersionId));
  const revisionIds = revisions.map(({ id }) => id);
  const links = revisionIds.length
    ? await exec.select({ itemRevisionId: itemRevisionSkills.itemRevisionId, itemId: itemRevisions.itemId, skill: itemRevisionSkills.skill, skillVersionId: itemRevisionSkills.skillVersionId })
      .from(itemRevisionSkills).innerJoin(itemRevisions, eq(itemRevisions.id, itemRevisionSkills.itemRevisionId))
      .where(inArray(itemRevisionSkills.itemRevisionId, revisionIds))
    : [];
  const scopes: HistoryScope[] = links.map((link) => ({ childId: child.id, skillVersionId: link.skillVersionId, skill: link.skill as HistoryScope["skill"] }));
  const histories = await readSkillHistories(exec, scopes);
  const policy = await loadPolicy(exec, child.policyId ?? CURRENT_POLICY_ID);
  const records = links.map((link) => {
    const revision = revisions.find(({ id }) => id === link.itemRevisionId);
    const payload = revision?.payload ?? {};
    const scope = { childId: child.id, skillVersionId: link.skillVersionId, skill: link.skill as HistoryScope["skill"] };
    return {
      itemId: link.itemId,
      skill: link.skill as PracticeHistoryRecord["skill"],
      skillVersionId: link.skillVersionId,
      source: typeof payload.source === "string" ? payload.source : "",
      target: typeof payload.target === "string" ? payload.target : "",
      history: histories.get(skillHistoryKey(scope)) ?? [],
    };
  });
  return selectPracticeItems({
    records,
    currentPolicyVersion: policy.version,
    periodStart: period.startUtc,
    generatedAt,
    dates: period.dates,
    timezone,
  });
}

export async function getLearningOverview(
  services: Services,
  queryInput: LearningOverviewQuery,
  rawToken: string,
  onAuthenticated?: (principal: IntegrationPrincipal) => void,
): Promise<LearningOverviewDto> {
  const query = LearningOverviewQuerySchema.parse(queryInput);
  return services.db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    await tx.execute(sql`select set_config('statement_timeout', ${`${MAX_STATEMENT_MS}ms`}, true)`);
    const principal = await requireLearningReadToken(tx, rawToken);
    onAuthenticated?.(principal);

    const generatedAt = services.clock.now().toISOString();
    const timezoneRow = (await tx.select({ timezone: familySettings.timezone }).from(familySettings).limit(1))[0];
    const timezone = timezoneRow?.timezone ?? DEFAULT_TIMEZONE;
    const period = buildReportPeriod(generatedAt, timezone, query.days);
    const today = period.to;
    const plannedFrom = today;
    const plannedTo = addDays(today, query.upcomingTestDays - 1);
    const childRows = (await tx.select({ id: childProfiles.id, displayName: childProfiles.displayName, policyId: childProfiles.policyId })
      .from(childProfiles).orderBy(childProfiles.id)) as ChildRow[];
    const children = query.childId ? childRows.filter(({ id }) => id === query.childId) : childRows;
    if (query.childId && children.length === 0) throw new AppError("not_found");
    const childIds = children.map(({ id }) => id);

    const daily = new Map<string, ActivityDay>();
    for (const child of children) for (const [index, date] of period.dates.entries()) {
      daily.set(activityKey(child.id, date), {
        date,
        isPartialDay: index === period.dates.length - 1,
        hasRecordedActivity: false,
        sessions: new Set(),
        submittedAttempts: 0,
        pendingAttempts: 0,
        decks: new Map(),
        mockTests: [],
      });
    }

    // Izolacja lekcji (zadanie 9): raport nauki obejmuje tylko zestawy słówek.
    // Jedna gałąź po rodzaju zestawu w tym module — przypisania lekcji nie
    // dają postępu, planowanych sprawdzianów, aktywności ani liczników.
    const assignmentsRows = childIds.length
      ? await tx.select({ id: assignments.id, childId: assignments.childId, deckId: assignments.deckId, testDate: assignments.testDate, testGoals: assignments.testGoals })
        .from(assignments)
        .innerJoin(decks, eq(decks.id, assignments.deckId))
        .where(and(inArray(assignments.childId, childIds), eq(assignments.active, true), eq(decks.kind, "vocabulary")))
      : [];
    const attemptRows = childIds.length
      ? (await tx.execute<ActivityRow>(sql`
          select a.child_id as "childId", s.id as "sessionId", v.deck_id as "deckId",
                 s.deck_version_id as "deckVersionId", v.title as "deckTitle",
                 v.version_number as "deckVersionNumber", a.received_at as at,
                 a.id as "attemptId", a.state, a.modality
            from learning_app.attempts a
            join learning_app.session_tasks t on t.id=a.task_id and t.child_id=a.child_id
            join learning_app.learning_sessions s on s.id=t.session_id and s.child_id=a.child_id
            join learning_app.deck_versions v on v.id=s.deck_version_id
            join learning_app.decks d on d.id=v.deck_id and d.kind='vocabulary'
           where a.child_id = any(${sql.param(childIds)}::uuid[])
             and a.received_at >= ${new Date(period.startUtc)} and a.received_at <= ${new Date(generatedAt)}
        `)).rows
      : [];
    const eventRows = childIds.length
      ? (await tx.execute<ActivityRow>(sql`
          select e.child_id as "childId", s.id as "sessionId", v.deck_id as "deckId",
                 s.deck_version_id as "deckVersionId", v.title as "deckTitle",
                 v.version_number as "deckVersionNumber", e.occurred_at as at
            from learning_app.learning_events e
            join learning_app.session_tasks t on t.id=e.task_id and t.child_id=e.child_id
            join learning_app.learning_sessions s on s.id=t.session_id and s.child_id=e.child_id
            join learning_app.deck_versions v on v.id=s.deck_version_id
            join learning_app.decks d on d.id=v.deck_id and d.kind='vocabulary'
           where e.child_id = any(${sql.param(childIds)}::uuid[])
             and e.sealed = true and e.kind = any(${sql.param([...ACTIVITY_EVENT_KINDS])}::text[])
             and e.occurred_at >= ${new Date(period.startUtc)} and e.occurred_at <= ${new Date(generatedAt)}
        `)).rows
      : [];

    for (const row of [...attemptRows, ...eventRows]) {
      const date = localDay(row.at, timezone);
      const day = daily.get(activityKey(row.childId, date));
      if (!day) continue;
      day.hasRecordedActivity = true;
      day.sessions.add(row.sessionId);
      ensureActivityDeck(day, row);
      if (row.attemptId && row.modality !== "skip") {
        day.submittedAttempts += 1;
        if (row.state === "processing") day.pendingAttempts += 1;
      }
    }

    const assessmentRows = childIds.length
      ? (await tx.execute<AssessmentRow>(sql`
          select a.child_id as "childId", s.id as "sessionId", v.deck_id as "deckId",
                 s.deck_version_id as "deckVersionId", v.title as "deckTitle",
                 v.version_number as "deckVersionNumber", p.received_at as at,
                 a.skill, a.outcome, a.independent
            from learning_app.assessments a
            join learning_app.attempts p on p.id=a.attempt_id and p.child_id=a.child_id
            join learning_app.session_tasks t on t.id=p.task_id and t.child_id=a.child_id
            join learning_app.learning_sessions s on s.id=t.session_id and s.child_id=a.child_id
            join learning_app.deck_versions v on v.id=s.deck_version_id
            join learning_app.decks d on d.id=v.deck_id and d.kind='vocabulary'
           where a.child_id = any(${sql.param(childIds)}::uuid[])
             and p.received_at >= ${new Date(period.startUtc)} and p.received_at <= ${new Date(generatedAt)}
        `)).rows
      : [];
    for (const row of assessmentRows) {
      const day = daily.get(activityKey(row.childId, localDay(row.at, timezone)));
      if (!day) continue;
      const deck = ensureActivityDeck(day, row);
      const count = deck.assessmentCounts.get(row.skill) ?? { independentCorrect: 0, correctNotIndependent: 0, incorrect: 0, unassessed: 0 };
      if (row.outcome === "correct") {
        if (row.independent) count.independentCorrect += 1;
        else count.correctNotIndependent += 1;
      } else if (row.outcome === "incorrect") count.incorrect += 1;
      else count.unassessed += 1;
      deck.assessmentCounts.set(row.skill, count);
    }

    const activityPoints = childIds.length
      ? (await tx.execute<{ childId: string; sessionId: string; at: Date | string }>(sql`
          select a.child_id as "childId", s.id as "sessionId", a.received_at as at
            from learning_app.attempts a
            join learning_app.session_tasks t on t.id=a.task_id and t.child_id=a.child_id
            join learning_app.learning_sessions s on s.id=t.session_id and s.child_id=a.child_id
            join learning_app.decks d on d.id=s.deck_id and d.kind='vocabulary'
           where a.child_id = any(${sql.param(childIds)}::uuid[])
             and a.received_at >= ${new Date(Date.parse(period.startUtc) - 120_000)} and a.received_at <= ${new Date(generatedAt)}
          union all
          select e.child_id as "childId", s.id as "sessionId", e.occurred_at as at
            from learning_app.learning_events e
            join learning_app.session_tasks t on t.id=e.task_id and t.child_id=e.child_id
            join learning_app.learning_sessions s on s.id=t.session_id and s.child_id=e.child_id
            join learning_app.decks d on d.id=s.deck_id and d.kind='vocabulary'
           where e.child_id = any(${sql.param(childIds)}::uuid[])
             and e.sealed = true and e.kind = any(${sql.param([...ACTIVITY_EVENT_KINDS])}::text[])
             and e.occurred_at >= ${new Date(Date.parse(period.startUtc) - 120_000)} and e.occurred_at <= ${new Date(generatedAt)}
        `)).rows
      : [];
    const activityDates = new Map<string, Set<string>>();
    for (const row of [...attemptRows, ...eventRows]) {
      const dates = activityDates.get(row.childId) ?? new Set<string>();
      dates.add(localDay(row.at, timezone));
      activityDates.set(row.childId, dates);
    }

    const mockRows = childIds.length
      ? await tx.select({ childId: learningSessions.childId, context: learningSessions.context })
        .from(learningSessions)
        .innerJoin(decks, eq(decks.id, learningSessions.deckId))
        // Bufor 48 h przed okresem: dzień rozstrzyga filtr JS po report.endedAt i strefie.
        // Filtr po session.endedAt zakłada niezmiennik closeMockTest: endedAt sesji i raportu to ten sam instant.
        .where(and(inArray(learningSessions.childId, childIds), eq(learningSessions.mode, "mock_test"), isNotNull(learningSessions.endedAt), gte(learningSessions.endedAt, new Date(Date.parse(period.startUtc) - 172_800_000)), eq(decks.kind, "vocabulary")))
      : [];
    for (const row of mockRows) {
      const parsed = MockTestReportDtoSchema.safeParse(row.context.mockTestReport);
      if (!parsed.success) continue;
      const report = parsed.data;
      const date = localDay(report.endedAt, timezone);
      const day = daily.get(activityKey(row.childId, date));
      if (!day) continue;
      day.mockTests.push({
        sessionId: report.sessionId,
        deckId: report.deckId,
        deckVersionId: report.deckVersionId,
        deckTitle: report.deckTitle,
        deckVersionNumber: report.deckVersionNumber,
        endedAt: report.endedAt,
        complete: report.complete,
        taskBudget: report.taskBudget,
        skills: report.skills.map(({ skill, totalItems, independentCorrect, practiceNeeded, correctNotIndependent, notTested, skipped, unassessed }) => ({
          skill, totalItems, independentCorrect, practiceNeeded, correctNotIndependent, notTested, skipped, unassessed,
        })),
      });
    }

    const publishedAssignments: PublishedAssignment[] = [];
    for (const assignment of assignmentsRows) {
      const child = children.find(({ id }) => id === assignment.childId)!;
      const deck = await readPublishedProgress(tx, assignment.childId, assignment.deckId).catch((error: unknown) => {
        if (error instanceof AppError && error.code === "not_found") return null;
        throw error;
      });
      if (!deck) continue;
      const practice = await currentPracticeItems(tx, child, deck, period, generatedAt, timezone);
      publishedAssignments.push({
        childId: child.id,
        deckId: deck.deckId,
        deckVersionId: deck.deckVersionId,
        deckTitle: deck.deckTitle,
        deckVersionNumber: deck.deckVersionNumber,
        totalItems: deck.totalItems,
        skills: deck.skills.map(({ totalItems: _totalItems, ...skill }) => skill),
        practiceItems: practice.items,
        practiceItemsTruncated: practice.truncated,
      });
    }

    const learningTimePoints = new Map<string, { sessionId: string; at: string }[]>();
    for (const row of activityPoints) {
      const points = learningTimePoints.get(row.childId) ?? [];
      points.push({ sessionId: row.sessionId, at: instant(row.at) });
      learningTimePoints.set(row.childId, points);
    }
    const plannedAssignments = assignmentsRows.filter((row) => row.testDate !== null && row.testDate >= plannedFrom && row.testDate <= plannedTo);

    const overview = {
      schemaVersion: 1 as const,
      learningTimeDefinition: { method: "activity_intervals_v1" as const, maxGapSeconds: 120 as const },
      generatedAt,
      timezone,
      period: { from: period.from, to: period.to, days: period.days },
      plannedTestsPeriod: { from: plannedFrom, to: plannedTo, days: query.upcomingTestDays },
      children: children.map((child) => {
        const time = estimateLearningTime({
          points: learningTimePoints.get(child.id) ?? [],
          period,
          timezone,
          now: generatedAt,
          daysWithActivity: activityDates.get(child.id) ?? new Set(),
        });
        const plannedTests = plannedAssignments.filter(({ childId }) => childId === child.id).map((assignment) => ({
          assignmentId: assignment.id,
          deckId: assignment.deckId,
          deckTitle: publishedAssignments.find((deck) => deck.childId === child.id && deck.deckId === assignment.deckId)?.deckTitle ?? "",
          date: assignment.testDate!,
          daysUntil: Math.round((Date.parse(assignment.testDate! + "T00:00:00.000Z") - Date.parse(plannedFrom + "T00:00:00.000Z")) / 86_400_000),
          goals: assignment.testGoals ?? [],
          source: "umiem_assignment" as const,
        })).sort((a, b) => a.date.localeCompare(b.date) || a.assignmentId.localeCompare(b.assignmentId));
        return {
          childId: child.id,
          childName: child.displayName,
          learningTime: time.total,
          dailyActivity: period.dates.map((date) => {
            const day = daily.get(activityKey(child.id, date))!;
            return {
              date,
              learningTime: time.byDate.get(date)!,
              isPartialDay: day.isPartialDay,
              hasRecordedActivity: day.hasRecordedActivity,
              sessionsWithActivity: day.sessions.size,
              submittedAttempts: day.submittedAttempts,
              pendingAttempts: day.pendingAttempts,
              decks: [...day.decks.values()].sort((a, b) => a.deckId.localeCompare(b.deckId) || a.deckVersionId.localeCompare(b.deckVersionId)).map((deck) => ({
                deckId: deck.deckId,
                deckVersionId: deck.deckVersionId,
                deckTitle: deck.deckTitle,
                deckVersionNumber: deck.deckVersionNumber,
                assessmentCounts: [...deck.assessmentCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([skill, counts]) => ({ skill, ...counts })),
              })),
              mockTests: day.mockTests,
            };
          }),
          currentProgress: publishedAssignments.filter((deck) => deck.childId === child.id)
            .sort((a, b) => a.deckId.localeCompare(b.deckId))
            .map(({ childId: _childId, ...deck }) => deck),
          plannedTests,
        };
      }),
    };
    return LearningOverviewDtoSchema.parse(overview);
  });
}
