import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  acceptVerdictAsVariant,
  completePresentation,
  createChild,
  createServices,
  FakeAnswerGrader,
  loginParent,
  nextTask,
  setupParent,
  startSession,
  submitAttempt,
  type Services,
} from "@learning/server";
import {
  LessonDeckDtoSchema,
  ObjectiveProgressDtoSchema,
  LessonVerdictDtoSchema,
  type TaskDto,
} from "@learning/contracts";
import { lessonWorld } from "../fixtures/lesson-world";
import { testDatabase, truncateCoreTables, ManualClock } from "./helpers";
import { handleParentApi } from "./helpers";
import { errorResponse } from "../../apps/web/src/http/errors";

/**
 * Zadanie 16 (integracja HTTP): postęp celów rodzica (statusy, kategorie błędów
 * z przykładami TYLKO tego dziecka, wyczerpanie puli), lista werdyktów modelu,
 * decyzja rodzica (bez przeliczeń), dodanie wariantu, provider oceny, autoryzacja.
 */

const { pool } = testDatabase();
const BASE = "http://localhost:3000";

beforeEach(async () => {
  await truncateCoreTables();
  await pool.query(`truncate learning_app.child_objective_progress, learning_app.lesson_verdicts,
    learning_app.generation_runs, learning_app.revision_assets, learning_app.media_assets,
    learning_app.item_revision_skills, learning_app.item_revisions, learning_app.skill_versions,
    learning_app.learning_items, learning_app.deck_versions, learning_app.decks cascade`);
});
afterAll(() => pool.end());

function graderServices(grader: FakeAnswerGrader | null, clock = new ManualClock()): Services {
  const { db } = testDatabase();
  return createServices({
    db,
    clock,
    generation: {} as Parameters<typeof createServices>[0]["generation"],
    ...(grader ? { grader: { provider: grader, maxCallsPerSession: 20, timeoutMs: 8000 } } : {}),
  });
}

