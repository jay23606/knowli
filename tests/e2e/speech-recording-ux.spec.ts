import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { createDatabase } from "@learning/server";
import { readTestRunConfig } from "../test-run-config";
import { installKidUiFixture } from "./helpers/kid-ui-fixture";
import { pictureVocabularyFixture } from "./helpers/picture-fixtures";
import { E2E_SETUP_TOKEN } from "./helpers/parent-session";

test.use({ trace: "off", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

interface StableBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** boundingBox, który przestał się zmieniać między kolejnymi odczytami (layout po resize ustabilizowany). */
async function stableBoundingBox(page: Page, locator: Locator, timeoutMs = 5_000): Promise<StableBox> {
  const deadline = Date.now() + timeoutMs;
  let previous = await locator.boundingBox();
  while (Date.now() < deadline) {
    await page.waitForTimeout(50);
    const current = await locator.boundingBox();
    if (
      previous !== null && current !== null &&
      previous.x === current.x && previous.y === current.y &&
      previous.width === current.width && previous.height === current.height
    ) {
      return current;
    }
    previous = current;
  }
  throw new Error(`boundingBox nie ustabilizował się w ${timeoutMs} ms`);
}

type Pool = ReturnType<typeof createDatabase>["pool"];
let databasePool: Pool | null = null;

async function pool(): Promise<Pool> {
  if (databasePool === null) {
    const world = JSON.parse(await readFile(join(process.cwd(), readTestRunConfig(process.env).worldFile), "utf8")) as { databaseUrl: string };
    databasePool = createDatabase(world.databaseUrl).pool;
  }
  return databasePool;
}

test.afterAll(async () => { await databasePool?.end(); });

async function query<T>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await (await pool()).query(sql, values)).rows as T[];
}

interface TaskRow {
  answer_key: { target: string; correctOptionId: string };
  public_prompt: { options?: Array<{ id: string; text: string | null; labelPl: string | null }> };
}

async function taskRow(taskId: string): Promise<TaskRow> {
  return (await query<TaskRow>(
    "select answer_key, public_prompt from learning_app.session_tasks where id = $1", [taskId],
  ))[0]!;
}

/**
 * Etykieta poprawnej opcji obrazkowej: w UI widnieje labelPl (visual niesie
 * obrazek/cyfrę), więc labelPl ma pierwszeństwo przed tekstem.
 */
async function correctOptionLabel(taskId: string): Promise<string> {
  const row = await taskRow(taskId);
  const correct = row.public_prompt.options!.find((o) => o.id === row.answer_key.correctOptionId);
  return correct!.labelPl ?? correct!.text!;
}

function currentFeedback(page: Page) {
  return page.getByTestId("kid-feedback").or(page.getByTestId("kid-speech-feedback"));
}

/**
 * Czeka na stabilny, interaktywny stan kroku; trwające (także automatyczne)
 * nagrywanie traktujemy jako stabilne — jego domknięcie należy do testu.
 */
async function taskSettled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    if (document.querySelector('[data-testid="kid-recording"]') !== null) return true;
    const disabled = [...document.querySelectorAll("[data-testid][disabled]")];
    const input = document.querySelector('[data-testid="kid-input"]');
    if (input !== null && !input.hasAttribute("disabled")) {
      return disabled.every((el) => el.getAttribute("data-testid") === "kid-submit");
    }
    return disabled.length === 0;
  }, undefined, { timeout: 20_000 });
}

/**
 * Świat testów auto-próby (quick 261021-lsw): profil nieczytający + zestaw
 * obrazkowy z mikrofonem. Po prezentacjach i sukcesie rozpoznawania scheduler
 * wydaje wprowadzenie recall (picture_recall, ręczne), a następnie — jako
 * kolejny wybór etapu — ćwiczenie wymowy (picture_speech), na którym auto-próba
 * ma rozpoczynać nagrywanie sama (scheduler-picture-reader.test.ts „nieczytający
 * z włączonym mikrofonem po opanowaniu słuchania otrzymuje picture_recall i speech").
 */
