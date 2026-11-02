import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lte, max, sql } from "drizzle-orm";
import type { TaskDto, TaskPrompt } from "@learning/contracts";
import type { Services } from "../../../config";
import type { Executor, Tx } from "../../../db/client";
import {
  assessments,
  attempts,
  childObjectiveProgress,
  deckVersions,
  eventExposures,
  itemRevisions,
  learningEvents,
  learningSessions,
  lessonCardAssets,
  mediaAssets,
  revisionAssets,
  sessionTasks,
} from "../../../db/schema";
import { AppError } from "../../../errors";
import type { DynamicTopicData, LearningObjective, LessonExerciseType, LessonTopic, SubjectModule } from "../../../domain/lessons/types";
import { resolveLessonTopic } from "../../../domain/lessons/topic-resolution";
import {
  selectLessonTask,
  type LessonExerciseCandidate,
  type LessonScheduleInput,
  type LessonSessionOutcome,
  type LessonSessionTask,
  type LessonTaskPlan,
  type ObjectivePrecisionSnapshot,
  type ObjectiveProgressSnapshot,
} from "../../../domain/lessons/scheduler";
import { DEFAULT_LESSON_POLICY } from "../../../domain/lessons/lesson-policy";
import { renderCard } from "../../../domain/lessons/card";
import { computeTargetKey } from "../../../domain/target-key";
import { isTestPreparationWindow } from "../../../domain/test-preparation";
import type { ProgressStatus } from "../../../domain/types";
import type { LessonTrainingSessionPlanSnapshot, LessonTrainingSessionSlot } from "../../../domain/training-session-plan";
import { readLessonTrainingSessionPlan } from "../../../domain/training-session-plan";
import { contextOf, writeSealedEvent, type SessionContextShape } from "../events";
import { mapObjectiveStatus as mapStatus } from "../../../domain/lessons/progress-status";
import {
  materializeCard,
  materializeExercise,
  speechInputFor,
  type LessonExercisePayload,
  type LoadedExercise,
  type MaterializedLessonTask,
} from "./lesson-materialize";
import { listenStimulusAssetId } from "./listen-stimulus";

/**
 * Sesja lekcji po stronie serwera (zadanie 13). `sessions.ts` deleguje tu dla
 * zestawów `kind='lesson'`: `buildLessonSessionContext` daje kontekst startowy,
 * `issueNextLessonTask` składa wejście selektora z bazy, woła `selectLessonTask`
 * i wydaje zadanie (publiczny prompt + prywatny `answer_key`), zapisując
 * ekspozycje ujawnianej treści PRZED odpowiedzią HTTP w tej samej transakcji.
 *
 * Kroki wspólne obu rodzajów (blokada profilu, jedna aktywna sesja, wznowienie,
 * przeterminowanie, budżet, limit czasu, obietnica „Jeszcze N”) są w `sessions.ts`
 * i działają przed delegacją — tu żyje wyłącznie to, co w lekcjach inne niż w
 * słówkach. Vocabulary pozostaje nietknięte.
 */

/** Domyślny limit wywołań modelu na sesję, gdy grader niekonfigurowany (zadanie 15). */
const GRADER_CALLS_PER_SESSION_FALLBACK = 20;

/** Kontekst sesji lekcji: pola wspólne + lekcyjne (bezpieczne rozszerzenie). */
export interface LessonSessionContext extends SessionContextShape {
  /** Wywołania modelu oceniającego w tej sesji (limit polityki) — zadanie 13B/15. */
  graderCalls: number;
  /** Ostatni kontakt dziecka z ćwiczeniem danego celu przed startem sesji. */
  previousObjectiveContact: Record<string, string>;
  initialObjectiveProgress?: Record<string, ObjectiveProgressSnapshot>;
  supportObjectives?: string[];
  /** Dyktowania w tej sesji (limit kosztu, design szkoły §5.4). */
  dictationCalls?: number;
  /** Skrót ostatniego dyktowania per zadanie — tekst dziecka nie jest tu zapisywany. */
  dictations?: Record<string, string>;
}

/** `lesson_context` zapisany w `deck_versions.lesson_context`. */
export interface LessonContextShape {
  subjectId: string;
  topicId: string;
  topicVersion: number;
  objectiveIds: string[];
  examples: Record<string, string[]>;
  dynamicTopic?: DynamicTopicData;
  subjectTitlePl?: string;
}

/** Odczyt `lesson_context` z wersji sesji; rzuca, gdy brak (nie powinno się zdarzyć dla lekcji). */
export function lessonContextOf(version: Pick<typeof deckVersions.$inferSelect, "lessonContext">): LessonContextShape {
  const raw = version.lessonContext as Partial<LessonContextShape> | null;
  if (!raw || typeof raw.subjectId !== "string" || typeof raw.topicId !== "string") {
    throw new AppError("internal", { message: "lesson version without lesson_context" });
  }
  return {
    subjectId: raw.subjectId,
    topicId: raw.topicId,
    topicVersion: typeof raw.topicVersion === "number" ? raw.topicVersion : 1,
    objectiveIds: Array.isArray(raw.objectiveIds) ? raw.objectiveIds : [],
    examples: raw.examples ?? {},
    ...(raw.dynamicTopic ? { dynamicTopic: raw.dynamicTopic } : {}),
    ...(typeof raw.subjectTitlePl === "string" ? { subjectTitlePl: raw.subjectTitlePl } : {}),
  };
}

/** Przypięta wersja tematu z rejestru (publikacja przypina `topicVersion`). */
export function requireTopic(services: Services, ctx: LessonContextShape): { subject: SubjectModule; topic: LessonTopic } {
  const resolved = resolveLessonTopic(services.subjects, ctx);
  const subject = resolved?.subject;
  const topic = resolved?.topic;
  if (!subject || !topic) {
    throw new AppError("internal", { message: `lesson subject/topic missing: ${ctx.subjectId}/${ctx.topicId} v${ctx.topicVersion}` });
  }
  return { subject, topic };
}

/** Czy model oceniający jest skonfigurowany (zadanie 15 — rzeczywisty port). */
function graderAvailable(services: Services): boolean {
  return services.grader !== undefined;
}

/**
 * Snapshot ostatniego kontaktu dziecka z każdym celem PRZED startem sesji
 * (odpowiednik `previousContactSnapshot` słówek): najpóźniejsze zdarzenie na
 * dowolnym ćwiczeniu celu w tej wersji, zamrożone w kontekście przy starcie.
 */
