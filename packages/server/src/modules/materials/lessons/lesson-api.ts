import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  ChildInterestsSchema,
  LessonDynamicTopicPatchSchema,
  LessonExerciseInputSchema,
  LessonStorySchema,
  type AssignmentDto,
  type CoverageGapDto,
  type ExposureLeakDto,
  type GenerationDto,
  type LessonDeckDto,
  type LessonDraftDto,
  type LessonExerciseInput,
  type LessonGenerationGapDto,
  type LessonReviewDto,
  type LessonStoryDto,
  type SubjectCatalogDto,
} from "@learning/contracts";
import type { Services } from "../../../config";
import type { Executor, Tx } from "../../../db/client";
import {
  assignments,
  childProfiles,
  deckVersions,
  decks,
  itemRevisionSkills,
  itemRevisions,
  learningItems,
  mediaAssets,
  revisionAssets,
  skillVersions,
} from "../../../db/schema";
import { AppError } from "../../../errors";
import { lessonExerciseTargetKey } from "../../../domain/lessons/exposure-key";
import { findExposureLeaks } from "../../../domain/lessons/exposure-leaks";
import { lessonCoverageGaps, lessonPoolMinimums } from "../../../domain/lessons/lesson-coverage";
import { materialCreationMode, requiresParentSubjectTitle } from "../../../domain/lessons/material-creation";
import { poolCoverage, validatePool, withoutRedundantAcceptedVariants } from "../../../domain/lessons/pool-validation";
import { solvedSentencesOf, validateLessonStory, type LessonStory } from "../../../domain/lessons/story";
import type { DynamicTopicData, LessonExerciseDraft, LessonTopic, SubjectModule } from "../../../domain/lessons/types";
import { resolveLessonTopic, validateDynamicTopicData } from "../../../domain/lessons/topic-resolution";
import { statusFromObjectives, type LessonReviewReport } from "../../../domain/lessons/review-report";
import { assertAssetPublishable, mediaPendingError, reconcileBeforePublish, reconcileDraftAssetsTx, reconcileLessonStoryAssetTx } from "../media-reconciliation";
import { copyRevisionsSkillsAssets } from "../decks";
import { supersedeFailedLessonStoryRuns, supersedeLessonRuns } from "../generation-runs";
import { readDeckSource } from "../source-materials";
import {
  assertEditable,
  bumpEditNumber,
  createVersionFromPublished,
  lockVersion,
} from "../version-ops";
import { buildObjectiveCriteria, lessonPayloadVersion, splitByPoolExtra, toExerciseDraft, type LessonGenerationGap } from "./lesson-drafts";
import { buildLessonPayload } from "./lesson-payload";
import { latestLessonRunOfPurpose, latestLessonStoryRun } from "./lesson-story-generation";
import { readLessonAudioStates } from "./lesson-prompt-audio";
import { exerciseFingerprint } from "./lesson-fingerprint";

/**
 * API rodzica dla lekcji (zadanie 11). Cienka logika serwerowa za routerem:
 * katalog przedmiotów, odczyt zestawu-lekcji, edycja ćwiczeń szkicu z walidacją
 * per ćwiczenie i zachowaniem/odnowieniem kluczy `objective`, publikacja z
 * wymogiem pokrycia etapów, oraz nowa wersja z opublikowanej. Mechaniki wspólne
 * z zestawami słówek (blokada wersji, optimistic locking, nowy szkic z
 * opublikowanej, kopia rewizji/umiejętności/mediów) pochodzą z `version-ops.ts`
 * i `decks.ts` — ten moduł dokłada tylko to, co specyficzne dla lekcji (zapis
 * ćwiczeń, walidacja puli, pokrycie).
 */

/** Pola `lesson_context` czytane przez API rodzica. */
interface LessonContextView {
  subjectId: string;
  topicId: string;
  topicVersion: number;
  objectiveIds: string[];
  examples: Record<string, string[]>;
  rejectedCount: number;
  rejectedReasons?: Record<string, number>;
  droppedObjectiveCount?: number;
  material: string;
  subjectTitlePl?: string;
  dynamicTopic?: DynamicTopicData;
  /** Historyjka na koniec sesji (przedmioty z `lessonStory`). */
  story?: LessonStory;
  /** Migawka tematów zdań (przedmioty z `interestsRule`); brak klucza = bez tematów. */
  interests?: string[];
  /** Raport automatycznej kontroli jakości szkicu (PR 2 etapu przeglądu); brak = bez raportu. */
  review?: LessonReviewReport;
  /** Zagadnienia do uzupełnienia po częściowym generowaniu agentem puli; brak klucza = pula pełna. */
  generationGaps?: LessonGenerationGap[];
}

export function readLessonContext(raw: Record<string, unknown> | null): LessonContextView {
  const ctx = (raw ?? {}) as Partial<LessonContextView>;
  return {
    subjectId: ctx.subjectId ?? "",
    topicId: ctx.topicId ?? "",
    topicVersion: ctx.topicVersion ?? 1,
    objectiveIds: ctx.objectiveIds ?? [],
    examples: ctx.examples ?? {},
    rejectedCount: ctx.rejectedCount ?? 0,
    ...(ctx.rejectedReasons && Object.keys(ctx.rejectedReasons).length > 0 ? { rejectedReasons: ctx.rejectedReasons } : {}),
    ...(ctx.droppedObjectiveCount ? { droppedObjectiveCount: ctx.droppedObjectiveCount } : {}),
    material: ctx.material ?? "",
    ...(ctx.subjectTitlePl ? { subjectTitlePl: ctx.subjectTitlePl } : {}),
    ...(ctx.dynamicTopic ? { dynamicTopic: ctx.dynamicTopic } : {}),
    ...(ctx.story ? { story: ctx.story } : {}),
    ...(ctx.interests?.length ? { interests: [...ctx.interests] } : {}),
    ...(ctx.review ? { review: ctx.review } : {}),
    ...(ctx.generationGaps?.length ? { generationGaps: ctx.generationGaps } : {}),
  };
}

/**
 * Luki generowania agentem dla rodzica: tylko edytowalny szkic (wersja opublikowana jest niezmienna,
 * rodzic nie ma czego uzupełnić) i tylko zagadnienia bieżącego tematu (rodzic mógł usunąć zagadnienie —
 * jego luki nie da się uzupełnić, jak wpisów raportu kontroli jakości); kopia bez współdzielenia obiektów z kontekstem.
 */
export function generationGapsDto(context: LessonContextView, published: boolean): LessonGenerationGapDto[] | undefined {
  if (published) return undefined;
  const inTopic = new Set(context.objectiveIds);
  const gaps = (context.generationGaps ?? []).filter((gap) => inTopic.has(gap.objectiveId));
  if (gaps.length === 0) return undefined;
  return gaps.map((gap) => ({
    objectiveId: gap.objectiveId,
    reason: gap.reason,
    ...(gap.added === undefined ? {} : { added: gap.added }),
    ...(gap.requested === undefined ? {} : { requested: gap.requested }),
  }));
}

