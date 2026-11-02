import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  LessonMockTestReportDtoSchema,
  LessonMockTestSummaryDtoSchema,
  messages,
  UuidSchema,
  type Assignment,
  type LessonExerciseTypeDto,
  type LessonMockTestReportDto,
  type LessonMockTestSummaryDto,
  type TaskDto,
  type TaskPrompt,
} from "@learning/contracts";
import type { Services } from "../../../config";
import type { Tx } from "../../../db/client";
import { attempts, deckVersions, eventExposures, itemRevisions, learningEvents, learningSessions, sessionTasks } from "../../../db/schema";
import { AppError } from "../../../errors";
import { fillCloze } from "../../../domain/lessons/cloze";
import { assignmentText } from "../../../domain/lessons/evaluate";
import { BASE_ERROR_CATEGORIES } from "../../../domain/lessons/base-error-categories";
import { planLessonMockTest, toLessonMockPoolEntry, type LessonMockPoolEntry } from "../../../domain/lessons/mock-test-plan";
import { mockPrecisionHint, objectivesWorthReviewing, schoolMockAggregate, type MockAnswerDetails, type MockPrecisionHint } from "../../../domain/lessons/mock-test-precision";
import type { LessonExerciseType, LessonTopic, SubjectModule } from "../../../domain/lessons/types";
import { writeSealedEvent } from "../events";
import { lessonContextOf, loadExercises, requireTopic } from "./lesson-sessions";
import { materializeExercise } from "./lesson-materialize";
import type { LessonMockSlot, LessonMockTestPlanSnapshot } from "../../../domain/mock-test-types";

export type { LessonMockSlot, LessonMockTestPlanSnapshot } from "../../../domain/mock-test-types";

/**
 * Próbna kartkówka lekcji po stronie serwera (zadanie 17, design „Kartkówka”,
 * requirements 9.1–9.4). Współdzieli mechanikę słówek przez te same punkty
 * wejścia w `sessions.ts`/`attempts.ts`: plan zamrożony w `mock_test_plan`
 * (dyskryminowany `kind:"lesson"`), jedna odpowiedź na slot kończy zadanie,
 * brak feedbacku w trakcie, limit 10 min, raport per cel utrwalony raz w
 * `context.lessonMockTestReport` (trigger czyni go niezmiennym — migracja 0008).
 */

/** Czy snapshot `mock_test_plan` jest planem lekcji (nie słówek). */
export function isLessonMockPlan(plan: unknown): plan is LessonMockTestPlanSnapshot {
  return typeof plan === "object" && plan !== null && (plan as { kind?: unknown }).kind === "lesson";
}

/**
 * Buduje zamrożony plan kartkówki lekcji: ładuje pulę przypiętej wersji, liczy
 * ujawnione `target_key` dziecka (ekspozycje zapieczętowane ≤ now), wybiera
 * bezpieczną porcję (`planLessonMockTest`) i materializuje każdy slot (prompt +
 * klucz) z fresh `taskId` i trybem kartkówki (bez podpowiedzi luki). Pusty plan
 * ⇒ wołający rzuca `mock_test_unavailable`.
 */
