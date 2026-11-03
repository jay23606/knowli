import { expect, test, type Locator, type Page } from "@playwright/test";
import type { AttemptDto, FeedbackDto, TaskDto } from "@learning/contracts";
import { expectFrameFillsViewport, waitForKidScale } from "./helpers/kid-frame";
import { installKidUiFixture } from "./helpers/kid-ui-fixture";
import { lessonAudioFixture, openLessonTask } from "./helpers/lesson-audio";

/**
 * Panel wyniku lekcji na telefonie (makieta 2026-11-02, API zaślepione
 * w przeglądarce): przyciski zdania w osobnym wierszu nad kartą wyniku,
 * odpowiedź dziecka i poprawna odpowiedź łamią się tylko między słowami,
 * a przy krótkiej odpowiedzi obie są widoczne bez przewijania karty.
 * Symulacja okna nie zastępuje odbioru na fizycznym telefonie.
 */

const ids = {
  childId: "10000000-0000-4000-8000-000000000a01",
  deckId: "10000000-0000-4000-8000-000000000a02",
  sessionId: "10000000-0000-4000-8000-000000000a03",
  deckVersionId: "10000000-0000-4000-8000-000000000a04",
};
const sentenceAssetId = "10000000-0000-4000-8000-000000000a21";

const gapTask: TaskDto = {
  taskId: "10000000-0000-4000-8000-000000000a11", sessionId: ids.sessionId, ordinal: 1, exerciseType: "lesson_gap",
  direction: null, state: "issued", remainingAssessed: 2,
  prompt: { kind: "lesson_gap", instructionPl: "Mieszkam w domu na łodzi. Wpisz brakujące słowo.", stemWithGap: "I live in a ___." },
};

const attempt = (feedback: FeedbackDto): AttemptDto => ({
  attemptId: "10000000-0000-4000-8000-000000000a31", taskId: gapTask.taskId, state: "completed", modality: "text",
  taskState: "answered", stepId: "s1", receivedAt: "2026-11-02T10:00:01.000Z", completedAt: "2026-11-02T10:00:01.000Z",
  feedback,
});

/** Zrzut właściciela: błąd pisowni jednego słowa, lektor zdania i podpowiedź kategorii. */
const shortAnswer = attempt({
  kind: "lesson_hint",
  hintPl: "Sprawdź litery w tym słowie.",
  correctText: "houseboat",
  answerSegments: [{ text: "h", state: "plain" }, { text: "a", state: "pill" }, { text: "useboat", state: "plain" }],
  correctSegments: [{ text: "h", state: "plain" }, { text: "o", state: "pill" }, { text: "useboat", state: "plain" }],
  correctAudioAssetId: sentenceAssetId,
});

/** Tłumaczenie zdania z dwoma błędami: etykiety nad tekstem. */
const longAnswer = attempt({
  kind: "lesson_hint",
  hintPl: "Sprawdź litery w tym słowie.",
  correctText: "My grandad lives in a houseboat.",
  answerSegments: [
    { text: "My grandad ", state: "plain" }, { text: "live", state: "pill" }, { text: " in a h", state: "plain" },
    { text: "a", state: "pill" }, { text: "useboat.", state: "plain" },
  ],
  correctSegments: [
    { text: "My grandad live", state: "plain" }, { text: "s", state: "pill" }, { text: " in a h", state: "plain" },
    { text: "o", state: "pill" }, { text: "useboat.", state: "plain" },
  ],
  correctAudioAssetId: sentenceAssetId,
});

/** Słowo dłuższe niż mieści karta telefonu obok etykiety. */
const longWordAnswer = attempt({
  kind: "lesson_almost",
  correctText: "unfortunately",
  answerSegments: [{ text: "unfortunat", state: "plain" }, { text: "l", state: "pill" }, { text: "y", state: "plain" }],
  correctSegments: [{ text: "unfortunat", state: "plain" }, { text: "el", state: "pill" }, { text: "y", state: "plain" }],
});

