import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createChild, endSession, nextTask, readLessonMockTestSummary, startSession, submitAttempt } from "@learning/server";
import { readLessonDeckOverviews, type LessonDeckOverviewInput } from "../../packages/server/src/modules/learning/lessons/lesson-deck-overview";
import type { LessonContextShape } from "../../packages/server/src/modules/learning/lessons/lesson-sessions";
import { lessonWorld } from "../fixtures/lesson-world";
import { buildTestServices, capturePoolQueries, testDatabase, truncateCoreTables } from "./helpers";

const { pool } = testDatabase();

beforeEach(async () => {
  await truncateCoreTables();
  await pool.query(`truncate learning_app.child_objective_progress, learning_app.lesson_verdicts,
    learning_app.revision_assets, learning_app.media_assets, learning_app.item_revision_skills,
    learning_app.item_revisions, learning_app.skill_versions, learning_app.learning_items,
    learning_app.deck_versions, learning_app.decks cascade`);
});
afterAll(() => pool.end());

async function captureSelects<T>(run: () => Promise<T>): Promise<{ value: T; selects: string[] }> {
  const captured = await capturePoolQueries(pool, run, (sql) => /^\s*(select|with)\b/i.test(sql));
  return { value: captured.value, selects: captured.queries };
}

describe("zbiorczy odczyt wartości lekcji", () => {
  it("zwraca wartości listy i dostępność kartkówki bez odczytu mediów; bez celu kartkówki nic nie wybiera", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "Lekcja", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, testDate: "2026-10-20", richPool: true });
    const version = (await pool.query<{ lesson_context: LessonContextShape }>(
      "select lesson_context from learning_app.deck_versions where id = $1", [lesson.versionId],
    )).rows[0]!;
    const input: LessonDeckOverviewInput = {
      deckId: lesson.deckId,
      versionId: lesson.versionId,
      testDate: "2026-10-20",
      testGoals: ["lesson"],
      mockTestTaskCount: 10,
      lessonContext: version.lesson_context,
    };
    const { value: overview, selects } = await captureSelects(() => readLessonDeckOverviews(services, services.db, {
      childId: child.id, now: services.clock.now(), decks: [input],
    }));
    expect(selects.length).toBeGreaterThan(0);
    expect(selects.some((sql) => /media_assets|revision_assets/i.test(sql))).toBe(false);
    expect(overview.get(lesson.deckId)).toEqual({
      itemCount: 1, independentlyRecalledCount: 0, recommended: true, mockTestAvailable: true,
    });

    const noGoal = await readLessonDeckOverviews(services, services.db, {
      childId: child.id, now: services.clock.now(), decks: [{ ...input, testGoals: null }],
    });
    expect(noGoal.get(lesson.deckId)?.mockTestAvailable).toBe(false);

    const seenFallback = await readLessonDeckOverviews(services, services.db, {
      childId: child.id,
      now: services.clock.now(),
      decks: [input],
      readExposedTargetKeys: async ({ targetKeys }) => new Set(targetKeys),
    });
    expect(seenFallback.get(lesson.deckId)?.mockTestAvailable).toBe(true);
  });

  it("utrzymuje stałą liczbę SELECT-ów nowego odczytu dla 1/10/30 lekcji", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "Lekcja", avatarKey: "owl" });
    const worlds = await Promise.all(Array.from({ length: 30 }, () =>
      lessonWorld(pool, { childId: child.id, testDate: "2026-10-20", richPool: true }),
    ));
    const inputs: LessonDeckOverviewInput[] = [];
    for (const world of worlds) {
      const version = (await pool.query<{ lesson_context: LessonContextShape }>(
        "select lesson_context from learning_app.deck_versions where id = $1", [world.versionId],
      )).rows[0]!;
      inputs.push({
        deckId: world.deckId, versionId: world.versionId, testDate: "2026-10-20",
        testGoals: ["lesson"], mockTestTaskCount: 10, lessonContext: version.lesson_context,
      });
    }
    const counts: number[] = [];
    for (const count of [1, 10, 30]) {
      const { value, selects } = await captureSelects(() => readLessonDeckOverviews(services, services.db, {
        childId: child.id, now: services.clock.now(), decks: inputs.slice(0, count),
      }));
      expect(value.size).toBe(count);
      counts.push(selects.length);
    }
    expect(counts[1]).toBe(counts[0]);
    expect(counts[2]).toBe(counts[1]);
  });

  it("start ponownie dobiera porcję po ekspozycji powstałej po wcześniejszej dostępności", async () => {
    const { services, clock } = buildTestServices();
    const child = await createChild(services, { displayName: "Lekcja", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, testDate: "2026-10-20", richPool: true });
    const version = (await pool.query<{ lesson_context: LessonContextShape }>(
      "select lesson_context from learning_app.deck_versions where id = $1", [lesson.versionId],
    )).rows[0]!;
    const input: LessonDeckOverviewInput = {
      deckId: lesson.deckId, versionId: lesson.versionId, testDate: "2026-10-20",
      testGoals: ["lesson"], mockTestTaskCount: 1, lessonContext: version.lesson_context,
    };
    const beforeExposure = await readLessonDeckOverviews(services, services.db, {
      childId: child.id, now: services.clock.now(), decks: [input],
    });
    expect(beforeExposure.get(lesson.deckId)?.mockTestAvailable).toBe(true);
    await pool.query("update learning_app.assignments set mock_test_task_count = 1 where child_id = $1 and deck_id = $2", [child.id, lesson.deckId]);

    const first = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false, mode: "mock_test" });
    const firstPlan = (await pool.query<{ plan: { slots: { itemRevisionId: string }[] } }>(
      "select mock_test_plan as plan from learning_app.learning_sessions where id = $1", [first.sessionId],
    )).rows[0]!.plan;
    const task = await nextTask(services, first.sessionId);
    expect(task?.exerciseType).toBe("lesson_gap");
    const key = (await pool.query<{ answer_key: { answer: string } }>(
      "select answer_key from learning_app.session_tasks where id = $1", [task!.taskId],
    )).rows[0]!.answer_key;
    await submitAttempt(services, {
      taskId: task!.taskId, clientAttemptId: randomUUID(), modality: "text", text: key.answer,
    });
    await endSession(services, first.sessionId);
    clock.advanceMs(11 * 60_000);
    await readLessonMockTestSummary(services, first.sessionId);
    const exposedCount = (await pool.query<{ count: number }>(
      `select count(*)::int as count from learning_app.event_exposures x
        join learning_app.learning_events e on e.id = x.event_id
       where e.task_id = $1 and e.sealed = true`, [task!.taskId],
    )).rows[0]!.count;
    expect(exposedCount).toBeGreaterThan(0);

    const second = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false, mode: "mock_test" });
    const secondPlan = (await pool.query<{ plan: { slots: { itemRevisionId: string }[] } }>(
      "select mock_test_plan as plan from learning_app.learning_sessions where id = $1", [second.sessionId],
    )).rows[0]!.plan;
    expect(secondPlan.slots[0]?.itemRevisionId).not.toBe(firstPlan.slots[0]?.itemRevisionId);
  });

});

