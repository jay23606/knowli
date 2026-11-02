import { expect, test, type Locator, type Page, type Route, type TestInfo } from "@playwright/test";
import type { AttemptDto, DisclosureDto } from "@learning/contracts";
import { expectFrameFillsViewport, nextFrames, waitForKidScale } from "./helpers/kid-frame";
import type { Viewport } from "./helpers/kid-layout";
import { installKidUiFixture } from "./helpers/kid-ui-fixture";
import {
  endListenPlayback,
  listenAudioPlays,
  listenChoiceTask,
  lessonAudioFixture,
  openLessonTask,
  setListenAudioMode,
  stubListenAudio,
  type ListenAudioMode,
} from "./helpers/lesson-audio";

/**
 * „Posłuchaj i wybierz” (`lesson_listen_choice`, spec 2026-11-01 §8 i §12, API
 * zaślepione w przeglądarce): autoodtwarzanie zdania po wyświetleniu zadania
 * przez autoryzację serwera (`/disclosures`, kind `audio`) i dopiero potem
 * pobranie nagrania; opcje nieaktywne do końca odsłuchu; stany blokady
 * autoodtwarzania, odmowy, wiszącego nagrania i braku sieci; odczyt zdania po
 * odpowiedzi; geometria najgorszego przypadku (zdanie 193 znaki, 4 opcje) na
 * telefonie, w niskim landscape, na tablecie dotykowym, desktopie i przy skali
 * > 1. `HTMLMediaElement.play` jest podmienione — test liczy wywołania, nie
 * słyszy dźwięku, więc nie zastępuje odbioru na fizycznym urządzeniu (polityka
 * autoodtwarzania Safari na iPhonie/iPadzie, słyszalność form w głosie lektora).
 */

const ids = {
  childId: "10000000-0000-4000-8000-000000000a01",
  deckId: "10000000-0000-4000-8000-000000000a02",
  sessionId: "10000000-0000-4000-8000-000000000a03",
  deckVersionId: "10000000-0000-4000-8000-000000000a04",
};
const taskId = "10000000-0000-4000-8000-000000000a11";
const optionIds = ["a21", "a22", "a23", "a24"].map((suffix) => `10000000-0000-4000-8000-000000000${suffix}`);
/**
 * Bodziec i odczyt po odpowiedzi to w aplikacji to samo nagranie `feedback_audio`;
 * osobne id pozwalają odróżnić w ruchu sieciowym, które odtworzenie pobrało plik.
 */
const stimulusAssetId = "10000000-0000-4000-8000-000000000a31";
const sentenceAssetId = "10000000-0000-4000-8000-000000000a32";

const task = listenChoiceTask(ids.sessionId, taskId, optionIds);
const disclosure: DisclosureDto = { taskId, stepId: "d1", kind: "audio", reveal: null, audioAssetId: stimulusAssetId };
const answered: AttemptDto = {
  attemptId: "10000000-0000-4000-8000-000000000a41", taskId, state: "completed", modality: "choice",
  taskState: "answered", stepId: "s1", receivedAt: "2026-11-01T10:00:01.000Z", completedAt: "2026-11-01T10:00:01.000Z",
  feedback: { kind: "great", correctAudioAssetId: sentenceAssetId },
};

/** Kolejność żądań: `auth` — POST autoryzacji odsłuchu, `media:<id>` — pobranie nagrania. */
function trackTraffic(page: Page): string[] {
  const log: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === `/api/v1/kid/tasks/${taskId}/disclosures`) log.push("auth");
    if (path.startsWith("/api/v1/media/")) log.push(`media:${path.slice("/api/v1/media/".length)}`);
  });
  return log;
}
const count = (log: string[], entry: string) => log.filter((item) => item === entry).length;

/** Zastępuje odpowiedź autoryzacji (zarejestrowane po fixture, więc ma pierwszeństwo); `null` oddaje fixture'owi. */
type AuthorizationOverride = (route: Route) => Promise<void> | null;

