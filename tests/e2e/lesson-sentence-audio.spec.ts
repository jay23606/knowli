import { expect, test, type Locator, type Page } from "@playwright/test";
import { messages, type AttemptDto, type FeedbackDto, type TaskDto } from "@learning/contracts";
import { expectFrameFillsViewport } from "./helpers/kid-frame";
import { installKidUiFixture } from "./helpers/kid-ui-fixture";
import { recordAttemptPosts, tapPoolAndCheck } from "./helpers/lesson-assignment-task";
import { lessonAudioFixture, openLessonTask } from "./helpers/lesson-audio";

/**
 * Odczyt pełnego zdania po odpowiedzi w lekcji (design odczytu zdania §7, API
 * zaślepione w przeglądarce): feedback z `correctAudioAssetId` odtwarza nagranie
 * raz bez akcji dziecka, dok ma „Posłuchaj zdania”, „Dalej” przerywa odczyt,
 * a zablokowane autoodtwarzanie nie pokazuje błędu. Dalsze prace (design
 * 2026-11-01-sentence-readback-followups §4.2–§4.4, §7): pierścień odtwarzania,
 * „Posłuchaj wolniej” (tempo 0,75, zachowana wysokość głosu), tekst nieudanego
 * ręcznego odsłuchu i geometria grupy obu przycisków. `HTMLMediaElement.play`
 * i `pause` są podmienione — test liczy wywołania i czyta ustawienia elementu,
 * nie słyszy dźwięku, więc nie zastępuje odbioru na fizycznym urządzeniu
 * (głośność, polityka autoplay, słyszalna jakość wolnego tempa).
 */

const ids = {
  childId: "10000000-0000-4000-8000-000000000901",
  deckId: "10000000-0000-4000-8000-000000000902",
  sessionId: "10000000-0000-4000-8000-000000000903",
  deckVersionId: "10000000-0000-4000-8000-000000000904",
};
const sentenceAssetId = "10000000-0000-4000-8000-000000000921";
const sentencePath = `/api/v1/media/${sentenceAssetId}`;

const gapTask = (n: number, stem: string): TaskDto => ({
  taskId: `10000000-0000-4000-8000-00000000091${n}`, sessionId: ids.sessionId, ordinal: n, exerciseType: "lesson_gap",
  direction: null, state: "issued", remainingAssessed: 2,
  prompt: { kind: "lesson_gap", instructionPl: "Uzupełnij lukę", stemWithGap: stem, hint: "(go)" },
});
const first = gapTask(1, "He ___ to school.");
const second = gapTask(2, "She ___ to work.");

const attempt = (feedback: FeedbackDto): AttemptDto => ({
  attemptId: "10000000-0000-4000-8000-000000000931", taskId: first.taskId, state: "completed", modality: "text",
  taskState: "answered", stepId: "s1", receivedAt: "2026-10-31T10:00:01.000Z", completedAt: "2026-10-31T10:00:01.000Z",
  feedback,
});
const withSentence = attempt({ kind: "great", correctAudioAssetId: sentenceAssetId });

type AudioMode = "hold" | "reject" | "reject-after-first";

/**
 * Tempo i zachowanie wysokości głosu odczytane z elementu w chwili `play()`.
 * `pitch` to sam odczyt właściwości — w Chromium domyślnie `true`, więc nie
 * odróżnia jawnego ustawienia; `pitchSet` to wartość, którą kod zapisał przez
 * setter `preservesPitch` tego elementu przed `play()` (`null` — nie zapisał).
 */
interface PlayCall { rate: number; pitch: boolean; pitchSet: boolean | null }
interface AudioSpy { plays: number; pauses: number; calls: PlayCall[] }

/**
 * `hold` — odtwarzanie trwa do `pause()` (bez zdarzenia `ended`), żeby „Dalej”
 * trafiło w trwający odczyt; `reject` — przeglądarka odrzuca każde `play()`
 * (zablokowane autoodtwarzanie i nieudany ręczny odsłuch); `reject-after-first`
 * — autoodczyt gra jak w `hold`, a każde kolejne `play()` jest odrzucane.
 * Każde wywołanie zapisuje w `calls` tempo i `preservesPitch` elementu.
 */
async function spyAudio(page: Page, mode: AudioMode = "hold"): Promise<void> {
  await page.addInitScript((audioMode: AudioMode) => {
    const spy: AudioSpy = { plays: 0, pauses: 0, calls: [] };
    (window as unknown as { __audio: AudioSpy }).__audio = spy;
    // Setter `preservesPitch` zapamiętuje zapis kodu per element (getter bez zmian).
    const pitchWrites = new WeakMap<HTMLMediaElement, boolean>();
    const pitch = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "preservesPitch");
    if (pitch?.get && pitch.set) {
      const { get, set } = pitch;
      Object.defineProperty(HTMLMediaElement.prototype, "preservesPitch", {
        ...pitch,
        get() { return get.call(this); },
        set(value: boolean) { pitchWrites.set(this as HTMLMediaElement, value); set.call(this, value); },
      });
    }
    HTMLMediaElement.prototype.play = function play() {
      spy.plays += 1;
      spy.calls.push({ rate: this.playbackRate, pitch: this.preservesPitch, pitchSet: pitchWrites.get(this) ?? null });
      if (audioMode === "reject" || (audioMode === "reject-after-first" && spy.plays > 1)) {
        return Promise.reject(new DOMException("blocked", "NotAllowedError"));
      }
      this.dispatchEvent(new Event("playing"));
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function pause() {
      spy.pauses += 1;
    };
  }, mode);
}

const audioCounters = (page: Page) => page.evaluate(() => (window as unknown as { __audio: AudioSpy }).__audio);

interface Box { x: number; y: number; width: number; height: number }

const within = (inner: Box, outer: Box): boolean => inner.x >= outer.x - 1 && inner.y >= outer.y - 1
  && inner.x + inner.width <= outer.x + outer.width + 1 && inner.y + inner.height <= outer.y + outer.height + 1;
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1
  && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;

async function boxOf(locator: Locator): Promise<Box> {
  const bounds = await locator.boundingBox();
  if (bounds === null) throw new Error("element has no layout box");
  return bounds;
}

function trackMedia(page: Page): string[] {
  const paths: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/v1/media/")) paths.push(path);
  });
  return paths;
}

async function answer(page: Page): Promise<void> {
  await page.getByTestId("kid-lesson-gap-input").fill("goes");
  await page.getByTestId("kid-lesson-check").click();
  await expect(page.getByTestId("kid-feedback-dock")).toBeVisible();
}

async function open(page: Page, attempts: AttemptDto[], mode: AudioMode = "hold", tasks: (TaskDto | null)[] = [first, second]): Promise<string[]> {
  await spyAudio(page, mode);
  const media = trackMedia(page);
  await installKidUiFixture(page, {
    ...lessonAudioFixture(ids, tasks as TaskDto[]), attempts,
    disclosure: { taskId: first.taskId, stepId: "d1", kind: "hint", reveal: { target: "goes" } },
  });
  await openLessonTask(page, "kid-lesson-gap");
  return media;
}

test("plays the sentence once after a gap answer and replays it from the dock", async ({ page }) => {
  const media = await open(page, [withSentence]);
  expect(media).toEqual([]);
  await answer(page);
  await expect.poll(() => audioCounters(page).then((c) => c.plays)).toBe(1);
  await expect.poll(() => media).toEqual([sentencePath]);
  const replay = page.getByTestId("kid-feedback-dock").getByTestId("kid-sentence-audio");
  await expect(replay).toHaveAttribute("aria-label", "Posłuchaj zdania");
  await replay.click();
  await expect.poll(() => audioCounters(page).then((c) => c.plays)).toBe(2);
  await expect.poll(() => media).toEqual([sentencePath, sentencePath]);
});

test("the dock message audio is an outlined question, not a second speaker, next to the sentence button", async ({ page }) => {
  await open(page, [withSentence]);
  await answer(page);
  const dock = page.getByTestId("kid-feedback-dock");
  const guidance = dock.getByTestId("kid-guidance-play");
  const sentence = dock.getByTestId("kid-sentence-audio");
  await expect(guidance).toHaveAttribute("aria-label", "Posłuchaj");
  await expect(guidance).toHaveAttribute("data-guidance-icon", "question");
  await expect(guidance).toHaveAttribute("data-variant", "outlined");
  await expect(sentence).toHaveAttribute("data-variant", "tonal");
  await expect(sentence).toHaveClass(/kid-listen/);
  await expect(guidance).not.toHaveClass(/kid-listen/);
});

