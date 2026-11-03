import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  completePresentation,
  createChild,
  createServices,
  deleteChild,
  endSession,
  FakeAnswerGrader,
  fakeGraderDeps,
  getLessonMockTestReport,
  listKidDecks,
  nextTask,
  readAttempt,
  readLessonMockTestSummary,
  startSession,
  submitAttempt,
  authorizeDisclosure,
  type AppError,
} from "@learning/server";
import type { AttemptInput, TaskDto } from "@learning/contracts";
import { lessonWorld } from "../fixtures/lesson-world";
import { buildTestServices, testDatabase, truncateCoreTables, type ManualClock } from "./helpers";

/**
 * Zadanie 13B: przyjęcie i ocena odpowiedzi w lekcji. Ocena deterministyczna
 * (`matchLessonAnswer`, typy zamknięte, sekwencja), kwalifikacja i projekcja
 * celu, feedback (great / lesson_almost / incorrect / not_assessed), idempotencja,
 * podsumowanie sesji, kaskada usunięcia profilu. Model oceniający i cache werdyktów
 * to zadanie 15 — brak dopasowania bez modelu => `unevaluated`, zadanie `issued`.
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

async function expectAppError(promise: Promise<unknown>, code: string): Promise<void> {
  await promise.then(
    () => {
      throw new Error(`Oczekiwano błędu ${code}, otrzymano sukces`);
    },
    (error: unknown) => {
      expect((error as AppError).code).toBe(code);
    },
  );
}

type Services = ReturnType<typeof buildTestServices>["services"];

/**
 * Services z „dostępnym” modelem oceniającym — selektor może wtedy wydawać typy
 * zależne od modelu (np. `lesson_transform`). Po zadaniu 15 `graderAvailable`
 * wynika z `services.grader` (nie z `generation`), więc wstrzykujemy FAKE grader.
 * `generation` zostaje, bo pierwotny helper 13B go dawał; ocena w tych testach i
 * tak biegnie deterministycznie (matchLessonAnswer) — grader nie jest wołany,
 * bo odpowiedzi są dopasowane albo literówkowe (nie `no_match`).
 */
function graderServices(startIso?: string): { services: Services; clock: ReturnType<typeof buildTestServices>["clock"] } {
  const { services, clock } = buildTestServices(startIso);
  const withGrader = createServices({
    db: (services as unknown as { db: Parameters<typeof createServices>[0]["db"] }).db,
    clock,
    generation: {} as Parameters<typeof createServices>[0]["generation"],
    grader: fakeGraderDeps(),
  });
  return { services: withGrader, clock };
}

/** Produktywne typy (etap productive) wymagają awansu z guided → odpowiadamy poprawnie. */
const PRODUCTIVE_TYPES = new Set(["lesson_gap", "lesson_error_fix", "lesson_transform", "lesson_open_answer"]);

/** Wydaje i kończy prezentacje/pośrednie ćwiczenia, aż `nextTask` zwróci wskazany typ. */
async function issueUntil(services: Services, sessionId: string, type: string, max = 30): Promise<TaskDto> {
  const advance = PRODUCTIVE_TYPES.has(type); // do productive trzeba awansować (poprawne odpowiedzi)
  for (let i = 0; i < max; i++) {
    const task = await nextTask(services, sessionId);
    if (task === null) throw new Error(`sesja skończyła się przed ${type}`);
    if (task.exerciseType === "lesson_card") {
      await completePresentation(services, { taskId: task.taskId });
      continue;
    }
    if (task.exerciseType === type) return task;
    if (advance) {
      await answerCorrectly(services, task);
    } else {
      await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "skip" });
    }
  }
  throw new Error(`nie doczekano ćwiczenia ${type}`);
}

/** Odpowiada POPRAWNIE na dowolne ćwiczenie, by cel awansował przez etapy. */
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

async function assessmentsFor(childId: string): Promise<{ outcome: string; reason: string | null; details: Record<string, unknown>; independent: boolean }[]> {
  const rows = await pool.query<{ outcome: string; reason: string | null; details: Record<string, unknown>; independent: boolean }>(
    `select a.outcome, a.reason, a.details, a.independent
       from learning_app.assessments a where a.child_id = $1 and a.skill = 'objective'
      order by a.outcome`,
    [childId],
  );
  return rows.rows;
}

async function progressRow(childId: string): Promise<{ status: string; streak: number; lastIndependentAt: string | null } | undefined> {
  const rows = await pool.query<{ status: string; streak: number; last_independent_at: Date | null }>(
    "select status, streak, last_independent_at from learning_app.child_objective_progress where child_id = $1",
    [childId],
  );
  const r = rows.rows[0];
  return r ? { status: r.status, streak: r.streak, lastIndependentAt: r.last_independent_at?.toISOString() ?? null } : undefined;
}

async function exposureKeys(childId: string): Promise<string[]> {
  const rows = await pool.query<{ targetKey: string }>(
    `select ee.target_key as "targetKey" from learning_app.event_exposures ee
       join learning_app.learning_events le on le.id = ee.event_id
      where ee.child_id = $1 and le.kind = 'feedback_issued' and le.sealed = true`,
    [childId],
  );
  return rows.rows.map((r) => r.targetKey);
}

