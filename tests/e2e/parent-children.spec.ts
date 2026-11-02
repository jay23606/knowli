import { expect, test, type Page, type Request } from "@playwright/test";
import { messages } from "@learning/contracts";

/**
 * Sekcja Dzieci na Mantine (plan 2026-10-29-parent-ui-mantine, faza 3):
 * układ kart na telefonie i desktopie, tryb ciemny, ochrona niezapisanych
 * formularzy przed wyjściem z sekcji, potwierdzenie usunięcia w oknie
 * i walidacja progów wymowy. API rodzica zaślepione w przeglądarce.
 */

const ALA = { id: "3f2c1a9e-5b7d-4c8e-9a1b-2c3d4e5f6a7b", displayName: "Ala", avatarKey: "fox", birthYear: 2018, recordingMode: "hold", canRead: true, interests: [] };
const BARTEK = { id: "8a9b0c1d-2e3f-4a5b-8c7d-9e0f1a2b3c4d", displayName: "Bartłomiej Długonazwiskowy", avatarKey: "owl", recordingMode: "toggle", canRead: false, interests: [] };

interface MockApi {
  requests: Request[];
  children: Array<Record<string, unknown>>;
}

async function openChildren(
  page: Page,
  options: { childStatus?: number; deleteStatus?: number; deleteGate?: Promise<void> } = {},
): Promise<MockApi> {
  const api: MockApi = { requests: [], children: [ALA, BARTEK] };
  await page.route("**/api/v1/parent/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    api.requests.push(request);
    if (url.pathname.endsWith("/login")) {
      return route.fulfill({ json: { authenticated: true, setupRequired: false } });
    }
    if (url.pathname.endsWith("/children") && method === "GET") return route.fulfill({ json: api.children });
    if (url.pathname.endsWith("/pronunciation") && method === "GET") {
      return route.fulfill({
        json: {
          pronunciationAvailable: true,
          thresholds: { correctMinScore: 70, partialMinScore: 50 },
          attempts: [{ word: "monday", score: 82.4, band: "correct", attemptedAt: "2026-10-28 17:05" }],
        },
      });
    }
    if (method === "PATCH") {
      if (options.childStatus) {
        return route.fulfill({ status: options.childStatus, json: { code: "unauthorized", message: "Sesja wygasła", retryable: false, requestId: "r" } });
      }
      return route.fulfill({ json: { ...ALA, ...request.postDataJSON() } });
    }
    if (method === "DELETE") {
      await options.deleteGate;
      if (options.deleteStatus) {
        return route.fulfill({ status: options.deleteStatus, json: { code: "internal", message: "Nie udało się usunąć", retryable: true, requestId: "r" } });
      }
      api.children = api.children.filter((child) => !url.pathname.endsWith(String(child.id)));
      return route.fulfill({ status: 204, body: "" });
    }
    if (method === "PUT") return route.fulfill({ status: 204, body: "" });
    return route.fulfill({ json: [] });
  });
  await page.goto("/parent/children");
  await expect(page.getByTestId("child-row-0")).toBeVisible();
  return api;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

const mutations = (api: MockApi, method: string) => api.requests.filter((request) => request.method() === method);

test("telefon: karty dzieci w jednej kolumnie, cele ≥ 44 px, bez przewijania w poziomie", async ({ page }) => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport);
    await openChildren(page);
    await expectNoHorizontalOverflow(page);
    const first = (await page.getByTestId("child-row-0").boundingBox())!;
    const second = (await page.getByTestId("child-row-1").boundingBox())!;
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.height);
    expect(Math.abs(second.x - first.x)).toBeLessThan(1);
    const row = page.getByTestId("child-row-1");
    for (const target of [row.getByTestId("child-learn-link"), row.getByTestId("child-edit"), row.getByTestId("child-settings-1"), row.getByRole("button", { name: messages.children.remove, exact: true })]) {
      const box = (await target.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
    }
    await row.getByTestId("child-edit").click();
    await row.getByTestId("child-settings-1").click();
    await expect(row.getByTestId("child-threshold-good")).toHaveValue("70");
    await expectNoHorizontalOverflow(page);
  }
});

