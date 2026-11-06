import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createDatabase } from "@learning/server";
import { readTestRunConfig } from "../test-run-config";
import { E2E_SETUP_TOKEN } from "./helpers/parent-session";

type WorldPool = ReturnType<typeof createDatabase>["pool"];
let worldPool: WorldPool | null = null;

async function pool(): Promise<WorldPool> {
  if (worldPool === null) {
    const world = JSON.parse(
      await readFile(join(process.cwd(), readTestRunConfig(process.env).worldFile), "utf8"),
    ) as { databaseUrl: string };
    worldPool = createDatabase(world.databaseUrl).pool;
  }
  return worldPool;
}

test.afterAll(async () => {
  await worldPool?.end();
});

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await (await pool()).query(sql, params)).rows as T[];
}

function localTestDate(): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Warsaw",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date()).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function setupParent(page: import("@playwright/test").Page) {
  const parent = page.request;
  await parent.post("/api/v1/parent/setup", { data: { secret: "1234", setupToken: E2E_SETUP_TOKEN } });
  const login = await parent.post("/api/v1/parent/login", { data: { secret: "1234" } });
  expect(login.status()).toBe(200);
  return parent;
}

async function assignedDeck(parent: import("@playwright/test").APIRequestContext, childId: string) {
  const title = `Przygotowanie ${randomUUID()}`;
  const generate = await parent.post("/api/v1/parent/decks/generate", {
    data: { prompt: "angielskie dni tygodnia dla początkującego dziecka", idempotencyKey: randomUUID(), title },
  });
  expect(generate.status()).toBe(202);
  const { deckId } = await generate.json() as { deckId: string };

  let draftId: string | null = null;
  for (let attempt = 0; attempt < 960 && draftId === null; attempt += 1) {
    const deck = await (await parent.get(`/api/v1/parent/decks/${deckId}`)).json();
    if (deck.generation?.state === "succeeded" && deck.draft) draftId = deck.draft.id;
    else await new Promise((resolve) => setTimeout(resolve, 250));
  }
  expect(draftId).not.toBeNull();

  let published = false;
  for (let attempt = 0; attempt < 720 && !published; attempt += 1) {
    const draft = await (await parent.get(`/api/v1/parent/drafts/${draftId}`)).json();
    const pendingAudio = draft.assets.some(
      (asset: { role: string; state: string }) => asset.role === "target_audio" && asset.state !== "approved",
    );
    if (!pendingAudio) {
      published = (await parent.post(`/api/v1/parent/drafts/${draftId}/publish`, {
        data: { expectedEditNumber: draft.editNumber },
      })).status() === 200;
    } else await new Promise((resolve) => setTimeout(resolve, 250));
  }
  expect(published).toBe(true);
  expect((await parent.put(`/api/v1/parent/assignments/${childId}/${deckId}`, { data: { testDate: null } })).status()).toBe(204);
  return { deckId, title };
}

test("termin sprawdzianu prowadzi do pisemnego Recall przed nowym materiałem bez mikrofonu", async ({ page }) => {
  test.slow();
  const parent = await setupParent(page);
  const child = await (await parent.post("/api/v1/parent/children", {
    data: { displayName: `Test-${randomUUID()}`, avatarKey: "fox", birthYear: 2018 },
  })).json() as { id: string; displayName: string };
  const { deckId, title } = await assignedDeck(parent, child.id);

  // Utwórz prawdziwe, zapieczętowane historyczne ujawnienie pierwszego słowa.
  const initial = await (await page.request.post("/api/v1/kid/sessions", {
    data: { childId: child.id, deckId, microphoneEnabled: false },
  })).json() as { sessionId: string };
  const firstPresentation = await (await page.request.post(`/api/v1/kid/sessions/${initial.sessionId}/next`)).json() as { taskId: string; exerciseType: string };
  expect(firstPresentation.exerciseType).toBe("exposure");
  await page.request.post(`/api/v1/kid/tasks/${firstPresentation.taskId}/complete-presentation`);
  await page.request.post(`/api/v1/kid/sessions/${initial.sessionId}/end`);

  const firstRevision = (await query<{ id: string }>(
    `select id from learning_app.item_revisions where deck_version_id =
       (select published_version_id from learning_app.decks where id = $1)
     order by position limit 1`,
    [deckId],
  ))[0]!;
  const skillRows = await query<{ skill: string; skill_version_id: string }>(
    `select skill, skill_version_id from learning_app.item_revision_skills
      where item_revision_id = $1 and skill in ('listening','spelling')`,
    [firstRevision.id],
  );
  for (const row of skillRows) {
    await query(
      `insert into learning_app.child_skill_progress
         (child_id, skill_version_id, policy_id, status, independent_success_streak, next_review_at, projection_version)
       select $1, $2, coalesce(c.policy_id, 'learning-v2'), 'practicing', $3, '2030-01-01T00:00:00Z', 'proj-3'
       from learning_app.child_profiles c where c.id = $1
       on conflict (child_id, skill_version_id, policy_id) do update set
         status = 'practicing', independent_success_streak = excluded.independent_success_streak,
         next_review_at = excluded.next_review_at`,
      [child.id, row.skill_version_id, row.skill === "listening" ? 1 : 0],
    );
  }
  expect(skillRows.map((row) => row.skill).sort()).toEqual(["listening", "spelling"]);

  const testDate = localTestDate();
  expect((await parent.put(`/api/v1/parent/assignments/${child.id}/${deckId}`, { data: { testDate } })).status()).toBe(204);
  await page.goto("/");
  await page.waitForSelector('[data-testid="kid-profile"], [data-testid="kid-deck"]', { timeout: 30_000 });
  if (await page.getByTestId("kid-profile").count()) {
    await page.getByTestId("kid-profile").filter({ hasText: child.displayName }).click();
  }
  await page.getByTestId("kid-mic-settings").click();
  await page.getByTestId("kid-mic-toggle").uncheck();
  await page.getByTestId("kid-mic-settings").click();
  await page.getByTestId("kid-deck").filter({ hasText: title }).click();

  await expect(page.getByTestId("kid-input")).toBeVisible();
  await expect(page.getByTestId("kid-input")).toHaveAttribute("placeholder", "Wpisz angielskie słowo");
  await expect(page.getByTestId("kid-source")).toHaveText("poniedziałek");
  await expect(page.getByTestId("kid-record")).toHaveCount(0);
  const currentTaskId = await page.locator("[data-task-id]").getAttribute("data-task-id");
  const taskContext = (await query<{ context: Record<string, unknown> }>(
    `select context from learning_app.session_tasks where id = $1`, [currentTaskId],
  ))[0]!;
  expect(taskContext.context).toMatchObject({ reason: "test-preparation" });
});
