import { randomInt, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte, max, sql } from "drizzle-orm";
import {
  PresentationCompletionInputSchema,
  SessionInputSchema,
  SessionSummaryDtoSchema,
  UuidSchema,
  type PresentationCompletionDto,
  type PresentationCompletionInput,
  type SessionDto,
  type SessionInput,
  type SessionSummaryDto,
  type TaskDto,
  type TaskPrompt,
  type TestGoal,
} from "@learning/contracts";
import type { Services } from "../../config";
import type { Tx } from "../../db/client";
import {
  assessments,
  assignments,
  attempts,
  childProfiles,
  childSkillProgress,
  deckVersions,
  decks,
  eventExposures,
  familySettings,
  itemRevisions,
  itemRevisionSkills,
  learningEvents,
  learningSessions,
  revisionAssets,
  sessionTasks,
} from "../../db/schema";
import { AppError } from "../../errors";
import {
  selectTask,
  type ScheduleCandidate,
  type ScheduleReason,
  type SkillSnapshot,
  type TaskPlan,
} from "../../domain/scheduler";
import type { Policy, ProgressStatus, ReadingDirection, Skill } from "../../domain/types";
import { buildTaskContent, type PlannedItem, type TaskContent } from "../../domain/task-materialization";
export type { PlannedItem } from "../../domain/task-materialization";
import { loadPolicy, ensureLearningPolicy, CURRENT_POLICY_ID } from "../../policies/registry";
import { lockTaskWithSession, writeSealedEvent, contextOf, type SessionContextShape } from "./events";
import { payloadToItem } from "../materials";
import { summarizeSessionAssessments } from "../../domain/session-summary";
import { computeTargetKey } from "../../domain/target-key";
import { LESSON_STORY_TASK_TYPES, MeaningVisualSchema } from "@learning/contracts";
import { readUiAudio } from "../materials";
import { getVocabularyCapabilities } from "../../domain/vocabulary-capabilities";
import { addLegacyTaskPromptDefaults } from "./task-prompt-compat";
import { deriveSupportStates, type SupportAttempt, type SupportTask } from "../../domain/support-cycle";
import {
  readLessonTrainingSessionPlan,
  readTrainingSessionPlan,
  type LessonTrainingSessionPlanSnapshot,
  type TrainingSessionPlanSnapshot,
  type TrainingSessionSlot,
} from "../../domain/training-session-plan";
import { readLearningSnapshot, type LearningSnapshotItem } from "./learning-snapshot";
import { createMockTestPlan, issueMockTestTask, closeMockTest } from "./mock-tests";
import { assertVocabularyDeck, type DeckKind } from "../materials";
import {
  buildLessonSessionContext,
  createLessonTrainingSessionPlan,
  issueNextLessonPlanTask,
  issueNextLessonTask,
  buildLessonSummaryObjectives,
  lessonTaskCounts,
  sqlTypeList,
} from "./lessons/lesson-sessions";
import {
  createLessonMockTestPlan,
  issueLessonMockTestTask,
  closeLessonMockTest,
  isLessonMockPlan,
} from "./lessons/lesson-mock-tests";
import { issueNextVocabularyPlanTask } from "./vocabulary-plan-tasks";
import { issueVocabularyTask, type VocabularyTaskSnapshot } from "./vocabulary-task-issuance";

import { completeDisabledVoiceTask } from "./voice-task-lifecycle";
import { beginSessionActivityReview, readSessionActivityResult } from "./session-activity";
import type { SessionActivityReport } from "@learning/contracts";
import { SKILL_PROJECTION_VERSION } from "./skill-projections";
import { RESUME_WINDOW_MS, sessionTimeLimitMs } from "../../domain/session-limits";
import { isNonAssessedLessonTaskType, NON_ASSESSED_LESSON_TASK_TYPES } from "../../domain/lessons/session-task-types";
import { withStoryCounters } from "./lessons/lesson-story-tasks";

/** Po komunikacie „Jeszcze N” obietnica wobec dziecka waży więcej niż limit. */
const PROMISE_REMAINING = 3;
/**
 * Startowy budżet zadań ocenianych; prezentacje go nie powiększają. Wartość
 * domyślna `decks.session_task_budget`; stała pozostaje fallbackiem dla
 * ścieżek startu sesji bez wczytanego zestawu (obecnie nieistniejących).
 */
export const DEFAULT_TASK_BUDGET = 20;

/** Statusy child_skill_progress odwzorowane na domenową projekcję zadania 5. */
export function mapStatus(dbStatus: string): ProgressStatus {
  switch (dbStatus) {
    case "unseen":
      return "not_assessed";
    case "practicing":
      return "learning";
    case "needs_confirmation":
      return "needs_confirmation";
    case "needs_reconfirmation":
      return "needs_reconfirmation";
    case "mastered":
      return "mastered";
    default:
      return "not_assessed";
  }
}

async function lockSession(tx: Tx, sessionId: string) {
  // Rodzaj zestawu dokładamy do zapytania o childId (join po FK decks), żeby
  // gorąca ścieżka nextTask nie płaciła osobnego odczytu rodzaju zestawu.
  const [identity] = await tx
    .select({ childId: learningSessions.childId, deckKind: decks.kind, lessonContext: deckVersions.lessonContext })
    .from(learningSessions)
    .innerJoin(decks, eq(decks.id, learningSessions.deckId))
    .innerJoin(deckVersions, eq(deckVersions.id, learningSessions.deckVersionId))
    .where(eq(learningSessions.id, sessionId));
  if (!identity) throw new AppError("not_found");
  await tx.select({ id: childProfiles.id }).from(childProfiles).where(eq(childProfiles.id, identity.childId)).for("key share");
  const session = (
    await tx.select().from(learningSessions).where(eq(learningSessions.id, sessionId)).for("update")
  )[0];
  if (!session) {
    throw new AppError("not_found");
  }
  return Object.assign(session, { deckKind: identity.deckKind as DeckKind, lessonContext: identity.lessonContext });
}

/** Typy poza budżetem ocenianych: prezentacje słówek, karty i zadania historyjki lekcji. */
const NON_ASSESSED_TASK_TYPES: readonly string[] = ["exposure", ...NON_ASSESSED_LESSON_TASK_TYPES];

/**
 * Liczniki `SessionDto` i podsumowania: `assessed` bez prezentacji, kart i zadań
 * historyjki (ruling 9 planu historyjki — karty lekcji przestały go zawyżać).
 * Zadania następcze lekcji liczą się jak dotąd.
 */
async function taskCounts(tx: Tx, sessionId: string): Promise<{ total: number; assessed: number }> {
  const [row] = await tx
    .select({
      total: sql<number>`count(*)::int`,
      assessed: sql<number>`(count(*) filter (where ${sessionTasks.exerciseType} not in (${sqlTypeList(NON_ASSESSED_TASK_TYPES)})))::int`,
    })
    .from(sessionTasks)
    .where(eq(sessionTasks.sessionId, sessionId));
  return { total: row?.total ?? 0, assessed: row?.assessed ?? 0 };
}

/**
 * Ostatnia aktywność sesji: wydanie zadania, zdarzenie (ujawnienie, próba
 * obserwacji) lub próba. Po przekroczeniu okna wznowienia sesja jest przeterminowana.
 */
async function lastActivityAt(tx: Tx, sessionId: string, startedAt: Date): Promise<Date> {
  // Jedno zapytanie zamiast trzech sekwencyjnych max(): greatest() w Postgresie
  // pomija NULL-e, a brak aktywności daje NULL → startedAt jak dotąd.
  const rows = await tx.execute(sql`
    select greatest(
      (select max(${sessionTasks.issuedAt}) from ${sessionTasks} where ${sessionTasks.sessionId} = ${sessionId}),
      (select max(${learningEvents.occurredAt}) from ${learningEvents}
         inner join ${sessionTasks} on ${sessionTasks.id} = ${learningEvents.taskId}
         where ${sessionTasks.sessionId} = ${sessionId}),
      (select max(${attempts.receivedAt}) from ${attempts}
         inner join ${sessionTasks} on ${sessionTasks.id} = ${attempts.taskId}
         where ${sessionTasks.sessionId} = ${sessionId})
    ) as latest
  `);
  const latest = (rows.rows[0] as { latest: Date | string | null } | undefined)?.latest;
  if (latest === null || latest === undefined) return startedAt;
  const latestDate = latest instanceof Date ? latest : new Date(latest);
  return latestDate.getTime() > startedAt.getTime() ? latestDate : startedAt;
}

interface SessionActivityCounts {
  total: number;
  assessed: number;
  /** Zadania z planu sesji — bez zadań następczych lekcji (`context.followUpOf`). */
  planned: number;
  /** Wydane zadania historyjki lekcji (sufiks planu). */
  story: number;
  lastActivity: Date;
}

