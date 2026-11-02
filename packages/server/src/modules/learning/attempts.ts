import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, max, or, sql } from "drizzle-orm";
import {
  AttemptInputSchema,
  UuidSchema,
  type AttemptDto,
  type AttemptInput,
  type FeedbackDto,
} from "@learning/contracts";
import type { Services } from "../../config";
import type { Tx } from "../../db/client";
import {
  assessments,
  attempts,
  deckVersions,
  eventExposures,
  itemRevisions,
  itemRevisionSkills,
  learningEvents,
  learningSessions,
  mediaAssets,
  revisionAssets,
  sessionTasks,
} from "../../db/schema";
import { AppError } from "../../errors";
import { sessionTimeLimitMs } from "../../domain/session-limits";
import { assessedSkills, evaluateChoice, evaluateNonAnswer, evaluateWritten } from "../../domain/evaluate";
import { chooseFeedback, feedbackExposureKeys } from "../../domain/feedback";
import { compareSpelling } from "../../domain/spelling-diff";
import { qualifyAttempt } from "../../domain/independence";
import { computeTargetKey } from "../../domain/target-key";
import { taskStateAfterAttempt } from "../../domain/task-completion";
import { payloadToItem } from "../materials";
import type {
  AnswerKey,
  AssistanceKind,
  EvaluationContext,
  ExerciseType,
  Grade,
  Policy,
  Skill,
  SkillGrade,
} from "../../domain/types";
import { loadPolicy } from "../../policies/registry";
import { lockTaskWithSession, writeSealedEvent, contextOf, sealPostAnswerAudio } from "./events";
import { requestHashOf, discloseFeedbackEvent } from "./attempt-shared";
import { submitLessonAttempt, readLessonAttempt } from "./lessons/lesson-attempts";
import { answerStoryQuestion, readStoryQuestionAttempt } from "./lessons/lesson-story-attempts";
import { readSkillHistories, skillHistoryKey } from "./skill-history";
import { persistSkillProjections } from "./skill-projections";
import { resolveTaskAssistance } from "../../domain/task-assistance";
import { assertVocabularyDeck, type DeckKind } from "../materials";
import { completeDisabledVoiceTask } from "./voice-task-lifecycle";

/** Leniwa finalizacja przeterminowanych prób processing (arch §9.2a). */
export const ATTEMPT_PROCESSING_TIMEOUT_MS = 60_000;

/** Zadania, w których ujawnienie angielskiego rozwiązania psuje samodzielność (SPEC §12.5–12.8). */
const RECALL_LIKE: ReadonlySet<string> = new Set(["recall", "spelling", "letter_completion"]);
const CHOICE_EXERCISES: ReadonlySet<string> = new Set(["listening", "reading", "reverse_recognition", "picture_recognition"]);
const WRITTEN_EXERCISES: ReadonlySet<string> = new Set(["recall", "spelling", "letter_completion"]);

type AttemptRow = typeof attempts.$inferSelect;
type TaskRow = typeof sessionTasks.$inferSelect;
type SessionRow = typeof learningSessions.$inferSelect;
type AnyModality = AttemptInput["modality"] | "audio";

/** Zamrożony przy received_at kontekst kwalifikacji (arch §9.2), zapisany w próbie. */
interface FrozenContext {
  receivedAt: string;
  policyVersion: string;
  lastExposureAt: string | null;
  firstTry: boolean;
  assistance: AssistanceKind[];
  previousSessionContactAt: string | null;
  timezone: string;
  assessmentSkills?: Skill[];
}

function answerKeyOf(task: TaskRow): AnswerKey {
  return task.answerKey as unknown as AnswerKey;
}

/**
 * Wsparcie użyte w zadaniu przed próbą (SPEC §13.2). Odsłuch w zadaniu ze słuchu
 * to pytanie, nie wsparcie; widoczne litery uzupełniania są podpowiedzią z
 * definicji. Wzorzec w ćwiczeniu wymowy jest oczekiwaną częścią nauki i nie
 * dyskwalifikuje oceny samej wymowy — wsparciem jest tylko tam, gdzie ujawnia
 * rozwiązanie (zadania przypominania i pisowni).
 */
async function assistanceFor(
  tx: Tx,
  task: TaskRow,
  receivedAt: Date,
): Promise<{ assistance: AssistanceKind[]; feedbackCount: number }> {
  // Jedno zapytanie o zdarzenia zadania daje i wsparcia (audio/hint), i liczbę
  // wcześniejszych ujawnien feedbacku — tę drugą finalizacja wykorzystuje do
  // stepId bez osobnego zapytania w discloseFeedbackEvent.
  const disclosures = await tx
    .select({ kind: learningEvents.kind, occurredAt: learningEvents.occurredAt })
    .from(learningEvents)
    .where(and(eq(learningEvents.taskId, task.id), inArray(learningEvents.kind, ["audio_issued", "hint_issued", "feedback_issued"])));
  const prompt = task.publicPrompt as { options?: { text?: string; labelPl?: string }[] };
  const distinctChoiceCount = Array.isArray(prompt.options)
    ? new Set(prompt.options.map((option) => (option.text ?? option.labelPl ?? "").normalize("NFC").trim().toLocaleLowerCase())).size
    : null;
  return {
    feedbackCount: disclosures.filter((row) => row.kind === "feedback_issued").length,
    assistance: resolveTaskAssistance({
      exerciseType: task.exerciseType as ExerciseType,
      visibleLetterFragment: task.exerciseType === "letter_completion",
      distinctChoiceCount,
      disclosureKinds: disclosures
        .filter((row) => row.kind !== "feedback_issued" && row.occurredAt <= receivedAt)
        .map((row) => row.kind as "audio_issued" | "hint_issued"),
    }),
  };
}