function call(
  services: Services,
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string | null; origin?: string | null } = {},
): Promise<Response> {
  const origin = options.origin === undefined ? BASE : options.origin;
  const headers: Record<string, string> = {};
  // jawny Host jak w żądaniu przyjmowanym przez serwer — router oRPC odtwarza
  // Request z samych nagłówków, więc kontrola Origin musi widzieć własnego hosta
  headers.host = "localhost:3000";
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (origin) headers.origin = origin;
  if (options.cookie) headers.cookie = `parent_session=${options.cookie}`;
  const request = new Request(`${BASE}/api/v1/parent/${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const segments = path.split("?")[0]!.split("/").filter((s) => s.length > 0);
  return handleParentApi(request, services, segments).catch((error) => errorResponse(error));
}

async function parentCookie(services: Services): Promise<string> {
  await setupParent(services, "sup-pin");
  const { token } = await loginParent(services, "sup-pin");
  return token;
}

const PRODUCTIVE = new Set(["lesson_gap", "lesson_error_fix", "lesson_transform", "lesson_open_answer"]);

async function seedPracticingProgress(childId: string, objectiveId: string, subjectId: string, topicId: string): Promise<void> {
  await pool.query(`insert into learning_app.child_objective_progress
    (child_id, subject_id, objective_id, topic_id, status, streak, projection_version)
    values ($1, $2, $3, $4, 'practicing', 1, 'proj-1')`, [childId, subjectId, objectiveId, topicId]);
}

async function answerKeyOf(taskId: string): Promise<Record<string, unknown>> {
  const rows = await pool.query<{ answerKey: Record<string, unknown> }>(
    `select answer_key as "answerKey" from learning_app.session_tasks where id = $1`, [taskId]);
  return rows.rows[0]!.answerKey;
}

async function answerCorrectly(services: Services, task: TaskDto): Promise<void> {
  const key = await answerKeyOf(task.taskId);
  if (task.exerciseType === "lesson_choice" || task.exerciseType === "lesson_short_answer" || task.exerciseType === "lesson_notice") {
    await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "choice", optionId: key.correctOptionId as string });
  } else if (task.exerciseType === "lesson_order") {
    await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "sequence", itemIds: key.itemIds as string[] });
  } else {
    await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: key.answer as string });
  }
}

/** Wydaje zadania do pierwszego ćwiczenia danego typu (awansując poprawnie). */
async function issueUntil(services: Services, sessionId: string, type: string, max = 40): Promise<TaskDto> {
  const advance = PRODUCTIVE.has(type);
  for (let i = 0; i < max; i++) {
    const task = await nextTask(services, sessionId);
    if (task === null) throw new Error(`sesja skończyła się przed ${type}`);
    if (task.exerciseType === "lesson_card") { await completePresentation(services, { taskId: task.taskId }); continue; }
    if (task.exerciseType === type) return task;
    if (advance) await answerCorrectly(services, task);
    else await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "skip" });
  }
  throw new Error(`nie doczekano ćwiczenia ${type}`);
}

describe("Parent supervision API (integracja HTTP)", () => {
  it("autoryzacja: 401 bez sesji, 403 bez Origin na mutacji", async () => {
    const services = graderServices(null);
    const cookie = await parentCookie(services);
    const child = await createChild(services, { displayName: "A", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, now: new Date() });

    const noSession = await call(services, "GET", `lessons/${lesson.deckId}/progress?childId=${child.id}`, { cookie: null });
    expect(noSession.status).toBe(401);
    const verdictNoSession = await call(services, "GET", `lessons/${lesson.deckId}/verdicts`, { cookie: null });
    expect(verdictNoSession.status).toBe(401);
    const crossOrigin = await call(services, "POST", `lesson-verdicts/${randomUUID()}/decision`, {
      body: { decision: "confirmed" }, cookie, origin: "https://attacker.example",
    });
    expect(crossOrigin.status).toBe(403);
  });

  it("provider oceny w DTO lekcji: dostępny z modelem / niedostępny bez sekretów", async () => {
    const withGrader = graderServices(new FakeAnswerGrader());
    const cookie = await parentCookie(withGrader);
    const child = await createChild(withGrader, { displayName: "A", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, now: new Date() });
    const dto = LessonDeckDtoSchema.parse(await (await call(withGrader, "GET", `lessons/${lesson.deckId}`, { cookie })).json());
    expect(dto.grading.available).toBe(true);
    expect(dto.grading.model).toBeTruthy();
    // Bez sekretów: żaden klucz/base-url nie wycieka.
    expect(JSON.stringify(dto.grading)).not.toMatch(/api[_-]?key|bearer|http/i);
  });

  it("postęp celów: status, kategorie błędów z przykładami tylko tego dziecka, drugie dziecko izolowane", async () => {
    const grader = new FakeAnswerGrader().onDefault({ raw: { verdict: "incorrect", errorCategory: "missing_ending", fragments: ["play"], note: "x" } });
    const services = graderServices(grader);
    const cookie = await parentCookie(services);
    const childA = await createChild(services, { displayName: "A", avatarKey: "owl" });
    const childB = await createChild(services, { displayName: "B", avatarKey: "cat" });
    const lesson = await lessonWorld(pool, { childId: childA.id, richPool: true, withObjectiveAssessment: true, now: new Date() });
    await seedPracticingProgress(childB.id, lesson.objectiveId, lesson.subjectId, lesson.topicId);
    await pool.query(`insert into learning_app.assignments (id, child_id, deck_id) values (gen_random_uuid(), $1, $2)`, [childB.id, lesson.deckId]);

    // Dziecko A popełnia błąd modelowy ("she play") na transformacie.
    const sA = await startSession(services, { childId: childA.id, deckId: lesson.deckId, microphoneEnabled: false });
    const tA = await issueUntil(services, sA.sessionId, "lesson_transform");
    await submitAttempt(services, { taskId: tA.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she play aaamarker" });

    // Dziecko B popełnia INNY błąd modelowy.
    const sB = await startSession(services, { childId: childB.id, deckId: lesson.deckId, microphoneEnabled: false });
    const tB = await issueUntil(services, sB.sessionId, "lesson_transform");
    await submitAttempt(services, { taskId: tB.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she play bbbmarker" });

    const res = await call(services, "GET", `lessons/${lesson.deckId}/progress?childId=${childA.id}`, { cookie });
    expect(res.status).toBe(200);
    const progress = ObjectiveProgressDtoSchema.array().parse(await res.json());
    const objective = progress.find((p) => p.objectiveId === lesson.objectiveId)!;
    expect(objective.titlePl).toBeTruthy();
    const err = objective.topErrors.find((e) => e.category === "missing_ending");
    expect(err).toBeTruthy();
    expect(err!.labelPl).toBeTruthy();
    // Przykłady TYLKO dziecka A — żadnej odpowiedzi dziecka B.
    const examplesJoined = err!.examples.join(" ").toLowerCase();
    expect(examplesJoined).toContain("aaamarker");
    expect(examplesJoined).not.toContain("bbbmarker");
  });

  it("werdykty: lista z flagą decyzji; decyzja NIE zmienia assessments ani child_objective_progress", async () => {
    const grader = new FakeAnswerGrader().onDefault({ raw: { verdict: "incorrect", errorCategory: "missing_ending", fragments: ["play"], note: "brak -s" } });
    const services = graderServices(grader);
    const cookie = await parentCookie(services);
    const child = await createChild(services, { displayName: "A", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, withObjectiveAssessment: true, now: new Date() });
    const session = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false });
    const task = await issueUntil(services, session.sessionId, "lesson_transform");
    await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she play" });

    const list = LessonVerdictDtoSchema.array().parse(await (await call(services, "GET", `lessons/${lesson.deckId}/verdicts`, { cookie })).json());
    expect(list.length).toBe(1);
    expect(list[0]!.parentDecision).toBeNull();
    expect(list[0]!.verdict).toBe("incorrect");
    expect(list[0]!.graderModel).toBeTruthy();
    expect(list[0]!.note).toBe("brak -s");
    const verdictId = list[0]!.id;

    const assessBefore = (await pool.query(`select to_jsonb(a) as row from learning_app.assessments a where a.child_id=$1 order by a.attempt_id`, [child.id])).rows;
    const progressBefore = (await pool.query(`select to_jsonb(p) as row from learning_app.child_objective_progress p where p.child_id=$1`, [child.id])).rows;

    const decided = await call(services, "POST", `lesson-verdicts/${verdictId}/decision`, { body: { decision: "overridden_correct" }, cookie });
    expect(decided.status).toBe(200);
    const decidedDto = LessonVerdictDtoSchema.parse(await decided.json());
    expect(decidedDto.parentDecision).toBe("overridden_correct");

    // assessments i child_objective_progress NIETKNIĘTE.
    const assessAfter = (await pool.query(`select to_jsonb(a) as row from learning_app.assessments a where a.child_id=$1 order by a.attempt_id`, [child.id])).rows;
    const progressAfter = (await pool.query(`select to_jsonb(p) as row from learning_app.child_objective_progress p where p.child_id=$1`, [child.id])).rows;
    expect(assessAfter).toEqual(assessBefore);
    expect(progressAfter).toEqual(progressBefore);

    // parent_decision zapisane w cache.
    const decisionRow = (await pool.query<{ parent_decision: string; parent_decided_at: Date | null }>(
      `select parent_decision, parent_decided_at from learning_app.lesson_verdicts where id=$1`, [verdictId])).rows[0]!;
    expect(decisionRow.parent_decision).toBe("overridden_correct");
    expect(decisionRow.parent_decided_at).not.toBeNull();
  });

  it("acceptVerdictAsVariant nie dopisuje wariantu redundantnego wobec odpowiedzi kanonicznej (pełna relacja równoważności)", async () => {
    const services = graderServices(null);
    // Szkic z ćwiczeniem otwartym o odpowiedzi z DWUZACZNYM skrótem („She's” → is|has).
    const lesson = await lessonWorld(pool, { now: new Date(), publish: false });
    await pool.query(
      `update learning_app.item_revisions set payload = $2::jsonb where id = $1`,
      [
        lesson.revisionId,
        JSON.stringify({
          exerciseType: "lesson_open_answer",
          objectiveId: lesson.objectiveId,
          instructionPl: "Przetłumacz zdanie na angielski.",
          prompt: "Ona jest spóźniona.",
          answer: "She's late.",
          acceptedAnswers: [],
          focus: ["late"],
        }),
      ],
    );
    const seedVerdict = async (normalizedAnswer: string): Promise<string> => {
      const id = randomUUID();
      await pool.query(
        `insert into learning_app.lesson_verdicts (id, item_revision_id, normalized_answer, prompt_version, grader_model, verdict)
         values ($1, $2, $3, 'pv-test', 'fake-grader', 'correct')`,
        [id, lesson.revisionId, normalizedAnswer],
      );
      return id;
    };

    // Kontrola pozytywna: werdykt nie równoważny żadnej sekwencji → wariant dopisany.
    const added = await acceptVerdictAsVariant(services, await seedVerdict("she is very late"));
    expect(added.added).toBe(true);

    // Werdykt równoważny DRUGIEJ sekwencji skrótu dwuznacznego: porównanie
    // pierwszej sekwencji (stare zachowanie) dopisałoby „she has late”, a taki
    // wariant zablokowałby publikację regułą duplikatu po normalizacji.
    const skipped = await acceptVerdictAsVariant(services, await seedVerdict("she has late"));
    expect(skipped.added).toBe(false);

    const [row] = (await pool.query<{ payload: { answer: string; acceptedAnswers: string[] } }>(
      "select payload from learning_app.item_revisions where id = $1",
      [lesson.revisionId],
    )).rows;
    expect(row!.payload.answer).toBe("She's late.");
    expect(row!.payload.acceptedAnswers).toEqual(["she is very late"]);
  });

  it("acceptVerdictAsVariant zachowuje explanationPl w przebudowanym payloadzie rewizji", async () => {
    const services = graderServices(null);
    const lesson = await lessonWorld(pool, { now: new Date(), publish: false });
    await pool.query(
      `update learning_app.item_revisions set payload = $2::jsonb where id = $1`,
      [
        lesson.revisionId,
        JSON.stringify({
          exerciseType: "lesson_open_answer",
          objectiveId: lesson.objectiveId,
          instructionPl: "Przetłumacz zdanie na angielski.",
          prompt: "Ona jest spóźniona.",
          answer: "She is late.",
          acceptedAnswers: [],
          focus: ["late"],
          explanationPl: "Po she używamy is, bo to trzecia osoba.",
        }),
      ],
    );
    const verdictId = randomUUID();
    await pool.query(
      `insert into learning_app.lesson_verdicts (id, item_revision_id, normalized_answer, prompt_version, grader_model, verdict)
       values ($1, $2, 'she is very late', 'pv-test', 'fake-grader', 'correct')`,
      [verdictId, lesson.revisionId],
    );
    expect((await acceptVerdictAsVariant(services, verdictId)).added).toBe(true);
    const [row] = (await pool.query<{ payload: { acceptedAnswers: string[]; explanationPl?: string } }>(
      "select payload from learning_app.item_revisions where id = $1",
      [lesson.revisionId],
    )).rows;
    expect(row!.payload.acceptedAnswers).toEqual(["she is very late"]);
    expect(row!.payload.explanationPl).toBe("Po she używamy is, bo to trzecia osoba.");
  });

  it.each([
    { initial: "incorrect", decision: "overridden_correct", feedback: "great", outcome: "correct" },
    // Nadpisanie bez kategorii i bez wyjaśnienia ćwiczenia: `incorrect` z correctText
    // (wcześniej `lesson_hint` bez `hintPl`, który łamał kontrakt Kid DTO; spec 2026-11-01 §4.2).
    { initial: "correct", decision: "overridden_incorrect", feedback: "incorrect", outcome: "incorrect" },
  ])("decyzja $decision działa dla przyszłej identycznej odpowiedzi bez ponownego modelu", async ({ initial, decision, feedback, outcome }) => {
    const grader = new FakeAnswerGrader().onDefault({ raw: { verdict: initial, errorCategory: initial === "correct" ? null : "missing_ending", fragments: initial === "correct" ? [] : ["play"], note: "x" } });
    const services = graderServices(grader);
    const cookie = await parentCookie(services);
    const childA = await createChild(services, { displayName: "A", avatarKey: "owl" });
    const childB = await createChild(services, { displayName: "B", avatarKey: "cat" });
    const lesson = await lessonWorld(pool, { childId: childA.id, richPool: true, withObjectiveAssessment: true, now: new Date() });
    await seedPracticingProgress(childB.id, lesson.objectiveId, lesson.subjectId, lesson.topicId);
    await pool.query(`insert into learning_app.assignments (id, child_id, deck_id) values (gen_random_uuid(), $1, $2)`, [childB.id, lesson.deckId]);
    const sA = await startSession(services, { childId: childA.id, deckId: lesson.deckId, microphoneEnabled: false });
    const tA = await issueUntil(services, sA.sessionId, "lesson_transform");
    await submitAttempt(services, { taskId: tA.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she play" });
    expect(grader.callCount).toBe(1);

    const verdictId = (await (await call(services, "GET", `lessons/${lesson.deckId}/verdicts`, { cookie })).json() as { id: string }[])[0]!.id;
    await call(services, "POST", `lesson-verdicts/${verdictId}/decision`, { body: { decision }, cookie });

    // Następna identyczna odpowiedź (inne dziecko) → werdykt z cache, decyzja nadrzędna, bez wołania modelu.
    const sB = await startSession(services, { childId: childB.id, deckId: lesson.deckId, microphoneEnabled: false });
    const tB = await issueUntil(services, sB.sessionId, "lesson_transform");
    const second = await submitAttempt(services, { taskId: tB.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she play" });
    expect(grader.callCount).toBe(1);
    expect(second.feedback?.kind).toBe(feedback);
    const outcomes = await pool.query("select outcome from learning_app.assessments where attempt_id=$1", [second.attemptId]);
    expect(outcomes.rows[0].outcome).toBe(outcome);
  });

  it("accept-as-variant dodaje wariant w szkicu; identyczna odpowiedź dopasowana deterministycznie po publikacji; idempotentne", async () => {
    const grader = new FakeAnswerGrader().onDefault({ raw: { verdict: "correct", errorCategory: null, fragments: [], note: "ok" } });
    const services = graderServices(grader);
    const cookie = await parentCookie(services);
    const child = await createChild(services, { displayName: "A", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, withObjectiveAssessment: true, now: new Date() });
    const session = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false });
    const task = await issueUntil(services, session.sessionId, "lesson_transform");
    // "she playz" — niedopasowane deterministycznie (focus plays), ocenione przez model jako correct.
    await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she playz" });
    const verdictId = (await (await call(services, "GET", `lessons/${lesson.deckId}/verdicts`, { cookie })).json() as { id: string; childAnswer: string }[])[0]!.id;

    const accepted = await call(services, "POST", `lesson-verdicts/${verdictId}/accept-as-variant`, { cookie });
    expect(accepted.status).toBe(200);
    const out = (await accepted.json()) as { deckVersionId: string; added: boolean };
    expect(out.added).toBe(true);

    // Wariant jest w acceptedAnswers ćwiczenia transform w szkicu.
    const draftDto = LessonDeckDtoSchema.parse(await (await call(services, "GET", `lessons/${lesson.deckId}`, { cookie })).json());
    const transform = draftDto.draft!.exercises.find((e) => e.exerciseType === "lesson_transform")!;
    expect(transform.acceptedAnswers.some((v) => v.includes("playz"))).toBe(true);

    // Idempotencja: drugie wywołanie nic nie dodaje.
    const again = await call(services, "POST", `lesson-verdicts/${verdictId}/accept-as-variant`, { cookie });
    const againOut = (await again.json()) as { added: boolean };
    expect(againOut.added).toBe(false);

    // Po publikacji szkicu: identyczna odpowiedź "she playz" dopasowana
    // DETERMINISTYCZNIE (great, bez wołania modelu). Pulę fixtury publikujemy
    // wprost w bazie (jak lessonWorld) — pokrycie etapu „independent” nie jest
    // tu przedmiotem testu i i tak było obejściem w fixturze.
    const draftId = draftDto.draft!.id;
    await pool.query(`update learning_app.deck_versions set state='published', published_at=now() where id=$1`, [draftId]);
    await pool.query(`update learning_app.decks set published_version_id=$1 where id=$2`, [draftId, lesson.deckId]);
    const callsBefore = grader.callCount;
    const child2 = await createChild(services, { displayName: "C", avatarKey: "cat" });
    await pool.query(`insert into learning_app.assignments (id, child_id, deck_id) values (gen_random_uuid(), $1, $2)`, [child2.id, lesson.deckId]);
    await seedPracticingProgress(child2.id, lesson.objectiveId, lesson.subjectId, lesson.topicId);
    const s2 = await startSession(services, { childId: child2.id, deckId: lesson.deckId, microphoneEnabled: false });
    const t2 = await issueUntil(services, s2.sessionId, "lesson_transform");
    const matched = await submitAttempt(services, { taskId: t2.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she playz" });
    expect(matched.feedback?.kind).toBe("great");
    expect(grader.callCount).toBe(callsBefore);
  });
});