/** Liczniki zadań i ostatnia aktywność sesji jednym zapytaniem (gorąca ścieżka nextTask). */
async function sessionActivityAndCounts(
  tx: Tx,
  sessionId: string,
  startedAt: Date,
  nonAssessedTypes: readonly string[] = ["exposure"],
): Promise<SessionActivityCounts> {
  const rows = await tx.execute(sql`
    select
      (select count(*)::int from ${sessionTasks} where ${sessionTasks.sessionId} = ${sessionId}) as total,
      (select (count(*) filter (where ${sessionTasks.exerciseType} not in (${sqlTypeList(nonAssessedTypes)}) and ${sessionTasks.context}->'followUpOf' is null))::int
         from ${sessionTasks} where ${sessionTasks.sessionId} = ${sessionId}) as assessed,
      (select (count(*) filter (where ${sessionTasks.context}->'followUpOf' is null))::int
         from ${sessionTasks} where ${sessionTasks.sessionId} = ${sessionId}) as planned,
      (select (count(*) filter (where ${sessionTasks.exerciseType} in (${sqlTypeList(LESSON_STORY_TASK_TYPES)})))::int
         from ${sessionTasks} where ${sessionTasks.sessionId} = ${sessionId}) as story,
      greatest(
        (select max(${sessionTasks.issuedAt}) from ${sessionTasks} where ${sessionTasks.sessionId} = ${sessionId}),
        (select max(${learningEvents.occurredAt}) from ${learningEvents}
           inner join ${sessionTasks} on ${sessionTasks.id} = ${learningEvents.taskId}
           where ${sessionTasks.sessionId} = ${sessionId}),
        (select max(${attempts.receivedAt}) from ${attempts}
           inner join ${sessionTasks} on ${sessionTasks.id} = ${attempts.taskId}
           where ${sessionTasks.sessionId} = ${sessionId})
      ) as latest
  `);
  const row = rows.rows[0] as { total: number; assessed: number; planned: number; story: number; latest: Date | string | null };
  const latest = row.latest === null ? null : row.latest instanceof Date ? row.latest : new Date(row.latest);
  return {
    total: row.total ?? 0,
    assessed: row.assessed ?? 0,
    planned: row.planned ?? 0,
    story: row.story ?? 0,
    lastActivity: latest !== null && latest.getTime() > startedAt.getTime() ? latest : startedAt,
  };
}

async function sessionDto(tx: Tx, row: typeof learningSessions.$inferSelect, resumed: boolean): Promise<SessionDto> {
  const counts = await taskCounts(tx, row.id);
  const snapshot = contextOf(row);
  return {
    sessionId: row.id,
    mode: row.mode,
    childId: row.childId,
    deckId: row.deckId,
    deckVersionId: row.deckVersionId,
    policyId: row.policyId,
    microphoneEnabled: row.microphoneEnabled,
    canRead: snapshot.canRead,
    vocabularyFormat: snapshot.vocabularyFormat,
    state: row.state as SessionDto["state"],
    taskBudget: row.taskBudget,
    tasksIssued: counts.total,
    assessedTasksIssued: counts.assessed,
    startedAt: row.startedAt.toISOString(),
    resumed,
  };
}

async function readTimezone(tx: Tx): Promise<string> {
  const row = (await tx.select().from(familySettings).limit(1))[0];
  return row?.timezone ?? "Europe/Warsaw";
}

/** Snapshot kontaktów z poprzednich sesji — zamrożony przy starcie (arch §9.3). */
async function previousContactSnapshot(
  tx: Tx,
  childId: string,
  deckVersionId: string,
  before: Date,
): Promise<Record<string, string>> {
  const revisions = await tx
    .select({ itemId: itemRevisions.itemId, payload: itemRevisions.payload, targetKey: itemRevisions.targetKey })
    .from(itemRevisions)
    .where(eq(itemRevisions.deckVersionId, deckVersionId));
  if (revisions.length === 0) {
    return {};
  }
  const rows = await tx
    .select({ itemId: learningEvents.itemId, latest: max(learningEvents.occurredAt) })
    .from(learningEvents)
    .where(
      and(
        eq(learningEvents.childId, childId),
        inArray(
          learningEvents.itemId,
          revisions.map((r) => r.itemId),
        ),
        lte(learningEvents.occurredAt, before),
      ),
    )
    .groupBy(learningEvents.itemId);
  const latestByItem = new Map(rows.map(r => [r.itemId, r.latest!.toISOString()]));
  const keysByItem = new Map(revisions.map(r => {
    const item = payloadToItem(r.payload);
    return [r.itemId, [...new Set([r.targetKey, ...[item.target, ...item.acceptedAnswers].map(answer => computeTargetKey(answer, item.locales.target))])]] as const;
  }));
  const keys = [...new Set([...keysByItem.values()].flat())];
  const exposures = await tx.select({ targetKey: eventExposures.targetKey, latest: max(learningEvents.occurredAt) }).from(eventExposures)
    .innerJoin(learningEvents, eq(learningEvents.id, eventExposures.eventId))
    .where(and(eq(eventExposures.childId, childId), inArray(eventExposures.targetKey, keys), lte(learningEvents.occurredAt, before)))
    .groupBy(eventExposures.targetKey);
  const latestByKey = new Map(exposures.map(e => [e.targetKey, e.latest!.toISOString()]));
  for (const [itemId, targetKeys] of keysByItem) for (const key of targetKeys) {
    const value = latestByKey.get(key);
    if (value && (!latestByItem.has(itemId) || value > latestByItem.get(itemId)!)) latestByItem.set(itemId, value);
  }
  return Object.fromEntries(latestByItem);
}

/**
 * Start lub wznowienie sesji dziecka (arch §9.1). Blokada wiersza profilu
 * serializuje równoległe starty; ta sama talia i tryb wznawiają aktywną sesję.
 * Inna talia/tryb wymagają jawnego końca; przeterminowanie zamyka starą sesję.
 */
