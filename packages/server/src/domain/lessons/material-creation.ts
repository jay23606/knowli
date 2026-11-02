import type { LessonExerciseDraft, SubjectModule } from "./types";

/**
 * Sposób tworzenia zestawu z materiału rodzica — jedno miejsce dla katalogu
 * przedmiotów (`creation`, `subjectTitleRequired`) i poleceń tworzenia, żeby
 * formularz nie obiecywał ścieżki, którą serwer odrzuci.
 *
 * Przedmiot tworzy zestawy z materiału, gdy składa zagadnienia z materiału
 * (`buildDynamicTopic`) i deklaruje, skąd bierze tytuł przedmiotu
 * (`materialSubjectTitle`): `parent` — nazwę podaje rodzic (szkoła, własne
 * polecenie), `fixed` — stały `titlePl` przedmiotu (rozdział angielskiego).
 * Brak któregokolwiek z tych pól oznacza przedmiot katalogowy.
 */
export type MaterialCreationMode = "parent" | "fixed";

type MaterialCreationSubject = Pick<SubjectModule, "buildDynamicTopic" | "materialSubjectTitle">;

/** Sposób tworzenia z materiału albo `undefined` dla przedmiotu katalogowego. */
export function materialCreationMode(subject: MaterialCreationSubject): MaterialCreationMode | undefined {
  return subject.buildDynamicTopic === undefined ? undefined : subject.materialSubjectTitle;
}

/** Czy rodzic musi podać nazwę przedmiotu własnym tytułem (formularz szkolny). */
export function requiresParentSubjectTitle(subject: MaterialCreationSubject): boolean {
  return materialCreationMode(subject) === "parent";
}

/**
 * Czyści świeże wyjście modelu z pól, których ćwiczenie wyboru ze słuchu nie
 * ma: polecenie dziecka jest stałe z katalogu komunikatów, bodźcem jest
 * nagranie (podpowiedź zdradzałaby odpowiedź), a piktogram należy do wyboru
 * obrazkowego. To niepożądany dodatek modelu, nie dane rodzica — wołaj
 * wyłącznie na świeżo wygenerowanych ćwiczeniach (generacja i dogenerowanie),
 * nigdy w edycji ani publikacji. Inne typy i ćwiczenie bez dodatków wracają
 * bez zmian (ta sama referencja).
 */
export function stripListenChoiceExtras(draft: LessonExerciseDraft): LessonExerciseDraft {
  if (draft.exerciseType !== "lesson_listen_choice") return draft;
  if (draft.instructionPl === undefined && draft.hint === undefined && draft.visualSubject === undefined) return draft;
  const { instructionPl: _instruction, hint: _hint, visualSubject: _visual, ...rest } = draft;
  return rest;
}
