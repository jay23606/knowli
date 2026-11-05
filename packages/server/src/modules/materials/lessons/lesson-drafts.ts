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
import { avoidSentencesFor } from "../../../domain/lessons/avoid-sentences";
import { cardExposureSources } from "../../../domain/lessons/card-exposure-sources";
import { explanationTextErrors } from "../../../domain/lessons/exercise-explanation";
import { lessonExerciseTargetKey } from "../../../domain/lessons/exposure-key";
import { resolveGenerationLeaks } from "../../../domain/lessons/exposure-leaks";
import { DISTINCT_OPEN_ANSWERS_PER_OBJECTIVE, stageDeficits, type StageDeficits } from "../../../domain/lessons/lesson-coverage";
import {
  DEFAULT_LESSON_POLICY,
  defaultPoolSize,
  type StageMix,
} from "../../../domain/lessons/lesson-policy";
import { materialCreationMode } from "../../../domain/lessons/material-creation";
import { keywordsAnswer, MAX_TEXT_LENGTH, validatePool } from "../../../domain/lessons/pool-validation";
import { withoutOrphanKeywords } from "../../../domain/lessons/keyword-families";
import { outsideStagePath, stageOf } from "../../../domain/lessons/stages";
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
import { solvedSentencesOf, storyCollisions, type LessonStory } from "../../../domain/lessons/story";
import type { LessonPoolInput, LlmLessonStageCounts, LlmProvider } from "../../../ports/ai";
import { resolveLessonTopic, validateDynamicTopicData } from "../../../domain/lessons/topic-resolution";
import {
  claimQueuedRun,
  enqueueGenerationRun,
  isStoryRunInput,
  lessonPoolRunFilter,
  supersedeLessonRuns,
  type LESSON_STORY_PURPOSE,
} from "../generation-runs";
import { MAX_AUTOMATIC_ATTEMPTS, requireGeneration } from "../generation-runtime";
import { classifyLessonGenerationFailure, lessonRetryDelayMs } from "./lesson-generation-errors";
import {
  assertLessonGenerationFinalizationAllowed,
  LessonGenerationCancelledError,
  withLessonGenerationControl,
  type LessonGenerationControl,
} from "./lesson-generation-control";
import { executeLessonAgentGeneration } from "./lesson-agent-generation";
import { lessonGeneratorFor } from "./lesson-agent-outcome";
import { DEFAULT_LESSON_GENERATION_POLICY, type LessonGenerationPolicy } from "./lesson-generation-policy";
import { reconcileDraftAssetsTx } from "../media-reconciliation";
import { committedRetryAfterSourceChange, lockSourceMaterialForCopy } from "../source-materials";
import { buildLessonPayload } from "./lesson-payload";
import { acceptFreshLessonPool } from "./lesson-pool-acceptance";
import { executeLessonStoryGeneration, queueLessonStoryRunTx } from "./lesson-story-generation";

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
export interface LessonContext {
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
  /** Historyjka na koniec sesji (przedmioty z `lessonStory`); zapisuje ją run historyjki albo rodzic. */
  story?: LessonStory;
  /** Zagadnienia do uzupełnienia po częściowym generowaniu agentem (panel rodzica); bez treści. */
  generationGaps?: LessonGenerationGap[];
}

/**
 * Luka generowania agentem (spec etapu 2a §11): zagadnienie `incomplete`/`failed` po pełnej generacji
 * albo niepełne dogenerowanie (`add_short`: dodano `added` z `requested`).
 */
export type LessonGenerationGap = {
  objectiveId: string;
  reason: "incomplete" | "failed" | "add_short";
  added?: number;
  requested?: number;
};

/** Wejście runu `lesson` zapisane w `generation_runs.input`. */
export interface LessonRunInput {
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
  /** Run historyjki (`LESSON_STORY_PURPOSE`); brak = generowanie puli ćwiczeń. */
  purpose?: typeof LESSON_STORY_PURPOSE;
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

/** Powód odrzucenia świeżego ćwiczenia z rozwiązaniem widocznym wcześniej (klucz `rejectedReasons`, widoczny dla rodzica). */
const EXPOSURE_LEAK_REASON = "rozwiązanie widoczne wcześniej";
/** Powód odrzucenia świeżych słów kluczowych, których rodzina pytań otwartych odpadła (klucz `rejectedReasons`). */
const ORPHAN_KEYWORDS_REASON = "ćwiczenie bez rodziny pytań otwartych";

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
  /** Zamówiony podział `count` na etapy; przy przycinaniu nadmiaru chroni etapy niedoreprezentowane. */
  readonly stages?: LlmLessonStageCounts;
}

/**
 * Ćwiczenia etapów celu, które mieszczą się w `count`: najpierw każdy etap do zamówionej
 * liczby, potem wolne miejsca w kolejności wejścia (typy bez kwoty, np. karty, i braki etapów).
 */
function withinStageQuotas(
  candidates: readonly LessonExerciseDraft[],
  limit: ObjectiveGenerationLimits,
): Set<LessonExerciseDraft> {
  if (candidates.length <= limit.count) return new Set(candidates);
  const quotas = limit.stages ?? { guided: 0, productive: 0, independent: 0 };
  const used = { guided: 0, productive: 0, independent: 0 };
  const selected = new Set<LessonExerciseDraft>();
  for (const exercise of candidates) {
    const stage = stageOf(exercise.exerciseType);
    if (outsideStagePath(exercise.exerciseType) || !(stage in quotas)) continue;
    const key = stage as keyof LlmLessonStageCounts;
    if (used[key] < quotas[key] && selected.size < limit.count) {
      used[key] += 1;
      selected.add(exercise);
    }
  }
  for (const exercise of candidates) {
    if (selected.size >= limit.count) break;
    selected.add(exercise);
  }
  return selected;
}

/**
 * Egzekwuje dodatek słuchowy po walidacji: na cel najwyżej `listen` nowych ćwiczeń
 * `lesson_listen_choice`, a gdy dodatek przyznano (`listen > 0`), najwyżej `count` pozostałych —
 * podniesiony w prompcie limit partii nie może dać dodatkowych ćwiczeń etapów. Słuchowe zachowują
 * pierwsze wystąpienia; z pozostałych odpadają najpierw ćwiczenia etapów ponad zamówiony podział
 * (`stages`), dalej kolejność wejścia. Nadmiar wraca jako odrzucenia z powodem.
 */