export async function createLessonMockTestPlan(
  tx: Tx,
  services: Services,
  input: { childId: string; deckVersionId: string; requestedTaskCount: number },
): Promise<LessonMockTestPlanSnapshot> {
  const version = (await tx.select().from(deckVersions).where(eq(deckVersions.id, input.deckVersionId)))[0]!;
  const context = lessonContextOf(version);
  const { subject, topic } = requireTopic(services, context);
  const exercises = await loadExercises(tx, input.deckVersionId, { feedbackAudio: false });

  const objectiveOrder = topic.objectives.map((o) => o.id).filter((id) => context.objectiveIds.includes(id));
  const pool: LessonMockPoolEntry[] = exercises.map((e) => toLessonMockPoolEntry({
    itemId: e.itemId,
    itemRevisionId: e.revisionId,
    objectiveId: e.payload.objectiveId,
    exerciseType: e.payload.exerciseType,
    targetKey: e.targetKey,
  }));

  const targetKeys = [...new Set(exercises.map((e) => e.targetKey))];
  const exposedRows = targetKeys.length
    ? await tx
        .selectDistinct({ targetKey: eventExposures.targetKey })
        .from(eventExposures)
        .innerJoin(learningEvents, eq(learningEvents.id, eventExposures.eventId))
        .where(
          and(
            eq(eventExposures.childId, input.childId),
            eq(learningEvents.sealed, true),
            lte(learningEvents.occurredAt, services.clock.now()),
            inArray(eventExposures.targetKey, targetKeys),
          ),
        )
    : [];
  const exposedTargetKeys = exposedRows.map((r) => r.targetKey);

  const planned = planLessonMockTest({
    pool,
    objectiveIds: objectiveOrder,
    requestedCount: input.requestedTaskCount,
    exposedTargetKeys,
  });

  const exerciseByRevision = new Map(exercises.map((e) => [e.revisionId, e] as const));
  const slots: LessonMockSlot[] = planned.map((item) => {
    const exercise = exerciseByRevision.get(item.itemRevisionId)!;
    const taskId = randomUUID();
    const materialized = materializeExercise(
      { independentCheck: true, reason: "mock-test" },
      taskId,
      exercise,
      topic,
      subject,
      { mockTest: true },
    );
    return {
      taskId,
      itemId: exercise.itemId,
      itemRevisionId: exercise.revisionId,
      objectiveId: item.objectiveId,
      exerciseType: item.exerciseType,
      targetKey: exercise.targetKey,
      prompt: materialized.prompt,
      answerKey: materialized.answerKey,
    };
  });

  return { kind: "lesson", version: 1, requestedTaskCount: input.requestedTaskCount, objectiveIds: objectiveOrder, slots };
}

/**
 * Czy istnieje bezpieczna porcja kartkówki lekcji dla dziecka (scope 6 —
 * `KidDeckDto.mockTestAvailable`). Reużywa planera bez utrwalania.
 */
export async function hasSafeLessonMockPortion(
  tx: Tx,
  services: Services,
  input: { childId: string; deckVersionId: string; requestedTaskCount: number },
): Promise<boolean> {
  const version = (await tx.select().from(deckVersions).where(eq(deckVersions.id, input.deckVersionId)))[0]!;
  const context = lessonContextOf(version);
  const { topic } = requireTopic(services, context);
  const objectiveOrder = topic.objectives.map((objective) => objective.id)
    .filter((id) => context.objectiveIds.includes(id));
  const rows = await tx.select({
    itemRevisionId: itemRevisions.id,
    itemId: itemRevisions.itemId,
    objectiveId: sql<string | null>`${itemRevisions.payload}->>'objectiveId'`,
    exerciseType: sql<string | null>`${itemRevisions.payload}->>'exerciseType'`,
    targetKey: itemRevisions.targetKey,
  }).from(itemRevisions)
    .where(eq(itemRevisions.deckVersionId, input.deckVersionId))
    .orderBy(asc(itemRevisions.position), asc(itemRevisions.id));
  const pool: LessonMockPoolEntry[] = rows.flatMap((row) => {
    if (!row.objectiveId || !row.exerciseType || !row.targetKey) return [];
    const exerciseType = row.exerciseType as LessonMockPoolEntry["exerciseType"];
    return [toLessonMockPoolEntry({
      itemId: row.itemId,
      itemRevisionId: row.itemRevisionId,
      objectiveId: row.objectiveId,
      exerciseType,
      targetKey: row.targetKey,
    })];
  });
  const targetKeys = [...new Set(pool.map((entry) => entry.targetKey))];
  const exposedRows = targetKeys.length
    ? await tx.selectDistinct({ targetKey: eventExposures.targetKey })
      .from(eventExposures)
      .innerJoin(learningEvents, eq(learningEvents.id, eventExposures.eventId))
      .where(and(
        eq(eventExposures.childId, input.childId),
        eq(learningEvents.sealed, true),
        lte(learningEvents.occurredAt, services.clock.now()),
        inArray(eventExposures.targetKey, targetKeys),
      ))
    : [];
  return planLessonMockTest({
    pool,
    objectiveIds: objectiveOrder,
    requestedCount: input.requestedTaskCount,
    exposedTargetKeys: exposedRows.map((row) => row.targetKey),
  }).length > 0;
}

/**
 * Wydaje kolejny slot kartkówki lekcji (mirror `issueMockTestTask` słówek):
 * idempotentnie zwraca wydane zadanie; inaczej bierze `slots[tasks.length]`,
 * wstawia `session_tasks` i pisze zapieczętowany `prompt_issued` z ekspozycją
 * issue-time (typy prowadzone ujawniają `target_key`, tekstowe []). `null` =
 * brak slotów (koniec kartkówki).
 */
