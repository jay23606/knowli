import { expect, test, type Page } from "@playwright/test";
import { messages } from "@learning/contracts";

/**
 * Edytor lekcji na Mantine (plan 2026-10-29-parent-ui-mantine, faza 6b;
 * szkic zaakceptowany 2026-10-29, decyzje A–D): zakładki „Ćwiczenia” /
 * „Dzieci i postęp”, reguły i etapy jako grupy rozwijane (telefon: pierwsza
 * reguła rozwinięta, etapy zwinięte; desktop: wszystko rozwinięte), karta
 * ćwiczenia jako podgląd z „Edytuj”, błąd walidacji rozwija swoją grupę,
 * dogenerowanie w oknie, przypięty pasek akcji, tryb ciemny. API rodzica
 * zaślepione w przeglądarce.
 */

const deckId = "00000000-0000-4000-8000-0000000000f1";
const draftId = "00000000-0000-4000-8000-0000000000f2";
const publishedId = "00000000-0000-4000-8000-0000000000f3";
const childId = "00000000-0000-4000-8000-0000000000c1";
const OBJ_A = "english_grammar.present_simple.third_person_s";
const OBJ_B = "english_grammar.present_simple.negative";
const uuid = (n: number) => `00000000-0000-4000-8000-0000000003${String(n).padStart(2, "0")}`;

const choice = (n: number, objectiveId: string) => ({
  id: uuid(n), revisionId: uuid(n + 50), exerciseType: "lesson_choice", objectiveId,
  instructionPl: "Wybierz poprawną formę.", stem: `He ___ football (${n}).`, answer: "plays",
  acceptedAnswers: [], focus: ["-s"], options: [{ id: "a", text: "plays" }, { id: "b", text: "play" }], correctOption: "a",
});
const gap = (n: number, objectiveId: string) => ({
  id: uuid(n), revisionId: uuid(n + 50), exerciseType: "lesson_gap", objectiveId,
  instructionPl: "Uzupełnij zdanie.", stem: `She ___ (watch) TV (${n}).`, answer: "watches", acceptedAnswers: [], focus: ["-es"],
});

const version = (id: string, status: "draft" | "published", editNumber: number) => ({
  id, deckId, editNumber, status, title: "Present Simple", subjectId: "english_grammar", topicId: "present_simple", topicVersion: 1,
  objectiveIds: [OBJ_A, OBJ_B],
  examples: { [OBJ_A]: ["He plays football every day."], [OBJ_B]: ["He doesn't play."] },
  exercises: [choice(1, OBJ_A), gap(2, OBJ_A), choice(3, OBJ_B), gap(4, OBJ_B)],
  assets: [], rejectedCount: 0, coverage: [],
});

const lesson = {
  id: deckId, title: "Present Simple", state: "published", sessionTaskBudget: 20,
  draft: { ...version(draftId, "draft", 2), interests: ["dinozaury", "Minecraft"] }, published: version(publishedId, "published", 1), generation: null,
  assignments: [{ childId, displayName: "Ala", testDate: "2026-11-12", testGoals: null, mockTestTaskCount: 10, active: true }],
  grading: { available: true, model: "test-grader" },
};

const catalog = {
  subjects: [{
    id: "english_grammar", titlePl: "Gramatyka angielska", creation: "catalog", subjectTitleRequired: false,
    topics: [{
      id: "present_simple", version: 1, titlePl: "Present Simple",
      objectives: [
        { id: OBJ_A, titlePl: "Końcówka -s w 3. osobie", cards: [{ title: "Jak dodajemy -s", body: "Do czasownika dodajemy -s. {{examples}}" }] },
        { id: OBJ_B, titlePl: "Przeczenia z doesn't", cards: [{ title: "Przeczenia", body: "Używamy doesn't. {{examples}}" }] },
      ],
    }],
  }],
};

interface Calls { requests: Array<{ method: string; path: string; body: unknown }> }

async function openLesson(page: Page, options: { data?: typeof lesson } = {}): Promise<Calls> {
  const data = options.data ?? lesson;
  const calls: Calls = { requests: [] };
  await page.route("**/api/v1/parent/**", (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    calls.requests.push({ method, path, body: method === "GET" ? null : request.postDataJSON() });
    if (path.endsWith("/login")) return route.fulfill({ json: { authenticated: true, setupRequired: false } });
    if (path.endsWith("/lesson-catalog")) return route.fulfill({ json: catalog });
    if (path.endsWith("/children")) return route.fulfill({ json: [{ id: childId, displayName: "Ala", avatarKey: "fox", recordingMode: "hold", canRead: true, interests: [] }] });
    if (path.endsWith("/decks")) return route.fulfill({ json: [{ deckId, title: lesson.title, state: "published", kind: "lesson", editableVersionId: draftId, publishedVersionId: publishedId }] });
    if (path.endsWith(`/lessons/${deckId}`)) return route.fulfill({ json: data });
    if (method === "POST" && path.endsWith(`/decks/${deckId}/archive`)) return route.fulfill({ status: 204, body: "" });
    if (method === "PATCH" && path.endsWith(`/lesson-drafts/${draftId}`)) {
      return route.fulfill({ status: 400, json: {
        code: "validation", message: "Popraw ćwiczenia.", retryable: false, requestId: "r",
        details: { exercises: [{ index: 3, errors: ["Odpowiedź nie może być pusta."] }] },
      } });
    }
    if (method === "POST" && path.endsWith(`/lesson-drafts/${draftId}/regenerate`)) {
      return route.fulfill({ status: 202, json: { generationRunId: uuid(99), deckId } });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto(`/parent/decks/${deckId}`);
  await expect(page.getByTestId("lesson-editor")).toBeVisible();
  await expect(page.locator('[data-testid^="objective-group-"]').first()).toBeVisible();
  return calls;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

test("telefon: pierwsza reguła rozwinięta, etapy zwinięte, pasek nad nawigacją, cele ≥ 44 px", async ({ page }) => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport);
    await openLesson(page);
    await expectNoHorizontalOverflow(page);

    // pierwsza reguła: karta wyjaśnienia widoczna, etapy zwinięte; druga reguła zwinięta
    await expect(page.getByTestId(`examples-${OBJ_A}`)).toBeVisible();
    await expect(page.getByTestId("exercise-0")).toBeHidden();
    await expect(page.getByTestId(`examples-${OBJ_B}`)).toBeHidden();
    await page.getByTestId(`stage-${OBJ_A}-guided`).getByRole("button").first().click();
    await expect(page.getByTestId("exercise-0")).toBeVisible();
    // podgląd karty: treść i poprawna odpowiedź, bez pól
    await expect(page.getByTestId("exercise-0")).toContainText("✓ plays");
    await expect(page.getByTestId("exercise-instruction-0")).toHaveCount(0);

    const bar = (await page.getByTestId("editor-action-bar").boundingBox())!;
    const nav = (await page.getByTestId("tab-decks").boundingBox())!;
    expect(bar.y + bar.height).toBeLessThanOrEqual(nav.y + 1);
    for (const id of ["editor-back", "lesson-menu", "lesson-tab-children", `objective-menu-${OBJ_A}`, "exercise-menu-0", "exercise-edit-0", "save-lesson", "publish-lesson", "lesson-themes-remove"]) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.height, id).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width, id).toBeLessThanOrEqual(viewport.width + 0.5);
    }
    // tematy zdań w szkicu: wiersz z przyciskiem usunięcia i notką o gotowych ćwiczeniach
    await expect(page.getByTestId("lesson-themes-line")).toContainText("dinozaury, Minecraft");
    await expect(page.getByTestId("lesson-themes-remove-hint")).toHaveText(messages.lessons.themesRemoveHint);
    await page.getByTestId("exercise-edit-0").click();
    await expect(page.getByTestId("exercise-option-0-1")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});

