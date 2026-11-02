// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { messages, type SubjectCatalogDto } from "@learning/contracts";
import NewLessonForm, {
  buildCommand, canSubmitLesson, defaultPoolSize, initialLessonValues, lessonInterestsOf, lessonPathOf, type NewLessonValues,
} from "./NewLessonForm";
import { ApiCallError } from "../api";
import type { SourceRefreshOutcome } from "../sources/source-refresh";
import { orpc } from "../query-client";
import { renderParentMarkup } from "../test-render";
import { parentTheme } from "../theme";

// Polecenia tworzenia lekcji zaślepione; pozostałe procedury klienta bez zmian (odczyty w testach są wstawione do pamięci).
const lessonsApi = vi.hoisted(() => ({ createFromMaterial: vi.fn(), createSchool: vi.fn(), create: vi.fn() }));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  const parentClient = new Proxy(actual.parentClient, {
    get: (target, key) => (key === "lessons" ? lessonsApi : Reflect.get(target, key)),
  });
  return { ...actual, parentClient };
});

const grammar = {
  id: "english_grammar",
  titlePl: "Gramatyka angielska",
  creation: "catalog",
  subjectTitleRequired: false,
  acceptsInterests: true,
  topics: [{
    id: "present_simple",
    titlePl: "Present Simple",
    objectives: [
      { id: "third_person_s", titlePl: "-s w 3. osobie" },
      { id: "negation", titlePl: "Przeczenia" },
    ],
  }],
};
const school = { id: "school", titlePl: "Przedmiot szkolny", creation: "material", subjectTitleRequired: true, topics: [] };
const chapter = { id: "english_chapter", titlePl: "Angielski — rozdział", creation: "material", subjectTitleRequired: false, topics: [] };

const catalog = { subjects: [grammar, school, chapter] } as unknown as SubjectCatalogDto;

const values = (overrides: Partial<NewLessonValues> = {}): NewLessonValues => ({
  ...initialLessonValues(catalog),
  material: "He plays football.",
  ...overrides,
});

/** Formularz z wczytanym katalogiem, w którym pierwszym przedmiotem jest podany (renderowanie statyczne nie wykonuje zapytań). */
function renderWithCatalog(first: unknown, extras: { children?: unknown[]; generationService?: string } = {}): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(orpc.lessonCatalog.get.queryOptions().queryKey, {
    subjects: [first],
    ...(extras.generationService ? { generationService: extras.generationService } : {}),
  } as unknown as SubjectCatalogDto);
  if (extras.children) queryClient.setQueryData(orpc.children.list.queryOptions().queryKey, extras.children as never);
  return renderParentMarkup(<NewLessonForm onCreated={vi.fn()} onCancel={vi.fn()} registerEditorState={vi.fn()} />, queryClient);
}

/** Brakujące w jsdom API, z których korzysta Mantine (media queries i Font Loading API autosize pola tekstowego). */
function stubMantineDomApis(): void {
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
  if (!("fonts" in document)) {
    Object.defineProperty(document, "fonts", { configurable: true, value: { addEventListener: () => undefined, removeEventListener: () => undefined } });
  }
}