async function openPictureSpeechSession(page: Page, name: string): Promise<void> {
  const parent = page.request;
  await parent.post("/api/v1/parent/setup", { data: { secret: "1234", setupToken: E2E_SETUP_TOKEN } });
  expect((await parent.post("/api/v1/parent/login", { data: { secret: "1234" } })).status()).toBe(200);
  const child = await (await parent.post("/api/v1/parent/children", {
    data: { displayName: name, avatarKey: "fox", canRead: false },
  })).json() as { id: string };
  // tryb przełącznika upraszcza ręczne domknięcie picture_recall w pętli
  expect((await parent.patch(`/api/v1/parent/children/${child.id}`, { data: { recordingMode: "toggle" } })).status()).toBe(200);
  const idempotencyKey = `speech-auto-${randomUUID()}`;
  const generated = await parent.post("/api/v1/parent/decks/generate", {
    data: { prompt: "angielskie dni tygodnia dla początkującego dziecka", idempotencyKey, title: `Obrazki dla ${name}`, vocabularyFormat: "picture" },
  });
  expect(generated.status()).toBe(202);
  const { deckId } = await generated.json() as { deckId: string };
  let draftId: string | null = null;
  for (let attempt = 0; attempt < 960 && draftId === null; attempt += 1) {
    const deck = await (await parent.get(`/api/v1/parent/decks/${deckId}`)).json();
    if (deck.generation?.state === "succeeded" && deck.draft) draftId = deck.draft.id;
    else await new Promise(resolve => setTimeout(resolve, 250));
  }
  expect(draftId).not.toBeNull();
  let published = false;
  for (let attempt = 0; attempt < 720 && !published; attempt += 1) {
    const draft = await (await parent.get(`/api/v1/parent/drafts/${draftId}`)).json();
    const pending = draft.assets.some((asset: { role: string; state: string }) =>
      (asset.role === "target_audio" || asset.role === "illustration") && asset.state !== "approved");
    if (!pending) {
      published = (await parent.post(`/api/v1/parent/drafts/${draftId}/publish`, { data: { expectedEditNumber: draft.editNumber } })).status() === 200;
    } else await new Promise(resolve => setTimeout(resolve, 250));
  }
  expect(published).toBe(true);
  expect((await parent.put(`/api/v1/parent/assignments/${child.id}/${deckId}`, { data: { testDate: null } })).status()).toBe(204);
  // Siejemy sukces rozpoznawania słuchowego (streak 1, termin w przyszłości, by
  // nie tworzyć należnego powtórzenia): po własnej prezentacji element od razu
  // kwalifikuje się do wprowadzenia recall (picture_recall), a kolejny wybór
  // etapu to ćwiczenie wymowy (speech/picture_speech) — scheduler-picture-reader
  // „nieczytający z włączonym mikrofonem po opanowaniu słuchania…". Bez tego
  // sesja zużywa budżet na fazę rozpoznawania i nigdy nie dochodzi do mowy.
  const version = await (await parent.get(`/api/v1/parent/decks/${deckId}`)).json() as { published: { id: string } };
  const revisionIds = await query<{ id: string }>(
    "select id from learning_app.item_revisions where deck_version_id = $1 order by position",
    [version.published.id],
  );
  for (const { id: revisionId } of revisionIds) {
    const skills = await query<{ skill_version_id: string }>(
      "select skill_version_id from learning_app.item_revision_skills where item_revision_id = $1 and skill = 'listening'",
      [revisionId],
    );
    for (const { skill_version_id } of skills) {
      await query(
        `insert into learning_app.child_skill_progress
           (child_id, skill_version_id, policy_id, status, independent_success_streak, last_reviewed_at, next_review_at, projection_version)
         select $1, $2, coalesce(c.policy_id, 'learning-v2'), 'practicing', 1, '2026-10-20T00:00:00Z', '2027-01-01T00:00:00Z', 'proj-3'
         from learning_app.child_profiles c where c.id = $1
         on conflict (child_id, skill_version_id, policy_id) do update set status='practicing', independent_success_streak=1,
              last_reviewed_at='2026-10-20T00:00:00Z', next_review_at='2027-01-01T00:00:00Z'`,
        [child.id, skill_version_id],
      );
    }
  }
  await page.goto(`/kids/${child.id}/learn`);
  await expect(page.getByTestId("kid-deck")).toBeVisible();
  await page.getByTestId("kid-mic-settings").click();
  await page.getByTestId("kid-mic-toggle").check();
  await page.getByTestId("kid-mic-settings").click();
  await page.getByTestId("kid-deck").filter({ hasText: `Obrazki dla ${name}` }).click();
}

/** Ręcznie domyka picture_recall (nagranie przez przycisk) i przechodzi dalej. */
async function completeSpokenRecall(page: Page): Promise<void> {
  const record = page.getByTestId("kid-record");
  if (await record.getAttribute("data-ready") !== "true") {
    await record.click({ timeout: 15_000 });
    await expect(record).toHaveAttribute("data-ready", "true");
  }
  await record.click({ timeout: 15_000 });
  await expect(record).toHaveAttribute("data-phase", "recording", { timeout: 10_000 });
  // kontroler odrzuca nagrania krótsze niż 300 ms — czekamy ponad ten strażnik
  await page.waitForTimeout(400);
  await record.click({ timeout: 15_000 });
  await expect(currentFeedback(page)).toBeVisible({ timeout: 30_000 });
  if (await page.getByTestId("kid-feedback-retry").isVisible() && !(await page.getByTestId("kid-technical-next").isVisible())) {
    await page.getByTestId("kid-feedback-retry").click();
    await expect(currentFeedback(page)).toHaveCount(0);
    await record.click({ timeout: 15_000 });
    await expect(record).toHaveAttribute("data-phase", "recording", { timeout: 10_000 });
    await page.waitForTimeout(400);
    await record.click({ timeout: 15_000 });
    await expect(currentFeedback(page)).toBeVisible({ timeout: 30_000 });
  }
  if (await page.getByTestId("kid-technical-next").count()) {
    await page.getByTestId("kid-technical-next").click({ timeout: 15_000 });
  }
  await page.getByTestId("kid-next").click({ timeout: 15_000 });
  await expect(currentFeedback(page)).toHaveCount(0);
}

/**
 * Prowadzi obrazkową sesję z mikrofonem do pierwszego zadania wymowy
 * (picture_speech/speech) — tam auto-próba rozpoczyna nagrywanie sama,
 * bez naciskania przycisku.
 */
