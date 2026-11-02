import { randomUUID } from "node:crypto";
import { and, asc, eq, or } from "drizzle-orm";
import {
  AttemptInputSchema,
  messages,
  type CalculationSpec,
  type AttemptDto,
  type AttemptInput,
  type FeedbackDto,
} from "@learning/contracts";
import type { Services } from "../../../config";
import type { Tx } from "../../../db/client";
import {
  assessments,
  attempts,
  childObjectiveProgress,
  deckVersions,
  eventExposures,
  itemRevisions,
  itemRevisionSkills,
  learningEvents,
  learningSessions,
  lessonVerdicts,
  sessionTasks,
} from "../../../db/schema";
import { computeCalculationAnswer, evaluateCalculationAnswer } from "../../../domain/lessons/calculation";
import { AppError } from "../../../errors";
import type { AssistanceKind, Policy, SkillOutcome } from "../../../domain/types";
import {
  buildAnswerSegments,
  closestApprovedVariant,
  evaluateChoice as evaluateLessonChoice,
  assignmentText,
  evaluateAssignment,
  evaluateKeywordSelection,
  evaluateSequence,
  countSentences,
  gradeFromMatch,
  gradeFromSchoolVerdict,
  gradeFromVerdict,
  matchLessonAnswer,
  validateSchoolVerdict,
  validateVerdict,
  type GraderVerdict,
  type SchoolVerdict,
  type LessonAnswerKey,
  type ObjectiveGrade,
} from "../../../domain/lessons/evaluate";
import type { GraderInput } from "../../../ports/ai";
import type { LearningObjective, LessonTopic, SubjectModule } from "../../../domain/lessons/types";
import { BASE_ERROR_CATEGORIES } from "../../../domain/lessons/base-error-categories";
import {
  projectObjectiveProgress,
  lastIndependentObjectiveAt,
  qualifyLessonAttempt,
  type LessonQualificationContext,
  type ObjectiveHistoryEntry,
} from "../../../domain/lessons/progress";
import { loadPolicy } from "../../../policies/registry";
import { lockTaskWithSession, sealPostAnswerAudio } from "../events";
import { discloseFeedbackEvent, requestHashOf } from "../attempt-shared";
import { lessonSessionContextOf, type LessonSessionContext } from "./lesson-sessions";
import { dictationFingerprint, dictationStateOf } from "./lesson-dictation";
import { resolveInputMethod } from "../../../domain/lessons/dictation";
import {
  offerShortenFollowUp,
  precisionTrainerQualification,
  unchangedRevisionResult,
  withRevisionComparison,
  type RevisionOf,
} from "./lesson-shorten";

/**
 * Przyjęcie i ocena odpowiedzi w lekcji (design „Przyjęcie odpowiedzi” kroki 1–2,
 * „Ocena”, „Kwalifikacja i projekcja celów”). `attempts.ts` deleguje tu zadania
 * `lesson_*`. Współdzieli mechanikę słówek przez `attempt-shared`: hasz treści dla
 * idempotencji i zapieczętowany `feedback_issued` z ekspozycją przed odpowiedzią HTTP.
 *
 * Zakres zadania 13B: ocena DETERMINISTYCZNA (dopasowanie + typy zamknięte + sekwencja).
 * Model oceniający i cache werdyktów to zadanie 15: brak dopasowania bez modelu →
 * `unevaluated` (technical, `verdict='unavailable'`), zadanie zostaje `issued`
 * (ruling progress.md 114, req 6.8). Jedna oceniona odpowiedź kończy zadanie
 * (`answered`); po błędzie cykl wsparcia prowadzi selektor (ruling 113, zadanie 13).
 */

/** Leniwa finalizacja przeterminowanej próby lekcji (jak słówka, arch §9.2a). */
export const LESSON_ATTEMPT_PROCESSING_TIMEOUT_MS = 60_000;

type TaskRow = typeof sessionTasks.$inferSelect;
type SessionRow = typeof learningSessions.$inferSelect;
type AttemptRow = typeof attempts.$inferSelect;
type LessonModality = "choice" | "text" | "dont_remember" | "skip" | "sequence" | "selection" | "assignment";

/** Prywatny `answer_key` zadania lekcji (materializowany w `lesson-sessions.ts`). */
interface LessonTaskAnswerKey extends LessonAnswerKey {
  calculation?: CalculationSpec;
  objectiveId: string;
  subjectId: string;
  targetKey: string;
  independentCheck?: boolean;
  reason?: string;
  /** Zamrożone przy wydaniu zadania nagranie pełnego zdania (feedback po odpowiedzi); tylko trening. */
  feedbackAudioAssetId?: string;
  /** `lesson_listen_choice`: klucz ekspozycji pełnego zdania z nagrania (spec #198 §3.4). */
  sentenceTargetKey?: string;
  optionValues?: Record<string, string>;
  itemValues?: Record<string, string>;
  segmentValues?: Record<string, string>;
  /** `lesson_cloze`: tekst z poprawnymi słowami w lukach (feedback, omówienie). */
  filledText?: string;
  /** Zadanie następcze „Skróć odpowiedź”: oryginał, do którego należy poprawka. */
  revisionOf?: RevisionOf;
  /** Kryteria v3 odpowiedzi otwartej szkoły (z payloadu rewizji; prywatne). */
  schoolCriteria?: {
    requiredElements: { id: string; text: string }[];
    supplementaryElements: string[];
    commonErrors?: string[];
    expectedForm?: string;
    sourceQuotes: string[];
  };
  objectiveSnapshot?: {
    objectiveTitlePl?: string;
    topicId?: string;
    topicVersion?: number;
    descriptionEn: string;
    errorCategories: string[];
    hints: Record<string, string>;
    topicTitlePl: string;
    extraErrorCategories: { code: string; labelPl: string }[];
  };
}

/** Zamrożony przy received_at kontekst kwalifikacji próby lekcji (arch §9.2). */
interface FrozenLessonContext {
  receivedAt: string;
  policyVersion: string;
  firstTry: boolean;
  assistance: AssistanceKind[];
  answerPreviouslyExposed: boolean;
  previousSessionContactAt: string | null;
  timezone: string;
}

function keyOf(task: TaskRow): LessonTaskAnswerKey {
  return task.answerKey as unknown as LessonTaskAnswerKey;
}

/** Odwrotność `mapObjectiveStatus`: status domeny → słownik bazy (ruling 97). */
function toDbObjectiveStatus(status: string): string {
  switch (status) {
    case "not_assessed":
      return "unseen";
    case "learning":
      return "practicing";
    default:
      return status; // needs_confirmation / needs_reconfirmation / mastered bez zmian
  }
}

/** Czy przedmiot ma normalizator (zawsze, gdy przedmiot istnieje w rejestrze). */
function normalizerFor(services: Services, subjectId: string) {
  const subject = services.subjects.getSubject(subjectId);
  if (!subject) {
    throw new AppError("internal", { message: `lesson subject missing: ${subjectId}` });
  }
  return subject.normalizer;
}

/** Ujawnienie `target_key` ćwiczenia dziecku PRZED wydaniem tego zadania (req 7.2). */
async function answerPreviouslyExposed(tx: Tx, childId: string, targetKey: string, task: TaskRow): Promise<boolean> {
  const rows = await tx
    .select({ eventId: eventExposures.eventId, taskId: learningEvents.taskId })
    .from(eventExposures)
    .innerJoin(learningEvents, eq(learningEvents.id, eventExposures.eventId))
    .where(and(eq(eventExposures.childId, childId), eq(eventExposures.targetKey, targetKey), eq(learningEvents.sealed, true)));
  // Ekspozycje zapisane przy wydaniu TEGO zadania (prompt/feedback tego taskId)
  // się nie liczą — tylko wcześniejsze, z dowolnej sesji/lekcji/kartkówki.
  return rows.some((row) => row.taskId !== task.id);
}

/** Wsparcie użyte w zadaniu przed odpowiedzią (guided options / odsłuch / podpowiedź). */
async function assistanceFor(
  tx: Tx,
  task: TaskRow,
  key: LessonTaskAnswerKey,
  receivedAt: Date,
): Promise<{ assistance: AssistanceKind[]; feedbackCount: number }> {
  const assistance = new Set<AssistanceKind>();
  // Typy prowadzone ujawniają rozwiązanie w prompt'cie: wybór z opcji
  // (choice/short_answer), zaznaczenie w segmencie (notice) oraz ułożenie
  // podanych klocków (order) — dziecko dostaje gotowe elementy, więc pierwsze
  // poprawne ułożenie jest wspomagane, nie niezależne (req 7.2, design etapów).
  if (
    key.exerciseType === "lesson_choice" ||
    key.exerciseType === "lesson_listen_choice" ||
    key.exerciseType === "lesson_short_answer" ||
    key.exerciseType === "lesson_notice" ||
    key.exerciseType === "lesson_order" ||
    key.exerciseType === "lesson_match" ||
    key.exerciseType === "lesson_group" ||
    key.exerciseType === "lesson_cloze"
  ) {
    assistance.add("options");
  }
  const disclosures = await tx
    .select({ kind: learningEvents.kind, occurredAt: learningEvents.occurredAt })
    .from(learningEvents)
    .where(and(eq(learningEvents.taskId, task.id), eq(learningEvents.sealed, true)));
  let feedbackCount = 0;
  for (const row of disclosures) {
    if (row.kind === "feedback_issued") feedbackCount += 1;
    if (row.occurredAt > receivedAt) continue;
    if (row.kind === "hint_issued") assistance.add("hint");
    if (row.kind === "audio_issued") assistance.add("model_audio");
  }
  return { assistance: [...assistance], feedbackCount };
}

/**
 * Kanoniczny tekst rozwiązania własnego zadania pokazywany dziecku (design
 * feedback). Nagranie zdania (`feedback_audio`) czyta to samo rozwiązanie.
 */
