import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createChild,
  createServices,
  endSession,
  FakeAnswerGrader,
  getLessonMockTestReport,
  listLessonMockTests,
  nextTask,
  readLessonMockTestSummary,
  startSession,
  submitAttempt,
  type AppError,
} from "@learning/server";
import type { TaskDto } from "@learning/contracts";
import { lessonWorld } from "../fixtures/lesson-world";
import { buildTestServices, testDatabase, truncateCoreTables } from "./helpers";

/**
 * Zadanie 17A: próbna kartkówka lekcji po stronie serwera. Start (plan zamrożony,
 * cel `lesson`), wydawanie slotów bez feedbacku, jedna odpowiedź na slot
 * (terminalna), limit czasu (min. 10 min), wznowienie w oknie, ocena modelem w kartkówce,
 * ekspozycje po kartkówce (ćwiczenie staje się widziane), raport per cel,
 * omówienie dziecka pieczętujące ekspozycje, `mock_test_unavailable`,
 * zamrożona porcja (edycja przypisania po starcie nie zmienia slotów).
 */

const { pool } = testDatabase();

beforeEach(async () => {
  await truncateCoreTables();
  await pool.query(`truncate learning_app.child_objective_progress, learning_app.lesson_verdicts,
    learning_app.revision_assets, learning_app.media_assets, learning_app.item_revision_skills,
    learning_app.item_revisions, learning_app.skill_versions, learning_app.learning_items,
    learning_app.deck_versions, learning_app.decks cascade`);
});
afterAll(() => pool.end());

type Services = ReturnType<typeof buildTestServices>["services"];
type Clock = ReturnType<typeof buildTestServices>["clock"];

function graderServices(grader: FakeAnswerGrader, opts: { startIso?: string } = {}): { services: Services; clock: Clock } {
  const { services, clock } = buildTestServices(opts.startIso);
  const withGrader = createServices({
    db: (services as unknown as { db: Parameters<typeof createServices>[0]["db"] }).db,
    clock,
    grader: { provider: grader, maxCallsPerSession: 20, timeoutMs: 8000 },
  });
  return { services: withGrader, clock };
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<void> {
  await promise.then(
    () => { throw new Error(`Oczekiwano błędu ${code}, otrzymano sukces`); },
    (error: unknown) => { expect((error as AppError).code).toBe(code); },
  );
}

async function answerKeyOf(taskId: string): Promise<Record<string, unknown>> {
  const rows = await pool.query<{ answerKey: Record<string, unknown> }>(
    `select answer_key as "answerKey" from learning_app.session_tasks where id = $1`,
    [taskId],
  );
  return rows.rows[0]!.answerKey;
}

/** Odpowiada poprawnie na slot, dobierając modalność do typu; skip gdy brak klucza. */
async function answerCorrectly(services: Services, task: TaskDto) {
  const key = await answerKeyOf(task.taskId);
  if (["lesson_choice", "lesson_short_answer", "lesson_notice"].includes(task.exerciseType)) {
    if (typeof key.correctOptionId === "string") {
      return submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "choice", optionId: key.correctOptionId });
    }
    // Slot prowadzony bez opcji (zdegenerowany fixture) — pomiń, nadal terminalny.
    return submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "skip" });
  }
  if (task.exerciseType === "lesson_order") {
    return submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "sequence", itemIds: key.itemIds as string[] });
  }
  return submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: key.answer as string });
}

async function startMock(services: Services, childId: string, deckId: string) {
  return startSession(services, { childId, deckId, microphoneEnabled: false, mode: "mock_test" });
}