async function driveToAutoSpeechTask(page: Page, deckTitle: string): Promise<string> {
  for (let step = 0; step < 30; step += 1) {
    await page.waitForSelector(
      '[data-testid="kid-option"], [data-testid="kid-done"], [data-testid="kid-record"], [data-testid="kid-summary"]',
      { timeout: 30_000 },
    );
    if (await page.getByTestId("kid-summary").isVisible()) break;
    await taskSettled(page);
    const kind = await page.getByTestId("kid-exercise").getAttribute("data-prompt-kind");
    if (kind === "speech" || kind === "picture_speech") {
      const taskId = await page.locator("[data-task-id]").getAttribute("data-task-id");
      expect(taskId).toBeTruthy();
      return taskId!;
    }
    if ((await page.getByTestId("kid-done").count()) > 0) {
      await page.getByTestId("kid-done").click({ timeout: 15_000 });
      continue;
    }
    const taskId = await page.locator("[data-task-id]").getAttribute("data-task-id");
    expect(taskId).toBeTruthy();
    if ((await page.getByTestId("kid-option").count()) > 0) {
      const correct = await correctOptionLabel(taskId!);
      // dopasowanie odporne na warianty widoków: opcje obrazkowe słuchowe mają
      // aria-label = labelPl (przycisk niesie wizual, np. cyfrę), a opcje
      // rozpoznawania obrazkowego sam tekst — porównujemy dokładnie, bez
      // dopasowań podciągiem (kolizje typu „one”/„money”)
      const options = page.getByTestId("kid-option");
      const total = await options.count();
      const index = await page.evaluate(
        ({ label, expected }) => {
          const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="kid-option"]')];
          if (buttons.length !== expected) return -2;
          return buttons.findIndex((button) =>
            (button.getAttribute("aria-label") ?? "").trim() === label ||
            (button.textContent ?? "").trim() === label);
        },
        { label: correct, expected: total },
      );
      expect(index, `brak opcji o etykiecie "${correct}" wśród ${total} opcji`).toBeGreaterThanOrEqual(0);
      await options.nth(index).click({ timeout: 15_000 });
      await expect(currentFeedback(page)).toBeVisible();
      await page.getByTestId("kid-next").click({ timeout: 15_000 });
      await expect(currentFeedback(page)).toHaveCount(0);
    } else if ((await page.getByTestId("kid-record").count()) > 0) {
      // picture_recall — wprowadzenie etapu przypomnienia, ścieżka ręczna
      await completeSpokenRecall(page);
    } else {
      throw new Error(`Nieobsłużony stan zadania przed speech: kind=${kind}`);
    }
  }
  const served = await query<{ exercise_type: string; state: string }>(
    `select st.exercise_type, st.state from learning_app.session_tasks st
       join learning_app.learning_sessions s on s.id = st.session_id
       join learning_app.deck_versions dv on dv.id = s.deck_version_id
       join learning_app.decks d on d.id = dv.deck_id
       where d.title = $1
       order by s.started_at desc, st.ordinal`,
    [deckTitle],
  );
  throw new Error(`Nie napotkano zadania mowy (picture_speech/speech) w budżecie kroków sesji; served=${JSON.stringify(served)}`);
}

/** Ustawia poziom sztucznego mikrofonu (skala rms×4 z browser.ts). */
async function setMicLevel(page: Page, level: number): Promise<void> {
  await page.evaluate((value) => {
    (window as unknown as { __kidMicLevel?: number }).__kidMicLevel = value;
  }, level);
}

async function createLearningTask(page: Page, name: string, recordingMode: "hold" | "toggle" = "hold"): Promise<void> {
  const parent: APIRequestContext = page.request;
  await parent.post("/api/v1/parent/setup", { data: { secret: "1234", setupToken: E2E_SETUP_TOKEN } });
  expect((await parent.post("/api/v1/parent/login", { data: { secret: "1234" } })).status()).toBe(200);
  const child = await (await parent.post("/api/v1/parent/children", { data: { displayName: name, avatarKey: "fox" } })).json() as { id: string };
  if (recordingMode === "toggle") {
    expect((await parent.patch(`/api/v1/parent/children/${child.id}`, { data: { recordingMode } })).status()).toBe(200);
  }
  const idempotencyKey = `speech-ux-${randomUUID()}`;
  const generated = await parent.post("/api/v1/parent/decks/generate", {
    data: { prompt: "angielskie dni tygodnia dla początkującego dziecka", idempotencyKey, title: `Dni dla ${name}` },
  });
  expect(generated.status()).toBe(202);
  const { deckId } = await generated.json() as { deckId: string };
  let draftId: string | null = null;
  for (let attempt = 0; attempt < 960 && draftId === null; attempt += 1) {
    const deck = await (await parent.get(`/api/v1/parent/decks/${deckId}`)).json();
    if (deck.generation?.state === "succeeded" && deck.draft) draftId = deck.draft.id;
    else await new Promise(resolve => setTimeout(resolve, 250));
  }
  expect(draftId).not.toBeNull();
  let publishedVersionId: string | null = null;
  for (let attempt = 0; attempt < 720 && publishedVersionId === null; attempt += 1) {
    const draft = await (await parent.get(`/api/v1/parent/drafts/${draftId}`)).json();
    const pending = draft.assets.some((asset: { role: string; state: string }) => asset.role === "target_audio" && asset.state !== "approved");
    if (!pending) {
      const result = await parent.post(`/api/v1/parent/drafts/${draftId}/publish`, { data: { expectedEditNumber: draft.editNumber } });
      if (result.status() === 200) {
        const updated = await (await parent.get(`/api/v1/parent/decks/${deckId}`)).json();
        publishedVersionId = updated.published.id;
      }
    } else await new Promise(resolve => setTimeout(resolve, 250));
  }
  expect(publishedVersionId).not.toBeNull();
  expect((await parent.put(`/api/v1/parent/assignments/${child.id}/${deckId}`, { data: { testDate: null } })).status()).toBe(204);
  const revisions = await query<{ id: string }>(
    "select id from learning_app.item_revisions where deck_version_id = $1 order by position offset 0 limit 1",
    [publishedVersionId],
  );
  const skills = await query<{ skill_version_id: string }>(
    "select skill_version_id from learning_app.item_revision_skills where item_revision_id = $1 and skill = 'recall'",
    [revisions[0]!.id],
  );
  for (const { skill_version_id } of skills) {
    await query(
      `insert into learning_app.child_skill_progress
         (child_id, skill_version_id, policy_id, status, independent_success_streak, next_review_at, projection_version)
       select $1, $2, coalesce(c.policy_id, 'learning-v2'), 'needs_confirmation', 3, '2026-10-01T00:00:00Z', 'proj-3'
       from learning_app.child_profiles c where c.id = $1
       on conflict (child_id, skill_version_id, policy_id) do update set status='needs_confirmation', independent_success_streak=3, next_review_at='2026-10-01T00:00:00Z'`,
      [child.id, skill_version_id],
    );
  }
  await page.goto(`/kids/${child.id}/learn`);
  await expect(page.getByTestId("kid-deck")).toBeVisible();
  await page.getByTestId("kid-mic-settings").click();
  await page.getByTestId("kid-mic-toggle").check();
  await page.getByTestId("kid-mic-settings").click();
  await page.getByTestId("kid-deck").filter({ hasText: `Dni dla ${name}` }).click();
  await expect(page.getByTestId("kid-input")).toBeVisible();
}