test("desktop: wszystko rozwinięte, edycja karty zostawia ją otwartą i blokuje publikację", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openLesson(page);
  for (const index of [0, 1, 2, 3]) await expect(page.getByTestId(`exercise-${index}`)).toBeVisible();
  await expect(page.getByTestId("publish-lesson")).toBeEnabled();

  await page.getByTestId("exercise-edit-1").click();
  await page.getByTestId("exercise-answer-1").fill("watched");
  // lekcja bez audio: znacznik zmiany bez wzmianki o mediach
  await expect(page.getByTestId("exercise-1")).toContainText(messages.lessons.exerciseChanged);
  // zmieniona karta nie daje się zwinąć
  await expect(page.getByTestId("exercise-collapse-1")).toHaveCount(0);
  await expect(page.getByTestId("publish-lesson")).toBeDisabled();
  await expect(page.getByTestId("publish-blocked-reason")).toContainText(messages.decks.unsavedChanges);
  // dogenerowanie zablokowane przy niezapisanych zmianach
  await expect(page.getByTestId(`regen-open-${OBJ_A}`)).toBeDisabled();
});

test("błąd walidacji przy ćwiczeniu rozwija jego regułę i etap na telefonie", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLesson(page);
  await page.getByTestId("editor-title").fill("Present Simple — poprawki");
  await page.getByTestId("save-lesson").click();
  await expect(page.getByTestId("exercise-errors-3")).toBeVisible();
  await expect(page.getByTestId("exercise-errors-3")).toContainText("Odpowiedź nie może być pusta.");
  // karta z błędem w trybie edycji
  await expect(page.getByTestId("exercise-answer-3")).toBeVisible();
  await expect(page.getByTestId("api-error")).toContainText(messages.errors.validation);
});

test("zakładka „Dzieci i postęp”: przypisanie z terminem, nadzór; ćwiczenia ukryte", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLesson(page);
  await page.getByTestId("lesson-tab-children").click();
  await expect(page.getByTestId("assign-row-0")).toBeVisible();
  await expect(page.getByTestId("assignment-row-0")).toContainText("12.11.2026");
  await expect(page.getByTestId("supervision-panel")).toBeVisible();
  await expect(page.getByTestId(`objective-group-${OBJ_A}`)).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  // usunięcie przypisania wymaga potwierdzenia w oknie (bez okna przeglądarki)
  page.on("dialog", (dialog) => { throw new Error(`niespodziewane okno przeglądarki: ${dialog.message()}`); });
  await page.getByTestId("unassign-submit-0").click();
  await expect(page.getByTestId("unassign-confirm")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("unassign-confirm")).toHaveCount(0);
});

test("dogenerowanie: okno z liczbą (domyślnie 4) wysyła polecenie dla reguły", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const calls = await openLesson(page);
  await page.getByTestId(`regen-open-${OBJ_B}`).click();
  await expect(page.getByTestId(`regen-count-${OBJ_B}`)).toHaveValue("4");
  await page.getByTestId(`regen-count-${OBJ_B}`).fill("6");
  await page.getByTestId(`regen-submit-${OBJ_B}`).click();
  await expect.poll(() => calls.requests.filter((r) => r.method === "POST" && r.path.endsWith("/regenerate")).length).toBe(1);
  const body = calls.requests.find((r) => r.path.endsWith("/regenerate"))!.body as Record<string, unknown>;
  expect(body).toMatchObject({ objectiveId: OBJ_B, count: 6 });
});

test("tryb ciemny obejmuje edytor lekcji", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await openLesson(page);
  await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "dark");
  for (const id of ["exercise-0", "editor-action-bar"]) {
    const background = await page.getByTestId(id).evaluate((element) => getComputedStyle(element).backgroundColor);
    const [r, g, b] = background.match(/\d+/g)!.map(Number);
    expect(r! + g! + b!, id).toBeLessThan(3 * 80);
  }
});

