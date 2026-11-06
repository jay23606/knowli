import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readTestRunConfig } from "../test-run-config";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { endSessionFromHeader } from "./helpers/kid-session";
import { createDatabase } from "@learning/server";
import { TaskDtoSchema } from "@learning/contracts";
import { expectReadableOnDarkContainer } from "./helpers/contrast";
import { E2E_SETUP_TOKEN } from "./helpers/parent-session";

// Kid-flow obejmuje krótkotrwałe testowe audio; nie zapisujemy trace, HAR ani video.
test.use({ trace: "off" });

/**
 * Pełny przepływ dziecka (zadanie 9): ekran profilu/zestawu/nauki/końca,
 * ćwiczenia exposure → rozpoznawanie → Recall z pisownią, przyciski
 * „Nie pamiętam — pokaż” i „Pomiń”, manifest PWA oraz regresje RF5:
 * odmowa mikrofonu, utrata sieci bez fałszywego sukcesu, opuszczenie
 * widoku zatrzymuje nagrywanie.
 */

type NavigatorWithServiceWorker = Navigator & {
  serviceWorker: { getRegistrations(): Promise<unknown[]> };
};

type WorldPool = ReturnType<typeof createDatabase>["pool"];
let worldPool: WorldPool | null = null;

async function pool(): Promise<WorldPool> {
  if (worldPool === null) {
    const world = JSON.parse(
      await readFile(join(process.cwd(), readTestRunConfig(process.env).worldFile), "utf8"),
    ) as { databaseUrl: string };
    worldPool = createDatabase(world.databaseUrl).pool;
  }
  return worldPool;
}

test.afterAll(async () => {
  await worldPool?.end();
});

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await (await pool()).query(sql, params);
  return result.rows as T[];
}

async function parentSession(page: Page): Promise<APIRequestContext> {
  const request = page.request;
  await request.post("/api/v1/parent/setup", { data: { secret: "1234", setupToken: E2E_SETUP_TOKEN } });
  const login = await request.post("/api/v1/parent/login", { data: { secret: "1234" } });
  expect(login.status()).toBe(200);
  return request;
}

async function createChild(
  parent: APIRequestContext,
  displayName: string,
  avatarKey: string,
  canRead = true,
): Promise<{ id: string; displayName: string }> {
  const uniqueName = `${displayName} ${randomUUID().slice(0, 8)}`;
  const child = await (
    await parent.post("/api/v1/parent/children", { data: { displayName: uniqueName, avatarKey, canRead } })
  ).json();
  expect(child.id).toBeDefined();
  return child;
}

async function configureToggleRecording(parent: APIRequestContext, childId: string): Promise<void> {
  const response = await parent.patch(`/api/v1/parent/children/${childId}`, {
    data: { recordingMode: "toggle" },
  });
  expect(response.status()).toBe(200);
}

