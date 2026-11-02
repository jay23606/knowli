import { expect, test } from "@playwright/test";
import { installKidUiFixture, type KidUiFixture } from "./helpers/kid-ui-fixture";
import { completedRecallFixture } from "./helpers/kid-fixtures";
import { boxes, expectRectsUnchanged, nextFrames } from "./helpers/kid-frame";
import { lessonAudioFixture, listenChoiceTask, openLessonTask, stubListenAudio } from "./helpers/lesson-audio";

const childId = "10000000-0000-4000-8000-000000000001";
const deckId = "10000000-0000-4000-8000-000000000002";
const sessionId = "10000000-0000-4000-8000-000000000003";
const taskId = "10000000-0000-4000-8000-000000000004";
const attemptId = "10000000-0000-4000-8000-000000000010";
const optionIds = ["10000000-0000-4000-8000-000000000007", "10000000-0000-4000-8000-000000000008", "10000000-0000-4000-8000-000000000009"];

function recallFixture() {
  const processing = {
    attemptId,
    taskId,
    state: "processing" as const,
    modality: "text" as const,
    feedback: null,
    taskState: "issued" as const,
    stepId: null,
    receivedAt: "2026-10-11T10:00:00.000Z",
    completedAt: null,
  };
  return {
    profiles: [{ childId, displayName: "Szymon", avatarKey: "cat", recordingMode: "hold" as const }],
    decks: [{ deckId, title: "Dni tygodnia", itemCount: 7, independentlyRecalledCount: 0, testDate: null,
      recommended: true, mockTestAvailable: false, activeSession: null }],
    session: { mode: "training" as const, sessionId, childId, deckId, deckVersionId: "10000000-0000-4000-8000-000000000005",
      policyId: "default", microphoneEnabled: false, state: "active" as const, taskBudget: 1, tasksIssued: 1,
      assessedTasksIssued: 1, startedAt: "2026-10-11T10:00:00.000Z", resumed: false },
    tasks: [{ taskId, sessionId, ordinal: 0, exerciseType: "recall" as const, direction: "source_to_target" as const,
      state: "issued" as const, prompt: { kind: "recall" as const, prompt: "kot" }, remainingAssessed: 1 }],
    attempts: [processing, processing, {
      ...processing,
      state: "completed" as const,
      feedback: { kind: "great" as const },
      taskState: "completed" as const,
      stepId: null,
      completedAt: "2026-10-11T10:00:01.000Z",
    }],
  };
}

function completedReadingFixture() {
  const base = recallFixture();
  return {
    ...base,
    tasks: [{ taskId, sessionId, ordinal: 0, exerciseType: "reading" as const, direction: "target_to_source" as const,
      state: "issued" as const, prompt: { kind: "reading" as const, text: "cat",
        options: ["kot", "pies", "ptak"].map((text, index) => ({ id: optionIds[index]!, text })) }, remainingAssessed: 1 }],
    attempts: [{ attemptId, taskId, state: "completed" as const, modality: "choice" as const,
      feedback: { kind: "great" as const }, taskState: "completed" as const, stepId: null,
      receivedAt: "2026-10-11T10:00:00.000Z", completedAt: "2026-10-11T10:00:01.000Z" }],
  };
}

test("processing status does not move task slots", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installKidUiFixture(page, recallFixture());
  await page.goto("/");
  await page.getByTestId("kid-profile").click();
  await page.getByTestId("kid-deck").click();

  const bounds = async () => {
    const frame = await page.getByTestId("kid-exercise").boundingBox();
    const instruction = await page.getByTestId("kid-instruction").boundingBox();
    const material = await page.getByTestId("kid-material").boundingBox();
    expect(frame).not.toBeNull();
    expect(instruction).not.toBeNull();
    expect(material).not.toBeNull();
    return { frame: frame!, instruction: instruction!, material: material! };
  };
  const before = await bounds();
  await page.getByTestId("kid-input").fill("cat");
  await page.getByTestId("kid-submit").click();
  await expect(page.getByTestId("kid-processing")).toBeVisible();
  const during = await bounds();
  const status = await page.getByTestId("kid-session-status").boundingBox();
  const processing = await page.getByTestId("kid-processing").boundingBox();
  expect(processing!.y).toBeGreaterThanOrEqual(status!.y - 1);
  expect(processing!.y + processing!.height).toBeLessThanOrEqual(status!.y + status!.height + 1);

  for (const key of ["frame", "instruction", "material"] as const) {
    expect(Math.abs(during[key].y - before[key].y), `${key} moved vertically during processing`).toBeLessThanOrEqual(2);
    expect(Math.abs(during[key].height - before[key].height), `${key} changed height during processing`).toBeLessThanOrEqual(2);
  }
  await expect(page.getByTestId("kid-feedback")).toBeVisible();
});

