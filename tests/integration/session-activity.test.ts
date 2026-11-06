import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completePresentation,
  createChild,
  createDraft,
  createServices,
  endSession,
  fakeSessionActivityDeps,
  FakeSessionActivityReviewer,
  type FakeSessionActivityBehavior,
  listKidProfiles,
  nextTask,
  publishDraft,
  readSessionActivityResult,
  readParentWorkCard,
  reviewSessionActivity,
  cleanupExpiredActivityReports,
  startSession,
  submitAttempt,
  upsertAssignment,
  type Services,
} from "@learning/server";
import type { SessionActivityReport } from "@learning/contracts";
import { ApiErrorSchema, SESSION_ACTIVITY_REPORT_MAX_BYTES } from "@learning/contracts";
import { createKidApiClient } from "../../packages/kid-ui/src/api/client";
import { AppError } from "../../packages/server/src/errors";
import { createOpenAiCompatibleSessionActivityReviewer } from "../../packages/server/src/providers/openai-compatible/session-activity";
import { materializeExercise, type LoadedExercise } from "../../packages/server/src/modules/learning/lessons/lesson-materialize";
import { englishGrammarSubject } from "../../packages/server/src/domain/lessons/subjects/english-grammar/module";
import { buildTestServices, handleKidApi, testDatabase, truncateCoreTables } from "./helpers";

const { pool } = testDatabase();
afterAll(() => pool.end());

/**
 * Ocena aktywności sesji na prawdziwym PostgreSQL (spec client-reward-time):
 * raport FE → zapis przed oceną → jedno wywołanie fake reviewera → punkty.
 * Zastępuje dawne regresje reward-activity/client/regressions.
 */

const DAY_ITEMS: { source: string; target: string }[] = [
  { source: "poniedziałek", target: "Monday" },
  { source: "wtorek", target: "Tuesday" },
  { source: "środa", target: "Wednesday" },
];

function vocabItem(pair: { source: string; target: string }) {
  return {
    source: pair.source,
    target: pair.target,
    acceptedAnswers: [],
    locales: { source: "pl-PL", target: "en-GB" },
    visualType: "color" as const,
    visualData: { color: "#4169e1" },
  };
}

async function publishDeck(services: Services, childId: string) {
  const draft = await createDraft(services, { title: "Aktywność sesji", items: DAY_ITEMS.map(vocabItem) });
  for (const index of DAY_ITEMS.keys()) {
    const revision = (await pool.query<{ id: string }>(
      "select id from learning_app.item_revisions where deck_version_id=$1 order by position offset $2 limit 1",
      [draft.id, index],
    )).rows[0]!;
    const assetId = randomUUID();
    const fingerprint = `fp-${randomUUID()}`;
    await pool.query(`insert into learning_app.media_assets
      (id,kind,fingerprint,generation_number,state,storage_key,content_sha256,mime_type,byte_count,provider,model,metadata)
      values ($1,'tts',$2,1,'ready',$3,$4,'audio/mpeg',1024,'fake','fake-tts','{"durationMs":20000}'::jsonb)`,
    [assetId, fingerprint, `blob/${assetId}`, `sha-${assetId}`]);
    await pool.query(`insert into learning_app.revision_assets
      (item_revision_id,role,asset_id,expected_fingerprint,state) values ($1,'target_audio',$2,$3,'approved')`,
    [revision.id, assetId, fingerprint]);
    await pool.query(`insert into learning_app.revision_assets
      (item_revision_id,role,asset_id,expected_fingerprint,state) values ($1,'illustration',null,$2,'omitted')`,
    [revision.id, `ill-${randomUUID()}`]);
  }
  await publishDraft(services, draft.id, 1);
  await upsertAssignment(services, childId, draft.deckId, null);
  return draft.deckId;
}

interface TaskActivity {
  taskId: string;
  exerciseType: string;
  intervals: [number, number][];
  edits: number;
  attempts: string[];
}

function reportOf(tasks: TaskActivity[], elapsedMs: number): SessionActivityReport {
  const activeMs = tasks.reduce((total, task) => {
    const union = [...task.intervals].sort((a, b) => a[0] - b[0]);
    let sum = 0;
    let lastEnd = -1;
    for (const [from, to] of union) {
      const start = Math.max(from, lastEnd);
      if (to > start) {
        sum += to - start;
        lastEnd = to;
      }
    }
    return total + sum;
  }, 0);
  let cursor = 0;
  return {
    version: 1,
    elapsedMs,
    activeMs,
    compacted: false,
    tasks: tasks.map((task) => {
      const shownFrom = cursor;
      cursor = Math.min(elapsedMs, task.intervals.at(-1)?.[1] ?? shownFrom + 1_000);
      return {
        taskId: task.taskId,
        exerciseType: task.exerciseType,
        shownFromMs: shownFrom,
        shownToMs: cursor,
        activeIntervals: task.intervals,
        editCount: task.edits,
        editWindows: task.edits > 0 ? [{ atMs: task.intervals[0]?.[0] ?? 0, count: task.edits }] : [],
        submittedAttempts: task.attempts,
        playbacks: [],
        pauses: [],
      };
    }),
  };
}

async function reviewerServices(startIso?: string, behaviors?: FakeSessionActivityBehavior[]) {
  const base = buildTestServices(startIso);
  const provider = new FakeSessionActivityReviewer();
  if (behaviors) provider.queue(...behaviors);
  const services = createServices({
    db: base.services.db,
    clock: base.clock,
    sessionActivity: fakeSessionActivityDeps({ provider }),
  });
  return { services, clock: base.clock, provider };
}

async function reviewEndedSession(services: Services, sessionId: string, report: SessionActivityReport) {
  await endSession(services, sessionId);
  return reviewSessionActivity(services, sessionId, report);
}