/**
 * Raport kontroli jakości dla rodzica: `changed`/`notes` tylko dla ćwiczeń, które są w wersji
 * i których zapisany payload ma ten sam odcisk co przy kontroli (po edycji rodzica wpis jest
 * nieaktualny); zagadnienia, usunięcia i dogenerowania tylko dla zagadnień bieżącego tematu (rodzic mógł
 * usunąć zagadnienie), z tytułami zamiast identyfikatorów i statusem liczonym od nowa; bez odcisków.
 * `undefined`, gdy kontrola była wyłączona dla wszystkich (pozostałych) zagadnień (zachowanie jak bez krytyka).
 */
function reviewDto(
  report: LessonReviewReport,
  currentFingerprints: ReadonlyMap<string, string>,
  objectiveTitles: ReadonlyMap<string, string>,
): LessonReviewDto | undefined {
  const inTopic = (entry: { objectiveId: string }) => objectiveTitles.has(entry.objectiveId);
  const title = (objectiveId: string) => objectiveTitles.get(objectiveId)!;
  const objectives = report.objectives.filter(inTopic);
  if (objectives.every((objective) => objective.reason === "disabled")) return undefined;
  const current = (entry: { exerciseId: string; fingerprint: string }) => currentFingerprints.get(entry.exerciseId) === entry.fingerprint;
  return {
    status: statusFromObjectives(objectives),
    ...(report.model === undefined ? {} : { model: report.model }),
    objectives: objectives.map((objective) => ({
      objectiveId: objective.objectiveId,
      title: title(objective.objectiveId),
      status: objective.status,
      ...(objective.reason === undefined ? {} : { reason: objective.reason }),
    })),
    changed: report.changed.filter(current).map((entry) => ({
      exerciseId: entry.exerciseId,
      category: entry.category,
      reasonPl: entry.reasonPl,
      beforePl: entry.beforePl,
      addedVariants: [...entry.addedVariants],
    })),
    dropped: report.dropped.filter(inTopic).map((entry) => ({
      objectiveTitle: title(entry.objectiveId),
      category: entry.category,
      reasonPl: entry.reasonPl,
      snippet: entry.snippet,
    })),
    notes: report.notes.filter(current).map((entry) => ({
      exerciseId: entry.exerciseId,
      category: entry.category,
      reasonPl: entry.reasonPl,
      fixRejected: entry.fixRejected,
    })),
    toppedUp: report.toppedUp.filter(inTopic).reduce((sum, entry) => sum + entry.guided + entry.productive + entry.independent, 0),
  };
}

/** Historyjka domeny → DTO (kopia, bez współdzielenia tablic `readonly`). */
function storyDto(story: LessonStory): LessonStoryDto {
  return {
    sentences: [...story.sentences],
    questions: story.questions.map((question) => ({
      id: question.id,
      question: question.question,
      options: question.options.map((option) => ({ id: option.id, text: option.text })),
      correctOption: question.correctOption,
    })),
  };
}

/** Bariera ekspozycji i reguły historyjki wobec puli; błędy → `validation` z `details.story`. */
function assertStoryValid(subject: SubjectModule, story: LessonStory, drafts: readonly LessonExerciseDraft[]): void {
  const errors = validateLessonStory(story, { normalizer: subject.normalizer, solvedSentences: solvedSentencesOf(drafts) });
  if (errors.length > 0) {
    throw new AppError("validation", { details: { story: errors } });
  }
}

/** Przedmiot z rejestru lub `validation` — wersja opublikowana przypina rejestr. */
function requireSubject(services: Services, subjectId: string): SubjectModule {
  const subject = services.subjects.getSubject(subjectId);
  if (!subject) {
    throw new AppError("validation", { message: `unknown subject: ${subjectId}` });
  }
  return subject;
}

/** Temat przypięty w `lesson_context` wersji (katalogowy lub dynamiczny), lub `validation`. */
function requireTopic(services: Services, context: LessonContextView): LessonTopic {
  const topic = resolveLessonTopic(services.subjects, context)?.topic;
  if (!topic) {
    throw new AppError("validation", { message: `unknown topic: ${context.subjectId}/${context.topicId}@${context.topicVersion}` });
  }
  return topic;
}

/**
 * Katalog przedmiotów do formularza rodzica: najnowsze wersje tematów, tylko
 * identyfikatory, polskie tytuły i karty wyjaśnienia (bez pól modelowych). Źródło: wstrzyknięty
 * rejestr przedmiotów (`services.subjects`).
 */
function offersListenChoice(subject: SubjectModule): boolean {
  return subject.ttsForFeedbackSentence === true && subject.exerciseTypes.includes("lesson_listen_choice");
}

/**
 * Usługi widoczne dla rodzica przy przedmiocie obsługiwanym przez agenta puli (spec etapu 2a §11):
 * model agenta, a gdy do `UMIEM_LLM` idzie etap zagadnień (temat dynamiczny bez planera z polityki)
 * albo run historyjki (przedmiot z `lessonStory`), także ta usługa; drugi model (checker) i informacja, czy dostaje materiał. Przedmiot poza listą
 * agenta albo bez polityki — bez pól (obowiązuje katalogowe `generationService`).
 */
function agentServicesOf(services: Services, subject: SubjectModule) {
  const agent = services.lessonAgentPublic;
  const policy = subject.agentPolicy;
  if (!agent || !policy || !agent.subjects.has(subject.id)) return {};
  const stageService = services.generationService;
  const topicsFromMaterial = materialCreationMode(subject) !== undefined && policy.planCoverage === undefined;
  // Krok poza agentem z materiałem lekcji: etap zagadnień albo run historyjki po nowej puli (oba przez `UMIEM_LLM`).
  const stageStepRuns = topicsFromMaterial || subject.lessonStory === true;
  const generationServices = stageStepRuns && stageService && stageService !== agent.generationService
    ? [agent.generationService, stageService]
    : [agent.generationService];
  return {
    generationServices,
    checkService: agent.checkService,
    checkServiceIncludesMaterial: policy.checkerNeedsMaterial,
    // ocena odpowiedzi próbnych do pytań otwartych: tylko przedmiot z takimi typami i skonfigurowany grader
    ...(policy.openAnswerCheckTypes?.length && agent.openCheckService ? { openCheckService: agent.openCheckService } : {}),
  };
}

export function lessonCatalog(services: Services): SubjectCatalogDto {
  return {
    ...(services.generationService ? { generationService: services.generationService } : {}),
    ...(services.reviewService ? { reviewService: services.reviewService } : {}),
    subjects: services.subjects.listSubjects().map((subject) => {
      const latestByTopic = new Map<string, LessonTopic>();
      for (const topic of subject.topics) {
        const current = latestByTopic.get(topic.id);
        if (!current || topic.version > current.version) {
          latestByTopic.set(topic.id, topic);
        }
      }
      return {
        id: subject.id,
        titlePl: subject.titlePl,
        // Zagadnienia z materiału rodzica zamiast tematów katalogowych; nazwę przedmiotu podaje rodzic tylko tam, gdzie moduł tego chce.
        // Te same reguły stosują polecenia tworzenia (`material-creation`), więc formularz nie obiecuje ścieżki odrzucanej przez serwer.
        creation: materialCreationMode(subject) === undefined ? "catalog" as const : "material" as const,
        subjectTitleRequired: requiresParentSubjectTitle(subject),
        // Formularz pokazuje tematy zdań tylko tam, gdzie przedmiot ma regułę w prompcie.
        acceptsInterests: subject.prompts.interestsRule !== undefined,
        // Te same warunki co przydział dodatku słuchowego w generacji (`listenChoiceAllowance`).
        offersListenChoice: offersListenChoice(subject),
        ...agentServicesOf(services, subject),
        topics: [...latestByTopic.values()].map((topic) => ({
          id: topic.id,
          version: topic.version,
          titlePl: topic.titlePl,
          objectives: topic.objectives.map((objective) => ({
            id: objective.id,
            titlePl: objective.titlePl,
            cards: objective.cards.map((card) => ({ title: card.title, body: card.body })),
            offersListenChoice: offersListenChoice(subject) && objective.exerciseTypes.includes("lesson_listen_choice"),
          })),
        })),
      };
    }),
  };
}

