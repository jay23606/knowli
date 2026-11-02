import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { completePresentation, createChild, createDraft, createServices, endSession, fakeSessionActivityDeps, FakeSessionActivityReviewer, loginParent, nextTask, publishDraft, readParentWorkCard, setupParent, startSession, submitAttempt, upsertAssignment } from "@learning/server";
import type { SessionActivityReport } from "@learning/contracts";
import { handleParentApi } from "./helpers";
import { buildTestServices, finishLessonTask, testDatabase, truncateCoreTables } from "./helpers";
import { lessonWorld, STORY_FIXTURE } from "../fixtures/lesson-world";

const { pool } = testDatabase();
afterAll(async () => { await pool.end(); });

/**
 * Karta pracy po zmianie kontraktu (spec client-reward-time): zatwierdzony czas
 * sesji ocenionych zakończonych danego dnia, liczba sesji bez oceny, szczegóły
 * wykluczeń w retencji 7 dni. Bez Xbox i segmentów.
 */

function reportOf(tasks: { taskId: string; exerciseType: string; interval: [number, number]; attempts?: string[] }[], elapsedMs: number): SessionActivityReport {
  return {
    version: 1,
    elapsedMs,
    activeMs: tasks.reduce((total, task) => total + (task.interval[1] - task.interval[0]), 0),
    compacted: false,
    tasks: tasks.map((task, index) => ({
      taskId: task.taskId,
      exerciseType: task.exerciseType,
      shownFromMs: index === 0 ? 0 : tasks[index - 1]!.interval[1],
      shownToMs: task.interval[1],
      activeIntervals: [task.interval],
      editCount: 1,
      editWindows: [{ atMs: task.interval[0], count: 1 }],
      submittedAttempts: task.attempts ?? [],
      playbacks: [],
      pauses: [],
    })),
  };
}

async function deckWithTwoWords(services: ReturnType<typeof buildTestServices>["services"], childId: string) {
  const draft = await createDraft(services, { title: "Dni", items: [
    { source: "poniedziałek", target: "Monday", acceptedAnswers: [], locales: { source: "pl-PL", target: "en-GB" }, visualType: "none" },
    { source: "wtorek", target: "Tuesday", acceptedAnswers: [], locales: { source: "pl-PL", target: "en-GB" }, visualType: "none" },
  ] });
  const revisions = (await pool.query<{ id: string }>("select id from learning_app.item_revisions where deck_version_id=$1", [draft.id])).rows;
  for (const revision of revisions) {
    const assetId = randomUUID(), fingerprint = `work-card-${randomUUID()}`;
    await pool.query(`insert into learning_app.media_assets
      (id,kind,fingerprint,generation_number,state,storage_key,content_sha256,mime_type,byte_count,provider,model,metadata)
      values ($1,'tts',$2,1,'ready',$3,$4,'audio/mpeg',100,'fake','fake',$5::jsonb)`,
    [assetId, fingerprint, `blob/${assetId}`, `sha-${assetId}`, JSON.stringify({ durationMs: 20_000 })]);
    await pool.query(`insert into learning_app.revision_assets
      (item_revision_id,role,asset_id,expected_fingerprint,state) values ($1,'target_audio',$2,$3,'approved')`, [revision.id, assetId, fingerprint]);
    await pool.query(`insert into learning_app.revision_assets
      (item_revision_id,role,asset_id,expected_fingerprint,state) values ($1,'illustration',null,$2,'omitted')`, [revision.id, `ill-${randomUUID()}`]);
  }
  await publishDraft(services, draft.id, 1);
  await upsertAssignment(services, childId, draft.deckId, null);
  return draft.deckId;
}