test("desktop: karty obok siebie, tryb ciemny obejmuje sekcję", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "dark" });
  await openChildren(page);
  const first = (await page.getByTestId("child-row-0").boundingBox())!;
  const second = (await page.getByTestId("child-row-1").boundingBox())!;
  expect(Math.abs(second.y - first.y)).toBeLessThan(1);
  const background = await page.getByTestId("child-row-0").evaluate((element) => getComputedStyle(element).backgroundColor);
  const [r, g, b] = background.match(/\d+/g)!.map(Number);
  expect(r! + g! + b!).toBeLessThan(3 * 80);
});

test("niezapisana edycja profilu zatrzymuje przejście do innej sekcji", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openChildren(page);
  const row = page.getByTestId("child-row-0");
  await row.getByTestId("child-edit").click();
  await row.getByTestId("child-edit-name").fill("Alicja");

  await page.getByTestId("tab-decks").click();
  await expect(page.getByTestId("leave-editor-dialog")).toBeVisible();
  await page.getByTestId("leave-editor-stay").click();
  await expect(page).toHaveURL(/\/parent\/children$/);
  await expect(row.getByTestId("child-edit-name")).toHaveValue("Alicja");

  // cofnięcie zmiany wyłącza ochronę
  await row.getByTestId("child-edit-name").fill("Ala");
  await page.getByTestId("tab-progress").click();
  await expect(page).toHaveURL(/\/parent\/progress$/);
  await expect(page.getByTestId("leave-editor-dialog")).toHaveCount(0);
});

test("niezapisane progi wymowy i wpisane imię nowego dziecka też chronią przed wyjściem", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openChildren(page);
  await page.getByTestId("child-settings-0").click();
  await page.getByTestId("child-threshold-good").fill("80");
  await page.getByTestId("tab-decks").click();
  await expect(page.getByTestId("leave-editor-dialog")).toBeVisible();
  await page.getByTestId("leave-editor-stay").click();
  await page.getByTestId("child-settings-0").click();

  await page.getByTestId("child-name").fill("Celina");
  await page.getByTestId("tab-decks").click();
  await expect(page.getByTestId("leave-editor-dialog")).toBeVisible();
  await page.getByTestId("leave-editor-leave").click();
  await expect(page).toHaveURL(/\/parent\/decks$/);

  // po wyjściu ochrona nie zostaje: kolejne przejścia bez okna
  await page.getByTestId("tab-children").click();
  await page.getByTestId("tab-progress").click();
  await expect(page).toHaveURL(/\/parent\/progress$/);
  await expect(page.getByTestId("leave-editor-dialog")).toHaveCount(0);
});

test("wygasła sesja przy zapisie profilu otwiera logowanie w oknie i zachowuje formularz", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openChildren(page, { childStatus: 401 });
  const row = page.getByTestId("child-row-0");
  await row.getByTestId("child-edit").click();
  await row.getByTestId("child-edit-name").fill("Alicja");
  await row.getByTestId("child-edit-save").click();
  await expect(page.getByTestId("reauth-dialog")).toBeVisible();
  await expect(row.getByTestId("child-edit-name")).toHaveValue("Alicja");
});

test("usunięcie profilu wymaga potwierdzenia w oknie; anulowanie niczego nie usuwa", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await openChildren(page);
  const remove = page.getByTestId("child-row-0").getByRole("button", { name: messages.children.remove, exact: true });

  await remove.click();
  const dialog = page.getByTestId("child-remove-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(messages.children.removeConfirm);
  await expect(dialog).toContainText(messages.children.removeKeepsLessonThemes);
  await expect(dialog).toContainText(messages.children.removeKeepsCostTotals);
  await expect(page.getByTestId("child-remove-cancel")).toBeFocused();
  await page.getByTestId("child-remove-cancel").click();
  await expect(dialog).toHaveCount(0);
  expect(mutations(api, "DELETE")).toHaveLength(0);

  await remove.click();
  await page.getByTestId("child-remove-confirm").click();
  await expect(page.locator('[data-testid^="child-row-"]')).toHaveCount(1);
  await expect(page.getByTestId("child-row-0")).toContainText(BARTEK.displayName);
  expect(mutations(api, "DELETE")).toHaveLength(1);
  expect(new URL(mutations(api, "DELETE")[0]!.url()).pathname).toBe(`/api/v1/parent/children/${ALA.id}`);
});