/** DTO ćwiczenia z payloadu rewizji (payload lekcji → `LessonExerciseInput` + revisionId). */
function exerciseDtoFromPayload(
  itemId: string,
  revisionId: string,
  payload: Record<string, unknown>,
): LessonDraftDto["exercises"][number] {
  const draft = toExerciseDraft(payload);
  return {
    id: itemId,
    revisionId,
    exerciseType: draft.exerciseType,
    objectiveId: draft.objectiveId,
    ...(draft.instructionPl === undefined ? {} : { instructionPl: draft.instructionPl }),
    ...(draft.stem === undefined ? {} : { stem: draft.stem }),
    ...(draft.statement === undefined ? {} : { statement: draft.statement }),
    ...(draft.prompt === undefined ? {} : { prompt: draft.prompt }),
    ...(draft.hint === undefined ? {} : { hint: draft.hint }),
    ...(draft.explanationPl === undefined ? {} : { explanationPl: draft.explanationPl }),
    ...(draft.transformId === undefined ? {} : { transformId: draft.transformId }),
    ...(draft.noticeSegments === undefined
      ? {}
      : { noticeSegments: draft.noticeSegments.map((s) => [...s]) }),
    ...(draft.visualSubject === undefined ? {} : { visualSubject: draft.visualSubject }),
    answer: draft.answer,
    acceptedAnswers: [...draft.acceptedAnswers],
    focus: [...draft.focus],
    ...(draft.options === undefined ? {} : { options: draft.options.map((o) => ({ ...o })) }),
    ...(draft.correctOption === undefined ? {} : { correctOption: draft.correctOption }),
    ...(draft.items === undefined ? {} : { items: draft.items.map((o) => ({ ...o })) }),
    ...(draft.questionType === undefined ? {} : { questionType: draft.questionType }),
    ...(draft.requiredElements === undefined ? {} : { requiredElements: draft.requiredElements.map((el) => ({ ...el })) }),
    ...(draft.supplementaryElements === undefined ? {} : { supplementaryElements: [...draft.supplementaryElements] }),
    ...(draft.commonErrors === undefined ? {} : { commonErrors: [...draft.commonErrors] }),
    ...(draft.expectedForm === undefined ? {} : { expectedForm: draft.expectedForm }),
    ...(draft.familyId === undefined ? {} : { familyId: draft.familyId }),
    ...(draft.voiceTone === undefined ? {} : { voiceTone: draft.voiceTone }),
    ...(draft.sourceRefs === undefined ? {} : { sourceRefs: draft.sourceRefs.map((ref) => ({ ...ref })) }),
    ...(draft.calculation === undefined ? {} : { calculation: draft.calculation }),
    ...(draft.keywordOptions === undefined ? {} : { keywordOptions: draft.keywordOptions.map((o) => ({ ...o })) }),
    ...(draft.keyOptionIds === undefined ? {} : { keyOptionIds: [...draft.keyOptionIds] }),
    ...(draft.pairs === undefined ? {} : { pairs: draft.pairs.map((pair) => ({ ...pair })) }),
    ...(draft.extraRight === undefined ? {} : { extraRight: [...draft.extraRight] }),
    ...(draft.groups === undefined ? {} : { groups: draft.groups.map((group) => ({ ...group })) }),
    ...(draft.groupItems === undefined ? {} : { groupItems: draft.groupItems.map((item) => ({ ...item })) }),
    ...(draft.clozeText === undefined ? {} : { clozeText: draft.clozeText }),
    ...(draft.gapAnswers === undefined ? {} : { gapAnswers: [...draft.gapAnswers] }),
    ...(draft.extraWords === undefined ? {} : { extraWords: [...draft.extraWords] }),
  };
}

