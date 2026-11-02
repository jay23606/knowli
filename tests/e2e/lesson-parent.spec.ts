import { expect, test, type Page } from "@playwright/test";
import { openNewMaterial } from "./helpers/parent-new-material";
import { randomUUID } from "node:crypto";
import { LessonDeckDtoSchema } from "@learning/contracts";
import { lessonWorld } from "../fixtures/lesson-world";
import { closeWorldDatabase, worldPool } from "./helpers/world-database";
import { loginParent } from "./helpers/parent-session";

/**
 * E2E panelu rodzica dla lekcji (fake providerzy, zadanie 12). Pełny przepływ:
 * logowanie → Nowa lekcja (Present Simple) z materiałem → generowanie (polling)
 * → przegląd pogrupowany po regułach i etapach → edycja odpowiedzi z błędem
 * walidacji (komunikat przy ćwiczeniu) i poprawką → zapis → brak pokrycia
 * (usunięcie etapu samodzielnego) → dogenerowanie → publikacja → przypisanie
 * dziecku z celem „Gramatyka" → lista pokazuje lekcję. Dodatkowo: ochrona
 * wyjścia z niezapisanymi zmianami i konflikt wersji.
 */

async function enterParent(page: Page): Promise<void> {
  await page.goto("/parent");
  await page.getByTestId("auth-secret").fill("1234");
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("tab-decks")).toBeVisible();
  await page.getByTestId("tab-decks").click();
}

async function openReadyDraft(page: Page, title: string): Promise<string> {
  await loginParent(page);
  const lesson = await lessonWorld(await worldPool(), { title, publish: false, editorReady: true });
  await page.goto("/parent");
  await page.getByTestId("tab-decks").click();
  await page.locator(`[data-deck-id="${lesson.deckId}"]`).click();
  await expect(page.getByTestId("lesson-editor")).toBeVisible();
  return lesson.deckId;
}

test.afterAll(closeWorldDatabase);

async function createLesson(
  page: Page,
  title: string,
  waitForGeneration = true,
  selectedObjectiveIds?: readonly string[],
  insertThemesOfChildId?: string,
): Promise<string> {
  await openNewMaterial(page, "lesson");
  await expect(page.getByTestId("new-lesson-form")).toBeVisible();
  // Katalog ma english_grammar → present_simple z regułami zaznaczonymi domyślnie.
  await expect(page.getByTestId("lesson-subject")).toBeVisible();
  // Domyślnie jedna reguła: cała pula trafia na nią, więc etapy spełniają minima
  // (guided≥3, productive≥4, independent≥2) i pokrycie startowo jest pełne.
  const objectiveCheckboxes = page.locator('[data-testid^="lesson-objective-"]');
  await expect(objectiveCheckboxes.first()).toBeVisible();
  const objectiveCount = await objectiveCheckboxes.count();
  for (let i = 0; i < objectiveCount; i++) {
    const id = (await objectiveCheckboxes.nth(i).getAttribute("data-testid"))!.replace("lesson-objective-", "");
    const objective = page.getByTestId(`lesson-objective-${id}`);
    const shouldBeChecked = selectedObjectiveIds ? selectedObjectiveIds.includes(id) : i === 0;
    await objective.setChecked(shouldBeChecked);
    await expect(objective).toBeChecked({ checked: shouldBeChecked });
  }
  await page.getByTestId("lesson-material").fill(
    `Materiał ${title}. He plays football every day. She watches television in the evening. They study English on Monday and Tuesday.`,
  );
  // Pula 20 na jedną regułę → guided 7 / productive 9 / independent 4 (spełnia minima),
  // a przegląd/usuwanie są lekkie.
  await page.getByTestId("lesson-pool-size").fill(selectedObjectiveIds && selectedObjectiveIds.length > 1 ? "60" : "20");
  if (insertThemesOfChildId) await page.getByTestId(`lesson-themes-insert-${insertThemesOfChildId}`).click();
  const created = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/api/v1/parent/lessons"),
  );
  await page.getByTestId("lesson-create-submit").click();
  const deck = (await (await created).json()) as { deckId: string };
  // Po utworzeniu wchodzimy do edytora i czekamy na koniec generowania (polling).
  await expect(page.getByTestId("lesson-editor")).toBeVisible();
  if (!waitForGeneration) return deck.deckId;
  await expect(page.getByTestId("generation-banner")).toBeHidden({ timeout: 120_000 });
  await expect(page.locator('[data-testid^="objective-group-"]').first()).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('[data-testid^="exercise-"]').first()).toBeVisible({ timeout: 120_000 });
  // Nadaj tytuł i zapisz, aby lista pokazywała lekcję po tytule.
  await page.getByTestId("editor-title").fill(title);
  const saved = page.waitForResponse((response) =>
    response.request().method() === "PATCH" && response.url().includes("/api/v1/parent/lesson-drafts/"),
  );
  await page.getByTestId("save-lesson").click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByTestId("save-lesson")).toBeEnabled();
  await expect(page.getByTestId("editor-title")).toHaveValue(title);
  return deck.deckId;
}