test("zainteresowania: dodanie tematów Enterem trafia do PATCH, notki są widoczne, szósty temat nie wchodzi", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const api = await openChildren(page);
  const row = page.getByTestId("child-row-0");
  await row.getByTestId("child-edit").click();
  await expect(row.getByText(messages.children.interestsHint)).toBeVisible();
  await expect(row.getByText(messages.children.interestsPrivacy)).toBeVisible();

  const field = row.getByTestId("child-edit-interests");
  await field.fill("piłka nożna");
  await field.press("Enter");
  await field.fill("Minecraft");
  await field.press("Enter");
  await field.fill("PIŁKA NOŻNA");
  await field.press("Enter");
  await expect(row.getByText(messages.children.interestsDuplicate)).toBeVisible();
  for (const topic of ["lego", "dinozaury", "koty"]) {
    await field.fill(topic);
    await field.press("Enter");
  }
  await field.fill("szósty");
  await field.press("Enter");
  await expect(row.getByText(messages.children.interestsLimit.replace("{max}", "5"))).toBeVisible();
  await expect(row.locator(".mantine-Pill-root")).toHaveCount(5);
  await expect(row.getByText("szósty", { exact: true })).toHaveCount(0);

  // usunięcie trzech ostatnich zostawia dwa tematy z wpisu
  for (let i = 0; i < 3; i += 1) await row.locator(".mantine-Pill-remove").last().click();
  await field.fill("");
  await row.getByTestId("child-edit-save").click();
  await expect(page.getByText(messages.children.saved)).toBeVisible();
  const patches = mutations(api, "PATCH");
  expect(patches).toHaveLength(1);
  expect(patches[0]!.postDataJSON()).toEqual({ interests: ["piłka nożna", "Minecraft"] });
});

test("zainteresowania: wklejenie listy ponad limit i przecinek przy pełnym polu pokazują komunikat o limicie", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const api = await openChildren(page);
  const row = page.getByTestId("child-row-0");
  await row.getByTestId("child-edit").click();
  const field = row.getByTestId("child-edit-interests");
  // zdarzenie wklejenia z danymi schowka, bez uprawnień do prawdziwego schowka
  await field.evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, "lego, dinozaury, koty, Minecraft, rowery, szósty, siódmy");
  const limit = messages.children.interestsLimit.replace("{max}", "5");
  await expect(row.locator(".mantine-Pill-root")).toHaveCount(5);
  await expect(row.getByText(limit)).toBeVisible();
  await expect(row.getByText("szósty", { exact: true })).toHaveCount(0);

  // przecinek przy pełnym polu też ucina wpis — z tym samym komunikatem
  await field.fill("ósmy");
  await expect(row.getByText(limit)).toHaveCount(0);
  await field.press(",");
  await expect(row.getByText(limit)).toBeVisible();
  await expect(row.locator(".mantine-Pill-root")).toHaveCount(5);

  await row.getByTestId("child-edit-save").click();
  await expect(page.getByText(messages.children.saved)).toBeVisible();
  const patches = mutations(api, "PATCH");
  expect(patches).toHaveLength(1);
  expect(patches[0]!.postDataJSON()).toEqual({ interests: ["lego", "dinozaury", "koty", "Minecraft", "rowery"] });
});

