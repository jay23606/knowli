import { expect, test, type Page } from "@playwright/test";
import { openNewMaterial } from "./helpers/parent-new-material";
import { holdFakeGeneration, releaseFakeGeneration } from "./helpers/fake-hold";
import { randomUUID } from "node:crypto";
import { DeckDtoSchema } from "@learning/contracts";
import { fillParentAuth } from "./helpers/parent-session";

async function enterParent(page: Page): Promise<void> {
  await page.goto("/parent");
  await fillParentAuth(page);
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("tab-decks")).toBeVisible();
  await page.getByTestId("tab-decks").click();
}

// Bramka fake'ów nie może zostać zamknięta po porażce w środku testu.
test.afterEach(releaseFakeGeneration);

test("creates, reopens and reloads an empty manual deck", async ({ page }) => {
  await enterParent(page);
  const createdResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/api/v1/parent/decks"),
  );
  await openNewMaterial(page, "empty");
  await page.getByTestId("create-empty-submit").click();
  const createdDeck = await (await createdResponse).json() as { deckId: string };
  const createdRow = page.locator(`[data-deck-id="${createdDeck.deckId}"]`);

  await expect(page.getByTestId("editor-title")).toHaveValue("Nowy zestaw");
  await expect(page.getByTestId("empty-draft")).toHaveText("Dodaj pierwsze słówko");
  await expect(page.locator('[data-testid^="item-card-"]')).toHaveCount(0);
  await expect(page.getByTestId("publish-deck")).toBeDisabled();

  await page.getByTestId("editor-back").click();
  await expect(createdRow).toBeVisible();
  await page.reload();
  await page.getByTestId("tab-decks").click();
  await createdRow.click();
  await expect(page.getByTestId("editor-title")).toHaveValue("Nowy zestaw");
  await expect(page.getByTestId("empty-draft")).toBeVisible();
});

test("trims the custom title, ignores the prompt and never requests deck generation", async ({ page }) => {
  const title = `Ręczny zestaw ${randomUUID().slice(0, 8)}`;
  let generationRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/decks/generate")) generationRequests += 1;
  });
  await enterParent(page);
  await openNewMaterial(page, "empty");
  await page.getByTestId("deck-title").fill(`  ${title}  `);
  await page.getByTestId("create-empty-submit").click();

  await expect(page.getByTestId("editor-title")).toHaveValue(title);
  expect(generationRequests).toBe(0);
});

test("retries an uncertain create with the same ID", async ({ page }) => {
  const title = `Retry ręczny ${randomUUID().slice(0, 8)}`;
  const requests: unknown[] = [];
  let failResponse = true;
  await page.route("**/api/v1/parent/decks", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    requests.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (failResponse) {
      failResponse = false;
      await route.abort("failed");
      return;
    }
    await route.fulfill({ response });
  });
  await enterParent(page);
  await openNewMaterial(page, "empty");
  await page.getByTestId("deck-title").fill(title);
  await page.getByTestId("create-empty-submit").click();
  await expect(page.getByTestId("api-error")).toBeVisible();
  await page.getByTestId("create-empty-submit").click();

  await expect(page.getByTestId("editor-title")).toHaveValue(title);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
});

test("saves an empty draft title without sending an items array", async ({ page }) => {
  const title = `Zapisany tytuł ${randomUUID().slice(0, 8)}`;
  let patchBody: Record<string, unknown> | undefined;
  await page.route("**/api/v1/parent/drafts/*", async (route) => {
    if (route.request().method() === "PATCH") patchBody = route.request().postDataJSON();
    await route.continue();
  });
  await enterParent(page);
  const createdResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/api/v1/parent/decks"),
  );
  await openNewMaterial(page, "empty");
  await page.getByTestId("create-empty-submit").click();
  const createdDeck = await (await createdResponse).json() as { deckId: string };
  await page.getByTestId("editor-title").fill(title);
  await page.getByTestId("save-items").click();
  await expect(page.getByTestId("editor-title")).toHaveValue(title);
  expect(patchBody).toBeDefined();
  expect(patchBody).not.toHaveProperty("items");
  await expect(page.getByTestId("save-items")).toBeEnabled();
  await page.getByTestId("editor-back").click();
  await page.locator(`[data-deck-id="${createdDeck.deckId}"]`).click();
  await expect(page.getByTestId("editor-title")).toHaveValue(title);
});