test("defaults the pool size to max(60, 12 × selected objectives)", async ({ page }) => {
  await enterParent(page);
  await openNewMaterial(page, "lesson");
  await expect(page.locator('[data-testid^="lesson-objective-"]').first()).toBeVisible();
  const objectiveCount = await page.locator('[data-testid^="lesson-objective-"]').count();
  await expect(page.getByTestId("lesson-pool-size")).toHaveValue(String(Math.max(60, 12 * objectiveCount)));
});

test("browser Back from a newly created lesson returns to the list, not to the empty form", async ({ page }) => {
  await enterParent(page);
  const deckId = await createLesson(page, `Wstecz ${randomUUID().slice(0, 8)}`, false);
  await expect(page).toHaveURL(new RegExp(`/parent/decks/${deckId}$`));
  await page.goBack();
  await expect(page).toHaveURL(/\/parent\/decks$/);
  await expect(page.getByTestId("new-lesson-form")).toHaveCount(0);
  await expect(page.locator(`[data-deck-id="${deckId}"]`)).toBeVisible();
});

test("parent can safely restart a running lesson generation", async ({ page }) => {
  await enterParent(page);
  await createLesson(page, `Restart ${randomUUID().slice(0, 8)}`, false);
  const retry = page.getByTestId("retry-stalled-generation");
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(page.getByTestId("generation-banner")).toBeHidden({ timeout: 120_000 });
  await expect(page.locator('[data-testid^="objective-group-"]').first()).toBeVisible();
  await expect(page.locator('[data-testid^="exercise-audio-state-"]')).toHaveCount(0);
});

test("generates a multi-objective Present Simple pool with Polish prompts and no audio assets", async ({ page }) => {
  const title = `Cele Present Simple ${randomUUID().slice(0, 8)}`;
  const objectiveIds = [
    "english_grammar.present_simple.question",
    "english_grammar.present_simple.negative",
    "english_grammar.present_simple.short_answers",
  ];
  await enterParent(page);
  const deckId = await createLesson(page, title, true, objectiveIds);

  for (const objectiveId of objectiveIds) {
    await expect(page.getByTestId(`objective-group-${objectiveId}`)).toBeVisible();
    await expect(page.getByTestId(`examples-${objectiveId}`)).toBeVisible();
  }
  await expect(page.locator('[data-testid^="exercise-audio-state-"]')).toHaveCount(0);

  const response = await page.request.get(`/api/v1/parent/lessons/${deckId}`);
  expect(response.ok()).toBeTruthy();
  const deck = LessonDeckDtoSchema.parse(await response.json());
  expect(deck.draft?.objectiveIds).toEqual(expect.arrayContaining(objectiveIds));
  expect(deck.draft?.assets).toEqual([]);
  for (const objectiveId of objectiveIds) {
    expect(deck.draft?.examples[objectiveId]?.length).toBeGreaterThan(0);
    const exercises = deck.draft!.exercises.filter((exercise) => exercise.objectiveId === objectiveId);
    expect(exercises.length).toBeGreaterThanOrEqual(9);
    // Ćwiczenie wyboru ze słuchu nie ma polecenia (jest stałe w Kid UI).
    expect(exercises.filter((exercise) => exercise.exerciseType !== "lesson_listen_choice").every((exercise) => exercise.instructionPl?.length)).toBe(true);
  }
  expect(deck.draft?.exercises.some((exercise) => exercise.exerciseType === "lesson_open_answer" && exercise.prompt?.startsWith("Przetłumacz"))).toBe(true);
});

