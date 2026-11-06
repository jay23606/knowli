import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createDatabase } from "@learning/server";
import { expect, test, type Page } from "@playwright/test";
import { messages } from "@learning/contracts";
import { readTestRunConfig } from "../test-run-config";
import { openNewMaterial } from "./helpers/parent-new-material";
import { fillParentAuth } from "./helpers/parent-session";

type WorldPool = ReturnType<typeof createDatabase>["pool"];
let worldPool: WorldPool | null = null;

async function pool(): Promise<WorldPool> {
  if (!worldPool) {
    const world = JSON.parse(
      await readFile(join(process.cwd(), readTestRunConfig(process.env).worldFile), "utf8"),
    ) as { databaseUrl: string };
    worldPool = createDatabase(world.databaseUrl).pool;
  }
  return worldPool;
}

/**
 * Edytor zaakceptowanego generowania: baner „Generuję zestaw…” (queued/running) albo gotowe
 * słówka — fake'i nie mają w E2E opóźnienia, więc zwykle już gotowe. Ten spec sprawdza ponowienie
 * żądania, nie stan przejściowy; baner świadomie bez bramki fake'ów (helpers/fake-hold.ts).
 */
async function expectGenerationEditor(page: Page): Promise<void> {
  await expect(page.getByTestId("generation-banner").or(page.getByTestId("item-card-0")).first()).toBeVisible();
}

async function enterParent(page: Page): Promise<void> {
  await page.goto("/parent");
  await fillParentAuth(page);
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("tab-decks")).toBeVisible();
  await page.getByTestId("tab-decks").click();
}

async function expectSingleGeneration(command: Record<string, unknown>, acceptance: { generationRunId: string; deckId: string }) {
  const sql = await (await pool()).query<{
    run_count: string;
    deck_count: string;
    run_id: string | null;
    deck_id: string | null;
  }>(
    `select count(*)::text as run_count,
            count(distinct d.id)::text as deck_count,
            min(gr.id::text) as run_id,
            min(d.id::text) as deck_id
       from learning_app.generation_runs gr
       join learning_app.deck_versions dv on dv.id = gr.deck_version_id
       join learning_app.decks d on d.id = dv.deck_id
      where gr.kind = 'deck' and gr.dedupe_key = $1`,
    [`deck:${command.idempotencyKey as string}`],
  );
  expect(sql.rows[0]?.run_count).toBe("1");
  expect(sql.rows[0]?.deck_count).toBe("1");
  expect(sql.rows[0]?.run_id).toBe(acceptance.generationRunId);
  expect(sql.rows[0]?.deck_id).toBe(acceptance.deckId);
}

test.afterAll(async () => {
  await worldPool?.end();
});