describe("kartkówka lekcji — start i plan", () => {
  it("start wymaga celu lesson; bez celu → validation", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "L", avatarKey: "owl" });
    // testDate undefined → brak celu lesson w przypisaniu
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true });
    await expectAppError(startMock(services, child.id, lesson.deckId), "validation");
  });

  it("plan zamrożony: slotów nie liczy notice/intro i są oceniane", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "L", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, testDate: "2026-10-20" });
    const session = await startMock(services, child.id, lesson.deckId);
    const plan = (await pool.query<{ plan: { kind: string; slots: { exerciseType: string }[] } }>(
      "select mock_test_plan as plan from learning_app.learning_sessions where id = $1", [session.sessionId])).rows[0]!.plan;
    expect(plan.kind).toBe("lesson");
    expect(plan.slots.length).toBe(session.taskBudget);
    expect(plan.slots.every((s) => s.exerciseType !== "lesson_notice" && s.exerciseType !== "lesson_card")).toBe(true);
  });

  it("edycja przypisania po starcie NIE zmienia slotów (zamrożona porcja)", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "L", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, testDate: "2026-10-20" });
    const session = await startMock(services, child.id, lesson.deckId);
    const before = (await pool.query<{ plan: { slots: unknown[] } }>(
      "select mock_test_plan as plan from learning_app.learning_sessions where id = $1", [session.sessionId])).rows[0]!.plan;
    await pool.query("update learning_app.assignments set mock_test_task_count = 1 where child_id = $1 and deck_id = $2", [child.id, lesson.deckId]);
    const after = (await pool.query<{ plan: { slots: unknown[] } }>(
      "select mock_test_plan as plan from learning_app.learning_sessions where id = $1", [session.sessionId])).rows[0]!.plan;
    expect(after.slots.length).toBe(before.slots.length);
  });

  it("brak bezpiecznej porcji → mock_test_unavailable", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "L", avatarKey: "owl" });
    // Lekcja, której JEDYNE ćwiczenie to lesson_notice (intro) — planer kartkówki
    // pomija notice/intro, więc porcja jest pusta. Budujemy wprost jako szkic,
    // modyfikujemy payload PRZED publikacją (trigger blokuje edycję po publikacji),
    // dopiero potem publikujemy.
    const deckId = randomUUID(), versionId = randomUUID(), itemId = randomUUID(), revisionId = randomUUID(), skillVersionId = randomUUID();
    const objectiveId = "english_grammar.present_simple.third_person_s";
    const lessonContext = JSON.stringify({ subjectId: "english_grammar", topicId: "present_simple", topicVersion: 1, objectiveIds: [objectiveId], examples: { [objectiveId]: [] } });
    await pool.query("insert into learning_app.decks (id, title, kind) values ($1, 'Notice only', 'lesson')", [deckId]);
    await pool.query(
      `insert into learning_app.deck_versions (id, deck_id, version_number, edit_number, state, title, lesson_context)
       values ($1, $2, 1, 1, 'draft', 'Notice only', $3::jsonb)`, [versionId, deckId, lessonContext]);
    await pool.query("insert into learning_app.learning_items (id, deck_id, kind) values ($1, $2, 'lesson_exercise')", [itemId, deckId]);
    await pool.query(
      `insert into learning_app.item_revisions (id, item_id, deck_id, deck_version_id, position, payload_version, payload, target_key)
       values ($1, $2, $3, $4, 0, 2, $5::jsonb, $6)`,
      [revisionId, itemId, deckId, versionId,
        JSON.stringify({ exerciseType: "lesson_notice", objectiveId, instructionPl: "Wskaż", noticeSegments: [["He", "plays"], ["They", "play"]], correctOption: "plays", answer: "plays", acceptedAnswers: ["plays"], focus: ["plays"], answerLocale: "en-GB", promptLocale: "pl-PL" }),
        `notice-tk-${revisionId}`]);
    await pool.query(
      `insert into learning_app.skill_versions (id, item_id, skill, revision_number, criteria, criteria_hash)
       values ($1, $2, 'objective', 1, $3::jsonb, $4)`, [skillVersionId, itemId, JSON.stringify({ objectiveId }), `oc-${skillVersionId}`]);
    await pool.query(
      `insert into learning_app.item_revision_skills (item_revision_id, item_id, skill, skill_version_id) values ($1, $2, 'objective', $3)`,
      [revisionId, itemId, skillVersionId]);
    await pool.query("update learning_app.deck_versions set state = 'published', published_at = now() where id = $1", [versionId]);
    await pool.query("update learning_app.decks set published_version_id = $1 where id = $2", [versionId, deckId]);
    await pool.query(`insert into learning_app.assignments (id, child_id, deck_id, test_date, test_goals) values ($1, $2, $3, '2026-10-20', $4)`,
      [randomUUID(), child.id, deckId, ["lesson"]]);

    await expectAppError(startMock(services, child.id, deckId), "mock_test_unavailable");
  });
});

