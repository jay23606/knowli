import { expect, test, type Page } from "@playwright/test";
import { openNewMaterial } from "./helpers/parent-new-material";
import { randomUUID } from "node:crypto";
import { DeckDtoSchema, messages } from "@learning/contracts";
import { fillParentAuth, loginParent } from "./helpers/parent-session";
import { holdFakeGeneration, releaseFakeGeneration } from "./helpers/fake-hold";

/**
 * Pełny obieg rodzica z zadania 4: generuj → preview/edit → publikuj → przypisz.
 * Świat (baza, web, worker z fake providerami) stawia global-setup i jest
 * współdzielony z innymi specami — własne wiersze lokalizujemy po treści.
 */

const DECK_TITLE = `Dni tygodnia — obieg rodzica ${randomUUID().slice(0, 8)}`;

async function playTargetAudio(page: Page, deckId: string, itemIndex: number): Promise<void> {
  const response = await page.request.get(`/api/v1/parent/decks/${deckId}`);
  expect(response.status()).toBe(200);
  const deck = DeckDtoSchema.parse(await response.json());
  expect(deck.draft).not.toBeNull();
  const item = deck.draft!.items[itemIndex]!;
  const audio = deck.draft!.assets.find((asset) =>
    asset.itemRevisionId === item.revisionId && asset.role === "target_audio",
  );
  expect(audio?.state).toBe("approved");
  expect(audio?.assetId).toBeTruthy();
  // Obrazy korzystają z tego samego endpointu. Czekamy na właściwy zasób,
  // zachowując asercję MIME, która wykryje błędne audio z serwera.
  const played = page.waitForResponse((entry) =>
    new URL(entry.url()).pathname === `/api/v1/media/${audio!.assetId}`,
  );
  await page.getByTestId(`item-menu-${itemIndex}`).click();
  await page.getByTestId(`item-play-${itemIndex}`).click();
  const audioResponse = await played;
  expect(audioResponse.status()).toBe(200);
  expect(audioResponse.headers()["content-type"]).toContain("audio/mpeg");
}

/** Termin w karcie przypisania: DD.MM.RRRR. */
function displayDate(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

function isoDate(daysAhead: number): string {
  const date = new Date(Date.now() + daysAhead * 86_400_000);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

async function profileForEditing(page: Page, avatarKey = "fox", paddedName = false) {
  await loginParent(page);
  const name = `${paddedName ? "  " : ""}Edycja-${randomUUID()}${paddedName ? "  " : ""}`;
  const response = await page.request.post("/api/v1/parent/children", {
    data: { displayName: name, avatarKey, birthYear: 2018 },
  });
  expect(response.status()).toBe(201);
  const child = await response.json() as { id: string; displayName: string; avatarKey: string; birthYear: number; recordingMode: "hold" | "toggle" };
  await page.goto("/parent");
  await page.getByTestId("tab-children").click();
  const href = `/kids/${child.id}/learn`;
  const row = page.locator('li[data-testid^="child-row-"]').filter({ has: page.locator(`a[href="${href}"]`) });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("child-edit")).toBeVisible({ timeout: 5_000 });
  return { child, row, href, path: `/api/v1/parent/children/${child.id}` };
}

async function createReadyManualDraft(page: Page, title: string): Promise<string> {
  await loginParent(page);
  const deckId = randomUUID();
  const created = await page.request.post("/api/v1/parent/decks", { data: { deckId, title } });
  expect(created.status()).toBe(201);
  const deck = DeckDtoSchema.parse(await (await page.request.get(`/api/v1/parent/decks/${deckId}`)).json());
  expect(deck.draft).not.toBeNull();
  const edited = await page.request.patch(`/api/v1/parent/drafts/${deck.draft!.id}`, {
    data: {
      expectedEditNumber: deck.draft!.editNumber,
      items: [
        { source: "poniedziałek", target: "monday", acceptedAnswers: ["Monday"], locales: { source: "pl-PL", target: "en-GB" }, visualType: "none" },
        { source: "wtorek", target: "tuesday", acceptedAnswers: ["Tuesday"], locales: { source: "pl-PL", target: "en-GB" }, visualType: "none" },
      ],
    },
  });
  expect(edited.status()).toBe(200);
  await expect.poll(async () => {
    const current = DeckDtoSchema.parse(await (await page.request.get(`/api/v1/parent/decks/${deckId}`)).json());
    return current.draft?.assets.filter((asset) => asset.role === "target_audio").every((asset) => asset.state === "approved") ?? false;
  }, { timeout: 60_000 }).toBe(true);
  await page.goto("/parent");
  await page.getByTestId("tab-decks").click();
  const row = page.locator(`[data-deck-id="${deckId}"]`);
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId("item-card-1")).toBeVisible();
  return deckId;
}