function correctTextFor(key: LessonTaskAnswerKey): string {
  if (key.exerciseType === "lesson_choice" || key.exerciseType === "lesson_listen_choice" || key.exerciseType === "lesson_short_answer") {
    return key.optionValues?.[key.correctOptionId ?? ""] ?? key.answer;
  }
  if (key.exerciseType === "lesson_notice") {
    return key.segmentValues?.[key.correctOptionId ?? ""] ?? key.answer;
  }
  if (key.exerciseType === "lesson_cloze") {
    return key.filledText || key.answer;
  }
  if (key.exerciseType === "lesson_match" || key.exerciseType === "lesson_group") {
    const text = assignmentText(key.assignments ?? [], key.itemValues ?? {}, {
      grouped: key.exerciseType === "lesson_group",
      ...(key.targetIds ? { targetOrder: key.targetIds } : {}),
      ...(key.itemIds ? { itemOrder: key.itemIds } : {}),
    });
    return text || key.answer;
  }
  if (key.exerciseType === "lesson_order") {
    const ids = key.itemIds ?? [];
    const values = key.itemValues ?? {};
    const text = ids.map((id) => values[id]).filter((t): t is string => Boolean(t)).join(" ");
    return text || key.answer;
  }
  return key.answer;
}

interface LessonGradeResult {
  grade: ObjectiveGrade;
  feedback: FeedbackDto;
  /** Ekspozycje feedbacku (klucze celów pokazane dziecku); puste dla not_assessed. */
  exposures: string[];
  /** `details` zapisywane w assessments. */
  details: Record<string, unknown>;
}

/**
 * „Posłuchaj i wybierz” bez odsłuchu (spec #198 §3.1): odpowiedź, przed której
 * `receivedAt` nie zapieczętowano `audio_issued` w tym zadaniu (brak `model_audio`
 * w zamrożonym wsparciu), jest nieoceniona — bez kary, wsparcia i historii
 * trudności; zadanie zostaje `issued`. „Pomiń” zostaje zwykłą ścieżką (`skipped`).
 * Werdykt `no_stimulus` jest wewnętrzny (szczegóły oceny), poza kontraktami.
 */
function noStimulusGrade(key: LessonTaskAnswerKey, assistance: readonly AssistanceKind[], modality: LessonModality): LessonGradeResult | null {
  if (key.exerciseType !== "lesson_listen_choice" || modality === "skip" || assistance.includes("model_audio")) return null;
  return {
    grade: { outcome: "unevaluated", verdict: "unavailable" },
    feedback: { kind: "not_assessed" },
    exposures: [],
    details: { objectiveId: key.objectiveId, verdict: "no_stimulus" },
  };
}

/**
 * Ocena deterministyczna odpowiedzi + feedback + ekspozycje (design „Ocena”,
 * tabela mapowania). `no_match` bez modelu → unevaluated/unavailable → not_assessed.
 */
function gradeLessonAnswer(
  input: Extract<AttemptInput, { modality: LessonModality }>,
  task: TaskRow,
  key: LessonTaskAnswerKey,
  services: Services,
  skipFormCheck = false,
): LessonGradeResult {
  const objectiveId = key.objectiveId;
  const correctText = correctTextFor(key);

  // „Pomiń” → próba bez ocen (jak słówka): nie ma ObjectiveGrade.
  if (input.modality === "skip") {
    return { grade: { outcome: "unevaluated", verdict: "unavailable" }, feedback: { kind: "not_assessed" }, exposures: [], details: { objectiveId, verdict: "skipped" } };
  }

  if (input.modality === "dont_remember") {
    if (key.exerciseType === "lesson_calculation") {
      try {
        if (!key.calculation) throw new Error("missing calculation");
        computeCalculationAnswer(key.calculation);
      } catch {
        throw new AppError("internal", { message: "invalid private calculation payload" });
      }
    }
    return {
      grade: { outcome: "incorrect", reason: "dont_remember", verdict: "closed_incorrect" },
      feedback: { kind: "incorrect", correctText },
      exposures: [key.targetKey],
      details: { objectiveId, verdict: "dont_remember" },
    };
  }

  if (input.modality === "choice") {
    const correct = evaluateLessonChoice(input.optionId, key);
    if (correct) {
      return { grade: { outcome: "correct", verdict: "closed_correct" }, feedback: { kind: "great" }, exposures: [key.targetKey], details: { objectiveId, verdict: "closed_correct" } };
    }
    return { grade: { outcome: "incorrect", verdict: "closed_incorrect" }, feedback: { kind: "incorrect", correctText }, exposures: [key.targetKey], details: { objectiveId, verdict: "closed_incorrect" } };
  }

  if (input.modality === "selection") {
    // Słowa kluczowe: wybór pojęć oceniany po identyfikatorach, bez modelu.
    // Identyfikatory spoza opcji tego zadania to błąd transportu, nie odpowiedź.
    const known = input.itemIds.every((id) => key.optionValues?.[id] !== undefined);
    const correct = known ? evaluateKeywordSelection(input.itemIds, key) : null;
    if (correct === null) {
      return { grade: { outcome: "unevaluated", reason: "technical", verdict: "unavailable" }, feedback: { kind: "not_assessed" }, exposures: [], details: { objectiveId, verdict: "unavailable" } };
    }
    if (correct) {
      return { grade: { outcome: "correct", verdict: "closed_correct" }, feedback: { kind: "great" }, exposures: [key.targetKey], details: { objectiveId, verdict: "closed_correct" } };
    }
    return { grade: { outcome: "incorrect", verdict: "closed_incorrect" }, feedback: { kind: "incorrect", correctText }, exposures: [key.targetKey], details: { objectiveId, verdict: "closed_incorrect" } };
  }

  if (input.modality === "assignment") {
    // Kształt sprawdzony przy przyjęciu próby (null → 400), tu tylko wynik.
    const correct = evaluateAssignment(input.assignments, key) === true;
    if (correct) {
      return { grade: { outcome: "correct", verdict: "closed_correct" }, feedback: { kind: "great" }, exposures: [key.targetKey], details: { objectiveId, verdict: "closed_correct" } };
    }
    return { grade: { outcome: "incorrect", verdict: "closed_incorrect" }, feedback: { kind: "incorrect", correctText }, exposures: [key.targetKey], details: { objectiveId, verdict: "closed_incorrect" } };
  }

  if (input.modality === "sequence") {
    const correct = evaluateSequence(input.itemIds, key);
    if (correct) {
      return { grade: { outcome: "correct", verdict: "closed_correct" }, feedback: { kind: "great" }, exposures: [key.targetKey], details: { objectiveId, verdict: "closed_correct" } };
    }
    return { grade: { outcome: "incorrect", verdict: "closed_incorrect" }, feedback: { kind: "incorrect", correctText }, exposures: [key.targetKey], details: { objectiveId, verdict: "closed_incorrect" } };
  }

  // Poprawka identyczna z oryginałem: bez oceny i modelu (trener precyzji).
  const unchanged = unchangedRevisionResult(key.revisionOf, input.text, objectiveId);
  if (unchanged) return unchanged;

  if (key.exerciseType === "lesson_calculation") {
    let outcome: "correct" | "incorrect" | "unevaluated";
    try {
      if (!key.calculation) throw new Error("missing calculation");
      outcome = evaluateCalculationAnswer(input.text, key.calculation);
    } catch {
      throw new AppError("internal", { message: "invalid private calculation payload" });
    }
    if (outcome === "unevaluated") {
      return { grade: { outcome, reason: "technical", verdict: "unavailable" }, feedback: { kind: "not_assessed" }, exposures: [], details: { objectiveId, verdict: "unavailable" } };
    }
    const verdict = outcome === "correct" ? "closed_correct" : "closed_incorrect";
    // Błędny wynik: podpowiedź metody bez wyniku, więc bez ekspozycji odpowiedzi.
    return outcome === "correct"
      ? { grade: { outcome, verdict }, feedback: { kind: "great" }, exposures: [key.targetKey], details: { objectiveId, verdict } }
      : { grade: { outcome, verdict }, feedback: { kind: "lesson_hint", hintPl: messages.kid.lessonCalculationHints[key.calculation!.kind] }, exposures: [], details: { objectiveId, verdict } };
  }

  // text: luka / error_fix / transform / open_answer → dopasowanie deterministyczne
  const normalizer = normalizerFor(services, key.subjectId);
  const match = matchLessonAnswer(input.text, key, normalizer);
  const grade = gradeFromMatch(match);
  if (grade === null) {
    // brak dopasowania, brak modelu w tym zadaniu → nieocenione (technical)
    return {
      grade: { outcome: "unevaluated", reason: "technical", verdict: "unavailable" },
      feedback: { kind: "not_assessed" },
      exposures: [],
      details: { objectiveId, verdict: "unavailable" },
    };
  }
  if (match.kind === "minor_typo") {
    const variant = closestApprovedVariant(input.text, key, normalizer);
    const segments = buildAnswerSegments(input.text, [match.typoToken]);
    const feedback: FeedbackDto = {
      kind: "lesson_almost",
      correctText: variant,
      ...(segments ? { answerSegments: segments } : {}),
    };
    return {
      grade, feedback, exposures: [key.targetKey],
      details: { objectiveId, verdict: "minor_typo", typoToken: match.typoToken, ...matchedSchoolDetails(key, input.text, skipFormCheck) },
    };
  }
  // exact — dla szkoły dokładne dopasowanie jest poprawną odpowiedzią (bez modelu).
  return {
    grade,
    feedback: { kind: "great" },
    exposures: [key.targetKey],
    details: { objectiveId, verdict: "exact", ...matchedSchoolDetails(key, input.text, skipFormCheck) },
  };
}

/**
 * Wymiar szkolny odpowiedzi dopasowanej do zatwierdzonego wariantu (dokładnie
 * albo z drobną literówką): wiedza poprawna, wszystkie elementy trafione;
 * forma `one_sentence` ogranicza precyzję, nigdy wiedzę. Bez kryteriów szkoły → `{}`.
 */
function matchedSchoolDetails(key: LessonTaskAnswerKey, childAnswer: string, skipFormCheck: boolean): Record<string, unknown> {
  if (!key.schoolCriteria) return {};
  const formOk = formOkFor(key, childAnswer, skipFormCheck);
  return {
    knowledge: "correct",
    precision: formOk === false ? "verbose" : "concise",
    matchedElementIds: key.schoolCriteria.requiredElements.map((el) => el.id),
    missingElementIds: [] as string[],
    ...(formOk === false ? { formOk: false } : {}),
    ...(key.schoolCriteria.expectedForm ? { expectedForm: key.schoolCriteria.expectedForm } : {}),
  };
}

// ───────────────────────────── model oceniający (zadanie 15) ─────────────────────────────

