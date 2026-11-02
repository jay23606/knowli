import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  LessonCommandSchema,
  LessonVoiceToneSchema,
  MaterialLessonCommandSchema,
  SchoolLessonCommandSchema,
  type LessonCommand,
  type LessonVoiceTone,
  type MaterialLessonCommand,
  type SchoolLessonCommand,
} from "@learning/contracts";
import type { Clock, Services } from "../../../config";
import type { Executor, Tx } from "../../../db/client";
import {
  deckVersions,
  decks,
  generationRuns,
  itemRevisions,
  itemRevisionSkills,
  learningItems,
  skillVersions,
} from "../../../db/schema";
import { AppError } from "../../../errors";
import { lessonExerciseTargetKey } from "../../../domain/lessons/exposure-key";
import {
  DEFAULT_LESSON_POLICY,
  defaultPoolSize,
  type StageMix,
} from "../../../domain/lessons/lesson-policy";
import { materialCreationMode, stripListenChoiceExtras } from "../../../domain/lessons/material-creation";
import { answersEquivalent, keywordsAnswer, MAX_TEXT_LENGTH, validatePool, withoutRedundantAcceptedVariants } from "../../../domain/lessons/pool-validation";
import {
  lessonExerciseIdentity,
  lessonExerciseStimulus,
  lessonExerciseStimulusRecord,
  lessonIdentityOptionsOf,
  type LessonExerciseIdentityOptions,
  type LessonExerciseStimulus,
} from "../../../domain/lessons/exercise-identity";
import type {
  DynamicTopicData,
  LessonExerciseDraft,
  LessonExerciseType,
  LessonTopic,
  SubjectModule,
} from "../../../domain/lessons/types";
import type { LessonPoolInput, LlmLessonStageCounts } from "../../../ports/ai";
import { resolveLessonTopic, validateDynamicTopicData } from "../../../domain/lessons/topic-resolution";
import {
  claimQueuedRun,
  enqueueGenerationRun,
  supersedeLessonRuns,
} from "../generation-runs";
import { MAX_AUTOMATIC_ATTEMPTS, requireGeneration } from "../generation-runtime";
import { classifyLessonGenerationFailure, lessonRetryDelayMs } from "./lesson-generation-errors";
import { assertLessonGenerationFinalizationAllowed, LessonGenerationCancelledError, withLessonGenerationControl } from "./lesson-generation-control";
import { DEFAULT_LESSON_GENERATION_POLICY } from "./lesson-generation-policy";
import { reconcileDraftAssetsTx } from "../media-reconciliation";
import { committedRetryAfterSourceChange, lockSourceMaterialForCopy } from "../source-materials";

/**
 * Generowanie i zapis szkicu lekcji (design „Generowanie puli (worker)”).
 * `createLesson` tworzy deck lekcji + wersję draft + run `lesson` idempotentnie
 * (wspólny `enqueueGenerationRun` ze ścieżką słówek). `executeLessonGeneration`
 * woła port `generateLessonPool` partiami per cel, waliduje pulę w domenie
 * (`validatePool`) i zapisuje poprawne ćwiczenia pod blokadą wersji, przechodząc
 * `draft → review`. Ścieżka słówek pozostaje nietknięta: ten moduł nie dotyka
 * `applyItems` ani VOCABULARY_SKILLS.
 */

/** Kontekst lekcji zapisany w `deck_versions.lesson_context`. */
interface LessonContext {
  subjectId: string;
  topicId: string;
  topicVersion: number;
  objectiveIds: string[];
  poolSize: number;
  material: string;
  instruction?: string;
  /** Migawka tematów zdań z zainteresowań dziecka z chwili tworzenia (bez danych dziecka). */
  interests?: string[];
  examples: Record<string, string[]>;
  /** Nazwa przedmiotu od rodzica (zestawy szkolne). */
  subjectTitlePl?: string;
  /** Temat dynamiczny z materiału (zestawy szkolne; uzupełniany przy generacji). */
  dynamicTopic?: DynamicTopicData;
  /** Licznik ćwiczeń odrzuconych przy walidacji (dla panelu rodzica). */
  rejectedCount: number;
  /** Powody odrzuceń z czyszczenia świeżej puli (`refineGeneratedPool`) z licznikami; bez danych dziecka. */
  rejectedReasons?: Record<string, number>;
  /** Zagadnienia odrzucone/pominięte na etapie generowania tematu (szkoła; panel rodzica). */
  droppedObjectiveCount?: number;
}

/** Wejście runu `lesson` zapisane w `generation_runs.input`. */
interface LessonRunInput {
  deckId: string;
  deckVersionId: string;
  subjectId: string;
  topicId: string;
  topicVersion: number;
  objectiveIds: string[];
  poolSize: number;
  material: string;
  instruction?: string;
  /** Migawka tematów zdań; dogenerowanie kopiuje ją z kontekstu, nie z profilu. */
  interests?: string[];
  subjectTitlePl?: string;
  topicTitlePl?: string;
  /** Migawka tematu dynamicznego (dogenerowanie zestawu szkolnego). */
  dynamicTopic?: DynamicTopicData;
  /** Dogenerowanie jednego celu: nowe ćwiczenia dopisujemy, nie czyścimy. */
  regenerate?: { objectiveId: string; count: number; existingAnswers: string[]; existingExercises?: LessonExerciseStimulus[] };
}

function requireSubject(services: Services, subjectId: string): SubjectModule {
  const subject = services.subjects.getSubject(subjectId);
  if (!subject) {
    throw new AppError("validation", { message: `unknown subject: ${subjectId}` });
  }
  return subject;
}

function requireLatestTopic(services: Services, subjectId: string, topicId: string): LessonTopic {
  const topic = services.subjects.getLatestTopic(subjectId, topicId);
  if (!topic) {
    throw new AppError("validation", { message: `unknown topic: ${subjectId}/${topicId}` });
  }
  return topic;
}

/** Cele ⊆ temat; inaczej 400 validation (design „Error Handling”). */
function assertObjectivesInTopic(topic: LessonTopic, objectiveIds: readonly string[]): void {
  const known = new Set(topic.objectives.map((o) => o.id));
  for (const id of objectiveIds) {
    if (!known.has(id)) {
      throw new AppError("validation", { message: `unknown objective: ${id}` });
    }
  }
}

/** Tytuł lekcji: z tematu i przedmiotu, lub z instrukcji, obcięty do 120 znaków. */
function lessonTitle(subject: SubjectModule, topic: LessonTopic, instruction?: string): string {
  const base = `${subject.titlePl}: ${topic.titlePl}`;
  const title = instruction && instruction.trim() !== "" ? instruction.trim() : base;
  return [...title].slice(0, 120).join("");
}

export async function createLesson(
  services: Services,
  cmd: LessonCommand,
): Promise<{ runId: string; deckId: string }> {
  const valid = LessonCommandSchema.parse(cmd);
  const subject = requireSubject(services, valid.subjectId);
  const topic = requireLatestTopic(services, valid.subjectId, valid.topicId);
  assertObjectivesInTopic(topic, valid.objectiveIds);
  // Tematy zdań mają sens tylko tam, gdzie przedmiot ma regułę ich użycia; odrzucenie przed kolejką.
  if (valid.interests !== undefined && subject.prompts.interestsRule === undefined) {
    throw new AppError("validation", { message: `subject does not support interests: ${subject.id}` });
  }

  const poolSize = valid.poolSize ?? defaultPoolSize(valid.objectiveIds.length);
  const title = lessonTitle(subject, topic, valid.instruction);

  return enqueueGenerationRun(services.db, `lesson:${valid.clientRequestId}`, async (tx) => {
      const deckId = valid.deckId ?? randomUUID();
      const versionId = randomUUID();
      const runId = randomUUID();
      const context: LessonContext = {
        subjectId: subject.id,
        topicId: topic.id,
        topicVersion: topic.version,
        objectiveIds: [...valid.objectiveIds],
        poolSize,
        material: valid.material,
        ...(valid.instruction === undefined ? {} : { instruction: valid.instruction }),
        ...(valid.interests === undefined ? {} : { interests: [...valid.interests] }),
        examples: {},
        rejectedCount: 0,
      };
      await tx.insert(decks).values({ id: deckId, title, kind: "lesson" });
      await tx.insert(deckVersions).values({
        id: versionId,
        deckId,
        versionNumber: 1,
        editNumber: 1,
        state: "draft",
        title,
        sourceLocale: subject.promptLocale,
        targetLocale: subject.answerLocale,
        lessonContext: context as unknown as Record<string, unknown>,
      });
      const input: LessonRunInput = {
        deckId,
        deckVersionId: versionId,
        subjectId: subject.id,
        topicId: topic.id,
        topicVersion: topic.version,
        objectiveIds: [...valid.objectiveIds],
        poolSize,
        material: valid.material,
        ...(valid.instruction === undefined ? {} : { instruction: valid.instruction }),
        ...(valid.interests === undefined ? {} : { interests: [...valid.interests] }),
      };
      await tx.insert(generationRuns).values({
        id: runId,
        deckVersionId: versionId,
        expectedEditNumber: 1,
        kind: "lesson",
        dedupeKey: `lesson:${valid.clientRequestId}`,
        state: "queued",
        input: input as unknown as Record<string, unknown>,
      });
      return { runId, deckId };
  });
}

/**
 * Polecenie utworzenia zestawu z materiału rodzica (wspólne dla szkoły i
 * przedmiotów o stałym tytule). Tekst pochodzi z dokładnie jednego miejsca:
 * wklejonego `material` albo zapisanego źródła (`sourceMaterialId`), którego
 * tekst serwer kopiuje w transakcji tworzenia.
 */
export interface MaterialLessonInput {
  subjectId: string;
  /** Nazwa przedmiotu od rodzica; brak = tytuł przedmiotu z modułu (`subject.titlePl`). */
  subjectTitlePl?: string;
  topicTitlePl: string;
  material?: string | undefined;
  sourceMaterialId?: string | undefined;
  /** Rewizja treści źródła z podglądu rodzica; wymagana przy `sourceMaterialId`. */
  expectedSourceRevision?: number | undefined;
  instruction?: string;
  poolSize?: number;
  deckId?: string;
  clientRequestId: string;
}

/** Skąd pochodzi tekst zestawu: wklejony przez rodzica albo skopiowany z zapisanego źródła. */
type MaterialTextSource =
  | { kind: "pasted"; material: string }
  | { kind: "source"; sourceMaterialId: string; expectedBodyRevision: number };

/**
 * Dokładnie jedno z `material` / `sourceMaterialId`, a przy źródle także
 * `expectedSourceRevision` (i tylko przy nim); inaczej → `validation`.
 */
function materialTextSource(cmd: MaterialLessonInput): MaterialTextSource {
  if (cmd.material !== undefined && cmd.sourceMaterialId === undefined && cmd.expectedSourceRevision === undefined) {
    return { kind: "pasted", material: cmd.material };
  }
  if (cmd.sourceMaterialId !== undefined && cmd.material === undefined && cmd.expectedSourceRevision !== undefined) {
    return { kind: "source", sourceMaterialId: cmd.sourceMaterialId, expectedBodyRevision: cmd.expectedSourceRevision };
  }
  throw new AppError("validation", {
    message: "provide exactly one of material or sourceMaterialId (with expectedSourceRevision)",
  });
}

