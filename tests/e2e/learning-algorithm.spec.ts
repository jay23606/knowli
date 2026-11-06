import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { messages } from "@learning/contracts";
import { createDatabase } from "@learning/server";
import { readTestRunConfig } from "../test-run-config";
import { E2E_SETUP_TOKEN } from "./helpers/parent-session";

let db: ReturnType<typeof createDatabase> | null = null;
async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (!db) {
    const world = JSON.parse(await readFile(join(process.cwd(), readTestRunConfig(process.env).worldFile), "utf8")) as { databaseUrl: string };
    db = createDatabase(world.databaseUrl);
  }
  return (await db.pool.query(sql, params)).rows as T[];
}

test.afterAll(async () => { await db?.pool.end(); });

async function createAssignedDeck(parent: APIRequestContext, childId: string, target: string): Promise<{ deckId: string; versionId: string }> {
  const title = `Pisownia ${randomUUID()}`;
  const deckId = randomUUID();
  expect((await parent.post("/api/v1/parent/decks", { data: { deckId, title } })).status()).toBe(201);
  const deck = await (await parent.get(`/api/v1/parent/decks/${deckId}`)).json() as { draft: { id: string } };
  expect(deck.draft?.id).toBeTruthy();
  const saved = await parent.patch(`/api/v1/parent/drafts/${deck.draft.id}`, {
    data: {
      title,
      expectedEditNumber: 1,
      items: [target, "Tuesday"].map((target, index) => ({
        source: ["poniedziałek", "wtorek"][index]!, target, acceptedAnswers: [],
        locales: { source: "pl-PL", target: "en-GB" }, visualType: "none",
      })),
    },
  });
  expect(saved.status()).toBe(200);
  let published = false;
  for (let i = 0; i < 720 && !published; i += 1) {
    const current = await (await parent.get(`/api/v1/parent/drafts/${deck.draft.id}`)).json();
    if (current.assets.some((asset: { role: string; state: string }) => asset.role === "target_audio" && asset.state !== "approved")) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    published = (await parent.post(`/api/v1/parent/drafts/${deck.draft.id}/publish`, {
      data: { expectedEditNumber: current.editNumber },
    })).status() === 200;
  }
  expect(published).toBe(true);
  expect((await parent.put(`/api/v1/parent/assignments/${childId}/${deckId}`, { data: { testDate: null } })).status()).toBe(204);
  const publishedDeck = await (await parent.get(`/api/v1/parent/decks/${deckId}`)).json() as { published: { id: string } };
  return { deckId, versionId: publishedDeck.published.id };
}

async function seedDue(childId: string, versionId: string): Promise<void> {
  const rows = await query<{ skill_version_id: string }>(
    `select s.skill_version_id from learning_app.item_revision_skills s
      join learning_app.item_revisions r on r.id = s.item_revision_id
     where r.deck_version_id = $1 and r.position = 0 and s.skill in ('recall','spelling')`,
    [versionId],
  );
  for (const row of rows) await query(
    `insert into learning_app.child_skill_progress
       (child_id, skill_version_id, policy_id, status, independent_success_streak, next_review_at, projection_version)
     select $1, $2, coalesce(c.policy_id, 'learning-v2'), 'needs_confirmation', 2, '2026-10-01T00:00:00Z', 'proj-3'
     from learning_app.child_profiles c where c.id = $1
     on conflict (child_id, skill_version_id, policy_id) do update set
       status = excluded.status, independent_success_streak = excluded.independent_success_streak,
       next_review_at = excluded.next_review_at`,
    [childId, row.skill_version_id],
  );
  expect(rows).toHaveLength(2);
}

async function taskInfo(taskId: string): Promise<{ exercise_type: string; state: string; answer_key: { target: string } }> {
  return (await query<{ exercise_type: string; state: string; answer_key: { target: string } }>(
    `select exercise_type, state, answer_key from learning_app.session_tasks where id = $1`, [taskId],
  ))[0]!;
}

async function useLegacyScheduler(sessionId: string): Promise<void> {
  // This suite covers the compatibility path for sessions created before the
  // fixed-plan migration. New-session behavior is asserted in the plan suite.
  await query("alter table learning_app.learning_sessions disable trigger learning_sessions_training_plan_immutable");
  try {
    await query("update learning_app.learning_sessions set training_plan = null, task_budget = 20 where id = $1", [sessionId]);
  } finally {
    await query("alter table learning_app.learning_sessions enable trigger learning_sessions_training_plan_immutable");
  }
}

