import { describe, expect, it } from "vitest";
import { messages, type SubjectCatalogDto } from "@learning/contracts";
import { routePath } from "../parent-routes";
import {
  CHAPTER_SUBJECT_ID,
  SCHOOL_SUBJECT_ID,
  deckCountLabel,
  deleteConfirmText,
  formatSourceDate,
  isUncertainFailure,
  newLessonFromSource,
  newSourceCommand,
  newVocabularyFromSource,
  sourceBodyAtLimit,
  sourceCounter,
  sourceDraftTyped,
  sourceLessonKinds,
  sourcePatch,
  sourceRoute,
  sourceValuesValid,
} from "./sources-state";

const SOURCE_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const source = { title: "Unit 3 — Food", body: "I like pizza.\nDo you like apples?", revision: 4 };

describe("sources state", () => {
  it("tekst i tytuł: 1–120 i 1–16000 znaków po obcięciu spacji", () => {
    expect(sourceValuesValid({ title: "Unit 3", body: "I like pizza." })).toBe(true);
    expect(sourceValuesValid({ title: "   ", body: "I like pizza." })).toBe(false);
    expect(sourceValuesValid({ title: "Unit 3", body: " \n " })).toBe(false);
    expect(sourceValuesValid({ title: "x".repeat(120), body: "x".repeat(16000) })).toBe(true);
    expect(sourceValuesValid({ title: "x".repeat(121), body: "x" })).toBe(false);
    expect(sourceValuesValid({ title: "x", body: "x".repeat(16001) })).toBe(false);
    // spacje na brzegach nie liczą się do limitu
    expect(sourceValuesValid({ title: ` ${"x".repeat(120)} `, body: ` ${"x".repeat(16000)} ` })).toBe(true);
  });

  describe("sourcePatch: tylko zmienione pola", () => {
    it("bez zmian (także same spacje na brzegach) nie ma czego wysłać", () => {
      expect(sourcePatch(source, { title: source.title, body: source.body })).toBeNull();
      expect(sourcePatch(source, { title: `  ${source.title} `, body: `${source.body}\n` })).toBeNull();
    });

    it("zmieniony tytuł: tylko tytuł z oczekiwaną rewizją", () => {
      expect(sourcePatch(source, { title: " Unit 3 — Jedzenie ", body: source.body }))
        .toEqual({ expectedRevision: 4, title: "Unit 3 — Jedzenie" });
    });

    it("zmieniony tekst: tylko tekst", () => {
      expect(sourcePatch(source, { title: source.title, body: "I like pizza." }))
        .toEqual({ expectedRevision: 4, body: "I like pizza." });
    });

    it("oba pola zmienione: oba", () => {
      expect(sourcePatch(source, { title: "Unit 4", body: "Sport." }))
        .toEqual({ expectedRevision: 4, title: "Unit 4", body: "Sport." });
    });
  });

  it("nowe źródło: przycięte pola i nowy identyfikator żądania przy każdym poleceniu", () => {
    const first = newSourceCommand({ title: "  Unit 3 ", body: " I like pizza. " });
    const second = newSourceCommand({ title: "Unit 3", body: "I like pizza." });
    expect(first).toEqual({ clientRequestId: expect.any(String), title: "Unit 3", body: "I like pizza." });
    expect(first.clientRequestId).not.toBe(second.clientRequestId);
  });

  it("licznik znaków tekstu rozdziału", () => {
    expect(sourceCounter(0)).toBe("0/16000 znaków");
    expect(sourceCounter(1234)).toBe("1234/16000 znaków");
  });

  it("potwierdzenie usunięcia podaje liczbę zestawów, a bez zestawów mówi, że ich nie ma", () => {
    expect(deleteConfirmText(3)).toBe("Usunąć źródło? Zestawy (3) zostaną, stracą tylko odnośnik.");
    expect(deleteConfirmText(1)).toBe("Usunąć źródło? Zestawy (1) zostaną, stracą tylko odnośnik.");
    expect(deleteConfirmText(0)).toBe("Usunąć źródło? Nie powstał z niego żaden zestaw.");
  });

  it("limit tekstu: uwaga od 16000 znaków (pole ucina wklejony nadmiar)", () => {
    expect(sourceBodyAtLimit("x".repeat(15_999))).toBe(false);
    expect(sourceBodyAtLimit("x".repeat(16_000))).toBe(true);
  });

  it("wpisany szkic nowego źródła: tytuł albo tekst inne niż same spacje", () => {
    expect(sourceDraftTyped({ title: "", body: "" })).toBe(false);
    expect(sourceDraftTyped({ title: "  ", body: "\n" })).toBe(false);
    expect(sourceDraftTyped({ title: "Unit 3", body: "" })).toBe(true);
    expect(sourceDraftTyped({ title: "", body: "I like pizza." })).toBe(true);
  });

  it("adres źródła: strona źródła albo lista źródeł", () => {
    expect(sourceRoute(SOURCE_ID)).toEqual({ section: "sources", sourceId: SOURCE_ID });
    expect(sourceRoute(null)).toEqual({ section: "sources" });
  });

  describe("sourceLessonKinds: przyciski tylko dla przedmiotów z katalogu tworzonych z materiału", () => {
    const subject = (id: string, creation: "catalog" | "material") => ({ id, titlePl: id, creation, subjectTitleRequired: id === "school", topics: [] });
    const catalogOf = (...subjects: SubjectCatalogDto["subjects"]): SubjectCatalogDto => ({ lessonGenerationAvailable: true, subjects });

    it("bez katalogu (wczytywanie, błąd) — nieznane", () => {
      expect(sourceLessonKinds(undefined)).toBeNull();
    });

    it("oba przedmioty w katalogu", () => {
      expect(sourceLessonKinds(catalogOf(subject("english_grammar", "catalog"), subject("school", "material"), subject("english_chapter", "material"))))
        .toEqual(["chapter", "school"]);
    });

    it("brakujący przedmiot albo przedmiot spoza ścieżki z materiału — bez przycisku", () => {
      expect(sourceLessonKinds(catalogOf(subject("school", "material")))).toEqual(["school"]);
      expect(sourceLessonKinds(catalogOf(subject("english_chapter", "catalog"), subject("school", "material")))).toEqual(["school"]);
      expect(sourceLessonKinds(catalogOf(subject("english_grammar", "catalog")))).toEqual([]);
    });
  });

  it("liczba zestawów z polską odmianą", () => {
    expect(deckCountLabel(0)).toBe("0 zestawów");
    expect(deckCountLabel(1)).toBe("1 zestaw");
    expect(deckCountLabel(3)).toBe("3 zestawy");
    expect(deckCountLabel(5)).toBe("5 zestawów");
    expect(deckCountLabel(22)).toBe("22 zestawy");
  });

  it("data zmiany w formacie DD.MM.RRRR", () => {
    expect(formatSourceDate("2026-10-31T12:00:00.000Z")).toBe("31.10.2026");
    expect(formatSourceDate("2026-01-05T12:00:00Z")).toBe("05.01.2026");
  });

  it("przyciski tworzenia prowadzą do formularza nowej lekcji ze źródłem i przedmiotem", () => {
    expect(newLessonFromSource(SOURCE_ID, "chapter"))
      .toEqual({ section: "decks", newLesson: true, sourceId: SOURCE_ID, subjectId: CHAPTER_SUBJECT_ID });
    expect(newLessonFromSource(SOURCE_ID, "school"))
      .toEqual({ section: "decks", newLesson: true, sourceId: SOURCE_ID, subjectId: SCHOOL_SUBJECT_ID });
    expect(CHAPTER_SUBJECT_ID).toBe("english_chapter");
    expect(SCHOOL_SUBJECT_ID).toBe("school");
  });

  it("przycisk zestawu słówek prowadzi do formularza zestawu ze źródłem", () => {
    expect(newVocabularyFromSource(SOURCE_ID)).toEqual({ section: "decks", newVocabulary: true, sourceId: SOURCE_ID });
    expect(routePath(newVocabularyFromSource(SOURCE_ID))).toBe(`/parent/vocabulary/new?source=${SOURCE_ID}`);
  });

  it("niepewny wynik polecenia: brak odpowiedzi albo błąd serwera; 4xx jest ostateczne", () => {
    expect(isUncertainFailure(undefined)).toBe(true);
    expect(isUncertainFailure(500)).toBe(true);
    expect(isUncertainFailure(503)).toBe(true);
    for (const status of [400, 401, 403, 404, 409]) expect(isUncertainFailure(status), String(status)).toBe(false);
  });

  it("komunikaty zakładki mają brzmienie z planu", () => {
    expect(messages.sources).toMatchObject({
      tab: "Źródła",
      newSource: "Nowe źródło",
      titleLabel: "Tytuł",
      bodyLabel: "Tekst rozdziału",
      bodyHint: "Wklej opracowanie rozdziału (np. z NotebookLM).",
      counter: "{n}/16000 znaków",
      createChapterLesson: "Utwórz lekcję rozdziału",
      createSchoolLesson: "Utwórz lekcję szkolną",
      decksHeading: "Zestawy z tego źródła",
      deleteConfirm: "Usunąć źródło? Zestawy ({n}) zostaną, stracą tylko odnośnik.",
      conflict: "Źródło zmieniono w innym oknie. Odśwież, aby zobaczyć najnowszą wersję.",
      empty: "Nie masz jeszcze źródeł.",
      fromSource: "Ze źródła: {title}",
      sourceChanged: "Źródło zmieniono od utworzenia tego zestawu.",
    });
  });

  it("komunikaty po przeglądzie: neutralne, bez podwójnych nazw i z jasnym skutkiem edycji", () => {
    expect(messages.sources).toMatchObject({
      deleteConfirmNoDecks: "Usunąć źródło? Nie powstał z niego żaden zestaw.",
      notFound: "Nie ma takiego źródła. Mogło zostać usunięte.",
      updatedAt: "Ostatnia zmiana {date}",
      editHint: "Zmiana nie zmieni istniejących zestawów. Aby jej użyć, utwórz nową lekcję.",
      backToSource: "Wróć do źródła",
    });
    // nagłówek podglądu i etykieta pola edycji nazywają ten sam tekst tak samo
    expect(messages.sources.previewLabel).toBe(messages.sources.bodyLabel);
    // okno wyjścia służy wszystkim edytorom panelu — bez „w tym zestawie”
    expect(messages.decks.leaveDescription).toBe("Jeśli teraz wyjdziesz, niezapisane zmiany przepadną.");
  });
});
