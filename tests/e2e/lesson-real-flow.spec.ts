import { randomUUID } from "node:crypto";
import { openNewMaterial } from "./helpers/parent-new-material";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AttemptDtoSchema,
  DeckSummaryDtoSchema,
  LessonDeckDtoSchema,
  ObjectiveProgressDtoSchema,
  SessionDtoSchema,
  SessionSummaryDtoSchema,
  TaskDtoSchema,
  type AttemptDto,
  type TaskDto,
} from "@learning/contracts";
import { createDatabase } from "@learning/server";
import { expect, test, type Page } from "@playwright/test";
import { endSessionFromHeader } from "./helpers/kid-session";
import { silentWavBuffer } from "./helpers/kid-ui-fixture";
import { listenAudioPlays, stubListenAudio } from "./helpers/lesson-audio";
import { readTestRunConfig } from "../test-run-config";

const CHILD_NAME = `Obieg lekcji ${randomUUID().slice(0, 8)}`;
const LESSON_TITLE = `Present Simple ${randomUUID().slice(0, 8)}`;
const OBJECTIVE_ID = "english_grammar.present_simple.third_person_s";
const APPROVED_EXAMPLE = `He plays football every day. ${randomUUID().slice(0, 6)}`;

let database: ReturnType<typeof createDatabase> | null = null;

async function query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (!database) {
    const worldPath = join(process.cwd(), readTestRunConfig(process.env).worldFile);
    const world = JSON.parse(await readFile(worldPath, "utf8")) as { databaseUrl: string };
    database = createDatabase(world.databaseUrl);
  }
  return (await database.pool.query(sql, params)).rows as T[];
}

test.afterAll(async () => {
  await database?.pool.end();
  database = null;
});

async function enterParent(page: Page): Promise<void> {
  await page.goto("/parent");
  await page.getByTestId("auth-secret").fill("1234");
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("tab-decks")).toBeVisible();
}

/**
 * Czeka, aż nagrania zdań wszystkich ćwiczeń „Posłuchaj i wybierz” szkicu
 * (`feedback_audio` z fake TTS workera) będą gotowe. Publikacja na nie nie czeka,
 * a plan sesji treningowej zamraża się przy starcie — bez tego obecność slotu
 * słuchowego zależałaby od tempa workera. Zwraca id gotowych nagrań.
 */
async function waitForListenSentenceAudio(page: Page, deckId: string): Promise<string[]> {
  let assetIds: string[] = [];
  await expect.poll(async () => {
    const deck = LessonDeckDtoSchema.parse(await (await page.request.get(`/api/v1/parent/lessons/${deckId}`)).json());
    const listen = (deck.draft?.exercises ?? []).filter((exercise) => exercise.exerciseType === "lesson_listen_choice");
    const states = listen.map((exercise) => exercise.sentenceAudio?.state ?? "missing");
    if (states.every((state) => state === "ready")) {
      assetIds = listen.map((exercise) => exercise.sentenceAudio!.assetId!);
    }
    return states.filter((state) => state !== "ready");
  }, { timeout: 120_000 }).toEqual([]);
  return assetIds;
}

