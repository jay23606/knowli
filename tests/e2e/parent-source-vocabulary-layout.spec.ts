import { expect, test, type Page } from "@playwright/test";
import { messages } from "@learning/contracts";

/**
 * Zestaw słówek ze źródła w panelu rodzica (Etap 4, design 2026-10-30 §6.2):
 * przycisk na stronie źródła, formularz (podgląd tekstu tylko do odczytu,
 * nazwa, rodzaj, najwięcej słówek, zawężenie), polecenie z rewizją podglądu,
 * konflikt 409 z odświeżeniem podglądu, niepewny zapis (także utracona
 * odpowiedź po zapisie zestawu), źródło usunięte oraz edytor zestawu z notką
 * źródła, liczbą pominiętych pozycji i porażką `no_source_items` z linkiem do
 * źródła. API rodzica zaślepione w przeglądarce (stan w pamięci testu), teksty
 * fikcyjne.
 */

const SOURCE_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const RUN_ID = "00000000-0000-4000-8000-0000000000aa";
const FAILED_DECK_ID = "20000000-0000-4000-8000-0000000000f1";
const BODY = "Unit 3 — Food\npizza — pizza\napple — jabłko\nI like pizza. Do you like apples?";

const catalog = {
  lessonGenerationAvailable: true,
  subjects: [
    { id: "school", titlePl: "Przedmiot szkolny", creation: "material", subjectTitleRequired: true, topics: [] },
    { id: "english_chapter", titlePl: "Angielski — rozdział", creation: "material", subjectTitleRequired: false, topics: [] },
  ],
};

interface StoredSource {
  id: string;
  title: string;
  body: string;
  revision: number;
  bodyRevision: number;
  decks: Array<{ deckId: string; title: string; kind: "lesson" | "vocabulary"; state: string; copiedRevision: number | null; stale: boolean }>;
}

interface StoredDeck {
  id: string;
  title: string;
  idempotencyKey: string;
  copiedRevision: number;
  generation: { state: string; errorCode: string | null; rejectedCount: number | null };
}

interface Api {
  source: StoredSource | null;
  decks: Map<string, StoredDeck>;
  generates: Array<Record<string, unknown>>;
  /** Tyle najbliższych POST /decks/generate kończy się błędem 500 (wynik niepewny, bez zapisu). */
  generateFailures: number;
  /**
   * Utracone odpowiedzi najbliższych POST /decks/generate: zestaw zostaje zapisany (jak na
   * serwerze), ale klient dostaje 500 albo zerwane połączenie — wynik niepewny.
   */
  lostResponses: Array<"500" | "abort">;
  /** Status odczytu strony źródła (200 — zwykła odpowiedź; inny — błąd). */
  getStatus: number;
}

const envelope = (code: string, message: string) => ({ code, message, retryable: false, requestId: "r" });

function storedSource(): StoredSource {
  return {
    id: SOURCE_ID, title: "Unit 3 — Food", body: BODY, revision: 2, bodyRevision: 2,
    decks: [{ deckId: "10000000-0000-4000-8000-000000000001", title: "Angielski — rozdział: Unit 3", kind: "lesson", state: "published", copiedRevision: 2, stale: false }],
  };
}

function sourceDto(source: StoredSource) {
  return {
    ...source,
    createdAt: "2026-10-30T12:00:00.000Z", updatedAt: "2026-10-31T12:00:00.000Z",
    deckCount: source.decks.filter((deck) => deck.state !== "archived").length,
  };
}

/**
 * Widok zestawu słówek: szkic z dwoma słowami z tekstu źródła albo — jak na serwerze, który
 * zakłada szkic przy przyjęciu polecenia — po porażce runu pusty szkic tej samej wersji.
 */