async function previousObjectiveContactSnapshot(
  tx: Tx,
  childId: string,
  deckVersionId: string,
  before: Date,
): Promise<Record<string, string>> {
  const rows = await tx
    .select({ payload: itemRevisions.payload, latest: max(learningEvents.occurredAt) })
    .from(learningEvents)
    .innerJoin(sessionTasks, eq(sessionTasks.id, learningEvents.taskId))
    .innerJoin(itemRevisions, eq(itemRevisions.id, sessionTasks.itemRevisionId))
    .where(and(eq(learningEvents.childId, childId), eq(itemRevisions.deckVersionId, deckVersionId), lte(learningEvents.occurredAt, before)))
    .groupBy(itemRevisions.payload);
  const result: Record<string, string> = {};
  for (const row of rows) {
    const objectiveId = (row.payload as { objectiveId?: string }).objectiveId;
    if (!objectiveId || !row.latest) continue;
    const iso = row.latest.toISOString();
    if (!result[objectiveId] || iso > result[objectiveId]!) {
      result[objectiveId] = iso;
    }
  }
  return result;
}

/** Cele, których ostatnia oceniona próba w treningu była błędna lub „Nie pamiętam”. */
async function historicalSupportObjectives(
  tx: Tx,
  args: { childId: string; subjectId: string; objectiveIds: readonly string[]; before: Date },
): Promise<string[]> {
  if (args.objectiveIds.length === 0) return [];
  const rows = await tx.select({
    taskId: sessionTasks.id, payload: itemRevisions.payload, ordinal: sessionTasks.ordinal,
    startedAt: learningSessions.startedAt, lessonContext: deckVersions.lessonContext,
  }).from(sessionTasks)
    .innerJoin(learningSessions, eq(learningSessions.id, sessionTasks.sessionId))
    .innerJoin(deckVersions, eq(deckVersions.id, sessionTasks.deckVersionId))
    .innerJoin(itemRevisions, eq(itemRevisions.id, sessionTasks.itemRevisionId))
    .where(and(
      eq(learningSessions.childId, args.childId), eq(learningSessions.mode, "training"),
      lte(learningSessions.startedAt, args.before),
      // Poprawka po informacji zwrotnej („Skróć odpowiedź”) nie jest trudnością celu.
      sql`${sessionTasks.context}->'followUpOf' is null`,
      sql`${deckVersions.lessonContext}->>'subjectId' = ${args.subjectId}`,
      inArray(sql<string>`${itemRevisions.payload}->>'objectiveId'`, args.objectiveIds),
    ));
  const tasks = rows.flatMap((row) => {
    const payload = row.payload as { objectiveId?: string; exerciseType?: string };
    // Zadanie słuchowe nie jest dowodem trudności reguły ani jej przezwyciężenia
    // (spec #198 §3.3): pomijamy je całkowicie, niezależnie od wyniku.
    if (payload?.exerciseType === "lesson_listen_choice") return [];
    const lessonContext = row.lessonContext as { subjectId?: string } | null;
    const objectiveId = payload?.objectiveId;
    if (lessonContext?.subjectId !== args.subjectId || !objectiveId || !args.objectiveIds.includes(objectiveId)) return [];
    return [{ taskId: row.taskId, objectiveId, ordinal: row.ordinal, startedAt: row.startedAt }];
  });
  if (tasks.length === 0) return [];
  const attemptsByTask = await tx.select({
    taskId: attempts.taskId, attemptNumber: attempts.attemptNumber, modality: attempts.modality,
    state: attempts.state, outcome: assessments.outcome,
  }).from(attempts).leftJoin(assessments, eq(assessments.attemptId, attempts.id))
    .where(inArray(attempts.taskId, tasks.map((row) => row.taskId))).orderBy(asc(attempts.attemptNumber));
  const resultByTask = new Map<string, typeof attemptsByTask>();
  for (const row of attemptsByTask) resultByTask.set(row.taskId, [...(resultByTask.get(row.taskId) ?? []), row]);
  const latestByObjective = new Map<string, { time: number; ordinal: number; support: boolean }>();
  for (const task of tasks) {
    const completed = (resultByTask.get(task.taskId) ?? []).filter((row) => row.state === "completed");
    const latest = completed[completed.length - 1];
    if (!latest) continue;
    const support = latest.modality === "dont_remember" || latest.outcome === "incorrect";
    if (!support && latest.outcome !== "correct") continue;
    const prior = latestByObjective.get(task.objectiveId);
    const time = task.startedAt.getTime();
    if (!prior || time > prior.time || (time === prior.time && task.ordinal >= prior.ordinal)) {
      latestByObjective.set(task.objectiveId, { time, ordinal: task.ordinal, support });
    }
  }
  return [...latestByObjective].filter(([, value]) => value.support).map(([id]) => id);
}

/** Buduje kontekst startowy sesji lekcji (wołane z `startSession` w `sessions.ts`). */
export async function buildLessonSessionContext(
  tx: Tx,
  args: { childId: string; deckVersionId: string; timezone: string; testDate: string | null | undefined; now: Date },
): Promise<LessonSessionContext> {
  const version = (await tx.select().from(deckVersions).where(eq(deckVersions.id, args.deckVersionId)))[0]!;
  const context = lessonContextOf(version);
  const rows = await tx.select().from(childObjectiveProgress).where(and(
    eq(childObjectiveProgress.childId, args.childId), eq(childObjectiveProgress.subjectId, context.subjectId),
  ));
  const initialObjectiveProgress: Record<string, ObjectiveProgressSnapshot> = {};
  for (const row of rows) {
    initialObjectiveProgress[row.objectiveId] = { status: mapStatus(row.status), nextReviewAt: row.nextReviewAt?.toISOString() ?? null };
  }
  return {
    timezone: args.timezone,
    canRead: true,
    vocabularyFormat: "standard",
    microphoneDisabledTaskIds: [],
    ...(args.testDate === undefined ? {} : { testDate: args.testDate }),
    previousContact: {},
    reservations: [],
    settledChecks: [],
    graderCalls: 0,
    previousObjectiveContact: await previousObjectiveContactSnapshot(tx, args.childId, args.deckVersionId, args.now),
    supportObjectives: await historicalSupportObjectives(tx, {
      childId: args.childId, subjectId: context.subjectId, objectiveIds: context.objectiveIds, before: args.now,
    }),
    initialObjectiveProgress,
  };
}