async function createAssignedDeck(
  parent: APIRequestContext,
  childId: string,
  title: string,
  idempotencyKey: string,
  vocabularyFormat: "standard" | "picture" = "standard",
): Promise<{ deckId: string; publishedVersionId: string }> {
  const generate = await parent.post("/api/v1/parent/decks/generate", {
    data: { prompt: "angielskie dni tygodnia dla początkującego dziecka", idempotencyKey, title, vocabularyFormat },
  });
  expect(generate.status()).toBe(202);
  const { deckId } = await generate.json();

  let draftId: string | null = null;
  for (let attempt = 0; attempt < 960 && draftId === null; attempt++) {
    const deck = await (await parent.get(`/api/v1/parent/decks/${deckId}`)).json();
    if (deck.generation?.state === "succeeded" && deck.draft) {
      draftId = deck.draft.id;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  expect(draftId).not.toBeNull();

  let published = false;
  let editNumber = 0;
  for (let attempt = 0; attempt < 720 && !published; attempt++) {
    const draft = await (await parent.get(`/api/v1/parent/drafts/${draftId}`)).json();
    editNumber = draft.editNumber;
    const audioPending = draft.assets.some(
      (asset: { role: string; state: string }) =>
        (asset.role === "target_audio" || (vocabularyFormat === "picture" && asset.role === "illustration")) &&
        asset.state !== "approved",
    );
    if (!audioPending) {
      const result = await parent.post(`/api/v1/parent/drafts/${draftId}/publish`, {
        data: { expectedEditNumber: editNumber },
      });
      published = result.status() === 200;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  expect(published).toBe(true);

  const assign = await parent.put(`/api/v1/parent/assignments/${childId}/${deckId}`, {
    data: { testDate: null },
  });
  expect(assign.status()).toBe(204);

  const deck = await (await parent.get(`/api/v1/parent/decks/${deckId}`)).json();
  return { deckId, publishedVersionId: deck.published.id };
}

interface TaskRow {
  answer_key: { target: string; correctOptionId?: string };
  public_prompt: { options?: { id: string; text?: string; labelPl?: string }[] };
}

async function taskRow(taskId: string): Promise<TaskRow> {
  return (
    await query<TaskRow>(`select answer_key, public_prompt from learning_app.session_tasks where id = $1`, [taskId])
  )[0]!;
}

async function answerTarget(taskId: string): Promise<string> {
  return (await taskRow(taskId)).answer_key.target;
}

async function correctOptionText(taskId: string): Promise<string> {
  const row = await taskRow(taskId);
  const correct = row.public_prompt.options!.find((o) => o.id === row.answer_key.correctOptionId);
  return correct!.text ?? correct!.labelPl!;
}

/** Fixture: należne sprawdzenie danej umiejętności dla elementu o indeksie. */
async function seedDue(childId: string, versionId: string, itemIndex: number, skill: string): Promise<void> {
  const revision = (
    await query<{ id: string }>(
      `select id from learning_app.item_revisions
        where deck_version_id = $1 order by position offset $2 limit 1`,
      [versionId, itemIndex],
    )
  )[0]!;
  const skillVersions = await query<{ skill_version_id: string }>(
    `select skill_version_id from learning_app.item_revision_skills
      where item_revision_id = $1 and skill = $2`,
    [revision.id, skill],
  );
  for (const { skill_version_id } of skillVersions) {
    await query(
      `insert into learning_app.child_skill_progress
         (child_id, skill_version_id, policy_id, status, independent_success_streak, last_reviewed_at, next_review_at, projection_version)
       select $1, $2, coalesce(c.policy_id, 'learning-v2'), 'needs_confirmation', 3,
              '2026-09-30T00:00:00Z', '2026-10-01T00:00:00Z', 'proj-3'
       from learning_app.child_profiles c where c.id = $1
       on conflict (child_id, skill_version_id, policy_id) do update
         set status = 'needs_confirmation', independent_success_streak = 3,
             last_reviewed_at = '2026-09-30T00:00:00Z',
             next_review_at = '2026-10-01T00:00:00Z'`,
      [childId, skill_version_id],
    );
  }
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


/**
 * Wejście w naukę: świat współdzieli bazę między testami, więc przy wielu
 * profilach wybieramy własny; przy pojedynczym ekran wyboru nie istnieje.
 * Czekamy na hydratację — zaraz po goto widać jeszcze ekran ładowania.
 */
async function openLearn(page: Page, childName: string): Promise<void> {
  await page.goto("/");
  await page.waitForSelector('[data-testid="kid-profile"], [data-testid="kid-deck"]', { timeout: 30_000 });
  if ((await page.getByTestId("kid-profile").count()) > 0) {
    await page.getByTestId("kid-profile").filter({ hasText: childName }).first().click();
  }
}

async function currentTaskId(page: Page): Promise<string> {
  const id = await page.locator("[data-task-id]").getAttribute("data-task-id");
  expect(id).not.toBeNull();
  return id!;
}

function currentFeedback(page: Page) {
  return page.getByTestId("kid-feedback").or(page.getByTestId("kid-speech-feedback"));
}

async function startFakeRecording(page: Page): Promise<void> {
  await expect(page.getByTestId("kid-record-mode")).toHaveCount(0);
  const record = page.getByTestId("kid-record");
  const recorderStarts = () => page.evaluate(() => Number(sessionStorage.getItem("test.recorderStarts") ?? "0"));
  const startsBefore = await recorderStarts();
  if ((await record.getAttribute("data-phase")) !== "recording") {
    // Najpierw krótkie okno na auto-start (speech/picture_speech): nagrywanie
    // rusza samo po wyświetleniu zadania. Klik inicjujący gotowość zostaje
    // tylko jako fallback ścieżki ręcznej (WrittenView, recall/pisownia) oraz
    // po wyczerpanej autopróbie (latch zadania w kontrolerze).
    const promptKind = await page.getByTestId("kid-exercise").getAttribute("data-prompt-kind");
    const autoPossible = promptKind === "speech" || promptKind === "picture_speech";
    let started = false;
    if (autoPossible) {
      // PR #109 runda 4: regresja auto-startu nie może cicho degradować do
      // ścieżki ręcznej — fallback zostaje tylko, gdy test JAWNIE ustawił brak
      // zgody (window.__kidMicPermission = "prompt"/"denied"); przy domyślnym
      // "granted" timeout polla jest twardą porażką testu
      const permission = await page.evaluate(() =>
        (window as unknown as { __kidMicPermission?: string }).__kidMicPermission ?? "granted");
      const autoExpected = permission !== "prompt" && permission !== "denied";
      try {
        await expect.poll(recorderStarts, { timeout: 3_000 }).toBeGreaterThan(startsBefore);
        await expect(record).toHaveAttribute("data-phase", "recording");
        started = true;
      } catch (error) {
        if (autoExpected) throw error;
        started = false;
      }
    }
    if (!started) {
      if (await record.getAttribute("data-ready") !== "true") {
        await record.click();
        await expect(record).toHaveAttribute("data-ready", "true");
      }
      await record.click();
      await expect(record).toHaveAttribute("aria-pressed", "true");
      await expect.poll(recorderStarts).toBeGreaterThan(startsBefore);
    }
  }
  // The controller rejects captures shorter than 300 ms; wait beyond that guard
  // after the recorder actually starts, rather than sleeping from the click.
  await expect.poll(() => page.evaluate(() =>
    Date.now() - Number(sessionStorage.getItem("test.recorderStartedAt") ?? "0"),
  )).toBeGreaterThanOrEqual(350);
}

async function stopFakeRecording(page: Page): Promise<void> {
  const stopsBefore = await page.evaluate(() => Number(sessionStorage.getItem("test.recorderStops") ?? "0"));
  const tracksBefore = await page.evaluate(() => Number(sessionStorage.getItem("test.trackStops") ?? "0"));
  await page.getByTestId("kid-record").click();
  await expect.poll(() => page.evaluate(() => Number(sessionStorage.getItem("test.recorderStops") ?? "0"))).toBeGreaterThan(stopsBefore);
  await expect.poll(() => page.evaluate(() => Number(sessionStorage.getItem("test.trackStops") ?? "0"))).toBeGreaterThan(tracksBefore);
}

/**
 * Czeka, aż przejście między zadaniami się zakończy: podczas zmiany kroku
 * stara karta zostaje z nieaktywnymi przyciskami, więc czytanie stanu w tym
 * momencie złapałoby poprzednie zadanie. Trwające nagrywanie (także-auto)
 * traktujemy jako stan stabilny — pomocnicze „Pomiń”/odsłuch są wtedy celowo
 * wyłączone i domknie je sterujący test.
 */
async function settled(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        if (document.querySelector('[data-testid="kid-recording"]') !== null) return true;
        const disabled = [...document.querySelectorAll("[data-testid][disabled]")];
        const input = document.querySelector('[data-testid="kid-input"]');
        if (input !== null && !input.hasAttribute("disabled")) {
          // aktywne pole pisemne: „Sprawdź” czeka tylko na wpisaną treść
          return disabled.every((el) => el.getAttribute("data-testid") === "kid-submit");
        }
        return disabled.length === 0;
      },
      undefined,
      { timeout: 20_000 },
    );
  } catch (error) {
    const taskId = await page.locator("[data-task-id]").getAttribute("data-task-id").catch(() => null);
    const type = taskId ? (await query<{ exercise_type: string }>(
      "select exercise_type from learning_app.session_tasks where id = $1", [taskId],
    ))[0]?.exercise_type ?? "nieznany" : "brak bieżącego zadania";
    throw new Error(`Timeout przejścia zadania: taskId=${taskId ?? "brak"}, exerciseType=${type}`, { cause: error });
  }
}

/** Prowadzi UI przez prezentacje i zadania z wyborem do momentu spełnienia warunku. */
async function driveUntil(page: Page, stop: () => Promise<boolean>): Promise<void> {
  for (let step = 0; step < 100; step++) {
    await page.waitForSelector('[data-task-id], [data-testid="kid-summary"]', { timeout: 30_000 });
    await settled(page);
    if (await stop()) return;
    if (await page.getByTestId("kid-summary").isVisible()) return;
    if (await page.getByTestId("kid-done").isVisible()) {
      await page.getByTestId("kid-done").click();
      continue;
    }
    if ((await page.getByTestId("kid-option").count()) > 0) {
      const taskId = await currentTaskId(page);
      const correct = await correctOptionText(taskId);
      await page
        .getByTestId("kid-option")
        .filter({ hasText: new RegExp(`^\\s*${escapeRegex(correct)}\\s*$`) })
        .first()
        .click();
      await expect(currentFeedback(page)).toBeVisible();
      await page.getByTestId("kid-next").click();
      continue;
    }
    if ((await page.getByTestId("kid-input").count()) > 0) {
      const taskId = await currentTaskId(page);
      await page.getByTestId("kid-input").fill(await answerTarget(taskId));
      await page.getByTestId("kid-submit").click();
      await expect(currentFeedback(page)).toBeVisible();
      await page.getByTestId("kid-next").click();
      continue;
    }
    if ((await page.getByTestId("kid-record").count()) > 0) {
      // ćwiczenie wymowy: nagranie i zatrzymanie domyka zadanie
      await startFakeRecording(page);
      await expect(page.getByTestId("kid-recording")).toBeVisible();
      await stopFakeRecording(page);
      await expect(page.getByTestId("kid-fragment").first()).toHaveClass(/kid-fragment--good/);
      await expect(currentFeedback(page)).toBeVisible();
      if (await page.getByTestId("kid-technical-next").count()) {
        await page.getByTestId("kid-technical-next").click();
        await page.getByTestId("kid-next").click();
      } else {
        await page.getByTestId("kid-next").click();
      }
      continue;
    }
    if ((await page.getByTestId("kid-input").count()) === 0 && (await page.getByTestId("kid-technical-next").count()) > 0) {
      // wymowa bez mikrofonu — pominięcie bez oceny
      await page.getByTestId("kid-technical-next").click();
      await expect(currentFeedback(page)).toBeVisible();
      await page.getByTestId("kid-next").click();
      continue;
    }
    throw new Error(`Nieobsłużony stabilny stan zadania: taskId=${await currentTaskId(page)}`);
  }
  throw new Error("driveUntil: przekroczono liczbę kroków");
}

test("wybór profilu prowadzi sesję do obiecanego końca", async ({ page }) => {
  test.slow();
  // sesja z mikrofonem wprowadza też ćwiczenie wymowy (SPEC §13) — fake media
  // podmienia tylko getUserMedia/MediaRecorder, odpowiedź przechodzi prawdziwy kod
  await injectFakeMediaPlatform(page);
  const parent = await parentSession(page);
  const child = await createChild(parent, "Ola", "fox");
  await configureToggleRecording(parent, child.id);
  const deckTitle = `Dni tygodnia ${randomUUID().slice(0, 8)}`;
  await createAssignedDeck(parent, child.id, deckTitle, `kid-flow-1-${randomUUID()}`);

  // manifest PWA: polska nazwa, start z ekranu nauki, ikony; brak service
  // workera — aplikacja nie obiecuje nauki offline ani nie cache'uje API
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  expect(manifest.name).toBe("Umiem!");
  expect(manifest.lang).toBe("pl-PL");
  expect(manifest.start_url).toBe("/");
  const icon192 = manifest.icons.find((icon: { sizes: string }) => icon.sizes.includes("192"));
  expect(icon192).toBeDefined();
  expect((await page.request.get(icon192.src)).status()).toBe(200);
  await page.goto("/");
  expect(
    await page.evaluate(() =>
      (navigator as unknown as NavigatorWithServiceWorker).serviceWorker
        .getRegistrations()
        .then((registrations) => registrations.length),
    ),
  ).toBe(0);

  // Wybieramy własny profil po unikalnym imieniu; nie usuwamy profili innych testów.
  await expect(page.getByTestId("kid-profile").filter({ hasText: child.displayName })).toBeVisible();
  await expect(page.getByTestId("kid-parent-link")).toBeVisible();
  await page.getByTestId("kid-profile").filter({ hasText: child.displayName }).click();
  await expect(page.getByTestId("kid-deck").first()).toBeVisible();
  await page.getByTestId("kid-mic-settings").click();
  await page.getByTestId("kid-mic-toggle").check();
  await page.getByTestId("kid-mic-settings").click();
  const taskResponses = new Map<string, number>();
  page.on("response", (response) => {
    if (response.request().method() !== "POST" || !/\/api\/v1\/kid\/sessions\/[^/]+\/next$/.test(new URL(response.url()).pathname)) return;
    void response.json().then((json: unknown) => {
      const task = TaskDtoSchema.safeParse(json);
      if (task.success) taskResponses.set(task.data.taskId, task.data.remainingAssessed);
    }).catch(() => undefined);
  });
  await page.getByTestId("kid-deck").filter({ hasText: deckTitle }).click();
  await page.waitForSelector('[data-task-id], [data-testid="kid-summary"]', { timeout: 30_000 });
  let sawRemaining = false;
  let sawIllustration = false;
  let promisedSessionId: string | null = null;
  let promisedRemaining = 0;
  let assessedAtPromise = 0;
  for (let step = 0; step < 90; step++) {
    await page.waitForSelector('[data-task-id], [data-testid="kid-summary"]', { timeout: 30_000 });
    await settled(page);
    if (await page.getByTestId("kid-summary").isVisible()) break;
    if (await page.getByTestId("kid-remaining").isVisible()) {
      sawRemaining = true;
      const taskId = await currentTaskId(page);
      await expect.poll(() => taskResponses.get(taskId) ?? 0).toBeGreaterThan(0);
      const taskRemaining = taskResponses.get(taskId)!;
      const shownText = await page.getByTestId("kid-remaining").innerText();
      const shownRemaining = Number(shownText.match(/\d+/)?.[0]);
      expect(shownRemaining).toBe(taskRemaining);
      promisedRemaining = taskRemaining;
      const session = (await query<{ session_id: string }>("select session_id from learning_app.session_tasks where id = $1", [taskId]))[0]!;
      promisedSessionId = session.session_id;
      const assessed = await query<{ count: string }>(
        `select count(distinct st.id)::text as count from learning_app.session_tasks st
         join learning_app.attempts a on a.task_id = st.id
         join learning_app.assessments asm on asm.attempt_id = a.id
         where st.session_id = $1`, [promisedSessionId],
      );
      assessedAtPromise = Number(assessed[0]!.count);
    }
    if (await page.getByTestId("kid-done").isVisible()) {
      // prezentacja niesie zatwierdzoną ilustrację (SPEC §12.1); karty bez
      // obrazu (sobota/niedziela w fake providerze) pokazują placeholder
      if (await page.getByTestId("kid-illustration").isVisible()) {
        sawIllustration = true;
      }
      // karta ze zdaniem przykładowym ma przycisk jego odsłuchu (SPEC §22)
      if (await page.getByTestId("kid-play-example").isVisible()) {
        await page.getByTestId("kid-play-example").click();
      }
      await page.getByTestId("kid-done").click();
      continue;
    }
    const taskId = await currentTaskId(page);
    if ((await page.getByTestId("kid-option").count()) > 0) {
      const correct = await correctOptionText(taskId);
      try {
        await page
          .getByTestId("kid-option")
          .filter({ hasText: new RegExp(`^\\s*${escapeRegex(correct)}\\s*$`) })
          .first()
          .click({ timeout: 15_000 });
      } catch {
        console.error(
          "WEDGE-DIAG",
          JSON.stringify({
            taskId,
            correct,
            dom: await page.evaluate(() =>
              [...document.querySelectorAll("[data-testid]")].map((el) => ({
                id: el.getAttribute("data-testid"),
                disabled: el.hasAttribute("disabled"),
                text: el.textContent?.slice(0, 40),
              })),
            ),
            body: await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 200)),
          }),
        );
        throw new Error("wedge on option click");
      }
    } else if ((await page.getByTestId("kid-input").count()) > 0) {
      await page.getByTestId("kid-input").fill(await answerTarget(taskId));
      await page.getByTestId("kid-submit").click();
    } else if ((await page.getByTestId("kid-record").count()) > 0) {
      // ćwiczenie wymowy po sukcesie rozpoznawania (SPEC §12.6, §13): fake
      // mikrofon nagrywa 2 s webm, odpowiedź ustna domyka zadanie
      await startFakeRecording(page);
      await expect(page.getByTestId("kid-recording")).toBeVisible();
      await stopFakeRecording(page);
    } else {
      // wymowa bez działającego mikrofonu — świadome pominięcie bez oceny
      await page.getByTestId("kid-technical-next").click();
    }
    await expect(currentFeedback(page)).toBeVisible();
    if (await page.getByTestId("kid-technical-next").count()) {
      await page.getByTestId("kid-technical-next").click();
      await page.getByTestId("kid-next").click();
    } else {
      await page.getByTestId("kid-next").click();
    }
  }
  await expect(page.getByTestId("kid-summary")).toBeVisible();
  expect(sawRemaining).toBe(true);
  expect(sawIllustration).toBe(true);
  // obiecany koniec jest też końcem po stronie serwera
  expect(promisedSessionId).not.toBeNull();
  const sessions = await query<{ state: string; task_budget: number }>(
    `select state, task_budget from learning_app.learning_sessions where id = $1`, [promisedSessionId],
  );
  expect(sessions).toEqual([expect.objectContaining({ state: "completed" })]);
  const assessed = await query<{ count: string }>(
    `select count(distinct st.id)::text as count from learning_app.session_tasks st
     join learning_app.attempts a on a.task_id = st.id
     join learning_app.assessments asm on asm.attempt_id = a.id
     where st.session_id = $1`, [promisedSessionId],
  );
  const finalAssessedCount = Number(assessed[0]!.count);
  expect(finalAssessedCount).toBeLessThanOrEqual(sessions[0]!.task_budget);
  expect(finalAssessedCount - assessedAtPromise).toBe(promisedRemaining);
});