/** Odczyt prywatnego answer_key wydanego zadania (do zbudowania odpowiedzi w teście). */
async function answerKeyOf(taskId: string): Promise<Record<string, unknown>> {
  const rows = await pool.query<{ answerKey: Record<string, unknown> }>(
    `select answer_key as "answerKey" from learning_app.session_tasks where id = $1`,
    [taskId],
  );
  return rows.rows[0]!.answerKey;
}

async function newLesson(services: Services, clock: ManualClock, withPriorSuccess = false) {
  const child = await createChild(services, { displayName: "Lekcja", avatarKey: "owl" });
  const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, now: clock.now(), withObjectiveAssessment: withPriorSuccess });
  const session = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false });
  return { child, lesson, session };
}

describe("ocena odpowiedzi w lekcji — typy zamknięte i sekwencja", () => {
  it("wybór poprawny → great, zadanie answered, ekspozycja przed DTO", async () => {
    const { services, clock } = buildTestServices();
    const { child, session } = await newLesson(services, clock);
    const task = await issueUntil(services, session.sessionId, "lesson_choice");
    const key = await answerKeyOf(task.taskId);
    const correctOptionId = key.correctOptionId as string;

    const attempt = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "choice", optionId: correctOptionId });
    expect(attempt.feedback?.kind).toBe("great");
    expect(attempt.taskState).toBe("answered");

    const rows = await assessmentsFor(child.id);
    expect(rows.some((r) => r.outcome === "correct")).toBe(true);
    expect((await exposureKeys(child.id)).length).toBeGreaterThan(0);
  });

  it("wybór niepoprawny → incorrect z correctText, zadanie answered", async () => {
    const { services, clock } = buildTestServices();
    const { child, session } = await newLesson(services, clock);
    const task = await issueUntil(services, session.sessionId, "lesson_choice");
    const key = await answerKeyOf(task.taskId);
    const options = (task.prompt as { options: { id: string }[] }).options;
    const wrongId = options.find((o) => o.id !== key.correctOptionId)!.id;

    const attempt = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "choice", optionId: wrongId });
    expect(attempt.feedback?.kind).toBe("incorrect");
    expect(attempt.feedback?.correctText).toBeTruthy();
    expect(attempt.taskState).toBe("answered");
    const rows = await assessmentsFor(child.id);
    expect(rows.some((r) => r.outcome === "incorrect")).toBe(true);
  });

  it("sekwencja poprawna → great; zła kolejność → incorrect", async () => {
    const { services, clock } = buildTestServices();
    const { session } = await newLesson(services, clock);
    const task = await issueUntil(services, session.sessionId, "lesson_order");
    const key = await answerKeyOf(task.taskId);
    const itemIds = key.itemIds as string[];

    const good = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "sequence", itemIds });
    expect(good.feedback?.kind).toBe("great");
    expect(good.taskState).toBe("answered");

    // nowa sesja/zadanie dla złej kolejności
    const second = await newLesson(services, clock);
    const task2 = await issueUntil(services, second.session.sessionId, "lesson_order");
    const key2 = await answerKeyOf(task2.taskId);
    const reversed = [...(key2.itemIds as string[])].reverse();
    const bad = await submitAttempt(services, { taskId: task2.taskId, clientAttemptId: randomUUID(), modality: "sequence", itemIds: reversed });
    expect(bad.feedback?.kind).toBe("incorrect");
    expect(bad.taskState).toBe("answered");
  });
});

