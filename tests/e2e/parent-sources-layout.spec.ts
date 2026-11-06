import { expect, test, type Page } from "@playwright/test";
import { messages } from "@learning/contracts";

/**
 * Zakładka „Źródła” panelu rodzica (Etap 2, design 2026-10-30 §3.4): lista,
 * nowe źródło, edycja z konfliktem rewizji (409), usunięcie z potwierdzeniem
 * i przyciski tworzenia lekcji ze źródła; przypadki brzegowe (telefon): fokus
 * po błędach, ochrona niezapisanych zmian, błędy wczytywania, linki do
 * nieistniejącego źródła i limit tekstu. API rodzica zaślepione
 * w przeglądarce (stan w pamięci testu), teksty fikcyjne.
 */

const SOURCE_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const NEW_ID = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";

const catalog = {
  lessonGenerationAvailable: true,
  subjects: [
    { id: "english_grammar", titlePl: "Gramatyka angielska", creation: "catalog", subjectTitleRequired: false,
      topics: [{ id: "present_simple", titlePl: "Present Simple", objectives: [{ id: "negation", titlePl: "Przeczenia" }] }] },
    { id: "school", titlePl: "Przedmiot szkolny", creation: "material", subjectTitleRequired: true, topics: [] },
    { id: "english_chapter", titlePl: "Angielski — rozdział", creation: "material", subjectTitleRequired: false, topics: [] },
  ],
};

interface StoredSource {
  id: string;
  title: string;
  body: string;
  revision: number;
  /** Rewizja treści (rośnie tylko przy zmianie tekstu) — `expectedSourceRevision` tworzenia lekcji. */
  bodyRevision: number;
  createdAt: string;
  updatedAt: string;
  decks: Array<{ deckId: string; title: string; kind: "lesson" | "vocabulary"; state: string; copiedRevision: number | null; stale: boolean }>;
  /** Klucz idempotencji utworzenia (tylko w zaślepce, nie w DTO). */
  requestId?: string;
}

interface Api {
  sources: Map<string, StoredSource>;
  creates: Array<{ clientRequestId: string; title: string; body: string }>;
  patches: Array<Record<string, unknown>>;
  deletes: string[];
  lessonCreates: Array<{ path: string; body: Record<string, unknown> }>;
  /** Następny PATCH kończy się konfliktem rewizji, a źródło zmienia się „w innym oknie”. */
  conflictNext: boolean;
  /** Tyle najbliższych POST /sources kończy się błędem 500 (wynik niepewny). */
  createFailures: number;
  /**
   * Status odpowiedzi tworzenia lekcji (202 przyjęte; 404 — źródło usunięte w innym oknie).
   * Niezależnie od niego, jak serwer: `expectedSourceRevision` inne niż bieżąca rewizja
   * treści źródła daje 409 z `details.reason = "source_changed"`.
   */
  lessonStatus: number;
  /** Lista zestawów kolejnych odczytów GET /decks (ostatnia zostaje). */
  deckLists: unknown[][];
  deckListCalls: number;
  /** Status odczytu listy źródeł i strony źródła (200 — zwykła odpowiedź; inny — błąd). */
  listStatus: number;
  getStatus: number;
  /** Status następnego PATCH (200 — zwykły zapis; inny — błąd bez zmiany źródła). */
  patchStatus: number;
  /** `lessonGenerationAvailable` katalogu lekcji (false — serwer bez klucza OpenRouter). */
  generationAvailable: boolean;
}

const BODY = "Unit 3 — Food\npizza — pizza\napple — jabłko\nI like pizza. Do you like apples?";
const NEW_IDS = [NEW_ID, "2c3d4e5f-6071-4b8c-9d0e-1f2a3b4c5d6e"];

function storedSource(): StoredSource {
  return {
    id: SOURCE_ID,
    title: "Unit 3 — Food",
    body: BODY,
    revision: 2,
    bodyRevision: 2,
    createdAt: "2026-10-30T12:00:00.000Z",
    updatedAt: "2026-10-31T12:00:00.000Z",
    decks: [
      { deckId: "10000000-0000-4000-8000-000000000001", title: "Angielski — rozdział: Unit 3", kind: "lesson", state: "published", copiedRevision: 1, stale: true },
      { deckId: "10000000-0000-4000-8000-000000000002", title: "Jedzenie — sprawdzian", kind: "lesson", state: "draft", copiedRevision: 2, stale: false },
      { deckId: "10000000-0000-4000-8000-000000000003", title: "Owoce", kind: "lesson", state: "archived", copiedRevision: 1, stale: true },
    ],
  };
}

/** `deckCount` jak na serwerze: bez zestawów zarchiwizowanych. */
function withCount(source: StoredSource) {
  const { requestId: _requestId, ...dto } = source;
  return { ...dto, deckCount: source.decks.filter((deck) => deck.state !== "archived").length };
}

function summary(source: StoredSource) {
  const { body: _body, decks: _decks, ...rest } = withCount(source);
  return rest;
}

const envelope = (code: string, message: string) => ({ code, message, retryable: false, requestId: "r" });

