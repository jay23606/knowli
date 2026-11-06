import { expect as baseExpect, test, type Page } from "@playwright/test";
import { openNewMaterial } from "./helpers/parent-new-material";
import type {
  AttemptDto, KidDeckDto, KidProfileDto, LessonMockTestReportDto, LessonMockTestSummaryDto, SessionDto, SessionSummaryDto, TaskDto,
} from "@learning/contracts";
import { installKidUiFixture } from "./helpers/kid-ui-fixture";
import { fillParentAuth } from "./helpers/parent-session";

/**
 * E2E próbnej kartkówki lekcji (zadanie 17B): rodzic ustawia kartkówkę lekcji →
 * dziecko ją rozwiązuje BEZ feedbacku w trakcie → omówienie po zamknięciu →
 * rodzic widzi raport per cel. Przepływ dziecka jest deterministycznie zaślepiony
 * fixturem kid-UI (jak w `lesson-kid.spec.ts`); logikę serwera (plan, ocena,
 * raport, pieczętowanie ekspozycji) pokrywają integracje 17A
 * (`lesson-mock-tests.test.ts`). Panel rodzica używa realnego backendu z publikacją
 * lekcji; endpoint raportu `/parent/mock-tests` jest zaślepiony deterministycznie,
 * jak nadzór w `lesson-parent-supervision.spec.ts`.
 *
 * Kompletność bierzemy z flagi `complete`; po Fix round 1 zamknięta kompletna
 * kartkówka utrwala `completed` (zgodnie ze słówkami), więc fikstury też.
 */

const expect = baseExpect.configure({ timeout: 2_000 });

