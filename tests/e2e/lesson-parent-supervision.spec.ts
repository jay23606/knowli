import { expect, test, type Page } from "@playwright/test";
import { openNewMaterial } from "./helpers/parent-new-material";
import { randomUUID } from "node:crypto";
import { fillParentAuth } from "./helpers/parent-session";

/**
 * E2E nadzoru rodzica nad lekcją (zadanie 16). Rodzic tworzy i publikuje realną
 * lekcję (prawdziwy backend, fake providerzy) — to daje edytor z typowanym polem
 * `grading` (provider oceny). Punkty NADZORU (postęp celów, werdykty modelu,
 * decyzja, dodanie wariantu) są deterministycznie zaślepione na warstwie API
 * (`page.route`), bo wygenerowanie prawdziwego werdyktu modelu przez pełną sesję
 * dziecka jest niestabilne; logikę serwera pokrywają testy integracyjne
 * (`lesson-parent-supervision.test.ts`). Ten E2E dowodzi, że UI panelu renderuje
 * postęp i werdykt oraz poprawnie wysyła decyzję i „dodaj jako wariant".
 */

async function enterParent(page: Page): Promise<void> {
  await page.goto("/parent");
  await fillParentAuth(page);
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("tab-decks")).toBeVisible();
}

const VERDICT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OBJECTIVE_ID = "english_grammar.present_simple.third_person_s";

/** Zaślepia endpointy nadzoru (postęp, werdykty, decyzja, wariant) deterministycznie. */
async function stubSupervision(page: Page): Promise<{
  decisions: string[];
  variantCalls: number;
  firstProgressStarted: Promise<void>;
  firstProgressFinished: Promise<void>;
  releaseFirstProgress: () => void;
  delayedChildId: string | null;
  failProgressChildId: string | null;
}> {
  let resolveFirstProgressStarted!: () => void;
  let resolveFirstProgressFinished!: () => void;
  let releaseFirstProgress!: () => void;
  const firstProgressStarted = new Promise<void>((resolve) => { resolveFirstProgressStarted = resolve; });
  const firstProgressFinished = new Promise<void>((resolve) => { resolveFirstProgressFinished = resolve; });
  const firstProgressGate = new Promise<void>((resolve) => { releaseFirstProgress = resolve; });
  const state = {
    decisions: [] as string[],
    variantCalls: 0,
    decided: null as string | null,
    delayedChildId: null as string | null,
    failProgressChildId: null as string | null,
    firstProgressStarted,
    firstProgressFinished,
    releaseFirstProgress,
  };
  await page.route(/\/api\/v1\/parent\/lessons\/[0-9a-f-]+\/progress/, async (route) => {
    const childId = new URL(route.request().url()).searchParams.get("childId");
    const delayFirstRequest = state.delayedChildId === null;
    if (delayFirstRequest) {
      state.delayedChildId = childId;
      resolveFirstProgressStarted();
      await firstProgressGate;
    }
    if (childId === state.failProgressChildId) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "internal", message: "Postęp chwilowo niedostępny" }) });
    } else {
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify([{
        objectiveId: OBJECTIVE_ID, titlePl: "-s w 3. osobie", status: childId === state.delayedChildId ? "not_assessed" : "learning",
        lastIndependentAt: null, nextReviewAt: null, poolExhausted: true,
        topErrors: [{ category: "missing_ending", labelPl: "Brak końcówki -s", count: 2, examples: ["he play", "she go"] }],
        }]),
      });
    }
    if (delayFirstRequest) resolveFirstProgressFinished();
  });
  await page.route(/\/api\/v1\/parent\/lessons\/[0-9a-f-]+\/verdicts/, async (route) => {
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify([{
        id: VERDICT_ID, exerciseRevisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", objectiveId: OBJECTIVE_ID,
        childAnswer: "he play", verdict: "incorrect", errorCategory: "missing_ending", note: "brak -s",
        graderModel: "fake-grader", parentDecision: state.decided, createdAt: "2026-10-12T10:00:00.000Z",
      }]),
    });
  });
  await page.route(/\/api\/v1\/parent\/lesson-verdicts\/[0-9a-f-]+\/decision/, async (route) => {
    const body = route.request().postDataJSON() as { decision: string };
    state.decisions.push(body.decision);
    state.decided = body.decision;
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        id: VERDICT_ID, exerciseRevisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", objectiveId: OBJECTIVE_ID,
        childAnswer: "he play", verdict: "incorrect", errorCategory: "missing_ending", note: "brak -s",
        graderModel: "fake-grader", parentDecision: body.decision, createdAt: "2026-10-12T10:00:00.000Z",
      }),
    });
  });
  await page.route(/\/api\/v1\/parent\/lesson-verdicts\/[0-9a-f-]+\/accept-as-variant/, async (route) => {
    state.variantCalls += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deckVersionId: "x", added: true }) });
  });
  return state;
}