describe("parent work card", () => {
  beforeEach(async () => {
    await truncateCoreTables();
    await pool.query(`truncate learning_app.revision_assets, learning_app.media_assets, learning_app.item_revision_skills,
      learning_app.item_revisions, learning_app.skill_versions, learning_app.learning_items,
      learning_app.deck_versions, learning_app.decks cascade`);
  });

  it("sums approved seconds of evaluated sessions ended that day and counts unevaluated ones", async () => {
    const base = buildTestServices("2026-10-16T10:00:00.000Z");
    const provider = new FakeSessionActivityReviewer();
    const services = createServices({ db: base.services.db, clock: base.clock, sessionActivity: fakeSessionActivityDeps({ provider }) });
    const child = await createChild(services, { displayName: "Ola", avatarKey: "fox" });
    const deckId = await deckWithTwoWords(services, child.id);

    // Sesja oceniona z wykluczeniem pierwszego zadania ocenianego (60 s → 0)
    // i drugiego (60 s → 60 s); prezentacje pomijamy.
    const session = await startSession(services, { childId: child.id, deckId, microphoneEnabled: false });
    const assessed: Awaited<ReturnType<typeof nextTask>>[] = [];
    let attemptId: string | null = null;
    for (let index = 0; index < 8; index += 1) {
      const task = await nextTask(services, session.sessionId);
      if (task === null) break;
      if (task.exerciseType === "exposure" || task.exerciseType === "lesson_card") {
        await completePresentation(services, { taskId: task.taskId });
        continue;
      }
      if (assessed.length === 0) {
        attemptId = (await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "dont_remember" })).attemptId;
      }
      assessed.push(task);
      if (assessed.length === 2) break;
    }
    expect(assessed).toHaveLength(2);
    const [first, second] = assessed;
    base.clock.advanceMs(120_000);
    const firstOrdinal = (await pool.query<{ ordinal: number }>("select ordinal from learning_app.session_tasks where id=$1", [first!.taskId])).rows[0]!.ordinal;
    provider.queue({ raw: {
      reason: "Jedno zadanie wykluczone.",
      excludedTasks: [{ taskOrdinal: firstOrdinal, reason: "Brak próby." }],
    } });
    await endSession(services, session.sessionId, reportOf([
      { taskId: first!.taskId, exerciseType: first!.exerciseType, interval: [0, 60_000], attempts: attemptId === null ? [] : [attemptId] },
      { taskId: second!.taskId, exerciseType: second!.exerciseType, interval: [60_000, 120_000] },
    ], 120_000));

    // Sesja zakończona bez raportu (np. z innego urządzenia): jawny brak oceny.
    const bare = await startSession(services, { childId: child.id, deckId, microphoneEnabled: false });
    for (let index = 0; index < 3; index += 1) {
      const task = await nextTask(services, bare.sessionId);
      if (task === null) break;
      if (task.exerciseType === "exposure" || task.exerciseType === "lesson_card") {
        await completePresentation(services, { taskId: task.taskId });
        continue;
      }
      await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "dont_remember" });
      break;
    }
    await endSession(services, bare.sessionId);

    const card = await readParentWorkCard(services, { childId: child.id });
    expect(card.creditedSeconds).toBe(60);
    expect(card.unevaluatedSessions).toBe(1);
    const evaluated = card.sessions.find((entry) => entry.sessionId === session.sessionId)!;
    expect(evaluated.activity).toMatchObject({ status: "evaluated", approvedSeconds: 60, pointsAwarded: 1 });
    expect(evaluated.activity.excludedTasks).toEqual([{ taskOrdinal: firstOrdinal, reason: "Brak próby." }]);
    const unevaluated = card.sessions.find((entry) => entry.sessionId === bare.sessionId)!;
    expect(unevaluated.activity).toMatchObject({ status: "not_delivered" });

    // Po retencji szczegóły wykluczeń znikają, krótki wynik zostaje.
    await pool.query("update learning_app.learning_sessions set activity_report_expires_at = $2 where id=$1", [session.sessionId, new Date(base.clock.now().getTime() - 1_000)]);
    const expired = await readParentWorkCard(services, { childId: child.id });
    const expiredSession = expired.sessions.find((entry) => entry.sessionId === session.sessionId)!;
    expect(expiredSession.activity.excludedTasks).toBeNull();
    expect(expiredSession.activity.approvedSeconds).toBe(60);

    // Nagroda należy do lokalnej daty KOŃCA sesji.
    expect((await readParentWorkCard(services, { childId: child.id, date: "2026-10-15" })).sessions).toEqual([]);
  });

  it("requires Parent Mode, rejects invalid input, and never returns another child's data", async () => {
    const { services } = buildTestServices();
    await setupParent(services, "work-card-pin");
    const { token } = await loginParent(services, "work-card-pin");
    const child = await createChild(services, { displayName: "Ola", avatarKey: "fox" });
    // Granica oRPC zwraca kopertę 401 zamiast rzucanego wyjątku legacy —
    // semantyka HTTP bez zmian, zmienia się tylko nośnik (Response, nie throw).
    const anonymous = await handleParentApi(new Request(`http://localhost/api/v1/parent/work-card?childId=${child.id}&date=2026-10-16`), services, ["work-card"]);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ code: "unauthorized" });
    await expect(readParentWorkCard(services, { childId: child.id, date: "16.10.2026" })).rejects.toMatchObject({ name: "ZodError" });
    const response = await handleParentApi(
      new Request(`http://localhost/api/v1/parent/work-card?childId=${child.id}&date=2026-10-16`, { headers: { cookie: `parent_session=${token}` } }),
      services,
      ["work-card"],
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ childId: child.id, date: "2026-10-16", sessions: [], creditedSeconds: 0, unevaluatedSessions: 0 });
    const other = await createChild(services, { displayName: "Jan", avatarKey: "bear" });
    expect(await readParentWorkCard(services, { childId: other.id, date: "2026-10-16" })).toMatchObject({ childId: other.id, sessions: [], creditedSeconds: 0 });
    await expect(readParentWorkCard(services, { childId: randomUUID(), date: "2026-10-16" }))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("story tasks appear as steps and do not reduce remaining steps", async () => {
    const { services, clock } = buildTestServices();
    const child = await createChild(services, { displayName: "Ola", avatarKey: "fox" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, story: { value: STORY_FIXTURE } });
    // Cel opanowany z należnym sprawdzeniem: plan bez kart z kilkoma ocenianymi slotami.
    await pool.query("update learning_app.decks set session_task_budget = 8 where id = $1", [lesson.deckId]);
    await pool.query(
      `insert into learning_app.child_objective_progress
         (child_id, subject_id, objective_id, topic_id, status, streak, next_review_at, projection_version)
       values ($1, 'english_grammar', $2, $3, 'mastered', 3, '2000-01-01T00:00:00Z', 'proj-1')`,
      [child.id, lesson.objectiveId, lesson.topicId],
    );
    const session = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false });
    expect(session.taskBudget).toBeGreaterThan(4);
    const first = (await nextTask(services, session.sessionId))!;
    await finishLessonTask(services, first);
    // Limit czasu przy więcej niż 3 pozostałych: zamiast reszty planu wychodzi historyjka.
    clock.advanceMs(11 * 60_000);
    const story: string[] = [];
    for (let task = await nextTask(services, session.sessionId); task !== null; task = await nextTask(services, session.sessionId)) {
      story.push(task.exerciseType);
      await finishLessonTask(services, task);
    }
    expect(story).toEqual(["lesson_story", "lesson_story_question", "lesson_story_question"]);

    const card = await readParentWorkCard(services, { childId: child.id });
    const entry = card.sessions.find((candidate) => candidate.sessionId === session.sessionId)!;
    expect(entry.steps.map((step) => step.exerciseType)).toEqual([first.exerciseType, ...story]);
    expect(entry.remainingSteps).toBe(session.taskBudget - 1);
  });
});