describe("NewLessonForm", () => {
  it("domyślna pula: większa z 60 i 12 × liczba reguł, w granicach 20–120", () => {
    expect(defaultPoolSize(0)).toBe(60);
    expect(defaultPoolSize(6)).toBe(72);
    expect(defaultPoolSize(20)).toBe(120);
  });

  it("wartości startowe z katalogu: pierwszy przedmiot i temat, wszystkie reguły", () => {
    expect(initialLessonValues(catalog)).toMatchObject({
      subjectId: "english_grammar",
      topicId: "present_simple",
      objectiveIds: ["third_person_s", "negation"],
      poolSize: 60,
      poolSizeTouched: false,
    });
    expect(initialLessonValues(undefined).subjectId).toBe("");
  });

  it("ścieżka tworzenia wynika z creation i subjectTitleRequired, nie z pustej listy tematów", () => {
    expect(lessonPathOf(catalog, "english_grammar")).toBe("catalog");
    expect(lessonPathOf(catalog, "school")).toBe("school");
    expect(lessonPathOf(catalog, "english_chapter")).toBe("material");
    expect(lessonPathOf(catalog, "unknown")).toBe("catalog");
    expect(lessonPathOf(undefined, "school")).toBe("catalog");
  });

  it("lekcja z katalogu wymaga reguły, materiału i puli 20–120", () => {
    expect(canSubmitLesson(values(), catalog)).toBe(true);
    expect(canSubmitLesson(values({ objectiveIds: [] }), catalog)).toBe(false);
    expect(canSubmitLesson(values({ material: "   " }), catalog)).toBe(false);
    expect(canSubmitLesson(values({ material: "x".repeat(8001) }), catalog)).toBe(false);
    for (const poolSize of [19, 121, 20.5, ""]) expect(canSubmitLesson(values({ poolSize }), catalog), String(poolSize)).toBe(false);
    expect(canSubmitLesson(values({ poolSize: 120 }), catalog)).toBe(true);
  });

  it("przedmiot szkolny wymaga nazw przedmiotu i tematu, pula do 160", () => {
    const schoolValues = values({ subjectId: "school", topicId: "", objectiveIds: [] });
    expect(canSubmitLesson(schoolValues, catalog)).toBe(false);
    const named = { ...schoolValues, schoolSubjectName: "Geografia", topicTitle: "Mapa" };
    expect(canSubmitLesson(named, catalog)).toBe(true);
    expect(canSubmitLesson({ ...named, poolSize: 160 }, catalog)).toBe(true);
    expect(canSubmitLesson({ ...named, poolSize: 161 }, catalog)).toBe(false);
  });

  it("rozdział wymaga tylko tytułu i materiału do 16000 znaków, bez nazwy przedmiotu; pula do 160", () => {
    const chapterValues = values({ subjectId: "english_chapter", topicId: "", objectiveIds: [], schoolSubjectName: "" });
    expect(canSubmitLesson(chapterValues, catalog)).toBe(false);
    const titled = { ...chapterValues, topicTitle: "Unit 1" };
    expect(canSubmitLesson(titled, catalog)).toBe(true);
    expect(canSubmitLesson({ ...titled, material: "x".repeat(16000) }, catalog)).toBe(true);
    expect(canSubmitLesson({ ...titled, material: "x".repeat(16001) }, catalog)).toBe(false);
    expect(canSubmitLesson({ ...titled, material: "   " }, catalog)).toBe(false);
    expect(canSubmitLesson({ ...titled, topicTitle: "x".repeat(121) }, catalog)).toBe(false);
    expect(canSubmitLesson({ ...titled, poolSize: 160 }, catalog)).toBe(true);
    expect(canSubmitLesson({ ...titled, poolSize: 161 }, catalog)).toBe(false);
  });

  describe("buildCommand", () => {
    it("rozdział: polecenie z materiału z identyfikatorem przedmiotu i bez nazwy przedmiotu", () => {
      const chapterValues = values({
        subjectId: "english_chapter", topicId: "", objectiveIds: [], topicTitle: "  Unit 1  ", material: "  I like pizza.  ",
        instruction: "  tylko jedzenie  ", poolSize: 80,
      });
      const pending = buildCommand(chapterValues, lessonPathOf(catalog, "english_chapter"));
      expect(pending.kind).toBe("material");
      expect(pending.command).toMatchObject({
        subjectId: "english_chapter",
        topicTitlePl: "Unit 1",
        material: "I like pizza.",
        instruction: "tylko jedzenie",
        poolSize: 80,
        deckId: expect.any(String),
        clientRequestId: expect.any(String),
      });
      expect(pending.command).not.toHaveProperty("subjectTitlePl");
      expect(pending.command).not.toHaveProperty("topicId");
      expect(pending.command).not.toHaveProperty("objectiveIds");
    });

    it("szkoła: polecenie szkolne z nazwą przedmiotu i tematu jak dotąd", () => {
      const pending = buildCommand(
        values({ subjectId: "school", topicId: "", objectiveIds: [], schoolSubjectName: " Geografia ", topicTitle: " Mapa ", material: "Skala mapy." }),
        lessonPathOf(catalog, "school"),
      );
      expect(pending.kind).toBe("school");
      expect(pending.command).toMatchObject({ subjectTitlePl: "Geografia", topicTitlePl: "Mapa", material: "Skala mapy." });
      expect(pending.command).not.toHaveProperty("subjectId");
    });

    it("gramatyka: polecenie katalogowe z tematem i regułami", () => {
      const pending = buildCommand(values(), lessonPathOf(catalog, "english_grammar"));
      expect(pending.kind).toBe("catalog");
      expect(pending.command).toMatchObject({
        subjectId: "english_grammar",
        topicId: "present_simple",
        objectiveIds: ["third_person_s", "negation"],
      });
    });
  });

  it("renderuje powrót do listy i tytuł przed wczytaniem katalogu", () => {
    const markup = renderParentMarkup(<NewLessonForm onCreated={vi.fn()} onCancel={vi.fn()} registerEditorState={vi.fn()} />);
    expect(markup).toContain('data-testid="new-lesson-form"');
    expect(markup).toContain('data-testid="new-lesson-cancel"');
    expect(markup).toContain(messages.lessons.newLessonTitle);
  });

  it("rozdział: pole tytułu rozdziału i licznik do 16000, bez nazwy przedmiotu, wyboru reguł i podpowiedzi szkolnej", () => {
    const markup = renderWithCatalog(chapter);
    expect(markup).not.toContain('data-testid="school-subject-name"');
    expect(markup).not.toContain('data-testid="lesson-topic"');
    expect(markup).not.toContain('data-testid="school-material-hint"');
    expect(markup).toContain('data-testid="material-topic-name"');
    expect(markup).toContain("Rozdział (np. Unit 1)");
    expect(markup).toContain(messages.lessons.chapterTopicLabel);
    expect(markup).toContain(messages.lessons.chapterMaterialHint);
    expect(markup).toContain("0/16000 znaków");
    expect(markup).toContain(messages.lessons.schoolObjectivesAuto);
    // Podpowiedź puli zgodna z limitami ścieżki z materiału (20–160), bez wzoru z liczbą reguł.
    expect(messages.lessons.chapterPoolSizeHint).toBe("Od 20 do 160 ćwiczeń. Domyślnie 60.");
    expect(markup).toContain(messages.lessons.chapterPoolSizeHint);
    expect(markup).not.toContain(messages.lessons.poolSizeHint);
    expect(markup).not.toContain("liczba reguł");
  });

  it("szkoła: nadal nazwa przedmiotu i temat, podpowiedź szkolna i licznik do 16000", () => {
    const markup = renderWithCatalog(school);
    expect(markup).toContain('data-testid="school-subject-name"');
    expect(markup).toContain('data-testid="school-topic-name"');
    expect(markup).toContain('data-testid="school-material-hint"');
    expect(markup).not.toContain(messages.lessons.chapterTopicLabel);
    expect(markup).toContain("0/16000 znaków");
  });

  describe("lekcja ze źródła", () => {
    const SOURCE_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    const source = { id: SOURCE_ID, title: "Unit 3 — Food", body: "I like pizza.\nDo you like apples?", bodyRevision: 3 };

    it("wartości startowe: wskazany przedmiot z materiału i tytuł źródła jako temat", () => {
      expect(initialLessonValues(catalog, { subjectId: "school", topicTitle: source.title, fromSource: true })).toMatchObject({
        subjectId: "school", topicId: "", objectiveIds: [], topicTitle: "Unit 3 — Food", material: "",
      });
      expect(initialLessonValues(catalog, { subjectId: "english_chapter", fromSource: true }).subjectId).toBe("english_chapter");
      // przedmiot spoza ścieżki z materiału (albo nieznany) → pierwszy przedmiot z materiału
      expect(initialLessonValues(catalog, { subjectId: "english_grammar", fromSource: true }).subjectId).toBe("school");
      expect(initialLessonValues(catalog, { subjectId: "nieznany", fromSource: true }).subjectId).toBe("school");
      // bez źródła wskazany przedmiot też wybiera się od startu
      expect(initialLessonValues(catalog, { subjectId: "english_chapter" }).subjectId).toBe("english_chapter");
    });

    it("tekst pochodzi ze źródła: pusty materiał nie blokuje wysyłki", () => {
      const chapterValues = values({ subjectId: "english_chapter", topicId: "", objectiveIds: [], material: "", topicTitle: "Unit 3" });
      expect(canSubmitLesson(chapterValues, catalog)).toBe(false);
      expect(canSubmitLesson(chapterValues, catalog, true)).toBe(true);
      expect(canSubmitLesson({ ...chapterValues, topicTitle: " " }, catalog, true)).toBe(false);
      const schoolValues = values({ subjectId: "school", topicId: "", objectiveIds: [], material: "", topicTitle: "Mapa" });
      expect(canSubmitLesson(schoolValues, catalog, true)).toBe(false);
      expect(canSubmitLesson({ ...schoolValues, schoolSubjectName: "Geografia" }, catalog, true)).toBe(true);
    });

    it("rozdział: polecenie z sourceMaterialId i rewizją treści podglądu, bez materiału", () => {
      const pending = buildCommand(
        values({ subjectId: "english_chapter", topicId: "", objectiveIds: [], topicTitle: "Unit 3", material: "" }),
        "material",
        source,
      );
      expect(pending.kind).toBe("material");
      expect(pending.command).toMatchObject({ subjectId: "english_chapter", topicTitlePl: "Unit 3", sourceMaterialId: SOURCE_ID, expectedSourceRevision: 3 });
      expect(pending.command).not.toHaveProperty("material");
    });

    it("szkoła: polecenie z sourceMaterialId, bez materiału", () => {
      const pending = buildCommand(
        values({ subjectId: "school", topicId: "", objectiveIds: [], schoolSubjectName: "Geografia", topicTitle: "Mapa", material: "ignorowany" }),
        "school",
        source,
      );
      expect(pending.kind).toBe("school");
      expect(pending.command).toMatchObject({ subjectTitlePl: "Geografia", topicTitlePl: "Mapa", sourceMaterialId: SOURCE_ID, expectedSourceRevision: 3 });
      expect(pending.command).not.toHaveProperty("material");
    });

    it("bez źródła polecenie nie niesie rewizji źródła", () => {
      const pending = buildCommand(values({ subjectId: "english_chapter", topicId: "", objectiveIds: [], topicTitle: "Unit 3" }), "material");
      expect(pending.command).not.toHaveProperty("sourceMaterialId");
      expect(pending.command).not.toHaveProperty("expectedSourceRevision");
    });

    it("formularz: podgląd źródła tylko do odczytu i link „Zmień źródło” zamiast pola materiału", () => {
      const queryClient = new QueryClient();
      queryClient.setQueryData(orpc.lessonCatalog.get.queryOptions().queryKey, catalog);
      const markup = renderParentMarkup(
        <NewLessonForm source={source} initialSubjectId="school" onOpenSource={vi.fn()} onCreated={vi.fn()} onCancel={vi.fn()} registerEditorState={vi.fn()} />,
        queryClient,
      );
      expect(markup).not.toContain('data-testid="lesson-material"');
      expect(markup).not.toContain('data-testid="lesson-material-counter"');
      expect(markup).toContain('data-testid="lesson-source"');
      expect(markup).toContain(messages.sources.fromSource.replace("{title}", "Unit 3 — Food"));
      expect(markup).toContain('data-testid="lesson-source-preview"');
      expect(markup).toContain("Do you like apples?");
      const preview = markup.match(/<textarea[^>]*data-testid="lesson-source-preview"[^>]*>/)?.[0] ?? "";
      expect(preview).toMatch(/readonly/i);
      expect(preview).toContain('aria-labelledby="lesson-source-title"');
      expect(preview).not.toMatch(/tabindex/i);
      // „Zmień źródło” prowadzi do listy źródeł, a przycisk u góry wraca do strony źródła
      expect(markup).toContain('data-testid="lesson-source-change"');
      expect(markup).toContain('href="/parent/sources"');
      expect(markup).not.toContain(`href="/parent/sources/${SOURCE_ID}"`);
      expect(markup).toContain(messages.sources.changeSource);
      expect(markup).toContain(messages.sources.backToSource);
      expect(markup).not.toContain(messages.decks.backToList);
      // tylko przedmioty tworzone z materiału; wskazany wybrany od startu
      expect(markup).toContain('value="school" selected=""');
      expect(markup).toContain('value="english_chapter"');
      expect(markup).not.toContain('value="english_grammar"');
      expect(markup).toContain('data-testid="school-subject-name"');
      expect(markup).toContain('value="Unit 3 — Food"');
    });
  });

  describe("odświeżenie źródła po konflikcie rewizji", () => {
    const SOURCE_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    const RUN_ID = "00000000-0000-4000-8000-0000000000aa";
    const source = { id: SOURCE_ID, title: "Unit 3 — Food", body: "I like pizza.", bodyRevision: 3 };
    type Source = typeof source;
    type Refresh = (setSource: (next: Source) => void) => Promise<SourceRefreshOutcome>;
    const sourceChanged = () => new ApiCallError("Konflikt.", "conflict", 409, { reason: "source_changed" });

    beforeEach(() => {
      stubMantineDomApis();
      lessonsApi.createFromMaterial.mockReset();
    });
    afterEach(cleanup);

    /** Formularz ze źródłem w stanie rodzica (jak `NewLessonFromSource`): `refresh` może podmienić źródło. */
    function renderFromSource(refresh: Refresh) {
      const onCreated = vi.fn();
      const registerEditorState = vi.fn();
      const onCancel = vi.fn();
      const onOpenSource = vi.fn();
      function Harness() {
        const [current, setCurrent] = useState(source);
        return (
          <NewLessonForm source={current} initialSubjectId="english_chapter" onOpenSource={onOpenSource} onSourceChanged={() => refresh(setCurrent)}
            onCreated={onCreated} onCancel={onCancel} registerEditorState={registerEditorState} />
        );
      }
      const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
      queryClient.setQueryData(orpc.lessonCatalog.get.queryOptions().queryKey, catalog);
      // formularz zawsze czyta listę dzieci (przyciski tematów) — bez danych w cache sięgnąłby do API
      queryClient.setQueryData(orpc.children.list.queryOptions().queryKey, []);
      render(
        <QueryClientProvider client={queryClient}>
          <MantineProvider theme={parentTheme}><Harness /></MantineProvider>
        </QueryClientProvider>,
      );
      return { onCreated };
    }
    const submitButton = () => screen.getByTestId("lesson-create-submit") as HTMLButtonElement;
    const sentCommand = (call: number) => lessonsApi.createFromMaterial.mock.calls[call]![0] as Record<string, unknown>;

    it("nieudane odświeżenie: tworzenie wyłączone z „Spróbuj ponownie”; udane z nową rewizją — nowe polecenie z tą rewizją", async () => {
      lessonsApi.createFromMaterial
        .mockRejectedValueOnce(sourceChanged())
        .mockImplementationOnce(async (command: { deckId: string }) => ({ runId: RUN_ID, deckId: command.deckId }));
      const refresh = vi.fn<Refresh>()
        .mockResolvedValueOnce({ status: "failed" })
        .mockImplementationOnce(async (setSource) => {
          setSource({ ...source, body: "I like pizza.\nWe like bananas.", bodyRevision: 4 });
          return { status: "refreshed", bodyRevision: 4 };
        });
      const { onCreated } = renderFromSource(refresh);

      fireEvent.click(submitButton());
      await waitFor(() => expect(screen.getByTestId("api-error").textContent).toContain(messages.sources.refreshFailed));
      expect(messages.sources.refreshFailed).toBe("Nie udało się odświeżyć źródła.");
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(submitButton().disabled).toBe(true);
      expect(sentCommand(0)).toMatchObject({ sourceMaterialId: SOURCE_ID, expectedSourceRevision: 3 });
      const retry = screen.getByTestId("lesson-source-refresh-retry");
      expect(retry.textContent).toBe(messages.parentShell.retry);

      fireEvent.click(retry);
      await waitFor(() => expect(submitButton().disabled).toBe(false));
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId("lesson-source-refresh-retry")).toBeNull();
      expect(screen.getByTestId("api-error").textContent).toContain(messages.sources.changedBeforeCreate);
      expect((screen.getByTestId("lesson-source-preview") as HTMLTextAreaElement).value).toContain("We like bananas.");

      fireEvent.click(submitButton());
      await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
      expect(lessonsApi.createFromMaterial).toHaveBeenCalledTimes(2);
      expect(sentCommand(1)).toMatchObject({ sourceMaterialId: SOURCE_ID, expectedSourceRevision: 4 });
      expect(sentCommand(1).clientRequestId).not.toBe(sentCommand(0).clientRequestId);
    });

    it("odświeżenie bez nowej rewizji treści nie odblokowuje tworzenia", async () => {
      lessonsApi.createFromMaterial.mockRejectedValueOnce(sourceChanged());
      renderFromSource(async () => ({ status: "refreshed", bodyRevision: 3 }));

      fireEvent.click(submitButton());
      await waitFor(() => expect(screen.getByTestId("api-error").textContent).toContain(messages.sources.refreshFailed));
      expect(submitButton().disabled).toBe(true);
      expect(screen.getByTestId("lesson-source-refresh-retry")).toBeTruthy();
    });

    it("źródło usunięte (404 przy odświeżeniu): stan usuniętego źródła, bez ponawiania", async () => {
      lessonsApi.createFromMaterial.mockRejectedValueOnce(sourceChanged());
      renderFromSource(async () => ({ status: "missing" }));

      fireEvent.click(submitButton());
      await waitFor(() => expect(screen.getByTestId("api-error").textContent).toContain(messages.sources.notFound));
      expect(submitButton().disabled).toBe(true);
      expect(screen.queryByTestId("lesson-source-refresh-retry")).toBeNull();
      expect(screen.getByTestId("lesson-source-missing-change").getAttribute("href")).toBe("/parent/sources");
      expect(screen.getByTestId("new-lesson-cancel").textContent).toContain(messages.sources.backToList);
    });
  });

  describe("tematy zdań", () => {
    const ola = { id: "c1", displayName: "Ola", interests: ["dinozaury", "Minecraft"] };
    const adam = { id: "c2", displayName: "Adam", interests: [] };
    const SERVICE = "openrouter.ai · google/gemini-3.8-flash";

    it("lessonInterestsOf: lista tylko dla przedmiotu z flagą i niepustej listy", () => {
      expect(lessonInterestsOf(values(), catalog)).toBeUndefined();
      expect(lessonInterestsOf(values({ interests: ["dinozaury", "  Minecraft "] }), catalog)).toEqual(["dinozaury", "Minecraft"]);
      expect(lessonInterestsOf(values({ interests: ["", "  "] }), catalog)).toBeUndefined();
      // zmiana przedmiotu na rozdział lub szkołę (bez flagi) nie wysyła listy
      expect(lessonInterestsOf(values({ subjectId: "english_chapter", topicId: "", interests: ["dinozaury"] }), catalog)).toBeUndefined();
      expect(lessonInterestsOf(values({ subjectId: "school", interests: ["dinozaury"] }), catalog)).toBeUndefined();
      expect(lessonInterestsOf(values({ interests: ["dinozaury"] }), undefined)).toBeUndefined();
    });

    it("wartości startowe: pusta lista tematów (formularz nie wypełnia jej sam)", () => {
      expect(initialLessonValues(catalog).interests).toEqual([]);
    });

    it("niepoprawny temat blokuje wysyłkę gramatyki, ale nie innych przedmiotów", () => {
      expect(canSubmitLesson(values({ interests: ["dinozaury"] }), catalog)).toBe(true);
      expect(canSubmitLesson(values({ interests: ["<b>"] }), catalog)).toBe(false);
      const chapterValues = values({ subjectId: "english_chapter", topicId: "", objectiveIds: [], topicTitle: "Unit 1", interests: ["<b>"] });
      expect(canSubmitLesson(chapterValues, catalog)).toBe(true);
    });

    it("buildCommand: polecenie katalogowe niesie interests tylko przy podanej liście", () => {
      const path = lessonPathOf(catalog, "english_grammar");
      expect(buildCommand(values(), path).command).not.toHaveProperty("interests");
      expect(buildCommand(values(), path, undefined, undefined).command).not.toHaveProperty("interests");
      expect(buildCommand(values(), path, undefined, ["dinozaury"]).command).toMatchObject({ interests: ["dinozaury"] });
    });

    it("sekcja dla gramatyki: pole, przyciski tylko dla dzieci z listą, notka z nazwą usługi", () => {
      const markup = renderWithCatalog(grammar, { children: [ola, adam], generationService: SERVICE });
      expect(markup).toContain('data-testid="lesson-themes"');
      expect(markup).toContain('data-testid="lesson-themes-input"');
      expect(markup).toContain(messages.lessons.themesTitle);
      expect(markup).toContain('data-testid="lesson-themes-insert-c1"');
      expect(markup).toContain(messages.lessons.themesInsert.replace("{name}", "Ola"));
      expect(markup).not.toContain('data-testid="lesson-themes-insert-c2"');
      expect(markup).not.toContain(messages.lessons.themesEmpty);
      expect(markup).toContain(messages.lessons.themesService.replace("{service}", SERVICE));
      // formularz nie wypełnia tematów sam
      expect(markup).not.toContain("dinozaury");
    });

    it("bez dzieci z zainteresowaniami: podpowiedź o profilu; bez nazwy usługi: wariant notki", () => {
      const markup = renderWithCatalog(grammar, { children: [adam] });
      expect(markup).toContain(messages.lessons.themesEmpty);
      expect(markup).not.toContain('data-testid="lesson-themes-insert-c2"');
      expect(markup).toContain(messages.lessons.themesServiceUnknown);
      expect(markup).not.toContain("{service}");
    });

    it("sekcja ukryta dla rozdziału, szkoły i przedmiotu bez flagi", () => {
      for (const subject of [chapter, school, { ...grammar, acceptsInterests: false }]) {
        const markup = renderWithCatalog(subject, { children: [ola] });
        expect(markup, subject.id).not.toContain('data-testid="lesson-themes"');
        expect(markup, subject.id).not.toContain(messages.lessons.themesTitle);
      }
    });

    describe("interakcja", () => {
      const RUN_ID = "00000000-0000-4000-8000-0000000000aa";
      beforeEach(() => {
        stubMantineDomApis();
        if (typeof ResizeObserver === "undefined") {
          vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
        }
        lessonsApi.create.mockReset();
      });
      afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
      });

      function renderInteractive(children: unknown[] | "error" = [ola, adam]) {
        const registerEditorState = vi.fn();
        const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, retryOnMount: false } } });
        queryClient.setQueryData(orpc.lessonCatalog.get.queryOptions().queryKey, catalog);
        if (children === "error") {
          // błąd odczytu listy dzieci: bez danych i bez ponownego pobrania przy montowaniu
          queryClient.getQueryCache().build(queryClient, orpc.children.list.queryOptions()).setState({
            status: "error", error: new Error("boom"), fetchStatus: "idle", data: undefined, dataUpdateCount: 0, dataUpdatedAt: 0,
            errorUpdateCount: 1, errorUpdatedAt: Date.now(), fetchFailureCount: 1, fetchFailureReason: null, fetchMeta: null,
            isInvalidated: false,
          } as never);
        } else {
          queryClient.setQueryData(orpc.children.list.queryOptions().queryKey, children as never);
        }
        render(
          <QueryClientProvider client={queryClient}>
            <MantineProvider theme={parentTheme}>
              <NewLessonForm onCreated={vi.fn()} onCancel={vi.fn()} registerEditorState={registerEditorState} />
            </MantineProvider>
          </QueryClientProvider>,
        );
        return { registerEditorState };
      }
      const pills = () => Array.from(document.querySelectorAll("[data-testid='lesson-themes'] .mantine-Pill-root")).map((el) => el.textContent?.trim());
      const insertButton = (id: string) => screen.getByTestId(`lesson-themes-insert-${id}`) as HTMLButtonElement;

      it("wstawienie dołącza tematy dziecka bez duplikatów, a przycisk gaśnie, gdy wszystkie już są", async () => {
        const { registerEditorState } = renderInteractive();
        expect(pills()).toEqual([]);
        expect(insertButton("c1").disabled).toBe(false);
        fireEvent.click(insertButton("c1"));
        await waitFor(() => expect(pills()).toEqual(["dinozaury", "Minecraft"]));
        expect(insertButton("c1").disabled).toBe(true);
        // wstawione tematy wlicza się do „brudnego” stanu formularza
        await waitFor(() => expect(registerEditorState).toHaveBeenLastCalledWith({ dirty: true, busy: false }));
      });

      it("limit 5 uciął tematy dziecka: wstawienie pokazuje komunikat o limicie, a pełne dołączenie go nie ma", async () => {
        renderInteractive([
          { id: "c1", displayName: "Ola", interests: ["a1", "a2", "a3", "a4"] },
          { id: "c2", displayName: "Adam", interests: ["b1", "b2"] },
          { id: "c3", displayName: "Ewa", interests: ["a1"] },
        ]);
        fireEvent.click(insertButton("c1"));
        await waitFor(() => expect(pills()).toHaveLength(4));
        expect(screen.queryByText(messages.children.interestsLimit.replace("{max}", "5"))).toBeNull();
        fireEvent.click(insertButton("c2"));
        await waitFor(() => expect(pills()).toEqual(["a1", "a2", "a3", "a4", "b1"]));
        expect(screen.getByText(messages.children.interestsLimit.replace("{max}", "5"))).toBeTruthy();
      });

      it("notka o usłudze jest powiązana z polem przez aria-describedby", () => {
        renderInteractive();
        const input = screen.getByTestId("lesson-themes-input");
        const note = screen.getByTestId("lesson-themes-note");
        const describedBy = input.getAttribute("aria-describedby") ?? "";
        expect(describedBy.split(" ")).toContain(note.parentElement!.id);
      });

      it("błąd odczytu dzieci nie pokazuje podpowiedzi o braku zainteresowań w profilach", async () => {
        renderInteractive("error");
        await waitFor(() => expect(screen.getByTestId("lesson-themes")).toBeTruthy());
        expect(screen.queryByTestId("lesson-themes-empty")).toBeNull();
      });

      it("porównanie bez wielkości liter i po normalizacji: pozostałe tematy dołączają się", async () => {
        renderInteractive([{ id: "c1", displayName: "Ola", interests: ["DINOZAURY", "  Minecraft  ", "rowery"] }]);
        fireEvent.click(insertButton("c1"));
        await waitFor(() => expect(pills()).toEqual(["DINOZAURY", "Minecraft", "rowery"]));
        expect(insertButton("c1").disabled).toBe(true);
      });

      it("pełne pole (5 tematów) wyłącza przyciski wstawiania", async () => {
        renderInteractive([{ id: "c1", displayName: "Ola", interests: ["a1", "a2", "a3", "a4", "a5"] }, { id: "c2", displayName: "Adam", interests: ["b1"] }]);
        fireEvent.click(insertButton("c1"));
        await waitFor(() => expect(pills()).toHaveLength(5));
        expect(insertButton("c2").disabled).toBe(true);
      });

      it("polecenie niesie wstawione tematy; ponowienie (hasPending) blokuje pole i przyciski", async () => {
        // brak potwierdzenia przyjęcia = niepewny wynik, polecenie czeka na ponowienie
        lessonsApi.create.mockResolvedValueOnce({}).mockImplementationOnce(async (command: { deckId: string }) => ({ runId: RUN_ID, deckId: command.deckId }));
        renderInteractive();
        fireEvent.change(screen.getByTestId("lesson-material"), { target: { value: "He plays football." } });
        fireEvent.click(insertButton("c1"));
        await waitFor(() => expect(pills()).toEqual(["dinozaury", "Minecraft"]));
        fireEvent.click(screen.getByTestId("lesson-create-submit"));
        await waitFor(() => expect(screen.getByTestId("api-error").textContent).toContain(messages.lessons.createUncertain));
        expect(lessonsApi.create.mock.calls[0]![0]).toMatchObject({ interests: ["dinozaury", "Minecraft"] });
        expect((screen.getByTestId("lesson-themes-input") as HTMLInputElement).disabled).toBe(true);
        expect(insertButton("c1").disabled).toBe(true);
        fireEvent.click(screen.getByTestId("lesson-create-submit"));
        await waitFor(() => expect(lessonsApi.create).toHaveBeenCalledTimes(2));
        expect(lessonsApi.create.mock.calls[1]![0]).toMatchObject({ deckId: lessonsApi.create.mock.calls[0]![0].deckId, interests: ["dinozaury", "Minecraft"] });
      });

      it("zmiana przedmiotu na rozdział ukrywa sekcję", async () => {
        renderInteractive();
        fireEvent.click(insertButton("c1"));
        await waitFor(() => expect(pills()).toHaveLength(2));
        fireEvent.change(screen.getByTestId("lesson-subject"), { target: { value: "english_chapter" } });
        await waitFor(() => expect(screen.queryByTestId("lesson-themes")).toBeNull());
      });
    });
  });

  it("gramatyka: wybór tematu i reguł, licznik do 8000", () => {
    const markup = renderWithCatalog(grammar);
    expect(markup).toContain('data-testid="lesson-topic"');
    expect(markup).toContain('data-testid="lesson-objective-third_person_s"');
    expect(markup).not.toContain('data-testid="school-subject-name"');
    expect(markup).not.toContain('data-testid="material-topic-name"');
    expect(markup).toContain("0/8000 znaków");
    expect(markup).toContain(messages.lessons.poolSizeHint);
    expect(markup).not.toContain(messages.lessons.chapterPoolSizeHint);
  });

  it("dopisek o ćwiczeniach „Posłuchaj i wybierz” przy polu puli: gramatyka i rozdział tak, szkoła nie", () => {
    expect(messages.lessons.listenChoiceCreateNote).toBe("Do puli dodamy najwyżej 2 ćwiczenia „Posłuchaj i wybierz” na regułę.");
    for (const subject of [grammar, chapter]) {
      const markup = renderWithCatalog(subject);
      expect(markup).toContain('data-testid="lesson-listen-choice-note"');
      expect(markup).toContain(messages.lessons.listenChoiceCreateNote);
    }
    const schoolMarkup = renderWithCatalog(school);
    expect(schoolMarkup).not.toContain('data-testid="lesson-listen-choice-note"');
    expect(schoolMarkup).not.toContain(messages.lessons.listenChoiceCreateNote);
  });
});
