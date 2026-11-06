import { randomUUID } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import { openNewMaterial } from "./helpers/parent-new-material";
import { holdFakeGeneration, releaseFakeGeneration } from "./helpers/fake-hold";
import { E2E_SETUP_TOKEN } from "./helpers/parent-session";

async function enterParent(page: Page): Promise<void> {
  const request = page.request;
  await request.post("/api/v1/parent/setup", { data: { secret: "1234", setupToken: E2E_SETUP_TOKEN } });
  const login = await request.post("/api/v1/parent/login", { data: { secret: "1234" } });
  expect(login.status()).toBe(200);
  await page.goto("/parent");
  await expect(page.getByTestId("tab-decks")).toBeVisible();
  await page.getByTestId("tab-decks").click();
}

// Bramka fake'ów nie może zostać zamknięta po porażce w środku testu.
test.afterEach(releaseFakeGeneration);

test("polling conflict sends the form's base edit number and keeps local correction", async ({ page }, testInfo) => {
  const targetValue = `cat-${randomUUID()}`;
  const pageB = await page.context().newPage();
  let holdNextGet = false;
  let blockConflictReads = false;
  let releaseHeldGet: (() => void) | undefined;
  let notifyHeldGet: (() => void) | undefined;
  const heldGet = new Promise<void>((resolve) => { notifyHeldGet = resolve; });
  const releaseGet = new Promise<void>((resolve) => { releaseHeldGet = resolve; });
  await page.route("**/api/v1/parent/decks/*", async (route: Route) => {
    if (route.request().method() === "GET" && blockConflictReads) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "internal", message: "temporary conflict read failure" }) });
      return;
    }
    if (route.request().method() === "GET" && holdNextGet) {
      holdNextGet = false;
      notifyHeldGet?.();
      await releaseGet;
    }
    await route.continue();
  });

  await enterParent(page);
  const createdResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/api/v1/parent/decks"),
  );
  await openNewMaterial(page, "empty");
  await page.getByTestId("create-empty-submit").click();
  const createdDeck = await (await createdResponse).json() as { deckId: string };
  await page.getByTestId("add-item").click();
  await page.getByTestId("item-source-0").fill("kot");
  await page.getByTestId("item-target-0").fill(targetValue);
  await page.getByTestId("item-visual-0").selectOption("none");
  const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/api/v1/parent/drafts/"));
  // Odpytywanie zestawu trwa tylko, gdy media czekają: bramka trzyma TTS aż do
  // zamknięcia porównania (fake'i nie mają w E2E opóźnienia).
  await holdFakeGeneration();
  await page.getByTestId("save-items").click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByTestId("item-audio-state-0")).toContainText("generowanie");
  const title = await page.getByTestId("editor-title").inputValue();
  const localValue = "local correction";
  await page.getByTestId("item-source-0").fill(localValue);

  await enterParent(pageB);
  await pageB.locator(`[data-deck-id="${createdDeck.deckId}"]`).click();
  await expect(pageB.getByTestId("item-source-0")).toHaveValue("kot");

  holdNextGet = true;
  const deckGet = heldGet;
  const remoteRead = page.waitForResponse(async (response) => {
    if (response.request().method() !== "GET" || !response.url().includes("/api/v1/parent/decks/")) return false;
    const body = await response.json().catch(() => null) as { draft?: { editNumber?: number } } | null;
    return body?.draft?.editNumber === 3;
  });
  await deckGet;

  await pageB.getByTestId("editor-title").fill("remote version");
  const remoteSave = pageB.waitForResponse(
    (response) => response.request().method() === "PATCH" && response.url().includes("/drafts/"),
  );
  await pageB.getByTestId("save-items").click();
  expect((await remoteSave).status()).toBe(200);
  releaseHeldGet?.();
  await remoteRead;
  blockConflictReads = true;

  let conflictStatus: number | undefined;
  const localSave = page.waitForResponse((response) => {
    if (response.request().method() !== "PATCH" || !response.url().includes("/drafts/")) return false;
    conflictStatus = response.status();
    return true;
  });
  await page.getByTestId("save-items").click();
  await localSave;
  expect(conflictStatus).toBe(409);
  await expect(page.getByTestId("deck-conflict-panel")).toBeVisible();
  await expect(page.getByTestId("conflict-load-error")).toBeVisible();
  await expect(page.getByTestId("item-source-0")).toHaveValue(localValue);
  blockConflictReads = false;
  await page.getByTestId("conflict-retry").click();
  await expect(page.getByTestId("conflict-remote-title")).toContainText("remote version");
  await expect(page.getByTestId("item-source-0")).toHaveValue(localValue);
  await expect(page.getByTestId("editor-title")).toHaveValue(title);
  for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`conflict-${width}.png`), fullPage: true });
  }
  expect(conflictStatus).toBe(409);
  await page.waitForTimeout(100);
  expect(conflictStatus).toBe(409);

  await page.getByTestId("conflict-load-remote").click();
  await expect(page.getByTestId("conflict-confirm")).toBeVisible();
  await page.getByTestId("conflict-cancel").click();
  await expect(page.getByTestId("item-source-0")).toHaveValue(localValue);
  await page.getByTestId("conflict-load-remote").click();
  await page.getByTestId("conflict-confirm").click();
  await expect(page.getByTestId("editor-title")).toHaveValue("remote version");
  await expect(page.getByTestId("item-target-0")).toHaveValue(targetValue);
  await expect(page.getByTestId("deck-conflict-panel")).toContainText(localValue);

  await pageB.getByTestId("editor-title").fill("remote version 2");
  const remoteSaveAgain = pageB.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/api/v1/parent/drafts/"));
  await pageB.getByTestId("save-items").click();
  expect((await remoteSaveAgain).status()).toBe(200);
  await page.getByTestId("item-target-0").fill(localValue);
  const secondConflict = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/api/v1/parent/drafts/"));
  await page.getByTestId("save-items").click();
  expect((await secondConflict).status()).toBe(409);
  await expect(page.getByTestId("conflict-remote-title")).toContainText("remote version 2");
  await expect(page.getByTestId("item-target-0")).toHaveValue(localValue);
  await page.getByTestId("conflict-load-remote").click();
  await page.getByTestId("conflict-confirm").click();
  await expect(page.getByTestId("editor-title")).toHaveValue("remote version 2");
  await expect(page.getByTestId("item-target-0")).toHaveValue(targetValue);
  await page.getByTestId("item-target-0").fill(localValue);
  const reappliedSave = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/api/v1/parent/drafts/"));
  await page.getByTestId("save-items").click();
  expect((await reappliedSave).status()).toBe(200);
  await page.getByTestId("conflict-finish").click();
  await expect(page.getByTestId("conflict-confirm")).toBeVisible();
  await page.getByTestId("conflict-confirm").click();
  await expect(page.getByTestId("deck-conflict-panel")).toHaveCount(0);
  // po zamknięciu porównania baza formularza wraca do odczytów serwera: media
  // dochodzą do „gotowe”, a odpytywanie ustaje (nie wisi na starej wersji z porównania)
  await releaseFakeGeneration();
  await expect(page.getByTestId("item-audio-state-0")).toContainText("gotowe", { timeout: 30_000 });
  let pollsAfterReady = 0;
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url().includes("/api/v1/parent/decks/")) pollsAfterReady += 1;
  });
  await page.waitForTimeout(2_500);
  expect(pollsAfterReady).toBe(0);
  await pageB.close();
});