/** Odczyt kontekstu lekcji z sesji (bez utraty pól bazowych). */
export function lessonSessionContextOf(session: { context: Record<string, unknown> }): LessonSessionContext {
  const base = contextOf(session);
  const raw = session.context as Partial<LessonSessionContext>;
  return {
    ...base,
    graderCalls: typeof raw.graderCalls === "number" ? raw.graderCalls : 0,
    previousObjectiveContact: raw.previousObjectiveContact ?? {},
    supportObjectives: Array.isArray(raw.supportObjectives) ? raw.supportObjectives.filter((id): id is string => typeof id === "string") : [],
    ...(raw.initialObjectiveProgress === undefined ? {} : { initialObjectiveProgress: raw.initialObjectiveProgress }),
    // Zapis kontekstu z tej funkcji (np. licznik gradera) nie może gubić stanu dyktowania.
    ...(typeof raw.dictationCalls === "number" ? { dictationCalls: raw.dictationCalls } : {}),
    ...(raw.dictations && typeof raw.dictations === "object" ? { dictations: raw.dictations } : {}),
  };
}

/** Ładuje pulę ćwiczeń przypiętej wersji w kolejności pozycji. */
export async function loadExercises(
  tx: Executor,
  deckVersionId: string,
  options: { questionAudio?: boolean; feedbackAudio?: boolean } = {},
): Promise<LoadedExercise[]> {
  const revisions = await tx
    .select({ id: itemRevisions.id, itemId: itemRevisions.itemId, position: itemRevisions.position, payload: itemRevisions.payload, targetKey: itemRevisions.targetKey })
    .from(itemRevisions)
    .where(eq(itemRevisions.deckVersionId, deckVersionId))
    .orderBy(asc(itemRevisions.position), asc(itemRevisions.id));

  // Audio odpowiedzi kanonicznej (`target_audio`) przygotowane przy publikacji,
  // gdy przedmiot ma `ttsForAnswers`. Odtwarzane jako wsparcie w ćwiczeniach
  // tekstowych (wym. 4.6); `materializeExercise` dołącza je tylko do tych typów.
  // Liczy się wyłącznie gotowy zasób (`revision_assets.state='approved'` i
  // `media_assets.state='ready'`), identycznie jak słówka rozwiązują audio.
  const revisionIds = revisions.map((r) => r.id);
  const audioRows = revisionIds.length
    ? await tx
        .select({ itemRevisionId: revisionAssets.itemRevisionId, assetId: revisionAssets.assetId })
        .from(revisionAssets)
        .innerJoin(mediaAssets, eq(mediaAssets.id, revisionAssets.assetId))
        .where(
          and(
            inArray(revisionAssets.itemRevisionId, revisionIds),
            eq(revisionAssets.role, "target_audio"),
            eq(revisionAssets.state, "approved"),
            eq(mediaAssets.state, "ready"),
          ),
        )
    : [];
  const audioByRevision = new Map(audioRows.map((a) => [a.itemRevisionId, a.assetId] as const));
  // Nagranie pytania (design szkoły §11.2): publikacja na nie nie czeka, a wiersz
  // opublikowanej rewizji jest niezmienny — liczy się więc dowolny gotowy zasób
  // o oczekiwanym fingerprincie tekstu (najnowsza generacja), także powstały po
  // publikacji albo po porażce zasobu powiązanego przy edycji.
  const promptAudioRows = revisionIds.length && options.questionAudio !== false
    ? await tx
        .select({ itemRevisionId: revisionAssets.itemRevisionId, assetId: mediaAssets.id })
        .from(revisionAssets)
        .innerJoin(mediaAssets, eq(mediaAssets.fingerprint, revisionAssets.expectedFingerprint))
        .where(
          and(
            inArray(revisionAssets.itemRevisionId, revisionIds),
            eq(revisionAssets.role, "prompt_audio"),
            eq(mediaAssets.kind, "tts"),
            eq(mediaAssets.state, "ready"),
          ),
        )
        .orderBy(desc(mediaAssets.generationNumber))
    : [];
  const promptAudioByRevision = new Map<string, string>();
  for (const row of promptAudioRows) {
    if (!promptAudioByRevision.has(row.itemRevisionId)) promptAudioByRevision.set(row.itemRevisionId, row.assetId);
  }

  // Nagranie pełnego zdania feedbacku: rozwiązywane jak `prompt_audio`.
  const feedbackAudioRows = revisionIds.length && options.feedbackAudio !== false
    ? await tx
        .select({ itemRevisionId: revisionAssets.itemRevisionId, assetId: mediaAssets.id })
        .from(revisionAssets)
        .innerJoin(mediaAssets, eq(mediaAssets.fingerprint, revisionAssets.expectedFingerprint))
        .where(
          and(
            inArray(revisionAssets.itemRevisionId, revisionIds),
            eq(revisionAssets.role, "feedback_audio"),
            eq(mediaAssets.kind, "tts"),
            eq(mediaAssets.state, "ready"),
          ),
        )
        .orderBy(desc(mediaAssets.generationNumber))
    : [];
  const feedbackAudioByRevision = new Map<string, string>();
  for (const row of feedbackAudioRows) {
    if (!feedbackAudioByRevision.has(row.itemRevisionId)) feedbackAudioByRevision.set(row.itemRevisionId, row.assetId);
  }

  return revisions.map((r) => ({
    revisionId: r.id,
    itemId: r.itemId,
    position: r.position,
    payload: r.payload as unknown as LessonExercisePayload,
    targetKey: r.targetKey,
    audioAssetId: audioByRevision.get(r.id) ?? null,
    questionAudioAssetId: promptAudioByRevision.get(r.id) ?? null,
    feedbackAudioAssetId: feedbackAudioByRevision.get(r.id) ?? null,
  }));
}

/** Klucz nagrania karty w mapie `loadLessonCardAudio`. */
export function lessonCardAudioKey(objectiveId: string, cardIndex: number): string {
  return `${cardIndex}:${objectiveId}`;
}

/**
 * Nagrania „Posłuchaj karty” wersji (design szkoły §12.3): jak nagrania pytań —
 * najnowszy gotowy zasób TTS o oczekiwanym fingerprincie wiersza karty,
 * niezależnie od zasobu powiązanego przy edycji (publikacja na nie nie czeka).
 */
