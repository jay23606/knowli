import { expect, test, type Page } from "@playwright/test";
import { messages } from "@learning/contracts";

/**
 * Edytor zestawu na Mantine (plan 2026-10-29-parent-ui-mantine, faza 5b;
 * szkic zaakceptowany 2026-10-29): telefon bez przewijania w poziomie,
 * przypięty pasek „Zapisz zmiany / Publikuj” nad dolną nawigacją, akcje
 * mediów w menu ⋯, ustawienia zestawu zwinięte na telefonie, tryb ciemny.
 * API rodzica zaślepione w przeglądarce.
 */

const deckId = "00000000-0000-4000-8000-0000000000d1";
const draftId = "00000000-0000-4000-8000-0000000000d2";
const childId = "00000000-0000-4000-8000-0000000000c1";
const revision = (n: number) => `00000000-0000-4000-8000-00000000010${n}`;
const asset = (n: number) => `00000000-0000-4000-8000-00000000020${n}`;

const items = [
  { source: "poniedziałek", target: "Monday", example: "I go swimming on Monday.", visualType: "none" },
  { source: "wtorek", target: "Tuesday", visualType: "none" },
  { source: "środa — bardzo długie polskie wyjaśnienie znaczenia", target: "Wednesday", visualType: "none" },
].map((item, index) => ({
  ...item,
  acceptedAnswers: [],
  locales: { source: "pl-PL", target: "en-GB" },
  id: `00000000-0000-4000-8000-00000000030${index}`,
  revisionId: revision(index),
}));

const draft = {
  id: draftId, deckId, editNumber: 2, status: "draft", vocabularyFormat: "standard", title: "Dni tygodnia", items,
  assets: [
    { itemRevisionId: revision(0), role: "target_audio", state: "approved", assetId: asset(0) },
    { itemRevisionId: revision(0), role: "example_audio", state: "approved", assetId: asset(1) },
    { itemRevisionId: revision(1), role: "target_audio", state: "approved", assetId: asset(2) },
    { itemRevisionId: revision(2), role: "target_audio", state: "failed", assetId: null },
  ],
};

const deck = {
  id: deckId, title: "Dni tygodnia", state: "published", coverAssetId: null, sessionTaskBudget: 20,
  draft, published: { ...draft, status: "published", editNumber: 1 }, generation: null,
  assignments: [{ childId, displayName: "Ala", testDate: "2026-11-12", testGoals: ["recall"], mockTestTaskCount: 10, active: true }],
};

interface Calls { requests: Array<{ method: string; path: string }> }

async function openEditor(page: Page): Promise<Calls> {
  const calls: Calls = { requests: [] };
  let current = structuredClone(deck);
  await page.route("**/api/v1/parent/**", (route) => {
    const method = route.request().method();
    const path = new URL(route.request().url()).pathname;
    calls.requests.push({ method, path });
    if (method === "DELETE" && path.endsWith(`/assignments/${childId}/${deckId}`)) {
      current = { ...current, assignments: [] };
      return route.fulfill({ status: 204, body: "" });
    }
    if (method === "POST" && path.endsWith(`/decks/${deckId}/archive`)) {
      current = { ...current, state: "archived" };
      return route.fulfill({ status: 204, body: "" });
    }
    if (path.endsWith("/login")) return route.fulfill({ json: { authenticated: true, setupRequired: false } });
    if (path.endsWith("/lesson-catalog")) return route.fulfill({ json: { lessonGenerationAvailable: true, subjects: [] } });
    if (path.endsWith("/children")) return route.fulfill({ json: [{ id: childId, displayName: "Ala", avatarKey: "fox", recordingMode: "hold", canRead: true, interests: [] }] });
    if (path.endsWith("/decks")) return route.fulfill({ json: [{ deckId, title: deck.title, state: "published", kind: "vocabulary", editableVersionId: draftId, publishedVersionId: draftId }] });
    if (path.endsWith(`/decks/${deckId}`)) return route.fulfill({ json: current });
    return route.fulfill({ json: [] });
  });
  await page.goto(`/parent/decks/${deckId}`);
  await expect(page.getByTestId("item-card-0")).toBeVisible();
  return calls;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

test("telefon: pasek akcji nad dolną nawigacją, cele ≥ 44 px, bez przewijania w poziomie", async ({ page }) => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport);
    await openEditor(page);
    await expectNoHorizontalOverflow(page);

    const bar = (await page.getByTestId("editor-action-bar").boundingBox())!;
    const nav = (await page.getByTestId("tab-decks").boundingBox())!;
    // pasek jest przyklejony nad nawigacją i jej nie zasłania
    expect(bar.y + bar.height).toBeLessThanOrEqual(nav.y + 1);
    expect(bar.y + bar.height).toBeGreaterThan(viewport.height - 140);
    for (const id of ["save-items", "publish-deck", "item-menu-0", "editor-back", "add-item"]) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.height, id).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width, id).toBeLessThanOrEqual(viewport.width + 0.5);
    }

    // ustawienia zestawu zwinięte, rozwijają się na żądanie
    await expect(page.getByTestId("deck-session-task-budget")).toBeHidden();
    await page.getByRole("button", { name: new RegExp(messages.decks.settingsTitle) }).click();
    await expect(page.getByTestId("deck-session-task-budget")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});

