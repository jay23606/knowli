import { expect, test, type Page } from "@playwright/test";
import { messages, type AttemptDto, type PresentationCompletionDto, type SessionSummaryDto, type TaskDto } from "@learning/contracts";
import { kidStreakLength } from "../../packages/kid-ui/src/motion/kid-motion";
import { expectFrameFillsViewport, expectInteractiveTargets, lineLengths, nextFrames, waitForKidScale } from "./helpers/kid-frame";
import { installKidUiFixture, type KidUiFixture } from "./helpers/kid-ui-fixture";
import {
  endListenPlayback,
  expectReachableOnSmallPhone,
  LESSON_AUDIO_VIEWPORTS,
  lessonAudioFixture,
  listenAudioPausedCurrent,
  listenAudioPlays,
  openLessonTask,
  STORY_WORST_CASE,
  storyQuestionTask,
  storyTask,
  stubListenAudio,
  type ListenAudioMode,
} from "./helpers/lesson-audio";

/**
 * Historyjka na koniec sesji lekcji (spec 2026-11-01 §10 i §15, etap 3; API
 * zaślepione w przeglądarce): baner „Jeszcze N i historyjka!” na ostatnim
 * zadaniu ocenianym, historyjka z jednorazowym autoodtwarzaniem po
 * zamontowaniu panelu, powtórką na żądanie i przerwaniem przez „Dalej”,
 * brak odsłuchu bez nagrania, cichy błąd autoodtwarzania i komunikat błędu
 * ręcznego odsłuchu, pytania z wynikiem (dobra i zła odpowiedź), bez wpływu
 * na serię, a potem podsumowanie. Geometria najgorszego przypadku (700 znaków
 * historyjki, pytanie 160 znaków, opcje po 80) w portrecie, niskim landscape,
 * na tablecie, desktopie i przy skali 1,2. `HTMLMediaElement.play` jest
 * podmienione — test liczy wywołania, nie słyszy dźwięku: autoodtwarzanie na
 * fizycznym iPhonie/iPadzie (polityka Safari) zostaje niezweryfikowane.
 */

const ids = {
  childId: "10000000-0000-4000-8000-000000000c01",
  deckId: "10000000-0000-4000-8000-000000000c02",
  sessionId: "10000000-0000-4000-8000-000000000c03",
  deckVersionId: "10000000-0000-4000-8000-000000000c04",
};
const { sessionId } = ids;
const uid = (n: number) => `10000000-0000-4000-8000-000000000c${String(n).padStart(2, "0")}`;
const storyAudioAssetId = uid(90);
const storyId = uid(20);
const firstQuestionId = uid(21);
const secondQuestionId = uid(22);
const firstQuestionOptions = [uid(31), uid(32), uid(33)];
const secondQuestionOptions = [uid(34), uid(35), uid(36)];

/** Zadanie oceniane przed historyjką: wybór w sesji zamykanej historyjką. */
function assessedTask(index: number, remainingAssessed: number): TaskDto {
  return {
    taskId: uid(10 + index), sessionId, ordinal: index, exerciseType: "lesson_choice", direction: null, state: "issued",
    remainingAssessed, closingStory: true,
    prompt: {
      kind: "lesson_choice", instructionPl: "Wybierz właściwą formę.", stem: "He ___ football every day.",
      options: [{ id: uid(40 + 2 * index), text: "plays" }, { id: uid(41 + 2 * index), text: "play" }],
      contentLocale: "en-GB",
    },
  };
}

const story = (audio = true) => storyTask(sessionId, storyId, audio ? { audioAssetId: storyAudioAssetId } : {});
const firstQuestion = (audio = true) =>
  storyQuestionTask(sessionId, firstQuestionId, firstQuestionOptions, STORY_WORST_CASE, audio ? storyAudioAssetId : undefined);
const secondQuestion = storyQuestionTask(sessionId, secondQuestionId, secondQuestionOptions, STORY_WORST_CASE, storyAudioAssetId);

function attempt(n: number, taskId: string, feedback: AttemptDto["feedback"]): AttemptDto {
  return {
    attemptId: uid(60 + n), taskId, state: "completed", modality: "choice", feedback, taskState: "answered", stepId: `s${n}`,
    receivedAt: "2026-11-02T10:00:01.000Z", completedAt: "2026-11-02T10:00:01.000Z",
  };
}

const presentation: PresentationCompletionDto = { taskId: storyId, state: "completed", completedAt: "2026-11-02T10:00:02.000Z" };
const summary: SessionSummaryDto = {
  sessionId, state: "completed", tasksIssued: 4, assessedTasksIssued: 1,
  independentSuccesses: { recall: 0, spelling: 0 }, practiceItems: [], endedAt: "2026-11-02T10:01:00.000Z",
};

