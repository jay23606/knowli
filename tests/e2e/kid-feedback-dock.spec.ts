import { expect, test } from "@playwright/test";
import type { AttemptDto, FeedbackDto, TaskDto } from "@learning/contracts";
import { installKidUiFixture } from "./helpers/kid-ui-fixture";
import { kidTokenColor } from "./helpers/contrast";
import { measure, resizeAndSettle } from "./helpers/kid-layout";
import { pictureVocabularyFixture } from "./helpers/picture-fixtures";
import { attemptId, baseFixture, completedRecallFixture, sessionId, taskId } from "./helpers/kid-fixtures";
import { dockRevealCalls, installDockRevealSpy, waitForKidScale } from "./helpers/kid-frame";
import { lessonAudioFixture, openLessonTask } from "./helpers/lesson-audio";

const optionIds = ["10000000-0000-4000-8000-000000000007", "10000000-0000-4000-8000-000000000008", "10000000-0000-4000-8000-000000000009"];

function completedReadingFixture() {
  return {
    ...baseFixture(),
    tasks: [{ taskId, sessionId, ordinal: 0, exerciseType: "reading" as const, direction: "target_to_source" as const,
      state: "issued" as const, prompt: { kind: "reading" as const, text: "cat",
        options: ["kot", "pies", "ptak"].map((text, index) => ({ id: optionIds[index]!, text })) }, remainingAssessed: 1 }],
    attempts: [{ attemptId, taskId, state: "completed" as const, modality: "choice" as const,
      feedback: { kind: "great" as const }, taskState: "completed" as const, stepId: null,
      receivedAt: "2026-10-11T10:00:00.000Z", completedAt: "2026-10-11T10:00:01.000Z" }],
  };
}

async function openTask(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("kid-profile").click();
  await page.getByTestId("kid-deck").click();
  await expect(page.getByTestId("kid-exercise")).toBeVisible();
}

test("confirming a revealed answer opens the next written task with an editable field", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = completedRecallFixture();
  const nextId = "10000000-0000-4000-8000-000000000011";
  await installKidUiFixture(page, {
    ...fixture,
    tasks: [fixture.tasks[0]!, { ...fixture.tasks[0]!, taskId: nextId, ordinal: 1 }],
    attempts: [{ ...fixture.attempts[0]!, modality: "dont_remember", taskState: "answered", feedback: { kind: "incorrect", correctText: "cat" } }],
    disclosure: { taskId, stepId: "hint", kind: "hint", reveal: { target: "cat" } },
  });
  await openTask(page);
  await page.getByTestId("kid-not-remember").click();
  await expect(page.getByTestId("kid-reveal")).toContainText("cat");
  let releaseNext!: () => void;
  const nextGate = new Promise<void>((resolve) => { releaseNext = resolve; });
  let nextRequested = false;
  await page.route(`**/api/v1/kid/sessions/${sessionId}/next`, async (route) => {
    nextRequested = true;
    await nextGate;
    await route.fallback();
  });
  await page.getByTestId("kid-next").click();
  await expect.poll(() => nextRequested).toBe(true);
  await expect(page.getByTestId("kid-reveal")).toContainText("cat");
  await expect(page.getByTestId("kid-input")).toHaveCount(0);
  await expect(page.getByTestId("kid-next")).toBeDisabled();
  releaseNext();
  await expect(page.locator(".kid-learning")).toHaveAttribute("data-task-id", nextId);
  await expect(page.getByTestId("kid-feedback")).toHaveCount(0);
  await expect(page.getByTestId("kid-input")).toBeEditable();
  await page.getByTestId("kid-input").fill("cat");
  await expect(page.getByTestId("kid-submit")).toBeEnabled();
});