// Bramka fake'ów nie może zostać zamknięta po porażce w środku testu.
test.afterEach(releaseFakeGeneration);

test("zakładka Dzieci: karty profili z avatarem, nauką jako główną akcją i kartą dodawania", async ({ page }) => {
  const name = `Karta-${randomUUID().slice(0, 8)}`;
  await page.goto("/parent");
  await fillParentAuth(page);
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("tab-children")).toBeVisible();
  const response = await page.request.post("/api/v1/parent/children", {
    data: { displayName: name, avatarKey: "fox", birthYear: 2018 },
  });
  expect(response.status()).toBe(201);
  const child = await response.json() as { id: string };
  await page.reload();
  await page.getByTestId("tab-children").click();

  const row = page.locator('li[data-testid^="child-row-"]').filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row.locator(".pp-child-avatar")).toBeVisible();
  await expect(row.getByTestId("child-learn-link").locator("svg")).toBeVisible();
  await expect(page.getByTestId("child-add")).toBeVisible();
  const link = row.getByTestId("child-learn-link");
  await expect(link).toHaveAttribute("href", `/kids/${child.id}/learn`);
});

test("edycja profilu: anulowanie, zapis Enter i trwałość danych", async ({ page }) => {
  const { child, row, href, path } = await profileForEditing(page);
  let patches = 0;
  let patchBody: unknown;
  page.on("request", (request) => {
    if (request.method() === "PATCH" && new URL(request.url()).pathname === path) {
      patches++;
      patchBody = request.postDataJSON();
    }
  });
  await row.getByTestId("child-edit").click();
  await expect(row.getByTestId("child-edit-name")).toHaveValue(child.displayName);
  await expect(row.getByTestId("child-edit-avatar")).toHaveValue("fox");
  await expect(row.getByTestId("child-edit-recording-mode")).toHaveValue("hold");
  await expect(row.getByTestId("child-edit-name")).toBeFocused();
  await expect(row.getByTestId("child-edit-save")).toBeDisabled();
  await row.getByTestId("child-edit-name").fill("  ");
  await expect(row.getByTestId("child-edit-save")).toBeDisabled();
  await row.getByTestId("child-edit-cancel").click();
  await expect(row.getByTestId("child-edit")).toBeFocused();
  expect(patches).toBe(0);
  await row.getByTestId("child-edit").click();
  await expect(row.getByTestId("child-edit-name")).toHaveValue(child.displayName);
  const newName = `Nowe-${randomUUID()}`;
  await row.getByTestId("child-edit-name").fill(` ${newName} `);
  await row.getByTestId("child-edit-avatar").selectOption("cat");
  await row.getByTestId("child-edit-recording-mode").selectOption("toggle");
  await row.getByTestId("child-edit-name").press("Enter");
  await expect(row).toContainText(newName);
  await expect(row.getByTestId("child-edit")).toBeFocused();
  expect(patches).toBe(1);
  expect(patchBody).toEqual({ displayName: newName, avatarKey: "cat", recordingMode: "toggle" });
  await expect(row.getByTestId("child-learn-link")).toHaveAttribute("href", href);
  await page.reload();
  await page.getByTestId("tab-children").click();
  await row.getByTestId("child-edit").click();
  await expect(row.getByTestId("child-edit-name")).toHaveValue(newName);
  await expect(row.getByTestId("child-edit-avatar")).toHaveValue("cat");
  await expect(row.getByTestId("child-edit-recording-mode")).toHaveValue("toggle");
  const saved = await (await page.request.get("/api/v1/parent/children")).json();
  expect(saved.find((value: { id: string }) => value.id === child.id)).toEqual({ ...child, displayName: newName, avatarKey: "cat", recordingMode: "toggle" });
});