test("typing preserves the exercise frame", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await installKidUiFixture(page, recallFixture());
  await page.goto("/");
  await page.getByTestId("kid-profile").click();
  await page.getByTestId("kid-deck").click();
  const frame = page.getByTestId("kid-exercise");
  const before = await frame.boundingBox();
  await page.getByTestId("kid-input").fill("cat");
  const shortAnswer = await frame.boundingBox();
  await page.getByTestId("kid-input").fill("an exceptionally long answer for the same prompt");
  const longAnswer = await frame.boundingBox();
  expect(before).not.toBeNull();
  expect(shortAnswer).not.toBeNull();
  expect(longAnswer).not.toBeNull();
  for (const after of [shortAnswer!, longAnswer!]) {
    expect(Math.abs(after.y - before!.y)).toBeLessThanOrEqual(2);
    expect(Math.abs(after.height - before!.height)).toBeLessThanOrEqual(2);
  }
});

test("written feedback keeps the material and primary action position", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installKidUiFixture(page, completedRecallFixture());
  await page.goto("/");
  await page.getByTestId("kid-profile").click();
  await page.getByTestId("kid-deck").click();

  const material = page.getByTestId("kid-material");
  const materialBefore = await material.boundingBox();
  const actionBefore = await page.getByTestId("kid-submit").boundingBox();
  await page.getByTestId("kid-input").fill("cat");
  await page.getByTestId("kid-submit").click();
  await expect(page.getByTestId("kid-feedback")).toBeVisible();
  const materialAfter = await material.boundingBox();
  await expect(page.getByTestId("kid-next")).toBeInViewport();
  const dockBox = await page.getByTestId("kid-feedback-dock").boundingBox();
  const actionAfter = await page.getByTestId("kid-next").boundingBox();

  expect(materialBefore).not.toBeNull();
  expect(materialAfter).not.toBeNull();
  expect(actionBefore).not.toBeNull();
  expect(actionAfter).not.toBeNull();
  expect(Math.abs(materialAfter!.y - materialBefore!.y), "material top moved").toBeLessThanOrEqual(2);
  expect(Math.abs(materialAfter!.height - materialBefore!.height),
    `material height changed from ${materialBefore!.height} to ${materialAfter!.height}`).toBeLessThanOrEqual(2);
  expect(actionAfter!.y).toBeGreaterThanOrEqual(dockBox!.y);
  expect(actionAfter!.y + actionAfter!.height).toBeLessThanOrEqual(dockBox!.y + dockBox!.height + 1);
  // Slot akcji nie zmienia miejsca, a akcja docka kończy się dokładnie
  // nad dolną krawędzią panelu (padding 10, bez pustego wiersza secondary).
  const slotAfter = await page.getByTestId("kid-primary-slot").boundingBox();
  expect(slotAfter).not.toBeNull();
  expect(Math.abs(slotAfter!.y - actionBefore!.y), "primary slot moved").toBeLessThanOrEqual(2);
  await expect.poll(async () => {
    const action = await page.getByTestId("kid-next").boundingBox();
    const dockNow = await page.getByTestId("kid-feedback-dock").boundingBox();
    return action && dockNow ? Math.abs(Math.round((action.y + action.height) - (dockNow.y + dockNow.height - 10))) : 999;
  }, { message: "dock action settles exactly above the dock bottom edge" }).toBeLessThanOrEqual(2);

});