export async function loadLessonCardAudio(tx: Executor, deckVersionId: string): Promise<Map<string, string>> {
  const rows = await tx
    .select({ objectiveId: lessonCardAssets.objectiveId, cardIndex: lessonCardAssets.cardIndex, assetId: mediaAssets.id })
    .from(lessonCardAssets)
    .innerJoin(mediaAssets, eq(mediaAssets.fingerprint, lessonCardAssets.expectedFingerprint))
    .where(and(eq(lessonCardAssets.deckVersionId, deckVersionId), eq(mediaAssets.kind, "tts"), eq(mediaAssets.state, "ready")))
    .orderBy(desc(mediaAssets.generationNumber));
  const audio = new Map<string, string>();
  for (const row of rows) {
    const key = lessonCardAudioKey(row.objectiveId, row.cardIndex);
    if (!audio.has(key)) audio.set(key, row.assetId);
  }
  return audio;
}

/** Liczba wydanych i ocenianych zadań (karty nie liczą się do budżetu). */
/**
 * Liczniki zadań sesji lekcji: `total` wyznacza kolejny ordinal, a `assessed`
 * budżet — bez zadań następczych (`context.followUpOf`), które są dodatkiem
 * trenera precyzji poza planem.
 */
export async function lessonTaskCounts(tx: Tx, sessionId: string): Promise<{ total: number; assessed: number; planned: number }> {
  const [row] = await tx
    .select({
      total: sql<number>`count(*)::int`,
      planned: sql<number>`(count(*) filter (where ${sessionTasks.context}->'followUpOf' is null))::int`,
      assessed: sql<number>`(count(*) filter (where ${sessionTasks.exerciseType} <> 'lesson_card' and ${sessionTasks.context}->'followUpOf' is null))::int`,
    })
    .from(sessionTasks)
    .where(eq(sessionTasks.sessionId, sessionId));
  return { total: row?.total ?? 0, assessed: row?.assessed ?? 0, planned: row?.planned ?? 0 };
}

/** Wynik oceny per zadanie tej sesji (z `assessments` przez `attempts`). */
async function loadSessionOutcomes(tx: Tx, sessionId: string): Promise<Map<string, LessonSessionOutcome>> {
  const rows = await tx
    .select({ taskId: attempts.taskId, modality: attempts.modality, outcome: assessments.outcome, feedback: attempts.feedback })
    .from(attempts)
    .innerJoin(sessionTasks, eq(sessionTasks.id, attempts.taskId))
    .leftJoin(assessments, eq(assessments.attemptId, attempts.id))
    .where(eq(sessionTasks.sessionId, sessionId));
  const byTask = new Map<string, LessonSessionOutcome>();
  for (const row of rows) {
    let outcome: LessonSessionOutcome;
    if (row.modality === "skip") outcome = "skipped";
    else if (row.modality === "dont_remember") outcome = "dont_remember";
    else if (row.outcome === "correct") outcome = "correct";
    else if (row.outcome === "incorrect") outcome = "incorrect";
    else outcome = "unevaluated";
    byTask.set(row.taskId, outcome);
  }
  return byTask;
}

interface PlannedLesson {
  plan: LessonTaskPlan;
  exercises: LoadedExercise[];
  topic: LessonTopic;
  subject: SubjectModule;
  context: LessonContextShape;
  cardIndexByObjective: Map<string, number>;
}

interface LessonPlanningSnapshot {
  exercises: LoadedExercise[];
  topic: LessonTopic;
  subject: SubjectModule;
  context: LessonContextShape;
  objectiveOrder: string[];
  progress: Record<string, { status: ProgressStatus; nextReviewAt: string | null }>;
  exposedTargetKeys: Set<string>;
  sessionHistory: LessonSessionTask[];
  lastSeenAt: Record<string, string>;
  cardCountByObjective: Record<string, number>;
  cardIndexByObjective: Map<string, number>;
  sessionContext: LessonSessionContext;
  testWindowOpen: boolean;
  precisionHistory: Record<string, ObjectivePrecisionSnapshot>;
}

const KNOWLEDGE_VALUES = new Set(["correct", "partial", "incorrect"]);
const PRECISION_VALUES = new Set(["concise", "verbose", "unfocused"]);

/**
 * Trener precyzji (design 6.4): ostatnia ocena dwuwymiarowa odpowiedzi otwartej
 * per cel sprzed startu sesji. Zadania następcze („Skróć odpowiedź”) się nie
 * liczą — to poprawka po informacji zwrotnej, nie odpowiedź na pytanie.
 */
async function objectivePrecisionHistory(
  tx: Tx,
  args: { childId: string; objectiveIds: readonly string[]; before: Date },
): Promise<Record<string, ObjectivePrecisionSnapshot>> {
  if (args.objectiveIds.length === 0) return {};
  const rows = await tx
    .select({ details: assessments.details })
    .from(assessments)
    .innerJoin(attempts, eq(attempts.id, assessments.attemptId))
    .innerJoin(sessionTasks, eq(sessionTasks.id, attempts.taskId))
    .where(and(
      eq(assessments.childId, args.childId),
      eq(assessments.skill, "objective"),
      sql`${assessments.details} ? 'precision'`,
      sql`${sessionTasks.context}->'followUpOf' is null`,
      lte(attempts.receivedAt, args.before),
      inArray(sql<string>`${assessments.details}->>'objectiveId'`, [...args.objectiveIds]),
    ))
    .orderBy(desc(attempts.receivedAt), desc(attempts.id));
  const result: Record<string, ObjectivePrecisionSnapshot> = {};
  for (const row of rows) {
    const details = row.details as { objectiveId?: unknown; knowledge?: unknown; precision?: unknown; confusedConcepts?: unknown } | null;
    const objectiveId = typeof details?.objectiveId === "string" ? details.objectiveId : null;
    if (!objectiveId || objectiveId in result) continue;
    if (KNOWLEDGE_VALUES.has(String(details?.knowledge)) && PRECISION_VALUES.has(String(details?.precision))) {
      const confusedConcepts = Array.isArray(details!.confusedConcepts)
        ? (details!.confusedConcepts as unknown[]).flatMap((pair) => {
            const candidate = pair as { said?: unknown; meant?: unknown } | null;
            return typeof candidate?.said === "string" && typeof candidate.meant === "string" ? [{ said: candidate.said, meant: candidate.meant }] : [];
          })
        : [];
      result[objectiveId] = {
        knowledge: details!.knowledge, precision: details!.precision,
        ...(confusedConcepts.length > 0 ? { confusedConcepts } : {}),
      } as ObjectivePrecisionSnapshot;
    }
  }
  return result;
}

