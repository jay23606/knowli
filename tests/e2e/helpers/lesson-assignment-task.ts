import { expect, type Page } from "@playwright/test";
import type { AttemptDto, TaskDto } from "@learning/contracts";
import type { KidUiFixture } from "./kid-ui-fixture";

/**
 * Zaślepiona w przeglądarce sesja treningowa lekcji z jednym zadaniem
 * przypisań („Połącz w pary”, „Pogrupuj”, „Uzupełnij tekst”) i wspólne
 * przebiegi „stukaj pulę → Sprawdź” oraz „połącz pary → Sprawdź” dla
 * specyfikacji geometrii.
 */

export interface LessonSessionIds { childId: string; deckId: string; sessionId: string; versionId: string }

export function lessonTaskFixture(ids: LessonSessionIds, deck: { title: string; subjectTitle: string }, tasks: TaskDto[], attempts: AttemptDto[] = []): KidUiFixture {
  const { childId, deckId, sessionId, versionId } = ids;
  return {
    profiles: [{ childId, displayName: "Ola", avatarKey: "owl", recordingMode: "hold" }],
    decks: [{ deckId, title: deck.title, itemCount: 6, independentlyRecalledCount: 0, testDate: null,
      recommended: true, mockTestAvailable: false, activeSession: null, kind: "lesson", subjectTitle: deck.subjectTitle }],
    session: { mode: "training", sessionId, childId, deckId, deckVersionId: versionId,
      policyId: "lesson-default", microphoneEnabled: false, state: "active", taskBudget: 3, tasksIssued: 1,
      assessedTasksIssued: 1, startedAt: "2026-10-29T10:00:00.000Z", resumed: false },
    tasks,
    attempts,
  };
}

/** Zakończona próba przypisań z podanym feedbackiem (odpowiedź zaślepionego API). */
export function assignmentAttempt(attemptId: string, taskId: string, feedback: AttemptDto["feedback"]): AttemptDto {
  return {
    attemptId, taskId, state: "completed", modality: "assignment", feedback, taskState: "answered", stepId: "s1",
    receivedAt: "2026-10-29T10:00:01.000Z", completedAt: "2026-10-29T10:00:01.000Z",
  };
}

/** Profil → zestaw → zadanie widoczne w danym viewporcie (fixture zainstalowany wcześniej przez spec). */
export async function openLessonTask(page: Page, viewport: { width: number; height: number }, ready: string): Promise<void> {
  await page.setViewportSize(viewport);
  await page.goto("/");
  await page.getByTestId("kid-profile").click();
  await page.getByTestId("kid-deck").click();
  await expect(page.getByTestId(ready)).toBeVisible();
}

/** Ciała żądań POST …/tasks/:id/attempts wysłanych przez stronę. */
export function recordAttemptPosts(page: Page): unknown[] {
  const posted: unknown[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && /\/tasks\/[^/]+\/attempts$/.test(path)) posted.push(request.postDataJSON());
  });
  return posted;
}

/**
 * Stuka pierwszy element puli `count` razy: „Sprawdź” jest nieaktywne aż do
 * kompletu, potem wysyła jedną próbę. Zwraca jej przypisania.
 */
export async function tapPoolAndCheck(page: Page, optionTestId: string, count: number, posted: unknown[]): Promise<{ itemId: string; targetId: string }[]> {
  const check = page.getByTestId("kid-lesson-check");
  for (let tapped = 1; tapped <= count; tapped += 1) {
    await page.getByTestId(optionTestId).first().click();
    if (tapped < count) await expect(check).toBeDisabled();
  }
  await expect(check).toBeEnabled();
  await check.click();
  await expect.poll(() => posted.length).toBe(1);
  const body = posted[0] as { modality: string; assignments: { itemId: string; targetId: string }[] };
  expect(body.modality).toBe("assignment");
  expect(new Set(body.assignments.map((entry) => entry.targetId)).size).toBe(count);
  return body.assignments;
}

/**
 * „Połącz w pary”: łączy i-ty lewy z i-tym prawym kafelkiem (kolejność widoku)
 * dla `i < count`. „Sprawdź” jest nieaktywne aż do ostatniej pary, potem wysyła
 * jedną próbę. Zwraca jej przypisania. Kafelki tylko przez test id i `nth`:
 * kafelek z ukrytym dopowiedzeniem ma swój tekst w DOM dwa razy.
 */
export async function pairAndCheck(page: Page, count: number, posted: unknown[]): Promise<{ itemId: string; targetId: string }[]> {
  const check = page.getByTestId("kid-lesson-check");
  for (let index = 0; index < count; index += 1) {
    await page.getByTestId("kid-lesson-match-left").nth(index).click();
    await page.getByTestId("kid-lesson-match-right").nth(index).click();
    if (index < count - 1) await expect(check).toBeDisabled();
  }
  await expect(check).toBeEnabled();
  await check.click();
  await expect.poll(() => posted.length).toBe(1);
  const body = posted[0] as { modality: string; assignments: { itemId: string; targetId: string }[] };
  expect(body.modality).toBe("assignment");
  expect(new Set(body.assignments.map((entry) => entry.targetId)).size).toBe(count);
  return body.assignments;
}