/** Cel + temat przedmiotu dla danego ćwiczenia (opis, kategorie, podpowiedzi). */
function resolveObjective(services: Services, key: LessonTaskAnswerKey): { subject: SubjectModule; topic: LessonTopic; objective: LearningObjective } {
  const subject = services.subjects.getSubject(key.subjectId);
  if (!subject) {
    throw new AppError("internal", { message: `lesson subject missing: ${key.subjectId}` });
  }
  if (key.objectiveSnapshot) {
    const snap = key.objectiveSnapshot;
    const objective: LearningObjective = {
      id: key.objectiveId,
      titlePl: snap.objectiveTitlePl ?? snap.topicTitlePl,
      descriptionEn: snap.descriptionEn,
      cards: [],
      errorCategories: [...snap.errorCategories],
      hints: { ...snap.hints },
      exerciseTypes: [],
    };
    // Tytuł TEMATU (nie celu): grader dostaje go jako „Topic”, tak jak przed
    // migawką — inaczej ten sam promptVersion mieszałby w cache dwa warianty promptu.
    const topic: LessonTopic = {
      id: snap.topicId ?? "dynamic",
      version: snap.topicVersion ?? 1,
      titlePl: snap.topicTitlePl,
      extraErrorCategories: snap.extraErrorCategories.map((c) => ({ ...c })),
      transforms: [],
      objectives: [objective],
    };
    return { subject, topic, objective };
  }
  for (const topic of subject.topics) {
    const objective = topic.objectives.find((o) => o.id === key.objectiveId);
    if (objective) return { subject, topic, objective };
  }
  throw new AppError("internal", { message: `lesson objective missing: ${key.subjectId}/${key.objectiveId}` });
}

/** Etykiety kategorii dla celu: bazowe ∪ przedmiotu ∪ tematu, po kodzie. */
function categoryLabels(subject: SubjectModule, topic: LessonTopic): Map<string, string> {
  const labels = new Map<string, string>();
  for (const category of BASE_ERROR_CATEGORIES) labels.set(category.code, category.labelPl);
  for (const category of subject.errorCategories) labels.set(category.code, category.labelPl);
  for (const category of topic.extraErrorCategories) labels.set(category.code, category.labelPl);
  return labels;
}

/**
 * Deterministyczny klucz cache z odpowiedzi dziecka: pierwszy wariant sekwencji
 * z normalizatora przedmiotu, tokeny złączone spacją. Ten sam materiał (ta sama
 * znormalizowana odpowiedź) trafia w ten sam wiersz niezależnie od wielkości
 * liter czy interpunkcji — co jest sensem wspólnego cache werdyktów.
 */
function normalizedAnswerKey(services: Services, key: LessonTaskAnswerKey, text: string): string {
  const normalizer = normalizerFor(services, key.subjectId);
  const sequences = normalizer.normalize(text).filter((seq) => seq.length > 0);
  const first = sequences[0];
  return first ? first.join(" ") : text.trim().toLowerCase();
}

/** Buduje wejście modelu z profilu przedmiotu i ćwiczenia (odpowiedź jako dane). */
function buildGraderInput(
  services: Services,
  task: TaskRow,
  key: LessonTaskAnswerKey,
  childAnswer: string,
): GraderInput {
  const { subject, topic, objective } = resolveObjective(services, key);
  const labels = categoryLabels(subject, topic);
  const prompt = task.publicPrompt as { instructionPl?: string; stem?: string; statement?: string; prompt?: string; stemWithGap?: string } | null;
  const instruction = prompt?.instructionPl ?? "";
  const stimulus = prompt?.stem ?? prompt?.stemWithGap ?? prompt?.statement ?? prompt?.prompt ?? null;
  const school = key.schoolCriteria
    ? {
        question: stimulus ?? instruction,
        modelAnswer: key.answer,
        requiredElements: key.schoolCriteria.requiredElements.map((el) => ({ ...el })),
        supplementaryElements: [...key.schoolCriteria.supplementaryElements],
        commonErrors: [...(key.schoolCriteria.commonErrors ?? [])],
        expectedForm: key.schoolCriteria.expectedForm ?? "explanation",
        sourceQuotes: [...key.schoolCriteria.sourceQuotes],
      }
    : undefined;
  return {
    subjectTitle: subject.titlePl,
    topicTitle: topic.titlePl,
    roleProfile: { gradingRole: subject.prompts.gradingRole, almostDefinition: subject.prompts.almostDefinition },
    instruction,
    stimulus,
    objective: {
      description: objective.descriptionEn,
      errorCategories: objective.errorCategories.map((code) => ({ code, label: labels.get(code) ?? code })),
    },
    acceptedAnswers: [key.answer, ...key.acceptedAnswers],
    // Limit ścieżki szkolnej 600 znaków (odpowiedzi otwarte), lekcje bez zmian 200.
    childAnswer: childAnswer.slice(0, school ? 600 : 200),
    ...(school ? { school } : {}),
  };
}

/** Kategorie dozwolone w werdykcie dla tego celu (do `validateVerdict`). */
function allowedCategoriesFor(services: Services, key: LessonTaskAnswerKey): readonly string[] {
  const { objective } = resolveObjective(services, key);
  return objective.errorCategories;
}

/** Szablon podpowiedzi kategorii celu (po polsku); null, gdy kategoria nieznana. */
function hintTemplateFor(services: Services, key: LessonTaskAnswerKey, errorCategory: string): string | null {
  const { objective } = resolveObjective(services, key);
  return objective.hints[errorCategory] ?? null;
}

/**
 * Buduje `LessonGradeResult` z werdyktu (lub jego braku) wg tabeli mapowania
 * (design „Ocena”). `model_correct` → great; `model_almost` → lesson_almost z
 * fragmentami; `model_incorrect` → lesson_hint z fragmentami + hintPl kategorii;
 * `model_other` → incorrect z correctText bez podpowiedzi celu; brak werdyktu →
 * not_assessed. Komentarz `note` modelu NIGDY nie wchodzi do Kid DTO.
 */
function resultFromVerdict(
  services: Services,
  task: TaskRow,
  key: LessonTaskAnswerKey,
  childAnswer: string,
  verdict: GraderVerdict | null,
  verdictId: string | null,
  authoritativeIncorrect = false,
): LessonGradeResult {
  const objectiveId = key.objectiveId;
  const grade: ObjectiveGrade = authoritativeIncorrect
    ? { outcome: "incorrect", verdict: "model_incorrect", ...(verdict?.errorCategory && verdict.errorCategory !== "other" ? { errorCategory: verdict.errorCategory } : {}) }
    : gradeFromVerdict(verdict);
  const normalizer = normalizerFor(services, key.subjectId);
  const correctText = closestApprovedVariant(childAnswer, key, normalizer);

  if (grade.verdict === "unavailable") {
    return { grade, feedback: { kind: "not_assessed" }, exposures: [], details: { objectiveId, verdict: "unavailable" } };
  }

  const fragments = verdict?.fragments ?? [];
  const segments = fragments.length > 0 ? buildAnswerSegments(childAnswer, [...fragments]) : null;
  const detailsBase: Record<string, unknown> = {
    objectiveId,
    verdict: grade.verdict,
    ...(verdictId ? { verdictId } : {}),
    ...(fragments.length > 0 ? { fragments: [...fragments] } : {}),
  };

  switch (grade.verdict) {
    case "model_correct":
      return { grade, feedback: { kind: "great" }, exposures: [key.targetKey], details: detailsBase };
    case "model_almost":
      return {
        grade,
        feedback: { kind: "lesson_almost", correctText, ...(segments ? { answerSegments: segments } : {}) },
        exposures: [key.targetKey],
        details: detailsBase,
      };
    case "model_incorrect": {
      const hintPl = grade.errorCategory ? hintTemplateFor(services, key, grade.errorCategory) : null;
      return {
        grade,
        feedback: {
          kind: "lesson_hint",
          correctText,
          ...(hintPl ? { hintPl } : {}),
          ...(segments ? { answerSegments: segments } : {}),
        },
        exposures: [key.targetKey],
        details: { ...detailsBase, ...(grade.errorCategory ? { errorCategory: grade.errorCategory } : {}) },
      };
    }
    case "model_other":
      // błąd poza celem: pokaż poprawną odpowiedź, bez podpowiedzi celu; nieoceniane
      return { grade, feedback: { kind: "incorrect", correctText }, exposures: [key.targetKey], details: detailsBase };
    default:
      return { grade, feedback: { kind: "not_assessed" }, exposures: [], details: detailsBase };
  }
}

/**
 * Czy forma zdaniowa odpowiedzi spełnia oczekiwanie (`one_sentence`); null = bez
 * znaczenia. Niepoprawiony tekst z dyktowania pomija liczenie: STT stawia kropki
 * w miejscach pauz, więc liczba zdań mierzyłaby namysł, nie formę (design §5.6).
 */
function formOkFor(key: LessonTaskAnswerKey, childAnswer: string, skipFormCheck = false): boolean | null {
  if (skipFormCheck || key.schoolCriteria?.expectedForm !== "one_sentence") return null;
  return countSentences(childAnswer) <= 1;
}

/** Wiersz cache → werdykt szkolny; decyzja rodzica nadpisuje wiedzę jak w v1. */
function schoolVerdictFromCacheRow(row: LessonVerdictRow, key: LessonTaskAnswerKey, childAnswer: string): SchoolVerdict | null {
  if (row.precision === null) return null;
  const knowledge: SchoolVerdict["knowledge"] =
    row.verdict === "correct" ? "correct" : row.verdict === "almost" ? "partial" : "incorrect";
  const base: SchoolVerdict = {
    knowledge,
    // Cache trzyma precyzję modelu bez klamry formy; klamrę dla BIEŻĄCEGO zapisu
    // odpowiedzi nakłada dopiero resultFromSchoolVerdict.
    precision: row.precision as SchoolVerdict["precision"],
    matchedElementIds: [...(row.matchedElements ?? [])],
    missingElementIds: [...(row.missingElements ?? [])],
    incorrectStatements: [...(row.incorrectStatements ?? [])],
    redundantFragments: [...(row.redundantFragments ?? [])],
    offTopicFragments: [...(row.offTopicFragments ?? [])],
    confusedConcepts: (row.confusedConcepts ?? []).map((pair) => ({ said: pair.said, meant: pair.meant })),
    note: row.note ?? "",
  };
  if (row.parentDecision === "overridden_correct") {
    // decyzja rodzica „poprawne” znosi błąd treści, więc i pomylenie pojęć
    return {
      ...base,
      knowledge: "correct",
      matchedElementIds: (key.schoolCriteria?.requiredElements ?? []).map((el) => el.id),
      missingElementIds: [],
      incorrectStatements: [],
      confusedConcepts: [],
    };
  }
  if (row.parentDecision === "overridden_incorrect") {
    return { ...base, knowledge: "incorrect" };
  }
  return base;
}