export async function startSession(services: Services, input: SessionInput): Promise<SessionDto> {
  const valid = SessionInputSchema.parse(input);
  const mode = valid.mode ?? "training";
  return services.db.transaction(async (tx) => {
    const child = (
      await tx.select({ id: childProfiles.id, canRead: childProfiles.canRead, projectionVersion: childProfiles.learningProjectionVersion }).from(childProfiles).where(eq(childProfiles.id, valid.childId)).for("no key update")
    )[0];
    if (!child) {
      throw new AppError("not_found");
    }
    const now = services.clock.now();
    const active = (
      await tx
        .select()
        .from(learningSessions)
        .where(and(eq(learningSessions.childId, valid.childId), eq(learningSessions.state, "active")))
      .for("update")
    )[0];
    if (active) {
      const stale =
        now.getTime() - (await lastActivityAt(tx, active.id, active.startedAt)).getTime() >
        RESUME_WINDOW_MS;
      if (active.deckId === valid.deckId && active.mode === mode && !stale) {
        const activeContext = contextOf(active);
        if ((activeContext.vocabularyFormat === "picture" || activeContext.supportsPictureVocabulary) && !valid.supportsPictureVocabulary) {
          throw new AppError("validation", { details: { reason: "picture_client_update_required" } });
        }
        return sessionDto(tx, active, true);
      }
      if (!stale) throw new AppError("conflict", { message: "Wróć do rozpoczętej sesji albo zakończ ją przed nową." });
      if (active.mode === "mock_test") {
        if (isLessonMockPlan(active.mockTestPlan)) await closeLessonMockTest(tx, services, active);
        else await closeMockTest(tx, services, active, "ended");
      } else await tx
        .update(learningSessions)
        .set({ state: "ended", endedAt: now })
        .where(eq(learningSessions.id, active.id));
    }

    if (child.projectionVersion !== SKILL_PROJECTION_VERSION) {
      throw new AppError("conflict", { message: "learning projection rebuild required" });
    }

    const assignment = (
      await tx.select().from(assignments).where(and(
        eq(assignments.childId, valid.childId),
        eq(assignments.deckId, valid.deckId),
        eq(assignments.active, true),
      ))
    )[0];
    if (!assignment) throw new AppError("not_found");
    const deck = (await tx.select().from(decks).where(eq(decks.id, valid.deckId)))[0];
    if (!deck) throw new AppError("not_found");
    if (deck.archivedAt) throw new AppError("conflict");
    if (!deck.publishedVersionId) throw new AppError("validation", { message: "deck is not published" });
    const deckKind = deck.kind as DeckKind;

    const timezone = await readTimezone(tx);
    const versionId = deck.publishedVersionId;
    const version = (await tx.select().from(deckVersions).where(eq(deckVersions.id, versionId)))[0]!;
    if (version.vocabularyFormat === "picture" && !valid.supportsPictureVocabulary) {
      throw new AppError("validation", { details: { reason: "picture_client_update_required" } });
    }
    if (!child.canRead) {
      if (mode === "mock_test") throw new AppError("validation", { details: { reason: "non_reader_mock_test_unavailable" } });
      if (deckKind !== "vocabulary" || version.vocabularyFormat !== "picture") {
        throw new AppError("validation", { details: { reason: "vocabulary_requires_reading" } });
      }
      if (!(await readUiAudio(services)).ready) {
        throw new AppError("validation", { details: { reason: "picture_guidance_unavailable" } });
      }
    }
    await ensureLearningPolicy(tx);
    // polityka per dziecko (design 2026-10-09): własna wersja profilu albo bieżąca globalna
    const childProfile = (
      await tx.select({ policyId: childProfiles.policyId }).from(childProfiles).where(eq(childProfiles.id, valid.childId))
    )[0];
    const contextBase = deckKind === "lesson"
      ? await buildLessonSessionContext(tx, {
          childId: valid.childId,
          deckVersionId: version.id,
          timezone,
          testDate: assignment.testDate,
          now,
        })
      : {
          timezone,
          testDate: assignment.testDate,
          previousContact: await previousContactSnapshot(tx, valid.childId, version.id, now),
          reservations: [],
          settledChecks: [],
        };
    const context: SessionContextShape = {
      ...contextBase,
      canRead: child.canRead,
      vocabularyFormat: version.vocabularyFormat,
      supportsPictureVocabulary: valid.supportsPictureVocabulary,
      supportsPictureRecognition: valid.supportsPictureRecognition,
      microphoneDisabledTaskIds: [],
    };
    const id = randomUUID();
    if (mode === "mock_test" && !assignment.testGoals?.length) throw new AppError("validation", { message: "Rodzic musi najpierw ustawić cel kartkówki." });
    // Kartkówka lekcji (zadanie 17): wymaga celu `lesson` w przypisaniu; plan z
    // planera kartkówki lekcji (bezpieczna porcja przypiętej wersji). Kartkówka
    // słówek: cele słówkowe i planer słówek. Oba zapisują snapshot w tej samej
    // kolumnie `mock_test_plan` (dyskryminator `kind` dla lekcji).
    const mockTestPlan =
      mode !== "mock_test"
        ? null
        : deckKind === "lesson"
          ? (assignment.testGoals!.includes("lesson")
              ? await createLessonMockTestPlan(tx, services, {
                  childId: valid.childId,
                  deckVersionId: version.id,
                  requestedTaskCount: assignment.mockTestTaskCount,
                })
              : (() => { throw new AppError("validation", { message: "Rodzic musi najpierw ustawić cel kartkówki lekcji." }); })())
          : await createMockTestPlan(tx, services, {
              // Kartkówka słówek obsługuje tylko cele słówkowe; cel `lesson`
              // dotyczy lekcji (osobna ścieżka) i nie trafia tu w czasie wykonania.
              childId: valid.childId, deckVersionId: version.id, policyId: childProfile?.policyId ?? CURRENT_POLICY_ID,
              testGoals: assignment.testGoals!.filter((g): g is TestGoal => g !== "lesson"), testDate: assignment.testDate,
              requestedTaskCount: assignment.mockTestTaskCount,
            });
    if (mockTestPlan && !mockTestPlan.slots.length) throw new AppError("mock_test_unavailable");
    const [row] = await tx
      .insert(learningSessions)
      .values({
        id,
        childId: valid.childId,
        assignmentId: assignment.id,
        deckId: valid.deckId,
        deckVersionId: version.id,
        policyId: childProfile?.policyId ?? CURRENT_POLICY_ID,
        microphoneEnabled: valid.microphoneEnabled,
        state: "active",
        taskBudget: mockTestPlan?.slots.length ?? deck.sessionTaskBudget,
        mode,
        mockTestPlan,
        startedAt: now,
        context: context as unknown as Record<string, unknown>,
      })
      .returning();
    if (mode === "training" && deckKind === "vocabulary") {
      const plan = await createTrainingSessionPlan(tx, services, row!, now);
      await tx.update(learningSessions).set({ trainingPlan: plan, taskBudget: plan.taskBudget })
        .where(eq(learningSessions.id, row!.id));
      const plannedSession = (await tx.select().from(learningSessions).where(eq(learningSessions.id, row!.id)))[0]!;
      return sessionDto(tx, plannedSession, false);
    }
    if (mode === "training" && deckKind === "lesson") {
      const plan = await createLessonTrainingSessionPlan(services, tx, row!, now);
      await tx.update(learningSessions).set({ trainingPlan: plan, taskBudget: plan.taskBudget })
        .where(eq(learningSessions.id, row!.id));
      const plannedSession = (await tx.select().from(learningSessions).where(eq(learningSessions.id, row!.id)))[0]!;
      return sessionDto(tx, plannedSession, false);
    }
    return sessionDto(tx, row!, false);
  });
}

interface PlannedTask {
  plan: TaskPlan;
  item: PlannedItem;
  audioAssetId: string | null;
  imageAssetId: string | null;
  exampleAudioAssetId: string | null;
}

interface ItemStats {
  usedThisSession: number;
  presentationsThisSession: number;
  lastUsedOrdinal: number | null;
  supportedThisSession: boolean;
  recognitionFallbackUsedThisSession: boolean;
  readingDirections: Partial<Record<ReadingDirection, number>>;
  practiceMix: { listening: number; reading: number };
  pictureListeningCount: number;
  textListeningCount: number;
}

interface TrainingPlanPlanningCache {
  policy: Policy | null;
  learningSnapshots: readonly LearningSnapshotItem[] | null;
}