test("choice feedback keeps each option in place", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installKidUiFixture(page, completedReadingFixture());
  await page.goto("/");
  await page.getByTestId("kid-profile").click();
  await page.getByTestId("kid-deck").click();

  const options = page.getByTestId("kid-option");
  await expect(options).toHaveCount(3);
  const before = await options.evaluateAll((elements) => elements.map((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  }));
  await options.first().click();
  await expect(page.getByTestId("kid-feedback")).toContainText("Świetnie");
  const feedbackMetrics = await page.getByTestId("kid-feedback").locator(".kid-feedback-content").evaluate((element) => {
    const title = element.querySelector<HTMLElement>(".kid-feedback-text");
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      titleHeight: title?.getBoundingClientRect().height,
      titleFontSize: title ? getComputedStyle(title).fontSize : null,
      titleLineHeight: title ? getComputedStyle(title).lineHeight : null,
    };
  });
  expect(feedbackMetrics.scrollHeight, JSON.stringify(feedbackMetrics)).toBeLessThanOrEqual(feedbackMetrics.clientHeight);
  const after = await options.evaluateAll((elements) => elements.map((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  }));
  expect(after).toHaveLength(before.length);
  after.forEach((box, index) => {
    expect(Math.abs(box.y - before[index]!.y), `option ${index} moved vertically`).toBeLessThanOrEqual(2);
    expect(Math.abs(box.x - before[index]!.x), `option ${index} moved horizontally`).toBeLessThanOrEqual(2);
  });
  await expect(page.getByTestId("kid-next")).toBeInViewport();
});

test("long choice labels keep their geometry when feedback markers appear", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  const fixture = completedReadingFixture();
  const task = fixture.tasks[0]!;
  if (task.prompt.kind !== "reading") throw new Error("reading fixture expected");
  task.prompt.options = [
    { id: optionIds[0]!, text: "mała zielona żaba na kamieniu" },
    { id: optionIds[1]!, text: "zielona papuga siedzi na gałęzi" },
    { id: optionIds[2]!, text: "niebieski motyl" },
  ];
  await installKidUiFixture(page, fixture);
  await page.goto("/");
  await page.getByTestId("kid-profile").click();
  await page.getByTestId("kid-deck").click();
  await expect(page.getByTestId("kid-exercise")).toBeVisible();

  const options = page.getByTestId("kid-option");
  await expect(options).toHaveCount(3);
  const before = await options.evaluateAll((elements) => elements.map((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  }));
  await options.first().click();
  await expect(options.first()).toHaveClass(/kid-option--correct/);
  const after = await options.evaluateAll((elements) => elements.map((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  }));

  after.forEach((box, index) => {
    expect(Math.abs(box.x - before[index]!.x), `option ${index} moved horizontally`).toBeLessThanOrEqual(2);
    expect(Math.abs(box.y - before[index]!.y), `option ${index} moved vertically`).toBeLessThanOrEqual(2);
    expect(Math.abs(box.height - before[index]!.height), `option ${index} changed height`).toBeLessThanOrEqual(2);
  });
});