describe("ocena odpowiedzi w lekcji — typy tekstowe (luka)", () => {
  it("luka exact → great", async () => {
    const { services, clock } = buildTestServices();
    const { session } = await newLesson(services, clock, true);
    const task = await issueUntil(services, session.sessionId, "lesson_gap");
    const attempt = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: "goes" });
    expect(attempt.feedback?.kind).toBe("great");
    expect(attempt.taskState).toBe("answered");
  });

  it("literówka w focus → no_match → unevaluated, zadanie issued, bez ekspozycji", async () => {
    // Literówka POZA focus → lesson_almost i reguła zaliczona jest dowiedziona
    // na poziomie domeny (evaluate.test: minor_typo). Tu dowodzimy ścieżki HTTP:
    // gap ma answer "goes", focus ["goes"] (jeden token) — literówka "gose" pada
    // w focus, więc dopasowanie to no_match → unevaluated, zadanie zostaje issued.
    const { services, clock } = buildTestServices();
    const { session } = await newLesson(services, clock, true);
    const task = await issueUntil(services, session.sessionId, "lesson_gap");
    const before = (await exposureKeys(session.childId)).length;
    const attempt = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: "gose" });
    expect(attempt.feedback?.kind).toBe("not_assessed");
    expect(attempt.taskState).toBe("issued");
    // not_assessed niczego nie ujawnia: brak NOWEJ ekspozycji feedbacku
    expect((await exposureKeys(session.childId)).length).toBe(before);
  });

  it("literówka poza focus na ćwiczeniu tekstowym → lesson_almost z answerSegments", async () => {
    // `lesson_transform` jest typem zależnym od modelu w SELEKCJI — bez „dostępnego”
    // modelu selektor go deprioryzuje; grader'em włączamy jego wydanie, ale OCENA i
    // tak biegnie deterministycznie (matchLessonAnswer), bo port grader'a to zadanie 15.
    const { services, clock } = graderServices();
    const { session } = await newLesson(services, clock, true);
    const task = await issueUntil(services, session.sessionId, "lesson_transform");
    // transform answer "she plays", focus ["plays"]; literówka w "she" (poza focus)
    const attempt = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: "shee plays" });
    expect(attempt.feedback?.kind).toBe("lesson_almost");
    expect(attempt.feedback?.answerSegments?.length).toBeGreaterThan(0);
    expect(attempt.feedback?.correctText).toBeTruthy();
    // Zaznaczona tylko zbędna litera; w poprawnej odpowiedzi nie ma czego zaznaczyć.
    expect(attempt.feedback?.answerSegments).toContainEqual({ text: "e", state: "pill" });
    expect(attempt.feedback?.correctSegments).toBeUndefined();
    expect(attempt.taskState).toBe("answered");
  });

  it("brak dopasowania bez modelu → unevaluated (technical, verdict unavailable), zadanie issued", async () => {
    const { services, clock } = buildTestServices();
    const { child, session } = await newLesson(services, clock, true);
    const task = await issueUntil(services, session.sessionId, "lesson_gap");
    const attempt = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: "completely wrong" });
    expect(attempt.feedback?.kind).toBe("not_assessed");
    expect(attempt.taskState).toBe("issued");
    const rows = await assessmentsFor(child.id);
    const unevaluated = rows.find((r) => r.outcome === "unassessed");
    expect(unevaluated).toBeTruthy();
    expect(unevaluated!.reason).toBe("technical");
    expect(unevaluated!.details.verdict).toBe("unavailable");
  });

  it("skip nie tworzy oceny, a dont_remember nie dopisuje wsparcia do stałej listy", async () => {
    const { services, clock } = buildTestServices();
    const { child, session } = await newLesson(services, clock, true);
    const gap = await issueUntil(services, session.sessionId, "lesson_gap");
    const skip = await submitAttempt(services, { taskId: gap.taskId, clientAttemptId: randomUUID(), modality: "skip" });
    expect(skip.taskState).toBe("skipped");

    const second = await newLesson(services, clock, true);
    const gap2 = await issueUntil(services, second.session.sessionId, "lesson_gap");
    const savedPlan = await pool.query<{ training_plan: { slots: Array<{ taskId: string }> } }>(
      "select training_plan from learning_app.learning_sessions where id=$1", [second.session.sessionId],
    );
    const dr = await submitAttempt(services, { taskId: gap2.taskId, clientAttemptId: randomUUID(), modality: "dont_remember" });
    expect(dr.feedback?.kind).toBe("incorrect");
    expect(dr.feedback?.correctText).toBeTruthy();
    expect(dr.taskState).toBe("answered");
    const rows = await assessmentsFor(second.child.id);
    expect(rows.some((r) => r.outcome === "incorrect" && r.reason === "dont_remember")).toBe(true);
    const next = await nextTask(services, second.session.sessionId);
    expect(next?.taskId).toBe(savedPlan.rows[0]!.training_plan.slots[gap2.ordinal + 1]?.taskId);
    expect(next?.exerciseType).not.toBe("lesson_card");
    void child;
  });
});

/** Czy ćwiczenie jest produktywne (etap productive) — niezależnie oceniane. */
const PRODUCTIVE_TASK_TYPES = new Set(["lesson_gap", "lesson_error_fix", "lesson_transform", "lesson_open_answer"]);

/**
 * Prowadzi sesję, odpowiadając POPRAWNIE na każde ćwiczenie, aż `nextTask`
 * zwróci null albo cel osiągnie `stopStatus`. Zwraca zbiór RÓŻNYCH itemId
 * ćwiczeń produktywnych rozwiązanych NIEZALEŻNIE (independent=true) poprawnie.
 */
async function driveSessionCorrectly(
  services: Services,
  sessionId: string,
  childId: string,
  stopStatus?: string,
  max = 40,
): Promise<Set<string>> {
  const independentProductiveItems = new Set<string>();
  for (let i = 0; i < max; i++) {
    const task = await nextTask(services, sessionId);
    if (task === null) break;
    if (task.exerciseType === "lesson_card") {
      await completePresentation(services, { taskId: task.taskId });
      continue;
    }
    await answerCorrectly(services, task);
    if (PRODUCTIVE_TASK_TYPES.has(task.exerciseType)) {
      const row = await pool.query<{ independent: boolean; item_id: string }>(
        `select a.independent, st.item_revision_id as item_id from learning_app.assessments a
           join learning_app.attempts at on at.id = a.attempt_id
           join learning_app.session_tasks st on st.id = at.task_id
          where st.id = $1 and a.outcome = 'correct'`,
        [task.taskId],
      );
      if (row.rows[0]?.independent) independentProductiveItems.add(row.rows[0].item_id);
    }
    if (stopStatus) {
      const p = await progressRow(childId);
      if (p?.status === stopStatus) break;
    }
  }
  return independentProductiveItems;
}

