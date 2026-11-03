import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { FeedbackDto, TaskDto } from "@learning/contracts";
import {
  clozeTask, clozeUid, completedRecallFixture, completedTextChoiceFixture, letterTask, lessonCardFixture, longClozeTask,
  longSpellingHintFeedback, makeDeck, mediumSpellingHintFeedback, openDeckScreen, overflowingRecallFixture, recallFixture, sessionId, taskFor,
} from "./helpers/kid-fixtures";
import {
  boxes, dockRevealCalls, emulatePinchZoom, expectFrameFillsViewport, expectInteractiveTargets, expectRectsUnchanged, installDockOverlapProbe,
  installDockRevealSpy, lineLengths, nextFrames, pictureTileLimit, pictureTiles, readDockOverlapProbe, settledDockReserve, VISUAL_CHOICE_MAX,
  waitForKidScale,
} from "./helpers/kid-frame";
import { measure, resizeAndSettle, type Viewport } from "./helpers/kid-layout";
import { lessonAudioFixture } from "./helpers/lesson-audio";
import { assignmentAttempt, lessonTaskFixture, openLessonTask } from "./helpers/lesson-assignment-task";
import { installKidUiFixture, type KidUiFixture } from "./helpers/kid-ui-fixture";
import { fourPictureTilesFixture, openPictureChoice, wrongThenCorrectAttempts } from "./helpers/picture-fixtures";

// The screenshot tests at the end (describe "screenshots") are skipped unless UMIEM_E2E_SCREENSHOTS is set. They attach
// PNGs as test attachments (body, not a file path). The list and github reporters do not save body attachments; to
// get the PNGs run
// `UMIEM_E2E_SCREENSHOTS=1 corepack pnpm exec playwright test tests/e2e/kid-large-screen.spec.ts --reporter=html`
// (or `--reporter=json`).

// A stuck click or navigation fails fast instead of waiting for the whole test timeout.
test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

// Large windows zoom the whole Kid UI by min(width / 840, height / 900), capped at 1.6 and rounded
// down to 0.01 (spec 2026-10-30-kid-ui-large-screens §3.4). Expected scales are written out on purpose.
const SESSION_WINDOWS = [
  { width: 1280, height: 600, scale: 1 },
  { width: 1536, height: 730, scale: 1 },
  { width: 1920, height: 1080, scale: 1.2 },
  { width: 1146, height: 1300, scale: 1.36 },
  { width: 3440, height: 1300, scale: 1.44 },
  { width: 3440, height: 1440, scale: 1.6 },
] as const;

const ULTRAWIDE = { width: 3440, height: 1440 };
const LAPTOP = { width: 1536, height: 730 };
const SMALL_LAPTOP = { width: 1280, height: 600 };
const PHONE = { width: 390, height: 750 };

// --kid-column-max-width from expanded width on (spec §3.1): 720 px in inner pixels. The tile cap (300 px) is VISUAL_CHOICE_MAX.
const COLUMN_MAX = 720;

/** Opens the first task of a single-profile, single-deck session. */
async function openSession(page: Page, fixture: KidUiFixture) {
  await installKidUiFixture(page, fixture);
  await page.goto("/");
  await page.getByTestId("kid-profile").click();
  await page.getByTestId("kid-deck").click();
}

async function openWrittenRecall(page: Page, fixture: KidUiFixture = completedRecallFixture()) {
  await openSession(page, fixture);
  await expect(page.getByTestId("kid-input")).toBeVisible();
}

/** Document scroll size against the window: zoom must not make the page wider or taller than the screen. */
async function documentOverflow(page: Page) {
  return page.evaluate(() => ({
    width: document.documentElement.scrollWidth - window.innerWidth,
    height: document.documentElement.scrollHeight - window.innerHeight,
  }));
}

async function expectSessionFitsWindow(page: Page, viewport: Viewport) {
  const name = `${viewport.width}x${viewport.height}`;
  await expectFrameFillsViewport(page, viewport);
  const overflow = await documentOverflow(page);
  expect(overflow.width, `horizontal overflow: ${name}`).toBeLessThanOrEqual(0);
  expect(overflow.height, `vertical overflow: ${name}`).toBeLessThanOrEqual(0);
}

for (const { width, height, scale } of SESSION_WINDOWS) {
  test(`session at ${width}x${height} uses scale ${scale} and fills the window`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openPictureChoice(page);
    await waitForKidScale(page, scale);
    await expectSessionFitsWindow(page, { width, height });
  });
}

test("rescales on resize", async ({ page }) => {
  await page.setViewportSize(ULTRAWIDE);
  await openPictureChoice(page);
  await waitForKidScale(page, 1.6);
  await expectSessionFitsWindow(page, ULTRAWIDE);

  const fullHd = { width: 1920, height: 1080 };
  await resizeAndSettle(page, fullHd);
  await waitForKidScale(page, 1.2);
  await expectSessionFitsWindow(page, fullHd);

  // Back to scale 1: KidPage drops the inline zoom and --kid-zoom instead of leaving a stale 1.2.
  const laptop = { width: 1280, height: 800 };
  await resizeAndSettle(page, laptop);
  await waitForKidScale(page, 1);
  await expect.poll(() => page.locator(".kid-page").evaluate((element) => ({
    zoom: (element as HTMLElement).style.zoom,
    kidZoom: (element as HTMLElement).style.getPropertyValue("--kid-zoom"),
  })), { message: "inline zoom and --kid-zoom are gone at scale 1" }).toEqual({ zoom: "", kidZoom: "" });
  await expectFrameFillsViewport(page, laptop);
});

test("short flow screens do not scroll", async ({ page }) => {
  const fixture: KidUiFixture = {
    ...completedRecallFixture(),
    summary: { sessionId, state: "completed", tasksIssued: 1, assessedTasksIssued: 1, endedAt: "2026-10-11T10:01:00.000Z",
      independentSuccesses: { recall: 1, spelling: 0 }, practiceItems: [] },
  };
  await installKidUiFixture(page, fixture);
  await page.setViewportSize(ULTRAWIDE);
  await page.goto("/");

  const expectFlowFitsWindow = async (name: string) => {
    await waitForKidScale(page, 1.6);
    // Window-unit tokens divide by --kid-zoom, so min-height 100dvh stays one screen tall under zoom.
    await expect.poll(async () => {
      const layout = await measure(page, { page: ".kid-page" });
      const overflow = await documentOverflow(page);
      const deviation = Math.max(Math.abs(layout.page.left), Math.abs(layout.page.top),
        Math.abs(layout.page.width - ULTRAWIDE.width), Math.abs(layout.page.height - ULTRAWIDE.height));
      return overflow.width <= 0 && overflow.height <= 1 && deviation <= 1 ? "ok" : JSON.stringify({ page: layout.page, overflow });
    }, { message: `${name} fits the window without scrolling` }).toBe("ok");
  };

  await expect(page.getByTestId("kid-profile")).toHaveCount(1);
  await expectFlowFitsWindow("profile screen");

  await page.getByTestId("kid-profile").click();
  await expect(page.getByTestId("kid-deck-screen")).toBeVisible();
  await expectFlowFitsWindow("deck screen");

  await page.getByTestId("kid-deck").click();
  await expect(page.getByTestId("kid-input")).toBeVisible();
  await page.getByTestId("kid-end").click();
  await expect(page.getByTestId("kid-end-confirm")).toBeVisible();
  await page.getByTestId("kid-end-confirm-end").click();
  await expect(page.getByTestId("kid-summary")).toBeVisible();
  await expectFlowFitsWindow("summary");
});

// Spec §1: on a 34" monitor (maximised window and full screen) the typed answer is about 34–39 px on screen.
const ANSWER_TEXT_SCREEN_PX = { min: 34, max: 39 };