test("popup wyniku mieści się w ekranie telefonu bez przewijania", async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 360, height: 640 });
  const parent = await parentSession(page);
  const child = await createChild(parent, "Popup", "fox");
  const { publishedVersionId } = await createAssignedDeck(parent, child.id, "Popup", `popup-${randomUUID()}`);
  await seedDue(child.id, publishedVersionId, 0, "recall");
  await openLearn(page, child.displayName);
  await page.getByTestId("kid-deck").first().click();
  await expect(page.getByTestId("kid-input")).toBeVisible();
  const taskId = await currentTaskId(page);
  await page.getByTestId("kid-input").fill("wrong");
  await page.getByTestId("kid-submit").click();

  const feedback = page.getByTestId("kid-feedback");
  const next = page.getByTestId("kid-next");
  async function assertVisibleWithoutScrolling() {
    await expect(feedback).toBeVisible();
    await expect.poll(async () => {
      const box = await next.boundingBox();
      const visibleHeight = await page.evaluate(() => window.visualViewport?.height ?? window.innerHeight);
      return box ? Math.round(box.y + box.height - visibleHeight) : 999;
    }, { message: "feedback action settles inside the visual viewport" }).toBeLessThanOrEqual(0);
    // toBeVisible() alone allows elements below the viewport. Bounding boxes
    // are read before click(), which otherwise scrolls automatically.
    for (const locator of [feedback, next]) {
      const box = await locator.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      const visibleHeight = await page.evaluate(() => window.visualViewport?.height ?? window.innerHeight);
      expect(box!.y + box!.height).toBeLessThanOrEqual(visibleHeight);
    }
    await expect(feedback).not.toHaveJSProperty("open", true);
    await expect(page.locator("#kid-feedback-title")).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  }

  await assertVisibleWithoutScrolling();
  await expect(feedback).toHaveClass(/kid-feedback--retry/);
  await page.keyboard.press("Escape");
  await expect(feedback).toBeVisible();
  await next.click();
  await expect(feedback).toHaveCount(0);
  await expect(page.getByTestId("kid-input")).toBeEnabled();
  expect(await currentTaskId(page)).toBe(taskId);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");

  // Bramka /next stoi PRZED poprawną odpowiedzią: po niej kontroler pobiera
  // następne zadanie w tle już przy feedbacku (prefetch), więc przechwycenie
  // instalowane dopiero przed „Dalej” nie zobaczyłoby żadnego żądania.
  let releaseRequest!: () => void;
  const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
  await page.route("**/api/v1/kid/sessions/*/next", async (route) => {
    await requestGate;
    await route.abort();
  });
  await page.getByTestId("kid-input").fill(await answerTarget(taskId));
  await page.getByTestId("kid-input").press("Enter");
  await expect(feedback).toContainText("Świetnie");
  for (const viewport of [{ width: 360, height: 640 }, { width: 390, height: 844 },
    { width: 768, height: 1024 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    await assertVisibleWithoutScrolling();
  }

  // Stress only the rendered content: a long transcript must scroll inside
  // the popup, while the continuation action stays in the viewport.
  await page.setViewportSize({ width: 360, height: 640 });
  await page.locator(".kid-feedback-content").evaluate((element) => {
    const transcript = document.createElement("p");
    transcript.textContent = "Długi tekst odpowiedzi. ".repeat(150);
    element.append(transcript);
  });
  await assertVisibleWithoutScrolling();
  await page.screenshot({ path: test.info().outputPath("feedback-mobile-long.png") });
  expect(await page.locator(".kid-feedback-content").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await page.mouse.move(5, 5);
  await page.mouse.wheel(0, 600);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  await page.keyboard.press("Tab");
  // Chromium may move Tab to browser chrome after the sole modal control.
  // Feedback is not modal: the child can still reach the session header.
  await page.getByTestId("kid-end").focus();
  await expect(page.getByTestId("kid-end")).toBeFocused();
  await next.focus();
  await expect(next).toBeFocused();

  // An unavailable next step must expose the existing recovery action,
  // rather than leave an inert error panel behind the modal. Bramka stoi
  // od poprawnej odpowiedzi (wyżej); prefetch wisi na niej, a po zwolnieniu
  // klik „Dalej” ponawia pobranie i też trafia w abort.
  await next.click();
  await expect(next).toBeDisabled();
  releaseRequest();
  await expect(page.getByTestId("kid-offline")).toBeVisible();
  await expect(page.getByTestId('kid-offline')).toHaveClass(/kid-card/);
  await expect(page.getByTestId('kid-retry')).toHaveClass(/kid-action/);
  await expectReadableOnDarkContainer(page.getByTestId("kid-offline"));
  await expect(feedback).toHaveCount(0);
  await page.unroute("**/api/v1/kid/sessions/*/next");
  await page.getByTestId("kid-retry").click();
  await expect(page.locator("[data-task-id]")).toBeVisible();
  await expect(page.getByTestId("kid-feedback")).toHaveCount(0);
});

test("odpowiedź obrazkowa pokazuje oba wyniki i czyści je po ponowieniu", async ({ page }) => {
  const parent = await parentSession(page);
  const child = await createChild(parent, "Maja", "fox");
  await createAssignedDeck(parent, child.id, "Wybór obrazkowy", `choice-popup-${randomUUID()}`);
  await openLearn(page, child.displayName);
  await page.getByTestId("kid-deck").first().click();
  await driveUntil(page, async () => (await page.getByTestId("kid-option").count()) > 0);
  await page.setViewportSize({ width: 360, height: 640 });
  const taskId = await currentTaskId(page);
  const options = page.getByTestId("kid-option");
  const texts = (await options.allTextContents()).map((text) => text.trim());
  const correctText = await correctOptionText(taskId);
  const correctIndex = texts.findIndex((text) => text === correctText);
  const wrongIndex = texts.findIndex((text) => text !== correctText);
  expect(correctIndex).toBeGreaterThanOrEqual(0);
  expect(wrongIndex).toBeGreaterThanOrEqual(0);
  const correct = options.nth(correctIndex);
  const wrong = options.nth(wrongIndex);
  // Awarię nagrania pytania wymuszamy deterministycznie (CodeRabbit):
  // zatwierdzone audio w realnym stackie zwykle gra, więc nie polegamy
  // na przypadkowej awarii — blokujemy media właściwego assetu i ponawiamy
  // odsłuch. Zadanie czytanego wyboru nie ma nagrania: komunikat ma wtedy
  // nie istnieć.
  const audioError = page.getByTestId("kid-task-audio-error");
  const play = page.getByTestId("kid-play");
  if ((await play.count()) > 0) {
    const audioAssetId = ((await taskRow(taskId)).public_prompt as { audioAssetId?: string | null }).audioAssetId ?? null;
    expect(audioAssetId).toBeTruthy();
    await page.route(`**/api/v1/media/${audioAssetId}`, (route) => route.fulfill({ status: 500, contentType: "text/plain", body: "forced audio failure" }));
    await play.click();
    await expect(audioError).toBeVisible();
  } else {
    await expect(audioError).toHaveCount(0);
  }
  await wrong.click();
  const feedback = page.getByTestId("kid-feedback");
  await expect(feedback).toBeVisible();
  await expect(feedback).toHaveClass(/kid-feedback--retry/);
  await expect(wrong).toHaveClass(/kid-option--wrong/);
  await expect(correct).toHaveClass(/kid-option--correct/);
  const bar = await feedback.boundingBox();
  expect(bar).not.toBeNull();
  // Komunikat rozpycha pasek statusu, więc materiał ma mniej wysokości.
  // Opcje pozostają w pełni osiągalne przewijaniem nad paskiem feedbacku
  // (pełny cel dotykowy), a sam komunikat nie może wchodzić na materiał.
  if (await audioError.isVisible()) {
    const noticeBox = await audioError.boundingBox();
    const materialBox = await page.getByTestId("kid-material").boundingBox();
    expect(noticeBox).not.toBeNull();
    expect(materialBox).not.toBeNull();
    expect(noticeBox!.y + noticeBox!.height).toBeLessThanOrEqual(materialBox!.y + 1);
  }
  const handles = await options.elementHandles();
  expect(handles.length).toBeGreaterThanOrEqual(2);
  expect(handles.length).toBeLessThanOrEqual(4);
  for (const option of handles) {
    await option.scrollIntoViewIfNeeded();
    const box = await option.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(bar!.y + 1);
  }
  await page.getByTestId("kid-next").click();
  await expect(feedback).toHaveCount(0);
  for (const option of await options.elementHandles()) expect((await option.getAttribute("class")) ?? "").not.toMatch(/kid-option--/);
  await correct.click();
  await expect(feedback).toContainText("Świetnie");
  await expect(correct).toHaveClass(/kid-option--correct/);
});

test("dwa profile mają osobne sesje", async ({ page }) => {
  test.slow();
  const parent = await parentSession(page);
  const ola = await createChild(parent, "Zosia", "fox");
  const ewa = await createChild(parent, "Ewa", "bear");
  const { deckId } = await createAssignedDeck(parent, ola.id, "Dni tygodnia dla Oli", `kid-flow-2a-${randomUUID()}`);
  const assign = await parent.put(`/api/v1/parent/assignments/${ewa.id}/${deckId}`, { data: { testDate: null } });
  expect(assign.status()).toBe(204);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Kto się dziś uczy?" })).toBeVisible();
  expect(await page.getByTestId("kid-profile").count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId("kid-profile").filter({ hasText: ola.displayName })).toHaveCount(1);
  await expect(page.getByTestId("kid-profile").filter({ hasText: ewa.displayName })).toHaveCount(1);

  // Bezpośredni link rodzica wybiera Zosię i pomija wybór profilu.
  await page.goto(`/kids/${ola.id}/learn`);
  await expect(page.getByTestId("kid-profile")).toHaveCount(0);
  await expect(page.getByTestId("kid-deck").filter({ hasText: "Dni tygodnia dla Oli" })).toHaveCount(1);

  // Zosia: krótka sesja zakończona wcześniej przez dziecko
  await page.getByTestId("kid-deck").first().click();
  await expect(page.locator("[data-task-id]")).toBeVisible();
  await endSessionFromHeader(page);
  await expect(page.getByTestId("kid-summary")).toBeVisible();

  // Ewa: własna, świeża sesja tego samego zestawu
  await page.getByTestId("kid-switch-profile").click();
  await page.getByTestId("kid-profile").filter({ hasText: ewa.displayName }).click();
  await page.getByTestId("kid-deck").first().click();
  await expect(page.locator("[data-task-id]")).toBeVisible();

  const olaSessions = await query<{ state: string }>(
    `select state from learning_app.learning_sessions where child_id = $1 order by started_at`,
    [ola.id],
  );
  const ewaSessions = await query<{ state: string }>(
    `select state from learning_app.learning_sessions where child_id = $1 order by started_at`,
    [ewa.id],
  );
  expect(olaSessions.at(-1)!.state).toBe("completed");
  expect(ewaSessions.at(-1)!.state).toBe("active");
});

test("recall z należnego sprawdzenia: pisemna pisownia, Nie pamiętam i Pomiń", async ({ page }) => {
  test.slow();
  const parent = await parentSession(page);
  const child = await createChild(parent, "Cezary", "fox");
  const { publishedVersionId } = await createAssignedDeck(
    parent,
    child.id,
    "Dni tygodnia dla Cezarego",
    `kid-flow-3-${randomUUID()}`,
  );
  await seedDue(child.id, publishedVersionId, 0, "recall");
  await seedDue(child.id, publishedVersionId, 1, "recall");
  await seedDue(child.id, publishedVersionId, 2, "recall");

  await openLearn(page, child.displayName);
  await page.getByTestId("kid-deck").first().click();

  // zadanie 1: samodzielne przypomnienie wpisane z klawiaturą ocenia
  // przypomnienie i pisownię jedną odpowiedzią (SPEC §12.5, §12.8)
  await expect(page.getByTestId("kid-input")).toBeVisible();
  const taskId1 = await currentTaskId(page);
  await page.getByTestId("kid-input").fill(await answerTarget(taskId1));
  await page.getByTestId("kid-submit").click();
  await expect(page.getByTestId("kid-feedback")).toContainText("Świetnie");
  await expect(page.getByTestId("kid-feedback")).toHaveClass(/kid-feedback--correct/);
  const grades1 = await query<{ skill: string }>(
    `select skill from learning_app.assessments where attempt_id in
       (select id from learning_app.attempts where task_id = $1)`,
    [taskId1],
  );
  expect(grades1.map((g) => g.skill).sort()).toEqual(["recall", "spelling"]);
  await page.getByTestId("kid-next").click();

  // zadanie 2: „Nie pamiętam — pokaż” ujawnia własne słowo, potem zapisuje
  // zadeklarowaną trudność (nie błąd techniczny, nie mylona para)
  await driveUntil(page, () => page.getByTestId("kid-input").isVisible());
  const taskId2 = await currentTaskId(page);
  const target2 = await answerTarget(taskId2);
  await page.getByTestId("kid-not-remember").click();
  await expect(page.getByTestId("kid-reveal")).toContainText(target2);
  await page.getByTestId("kid-next").click();
  await expect(page.locator(".kid-learning")).not.toHaveAttribute("data-task-id", taskId2);
  await expect(page.getByTestId("kid-feedback")).toHaveCount(0);
  const modality2 = await query<{ modality: string }>(
    `select modality from learning_app.attempts where task_id = $1`,
    [taskId2],
  );
  expect(modality2[0]!.modality).toBe("dont_remember");

  // Serwer nadal obsługuje historyczny wynik skip bez oceny wiedzy.
  await driveUntil(page, () => page.getByTestId("kid-input").isVisible());
  const taskId3 = await currentTaskId(page);
  await expect(page.getByTestId("kid-skip")).toHaveCount(0);
  const skipped = await page.request.post(`/api/v1/kid/tasks/${taskId3}/attempts`, {
    data: { modality: "skip", clientAttemptId: randomUUID() },
  });
  expect(skipped.status()).toBe(200);
  const task3 = await query<{ state: string }>(
    `select state from learning_app.session_tasks where id = $1`, [taskId3],
  );
  expect(task3[0]!.state).toBe("skipped");

  // A22: rodzic widzi osobno przypominanie, pisownię i brak oceny wymowy
  await page.goto("/parent");
  await page.getByTestId("tab-progress").click();
  await page.getByTestId("progress-child").getByRole("button", { name: "Cezary" }).click();
  await page.getByTestId("progress-deck").selectOption({ label: "Dni tygodnia dla Cezarego" });
  await expect(page.getByTestId("progress-heading")).toContainText("Cezary");
  await expect(page.getByTestId("progress-skill-recall")).toHaveAttribute("aria-label", /do potwierdzenia 1, w trakcie nauki 2/);
  await expect(page.getByTestId("progress-skill-spelling")).toHaveAttribute("aria-label", /w trakcie nauki 2/);
  await expect(page.getByTestId("progress-pronunciation")).toContainText("Nie sprawdzono");
});

test("odmowa mikrofonu przełącza na tryb bez nagrywania", async ({ page }) => {
  test.slow();
  const parent = await parentSession(page);
  const child = await createChild(parent, "Darek", "fox");
  const { publishedVersionId } = await createAssignedDeck(
    parent,
    child.id,
    "Dni tygodnia dla Darka",
    `kid-flow-4-${randomUUID()}`,
  );
  await seedDue(child.id, publishedVersionId, 0, "recall");

  // headless-shell odrzuca getUserMedia błędem NotSupportedError (brak
  // wsparcia mediów), więc świadomą odmowę uprawnienia (A12) symulujemy
  // jawnie — tylko NotAllowedError jest zapamiętywana między sesjami
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          throw new DOMException("Permission denied", "NotAllowedError");
        },
      },
    });
  });

  await openLearn(page, child.displayName);
  await page.getByTestId("kid-mic-settings").click();
  await page.getByTestId("kid-mic-toggle").check();
  await page.getByTestId("kid-mic-settings").click();
  await page.getByTestId("kid-deck").first().click();
  await expect(page.getByTestId("kid-record")).toBeVisible();

  // brak zgody na mikrofon: komunikat i kontynuacja bez nagrywania (A12)
  await page.getByTestId("kid-record").click();
  await expect(page.getByTestId("kid-microphone-status")).toHaveAccessibleName("Mikrofon niedostępny");
  await expect(page.getByTestId("kid-mic-denied")).toBeHidden();
  await page.getByTestId("kid-microphone-status").click();
  await expect(page.getByTestId("kid-mic-denied")).toBeVisible();
  await page.getByTestId("kid-microphone-status").click();
  const taskId = await currentTaskId(page);
  await page.getByTestId("kid-input").fill(await answerTarget(taskId));
  await page.getByTestId("kid-submit").click();
  await expect(page.getByTestId("kid-feedback")).toContainText("Świetnie");

  // odmowa zapamiętana lokalnie: kolejna sesja startuje bez mikrofonu
  await page.getByTestId("kid-next").click();
  await expect(page.getByTestId("kid-feedback")).toHaveCount(0);
  await endSessionFromHeader(page);
  await expect(page.getByTestId("kid-summary")).toBeVisible();
  await page.getByTestId("kid-again").click();
  await page.getByTestId("kid-deck").first().click();
  await expect(page.locator("[data-task-id]")).toBeVisible();
  const mic = await query<{ microphone_enabled: boolean }>(
    `select microphone_enabled from learning_app.learning_sessions where child_id = $1 order by started_at`,
    [child.id],
  );
  expect(mic.map((row) => row.microphone_enabled)).toEqual([true, false]);
});

