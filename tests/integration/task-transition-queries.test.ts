import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  completePresentation,
  createChild,
  createDraft,
  nextTask,
  publishDraft,
  startSession,
  submitAttempt,
  upsertAssignment,
} from "@learning/server";
import type { TaskDto } from "@learning/contracts";
import { buildTestServices, capturePoolQueries, finishLessonTask, startLegacyTrainingSession, testDatabase, truncateCoreTables } from "./helpers";
import { lessonWorld, STORY_FIXTURE } from "../fixtures/lesson-world";

const { pool } = testDatabase();

afterAll(async () => {
  await pool.end();
});

const ITEMS = [
  { source: "poniedziałek", target: "Monday" },
  { source: "wtorek", target: "Tuesday" },
  { source: "środa", target: "Wednesday" },
  { source: "czwartek", target: "Thursday" },
  { source: "piątek", target: "Friday" },
  { source: "sobota", target: "Saturday" },
];

async function attachFakeReadyAudio(deckVersionId: string, itemIndex: number): Promise<void> {
  const { rows } = await pool.query(
    "select id from learning_app.item_revisions where deck_version_id = $1 order by position offset $2 limit 1",
    [deckVersionId, itemIndex],
  );
  const assetId = randomUUID();
  const fingerprint = `fp-${randomUUID()}`;
  await pool.query(
    `insert into learning_app.media_assets
       (id, kind, fingerprint, generation_number, state, storage_key, content_sha256, mime_type, byte_count, provider, model)
     values ($1,'tts',$2,1,'ready',$3,$4,'audio/mpeg',1024,'fake','fake-tts')`,
    [assetId, fingerprint, `blob/${assetId}`, `sha-${assetId}`],
  );
  await pool.query(
    `insert into learning_app.revision_assets (item_revision_id, role, asset_id, expected_fingerprint, state)
     values ($1,'target_audio',$2,$3,'approved')`,
    [rows[0].id, assetId, fingerprint],
  );
  await pool.query(
    `insert into learning_app.revision_assets (item_revision_id, role, asset_id, expected_fingerprint, state)
     values ($1,'illustration',null,$2,'omitted')`,
    [rows[0].id, `fp-ill-${randomUUID()}`],
  );
}

async function publishDeck(services: ReturnType<typeof buildTestServices>["services"], childId: string) {
  const draft = await createDraft(services, {
    title: "Dni tygodnia",
    items: ITEMS.map((pair) => ({
      source: pair.source,
      target: pair.target,
      acceptedAnswers: [],
      locales: { source: "pl-PL", target: "en-GB" },
      visualType: "color" as const,
      visualData: { color: "#4169e1" },
    })),
  });
  for (const index of ITEMS.keys()) await attachFakeReadyAudio(draft.id, index);
  await publishDraft(services, draft.id, 1);
  await upsertAssignment(services, childId, draft.deckId, null);
  return { deckId: draft.deckId, versionId: draft.id };
}

/** Element ma należne sprawdzenie recall/pisowni (jak w attempts.test.ts). */
async function setDueCheck(childId: string, versionId: string, itemIndex: number): Promise<void> {
  const { rows } = await pool.query(
    "select id from learning_app.item_revisions where deck_version_id = $1 order by position offset $2 limit 1",
    [versionId, itemIndex],
  );
  const skills = await pool.query(
    "select skill_version_id from learning_app.item_revision_skills where item_revision_id = $1 and skill in ('recall','spelling')",
    [rows[0].id],
  );
  for (const row of skills.rows) {
    await pool.query(
      `insert into learning_app.child_skill_progress
         (child_id, skill_version_id, policy_id, status, independent_success_streak, next_review_at, last_reviewed_at, first_issued_at, projection_version, has_qualifying_assessment)
       select $1,$2,coalesce((select policy_id from learning_app.learning_sessions where child_id = $1 and state = 'active' order by started_at desc limit 1), c.policy_id, 'learning-v2'),'needs_confirmation',3,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z',null,'proj-3',false from learning_app.child_profiles c where c.id = $1
       on conflict (child_id, skill_version_id, policy_id) do update
         set status = excluded.status, independent_success_streak = excluded.independent_success_streak,
             next_review_at = excluded.next_review_at`,
      [childId, row.skill_version_id],
    );
  }
}

/** Wydaje zadania, kończąc karty/prezentacje po drodze, aż trafi na oceniane. */
async function firstAssessedTask(
  services: ReturnType<typeof buildTestServices>["services"],
  sessionId: string,
  cardType: "exposure" | "lesson_card",
): Promise<TaskDto> {
  for (let step = 0; step < 20; step++) {
    const issued = await nextTask(services, sessionId);
    expect(issued).not.toBeNull();
    if (issued!.exerciseType !== cardType) return issued!;
    await completePresentation(services, { taskId: issued!.taskId });
  }
  throw new Error("nie wydano zadania ocenianego");
}

