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
import { isLessonAgentAvailable, type Clock, type Services } from "../../../config";
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
import { explanationTextErrors } from "../../../domain/lessons/exercise-explanation";
import { lessonExerciseTargetKey } from "../../../domain/lessons/exposure-key";
import { DISTINCT_OPEN_ANSWERS_PER_OBJECTIVE } from "../../../domain/lessons/lesson-coverage";
import {
  DEFAULT_LESSON_POLICY,
  defaultPoolSize,
  type StageMix,
} from "../../../domain/lessons/lesson-policy";
import { materialCreationMode } from "../../../domain/lessons/material-creation";
import { keywordsAnswer } from "../../../domain/lessons/pool-validation";
import { hasLenientRawShape } from "../../../domain/lessons/raw-shape";
import { familyRunSuffix, withoutOrphanKeywords } from "../../../domain/lessons/keyword-families";
import { messagesOf } from "../../../domain/lessons/rules/catalog";
import { lessonRuleBook, ruleBookContextFor, ruleTextContextOf } from "../../../domain/lessons/rules/rule-book";
import {
  lessonExerciseStimulus,
  lessonIdentityOptionsOf,
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
import { validateDynamicTopicData } from "../../../domain/lessons/topic-resolution";
import {
  claimQueuedRun,
  enqueueGenerationRun,
  isStoryRunInput,
  lessonPoolRunFilter,
  supersedeLessonRuns,
  type LESSON_STORY_PURPOSE,
} from "../generation-runs";
import { requireGeneration } from "../generation-runtime";
import { assertLessonGenerationFinalizationAllowed, type LessonGenerationControl } from "./lesson-generation-control";
import { executeLessonAgentGeneration } from "./lesson-agent-generation";
import { reconcileDraftAssetsTx } from "../media-reconciliation";
import { committedRetryAfterSourceChange, lockSourceMaterialForCopy } from "../source-materials";
import { buildLessonPayload } from "./lesson-payload";
import { executeLessonStoryGeneration, queueLessonStoryRunTx } from "./lesson-story-generation";

/**
 * Generowanie i zapis szkicu lekcji (design „Generowanie puli (worker)”).
 * `createLesson` tworzy deck lekcji + wersję draft + run `lesson` idempotentnie
 * (wspólny `enqueueGenerationRun` ze ścieżką słówek). `executeLessonGeneration`
 * przejmuje run i przekazuje go agentowi puli (`executeLessonAgentGeneration`,
 * jedyny generator od etapu 3 #237); wspólny zapis `finalizeLessonPoolWrite`
 * dopisuje przyjęte ćwiczenia pod blokadą wersji, przechodząc `draft → review`.
 * Ścieżka słówek pozostaje nietknięta: ten moduł nie dotyka `applyItems` ani
 * VOCABULARY_SKILLS.
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
  /** Oczyszczenia agenta puli przy przyjmowaniu (`hintsRemoved`, `variantsRemoved`, `quotesSnapped`), sumowane między przebiegami; same liczby. */
  cleanupCounts?: Record<string, number>;
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
  /**
   * Dogenerowanie jednego celu: nowe ćwiczenia dopisujemy, nie czyścimy. Runy z kolejki sprzed etapu 3
   * mogą mieć tu jeszcze pola potoku (odpowiedzi i bodźce istniejących ćwiczeń) — wejście jest
   * rzutowane, agent ich nie czyta.
   */
  regenerate?: { objectiveId: string; count: number };
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
 * Podział liczby ćwiczeń celu na etapy (`targets` kierownika agenta). Rachunek dzieli
 * etap samodzielny z pytaniami otwartymi, a te mają twarde minimum publikacji — gdy
 * etap samodzielny ma tylko tyle miejsc, ile wynosi minimum, jedno miejsce przechodzi
 * z etapu produktywnego (o ile ten zachowa swoje minimum). Łączna liczba bez zmian.
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
 * Liczby ćwiczeń per cel. Zamówiona pula dzieli się dokładnie (część
 * całkowita + reszta), więc suma liczb celów jej nie przekracza. Wyjątek: gdy pula
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

/** Najwięcej ćwiczeń `lesson_listen_choice` na cel w szkicu — dodatek ponad podział etapów (decyzja #198). */
const LISTEN_CHOICE_PER_OBJECTIVE = 2;

/** Powód odrzucenia świeżych słów kluczowych, których rodzina pytań otwartych odpadła (klucz `rejectedReasons`). */
const ORPHAN_KEYWORDS_REASON = "ćwiczenie bez rodziny pytań otwartych";

/**
 * Ile ćwiczeń słuchowych generator może jeszcze dodać do celu: limit na cel minus ćwiczenia
 * słuchowe tego celu już obecne (`present`; agent podaje `[]` i ćwiczenia szkicu odejmuje sam). 0, gdy przedmiot
 * nie nagrywa zdań albo typ nie leży na liście celu.
 */
export function listenChoiceAllowance(
  subject: SubjectModule,
  objective: { id: string; exerciseTypes: readonly string[] },
  present: readonly LessonExerciseStimulus[],
): number {
  if (!listenChoiceAvailable(subject, objective)) return 0;
  const listened = present.filter((exercise) => exercise.objectiveId === objective.id && exercise.exerciseType === "lesson_listen_choice").length;
  return Math.max(0, LISTEN_CHOICE_PER_OBJECTIVE - listened);
}

/** Czy cel może mieć ćwiczenia `lesson_listen_choice`: przedmiot nagrywa zdania, a typ leży na liście przedmiotu i celu. */
function listenChoiceAvailable(subject: SubjectModule, objective: { exerciseTypes: readonly string[] }): boolean {
  return subject.ttsForFeedbackSentence && subject.exerciseTypes.includes("lesson_listen_choice") && objective.exerciseTypes.includes("lesson_listen_choice");
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
  interests?: readonly string[],
  options: { readonly avoidSentences?: readonly string[] } = {},
): LessonPoolInput {
  // Tematy i reguła ich użycia idą do modelu razem albo wcale (reguła należy do przedmiotu).
  const interestsRule = subject.prompts.interestsRule;
  const withInterests = interestsRule !== undefined && interests !== undefined && interests.length > 0;
  const objective = topic.objectives.find((o) => o.id === objectiveId)!;
  const listenAllowance = listenChoiceAllowance(subject, objective, []);
  // Księga reguł: typy celu (bez wyboru ze słuchu, gdy cel go nie dostaje — prompt go wtedy nie wymienia)
  // i dostępność typu słuchowego, nie wolne miejsce w przydziale (reguły puli dotyczą też istniejących zdań).
  const listenChoice = listenChoiceAvailable(subject, objective);
  const ruleTypes = objective.exerciseTypes.filter((type) => listenChoice || type !== "lesson_listen_choice");
  const ruleBook = lessonRuleBook(subject, ruleBookContextFor(subject, topic.id, objective.id, ruleTypes, listenChoice));
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
    // Wybór ze słuchu to dodatek poza podziałem etapów i liczbą ćwiczeń celu: tylko przedmiot z nagraniami zdań
    // i cel, którego lista zawiera typ (ćwiczenia słuchowe już w szkicu odejmuje agent w swoich limitach).
    ...(listenAllowance > 0 ? { listenChoicePerObjective: listenAllowance } : {}),
    ...(subject.usesV3Payload === true ? { minDistinctOpenAnswers: DISTINCT_OPEN_ANSWERS_PER_OBJECTIVE } : {}),
    graderAvailable,
    groundingRequired: subject.sourceQuotes === true,
    answerMaxLength: ruleTextContextOf(subject).answerMaxLength,
    deduplication: subject.poolDeduplication ?? "answer",
    voiceTones: subject.ttsForPrompts === true,
    exerciseExplanations: subject.exerciseExplanations,
    ...(options.avoidSentences !== undefined && options.avoidSentences.length > 0 ? { avoidSentences: [...options.avoidSentences] } : {}),
    ruleBook,
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
  const suffix = familyRunSuffix(runId);
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
    if (errs && errs.length > 0) extraRejected.push({ exercise: draft, errors: messagesOf(errs) });
    else kept.push(draft);
  });
  return { kept, extraRejected };
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
 * Czy surowy obiekt ma bezpieczny KSZTAŁT do walidacji semantycznej (łagodny
 * strażnik punktu kontrolnego, dzisiejsza semantyka — `hasLenientRawShape` w
 * domenie). Rekord o złym kształcie jest odrzucany (liczony do `rejectedCount`),
 * nie rzuca. Nie maskuje realnych błędów treści — sprawdza wyłącznie kształt pól,
 * które faza semantyczna dereferencuje. Ścieżka agenta ze zgłoszeniami reguł:
 * `rawShapeIssues` (`domain/lessons/raw-shape.ts`).
 */