/** Buduje `LessonDraftDto` wersji (szkic lub opublikowana): ćwiczenia, pokrycie, media. */
async function readLessonDraftDto(
  db: Executor,
  services: Services,
  versionId: string,
): Promise<LessonDraftDto> {
  const version = (await db.select().from(deckVersions).where(eq(deckVersions.id, versionId)))[0];
  if (!version) {
    throw new AppError("not_found");
  }
  const context = readLessonContext(version.lessonContext);
  const revisions = await db
    .select()
    .from(itemRevisions)
    .where(eq(itemRevisions.deckVersionId, versionId))
    .orderBy(asc(itemRevisions.position));
  const revisionIds = revisions.map((r) => r.id);
  const assetRows = revisionIds.length && requireSubject(services, context.subjectId).ttsForAnswers
    ? await db
        .select({
          itemRevisionId: revisionAssets.itemRevisionId,
          role: revisionAssets.role,
          decisionState: revisionAssets.state,
          assetId: revisionAssets.assetId,
          assetState: mediaAssets.state,
        })
        .from(revisionAssets)
        .leftJoin(mediaAssets, eq(mediaAssets.id, revisionAssets.assetId))
        // Nagranie pytania (`prompt_audio`) nie jest decyzją rodzica ani warunkiem publikacji.
        .where(and(inArray(revisionAssets.itemRevisionId, revisionIds), eq(revisionAssets.role, "target_audio")))
    : [];

  // Stan nagrań pytań i kart do odsłuchu i „Nagraj ponownie” (spec tonu TTS §4.5) — nie są decyzją rodzica.
  const audio = await readLessonAudioStates(db, versionId, context.objectiveIds);
  const exercises = revisions.map((r) => {
    const dto = exerciseDtoFromPayload(r.itemId, r.id, r.payload);
    const promptAudio = audio.prompts.get(r.id);
    const explanationAudio = audio.explanations.get(r.id);
    // Zdanie ćwiczenia słuchowego: stan nagrania tylko dla `lesson_listen_choice`.
    const sentenceAudio = dto.exerciseType === "lesson_listen_choice" ? audio.sentences.get(r.id) : undefined;
    return {
      ...dto,
      ...(promptAudio ? { promptAudio } : {}),
      ...(explanationAudio ? { explanationAudio } : {}),
      ...(sentenceAudio ? { sentenceAudio } : {}),
    };
  });
  const drafts: LessonExerciseDraft[] = revisions.map((r) => toExerciseDraft(r.payload));
  const draftSubject = services.subjects.getSubject(context.subjectId);
  // Wersja opublikowana jest niezmienna: jej pokrycie liczymy jak przed regułą ujawnień
  // (bez wykluczeń i nowych braków), a publikacja szkicu nadal wyklucza ujawnione ćwiczenia.
  const published = version.state === "published";
  // Nieznany przedmiot: pokrycie z minimami domyślnymi, bez ujawnień (brak normalizatora do ich oceny).
  const coverage: CoverageGapDto[] = draftSubject
    ? lessonCoverageGaps({
        subject: draftSubject,
        exercises: drafts,
        examples: context.examples,
        objectiveIds: context.objectiveIds,
        ...(published ? { ignoreExposure: true } : {}),
      })
    : poolCoverage(drafts, context.objectiveIds, lessonPoolMinimums({}));
  // Ujawnione rozwiązania (spec etapu przeglądu lekcji §8): tylko edytowalny szkic — wersja opublikowana
  // jest niezmienna, więc rodzic nie ma czego poprawić; indeksy z domeny mapujemy na id ćwiczeń.
  // Miękkie powtórzenie w rodzinie pytań szkoły (ta sama rodzina w tym samym zagadnieniu) to zamierzona
  // struktura, nie błąd rodzica: bez ostrzeżenia, choć pokrycie nadal liczy rodzinę raz.
  const sameFamily = (a: LessonExerciseDraft, b: LessonExerciseDraft) =>
    a.objectiveId === b.objectiveId && a.familyId !== undefined && a.familyId.trim() !== "" && a.familyId === b.familyId;
  const exposureLeaks: ExposureLeakDto[] = draftSubject && !published
    ? findExposureLeaks({
        exercises: drafts,
        examples: context.examples,
        objectiveOrder: context.objectiveIds,
        subject: draftSubject,
        mode: "coverage",
      })
        .filter((leak) => !(leak.kind === "soft" && leak.source.kind === "exercise" && sameFamily(drafts[leak.index]!, drafts[leak.source.index]!)))
        .map((leak) => ({
          exerciseId: revisions[leak.index]!.itemId,
          kind: leak.kind,
          source: leak.source.kind === "card_example"
            ? { kind: "card_example" as const, objectiveId: leak.source.objectiveId }
            : { kind: "exercise" as const, exerciseId: revisions[leak.source.index]!.itemId },
        }))
    : [];
  // Raport kontroli jakości: tylko edytowalny szkic (wersja opublikowana jest niezmienna, rodzic nie ma czego poprawić).
  let review: LessonReviewDto | undefined;
  if (context.review && !published) {
    const titles = new Map((resolveLessonTopic(services.subjects, context)?.topic.objectives ?? []).map((o) => [o.id, o.titlePl] as const));
    review = reviewDto(
      context.review,
      new Map(revisions.map((r) => [r.itemId, exerciseFingerprint(r.payload)])),
      titles,
    );
  }

  const generationGaps = generationGapsDto(context, published);

  return {
    id: version.id,
    deckId: version.deckId,
    editNumber: version.editNumber,
    status: version.state as LessonDraftDto["status"],
    title: version.title,
    subjectId: context.subjectId,
    topicId: context.topicId,
    topicVersion: context.topicVersion,
    objectiveIds: [...context.objectiveIds],
    ...(draftSubject?.ttsForPrompts === true ? { voiceTones: { styleEnabled: services.media?.tts.style === "instructions" } } : {}),
    ...(draftSubject?.exerciseExplanations === true ? { exerciseExplanations: true as const } : {}),
    ...(context.subjectTitlePl === undefined ? {} : { subjectTitlePl: context.subjectTitlePl }),
    ...(context.interests?.length ? { interests: [...context.interests] } : {}),
    ...(context.dynamicTopic === undefined
      ? {}
      : {
          dynamicTopic: {
            titlePl: context.dynamicTopic.titlePl,
            objectives: context.dynamicTopic.objectives.map((o) => ({
              id: o.id,
              titlePl: o.titlePl,
              cards: o.cards.map((card) => ({
                title: card.title,
                body: card.body,
                ...(card.voiceTone === undefined ? {} : { voiceTone: card.voiceTone }),
              })),
              ...(o.kind === undefined ? {} : { kind: o.kind }),
            })),
          },
        }),
    examples: context.examples,
    exercises,
    ...(context.story ? { story: storyDto(context.story) } : {}),
    storyEnabled: draftSubject?.lessonStory === true,
    // Nagranie pytania, zdania feedbacku i wyjaśnienia błędu nie jest zasobem do decyzji rodzica (design szkoły §11.2).
    assets: assetRows.flatMap((a) => a.role === "prompt_audio" || a.role === "feedback_audio" || a.role === "explanation_audio" ? [] : [{
      itemRevisionId: a.itemRevisionId,
      role: a.role,
      state:
        a.decisionState === "omitted"
          ? "omitted"
          : a.assetState === "ready"
            ? "approved"
            : a.assetState === "failed"
              ? "failed"
              : "pending",
      assetId: a.assetId,
    }]),
    ...(audio.cards.length > 0 ? { cardAudio: audio.cards } : {}),
    // Nagranie lektora historyjki; brak pola = lekcja bez historyjki (albo bez nagrania).
    ...(audio.story ? { storyAudio: audio.story } : {}),
    rejectedCount: context.rejectedCount,
    ...(context.rejectedReasons ? { rejectedReasons: context.rejectedReasons } : {}),
    ...(context.droppedObjectiveCount ? { droppedObjectiveCount: context.droppedObjectiveCount } : {}),
    coverage,
    ...(exposureLeaks.length > 0 ? { exposureLeaks } : {}),
    ...(review ? { review } : {}),
    ...(generationGaps ? { generationGaps } : {}),
  };
}

/** Najnowszy run puli lekcji wskazanej wersji (polling panelu rodzica; bez runów historyjki). */
async function latestLessonRun(db: Executor, deckVersionId: string): Promise<GenerationDto | null> {
  return latestLessonRunOfPurpose(db, deckVersionId, "pool");
}

async function lessonAssignments(db: Executor, deckId: string): Promise<AssignmentDto[]> {
  return db
    .select({
      childId: assignments.childId,
      displayName: childProfiles.displayName,
      testDate: assignments.testDate,
      testGoals: assignments.testGoals,
      mockTestTaskCount: assignments.mockTestTaskCount,
      active: assignments.active,
    })
    .from(assignments)
    .innerJoin(childProfiles, eq(childProfiles.id, assignments.childId))
    .where(and(eq(assignments.deckId, deckId), eq(assignments.active, true)))
    .orderBy(asc(childProfiles.createdAt), asc(childProfiles.id));
}

/**
 * Pełny widok zestawu-lekcji (`GET /parent/lessons/:deckId`): szkic edytowalny,
 * opublikowana wersja, najnowszy run i przypisania. Nieznany zestaw → not_found;
 * zestaw słówek na tej ścieżce → `deck_kind_mismatch`.
 */
export async function readLessonDeck(services: Services, deckId: string): Promise<LessonDeckDto> {
  const id = z.uuid().parse(deckId);
  // Stan runu i zawartość szkicu muszą pochodzić z jednej migawki. Inaczej
  // polling może zobaczyć succeeded z pustą pulą i przestać odświeżać edytor.
  return services.db.transaction((tx) => readLessonDeckSnapshot(tx, services, id), { isolationLevel: "repeatable read", accessMode: "read only" });
}