test("keeps incomplete cards unsaved and blocks publishing until a completed card is saved", async ({ page }) => {
  let patchCount = 0;
  await page.route("**/api/v1/parent/drafts/*", async (route) => {
    if (route.request().method() === "PATCH") patchCount += 1;
    await route.continue();
  });
  await enterParent(page);
  await openNewMaterial(page, "empty");
  await page.getByTestId("create-empty-submit").click();
  await page.getByTestId("add-item").click();
  await expect(page.getByTestId("publish-deck")).toBeDisabled();
  await page.getByTestId("save-items").click();
  await expect(page.getByTestId("api-error")).toBeVisible();
  expect(patchCount).toBe(0);
  await page.getByTestId("item-source-0").fill("kot");
  await page.getByTestId("item-target-0").fill("cat");
  await expect(page.getByTestId("publish-deck")).toBeDisabled();
  await page.getByTestId("save-items").click();
  await expect(page.getByTestId("publish-deck")).toBeEnabled();
  expect(patchCount).toBe(1);
});

test("locks draft controls while a save is pending and unlocks publishing after success", async ({ page }) => {
  let releasePatch: (() => void) | undefined;
  let notifyPatch: (() => void) | undefined;
  const patchReceived = new Promise<void>((resolve) => { notifyPatch = resolve; });
  const patchRelease = new Promise<void>((resolve) => { releasePatch = resolve; });
  await page.route("**/api/v1/parent/drafts/*", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    notifyPatch?.();
    await patchRelease;
    await route.fulfill({ response });
  });
  await enterParent(page);
  await openNewMaterial(page, "empty");
  await page.getByTestId("create-empty-submit").click();
  await page.getByTestId("add-item").click();
  await page.getByTestId("item-source-0").fill("kot");
  await page.getByTestId("item-target-0").fill("cat");
  await page.getByTestId("save-items").click();
  await patchReceived;
  await expect(page.getByTestId("item-source-0")).toBeDisabled();
  await expect(page.getByTestId("add-item")).toBeDisabled();
  await expect(page.getByTestId("publish-deck")).toBeDisabled();
  releasePatch?.();
  await expect(page.getByTestId("item-source-0")).toBeEnabled();
  await expect(page.getByTestId("publish-deck")).toBeEnabled();
});

test("preserves edits made while an asset-polling read is in flight", async ({ page }) => {
  // unikalny cel: powtórzone słowo dostanie gotowy zasób o znanym fingerprintcie
  // i etykieta od razu pokaże "gotowe" zamiast okna "generowanie"
  const targetValue = `cat-${randomUUID()}`;
  let holdNextRead = false;
  let releaseRead: (() => void) | undefined;
  let notifyRead: (() => void) | undefined;
  let markReadFulfilled: (() => void) | undefined;
  const readReceived = new Promise<void>((resolve) => { notifyRead = resolve; });
  const readRelease = new Promise<void>((resolve) => { releaseRead = resolve; });
  const readFulfilled = new Promise<void>((resolve) => { markReadFulfilled = resolve; });
  let deckId: string | undefined;
  await page.route("**/api/v1/parent/decks/*", async (route) => {
    if (route.request().method() !== "GET" || !holdNextRead) {
      await route.continue();
      return;
    }
    holdNextRead = false;
    const response = await route.fetch();
    const body = await response.json() as {
      draft?: { assets: { itemRevisionId: string; role: string; state: string }[] };
    };
    const audio = body.draft?.assets?.find((asset) => asset.role === "target_audio");
    expect(audio).toBeDefined();
    // Kontrolowany stary odczyt sygnalizuje gotowy asset, aby dać UI widoczny
    // efekt zastosowania tej konkretnej odpowiedzi. Zapis i końcowy odczyt są realne.
    audio!.state = "approved";
    notifyRead?.();
    await readRelease;
    await route.fulfill({ response, body: JSON.stringify(body) });
    markReadFulfilled?.();
  });
  try {
  await enterParent(page);
  await openNewMaterial(page, "empty");
  const createdResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/api/v1/parent/decks"),
  );
  await page.getByTestId("create-empty-submit").click();
  const created = await createdResponse;
  deckId = ((await created.json()) as { deckId: string }).deckId;
  expect(deckId).toBeTruthy();
  await page.getByTestId("add-item").click();
  await page.getByTestId("item-source-0").fill("kot");
  await page.getByTestId("item-target-0").fill(targetValue);
  await page.getByTestId("item-visual-0").selectOption("none");
  // Odpytywanie mediów trwa tylko, gdy TTS czeka: bramka trzyma je do
  // przechwycenia odczytu (fake'i nie mają w E2E opóźnienia).
  await holdFakeGeneration();
  await page.getByTestId("save-items").click();
  await expect(page.getByTestId("item-audio-state-0")).toContainText("generowanie");
  holdNextRead = true;
  await readReceived;
  await page.getByTestId("item-source-0").fill("kotek");
  releaseRead?.();
  // Wait for this exact response to finish, then assert the rendered edit is
  // still present. A dirty editor intentionally drops the stale GET payload.
  await readFulfilled;
  await releaseFakeGeneration();
  await expect(page.getByTestId("item-source-0")).toHaveValue("kotek");
  const save = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/drafts/"));
  await page.getByTestId("save-items").click();
  expect((await save).status()).toBe(200);
  const persisted = DeckDtoSchema.parse(await (await page.request.get(`/api/v1/parent/decks/${deckId}`)).json());
  expect(persisted.draft?.items[0]?.source).toBe("kotek");
  } finally {
    releaseRead?.();
    await page.unroute("**/api/v1/parent/decks/*");
  }
});