test("without the sentence recording the dock message audio keeps the speaker", async ({ page }) => {
  await open(page, [attempt({ kind: "great" })]);
  await answer(page);
  const guidance = page.getByTestId("kid-feedback-dock").getByTestId("kid-guidance-play");
  await expect(guidance).toHaveAttribute("data-guidance-icon", "speaker");
  await expect(guidance).toHaveClass(/kid-listen/);
});

test("„Nie pamiętam” with a sentence recording shows the result with readback until „Dalej”", async ({ page }) => {
  const media = await open(page, [{ ...attempt({ kind: "incorrect", correctText: "He goes to school.", correctAudioAssetId: sentenceAssetId }), modality: "dont_remember" }]);
  await page.getByTestId("kid-not-remember").click();
  await expect(page.getByTestId("kid-reveal")).toContainText("goes");
  await page.getByTestId("kid-next").click();
  await expect(page.getByTestId("kid-reveal")).toHaveCount(0);
  await expect(page.getByTestId("kid-feedback-dock")).toBeVisible();
  await expect(page.getByTestId("kid-feedback-correct-answer")).toContainText("He goes to school.");
  await expect(page.getByTestId("kid-sentence-audio")).toBeVisible();
  await expect.poll(() => audioCounters(page).then((c) => c.plays)).toBe(1);
  await expect.poll(() => media).toEqual([sentencePath]);
  await page.getByTestId("kid-next").click();
  await expect(page.getByTestId("kid-lesson-gap")).toContainText("She");
  await expect(page.getByTestId("kid-feedback-dock")).toHaveCount(0);
});

test("„Dalej” stops the reading and the next task has no sentence button", async ({ page }) => {
  await open(page, [withSentence]);
  await answer(page);
  await expect.poll(() => audioCounters(page).then((c) => c.plays)).toBe(1);
  const pausesBefore = (await audioCounters(page)).pauses;
  await page.getByTestId("kid-next").click();
  await expect(page.getByTestId("kid-lesson-gap")).toContainText("She");
  expect((await audioCounters(page)).pauses).toBeGreaterThan(pausesBefore);
  await expect(page.getByTestId("kid-sentence-audio")).toHaveCount(0);
  expect((await audioCounters(page)).plays).toBe(1);
});

test("blocked autoplay shows no error and keeps the replay button", async ({ page }) => {
  await open(page, [withSentence], "reject");
  await answer(page);
  await expect.poll(() => audioCounters(page).then((c) => c.plays)).toBe(1);
  await expect(page.getByTestId("kid-sentence-audio")).toBeVisible();
  // Zakres `main`: pusty `alert` poza nim to ogłaszacz tras Next.js.
  await expect(page.locator("main.kid-learning").getByRole("alert")).toHaveCount(0);
  await expect(page.locator("main.kid-learning")).toHaveAttribute("data-action-notice", "false");
  await expect(page.getByTestId("kid-feedback")).toContainText("Świetnie!");
});

test("feedback without the sentence recording has no button and plays nothing", async ({ page }) => {
  const media = await open(page, [attempt({ kind: "great" })]);
  await answer(page);
  await expect(page.getByTestId("kid-feedback")).toContainText("Świetnie!");
  await expect(page.getByTestId("kid-sentence-audio")).toHaveCount(0);
  expect(media).toEqual([]);
  expect((await audioCounters(page)).plays).toBe(0);
});

/**
 * Wyjaśnienie ćwiczenia po błędzie (spec 2026-11-01-lesson-error-explanation §6):
 * jedno zdanie po polsku w osobnym wierszu doku, „Posłuchaj wyjaśnienia” tylko
 * z nagraniem i wyłącznie po kliknięciu — samo gra jedynie odczyt zdania.
 */
const explanationAssetId = "10000000-0000-4000-8000-000000000922";
const explanationPath = `/api/v1/media/${explanationAssetId}`;
/** 120 znaków — górny limit `explanationPl`. */
const EXPLANATION = "Po he, she i it w czasie Present Simple dodajemy do czasownika końcówkę -s, na przykład he goes albo she plays football.";
const choiceTask: TaskDto = {
  taskId: "10000000-0000-4000-8000-000000000917", sessionId: ids.sessionId, ordinal: 1, exerciseType: "lesson_choice",
  direction: null, state: "issued", remainingAssessed: 2,
  prompt: { kind: "lesson_choice", instructionPl: "Wybierz właściwą formę", stem: "He ___ to school.",
    options: [{ id: "10000000-0000-4000-8000-000000000918", text: "go" }, { id: "10000000-0000-4000-8000-000000000919", text: "goes" }] },
};
const wrongChoice: AttemptDto = {
  ...attempt({ kind: "incorrect", correctText: "He goes to school.", hintPl: EXPLANATION,
    correctAudioAssetId: sentenceAssetId, explanationAudioAssetId: explanationAssetId }),
  taskId: choiceTask.taskId, modality: "choice",
};

test("a wrong choice shows the explanation; only the sentence plays by itself and „Posłuchaj wyjaśnienia” plays the explanation", async ({ page }) => {
  await spyAudio(page);
  const media = trackMedia(page);
  await installKidUiFixture(page, { ...lessonAudioFixture(ids, [choiceTask, second]), attempts: [wrongChoice] });
  await openLessonTask(page, "kid-lesson-stem");
  await page.getByTestId("kid-option").filter({ hasText: /^go$/ }).click();
  const dock = page.getByTestId("kid-feedback-dock");
  await expect(dock).toHaveAttribute("data-tone", "incorrect");
  await expect(dock.getByTestId("kid-explanation-text")).toHaveText(EXPLANATION);
  await expect.poll(() => audioCounters(page).then((c) => c.plays)).toBe(1);
  await expect.poll(() => media).toEqual([sentencePath]);
  const listen = dock.getByTestId("kid-explanation-audio");
  await expect(listen).toHaveAttribute("aria-label", "Posłuchaj wyjaśnienia");
  await expect(listen).toHaveAttribute("title", "Posłuchaj wyjaśnienia");
  const pausesBefore = (await audioCounters(page)).pauses;
  await listen.click();
  await expect.poll(() => audioCounters(page).then((c) => c.plays)).toBe(2);
  await expect.poll(() => media).toEqual([sentencePath, explanationPath]);
  // Odczyt zdania ustąpił wyjaśnieniu.
  expect((await audioCounters(page)).pauses).toBeGreaterThan(pausesBefore);
  // Komunikat obok głośników ma „?”, a „Dalej” przerywa wyjaśnienie.
  await expect(dock.getByTestId("kid-guidance-play")).toHaveAttribute("data-guidance-icon", "question");
  const pausesBeforeNext = (await audioCounters(page)).pauses;
  await page.getByTestId("kid-next").click();
  await expect(page.getByTestId("kid-lesson-gap")).toContainText("She");
  expect((await audioCounters(page)).pauses).toBeGreaterThan(pausesBeforeNext);
  await expect(page.getByTestId("kid-explanation-text")).toHaveCount(0);
});

test("„Nie pamiętam” with an explanation and no sentence recording keeps the result until „Dalej”", async ({ page }) => {
  const media = await open(page, [{ ...attempt({ kind: "incorrect", correctText: "He goes to school.", hintPl: EXPLANATION }), modality: "dont_remember" }]);
  await page.getByTestId("kid-not-remember").click();
  await expect(page.getByTestId("kid-reveal")).toContainText("goes");
  await page.getByTestId("kid-next").click();
  await expect(page.getByTestId("kid-reveal")).toHaveCount(0);
  const dock = page.getByTestId("kid-feedback-dock");
  await expect(dock).toBeVisible();
  await expect(dock.getByTestId("kid-explanation-text")).toHaveText(EXPLANATION);
  await expect(page.getByTestId("kid-feedback-correct-answer")).toContainText("He goes to school.");
  // Bez nagrań nic nie gra i nie ma przycisków odsłuchu wyniku.
  await expect(dock.getByTestId("kid-explanation-audio")).toHaveCount(0);
  await expect(dock.getByTestId("kid-sentence-audio")).toHaveCount(0);
  expect((await audioCounters(page)).plays).toBe(0);
  expect(media).toEqual([]);
  await page.getByTestId("kid-next").click();
  await expect(page.getByTestId("kid-lesson-gap")).toContainText("She");
  await expect(page.getByTestId("kid-feedback-dock")).toHaveCount(0);
});