async function readLessonDeckSnapshot(db: Executor, services: Services, id: string): Promise<LessonDeckDto> {
  const deck = (await db.select().from(decks).where(eq(decks.id, id)))[0];
  if (!deck) {
    throw new AppError("not_found");
  }
  if (deck.kind !== "lesson") {
    throw new AppError("deck_kind_mismatch", { message: "nie jest zestawem lekcji" });
  }
  const editable = (
    await db
      .select({ id: deckVersions.id })
      .from(deckVersions)
      .where(and(eq(deckVersions.deckId, id), inArray(deckVersions.state, ["draft", "review"])))
  )[0];
  const publishedVersionId = deck.publishedVersionId ?? null;
  const source = await readDeckSource(db, deck);
  const state: LessonDeckDto["state"] = deck.archivedAt
    ? "archived"
    : editable
      ? ((await db.select({ state: deckVersions.state }).from(deckVersions).where(eq(deckVersions.id, editable.id)))[0]!.state as "draft" | "review")
      : publishedVersionId
        ? "published"
        : "draft";
  return {
    id: deck.id,
    title: deck.title,
    state,
    sessionTaskBudget: deck.sessionTaskBudget,
    draft: editable ? await readLessonDraftDto(db, services, editable.id) : null,
    published: publishedVersionId ? await readLessonDraftDto(db, services, publishedVersionId) : null,
    generation: editable ? await latestLessonRun(db, editable.id) : null,
    // Run historyjki osobno: `generation` pokazuje tylko runy puli (spec §6.2).
    storyGeneration: editable ? await latestLessonStoryRun(db, editable.id) : null,
    assignments: await lessonAssignments(db, id),
    ...(source === undefined ? {} : { source }),
    // Wymaganie 10.1: provider oceny dowolnych odpowiedzi (nazwa modelu z
    // konfiguracji, bez sekretów). `available=false` steruje komunikatem rodzica.
    grading: services.grader ? { available: true, model: services.grader.provider.model } : { available: false },
    // Etykieta usługi kontroli jakości lekcji (bez sekretów); brak = kontrola wyłączona.
    ...(services.reviewService ? { reviewService: services.reviewService } : {}),
  };
}

/**
 * Deck id wersji lekcji (dla ścieżek operujących na `versionId`, a wołających
 * logikę po `deckId`, jak dogenerowanie celu). Nieznana wersja → not_found;
 * wersja słówek → `deck_kind_mismatch`.
 */
export async function deckIdOfLessonVersion(services: Services, versionId: string): Promise<string> {
  const id = z.uuid().parse(versionId);
  const row = (
    await services.db
      .select({ deckId: deckVersions.deckId, kind: decks.kind })
      .from(deckVersions)
      .innerJoin(decks, eq(decks.id, deckVersions.deckId))
      .where(eq(deckVersions.id, id))
  )[0];
  if (!row) {
    throw new AppError("not_found");
  }
  if (row.kind !== "lesson") {
    throw new AppError("deck_kind_mismatch", { message: "nie jest zestawem lekcji" });
  }
  return row.deckId;
}

/** Patch edycji ćwiczeń lekcji (jak `DraftPatch` słówek, ale pełna lista ćwiczeń). */
const LessonDraftPatchSchema = z.object({
  expectedEditNumber: z.number().int().positive(),
  title: z.string().min(1).max(200).optional(),
  exercises: z.array(LessonExerciseInputSchema).optional(),
  examples: z.record(z.string(), z.array(z.string())).optional(),
  dynamicTopic: LessonDynamicTopicPatchSchema.optional(),
  /** Historyjka: obiekt zastępuje, `null` usuwa, brak pola nie zmienia. */
  story: LessonStorySchema.nullable().optional(),
  /**
   * Historyjka, od której rodzic zaczął edycję (`null` = bez historyjki). Run historyjki
   * nie podbija `editNumber`, więc przy `story` serwer porównuje ją z bieżącą i przy
   * różnicy zwraca `conflict` (wynik runu z innej karty nie zostanie nadpisany po cichu).
   */
  expectedStory: LessonStorySchema.nullable().optional(),
  interests: ChildInterestsSchema.optional(),
}).refine(
  (p) =>
    p.title !== undefined || p.exercises !== undefined || p.examples !== undefined ||
    p.dynamicTopic !== undefined || p.story !== undefined || p.interests !== undefined,
  { message: "patch must change title, exercises, examples, dynamicTopic, story or interests" },
);
export type LessonDraftPatch = z.infer<typeof LessonDraftPatchSchema>;

/** Czy zmiana treści ćwiczenia tworzy nowy `objective` (odpowiedź/warianty/focus/kryteria v3). */
function objectiveImpacted(oldDraft: LessonExerciseDraft, next: LessonExerciseInput, subject: SubjectModule, topicVersion: number): boolean {
  const sameAnswer = oldDraft.answer === next.answer;
  const sameAccepted =
    JSON.stringify([...oldDraft.acceptedAnswers].sort()) === JSON.stringify([...next.acceptedAnswers].sort());
  const sameFocus = JSON.stringify([...oldDraft.focus]) === JSON.stringify([...next.focus]);
  const sameObjective = oldDraft.objectiveId === next.objectiveId;
  const sameRequired = JSON.stringify(oldDraft.requiredElements ?? null) === JSON.stringify(next.requiredElements ?? null);
  const sameV3Criteria =
    JSON.stringify(oldDraft.supplementaryElements ?? null) === JSON.stringify(next.supplementaryElements ?? null) &&
    JSON.stringify(oldDraft.commonErrors ?? null) === JSON.stringify(next.commonErrors ?? null) &&
    (oldDraft.expectedForm ?? null) === (next.expectedForm ?? null) &&
    (oldDraft.questionType ?? null) === (next.questionType ?? null) &&
    JSON.stringify((oldDraft.sourceRefs ?? []).map((r) => r.quote)) === JSON.stringify((next.sourceRefs ?? []).map((r) => r.quote));
  const sameGradingCriteria = buildObjectiveCriteria(oldDraft, subject, topicVersion).criteriaHash ===
    buildObjectiveCriteria(toExerciseDraft(next), subject, topicVersion).criteriaHash;
  return !(sameAnswer && sameAccepted && sameFocus && sameObjective && sameRequired && sameV3Criteria && sameGradingCriteria);
}

const TEMP_POSITION_OFFSET = 1000;

interface CurrentLessonRevision {
  revisionId: string;
  itemId: string;
  payload: Record<string, unknown>;
  objectiveSkillVersionId: string;
  objectiveRevisionNumber: number;
}