describe("kartkówka lekcji — odpowiedzi i zamknięcie", () => {
  it("brak feedbacku i jedna odpowiedź na slot (terminalna)", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "L", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, testDate: "2026-10-20" });
    const session = await startMock(services, child.id, lesson.deckId);
    const task = await nextTask(services, session.sessionId);
    expect(task).not.toBeNull();
    const attempt = await answerCorrectly(services, task!);
    expect(attempt.feedback).toBeNull();
    expect(attempt.stepId).toBeNull();
    expect(["answered", "skipped"]).toContain(attempt.taskState);
    // Drugie podejście na ten sam (terminalny) slot → konflikt.
    await expectAppError(answerCorrectly(services, task!), "conflict");
  });

  it("nieoceniona odpowiedź (brak modelu) nadal kończy slot bez kary", async () => {
    const { services, clock } = buildTestServices(); // brak gradera
    const child = await createChild(services, { displayName: "L", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, testDate: "2026-10-20" });
    const session = await startMock(services, child.id, lesson.deckId);
    // Doprowadź do open-ended tekstu (transform) i odpowiedz niedopasowanym tekstem.
    let task: TaskDto | null = null;
    for (let i = 0; i < 20; i++) {
      const t = await nextTask(services, session.sessionId);
      if (!t) break;
      if (t.exerciseType === "lesson_transform" || t.exerciseType === "lesson_gap") { task = t; break; }
      await answerCorrectly(services, t);
    }
    expect(task).not.toBeNull();
    const attempt = await submitAttempt(services, { taskId: task!.taskId, clientAttemptId: randomUUID(), modality: "text", text: "zzqq niedopasowane" });
    expect(attempt.feedback).toBeNull();
    expect(attempt.taskState).toBe("answered"); // terminalny mimo unevaluated
  });

  it("limit 10 min: po przekroczeniu brak nowej odpowiedzi i zamknięcie", async () => {
    const { services, clock } = buildTestServices();
    const child = await createChild(services, { displayName: "L", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, testDate: "2026-10-20" });
    const session = await startMock(services, child.id, lesson.deckId);
    const task = await nextTask(services, session.sessionId);
    clock.advanceMs(11 * 60_000);
    await expectAppError(answerCorrectly(services, task!), "conflict");
    const next = await nextTask(services, session.sessionId);
    expect(next).toBeNull();
    const state = (await pool.query<{ state: string }>("select state from learning_app.learning_sessions where id = $1", [session.sessionId])).rows[0]!.state;
    expect(state).toBe("ended");
  });

  it("skalowany limit (#297): budżet 20 przyjmuje odpowiedź w 11. minucie, omówienie i lista nie zamykają, po 15 min koniec", async () => {
    const { services, clock } = buildTestServices();
    const child = await createChild(services, { displayName: "L", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, testDate: "2026-10-20" });
    const session = await startMock(services, child.id, lesson.deckId);
    // Bogata pula fixture'u daje 7 slotów; limit liczy się z budżetu sesji, więc podnosimy go wprost.
    await pool.query("update learning_app.learning_sessions set task_budget = 20 where id = $1", [session.sessionId]);
    const task = await nextTask(services, session.sessionId);
    clock.advanceMs(11 * 60_000); // ponad podłogę 10 min, pod limitem 20 × 45 s
    await expectAppError(readLessonMockTestSummary(services, session.sessionId), "conflict");
    await expectAppError(getLessonMockTestReport(services, session.sessionId), "conflict");
    expect(await listLessonMockTests(services, child.id, lesson.deckId)).toEqual([]);
    const attempt = await answerCorrectly(services, task!);
    expect(attempt.taskState).toBe("answered");
    const late = await nextTask(services, session.sessionId);
    clock.advanceMs(4 * 60_001); // łącznie ponad 15 min od startu
    await expectAppError(answerCorrectly(services, late!), "conflict");
    expect((await listLessonMockTests(services, child.id, lesson.deckId)).map((r) => r.sessionId)).toEqual([session.sessionId]);
  });

  it("wznowienie w oknie zwraca tę samą sesję", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "L", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, testDate: "2026-10-20" });
    const first = await startMock(services, child.id, lesson.deckId);
    const resumed = await startMock(services, child.id, lesson.deckId);
    expect(resumed.sessionId).toBe(first.sessionId);
    expect(resumed.resumed).toBe(true);
  });
});

