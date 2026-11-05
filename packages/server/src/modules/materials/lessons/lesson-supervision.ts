import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  LessonVerdictDecisionSchema,
  UuidSchema,
  type LessonVerdictDecision,
  type LessonVerdictDto,
  type ObjectiveProgressDto,
} from "@learning/contracts";
import type { Services } from "../../../config";
import type { Executor } from "../../../db/client";
import {
  childObjectiveProgress,
  childProfiles,
  deckVersions,
  decks,
  eventExposures,
  itemRevisions,
  itemRevisionSkills,
  learningEvents,
  lessonVerdicts,
  skillVersions,
} from "../../../db/schema";
import { AppError } from "../../../errors";
import { mapObjectiveStatus } from "../../../domain/lessons/progress-status";
import { answersEquivalent } from "../../../domain/lessons/pool-validation";
import type { LearningObjective, LessonTopic, SubjectModule } from "../../../domain/lessons/types";
import { reconcileDraftAssetsTx } from "../media-reconciliation";
import { bumpEditNumber, lockVersion } from "../version-ops";
import { lessonCategoryLabels } from "./lesson-grader-input";
import { createLessonDraftFromPublished } from "./lesson-api";
import { buildObjectiveCriteria, toExerciseDraft } from "./lesson-drafts";
import { buildLessonPayload } from "./lesson-payload";

/**
 * Nadzór rodzica nad lekcją (zadanie 16): odczyt postępu celów z przykładami
 * błędów TYLKO tego dziecka, lista werdyktów modelu dla ćwiczeń lekcji oraz
 * decyzje rodzica (potwierdzenie/nadpisanie, dodanie wariantu). Decyzje NIE
 * przepisują zakończonych ocen (`assessments`) ani nie przeliczają projekcji
 * (`child_objective_progress`) — zmieniają tylko `parent_decision`, które przy
 * NASTĘPNEJ identycznej odpowiedzi jest nadrzędne (patrz lesson-attempts).
 */

/** Status bazy → status DTO rodzica (słownik domeny), z zapasem not_assessed. */
function toDtoStatus(dbStatus: string | null): ObjectiveProgressDto["status"] {
  return dbStatus === null ? "not_assessed" : mapObjectiveStatus(dbStatus);
}

/** Pola `lesson_context` czytane tu (temat przypięty + lista celów). */
interface LessonContextView {
  subjectId: string;
  topicId: string;
  topicVersion: number;
  objectiveIds: string[];
  dynamicTopic?: import("../../../domain/lessons/types").DynamicTopicData;
}

function readLessonContext(raw: Record<string, unknown> | null): LessonContextView {
  const ctx = (raw ?? {}) as Partial<LessonContextView>;
  return {
    subjectId: ctx.subjectId ?? "",
    topicId: ctx.topicId ?? "",
    topicVersion: ctx.topicVersion ?? 1,
    objectiveIds: ctx.objectiveIds ?? [],
    ...(ctx.dynamicTopic ? { dynamicTopic: ctx.dynamicTopic } : {}),
  };
}

function requireSubject(services: Services, subjectId: string): SubjectModule {
  const subject = services.subjects.getSubject(subjectId);
  if (!subject) throw new AppError("internal", { message: `lesson subject missing: ${subjectId}` });
  return subject;
}

function requireTopic(subject: SubjectModule, topicId: string, version: number, dynamicTopic?: import("../../../domain/lessons/types").DynamicTopicData): LessonTopic {
  if (subject.buildDynamicTopic && dynamicTopic) return subject.buildDynamicTopic(dynamicTopic);
  const topic = subject.topics.find((t) => t.id === topicId && t.version === version)
    ?? subject.topics.find((t) => t.id === topicId);
  if (!topic) throw new AppError("internal", { message: `lesson topic missing: ${subject.id}/${topicId}@${version}` });
  return topic;
}