async function createAssignedLesson(
  page: Page,
  options: { objectiveIds?: readonly string[]; suffix?: string; labels?: { childName: string; lessonTitle: string } } = {},
): Promise<{ childId: string; deckId: string; versionId: string; childName: string; lessonTitle: string; listenAssetIds: string[] }> {
  const objectiveIds = options.objectiveIds ?? [OBJECTIVE_ID];
  const exampleObjectiveId = objectiveIds.includes(OBJECTIVE_ID) ? OBJECTIVE_ID : objectiveIds[0]!;
  const childName = options.labels?.childName ?? (options.suffix ? `Obieg wielocelowy ${options.suffix}` : CHILD_NAME);
  const lessonTitle = options.labels?.lessonTitle ?? (options.suffix ? `Present Simple wielocelowy ${options.suffix}` : LESSON_TITLE);
  await page.getByTestId("tab-children").click();
  await page.getByTestId("child-name").fill(childName);
  await page.getByTestId("child-add").click();
  const childRow = page.locator('[data-testid^="child-row-"]').filter({ hasText: childName });
  await expect(childRow).toHaveCount(1);
  const childHref = await childRow.getByTestId("child-learn-link").getAttribute("href");
  const childId = childHref?.match(/\/kids\/([0-9a-f-]{36})\//)?.[1];
  expect(childId).toBeTruthy();

  await page.getByTestId("tab-decks").click();
  await openNewMaterial(page, "lesson");
  const objective = page.getByTestId(`lesson-objective-${objectiveIds[0]}`);
  await expect(objective).toBeVisible();
  const objectives = page.locator('[data-testid^="lesson-objective-"]');
  for (let index = 0; index < await objectives.count(); index += 1) {
    const checkbox = objectives.nth(index);
    const id = (await checkbox.getAttribute("data-testid"))!.replace("lesson-objective-", "");
    await checkbox.setChecked(objectiveIds.includes(id));
  }
  await page.getByTestId("lesson-material").fill(
    "He plays football every day. She watches television in the evening. They study English on Monday and Tuesday.",
  );
  await page.getByTestId("lesson-pool-size").fill(objectiveIds.length > 1 ? "60" : "20");
  const createResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/parent/lessons",
  );
  await page.getByTestId("lesson-create-submit").click();
  const created = (await createResponse).json() as Promise<{ deckId: string }>;
  const { deckId } = await created;
  await expect(page.getByTestId("lesson-editor")).toBeVisible();
  await expect(page.locator('[data-testid^="exercise-"]').first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("generation-banner")).toBeHidden({ timeout: 120_000 });
  await expect(page.locator(`[data-testid="examples-${exampleObjectiveId}"]`)).toBeVisible();
  await expect(page.locator(`[data-testid^="exercise-audio-state-"]`, { hasText: "generowanie" })).toHaveCount(0, { timeout: 120_000 });
  await page.getByTestId("editor-title").fill(lessonTitle);

  const example = page.getByTestId(`example-line-${exampleObjectiveId}-0`);
  await expect(example).toBeVisible();
  await example.fill(APPROVED_EXAMPLE);
  await expect(page.getByTestId(`lesson-card-preview-${exampleObjectiveId}`).last()).toContainText(APPROVED_EXAMPLE);
  const saveDraft = page.waitForResponse((response) =>
    response.request().method() === "PATCH" && /\/api\/v1\/parent\/lesson-drafts\//.test(new URL(response.url()).pathname),
  );
  await page.getByTestId("save-lesson").click();
  expect((await saveDraft).ok()).toBe(true);
  await expect(page.getByTestId("editor-title")).toHaveValue(lessonTitle);

  const savedDeck = LessonDeckDtoSchema.parse(await (await page.request.get(`/api/v1/parent/lessons/${deckId}`)).json());
  expect(savedDeck.draft?.examples[exampleObjectiveId]).toEqual([APPROVED_EXAMPLE]);
  expect(savedDeck.draft?.assets).toEqual([]);
  await expect(page.locator('[data-testid^="exercise-audio-state-"]')).toHaveCount(0);
  const deckList = (await (await page.request.get("/api/v1/parent/decks")).json() as unknown[]).map((row) => DeckSummaryDtoSchema.parse(row));
  expect(deckList.some((deck) => deck.deckId === deckId)).toBe(true);
  await page.getByTestId("editor-back").click();
  await expect(page.getByTestId("lesson-editor")).toBeHidden();
  await page.locator(`[data-deck-id="${deckId}"]`).click();
  await expect(page.getByTestId("lesson-editor")).toBeVisible();
  await expect(page.getByTestId(`example-line-${exampleObjectiveId}-0`)).toHaveValue(APPROVED_EXAMPLE);
  await expect(page.getByTestId("publish-lesson")).toBeEnabled({ timeout: 120_000 });
  await expect(page.locator(`[data-testid^="exercise-audio-state-"]`, { hasText: "generowanie" })).toHaveCount(0, { timeout: 120_000 });
  const listenAssetIds = await waitForListenSentenceAudio(page, deckId);

  const publish = page.waitForResponse((response) =>
    response.request().method() === "POST" && /\/api\/v1\/parent\/lesson-drafts\/.+\/publish$/.test(new URL(response.url()).pathname),
  );
  await page.getByTestId("publish-lesson").click();
  expect((await publish).ok()).toBe(true);
  await expect(page.getByTestId("publish-status")).toBeVisible();
  const deckResponse = await page.request.get(`/api/v1/parent/lessons/${deckId}`);
  expect(deckResponse.ok()).toBe(true);
  const publishedDeck = LessonDeckDtoSchema.parse(await deckResponse.json());
  const versionId = publishedDeck.published?.id;
  expect(versionId).toBeTruthy();

  await page.getByTestId("lesson-tab-children").click();
  const childAssignment = page.locator('[data-testid^="assign-row-"]').filter({ hasText: childName });
  await expect(childAssignment).toBeVisible();
  const assignment = page.waitForResponse((response) =>
    response.request().method() === "PUT" && new URL(response.url()).pathname === `/api/v1/parent/assignments/${childId}/${deckId}`,
  );
  await childAssignment.locator('[data-testid^="assign-submit-"]').click();
  expect((await assignment).status()).toBe(204);

  return { childId: childId!, deckId, versionId: versionId!, childName, lessonTitle, listenAssetIds };
}

/**
 * Odsłuch w przeglądarce dziecka: żądania nagrań idą do prawdziwego serwera
 * (status zostaje zapisany), ale przeglądarka dostaje cichy WAV, bo fake TTS
 * zwraca bajty, których nie da się zdekodować; `play()` zastępuje atrapa
 * kończąca odtwarzanie po 50 ms (headless nie gwarantuje odtworzenia).
 * Dziennik `log` zachowuje kolejność: `auth:<taskId>` przy wysłaniu
 * autoryzacji odsłuchu, `media:<assetId>:<status>` przy pobraniu nagrania.
 */
async function prepareKidAudio(page: Page): Promise<{ log: string[] }> {
  const log: string[] = [];
  await stubListenAudio(page, "end");
  page.on("request", (request) => {
    const match = /^\/api\/v1\/kid\/tasks\/([0-9a-f-]{36})\/disclosures$/.exec(new URL(request.url()).pathname);
    if (request.method() === "POST" && match) log.push(`auth:${match[1]}`);
  });
  await page.route("**/api/v1/media/**", async (route) => {
    const response = await route.fetch();
    const assetId = new URL(route.request().url()).pathname.split("/").pop();
    log.push(`media:${assetId}:${response.status()}`);
    if (!response.ok()) {
      await route.fulfill({ response });
      return;
    }
    await route.fulfill({ status: 200, contentType: "audio/wav", body: silentWavBuffer() });
  });
  return { log };
}