for (const { width, height, scale } of SESSION_WINDOWS.filter(({ width }) => width === ULTRAWIDE.width)) {
  test(`answer text scales at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openWrittenRecall(page);
    await page.getByTestId("kid-input").fill("cat");
    await waitForKidScale(page, scale);
    const text = await page.getByTestId("kid-input").evaluate((element: HTMLElement) => ({
      // A rectangle is in screen pixels and offsetHeight in inner pixels: their ratio is the zoom applied to the field.
      ratio: element.getBoundingClientRect().height / element.offsetHeight,
      // The computed font size is an inner length; the zoom of the field multiplies it on screen.
      fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
      zoom: element.currentCSSZoom,
    }));
    const details = JSON.stringify(text);
    expect(Math.abs(text.ratio - scale), `the field is drawn at the scale: ${details}`).toBeLessThanOrEqual(0.01);
    const screenSize = text.fontSize * text.zoom;
    expect(screenSize, `answer text on screen: ${details}`).toBeGreaterThanOrEqual(ANSWER_TEXT_SCREEN_PX.min);
    expect(screenSize, `answer text on screen: ${details}`).toBeLessThanOrEqual(ANSWER_TEXT_SCREEN_PX.max);
  });
}

test("targets stay large", async ({ page }) => {
  await page.setViewportSize(ULTRAWIDE);
  await openWrittenRecall(page);
  await page.getByTestId("kid-input").fill("cat");
  await waitForKidScale(page, 1.6);
  await expectInteractiveTargets(page, [
    "[data-testid='kid-input']",
    "[data-testid='kid-submit']",
    "[data-testid='kid-not-remember']",
    "[data-testid='kid-end']",
  ]);
  const submit = await page.getByTestId("kid-submit").boundingBox();
  expect(submit!.height, "primary action height").toBeGreaterThanOrEqual(54);
});

test("end-session sheet", async ({ page }) => {
  await page.setViewportSize(ULTRAWIDE);
  await openWrittenRecall(page);
  await waitForKidScale(page, 1.6);
  await page.getByTestId("kid-end").click();
  await expect(page.getByTestId("kid-end-confirm")).toBeVisible();
  const layout = await measure(page, {
    scrim: "[data-testid='kid-end-confirm-scrim']",
    sheet: "[data-testid='kid-end-confirm']",
  });
  expect(Math.abs(layout.scrim.left), "scrim left").toBeLessThanOrEqual(1);
  expect(Math.abs(layout.scrim.top), "scrim top").toBeLessThanOrEqual(1);
  expect(Math.abs(layout.scrim.width - ULTRAWIDE.width), "scrim width").toBeLessThanOrEqual(1);
  expect(Math.abs(layout.scrim.height - ULTRAWIDE.height), "scrim height").toBeLessThanOrEqual(1);
  // The sheet takes the 720 px column token (inner pixels), i.e. 720 x 1.6 on screen.
  expect(layout.sheet.width, "sheet width").toBeLessThanOrEqual(COLUMN_MAX * 1.6 + 1);
  expect(layout.sheet.width, "sheet is a full column").toBeGreaterThanOrEqual(COLUMN_MAX * 1.6 - 1);
  expect(Math.abs((layout.sheet.left + layout.sheet.right) / 2 - ULTRAWIDE.width / 2), "sheet centred").toBeLessThanOrEqual(1);
  expect(layout.scrollWidth, "horizontal overflow").toBeLessThanOrEqual(layout.innerWidth);
});

/** Waits for the column (a screen rectangle) to have the expected width and sit in the middle of the window (± 1 px). */
async function expectColumn(page: Page, selector: string, name: string, expectedWidth: number) {
  await expect.poll(async () => {
    const { column, innerWidth } = await measure(page, { column: selector });
    const centred = Math.abs((column.left + column.right) / 2 - innerWidth / 2) <= 1;
    return Math.abs(column.width - expectedWidth) <= 1 && centred ? "ok" : JSON.stringify({ column, innerWidth, expectedWidth });
  }, { message: `column ${selector} at ${name} is ${expectedWidth}px wide and centred` }).toBe("ok");
}

// The column is 560 px below expanded width or on a low window (a phone in landscape, a tablet in portrait),
// 720 px from 840 x 480 on; on a narrow phone it is the whole window.
const COLUMN_CONTROL_WINDOWS = [
  { width: 844, height: 390, column: 560 },
  { width: 768, height: 1024, column: 560 },
] as const;

for (const [name, selector, open] of [
  ["session", ".kid-learning", (page: Page) => openWrittenRecall(page)],
  ["flow screen", "[data-kid-screen='true']", (page: Page) => openDeckScreen(page, [makeDeck(0)])],
] as const) {
  test(`${name} column width follows the token`, async ({ page }) => {
    await page.setViewportSize(SESSION_WINDOWS[0]);
    await open(page);
    for (const { width, height, scale } of SESSION_WINDOWS) {
      await resizeAndSettle(page, { width, height });
      await waitForKidScale(page, scale);
      await expectColumn(page, selector, `${width}x${height}`, COLUMN_MAX * scale);
    }
    for (const { width, height, column } of COLUMN_CONTROL_WINDOWS) {
      await resizeAndSettle(page, { width, height });
      await waitForKidScale(page, 1);
      await expectColumn(page, selector, `${width}x${height}`, column);
    }
    await resizeAndSettle(page, { width: 390, height: 750 });
    await waitForKidScale(page, 1);
    const phone = await measure(page, { column: selector });
    // The whole window width: the 16 px margins are padding inside the column.
    expect(phone.column.width, "phone column fills the window").toBeGreaterThanOrEqual(390 - 1);
    expect(phone.column.width, "phone column stays in the window").toBeLessThanOrEqual(390 + 1);
  });
}

test.describe("touch tablet in landscape", () => {
  // A touch tablet never scales (no fine pointer) but is wide enough for the 720 px column.
  test.use({ viewport: { width: 1366, height: 1024 }, isMobile: true, hasTouch: true });

  test("session column is 720 px at scale 1", async ({ page }) => {
    await openWrittenRecall(page);
    await waitForKidScale(page, 1);
    await expectColumn(page, ".kid-learning", "1366x1024 touch", COLUMN_MAX);
  });

  test("flow screen column is 720 px at scale 1", async ({ page }) => {
    await openDeckScreen(page, [makeDeck(0)]);
    await waitForKidScale(page, 1);
    await expectColumn(page, "[data-kid-screen='true']", "1366x1024 touch", COLUMN_MAX);
  });

  // The on-screen keyboard (interactiveWidget: resizes-content) lowers the window below 781 px; from 960 x 480 a coarse
  // pointer keeps the compact frame (spec 2026-10-31 §3.5), so the field does not jump while the child types, and a
  // touch screen gets no top offset (§3.4). Under 700 px the session's top padding shrinks by 8 px (styles.css), so the
  // positions are taken against the exercise frame, not the window.
  test("compact frame keeps its layout while the keyboard is open", async ({ page }) => {
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "a touch screen").toBe(true);
    const keyboardOpen = { width: 1366, height: 600 };
    const form = { instruction: "[data-testid='kid-instruction']", input: "[data-testid='kid-input']", submit: "[data-testid='kid-submit']" };
    await openWrittenRecall(page);
    await waitForKidScale(page, 1);
    const input = page.getByTestId("kid-input");
    await input.fill("cat");
    await input.focus();
    await page.evaluate(async () => { await document.fonts.ready; });
    const closed = await topsInFrame(page, form);
    expect(Math.abs(closed.instruction), `no space above the instruction: ${JSON.stringify(closed)}`).toBeLessThanOrEqual(1);

    await resizeAndSettle(page, keyboardOpen);
    await expect(input).toBeFocused();
    const typing = await topsInFrame(page, form);
    for (const key of Object.keys(form) as (keyof typeof form)[]) {
      expect(Math.abs(typing[key] - closed[key]), `${key} keeps its place in the frame: ${JSON.stringify({ closed, typing })}`)
        .toBeLessThanOrEqual(1);
    }

    // A shorter tablet window is compact too: the footer right under the content (track gap 8 + content padding 4).
    await resizeAndSettle(page, { width: 1280, height: 720 });
    const gap = await footerBelowContent(page);
    expect(gap, "footer below the content at 1280x720").toBeGreaterThanOrEqual(-1);
    expect(gap, "footer right under the content at 1280x720").toBeLessThanOrEqual(8 + 4 + 1);

    await resizeAndSettle(page, keyboardOpen);
    const field = await boxes(page, "[data-testid='kid-input']");
    await page.getByTestId("kid-submit").click();
    await expect(page.getByTestId("kid-feedback-dock")).toBeVisible();
    await settledDockReserve(page);
    await expectDockCorners(page, "rounded");
    expectRectsUnchanged(field, await boxes(page, "[data-testid='kid-input']"), "field after the verdict with the keyboard open");

    // Each touch threshold on its own keeps the regular frame, where the panel is a bottom sheet: a phone in landscape,
    // a window narrower than 960 px (900 x 600) and one lower than 480 px (1366 x 470: very short, the session
    // scrolls as a page).
    const sessionFrame = page.getByTestId("kid-session-frame");
    for (const viewport of [{ width: 844, height: 390 }, { width: 900, height: 600 }, { width: 1366, height: 470 }]) {
      await resizeAndSettle(page, viewport);
      if (viewport.height < 480) await expect(sessionFrame).toHaveAttribute("data-viewport-very-short", "true");
      else await expect(sessionFrame).not.toHaveAttribute("data-viewport-very-short");
      await expectDockCorners(page, "sheet");
    }
  });
});

test.describe("touch device with the on-screen keyboard open", () => {
  // The keyboard (interactiveWidget: resizes-content) leaves a landscape tablet a window under 480 px high. From 960 px
  // wide the column keeps 720 px whatever the height (spec §3.1); a phone in landscape (at most 932 px wide) keeps 560.
  test.use({ viewport: { width: 1024, height: 420 }, isMobile: true, hasTouch: true });

  test("a landscape tablet keeps the 720 px column, a landscape phone keeps 560 px", async ({ page }) => {
    await openWrittenRecall(page);
    await waitForKidScale(page, 1);
    await expectColumn(page, ".kid-learning", "1024x420 touch", COLUMN_MAX);

    await resizeAndSettle(page, { width: 844, height: 390 });
    await waitForKidScale(page, 1);
    await expectColumn(page, ".kid-learning", "844x390 touch", 560);
  });
});

for (const { width, height, scale } of [{ width: 1920, height: 1080, scale: 1.2 }, { width: 3440, height: 1440, scale: 1.6 }]) {
  test(`picture tiles use the new cap and keep their size after the verdict at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openPictureChoice(page, fourPictureTilesFixture());
    await waitForKidScale(page, scale);
    await expect(page.getByTestId("kid-option")).toHaveCount(4);
    // Let the grid settle (fonts, first layout pass) before reading the tile size.
    await page.evaluate(async () => { await document.fonts.ready; });

    const before = await pictureTiles(page, { settle: true });
    // --visual-choice-size: the cap, half the material width, or the material height shared by two rows (never below 112).
    const { limit } = pictureTileLimit(before.container);
    if (width === ULTRAWIDE.width) {
      // The material is wide here, but the footer reserve for the result panel (spec 2026-10-31 §3.1) makes its height
      // decide: about 295 px, a few px under the 300 cap, because tiles that keep their size at the verdict win over the
      // cap. They stay well above the old 260 px cap: 290 x 1.6 = 464, not 260 x 1.6 = 416.
      expect(limit, `material allows nearly the full cap: ${JSON.stringify(before.container)}`).toBeGreaterThanOrEqual(290);
      expect(limit, `tiles stay under the cap: ${JSON.stringify(before.container)}`).toBeLessThanOrEqual(VISUAL_CHOICE_MAX);
    }
    for (const [index, tile] of before.tiles.entries()) {
      expect(Math.abs(tile.width - limit * scale), `tile ${index} width: ${JSON.stringify({ tile, limit, scale })}`).toBeLessThanOrEqual(2);
      expect(Math.abs(tile.height - limit * scale), `tile ${index} height: ${JSON.stringify({ tile, limit, scale })}`).toBeLessThanOrEqual(2);
    }

    await page.getByTestId("kid-option").first().click();
    await expect(page.getByTestId("kid-outcome-correct")).toBeVisible();
    await expect(page.getByTestId("kid-next")).toBeVisible();
    await nextFrames(page);

    const after = await pictureTiles(page);
    expectRectsUnchanged(before.tiles, after.tiles, "picture tile after the verdict");
  });
}

// Picture choice reserves the height of the result panel in its footer from the start (spec 2026-10-31 §3.1), so a verdict
// does not shorten the material row and the tiles keep their size and place through a wrong verdict, a retry and a
// right verdict. `bound`: the material height limits the tiles after the wrong verdict (otherwise the width or the cap
// decides, and a panel cannot shrink them); that is where the panel used to shrink them. The audio notice takes ~87 inner px
// of the material. 3440x1440 without the notice keeps constant tiles over the 300 cap (`minTile`: but not under 290 px).
// 768x600 has the reserve too (from 600 px wide) in the 560 px column, below the expanded width. 844x390 is a very short
// window: no reserve, the empty footer is hidden.
interface PictureVerdictWindow {
  viewport: Viewport; scale: number; bound: boolean; notice?: boolean; minTile?: number; rootFont?: string; veryShort?: boolean;
}
const PICTURE_VERDICT_WINDOWS: PictureVerdictWindow[] = [
  { viewport: LAPTOP, scale: 1, bound: true },
  { viewport: SMALL_LAPTOP, scale: 1, bound: true },
  { viewport: ULTRAWIDE, scale: 1.6, bound: true, notice: true },
  { viewport: ULTRAWIDE, scale: 1.6, bound: true, minTile: 290 },
  { viewport: PHONE, scale: 1, bound: false },
  { viewport: LAPTOP, scale: 1, bound: true, rootFont: "125%" },
  { viewport: { width: 768, height: 600 }, scale: 1, bound: true },
  { viewport: { width: 844, height: 390 }, scale: 1, bound: false, veryShort: true },
];

for (const { viewport, scale, bound, notice = false, minTile = 0, rootFont, veryShort = false } of PICTURE_VERDICT_WINDOWS) {
  const label = `${viewport.width}x${viewport.height}${notice ? " with the audio notice" : ""}${rootFont ? ` at ${rootFont} root font` : ""}`;

  test(`picture tiles keep their size and place through every verdict at ${label}`, async ({ page }) => {
    const fixture = fourPictureTilesFixture();
    fixture.attempts = wrongThenCorrectAttempts(fixture, "Kolor 1");
    await page.setViewportSize(viewport);
    // No `uiAudio` in the fixture: the media stub answers the instruction recording with an SVG, which cannot be decoded,
    // so it fails and the notice appears (the silent WAV stub of `openPictureChoice` keeps it away).
    await openPictureChoice(page, fixture, { stubInstructionAudio: !notice });
    if (rootFont) await page.addStyleTag({ content: `html { font-size: ${rootFont}; }` });
    await expect(page.getByTestId("kid-option")).toHaveCount(4);
    await waitForKidScale(page, scale);
    await page.evaluate(async () => { await document.fonts.ready; });
    await expect(page.getByTestId("kid-task-audio-error")).toHaveCount(notice ? 1 : 0);
    await nextFrames(page);

    if (veryShort) {
      const footer = await page.getByTestId("kid-exercise-actions").evaluate((element) =>
        ({ height: element.getBoundingClientRect().height, display: getComputedStyle(element).display }));
      expect(footer.height === 0 || footer.display === "none", `the empty footer takes no room: ${JSON.stringify(footer)}`).toBe(true);
      expect((await documentOverflow(page)).width, "no horizontal overflow").toBeLessThanOrEqual(0);
      return;
    }

    const dock = page.getByTestId("kid-feedback-dock");
    const before = await pictureTiles(page, { settle: true });
    await page.getByTestId("kid-option").first().click();
    // Every panel has the voice hint button (48 px), which is part of what the footer reserve is made of.
    await expect(dock.getByTestId("kid-guidance-play")).toBeVisible();
    await nextFrames(page);
    const afterIncorrect = await pictureTiles(page);
    if (bound) {
      // Without this the equality below proves nothing: tiles that the width decides cannot be shrunk by the panel.
      expect(pictureTileLimit(afterIncorrect.container).heightBound, `tiles bound by the height: ${JSON.stringify(afterIncorrect.container)}`).toBe(true);
    }

    await dock.getByTestId("kid-next").click();
    await expect(dock).toHaveCount(0);
    await nextFrames(page);
    const afterRetry = await pictureTiles(page);

    await page.getByTestId("kid-option").first().click();
    await expect(page.getByTestId("kid-outcome-correct")).toBeVisible();
    await expect(dock.getByTestId("kid-next")).toBeVisible();
    await nextFrames(page);
    const afterCorrect = await pictureTiles(page);

    expectRectsUnchanged(before.tiles, afterIncorrect.tiles, `${label}: tile after the wrong verdict`);
    expectRectsUnchanged(before.tiles, afterRetry.tiles, `${label}: tile after the retry`);
    expectRectsUnchanged(before.tiles, afterCorrect.tiles, `${label}: tile after the right verdict`);
    for (const [index, tile] of before.tiles.entries()) {
      expect(tile.width / scale, `tile ${index} inner width: ${JSON.stringify({ tile, scale })}`).toBeGreaterThanOrEqual(minTile);
    }
  });
}

// Compact exercise frame from 840 x 781 on (spec §3.2): the instruction, the answers and the footer (action or
// result panel) stand together at the top, so no empty band separates the answers from the footer. Every window here
// scales, so each test also waits for its zoom; the band is measured in screen pixels against the window height.
const TALL_WINDOWS = SESSION_WINDOWS.filter(({ height }) => height >= 781);
const MAX_BAND = 0.15;

/**
 * In the compact frame the result panel floats under the answers, so all its corners are rounded; picture choice keeps
 * its frame and the panel stays a bottom sheet (rounded top, square bottom).
 */
async function expectDockCorners(page: Page, shape: "rounded" | "sheet") {
  const corners = await page.getByTestId("kid-feedback-dock").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      top: Number.parseFloat(style.borderTopLeftRadius),
      bottomLeft: Number.parseFloat(style.borderBottomLeftRadius),
      bottomRight: Number.parseFloat(style.borderBottomRightRadius),
    };
  });
  const details = JSON.stringify(corners);
  expect(corners.top, `panel top corners rounded: ${details}`).toBeGreaterThan(0);
  if (shape === "rounded") {
    expect(corners.bottomLeft, `panel bottom corners as round as the top: ${details}`).toBe(corners.top);
    expect(corners.bottomRight, `panel bottom corners as round as the top: ${details}`).toBe(corners.top);
  } else {
    expect(corners.bottomLeft, `bottom-sheet panel: ${details}`).toBe(0);
    expect(corners.bottomRight, `bottom-sheet panel: ${details}`).toBe(0);
  }
}