async function open(page: Page, setup: {
  mode: ListenAudioMode; authorization?: AuthorizationOverride; routes?: (page: Page) => Promise<unknown>; readyTestId?: string;
} = { mode: "end" }): Promise<string[]> {
  await stubListenAudio(page, setup.mode);
  const log = trackTraffic(page);
  await installKidUiFixture(page, { ...lessonAudioFixture(ids, [task]), disclosure, attempts: [answered] });
  if (setup.authorization) {
    const override = setup.authorization;
    await page.route(`**/api/v1/kid/tasks/${taskId}/disclosures`, async (route) => {
      const handled = override(route);
      if (handled === null) await route.fallback();
      else await handled;
    });
  }
  // Trasy zarejestrowane po fixture mają pierwszeństwo przed jego trasami.
  await setup.routes?.(page);
  await openLessonTask(page, setup.readyTestId ?? "kid-lesson-stem");
  return log;
}

const options = (page: Page) => page.getByTestId("kid-option");

async function expectOptionsLocked(page: Page, locked: boolean): Promise<void> {
  await expect(options(page)).toHaveCount(4);
  for (const option of await options(page).all()) {
    if (locked) await expect(option).toBeDisabled();
    else await expect(option).toBeEnabled();
  }
}

/** Pusty `alert` poza `main` to ogłaszacz tras Next.js. */
async function expectNoAlert(page: Page): Promise<void> {
  await expect(page.locator("main.kid-learning").getByRole("alert")).toHaveCount(0);
}

