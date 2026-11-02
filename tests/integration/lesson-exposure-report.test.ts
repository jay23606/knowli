import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { reportLessonExposureLeaks } from "../../packages/server/src/modules/materials/lessons/lesson-exposure-report";
import { lessonWorld, seedEditorPoolWithLeak } from "../fixtures/lesson-world";
import { buildTestServices, testDatabase } from "./helpers";

const { pool } = testDatabase();

beforeEach(async () => {
  await pool.query(`truncate learning_app.revision_assets, learning_app.media_assets,
    learning_app.item_revision_skills, learning_app.item_revisions, learning_app.skill_versions,
    learning_app.learning_items, learning_app.deck_versions, learning_app.decks cascade`);
});
afterAll(() => pool.end());

describe("raport ujawnionych rozwiązań w istniejących szkicach", () => {
  it("rozróżnia szkic czysty, z ujawnieniem przy wystarczającym pokryciu i z ujawnieniem powodującym brak", async () => {
    const { services } = buildTestServices();
    const clean = await lessonWorld(pool, { publish: false, editorReady: true, title: "Czysty" });
    const covered = await lessonWorld(pool, { publish: false, title: "Z zapasem" });
    await seedEditorPoolWithLeak(pool, covered, { spareIndependent: true });
    const blocked = await lessonWorld(pool, { publish: false, title: "Zablokowany" });
    await seedEditorPoolWithLeak(pool, blocked);
    // Zablokowany już przed regułą: pula z ujawnieniem bez ćwiczeń luki (brak etapu produktywnego).
    const blockedBefore = await lessonWorld(pool, { publish: false, title: "Zablokowany wcześniej" });
    await seedEditorPoolWithLeak(pool, blockedBefore);
    await pool.query(
      `delete from learning_app.item_revision_skills where item_revision_id in (
         select id from learning_app.item_revisions where deck_version_id = $1 and payload->>'exerciseType' = 'lesson_gap')`,
      [blockedBefore.versionId],
    );
    await pool.query("delete from learning_app.item_revisions where deck_version_id = $1 and payload->>'exerciseType' = 'lesson_gap'", [blockedBefore.versionId]);
    // Opublikowana wersja jest niezmienna i nie wchodzi do raportu.
    await lessonWorld(pool, { title: "Opublikowany" });

    const rows = await reportLessonExposureLeaks(services.db, services);
    const byVersion = new Map(rows.map((row) => [row.deckVersionId, row]));

    expect(rows).toHaveLength(4);
    expect(byVersion.get(clean.versionId)).toMatchObject({
      deckId: clean.deckId, state: "draft", hardLeaks: 0, softLeaks: 0, blockedBefore: false, blockedAfter: false,
    });
    expect(byVersion.get(covered.versionId)).toMatchObject({
      deckId: covered.deckId, state: "draft", hardLeaks: 1, softLeaks: 0, blockedBefore: false, blockedAfter: false,
    });
    expect(byVersion.get(blocked.versionId)).toMatchObject({
      deckId: blocked.deckId, state: "draft", hardLeaks: 1, softLeaks: 0, blockedBefore: false, blockedAfter: true,
    });
    expect(byVersion.get(blockedBefore.versionId)).toMatchObject({
      deckId: blockedBefore.deckId, state: "draft", hardLeaks: 1, softLeaks: 0, blockedBefore: true, blockedAfter: true,
    });
    const newlyBlocked = rows.filter((row) => row.blockedAfter && !row.blockedBefore).map((row) => row.deckVersionId);
    expect(newlyBlocked).toEqual([blocked.versionId]);
  });

  it("szkic w stanie review też jest raportowany", async () => {
    const { services } = buildTestServices();
    const lesson = await lessonWorld(pool, { publish: false });
    await seedEditorPoolWithLeak(pool, lesson);
    await pool.query("update learning_app.deck_versions set state = 'review' where id = $1", [lesson.versionId]);

    const rows = await reportLessonExposureLeaks(services.db, services);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deckVersionId: lesson.versionId, state: "review", hardLeaks: 1 });
  });
});