/** Ostatnie ujawnienie rozwiązania elementu — także w innym ćwiczeniu (SPEC §18.1). */
async function lastExposureAt(tx: Tx, childId: string, targetKeys: readonly string[]): Promise<string | null> {
  const [row] = await tx
    .select({ latest: max(learningEvents.occurredAt) })
    .from(eventExposures)
    .innerJoin(learningEvents, eq(learningEvents.id, eventExposures.eventId))
    .where(and(eq(eventExposures.childId, childId), inArray(eventExposures.targetKey, [...targetKeys])));
  return row?.latest?.toISOString() ?? null;
}

function solutionTargetKeys(revisionPayload: unknown, revisionTargetKey: string, key: AnswerKey): string[] {
  const locale = payloadToItem(revisionPayload as Record<string, unknown>).locales.target;
  return [...new Set([revisionTargetKey, ...[key.target, ...key.acceptedAnswers].map(answer => computeTargetKey(answer, locale))])];
}


/** Rozwiązanie własnego zadania pokazywane dziecku w feedbacku (SPEC §16). */
function correctTextOf(task: TaskRow, key: AnswerKey): string {
  if (key.correctOptionId !== undefined) {
    const options = (task.publicPrompt.options as { id: string; text?: string; labelPl?: string }[] | undefined) ?? [];
    const option = options.find((o) => o.id === key.correctOptionId);
    return option?.text ?? option?.labelPl ?? key.target;
  }
  return key.target;
}

function optionTextOf(task: TaskRow, optionId: string): string {
  const options = (task.publicPrompt.options as { id: string; text?: string; labelPl?: string }[] | undefined) ?? [];
  const option = options.find((o) => o.id === optionId);
  return option?.text ?? option?.labelPl ?? "";
}

function limitGradeToTaskSkills(task: TaskRow, grade: Grade): Grade {
  const allowed = (task.context as { assessmentSkills?: unknown } | null)?.assessmentSkills;
  if (!Array.isArray(allowed)) return grade;
  const permitted = new Set(allowed.filter((skill): skill is Skill =>
    ["listening", "reading", "recall", "pronunciation", "spelling"].includes(String(skill)),
  ));
  return { ...grade, skills: Object.fromEntries(Object.entries(grade.skills).filter(([skill]) => permitted.has(skill as Skill))) };
}

function gradeOf(input: AttemptInput, key: AnswerKey, ctx: EvaluationContext): Grade {
  switch (input.modality) {
    case "text":
      return evaluateWritten(input.text, key, ctx);
    case "choice":
      return evaluateChoice(input.optionId, key, ctx);
    case "dont_remember":
      return evaluateNonAnswer("dont_remember", key, ctx);
    case "skip":
      return evaluateNonAnswer("skip", key, ctx);
    case "audio":
      // nieosiągalne: ścieżka audio przechodzi przez submitSpeechAttempt
      throw new AppError("validation", { message: "speech attempts require the audio path" });
    case "sequence":
    case "selection":
    case "assignment":
      // nieosiągalne tutaj: próby lekcji (w tym `sequence` i `selection`) obsługuje
      // `modules/lessons/lesson-attempts.ts` (design „Przyjęcie odpowiedzi”).
      throw new AppError("validation", { message: `${input.modality} attempts require the lesson path` });
  }
}

function dbOutcome(outcome: SkillGrade["outcome"]): "correct" | "incorrect" | "unassessed" {
  return outcome === "unevaluated" ? "unassessed" : outcome;
}

/** Ujawnienie feedbacku: ekspozycja celu zapisana przed odpowiedzią HTTP (arch §9.2). */
async function discloseFeedback(
  tx: Tx,
  task: TaskRow,
  childId: string,
  itemId: string,
  feedback: FeedbackDto,
  targetKey: string,
  now: Date,
  knownLocale?: string,
  knownFeedbackCount?: number,
): Promise<string> {
  const locale = knownLocale ?? (await tx.select({ locale: deckVersions.targetLocale })
    .from(itemRevisions)
    .innerJoin(deckVersions, eq(deckVersions.id, itemRevisions.deckVersionId))
    .where(eq(itemRevisions.id, task.itemRevisionId)))[0]?.locale;
  // oceniona próba pokazuje rozwiązanie własnego zadania (własna poprawna
  // odpowiedź albo correctText); „Pomiń”/brak oceny niczego nie ujawnia
  const exposures = locale
    ? feedbackExposureKeys(feedback, targetKey, locale)
    : feedback.kind === "not_assessed"
      ? []
      : [targetKey];
  return discloseFeedbackEvent(tx, {
    task, childId, itemId, exposures, now,
    ...(knownFeedbackCount === undefined ? {} : { knownPriorCount: knownFeedbackCount }),
  });
}

/**
 * Jednokrotna finalizacja próby: oceny per umiejętność, projekcje, przejście
 * zadania, rezerwacja i ujawnienie feedbacku — wszystko w jednej transakcji
 * (arch §9.2). CAS stanu processing → completed chroni przed podwójną
 * finalizacją; blokada sesji serializuje równoległych klientów.
 */