test("menu ⋯ lekcji: usunięcie z listy po potwierdzeniu wraca do listy bez tej lekcji", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const calls = await openLesson(page);
  await page.getByTestId("lesson-menu").click();
  await page.getByTestId("archive-lesson").click();
  const dialog = page.getByRole("dialog", { name: messages.lessons.archiveTitle });
  await expect(dialog).toBeVisible();
  expect(calls.requests.filter((r) => r.path.endsWith("/archive"))).toHaveLength(0);
  await dialog.getByRole("button", { name: messages.lessons.archive }).click();
  await expect(page).toHaveURL(/\/parent\/decks$/);
  expect(calls.requests.filter((r) => r.method === "POST" && r.path.endsWith("/archive"))).toHaveLength(1);
  // lista z serwera jeszcze pokazuje lekcję jako aktywną — panel ukrywa ją od razu
  await expect(page.locator(`[data-deck-id="${deckId}"]`)).toHaveCount(0);
});

test("rozdział angielskiego: powody odrzuceń pod licznikiem i rodzaj zagadnienia przy regule", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const WORDS = "english_chapter.d1.clothes";
  const FRAME = "english_chapter.d1.i_like";
  const card = (title: string) => [{ title, body: "Słowa z rozdziału." }, { title: `${title} 2`, body: "Zdania z rozdziału." }];
  const chapter = {
    ...version(draftId, "draft", 2),
    title: "Angielski — rozdział: Unit 1", subjectId: "english_chapter", topicId: "dynamic",
    objectiveIds: [WORDS, FRAME],
    examples: {},
    // 12 odrzuceń, z czego 8 wyjaśnia pięć wypisanych powodów — reszta to „inne powody: 4”.
    rejectedCount: 12,
    rejectedReasons: { "słowo spoza materiału: raining": 3, "zdanie bez słownictwa z materiału": 2, "inny powód": 1, "powód A": 1, "powód B": 1, "powód C": 1 },
    dynamicTopic: { titlePl: "Unit 1", objectives: [
      { id: WORDS, titlePl: "Ubrania", kind: "words", cards: card("Ubrania") },
      { id: FRAME, titlePl: "I like", kind: "frame", cards: card("I like") },
    ] },
    exercises: [choice(1, WORDS), choice(2, FRAME)],
  };
  await openLesson(page, { data: { ...lesson, draft: chapter, published: null, assignments: [] } as unknown as typeof lesson });
  await expect(page.getByTestId("rejected-count")).toContainText("12");
  // Lista jest podpisana jako powody odrzuceń przy generowaniu (słownik rozdziału i ujawnione rozwiązania), nie wszystkie odrzucenia.
  await expect(page.getByTestId("rejected-reasons-label")).toHaveText(messages.lessons.rejectedReasonsLabel);
  await expect(page.getByRole("list", { name: messages.lessons.rejectedReasonsLabel })).toBeVisible();
  // do 5 najczęstszych, malejąco; remis alfabetycznie; na końcu odrzucenia bez wypisanego powodu
  const reasons = page.getByTestId("rejected-reasons").getByRole("listitem");
  await expect(reasons).toHaveCount(6);
  await expect(reasons.nth(0)).toHaveText("słowo spoza materiału: raining ×3");
  await expect(reasons.nth(1)).toHaveText("zdanie bez słownictwa z materiału ×2");
  await expect(page.getByTestId("rejected-other")).toHaveText("inne powody: 4");
  await expect(page.getByTestId(`objective-kind-${WORDS}`)).toHaveText(messages.lessons.objectiveKind.words!);
  await expect(page.getByTestId(`objective-kind-${FRAME}`)).toHaveText(messages.lessons.objectiveKind.frame!);
  await expectNoHorizontalOverflow(page);
});

test("lekcja bez powodów odrzuceń i bez rodzaju zagadnień nie pokazuje listy ani znaczka", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLesson(page);
  await expect(page.getByTestId("rejected-reasons")).toHaveCount(0);
  await expect(page.locator('[data-testid^="objective-kind-"]')).toHaveCount(0);
});