test("błąd sieci pokazuje brak połączenia i nie dopisuje sukcesu", async ({ page }) => {
  test.slow();
  const parent = await parentSession(page);
  const child = await createChild(parent, "Ewelina", "fox");
  await createAssignedDeck(parent, child.id, "Dni tygodnia dla Eweliny", `kid-flow-5-${randomUUID()}`);

  await openLearn(page, child.displayName);
  await page.getByTestId("kid-deck").first().click();

  // dojdź do pierwszego zadania ocenianego z wyborem odpowiedzi
  await driveUntil(page, () => page.getByTestId("kid-option").first().isVisible());
  const taskId = await currentTaskId(page);
  const correct = await correctOptionText(taskId);

  // utrata sieci: karta zadania znika (ukrycie wzorców), próby zablokowane
  await page.context().setOffline(true);
  await expect(page.getByTestId("kid-offline")).toBeVisible();
  await expect(page.getByTestId('kid-offline')).toHaveClass(/kid-card/);
  await expect(page.getByTestId('kid-retry')).toHaveClass(/kid-action/);
  await expect(page.getByTestId("kid-feedback")).toHaveCount(0);
  await expect(page.getByTestId("kid-option")).toHaveCount(0);
  expect(await query(`select id from learning_app.attempts where task_id = $1`, [taskId])).toHaveLength(0);

  // powrót sieci: automatyczne ponowienie odtwarza krok; odpowiedź idzie
  // raz — bez dublowania próby (A20)
  await page.context().setOffline(false);
  await expect(page.getByTestId("kid-option").first()).toBeVisible({ timeout: 30_000 });
  await page
    .getByTestId("kid-option")
    .filter({ hasText: new RegExp(`^\\s*${escapeRegex(correct)}\\s*$`) })
    .first()
    .click();
  await expect(page.getByTestId("kid-feedback")).toBeVisible();
  const attempts = await query<{ client_attempt_id: string }>(
    `select client_attempt_id from learning_app.attempts where task_id = $1`,
    [taskId],
  );
  expect(attempts).toHaveLength(1);
});