/** Buduje wejście schedulera z przypiętej wersji, projekcji i statystyki sesji. */
async function planNextTask(
  tx: Tx,
  session: typeof learningSessions.$inferSelect,
  now: Date,
  assessedRemaining: number,
  nextOrdinal: number,
  plannedPrefix: readonly TrainingSessionSlot[] = [],
  historicalSupport: { tasks: readonly SupportTask[]; attempts: readonly SupportAttempt[] } = { tasks: [], attempts: [] },
  planningCache?: TrainingPlanPlanningCache,
): Promise<PlannedTask | null> {
  const allRevisions = await tx
    .select()
    .from(itemRevisions)
    .where(eq(itemRevisions.deckVersionId, session.deckVersionId))
    .orderBy(asc(itemRevisions.position));
  const revisions = allRevisions;
  if (revisions.length === 0) {
    return null;
  }
  const revisionIds = revisions.map((r) => r.id);

  const audioRows = await tx
    .select({ itemRevisionId: revisionAssets.itemRevisionId, assetId: revisionAssets.assetId })
    .from(revisionAssets)
    .where(
      and(
        inArray(revisionAssets.itemRevisionId, revisionIds),
        eq(revisionAssets.role, "target_audio"),
        eq(revisionAssets.state, "approved"),
      ),
    );
  const audioByRevision = new Map(audioRows.map((a) => [a.itemRevisionId, a.assetId]));

  // Audio zdania przykładowego (SPEC §22): odtwarzane z pliku przygotowanego
  // z zestawem; karta bez przykładu po prostu dostaje null.
  const exampleRows = await tx
    .select({ itemRevisionId: revisionAssets.itemRevisionId, assetId: revisionAssets.assetId })
    .from(revisionAssets)
    .where(
      and(
        inArray(revisionAssets.itemRevisionId, revisionIds),
        eq(revisionAssets.role, "example_audio"),
        eq(revisionAssets.state, "approved"),
      ),
    );
  const exampleByRevision = new Map(exampleRows.map((a) => [a.itemRevisionId, a.assetId]));

  // Pomoc wizualna prezentacji (SPEC §12.1): zatwierdzona ilustracja rodzica;
  // pominięty obraz pozostaje null i nie blokuje zadania.
  const imageRows = await tx
    .select({ itemRevisionId: revisionAssets.itemRevisionId, assetId: revisionAssets.assetId })
    .from(revisionAssets)
    .where(
      and(
        inArray(revisionAssets.itemRevisionId, revisionIds),
        eq(revisionAssets.role, "illustration"),
        eq(revisionAssets.state, "approved"),
      ),
    );
  const imageByRevision = new Map(imageRows.map((a) => [a.itemRevisionId, a.assetId]));

  const progressRows = await tx
    .select({
      itemRevisionId: itemRevisionSkills.itemRevisionId,
      skill: itemRevisionSkills.skill,
      status: childSkillProgress.status,
      nextReviewAt: childSkillProgress.nextReviewAt,
      streak: childSkillProgress.independentSuccessStreak,
    })
    .from(itemRevisionSkills)
    .leftJoin(
      childSkillProgress,
      and(
        eq(childSkillProgress.skillVersionId, itemRevisionSkills.skillVersionId),
        eq(childSkillProgress.childId, session.childId),
        eq(childSkillProgress.policyId, session.policyId),
      ),
    )
    .where(inArray(itemRevisionSkills.itemRevisionId, revisionIds));

  const statsByRevision = new Map<string, ItemStats>(
    revisions.map((r) => [
      r.id,
      {
        usedThisSession: 0,
        presentationsThisSession: 0,
        lastUsedOrdinal: null,
        supportedThisSession: false,
        recognitionFallbackUsedThisSession: false,
        readingDirections: {},
        practiceMix: { listening: 0, reading: 0 },
        pictureListeningCount: 0,
        textListeningCount: 0,
      },
    ]),
  );
  const storedTaskRows = await tx
    .select({
      id: sessionTasks.id,
      itemRevisionId: sessionTasks.itemRevisionId,
      exerciseType: sessionTasks.exerciseType,
      direction: sessionTasks.direction,
      ordinal: sessionTasks.ordinal,
      context: sessionTasks.context,
      publicPrompt: sessionTasks.publicPrompt,
      state: sessionTasks.state,
    })
    .from(sessionTasks)
    .where(eq(sessionTasks.sessionId, session.id))
    .orderBy(asc(sessionTasks.ordinal));
  const taskRows = [...storedTaskRows, ...plannedPrefix.map((slot) => ({
    id: slot.taskId,
    itemRevisionId: slot.itemRevisionId,
    exerciseType: slot.exerciseType,
    direction: slot.direction,
    ordinal: slot.ordinal,
    context: {
      reason: slot.reason,
      ...(slot.supportCycleId ? { supportCycleId: slot.supportCycleId } : {}),
      ...(slot.skillAtIssue ? { skillAtIssue: slot.skillAtIssue } : {}),
      ...(slot.statusAtIssue !== undefined ? { statusAtIssue: slot.statusAtIssue } : {}),
      ...(slot.assessmentSkills ? { assessmentSkills: slot.assessmentSkills } : {}),
    },
    publicPrompt: slot.prompt as unknown as Record<string, unknown>,
    state: slot.exerciseType === "exposure" ? "completed" : "answered",
  }))].sort((a, b) => a.ordinal - b.ordinal);
  for (const row of taskRows) {
    const stats = statsByRevision.get(row.itemRevisionId);
    if (!stats) continue;
    stats.usedThisSession += 1;
    stats.lastUsedOrdinal = Math.max(stats.lastUsedOrdinal ?? -1, row.ordinal);
    if (row.exerciseType === "exposure") {
      stats.presentationsThisSession += 1;
    }
    if ((row.context as { reason?: string } | null)?.reason === "support") {
      stats.supportedThisSession = true;
    }
    if ((row.context as { reason?: string } | null)?.reason === "recognition-fallback") {
      stats.recognitionFallbackUsedThisSession = true;
    }
    if (row.exerciseType === "listening") {
      stats.practiceMix.listening += 1;
      if ((row.publicPrompt as { kind?: unknown } | null)?.kind === "picture_listening") stats.pictureListeningCount += 1;
      else stats.textListeningCount += 1;
    } else if (row.exerciseType === "reading" || row.exerciseType === "reverse_recognition" || row.exerciseType === "picture_recognition") {
      stats.practiceMix.reading += 1;
      const direction = (row.direction ?? (row.exerciseType === "reading" ? "target_to_source" : "source_to_target")) as ReadingDirection;
      stats.readingDirections[direction] = (stats.readingDirections[direction] ?? 0) + 1;
    }
  }

  // Trudności z prób tej sesji: oceniony błąd liczy się pojedynczo, a jedno
  // „Nie pamiętam” nasycie próg wsparcia — deklarowana trudność prowadzi do
  // wsparcia bez czekania na drugi błąd (SPEC §15.1, §16).
  const policy = planningCache?.policy ?? await loadPolicy(tx, session.policyId);
  if (planningCache && planningCache.policy === null) planningCache.policy = policy;
  const learningSnapshots = planningCache?.learningSnapshots ?? await readLearningSnapshot(tx, {
    childId: session.childId, revisionIds, policy, now: now.toISOString(),
  });
  if (planningCache && planningCache.learningSnapshots === null) planningCache.learningSnapshots = learningSnapshots;
  const snapshotByRevision = new Map(learningSnapshots.map((snapshot) => [snapshot.itemRevisionId, snapshot]));
  const gradedRows = await tx
    .select({
      attemptId: attempts.id,
      taskId: attempts.taskId,
      itemRevisionId: sessionTasks.itemRevisionId,
      exerciseType: sessionTasks.exerciseType,
      modality: attempts.modality,
      feedback: attempts.feedback,
      skill: assessments.skill,
      outcome: assessments.outcome,
    })
    .from(attempts)
    .innerJoin(sessionTasks, eq(sessionTasks.id, attempts.taskId))
    .leftJoin(assessments, eq(assessments.attemptId, attempts.id))
    .where(eq(sessionTasks.sessionId, session.id));
  const attemptsById = new Map<string, SupportAttempt>();
  for (const row of gradedRows) {
    const current = attemptsById.get(row.attemptId) ?? {
      attemptId: row.attemptId, taskId: row.taskId, modality: row.modality,
      outcomes: [] as { skill: Skill; outcome: "correct" | "incorrect" | "unevaluated" }[],
    };
    if (row.skill !== null && row.outcome !== null) {
      current.outcomes = [...current.outcomes, { skill: row.skill as Skill, outcome: row.outcome === "unassessed" ? "unevaluated" : row.outcome as "correct" | "incorrect" }];
    }
    attemptsById.set(row.attemptId, current);
  }
  const supportTasks: SupportTask[] = [...historicalSupport.tasks, ...taskRows.map((row) => {
    const context = row.context as { reason?: string; supportCycleId?: string } | null;
    return {
      taskId: row.id,
      itemRevisionId: row.itemRevisionId,
      sessionId: session.id,
      ordinal: historicalSupport.tasks.length + row.ordinal,
      exerciseType: row.exerciseType as SupportTask["exerciseType"],
      state: (row.state === "completed" || row.state === "answered" || row.state === "skipped" ? row.state : "issued") as SupportTask["state"],
      reason: context?.reason ?? "",
      ...(context?.supportCycleId ? { supportCycleId: context.supportCycleId } : {}),
    };
  })];
  const supportByRevision = deriveSupportStates(supportTasks, [...historicalSupport.attempts, ...attemptsById.values()], policy.supportAfterFailures);

  const sessionContext = contextOf(session);
  const items = new Map<string, PlannedItem>(
    revisions.map((r) => {
      const item = payloadToItem(r.payload as Record<string, unknown>);
      return [
        r.id,
        {
          itemId: r.itemId,
          source: item.source,
          target: item.target,
          acceptedAnswers: [...item.acceptedAnswers],
          visualType: item.visualType,
          ...(item.visualData === undefined ? {} : { visualData: item.visualData }),
          ...(item.example === undefined ? {} : { example: item.example }),
          sourceLocale: item.locales.source,
          targetLocale: item.locales.target,
          ...(sessionContext.vocabularyFormat === "picture"
            ? {
                meaningVisual: item.visualType === "image"
                  ? MeaningVisualSchema.parse({ kind: "image", imageAssetId: imageByRevision.get(r.id) })
                  : item.visualType === "color"
                    ? MeaningVisualSchema.parse({ kind: "color", color: item.visualData?.color })
                    : MeaningVisualSchema.parse({ kind: "number", count: item.visualData?.count }),
              }
            : {}),
          ...(item.visualType === "image" && imageByRevision.has(r.id)
            ? { listeningVisual: MeaningVisualSchema.parse({ kind: "image", imageAssetId: imageByRevision.get(r.id) }) }
            : item.visualType === "color"
              ? { listeningVisual: MeaningVisualSchema.parse({ kind: "color", color: item.visualData?.color }) }
              : item.visualType === "number"
                ? { listeningVisual: MeaningVisualSchema.parse({ kind: "number", count: item.visualData?.count }) }
                : {}),
        },
      ];
    }),
  );

  // kontakt z poprzednich sesji zamrożony przy starcie (arch §9.3) —
  // porządek rotacji utrwalania na rozpoczętym zestawie
  // Każda ujawniona treść (cel lub dystraktor) ma wcześniej zapieczętowany
  // event_exposures. Używamy klucza odpowiedzi, nie samej historii zadań,
  // żeby nie uznać nieujawnionego/legacy tasku za znane słowo.
  const targetKeysByRevision = new Map(
    revisions.map((revision) => {
      const item = items.get(revision.id)!;
      return [revision.id, computeTargetKey(item.target, item.targetLocale)] as const;
    }),
  );
  const historicalExposureRows = await tx
    .select({ targetKey: eventExposures.targetKey })
    .from(eventExposures)
    .innerJoin(learningEvents, eq(learningEvents.id, eventExposures.eventId))
    .where(
      and(
        eq(eventExposures.childId, session.childId),
        eq(learningEvents.sealed, true),
        inArray(eventExposures.targetKey, [...targetKeysByRevision.values()]),
      ),
    );
  const historicallyExposed = new Set(historicalExposureRows.map((row) => row.targetKey));

  const terminalTasks = taskRows.filter((row) => row.state === "answered" || row.state === "skipped");
  const assessedTasks = terminalTasks.filter((row) => row.state === "answered");
  const recentAssessedReasons = assessedTasks
    .filter((row) => row.exerciseType !== "exposure")
    .map((row) => (row.context as { reason?: unknown } | null)?.reason)
    .filter((reason): reason is ScheduleReason => typeof reason === "string")
    .slice(-2);
  const recentAssessedTasks = assessedTasks
    .filter((row) => row.exerciseType !== "exposure")
    .slice(-2)
    .map((row) => {
      const context = row.context as { reason?: unknown; skillAtIssue?: unknown; statusAtIssue?: unknown } | null;
      return {
        reason: typeof context?.reason === "string" ? context.reason as ScheduleReason : "new-practice" as ScheduleReason,
        skill: typeof context?.skillAtIssue === "string" ? context.skillAtIssue as Skill : null,
        statusAtIssue: typeof context?.statusAtIssue === "string" ? context.statusAtIssue as SkillSnapshot["status"] : null,
      };
    });
  const settledReviewSkillsByRevision = new Map<string, Skill[]>();
  for (const row of terminalTasks) {
    const context = row.context as { reason?: unknown; skillAtIssue?: unknown } | null;
    if (context?.reason !== "due-review") continue;
    const inferred: Partial<Record<string, Skill>> = {
      listening: "listening", reading: "reading", reverse_recognition: "reading", speech: "pronunciation",
    };
    const skill = typeof context.skillAtIssue === "string" ? context.skillAtIssue as Skill : inferred[row.exerciseType];
    if (!skill) continue;
    const values = settledReviewSkillsByRevision.get(row.itemRevisionId) ?? [];
    if (!values.includes(skill)) settledReviewSkillsByRevision.set(row.itemRevisionId, [...values, skill]);
  }

  // Etapy już wprowadzone zadaniem w dowolnej sesji dziecka (SPEC §13): pierwsze
  // recall/wymowa nie może czekać na postęp, którego bez tego zadania nie będzie;
  // technicznie nieoceniona próba wymowy nie zapętla wprowadzania.
  const introRows = await tx
    .select({ itemRevisionId: sessionTasks.itemRevisionId, exerciseType: sessionTasks.exerciseType })
    .from(sessionTasks)
    .innerJoin(learningSessions, eq(learningSessions.id, sessionTasks.sessionId))
    .where(
      and(
        eq(learningSessions.childId, session.childId),
        inArray(sessionTasks.itemRevisionId, revisionIds),
        inArray(sessionTasks.exerciseType, ["recall", "speech"]),
      ),
    );
  const introducedByRevision = new Map<string, { recall: boolean; pronunciation: boolean }>();
  for (const row of introRows) {
    const flags = introducedByRevision.get(row.itemRevisionId) ?? { recall: false, pronunciation: false };
    if (row.exerciseType === "recall") flags.recall = true;
    if (row.exerciseType === "speech") flags.pronunciation = true;
    introducedByRevision.set(row.itemRevisionId, flags);
  }
  for (const slot of plannedPrefix) {
    if (slot.reason !== "stage-introduction") continue;
    const flags = introducedByRevision.get(slot.itemRevisionId) ?? { recall: false, pronunciation: false };
    if (slot.exerciseType === "recall") flags.recall = true;
    if (slot.exerciseType === "speech") flags.pronunciation = true;
    introducedByRevision.set(slot.itemRevisionId, flags);
  }

  const candidates: ScheduleCandidate[] = revisions.map((r) => {
    const item = items.get(r.id)!;
    const stats = statsByRevision.get(r.id)!;
    const learning = snapshotByRevision.get(r.id);
    const progress: Partial<Record<Skill, SkillSnapshot>> = {};
    for (const row of progressRows) {
      if (row.itemRevisionId !== r.id || row.status === null) continue;
      progress[row.skill as Skill] = {
        status: mapStatus(row.status),
        nextReviewAt: row.nextReviewAt?.toISOString() ?? null,
        streak: row.streak ?? 0,
      };
    }
    if (learning) {
      for (const [skill, snapshot] of Object.entries(learning.progress) as [Skill, SkillSnapshot][]) {
        progress[skill] = snapshot;
      }
    }
    return {
      itemRevisionId: r.id,
      itemId: r.itemId,
      position: r.position,
      target: item.target,
      source: item.source,
      acceptedAnswers: item.acceptedAnswers,
      targetLocale: item.targetLocale,
      progress,
      // trudności z prawdziwych prób tej sesji (błędy i „Nie pamiętam”)
      failuresThisSession: 0,
      supportedThisSession: stats.supportedThisSession,
      support: supportByRevision.get(r.id),
      work: learning?.work,
      ownPresentationCompleted: learning?.ownPresentationCompleted === true || stats.presentationsThisSession > 0,
      recognitionFallbackUsedThisSession: stats.recognitionFallbackUsedThisSession,
      readingEvidenceDirections: learning?.readingEvidenceDirections ?? {},
      usedThisSession: stats.usedThisSession,
      presentationsThisSession: stats.presentationsThisSession,
      lastContactAt: sessionContext.previousContact[r.itemId] ?? null,
      lastUsedOrdinal: stats.lastUsedOrdinal,
      readingDirections: stats.readingDirections,
      practiceMix: stats.practiceMix,
      pictureListeningCount: stats.pictureListeningCount,
      textListeningCount: stats.textListeningCount,
      introducedSkills: {
        recall: learning?.introducedSkills.recall === true || introducedByRevision.get(r.id)?.recall === true,
        pronunciation: learning?.introducedSkills.pronunciation === true || introducedByRevision.get(r.id)?.pronunciation === true,
      },
      hasBeenPresented: historicallyExposed.has(targetKeysByRevision.get(r.id)!),
      testPreparationIssued: taskRows.some(
        (row) =>
          row.itemRevisionId === r.id &&
          (row.context as { reason?: unknown } | null)?.reason === "test-preparation",
      ),
      settledReviewSkills: settledReviewSkillsByRevision.get(r.id) ?? [],
      ...((item.listeningVisual ?? item.meaningVisual) ? { visual: item.listeningVisual ?? item.meaningVisual } : {}),
    };
  });
  const peers = candidates.map((c) => ({
    itemRevisionId: c.itemRevisionId,
    position: c.position,
    target: c.target,
    source: c.source,
    targetLocale: c.targetLocale,
    acceptedAnswers: c.acceptedAnswers,
    ...(c.visual ? { visual: c.visual } : {}),
  }));

  const plan = selectTask({
    selectionSeed: randomInt(0x1_0000_0000),
    now: now.toISOString(),
    policy,
    microphoneEnabled: session.microphoneEnabled,
    canRead: sessionContext.canRead,
    vocabularyFormat: sessionContext.vocabularyFormat,
    supportsPictureVocabulary: sessionContext.supportsPictureVocabulary,
    supportsPictureRecognition: sessionContext.supportsPictureRecognition,
    assessedRemaining,
    nextOrdinal,
    candidates,
    peers,
    reservedTargetKeys: sessionContext.reservations,
    settledCheckTargetKeys: sessionContext.settledChecks,
    ...(sessionContext.testDate === undefined
      ? {}
      : { testPreparation: { testDate: sessionContext.testDate, timezone: sessionContext.timezone } }),
    recentAssessedReasons,
    recentAssessedTasks,
    confusions: learningSnapshots.flatMap((snapshot) => snapshot.confusions),
  });
  if (!plan) {
    return null;
  }
  return {
    plan,
    item: items.get(plan.itemRevisionId)!,
    audioAssetId: audioByRevision.get(plan.itemRevisionId) ?? null,
    imageAssetId: imageByRevision.get(plan.itemRevisionId) ?? null,
    exampleAudioAssetId: exampleByRevision.get(plan.itemRevisionId) ?? null,
  };
}