for (const kind of ["reading", "listening", "lesson_choice"] as const) {
  test(`${kind}: long feedback leaves choices and actions reachable on short windows`, async ({ page }) => {
    const fixture: KidUiFixture = completedReadingFixture();
    const task = fixture.tasks[0]!;
    if (task.prompt.kind !== "reading") throw new Error("reading fixture expected");
    const options = task.prompt.options;
    fixture.tasks = [{ ...task, exerciseType: kind, prompt: kind === "reading" ? task.prompt
      : kind === "listening" ? { kind, options, audioAssetId: "10000000-0000-4000-8000-000000000012" }
        : { kind, options, instructionPl: "Wybierz odpowiedź", stem: "He ___ a cat." } }];
    fixture.attempts = [{ ...fixture.attempts![0]!, taskState: "issued",
      feedback: { kind: "incorrect", correctText: "Poprawna odpowiedź wymaga przeczytania dłuższego objaśnienia. ".repeat(8) } }];
    fixture.uiAudio = { ready: true, assets: {} };
    await installKidUiFixture(page, fixture);
    await page.setViewportSize({ width: 360, height: 500 });
    await page.goto("/");
    await page.getByTestId("kid-profile").click();
    await page.getByTestId("kid-deck").click();
    await expect(page.getByTestId("kid-exercise-actions")).toBeEmpty();
    await page.getByTestId("kid-option").first().click();
    await expect(page.getByTestId("kid-feedback-dock")).toBeVisible();

    await expect(page.locator(".kid-page")).toHaveAttribute("data-zoomed", "false");
      for (const option of await page.getByTestId("kid-option").all()) {
        await option.evaluate((element) => element.scrollIntoView({ block: "center" }));
        await expect(option).toBeInViewport({ ratio: 0.98 });
      }
      const next = page.getByTestId("kid-next");
      await next.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await expect(next).toBeInViewport({ ratio: 0.98 });
      const material = await page.getByTestId("kid-material").boundingBox();
      const dock = await page.getByTestId("kid-feedback-dock").boundingBox();
      expect(material!.y + material!.height).toBeLessThanOrEqual(dock!.y + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });
}

test("lesson_choice pictogram keeps geometry across viewports", async ({ page }) => {
  const fixture: KidUiFixture = completedReadingFixture();
  const task = fixture.tasks[0]!;
  fixture.tasks = [{ ...task, exerciseType: "lesson_choice", prompt: {
    kind: "lesson_choice", instructionPl: "Kto to jest? Wybierz.", visualSubject: "girl", stem: "___ is happy.",
    options: ["She", "He", "They"].map((text, index) => ({ id: optionIds[index]!, text })),
  } }];
  fixture.uiAudio = { ready: true, assets: {} };
  await installKidUiFixture(page, fixture);
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/");
  await page.getByTestId("kid-profile").click();
  await page.getByTestId("kid-deck").click();
  await expect(page.getByTestId("kid-lesson-visual")).toBeVisible();

  for (const viewport of [
    { width: 360, height: 640 },
    { width: 640, height: 360 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    // The previous viewport may have scrolled the material (options were
    // scrolled into view) and scroll anchoring can re-apply that offset
    // after the resize; let it settle, then measure from the top.
    await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      document.querySelector<HTMLElement>("[data-testid=kid-material]")!.scrollTop = 0;
    });
    const visual = await page.getByTestId("kid-lesson-visual").boundingBox();
    const material = await page.getByTestId("kid-material").boundingBox();
    const stem = await page.getByTestId("kid-lesson-stem").boundingBox();
    expect(visual, `visual at ${viewport.width}x${viewport.height}`).not.toBeNull();
    expect(material).not.toBeNull();
    expect(visual!.x).toBeGreaterThanOrEqual(material!.x - 1);
    expect(visual!.x + visual!.width).toBeLessThanOrEqual(material!.x + material!.width + 1);
    expect(visual!.y).toBeGreaterThanOrEqual(material!.y - 1);
    expect(visual!.y + visual!.height).toBeLessThanOrEqual(stem!.y + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    for (const option of await page.getByTestId("kid-option").all()) {
      const box = await option.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(48);
      await option.scrollIntoViewIfNeeded();
      await expect(option).toBeInViewport({ ratio: 0.95 });
    }
  }
});

/**
 * „Posłuchaj i wybierz” (spec 2026-11-01 §8): przycisk odsłuchu w poleceniu zostaje na miejscu po odpowiedzi
 * (odtwarza wtedy nagranie z feedbacku), a zdanie i opcje nie przesuwają się, gdy pojawia się dok wyniku.
 * Najgorszy przypadek treści (zdanie 193 znaki, 4 opcje); telefon i desktop.
 */
for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test(`lesson_listen_choice keeps the play button, sentence and options in place under the dock at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const listenTaskId = "10000000-0000-4000-8000-000000000041";
    const listenOptionIds = ["42", "43", "44", "45"].map((suffix) => `10000000-0000-4000-8000-0000000000${suffix}`);
    await stubListenAudio(page, "end");
    await installKidUiFixture(page, {
      ...lessonAudioFixture({ childId, deckId, sessionId, deckVersionId: "10000000-0000-4000-8000-000000000005" },
        [listenChoiceTask(sessionId, listenTaskId, listenOptionIds)]),
      disclosure: { taskId: listenTaskId, stepId: "d1", kind: "audio", reveal: null, audioAssetId: "10000000-0000-4000-8000-000000000046" },
      attempts: [{ attemptId, taskId: listenTaskId, state: "completed", modality: "choice", taskState: "answered", stepId: "s1",
        receivedAt: "2026-11-01T10:00:00.000Z", completedAt: "2026-11-01T10:00:01.000Z",
        feedback: { kind: "great", correctAudioAssetId: "10000000-0000-4000-8000-000000000047" } }],
    });
    await openLessonTask(page, "kid-lesson-stem");
    await page.setViewportSize(viewport);
    const options = page.getByTestId("kid-option");
    await expect(options).toHaveCount(4);
    for (const option of await options.all()) await expect(option).toBeEnabled();
    await page.evaluate(async () => { await document.fonts.ready; });
    await nextFrames(page);

    const measure = async () => ({
      play: await boxes(page, "[data-testid='kid-play']"),
      stem: await boxes(page, "[data-testid='kid-lesson-stem']"),
      options: await boxes(page, "[data-testid='kid-option']"),
    });
    const before = await measure();
    await options.first().click();
    await expect(page.getByTestId("kid-feedback-dock")).toBeVisible();
    await expect(page.getByTestId("kid-feedback")).toContainText("Świetnie");
    await expect(options.first()).toHaveClass(/kid-option--correct/);
    await nextFrames(page);
    const after = await measure();

    const label = `${viewport.width}x${viewport.height}`;
    expectRectsUnchanged(before.play, after.play, `play button under the dock at ${label}`, 2);
    expectRectsUnchanged(before.stem, after.stem, `sentence under the dock at ${label}`, 2);
    expectRectsUnchanged(before.options, after.options, `options under the dock at ${label}`, 2);
    await expect(page.getByTestId("kid-play")).toBeEnabled();
    await expect(page.getByTestId("kid-next")).toBeInViewport();
  });
}

test("choice selection and transition feedback appear while the answer request is still pending", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture: KidUiFixture = completedReadingFixture();
  await installKidUiFixture(page, fixture);
  // Opóźnienie rejestrujemy PO fixture'u, żeby przejął routing; `fallback()`
  // oddaje żądanie fixture'owi po wprowadzonym opóźnieniu.
  let releaseAttempt!: () => void;
  const pendingAttempt = new Promise<void>((resolve) => { releaseAttempt = resolve; });
  await page.route("**/api/v1/kid/tasks/*/attempts", async (route) => {
    await pendingAttempt;
    await route.fallback();
  });
  await page.goto("/");
  await page.getByTestId("kid-profile").click();
  await page.getByTestId("kid-deck").click();

  const option = page.getByTestId("kid-option").first();
  await option.scrollIntoViewIfNeeded();
  const before = await page.getByTestId("kid-exercise").boundingBox();
  expect(before).not.toBeNull();
  await option.click();

  await expect(option).toHaveClass(/kid-option--pending/);
  await expect(option).toHaveAttribute("aria-pressed", "true");
  await expect(option).not.toHaveClass(/kid-option--correct|kid-option--wrong/);
  await expect(page.getByTestId("kid-transitioning")).toHaveCount(0);
  const during = await page.getByTestId("kid-exercise").boundingBox();
  expect(during).not.toBeNull();
  expect(Math.abs(during!.x - before!.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(during!.y - before!.y)).toBeLessThanOrEqual(2);
  expect(Math.abs(during!.height - before!.height)).toBeLessThanOrEqual(2);

  releaseAttempt();
  await expect(page.getByTestId("kid-next")).toBeVisible();
  await expect(page.getByTestId("kid-next")).toBeInViewport();
  await expect(option).toHaveClass(/kid-option--correct/);
});

for (const kind of ["recall", "speech"] as const) {
test(`${kind} microphone phases keep exercise controls in place`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    let microphoneCalls = 0;
    const track = { kind: "audio", stop: () => undefined, addEventListener: () => undefined };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    const browserWindow = window as typeof window & { resolveMicrophonePreparation?: () => void };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => {
        microphoneCalls += 1;
        if (microphoneCalls === 1) {
          await new Promise<void>((resolve) => { browserWindow.resolveMicrophonePreparation = resolve; });
        }
        return stream;
      } },
    });
    // WR-02: uprawnienie mikrofonu "granted" — auto-próba na zadaniu speech
    // sama rozpoczyna przygotowanie (pierwsze getUserMedia jest bramkowane)
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: async () => ({ state: "granted" }) },
    });
    // PR #109 P1 #2: auto-próba wymaga sprawnego monitora poziomów — fake
    // AudioContext z analizatorem (cisza), bo realny createMediaStreamSource
    // odrzuciłby strumień-testowy obiekt i przerwał auto-start
    class FakeAudioContext {
      // PR #109 r2: auto-próba akceptuje wyłącznie stan "running"
      readonly state = "running";
      createAnalyser() {
        return {
          fftSize: 256,
          getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0),
          disconnect: () => undefined,
        };
      }
      createMediaStreamSource() { return { connect: () => undefined }; }
      async close(): Promise<void> {}
    }
    Object.defineProperty(window, "AudioContext", { configurable: true, value: FakeAudioContext });
    class FakeMediaRecorder {
      static isTypeSupported(): boolean { return true; }
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      start(): void { this.state = "recording"; }
      stop(): void { this.state = "inactive"; this.onstop?.(); }
    }
    (window as unknown as { MediaRecorder: typeof FakeMediaRecorder }).MediaRecorder = FakeMediaRecorder;
  });
  const base = recallFixture();
  const fixture: KidUiFixture = {
    ...base,
    profiles: [{ ...base.profiles[0]!, recordingMode: "toggle" }],
    session: { ...base.session, microphoneEnabled: true },
    tasks: [{
      ...base.tasks[0]!,
      ...(kind === "speech" ? {
        exerciseType: "speech" as const,
        prompt: { kind: "speech" as const, text: "cat", audioAssetId: null, imageAssetId: null, visualType: "none" as const },
      } : {}),
    }],
  };
  await installKidUiFixture(page, fixture);
  await page.goto("/");
  await page.getByTestId("kid-profile").click();
  await page.getByTestId("kid-deck").click();
  await expect(page.getByTestId("kid-exercise")).toBeVisible();

  const measure = async () => page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing layout element: ${selector}`);
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    };
    return {
      frame: rect("[data-testid='kid-exercise']"),
      instruction: rect("[data-testid='kid-instruction']"),
      material: rect("[data-testid='kid-material']"),
      primary: rect("[data-testid='kid-primary-slot']"),
      record: rect("[data-testid='kid-record']"),
      input: document.querySelector("[data-testid='kid-input']")
        ? rect("[data-testid='kid-input']")
        : null,
    };
  });
  const record = page.getByTestId("kid-record");
  type PhaseMeasure = Awaited<ReturnType<typeof measure>>;
  let before: PhaseMeasure;
  let preparing: PhaseMeasure;
  if (kind === "speech") {
    // Auto-cykl mowy (quick 261021-lsw): przygotowanie mikrofonu startuje samo
    // po wyświetleniu zadania i wisi na pierwszym wywołaniu fake getUserMedia.
    // Stan idle jest ulotny, więc punktem odniesienia pomiarów jest preparing;
    // po zwolnieniu sondy auto-start osiąga recording bez żadnego kliku (drugie
    // wywołanie getUserMedia nie jest bramkowane, bip degraduje się po cichu).
    await expect(record).toHaveAttribute("data-phase", "preparing");
    before = await measure();
    preparing = before;
    await page.evaluate(() => {
      const browserWindow = window as typeof window & { resolveMicrophonePreparation?: () => void };
      browserWindow.resolveMicrophonePreparation?.();
    });
    await expect(record).toHaveAttribute("data-phase", "recording", { timeout: 10_000 });
  } else {
    // recall (WrittenView) pozostaje na ścieżce ręcznej — przygotowanie i start
    // przez kliknięcia, jak dotychczas
    before = await measure();
    await record.click();
    await expect(record).toHaveAttribute("data-phase", "preparing");
    preparing = await measure();
    await page.evaluate(() => {
      const browserWindow = window as typeof window & { resolveMicrophonePreparation?: () => void };
      browserWindow.resolveMicrophonePreparation?.();
    });
    await expect(record).toHaveAttribute("data-ready", "true");
    await record.click();
    await expect(record).toHaveAttribute("data-phase", "recording");
  }
  const recording = await measure();

  for (const phase of [preparing, recording]) {
    for (const key of ["frame", "instruction", "material", "primary", "record"] as const) {
      expect(Math.abs(phase[key].x - before[key].x), `${key} moved horizontally`).toBeLessThanOrEqual(2);
      expect(Math.abs(phase[key].y - before[key].y), `${key} moved vertically while microphone was ${key === "record" ? "used" : "active"}`).toBeLessThanOrEqual(2);
      expect(Math.abs(phase[key].height - before[key].height), `${key} changed height`).toBeLessThanOrEqual(2);
    }
    if (before.input !== null && phase.input !== null) {
      expect(Math.abs(phase.input.x - before.input.x), "written input moved horizontally").toBeLessThanOrEqual(2);
      expect(Math.abs(phase.input.y - before.input.y), "written input moved vertically while recording").toBeLessThanOrEqual(2);
      expect(Math.abs(phase.input.height - before.input.height), "written input changed height").toBeLessThanOrEqual(2);
    }
  }
  await page.keyboard.press("Escape");
});
}
