import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  completePresentation,
  createChild,
  createServices,
  FakeAnswerGrader,
  nextTask,
  readAttempt,
  startSession,
  submitAttempt,
  type AppError,
} from "@learning/server";
import { FeedbackDtoSchema, type AttemptInput, type TaskDto } from "@learning/contracts";
import { lessonWorld } from "../fixtures/lesson-world";
import { buildTestServices, testDatabase, truncateCoreTables } from "./helpers";

/**
 * Zadanie 15: ocena niedopasowanych odpowiedzi tekstowych przez model oceniający
 * (fake grader w `Services`), cache werdyktów (`lesson_verdicts`) z nadrzędnym
 * `parent_decision`, rezerwacja `processing` + budżet wywołań na sesję, retry przy
 * processing, leniwa finalizacja, limit, równoległe identyczne odpowiedzi.
 *
 * `lesson_transform` ma answer "she plays", focus ["plays"]; odpowiedź "she play"
 * (brak -s W focus) → `no_match` deterministyczny → ścieżka modelu.
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

/** Services z fake graderem (i obecnym `generation`, by selektor wydawał transform). */
function graderServices(
  grader: FakeAnswerGrader,
  opts: { startIso?: string; maxCallsPerSession?: number; timeoutMs?: number } = {},
): { services: Services; clock: Clock } {
  const { services, clock } = buildTestServices(opts.startIso);
  const withGrader = createServices({
    db: (services as unknown as { db: Parameters<typeof createServices>[0]["db"] }).db,
    clock,
    generation: {} as Parameters<typeof createServices>[0]["generation"],
    grader: { provider: grader, maxCallsPerSession: opts.maxCallsPerSession ?? 20, timeoutMs: opts.timeoutMs ?? 8000 },
  });
  return { services: withGrader, clock };
}

async function answerKeyOf(taskId: string): Promise<Record<string, unknown>> {
  const rows = await pool.query<{ answerKey: Record<string, unknown> }>(
    `select answer_key as "answerKey" from learning_app.session_tasks where id = $1`,
    [taskId],
  );
  return rows.rows[0]!.answerKey;
}

async function answerCorrectly(services: Services, task: TaskDto): Promise<void> {
  const key = await answerKeyOf(task.taskId);
  if (task.exerciseType === "lesson_choice" || task.exerciseType === "lesson_short_answer" || task.exerciseType === "lesson_notice") {
    await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "choice", optionId: key.correctOptionId as string });
    return;
  }
  if (task.exerciseType === "lesson_order") {
    await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "sequence", itemIds: key.itemIds as string[] });
    return;
  }
  await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: key.answer as string });
}

const PRODUCTIVE = new Set(["lesson_gap", "lesson_error_fix", "lesson_transform", "lesson_open_answer"]);

/** Wydaje zadania (awansując poprawnie przez wcześniejsze typy) aż `type` wyjdzie. */
async function issueUntil(services: Services, sessionId: string, type: string, max = 40): Promise<TaskDto> {
  const advance = PRODUCTIVE.has(type);
  for (let i = 0; i < max; i++) {
    const task = await nextTask(services, sessionId);
    if (task === null) throw new Error(`sesja skończyła się przed ${type}`);
    if (task.exerciseType === "lesson_card") {
      await completePresentation(services, { taskId: task.taskId });
      continue;
    }
    if (task.exerciseType === type) return task;
    if (advance) await answerCorrectly(services, task);
    else await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "skip" });
  }
  throw new Error(`nie doczekano ćwiczenia ${type}`);
}

async function newLesson(services: Services, clock: Clock, withPriorSuccess = false) {
  const child = await createChild(services, { displayName: "Grader", avatarKey: "owl" });
  const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, now: clock.now(), withObjectiveAssessment: withPriorSuccess });
  const session = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false });
  return { child, lesson, session };
}

async function seedPracticing(childId: string): Promise<void> {
  await pool.query(
    `insert into learning_app.child_objective_progress
       (child_id, subject_id, objective_id, topic_id, status, streak, projection_version)
     values ($1, 'english_grammar', 'english_grammar.present_simple.third_person_s', 'present_simple', 'practicing', 1, 'proj-1')`,
    [childId],
  );
}

