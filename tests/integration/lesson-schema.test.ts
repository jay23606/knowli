import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { lessonWorld } from "../fixtures/lesson-world";
import { testDatabase } from "./helpers";

/**
 * Integracja migracji 0007_lessons: nowe CHECK-i i triggery warstwy lekcji
 * oraz tabele lesson_verdicts i child_objective_progress. Testy wkładają
 * surowe wiersze przez pulę pg, żeby sprawdzić bramki bazy niezależnie od
 * logiki modułów. Każdy przypadek ma wariant odrzucony i poprawny.
 */

const { pool } = testDatabase();

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

async function expectReject(sql: string, params: unknown[], fragment: string): Promise<void> {
  await expect(pool.query(sql, params)).rejects.toThrow(fragment);
}

/** Minimalny profil dziecka — potrzebny dla child_objective_progress. */
async function insertChild(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "insert into learning_app.child_profiles (id, display_name, avatar_key) values ($1, $2, $3)",
    [id, "Ola", "fox"],
  );
  return id;
}

interface DeckScope {
  deckId: string;
  versionId: string;
  itemId: string;
  revisionId: string;
}

/**
 * Zestaw danego rodzaju z jedną wersją (draft), jednym elementem i rewizją.
 * Element dopasowany do rodzaju zestawu (vocabulary↔vocabulary, lesson↔lesson_exercise),
 * żeby trigger zgodności nie blokował przygotowania sceny.
 */
async function insertDeckScope(kind: "vocabulary" | "lesson"): Promise<DeckScope> {
  const deckId = randomUUID();
  const versionId = randomUUID();
  const itemId = randomUUID();
  const revisionId = randomUUID();
  const itemKind = kind === "lesson" ? "lesson_exercise" : "vocabulary";
  const lessonContext =
    kind === "lesson"
      ? JSON.stringify({ subjectId: "english_grammar", topicId: "present_simple", topicVersion: 1, objectiveIds: ["o1"], poolSize: 10, examples: {}, material: "m", instruction: "i" })
      : null;

  await pool.query("insert into learning_app.decks (id, title, kind) values ($1, $2, $3)", [deckId, "Scope", kind]);
  await pool.query(
    `insert into learning_app.deck_versions (id, deck_id, version_number, edit_number, state, title, lesson_context)
     values ($1, $2, 1, 1, 'draft', 'Scope', $3::jsonb)`,
    [versionId, deckId, lessonContext],
  );
  await pool.query("insert into learning_app.learning_items (id, deck_id, kind) values ($1, $2, $3)", [itemId, deckId, itemKind]);
  await pool.query(
    `insert into learning_app.item_revisions (id, item_id, deck_id, deck_version_id, position, payload_version, payload, target_key)
     values ($1, $2, $3, $4, 0, 2, '{}'::jsonb, $5)`,
    [revisionId, itemId, deckId, versionId, `tk-${revisionId}`],
  );
  return { deckId, versionId, itemId, revisionId };
}