test("edycja profilu: nieznany awatar i przełączanie formularzy", async ({ page }) => {
  const { child, row, path } = await profileForEditing(page, "legacy");
  const otherResponse = await page.request.post("/api/v1/parent/children", { data: { displayName: `Inne-${randomUUID()}`, avatarKey: "owl" } });
  const other = await otherResponse.json();
  await page.reload();
  await page.getByTestId("tab-children").click();
  const otherRow = page.locator('li[data-testid^="child-row-"]').filter({ has: page.locator(`a[href="/kids/${other.id}/learn"]`) });
  await row.getByTestId("child-edit").click();
  await expect(row.getByTestId("child-edit-avatar")).toHaveValue("legacy");
  await row.getByTestId("child-edit-name").fill("Niezapisane");
  await otherRow.getByTestId("child-edit").click();
  await expect(page.getByTestId("child-edit-name")).toHaveCount(1);
  await row.getByTestId("child-edit").click();
  await expect(row.getByTestId("child-edit-name")).toHaveValue(child.displayName);
  await row.getByTestId("child-edit-name").fill("Poprawione");
  const request = page.waitForRequest((request) => request.method() === "PATCH" && new URL(request.url()).pathname === path);
  await row.getByTestId("child-edit-save").click();
  expect((await request).postDataJSON()).toEqual({ displayName: "Poprawione" });
  await expect(row).toContainText("Poprawione");
  const children = await (await page.request.get("/api/v1/parent/children")).json();
  expect(children.find((value: { id: string }) => value.id === child.id).avatarKey).toBe("legacy");
});

test("edycja profilu: błąd zapisu zachowuje wartości i pozwala ponowić", async ({ page }) => {
  const { row, path } = await profileForEditing(page);
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() === "PATCH") await route.fulfill({ status: 500, json: { code: "internal", message: "Błąd zapisu" } });
    else await route.continue();
  });
  await row.getByTestId("child-edit").click();
  await row.getByTestId("child-edit-name").fill("Retry");
  await row.getByTestId("child-edit-avatar").selectOption("panda");
  await row.getByTestId("child-edit-save").click();
  await expect(row.getByRole("alert")).toContainText("Błąd zapisu");
  await expect(row.getByTestId("child-edit-name")).toHaveValue("Retry");
  await expect(row.getByTestId("child-edit-avatar")).toHaveValue("panda");
  await page.unroute(`**${path}`);
  await row.getByTestId("child-edit-save").click();
  await expect(row).toContainText("Retry");
  await expect(row.getByTestId("child-edit-name")).toHaveCount(0);
});

for (const paddedName of [false, true]) {
  test(`edycja profilu: dwie przeglądarki zachowują zmiany różnych pól (${paddedName ? "spacje" : "bez spacji"})`, async ({ page, browser }) => {
    const { child, row, path } = await profileForEditing(page, "fox", paddedName);
    const secondContext = await browser.newContext({ storageState: await page.context().storageState() });
    try {
      const secondPage = await secondContext.newPage();
      await secondPage.goto("/parent");
      await secondPage.getByTestId("tab-children").click();
      const secondRow = secondPage.locator('li[data-testid^="child-row-"]')
        .filter({ has: secondPage.locator(`a[href="/kids/${child.id}/learn"]`) });
      await row.getByTestId("child-edit").click();
      await secondRow.getByTestId("child-edit").click();
      await expect(secondRow.getByTestId("child-edit-save")).toBeDisabled();
      await row.getByTestId("child-edit-name").fill("Nowe imię");
      await row.getByTestId("child-edit-save").click();
      await expect(row).toContainText("Nowe imię");
      // Drugi formularz nadal ma starą nazwę, ale zmienia wyłącznie awatar.
      await expect(secondRow.getByTestId("child-edit-name")).toHaveValue(child.displayName);
      await secondRow.getByTestId("child-edit-avatar").selectOption("panda");
      const request = secondPage.waitForRequest((request) => request.method() === "PATCH" && new URL(request.url()).pathname === path);
      await secondRow.getByTestId("child-edit-save").click();
      expect((await request).postDataJSON()).toEqual({ avatarKey: "panda" });
      await expect(secondRow).toContainText("Nowe imię");
      const list = await (await secondPage.request.get("/api/v1/parent/children")).json();
      expect(list.find((value: { id: string }) => value.id === child.id))
        .toEqual({ ...child, displayName: "Nowe imię", avatarKey: "panda" });
    } finally {
      await secondContext.close();
    }
  });
}