for (const { width, height, scale } of TALL_WINDOWS) {
  test(`text choice has no empty band at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openSession(page, completedTextChoiceFixture());
    await expect(page.getByTestId("kid-exercise")).toHaveAttribute("data-feedback-layout", "flow");
    await expect(page.getByTestId("kid-option")).toHaveCount(4);
    await waitForKidScale(page, scale);
    await page.evaluate(async () => { await document.fonts.ready; });
    const before = await boxes(page, "[data-testid='kid-option']");

    await page.getByTestId("kid-option").first().click();
    await expect(page.getByTestId("kid-feedback-dock")).toBeVisible();
    await nextFrames(page);

    const after = await boxes(page, "[data-testid='kid-option']");
    const [dock] = await boxes(page, "[data-testid='kid-feedback-dock']");
    const details = JSON.stringify({ before, after, dock });
    expect(after).toHaveLength(4);
    expectRectsUnchanged(before, after, "option after the verdict");
    const band = dock!.top - Math.max(...after.map((option) => option.bottom));
    expect(band, `panel below the options: ${details}`).toBeGreaterThanOrEqual(-1);
    expect(band, `no empty band between the options and the panel: ${details}`).toBeLessThanOrEqual(MAX_BAND * height);
    expect(dock!.bottom, `panel in the window: ${details}`).toBeLessThanOrEqual(height + 1);
    await expectDockCorners(page, "rounded");
  });

  test(`written answer has no empty band at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openWrittenRecall(page);
    await waitForKidScale(page, scale);
    await page.getByTestId("kid-input").fill("cat");
    await page.evaluate(async () => { await document.fonts.ready; });
    const before = await measure(page, { input: "[data-testid='kid-input']", submit: "[data-testid='kid-submit']" });
    const band = before.submit.top - before.input.bottom;
    expect(band, `action below the field: ${JSON.stringify(before)}`).toBeGreaterThanOrEqual(0);
    expect(band, `no empty band between the field and the action: ${JSON.stringify(before)}`).toBeLessThanOrEqual(MAX_BAND * height);

    await page.getByTestId("kid-submit").click();
    await expect(page.getByTestId("kid-feedback-dock")).toBeVisible();
    await settledDockReserve(page);
    const after = await measure(page, { input: "[data-testid='kid-input']", dock: "[data-testid='kid-feedback-dock']" });
    const details = JSON.stringify({ before: before.input, after });
    expect(after.input.bottom, `field not covered by the panel: ${details}`).toBeLessThanOrEqual(after.dock.top + 1);
    expect(Math.abs(after.input.top - before.input.top), `field stays in place: ${details}`).toBeLessThanOrEqual(1);
    expect(after.dock.top - after.input.bottom, `no empty band between the field and the panel: ${details}`)
      .toBeLessThanOrEqual(MAX_BAND * height);
    expect(after.dock.bottom, `panel in the window: ${details}`).toBeLessThanOrEqual(height + 1);
    await expectDockCorners(page, "rounded");
  });
}

// Picture choice keeps its frame (excluded from the compact rule): the tiles fill the material height (cqh) anyway.
for (const { width, height, scale } of TALL_WINDOWS.filter(({ width }) => width === ULTRAWIDE.width)) {
  test(`picture choice has no empty band at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openPictureChoice(page, fourPictureTilesFixture());
    await expect(page.getByTestId("kid-option")).toHaveCount(4);
    await waitForKidScale(page, scale);
    await page.evaluate(async () => { await document.fonts.ready; });

    await page.getByTestId("kid-option").first().click();
    await expect(page.getByTestId("kid-outcome-correct")).toBeVisible();
    await expect(page.getByTestId("kid-next")).toBeVisible();
    await nextFrames(page);

    const tiles = await boxes(page, "[data-testid='kid-option']");
    const [dock] = await boxes(page, "[data-testid='kid-feedback-dock']");
    const details = JSON.stringify({ tiles, dock });
    for (const [index, tile] of [...tiles, dock!].entries()) {
      const name = index < tiles.length ? `tile ${index}` : "panel";
      expect(tile.left, `${name} in the window: ${details}`).toBeGreaterThanOrEqual(-1);
      expect(tile.top, `${name} in the window: ${details}`).toBeGreaterThanOrEqual(-1);
      expect(tile.right, `${name} in the window: ${details}`).toBeLessThanOrEqual(width + 1);
      expect(tile.bottom, `${name} in the window: ${details}`).toBeLessThanOrEqual(height + 1);
    }
    const band = dock!.top - Math.max(...tiles.map((tile) => tile.bottom));
    expect(band, `panel below the tiles: ${details}`).toBeGreaterThanOrEqual(-1);
    expect(band, `no empty band between the tiles and the panel: ${details}`).toBeLessThanOrEqual(MAX_BAND * height);
    await expectDockCorners(page, "sheet");
  });
}

test("long lesson card scrolls inside the material", async ({ page }) => {
  await page.setViewportSize(ULTRAWIDE);
  await openSession(page, lessonCardFixture());
  await expect(page.getByTestId("kid-lesson-card")).toBeVisible();
  await waitForKidScale(page, 1.6);
  await page.evaluate(async () => { await document.fonts.ready; });

  // The material track keeps its minimum 0: content longer than the window scrolls inside the material.
  const material = await page.getByTestId("kid-material").evaluate((element) =>
    ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
  expect(material.scrollHeight, `material scrolls: ${JSON.stringify(material)}`).toBeGreaterThan(material.clientHeight);
  const [next] = await boxes(page, "[data-testid='kid-lesson-next']");
  expect(next!.top, `main action in the window: ${JSON.stringify(next)}`).toBeGreaterThanOrEqual(0);
  expect(next!.bottom, `main action in the window: ${JSON.stringify(next)}`).toBeLessThanOrEqual(ULTRAWIDE.height + 1);
  await expectSessionFitsWindow(page, ULTRAWIDE);
});

/** Top edges of the selected elements below the top edge of the exercise frame, in screen pixels. */
async function topsInFrame<K extends string>(page: Page, selectors: Record<K, string>): Promise<Record<K, number>> {
  const layout = await measure(page, { ...selectors, frame: "[data-testid='kid-exercise']" });
  const keys = Object.keys(selectors) as K[];
  return Object.fromEntries(keys.map((key) => [key, layout[key].top - layout.frame.top])) as Record<K, number>;
}

/**
 * The footer's top edge below the lowest bottom edge among the children of `.kid-material-content` (screen px). The
 * material track ends 8 px above the footer in either frame; only in the compact frame does the content end there too.
 */
async function footerBelowContent(page: Page): Promise<number> {
  return page.evaluate(() => {
    const content = document.querySelector(".kid-material-content")!;
    const footer = document.querySelector("[data-testid='kid-exercise-actions']")!;
    return footer.getBoundingClientRect().top - Math.max(...[...content.children].map((child) => child.getBoundingClientRect().bottom));
  });
}

/** The space above the instruction: its top edge below the top edge of the exercise frame (screen px). */
async function frameTopOffset(page: Page): Promise<number> {
  return (await topsInFrame(page, { instruction: "[data-testid='kid-instruction']" })).instruction;
}

/** A speech task without a microphone and without a recording of the word (no audio notice can arrive later). */
function silentSpeechTask(): TaskDto {
  const task = taskFor("speech");
  if (task.prompt.kind !== "speech") throw new Error("speech task expected");
  return { ...task, prompt: { ...task.prompt, audioAssetId: null } };
}

// --kid-compact-frame-offset (spec 2026-10-31 §3.4): with a mouse or touchpad the compact frame leaves 90 inner px above
// the instruction, which the zoom multiplies on screen. The word cards, the illustrated tasks and the lesson card get
// none (their content is short here, so an offset would show); picture choice has no compact frame at all. `verdict`
// answers the task and names the answers that must not move.
const COMPACT_FRAME_OFFSET = 90;
const SHORT_LESSON_CARD = { title: "Pająki", body: "Pająk ma osiem nóg, a owad sześć.", examples: ["Pająk tka sieć."] };
const NO_OFFSET_KINDS = ["exposure", "picture_exposure", "picture_recall", "picture_speech"] as const;
const OFFSET_KINDS: {
  name: string; promptKind: string; offset: boolean; open: (page: Page) => Promise<void>;
  verdict?: { answers: string; give: (page: Page) => Promise<void> };
}[] = [
  {
    name: "written answer", promptKind: "recall", offset: true,
    open: async (page) => {
      await openWrittenRecall(page);
      await page.getByTestId("kid-input").fill("cat");
    },
    verdict: {
      answers: "[data-testid='kid-input']",
      give: async (page) => {
        await page.getByTestId("kid-submit").click();
        await expect(page.getByTestId("kid-feedback-dock")).toBeVisible();
        await settledDockReserve(page);
      },
    },
  },
  {
    name: "text choice", promptKind: "reading", offset: true,
    open: (page) => openSession(page, completedTextChoiceFixture()),
    verdict: {
      answers: "[data-testid='kid-option']",
      give: async (page) => {
        await page.getByTestId("kid-option").first().click();
        await expect(page.getByTestId("kid-feedback-dock")).toBeVisible();
        await nextFrames(page);
      },
    },
  },
  { name: "missing letters", promptKind: "letter_completion", offset: true,
    open: (page) => openSession(page, { ...recallFixture(), tasks: [letterTask("kot", "c_t")] }) },
  { name: "speech", promptKind: "speech", offset: true,
    open: (page) => openSession(page, { ...recallFixture(), tasks: [silentSpeechTask()] }) },
  ...NO_OFFSET_KINDS.map((promptKind) => ({ name: promptKind, promptKind, offset: false,
    open: (page: Page) => openSession(page, { ...recallFixture(), tasks: [taskFor(promptKind)] }) })),
  { name: "lesson card", promptKind: "lesson_card", offset: false, open: (page) => openSession(page, lessonCardFixture(SHORT_LESSON_CARD)) },
  { name: "picture choice", promptKind: "picture_listening", offset: false, open: (page) => openPictureChoice(page) },
];

for (const { width, height, scale } of SESSION_WINDOWS.filter(({ width }) => width >= 1920)) {
  test(`compact frame top offset by task kind at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    for (const { name, promptKind, offset, open, verdict } of OFFSET_KINDS) {
      await open(page);
      await expect(page.getByTestId("kid-exercise")).toHaveAttribute("data-prompt-kind", promptKind);
      await waitForKidScale(page, scale);
      await page.evaluate(async () => { await document.fonts.ready; });
      await nextFrames(page);
      const expected = offset ? COMPACT_FRAME_OFFSET * scale : 0;
      const actual = await frameTopOffset(page);
      expect(Math.abs(actual - expected), `${name}: space above the instruction ${actual}, expected ${expected}`)
        .toBeLessThanOrEqual(offset ? 2 : 1);
      if (!verdict) continue;
      const before = await boxes(page, verdict.answers);
      await verdict.give(page);
      expectRectsUnchanged(before, await boxes(page, verdict.answers), `${name}: answer after the verdict`);
    }
  });
}

test("regular frame and pinch zoom have no top offset", async ({ page }) => {
  await page.setViewportSize(LAPTOP);
  await openWrittenRecall(page);
  // Below 781 px a mouse gets the regular frame: the footer stays at the bottom edge and nothing is added on top.
  for (const viewport of [LAPTOP, { width: 1366, height: 600 }]) {
    const name = `${viewport.width}x${viewport.height}`;
    await resizeAndSettle(page, viewport);
    await waitForKidScale(page, 1);
    const layout = await measure(page, { frame: "[data-testid='kid-exercise']", footer: "[data-testid='kid-exercise-actions']" });
    expect(Math.abs(layout.footer.bottom - layout.frame.bottom), `${name}: footer at the bottom of the frame: ${JSON.stringify(layout)}`)
      .toBeLessThanOrEqual(6);
    expect(Math.abs(await frameTopOffset(page)), `${name}: no space above the instruction`).toBeLessThanOrEqual(1);
  }
  // A pinch zoom (data-zoomed) on the 34" window scrolls the session as a page: no offset there either. Without the
  // zoom the same window has the full offset, so the zero below is the zoom's doing.
  await resizeAndSettle(page, ULTRAWIDE);
  await waitForKidScale(page, 1.6);
  const unzoomed = await frameTopOffset(page);
  expect(Math.abs(unzoomed - COMPACT_FRAME_OFFSET * 1.6), `before the pinch zoom: the full offset, got ${unzoomed}`).toBeLessThanOrEqual(2);
  await emulatePinchZoom(page);
  await nextFrames(page);
  expect(Math.abs(await frameTopOffset(page)), "pinch zoom: no space above the instruction").toBeLessThanOrEqual(1);
});

// JS measurements under zoom (spec §4.4): rectangles are screen pixels, offset/scroll lengths and position: fixed
// lengths are inner pixels. The checks below compare screen rectangles only, at scale 1.6.
const ULTRAWIDE_SCALE = 1.6;

// A long source prompt and a spelling hint whose dock (382 inner px over a 54 px footer) covers the answer form.
// 3440x1440 has the compact frame (spec §3.2): the reserve grows the material row instead, and only once the material
// reaches its limit does the reserve lengthen the scroll range and the correcting scroll run — the path under test.
// So the prompt fills enough of the material for that (about 2/3), yet still fits before the verdict; a material that
// already scrolls before the verdict is covered by "the reserve lengthens an already scrolling material".
const LONG_RECALL_PROMPT = "Przeczytaj uważnie całą historyjkę, a potem przetłumacz zdanie na angielski, pilnując kolejności "
  + "słów i małych liter: dzieci szły starym drewnianym mostem nad rzeką i liczyły łódki, które powoli płynęły do portu, "
  + "zanim słońce schowało się za wzgórzami, a w miasteczku zapaliły się wszystkie światła.";