test.describe("behaviour", () => {
  test("autoplay authorizes once, fetches the recording only afterwards and unlocks the options at the end of playback", async ({ page }) => {
    let releaseAuthorization!: () => void;
    const held = new Promise<void>((resolve) => { releaseAuthorization = resolve; });
    const log = await open(page, { mode: "hold", authorization: (route) => held.then(() => route.fallback()) });

    const play = page.getByTestId("kid-play");
    await expect(play).toHaveAttribute("aria-label", "Posłuchaj zdania");
    await expect(play).toBeFocused();
    await expect(page.getByTestId("kid-instruction")).toContainText("Posłuchaj i wybierz, czego brakuje.");
    const stem = page.getByTestId("kid-lesson-stem");
    await expect(stem).toHaveAttribute("lang", "en-GB");
    await expect(stem).not.toContainText("___");
    await expect(page.getByTestId("kid-listen-gap")).toHaveAttribute("aria-label", /.+/);

    // Autoryzacja wisi: nagranie nie jest pobierane, opcje czekają.
    await expect.poll(() => count(log, "auth")).toBe(1);
    await page.waitForTimeout(300);
    expect(log, "no recording before the authorization").toEqual(["auth"]);
    await expectOptionsLocked(page, true);

    releaseAuthorization();
    await expect.poll(() => [...log]).toEqual(["auth", `media:${stimulusAssetId}`]);
    await expect.poll(() => listenAudioPlays(page)).toBe(1);
    await expect(play).toHaveAttribute("data-sound-active", "true");
    // Trwa odsłuch: opcje nadal nieaktywne (zapas bez długości to 8 s).
    await page.waitForTimeout(500);
    await expectOptionsLocked(page, true);

    await endListenPlayback(page);
    await expectOptionsLocked(page, false);
    await expect(play).not.toHaveAttribute("data-sound-active", "true");
    expect(count(log, "auth"), "autoplay authorizes exactly once").toBe(1);
    expect(await listenAudioPlays(page)).toBe(1);
  });

  test("a replay interrupting the first playback keeps the options locked until the replay ends", async ({ page }) => {
    const log = await open(page, { mode: "hold" });
    await expect.poll(() => listenAudioPlays(page)).toBe(1);
    await page.getByTestId("kid-play").click();
    await expect.poll(() => count(log, "auth")).toBe(2);
    await expect.poll(() => listenAudioPlays(page)).toBe(2);
    await expectOptionsLocked(page, true);
    await endListenPlayback(page);
    await expectOptionsLocked(page, false);
  });

  test("Space and the button replay the sentence, each with one new authorization", async ({ page }) => {
    const log = await open(page, { mode: "end" });
    await expectOptionsLocked(page, false);
    await expect(page.getByTestId("kid-play")).toBeFocused();
    expect(count(log, "auth")).toBe(1);

    await page.keyboard.press("Space");
    await expect.poll(() => count(log, "auth")).toBe(2);
    await expect.poll(() => listenAudioPlays(page)).toBe(2);
    await expect.poll(() => count(log, `media:${stimulusAssetId}`)).toBe(2);

    await page.getByTestId("kid-play").click();
    await expect.poll(() => count(log, "auth")).toBe(3);
    await expect.poll(() => listenAudioPlays(page)).toBe(3);
    // Powtórka nie zamyka otwartych opcji.
    await expectOptionsLocked(page, false);
    await page.waitForTimeout(300);
    expect(count(log, "auth"), "one authorization per replay").toBe(3);
  });

  test("after the answer the sentence is read back and the instruction button replays it without a new authorization", async ({ page }) => {
    const log = await open(page, { mode: "end" });
    await expectOptionsLocked(page, false);
    const playsBefore = await listenAudioPlays(page);
    await options(page).first().click();

    const dock = page.getByTestId("kid-feedback-dock");
    await expect(dock).toBeVisible();
    await expect(page.getByTestId("kid-feedback")).toContainText("Świetnie!");
    // Odczyt zdania z feedbacku gra sam, raz.
    await expect.poll(() => listenAudioPlays(page)).toBe(playsBefore + 1);
    await expect.poll(() => count(log, `media:${sentenceAssetId}`)).toBe(1);
    // Dok nie ma drugiego głośnika: komunikat głosowy to „?”, a odczyt jest w poleceniu.
    await expect(dock.getByTestId("kid-sentence-audio")).toHaveCount(0);
    await expect(dock.getByTestId("kid-guidance-play")).toHaveAttribute("data-guidance-icon", "question");

    const play = page.getByTestId("kid-play");
    await expect(play).toBeEnabled();
    await expect(play).toHaveAttribute("aria-label", "Posłuchaj zdania");
    await play.click();
    await expect.poll(() => count(log, `media:${sentenceAssetId}`)).toBe(2);
    await expect.poll(() => listenAudioPlays(page)).toBe(playsBefore + 2);
    await page.waitForTimeout(300);
    expect(count(log, "auth"), "a replay after the answer authorizes nothing new").toBe(1);
    expect(count(log, `media:${stimulusAssetId}`)).toBe(1);
  });

  test("blocked autoplay shows a polite status and a press on the highlighted button plays the sentence", async ({ page }) => {
    const log = await open(page, { mode: "reject" });
    const status = page.getByTestId("kid-listen-status");
    await expect(status).toHaveText("Dotknij głośnika, aby posłuchać.");
    await expect(status).toHaveAttribute("role", "status");
    const play = page.getByTestId("kid-play");
    await expect(play).toHaveAttribute("data-attention", "true");
    await expect(play).toBeEnabled();
    // Wyróżnienie to wypełnienie przycisku, nie obrys identyczny z fokusem.
    const highlighted = await play.evaluate((element) => getComputedStyle(element).backgroundColor);
    await expectOptionsLocked(page, true);
    await expectNoAlert(page);
    await expect(page.getByTestId("kid-listen-skip")).toHaveCount(0);

    await setListenAudioMode(page, "end");
    await play.click();
    await expectOptionsLocked(page, false);
    // Linia statusu zostaje w układzie, pusta.
    await expect(status).toHaveText("");
    await expect(play).not.toHaveAttribute("data-attention", "true");
    await page.mouse.move(0, 0);
    expect(await play.evaluate((element) => getComputedStyle(element).backgroundColor), "the highlight is a distinct fill").not.toBe(highlighted);
    expect(count(log, "auth")).toBe(2);
  });

  test("blocked autoplay without a press offers „Pomiń” after about 6 s", async ({ page }) => {
    await open(page, { mode: "reject" });
    await expect(page.getByTestId("kid-listen-status")).toHaveText("Dotknij głośnika, aby posłuchać.");
    const skip = page.getByTestId("kid-listen-skip");
    await expect(skip).toHaveCount(0);
    await expect(skip).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("kid-play")).toBeEnabled();
    await expectOptionsLocked(page, true);
    await expectNoAlert(page);
  });

  test("a manual press blocked by the browser offers „Pomiń” with a message only, and „Pomiń” clears it", async ({ page }) => {
    const log = await open(page, { mode: "reject" });
    const status = page.getByTestId("kid-listen-status");
    await expect(status).toHaveText("Dotknij głośnika, aby posłuchać.");
    await page.getByTestId("kid-play").click();
    await expect.poll(() => count(log, "auth")).toBe(2);

    const skip = page.getByTestId("kid-listen-skip");
    await expect(skip).toBeVisible();
    const notice = page.getByTestId("kid-task-audio-error");
    await expect(notice).toHaveText("Nie udało się odtworzyć nagrania.");
    // Sam komunikat: bez martwego „Odtwórz ponownie” i bez „Koniec” — ponawia głośnik, a „Pomiń” jest w zadaniu.
    await expect(notice.getByRole("button")).toHaveCount(0);
    await expect(status).toHaveText("");
    await expect(page.getByTestId("kid-play")).not.toHaveAttribute("data-attention", "true");
    await expectOptionsLocked(page, true);

    await skip.click();
    const dock = page.getByTestId("kid-feedback-dock");
    await expect(dock).toBeVisible();
    await expect(notice).toHaveCount(0);
    // Głośnik polecenia jest obok: komunikat w doku to „?”, nawet bez odczytu zdania.
    await expect(dock.getByTestId("kid-guidance-play")).toHaveAttribute("data-guidance-icon", "question");
  });

  test("a refused authorization (409) offers „Pomiń” with locked options, and a successful replay opens them", async ({ page }) => {
    let refuse = true;
    const log = await open(page, {
      mode: "end",
      authorization: (route) => refuse
        ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "conflict", message: "x", retryable: false }) })
        : null,
    });
    const skip = page.getByTestId("kid-listen-skip");
    // Odmowa daje „Pomiń” od razu, bez czekania 6 s.
    await expect(skip).toBeVisible({ timeout: 3_000 });
    await expect(skip).toHaveText("Pomiń");
    await expectOptionsLocked(page, true);
    await expect(page.getByTestId("kid-play")).toBeEnabled();
    // Autoodtwarzanie odmawia cicho.
    await expectNoAlert(page);
    expect(log.filter((entry) => entry.startsWith("media:")), "no recording without an authorization").toEqual([]);

    refuse = false;
    await page.getByTestId("kid-play").click();
    await expectOptionsLocked(page, false);
    await expect(skip).toHaveCount(0);
    expect(count(log, "auth")).toBe(2);
  });

  test("a recording that does not start within 6 s offers „Pomiń”", async ({ page }) => {
    let authorizedAt = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/disclosures")) authorizedAt = Date.now();
    });
    // Pobranie nagrania wisi do końca testu.
    let releaseMedia!: () => void;
    const media = new Promise<void>((resolve) => { releaseMedia = resolve; });
    const log = await open(page, {
      mode: "end",
      routes: (target) => target.route(`**/api/v1/media/${stimulusAssetId}`, async (route) => {
        await media;
        await route.abort("aborted").catch(() => undefined);
      }),
    });
    await expect.poll(() => [...log]).toEqual(["auth", `media:${stimulusAssetId}`]);
    const skip = page.getByTestId("kid-listen-skip");
    await expect(skip).toHaveCount(0);

    await expect(skip).toBeVisible({ timeout: 10_000 });
    expect(Date.now() - authorizedAt, "„Pomiń” waits about 6 s").toBeGreaterThanOrEqual(5_500);
    await expectOptionsLocked(page, true);
    await expect(page.getByTestId("kid-play")).toBeEnabled();
    expect(await listenAudioPlays(page)).toBe(0);
    releaseMedia();
  });

  test("a network failure shows the offline screen and the retry does not autoplay again", async ({ page }) => {
    let offline = true;
    const log = await open(page, {
      mode: "end", readyTestId: "kid-offline", authorization: (route) => offline ? route.abort("internetdisconnected") : null,
    });
    await expect(page.getByTestId("kid-offline")).toBeVisible();
    await expect(options(page)).toHaveCount(0);

    offline = false;
    await page.getByTestId("kid-retry").click();
    await expect(page.getByTestId("kid-lesson-stem")).toBeVisible();
    // Bodziec nie był otwarty: status i wyróżniony głośnik, jak przy zablokowanym autoodtwarzaniu.
    await expect(page.getByTestId("kid-listen-status")).toHaveText("Dotknij głośnika, aby posłuchać.");
    await expect(page.getByTestId("kid-play")).toHaveAttribute("data-attention", "true");
    await page.waitForTimeout(500);
    expect(count(log, "auth"), "no second autoplay after the retry").toBe(1);
    expect(await listenAudioPlays(page)).toBe(0);
    await expectOptionsLocked(page, true);

    await page.getByTestId("kid-play").click();
    await expectOptionsLocked(page, false);
    expect(count(log, "auth")).toBe(2);
  });
});