test("an explanation without a recording shows the text without a listen button", async ({ page }) => {
  await open(page, [attempt({ kind: "incorrect", correctText: "He goes to school.", hintPl: EXPLANATION })]);
  await answer(page);
  const dock = page.getByTestId("kid-feedback-dock");
  await expect(dock.getByTestId("kid-explanation-text")).toHaveText(EXPLANATION);
  await expect(dock.getByTestId("kid-explanation-audio")).toHaveCount(0);
  await expect(dock.getByRole("button", { name: "Posłuchaj wyjaśnienia" })).toHaveCount(0);
  // Bez żadnego nagrania komunikat zostaje głośnikiem.
  await expect(dock.getByTestId("kid-guidance-play")).toHaveAttribute("data-guidance-icon", "speaker");
});

test("an explanation recording alone turns the message audio into a question", async ({ page }) => {
  await open(page, [attempt({ kind: "incorrect", correctText: "He goes to school.", hintPl: EXPLANATION, explanationAudioAssetId: explanationAssetId })]);
  await answer(page);
  const dock = page.getByTestId("kid-feedback-dock");
  await expect(dock.getByTestId("kid-explanation-audio")).toBeVisible();
  await expect(dock.getByTestId("kid-sentence-audio")).toHaveCount(0);
  await expect(dock.getByTestId("kid-guidance-play")).toHaveAttribute("data-guidance-icon", "question");
  // Bez nagrania zdania nic nie gra samo.
  await page.waitForTimeout(300);
  expect((await audioCounters(page)).plays).toBe(0);
});

test("a lesson_hint with an explanation recording shows the hint in the dock row, not in the card", async ({ page }) => {
  await open(page, [attempt({ kind: "lesson_hint", correctText: "He goes to school.", hintPl: EXPLANATION, explanationAudioAssetId: explanationAssetId })]);
  await answer(page);
  const dock = page.getByTestId("kid-feedback-dock");
  await expect(dock.getByTestId("kid-explanation-text")).toHaveText(EXPLANATION);
  await expect(dock.getByTestId("kid-lesson-feedback-hint")).toHaveCount(0);
  await expect(dock.getByTestId("kid-explanation-audio")).toBeVisible();
});

const withBothRecordings = attempt({ kind: "incorrect", correctText: "He goes to school.", hintPl: EXPLANATION,
  correctAudioAssetId: sentenceAssetId, explanationAudioAssetId: explanationAssetId });

test("„Posłuchaj wyjaśnienia” shows the playing ring and clears a stale sentence failure", async ({ page }) => {
  const media = await open(page, [withBothRecordings]);
  await answer(page);
  const dock = page.getByTestId("kid-feedback-dock");
  await expect.poll(() => media).toEqual([sentencePath]);
  // Ręczna powtórka zdania zawodzi (plik niedostępny) — komunikat i poruszenie żółwia.
  await page.route(`**${sentencePath}`, (route) => route.fulfill({ status: 500, body: "" }));
  const slow = dock.getByTestId("kid-sentence-audio-slow");
  await slow.click();
  const error = dock.getByTestId("kid-sentence-audio-error");
  await expect(error).toHaveText(messages.kid.sentenceAudioFailed);
  await expect(slow).toHaveAttribute("data-audio-failed", "1");
  // Udany start wyjaśnienia gasi nieaktualny błąd i zapala pierścień tylko na wyjaśnieniu.
  const listen = dock.getByTestId("kid-explanation-audio");
  await listen.click();
  await expect.poll(() => media.at(-1)).toBe(explanationPath);
  await expect(listen).toHaveAttribute("data-sound-active", "true");
  await expect(listen.getByTestId("kid-sound-ring")).toHaveCount(1);
  await expect(error).toHaveText("");
  await expect(slow).not.toHaveAttribute("data-audio-failed");
  await expect(dock.locator("[data-sound-active]")).toHaveCount(1);
  // Ponowne dotknięcie zaczyna wyjaśnienie od nowa, pierścień zostaje.
  const plays = (await audioCounters(page)).plays;
  await listen.click();
  await expect.poll(() => audioCounters(page).then((spy) => spy.plays)).toBe(plays + 1);
  await expect(listen).toHaveAttribute("data-sound-active", "true");
  // „Dalej” gasi pierścień razem z feedbackiem.
  await page.getByTestId("kid-next").click();
  await expect(page.getByTestId("kid-lesson-gap")).toContainText("She");
  await expect(page.locator("[data-sound-active]")).toHaveCount(0);
});

test("a failed manual explanation replay shows the shared message and wobbles the explanation button", async ({ page }) => {
  await open(page, [withBothRecordings]);
  await page.route(`**${explanationPath}`, (route) => route.fulfill({ status: 500, body: "" }));
  await answer(page);
  const dock = page.getByTestId("kid-feedback-dock");
  const listen = dock.getByTestId("kid-explanation-audio");
  const error = dock.getByTestId("kid-sentence-audio-error");
  await expect(error).toHaveAttribute("aria-live", "polite");
  await expect(error).toHaveText("");
  await listen.click();
  await expect(error).toHaveText(messages.kid.sentenceAudioFailed);
  await expect(listen).toHaveAttribute("data-audio-failed", "1");
  await expect(listen).toBeFocused();
  await expect(listen).not.toHaveAttribute("data-sound-active");
  await expect(dock.getByTestId("kid-sentence-audio")).not.toHaveAttribute("data-audio-failed");
  await expect(dock.getByTestId("kid-sentence-audio-slow")).not.toHaveAttribute("data-audio-failed");
  await listen.click();
  await expect(listen).toHaveAttribute("data-audio-failed", "2");
  await expect(error).toHaveText(messages.kid.sentenceAudioFailed);
  // Tekst wyjaśnienia ma własny region `aria-live`.
  await expect(dock.getByTestId("kid-explanation-text")).toHaveAttribute("aria-live", "polite");
});

test("the explanation button is disabled while the next step loads and gone offline", async ({ page }) => {
  const media = await open(page, [withBothRecordings]);
  // Następne zadanie czeka na bramce (także ewentualne wcześniejsze pobranie po odpowiedzi).
  let releaseNext!: () => void;
  const nextGate = new Promise<void>((resolve) => { releaseNext = resolve; });
  let nextRequested = false;
  await page.route(`**/api/v1/kid/sessions/${ids.sessionId}/next`, async (route) => {
    nextRequested = true;
    await nextGate;
    await route.fallback();
  });
  await answer(page);
  await expect.poll(() => media).toEqual([sentencePath]);
  const dock = page.getByTestId("kid-feedback-dock");
  const listen = dock.getByTestId("kid-explanation-audio");
  await expect(listen).toBeEnabled();
  // „Dalej” czeka na następne zadanie (busy) — odsłuchy w doku są zablokowane jak przyciski zdania.
  await page.getByTestId("kid-next").click();
  await expect.poll(() => nextRequested).toBe(true);
  await expect(listen).toBeDisabled();
  await expect(dock.getByTestId("kid-sentence-audio")).toBeDisabled();
  await expect(dock.getByTestId("kid-sentence-audio-slow")).toBeDisabled();
  const plays = (await audioCounters(page)).plays;
  await listen.click({ force: true });
  expect((await audioCounters(page)).plays).toBe(plays);
  expect(media).toEqual([sentencePath]);
  releaseNext();
  await expect(page.getByTestId("kid-lesson-gap")).toContainText("She");
});

test("going offline replaces the dock, so the explanation cannot be played", async ({ page, context }) => {
  const media = await open(page, [withBothRecordings]);
  await answer(page);
  await expect.poll(() => media).toEqual([sentencePath]);
  await expect(page.getByTestId("kid-explanation-audio")).toBeEnabled();
  await context.setOffline(true);
  await expect(page.getByTestId("kid-offline")).toBeVisible();
  await expect(page.getByTestId("kid-explanation-audio")).toHaveCount(0);
  expect(media).toEqual([sentencePath]);
  await context.setOffline(false);
});