async function loadCurrentLessonRevisions(tx: Tx, versionId: string): Promise<CurrentLessonRevision[]> {
  const revisions = await tx
    .select()
    .from(itemRevisions)
    .where(eq(itemRevisions.deckVersionId, versionId))
    .orderBy(asc(itemRevisions.position));
  const result: CurrentLessonRevision[] = [];
  for (const r of revisions) {
    const skill = (
      await tx
        .select({
          skillVersionId: itemRevisionSkills.skillVersionId,
          revisionNumber: skillVersions.revisionNumber,
        })
        .from(itemRevisionSkills)
        .innerJoin(skillVersions, eq(skillVersions.id, itemRevisionSkills.skillVersionId))
        .where(and(eq(itemRevisionSkills.itemRevisionId, r.id), eq(itemRevisionSkills.skill, "objective")))
    )[0];
    result.push({
      revisionId: r.id,
      itemId: r.itemId,
      payload: r.payload,
      objectiveSkillVersionId: skill?.skillVersionId ?? "",
      objectiveRevisionNumber: skill?.revisionNumber ?? 1,
    });
  }
  return result;
}

/**
 * Nadpisuje ćwiczenia szkicu lekcji pełną listą (jak `applyItems` słówek, ale
 * dla jednej umiejętności `objective`). Dla istniejących (po `id`) zmiana
 * odpowiedzi/wariantów/`focus`/celu tworzy nową `skill_version` (predecessor +
 * revision_number+1); zmiana wyłącznie polecenia zachowuje klucz. Nowe ćwiczenia
 * (bez `id`) dostają nowy learning_item i skill_version. Usunięte znikają wraz
 * z powiązaniami. `target_key` z `lessonExerciseTargetKey` (domyślnie `computeTargetKey(answer, answerLocale)`).
 */
/** Ćwiczenie z patcha rodzica bez wariantów `acceptedAnswers` równoważnych odpowiedzi kanonicznej. */
function withoutRedundantInputVariants(input: LessonExerciseInput, subject: SubjectModule): LessonExerciseInput {
  const kept = withoutRedundantAcceptedVariants(toExerciseDraft(input), subject.normalizer).acceptedAnswers;
  return kept.length === input.acceptedAnswers.length ? input : { ...input, acceptedAnswers: [...kept] };
}

async function applyLessonExercisesEdit(
  tx: Tx,
  version: { id: string; deckId: string },
  subject: SubjectModule,
  topicVersion: number,
  exercises: readonly LessonExerciseInput[],
): Promise<void> {
  const current = await loadCurrentLessonRevisions(tx, version.id);
  const byItemId = new Map(current.map((c) => [c.itemId, c]));

  const referencedIds = new Set(exercises.map((e) => e.id).filter((id): id is string => id !== undefined));
  for (const id of referencedIds) {
    if (!byItemId.has(id)) {
      throw new AppError("validation", { message: `unknown exercise id: ${id}` });
    }
  }

  // Usuń ćwiczenia nieobecne na nowej liście (wraz z powiązaniami).
  for (const c of current) {
    if (!referencedIds.has(c.itemId)) {
      await tx.delete(revisionAssets).where(eq(revisionAssets.itemRevisionId, c.revisionId));
      await tx.delete(itemRevisionSkills).where(eq(itemRevisionSkills.itemRevisionId, c.revisionId));
      await tx.delete(itemRevisions).where(eq(itemRevisions.id, c.revisionId));
    }
  }

  for (const [position, ex] of exercises.entries()) {
    const tempPosition = TEMP_POSITION_OFFSET + position;
    const draft = toExerciseDraft(ex as unknown);
    const payload = buildLessonPayload(draft, subject);
    const targetKey = lessonExerciseTargetKey(subject, draft);

    if (ex.id) {
      const existing = byItemId.get(ex.id)!;
      const oldDraft = toExerciseDraft(existing.payload);
      let skillVersionId = existing.objectiveSkillVersionId;
      if (objectiveImpacted(oldDraft, ex, subject, topicVersion) || skillVersionId === "") {
        const { criteria, criteriaHash } = buildObjectiveCriteria(draft, subject, topicVersion);
        skillVersionId = randomUUID();
        await tx.insert(skillVersions).values({
          id: skillVersionId,
          itemId: existing.itemId,
          skill: "objective",
          revisionNumber: existing.objectiveRevisionNumber + 1,
          criteria,
          criteriaHash,
          ...(existing.objectiveSkillVersionId ? { predecessorId: existing.objectiveSkillVersionId } : {}),
        });
      }
      await tx
        .update(itemRevisions)
        .set({ payload, targetKey, position: tempPosition, payloadVersion: lessonPayloadVersion(draft, subject) })
        .where(eq(itemRevisions.id, existing.revisionId));
      await tx.delete(itemRevisionSkills).where(eq(itemRevisionSkills.itemRevisionId, existing.revisionId));
      await tx.insert(itemRevisionSkills).values({
        itemRevisionId: existing.revisionId,
        itemId: existing.itemId,
        skill: "objective",
        skillVersionId,
      });
    } else {
      const itemId = randomUUID();
      await tx.insert(learningItems).values({ id: itemId, deckId: version.deckId, kind: "lesson_exercise" });
      const { criteria, criteriaHash } = buildObjectiveCriteria(draft, subject, topicVersion);
      const skillVersionId = randomUUID();
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
        position: tempPosition,
        payloadVersion: lessonPayloadVersion(draft, subject),
        payload,
        targetKey,
      });
      await tx.insert(itemRevisionSkills).values({
        itemRevisionId: revisionId,
        itemId,
        skill: "objective",
        skillVersionId,
      });
    }
  }

  // Przesunięcie pozycji z powrotem do 0-based (omija UNIQUE podczas przepisania).
  const rewritten = await tx
    .select({ id: itemRevisions.id, position: itemRevisions.position })
    .from(itemRevisions)
    .where(eq(itemRevisions.deckVersionId, version.id))
    .orderBy(asc(itemRevisions.position));
  for (const [index, row] of rewritten.entries()) {
    if (row.position !== index) {
      await tx.update(itemRevisions).set({ position: index }).where(eq(itemRevisions.id, row.id));
    }
  }
}

/**
 * Edycja ćwiczeń szkicu lekcji. Waliduje każde ćwiczenie
 * (`validateLessonExercise`); jeśli którekolwiek niepoprawne → 400 z listą
 * błędów per ćwiczenie (`details.exercises`). Optimistic locking jak słówka:
 * published → immutable, zły editNumber → conflict. Po zapisie bump editNumber,
 * uzgodnienie mediów (TTS odpowiedzi) i zwrot `LessonDraftDto`.
 */