test("zagadnienie szkolne przy 320 px: pola z przyciskami bez przepełnienia, usunięcie zagadnienia po potwierdzeniu", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const OBJ = "school.map.scale";
  const school = {
    ...version(draftId, "draft", 2),
    subjectId: "school", topicId: "map", subjectTitlePl: "Geografia", voiceTones: { styleEnabled: true },
    objectiveIds: [OBJ],
    examples: {},
    dynamicTopic: { titlePl: "Posługuję się mapą", objectives: [{ id: OBJ, titlePl: "Skala mapy", cards: [
      { title: "Skala", body: "Skala mówi, ile razy odległość na mapie jest mniejsza niż w terenie." },
      { title: "Przykład", body: "1:25 000 — 1 cm to 250 m." },
    ] }] },
    exercises: [{
      id: uuid(10), revisionId: uuid(60), exerciseType: "lesson_open_answer", objectiveId: OBJ,
      instructionPl: "Odpowiedz jednym zdaniem.", prompt: "Czym jest skala mapy?", answer: "Stosunek odległości na mapie do odległości w terenie.",
      acceptedAnswers: [], focus: [], questionType: "definition", expectedForm: "one_sentence",
      requiredElements: [{ id: "e1", text: "stosunek odległości" }, { id: "e2", text: "mapa a teren" }],
      supplementaryElements: [], commonErrors: ["myli skalę z legendą"],
      sourceRefs: [{ quote: "Skala mapy to stosunek odległości na mapie do odległości w terenie." }, { quote: "Własne wyjaśnienie", parentAdded: true }],
    }],
  };
  const calls = await openLesson(page, { data: { ...lesson, draft: school, published: null, assignments: [] } as unknown as typeof lesson });
  await expect(page.getByTestId(`examples-${OBJ}`)).toBeVisible();
  await page.getByTestId(`stage-${OBJ}-independent`).getByRole("button").first().click();
  await page.getByTestId("exercise-edit-0").click();
  // fokus przechodzi na pierwsze pole karty
  await expect(page.getByTestId("exercise-instruction-0")).toBeFocused();
  for (const id of ["exercise-required-remove-0-0", "exercise-source-remove-0-0", `dynamic-objective-remove-${OBJ}`, "exercise-required-0-0", "exercise-source-0-0"]) {
    const box = (await page.getByTestId(id).boundingBox())!;
    expect(box.x + box.width, id).toBeLessThanOrEqual(320 + 0.5);
    expect(box.width, id).toBeGreaterThan(120);
  }
  await expectNoHorizontalOverflow(page);

  // typowe błędy: spacja na końcu wiersza i nowy wiersz zostają w polu w trakcie pisania,
  // a polecenie zapisu dostaje wiersze przycięte i bez pustych
  const commonErrors = page.getByTestId("exercise-common-errors-0");
  await commonErrors.click();
  await commonErrors.press("Control+End");
  await commonErrors.pressSequentially(" ");
  await commonErrors.press("Enter");
  await commonErrors.pressSequentially("brak jednostki ");
  await expect(commonErrors).toHaveValue("myli skalę z legendą \nbrak jednostki ");
  await commonErrors.press("Enter");
  await expect(commonErrors).toHaveValue("myli skalę z legendą \nbrak jednostki \n");
  await page.getByTestId("save-lesson").click();
  await expect.poll(() => calls.requests.filter((request) => request.method === "PATCH").length).toBe(1);
  const patch = calls.requests.find((request) => request.method === "PATCH")!.body as { exercises: Array<{ commonErrors?: string[] }> };
  expect(patch.exercises[0]!.commonErrors).toEqual(["myli skalę z legendą", "brak jednostki"]);

  await page.getByTestId(`dynamic-objective-remove-${OBJ}`).click();
  await expect(page.getByTestId("dynamic-objective-remove-confirm")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("exercise-0")).toBeVisible();
  await page.getByTestId(`dynamic-objective-remove-${OBJ}`).click();
  await page.getByTestId("dynamic-objective-remove-confirm").click();
  await expect(page.getByTestId("exercise-0")).toHaveCount(0);
});

test("ćwiczenie z gotowym audio: odsłuch w menu ⋯, po zmianie zapowiedź nowych mediów", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const withAudio = {
    ...lesson,
    draft: { ...lesson.draft, assets: [{ itemRevisionId: uuid(51), role: "target_audio", state: "approved", assetId: uuid(90) }] },
  };
  await openLesson(page, { data: withAudio as unknown as typeof lesson });
  await expect(page.getByTestId("exercise-audio-state-0")).toBeVisible();
  await page.getByTestId("exercise-menu-0").click();
  await expect(page.getByTestId("exercise-play-0")).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.getByTestId("exercise-edit-0").click();
  await page.getByTestId("exercise-instruction-0").fill("Wybierz właściwą formę.");
  await expect(page.getByTestId("exercise-0")).toContainText(messages.decks.changedMediaAfterSave);
  await expect(page.getByTestId("exercise-audio-state-0")).toHaveCount(0);
});