export async function issueLessonMockTestTask(tx: Tx, services: Services, session: typeof learningSessions.$inferSelect): Promise<TaskDto | null> {
  const plan = session.mockTestPlan as unknown as LessonMockTestPlanSnapshot;
  const tasks = await tx.select().from(sessionTasks).where(eq(sessionTasks.sessionId, session.id)).orderBy(asc(sessionTasks.ordinal));
  const active = tasks.find((t) => t.state === "issued");
  if (active) {
    return {
      taskId: active.id,
      sessionId: session.id,
      ordinal: active.ordinal,
      exerciseType: active.exerciseType as TaskDto["exerciseType"],
      direction: null,
      state: "issued",
      prompt: active.publicPrompt as unknown as TaskDto["prompt"],
      remainingAssessed: session.taskBudget - active.ordinal,
    };
  }
  const slot = plan.slots[tasks.length];
  if (!slot) return null;
  const now = services.clock.now();
  await tx.insert(sessionTasks).values({
    id: slot.taskId,
    sessionId: session.id,
    childId: session.childId,
    deckVersionId: session.deckVersionId,
    itemRevisionId: slot.itemRevisionId,
    ordinal: tasks.length,
    exerciseType: slot.exerciseType,
    direction: null,
    state: "issued",
    publicPrompt: slot.prompt as unknown as Record<string, unknown>,
    answerKey: slot.answerKey,
    context: { reason: "mock-test", objectiveId: slot.objectiveId, independentCheck: false },
    issuedAt: now,
  });
  // Ekspozycja issue-time: typy prowadzone (notice/choice/short_answer/order)
  // ujawniają rozwiązanie w prompcie → pieczętujemy `target_key`; tekstowe nie.
  const guided = ["lesson_notice", "lesson_choice", "lesson_short_answer", "lesson_order", "lesson_match", "lesson_group", "lesson_cloze"].includes(slot.exerciseType);
  await writeSealedEvent(tx, {
    childId: session.childId,
    taskId: slot.taskId,
    itemId: slot.itemId,
    kind: "prompt_issued",
    stepId: `${slot.taskId}:prompt`,
    occurredAt: now,
    exposures: guided ? [slot.targetKey] : [],
  });
  return {
    taskId: slot.taskId,
    sessionId: session.id,
    ordinal: tasks.length,
    exerciseType: slot.exerciseType as TaskDto["exerciseType"],
    direction: null,
    state: "issued",
    prompt: slot.prompt,
    remainingAssessed: session.taskBudget - tasks.length,
  };
}

/** Etykiety kategorii dla celu: bazowe ∪ przedmiotu ∪ tematu, po kodzie. */
function categoryLabels(subject: SubjectModule, topic: LessonTopic): Map<string, string> {
  const labels = new Map<string, string>();
  for (const category of BASE_ERROR_CATEGORIES) labels.set(category.code, category.labelPl);
  for (const category of subject.errorCategories) labels.set(category.code, category.labelPl);
  for (const category of topic.extraErrorCategories) labels.set(category.code, category.labelPl);
  return labels;
}

interface AssessmentRow {
  taskId: string;
  objectiveId: string;
  state: string;
  outcome: string | null;
  verdict: string | null;
  verdictId: string | null;
  errorCategory: string | null;
  /** Szczegóły oceny (wymiar wiedzy i precyzji odpowiedzi otwartej szkoły). */
  details: MockAnswerDetails;
}