/**
 * Tekst zestawu w transakcji tworzenia. Ze źródła czyta go (razem z rewizją
 * treści) pod `FOR KEY SHARE`, sprawdza rewizję z podglądu rodzica i zwraca
 * pochodzenie do zapisu w `decks`; wklejony tekst nie ma pochodzenia.
 */
async function resolveMaterialText(
  tx: Tx,
  textSource: MaterialTextSource,
): Promise<{ material: string; origin?: { sourceMaterialId: string; bodyRevision: number } }> {
  if (textSource.kind === "pasted") {
    return { material: textSource.material };
  }
  const copied = await lockSourceMaterialForCopy(tx, textSource.sourceMaterialId, textSource.expectedBodyRevision);
  return { material: copied.body, origin: { sourceMaterialId: textSource.sourceMaterialId, bodyRevision: copied.bodyRevision } };
}

/**
 * Tworzenie zestawu z materiału rodzica: deck lekcji + szkic + run `lesson`
 * bez celów — zagadnienia wyprowadzi etap generacji z materiału i zapisze
 * w `lesson_context.dynamicTopic` oraz `objectiveIds` przy finalizacji runu.
 * Dotyczy przedmiotów z `buildDynamicTopic`; nazwę przedmiotu zapisuje tylko
 * wtedy, gdy podał ją rodzic (szkoła) — inaczej tytuł pochodzi z przedmiotu.
 *
 * Ze źródła (`sourceMaterialId`) tekst i rewizję treści czyta pierwsze
 * zapytanie transakcji tworzenia (`FOR KEY SHARE`, `lockSourceMaterialForCopy`);
 * transakcję otwiera `enqueueGenerationRun`, a jej treścią jest wywołanie
 * zwrotne poniżej. Tekst trafia do `lesson_context.material`
 * i `generation_runs.input.material` jako kopia, a
 * `decks.source_material_id/_revision` zapisują pochodzenie (rewizja treści
 * źródła, nie rewizja współbieżności). Po utworzeniu źródło nie jest już
 * czytane. Brak źródła → `not_found`; rewizja treści inna niż
 * `expectedSourceRevision` (tekst zmieniono po wyświetleniu podglądu) →
 * `conflict` z `LessonSourceChangedDetails`, bez zapisu. Ponowienie z tym samym
 * `clientRequestId` zwraca istniejący zestaw, zanim źródło zostanie odczytane
 * (`enqueueGenerationRun`), więc późniejsza edycja ani usunięcie źródła go nie
 * psują. Gdy wcześniejsze żądanie z tym samym kluczem zatwierdziło zestaw już
 * po naszym sprawdzeniu klucza, a źródło usunięto albo zmieniono przed naszą
 * blokadą, wynikiem jest zestaw tamtego żądania.
 */
export async function createMaterialLesson(
  services: Services,
  cmd: MaterialLessonInput,
): Promise<{ runId: string; deckId: string }> {
  const subject = requireSubject(services, cmd.subjectId);
  if (materialCreationMode(subject) === undefined) {
    throw new AppError("validation", { message: `subject does not create lessons from material: ${subject.id}` });
  }
  const textSource = materialTextSource(cmd);
  const poolSize = cmd.poolSize ?? 60;
  const title = [...`${cmd.subjectTitlePl ?? subject.titlePl}: ${cmd.topicTitlePl}`].slice(0, 120).join("");
  const dedupeKey = `lesson:${cmd.clientRequestId}`;

  return enqueueGenerationRun(services.db, dedupeKey, async (tx) => {
    // Pierwsze zapytanie transakcji: blokada źródła poprzedza każdy zapis zestawu.
    const { material, origin } = await resolveMaterialText(tx, textSource);
    const deckId = cmd.deckId ?? randomUUID();
    const versionId = randomUUID();
    const runId = randomUUID();
    const context: LessonContext = {
      subjectId: subject.id,
      topicId: "dynamic",
      topicVersion: 1,
      objectiveIds: [],
      poolSize,
      material,
      ...(cmd.instruction === undefined ? {} : { instruction: cmd.instruction }),
      ...(cmd.subjectTitlePl === undefined ? {} : { subjectTitlePl: cmd.subjectTitlePl }),
      examples: {},
      rejectedCount: 0,
    };
    await tx.insert(decks).values({
      id: deckId,
      title,
      kind: "lesson",
      ...(origin === undefined ? {} : { sourceMaterialId: origin.sourceMaterialId, sourceMaterialRevision: origin.bodyRevision }),
    });
    await tx.insert(deckVersions).values({
      id: versionId,
      deckId,
      versionNumber: 1,
      editNumber: 1,
      state: "draft",
      title,
      sourceLocale: subject.promptLocale,
      targetLocale: subject.answerLocale,
      lessonContext: context as unknown as Record<string, unknown>,
    });
    const input: LessonRunInput = {
      deckId,
      deckVersionId: versionId,
      subjectId: subject.id,
      topicId: "dynamic",
      topicVersion: 1,
      objectiveIds: [],
      poolSize,
      material,
      ...(cmd.instruction === undefined ? {} : { instruction: cmd.instruction }),
      ...(cmd.subjectTitlePl === undefined ? {} : { subjectTitlePl: cmd.subjectTitlePl }),
      topicTitlePl: cmd.topicTitlePl,
    };
    await tx.insert(generationRuns).values({
      id: runId,
      deckVersionId: versionId,
      expectedEditNumber: 1,
      kind: "lesson",
      dedupeKey,
      state: "queued",
      input: input as unknown as Record<string, unknown>,
    });
    return { runId, deckId };
  }).catch((error: unknown) => {
    // Ponowienie po równoległym usunięciu albo zmianie tekstu źródła zwraca zestaw
    // pierwszego żądania (wspólne ze słówkami ze źródła); wklejony tekst — bez tego.
    if (textSource.kind === "source") {
      return committedRetryAfterSourceChange(services.db, dedupeKey, error);
    }
    throw error;
  });
}

/**
 * Tworzenie zestawu przedmiotu szkolnego: rodzic nazywa przedmiot własnym
 * tytułem, a zestaw powstaje z materiału (`createMaterialLesson`).
 */
export async function createSchoolLesson(
  services: Services,
  cmd: SchoolLessonCommand,
): Promise<{ runId: string; deckId: string }> {
  const valid = SchoolLessonCommandSchema.parse(cmd);
  return createMaterialLesson(services, { ...valid, subjectId: "school" });
}

/**
 * Tworzenie zestawu z materiału dla przedmiotu o stałym tytule (np. „Angielski
 * — rozdział”): rodzic podaje tytuł tematu i materiał, bez nazwy przedmiotu.
 * Przedmiot bez tematów dynamicznych albo z nazwą od rodzica (szkoła) to
 * `validation` — szkoła ma własne polecenie.
 */
export async function createLessonFromMaterial(
  services: Services,
  cmd: MaterialLessonCommand,
): Promise<{ runId: string; deckId: string }> {
  const valid = MaterialLessonCommandSchema.parse(cmd);
  const subject = requireSubject(services, valid.subjectId);
  if (materialCreationMode(subject) !== "fixed") {
    throw new AppError("validation", { message: `subject does not create lessons from parent material: ${subject.id}` });
  }
  return createMaterialLesson(services, valid);
}

/**
 * Rozkład liczby ćwiczeń celu na etapy wg `stageMix` (sumuje do `count`).
 * Reszta z zaokrągleń trafia do etapu produktywnego (największy udział).
 */
export function splitStages(count: number, mix: StageMix = DEFAULT_LESSON_POLICY.stageMix): LlmLessonStageCounts {
  const guided = Math.round(count * mix.guided);
  const independent = Math.round(count * mix.independent);
  const productive = Math.max(0, count - guided - independent);
  return { guided, productive, independent };
}

/** Publikacja zestawu v3 wymaga tylu różnych pytań otwartych na zagadnienie. */
export const DISTINCT_OPEN_ANSWERS_PER_OBJECTIVE = 2;

/**
 * Podział partii na etapy dla jednego celu. Rachunek dzieli etap samodzielny
 * z pytaniami otwartymi, a te mają twarde minimum publikacji — gdy etap
 * samodzielny ma tylko tyle miejsc, ile wynosi minimum, jedno miejsce przechodzi
 * z etapu produktywnego (o ile ten zachowa swoje minimum). Budżet partii bez zmian.
 */
export function poolStageCounts(
  subject: SubjectModule,
  objectiveTypes: readonly LessonExerciseType[],
  count: number,
): LlmLessonStageCounts {
  const split = splitStages(count);
  const minimums = subject.poolMinimums ?? DEFAULT_LESSON_POLICY.poolMinimums;
  if (!objectiveTypes.includes("lesson_calculation") || split.independent > minimums.independent) return split;
  if (split.productive - 1 < minimums.productive) return split;
  return { ...split, productive: split.productive - 1, independent: split.independent + 1 };
}

function meetsStageMinimums(count: number, subject: SubjectModule): boolean {
  const minimums = subject.poolMinimums ?? DEFAULT_LESSON_POLICY.poolMinimums;
  const split = splitStages(count);
  return split.guided >= minimums.guided && split.productive >= minimums.productive && split.independent >= minimums.independent;
}

/**
 * Najmniejsza liczba ćwiczeń celu, której podział na etapy spełnia minima
 * KAŻDEGO etapu pokrycia przedmiotu — sama suma minimów nie wystarcza, bo
 * zaokrąglenia miksu potrafią dać np. independent=1 przy minimum 2 (pula
 * strukturalnie niepublikowalna mimo idealnej odpowiedzi modelu).
 */
export function minimumCountPerObjective(subject: SubjectModule): number {
  const minimums = subject.poolMinimums ?? DEFAULT_LESSON_POLICY.poolMinimums;
  let count = minimums.guided + minimums.productive + minimums.independent;
  while (!meetsStageMinimums(count, subject)) count += 1;
  return count;
}

/**
 * Liczby ćwiczeń partii per cel. Zamówiona pula dzieli się dokładnie (część
 * całkowita + reszta), więc suma partii jej nie przekracza. Wyjątek: gdy pula
 * jest mniejsza niż (liczba celów × minimum publikacji), każdy cel dostaje
 * minimum — inaczej szkic byłby niepublikowalny; nadwyżkę loguje wywołujący.
 */
export function objectiveBatchCounts(poolSize: number, objectiveCount: number, subject: SubjectModule): number[] {
  const objectives = Math.max(1, objectiveCount);
  const total = Math.max(poolSize, minimumCountPerObjective(subject) * objectives);
  const base = Math.floor(total / objectives);
  const remainder = total % objectives;
  return Array.from({ length: objectives }, (_, index) => {
    let count = base + (index < remainder ? 1 : 0);
    while (!meetsStageMinimums(count, subject)) count += 1;
    return count;
  });
}