test("Posłuchaj i wybierz: odznaka, informacja, tekst naprawy i licznik bez przepełnienia (320 px i desktop)", async ({ page }) => {
  const listen = (n: number, sentenceAudio: Record<string, string>) => ({
    id: uuid(n), revisionId: uuid(n + 50), exerciseType: "lesson_listen_choice", objectiveId: OBJ_A,
    stem: `He ___ football (${n}).`, answer: "plays", acceptedAnswers: [], focus: ["plays"],
    options: [{ id: "a", text: "plays" }, { id: "b", text: "play" }], correctOption: "a", sentenceAudio,
  });
  const withListen = {
    ...lesson,
    draft: { ...lesson.draft, exercises: [listen(1, { state: "ready", assetId: uuid(90) }), listen(2, { state: "failed" }), listen(3, { state: "pending" })] },
  };
  for (const viewport of [{ width: 320, height: 568 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(viewport);
    const calls = await openLesson(page, { data: withListen as unknown as typeof lesson });
    if (viewport.width < 600) await page.getByTestId(`stage-${OBJ_A}-guided`).getByRole("button").first().click();
    for (const index of [0, 1, 2]) {
      await expect(page.getByTestId(`exercise-type-${index}`)).toHaveText(messages.lessons.exerciseTypes.lesson_listen_choice);
      await expect(page.getByTestId(`exercise-listen-note-${index}`)).toHaveText(messages.lessons.listenChoiceNote);
      await expect(page.getByTestId(`exercise-sentence-audio-state-${index}`)).toBeVisible();
      await expect(page.getByTestId(`exercise-audio-state-${index}`)).toHaveCount(0);
    }
    await expect(page.getByTestId("exercise-sentence-audio-state-0")).toHaveText(messages.lessons.sentenceAudioState.ready!);
    await expect(page.getByTestId("exercise-sentence-audio-state-2")).toHaveText(messages.lessons.sentenceAudioState.pending!);
    // tekst naprawy tylko przy błędzie
    await expect(page.getByTestId("exercise-sentence-audio-failed-1")).toHaveText(messages.lessons.listenChoiceAudioFailed);
    await expect(page.getByTestId("exercise-sentence-audio-failed-0")).toHaveCount(0);
    await expect(page.getByTestId("exercise-sentence-audio-failed-2")).toHaveCount(0);
    // brak regeneracji i tonu lektora
    await expect(page.locator('[data-testid^="exercise-prompt-audio-"]')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    // elementy karty mieszczą się w oknie
    for (const id of ["exercise-0", "exercise-1", "exercise-menu-1", "exercise-sentence-audio-failed-1"]) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.x, id).toBeGreaterThanOrEqual(-0.5);
      expect(box.x + box.width, id).toBeLessThanOrEqual(viewport.width + 0.5);
    }
    // licznik: dwa ćwiczenia bez gotowego nagrania (błąd + w tworzeniu)
    await expect(page.getByTestId("listen-missing-audio")).toHaveText(messages.lessons.listenChoiceMissingAudioCount.replace("{n}", "2"));
    // odsłuch zdania w menu ⋯: gotowe — aktywny; w tworzeniu bez poprzedniego ujęcia — wyłączony
    await page.getByTestId("exercise-menu-0").click();
    await expect(page.getByTestId("exercise-sentence-play-0")).toBeEnabled();
    const played = page.waitForRequest((request) => new URL(request.url()).pathname === `/api/v1/media/${uuid(90)}`);
    await page.getByTestId("exercise-sentence-play-0").click();
    await played;
    await page.getByTestId("exercise-menu-2").click();
    await expect(page.getByTestId("exercise-sentence-play-2")).toBeDisabled();
    await page.keyboard.press("Escape");
    // edycja: zdanie i opcje, bez polecenia i tonu; zapis nie niesie sentenceAudio
    await page.getByTestId("exercise-edit-0").click();
    await expect(page.getByTestId("exercise-stem-0")).toBeVisible();
    await expect(page.getByTestId("exercise-option-0-1")).toBeVisible();
    await expect(page.getByTestId("exercise-instruction-0")).toHaveCount(0);
    await expect(page.getByTestId("exercise-visual-0")).toHaveCount(0);
    await expect(page.getByTestId("exercise-voice-tone-0")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await page.getByTestId("exercise-stem-0").fill("He ___ tennis.");
    // zmieniona karta traci odznakę nagrania (nowe nagranie po zapisie)
    await expect(page.getByTestId("exercise-sentence-audio-state-0")).toHaveCount(0);
    await page.getByTestId("save-lesson").click();
    await expect.poll(() => calls.requests.filter((request) => request.method === "PATCH").length).toBe(1);
    const patch = calls.requests.find((request) => request.method === "PATCH")!.body as { exercises: Array<Record<string, unknown>> };
    expect(patch.exercises[0]).toMatchObject({ exerciseType: "lesson_listen_choice", stem: "He ___ tennis.", correctOption: "a" });
    expect(JSON.stringify(patch)).not.toContain("sentenceAudio");
    expect(patch.exercises[0]).not.toHaveProperty("instructionPl");
  }
});

test("lekcja bez ćwiczeń słuchowych albo z gotowymi nagraniami nie pokazuje licznika", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openLesson(page);
  await expect(page.getByTestId("coverage-section")).toBeVisible();
  await expect(page.getByTestId("listen-missing-audio")).toHaveCount(0);
});

test("opublikowana lekcja bez szkicu: stan audio i odsłuch w menu ⋯ karty", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const publishedOnly = {
    ...lesson,
    draft: null,
    published: { ...lesson.published, assets: [{ itemRevisionId: uuid(51), role: "target_audio", state: "approved", assetId: uuid(90) }] },
  };
  await openLesson(page, { data: publishedOnly as unknown as typeof lesson });
  await expect(page.getByTestId("exercise-audio-state-0")).toBeVisible();
  await page.getByTestId("exercise-menu-0").click();
  const played = page.waitForRequest((request) => new URL(request.url()).pathname === `/api/v1/media/${uuid(90)}`);
  await page.getByTestId("exercise-play-0").click();
  await played;
  await expect(page.getByTestId("new-version")).toBeVisible();
});

test("opublikowana lekcja bez szkicu: wiersz „Tematy zdań” bez przycisku usuwania i notki", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const publishedOnly = { ...lesson, draft: null, published: { ...lesson.published, interests: ["dinozaury", "Minecraft"] } };
  await openLesson(page, { data: publishedOnly as unknown as typeof lesson });
  await expect(page.getByTestId("lesson-themes-line")).toHaveText(messages.lessons.themesLine.replace("{themes}", "dinozaury, Minecraft"));
  await expect(page.getByTestId("lesson-themes-remove")).toHaveCount(0);
  await expect(page.getByTestId("lesson-themes-remove-hint")).toHaveCount(0);
});

test.describe("telefon z klawiaturą ekranową", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("pisanie w polu chowa pasek akcji i dolną nawigację, po zamknięciu klawiatury wracają", async ({ page }) => {
    await openLesson(page);
    await page.getByTestId(`stage-${OBJ_A}-guided`).getByRole("button").first().click();
    await expect(page.getByTestId("editor-action-bar")).toBeVisible();
    await expect(page.getByTestId("tab-decks")).toBeInViewport();

    // „Edytuj” przenosi fokus na pierwsze pole karty — na telefonie otwiera się klawiatura
    await page.getByTestId("exercise-edit-0").click();
    await expect(page.getByTestId("exercise-instruction-0")).toBeFocused();
    await expect(page.getByTestId("editor-action-bar")).toBeHidden();
    await expect(page.getByTestId("tab-decks")).not.toBeInViewport();

    // przejście do kolejnego pola nie pokazuje paska na chwilę
    await page.getByTestId("exercise-stem-0").focus();
    await expect(page.getByTestId("editor-action-bar")).toBeHidden();

    // Android: klawiatura wysunięta (widoczny obszar mniejszy), potem schowana przyciskiem „wstecz” —
    // fokus zostaje w polu, a pasek i nawigacja wracają
    const setVisualViewportHeight = (height: number) => page.evaluate((value) => {
      Object.defineProperty(window.visualViewport!, "height", { configurable: true, get: () => value });
      window.visualViewport!.dispatchEvent(new Event("resize"));
    }, height);
    await setVisualViewportHeight(844 - 320);
    await expect(page.getByTestId("editor-action-bar")).toBeHidden();
    // powiększenie gestem przy otwartej klawiaturze: pomiar nieporównywalny, pasek zostaje schowany
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport!, "scale", { configurable: true, get: () => 2 });
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });
    await expect(page.getByTestId("editor-action-bar")).toBeHidden();
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport!, "scale", { configurable: true, get: () => 1 });
    });
    await setVisualViewportHeight(844);
    await expect(page.getByTestId("exercise-stem-0")).toBeFocused();
    await expect(page.getByTestId("editor-action-bar")).toBeVisible();
    await expect(page.getByTestId("tab-decks")).toBeInViewport();
    // ponowne wysunięcie klawiatury w tym samym polu znów chowa pasek
    await setVisualViewportHeight(844 - 320);
    await expect(page.getByTestId("editor-action-bar")).toBeHidden();

    await page.getByTestId("exercise-stem-0").blur();
    await expect(page.getByTestId("editor-action-bar")).toBeVisible();
    await expect(page.getByTestId("tab-decks")).toBeInViewport();
    await expect(page.getByTestId("save-lesson")).toBeEnabled();

    // błąd zapisu zostaje widoczny przy pisaniu: pasek pokazuje sam wiersz błędu, bez przycisków
    await page.getByTestId("exercise-stem-0").fill("He ___ tennis.");
    await page.getByTestId("exercise-stem-0").blur();
    await page.getByTestId("save-lesson").click();
    await expect(page.getByTestId("api-error")).toBeVisible();
    await page.getByTestId("exercise-stem-0").focus();
    await expect(page.getByTestId("api-error")).toBeInViewport();
    // znacznik zmiany w karcie (ta sama klasa co powód blokady w pasku) zostaje widoczny
    await expect(page.getByTestId("exercise-0").getByText(messages.lessons.exerciseChanged)).toBeVisible();
    await expect(page.getByTestId("save-lesson")).toBeHidden();
    await expect(page.getByTestId("tab-decks")).not.toBeInViewport();
  });
});

