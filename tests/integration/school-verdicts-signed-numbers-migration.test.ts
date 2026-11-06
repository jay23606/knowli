import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createChild } from "@learning/server";
import { buildTestServices, testDatabase, truncateCoreTables } from "./helpers";
import { lessonWorld } from "../fixtures/lesson-world";
import { seedSchoolDeck } from "../fixtures/school-world";

/**
 * #318: migracja 0038 usuwa z cache werdyktów wpisy szkoły z cyfrą w
 * znormalizowanej odpowiedzi (dawniej „-5” i „5” dzieliły klucz). Wpisy szkoły
 * bez cyfr i wpisy innych przedmiotów zostają.
 */

const { pool } = testDatabase();
const migration = path.resolve("packages/server/drizzle/0038_school_verdicts_signed_numbers.sql");

beforeEach(async () => {
  await truncateCoreTables();
  await pool.query(`truncate learning_app.child_objective_progress, learning_app.lesson_verdicts,
    learning_app.revision_assets, learning_app.media_assets, learning_app.item_revision_skills,
    learning_app.item_revisions, learning_app.skill_versions, learning_app.learning_items,
    learning_app.deck_versions, learning_app.decks cascade`);
});
afterAll(() => pool.end());

async function insertVerdict(itemRevisionId: string, normalizedAnswer: string): Promise<void> {
  await pool.query(
    `insert into learning_app.lesson_verdicts (id, item_revision_id, normalized_answer, prompt_version, grader_model, verdict)
     values ($1, $2, $3, 'v', 'm', 'correct')`,
    [randomUUID(), itemRevisionId, normalizedAnswer],
  );
}

describe("migracja 0038 — cache werdyktów szkoły z liczbami (#318)", () => {
  it("usuwa wpisy szkoły z cyfrą, zostawia pozostałe i inne przedmioty", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "Ola", avatarKey: "fox" });
    const school = await seedSchoolDeck(pool, child.id);
    const grammar = await lessonWorld(pool);
    const { rows } = await pool.query<{ id: string }>(
      "select id from learning_app.item_revisions where deck_version_id = $1 limit 1",
      [school.versionId],
    );
    const schoolRevision = rows[0]!.id;

    await insertVerdict(schoolRevision, "5");
    await insertVerdict(schoolRevision, "temperatura 5 stopni");
    await insertVerdict(schoolRevision, "fotosynteza");
    await insertVerdict(grammar.revisionId, "5");

    await pool.query(await readFile(migration, "utf8"));

    const left = await pool.query<{ item_revision_id: string; normalized_answer: string }>(
      "select item_revision_id, normalized_answer from learning_app.lesson_verdicts order by normalized_answer",
    );
    expect(left.rows).toEqual([
      { item_revision_id: grammar.revisionId, normalized_answer: "5" },
      { item_revision_id: schoolRevision, normalized_answer: "fotosynteza" },
    ]);
  });
});