/** Odczytuje raz stan potrzebny do zaplanowania całej sesji lekcji. */
async function loadLessonPlanningSnapshot(
  services: Services,
  tx: Tx,
  session: typeof learningSessions.$inferSelect,
  now: Date,
): Promise<LessonPlanningSnapshot | null> {
  const version = (await tx.select().from(deckVersions).where(eq(deckVersions.id, session.deckVersionId)))[0]!;
  const context = lessonContextOf(version);
  const { subject, topic } = requireTopic(services, context);
  const allExercises = await loadExercises(tx, session.deckVersionId);
  const exercises = allExercises;
  if (exercises.length === 0) {
    return null;
  }

  const objectiveById = new Map(topic.objectives.map((o) => [o.id, o] as const));
  const objectiveOrder = topic.objectives.map((o) => o.id).filter((id) => context.objectiveIds.includes(id));
  const cardCountByObjective: Record<string, number> = {};
  for (const id of objectiveOrder) {
    cardCountByObjective[id] = objectiveById.get(id)?.cards.length ?? 0;
  }

  const progressRows = await tx
    .select({ objectiveId: childObjectiveProgress.objectiveId, status: childObjectiveProgress.status, nextReviewAt: childObjectiveProgress.nextReviewAt })
    .from(childObjectiveProgress)
    .where(and(eq(childObjectiveProgress.childId, session.childId), eq(childObjectiveProgress.subjectId, context.subjectId)));
  const progress: Record<string, { status: ProgressStatus; nextReviewAt: string | null }> = {};
  for (const row of progressRows) {
    progress[row.objectiveId] = { status: mapStatus(row.status), nextReviewAt: row.nextReviewAt?.toISOString() ?? null };
  }

  const targetKeys = [...new Set(exercises.map((e) => e.targetKey))];
  const historicalRows = targetKeys.length
    ? await tx
        .select({ targetKey: eventExposures.targetKey })
        .from(eventExposures)
        .innerJoin(learningEvents, eq(learningEvents.id, eventExposures.eventId))
        .where(and(eq(eventExposures.childId, session.childId), eq(learningEvents.sealed, true), lte(learningEvents.occurredAt, session.startedAt), inArray(eventExposures.targetKey, targetKeys)))
    : [];
  const exposedTargetKeys = new Set(historicalRows.map((r) => r.targetKey));

  const taskRows = await tx
    .select({ id: sessionTasks.id, itemRevisionId: sessionTasks.itemRevisionId, ordinal: sessionTasks.ordinal, exerciseType: sessionTasks.exerciseType, context: sessionTasks.context })
    .from(sessionTasks)
    .where(eq(sessionTasks.sessionId, session.id))
    .orderBy(asc(sessionTasks.ordinal));
  const exerciseByRevision = new Map(exercises.map((e) => [e.revisionId, e] as const));
  const outcomeByTask = await loadSessionOutcomes(tx, session.id);
  const cardIndexByObjective = new Map<string, number>();
  // Zadania następcze są poza planem: selektor ich nie widzi (design 6.3).
  const plannedRows = taskRows.filter((row) => (row.context as { followUpOf?: unknown } | null)?.followUpOf === undefined);
  const sessionHistory: LessonSessionTask[] = plannedRows.map((row) => {
    const taskContext = row.context as { objectiveId?: string; cardPurpose?: string } | null;
    const exercise = exerciseByRevision.get(row.itemRevisionId);
    const type = row.exerciseType as LessonExerciseType;
    const objectiveId = taskContext?.objectiveId ?? exercise?.payload.objectiveId ?? "";
    const kind: LessonSessionTask["kind"] =
      type === "lesson_card" ? (taskContext?.cardPurpose === "support" ? "support_card" : "card") : "exercise";
    if (kind === "card") {
      cardIndexByObjective.set(objectiveId, (cardIndexByObjective.get(objectiveId) ?? 0) + 1);
    }
    const outcome = outcomeByTask.get(row.id);
    return {
      ordinal: row.ordinal,
      itemId: kind === "exercise" ? exercise?.itemId ?? null : null,
      objectiveId,
      exerciseType: type,
      kind,
      ...(outcome ? { outcome } : {}),
    };
  });

  const lastSeenAt: Record<string, string> = {};
  const issuedRows = await tx
    .select({ itemId: itemRevisions.itemId, latest: max(sessionTasks.issuedAt) })
    .from(sessionTasks)
    .innerJoin(itemRevisions, eq(itemRevisions.id, sessionTasks.itemRevisionId))
    .where(and(eq(sessionTasks.childId, session.childId), inArray(itemRevisions.itemId, exercises.map((exercise) => exercise.itemId))))
    .groupBy(itemRevisions.itemId);
  for (const row of issuedRows) {
    if (row.latest) lastSeenAt[row.itemId] = row.latest.toISOString();
  }
  const sessionContext = lessonSessionContextOf(session);
  const testWindowOpen =
    sessionContext.testDate != null && isTestPreparationWindow({ now: now.toISOString(), testDate: sessionContext.testDate, timezone: sessionContext.timezone });

  const precisionHistory = await objectivePrecisionHistory(tx, { childId: session.childId, objectiveIds: objectiveOrder, before: session.startedAt });

  return {
    exercises, topic, subject, context, objectiveOrder, progress, exposedTargetKeys,
    sessionHistory, lastSeenAt, cardCountByObjective, cardIndexByObjective,
    sessionContext, testWindowOpen, precisionHistory,
  };
}