test("zainteresowania: niepoprawny temat daje błąd pola i blokuje zapis", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const api = await openChildren(page);
  const row = page.getByTestId("child-row-0");
  await row.getByTestId("child-edit").click();
  const field = row.getByTestId("child-edit-interests");
  await field.fill("<script>");
  await field.press("Enter");
  await expect(row.getByText(messages.children.interestsInvalid.replace("{max}", "40"))).toBeVisible();
  await expect(row.getByTestId("child-edit-save")).toBeDisabled();
  await row.locator(".mantine-Pill-remove").last().click();
  await expect(row.getByTestId("child-edit-save")).toBeDisabled(); // brak zmian względem profilu
  expect(mutations(api, "PATCH")).toHaveLength(0);
});

test("progi wymowy: błędna kolejność progów nie trafia do API", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const api = await openChildren(page);
  await page.getByTestId("child-settings-0").click();
  await expect(page.getByTestId("child-attempt-row")).toContainText("monday — 82 (dobrze)");

  await page.getByTestId("child-threshold-good").fill("40");
  await page.getByTestId("child-settings-save").click();
  await expect(page.getByText(messages.children.pronunciationThresholdOrder)).toBeVisible();
  expect(mutations(api, "PUT")).toHaveLength(0);

  await page.getByTestId("child-threshold-good").fill("90");
  await page.getByTestId("child-settings-save").click();
  await expect(page.getByText(messages.children.pronunciationSaved)).toBeVisible();
  expect(mutations(api, "PUT")).toHaveLength(1);
  expect(mutations(api, "PUT")[0]!.postDataJSON()).toEqual({ correctMinScore: 90, partialMinScore: 50 });

  // zapisane progi nie blokują wyjścia
  await page.getByTestId("tab-decks").click();
  await expect(page).toHaveURL(/\/parent\/decks$/);
});

test("nieudane usunięcie profilu zostawia kartę i pokazuje błąd", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openChildren(page, { deleteStatus: 500 });
  const remove = page.getByTestId("child-row-0").getByRole("button", { name: messages.children.remove, exact: true });
  await remove.click();
  await page.getByTestId("child-remove-confirm").click();
  await expect(page.getByTestId("children-error")).toContainText("Nie udało się usunąć");
  await expect(page.locator('[data-testid^="child-row-"]')).toHaveCount(2);
  await expect(remove).toBeEnabled();
});

test("trwające usunięcie wstrzymuje wyjście z sekcji, a lista odświeża się po zakończeniu", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await openChildren(page, { deleteGate: gate });
  await page.getByTestId("child-row-0").getByRole("button", { name: messages.children.remove, exact: true }).click();
  await page.getByTestId("child-remove-confirm").click();
  await expect(page.getByTestId("child-row-0").getByRole("button", { name: messages.children.removing })).toBeDisabled();
  await expect(page.getByRole("heading", { name: messages.children.title })).toBeFocused();

  await page.getByTestId("tab-progress").click();
  await expect(page).toHaveURL(/\/parent\/children$/);
  release();
  await expect(page.locator('[data-testid^="child-row-"]')).toHaveCount(1);
  await page.getByTestId("tab-progress").click();
  await expect(page).toHaveURL(/\/parent\/progress$/);
});

test("progi wymowy i rok urodzenia spoza zakresu dają komunikat zamiast cichej poprawki", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const api = await openChildren(page);
  await page.getByTestId("child-settings-0").click();
  await page.getByTestId("child-threshold-good").fill("150");
  await page.getByTestId("child-settings-save").click();
  await expect(page.getByText(messages.children.pronunciationThresholdRange)).toBeVisible();
  await expect(page.getByTestId("child-threshold-good")).toHaveValue("150");
  expect(mutations(api, "PUT")).toHaveLength(0);

  await page.getByTestId("child-name").fill("Celina");
  await page.getByTestId("child-year").fill("1800");
  await page.getByTestId("child-add").click();
  await expect(page.getByText(messages.children.birthYearInvalid)).toBeVisible();
  expect(mutations(api, "POST")).toHaveLength(0);
});