test("creates a lesson, reviews it grouped by objective and stage, fixes a validation error, saves, closes coverage and publishes", async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 8);
  const childName = `Lekcyjne dziecko ${suffix}`;
  const lessonTitle = `Present Simple ${suffix}`;

  await enterParent(page);
  // Create the reusable child fixture through the API; this keeps this editor
  // flow focused on lesson generation, review, publishing, and assignment UI.
  const childResponse = await page.request.post("/api/v1/parent/children", {
    data: { displayName: childName, avatarKey: "fox", birthYear: 2018, canRead: false },
  });
  expect(childResponse.status(), await childResponse.text()).toBe(201);
  const child = await childResponse.json() as { id: string };
  const childId = child.id;
  // Refresh the parent snapshot so the editor's assignment list sees the API-seeded profile.
  await page.reload();
  await page.getByTestId("tab-decks").click();
  await createLesson(page, lessonTitle);

  // Przegląd pogrupowany po etapach obecny.
  await expect(page.locator('[data-testid^="stage-"]').first()).toBeVisible();
  await expect(page.locator('[data-testid^="exercise-type-"]').first()).toBeVisible();

  // Edycja ćwiczenia tekstowego: wyczyść „element sprawdzany" → błąd walidacji
  // domenowej przy tym ćwiczeniu (focus musi być niepusty dla typów tekstowych).
  const objectiveGroupEarly = page.locator('[data-testid^="objective-group-"]').first();
  const objId = (await objectiveGroupEarly.getAttribute("data-testid"))!.replace("objective-group-", "");
  const productiveStage = page.getByTestId(`stage-${objId}-productive`);
  const firstProductive = productiveStage.locator('[data-testid^="exercise-"]').first();
  const exerciseTestId = (await firstProductive.getAttribute("data-testid"))!; // exercise-<index>
  const idx = exerciseTestId.replace("exercise-", "");
  // karta ćwiczenia domyślnie w podglądzie (szkic 6b) — pola po „Edytuj”
  await page.getByTestId(`exercise-edit-${idx}`).click();
  const originalFocus = await page.getByTestId(`exercise-focus-${idx}`).inputValue();
  await page.getByTestId(`exercise-focus-${idx}`).fill("");
  await page.getByTestId("save-lesson").click();
  await expect(page.getByTestId(`exercise-errors-${idx}`)).toBeVisible();
  // Poprawka: przywróć element sprawdzany.
  await page.getByTestId(`exercise-focus-${idx}`).fill(originalFocus);
  await page.getByTestId("save-lesson").click();
  await expect(page.getByTestId(`exercise-errors-${idx}`)).toHaveCount(0);

  // Doprowadź do braku pokrycia: usuń wszystkie ćwiczenia etapu samodzielnego.
  const objectiveGroup = page.locator('[data-testid^="objective-group-"]').first();
  const objectiveId = (await objectiveGroup.getAttribute("data-testid"))!.replace("objective-group-", "");
  const independentStage = page.getByTestId(`stage-${objectiveId}-independent`);
  // „Usuń ćwiczenie” jest w menu ⋯ karty
  const menus = independentStage.locator('[data-testid^="exercise-menu-"]');
  while (await menus.count()) {
    await menus.first().click();
    await page.locator('[data-testid^="exercise-remove-"]').click();
  }
  await page.getByTestId("save-lesson").click();
  // Pokrycie pokazuje brak etapu samodzielnego; publikacja zablokowana.
  await expect(page.getByTestId("coverage-gaps")).toBeVisible();
  await expect(page.getByTestId("publish-lesson")).toBeDisabled();

  // Dogeneruj dla reguły, aby domknąć brak (polling do końca generowania).
  await page.getByTestId(`regen-open-${objectiveId}`).click();
  await page.getByTestId(`regen-count-${objectiveId}`).fill("12");
  await page.getByTestId(`regen-submit-${objectiveId}`).click();
  await expect(page.getByTestId("generation-banner")).toBeHidden({ timeout: 120_000 });
  // Pokrycie domknięte → publikacja odblokowana.
  await expect(page.getByTestId("publish-lesson")).toBeEnabled({ timeout: 120_000 });
  await expect(page.getByTestId("coverage-ok")).toBeVisible();

  // Lekcje gramatyki nie tworzą audio odpowiedzi; publikacja zależy od treści i pokrycia.
  await expect(page.locator('[data-testid^="exercise-audio-state-"]')).toHaveCount(0);

  // Publikacja (odblokowana po domknięciu pokrycia).
  await page.getByTestId("publish-lesson").click();
  await expect(page.getByTestId("publish-status")).toBeVisible({ timeout: 120_000 });

  // Przypisanie z celem kartkówki „Gramatyka".
  await page.getByTestId("lesson-tab-children").click();
  const assignRow = page.locator('[data-testid^="assign-row-"]').filter({ hasText: childName });
  await expect(assignRow.locator('[data-testid^="non-reader-lesson-warning-"]')).toContainText("może wymagać czytania");
  await assignRow.getByTestId("mock-enable").check();
  await expect(assignRow.getByTestId("mock-goal-lesson")).toContainText("Gramatyka");
  await assignRow.locator('[data-testid^="assign-submit-"]').click();
  await expect(page.locator('[data-testid^="assignment-row-"]').filter({ hasText: childName })).toBeVisible();

  // Lista zestawów pokazuje lekcję z etykietą rodzaju.
  await page.getByTestId("editor-back").click();
  const lessonRow = page.locator('[data-testid^="deck-row-"]').filter({ hasText: lessonTitle });
  await expect(lessonRow).toBeVisible();
  await expect(lessonRow.locator('[data-testid^="deck-kind-"]')).toHaveText("Lekcja");

  // Lekcja opublikowana trafia do Kid API przypisanego dziecka.
  const kidDecks = await request.get(`/api/v1/kid/decks?childId=${childId}`);
  expect(kidDecks.ok()).toBeTruthy();
});