function longSpellingHintFixture(): KidUiFixture {
  return completedRecallFixture({ feedback: longSpellingHintFeedback, prompt: LONG_RECALL_PROMPT });
}

test("overlay dock reserve is exact", async ({ page }) => {
  await page.setViewportSize(ULTRAWIDE);
  await openWrittenRecall(page, longSpellingHintFixture());
  await waitForKidScale(page, ULTRAWIDE_SCALE);
  const material = await page.getByTestId("kid-material").evaluate((element) =>
    ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
  expect(material.scrollHeight, `the long prompt still fits the material before the verdict: ${JSON.stringify(material)}`)
    .toBeLessThanOrEqual(material.clientHeight + 1);
  await page.getByTestId("kid-input").fill("the children walked");
  await page.getByTestId("kid-submit").click();
  await expect(page.getByTestId("kid-feedback-dock")).toBeVisible();

  const geometry = await settledDockReserve(page);
  const details = JSON.stringify(geometry);
  // The dock really covers the content: without overlap the reserve stays off and the bound below proves nothing.
  expect(geometry.inlineReserve, `dock reserve engaged: ${details}`).toBeGreaterThan(0);
  // The reserve lengthened the scroll range and the correcting scroll ran; without it the content would simply end
  // above the dock in the grown material row and the bound below would not test the scroll.
  expect(geometry.scrollTop, `correcting scroll ran: ${details}`).toBeGreaterThan(0);
  // The top offset gives way first (spec 2026-10-31 §3.4): once the material scrolls, none is left above the instruction.
  expect(await frameTopOffset(page), `no top offset once the material scrolls: ${details}`).toBeLessThanOrEqual(1);
  // The correcting scroll leaves the answer 8 inner px above the dock: not under it, and not scrolled past it.
  expect(geometry.contentBottom, `answer above the dock: ${details}`).toBeLessThanOrEqual(geometry.dockTop + 1);
  expect(geometry.contentBottom, `answer right above the dock: ${details}`)
    .toBeGreaterThanOrEqual(geometry.dockTop - (8 * ULTRAWIDE_SCALE + 3));
});

// The offset gives way first (spec 2026-10-31 §3.4, `flex-shrink: 1000000`): content a little too tall for the full
// offset takes part of it, and the material keeps every pixel of its content. With a shrink factor of 1000 the material
// gave up a fraction of a pixel along with the offset, which leaves a 1 px scroll range (and a scroll bar). The content
// is lengthened by a test style measured from the free space under the footer, not by wrapping text (spec
// 2026-10-31-kid-ui-dock-followups §3.4): 45 px too tall takes half of the offset; 120 px too tall takes all of it and
// only then 30 px of the material.
test("the top offset gives way before the material", async ({ page }) => {
  await page.setViewportSize(ULTRAWIDE);
  await openWrittenRecall(page);
  await page.getByTestId("kid-input").fill("cat");
  await waitForKidScale(page, ULTRAWIDE_SCALE);
  await page.evaluate(async () => { await document.fonts.ready; });
  await nextFrames(page);
  const fullOffset = await frameTopOffset(page);
  expect(Math.abs(fullOffset - COMPACT_FRAME_OFFSET * ULTRAWIDE_SCALE), `the full offset: ${fullOffset}`).toBeLessThanOrEqual(2);
  // Free space under the footer, in inner px.
  const free = await page.evaluate(() => {
    const frame = document.querySelector("[data-testid='kid-exercise']")!;
    const footer = document.querySelector("[data-testid='kid-exercise-actions']")!;
    return (frame.getBoundingClientRect().bottom - footer.getBoundingClientRect().bottom) / (frame.currentCSSZoom || 1);
  });
  expect(free, "free space under the footer of a short prompt").toBeGreaterThan(50);

  const style = await page.addStyleTag({ content: "/* lengthens the material content below */" });
  const lengthen = async (extra: number) => {
    await style.evaluate((element, px) => {
      element.textContent = `.kid-material-content { padding-block-end: calc(4px + ${px}px) !important; }`;
    }, extra);
    await nextFrames(page);
    const material = await page.getByTestId("kid-material").evaluate((element) => element.scrollHeight - element.clientHeight);
    return { offset: await frameTopOffset(page), scrollRange: material };
  };
  const half = await lengthen(free + 45);
  const halfDetails = JSON.stringify({ fullOffset, free, half });
  expect(Math.abs(half.offset - (fullOffset - 45 * ULTRAWIDE_SCALE)), `45 px too tall takes 45 px of the offset: ${halfDetails}`)
    .toBeLessThanOrEqual(2 * ULTRAWIDE_SCALE);
  expect(half.scrollRange, `the material shows all of its content: ${halfDetails}`).toBe(0);

  const over = await lengthen(free + COMPACT_FRAME_OFFSET + 30);
  const overDetails = JSON.stringify({ fullOffset, free, over });
  expect(over.offset, `no offset left: ${overDetails}`).toBeLessThanOrEqual(1);
  expect(Math.abs(over.scrollRange - 30), `only then the material scrolls: ${overDetails}`).toBeLessThanOrEqual(1);
});

/**
 * Reads the overlap probe (`installDockOverlapProbe`): in no sampled frame does the panel cover the material content by
 * more than the 1 screen px correction threshold of `ExerciseFrame` (+ 1 for rounding), and once settled the content
 * ends above the panel (spec 2026-10-31 §1, §3.2; threshold: spec 2026-10-31-kid-ui-dock-followups §3.3). `settledIn`:
 * the window the probe must have settled in (a resize step). Returns the probe result.
 */
async function expectPanelNeverCovers(page: Page, label: string, settledIn?: Viewport) {
  const probe = await readDockOverlapProbe(page);
  const details = `${label}: ${JSON.stringify(probe)}`;
  if (settledIn) expect(probe.window, `the probe settled after the resize: ${details}`).toBe(`${settledIn.width}x${settledIn.height}`);
  expect(probe.samples.length, `the probe sampled frames: ${details}`).toBeGreaterThan(0);
  expect(Math.max(...probe.samples), `overlap in every sampled frame: ${details}`).toBeLessThanOrEqual(2);
  expect(probe.settled, `overlap once settled: ${details}`).toBeLessThanOrEqual(1);
  return probe;
}

// The reserve under the result panel is ready before the first frame that shows the panel (spec 2026-10-31 §3.2):
// a short wrong verdict and a long hint in the compact frame, a long hint in the regular frame (which also scrolls the
// material to correct), and a window resize while the panel is visible.
const PAINTED_FRAME_CASES = [
  { name: "short wrong verdict", viewport: ULTRAWIDE, scale: ULTRAWIDE_SCALE, scrolls: false, resizeTo: null,
    fixture: () => completedRecallFixture({ feedback: { kind: "incorrect", correctText: "cat" } }) },
  { name: "long spelling hint", viewport: ULTRAWIDE, scale: ULTRAWIDE_SCALE, scrolls: false, resizeTo: null, fixture: longSpellingHintFixture },
  { name: "long spelling hint", viewport: LAPTOP, scale: 1, scrolls: true, resizeTo: SMALL_LAPTOP, fixture: longSpellingHintFixture },
];

test("result panel never covers the material in a painted frame", async ({ page }) => {
  for (const { name, viewport, scale, scrolls, resizeTo, fixture } of PAINTED_FRAME_CASES) {
    const label = `${name} at ${viewport.width}x${viewport.height}`;
    await page.setViewportSize(viewport);
    await openWrittenRecall(page, fixture());
    await waitForKidScale(page, scale);
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.getByTestId("kid-input").fill("the children walked");
    await installDockOverlapProbe(page);
    await page.getByTestId("kid-submit").click();
    await expect(page.getByTestId("kid-feedback-dock")).toBeVisible();

    const geometry = await settledDockReserve(page);
    const details = `${label}: ${JSON.stringify(geometry)}`;
    // Without a real overlap the reserve stays off and the probe proves nothing.
    expect(geometry.inlineReserve, `the panel covers the answer, so the reserve is engaged: ${details}`).toBeGreaterThan(0);
    if (scrolls) expect(geometry.scrollTop, `the correcting scroll ran: ${details}`).toBeGreaterThan(0);
    await expectPanelNeverCovers(page, label);

    if (resizeTo) {
      const resizedLabel = `${label} resized to ${resizeTo.width}x${resizeTo.height}`;
      await installDockOverlapProbe(page, { startNow: true, until: resizeTo });
      await resizeAndSettle(page, resizeTo);
      await expectPanelNeverCovers(page, resizedLabel, resizeTo);
      const resized = await settledDockReserve(page);
      const resizedDetails = `${resizedLabel}: ${JSON.stringify({ before: geometry, after: resized })}`;
      // The resize moved the material under the panel, and the panel still covers the answer without its reserve.
      expect(resized.clientHeight !== geometry.clientHeight || resized.scrollTop !== geometry.scrollTop,
        `the resize changed the material: ${resizedDetails}`).toBe(true);
      expect(resized.inlineReserve, `the reserve is still engaged: ${resizedDetails}`).toBeGreaterThan(0);
    }
  }
});

const CLOZE_IDS = { childId: clozeUid(1), deckId: clozeUid(2), sessionId: clozeTask.sessionId, versionId: clozeUid(4) };
const CLOZE_DECK = { title: "Fotosynteza", subjectTitle: "Przyroda" };

/** "Uzupełnij tekst" with no attempt yet: the text with four empty gaps. */
function clozeFixture(): KidUiFixture {
  return lessonTaskFixture(CLOZE_IDS, CLOZE_DECK, [clozeTask]);
}

/** "Uzupełnij tekst" answered with the first bank word in every gap: a lesson hint with the child's text, the hint, the solution and its recording. */
/** Podpowiedź na tyle długa, że karta wyniku przekracza wolne miejsce tabletu (przypadek „space”). */
const LONG_CLOZE_HINT = Array.from({ length: 6 }, () =>
  "Pomyśl, co roślina pobiera z powietrza, a co do niego oddaje, i w której części dnia potrzebuje światła słonecznego.").join(" ");

function clozeHintFixture(task: TaskDto = clozeTask, hintPl = "Pomyśl, co roślina pobiera z powietrza, a co do niego oddaje."): KidUiFixture {
  const { prompt } = task;
  if (prompt.kind !== "lesson_cloze") throw new Error("cloze fixture expected");
  // Tapping the first bank word four times fills the gaps in this order.
  const given = ["światła słonecznego", "tlen", "dwutlenek węgla", "azot"];
  const solution = ["dwutlenek węgla", "światła słonecznego", "cukry", "tlen"];
  const filled = (words: string[]) => {
    let gap = 0;
    return prompt.segments.map((segment) => ("gapId" in segment ? { text: words[gap++]!, gap: true } : { text: segment.text, gap: false }));
  };
  const feedback: FeedbackDto = {
    kind: "lesson_hint",
    answerSegments: filled(given).map(({ text, gap }) => ({ text, state: gap ? "pill" as const : "plain" as const })),
    hintPl,
    correctText: filled(solution).map(({ text }) => text).join(""),
    correctAudioAssetId: clozeUid(60),
  };
  return lessonTaskFixture(CLOZE_IDS, CLOZE_DECK, [task], [assignmentAttempt(clozeUid(90), task.taskId, feedback)]);
}

/** Opens "Uzupełnij tekst" (`clozeHintFixture`) and fills the four gaps, ready for "Sprawdź" (`kid-lesson-check`). */
async function openAnsweredCloze(page: Page, viewport: Viewport, task: TaskDto = clozeTask, hintPl?: string) {
  await installKidUiFixture(page, clozeHintFixture(task, hintPl));
  await openLessonTask(page, viewport, "kid-lesson-cloze");
  for (let gap = 0; gap < 4; gap += 1) await page.getByTestId("kid-lesson-cloze-option").first().click();
}

/** How far the first matching element sits from the left and right edge of its parent's content box (screen px). */
async function insetsInParent(page: Page, selector: string): Promise<{ left: number; right: number }> {
  return page.locator(selector).first().evaluate((element) => {
    const parent = element.parentElement!;
    const style = getComputedStyle(parent);
    const rect = element.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    // Border and padding come from the style in inner pixels.
    const inset = (side: "Left" | "Right") =>
      (Number.parseFloat(style[`border${side}Width`]) + Number.parseFloat(style[`padding${side}`])) * parent.currentCSSZoom;
    return { left: rect.left - parentRect.left - inset("Left"), right: parentRect.right - rect.right - inset("Right") };
  });
}

// Reading measure (spec 2026-10-31 §3.6): in the 720 px column the longest line of the card body and of the cloze text
// is about 60 characters, and the narrower block sits in the middle of the column. The text is the long card body
// (1200 characters) and the four-gap cloze text (about 225 characters; the empty gaps hold only the "?" of the active
// gap and the screen-reader prefixes, none of them counted).
const READING_MEASURE_CASES = [
  {
    name: "lesson card", text: ".kid-lesson-card__body", exclude: undefined, blocks: [".kid-lesson-card__body", ".kid-lesson-card__examples"],
    open: async (page: Page) => {
      await page.setViewportSize(LAPTOP);
      await openSession(page, lessonCardFixture());
      await expect(page.getByTestId("kid-lesson-card")).toBeVisible();
    },
  },
  {
    name: "cloze text", text: ".kid-lesson-cloze__text", exclude: ".kid-lesson-cloze__gap-mark, .kid-visually-hidden", blocks: [".kid-lesson-cloze__text"],
    open: async (page: Page) => {
      await installKidUiFixture(page, clozeFixture());
      await openLessonTask(page, LAPTOP, "kid-lesson-cloze");
    },
  },
];

test("lesson text keeps about 60 characters per line in the 720 px column", async ({ page }) => {
  for (const { name, text, exclude, blocks, open } of READING_MEASURE_CASES) {
    await open(page);
    await waitForKidScale(page, 1);
    await page.evaluate(async () => { await document.fonts.ready; });
    const lines = await lineLengths(page, text, exclude);
    const longest = Math.max(...lines);
    const details = `${name}: characters per line ${JSON.stringify(lines)}`;
    expect(longest, `the longest line is at least 45 characters: ${details}`).toBeGreaterThanOrEqual(45);
    expect(longest, `the longest line is at most 65 characters: ${details}`).toBeLessThanOrEqual(65);
    const leftEdges: number[] = [];
    for (const block of blocks) {
      const insets = await insetsInParent(page, block);
      expect(Math.abs(insets.left - insets.right), `${name}: ${block} sits in the middle of the column: ${JSON.stringify(insets)}`)
        .toBeLessThanOrEqual(2);
      leftEdges.push((await boxes(page, block))[0]!.left);
    }
    // The card body and its examples start on one line, whatever the length of their text (`inline-size: 100%`).
    expect(Math.max(...leftEdges) - Math.min(...leftEdges), `${name}: ${blocks.join(" and ")} share the left edge: ${JSON.stringify(leftEdges)}`)
      .toBeLessThanOrEqual(1);
  }
});

/** The written answer whose long prompt scrolls the material before the verdict, answered; the dock shows `feedback`. */
async function openOverflowingRecall(page: Page, viewport: Viewport, feedback?: FeedbackDto) {
  await page.setViewportSize(viewport);
  await openWrittenRecall(page, overflowingRecallFixture(feedback));
  await page.getByTestId("kid-input").fill("the children walked");
}

/** A material that already scrolls before the verdict: the written answer with a long prompt and the cloze text. */
const SCROLLING_MATERIAL_CASES = [
  ...[LAPTOP, PHONE].map((viewport) => ({
    name: "written answer", viewport, submit: "kid-submit",
    open: (page: Page) => openOverflowingRecall(page, viewport),
  })),
  // A panel 20 px over the footer while the child reads the prompt from the top. The short panel is stretched by a
  // style, so the excess does not depend on fonts. The correcting scroll needs the scroll range the reserve adds, so it
  // runs on the layout with the reserve (spec 2026-10-31 §3.2): run on the layout before it, it stopped at the old end
  // and left about 4 px of the answer under the panel (an excess in (16, 24] px leaves 0–8 px), below the then 8 px
  // threshold (1 screen px since spec 2026-10-31-kid-ui-dock-followups §3.3).
  {
    name: "written answer under a panel 20 px over the footer", viewport: SMALL_LAPTOP, submit: "kid-submit",
    open: async (page: Page) => {
      await openOverflowingRecall(page, SMALL_LAPTOP, { kind: "great" });
      await page.addStyleTag({ content: ".kid-feedback-overlay { height: calc(100% + 20px); }" });
      await page.getByTestId("kid-material").evaluate((element) => { element.scrollTop = 0; });
    },
  },
  // With the gaps in the sentence the four-gap text still scrolls at 1280x600, but not at 1536x730: there the text is
  // longer after the last gap (`longClozeTask`).
  ...[{ viewport: SMALL_LAPTOP, task: clozeTask }, { viewport: LAPTOP, task: longClozeTask }].map(({ viewport, task }) => ({
    name: "cloze with a lesson hint", viewport, submit: "kid-lesson-check",
    open: (page: Page) => openAnsweredCloze(page, viewport, task),
  })),
];

// The reserve lengthens the scroll range of a material that already scrolls before the verdict (spec 2026-10-31 §3.3),
// also outside the compact frame: the content ends above the panel once settled and when scrolled to the very end.
test("the reserve lengthens an already scrolling material", async ({ page }) => {
  for (const { name, viewport, submit, open } of SCROLLING_MATERIAL_CASES) {
    const label = `${name} at ${viewport.width}x${viewport.height}`;
    await open(page);
    await page.evaluate(async () => { await document.fonts.ready; });
    const material = page.getByTestId("kid-material");
    const before = await material.evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
    expect(before.scrollHeight, `the material scrolls before the verdict: ${label}: ${JSON.stringify(before)}`)
      .toBeGreaterThan(before.clientHeight);
    await installDockOverlapProbe(page);
    await page.getByTestId(submit).click();
    await expect(page.getByTestId("kid-feedback-dock")).toBeVisible();

    const settled = await settledDockReserve(page);
    expect(settled.contentBottom, `content above the panel once settled: ${label}: ${JSON.stringify(settled)}`)
      .toBeLessThanOrEqual(settled.dockTop + 1);
    await expectPanelNeverCovers(page, label);

    await material.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await nextFrames(page);
    const atEnd = await settledDockReserve(page);
    expect(atEnd.contentBottom, `content above the panel when scrolled to the end: ${label}: ${JSON.stringify(atEnd)}`)
      .toBeLessThanOrEqual(atEnd.dockTop + 1);
  }
});

// The correcting scroll runs from a 1 screen px overlap (spec 2026-10-31-kid-ui-dock-followups §3.3); up to 8 inner px
// stayed under the panel before. A style stretches the panel so that it covers the answer by exactly 5 px: the overlay
// top is the anchor top (footer top + 8) minus the stretch, whatever the anchor height. The reserve does not move the
// centred content of the regular frame, so the correction scrolls by the overlap plus 8 px.
test("a first overlap of a few pixels is corrected", async ({ page }) => {
  await page.setViewportSize(SMALL_LAPTOP);
  await openWrittenRecall(page);
  await waitForKidScale(page, 1);
  await page.evaluate(async () => { await document.fonts.ready; });
  await nextFrames(page);
  const before = await page.evaluate(() => {
    const content = document.querySelector(".kid-material-content")!;
    const footer = document.querySelector("[data-testid='kid-exercise-actions']")!.getBoundingClientRect();
    return {
      contentBottom: Math.max(...[...content.children].map((child) => child.getBoundingClientRect().bottom)),
      footerTop: footer.top,
      footerHeight: footer.height,
    };
  });
  const stretch = before.footerTop + 8 - before.contentBottom + 5;
  await page.addStyleTag({ content: `.kid-feedback-overlay { height: calc(100% + ${stretch}px) !important; }` });
  await page.getByTestId("kid-input").fill("cat");
  await installDockOverlapProbe(page);
  await page.getByTestId("kid-submit").click();
  await expect(page.getByTestId("kid-feedback-dock")).toBeVisible();

  const settled = await settledDockReserve(page);
  const footerHeight = (await boxes(page, "[data-testid='kid-exercise-actions']"))[0]!.height;
  const details = JSON.stringify({ before, stretch, settled, footerHeight });
  // The footer keeps its height at the verdict, so the overlap really is 5 px.
  expect(Math.abs(footerHeight - before.footerHeight), `footer height unchanged: ${details}`).toBeLessThanOrEqual(0.5);
  expect(settled.inlineReserve, `the reserve is engaged: ${details}`).toBeGreaterThan(0);
  expect(Math.abs(settled.scrollTop - 13), `scrolled by the 5 px overlap + 8: ${details}`).toBeLessThanOrEqual(1);
  await expectPanelNeverCovers(page, "first overlap of 5 px at 1280x600");
});

// The result card takes the free space under the answer (spec 2026-10-31-kid-ui-dock-followups §3.1, §5): past the old
// limit min(36vh, 300px), as far as the panel does not cover the content and ends at least 12 inner px above the bottom
// edge of the exercise frame. All rows answer a short prompt ("kot"), which leaves free space under the footer.
const CARD_LIMIT = 300;

/**
 * The result card and its panel, in inner px against the top edge of the exercise frame: the card height and its natural
 * height (with the part its scroll area hides), whether the card scrolls, the card-limit variable on the overlay, the
 * lowest content edge and the edges of the overlay, the panel action, the answer and the instruction.
 */
async function cardState(page: Page) {
  return page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>("[data-testid='kid-exercise']")!;
    const zoom = frame.currentCSSZoom || 1;
    const frameTop = frame.getBoundingClientRect().top;
    const edges = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { top: (rect.top - frameTop) / zoom, bottom: (rect.bottom - frameTop) / zoom, width: rect.width / zoom };
    };
    const overlay = document.querySelector<HTMLElement>(".kid-feedback-overlay");
    const card = overlay?.querySelector<HTMLElement>(".kid-answer-feedback, .kid-speech-feedback") ?? null;
    // The answer card scrolls its content area; the speech card scrolls itself.
    const scroller = card?.querySelector<HTMLElement>(".kid-feedback-content") ?? card;
    const content = document.querySelector(".kid-material-content")!;
    const material = document.querySelector<HTMLElement>("[data-testid='kid-material']")!;
    const variable = overlay?.style.getPropertyValue("--kid-feedback-card-max") ?? "";
    return {
      zoom,
      // `flex` for the compact frame, `grid` for the regular one.
      display: getComputedStyle(frame).display,
      frameHeight: frame.offsetHeight,
      card: card?.offsetHeight ?? 0,
      natural: card && scroller ? card.offsetHeight + scroller.scrollHeight - scroller.clientHeight : 0,
      cardScrolls: scroller ? scroller.scrollHeight > scroller.clientHeight + 1 : false,
      variable: variable === "" ? null : Number.parseFloat(variable),
      contentBottom: (Math.max(...[...content.children].map((child) => child.getBoundingClientRect().bottom)) - frameTop) / zoom,
      materialScrolls: material.scrollHeight > material.clientHeight,
      overlay: edges(".kid-feedback-overlay"),
      next: edges("[data-testid='kid-next']"),
      answer: edges("[data-testid='kid-input'], .kid-lesson-cloze__text"),
      instruction: edges("[data-testid='kid-instruction']"),
      actions: edges("[data-testid='kid-exercise-actions']"),
    };
  });
}