/** Partie pełnej generacji; nadwyżkę ponad zamówioną pulę (minimum publikacji) zapisuje w logu. */
function batchesForObjectives(
  objectiveIds: readonly string[],
  poolSize: number,
  subject: SubjectModule,
  runId: string,
): { objectiveId: string; count: number; existingAnswers: string[]; existingExercises: LessonExerciseStimulus[] }[] {
  const counts = objectiveBatchCounts(poolSize, objectiveIds.length, subject);
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total > poolSize) {
    console.log(`[lesson] run=${runId} pula podniesiona do minimum publikacji: ${total} zamiast ${poolSize} (cele=${objectiveIds.length})`);
  }
  return objectiveIds.map((objectiveId, index) => ({ objectiveId, count: counts[index]!, existingAnswers: [], existingExercises: [] }));
}

/** Najwięcej ćwiczeń `lesson_listen_choice` na cel w szkicu — dodatek ponad podział etapów (decyzja #198). */
const LISTEN_CHOICE_PER_OBJECTIVE = 2;

/**
 * Ile ćwiczeń słuchowych generator może jeszcze dodać do celu: limit na cel minus ćwiczenia
 * słuchowe tego celu już w szkicu (dogenerowanie) i we wcześniejszych partiach runu. 0, gdy
 * przedmiot nie nagrywa zdań albo typ nie leży na liście celu.
 */
export function listenChoiceAllowance(
  subject: SubjectModule,
  objective: { id: string; exerciseTypes: readonly string[] },
  existingExercises: readonly LessonExerciseStimulus[],
): number {
  if (!subject.ttsForFeedbackSentence || !subject.exerciseTypes.includes("lesson_listen_choice") || !objective.exerciseTypes.includes("lesson_listen_choice")) {
    return 0;
  }
  const existing = existingExercises.filter((exercise) => exercise.objectiveId === objective.id && exercise.exerciseType === "lesson_listen_choice").length;
  return Math.max(0, LISTEN_CHOICE_PER_OBJECTIVE - existing);
}

/** Limity jednego celu w runie: zamówiona liczba ćwiczeń etapów i przyznany dodatek słuchowy. */
export interface ObjectiveGenerationLimits {
  readonly count: number;
  readonly listen: number;
}

/**
 * Egzekwuje dodatek słuchowy po walidacji: na cel najwyżej `listen` nowych ćwiczeń
 * `lesson_listen_choice`, a gdy dodatek przyznano (`listen > 0`), najwyżej `count` pozostałych —
 * podniesiony w prompcie limit partii nie może dać dodatkowych ćwiczeń etapów. Zachowuje
 * pierwsze wystąpienia (kolejność wejścia); nadmiar wraca jako odrzucenia z powodem.
 */
export function capListenChoiceOverflow(
  exercises: readonly LessonExerciseDraft[],
  limits: ReadonlyMap<string, ObjectiveGenerationLimits>,
): { kept: LessonExerciseDraft[]; rejected: { exercise: LessonExerciseDraft; errors: string[] }[] } {
  const listenSeen = new Map<string, number>();
  const otherSeen = new Map<string, number>();
  const kept: LessonExerciseDraft[] = [];
  const rejected: { exercise: LessonExerciseDraft; errors: string[] }[] = [];
  for (const exercise of exercises) {
    const limit = limits.get(exercise.objectiveId);
    if (exercise.exerciseType === "lesson_listen_choice") {
      const seen = listenSeen.get(exercise.objectiveId) ?? 0;
      const allowed = limit?.listen ?? 0;
      if (seen >= allowed) {
        rejected.push({ exercise, errors: [`exerciseType: ponad limit ${LISTEN_CHOICE_PER_OBJECTIVE} ćwiczeń „lesson_listen_choice” na regułę (wolne miejsca: ${allowed})`] });
        continue;
      }
      listenSeen.set(exercise.objectiveId, seen + 1);
    } else if (limit !== undefined && limit.listen > 0) {
      const seen = otherSeen.get(exercise.objectiveId) ?? 0;
      if (seen >= limit.count) {
        rejected.push({ exercise, errors: [`exerciseType: ćwiczenie ponad zamówioną liczbę ${limit.count} dla reguły`] });
        continue;
      }
      otherSeen.set(exercise.objectiveId, seen + 1);
    }
    kept.push(exercise);
  }
  return { kept, rejected };
}

/** Składa `LessonPoolInput` dla jednego celu z danych rejestru (port nie zna przedmiotu). */
export function buildPoolInput(
  subject: SubjectModule,
  topic: LessonTopic,
  objectiveId: string,
  count: number,
  material: string,
  instruction: string | undefined,
  graderAvailable: boolean,
  existingAnswers: readonly string[],
  existingExercises: readonly LessonExerciseStimulus[] = [],
  interests?: readonly string[],
): LessonPoolInput {
  // Tematy i reguła ich użycia idą do modelu razem albo wcale (reguła należy do przedmiotu).
  const interestsRule = subject.prompts.interestsRule;
  const withInterests = interestsRule !== undefined && interests !== undefined && interests.length > 0;
  const objective = topic.objectives.find((o) => o.id === objectiveId)!;
  const listenAllowance = listenChoiceAllowance(subject, objective, existingExercises);
  return {
    subjectId: subject.id,
    subjectTitle: subject.titlePl,
    answerLocale: subject.answerLocale,
    promptLocale: subject.promptLocale,
    promptProfile: {
      generationRole: subject.prompts.generationRole,
      gradingRole: subject.prompts.gradingRole,
      almostDefinition: subject.prompts.almostDefinition,
      ...(subject.prompts.fieldRules === undefined ? {} : { fieldRules: subject.prompts.fieldRules }),
      ...(subject.prompts.typeRules === undefined ? {} : { typeRules: subject.prompts.typeRules }),
      ...(withInterests ? { interestsRule } : {}),
    },
    exerciseTypes: [...subject.exerciseTypes],
    transforms: topic.transforms.map((t) => ({ id: t.id, instructionPl: t.instructionPl })),
    objectives: [
      {
        id: objective.id,
        descriptionEn: objective.descriptionEn,
        exerciseTypes: [...objective.exerciseTypes],
        errorCategories: [...objective.errorCategories],
      },
    ],
    material,
    ...(instruction === undefined ? {} : { instruction }),
    ...(withInterests ? { interests: [...interests] } : {}),
    countPerObjective: count,
    stageCounts: poolStageCounts(subject, objective.exerciseTypes, count),
    // Wybór ze słuchu to dodatek poza podziałem etapów i liczbą partii: tylko przedmiot z nagraniami zdań
    // i cel, którego lista zawiera typ, pomniejszony o ćwiczenia słuchowe celu już w szkicu/partiach.
    ...(listenAllowance > 0 ? { listenChoicePerObjective: listenAllowance } : {}),
    ...(subject.usesV3Payload === true ? { minDistinctOpenAnswers: DISTINCT_OPEN_ANSWERS_PER_OBJECTIVE } : {}),
    graderAvailable,
    groundingRequired: subject.sourceQuotes === true,
    deduplication: subject.poolDeduplication ?? "answer",
    voiceTones: subject.ttsForPrompts === true,
    ...(existingAnswers.length > 0 ? { existingAnswers: [...existingAnswers] } : {}),
    ...(existingExercises.length > 0 ? { existingExercises: [...existingExercises] } : {}),
  };
}

/**
 * Ton lektora z niezaufanego wyjścia modelu: nieznana wartość albo `null`
 * znaczą „brak tonu” (styl domyślny roli), nigdy błąd ćwiczenia/karty.
 */
function sanitizedVoiceTone(raw: unknown): { voiceTone?: LessonVoiceTone } {
  const parsed = LessonVoiceToneSchema.safeParse(raw);
  return parsed.success ? { voiceTone: parsed.data } : {};
}

/**
 * Ton lektora ma sens tylko dla przedmiotu z nagraniami pytań (`ttsForPrompts`).
 * Luźny dostawca mógłby go dopisać do ćwiczeń innego przedmiotu — wtedy pole
 * jest po prostu odrzucane, a ćwiczenie nie przepada na walidacji puli. Tylko
 * wyjście modelu: rodzic może zapisać dowolny ton z kontraktu.
 */
export function withoutVoiceToneUnlessAllowed(draft: LessonExerciseDraft, subject: Pick<SubjectModule, "ttsForPrompts">): LessonExerciseDraft {
  if (draft.voiceTone === undefined) return draft;
  // `mysterious` w ćwiczeniu z modelu → `curious`, jak brzmi nagranie (pytania nie są szeptane,
  // spec tonu TTS §4.3) — edytor nie pokaże „Tajemniczo” przy nagraniu brzmiącym „z ciekawością”.
  if (subject.ttsForPrompts === true) return draft.voiceTone === "mysterious" ? { ...draft, voiceTone: "curious" } : draft;
  const { voiceTone: _dropped, ...rest } = draft;
  return rest;
}

const rawObjectiveSchema = z
  .object({
    slug: z.string(),
    titlePl: z.string(),
    descriptionEn: z.string(),
    // Strict structured output zwraca `kind` zawsze (`null` = brak rodzaju); nieznana wartość to brak rodzaju, nie błąd kształtu.
    kind: z.unknown().optional(),
    cards: z.array(z.object({ title: z.string(), body: z.string() }).passthrough()),
  })
  .passthrough();

/** Slug celu dynamicznego z surowego sluga modelu: ASCII, unikalny w zestawie. */
function sanitizeObjectiveSlug(raw: string, index: number, used: Set<string>): string {
  const base = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    // Runs are already collapsed to one "_", so trimming one per end is enough (no backtracking).
    .replace(/^_/, "")
    .replace(/_$/, "")
    .slice(0, 40);
  const root = base.length > 0 ? base : `zagadnienie_${index + 1}`;
  // A suffixed slug can itself be taken (e.g. "a", "a_3", "a"), so keep counting.
  let slug = root;
  for (let n = index + 1; used.has(slug); n += 1) slug = `${root}_${n}`;
  used.add(slug);
  return slug;
}

/**
 * Składa `DynamicTopicData` z surowych zagadnień modelu: identyfikatory celów
 * `<subjectId>.d<deckId>.<slug>` nadaje serwer (prefiks to identyfikator
 * przedmiotu, np. `school.d…`). Rodzaj zagadnienia (`kind`) przechodzi tylko
 * jako `words`/`frame`; `null`, brak i nieznana wartość dają brak pola.
 * Rekordy o złym kształcie albo niespełniające reguł przedmiotu
 * (`validateObjective`, np. 2–4 karty, niepuste teksty) są odrzucane
 * pojedynczo — jedno wadliwe zagadnienie nie przerywa całej generacji; zero
 * poprawnych celów zwraca błędy zamiast danych.
 */