/** Trudności poprzednich sesji doboru wsparcia; skip i nieocenione próby nie tworzą błędu. */
async function loadHistoricalSupport(
  tx: Tx,
  childId: string,
  revisionIds: readonly string[],
): Promise<{ tasks: SupportTask[]; attempts: SupportAttempt[] }> {
  if (revisionIds.length === 0) return { tasks: [], attempts: [] };
  const rows = await tx.select({
    id: sessionTasks.id, sessionId: sessionTasks.sessionId, itemRevisionId: sessionTasks.itemRevisionId, exerciseType: sessionTasks.exerciseType,
    state: sessionTasks.state, context: sessionTasks.context, issuedAt: sessionTasks.issuedAt,
  }).from(sessionTasks)
    .innerJoin(learningSessions, eq(learningSessions.id, sessionTasks.sessionId))
    .where(and(eq(learningSessions.childId, childId), inArray(sessionTasks.itemRevisionId, [...revisionIds])))
    .orderBy(asc(sessionTasks.issuedAt), asc(sessionTasks.id));
  if (rows.length === 0) return { tasks: [], attempts: [] };
  const taskIds = rows.map((row) => row.id);
  const graded = await tx.select({
    attemptId: attempts.id, taskId: attempts.taskId, modality: attempts.modality,
    skill: assessments.skill, outcome: assessments.outcome,
  }).from(attempts).leftJoin(assessments, eq(assessments.attemptId, attempts.id))
    .where(inArray(attempts.taskId, taskIds));
  const byAttempt = new Map<string, SupportAttempt>();
  for (const row of graded) {
    const attempt = byAttempt.get(row.attemptId) ?? {
      attemptId: row.attemptId, taskId: row.taskId, modality: row.modality,
      outcomes: [] as { skill: Skill; outcome: "correct" | "incorrect" | "unevaluated" }[],
    };
    if (row.skill !== null && row.outcome !== null) {
      attempt.outcomes = [...attempt.outcomes, {
        skill: row.skill as Skill,
        outcome: row.outcome === "unassessed" ? "unevaluated" : row.outcome as "correct" | "incorrect",
      }];
    }
    byAttempt.set(row.attemptId, attempt);
  }
  return {
    tasks: rows.map((row, ordinal) => {
      const context = row.context as { reason?: string; supportCycleId?: string } | null;
      return {
        taskId: row.id, sessionId: row.sessionId, itemRevisionId: row.itemRevisionId, ordinal,
        exerciseType: row.exerciseType as SupportTask["exerciseType"],
        state: (row.state === "completed" || row.state === "answered" || row.state === "skipped" ? row.state : "issued") as SupportTask["state"],
        reason: context?.reason ?? "", ...(context?.supportCycleId ? { supportCycleId: context.supportCycleId } : {}),
      };
    }),
    attempts: [...byAttempt.values()],
  };
}

