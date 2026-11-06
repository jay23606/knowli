import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { LessonDeckDtoSchema } from "@learning/contracts";
import { lessonWorld } from "../fixtures/lesson-world";
import { closeWorldDatabase, worldPool } from "./helpers/world-database";
import { fillParentAuth, loginParent } from "./helpers/parent-session";

async function enterParent(page: Page): Promise<void> {
  await loginParent(page);
}

async function openParent(page: Page): Promise<void> {
  await page.goto("/parent");
  await expect(page.getByTestId("tab-decks")).toBeVisible();
}

// Gotowy, rzeczywisty rekord w bazie; zaślepiane są tylko awarie transportu.
async function createLesson(page: Page, requestedTitle?: string, publish = false): Promise<{ deckId: string; title: string }> {
  const title = requestedTitle ?? `Present Simple ${randomUUID().slice(0, 8)}`;
  const lesson = await lessonWorld(await worldPool(), { title, publish });
  await openParent(page);
  await expect(page.locator(`[data-deck-id="${lesson.deckId}"]`)).toBeVisible();
  return { deckId: lesson.deckId, title };
}

test.afterAll(closeWorldDatabase);

function removeButton(page: Page, title: string) {
  return page.getByRole("button", { name: `Usuń z listy: ${title}`, exact: true });
}

test("archives a lesson only after confirmation and finds it in the archive after reload", async ({ page }, testInfo) => {
  await enterParent(page);
  // Legalny tytuł maksymalnej długości z długim fragmentem bez spacji.
  const { deckId, title } = await createLesson(page, `Present Simple ${"A".repeat(177)}${randomUUID().slice(0, 8)}`, true);
  await page.setViewportSize({ width: 390, height: 844 });
  const row = page.locator('[data-testid^="deck-row-"]').filter({ hasText: title });
  const remove = removeButton(page, title);
  await expect(remove).toBeVisible({ timeout: 1500 });
  await remove.click();
  const dialog = page.getByRole("dialog", { name: "Usuń lekcję z listy" });
  await expect(dialog).toContainText(title);
  await expect(dialog).toContainText("Historia nauki zostanie zachowana");
  expect(await dialog.locator("#archive-lesson-description").evaluate((element) =>
    element.scrollWidth <= element.clientWidth,
  )).toBe(true);
  await expect(dialog.getByRole("button", { name: "Anuluj", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(remove).toBeFocused();
  const before = LessonDeckDtoSchema.parse(await (await page.request.get(`/api/v1/parent/lessons/${deckId}`)).json());
  expect(before.state).not.toBe("archived");
  await remove.click();
  await dialog.getByRole("button", { name: "Anuluj", exact: true }).click();
  await expect(row).toBeVisible();
  await remove.click();
  await dialog.getByRole("button", { name: "Usuń z listy", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Pokaż archiwalne" })).toBeFocused();
  await page.reload();
  await expect(page.getByTestId("tab-decks")).toBeVisible();
  await expect(row).toHaveCount(0);
  const showArchive = page.getByRole("checkbox", { name: "Pokaż archiwalne" });
  await showArchive.check();
  await expect(row).toBeVisible();
  await expect(row).toContainText("Archiwum");
  await expect(remove).toHaveCount(0);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`archive-list-${width}.png`), fullPage: true });
  }
  await row.click();
  await expect(page.getByTestId("lesson-editor")).toBeVisible();
});

test("keeps the lesson on a transport failure and allows an idempotent retry", async ({ page }) => {
  await enterParent(page);
  const { deckId, title } = await createLesson(page);
  await page.route(`**/api/v1/parent/decks/${deckId}/archive`, (route) => route.abort("failed"));
  await expect(removeButton(page, title)).toBeVisible({ timeout: 1500 });
  await removeButton(page, title).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Usuń z listy", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Nie udało się usunąć lekcji z listy. Spróbuj ponownie.");
  await expect(dialog.getByRole("button", { name: "Usuń z listy", exact: true })).toBeEnabled();
  const before = LessonDeckDtoSchema.parse(await (await page.request.get(`/api/v1/parent/lessons/${deckId}`)).json());
  expect(before.state).not.toBe("archived");
  await page.unroute(`**/api/v1/parent/decks/${deckId}/archive`);
  await dialog.getByRole("button", { name: "Usuń z listy", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(removeButton(page, title)).toHaveCount(0);
});

test("blocks double submission and preserves success when list refresh fails", async ({ page }) => {
  await enterParent(page);
  const { deckId, title } = await createLesson(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  await page.route(`**/api/v1/parent/decks/${deckId}/archive`, async (route) => {
    requests += 1;
    await gate;
    await route.continue();
  });
  await page.route("**/api/v1/parent/decks", (route) => route.abort("failed"));
  await expect(removeButton(page, title)).toBeVisible({ timeout: 1500 });
  await removeButton(page, title).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Usuń z listy", exact: true }).click();
  try {
    await expect(dialog.getByRole("button", { name: "Usuwam…", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Anuluj", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    expect(requests).toBe(1);
  } finally { release(); }
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status")).toContainText("Lekcja została usunięta z listy");
  await expect(page.locator('[data-testid^="deck-row-"]').filter({ hasText: title })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Pokaż archiwalne" }).check();
  await expect(page.locator('[data-testid^="deck-row-"]').filter({ hasText: title })).toContainText("Archiwum");
  expect(requests).toBe(1);
});

test("returns to login when the parent session expires during archiving", async ({ page }) => {
  await enterParent(page);
  const { deckId, title } = await createLesson(page);
  await expect(removeButton(page, title)).toBeVisible({ timeout: 1500 });
  await removeButton(page, title).click();
  expect((await page.request.post("/api/v1/parent/logout")).status()).toBe(204);
  await page.getByRole("dialog").getByRole("button", { name: "Usuń z listy", exact: true }).click();
  await expect(page.getByTestId("auth-secret")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await fillParentAuth(page);
  await page.getByTestId("auth-submit").click();
  await expect(removeButton(page, title)).toBeVisible();
  const dto = LessonDeckDtoSchema.parse(await (await page.request.get(`/api/v1/parent/lessons/${deckId}`)).json());
  expect(dto.state).not.toBe("archived");
});

test("keeps archived vocabulary decks visible and does not offer lesson removal for them", async ({ page }) => {
  await enterParent(page);
  const title = `Słówka ${randomUUID().slice(0, 8)}`;
  const response = await page.request.post("/api/v1/parent/decks", { data: { deckId: randomUUID(), title } });
  expect(response.status()).toBe(201);
  const { deckId } = await response.json() as { deckId: string };
  expect((await page.request.post(`/api/v1/parent/decks/${deckId}/archive`)).status()).toBe(204);
  await openParent(page);
  const row = page.locator('[data-testid^="deck-row-"]').filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Archiwum");
  await expect(removeButton(page, title)).toHaveCount(0);
});