export function buildDynamicTopicData(
  rawObjectives: unknown[],
  subjectId: string,
  deckId: string,
  topicTitle: string,
  validateObjective: (objective: DynamicTopicData["objectives"][number]) => string[] = () => [],
  allowVoiceTone = true,
): { data?: DynamicTopicData; errors: string[] } {
  const errors: string[] = [];
  const used = new Set<string>();
  const objectives: DynamicTopicData["objectives"][number][] = [];
  rawObjectives.slice(0, 8).forEach((raw, index) => {
    const parsed = rawObjectiveSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push(`zagadnienie ${index + 1}: zły kształt`);
      return;
    }
    const slug = sanitizeObjectiveSlug(parsed.data.slug || parsed.data.titlePl, index, used);
    const kind = parsed.data.kind === "words" || parsed.data.kind === "frame" ? parsed.data.kind : undefined;
    const objective: DynamicTopicData["objectives"][number] = {
      id: `${subjectId}.d${deckId}.${slug}`,
      titlePl: [...parsed.data.titlePl.trim()].slice(0, 120).join(""),
      descriptionEn: [...parsed.data.descriptionEn.trim()].slice(0, 400).join(""),
      cards: parsed.data.cards.slice(0, 4).map((card) => ({
        title: [...card.title.trim()].slice(0, 120).join(""),
        body: [...card.body.trim()].slice(0, 1200).join(""),
        ...(allowVoiceTone ? sanitizedVoiceTone(card.voiceTone) : {}),
      })),
      ...(kind === undefined ? {} : { kind }),
    };
    const objectiveErrors = validateObjective(objective);
    if (objectiveErrors.length > 0) {
      errors.push(`zagadnienie ${index + 1}: ${objectiveErrors.join("; ")}`);
      return;
    }
    objectives.push(objective);
  });
  if (rawObjectives.length > 8) {
    errors.push(`pominięto ${rawObjectives.length - 8} zagadnień ponad limit 8`);
  }
  if (objectives.length === 0) {
    return { errors: errors.length > 0 ? errors : ["model nie zwrócił żadnego zagadnienia"] };
  }
  return { data: { titlePl: topicTitle, objectives }, errors };
}

/**
 * Generacja jest niezaufanym źródłem: flaga `parentAdded` (źródło rodzica)
 * może pochodzić wyłącznie z edycji rodzica, nie z wyjścia modelu. Przyjęcie
 * puli usuwa ją z każdego cytatu, zanim walidacja uziemienia ją zobaczy.
 */
export function stripParentAddedFlags(drafts: readonly LessonExerciseDraft[]): LessonExerciseDraft[] {
  return drafts.map((draft) =>
    draft.sourceRefs === undefined
      ? draft
      : { ...draft, sourceRefs: draft.sourceRefs.map((ref) => ({ quote: ref.quote })) },
  );
}
/**
 * Strict structured output każe modelowi zwrócić każde pole, także pola innych
 * typów ćwiczeń (np. `options` w luce, `noticeSegments` w wyborze, pola v3
 * w gramatyce). Pusta tablica znaczy tam „brak” (jak `null`), więc nie może
 * odrzucać ćwiczenia przez minimum kontraktu ani trafiać do payloadu.
 * Braki naprawdę wymagane (opcje wyboru, klocki, cytat, elementy odpowiedzi
 * otwartej) nadal zgłasza walidacja typu i przedmiotu.
 */
const OPTIONAL_ARRAY_FIELDS = [
  "options", "items", "noticeSegments",
  "requiredElements", "supplementaryElements", "commonErrors", "sourceRefs",
] as const;

export function withoutEmptyOptionalArrays(draft: LessonExerciseDraft): LessonExerciseDraft {
  const out: LessonExerciseDraft = { ...draft };
  for (const field of OPTIONAL_ARRAY_FIELDS) {
    const value = out[field];
    if (Array.isArray(value) && value.length === 0) delete out[field];
  }
  return out;
}

/**
 * Dogenerowanie to osobne wywołanie modelu, który nie zna rodzin już zapisanych
 * w szkicu: slug zbieżny z istniejącą rodziną dołączyłby nowe pytanie (z inną
 * odpowiedzią wzorcową) do starej rodziny i zablokował publikację. Rodziny
 * nowej partii dostają więc sufiks runu i pozostają wewnątrz niej.
 */
export function scopeFamiliesToRun(draft: LessonExerciseDraft, runId: string): LessonExerciseDraft {
  const suffix = `-r${runId.replace(/[^0-9a-f]/gi, "").slice(0, 6).toLowerCase()}`;
  // Cut before the suffix without leaving a dangling "-" (templateFamilyId is a strict slug).
  const scoped = (slug: string) => {
    let base = slug.slice(0, 64 - suffix.length);
    while (base.endsWith("-")) base = base.slice(0, -1);
    return `${base}${suffix}`;
  };
  const templateFamilyId = draft.calculation?.templateFamilyId;
  return {
    ...draft,
    ...(draft.familyId ? { familyId: scoped(draft.familyId) } : {}),
    ...(draft.calculation && typeof templateFamilyId === "string"
      ? { calculation: { ...draft.calculation, templateFamilyId: scoped(templateFamilyId) } }
      : {}),
  };
}

/** Dzieli szkice wg walidacji puli z materiałem przedmiotu (uziemienie itp.). */
export function splitByPoolExtra(
  subject: SubjectModule,
  drafts: readonly LessonExerciseDraft[],
  material: string,
): { kept: LessonExerciseDraft[]; extraRejected: { exercise: LessonExerciseDraft; errors: string[] }[] } {
  if (!subject.validatePoolExtra) return { kept: [...drafts], extraRejected: [] };
  const extra = subject.validatePoolExtra(drafts, { material });
  const kept: LessonExerciseDraft[] = [];
  const extraRejected: { exercise: LessonExerciseDraft; errors: string[] }[] = [];
  drafts.forEach((draft, index) => {
    const errs = extra.get(index);
    if (errs && errs.length > 0) extraRejected.push({ exercise: draft, errors: [...errs] });
    else kept.push(draft);
  });
  return { kept, extraRejected };
}

/**
 * Czyści świeżo wygenerowaną pulę hakiem przedmiotu `refineGeneratedPool` i
 * zlicza odrzucenia po powodzie (dla panelu rodzica; powody bez danych dziecka).
 * Wołana wyłącznie w generacji (także dogenerowaniu) — nie przy edycji rodzica
 * ani publikacji. Przedmiot bez haka zwraca pulę bez zmian i bez zliczeń.
 */
export function refineGeneratedDrafts(
  subject: SubjectModule,
  drafts: readonly LessonExerciseDraft[],
  material: string,
): { kept: LessonExerciseDraft[]; rejectedCount: number; rejectedReasons: Record<string, number> } {
  if (!subject.refineGeneratedPool) return { kept: [...drafts], rejectedCount: 0, rejectedReasons: {} };
  const refined = subject.refineGeneratedPool(drafts, { material });
  const counts = new Map<string, number>();
  for (const { reason } of refined.rejected) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return { kept: refined.kept, rejectedCount: refined.rejected.length, rejectedReasons: Object.fromEntries(counts) };
}

/**
 * Sumuje liczniki powodów odrzuceń (kolejne przebiegi generacji tej samej
 * wersji). Powód pochodzi od przedmiotu (pośrednio z wyjścia modelu), więc
 * liczymy w `Map`, a obiekt składa `Object.fromEntries` (własne pola): powód
 * „constructor”, „toString” czy „__proto__” nie czyta ani nie podmienia
 * prototypu zwykłego obiektu.
 */
export function sumRejectedReasons(
  previous: Readonly<Record<string, number>> | undefined,
  added: Readonly<Record<string, number>>,
): Record<string, number> {
  const total = new Map<string, number>(Object.entries(previous ?? {}));
  for (const [reason, count] of Object.entries(added)) total.set(reason, (total.get(reason) ?? 0) + count);
  return Object.fromEntries(total);
}

/**
 * Rodzaj zagadnienia (`kind`) zapisuje tylko przedmiot, który z niego korzysta
 * (ma `prompts.objectivesRules`); dla pozostałych (np. szkoły) pole nigdy nie
 * trafia do `dynamicTopic`, nawet gdy model je zwrócił.
 */
export function withSubjectObjectiveKinds(subject: SubjectModule, data: DynamicTopicData): DynamicTopicData {
  if (subject.prompts.objectivesRules !== undefined) return data;
  return {
    ...data,
    objectives: data.objectives.map(({ kind: _kind, ...objective }) => objective),
  };
}

/** Wersja payloadu rewizji: 3, gdy ćwiczenie niesie pola v3, inaczej 2. */
export function lessonPayloadVersion(ex: LessonExerciseDraft, subject: SubjectModule): number {
  if (subject.usesV3Payload !== true) return 2;
  return ex.questionType !== undefined || ex.requiredElements !== undefined ||
    ex.supplementaryElements !== undefined || ex.commonErrors !== undefined ||
    ex.expectedForm !== undefined || ex.familyId !== undefined || ex.sourceRefs !== undefined || ex.calculation !== undefined
    ? 3
    : 2;
}
/**
 * Schemat KSZTAŁTU surowego ćwiczenia z portu (nie semantyki). Chroni dalszą
 * walidację semantyczną (`validatePool`) przed rekordami, których tablice mają
 * zły typ elementów (np. `options=[null,{…}]`) — bez tego `validateOptions`
 * dereferencuje `null.text` i rzuca `TypeError`, wywracając cały run zamiast
 * odrzucić jeden rekord (wymóg 2.5). Sprawdzamy tylko to, co faza semantyczna
 * dereferencuje: elementy `options`/`items` muszą być `{id,text}`, a
 * `noticeSegments` musi być tablicą tablic napisów. Pozostałe pola pozostają
 * domeną `validateLessonExercise`. `passthrough` — nie odrzucamy pól dodatkowych.
 *
 * Pola opcjonalne są `nullish`, bo structured outputs (json_schema strict)
 * zwraca KAŻDE pole schematu, z `null` dla nie dotyczących typu — brak pola
 * i jawny `null` muszą przejść tak samo (`toExerciseDraft` nulla pomija).
 */
const optionShapeSchema = z.object({ id: z.string(), text: z.string() }).passthrough();
const rawExerciseShapeSchema = z
  .object({
    exerciseType: z.string(),
    objectiveId: z.string(),
    answer: z.string(),
    acceptedAnswers: z.array(z.string()).nullish(),
    focus: z.array(z.string()).nullish(),
    instructionPl: z.string().nullish(),
    stem: z.string().nullish(),
    statement: z.string().nullish(),
    prompt: z.string().nullish(),
    hint: z.string().nullish(),
    transformId: z.string().nullish(),
    correctOption: z.string().nullish(),
    options: z.array(optionShapeSchema).nullish(),
    items: z.array(optionShapeSchema).nullish(),
    keywordOptions: z.array(optionShapeSchema).nullish(),
    keyOptionIds: z.array(z.string()).nullish(),
    noticeSegments: z.array(z.array(z.string())).nullish(),
    pairs: z.array(z.object({ left: z.string(), right: z.string() }).passthrough()).nullish(),
    extraRight: z.array(z.string()).nullish(),
    groups: z.array(z.object({ id: z.string(), label: z.string() }).passthrough()).nullish(),
    groupItems: z.array(z.object({ text: z.string(), groupId: z.string() }).passthrough()).nullish(),
    clozeText: z.string().nullish(),
    gapAnswers: z.array(z.string()).nullish(),
    extraWords: z.array(z.string()).nullish(),
  })
  .passthrough();