/** Zbiera oceny slotów kartkówki (jedna próba completed na slot). */
async function loadMockAssessments(tx: Tx, sessionId: string): Promise<Map<string, AssessmentRow>> {
  const tasks = await tx
    .select({ id: sessionTasks.id, state: sessionTasks.state, context: sessionTasks.context })
    .from(sessionTasks)
    .where(eq(sessionTasks.sessionId, sessionId));
  const byTask = new Map<string, AssessmentRow>();
  for (const t of tasks) {
    const objectiveId = (t.context as { objectiveId?: string } | null)?.objectiveId ?? "";
    byTask.set(t.id, { taskId: t.id, objectiveId, state: t.state, outcome: null, verdict: null, verdictId: null, errorCategory: null, details: {} });
  }
  const graded = await tx.execute<{ task_id: string; outcome: string; details: Record<string, unknown> }>(sql`
    select t.id as task_id, a.outcome, a.details
      from learning_app.session_tasks t
      join learning_app.attempts p on p.task_id = t.id and p.state = 'completed'
      join learning_app.assessments a on a.attempt_id = p.id and a.skill = 'objective'
    where t.session_id = ${sessionId}`);
  for (const g of graded.rows) {
    const row = byTask.get(g.task_id);
    if (!row) continue;
    const details = g.details as { objectiveId?: string; verdict?: string; verdictId?: string; errorCategory?: string };
    row.outcome = g.outcome;
    row.verdict = details.verdict ?? null;
    row.verdictId = details.verdictId ?? null;
    row.errorCategory = details.errorCategory ?? null;
    row.details = g.details as MockAnswerDetails;
    if (details.objectiveId) row.objectiveId = details.objectiveId;
  }
  return byTask;
}

/**
 * Zamyka kartkówkę lekcji wspólną ścieżką `closeMockTest` (komplet / timeout /
 * jawne przerwanie) i utrwala raport per cel RAZ w `context.lessonMockTestReport`
 * (trigger czyni go niezmiennym). `complete` = każdy slot terminalny.
 */
export async function closeLessonMockTest(tx: Tx, services: Services, session: typeof learningSessions.$inferSelect): Promise<LessonMockTestReportDto> {
  const saved = LessonMockTestReportDtoSchema.safeParse((session.context as { lessonMockTestReport?: unknown }).lessonMockTestReport);
  if (saved.success) {
    if (session.state === "active") {
      await tx.update(learningSessions).set({ state: "ended", endedAt: session.endedAt ?? services.clock.now() }).where(eq(learningSessions.id, session.id));
    }
    return saved.data;
  }
  const plan = session.mockTestPlan as unknown as LessonMockTestPlanSnapshot;
  const version = (await tx.select().from(deckVersions).where(eq(deckVersions.id, session.deckVersionId)))[0]!;
  const context = lessonContextOf(version);
  const { subject, topic } = requireTopic(services, context);
  const labels = categoryLabels(subject, topic);
  const titleOf = (objectiveId: string): string => topic.objectives.find((o) => o.id === objectiveId)?.titlePl ?? objectiveId;

  const byTask = await loadMockAssessments(tx, session.id);

  interface Acc {
    total: number; correct: number; incorrect: number; unassessed: number; skipped: number; modelGraded: number;
    errorCategories: Map<string, number>;
    answers: MockAnswerDetails[];
  }
  const accByObjective = new Map<string, Acc>();
  const ensure = (objectiveId: string): Acc => {
    let acc = accByObjective.get(objectiveId);
    if (!acc) { acc = { total: 0, correct: 0, incorrect: 0, unassessed: 0, skipped: 0, modelGraded: 0, errorCategories: new Map(), answers: [] }; accByObjective.set(objectiveId, acc); }
    return acc;
  };
  for (const objectiveId of plan.objectiveIds) ensure(objectiveId);

  let complete = true;
  for (const slot of plan.slots) {
    const row = byTask.get(slot.taskId);
    const acc = ensure(slot.objectiveId);
    acc.total += 1;
    if (!row || row.state === "issued") { complete = false; acc.unassessed += 1; continue; }
    if (row.state === "skipped") { acc.skipped += 1; continue; }
    acc.answers.push(row.details);
    const modelGraded = row.verdictId !== null || (row.verdict !== null && row.verdict.startsWith("model_"));
    if (modelGraded) acc.modelGraded += 1;
    if (row.outcome === "correct") acc.correct += 1;
    else if (row.outcome === "incorrect") {
      acc.incorrect += 1;
      if (row.errorCategory) acc.errorCategories.set(row.errorCategory, (acc.errorCategories.get(row.errorCategory) ?? 0) + 1);
    } else acc.unassessed += 1;
  }

  const objectives = [...accByObjective].map(([objectiveId, acc]) => {
    // Wymiar precyzji odpowiedzi otwartych szkoły (design §8.1), zamrażany z raportem.
    const school = schoolMockAggregate(acc.answers);
    return {
      objectiveId,
      titlePl: titleOf(objectiveId),
      total: acc.total,
      correct: acc.correct,
      incorrect: acc.incorrect,
      unassessed: acc.unassessed,
      skipped: acc.skipped,
      modelGraded: acc.modelGraded,
      errorCategories: [...acc.errorCategories].map(([category, count]) => ({ category, labelPl: labels.get(category) ?? category, count })),
      ...(school ? { school } : {}),
    };
  });

  const endedAt = session.endedAt ?? services.clock.now();
  // Stan utrwalany jak w słówkach (`closeMockTest`): komplet → `completed`,
  // niepełna (timeout/abort) → `ended`. Sesja już zakończona zachowuje swój stan.
  const state: "completed" | "ended" = session.state === "active" ? (complete ? "completed" : "ended") : (session.state as "completed" | "ended");
  const report = LessonMockTestReportDtoSchema.parse({
    sessionId: session.id,
    objectives,
    complete,
    taskBudget: session.taskBudget,
    startedAt: session.startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
  });
  await tx
    .update(learningSessions)
    .set({ ...(session.state === "active" ? { state, endedAt } : {}), context: { ...session.context, lessonMockTestReport: report } })
    .where(eq(learningSessions.id, session.id));
  return report;
}