function fixture(tasks: (TaskDto | null)[], attempts: AttemptDto[], options: { audioReady?: boolean } = {}): KidUiFixture {
  return {
    ...lessonAudioFixture(ids, [], { audioReady: options.audioReady, assessedTasksIssued: 0 }),
    tasks, attempts, presentation, summary,
  };
}

/** Sesja z ostatnim zadaniem ocenianym, historyjką i dwoma pytaniami (dobra, potem zła odpowiedź). */
function closingSessionFixture(): KidUiFixture {
  return fixture([assessedTask(0, 1), story(), firstQuestion(), secondQuestion, null], [
    attempt(0, assessedTask(0, 1).taskId, { kind: "great" }),
    attempt(1, firstQuestionId, { kind: "great" }),
    attempt(2, secondQuestionId, { kind: "incorrect", correctText: STORY_WORST_CASE.options[0] }),
  ]);
}

async function open(page: Page, kidFixture: KidUiFixture, readyTestId: string, mode: ListenAudioMode | null = "end"): Promise<void> {
  if (mode !== null) await stubListenAudio(page, mode);
  await installKidUiFixture(page, kidFixture);
  await openLessonTask(page, readyTestId);
}

/** Odpowiada na bieżące zadanie oceniane (pierwsza opcja, wynik „Świetnie!”) i przechodzi dalej. */
async function answerAssessed(page: Page): Promise<void> {
  await page.getByTestId("kid-option").first().click();
  await expect(page.getByTestId("kid-feedback")).toContainText("Świetnie!");
  await page.getByTestId("kid-next").click();
}

function mediaRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/v1/media/")) requests.push(path);
  });
  return requests;
}

async function pageOverflows(page: Page): Promise<{ page: boolean; material: boolean }> {
  return page.evaluate(() => {
    const material = document.querySelector<HTMLElement>("[data-testid='kid-material']");
    return {
      page: document.documentElement.scrollWidth > window.innerWidth,
      material: material !== null && material.scrollWidth > material.clientWidth + 1,
    };
  });
}

/** Po przewinięciu do widoku element mieści się w oknie w całości. */
async function expectReachable(page: Page, testId: string, viewport: { width: number; height: number }, minHeight: number): Promise<void> {
  const label = `${testId} at ${viewport.width}x${viewport.height}`;
  const element = page.getByTestId(testId);
  await element.scrollIntoViewIfNeeded();
  const box = (await element.boundingBox())!;
  expect(box.y, `${label} top`).toBeGreaterThanOrEqual(-1);
  expect(box.y + box.height, `${label} bottom`).toBeLessThanOrEqual(viewport.height + 1);
  expect(box.x, `${label} left`).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width, `${label} right`).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.height, `${label} height`).toBeGreaterThanOrEqual(minHeight);
}

const GEOMETRY_VIEWPORTS: readonly { width: number; height: number; scale: number }[] = [
  ...LESSON_AUDIO_VIEWPORTS.map((viewport) => ({ ...viewport, scale: 1 })),
  { width: 1920, height: 1080, scale: 1.2 },
];

async function resizeTo(page: Page, viewport: { width: number; height: number; scale: number }): Promise<void> {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await waitForKidScale(page, viewport.scale);
  await nextFrames(page);
}

test("last assessed task announces the story", async ({ page }) => {
  await open(page, closingSessionFixture(), "kid-instruction");
  await expect(page.getByTestId("kid-remaining")).toHaveText("Jeszcze 1 i historyjka!");
});

test("story autoplays once after the last task and replays on demand", async ({ page }) => {
  await open(page, closingSessionFixture(), "kid-instruction", "hold");
  expect(await listenAudioPlays(page)).toBe(0);
  await answerAssessed(page);
  await expect(page.getByTestId("kid-lesson-story")).toBeVisible();
  // Historyjka nie zużywa budżetu: baner „Jeszcze 0” się nie pokazuje.
  await expect(page.getByTestId("kid-remaining")).toHaveCount(0);

  const listen = page.getByTestId("kid-question-audio");
  await expect(listen).toHaveAttribute("aria-label", "Posłuchaj historyjki");
  await expect.poll(() => listenAudioPlays(page)).toBe(1);
  // Autoodtwarzanie widać na przycisku, choć dziecko go nie dotknęło.
  await expect(listen).toHaveAttribute("data-sound-active", "true");
  await endListenPlayback(page);
  await expect(listen).not.toHaveAttribute("data-sound-active");
  await nextFrames(page);
  expect(await listenAudioPlays(page), "autoplay runs once").toBe(1);

  await listen.click();
  await expect.poll(() => listenAudioPlays(page)).toBe(2);
  await expect(listen).toHaveAttribute("data-sound-active", "true");
});