/** Ciąg liter szerszy od całej karty (dziecko stuka w klawiaturę). */
const mashedAnswer = attempt({
  kind: "lesson_hint",
  hintPl: "Sprawdź litery w tym słowie.",
  correctText: "houseboat",
  answerSegments: [{ text: "hausebotasdfghjklqwertyuiopzxcv", state: "pill" }],
});

interface Box { x: number; y: number; width: number; height: number }

async function boxOf(locator: Locator): Promise<Box> {
  const bounds = await locator.boundingBox();
  if (bounds === null) throw new Error("element has no layout box");
  return bounds;
}

/**
 * Otwiera zadanie, ustawia okno i dopiero wtedy wysyła odpowiedź: panel wyniku
 * pojawia się od razu w docelowym rozmiarze (pierwsza klatka geometrii doku).
 */
async function open(page: Page, result: AttemptDto, viewport: Viewport): Promise<void> {
  // Lektor zdania gra bez dźwięku: test mierzy tylko układ.
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function play() { return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function pause() {};
  });
  await installKidUiFixture(page, { ...lessonAudioFixture(ids, [gapTask]), attempts: [result] });
  await openLessonTask(page, "kid-lesson-gap");
  await page.setViewportSize(viewport);
  await expectFrameFillsViewport(page, viewport);
  await page.getByTestId("kid-lesson-gap-input").fill("hauseboat");
  await page.getByTestId("kid-lesson-check").click();
  await expect(page.getByTestId("kid-feedback-dock")).toBeVisible();
  // Limit karty i rezerwę liczą ResizeObserver i rAF: dwie klatki na ustalenie.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** Każde słowo odpowiedzi stoi w jednym wierszu (nie łamie się między literami). */
async function expectWordsUnbroken(page: Page, label: string): Promise<void> {
  const words = page.getByTestId("kid-feedback-dock").locator(".kid-lesson-word");
  const count = await words.count();
  expect(count, `words at ${label}`).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const word = words.nth(index);
    // Prostokąt jest w px ekranu, a line-height w px wewnętrznych — mnożymy przez zoom elementu.
    const { height, lineHeight } = await word.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(element).lineHeight) * element.currentCSSZoom,
    }));
    expect(height, `word "${await word.textContent()}" on one line at ${label}`).toBeLessThan(lineHeight * 1.5);
  }
}

/** Nic nie wychodzi w poziomie: ani strona, ani przewijana karta wyniku, ani słowa poza kartę. */
async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `page overflow at ${label}`).toBe(true);
  const dock = page.getByTestId("kid-feedback-dock");
  const scroller = dock.locator(".kid-feedback-content");
  const { scrollWidth, clientWidth } = await scroller.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  expect(scrollWidth, `card scrolls sideways at ${label}`).toBeLessThanOrEqual(clientWidth + 1);
  const card = await boxOf(dock.getByTestId("kid-feedback"));
  const words = dock.locator(".kid-lesson-word");
  const count = await words.count();
  for (let index = 0; index < count; index += 1) {
    const word = await boxOf(words.nth(index));
    expect(word.x + word.width, `word ${index} inside the card at ${label}`).toBeLessThanOrEqual(card.x + card.width + 1);
  }
}

async function expectNextReachable(page: Page, label: string): Promise<void> {
  const next = page.getByTestId("kid-next");
  await next.scrollIntoViewIfNeeded();
  const nextBox = await boxOf(next);
  // „Dalej” to akcja główna: co najmniej 54 px.
  expect(nextBox.height, `next target at ${label}`).toBeGreaterThanOrEqual(54);
  const viewport = page.viewportSize()!;
  expect(nextBox.y + nextBox.height, `next in the viewport at ${label}`).toBeLessThanOrEqual(viewport.height + 1);
}

type Viewport = { width: number; height: number };
const PHONES: Viewport[] = [{ width: 412, height: 915 }, { width: 375, height: 812 }];
const OTHER_VIEWPORTS: Viewport[] = [{ width: 320, height: 640 }, { width: 812, height: 375 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }];
const label = (viewport: Viewport) => `${viewport.width}x${viewport.height}`;