async function finalizeAttemptRow(
  tx: Tx,
  task: TaskRow,
  session: SessionRow,
  itemId: string,
  attempt: AttemptRow,
  modality: AnyModality,
  grade: Grade,
  policy: Policy,
  targetKey: string,
  now: Date,
  revision: { targetLocale: string; revisionPayload: unknown },
  knownCounts?: { feedbackPriorCount: number; priorIncorrectAttemptCount: number },
): Promise<AttemptDto> {
  grade = limitGradeToTaskSkills(task, grade);
  const key = answerKeyOf(task);
  const correctText = correctTextOf(task, key);
  // diagnoza liter wyłącznie dla odpowiedzi pisemnej z ocenianą pisownią (issue #9);
  // to komunikat, nie podstawa oceny — odległość nie zalicza znaczenia (A16)
  const answerText =
    modality === "text" ? ((attempt.answer as { text?: string } | null)?.text ?? null) : null;
  const spellingIncorrect = grade.skills.spelling?.outcome === "incorrect";
  const diff =
    answerText !== null &&
    spellingIncorrect &&
    ["recall", "spelling", "letter_completion"].includes(key.exerciseType)
      ? compareSpelling(answerText, key)
      : null;
  let feedback: FeedbackDto | null = session.mode === "mock_test" ? null : chooseFeedback(grade, correctText, diff);
  if (feedback?.speech && ["matched", "different"].includes(feedback.speech.recognition) && feedback.speech.referenceText !== undefined) {
    const canonical = (revision.revisionPayload as { target?: string } | undefined)?.target;
    const matchingCanonical = canonical !== undefined &&
      computeTargetKey(feedback.speech.referenceText, revision.targetLocale) === computeTargetKey(canonical, revision.targetLocale);
    const audio = matchingCanonical
      ? (await tx.select({ id: mediaAssets.id })
          .from(revisionAssets)
          .innerJoin(mediaAssets, eq(mediaAssets.id, revisionAssets.assetId))
          .where(and(
            eq(revisionAssets.itemRevisionId, task.itemRevisionId),
            eq(revisionAssets.role, "target_audio"),
            eq(revisionAssets.state, "approved"),
            eq(mediaAssets.kind, "tts"),
            eq(mediaAssets.state, "ready"),
          )))[0]
      : undefined;
    feedback = { ...feedback, referenceAudioAvailable: Boolean(audio) };
  }
  // picture_recognition: odsłuch poprawnego słowa jest częścią feedbacku, nie
  // zadania (SPEC §12.4a, A07). Ujawniamy identyfikator gotowego audio tylko
  // razem z oceną; feedback nieoceniony niczego nie odsłuchuje.
  if (feedback !== null && feedback.kind !== "not_assessed" && key.exerciseType === "picture_recognition") {
    const [correctAudio] = await tx.select({ id: mediaAssets.id })
      .from(revisionAssets)
      .innerJoin(mediaAssets, eq(mediaAssets.id, revisionAssets.assetId))
      .where(and(
        eq(revisionAssets.itemRevisionId, task.itemRevisionId),
        eq(revisionAssets.role, "target_audio"),
        eq(revisionAssets.state, "approved"),
        eq(mediaAssets.kind, "tts"),
        eq(mediaAssets.state, "ready"),
      ))
      // przy kilku zatwierdzonych nagraniach wybór musi być deterministyczny:
      // najnowszy gotowy zasób, remis rozstrzyga id
      .orderBy(desc(mediaAssets.createdAt), desc(mediaAssets.id));
    if (correctAudio) feedback = { ...feedback, correctAudioAssetId: correctAudio.id };
  }
  const chosenText =
    modality === "choice"
      ? ((attempt.answer as { optionText?: string } | null)?.optionText ?? "")
      : modality === "audio"
        ? ((attempt.answer as { transcript?: string | null } | null)?.transcript ?? null)
        : null;
  const choiceIds = key.optionItemRevisionIds ?? {};
  const choiceOptionId = modality === "choice" ? (attempt.answer as { optionId?: string } | null)?.optionId : undefined;
  const expectedRevisionId = choiceIds[key.correctOptionId ?? ""];
  const answeredRevisionId = choiceOptionId === undefined ? undefined : choiceIds[choiceOptionId];

  if (modality !== "skip") {
    const skillRows = await tx
      .select({ skill: itemRevisionSkills.skill, skillVersionId: itemRevisionSkills.skillVersionId })
      .from(itemRevisionSkills)
      .where(eq(itemRevisionSkills.itemRevisionId, task.itemRevisionId));
    const versionBySkill = new Map(skillRows.map((row) => [row.skill as Skill, row.skillVersionId]));

    // Oceny wszystkich umiejętności jednym insertem, historie jednym
    // wywołaniem wsadowym i projekcje jednym upsertem — wcześniej pętla
    // płaciła 4 zapytania na umiejętność (insert, 2x historia, projekcja).
    const assessmentValues = [];
    const projectionScopes: { childId: string; skillVersionId: string; skill: Skill }[] = [];
    for (const [skill, skillGrade] of Object.entries(grade.skills) as [Skill, SkillGrade][]) {
      const skillVersionId = versionBySkill.get(skill);
      if (!skillVersionId) {
        throw new AppError("internal", { message: `missing skill version for ${skill}` });
      }
      const details: Record<string, unknown> = { ...(skillGrade.details ?? {}) };
      if (modality === "choice" && expectedRevisionId && answeredRevisionId) {
        details.expectedItemRevisionId = expectedRevisionId;
        details.answeredItemRevisionId = answeredRevisionId;
      }
      if (chosenText !== null && skillGrade.outcome === "incorrect") {
        // konkretna pomyłka z zachowaniem kierunku (SPEC §21); „Nie pamiętam”,
        // próby techniczne i niepewne rozpoznanie pary nie tworzą — dla mowy
        // transkrypcja trafia tutaj tylko przy wiarygodnym rozpoznaniu
        details.confusion = { expected: correctText, answered: chosenText };
      }
      assessmentValues.push({
        childId: session.childId,
        attemptId: attempt.id,
        itemRevisionId: task.itemRevisionId,
        skill,
        skillVersionId,
        outcome: dbOutcome(skillGrade.outcome),
        reason: skillGrade.reason ?? null,
        independent: skillGrade.independent,
        confirmationEligible: skillGrade.confirmationEligible,
        details,
      });
      if (skillGrade.outcome !== "unevaluated") {
        projectionScopes.push({ childId: session.childId, skillVersionId, skill });
      }
    }
    if (assessmentValues.length > 0) {
      await tx.insert(assessments).values(assessmentValues);
    }
    if (projectionScopes.length > 0) {
      const histories = await readSkillHistories(tx, projectionScopes);
      await persistSkillProjections(tx, projectionScopes.map((scope) => ({
        scope,
        history: histories.get(skillHistoryKey(scope)) ?? [],
        policy,
        now,
        receivedAt: attempt.receivedAt,
      })));
    }
  }

  // Gorąca ścieżka zna liczbę wcześniejszych niepoprawnych prób zadania ze
  // wstępu (ta sama blokada sesji); bieżąca próba dokłada się sama, gdy choć
  // jedna jej ocena jest niepoprawna i oceny faktycznie zapisano.
  const currentIncorrect = modality !== "skip" &&
    Object.values(grade.skills).some((skill) => skill.outcome === "incorrect");
  const incorrectAttemptCount = knownCounts !== undefined
    ? knownCounts.priorIncorrectAttemptCount + (currentIncorrect ? 1 : 0)
    : (await tx
        .selectDistinct({ id: attempts.id })
        .from(attempts)
        .innerJoin(assessments, eq(assessments.attemptId, attempts.id))
        .where(and(eq(attempts.taskId, task.id), eq(assessments.outcome, "incorrect")))).length;
  const taskState = taskStateAfterAttempt({
    isMockTest: session.mode === "mock_test",
    action: modality === "skip" || modality === "dont_remember" ? modality : "answer",
    outcomes: Object.values(grade.skills).map((skill) => skill.outcome),
    attemptNumber: attempt.attemptNumber,
    incorrectAttemptCount,
    speechContentMatched: grade.speechAttempt?.contentMatched,
  });
  let finalTaskState: string = task.state;
  if (taskState !== "issued") {
    const [updated] = await tx.update(sessionTasks).set({ state: taskState }).where(eq(sessionTasks.id, task.id)).returning({ state: sessionTasks.state });
    finalTaskState = updated?.state ?? taskState;
  }

  const completed = await tx
    .update(attempts)
    .set({ state: "completed", completedAt: now, feedback: feedback as unknown as Record<string, unknown> })
    .where(and(eq(attempts.id, attempt.id), eq(attempts.state, "processing")))
    .returning();
  if (completed.length === 0) {
    throw new AppError("conflict", { message: "attempt is already finalized" });
  }

  // Aktywność sesji rozlicza wyłącznie raport FE na końcu sesji (spec
  // client-reward-time); próba zostawia tylko ocenę i ekspozycje.
  const stepId = feedback === null ? null : await discloseFeedback(
    tx, task, session.childId, itemId, feedback, targetKey, now,
    revision.targetLocale, knownCounts?.feedbackPriorCount,
  );
  // picture_recognition: zgoda na odsłuch poprawnego słowa (feedback) to
  // ujawnienie rozwiązania — pieczęć audio_issued po odpowiedzi (issue #187).
  if (feedback?.correctAudioAssetId !== undefined) {
    await sealPostAnswerAudio(tx, { childId: session.childId, taskId: task.id, itemId, targetKey, receivedAt: attempt.receivedAt, now });
  }
  if (session.mode === "mock_test") {
    await writeSealedEvent(tx, {
      childId: session.childId,
      taskId: task.id,
      itemId,
      kind: "contact",
      stepId: `${task.id}:contact`,
      occurredAt: attempt.receivedAt,
      exposures: [],
    });
  }
  // rezerwacja sprawdzenia zwalniana po rozliczeniu albo po ocenionej próbie,
  // której feedback ujawnił rozwiązanie (arch §9.3; próba techniczna zostawia)
  const assessedAny = Object.values(grade.skills).some((s) => s.outcome !== "unevaluated");
  if (RECALL_LIKE.has(task.exerciseType) && (taskState !== "issued" || assessedAny)) {
    const context = contextOf(session);
    const reservations = context.reservations.filter((k) => k !== targetKey);
    const settledChecks = [...new Set([...context.settledChecks, targetKey])];
    await tx
      .update(learningSessions)
      .set({ context: { ...session.context, reservations, settledChecks } as unknown as Record<string, unknown> })
      .where(eq(learningSessions.id, session.id));
  }

  if (contextOf(session).microphoneDisabledTaskIds.includes(task.id)) {
    await completeDisabledVoiceTask(tx, session.id, task.id);
    // Tylko ta ścieżka zmienia stan zadania poza powyższym update'em.
    finalTaskState = await rereadTaskState(tx, task.id);
  }
  return {
    attemptId: attempt.id,
    taskId: task.id,
    state: "completed",
    modality: modality as AttemptDto["modality"],
    feedback,
    taskState: finalTaskState as AttemptDto["taskState"],
    stepId,
    receivedAt: attempt.receivedAt.toISOString(),
    completedAt: now.toISOString(),
  };
}

