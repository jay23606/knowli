import { randomUUID } from "node:crypto";
import { computeTargetKey } from "@learning/server";
import type { testDatabase } from "../integration/helpers";
import type { LessonStoryFixture } from "./lesson-world";

type Pool = ReturnType<typeof testDatabase>["pool"];

/**
 * Lekcja szkolna (przedmiot `school`, temat dynamiczny „Rośliny”) zasiana wprost
 * w bazie: cel „Fotosynteza” z wyborem, lukami i odpowiedzią otwartą ocenianą
 * modelem (fake grader w testach), opcjonalnie drugi cel, trener precyzji,
 * pytanie porównawcze i historyjka w `lesson_context` (przed publikacją —
 * kontekst opublikowanej wersji jest niezmienny). Wspólne dla testów oceny
 * szkolnej i historyjki na końcu sesji.
 */

export interface SchoolDeckOptions {
  expectedForm?: string;
  openAcceptedAnswers?: string[];
  secondObjective?: boolean;
  precisionTrainer?: boolean;
  comparison?: boolean;
  /** Historyjka na koniec sesji (wymaga przedmiotu z `lessonStory`). */
  story?: LessonStoryFixture;
}

export const SCHOOL_OBJECTIVE_ID = "school.ddeck000.fotosynteza";
export const SCHOOL_SECOND_OBJECTIVE_ID = "school.ddeck000.korzenie";
export const SCHOOL_MATERIAL =
  "Fotosynteza to proces, w którym roślina z wody i dwutlenku węgla, przy udziale światła, wytwarza cukry.";