/**
 * Wynik próby z werdyktu szkolnego: wiedza → ocena celu (`gradeFromSchoolVerdict`),
 * precyzja wyłącznie do `details` oceny (raport rodzica) — nigdy do oceny.
 * Feedback (wym. 5.7): correct → great; partial/incorrect → lesson_hint
 * z szablonów (co było dobre → jeden brak → zachęta) BEZ odpowiedzi wzorcowej
 * i bez ekspozycji — nic nie jest ujawniane; ujawnienie następuje dopiero
 * w istniejącym cyklu wsparcia. Segmenty zaznaczają wyłącznie fragmenty
 * własnej odpowiedzi dziecka. Komentarz modelu (`note`) nie wchodzi do Kid DTO.
 */
function resultFromSchoolVerdict(
  services: Services,
  key: LessonTaskAnswerKey,
  childAnswer: string,
  verdict: SchoolVerdict | null,
  verdictId: string | null,
  authoritativeIncorrect = false,
  skipFormCheck = false,
): LessonGradeResult {
  const objectiveId = key.objectiveId;
  if (verdict === null) {
    return { grade: gradeFromSchoolVerdict(null), feedback: { kind: "not_assessed" }, exposures: [], details: { objectiveId, verdict: "unavailable" } };
  }
  const grade: ObjectiveGrade = authoritativeIncorrect
    ? gradeFromSchoolVerdict({ ...verdict, knowledge: "incorrect" })
    : gradeFromSchoolVerdict(verdict);
  const criteria = key.schoolCriteria;
  const elementText = new Map((criteria?.requiredElements ?? []).map((el) => [el.id, el.text]));
  const fragments = [...verdict.incorrectStatements, ...verdict.redundantFragments];
  const segments = fragments.length + verdict.offTopicFragments.length > 0
    ? buildAnswerSegments(childAnswer, fragments, verdict.offTopicFragments)
    : null;
  const details: Record<string, unknown> = {
    objectiveId,
    verdict: grade.verdict,
    knowledge: verdict.knowledge,
    // Forma `one_sentence` liczona dla tego zapisu ogranicza precyzję (nigdy wiedzę).
    precision: formOkFor(key, childAnswer, skipFormCheck) === false && verdict.precision === "concise" ? "verbose" : verdict.precision,
    ...(verdictId ? { verdictId } : {}),
    matchedElementIds: [...verdict.matchedElementIds],
    missingElementIds: [...verdict.missingElementIds],
    ...(verdict.missingElementIds.length > 0
      ? { missingElementTexts: verdict.missingElementIds.map((id) => elementText.get(id) ?? id) }
      : {}),
    ...(verdict.incorrectStatements.length > 0 ? { incorrectStatements: [...verdict.incorrectStatements] } : {}),
    ...(verdict.redundantFragments.length > 0 ? { redundantFragments: [...verdict.redundantFragments] } : {}),
    // v3 (design §9.1): kategorie fragmentów i pomylone pojęcia — dla rodzica i selektora
    ...(verdict.offTopicFragments.length > 0 ? { offTopicFragments: [...verdict.offTopicFragments] } : {}),
    ...(verdict.confusedConcepts.length > 0 ? { confusedConcepts: verdict.confusedConcepts.map((pair) => ({ ...pair })) } : {}),
    ...(grade.errorCategory ? { errorCategory: grade.errorCategory } : {}),
    ...(formOkFor(key, childAnswer, skipFormCheck) === false ? { formOk: false } : {}),
    ...(criteria?.expectedForm ? { expectedForm: criteria.expectedForm } : {}),
  };
  if (grade.verdict === "model_correct") {
    return { grade, feedback: { kind: "great" }, exposures: [key.targetKey], details };
  }
  // Szablon: dobra część (gdy jest) → jeden najważniejszy brak → zachęta w tytule/UI.
  // Brakujący element nazywamy kategorią z modułu przedmiotu, nigdy treścią wzorca.
  const category = grade.errorCategory ?? "incomplete";
  const hint = hintTemplateFor(services, key, category) ?? "Pomyśl jeszcze raz i uzupełnij odpowiedź.";
  const praise = verdict.matchedElementIds.length > 0 ? "Dobra część odpowiedzi już jest. " : "";
  return {
    grade,
    feedback: { kind: "lesson_hint", hintPl: `${praise}${hint}`, ...(segments ? { answerSegments: segments } : {}) },
    exposures: [],
    details,
  };
}
type LessonVerdictRow = typeof lessonVerdicts.$inferSelect;

/**
 * Zapisany werdykt → `GraderVerdict` z `parent_decision` NADRZĘDNYM (design):
 * `overridden_correct` → correct bez kategorii/fragmentów; `overridden_incorrect`
 * → incorrect z zachowaną kategorią (albo `other`); `confirmed`/brak → werdykt
 * zapisany. Zwrócony kształt przechodzi przez `gradeFromVerdict` jak świeży.
 */
function verdictFromCacheRow(row: LessonVerdictRow): GraderVerdict {
  const stored: GraderVerdict = {
    verdict: row.verdict as GraderVerdict["verdict"],
    errorCategory: row.errorCategory,
    fragments: row.fragments ?? [],
    note: row.note ?? "",
  };
  switch (row.parentDecision) {
    case "overridden_correct":
      return { verdict: "correct", errorCategory: null, fragments: [], note: stored.note };
    case "overridden_incorrect":
      return { verdict: "incorrect", errorCategory: stored.errorCategory ?? "other", fragments: stored.fragments, note: stored.note };
    default:
      return stored;
  }
}

function dbOutcome(outcome: SkillOutcome): "correct" | "incorrect" | "unassessed" {
  return outcome === "unevaluated" ? "unassessed" : outcome;
}

/**
 * `confirmation_eligible` zapisywane do oceny. „Nieocenione" (`unevaluated` →
 * `unassessed`) jest NEUTRALNE: nie potwierdza niczego, więc flaga musi być
 * false — inaczej CHECK `assessments_unassessed_no_score` (outcome='unassessed'
 * ⇒ score null AND NOT confirmation_eligible) rzuca 23514. Dla ocenionych
 * zachowujemy wynik kwalifikacji (ta sama reguła przerwy co słówka).
 */
function confirmationEligibleFor(outcome: SkillOutcome, qualified: boolean): boolean {
  return outcome === "unevaluated" ? false : qualified;
}

/** Stan zadania lekcji po próbie (wynik `nextLessonTaskState`). */
export type LessonTaskStateAfterAttempt = "issued" | "answered" | "skipped";

/**
 * Przejście stanu zadania lekcji po ocenie (ruling 113): jedna oceniona
 * odpowiedź (poprawna albo błędna) kończy zadanie (`answered`); `skip` →
 * `skipped`; brak oceny (`unevaluated`) zostawia `issued` (retry / „Pomiń”).
 * W KARTKÓWCE jedna odpowiedź na slot jest zawsze terminalna: `skip` → `skipped`,
 * każda inna (w tym `unevaluated` bez kary) → `answered` (nigdy retry).
 */
function nextLessonTaskState(modality: LessonModality, outcome: SkillOutcome, mockTest = false): LessonTaskStateAfterAttempt {
  if (modality === "skip") return "skipped";
  if (mockTest) return "answered";
  if (outcome === "unevaluated") return "issued";
  return "answered";
}

/** Historia ocen celu dziecka (bieżąca wersja polityki filtruje projektor). */
async function objectiveHistory(tx: Tx, childId: string, objectiveId: string): Promise<ObjectiveHistoryEntry[]> {
  const rows = await tx
    .select({
      receivedAt: attempts.receivedAt,
      policyId: attempts.policyId,
      itemId: itemRevisions.itemId,
      outcome: assessments.outcome,
      reason: assessments.reason,
      independent: assessments.independent,
      confirmationEligible: assessments.confirmationEligible,
      objectiveId: assessments.details,
    })
    .from(assessments)
    .innerJoin(attempts, eq(attempts.id, assessments.attemptId))
    .innerJoin(itemRevisions, eq(itemRevisions.id, assessments.itemRevisionId))
    .where(and(eq(assessments.childId, childId), eq(assessments.skill, "objective")));

  // Wersja polityki wyprowadzona WPROST z zapisanego rekordu polityki (join przez
  // loadPolicy), a nie z założenia `policyId === version`. Gdyby id i version
  // kiedykolwiek się rozjechały, projektor nadal filtruje po PRAWDZIWEJ wersji
  // zamiast po cichu odrzucić całą historię. Cache per policyId w tej pętli.
  const versionByPolicyId = new Map<string, string>();
  const resolveVersion = async (policyId: string): Promise<string> => {
    const cached = versionByPolicyId.get(policyId);
    if (cached !== undefined) return cached;
    const version = (await loadPolicy(tx, policyId)).version;
    versionByPolicyId.set(policyId, version);
    return version;
  };

  const relevant = rows.filter(
    (row) => (row.objectiveId as { objectiveId?: string } | null)?.objectiveId === objectiveId,
  );
  const entries: ObjectiveHistoryEntry[] = [];
  for (const row of relevant) {
    entries.push({
      receivedAt: row.receivedAt.toISOString(),
      policyVersion: await resolveVersion(row.policyId),
      objectiveId,
      itemId: row.itemId,
      outcome: row.outcome === "unassessed" ? "unevaluated" : (row.outcome as SkillOutcome),
      ...(row.reason ? { reason: row.reason } : {}),
      independent: row.independent,
      confirmationEligible: row.confirmationEligible,
    });
  }
  return entries;
}

/** Interfejs wyniku wstępu przyjęcia odpowiedzi lekcji. */
interface LessonAttemptStart {
  task: TaskRow;
  session: SessionRow;
  itemId: string;
  lessonContext: unknown;
  feedbackPriorCount: number;
  policy: Policy;
  key: LessonTaskAnswerKey;
  frozen: FrozenLessonContext;
  attemptNumber: number;
  requestHash: string;
  receivedAt: Date;
  /** Sposób wprowadzenia odpowiedzi tekstowej, zweryfikowany wobec dyktowania. */
  answerSource: AnswerSource;
}