export function capListenChoiceOverflow(
  exercises: readonly LessonExerciseDraft[],
  limits: ReadonlyMap<string, ObjectiveGenerationLimits>,
): { kept: LessonExerciseDraft[]; rejected: { exercise: LessonExerciseDraft; errors: string[] }[] } {
  const listenSeen = new Map<string, number>();
  const allowedOther = new Map<string, Set<LessonExerciseDraft>>();
  for (const [objectiveId, limit] of limits) {
    if (limit.listen <= 0) continue;
    const candidates = exercises.filter((exercise) => exercise.objectiveId === objectiveId && exercise.exerciseType !== "lesson_listen_choice");
    allowedOther.set(objectiveId, withinStageQuotas(candidates, limit));
  }
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
    } else if (limit !== undefined && !(allowedOther.get(exercise.objectiveId)?.has(exercise) ?? true)) {
      rejected.push({ exercise, errors: [`exerciseType: ćwiczenie ponad zamówioną liczbę ${limit.count} dla reguły`] });
      continue;
    }
    kept.push(exercise);
  }
  return { kept, rejected };
}

/** Błąd nadwyżki rundy pod etap ponad brak (log walidacji, jak przycięcie limitów celu). */
const STAGE_TOP_UP_EXCESS_ERROR = "exerciseType: ponad brak etapu";
/** Błąd ćwiczenia spoza ścieżki etapów w rundzie pod etap (runda zamawia tylko braki etapów). */
const STAGE_TOP_UP_OUTSIDE_PATH_ERROR = "exerciseType: poza ścieżką etapów w dogenerowaniu";

/** Zapas czasu przed deadlinem przebiegu, który zostaje po wywołaniu rundy na walidację i zapis. */
const STAGE_TOP_UP_MARGIN_MS = 30_000;

/**
 * Przycina przyjęte ćwiczenia rundy pod etap do braków: z każdego etapu najwyżej jego brak
 * (kolejność wejścia); nadwyżka i ćwiczenia spoza etapów z brakiem odpadają z powodem.
 * Typy spoza ścieżki etapów (słowa kluczowe, wybór ze słuchu) odpadają zawsze — nie zajmują
 * miejsca etapu, a runda zamawia wyłącznie braki etapów.
 */
export function trimToStageDeficits(
  exercises: readonly LessonExerciseDraft[],
  deficits: StageDeficits,
): { kept: LessonExerciseDraft[]; rejected: { exercise: LessonExerciseDraft; errors: string[] }[] } {
  const used = { guided: 0, productive: 0, independent: 0 };
  const kept: LessonExerciseDraft[] = [];
  const rejected: { exercise: LessonExerciseDraft; errors: string[] }[] = [];
  for (const exercise of exercises) {
    if (outsideStagePath(exercise.exerciseType)) {
      rejected.push({ exercise, errors: [STAGE_TOP_UP_OUTSIDE_PATH_ERROR] });
      continue;
    }
    const stage = stageOf(exercise.exerciseType);
    if ((stage === "guided" || stage === "productive" || stage === "independent") && used[stage] < deficits[stage]) {
      used[stage] += 1;
      kept.push(exercise);
    } else {
      rejected.push({ exercise, errors: [STAGE_TOP_UP_EXCESS_ERROR] });
    }
  }
  return { kept, rejected };
}

/** Czysta reguła rodzin słów kluczowych żyje w domenie (używa jej też agent puli); reeksport dla obecnych wywołujących. */
export { withoutOrphanKeywords };

/** Licznik powodu dla `rejectedReasons` (pusty, gdy nic nie odpadło). */
function reasonCount(reason: string, count: number): Record<string, number> {
  return count > 0 ? { [reason]: count } : {};
}

/** Przykłady kart ze szkicu i z bieżącego przebiegu, razem (per zagadnienie: najpierw szkic). */
export function mergeExamples(
  draft: Readonly<Record<string, readonly string[]>>,
  fresh: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const source of [draft, fresh]) {
    for (const [objectiveId, list] of Object.entries(source)) merged[objectiveId] = [...(merged[objectiveId] ?? []), ...list];
  }
  return merged;
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
  options: { readonly avoidSentences?: readonly string[]; readonly purpose?: LessonPoolInput["purpose"] } = {},
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
    exerciseExplanations: subject.exerciseExplanations,
    ...(existingAnswers.length > 0 ? { existingAnswers: [...existingAnswers] } : {}),
    ...(existingExercises.length > 0 ? { existingExercises: [...existingExercises] } : {}),
    ...(options.avoidSentences !== undefined && options.avoidSentences.length > 0 ? { avoidSentences: [...options.avoidSentences] } : {}),
    ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
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

/**
 * Wyjaśnienie błędu z niezaufanego wyjścia modelu: wyłącznie niepusty tekst (przycięty);
 * `null`, pusty tekst i inne typy znaczą „brak wyjaśnienia”, nigdy błąd ćwiczenia.
 */
function sanitizedExplanation(raw: unknown): { explanationPl?: string } {
  if (typeof raw !== "string") return {};
  const trimmed = raw.trim();
  return trimmed === "" ? {} : { explanationPl: trimmed };
}

/**
 * Wyjaśnienie z generatora łamiące reguły treści albo wyłączone flagą przedmiotu jest po cichu
 * usuwane — ćwiczenie zostaje (walidacja puli odrzuciłaby je w całości). Tylko wyjście modelu:
 * zapis rodzica z niepoprawnym wyjaśnieniem kończy się błędem walidacji.
 */