// --- stabilność układu ----------------------------------------------------------

/** Prostokąty zdania i opcji (piksele ekranu) — zmiana stanu bodźca nie może ich przesunąć. */
async function contentBoxes(page: Page): Promise<Box[]> {
  return page.evaluate(() => [...document.querySelectorAll("[data-testid='kid-lesson-stem'], [data-testid='kid-option']")].map((element) => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }));
}

function expectSameBoxes(actual: Box[], expected: Box[], label: string): void {
  expect(actual.length, label).toBe(expected.length);
  actual.forEach((box, index) => {
    const before = expected[index]!;
    for (const key of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(box[key] - before[key]), `${label}: element ${index} ${key} ${JSON.stringify({ before, box })}`).toBeLessThanOrEqual(0.5);
    }
  });
}

test.describe("layout stability", () => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    test(`the sentence and options keep their place pending → blocked → pending at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      let releaseAuthorization!: () => void;
      const held = new Promise<void>((resolve) => { releaseAuthorization = resolve; });
      await open(page, { mode: "reject", authorization: (route) => held.then(() => route.fallback()) });
      await page.setViewportSize(viewport);
      await page.evaluate(async () => { await document.fonts.ready; });
      await nextFrames(page);
      const status = page.getByTestId("kid-listen-status");
      await expect(status).toHaveText("");
      const pending = await contentBoxes(page);

      releaseAuthorization();
      await expect(status).toHaveText("Dotknij głośnika, aby posłuchać.");
      await nextFrames(page);
      expectSameBoxes(await contentBoxes(page), pending, "blocked");

      await setListenAudioMode(page, "hold");
      await page.getByTestId("kid-play").click();
      await expect(page.getByTestId("kid-play")).toHaveAttribute("data-sound-active", "true");
      await expect(status).toHaveText("");
      await nextFrames(page);
      expectSameBoxes(await contentBoxes(page), pending, "pending again");
    });

    test(`the sentence and options keep their place pending → unavailable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      let refuse!: () => void;
      const refused = new Promise<void>((resolve) => { refuse = resolve; });
      await open(page, {
        mode: "end",
        authorization: (route) => refused.then(() => route.fulfill({
          status: 409, contentType: "application/json", body: JSON.stringify({ code: "conflict", message: "x", retryable: false }),
        })),
      });
      await page.setViewportSize(viewport);
      await page.evaluate(async () => { await document.fonts.ready; });
      await nextFrames(page);
      const pending = await contentBoxes(page);

      refuse();
      await expect(page.getByTestId("kid-listen-skip")).toBeVisible();
      await nextFrames(page);
      expectSameBoxes(await contentBoxes(page), pending, "unavailable");
    });
  }
});