test("the explanation row fits the feedback dock on every form factor", async ({ page }, testInfo) => {
  await open(page, [attempt({ kind: "incorrect", correctText: "He goes to school.", hintPl: EXPLANATION,
    correctAudioAssetId: sentenceAssetId, explanationAudioAssetId: explanationAssetId })]);
  await answer(page);
  const measured: Record<string, unknown> = {};
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 812, height: 375 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    const label = `${viewport.width}x${viewport.height}`;
    await expectFrameFillsViewport(page, viewport);
    const viewportBox: Box = { x: 0, y: 0, width: viewport.width, height: viewport.height };
    const dock = page.getByTestId("kid-feedback-dock");
    const listen = dock.getByTestId("kid-explanation-audio");
    const text = dock.getByTestId("kid-explanation-text");
    await listen.scrollIntoViewIfNeeded();
    const [dockBox, listenBox, textBox, result] = await Promise.all([boxOf(dock), boxOf(listen), boxOf(text), boxOf(dock.getByTestId("kid-feedback"))]);
    measured[label] = { dock: dockBox, listen: listenBox, text: textBox, result };
    const details = JSON.stringify(measured[label]);
    expect(listenBox.width, `listen width at ${label}: ${details}`).toBeGreaterThanOrEqual(48);
    expect(listenBox.height, `listen height at ${label}: ${details}`).toBeGreaterThanOrEqual(48);
    expect(within(listenBox, dockBox), `listen inside dock at ${label}: ${details}`).toBe(true);
    expect(within(listenBox, viewportBox), `listen inside viewport at ${label}: ${details}`).toBe(true);
    expect(within(textBox, dockBox), `text inside dock at ${label}: ${JSON.stringify(textBox)}`).toBe(true);
    expect(within(textBox, viewportBox), `text inside viewport at ${label}: ${JSON.stringify(measured[label])}`).toBe(true);
    // Wiersz wyjaśnienia stoi pod wynikiem, a przycisk na jego początku.
    expect(textBox.y, `text below the result at ${label}`).toBeGreaterThanOrEqual(result.y + result.height - 1);
    expect(listenBox.x + listenBox.width, `listen before the text at ${label}`).toBeLessThanOrEqual(textBox.x + 1);
    if (viewport.width === 375) expect(textBox.width, `text width at ${label}`).toBeGreaterThanOrEqual(220);
    // „Dalej” osiągalne w viewporcie.
    const next = page.getByTestId("kid-next");
    await next.scrollIntoViewIfNeeded();
    const nextBox = await boxOf(next);
    expect(within(nextBox, viewportBox), `next inside viewport at ${label}: ${JSON.stringify(nextBox)}`).toBe(true);
    expect(nextBox.height, `next height at ${label}`).toBeGreaterThanOrEqual(54);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `page overflow at ${label}`).toBe(false);
    expect(await dock.evaluate((element) => element.scrollWidth > element.clientWidth + 1), `dock overflow at ${label}`).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`explanation-${label}.png`) });
  }
});

test("the sentence button shows the playing ring during readback", async ({ page }) => {
  await open(page, [withSentence]);
  await answer(page);
  const dock = page.getByTestId("kid-feedback-dock");
  const sentence = dock.getByTestId("kid-sentence-audio");
  // Pierścień zapala zdarzenie `playing` autoodczytu; ma go tylko przycisk tempa, które gra.
  await expect(sentence).toHaveAttribute("data-sound-active", "true");
  await expect(dock.getByTestId("kid-sentence-audio-slow")).not.toHaveAttribute("data-sound-active");
  const ring = sentence.getByTestId("kid-sound-ring");
  await expect(ring).toHaveCount(1);
  const ringBox = await boxOf(ring);
  const dockBox = await boxOf(dock);
  expect(within(ringBox, dockBox), `ring inside dock: ${JSON.stringify({ ringBox, dockBox })}`).toBe(true);
  await page.getByTestId("kid-next").click();
  await expect(page.getByTestId("kid-lesson-gap")).toContainText("She");
  await expect(page.getByTestId("kid-sentence-audio-group")).toHaveCount(0);
  await expect(page.locator("[data-sound-active]")).toHaveCount(0);
});

test("„Posłuchaj wolniej” replays the same file at 0.75 with preserved pitch", async ({ page }) => {
  const media = await open(page, [withSentence]);
  await answer(page);
  await expect.poll(() => media).toEqual([sentencePath]);
  // Autoodczyt gra w normalnym tempie.
  await expect.poll(() => audioCounters(page).then((spy) => spy.calls)).toEqual([{ rate: 1, pitch: true, pitchSet: true }]);
  const slow = page.getByTestId("kid-feedback-dock").getByTestId("kid-sentence-audio-slow");
  await expect(slow).toHaveAttribute("aria-label", "Posłuchaj wolniej");
  await slow.click();
  await expect.poll(() => audioCounters(page).then((spy) => spy.calls.at(-1))).toEqual({ rate: 0.75, pitch: true, pitchSet: true });
  expect((await audioCounters(page)).calls).toHaveLength(2);
  await expect.poll(() => media).toEqual([sentencePath, sentencePath]);
  await expect(slow).toHaveAttribute("data-sound-active", "true");
  await expect(page.getByTestId("kid-sentence-audio")).not.toHaveAttribute("data-sound-active");
});

test("a failed manual replay shows the message, a blocked autoplay does not", async ({ page }) => {
  await open(page, [withSentence], "reject");
  await answer(page);
  await expect.poll(() => audioCounters(page).then((spy) => spy.plays)).toBe(1);
  const error = page.getByTestId("kid-sentence-audio-error");
  const slow = page.getByTestId("kid-sentence-audio-slow");
  // Region stoi w doku od początku, ale zablokowany autoodczyt go nie wypełnia.
  await expect(error).toHaveAttribute("aria-live", "polite");
  await expect(error).toHaveText("");
  await expect(slow).not.toHaveAttribute("data-audio-failed");

  await slow.click();
  await expect.poll(() => audioCounters(page).then((spy) => spy.plays)).toBe(2);
  await expect(error).toHaveText(messages.kid.sentenceAudioFailed);
  await expect(slow).toHaveAttribute("data-audio-failed", "1");
  // Fokus zostaje na przycisku, który zawiódł (spec §4.4).
  await expect(slow).toBeFocused();
  await expect(page.getByTestId("kid-sentence-audio")).not.toHaveAttribute("data-audio-failed");
  await expect(slow).not.toHaveAttribute("data-sound-active");

  // Kolejne nieudane dotknięcie: ten sam tekst (dok nie skacze), nowy klucz poruszenia ikony.
  await slow.click();
  await expect.poll(() => audioCounters(page).then((spy) => spy.plays)).toBe(3);
  await expect(slow).toHaveAttribute("data-audio-failed", "2");
  await expect(error).toHaveText(messages.kid.sentenceAudioFailed);

  // „Dalej” zabiera błąd razem z feedbackiem.
  await page.getByTestId("kid-next").click();
  await expect(page.getByTestId("kid-lesson-gap")).toContainText("She");
  await expect(page.getByTestId("kid-sentence-audio-error")).toHaveCount(0);
});

test("a failed manual replay during readback stops the ring and shows the message", async ({ page }) => {
  await open(page, [withSentence], "reject-after-first");
  await answer(page);
  const sentence = page.getByTestId("kid-sentence-audio");
  await expect(sentence).toHaveAttribute("data-sound-active", "true");
  await expect(page.getByTestId("kid-sentence-audio-error")).toHaveText("");
  await sentence.click();
  await expect.poll(() => audioCounters(page).then((spy) => spy.plays)).toBe(2);
  await expect(page.getByTestId("kid-sentence-audio-error")).toHaveText(messages.kid.sentenceAudioFailed);
  await expect(sentence).toHaveAttribute("data-audio-failed", "1");
  await expect(page.locator("[data-sound-active]")).toHaveCount(0);
});

/**
 * Układ grupy przycisków zdania z container query doku (spec §4.3): gdy treść
 * doku ma mniej niż 480 px szerokości (px wewnętrzne, jak w `@container`),
 * żółw stoi pod „Posłuchaj zdania” (odstęp 8 px, ta sama lewa krawędź), a „?”
 * komunikatu zaczyna się na wysokości górnego przycisku; szerszy dok ma oba
 * w jednym wierszu, żółw po prawej. Próg z pomiaru doku, nie z okna.
 */
async function expectSentenceGroupLayout(page: Page, label: string): Promise<void> {
  const dock = page.getByTestId("kid-feedback-dock");
  const { contentWidth, zoom } = await dock.evaluate((element) => {
    const style = getComputedStyle(element);
    const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return { contentWidth: width, zoom: element.getBoundingClientRect().width / (element as HTMLElement).offsetWidth };
  });
  const sentence = await boxOf(dock.getByTestId("kid-sentence-audio"));
  const slow = await boxOf(dock.getByTestId("kid-sentence-audio-slow"));
  const guidance = await boxOf(dock.getByTestId("kid-guidance-play"));
  const details = `dock content ${contentWidth}px, sentence ${JSON.stringify(sentence)}, slow ${JSON.stringify(slow)}, guidance ${JSON.stringify(guidance)} at ${label}`;
  if (contentWidth < 480) {
    expect(slow.y, `column: slow under sentence: ${details}`).toBeGreaterThanOrEqual(sentence.y + sentence.height + 8 * zoom - 1);
    expect(Math.abs(slow.x - sentence.x), `column: same left edge: ${details}`).toBeLessThanOrEqual(1);
    expect(Math.abs(guidance.y - sentence.y), `column: guidance at the top button: ${details}`).toBeLessThanOrEqual(1);
  } else {
    expect(Math.abs(slow.y - sentence.y), `row: same top: ${details}`).toBeLessThanOrEqual(1);
    expect(slow.x, `row: slow right of sentence: ${details}`).toBeGreaterThanOrEqual(sentence.x + sentence.width - 1);
  }
}