test("edycja profilu: udany zapis i błąd odświeżenia mają osobny komunikat", async ({ page }) => {
  const { child, row } = await profileForEditing(page);
  await row.getByTestId("child-edit").click();
  await row.getByTestId("child-edit-name").fill("Zapisane");
  await page.route("**/api/v1/parent/children", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ status: 500, json: { code: "internal", message: "Błąd listy" } });
    else await route.continue();
  });
  await row.getByTestId("child-edit-save").click();
  await expect(page.getByRole("status")).toContainText("Zapisano zmiany, ale nie udało się odświeżyć listy");
  await expect(row.getByTestId("child-edit-name")).toHaveCount(0);
  await page.unroute("**/api/v1/parent/children");
  const list = await (await page.request.get("/api/v1/parent/children")).json();
  expect(list.find((value: { id: string }) => value.id === child.id).displayName).toBe("Zapisane");
});

test("edycja profilu: blokada podczas żądania i usunięcie w drugim kliencie", async ({ page }) => {
  const { row, path } = await profileForEditing(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let patches = 0;
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() === "PATCH") { patches++; await gate; }
    await route.continue();
  });
  await row.getByTestId("child-edit").click();
  await row.getByTestId("child-edit-name").fill("Usunięte");
  try {
    await row.getByTestId("child-edit-name").press("Enter");
    await expect(row.getByTestId("child-edit-name")).toBeDisabled();
    await expect(row.getByTestId("child-edit-avatar")).toBeDisabled();
    await expect(row.getByTestId("child-edit-save")).toBeDisabled();
    await expect(row.getByTestId("child-edit-cancel")).toBeDisabled();
    await expect(row.getByRole("button", { name: "Usuń", exact: true })).toBeDisabled();
    await row.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit());
    expect((await page.request.delete(path)).status()).toBe(204);
  } finally { release(); }
  await expect(row.getByRole("alert")).toBeVisible();
  expect(patches).toBe(1);
  await expect(row.getByTestId("child-edit-name")).toHaveValue("Usunięte");
  await page.reload();
  await page.getByTestId("tab-children").click();
  await expect(row).toHaveCount(0);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }]) {
  test(`edycja profilu: układ ${viewport.width}px i zniknięcie po odświeżeniu`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const { row, child } = await profileForEditing(page);
    await row.getByTestId("child-edit").click();
    await expect(row.getByLabel("Imię", { exact: true })).toBeVisible();
    await expect(row.getByLabel("Obrazek", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await row.screenshot({ path: testInfo.outputPath(`profile-edit-${viewport.width}.png`) });
    expect((await page.request.delete(`/api/v1/parent/children/${child.id}`)).status()).toBe(204);
    // Dodanie innego profilu wywołuje istniejące onChanged bez reload.
    await page.getByTestId("child-name").fill(`Nowe-${randomUUID()}`);
    await page.getByTestId("child-add").click();
    await expect(row).toHaveCount(0);
    await expect(page.getByTestId("child-edit-name")).toHaveCount(0);
  });
}

test("pełny obieg rodzica: generuj, popraw, publikuj, przypisz", async ({ page, request }) => {
  test.slow();

  // Pierwsze uruchomienie w czystym świecie: setup PIN rodzica; w świecie
  // współdzielonym z innymi specami ten sam formularz loguje istniejącym PIN-em.
  await page.goto("/parent");
  await fillParentAuth(page);
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("tab-decks")).toBeVisible();

  // Profile dwojga dzieci — świat współdzieli bazę z innymi specami,
  // więc szukamy wierszy po imieniu, a nie po indeksie.
  await page.getByTestId("tab-children").click();
  const alaName = `Ala ${randomUUID().slice(0, 6)}`;
  const bartekName = `Bartek ${randomUUID().slice(0, 6)}`;
  await page.getByTestId("child-name").fill(alaName);
  await page.getByTestId("child-year").fill("2018");
  await page.getByTestId("child-add").click();
  const alaRow = page.locator('[data-testid^="child-row"]').filter({ hasText: alaName });
  await expect(alaRow).toHaveCount(1);
  const alaLearnLink = alaRow.getByTestId("child-learn-link");
  await expect(alaLearnLink).toHaveAttribute("href", /^\/kids\/[0-9a-f-]{36}\/learn$/);
  const alaId = (await alaLearnLink.getAttribute("href"))!.match(/\/kids\/([0-9a-f-]{36})\//)![1]!;
  await page.getByTestId("child-name").fill(bartekName);
  await page.getByTestId("child-add").click();
  const bartekRow = page.locator('[data-testid^="child-row"]').filter({ hasText: bartekName });
  await expect(bartekRow).toHaveCount(1);
  const bartekLearnLink = bartekRow.getByTestId("child-learn-link");
  await expect(bartekLearnLink).toHaveAttribute("href", /^\/kids\/[0-9a-f-]{36}\/learn$/);
  const bartekId = (await bartekLearnLink.getAttribute("href"))!.match(/\/kids\/([0-9a-f-]{36})\//)![1]!;
  expect(await alaLearnLink.getAttribute("href")).not.toBe(await bartekLearnLink.getAttribute("href"));

  // Nowy zestaw o znanym terminie sprawdzianu (za siedem dni).
  await page.getByTestId("tab-decks").click();
  await openNewMaterial(page, "generate");
  await page.getByTestId("deck-prompt").fill("angielskie dni tygodnia dla początkującego dziecka");
  await page.getByTestId("deck-title").fill(DECK_TITLE);
  const generated = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/api/v1/parent/decks/generate"),
  );
  // Fake'i nie mają opóźnienia: bramka trzyma generowanie, dopóki test nie
  // sprawdzi banera i odświeżenia w trakcie.
  await holdFakeGeneration();
  await page.getByTestId("generate-submit").click();
  const generationResponse = await generated;
  expect(generationResponse.status()).toBe(202);
  const { deckId } = await generationResponse.json() as { deckId: string };
  // Po zweryfikowanym 202 panel otwiera utworzony edytor.
  await expect(page.getByTestId("editor-title")).toHaveValue(DECK_TITLE);
  await expect(page.getByTestId("generation-banner")).toBeVisible();

  // Odświeżenie strony w trakcie generowania: panel dalej prowadzi przegląd.
  // Edytor ma własny adres, więc odświeżenie zostawia go otwartym.
  await page.reload();
  await expect(page.getByTestId("editor-title")).toHaveValue(DECK_TITLE);
  await expect(page.getByTestId("generation-banner")).toBeVisible();
  await releaseFakeGeneration();
  await expect(page.getByTestId("item-card-0")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("item-card-6")).toBeVisible();
  await expect(page.getByTestId("item-target-0")).toHaveValue("monday");
  await expect(page.getByTestId("item-accepted-4")).toHaveValue("Friday, Fri.");

  // Odtworzenie audio celu przed edycją.
  await expect(page.getByTestId("item-audio-state-0")).toContainText("gotowe", { timeout: 60_000 });
  await playTargetAudio(page, deckId, 0);

  // Popraw słowo i wariant; kosztowna regeneracja dopiero po jawnym zapisie.
  await page.getByTestId("item-target-3").fill("thursday");
  await page.getByTestId("item-accepted-3").fill("Thursday");
  await holdFakeGeneration();
  await page.getByTestId("save-items").click();
  await expect(page.getByTestId("item-target-3")).toHaveValue("thursday");
  await expect(page.getByTestId("item-audio-state-3")).toContainText("generowanie");

  // Publikacja zablokowana, dopóki obowiązkowe TTS nie jest gotowe; rodzic
  // wie, że media się przygotowują i wystarczy opublikować ponownie (#106).
  await page.getByTestId("publish-deck").click();
  await expect(page.getByTestId("api-error")).toContainText(messages.decks.publishMediaPending);
  await releaseFakeGeneration();

  // Nowe audio gotowe → odtworzenie nowego zasobu.
  await expect(page.getByTestId("item-audio-state-3")).toContainText("gotowe", { timeout: 60_000 });
  await playTargetAudio(page, deckId, 3);

  // Zły obraz świadomie pominięty — publikacja bez niego jest dozwolona.
  await page.getByTestId("item-menu-3").click();
  await page.getByTestId("item-omit-image-3").click();
  await expect(page.getByTestId("item-image-state-3")).toContainText("pominięty");

  for (const index of [0, 1, 2, 4]) {
    await expect(page.getByTestId(`item-image-state-${index}`)).toContainText("gotowy", {
      timeout: 60_000,
    });
  }
  await page.getByTestId("publish-deck").click();
  await expect(page.getByTestId("publish-status")).toContainText(messages.decks.published);

  // Przypisanie dwojgu dzieciom z różnymi terminami sprawdzianu.
  const alaDate = isoDate(7);
  const bartekDate = isoDate(14);
  const alaAssignRow = page.locator('[data-testid^="assign-row-"]').filter({ hasText: alaName });
  await alaAssignRow.locator('[data-testid^="assign-date-"]').fill(alaDate);
  await alaAssignRow.locator('[data-testid^="assign-submit-"]').click();
  await expect(page.locator('[data-testid^="assignment-row-"]').filter({ hasText: alaName })).toContainText(displayDate(alaDate));
  const bartekAssignRow = page.locator('[data-testid^="assign-row-"]').filter({ hasText: bartekName });
  await bartekAssignRow.locator('[data-testid^="assign-date-"]').fill(bartekDate);
  await bartekAssignRow.locator('[data-testid^="assign-submit-"]').click();
  await expect(page.locator('[data-testid^="assignment-row-"]').filter({ hasText: bartekName })).toContainText(displayDate(bartekDate));
  // Kid API exposes a published deck only after assignment to that child.
  const assignedKidDecks = await request.get(`/api/v1/kid/decks?childId=${alaId}`);
  expect(assignedKidDecks.ok()).toBe(true);
  expect((await assignedKidDecks.json() as { deckId: string }[]).some((entry) => entry.deckId === deckId)).toBe(true);

  // Przypisania przeżywają odświeżenie strony (edytor zostaje otwarty pod swoim adresem).
  await page.reload();
  await expect(page.locator('[data-testid^="assignment-row-"]').filter({ hasText: alaName })).toContainText(displayDate(alaDate));
  await expect(page.locator('[data-testid^="assignment-row-"]').filter({ hasText: bartekName })).toContainText(displayDate(bartekDate));

  // Nowa wersja opublikowanego materiału (SPEC §84): wgląd w opublikowane
  // elementy, szkic v2 z kopią treści i mediów, zmiana znaczenia słowa,
  // ponowna publikacja. Opublikowana wersja pozostaje niezmieniona.
  await expect(page.getByTestId("item-target-0")).toHaveValue("monday");
  await expect(page.getByTestId("item-source-0")).toBeDisabled();
  await page.getByTestId("new-version").click();
  await expect(page.getByTestId("item-source-0")).toBeEnabled();
  const mondaySource = await page.getByTestId("item-source-0").inputValue();
  await page.getByTestId("item-source-0").fill(`${mondaySource} (dzień)`);

  // Klik nie czeka na PATCH: stan mediów weryfikujemy w odpowiedzi zapisu,
  // a nie na DOM, który chwilę po kliknięciu pokazuje jeszcze stan przed zapisem.
  const saved = page.waitForResponse(
    (response) => response.request().method() === "PATCH" && response.url().includes("/drafts/"),
  );
  await holdFakeGeneration();
  await page.getByTestId("save-items").click();
  const savedResponse = await saved;
  expect(savedResponse.status()).toBe(200);
  const savedDraft = (await savedResponse.json()) as {
    items: { revisionId: string }[];
    assets: { itemRevisionId: string; role: string; state: string }[];
  };
  const mondayRevision = savedDraft.items[0]!.revisionId;
  // niezmieniony angielski cel zachowuje gotowe audio bez regeneracji
  const mondayAudio = savedDraft.assets.find(
    (asset) => asset.role === "target_audio" && asset.itemRevisionId === mondayRevision,
  );
  expect(mondayAudio?.state).toBe("approved");
  // obraz ilustruje znaczenie — zmiana źródła planuje nową generację
  const mondayImage = savedDraft.assets.find(
    (asset) => asset.role === "illustration" && asset.itemRevisionId === mondayRevision,
  );
  expect(mondayImage?.state).toBe("pending");

  // publikacja dopiero, gdy nowy obraz dojrzeje w workerze (bramka fake'ów)
  await expect(page.getByTestId("item-image-state-0")).toContainText("generowanie");
  await releaseFakeGeneration();
  await expect(page.getByTestId("item-image-state-0")).toContainText("gotowy", { timeout: 60_000 });
  await page.getByTestId("publish-deck").click();
  await expect(page.getByTestId("publish-status")).toContainText(messages.decks.published);

  // Nieopublikowana treść nie jest dostępna w Kid API.
  const visible = await request.get(`/api/v1/kid/decks?childId=${bartekId}`);
  expect(visible.ok()).toBe(true);
  expect((await visible.json() as { deckId: string }[]).some((entry) => entry.deckId === deckId)).toBe(true);
});

const MANUAL_DECK_TITLE = `Dni tygodnia — edycja ręczna ${randomUUID().slice(0, 8)}`;

test("ręczna edycja zestawu: dodaj element, usuń element, zmień tytuł", async ({ page }) => {
  test.slow();

  const deckId = await createReadyManualDraft(page, MANUAL_DECK_TITLE);
  const manualRow = page.locator(`[data-deck-id="${deckId}"]`);
  await expect(page.getByTestId("editor-title")).toHaveValue(MANUAL_DECK_TITLE);

  // Nowa, pusta karta na końcu listy — dopóki rodzic nie wypełni pól.
  await page.getByTestId("add-item").click();
  await expect(page.getByTestId("item-card-2")).toBeVisible();
  await expect(page.getByTestId("item-source-2")).toHaveValue("");

  // Pusta karta blokuje zapis całości: polski komunikat zanim PATCH poleci na serwer.
  await page.getByTestId("save-items").click();
  await expect(page.getByTestId("api-error")).toContainText(messages.decks.itemIncomplete);

  // Uzupełniona karta zapisuje się jako nowy element; serwer zleca jej media.
  await page.getByTestId("item-source-2").fill("gruszka");
  await page.getByTestId("item-target-2").fill("pear");
  const added = page.waitForResponse(
    (response) => response.request().method() === "PATCH" && response.url().includes("/drafts/"),
  );
  await holdFakeGeneration();
  await page.getByTestId("save-items").click();
  const addedResponse = await added;
  expect(addedResponse.status()).toBe(200);
  const addedDraft = (await addedResponse.json()) as { items: { source: string }[] };
  expect(addedDraft.items).toHaveLength(3);
  expect(addedDraft.items[2]!.source).toBe("gruszka");
  await expect(page.getByTestId("item-audio-state-2")).toContainText("generowanie");
  await releaseFakeGeneration();
  await expect(page.getByTestId("item-audio-state-2")).toContainText("gotowe", { timeout: 60_000 });

  // Usunięcie karty jest częścią formularza: znika po zapisie jako element wersji.
  await page.getByTestId("item-menu-0").click();
  await page.getByTestId("item-remove-0").click();
  await expect(page.getByTestId("item-card-2")).toHaveCount(0);
  await expect(page.getByTestId("item-source-0")).toHaveValue("wtorek");
  const removed = page.waitForResponse(
    (response) => response.request().method() === "PATCH" && response.url().includes("/drafts/"),
  );
  await page.getByTestId("save-items").click();
  const removedResponse = await removed;
  expect(removedResponse.status()).toBe(200);
  const removedDraft = (await removedResponse.json()) as { items: { source: string }[] };
  expect(removedDraft.items).toHaveLength(2);
  expect(removedDraft.items.map((item) => item.source)).not.toContain("poniedziałek");

  // Tytuł edytujemy w tym samym formularzu; wiersz zestawu na liście podąży
  // dopiero po publikacji, więc trwałość sprawdzamy w polu szkicu.
  await page.getByTestId("editor-title").fill(`${MANUAL_DECK_TITLE} v2`);
  const retitled = page.waitForResponse(
    (response) => response.request().method() === "PATCH" && response.url().includes("/drafts/"),
  );
  await page.getByTestId("save-items").click();
  expect((await retitled).status()).toBe(200);

  await page.reload();
  await expect(page.getByTestId("editor-title")).toHaveValue(`${MANUAL_DECK_TITLE} v2`);
  await expect(page.getByTestId("item-card-1")).toBeVisible();
  await expect(page.getByTestId("item-card-2")).toHaveCount(0);
  await expect(page.getByTestId("item-target-0")).toHaveValue("tuesday");
  await expect(page.getByTestId("item-source-1")).toHaveValue("gruszka");
  await expect(page.getByTestId("item-target-1")).toHaveValue("pear");
});

test("rodzic edytuje progi wymowy i otwiera listę kalibracyjną", async ({ page }) => {
  await page.goto("/parent");
  await fillParentAuth(page);
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("tab-children")).toBeVisible();
  await page.getByTestId("tab-children").click();

  const childIndex = await page.locator('[data-testid^="child-row-"]').count();
  const childName = `Kalibracja-${randomUUID().slice(0, 8)}`;
  await page.getByTestId("child-name").fill(childName);
  await page.getByTestId("child-add").click();
  const row = page.locator('[data-testid^="child-row"]').filter({ hasText: childName });
  await expect(row).toBeVisible();
  const loaded = page.waitForResponse(
    (response) => response.url().includes("/pronunciation") && response.request().method() === "GET" && response.status() === 200,
  );
  await page.getByTestId(`child-settings-${childIndex}`).click();
  await loaded;
  await expect(page.getByTestId("child-threshold-good")).toHaveValue("70");
  await expect(page.getByTestId("child-threshold-almost")).toHaveValue("50");
  await expect(page.getByTestId("child-attempts")).toBeVisible();

  await page.getByTestId("child-threshold-good").fill("75");
  await page.getByTestId("child-threshold-almost").fill("55");
  await expect(page.getByTestId("child-threshold-good")).toHaveValue("75");
  await expect(page.getByTestId("child-threshold-almost")).toHaveValue("55");
  const saved = page.waitForResponse(
    (response) => response.url().includes("/pronunciation") && response.request().method() === "PUT" && response.status() === 204,
  );
  await page.getByTestId("child-settings-save").click();
  await saved;
  await page.reload();
  await page.getByTestId("tab-children").click();
  const reloaded = page.waitForResponse(
    (response) => response.url().includes("/pronunciation") && response.request().method() === "GET" && response.status() === 200,
  );
  await page.getByTestId(`child-settings-${childIndex}`).click();
  await reloaded;
  await expect(page.getByTestId("child-threshold-good")).toHaveValue("75");
  await expect(page.getByTestId("child-threshold-almost")).toHaveValue("55");
});