/**
 * Headless-shell Chromium nie udostępnia urządzeń medialnych, więc polyfill
 * zastępuje API platformowe (getUserMedia/MediaRecorder/Web Audio) fałszywym
 * strumieniem i dekoderem — reszta (kontroler, BrowserRecorder, cykl życia
 * UI i wysyłka PCM WAV) działa na prawdziwym kodzie.
 */
async function injectFakeMediaPlatform(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("test.trackStops") === null) {
      sessionStorage.setItem("test.trackStops", "0");
    }
    sessionStorage.setItem("test.recorderStarts", "0");
    sessionStorage.setItem("test.recorderStops", "0");
    const stopTrack = (): void => {
      sessionStorage.setItem("test.trackStops", String(Number(sessionStorage.getItem("test.trackStops") ?? "0") + 1));
    };
    const fakeTrack = {
      kind: "audio",
      label: "fake-mic",
      stop: stopTrack,
      addEventListener: (): void => undefined,
    };
    const fakeStream = {
      getTracks: () => [fakeTrack],
      getAudioTracks: () => [fakeTrack],
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => fakeStream },
    });
    // WR-02: uprawnienie mikrofonu "granted" — auto-próba mowy może wołać
    // getUserMedia bez promptu; sterowanie przez window.__kidMicPermission
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: {
        query: async () => ({
          state: ((window as unknown as { __kidMicPermission?: string }).__kidMicPermission ?? "granted"),
        }),
      },
    });
    // minimalny ważny webm: EBML header + Segment→Info→Duration 2000 (2 s) —
    // serwer czyta czas trwania z metadanych i odrzuca nagrania bez niego
    const webm = new Uint8Array([
      0x1a, 0x45, 0xdf, 0xa3, 0x80,
      0x18, 0x53, 0x80, 0x67, 0x8c,
      0x15, 0x49, 0xa9, 0x66, 0x87,
      0x44, 0x89, 0x84, 0x44, 0x7a, 0x00, 0x00,
    ]);
    class FakeMediaRecorder {
      static isTypeSupported(mimeType: string): boolean {
        return mimeType.includes("webm");
      }
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      start(): void {
        this.state = "recording";
        sessionStorage.setItem("test.recorderStarts", String(Number(sessionStorage.getItem("test.recorderStarts") ?? "0") + 1));
        sessionStorage.setItem("test.recorderStartedAt", String(Date.now()));
      }
      stop(): void {
        this.state = "inactive";
        sessionStorage.setItem("test.recorderStops", String(Number(sessionStorage.getItem("test.recorderStops") ?? "0") + 1));
        // BrowserRecorder składa bajty z ondataavailable i domyka się na onstop
        queueMicrotask(() => {
          this.ondataavailable?.({ data: new Blob([webm]) });
          this.onstop?.();
        });
      }
    }
    (window as unknown as { MediaRecorder: typeof FakeMediaRecorder }).MediaRecorder = FakeMediaRecorder;

    const decodedBuffer = (length: number, sampleRate: number) => ({
      duration: length / sampleRate,
      length,
      sampleRate,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(length),
    });
    class FakeAudioContext {
      // PR #109 r2: auto-próba akceptuje wyłącznie stan "running" — fake mikrofonu
      // jest zawsze gotowy do nasłuchu (brak polityki autoplay w teście)
      readonly state = "running";
      async decodeAudioData(): Promise<AudioBuffer> {
        return decodedBuffer(96_000, 48_000) as unknown as AudioBuffer;
      }
      // sterowalny analyser: poziom mikrofonu (skala rms×4 z browser.ts)
      // kontroluje test przez window.__kidMicLevel — domyślnie cisza, więc
      // auto-próba mowy czeka na ręczne domknięcie kliknięciem przycisku
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
      createBufferSource() {
        return { buffer: null as AudioBuffer | null, connect: () => undefined, start: () => undefined };
      }
      async startRendering(): Promise<AudioBuffer> {
        return decodedBuffer(this.length, this.sampleRate) as unknown as AudioBuffer;
      }
    }
    Object.defineProperty(window, "AudioContext", { configurable: true, value: FakeAudioContext });
    Object.defineProperty(window, "OfflineAudioContext", { configurable: true, value: FakeOfflineAudioContext });
  });
}