describe("kwalifikacja i projekcja celu", () => {
  it("guided (choice) nigdy niezależne; produktywne (gap) na niewidzianym → niezależne", async () => {
    const { services, clock } = buildTestServices();
    const { child, session } = await newLesson(services, clock);
    const choice = await issueUntil(services, session.sessionId, "lesson_choice");
    const key = await answerKeyOf(choice.taskId);
    await submitAttempt(services, { taskId: choice.taskId, clientAttemptId: randomUUID(), modality: "choice", optionId: key.correctOptionId as string });

    await endSession(services, session.sessionId);
    const deckId = (await pool.query<{ deck_id: string }>("select deck_id from learning_app.learning_sessions where id=$1", [session.sessionId])).rows[0]!.deck_id;
    const nextSession = await startSession(services, { childId: child.id, deckId, microphoneEnabled: false });
    const gap = await issueUntil(services, nextSession.sessionId, "lesson_gap");
    await submitAttempt(services, { taskId: gap.taskId, clientAttemptId: randomUUID(), modality: "text", text: "goes" });

    const rows = await pool.query<{ independent: boolean; exercise_type: string }>(
      `select a.independent, st.exercise_type from learning_app.assessments a
         join learning_app.attempts at on at.id = a.attempt_id
         join learning_app.session_tasks st on st.id = at.task_id
        where a.child_id = $1 and a.outcome = 'correct'`,
      [child.id],
    );
    const byType = new Map(rows.rows.map((r) => [r.exercise_type, r.independent]));
    expect(byType.get("lesson_choice")).toBe(false); // guided (options) → assisted
    expect(byType.get("lesson_gap")).toBe(true); // produktywne na niewidzianym

    // Projekcja celu: niezależny sukces zapisuje wiersz child_objective_progress
    // ze statusem słownika bazy (learning→practicing) i last_independent_at.
    const progress = await progressRow(child.id);
    expect(progress).toBeDefined();
    expect(["practicing", "needs_confirmation", "mastered"]).toContain(progress!.status);
    expect(progress!.lastIndependentAt).not.toBeNull();
  });

  it("podpowiedź dla zadania zamkniętego (lesson_choice) → 409 bez zdarzenia i ekspozycji", async () => {
    const { services, clock } = buildTestServices();
    const { session } = await newLesson(services, clock);
    const choice = await issueUntil(services, session.sessionId, "lesson_choice");
    await expect(authorizeDisclosure(services, { taskId: choice.taskId, kind: "hint" })).rejects.toMatchObject({ code: "conflict" });
    const events = await pool.query("select id from learning_app.learning_events where task_id = $1 and kind = 'hint_issued'", [choice.taskId]);
    expect(events.rows).toHaveLength(0);
  });

  it("odsłuch odpowiedzi przed odpowiedzią → zależne", async () => {
    const { services, clock } = buildTestServices();
    const { child, session } = await newLesson(services, clock, true);
    const gap = await issueUntil(services, session.sessionId, "lesson_gap");
    // odsłuch (hint) psuje niezależność
    await authorizeDisclosure(services, { taskId: gap.taskId, kind: "hint" });
    await submitAttempt(services, { taskId: gap.taskId, clientAttemptId: randomUUID(), modality: "text", text: "goes" });
    const correct = await pool.query<{ independent: boolean }>(
      "select independent from learning_app.assessments where attempt_id in (select id from learning_app.attempts where task_id=$1) and outcome='correct'",
      [gap.taskId],
    );
    expect(correct.rows).toEqual([{ independent: false }]);
  });
});