/** Składa wejście selektora z migawki i wywołuje go bez ponownych odczytów bazy. */
function planLessonTaskFromSnapshot(
  services: Services,
  session: typeof learningSessions.$inferSelect,
  now: Date,
  assessedRemaining: number,
  snapshot: LessonPlanningSnapshot,
  plannedPrefix: readonly LessonTrainingSessionSlot[] = [],
  planningMode = false,
): PlannedLesson | null {
  const { exercises, topic, subject, context } = snapshot;
  const exposedTargetKeys = new Set([...snapshot.exposedTargetKeys, ...plannedPrefix.flatMap((slot) => slot.revealsTargetKeys)]);
  const cardIndexByObjective = new Map(snapshot.cardIndexByObjective);
  const sessionHistory = [...snapshot.sessionHistory, ...plannedPrefix.map((slot) => ({
    ordinal: slot.ordinal,
    itemId: slot.taskKind === "exercise" ? slot.itemId : null,
    objectiveId: String(slot.context.objectiveId ?? ""),
    exerciseType: slot.exerciseType as LessonExerciseType,
    kind: slot.taskKind,
  }))];
  for (const slot of plannedPrefix) {
    if (slot.taskKind === "card") {
      const objectiveId = String(slot.context.objectiveId ?? "");
      cardIndexByObjective.set(objectiveId, (cardIndexByObjective.get(objectiveId) ?? 0) + 1);
    }
  }
  const lastSeenAt = { ...snapshot.lastSeenAt };
  for (const slot of plannedPrefix) {
    if (slot.taskKind === "exercise") lastSeenAt[slot.itemId] = now.toISOString();
  }

  const input: LessonScheduleInput = {
    exercises: exercises.map(
      (e): LessonExerciseCandidate => ({
        itemId: e.itemId, itemRevisionId: e.revisionId, objectiveId: e.payload.objectiveId, exerciseType: e.payload.exerciseType, targetKey: e.targetKey,
        ...(e.payload.familyId ? { familyId: e.payload.familyId } : {}),
        ...(e.payload.expectedForm ? { expectedForm: e.payload.expectedForm } : {}),
        ...(e.payload.questionType ? { questionType: e.payload.questionType } : {}),
        ...(e.payload.questionType === "comparison"
          ? { searchText: [e.payload.prompt ?? "", ...(e.payload.requiredElements ?? []).map((el) => el.text)].join(" ") }
          : {}),
        // Gotowość nagrania-bodźca tylko dla zadań słuchowych; ta sama reguła co materializacja.
        ...(e.payload.exerciseType === "lesson_listen_choice"
          ? { stimulusAudioReady: listenStimulusAssetId(e, subject, "training") !== null }
          : {}),
      }),
    ),
    objectiveOrder: snapshot.objectiveOrder,
    progress: snapshot.progress,
    ...(snapshot.sessionContext.initialObjectiveProgress === undefined ? {} : { initialProgress: snapshot.sessionContext.initialObjectiveProgress }),
    supportObjectives: new Set(snapshot.sessionContext.supportObjectives ?? []),
    planningMode,
    reservedDueCheckObjectives: new Set(plannedPrefix
      .filter((slot) => slot.reason === "due_check")
      .map((slot) => String(slot.context.objectiveId ?? ""))),
    exposedTargetKeys,
    sessionHistory,
    lastSeenAt,
    cardCountByObjective: snapshot.cardCountByObjective,
    assessedRemaining,
    testWindowOpen: snapshot.testWindowOpen,
    graderAvailable: graderAvailable(services),
    graderCallsLeft: Math.max(0,
      (services.grader?.maxCallsPerSession ?? GRADER_CALLS_PER_SESSION_FALLBACK) - snapshot.sessionContext.graderCalls -
      plannedPrefix.filter((slot) => slot.exerciseType === "lesson_error_fix" || slot.exerciseType === "lesson_transform" || slot.exerciseType === "lesson_open_answer").length,
    ),
    precisionHistory: snapshot.precisionHistory,
    policy: DEFAULT_LESSON_POLICY,
    now: now.toISOString(),
  };

  const plan = selectLessonTask(input);
  if (!plan) {
    return null;
  }
  return { plan, exercises, topic, subject, context, cardIndexByObjective };
}

/** Legacy dynamic sessions load a fresh snapshot for their next-task request. */
async function planLessonTask(
  services: Services,
  tx: Tx,
  session: typeof learningSessions.$inferSelect,
  now: Date,
  assessedRemaining: number,
): Promise<PlannedLesson | null> {
  const snapshot = await loadLessonPlanningSnapshot(services, tx, session, now);
  return snapshot ? planLessonTaskFromSnapshot(services, session, now, assessedRemaining, snapshot) : null;
}

/** Materiałizuje skończony plan lekcji raz podczas startu nowej sesji treningowej. */
export async function createLessonTrainingSessionPlan(
  services: Services,
  tx: Tx,
  session: typeof learningSessions.$inferSelect,
  now: Date,
): Promise<LessonTrainingSessionPlanSnapshot> {
  const planningSnapshot = await loadLessonPlanningSnapshot(services, tx, session, now);
  const cardAudio = await loadLessonCardAudio(tx, session.deckVersionId);
  const slots: LessonTrainingSessionSlot[] = [];
  let assessed = 0;
  const pushSlot = (taskId: string, materialized: MaterializedLessonTask, taskKind: LessonTrainingSessionSlot["taskKind"], reason: string): void => {
    const itemId = planningSnapshot!.exercises.find((e) => e.revisionId === materialized.itemRevisionId)!.itemId;
    slots.push({
      taskId, itemId, itemRevisionId: materialized.itemRevisionId, ordinal: slots.length,
      exerciseType: materialized.exerciseType, direction: null, assessed: materialized.exerciseType !== "lesson_card",
      prompt: materialized.prompt, answerKey: materialized.answerKey, reason, taskKind,
      context: materialized.context, revealsTargetKeys: materialized.exposures,
    });
    if (materialized.exerciseType !== "lesson_card") assessed += 1;
  };
  const maxSlots = session.taskBudget * 2 + 32;
  while (assessed < session.taskBudget && slots.length < maxSlots) {
    const planned = planningSnapshot
      ? planLessonTaskFromSnapshot(services, session, now, session.taskBudget - assessed, planningSnapshot, slots, true)
      : null;
    if (!planned) break;
    const { plan, exercises, topic, subject, context, cardIndexByObjective } = planned;
    const taskId = randomUUID();
    let materialized: MaterializedLessonTask;
    let taskKind: LessonTrainingSessionSlot["taskKind"];
    let reason: string;
    if (plan.kind === "card") {
      const objective = topic.objectives.find((o) => o.id === plan.objectiveId)!;
      const cardIndex = plan.cardPurpose === "support" ? 0 : cardIndexByObjective.get(plan.objectiveId) ?? 0;
      const anchor = exercises.find((e) => e.payload.objectiveId === plan.objectiveId) ?? exercises[0]!;
      const shownIndex = Math.min(cardIndex, objective.cards.length - 1);
      materialized = materializeCard(plan, shownIndex, objective, subject, context.examples[plan.objectiveId] ?? [], anchor.revisionId,
        cardAudio.get(lessonCardAudioKey(objective.id, shownIndex)));
      taskKind = plan.cardPurpose === "support" ? "support_card" : "card";
      reason = plan.cardPurpose === "support" ? "support" : "introduce";
    } else if (plan.pairedWith) {
      // Para trenera precyzji: wybór pojęć, a zaraz po nim odpowiedź otwarta tej
      // samej rodziny (dwa sloty; selektor sprawdził budżet na oba).
      const keywords = exercises.find((e) => e.revisionId === plan.itemRevisionId)!;
      const paired = exercises.find((e) => e.revisionId === plan.pairedWith!.itemRevisionId)!;
      const pairedOpenAnswer = { prompt: paired.payload.prompt ?? "", targetKey: paired.targetKey };
      pushSlot(taskId, materializeExercise({ ...plan, pairedOpenAnswer }, taskId, keywords, topic, subject), "exercise", plan.reason);
      const pairedTaskId = randomUUID();
      pushSlot(pairedTaskId, materializeExercise({ independentCheck: false, reason: plan.reason }, pairedTaskId, paired, topic, subject, speechInputFor(services, session, subject, paired.payload.exerciseType)), "exercise", plan.reason);
      continue;
    } else {
      const exercise = exercises.find((e) => e.revisionId === plan.itemRevisionId)!;
      materialized = materializeExercise(plan, taskId, exercise, topic, subject, speechInputFor(services, session, subject, exercise.payload.exerciseType));
      taskKind = "exercise";
      reason = plan.reason;
    }
    pushSlot(taskId, materialized, taskKind, reason);
  }
  const snapshot = { version: 1 as const, kind: "lesson" as const, taskBudget: Math.max(1, assessed), slots };
  const validated = readLessonTrainingSessionPlan(snapshot);
  if (!validated) throw new AppError("internal", { message: "lesson training plan could not be read" });
  return validated;
}