async function installFakeMicrophone(page: Page, deny = false): Promise<void> {
  await page.addInitScript((shouldDeny) => {
    // WR-02: sterowalny stan uprawnienia mikrofonu (Permissions API) —
    // domyślnie "granted", żeby auto-próba działała bez promptu; test ustawia
    // window.__kidMicPermission przed wejściem w zadanie mowy
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: {
        query: async () => ({
          state: ((window as unknown as { __kidMicPermission?: string }).__kidMicPermission ?? "granted"),
        }),
      },
    });
    (window as unknown as { __microphoneTrackStops?: number }).__microphoneTrackStops = 0;
    const track = {
      kind: "audio",
      stop: () => {
        const state = window as unknown as { __microphoneTrackStops?: number };
        state.__microphoneTrackStops = (state.__microphoneTrackStops ?? 0) + 1;
      },
      addEventListener: () => undefined,
    };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => {
        if (shouldDeny) throw new DOMException("Permission denied", "NotAllowedError");
        return stream;
      } },
    });
    class FakeMediaRecorder {
      static isTypeSupported(type: string): boolean { return type.includes("webm"); }
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      start(): void { this.state = "recording"; }
      stop(): void {
        this.state = "inactive";
        const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x18, 0x53, 0x80, 0x67, 0x8c, 0x15, 0x49, 0xa9, 0x66, 0x87, 0x44, 0x89, 0x84, 0x44, 0x7a, 0x00, 0x00]);
        queueMicrotask(() => {
          this.ondataavailable?.({ data: new Blob([webm]) });
          this.onstop?.();
        });
      }
    }
    (window as unknown as { MediaRecorder: typeof FakeMediaRecorder }).MediaRecorder = FakeMediaRecorder;
    const decodedBuffer = (length: number, sampleRate: number) => ({
      duration: length / sampleRate, length, sampleRate, numberOfChannels: 1,
      getChannelData: () => new Float32Array(length),
    });
    class FakeAudioContext {
      // PR #109 r2: auto-próba akceptuje wyłącznie stan "running" — fake mikrofonu
      // jest zawsze gotowy do nasłuchu (brak polityki autoplay w teście)
      readonly state = "running";
      async decodeAudioData(): Promise<AudioBuffer> { return decodedBuffer(96_000, 48_000) as unknown as AudioBuffer; }
      // sterowalny analyser: poziom mikrofonu (skala rms×4 z browser.ts)
      // kontroluje test przez window.__kidMicLevel — domyślnie cisza
      createMediaStreamSource() { return { connect: () => undefined }; }
      createAnalyser() {
        return {
          fftSize: 256,
          getFloatTimeDomainData: (samples: Float32Array) => {
            const level = (window as unknown as { __kidMicLevel?: number }).__kidMicLevel ?? 0;
            samples.fill(level / 4);
          },
          disconnect: () => undefined,
        };
      }
      async close(): Promise<void> {}
    }
    class FakeOfflineAudioContext {
      readonly destination = {};
      constructor(readonly channels: number, readonly length: number, readonly sampleRate: number) {}
      createBufferSource() { return { buffer: null as AudioBuffer | null, connect: () => undefined, start: () => undefined }; }
      async startRendering(): Promise<AudioBuffer> { return decodedBuffer(this.length, this.sampleRate) as unknown as AudioBuffer; }
    }
    Object.defineProperty(window, "AudioContext", { configurable: true, value: FakeAudioContext });
    Object.defineProperty(window, "OfflineAudioContext", { configurable: true, value: FakeOfflineAudioContext });
  }, deny);
}