async function correctInput(task: TaskDto) {
  const { rows } = await pool.query(
    "select answer_key as key from learning_app.session_tasks where id = $1",
    [task.taskId],
  );
  const key = rows[0].key as { target: string; correctOptionId?: string };
  if (key.correctOptionId) {
    return { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "choice" as const, optionId: key.correctOptionId };
  }
  return { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text" as const, text: key.target };
}

function summarize(label: string, queries: string[]) {
  const kinds = new Map<string, number>();
  for (const sql of queries) {
    const kind = sql.trim().split(/\s+/).slice(0, 2).join(" ").toLowerCase();
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  console.log(`[transition] ${label}: ${queries.length} zapytań`, Object.fromEntries(kinds));
  return queries.length;
}

describe("przejście między ćwiczeniami — liczba sekwencyjnych SQL", () => {
  beforeEach(async () => {
    await truncateCoreTables();
    await pool.query(
      `truncate learning_app.revision_assets, learning_app.media_assets, learning_app.item_revision_skills,
              learning_app.item_revisions, learning_app.skill_versions, learning_app.learning_items,
              learning_app.lesson_story_assets, learning_app.deck_versions, learning_app.decks cascade`,
    );
  });

  it("mierzy submitAttempt + nextTask na ścieżce treningu słówek", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "Ola", avatarKey: "fox" });
    const { deckId } = await publishDeck(services, child.id);
    const session = await startSession(services, { childId: child.id, deckId, microphoneEnabled: false });

    const task = await firstAssessedTask(services, session.sessionId, "exposure");

    const input = await correctInput(task);
    const submitted = await capturePoolQueries(pool, () => submitAttempt(services, input));
    expect(submitted.value.state).toBe("completed");
    const submitCount = summarize(`submitAttempt (${input.modality})`, submitted.queries);

    const next = await capturePoolQueries(pool, () => nextTask(services, session.sessionId));
    expect(next.value).not.toBeNull();
    expect(next.value!.state).toBe("issued");
    const nextCount = summarize("nextTask (plan)", next.queries);

    console.log(`[transition] łącznie: ${submitCount + nextCount}`);
    // Budżety regresji (baseline przed optymalizacją: submit 36, next 17,
    // łącznie 53 wywołania klienta, w tym begin/commit).
    expect(submitCount).toBeLessThanOrEqual(21);
    expect(nextCount).toBeLessThanOrEqual(12);
    expect(submitCount + nextCount).toBeLessThanOrEqual(33);
  });

  it("mierzy pisaną odpowiedź recall (dwie umiejętności naraz)", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "Ola", avatarKey: "fox" });
    const { deckId, versionId } = await publishDeck(services, child.id);
    await setDueCheck(child.id, versionId, 0);
    const session = await startLegacyTrainingSession(services, { childId: child.id, deckId, microphoneEnabled: false });
    const task = await nextTask(services, session.sessionId);
    expect(task?.exerciseType).toBe("recall");

    const input = await correctInput(task!);
    expect(input.modality).toBe("text");
    const submitted = await capturePoolQueries(pool, () => submitAttempt(services, input));
    expect(submitted.value.state).toBe("completed");
    const measured = summarize("submitAttempt (text, recall/spelling)", submitted.queries);
    // Dwie oceny zapisane, historia i projekcja policzone wsadowo.
    const assessments = await pool.query(
      "select count(*)::int as count from learning_app.assessments where attempt_id = $1",
      [submitted.value.attemptId],
    );
    expect(assessments.rows[0].count).toBe(2);
    expect(measured!).toBeLessThanOrEqual(23);
  });

  it("mierzy submitAttempt + nextTask na sciezce lekcji", async () => {
    const { services, clock } = buildTestServices();
    const child = await createChild(services, { displayName: "Lekcja", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, now: clock.now() });
    const session = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false });

    const task = await firstAssessedTask(services, session.sessionId, "lesson_card");

    const input = await correctInput(task);
    const submitted = await capturePoolQueries(pool, () => submitAttempt(services, input));
    expect(submitted.value.state).toBe("completed");
    const submitCount = summarize("submitLessonAttempt (choice)", submitted.queries);

    const next = await capturePoolQueries(pool, () => nextTask(services, session.sessionId));
    expect(next.value).not.toBeNull();
    expect(next.value!.state).toBe("issued");
    const nextCount = summarize("nextTask (lekcja, plan)", next.queries);

    console.log(`[transition] lekcja łącznie: ${submitCount + nextCount}`);
    expect(submitCount).toBeLessThanOrEqual(21);
    expect(nextCount).toBeLessThanOrEqual(12);
  });

  /** Lekcja z historyjką i budżetem 2; kończy zadania do ostatniego przed historyjką. */
  async function lessonBeforeStory() {
    const { services, clock } = buildTestServices();
    const child = await createChild(services, { displayName: "Historyjka", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, now: clock.now(), story: { value: STORY_FIXTURE, audio: "ready" } });
    await pool.query("update learning_app.decks set session_task_budget = 2 where id = $1", [lesson.deckId]);
    const session = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false });
    for (let step = 0; step < 20; step++) {
      const task = (await nextTask(services, session.sessionId))!;
      await finishLessonTask(services, task);
      if (task.remainingAssessed === 1 && task.exerciseType !== "lesson_card") return { services, sessionId: session.sessionId };
    }
    throw new Error("nie doszło do ostatniego zadania ocenianego");
  }

  it("nextTask issuing the story stays within the lesson budget", async () => {
    const { services, sessionId } = await lessonBeforeStory();
    const next = await capturePoolQueries(pool, () => nextTask(services, sessionId));
    expect(next.value?.exerciseType).toBe("lesson_story");
    expect(summarize("nextTask (lekcja, historyjka)", next.queries)).toBeLessThanOrEqual(12);
  });

  it("re-reading an issued story stays within the lesson budget", async () => {
    const { services, sessionId } = await lessonBeforeStory();
    const story = await nextTask(services, sessionId);
    expect(story?.exerciseType).toBe("lesson_story");
    const again = await capturePoolQueries(pool, () => nextTask(services, sessionId));
    expect(again.value).toEqual(story);
    expect(summarize("nextTask (lekcja, ponowny odczyt historyjki)", again.queries)).toBeLessThanOrEqual(12);
  });
});
