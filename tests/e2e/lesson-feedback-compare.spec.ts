import { expect, test, type Locator, type Page } from "@playwright/test";
import type { AttemptDto, FeedbackDto, TaskDto } from "@learning/contracts";
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

interface Box { x: number; y: number; width: number; height: number }

async function boxOf(locator: Locator): Promise<Box> {
  const bounds = await locator.boundingBox();
  if (bounds === null) throw new Error("element has no layout box");
  return bounds;
}

async function open(page: Page, result: AttemptDto): Promise<void> {
  // Lektor zdania gra bez dźwięku: test mierzy tylko układ.
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function play() { return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function pause() {};
  });
  await installKidUiFixture(page, { ...lessonAudioFixture(ids, [gapTask]), attempts: [result] });
  await openLessonTask(page, "kid-lesson-gap");
  await page.getByTestId("kid-lesson-gap-input").fill("hauseboat");
  await page.getByTestId("kid-lesson-check").click();
  await expect(page.getByTestId("kid-feedback-dock")).toBeVisible();
}

/** Każde słowo odpowiedzi stoi w jednym wierszu (nie łamie się między literami). */
async function expectWordsUnbroken(page: Page, label: string): Promise<void> {
  const words = page.getByTestId("kid-feedback-dock").locator(".kid-lesson-word");
  const count = await words.count();
  expect(count, `words at ${label}`).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const word = words.nth(index);
    const { height, lineHeight } = await word.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(element).lineHeight) * (element.getBoundingClientRect().height / ((element as HTMLElement).offsetHeight || 1)),
    }));
    expect(height, `word "${await word.textContent()}" on one line at ${label}`).toBeLessThan(lineHeight * 1.5);
  }
}

async function expectNoPageOverflow(page: Page, label: string): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `page overflow at ${label}`).toBe(true);
}

const PHONES = [{ width: 412, height: 915 }, { width: 375, height: 812 }];
const OTHER_VIEWPORTS = [{ width: 320, height: 640 }, { width: 812, height: 375 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }];

test("short answer on a phone: buttons above the card, both answers visible without scrolling", async ({ page }) => {
  await open(page, shortAnswer);
  for (const viewport of PHONES) {
    await page.setViewportSize(viewport);
    const label = `${viewport.width}x${viewport.height}`;
    const dock = page.getByTestId("kid-feedback-dock");
    const sentence = await boxOf(dock.getByTestId("kid-sentence-audio"));
    const card = await boxOf(dock.getByTestId("kid-feedback"));
    expect(card.y, `card under the button row at ${label}`).toBeGreaterThanOrEqual(sentence.y + sentence.height - 1);

    const compare = dock.getByTestId("kid-lesson-compare");
    await expect(compare).toHaveAttribute("data-layout", "inline");
    // Karta mieści całą treść: nic do przewijania, a „Poprawnie” kończy się w jej obrębie.
    const scroller = dock.locator(".kid-feedback-content");
    const { scrollHeight, clientHeight } = await scroller.evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
    expect(scrollHeight, `card needs no scrolling at ${label}`).toBeLessThanOrEqual(clientHeight + 1);
    const correct = await boxOf(dock.getByTestId("kid-lesson-correct"));
    const visible = await boxOf(scroller);
    expect(correct.y + correct.height, `correct answer fully visible at ${label}`).toBeLessThanOrEqual(visible.y + visible.height + 1);

    await expectWordsUnbroken(page, label);
    await expect(dock.getByTestId("kid-lesson-answer-segments").getByTestId("kid-spelling-pill")).toHaveText(["a"]);
    await expect(dock.getByTestId("kid-lesson-correct").getByTestId("kid-spelling-pill")).toHaveText(["o"]);
    const next = await boxOf(page.getByTestId("kid-next"));
    expect(next.y + next.height, `next in the viewport at ${label}`).toBeLessThanOrEqual(viewport.height + 1);
    await expectNoPageOverflow(page, label);
  }
  // Szersze okna: słowo w jednym wierszu także obok przycisków (regresja „ho / useboat” na tablecie).
  for (const viewport of OTHER_VIEWPORTS) {
    await page.setViewportSize(viewport);
    const label = `${viewport.width}x${viewport.height}`;
    await expectWordsUnbroken(page, label);
    await expectNoPageOverflow(page, label);
  }
});

test("long answer wraps only between words on every form factor", async ({ page }) => {
  await open(page, longAnswer);
  await expect(page.getByTestId("kid-lesson-compare")).toHaveAttribute("data-layout", "stacked");
  for (const viewport of [...PHONES, ...OTHER_VIEWPORTS]) {
    await page.setViewportSize(viewport);
    const label = `${viewport.width}x${viewport.height}`;
    await expectWordsUnbroken(page, label);
    await expectNoPageOverflow(page, label);
    const next = page.getByTestId("kid-next");
    await next.scrollIntoViewIfNeeded();
    const nextBox = await boxOf(next);
    expect(nextBox.height, `next target at ${label}`).toBeGreaterThanOrEqual(48);
  }
});