// --- geometria --------------------------------------------------------------

type GeometryState = "playing" | "blocked" | "unavailable";

interface Box { x: number; y: number; width: number; height: number }

const within = (inner: Box, outer: Box): boolean => inner.x >= outer.x - 1 && inner.y >= outer.y - 1
  && inner.x + inner.width <= outer.x + outer.width + 1 && inner.y + inner.height <= outer.y + outer.height + 1;

async function boxOf(locator: Locator): Promise<Box> {
  const bounds = await locator.boundingBox();
  if (bounds === null) throw new Error("element has no layout box");
  return bounds;
}

/**
 * Przewija element na środek okna (każdy przewijany przodek, także strona w trybie bardzo niskiego okna);
 * `scrollIntoViewIfNeeded` zostawiał element na krawędzi z ułamkiem piksela poza oknem.
 */
async function scrollToCenter(page: Page, locator: Locator): Promise<void> {
  await locator.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await nextFrames(page);
}

/** Otwiera zadanie w danym stanie bodźca: odtwarzanie trwa, autoodtwarzanie zablokowane albo odmowa („Pomiń”). */
async function openInState(page: Page, state: GeometryState): Promise<void> {
  await open(page, state === "playing" ? { mode: "hold" }
    : state === "blocked" ? { mode: "reject" }
      : {
        mode: "end",
        authorization: (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "conflict", message: "x", retryable: false }) }),
      });
  if (state === "playing") await expect(page.getByTestId("kid-play")).toHaveAttribute("data-sound-active", "true");
  if (state === "blocked") await expect(page.getByTestId("kid-listen-status")).toBeVisible();
  if (state === "unavailable") await expect(page.getByTestId("kid-listen-skip")).toBeVisible();
  await expectOptionsLocked(page, true);
}