function deckDto(deck: StoredDeck, source: StoredSource | null) {
  const draftId = deck.id.replace(/^2/, "3");
  const failed = deck.generation.state === "failed";
  const items = [
    { source: "pizza", target: "pizza", visualType: "none" },
    { source: "jabłko", target: "apple", example: "Do you like apples?", visualType: "none" },
  ].map((item, index) => ({
    ...item, acceptedAnswers: [], locales: { source: "pl-PL", target: "en-GB" },
    id: `40000000-0000-4000-8000-00000000000${index}`, revisionId: `50000000-0000-4000-8000-00000000000${index}`,
  }));
  return {
    id: deck.id, title: deck.title, state: "draft", coverAssetId: null, sessionTaskBudget: 20,
    draft: { id: draftId, deckId: deck.id, editNumber: 1, status: "draft", vocabularyFormat: "standard", title: deck.title, items: failed ? [] : items, assets: [] },
    published: null,
    generation: { id: RUN_ID, deckId: deck.id, deckVersionId: draftId, attempts: 1, ...deck.generation },
    assignments: [],
    ...(source ? { source: { id: source.id, title: source.title, copiedRevision: deck.copiedRevision, currentRevision: source.bodyRevision } } : {}),
  };
}

async function mockApi(page: Page): Promise<Api> {
  const api: Api = { source: storedSource(), decks: new Map(), generates: [], generateFailures: 0, lostResponses: [], getStatus: 200 };
  await page.route("**/api/v1/parent/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname.replace("/api/v1/parent", "");
    if (path === "/login") return route.fulfill({ json: { authenticated: true, setupRequired: false } });
    if (path === "/lesson-catalog") return route.fulfill({ json: catalog });
    if (path === "/decks" && method === "GET") {
      return route.fulfill({ json: [...api.decks.values()].map((deck) => ({
        deckId: deck.id, title: deck.title, state: "draft", kind: "vocabulary", editableVersionId: null, publishedVersionId: null, itemCount: 2,
      })) });
    }
    if (path === "/sources" && method === "GET") {
      const { source } = api;
      return route.fulfill({ json: source ? [{ id: source.id, title: source.title, revision: source.revision, createdAt: "2026-10-30T12:00:00.000Z", updatedAt: "2026-10-31T12:00:00.000Z", deckCount: source.decks.length }] : [] });
    }
    if (path === `/sources/${SOURCE_ID}` && method === "GET") {
      if (!api.source) return route.fulfill({ status: 404, json: envelope("not_found", "Nie znaleziono.") });
      if (api.getStatus !== 200) return route.fulfill({ status: api.getStatus, json: { ...envelope("internal", "Błąd serwera."), retryable: true } });
      return route.fulfill({ json: sourceDto(api.source) });
    }
    if (path === "/decks/generate" && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      api.generates.push(body);
      if (api.generateFailures > 0) {
        api.generateFailures -= 1;
        return route.fulfill({ status: 500, json: { ...envelope("internal", "Błąd serwera."), retryable: true } });
      }
      // jak serwer: ponowienie tym samym kluczem zwraca utworzony zestaw, zanim sprawdzi źródło
      const existing = [...api.decks.values()].find((deck) => deck.idempotencyKey === body.idempotencyKey);
      if (existing) return route.fulfill({ status: 202, json: { generationRunId: RUN_ID, deckId: existing.id } });
      const source = api.source;
      if (!source || body.sourceMaterialId !== source.id) return route.fulfill({ status: 404, json: envelope("not_found", "Nie znaleziono źródła.") });
      if (body.expectedSourceRevision !== source.bodyRevision) {
        return route.fulfill({ status: 409, json: { ...envelope("conflict", "Konflikt."), details: { reason: "source_changed" } } });
      }
      const id = `20000000-0000-4000-8000-00000000000${api.decks.size + 1}`;
      const title = typeof body.title === "string" ? body.title : source.title;
      api.decks.set(id, { id, title, idempotencyKey: String(body.idempotencyKey), copiedRevision: source.bodyRevision, generation: { state: "succeeded", errorCode: null, rejectedCount: 2 } });
      source.decks.push({ deckId: id, title, kind: "vocabulary", state: "draft", copiedRevision: source.bodyRevision, stale: false });
      const lost = api.lostResponses.shift();
      if (lost === "abort") return route.abort("connectionreset");
      if (lost === "500") return route.fulfill({ status: 500, json: { ...envelope("internal", "Błąd serwera."), retryable: true } });
      return route.fulfill({ status: 202, json: { generationRunId: RUN_ID, deckId: id } });
    }
    const deckMatch = /^\/decks\/([0-9a-f-]{36})$/.exec(path);
    if (deckMatch && method === "GET") {
      const deck = api.decks.get(deckMatch[1]!);
      if (!deck) return route.fulfill({ status: 404, json: envelope("not_found", "Nie znaleziono.") });
      return route.fulfill({ json: deckDto(deck, api.source) });
    }
    return route.fulfill({ json: [] });
  });
  return api;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