test("profil bez czytania przechodzi obrazkowe ćwiczenie mówione przez rzeczywisty tor nagrania", async ({ page }) => {
  test.slow();
  await injectFakeMediaPlatform(page);
  const parent = await parentSession(page);
  const child = await createChild(parent, "Ola bez czytania", "fox", false);
  try {
    await configureToggleRecording(parent, child.id);
    const { publishedVersionId } = await createAssignedDeck(
      parent, child.id, "Kolory obrazkowe", `picture-voice-${randomUUID()}`, "picture",
    );
    await seedDue(child.id, publishedVersionId, 0, "recall");
    await openLearn(page, child.displayName);
    expect(await (await page.request.get("/api/v1/kid/profiles")).json()).toContainEqual(
      expect.objectContaining({ childId: child.id, canRead: false }),
    );
    await page.getByTestId("kid-mic-settings").click();
    const microphone = page.getByTestId("kid-mic-toggle");
    if (!(await microphone.isChecked())) await microphone.check();
    await page.getByTestId("kid-mic-settings").click();
    await page.getByTestId("kid-deck").filter({ hasText: "Kolory obrazkowe" }).click();

    let spokenTaskId: string | null = null;
    for (let step = 0; step < 18; step += 1) {
      await page.waitForSelector('[data-task-id], [data-testid="kid-summary"]', { timeout: 30_000 });
      await settled(page);
      if (await page.getByTestId("kid-summary").isVisible()) break;
      await expect(page.getByTestId("kid-input")).toHaveCount(0);
      const kind = await page.getByTestId("kid-exercise").getAttribute("data-prompt-kind");
      if (kind === "picture_recall" || kind === "picture_speech") {
        spokenTaskId = await currentTaskId(page);
        await expect(page.getByTestId("kid-record")).toBeVisible();
        break;
      }
      if (await page.getByTestId("kid-done").isVisible()) {
        await page.getByTestId("kid-done").click();
      } else if (await page.getByTestId("kid-option").count() > 0) {
        const correct = await correctOptionText(await currentTaskId(page));
        await page.getByTestId("kid-option").filter({ hasText: new RegExp("^\\s*" + escapeRegex(correct) + "\\s*$") }).first().click();
        await expect(currentFeedback(page)).toBeVisible();
        await page.getByTestId("kid-next").click();
      } else {
        throw new Error("Nieoczekiwane ćwiczenie w zestawie obrazkowym: " + kind);
      }
    }
    expect(spokenTaskId).not.toBeNull();
    await expect(page.getByTestId("kid-exercise")).not.toContainText("red");
    await startFakeRecording(page);
    await expect(page.getByTestId("kid-recording")).toBeVisible();
    await stopFakeRecording(page);
    await expect(currentFeedback(page)).toBeVisible();
    const audioAttempts = await query<{ modality: string }>(
      `select modality from learning_app.attempts where task_id = $1`,
      [spokenTaskId],
    );
    expect(audioAttempts).toContainEqual({ modality: "audio" });
  } finally {
    expect((await parent.delete(`/api/v1/parent/children/${child.id}`)).status()).toBe(204);
  }
});