/** Oba przyciski zdania: cel ≥ 48 px, w doku i bez nakładania na „?” komunikatu. */
async function expectSentenceButtonsInDock(page: Page, label: string): Promise<void> {
  const dock = page.getByTestId("kid-feedback-dock");
  const dockBox = await boxOf(dock);
  const guidance = await boxOf(dock.getByTestId("kid-guidance-play"));
  for (const testId of ["kid-sentence-audio", "kid-sentence-audio-slow"]) {
    const bounds = await boxOf(dock.getByTestId(testId));
    const details = `${testId} ${JSON.stringify(bounds)}, dock ${JSON.stringify(dockBox)}, guidance ${JSON.stringify(guidance)} at ${label}`;
    expect(bounds.width, `width: ${details}`).toBeGreaterThanOrEqual(48);
    expect(bounds.height, `height: ${details}`).toBeGreaterThanOrEqual(48);
    expect(within(bounds, dockBox), `inside dock: ${details}`).toBe(true);
    expect(overlaps(bounds, guidance), `overlaps guidance: ${details}`).toBe(false);
  }
  await expectSentenceGroupLayout(page, label);
}

/** Bez poziomego przewijania strony, a „Dalej” w całości w oknie. */
async function expectNextReachable(page: Page, viewport: { width: number; height: number }, label: string): Promise<void> {
  const next = page.getByTestId("kid-next");
  await next.scrollIntoViewIfNeeded();
  const nextBox = await boxOf(next);
  expect(within(nextBox, { x: 0, y: 0, ...viewport }), `next in viewport at ${label}: ${JSON.stringify(nextBox)}`).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `page overflow at ${label}`).toBe(true);
}

const SENTENCE_VIEWPORTS = [
  { width: 320, height: 640 },
  { width: 375, height: 812 },
  { width: 812, height: 375 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
];

test("sentence button fits the feedback dock on every form factor", async ({ page }, testInfo) => {
  await open(page, [attempt({ kind: "incorrect", correctText: "He goes to school.", correctAudioAssetId: sentenceAssetId })]);
  await answer(page);
  for (const viewport of SENTENCE_VIEWPORTS) {
    await page.setViewportSize(viewport);
    const label = `${viewport.width}x${viewport.height}`;
    await expectFrameFillsViewport(page, viewport);
    const button = page.getByTestId("kid-sentence-audio");
    await button.scrollIntoViewIfNeeded();
    const bounds = (await button.boundingBox())!;
    const dock = (await page.getByTestId("kid-feedback-dock").boundingBox())!;
    expect(bounds.width, `width at ${label}`).toBeGreaterThanOrEqual(48);
    expect(bounds.height, `height at ${label}`).toBeGreaterThanOrEqual(48);
    expect(bounds.x, `inside dock at ${label}`).toBeGreaterThanOrEqual(dock.x - 1);
    expect(bounds.x + bounds.width, `inside dock at ${label}`).toBeLessThanOrEqual(dock.x + dock.width + 1);
    expect(bounds.y, `inside dock at ${label}`).toBeGreaterThanOrEqual(dock.y - 1);
    expect(bounds.y + bounds.height, `inside dock at ${label}`).toBeLessThanOrEqual(dock.y + dock.height + 1);
    expect(bounds.x, `in viewport at ${label}`).toBeGreaterThanOrEqual(-1);
    expect(bounds.y, `in viewport at ${label}`).toBeGreaterThanOrEqual(-1);
    expect(bounds.x + bounds.width, `in viewport at ${label}`).toBeLessThanOrEqual(viewport.width + 1);
    expect(bounds.y + bounds.height, `in viewport at ${label}`).toBeLessThanOrEqual(viewport.height + 1);
    // Obrysowany „?” komunikatu obok też ma pełny cel i mieści się w doku.
    const guidance = (await page.getByTestId("kid-feedback-dock").getByTestId("kid-guidance-play").boundingBox())!;
    expect(guidance.width, `guidance width at ${label}`).toBeGreaterThanOrEqual(48);
    expect(guidance.height, `guidance height at ${label}`).toBeGreaterThanOrEqual(48);
    expect(guidance.x + guidance.width, `guidance inside dock at ${label}`).toBeLessThanOrEqual(dock.x + dock.width + 1);
    // „Posłuchaj zdania” i „Posłuchaj wolniej”: oba cele w doku, obok „?”, nie na nim.
    await expectSentenceButtonsInDock(page, label);
    // „Dalej” pozostaje osiągalne obok przycisków odczytu.
    const next = (await page.getByTestId("kid-next").boundingBox())!;
    expect(next.y + next.height, `next in viewport at ${label}`).toBeLessThanOrEqual(viewport.height + 1);
    await expectNextReachable(page, viewport, label);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `page overflow at ${label}`).toBe(false);
    expect(await page.getByTestId("kid-feedback-dock").evaluate((element) => element.scrollWidth > element.clientWidth + 1), `dock overflow at ${label}`).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`sentence-audio-${label}.png`) });
  }
});

test("the replay error stays inside the dock on every form factor", async ({ page }, testInfo) => {
  await open(page, [attempt({ kind: "incorrect", correctText: "He goes to school.", correctAudioAssetId: sentenceAssetId })], "reject");
  await answer(page);
  await page.getByTestId("kid-sentence-audio-slow").click();
  const error = page.getByTestId("kid-sentence-audio-error");
  await expect(error).toHaveText(messages.kid.sentenceAudioFailed);
  for (const viewport of SENTENCE_VIEWPORTS) {
    await page.setViewportSize(viewport);
    const label = `${viewport.width}x${viewport.height}`;
    await expectFrameFillsViewport(page, viewport);
    await error.scrollIntoViewIfNeeded();
    await expect(error).toBeVisible();
    const errorBox = await boxOf(error);
    const dockBox = await boxOf(page.getByTestId("kid-feedback-dock"));
    expect(within(errorBox, dockBox), `error inside dock at ${label}: ${JSON.stringify({ errorBox, dockBox })}`).toBe(true);
    await expectSentenceButtonsInDock(page, `${label} with the error`);
    await expectNextReachable(page, viewport, `${label} with the error`);
    expect(await page.getByTestId("kid-feedback-dock").evaluate((element) => element.scrollWidth > element.clientWidth + 1), `dock overflow at ${label}`).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`sentence-audio-error-${label}.png`) });
  }
});

/**
 * Nieudane dotknięcie nie przesuwa przycisków zdania pod palcem (spec §4.4).
 * `up` — dok w nakładce stoi przy dolnej krawędzi ramy i rośnie w górę: tekst
 * stoi nad górnym wierszem, a przyciski zdania i „Dalej” zostają na miejscu.
 * `down` — zwarta rama dużego okna (stopka tuż pod odpowiedziami, wolne miejsce
 * niżej) i przewijana strona: dok rośnie w dół, więc tekst stoi pod górnym
 * wierszem, przyciski zdania zostają, a w dół przesuwa się tylko „Dalej”.
 */
const ERROR_SHIFT_VIEWPORTS: { viewport: { width: number; height: number }; grows: "up" | "down" }[] = [
  { viewport: { width: 375, height: 812 }, grows: "up" },
  { viewport: { width: 1280, height: 800 }, grows: "down" },
  { viewport: { width: 812, height: 375 }, grows: "down" },
];