describe("opanowanie celu end-to-end (projekcja HTTP, kontrolowany zegar)", () => {
  it("opanowuje cel po sukcesach na różnych ćwiczeniach i potwierdzeniu po przerwie", async () => {
    const { services, clock } = buildTestServices("2026-10-10T08:00:00.000Z");
    const child = await createChild(services, { displayName: "Opanowanie", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, now: clock.now() });

    // Sesja 1 rzeczywiście zapisuje sukcesy guided dla nowego celu.
    const s1 = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false });
    await driveSessionCorrectly(services, s1.sessionId, child.id);
    expect((await progressRow(child.id))!.status).toBe("practicing");
    await endSession(services, s1.sessionId);

    // Następna sesja planuje dwa niezależne zadania productive, a zachowuje
    // trzecie niewidziane na należne sprawdzenie w późniejszej sesji.
    clock.advanceHours(1);
    const s2 = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false });
    const distinct2 = await driveSessionCorrectly(services, s2.sessionId, child.id);
    expect(distinct2.size).toBeGreaterThanOrEqual(2);
    expect((await progressRow(child.id))!.status).not.toBe("mastered");
    await endSession(services, s2.sessionId);

    // Niewidziane ćwiczenie umożliwia niezależne potwierdzenie po przerwie.
    clock.advanceHours(26);
    const s3 = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false });
    await driveSessionCorrectly(services, s3.sessionId, child.id, "mastered");
    expect((await progressRow(child.id))!.status).toBe("mastered");

    const decks = await listKidDecks(services, child.id);
    const lessonDeck = decks.find((d) => d.deckId === lesson.deckId)!;
    expect(lessonDeck.independentlyRecalledCount).toBe(1);
  });

  it("powtórny sukces na TYM SAMYM ćwiczeniu nie potwierdza opanowania (wymagane różne ćwiczenia)", async () => {
    const { services, clock } = buildTestServices("2026-10-10T08:00:00.000Z");
    const child = await createChild(services, { displayName: "Powtórka", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, now: clock.now() });
    await pool.query(`insert into learning_app.child_objective_progress
      (child_id, subject_id, objective_id, topic_id, status, streak, projection_version)
      values ($1, $2, $3, $4, 'practicing', 1, 'proj-1')`,
    [child.id, lesson.subjectId, lesson.objectiveId, lesson.topicId]);

    const s1 = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false });
    const distinct1 = await driveSessionCorrectly(services, s1.sessionId, child.id);
    const seenItem = [...distinct1][0]!; // ćwiczenie produktywne już rozwiązane w sesji 1
    expect(["practicing", "needs_confirmation", "needs_reconfirmation"]).toContain((await progressRow(child.id))!.status);
    await endSession(services, s1.sessionId);
    clock.advanceHours(26);

    // Sesja 2: potwierdzaj WYŁĄCZNIE na ćwiczeniu już widzianym (ten sam itemId),
    // resztę pomijaj. Powtórka nie wchodzi do okna RÓŻNYCH ćwiczeń → NIE mastered.
    const s2 = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false });
    for (let i = 0; i < 16; i++) {
      const task = await nextTask(services, s2.sessionId);
      if (task === null) break;
      if (task.exerciseType === "lesson_card") { await completePresentation(services, { taskId: task.taskId }); continue; }
      const itemId = (await pool.query<{ item_id: string }>(
        `select ir.item_id from learning_app.session_tasks st
           join learning_app.item_revisions ir on ir.id = st.item_revision_id where st.id = $1`, [task.taskId])).rows[0]!.item_id;
      if (itemId === seenItem && PRODUCTIVE_TASK_TYPES.has(task.exerciseType)) {
        await answerCorrectly(services, task);
      } else {
        await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "skip" });
      }
    }
    expect((await progressRow(child.id))!.status).not.toBe("mastered");
  });
});

describe("idempotencja", () => {
  it("ten sam clientAttemptId → ten sam wynik; inna treść → 409", async () => {
    const { services, clock } = buildTestServices();
    const { session } = await newLesson(services, clock, true);
    const gap = await issueUntil(services, session.sessionId, "lesson_gap");
    const cid = randomUUID();
    const first = await submitAttempt(services, { taskId: gap.taskId, clientAttemptId: cid, modality: "text", text: "goes" });
    const again = await submitAttempt(services, { taskId: gap.taskId, clientAttemptId: cid, modality: "text", text: "goes" });
    expect(again.attemptId).toBe(first.attemptId);

    await expectAppError(
      submitAttempt(services, { taskId: gap.taskId, clientAttemptId: cid, modality: "text", text: "different" }),
      "conflict",
    );
  });

  it("odpowiedź dla zadania answered nie tworzy nowej próby", async () => {
    const { services, clock } = buildTestServices();
    const { session } = await newLesson(services, clock);
    const choice = await issueUntil(services, session.sessionId, "lesson_choice");
    const key = await answerKeyOf(choice.taskId);
    await submitAttempt(services, { taskId: choice.taskId, clientAttemptId: randomUUID(), modality: "choice", optionId: key.correctOptionId as string });
    await expectAppError(
      submitAttempt(services, { taskId: choice.taskId, clientAttemptId: randomUUID(), modality: "choice", optionId: key.correctOptionId as string }),
      "conflict",
    );
  });
});