/** Plan słówek materializujemy raz w transakcji startu; każde pytanie jest prywatne do chwili wydania. */
async function createTrainingSessionPlan(
  tx: Tx,
  services: Services,
  session: typeof learningSessions.$inferSelect,
  now: Date,
): Promise<TrainingSessionPlanSnapshot> {
  const slots: TrainingSessionSlot[] = [];
  let assessed = 0;
  const maxSlots = session.taskBudget * 2 + 32;
  const planRevisions = await tx.select({ id: itemRevisions.id, payload: itemRevisions.payload }).from(itemRevisions)
    .where(eq(itemRevisions.deckVersionId, session.deckVersionId));
  const revisionIds = planRevisions.map((row) => row.id);
  const historicalSupport = await loadHistoricalSupport(tx, session.childId, revisionIds);
  const planningCache: TrainingPlanPlanningCache = { policy: null, learningSnapshots: null };
  for (let ordinal = 0; assessed < session.taskBudget && ordinal < maxSlots; ordinal += 1) {
    const plannedDueKeys = slots.filter((slot) => slot.reason === "due-check").map((slot) => {
      const revision = planRevisions.find((candidate) => candidate.id === slot.itemRevisionId)!;
      const item = payloadToItem(revision.payload as Record<string, unknown>);
      return computeTargetKey(item.target, item.locales.target);
    });
    const planningSession = slots.length === 0 ? session : {
      ...session,
      context: { ...contextOf(session), reservations: [...slots.at(-1)!.keepsReservations], settledChecks: [...contextOf(session).settledChecks, ...plannedDueKeys] },
    };
    const planned = await planNextTask(tx, planningSession, now, session.taskBudget - assessed, ordinal, slots, historicalSupport, planningCache);
    if (!planned) break;
    const { plan, item, audioAssetId, imageAssetId, exampleAudioAssetId } = planned;
    const materialized = materializeTask(plan, item, audioAssetId, imageAssetId, exampleAudioAssetId);
    const slot: TrainingSessionSlot = {
      taskId: randomUUID(), itemId: item.itemId, itemRevisionId: plan.itemRevisionId, ordinal,
      exerciseType: plan.exerciseType, direction: plan.direction ?? null, assessed: plan.assessed,
      prompt: materialized.prompt, answerKey: materialized.answerKey, reason: plan.reason,
      ...(plan.supportCycleId ? { supportCycleId: plan.supportCycleId } : {}),
      ...(plan.skillAtIssue ? { skillAtIssue: plan.skillAtIssue } : {}),
      ...(plan.statusAtIssue !== undefined ? { statusAtIssue: plan.statusAtIssue } : {}),
      ...(plan.assessmentSkills ? { assessmentSkills: plan.assessmentSkills } : {}),
      revealsTargetKeys: plan.revealsTargetKeys,
      keepsReservations: plan.keepsReservations,
    };
    slots.push(slot);
    if (slot.assessed) assessed += 1;
  }
  if (slots.length === 0) throw new AppError("validation", { message: "Nie udało się przygotować zadań do sesji." });
  return { version: 1, taskBudget: Math.max(1, assessed), slots };
}

/** Tasowanie Fishera–Yatesa; pętla nie wykonuje się dla 0/1 elementów. */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface TaskMaterializationEffects {
  random(): number;
  createOptionId(): string;
}

export function materializeTask(
  plan: TaskPlan,
  item: PlannedItem,
  audioAssetId: string | null,
  imageAssetId: string | null,
  exampleAudioAssetId: string | null,
  effects: TaskMaterializationEffects = { random: Math.random, createOptionId: randomUUID },
): TaskContent {
  // Plan trzyma kanoniczną kolejność (poprawna pierwsza); kolejność prezentacji
  // losujemy raz przy wydaniu zadania, bo wydany prompt jest niezmienny, więc
  // ponowne wyświetlenie tego samego zadania zachowuje układ opcji.
  const plannedOptions = shuffled(plan.options ?? [], effects.random);
  const optionIds = new Map(plannedOptions.map((option) => [option.text, effects.createOptionId()] as const));
  const options = plannedOptions.map((option) => ({ ...option, id: optionIds.get(option.text)! }));
  return buildTaskContent({
    plan,
    item,
    options,
    audioAssetId,
    imageAssetId,
    exampleAudioAssetId,
  });
}

/**
 * Wydanie kolejnego zadania pod blokadą sesji (arch §9.1a): dla issued zwraca
 * to samo zadanie; nowe tworzy dopiero po terminalnym stanie poprzedniego.
 * Ujawnienia treści promptu zapisuje w tej samej transakcji.
 */