type AnswerSource = { inputMethod: "keyboard" } | { inputMethod: "speech"; edited: boolean };

/** Niepoprawiony tekst z dyktowania nie ma wiarygodnej interpunkcji (formOkFor). */
function skipsFormCheck(source: AnswerSource): boolean {
  return source.inputMethod === "speech" && !source.edited;
}

/** Zapis odpowiedzi tekstowej z oznaczeniem dyktowania; brak pola = klawiatura. */
function textAnswerOf(text: string, source: AnswerSource): Record<string, unknown> {
  return source.inputMethod === "speech" ? { text, inputMethod: "speech", edited: source.edited } : { text };
}

/**
 * Wspólny wstęp (arch §9.1a, §9.2): blokada sesji, idempotencja, leniwa
 * finalizacja, walidacje stanu, zamrożenie kontekstu kwalifikacji. Zwraca
 * `{ kind: 'dto' }` dla idempotentnego/istniejącego wyniku albo `{ kind: 'fresh' }`.
 */
async function startLessonAttempt(
  tx: Tx,
  services: Services,
  valid: Extract<AttemptInput, { modality: LessonModality }>,
): Promise<{ kind: "dto"; dto: AttemptDto } | { kind: "conflict"; error: AppError } | ({ kind: "fresh" } & LessonAttemptStart)> {
  const { task, session, itemId, lessonContext } = await lockTaskWithSession(tx, valid.taskId);
  const now = services.clock.now();
  const requestHash = requestHashOf(valid);

  // Jedno zapytanie o próby zadania i ewentualną próbę o tym samym
  // clientAttemptId: istniejący wynik, próby processing i liczba prób —
  // wcześniej do 4 osobnych zapytań.
  const related = await tx.select().from(attempts).where(or(
    eq(attempts.taskId, task.id),
    and(eq(attempts.childId, task.childId), eq(attempts.clientAttemptId, valid.clientAttemptId)),
  ));
  const taskAttempts = related.filter((attempt) => attempt.taskId === task.id);
  const existing = related.find((attempt) => attempt.clientAttemptId === valid.clientAttemptId);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new AppError("conflict", { message: "clientAttemptId reused with different answer" });
    }
    await lazyFinalizeStale(tx, services, task, session, itemId, now, taskAttempts);
    const fresh = (await tx.select().from(attempts).where(eq(attempts.id, existing.id)))[0]!;
    const state = await rereadTaskState(tx, task.id);
    // Kartkówka: idempotentny odczyt NIE ujawnia feedbacku (omówienie po końcu).
    if (session.mode !== "mock_test" && fresh.state === "completed" && fresh.feedback) {
      const stepId = await discloseLessonFeedback(tx, task, itemId, fresh.feedback as FeedbackDto, now);
      return { kind: "dto", dto: dtoOf(fresh, state, stepId) };
    }
    return { kind: "dto", dto: dtoOf(fresh, state) };
  }

  const lazy = await lazyFinalizeStale(tx, services, task, session, itemId, now, taskAttempts);

  if (session.state !== "active") {
    return { kind: "conflict", error: new AppError("conflict", { message: "session is closed" }) };
  }
  // Kartkówka: twardy limit 10 min — po nim żadnej nowej odpowiedzi (jak słówka).
  if (session.mode === "mock_test" && now.getTime() - session.startedAt.getTime() > 600_000) {
    return { kind: "conflict", error: new AppError("conflict", { message: "Czas kartkówki minął. Przejdź do omówienia." }) };
  }
  // Poza ścieżką leniwej finalizacji kartkówki stan zadania z locka jest
  // aktualny — każdy zapis stanu przechodzi przez tę samą blokadę sesji.
  const currentTaskState = lazy.taskChanged ? await rereadTaskState(tx, task.id) : task.state;
  if (currentTaskState !== "issued") {
    // Recovery musi zostać utrwalone nawet wtedy, gdy nowa próba jest odrzucona.
    return { kind: "conflict", error: new AppError("conflict", { message: "task is no longer issued" }) };
  }
  const key = keyOf(task);
  // Walidacja modalności vs typ ćwiczenia.
  assertModalityMatchesExercise(valid.modality, key.exerciseType);
  // Przypisania niepasujące do zadania (brak, obcy element, nieznany cel) to
  // błąd klienta: 400 bez próby (design szkoły §10.3). Zwracane, nie rzucane —
  // leniwa finalizacja wyżej musi zostać utrwalona.
  if (valid.modality === "assignment" && evaluateAssignment(valid.assignments, key) === null) {
    return { kind: "conflict", error: new AppError("validation", { message: "assignments do not match the task" }) };
  }
  // Poprawka („Skróć odpowiedź”): tylko tekst albo „Dalej”; „Nie pamiętam” przy
  // własnej odpowiedzi na ekranie ujawniałoby wzorzec bez sensu dydaktycznego.
  if (key.revisionOf && valid.modality !== "text" && valid.modality !== "skip") {
    throw new AppError("validation", { message: "attempt modality does not match exercise" });
  }

  // Migawka taskAttempts jest sprzed leniwej finalizacji: próba właśnie
  // domknięta jako techniczna nie jest już "processing" i nie blokuje
  // nowej odpowiedzi (regresja wykryta w review — słówka mają finalizedIds).
  const processing = taskAttempts.find(
    (attempt) => attempt.state === "processing" && !lazy.finalizedIds.has(attempt.id),
  );
  if (processing) {
    return { kind: "dto", dto: dtoOf(processing, currentTaskState) };
  }

  const attemptNumber = taskAttempts.length + 1;
  const policy = await loadPolicy(tx, session.policyId);
  const sessionContext = lessonSessionContextOf(session);
  const assistanceInfo = await assistanceFor(tx, task, key, now);
  const frozen: FrozenLessonContext = {
    receivedAt: now.toISOString(),
    policyVersion: policy.version,
    firstTry: attemptNumber === 1,
    assistance: assistanceInfo.assistance,
    answerPreviouslyExposed: await answerPreviouslyExposed(tx, task.childId, key.targetKey, task),
    previousSessionContactAt: sessionContext.previousObjectiveContact[key.objectiveId] ?? null,
    timezone: sessionContext.timezone,
  };

  const answerSource: AnswerSource = valid.modality === "text"
    ? resolveInputMethod({
      declared: valid.inputMethod,
      answerFingerprint: dictationFingerprint(valid.text),
      dictatedFingerprint: dictationStateOf(session.context).dictations[task.id],
    })
    : { inputMethod: "keyboard" };

  return {
    kind: "fresh", task, session, itemId, lessonContext,
    feedbackPriorCount: assistanceInfo.feedbackCount,
    policy, key, frozen, attemptNumber, requestHash, receivedAt: now, answerSource,
  };
}