const EXPLANATION = "Po „he” czasownik dostaje końcówkę -s.";

/** Szkic gramatyki z wyjaśnieniem pierwszego ćwiczenia i jego gotowym nagraniem; opublikowana wersja ma to samo. */
function withExplanations(): typeof lesson {
  const explained = (v: ReturnType<typeof version>) => ({
    ...v,
    exerciseExplanations: true,
    exercises: v.exercises.map((exercise, index) => (index === 0
      ? { ...exercise, explanationPl: EXPLANATION, explanationAudio: { state: "ready", assetId: uuid(91) } }
      : exercise)),
  });
  return { ...lesson, draft: explained(lesson.draft), published: explained(lesson.published) } as unknown as typeof lesson;
}

test("szkic gramatyki: pole wyjaśnienia z licznikiem, kontrolki nagrania i patch bez nagrania", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const calls = await openLesson(page, { data: withExplanations() });
  const card = page.getByTestId("exercise-0");
  // nagranie wyjaśnienia jest w karcie także zwiniętej, z nazwą odrębną od nagrania pytania,
  // z widoczną etykietą i pod podglądem wyjaśnienia (nie na górze karty)
  await expect(card.getByTestId("lesson-explanation-audio-0")).toHaveAttribute("data-audio-state", "ready");
  await expect(card.getByTestId("lesson-explanation-audio-0-listen")).toHaveAccessibleName("Posłuchaj: wyjaśnienie — Ćwiczenie 1");
  await expect(card.getByTestId("lesson-explanation-audio-0-regenerate")).toHaveAccessibleName("Nagraj ponownie: wyjaśnienie — Ćwiczenie 1");
  const collapsedBlock = card.getByTestId("exercise-explanation-audio-0");
  await expect(collapsedBlock).toContainText(messages.lessons.explanationAudioLabel);
  await expect(card.getByRole("group", { name: messages.lessons.explanationAudioLabel })).toBeVisible();
  const previewBox = (await page.getByTestId("exercise-explanation-preview-0").boundingBox())!;
  const collapsedBox = (await collapsedBlock.boundingBox())!;
  expect(collapsedBox.y, `controls under the explanation preview: ${JSON.stringify({ previewBox, collapsedBox })}`).toBeGreaterThanOrEqual(previewBox.y + previewBox.height - 1);

  await page.getByTestId("exercise-edit-0").click();
  const field = page.getByTestId("exercise-explanation-0");
  // rozwinięta karta: etykieta i kontrolki pod polem wyjaśnienia
  const expandedBlock = card.getByTestId("exercise-explanation-audio-0");
  await expect(expandedBlock).toContainText(messages.lessons.explanationAudioLabel);
  const fieldBox = (await field.boundingBox())!;
  const expandedBox = (await expandedBlock.boundingBox())!;
  expect(expandedBox.y, `controls under the explanation field: ${JSON.stringify({ fieldBox, expandedBox })}`).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height - 1);
  await expect(card.getByTestId("lesson-explanation-audio-0")).toHaveCount(1);
  await expect(card.getByText(messages.lessons.explanationLabel)).toBeVisible();
  await expect(field).toHaveValue(EXPLANATION);
  await expect(field).toHaveAttribute("maxlength", "120");
  await expect(card).toContainText(messages.lessons.explanationHint);
  await expect(page.getByTestId("exercise-explanation-count-0")).toHaveText(`${EXPLANATION.length}/120`);
  // pole jest też w ćwiczeniu bez wyjaśnienia
  await page.getByTestId("exercise-edit-1").click();
  await expect(page.getByTestId("exercise-explanation-1")).toHaveValue("");
  await expect(page.getByTestId("exercise-explanation-count-1")).toHaveText("0/120");

  await field.fill("  Dodaj -s do czasownika.  ");
  await expect(page.getByTestId("exercise-explanation-count-0")).toHaveText("27/120");
  // zmiana tekstu unieważnia nagranie wyjaśnienia do zapisu
  await expect(card.getByTestId("lesson-explanation-audio-0")).toHaveCount(0);
  await page.getByTestId("save-lesson").click();
  await expect.poll(() => calls.requests.filter((request) => request.method === "PATCH").length).toBe(1);
  const patch = calls.requests.find((request) => request.method === "PATCH")!.body as { exercises: Array<{ explanationPl?: string }> };
  expect(patch.exercises[0]!.explanationPl).toBe("Dodaj -s do czasownika.");
  expect(patch.exercises[1]).not.toHaveProperty("explanationPl");
  expect(JSON.stringify(patch)).not.toContain("explanationAudio");
});