/** Opens the written answer to "kot" with the given verdict and types the answer; the session status stays empty. */
async function openShortPromptAnswer(page: Page, viewport: Viewport, scale: number, feedback: FeedbackDto) {
  await page.setViewportSize(viewport);
  await openWrittenRecall(page, completedRecallFixture({ feedback }));
  await waitForKidScale(page, scale);
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.getByTestId("kid-input").fill("the children walked");
  await nextFrames(page);
  await expect(page.getByTestId("kid-session-status")).toHaveText("");
}

/** Sends the answer with the overlap probe running and waits for the reserve to settle. */
async function sendAndSettle(page: Page, submit = "kid-submit", probe: Parameters<typeof installDockOverlapProbe>[1] = {}) {
  await installDockOverlapProbe(page, probe);
  await page.getByTestId(submit).click();
  await expect(page.getByTestId("kid-feedback-dock")).toBeVisible();
  return settledDockReserve(page);
}

type CardSpaceCase = {
  name: string;
  viewport: Viewport;
  scale: number;
  frame: "compact" | "regular";
  open: (page: Page, viewport: Viewport, scale: number) => Promise<void>;
  submit?: string;
  // "whole": the card shows all of its content; "space": the free space limits the card and its content still scrolls.
  fits: "whole" | "space";
  // Also checks the card height in the first frame the panel can be painted in.
  firstFrame?: boolean;
};

const shortPromptHint = (feedback: FeedbackDto) => (page: Page, viewport: Viewport, scale: number) =>
  openShortPromptAnswer(page, viewport, scale, feedback);

/** One row of the card table: the card grows past the old limit, the answer stays, the panel stays in the frame. */
async function expectCardTakesFreeSpace(page: Page, row: CardSpaceCase) {
  const label = `${row.name} at ${row.viewport.width}x${row.viewport.height}`;
  await row.open(page, row.viewport, row.scale);
  const before = await cardState(page);
  const settled = await sendAndSettle(page, row.submit, { cardHeight: row.firstFrame });
  const probe = await expectPanelNeverCovers(page, label);
  const after = await cardState(page);
  // The card limit expected from the layout before the verdict (spec §3.1): the frame below the content, minus the
  // footer clearance (24) and the slack (8), minus the rest of the panel around the card.
  const expected = Math.floor(before.frameHeight - before.contentBottom - 24 - 8
    - (after.overlay!.bottom - after.overlay!.top - after.card));
  const details = `${label}: ${JSON.stringify({ expected, before, after, settled, firstCardHeight: probe.firstCardHeight })}`;
  expect(before.display, `the ${row.frame} frame: ${details}`).toBe(row.frame === "compact" ? "flex" : "grid");
  expect(after.natural, `the card content is taller than the old limit: ${details}`).toBeGreaterThan(CARD_LIMIT);
  if (row.fits === "whole") {
    // Fonts other than the ones measured (fixture comment) would show up here first, not as a scrolling card.
    expect(after.natural, `the card content fits the free space with room to spare: ${details}`).toBeLessThan(expected - 10);
  }
  expect(Math.abs(after.variable! - expected), `the card limit comes from the free space: ${details}`).toBeLessThanOrEqual(2);
  expect(after.card, `the card grew past the old limit: ${details}`).toBeGreaterThan(CARD_LIMIT + 10);
  expect(after.cardScrolls, `${row.fits === "whole" ? "the whole card is shown" : "the free space limits the card"}: ${details}`)
    .toBe(row.fits === "space");
  expect(after.next!.bottom, `the panel action stays in the frame: ${details}`).toBeLessThanOrEqual(after.frameHeight + 0.5);
  if (row.frame === "compact") {
    // The reserve moves the footer down into the free space; the answer and the top offset stay.
    for (const key of ["answer", "instruction"] as const) {
      expect(Math.abs(after[key]!.top - before[key]!.top), `${key} keeps its place: ${details}`).toBeLessThanOrEqual(1);
    }
    expect(after.materialScrolls, `the material does not scroll: ${details}`).toBe(false);
    if (row.fits === "space") {
      const below = after.frameHeight - after.overlay!.bottom;
      expect(below, `the panel ends 12 px above the frame bottom: ${details}`).toBeGreaterThanOrEqual(10);
      expect(below, `the panel ends 12 px above the frame bottom: ${details}`).toBeLessThanOrEqual(15);
    }
  } else {
    // The regular frame: the panel stops 28 px under the centred content and needs no reserve.
    expect(settled.inlineReserve, `no reserve: ${details}`).toBe(0);
    const gap = after.overlay!.top - after.contentBottom;
    expect(gap, `the panel ends 28 px under the content: ${details}`).toBeGreaterThanOrEqual(26);
    expect(gap, `the panel ends 28 px under the content: ${details}`).toBeLessThanOrEqual(32);
  }
  if (row.firstFrame) {
    expect(probe.firstCardHeight, `the first frame with the panel has the grown card: ${details}`).not.toBeNull();
    expect(Math.abs(probe.firstCardHeight! - after.card), `the first frame with the panel has the grown card: ${details}`)
      .toBeLessThanOrEqual(1);
  }
}