async function mockApi(page: Page): Promise<Api> {
  const api: Api = {
    sources: new Map([[SOURCE_ID, storedSource()]]), creates: [], patches: [], deletes: [], lessonCreates: [],
    conflictNext: false, createFailures: 0, lessonStatus: 202, deckLists: [[]], deckListCalls: 0,
    listStatus: 200, getStatus: 200, patchStatus: 200, generationAvailable: true,
  };
  const failure = (status: number) => ({ status, json: { ...envelope(status >= 500 ? "internal" : "validation", "Błąd."), retryable: status >= 500 } });
  await page.route("**/api/v1/parent/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname.replace("/api/v1/parent", "");
    if (path === "/login") return route.fulfill({ json: { authenticated: true, setupRequired: false } });
    if (path === "/lesson-catalog") return route.fulfill({ json: { ...catalog, lessonGenerationAvailable: api.generationAvailable } });
    if (path === "/decks" && method === "GET") {
      const list = api.deckLists[Math.min(api.deckListCalls, api.deckLists.length - 1)]!;
      api.deckListCalls += 1;
      return route.fulfill({ json: list });
    }
    if (path === "/sources" && method === "GET") {
      if (api.listStatus !== 200) return route.fulfill(failure(api.listStatus));
      return route.fulfill({ json: [...api.sources.values()].map(summary) });
    }
    if (path === "/sources" && method === "POST") {
      const body = request.postDataJSON() as { clientRequestId: string; title: string; body: string };
      api.creates.push(body);
      if (api.createFailures > 0) {
        api.createFailures -= 1;
        return route.fulfill({ status: 500, json: { ...envelope("internal", "Błąd serwera."), retryable: true } });
      }
      // ponowienie tym samym clientRequestId zwraca to samo źródło (200), nowe polecenie — nowe źródło
      const existing = [...api.sources.values()].find((source) => source.requestId === body.clientRequestId);
      if (existing) return route.fulfill({ status: 200, json: { id: existing.id } });
      const id = NEW_IDS.find((candidate) => !api.sources.has(candidate))!;
      api.sources.set(id, {
        id, title: body.title, body: body.body, revision: 1, bodyRevision: 1, createdAt: "2026-10-31T13:00:00.000Z", updatedAt: "2026-10-31T13:00:00.000Z",
        decks: [], requestId: body.clientRequestId,
      });
      return route.fulfill({ status: 201, json: { id } });
    }
    const sourceMatch = /^\/sources\/([0-9a-f-]+)$/.exec(path);
    if (sourceMatch) {
      const id = sourceMatch[1]!;
      const stored = api.sources.get(id);
      if (!stored) return route.fulfill({ status: 404, json: envelope("not_found", "Nie znaleziono.") });
      if (method === "GET") {
        if (api.getStatus !== 200) return route.fulfill(failure(api.getStatus));
        return route.fulfill({ json: withCount(stored) });
      }
      if (method === "PATCH") {
        const patch = request.postDataJSON() as { expectedRevision: number; title?: string; body?: string };
        api.patches.push(patch);
        if (api.patchStatus !== 200) {
          const status = api.patchStatus;
          api.patchStatus = 200;
          return route.fulfill(failure(status));
        }
        if (api.conflictNext) {
          api.conflictNext = false;
          api.sources.set(id, { ...stored, body: `${stored.body}\nWe like apples.`, revision: stored.revision + 1, bodyRevision: stored.bodyRevision + 1 });
          return route.fulfill({ status: 409, json: envelope("conflict", "Wersja jest nieaktualna.") });
        }
        const updated = { ...stored, ...(patch.title ? { title: patch.title } : {}), ...(patch.body ? { body: patch.body, bodyRevision: stored.bodyRevision + 1 } : {}), revision: stored.revision + 1,
          decks: stored.decks.map((deck) => ({ ...deck, stale: true })) };
        api.sources.set(id, updated);
        return route.fulfill({ json: withCount(updated) });
      }
      if (method === "DELETE") {
        api.deletes.push(id);
        api.sources.delete(id);
        return route.fulfill({ status: 204 });
      }
    }
    if (method === "POST" && /^\/lessons(\/school|\/material)?$/.test(path)) {
      const body = request.postDataJSON() as Record<string, unknown>;
      api.lessonCreates.push({ path, body });
      if (api.lessonStatus === 404) return route.fulfill({ status: 404, json: envelope("not_found", "Nie znaleziono źródła.") });
      const source = typeof body.sourceMaterialId === "string" ? api.sources.get(body.sourceMaterialId) : undefined;
      if (source && body.expectedSourceRevision !== source.bodyRevision) {
        return route.fulfill({ status: 409, json: { ...envelope("conflict", "Konflikt."), details: { reason: "source_changed" } } });
      }
      return route.fulfill({ status: 202, json: { runId: "00000000-0000-4000-8000-0000000000aa", deckId: body.deckId } });
    }
    // edytor lekcji po utworzeniu: odczyt nieistotny dla tego speca
    if (/^\/lessons\/[0-9a-f-]+$/.test(path)) return route.fulfill({ status: 404, json: envelope("not_found", "Brak") });
    return route.fulfill({ json: [] });
  });
  return api;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