/**
 * Przycisk odsłuchu w poleceniu (w ramie zadania i w oknie), zdanie, status i każda opcja w kontenerze materiału
 * i w oknie po przewinięciu do widoku, „Pomiń” w ramie i w oknie; cele ≥ 48 px; bez poziomego przepełnienia
 * dokumentu, ramy i materiału. Prostokąty w pikselach ekranu (przy skali > 1 też okno jest w pikselach ekranu).
 */
async function expectListenGeometry(page: Page, viewport: Viewport, scale: number, state: GeometryState, testInfo: TestInfo): Promise<void> {
  const label = `${state} at ${viewport.width}x${viewport.height}`;
  await page.setViewportSize(viewport);
  await waitForKidScale(page, scale);
  await expectFrameFillsViewport(page, viewport);
  await page.evaluate(async () => { await document.fonts.ready; });
  await nextFrames(page);
  const viewportBox: Box = { x: 0, y: 0, width: viewport.width, height: viewport.height };

  const play = page.getByTestId("kid-play");
  await scrollToCenter(page, play);
  const playBox = await boxOf(play);
  const frameBox = await boxOf(page.getByTestId("kid-exercise"));
  expect(within(playBox, viewportBox), `play button in viewport, ${label}: ${JSON.stringify(playBox)}`).toBe(true);
  expect(within(playBox, frameBox), `play button in the exercise frame, ${label}: ${JSON.stringify({ playBox, frameBox })}`).toBe(true);
  expect(playBox.width, `play button width, ${label}`).toBeGreaterThanOrEqual(48);
  expect(playBox.height, `play button height, ${label}`).toBeGreaterThanOrEqual(48);

  const inMaterial: { name: string; locator: Locator; target: boolean }[] = [
    ...(state === "blocked" ? [{ name: "status", locator: page.getByTestId("kid-listen-status"), target: false }] : []),
    { name: "stem", locator: page.getByTestId("kid-lesson-stem"), target: false },
    ...(await options(page).all()).map((locator, index) => ({ name: `option ${index}`, locator, target: true })),
  ];
  for (const { name, locator, target } of inMaterial) {
    await scrollToCenter(page, locator);
    // Element i materiał w jednej chwili — przewinięcie między odczytami nie rozjedzie porównania.
    const [box, material] = await Promise.all([
      locator.evaluate((element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }),
      page.getByTestId("kid-material").evaluate((element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }),
    ]);
    const geometry = `${name}, ${label}: ${JSON.stringify({ box, material })}`;
    expect(within(box, material), `inside the material: ${geometry}`).toBe(true);
    expect(within(box, viewportBox), `inside the viewport: ${geometry}`).toBe(true);
    if (target) {
      expect(box.width, `target width: ${geometry}`).toBeGreaterThanOrEqual(48);
      expect(box.height, `target height: ${geometry}`).toBeGreaterThanOrEqual(48);
    }
  }

  if (state === "unavailable") {
    const skip = page.getByTestId("kid-listen-skip");
    await scrollToCenter(page, skip);
    const skipBox = await boxOf(skip);
    const frameNow = await boxOf(page.getByTestId("kid-exercise"));
    expect(within(skipBox, viewportBox), `skip in viewport, ${label}: ${JSON.stringify(skipBox)}`).toBe(true);
    expect(within(skipBox, frameNow), `skip in the exercise frame, ${label}: ${JSON.stringify({ skipBox, frameNow })}`).toBe(true);
    expect(skipBox.width, `skip width, ${label}`).toBeGreaterThanOrEqual(48);
    expect(skipBox.height, `skip height, ${label}`).toBeGreaterThanOrEqual(48);
  }

  const overflow = await page.evaluate(() => {
    const horizontal = (element: Element | null): boolean => element !== null && element.scrollWidth > element.clientWidth + 1;
    return {
      page: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      frame: horizontal(document.querySelector("[data-testid='kid-exercise']")),
      material: horizontal(document.querySelector("[data-testid='kid-material']")),
      stem: horizontal(document.querySelector("[data-testid='kid-lesson-stem']")),
    };
  });
  expect(overflow, `horizontal overflow, ${label}`).toEqual({ page: false, frame: false, material: false, stem: false });
  // Pomiar musiał objąć stan, który opisuje (blokada mija po 6 s bez naciśnięcia).
  if (state === "blocked") await expect(page.getByTestId("kid-listen-status"), `still blocked, ${label}`).toHaveText(/.+/, { timeout: 0 });
  await page.screenshot({ path: testInfo.outputPath(`listen-choice-${state}-${viewport.width}x${viewport.height}.png`) });
}

