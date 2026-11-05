import { expect, test, type Page } from "@playwright/test";
import { messages } from "@learning/contracts";

/**
 * Nowa lekcja na Mantine (plan 2026-10-29-parent-ui-mantine, faza 6a):
 * telefon bez przewijania w poziomie, cele ≥ 44 px, tryb ciemny, przedmiot
 * szkolny, ochrona wpisanego materiału przed wyjściem i ponowienie
 * niepewnego polecenia z tym samym identyfikatorem. API rodzica zaślepione
 * w przeglądarce.
 */

const catalog = {
  generationService: "openrouter.ai · google/gemini-3.8-flash",
  subjects: [
    {
      id: "english_grammar",
      titlePl: "Gramatyka angielska",
      creation: "catalog",
      subjectTitleRequired: false,
      acceptsInterests: true,
      topics: [{
        id: "present_simple",
        titlePl: "Present Simple",
        objectives: [
          { id: "third_person_s", titlePl: "Końcówka -s w trzeciej osobie liczby pojedynczej (he/she/it)" },
          { id: "negation", titlePl: "Przeczenia z do/does" },
          { id: "questions", titlePl: "Pytania z do/does" },
          { id: "adverbs", titlePl: "Przysłówki częstotliwości" },
          { id: "spelling_es", titlePl: "Pisownia -es" },
          { id: "spelling_ies", titlePl: "Pisownia -ies" },
        ],
      }],
    },
    { id: "school", titlePl: "Przedmiot szkolny", creation: "material", subjectTitleRequired: true, topics: [] },
    { id: "english_chapter", titlePl: "Angielski — rozdział", creation: "material", subjectTitleRequired: false, topics: [] },
  ],
};

const children = [
  { id: "00000000-0000-4000-8000-0000000000c1", displayName: "Ola", avatarKey: "fox", recordingMode: "hold", canRead: true, interests: ["dinozaury", "Minecraft"] },
  { id: "00000000-0000-4000-8000-0000000000c2", displayName: "Adam", avatarKey: "owl", recordingMode: "hold", canRead: true, interests: [] },
];

interface Api { creates: Array<{ path: string; body: Record<string, unknown> }> }

async function openNewLesson(
  page: Page, createStatus: () => number = () => 202, hold: Promise<void> = Promise.resolve(), childList: unknown[] = [], catalogData: unknown = catalog,
): Promise<Api> {
  const api: Api = { creates: [] };
  await page.route("**/api/v1/parent/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/login")) return route.fulfill({ json: { authenticated: true, setupRequired: false } });
    if (path.endsWith("/lesson-catalog")) return route.fulfill({ json: catalogData });
    if (path.endsWith("/children")) return route.fulfill({ json: childList });
    if (request.method() === "POST" && /\/lessons(\/school|\/material)?$/.test(path)) {
      const body = request.postDataJSON() as Record<string, unknown>;
      api.creates.push({ path, body });
      await hold;
      const status = createStatus();
      if (status !== 202) return route.fulfill({ status, json: { code: "internal", message: "Błąd", retryable: true, requestId: "r" } });
      return route.fulfill({ status: 202, json: { runId: "00000000-0000-4000-8000-0000000000aa", deckId: body.deckId } });
    }
    // edytor lekcji po utworzeniu: odczyt nieistotny dla tego speca
    if (/\/lessons\/[0-9a-f-]+$/.test(path)) return route.fulfill({ status: 404, json: { code: "not_found", message: "Brak", retryable: false, requestId: "r" } });
    return route.fulfill({ json: [] });
  });
  await page.goto("/parent/lessons/new");
  await expect(page.getByTestId("lesson-subject")).toBeVisible();
  return api;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

test("telefon: formularz bez przewijania w poziomie, cele ≥ 44 px, pula podąża za regułami", async ({ page }) => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport);
    await openNewLesson(page);
    await expectNoHorizontalOverflow(page);
    // 6 reguł → 72; po odznaczeniu jednej → max(60, 60)
    await expect(page.getByTestId("lesson-pool-size")).toHaveValue("72");
    await page.getByTestId("lesson-objective-negation").setChecked(false);
    await expect(page.getByTestId("lesson-pool-size")).toHaveValue("60");
    await page.getByTestId("lesson-material").fill("He plays football every day.");
    for (const id of ["new-lesson-cancel", "lesson-subject", "lesson-topic", "lesson-material", "lesson-instruction", "lesson-pool-size", "lesson-create-submit"]) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.height, id).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width, id).toBeLessThanOrEqual(viewport.width + 0.5);
    }
    await expect(page.getByTestId("lesson-create-submit")).toBeEnabled();
    await expectNoHorizontalOverflow(page);
  }
});