for (const { viewport, grows } of ERROR_SHIFT_VIEWPORTS) {
  const label = `${viewport.width}x${viewport.height}`;
  test(`the replay error does not move the sentence buttons at ${label}`, async ({ page }) => {
    await open(page, [attempt({ kind: "incorrect", correctText: "He goes to school.", correctAudioAssetId: sentenceAssetId })], "reject");
    await answer(page);
    await page.setViewportSize(viewport);
    await expectFrameFillsViewport(page, viewport);
    const dock = page.getByTestId("kid-feedback-dock");
    const error = page.getByTestId("kid-sentence-audio-error");
    await expect(error).toHaveText("");
    const targets = { sentence: dock.getByTestId("kid-sentence-audio"), slow: dock.getByTestId("kid-sentence-audio-slow"), next: dock.getByTestId("kid-next") };
    await targets.slow.scrollIntoViewIfNeeded();
    const measure = async () => ({ sentence: await boxOf(targets.sentence), slow: await boxOf(targets.slow), next: await boxOf(targets.next) });
    const before = await measure();

    await targets.slow.click();
    await expect(error).toHaveText(messages.kid.sentenceAudioFailed);
    // Dwie klatki na przeliczenie rezerwy i limitu karty po zmianie wysokości doku.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const after = await measure();
    const fixed: (keyof typeof targets)[] = grows === "up" ? ["sentence", "slow", "next"] : ["sentence", "slow"];
    for (const name of fixed) {
      const moved = `${name} before ${JSON.stringify(before[name])}, after ${JSON.stringify(after[name])} at ${label}`;
      expect(Math.abs(after[name].x - before[name].x), `x: ${moved}`).toBeLessThanOrEqual(1);
      expect(Math.abs(after[name].y - before[name].y), `y: ${moved}`).toBeLessThanOrEqual(1);
    }
    const errorBox = await boxOf(error);
    expect(within(errorBox, await boxOf(dock)), `error inside dock at ${label}`).toBe(true);
    // Tekst nie wchodzi na przyciski zdania ani na „Dalej”.
    for (const name of Object.keys(targets) as (keyof typeof targets)[]) {
      expect(overlaps(errorBox, after[name]), `error overlaps ${name} at ${label}: ${JSON.stringify({ errorBox, target: after[name] })}`).toBe(false);
    }
    const rowTop = Math.min(after.sentence.y, after.slow.y);
    const rowBottom = Math.max(after.sentence.y + after.sentence.height, after.slow.y + after.slow.height);
    if (grows === "up") {
      expect(errorBox.y + errorBox.height, `error above the sentence row at ${label}`).toBeLessThanOrEqual(rowTop + 1);
    } else {
      expect(errorBox.y, `error under the sentence row at ${label}`).toBeGreaterThanOrEqual(rowBottom - 1);
      expect(errorBox.y + errorBox.height, `error above „Dalej” at ${label}`).toBeLessThanOrEqual(after.next.y + 1);
    }
  });
}

/**
 * Tekst z lukami i bankiem słów („Angielski — rozdział”, `lesson_cloze` z
 * `contentLocale` en-GB): odczyt pełnego, kilkuzdaniowego tekstu po odpowiedzi.
 * Dłuższy bodziec niż jednozdaniowe luki gramatyki, a `correctText` to cały
 * wypełniony tekst — dok musi zmieścić w viewporcie „Posłuchaj zdania”, „?”
 * i „Dalej” także w niskim landscape (<480 px), a długa treść wyniku przewija
 * się wewnątrz doku. Materiał obok doku zachowuje czytelne minimum, a pierwszą
 * lukę tekstu da się przewinąć do kontenera materiału nad dokiem (telefon,
 * landscape, tablet, desktop). Treść jest zmyślona. Symulacja nie zastępuje
 * odbioru na fizycznym urządzeniu.
 */
const clozeUid = (n: number) => `10000000-0000-4000-8000-0000000009${String(n).padStart(2, "0")}`;
const clozeSolution = ["sun hat", "swimming costume", "sandcastle"];
const clozeTask: TaskDto = {
  taskId: clozeUid(41), sessionId: ids.sessionId, ordinal: 1, exerciseType: "lesson_cloze", direction: null, state: "issued", remainingAssessed: 2,
  prompt: {
    kind: "lesson_cloze",
    instructionPl: "W weekend jedziemy nad morze. Rano zakładam kapelusz przeciwsłoneczny i strój kąpielowy. Mój młodszy brat buduje na plaży duży zamek z piasku, a mama kupuje nam lody. Uzupełnij tekst.",
    contentLocale: "en-GB",
    segments: [
      { text: "At the weekend we go to the seaside. In the morning I put on my " },
      { gapId: clozeUid(42) },
      { text: " and my " },
      { gapId: clozeUid(43) },
      { text: ". My little brother builds a big " },
      { gapId: clozeUid(44) },
      { text: " on the beach, and Mum buys us ice cream." },
    ],
    words: [
      { id: clozeUid(51), text: "sun hat" },
      { id: clozeUid(52), text: "swimming costume" },
      { id: clozeUid(53), text: "sandcastle" },
      { id: clozeUid(54), text: "umbrella" },
      { id: clozeUid(55), text: "woolly gloves" },
    ],
  },
};
/** Pełny wypełniony tekst z poprawnymi słowami (jak `filledText` serwera). */
const clozeFilledText = (() => {
  if (clozeTask.prompt.kind !== "lesson_cloze") throw new Error("cloze fixture expected");
  let gap = 0;
  return clozeTask.prompt.segments.map((segment) => ("gapId" in segment ? clozeSolution[gap++] : segment.text)).join("");
})();

const clozeAttempt = (feedback: FeedbackDto): AttemptDto => ({
  attemptId: clozeUid(61), taskId: clozeTask.taskId, state: "completed", modality: "assignment",
  taskState: "answered", stepId: "s1", receivedAt: "2026-10-31T10:00:01.000Z", completedAt: "2026-10-31T10:00:01.000Z",
  feedback,
});