/** Limit recenzenta w teście „odpowiedź przed oceną modelu” (wyścig czeka połowę). */
const REVIEWER_TIMEOUT_MS = 20_000;

async function waitForActivityResult(services: Services, sessionId: string) {
  // Limit zegarowy z zapasem: przy równoległych workerach integracji 20 × 10 ms nie wystarczało.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await readSessionActivityResult(services, sessionId);
    if (result !== null && result.status !== "already_started") return result;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("activity review did not finish in time");
}

/** Pełna sesja treningowa: prezentacje + dwa zadania oceniane, jedna odpowiedź. */
async function playedSession(services: Services, childId: string) {
  const deckId = await publishDeck(services, childId);
  const session = await startSession(services, { childId, deckId, microphoneEnabled: false });
  const tasks: Awaited<ReturnType<typeof nextTask>>[] = [];
  let attemptIds: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const task = await nextTask(services, session.sessionId);
    if (task === null) break;
    if (task.exerciseType === "exposure" || task.exerciseType === "lesson_card") {
      await completePresentation(services, { taskId: task.taskId });
      continue;
    }
    if (tasks.length === 0) {
      const attempt = await submitAttempt(services, {
        taskId: task.taskId, clientAttemptId: randomUUID(), modality: "dont_remember",
      });
      attemptIds = [attempt.attemptId];
    }
    tasks.push(task);
    if (tasks.length === 2) break;
  }
  expect(tasks).toHaveLength(2);
  return { session, tasks: [tasks[0]!, tasks[1]!], attemptIds };
}

async function childWithProfile(services: Services) {
  return createChild(services, { displayName: "Ola", avatarKey: "fox" });
}

async function rewardPointsOf(childId: string): Promise<{ points: number; remainder: number }> {
  const row = (await pool.query("select reward_points, reward_remainder_ms from learning_app.child_profiles where id=$1", [childId])).rows[0]!;
  return { points: row.reward_points as number, remainder: row.reward_remainder_ms as number };
}

beforeEach(async () => {
  await truncateCoreTables();
  await pool.query("update learning_app.family_settings set timezone='Europe/Warsaw'");
});