/** Tworzy, przegląda i PUBLIKUJE lekcję; zwraca deckId. */
async function createAndPublishLesson(page: Page, title: string): Promise<string> {
  await page.getByTestId("tab-decks").click();
  await openNewMaterial(page, "lesson");
  await expect(page.getByTestId("new-lesson-form")).toBeVisible();
  const objectiveCheckboxes = page.locator('[data-testid^="lesson-objective-"]');
  await expect(objectiveCheckboxes.first()).toBeVisible();
  const objectiveCount = await objectiveCheckboxes.count();
  for (let i = 0; i < objectiveCount; i++) await objectiveCheckboxes.nth(i).setChecked(i === 0);
  await page.getByTestId("lesson-material").fill(
    `Materiał ${title}. He plays football every day. She watches television in the evening. They study English daily.`,
  );
  await page.getByTestId("lesson-pool-size").fill("20");
  const created = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/v1/parent/lessons"));
  await page.getByTestId("lesson-create-submit").click();
  const deck = (await (await created).json()) as { deckId: string };
  await expect(page.getByTestId("lesson-editor")).toBeVisible();
  await expect(page.getByTestId("generation-banner")).toBeHidden({ timeout: 120_000 });
  await expect(page.locator('[data-testid^="exercise-"]').first()).toBeVisible({ timeout: 120_000 });
  await page.getByTestId("editor-title").fill(title);
  await page.getByTestId("save-lesson").click();
  await expect(page.getByTestId("editor-title")).toHaveValue(title);
  await expect(page.locator('[data-testid^="exercise-audio-state-"]')).toHaveCount(0);
  await expect(page.getByTestId("publish-lesson")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("publish-lesson").click();
  await expect(page.getByTestId("publish-status")).toBeVisible({ timeout: 120_000 });
  return deck.deckId;
}

test("parent supervises objective progress and model verdicts: changes a decision and adds a variant", async ({ page }) => {
  const suffix = randomUUID().slice(0, 8);
  const lessonTitle = `Nadzór Present Simple ${suffix}`;

  await enterParent(page);
  // Dziecko (panel nadzoru wymaga wybranego dziecka do postępu celów).
  await page.getByTestId("tab-children").click();
  await page.getByTestId("child-name").fill(`Nadzór dziecko ${suffix}`);
  await page.getByTestId("child-add").click();
  await expect(page.locator('[data-testid^="child-row-"]').filter({ hasText: `Nadzór dziecko ${suffix}` })).toHaveCount(1);
  await page.getByTestId("child-name").fill(`Drugie dziecko ${suffix}`);
  await page.getByTestId("child-add").click();
  await expect(page.locator('[data-testid^="child-row-"]').filter({ hasText: `Drugie dziecko ${suffix}` })).toHaveCount(1);

  const supervision = await stubSupervision(page);

  await createAndPublishLesson(page, lessonTitle);

  // Panel nadzoru widoczny po publikacji; provider oceny i postęp celu.
  await page.getByTestId("lesson-tab-children").click();
  await expect(page.getByTestId("supervision-panel")).toBeVisible();
  await expect(page.getByTestId("grading-provider")).toBeVisible();
  // Opóźnij odpowiedź domyślnego dziecka, wybierz drugie i upewnij się,
  // że starszy request nie nadpisze aktualnie wybranego postępu.
  await supervision.firstProgressStarted;
  const childSelect = page.getByTestId("supervision-child");
  const selectedChildId = await childSelect.locator("option").nth(1).getAttribute("value");
  expect(selectedChildId).toBeTruthy();
  const selectedProgressResponse = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname.endsWith("/progress") && new URL(response.url()).searchParams.get("childId") === selectedChildId,
  );
  await childSelect.selectOption(selectedChildId!);
  expect((await selectedProgressResponse).ok()).toBe(true);
  const delayedChildId = supervision.delayedChildId;
  expect(delayedChildId).toBeTruthy();
  await expect(page.getByTestId(`progress-status-${OBJECTIVE_ID}`)).toHaveText("W nauce");
  supervision.releaseFirstProgress();
  await supervision.firstProgressFinished;
  await expect(page.getByTestId(`progress-${OBJECTIVE_ID}`)).toBeVisible();
  await expect(page.getByTestId(`progress-status-${OBJECTIVE_ID}`)).toHaveText("W nauce");
  // Kategoria błędu z przykładami i podpowiedź o wyczerpanej puli.
  await expect(page.getByTestId(`error-${OBJECTIVE_ID}-missing_ending`)).toContainText("Brak końcówki -s");
  await expect(page.getByTestId(`error-${OBJECTIVE_ID}-missing_ending`)).toContainText("he play");
  await expect(page.getByTestId(`pool-exhausted-${OBJECTIVE_ID}`)).toBeVisible();

  // Werdykt modelu z akcjami.
  await expect(page.getByTestId(`verdict-${VERDICT_ID}`)).toContainText("he play");
  await expect(page.getByTestId(`verdict-value-${VERDICT_ID}`)).toHaveText("Błędna");

  // Zmiana decyzji: „Uznaj za poprawne" → oznaczenie werdyktu zmienionego.
  await page.getByTestId(`verdict-correct-${VERDICT_ID}`).click();
  await expect(page.getByTestId(`verdict-changed-${VERDICT_ID}`)).toBeVisible();
  expect(supervision.decisions).toContain("overridden_correct");

  // Dodanie wariantu → komunikat potwierdzenia i wywołanie endpointu.
  await page.getByTestId(`verdict-variant-${VERDICT_ID}`).click();
  await expect(page.getByTestId("supervision-notice")).toBeVisible();
  expect(supervision.variantCalls).toBeGreaterThan(0);

  const delayedChildResponse = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname.endsWith("/progress") && new URL(response.url()).searchParams.get("childId") === delayedChildId,
  );
  await childSelect.selectOption(delayedChildId!);
  expect((await delayedChildResponse).ok()).toBe(true);
  await expect(page.getByTestId(`progress-status-${OBJECTIVE_ID}`)).toHaveText("Nieoceniony");

  supervision.failProgressChildId = selectedChildId!;
  const unavailableProgressResponse = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname.endsWith("/progress") && new URL(response.url()).searchParams.get("childId") === selectedChildId,
  );
  await childSelect.selectOption(selectedChildId!);
  expect((await unavailableProgressResponse).status()).toBe(503);
  await expect(page.getByTestId(`progress-status-${OBJECTIVE_ID}`)).toHaveCount(0);
  // odczyt 5xx ponawiany dwukrotnie (globalny klient zapytań) — błąd po kilku sekundach
  await expect(page.getByTestId("supervision-progress-error")).toBeVisible({ timeout: 15_000 });
});
