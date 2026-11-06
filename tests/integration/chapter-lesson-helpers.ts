import { randomUUID } from "node:crypto";
import { createLessonFromMaterial, editLessonDraft, readGeneration, type Services } from "@learning/server";
import { testDatabase } from "./helpers";

/**
 * Szkic lekcji „Angielski — rozdział” bez generowania (etap 3 #237, PR 2): testy sesji dziecka
 * i nagrań potrzebują konkretnej puli, a nie wyniku agenta. Zestaw powstaje poleceniem rodzica
 * (`createLessonFromMaterial`), temat dynamiczny trafia do kontekstu wersji wprost w bazie (jak zapis
 * agenta), a ćwiczenia i przykłady kart — edycją rodzica (`editLessonDraft`: `target_key`, umiejętności,
 * uzgodnienie mediów). Edycja unieważnia run utworzony razem z zestawem.
 */

export interface SeedChapterObjective {
  /** Ostatni człon identyfikatora zagadnienia: `english_chapter.d<deckId>.<slug>`. */
  slug: string;
  titlePl: string;
  kind: "words" | "frame";
  cards: { title: string; body: string }[];
  /** Ćwiczenia zagadnienia w kształcie wejścia edycji (`LessonExerciseInput`). */
  exercises: (deckId: string, objectiveId: string) => unknown[];
}

export async function seedChapterDraft(
  services: Services,
  args: {
    material: string;
    objectives: SeedChapterObjective[];
    /** Przykłady kart według sluga zagadnienia. */
    examples?: Record<string, string[]>;
    topicTitlePl?: string;
  },
): Promise<{ deckId: string; versionId: string; objectiveIds: string[]; editNumber: number }> {
  const topicTitlePl = args.topicTitlePl ?? "Unit 1";
  const { runId, deckId } = await createLessonFromMaterial(services, {
    subjectId: "english_chapter",
    topicTitlePl,
    material: args.material,
    poolSize: 40,
    clientRequestId: randomUUID(),
  });
  const versionId = (await readGeneration(services, runId)).deckVersionId!;
  const idOf = (slug: string) => `english_chapter.d${deckId}.${slug}`;
  const objectiveIds = args.objectives.map((objective) => idOf(objective.slug));
  const dynamicTopic = {
    titlePl: topicTitlePl,
    objectives: args.objectives.map((objective) => ({
      id: idOf(objective.slug),
      titlePl: objective.titlePl,
      descriptionEn: `Objective: ${objective.titlePl}.`,
      cards: objective.cards,
      kind: objective.kind,
    })),
  };
  await testDatabase().pool.query(
    `update learning_app.deck_versions
        set lesson_context = lesson_context || jsonb_build_object('dynamicTopic', $2::jsonb, 'objectiveIds', $3::jsonb)
      where id = $1`,
    [versionId, JSON.stringify(dynamicTopic), JSON.stringify(objectiveIds)],
  );
  const examples = Object.fromEntries(Object.entries(args.examples ?? {}).map(([slug, lines]) => [idOf(slug), lines]));
  const edited = await editLessonDraft(services, versionId, {
    expectedEditNumber: 1,
    exercises: args.objectives.flatMap((objective) => objective.exercises(deckId, idOf(objective.slug))),
    ...(Object.keys(examples).length === 0 ? {} : { examples }),
  });
  return { deckId, versionId, objectiveIds, editNumber: edited.editNumber };
}