test("szkic szkoły (bez flagi wyjaśnień): brak pola wyjaśnienia", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openLesson(page);
  await page.getByTestId("exercise-edit-0").click();
  await expect(page.getByTestId("exercise-instruction-0")).toBeVisible();
  await expect(page.getByTestId("exercise-explanation-0")).toHaveCount(0);
  await expect(page.getByText(messages.lessons.explanationLabel)).toHaveCount(0);
  await expect(page.locator('[data-testid^="lesson-explanation-audio-"]')).toHaveCount(0);
});

test("opublikowana lekcja: zwinięty podgląd pokazuje wyjaśnienie i odsłuch", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const data = withExplanations();
  await openLesson(page, { data: { ...data, draft: null } as unknown as typeof lesson });
  const card = page.getByTestId("exercise-0");
  await expect(page.getByTestId("exercise-explanation-preview-0")).toHaveText(messages.lessons.explanationPreview.replace("{text}", EXPLANATION));
  await expect(card.getByTestId("lesson-explanation-audio-0-listen")).toBeVisible();
  await expect(card.getByTestId("exercise-explanation-audio-0")).toContainText(messages.lessons.explanationAudioLabel);
  // wersja tylko do odczytu: bez „Nagraj ponownie”
  await expect(card.getByTestId("lesson-explanation-audio-0-regenerate")).toHaveCount(0);
  await expect(page.getByTestId("exercise-explanation-preview-1")).toHaveCount(0);
});

for (const viewport of [{ width: 375, height: 812 }, { width: 1280, height: 800 }]) {
  test(`geometria pola wyjaśnienia i nagrania w ${viewport.width}×${viewport.height}: bez przepełnienia poziomego`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openLesson(page, { data: withExplanations() });
    if (viewport.width < 600) await page.getByTestId(`stage-${OBJ_A}-guided`).getByRole("button").first().click();
    await page.getByTestId("exercise-edit-0").click();
    await expect(page.getByTestId("exercise-explanation-0")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    for (const id of ["exercise-explanation-0", "lesson-explanation-audio-0-listen", "lesson-explanation-audio-0-regenerate"]) {
      const box = (await page.getByTestId("exercise-0").getByTestId(id).boundingBox())!;
      expect(box.x, id).toBeGreaterThanOrEqual(-0.5);
      expect(box.x + box.width, id).toBeLessThanOrEqual(viewport.width + 0.5);
      if (id !== "exercise-explanation-0") expect(box.height, id).toBeGreaterThanOrEqual(44);
    }
  });
}

/** Ćwiczenie samodzielne (otwarte) zagadnienia z podaną odpowiedzią. */
const openAnswer = (n: number, objectiveId: string, answer: string) => ({
  id: uuid(n), revisionId: uuid(n + 50), exerciseType: "lesson_open_answer", objectiveId,
  instructionPl: "Powiedz całe zdanie.", prompt: `Co robi on (${n})?`, answer, acceptedAnswers: [], focus: ["plays"],
});

/**
 * Szkic z ujawnionymi rozwiązaniami (spec etapu przeglądu lekcji §8): ćwiczenie 5 powtarza przykład karty
 * zagadnienia, ćwiczenie 6 rozwiązanie ćwiczenia 3 (inne zagadnienie), ćwiczenie 7 — ćwiczenie 5 (miękko).
 */
const leakyLesson = {
  ...lesson,
  published: null,
  draft: {
    ...version(draftId, "draft", 2),
    exercises: [
      choice(1, OBJ_A), gap(2, OBJ_A), choice(3, OBJ_B), gap(4, OBJ_B),
      openAnswer(5, OBJ_A, "He plays football every day."),
      openAnswer(6, OBJ_A, "plays"),
      openAnswer(7, OBJ_A, "He plays football every day."),
    ],
    coverage: [{ objectiveId: OBJ_A, stage: "independent", required: 2, actual: 1, excluded: 2 }],
    exposureLeaks: [
      { exerciseId: uuid(5), kind: "hard", source: { kind: "card_example", objectiveId: OBJ_A } },
      { exerciseId: uuid(6), kind: "hard", source: { kind: "exercise", exerciseId: uuid(3) } },
      { exerciseId: uuid(7), kind: "soft", source: { kind: "exercise", exerciseId: uuid(5) } },
    ],
  },
} as unknown as typeof lesson;

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test(`ujawnione rozwiązania w ${viewport.width}×${viewport.height}: ostrzeżenia w nagłówku karty, brak z wykluczeniem, „Pokaż ćwiczenie”`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openLesson(page, { data: leakyLesson });
    const phone = viewport.width < 600;

    // lista braków: etap z wykluczonymi ćwiczeniami ma osobny komunikat
    const expectedGap = messages.lessons.coverageGapExcluded
      .replace("{objective}", "Końcówka -s w 3. osobie").replace("{stage}", messages.lessons.stages.independent)
      .replace("{actual}", "1").replace("{excluded}", "2").replace("{required}", "2");
    await expect(page.getByTestId("coverage-gap-0")).toHaveText(expectedGap);

    // telefon: etapy zwinięte — rozwiń etap samodzielny pierwszego zagadnienia
    if (phone) await page.getByTestId(`stage-${OBJ_A}-independent`).getByRole("button").first().click();

    const cardLeak = page.getByTestId("exercise-leak-4");
    await expect(cardLeak).toBeVisible();
    await expect(cardLeak).toContainText(messages.lessons.exposureLeakCard.replace("{objective}", "Końcówka -s w 3. osobie"));
    await expect(cardLeak).toHaveAttribute("data-leak-kind", "hard");
    await expect(cardLeak).not.toHaveAttribute("role", "alert");
    await expect(page.getByTestId("exercise-leak-4-show")).toHaveCount(0);
    // opis karty wskazuje sam tekst ostrzeżenia (bez przycisku „Pokaż ćwiczenie”)
    await expect(page.getByTestId("exercise-4")).toHaveAttribute("aria-describedby", "exercise-leak-4-text");
    await expect(page.locator("#exercise-leak-4-text")).toHaveText(messages.lessons.exposureLeakCard.replace("{objective}", "Końcówka -s w 3. osobie"));
    // ostrzeżenie jest w nagłówku karty: nad podglądem treści (karta zwinięta)
    const alertBox = (await cardLeak.boundingBox())!;
    const previewBox = (await page.getByTestId("exercise-4").locator(".pp-lesson-ex-preview").boundingBox())!;
    expect(alertBox.y + alertBox.height).toBeLessThanOrEqual(previewBox.y + 1);

    const softLeak = page.getByTestId("exercise-leak-6");
    await expect(softLeak).toContainText(messages.lessons.exposureLeakSoft.replace("{n}", "5"));
    await expect(softLeak).toHaveAttribute("data-leak-kind", "soft");

    const hardLeak = page.getByTestId("exercise-leak-5");
    await expect(hardLeak).toContainText(messages.lessons.exposureLeakExercise.replace("{n}", "3"));
    const show = page.getByTestId("exercise-leak-5-show");
    await expect(show).toHaveText(messages.lessons.exposureLeakShow.replace("{n}", "3"));
    const showBox = (await show.boundingBox())!;
    expect(showBox.height).toBeGreaterThanOrEqual(48);
    expect(showBox.x + showBox.width).toBeLessThanOrEqual(viewport.width + 0.5);
    await expectNoHorizontalOverflow(page);

    // „Pokaż ćwiczenie 3”: rozwija zagadnienie i etap źródła (telefon: oba były zwinięte), pokazuje jego kartę
    // i przenosi na nią fokus
    if (phone) await expect(page.getByTestId("exercise-2")).toBeHidden();
    await show.click();
    await expect(page.getByTestId("exercise-2")).toBeVisible();
    await expect(page.getByTestId("exercise-2")).toBeInViewport();
    await expect(page.getByTestId("exercise-2")).toBeFocused();
    await expectNoHorizontalOverflow(page);
  });
}

