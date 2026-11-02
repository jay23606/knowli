import { randomUUID } from "node:crypto";
import { messages, type FeedbackDto, type TaskPrompt } from "@learning/contracts";
import type { Services } from "../../../config";
import type { Tx } from "../../../db/client";
import { sessionTasks, type learningSessions } from "../../../db/schema";
import { buildAnswerSegments, type ObjectiveGrade } from "../../../domain/lessons/evaluate";
import type { SubjectModule } from "../../../domain/lessons/types";
import {
  compareRevision,
  isUnchangedRevision,
  matchedElementIdsOf,
  removableFragments,
  shouldOfferShorten,
  type SchoolAssessmentDetails,
} from "../../../domain/lessons/precision-trainer";
import { readLessonTrainingSessionPlan } from "../../../domain/training-session-plan";
import { writeSealedEvent } from "../events";
import { lessonSessionContextOf, lessonTaskCounts } from "./lesson-sessions";
import { speechInputFor } from "./lesson-materialize";
import { unissuedPlanSlots } from "./lesson-story-tasks";

/**
 * Trener precyzji — zadanie następcze „Skróć swoją odpowiedź” (design 6.3).
 * Technicznie to odpowiedź otwarta na tę samą rewizję ćwiczenia, z promptem
 * `lesson_shorten` i kluczem oryginału; poza planem i budżetem sesji.
 */

/** Powiązanie poprawki z oryginałem — w prywatnym kluczu zadania następczego. */
export interface RevisionOf {
  taskId: string;
  attemptId: string;
  originalAnswer: string;
  matchedElementIds: string[];
}

type TaskRow = typeof sessionTasks.$inferSelect;

/** Typy oceniane modelem (jak rezerwacja wywołań przy budowie planu). */
const GRADER_TYPES: ReadonlySet<string> = new Set(["lesson_error_fix", "lesson_transform", "lesson_open_answer"]);
type SessionRow = typeof learningSessions.$inferSelect;

interface GradeShape {
  grade: ObjectiveGrade;
  feedback: FeedbackDto;
  exposures: string[];
  details: Record<string, unknown>;
}

/** Czy zadanie jest zadaniem następczym (`context.followUpOf`). */
export function isFollowUpTask(task: Pick<TaskRow, "context">): boolean {
  return (task.context as { followUpOf?: unknown } | null)?.followUpOf !== undefined;
}

/** Poprawka identyczna z oryginałem: bez oceny i modelu, zadanie czeka na krótszą wersję. */
export function unchangedRevisionResult(revisionOf: RevisionOf | undefined, text: string, objectiveId: string): GradeShape | null {
  if (!revisionOf || !isUnchangedRevision(revisionOf.originalAnswer, text)) return null;
  return {
    // `no_match`, nie `unavailable`: ta odpowiedź nie eskaluje do modelu.
    grade: { outcome: "unevaluated", reason: "technical", verdict: "no_match" },
    feedback: { kind: "lesson_hint", hintPl: messages.kid.lessonShortenUnchanged },
    exposures: [],
    details: {
      objectiveId, verdict: "unchanged_revision",
      // Powiązanie z oryginałem: raporty pomijają poprawki, także te bez oceny.
      revisionOf: { taskId: revisionOf.taskId, attemptId: revisionOf.attemptId },
    },
  };
}

/**
 * Ocena poprawki względem oryginału: zapisuje powiązanie, utracone elementy
 * wymagane (N07) i skrócenie. Utrata elementu daje wynik niezaliczony
 * z podpowiedzią bez treści elementu; wiedza z modelu zostaje w szczegółach.
 */
export function withRevisionComparison<T extends GradeShape>(revisionOf: RevisionOf | undefined, childAnswer: string, result: T): T {
  if (!revisionOf || result.grade.outcome === "unevaluated") return result;
  const comparison = compareRevision({
    originalMatchedElementIds: revisionOf.matchedElementIds,
    originalAnswer: revisionOf.originalAnswer,
    revisionAnswer: childAnswer,
    revisionDetails: result.details as SchoolAssessmentDetails,
  });
  const details = {
    ...result.details,
    revisionOf: { taskId: revisionOf.taskId, attemptId: revisionOf.attemptId },
    lostElementIds: [...comparison.lostElementIds],
    shorter: comparison.shorter,
  };
  if (comparison.lostElementIds.length === 0) return { ...result, details };
  return {
    ...result,
    grade: { ...result.grade, outcome: "incorrect" },
    feedback: { kind: "lesson_hint", hintPl: messages.kid.lessonShortenLostElement },
    exposures: [],
    details,
  };
}

/**
 * Trener precyzji jest zawsze wspomagany: ani poprawka po informacji zwrotnej,
 * ani wybór pojęć kluczowych nie potwierdza samodzielnej pamięci (wym. 7.1, 7.3).
 */
export function precisionTrainerQualification<Q extends { independent: boolean; confirmationEligible: boolean }>(
  task: Pick<TaskRow, "context" | "exerciseType">,
  qualification: Q,
): Q {
  const supported = isFollowUpTask(task) || task.exerciseType === "lesson_keywords";
  return supported ? { ...qualification, independent: false, confirmationEligible: false } : qualification;
}