const STATES: GeometryState[] = ["playing", "blocked", "unavailable"];

/** Telefon w portrecie, landscape < 480 px (przewijana strona), desktop i skala > 1 (mysz). */
const POINTER_WINDOWS = [
  { width: 390, height: 844, scale: 1 },
  { width: 812, height: 375, scale: 1 },
  { width: 1440, height: 900, scale: 1 },
  { width: 1920, height: 1080, scale: 1.2 },
] as const;

/**
 * Okna jednego testu. „blocked” po 6 s bez naciśnięcia przechodzi w „unavailable” („Pomiń”),
 * więc każde okno tego stanu ma świeże zadanie.
 */
function windowGroups<T>(state: GeometryState, windows: readonly T[]): T[][] {
  return state === "blocked" ? windows.map((window) => [window]) : [[...windows]];
}

const windowsLabel = (windows: readonly { width: number; height: number }[]) => windows.map(({ width, height }) => `${width}x${height}`).join(", ");

test.describe("geometry with a fine pointer", () => {
  for (const state of STATES) {
    for (const windows of windowGroups(state, POINTER_WINDOWS)) {
      test(`worst-case sentence and four options fit ${windowsLabel(windows)} (${state})`, async ({ page }, testInfo) => {
        await openInState(page, state);
        for (const { width, height, scale } of windows) {
          await expectListenGeometry(page, { width, height }, scale, state, testInfo);
        }
      });
    }
  }
});

test.describe("geometry on a touch tablet in portrait (medium width)", () => {
  // Klasa medium (600–839) przy dotyku: tablet w pionie, bez skali.
  test.use({ viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true });

  for (const state of STATES) {
    test(`worst-case sentence and four options fit 768x1024 (${state})`, async ({ page }, testInfo) => {
      await openInState(page, state);
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "a touch screen").toBe(true);
      await expectListenGeometry(page, { width: 768, height: 1024 }, 1, state, testInfo);
    });
  }
});

test.describe("geometry on a touch tablet", () => {
  // Dotykowy tablet (`pointer: coarse`) od 960×480 ma zwartą ramę i nigdy nie skaluje.
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: true, hasTouch: true });

  for (const state of STATES) {
    for (const windows of windowGroups(state, [{ width: 1024, height: 768 }, { width: 1280, height: 800 }])) {
      test(`worst-case sentence and four options fit ${windowsLabel(windows)} (${state})`, async ({ page }, testInfo) => {
        await openInState(page, state);
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "a touch screen").toBe(true);
        for (const viewport of windows) {
          await expectListenGeometry(page, viewport, 1, state, testInfo);
        }
      });
    }
  }
});