test("tematy zdań: wstawienie zainteresowań dziecka trafia do polecenia, sekcja ukryta dla rozdziału i szkoły", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await openNewLesson(page, () => 202, Promise.resolve(), children);
  const themes = page.getByTestId("lesson-themes");
  await expect(themes).toBeVisible();
  await expect(themes).toContainText(messages.lessons.themesTitle);
  await expect(themes).toContainText(messages.lessons.themesService.replace("{service}", catalog.generationService));
  // przycisk tylko dla dziecka z zainteresowaniami; formularz nie wypełnia pola sam
  const insert = page.getByTestId(`lesson-themes-insert-${children[0]!.id}`);
  await expect(insert).toHaveText(messages.lessons.themesInsert.replace("{name}", "Ola"));
  await expect(page.getByTestId(`lesson-themes-insert-${children[1]!.id}`)).toHaveCount(0);
  await expect(themes.locator(".mantine-Pill-root")).toHaveCount(0);
  const box = (await insert.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  await expectNoHorizontalOverflow(page);

  await insert.click();
  await expect(themes.locator(".mantine-Pill-root")).toHaveText(["dinozaury", "Minecraft"]);
  await expect(insert).toBeDisabled();
  await expectNoHorizontalOverflow(page);
  // dopisanie własnego tematu (Enter dodaje wpis)
  await page.getByTestId("lesson-themes-input").fill("rowery");
  await page.getByTestId("lesson-themes-input").press("Enter");
  await expect(themes.locator(".mantine-Pill-root")).toHaveText(["dinozaury", "Minecraft", "rowery"]);

  await page.getByTestId("lesson-material").fill("He plays football every day.");
  await page.getByTestId("lesson-create-submit").click();
  await expect(page).toHaveURL(/\/parent\/decks\/[0-9a-f-]+$/);
  expect(api.creates).toHaveLength(1);
  expect(api.creates[0]!.path).toMatch(/\/lessons$/);
  expect(api.creates[0]!.body.interests).toEqual(["dinozaury", "Minecraft", "rowery"]);
});

test("tematy zdań: bez wpisanych tematów polecenie ich nie niesie; rozdział i szkoła nie pokazują sekcji", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await openNewLesson(page, () => 202, Promise.resolve(), children);
  await page.getByTestId("lesson-material").fill("He plays football every day.");
  await page.getByTestId("lesson-create-submit").click();
  await expect(page).toHaveURL(/\/parent\/decks\/[0-9a-f-]+$/);
  expect(api.creates[0]!.body).not.toHaveProperty("interests");

  await openNewLesson(page, () => 202, Promise.resolve(), children);
  await page.getByTestId(`lesson-themes-insert-${children[0]!.id}`).click();
  for (const subject of ["english_chapter", "school"]) {
    await page.getByTestId("lesson-subject").selectOption(subject);
    await expect(page.getByTestId("lesson-themes")).toHaveCount(0);
  }
  // powrót do gramatyki: wstawione tematy wracają, ale po zmianie przedmiotu nie były wysyłane
  await page.getByTestId("lesson-subject").selectOption("english_grammar");
  await expect(page.getByTestId("lesson-themes").locator(".mantine-Pill-root")).toHaveCount(2);
});

test("tematy zdań: bez dzieci z zainteresowaniami podpowiedź o profilu", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openNewLesson(page, () => 202, Promise.resolve(), [children[1]]);
  await expect(page.getByTestId("lesson-themes")).toContainText(messages.lessons.themesEmpty);
  await expect(page.locator("[data-testid^='lesson-themes-insert-']")).toHaveCount(0);
});

test("tematy zdań: po niepewnej odpowiedzi pole i przyciski są zablokowane, ponowienie wysyła te same tematy", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let status = 500;
  const api = await openNewLesson(page, () => status, Promise.resolve(), children);
  await page.getByTestId("lesson-material").fill("He plays football every day.");
  await page.getByTestId(`lesson-themes-insert-${children[0]!.id}`).click();
  await page.getByTestId("lesson-create-submit").click();
  await expect(page.getByTestId("api-error")).toContainText(messages.lessons.createUncertain);
  await expect(page.getByTestId("lesson-themes-input")).toBeDisabled();
  await expect(page.getByTestId(`lesson-themes-insert-${children[0]!.id}`)).toBeDisabled();
  status = 202;
  await page.getByTestId("lesson-create-submit").click();
  await expect(page).toHaveURL(/\/parent\/decks\/[0-9a-f-]+$/);
  expect(api.creates).toHaveLength(2);
  expect(api.creates[1]!.body.interests).toEqual(["dinozaury", "Minecraft"]);
  expect(api.creates[1]!.body.deckId).toBe(api.creates[0]!.body.deckId);
});