/**
 * Czy surowy obiekt ma bezpieczny KSZTAŁT do walidacji semantycznej. Rekord o
 * złym kształcie jest odrzucany (liczony do `rejectedCount`), nie rzuca. Nie
 * maskuje realnych błędów treści — sprawdza wyłącznie kształt pól tablicowych,
 * które faza semantyczna dereferencuje.
 */
export function isWellShapedRawExercise(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object") {
    return false;
  }
  return rawExerciseShapeSchema.safeParse(raw).success;
}

export function collectBatchExerciseMetadata(
  exercises: unknown[],
  deduplicateByExercise: boolean,
  identityOptions: LessonExerciseIdentityOptions = {},
): {
  answers: string[];
  exerciseRecords: LessonExerciseStimulus[];
} {
  const answers: string[] = [];
  const exerciseRecords: LessonExerciseStimulus[] = [];
  for (const exercise of exercises) {
    if (!isWellShapedRawExercise(exercise)) continue;
    const answer = (exercise as { answer?: unknown }).answer;
    if (typeof answer === "string" && answer.trim() !== "") answers.push(answer);
    if (deduplicateByExercise) {
      exerciseRecords.push(lessonExerciseStimulusRecord(toExerciseDraft(exercise), identityOptions));
    }
  }
  return { answers, exerciseRecords };
}

export function filterExercisesToRequestedObjective(exercises: unknown[], objectiveId: string): {
  exercises: unknown[];
  outOfScopeCount: number;
} {
  const accepted: unknown[] = [];
  let outOfScopeCount = 0;
  for (const exercise of exercises) {
    const returnedObjective = exercise && typeof exercise === "object"
      ? (exercise as { objectiveId?: unknown }).objectiveId
      : undefined;
    if (typeof returnedObjective === "string" && returnedObjective !== objectiveId) outOfScopeCount += 1;
    else accepted.push(exercise);
  }
  return { exercises: accepted, outOfScopeCount };
}

export function summarizeLessonPoolValidation(input: {
  rawCount: number;
  shapeRejected: number;
  outOfScopeCount: number;
  rejectedExerciseCount: number;
  rejectedErrors: readonly string[];
  duplicateCount: number;
  validCount: number;
  /** Odrzucone przez `refineGeneratedPool` (nie niosą reguł walidacji puli). */
  refineRejected?: number;
}): string {
  const ruleCounts = new Map<string, number>();
  for (const error of input.rejectedErrors) {
    const rule = /^([a-z][a-z0-9_]*):/i.exec(error)?.[1] ?? "other";
    ruleCounts.set(rule, (ruleCounts.get(rule) ?? 0) + 1);
  }
  const refineRejected = input.refineRejected ?? 0;
  if (refineRejected > 0) ruleCounts.set("czyszczenie", refineRejected);
  const reasons = [...ruleCounts.entries()].map(([rule, count]) => `${rule}×${count}`).join(", ") || "-";
  const rejected = input.shapeRejected + input.outOfScopeCount + input.rejectedExerciseCount + input.duplicateCount + refineRejected;
  return `surowe=${input.rawCount} zły_kształt=${input.shapeRejected} obcy_cel=${input.outOfScopeCount} odrzucone=${rejected} ważne=${input.validCount}; reguły: ${reasons}`;
}

/** Sanityzacja pól v3 surowego ćwiczenia: tylko poprawnie uformowane wpisy. */
function v3FieldsOf(r: Record<string, unknown>): Partial<LessonExerciseDraft> {
  const out: Record<string, unknown> = {};
  if (typeof r.questionType === "string") out.questionType = r.questionType;
  if (Array.isArray(r.requiredElements)) {
    out.requiredElements = r.requiredElements.filter(
      (el): el is { id: string; text: string } =>
        el !== null && typeof el === "object" && typeof (el as { id?: unknown }).id === "string" && typeof (el as { text?: unknown }).text === "string",
    );
  }
  if (Array.isArray(r.supplementaryElements)) {
    out.supplementaryElements = r.supplementaryElements.filter((el): el is string => typeof el === "string");
  }
  if (Array.isArray(r.commonErrors)) {
    out.commonErrors = r.commonErrors.filter((el): el is string => typeof el === "string");
  }
  if (typeof r.expectedForm === "string") out.expectedForm = r.expectedForm;
  if (typeof r.familyId === "string") out.familyId = r.familyId;
  Object.assign(out, sanitizedVoiceTone(r.voiceTone));
  if (Array.isArray(r.keywordOptions)) {
    out.keywordOptions = r.keywordOptions.filter(
      (el): el is { id: string; text: string } =>
        el !== null && typeof el === "object" && typeof (el as { id?: unknown }).id === "string" && typeof (el as { text?: unknown }).text === "string",
    ).map((el) => ({ id: el.id, text: el.text }));
  }
  if (Array.isArray(r.keyOptionIds)) out.keyOptionIds = r.keyOptionIds.filter((id): id is string => typeof id === "string");
  // Pary i grupy (design szkoły §10): tylko poprawnie uformowane wpisy, bez pól dodatkowych.
  const has = (value: unknown, fields: readonly string[]) => value !== null && typeof value === "object" &&
    fields.every((field) => typeof (value as Record<string, unknown>)[field] === "string");
  if (Array.isArray(r.pairs)) {
    out.pairs = r.pairs.filter((pair) => has(pair, ["left", "right"]))
      .map((pair) => ({ left: (pair as { left: string }).left, right: (pair as { right: string }).right }));
  }
  if (Array.isArray(r.extraRight)) out.extraRight = r.extraRight.filter((text): text is string => typeof text === "string");
  if (Array.isArray(r.groups)) {
    out.groups = r.groups.filter((group) => has(group, ["id", "label"]))
      .map((group) => ({ id: (group as { id: string }).id, label: (group as { label: string }).label }));
  }
  if (Array.isArray(r.groupItems)) {
    out.groupItems = r.groupItems.filter((item) => has(item, ["text", "groupId"]))
      .map((item) => ({ text: (item as { text: string }).text, groupId: (item as { groupId: string }).groupId }));
  }
  // Luki z bankiem (design szkoły §13).
  if (typeof r.clozeText === "string") out.clozeText = r.clozeText;
  if (Array.isArray(r.gapAnswers)) out.gapAnswers = r.gapAnswers.filter((text): text is string => typeof text === "string");
  if (Array.isArray(r.extraWords)) out.extraWords = r.extraWords.filter((text): text is string => typeof text === "string");
  // Preserve the submitted spec unchanged; subject validation rejects malformed
  // or inconsistent calculations instead of silently repairing parent input.
  if (r.calculation !== undefined && r.calculation !== null) out.calculation = r.calculation;
  if (Array.isArray(r.sourceRefs)) {
    out.sourceRefs = r.sourceRefs
      .filter(
        (ref): ref is { quote: string; parentAdded?: unknown } =>
          ref !== null && typeof ref === "object" && typeof (ref as { quote?: unknown }).quote === "string",
      )
      .map((ref) => ({ quote: ref.quote, ...(ref.parentAdded === true ? { parentAdded: true } : {}) }));
  }
  return out as Partial<LessonExerciseDraft>;
}
/** Surowy obiekt z portu → `LessonExerciseDraft` (walidacja kształtu w domenie). */
export function toExerciseDraft(raw: unknown): LessonExerciseDraft {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    exerciseType: r.exerciseType as LessonExerciseType,
    objectiveId: String(r.objectiveId ?? ""),
    ...(typeof r.instructionPl === "string" ? { instructionPl: r.instructionPl } : {}),
    ...(typeof r.stem === "string" ? { stem: r.stem } : {}),
    ...(typeof r.statement === "string" ? { statement: r.statement } : {}),
    ...(typeof r.prompt === "string" ? { prompt: r.prompt } : {}),
    ...(typeof r.hint === "string" ? { hint: r.hint } : {}),
    ...(typeof r.transformId === "string" ? { transformId: r.transformId } : {}),
    ...(Array.isArray(r.noticeSegments)
      ? { noticeSegments: r.noticeSegments as readonly (readonly string[])[] }
      : {}),
    ...(typeof r.visualSubject === "string" ? { visualSubject: r.visualSubject as LessonExerciseDraft["visualSubject"] } : {}),
    answer: String(r.answer ?? ""),
    acceptedAnswers: Array.isArray(r.acceptedAnswers) ? (r.acceptedAnswers as string[]) : [],
    focus: Array.isArray(r.focus) ? (r.focus as string[]) : [],
    ...(Array.isArray(r.options)
      ? { options: r.options as readonly { id: string; text: string }[] }
      : {}),
    ...(typeof r.correctOption === "string" ? { correctOption: r.correctOption } : {}),
    ...(Array.isArray(r.items)
      ? { items: r.items as readonly { id: string; text: string }[] }
      : {}),
    ...v3FieldsOf(r),
  };
}

/** Payload `lesson_exercise` (payload_version 2) z locale przedmiotu. */
export function buildLessonPayload(
  ex: LessonExerciseDraft,
  subject: SubjectModule,
): Record<string, unknown> {
  return {
    exerciseType: ex.exerciseType,
    objectiveId: ex.objectiveId,
    ...(ex.instructionPl === undefined ? {} : { instructionPl: ex.instructionPl }),
    ...(ex.stem === undefined ? {} : { stem: ex.stem }),
    ...(ex.statement === undefined ? {} : { statement: ex.statement }),
    ...(ex.prompt === undefined ? {} : { prompt: ex.prompt }),
    ...(ex.hint === undefined ? {} : { hint: ex.hint }),
    ...(ex.transformId === undefined ? {} : { transformId: ex.transformId }),
    ...(ex.noticeSegments === undefined ? {} : { noticeSegments: ex.noticeSegments }),
    ...(ex.visualSubject === undefined ? {} : { visualSubject: ex.visualSubject }),
    answer: ex.answer,
    acceptedAnswers: [...ex.acceptedAnswers],
    focus: [...ex.focus],
    ...(ex.options === undefined ? {} : { options: ex.options }),
    ...(ex.correctOption === undefined ? {} : { correctOption: ex.correctOption }),
    ...(ex.items === undefined ? {} : { items: ex.items }),
    ...(ex.questionType === undefined ? {} : { questionType: ex.questionType }),
    ...(ex.requiredElements === undefined ? {} : { requiredElements: ex.requiredElements }),
    ...(ex.supplementaryElements === undefined ? {} : { supplementaryElements: ex.supplementaryElements }),
    ...(ex.commonErrors === undefined ? {} : { commonErrors: ex.commonErrors }),
    ...(ex.expectedForm === undefined ? {} : { expectedForm: ex.expectedForm }),
    ...(ex.familyId === undefined ? {} : { familyId: ex.familyId }),
    ...(ex.voiceTone === undefined ? {} : { voiceTone: ex.voiceTone }),
    ...(ex.sourceRefs === undefined ? {} : { sourceRefs: ex.sourceRefs }),
    ...(ex.calculation === undefined ? {} : { calculation: ex.calculation }),
    ...(ex.keywordOptions === undefined ? {} : { keywordOptions: ex.keywordOptions.map((option) => ({ id: option.id, text: option.text })) }),
    ...(ex.keyOptionIds === undefined ? {} : { keyOptionIds: [...ex.keyOptionIds] }),
    ...(ex.pairs === undefined ? {} : { pairs: ex.pairs.map((pair) => ({ left: pair.left, right: pair.right })) }),
    ...(ex.extraRight === undefined ? {} : { extraRight: [...ex.extraRight] }),
    ...(ex.groups === undefined ? {} : { groups: ex.groups.map((group) => ({ id: group.id, label: group.label })) }),
    ...(ex.groupItems === undefined ? {} : { groupItems: ex.groupItems.map((item) => ({ text: item.text, groupId: item.groupId })) }),
    ...(ex.clozeText === undefined ? {} : { clozeText: ex.clozeText }),
    ...(ex.gapAnswers === undefined ? {} : { gapAnswers: [...ex.gapAnswers] }),
    ...(ex.extraWords === undefined ? {} : { extraWords: [...ex.extraWords] }),
    answerLocale: subject.answerLocale,
    promptLocale: subject.promptLocale,
  };
}