async function expectTargets(page: Page, ids: string[], width: number): Promise<void> {
  for (const id of ids) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box, id).not.toBeNull();
    // ≥ 44 px; tolerancja 0,01 px na zaokrąglenie przekształceń okna (np. 43,999996 w otwartym modalu)
    expect(box!.height, id).toBeGreaterThanOrEqual(44 - 0.01);
    expect(box!.x, id).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, id).toBeLessThanOrEqual(width + 0.5);
  }
}

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

    test("lista i nowe źródło: licznik znaków, zapis otwiera stronę źródła", async ({ page }) => {
      const api = await mockApi(page);
      await page.goto("/parent/decks");
      await page.getByTestId("tab-sources").click();
      await expect(page).toHaveURL(/\/parent\/sources$/);
      await expect(page.getByTestId("tab-sources")).toHaveAttribute("aria-current", "true");
      await expect(page.getByTestId("source-row-0")).toContainText("Unit 3 — Food");
      await expect(page.getByTestId("source-row-0")).toContainText("2 zestawy");
      await expect(page.getByTestId("source-row-0")).toContainText("31.10.2026");
      await expectNoHorizontalOverflow(page);
      await expectTargets(page, ["source-row-0", "new-source-open"], viewport.width);
      if (viewport.width < 600) {
        // przycisk nad dolnym paskiem nawigacji
        const fab = (await page.getByTestId("new-source-open").boundingBox())!;
        const nav = (await page.getByTestId("tab-sources").boundingBox())!;
        expect(fab.y + fab.height).toBeLessThanOrEqual(nav.y);
      }

      await page.getByTestId("new-source-open").click();
      await expect(page.getByTestId("new-source-dialog")).toBeVisible();
      await expect(page.getByTestId("source-create-submit")).toBeDisabled();
      await page.getByTestId("source-title").fill("Unit 4 — Sport");
      await page.getByTestId("source-body").fill("football — piłka nożna\nI play football.");
      await expect(page.getByTestId("source-body-counter")).toHaveText(messages.sources.counter.replace("{n}", "39"));
      await expect(page.getByTestId("source-body-hint")).toHaveText(messages.sources.bodyHint);
      await expectNoHorizontalOverflow(page);
      await expectTargets(page, ["source-title", "source-body", "source-create-submit"], viewport.width);
      await page.getByTestId("source-create-submit").click();

      await expect(page).toHaveURL(new RegExp(`/parent/sources/${NEW_ID}$`));
      await expect(page.getByTestId("source-page")).toBeVisible();
      await expect(page.getByTestId("source-heading")).toHaveText("Unit 4 — Sport");
      await expect(page.getByTestId("source-no-decks")).toBeVisible();
      expect(api.creates).toEqual([{ clientRequestId: expect.any(String), title: "Unit 4 — Sport", body: "football — piłka nożna\nI play football." }]);
    });

    test("bez klucza: tworzenie lekcji ze źródła wyłączone z komunikatem, zestaw słówek aktywny", async ({ page }) => {
      const api = await mockApi(page);
      api.generationAvailable = false;
      await page.goto(`/parent/sources/${SOURCE_ID}`);
      await expect(page.getByTestId("source-generation-unavailable")).toHaveText(messages.lessons.generationErrors.lesson_agent_unavailable!);
      await expect(page.getByTestId("source-create-chapter")).toBeDisabled();
      await expect(page.getByTestId("source-create-school")).toBeDisabled();
      await expect(page.getByTestId("source-create-vocabulary")).toBeEnabled();
      await expectNoHorizontalOverflow(page);
      expect(api.lessonCreates).toHaveLength(0);
    });

    test("edycja: tylko zmienione pola, konflikt 409 pokazuje komunikat i odświeżenie", async ({ page }) => {
      const api = await mockApi(page);
      await page.goto(`/parent/sources/${SOURCE_ID}`);
      await expect(page.getByTestId("source-preview")).toHaveValue(BODY);
      await expectNoHorizontalOverflow(page);
      await expectTargets(page, ["source-back", "source-preview", "source-create-chapter", "source-create-school", "source-edit", "source-delete", "source-deck-0"], viewport.width);
      // podgląd to natywne pole tylko do odczytu: fokusowalne z klawiatury bez tabIndex, nazwane nagłówkiem
      await expect(page.getByTestId("source-preview")).toHaveAttribute("readonly", "");
      await expect(page.getByTestId("source-preview")).not.toHaveAttribute("tabindex", /.*/);
      await expect(page.getByRole("textbox", { name: messages.sources.previewLabel })).toHaveValue(BODY);
      await expect(page.getByTestId("source-deck-stale-0")).toHaveText(messages.sources.sourceChanged);
      // nagłówek liczy zestawy jak lista (bez zarchiwizowanego), lista zestawów pokazuje wszystkie trzy
      await expect(page.getByTestId("source-meta")).toContainText("2 zestawy");
      await expect(page.getByTestId("source-deck-2")).toContainText(messages.decks.states.archived);

      // stały region na żywo jest od początku na stronie (pusty) — ogłoszenie zapisu zmienia tylko tekst
      await expect(page.getByTestId("source-status")).toHaveAttribute("role", "status");
      await expect(page.getByTestId("source-status")).toHaveText("");

      await page.getByTestId("source-edit").click();
      await expect(page.getByTestId("source-body")).toHaveValue(BODY);
      // „Edytuj” znika — fokus przechodzi do pola tytułu, nie na <body>
      await expect(page.getByTestId("source-title")).toBeFocused();
      // źródło ma zestawy: uwaga, że zmiana ich nie zmieni
      await expect(page.getByTestId("source-edit-hint")).toHaveText(messages.sources.editHint);
      // bez zmian nie ma czego zapisać (zapis podbiłby rewizję i oznaczył zestawy jako nieaktualne)
      await expect(page.getByTestId("source-save")).toBeDisabled();
      await expectNoHorizontalOverflow(page);
      await expectTargets(page, ["source-title", "source-body", "source-save", "source-edit-cancel"], viewport.width);

      api.conflictNext = true;
      await page.getByTestId("source-title").fill("Unit 3 — Jedzenie");
      await expect(page.getByTestId("source-save")).toBeEnabled();
      await page.getByTestId("source-save").click();
      await expect(page.getByTestId("source-conflict")).toContainText(messages.sources.conflict);
      expect(api.patches).toEqual([{ expectedRevision: 2, title: "Unit 3 — Jedzenie" }]);
      await expect(page.getByTestId("source-save")).toBeDisabled();
      // „Zapisz” jest wyłączone — fokus przechodzi na następny krok, „Odśwież”
      await expect(page.getByTestId("source-conflict-refresh")).toBeFocused();
      await expectNoHorizontalOverflow(page);

      // „Odśwież” odrzuca wpisane zmiany — najpierw potwierdzenie; anulowanie je zostawia
      await page.getByTestId("source-conflict-refresh").click();
      await expect(page.getByTestId("source-refresh-dialog")).toContainText(messages.sources.refreshConfirm);
      await expectTargets(page, ["source-refresh-cancel", "source-refresh-confirm"], viewport.width);
      await page.getByTestId("source-refresh-cancel").click();
      await expect(page.getByTestId("source-refresh-dialog")).toHaveCount(0);
      await expect(page.getByTestId("source-title")).toHaveValue("Unit 3 — Jedzenie");
      await expect(page.getByTestId("source-conflict")).toBeVisible();

      await page.getByTestId("source-conflict-refresh").click();
      await page.getByTestId("source-refresh-confirm").click();
      await expect(page.getByTestId("source-conflict")).toHaveCount(0);
      await expect(page.getByTestId("source-preview")).toHaveValue(/We like apples\./);
      await expect(page.getByTestId("source-heading")).toHaveText("Unit 3 — Food");
      await expect(page.getByTestId("source-edit")).toBeFocused();

      // ponowna edycja od najnowszej rewizji zapisuje się
      await page.getByTestId("source-edit").click();
      await page.getByTestId("source-body").fill("I like pizza.");
      await page.getByTestId("source-save").click();
      await expect(page.getByTestId("source-preview")).toHaveValue("I like pizza.");
      await expect(page.getByTestId("source-status")).toHaveText(messages.sources.saved);
      expect(api.patches[1]).toEqual({ expectedRevision: 3, body: "I like pizza." });
    });

    test("usunięcie: potwierdzenie z liczbą zestawów, powrót do listy", async ({ page }) => {
      const api = await mockApi(page);
      await page.goto(`/parent/sources/${SOURCE_ID}`);
      await page.getByTestId("source-delete").click();
      const dialog = page.getByTestId("source-delete-dialog");
      // odnośnik tracą wszystkie zestawy, także zarchiwizowany
      await expect(dialog).toContainText(messages.sources.deleteConfirm.replace("{n}", "3"));
      await expectNoHorizontalOverflow(page);
      await expectTargets(page, ["source-delete-cancel", "source-delete-confirm"], viewport.width);
      await page.getByTestId("source-delete-cancel").click();
      await expect(dialog).toHaveCount(0);
      expect(api.deletes).toEqual([]);

      await page.getByTestId("source-delete").click();
      await page.getByTestId("source-delete-confirm").click();
      await expect(page).toHaveURL(/\/parent\/sources$/);
      await expect(page.getByText(messages.sources.empty)).toBeVisible();
      expect(api.deletes).toEqual([SOURCE_ID]);
    });

    test("przyciski tworzenia: formularz nowej lekcji ze źródłem zamiast pola materiału", async ({ page }) => {
      const api = await mockApi(page);
      await page.goto(`/parent/sources/${SOURCE_ID}`);
      await page.getByTestId("source-create-school").click();
      await expect(page).toHaveURL(new RegExp(`/parent/lessons/new\\?source=${SOURCE_ID}&subject=school$`));
      await expect(page.getByTestId("lesson-subject")).toHaveValue("school");
      await expect(page.getByTestId("lesson-source")).toContainText(messages.sources.fromSource.replace("{title}", "Unit 3 — Food"));
      await expect(page.getByTestId("lesson-material")).toHaveCount(0);

      // „Zmień źródło” prowadzi do listy źródeł, a przycisk u góry z powrotem na stronę źródła
      await expect(page.getByTestId("lesson-source-change")).toHaveAttribute("href", "/parent/sources");
      await page.getByTestId("lesson-source-change").click();
      await expect(page).toHaveURL(/\/parent\/sources$/);
      await page.getByTestId("source-row-0").click();
      await page.getByTestId("source-create-school").click();
      await expect(page.getByTestId("new-lesson-cancel")).toHaveText(messages.sources.backToSource);
      await page.getByTestId("new-lesson-cancel").click();
      await expect(page).toHaveURL(new RegExp(`/parent/sources/${SOURCE_ID}$`));
      await page.getByTestId("source-create-chapter").click();
      await expect(page).toHaveURL(new RegExp(`/parent/lessons/new\\?source=${SOURCE_ID}&subject=english_chapter$`));
      await expect(page.getByTestId("lesson-subject")).toHaveValue("english_chapter");
      await expect(page.getByTestId("lesson-source-preview")).toHaveValue(/Do you like apples\?/);
      await expect(page.getByTestId("material-topic-name")).toHaveValue("Unit 3 — Food");
      await expectNoHorizontalOverflow(page);
      await expectTargets(page, ["new-lesson-cancel", "lesson-subject", "lesson-source-change", "lesson-source-preview", "material-topic-name", "lesson-create-submit"], viewport.width);

      await page.getByTestId("lesson-create-submit").click();
      await expect(page).toHaveURL(/\/parent\/decks\/[0-9a-f-]+$/);
      expect(api.lessonCreates).toHaveLength(1);
      expect(api.lessonCreates[0]!.path).toBe("/lessons/material");
      expect(api.lessonCreates[0]!.body).toMatchObject({ subjectId: "english_chapter", topicTitlePl: "Unit 3 — Food", sourceMaterialId: SOURCE_ID, expectedSourceRevision: 2 });
      expect(api.lessonCreates[0]!.body).not.toHaveProperty("material");
    });
  });
}