test("keeps the editor open when the list refresh fails after successful creation", async ({ page }) => {
  const title = `Lista niedostępna ${randomUUID().slice(0, 8)}`;
  let failNextList = false;
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
  await openNewMaterial(page, "empty");
  await page.getByTestId("deck-title").fill(title);
  await page.getByTestId("create-empty-submit").click();

  await expect(page.getByTestId("editor-title")).toHaveValue(title);
  await expect(page.getByTestId("empty-draft")).toBeVisible();
});

test("disables both creation actions while the manual create request is pending", async ({ page }) => {
  const title = `W trakcie tworzenia ${randomUUID().slice(0, 8)}`;
  let releasePost: (() => void) | undefined;
  let notifyPost: (() => void) | undefined;
  const postReceived = new Promise<void>((resolve) => { notifyPost = resolve; });
  const postRelease = new Promise<void>((resolve) => { releasePost = resolve; });
  await page.route("**/api/v1/parent/decks", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    notifyPost?.();
    await postRelease;
    await route.fulfill({ response });
  });
  await enterParent(page);
  await openNewMaterial(page, "empty");
  await page.getByTestId("deck-title").fill(title);
  await page.getByTestId("create-empty-submit").click();
  await postReceived;

  await expect(page.getByTestId("create-empty-submit")).toBeDisabled();
  await expect(page.getByTestId("new-material-back")).toBeDisabled();
  releasePost?.();
  await expect(page.getByTestId("editor-title")).toHaveValue(title);
});

test("keeps manual creation and editing usable at phone, tablet and desktop widths", async ({ page }, testInfo) => {
  await enterParent(page);
  for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await expect(page.getByTestId("new-material-open")).toBeVisible();
    const listOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(listOverflow).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`list-${viewport.width}.png`), fullPage: true });
  }
  await openNewMaterial(page, "empty");
  await page.getByTestId("create-empty-submit").click();
  await expect(page.getByTestId("empty-draft")).toBeVisible();
  await page.getByTestId("add-item").click();
  await page.getByTestId("item-source-0").fill("kot");
  await page.getByTestId("item-target-0").fill("cat");
  for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await expect(page.getByTestId("save-items")).toBeVisible();
    const editorOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(editorOverflow).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`editor-${viewport.width}.png`), fullPage: true });
  }
});

test("grupuje listę zestawów po stanie i filtruje po rodzaju", async ({ page }) => {
  await enterParent(page);
  // dwa szkice przez API: najnowszy drugi
  const created: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const response = await page.request.post("/api/v1/parent/decks", { data: { deckId: randomUUID(), title: `Grupa ${randomUUID().slice(0, 8)}` } });
    expect(response.status()).toBe(201);
    created.push(((await response.json()) as { deckId: string }).deckId);
  }
  await page.reload();
  await page.getByTestId("tab-decks").click();

  // szkice w sekcji własnej grupy; numeracja deck-row-N biegnie przez grupy
  const draftSection = page.getByTestId("deck-group-draft");
  await expect(draftSection).toBeVisible();
  await expect(draftSection.locator(`[data-deck-id="${created[0]}"]`)).toBeVisible();
  await expect(draftSection.locator(`[data-deck-id="${created[1]}"]`)).toBeVisible();

  // filtr rodzaju zawęża listę; świat współdzielony może zawierać lekcje
  // innych speków — sprawdzamy, że nasze słówka znikają przy filtrze Lekcje
  const filter = page.getByTestId("deck-kind-filter");
  await filter.getByRole("button", { name: "Lekcje" }).click();
  await expect(page.locator(`[data-deck-id="${created[0]}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-deck-id="${created[1]}"]`)).toHaveCount(0);
  await filter.getByRole("button", { name: "Słówka" }).click();
  await expect(page.locator(`[data-deck-id="${created[0]}"]`)).toBeVisible();
  await expect(page.getByTestId("deck-group-draft")).toBeVisible();
});