async function expectTargets(page: Page, ids: string[], width: number, containerId?: string): Promise<void> {
  const container = containerId ? await page.getByTestId(containerId).boundingBox() : null;
  if (containerId) expect(container, containerId).not.toBeNull();
  for (const id of ids) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box, id).not.toBeNull();
    // ≥ 44 px jak w pozostałych specyfikacjach panelu rodzica (48 px to próg Kid UI);
    // tolerancja 0,01 px na zaokrąglenie przekształceń okna
    expect(box!.height, id).toBeGreaterThanOrEqual(44 - 0.01);
    expect(box!.x, id).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, id).toBeLessThanOrEqual(width + 0.5);
    if (container) {
      expect(box!.x, `${id} inside ${containerId}`).toBeGreaterThanOrEqual(container.x - 0.5);
      expect(box!.x + box!.width, `${id} inside ${containerId}`).toBeLessThanOrEqual(container.x + container.width + 0.5);
    }
  }
}

const FORM_TARGETS = [
  "new-vocabulary-cancel", "new-vocabulary-source-change", "new-vocabulary-source-preview", "new-vocabulary-title",
  "new-vocabulary-format", "new-vocabulary-max-items", "new-vocabulary-instruction", "new-vocabulary-submit",
];
const formUrl = new RegExp(`/parent/vocabulary/new\\?source=${SOURCE_ID}$`);