const CLOZE_VIEWPORTS = [
  { width: 360, height: 800 },
  { width: 812, height: 375 },
  { width: 740, height: 420 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
];

const CLOZE_FEEDBACKS: { kind: string; feedback: FeedbackDto }[] = [
  { kind: "great", feedback: { kind: "great", correctAudioAssetId: sentenceAssetId } },
  { kind: "incorrect", feedback: { kind: "incorrect", correctText: clozeFilledText, correctAudioAssetId: sentenceAssetId } },
  { kind: "incorrect-explanation", feedback: { kind: "incorrect", correctText: clozeFilledText, correctAudioAssetId: sentenceAssetId,
    hintPl: EXPLANATION, explanationAudioAssetId: explanationAssetId } },
];

/**
 * Najmniejsza widoczna wysokość materiału obok doku: dwa cele dotykowe 48 px
 * (wiersz tekstu z luką i miejsce luki). Pomiar 2026-10-31: z nakładką
 * najciaśniej jest na 360×800 po błędzie (dok z całym tekstem zakrywa dół
 * materiału, nad nim zostaje ok. 167 px); przy wysokości <480 (812×375,
 * 740×420) materiał ma naturalną wysokość ok. 407 px i przewija strona.
 */
const MIN_VISIBLE_MATERIAL = 96;

test.describe("cloze with a word bank: sentence readback dock geometry", () => {
  for (const viewport of CLOZE_VIEWPORTS) {
    for (const { kind, feedback } of CLOZE_FEEDBACKS) {
      const label = `${viewport.width}x${viewport.height}`;
      test(`„Posłuchaj zdania” and „Dalej” fit ${label} after a ${kind} answer`, async ({ page }, testInfo) => {
        const posted = recordAttemptPosts(page);
        await spyAudio(page);
        const media = trackMedia(page);
        await installKidUiFixture(page, { ...lessonAudioFixture(ids, [clozeTask]), attempts: [clozeAttempt(feedback)] });
        await openLessonTask(page, "kid-lesson-cloze");
        await page.setViewportSize(viewport);
        await expect(page.getByTestId("kid-session-frame")).toHaveCSS("height", `${viewport.height}px`);
        await expect(page.getByTestId("kid-lesson-cloze-gap")).toHaveCount(3);
        expect(media).toEqual([]);

        // Odpowiedź ułożona w przeglądarce: trzy stuknięcia w bank, potem „Sprawdź”.
        await tapPoolAndCheck(page, "kid-lesson-cloze-option", 3, posted);
        const dock = page.getByTestId("kid-feedback-dock");
        await expect(dock).toBeVisible();
        if (kind === "great") await expect(page.getByTestId("kid-feedback")).toContainText("Świetnie!");
        else await expect(page.getByTestId("kid-feedback-correct-answer")).toHaveText(clozeFilledText);

        // Nagranie całego tekstu gra raz, bez akcji dziecka.
        await expect.poll(() => audioCounters(page).then((c) => c.plays)).toBe(1);
        await expect.poll(() => media).toEqual([sentencePath]);

        // Dok i jego akcje stoją w viewporcie bez przewijania strony.
        const viewportBox: Box = { x: 0, y: 0, width: viewport.width, height: viewport.height };
        const dockBox = await boxOf(dock);
        expect(within(dockBox, viewportBox), `dock in viewport at ${label}: ${JSON.stringify(dockBox)}`).toBe(true);
        const sentence = dock.getByTestId("kid-sentence-audio");
        const guidance = dock.getByTestId("kid-guidance-play");
        const next = dock.getByTestId("kid-next");
        await expect(sentence).toHaveAttribute("aria-label", "Posłuchaj zdania");
        const slow = dock.getByTestId("kid-sentence-audio-slow");
        await expect(slow).toHaveAttribute("aria-label", "Posłuchaj wolniej");
        const boxes = { sentence: await boxOf(sentence), slow: await boxOf(slow), guidance: await boxOf(guidance), next: await boxOf(next) };
        for (const [name, bounds] of Object.entries(boxes)) {
          expect(within(bounds, dockBox), `${name} inside dock at ${label}: ${JSON.stringify(bounds)}`).toBe(true);
          expect(within(bounds, viewportBox), `${name} inside viewport at ${label}: ${JSON.stringify(bounds)}`).toBe(true);
          expect(bounds.width, `${name} width at ${label}`).toBeGreaterThanOrEqual(48);
          expect(bounds.height, `${name} height at ${label}`).toBeGreaterThanOrEqual(48);
        }
        // „Dalej” to akcja główna.
        expect(boxes.next.height, `next height at ${label}`).toBeGreaterThanOrEqual(54);
        expect(overlaps(boxes.sentence, boxes.guidance), `sentence/guidance overlap at ${label}`).toBe(false);
        expect(overlaps(boxes.sentence, boxes.next), `sentence/next overlap at ${label}`).toBe(false);
        expect(overlaps(boxes.guidance, boxes.next), `guidance/next overlap at ${label}`).toBe(false);
        expect(overlaps(boxes.sentence, boxes.slow), `sentence/slow overlap at ${label}`).toBe(false);
        expect(overlaps(boxes.slow, boxes.guidance), `slow/guidance overlap at ${label}`).toBe(false);
        expect(overlaps(boxes.slow, boxes.next), `slow/next overlap at ${label}`).toBe(false);
        await expectSentenceGroupLayout(page, label);

        // Kontener materiału obok doku. Poniżej 480 px wysokości przewija się strona, a dok stoi
        // w przepływie pod materiałem; wyżej dok jest nakładką na dolną krawędź materiału
        // (`ExerciseFrame`), więc widoczny materiał kończy się na górnej krawędzi doku.
        const pageScrolls = viewport.height < 480;
        if (pageScrolls) await expect(page.locator(".kid-page")).toHaveAttribute("data-viewport-very-short", "true");
        else await expect(page.locator(".kid-page")).not.toHaveAttribute("data-viewport-very-short", "true");
        // Materiał i dok mierzone w jednej chwili — przewinięcie strony po pokazaniu doku nie
        // rozjedzie porównania.
        const material = page.getByTestId("kid-material");
        const [materialBox, dockWithMaterial] = await page.evaluate(() => {
          const rect = (testId: string) => {
            const r = document.querySelector(`[data-testid="${testId}"]`)!.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          };
          return [rect("kid-material"), rect("kid-feedback-dock")] as const;
        });
        const materialBottom = materialBox.y + materialBox.height;
        const geometry = `material ${JSON.stringify(materialBox)}, dock ${JSON.stringify(dockWithMaterial)} at ${label}`;
        if (pageScrolls) {
          expect(materialBottom, `material bottom above the dock: ${geometry}`).toBeLessThanOrEqual(dockWithMaterial.y + 1);
          // Materiał ma naturalną wysokość (nie jest ściśnięty przez dok) — przewija strona.
          expect(materialBox.height, `material height: ${geometry}`).toBeGreaterThanOrEqual(MIN_VISIBLE_MATERIAL);
        } else {
          const visible = Math.min(materialBottom, dockWithMaterial.y) - Math.max(materialBox.y, 0);
          expect(visible, `material visible above the dock: ${geometry}`).toBeGreaterThanOrEqual(MIN_VISIBLE_MATERIAL);
        }
        // Wynik z całym tekstem mieści się w szerokości doku (wysokość przewija się w środku).
        const result = await boxOf(page.getByTestId("kid-feedback"));
        expect(result.x, `feedback inside dock at ${label}`).toBeGreaterThanOrEqual(dockBox.x - 1);
        expect(result.x + result.width, `feedback inside dock at ${label}`).toBeLessThanOrEqual(dockBox.x + dockBox.width + 1);

        const overflow = await page.evaluate(() => {
          const horizontal = (element: Element | null): boolean => element !== null && element.scrollWidth > element.clientWidth + 1;
          return {
            page: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            material: horizontal(document.querySelector("[data-testid='kid-material']")),
            dock: horizontal(document.querySelector("[data-testid='kid-feedback-dock']")),
            feedback: horizontal(document.querySelector("[data-testid='kid-feedback']")),
          };
        });
        expect(overflow, `horizontal overflow at ${label}`).toEqual({ page: false, material: false, dock: false, feedback: false });
        await page.screenshot({ path: testInfo.outputPath(`cloze-sentence-audio-${kind}-${label}.png`) });

        // Długi wypełniony tekst nie jest trwale przycięty: po przewinięciu treści wyniku do końca
        // jego ostatnia linia stoi w obszarze treści doku i w viewporcie.
        if (kind === "incorrect") {
          const content = dock.locator(".kid-feedback-content");
          await content.evaluate((element) => { element.scrollTop = element.scrollHeight; });
          const contentBox = await boxOf(content);
          const answerBox = await boxOf(page.getByTestId("kid-feedback-correct-answer"));
          expect(answerBox.y + answerBox.height, `last line in feedback content at ${label}`).toBeLessThanOrEqual(contentBox.y + contentBox.height + 1);
          expect(answerBox.y + answerBox.height, `last line in viewport at ${label}`).toBeLessThanOrEqual(viewport.height + 1);
          await content.evaluate((element) => { element.scrollTop = 0; });
        }
        // Wyjaśnienie pod długim wynikiem (spec 2026-11-01-lesson-error-explanation §6, K1):
        // wiersz stoi poza przewijaną kartą wyniku, więc tekst i „Posłuchaj wyjaśnienia” są
        // w doku i w viewporcie od razu — bez przewijania karty ani strony.
        if (kind === "incorrect-explanation") {
          const explanationBoxes = { text: await boxOf(dock.getByTestId("kid-explanation-text")), listen: await boxOf(dock.getByTestId("kid-explanation-audio")) };
          const scrolled = await page.evaluate(() => ({
            page: document.scrollingElement?.scrollTop ?? 0,
            card: document.querySelector("[data-testid='kid-feedback-dock'] .kid-feedback-content")?.scrollTop ?? 0,
          }));
          const pinned = `${JSON.stringify({ ...explanationBoxes, dock: dockBox, next: boxes.next, scrolled })} at ${label}`;
          expect(scrolled.card, `result card not scrolled: ${pinned}`).toBe(0);
          for (const [name, bounds] of Object.entries(explanationBoxes)) {
            expect(within(bounds, dockBox), `explanation ${name} in dock: ${pinned}`).toBe(true);
            expect(within(bounds, viewportBox), `explanation ${name} in viewport without scrolling: ${pinned}`).toBe(true);
            expect(overlaps(bounds, boxes.next), `explanation ${name} overlaps „Dalej”: ${pinned}`).toBe(false);
          }
          // Wiersz stoi pod wynikiem i nad „Dalej”.
          expect(explanationBoxes.text.y + explanationBoxes.text.height, `explanation above „Dalej”: ${pinned}`).toBeLessThanOrEqual(boxes.next.y + 1);
          expect(explanationBoxes.listen.width, `explanation listen width: ${pinned}`).toBeGreaterThanOrEqual(48);
          expect(explanationBoxes.listen.height, `explanation listen height: ${pinned}`).toBeGreaterThanOrEqual(48);
        }

        // Pierwszą lukę tekstu da się przewinąć do kontenera materiału: w nim, w viewporcie i nad dokiem.
        const firstGap = page.getByTestId("kid-lesson-cloze-gap").first();
        await firstGap.scrollIntoViewIfNeeded();
        const gapBox = await boxOf(firstGap);
        const materialNow = await boxOf(material);
        const dockNow = await boxOf(dock);
        const reached = `gap ${JSON.stringify(gapBox)}, material ${JSON.stringify(materialNow)}, dock ${JSON.stringify(dockNow)} at ${label}`;
        expect(within(gapBox, materialNow), `first gap inside material: ${reached}`).toBe(true);
        expect(within(gapBox, viewportBox), `first gap inside viewport: ${reached}`).toBe(true);
        expect(gapBox.y + gapBox.height, `first gap above the dock: ${reached}`).toBeLessThanOrEqual(dockNow.y + 1);

        // Koniec materiału (bank słów pod tekstem) da się przewinąć nad dok: przewija kontener
        // materiału, a poniżej 480 px wysokości strona (każdy przodek przewinięty do końca). Liczy
        // się dolna krawędź najniższego elementu treści, nie rezerwa pod nią.
        await material.evaluate((element) => {
          for (let node: Element | null = element; node !== null; node = node.parentElement) node.scrollTop = node.scrollHeight;
        });
        const end = await page.evaluate(() => {
          const content = document.querySelector("[data-testid='kid-material'] .kid-material-content")!;
          const bottoms = [...content.querySelectorAll("*")].map((element) => element.getBoundingClientRect().bottom);
          const dockRect = document.querySelector("[data-testid='kid-feedback-dock']")!.getBoundingClientRect();
          const materialRect = document.querySelector("[data-testid='kid-material']")!.getBoundingClientRect();
          return { contentBottom: Math.max(...bottoms), dockTop: dockRect.y, materialTop: materialRect.top, materialBottom: materialRect.bottom };
        });
        const ended = `${JSON.stringify(end)} at ${label}`;
        expect(end.contentBottom, `end of material above the dock: ${ended}`).toBeLessThanOrEqual(end.dockTop + 1);
        expect(end.contentBottom, `end of material in viewport: ${ended}`).toBeLessThanOrEqual(viewport.height + 1);
        // …i nie uciekł nad widoczny obszar materiału.
        expect(end.contentBottom, `end of material visible: ${ended}`).toBeGreaterThan(Math.max(0, end.materialTop));
        // Poniżej 480 px dok stoi w przepływie tuż pod materiałem — bez pustego pasa po ukrytych akcjach.
        if (pageScrolls) expect(end.dockTop - end.materialBottom, `blank band between material and dock: ${ended}`).toBeLessThanOrEqual(24);

        // Autoodtwarzanie nie powtórzyło się samo; „Posłuchaj zdania” gra drugi raz.
        expect((await audioCounters(page)).plays).toBe(1);
        await sentence.click();
        await expect.poll(() => audioCounters(page).then((c) => c.plays)).toBe(2);
        await expect.poll(() => media).toEqual([sentencePath, sentencePath]);
      });
    }
  }
});

/**
 * Dotykowy tablet w poziomie (`pointer: coarse`, zwarta rama od 960 × 480) z
 * długą treścią — tekst z lukami (panel w nakładce) i wybór z długim poleceniem
 * (panel w przepływie): pod stopką nie ma wolnego miejsca, więc panel rośnie
 * w górę. Tekst błędu ręcznego odsłuchu staje wtedy nad górnym wierszem
 * (`data-frame-full`) i nie przesuwa przycisków zdania ani „Dalej”.
 */
const TABLET_TOUCH_VIEWPORTS = [
  { width: 1024, height: 600 },
  { width: 1280, height: 800 },
];

/** Wybór z długim poleceniem i zdaniem: panel w przepływie (`feedbackLayout="flow"`). */
const longChoiceTask: TaskDto = {
  taskId: clozeUid(71), sessionId: ids.sessionId, ordinal: 1, exerciseType: "lesson_choice", direction: null, state: "issued", remainingAssessed: 2,
  prompt: {
    kind: "lesson_choice",
    instructionPl: "Przeczytaj uważnie całe zdanie o wakacjach nad morzem i wybierz słowo, które pasuje do luki. ".repeat(9).trim(),
    stem: "Every summer my whole family travels to the seaside, and every morning my little brother ___ a big sandcastle near the water.",
    contentLocale: "en-GB",
    options: [
      { id: clozeUid(72), text: "builds" },
      { id: clozeUid(73), text: "build" },
      { id: clozeUid(74), text: "building" },
      { id: clozeUid(75), text: "is build" },
    ],
  },
};
const longChoiceAttempt: AttemptDto = {
  ...clozeAttempt({ kind: "incorrect", correctText: "builds", correctAudioAssetId: sentenceAssetId }),
  taskId: longChoiceTask.taskId, modality: "choice",
};

const TABLET_SCENARIOS: { name: string; task: TaskDto; attempt: AttemptDto; ready: string; answer: (page: Page, posted: unknown[]) => Promise<void> }[] = [
  {
    name: "overflowing cloze (overlay dock)", task: clozeTask, ready: "kid-lesson-cloze",
    attempt: clozeAttempt({ kind: "incorrect", correctText: clozeFilledText, correctAudioAssetId: sentenceAssetId }),
    answer: async (page, posted) => { await tapPoolAndCheck(page, "kid-lesson-cloze-option", 3, posted); },
  },
  {
    name: "long choice (flow dock)", task: longChoiceTask, ready: "kid-lesson-stem", attempt: longChoiceAttempt,
    answer: (page) => page.getByTestId("kid-option").nth(1).tap(),
  },
];

for (const viewport of TABLET_TOUCH_VIEWPORTS) {
  const label = `${viewport.width}x${viewport.height}`;
  test.describe(`touch tablet ${label}`, () => {
    test.use({ isMobile: true, hasTouch: true });
    for (const scenario of TABLET_SCENARIOS) {
      test(`${scenario.name}: the replay error keeps the sentence buttons and „Dalej” still at ${label}`, async ({ page }) => {
        const posted = recordAttemptPosts(page);
        await spyAudio(page, "reject");
        await installKidUiFixture(page, { ...lessonAudioFixture(ids, [scenario.task]), attempts: [scenario.attempt] });
        // `openLessonTask` otwiera zadanie w oknie telefonu; rozmiar tabletu dopiero potem.
        await openLessonTask(page, scenario.ready);
        await page.setViewportSize(viewport);
        await expectFrameFillsViewport(page, viewport);
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "a touch screen").toBe(true);
        await scenario.answer(page, posted);
        const dock = page.getByTestId("kid-feedback-dock");
        await expect(dock).toBeVisible();
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        // Scenariusz wymaga ramy bez wolnego miejsca pod stopką — bez niego test niczego nie sprawdza.
        await expect(page.locator(".kid-page")).toHaveAttribute("data-zoomed", "false");
        await expect(page.locator("[data-frame-full]"), `frame full at ${label}`).toHaveCount(1);
        const error = page.getByTestId("kid-sentence-audio-error");
        await expect(error).toHaveText("");
        const targets = { sentence: dock.getByTestId("kid-sentence-audio"), slow: dock.getByTestId("kid-sentence-audio-slow"), next: dock.getByTestId("kid-next") };
        const measure = async () => ({ sentence: await boxOf(targets.sentence), slow: await boxOf(targets.slow), next: await boxOf(targets.next) });
        const before = await measure();

        await targets.slow.tap();
        await expect(error).toHaveText(messages.kid.sentenceAudioFailed);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const after = await measure();
        for (const name of Object.keys(targets) as (keyof typeof targets)[]) {
          const moved = `${name} before ${JSON.stringify(before[name])}, after ${JSON.stringify(after[name])} at ${label}`;
          expect(Math.abs(after[name].x - before[name].x), `x: ${moved}`).toBeLessThanOrEqual(1);
          expect(Math.abs(after[name].y - before[name].y), `y: ${moved}`).toBeLessThanOrEqual(1);
        }
        const errorBox = await boxOf(error);
        expect(within(errorBox, await boxOf(dock)), `error inside dock at ${label}`).toBe(true);
        expect(overlaps(errorBox, after.sentence) || overlaps(errorBox, after.slow), `error overlaps a sentence button at ${label}`).toBe(false);
        expect(errorBox.y + errorBox.height, `error above the sentence row at ${label}`).toBeLessThanOrEqual(Math.min(after.sentence.y, after.slow.y) + 1);
        expect(within(after.next, { x: 0, y: 0, ...viewport }), `„Dalej” in viewport at ${label}`).toBe(true);
      });
    }
  });
}

test.describe("touch tablet 1280x800: flow dock follows content height", () => {
  test.use({ isMobile: true, hasTouch: true });
  test("data-frame-full drops when the content above the flow dock shrinks", async ({ page }) => {
    await spyAudio(page, "reject");
    await installKidUiFixture(page, { ...lessonAudioFixture(ids, [longChoiceTask]), attempts: [longChoiceAttempt] });
    await openLessonTask(page, "kid-lesson-stem");
    const viewport = { width: 1280, height: 800 };
    await page.setViewportSize(viewport);
    await expectFrameFillsViewport(page, viewport);
    await page.getByTestId("kid-option").nth(1).tap();
    await expect(page.getByTestId("kid-feedback-dock")).toBeVisible();
    await expect(page.locator("[data-frame-full]")).toHaveCount(1);
    // Sama treść maleje (rama i panel bez zmian) — stopka podjeżdża, pod nią
    // pojawia się wolne miejsce i atrybut musi zniknąć.
    await page.evaluate(() => {
      for (const id of ["kid-instruction", "kid-lesson-stem"]) {
        const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
        if (element) element.style.display = "none";
      }
    });
    await expect(page.locator("[data-frame-full]")).toHaveCount(0);
  });
});
