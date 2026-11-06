import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { messages, type SourceMaterialDto, type SourceMaterialSummaryDto, type SubjectCatalogDto } from "@learning/contracts";
import SourcesPanel from "./SourcesPanel";
import SourcePage from "./SourcePage";
import { ApiCallError } from "../api";
import { orpc } from "../query-client";
import { renderParentMarkup } from "../test-render";

const SOURCE_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const SECOND_ID = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";

const summaries: SourceMaterialSummaryDto[] = [
  { id: SOURCE_ID, title: "Unit 3 — Food", revision: 2, createdAt: "2026-10-30T12:00:00.000Z", updatedAt: "2026-10-31T12:00:00.000Z", deckCount: 2 },
  { id: SECOND_ID, title: "Rozdział 4: Mapa", revision: 1, createdAt: "2026-10-29T12:00:00.000Z", updatedAt: "2026-10-29T12:00:00.000Z", deckCount: 1 },
];

const source: SourceMaterialDto = {
  ...summaries[0]!,
  // jeden z dwóch zestawów jest zarchiwizowany — deckCount go pomija (jak na serwerze)
  deckCount: 1,
  bodyRevision: 2,
  body: "I like pizza.\nDo you like apples?",
  decks: [
    { deckId: "10000000-0000-4000-8000-000000000001", title: "Angielski — rozdział: Unit 3", kind: "lesson", state: "published", copiedRevision: 1, stale: true },
    { deckId: "10000000-0000-4000-8000-000000000002", title: "Jedzenie", kind: "lesson", state: "archived", copiedRevision: 2, stale: false },
  ],
};

function withList(list: SourceMaterialSummaryDto[]): QueryClient {
  const queryClient = new QueryClient();
  queryClient.setQueryData(orpc.sources.list.queryOptions().queryKey, list);
  return queryClient;
}

const fullCatalog: SubjectCatalogDto = {
  lessonGenerationAvailable: true,
  subjects: [
    { id: "english_grammar", titlePl: "Gramatyka angielska", creation: "catalog", subjectTitleRequired: false, topics: [] },
    { id: "school", titlePl: "Przedmiot szkolny", creation: "material", subjectTitleRequired: true, topics: [] },
    { id: "english_chapter", titlePl: "Angielski — rozdział", creation: "material", subjectTitleRequired: false, topics: [] },
  ],
};

function withSource(dto: SourceMaterialDto, catalog: SubjectCatalogDto | null = fullCatalog): QueryClient {
  const queryClient = new QueryClient();
  queryClient.setQueryData(orpc.sources.get.queryOptions({ input: { sourceId: dto.id } }).queryKey, dto);
  if (catalog) queryClient.setQueryData(orpc.lessonCatalog.get.queryOptions().queryKey, catalog);
  return queryClient;
}

const handlers = () => ({ onNavigate: vi.fn(), registerEditorState: vi.fn() });

describe("SourcesPanel", () => {
  it("lista: tytuł, data zmiany i liczba zestawów; przycisk nowego źródła", () => {
    const markup = renderParentMarkup(<SourcesPanel route={{ section: "sources" }} {...handlers()} />, withList(summaries));
    expect(markup).toContain('data-testid="sources-panel"');
    expect(markup).toContain(messages.sources.tab);
    expect(markup).toContain('data-testid="new-source-open"');
    expect(markup).toContain(messages.sources.newSource);
    expect(markup).toContain('data-testid="source-row-0"');
    expect(markup).toContain(`data-source-id="${SOURCE_ID}"`);
    expect(markup).toContain("Unit 3 — Food");
    expect(markup).toContain("31.10.2026");
    expect(markup).toContain("2 zestawy");
    expect(markup).toContain('data-testid="source-row-1"');
    expect(markup).toContain("1 zestaw");
    expect(markup).not.toContain(messages.sources.empty);
  });

  it("pusta lista: komunikat bez źródeł", () => {
    const markup = renderParentMarkup(<SourcesPanel route={{ section: "sources" }} {...handlers()} />, withList([]));
    expect(markup).toContain(messages.sources.empty);
    expect(markup).not.toContain('data-testid="source-row-0"');
  });

  it("adres źródła otwiera jego stronę", () => {
    const markup = renderParentMarkup(<SourcesPanel route={{ section: "sources", sourceId: SOURCE_ID }} {...handlers()} />, withSource(source));
    expect(markup).toContain('data-testid="source-page"');
    expect(markup).not.toContain('data-testid="new-source-open"');
  });
});