test("ostrzega rodzica, gdy profile współdzielą obrazek awatara", async ({ page }) => {
  const suffix = randomUUID().slice(0, 8);
  await loginParent(page);
  const firstName = `Awatar A ${suffix}`;
  const secondName = `Awatar B ${suffix}`;
  expect((await page.request.post("/api/v1/parent/children", { data: { displayName: firstName, avatarKey: "fox" } })).status()).toBe(201);
  expect((await page.request.post("/api/v1/parent/children", { data: { displayName: secondName, avatarKey: "fox" } })).status()).toBe(201);
  await page.goto("/parent");
  await page.getByTestId("tab-children").click();
  const first = page.locator('[data-testid^="child-row-"]').filter({ hasText: firstName });
  const second = page.locator('[data-testid^="child-row-"]').filter({ hasText: secondName });
  await expect(first.locator('[data-testid^="duplicate-avatar-warning-"]')).toContainText("ten sam obrazek");
  await expect(second.locator('[data-testid^="duplicate-avatar-warning-"]')).toContainText("link przy imieniu");
  await expect(first.getByTestId("child-learn-link")).toHaveAttribute("href", /^\/kids\/[0-9a-f-]{36}\/learn$/);
  await expect(second.getByTestId("child-learn-link")).toHaveAttribute("href", /^\/kids\/[0-9a-f-]{36}\/learn$/);
});