test("akcje mediów są w menu ⋯ karty, odsłuch prosi o właściwy plik", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openEditor(page);
  await expect(page.getByTestId("item-play-0")).toHaveCount(0);
  await page.getByTestId("item-menu-0").click();
  await expect(page.getByTestId("item-play-example-0")).toBeVisible();
  await expect(page.getByTestId("item-regen-audio-0")).toBeVisible();
  const played = page.waitForRequest((request) => new URL(request.url()).pathname === `/api/v1/media/${asset(0)}`);
  await page.getByTestId("item-play-0").click();
  await played;
  await expect(page.getByTestId("item-audio-state-2")).toContainText("nie udało");
});

test("zmiana pola pokazuje niezapisane zmiany w pasku i blokuje publikację", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openEditor(page);
  await expect(page.getByTestId("publish-deck")).toBeEnabled();
  await page.getByTestId("item-target-1").fill("Tuesday!");
  await expect(page.getByTestId("publish-blocked-reason")).toContainText(messages.decks.unsavedChanges);
  await expect(page.getByTestId("publish-deck")).toBeDisabled();
  await expect(page.getByTestId("item-card-1")).toContainText(messages.decks.changedMediaAfterSave);
  // desktop: pasek przy dolnej krawędzi okna, ustawienia rozwinięte
  const bar = (await page.getByTestId("editor-action-bar").boundingBox())!;
  expect(bar.y + bar.height).toBeGreaterThan(900 - 2);
  await expect(page.getByTestId("deck-session-task-budget")).toBeVisible();
});

test("przypisanie pokazuje termin w karcie dziecka, usunięcie wymaga potwierdzenia w oknie", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const calls = await openEditor(page);
  // systemowe okno przeglądarki nie może się pojawić (zastąpione oknem panelu)
  page.on("dialog", (dialog) => { throw new Error(`niespodziewane okno przeglądarki: ${dialog.message()}`); });
  const deletes = () => calls.requests.filter((request) => request.method === "DELETE");
  const row = page.getByTestId("assign-row-0");
  await expect(row.getByTestId("assignment-row-0")).toContainText("12.11.2026");

  await row.getByTestId("unassign-submit-0").click();
  await expect(page.getByTestId("unassign-confirm")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("unassign-confirm")).toHaveCount(0);
  expect(deletes()).toHaveLength(0);

  await row.getByTestId("unassign-submit-0").click();
  await page.getByTestId("unassign-confirm").click();
  await expect(row.getByTestId("assignment-row-0")).toHaveCount(0);
  expect(deletes()).toHaveLength(1);
});

test("archiwizacja z menu ⋯ zestawu wymaga potwierdzenia", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const calls = await openEditor(page);
  const archives = () => calls.requests.filter((request) => request.method === "POST" && request.path.endsWith("/archive"));
  await page.getByTestId("deck-menu").click();
  await page.getByTestId("archive-deck").click();
  await expect(page.getByTestId("archive-confirm")).toBeVisible();
  expect(archives()).toHaveLength(0);
  await page.getByTestId("archive-confirm").click();
  await expect.poll(() => archives().length).toBe(1);
});

test("tryb ciemny obejmuje edytor", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await openEditor(page);
  const background = await page.getByTestId("item-card-0").evaluate((element) => getComputedStyle(element).backgroundColor);
  const [r, g, b] = background.match(/\d+/g)!.map(Number);
  expect(r! + g! + b!).toBeLessThan(3 * 80);
  const bar = await page.getByTestId("editor-action-bar").evaluate((element) => getComputedStyle(element).backgroundColor);
  const [br, bg, bb] = bar.match(/\d+/g)!.map(Number);
  expect(br! + bg! + bb!).toBeLessThan(3 * 80);
});

test("nowa lekcja i edytor lekcji są w trybie ciemnym jak reszta panelu (bez jasnej wyspy)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await openEditor(page);
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-mantine-color-scheme", "dark");

  await page.goto("/parent/lessons/new");
  await expect(page.getByTestId("new-lesson-form")).toBeVisible();
  await expect(html).toHaveAttribute("data-mantine-color-scheme", "dark");

  // odczyt lekcji nieistotny — liczy się schemat strony z edytorem lekcji
  const lessonId = "00000000-0000-4000-8000-0000000000e1";
  await page.route("**/api/v1/parent/decks", (route) => route.fulfill({ json: [
    { deckId: lessonId, title: "Present Simple", state: "draft", kind: "lesson", editableVersionId: draftId, publishedVersionId: null },
  ] }));
  await page.route(`**/api/v1/parent/lessons/${lessonId}`, (route) =>
    route.fulfill({ status: 404, json: { code: "not_found", message: "Brak", retryable: false, requestId: "r" } }));
  await page.goto(`/parent/decks/${lessonId}`);
  await expect(page.getByTestId("lesson-editor")).toBeVisible();
  await expect(html).toHaveAttribute("data-mantine-color-scheme", "dark");
  await expect(page.locator(".pp-legacy-area")).toHaveCount(0);
});