describe("SourcePage", () => {
  it("podgląd tekstu, przyciski tworzenia lekcji, edycja i usunięcie", () => {
    const markup = renderParentMarkup(<SourcePage sourceId={SOURCE_ID} {...handlers()} />, withSource(source));
    expect(markup).toContain('data-testid="source-back"');
    expect(markup).toContain("Unit 3 — Food");
    expect(markup).toContain('data-testid="source-preview"');
    expect(markup).toContain("Do you like apples?");
    // podgląd to natywne pole tylko do odczytu nazwane nagłówkiem — bez tabIndex na zwykłym div
    const preview = markup.match(/<textarea[^>]*data-testid="source-preview"[^>]*>/)?.[0] ?? "";
    expect(preview).toMatch(/readonly/i);
    expect(preview).toContain('aria-labelledby="source-preview-label"');
    expect(preview).not.toMatch(/tabindex/i);
    expect(markup).not.toContain('role="region"');
    expect(markup).toContain('data-testid="source-create-chapter"');
    expect(markup).toContain(messages.sources.createChapterLesson);
    expect(markup).toContain('data-testid="source-create-school"');
    expect(markup).toContain(messages.sources.createSchoolLesson);
    expect(markup).toContain('data-testid="source-edit"');
    expect(markup).toContain('data-testid="source-delete"');
    // podgląd jest tylko do odczytu — pola edycji pojawiają się dopiero po „Edytuj”
    expect(markup).not.toContain('data-testid="source-body"');
  });

  describe("przedmioty z agentem puli (checkService)", () => {
    const GEN = ["openrouter.ai · a", "openrouter.ai · b"];
    const CHECK = "openrouter.ai · c";
    const agentCatalog = (chapterOnly: boolean): SubjectCatalogDto => ({
      lessonGenerationAvailable: true,
      subjects: [
        fullCatalog.subjects[0]!,
        { ...fullCatalog.subjects[1]!, generationServices: GEN, checkService: CHECK, checkServiceIncludesMaterial: true },
        chapterOnly ? { ...fullCatalog.subjects[2]!, generationServices: GEN, checkService: CHECK } : fullCatalog.subjects[2]!,
      ],
    });

    it("usługi generowania i drugi model w wariancie szkolnym (z materiałem)", () => {
      const both = renderParentMarkup(<SourcePage sourceId={SOURCE_ID} {...handlers()} />, withSource(source, agentCatalog(true)));
      expect(both).toContain(messages.lessons.generationServicesInfo.replace("{service}", GEN.join(", ")));
      // te same usługi generowania przy obu przyciskach: komunikat tylko raz
      expect(both).toContain('data-testid="source-generation-service-chapter"');
      expect(both).not.toContain('data-testid="source-generation-service-school"');
      expect(both).toContain('data-testid="source-check-service-school"');
      expect(both).toContain(messages.lessons.checkServiceInfoWithMaterial.replace("{service}", CHECK));
      expect(both).toContain('data-testid="source-check-service-chapter"');
      expect(both).toContain(messages.lessons.checkServiceInfo.replace("{service}", CHECK));

      const mixed = renderParentMarkup(<SourcePage sourceId={SOURCE_ID} {...handlers()} />, withSource(source, agentCatalog(false)));
      expect(mixed).toContain('data-testid="source-check-service-school"');
      expect(mixed).not.toContain('data-testid="source-check-service-chapter"');
    });

    it("ocena pytań otwartych: komunikat tylko przy przedmiocie z openCheckService", () => {
      const OPEN = "openrouter.ai · g";
      const catalog: SubjectCatalogDto = {
        ...agentCatalog(true),
        subjects: agentCatalog(true).subjects.map((s) => (s.id === fullCatalog.subjects[1]!.id ? { ...s, openCheckService: OPEN } : s)),
      };
      const markup = renderParentMarkup(<SourcePage sourceId={SOURCE_ID} {...handlers()} />, withSource(source, catalog));
      expect(markup).toContain('data-testid="source-open-check-service-school"');
      expect(markup).toContain(messages.lessons.openCheckServiceInfo.replace("{service}", OPEN));
      expect(markup).not.toContain('data-testid="source-open-check-service-chapter"');
    });

    it("bez checkService nie ma komunikatów agenta", () => {
      const markup = renderParentMarkup(<SourcePage sourceId={SOURCE_ID} {...handlers()} />, withSource(source, fullCatalog));
      expect(markup).not.toContain('data-testid="source-check-service-school"');
      expect(markup).not.toContain('data-testid="source-generation-service-school"');
    });
  });

  it("zestawy z tego źródła: tytuł, stan i notka o zmianie źródła", () => {
    const markup = renderParentMarkup(<SourcePage sourceId={SOURCE_ID} {...handlers()} />, withSource(source));
    expect(markup).toContain(messages.sources.decksHeading);
    expect(markup).toContain('data-testid="source-deck-0"');
    expect(markup).toContain("Angielski — rozdział: Unit 3");
    expect(markup).toContain('data-testid="source-deck-1"');
    expect(markup).toContain(messages.decks.states.archived);
    expect(markup).toContain('data-testid="source-deck-stale-0"');
    expect(markup).not.toContain('data-testid="source-deck-stale-1"');
  });

  it("nagłówek liczy zestawy bez zarchiwizowanych, jak lista źródeł", () => {
    const markup = renderParentMarkup(<SourcePage sourceId={SOURCE_ID} {...handlers()} />, withSource(source));
    expect(markup).toMatch(/data-testid="source-meta"[^>]*>[^<]*1 zestaw</);
    expect(markup).not.toContain("2 zestawy");
  });

  it("źródło bez zestawów: komunikat zamiast listy", () => {
    const markup = renderParentMarkup(<SourcePage sourceId={SOURCE_ID} {...handlers()} />, withSource({ ...source, decks: [] }));
    expect(markup).toContain('data-testid="source-no-decks"');
    expect(markup).toContain(messages.sources.noDecks);
  });

  it("podgląd ma nagłówek „Tekst rozdziału”, a data zmiany — „Ostatnia zmiana”", () => {
    const markup = renderParentMarkup(<SourcePage sourceId={SOURCE_ID} {...handlers()} />, withSource(source));
    expect(markup).toMatch(/id="source-preview-label"[^>]*>Tekst rozdziału</);
    expect(markup).toContain("Ostatnia zmiana 31.10.2026");
  });

  it("stały, początkowo pusty region na żywo dla „Zapisano zmiany.”", () => {
    const markup = renderParentMarkup(<SourcePage sourceId={SOURCE_ID} {...handlers()} />, withSource(source));
    expect(markup).toMatch(/<p[^>]*role="status"[^>]*data-testid="source-status"[^>]*><\/p>/);
    expect(markup).not.toContain(messages.sources.saved);
  });

  describe("przyciski tworzenia lekcji według katalogu", () => {
    it("oba przedmioty w katalogu: oba przyciski aktywne", () => {
      const markup = renderParentMarkup(<SourcePage sourceId={SOURCE_ID} {...handlers()} />, withSource(source));
      expect(markup).toMatch(/<button(?![^>]*disabled)[^>]*data-testid="source-create-chapter"/);
      expect(markup).toMatch(/<button(?![^>]*disabled)[^>]*data-testid="source-create-school"/);
      expect(markup).not.toContain('data-testid="source-no-lesson-subjects"');
    });

    it("bez klucza (lessonGenerationAvailable: false): przyciski lekcji wyłączone z komunikatem, zestaw słówek aktywny", () => {
      const markup = renderParentMarkup(<SourcePage sourceId={SOURCE_ID} {...handlers()} />, withSource(source, { ...fullCatalog, lessonGenerationAvailable: false }));
      expect(markup).toMatch(/<button[^>]*disabled=""[^>]*data-testid="source-create-chapter"/);
      expect(markup).toMatch(/<button[^>]*disabled=""[^>]*data-testid="source-create-school"/);
      expect(markup).toMatch(/<button(?![^>]*disabled)[^>]*data-testid="source-create-vocabulary"/);
      expect(markup).toContain('data-testid="source-generation-unavailable"');
      expect(markup).toContain(messages.lessons.generationErrors.lesson_agent_unavailable);
      const available = renderParentMarkup(<SourcePage sourceId={SOURCE_ID} {...handlers()} />, withSource(source));
      expect(available).not.toContain('data-testid="source-generation-unavailable"');
    });

    it("katalog jeszcze się wczytuje: przyciski są, ale wyłączone", () => {
      const markup = renderParentMarkup(<SourcePage sourceId={SOURCE_ID} {...handlers()} />, withSource(source, null));
      expect(markup).toMatch(/<button[^>]*disabled=""[^>]*data-testid="source-create-chapter"/);
      expect(markup).toMatch(/<button[^>]*disabled=""[^>]*data-testid="source-create-school"/);
    });

    it("przedmiotu nie ma w katalogu: bez jego przycisku (formularz nie wybierze innego przedmiotu)", () => {
      const schoolOnly = { lessonGenerationAvailable: true, subjects: fullCatalog.subjects.filter((subject) => subject.id !== "english_chapter") };
      const markup = renderParentMarkup(<SourcePage sourceId={SOURCE_ID} {...handlers()} />, withSource(source, schoolOnly));
      expect(markup).not.toContain('data-testid="source-create-chapter"');
      expect(markup).toContain('data-testid="source-create-school"');

      const none = { lessonGenerationAvailable: true, subjects: fullCatalog.subjects.filter((subject) => subject.creation !== "material") };
      const empty = renderParentMarkup(<SourcePage sourceId={SOURCE_ID} {...handlers()} />, withSource(source, none));
      expect(empty).not.toContain('data-testid="source-create-chapter"');
      expect(empty).not.toContain('data-testid="source-create-school"');
      expect(empty).toContain(messages.sources.noLessonSubjects);
    });
  });

  describe("przycisk zestawu słówek ze źródła", () => {
    const vocabularyButton = /<button(?![^>]*disabled)[^>]*data-testid="source-create-vocabulary"/;

    it("jest obok przycisków lekcji i aktywny", () => {
      const markup = renderParentMarkup(<SourcePage sourceId={SOURCE_ID} {...handlers()} />, withSource(source));
      expect(markup).toMatch(vocabularyButton);
      expect(markup).toContain(messages.sources.createVocabulary);
      expect(messages.sources.createVocabulary).toBe("Utwórz zestaw słówek");
      // w jednym rzędzie akcji z przyciskami lekcji
      const actions = markup.match(/<div class="pp-source-actions">[\s\S]*?<\/div>/)?.[0] ?? "";
      expect(actions).toContain('data-testid="source-create-chapter"');
      expect(actions).toContain('data-testid="source-create-vocabulary"');
    });

    it("nie zależy od katalogu lekcji: aktywny w trakcie wczytywania i bez przedmiotów z materiału", () => {
      const loading = renderParentMarkup(<SourcePage sourceId={SOURCE_ID} {...handlers()} />, withSource(source, null));
      expect(loading).toMatch(vocabularyButton);

      const none = { lessonGenerationAvailable: true, subjects: fullCatalog.subjects.filter((subject) => subject.creation !== "material") };
      const empty = renderParentMarkup(<SourcePage sourceId={SOURCE_ID} {...handlers()} />, withSource(source, none));
      expect(empty).toMatch(vocabularyButton);
      expect(empty).toContain(messages.sources.noLessonSubjects);
    });
  });

  it("źródło usunięte w innym oknie: odświeżenie z 404 pokazuje brak źródła mimo danych w pamięci", () => {
    const queryClient = withSource(source);
    const key = orpc.sources.get.queryOptions({ input: { sourceId: SOURCE_ID } }).queryKey;
    queryClient.getQueryCache().find({ queryKey: key })!.setState({
      status: "error",
      error: new ApiCallError("Nie znaleziono.", "not_found", 404),
    });
    const markup = renderParentMarkup(<SourcePage sourceId={SOURCE_ID} {...handlers()} />, queryClient);
    expect(markup).toContain('data-testid="source-not-found"');
    expect(markup).toContain(messages.sources.notFound);
    expect(markup).toContain('data-testid="source-back"');
    expect(markup).not.toContain('data-testid="source-page"');
    expect(markup).not.toContain("Do you like apples?");
  });

  it("inny błąd odświeżenia z danymi w pamięci: strona zostaje", () => {
    const queryClient = withSource(source);
    const key = orpc.sources.get.queryOptions({ input: { sourceId: SOURCE_ID } }).queryKey;
    queryClient.getQueryCache().find({ queryKey: key })!.setState({
      status: "error",
      error: new ApiCallError("Błąd serwera.", "internal", 500),
    });
    const markup = renderParentMarkup(<SourcePage sourceId={SOURCE_ID} {...handlers()} />, queryClient);
    expect(markup).toContain('data-testid="source-page"');
  });
});