const MOUSE_CARD_SPACE_CASES: CardSpaceCase[] = [
  { name: "medium hint", viewport: ULTRAWIDE, scale: 1.6, frame: "compact", fits: "whole", firstFrame: true,
    open: shortPromptHint(mediumSpellingHintFeedback) },
  { name: "medium hint", viewport: { width: 3440, height: 1300 }, scale: 1.44, frame: "compact", fits: "whole", firstFrame: true,
    open: shortPromptHint(mediumSpellingHintFeedback) },
  { name: "long hint", viewport: ULTRAWIDE, scale: 1.6, frame: "compact", fits: "space", open: shortPromptHint(longSpellingHintFeedback) },
  { name: "long hint", viewport: { width: 820, height: 1180 }, scale: 1, frame: "regular", fits: "space",
    open: shortPromptHint(longSpellingHintFeedback) },
];

for (const row of MOUSE_CARD_SPACE_CASES) {
  test(`result card takes the free space under the answer: ${row.name} at ${row.viewport.width}x${row.viewport.height}`, async ({ page }) => {
    await expectCardTakesFreeSpace(page, row);
  });
}

// Where the free space is smaller (a laptop), the old limit stays: the variable is set, but 36vh of the window wins.
test("result card keeps 36vh where the free space is smaller", async ({ page }) => {
  await openShortPromptAnswer(page, LAPTOP, 1, longSpellingHintFeedback);
  await sendAndSettle(page);
  const state = await cardState(page);
  expect(state.variable, `the card limit is set: ${JSON.stringify(state)}`).toBeGreaterThan(0);
  expect(Math.abs(state.card - 0.36 * LAPTOP.height), `the card keeps 36vh: ${JSON.stringify(state)}`).toBeLessThanOrEqual(1);
});

// A change of the frame height alone is measured again (spec §3.1): 840 px wide windows keep scale 1 at every height,
// so the inner frame really changes. 1000 → 960 is less than the 90 px top offset: without measuring the frame the
// card would keep its size and the offset would give way, moving the answer.
test("result card follows the frame size", async ({ page }) => {
  await openShortPromptAnswer(page, { width: 840, height: 1000 }, 1, longSpellingHintFeedback);
  await sendAndSettle(page);
  const tall = await cardState(page);
  await resizeAndSettle(page, { width: 840, height: 960 });
  await settledDockReserve(page);
  const shorter = await cardState(page);
  const details = JSON.stringify({ tall, shorter });
  expect(tall.variable, `the variable wins over the 300 px limit at 1000: ${details}`).toBeGreaterThan(CARD_LIMIT);
  expect(shorter.variable, `the variable wins over the 300 px limit at 960: ${details}`).toBeGreaterThan(CARD_LIMIT);
  expect(Math.abs(tall.variable! - shorter.variable! - (tall.frameHeight - shorter.frameHeight)),
    `the card limit follows the frame height: ${details}`).toBeLessThanOrEqual(2);
  for (const state of [tall, shorter]) {
    expect(Math.abs(state.instruction!.top - COMPACT_FRAME_OFFSET), `the full top offset: ${details}`).toBeLessThanOrEqual(2);
  }
  expect(Math.abs(shorter.answer!.top - tall.answer!.top), `the answer keeps its place: ${details}`).toBeLessThanOrEqual(1);

  const small = { width: 840, height: 800 };
  await installDockOverlapProbe(page, { startNow: true, until: small });
  await resizeAndSettle(page, small);
  await expectPanelNeverCovers(page, "840x960 resized to 840x800", small);
  const smallest = await cardState(page);
  const smallDetails = JSON.stringify({ shorter, smallest });
  expect(smallest.variable ?? 0, `the card limit is measured again: ${smallDetails}`).toBeLessThan(shorter.variable!);
  expect(smallest.overlay!.bottom, `the panel stays in the frame: ${smallDetails}`).toBeLessThanOrEqual(smallest.frameHeight + 0.5);
});

// A change of the content alone (e.g. a notice inside the material) is measured again, too (spec §3.1): the card gives
// back the space the content takes, and the answer and the top offset stay. A padding under the last content block
// lengthens the content without moving the answer.
test("result card follows the content", async ({ page }) => {
  await openShortPromptAnswer(page, ULTRAWIDE, ULTRAWIDE_SCALE, longSpellingHintFeedback);
  await sendAndSettle(page);
  const before = await cardState(page);
  await page.addStyleTag({ content: ".kid-material-content > :last-child { padding-block-end: 40px !important; }" });
  await nextFrames(page);
  await settledDockReserve(page);
  const after = await cardState(page);
  const details = JSON.stringify({ before, after });
  expect(before.variable, `the card limit is set: ${details}`).not.toBeNull();
  expect(Math.abs(before.variable! - (after.variable ?? 0) - 40), `the card gives back the 40 px: ${details}`).toBeLessThanOrEqual(2);
  expect(Math.abs(after.instruction!.top - COMPACT_FRAME_OFFSET), `the full top offset: ${details}`).toBeLessThanOrEqual(2);
  expect(Math.abs(after.answer!.top - before.answer!.top), `the answer keeps its place: ${details}`).toBeLessThanOrEqual(1);
});

// A pinch zoom turns the session into a scrolling page (spec §3.1, §3.2): no card limit from the free space there.
test("pinch zoom brings back the old card limit", async ({ page }) => {
  await installDockRevealSpy(page);
  await openShortPromptAnswer(page, ULTRAWIDE, ULTRAWIDE_SCALE, longSpellingHintFeedback);
  await sendAndSettle(page);
  const grown = await cardState(page);
  expect(grown.card, `the card grew before the pinch zoom: ${JSON.stringify(grown)}`).toBeGreaterThan(CARD_LIMIT + 10);
  expect(await dockRevealCalls(page), "no reveal before the pinch zoom").toBe(0);
  await emulatePinchZoom(page);
  await expect.poll(() => dockRevealCalls(page)).toBe(1);
  await nextFrames(page);
  expect(await dockRevealCalls(page), "revealed once").toBe(1);
  const zoomed = await cardState(page);
  const details = JSON.stringify({ grown, zoomed });
  expect(zoomed.variable, `no card limit variable: ${details}`).toBeNull();
  expect(Math.abs(zoomed.card - CARD_LIMIT), `the old card limit: ${details}`).toBeLessThanOrEqual(1);
  await expectPanelFillsFooter(page, "pinch zoom at 3440x1440");
});

/**
 * In page-scroll mode the panel spans the footer (± 1 screen px) and the empty action slots of its anchor take no
 * space (spec 2026-10-31-kid-ui-dock-followups §3.2).
 */
async function expectPanelFillsFooter(page: Page, label: string) {
  const [panel] = await boxes(page, ".kid-feedback-overlay");
  const [footer] = await boxes(page, "[data-testid='kid-exercise-actions']");
  expect(Math.abs(panel!.width - footer!.width), `${label}: the panel spans the footer: ${JSON.stringify({ panel, footer })}`)
    .toBeLessThanOrEqual(1);
  const slotBoxes = await page.locator(".kid-feedback-overlay").locator("xpath=..")
    .locator("[data-testid='kid-primary-slot'], [data-testid='kid-secondary-slot']")
    .evaluateAll((slots) => slots.map((slot) => slot.getClientRects().length));
  // Both slots are there (primary and secondary) and neither has a box.
  expect(slotBoxes, `${label}: the empty action slots take no space`).toEqual([0, 0]);
}

// A very short window (a phone in landscape) scrolls the session as a page and the panel is part of it: it takes the
// place of the actions, over the whole footer, instead of the first grid column under a row of empty slots (spec
// 2026-10-31-kid-ui-dock-followups §3.2). The reveal scrolls the page, so positions are taken against the frame.
const PAGE_SCROLL_DOCK_CASES = [
  ...[{ width: 844, height: 390 }, { width: 667, height: 375 }].map((viewport) => ({
    name: "written answer", viewport, layout: "inline", answer: "[data-testid='kid-input']", submit: "kid-submit",
    open: async (page: Page) => {
      await page.setViewportSize(viewport);
      await openWrittenRecall(page, completedRecallFixture({ feedback: { kind: "incorrect", correctText: "cat" } }));
      await page.getByTestId("kid-input").fill("dog");
    },
  })),
  {
    name: "cloze", viewport: { width: 812, height: 375 }, layout: "stacked", answer: ".kid-lesson-cloze__text", submit: "kid-lesson-check",
    open: (page: Page) => openAnsweredCloze(page, { width: 812, height: 375 }),
  },
];

test("result panel takes the place of the actions when the page scrolls", async ({ page }) => {
  for (const { name, viewport, layout, answer, submit, open } of PAGE_SCROLL_DOCK_CASES) {
    const label = `${name} at ${viewport.width}x${viewport.height}`;
    await open(page);
    await expect(page.locator(".kid-page")).toHaveAttribute("data-viewport-very-short", "true");
    await expect(page.getByTestId("kid-exercise")).toHaveAttribute("data-action-layout", layout);
    await page.evaluate(async () => { await document.fonts.ready; });
    const before = await topsInFrame(page, { slot: "[data-testid='kid-primary-slot']", answer });
    await page.getByTestId(submit).click();
    await expect(page.getByTestId("kid-feedback-dock")).toBeVisible();
    await nextFrames(page);
    const after = await topsInFrame(page, { panel: ".kid-feedback-overlay", answer });
    const details = `${label}: ${JSON.stringify({ before, after })}`;
    expect(Math.abs(after.panel - before.slot), `the panel stands where the actions stood: ${details}`).toBeLessThanOrEqual(1);
    expect(Math.abs(after.answer - before.answer), `the answer keeps its place: ${details}`).toBeLessThanOrEqual(1);
    await expectPanelFillsFooter(page, label);
  }
});

test.describe("touch tablet in portrait", () => {
  // A touch tablet never scales and has no top offset; 1024 px wide it has the 720 px column and the compact frame.
  test.use({ viewport: { width: 1024, height: 1366 }, isMobile: true, hasTouch: true });

  const tablet = { width: 1024, height: 1366 };
  const TOUCH_CARD_SPACE_CASES: CardSpaceCase[] = [
    { name: "long hint", viewport: tablet, scale: 1, frame: "compact", fits: "whole", open: shortPromptHint(longSpellingHintFeedback) },
    // The lesson card (the hint, the child's text and the solution, stacked under their labels) with the six-sentence
    // `LONG_CLOZE_HINT` is taller than the free space under the text (about 690 px), which limits it, with another
    // overhead than the spelling card; with the short hint the compact answers (2026-11-02) fit whole (about 536 px).
    // The panel does not depend on the cloze view, so the short `clozeTask` is enough here.
    {
      name: "cloze with a lesson hint", viewport: tablet, scale: 1, frame: "compact", fits: "space", submit: "kid-lesson-check",
      open: async (page, viewport) => {
        await openAnsweredCloze(page, viewport, clozeTask, LONG_CLOZE_HINT);
        await page.evaluate(async () => { await document.fonts.ready; });
        await nextFrames(page);
      },
    },
  ];

  for (const row of TOUCH_CARD_SPACE_CASES) {
    test(`result card takes the free space under the answer: ${row.name}`, async ({ page }) => {
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "a touch screen").toBe(true);
      await expectCardTakesFreeSpace(page, row);
    });
  }

  // The 300 px card limit is the same at both heights (36vh is more than 300), so only measuring the frame again lets
  // the card grow.
  test("result card grows when the frame grows", async ({ page }) => {
    await openShortPromptAnswer(page, { width: 1024, height: 900 }, 1, longSpellingHintFeedback);
    await sendAndSettle(page);
    const lower = await cardState(page);
    await resizeAndSettle(page, tablet);
    await settledDockReserve(page);
    const taller = await cardState(page);
    const details = JSON.stringify({ lower, taller });
    expect(lower.card, `the card grew at 1024x900: ${details}`).toBeGreaterThan(CARD_LIMIT + 10);
    expect(lower.cardScrolls, `the free space limits the card at 1024x900: ${details}`).toBe(true);
    expect(taller.variable, `the card limit is measured again: ${details}`).toBeGreaterThan(lower.variable!);
    expect(taller.cardScrolls, `the whole card is shown at 1024x1366: ${details}`).toBe(false);
  });

  // The verdict takes the focus, which closes the on-screen keyboard: the frame grows after the panel appears.
  test("result card grows once the on-screen keyboard closes", async ({ page }) => {
    await openShortPromptAnswer(page, { width: 1024, height: 700 }, 1, longSpellingHintFeedback);
    await sendAndSettle(page, "kid-submit", { until: tablet });
    const typing = await cardState(page);
    await resizeAndSettle(page, tablet);
    await expectPanelNeverCovers(page, "1024x700 resized to 1024x1366", tablet);
    const closed = await cardState(page);
    const details = JSON.stringify({ typing, closed });
    expect(closed.variable, `the card limit is measured again: ${details}`).toBeGreaterThan(typing.variable ?? 0);
    expect(closed.cardScrolls, `the whole card is shown once the keyboard is closed: ${details}`).toBe(false);
  });
});