test("successful save with a failed refresh stays clean and is not sent again", async ({ page }) => {
  let failNextDeckGet = false;
  await page.route("**/api/v1/parent/decks/*", async (route: Route) => {
    if (route.request().method() === "GET" && failNextDeckGet) {
      failNextDeckGet = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "internal", message: "refresh unavailable" }) });
      return;
    }
    await route.continue();
  });
  await enterParent(page);
  await openNewMaterial(page, "empty");
  await page.getByTestId("create-empty-submit").click();
  await page.getByTestId("editor-title").fill("Zapisany szkic");

  let patchCount = 0;
  page.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().includes("/api/v1/parent/drafts/")) patchCount += 1;
  });
  failNextDeckGet = true;
  const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/api/v1/parent/drafts/"));
  const refreshFailed = page.waitForResponse((response) => response.request().method() === "GET" && response.url().includes("/api/v1/parent/decks/") && response.status() === 503);
  await page.getByTestId("save-items").click();
  expect((await saved).status()).toBe(200);
  await refreshFailed;
  await expect(page.getByTestId("api-error")).toContainText("Zapisano, ale nie udało się odświeżyć szkicu.");
  await expect(page.getByTestId("editor-title")).toHaveValue("Zapisany szkic");

  await page.getByTestId("save-items").click();
  await page.waitForTimeout(100);
  expect(patchCount).toBe(1);
});