/** Blokuje i zamyka terminalną sesję kartkówki lekcji (jak `terminalSession` słówek). */
async function terminalLessonSession(tx: Tx, services: Services, sessionId: string) {
  const [session] = await tx.select().from(learningSessions).where(eq(learningSessions.id, UuidSchema.parse(sessionId))).for("update");
  if (!session || session.mode !== "mock_test" || !isLessonMockPlan(session.mockTestPlan)) throw new AppError("not_found");
  if (session.state === "active" && services.clock.now().getTime() - session.startedAt.getTime() <= 600_000) {
    throw new AppError("conflict", { message: "Omówienie jest dostępne po zakończeniu kartkówki." });
  }
  const report = await closeLessonMockTest(tx, services, session);
  return { session, report };
}

export async function getLessonMockTestReport(services: Services, sessionId: string): Promise<LessonMockTestReportDto> {
  return services.db.transaction(async (tx) => (await terminalLessonSession(tx, services, sessionId)).report);
}

/** Teksty wskazówek precyzji w omówieniu (katalog komunikatów dziecka). */
const HINT_TEXT: Readonly<Record<MockPrecisionHint, string>> = {
  shorter: messages.kid.mockTestHintShorter,
  focus: messages.kid.mockTestHintFocus,
  missing: messages.kid.mockTestHintMissing,
};

/**
 * Omówienie kartkówki lekcji dla dziecka po zamknięciu (req 9.4, SPEC §19.1).
 * Pieczętuje ekspozycje (`feedback_issued` z `target_key`) PRZED zwróceniem, tak
 * jak słówka. Odpowiedź dziecka i poprawna odpowiedź jako tekst, prosty wynik;
 * przedmiot szkolny dokłada wskazówki precyzji i „Warto powtórzyć” (design §8).
 */