function dtoOf(attempt: AttemptRow, taskState: string, stepId: string | null = null): AttemptDto {
  return {
    attemptId: attempt.id,
    taskId: attempt.taskId,
    state: attempt.state as "processing" | "completed",
    modality: attempt.modality as AttemptDto["modality"],
    feedback: (attempt.feedback as FeedbackDto | null) ?? null,
    taskState: taskState as AttemptDto["taskState"],
    stepId,
    receivedAt: attempt.receivedAt.toISOString(),
    completedAt: attempt.completedAt?.toISOString() ?? null,
  };
}

async function rereadTaskState(tx: Tx, taskId: string): Promise<string> {
  const row = (await tx.select({ state: sessionTasks.state }).from(sessionTasks).where(eq(sessionTasks.id, taskId)))[0]!;
  return row.state;
}

/**
 * Wynik rozpoczęcia próby: istniejąca/processing odpowiedź klienta albo komplet
 * danych świeżej próby z zamrożonym kontekstem (wspólne dla odpowiedzi pisemnych
 * i ścieżki mowy z zadania 8).
 */
export type AttemptStart =
  | { kind: "dto"; dto: AttemptDto }
  | {
      kind: "fresh";
      task: TaskRow;
      session: SessionRow;
      itemId: string;
      policy: Policy;
      frozen: FrozenContext;
      key: AnswerKey;
      targetKey: string;
      targetLocale: string;
      revisionPayload: unknown;
      feedbackPriorCount: number;
      priorIncorrectAttemptCount: number;
      attemptNumber: number;
      requestHash: string;
      receivedAt: Date;
    };