const VIEWPORTS = [
  { width: 320, height: 640 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
];

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.width}×${viewport.height}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
    });

    test("strona źródła → formularz → edytor zestawu z notką źródła i liczbą pominiętych pozycji", async ({ page }) => {
      const api = await mockApi(page);
      await page.goto(`/parent/sources/${SOURCE_ID}`);
      await expect(page.getByTestId("source-create-vocabulary")).toHaveText(messages.sources.createVocabulary);
      await expectNoHorizontalOverflow(page);
      await expectTargets(page, ["source-create-chapter", "source-create-school", "source-create-vocabulary"], viewport.width);

      await page.getByTestId("source-create-vocabulary").click();
      await expect(page).toHaveURL(formUrl);
      await expect(page.getByTestId("new-vocabulary-form").getByRole("heading", { level: 1 })).toHaveText(messages.sources.newVocabularyTitle);
      await expect(page.getByTestId("new-vocabulary-source")).toContainText(messages.sources.fromSource.replace("{title}", "Unit 3 — Food"));
      // podgląd to natywne pole tylko do odczytu, nazwane tytułem źródła
      await expect(page.getByTestId("new-vocabulary-source-preview")).toHaveValue(BODY);
      await expect(page.getByTestId("new-vocabulary-source-preview")).toHaveAttribute("readonly", "");
      await expect(page.getByRole("textbox", { name: messages.sources.fromSource.replace("{title}", "Unit 3 — Food") })).toHaveValue(BODY);
      await expect(page.getByTestId("new-vocabulary-title")).toHaveValue("Unit 3 — Food");
      await expect(page.getByTestId("new-vocabulary-format")).toHaveValue("standard");
      await expect(page.getByTestId("new-vocabulary-max-items")).toHaveValue("20");
      await expect(page.getByTestId("new-vocabulary-instruction")).toHaveAttribute("placeholder", messages.sources.vocabularyInstructionPlaceholder);
      await expect(page.getByTestId("new-vocabulary-form")).toContainText(messages.sources.vocabularyInstructionHint);
      await expect(page.getByTestId("new-vocabulary-cancel")).toHaveText(messages.sources.backToSource);
      await expect(page.getByTestId("new-vocabulary-source-change")).toHaveAttribute("href", "/parent/sources");
      await expectNoHorizontalOverflow(page);
      // „Wróć” (`pp-editor-back`) celowo wysuwa się ujemnym marginesem jak w edytorach — tylko w viewporcie;
      // kontrolki formularza leżą też w kontenerze formularza.
      await expectTargets(page, FORM_TARGETS.slice(0, 1), viewport.width);
      await expectTargets(page, FORM_TARGETS.slice(1), viewport.width, "new-vocabulary-form");

      // liczba spoza 1–100: błąd przy polu (aria-invalid), „Utwórz zestaw” wyłączone
      await page.getByTestId("new-vocabulary-max-items").fill("101");
      await expect(page.getByTestId("new-vocabulary-max-items")).toHaveAttribute("aria-invalid", "true");
      await expect(page.getByTestId("new-vocabulary-form")).toContainText(messages.sources.vocabularyMaxItemsInvalid);
      await expect(page.getByTestId("new-vocabulary-submit")).toBeDisabled();
      await expectNoHorizontalOverflow(page);
      await page.getByTestId("new-vocabulary-max-items").fill("12");
      await expect(page.getByTestId("new-vocabulary-max-items")).not.toHaveAttribute("aria-invalid", "true");
      await expect(page.getByTestId("new-vocabulary-form")).not.toContainText(messages.sources.vocabularyMaxItemsInvalid);
      await page.getByTestId("new-vocabulary-instruction").fill("  tylko owoce  ");
      await page.getByTestId("new-vocabulary-submit").click();

      await expect(page).toHaveURL(/\/parent\/decks\/20000000-0000-4000-8000-000000000001$/);
      expect(api.generates).toHaveLength(1);
      expect(api.generates[0]).toEqual({
        sourceMaterialId: SOURCE_ID, expectedSourceRevision: 2, vocabularyFormat: "standard", maxItems: 12,
        idempotencyKey: expect.any(String), title: "Unit 3 — Food", instruction: "tylko owoce",
      });
      await expect(page.getByTestId("editor-title")).toHaveValue("Unit 3 — Food");
      await expect(page.getByTestId("lesson-source-link")).toHaveText(messages.sources.fromSource.replace("{title}", "Unit 3 — Food"));
      await expect(page.getByTestId("lesson-source-changed")).toHaveCount(0);
      await expect(page.getByTestId("vocabulary-rejected-count")).toHaveText(messages.decks.rejectedFromSource.replace("{n}", "2"));
      await expect(page.getByTestId("leave-editor-dialog")).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      await expectTargets(page, ["lesson-source-link"], viewport.width);

      // link notki prowadzi na stronę źródła, a jej lista zestawów zna już nowy zestaw
      await page.getByTestId("lesson-source-link").click();
      await expect(page).toHaveURL(new RegExp(`/parent/sources/${SOURCE_ID}$`));
      await expect(page.getByTestId("source-deck-1")).toContainText("Unit 3 — Food");
      // formularz zniknął z historii: „wstecz” z edytora nie wraca do formularza
      await page.goBack();
      await expect(page).toHaveURL(/\/parent\/decks\/20000000-0000-4000-8000-000000000001$/);
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`/parent/sources/${SOURCE_ID}$`));
    });

    test("źródło zmienione w innym oknie: 409 odświeża podgląd, ponowne „Utwórz zestaw” wysyła nową rewizję", async ({ page }) => {
      const api = await mockApi(page);
      await page.goto(`/parent/vocabulary/new?source=${SOURCE_ID}`);
      await expect(page.getByTestId("new-vocabulary-source-preview")).toHaveValue(BODY);
      // w innym oknie: tekst źródła zmieniono po wyświetleniu podglądu
      api.source = { ...api.source!, body: `${BODY}\nWe like bananas.`, revision: 3, bodyRevision: 3 };

      await page.getByTestId("new-vocabulary-submit").click();
      await expect(page.getByTestId("new-vocabulary-error")).toContainText(messages.sources.changedBeforeCreateVocabulary);
      await expect(page.getByTestId("new-vocabulary-source-preview")).toHaveValue(/We like bananas\./);
      await expect(page.getByTestId("new-vocabulary-submit")).toBeEnabled();
      await expect(page.getByTestId("new-vocabulary-submit")).toHaveText(messages.sources.createVocabularySubmit);
      // fokus na odświeżonym tekście do sprawdzenia; komunikat informacyjny, nie błąd
      await expect(page.getByTestId("new-vocabulary-source-preview")).toBeFocused();
      await expect(page.getByTestId("new-vocabulary-error")).toHaveAttribute("data-tone", "notice");
      await expect(page).toHaveURL(formUrl);
      expect(api.generates).toHaveLength(1);
      expect(api.generates[0]).toMatchObject({ sourceMaterialId: SOURCE_ID, expectedSourceRevision: 2 });
      await expectNoHorizontalOverflow(page);
      await expectTargets(page, ["new-vocabulary-submit"], viewport.width, "new-vocabulary-form");

      await page.getByTestId("new-vocabulary-submit").click();
      await expect(page).toHaveURL(/\/parent\/decks\/20000000-0000-4000-8000-000000000001$/);
      expect(api.generates).toHaveLength(2);
      expect(api.generates[1]).toMatchObject({ sourceMaterialId: SOURCE_ID, expectedSourceRevision: 3 });
      expect(api.generates[1]!.idempotencyKey).not.toBe(api.generates[0]!.idempotencyKey);
      await expect(page.getByTestId("leave-editor-dialog")).toHaveCount(0);
    });
  });
}