function lessonTaskDto(session: typeof learningSessions.$inferSelect, task: { id: string; ordinal: number; exerciseType: LessonExerciseType; prompt: TaskPrompt }, assessedBefore: number): TaskDto {
  return {
    taskId: task.id,
    sessionId: session.id,
    ordinal: task.ordinal,
    exerciseType: task.exerciseType,
    direction: null,
    state: "issued",
    prompt: task.prompt,
    remainingAssessed: session.taskBudget - assessedBefore,
  };
}

/**
 * Wydaje kolejne zadanie lekcji pod blokadą sesji (wołane z `nextTask` w
 * `sessions.ts` po wspólnych krokach budżetu i limitu czasu). Dla już wydanego
 * zadania zwraca je idempotentnie; inaczej planuje, materializuje, zapisuje
 * zadanie i jego ekspozycje w tej transakcji i zwraca DTO. `null` kończy sesję.
 */
export async function issueNextLessonTask(
  services: Services,
  tx: Tx,
  session: typeof learningSessions.$inferSelect,
  now: Date,
  assessedRemaining: number,
  nextOrdinal: number,
): Promise<TaskDto | null> {
  const planned = await planLessonTask(services, tx, session, now, assessedRemaining);
  if (!planned) {
    return null;
  }
  const { plan, exercises, topic, subject, context, cardIndexByObjective } = planned;
  const taskId = randomUUID();

  let materialized: MaterializedLessonTask;
  if (plan.kind === "card") {
    const objective = topic.objectives.find((o) => o.id === plan.objectiveId)!;
    const cardIndex = plan.cardPurpose === "support" ? 0 : cardIndexByObjective.get(plan.objectiveId) ?? 0;
    const anchorRevision = exercises.find((e) => e.payload.objectiveId === plan.objectiveId) ?? exercises[0]!;
    const shownIndex = Math.min(cardIndex, objective.cards.length - 1);
    const cardAudio = subject.ttsForPrompts ? await loadLessonCardAudio(tx, session.deckVersionId) : new Map<string, string>();
    materialized = materializeCard(plan, shownIndex, objective, subject, context.examples[plan.objectiveId] ?? [], anchorRevision.revisionId,
      cardAudio.get(lessonCardAudioKey(objective.id, shownIndex)));
  } else {
    const exercise = exercises.find((e) => e.revisionId === plan.itemRevisionId)!;
    materialized = materializeExercise(plan, taskId, exercise, topic, subject, speechInputFor(services, session, subject, exercise.payload.exerciseType));
  }

  const counts = await lessonTaskCounts(tx, session.id);
  await tx.insert(sessionTasks).values({
    id: taskId,
    sessionId: session.id,
    childId: session.childId,
    deckVersionId: session.deckVersionId,
    itemRevisionId: materialized.itemRevisionId,
    ordinal: nextOrdinal,
    exerciseType: materialized.exerciseType,
    direction: null,
    state: "issued",
    publicPrompt: materialized.prompt as unknown as Record<string, unknown>,
    answerKey: materialized.answerKey,
    context: materialized.context,
    issuedAt: now,
  });
  const anchorItemId = exercises.find((e) => e.revisionId === materialized.itemRevisionId)!.itemId;
  await writeSealedEvent(tx, {
    childId: session.childId,
    taskId,
    itemId: anchorItemId,
    kind: "prompt_issued",
    stepId: `${taskId}:prompt`,
    occurredAt: now,
    exposures: materialized.exposures,
  });
  return lessonTaskDto(session, { id: taskId, ordinal: nextOrdinal, exerciseType: materialized.exerciseType, prompt: materialized.prompt }, counts.assessed);
}

/** Wydaje kolejny uprzednio przygotowany slot; legacy sessions używają selektora dynamicznego. */
export async function issueNextLessonPlanTask(
  tx: Tx,
  session: typeof learningSessions.$inferSelect,
  now: Date,
  nextOrdinal: number,
  /** Indeks slotu planu: wydane zadania planu, bez zadań następczych. */
  planIndex: number,
  assessedBefore: number,
): Promise<TaskDto | null> {
  let plan: LessonTrainingSessionPlanSnapshot | null;
  try { plan = readLessonTrainingSessionPlan(session.trainingPlan); }
  catch { throw new AppError("conflict", { message: "Ta sesja wymaga nowszej wersji aplikacji." }); }
  if (!plan) return null;
  const slot = plan.slots[planIndex];
  if (!slot || (slot.assessed && assessedBefore >= plan.taskBudget)) return null;
  await tx.insert(sessionTasks).values({
    id: slot.taskId, sessionId: session.id, childId: session.childId, deckVersionId: session.deckVersionId,
    itemRevisionId: slot.itemRevisionId, ordinal: nextOrdinal, exerciseType: slot.exerciseType,
    direction: null, state: "issued", publicPrompt: slot.prompt as unknown as Record<string, unknown>,
    answerKey: slot.answerKey, context: slot.context, issuedAt: now,
  });
  await writeSealedEvent(tx, {
    childId: session.childId, taskId: slot.taskId, itemId: slot.itemId, kind: "prompt_issued",
    stepId: `${slot.taskId}:prompt`, occurredAt: now, exposures: slot.revealsTargetKeys,
  });
  return lessonTaskDto(session, {
    id: slot.taskId, ordinal: nextOrdinal, exerciseType: slot.exerciseType as LessonExerciseType, prompt: slot.prompt,
  }, assessedBefore);
}