test("opuszczenie widoku w trakcie nagrywania zatrzymuje strumień", async ({ page }) => {
  test.slow();
  await injectFakeMediaPlatform(page);
  const parent = await parentSession(page);
  const child = await createChild(parent, "Filip", "fox");
  await configureToggleRecording(parent, child.id);
  const { publishedVersionId } = await createAssignedDeck(
    parent,
    child.id,
    "Dni tygodnia dla Filipa",
    `kid-flow-6-${randomUUID()}`,
  );
  await seedDue(child.id, publishedVersionId, 0, "recall");

  await openLearn(page, child.displayName);
  await page.getByTestId("kid-mic-settings").click();
  await page.getByTestId("kid-mic-toggle").check();
  await page.getByTestId("kid-mic-settings").click();
  await page.getByTestId("kid-deck").first().click();
  await startFakeRecording(page);
  await expect(page.getByTestId("kid-recording")).toBeVisible();

  // zakończenie sesji w trakcie nagrywania zatrzymuje strumień mikrofonu
  // (RF5); pełne przejście między dokumentami zwalnia strumień sam browser
  await endSessionFromHeader(page);
  await expect(page.getByTestId("kid-summary")).toBeVisible();
  expect(await page.evaluate(() => Number(sessionStorage.getItem("test.trackStops") ?? "0"))).toBeGreaterThanOrEqual(1);

  // Nowa sesja może zacząć od prezentacji. Cleanup mikrofonu sprawdzamy
  // przy kolejnym zadaniu z nagrywaniem, bez narzucania kolejności schedulera.
  await page.getByTestId("kid-again").click();
  await page.getByTestId("kid-mic-settings").click();
  await page.getByTestId("kid-mic-toggle").check();
  await page.getByTestId("kid-mic-settings").click();
  await page.getByTestId("kid-deck").first().click();
  // The next session has its own fixed plan and need not repeat a speech slot.
  // The lifecycle assertion above verifies the old stream was released; nowa
  // sesja może też zgodnie z produktem sama rozpocząć nagrywanie na zadaniu
  // mowy, więc nie zakładamy już braku wskaźnika nagrywania w pierwszej chwili.
  await expect(page.locator("[data-task-id]")).toBeVisible({ timeout: 30_000 });
});