test.describe("przypadki brzegowe (telefon 390×844)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test("niepewny zapis: ponowienie wysyła to samo polecenie, pola zablokowane do rozstrzygnięcia", async ({ page }) => {
    const api = await mockApi(page);
    api.generateFailures = 1;
    await page.goto(`/parent/vocabulary/new?source=${SOURCE_ID}`);
    await page.getByTestId("new-vocabulary-format").selectOption("picture");
    await page.getByTestId("new-vocabulary-title").fill("   ");
    await page.getByTestId("new-vocabulary-submit").click();
    await expect(page.getByTestId("new-vocabulary-error")).toContainText(messages.decks.generationUncertain);
    await expect(page.getByTestId("new-vocabulary-submit")).toHaveText(messages.decks.retryGenerationRequest);
    await expect(page.getByTestId("new-vocabulary-instruction")).toBeDisabled();
    await expect(page.getByTestId("new-vocabulary-max-items")).toBeDisabled();
    await expect(page.getByTestId("new-vocabulary-format")).toBeDisabled();
    // pusta nazwa i puste zawężenie są pominięte — serwer nada tytuł źródła
    expect(api.generates[0]).not.toHaveProperty("title");
    expect(api.generates[0]).not.toHaveProperty("instruction");
    expect(api.generates[0]).toMatchObject({ vocabularyFormat: "picture", maxItems: 20 });

    // niepewne polecenie (i zmienione pola) chroni wyjście
    await page.getByTestId("tab-decks").click();
    await expect(page.getByTestId("leave-editor-dialog")).toBeVisible();
    await page.getByTestId("leave-editor-stay").click();

    await page.getByTestId("new-vocabulary-submit").click();
    await expect(page).toHaveURL(/\/parent\/decks\/20000000-0000-4000-8000-000000000001$/);
    expect(api.generates).toHaveLength(2);
    expect(api.generates[1]).toEqual(api.generates[0]);
    await expect(page.getByTestId("editor-title")).toHaveValue("Unit 3 — Food");
  });

  test("odczyt źródła po 409 nie udaje się: tworzenie czeka, „Spróbuj ponownie” odświeża podgląd", async ({ page }) => {
    const api = await mockApi(page);
    await page.goto(`/parent/vocabulary/new?source=${SOURCE_ID}`);
    await expect(page.getByTestId("new-vocabulary-source-preview")).toHaveValue(BODY);
    api.source = { ...api.source!, body: `${BODY}\nWe like bananas.`, revision: 3, bodyRevision: 3 };
    api.getStatus = 503;

    await page.getByTestId("new-vocabulary-submit").click();
    // odczyt jest ponawiany po 5xx — komunikat po wyczerpaniu ponowień
    await expect(page.getByTestId("new-vocabulary-error")).toContainText(messages.sources.refreshFailed, { timeout: 15_000 });
    await expect(page.getByTestId("new-vocabulary-submit")).toBeDisabled();
    await expect(page.getByTestId("new-vocabulary-source-preview")).toHaveValue(BODY);
    await expect(page.getByTestId("new-vocabulary-refresh-retry")).toHaveText(messages.parentShell.retry);
    // wyłączone „Utwórz zestaw” oddało fokus ponowieniu odczytu
    await expect(page.getByTestId("new-vocabulary-refresh-retry")).toBeFocused();
    await expectNoHorizontalOverflow(page);
    await expectTargets(page, ["new-vocabulary-refresh-retry"], 390);
    expect(api.generates).toHaveLength(1);

    api.getStatus = 200;
    await page.getByTestId("new-vocabulary-refresh-retry").click();
    await expect(page.getByTestId("new-vocabulary-source-preview")).toHaveValue(/We like bananas\./);
    await expect(page.getByTestId("new-vocabulary-error")).toContainText(messages.sources.changedBeforeCreateVocabulary);
    await expect(page.getByTestId("new-vocabulary-refresh-retry")).toHaveCount(0);
    await expect(page.getByTestId("new-vocabulary-submit")).toBeEnabled();
    await page.getByTestId("new-vocabulary-submit").click();
    await expect(page).toHaveURL(/\/parent\/decks\/20000000-0000-4000-8000-000000000001$/);
    expect(api.generates[1]).toMatchObject({ expectedSourceRevision: 3 });
  });

  test("źródło usunięte w innym oknie: 404 jest ostateczne, powrót do listy źródeł", async ({ page }) => {
    const api = await mockApi(page);
    await page.goto(`/parent/vocabulary/new?source=${SOURCE_ID}`);
    await expect(page.getByTestId("new-vocabulary-source-preview")).toHaveValue(BODY);
    api.source = null;
    await page.getByTestId("new-vocabulary-submit").click();
    await expect(page.getByTestId("new-vocabulary-error")).toContainText(messages.sources.notFound);
    await expect(page.getByTestId("new-vocabulary-error")).not.toContainText(messages.decks.generationUncertain);
    await expect(page.getByTestId("new-vocabulary-submit")).toBeDisabled();
    await expect(page.getByTestId("new-vocabulary-submit")).toHaveText(messages.sources.createVocabularySubmit);
    await expect(page.getByTestId("new-vocabulary-cancel")).toHaveText(messages.sources.backToList);
    expect(api.generates).toHaveLength(1);
    // jeden „Zmień źródło” — przy komunikacie, z fokusem
    await expect(page.getByTestId("new-vocabulary-source-change")).toHaveCount(0);
    await expect(page.getByTestId("new-vocabulary-source-missing-change")).toBeFocused();
    await expectNoHorizontalOverflow(page);
    await expectTargets(page, ["new-vocabulary-source-missing-change"], 390);
    await expect(page.getByTestId("new-vocabulary-source-missing-change")).toHaveAttribute("href", "/parent/sources");
    await page.getByTestId("new-vocabulary-source-missing-change").click();
    await expect(page).toHaveURL(/\/parent\/sources$/);
    await expect(page.getByTestId("leave-editor-dialog")).toHaveCount(0);
  });

  test("link do nieistniejącego źródła i adres bez prawidłowego źródła", async ({ page }) => {
    const api = await mockApi(page);
    api.source = null;
    await page.goto(`/parent/vocabulary/new?source=${SOURCE_ID}`);
    await expect(page.getByTestId("new-vocabulary-not-found")).toContainText(messages.sources.notFound);
    await expect(page.getByTestId("new-vocabulary-form")).toHaveCount(0);
    await expectTargets(page, ["new-vocabulary-back"], 390);
    await page.getByTestId("new-vocabulary-back").click();
    await expect(page).toHaveURL(/\/parent\/sources$/);

    // bez prawidłowego `source` formularz nie ma widoku — panel przechodzi do domyślnej sekcji
    await page.goto("/parent/vocabulary/new?source=nie-uuid");
    await expect(page).toHaveURL(/\/parent\/decks$/);
    await expect(page.getByTestId("new-vocabulary-form")).toHaveCount(0);
  });

  for (const { lost, change } of [
    { lost: "500", change: "tekst źródła zmieniono" },
    { lost: "abort", change: "źródło usunięto" },
  ] as const) {
    test(`utracona odpowiedź (${lost}), potem ${change}: ponowienie tym samym poleceniem otwiera zapisany zestaw`, async ({ page }) => {
      const api = await mockApi(page);
      api.lostResponses = [lost];
      await page.goto(`/parent/vocabulary/new?source=${SOURCE_ID}`);
      await expect(page.getByTestId("new-vocabulary-source-preview")).toHaveValue(BODY);
      await page.getByTestId("new-vocabulary-submit").click();
      await expect(page.getByTestId("new-vocabulary-error")).toContainText(messages.decks.generationUncertain);
      await expect(page.getByTestId("new-vocabulary-submit")).toHaveText(messages.decks.retryGenerationRequest);
      // zestaw zapisano, choć odpowiedź nie dotarła
      expect(api.decks.size).toBe(1);

      // w innym oknie, zanim rodzic ponowi: źródło zmienione albo usunięte
      api.source = lost === "500" ? { ...api.source!, body: `${BODY}\nWe like bananas.`, revision: 3, bodyRevision: 3 } : null;
      await page.getByTestId("new-vocabulary-submit").click();

      // serwer rozpoznaje klucz przed odczytem źródła — to samo polecenie zwraca zapisany zestaw
      await expect(page).toHaveURL(/\/parent\/decks\/20000000-0000-4000-8000-000000000001$/);
      expect(api.generates).toHaveLength(2);
      expect(api.generates[1]).toEqual(api.generates[0]);
      expect(api.decks.size).toBe(1);
      await expect(page.getByTestId("editor-title")).toHaveValue("Unit 3 — Food");
      await expect(page.getByTestId("leave-editor-dialog")).toHaveCount(0);
      if (lost === "500") {
        await expect(page.getByTestId("lesson-source-changed")).toHaveText(messages.sources.sourceChanged);
      } else {
        await expect(page.getByTestId("lesson-source-note")).toHaveCount(0);
      }
    });
  }

  test("edytor zestawu, gdy w tekście źródła nie było słówek: komunikat no_source_items, link do źródła i notka o zmianie źródła", async ({ page }) => {
    const api = await mockApi(page);
    api.source = { ...api.source!, bodyRevision: 4 };
    api.decks.set(FAILED_DECK_ID, {
      id: FAILED_DECK_ID, title: "Unit 3 — Food", idempotencyKey: "k-failed-0001", copiedRevision: 2,
      generation: { state: "failed", errorCode: "no_source_items", rejectedCount: 6 },
    });
    await page.goto(`/parent/decks/${FAILED_DECK_ID}`);
    await expect(page.getByTestId("generation-failed")).toContainText(messages.decks.noSourceItems);
    await expect(page.getByTestId("generation-failed")).not.toContainText(messages.decks.generationFailed);
    await expect(page.getByTestId("vocabulary-rejected-count")).toHaveText(messages.decks.rejectedFromSource.replace("{n}", "6"));
    await expect(page.getByTestId("lesson-source-link")).toHaveAttribute("href", `/parent/sources/${SOURCE_ID}`);
    await expect(page.getByTestId("lesson-source-changed")).toHaveText(messages.sources.sourceChanged);
    // ponowienie powtarza zamrożone polecenie — inne zawężenie to nowy zestaw ze strony źródła
    await expect(page.getByTestId("generation-source-link")).toHaveText(messages.decks.goToSource);
    await expect(page.getByTestId("generation-source-link")).toHaveAttribute("href", `/parent/sources/${SOURCE_ID}`);
    await expectNoHorizontalOverflow(page);
    await expectTargets(page, ["lesson-source-link", "generation-retry", "generation-source-link"], 390);
    await page.getByTestId("generation-source-link").click();
    await expect(page).toHaveURL(new RegExp(`/parent/sources/${SOURCE_ID}$`));
    await expect(page.getByTestId("source-create-vocabulary")).toBeVisible();
  });
});