test("written feedback appears in a dock without replacing the stimulus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installKidUiFixture(page, completedRecallFixture());
  await openTask(page);

  const materialBefore = await page.getByTestId("kid-material").boundingBox();
  await page.getByTestId("kid-input").fill("cat");
  await page.getByTestId("kid-submit").click();

  const dock = page.getByTestId("kid-feedback-dock");
  await expect(dock).toBeVisible();
  await expect(dock.getByTestId("kid-feedback")).toBeVisible();
  await expect(dock.getByTestId("kid-next")).toBeVisible();
  // Bodziec zadania pozostaje w widoku po ocenie.
  await expect(page.getByTestId("kid-source")).toHaveText("kot");
  const materialAfter = await page.getByTestId("kid-material").boundingBox();
  expect(Math.abs(materialAfter!.y - materialBefore!.y)).toBeLessThanOrEqual(2);
  expect(Math.abs(materialAfter!.x - materialBefore!.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(materialAfter!.height - materialBefore!.height)).toBeLessThanOrEqual(2);
  // Dokładnie jedna główna akcja w docku i dock w całości w viewporcie.
  await expect(dock.getByTestId("kid-next")).toHaveCount(1);
  await expect.poll(async () => {
    const box = await dock.boundingBox();
    return box ? Math.round(box.y + box.height) : Number.POSITIVE_INFINITY;
  }, { message: "dock settles within the viewport after its transition" }).toBeLessThanOrEqual(845);
  await expect(page.getByTestId("kid-next")).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test("choice feedback dock does not overlap the options", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await installKidUiFixture(page, completedReadingFixture());
  await openTask(page);

  const options = page.getByTestId("kid-option");
  await expect(options).toHaveCount(3);
  const before = await options.evaluateAll((elements) => elements.map((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  }));
  await options.first().click();

  const dock = page.getByTestId("kid-feedback-dock");
  await expect(dock).toBeVisible();
  await expect(page.getByTestId("kid-feedback")).toContainText("Świetnie");
  await expect.poll(async () => {
    const box = await dock.boundingBox();
    return box ? Math.abs(box.y + box.height - 640) : Number.POSITIVE_INFINITY;
  }, { message: "dock settles at the viewport bottom" }).toBeLessThanOrEqual(24);
  const after = await options.evaluateAll((elements) => elements.map((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  }));
  after.forEach((box, index) => {
    expect(Math.abs(box.y - before[index]!.y), `option ${index} moved`).toBeLessThanOrEqual(2);
    expect(Math.abs(box.x - before[index]!.x), `option ${index} moved`).toBeLessThanOrEqual(2);
  });
  const dockBox = await dock.boundingBox();
  const lastOption = after.at(-1)!;
  expect(dockBox!.y).toBeGreaterThanOrEqual(lastOption.y + lastOption.height - 1);
  await expect(dock.getByTestId("kid-next")).toBeInViewport();
});

test("incorrect written feedback retries with an empty, focused input", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = completedRecallFixture();
  fixture.attempts = [{ ...fixture.attempts[0]!, feedback: { kind: "incorrect" as const, correctText: "cat" }, taskState: "issued" as const }] as unknown as typeof fixture.attempts;
  await installKidUiFixture(page, fixture);
  await openTask(page);

  await page.getByTestId("kid-input").fill("dog");
  await page.getByTestId("kid-submit").click();
  const dock = page.getByTestId("kid-feedback-dock");
  await expect(dock).toBeVisible();
  await expect(dock).toHaveAttribute("data-tone", "incorrect");
  await dock.getByTestId("kid-next").click();
  await expect(dock).toHaveCount(0);
  await expect(page.getByTestId("kid-input")).toHaveValue("");
  await expect(page.getByTestId("kid-input")).toBeFocused();
  await expect(page.getByTestId("kid-submit")).toBeDisabled();
});