/**
 * Wspólny wstęp przyjęcia odpowiedzi (arch §9.1a, §9.2): blokada sesji,
 * idempotencja clientAttemptId, leniwa finalizacja przeterminowanych prób,
 * walidacje stanu i zamrożenie kontekstu kwalifikacji przy received_at.
 */
export async function startAttempt(
  tx: Tx,
  services: Services,
  valid: AttemptInput,
): Promise<AttemptStart> {
  const { task, session, itemId, targetKey, targetLocale, revisionPayload, deckKind } =
    await lockTaskWithSession(tx, valid.taskId);
  const revision = { targetKey, targetLocale, revisionPayload };
  const now = services.clock.now();
  if (session.mode === "daily_round") {
    throw new AppError("conflict", { message: "daily-round sessions are retired" });
  }
  // Izolacja lekcji (zadanie 9): próby słówek nie dotyczą lekcji. W praktyce
  // nieosiągalne (sesja lekcji nie powstaje), ale strzeżemy w jednym miejscu;
  // delegację oceny lekcji doda zadanie 13/17. Rodzaj zestawu daje join locka.
  assertVocabularyDeck(deckKind as DeckKind);

  // Jedno zapytanie daje próby tego zadania (z wynikami ocen do liczby
  // wcześniejszych niepoprawnych prób) oraz ewentualną próbę o tym samym
  // clientAttemptId na innym zadaniu — wcześniej 3–4 osobne zapytania.
  const relatedRows = await tx
    .select({ attempt: attempts, outcome: assessments.outcome })
    .from(attempts)
    .leftJoin(assessments, eq(assessments.attemptId, attempts.id))
    .where(or(
      eq(attempts.taskId, task.id),
      and(eq(attempts.childId, task.childId), eq(attempts.clientAttemptId, valid.clientAttemptId)),
    ));
  const taskAttemptsById = new Map<string, AttemptRow>();
  const incorrectAttemptIds = new Set<string>();
  for (const row of relatedRows) {
    if (row.attempt.taskId === task.id) {
      taskAttemptsById.set(row.attempt.id, row.attempt);
      if (row.outcome === "incorrect") incorrectAttemptIds.add(row.attempt.id);
    }
  }
  const taskAttempts = [...taskAttemptsById.values()];
  const existing = relatedRows.map((row) => row.attempt).find((attempt) => attempt.clientAttemptId === valid.clientAttemptId);
  if (existing) {
    if (existing.requestHash !== requestHashOf(valid)) {
      throw new AppError("conflict", { message: "clientAttemptId reused with different answer" });
    }
    await lazyFinalizeProcessing(tx, task, session, itemId, now, revision);
    const fresh = (await tx.select().from(attempts).where(eq(attempts.id, existing.id)))[0]!;
    const state = await rereadTaskState(tx, task.id);
    if (session.mode !== "mock_test" && fresh.state === "completed" && fresh.feedback) {
      const stepId = await discloseFeedback(
        tx,
        task,
        task.childId,
        itemId,
        fresh.feedback as FeedbackDto,
        targetKey,
        now,
        targetLocale,
      );
      return { kind: "dto", dto: dtoOf(fresh, state, stepId) };
    }
    return { kind: "dto", dto: dtoOf(fresh, state) };
  }

  // leniwa finalizacja najpierw: zwalnia jedyną próbę processing zadania
  const lazy = await lazyFinalizeProcessing(tx, task, session, itemId, now, revision, taskAttempts);
  let taskStateMayHaveChanged = lazy.finalizedAny;
  if (contextOf(session).microphoneDisabledTaskIds.includes(task.id)) {
    await completeDisabledVoiceTask(tx, session.id, task.id);
    taskStateMayHaveChanged = true;
  }

  if (session.state !== "active") {
    throw new AppError("conflict", { message: "session is closed" });
  }
  // Skalowany limit kartkówki (jak w nextTask): max(10 minut, 45 s × budżet
  // sesji), żeby odpowiedzi na dużą porcję nie były blokowane po 10 minutach.
  if (session.mode === "mock_test" && now.getTime() - session.startedAt.getTime() > sessionTimeLimitMs(session.taskBudget)) {
    throw new AppError("conflict", { message: "Czas kartkówki minął. Przejdź do omówienia." });
  }
  if (task.exerciseType === "exposure") {
    throw new AppError("validation", { message: "presentation tasks take no attempts" });
  }
  // `lazyFinalizeProcessing` i `completeDisabledVoiceTask` mogły zakończyć to
  // zadanie; poza tymi ścieżkami stan z locka jest aktualny, bo każdy zapis
  // stanu zadania przechodzi przez tę samą blokadę sesji.
  const currentTaskState = taskStateMayHaveChanged ? await rereadTaskState(tx, task.id) : task.state;
  if (currentTaskState !== "issued") {
    throw new AppError("conflict", { message: "task is no longer issued" });
  }
  const sessionContext = contextOf(session);
  if (!sessionContext.canRead && valid.modality === "text") {
    throw new AppError("validation", { details: { reason: "vocabulary_requires_reading" } });
  }
  if (!session.microphoneEnabled && valid.modality === "audio") {
    throw new AppError("validation", { message: "microphone is disabled for this session" });
  }
  if (session.mode === "mock_test" && valid.modality === "audio") {
    throw new AppError("validation", { message: "Kartkówka nie wymaga nagrywania odpowiedzi." });
  }
  if (
    (valid.modality === "choice" && !CHOICE_EXERCISES.has(task.exerciseType)) ||
    (valid.modality === "text" && !WRITTEN_EXERCISES.has(task.exerciseType))
  ) {
    throw new AppError("validation", { message: "attempt modality does not match exercise" });
  }

  // świeża próba processing (audio) nie uruchamia drugiej analizy — klient
  // dostaje ten sam rekord do odpytywania (arch §9.2a)
  const processing = taskAttempts.find(
    (attempt) => attempt.state === "processing" && !lazy.finalizedIds.has(attempt.id),
  );
  if (processing) {
    return { kind: "dto", dto: dtoOf(processing, currentTaskState) };
  }

  const attemptNumber = taskAttempts.length + 1;
  const policy = await loadPolicy(tx, session.policyId);
  const key = answerKeyOf(task);
  const assistanceInfo = await assistanceFor(tx, task, now);
  const frozen: FrozenContext = {
    receivedAt: now.toISOString(),
    policyVersion: policy.version,
    lastExposureAt: RECALL_LIKE.has(task.exerciseType)
      ? await lastExposureAt(tx, task.childId, solutionTargetKeys(revisionPayload, targetKey, key))
      : null,
    firstTry: attemptNumber === 1,
    assistance: assistanceInfo.assistance,
    previousSessionContactAt: sessionContext.previousContact[itemId] ?? null,
    timezone: sessionContext.timezone,
    ...((task.context as { assessmentSkills?: Skill[] } | null)?.assessmentSkills
      ? { assessmentSkills: (task.context as { assessmentSkills: Skill[] }).assessmentSkills }
      : {}),
  };

  return {
    kind: "fresh",
    task,
    session,
    itemId,
    policy,
    frozen,
    key,
    targetKey,
    targetLocale,
    revisionPayload,
    feedbackPriorCount: assistanceInfo.feedbackCount,
    priorIncorrectAttemptCount: incorrectAttemptIds.size,
    attemptNumber,
    requestHash: requestHashOf(valid),
    receivedAt: now,
  };
}