async function verdictRows(): Promise<{ verdict: string; errorCategory: string | null; normalizedAnswer: string; parentDecision: string | null }[]> {
  const rows = await pool.query<{ verdict: string; error_category: string | null; normalized_answer: string; parent_decision: string | null }>(
    `select verdict, error_category, normalized_answer, parent_decision from learning_app.lesson_verdicts order by created_at`,
  );
  return rows.rows.map((r) => ({ verdict: r.verdict, errorCategory: r.error_category, normalizedAnswer: r.normalized_answer, parentDecision: r.parent_decision }));
}

async function graderCallsOf(sessionId: string): Promise<number> {
  const rows = await pool.query<{ context: { graderCalls?: number } }>(
    "select context from learning_app.learning_sessions where id = $1",
    [sessionId],
  );
  return rows.rows[0]!.context.graderCalls ?? 0;
}

async function reserveTransform(services: Services, sessionId: string): Promise<TaskDto> {
  return issueUntil(services, sessionId, "lesson_transform");
}

describe("model oceniający — mapowanie werdyktów", () => {
  it("verdict correct → great, zadanie answered, jedno wywołanie, wpis cache", async () => {
    const grader = new FakeAnswerGrader().onDefault({ raw: { verdict: "correct", errorCategory: null, fragments: [], note: "ok" } });
    const { services, clock } = graderServices(grader);
    const { child, session } = await newLesson(services, clock, true);
    const task = await reserveTransform(services, session.sessionId);
    const attempt = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she play" });
    expect(attempt.feedback?.kind).toBe("great");
    expect(attempt.taskState).toBe("answered");
    expect(grader.callCount).toBe(1);
    expect((await verdictRows()).length).toBe(1);
    // Regresja gramatyki: „Topic” w promptcie to tytuł tematu katalogu, jak przed migawką celu.
    const catalogTopic = services.subjects.getTopic("english_grammar", "present_simple", 1);
    expect(grader.requests[0]?.topicTitle).toBe(catalogTopic?.titlePl);
  });

  it("verdict almost → lesson_almost z fragmentami i correctText", async () => {
    const grader = new FakeAnswerGrader().onDefault({ raw: { verdict: "almost", errorCategory: null, fragments: ["she"], note: "typo" } });
    const { services, clock } = graderServices(grader);
    const { session } = await newLesson(services, clock, true);
    const task = await reserveTransform(services, session.sessionId);
    const attempt = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she play" });
    expect(attempt.feedback?.kind).toBe("lesson_almost");
    expect(attempt.feedback?.answerSegments?.length).toBeGreaterThan(0);
    expect(attempt.feedback?.correctText).toBeTruthy();
    expect(attempt.taskState).toBe("answered");
  });

  it("verdict incorrect z kategorią celu → lesson_hint z hintPl i fragmentami", async () => {
    const grader = new FakeAnswerGrader().onDefault({ raw: { verdict: "incorrect", errorCategory: "missing_ending", fragments: ["play"], note: "brak -s" } });
    const { services, clock } = graderServices(grader);
    const { child, session } = await newLesson(services, clock, true);
    const task = await reserveTransform(services, session.sessionId);
    const attempt = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she play" });
    expect(attempt.feedback?.kind).toBe("lesson_hint");
    expect(attempt.feedback?.hintPl).toBeTruthy();
    expect(attempt.feedback?.answerSegments?.length).toBeGreaterThan(0);
    expect(attempt.feedback?.correctText).toBeTruthy();
    // „play” → „plays”: słowo dziecka zaznaczone w całości, w poprawnej odpowiedzi brakujące „s”.
    expect(attempt.feedback?.answerSegments).toContainEqual({ text: "play", state: "pill" });
    expect(attempt.feedback?.correctSegments).toContainEqual({ text: "s", state: "pill" });
    expect(FeedbackDtoSchema.safeParse(attempt.feedback).success).toBe(true);
    expect(attempt.taskState).toBe("answered");
    const rows = await pool.query<{ outcome: string }>(
      "select outcome from learning_app.assessments where child_id = $1 and skill='objective'",
      [child.id],
    );
    expect(rows.rows.some((r) => r.outcome === "incorrect")).toBe(true);
  });

  it("verdict incorrect kategoria other → unevaluated (model_other), zadanie issued, correctText bez podpowiedzi celu", async () => {
    const grader = new FakeAnswerGrader().onDefault({ raw: { verdict: "incorrect", errorCategory: "other", fragments: [], note: "off topic" } });
    const { services, clock } = graderServices(grader);
    const { session } = await newLesson(services, clock, true);
    const task = await reserveTransform(services, session.sessionId);
    const attempt = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she play" });
    expect(attempt.feedback?.kind).toBe("incorrect");
    expect(attempt.feedback?.correctText).toBeTruthy();
    expect(attempt.taskState).toBe("issued");
  });

  it("invalid JSON (zły kształt) → unevaluated technical, bez wpisu cache, licznik zużyty", async () => {
    const grader = new FakeAnswerGrader().onDefault({ raw: { nope: true } });
    const { services, clock } = graderServices(grader);
    const { session } = await newLesson(services, clock, true);
    const task = await reserveTransform(services, session.sessionId);
    const attempt = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she play" });
    expect(attempt.feedback?.kind).toBe("not_assessed");
    expect(attempt.taskState).toBe("issued");
    expect((await verdictRows()).length).toBe(0);
    expect(await graderCallsOf(session.sessionId)).toBe(1);
  });

  it("kategoria spoza listy celu → odrzucona → unevaluated, bez cache", async () => {
    const grader = new FakeAnswerGrader().onDefault({ raw: { verdict: "incorrect", errorCategory: "not_a_real_category", fragments: [], note: "x" } });
    const { services, clock } = graderServices(grader);
    const { session } = await newLesson(services, clock, true);
    const task = await reserveTransform(services, session.sessionId);
    const attempt = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she play" });
    expect(attempt.feedback?.kind).toBe("not_assessed");
    expect((await verdictRows()).length).toBe(0);
  });

  it("wyjątek/timeout gradera → unevaluated technical, bez cache, licznik zużyty", async () => {
    const grader = new FakeAnswerGrader().onDefault({ error: "boom" });
    const { services, clock } = graderServices(grader);
    const { session } = await newLesson(services, clock, true);
    const task = await reserveTransform(services, session.sessionId);
    const attempt = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she play" });
    expect(attempt.feedback?.kind).toBe("not_assessed");
    expect((await verdictRows()).length).toBe(0);
    expect(await graderCallsOf(session.sessionId)).toBe(1);
  });
});