test("next stops the story playback", async ({ page }) => {
  await open(page, closingSessionFixture(), "kid-instruction", "hold");
  await answerAssessed(page);
  await expect.poll(() => listenAudioPlays(page)).toBe(1);
  await expect(page.getByTestId("kid-question-audio")).toHaveAttribute("data-sound-active", "true");
  expect(await listenAudioPausedCurrent(page)).toBe(false);

  await page.getByTestId("kid-lesson-next").click();
  await expect(page.locator(`main[data-task-id="${firstQuestionId}"]`)).toBeVisible();
  expect(await listenAudioPausedCurrent(page), "story playback paused by next").toBe(true);
  // Pytanie historyjki nie gra samo.
  await nextFrames(page);
  expect(await listenAudioPlays(page)).toBe(1);
});

test("story without a recording has no listen button and plays nothing", async ({ page }) => {
  const media = mediaRequests(page);
  await open(page, fixture([story(false), null], []), "kid-lesson-story");
  await expect(page.getByTestId("kid-instruction")).toContainText("Przeczytaj historyjkę.");
  await expect(page.getByTestId("kid-lesson-story-lead")).toHaveText("Potem odpowiesz na pytania.");
  await expect(page.getByTestId("kid-question-audio")).toHaveCount(0);
  await nextFrames(page);
  expect(await listenAudioPlays(page)).toBe(0);
  expect(media).toEqual([]);
});

test("story questions show the result and the correct answer", async ({ page }) => {
  await open(page, fixture([story(), firstQuestion(), secondQuestion, null], [
    attempt(1, firstQuestionId, { kind: "great" }),
    attempt(2, secondQuestionId, { kind: "incorrect", correctText: STORY_WORST_CASE.options[0] }),
  ]), "kid-lesson-story");
  await expect(page.getByTestId("kid-lesson-story-text")).toHaveAttribute("lang", "en-GB");
  await page.getByTestId("kid-lesson-next").click();

  await expect(page.locator(`main[data-task-id="${firstQuestionId}"]`)).toBeVisible();
  await expect(page.getByTestId("kid-instruction")).toContainText(STORY_WORST_CASE.question);
  await expect(page.getByTestId("kid-lesson-story-reread").getByTestId("kid-question-audio")).toHaveCount(1);
  await page.getByTestId("kid-option").first().click();
  await expect(page.getByTestId("kid-feedback")).toContainText("Świetnie!");
  // Przy wyniku nie ma drugiego głośnika: odsłuch historyjki znika.
  await expect(page.getByTestId("kid-question-audio")).toHaveCount(0);
  await page.getByTestId("kid-next").click();

  await expect(page.locator(`main[data-task-id="${secondQuestionId}"]`)).toBeVisible();
  await page.getByTestId("kid-option").nth(1).click();
  await expect(page.getByTestId("kid-feedback-correct-answer")).toHaveText(STORY_WORST_CASE.options[0]);
  await expect(page.getByTestId("kid-question-audio")).toHaveCount(0);
  await page.getByTestId("kid-next").click();
  await expect(page.getByTestId("kid-summary")).toBeVisible();
});

test("story answers do not grow the streak", async ({ page }) => {
  // Seria poprawnych zadań ocenianych tuż przed historyjką: jeszcze jedna poprawna odpowiedź dałaby kamień milowy.
  const before = kidStreakLength - 1;
  const assessed = Array.from({ length: before }, (_, index) => assessedTask(index, before - index));
  await open(page, fixture([...assessed, story(false), firstQuestion(false), null], [
    ...assessed.map((task, index) => attempt(10 + index, task.taskId, { kind: "great" })),
    attempt(1, firstQuestionId, { kind: "great" }),
  ]), "kid-instruction");
  for (let index = 0; index < before; index += 1) await answerAssessed(page);
  await expect(page.getByTestId("kid-lesson-story")).toBeVisible();
  const stars = page.getByTestId("kid-streak-star");
  await expect(stars).toHaveCount(0);

  await page.getByTestId("kid-lesson-next").click();
  await expect(page.locator(`main[data-task-id="${firstQuestionId}"]`)).toBeVisible();
  await page.getByTestId("kid-option").first().click();
  await expect(page.getByTestId("kid-feedback")).toContainText("Świetnie!");
  await nextFrames(page);
  await expect(stars).toHaveCount(0);
});