/** criteria dla umiejętności `objective` (design „Data Models”). */
export function buildObjectiveCriteria(
  ex: LessonExerciseDraft,
  subject: SubjectModule,
  topicVersion: number,
): { criteria: Record<string, unknown>; criteriaHash: string } {
  const acceptedAnswersHash = createHash("sha256")
    .update(JSON.stringify([...ex.acceptedAnswers].sort()))
    .digest("hex");
  const criteria = {
    kind: "objective-v1",
    subjectId: subject.id,
    objectiveId: ex.objectiveId,
    focus: [...ex.focus],
    acceptedAnswersHash,
    ...(ex.requiredElements === undefined ? {} : { requiredElements: ex.requiredElements.map((el) => ({ id: el.id, text: el.text })) }),
    ...(ex.calculation === undefined ? {} : { calculation: {
      kind: ex.calculation.kind,
      params: Object.fromEntries(Object.entries(ex.calculation.params).sort(([a], [b]) => a.localeCompare(b))),
      unit: ex.calculation.unit,
      tolerance: ex.calculation.tolerance ?? 0,
    } }),
    // Słowa kluczowe: zmiana pojęć kluczowych to nowe kryterium oceny wyboru.
    ...(ex.keyOptionIds === undefined ? {} : { keyTerms: keywordsAnswer(ex) }),
    // Pary, grupy i luki: zmiana przypisań to nowe kryterium oceny (stara próba nie awansuje nowego).
    ...(ex.exerciseType === "lesson_match" || ex.exerciseType === "lesson_group" || ex.exerciseType === "lesson_cloze"
      ? { assignments: lessonExerciseStimulus(ex, lessonIdentityOptionsOf(subject)) }
      : {}),
    topicVersion,
  };
  const criteriaHash = createHash("sha256").update(JSON.stringify(criteria)).digest("hex");
  return { criteria, criteriaHash };
}

/** Następna wolna pozycja w wersji (dogenerowanie dopisuje za istniejącymi). */
async function nextPosition(tx: Tx, versionId: string): Promise<number> {
  const row = (
    await tx
      .select({ position: itemRevisions.position })
      .from(itemRevisions)
      .where(eq(itemRevisions.deckVersionId, versionId))
      .orderBy(desc(itemRevisions.position))
      .limit(1)
  )[0];
  return row === undefined ? 0 : row.position + 1;
}

/**
 * Zapis poprawnych ćwiczeń lekcji do wersji: `learning_items (lesson_exercise)`,
 * `item_revisions (payload_version 2, target_key)`, `skill_versions (objective)`
 * i `item_revision_skills`. Dopisuje za istniejącymi (nie czyści) — pasuje i do
 * pierwszej generacji, i do dogenerowania celu. Osobny od `applyItems` słówek:
 * lekcje mają jedną umiejętność (`objective`) i inny payload, więc współdzielenie
 * pętli słówek (iterującej VOCABULARY_SKILLS) zmieniłoby zachowanie słówek —
 * zapis jest celowo osobny (udokumentowane w raporcie).
 */
export async function applyLessonExercises(
  tx: Tx,
  version: { id: string; deckId: string },
  subject: SubjectModule,
  topicVersion: number,
  exercises: readonly LessonExerciseDraft[],
): Promise<void> {
  let position = await nextPosition(tx, version.id);
  for (const ex of exercises) {
    const itemId = randomUUID();
    await tx.insert(learningItems).values({ id: itemId, deckId: version.deckId, kind: "lesson_exercise" });
    const skillVersionId = randomUUID();
    const { criteria, criteriaHash } = buildObjectiveCriteria(ex, subject, topicVersion);
    await tx.insert(skillVersions).values({
      id: skillVersionId,
      itemId,
      skill: "objective",
      revisionNumber: 1,
      criteria,
      criteriaHash,
    });
    const revisionId = randomUUID();
    await tx.insert(itemRevisions).values({
      id: revisionId,
      itemId,
      deckId: version.deckId,
      deckVersionId: version.id,
      position,
      payloadVersion: lessonPayloadVersion(ex, subject),
      payload: buildLessonPayload(ex, subject),
      targetKey: lessonExerciseTargetKey(subject, ex),
    });
    await tx.insert(itemRevisionSkills).values({
      itemRevisionId: revisionId,
      itemId,
      skill: "objective",
      skillVersionId,
    });
    position += 1;
  }
}

/** Odpowiedzi kanoniczne już w szkicu (dla dogenerowania bez duplikatów). */
async function existingAnswersOf(tx: Tx, versionId: string): Promise<string[]> {
  const rows = await tx
    .select({ payload: itemRevisions.payload })
    .from(itemRevisions)
    .where(eq(itemRevisions.deckVersionId, versionId));
  return rows
    .map((r) => (r.payload as { answer?: string }).answer)
    .filter((a): a is string => typeof a === "string");
}

/** Ćwiczenia już zapisane w wersji szkicu (kontekst walidacji dogenerowania, np. krzyżowa reguła ćwiczeń słuchowych). */
async function existingDraftsOf(tx: Executor, versionId: string): Promise<LessonExerciseDraft[]> {
  const rows = await tx
    .select({ payload: itemRevisions.payload })
    .from(itemRevisions)
    .where(eq(itemRevisions.deckVersionId, versionId));
  return rows.flatMap(({ payload }) => {
    if (!payload || typeof payload !== "object") return [];
    const value = payload as Record<string, unknown>;
    if (typeof value.objectiveId !== "string" || typeof value.exerciseType !== "string" || typeof value.answer !== "string") return [];
    return [toExerciseDraft(value)];
  });
}

/** Funkcjonalne bodźce ćwiczeń już zapisanych w wersji szkicu. */
async function existingExercisesOf(tx: Executor, versionId: string, subject: SubjectModule): Promise<LessonExerciseStimulus[]> {
  const rows = await tx
    .select({ payload: itemRevisions.payload })
    .from(itemRevisions)
    .where(eq(itemRevisions.deckVersionId, versionId));
  return rows.flatMap(({ payload }) => {
    if (!payload || typeof payload !== "object") return [];
    const value = payload as Record<string, unknown>;
    if (typeof value.objectiveId !== "string" || typeof value.exerciseType !== "string" || typeof value.answer !== "string") return [];
    const exercise = toExerciseDraft(value);
    return [lessonExerciseStimulusRecord(exercise, lessonIdentityOptionsOf(subject))];
  });
}