const childId = "20000000-0000-4000-8000-000000000001";
const deckId = "20000000-0000-4000-8000-000000000002";
const sessionId = "20000000-0000-4000-8000-000000000003";
const versionId = "20000000-0000-4000-8000-000000000005";
const t = (n: number) => `20000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;
const o = (n: number) => `20000000-0000-4000-8000-0000000002${String(n).padStart(2, "0")}`;
const a = (n: number) => `20000000-0000-4000-8000-0000000003${String(n).padStart(2, "0")}`;

function profile(): KidProfileDto {
  return { childId, displayName: "Ola", avatarKey: "fox", recordingMode: "hold" };
}

function lessonDeck(): KidDeckDto {
  return {
    deckId, title: "Present Simple", itemCount: 0, independentlyRecalledCount: 0, testDate: null,
    recommended: true, mockTestAvailable: true, activeSession: null, kind: "lesson", subjectTitle: "Język angielski",
  };
}

function mockSession(): SessionDto {
  return {
    mode: "mock_test", sessionId, childId, deckId, deckVersionId: versionId, policyId: "lesson-default",
    microphoneEnabled: false, state: "active", taskBudget: 2, tasksIssued: 0, assessedTasksIssued: 0,
    startedAt: "2026-10-12T10:00:00.000Z", resumed: false,
  };
}

const base = (taskId: string, exerciseType: TaskDto["exerciseType"]) => ({
  taskId, sessionId, ordinal: 0, exerciseType, direction: null, state: "issued" as const, remainingAssessed: 1,
});

// Pula bogata: dwa różne typy ćwiczeń z opcjami (uwaga 17A: zdegenerowane
// lesson_short_answer bez opcji nie da się odpowiedzieć jako wybór).
const choiceTask: TaskDto = {
  ...base(t(1), "lesson_choice"),
  prompt: { kind: "lesson_choice", instructionPl: "Wybierz właściwą formę", stem: "He ___ football every day.",
    options: [{ id: o(1), text: "play" }, { id: o(2), text: "plays" }] },
};
const gapTask: TaskDto = {
  ...base(t(2), "lesson_gap"),
  prompt: { kind: "lesson_gap", instructionPl: "Uzupełnij lukę", stemWithGap: "She ___ TV." },
};

// W kartkówce finalizacja ZAWSZE terminalna, feedback = null, stepId = null.
const terminal = (attemptId: string, taskId: string, modality: AttemptDto["modality"]): AttemptDto => ({
  attemptId, taskId, state: "completed", modality, feedback: null, taskState: "answered", stepId: null,
  receivedAt: "2026-10-12T10:00:01.000Z", completedAt: "2026-10-12T10:00:01.000Z",
});

const lessonSummary: LessonMockTestSummaryDto = {
  sessionId, deckId, state: "completed", complete: true, taskBudget: 2, answeredCount: 2,
  solutions: [
    { taskId: t(1), objectiveId: "obj-s", titlePl: "-s w 3. osobie", exerciseType: "lesson_choice",
      prompt: "He ___ football every day.", childAnswer: "plays", correctAnswer: "plays", outcome: "correct" },
    { taskId: t(2), objectiveId: "obj-s", titlePl: "-s w 3. osobie", exerciseType: "lesson_gap",
      prompt: "She ___ TV.", childAnswer: "watch", correctAnswer: "watches", outcome: "incorrect" },
  ],
};

const summary: SessionSummaryDto = {
  sessionId, state: "ended", tasksIssued: 2, assessedTasksIssued: 2,
  independentSuccesses: { recall: 0, spelling: 0 }, practiceItems: [], endedAt: "2026-10-12T10:01:00.000Z",
};

async function openLessonMock(page: Page): Promise<void> {
  await installKidUiFixture(page, {
    profiles: [profile()],
    decks: [lessonDeck()],
    session: mockSession(),
    tasks: [choiceTask, gapTask, null],
    attempts: [terminal(a(1), t(1), "choice"), terminal(a(2), t(2), "text")],
    lessonMockSummary: lessonSummary,
    summary,
  });
  await page.goto("/");
}

test("child solves a lesson mock test with no feedback, then reviews per-task answers", async ({ page }, testInfo) => {
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 390, height: 844 });

  // Dowód braku feedbacku w trakcie: żaden /attempts nie niesie feedbacku ani stepId.
  const leaks: string[] = [];
  page.on("response", (response) => {
    if (!/\/tasks\/[^/]+\/attempts$/.test(new URL(response.url()).pathname)) return;
    void response.text().then((body) => {
      const dto = JSON.parse(body) as { feedback: unknown; stepId: unknown };
      if (dto.feedback !== null) leaks.push("feedback not null");
      if (dto.stepId !== null) leaks.push("stepId not null");
    }).catch(() => undefined);
  });

  await openLessonMock(page);
  await page.getByTestId("kid-profile").click();

  // Lista zestawów: lekcja z przyciskiem „Próbna kartkówka".
  await expect(page.getByTestId("kid-deck-card")).toHaveAttribute("data-kind", "lesson");
  await page.getByTestId("kid-mock-start").click();

  // Ekran gotowości → start; w kartkówce brak nagrywania i brak feedbacku.
  await page.getByTestId("kid-mock-confirm").click();
  await expect(page.getByTestId("kid-record")).toHaveCount(0);

  // Zadanie 1 (wybór) → bez karty wyniku przechodzi dalej.
  await page.getByTestId("kid-option").filter({ hasText: "plays" }).click();
  await expect(page.getByTestId("kid-feedback")).toHaveCount(0);

  // Zadanie 2 (luka) → odpowiedź tekstowa, nadal bez feedbacku.
  await expect(page.getByTestId("kid-lesson-gap")).toBeVisible();
  await page.getByTestId("kid-lesson-gap-input").fill("watch");
  await page.getByTestId("kid-lesson-check").click();
  await expect(page.getByTestId("kid-feedback")).toHaveCount(0);

  // Omówienie po zamknięciu: wynik prosty + lista slotów z odpowiedzią dziecka i poprawną.
  await expect(page.getByTestId("kid-lesson-mock-summary")).toBeVisible();
  await expect(page.getByTestId("kid-lesson-mock-score")).toContainText("1/2 · 50%");
  await expect(page.getByTestId("kid-lesson-mock-solution")).toHaveCount(2);
  await expect(page.locator('[data-testid="kid-lesson-mock-solution"][data-status="correct"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="kid-lesson-mock-solution"][data-status="incorrect"]')).toHaveCount(1);
  await expect(page.getByTestId("kid-lesson-mock-summary")).toContainText("He ___ football every day.");
  await expect(page.getByTestId("kid-lesson-mock-summary")).toContainText("Poprawna odpowiedź: watches");
  // Zrzut po asercjach: gwiazdki wyniku kończą wtedy animację wejścia.
  await page.screenshot({ path: testInfo.outputPath("lesson-mock-summary.png"), fullPage: true });

  expect(leaks, leaks.join("; ")).toHaveLength(0);
});

async function enterParent(page: Page): Promise<void> {
  await page.goto("/parent");
  await fillParentAuth(page);
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("tab-decks")).toBeVisible();
}

const report: LessonMockTestReportDto = {
  sessionId, complete: true, taskBudget: 2, startedAt: "2026-10-12T10:00:00.000Z", endedAt: "2026-10-12T10:05:00.000Z",
  objectives: [{
    objectiveId: "obj-s", titlePl: "-s w 3. osobie", total: 2, correct: 1, incorrect: 1, unassessed: 0, skipped: 0, modelGraded: 1,
    errorCategories: [{ category: "missing_ending", labelPl: "Brak końcówki -s", count: 1 }],
    // Wymiar precyzji odpowiedzi otwartych (Etap 5) — panel pokazuje go pod wynikiem celu.
    school: {
      knowledge: { correct: 1, partial: 1, incorrect: 0 }, precision: { concise: 1, verbose: 1, unfocused: 0 },
      formViolations: 1, missingElements: [{ text: "roślina wykorzystuje światło", count: 1 }],
    },
  }],
};

test("parent sees the per-objective lesson mock-test report in the supervision panel", async ({ page }) => {
  test.setTimeout(240_000);
  await enterParent(page);

  // Dziecko (panel nadzoru potrzebuje wybranego dziecka).
  await page.getByTestId("tab-children").click();
  await page.getByTestId("child-name").fill("Raport dziecko");
  await page.getByTestId("child-add").click();

  // Zaślep raport kartkówki lekcji (per cel) — endpoint 17A współdzielony z rozgałęzieniem po rodzaju.
  await page.route(/\/api\/v1\/parent\/mock-tests\?/, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([report]) });
  });
  // Postęp/werdykty puste, by panel nadzoru lekcji się wyrenderował bez szumu.
  await page.route(/\/api\/v1\/parent\/lessons\/[0-9a-f-]+\/progress/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route(/\/api\/v1\/parent\/lessons\/[0-9a-f-]+\/verdicts/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));

  await createAndPublishLesson(page, `Raport Present Simple ${Date.now()}`);

  await page.getByTestId("lesson-tab-children").click();

  await expect(page.getByTestId("supervision-panel")).toBeVisible();
  await expect(page.getByTestId("lesson-mock-reports")).toBeVisible();
  await expect(page.getByTestId("lesson-mock-report")).toHaveCount(1);
  await expect(page.getByTestId("lesson-mock-complete-0")).toHaveText("Ukończono zaplanowaną porcję");
  const objective = page.getByTestId("lesson-mock-objective-obj-s");
  await expect(objective).toContainText("-s w 3. osobie");
  await expect(objective).toContainText("1/2 poprawnie");
  await expect(objective).toContainText("Ocenione modelem: 1");
  await expect(objective).toContainText("Brak końcówki -s");
  const school = page.getByTestId("lesson-mock-school-obj-s");
  await expect(school).toContainText("częściowe 1");
  await expect(school).toContainText("rozwlekłe 1");
  await expect(school).toContainText("Więcej niż jedno zdanie tam, gdzie wystarczy jedno: 1");
  await expect(school).toContainText("Brakowało: roślina wykorzystuje światło (1)");
});

/** Tworzy, przegląda i PUBLIKUJE lekcję; zwraca deckId (jak w lesson-parent-supervision). */
async function createAndPublishLesson(page: Page, title: string): Promise<string> {
  await page.getByTestId("tab-decks").click();
  await openNewMaterial(page, "lesson");
  await expect(page.getByTestId("new-lesson-form")).toBeVisible();
  const objectiveCheckboxes = page.locator('[data-testid^="lesson-objective-"]');
  await expect(objectiveCheckboxes.first()).toBeVisible();
  const objectiveCount = await objectiveCheckboxes.count();
  for (let i = 0; i < objectiveCount; i++) await objectiveCheckboxes.nth(i).setChecked(i === 0);
  await page.getByTestId("lesson-material").fill(
    `Materiał ${title}. He plays football every day. She watches television in the evening. They study English daily.`,
  );
  await page.getByTestId("lesson-pool-size").fill("20");
  const created = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/v1/parent/lessons"));
  await page.getByTestId("lesson-create-submit").click();
  const deck = (await (await created).json()) as { deckId: string };
  await expect(page.getByTestId("lesson-editor")).toBeVisible();
  await expect(page.getByTestId("generation-banner")).toBeHidden({ timeout: 120_000 });
  await expect(page.locator('[data-testid^="exercise-"]').first()).toBeVisible({ timeout: 120_000 });
  await page.getByTestId("editor-title").fill(title);
  await page.getByTestId("save-lesson").click();
  await expect(page.getByTestId("editor-title")).toHaveValue(title);
  await expect(page.locator('[data-testid^="exercise-audio-state-"]')).toHaveCount(0);
  await expect(page.getByTestId("publish-lesson")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("publish-lesson").click();
  await expect(page.getByTestId("publish-status")).toBeVisible({ timeout: 120_000 });
  return deck.deckId;
}