test("story playback error shows the story message and keeps next reachable", async ({ page }) => {
  // Bez atrapy odtwarzania: `/media` daje obrazek SVG, którego przeglądarka nie zdekoduje.
  const media = mediaRequests(page);
  await open(page, fixture([story(), null], [], { audioReady: false }), "kid-lesson-story", null);
  // Autoodtwarzanie próbuje pobrać nagranie, ale błąd jest cichy.
  await expect.poll(() => media).toContain(`/api/v1/media/${storyAudioAssetId}`);
  await page.waitForTimeout(500);
  await expect(page.getByTestId("kid-question-audio-error")).toHaveCount(0);

  await page.getByTestId("kid-question-audio").click();
  await expect(page.getByTestId("kid-question-audio-error")).toContainText(messages.kid.storyAudioUnavailable);
  await expect(page.getByTestId("kid-question-audio-retry")).toHaveText(messages.kid.storyAudioRetry);
  await page.setViewportSize({ width: 320, height: 480 });
  await expectReachableOnSmallPhone(page, { "kid-question-audio-retry": 48, "kid-lesson-next": 54 });
});

test.describe("geometry", () => {
  test("story view fits every form factor", async ({ page }, testInfo) => {
    await open(page, fixture([story(), null], []), "kid-lesson-story");
    for (const viewport of GEOMETRY_VIEWPORTS) {
      const label = `${viewport.width}x${viewport.height}`;
      await resizeTo(page, viewport);
      expect(await pageOverflows(page), `horizontal overflow at ${label}`).toEqual({ page: false, material: false });
      await expectFrameFillsViewport(page, viewport);
      await expectInteractiveTargets(page, ['[data-testid="kid-lesson-next"]', '[data-testid="kid-question-audio"]']);
      // Przy bardzo niskim oknie treść może się przewijać, ale „Dalej” jest osiągalne.
      await expectReachable(page, "kid-lesson-next", viewport, 54);
      const lines = await lineLengths(page, '[data-testid="kid-lesson-story-text"]');
      expect(lines.length, `story lines at ${label}`).toBeGreaterThan(1);
      for (const length of lines) expect(length, `story line length at ${label}`).toBeLessThanOrEqual(70);
      await page.screenshot({ path: testInfo.outputPath(`story-${label}.png`) });
    }
  });

  test("longest story keeps listen and next reachable at 320x480", async ({ page }, testInfo) => {
    await open(page, fixture([story(), null], []), "kid-lesson-story");
    await page.setViewportSize({ width: 320, height: 480 });
    await expectReachableOnSmallPhone(page, { "kid-question-audio": 48, "kid-lesson-next": 54 });
    await page.screenshot({ path: testInfo.outputPath("story-320x480.png") });
  });

  test("story question keeps the first option visible without scrolling", async ({ page }, testInfo) => {
    await open(page, fixture([firstQuestion(), null], [
      attempt(1, firstQuestionId, { kind: "incorrect", correctText: STORY_WORST_CASE.options[0] }),
    ]), "kid-lesson-story-reread");
    for (const viewport of GEOMETRY_VIEWPORTS) {
      const label = `${viewport.width}x${viewport.height}`;
      await resizeTo(page, viewport);
      await expectFrameFillsViewport(page, viewport);
      // Nic nie jest przewinięte: pomiar „bez przewijania”.
      expect(await page.evaluate(() => window.scrollY +
        [...document.querySelectorAll("*")].filter((element) => element.scrollTop > 0).length), `scrolled at ${label}`).toBe(0);
      const first = (await page.getByTestId("kid-option").first().boundingBox())!;
      expect(first.y, `first option top at ${label}`).toBeGreaterThanOrEqual(0);
      expect(first.y + first.height, `first option bottom at ${label}`).toBeLessThanOrEqual(viewport.height + 1);
      expect(first.x + first.width, `first option right at ${label}`).toBeLessThanOrEqual(viewport.width + 1);
      expect(await pageOverflows(page), `horizontal overflow at ${label}`).toEqual({ page: false, material: false });
      await expectInteractiveTargets(page, ['[data-testid="kid-option"]', '[data-testid="kid-question-audio"]']);
      await page.screenshot({ path: testInfo.outputPath(`story-question-${label}.png`) });
    }

    await resizeTo(page, GEOMETRY_VIEWPORTS[1]!);
    await page.getByTestId("kid-option").nth(1).click();
    await expect(page.getByTestId("kid-feedback-correct-answer")).toHaveText(STORY_WORST_CASE.options[0]);
    for (const viewport of GEOMETRY_VIEWPORTS) {
      const label = `${viewport.width}x${viewport.height}`;
      await resizeTo(page, viewport);
      await expectReachable(page, "kid-next", viewport, 48);
      expect(await pageOverflows(page), `horizontal overflow with the result at ${label}`).toEqual({ page: false, material: false });
      await page.screenshot({ path: testInfo.outputPath(`story-question-result-${label}.png`) });
    }
  });
});
