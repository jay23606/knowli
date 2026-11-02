/**
 * Adresy panelu rodzica (plan 2026-10-29-parent-ui-mantine, §4.1).
 * Czysta logika: odczyt widoku z adresu i adres widoku.
 */

/** Sekcje z zakładką w pasku nawigacji. */
export const TAB_SECTIONS = ["decks", "sources", "children", "progress", "work-card"] as const;

export type TabSection = (typeof TAB_SECTIONS)[number];

/** Wszystkie sekcje adresowalne: zakładki oraz Koszty (pozycja menu, nie zakładka). */
export const PARENT_SECTIONS = [...TAB_SECTIONS, "costs"] as const;

export type ParentSection = (typeof PARENT_SECTIONS)[number];

/**
 * Widok panelu: sekcja, a w niej opcjonalnie otwarty zestaw, nowa lekcja albo
 * nowy zestaw słówek ze źródła (Zestawy) lub otwarte źródło (Źródła). Nowa
 * lekcja ze źródła niesie `sourceId` i wskazany przedmiot `subjectId`
 * w parametrach adresu; nowy zestaw słówek — zawsze `sourceId` (bez źródła
 * nie ma tego formularza).
 */
export interface ParentRoute {
  section: ParentSection;
  deckId?: string;
  newLesson?: true;
  newVocabulary?: true;
  sourceId?: string;
  subjectId?: string;
}

export const PARENT_ROOT = "/parent";
export const DEFAULT_SECTION: ParentSection = "decks";
export const DEFAULT_ROUTE: ParentRoute = { section: DEFAULT_SECTION };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Identyfikator przedmiotu z katalogu lekcji (np. `english_chapter`; kontrakt: do 64 znaków). */
const SUBJECT_ID = /^[a-z][a-z0-9_]{0,63}$/;

export function sectionPath(section: ParentSection): string {
  return `${PARENT_ROOT}/${section}`;
}

export function routePath(route: ParentRoute): string {
  if (route.deckId !== undefined) return `${sectionPath("decks")}/${route.deckId}`;
  if (route.newLesson) {
    const params = new URLSearchParams();
    if (route.sourceId !== undefined) params.set("source", route.sourceId);
    if (route.subjectId !== undefined) params.set("subject", route.subjectId);
    const query = params.toString();
    return `${PARENT_ROOT}/lessons/new${query ? `?${query}` : ""}`;
  }
  if (route.newVocabulary) {
    const query = route.sourceId !== undefined ? `?${new URLSearchParams({ source: route.sourceId }).toString()}` : "";
    return `${PARENT_ROOT}/vocabulary/new${query}`;
  }
  if (route.section === "sources" && route.sourceId !== undefined) return `${sectionPath("sources")}/${route.sourceId}`;
  return sectionPath(route.section);
}

/** Parametry nowej lekcji ze źródła; nieprawidłowe wartości pomijamy (adres mógł być ręcznie zmieniony). */
function newLessonRoute(query: string): ParentRoute {
  const params = new URLSearchParams(query);
  const source = params.get("source");
  const subject = params.get("subject");
  return {
    section: "decks",
    newLesson: true,
    ...(source !== null && UUID.test(source) ? { sourceId: source.toLowerCase() } : {}),
    ...(subject !== null && SUBJECT_ID.test(subject) ? { subjectId: subject } : {}),
  };
}

/**
 * Nowy zestaw słówek ze źródła: bez prawidłowego `source` formularz nie ma
 * z czego tworzyć, więc adres nie ma widoku (panel przejdzie do domyślnej sekcji).
 */
function newVocabularyRoute(query: string): ParentRoute | null {
  const source = new URLSearchParams(query).get("source");
  if (source === null || !UUID.test(source)) return null;
  return { section: "decks", newVocabulary: true, sourceId: source.toLowerCase() };
}

/**
 * Widok dla ścieżki z adresu (z opcjonalnymi parametrami `?…`). `null` dla
 * `/parent` i adresów nieznanych — panel zastępuje je adresem domyślnej
 * sekcji (bez nowego wpisu historii).
 */
export function routeFromPath(location: string): ParentRoute | null {
  const queryStart = location.indexOf("?");
  const pathname = queryStart === -1 ? location : location.slice(0, queryStart);
  const query = queryStart === -1 ? "" : location.slice(queryStart + 1);
  const segments = pathname.split("/").filter(Boolean);
  if (`/${segments[0]}` !== PARENT_ROOT) return null;
  const [, first, second] = segments;
  if (segments.length === 2 && (PARENT_SECTIONS as readonly string[]).includes(first!)) {
    return { section: first as ParentSection };
  }
  if (segments.length === 3 && first === "decks" && UUID.test(second!)) {
    return { section: "decks", deckId: second!.toLowerCase() };
  }
  if (segments.length === 3 && first === "sources" && UUID.test(second!)) {
    return { section: "sources", sourceId: second!.toLowerCase() };
  }
  if (segments.length === 3 && first === "lessons" && second === "new") {
    return newLessonRoute(query);
  }
  if (segments.length === 3 && first === "vocabulary" && second === "new") {
    return newVocabularyRoute(query);
  }
  return null;
}