test("szczegółowe podsumowanie pokazuje samodzielne wyniki i słowa do ćwiczenia na telefonie i tablecie", async ({ page }, testInfo) => {
  const parent = await parentSession(page);
  const child = await createChild(parent, "Podsumowanie", "fox");
  try {
    const { deckId, publishedVersionId } = await createAssignedDeck(parent, child.id, "Podsumowanie słów", `summary-${randomUUID()}`);
    await seedDue(child.id, publishedVersionId, 0, "recall");
    await seedDue(child.id, publishedVersionId, 0, "spelling");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/kids/${child.id}/learn`);
    await expect(page.getByTestId("kid-deck")).toBeVisible();
    await page.getByTestId("kid-mic-settings").click();
    await page.getByTestId("kid-mic-toggle").uncheck();
    await page.getByTestId("kid-mic-settings").click();
    await page.getByTestId("kid-deck").filter({ hasText: "Podsumowanie słów" }).click();
    await expect(page.getByTestId("kid-input")).toBeVisible();
    const target = await answerTarget(await currentTaskId(page));
    // Fake materiał akceptuje monday i Monday; MONDAY zalicza treść, ale nie pisownię.
    await page.getByTestId("kid-input").fill(target.toUpperCase());
    await page.getByTestId("kid-submit").click();
    await expect(page.getByTestId("kid-feedback")).toBeVisible();
    await page.getByTestId("kid-next").click();
    await expect(page.getByTestId("kid-feedback")).toHaveCount(0);
    await endSessionFromHeader(page);
    await expect(page.getByTestId("kid-summary-recall")).toContainText("1 słowo");
    await expect(page.getByTestId("kid-summary-spelling")).toHaveCount(0);
    await expect(page.getByTestId("kid-summary-practice")).toContainText(target);
    await expect(page.getByTestId("kid-summary-practice")).toContainText("pisownia");
    await expect(page.getByTestId("kid-summary-practice")).not.toContainText("przypominanie");
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: 1024 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`summary-${width}.png`), fullPage: true });
    }
    // Kolejna sesja z prezentacją nie dziedziczy poprzedniego sukcesu.
    await page.getByTestId("kid-again").click();
    await expect(page.getByTestId("kid-deck")).toBeVisible();
    await page.getByTestId("kid-deck").filter({ hasText: "Podsumowanie słów" }).click();
    await expect(page.locator("[data-task-id]")).toBeVisible();
    await endSessionFromHeader(page);
    await expect(page.getByTestId("kid-summary-neutral")).toBeVisible();
    await expect(page.getByTestId("kid-summary-recall")).toHaveCount(0);
    await expect(page.getByTestId("kid-summary-practice")).toHaveCount(0);
  } finally {
    // Sprzątanie syntetycznego profilu izoluje kolejne testy.
    expect((await parent.delete(`/api/v1/parent/children/${child.id}`)).status()).toBe(204);
  }
});