describe("cache werdyktów i parent_decision", () => {
  it("druga identyczna odpowiedź (inne dziecko) nie woła modelu — trafia w cache", async () => {
    const grader = new FakeAnswerGrader().onDefault({ raw: { verdict: "incorrect", errorCategory: "missing_ending", fragments: ["play"], note: "x" } });
    const { services, clock } = graderServices(grader);
    // JEDNA lekcja (ten sam item_revision_id) dla dwojga dzieci — klucz cache to
    // (item_revision_id, normalized_answer, prompt_version), więc cache dzieli się
    // tylko w obrębie tego samego ćwiczenia.
    const childA = await createChild(services, { displayName: "A", avatarKey: "owl" });
    const childB = await createChild(services, { displayName: "B", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: childA.id, richPool: true, now: clock.now(), withObjectiveAssessment: true });
    await seedPracticing(childB.id);
    await pool.query(
      `insert into learning_app.assignments (id, child_id, deck_id) values (gen_random_uuid(), $1, $2)`,
      [childB.id, lesson.deckId],
    );
    const sA = await startSession(services, { childId: childA.id, deckId: lesson.deckId, microphoneEnabled: false });
    const t1 = await reserveTransform(services, sA.sessionId);
    await submitAttempt(services, { taskId: t1.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she play" });
    expect(grader.callCount).toBe(1);

    const sB = await startSession(services, { childId: childB.id, deckId: lesson.deckId, microphoneEnabled: false });
    const t2 = await reserveTransform(services, sB.sessionId);
    const second = await submitAttempt(services, { taskId: t2.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she play" });
    expect(grader.callCount).toBe(1); // cache hit, no second call
    expect(second.feedback?.kind).toBe("lesson_hint");
    expect((await verdictRows()).length).toBe(1);
  });

  it("parent_decision overridden_correct nadrzędne nad zapisanym incorrect", async () => {
    const grader = new FakeAnswerGrader().onDefault({ raw: { verdict: "incorrect", errorCategory: "missing_ending", fragments: ["play"], note: "x" } });
    const { services, clock } = graderServices(grader);
    const childA = await createChild(services, { displayName: "A", avatarKey: "owl" });
    const childB = await createChild(services, { displayName: "B", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: childA.id, richPool: true, now: clock.now(), withObjectiveAssessment: true });
    await seedPracticing(childB.id);
    await pool.query(
      `insert into learning_app.assignments (id, child_id, deck_id) values (gen_random_uuid(), $1, $2)`,
      [childB.id, lesson.deckId],
    );
    const sA = await startSession(services, { childId: childA.id, deckId: lesson.deckId, microphoneEnabled: false });
    const t1 = await reserveTransform(services, sA.sessionId);
    await submitAttempt(services, { taskId: t1.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she play" });
    // rodzic nadpisuje werdykt
    await pool.query(
      "update learning_app.lesson_verdicts set parent_decision = 'overridden_correct', parent_decided_at = now()",
    );
    const sB = await startSession(services, { childId: childB.id, deckId: lesson.deckId, microphoneEnabled: false });
    const t2 = await reserveTransform(services, sB.sessionId);
    const second = await submitAttempt(services, { taskId: t2.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she play" });
    expect(second.feedback?.kind).toBe("great");
    expect(second.taskState).toBe("answered");
    expect(grader.callCount).toBe(1);
  });
});

describe("rezerwacja, budżet i leniwa finalizacja", () => {
  it("limit wywołań wyczerpany → unevaluated bez wywołania", async () => {
    const grader = new FakeAnswerGrader().onDefault({ raw: { verdict: "incorrect", errorCategory: "missing_ending", fragments: [], note: "x" } });
    const { services, clock } = graderServices(grader, { maxCallsPerSession: 0 });
    const { session } = await newLesson(services, clock, true);
    // gap jest wydawalny przy limicie 0 (nie jest typem zależnym od modelu w selekcji);
    // niedopasowana odpowiedź tekstowa i tak eskaluje do modelu PRZY OCENIE — ale
    // limit=0 blokuje wywołanie → unevaluated.
    const gap = await issueUntil(services, session.sessionId, "lesson_gap");
    const attempt = await submitAttempt(services, { taskId: gap.taskId, clientAttemptId: randomUUID(), modality: "text", text: "completely wrong" });
    expect(attempt.feedback?.kind).toBe("not_assessed");
    expect(grader.callCount).toBe(0);
  });

  it("retry przy processing → ten sam wynik bez drugiego wywołania i bez inkrementu", async () => {
    const grader = new FakeAnswerGrader().onDefault({ raw: { verdict: "incorrect", errorCategory: "missing_ending", fragments: ["play"], note: "x" } });
    const { services, clock } = graderServices(grader);
    const { session } = await newLesson(services, clock, true);
    const task = await reserveTransform(services, session.sessionId);
    const cid = randomUUID();
    const first = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: cid, modality: "text", text: "she play" });
    const again = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: cid, modality: "text", text: "she play" });
    expect(again.attemptId).toBe(first.attemptId);
    expect(grader.callCount).toBe(1);
    expect(await graderCallsOf(session.sessionId)).toBe(1);
  });

  it("równoległe identyczne odpowiedzi (dwoje dzieci, ta sama lekcja) → jeden wpis cache, ten sam werdykt", async () => {
    // Grader z opóźnieniem, by oba wywołania nałożyły się przed zapisem cache.
    const grader = new FakeAnswerGrader().onDefault({ raw: { verdict: "incorrect", errorCategory: "missing_ending", fragments: ["play"], note: "x" }, delayMs: 150 });
    const { services, clock } = graderServices(grader);
    const childA = await createChild(services, { displayName: "A", avatarKey: "owl" });
    const childB = await createChild(services, { displayName: "B", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: childA.id, richPool: true, now: clock.now(), withObjectiveAssessment: true });
    await seedPracticing(childB.id);
    await pool.query(`insert into learning_app.assignments (id, child_id, deck_id) values (gen_random_uuid(), $1, $2)`, [childB.id, lesson.deckId]);
    const sA = await startSession(services, { childId: childA.id, deckId: lesson.deckId, microphoneEnabled: false });
    const sB = await startSession(services, { childId: childB.id, deckId: lesson.deckId, microphoneEnabled: false });
    const tA = await reserveTransform(services, sA.sessionId);
    const tB = await reserveTransform(services, sB.sessionId);
    const [rA, rB] = await Promise.all([
      submitAttempt(services, { taskId: tA.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she play" }),
      submitAttempt(services, { taskId: tB.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she play" }),
    ]);
    // Jeden wpis cache (ON CONFLICT DO NOTHING), ten sam werdykt w obu ocenach.
    expect((await verdictRows()).length).toBe(1);
    expect(rA.feedback?.kind).toBe("lesson_hint");
    expect(rB.feedback?.kind).toBe("lesson_hint");
  });

  it("proces padł w trakcie processing → leniwa finalizacja po 60 s → nieocenione, zadanie issued", async () => {
    // Rezerwujemy processing wprost (jak crash po inkremencie, przed finalizacją),
    // potem przesuwamy zegar o >60 s i próbujemy ponownie — leniwa finalizacja domyka.
    const grader = new FakeAnswerGrader().onDefault({ raw: { verdict: "incorrect", errorCategory: "missing_ending", fragments: [], note: "x" } });
    const { services, clock } = graderServices(grader);
    const { session } = await newLesson(services, clock, true);
    const task = await reserveTransform(services, session.sessionId);
    // Wstaw osieroconą próbę processing wprost (symulacja crashu po rezerwacji).
    const revisionId = (await pool.query<{ item_revision_id: string }>(
      "select item_revision_id from learning_app.session_tasks where id = $1", [task.taskId])).rows[0]!.item_revision_id;
    const policyId = (await pool.query<{ policy_id: string }>(
      "select policy_id from learning_app.learning_sessions where id = $1", [session.sessionId])).rows[0]!.policy_id;
    await pool.query(
      `insert into learning_app.attempts (id, child_id, task_id, item_revision_id, client_attempt_id, request_hash, attempt_number, modality, state, answer, context, policy_id, received_at)
       values (gen_random_uuid(), $1, $2, $3, $4, 'h', 1, 'text', 'processing', '{"text":"she play"}'::jsonb, '{}'::jsonb, $5, $6)`,
      [session.childId, task.taskId, revisionId, randomUUID(), policyId, clock.now()],
    );
    clock.advanceMs(61_000);
    // Nowa odpowiedź na to samo zadanie: wstęp leniwie finalizuje osieroconą próbę.
    const after = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she play" });
    // Regresja: migawka prób sprzed leniwej finalizacji zwracała DTO osieroconej
    // próby (processing) zamiast przyjąć nową odpowiedź.
    expect(after.state).toBe("completed");
    expect(after.feedback?.kind).toBe("lesson_hint");
    const stale = await pool.query<{ state: string; feedback: { kind?: string } | null }>(
      "select state, feedback from learning_app.attempts where task_id = $1 order by received_at asc", [task.taskId]);
    expect(stale.rows[0]!.state).toBe("completed");
    expect(stale.rows[0]!.feedback?.kind).toBe("not_assessed");
  });
});

describe("brak modelu", () => {
  it("brak gradera w Services → niedopasowanie tekstowe = unevaluated, zadanie issued", async () => {
    // buildTestServices bez grader + bez generation: ale wtedy transform nie wyjdzie.
    // Używamy gap z odpowiedzią no_match: "completely wrong".
    const { services, clock } = buildTestServices();
    const child = await createChild(services, { displayName: "NoGrader", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, now: clock.now(), withObjectiveAssessment: true });
    const session = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false });
    const gap = await issueUntil(services, session.sessionId, "lesson_gap");
    const attempt = await submitAttempt(services, { taskId: gap.taskId, clientAttemptId: randomUUID(), modality: "text", text: "completely wrong" });
    expect(attempt.feedback?.kind).toBe("not_assessed");
    expect(attempt.taskState).toBe("issued");
    expect((await verdictRows()).length).toBe(0);
  });
});

describe("prywatność — note modelu i źródło oceny poza Kid DTO", () => {
  it("komentarz note modelu nie trafia do feedbacku dziecka", async () => {
    const grader = new FakeAnswerGrader().onDefault({ raw: { verdict: "incorrect", errorCategory: "missing_ending", fragments: ["play"], note: "SEKRETNY-KOMENTARZ-RODZICA" } });
    const { services, clock } = graderServices(grader);
    const { session } = await newLesson(services, clock, true);
    const task = await reserveTransform(services, session.sessionId);
    const attempt = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she play" });
    const raw = JSON.stringify(attempt.feedback);
    expect(raw).not.toContain("SEKRETNY-KOMENTARZ-RODZICA");
    for (const forbidden of ["objectiveId", "errorCategor", "verdict", "model_"]) {
      expect(raw).not.toContain(forbidden);
    }
    const read = await readAttempt(services, attempt.attemptId);
    expect(JSON.stringify(read.feedback)).not.toContain("SEKRETNY-KOMENTARZ-RODZICA");
  });
});

void (null as unknown as AttemptInput);
void (null as unknown as AppError);