async function openKidLesson(page: Page, childId: string, deckId: string): Promise<ReturnType<typeof SessionDtoSchema.parse>> {
  await page.goto(`/kids/${childId}/learn`);
  const deck = page.locator(`[data-testid="kid-deck-card"][data-deck-id="${deckId}"]`);
  await expect(deck).toBeVisible();
  await page.getByTestId("kid-mic-settings").click();
  await page.getByTestId("kid-mic-toggle").uncheck();
  await page.getByTestId("kid-mic-settings").click();
  const start = page.waitForResponse((response) =>
    response.request().method() === "POST" && /\/api\/v1\/kid\/sessions$/.test(new URL(response.url()).pathname),
  );
  await deck.getByTestId("kid-deck").click();
  const session = SessionDtoSchema.parse(await (await start).json());
  expect(session.mode).toBe("training");
  expect(session.microphoneEnabled).toBe(false);
  await expect(page.locator("main[data-task-id]")).toBeVisible();
  return session;
}

function captureTaskResponses(page: Page): Map<string, TaskDto> {
  const tasks = new Map<string, TaskDto>();
  page.on("response", async (response) => {
    if (response.request().method() !== "POST" || !/\/api\/v1\/kid\/sessions\/.+\/next$/.test(new URL(response.url()).pathname)) return;
    try {
      const payload: unknown = await response.json();
      if (payload !== null) {
        const task = TaskDtoSchema.parse(payload);
        tasks.set(task.taskId, task);
      }
    } catch {
      // Błąd odpowiedzi jest asertywnie wykrywany, gdy bieżącego taskId brak w mapie.
    }
  });
  return tasks;
}

async function currentTask(page: Page): Promise<TaskDto> {
  const taskId = await page.locator("main[data-task-id]").getAttribute("data-task-id");
  expect(taskId).toBeTruthy();
  await expect.poll(() => taskResponses.get(taskId!)).toBeTruthy();
  const task = taskResponses.get(taskId!);
  expect(task, `Brak prawdziwej odpowiedzi API dla zadania ${taskId}`).toBeTruthy();
  expect(task!.prompt).not.toHaveProperty("audioAssetId");
  await expect(page.getByTestId("kid-lesson-listen")).toHaveCount(0);
  return task!;
}

let taskResponses: Map<string, TaskDto>;

async function readCorrectOption(taskId: string): Promise<string> {
  const rows = await query<{ answer_key: { correctOptionId?: string } }>(
    "select answer_key from learning_app.session_tasks where id = $1",
    [taskId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.answer_key.correctOptionId).toBeTruthy();
  return rows[0]!.answer_key.correctOptionId!;
}

async function answerGuided(page: Page, task: TaskDto): Promise<{ attempt: AttemptDto; nextTask: TaskDto }> {
  const correctOptionId = await readCorrectOption(task.taskId);
  const attemptResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && /\/tasks\/.+\/attempts$/.test(new URL(response.url()).pathname),
  );
  if (task.prompt.kind === "lesson_choice" || task.prompt.kind === "lesson_listen_choice") {
    // Opcje „Posłuchaj i wybierz” otwiera dopiero koniec autoodtwarzania (atrapa z `prepareKidAudio`).
    const text = task.prompt.options.find((option) => option.id === correctOptionId)?.text;
    expect(text).toBeTruthy();
    const option = page.getByRole("button", { name: text!, exact: true });
    await expect(option).toBeVisible();
    await expect(option).toBeEnabled();
    await option.click({ force: true, noWaitAfter: true });
  } else if (task.prompt.kind === "lesson_notice") {
    const text = task.prompt.segments.flat().find((segment) => segment.id === correctOptionId)?.text;
    expect(text).toBeTruthy();
    const option = page.getByTestId("kid-lesson-notice-word").getByText(text!, { exact: true });
    await expect(option).toBeVisible();
    await expect(option).toBeEnabled();
    await option.click({ force: true, noWaitAfter: true });
  } else {
    throw new Error(`Nieobsługiwane ćwiczenie guided: ${task.prompt.kind}`);
  }
  const attempt = AttemptDtoSchema.parse(await (await attemptResponse).json());
  await expect(page.getByTestId("kid-feedback")).toContainText("Świetnie!");
  await page.getByTestId("kid-next").click();
  await expect(page.locator("main[data-task-id]")).not.toHaveAttribute("data-task-id", task.taskId);
  const nextTask = await currentTask(page);
  return { attempt, nextTask };
}

async function advanceLessonCard(page: Page, task: TaskDto): Promise<TaskDto> {
  const completion = page.waitForResponse((response) =>
    response.request().method() === "POST" && /\/api\/v1\/kid\/tasks\/.+\/complete-presentation$/.test(new URL(response.url()).pathname),
  );
  const next = page.waitForResponse((response) =>
    response.request().method() === "POST" && /\/api\/v1\/kid\/sessions\/.+\/next$/.test(new URL(response.url()).pathname),
  );
  const nextButton = page.getByTestId("kid-lesson-next");
  await expect(nextButton).toBeVisible();
  await expect(nextButton).toBeEnabled();
  await nextButton.click({ force: true, noWaitAfter: true });
  expect((await completion).ok()).toBe(true);
  const nextTask = TaskDtoSchema.parse(await (await next).json());
  expect(nextTask.taskId).not.toBe(task.taskId);
  await expect(page.locator(`main[data-task-id="${nextTask.taskId}"]`)).toBeVisible();
  return nextTask;
}