test.describe("przypadki brzegowe (telefon 390×844)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test("niepewny zapis nowego źródła: ponowienie wysyła to samo polecenie, następne źródło ma nowy klucz", async ({ page }) => {
    const api = await mockApi(page);
    api.createFailures = 1;
    await page.goto("/parent/sources");
    await page.getByTestId("new-source-open").click();
    await page.getByTestId("source-title").fill("Unit 4 — Sport");
    await page.getByTestId("source-body").fill("I play football.");
    await page.getByTestId("source-create-submit").click();
    await expect(page.getByTestId("api-error")).toContainText(messages.sources.createUncertain);
    // fokus na komunikacie błędu (przycisk zapisu był wyłączony w trakcie wysyłki)
    await expect(page.getByTestId("api-error")).toBeFocused();
    await expect(page.getByTestId("source-create-submit")).toHaveText(messages.sources.retryCreate);
    // ponowienie wysyła dokładnie to, co widać — pola zablokowane do rozstrzygnięcia
    await expect(page.getByTestId("source-title")).toBeDisabled();
    await expect(page.getByTestId("source-body")).toBeDisabled();

    await page.getByTestId("source-create-submit").click();
    await expect(page).toHaveURL(new RegExp(`/parent/sources/${NEW_ID}$`));
    expect(api.creates).toHaveLength(2);
    expect(api.creates[1]).toEqual(api.creates[0]);

    await page.getByTestId("source-back").click();
    await page.getByTestId("new-source-open").click();
    await expect(page.getByTestId("source-title")).toHaveValue("");
    await page.getByTestId("source-title").fill("Unit 5 — Pogoda");
    await page.getByTestId("source-body").fill("It is sunny.");
    await page.getByTestId("source-create-submit").click();
    await expect(page).toHaveURL(new RegExp(`/parent/sources/${NEW_IDS[1]}$`));
    expect(api.creates).toHaveLength(3);
    expect(api.creates[2]!.clientRequestId).not.toBe(api.creates[0]!.clientRequestId);

    // źródło bez zestawów: potwierdzenie usunięcia mówi, że nie powstał z niego żaden zestaw
    await page.getByTestId("source-delete").click();
    await expect(page.getByTestId("source-delete-dialog")).toContainText(messages.sources.deleteConfirmNoDecks);
    await page.getByTestId("source-delete-cancel").click();
    expect(api.deletes).toEqual([]);
  });

  test("okno nowego źródła: puste zamyka się od razu, szkic odrzuca dopiero potwierdzenie", async ({ page }) => {
    await mockApi(page);
    await page.goto("/parent/sources");
    await page.getByTestId("new-source-open").click();
    await page.getByTestId("source-create-cancel").click();
    await expect(page.getByTestId("new-source-dialog")).toHaveCount(0);
    await expect(page.getByTestId("source-discard-dialog")).toHaveCount(0);

    await page.getByTestId("new-source-open").click();
    await page.getByTestId("source-title").fill("Unit 4 — Sport");
    await page.getByTestId("source-create-cancel").click();
    await expect(page.getByTestId("source-discard-dialog")).toContainText(messages.sources.discardConfirm);
    await expectTargets(page, ["source-discard-cancel", "source-discard-confirm"], 390);
    // „Wróć do edycji” zostawia szkic w otwartym oknie
    await page.getByTestId("source-discard-cancel").click();
    await expect(page.getByTestId("source-discard-dialog")).toHaveCount(0);
    await expect(page.getByTestId("source-title")).toHaveValue("Unit 4 — Sport");

    // × też pyta, a „Odrzuć” zamyka okno, czyści szkic i zdejmuje ochronę wyjścia
    await page.getByTestId("new-source-close").click();
    await page.getByTestId("source-discard-confirm").click();
    await expect(page.getByTestId("new-source-dialog")).toHaveCount(0);
    await page.getByTestId("tab-decks").click();
    await expect(page).toHaveURL(/\/parent\/decks$/);
    await expect(page.getByTestId("leave-editor-dialog")).toHaveCount(0);
    await page.getByTestId("tab-sources").click();
    await page.getByTestId("new-source-open").click();
    await expect(page.getByTestId("source-title")).toHaveValue("");
  });

  test("niezapisana edycja źródła i wpisany szkic nowego źródła zatrzymują wyjście", async ({ page }) => {
    await mockApi(page);
    await page.goto("/parent/decks");
    await page.getByTestId("tab-sources").click();
    await page.getByTestId("source-row-0").click();
    await page.getByTestId("source-edit").click();
    await page.getByTestId("source-title").fill("Unit 3 — Jedzenie");

    await page.getByTestId("tab-decks").click();
    await expect(page.getByTestId("leave-editor-dialog")).toContainText(messages.decks.leaveDescription);
    await page.getByTestId("leave-editor-stay").click();
    await expect(page).toHaveURL(new RegExp(`/parent/sources/${SOURCE_ID}$`));
    await expect(page.getByTestId("source-title")).toHaveValue("Unit 3 — Jedzenie");

    // „wstecz” z niezapisaną edycją też pyta
    await page.goBack();
    await expect(page.getByTestId("leave-editor-dialog")).toBeVisible();
    await page.getByTestId("leave-editor-stay").click();
    await expect(page).toHaveURL(new RegExp(`/parent/sources/${SOURCE_ID}$`));
    await expect(page.getByTestId("source-title")).toHaveValue("Unit 3 — Jedzenie");

    await page.getByTestId("source-edit-cancel").click();
    await page.getByTestId("source-back").click();
    await expect(page).toHaveURL(/\/parent\/sources$/);
    await expect(page.getByTestId("leave-editor-dialog")).toHaveCount(0);

    // wpisany szkic w otwartym oknie nowego źródła: „wstecz” pyta, „Zostań” zostawia okno ze szkicem
    await page.getByTestId("new-source-open").click();
    await page.getByTestId("source-body").fill("I play football.");
    await page.goBack();
    await expect(page.getByTestId("leave-editor-dialog")).toBeVisible();
    await page.getByTestId("leave-editor-stay").click();
    await expect(page).toHaveURL(/\/parent\/sources$/);
    await expect(page.getByTestId("new-source-dialog")).toBeVisible();
    await expect(page.getByTestId("source-body")).toHaveValue("I play football.");
  });

  test("błędy wczytywania listy i strony źródła: komunikat z ponowieniem zamiast pustego stanu", async ({ page }) => {
    const api = await mockApi(page);
    api.listStatus = 503;
    await page.goto("/parent/sources");
    // odczyt jest ponawiany po 5xx — komunikat po wyczerpaniu ponowień
    await expect(page.getByTestId("sources-load-error")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("sources-empty")).toHaveCount(0);
    await expectTargets(page, ["sources-load-retry"], 390);
    api.listStatus = 200;
    await page.getByTestId("sources-load-retry").click();
    await expect(page.getByTestId("source-row-0")).toContainText("Unit 3 — Food");
    await expect(page.getByTestId("sources-load-error")).toHaveCount(0);

    api.getStatus = 503;
    await page.goto(`/parent/sources/${SOURCE_ID}`);
    await expect(page.getByTestId("source-load-error")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("source-not-found")).toHaveCount(0);
    await expectTargets(page, ["source-back", "source-load-retry"], 390);
    api.getStatus = 200;
    await page.getByTestId("source-load-retry").click();
    await expect(page.getByTestId("source-heading")).toHaveText("Unit 3 — Food");
  });

  test("link do nieistniejącego źródła i do nowej lekcji z nim: brak źródła i powrót do listy źródeł", async ({ page }) => {
    await mockApi(page);
    const missing = "3d4e5f60-7182-4c9d-8e0f-2a3b4c5d6e7f";
    await page.goto(`/parent/sources/${missing}`);
    await expect(page.getByTestId("source-not-found")).toContainText(messages.sources.notFound);
    await expectNoHorizontalOverflow(page);
    await expectTargets(page, ["source-back"], 390);
    await page.getByTestId("source-back").click();
    await expect(page).toHaveURL(/\/parent\/sources$/);

    await page.goto(`/parent/lessons/new?source=${missing}&subject=english_chapter`);
    await expect(page.getByTestId("lesson-source-not-found")).toContainText(messages.sources.notFound);
    await expect(page.getByTestId("new-lesson-form")).toHaveCount(0);
    await expectTargets(page, ["lesson-source-back"], 390);
    await expect(page.getByTestId("lesson-source-back")).toHaveText(messages.sources.backToList);
    await page.getByTestId("lesson-source-back").click();
    await expect(page).toHaveURL(/\/parent\/sources$/);
    await expect(page.getByTestId("source-row-0")).toBeVisible();
  });

  test("zapis kończy się błędem serwera: fokus na komunikacie, edycja zostaje", async ({ page }) => {
    const api = await mockApi(page);
    await page.goto(`/parent/sources/${SOURCE_ID}`);
    await page.getByTestId("source-edit").click();
    await page.getByTestId("source-title").fill("Unit 3 — Jedzenie");
    api.patchStatus = 500;
    await page.getByTestId("source-save").click();
    await expect(page.getByTestId("source-error")).toBeVisible();
    await expect(page.getByTestId("source-error")).toBeFocused();
    await expect(page.getByTestId("source-title")).toHaveValue("Unit 3 — Jedzenie");

    // ponowny zapis się udaje i ogłasza wynik w regionie na żywo
    await page.getByTestId("source-save").click();
    await expect(page.getByTestId("source-status")).toHaveText(messages.sources.saved);
    await expect(page.getByTestId("source-heading")).toHaveText("Unit 3 — Jedzenie");
    await expect(page.getByTestId("source-error")).toHaveCount(0);
  });

  test("tekst na limicie 16 000 znaków: widoczna uwaga pod licznikiem", async ({ page }) => {
    await mockApi(page);
    await page.goto("/parent/sources");
    await page.getByTestId("new-source-open").click();
    await page.getByTestId("source-title").fill("Długi rozdział");
    await page.getByTestId("source-body").fill("a".repeat(15_999));
    await expect(page.getByTestId("source-body-limit")).toHaveText("");
    // wklejony tekst dłuższy niż limit: pole go ucina, a formularz mówi o tym wprost
    await page.getByTestId("source-body").fill("b".repeat(16_050));
    await expect(page.getByTestId("source-body-limit")).toHaveText(messages.sources.bodyAtLimit);
    await expect(page.getByTestId("source-body-limit")).toHaveAttribute("role", "status");
    await expect(page.getByTestId("source-body-counter")).toHaveText(messages.sources.counter.replace("{n}", "16000"));
    await expectNoHorizontalOverflow(page);
  });

  test("lekcja ze źródła usuniętego w innym oknie: 404 jest ostateczne, bez ponawiania", async ({ page }) => {
    const api = await mockApi(page);
    api.lessonStatus = 404;
    await page.goto(`/parent/lessons/new?source=${SOURCE_ID}&subject=english_chapter`);
    await page.getByTestId("lesson-create-submit").click();
    await expect(page.getByTestId("api-error")).toContainText(messages.sources.notFound);
    await expect(page.getByTestId("api-error")).not.toContainText(messages.lessons.createUncertain);
    await expect(page.getByTestId("lesson-create-submit")).toHaveText(messages.lessons.createLesson);
    await expect(page.getByTestId("lesson-create-submit")).toBeDisabled();
    expect(api.lessonCreates).toHaveLength(1);
    // strony źródła już nie ma — przycisk u góry prowadzi do listy źródeł
    await expect(page.getByTestId("new-lesson-cancel")).toHaveText(messages.sources.backToList);
    await expectNoHorizontalOverflow(page);
    await expectTargets(page, ["lesson-source-missing-change"], 390);

    // „Zmień źródło” prowadzi do listy źródeł (strona usuniętego źródła nie istnieje)
    await expect(page.getByTestId("lesson-source-missing-change")).toHaveAttribute("href", "/parent/sources");
    await page.getByTestId("lesson-source-missing-change").click();
    await expect(page).toHaveURL(/\/parent\/sources$/);
    await expect(page.getByTestId("leave-editor-dialog")).toHaveCount(0);
  });

  test("lekcja ze źródła zmienionego w innym oknie: 409 odświeża podgląd, ponowne utworzenie wysyła nową rewizję", async ({ page }) => {
    const api = await mockApi(page);
    await page.goto(`/parent/lessons/new?source=${SOURCE_ID}&subject=english_chapter`);
    await expect(page.getByTestId("lesson-source-preview")).toHaveValue(BODY);
    // w innym oknie: tekst źródła zmieniono po wyświetleniu podglądu
    const stored = api.sources.get(SOURCE_ID)!;
    api.sources.set(SOURCE_ID, { ...stored, body: `${BODY}\nWe like bananas.`, revision: stored.revision + 1, bodyRevision: stored.bodyRevision + 1 });

    await page.getByTestId("lesson-create-submit").click();
    await expect(page.getByTestId("api-error")).toContainText(messages.sources.changedBeforeCreate);
    await expect(page.getByTestId("lesson-source-preview")).toHaveValue(/We like bananas\./);
    await expect(page.getByTestId("lesson-create-submit")).toBeEnabled();
    await expect(page.getByTestId("lesson-create-submit")).toHaveText(messages.lessons.createLesson);
    await expect(page).toHaveURL(new RegExp(`/parent/lessons/new\\?source=${SOURCE_ID}&subject=english_chapter$`));
    expect(api.lessonCreates).toHaveLength(1);
    expect(api.lessonCreates[0]!.body).toMatchObject({ sourceMaterialId: SOURCE_ID, expectedSourceRevision: 2 });
    await expectNoHorizontalOverflow(page);

    // ponowne „Utwórz lekcję” potwierdza nowy tekst: nowe polecenie z bieżącą rewizją treści
    await page.getByTestId("lesson-create-submit").click();
    await expect(page).toHaveURL(/\/parent\/decks\/[0-9a-f-]+$/);
    expect(api.lessonCreates).toHaveLength(2);
    expect(api.lessonCreates[1]!.body).toMatchObject({ sourceMaterialId: SOURCE_ID, expectedSourceRevision: 3 });
    expect(api.lessonCreates[1]!.body.clientRequestId).not.toBe(api.lessonCreates[0]!.body.clientRequestId);
    await expect(page.getByTestId("leave-editor-dialog")).toHaveCount(0);
  });

  test("lekcja ze źródła zmienionego w innym oknie: nieudane odświeżenie podglądu blokuje tworzenie do udanego ponowienia", async ({ page }) => {
    const api = await mockApi(page);
    await page.goto(`/parent/lessons/new?source=${SOURCE_ID}&subject=english_chapter`);
    await expect(page.getByTestId("lesson-source-preview")).toHaveValue(BODY);
    const stored = api.sources.get(SOURCE_ID)!;
    api.sources.set(SOURCE_ID, { ...stored, body: `${BODY}\nWe like bananas.`, revision: stored.revision + 1, bodyRevision: stored.bodyRevision + 1 });
    // ponowny odczyt źródła po konflikcie kończy się błędem serwera
    api.getStatus = 503;

    await page.getByTestId("lesson-create-submit").click();
    // odczyt jest ponawiany po 5xx — komunikat po wyczerpaniu ponowień
    await expect(page.getByTestId("api-error")).toContainText(messages.sources.refreshFailed, { timeout: 15_000 });
    await expect(page.getByTestId("lesson-source-preview")).toHaveValue(BODY);
    await expect(page.getByTestId("lesson-create-submit")).toBeDisabled();
    await expect(page.getByTestId("lesson-source-refresh-retry")).toHaveText(messages.parentShell.retry);
    expect(api.lessonCreates).toHaveLength(1);
    await expectNoHorizontalOverflow(page);
    await expectTargets(page, ["lesson-source-refresh-retry"], 390);

    // udane ponowienie odświeża podgląd i rewizję — dopiero wtedy tworzenie wraca
    api.getStatus = 200;
    await page.getByTestId("lesson-source-refresh-retry").click();
    await expect(page.getByTestId("lesson-source-preview")).toHaveValue(/We like bananas\./);
    await expect(page.getByTestId("lesson-source-refresh-retry")).toHaveCount(0);
    await expect(page.getByTestId("api-error")).toContainText(messages.sources.changedBeforeCreate);
    await expect(page.getByTestId("lesson-create-submit")).toBeEnabled();
    expect(api.lessonCreates).toHaveLength(1);

    await page.getByTestId("lesson-create-submit").click();
    await expect(page).toHaveURL(/\/parent\/decks\/[0-9a-f-]+$/);
    expect(api.lessonCreates).toHaveLength(2);
    expect(api.lessonCreates[1]!.body).toMatchObject({ sourceMaterialId: SOURCE_ID, expectedSourceRevision: 3 });
  });

  test("zapis źródła usuniętego w innym oknie: komunikat o braku źródła", async ({ page }) => {
    const api = await mockApi(page);
    await page.goto(`/parent/sources/${SOURCE_ID}`);
    await page.getByTestId("source-edit").click();
    await page.getByTestId("source-title").fill("Unit 3 — Jedzenie");
    api.sources.delete(SOURCE_ID);
    await page.getByTestId("source-save").click();
    await expect(page.getByTestId("source-error")).toHaveText(messages.sources.notFound);
    await expect(page.getByTestId("source-error")).toBeFocused();
    // wpisany tekst zostaje do skopiowania; po wyjściu z edycji — brak źródła, nie stara kopia
    await expect(page.getByTestId("source-title")).toHaveValue("Unit 3 — Jedzenie");
    await page.getByTestId("source-edit-cancel").click();
    await expect(page.getByTestId("source-not-found")).toContainText(messages.sources.notFound);
    await expect(page.getByTestId("source-page")).toHaveCount(0);
  });

  test("strona źródła usuniętego w innym oknie: odświeżenie z 404 zastępuje kopię z pamięci", async ({ page }) => {
    const api = await mockApi(page);
    await page.goto(`/parent/sources/${SOURCE_ID}`);
    await expect(page.getByTestId("source-heading")).toHaveText("Unit 3 — Food");
    await page.getByTestId("source-back").click();
    api.sources.delete(SOURCE_ID);
    // powrót na stronę z pamięci podręcznej: odczyt w tle kończy się 404
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/parent/sources/${SOURCE_ID}$`));
    await expect(page.getByTestId("source-not-found")).toContainText(messages.sources.notFound);
    await expect(page.getByTestId("source-delete")).toHaveCount(0);
  });

  test("zestaw spoza wczytanej listy: jedno odświeżenie listy przed komunikatem o braku zestawu", async ({ page }) => {
    const api = await mockApi(page);
    // pierwszy odczyt listy (start panelu) nie zna zestawu ze źródła — powstał w innym oknie
    api.deckLists = [[], [{ deckId: "10000000-0000-4000-8000-000000000001", title: "Angielski — rozdział: Unit 3", state: "published", kind: "lesson",
      editableVersionId: null, publishedVersionId: null, itemCount: 24 }]];
    await page.goto(`/parent/sources/${SOURCE_ID}`);
    await page.getByTestId("source-deck-0").click();
    await expect(page).toHaveURL(/\/parent\/decks\/10000000-0000-4000-8000-000000000001$/);
    await expect(page.getByTestId("lesson-editor")).toBeVisible();
    await expect(page.getByTestId("deck-not-found")).toHaveCount(0);
    expect(api.deckListCalls).toBe(2);

    // zestaw, którego nie ma także po odświeżeniu listy — dopiero wtedy komunikat
    await page.goto("/parent/decks/10000000-0000-4000-8000-0000000000ff");
    await expect(page.getByTestId("deck-not-found")).toBeVisible();
    await expect(page.getByTestId("deck-loading")).toHaveCount(0);
  });
});