test("choice feedback dock fits tablet and desktop viewports", async ({ page }) => {
  // 1440x960 zooms by 1.06; the dock and options are compared with each other and the window, all in screen pixels.
  for (const viewport of [{ width: 768, height: 1024, scale: 1 }, { width: 1440, height: 960, scale: 1.06 }]) {
    await page.setViewportSize(viewport);
    await installKidUiFixture(page, completedReadingFixture());
    await openTask(page);
    await waitForKidScale(page, viewport.scale);
    await page.getByTestId("kid-option").first().click();
    const dock = page.getByTestId("kid-feedback-dock");
    await expect(dock).toBeVisible();
    await expect(dock.getByTestId("kid-next")).toBeInViewport();
    await expect.poll(async () => {
      const box = await dock.boundingBox();
      return box ? Math.round(box.y + box.height) : 99999;
    }, { message: "dock settles within the viewport" }).toBeLessThanOrEqual(viewport.height + 1);
    const geometry = await page.evaluate(() => {
      const dockBox = document.querySelector<HTMLElement>("[data-testid='kid-feedback-dock']")!.getBoundingClientRect();
      const options = [...document.querySelectorAll<HTMLElement>("[data-testid='kid-option']")].map((el) => el.getBoundingClientRect());
      return { dockTop: dockBox.top, dockBottom: dockBox.bottom, lastOptionBottom: Math.max(...options.map((b) => b.bottom)), overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    });
    expect(geometry.dockTop, JSON.stringify({ viewport, geometry })).toBeGreaterThanOrEqual(geometry.lastOptionBottom - 1);
    expect(geometry.dockBottom).toBeLessThanOrEqual(viewport.height + 1);
    expect(geometry.overflow).toBe(false);
  }
});

test("dock stays reachable after the viewport shrinks and long feedback fits a small screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = completedRecallFixture();
  fixture.attempts = [{ ...fixture.attempts[0]!, feedback: { kind: "incorrect" as const, correctText: "antidisestablishmentarianism" }, taskState: "issued" as const }] as unknown as typeof fixture.attempts;
  await installKidUiFixture(page, fixture);
  await openTask(page);
  await page.getByTestId("kid-input").fill("dog");
  await page.getByTestId("kid-submit").click();
  const dock = page.getByTestId("kid-feedback-dock");
  await expect(dock).toBeVisible();
  await expect(dock.getByTestId("kid-next")).toBeInViewport();

  // Klawiatura ekranowa / rotacja: materiał zmienia rozmiar i korekta
  // musi policzyć się jeszcze raz dla tego samego docka.
  const scrollBeforeShrink = await page.evaluate(() => document.querySelector<HTMLElement>("[data-testid='kid-material']")!.scrollTop);
  await page.setViewportSize({ width: 390, height: 480 });
  await expect.poll(async () => {
    const dockBox = await dock.boundingBox();
    const inputBox = await page.getByTestId("kid-input").boundingBox();
    if (!dockBox || !inputBox) return 9999;
    return Math.round(Math.max(dockBox.y + dockBox.height - 480, inputBox.y + inputBox.height - dockBox.y));
  }, { message: "dock and input settle above each other after the shrink" }).toBeLessThanOrEqual(1);
  await expect(dock.getByTestId("kid-next")).toBeInViewport();
  await expect(dock.getByTestId("kid-next")).toBeEnabled();
  // Dowód ponownej korekty: materiał faktycznie przewinął się po zmianie rozmiaru.
  const scrollAfterShrink = await page.evaluate(() => document.querySelector<HTMLElement>("[data-testid='kid-material']")!.scrollTop);
  expect(scrollAfterShrink, "material scrolls when the viewport shrinks under the dock").toBeGreaterThan(scrollBeforeShrink);
  const padAfterShrink = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector<HTMLElement>(".kid-material-content")!).paddingBottom));
  expect(padAfterShrink, "dock reserve (padding) is applied after the shrink").toBeGreaterThanOrEqual(24);

  await page.setViewportSize({ width: 360, height: 640 });
  await expect.poll(async () => {
    const dockBox = await dock.boundingBox();
    return dockBox ? Math.round(dockBox.y + dockBox.height) : 99999;
  }, { message: "long feedback dock settles within 360x640" }).toBeLessThanOrEqual(641);
  await expect(dock.getByTestId("kid-next")).toBeInViewport();
});

test("feedback dock stays reachable on a short landscape screen with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 640, height: 360 });
  await installKidUiFixture(page, completedRecallFixture());
  await openTask(page);

  await page.getByTestId("kid-input").fill("cat");
  await page.getByTestId("kid-submit").click();

  const dock = page.getByTestId("kid-feedback-dock");
  await expect(dock).toBeVisible();
  await expect(dock.getByTestId("kid-next")).toBeInViewport();
  await expect(dock.getByTestId("kid-next")).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  const animation = await dock.evaluate((element) => {
    const style = getComputedStyle(element);
    return { name: style.animationName, duration: style.animationDuration };
  });
  expect(animation.name === "none" || animation.duration === "0s", JSON.stringify(animation)).toBe(true);
});

test("dock reveals after viewport mode changes and does not jump again on repeated updates", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installDockRevealSpy(page);
  await installKidUiFixture(page, completedRecallFixture());
  await openTask(page);
  await page.getByTestId("kid-input").fill("cat");
  await page.getByTestId("kid-submit").click();
  const dock = page.getByTestId("kid-feedback-dock");
  await expect(dock).toBeVisible();

  await page.locator(".kid-page").evaluate((element) => element.setAttribute("data-zoomed", "true"));
  await expect(page.locator(".kid-page")).toHaveAttribute("data-zoomed", "true");
  await expect.poll(() => dockRevealCalls(page)).toBe(1);

  const pageScroll = await page.locator(".kid-page").evaluate((element) => element.scrollTop);
  await page.locator(".kid-page").evaluate((element) => element.setAttribute("data-zoomed", "true"));
  await expect.poll(() => dockRevealCalls(page)).toBe(1);
  expect(await page.locator(".kid-page").evaluate((element) => element.scrollTop)).toBe(pageScroll);
});