export async function nextTask(services: Services, sessionId: string): Promise<TaskDto | null> {
  const id = UuidSchema.parse(sessionId);
  return services.db.transaction(async (tx) => {
    const session = await lockSession(tx, id);
    if (session.state !== "active") {
      return null;
    }
    const now = services.clock.now();
    if (session.mode === "mock_test") {
      const lessonMock = isLessonMockPlan(session.mockTestPlan);
      if (now.getTime() - session.startedAt.getTime() > sessionTimeLimitMs(session.taskBudget)) {
        if (lessonMock) await closeLessonMockTest(tx, services, session);
        else await closeMockTest(tx, services, session, "ended");
        return null;
      }
      const task = lessonMock ? await issueLessonMockTestTask(tx, services, session) : await issueMockTestTask(tx, services, session);
      if (!task) {
        if (lessonMock) await closeLessonMockTest(tx, services, session);
        else await closeMockTest(tx, services, session, "completed");
      }
      return task;
    }

    // Lekcja (zadanie 13): wspólne kroki (blokada, idempotencja wydanego zadania,
    // przeterminowanie, budżet, limit czasu, obietnica „Jeszcze N”) są te same co
    // słówka; różni się tylko plan i materializacja — delegacja do silnika lekcji.
    const isLesson = session.deckKind === "lesson";
    let issuedTask: typeof sessionTasks.$inferSelect | undefined = (
      await tx.select().from(sessionTasks).where(and(eq(sessionTasks.sessionId, id), eq(sessionTasks.state, "issued"))).limit(1)
    )[0];
    if (issuedTask && contextOf(session).microphoneDisabledTaskIds.includes(issuedTask.id)) {
      if (await completeDisabledVoiceTask(tx, id, issuedTask.id) === "skipped") issuedTask = undefined;
    }
    if (isLesson) {
      if (issuedTask) {
        const counts = await lessonTaskCounts(tx, id);
        // Zadanie następcze („Skróć odpowiedź”) nie należy do budżetu, ale pokazuje
        // licznik oryginału (`remainingAssessed` z bieżącym zadaniem): obietnica
        // „Jeszcze N” nie zaczyna się na poprawce przed ostatnimi zadaniami planu.
        const assessedBefore = counts.assessed - (isNonAssessedLessonTaskType(issuedTask.exerciseType) ? 0 : 1);
        const subjectId = (session.lessonContext as { subjectId?: string } | null)?.subjectId;
        const audioAllowed = subjectId ? services.subjects.getSubject(subjectId)?.ttsForAnswers === true : false;
        // Ponowny odczyt nie rzuca na zepsutym planie: liczniki historyjki wtedy bez zmian.
        let plan: LessonTrainingSessionPlanSnapshot | null = null;
        try { plan = readLessonTrainingSessionPlan(session.trainingPlan); } catch { plan = null; }
        return withStoryCounters(issuedTaskDto(session, issuedTask, assessedBefore, audioAllowed), plan);
      }
      const activity = await sessionActivityAndCounts(tx, id, session.startedAt, NON_ASSESSED_LESSON_TASK_TYPES);
      if (now.getTime() - activity.lastActivity.getTime() > RESUME_WINDOW_MS) {
        await tx.update(learningSessions).set({ state: "ended", endedAt: now }).where(eq(learningSessions.id, id));
        return null;
      }
      const counts = activity;
      const remaining = session.taskBudget - counts.assessed;
      // Koniec sesji: budżet albo miękki limit czasu (przy obietnicy „Jeszcze N”
      // dokończone są obiecane zadania). Plan z historyjką wydaje wtedy jej sloty
      // zamiast `null` (design „Historyjka lekcji” §8.2).
      const timeUp = now.getTime() - session.startedAt.getTime() > sessionTimeLimitMs(session.taskBudget) && remaining > PROMISE_REMAINING;
      const closing = remaining <= 0 || timeUp;
      if (session.trainingPlan && "kind" in session.trainingPlan && session.trainingPlan.kind === "lesson") {
        return issueNextLessonPlanTask(tx, session, now, counts, { closing });
      }
      if (closing) return null;
      return issueNextLessonTask(services, tx, session, now, remaining, counts.total);
    }

    const issued = issuedTask;
    if (issued) {
      const counts = await taskCounts(tx, id);
      const assessedBefore =
        counts.assessed - (issued.exerciseType !== "exposure" ? 1 : 0);
      const pending = contextOf(session).microphoneDisabledTaskIds.includes(issued.id)
        ? (await tx.select({ id: attempts.id }).from(attempts).where(and(eq(attempts.taskId, issued.id), eq(attempts.state, "processing"))))[0]
        : undefined;
      return issuedTaskDto(session, issued, assessedBefore, true, pending?.id);
    }

    const activity = await sessionActivityAndCounts(tx, id, session.startedAt);
    if (now.getTime() - activity.lastActivity.getTime() > RESUME_WINDOW_MS) {
      await tx
        .update(learningSessions)
        .set({ state: "ended", endedAt: now })
        .where(eq(learningSessions.id, id));
      return null;
    }

    const counts = activity;
    const remaining = session.taskBudget - counts.assessed;
    if (remaining <= 0) {
      return null;
    }
    // limit czasu tylko między zadaniami; obiecane ostatnie zadania są dokończone
    if (now.getTime() - session.startedAt.getTime() > sessionTimeLimitMs(session.taskBudget) && remaining > PROMISE_REMAINING) {
      return null;
    }

    const storedPlan = session.trainingPlan === null
      ? null
      : (() => {
          try { return readTrainingSessionPlan(session.trainingPlan); }
          catch { throw new AppError("conflict", { message: "Ta sesja wymaga nowszej wersji aplikacji." }); }
        })();
    if (storedPlan !== null) {
      const issued = await issueNextVocabularyPlanTask(
        tx, session, storedPlan, now, counts.total, counts.assessed,
      );
      if (!issued) return null;
      return issuedTaskDto(session, {
        id: issued.slot.taskId,
        ordinal: issued.slot.ordinal,
        exerciseType: issued.slot.exerciseType,
        direction: issued.slot.direction,
        publicPrompt: issued.slot.prompt,
      }, issued.assessedBefore);
    }

    const planned = await planNextTask(tx, session, now, remaining, counts.total);
    if (!planned) {
      return null;
    }
    const { plan, item, audioAssetId, imageAssetId, exampleAudioAssetId } = planned;
    const materialized = materializeTask(plan, item, audioAssetId, imageAssetId, exampleAudioAssetId);
    const taskId = randomUUID();
    const task: VocabularyTaskSnapshot = {
      taskId,
      itemId: item.itemId,
      itemRevisionId: plan.itemRevisionId,
      ordinal: counts.total,
      exerciseType: plan.exerciseType,
      direction: plan.direction ?? null,
      prompt: materialized.prompt,
      answerKey: materialized.answerKey,
      reason: plan.reason,
      revealsTargetKeys: plan.revealsTargetKeys,
      keepsReservations: plan.keepsReservations,
      ...(plan.supportCycleId ? { supportCycleId: plan.supportCycleId } : {}),
      ...(plan.skillAtIssue ? { skillAtIssue: plan.skillAtIssue } : {}),
      ...(plan.statusAtIssue ? { statusAtIssue: plan.statusAtIssue } : {}),
      ...(plan.assessmentSkills ? { assessmentSkills: plan.assessmentSkills } : {}),
    };
    await issueVocabularyTask(tx, session, task, now);
    return issuedTaskDto(session, { exerciseType: plan.exerciseType, direction: plan.direction ?? null, id: taskId, ordinal: counts.total, publicPrompt: materialized.prompt }, counts.assessed);
  });
}

type IssuedShape = {
  id: string;
  ordinal: number;
  exerciseType: string;
  direction: string | null;
  publicPrompt: unknown;
};

function issuedTaskDto(
  session: typeof learningSessions.$inferSelect,
  task: IssuedShape,
  assessedBefore: number,
  audioAllowed = true,
  pendingAttemptId?: string,
): TaskDto {
  // Zachowaj znaczenie snapshotów i dopełnij jedynie brakujące pola kontraktu.
  const storedPrompt = addLegacyTaskPromptDefaults(task.publicPrompt as Record<string, unknown>);
  // Dostępność audio jest bieżącą możliwością przedmiotu. Nie przepisujemy
  // niezmiennego snapshotu zadania ani wcześniejszych ekspozycji.
  const { audioAssetId: _audioAssetId, ...withoutAudio } = storedPrompt;
  const prompt = audioAllowed ? storedPrompt : withoutAudio;
  return {
    taskId: task.id,
    sessionId: session.id,
    ordinal: task.ordinal,
    exerciseType: task.exerciseType as TaskDto["exerciseType"],
    direction: (task.direction ?? null) as TaskDto["direction"],
    state: "issued",
    prompt: prompt as TaskPrompt,
    remainingAssessed: session.taskBudget - assessedBefore,
    ...(pendingAttemptId ? { pendingAttemptId } : {}),
  };
}

/** Parent disables recording for a non-reader session; issued voice work is skipped safely. */
export async function disableSessionMicrophone(services: Services, sessionId: string): Promise<SessionDto> {
  const id = UuidSchema.parse(sessionId);
  return services.db.transaction(async (tx) => {
    const session = await lockSession(tx, id);
    const context = contextOf(session);
    if ((session.mode !== "training") || context.canRead || context.vocabularyFormat !== "picture") {
      throw new AppError("validation");
    }
    if (session.state !== "active") throw new AppError("conflict", { message: "session is not active" });
    if (!session.microphoneEnabled) return sessionDto(tx, session, true);
    const voiceTasks = await tx.select({ id: sessionTasks.id }).from(sessionTasks).where(and(
      eq(sessionTasks.sessionId, id), eq(sessionTasks.state, "issued"),
      inArray(sessionTasks.exerciseType, ["recall", "speech"]),
    ));
    const microphoneDisabledTaskIds = [...new Set([...context.microphoneDisabledTaskIds, ...voiceTasks.map((task) => task.id)])];
    await tx.update(learningSessions).set({
      microphoneEnabled: false,
      context: { ...context, microphoneDisabledTaskIds, reservations: [] } as unknown as Record<string, unknown>,
    }).where(eq(learningSessions.id, id));
    for (const task of voiceTasks) await completeDisabledVoiceTask(tx, id, task.id);
    const fresh = (await tx.select().from(learningSessions).where(eq(learningSessions.id, id)))[0]!;
    return sessionDto(tx, fresh, true);
  });
}