test("ujawnione rozwiązanie: zmiana ćwiczenia zamienia treść ostrzeżenia na prośbę o zapis", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openLesson(page, { data: leakyLesson });
  await expect(page.getByTestId("exercise-leak-4")).toContainText(messages.lessons.exposureLeakCard.replace("{objective}", "Końcówka -s w 3. osobie"));
  await page.getByTestId("exercise-edit-4").click();
  await page.getByTestId("exercise-answer-4").fill("He plays chess every day.");
  await expect(page.getByTestId("exercise-leak-4")).toHaveText(messages.lessons.exposureLeakStale);
  await expectNoHorizontalOverflow(page);
});

test("opublikowana lekcja bez szkicu nie pokazuje ostrzeżeń o ujawnionych rozwiązaniach", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // Wersja opublikowana z ćwiczeniami samodzielnymi równymi przykładowi karty (ujawnienie), tak jak zwraca ją
  // serwer: bez `exposureLeaks` i z pokryciem sprzed reguły (bez `excluded`) — opublikowane wersje bez zmian.
  const published = {
    ...version(publishedId, "published", 1),
    exercises: [...leakyLesson.draft!.exercises],
    coverage: [],
  };
  expect(published.examples[OBJ_A]).toContain(published.exercises[4]!.answer);
  await openLesson(page, { data: { ...lesson, draft: null, published } as unknown as typeof lesson });
  await expect(page.getByTestId("exercise-4")).toBeVisible();
  await expect(page.locator('[data-testid^="exercise-leak-"]')).toHaveCount(0);
  await expect(page.getByTestId("coverage-ok")).toBeVisible();
  await expect(page.getByText("z rozwiązaniem widocznym wcześniej")).toHaveCount(0);
});

/**
 * Niepełna pula po generowaniu agentem puli (spec etapu 2a §11): jeden alert z liczbą zagadnień
 * i znacznik przy każdym zagadnieniu z luką, obok plakietek pokrycia; wersja opublikowana bez nich.
 */
const gappedLesson = {
  ...lesson,
  published: null,
  draft: {
    ...version(draftId, "draft", 2),
    generationGaps: [
      { objectiveId: OBJ_A, reason: "incomplete" },
      { objectiveId: OBJ_B, reason: "add_short", added: 3, requested: 8 },
    ],
  },
} as unknown as typeof lesson;

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test(`niepełna pula w ${viewport.width}×${viewport.height}: alert z liczbą zagadnień i znacznik przy zagadnieniu`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openLesson(page, { data: gappedLesson });
    const alert = page.getByTestId("lesson-generation-gaps");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(messages.lessons.generationGapsAlert.few.replace("{n}", "2"));
    await expect(alert).not.toHaveAttribute("role", "alert");

    const incomplete = page.getByTestId(`objective-gap-${OBJ_A}`);
    await expect(incomplete).toHaveText(messages.lessons.generationGapIncomplete);
    await expect(incomplete).toHaveAttribute("data-reason", "incomplete");
    const short = page.getByTestId(`objective-gap-${OBJ_B}`);
    await expect(short).toHaveText(messages.lessons.generationGapAddShort.replace("{added}", "3").replace("{requested}", "8"));
    // znacznik stoi obok plakietki pokrycia w nagłówku zagadnienia
    await expect(page.getByTestId(`objective-group-${OBJ_A}`)).toContainText(messages.lessons.coverageFull);
    await expectNoHorizontalOverflow(page);
  });
}

test("bez luk generowania nie ma alertu ani znaczników", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLesson(page);
  await expect(page.getByTestId("lesson-generation-gaps")).toHaveCount(0);
  await expect(page.locator('[data-testid^="objective-gap-"]')).toHaveCount(0);
});