type ToneCase = {
  tone: "correct" | "partial" | "incorrect" | "technical";
  icon: "check" | "almost" | "close" | "info";
  feedback: { kind: "great" } | { kind: "almost" } | { kind: "incorrect"; correctText: string } | { kind: "not_assessed" };
  background: `--${string}`;
  foreground: `--${string}`;
};

const toneCases: ToneCase[] = [
  { tone: "correct", icon: "check", feedback: { kind: "great" }, background: "--kid-color-success-container", foreground: "--kid-color-on-success-container" },
  { tone: "partial", icon: "almost", feedback: { kind: "almost" }, background: "--kid-color-warm-container", foreground: "--kid-color-on-warm-container" },
  { tone: "incorrect", icon: "close", feedback: { kind: "incorrect", correctText: "cat" }, background: "--md-sys-color-error-container", foreground: "--md-sys-color-on-error-container" },
  { tone: "technical", icon: "info", feedback: { kind: "not_assessed" }, background: "--md-sys-color-surface-container-high", foreground: "--md-sys-color-on-surface" },
];

/** WCAG contrast of the element's text against the dock behind it (the title itself is transparent). */
async function titleContrastOnDock(title: import("@playwright/test").Locator, dock: import("@playwright/test").Locator) {
  const [color, background] = await Promise.all([
    title.evaluate((node) => getComputedStyle(node).color),
    dock.evaluate((node) => getComputedStyle(node).backgroundColor),
  ]);
  const luminance = (value: string) => {
    const [red, green, blue] = value.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((channel) => {
      const unit = channel / 255;
      return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    });
    return red! * 0.2126 + green! * 0.7152 + blue! * 0.0722;
  };
  const text = luminance(color);
  const back = luminance(background);
  return { ratio: (Math.max(text, back) + 0.05) / (Math.min(text, back) + 0.05), color, background };
}

for (const viewport of [{ width: 360, height: 800 }, { width: 844, height: 390 }]) {
  test(`each feedback tone keeps readable text and its icon (${viewport.width}x${viewport.height})`, async ({ page }) => {
    for (const toneCase of toneCases) {
      const fixture = completedRecallFixture();
      fixture.attempts = [{ ...fixture.attempts[0]!, feedback: toneCase.feedback, taskState: "issued" as const }] as unknown as typeof fixture.attempts;
      await installKidUiFixture(page, fixture);
      await page.setViewportSize(viewport);
      await openTask(page);
      await page.getByTestId("kid-input").fill("cat");
      await page.getByTestId("kid-submit").click();

      const dock = page.getByTestId("kid-feedback-dock");
      await expect(dock).toHaveAttribute("data-tone", toneCase.tone);
      await resizeAndSettle(page, viewport);
      const badge = dock.getByTestId("kid-feedback-tone-icon");
      await expect(badge).toBeVisible();
      await expect(badge).toHaveAttribute("data-icon", toneCase.icon);
      // The badge is a circle: 40 px, or 32 px in the one-row compact dock.
      const badgeBox = await badge.boundingBox();
      expect(badgeBox!.width, `${toneCase.tone} badge`).toBeGreaterThanOrEqual(32);
      expect(Math.abs(badgeBox!.width - badgeBox!.height)).toBeLessThanOrEqual(1);

      const title = dock.getByTestId("kid-feedback").locator(".kid-feedback-text");
      await expect.poll(() => title.evaluate((node) => getComputedStyle(node).opacity), { message: "title finishes its fade-in" }).toBe("1");
      const contrast = await titleContrastOnDock(title, dock);
      expect(contrast.ratio, `${toneCase.tone}: ${JSON.stringify(contrast)}`).toBeGreaterThanOrEqual(4.5);
      // The dock carries the tone's container role pair, not the neutral surface.
      expect(contrast.background).toBe(await kidTokenColor(page, toneCase.background));
      expect(contrast.color).toBe(await kidTokenColor(page, toneCase.foreground));

      const next = dock.getByTestId("kid-next");
      await expect(next).toBeInViewport();
      const action = await next.boundingBox();
      expect(action!.height, `${toneCase.tone} primary action height`).toBeGreaterThanOrEqual(54);
      expect(action!.y + action!.height).toBeLessThanOrEqual(viewport.height + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);

      if (process.env.UMIEM_FEEDBACK_SHOTS) {
        await page.screenshot({ path: `${process.env.UMIEM_FEEDBACK_SHOTS}/dock-${toneCase.tone}-${viewport.width}x${viewport.height}.png` });
      }
    }
  });
}

