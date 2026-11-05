import {
  messages,
  MAX_SCHOOL_MATERIAL_LENGTH,
  MAX_SOURCE_TITLE_LENGTH,
  type SourceMaterialInput,
  type SourceMaterialPatch,
  type SubjectCatalogDto,
} from "@learning/contracts";
import { polishPlural } from "../deck-list-grouping";
import type { ParentRoute } from "../parent-routes";

/**
 * Czysta logika zakładki „Źródła” (design 2026-10-30 §3.4): walidacja pól,
 * patch tylko zmienionych pól, teksty z liczbami i adresy tworzenia lekcji.
 */

export const SOURCE_TITLE_MAX = MAX_SOURCE_TITLE_LENGTH;
export const SOURCE_BODY_MAX = MAX_SCHOOL_MATERIAL_LENGTH;

/** Przedmioty, z których przyciski strony źródła otwierają formularz nowej lekcji. */
export const CHAPTER_SUBJECT_ID = "english_chapter";
export const SCHOOL_SUBJECT_ID = "school";

export type SourceLessonKind = "chapter" | "school";

const SUBJECT_OF_KIND: Record<SourceLessonKind, string> = { chapter: CHAPTER_SUBJECT_ID, school: SCHOOL_SUBJECT_ID };

/**
 * Rodzaje lekcji, które da się utworzyć ze źródła według katalogu: przedmiot
 * musi w nim być i powstawać z materiału — inaczej formularz po cichu wybrałby
 * inny przedmiot. `null`, gdy katalogu jeszcze nie ma (wczytywanie albo błąd;
 * formularz pokaże wtedy własny stan katalogu).
 */
export function sourceLessonKinds(catalog: SubjectCatalogDto | undefined): SourceLessonKind[] | null {
  if (catalog === undefined) return null;
  return (Object.keys(SUBJECT_OF_KIND) as SourceLessonKind[]).filter((kind) =>
    catalog.subjects.some((subject) => subject.id === SUBJECT_OF_KIND[kind] && subject.creation === "material"));
}

/** Wpis katalogu przedmiotu, który otwiera przycisk tworzenia lekcji danego rodzaju (informacje o usługach). */
export function sourceLessonSubject(catalog: SubjectCatalogDto | undefined, kind: SourceLessonKind): SubjectCatalogDto["subjects"][number] | undefined {
  return catalog?.subjects.find((subject) => subject.id === SUBJECT_OF_KIND[kind]);
}

export interface SourceFormValues {
  title: string;
  body: string;
}

/** Tytuł 1–120 i tekst 1–16000 znaków po obcięciu spacji (jak kontrakt i CHECK-i bazy). */
export function sourceValuesValid(values: SourceFormValues): boolean {
  const title = values.title.trim().length;
  const body = values.body.trim().length;
  return title > 0 && title <= SOURCE_TITLE_MAX && body > 0 && body <= SOURCE_BODY_MAX;
}

/**
 * Tekst doszedł do limitu pola (`maxLength` ucina wklejony nadmiar bez
 * ostrzeżenia) — formularz pokazuje wtedy widoczną uwagę o limicie.
 */
export function sourceBodyAtLimit(body: string): boolean {
  return body.length >= SOURCE_BODY_MAX;
}

/** Wpisano coś w okno nowego źródła (zamknięcie pyta wtedy o odrzucenie). */
export function sourceDraftTyped(values: SourceFormValues): boolean {
  return values.title.trim() !== "" || values.body.trim() !== "";
}

/**
 * Edycja źródła: tylko pola różne od zapisanych (po obcięciu spacji, jak na
 * serwerze). `null`, gdy nie ma czego wysłać — pusty zapis podbiłby rewizję
 * i oznaczył zestawy z tego źródła jako utworzone ze starszej wersji.
 */
export function sourcePatch(
  source: { title: string; body: string; revision: number },
  values: SourceFormValues,
): SourceMaterialPatch | null {
  const title = values.title.trim();
  const body = values.body.trim();
  const titleChanged = title !== source.title;
  const bodyChanged = body !== source.body;
  if (!titleChanged && !bodyChanged) return null;
  return {
    expectedRevision: source.revision,
    ...(titleChanged ? { title } : {}),
    ...(bodyChanged ? { body } : {}),
  };
}

/** Polecenie utworzenia źródła z nowym kluczem idempotencji (ponowienie wysyła to samo polecenie). */
export function newSourceCommand(values: SourceFormValues): SourceMaterialInput {
  return { clientRequestId: crypto.randomUUID(), title: values.title.trim(), body: values.body.trim() };
}

export function sourceCounter(length: number): string {
  return messages.sources.counter.replace("{n}", String(length));
}

/** Potwierdzenie usunięcia: liczba zestawów, które stracą odnośnik, albo informacja, że nie ma żadnego. */
export function deleteConfirmText(deckCount: number): string {
  if (deckCount === 0) return messages.sources.deleteConfirmNoDecks;
  return messages.sources.deleteConfirm.replace("{n}", String(deckCount));
}

export function deckCountLabel(count: number): string {
  return (messages.sources.deckCount[polishPlural(count)] ?? "{n}").replace("{n}", String(count));
}

const DATE_FORMAT = new Intl.DateTimeFormat("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric" });

/** Data zmiany źródła (chwila z serwera) w strefie przeglądarki: DD.MM.RRRR. */
export function formatSourceDate(instant: string): string {
  return DATE_FORMAT.format(new Date(instant));
}

/** Formularz nowej lekcji z tekstem źródła i przedmiotem wybranym przyciskiem. */
export function newLessonFromSource(sourceId: string, kind: SourceLessonKind): ParentRoute {
  return {
    section: "decks",
    newLesson: true,
    sourceId,
    subjectId: SUBJECT_OF_KIND[kind],
  };
}

/**
 * Formularz nowego zestawu słówek ze źródła (design 2026-10-30 §6.2). Zawsze
 * dostępny — nie zależy od katalogu przedmiotów lekcji.
 */
export function newVocabularyFromSource(sourceId: string): ParentRoute {
  return { section: "decks", newVocabulary: true, sourceId };
}

/** Widok źródła w panelu: jego strona albo (`null`) lista źródeł. */
export function sourceRoute(sourceId: string | null): ParentRoute {
  return sourceId === null ? { section: "sources" } : { section: "sources", sourceId };
}

/**
 * Wynik polecenia jest niepewny bez odpowiedzi (sieć, limit czasu) albo przy
 * błędzie serwera (5xx) — wtedy ponowienie wysyła to samo polecenie. Odpowiedź
 * 4xx (sesja, walidacja, konflikt) jest ostateczna: polecenie nie zostało wykonane.
 */
export function isUncertainFailure(status: number | undefined): boolean {
  return status === undefined || status >= 500;
}