export async function executeLessonGeneration(services: Services, runId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
  const deps = requireGeneration(services);
  const run = (await services.db.select().from(generationRuns).where(eq(generationRuns.id, runId)))[0];
  if (!run) {
    throw new AppError("not_found");
  }
  if (run.kind !== "lesson") {
    throw new AppError("internal", { message: "not a lesson run" });
  }
  if (run.state !== "queued") {
    return;
  }

  const attempts = await claimQueuedRun(services.db, runId, run.expectedEditNumber!, services.clock.now());
  if (attempts === null) {
    return;
  }
  const runStartedAtMs = Date.now();
  const markCurrentRun = async (db: Executor, state: "failed" | "succeeded" | "superseded" | "queued", errorCode: string | null, nextAttemptAt: Date | null = null) => {
    const result = await db.update(generationRuns).set({ state, errorCode, nextAttemptAt, finishedAt: state === "queued" ? null : services.clock.now() })
      .where(and(eq(generationRuns.id, runId), eq(generationRuns.state, "running"), eq(generationRuns.attempts, attempts), eq(generationRuns.expectedEditNumber, run.expectedEditNumber!)));
    // Logujemy tylko realne przejście (WHERE może dopasować 0 wierszy, np. gdy
    // równoległy retry rodzica podbił expectedEditNumber).
    if ((result as { rowCount?: number }).rowCount !== 0) {
      console.log(
        `[lesson] run=${runId} ${state === "queued" ? "ponowienie" : "zakończony"}: state=${state} kod=${errorCode ?? "-"} próba=${attempts}`,
      );
    }
  };
  if (attempts > MAX_AUTOMATIC_ATTEMPTS) {
    await markCurrentRun(services.db, "failed", "attempts_exhausted");
    return;
  }

  // Do not spend an LLM request on a run invalidated by a parent edit/retry.
  // The final write still rechecks the edit number under a row lock.
  const currentVersion = (await services.db.select({ editNumber: deckVersions.editNumber, state: deckVersions.state })
    .from(deckVersions).where(eq(deckVersions.id, run.deckVersionId!)))[0];
  if (!currentVersion || currentVersion.state === "published" || currentVersion.editNumber !== run.expectedEditNumber) {
    await markCurrentRun(services.db, "superseded", null);
    return;
  }

  const input = run.input as unknown as LessonRunInput;
  const subject = services.subjects.getSubject(input.subjectId);
  // Temat dynamiczny: migawka z kontekstu (dogenerowanie) albo do wygenerowania
  // w etapie zagadnień tego runu (pierwsza generacja zestawu szkolnego).
  let dynamicTopicData: DynamicTopicData | undefined = input.dynamicTopic;
  let droppedObjectiveCount = 0;
  let topic: LessonTopic | undefined = subject
    ? resolveLessonTopic(services.subjects, input)?.topic
    : undefined;
  const needsDynamicObjectives =
    subject?.buildDynamicTopic !== undefined && !input.regenerate && dynamicTopicData === undefined;
  if (!subject || (!topic && !needsDynamicObjectives)) {
    await markCurrentRun(services.db, "failed", "validation");
    return;
  }
  // Czy model oceniający będzie dostępny przy odpowiedzi (proces web)? Worker
  // liczy to z tego samego env co web (`graderConfigured`, wspólny .env w
  // Compose) i wstrzykuje w GenerationDeps. To steruje tylko PREFERENCJĄ
  // typów przy generacji (closed/gap, gdy brak modelu), nie oceną.
  const graderAvailable = services.generation?.graderAvailable === true;

  // Runy dogenerowania utworzone przed wprowadzeniem polityki exercise mają
  // tylko existingAnswers. Dla gramatyki odbudowujemy bodźce z bieżącego szkicu.
  const legacyExistingExercises = subject.poolDeduplication === "exercise" && input.regenerate && input.regenerate.existingExercises === undefined
    ? await existingExercisesOf(services.db, input.deckVersionId, subject)
    : [];

  // Partie per cel: albo dogenerowanie jednego celu, albo pełna pula.
  let batches: { objectiveId: string; count: number; existingAnswers: string[]; existingExercises: LessonExerciseStimulus[] }[] = input.regenerate
    ? [
        {
          objectiveId: input.regenerate.objectiveId,
          count: input.regenerate.count,
          existingAnswers: input.regenerate.existingAnswers,
          existingExercises: input.regenerate.existingExercises ?? legacyExistingExercises,
        },
      ]
    : needsDynamicObjectives
      ? []
      : batchesForObjectives(input.objectiveIds, input.poolSize, subject, runId);

  const rawExercises: unknown[] = [];
  let rawExerciseCount = 0;
  let outOfScopeCount = 0;
  // Odpowiedzi kanoniczne z wcześniejszych partii tej samej generacji: późniejsze
  // cele dostają je jako `existingAnswers` ("Do NOT repeat…"), więc pełna
  // generacja wielocelowa też omija duplikaty między partiami — walidacja fazy 2
  // pozostaje egzekwatorem (advisory list z surowych odpowiedzi, deduplikowana).
  const earlierAnswers: string[] = [];
  const earlierExercises: LessonExerciseStimulus[] = [];
  // Limity celów runu (zamówiona liczba i przyznany dodatek słuchowy) — egzekwowane po walidacji.
  const objectiveLimits = new Map<string, ObjectiveGenerationLimits>();
  const examples: Record<string, string[]> = {};
  const executionPolicy = deps.lessonExecution ?? DEFAULT_LESSON_GENERATION_POLICY;
  const runDeadlineAtMs = runStartedAtMs + executionPolicy.runTimeoutMs;
  console.log(
    `[lesson] generacja run=${runId} deck=${input.deckId} cele=${batches.length} próba=${attempts} pula=${input.poolSize} model=${deps.llm.model}`,
  );
  try {
    await withLessonGenerationControl({
      ...executionPolicy,
      signal: options.signal,
      assertCurrent: async () => {
        const [current] = await services.db.select({ state: generationRuns.state, attempts: generationRuns.attempts, expectedEditNumber: generationRuns.expectedEditNumber })
          .from(generationRuns).where(eq(generationRuns.id, runId));
        const [version] = await services.db.select({ editNumber: deckVersions.editNumber, state: deckVersions.state })
          .from(deckVersions).where(eq(deckVersions.id, run.deckVersionId!));
        return current?.state === "running" && current.attempts === attempts &&
          current.expectedEditNumber === run.expectedEditNumber && version?.state !== "published" &&
          version?.editNumber === run.expectedEditNumber;
      },
    }, async (control) => {
    if (needsDynamicObjectives) {
      await control.assertCurrent();
      const objectivesResult = await control.call((signal) =>
        deps.llm.generateLessonObjectives(
          {
            subjectTitle: input.subjectTitlePl ?? subject.titlePl,
            topicTitle: input.topicTitlePl ?? "",
            material: input.material,
            ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
            generationRole: subject.prompts.generationRole,
            voiceTones: subject.ttsForPrompts === true,
            ...(subject.prompts.objectivesRules === undefined ? {} : { objectivesRules: subject.prompts.objectivesRules }),
          },
          signal,
        ),
      );
      await control.assertCurrent();
      const topicTitle = input.topicTitlePl ?? "";
      const built = buildDynamicTopicData(objectivesResult.objectives, subject.id, input.deckId, topicTitle, (objective) =>
        validateDynamicTopicData(subject, { titlePl: topicTitle, objectives: [objective] }), subject.ttsForPrompts === true);
      if (!built.data) {
        throw new AppError("validation", { message: `dynamic objectives invalid: ${built.errors.join("; ")}` });
      }
      const topicErrors = validateDynamicTopicData(subject, built.data);
      if (topicErrors.length > 0) {
        throw new AppError("validation", { message: `dynamic topic invalid: ${topicErrors.join("; ")}` });
      }
      const storedData = withSubjectObjectiveKinds(subject, built.data);
      dynamicTopicData = storedData;
      topic = subject.buildDynamicTopic!(storedData);
      batches = batchesForObjectives(storedData.objectives.map((objective) => objective.id), input.poolSize, subject, runId);
      console.log(`[lesson] run=${runId} etap zagadnień: cele=${batches.length}`);
      droppedObjectiveCount = built.errors.length;
      if (droppedObjectiveCount > 0) {
        console.log(`[lesson] run=${runId} etap zagadnień: porzucone=${droppedObjectiveCount}`);
      }
    }
    const activeTopic = topic;
    if (!activeTopic) {
      throw new AppError("validation", { message: "lesson topic unresolved" });
    }
    for (const batch of batches) {
      await control.assertCurrent();
      const batchStartedAtMs = Date.now();
      const poolInput = buildPoolInput(
        subject,
        activeTopic,
        batch.objectiveId,
        batch.count,
        input.material,
        input.instruction,
        graderAvailable,
        subject.poolDeduplication === "exercise"
          ? []
          : [...new Set([...batch.existingAnswers, ...earlierAnswers])],
        subject.poolDeduplication === "exercise"
          ? [...batch.existingExercises, ...earlierExercises]
          : [],
        input.interests,
      );
      objectiveLimits.set(batch.objectiveId, { count: batch.count, listen: poolInput.listenChoicePerObjective ?? 0 });
      const result = await control.call((signal) => deps.llm.generateLessonPool(poolInput, signal));
      await control.assertCurrent();
      console.log(`[lesson] run=${runId} partia=${batch.objectiveId} durationMs=${Date.now() - batchStartedAtMs}`);
      rawExerciseCount += result.exercises.length;
      const scoped = filterExercisesToRequestedObjective(result.exercises, batch.objectiveId);
      outOfScopeCount += scoped.outOfScopeCount;
      rawExercises.push(...scoped.exercises);
      const metadata = collectBatchExerciseMetadata(scoped.exercises, subject.poolDeduplication === "exercise", lessonIdentityOptionsOf(subject));
      earlierAnswers.push(...metadata.answers);
      earlierExercises.push(...metadata.exerciseRecords);
      const rawExamples = result.examples;
      for (const objectiveId of [batch.objectiveId]) {
        const list = rawExamples && typeof rawExamples === "object" ? rawExamples[objectiveId] : undefined;
        if (!Array.isArray(list)) continue;
        examples[objectiveId] = list.filter((line): line is string => typeof line === "string" && line.trim().length > 0 && line.trim().length <= MAX_TEXT_LENGTH)
          .map((line) => line.trim()).slice(0, 3);
      }
    }
    });
  } catch (error) {
    if (error instanceof LessonGenerationCancelledError) {
      if (error.reason === "shutdown") await markCurrentRun(services.db, "queued", null, null);
      return;
    }
    const failure = classifyLessonGenerationFailure(error);
    console.error(`[lesson] run=${runId} błąd partii LLM: kod=${failure.errorCode} retryable=${failure.retryable} próba=${attempts}`);
    if (!failure.retryable) {
      await markCurrentRun(services.db, "failed", failure.errorCode);
    } else if (attempts >= MAX_AUTOMATIC_ATTEMPTS) {
      await markCurrentRun(services.db, "failed", "attempts_exhausted");
    } else {
      const delay = lessonRetryDelayMs(attempts, failure.retryAfterMs, Math.random);
      const nextAttemptAt = new Date(services.clock.now().getTime() + delay);
      console.log(`[lesson] run=${runId} retryDelayMs=${delay} nextAttemptAt=${nextAttemptAt.toISOString()}`);
      await markCurrentRun(services.db, "queued", failure.errorCode, nextAttemptAt);
    }
    return;
  }

  // Walidacja puli w domenie: pojedyncze reguły + duplikaty, także wobec
  // odpowiedzi już w szkicu (existingAnswers z partii dogenerowania). Najpierw
  // strażnik KSZTAŁTU: rekord o złym kształcie tablic (np. options=[null,…])
  // jest odrzucany pojedynczo (liczony do rejectedCount), zamiast rzucać
  // TypeError w walidacji semantycznej i wywracać cały run (wymóg 2.5).
  // Całość walidacji + zapisu w terminalnym try/catch: nawet nieprzewidziany
  // wyjątek rozlicza run (failed/validation), nie zostawia go w stanie running.
  try {
    assertLessonGenerationFinalizationAllowed(runDeadlineAtMs, options.signal);
    const wellShaped = rawExercises.filter(isWellShapedRawExercise);
    const shapeRejected = rawExercises.length - wellShaped.length;
    // Warianty acceptedAnswers redundantne wobec odpowiedzi kanonicznej (np.
    // skrótowa forma przeczenia „to be” przy pełnej) porzucamy przy przyjęciu
    // puli — bez tego walidacja fazy 1 odrzucałaby całe ćwiczenie za wpis
    // nieznoszący informacji (odpowiedź kanoniczna jest akceptowana automatycznie).
    let droppedAcceptedVariants = 0;
    const drafts = wellShaped
      .map(toExerciseDraft)
      .map((draft) => withoutVoiceToneUnlessAllowed(draft, subject))
      .map(withoutEmptyOptionalArrays)
      // Ćwiczenie słuchowe nie ma polecenia, podpowiedzi ani piktogramu: dodatek modelu usuwamy, nie odrzucamy ćwiczenia.
      .map(stripListenChoiceExtras)
      .map((draft) => (input.regenerate ? scopeFamiliesToRun(draft, runId) : draft))
      .map((draft) => {
        const sanitized = withoutRedundantAcceptedVariants(draft, subject.normalizer);
        droppedAcceptedVariants += draft.acceptedAnswers.length - sanitized.acceptedAnswers.length;
        return sanitized;
      });
    if (!topic) {
      await markCurrentRun(services.db, "failed", "validation");
      return;
    }
    // Czyszczenie świeżego wyjścia modelu hakiem przedmiotu (tylko generacja,
    // także dogenerowanie): odrzucenia liczą się do rejectedCount i są zliczone
    // po powodzie w rejectedReasons dla rodzica.
    const refined = refineGeneratedDrafts(subject, drafts, input.material);
    // Walidacja puli z materiałem (przedmiot: uziemienie cytatów, rodziny pytań)
    // przed walidacją semantyczną — odrzucone ćwiczenia liczą się do rejectedCount.
    const grounded = splitByPoolExtra(subject, stripParentAddedFlags(refined.kept), input.material);
    // Dogenerowanie dopisuje do szkicu: krzyżowa reguła ćwiczeń słuchowych widzi też ćwiczenia już w szkicu
    // (inaczej konflikt zdania z odpowiedzią tekstową wyszedłby dopiero przy publikacji).
    const existingDrafts = input.regenerate ? await existingDraftsOf(services.db, input.deckVersionId) : [];
    const poolResult = validatePool(grounded.kept, subject, topic, { existingExercises: existingDrafts });
    const valid = poolResult.valid;
    const rejected = [...grounded.extraRejected, ...poolResult.rejected];
    // Duplikaty wobec odpowiedzi już w puli: odrzucamy valid, których odpowiedź
    // równa się istniejącej (dogenerowanie nie powiela odpowiedzi szkicu).
    const existingSet = new Set(batches.flatMap((b) => b.existingAnswers));
    const existingExerciseSet = new Set(batches.flatMap((b) => b.existingExercises).map((exercise) =>
      JSON.stringify([exercise.objectiveId, exercise.exerciseType, exercise.stimulus]),
    ));
    const identityOptions = lessonIdentityOptionsOf(subject);
    const deduplicated: LessonExerciseDraft[] = [];
    let dupAgainstExisting = 0;
    for (const ex of valid) {
      const clash = subject.poolDeduplication === "exercise"
        ? existingExerciseSet.has(lessonExerciseIdentity(ex, identityOptions))
        : [...existingSet].some((a) => answersEquivalent(a, ex.answer, subject.normalizer));
      if (clash) {
        dupAgainstExisting += 1;
      } else {
        deduplicated.push(ex);
      }
    }
    // Dodatek słuchowy: najwyżej przyznana liczba na cel, a ćwiczenia etapów nie ponad zamówione.
    const capped = capListenChoiceOverflow(deduplicated, objectiveLimits);
    const uniqueValid = capped.kept;
    rejected.push(...capped.rejected);
    const rejectedCount = shapeRejected + outOfScopeCount + refined.rejectedCount + rejected.length + dupAgainstExisting;

    console.log(
      `[lesson] run=${runId} walidacja puli: ${summarizeLessonPoolValidation({
        rawCount: rawExerciseCount,
        shapeRejected,
        outOfScopeCount,
        rejectedExerciseCount: rejected.length,
        rejectedErrors: rejected.flatMap((item) => item.errors),
        duplicateCount: dupAgainstExisting,
        validCount: uniqueValid.length,
        refineRejected: refined.rejectedCount,
      })}`,
    );
    // Porzucone warianty redundantne nie są odrzuceniem (nie trafiają do
    // rejectedCount ani podsumowania) — sama linia z licznikiem, bez treści
    // wariantów, żeby incydenty tej klasy były widoczne w logach workera.
    if (droppedAcceptedVariants > 0) {
      console.log(`[lesson] run=${runId} sanityzacja wariantów: porzucone=${droppedAcceptedVariants}`);
    }

    if (uniqueValid.length === 0) {
      // Nawet przy porażce rodzic widzi skalę odrzuceń: zapisujemy liczniki
      // do kontekstu (ta sama straż wersji co przy finalizacji).
      await services.db.transaction(async (tx) => {
        const version = (
          await tx.select().from(deckVersions).where(eq(deckVersions.id, run.deckVersionId!)).for("update")
        )[0];
        if (version && version.state !== "published" && version.editNumber === run.expectedEditNumber) {
          const prevContext = (version.lessonContext ?? {}) as unknown as LessonContext;
          const rejectedReasons = sumRejectedReasons(prevContext.rejectedReasons, refined.rejectedReasons);
          await tx
            .update(deckVersions)
            .set({
              lessonContext: {
                ...prevContext,
                rejectedCount: (prevContext.rejectedCount ?? 0) + rejectedCount,
                ...(Object.keys(rejectedReasons).length > 0 ? { rejectedReasons } : {}),
                droppedObjectiveCount: (prevContext.droppedObjectiveCount ?? 0) + droppedObjectiveCount,
              } as unknown as Record<string, unknown>,
            })
            .where(eq(deckVersions.id, version.id));
        }
        await markCurrentRun(tx, "failed", "validation");
      });
      return;
    }

    await services.db.transaction(async (tx) => {
      const version = (
        await tx.select().from(deckVersions).where(eq(deckVersions.id, run.deckVersionId!)).for("update")
      )[0];
      const current = (await tx.select().from(generationRuns).where(eq(generationRuns.id, runId)).for("update"))[0];
      if (!current || current.state !== "running" || current.attempts !== attempts || current.expectedEditNumber !== run.expectedEditNumber) return;
      assertLessonGenerationFinalizationAllowed(runDeadlineAtMs, options.signal);
      if (!version) {
        await markCurrentRun(tx, "failed", "deck_version_gone");
        return;
      }
      if (version.state === "published" || version.editNumber !== run.expectedEditNumber) {
        await markCurrentRun(tx, "superseded", null);
        return;
      }
      await applyLessonExercises(
        tx,
        { id: version.id, deckId: version.deckId },
        subject,
        input.topicVersion,
        uniqueValid,
      );
      // Uzupełnienie lesson_context: przykłady i licznik odrzuconych (sumujemy przy
      // dogenerowaniu). lesson_context jest niezmienny dopiero po publikacji.
      const prevContext = (version.lessonContext ?? {}) as unknown as LessonContext;
      const rejectedReasons = sumRejectedReasons(prevContext.rejectedReasons, refined.rejectedReasons);
      const nextContext: LessonContext = {
        ...prevContext,
        ...(dynamicTopicData ? { dynamicTopic: dynamicTopicData, objectiveIds: dynamicTopicData.objectives.map((o) => o.id) } : {}),
        examples: { ...prevContext.examples, ...examples },
        rejectedCount: (prevContext.rejectedCount ?? 0) + rejectedCount,
        ...(Object.keys(rejectedReasons).length > 0 ? { rejectedReasons } : {}),
        droppedObjectiveCount: (prevContext.droppedObjectiveCount ?? 0) + droppedObjectiveCount,
      };
      await tx
        .update(deckVersions)
        .set({ lessonContext: nextContext as unknown as Record<string, unknown> })
        .where(eq(deckVersions.id, version.id));
      await reconcileDraftAssetsTx(tx, services, version);
      const nextEditNumber = version.editNumber + 1;
      await tx.update(deckVersions).set({ editNumber: nextEditNumber }).where(eq(deckVersions.id, version.id));
      await supersedeLessonRuns(tx, version.id, services.clock.now(), runId);
      if (version.state !== "review") {
        await tx.update(deckVersions).set({ state: "review" }).where(eq(deckVersions.id, version.id));
      }
      await markCurrentRun(tx, "succeeded", null);
    });
    console.log(`[lesson] run=${runId} zakończony durationMs=${Date.now() - runStartedAtMs}`);
  } catch (error) {
    // Nieprzewidziany wyjątek walidacji/zapisu NIE może zostawić runu „running”.
    // Rozliczamy terminalnie: wyczerpane próby → attempts_exhausted, inaczej
    // validation (błąd kształtu/treści puli, nie błąd przejściowy providera).
    console.error(`[lesson] run=${runId} nieprzewidziany błąd walidacji/zapisu: kod=validation_or_write`);
    if (error instanceof LessonGenerationCancelledError) {
      if (error.reason === "shutdown") await markCurrentRun(services.db, "queued", null, null);
    } else if (classifyLessonGenerationFailure(error).errorCode === "provider_timeout") {
      await markCurrentRun(services.db, "failed", "provider_timeout");
    } else if (attempts >= MAX_AUTOMATIC_ATTEMPTS) {
      await markCurrentRun(services.db, "failed", "attempts_exhausted");
    } else {
      await markCurrentRun(services.db, "failed", "validation");
    }
    return;
  }
}