test("delayed save locks the entire editor until the PATCH completes", async ({ page }) => {
  let releasePatch: (() => void) | undefined;
  let notifyPatch: (() => void) | undefined;
  const patchStarted = new Promise<void>((resolve) => { notifyPatch = resolve; });
  const patchGate = new Promise<void>((resolve) => { releasePatch = resolve; });
  await page.route("**/api/v1/parent/drafts/*", async (route: Route) => {
    if (route.request().method() === "PATCH") {
      notifyPatch?.();
      await patchGate;
    }
    await route.continue();
  });
  await enterParent(page);
  await openNewMaterial(page, "empty");
  await page.getByTestId("create-empty-submit").click();
  await page.getByTestId("add-item").click();
  await page.getByTestId("item-source-0").fill("kot");
  await page.getByTestId("item-target-0").fill("cat");
  await page.getByTestId("item-visual-0").selectOption("none");
  await page.getByTestId("add-item").click();
  await page.getByTestId("item-source-1").fill("pies");
  await page.getByTestId("item-target-1").fill("dog");
  await page.getByTestId("item-visual-1").selectOption("none");
  const saveResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/api/v1/parent/drafts/"));
  await page.getByTestId("save-items").click();
  await patchStarted;

  await expect(page.getByTestId("editor-title")).toBeDisabled();
  await expect(page.getByTestId("item-source-0")).toBeDisabled();
  await expect(page.getByTestId("item-target-1")).toBeDisabled();
  await expect(page.getByTestId("item-visual-0")).toBeDisabled();
  await page.getByTestId("item-menu-1").click();
  await expect(page.getByTestId("item-remove-1")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("add-item")).toBeDisabled();
  await expect(page.getByTestId("save-items")).toBeDisabled();

  releasePatch?.();
  expect((await saveResponse).status()).toBe(200);
});

test("leaving a dirty editor asks first and Stay preserves the local text", async ({ page }) => {
  await enterParent(page);
  await openNewMaterial(page, "empty");
  await page.getByTestId("create-empty-submit").click();
  await page.getByTestId("add-item").click();
  await page.getByTestId("item-source-0").fill("kot");
  await page.getByTestId("item-target-0").fill("local correction");
  await page.getByTestId("item-visual-0").selectOption("none");
  let patchCount = 0;
  page.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().includes("/api/v1/parent/drafts/")) patchCount += 1;
  });

  await page.getByTestId("editor-back").click();
  await expect(page.getByTestId("leave-editor-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("leave-editor-dialog")).not.toBeVisible();
  await expect(page.getByTestId("editor-back")).toBeFocused();
  await expect(page.getByTestId("item-target-0")).toHaveValue("local correction");

  await page.getByTestId("editor-back").click();
  await expect(page.getByTestId("leave-editor-dialog")).toBeVisible();
  await page.getByTestId("leave-editor-stay").click();
  await expect(page.getByTestId("leave-editor-dialog")).not.toBeVisible();
  await expect(page.getByTestId("item-target-0")).toHaveValue("local correction");
  expect(patchCount).toBe(0);

  await page.getByTestId("editor-back").click();
  await expect(page.getByTestId("leave-editor-dialog")).toBeVisible();
  await page.getByTestId("leave-editor-leave").click();
  await expect(page.getByTestId("editor-back")).toHaveCount(0);
  expect(patchCount).toBe(0);
});