describe("session activity review", () => {
  it("sends lesson order/gap prompts and canonical answers to the reviewer", async () => {
    const { services, clock, provider } = await reviewerServices("2026-10-16T10:00:00.000Z");
    const child = await childWithProfile(services);
    const { session } = await playedSession(services, child.id);
    const subject = englishGrammarSubject;
    const topic = subject.topics[0]!;
    const loaded = (payload: LoadedExercise["payload"]): LoadedExercise => ({ revisionId: randomUUID(), itemId: randomUUID(), position: 0, payload, targetKey: "test-target", audioAssetId: null });
    const ordered = materializeExercise({ independentCheck: false, reason: "practice" }, randomUUID(), loaded({
      exerciseType: "lesson_order", objectiveId: "english_grammar.present_simple.third_person_s", instructionPl: "Ułóż zdanie",
      items: [{ id: "first", text: "She" }, { id: "second", text: "reads" }, { id: "third", text: "books" }],
      answer: "She reads books", acceptedAnswers: [], focus: ["reads"], answerLocale: "en-GB", promptLocale: "pl-PL",
    }), topic, subject);
    const firstItems = Array.isArray(ordered.answerKey.itemIds)
      ? ordered.answerKey.itemIds.filter((id): id is string => typeof id === "string")
      : [];
    const gap = materializeExercise({ independentCheck: false, reason: "practice" }, randomUUID(), loaded({
      exerciseType: "lesson_gap", objectiveId: "english_grammar.present_simple.third_person_s", instructionPl: "Uzupełnij lukę",
      stem: "She ___ books", answer: "reads", acceptedAnswers: [], focus: ["reads"], answerLocale: "en-GB", promptLocale: "pl-PL",
    }), topic, subject);
    const base = (await pool.query("select child_id,deck_version_id,item_revision_id,(select coalesce(max(ordinal),-1)+1 from learning_app.session_tasks where session_id=$1) as ordinal from learning_app.session_tasks where session_id=$1 limit 1", [session.sessionId])).rows[0]!;
    const lessonTaskIds = [randomUUID(), randomUUID()];
    for (const [index, materialized] of [ordered, gap].entries()) {
      await pool.query(`insert into learning_app.session_tasks
        (id,session_id,child_id,deck_version_id,item_revision_id,ordinal,exercise_type,state,public_prompt,answer_key,context,issued_at)
        values ($1,$2,$3,$4,$5,$6,$7,'answered',$8::jsonb,$9::jsonb,'{}'::jsonb,$10)`, [
        lessonTaskIds[index], session.sessionId, base.child_id, base.deck_version_id, base.item_revision_id, Number(base.ordinal) + index,
        materialized.exerciseType, JSON.stringify(materialized.prompt), JSON.stringify(materialized.answerKey), clock.now(),
      ]);
    }
    const sequenceAttemptId = randomUUID();
    await pool.query(`insert into learning_app.attempts
      (id,child_id,task_id,item_revision_id,client_attempt_id,request_hash,attempt_number,modality,state,answer,context,policy_id,received_at,completed_at)
      values ($1,$2,$3,$4,$5,$6,1,'sequence','completed',$7::jsonb,'{}'::jsonb,'learning-v2',$8,$8)`, [
      sequenceAttemptId, base.child_id, lessonTaskIds[0], base.item_revision_id, randomUUID(), randomUUID(), JSON.stringify({ itemIds: firstItems }), clock.now(),
    ]);
    clock.advanceMs(30_000);
    await reviewEndedSession(services, session.sessionId, reportOf([
      { taskId: lessonTaskIds[0]!, exerciseType: "lesson_order", intervals: [[0, 15_000]], edits: 2, attempts: [sequenceAttemptId] },
      { taskId: lessonTaskIds[1]!, exerciseType: "lesson_gap", intervals: [[15_000, 30_000]], edits: 1, attempts: [] },
    ], 30_000));
    expect(provider.requests[0]!.tasks[0]).toMatchObject({ instruction: "Ułóż zdanie", acceptedAnswers: ["She reads books"], submittedAnswers: [{ modality: "sequence", text: "She reads books" }] });
    expect(provider.requests[0]!.tasks[0]!.options).toEqual(expect.arrayContaining(["She", "reads", "books"]));
    expect(provider.requests[0]!.tasks[1]).toMatchObject({ instruction: "Uzupełnij lukę", stimulus: "She ___ books", acceptedAnswers: ["reads"] });
  });

  it("awards points from the measured time of tasks the model did not exclude", async () => {
    const { services, clock, provider } = await reviewerServices("2026-10-16T10:00:00.000Z");
    const child = await childWithProfile(services);
    const { session, tasks, attemptIds } = await playedSession(services, child.id);
    clock.advanceMs(90_000);
    const report = reportOf([
      { taskId: tasks[0]!.taskId, exerciseType: tasks[0]!.exerciseType, intervals: [[0, 65_000]], edits: 5, attempts: attemptIds },
      { taskId: tasks[1]!.taskId, exerciseType: tasks[1]!.exerciseType, intervals: [[65_000, 90_000]], edits: 2, attempts: [] },
    ], 90_000);
    const activity = await reviewEndedSession(services, session.sessionId, report);
    expect(activity).toMatchObject({ status: "evaluated", pointsAwarded: 1 });
    // Kształt payloadu do modelu: wyłącznie dozwolone pola, bez identyfikatorów
    // dziecka/sesji; odpowiedzi bez attemptId/receivedAt, tekst przycięty ≤200.
    const payload = provider.requests[0]!;
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(child.id);
    expect(serialized).not.toContain(session.sessionId);
    for (const task of payload.tasks) {
      expect(Object.keys(task).sort()).toEqual(["acceptedAnswers", "activeIntervals", "editCount", "editWindows", "instruction", "options", "pauses", "playbacks", "stimulus", "submittedAnswers", "taskOrdinal"]);
      for (const answer of task.submittedAnswers) {
        expect(Object.keys(answer).sort()).toEqual(["modality", "supportDisclosedBefore", "text", "uncertain"]);
        if (answer.text !== null) expect(answer.text.length).toBeLessThanOrEqual(200);
      }
    }
    expect(await rewardPointsOf(child.id)).toEqual({ points: 1, remainder: 30_000 });
    const review = (await pool.query("select activity_review from learning_app.learning_sessions where id=$1", [session.sessionId])).rows[0].activity_review;
    expect(review.approvedMilliseconds).toBe(90_000);
    expect(review.durationSeconds).toBe(90);
    expect(review.reason).toBe("Ocena aktywności: zaliczono pracę w 2 zadaniach.");
  });

  it("caps the awarded time at the server-measured session duration (#305)", async () => {
    const { services, clock } = await reviewerServices("2026-10-16T10:00:00.000Z");
    const child = await childWithProfile(services);
    const { session, tasks, attemptIds } = await playedSession(services, child.id);
    clock.advanceMs(90_000);
    // Klient twierdzi, że sesja trwała godzinę, a serwer zna 90 s.
    const report = reportOf([
      { taskId: tasks[0]!.taskId, exerciseType: tasks[0]!.exerciseType, intervals: [[0, 3_600_000]], edits: 5, attempts: attemptIds },
    ], 3_600_000);
    const activity = await reviewEndedSession(services, session.sessionId, report);
    expect(activity).toMatchObject({ status: "evaluated", pointsAwarded: 1 });
    expect(await rewardPointsOf(child.id)).toEqual({ points: 1, remainder: 30_000 });
    const review = (await pool.query("select activity_review from learning_app.learning_sessions where id=$1", [session.sessionId])).rows[0].activity_review;
    expect(review).toMatchObject({ durationSeconds: 90, activeSeconds: 90, approvedMilliseconds: 90_000, approvedSeconds: 90 });
  });

  it("returns the session summary after accepting the report while the reviewer is still pending", async () => {
    const base = buildTestServices("2026-10-16T10:00:00.000Z");
    let releaseReview: () => void = () => {};
    const reviewerGate = new Promise<void>((resolve) => { releaseReview = resolve; });
    let markReviewerSettled: () => void = () => {};
    const reviewerSettled = new Promise<void>((resolve) => { markReviewerSettled = resolve; });
    let calls = 0;
    const services = createServices({
      db: base.services.db,
      clock: base.clock,
      sessionActivity: {
        timeoutMs: REVIEWER_TIMEOUT_MS,
        provider: {
          name: "pending-reviewer",
          model: "pending-reviewer-v1",
          promptVersion: "pending-reviewer-v1",
          async review() {
            calls += 1;
            await reviewerGate;
            markReviewerSettled();
            return { reason: "Potwierdzona aktywność.", excludedTasks: [] };
          },
        },
      },
    });
    const child = await childWithProfile(services);
    const { session, tasks } = await playedSession(services, child.id);
    base.clock.advanceMs(60_000);
    const report = reportOf([
      { taskId: tasks[0]!.taskId, exerciseType: tasks[0]!.exerciseType, intervals: [[0, 60_000]], edits: 1, attempts: [] },
    ], 60_000);

    const ending = endSession(services, session.sessionId, report);
    try {
      const summaryReturnedBeforeReviewer = await Promise.race([
        ending.then(() => true),
        // Pozostaw margines dla wolniejszego PostgreSQL CI i równoległych workerów
        // integracji; reviewerGate pozostaje zamknięty, więc poprawna odpowiedź
        // musi nadal wrócić przed oceną modelu. Limit wyścigu musi być krótszy
        // od limitu recenzenta — inaczej czekająca implementacja wróciłaby po
        // przerwaniu recenzji i przeszła.
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), REVIEWER_TIMEOUT_MS / 2)),
      ]);

      expect(summaryReturnedBeforeReviewer).toBe(true);
      const summary = await ending;
      expect(summary.activity).toEqual({ status: "already_started", pointsAwarded: 0, errorCode: null });
      const stored = (await pool.query("select activity_report_hash is not null as accepted from learning_app.learning_sessions where id=$1", [session.sessionId])).rows[0]!;
      expect(stored.accepted).toBe(true);
      expect(calls).toBe(1);
    } finally {
      releaseReview();
      await ending;
      await reviewerSettled;
      await expect(waitForActivityResult(services, session.sessionId)).resolves.toMatchObject({ status: "evaluated" });
    }
  });

  it("counts only FE-reported reviewer tasks and accepts exclusions for an included presentation", async () => {
    const { services, clock, provider } = await reviewerServices("2026-10-16T10:00:00.000Z");
    const child = await childWithProfile(services);
    const { session, tasks } = await playedSession(services, child.id);
    const presentation = (await pool.query<{ id: string; ordinal: number }>(
      "select id, ordinal from learning_app.session_tasks where session_id=$1 and exercise_type in ('exposure','lesson_card') order by ordinal limit 1", [session.sessionId],
    )).rows[0]!;
    provider.queue({ raw: { reason: "Prezentacja wyłączona.", excludedTasks: [{ taskOrdinal: presentation.ordinal, reason: "Bez odpowiedzi." }] } });
    clock.advanceMs(15_000);
    const activity = await reviewEndedSession(services, session.sessionId, reportOf([
      { taskId: presentation.id, exerciseType: "exposure", intervals: [[0, 5_000]], edits: 0, attempts: [] },
      { taskId: tasks[0]!.taskId, exerciseType: tasks[0]!.exerciseType, intervals: [[5_000, 15_000]], edits: 1, attempts: [] },
    ], 15_000));
    expect(provider.requests[0]!.tasks).toHaveLength(2);
    expect(activity).toMatchObject({ status: "evaluated" });
    const savedReview = (await pool.query("select activity_review from learning_app.learning_sessions where id=$1", [session.sessionId])).rows[0]!.activity_review;
    expect(savedReview.approvedMilliseconds).toBe(10_000);
    const card = await readParentWorkCard(services, { childId: child.id });
    expect(card.sessions[0]!.activity.reason).toBe("Ocena aktywności: zaliczono pracę w 1 z 2 zadań; 1 wykluczono.");
  });

  it("excludes only the tasks the model listed and keeps their time out of the award", async () => {
    const { services, clock, provider } = await reviewerServices("2026-10-16T10:00:00.000Z");
    const child = await childWithProfile(services);
    const { session, tasks, attemptIds } = await playedSession(services, child.id);
    const firstOrdinal = (await pool.query<{ ordinal: number }>("select ordinal from learning_app.session_tasks where id=$1", [tasks[0]!.taskId])).rows[0]!.ordinal;
    provider.queue({ raw: {
      reason: "Jedno zadanie bez rzeczywistej próby.",
      excludedTasks: [{ taskOrdinal: firstOrdinal, reason: "Jedyna próba to aaa." }],
    } });
    clock.advanceMs(90_000);
    const report = reportOf([
      { taskId: tasks[0]!.taskId, exerciseType: tasks[0]!.exerciseType, intervals: [[0, 65_000]], edits: 0, attempts: attemptIds },
      { taskId: tasks[1]!.taskId, exerciseType: tasks[1]!.exerciseType, intervals: [[65_000, 90_000]], edits: 2, attempts: [] },
    ], 90_000);
    const activity = await reviewEndedSession(services, session.sessionId, report);
    expect(activity).toMatchObject({ status: "evaluated", pointsAwarded: 0 });
    expect(await rewardPointsOf(child.id)).toEqual({ points: 0, remainder: 25_000 });
    expect(provider.callCount).toBe(1);
    const workCard = await readParentWorkCard(services, { childId: child.id });
    expect(workCard.creditedSeconds).toBe(25);
    expect(workCard.sessions[0]!.activity.excludedTasks).toEqual([{ taskOrdinal: firstOrdinal, reason: "Jedyna próba to aaa." }]);
    expect(workCard.sessions[0]!.activity.reason).toBe("Ocena aktywności: zaliczono pracę w 1 z 2 zadań; 1 wykluczono.");
    expect(workCard.sessions[0]!.activity.details?.tasks[0]).toMatchObject({ instruction: expect.any(String), acceptedAnswers: expect.any(Array), submittedAnswers: expect.any(Array), activeMilliseconds: expect.any(Number) });
    expect(workCard.reviewService).toBeNull();
  });

  it("keeps a model-quoted child answer only in the expiring report details", async () => {
    const { services, clock, provider } = await reviewerServices("2026-10-16T10:00:00.000Z");
    const child = await childWithProfile(services);
    const { session, tasks, attemptIds } = await playedSession(services, child.id);
    const reportedOrdinal = (await pool.query<{ ordinal: number }>("select ordinal from learning_app.session_tasks where id=$1", [tasks[0]!.taskId])).rows[0]!.ordinal;
    provider.queue({ raw: { reason: "Dziecko wpisało \"private-answer\".", excludedTasks: [{ taskOrdinal: reportedOrdinal, reason: "Odpowiedź private-answer nie pasowała." }] } });
    clock.advanceMs(60_000);
    await reviewEndedSession(services, session.sessionId, reportOf([
      { taskId: tasks[0]!.taskId, exerciseType: tasks[0]!.exerciseType, intervals: [[0, 60_000]], edits: 2, attempts: attemptIds },
    ], 60_000));
    const row = (await pool.query("select activity_review, activity_report from learning_app.learning_sessions where id=$1", [session.sessionId])).rows[0]!;
    expect(row.activity_review.reason).toBe("Ocena aktywności: zaliczono pracę w 0 z 1 zadań; 1 wykluczono.");
    expect(JSON.stringify(row.activity_report)).toContain("private-answer");
    const beforeCleanup = await readParentWorkCard(services, { childId: child.id });
    expect(JSON.stringify(beforeCleanup.sessions[0]!.activity.details)).toContain("private-answer");
    await pool.query("update learning_app.learning_sessions set activity_report_expires_at=$2 where id=$1", [session.sessionId, new Date(clock.now().getTime() - 1)]);
    await cleanupExpiredActivityReports(services);
    const afterCleanup = await readParentWorkCard(services, { childId: child.id });
    expect(afterCleanup.sessions[0]!.activity.details).toBeNull();
    expect(afterCleanup.sessions[0]!.activity.reason).not.toContain("private-answer");
  });

  it("rejects a foreign task id instead of reading another child's data", async () => {
    const { services } = await reviewerServices();
    const child = await childWithProfile(services);
    const { session } = await playedSession(services, child.id);
    const report = reportOf([
      { taskId: randomUUID(), exerciseType: "recall", intervals: [[0, 10_000]], edits: 0, attempts: [] },
    ], 10_000);
    await expect(reviewSessionActivity(services, session.sessionId, report)).rejects.toMatchObject({ code: "validation" });
  });

  it("keeps the report and records an error when the model is not configured (no points, no queue)", async () => {
    const { services, clock } = buildTestServices("2026-10-16T10:00:00.000Z");
    const child = await childWithProfile(services);
    const { session, tasks } = await playedSession(services, child.id);
    clock.advanceMs(60_000);
    const activity = await reviewEndedSession(services, session.sessionId, reportOf([
      { taskId: tasks[0]!.taskId, exerciseType: tasks[0]!.exerciseType, intervals: [[0, 60_000]], edits: 1, attempts: [] },
    ], 60_000));
    expect(activity).toMatchObject({ status: "error", pointsAwarded: 0, errorCode: "model_not_configured" });
    expect(await rewardPointsOf(child.id)).toEqual({ points: 0, remainder: 0 });
    // Raport pozostaje zapisany wraz z kodem błędu (szczegóły do retencji).
    const stored = (await pool.query("select activity_report, activity_report_hash is not null as hashed from learning_app.learning_sessions where id=$1", [session.sessionId])).rows[0]!;
    expect(stored.activity_report.errorCode).toBe("model_not_configured");
    expect(stored.hashed).toBe(true);
  });

  it.each(["timeout", "http_error", "provider_error", "unknown_task_ordinal", "duplicate_task_ordinal"])("logs safe diagnostics for %s", async (failureKind) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const base = buildTestServices("2026-10-16T10:00:00.000Z");
      const provider = new FakeSessionActivityReviewer();
      if (failureKind === "timeout") provider.queue({ raw: {}, delayMs: 30_000 });
      if (failureKind === "provider_error") provider.queue({ error: "private-child-answer secret-token" });
      if (failureKind.endsWith("task_ordinal")) {
        provider.review = async ({ tasks }) => ({ reason: "ok", excludedTasks: failureKind === "unknown_task_ordinal"
          ? [{ taskOrdinal: 999_999, reason: "private-child-answer" }]
          : [0, 1].map(() => ({ taskOrdinal: tasks[0]!.taskOrdinal, reason: "private-child-answer" })) });
      }
      const httpProvider = createOpenAiCompatibleSessionActivityReviewer({
        baseUrl: "https://test.invalid/v1", apiKey: "secret-token", model: "fake",
        fetchImpl: async () => new Response("private-child-answer secret-token", { status: 429 }),
      });
      const services = createServices({ db: base.services.db, clock: base.clock, sessionActivity: {
        provider: failureKind === "http_error" ? httpProvider : provider, timeoutMs: 10,
      } });
      const child = await childWithProfile(services);
      const { session, tasks } = await playedSession(services, child.id);
      base.clock.advanceMs(60_000);
      const report = reportOf([{ taskId: tasks[0]!.taskId, exerciseType: tasks[0]!.exerciseType, intervals: [[0, 60_000]], edits: 1, attempts: [] }], 60_000);
      const errorCode = failureKind === "timeout" ? "model_timeout" : failureKind.endsWith("task_ordinal") ? "invalid_verdict" : "model_failed";
      expect(await reviewEndedSession(services, session.sessionId, report)).toMatchObject({ errorCode, pointsAwarded: 0 });
      expect(log).toHaveBeenCalledWith("[session-activity] ocena nie powiodła się", expect.objectContaining({
        sessionId: session.sessionId, errorCode, failureKind, taskCount: 1, timeoutMs: 10,
        ...(failureKind === "http_error" ? { httpStatus: 429 } : {}),
      }));
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-child-answer|secret-token/);
      expect(await rewardPointsOf(child.id)).toEqual({ points: 0, remainder: 0 });
    } finally { log.mockRestore(); }
  });

  it("logs schema failure codes without raw values and does not log again on delivery retry", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { services, clock, provider } = await reviewerServices("2026-10-16T10:00:00.000Z", [
        { raw: { reason: "private-child-answer", excludedTasks: [], "secret-token": 120 } },
      ]);
      const child = await childWithProfile(services);
      const { session, tasks } = await playedSession(services, child.id);
      clock.advanceMs(60_000);
      const report = reportOf([
        { taskId: tasks[0]!.taskId, exerciseType: tasks[0]!.exerciseType, intervals: [[0, 60_000]], edits: 1, attempts: [] },
      ], 60_000);
      expect(await reviewEndedSession(services, session.sessionId, report)).toMatchObject({ errorCode: "invalid_verdict", pointsAwarded: 0 });
      expect(log).toHaveBeenCalledWith("[session-activity] ocena nie powiodła się", expect.objectContaining({
        sessionId: session.sessionId, errorCode: "invalid_verdict", failureKind: "schema_validation",
        validationCodes: ["unrecognized_keys"], taskCount: 1, timeoutMs: 20_000, elapsedMs: expect.any(Number),
      }));
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-child-answer|secret-token/);
      await reviewEndedSession(services, session.sessionId, report);
      expect(log).toHaveBeenCalledTimes(1);
      expect(provider.callCount).toBe(1);
      expect(await rewardPointsOf(child.id)).toEqual({ points: 0, remainder: 0 });
    } finally { log.mockRestore(); }
  });

  it("treats an invalid verdict (seconds/points) as an evaluation error without retry", async () => {
    const { services, clock, provider } = await reviewerServices("2026-10-16T10:00:00.000Z", [
      { raw: { reason: "ok", excludedTasks: [], approvedSeconds: 120 } },
    ]);
    const child = await childWithProfile(services);
    const { session, tasks } = await playedSession(services, child.id);
    clock.advanceMs(60_000);
    const activity = await reviewEndedSession(services, session.sessionId, reportOf([
      { taskId: tasks[0]!.taskId, exerciseType: tasks[0]!.exerciseType, intervals: [[0, 60_000]], edits: 1, attempts: [] },
    ], 60_000));
    expect(activity).toMatchObject({ status: "error", errorCode: "invalid_verdict", pointsAwarded: 0 });
    expect(provider.callCount).toBe(1);
  });

  it("a model timeout keeps the report and error without points, and a retry starts no new call", async () => {
    const base = buildTestServices("2026-10-16T10:00:00.000Z");
    const provider = new FakeSessionActivityReviewer();
    // Opóźnienie dłuższe niż deadline zamyka wywołanie przez AbortController.
    provider.queue({ raw: { reason: "nieużyte", excludedTasks: [] }, delayMs: 30_000 });
    const services = createServices({
      db: base.services.db,
      clock: base.clock,
      sessionActivity: fakeSessionActivityDeps({ provider, timeoutMs: 100 }),
    });
    const child = await childWithProfile(services);
    const { session, tasks } = await playedSession(services, child.id);
    base.clock.advanceMs(60_000);
    const report = reportOf([
      { taskId: tasks[0]!.taskId, exerciseType: tasks[0]!.exerciseType, intervals: [[0, 60_000]], edits: 1, attempts: [] },
    ], 60_000);
    const activity = await reviewEndedSession(services, session.sessionId, report);
    expect(activity).toMatchObject({ status: "error", errorCode: "model_timeout", pointsAwarded: 0 });
    expect(await rewardPointsOf(child.id)).toEqual({ points: 0, remainder: 0 });
    // Raport i kod błędu pozostają zapisane (szczegóły w retencji 7 dni).
    const stored = (await pool.query("select activity_report from learning_app.learning_sessions where id=$1", [session.sessionId])).rows[0]!;
    expect(stored.activity_report.errorCode).toBe("model_timeout");
    // Powtórzenie żądania zwraca zapisany błąd bez kolejnego wywołania modelu.
    const retry = await reviewEndedSession(services, session.sessionId, report);
    expect(retry).toMatchObject({ status: "error", errorCode: "model_timeout", pointsAwarded: 0 });
    expect(provider.callCount).toBe(1);
  });

  it("returns the stored result on retry without a second model call or points", async () => {
    const { services, clock, provider } = await reviewerServices("2026-10-16T10:00:00.000Z");
    const child = await childWithProfile(services);
    const { session, tasks, attemptIds } = await playedSession(services, child.id);
    clock.advanceMs(70_000);
    const report = reportOf([
      { taskId: tasks[0]!.taskId, exerciseType: tasks[0]!.exerciseType, intervals: [[0, 70_000]], edits: 3, attempts: attemptIds },
      { taskId: tasks[1]!.taskId, exerciseType: tasks[1]!.exerciseType, intervals: [], edits: 0, attempts: [] },
    ], 70_000);
    const first = await reviewEndedSession(services, session.sessionId, report);
    const second = await reviewEndedSession(services, session.sessionId, report);
    expect(second).toEqual(first);
    expect(provider.callCount).toBe(1);
    expect(await rewardPointsOf(child.id)).toEqual({ points: 1, remainder: 10_000 });
  });

  it("conflicts on a different report for an already accepted session", async () => {
    const { services, clock } = await reviewerServices("2026-10-16T10:00:00.000Z");
    const child = await childWithProfile(services);
    const { session, tasks } = await playedSession(services, child.id);
    clock.advanceMs(60_000);
    const report = reportOf([
      { taskId: tasks[0]!.taskId, exerciseType: tasks[0]!.exerciseType, intervals: [[0, 60_000]], edits: 1, attempts: [] },
    ], 60_000);
    await reviewEndedSession(services, session.sessionId, report);
    const tampered = reportOf([
      { taskId: tasks[0]!.taskId, exerciseType: tasks[0]!.exerciseType, intervals: [[0, 600_000]], edits: 1, attempts: [] },
    ], 600_000);
    await expect(endSession(services, session.sessionId, tampered)).rejects.toMatchObject({ code: "conflict" });
  });

  it("parallel identical deliveries award points at most once", async () => {
    const { services, clock } = await reviewerServices("2026-10-16T10:00:00.000Z");
    const child = await childWithProfile(services);
    const { session, tasks } = await playedSession(services, child.id);
    clock.advanceMs(60_000);
    const report = reportOf([
      { taskId: tasks[0]!.taskId, exerciseType: tasks[0]!.exerciseType, intervals: [[0, 60_000]], edits: 1, attempts: [] },
    ], 60_000);
    await endSession(services, session.sessionId);
    const results = await Promise.all([
      reviewSessionActivity(services, session.sessionId, report),
      reviewSessionActivity(services, session.sessionId, report),
      reviewSessionActivity(services, session.sessionId, report),
    ]);
    const evaluated = results.filter((result) => result.status === "evaluated");
    const already = results.filter((result) => result.status === "already_started");
    expect(evaluated.length + already.length).toBe(3);
    expect(await rewardPointsOf(child.id)).toEqual({ points: 1, remainder: 0 });
  });

  it("after the deadline an interrupted marker ends as a technical error without points", async () => {
    const { services, clock } = await reviewerServices("2026-10-16T10:00:00.000Z");
    const child = await childWithProfile(services);
    const { session, tasks } = await playedSession(services, child.id);
    clock.advanceMs(60_000);
    // Symulacja restartu: znacznik rozpoczęcia zapisany, wyniku brak.
    await pool.query(
      "update learning_app.learning_sessions set activity_review_started_at=$2, activity_report_expires_at=$3 where id=$1",
      [session.sessionId, clock.now(), new Date(clock.now().getTime() + 7 * 86_400_000)],
    );
    clock.advanceMs(130_000);
    // Zwykłe zakończenie bez raportu/odczyt wyniku ma rozstrzygnąć przerwany review.
    const result = await endSession(services, session.sessionId);
    expect(result).toMatchObject({ activity: { status: "error", errorCode: "review_interrupted", pointsAwarded: 0 } });
    expect(await rewardPointsOf(child.id)).toEqual({ points: 0, remainder: 0 });
    const card = await readParentWorkCard(services, { childId: child.id });
    expect(card.sessions[0]!.activity).toMatchObject({ status: "error", errorCode: "review_interrupted" });
  });

  it("an empty cancelled session evaluates to zero without calling the model", async () => {
    const { services, provider } = await reviewerServices("2026-10-16T10:00:00.000Z");
    const child = await childWithProfile(services);
    const deckId = await publishDeck(services, child.id);
    // Anulowana kartkówka przed pierwszym zadaniem: sesja bez wydanych zadań.
    const session = await startSession(services, { childId: child.id, deckId, microphoneEnabled: false });
    const activity = await reviewEndedSession(services, session.sessionId, reportOf([], 1));
    expect(activity).toMatchObject({ status: "evaluated", pointsAwarded: 0 });
    expect(provider.callCount).toBe(0);
  });

  it("carries the sub-minute remainder across days but counts only today's approved time", async () => {
    const { services, clock } = await reviewerServices("2026-10-16T10:00:00.000Z");
    const child = await childWithProfile(services);
    const first = await playedSession(services, child.id);
    clock.advanceMs(40_000);
    await reviewEndedSession(services, first.session.sessionId, reportOf([
      { taskId: first.tasks[0]!.taskId, exerciseType: first.tasks[0]!.exerciseType, intervals: [[0, 40_000]], edits: 1, attempts: first.attemptIds },
    ], 40_000));
    expect(await rewardPointsOf(child.id)).toEqual({ points: 0, remainder: 40_000 });
    clock.advanceHours(24);
    expect((await listKidProfiles(services)).find((profile) => profile.childId === child.id)?.todayActivitySeconds).toBe(0);
    const second = await playedSession(services, child.id);
    clock.advanceMs(50_000);
    const activity = await reviewEndedSession(services, second.session.sessionId, reportOf([
      { taskId: second.tasks[0]!.taskId, exerciseType: second.tasks[0]!.exerciseType, intervals: [[0, 50_000]], edits: 1, attempts: second.attemptIds },
    ], 50_000));
    expect(activity).toMatchObject({ status: "evaluated", pointsAwarded: 1 });
    expect(await rewardPointsOf(child.id)).toEqual({ points: 1, remainder: 30_000 });
    const profiles = await listKidProfiles(services);
    expect(profiles.find((profile) => profile.childId === child.id)?.rewardPoints).toBe(1);
    expect(profiles.find((profile) => profile.childId === child.id)?.todayActivitySeconds).toBe(50);
  });

  it("cleanup drops expired details but keeps points, short result and the once-marker", async () => {
    const { services, clock } = await reviewerServices("2026-10-16T10:00:00.000Z");
    const child = await childWithProfile(services);
    const { session, tasks, attemptIds } = await playedSession(services, child.id);
    clock.advanceMs(60_000);
    await reviewEndedSession(services, session.sessionId, reportOf([
      { taskId: tasks[0]!.taskId, exerciseType: tasks[0]!.exerciseType, intervals: [[0, 60_000]], edits: 2, attempts: attemptIds },
    ], 60_000));
    const before = await rewardPointsOf(child.id);
    // Retencja minęła, worker jeszcze nie czyścił: API nie udostępnia szczegółów.
    await pool.query("update learning_app.learning_sessions set activity_report_expires_at = $2 where id=$1", [session.sessionId, new Date(clock.now().getTime() - 1_000)]);
    const expiredCard = await readParentWorkCard(services, { childId: child.id });
    expect(expiredCard.sessions[0]!.activity.excludedTasks).toBeNull();
    expect(expiredCard.sessions[0]!.activity.pointsAwarded).toBe(before.points);
    // Fizyczne czyszczenie: JSONB znika, krótki wynik i punkty zostają.
    const cleaned = await cleanupExpiredActivityReports(services);
    expect(cleaned).toBeGreaterThanOrEqual(1);
    const row = (await pool.query("select activity_report, activity_review, activity_report_hash, activity_review_started_at is not null as marked from learning_app.learning_sessions where id=$1", [session.sessionId])).rows[0]!;
    expect(row.activity_report).toBeNull();
    expect(row.activity_report_hash).not.toBeNull();
    expect(row.marked).toBe(true);
    expect((row.activity_review as { pointsAwarded: number }).pointsAwarded).toBe(before.points);
    expect(await rewardPointsOf(child.id)).toEqual(before);
  });

  it("does not re-evaluate a report delivered after retention", async () => {
    const { services, clock, provider } = await reviewerServices("2026-10-16T10:00:00.000Z");
    const child = await childWithProfile(services);
    const { session, tasks } = await playedSession(services, child.id);
    clock.advanceMs(60_000);
    const report = reportOf([
      { taskId: tasks[0]!.taskId, exerciseType: tasks[0]!.exerciseType, intervals: [[0, 60_000]], edits: 1, attempts: [] },
    ], 60_000);
    await reviewEndedSession(services, session.sessionId, report);
    await pool.query("update learning_app.learning_sessions set activity_report_expires_at = $2 where id=$1", [session.sessionId, new Date(clock.now().getTime() - 8 * 86_400_000)]);
    const calls = provider.callCount;
    const retry = await reviewSessionActivity(services, session.sessionId, report);
    // Wynik już zapisany → zwracany bez modelu; retencja nie tworzy ponownej oceny.
    expect(retry.status).toBe("evaluated");
    expect(provider.callCount).toBe(calls);
  });

  it("a legacy session predating the rollout cannot be settled by the new mechanism", async () => {
    const { services, clock, provider } = await reviewerServices("2026-10-16T10:00:00.000Z");
    const child = await childWithProfile(services);
    const { session, tasks } = await playedSession(services, child.id);
    // Migracja 0021 ustawia wygasły termin wszystkim istniejącym sesjom.
    await pool.query("update learning_app.learning_sessions set activity_report_expires_at = $2 where id=$1", [session.sessionId, clock.now()]);
    clock.advanceMs(60_000);
    const result = await reviewSessionActivity(services, session.sessionId, reportOf([
      { taskId: tasks[0]!.taskId, exerciseType: tasks[0]!.exerciseType, intervals: [[0, 60_000]], edits: 1, attempts: [] },
    ], 60_000));
    expect(result).toMatchObject({ status: "error", errorCode: "report_expired", pointsAwarded: 0 });
    expect(provider.callCount).toBe(0);
    expect(await rewardPointsOf(child.id)).toEqual({ points: 0, remainder: 0 });
  });
});