export async function editLessonDraft(
  services: Services,
  versionId: string,
  input: unknown,
): Promise<LessonDraftDto> {
  const patch = LessonDraftPatchSchema.parse(input);

  return services.db.transaction(async (tx) => {
    const version = await lockVersion(tx, versionId);
    assertEditable(version, patch.expectedEditNumber);
    const context = readLessonContext(version.lessonContext);
    const subject = requireSubject(services, context.subjectId);
    if (patch.story !== undefined && subject.lessonStory !== true) {
      throw new AppError("validation", { message: "story patch requires a subject with lesson story" });
    }
    if (patch.story !== undefined && patch.expectedStory !== undefined && !isDeepStrictEqual(patch.expectedStory, context.story ?? null)) {
      throw new AppError("conflict");
    }
    // Niepuste tematy zdań mają sens tylko tam, gdzie przedmiot ma regułę w prompcie (jak przy
    // tworzeniu lekcji); pusta lista (usunięcie) jest zawsze dozwolona.
    if (patch.interests?.length && subject.prompts.interestsRule === undefined) {
      throw new AppError("validation", { message: `subject does not support interests: ${subject.id}` });
    }

    // Patch tematu dynamicznego (zagadnienia z materiału): edycja tytułów/kart
    // istniejących celów i usuwanie celów przez pominięcie. `descriptionEn`
    // i `kind` (pola serwera) zachowujemy z zapisanego kontekstu; temat
    // walidujemy regułami katalogu.
    let nextDynamicTopic: DynamicTopicData | undefined;
    let deletedObjectiveIds: string[] = [];
    if (patch.dynamicTopic !== undefined) {
      if (!subject.buildDynamicTopic || !context.dynamicTopic) {
        throw new AppError("validation", { message: "dynamicTopic patch requires a dynamic lesson" });
      }
      const currentById = new Map(context.dynamicTopic.objectives.map((o) => [o.id, o]));
      for (const objective of patch.dynamicTopic.objectives) {
        if (!currentById.has(objective.id)) {
          throw new AppError("validation", { message: `unknown dynamic objective: ${objective.id}` });
        }
        // Ton lektora karty ma skutek tylko w przedmiocie z nagraniami (jak ton ćwiczenia w walidacji puli).
        if (!subject.ttsForPrompts && objective.cards.some((card) => card.voiceTone !== undefined)) {
          throw new AppError("validation", { message: `voiceTone requires a subject with recorded prompts: ${objective.id}` });
        }
      }
      nextDynamicTopic = {
        titlePl: context.dynamicTopic.titlePl,
        objectives: patch.dynamicTopic.objectives.map((objective) => {
          const current = currentById.get(objective.id)!;
          return {
            id: objective.id,
            titlePl: objective.titlePl,
            descriptionEn: current.descriptionEn,
            cards: objective.cards.map((card) => ({
              title: card.title,
              body: card.body,
              ...(card.voiceTone === undefined ? {} : { voiceTone: card.voiceTone }),
            })),
            ...(current.kind === undefined ? {} : { kind: current.kind }),
          };
        }),
      };
      const topicErrors = validateDynamicTopicData(subject, nextDynamicTopic);
      if (topicErrors.length > 0) {
        throw new AppError("validation", { message: topicErrors.join("; ") });
      }
      const keptIds = new Set(nextDynamicTopic.objectives.map((o) => o.id));
      deletedObjectiveIds = context.dynamicTopic.objectives.map((o) => o.id).filter((id) => !keptIds.has(id));
    }
    const effectiveContext: LessonContextView = nextDynamicTopic
      ? { ...context, dynamicTopic: nextDynamicTopic, objectiveIds: nextDynamicTopic.objectives.map((o) => o.id) }
      : context;

    // Historyjka bez patcha ćwiczeń: bariera ekspozycji wobec bieżącej puli
    // pomniejszonej o ćwiczenia usuwanych zagadnień (pula po tej edycji).
    if (patch.story && patch.exercises === undefined) {
      const rows = await tx
        .select({ payload: itemRevisions.payload })
        .from(itemRevisions)
        .where(eq(itemRevisions.deckVersionId, versionId));
      const remaining = rows
        .map((row) => toExerciseDraft(row.payload))
        .filter((draft) => !deletedObjectiveIds.includes(draft.objectiveId));
      assertStoryValid(subject, patch.story, remaining);
    }

    if (patch.exercises !== undefined) {
      const topic = requireTopic(services, effectiveContext);
      // Warianty równoważne odpowiedzi po normalizacji pomijamy jak przy generacji: nie zmieniają
      // oceny, a rozszerzenie tabeli skrótów (np. „there's”) czyni takimi warianty zapisane wcześniej.
      const exercises = patch.exercises.map((input) => withoutRedundantInputVariants(input, subject));
      // Walidacja per ćwiczenie — zbieramy wszystkie błędy, nie przerywamy na pierwszym.
      const drafts = exercises.map(toExerciseDraft);
      const grounded = splitByPoolExtra(subject, drafts, context.material);
      const errors = [...grounded.extraRejected, ...validatePool(grounded.kept, subject, topic).rejected]
        .map((rejection) => ({ index: drafts.indexOf(rejection.exercise), errors: rejection.errors }))
        .sort((a, b) => a.index - b.index);
      if (errors.length > 0) {
        throw new AppError("validation", { details: { exercises: errors } });
      }
      // Bariera wobec puli z patcha, przed zapisem ćwiczeń: historyjka z tego patcha,
      // a bez pola `story` zapisana (`null` usuwa ją, więc nie ma czego sprawdzać).
      const story = patch.story === undefined ? context.story : patch.story;
      if (story) assertStoryValid(subject, story, drafts);
      await applyLessonExercisesEdit(tx, { id: version.id, deckId: version.deckId }, subject, context.topicVersion, exercises);
    }

    if (patch.title !== undefined) {
      await tx.update(deckVersions).set({ title: patch.title }).where(eq(deckVersions.id, versionId));
    }
    // Usunięte zagadnienia bez patcha ćwiczeń: ich ćwiczenia znikają ze szkicu
    // w tej samej transakcji (z patcha ćwiczeń usuwa je applyLessonExercisesEdit).
    if (deletedObjectiveIds.length > 0 && patch.exercises === undefined) {
      const revisions = await tx
        .select({ id: itemRevisions.id, payload: itemRevisions.payload })
        .from(itemRevisions)
        .where(eq(itemRevisions.deckVersionId, versionId));
      for (const revision of revisions) {
        if (!deletedObjectiveIds.includes(String(revision.payload.objectiveId ?? ""))) continue;
        await tx.delete(revisionAssets).where(eq(revisionAssets.itemRevisionId, revision.id));
        await tx.delete(itemRevisionSkills).where(eq(itemRevisionSkills.itemRevisionId, revision.id));
        await tx.delete(itemRevisions).where(eq(itemRevisions.id, revision.id));
      }
    }
    if (nextDynamicTopic !== undefined || patch.examples !== undefined || patch.story !== undefined || patch.interests !== undefined) {
      // Pusta lista tematów usuwa klucz (brak klucza = lekcja bez tematów, jak przy tworzeniu).
      const currentContext = (version.lessonContext ?? {}) as Record<string, unknown>;
      const contextWithoutInterests = Object.fromEntries(Object.entries(currentContext).filter(([key]) => key !== "interests"));
      const nextContext: Record<string, unknown> = {
        ...(patch.interests === undefined ? currentContext : contextWithoutInterests),
        ...(patch.interests?.length ? { interests: patch.interests } : {}),
        ...(nextDynamicTopic
          ? { dynamicTopic: nextDynamicTopic, objectiveIds: nextDynamicTopic.objectives.map((o) => o.id) }
          : {}),
        ...(patch.examples !== undefined ? { examples: patch.examples } : {}),
        ...(patch.story ? { story: patch.story } : {}),
      };
      // `story: null` usuwa historyjkę (klucz znika z kontekstu).
      if (patch.story === null) delete nextContext.story;
      await tx
        .update(deckVersions)
        .set({ lessonContext: nextContext as Record<string, unknown> })
        .where(eq(deckVersions.id, versionId));
    }

    await bumpEditNumber(tx, versionId);
    // Wybór rodzica co do historyjki wygrywa z runem historyjki w toku (spec §6.2);
    // edycja bez pola `story` zostawia run historyjki.
    await supersedeLessonRuns(
      tx,
      versionId,
      services.clock.now(),
      undefined,
      patch.story === undefined ? {} : { includeStoryRuns: true },
    );
    if (patch.story !== undefined) await supersedeFailedLessonStoryRuns(tx, versionId);
    await reconcileDraftAssetsTx(tx, services, { id: version.id, state: version.state });
    return readLessonDraftDto(tx, services, versionId);
  });
}