for (const viewport of [{ width: 360, height: 800 }, { width: 320, height: 640 }]) {
  test(`the guidance button in the feedback dock keeps its geometry (${viewport.width}x${viewport.height})`, async ({ page }) => {
    const fixture = pictureVocabularyFixture();
    fixture.tasks = [fixture.tasks[1]!, null];
    const audioId = "20000000-0000-4000-8000-000000000001";
    fixture.uiAudio = { ready: true, assets: { listening: audioId, correct: audioId } };
    await installKidUiFixture(page, fixture);
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.getByTestId("kid-profile").click();
    await page.getByTestId("kid-deck").first().click();
    await page.getByTestId("kid-option").first().click();

    const dock = page.getByTestId("kid-feedback-dock");
    await expect(dock.getByTestId("kid-guidance-play")).toBeVisible();
    await resizeAndSettle(page, viewport);
    await expect.poll(async () => {
      const box = await dock.boundingBox();
      return box ? Math.round(box.y + box.height) : 99999;
    }, { message: "dock settles within the viewport" }).toBeLessThanOrEqual(viewport.height + 1);
    const layout = await measure(page, {
      dock: "[data-testid='kid-feedback-dock']",
      guidance: "[data-testid='kid-feedback-dock'] [data-testid='kid-guidance-play']",
      title: "[data-testid='kid-feedback-dock'] .kid-feedback-text",
    });
    expect(layout.guidance.width, "guidance width").toBeGreaterThanOrEqual(48);
    expect(layout.guidance.height, "guidance height").toBeGreaterThanOrEqual(48);
    expect(layout.guidance.left).toBeGreaterThanOrEqual(layout.dock.left - 1);
    expect(layout.guidance.right).toBeLessThanOrEqual(layout.dock.right + 1);
    expect(layout.guidance.top).toBeGreaterThanOrEqual(layout.dock.top - 1);
    expect(layout.guidance.bottom).toBeLessThanOrEqual(layout.dock.bottom + 1);
    const apart = layout.guidance.left >= layout.title.right - 1 || layout.guidance.right <= layout.title.left + 1
      || layout.guidance.top >= layout.title.bottom - 1 || layout.guidance.bottom <= layout.title.top + 1;
    expect(apart, `guidance intersects the title: ${JSON.stringify({ guidance: layout.guidance, title: layout.title })}`).toBe(true);
    const overflow = await dock.evaluate((node) => node.scrollWidth - node.clientWidth);
    expect(overflow, "dock horizontal overflow").toBeLessThanOrEqual(0);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth);
  });
}