test("allows correcting the title after a definitive validation error", async ({ page }) => {
  const title = `Poprawiony tytuł ${randomUUID().slice(0, 8)}`;
  await enterParent(page);
  await openNewMaterial(page, "empty");
  await page.getByTestId("deck-title").fill("x".repeat(201));
  await page.getByTestId("create-empty-submit").click();
  await expect(page.getByTestId("api-error")).toBeVisible();
  await page.getByTestId("deck-title").fill(title);
  await page.getByTestId("create-empty-submit").click();
  await expect(page.getByTestId("editor-title")).toHaveValue(title);
});

test("creates and publishes a manually entered word without generating content", async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 8);
  const childName = `Manualne dziecko ${suffix}`;
  const deckTitle = `Manualny ${suffix}`;
  let generationRequests = 0;
  page.on("request", (entry) => {
    if (entry.url().includes("/decks/generate")) generationRequests += 1;
  });
  await enterParent(page);
  await page.getByTestId("tab-children").click();
  await page.getByTestId("child-name").fill(childName);
  await page.getByTestId("child-year").fill("2018");
  await page.getByTestId("child-add").click();
  const childRow = page.locator('[data-testid^="child-row-"]').filter({ hasText: childName });
  await expect(childRow).toHaveCount(1);
  await childRow.getByTestId("child-edit").click();
  await childRow.getByTestId("child-edit-can-read").check();
  // trwający zapis profilu wstrzymuje przejście do innej sekcji (leave guard):
  // PATCH czeka, próba zmiany zakładki nic nie robi, formularz zostaje
  let releasePatch!: () => void;
  const patchGate = new Promise<void>((resolve) => { releasePatch = resolve; });
  await page.route("**/api/v1/parent/children/*", async (route) => {
    if (route.request().method() === "PATCH") await patchGate;
    await route.continue();
  });
  await childRow.getByTestId("child-edit-save").click();
  await expect(childRow.getByTestId("child-edit-save")).toBeDisabled();
  await page.getByTestId("tab-decks").click();
  await expect(page).toHaveURL(/\/parent\/children$/);
  await expect(childRow.getByTestId("child-edit-name")).toBeVisible();
  releasePatch();
  await expect(childRow.getByTestId("child-edit-name")).toHaveCount(0);
  await page.unroute("**/api/v1/parent/children/*");
  const childHref = await childRow.getByTestId("child-learn-link").getAttribute("href");
  const childId = childHref?.match(/\/kids\/([0-9a-f-]{36})\//)?.[1];
  expect(childId).toBeTruthy();
  await page.getByTestId("tab-decks").click();
  await openNewMaterial(page, "empty");
  await page.getByTestId("deck-title").fill(deckTitle);
  const createdResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/api/v1/parent/decks"),
  );
  await page.getByTestId("create-empty-submit").click();
  const createdDeck = await (await createdResponse).json() as { deckId: string };
  await page.getByTestId("add-item").click();
  await page.getByTestId("item-source-0").fill("kot");
  await page.getByTestId("item-target-0").fill("cat");
  await page.getByTestId("item-visual-0").selectOption("none");
  await page.getByTestId("save-items").click();
  await expect(page.getByTestId("item-audio-state-0")).toContainText("gotowe", { timeout: 60_000 });
  const beforePublish = await request.get(`/api/v1/kid/decks?childId=${childId}`);
  expect((await beforePublish.json()).some((entry: { deckId: string }) => entry.deckId === createdDeck.deckId)).toBe(false);
  await page.getByTestId("editor-back").click();
  await page.locator('[data-testid^="deck-row-"]').filter({ hasText: deckTitle }).click();
  await expect(page.getByTestId("item-source-0")).toHaveValue("kot");
  await expect(page.getByTestId("item-target-0")).toHaveValue("cat");
  await page.getByTestId("publish-deck").click();
  await expect(page.getByTestId("publish-status")).toBeVisible();
  await page.locator(`[data-testid^="assign-row-"]`).filter({ hasText: childName }).locator('[data-testid^="assign-submit-"]').click();
  await expect(page.locator('[data-testid^="assignment-row-"]').filter({ hasText: childName })).toBeVisible();
  const nonReaderWarnings = page.locator('[data-testid^="non-reader-assignment-warning-"]');
  await expect(nonReaderWarnings.first()).toContainText("nie czyta");
  expect(generationRequests, `Unexpected generation request count: ${generationRequests}`).toBe(0);
  const kidDecks = await request.get(`/api/v1/kid/decks?childId=${childId}`);
  expect(kidDecks.ok()).toBeTruthy();
  const payload = await kidDecks.json();
  expect(
    payload.some((entry: { deckId: string }) => entry.deckId === createdDeck.deckId),
    `A standard deck must stay hidden from a child configured as not yet able to read: ${JSON.stringify(payload)}`,
  ).toBe(false);
});