for (const viewport of PHONES) {
  test(`short answer at ${label(viewport)}: buttons above the card, both answers visible without scrolling`, async ({ page }) => {
    await open(page, shortAnswer, viewport);
    const dock = page.getByTestId("kid-feedback-dock");
    const dockBox = await boxOf(dock);
    const sentence = await boxOf(dock.getByTestId("kid-sentence-audio"));
    const card = await boxOf(dock.getByTestId("kid-feedback"));
    expect(card.y, `card under the button row at ${label(viewport)}`).toBeGreaterThanOrEqual(sentence.y + sentence.height - 1);
    expect(card.x + card.width, `card inside the dock at ${label(viewport)}`).toBeLessThanOrEqual(dockBox.x + dockBox.width + 1);

    await expect(dock.getByTestId("kid-lesson-compare")).toHaveAttribute("data-layout", "inline");
    // Karta mieści całą treść: nic do przewijania, a „Poprawnie” kończy się w jej obrębie.
    const scroller = dock.locator(".kid-feedback-content");
    const { scrollHeight, clientHeight } = await scroller.evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
    expect(scrollHeight, `card needs no scrolling at ${label(viewport)}`).toBeLessThanOrEqual(clientHeight + 1);
    const correct = await boxOf(dock.getByTestId("kid-lesson-correct"));
    const visible = await boxOf(scroller);
    expect(correct.y + correct.height, `correct answer fully visible at ${label(viewport)}`).toBeLessThanOrEqual(visible.y + visible.height + 1);

    await expectWordsUnbroken(page, label(viewport));
    await expect(dock.getByTestId("kid-lesson-answer-segments").getByTestId("kid-spelling-pill")).toHaveText(["a"]);
    await expect(dock.getByTestId("kid-lesson-correct").getByTestId("kid-spelling-pill")).toHaveText(["o"]);
    await expectNextReachable(page, label(viewport));
    await expectNoHorizontalOverflow(page, label(viewport));
  });
}

// Szersze okna: słowo w jednym wierszu także obok przycisków (regresja „ho / useboat” na tablecie).
for (const viewport of OTHER_VIEWPORTS) {
  test(`short answer at ${label(viewport)}: words unbroken, nothing overflows`, async ({ page }) => {
    await open(page, shortAnswer, viewport);
    await expectWordsUnbroken(page, label(viewport));
    await expectNoHorizontalOverflow(page, label(viewport));
    await expectNextReachable(page, label(viewport));
  });
}

for (const viewport of [...PHONES, ...OTHER_VIEWPORTS]) {
  test(`long answer at ${label(viewport)}: wraps only between words`, async ({ page }) => {
    await open(page, longAnswer, viewport);
    await expect(page.getByTestId("kid-lesson-compare")).toHaveAttribute("data-layout", "stacked");
    await expectWordsUnbroken(page, label(viewport));
    await expectNoHorizontalOverflow(page, label(viewport));
    await expectNextReachable(page, label(viewport));
  });
}

test("a long single word stands under its label and stays inside the card at 320x640", async ({ page }) => {
  await open(page, longWordAnswer, { width: 320, height: 640 });
  await expect(page.getByTestId("kid-lesson-compare")).toHaveAttribute("data-layout", "stacked");
  await expectWordsUnbroken(page, "320x640 unfortunately");
  await expectNoHorizontalOverflow(page, "320x640 unfortunately");
});

test("a letter string wider than the card breaks inside instead of overflowing at 320x640", async ({ page }) => {
  await open(page, mashedAnswer, { width: 320, height: 640 });
  await expectNoHorizontalOverflow(page, "320x640 mashed");
  await expectNextReachable(page, "320x640 mashed");
});

test("short answer on a large mouse screen (scale 1.2): words unbroken, nothing overflows", async ({ page }) => {
  await open(page, shortAnswer, { width: 1512, height: 1080 });
  await waitForKidScale(page, 1.2);
  await expectWordsUnbroken(page, "1512x1080 scale 1.2");
  await expectNoHorizontalOverflow(page, "1512x1080 scale 1.2");
});