test("hold gesture handles keyboard, capture loss and release outside the button", async ({ page }) => {
  test.slow();
  await installFakeMicrophone(page);
  await createLearningTask(page, `Gest ${randomUUID().slice(0, 6)}`);
  const button = page.getByTestId("kid-record");
  await expect(button).toHaveText(/Włącz mikrofon/);
  await button.click();
  await expect(button).toHaveAttribute("data-ready", "true");

  let releaseMicrophoneStart!: () => void;
  await page.evaluate(() => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    (window as unknown as { __releaseMicrophoneStart?: () => void }).__releaseMicrophoneStart = release;
    const devices = navigator.mediaDevices;
    const original = devices.getUserMedia.bind(devices);
    let delayNext = true;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { ...devices, getUserMedia: async (constraints: MediaStreamConstraints) => {
        if (delayNext) { delayNext = false; await gate; }
        return original(constraints);
      } },
    });
  });
  releaseMicrophoneStart = () => page.evaluate(() => (window as unknown as { __releaseMicrophoneStart?: () => void }).__releaseMicrophoneStart?.());
  await button.focus();
  await page.keyboard.down("Space");
  await expect(button).toHaveAttribute("data-phase", "starting");
  expect(await button.evaluate((element) => (element as HTMLButtonElement).disabled)).toBe(false);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("kid-record");
  await releaseMicrophoneStart();
  await expect(button).toHaveAttribute("data-phase", "recording");
  await page.keyboard.up("Space");
  await expect(button).toHaveAttribute("data-phase", "idle");

  await expect(page.getByTestId("kid-record-mode")).toHaveCount(0);
  await expect(page.getByText("Wolisz nacisnąć raz? Zmień tryb")).toHaveCount(0);

  await button.focus();
  await page.keyboard.down("Space");
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await page.keyboard.up("Space");
  await expect(button).toHaveAttribute("data-phase", "idle");

  await button.focus();
  await page.keyboard.down("Enter");
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await page.keyboard.up("Enter");
  await expect(button).toHaveAttribute("data-phase", "idle");

  await page.setViewportSize({ width: 768, height: 1024 });
  // Surowe eventy myszy nie auto-czekają jak kliknięcia locatora: trafiają w
  // punkt, a nie w element. Po resize layout dosiada się asynchronicznie, więc
  // czekamy, aż boundingBox przestanie się ruszać, zanim oddamy gest.
  const box = await stableBoundingBox(page, button);
  expect(box.width).toBeGreaterThanOrEqual(48);
  expect(box.height).toBeGreaterThanOrEqual(48);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(150);
  await page.mouse.move(8, 8);
  await page.mouse.up();
  await expect(button).toHaveAttribute("data-phase", "idle");

  const touchX = box.x + box.width / 2;
  const touchY = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touchX, y: touchY, id: 2 }] });
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(350);
  const trackStopsBeforeCancel = await page.evaluate(
    () => (window as unknown as { __microphoneTrackStops?: number }).__microphoneTrackStops ?? 0,
  );
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-testid="kid-record"]')!;
    button.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 2, pointerType: "touch" }));
  });
  await expect(button).toHaveAttribute("data-phase", "idle");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __microphoneTrackStops?: number }).__microphoneTrackStops ?? 0))
    .toBeGreaterThan(trackStopsBeforeCancel);
  await cdp.detach();
});

test("tryb toggle z profilu rodzica działa po odświeżeniu i nie pokazuje przełącznika dziecku", async ({ page }) => {
  await installFakeMicrophone(page);
  const name = `Toggle ${randomUUID().slice(0, 6)}`;
  await createLearningTask(page, name, "toggle");
  await expect(page.getByTestId("kid-record-mode")).toHaveCount(0);
  await expect(page.getByText("Wolisz nacisnąć raz? Zmień tryb")).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("kid-deck")).toBeVisible();
  await page.getByTestId("kid-deck").filter({ hasText: `Dni dla ${name}` }).click();
  await expect(page.getByTestId("kid-record")).toBeVisible();
  await expect(page.getByTestId("kid-record-mode")).toHaveCount(0);
  const button = page.getByTestId("kid-record");
  await button.click();
  await expect(button).toHaveAttribute("data-ready", "true");
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(button).toHaveAttribute("data-phase", "recording");
  await button.click();
  await expect(button).toHaveAttribute("data-phase", "idle");
});

test("automat na zadaniu mowy sam nagrywa i sam kończy po wypowiedzi z ciszą", async ({ page }) => {
  test.slow();
  await installFakeMicrophone(page);
  const name = `Auto ${randomUUID().slice(0, 6)}`;
  await openPictureSpeechSession(page, name);
  const taskId = await driveToAutoSpeechTask(page, `Obrazki dla ${name}`);
  const button = page.getByTestId("kid-record");

  // D-01: nagrywanie startuje samo po wyświetleniu zadania — bez kliknięcia
  await expect(button).toHaveAttribute("data-phase", "recording", { timeout: 10_000 });
  await expect(page.getByTestId("kid-recording")).toBeVisible();
  await expect(button).toHaveAttribute("aria-pressed", "true");

  // D-03: mowa powyżej progu, potem cisza — VAD kończy nagrywanie samo
  // (sustain 2 próbki mowy bez grace, potem 12 próbek ciszy; okno 2 s toleruje
  // wolniejszą realną kadencję próbkowania w headless). Domknięcie potwierdzamy
  // kartą wyniku i dokładnie jedną próbą w bazie — przejściowa faza idle trwa
  // krócej niż interwał pollowania atrybutu.
  await setMicLevel(page, 0.2);
  await page.waitForTimeout(2_000);
  await setMicLevel(page, 0);

  // dokładnie jedna próba audio dla zadania (D-03), feedback inline
  await expect(page.getByTestId("kid-speech-feedback")).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await query<{ modality: string }>(
    "select modality from learning_app.attempts where task_id = $1", [taskId],
  )).length, { timeout: 30_000 }).toBe(1);
  const attempts = await query<{ modality: string }>(
    "select modality from learning_app.attempts where task_id = $1", [taskId],
  );
  expect(attempts).toEqual([{ modality: "audio" }]);
});

test("cisza bez wykrytej mowy anuluje automatyczne nagrywanie bez próby", async ({ page }) => {
  test.slow();
  await installFakeMicrophone(page);
  const name = `Cisza ${randomUUID().slice(0, 6)}`;
  await openPictureSpeechSession(page, name);
  const taskId = await driveToAutoSpeechTask(page, `Obrazki dla ${name}`);
  const button = page.getByTestId("kid-record");

  // auto-start bez kliknięcia; poziom pozostaje 0 (cisza) przez cały limit
  await expect(button).toHaveAttribute("data-phase", "recording", { timeout: 10_000 });
  // SPEC §15: limit 15 s w trybie auto anuluje nagrywanie — bez próby, z krótkim
  // komunikatem; przycisk wraca jako fallback do ręcznej próby
  await expect(button).toHaveAttribute("data-phase", "idle", { timeout: 25_000 });
  await expect(page.getByTestId("kid-record-status")).toContainText("Nie usłyszałem słowa");
  await expect(button).toHaveAttribute("aria-pressed", "false");
  expect(await query<{ modality: string }>(
    "select modality from learning_app.attempts where task_id = $1", [taskId],
  )).toHaveLength(0);
});

