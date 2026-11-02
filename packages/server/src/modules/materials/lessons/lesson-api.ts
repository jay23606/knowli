import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  ChildInterestsSchema,
  LessonDynamicTopicPatchSchema,
  LessonExerciseInputSchema,
  type AssignmentDto,
  type CoverageGapDto,
  type GenerationDto,
  type LessonDeckDto,
  type LessonDraftDto,
  type LessonExerciseInput,
  type SubjectCatalogDto,
} from "@learning/contracts";
import type { Services } from "../../../config";
import type { Executor, Tx } from "../../../db/client";
import {
  assignments,
  childProfiles,
  deckVersions,
  decks,
  generationRuns,
  itemRevisionSkills,
  itemRevisions,
  learningItems,
  mediaAssets,
  revisionAssets,
  skillVersions,
} from "../../../db/schema";
import { AppError } from "../../../errors";
import { lessonExerciseTargetKey } from "../../../domain/lessons/exposure-key";
import { DEFAULT_LESSON_POLICY } from "../../../domain/lessons/lesson-policy";
import { materialCreationMode, requiresParentSubjectTitle } from "../../../domain/lessons/material-creation";
import { poolCoverage, validatePool } from "../../../domain/lessons/pool-validation";
import type { DynamicTopicData, LessonExerciseDraft, LessonTopic, SubjectModule } from "../../../domain/lessons/types";
import { resolveLessonTopic, validateDynamicTopicData } from "../../../domain/lessons/topic-resolution";
import { assertAssetPublishable, mediaPendingError, reconcileBeforePublish, reconcileDraftAssetsTx } from "../media-reconciliation";
import { copyRevisionsSkillsAssets } from "../decks";
import { supersedeLessonRuns } from "../generation-runs";
import { readDeckSource } from "../source-materials";
import {
  assertEditable,
  bumpEditNumber,
  createVersionFromPublished,
  lockVersion,
} from "../version-ops";
import { buildLessonPayload, buildObjectiveCriteria, lessonPayloadVersion, splitByPoolExtra, toExerciseDraft } from "./lesson-drafts";
import { readLessonAudioStates } from "./lesson-prompt-audio";

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
  /** Migawka tematów zdań (przedmioty z `interestsRule`); brak klucza = bez tematów. */
  interests?: string[];
}