test("guards against leaving the lesson editor with unsaved changes", async ({ page }) => {
  const lessonTitle = `Ochrona ${randomUUID().slice(0, 8)}`;
  await openReadyDraft(page, lessonTitle);
  await page.getByTestId("editor-title").fill(`${lessonTitle} zmienione`);
  // Próba wyjścia z brudnym formularzem → dialog ochrony.
  await page.getByTestId("editor-back").click();
  await expect(page.getByTestId("leave-editor-dialog")).toBeVisible();
  await page.getByTestId("leave-editor-stay").click();
  await expect(page.getByTestId("lesson-editor")).toBeVisible();
});

test("shows a version conflict when the draft changed in another window", async ({ page, context }) => {
  const lessonTitle = `Konflikt ${randomUUID().slice(0, 8)}`;
  const deckId = await openReadyDraft(page, lessonTitle);

  // Lokalna zmiana zamraża bazę formularza przed zapisem drugiego okna.
  await page.getByTestId("editor-title").fill(`${lessonTitle} lokalnie`);

  // Drugie okno tej samej sesji (ta sama przeglądarka/cookies) edytuje i zapisuje
  // szkic → podbija editNumber. Najnowsza lekcja jest pierwsza na liście.
  const other = await context.newPage();
  await other.goto("/parent");
  await other.getByTestId("tab-decks").click();
  await other.locator(`[data-deck-id="${deckId}"]`).click();
  await expect(other.getByTestId("lesson-editor")).toBeVisible();
  await other.getByTestId("editor-title").fill(`${lessonTitle} zdalnie`);
  const remoteSaved = other.waitForResponse((response) =>
    response.request().method() === "PATCH" && response.url().includes("/api/v1/parent/lesson-drafts/"),
  );
  await other.getByTestId("save-lesson").click();
  const remoteResponse = await remoteSaved;
  expect(remoteResponse.status(), await remoteResponse.text()).toBe(200);
  await expect(other.getByTestId("editor-title")).toHaveValue(`${lessonTitle} zdalnie`);
  await other.close();

  // Pierwsze okno zapisuje na nieaktualnym editNumber → konflikt.
  const staleSave = page.waitForResponse((response) =>
    response.request().method() === "PATCH" && response.url().includes("/api/v1/parent/lesson-drafts/"),
  );
  await page.getByTestId("save-lesson").click();
  expect((await staleSave).status()).toBe(409);
  await expect(page.getByTestId("lesson-conflict-panel")).toBeVisible();
  await page.getByTestId("conflict-load-remote").click();
  await expect(page.getByTestId("lesson-conflict-panel")).toHaveCount(0);
  await expect(page.getByTestId("editor-title")).toHaveValue(`${lessonTitle} zdalnie`);
});