/**
 * Dogenerowanie ćwiczeń jednego celu w istniejącym szkicu (design „Generowanie
 * puli”). Nowy run `lesson` z `existingAnswers` istniejących ćwiczeń szkicu;
 * dopisuje ćwiczenia, nie usuwa istniejących. Idempotentne po `clientRequestId`.
 */
export async function regenerateObjective(
  services: Services,
  args: {
    deckId: string;
    objectiveId: string;
    count: number;
    expectedEditNumber: number;
    clientRequestId: string;
  },
): Promise<{ runId: string; deckId: string }> {
  return enqueueGenerationRun(services.db, `lesson:${args.clientRequestId}`, async (tx) => {
      const version = (
        await tx
          .select()
          .from(deckVersions)
          .where(and(eq(deckVersions.deckId, args.deckId)))
          .orderBy(desc(deckVersions.versionNumber))
          .limit(1)
          .for("update")
      )[0];
      if (!version) {
        throw new AppError("not_found");
      }
      const priorRequest = (await tx.select().from(generationRuns).where(eq(generationRuns.dedupeKey, `lesson:${args.clientRequestId}`)))[0];
      if (priorRequest) return { runId: priorRequest.id, deckId: args.deckId };
      if (version.state === "published") {
        throw new AppError("immutable");
      }
      if (version.editNumber !== args.expectedEditNumber) {
        throw new AppError("conflict");
      }
      const activeRun = (await tx.select({ id: generationRuns.id }).from(generationRuns).where(and(
        eq(generationRuns.kind, "lesson"),
        eq(generationRuns.deckVersionId, version.id),
        inArray(generationRuns.state, ["queued", "running"]),
      )).limit(1))[0];
      if (activeRun) throw new AppError("conflict");
      const context = (version.lessonContext ?? {}) as unknown as LessonContext;
      if (!context.subjectId || !context.objectiveIds?.includes(args.objectiveId)) {
        throw new AppError("validation", { message: "objective not in lesson" });
      }
      const subject = services.subjects.getSubject(context.subjectId);
      if (!subject) throw new AppError("validation", { message: "unknown subject" });
      const existingAnswers = subject.poolDeduplication === "exercise" ? [] : await existingAnswersOf(tx, version.id);
      const existingExercises = subject.poolDeduplication === "exercise" ? await existingExercisesOf(tx, version.id, subject) : [];
      const runId = randomUUID();
      const runInput: LessonRunInput = {
        deckId: args.deckId,
        deckVersionId: version.id,
        subjectId: context.subjectId,
        topicId: context.topicId,
        topicVersion: context.topicVersion,
        objectiveIds: context.objectiveIds,
        poolSize: context.poolSize,
        material: context.material,
        ...(context.instruction === undefined ? {} : { instruction: context.instruction }),
        ...(context.interests === undefined ? {} : { interests: context.interests }),
        ...(context.subjectTitlePl === undefined ? {} : { subjectTitlePl: context.subjectTitlePl }),
        ...(context.dynamicTopic === undefined ? {} : { dynamicTopic: context.dynamicTopic }),
        regenerate: { objectiveId: args.objectiveId, count: args.count, existingAnswers, existingExercises },
      };
      await tx.insert(generationRuns).values({
        id: runId,
        deckVersionId: version.id,
        expectedEditNumber: version.editNumber,
        kind: "lesson",
        dedupeKey: `lesson:${args.clientRequestId}`,
        state: "queued",
        input: runInput as unknown as Record<string, unknown>,
      });
      return { runId, deckId: args.deckId };
  });
}