describe("migracja 0007_lessons — CHECK-i i triggery warstwy lekcji", () => {
  beforeEach(async () => {
    await pool.query(
      `truncate learning_app.child_objective_progress, learning_app.lesson_verdicts,
                learning_app.assignments, learning_app.item_revision_skills,
                learning_app.item_revisions, learning_app.skill_versions,
                learning_app.learning_items, learning_app.deck_versions,
                learning_app.decks, learning_app.child_profiles cascade`,
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("decks.kind dopuszcza vocabulary i lesson, odrzuca inne", async () => {
    const ok = randomUUID();
    await pool.query("insert into learning_app.decks (id, title, kind) values ($1, 'ok', 'lesson')", [ok]);
    await expectReject(
      "insert into learning_app.decks (id, title, kind) values ($1, 'bad', 'quiz')",
      [randomUUID()],
      "decks_kind_allowed",
    );
  });

  it("learning_items.kind dopuszcza vocabulary i lesson_exercise, odrzuca inne", async () => {
    const { deckId } = await insertDeckScope("lesson");
    // Nieprawidłowy kind w lekcji łapie najpierw trigger zgodności (BEFORE),
    // CHECK learning_items_kind_allowed to druga linia obrony. Oba mówią „kind”.
    await expectReject(
      "insert into learning_app.learning_items (id, deck_id, kind) values ($1, $2, 'flashcard')",
      [randomUUID(), deckId],
      "kind",
    );
  });

  it("decks.kind jest niezmienne po utworzeniu", async () => {
    const { deckId } = await insertDeckScope("vocabulary");
    await expectReject(
      "update learning_app.decks set kind = 'lesson' where id = $1",
      [deckId],
      "kind",
    );
    // zmiana innego pola przechodzi
    await pool.query("update learning_app.decks set title = 'nowa' where id = $1", [deckId]);
  });

  it("learning_items.kind musi być zgodny z decks.kind", async () => {
    const vocab = await insertDeckScope("vocabulary");
    // lesson_exercise w zestawie słówek — odrzucone
    await expectReject(
      "insert into learning_app.learning_items (id, deck_id, kind) values ($1, $2, 'lesson_exercise')",
      [randomUUID(), vocab.deckId],
      "kind",
    );
    const lesson = await insertDeckScope("lesson");
    // vocabulary w lekcji — odrzucone
    await expectReject(
      "insert into learning_app.learning_items (id, deck_id, kind) values ($1, $2, 'vocabulary')",
      [randomUUID(), lesson.deckId],
      "kind",
    );
    // zgodny element przechodzi (lesson_exercise w lekcji)
    await pool.query(
      "insert into learning_app.learning_items (id, deck_id, kind) values ($1, $2, 'lesson_exercise')",
      [randomUUID(), lesson.deckId],
    );
  });

  it("deck_versions.lesson_context: wymagane dla lekcji, zabronione dla słówek", async () => {
    // lekcja bez lesson_context — odrzucone
    const lessonDeck = randomUUID();
    await pool.query("insert into learning_app.decks (id, title, kind) values ($1, 'L', 'lesson')", [lessonDeck]);
    await expectReject(
      `insert into learning_app.deck_versions (id, deck_id, version_number, edit_number, state, title)
       values ($1, $2, 1, 1, 'draft', 'L')`,
      [randomUUID(), lessonDeck],
      "lesson_context",
    );
    // słówka z lesson_context — odrzucone
    const vocabDeck = randomUUID();
    await pool.query("insert into learning_app.decks (id, title, kind) values ($1, 'V', 'vocabulary')", [vocabDeck]);
    await expectReject(
      `insert into learning_app.deck_versions (id, deck_id, version_number, edit_number, state, title, lesson_context)
       values ($1, $2, 1, 1, 'draft', 'V', '{"subjectId":"x"}'::jsonb)`,
      [randomUUID(), vocabDeck],
      "lesson_context",
    );
    // oba poprawne warianty przechodzą (insertDeckScope ich używa)
    await insertDeckScope("lesson");
    await insertDeckScope("vocabulary");
  });

  it("deck_versions.lesson_context jest niezmienne po publikacji", async () => {
    const { versionId } = await insertDeckScope("lesson");
    await pool.query(
      "update learning_app.deck_versions set state = 'published', published_at = now() where id = $1",
      [versionId],
    );
    await expectReject(
      `update learning_app.deck_versions set lesson_context = '{"subjectId":"y"}'::jsonb where id = $1`,
      [versionId],
      "immutable",
    );
  });

  it("attempts.modality dopuszcza sequence", async () => {
    // sprawdzamy że sequence jest w dozwolonym zbiorze — pełny insert attempts
    // wymaga łańcucha task/session; tu bada sam CHECK przez constraint definicji.
    const rows = await query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conname = 'attempts_modality_allowed'`,
    );
    expect(rows[0]?.definition).toContain("sequence");
  });

  it("session_tasks.completed dozwolone dla lesson_card i lesson_story, nie dla innych typów lekcji", async () => {
    const rows = await query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conname = 'session_tasks_completed_only_exposure'`,
    );
    expect(rows[0]?.definition).toContain("lesson_card");
    expect(rows[0]?.definition).toContain("lesson_story");
    expect(rows[0]?.definition).toContain("exposure");
    // Pytanie historyjki kończy się stanem `answered`, więc nie ma go na liście.
    expect(rows[0]?.definition).not.toMatch(/lesson_story_question/);

    // Zachowanie: `completed` przechodzi dla historyjki, a dla jej pytania jest odrzucane.
    const child = await insertChild();
    const world = await lessonWorld(pool, { childId: child });
    const sessionId = randomUUID();
    const assignmentId = (
      await query<{ id: string }>("select id from learning_app.assignments where child_id = $1 and deck_id = $2", [child, world.deckId])
    )[0]!.id;
    await pool.query(
      `insert into learning_app.learning_sessions
         (id, child_id, assignment_id, deck_id, deck_version_id, policy_id, microphone_enabled, mode, state, task_budget, started_at)
       values ($1, $2, $3, $4, $5, 'learning-v2', false, 'training', 'active', 5, now())`,
      [sessionId, child, assignmentId, world.deckId, world.versionId],
    );
    const insertTask = async (ordinal: number, exerciseType: string): Promise<string> => {
      const taskId = randomUUID();
      await pool.query(
        `insert into learning_app.session_tasks
           (id, session_id, child_id, deck_version_id, item_revision_id, ordinal, exercise_type, state, public_prompt, answer_key, issued_at)
         values ($1, $2, $3, $4, $5, $6, $7, 'issued', '{}'::jsonb, '{}'::jsonb, now())`,
        [taskId, sessionId, child, world.versionId, world.revisionId, ordinal, exerciseType],
      );
      return taskId;
    };
    // Naraz może być wydane tylko jedno zadanie sesji, więc historyjkę zamykamy przed pytaniem.
    const storyId = await insertTask(0, "lesson_story");
    await pool.query("update learning_app.session_tasks set state = 'completed' where id = $1", [storyId]);
    const questionId = await insertTask(1, "lesson_story_question");
    await expectReject(
      "update learning_app.session_tasks set state = 'completed' where id = $1",
      [questionId],
      "session_tasks_completed_only_exposure",
    );
    await pool.query("update learning_app.session_tasks set state = 'answered' where id = $1", [questionId]);
  });

  it("assignments.test_goals: lesson tylko dla lekcji, cele słówek tylko dla słówek", async () => {
    const child = await insertChild();
    const lesson = await insertDeckScope("lesson");
    const vocab = await insertDeckScope("vocabulary");

    // lesson jako cel dla zestawu słówek — odrzucone (trigger: cel lesson wymaga lekcji)
    await expectReject(
      `insert into learning_app.assignments (id, child_id, deck_id, test_goals)
       values ($1, $2, $3, array['lesson']::text[])`,
      [randomUUID(), child, vocab.deckId],
      "Lesson test goal requires a lesson deck",
    );
    // cel słówek (recall) dla lekcji — odrzucone (trigger: cele słówek wymagają słówek)
    await expectReject(
      `insert into learning_app.assignments (id, child_id, deck_id, test_goals)
       values ($1, $2, $3, array['recall']::text[])`,
      [randomUUID(), child, lesson.deckId],
      "Vocabulary test goals require a vocabulary deck",
    );
    // lesson + cel słówek razem — trigger (BEFORE) odrzuca je zanim dojdzie do
    // CHECK-u assignments_test_goals (wzajemne wykluczenie lesson/słówka to druga
    // linia obrony w CHECK-u). Na lekcji łapie je reguła celów słówek.
    await expectReject(
      `insert into learning_app.assignments (id, child_id, deck_id, test_goals)
       values ($1, $2, $3, array['lesson','recall']::text[])`,
      [randomUUID(), child, lesson.deckId],
      "Vocabulary test goals require a vocabulary deck",
    );
    // poprawnie: lesson dla lekcji
    await pool.query(
      `insert into learning_app.assignments (id, child_id, deck_id, test_goals)
       values ($1, $2, $3, array['lesson']::text[])`,
      [randomUUID(), child, lesson.deckId],
    );
    // poprawnie: cele słówek dla słówek (dotychczasowe zachowanie)
    await pool.query(
      `insert into learning_app.assignments (id, child_id, deck_id, test_goals)
       values ($1, $2, $3, array['recall','spelling']::text[])`,
      [randomUUID(), child, vocab.deckId],
    );
    // nieznany cel — odrzucony CHECK-iem assignments_test_goals (membership)
    await expectReject(
      `insert into learning_app.assignments (id, child_id, deck_id, test_goals)
       values ($1, $2, $3, array['bogus']::text[])`,
      [randomUUID(), child, vocab.deckId],
      "assignments_test_goals",
    );
  });

  it("generation_runs akceptuje kind lesson o kształcie deck", async () => {
    const { versionId } = await insertDeckScope("lesson");
    const okRun = randomUUID();
    await pool.query(
      `insert into learning_app.generation_runs (id, deck_version_id, expected_edit_number, kind, dedupe_key, state, input)
       values ($1, $2, 1, 'lesson', $3, 'queued', '{}'::jsonb)`,
      [okRun, versionId, `lesson:${okRun}`],
    );
    // lesson z asset_id (jak media) — odrzucone kształtem
    await expectReject(
      `insert into learning_app.generation_runs (id, kind, dedupe_key, state, input, asset_id)
       values ($1, 'lesson', $2, 'queued', '{}'::jsonb, $3)`,
      [randomUUID(), `lesson:${randomUUID()}`, randomUUID()],
      "generation_runs_kind_shape",
    );
    // lesson z lease — odrzucone
    await expectReject(
      `insert into learning_app.generation_runs (id, deck_version_id, expected_edit_number, kind, dedupe_key, state, input, lease_token, lease_until)
       values ($1, $2, 1, 'lesson', $3, 'queued', '{}'::jsonb, $4, now())`,
      [randomUUID(), versionId, `lesson:${randomUUID()}`, randomUUID()],
      "generation_runs_deck_without_lease",
    );
  });

  it("lesson_verdicts: unikalność (item_revision_id, normalized_answer, prompt_version)", async () => {
    const { revisionId } = await insertDeckScope("lesson");
    await pool.query(
      `insert into learning_app.lesson_verdicts (id, item_revision_id, normalized_answer, prompt_version, grader_model, verdict, fragments)
       values ($1, $2, 'he plays', 'p1', 'gpt', 'correct', '[]'::jsonb)`,
      [randomUUID(), revisionId],
    );
    await expectReject(
      `insert into learning_app.lesson_verdicts (id, item_revision_id, normalized_answer, prompt_version, grader_model, verdict, fragments)
       values ($1, $2, 'he plays', 'p1', 'gpt', 'almost', '[]'::jsonb)`,
      [randomUUID(), revisionId],
      "unique",
    );
    // inny prompt_version przechodzi
    await pool.query(
      `insert into learning_app.lesson_verdicts (id, item_revision_id, normalized_answer, prompt_version, grader_model, verdict, fragments)
       values ($1, $2, 'he plays', 'p2', 'gpt', 'correct', '[]'::jsonb)`,
      [randomUUID(), revisionId],
    );
  });

  it("lesson_verdicts: CHECK werdyktu i decyzji rodzica", async () => {
    const { revisionId } = await insertDeckScope("lesson");
    await expectReject(
      `insert into learning_app.lesson_verdicts (id, item_revision_id, normalized_answer, prompt_version, grader_model, verdict, fragments)
       values ($1, $2, 'x', 'p1', 'gpt', 'maybe', '[]'::jsonb)`,
      [randomUUID(), revisionId],
      "lesson_verdicts_verdict_allowed",
    );
    await expectReject(
      `insert into learning_app.lesson_verdicts (id, item_revision_id, normalized_answer, prompt_version, grader_model, verdict, fragments, parent_decision)
       values ($1, $2, 'x', 'p1', 'gpt', 'incorrect', '[]'::jsonb, 'maybe')`,
      [randomUUID(), revisionId],
      "lesson_verdicts_parent_decision_allowed",
    );
    // poprawna decyzja rodzica przechodzi
    await pool.query(
      `insert into learning_app.lesson_verdicts (id, item_revision_id, normalized_answer, prompt_version, grader_model, verdict, fragments, parent_decision, parent_decided_at)
       values ($1, $2, 'x', 'p1', 'gpt', 'incorrect', '[]'::jsonb, 'overridden_correct', now())`,
      [randomUUID(), revisionId],
    );
  });

  it("usunięcie profilu dziecka kasuje child_objective_progress, zachowuje lesson_verdicts", async () => {
    const child = await insertChild();
    const { revisionId } = await insertDeckScope("lesson");
    await pool.query(
      `insert into learning_app.lesson_verdicts (id, item_revision_id, normalized_answer, prompt_version, grader_model, verdict, fragments)
       values ($1, $2, 'he plays', 'p1', 'gpt', 'correct', '[]'::jsonb)`,
      [randomUUID(), revisionId],
    );
    await pool.query(
      `insert into learning_app.child_objective_progress
         (child_id, subject_id, objective_id, topic_id, status, streak, projection_version)
       values ($1, 'english_grammar', 'o1', 'present_simple', 'practicing', 1, 'proj-1')`,
      [child],
    );
    await pool.query("delete from learning_app.child_profiles where id = $1", [child]);

    const progress = await query("select 1 from learning_app.child_objective_progress where child_id = $1", [child]);
    expect(progress).toHaveLength(0);
    const verdicts = await query("select 1 from learning_app.lesson_verdicts where item_revision_id = $1", [revisionId]);
    expect(verdicts).toHaveLength(1);
  });

  it("child_objective_progress: CHECK statusu i streak nieujemny", async () => {
    const child = await insertChild();
    await insertDeckScope("lesson");
    await expectReject(
      `insert into learning_app.child_objective_progress
         (child_id, subject_id, objective_id, topic_id, status, streak, projection_version)
       values ($1, 'english_grammar', 'o1', 'present_simple', 'bogus', 1, 'proj-1')`,
      [child],
      "child_objective_progress_status_allowed",
    );
    await expectReject(
      `insert into learning_app.child_objective_progress
         (child_id, subject_id, objective_id, topic_id, status, streak, projection_version)
       values ($1, 'english_grammar', 'o1', 'present_simple', 'practicing', -1, 'proj-1')`,
      [child],
      "child_objective_progress_streak_nonnegative",
    );
  });

  it("istniejące dane słówek po migracji działają bez zmian", async () => {
    const vocab = await insertDeckScope("vocabulary");
    // domyślny kind, publikacja i cele słówek bez lesson_context
    const rows = await query<{ kind: string }>(
      "select kind from learning_app.decks where id = $1",
      [vocab.deckId],
    );
    expect(rows[0]?.kind).toBe("vocabulary");
  });
});