test("keeps the lesson editor usable at phone and desktop widths", async ({ page }, testInfo) => {
  const lessonTitle = `Mobile ${randomUUID().slice(0, 8)}`;
  await openReadyDraft(page, lessonTitle);
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await expect(page.getByTestId("save-lesson")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`lesson-editor-${viewport.width}.png`), fullPage: true });
  }
});


test("parent edits an AI example before publishing: change is sent in PATCH.examples and persists (P2-10)", async ({ page }) => {
  const lessonTitle = `Przyklady ${randomUUID().slice(0, 8)}`;
  const deckId = await openReadyDraft(page, lessonTitle);

  // Sekcja przykładów AI jest obecna; przykłady są EDYTOWALNE (wym. 3.3), nie read-only.
  const examplesSection = page.getByTestId("lesson-examples");
  await expect(examplesSection).toBeVisible();
  const firstObjectiveBlock = examplesSection.locator('[data-testid^="examples-"]').first();
  await expect(firstObjectiveBlock).toBeVisible();
  const objectiveId = (await firstObjectiveBlock.getAttribute("data-testid"))!.replace("examples-", "");
  const exampleInput = page.getByTestId(`example-line-${objectiveId}-0`);
  await expect(exampleInput).toBeVisible();
  const previews = page.getByTestId(`lesson-card-preview-${objectiveId}`);
  await expect(previews.first()).toBeVisible();
  // The ready fixture has a deterministic first exercise ("Dodaj -s"); do not
  // depend on which generated example happened to appear first in a worker run.
  await expect(previews.first()).toContainText("Dodaj -s");

  const corrected = `He plays football every day. ${randomUUID().slice(0, 6)}`;
  await exampleInput.fill(corrected);
  await expect(previews.last()).toContainText(corrected);
  await expect(page.getByTestId(`example-add-${objectiveId}`)).toBeVisible();
  await page.getByTestId(`example-add-${objectiveId}`).click();
  const added = "We work, and we learn.";
  await page.getByTestId(`example-line-${objectiveId}-1`).fill(added);
  await expect(previews.last()).toContainText(added);

  // Zapis wysyła poprawione przykłady w PATCH.examples.
  const patchPromise = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && /\/api\/v1\/parent\/lesson-drafts\//.test(r.url()),
  );
  await page.getByTestId("save-lesson").click();
  const patch = await patchPromise;
  expect(patch.status(), await patch.text()).toBe(200);
  const body = await patch.json() as { examples?: Record<string, string[]> };
  expect(body.examples).toBeTruthy();
  expect(body.examples![objectiveId]).toContain(corrected);
  expect(body.examples![objectiveId]).toContain(added);

  // Przeładowanie edytora pokazuje poprawioną treść przykładu (trwałość).
  // Wejście od nowa (jak w teście konfliktu) — wiersz po deckId, lista jest pogrupowana.
  await page.goto("/parent");
  await page.getByTestId("tab-decks").click();
  await page.locator(`[data-deck-id="${deckId}"]`).click();
  await expect(page.getByTestId("lesson-editor")).toBeVisible();
  await expect(page.getByTestId(`example-line-${objectiveId}-0`)).toHaveValue(corrected);
});