test("tab and logout are guarded; busy save drops the leave request", async ({ page }) => {
  let releasePatch: (() => void) | undefined;
  let notifyPatch: (() => void) | undefined;
  const patchStarted = new Promise<void>((resolve) => { notifyPatch = resolve; });
  const patchGate = new Promise<void>((resolve) => { releasePatch = resolve; });
  await page.route("**/api/v1/parent/drafts/*", async (route: Route) => {
    if (route.request().method() === "PATCH") {
      notifyPatch?.();
      await patchGate;
    }
    await route.continue();
  });
  await enterParent(page);
  await openNewMaterial(page, "empty");
  await page.getByTestId("create-empty-submit").click();
  await page.getByTestId("add-item").click();
  await page.getByTestId("item-source-0").fill("kot");
  await page.getByTestId("item-target-0").fill("cat");
  await page.getByTestId("item-visual-0").selectOption("none");
  await page.getByTestId("tab-progress").click();
  await expect(page.getByTestId("leave-editor-dialog")).toBeVisible();
  await page.getByTestId("leave-editor-stay").click();
  await expect(page.getByTestId("item-source-0")).toHaveValue("kot");
  await page.getByTestId("parent-logout").click();
  await expect(page.getByTestId("leave-editor-dialog")).toBeVisible();
  await page.getByTestId("leave-editor-stay").click();

  const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/api/v1/parent/drafts/"));
  await page.getByTestId("save-items").click();
  await patchStarted;
  await page.getByTestId("parent-logout").click();
  await expect(page.getByTestId("leave-editor-dialog")).not.toBeVisible();
  await expect(page.getByTestId("editor-title")).toBeVisible();
  releasePatch?.();
  expect((await saved).status()).toBe(200);
  // busy schodzi dopiero po odświeżeniu po zapisie; logout w tym oknie jest
  // porzucany bez dialogu, więc czekamy na odblokowanie kontrolek edytora
  await expect(page.getByTestId("add-item")).toBeEnabled();
  await page.getByTestId("parent-logout").click();
  await expect(page.getByTestId("auth-secret")).toBeVisible();
});

test("beforeunload warns only while the editor has unsaved changes", async ({ page }) => {
  await enterParent(page);
  await openNewMaterial(page, "empty");
  await page.getByTestId("create-empty-submit").click();
  await page.getByTestId("editor-title").fill("Niezapisane");
  const dirtyBeforeUnload = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(dirtyBeforeUnload).toBe(true);
  await expect(page.getByTestId("editor-title")).toHaveValue("Niezapisane");

  const savedResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/api/v1/parent/drafts/"));
  await page.getByTestId("save-items").click();
  expect((await savedResponse).status()).toBe(200);
  await expect(page.getByTestId("api-error")).toHaveCount(0);
  const cleanBeforeUnload = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(cleanBeforeUnload).toBe(false);
  await page.reload();
  await expect(page.getByTestId("tab-decks")).toBeVisible();
});

test("a published remote draft requires creating a new version before local edits can be saved", async ({ page }) => {
  const title = `Konflikt publikacji ${Date.now()}`;
  const pageB = await page.context().newPage();
  await enterParent(page);
  await openNewMaterial(page, "empty");
  await page.getByTestId("deck-title").fill(title);
  await page.getByTestId("create-empty-submit").click();
  await page.getByTestId("add-item").click();
  await page.getByTestId("item-source-0").fill("kot");
  await page.getByTestId("item-target-0").fill("cat");
  await page.getByTestId("item-visual-0").selectOption("none");
  const initialSave = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/api/v1/parent/drafts/"));
  await page.getByTestId("save-items").click();
  const initialResponse = await initialSave;
  expect(initialResponse.status()).toBe(200);
  const oldDraftId = initialResponse.url().split("/").at(-1);
  await page.getByTestId("item-source-0").fill("kociak");

  await enterParent(pageB);
  await pageB.locator('[data-testid^="deck-row-"]').filter({ hasText: title }).click();
  await expect(pageB.getByTestId("item-source-0")).toHaveValue("kot");
  await expect(pageB.getByTestId("item-audio-state-0")).toContainText("gotowe", { timeout: 60_000 });
  await pageB.getByTestId("publish-deck").click();
  await expect(pageB.getByTestId("publish-status")).toBeVisible();

  const conflictSave = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/api/v1/parent/drafts/"));
  await page.getByTestId("save-items").click();
  const conflictResponse = await conflictSave;
  expect(conflictResponse.status()).toBe(409);
  await expect(page.getByTestId("deck-conflict-panel")).toBeVisible();
  await expect(page.getByTestId("conflict-remote-title")).toContainText(title);
  await expect(page.getByTestId("conflict-load-remote")).toContainText("Utwórz nowy szkic");
  await page.getByTestId("conflict-load-remote").click();
  const createVersion = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/draft"));
  await page.getByTestId("conflict-confirm").click();
  expect((await createVersion).status()).toBe(201);
  await expect(page.getByTestId("item-source-0")).toHaveValue("kot");
  await expect(page.getByTestId("deck-conflict-panel")).toContainText("kociak");
  await page.getByTestId("item-source-0").fill("kociak");
  const newVersionSave = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/api/v1/parent/drafts/"));
  await page.getByTestId("save-items").click();
  const savedNewVersion = await newVersionSave;
  expect(savedNewVersion.status()).toBe(200);
  expect(savedNewVersion.url().split("/").at(-1)).not.toBe(oldDraftId);
  await page.getByTestId("conflict-finish").click();
  await page.getByTestId("conflict-confirm").click();
  await pageB.close();
});