test("spelling comparison uses the display font and underlines the wrong places", async ({ page }) => {
  const fixture = completedRecallFixture();
  const segment = (text: string, state: "plain" | "pill") => ({ text, state });
  fixture.attempts = [{ ...fixture.attempts[0]!, taskState: "issued" as const,
    feedback: { kind: "spelling_hint", correctText: "cat", spellingDiff: {
      given: [segment("c", "plain"), segment("o", "pill"), segment("t", "plain")],
      expected: [segment("c", "plain"), segment("a", "pill"), segment("t", "plain")],
      capitalizationHint: false,
    } } }] as unknown as typeof fixture.attempts;
  await installKidUiFixture(page, fixture);
  await page.setViewportSize({ width: 360, height: 800 });
  await openTask(page);
  await page.getByTestId("kid-input").fill("cot");
  await page.getByTestId("kid-submit").click();

  const dock = page.getByTestId("kid-feedback-dock");
  await expect(dock).toHaveAttribute("data-tone", "partial");
  const pills = dock.getByTestId("kid-spelling-pill");
  await expect(pills).toHaveCount(2);
  for (const pill of await pills.all()) {
    const style = await pill.evaluate((node) => {
      const computed = getComputedStyle(node);
      return { family: computed.fontFamily, line: computed.textDecorationLine, thickness: computed.textDecorationThickness };
    });
    expect(style.family, "pill font").toContain("KnowliKidNunito");
    expect(style.line, "pill underline").toContain("underline");
    expect(Number.parseFloat(style.thickness)).toBeGreaterThanOrEqual(2);
  }
  const layout = await measure(page, { dock: "[data-testid='kid-feedback-dock']", diff: "[data-testid='kid-spelling-diff']" });
  expect(layout.diff.left).toBeGreaterThanOrEqual(layout.dock.left - 1);
  expect(layout.diff.right).toBeLessThanOrEqual(layout.dock.right + 1);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth);
  await expect(dock.getByTestId("kid-next")).toBeInViewport();
  if (process.env.UMIEM_FEEDBACK_SHOTS) {
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${process.env.UMIEM_FEEDBACK_SHOTS}/dock-spelling-360x800.png` });
  }
});

/** Lekcja z jednym zadaniem luki i drugim po nim — wyjaśnienie ćwiczenia po błędzie (spec 2026-11-01 §6). */
const lessonIds = {
  childId: "10000000-0000-4000-8000-000000000a01",
  deckId: "10000000-0000-4000-8000-000000000a02",
  sessionId: "10000000-0000-4000-8000-000000000a03",
  deckVersionId: "10000000-0000-4000-8000-000000000a04",
};
const lessonGap = (n: number, stem: string): TaskDto => ({
  taskId: `10000000-0000-4000-8000-000000000a1${n}`, sessionId: lessonIds.sessionId, ordinal: n, exerciseType: "lesson_gap",
  direction: null, state: "issued", remainingAssessed: 2,
  prompt: { kind: "lesson_gap", instructionPl: "Uzupełnij lukę", stemWithGap: stem, hint: "(go)" },
});
const lessonTasks = [lessonGap(1, "He ___ to school."), lessonGap(2, "She ___ to work.")];
const lessonAttempt = (feedback: FeedbackDto, modality: AttemptDto["modality"] = "text"): AttemptDto => ({
  attemptId: "10000000-0000-4000-8000-000000000a31", taskId: lessonTasks[0]!.taskId, state: "completed", modality,
  taskState: "answered", stepId: "s1", receivedAt: "2026-10-31T10:00:01.000Z", completedAt: "2026-10-31T10:00:01.000Z",
  feedback,
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`the explanation text keeps the dock contrast on an incorrect result (${colorScheme} system theme)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await installKidUiFixture(page, {
      ...lessonAudioFixture(lessonIds, lessonTasks),
      attempts: [lessonAttempt({ kind: "incorrect", correctText: "He goes to school.", hintPl: "Po he dodajemy do czasownika końcówkę -s." })],
    });
    await openLessonTask(page, "kid-lesson-gap");
    await page.getByTestId("kid-lesson-gap-input").fill("go");
    await page.getByTestId("kid-lesson-check").click();
    const dock = page.getByTestId("kid-feedback-dock");
    await expect(dock).toHaveAttribute("data-tone", "incorrect");
    const text = dock.getByTestId("kid-explanation-text");
    await expect(text).toBeVisible();
    await expect.poll(() => dock.evaluate((node) => getComputedStyle(node).opacity), { message: "dock finishes its fade-in" }).toBe("1");
    const contrast = await titleContrastOnDock(text, dock);
    expect(contrast.ratio, `explanation (${colorScheme}): ${JSON.stringify(contrast)}`).toBeGreaterThanOrEqual(4.5);
    expect(contrast.color).toBe(await kidTokenColor(page, "--md-sys-color-on-error-container"));
    expect(contrast.background).toBe(await kidTokenColor(page, "--md-sys-color-error-container"));
    expect(await text.evaluate((node) => getComputedStyle(node).textAlign)).toBe("start");
    expect(await text.evaluate((node) => getComputedStyle(node).fontStyle)).toBe("normal");
  });
}

test("„Nie pamiętam” in a lesson without an explanation moves on as before", async ({ page }) => {
  await installKidUiFixture(page, {
    ...lessonAudioFixture(lessonIds, lessonTasks),
    attempts: [lessonAttempt({ kind: "incorrect", correctText: "He goes to school." }, "dont_remember")],
    disclosure: { taskId: lessonTasks[0]!.taskId, stepId: "d1", kind: "hint", reveal: { target: "goes" } },
  });
  await openLessonTask(page, "kid-lesson-gap");
  await page.getByTestId("kid-not-remember").click();
  await expect(page.getByTestId("kid-reveal")).toContainText("goes");
  await page.getByTestId("kid-next").click();
  await expect(page.getByTestId("kid-lesson-gap")).toContainText("She");
  await expect(page.getByTestId("kid-feedback-dock")).toHaveCount(0);
  await expect(page.getByTestId("kid-explanation-text")).toHaveCount(0);
});