test("sentence themes: inserted from the child profile into a new lesson, shown in the editor and removable with a draft patch (#197)", async ({ page }) => {
  const suffix = randomUUID().slice(0, 8);
  const lessonTitle = `Tematy zdan ${suffix}`;
  const themes = ["piłka nożna", "Minecraft"];
  await enterParent(page);
  // Profil z zainteresowaniami (UI profilu pokrywa spec parent-children; tu zasiew przez API).
  const childResponse = await page.request.post("/api/v1/parent/children", {
    data: { displayName: `Tematy ${suffix}`, avatarKey: "fox", birthYear: 2018, canRead: false },
  });
  expect(childResponse.status(), await childResponse.text()).toBe(201);
  const childId = (await childResponse.json() as { id: string }).id;
  const profile = await page.request.patch(`/api/v1/parent/children/${childId}`, { data: { interests: themes } });
  expect(profile.status(), await profile.text()).toBe(200);
  await page.reload();
  await page.getByTestId("tab-decks").click();

  const patchBodies: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && /\/api\/v1\/parent\/lesson-drafts\//.test(request.url())) {
      patchBodies.push(request.postDataJSON() as Record<string, unknown>);
    }
  });
  const deckId = await createLesson(page, lessonTitle, true, undefined, childId);

  // Wiersz tematów w edytorze po wygenerowaniu; zwykły zapis (tytuł) nie wysłał interests.
  const line = page.getByTestId("lesson-themes-line");
  await expect(line).toContainText(`Tematy zdań: ${themes.join(", ")}`);
  expect(patchBodies.length).toBeGreaterThan(0);
  expect(patchBodies.every((body) => !("interests" in body))).toBe(true);
  const stored = LessonDeckDtoSchema.parse(await (await page.request.get(`/api/v1/parent/lessons/${deckId}`)).json());
  expect(stored.draft?.interests).toEqual(themes);

  // „Usuń tematy” oznacza edytor jako zmieniony; zapis wysyła interests: [].
  await page.getByTestId("lesson-themes-remove").click();
  await expect(line).toHaveCount(0);
  const patchResponse = page.waitForResponse((response) =>
    response.request().method() === "PATCH" && response.url().includes("/api/v1/parent/lesson-drafts/"),
  );
  await page.getByTestId("save-lesson").click();
  const patch = await patchResponse;
  expect(patch.status(), await patch.text()).toBe(200);
  expect(patch.request().postDataJSON()).toMatchObject({ interests: [] });
  await expect(page.getByTestId("save-lesson")).toBeEnabled();

  // Po przeładowaniu wiersza nie ma, a szkic w API nie ma tematów.
  await page.goto("/parent");
  await page.getByTestId("tab-decks").click();
  await page.locator(`[data-deck-id="${deckId}"]`).click();
  await expect(page.getByTestId("lesson-editor")).toBeVisible();
  await expect(page.locator('[data-testid^="objective-group-"]').first()).toBeVisible();
  await expect(page.getByTestId("lesson-themes-line")).toHaveCount(0);
  const after = LessonDeckDtoSchema.parse(await (await page.request.get(`/api/v1/parent/lessons/${deckId}`)).json());
  expect(after.draft?.interests).toBeUndefined();
});