/** Rozwiązuje aktywną (opublikowaną, inaczej edytowalną) wersję lekcji deckId. */
async function activeLessonVersion(
  db: Executor,
  deckId: string,
): Promise<{ versionId: string; context: LessonContextView }> {
  const deck = (await db.select().from(decks).where(eq(decks.id, deckId)))[0];
  if (!deck) throw new AppError("not_found");
  if (deck.kind !== "lesson") throw new AppError("deck_kind_mismatch", { message: "nie jest zestawem lekcji" });
  const versionId = deck.publishedVersionId
    ?? (await db
      .select({ id: deckVersions.id })
      .from(deckVersions)
      .where(and(eq(deckVersions.deckId, deckId), inArray(deckVersions.state, ["draft", "review"])))
      .orderBy(desc(deckVersions.editNumber))
      .limit(1))[0]?.id;
  if (!versionId) throw new AppError("not_found");
  const version = (await db.select().from(deckVersions).where(eq(deckVersions.id, versionId)))[0]!;
  return { versionId, context: readLessonContext(version.lessonContext) };
}

interface ObjectiveErrorRow {
  objectiveId: string;
  category: string;
  answer: string | null;
  count: number;
}

/**
 * Postęp celów lekcji dla rodzica. Statusy z `child_objective_progress`,
 * najczęstsze kategorie błędów z `assessments` (skill=objective) tego dziecka na
 * ćwiczeniach tej lekcji z do 3 PRZYKŁADAMI odpowiedzi tylko tego dziecka, oraz
 * flaga wyczerpania puli (brak jeszcze niewidzianych ćwiczeń celu). Przykłady i
 * błędy są izolowane per dziecko — żadne dane innego dziecka tu nie wchodzą.
 */