/**
 * Przyjmuje odpowiedź dziecka (arch §9.1a, §9.2). Kontekst kwalifikacji zamraża
 * się przy received_at pod blokadą sesji; dla odpowiedzi pisemnych cała ocena,
 * projekcja i ujawnienie feedbacku są jedną transakcją. `clientAttemptId`
 * zabezpiecza retry transportowy; ten sam klucz z inną treścią daje 409.
 */
export async function submitAttempt(services: Services, input: AttemptInput): Promise<AttemptDto> {
  const valid = AttemptInputSchema.parse(input);
  if (valid.modality === "audio") {
    // bajty nagrania nie podróżują w JSON — ścieżka mowy jest osobna (arch §11)
    throw new AppError("validation", { message: "speech attempts require the audio path" });
  }
  // Rozgałęzienie po rodzaju zestawu (zadanie 13B, review minor zadania 9): zadania
  // lekcji (`lesson_*`) idą do silnika lekcji, który sam ocenia, projektuje cel i
  // składa feedback. Rozstrzygamy to po stanie zadania, nie modalności: `sequence`
  // jest lekcyjne, ale zwykły `text`/`choice`/`skip`/`dont_remember` też musi trafić
  // do lekcji, gdy dotyczy zadania lekcji. Nieznane zadanie → `not_found` (jak słówka).
  // Sam odczyt routujący nie potrzebuje transakcji (begin/commit to 2 z 3
  // wywołań dawnej wersji) — blokadę i tak zakłada właściwa ścieżka.
  const routedTask = (await services.db
    .select({ exerciseType: sessionTasks.exerciseType })
    .from(sessionTasks)
    .where(eq(sessionTasks.id, valid.taskId)))[0];
  const routed = routedTask ? (routedTask.exerciseType as string).startsWith("lesson_") : null;
  if (routed === null) {
    throw new AppError("not_found");
  }
  if (routed) {
    // Pytanie historyjki ma własną odpowiedź poza oceną celu; karta i historyjka
    // to prezentacje — próba „Pomiń”/„Nie pamiętam” zapisałaby ocenę celu kotwicy.
    const type = routedTask!.exerciseType as string;
    if (type === "lesson_story_question") return answerStoryQuestion(services, valid);
    if (type === "lesson_card" || type === "lesson_story") {
      throw new AppError("validation", { message: "presentation tasks take no attempts" });
    }
    return submitLessonAttempt(services, valid);
  }
  return services.db.transaction(async (tx) => {
    const started = await startAttempt(tx, services, valid);
    if (started.kind !== "fresh") {
      return started.dto;
    }
    const ctx: EvaluationContext = { ...started.frozen, policy: started.policy };
    const grade = gradeOf(valid, started.key, ctx);

    const answer =
      valid.modality === "text"
        ? { text: valid.text }
        : valid.modality === "choice"
          ? { optionId: valid.optionId, optionText: optionTextOf(started.task, valid.optionId) }
          : null;
    const attemptId = randomUUID();
    const [attempt] = await tx.insert(attempts).values({
      id: attemptId,
      childId: started.task.childId,
      taskId: started.task.id,
      itemRevisionId: started.task.itemRevisionId,
      clientAttemptId: valid.clientAttemptId,
      requestHash: started.requestHash,
      attemptNumber: started.attemptNumber,
      modality: valid.modality,
      state: "processing",
      answer,
      context: started.frozen as unknown as Record<string, unknown>,
      policyId: started.session.policyId,
      receivedAt: started.receivedAt,
    }).returning();
    return finalizeAttemptRow(
      tx,
      started.task,
      started.session,
      started.itemId,
      attempt!,
      valid.modality,
      grade,
      started.policy,
      started.targetKey,
      started.receivedAt,
      { targetLocale: started.targetLocale, revisionPayload: started.revisionPayload },
      {
        feedbackPriorCount: started.feedbackPriorCount,
        priorIncorrectAttemptCount: started.priorIncorrectAttemptCount,
      },
    );
  });
}