describe("feedback i prywatność Kid DTO", () => {
  it("Kid feedback nie ujawnia focus/objective/kategorii/źródła oceny", async () => {
    const { services, clock } = buildTestServices();
    const { session } = await newLesson(services, clock, true);
    const gap = await issueUntil(services, session.sessionId, "lesson_gap");
    const attempt = await submitAttempt(services, { taskId: gap.taskId, clientAttemptId: randomUUID(), modality: "text", text: "goes" });
    const raw = JSON.stringify(attempt.feedback);
    for (const forbidden of ["focus", "objectiveId", "errorCategor", "verdict", "typoToken"]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("retry (GET attempt) zwraca ten sam feedback i ponownie pieczętuje ekspozycję", async () => {
    const { services, clock } = buildTestServices();
    const { child, session } = await newLesson(services, clock);
    const choice = await issueUntil(services, session.sessionId, "lesson_choice");
    const key = await answerKeyOf(choice.taskId);
    const submitted = await submitAttempt(services, { taskId: choice.taskId, clientAttemptId: randomUUID(), modality: "choice", optionId: key.correctOptionId as string });
    const before = (await exposureKeys(child.id)).length;
    const read = await readAttempt(services, submitted.attemptId);
    expect(read.feedback).toEqual(submitted.feedback);
    expect((await exposureKeys(child.id)).length).toBeGreaterThanOrEqual(before);
  });
});

describe("podsumowanie sesji lekcji", () => {
  it("endSession zwraca podsumowanie per cel; ponowny odczyt identyczny", async () => {
    const { services, clock } = buildTestServices();
    const { session } = await newLesson(services, clock);
    const choice = await issueUntil(services, session.sessionId, "lesson_choice");
    const key = await answerKeyOf(choice.taskId);
    await submitAttempt(services, { taskId: choice.taskId, clientAttemptId: randomUUID(), modality: "choice", optionId: key.correctOptionId as string });

    const summary = await endSession(services, session.sessionId);
    expect(summary.objectives).toBeDefined();
    expect(summary.objectives!.length).toBeGreaterThan(0);
    const obj = summary.objectives![0]!;
    expect(obj.practiced).toBeGreaterThan(0);
    expect(obj.correct).toBeGreaterThanOrEqual(1);
    expect(obj.titlePl).toBeTruthy();

    const again = await endSession(services, session.sessionId);
    expect(again).toEqual(summary);
  });
});

describe("kaskada usunięcia profilu", () => {
  it("usunięcie profilu kasuje próby, oceny i child_objective_progress", async () => {
    const { services, clock } = buildTestServices();
    const { child, session } = await newLesson(services, clock, true);
    const gap = await issueUntil(services, session.sessionId, "lesson_gap");
    await submitAttempt(services, { taskId: gap.taskId, clientAttemptId: randomUUID(), modality: "text", text: "goes" });
    expect(await progressRow(child.id)).toBeDefined();

    await deleteChild(services, child.id);
    const attempts = await pool.query<{ count: number }>("select count(*)::int as count from learning_app.attempts where child_id = $1", [child.id]);
    expect(attempts.rows[0]!.count).toBe(0);
    const assess = await pool.query<{ count: number }>("select count(*)::int as count from learning_app.assessments where child_id = $1", [child.id]);
    expect(assess.rows[0]!.count).toBe(0);
    expect(await progressRow(child.id)).toBeUndefined();
  });
});

describe("delegacja ścieżki prób po rodzaju zestawu (zadanie 9 review minor)", () => {
  it("próba na zadaniu lekcji przechodzi ścieżką lekcji (nie deck_kind_mismatch słówek)", async () => {
    const { services, clock } = buildTestServices();
    const { session } = await newLesson(services, clock, true);
    const gap = await issueUntil(services, session.sessionId, "lesson_gap");
    // Gdyby ścieżka słówek przejęła próbę lekcji, assertVocabularyDeck rzuciłby
    // deck_kind_mismatch. Delegacja do silnika lekcji daje poprawny feedback.
    const attempt = await submitAttempt(services, { taskId: gap.taskId, clientAttemptId: randomUUID(), modality: "text", text: "goes" });
    expect(attempt.feedback?.kind).toBe("great");
  });

  it("sekwencja na zadaniu słówkowym jest odrzucona (sequence tylko w lekcji)", async () => {
    const { services } = buildTestServices();
    const input: AttemptInput = { taskId: randomUUID(), clientAttemptId: randomUUID(), modality: "sequence", itemIds: [randomUUID()] };
    await expectAppError(submitAttempt(services, input), "not_found");
  });
});

/**
 * Review PR #51 — Grupa B (poprawki w lesson-attempts.ts): P1-3 CHECK przy
 * nieocenionej odpowiedzi, P1-4 lesson_order liczony jako samodzielny, P1-5
 * późna finalizacja modelu nadpisująca zamkniętą kartkówkę.
 */
describe("review P1-3: nieoceniona odpowiedź nie łamie CHECK (confirmationEligible=false)", () => {
  it("wybiera ćwiczenie niewidziane zamiast początku puli z poprzedniej sesji", async () => {
    const { services, clock } = buildTestServices();
    const child = await createChild(services, { displayName: "Historia", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, withObjectiveAssessment: true });
    const firstSession = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false });
    const first = await issueUntil(services, firstSession.sessionId, "lesson_gap");
    await submitAttempt(services, { taskId: first.taskId, clientAttemptId: randomUUID(), modality: "skip" });
    await endSession(services, firstSession.sessionId);
    clock.advanceMs(1000);
    const other = await createChild(services, { displayName: "Inne dziecko", avatarKey: "cat" });
    await pool.query("insert into learning_app.assignments(id,child_id,deck_id) values(gen_random_uuid(),$1,$2)", [other.id, lesson.deckId]);
    const otherSession = await startSession(services, { childId: other.id, deckId: lesson.deckId, microphoneEnabled: false });
    const row = (await pool.query("select id,payload from learning_app.item_revisions where deck_version_id=$1 and payload->>'exerciseType'='lesson_gap' order by position offset 1 limit 1", [lesson.versionId])).rows[0];
    await pool.query("insert into learning_app.session_tasks(id,session_id,child_id,deck_version_id,item_revision_id,ordinal,exercise_type,state,public_prompt,answer_key,issued_at) values(gen_random_uuid(),$1,$2,$3,$4,0,'lesson_gap','skipped',$5::jsonb,'{}'::jsonb,$6)",
      [otherSession.sessionId, other.id, lesson.versionId, row.id, JSON.stringify({ kind: "lesson_gap", instructionPl: "Uzupełnij", stemWithGap: row.payload.stem }), clock.now()]);
    const secondSession = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false });
    const next = await nextTask(services, secondSession.sessionId);
    expect(next?.exerciseType).toBe("lesson_gap");
    expect(next?.prompt).not.toEqual(first.prompt);
    expect(next?.prompt).toMatchObject({ stemWithGap: row.payload.stem }); // historia innego dziecka nie wpływa na kolejność
  });
  it.each([false, true])("odpowiedź nieoceniona po przerwie ≥12h (grader=%s) → zapis przechodzi, outcome unassessed", async (withModel) => {
    // previousSessionContactAt > 12h wcześniej sprawiłby, że confirmationEligible
    // policzyłby się na true. Bez gradera niedopasowany tekst → unevaluated
    // (dbOutcome 'unassessed'). CHECK assessments_unassessed_no_score wymaga
    // confirmation_eligible=false dla 'unassessed'; przed poprawką zapis rzucał 23514.
    const { services: baseServices, clock } = buildTestServices("2026-10-10T08:00:00.000Z");
    const services = withModel ? createServices({ db: baseServices.db, clock,
      grader: { provider: new FakeAnswerGrader().onDefault({ error: "offline" }), maxCallsPerSession: 20, timeoutMs: 8000 },
    }) : baseServices;
    const child = await createChild(services, { displayName: "Check", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, now: clock.now(), withObjectiveAssessment: true });

    // Sesja 1: dotknij celu (kontakt z celem), zakończ.
    const s1 = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false });
    const g1 = await issueUntil(services, s1.sessionId, "lesson_gap");
    await submitAttempt(services, { taskId: g1.taskId, clientAttemptId: randomUUID(), modality: "text", text: "goes" });
    await endSession(services, s1.sessionId);

    // Przerwa ≥12h i inny dzień lokalny → confirmationEligible policzy się na true.
    clock.advanceHours(26);

    // Sesja 2: niedopasowany tekst bez gradera → unevaluated. Zapis MUSI przejść.
    const s2 = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false });
    const g2 = await issueUntil(services, s2.sessionId, "lesson_gap");
    const attempt = await submitAttempt(services, { taskId: g2.taskId, clientAttemptId: randomUUID(), modality: "text", text: "completely wrong" });
    expect(attempt.feedback?.kind).toBe("not_assessed");
    expect(attempt.taskState).toBe("issued");

    const rows = await assessmentsFor(child.id);
    const unassessed = rows.find((r) => r.outcome === "unassessed");
    expect(unassessed).toBeTruthy();
    // Nieocenione jest neutralne: confirmation_eligible musi być false (inaczej CHECK).
    const raw = await pool.query<{ confirmation_eligible: boolean }>(
      `select a.confirmation_eligible from learning_app.assessments a where a.child_id = $1 and a.outcome = 'unassessed'`,
      [child.id],
    );
    expect(raw.rows[0]!.confirmation_eligible).toBe(false);
  });
});