export async function readLessonMockTestSummary(services: Services, sessionId: string): Promise<LessonMockTestSummaryDto> {
  return services.db.transaction(async (tx) => {
    const { session, report } = await terminalLessonSession(tx, services, sessionId);
    const plan = session.mockTestPlan as unknown as LessonMockTestPlanSnapshot;
    const bySlot = new Map(plan.slots.map((s) => [s.taskId, s] as const));
    const tasks = await tx.select().from(sessionTasks).where(eq(sessionTasks.sessionId, session.id)).orderBy(asc(sessionTasks.ordinal));
    const byTask = await loadMockAssessments(tx, session.id);
    const version = (await tx.select().from(deckVersions).where(eq(deckVersions.id, session.deckVersionId)))[0]!;
    const context = lessonContextOf(version);
    const { subject, topic } = requireTopic(services, context);
    const titleOf = (objectiveId: string): string => topic.objectives.find((o) => o.id === objectiveId)?.titlePl ?? objectiveId;
    // Wskazówki i „Warto powtórzyć” dotyczą przedmiotów szkolnych (payload v3); gramatyka bez zmian.
    const schoolSubject = subject.usesV3Payload === true;

    const solutions: LessonMockTestSummaryDto["solutions"] = [];
    const reviewInputs: { objectiveId: string; outcome: LessonMockTestSummaryDto["solutions"][number]["outcome"]; knowledge: unknown }[] = [];
    let answeredCount = 0;
    const now = services.clock.now();
    for (const task of tasks) {
      const slot = bySlot.get(task.id);
      if (!slot) continue;
      const key = slot.answerKey as { targetKey?: string; answer?: string; correctOptionId?: string; optionValues?: Record<string, string>; segmentValues?: Record<string, string>; itemIds?: string[]; itemValues?: Record<string, string> };
      // Ekspozycja omówienia PRZED HTTP (jak słówka).
      await writeSealedEvent(tx, {
        childId: session.childId,
        taskId: task.id,
        itemId: slot.itemId,
        kind: "feedback_issued",
        stepId: `${session.id}:review:${task.ordinal}`,
        occurredAt: now,
        exposures: [slot.targetKey],
      });
      const row = byTask.get(task.id);
      const outcome: LessonMockTestSummaryDto["solutions"][number]["outcome"] =
        task.state === "skipped" ? "skipped"
          : row?.outcome === "correct" ? "correct"
            : row?.outcome === "incorrect" ? "incorrect"
              : "unassessed";
      if (task.state !== "issued" && task.state !== "skipped") answeredCount += 1;
      const hint = schoolSubject && row ? mockPrecisionHint(row.details) : null;
      solutions.push({
        taskId: task.id,
        objectiveId: slot.objectiveId,
        titlePl: titleOf(slot.objectiveId),
        exerciseType: slot.exerciseType as LessonExerciseTypeDto,
        prompt: promptText(task.publicPrompt as TaskPrompt),
        childAnswer: await childAnswerText(tx, task.id, key),
        correctAnswer: correctAnswerText(key),
        outcome,
        ...(hint ? { hintPl: HINT_TEXT[hint] } : {}),
      });
      reviewInputs.push({ objectiveId: slot.objectiveId, outcome, knowledge: row?.details.knowledge });
    }
    // Stan jak utrwalony przez `closeLessonMockTest`: komplet → `completed`,
    // niepełna → `ended`; sesja już zamknięta zachowuje swój stan.
    const state: "completed" | "ended" = session.state === "active" ? (report.complete ? "completed" : "ended") : (session.state as "completed" | "ended");
    const review = schoolSubject ? objectivesWorthReviewing(reviewInputs, topic.objectives.map((objective) => objective.id)) : [];
    return LessonMockTestSummaryDtoSchema.parse({
      sessionId: session.id,
      deckId: session.deckId,
      state,
      complete: report.complete,
      taskBudget: session.taskBudget,
      answeredCount,
      solutions,
      ...(review.length > 0 ? { reviewObjectives: review.map((objectiveId) => ({ objectiveId, titlePl: titleOf(objectiveId) })) } : {}),
    });
  });
}

/**
 * Treść promptu pokazywana w omówieniu — pełne pokrycie typów lekcji przez
 * `switch` z gwardią `never`: dodanie nowego kind lekcji wymusi tu obsługę.
 * Karta (`lesson_card`) nie jest slotem kartkówki, więc nie występuje.
 */
function promptText(prompt: TaskPrompt): string {
  switch (prompt.kind) {
    case "lesson_choice":
    case "lesson_listen_choice":
      return prompt.stem;
    case "lesson_gap":
      return prompt.stemWithGap;
    case "lesson_error_fix":
    case "lesson_transform":
      return prompt.statement;
    case "lesson_open_answer":
    case "lesson_calculation":
    case "lesson_keywords":
    case "lesson_shorten":
      return prompt.prompt;
    case "lesson_short_answer":
      return prompt.question;
    case "lesson_notice":
      return prompt.instructionPl;
    case "lesson_order":
    case "lesson_match":
    case "lesson_group":
    case "lesson_cloze":
      return prompt.instructionPl;
    case "lesson_card":
    case "exposure":
    case "picture_exposure":
    case "listening":
    case "picture_listening":
    case "reading":
    case "reverse_recognition":
    case "recall":
    case "spelling":
    case "letter_completion":
    case "speech":
    case "picture_speech":
    case "picture_recall":
    case "picture_recognition":
      // Typy nielekcyjne i karta nie są slotami kartkówki lekcji.
      return "";
    default: {
      const _exhaustive: never = prompt;
      void _exhaustive;
      return "";
    }
  }
}