export async function seedSchoolDeck(
  pool: Pool,
  childId: string,
  options: SchoolDeckOptions = {},
): Promise<{ deckId: string; versionId: string }> {
  const deckId = randomUUID();
  const versionId = randomUUID();
  const context = {
    subjectId: "school",
    topicId: "dynamic",
    topicVersion: 1,
    objectiveIds: options.secondObjective ? [SCHOOL_OBJECTIVE_ID, SCHOOL_SECOND_OBJECTIVE_ID] : [SCHOOL_OBJECTIVE_ID],
    poolSize: 20,
    examples: {},
    material: SCHOOL_MATERIAL,
    subjectTitlePl: "Przyroda",
    ...(options.story ? { story: options.story } : {}),
    dynamicTopic: {
      titlePl: "Rośliny",
      objectives: [{
        id: SCHOOL_OBJECTIVE_ID,
        titlePl: "Fotosynteza",
        descriptionEn: "Photosynthesis: plant produces sugars from water, carbon dioxide and light.",
        cards: [
          { title: "Co to jest?", body: "Roślina wytwarza cukry z wody i dwutlenku węgla przy świetle." },
          { title: "Po co?", body: "Cukry są pokarmem rośliny." },
        ],
      }, ...(options.secondObjective ? [{
        id: SCHOOL_SECOND_OBJECTIVE_ID,
        titlePl: "Korzenie",
        descriptionEn: "Roots take water from the soil.",
        cards: [{ title: "Korzenie", body: "Korzenie pobierają wodę z gleby." }],
      }] : [])],
    },
  };
  await pool.query("insert into learning_app.decks (id, title, kind) values ($1, 'Przyroda: Rośliny', 'lesson')", [deckId]);
  await pool.query(
    `insert into learning_app.deck_versions (id, deck_id, version_number, edit_number, state, title, lesson_context)
     values ($1, $2, 1, 1, 'draft', 'Przyroda: Rośliny', $3::jsonb)`,
    [versionId, deckId, JSON.stringify(context)],
  );
  const exercises: Record<string, unknown>[] = [
    {
      exerciseType: "lesson_choice", objectiveId: SCHOOL_OBJECTIVE_ID, instructionPl: "Wybierz.",
      stem: "Co roślina wytwarza w fotosyntezie?", answer: "cukry", acceptedAnswers: [], focus: ["cukry"],
      options: [{ id: "a", text: "cukry" }, { id: "b", text: "tlen" }], correctOption: "a",
      sourceRefs: [{ quote: "wytwarza cukry" }],
    },
    {
      // Drugie ćwiczenie prowadzone: awans etapu wymaga 2 sukcesów (advanceAfterCorrect).
      exerciseType: "lesson_choice", objectiveId: SCHOOL_OBJECTIVE_ID, instructionPl: "Wybierz.",
      stem: "Co roślina wykorzystuje ze słońca?", answer: "światło", acceptedAnswers: [], focus: ["światło"],
      options: [{ id: "a", text: "światło" }, { id: "b", text: "cień" }], correctOption: "a",
      sourceRefs: [{ quote: "przy udziale światła" }],
    },
    {
      exerciseType: "lesson_gap", objectiveId: SCHOOL_OBJECTIVE_ID, instructionPl: "Uzupełnij.",
      stem: "W fotosyntezie roślina wytwarza ___.", answer: "cukry", acceptedAnswers: [], focus: ["cukry"],
      sourceRefs: [{ quote: "wytwarza cukry" }],
    },
    {
      exerciseType: "lesson_gap", objectiveId: SCHOOL_OBJECTIVE_ID, instructionPl: "Uzupełnij.",
      stem: "Roślina wytwarza cukry z wody i ___.", answer: "dwutlenku węgla", acceptedAnswers: [], focus: ["dwutlenku"],
      sourceRefs: [{ quote: "z wody i dwutlenku węgla" }],
    },
    {
      exerciseType: "lesson_open_answer", objectiveId: SCHOOL_OBJECTIVE_ID, instructionPl: "Odpowiedz własnymi słowami.",
      prompt: "Co to jest fotosynteza?",
      answer: "Roślina z wody i dwutlenku węgla, przy udziale światła, wytwarza cukry.",
      acceptedAnswers: options.openAcceptedAnswers ?? [], focus: ["wytwarza cukry"],
      questionType: "definition", expectedForm: options.expectedForm ?? "explanation",
      requiredElements: [
        { id: "e1", text: "Roślina wytwarza cukry" },
        { id: "e2", text: "roślina wykorzystuje światło" },
      ],
      supplementaryElements: [], commonErrors: ["Fotosynteza to oddychanie rośliny."],
      sourceRefs: [{ quote: "przy udziale światła, wytwarza cukry" }],
      ...(options.precisionTrainer ? { familyId: "def" } : {}),
    },
  ];
  if (options.comparison) {
    // Etap 6: zwykłe pytanie otwarte innej rodziny PRZED pytaniem porównawczym w puli —
    // wybór porównania po pomyleniu pojęć wynika wtedy z reguły selektora, nie z kolejności.
    exercises.push({
      exerciseType: "lesson_open_answer", objectiveId: SCHOOL_OBJECTIVE_ID, instructionPl: "Odpowiedz własnymi słowami.",
      prompt: "Czego roślina potrzebuje do fotosyntezy?",
      answer: "Roślina potrzebuje wody, dwutlenku węgla i światła.",
      acceptedAnswers: [], focus: ["światła"], questionType: "enumeration", expectedForm: "explanation", familyId: "potrzeby",
      requiredElements: [{ id: "p1", text: "roślina potrzebuje wody" }, { id: "p2", text: "roślina potrzebuje światła" }],
      supplementaryElements: [], commonErrors: [], sourceRefs: [{ quote: "z wody i dwutlenku węgla" }],
    }, {
      exerciseType: "lesson_open_answer", objectiveId: SCHOOL_OBJECTIVE_ID, instructionPl: "Odpowiedz własnymi słowami.",
      prompt: "Czym różni się fotosynteza od oddychania rośliny?",
      answer: "Fotosynteza wytwarza cukry przy świetle, a oddychanie je rozkłada.",
      acceptedAnswers: [], focus: ["wytwarza cukry"], questionType: "comparison", expectedForm: "explanation", familyId: "porownanie",
      requiredElements: [{ id: "c1", text: "fotosynteza wytwarza cukry" }, { id: "c2", text: "oddychanie rozkłada cukry" }],
      supplementaryElements: [], commonErrors: [], sourceRefs: [{ quote: "wytwarza cukry" }],
    });
  }
  if (options.precisionTrainer) {
    // Trener precyzji: druga rodzina pytań (inne pytanie i odpowiedź) i słowa
    // kluczowe rodziny „def” — para wybór pojęć → odpowiedź otwarta.
    exercises.push({
      exerciseType: "lesson_open_answer", objectiveId: SCHOOL_OBJECTIVE_ID, instructionPl: "Odpowiedz własnymi słowami.",
      prompt: "Czego roślina potrzebuje do fotosyntezy?",
      answer: "Roślina potrzebuje wody, dwutlenku węgla i światła.",
      acceptedAnswers: [], focus: ["światła"], questionType: "enumeration", expectedForm: "explanation", familyId: "potrzeby",
      requiredElements: [{ id: "p1", text: "roślina potrzebuje wody" }, { id: "p2", text: "roślina potrzebuje światła" }],
      supplementaryElements: [], commonErrors: [],
      sourceRefs: [{ quote: "z wody i dwutlenku węgla" }],
    }, {
      exerciseType: "lesson_keywords", objectiveId: SCHOOL_OBJECTIVE_ID, familyId: "def",
      keywordOptions: [{ id: "k1", text: "światło" }, { id: "k2", text: "cukry" }, { id: "k3", text: "korzenie" }, { id: "k4", text: "tlen" }],
      keyOptionIds: ["k1", "k2"], answer: "światło, cukry", acceptedAnswers: [], focus: [],
      sourceRefs: [{ quote: "wytwarza cukry" }],
    });
  }
  if (options.secondObjective) {
    // Drugie zagadnienie wydłuża plan sesji (wprowadzenie nowego celu), żeby
    // odpowiedź otwarta pierwszego celu nie trafiała w fazę „Jeszcze 3 i koniec!”.
    for (const stem of ["Co pobierają korzenie?", "Skąd korzenie biorą wodę?", "Czym są korzenie dla rośliny?"]) {
      exercises.push({
        exerciseType: "lesson_choice", objectiveId: SCHOOL_SECOND_OBJECTIVE_ID, instructionPl: "Wybierz.",
        stem, answer: "wodę", acceptedAnswers: [], focus: ["wodę"],
        options: [{ id: "a", text: "wodę" }, { id: "b", text: "cukier" }], correctOption: "a",
        sourceRefs: [{ quote: "wytwarza cukry" }],
      });
    }
  }
  let position = 0;
  for (const payload of exercises) {
    const itemId = randomUUID();
    const revisionId = randomUUID();
    const skillVersionId = randomUUID();
    await pool.query("insert into learning_app.learning_items (id, deck_id, kind) values ($1, $2, 'lesson_exercise')", [itemId, deckId]);
    await pool.query(
      `insert into learning_app.item_revisions (id, item_id, deck_id, deck_version_id, position, payload_version, payload, target_key)
       values ($1, $2, $3, $4, $5, 3, $6::jsonb, $7)`,
      [revisionId, itemId, deckId, versionId, position++, JSON.stringify(payload), computeTargetKey(String(payload.answer), "pl-PL")],
    );
    await pool.query(
      `insert into learning_app.skill_versions (id, item_id, skill, revision_number, criteria, criteria_hash)
       values ($1, $2, 'objective', 1, $3::jsonb, $4)`,
      [skillVersionId, itemId, JSON.stringify({ objectiveId: payload.objectiveId }), `oc-${skillVersionId}`],
    );
    await pool.query(
      "insert into learning_app.item_revision_skills (item_revision_id, item_id, skill, skill_version_id) values ($1, $2, 'objective', $3)",
      [revisionId, itemId, skillVersionId],
    );
  }
  await pool.query("update learning_app.deck_versions set state = 'published', published_at = now() where id = $1", [versionId]);
  await pool.query("update learning_app.decks set published_version_id = $1 where id = $2", [versionId, deckId]);
  await pool.query(
    "insert into learning_app.assignments (id, child_id, deck_id, test_date, test_goals) values ($1, $2, $3, CURRENT_DATE + 7, ARRAY['lesson'])",
    [randomUUID(), childId, deckId],
  );
  return { deckId, versionId };
}