/**
 * Publikacja szkicu lekcji. Wymaga pokrycia etapów ocenianych per cel
 * (`lessonCoverageGaps`: bez ujawnionych ćwiczeń samodzielnych); braki → 409 z listą
 * `{objectiveId, stage, required, actual, excluded?}` w `details.coverage`. Jak dla słówek
 * uzgadnia media i wymaga gotowego `target_audio`, gdy przedmiot go wymaga.
 * Stan review/draft → published; ustawia `decks.published_version_id`.
 */
export async function publishLessonDraft(
  services: Services,
  versionId: string,
  expectedEditNumber: number,
): Promise<{ deckVersionId: string }> {
  // Jak przy słówkach: zlecone media przetrwają nieudaną walidację (issue #106).
  await reconcileBeforePublish(services, versionId, expectedEditNumber);
  return services.db.transaction(async (tx) => {
    const version = await lockVersion(tx, versionId);
    if (version.state === "published") {
      throw new AppError("conflict");
    }
    if (version.editNumber !== expectedEditNumber) {
      throw new AppError("conflict");
    }
    const context = readLessonContext(version.lessonContext);
    const subject = requireSubject(services, context.subjectId);

    const revisions = await tx
      .select({ id: itemRevisions.id, payload: itemRevisions.payload })
      .from(itemRevisions)
      .where(eq(itemRevisions.deckVersionId, versionId))
      .orderBy(asc(itemRevisions.position));
    if (revisions.length === 0) {
      throw new AppError("validation", { message: "lesson has no exercises" });
    }

    // Pokrycie etapów ocenianych per cel.
    // Bez wariantów równoważnych odpowiedzi (jak przy zapisie): szkic zapisany przed rozszerzeniem
    // tabeli skrótów publikuje się bez ręcznego czyszczenia; zapisane rewizje zostają bez zmian.
    const drafts: LessonExerciseDraft[] = revisions.map((r) => withoutRedundantAcceptedVariants(toExerciseDraft(r.payload), subject.normalizer));
    const topic = requireTopic(services, context);
    const groundedPublish = splitByPoolExtra(subject, drafts, context.material);
    const invalid = [...groundedPublish.extraRejected, ...validatePool(groundedPublish.kept, subject, topic).rejected];
    if (invalid.length > 0) throw new AppError("validation", { details: { exercises: invalid.map((rejection) => ({ index: drafts.indexOf(rejection.exercise), errors: rejection.errors })) } });
    // Historyjka (np. ze starych danych) też przechodzi barierę ekspozycji wobec publikowanej puli.
    if (context.story) assertStoryValid(subject, context.story, drafts);
    const gaps = lessonCoverageGaps({ subject, exercises: drafts, examples: context.examples, objectiveIds: context.objectiveIds });
    if (gaps.length > 0) {
      throw new AppError("conflict", {
        message: "lesson coverage incomplete",
        details: { coverage: gaps },
      });
    }

    // Uzgodnij media (TTS odpowiedzi) i zweryfikuj gotowość wymaganego audio.
    await reconcileDraftAssetsTx(tx, services, { id: version.id, state: version.state }, { keepFailed: true });

    if (subject.ttsForAnswers && services.media) {
      const revisionIds = revisions.map((r) => r.id);
      const assets = await tx
        .select()
        .from(revisionAssets)
        .where(inArray(revisionAssets.itemRevisionId, revisionIds));
      let firstPendingRevision: string | null = null;
      for (const revision of revisions) {
        const audio = assets.find((a) => a.itemRevisionId === revision.id && a.role === "target_audio");
        if (!audio || audio.assetId === null) {
          throw new AppError("validation", {
            message: `missing ready target_audio for revision ${revision.id}`,
          });
        }
        const status = await assertAssetPublishable(tx, {
          itemRevisionId: revision.id,
          role: "target_audio",
          assetId: audio.assetId,
          expectedFingerprint: audio.expectedFingerprint,
          linkState: audio.state,
        });
        if (status === "pending") firstPendingRevision ??= revision.id;
      }
      // generacja zgłaszana po wszystkich ćwiczeniach: inny błąd ma pierwszeństwo
      if (firstPendingRevision) throw mediaPendingError({ role: "target_audio", itemRevisionId: firstPendingRevision });
    }

    const now = services.clock.now();
    // Publikacja kończy szkic: oczekujące runy (także historyjki, §6.2a) od razu
    // jako zastąpione, zamiast czekać, aż worker je przejmie i odrzuci.
    await supersedeLessonRuns(tx, versionId, now, undefined, { includeStoryRuns: true });
    await tx
      .update(deckVersions)
      .set({ state: "published", publishedAt: now })
      .where(eq(deckVersions.id, versionId));
    await tx
      .update(decks)
      .set({ publishedVersionId: versionId, title: version.title })
      .where(eq(decks.id, version.deckId));
    return { deckVersionId: versionId };
  });
}

/**
 * Nowy edytowalny szkic z opublikowanej wersji lekcji (reużywa szkieletu
 * słówek: blokada, strażniki, numer wersji + kopia rewizji/umiejętności/mediów).
 * `lesson_context` wersji źródłowej jest kopiowany do nowej (przykłady,
 * objectiveIds, decyzje o mediach). Zwraca `LessonDraftDto`.
 */
export async function createLessonDraftFromPublished(
  services: Services,
  deckId: string,
): Promise<LessonDraftDto> {
  const id = z.uuid().parse(deckId);
  const deck = (await services.db.select().from(decks).where(eq(decks.id, id)))[0];
  if (!deck) {
    throw new AppError("not_found");
  }
  if (deck.kind !== "lesson") {
    throw new AppError("deck_kind_mismatch", { message: "nie jest zestawem lekcji" });
  }
  return services.db.transaction(async (tx) => {
    const newVersionId = await createVersionFromPublished(tx, id, (innerTx, { source, newVersionId }) =>
      copyRevisionsSkillsAssets(innerTx, { sourceVersionId: source.id, newVersionId, deckId: id }),
    );
    // Historyjka przechodzi z kontekstem wersji; jej nagranie wiąże się od razu.
    // Gdy gotowy zasób o bieżącym fingerprincie istnieje, kopia nie kosztuje TTS
    // i szkic pokazuje odsłuch bez czekania na pierwszy zapis; w przeciwnym
    // razie (zmiana konfiguracji TTS, nieudane ujęcie, lekcja z etapu 1 bez
    // wiersza) kopia zleca nowe nagranie.
    await reconcileLessonStoryAssetTx(tx, services, { id: newVersionId, state: "draft" });
    return readLessonDraftDto(tx, services, newVersionId);
  });
}