export function isWellShapedRawExercise(raw: unknown): boolean {
  return hasLenientRawShape(raw);
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
 * zapis jest celowo osobny (udokumentowane w raporcie).
 */
export async function applyLessonExercises(
  tx: Tx,
  version: { id: string; deckId: string },
  subject: SubjectModule,
  topicVersion: number | undefined,
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
  /** Oczyszczenia tej próby (ścieżka agenta); sumowane z poprzednim kontekstem jak `rejectedReasons`. */
  readonly cleanupCounts?: Record<string, number>;
  readonly droppedObjectiveCount: number;
}

/** Kontekst z doliczonymi oczyszczeniami próby; bez nich (albo same zera) pole zostaje, jakie było. */
function withCleanupCounts(next: LessonContext, prev: LessonContext, added: Record<string, number> | undefined): LessonContext {
  const cleanupCounts = sumRejectedReasons(prev.cleanupCounts, added ?? {});
  return Object.values(cleanupCounts).some((count) => count > 0) ? { ...next, cleanupCounts } : next;
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
  const next = withCleanupCounts({
    ...prevContext,
    rejectedCount: (prevContext.rejectedCount ?? 0) + context.rejectedCount + writeRejected,
    ...(Object.keys(rejectedReasons).length > 0 ? { rejectedReasons } : {}),
    droppedObjectiveCount: (prevContext.droppedObjectiveCount ?? 0) + context.droppedObjectiveCount,
  }, prevContext, context.cleanupCounts);
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
 * Wspólny zapis puli agenta do szkicu: jedna transakcja pod blokadami wersja → run.
 * Straże (bieżąca próba, termin finalizacji, wersja szkicu), odrzucenie kolizji z historyjką i słów
 * kluczowych bez rodziny, zapis ćwiczeń, `lesson_context` z licznikami zsumowanymi z poprzednimi,
 * uzgodnienie mediów, podbicie numeru edycji, anulowanie innych runów, kolejka historyjki, stan
 * wersji `review` i sukces runu. `onSuccessTransaction` (podsumowanie punktu kontrolnego) tylko w gałęzi
 * sukcesu, przed podbiciem numeru edycji;
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
    /** Dodatkowe pola kontekstu i zapisy w tej samej transakcji (sukces albo porażka walidacji). */
    extendContext?: LessonContextExtension;
    onSuccessTransaction: (tx: Tx) => Promise<void>;
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
    const baseContext = withCleanupCounts({
      ...(args.regenerate ? prevContext : prevWithoutGaps),
      ...(context.dynamicTopic ? { dynamicTopic: context.dynamicTopic, objectiveIds: context.dynamicTopic.objectives.map((o) => o.id) } : {}),
      examples: { ...prevContext.examples, ...context.newExamples },
      rejectedCount: (prevContext.rejectedCount ?? 0) + context.rejectedCount + writeRejected,
      ...(Object.keys(rejectedReasons).length > 0 ? { rejectedReasons } : {}),
      droppedObjectiveCount: (prevContext.droppedObjectiveCount ?? 0) + context.droppedObjectiveCount,
    }, prevContext, context.cleanupCounts);
    const nextContext = args.extendContext === undefined ? baseContext : args.extendContext(baseContext, accepted);
    await tx
      .update(deckVersions)
      .set({ lessonContext: nextContext as unknown as Record<string, unknown> })
      .where(eq(deckVersions.id, version.id));
    await reconcileDraftAssetsTx(tx, services, version);
    // Zapis ścieżki agenta w tej samej transakcji (wiersz runu zablokowany wyżej).
    await args.onSuccessTransaction(tx);
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
 * Tożsamość runu w bazie (kierownik agenta, przejęcie runu): edycja rodzica, retry albo
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
 * Etap zagadnień przedmiotu dynamicznego bez planera (szkoła; ścieżka agenta): jedno żądanie
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
  if (subject === undefined) {
    await markCurrentRun(services.db, "failed", "validation");
    return;
  }
  // Agent jest jedynym generatorem puli (etap 3): bez jego zależności (brak klucza OpenRouter) run kończy się
  // od razu po przejęciu — bez odczytu punktu kontrolnego i bez wywołań modeli; „Ponów” po dodaniu klucza go wznawia.
  const lessonAgent = deps.lessonAgent;
  if (!isLessonAgentAvailable(lessonAgent)) {
    await markCurrentRun(services.db, "failed", "lesson_agent_unavailable");
    return;
  }
  if (!(await lessonRunIsCurrent(services.db, lessonRun))) {
    await markCurrentRun(services.db, "superseded", null);
    return;
  }
  // Agent sam rozlicza limit prób (wyczerpane próby z postępem → zapis bez wywołań modelu).
  await executeLessonAgentGeneration(services, {
    run,
    attempts,
    subject,
    input,
    agent: lessonAgent,
    runStartedAtMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

/**
 * Dogenerowanie ćwiczeń jednego celu w istniejącym szkicu (design „Generowanie
 * puli”). Nowy run `lesson` z zagadnieniem i liczbą; agent czyta ćwiczenia szkicu
 * przy wykonaniu, dopisuje nowe, nie usuwa istniejących. Idempotentne po `clientRequestId`.
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
      if (!services.subjects.getSubject(context.subjectId)) throw new AppError("validation", { message: "unknown subject" });
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
        regenerate: { objectiveId: args.objectiveId, count: args.count },
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