async function tableCounts(sessionId: string): Promise<{ tasks: number; attempts: number; assessments: number }> {
  const [taskRows, attemptRows, assessmentRows] = await Promise.all([
    query<{ count: string }>("select count(*)::text as count from learning_app.session_tasks where session_id = $1", [sessionId]),
    query<{ count: string }>("select count(*)::text as count from learning_app.attempts where task_id in (select id from learning_app.session_tasks where session_id = $1)", [sessionId]),
    query<{ count: string }>("select count(*)::text as count from learning_app.assessments where attempt_id in (select a.id from learning_app.attempts a join learning_app.session_tasks st on st.id = a.task_id where st.session_id = $1)", [sessionId]),
  ]);
  return { tasks: Number(taskRows[0]!.count), attempts: Number(attemptRows[0]!.count), assessments: Number(assessmentRows[0]!.count) };
}

test("approved lesson survives reload and support without duplicate or independent credit", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await enterParent(page);
  const { childId, deckId, versionId } = await createAssignedLesson(page);

  const kidContext = await browser.newContext({ locale: "pl-PL", viewport: { width: 390, height: 844 } });
  try {
    const kid = await kidContext.newPage();
    await prepareKidAudio(kid);
    taskResponses = captureTaskResponses(kid);
    const started = await openKidLesson(kid, childId, deckId);
    expect(started.deckVersionId).toBe(versionId);

    const firstCard = kid.getByTestId("kid-lesson-card-title");
    await expect(firstCard).toBeVisible();
    await expect(kid.getByTestId("kid-lesson-card-examples").locator("li")).toHaveText([APPROVED_EXAMPLE]);
    await expect(kid.getByTestId("kid-lesson-card-examples")).not.toContainText(/^Example for /);

    let task = await currentTask(kid);
    let steps = 0;
    const completedGuidedTaskIds: string[] = [];
    while (completedGuidedTaskIds.length < 2 && steps < 12) {
      if (task.prompt.kind === "lesson_card") {
        task = await advanceLessonCard(kid, task);
      } else if (task.prompt.kind === "lesson_listen_choice") {
        // Slot słuchowy (po pierwszym zwykłym zadaniu celu) jest wspomagany i poza ścieżką etapów —
        // nie liczy się do zadań prowadzonych tego scenariusza; pełny przebieg ma osobny test.
        const { nextTask } = await answerGuided(kid, task);
        task = nextTask;
      } else {
        const { attempt, nextTask } = await answerGuided(kid, task);
        expect(attempt.taskId).toBe(task.taskId);
        completedGuidedTaskIds.push(task.taskId);
        task = nextTask;
      }
      steps += 1;
    }
    expect(completedGuidedTaskIds).toHaveLength(2);
    expect(["lesson_choice", "lesson_order", "lesson_short_answer"]).toContain(task.prompt.kind);
    const sessionId = task.sessionId;
    const difficultyTaskId = task.taskId;
    const completedAttemptsBeforeReload = await query<{ task_id: string; attempt_count: string; assessment_count: string }>(
      `select st.id as task_id, count(distinct a.id)::text as attempt_count,
              count(distinct (asm.attempt_id, asm.skill)) filter (where asm.attempt_id is not null)::text as assessment_count
         from learning_app.session_tasks st
         left join learning_app.attempts a on a.task_id = st.id
         left join learning_app.assessments asm on asm.attempt_id = a.id
        where st.session_id = $1 and st.id = any($2::uuid[])
        group by st.id`,
      [sessionId, completedGuidedTaskIds],
    );
    expect(completedAttemptsBeforeReload).toHaveLength(completedGuidedTaskIds.length);
    for (const row of completedAttemptsBeforeReload) {
      expect(row.attempt_count).toBe("1");
      expect(Number(row.assessment_count)).toBeGreaterThan(0);
    }
    const beforeReload = await tableCounts(sessionId);

    await kid.reload();
    const resumedSessionResponse = kid.waitForResponse((response) =>
      response.request().method() === "POST" && /\/api\/v1\/kid\/sessions$/.test(new URL(response.url()).pathname),
    );
    await kid.locator(`[data-testid="kid-deck-card"][data-deck-id="${deckId}"]`).getByTestId("kid-deck").click();
    const resumed = SessionDtoSchema.parse(await (await resumedSessionResponse).json());
    expect(resumed).toMatchObject({ sessionId, deckVersionId: versionId, resumed: true });
    await expect(kid.locator(`main[data-task-id="${difficultyTaskId}"]`)).toBeVisible();
    await expect(kid.getByTestId("kid-lesson-listen")).toHaveCount(0);
    expect(await tableCounts(sessionId)).toEqual(beforeReload);
    const completedAttemptsAfterReload = await query<{ task_id: string; attempt_count: string; assessment_count: string }>(
      `select st.id as task_id, count(distinct a.id)::text as attempt_count,
              count(distinct (asm.attempt_id, asm.skill)) filter (where asm.attempt_id is not null)::text as assessment_count
         from learning_app.session_tasks st
         left join learning_app.attempts a on a.task_id = st.id
         left join learning_app.assessments asm on asm.attempt_id = a.id
        where st.session_id = $1 and st.id = any($2::uuid[])
        group by st.id`,
      [sessionId, completedGuidedTaskIds],
    );
    expect(completedAttemptsAfterReload).toEqual(completedAttemptsBeforeReload);

    let taskAfterDifficulty = await currentTask(kid);
    let incorrectCount = 0;
    let difficultySteps = 0;
    const incorrectTaskIds: string[] = [];
    while (incorrectCount < 2 && difficultySteps < 12) {
      if (taskAfterDifficulty.prompt.kind === "lesson_card") {
        taskAfterDifficulty = await advanceLessonCard(kid, taskAfterDifficulty);
      } else if (taskAfterDifficulty.prompt.kind === "lesson_choice") {
        const correctOptionId = await readCorrectOption(taskAfterDifficulty.taskId);
        const wrongText = taskAfterDifficulty.prompt.options.find((option) => option.id !== correctOptionId)?.text;
        expect(wrongText).toBeTruthy();
        const wrongAttemptResponse = kid.waitForResponse((response) =>
          response.request().method() === "POST" && /\/tasks\/.+\/attempts$/.test(new URL(response.url()).pathname),
        );
        await kid.getByRole("button", { name: wrongText!, exact: true }).click();
        const wrongAttempt = AttemptDtoSchema.parse(await (await wrongAttemptResponse).json());
        expect(wrongAttempt).toMatchObject({ taskId: taskAfterDifficulty.taskId, feedback: { kind: "incorrect" } });
        incorrectCount += 1;
        incorrectTaskIds.push(taskAfterDifficulty.taskId);
        await kid.getByTestId("kid-next").click();
        await expect(kid.locator("main[data-task-id]")).not.toHaveAttribute("data-task-id", taskAfterDifficulty.taskId);
        taskAfterDifficulty = await currentTask(kid);
      } else {
        const { nextTask } = await answerGuided(kid, taskAfterDifficulty);
        taskAfterDifficulty = nextTask;
      }
      difficultySteps += 1;
    }
    expect(incorrectCount).toBe(2);
    const difficultyRows = await query<{ attempt_id: string }>(
      "select attempt_id from learning_app.assessments where attempt_id in (select id from learning_app.attempts where task_id = any($1::uuid[])) and outcome = 'incorrect'",
      [incorrectTaskIds],
    );
    expect(difficultyRows.length).toBeGreaterThanOrEqual(2);

    const unchangedNextTask = taskAfterDifficulty;
    expect(unchangedNextTask.prompt.kind).not.toBe("lesson_card");

    const endFirstSession = kid.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === `/api/v1/kid/sessions/${sessionId}/end`,
    );
    await endSessionFromHeader(kid);
    const firstSummary = SessionSummaryDtoSchema.parse(await (await endFirstSession).json());
    expect(firstSummary.sessionId).toBe(sessionId);
    expect((await tableCounts(sessionId)).attempts).toBe(beforeReload.attempts + 2);

    await kid.goto(`/kids/${childId}/learn`);
    const deck = kid.locator(`[data-testid="kid-deck-card"][data-deck-id="${deckId}"]`);
    await expect(deck).toBeVisible();
    const supportSessionResponse = kid.waitForResponse((response) =>
      response.request().method() === "POST" && /\/api\/v1\/kid\/sessions$/.test(new URL(response.url()).pathname),
    );
    await deck.getByTestId("kid-deck").click();
    const supportSession = SessionDtoSchema.parse(await (await supportSessionResponse).json());
    expect(supportSession.sessionId).not.toBe(sessionId);
    const supportSessionId = supportSession.sessionId;
    const supportCardTask = await currentTask(kid);
    if (supportCardTask.prompt.kind !== "lesson_card") {
      throw new Error(`Oczekiwano karty wsparcia, otrzymano ${supportCardTask.prompt.kind}`);
    }
    const supportTaskContext = await query<{ exercise_type: string; card_purpose: string | null }>(
      "select exercise_type, context->>'cardPurpose' as card_purpose from learning_app.session_tasks where id = $1 and session_id = $2",
      [supportCardTask.taskId, supportSessionId],
    );
    expect(supportTaskContext).toEqual([{ exercise_type: "lesson_card", card_purpose: "support" }]);
    await expect(kid.getByTestId("kid-lesson-card-title")).toHaveText(supportCardTask.prompt.card.title);
    const supportedTask = await advanceLessonCard(kid, supportCardTask);
    expect(["lesson_choice", "lesson_notice"]).toContain(supportedTask.prompt.kind);
    const { attempt: supportedAttempt } = await answerGuided(kid, supportedTask);
    expect(supportedAttempt).toMatchObject({ taskId: supportedTask.taskId, modality: "choice", taskState: "answered" });
    const supportedAssessment = await query<{ outcome: string; independent: boolean; confirmation_eligible: boolean }>(
      "select outcome, independent, confirmation_eligible from learning_app.assessments where attempt_id = $1 and skill = 'objective'",
      [supportedAttempt.attemptId],
    );
    expect(supportedAssessment).toEqual([{ outcome: "correct", independent: false, confirmation_eligible: false }]);

    const projection = await query<{ streak: number; last_independent_at: string | null; status: string }>(
      "select streak, last_independent_at, status from learning_app.child_objective_progress where child_id = $1 and objective_id = $2",
      [childId, OBJECTIVE_ID],
    );
    expect(projection).toHaveLength(1);
    expect(projection[0]).toMatchObject({ streak: 0, last_independent_at: null });
    expect(projection[0]!.status).not.toBe("mastered");

    const endResponse = kid.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === `/api/v1/kid/sessions/${supportSessionId}/end`,
    );
    await endSessionFromHeader(kid);
    const summary = SessionSummaryDtoSchema.parse(await (await endResponse).json());
    await expect(kid.getByTestId("kid-summary")).toBeVisible();
    expect(summary.sessionId).toBe(supportSessionId);
    expect(["ended", "completed"]).toContain(summary.state);
    expect(summary.objectives?.map((objective) => objective.objectiveId)).toContain(OBJECTIVE_ID);
    expect((await tableCounts(sessionId)).attempts).toBe(beforeReload.attempts + 2);
    const completedAttemptsAfterEnd = await query<{ task_id: string; attempt_count: string; assessment_count: string }>(
      `select st.id as task_id, count(distinct a.id)::text as attempt_count,
              count(distinct (asm.attempt_id, asm.skill)) filter (where asm.attempt_id is not null)::text as assessment_count
         from learning_app.session_tasks st
         left join learning_app.attempts a on a.task_id = st.id
         left join learning_app.assessments asm on asm.attempt_id = a.id
        where st.session_id = $1 and st.id = any($2::uuid[])
        group by st.id`,
      [sessionId, completedGuidedTaskIds],
    );
    expect(completedAttemptsAfterEnd).toEqual(completedAttemptsBeforeReload);

    await page.getByTestId("editor-back").click();
    await page.getByTestId("tab-decks").click();
    const lessonRow = page.locator('[data-testid^="deck-row-"]').filter({ hasText: LESSON_TITLE });
    await expect(lessonRow).toBeVisible();
    const progressResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === `/api/v1/parent/lessons/${deckId}/progress` && new URL(response.url()).searchParams.get("childId") === childId,
    );
    await lessonRow.click();
    await page.getByTestId("lesson-tab-children").click();
    await expect(page.getByTestId("supervision-panel")).toBeVisible();
    const selectedChild = page.getByTestId("supervision-child");
    if (await selectedChild.inputValue() !== childId) await selectedChild.selectOption(childId);
    const progressResponse = await progressResponsePromise;
    expect(progressResponse.ok()).toBe(true);
    const progress = (await progressResponse.json() as unknown[]).map((row) => ObjectiveProgressDtoSchema.parse(row));
    const objectiveProgress = progress.find((row) => row.objectiveId === OBJECTIVE_ID);
    expect(objectiveProgress).toMatchObject({ status: "learning", lastIndependentAt: null });
    await expect(page.getByTestId(`progress-status-${OBJECTIVE_ID}`)).toHaveText("W nauce");

    await page.reload();
    await page.getByTestId("tab-decks").click();
    const persistedProgressResponse = page.waitForResponse((response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === `/api/v1/parent/lessons/${deckId}/progress` && new URL(response.url()).searchParams.get("childId") === childId,
    );
    await page.locator('[data-testid^="deck-row-"]').filter({ hasText: LESSON_TITLE }).click();
    await page.getByTestId("lesson-tab-children").click();
    await expect(page.getByTestId("supervision-panel")).toBeVisible();
    const persistedSelectedChild = page.getByTestId("supervision-child");
    if (await persistedSelectedChild.inputValue() !== childId) await persistedSelectedChild.selectOption(childId);
    expect((await persistedProgressResponse).ok()).toBe(true);
    await expect(page.getByTestId(`progress-status-${OBJECTIVE_ID}`)).toHaveText("W nauce");
    const persisted = await (await page.request.get(`/api/v1/parent/lessons/${deckId}/progress?childId=${childId}`)).json() as unknown[];
    expect(persisted.map((row) => ObjectiveProgressDtoSchema.parse(row).objectiveId)).toContain(OBJECTIVE_ID);
  } finally {
    await kidContext.close();
  }
});