test("browser Back with a dirty editor asks first; Stay keeps the address and the form", async ({ page }) => {
  await enterParent(page);
  await page.getByTestId("tab-children").click();
  await expect(page).toHaveURL(/\/parent\/children$/);
  await page.getByTestId("tab-decks").click();
  await expect(page).toHaveURL(/\/parent\/decks$/);
  await openNewMaterial(page, "empty");
  await page.getByTestId("create-empty-submit").click();
  await page.getByTestId("add-item").click();
  await page.getByTestId("item-source-0").fill("kot");
  await page.getByTestId("item-target-0").fill("local correction");

  // otwarty zestaw ma własny adres; „wstecz” prowadzi do listy zestawów
  const editorUrl = /\/parent\/decks\/[0-9a-f-]{36}$/;
  await expect(page).toHaveURL(editorUrl);
  await page.goBack();
  await expect(page.getByTestId("leave-editor-dialog")).toBeVisible();
  await expect(page).toHaveURL(editorUrl);
  await page.getByTestId("leave-editor-stay").click();
  await expect(page.getByTestId("leave-editor-dialog")).not.toBeVisible();
  await expect(page.getByTestId("item-target-0")).toHaveValue("local correction");
  await expect(page.getByTestId("tab-decks")).toHaveAttribute("aria-current", "true");

  await page.goBack();
  await expect(page.getByTestId("leave-editor-dialog")).toBeVisible();
  await page.getByTestId("leave-editor-leave").click();
  await expect(page).toHaveURL(/\/parent\/decks$/);
  await expect(page.getByTestId("new-material-open")).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/parent\/children$/);
  await expect(page.getByTestId("tab-children")).toHaveAttribute("aria-current", "true");
});

test("expired session on save keeps the dirty form and offers re-login above the editor", async ({ page }) => {
  await enterParent(page);
  await openNewMaterial(page, "empty");
  await page.getByTestId("create-empty-submit").click();
  await page.getByTestId("add-item").click();
  await page.getByTestId("item-source-0").fill("kot");
  await page.getByTestId("item-target-0").fill("local correction");
  await page.getByTestId("item-visual-0").selectOption("none");

  let expireNextSave = true;
  await page.route("**/api/v1/parent/drafts/*", async (route: Route) => {
    if (route.request().method() === "PATCH" && expireNextSave) {
      expireNextSave = false;
      await route.fulfill({ status: 401, json: { code: "unauthorized", message: "x", retryable: false, requestId: "r" } });
      return;
    }
    await route.fallback();
  });
  await page.getByTestId("save-items").click();

  await expect(page.getByTestId("reauth-dialog")).toBeVisible();
  await expect(page.getByTestId("auth-secret")).toHaveCount(0);
  await page.getByTestId("reauth-secret").fill("1234");
  await page.getByTestId("reauth-submit").click();
  await expect(page.getByTestId("reauth-dialog")).toHaveCount(0);
  await expect(page.getByTestId("item-target-0")).toHaveValue("local correction");

  const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/api/v1/parent/drafts/"));
  await page.getByTestId("save-items").click();
  expect((await saved).status()).toBe(200);
});