function readLessonContext(raw: Record<string, unknown> | null): LessonContextView {
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
    ...(ctx.interests?.length ? { interests: [...ctx.interests] } : {}),
  };
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
export function lessonCatalog(services: Services): SubjectCatalogDto {
  return {
    ...(services.generationService ? { generationService: services.generationService } : {}),
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
        topics: [...latestByTopic.values()].map((topic) => ({
          id: topic.id,
          version: topic.version,
          titlePl: topic.titlePl,
          objectives: topic.objectives.map((objective) => ({
            id: objective.id,
            titlePl: objective.titlePl,
            cards: objective.cards.map((card) => ({ title: card.title, body: card.body })),
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

/** Minima pokrycia publikacji przedmiotu (fallback: polityka domyślna lekcji). */
function poolMinimumsOf(services: Services, subjectId: string) {
  return services.subjects.getSubject(subjectId)?.poolMinimums ?? DEFAULT_LESSON_POLICY.poolMinimums;
}

/**
 * Dodatkowa reguła szkoły: zagadnienie potrzebuje co najmniej dwóch RÓŻNYCH
 * pytań otwartych (różne odpowiedzi wzorcowe), nie jednej rodziny sformułowań.
 * Zwraca braki w kształcie CoverageGap (etap independent).
 */
function distinctOpenAnswerGaps(
  subject: SubjectModule,
  drafts: readonly LessonExerciseDraft[],
  objectiveIds: readonly string[],
): CoverageGapDto[] {
  if (subject.usesV3Payload !== true) return [];
  const gaps: CoverageGapDto[] = [];
  for (const objectiveId of objectiveIds) {
    const distinct = new Set(
      drafts
        .filter((d) => d.objectiveId === objectiveId && d.exerciseType === "lesson_open_answer")
        .map((d) => (subject.normalizer.normalize(d.answer)[0] ?? []).join(" ")),
    );
    if (distinct.size < 2) {
      gaps.push({ objectiveId, stage: "independent", required: 2, actual: distinct.size });
    }
  }
  return gaps;
}
/** Łączy braki pokrycia etapów z brakami reguły różnych pytań otwartych bez duplikatów per cel+etap. */
function mergeCoverage(base: CoverageGapDto[], extra: CoverageGapDto[]): CoverageGapDto[] {
  return [...base, ...extra.filter((g) => !base.some((b) => b.objectiveId === g.objectiveId && b.stage === g.stage))];
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
    const withPrompt = promptAudio ? { ...dto, promptAudio } : dto;
    // Zdanie ćwiczenia słuchowego: stan nagrania tylko dla `lesson_listen_choice`.
    const sentenceAudio = dto.exerciseType === "lesson_listen_choice" ? audio.sentences.get(r.id) : undefined;
    return sentenceAudio ? { ...withPrompt, sentenceAudio } : withPrompt;
  });
  const drafts: LessonExerciseDraft[] = revisions.map((r) => toExerciseDraft(r.payload));
  const draftSubject = services.subjects.getSubject(context.subjectId);
  const coverage: CoverageGapDto[] = mergeCoverage(
    poolCoverage(drafts, context.objectiveIds, poolMinimumsOf(services, context.subjectId)),
    draftSubject ? distinctOpenAnswerGaps(draftSubject, drafts, context.objectiveIds) : [],
  );

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
    // Nagranie pytania i zdania feedbacku nie jest zasobem do decyzji rodzica (design szkoły §11.2).
    assets: assetRows.flatMap((a) => a.role === "prompt_audio" || a.role === "feedback_audio" ? [] : [{
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
    rejectedCount: context.rejectedCount,
    ...(context.rejectedReasons ? { rejectedReasons: context.rejectedReasons } : {}),
    ...(context.droppedObjectiveCount ? { droppedObjectiveCount: context.droppedObjectiveCount } : {}),
    coverage,
  };
}

/** Najnowszy run `lesson` wskazanej wersji (polling panelu rodzica). */
async function latestLessonRun(db: Executor, deckVersionId: string): Promise<GenerationDto | null> {
  const run = (
    await db
      .select()
      .from(generationRuns)
      .where(and(eq(generationRuns.deckVersionId, deckVersionId), eq(generationRuns.kind, "lesson")))
      .orderBy(desc(generationRuns.createdAt))
      .limit(1)
  )[0];
  if (!run) {
    return null;
  }
  const deckId = (
    await db.select({ deckId: deckVersions.deckId }).from(deckVersions).where(eq(deckVersions.id, deckVersionId))
  )[0]?.deckId ?? null;
  return {
    id: run.id,
    deckId,
    deckVersionId: run.deckVersionId ?? null,
    state: run.state as GenerationDto["state"],
    attempts: run.attempts,
    errorCode: run.errorCode ?? null,
    // Lekcje liczą odrzucenia w `LessonDraftDto.rejectedCount` (z `lesson_context`), nie w runie.
    rejectedCount: null,
  };
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
    assignments: await lessonAssignments(db, id),
    ...(source === undefined ? {} : { source }),
    // Wymaganie 10.1: provider oceny dowolnych odpowiedzi (nazwa modelu z
    // konfiguracji, bez sekretów). `available=false` steruje komunikatem rodzica.
    grading: services.grader ? { available: true, model: services.grader.provider.model } : { available: false },
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
  interests: ChildInterestsSchema.optional(),
}).refine(
  (p) => p.title !== undefined || p.exercises !== undefined || p.examples !== undefined || p.dynamicTopic !== undefined || p.interests !== undefined,
  { message: "patch must change title, exercises, examples, dynamicTopic or interests" },
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

    if (patch.exercises !== undefined) {
      const topic = requireTopic(services, effectiveContext);
      // Walidacja per ćwiczenie — zbieramy wszystkie błędy, nie przerywamy na pierwszym.
      const drafts = patch.exercises.map(toExerciseDraft);
      const grounded = splitByPoolExtra(subject, drafts, context.material);
      const errors = [...grounded.extraRejected, ...validatePool(grounded.kept, subject, topic).rejected]
        .map((rejection) => ({ index: drafts.indexOf(rejection.exercise), errors: rejection.errors }))
        .sort((a, b) => a.index - b.index);
      if (errors.length > 0) {
        throw new AppError("validation", { details: { exercises: errors } });
      }
      await applyLessonExercisesEdit(tx, { id: version.id, deckId: version.deckId }, subject, context.topicVersion, patch.exercises);
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
    if (nextDynamicTopic !== undefined || patch.examples !== undefined || patch.interests !== undefined) {
      // Pusta lista tematów usuwa klucz (brak klucza = lekcja bez tematów, jak przy tworzeniu).
      const currentContext = (version.lessonContext ?? {}) as Record<string, unknown>;
      const contextWithoutInterests = Object.fromEntries(Object.entries(currentContext).filter(([key]) => key !== "interests"));
      const nextContext = {
        ...(patch.interests === undefined ? currentContext : contextWithoutInterests),
        ...(patch.interests?.length ? { interests: patch.interests } : {}),
        ...(nextDynamicTopic
          ? { dynamicTopic: nextDynamicTopic, objectiveIds: nextDynamicTopic.objectives.map((o) => o.id) }
          : {}),
        ...(patch.examples !== undefined ? { examples: patch.examples } : {}),
      };
      await tx
        .update(deckVersions)
        .set({ lessonContext: nextContext as Record<string, unknown> })
        .where(eq(deckVersions.id, versionId));
    }

    await bumpEditNumber(tx, versionId);
    await supersedeLessonRuns(tx, versionId, services.clock.now());
    await reconcileDraftAssetsTx(tx, services, { id: version.id, state: version.state });
    return readLessonDraftDto(tx, services, versionId);
  });
}

/**
 * Publikacja szkicu lekcji. Wymaga pokrycia etapów ocenianych per cel
 * (`poolCoverage` z `DEFAULT_LESSON_POLICY.poolMinimums`); braki → 409 z listą
 * `{objectiveId, stage, required, actual}` w `details.coverage`. Jak dla słówek
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
    const drafts: LessonExerciseDraft[] = revisions.map((r) => toExerciseDraft(r.payload));
    const topic = requireTopic(services, context);
    const groundedPublish = splitByPoolExtra(subject, drafts, context.material);
    const invalid = [...groundedPublish.extraRejected, ...validatePool(groundedPublish.kept, subject, topic).rejected];
    if (invalid.length > 0) throw new AppError("validation", { details: { exercises: invalid.map((rejection) => ({ index: drafts.indexOf(rejection.exercise), errors: rejection.errors })) } });
    const gaps = mergeCoverage(
      poolCoverage(drafts, context.objectiveIds, poolMinimumsOf(services, context.subjectId)),
      distinctOpenAnswerGaps(subject, drafts, context.objectiveIds),
    );
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
    return readLessonDraftDto(tx, services, newVersionId);
  });
}