const SECOND_ATTEMPT_ID = "10000000-0000-4000-8000-000000000011";

// Review focus 1 (plan 2026-10-31): after "Spróbuj jeszcze raz" the leaving panel never takes the action's click, the
// reserve drops to 0, and the next wrong verdict gets its reserve again without covering the answer in any frame.
// At 3440x1440 the short wrong verdict covers the form (compact frame), so the reserve there is > 0.
const RETRY_CASES = [
  { viewport: ULTRAWIDE, scale: ULTRAWIDE_SCALE, coversForm: true },
  { viewport: LAPTOP, scale: 1, coversForm: false },
];

test("retry hands the footer back to the answer at once", async ({ page }) => {
  for (const { viewport, scale, coversForm } of RETRY_CASES) {
    const label = `${viewport.width}x${viewport.height}`;
    const fixture = completedRecallFixture({ feedback: { kind: "incorrect", correctText: "cat" } });
    const wrong = { ...fixture.attempts[0]!, taskState: "issued" as const };
    await page.setViewportSize(viewport);
    await openWrittenRecall(page, { ...fixture, attempts: [wrong, { ...wrong, attemptId: SECOND_ATTEMPT_ID }] });
    // The fixture emulates reduced motion; the panel's exit animation has to run here.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await waitForKidScale(page, scale);
    await page.getByTestId("kid-input").fill("dog");
    await page.getByTestId("kid-submit").click();
    const dock = page.getByTestId("kid-feedback-dock");
    await expect(dock).toBeVisible();
    const first = await settledDockReserve(page);

    // The retry and the hit test run in one evaluate, so the check lands well inside the 140 ms exit animation however
    // slow the test runner is. The retry is local state, which React commits without waiting for a frame, so the action
    // is looked up after a microtask and then task by task (`setTimeout(0)`). The retry clears the field and disables
    // the action until there is an answer again; a disabled button is still the element at its own point, so the hit
    // test needs no typing.
    const hit = await page.evaluate(async () => {
      const findAction = () => document.querySelector<HTMLElement>("[data-testid='kid-submit']");
      document.querySelector<HTMLElement>("[data-testid='kid-feedback-dock'] [data-testid='kid-next']")!.click();
      await Promise.resolve();
      let action = findAction();
      for (let tasks = 0; tasks < 10 && action === null; tasks += 1) {
        await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
        action = findAction();
      }
      if (action === null) return { action: false, popped: null, onAction: false, target: null };
      const { left, top, width, height } = action.getBoundingClientRect();
      const target = document.elementFromPoint(left + width / 2, top + height / 2);
      // The panel still on the page is the leaving one, popped out of the layout by AnimatePresence.
      const popped = document.querySelector(".kid-feedback-overlay")?.closest("[data-motion-pop-id]");
      return {
        action: true,
        popped: popped ? getComputedStyle(popped).pointerEvents : null,
        onAction: target !== null && action.contains(target),
        target: target === null ? null : `${target.tagName.toLowerCase()}.${target.className}`,
      };
    });
    const hitDetails = `${label}: ${JSON.stringify(hit)}`;
    expect(hit.action, `the answer action is back after the retry: ${label}`).toBe(true);
    expect(hit.popped, `the panel is still animating out: ${hitDetails}`).not.toBeNull();
    expect(hit.popped, `the leaving panel lets clicks through: ${hitDetails}`).toBe("none");
    expect(hit.onAction, `the action, not the leaving panel, takes the click: ${hitDetails}`).toBe(true);

    await expect(page.locator(".kid-feedback-overlay")).toHaveCount(0);
    const reserve = await page.locator(".kid-material-content").evaluate((element: HTMLElement) =>
      Number.parseFloat(element.style.paddingBottom) || 0);
    expect(reserve, `no reserve once the panel is gone: ${label}`).toBe(0);

    await page.getByTestId("kid-input").fill("dog");
    await installDockOverlapProbe(page);
    await page.getByTestId("kid-submit").click();
    await expect(dock).toBeVisible();
    const again = await settledDockReserve(page);
    const details = `${label}: ${JSON.stringify({ first, again })}`;
    // The same panel over the same answer gets the same reserve again.
    expect(again.inlineReserve, `the second wrong verdict gets the reserve again: ${details}`).toBe(first.inlineReserve);
    if (coversForm) expect(again.inlineReserve, `the panel covers the form, so the reserve is engaged: ${details}`).toBeGreaterThan(0);
    expect(again.contentBottom, `the second wrong verdict keeps the answer above the panel: ${details}`)
      .toBeLessThanOrEqual(again.dockTop + 1);
    await expectPanelNeverCovers(page, `${label} second wrong verdict`);
  }
});

test("microphone panel opens under its button", async ({ page }) => {
  await page.setViewportSize(ULTRAWIDE);
  await openDeckScreen(page, [makeDeck(0)]);
  await waitForKidScale(page, ULTRAWIDE_SCALE);
  const button = page.getByTestId("kid-mic-settings");
  await button.click();
  const panel = page.getByTestId("kid-mic-settings-panel");
  await expect(panel).toBeVisible();
  // JS has placed the panel; its static position would sit right under the button anyway.
  await expect.poll(() => panel.evaluate((element: HTMLElement) => element.style.left !== "" && element.style.top !== "")).toBe(true);

  const buttonBox = (await button.boundingBox())!;
  const panelBox = (await panel.boundingBox())!;
  const details = JSON.stringify({ buttonBox, panelBox });
  const buttonBottom = buttonBox.y + buttonBox.height;
  // The 8 px gap is an inner length, so it is 8 x 1.6 on screen: an unscaled 8 px gap fails the lower bound.
  expect(panelBox.y, `panel below the button by the scaled gap: ${details}`).toBeGreaterThanOrEqual(buttonBottom + 8 * ULTRAWIDE_SCALE - 2);
  expect(panelBox.y, `panel right below the button: ${details}`).toBeLessThanOrEqual(buttonBottom + 8 * ULTRAWIDE_SCALE + 2);
  // The 280 px panel fits the window, so it starts at the button's left edge.
  expect(Math.abs(panelBox.x - buttonBox.x), `panel aligned with the button: ${details}`).toBeLessThanOrEqual(2);
});

// A question long enough to push the answer field below the visible material at 3440x1440. It is not
// LONG_LESSON_CARD.body on purpose: that text is a bulleted card body, this one is a plain question prompt that ends
// with the question itself.
const LONG_LESSON_TEXT = (
  "Pająki nie są owadami, chociaż wiele osób tak myśli. Pająk ma osiem nóg, a owad sześć. "
  + "Ciało pająka składa się z dwóch części: głowotułowia i odwłoka. Pająki nie mają czułków ani skrzydeł. "
  + "Większość pająków tka sieci z cienkich, mocnych nici, które wytwarzają kądziołki na końcu odwłoka. "
).repeat(5).slice(0, 1200).trim() + " Czym różni się pająk od owada?";

function longQuestionFixture(): KidUiFixture {
  const ids = {
    childId: "10000000-0000-4000-8000-000000000a01",
    deckId: "10000000-0000-4000-8000-000000000a02",
    sessionId: "10000000-0000-4000-8000-000000000a03",
    deckVersionId: "10000000-0000-4000-8000-000000000a04",
  };
  const task: TaskDto = {
    taskId: "10000000-0000-4000-8000-000000000a11", sessionId: ids.sessionId, ordinal: 0, exerciseType: "lesson_open_answer",
    direction: null, state: "issued", remainingAssessed: 2,
    prompt: { kind: "lesson_open_answer", instructionPl: "Odpowiedz własnymi słowami.", prompt: LONG_LESSON_TEXT, promptLocale: "pl-PL",
      questionAudioAssetId: "10000000-0000-4000-8000-000000000a21" },
  };
  return lessonAudioFixture(ids, [task]);
}

test("keyboard focus stays visible", async ({ page }) => {
  await installKidUiFixture(page, longQuestionFixture());
  await page.setViewportSize(ULTRAWIDE);
  await page.goto("/");
  await page.getByTestId("kid-profile").click();
  await page.getByTestId("kid-deck").click();
  const field = page.getByTestId("kid-lesson-input");
  await expect(field).toBeVisible();
  await waitForKidScale(page, ULTRAWIDE_SCALE);

  // The question audio button in the instruction row is the control right before the field.
  await page.getByTestId("kid-question-audio").focus();
  const before = await measure(page, { field: "[data-testid='kid-lesson-input']", material: "[data-testid='kid-material']" });
  expect(before.field.top, `field starts below the visible material: ${JSON.stringify(before)}`).toBeGreaterThan(before.material.bottom);

  await page.keyboard.press("Tab");
  await expect(field).toBeFocused();
  await expect.poll(async () => {
    const layout = await measure(page, {
      field: "[data-testid='kid-lesson-input']",
      material: "[data-testid='kid-material']",
      actions: "[data-testid='kid-exercise-actions']",
    });
    const visible = layout.field.top >= layout.material.top - 1 && layout.field.bottom <= layout.material.bottom + 1
      && layout.field.bottom <= layout.actions.top + 1;
    return visible ? "ok" : JSON.stringify(layout);
  }, { message: "focused field is inside the material and above the actions" }).toBe("ok");
});

// „Posłuchaj zdania” and „Posłuchaj wolniej” in the result panel of a lesson gap (spec 2026-11-01-sentence-readback-followups
// §4.3): the dock is at most 560 inner pixels wide, so the container query keeps the two buttons in one row at every scale.
// Rectangles are screen pixels, so a 48 px target is 48 x scale on screen.
const SENTENCE_AUDIO_WINDOWS = [
  { width: 1920, height: 1080, scale: 1.2 },
  { width: 3440, height: 1440, scale: 1.6 },
] as const;

function sentenceAudioFixture(): KidUiFixture {
  const ids = {
    childId: "10000000-0000-4000-8000-000000000b01",
    deckId: "10000000-0000-4000-8000-000000000b02",
    sessionId: "10000000-0000-4000-8000-000000000b03",
    deckVersionId: "10000000-0000-4000-8000-000000000b04",
  };
  const task: TaskDto = {
    taskId: "10000000-0000-4000-8000-000000000b11", sessionId: ids.sessionId, ordinal: 1, exerciseType: "lesson_gap",
    direction: null, state: "issued", remainingAssessed: 2,
    prompt: { kind: "lesson_gap", instructionPl: "Uzupełnij lukę", stemWithGap: "He ___ to school.", hint: "(go)" },
  };
  return {
    ...lessonAudioFixture(ids, [task]),
    attempts: [{
      attemptId: "10000000-0000-4000-8000-000000000b31", taskId: task.taskId, state: "completed", modality: "text",
      taskState: "answered", stepId: "s1", receivedAt: "2026-10-31T10:00:01.000Z", completedAt: "2026-10-31T10:00:01.000Z",
      feedback: { kind: "incorrect", correctText: "He goes to school.", correctAudioAssetId: "10000000-0000-4000-8000-000000000b21" },
    }],
  };
}

for (const { width, height, scale } of SENTENCE_AUDIO_WINDOWS) {
  test(`sentence audio group in the dock at scale ${scale}`, async ({ page }) => {
    const viewport = { width, height };
    await installKidUiFixture(page, sentenceAudioFixture());
    await openLessonTask(page, viewport, "kid-lesson-gap");
    await waitForKidScale(page, scale);
    await page.getByTestId("kid-lesson-gap-input").fill("goes");
    await page.getByTestId("kid-lesson-check").click();
    const dock = page.getByTestId("kid-feedback-dock");
    await expect(dock.getByTestId("kid-sentence-audio-group")).toBeVisible();
    await expect(dock.getByTestId("kid-sentence-audio-slow")).toBeVisible();
    await nextFrames(page);

    const dockBox = (await dock.boundingBox())!;
    const guidance = (await dock.getByTestId("kid-guidance-play").boundingBox())!;
    type ScreenBox = { x: number; y: number; width: number; height: number };
    const buttons: ScreenBox[] = [];
    for (const testId of ["kid-sentence-audio", "kid-sentence-audio-slow"]) {
      const box = (await dock.getByTestId(testId).boundingBox())!;
      const details = `${testId} ${JSON.stringify(box)}, dock ${JSON.stringify(dockBox)} at ${width}x${height}`;
      expect(box.width, `width: ${details}`).toBeGreaterThanOrEqual(48 * scale - 0.5);
      expect(box.height, `height: ${details}`).toBeGreaterThanOrEqual(48 * scale - 0.5);
      expect(box.x, `inside dock: ${details}`).toBeGreaterThanOrEqual(dockBox.x - 1);
      expect(box.y, `inside dock: ${details}`).toBeGreaterThanOrEqual(dockBox.y - 1);
      expect(box.x + box.width, `inside dock: ${details}`).toBeLessThanOrEqual(dockBox.x + dockBox.width + 1);
      expect(box.y + box.height, `inside dock: ${details}`).toBeLessThanOrEqual(dockBox.y + dockBox.height + 1);
      buttons.push(box);
    }
    const [sentence, slow] = buttons as [ScreenBox, ScreenBox];
    const row = JSON.stringify({ sentence, slow, guidance });
    // One row: the sentence button, then the slow one, then the message „?”.
    expect(Math.abs(sentence.y - slow.y), `buttons in one row: ${row}`).toBeLessThanOrEqual(1);
    expect(slow.x, `slow button right of the sentence button: ${row}`).toBeGreaterThanOrEqual(sentence.x + sentence.width - 1);
    expect(guidance.x, `„?” right of the slow button: ${row}`).toBeGreaterThanOrEqual(slow.x + slow.width - 1);
    expect((await documentOverflow(page)).width, `horizontal overflow at ${width}x${height}`).toBeLessThanOrEqual(0);
  });
}