for (const sample of [
  { target: "Monday", visible: "Mna", letters: ["o", "d", "y"], wrongAnswer: "Mxnday" },
  { target: "New York!", visible: "Nw Yr!", letters: ["e", "o", "k"], wrongAnswer: "Nxw York!" },
  { target: "A", visible: "", letters: ["A"], wrongAnswer: "x" },
  { target: "42", visible: "2", letters: ["4"], wrongAnswer: "x2" },
]) {
test(`letter_completion accepts only missing letters after spelling difficulty: ${sample.target}`, async ({ page }, testInfo) => {
  test.slow();
  const parent = page.request;
  await parent.post("/api/v1/parent/setup", { data: { secret: "1234", setupToken: E2E_SETUP_TOKEN } });
  expect((await parent.post("/api/v1/parent/login", { data: { secret: "1234" } })).status()).toBe(200);
  const child = await (await parent.post("/api/v1/parent/children", {
    data: { displayName: `Litery-${randomUUID()}`, avatarKey: "fox", birthYear: 2018 },
  })).json() as { id: string; displayName: string };
  const { deckId, versionId } = await createAssignedDeck(parent, child.id, sample.target);
  await seedDue(child.id, versionId);
  const firstDeckList = await parent.get(`/api/v1/kid/decks?childId=${child.id}`);
  expect(firstDeckList.ok()).toBeTruthy();

  const started = await parent.post("/api/v1/kid/sessions", {
    data: { childId: child.id, deckId, microphoneEnabled: true },
  });
  const { sessionId } = await started.json() as { sessionId: string };
  await useLegacyScheduler(sessionId);
  const source = await (await parent.post(`/api/v1/kid/sessions/${sessionId}/next`)).json() as { taskId: string; exerciseType: string };
  expect(source.exerciseType).toBe("recall");
  for (let failure = 0; failure < 2; failure += 1) {
    expect((await parent.post(`/api/v1/kid/tasks/${source.taskId}/attempts`, {
      data: { clientAttemptId: randomUUID(), modality: "text", text: "wrong" },
    })).status()).toBe(200);
  }
  const support = await (await parent.post(`/api/v1/kid/sessions/${sessionId}/next`)).json() as { taskId: string; exerciseType: string };
  expect(support.exerciseType).toBe("exposure");
  await parent.post(`/api/v1/kid/tasks/${support.taskId}/complete-presentation`);
  const other = await (await parent.post(`/api/v1/kid/sessions/${sessionId}/next`)).json() as { taskId: string; exerciseType: string };
  expect(other.exerciseType).toBe("exposure");
  await parent.post(`/api/v1/kid/tasks/${other.taskId}/complete-presentation`);
  const retry = await (await parent.post(`/api/v1/kid/sessions/${sessionId}/next`)).json() as { taskId: string; exerciseType: string };
  expect(retry.exerciseType).toBe("letter_completion");

  await page.goto(`/kids/${child.id}/learn`);
  await page.waitForSelector('[data-testid="kid-profile"], [data-testid="kid-deck"]', { timeout: 30_000 });
  if (await page.getByTestId("kid-profile").count()) await page.getByTestId("kid-profile").filter({ hasText: child.displayName }).click();
  await page.getByTestId("kid-mic-settings").click();
  await page.getByTestId("kid-mic-toggle").check();
  await page.getByTestId("kid-mic-settings").click();
  await page.getByTestId("kid-deck").filter({ hasText: `Pisownia` }).first().click();

  const letterTaskId = retry.taskId;
  expect((await taskInfo(letterTaskId)).exercise_type).toBe("letter_completion");
  const gaps = page.getByTestId("kid-letter-input");
  await expect(gaps).toHaveCount(sample.letters.length, { timeout: 5_000 });
  await expect(page.getByTestId("kid-input")).toHaveCount(0);
  await expect(page.getByTestId("kid-fragment")).toHaveText(sample.visible);
  await expect(page.getByTestId("kid-instruction")).toContainText(messages.kid.instructionLetterCompletion);
  await expect(gaps.first()).toHaveAttribute("autocorrect", "off");
  await expect(gaps.first()).toHaveAttribute("autocapitalize", "off");
  await expect(gaps.first()).toHaveAttribute("spellcheck", "false");
  await expect(page.getByTestId("kid-record")).toHaveCount(0);
  await expect(page.getByTestId("kid-submit")).toBeDisabled();

  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 1024 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`letters-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await gaps.nth(0).fill("x");
  for (let index = 1; index < sample.letters.length; index += 1) {
    await expect(gaps.nth(index)).toBeFocused();
    await expect(page.getByTestId("kid-submit")).toBeDisabled();
    await gaps.nth(index).fill(sample.letters[index]!);
  }
  // Usunięcie wcześniej wpisanej litery ponownie blokuje sprawdzenie.
  await gaps.nth(0).fill("");
  await expect(page.getByTestId("kid-submit")).toBeDisabled();
  await gaps.nth(0).fill("x");
  await page.getByTestId("kid-submit").click();
  await expect(page.getByTestId("kid-feedback")).toContainText(/Posłuchaj|Prawie/);
  await page.getByTestId("kid-next").click();
  await gaps.nth(0).fill(sample.letters[0]!);
  for (let index = 1; index < sample.letters.length; index += 1) {
    await expect(gaps.nth(index)).toHaveValue(sample.letters[index]!);
  }
  await page.getByTestId("kid-submit").click();
  await expect(page.getByTestId("kid-feedback")).toContainText("Świetnie");
  await page.getByTestId("kid-next").click();
  expect(await taskInfo(letterTaskId)).toMatchObject({ exercise_type: "letter_completion", state: "answered" });
  const writtenAttempts = await query<{ answer: { text: string } }>(
    `select answer from learning_app.attempts where task_id = $1 order by received_at`, [letterTaskId],
  );
  expect(writtenAttempts.map((attempt) => attempt.answer.text)).toEqual([sample.wrongAnswer, sample.target]);
  const assessments = await query<{ independent: boolean }>(
    `select independent from learning_app.assessments where attempt_id in
      (select id from learning_app.attempts where task_id = $1)`, [letterTaskId],
  );
  expect(assessments.length).toBeGreaterThan(0);
  expect(assessments.every((assessment) => assessment.independent === false)).toBe(true);
});
}