test("przedmiot szkolny: nazwy zamiast tematu i reguł, wysyłka na /lessons/school", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await openNewLesson(page);
  await page.getByTestId("lesson-subject").selectOption("school");
  await expect(page.getByTestId("lesson-topic")).toHaveCount(0);
  await expect(page.getByTestId("school-objectives-auto")).toBeVisible();
  await expect(page.getByTestId("lesson-material-counter")).toContainText("/16000");
  await page.getByTestId("lesson-material").fill("Mapa to obraz powierzchni Ziemi.");
  await expect(page.getByTestId("lesson-create-submit")).toBeDisabled();
  await page.getByTestId("school-subject-name").fill("Geografia");
  await page.getByTestId("school-topic-name").fill("Posługuję się mapą");
  await page.getByTestId("lesson-create-submit").click();
  await expect(page).toHaveURL(/\/parent\/decks\/[0-9a-f-]+$/);
  expect(api.creates).toHaveLength(1);
  expect(api.creates[0]!.path).toMatch(/\/lessons\/school$/);
  expect(api.creates[0]!.body).toMatchObject({ subjectTitlePl: "Geografia", topicTitlePl: "Posługuję się mapą", poolSize: 60 });
});

test("rozdział angielskiego: tytuł rozdziału zamiast nazwy przedmiotu i reguł, wysyłka na /lessons/material", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await openNewLesson(page);
  await page.getByTestId("lesson-subject").selectOption("english_chapter");
  await expect(page.getByTestId("lesson-topic")).toHaveCount(0);
  await expect(page.getByTestId("school-subject-name")).toHaveCount(0);
  await expect(page.getByTestId("school-objectives-auto")).toBeVisible();
  await expect(page.getByTestId("material-topic-name")).toBeVisible();
  await expect(page.getByTestId("material-hint")).toContainText(messages.lessons.chapterMaterialHint);
  await expect(page.getByTestId("lesson-material-counter")).toContainText("/16000");
  await expectNoHorizontalOverflow(page);
  await page.getByTestId("lesson-material").fill("I like pizza. What do you like?");
  await expect(page.getByTestId("lesson-create-submit")).toBeDisabled();
  await page.getByTestId("material-topic-name").fill("Unit 1");
  await page.getByTestId("lesson-create-submit").click();
  await expect(page).toHaveURL(/\/parent\/decks\/[0-9a-f-]+$/);
  expect(api.creates).toHaveLength(1);
  expect(api.creates[0]!.path).toMatch(/\/lessons\/material$/);
  expect(api.creates[0]!.body).toMatchObject({ subjectId: "english_chapter", topicTitlePl: "Unit 1", material: "I like pizza. What do you like?", poolSize: 60 });
  expect(api.creates[0]!.body).not.toHaveProperty("subjectTitlePl");
});

test("wpisany materiał chroni wyjście; utworzenie lekcji przechodzi do edytora bez pytania", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openNewLesson(page);
  await page.getByTestId("lesson-material").fill("He plays football every day.");
  await page.getByTestId("tab-children").click();
  await expect(page.getByTestId("leave-editor-dialog")).toBeVisible();
  await page.getByTestId("leave-editor-stay").click();
  await expect(page.getByTestId("lesson-material")).toHaveValue("He plays football every day.");

  await page.getByTestId("lesson-create-submit").click();
  await expect(page).toHaveURL(/\/parent\/decks\/[0-9a-f-]+$/);
  await expect(page.getByTestId("leave-editor-dialog")).toHaveCount(0);
});

