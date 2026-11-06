import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readTestRunConfig } from "../test-run-config";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createDatabase } from "@learning/server";
import { E2E_SETUP_TOKEN } from "./helpers/parent-session";

// Krótkotrwałe testowe audio; nie zapisujemy trace, HAR ani video.
test.use({ trace: "off" });

/**
 * Issue #9: literówka w pisowni pokazuje diff z pigułkami dopiero po ocenie,
 * bez zwiększania liczby prób ani budżetu sesji.
 */

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
  const result = await (await pool()).query(sql, params);
  return result.rows as T[];
}

async function parentSession(page: Page): Promise<APIRequestContext> {
  const request = page.request;
  await request.post("/api/v1/parent/setup", { data: { secret: "1234", setupToken: E2E_SETUP_TOKEN } });
  const login = await request.post("/api/v1/parent/login", { data: { secret: "1234" } });
  expect(login.status()).toBe(200);
  return request;
}

async function createChild(
  parent: APIRequestContext,
  displayName: string,
  avatarKey: string,
): Promise<{ id: string }> {
  const child = await (
    await parent.post("/api/v1/parent/children", { data: { displayName, avatarKey } })
  ).json();
  expect(child.id).toBeDefined();
  return child;
}

async function createAssignedDeck(
  parent: APIRequestContext,
  childId: string,
  title: string,
  idempotencyKey: string,
): Promise<{ deckId: string; publishedVersionId: string }> {
  const generate = await parent.post("/api/v1/parent/decks/generate", {
    data: { prompt: "angielskie dni tygodnia dla początkującego dziecka", idempotencyKey, title },
  });
  expect(generate.status()).toBe(202);
  const { deckId } = await generate.json();

  let draftId: string | null = null;
  for (let attempt = 0; attempt < 960 && draftId === null; attempt++) {
    const deck = await (await parent.get(`/api/v1/parent/decks/${deckId}`)).json();
    if (deck.generation?.state === "succeeded" && deck.draft) {
      draftId = deck.draft.id;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  expect(draftId).not.toBeNull();

  let published = false;
  let editNumber = 0;
  for (let attempt = 0; attempt < 720 && !published; attempt++) {
    const draft = await (await parent.get(`/api/v1/parent/drafts/${draftId}`)).json();
    editNumber = draft.editNumber;
    const audioPending = draft.assets.some(
      (asset: { role: string; state: string }) => asset.role === "target_audio" && asset.state !== "approved",
    );
    if (!audioPending) {
      const result = await parent.post(`/api/v1/parent/drafts/${draftId}/publish`, {
        data: { expectedEditNumber: editNumber },
      });
      published = result.status() === 200;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  expect(published).toBe(true);

  const assign = await parent.put(`/api/v1/parent/assignments/${childId}/${deckId}`, {
    data: { testDate: null },
  });
  expect(assign.status()).toBe(204);

  const deck = await (await parent.get(`/api/v1/parent/decks/${deckId}`)).json();
  return { deckId, publishedVersionId: deck.published.id };
}

/** Fixture: należne sprawdzenie danej umiejętności dla elementu o indeksie. */
async function seedDue(childId: string, versionId: string, itemIndex: number, skill: string): Promise<void> {
  const revision = (
    await query<{ id: string }>(
      `select id from learning_app.item_revisions
        where deck_version_id = $1 order by position offset $2 limit 1`,
      [versionId, itemIndex],
    )
  )[0]!;
  const skillVersions = await query<{ skill_version_id: string }>(
    `select skill_version_id from learning_app.item_revision_skills
      where item_revision_id = $1 and skill = $2`,
    [revision.id, skill],
  );
  for (const { skill_version_id } of skillVersions) {
    await query(
      `insert into learning_app.child_skill_progress
         (child_id, skill_version_id, policy_id, status, independent_success_streak, next_review_at, projection_version)
       select $1, $2, coalesce(c.policy_id, 'learning-v2'), 'needs_confirmation', 3, '2026-10-01T00:00:00Z', 'proj-3'
       from learning_app.child_profiles c where c.id = $1
       on conflict (child_id, skill_version_id, policy_id) do update
         set status = 'needs_confirmation', independent_success_streak = 3,
             next_review_at = '2026-10-01T00:00:00Z'`,
      [childId, skill_version_id],
    );
  }
}

/** Wejście w naukę: świat współdzieli bazę między testami, wybieramy własny profil. */
async function openLearn(page: Page, childName: string): Promise<void> {
  await page.goto("/");
  await page.waitForSelector('[data-testid="kid-profile"], [data-testid="kid-deck"]', { timeout: 30_000 });
  if ((await page.getByTestId("kid-profile").count()) > 0) {
    await page.getByTestId("kid-profile").filter({ hasText: childName }).first().click();
  }
}

async function currentTaskId(page: Page): Promise<string> {
  const id = await page.locator("[data-task-id]").getAttribute("data-task-id");
  expect(id).not.toBeNull();
  return id!;
}

interface TaskRow {
  answer_key: { target: string };
}

async function answerTarget(taskId: string): Promise<string> {
  return (await query<TaskRow>(`select answer_key from learning_app.session_tasks where id = $1`, [taskId]))
    [0]!.answer_key.target;
}

test("literówka w pisowni pokazuje diff z pigułkami dopiero po ocenie (issue #9)", async ({ page }) => {
  test.setTimeout(240_000);
  const parent = await parentSession(page);
  const child = await createChild(parent, "Ola Diff", "fox");
  const { deckId, publishedVersionId } = await createAssignedDeck(
    parent,
    child.id,
    "Dni tygodnia — diff pisowni",
    `spelling-diff-${randomUUID()}`,
  );
  void deckId;
  await seedDue(child.id, publishedVersionId, 0, "recall");
  await openLearn(page, "Ola Diff");
  await page.getByTestId("kid-deck").first().click();
  await page.waitForSelector('[data-testid="kid-input"]', { timeout: 30_000 });

  // przed odpowiedzią nie ma żadnej diagnozy liter
  await expect(page.getByTestId("kid-spelling-diff")).toHaveCount(0);

  const taskId = await currentTaskId(page);
  const target = await answerTarget(taskId);
  // zamiana litery przed końcówką „-day”: odległość 1 i błędna litera w zapisie
  // (usunięcie litery to już przypadek „brakujących liter” — widok jednoliniowy)
  const typo = target.slice(0, -3) + "x" + target.slice(-2);
  await page.getByTestId("kid-input").fill(typo);
  await page.getByTestId("kid-submit").click();

  await expect(page.getByTestId("kid-feedback")).toBeVisible();
  const diff = page.getByTestId("kid-spelling-diff");
  await expect(diff).toBeVisible();
  await expect(page.getByTestId("kid-spelling-given")).toContainText(typo);
  await expect(page.getByTestId("kid-spelling-expected")).toContainText(target);
  // drugi kanał informacji: pigułki istnieją niezależnie od koloru
  await expect(page.getByTestId("kid-spelling-pill").first()).toBeVisible();
  // pomoc po odpowiedzi nie zwiększa liczby prób: przycisk wraca do tego zadania
  await expect(page.getByTestId("kid-next")).toHaveText(/Spróbuj jeszcze raz/);
});

test("brakujące litery bez błędnych liter pokazują jedno słowo wzorca (prefiks i środek)", async ({ page }) => {
  test.setTimeout(240_000);
  const parent = await parentSession(page);
  const child = await createChild(parent, "Ola Środek", "fox");
  const { deckId, publishedVersionId } = await createAssignedDeck(
    parent,
    child.id,
    "Dni tygodnia — brakujące litery",
    `spelling-middle-${randomUUID()}`,
  );
  void deckId;
  await seedDue(child.id, publishedVersionId, 0, "recall");
  await openLearn(page, "Ola Środek");
  await page.getByTestId("kid-deck").first().click();
  await page.waitForSelector('[data-testid="kid-input"]', { timeout: 30_000 });

  const taskId = await currentTaskId(page);
  const target = await answerTarget(taskId);
  // wariant „Fri.” przy „friday” kolizjonuje z krótkim prefiksem — wydłużamy
  const prefix = target.startsWith("fri") ? target.slice(0, 5) : target.slice(0, 3);
  await page.getByTestId("kid-input").fill(prefix);
  await page.getByTestId("kid-submit").click();

  // jeden wiersz: bez „Twojego zapisu”, pełne słowo wzorca z pigułką braku
  await expect(page.getByTestId("kid-feedback")).toBeVisible();
  await expect(page.getByTestId("kid-feedback")).toContainText("Uzupełnij brakujące litery");
  await expect(page.getByTestId("kid-spelling-diff")).toBeVisible();
  await expect(page.getByTestId("kid-spelling-given")).toHaveCount(0);
  await expect(page.getByTestId("kid-spelling-expected")).toBeVisible();
  await expect(page.getByTestId("kid-spelling-pill").first()).toBeVisible();

  // druga próba tego zadania: wpisany środek słowa (brak obu końców)
  await page.getByTestId("kid-next").click();
  await page.waitForSelector('[data-testid="kid-input"]', { timeout: 30_000 });
  await page.getByTestId("kid-input").fill(target.slice(1, -1));
  await page.getByTestId("kid-submit").click();

  await expect(page.getByTestId("kid-feedback")).toContainText("Uzupełnij brakujące litery");
  await expect(page.getByTestId("kid-spelling-given")).toHaveCount(0);
  await expect(page.getByTestId("kid-spelling-expected")).toBeVisible();
  // pigułki na obu końcach słowa wzorca
  await expect(page.getByTestId("kid-spelling-pill")).toHaveCount(2);
});