/** Modalność musi pasować do typu ćwiczenia (jak walidacja słówek). */
function assertModalityMatchesExercise(modality: LessonModality, exerciseType: string): void {
  if (modality === "skip" || modality === "dont_remember") return;
  const CHOICE_TYPES = ["lesson_choice", "lesson_listen_choice", "lesson_short_answer", "lesson_notice"];
  const TEXT_TYPES = ["lesson_gap", "lesson_error_fix", "lesson_transform", "lesson_open_answer", "lesson_calculation"];
  const ok =
    (modality === "choice" && CHOICE_TYPES.includes(exerciseType)) ||
    (modality === "sequence" && exerciseType === "lesson_order") ||
    (modality === "selection" && exerciseType === "lesson_keywords") ||
    (modality === "assignment" && ["lesson_match", "lesson_group", "lesson_cloze"].includes(exerciseType)) ||
    (modality === "text" && TEXT_TYPES.includes(exerciseType));
  if (!ok) {
    throw new AppError("validation", { message: "attempt modality does not match exercise" });
  }
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

/** Czy feedback lekcji pokazuje odpowiedź celu (dla zapisu ekspozycji). */
export function revealsAnswer(feedback: FeedbackDto): boolean {
  if (feedback.kind === "not_assessed") return false;
  if (feedback.kind === "lesson_hint" && feedback.correctText === undefined) return false;
  return true;
}

/**
 * Dokleja do feedbacku nagranie pełnego zdania zamrożone w kluczu zadania
 * (tylko trening — kartkówka nie dostaje go w kluczu i nie ma feedbacku).
 * Nagranie ujawnia rozwiązanie, więc towarzyszy wyłącznie feedbackowi, który
 * je już pokazuje; oferta trenera precyzji i „Pomiń” (null) go nie dostają.
 * Nagranie czyta rozwiązanie kanoniczne, więc omówienie pokazujące inny
 * zatwierdzony wariant (`correctText` najbliższego wariantu ≠ `correctTextFor`)
 * też go nie dostaje: dziecko nie słyszy innego zdania, niż widzi. Bez pola
 * nagrania nie ma też pieczęci `audio_issued`.
 * Zadanie otwarte do ponowienia (`taskState === "issued"`, np. model_other)
 * nie dostaje nagrania: odsłuch przed ponowieniem byłby wsparciem tej próby.
 */
export function withFeedbackSentenceAudio(
  feedback: FeedbackDto | null,
  key: LessonTaskAnswerKey,
  taskState: LessonTaskStateAfterAttempt,
): FeedbackDto | null {
  if (taskState === "issued") return feedback;
  if (feedback === null || key.feedbackAudioAssetId === undefined) return feedback;
  if (feedback.kind === "lesson_precision_hint" || !revealsAnswer(feedback)) return feedback;
  if (feedback.correctText !== undefined && feedback.correctText !== correctTextFor(key)) return feedback;
  return { ...feedback, correctAudioAssetId: key.feedbackAudioAssetId };
}

/** Pieczęć odsłuchu zdania, gdy feedback niesie nagranie (po `discloseLessonFeedback`). */
async function sealFeedbackSentenceAudio(
  tx: Tx,
  task: TaskRow,
  itemId: string,
  feedback: FeedbackDto | null,
  receivedAt: Date,
  now: Date,
): Promise<void> {
  if (feedback?.correctAudioAssetId === undefined) return;
  await sealPostAnswerAudio(tx, { childId: task.childId, taskId: task.id, itemId, targetKey: keyOf(task).targetKey, receivedAt, now });
}

/** Zapis ekspozycji feedbacku lekcji przed odpowiedzią HTTP (jak słówka). */
async function discloseLessonFeedback(
  tx: Tx,
  task: TaskRow,
  itemId: string,
  feedback: FeedbackDto,
  now: Date,
  knownFeedbackCount?: number,
): Promise<string> {
  const key = keyOf(task);
  // not_assessed niczego nie ujawnia; podpowiedź bez correctText (szkoła:
  // partial/incorrect, błędny rachunek) pokazuje tylko szablon metody i fragmenty
  // własnej odpowiedzi dziecka — też bez ujawnienia. W pozostałych pokazujemy
  // rozwiązanie własnego zadania (target_key celu) oraz, przy minor_typo, wariant correctText.
  const exposures = revealsAnswer(feedback) ? [key.targetKey] : [];
  return discloseFeedbackEvent(tx, {
    task, childId: task.childId, itemId, exposures, now,
    ...(knownFeedbackCount === undefined ? {} : { knownPriorCount: knownFeedbackCount }),
  });
}

/**
 * Finalizuje świeżą próbę lekcji w jednej transakcji: ocena, assessments
 * (skill=`objective`), projekcja celu, przejście zadania, ekspozycja feedbacku.
 */
async function finalizeLessonAttempt(
  tx: Tx,
  services: Services,
  start: LessonAttemptStart,
  valid: Extract<AttemptInput, { modality: LessonModality }>,
  precomputed?: LessonGradeResult,
): Promise<AttemptDto> {
  const { task, session, itemId, policy, key, frozen, attemptNumber, requestHash, receivedAt } = start;
  const mockTest = session.mode === "mock_test";
  const graded = precomputed
    ?? noStimulusGrade(key, frozen.assistance, valid.modality)
    ?? gradeLessonAnswer(valid, task, key, services, skipsFormCheck(start.answerSource));
  const result = valid.modality === "text" ? withRevisionComparison(key.revisionOf, valid.text, graded) : graded;
  const qualification = qualifyLessonAttempt({
    receivedAt: frozen.receivedAt,
    policy,
    firstTry: frozen.firstTry,
    assistance: frozen.assistance,
    answerPreviouslyExposed: frozen.answerPreviouslyExposed,
    previousSessionContactAt: frozen.previousSessionContactAt,
    timezone: frozen.timezone,
  } satisfies LessonQualificationContext);
  const effectiveQualification = precisionTrainerQualification(task, qualification);

  const answer =
    valid.modality === "text"
      ? textAnswerOf(valid.text, start.answerSource)
      : valid.modality === "choice"
        ? { optionId: valid.optionId, optionText: key.optionValues?.[valid.optionId] ?? key.segmentValues?.[valid.optionId] ?? "" }
        : valid.modality === "sequence" || valid.modality === "selection"
          ? { itemIds: valid.itemIds }
          : valid.modality === "assignment"
            ? { assignments: valid.assignments }
            : null;

  const attemptId = randomUUID();
  await tx.insert(attempts).values({
    id: attemptId,
    childId: task.childId,
    taskId: task.id,
    itemRevisionId: task.itemRevisionId,
    clientAttemptId: valid.clientAttemptId,
    requestHash,
    attemptNumber,
    modality: valid.modality,
    state: "processing",
    answer,
    context: frozen as unknown as Record<string, unknown>,
    policyId: session.policyId,
    receivedAt,
  });

  // Oceny: skip nie tworzy ocen (jak słówka); pozostałe modalności tworzą jedną
  // ocenę celu (skill=objective) z `details` i kwalifikacją.
  if (valid.modality !== "skip") {
    const skillRow = (
      await tx
        .select({ skillVersionId: itemRevisionSkills.skillVersionId })
        .from(itemRevisionSkills)
        .where(and(eq(itemRevisionSkills.itemRevisionId, task.itemRevisionId), eq(itemRevisionSkills.skill, "objective")))
    )[0];
    if (!skillRow) {
      throw new AppError("internal", { message: "missing objective skill version" });
    }
    await tx.insert(assessments).values({
      childId: task.childId,
      attemptId,
      itemRevisionId: task.itemRevisionId,
      skill: "objective",
      skillVersionId: skillRow.skillVersionId,
      outcome: dbOutcome(result.grade.outcome),
      ...(result.grade.reason ? { reason: result.grade.reason } : {}),
      independent: effectiveQualification.independent,
      confirmationEligible: confirmationEligibleFor(result.grade.outcome, effectiveQualification.confirmationEligible),
      details: result.details,
    });

    // Projekcja celu w tej samej transakcji (tylko gdy oceniono — unevaluated jest neutralne).
    if (result.grade.outcome !== "unevaluated") {
      await projectAndUpsertObjective(tx, services, task, key, policy, receivedAt, start.lessonContext);
    }
  }

  const taskState = nextLessonTaskState(valid.modality, result.grade.outcome, mockTest);
  let finalTaskState: string = task.state;
  if (taskState !== "issued") {
    const [updated] = await tx.update(sessionTasks).set({ state: taskState }).where(eq(sessionTasks.id, task.id)).returning({ state: sessionTasks.state });
    finalTaskState = updated?.state ?? taskState;
  }

  // Kartkówka: wynik niewidoczny dla dziecka — żadnego feedbacku ani ekspozycji
  // feedbacku w trakcie (omówienie dopiero po zamknięciu).
  // Trener precyzji: poprawna, lecz rozwlekła odpowiedź otwarta dostaje zadanie następcze.
  const shortenOffer = !mockTest && valid.modality === "text" && taskState !== "issued"
    ? await offerShortenFollowUp(tx, services, { task, session, itemId, attemptId, childAnswer: valid.text, result, now: receivedAt })
    : null;
  // Nagranie zdania doklejone PRZED zapisem — ponowny odczyt zwraca ten sam identyfikator.
  const visibleFeedback = mockTest || valid.modality === "skip" ? null : shortenOffer ?? result.feedback;
  const feedback = withFeedbackSentenceAudio(visibleFeedback, key, taskState);
  const completed = await tx
    .update(attempts)
    .set({ state: "completed", completedAt: receivedAt, feedback: feedback as unknown as Record<string, unknown> })
    .where(and(eq(attempts.id, attemptId), eq(attempts.state, "processing")))
    .returning();
  if (completed.length === 0) {
    throw new AppError("conflict", { message: "attempt is already finalized" });
  }

  // Aktywność sesji rozlicza wyłącznie raport FE na końcu sesji (spec
  // client-reward-time); próba zostawia tylko ocenę i ekspozycje.
  const stepId = feedback === null ? null : await discloseLessonFeedback(tx, task, itemId, feedback, receivedAt, start.feedbackPriorCount);
  await sealFeedbackSentenceAudio(tx, task, itemId, feedback, receivedAt, receivedAt);
  return {
    attemptId,
    taskId: task.id,
    state: "completed",
    modality: valid.modality,
    feedback,
    taskState: finalTaskState as AttemptDto["taskState"],
    stepId,
    receivedAt: receivedAt.toISOString(),
    completedAt: receivedAt.toISOString(),
  };
}

/** Projekcja celu z historii ocen i upsert `child_objective_progress`. */
async function projectAndUpsertObjective(
  tx: Tx,
  services: Services,
  task: TaskRow,
  key: LessonTaskAnswerKey,
  policy: Policy,
  now: Date,
  knownLessonContext?: unknown,
): Promise<void> {
  const history = await objectiveHistory(tx, task.childId, key.objectiveId);
  const projection = projectObjectiveProgress(history, policy, now.toISOString())[key.objectiveId];
  if (!projection) return;
  const topicId = await objectiveTopicId(tx, task, key, services, knownLessonContext);
  const lastIndependentAt = lastIndependentObjectiveAt(history, policy.version);
  await tx
    .insert(childObjectiveProgress)
    .values({
      childId: task.childId,
      subjectId: key.subjectId,
      objectiveId: key.objectiveId,
      topicId,
      status: toDbObjectiveStatus(projection.status),
      streak: projection.streak,
      ...(projection.nextReviewAt ? { nextReviewAt: new Date(projection.nextReviewAt) } : {}),
      ...(lastIndependentAt ? { lastIndependentAt: new Date(lastIndependentAt) } : {}),
      projectionVersion: policy.version,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [childObjectiveProgress.childId, childObjectiveProgress.subjectId, childObjectiveProgress.objectiveId],
      set: {
        status: toDbObjectiveStatus(projection.status),
        streak: projection.streak,
        nextReviewAt: projection.nextReviewAt ? new Date(projection.nextReviewAt) : null,
        ...(lastIndependentAt ? { lastIndependentAt: new Date(lastIndependentAt) } : {}),
        projectionVersion: policy.version,
        updatedAt: now,
      },
    });
}

/** Temat celu z `lesson_context` wersji (dla klucza child_objective_progress). */
async function objectiveTopicId(
  tx: Tx,
  task: TaskRow,
  key: LessonTaskAnswerKey,
  services: Services,
  knownLessonContext?: unknown,
): Promise<string> {
  const topicId = knownLessonContext !== undefined
    ? (knownLessonContext as { topicId?: string } | null)?.topicId
    : ((await tx.select({ lessonContext: deckVersions.lessonContext }).from(deckVersions).where(eq(deckVersions.id, task.deckVersionId)))[0]?.lessonContext as { topicId?: string } | null | undefined)?.topicId;
  if (topicId) return topicId;
  // zapas: znajdź temat zawierający cel w rejestrze
  const subject = services.subjects.getSubject(key.subjectId);
  for (const topic of subject?.topics ?? []) {
    if (topic.objectives.some((o) => o.id === key.objectiveId)) return topic.id;
  }
  // Brak topic_id to niespójna wersja lekcji — nie zapisujemy pustego klucza
  // do child_objective_progress, tylko sygnalizujemy błąd.
  throw new AppError("internal", { message: `lesson topic missing for objective: ${key.subjectId}/${key.objectiveId}` });
}

/** Leniwa finalizacja przeterminowanej próby processing lekcji (arch §9.2a). */
async function lazyFinalizeStale(
  tx: Tx,
  services: Services,
  task: TaskRow,
  session: SessionRow,
  itemId: string,
  now: Date,
  preloadedTaskAttempts?: readonly AttemptRow[],
): Promise<{ taskChanged: boolean; finalizedIds: ReadonlySet<string> }> {
  void services;
  let taskChanged = false;
  const finalizedIds = new Set<string>();
  const taskAttempts = preloadedTaskAttempts ?? await tx.select().from(attempts).where(eq(attempts.taskId, task.id));
  const stale = taskAttempts.filter((attempt) => attempt.state === "processing");
  for (const attempt of stale) {
    if (now.getTime() - attempt.receivedAt.getTime() <= LESSON_ATTEMPT_PROCESSING_TIMEOUT_MS) continue;
    // technical: żadnej oceny wiedzy; zadanie zostaje issued; feedback not_assessed bez ekspozycji
    const completed = await tx
      .update(attempts)
      .set({ state: "completed", completedAt: now, feedback: session.mode === "mock_test" ? null : { kind: "not_assessed" } as unknown as Record<string, unknown> })
      .where(and(eq(attempts.id, attempt.id), eq(attempts.state, "processing")))
      .returning();
    if (completed.length === 0) continue;
    finalizedIds.add(attempt.id);
    if (session.mode === "mock_test") {
      if (session.state === "active") {
        await tx.update(sessionTasks).set({ state: "answered" }).where(eq(sessionTasks.id, task.id));
        taskChanged = true;
      }
    } else {
      await discloseLessonFeedback(tx, task, itemId, { kind: "not_assessed" }, now);
    }
  }
  return { taskChanged, finalizedIds };
}

/**
 * Przyjmuje odpowiedź dziecka na zadanie lekcji (design „Przyjęcie odpowiedzi”).
 * Walidacja wejścia, idempotencja i blokada sesji wspólne ze słówkami; ocena,
 * projekcja celu i ujawnienie feedbacku to jedna transakcja.
 */
export async function submitLessonAttempt(services: Services, input: AttemptInput): Promise<AttemptDto> {
  const valid = AttemptInputSchema.parse(input);
  if (valid.modality === "audio") {
    throw new AppError("validation", { message: "speech attempts require the audio path" });
  }
  const typed = valid as Extract<AttemptInput, { modality: LessonModality }>;

  // Faza 1 (pod blokadą sesji): wstęp, ocena deterministyczna i decyzja o ścieżce.
  const phase1 = await services.db.transaction(async (tx) => {
    const started = await startLessonAttempt(tx, services, typed);
    if (started.kind === "conflict") return started;
    if (started.kind === "dto") {
      return { kind: "done" as const, dto: started.dto };
    }
    const result = noStimulusGrade(started.key, started.frozen.assistance, typed.modality)
      ?? gradeLessonAnswer(typed, started.task, started.key, services, skipsFormCheck(started.answerSource));

    // Tylko niedopasowana odpowiedź TEKSTOWA eskaluje do zapisanego werdyktu / modelu.
    const needsModel = typed.modality === "text" && started.key.exerciseType !== "lesson_calculation" && result.grade.verdict === "unavailable";
    if (!needsModel) {
      const dto = await finalizeLessonAttempt(tx, services, started, typed, result);
      return { kind: "done" as const, dto };
    }

    const childAnswer = typed.text;
    const normalizedAnswer = normalizedAnswerKey(services, started.key, childAnswer);
    // Wersja promptu zależy od ścieżki (szkoła ma osobny klucz cache).
    const earlyInput = services.grader ? buildGraderInput(services, started.task, started.key, childAnswer) : null;
    const promptVersion = services.grader
      ? (services.grader.provider.promptVersionForInput?.(earlyInput!) ?? services.grader.provider.promptVersion)
      : undefined;

    // Krok 3: trafienie w cache (ten sam materiał) — finalizacja jak deterministyczna.
    if (promptVersion) {
      const cached = await readCachedVerdict(tx, started.task.itemRevisionId, normalizedAnswer, promptVersion);
      if (cached) {
        const schoolVerdict = earlyInput?.school ? schoolVerdictFromCacheRow(cached, started.key, childAnswer) : null;
        const cachedResult = earlyInput?.school
          ? schoolVerdict
            ? resultFromSchoolVerdict(services, started.key, childAnswer, schoolVerdict, cached.id, cached.parentDecision === "overridden_incorrect", skipsFormCheck(started.answerSource))
            : null
          : resultFromVerdict(services, started.task, started.key, childAnswer, verdictFromCacheRow(cached), cached.id, cached.parentDecision === "overridden_incorrect");
        if (cachedResult) {
          const dto = await finalizeLessonAttempt(tx, services, started, typed, cachedResult);
          return { kind: "done" as const, dto };
        }
      }
    }

    // Krok 4: brak werdyktu. Model niedostępny lub limit wyczerpany → nieocenione.
    const grader = services.grader;
    const sessionContext = lessonSessionContextOf(started.session);
    const underLimit = grader !== undefined && sessionContext.graderCalls < grader.maxCallsPerSession;
    if (!grader || !underLimit) {
      const unavailable = resultFromVerdict(services, started.task, started.key, childAnswer, null, null);
      const dto = await finalizeLessonAttempt(tx, services, started, typed, unavailable);
      return { kind: "done" as const, dto };
    }

    // Rezerwacja: inkrement graderCalls + wstawienie próby `processing` w tej transakcji.
    await incrementGraderCalls(tx, started.session.id, sessionContext);
    const attemptId = await reserveProcessingAttempt(tx, started, typed, childAnswer);
    return {
      kind: "grade" as const,
      start: started,
      attemptId,
      childAnswer,
      normalizedAnswer,
      promptVersion: grader.provider.promptVersion,
      graderModel: grader.provider.model,
      timeoutMs: grader.timeoutMs,
    };
  });

  if (phase1.kind === "conflict") throw phase1.error;
  if (phase1.kind === "done") {
    return phase1.dto;
  }

  // Wywołanie modelu POZA transakcją (deadline). Awaria/timeout/odrzucenie → brak werdyktu.
  const grader = services.grader!;
  const graderInput = buildGraderInput(services, phase1.start.task, phase1.start.key, phase1.childAnswer);
  const allowed = allowedCategoriesFor(services, phase1.start.key);
  let verdict: GraderVerdict | null = null;
  let schoolVerdict: SchoolVerdict | null = null;
  const effectivePromptVersion =
    grader.provider.promptVersionForInput?.(graderInput) ?? grader.provider.promptVersion;
  try {
    const signal = AbortSignal.timeout(phase1.timeoutMs);
    const raw = await grader.provider.grade(graderInput, signal);
    if (graderInput.school) {
      schoolVerdict = validateSchoolVerdict(raw, {
        requiredElementIds: graderInput.school.requiredElements.map((el) => el.id),
        childAnswer: phase1.childAnswer,
        // Bez klamry formy: do cache trafia precyzja modelu, klamra dotyczy tylko tej próby.
        formOk: null,
      });
    } else {
      verdict = validateVerdict(raw, { allowedCategories: allowed, childAnswer: phase1.childAnswer });
    }
  } catch {
    verdict = null; // technical: timeout / 5xx / sieć / 429 → nieocenione, licznik zużyty
    schoolVerdict = null;
  }

  // Faza 2 (CAS): zapis werdyktu do cache (ON CONFLICT DO NOTHING), odczyt wiersza,
  // ocena z wiersza cache (równoległe identyczne odpowiedzi → ten sam werdykt),
  // finalizacja zarezerwowanej próby.
  return services.db.transaction(async (tx) => {
    return finalizeGradedAttempt(tx, services, phase1.start, phase1.attemptId, {
      childAnswer: phase1.childAnswer,
      normalizedAnswer: phase1.normalizedAnswer,
      promptVersion: effectivePromptVersion,
      graderModel: phase1.graderModel,
      verdict,
      ...(schoolVerdict ? { schoolVerdict } : {}),
    });
  });
}

/** Odczyt zapisanego werdyktu po kluczu cache (ta sama transakcja). */
async function readCachedVerdict(
  tx: Tx,
  itemRevisionId: string,
  normalizedAnswer: string,
  promptVersion: string,
): Promise<LessonVerdictRow | undefined> {
  return (
    await tx
      .select()
      .from(lessonVerdicts)
      .where(
        and(
          eq(lessonVerdicts.itemRevisionId, itemRevisionId),
          eq(lessonVerdicts.normalizedAnswer, normalizedAnswer),
          eq(lessonVerdicts.promptVersion, promptVersion),
        ),
      )
  )[0];
}

/** Inkrement `learning_sessions.context.graderCalls` w tej transakcji (pod blokadą). */
async function incrementGraderCalls(tx: Tx, sessionId: string, context: LessonSessionContext): Promise<void> {
  const next = { ...context, graderCalls: context.graderCalls + 1 } as unknown as Record<string, unknown>;
  await tx.update(learningSessions).set({ context: next }).where(eq(learningSessions.id, sessionId));
}

/** Rezerwuje próbę `processing` dla ścieżki modelu (finalizowana w fazie 2). */
async function reserveProcessingAttempt(
  tx: Tx,
  start: LessonAttemptStart,
  valid: Extract<AttemptInput, { modality: "text" }>,
  childAnswer: string,
): Promise<string> {
  const attemptId = randomUUID();
  await tx.insert(attempts).values({
    id: attemptId,
    childId: start.task.childId,
    taskId: start.task.id,
    itemRevisionId: start.task.itemRevisionId,
    clientAttemptId: valid.clientAttemptId,
    requestHash: start.requestHash,
    attemptNumber: start.attemptNumber,
    modality: "text",
    state: "processing",
    answer: textAnswerOf(childAnswer, start.answerSource),
    context: start.frozen as unknown as Record<string, unknown>,
    policyId: start.session.policyId,
    receivedAt: start.receivedAt,
  });
  return attemptId;
}

interface GradedFinalizeArgs {
  childAnswer: string;
  schoolVerdict?: SchoolVerdict | null;
  normalizedAnswer: string;
  promptVersion: string;
  graderModel: string;
  verdict: GraderVerdict | null;
}

/**
 * Faza 2: finalizacja zarezerwowanej próby po wywołaniu modelu. Werdykt (gdy
 * jest) zapisywany do cache `ON CONFLICT DO NOTHING`, po czym czytamy wiersz —
 * dwie równoległe identyczne odpowiedzi zbiegają się na JEDNYM wpisie i obie
 * oceniają z tego samego werdyktu. Brak werdyktu → nieocenione, bez wpisu w
 * cache, licznik nie cofany. Ocena, projekcja celu, ekspozycja, przejście
 * zadania — jak ścieżka deterministyczna.
 */
async function finalizeGradedAttempt(
  tx: Tx,
  services: Services,
  start: LessonAttemptStart,
  attemptId: string,
  args: GradedFinalizeArgs,
): Promise<AttemptDto> {
  const { task, itemId, policy, key, frozen, receivedAt } = start;

  // Faza 2 MUSI działać pod TĄ SAMĄ wspólną blokadą sesji co faza 1 / endSession:
  // bez niej drugi klient mógł w międzyczasie zamknąć sesję (np. kartkówkę) i
  // utrwalić NIEZMIENNY raport, a spóźniony werdykt rozjechałby omówienie dziecka
  // z raportem rodzica. Blokada ustawia wspólną kolejność; po niej odczytujemy
  // aktualny stan próby i sesji.
  const { session: freshSession, lessonContext } = await lockTaskWithSession(tx, task.id);
  const reserved = (await tx.select().from(attempts).where(eq(attempts.id, attemptId)))[0];
  const mockTest = freshSession.mode === "mock_test";

  // Sesja już zamknięta (raport utrwalony) albo próba już sfinalizowana (leniwa
  // finalizacja / inny klient): NIE zapisujemy oceny, nie zmieniamy projekcji ani
  // zadania. Domykamy zarezerwowaną próbę jako nieocenioną (bez wpisu assessment,
  // bez feedbacku) i zwracamy bieżący stan zgodny z utrwalonym raportem.
  if (freshSession.state !== "active" || !reserved || reserved.state !== "processing") {
    if (reserved && reserved.state === "processing") {
      await tx
        .update(attempts)
        .set({ state: "completed", completedAt: receivedAt, feedback: { kind: "not_assessed" } as unknown as Record<string, unknown> })
        .where(and(eq(attempts.id, attemptId), eq(attempts.state, "processing")));
    }
    const current = (await tx.select().from(attempts).where(eq(attempts.id, attemptId)))[0]!;
    const freshTask = (await tx.select().from(sessionTasks).where(eq(sessionTasks.id, task.id)))[0]!;
    return dtoOf(current, freshTask.state);
  }

  // Zapis werdyktu do cache i odczyt wiersza (zbieżność równoległych odpowiedzi).
  let effectiveVerdict: GraderVerdict | null = args.verdict;
  let effectiveSchoolVerdict: SchoolVerdict | null = args.schoolVerdict ?? null;
  let authoritativeIncorrect = false;
  let verdictId: string | null = null;
  if (args.schoolVerdict) {
    const sv = args.schoolVerdict;
    await tx
      .insert(lessonVerdicts)
      .values({
        id: randomUUID(),
        itemRevisionId: task.itemRevisionId,
        normalizedAnswer: args.normalizedAnswer,
        promptVersion: args.promptVersion,
        graderModel: args.graderModel,
        verdict: sv.knowledge === "correct" ? "correct" : sv.knowledge === "partial" ? "almost" : "incorrect",
        // Ta sama kategoria co w ocenie (np. incorrect bez błędnych stwierdzeń = incomplete).
        errorCategory: gradeFromSchoolVerdict(sv).errorCategory ?? null,
        fragments: [...new Set([...sv.incorrectStatements, ...sv.redundantFragments, ...sv.offTopicFragments])].slice(0, 4),
        precision: sv.precision,
        matchedElements: [...sv.matchedElementIds],
        missingElements: [...sv.missingElementIds],
        incorrectStatements: [...sv.incorrectStatements],
        redundantFragments: [...sv.redundantFragments],
        offTopicFragments: [...sv.offTopicFragments],
        confusedConcepts: sv.confusedConcepts.map((pair) => ({ ...pair })),
        note: sv.note,
        createdAt: receivedAt,
      })
      .onConflictDoNothing({
        target: [lessonVerdicts.itemRevisionId, lessonVerdicts.normalizedAnswer, lessonVerdicts.promptVersion],
      });
    const row = await readCachedVerdict(tx, task.itemRevisionId, args.normalizedAnswer, args.promptVersion);
    if (row) {
      effectiveSchoolVerdict = schoolVerdictFromCacheRow(row, key, args.childAnswer) ?? effectiveSchoolVerdict;
      verdictId = row.id;
      authoritativeIncorrect = row.parentDecision === "overridden_incorrect";
    }
  }
  if (args.verdict !== null) {
    await tx
      .insert(lessonVerdicts)
      .values({
        id: randomUUID(),
        itemRevisionId: task.itemRevisionId,
        normalizedAnswer: args.normalizedAnswer,
        promptVersion: args.promptVersion,
        graderModel: args.graderModel,
        verdict: args.verdict.verdict,
        errorCategory: args.verdict.errorCategory,
        fragments: [...args.verdict.fragments],
        note: args.verdict.note,
        createdAt: receivedAt,
      })
      .onConflictDoNothing({
        target: [lessonVerdicts.itemRevisionId, lessonVerdicts.normalizedAnswer, lessonVerdicts.promptVersion],
      });
    const row = await readCachedVerdict(tx, task.itemRevisionId, args.normalizedAnswer, args.promptVersion);
    if (row) {
      effectiveVerdict = verdictFromCacheRow(row);
      verdictId = row.id;
      authoritativeIncorrect = row.parentDecision === "overridden_incorrect";
    }
  }

  const result = withRevisionComparison(key.revisionOf, args.childAnswer, args.schoolVerdict !== undefined || key.schoolCriteria
    ? resultFromSchoolVerdict(
        services,
        key,
        args.childAnswer,
        effectiveSchoolVerdict,
        verdictId,
        authoritativeIncorrect,
        skipsFormCheck(start.answerSource),
      )
    : resultFromVerdict(services, task, key, args.childAnswer, effectiveVerdict, verdictId, authoritativeIncorrect));
  const qualification = qualifyLessonAttempt({
    receivedAt: frozen.receivedAt,
    policy,
    firstTry: frozen.firstTry,
    assistance: frozen.assistance,
    answerPreviouslyExposed: frozen.answerPreviouslyExposed,
    previousSessionContactAt: frozen.previousSessionContactAt,
    timezone: frozen.timezone,
  } satisfies LessonQualificationContext);
  const effectiveQualification = precisionTrainerQualification(task, qualification);

  const skillRow = (
    await tx
      .select({ skillVersionId: itemRevisionSkills.skillVersionId })
      .from(itemRevisionSkills)
      .where(and(eq(itemRevisionSkills.itemRevisionId, task.itemRevisionId), eq(itemRevisionSkills.skill, "objective")))
  )[0];
  if (!skillRow) {
    throw new AppError("internal", { message: "missing objective skill version" });
  }
  await tx.insert(assessments).values({
    childId: task.childId,
    attemptId,
    itemRevisionId: task.itemRevisionId,
    skill: "objective",
    skillVersionId: skillRow.skillVersionId,
    outcome: dbOutcome(result.grade.outcome),
    ...(result.grade.reason ? { reason: result.grade.reason } : {}),
    independent: effectiveQualification.independent,
    confirmationEligible: confirmationEligibleFor(result.grade.outcome, effectiveQualification.confirmationEligible),
    details: result.details,
  });
  if (result.grade.outcome !== "unevaluated") {
    await projectAndUpsertObjective(tx, services, task, key, policy, receivedAt, lessonContext);
  }

  const taskState = nextLessonTaskState("text", result.grade.outcome, mockTest);
  let finalTaskState: string = task.state;
  if (taskState !== "issued") {
    const [updated] = await tx.update(sessionTasks).set({ state: taskState }).where(eq(sessionTasks.id, task.id)).returning({ state: sessionTasks.state });
    finalTaskState = updated?.state ?? taskState;
  }

  // Kartkówka: wynik niewidoczny — brak feedbacku/ekspozycji w trakcie.
  const shortenOffer = !mockTest && taskState !== "issued"
    ? await offerShortenFollowUp(tx, services, { task, session: freshSession, itemId, attemptId, childAnswer: args.childAnswer, result, now: receivedAt })
    : null;
  // Nagranie zdania doklejone przed zapisem (jak wyżej).
  const visibleFeedback = mockTest ? null : shortenOffer ?? result.feedback;
  const feedback = withFeedbackSentenceAudio(visibleFeedback, key, taskState);
  const completed = await tx
    .update(attempts)
    .set({ state: "completed", completedAt: receivedAt, feedback: feedback as unknown as Record<string, unknown> })
    .where(and(eq(attempts.id, attemptId), eq(attempts.state, "processing")))
    .returning();
  if (completed.length === 0) {
    // Już sfinalizowana (np. leniwa finalizacja w międzyczasie) — zwróć bieżący stan.
    const fresh = (await tx.select().from(attempts).where(eq(attempts.id, attemptId)))[0]!;
    const freshTask = (await tx.select().from(sessionTasks).where(eq(sessionTasks.id, task.id)))[0]!;
    return dtoOf(fresh, freshTask.state);
  }

  // finalizeGradedAttempt is only reached for an accepted textual response;
  // an unavailable grader changes mastery, not whether the child did the work.
  // Aktywność sesji rozlicza wyłącznie raport FE na końcu sesji.
  const stepId = feedback === null ? null : await discloseLessonFeedback(tx, task, itemId, feedback, receivedAt);
  await sealFeedbackSentenceAudio(tx, task, itemId, feedback, receivedAt, services.clock.now());
  return {
    attemptId,
    taskId: task.id,
    state: "completed",
    modality: "text",
    feedback,
    taskState: finalTaskState as AttemptDto["taskState"],
    stepId,
    receivedAt: receivedAt.toISOString(),
    completedAt: receivedAt.toISOString(),
  };
}

/**
 * Odczyt próby lekcji (arch §12). Rozlicza leniwe processing; ponowne wydanie
 * feedbacku zapisuje kolejne ujawnienie przed odpowiedzią (jak słówka).
 */
export async function readLessonAttempt(services: Services, attempt: AttemptRow): Promise<AttemptDto> {
  return services.db.transaction(async (tx) => {
    const { task, session, itemId } = await lockTaskWithSession(tx, attempt.taskId);
    const now = services.clock.now();
    await lazyFinalizeStale(tx, services, task, session, itemId, now);
    const fresh = (await tx.select().from(attempts).where(eq(attempts.id, attempt.id)))[0]!;
    const freshTask = (await tx.select().from(sessionTasks).where(eq(sessionTasks.id, task.id)))[0]!;
    if (session.mode !== "mock_test" && fresh.state === "completed" && fresh.feedback) {
      const stepId = await discloseLessonFeedback(tx, freshTask, itemId, fresh.feedback as FeedbackDto, now);
      return dtoOf(fresh, freshTask.state, stepId);
    }
    return dtoOf(fresh, freshTask.state);
  });
}