export async function lessonObjectiveProgress(
  services: Services,
  deckId: string,
  childId: string,
): Promise<ObjectiveProgressDto[]> {
  const deck = UuidSchema.parse(deckId);
  const child = UuidSchema.parse(childId);
  const profile = (await services.db.select({ id: childProfiles.id }).from(childProfiles).where(eq(childProfiles.id, child)))[0];
  if (!profile) throw new AppError("not_found");

  const { versionId, context } = await activeLessonVersion(services.db, deck);
  const subject = requireSubject(services, context.subjectId);
  // Szkic szkolny przed zakończeniem generacji nie ma jeszcze zagadnień — brak postępu do pokazania.
  if (subject.buildDynamicTopic && !context.dynamicTopic) return [];
  const topic = requireTopic(subject, context.topicId, context.topicVersion, context.dynamicTopic);
  const labels = lessonCategoryLabels(subject, topic);
  const objectiveById = new Map<string, LearningObjective>();
  for (const o of topic.objectives) objectiveById.set(o.id, o);

  // Rewizje ćwiczeń tej wersji z celem i target_key (do puli i izolacji błędów).
  const revisions = await services.db
    .select({ id: itemRevisions.id, targetKey: itemRevisions.targetKey, payload: itemRevisions.payload })
    .from(itemRevisions)
    .where(eq(itemRevisions.deckVersionId, versionId));
  const targetKeysByObjective = new Map<string, Set<string>>();
  for (const r of revisions) {
    const objectiveId = toExerciseDraft(r.payload).objectiveId;
    const keys = targetKeysByObjective.get(objectiveId) ?? new Set<string>();
    keys.add(r.targetKey);
    targetKeysByObjective.set(objectiveId, keys);
  }

  // Statusy per cel z projekcji.
  const progressRows = await services.db
    .select({
      objectiveId: childObjectiveProgress.objectiveId,
      status: childObjectiveProgress.status,
      nextReviewAt: childObjectiveProgress.nextReviewAt,
      lastIndependentAt: childObjectiveProgress.lastIndependentAt,
    })
    .from(childObjectiveProgress)
    .where(and(eq(childObjectiveProgress.childId, child), eq(childObjectiveProgress.subjectId, context.subjectId)));
  const progressByObjective = new Map(progressRows.map((r) => [r.objectiveId, r]));

  // Kategorie błędów tego dziecka na ćwiczeniach tej lekcji (skill=objective),
  // z odpowiedzią dziecka (attempts.answer->>text) jako przykładem. Zakres to
  // rewizje WSZYSTKICH wersji zestawu: historia prób nie znika z raportu po
  // republicacji (pula powyżej nadal liczona z wersji aktywnej).
  const historyRevisionIds = (
    await services.db
      .select({ id: itemRevisions.id })
      .from(itemRevisions)
      .where(eq(itemRevisions.deckId, deck))
  ).map((r) => r.id);
  const errorRows: ObjectiveErrorRow[] = historyRevisionIds.length
    ? (await services.db.execute<{ objectiveId: string | null; category: string | null; answer: string | null; count: number }>(sql`
        select n.details->>'objectiveId' as "objectiveId",
               n.details->>'errorCategory' as category,
               a.answer->>'text' as answer,
               count(*)::int as count
          from learning_app.assessments n
          join learning_app.attempts a on a.id = n.attempt_id
         where n.child_id = ${child}
           and n.skill = 'objective'
           and n.item_revision_id = any(${sql.param(historyRevisionIds)}::uuid[])
           and n.details ? 'errorCategory'
           -- Poprawka po informacji zwrotnej („Skróć odpowiedź”) nie jest błędem wiedzy.
           and not (n.details ? 'revisionOf')
         group by 1, 2, 3
      `)).rows.map((r) => ({ objectiveId: r.objectiveId ?? "", category: r.category ?? "", answer: r.answer, count: r.count }))
    : [];

  // Agregacja: per (objective, category) suma i do 3 przykładów (najczęstsze
  // odpowiedzi dziecka najpierw).
  interface Agg { count: number; examples: { answer: string; count: number }[] }
  const byObjectiveCategory = new Map<string, Map<string, Agg>>();
  for (const row of errorRows) {
    if (!row.category) continue;
    const perObjective = byObjectiveCategory.get(row.objectiveId) ?? new Map<string, Agg>();
    const agg = perObjective.get(row.category) ?? { count: 0, examples: [] };
    agg.count += row.count;
    if (row.answer) agg.examples.push({ answer: row.answer, count: row.count });
    perObjective.set(row.category, agg);
    byObjectiveCategory.set(row.objectiveId, perObjective);
  }

  // Agregat szkolny (Etap 2): wiedza/precyzja/brakujące elementy z details ocen
  // + ostatnie odpowiedzi dziecka. Tylko oceny z wymiarem wiedzy (details.knowledge).
  // Liczniki i braki liczy baza; do aplikacji trafia najwyżej 5 odpowiedzi na cel.
  const schoolFrom = sql`
          from learning_app.assessments n
          join learning_app.attempts a on a.id = n.attempt_id`;
  const schoolWhere = sql`
         where n.child_id = ${child}
           and n.skill = 'objective'
           and n.item_revision_id = any(${sql.param(historyRevisionIds)}::uuid[])
           and n.details ? 'knowledge'
           and not (n.details ? 'revisionOf')`;
  // Trener precyzji: poprawki („Skróć odpowiedź”) raportujemy osobno, z oryginałem.
  const [offeredResult, revisionResult] = historyRevisionIds.length
    ? await Promise.all([
        services.db.execute<{ objectiveId: string | null; count: number }>(sql`
        select t.context->>'objectiveId' as "objectiveId", count(*)::int as count
          from learning_app.session_tasks t
         where t.child_id = ${child}
           and t.item_revision_id = any(${sql.param(historyRevisionIds)}::uuid[])
           and t.context ? 'followUpOf'
         group by 1`),
        services.db.execute<{
          objectiveId: string | null; outcome: string; details: Record<string, unknown>;
          revision: string | null; original: string | null;
        }>(sql`
        select n.details->>'objectiveId' as "objectiveId", n.outcome, n.details,
               a.answer->>'text' as revision, o.answer->>'text' as original
          from learning_app.assessments n
          join learning_app.attempts a on a.id = n.attempt_id
          left join learning_app.attempts o on o.id = (n.details->'revisionOf'->>'attemptId')::uuid
         where n.child_id = ${child}
           and n.skill = 'objective'
           and n.item_revision_id = any(${sql.param(historyRevisionIds)}::uuid[])
           and n.details ? 'revisionOf'
           -- Poprawka bez oceny (ten sam tekst, awaria gradera) nie jest próbą skrócenia.
           and n.outcome <> 'unassessed'
         order by a.received_at desc, a.id`),
      ])
    : [null, null];
  function shorteningAggregate(objectiveId: string) {
    const offered = offeredResult?.rows.find((row) => row.objectiveId === objectiveId)?.count ?? 0;
    const revisions = (revisionResult?.rows ?? []).filter((row) => row.objectiveId === objectiveId);
    if (offered === 0 && revisions.length === 0) return undefined;
    const summarized = revisions.map((row) => {
      const lostIds = Array.isArray(row.details.lostElementIds) ? row.details.lostElementIds : [];
      const missingIds = Array.isArray(row.details.missingElementIds) ? row.details.missingElementIds : [];
      const missingTexts = Array.isArray(row.details.missingElementTexts) ? row.details.missingElementTexts : [];
      const lostElements = missingIds.flatMap((id, index) =>
        lostIds.includes(id) && typeof missingTexts[index] === "string" ? [missingTexts[index] as string] : []).slice(0, 6);
      return {
        original: row.original ?? "",
        revision: row.revision ?? "",
        lostElements,
        successful: row.outcome === "correct" && lostIds.length === 0 && row.details.shorter === true,
      };
    });
    return {
      offered,
      attempted: revisions.length,
      successful: summarized.filter((revision) => revision.successful).length,
      recent: summarized.slice(0, 3),
    };
  }
  const [countsResult, missingResult, recentResult, confusionResult] = historyRevisionIds.length
    ? await Promise.all([
        services.db.execute<{
          objectiveId: string | null; correct: number; partial: number; incorrect: number;
          concise: number; verbose: number; unfocused: number;
          speechCorrect: number; speechPartial: number; speechIncorrect: number; speechEdited: number;
          withRedundant: number; withOffTopic: number;
        }>(sql`
        select n.details->>'objectiveId' as "objectiveId",
               count(*) filter (where n.details->>'knowledge' = 'correct')::int as correct,
               count(*) filter (where n.details->>'knowledge' = 'partial')::int as partial,
               count(*) filter (where n.details->>'knowledge' = 'incorrect')::int as incorrect,
               count(*) filter (where n.details->>'precision' = 'concise')::int as concise,
               count(*) filter (where n.details->>'precision' = 'verbose')::int as verbose,
               count(*) filter (where n.details->>'precision' = 'unfocused')::int as unfocused,
               -- Etap 3: odpowiedzi z dyktowania (answer.inputMethod); reszta to klawiatura
               count(*) filter (where n.details->>'knowledge' = 'correct' and a.answer->>'inputMethod' = 'speech')::int as "speechCorrect",
               count(*) filter (where n.details->>'knowledge' = 'partial' and a.answer->>'inputMethod' = 'speech')::int as "speechPartial",
               count(*) filter (where n.details->>'knowledge' = 'incorrect' and a.answer->>'inputMethod' = 'speech')::int as "speechIncorrect",
               count(*) filter (where a.answer->>'inputMethod' = 'speech' and a.answer->>'edited' = 'true')::int as "speechEdited",
               -- werdykt v3: oceny z fragmentami „poprawne, ale zbędne” i „nie na temat”
               count(*) filter (where jsonb_typeof(n.details->'redundantFragments') = 'array'
                                  and jsonb_array_length(n.details->'redundantFragments') > 0)::int as "withRedundant",
               count(*) filter (where jsonb_typeof(n.details->'offTopicFragments') = 'array'
                                  and jsonb_array_length(n.details->'offTopicFragments') > 0)::int as "withOffTopic"
        ${schoolFrom}
        ${schoolWhere}
         group by 1`),
        services.db.execute<{ objectiveId: string | null; text: string; count: number }>(sql`
        select n.details->>'objectiveId' as "objectiveId", m.text, count(*)::int as count
        ${schoolFrom}
         cross join lateral jsonb_array_elements_text(
           case when jsonb_typeof(n.details->'missingElementTexts') = 'array'
                then n.details->'missingElementTexts' else '[]'::jsonb end) as m(text)
        ${schoolWhere}
         group by 1, 2`),
        services.db.execute<{ objectiveId: string | null; knowledge: string | null; precision: string | null; answer: string | null; inputMethod: string | null }>(sql`
        select "objectiveId", knowledge, precision, answer, "inputMethod" from (
          select n.details->>'objectiveId' as "objectiveId",
                 n.details->>'knowledge' as knowledge,
                 n.details->>'precision' as precision,
                 a.answer->>'text' as answer,
                 a.answer->>'inputMethod' as "inputMethod",
                 row_number() over (partition by n.details->>'objectiveId' order by a.received_at desc, a.id) as rank
          ${schoolFrom}
          ${schoolWhere}
        ) recent
         where rank <= 5
         order by "objectiveId", rank`),
        // Pomylone pojęcia (werdykt v3, design §9.4): pary bez wielkości liter; zapis — najmniejszy wariant w porządku kodów znaków (jak w JS).
        services.db.execute<{ objectiveId: string | null; said: string; meant: string; count: number }>(sql`
        select "objectiveId", min(said collate "C") as said, min(meant collate "C") as meant, count(*)::int as count from (
          select n.details->>'objectiveId' as "objectiveId", c->>'said' as said, c->>'meant' as meant
          ${schoolFrom}
           cross join lateral jsonb_array_elements(
             case when jsonb_typeof(n.details->'confusedConcepts') = 'array'
                  then n.details->'confusedConcepts' else '[]'::jsonb end) as c
          ${schoolWhere}
            and jsonb_typeof(c->'said') = 'string' and jsonb_typeof(c->'meant') = 'string'
        ) pairs
         group by "objectiveId", lower(said), lower(meant)`),
      ])
    : [null, null, null, null];
  function schoolAggregate(objectiveId: string) {
    const counts = countsResult?.rows.find((row) => row.objectiveId === objectiveId);
    if (!counts) return undefined;
    const missing = (missingResult?.rows ?? []).filter((row) => row.objectiveId === objectiveId);
    const recent = (recentResult?.rows ?? []).filter((row) => row.objectiveId === objectiveId);
    return {
      knowledge: { correct: counts.correct, partial: counts.partial, incorrect: counts.incorrect },
      precision: { concise: counts.concise, verbose: counts.verbose, unfocused: counts.unfocused },
      topMissing: missing
        .map((row) => ({ text: row.text, count: row.count }))
        .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text, "pl"))
        .slice(0, 5),
      recentAnswers: recent.map((r) => ({
        text: r.answer ?? "",
        knowledge: (["correct", "partial", "incorrect"].includes(r.knowledge ?? "") ? r.knowledge : "incorrect") as "correct" | "partial" | "incorrect",
        precision: (r.precision === "concise" || r.precision === "verbose" || r.precision === "unfocused" ? r.precision : null) as "concise" | "verbose" | "unfocused" | null,
        inputMethod: r.inputMethod === "speech" ? "speech" as const : "keyboard" as const,
      })),
      byInputMethod: {
        keyboard: {
          correct: counts.correct - counts.speechCorrect,
          partial: counts.partial - counts.speechPartial,
          incorrect: counts.incorrect - counts.speechIncorrect,
        },
        speech: { correct: counts.speechCorrect, partial: counts.speechPartial, incorrect: counts.speechIncorrect, edited: counts.speechEdited },
      },
      speechService: services.lessonSpeech?.publicService ?? null,
      topConfusions: (confusionResult?.rows ?? [])
        .filter((row) => row.objectiveId === objectiveId && row.said.length <= 60 && row.meant.length <= 60)
        .map((row) => ({ said: row.said, meant: row.meant, count: row.count }))
        .sort((a, b) => b.count - a.count || a.said.localeCompare(b.said, "pl") || a.meant.localeCompare(b.meant, "pl"))
        .slice(0, 5),
      fragmentKinds: { redundant: counts.withRedundant, offTopic: counts.withOffTopic },
      ...(shorteningAggregate(objectiveId) ? { shortening: shorteningAggregate(objectiveId)! } : {}),
    };
  }
  // Pula wyczerpana: wszystkie target_key ćwiczeń celu były już ujawnione dziecku
  // (dowolna sesja/lekcja). Ekspozycje zapieczętowane.
  const allTargetKeys = [...new Set(revisions.map((r) => r.targetKey))];
  const exposedTargetKeys = allTargetKeys.length
    ? new Set((await services.db
        .selectDistinct({ targetKey: eventExposures.targetKey })
        .from(eventExposures)
        .innerJoin(learningEvents, eq(learningEvents.id, eventExposures.eventId))
        .where(and(
          eq(eventExposures.childId, child),
          eq(learningEvents.sealed, true),
          inArray(eventExposures.targetKey, allTargetKeys),
        ))).map((r) => r.targetKey))
    : new Set<string>();

  // Kolejność celów jak w temacie, przefiltrowana do celów lekcji.
  const orderedObjectiveIds = topic.objectives.map((o) => o.id).filter((id) => context.objectiveIds.includes(id));
  return orderedObjectiveIds.map((objectiveId) => {
    const progress = progressByObjective.get(objectiveId);
    const categoryAggs = byObjectiveCategory.get(objectiveId) ?? new Map<string, Agg>();
    const topErrors = [...categoryAggs.entries()]
      .map(([category, agg]) => ({
        category,
        labelPl: labels.get(category) ?? category,
        count: agg.count,
        examples: agg.examples
          .sort((a, b) => b.count - a.count || a.answer.localeCompare(b.answer, "pl"))
          .slice(0, 3)
          .map((e) => e.answer),
      }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))
      .slice(0, 5);
    const targetKeys = targetKeysByObjective.get(objectiveId) ?? new Set<string>();
    const poolExhausted = targetKeys.size > 0 && [...targetKeys].every((k) => exposedTargetKeys.has(k));
    return {
      objectiveId,
      titlePl: objectiveById.get(objectiveId)?.titlePl ?? objectiveId,
      status: toDtoStatus(progress?.status ?? null),
      lastIndependentAt: progress?.lastIndependentAt?.toISOString() ?? null,
      nextReviewAt: progress?.nextReviewAt?.toISOString() ?? null,
      poolExhausted,
      topErrors,
      ...(schoolAggregate(objectiveId) ? { school: schoolAggregate(objectiveId)! } : {}),
    } satisfies ObjectiveProgressDto;
  });
}