/** Odpowiedź kanoniczna slotu pokazywana dziecku (jak `correctTextFor` lekcji). */
function correctAnswerText(key: { exerciseType?: string; answer?: string; correctOptionId?: string; optionValues?: Record<string, string>; segmentValues?: Record<string, string>; itemIds?: string[]; itemValues?: Record<string, string>; assignments?: Assignment[]; targetIds?: string[]; filledText?: string }): string {
  // Luki z bankiem: cały tekst z poprawnymi słowami (design szkoły §13.3).
  if (key.filledText) return key.filledText;
  if (key.assignments && key.itemValues) {
    return assignmentText(key.assignments, key.itemValues, assignmentTextOptions(key)) || (key.answer ?? "");
  }
  if (key.optionValues && key.correctOptionId) return key.optionValues[key.correctOptionId] ?? key.answer ?? "";
  if (key.segmentValues && key.correctOptionId) return key.segmentValues[key.correctOptionId] ?? key.answer ?? "";
  if (key.itemIds && key.itemValues) {
    const text = key.itemIds.map((id) => key.itemValues![id]).filter((t): t is string => Boolean(t)).join(" ");
    return text || (key.answer ?? "");
  }
  return key.answer ?? "";
}

/** Tekst odpowiedzi dziecka na slot (z completed attempt.answer), rozwiązany do tekstu. */
/** Pary w kolejności lewej kolumny; grupy w kolejności grup. */
function assignmentTextOptions(key: { exerciseType?: string; itemIds?: string[]; targetIds?: string[] }) {
  return {
    grouped: key.exerciseType === "lesson_group",
    ...(key.targetIds ? { targetOrder: key.targetIds } : {}),
    ...(key.itemIds ? { itemOrder: key.itemIds } : {}),
  };
}

async function childAnswerText(tx: Tx, taskId: string, key: { exerciseType?: string; optionValues?: Record<string, string>; segmentValues?: Record<string, string>; itemIds?: string[]; itemValues?: Record<string, string>; targetIds?: string[]; clozeText?: string }): Promise<string> {
  const [attempt] = await tx
    .select({ modality: attempts.modality, answer: attempts.answer })
    .from(attempts)
    .where(and(eq(attempts.taskId, taskId), eq(attempts.state, "completed")))
    .orderBy(desc(attempts.receivedAt))
    .limit(1);
  if (!attempt) return "";
  const answer = attempt.answer as { text?: string; optionId?: string; optionText?: string; itemIds?: string[]; assignments?: Assignment[] } | null;
  if (!answer) return "";
  if (attempt.modality === "text") return answer.text ?? "";
  if (attempt.modality === "choice") {
    if (answer.optionText) return answer.optionText;
    const id = answer.optionId ?? "";
    return key.optionValues?.[id] ?? key.segmentValues?.[id] ?? "";
  }
  if (attempt.modality === "sequence") {
    const ids = answer.itemIds ?? [];
    return ids.map((id) => key.itemValues?.[id]).filter((t): t is string => Boolean(t)).join(" ");
  }
  if (attempt.modality === "assignment" && key.clozeText !== undefined) {
    // Luki z bankiem: tekst ze słowami dziecka, jak poprawny tekst w omówieniu (design szkoły §13.3).
    const wordOf = new Map((answer.assignments ?? []).map((entry) => [entry.itemId, key.itemValues?.[entry.targetId] ?? ""] as const));
    return fillCloze(key.clozeText, (key.itemIds ?? []).map((gapId) => wordOf.get(gapId) || "___"));
  }
  if (attempt.modality === "assignment") {
    return assignmentText(answer.assignments ?? [], key.itemValues ?? {}, assignmentTextOptions(key));
  }
  return "";
}

/** 20 ostatnich kartkówek lekcji dla dziecka i lekcji (jak `listMockTests` słówek). */
export async function listLessonMockTests(services: Services, childId: string, deckId: string): Promise<LessonMockTestReportDto[]> {
  const rows = await services.db
    .select({ id: learningSessions.id })
    .from(learningSessions)
    .where(
      and(
        eq(learningSessions.childId, UuidSchema.parse(childId)),
        eq(learningSessions.deckId, UuidSchema.parse(deckId)),
        eq(learningSessions.mode, "mock_test"),
        or(ne(learningSessions.state, "active"), lt(learningSessions.startedAt, new Date(services.clock.now().getTime() - 600_000))),
      ),
    )
    .orderBy(desc(learningSessions.startedAt), desc(learningSessions.id))
    .limit(20);
  const result: LessonMockTestReportDto[] = [];
  for (const row of rows) result.push(await getLessonMockTestReport(services, row.id));
  return result;
}