describe("kartkówka lekcji — raport, ekspozycje, omówienie", () => {
  it("komplet zamyka kartkówkę i daje raport per cel; ekspozycje po kartkówce widoczne", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "L", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, testDate: "2026-10-20" });
    const session = await startMock(services, child.id, lesson.deckId);

    for (let i = 0; i < 30; i++) {
      const t = await nextTask(services, session.sessionId);
      if (!t) break;
      await answerCorrectly(services, t);
    }
    const report = await getLessonMockTestReport(services, session.sessionId);
    expect(report.complete).toBe(true);
    expect(report.objectives.length).toBe(1);
    expect(report.objectives[0]!.objectiveId).toBe(lesson.objectiveId);
    expect(report.objectives[0]!.total).toBe(session.taskBudget);
    expect(report.objectives[0]!.correct + report.objectives[0]!.incorrect + report.objectives[0]!.unassessed + report.objectives[0]!.skipped).toBe(session.taskBudget);

    // Ćwiczenia wydane w kartkówce zapisały ekspozycje (stają się widziane).
    const exposed = (await pool.query<{ count: number }>(
      `select count(*)::int as count from learning_app.event_exposures x
         join learning_app.learning_events e on e.id = x.event_id
        where x.child_id = $1 and e.sealed = true`, [child.id])).rows[0]!.count;
    expect(exposed).toBeGreaterThan(0);
  });

  it("komplet utrwala state=completed i raport niesie sessionId/startedAt/endedAt", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "L", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, testDate: "2026-10-20" });
    const session = await startMock(services, child.id, lesson.deckId);
    for (let i = 0; i < 30; i++) { const t = await nextTask(services, session.sessionId); if (!t) break; await answerCorrectly(services, t); }
    const report = await getLessonMockTestReport(services, session.sessionId);
    expect(report.complete).toBe(true);
    expect(report.sessionId).toBe(session.sessionId);
    expect(typeof report.startedAt).toBe("string");
    expect(typeof report.endedAt).toBe("string");
    // Komplet → utrwalony state = completed (jak słówki), nie ended.
    const persisted = (await pool.query<{ state: string }>("select state from learning_app.learning_sessions where id = $1", [session.sessionId])).rows[0]!.state;
    expect(persisted).toBe("completed");
    const summary = await readLessonMockTestSummary(services, session.sessionId);
    expect(summary.state).toBe("completed");
  });

  it("gramatyka bez zmian (design §8): pominięte odpowiedzi nie dają wskazówek ani „Warto powtórzyć”", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "G", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, testDate: "2026-10-20" });
    const session = await startMock(services, child.id, lesson.deckId);
    for (let i = 0; i < 30; i++) {
      const t = await nextTask(services, session.sessionId);
      if (!t) break;
      await submitAttempt(services, { taskId: t.taskId, clientAttemptId: randomUUID(), modality: "skip" });
    }
    const summary = await readLessonMockTestSummary(services, session.sessionId);
    expect(summary.solutions.every((solution) => solution.outcome === "skipped")).toBe(true);
    expect(summary.reviewObjectives).toBeUndefined();
    expect(summary.solutions.some((solution) => solution.hintPl !== undefined)).toBe(false);
    expect((await getLessonMockTestReport(services, session.sessionId)).objectives[0]!.school).toBeUndefined();
  });

  it("timeout (niepełna) utrwala state=ended i summary=ended", async () => {
    const { services, clock } = buildTestServices();
    const child = await createChild(services, { displayName: "L", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, testDate: "2026-10-20" });
    const session = await startMock(services, child.id, lesson.deckId);
    await nextTask(services, session.sessionId); // wydaj pierwszy slot, nie odpowiadaj
    clock.advanceMs(11 * 60_000);
    await nextTask(services, session.sessionId); // limit → closeLessonMockTest(ended)
    const report = await getLessonMockTestReport(services, session.sessionId);
    expect(report.complete).toBe(false);
    const persisted = (await pool.query<{ state: string }>("select state from learning_app.learning_sessions where id = $1", [session.sessionId])).rows[0]!.state;
    expect(persisted).toBe("ended");
    const summary = await readLessonMockTestSummary(services, session.sessionId);
    expect(summary.state).toBe("ended");
  });

  it("jawne przerwanie niepełnej (endSession) utrwala state=ended", async () => {
    const { services, clock } = buildTestServices();
    const child = await createChild(services, { displayName: "L", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, testDate: "2026-10-20" });
    const session = await startMock(services, child.id, lesson.deckId);
    await nextTask(services, session.sessionId);
    await endSession(services, session.sessionId); // przerwanie przed kompletem
    const persisted = (await pool.query<{ state: string }>("select state from learning_app.learning_sessions where id = $1", [session.sessionId])).rows[0]!.state;
    expect(persisted).toBe("ended");
    clock.advanceMs(11 * 60_000);
    const summary = await readLessonMockTestSummary(services, session.sessionId);
    expect(summary.state).toBe("ended");
  });

  it("raport jest niezmienny po utrwaleniu (trigger)", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "L", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, testDate: "2026-10-20" });
    const session = await startMock(services, child.id, lesson.deckId);
    for (let i = 0; i < 30; i++) { const t = await nextTask(services, session.sessionId); if (!t) break; await answerCorrectly(services, t); }
    await getLessonMockTestReport(services, session.sessionId);
    await expect(
      pool.query(
        `update learning_app.learning_sessions set context = jsonb_set(context, '{lessonMockTestReport,complete}', 'false') where id = $1`,
        [session.sessionId],
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it("omówienie dziecka po zamknięciu listuje rozwiązania i pieczętuje ekspozycje", async () => {
    const { services, clock } = buildTestServices();
    const child = await createChild(services, { displayName: "L", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, testDate: "2026-10-20" });
    const session = await startMock(services, child.id, lesson.deckId);
    const first = await nextTask(services, session.sessionId);
    await answerCorrectly(services, first!);
    // Przed końcem okna 10 min: omówienie zablokowane.
    await expectAppError(readLessonMockTestSummary(services, session.sessionId), "conflict");
    clock.advanceMs(11 * 60_000);
    const summary = await readLessonMockTestSummary(services, session.sessionId);
    expect(summary.solutions.length).toBeGreaterThan(0);
    expect(summary.solutions[0]!.correctAnswer.length).toBeGreaterThan(0);
    // Ekspozycja omówienia zapieczętowana.
    const review = (await pool.query<{ count: number }>(
      `select count(*)::int as count from learning_app.learning_events where child_id = $1 and kind = 'feedback_issued' and sealed = true`,
      [child.id])).rows[0]!.count;
    expect(review).toBeGreaterThan(0);
  });

  it("lista rodzica zwraca ostatnie kartkówki lekcji per cel", async () => {
    const { services, clock } = buildTestServices();
    const child = await createChild(services, { displayName: "L", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, testDate: "2026-10-20" });
    const session = await startMock(services, child.id, lesson.deckId);
    await endSession(services, session.sessionId);
    clock.advanceMs(11 * 60_000);
    const list = await listLessonMockTests(services, child.id, lesson.deckId);
    expect(list.length).toBe(1);
    expect(list[0]!.objectives[0]!.objectiveId).toBe(lesson.objectiveId);
  });

  it("ocena modelem w kartkówce: wynik ukryty, ale assessment zapisany", async () => {
    const grader = new FakeAnswerGrader().onDefault({ raw: { verdict: "correct", errorCategory: null, fragments: [], note: "ok" } });
    const { services } = graderServices(grader);
    const child = await createChild(services, { displayName: "L", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, testDate: "2026-10-20" });
    const session = await startMock(services, child.id, lesson.deckId);
    // Doprowadź do transform/gap i odpowiedz niedopasowanym tekstem → ścieżka modelu.
    let task: TaskDto | null = null;
    for (let i = 0; i < 20; i++) {
      const t = await nextTask(services, session.sessionId);
      if (!t) break;
      if (t.exerciseType === "lesson_transform") { task = t; break; }
      await answerCorrectly(services, t);
    }
    if (task) {
      const attempt = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she play" });
      expect(attempt.feedback).toBeNull(); // wynik ukryty
      expect(attempt.taskState).toBe("answered");
      const graded = (await pool.query<{ count: number }>(
        `select count(*)::int as count from learning_app.assessments a
           join learning_app.attempts p on p.id = a.attempt_id
          where p.task_id = $1`, [task.taskId])).rows[0]!.count;
      expect(graded).toBeGreaterThan(0);
    }
  });
});