for (const action of ["click", "Escape", "hold-touch", "hold-silent", "Space", "Enter", "listen", "guidance", "skip"] as const) {
  test(`automatyczne nagranie reaguje na pierwszy ${action}`, async ({ page }) => {
    await installFakeMicrophone(page);
    const fixture = pictureVocabularyFixture();
    const source = fixture.tasks[0];
    if (!source || source.prompt.kind !== "picture_exposure") throw new Error("picture exposure fixture missing");
    fixture.profiles[0]!.recordingMode = action === "click" || action === "Escape" ? "toggle" : "hold";
    fixture.session.microphoneEnabled = true;
    const taskId = "10000000-0000-4000-8000-000000000017";
    fixture.tasks = [{
      ...source, taskId, exerciseType: "speech",
      prompt: { kind: "picture_speech", audioAssetId: "10000000-0000-4000-8000-000000000014", visual: source.prompt.visual },
    }, null];
    fixture.attempts = [{ ...fixture.attempts![0]!, taskId, modality: "audio" }];
    const audioId = "10000000-0000-4000-8000-000000000014";
    fixture.disclosure = { taskId, stepId: "listen", kind: "audio", reveal: null, audioAssetId: audioId };
    fixture.uiAudio = { ready: true, assets: { speech: audioId } };
    if (action === "skip") fixture.attempts = [{ ...fixture.attempts[0]!, modality: "skip" }];
    let submissions = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/tasks\/[^/]+\/attempts$/.test(new URL(request.url()).pathname)) submissions += 1;
    });
    await installKidUiFixture(page, fixture);
    await page.goto("/");
    await page.getByTestId("kid-profile").click();
    await page.getByTestId("kid-deck").first().click();
    const button = page.getByTestId("kid-record");
    await expect(button).toHaveAttribute("data-phase", "recording");
    // Wysłanie audio wymaga wykrytej mowy oraz minimum 300 ms nagrania.
    if (action === "click" || action === "hold-touch") {
      await page.evaluate(() => { (window as unknown as { __kidMicLevel: number }).__kidMicLevel = 0.2; });
    }
    await page.waitForTimeout(400);
    if (action === "click" || action === "hold-touch") {
      if (action === "click") await button.click();
      else await button.tap();
      await expect(page.getByTestId("kid-speech-feedback")).toBeVisible();
      expect(submissions).toBe(1);
    } else if (action === "Space" || action === "Enter") {
      await button.focus();
      await page.keyboard.press(action);
      await expect(button).toHaveAttribute("data-phase", "recording");
      expect(submissions).toBe(0);
      await page.keyboard.press("Escape");
      await expect(button).toHaveAttribute("data-phase", "idle");
    } else if (action === "listen" || action === "guidance") {
      await page.getByTestId(action === "listen" ? "kid-play" : "kid-guidance-play").click();
      await expect(button).toHaveAttribute("data-phase", "idle");
      await page.waitForTimeout(500);
      expect(submissions).toBe(0);
    } else if (action === "skip") {
      await expect(page.getByTestId("kid-skip")).toHaveCount(0);
      await page.keyboard.press("Escape");
      expect(submissions).toBe(0);
    } else {
      if (action === "hold-silent") await button.tap();
      else { await button.focus(); await page.keyboard.press("Escape"); }
      await expect(button).toHaveAttribute("data-phase", "idle");
      await page.waitForTimeout(1_500);
      expect(submissions).toBe(0);
    }
  });
}

test("bez nadanego uprawnienia mikrofonu automat nie startuje — dopiero świadomy przycisk (WR-02)", async ({ page }) => {
  await installFakeMicrophone(page);
  // fixture obrazkowy: pierwsze zadanie sesji to od razu picture_speech, więc
  // brak wcześniejszego użycia mikrofonu — auto-próba musi zapytać o uprawnienie
  const fixture = pictureVocabularyFixture();
  const source = fixture.tasks[0];
  if (!source || source.prompt.kind !== "picture_exposure") throw new Error("picture exposure fixture missing");
  fixture.profiles[0]!.recordingMode = "toggle";
  fixture.session.microphoneEnabled = true;
  fixture.tasks = [{
    ...source,
    taskId: "10000000-0000-4000-8000-000000000017",
    exerciseType: "speech",
    prompt: { kind: "picture_speech", audioAssetId: "10000000-0000-4000-8000-000000000014", visual: source.prompt.visual },
  }, null];
  await installKidUiFixture(page, fixture);
  await page.goto("/");
  // świeża przeglądarka: zgoda na mikrofon jeszcze nie została nadana
  await page.evaluate(() => {
    (window as unknown as { __kidMicPermission?: string }).__kidMicPermission = "prompt";
  });
  await page.getByTestId("kid-profile").click();
  await page.getByTestId("kid-deck").first().click();
  await expect(page.getByTestId("kid-exercise")).toHaveAttribute("data-prompt-kind", "picture_speech");
  const button = page.getByTestId("kid-record");

  // automat nie ruszył sam: faza idle bez kliku, brak wskaźnika nagrywania
  // (żadnego getUserMedia poza gestem użytkownika — WR-02)
  await page.waitForTimeout(1_500);
  await expect(button).toHaveAttribute("data-phase", "idle");
  await expect(page.getByTestId("kid-recording")).toHaveCount(0);

  // pierwsza zgoda należy do świadomego naciśnięcia: przygotowanie mikrofonu…
  await button.click();
  await expect(button).toHaveAttribute("data-ready", "true");
  await expect(button).toHaveAttribute("data-phase", "idle");
  // …kolejne naciśnięcie rozpoczyna nagrywanie na ścieżce ręcznej
  await button.click();
  await expect(button).toHaveAttribute("data-phase", "recording", { timeout: 10_000 });
  await expect(page.getByTestId("kid-recording")).toBeVisible();
  await button.click();
  await expect(button).toHaveAttribute("data-phase", "idle", { timeout: 30_000 });
});