test("w trakcie tworzenia lekcji wyjście jest zablokowane, po odpowiedzi otwiera się edytor", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let release!: () => void;
  const api = await openNewLesson(page, () => 202, new Promise<void>((resolve) => { release = resolve; }));
  await page.getByTestId("lesson-material").fill("He plays football every day.");
  await page.getByTestId("lesson-create-submit").click();
  await expect.poll(() => api.creates.length).toBe(1);
  // polecenie w drodze: zmiana sekcji nie wychodzi i nie pyta (jak zapis w edytorach)
  await page.getByTestId("tab-children").click();
  await expect(page.getByTestId("leave-editor-dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/parent\/lessons\/new$/);
  release();
  await expect(page).toHaveURL(/\/parent\/decks\/[0-9a-f-]+$/);
  await expect(page.getByTestId("leave-editor-dialog")).toHaveCount(0);
});

test("niepewna odpowiedź: ponowienie wysyła to samo polecenie", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let status = 500;
  const api = await openNewLesson(page, () => status);
  await page.getByTestId("lesson-material").fill("He plays football every day.");
  await page.getByTestId("lesson-create-submit").click();
  await expect(page.getByTestId("api-error")).toContainText(messages.lessons.createUncertain);
  await expect(page.getByTestId("lesson-create-submit")).toHaveText(messages.lessons.retryCreate);
  status = 202;
  await page.getByTestId("lesson-create-submit").click();
  await expect(page).toHaveURL(/\/parent\/decks\/[0-9a-f-]+$/);
  expect(api.creates).toHaveLength(2);
  expect(api.creates[1]!.body.deckId).toBe(api.creates[0]!.body.deckId);
  expect(api.creates[1]!.body.clientRequestId).toBe(api.creates[0]!.body.clientRequestId);
});

test("niepewna odpowiedź i zmiana przedmiotu: komunikat zostaje, ponowienie wysyła oczekujące polecenie (W15)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let status = 500;
  const api = await openNewLesson(page, () => status);
  await page.getByTestId("lesson-material").fill("He plays football every day.");
  await page.getByTestId("lesson-create-submit").click();
  await expect(page.getByTestId("api-error")).toContainText(messages.lessons.createUncertain);
  await page.getByTestId("lesson-subject").selectOption("school");
  await expect(page.getByTestId("api-error")).toContainText(messages.lessons.createUncertain);
  status = 202;
  await page.getByTestId("lesson-create-submit").click();
  await expect(page).toHaveURL(/\/parent\/decks\/[0-9a-f-]+$/);
  expect(api.creates).toHaveLength(2);
  expect(api.creates[1]!.path).toMatch(/\/lessons$/);
  expect(api.creates[1]!.body.deckId).toBe(api.creates[0]!.body.deckId);
});

test("tryb ciemny obejmuje formularz nowej lekcji", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await openNewLesson(page);
  await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "dark");
  const background = await page.getByTestId("lesson-material").evaluate((element) => getComputedStyle(element).backgroundColor);
  const [r, g, b] = background.match(/\d+/g)!.map(Number);
  expect(r! + g! + b!).toBeLessThan(3 * 80);
  // tekst pomocniczy jasny na ciemnym tle (kontrast)
  const counter = await page.getByTestId("lesson-material-counter").evaluate((element) => getComputedStyle(element).color);
  const [cr, cg, cb] = counter.match(/\d+/g)!.map(Number);
  expect(cr! + cg! + cb!).toBeGreaterThan(3 * 140);
});

/**
 * Przedmioty generowane agentem puli (spec etapu 2a §11): usługi generowania z katalogu przedmiotu,
 * drugi model rozwiązujący ćwiczenia (wariant z materiałem wg polityki checkera).
 */
const GEN = ["openrouter.ai · google/gemini-3.8-flash", "openrouter.ai · google/gemini-3.8-pro"];
const CHECK = "openrouter.ai · deepseek/deepseek-v4.1-flash-1017";
const agentCatalog = {
  ...catalog,
  subjects: catalog.subjects.map((subject) => subject.id === "english_chapter"
    ? subject
    : { ...subject, generationServices: GEN, checkService: CHECK, ...(subject.id === "school" ? { checkServiceIncludesMaterial: true } : {}) }),
};

test("przedmiot z agentem puli: usługi generowania i drugi model, bez przewijania w poziomie", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openNewLesson(page, () => 202, Promise.resolve(), children, agentCatalog);
  await expect(page.getByTestId("lesson-themes")).toContainText(messages.lessons.themesService.replace("{service}", GEN[0]!));
  await expect(page.getByTestId("lesson-generation-service")).toHaveText(messages.lessons.generationServicesInfo.replace("{service}", GEN.join(", ")));
  await expect(page.getByTestId("lesson-check-service")).toHaveText(messages.lessons.checkServiceInfo.replace("{service}", CHECK));
  await expectNoHorizontalOverflow(page);

  // szkoła: wariant z materiałem
  await page.getByTestId("lesson-subject").selectOption("school");
  await expect(page.getByTestId("lesson-check-service")).toHaveText(messages.lessons.checkServiceInfoWithMaterial.replace("{service}", CHECK));
  await expectNoHorizontalOverflow(page);

  // rozdział (potok): bez komunikatów agenta
  await page.getByTestId("lesson-subject").selectOption("english_chapter");
  await expect(page.getByTestId("lesson-check-service")).toHaveCount(0);
});