/**
 * Odczyt próby (arch §12). Rozlicza leniwe processing starsze niż 60 s;
 * ponowne wydanie feedbacku zapisuje kolejne ujawnienie przed odpowiedzią.
 */
export async function readAttempt(services: Services, attemptId: string): Promise<AttemptDto> {
  const id = UuidSchema.parse(attemptId);
  const routed = (
    await services.db
      .select({ attempt: attempts, exerciseType: sessionTasks.exerciseType })
      .from(attempts)
      .innerJoin(sessionTasks, eq(sessionTasks.id, attempts.taskId))
      .where(eq(attempts.id, id))
  )[0] ?? null;
  if (routed && (routed.exerciseType as string) === "lesson_story_question") {
    return readStoryQuestionAttempt(services, routed.attempt as unknown as typeof attempts.$inferSelect);
  }
  if (routed && (routed.exerciseType as string).startsWith("lesson_")) {
    return readLessonAttempt(services, routed.attempt as unknown as typeof attempts.$inferSelect);
  }
  return services.db.transaction(async (tx) => {
    const attempt = (await tx.select().from(attempts).where(eq(attempts.id, id)))[0];
    if (!attempt) {
      throw new AppError("not_found");
    }
    const { task, session, itemId, targetKey, targetLocale, revisionPayload } = await lockTaskWithSession(tx, attempt.taskId);
    if (session.mode === "daily_round") return dtoOf(attempt, task.state);
    const now = services.clock.now();

    await lazyFinalizeProcessing(tx, task, session, itemId, now, { targetKey, targetLocale, revisionPayload });

    const fresh = (await tx.select().from(attempts).where(eq(attempts.id, id)))[0]!;
    const freshTask = (await tx.select().from(sessionTasks).where(eq(sessionTasks.id, task.id)))[0]!;
    if (session.mode !== "mock_test" && fresh.state === "completed" && fresh.feedback) {
      const stepId = await discloseFeedback(
        tx,
        freshTask,
        fresh.childId,
        itemId,
        fresh.feedback as FeedbackDto,
        targetKey,
        now,
        targetLocale,
      );
      return dtoOf(fresh, freshTask.state, stepId);
    }
    return dtoOf(fresh, freshTask.state);
  });
}

/**
 * Zachowany wynik ścieżki mowy zapisywany w answer (SPEC §20, §26): potrzebna
 * transkrypcja i identyfikacja providerów — nigdy surowe odpowiedzi usług
 * ani bajty nagrania.
 */
export interface AttemptAnswerPatch {
  transcript: string | null;
  sttProvider: string | null;
  pronunciationProvider: string | null;
}