test("lost 202 response retries the same command and opens its single deck", async ({ page }, testInfo) => {
  const title = `Ponowienie ${randomUUID().slice(0, 8)}`;
  const prompt = "angielskie kolory i liczby dla początkującego dziecka";
  const bodies: Record<string, unknown>[] = [];
  let loseFirstResponse = true;
  let acceptance: { generationRunId: string; deckId: string } | null = null;
  await page.route("**/api/v1/parent/decks/generate", async (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    const response = await route.fetch();
    if (loseFirstResponse) {
      loseFirstResponse = false;
      await route.abort("failed");
      return;
    }
    acceptance = await response.json() as { generationRunId: string; deckId: string };
    await route.fulfill({ response });
  });

  await enterParent(page);
  await openNewMaterial(page, "generate");
  await page.getByTestId("deck-prompt").fill(prompt);
  await page.getByTestId("deck-title").fill(title);
  await page.getByTestId("deck-vocabulary-format").selectOption("picture");
  await page.getByTestId("generate-submit").click();
  await expect(page.getByTestId("api-error")).toHaveText(messages.decks.generationUncertain);
  await expect(page.getByTestId("deck-title")).toBeDisabled();
  await expect(page.getByTestId("deck-prompt")).toBeDisabled();
  await expect(page.getByTestId("new-material-back")).toBeDisabled();
  await expect(page.getByTestId("generate-submit")).toHaveText(messages.decks.retryGenerationRequest);
  // zamknięcie modala w stanie niepewnym nie gubi polecenia — ponowne otwarcie odtwarza krok generowania
  await page.getByTestId("new-material-close").click();
  await page.getByTestId("new-material-open").click();
  await expect(page.getByTestId("generate-submit")).toHaveText(messages.decks.retryGenerationRequest);
  await expect(page.getByTestId("deck-title")).toBeDisabled();
  for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", await page.evaluate(() => window.innerWidth));
    await page.screenshot({ path: testInfo.outputPath(`uncertain-${viewport.width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByTestId("generate-submit").click();
  await expectGenerationEditor(page);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0]).toMatchObject({ vocabularyFormat: "picture" });

  const command = bodies[0]!;
  const idempotencyKey = command.idempotencyKey as string;
  expect(idempotencyKey).toBeTruthy();
  await expectSingleGeneration(command, acceptance!);
  await expect(page.getByTestId("editor-title")).toHaveValue(title);
  await expect(page.getByTestId("vocabulary-format")).toContainText(messages.decks.pictureVocabulary);
  await expect(page.getByTestId("item-visual-0").locator("option")).toHaveCount(3);
  await expect(page.getByTestId("item-visual-0").locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)))
    .resolves.toEqual(["image", "color", "number"]);
});

type Acceptance = { generationRunId: string; deckId: string };

/**
 * Pierwsza odpowiedź 202 ma zepsutą treść (`malformedBody`): panel zostaje w stanie niepewnym bez
 * otwierania edytora, a ponowienie wysyła to samo polecenie i otwiera jedyny utworzony zestaw.
 */
async function expectMalformedAcceptanceRetried(page: Page, prompt: string, malformedBody: (accepted: Acceptance) => string) {
  const bodies: Record<string, unknown>[] = [];
  let malformed = true;
  let acceptance: Acceptance | null = null;
  await page.route("**/api/v1/parent/decks/generate", async (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    const response = await route.fetch();
    if (malformed) {
      malformed = false;
      await route.fulfill({ status: 202, contentType: "application/json", body: malformedBody(await response.json() as Acceptance) });
      return;
    }
    acceptance = await response.json() as Acceptance;
    await route.fulfill({ response });
  });

  await enterParent(page);
  await openNewMaterial(page, "generate");
  await page.getByTestId("deck-prompt").fill(prompt);
  await page.getByTestId("generate-submit").click();
  await expect(page.getByTestId("api-error")).toHaveText(messages.decks.generationUncertain);
  await expect(page.getByTestId("editor-title")).toHaveCount(0);
  await page.getByTestId("generate-submit").click();
  await expectGenerationEditor(page);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  await expectSingleGeneration(bodies[0]!, acceptance!);
}

test("malformed 202 response stays uncertain and retries the original command", async ({ page }) => {
  await expectMalformedAcceptanceRetried(page, "angielskie kolory dla dziecka", () => "{");
});

test("a 202 with a malformed deck ID is not opened before retry", async ({ page }) => {
  await expectMalformedAcceptanceRetried(page, "angielskie zwierzęta dla dziecka", (accepted) => JSON.stringify({ ...accepted, deckId: "bad-id" }));
});

test("a 500 after acceptance can be retried with one logical generation", async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  let failOnce = true;
  let acceptance: { generationRunId: string; deckId: string } | null = null;
  await page.route("**/api/v1/parent/decks/generate", async (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    const response = await route.fetch();
    if (failOnce) {
      failOnce = false;
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "internal", message: "server error" }) });
      return;
    }
    acceptance = await response.json() as { generationRunId: string; deckId: string };
    await route.fulfill({ response });
  });

  await enterParent(page);
  await openNewMaterial(page, "generate");
  await page.getByTestId("deck-prompt").fill("angielskie jedzenie dla dziecka");
  await page.getByTestId("generate-submit").click();
  await expect(page.getByTestId("api-error")).toHaveText(messages.decks.generationUncertain);
  await page.getByTestId("generate-submit").click();
  await expectGenerationEditor(page);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  await expectSingleGeneration(bodies[0]!, acceptance!);
});

test("two synchronous clicks issue only one generation request", async ({ page }) => {
  let requestCount = 0;
  await page.route("**/api/v1/parent/decks/generate", async (route) => {
    requestCount += 1;
    await route.continue();
  });
  await enterParent(page);
  await openNewMaterial(page, "generate");
  await page.getByTestId("deck-prompt").fill("angielskie kolory dla dziecka");
  await page.getByTestId("generate-submit").evaluate((element) => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expectGenerationEditor(page);
  expect(requestCount).toBe(1);
});

test("validation unlocks correction while authorization failure sends the parent to login", async ({ page }) => {
  let requestCount = 0;
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/v1/parent/decks/generate", async (route) => {
    requestCount += 1;
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    if (requestCount === 1) {
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ code: "validation", message: "invalid" }) });
      return;
    }
    await route.continue();
  });
  await enterParent(page);
  await openNewMaterial(page, "generate");
  await page.getByTestId("deck-prompt").fill("angielskie kolory dla dziecka");
  await page.getByTestId("generate-submit").click();
  await expect(page.getByTestId("api-error")).toHaveText("invalid");
  await expect(page.getByTestId("deck-prompt")).toBeEnabled();
  await page.getByTestId("deck-prompt").fill("angielskie owoce dla dziecka");
  await page.getByTestId("generate-submit").click();
  await expectGenerationEditor(page);
  expect(bodies[0]?.idempotencyKey).not.toBe(bodies[1]?.idempotencyKey);
  expect(bodies[1]?.prompt).toBe("angielskie owoce dla dziecka");
});

test("401 clears the pending command and returns the parent to login", async ({ page }) => {
  await page.route("**/api/v1/parent/decks/generate", async (route) => {
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ code: "unauthorized", message: "login" }) });
  });
  await enterParent(page);
  await openNewMaterial(page, "generate");
  await page.getByTestId("deck-prompt").fill("angielskie kolory dla dziecka");
  await page.getByTestId("generate-submit").click();
  await expect(page.getByTestId("auth-secret")).toBeVisible();
});

test("403 is definitive and allows a corrected generation", async ({ page }) => {
  let requestCount = 0;
  await page.route("**/api/v1/parent/decks/generate", async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ code: "forbidden", message: "denied" }) });
      return;
    }
    await route.continue();
  });
  await enterParent(page);
  await openNewMaterial(page, "generate");
  await page.getByTestId("deck-prompt").fill("angielskie kolory dla dziecka");
  await page.getByTestId("generate-submit").click();
  await expect(page.getByTestId("api-error")).toHaveText("denied");
  await expect(page.getByTestId("deck-prompt")).toBeEnabled();
  await expect(page.getByTestId("generate-submit")).toHaveText(messages.decks.generate);
});

test("a failed list refresh after acceptance keeps the created editor open", async ({ page }) => {
  let failNextList = false;
  let command: Record<string, unknown> | null = null;
  let acceptance: { generationRunId: string; deckId: string } | null = null;
  let postCount = 0;
  await page.route("**/api/v1/parent/decks/generate", async (route) => {
    postCount += 1;
    command = route.request().postDataJSON() as Record<string, unknown>;
    const response = await route.fetch();
    acceptance = await response.json() as { generationRunId: string; deckId: string };
    await route.fulfill({ response });
  });
  await page.route("**/api/v1/parent/decks", async (route) => {
    if (route.request().method() === "POST") {
      const response = await route.fetch();
      failNextList = true;
      await route.fulfill({ response });
      return;
    }
    if (route.request().method() === "GET" && failNextList) {
      failNextList = false;
      await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
      return;
    }
    await route.continue();
  });
  await enterParent(page);
  await openNewMaterial(page, "generate");
  await page.getByTestId("deck-prompt").fill("angielskie kolory dla dziecka");
  await page.getByTestId("deck-title").fill("Lista może się odświeżyć później");
  await page.getByTestId("generate-submit").click();
  await expect(page.getByTestId("editor-title")).toHaveValue("Lista może się odświeżyć później");
  await expectGenerationEditor(page);
  expect(postCount).toBe(1);
  await expectSingleGeneration(command!, acceptance!);
});

test("a new conscious generation after success uses a new idempotency key", async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/v1/parent/decks/generate", async (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.continue();
  });
  await enterParent(page);
  await openNewMaterial(page, "generate");
  await page.getByTestId("deck-prompt").fill("angielskie kolory dla dziecka");
  await page.getByTestId("generate-submit").click();
  await expectGenerationEditor(page);
  await page.getByTestId("editor-back").click();
  await openNewMaterial(page, "generate");
  await page.getByTestId("deck-prompt").fill("angielskie owoce dla dziecka");
  await page.getByTestId("generate-submit").click();
  await expectGenerationEditor(page);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]?.idempotencyKey).not.toBe(bodies[0]?.idempotencyKey);
});

test("a late acceptance after leaving the decks tab does not open an editor", async ({ page }) => {
  let releaseResponse: (() => void) | undefined;
  let notifyResponse: (() => void) | undefined;
  const responseReceived = new Promise<void>((resolve) => { notifyResponse = resolve; });
  const responseRelease = new Promise<void>((resolve) => { releaseResponse = resolve; });
  await page.route("**/api/v1/parent/decks/generate", async (route) => {
    const response = await route.fetch();
    notifyResponse?.();
    await responseRelease;
    await route.fulfill({ response });
  });
  await enterParent(page);
  await openNewMaterial(page, "generate");
  await page.getByTestId("deck-prompt").fill("angielskie kolory dla dziecka");
  await page.getByTestId("generate-submit").click();
  await responseReceived;
  await page.getByTestId("new-material-close").click();
  await page.getByTestId("tab-children").click();
  releaseResponse?.();
  await expect(page.getByTestId("child-name")).toBeVisible();
  await expect(page.getByTestId("editor-title")).toHaveCount(0);
});