/**
 * Kończy wyłącznie zadanie exposure: issued → completed (arch §9.1a). Nie tworzy
 * próby ani oceny i nie zużywa budżetu; ponowne wywołanie zwraca ten sam rezultat
 * i nie dotyka nowo wydanego zadania.
 */
export async function completePresentation(
  services: Services,
  input: PresentationCompletionInput,
): Promise<PresentationCompletionDto> {
  const valid = PresentationCompletionInputSchema.parse(input);
  return services.db.transaction(async (tx) => {
    const { task, session, itemId } = await lockTaskWithSession(tx, valid.taskId);
    if (session.mode === "daily_round") {
      throw new AppError("conflict", { message: "daily round sessions are retired" });
    }
    if (task.exerciseType !== "exposure" && task.exerciseType !== "lesson_card" && task.exerciseType !== "lesson_story") {
      throw new AppError("validation", { message: "task is not a presentation" });
    }
    if (task.state === "completed") {
      const row = (
        await tx
          .select({ occurredAt: learningEvents.occurredAt })
          .from(learningEvents)
          .where(and(eq(learningEvents.taskId, task.id), eq(learningEvents.kind, "presentation_completed")))
          .limit(1)
      )[0];
      return {
        taskId: task.id,
        state: "completed" as const,
        completedAt: (row?.occurredAt ?? task.issuedAt).toISOString(),
      };
    }
    if (task.state !== "issued") {
      throw new AppError("conflict", { message: "presentation task is not issued" });
    }
    const now = services.clock.now();
    await tx.update(sessionTasks).set({ state: "completed" }).where(eq(sessionTasks.id, task.id));
    await writeSealedEvent(tx, {
      childId: task.childId,
      taskId: task.id,
      itemId,
      kind: "presentation_completed",
      stepId: `${task.id}:done`,
      occurredAt: now,
      ...(valid.clientCommandId ? { clientEventId: valid.clientCommandId } : {}),
      exposures: [],
    });
    return { taskId: task.id, state: "completed" as const, completedAt: now.toISOString() };
  });
}

/**
 * Jawny koniec z podsumowaniem; idempotentny dla sesji już zakończonej.
 * Opcjonalny raport aktywności (zebrany lokalnie przez FE) uruchamia JEDNĄ
 * ocenę poza transakcją zamknięcia wiedzy; wynik/błąd zwracany jest w polu
 * `activity` bez wpisywania punktów do zamrożonego raportu wiedzy.
 */
export async function endSession(
  services: Services,
  sessionId: string,
  activityReport?: SessionActivityReport,
): Promise<SessionSummaryDto> {
  const summary = await closeSessionKnowledge(services, sessionId);
  if (activityReport !== undefined) {
    const result = await beginSessionActivityReview(services, sessionId, activityReport);
    return { ...summary, activity: result };
  }
  const stored = await readSessionActivityResult(services, sessionId);
  return stored === null ? summary : { ...summary, activity: stored };
}

async function closeSessionKnowledge(services: Services, sessionId: string): Promise<SessionSummaryDto> {
  const id = UuidSchema.parse(sessionId);
  return services.db.transaction(async (tx) => {
    const session = await lockSession(tx, id);
    let state = session.state as "active" | "completed" | "ended";
    if (session.mode === "mock_test") {
      if (isLessonMockPlan(session.mockTestPlan)) {
        // Kartkówka lekcji: zamknięcie wspólną ścieżką lekcji (raport per cel do
        // kontekstu); podsumowanie sesji ma kształt słówkowy z zerowymi licznikami
        // (omówienie i wynik idą przez endpoint mock-test-summary, nie endSession).
        const report = await closeLessonMockTest(tx, services, session);
        const counts = await taskCounts(tx, id);
        const fresh = (await tx.select().from(learningSessions).where(eq(learningSessions.id, id)))[0]!;
        return {
          sessionId: id,
          state: report.complete ? "completed" : "ended",
          tasksIssued: counts.total,
          assessedTasksIssued: counts.assessed,
          endedAt: (fresh.endedAt ?? services.clock.now()).toISOString(),
          independentSuccesses: { recall: 0, spelling: 0 },
          practiceItems: [],
        };
      }
      const report = await closeMockTest(tx, services, session, "completed");
      const counts = await taskCounts(tx, id);
      const summaryRows = await tx.select({ itemRevisionId: assessments.itemRevisionId, skill: assessments.skill }).from(assessments)
        .innerJoin(attempts, eq(attempts.id, assessments.attemptId)).innerJoin(sessionTasks, eq(sessionTasks.id, attempts.taskId))
        .where(and(eq(sessionTasks.sessionId, id), eq(assessments.independent, true), eq(assessments.outcome, "correct")));
      return { sessionId: id, state: report.state, tasksIssued: counts.total, assessedTasksIssued: counts.assessed, endedAt: report.endedAt,
        independentSuccesses: { recall: new Set(summaryRows.filter(r => r.skill === "recall").map(r => r.itemRevisionId)).size,
          spelling: new Set(summaryRows.filter(r => r.skill === "spelling").map(r => r.itemRevisionId)).size }, practiceItems: [] };
    }
    let endedAt = session.endedAt;
    if (state === "active") {
      endedAt = services.clock.now();
      state = "completed";
      await tx
        .update(learningSessions)
        .set({ state, endedAt })
        .where(eq(learningSessions.id, id));
    }
    const counts = await taskCounts(tx, id);
    const saved = SessionSummaryDtoSchema.safeParse(session.context.summary);
    const isLesson = session.deckKind === "lesson";
    const rows = saved.success ? [] : await tx
      .select({
        itemId: itemRevisions.itemId, payload: itemRevisions.payload,
        skill: assessments.skill, outcome: assessments.outcome, independent: assessments.independent,
      })
      .from(assessments)
      .innerJoin(attempts, eq(attempts.id, assessments.attemptId))
      .innerJoin(sessionTasks, eq(sessionTasks.id, attempts.taskId))
      .innerJoin(itemRevisions, eq(itemRevisions.id, assessments.itemRevisionId))
      .where(and(eq(sessionTasks.sessionId, id), eq(attempts.state, "completed")))
      .orderBy(asc(attempts.receivedAt), asc(sessionTasks.ordinal), asc(attempts.attemptNumber));
    // Lekcja (req 7.7): podsumowanie per cel. Wartości słówkowe (recall/spelling)
    // są puste — `summarizeSessionAssessments` ignoruje skill `objective` — więc
    // bezpiecznie dołączamy `objectives` do tego samego kształtu DTO.
    const lessonObjectives = saved.success || !isLesson ? undefined : await buildLessonSummaryObjectives(services, tx, id);
    const summary: SessionSummaryDto = saved.success ? saved.data : {
      sessionId: id,
      state,
      tasksIssued: counts.total,
      assessedTasksIssued: counts.assessed,
      endedAt: endedAt!.toISOString(),
      ...summarizeSessionAssessments(rows.map(row => ({ ...row, target: payloadToItem(row.payload).target }))),
      ...(lessonObjectives ? { objectives: lessonObjectives } : {}),
    };
    if (!saved.success) {
      await tx.update(learningSessions)
        .set({ context: { ...session.context, summary } })
        .where(eq(learningSessions.id, id));
    }
    // Lista pokazuje wzorce także przy ponownym odczycie. Każda odpowiedź
    // ma nową, zamkniętą ekspozycję; snapshot wyników pozostaje ten sam.
    if (summary.practiceItems.length > 0) {
      const items = await tx.select({ taskId: sessionTasks.id, itemId: itemRevisions.itemId, payload: itemRevisions.payload })
        .from(sessionTasks)
        .innerJoin(itemRevisions, eq(itemRevisions.id, sessionTasks.itemRevisionId))
        .where(and(eq(sessionTasks.sessionId, id), inArray(itemRevisions.itemId, summary.practiceItems.map(item => item.itemId))))
        .orderBy(asc(sessionTasks.ordinal));
      const disclosed = new Set<string>();
      for (const item of items) {
        if (disclosed.has(item.itemId)) continue;
        disclosed.add(item.itemId);
        const vocabulary = payloadToItem(item.payload);
        await writeSealedEvent(tx, {
          childId: session.childId, taskId: item.taskId, itemId: item.itemId,
          kind: "feedback_issued", stepId: `${id}:summary:${item.itemId}`,
          occurredAt: services.clock.now(),
          exposures: [computeTargetKey(vocabulary.target, vocabulary.locales.target)],
        });
      }
    }
    return summary;
  });
}