test("question, negative and short-answer objectives complete a no-audio child and parent flow", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const suffix = randomUUID().slice(0, 8);
  const objectiveIds = [
    "english_grammar.present_simple.question",
    "english_grammar.present_simple.negative",
    "english_grammar.present_simple.short_answers",
  ];
  await enterParent(page);
  const { childId, deckId, versionId, lessonTitle } = await createAssignedLesson(page, { objectiveIds, suffix });
  const published = LessonDeckDtoSchema.parse(await (await page.request.get(`/api/v1/parent/lessons/${deckId}`)).json()).published!;
  expect(published.objectiveIds).toEqual(expect.arrayContaining(objectiveIds));
  expect(published.assets).toEqual([]);
  for (const objectiveId of objectiveIds) {
    expect(published.examples[objectiveId]?.length).toBeGreaterThan(0);
    expect(published.exercises.filter((exercise) => exercise.objectiveId === objectiveId).length).toBeGreaterThanOrEqual(9);
  }
  expect(published.exercises.some((exercise) => exercise.exerciseType === "lesson_open_answer" && exercise.prompt?.startsWith("Przetłumacz"))).toBe(true);

  const kidContext = await browser.newContext({ locale: "pl-PL", viewport: { width: 390, height: 844 } });
  try {
    const kid = await kidContext.newPage();
    await prepareKidAudio(kid);
    taskResponses = captureTaskResponses(kid);
    const started = await openKidLesson(kid, childId, deckId);
    expect(started.deckVersionId).toBe(versionId);
    let task = await currentTask(kid);
    let answered = false;
    let assessedObjectiveId: string | null = null;
    for (let step = 0; step < 15 && !answered; step += 1) {
      if (task.prompt.kind === "lesson_card") {
        task = await advanceLessonCard(kid, task);
      } else if (task.prompt.kind === "lesson_choice" || task.prompt.kind === "lesson_notice") {
        const objectiveRows = await query<{ objective_id: string }>(
          `select ir.payload->>'objectiveId' as objective_id
             from learning_app.session_tasks st
             join learning_app.item_revisions ir on ir.id = st.item_revision_id
            where st.id = $1`,
          [task.taskId],
        );
        expect(objectiveRows).toHaveLength(1);
        assessedObjectiveId = objectiveRows[0]!.objective_id;
        const { attempt } = await answerGuided(kid, task);
        expect(attempt.taskState).toBe("answered");
        const assessment = await query<{ outcome: string }>(
          "select outcome from learning_app.assessments where attempt_id = $1 and skill = 'objective'",
          [attempt.attemptId],
        );
        expect(assessment).toEqual([{ outcome: "correct" }]);
        answered = true;
      } else {
        throw new Error(`Nieoczekiwany typ pierwszego ćwiczenia prowadzonego: ${task.prompt.kind}`);
      }
      if (!answered) task = await currentTask(kid);
    }
    expect(answered).toBe(true);
    expect(objectiveIds).toContain(assessedObjectiveId);
    await expect(kid.getByTestId("kid-lesson-listen")).toHaveCount(0);

    const afterAnswer = await query<{ attempts: string }>(
      "select count(*)::text as attempts from learning_app.attempts where task_id in (select id from learning_app.session_tasks where session_id = $1)",
      [started.sessionId],
    );
    expect(Number(afterAnswer[0]!.attempts)).toBe(1);
    await kid.reload();
    const resume = kid.waitForResponse((response) =>
      response.request().method() === "POST" && /\/api\/v1\/kid\/sessions$/.test(new URL(response.url()).pathname),
    );
    await kid.locator(`[data-testid="kid-deck-card"][data-deck-id="${deckId}"]`).getByTestId("kid-deck").click();
    expect(SessionDtoSchema.parse(await (await resume).json())).toMatchObject({ sessionId: started.sessionId, resumed: true });
    expect(Number((await query<{ attempts: string }>(
      "select count(*)::text as attempts from learning_app.attempts where task_id in (select id from learning_app.session_tasks where session_id = $1)",
      [started.sessionId],
    ))[0]!.attempts)).toBe(1);

    await page.getByTestId("editor-back").click();
    await page.getByTestId("tab-decks").click();
    const lessonRow = page.locator('[data-testid^="deck-row-"]').filter({ hasText: lessonTitle });
    await expect(lessonRow).toBeVisible();
    await lessonRow.click();
    await page.getByTestId("lesson-tab-children").click();
    await expect(page.getByTestId("supervision-panel")).toBeVisible();
    const selectedChild = page.getByTestId("supervision-child");
    if (await selectedChild.inputValue() !== childId) await selectedChild.selectOption(childId);
    const progress = (await (await page.request.get(`/api/v1/parent/lessons/${deckId}/progress?childId=${childId}`)).json() as unknown[])
      .map((row) => ObjectiveProgressDtoSchema.parse(row));
    expect(progress.find((row) => row.objectiveId === assessedObjectiveId)).toMatchObject({ status: "learning" });
  } finally {
    await kidContext.close();
  }
});