/**
 * Werdykty modelu dla ćwiczeń tej lekcji (opublikowana + edytowalna wersja),
 * najnowsze najpierw, z flagą decyzji rodzica. `childAnswer` to
 * `normalized_answer` (materiał wspólny, bez kolumn dziecka). Bez sekretów.
 */
export async function listLessonVerdicts(services: Services, deckId: string): Promise<LessonVerdictDto[]> {
  const deck = UuidSchema.parse(deckId);
  const deckRow = (await services.db.select({ kind: decks.kind, publishedVersionId: decks.publishedVersionId }).from(decks).where(eq(decks.id, deck)))[0];
  if (!deckRow) throw new AppError("not_found");
  if (deckRow.kind !== "lesson") throw new AppError("deck_kind_mismatch", { message: "nie jest zestawem lekcji" });

  // Wszystkie wersje tej lekcji (werdykt należy do rewizji, która żyje w wersji).
  const versionIds = (await services.db.select({ id: deckVersions.id }).from(deckVersions).where(eq(deckVersions.deckId, deck))).map((v) => v.id);
  if (versionIds.length === 0) return [];
  const revisionRows = await services.db
    .select({ id: itemRevisions.id, payload: itemRevisions.payload })
    .from(itemRevisions)
    .where(inArray(itemRevisions.deckVersionId, versionIds));
  if (revisionRows.length === 0) return [];
  const objectiveByRevision = new Map(revisionRows.map((r) => [r.id, toExerciseDraft(r.payload).objectiveId]));
  const revisionIds = revisionRows.map((r) => r.id);

  const rows = await services.db
    .select()
    .from(lessonVerdicts)
    .where(inArray(lessonVerdicts.itemRevisionId, revisionIds))
    .orderBy(desc(lessonVerdicts.createdAt), desc(lessonVerdicts.id));

  return rows.map((row) => ({
    id: row.id,
    exerciseRevisionId: row.itemRevisionId,
    objectiveId: objectiveByRevision.get(row.itemRevisionId) ?? "",
    childAnswer: row.normalizedAnswer,
    verdict: row.verdict as LessonVerdictDto["verdict"],
    errorCategory: row.errorCategory,
    note: row.note ?? "",
    graderModel: row.graderModel,
    parentDecision: (row.parentDecision as LessonVerdictDecision | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    school: row.precision === null
      ? null
      : {
          knowledge: (row.verdict === "correct" ? "correct" : row.verdict === "almost" ? "partial" : "incorrect") as "correct" | "partial" | "incorrect",
          precision: row.precision as "concise" | "verbose" | "unfocused",
          matchedElementIds: [...(row.matchedElements ?? [])],
          missingElementIds: [...(row.missingElements ?? [])],
        },
  }));
}

/**
 * Decyzja rodzica nad werdyktem: zapis `parent_decision` + `parent_decided_at`.
 * NIE zmienia `assessments` i NIE przelicza `child_objective_progress`. Działa
 * dopiero przy NASTĘPNEJ identycznej odpowiedzi (cache verdictFromCacheRow).
 */
export async function decideLessonVerdict(
  services: Services,
  verdictId: string,
  decision: LessonVerdictDecision,
): Promise<LessonVerdictDto> {
  const id = UuidSchema.parse(verdictId);
  const parsed = LessonVerdictDecisionSchema.parse(decision);
  const updated = await services.db
    .update(lessonVerdicts)
    .set({ parentDecision: parsed, parentDecidedAt: services.clock.now() })
    .where(eq(lessonVerdicts.id, id))
    .returning();
  if (updated.length === 0) throw new AppError("not_found");
  const row = updated[0]!;
  const objectiveId = await objectiveOfRevision(services, row.itemRevisionId);
  return {
    id: row.id,
    exerciseRevisionId: row.itemRevisionId,
    objectiveId,
    childAnswer: row.normalizedAnswer,
    verdict: row.verdict as LessonVerdictDto["verdict"],
    errorCategory: row.errorCategory,
    note: row.note ?? "",
    graderModel: row.graderModel,
    parentDecision: (row.parentDecision as LessonVerdictDecision | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    school: row.precision === null
      ? null
      : {
          knowledge: (row.verdict === "correct" ? "correct" : row.verdict === "almost" ? "partial" : "incorrect") as "correct" | "partial" | "incorrect",
          precision: row.precision as "concise" | "verbose" | "unfocused",
          matchedElementIds: [...(row.matchedElements ?? [])],
          missingElementIds: [...(row.missingElements ?? [])],
        },
  };
}

/** Cel ćwiczenia (po rewizji) — do DTO werdyktu po decyzji. */
async function objectiveOfRevision(services: Services, revisionId: string): Promise<string> {
  const row = (await services.db.select({ payload: itemRevisions.payload }).from(itemRevisions).where(eq(itemRevisions.id, revisionId)))[0];
  return row ? toExerciseDraft(row.payload).objectiveId : "";
}

/** Deck id werdyktu (po rewizji → wersja → deck). */
async function deckOfVerdict(services: Services, revisionId: string): Promise<string | null> {
  const row = (await services.db
    .select({ deckId: deckVersions.deckId })
    .from(itemRevisions)
    .innerJoin(deckVersions, eq(deckVersions.id, itemRevisions.deckVersionId))
    .where(eq(itemRevisions.id, revisionId)))[0];
  return row?.deckId ?? null;
}

/**
 * Dodaje znormalizowaną odpowiedź jako zatwierdzony wariant ćwiczenia w BIEŻĄCYM
 * szkicu (tworzy szkic z opublikowanej, jeśli trzeba — reużywa mechanizmu z
 * zadania 11, `createLessonDraftFromPublished`). Idempotentne: wariant już obecny
 * → bez zmian. Edycja jest CHIRURGICZNA — dotyka tylko docelowego ćwiczenia (po
 * `itemId` werdyktu): dopisuje wariant do payloadu i — jak każda zmiana
 * wariantów w zadaniu 11 — tworzy NOWĄ `skill_version` celu (predecessor +
 * revision_number+1), potem bumpEditNumber i uzgodnienie mediów. Nie przepisuje
 * ani nie rewaliduje pozostałych ćwiczeń szkicu.
 */
export async function acceptVerdictAsVariant(services: Services, verdictId: string): Promise<{ deckVersionId: string; added: boolean }> {
  const id = UuidSchema.parse(verdictId);
  const verdict = (await services.db.select().from(lessonVerdicts).where(eq(lessonVerdicts.id, id)))[0];
  if (!verdict) throw new AppError("not_found");

  const deckId = await deckOfVerdict(services, verdict.itemRevisionId);
  if (!deckId) throw new AppError("not_found");

  // Tożsamość ćwiczenia (itemId) z rewizji werdyktu — wariant dodajemy do tego
  // samego learning_item w bieżącym szkicu, nie do rewizji werdyktu (która może
  // należeć do opublikowanej wersji).
  const sourceRevision = (await services.db
    .select({ itemId: itemRevisions.itemId })
    .from(itemRevisions)
    .where(eq(itemRevisions.id, verdict.itemRevisionId)))[0];
  if (!sourceRevision) throw new AppError("not_found");
  const itemId = sourceRevision.itemId;
  const normalized = verdict.normalizedAnswer;

  // Upewnij się, że istnieje edytowalny szkic (utwórz z opublikowanej, jak zadanie 11).
  const deck = (await services.db.select().from(decks).where(eq(decks.id, deckId)))[0]!;
  let draftVersionId = (await services.db
    .select({ id: deckVersions.id })
    .from(deckVersions)
    .where(and(eq(deckVersions.deckId, deckId), inArray(deckVersions.state, ["draft", "review"])))
    .orderBy(desc(deckVersions.editNumber))
    .limit(1))[0]?.id;
  if (!draftVersionId) {
    if (!deck.publishedVersionId) throw new AppError("conflict", { message: "lesson has no editable or published version" });
    const draft = await createLessonDraftFromPublished(services, deckId);
    draftVersionId = draft.id;
  }

  return services.db.transaction(async (tx) => {
    const version = await lockVersion(tx, draftVersionId!);
    if (version.state === "published") throw new AppError("conflict");
    const context = readLessonContext(version.lessonContext);
    const subject = requireSubject(services, context.subjectId);

    const target = (await tx
      .select({ id: itemRevisions.id, payload: itemRevisions.payload })
      .from(itemRevisions)
      .where(and(eq(itemRevisions.deckVersionId, draftVersionId!), eq(itemRevisions.itemId, itemId))))[0];
    if (!target) {
      // Ćwiczenie usunięte w szkicu — nic do zrobienia (idempotentnie bez zmian).
      return { deckVersionId: draftVersionId!, added: false };
    }

    const draft = toExerciseDraft(target.payload);
    // Pełna relacja równoważności (każda wspólna sekwencja normalizacji — ta sama
    // co `validateAcceptedAnswers` i sanityzacja generacji). Porównanie samej
    // pierwszej sekwencji dopisywało wariant redundantny wobec odpowiedzi
    // kanonicznej, gdy równoważność tkwiła w dalszej sekwencji skrótu
    // dwuznacznego („She's…” → is|has), i twardo blokowało publikację szkicu.
    const alreadyPresent = [draft.answer, ...draft.acceptedAnswers].some(
      (v) => answersEquivalent(v, normalized, subject.normalizer),
    );
    if (alreadyPresent) {
      return { deckVersionId: draftVersionId!, added: false };
    }

    const nextDraft = { ...draft, acceptedAnswers: [...draft.acceptedAnswers, normalized] };
    const payload = buildLessonPayload(nextDraft, subject);

    // Zmiana wariantów = nowa skill_version celu (jak applyLessonExercisesEdit).
    const existingSkill = (await tx
      .select({ skillVersionId: itemRevisionSkills.skillVersionId, revisionNumber: skillVersions.revisionNumber })
      .from(itemRevisionSkills)
      .innerJoin(skillVersions, eq(skillVersions.id, itemRevisionSkills.skillVersionId))
      .where(and(eq(itemRevisionSkills.itemRevisionId, target.id), eq(itemRevisionSkills.skill, "objective"))))[0];
    const { criteria, criteriaHash } = buildObjectiveCriteria(nextDraft, subject, context.topicVersion);
    const newSkillVersionId = randomUUID();
    await tx.insert(skillVersions).values({
      id: newSkillVersionId,
      itemId,
      skill: "objective",
      revisionNumber: (existingSkill?.revisionNumber ?? 1) + 1,
      criteria,
      criteriaHash,
      ...(existingSkill?.skillVersionId ? { predecessorId: existingSkill.skillVersionId } : {}),
    });
    await tx.update(itemRevisions).set({ payload }).where(eq(itemRevisions.id, target.id));
    await tx.delete(itemRevisionSkills).where(eq(itemRevisionSkills.itemRevisionId, target.id));
    await tx.insert(itemRevisionSkills).values({
      itemRevisionId: target.id,
      itemId,
      skill: "objective",
      skillVersionId: newSkillVersionId,
    });
    await bumpEditNumber(tx, draftVersionId!);
    await reconcileDraftAssetsTx(tx, services, { id: version.id, state: version.state });
    return { deckVersionId: draftVersionId!, added: true };
  });
}