describe("review P1-4: lesson_order prowadzony (klocki ujawnione) → zależne", () => {
  it("pierwsze poprawne ułożenie sekwencji → assessment independent=false, seria nie rośnie", async () => {
    const { services, clock } = buildTestServices();
    const { child, session } = await newLesson(services, clock);
    const order = await issueUntil(services, session.sessionId, "lesson_order");
    const key = await answerKeyOf(order.taskId);
    const attempt = await submitAttempt(services, {
      taskId: order.taskId,
      clientAttemptId: randomUUID(),
      modality: "sequence",
      itemIds: key.itemIds as string[],
    });
    expect(attempt.feedback?.kind).toBe("great");

    const rows = await pool.query<{ independent: boolean; exercise_type: string }>(
      `select a.independent, st.exercise_type from learning_app.assessments a
         join learning_app.attempts at on at.id = a.attempt_id
         join learning_app.session_tasks st on st.id = at.task_id
        where a.child_id = $1 and a.outcome = 'correct' and st.exercise_type = 'lesson_order'`,
      [child.id],
    );
    expect(rows.rows[0]).toBeTruthy();
    // Klocki (segmenty) podane dziecku = prowadzenie → nie liczy się jako niezależne.
    expect(rows.rows[0]!.independent).toBe(false);
  });
});