/**
 * Wartości listy zestawów dziecka dla lekcji (zadanie 13, `modules/kid.ts`):
 * `itemCount` = liczba celów lekcji; `independentlyRecalledCount` = liczba celów
 * `mastered`; `recommended` = selektor ma pracę (bez efektów ubocznych).
 */
export async function lessonDeckListValues(
  services: Services,
  exec: Executor,
  args: { childId: string; deckVersionId: string; testDate: string | null; timezone: string; now: Date },
): Promise<{ itemCount: number; independentlyRecalledCount: number; recommended: boolean }> {
  const version = (await exec.select().from(deckVersions).where(eq(deckVersions.id, args.deckVersionId)))[0]!;
  const context = lessonContextOf(version);
  const { topic } = requireTopic(services, context);
  // Lista zestawów liczy tylko postęp — nagrania pytań są zbędne.
  const exercises = await loadExercises(exec, args.deckVersionId, { questionAudio: false, feedbackAudio: false });
  const objectiveOrder = topic.objectives.map((o) => o.id).filter((id) => context.objectiveIds.includes(id));

  // Postęp celów: tylko cele z ćwiczeniami w puli liczą się do rekomendacji
  // (cel bez ćwiczeń selektor i tak pomija).
  const objectivesWithExercises = new Set(exercises.map((e) => e.payload.objectiveId));
  const progressRows = await exec
    .select({ objectiveId: childObjectiveProgress.objectiveId, status: childObjectiveProgress.status, nextReviewAt: childObjectiveProgress.nextReviewAt })
    .from(childObjectiveProgress)
    .where(and(eq(childObjectiveProgress.childId, args.childId), eq(childObjectiveProgress.subjectId, context.subjectId)));
  const statusByObjective = new Map<string, ProgressStatus>();
  const dueByObjective = new Map<string, string | null>();
  let masteredCount = 0;
  for (const row of progressRows) {
    const status = mapStatus(row.status);
    statusByObjective.set(row.objectiveId, status);
    dueByObjective.set(row.objectiveId, row.nextReviewAt?.toISOString() ?? null);
    if (status === "mastered" && objectiveOrder.includes(row.objectiveId)) masteredCount += 1;
  }

  // Rekomendacja (odpowiednik `hasScheduledWork` słówek): istnieje cel lekcji
  // nie `mastered` (nowy materiał lub w toku) ALBO należne sprawdzenie celu
  // opanowanego. Dodatkowe utrwalanie nie czyni zestawu rekomendowanym.
  const nowIso = args.now.toISOString();
  const recommended = objectiveOrder.some((id) => {
    if (!objectivesWithExercises.has(id)) return false;
    const status = statusByObjective.get(id);
    if (status === undefined || status === "not_assessed") return true; // nowy materiał
    if (status !== "mastered") return true; // w toku
    const due = dueByObjective.get(id);
    return due !== null && due !== undefined && due <= nowIso; // należne sprawdzenie
  });

  return { itemCount: objectiveOrder.length, independentlyRecalledCount: masteredCount, recommended };
}

/** Tytuł celu z przypiętego tematu (katalogowego albo dynamicznego). */
function objectiveTitle(topic: LessonTopic, subjectId: string, objectiveId: string): string {
  const objective = topic.objectives.find((o) => o.id === objectiveId);
  if (objective) return objective.titlePl;
  // Nigdy nie wpuszczamy surowego id celu do Kid DTO — brak tytułu to znak
  // uszkodzonej/niespójnej wersji lekcji, nie dane do pokazania dziecku.
  throw new AppError("internal", { message: `lesson objective title missing: ${subjectId}/${objectiveId}` });
}

/**
 * Podsumowanie sesji lekcji per cel (req 7.7): dla każdego celu ćwiczonego w
 * sesji — liczba wykonanych ocenianych ćwiczeń i liczba poprawnych. Bez procentów,
 * bez statusów technicznych, bez kategorii błędów. `skip` i `unevaluated` liczą się
 * do „practiced”? Nie: „practiced” to oceniane próby (correct+incorrect+dont_remember);
 * `unevaluated`/`skip` nie są dowodem pracy nad regułą.
 */
export async function buildLessonSummaryObjectives(
  services: Services,
  tx: Tx,
  sessionId: string,
): Promise<{ objectiveId: string; titlePl: string; practiced: number; correct: number }[]> {
  const rows = await tx
    .select({ details: assessments.details, outcome: assessments.outcome, reason: assessments.reason })
    .from(assessments)
    .innerJoin(attempts, eq(attempts.id, assessments.attemptId))
    .innerJoin(sessionTasks, eq(sessionTasks.id, attempts.taskId))
    .where(and(
      eq(sessionTasks.sessionId, sessionId), eq(assessments.skill, "objective"), eq(attempts.state, "completed"),
      // Poprawka („Skróć odpowiedź”) to druga próba tego samego pytania, nie osobne ćwiczenie celu.
      sql`${sessionTasks.context}->'followUpOf' is null`,
    ))
    .orderBy(asc(attempts.receivedAt));
  const version = (await tx.select({ lessonContext: deckVersions.lessonContext }).from(deckVersions)
    .innerJoin(learningSessions, eq(learningSessions.deckVersionId, deckVersions.id))
    .where(eq(learningSessions.id, sessionId)))[0];
  const subjectId = (version?.lessonContext as { subjectId?: string } | null)?.subjectId;
  if (!subjectId) {
    throw new AppError("internal", { message: `lesson session without subjectId: ${sessionId}` });
  }

  const { topic } = requireTopic(services, lessonContextOf(version!));
  const byObjective = new Map<string, { practiced: number; correct: number }>();
  for (const row of rows) {
    const objectiveId = (row.details as { objectiveId?: string } | null)?.objectiveId;
    if (!objectiveId) continue;
    if (row.outcome === "unassessed") continue; // nieocenione nie liczy się jako praca nad regułą
    const entry = byObjective.get(objectiveId) ?? { practiced: 0, correct: 0 };
    entry.practiced += 1;
    if (row.outcome === "correct") entry.correct += 1;
    byObjective.set(objectiveId, entry);
  }
  return [...byObjective].map(([objectiveId, counts]) => ({
    objectiveId,
    titlePl: objectiveTitle(topic, subjectId, objectiveId),
    practiced: counts.practiced,
    correct: counts.correct,
  }));
}