describe("session activity kid transport", () => {
  it("delivers the report through the real Kid router end route", async () => {
    const { services, clock } = await reviewerServices("2026-10-16T10:00:00.000Z");
    const child = await childWithProfile(services);
    const { session, tasks, attemptIds } = await playedSession(services, child.id);
    clock.advanceMs(65_000);
    const api = createKidApiClient({
      baseUrl: "http://localhost",
      fetchImpl: async (input, init) => {
        const url = new URL(String(input), "http://localhost");
        return handleKidApi(new Request(url, init), services);
      },
    });
    const summary = await api.endSession(session.sessionId, reportOf([
      { taskId: tasks[0]!.taskId, exerciseType: tasks[0]!.exerciseType, intervals: [[0, 65_000]], edits: 4, attempts: attemptIds },
    ], 65_000));
    expect(summary.activity).toEqual({ status: "already_started", pointsAwarded: 0, errorCode: null });
    expect(await waitForActivityResult(services, session.sessionId)).toMatchObject({ status: "evaluated", pointsAwarded: 1 });
    expect(await rewardPointsOf(child.id)).toEqual({ points: 1, remainder: 5_000 });
  });

  it("requires a client refresh for an unknown report version", async () => {
    const { services } = buildTestServices("2026-10-16T10:00:00.000Z");
    const child = await childWithProfile(services);
    const deckId = await publishDeck(services, child.id);
    const session = await startSession(services, { childId: child.id, deckId, microphoneEnabled: false });
    const response = await handleKidApi(
      new Request(`http://localhost/api/v1/kid/sessions/${session.sessionId}/end`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ activityReport: { version: 2, elapsedMs: 10, activeMs: 0, compacted: false, tasks: [] } }),
      }),
      services,
    );
    expect(response.status).toBe(400);
    const body = ApiErrorSchema.parse(await response.json());
    expect(body.code).toBe("validation");
    expect(body.details).toEqual({ reason: "activity_report_update_required" });
  });

  it("rejects an oversized report with a validation error instead of silently dropping it", async () => {
    const { services } = buildTestServices("2026-10-16T10:00:00.000Z");
    const child = await childWithProfile(services);
    const deckId = await publishDeck(services, child.id);
    const session = await startSession(services, { childId: child.id, deckId, microphoneEnabled: false });
    const response = await handleKidApi(
      new Request(`http://localhost/api/v1/kid/sessions/${session.sessionId}/end`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          activityReport: { version: 1, elapsedMs: 10, activeMs: 0, compacted: false, tasks: [], padding: "x".repeat(SESSION_ACTIVITY_REPORT_MAX_BYTES + 512) },
        }),
      }),
      services,
    );
    expect(response.status).toBe(400);
    expect(ApiErrorSchema.parse(await response.json()).code).toBe("validation");
    // Sesja pozostała aktywna — raport nie zniknął po cichu razem z oceną.
    const state = (await pool.query("select state from learning_app.learning_sessions where id=$1", [session.sessionId])).rows[0]!;
    expect(state.state).toBe("active");
  });
});

describe("session activity guardrails", () => {
  it("AppError code mapping stays available for router reuse", () => {
    expect(new AppError("conflict").code).toBe("conflict");
  });
});