describe("review P1-5: późna finalizacja modelu nie nadpisuje zamkniętej kartkówki", () => {
  it.each([{ closed: false, readFirst: true }, { closed: true, readFirst: true }, { closed: false, readFirst: false }])("stale processing chroni slot i raport (closed=$closed, readFirst=$readFirst)", async ({ closed, readFirst }) => {
    const grader = new FakeAnswerGrader();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const original = grader.grade.bind(grader);
    grader.grade = async (input, signal) => { enter(); await released; return original(input, signal); };
    const { services: base, clock } = buildTestServices();
    const services = createServices({ db: base.db, clock, grader: { provider: grader, maxCallsPerSession: 20, timeoutMs: 8000 } });
    const child = await createChild(services, { displayName: "Recovery", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, testDate: "2026-10-20" });
    const session = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false, mode: "mock_test" });
    const task = await nextTask(services, session.sessionId);
    expect(task?.exerciseType).toBe("lesson_gap");
    const pending = submitAttempt(services, { taskId: task!.taskId, clientAttemptId: randomUUID(), modality: "text", text: "unmatched response" });
    await entered;
    try {
      const id = (await pool.query("select id from learning_app.attempts where task_id=$1", [task!.taskId])).rows[0].id as string;
      if (closed) await endSession(services, session.sessionId);
      clock.advanceMs(61_000);
      if (!readFirst) {
        await expectAppError(submitAttempt(services, { taskId: task!.taskId, clientAttemptId: randomUUID(), modality: "text", text: "goes" }), "conflict");
        const persisted = (await pool.query("select a.state as attempt_state, st.state as task_state from learning_app.attempts a join learning_app.session_tasks st on st.id=a.task_id where a.id=$1", [id])).rows[0];
        expect(persisted.attempt_state).toBe("completed");
        expect(persisted.task_state).toBe("answered");
      }
      const recovered = await readAttempt(services, id);
      expect(recovered.state).toBe("completed");
      expect(recovered.feedback).toBeNull();
      expect(recovered.taskState).toBe(closed ? "issued" : "answered");
      await expectAppError(submitAttempt(services, { taskId: task!.taskId, clientAttemptId: randomUUID(), modality: "text", text: "goes" }), "conflict");
      if (!closed) expect((await nextTask(services, session.sessionId))?.taskId).not.toBe(task!.taskId);
      else expect((await readLessonMockTestSummary(services, session.sessionId)).answeredCount).toBe(0);
    } finally { release(); await pending; }
  });
  it("endSession przed powrotem gradera → raport niezmieniony, omówienie zgodne (brak późnego correct)", async () => {
    // Fake grader z opóźnieniem: faza 1 rezerwuje próbę `processing`, grader śpi;
    // w tym czasie endSession utrwala NIEZMIENNY raport (slot unassessed); powrót
    // gradera (faza 2) NIE może dopisać correct ani zmienić zadania/projekcji.
    const grader = new FakeAnswerGrader();
    grader.onDefault({ raw: { verdict: "correct", errorCategory: null, fragments: [], note: "ok" } });
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const originalGrade = grader.grade.bind(grader);
    grader.grade = async (input, signal) => { enter(); await released; return originalGrade(input, signal); };
    const { services, clock } = buildTestServices();
    const withGrader = createServices({
      db: (services as unknown as { db: Parameters<typeof createServices>[0]["db"] }).db,
      clock,
      grader: { provider: grader, maxCallsPerSession: 20, timeoutMs: 8000 },
    });
    const child = await createChild(withGrader, { displayName: "Race", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, testDate: "2026-10-20" });
    const session = await startSession(withGrader, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false, mode: "mock_test" });

    // Doprowadź do slotu tekstowego (gap/transform), odpowiedz niedopasowanym
    // tekstem → eskalacja do modelu (verdict unavailable deterministycznie).
    let task: TaskDto | null = null;
    for (let i = 0; i < 20; i++) {
      const t = await nextTask(withGrader, session.sessionId);
      if (!t) break;
      if (t.exerciseType === "lesson_gap" || t.exerciseType === "lesson_transform") { task = t; break; }
      await submitAttempt(withGrader, { taskId: t.taskId, clientAttemptId: randomUUID(), modality: "skip" });
    }
    expect(task).not.toBeNull();

    // Uruchom próbę (model odpowie po 400 ms); NIE czekaj — w międzyczasie zamknij.
    const pending = submitAttempt(withGrader, { taskId: task!.taskId, clientAttemptId: randomUUID(), modality: "text", text: "almost correct answer" });
    await entered; // faza 1 jest utrwalona, grader czeka na jawną barierę
    try {
      const reserved = await pool.query("select state from learning_app.attempts where task_id=$1", [task!.taskId]);
      expect(reserved.rows[0].state).toBe("processing");
      await endSession(withGrader, session.sessionId);
    } finally { release(); }
    await pending; // faza 2 wraca po zamknięciu

    // Raport rodzica NIEZMIENIONY: żaden correct nie wszedł.
    clock.advanceMs(11 * 60_000);
    const report = await getLessonMockTestReport(withGrader, session.sessionId);
    expect(report.objectives.reduce((s, o) => s + o.correct, 0)).toBe(0);

    // Omówienie dziecka zgodne z utrwalonym raportem (brak późnego correct).
    const summary = await readLessonMockTestSummary(withGrader, session.sessionId);
    const answered = summary.solutions.find((sl) => sl.taskId === task!.taskId);
    expect(answered?.outcome).not.toBe("correct");
    const late = await pool.query("select count(*)::int as n from learning_app.assessments where child_id=$1 and outcome='correct'", [child.id]);
    expect(late.rows[0].n).toBe(0);
  });
});