// Missing letters wrap between words only (spec §3.3). A leaf is one letter field or one fixed character (a space is a
// leaf too); the checks read leaf rectangles, not the word grouping, so they hold for any markup that lays words out right.
const LETTER_GAP = 4;
const LETTER_ROW_TOLERANCE = 4;

interface LetterLeaf { text: string; input: boolean; left: number; right: number; width: number; height: number; centerY: number }

async function openLetters(page: Page, viewport: Viewport, fragment: string) {
  await page.setViewportSize(viewport);
  await openSession(page, { ...recallFixture(), tasks: [letterTask("Uzupełnij słowo", fragment)] });
  await expect(page.getByTestId("kid-fragment")).toBeVisible();
  await waitForKidScale(page, 1);
  await page.evaluate(async () => { await document.fonts.ready; });
  await nextFrames(page);
}

async function letterLeaves(page: Page): Promise<LetterLeaf[]> {
  return page.getByTestId("kid-fragment").evaluate((fragment) =>
    [...fragment.querySelectorAll<HTMLElement>(".kid-letter-input, .kid-letter-fixed")].map((element) => {
      const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
      return { text: element.textContent ?? "", input: element.classList.contains("kid-letter-input"),
        left, right, width, height, centerY: (top + bottom) / 2 };
    }));
}

/** Rows (leaves whose vertical centres are within 4 px share a row), words (runs of leaves between spaces) and the width of the phrase on one row. */
function analyseLetters(leaves: LetterLeaf[]) {
  const rowCentres: number[] = [];
  const rowOf = leaves.map((leaf) => {
    const row = rowCentres.findIndex((centre) => Math.abs(centre - leaf.centerY) <= LETTER_ROW_TOLERANCE);
    return row >= 0 ? row : rowCentres.push(leaf.centerY) - 1;
  });
  const words: number[][] = [[]];
  leaves.forEach((leaf, index) => {
    if (!leaf.input && leaf.text === " ") words.push([]);
    else words[words.length - 1]!.push(index);
  });
  const widthOf = (indices: number[]) => indices.reduce((sum, index) => sum + leaves[index]!.width, 0) + LETTER_GAP * (indices.length - 1);
  const letterWords = words.filter((word) => word.length > 0);
  const naturalWidth = widthOf(leaves.map((_, index) => index));
  const describe = () => JSON.stringify({ naturalWidth, words: letterWords.map((word) =>
    ({ word: word.map((index) => leaves[index]!.input ? "_" : leaves[index]!.text).join(""), rows: [...new Set(word.map((index) => rowOf[index]))] })) });
  return { rows: rowCentres.length, rowOf, words: letterWords, naturalWidth, widthOf, describe };
}

/** Words that sit on more than one row, i.e. the ones broken in the middle. */
const brokenWords = (analysis: ReturnType<typeof analyseLetters>) =>
  analysis.words.filter((word) => new Set(word.map((index) => analysis.rowOf[index])).size > 1);

// The phrase is sized for the two columns of the large-screen spec: it fits the 720 px column on one row and not the
// 560 px one. A different monospace font moves the width, so this precondition fails with a font message, not a layout one.
const LETTER_PHRASE = "My s_ster r_ads b__ks";
const LETTER_PHRASE_WIDTH = { min: 540, max: 680 };

function expectPhraseSized(analysis: ReturnType<typeof analyseLetters>) {
  expect(analysis.words.length, `the phrase has at least three words: ${analysis.describe()}`).toBeGreaterThanOrEqual(3);
  const width = analysis.naturalWidth;
  expect(width > LETTER_PHRASE_WIDTH.min && width < LETTER_PHRASE_WIDTH.max,
    `natural width of the phrase is ${width} px, outside (${LETTER_PHRASE_WIDTH.min}; ${LETTER_PHRASE_WIDTH.max}): the monospace font differs from the one the phrase was sized for`).toBe(true);
}

test("missing letters fit one row in the 720 px column", async ({ page }) => {
  await openLetters(page, { width: 1536, height: 730 }, LETTER_PHRASE);
  const analysis = analyseLetters(await letterLeaves(page));
  expectPhraseSized(analysis);
  expect(analysis.rows, `the phrase fits one row in the wide column: ${analysis.describe()}`).toBe(1);
});

test("missing letters wrap only between words in the 560 px column", async ({ page }) => {
  await openLetters(page, { width: 768, height: 1024 }, LETTER_PHRASE);
  const analysis = analyseLetters(await letterLeaves(page));
  expectPhraseSized(analysis);
  expect(analysis.rows, `the phrase needs more than one row in the narrow column: ${analysis.describe()}`).toBeGreaterThanOrEqual(2);
  expect(brokenWords(analysis).length, `no word is broken across rows: ${analysis.describe()}`).toBe(0);
});

test("a long word stays on one row on a phone", async ({ page }) => {
  // A short word, then a nine-letter word with five gaps that fits the 358 px row on its own but not after the short word.
  await openLetters(page, PHONE, "a _a_g_r_u_");
  const leaves = await letterLeaves(page);
  const analysis = analyseLetters(leaves);
  const { fragment } = await measure(page, { fragment: "[data-testid='kid-fragment']" });
  const word = analysis.words[1]!;
  const wordWidth = analysis.widthOf(word);
  const details = JSON.stringify({ wordWidth, fragmentWidth: fragment.width, phrase: analysis.describe() });
  expect(wordWidth, `the word fits the row on its own: ${details}`).toBeLessThanOrEqual(fragment.width);
  expect(analysis.naturalWidth, `the short word and the long one do not fit one row: ${details}`).toBeGreaterThan(fragment.width);
  expect(analysis.rows, `the phrase wraps: ${details}`).toBeGreaterThanOrEqual(2);
  expect(brokenWords(analysis).length, `the long word is not broken across rows: ${details}`).toBe(0);
});

test("a word wider than the screen wraps inside the material on a phone", async ({ page }) => {
  await openLetters(page, PHONE, "unch_r_ct_r_stic_lly");
  const leaves = await letterLeaves(page);
  const { material, scrollWidth, innerWidth } = await measure(page, { material: "[data-testid='kid-material']" });
  const details = JSON.stringify({ material, leaves: leaves.length });
  expect(leaves.filter((leaf) => leaf.input), `the word keeps its five letter fields: ${details}`).toHaveLength(5);
  for (const [index, leaf] of leaves.entries()) {
    expect(leaf.left, `leaf ${index} inside the material (left): ${details}`).toBeGreaterThanOrEqual(material.left - 1);
    expect(leaf.right, `leaf ${index} inside the material (right): ${details}`).toBeLessThanOrEqual(material.right + 1);
  }
  expect(scrollWidth, "no horizontal scroll").toBeLessThanOrEqual(innerWidth);
  for (const [index, leaf] of leaves.filter((item) => item.input).entries()) {
    expect(leaf.width, `letter field ${index} width`).toBeGreaterThanOrEqual(48);
    expect(leaf.height, `letter field ${index} height`).toBeGreaterThanOrEqual(48);
  }
});

// Screenshots of the five main screens on a laptop window and on an ultrawide full-screen window, attached to the
// report (PR description). They assert only what they need to be taken (screen visible, scale applied); the layout
// itself is checked by the tests above.
const SCREENSHOT_WINDOWS = [
  { width: 1536, height: 730, scale: 1 },
  { width: 3440, height: 1440, scale: 1.6 },
] as const;

/**
 * Waits for a settled picture: fonts loaded, no running finite CSS/WAAPI animation, and the computed opacity of every
 * element of the page unchanged for ten frames. reducedMotion drops Motion's transforms but keeps its opacity fades, and those
 * are driven from JS (inline style per frame), so `getAnimations()` alone does not see them.
 */
async function waitForSettledPicture(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const frame = () => new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
    const opacities = () => [...document.querySelectorAll(".kid-page *")]
      .map((element) => getComputedStyle(element).opacity).join(",");
    let previous = "";
    let stableFrames = 0;
    for (let attempt = 0; attempt < 300 && stableFrames < 10; attempt += 1) {
      await frame();
      const next = opacities();
      // Endless CSS/WAAPI animations (if any) never finish, so only finite ones count here. This exemption covers
      // getAnimations() only: an endless JS-driven opacity loop would still change the opacities and hit the throw below.
      const running = document.getAnimations().some((animation) =>
        animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity);
      stableFrames = next === previous && !running ? stableFrames + 1 : 0;
      previous = next;
    }
    if (stableFrames < 10) throw new Error("the page did not settle: opacity or animations kept changing for 300 frames");
  });
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string) {
  // The click that opened the screen leaves the pointer over a control (e.g. "Dalej" in the written answer), which
  // would show its hover state; move it to the empty corner first.
  await page.mouse.move(0, 0);
  await waitForSettledPicture(page);
  await testInfo.attach(name, { body: await page.screenshot(), contentType: "image/png" });
}

test.describe("screenshots", () => {
  test.skip(!process.env.UMIEM_E2E_SCREENSHOTS, "set UMIEM_E2E_SCREENSHOTS=1 to attach review screenshots");

  for (const { width, height, scale } of SCREENSHOT_WINDOWS) {
    const size = `${width}x${height}`;

    test(`screenshot: picture choice at ${size}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await openPictureChoice(page, fourPictureTilesFixture());
      await expect(page.getByTestId("kid-option")).toHaveCount(4);
      await waitForKidScale(page, scale);
      await page.getByTestId("kid-option").first().click();
      await expect(page.getByTestId("kid-outcome-correct")).toBeVisible();
      await expect(page.getByTestId("kid-next")).toBeVisible();
      await attachScreenshot(page, testInfo, `picture-choice-${size}`);
    });

    test(`screenshot: text choice at ${size}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await openSession(page, completedTextChoiceFixture());
      await expect(page.getByTestId("kid-option")).toHaveCount(4);
      await waitForKidScale(page, scale);
      await page.getByTestId("kid-option").first().click();
      await expect(page.getByTestId("kid-feedback-dock")).toBeVisible();
      await attachScreenshot(page, testInfo, `text-choice-${size}`);
    });

    test(`screenshot: written answer at ${size}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await openWrittenRecall(page);
      await waitForKidScale(page, scale);
      await page.getByTestId("kid-input").fill("cat");
      await page.getByTestId("kid-submit").click();
      await expect(page.getByTestId("kid-feedback-dock")).toBeVisible();
      await settledDockReserve(page);
      await attachScreenshot(page, testInfo, `written-answer-${size}`);
    });

    test(`screenshot: missing letters at ${size}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await openSession(page, { ...recallFixture(), tasks: [letterTask("Uzupełnij słowo", LETTER_PHRASE)] });
      await expect(page.getByTestId("kid-fragment")).toBeVisible();
      await waitForKidScale(page, scale);
      await attachScreenshot(page, testInfo, `missing-letters-${size}`);
    });

    test(`screenshot: deck screen at ${size}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await openDeckScreen(page, [makeDeck(0), makeDeck(1), makeDeck(2)]);
      await expect(page.getByTestId("kid-deck-screen")).toBeVisible();
      await waitForKidScale(page, scale);
      await attachScreenshot(page, testInfo, `deck-screen-${size}`);
    });
  }

  // The same two answer screens one step earlier: the question as the child sees it before the verdict (the tests above
  // show the screen after it), also on the small laptop window the follow-ups were measured on.
  const BEFORE_VERDICT = [
    { screen: "picture choice", width: 1280, height: 600, scale: 1, open: openPictureTiles },
    { screen: "picture choice", width: 1536, height: 730, scale: 1, open: openPictureTiles },
    { screen: "written answer", width: 3440, height: 1440, scale: 1.6, open: openWrittenRecall },
  ] as const;

  for (const { screen, width, height, scale, open } of BEFORE_VERDICT) {
    test(`screenshot: ${screen} before the verdict at ${width}x${height}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await open(page);
      await waitForKidScale(page, scale);
      await attachScreenshot(page, testInfo, `${screen.replace(" ", "-")}-before-verdict-${width}x${height}`);
    });
  }
});

async function openPictureTiles(page: Page) {
  await openPictureChoice(page, fourPictureTilesFixture());
  await expect(page.getByTestId("kid-option")).toHaveCount(4);
}