test("listen choice slot follows the first assessed task with autoplay, readback and a parent work-card step", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const suffix = randomUUID().slice(0, 8);
  await enterParent(page);
  const { childId, deckId, childName, listenAssetIds } = await createAssignedLesson(page, {
    labels: { childName: `Obieg słuchowy ${suffix}`, lessonTitle: `Present Simple słuchowy ${suffix}` },
  });
  // Fake provider dokłada do 2 ćwiczeń słuchowych na cel; wszystkie nagrania są gotowe przed startem sesji.
  expect(listenAssetIds.length).toBeGreaterThan(0);
  const published = LessonDeckDtoSchema.parse(await (await page.request.get(`/api/v1/parent/lessons/${deckId}`)).json()).published!;
  expect(published.exercises.filter((exercise) => exercise.exerciseType === "lesson_listen_choice")).toHaveLength(listenAssetIds.length);

  const kidContext = await browser.newContext({ locale: "pl-PL", viewport: { width: 390, height: 844 } });
  try {
    const kid = await kidContext.newPage();
    const audio = await prepareKidAudio(kid);
    taskResponses = captureTaskResponses(kid);
    const started = await openKidLesson(kid, childId, deckId);
    const sessionId = started.sessionId;

    // Karty i „Zauważ” wprowadzają cel; slot słuchowy przychodzi zaraz po pierwszym zwykłym zadaniu celu.
    let task = await currentTask(kid);
    const regularTaskIds: string[] = [];
    let previousTaskId: string | null = null;
    for (let step = 0; step < 10 && task.prompt.kind !== "lesson_listen_choice"; step += 1) {
      previousTaskId = task.taskId;
      if (task.prompt.kind === "lesson_card") {
        task = await advanceLessonCard(kid, task);
      } else {
        expect(regularTaskIds, "slot słuchowy powinien przyjść po pierwszym zwykłym zadaniu").toHaveLength(0);
        if (task.prompt.kind !== "lesson_notice") regularTaskIds.push(task.taskId);
        const { attempt, nextTask } = await answerGuided(kid, task);
        expect(attempt).toMatchObject({ taskId: task.taskId, taskState: "answered" });
        task = nextTask;
      }
    }
    if (task.prompt.kind !== "lesson_listen_choice") throw new Error(`Oczekiwano zadania słuchowego, otrzymano ${task.prompt.kind}`);
    expect(regularTaskIds).toHaveLength(1);
    expect(previousTaskId).toBe(regularTaskIds[0]);
    const listenTask = task;
    const listenRows = await query<{ exercise_type: string; reason: string | null }>(
      "select exercise_type, context->>'reason' as reason from learning_app.session_tasks where id = $1 and session_id = $2",
      [listenTask.taskId, sessionId],
    );
    expect(listenRows).toEqual([{ exercise_type: "lesson_listen_choice", reason: "listen_practice" }]);

    // Kid DTO bez id nagrania; polecenie z katalogu i przycisk odsłuchu w poleceniu.
    expect(listenTask.prompt).not.toHaveProperty("audioAssetId");
    await expect(kid.getByTestId("kid-exercise")).toContainText("Posłuchaj i wybierz, czego brakuje.");
    await expect(kid.getByTestId("kid-play")).toHaveAccessibleName("Posłuchaj zdania");
    await expect(kid.getByTestId("kid-lesson-stem")).toHaveAttribute("lang", "en-GB");

    // Autoodtwarzanie: jedna autoryzacja odsłuchu, potem pobranie nagrania z prawdziwego serwera.
    const authIndex = () => audio.log.indexOf(`auth:${listenTask.taskId}`);
    const mediaAfterAuth = () => authIndex() < 0 ? undefined : audio.log.slice(authIndex() + 1).find((entry) => entry.startsWith("media:"));
    await expect.poll(mediaAfterAuth).toBeTruthy();
    // Żadne nagranie zdania nie zostało pobrane przed autoryzacją.
    expect(audio.log.slice(0, authIndex()).filter((entry) => listenAssetIds.some((assetId) => entry.startsWith(`media:${assetId}:`)))).toEqual([]);
    const [, stimulusAssetId, mediaStatus] = mediaAfterAuth()!.split(":");
    expect(mediaStatus).toBe("200");
    expect(listenAssetIds).toContain(stimulusAssetId);
    const sealedAudio = await query<{ count: string }>(
      "select count(*)::text as count from learning_app.learning_events where task_id = $1 and kind = 'audio_issued' and sealed = true",
      [listenTask.taskId],
    );
    expect(Number(sealedAudio[0]!.count)).toBeGreaterThanOrEqual(1);
    await expect.poll(() => listenAudioPlays(kid)).toBe(1);

    // Odpowiedź po odsłuchu: wspomagana, oceniona; feedback odczytuje zdanie tym samym nagraniem.
    const { attempt, nextTask } = await (async () => {
      const attemptPromise = kid.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === `/api/v1/kid/tasks/${listenTask.taskId}/attempts`,
      );
      const correctOptionId = await readCorrectOption(listenTask.taskId);
      const text = listenTask.prompt.kind === "lesson_listen_choice" ? listenTask.prompt.options.find((option) => option.id === correctOptionId)?.text : undefined;
      expect(text).toBeTruthy();
      const option = kid.getByRole("button", { name: text!, exact: true });
      await expect(option).toBeEnabled();
      await option.click({ noWaitAfter: true });
      const parsed = AttemptDtoSchema.parse(await (await attemptPromise).json());
      await expect(kid.getByTestId("kid-feedback")).toContainText("Świetnie!");
      // Odczyt zdania: drugie pobranie tego samego nagrania i drugie odtworzenie, bez nowej autoryzacji.
      await expect.poll(() => audio.log.filter((entry) => entry === `media:${stimulusAssetId}:200`).length).toBe(2);
      await expect.poll(() => listenAudioPlays(kid)).toBe(2);
      expect(audio.log.filter((entry) => entry === `auth:${listenTask.taskId}`)).toHaveLength(1);
      await kid.getByTestId("kid-next").click();
      await expect(kid.locator("main[data-task-id]")).not.toHaveAttribute("data-task-id", listenTask.taskId);
      return { attempt: parsed, nextTask: await currentTask(kid) };
    })();
    expect(attempt).toMatchObject({ taskId: listenTask.taskId, taskState: "answered", feedback: { correctAudioAssetId: stimulusAssetId } });
    expect(nextTask.prompt.kind).not.toBe("lesson_listen_choice");
    const assessment = await query<{ outcome: string; independent: boolean }>(
      "select outcome, independent from learning_app.assessments where attempt_id = $1 and skill = 'objective'",
      [attempt.attemptId],
    );
    expect(assessment).toEqual([{ outcome: "correct", independent: false }]);

    const endResponse = kid.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === `/api/v1/kid/sessions/${sessionId}/end`,
    );
    await endSessionFromHeader(kid);
    expect((await endResponse).ok()).toBe(true);
    await expect(kid.getByTestId("kid-summary")).toBeVisible();

    // Nadzór rodzica: krok słuchowy na karcie pracy dziecka jak każdy inny typ.
    await page.getByTestId("editor-back").click();
    await page.getByTestId("tab-work-card").click();
    await expect(page.getByTestId("work-card")).toBeVisible();
    await page.getByRole("button", { name: childName, exact: true }).click();
    const listenStep = page.getByTestId("work-card-step").filter({ hasText: "Posłuchaj i wybierz" });
    await expect(listenStep).toHaveCount(1);
    await expect(listenStep).toContainText("Odpowiedziano");
  } finally {
    await kidContext.close();
  }
});