/**
 * Po poprawnej, rozwlekłej odpowiedzi otwartej szkoły tworzy zadanie następcze
 * w stanie `issued` (ta sama transakcja co ocena) i zwraca feedback zachęty.
 * Prompt to tekst dziecka z zaznaczonymi fragmentami — bez ekspozycji klucza.
 * `null`, gdy reguły trenera nie proponują skrócenia.
 */
function subjectOfTask(services: Services, task: TaskRow): { spokenAnswers?: SubjectModule["spokenAnswers"] } {
  const subjectId = (task.answerKey as { subjectId?: unknown } | null)?.subjectId;
  return (typeof subjectId === "string" ? services.subjects.getSubject(subjectId) : undefined) ?? {};
}

export async function offerShortenFollowUp(
  tx: Tx,
  services: Services,
  args: { task: TaskRow; session: SessionRow; itemId: string; attemptId: string; childAnswer: string; result: GradeShape; now: Date },
): Promise<FeedbackDto | null> {
  const { task, session, result } = args;
  const key = task.answerKey as { schoolCriteria?: unknown; exerciseType?: string } | null;
  if (!key?.schoolCriteria || task.exerciseType !== "lesson_open_answer" || result.feedback.kind !== "great") return null;
  const counts = await lessonTaskCounts(tx, session.id);
  // Wywołania gradera zarezerwowane przez plan dla jeszcze niewydanych zadań
  // ocenianych modelem: poprawka nie może ich zabrać (np. należnemu sprawdzeniu).
  let reservedForPlan = 0;
  try {
    const plan = readLessonTrainingSessionPlan(session.trainingPlan);
    // Tylko niewydane sloty spoza historyjki: indeks `counts.planned` obejmuje też
    // wydane zadania historyjki, więc liczymy z `unissuedPlanSlots` (ruling 1).
    reservedForPlan = plan ? unissuedPlanSlots(plan, counts).regular.filter((slot) => GRADER_TYPES.has(slot.exerciseType)).length : 0;
  } catch {
    reservedForPlan = 0;
  }
  const graderCallsLeft = services.grader
    ? services.grader.maxCallsPerSession - lessonSessionContextOf(session).graderCalls - reservedForPlan
    : 0;
  const details = result.details as SchoolAssessmentDetails;
  if (!shouldOfferShorten({
    trainingSession: session.mode === "training",
    followUp: isFollowUpTask(task),
    details,
    graderCallsLeft,
    // `counts.assessed` obejmuje już to zadanie, więc dodajemy je z powrotem.
    remainingWithThisTask: session.taskBudget - counts.assessed + 1,
  })) return null;

  const publicPrompt = task.publicPrompt as { prompt?: unknown } | null;
  const question = typeof publicPrompt?.prompt === "string" ? publicPrompt.prompt : "";
  const fragments = removableFragments(details);
  const segments = (fragments.length > 0 ? buildAnswerSegments(args.childAnswer, fragments.redundant, fragments.offTopic) : null)
    ?? [{ text: args.childAnswer, state: "plain" as const }];
  const prompt: TaskPrompt = {
    kind: "lesson_shorten",
    instructionPl: messages.kid.lessonShortenInstruction,
    prompt: question,
    originalAnswer: args.childAnswer,
    answerSegments: segments.slice(0, 32).map((segment) => ({ text: segment.text, state: segment.state })),
    // Poprawkę też można podyktować (design szkoły §5.9 pkt 5).
    ...speechInputFor(services, session, subjectOfTask(services, task), "lesson_open_answer"),
  };
  const revisionOf: RevisionOf = {
    taskId: task.id,
    attemptId: args.attemptId,
    originalAnswer: args.childAnswer,
    matchedElementIds: matchedElementIdsOf(details),
  };
  const followUpId = randomUUID();
  await tx.insert(sessionTasks).values({
    id: followUpId,
    sessionId: session.id,
    childId: task.childId,
    deckVersionId: task.deckVersionId,
    itemRevisionId: task.itemRevisionId,
    ordinal: counts.total,
    exerciseType: "lesson_open_answer",
    direction: null,
    state: "issued",
    publicPrompt: prompt as unknown as Record<string, unknown>,
    answerKey: { ...(task.answerKey as Record<string, unknown>), revisionOf },
    context: { ...(task.context as Record<string, unknown>), reason: "precision_shorten", independentCheck: false, followUpOf: { taskId: task.id, attemptId: args.attemptId } },
    issuedAt: args.now,
  });
  // Prompt pokazuje wyłącznie tekst dziecka: zdarzenie wydania bez ekspozycji.
  await writeSealedEvent(tx, {
    childId: task.childId, taskId: followUpId, itemId: args.itemId, kind: "prompt_issued",
    stepId: `${followUpId}:prompt`, occurredAt: args.now, exposures: [],
  });
  // Treść nie na temat ma własną podpowiedź; same zbędne informacje — „krócej” (design §9.2).
  return {
    kind: "lesson_precision_hint",
    hintPl: fragments.offTopic.length > 0 ? messages.kid.lessonPrecisionHintOffTopic : messages.kid.lessonPrecisionHint,
  };
}