export function withoutInvalidExplanation(
  draft: LessonExerciseDraft,
  subject: Pick<SubjectModule, "exerciseExplanations">,
): LessonExerciseDraft {
  if (draft.explanationPl === undefined) return draft;
  if (subject.exerciseExplanations && explanationTextErrors(draft.explanationPl).length === 0) return draft;
  const { explanationPl: _dropped, ...rest } = draft;
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
    // `explanationPl` celowo poza strażnikiem: zły typ znaczy „brak wyjaśnienia”
    // (`sanitizedExplanation`), nie odrzucenie całego ćwiczenia.
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
    ...sanitizedExplanation(r.explanationPl),
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

/** criteria dla umiejętności `objective` (design „Data Models”). */
export function buildObjectiveCriteria(
  ex: LessonExerciseDraft,
  subject: SubjectModule,
  topicVersion: number | undefined,
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
 * zapis jest celowo osobny (udokumentowane w raporcie). Zwraca identyfikatory
 * elementów (`learning_items.id`) w kolejności wejścia.
 */
export async function applyLessonExercises(
  tx: Tx,
  version: { id: string; deckId: string },
  subject: SubjectModule,
  topicVersion: number | undefined,
  exercises: readonly LessonExerciseDraft[],
): Promise<string[]> {
  let position = await nextPosition(tx, version.id);
  const itemIds: string[] = [];
  for (const ex of exercises) {
    const itemId = randomUUID();
    itemIds.push(itemId);
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
  return itemIds;
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

/**
 * Ćwiczenia już zapisane w wersji szkicu, w kolejności lekcji (pozycja, potem id — jak sesja lekcji);
 * kontekst walidacji dogenerowania (np. krzyżowa reguła ćwiczeń słuchowych) i stan stały ścieżki agenta.
 */
export async function orderedDraftExercises(db: Executor, deckVersionId: string): Promise<LessonExerciseDraft[]> {
  const rows = await db
    .select({ payload: itemRevisions.payload })
    .from(itemRevisions)
    .where(eq(itemRevisions.deckVersionId, deckVersionId))
    .orderBy(asc(itemRevisions.position), asc(itemRevisions.id));
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

interface StageTopUpContext {
  readonly runId: string;
  readonly llm: ReturnType<typeof requireGeneration>["llm"];
  readonly subject: SubjectModule;
  readonly topic: LessonTopic;
  readonly input: LessonRunInput;
  readonly graderAvailable: boolean;
  readonly policy: LessonGenerationPolicy;
  readonly runDeadlineAtMs: number;
  readonly signal?: AbortSignal;
  readonly assertCurrent: () => Promise<boolean>;
  /** Zagadnienia przebiegu (kolejność partii) — runda sprawdza braki tylko u nich. */
  readonly objectiveIds: readonly string[];
  /** Kolejność zagadnień lekcji dla reguły ujawnień i pokrycia. */
  readonly objectiveOrder: readonly string[];
  readonly existingDrafts: readonly LessonExerciseDraft[];
  /** Ćwiczenia przyjęte z partii głównej (po regule ujawnień). */
  readonly kept: readonly LessonExerciseDraft[];
  /** Końcowe przykłady kart (szkic z zachowanymi nowymi); runda ich nie zmienia. */
  readonly examples: Readonly<Record<string, readonly string[]>>;
  /**
   * Zdania z kart rozdziału (`cardExposureSources`): stałe źródła reguły twardej i podpowiedź
   * `avoidSentences` rundy; nie są przykładami kart, więc nie wpływają na pokrycie ani zapis.
   */
  readonly cardSources: Readonly<Record<string, readonly string[]>>;
  /** Bodźce i odpowiedzi surowych ćwiczeń partii głównej (advisory „nie powtarzaj”, numeracja fake'a). */
  readonly runStimuli: readonly LessonExerciseStimulus[];
  readonly runAnswers: readonly string[];
}

/** Bodźce bez powtórzeń (przyjęte ćwiczenia runu są też wśród jego surowych bodźców). */
function uniqueStimuli(records: readonly LessonExerciseStimulus[]): LessonExerciseStimulus[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = JSON.stringify([record.objectiveId, record.exerciseType, record.stimulus]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Runda dogenerowania pod brakujący etap (spec etapu przeglądu lekcji): po partii głównej
 * i regule ujawnień każde zagadnienie przebiegu z brakiem pokrycia dostaje jedno wywołanie
 * zamawiające dokładnie braki etapów. Własny zakres kontroli z resztą budżetu przebiegu
 * i miękkim limitem żądania: błąd albo przekroczenie limitu kończy rundę bez wpływu na run
 * (zostaje to, co już przyjęte). Anulowanie (edycja rodzica, zamknięcie procesu) przechodzi
 * dalej. Przykłady z odpowiedzi rundy są pomijane.
 */
async function stageTopUpRound(ctx: StageTopUpContext): Promise<{
  added: LessonExerciseDraft[];
  rejectedCount: number;
  rejectedReasons: Record<string, number>;
}> {
  const { runId, subject, topic, input } = ctx;
  const kept: LessonExerciseDraft[] = [...ctx.kept];
  const added: LessonExerciseDraft[] = [];
  let rejectedCount = 0;
  let rejectedReasons: Record<string, number> = {};
  const deficitsOf = (objectiveId: string) =>
    stageDeficits({ subject, exercises: [...ctx.existingDrafts, ...kept], examples: ctx.examples, objectiveIds: ctx.objectiveOrder }, objectiveId);
  const total = (deficits: StageDeficits) => deficits.guided + deficits.productive + deficits.independent;
  if (!ctx.objectiveIds.some((objectiveId) => total(deficitsOf(objectiveId)) > 0)) {
    return { added, rejectedCount, rejectedReasons };
  }
  const byExercise = subject.poolDeduplication === "exercise";
  const identityOptions = lessonIdentityOptionsOf(subject);
  const runStimuli = [...ctx.runStimuli];
  const runAnswers = [...ctx.runAnswers];
  try {
    await withLessonGenerationControl({
      ...ctx.policy,
      runTimeoutMs: Math.max(1, ctx.runDeadlineAtMs - Date.now()),
      signal: ctx.signal,
      assertCurrent: ctx.assertCurrent,
    }, async (control) => {
      for (const objectiveId of ctx.objectiveIds) {
        const deficits = deficitsOf(objectiveId);
        const count = total(deficits);
        if (count === 0) continue;
        if (ctx.runDeadlineAtMs - Date.now() < ctx.policy.requestTimeoutMs + STAGE_TOP_UP_MARGIN_MS) {
          console.log(`[lesson] run=${runId} dogenerowanie pod etap: pominięte: brak czasu`);
          return;
        }
        const existing = [...ctx.existingDrafts, ...kept];
        // Wybór ze słuchu to dodatek partii głównej, nie etap: runda go nie zamawia.
        const { listenChoicePerObjective: _listen, ...base } = buildPoolInput(
          subject,
          topic,
          objectiveId,
          count,
          input.material,
          input.instruction,
          ctx.graderAvailable,
          byExercise ? [] : [...new Set([...existing.map((exercise) => exercise.answer), ...runAnswers])],
          byExercise ? uniqueStimuli([...existing.map((exercise) => lessonExerciseStimulusRecord(exercise, identityOptions)), ...runStimuli]) : [],
          input.interests,
          { avoidSentences: avoidSentencesFor({ examples: mergeExamples(ctx.examples, ctx.cardSources), exercises: existing, subject }), purpose: "stage_top_up" },
        );
        const poolInput: LessonPoolInput = { ...base, countPerObjective: count, stageCounts: { ...deficits } };
        // callSoft sam sprawdza aktualność runu przed żądaniem i po nim.
        const result = await control.callSoft((signal) => ctx.llm.generateLessonPool(poolInput, signal));
        const scoped = filterExercisesToRequestedObjective(result.exercises, objectiveId);
        const metadata = collectBatchExerciseMetadata(scoped.exercises, byExercise, identityOptions);
        runAnswers.push(...metadata.answers);
        runStimuli.push(...metadata.exerciseRecords);
        const fresh = acceptFreshLessonPool({
          rawExercises: scoped.exercises,
          subject,
          topic,
          material: input.material,
          familyScope: `${runId}-t`,
          existingDrafts: existing,
          existingAnswers: new Set(existing.map((exercise) => exercise.answer)),
          existingExerciseIdentities: new Set(existing.map((exercise) => lessonExerciseIdentity(exercise, identityOptions))),
          // Bez kwot etapów: przycięcie do braków robi niżej trimToStageDeficits.
          objectiveLimits: new Map([[objectiveId, { count, listen: 0 }]]),
        });
        const trimmed = trimToStageDeficits(fresh.accepted, deficits);
        const leaks = resolveGenerationLeaks({
          existing,
          fresh: trimmed.kept,
          existingExamples: ctx.examples,
          newExamples: {},
          fixedSources: ctx.cardSources,
          objectiveOrder: ctx.objectiveOrder,
          subject,
        });
        const orphans = withoutOrphanKeywords(existing, leaks.keptFresh);
        kept.push(...orphans.kept);
        added.push(...orphans.kept);
        const leakRejected = leaks.droppedFresh.length;
        rejectedCount += fresh.shapeRejected + scoped.outOfScopeCount + fresh.refineRejected + fresh.rejected.length +
          trimmed.rejected.length + fresh.duplicateCount + leakRejected + orphans.dropped;
        rejectedReasons = sumRejectedReasons(
          sumRejectedReasons(rejectedReasons, fresh.refinedReasons),
          {
            ...reasonCount(EXPOSURE_LEAK_REASON, leakRejected),
            ...reasonCount(ORPHAN_KEYWORDS_REASON, orphans.dropped),
          },
        );
        console.log(
          `[lesson] run=${runId} dogenerowanie pod etap: zagadnienie=${objectiveId.split(".").at(-1)} guided=${deficits.guided} productive=${deficits.productive} independent=${deficits.independent} przyjęte=${orphans.kept.length}`,
        );
      }
    });
  } catch (error) {
    if (error instanceof LessonGenerationCancelledError) throw error;
    console.error(`[lesson] run=${runId} dogenerowanie pod etap: błąd=${classifyLessonGenerationFailure(error).errorCode}`);
  }
  return { added, rejectedCount, rejectedReasons };
}

/** Bieżąca próba runu puli: straż zapisu (stan `running`, ta sama próba i ten sam numer edycji szkicu). */
export interface LessonRunIdentity {
  readonly runId: string;
  readonly attempts: number;
  readonly expectedEditNumber: number;
  readonly deckVersionId: string;
}

/** Wynik próby zapisywany do `lesson_context` szkicu (liczniki tej próby; zapis sumuje je z poprzednim kontekstem). */
export interface LessonPoolWriteContext {
  readonly dynamicTopic?: DynamicTopicData;
  readonly newExamples: Record<string, string[]>;
  /** Odrzucenia tej próby; sumowane z licznikiem poprzedniego kontekstu (wspólny zapis dolicza kolizje z historyjką i słowa kluczowe). */
  readonly rejectedCount: number;
  readonly rejectedReasons: Record<string, number>;
  readonly droppedObjectiveCount: number;
}

/**
 * Dodatkowe pola kontekstu szkicu (ścieżka agenta), w transakcji zapisu: `written` = ćwiczenia zapisane do
 * szkicu po odrzuceniach samego zapisu (kolizje z historyjką, słowa kluczowe bez rodziny); puste przy porażce.
 */
type LessonContextExtension = (next: LessonContext, written: readonly LessonExerciseDraft[]) => LessonContext;

type LessonPoolWriteOutcome = "succeeded" | "failed_validation" | "superseded" | "gone";

/**
 * Przejście bieżącej próby runu puli (straż: `running`, ta sama próba, ten sam numer edycji).
 * Zegar jawnie, jak w `markRun` — `finishedAt` z zegara usług (testy sterują czasem).
 * `superseded` zeruje punkt kontrolny agenta (run anulowany nie wraca); porażka go
 * zostawia do „Ponów” (spec etapu 2a §8.1).
 */
export async function markLessonRun(
  db: Executor,
  clock: Clock,
  run: LessonRunIdentity,
  state: "failed" | "succeeded" | "superseded" | "queued",
  errorCode: string | null,
  nextAttemptAt: Date | null = null,
): Promise<void> {
  const result = await db.update(generationRuns).set({
    state,
    errorCode,
    nextAttemptAt,
    finishedAt: state === "queued" ? null : clock.now(),
    ...(state === "superseded" ? { agentCheckpoint: null } : {}),
  })
    .where(and(eq(generationRuns.id, run.runId), eq(generationRuns.state, "running"), eq(generationRuns.attempts, run.attempts), eq(generationRuns.expectedEditNumber, run.expectedEditNumber)));
  // Logujemy tylko realne przejście (WHERE może dopasować 0 wierszy, np. gdy
  // równoległy retry rodzica podbił expectedEditNumber).
  if ((result as { rowCount?: number }).rowCount !== 0) {
    console.log(
      `[lesson] run=${run.runId} ${state === "queued" ? "ponowienie" : "zakończony"}: state=${state} kod=${errorCode ?? "-"} próba=${run.attempts}`,
    );
  }
}

/**
 * Kontekst szkicu po porażce walidacji: liczniki próby (plus odrzucenia samego zapisu) zsumowane
 * z poprzednimi.
 */
function failedValidationContext(
  prevContext: LessonContext,
  context: LessonPoolWriteContext,
  writeRejected: number,
  rejectedReasons: Record<string, number>,
  extendContext: LessonContextExtension | undefined,
): LessonContext {
  const next: LessonContext = {
    ...prevContext,
    rejectedCount: (prevContext.rejectedCount ?? 0) + context.rejectedCount + writeRejected,
    ...(Object.keys(rejectedReasons).length > 0 ? { rejectedReasons } : {}),
    droppedObjectiveCount: (prevContext.droppedObjectiveCount ?? 0) + context.droppedObjectiveCount,
  };
  return extendContext === undefined ? next : extendContext(next, []);
}

/**
 * Porażka walidacji (0 nowych ćwiczeń): nawet wtedy rodzic widzi skalę odrzuceń — zapisujemy
 * liczniki do kontekstu (ta sama straż wersji co przy finalizacji).
 * `onTransaction` (ścieżka agenta) działa w tej samej transakcji, przed zmianą stanu runu.
 */
export async function failLessonPoolValidation(
  services: Services,
  args: {
    run: LessonRunIdentity;
    context: LessonPoolWriteContext;
    extendContext?: LessonContextExtension;
    onTransaction?: (tx: Tx) => Promise<void>;
  },
): Promise<void> {
  const { run } = args;
  await services.db.transaction(async (tx) => {
    const version = (
      await tx.select().from(deckVersions).where(eq(deckVersions.id, run.deckVersionId)).for("update")
    )[0];
    if (version && version.state !== "published" && version.editNumber === run.expectedEditNumber) {
      const prevContext = (version.lessonContext ?? {}) as unknown as LessonContext;
      const rejectedReasons = sumRejectedReasons(prevContext.rejectedReasons, args.context.rejectedReasons);
      const nextContext = failedValidationContext(prevContext, args.context, 0, rejectedReasons, args.extendContext);
      await tx
        .update(deckVersions)
        .set({ lessonContext: nextContext as unknown as Record<string, unknown> })
        .where(eq(deckVersions.id, version.id));
    }
    await args.onTransaction?.(tx);
    await markLessonRun(tx, services.clock, run, "failed", "validation");
  });
}

/**
 * Wspólny zapis puli do szkicu (potok i ścieżka agenta): jedna transakcja pod blokadami wersja → run.
 * Straże (bieżąca próba, termin finalizacji, wersja szkicu), odrzucenie kolizji z historyjką i słów
 * kluczowych bez rodziny, zapis ćwiczeń, `lesson_context` z licznikami zsumowanymi z poprzednimi,
 * uzgodnienie mediów, podbicie numeru edycji, anulowanie innych runów, kolejka historyjki, stan
 * wersji `review` i sukces runu. `onSuccessTransaction` tylko w gałęzi sukcesu, przed podbiciem numeru edycji
 * (bez niego — potok — sukces zeruje `agent_checkpoint`);
 * `onFailedValidationTransaction` tylko w gałęzi porażki walidacji (zapis odrzucił wszystko), przed zmianą
 * stanu runu.
 * „superseded” zwraca też, gdy run nie jest już bieżącą próbą (wtedy bez zmiany stanu runu).
 */
export async function finalizeLessonPoolWrite(
  services: Services,
  args: {
    run: LessonRunIdentity;
    subject: SubjectModule;
    topicVersion: number | undefined;
    regenerate: boolean;
    existingDrafts: readonly LessonExerciseDraft[];
    accepted: readonly LessonExerciseDraft[];
    context: LessonPoolWriteContext;
    /** Ścieżka agenta: dodatkowe pola kontekstu i zapisy w tej samej transakcji (sukces albo porażka walidacji). */
    extendContext?: LessonContextExtension;
    onSuccessTransaction?: (tx: Tx) => Promise<void>;
    onFailedValidationTransaction?: (tx: Tx) => Promise<void>;
    finalizationDeadlineAtMs: number;
    signal?: AbortSignal;
  },
): Promise<LessonPoolWriteOutcome> {
  const { run, subject, context } = args;
  return services.db.transaction(async (tx): Promise<LessonPoolWriteOutcome> => {
    const version = (
      await tx.select().from(deckVersions).where(eq(deckVersions.id, run.deckVersionId)).for("update")
    )[0];
    const current = (await tx.select().from(generationRuns).where(eq(generationRuns.id, run.runId)).for("update"))[0];
    if (!current || current.state !== "running" || current.attempts !== run.attempts || current.expectedEditNumber !== run.expectedEditNumber) {
      return "superseded";
    }
    assertLessonGenerationFinalizationAllowed(args.finalizationDeadlineAtMs, args.signal);
    if (!version) {
      await markLessonRun(tx, services.clock, run, "failed", "deck_version_gone");
      return "gone";
    }
    if (version.state === "published" || version.editNumber !== run.expectedEditNumber) {
      await markLessonRun(tx, services.clock, run, "superseded", null);
      return "superseded";
    }
    const prevContext = (version.lessonContext ?? {}) as unknown as LessonContext;
    // Pula zapisywana do lekcji z historyjką (dogenerowanie, ale też pełny run):
    // ćwiczenie, którego rozwiązanie powtarza zdanie historyjki, ujawniłoby
    // odpowiedź (bariera ekspozycji, spec historyjki §5). Historyjka z tej
    // transakcji — rodzic mógł ją zmienić.
    const story = prevContext.story;
    const withoutStoryCollisions = story
      ? args.accepted.filter((ex) => storyCollisions(story.sentences, solvedSentencesOf([ex]), subject.normalizer).length === 0)
      : args.accepted;
    const storyRejected = args.accepted.length - withoutStoryCollisions.length;
    if (storyRejected > 0) {
      console.log(`[lesson] run=${run.runId} kolizje z historyjką: odrzucone=${storyRejected}`);
    }
    // Kolizja mogła usunąć całą rodzinę pytań otwartych — jej słowa kluczowe odpadają razem z nią.
    const writeOrphans = withoutOrphanKeywords(args.existingDrafts, withoutStoryCollisions);
    const accepted = writeOrphans.kept;
    const writeRejected = storyRejected + writeOrphans.dropped;
    const rejectedReasons = sumRejectedReasons(
      sumRejectedReasons(prevContext.rejectedReasons, context.rejectedReasons),
      reasonCount(ORPHAN_KEYWORDS_REASON, writeOrphans.dropped),
    );
    if (accepted.length === 0) {
      const failedContext = failedValidationContext(prevContext, context, writeRejected, rejectedReasons, args.extendContext);
      await tx
        .update(deckVersions)
        .set({ lessonContext: failedContext as unknown as Record<string, unknown> })
        .where(eq(deckVersions.id, version.id));
      await args.onFailedValidationTransaction?.(tx);
      await markLessonRun(tx, services.clock, run, "failed", "validation");
      return "failed_validation";
    }
    await applyLessonExercises(
      tx,
      { id: version.id, deckId: version.deckId },
      subject,
      args.topicVersion,
      accepted,
    );
    // Uzupełnienie lesson_context: przykłady i licznik odrzuconych (sumujemy przy
    // dogenerowaniu). lesson_context jest niezmienny dopiero po publikacji.
    // Pełna generacja zastępuje pulę: luki poprzedniego generowania agentem są nieaktualne (ścieżka
    // agenta dopisuje bieżące w `extendContext`); dogenerowanie zostawia luki innych zagadnień.
    const { generationGaps: _staleGaps, ...prevWithoutGaps } = prevContext;
    const baseContext: LessonContext = {
      ...(args.regenerate ? prevContext : prevWithoutGaps),
      ...(context.dynamicTopic ? { dynamicTopic: context.dynamicTopic, objectiveIds: context.dynamicTopic.objectives.map((o) => o.id) } : {}),
      examples: { ...prevContext.examples, ...context.newExamples },
      rejectedCount: (prevContext.rejectedCount ?? 0) + context.rejectedCount + writeRejected,
      ...(Object.keys(rejectedReasons).length > 0 ? { rejectedReasons } : {}),
      droppedObjectiveCount: (prevContext.droppedObjectiveCount ?? 0) + context.droppedObjectiveCount,
    };
    const nextContext = args.extendContext === undefined ? baseContext : args.extendContext(baseContext, accepted);
    await tx
      .update(deckVersions)
      .set({ lessonContext: nextContext as unknown as Record<string, unknown> })
      .where(eq(deckVersions.id, version.id));
    await reconcileDraftAssetsTx(tx, services, version);
    // Zapis ścieżki agenta w tej samej transakcji (wiersz runu zablokowany wyżej). Potok czyści punkt
    // kontrolny: postęp agenta z wcześniejszej próby (przedmiot zdjęty z listy agenta) to treść ćwiczeń,
    // która po sukcesie nie ma już zastosowania.
    if (args.onSuccessTransaction !== undefined) {
      await args.onSuccessTransaction(tx);
    } else {
      await tx.update(generationRuns).set({ agentCheckpoint: null }).where(eq(generationRuns.id, run.runId));
    }
    const nextEditNumber = version.editNumber + 1;
    await tx.update(deckVersions).set({ editNumber: nextEditNumber }).where(eq(deckVersions.id, version.id));
    if (args.regenerate) {
      // Dogenerowanie celu nie anuluje runu historyjki (spec §6.2).
      await supersedeLessonRuns(tx, version.id, services.clock.now(), run.runId);
    } else {
      // Nowa pula: stara historyjka w toku jest nieaktualna; zlecamy nową
      // (tylko przedmiot z `lessonStory` i tylko gdy wersja nie ma historyjki).
      await supersedeLessonRuns(tx, version.id, services.clock.now(), run.runId, { includeStoryRuns: true });
      if (nextContext.story === undefined) {
        await queueLessonStoryRunTx(
          tx,
          services,
          { ...version, editNumber: nextEditNumber, lessonContext: nextContext as unknown as Record<string, unknown> },
          `lesson-story:${run.runId}`,
        );
      }
    }
    if (version.state !== "review") {
      await tx.update(deckVersions).set({ state: "review" }).where(eq(deckVersions.id, version.id));
    }
    await markLessonRun(tx, services.clock, run, "succeeded", null);
    return "succeeded";
  });
}

/**
 * Tożsamość runu w bazie (partie, runda pod etap, kierownik agenta): edycja rodzica, retry albo
 * publikacja ją zmieniają — run nadal `running` w tej próbie, a wersja szkicu ma ten numer edycji.
 */
export async function lessonRunIsCurrent(db: Executor, run: LessonRunIdentity): Promise<boolean> {
  const [current] = await db.select({ state: generationRuns.state, attempts: generationRuns.attempts, expectedEditNumber: generationRuns.expectedEditNumber })
    .from(generationRuns).where(eq(generationRuns.id, run.runId));
  const [version] = await db.select({ editNumber: deckVersions.editNumber, state: deckVersions.state })
    .from(deckVersions).where(eq(deckVersions.id, run.deckVersionId));
  return current?.state === "running" && current.attempts === run.attempts &&
    current.expectedEditNumber === run.expectedEditNumber && version?.state !== "published" &&
    version?.editNumber === run.expectedEditNumber;
}

/**
 * Etap zagadnień przedmiotu dynamicznego bez planera (szkoła; potok i ścieżka agenta): jedno żądanie
 * `generateLessonObjectives`, budowa i walidacja tematu jak przy zapisie. `droppedObjectiveCount` —
 * zagadnienia odrzucone przy budowie (panel rodzica).
 */
export async function generateDynamicObjectives(
  llm: LlmProvider,
  control: LessonGenerationControl,
  subject: SubjectModule,
  input: LessonRunInput,
): Promise<{ data: DynamicTopicData; droppedObjectiveCount: number }> {
  await control.assertCurrent();
  const objectivesResult = await control.call((signal) =>
    llm.generateLessonObjectives(
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
  return { data: withSubjectObjectiveKinds(subject, built.data), droppedObjectiveCount: built.errors.length };
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
  if (isStoryRunInput(run.input)) {
    return executeLessonStoryGeneration(services, runId, options);
  }
  if (run.state !== "queued") {
    return;
  }

  const attempts = await claimQueuedRun(services.db, runId, run.expectedEditNumber!, services.clock.now());
  if (attempts === null) {
    return;
  }
  const runStartedAtMs = Date.now();
  const lessonRun: LessonRunIdentity = { runId, attempts, expectedEditNumber: run.expectedEditNumber!, deckVersionId: run.deckVersionId! };
  const markCurrentRun = (db: Executor, state: "failed" | "succeeded" | "superseded" | "queued", errorCode: string | null, nextAttemptAt: Date | null = null) =>
    markLessonRun(db, services.clock, lessonRun, state, errorCode, nextAttemptAt);
  const input = run.input as unknown as LessonRunInput;
  const subject = services.subjects.getSubject(input.subjectId);
  // Wybór ścieżki przy każdej próbie (spec etapu 2a §3), z rejestru bez I/O. Agent sam rozlicza limit
  // prób (wyczerpane próby z postępem → zapis bez wywołań modelu), więc wybór zapada przed nim.
  if (subject !== undefined && lessonGeneratorFor(subject, deps.lessonAgent) === "agent") {
    if (!(await lessonRunIsCurrent(services.db, lessonRun))) {
      await markCurrentRun(services.db, "superseded", null);
      return;
    }
    await executeLessonAgentGeneration(services, {
      run,
      attempts,
      subject,
      input,
      runStartedAtMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return;
  }
  if (attempts > MAX_AUTOMATIC_ATTEMPTS) {
    await markCurrentRun(services.db, "failed", "attempts_exhausted");
    return;
  }

  // Do not spend an LLM request on a run invalidated by a parent edit/retry.
  // The final write still rechecks the edit number under a row lock.
  const currentVersion = (await services.db.select({ editNumber: deckVersions.editNumber, state: deckVersions.state, lessonContext: deckVersions.lessonContext })
    .from(deckVersions).where(eq(deckVersions.id, run.deckVersionId!)))[0];
  if (!currentVersion || currentVersion.state === "published" || currentVersion.editNumber !== run.expectedEditNumber) {
    await markCurrentRun(services.db, "superseded", null);
    return;
  }

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
  // Szkic przed partiami (poza transakcją; zapis i tak sprawdza editNumber pod blokadą,
  // więc edycja rodzica w międzyczasie unieważnia run): przykłady kart i ćwiczenia szkicu
  // dla reguły ujawnionych rozwiązań. Dogenerowanie dopisuje do szkicu: krzyżowa reguła
  // ćwiczeń słuchowych też widzi ćwiczenia już w szkicu (inaczej konflikt zdania
  // z odpowiedzią tekstową wyszedłby dopiero przy publikacji).
  const draftContext = (currentVersion.lessonContext ?? {}) as unknown as Partial<LessonContext>;
  const draftExamples: Record<string, string[]> = draftContext.examples ?? {};
  const existingDrafts = input.regenerate ? await orderedDraftExercises(services.db, input.deckVersionId) : [];

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
  // Ćwiczenia wcześniejszych partii jako szkice (rozwiązania do listy zdań do unikania).
  const earlierDrafts: LessonExerciseDraft[] = [];
  // Limity celów runu (zamówiona liczba i przyznany dodatek słuchowy) — egzekwowane po walidacji.
  const objectiveLimits = new Map<string, ObjectiveGenerationLimits>();
  const examples: Record<string, string[]> = {};
  // Zdania z kart rozdziału (ustawiane po rozwiązaniu tematu): dziecko widzi je jako gotowe rozwiązania.
  // Idą tylko do podpowiedzi `avoidSentences` i jako stałe źródła reguły twardej — nie do zapisanych
  // przykładów ani pokrycia.
  let cardSources: Record<string, string[]> = {};
  const executionPolicy = deps.lessonExecution ?? DEFAULT_LESSON_GENERATION_POLICY;
  const runDeadlineAtMs = runStartedAtMs + executionPolicy.runTimeoutMs;
  // Tożsamość runu w bazie (partie i runda pod etap): edycja rodzica, retry albo publikacja ją zmieniają.
  const runIsCurrent = (): Promise<boolean> => lessonRunIsCurrent(services.db, lessonRun);
  console.log(
    `[lesson] generacja run=${runId} deck=${input.deckId} cele=${batches.length} próba=${attempts} pula=${input.poolSize} model=${deps.llm.model}`,
  );
  try {
    await withLessonGenerationControl({
      ...executionPolicy,
      signal: options.signal,
      assertCurrent: runIsCurrent,
    }, async (control) => {
    if (needsDynamicObjectives) {
      const objectivesStage = await generateDynamicObjectives(deps.llm, control, subject, input);
      const storedData = objectivesStage.data;
      dynamicTopicData = storedData;
      topic = subject.buildDynamicTopic!(storedData);
      batches = batchesForObjectives(storedData.objectives.map((objective) => objective.id), input.poolSize, subject, runId);
      console.log(`[lesson] run=${runId} etap zagadnień: cele=${batches.length}`);
      droppedObjectiveCount = objectivesStage.droppedObjectiveCount;
      if (droppedObjectiveCount > 0) {
        console.log(`[lesson] run=${runId} etap zagadnień: porzucone=${droppedObjectiveCount}`);
      }
    }
    const activeTopic = topic;
    if (!activeTopic) {
      throw new AppError("validation", { message: "lesson topic unresolved" });
    }
    cardSources = cardExposureSources(subject, activeTopic);
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
        {
          // Rozwiązania widziane wcześniej (przykłady kart, szkic i wcześniejsze partie): generator ich nie
          // powtarza w ćwiczeniach samodzielnych — podpowiedź, egzekwuje ją reguła twarda po generacji.
          avoidSentences: avoidSentencesFor({
            examples: mergeExamples(mergeExamples(draftExamples, examples), cardSources),
            exercises: [...existingDrafts, ...earlierDrafts],
            subject,
          }),
        },
      );
      // Kwoty etapów tylko przy pełnej generacji: przy dogenerowaniu `stageCounts` dzieli same nowe
      // ćwiczenia i nie zna braków szkicu, więc mogłyby odrzucić akurat brakujący etap — tam decyduje kolejność.
      objectiveLimits.set(batch.objectiveId, {
        count: batch.count,
        listen: poolInput.listenChoicePerObjective ?? 0,
        ...(input.regenerate ? {} : { stages: poolInput.stageCounts }),
      });
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
      earlierDrafts.push(...scoped.exercises.filter(isWellShapedRawExercise).map(toExerciseDraft));
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
    if (!topic) {
      await markCurrentRun(services.db, "failed", "validation");
      return;
    }
    const fresh = acceptFreshLessonPool({
      rawExercises,
      subject,
      topic,
      material: input.material,
      familyScope: input.regenerate ? runId : null,
      existingDrafts,
      existingAnswers: new Set(batches.flatMap((b) => b.existingAnswers)),
      existingExerciseIdentities: new Set(batches.flatMap((b) => b.existingExercises).map((exercise) =>
        JSON.stringify([exercise.objectiveId, exercise.exerciseType, exercise.stimulus]),
      )),
      objectiveLimits,
    });
    const { shapeRejected, droppedAcceptedVariants, droppedExplanations, rejected } = fresh;
    const dupAgainstExisting = fresh.duplicateCount;
    // Reguła twarda (spec etapu przeglądu §5.2): świeże ćwiczenie samodzielne z rozwiązaniem
    // widocznym wcześniej (przykład karty, ćwiczenie niesamodzielne) odpada; ćwiczenia szkicu
    // są nietykalne — odpadają wtedy świeże źródła i nowe przykłady.
    const objectiveOrder = input.regenerate ? (draftContext.objectiveIds ?? input.objectiveIds) : batches.map((batch) => batch.objectiveId);
    // Końcowe przykłady kart: nowe przykłady ujawniające istniejące ćwiczenie odpadają (nie zależy od świeżych ćwiczeń).
    const finalExamples: Record<string, string[]> = {
      ...draftExamples,
      ...resolveGenerationLeaks({ existing: existingDrafts, fresh: [], existingExamples: draftExamples, newExamples: examples, objectiveOrder, subject }).keptNewExamples,
    };
    const leaks = resolveGenerationLeaks({
      existing: existingDrafts,
      fresh: fresh.accepted,
      existingExamples: draftExamples,
      newExamples: examples,
      fixedSources: cardSources,
      objectiveOrder,
      subject,
    });
    // Słowa kluczowe, których rodzina pytań otwartych odpadła (reguła twarda, przycięcie), też odpadają.
    const orphans = withoutOrphanKeywords(existingDrafts, leaks.keptFresh);
    let uniqueValid = orphans.kept;
    const leakRejected = leaks.droppedFresh.length;
    let rejectedCount = shapeRejected + outOfScopeCount + fresh.refineRejected + rejected.length + dupAgainstExisting +
      leakRejected + orphans.dropped;
    let runRejectedReasons = sumRejectedReasons(fresh.refinedReasons, {
      ...reasonCount(EXPOSURE_LEAK_REASON, leakRejected),
      ...reasonCount(ORPHAN_KEYWORDS_REASON, orphans.dropped),
    });

    console.log(
      `[lesson] run=${runId} walidacja puli: ${summarizeLessonPoolValidation({
        rawCount: rawExerciseCount,
        shapeRejected,
        outOfScopeCount,
        rejectedExerciseCount: rejected.length,
        rejectedErrors: rejected.flatMap((item) => item.errors),
        duplicateCount: dupAgainstExisting,
        validCount: uniqueValid.length,
        refineRejected: fresh.refineRejected,
      })}`,
    );
    if (leakRejected > 0 || leaks.droppedExampleCount > 0) {
      console.log(`[lesson] run=${runId} ujawnienia: usunięte=${leakRejected} przykłady=${leaks.droppedExampleCount}`);
    }
    if (orphans.dropped > 0) {
      console.log(`[lesson] run=${runId} słowa kluczowe bez rodziny pytań otwartych: usunięte=${orphans.dropped}`);
    }
    // Porzucone warianty redundantne nie są odrzuceniem (nie trafiają do
    // rejectedCount ani podsumowania) — sama linia z licznikiem, bez treści
    // wariantów, żeby incydenty tej klasy były widoczne w logach workera.
    if (droppedAcceptedVariants > 0) {
      console.log(`[lesson] run=${runId} sanityzacja wariantów: porzucone=${droppedAcceptedVariants}`);
    }
    if (droppedExplanations > 0) {
      console.log(`[lesson] run=${runId} porzucone wyjaśnienia=${droppedExplanations}`);
    }

    // Wynik próby do kontekstu szkicu — liczniki czytane w chwili zapisu (runda pod etap je zwiększa).
    const writeContext = (): LessonPoolWriteContext => ({
      ...(dynamicTopicData ? { dynamicTopic: dynamicTopicData } : {}),
      newExamples: leaks.keptNewExamples,
      rejectedCount,
      rejectedReasons: runRejectedReasons,
      droppedObjectiveCount,
    });
    // Porażka walidacji (0 nowych ćwiczeń): liczniki i tak trafiają do kontekstu.
    const failValidation = () => failLessonPoolValidation(services, { run: lessonRun, context: writeContext() });

    // Runda pod brakujący etap (spec etapu przeglądu lekcji): po regule ujawnień, przed zapisem.
    // Pełna generacja bez przyjętych ćwiczeń kończy się porażką bez rundy; ręczne dogenerowanie
    // do niepustego szkicu dostaje rundę także wtedy, gdy partia główna nic nie dała.
    const stageTopUpEnabled = executionPolicy.stageTopUp !== false;
    if (uniqueValid.length === 0 && !(stageTopUpEnabled && existingDrafts.length > 0)) {
      await failValidation();
      return;
    }
    if (stageTopUpEnabled) {
      const topUp = await stageTopUpRound({
        runId,
        llm: deps.llm,
        subject,
        topic,
        input,
        graderAvailable,
        policy: executionPolicy,
        runDeadlineAtMs,
        signal: options.signal,
        assertCurrent: runIsCurrent,
        objectiveIds: batches.map((batch) => batch.objectiveId),
        objectiveOrder,
        existingDrafts,
        kept: uniqueValid,
        examples: finalExamples,
        cardSources,
        runStimuli: earlierExercises,
        runAnswers: earlierAnswers,
      });
      uniqueValid = [...uniqueValid, ...topUp.added];
      rejectedCount += topUp.rejectedCount;
      runRejectedReasons = sumRejectedReasons(runRejectedReasons, topUp.rejectedReasons);
    }
    if (uniqueValid.length === 0) {
      await failValidation();
      return;
    }

    await finalizeLessonPoolWrite(services, {
      run: lessonRun,
      subject,
      topicVersion: input.topicVersion,
      regenerate: Boolean(input.regenerate),
      existingDrafts,
      accepted: uniqueValid,
      context: writeContext(),
      finalizationDeadlineAtMs: runDeadlineAtMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    console.log(`[lesson] run=${runId} zakończony durationMs=${Date.now() - runStartedAtMs}`);
  } catch (error) {
    // Nieprzewidziany wyjątek walidacji/zapisu NIE może zostawić runu „running”.
    // Rozliczamy terminalnie: wyczerpane próby → attempts_exhausted, inaczej
    // validation (błąd kształtu/treści puli, nie błąd przejściowy providera).
    if (error instanceof LessonGenerationCancelledError) {
      // Anulowanie rundy pod etap (edycja rodzica, zamknięcie procesu) — nie jest błędem zapisu.
      if (error.reason === "shutdown") await markCurrentRun(services.db, "queued", null, null);
      return;
    }
    console.error(`[lesson] run=${runId} nieprzewidziany błąd walidacji/zapisu: kod=validation_or_write`);
    if (classifyLessonGenerationFailure(error).errorCode === "provider_timeout") {
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
      // Aktywny run historyjki nie blokuje dogenerowania (spec §6.2).
      const activeRun = (await tx.select({ id: generationRuns.id }).from(generationRuns).where(and(
        eq(generationRuns.kind, "lesson"),
        eq(generationRuns.deckVersionId, version.id),
        inArray(generationRuns.state, ["queued", "running"]),
        lessonPoolRunFilter(),
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