/**
 * Finalizacja próby z gotową oceną — ścieżka oceny mowy (zadanie 8) i testów
 * awarii. Idempotentna: ponowne wywołanie dla próby completed zwraca jej wynik.
 * `answer` uzupełnia rekord przetworzonej próby w tej samej transakcji.
 */
export async function finalizeAttempt(
  services: Services,
  attemptId: string,
  grade: Grade,
  answer?: AttemptAnswerPatch,
): Promise<AttemptDto> {
  const id = UuidSchema.parse(attemptId);
  return services.db.transaction(async (tx) => {
    const taskRef = (await tx.select({ taskId: attempts.taskId }).from(attempts).where(eq(attempts.id, id)))[0];
    if (!taskRef) {
      throw new AppError("not_found");
    }
    const { task, session, itemId, targetKey, targetLocale, revisionPayload } = await lockTaskWithSession(tx, taskRef.taskId);
    // odczyt dopiero pod blokadą sesji — równoległy finalizer mógł już zatwierdzić
    const attempt = (await tx.select().from(attempts).where(eq(attempts.id, id)))[0];
    if (!attempt) {
      throw new AppError("not_found");
    }
    if (session.mode === "daily_round") {
      if (attempt.state === "completed") return dtoOf(attempt, task.state);
      throw new AppError("conflict", { message: "daily-round sessions are retired" });
    }
    const now = services.clock.now();

    if (attempt.state === "completed") {
      const freshTask = (await tx.select().from(sessionTasks).where(eq(sessionTasks.id, task.id)))[0]!;
      if (session.mode !== "mock_test" && attempt.feedback) {
        const stepId = await discloseFeedback(
          tx,
          freshTask,
          attempt.childId,
          itemId,
          attempt.feedback as FeedbackDto,
          targetKey,
          now,
          targetLocale,
        );
        return dtoOf(attempt, freshTask.state, stepId);
      }
      return dtoOf(attempt, freshTask.state);
    }

    if (answer) {
      await tx
        .update(attempts)
        .set({
          answer: {
            transcript: answer.transcript === null ? null : answer.transcript.slice(0, 200),
            stt: answer.sttProvider,
            pronunciation: answer.pronunciationProvider,
          } as unknown as Record<string, unknown>,
        })
        .where(and(eq(attempts.id, id), eq(attempts.state, "processing")));
    }
    const current = answer
      ? (await tx.select().from(attempts).where(eq(attempts.id, id)))[0]!
      : attempt;

    const policy = await loadPolicy(tx, attempt.policyId);
    return finalizeAttemptRow(
      tx,
      task,
      session,
      itemId,
      current,
      current.modality as AnyModality,
      grade,
      policy,
      targetKey,
      now,
      { targetLocale, revisionPayload },
    );
  });
}

/**
 * Leniwa finalizacja: próby processing starsze niż 60 s zamieniają się w
 * nieocenione (technical) bez osobnego joba w tle (arch §9.2a). Zadanie
 * pozostaje issued — błąd techniczny nie jest błędem wiedzy.
 */
async function lazyFinalizeProcessing(
  tx: Tx,
  task: TaskRow,
  session: SessionRow,
  itemId: string,
  now: Date,
  revision: { targetKey: string; targetLocale: string; revisionPayload: unknown },
  preloadedTaskAttempts?: readonly AttemptRow[],
): Promise<{ finalizedAny: boolean; finalizedIds: ReadonlySet<string> }> {
  const finalizedIds = new Set<string>();
  if (session.mode === "daily_round") return { finalizedAny: false, finalizedIds };
  const taskAttempts = preloadedTaskAttempts ?? await tx
    .select()
    .from(attempts)
    .where(eq(attempts.taskId, task.id));
  const stale = taskAttempts.filter((attempt) => attempt.state === "processing");
  for (const attempt of stale) {
    if (now.getTime() - attempt.receivedAt.getTime() <= ATTEMPT_PROCESSING_TIMEOUT_MS) {
      continue;
    }
    const policy = await loadPolicy(tx, attempt.policyId);
    const frozen = attempt.context as Partial<FrozenContext>;
    const qualification = qualifyAttempt({
      receivedAt: attempt.receivedAt.toISOString(),
      policy,
      lastExposureAt: frozen.lastExposureAt ?? null,
      firstTry: frozen.firstTry ?? attempt.attemptNumber === 1,
      assistance: frozen.assistance ?? [],
      previousSessionContactAt: frozen.previousSessionContactAt ?? null,
      timezone: frozen.timezone ?? "Europe/Warsaw",
    });
    const skills: Partial<Record<Skill, SkillGrade>> = {};
    for (const skill of assessedSkills(task.exerciseType as ExerciseType)) {
      skills[skill] = {
        outcome: "unevaluated",
        reason: "technical",
        independent: false,
        confirmationEligible: false,
      };
    }
    await finalizeAttemptRow(
      tx,
      task,
      session,
      itemId,
      attempt,
      attempt.modality as AnyModality,
      { skills, attempt: qualification },
      policy,
      revision.targetKey,
      now,
      revision,
    );
    finalizedIds.add(attempt.id);
  }
  if (contextOf(session).microphoneDisabledTaskIds.includes(task.id)) {
    await completeDisabledVoiceTask(tx, session.id, task.id);
  }
  return { finalizedAny: finalizedIds.size > 0, finalizedIds };
}