test("microphone denial is available on request and leaves the written learning path available", async ({ page }) => {
  await installFakeMicrophone(page, true);
  await createLearningTask(page, `Bez mikrofonu ${randomUUID().slice(0, 6)}`);
  await page.getByTestId("kid-record").click();
  const microphoneStatus = page.getByTestId("kid-microphone-status");
  await expect(microphoneStatus).toHaveAccessibleName("Mikrofon niedostępny");
  await expect(page.getByTestId("kid-mic-denied")).toBeHidden();
  await microphoneStatus.click();
  await expect(page.getByTestId("kid-mic-denied")).toBeVisible();
  await microphoneStatus.click();
  await expect(page.getByTestId("kid-input")).toBeEnabled();
  await page.getByTestId("kid-input").fill("Monday");
  await expect(page.getByTestId("kid-submit")).toBeEnabled();
});

test("speech feedback stays inline, explains fragments and exposes only the available actions", async ({ page }) => {
  // Geometry is measured at rest: reduced motion skips the dock entrance.
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await createLearningTask(page, `Wynik ${randomUUID().slice(0, 6)}`);
  const taskId = await page.locator("[data-task-id]").getAttribute("data-task-id");
  expect(taskId).toBeTruthy();
  const attemptId = randomUUID();
  let submitCount = 0;
  await page.evaluate(() => {
    class FakeAudio {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly src: string) {}
      play(): Promise<void> { setTimeout(() => this.onended?.(), 0); return Promise.resolve(); }
      pause(): void {}
    }
    (window as unknown as { Audio: typeof FakeAudio }).Audio = FakeAudio;
  });
  await page.route("**/api/v1/kid/tasks/*/attempts", async (route) => {
    submitCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        attemptId,
        taskId,
        state: "completed",
        modality: "audio",
        feedback: {
          kind: "almost",
          heardText: "Thursday ".repeat(10).trim(),
          fragments: [{ text: "Thurs", verdict: "almost" }, { text: "day", verdict: "unknown" }],
          speech: { recognition: "matched", pronunciation: "practice", referenceText: "Thursday" },
          referenceAudioAvailable: true,
        },
        taskState: submitCount === 1 ? "issued" : "answered",
        stepId: "speech-feedback-e2e",
        receivedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }),
    });
  });
  let authorizationCount = 0;
  await page.route("**/api/v1/kid/attempts/*/feedback-audio", async (route) => {
    authorizationCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ attemptId, taskId, stepId: "feedback-audio-e2e", audioAssetId: randomUUID() }),
    });
  });
  await page.route("**/api/v1/media/*", (route) => route.fulfill({ status: 200, contentType: "audio/mpeg", body: Buffer.from([1, 2, 3]) }));

  const input = page.getByTestId("kid-input");
  await input.fill("Thursday");
  const submitFrameBounds = await page.getByTestId("kid-exercise").boundingBox();
  const submitInstructionBounds = await page.getByTestId("kid-instruction").boundingBox();
  const submitMaterialBounds = await page.getByTestId("kid-material").boundingBox();
  const submitScrollY = await page.evaluate(() => window.scrollY);
  const submitSlotBounds = await page.getByTestId("kid-primary-slot").boundingBox();
  const submitBounds = await page.getByTestId("kid-submit").boundingBox();
  await page.getByTestId("kid-submit").click();
  const card = page.getByTestId("kid-speech-feedback");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("kid-target")).toHaveCount(0);
  await expect(card).toContainText("Usłyszałem:");
  await expect(page.getByTestId("kid-reference-text")).toContainText("Thursday");
  const legend = page.getByRole("list", { name: "Legenda wymowy" });
  await expect(legend).toContainText("poćwicz go");
  // The focused heading's outline stays inside the scrolling box that holds it.
  const outlineClipped = await page.locator("#kid-speech-feedback-title").evaluate((heading) => {
    const style = getComputedStyle(heading);
    const reach = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
    let scroller = heading.parentElement;
    while (scroller && !/(auto|scroll|hidden|clip)/.test(getComputedStyle(scroller).overflowY + getComputedStyle(scroller).overflowX)) {
      scroller = scroller.parentElement;
    }
    scroller!.scrollTop = 0;
    const box = heading.getBoundingClientRect();
    const frame = scroller!.getBoundingClientRect();
    const left = frame.left + scroller!.clientLeft;
    const top = frame.top + scroller!.clientTop;
    return {
      top: box.top - reach < top - 0.5,
      left: box.left - reach < left - 0.5,
      right: box.right + reach > left + scroller!.clientWidth + 0.5,
    };
  });
  expect(outlineClipped).toEqual({ top: false, left: false, right: false });
  // The long heard text overflows the card body, which is the scrolling box for
  // the legend (not the outer card); a wheel gesture over it scrolls the body,
  // and the legend then ends inside it, above the dock's action row.
  const scroller = card.locator(".kid-speech-feedback__body");
  expect(await scroller.evaluate((body) => ({
    scrolls: /(auto|scroll)/.test(getComputedStyle(body).overflowY),
    overflows: body.scrollHeight > body.clientHeight + 1,
  })), "card body is the overflowing scroll box").toEqual({ scrolls: true, overflows: true });
  await expect(scroller.locator(".kid-speech-feedback__legend")).toHaveCount(1);
  const startTop = await scroller.evaluate((body) => body.scrollTop);
  const scrollerBox = (await scroller.boundingBox())!;
  await page.mouse.move(scrollerBox.x + scrollerBox.width / 2, scrollerBox.y + scrollerBox.height / 2);
  await page.mouse.wheel(0, 4000);
  await expect.poll(() => scroller.evaluate((body) => body.scrollTop)).toBeGreaterThan(startTop);
  const [legendBox, actionBox] = await Promise.all([legend.boundingBox(), page.getByTestId("kid-feedback-retry").boundingBox()]);
  expect(legendBox!.y, "legend top inside its scroll box").toBeGreaterThanOrEqual(scrollerBox.y - 1);
  expect(legendBox!.y + legendBox!.height, "legend bottom inside its scroll box").toBeLessThanOrEqual(scrollerBox.y + scrollerBox.height + 1);
  expect(legendBox!.y + legendBox!.height, "legend hidden under the action row").toBeLessThanOrEqual(actionBox!.y + 1);
  // Each legend entry carries a sample styled exactly like its fragment in the word.
  const fragmentLook = (locator: Locator) => locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, decoration: style.textDecorationLine, color: style.color };
  });
  for (const verdict of ["almost", "unknown"] as const) {
    const fragment = page.getByTestId("kid-reference-text").locator(`.kid-fragment--${verdict}`);
    const sample = legend.locator(`.kid-speech-feedback__legend--${verdict} .kid-fragment--${verdict}`);
    await expect(sample).toHaveCount(1);
    expect(await fragmentLook(sample), `legend sample for ${verdict}`).toEqual(await fragmentLook(fragment));
  }
  await expect(page.locator("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("kid-speech-feedback-title");
  const retryBounds = await page.getByTestId("kid-feedback-retry").boundingBox();
  const retryFrameBounds = await page.getByTestId("kid-exercise").boundingBox();
  const retryInstructionBounds = await page.getByTestId("kid-instruction").boundingBox();
  const retryMaterialBounds = await page.getByTestId("kid-material").boundingBox();
  const retryScrollY = await page.evaluate(() => window.scrollY);
  const retrySlotBounds = await page.getByTestId("kid-primary-slot").boundingBox();
  expect(submitSlotBounds).not.toBeNull();
  expect(retrySlotBounds).not.toBeNull();
  expect(submitFrameBounds).not.toBeNull();
  expect(retryFrameBounds).not.toBeNull();
  expect(submitInstructionBounds).not.toBeNull();
  expect(retryInstructionBounds).not.toBeNull();
  expect(submitMaterialBounds).not.toBeNull();
  expect(retryMaterialBounds).not.toBeNull();
  expect(Math.abs(retrySlotBounds!.y - submitSlotBounds!.y), "speech moved the primary action slot").toBeLessThanOrEqual(2);
  for (const [name, before, after] of [
    ["frame", submitFrameBounds!, retryFrameBounds!],
    ["instruction", submitInstructionBounds!, retryInstructionBounds!],
    ["material", submitMaterialBounds!, retryMaterialBounds!],
  ] as const) {
    expect(Math.abs(after.y - before.y), `speech moved ${name}`).toBeLessThanOrEqual(2);
    expect(Math.abs(after.height - before.height), `speech changed ${name} height`).toBeLessThanOrEqual(2);
  }
  expect(retryScrollY).toBe(submitScrollY);
  expect(submitBounds).not.toBeNull();
  expect(retryBounds).not.toBeNull();
  const dockBounds = await page.getByTestId("kid-feedback-dock").boundingBox();
  expect(dockBounds).not.toBeNull();
  expect(retryBounds!.y).toBeGreaterThanOrEqual(dockBounds!.y);
  expect(retryBounds!.y + retryBounds!.height).toBeLessThanOrEqual(dockBounds!.y + dockBounds!.height + 1);
  expect(retryBounds!.width).toBeGreaterThanOrEqual(48);
  expect(retryBounds!.height, "speech retry target height").toBeGreaterThanOrEqual(48);
  expect(Math.abs(retryBounds!.x - (dockBounds!.x + 10)), "speech retry x inside dock padding").toBeLessThanOrEqual(2);
  expect(Math.abs(retryBounds!.width - (dockBounds!.width - 20)), "speech retry width fills the dock").toBeLessThanOrEqual(2);
  await expect(page.getByTestId("kid-feedback-dock")).toHaveAttribute("data-dock-kind", "speech");

  await expect(page.getByTestId("kid-technical-next")).toHaveCount(0);
  for (const selector of ["[data-testid='kid-play-reference']"]) {
    const button = page.locator(selector);
    const ratio = await button.evaluate((element) => {
      const luminance = (value: string) => {
        const [red, green, blue] = value.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
      };
      const style = getComputedStyle(element);
      const [foreground, background] = [luminance(style.color), luminance(style.backgroundColor)];
      return (Math.max(foreground!, background!) + 0.05) / (Math.min(foreground!, background!) + 0.05);
    });
    expect(ratio, selector).toBeGreaterThanOrEqual(4.5);
  }

  await page.getByTestId("kid-play-reference").click();
  await expect.poll(() => authorizationCount).toBe(1);
  await page.getByTestId("kid-feedback-retry").click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("kid-record")).toHaveAttribute("data-phase", "idle");
  await input.fill("Thursday");
  await page.getByTestId("kid-submit").click();
  await expect(card).toBeVisible();
  await expect(page.getByTestId("kid-feedback-retry")).toHaveCount(0);
  await expect(page.getByTestId("kid-technical-next")).toHaveCount(0);
  await expect(page.getByTestId("kid-next")).toBeVisible();
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByTestId("kid-next")).toBeInViewport();
  }
});
