import { answersEquivalent, V3_EXERCISE_FIELDS, type V3ExerciseField } from "../../pool-validation";
import type { LessonExerciseDraft, LessonExerciseType, LessonTopic } from "../../types";
import { englishNormalizer } from "../english/normalizer";
import { checkElement, materialLexicon, type ElementCheck } from "./lexicon";
import { trimTrailing } from "./text";

/**
 * Reguły przedmiotu `english_chapter` (design „Angielski — rozdział” §4.1, §4.4):
 * `validateChapterExercise` obowiązuje zawsze (generacja, edycja rodzica,
 * publikacja), a `refineChapterPool` czyści wyłącznie świeże wyjście modelu
 * walidacją słownikową, więc rodzic może dopisać słowo spoza rozdziału.
 * Limit 120 znaków odpowiedzi i jedną lukę w `lesson_gap` pilnuje już walidacja
 * ogólna silnika — przedmiot ich nie powiela (jeden komunikat dla rodzica).
 * Komunikaty po polsku, z nazwą pola — jak reszta walidatorów lekcji.
 */

/**
 * Stałe polecenia typów bez polskiego zdania-bodźca. Takie polecenie nie mówi
 * dziecku, jakie zdanie ma powstać, więc ćwiczenie byłoby zgadywanką.
 */
export const GENERIC_CHAPTER_INSTRUCTIONS: readonly string[] = [
  "Wybierz słowo",
  "Wybierz",
  "Wpisz brakujące słowo",
  "Wpisz słowo",
  "Ułóż zdanie",
  "Uzupełnij",
  "Uzupełnij zdanie",
  "Uzupełnij tekst",
];

/** Najkrótsze polecenie niosące polskie zdanie-bodziec (znaki po przycięciu). */
export const MIN_STIMULUS_INSTRUCTION_LENGTH = 12;

/**
 * Bodziec to polskie zdanie, po którym stoi polecenie („Dziś pada deszcz.
 * Wybierz słowo.”, „Ułóż zdanie: Mam na sobie płaszcz.”): w poleceniu musi
 * być granica zdania (`.!?:`) z dalszym tekstem. Samo polecenie („Wybierz
 * właściwe słowo.”) jej nie ma.
 */
const SENTENCE_THEN_TEXT = /[.!?:]\s+\S/u;

/** Stałe polecenie tłumaczenia (prompt i uzupełnianie brakującego polecenia z modelu). */
export const TRANSLATION_INSTRUCTION = "Przetłumacz na angielski.";

/** Najdłuższy powód odrzucenia w raporcie rodzica (słowo modelu nie tworzy dowolnie długich kluczy). */
export const MAX_REJECTION_REASON_LENGTH = 80;

/** Typy, w których polskie zdanie-bodziec jest w `instructionPl`. */
const STIMULUS_IN_INSTRUCTION: ReadonlySet<LessonExerciseType> = new Set<LessonExerciseType>([
  "lesson_choice",
  "lesson_gap",
  "lesson_order",
  "lesson_cloze",
]);

/** Luka w zdaniu wyboru (luka `lesson_gap` ma już regułę silnika). */
const GAP = /_{2,}/gu;

/** Końcowe znaki pomijane przy porównaniu polecenia; białe znaki są już zredukowane do spacji. */
const INSTRUCTION_TRAILING: ReadonlySet<string> = new Set([".", "!", ":", "…", " "]);

/** Polecenie do porównania ze stałymi: bez wielkości liter, spacji i końcowej kropki. */
function comparableInstruction(text: string): string {
  const collapsed = text.normalize("NFC").replace(/\s+/gu, " ").trim();
  return trimTrailing(collapsed, INSTRUCTION_TRAILING).toLocaleLowerCase("pl-PL");
}

const GENERIC_INSTRUCTION_KEYS: ReadonlySet<string> = new Set(GENERIC_CHAPTER_INSTRUCTIONS.map(comparableInstruction));

function carriesStimulus(instruction: string | undefined): boolean {
  if (instruction === undefined) return false;
  return [...instruction.trim()].length >= MIN_STIMULUS_INSTRUCTION_LENGTH
    && !GENERIC_INSTRUCTION_KEYS.has(comparableInstruction(instruction))
    && SENTENCE_THEN_TEXT.test(instruction);
}

function isBlank(text: string | undefined): boolean {
  return text === undefined || text.trim() === "";
}

export function validateChapterExercise(ex: LessonExerciseDraft, _topic: LessonTopic): string[] {
  const errors: string[] = [];

  if (ex.exerciseType === "lesson_choice") {
    const gaps = ex.stem?.match(GAP)?.length ?? 0;
    if (gaps !== 1) {
      errors.push(`stem: zdanie musi mieć dokładnie jedną lukę „___” (znaleziono ${gaps})`);
    }
  }

  if (STIMULUS_IN_INSTRUCTION.has(ex.exerciseType) && !carriesStimulus(ex.instructionPl)) {
    errors.push("instructionPl: polecenie musi zawierać polskie zdanie, np. „Dziś pada deszcz. Wybierz słowo.”");
  }

  // Bez polecenia dziecko widziałoby tylko tytuł zagadnienia i nie wiedziałoby, że ma tłumaczyć.
  if (ex.exerciseType === "lesson_open_answer" && isBlank(ex.instructionPl)) {
    errors.push(`instructionPl: tłumaczenie wymaga polecenia, np. „${TRANSLATION_INSTRUCTION}”`);
  }

  // Bodziec jest w poleceniu: kartkówka usuwa podpowiedź z luki, więc nie może jej nieść.
  if (ex.hint !== undefined) {
    errors.push("hint: pole niedozwolone w tym przedmiocie — polskie zdanie należy do polecenia");
  }

  if (ex.exerciseType === "lesson_order") {
    // Ocena porównuje identyfikatory klocków: zamiana dwóch „a” dałaby fałszywy błąd.
    const items = ex.items ?? [];
    items.forEach((item, index) => {
      const earlier = items.slice(0, index).find((other) => answersEquivalent(other.text, item.text, englishNormalizer));
      if (earlier !== undefined) {
        errors.push(`items: klocek „${item.text}” powtarza klocek „${earlier.text}” — każdy klocek musi mieć inny tekst`);
      }
    });
  }

  return errors;
}

/** Elementy sprawdzane słownikiem materiału (§4.4); niepowodzenie odrzuca ćwiczenie. */
function checkedElements(ex: LessonExerciseDraft): readonly string[] {
  switch (ex.exerciseType) {
    case "lesson_match":
      return (ex.pairs ?? []).map((pair) => pair.left);
    case "lesson_group":
      return (ex.groupItems ?? []).map((item) => item.text);
    case "lesson_cloze":
      return [...(ex.gapAnswers ?? []), ...(ex.extraWords ?? [])];
    // Wybór ze słuchu: opcje to słowa materiału jak w wyborze; bodźcem jest nagranie, nie polecenie.
    case "lesson_choice":
    case "lesson_listen_choice":
      return (ex.options ?? []).map((option) => option.text);
    case "lesson_order":
    case "lesson_gap":
    case "lesson_open_answer":
      return [ex.answer];
    default:
      return [];
  }
}

/** Typy, w których wariant odpowiedzi spoza materiału jest usuwany, a ćwiczenie zostaje. */
const VARIANT_TYPES: ReadonlySet<LessonExerciseType> = new Set<LessonExerciseType>(["lesson_gap", "lesson_open_answer"]);

/**
 * Pola v3 (przedmioty szkolne), których przedmiot nie żąda: prompt każe zwracać
 * dla nich null, ale prawdziwy model potrafi wypełnić je dla całej partii
 * (próba na prawdziwym modelu: cytaty `sourceRefs` w jednej z czterech partii),
 * a walidacja ogólna odrzuca takie ćwiczenie w całości jako „pole v3
 * niedozwolone”. To niepożądany dodatek modelu, nie dane rodzica, więc na
 * świeżym wyjściu usuwamy go zamiast tracić dobre ćwiczenie. Lista pochodzi z
 * walidacji ogólnej (`V3_EXERCISE_FIELDS`) bez `calculation`: specyfikacja
 * rachunku to nie przypadkowo wypełnione pole, tylko inny typ ćwiczenia, który
 * ma zostać odrzucony przez walidację, a nie po cichu naprawiony.
 */
export const UNSOLICITED_V3_FIELDS: readonly Exclude<V3ExerciseField, "calculation">[] =
  V3_EXERCISE_FIELDS.filter((field): field is Exclude<V3ExerciseField, "calculation"> => field !== "calculation");

function withoutUnsolicitedV3Fields(draft: LessonExerciseDraft): LessonExerciseDraft {
  if (UNSOLICITED_V3_FIELDS.every((field) => draft[field] === undefined)) return draft;
  const copy: Partial<Record<keyof LessonExerciseDraft, unknown>> = { ...draft };
  for (const field of UNSOLICITED_V3_FIELDS) delete copy[field];
  return copy as unknown as LessonExerciseDraft;
}

/**
 * Tłumaczenie bez polecenia z modelu (próba: `instructionPl: null` w 20–50%
 * tłumaczeń) dostaje stałe polecenie — jak usuwanie niezamówionych pól v3, to
 * naprawa świeżego wyjścia modelu, a nie danych rodzica.
 */
function withTranslationInstruction(draft: LessonExerciseDraft): LessonExerciseDraft {
  if (draft.exerciseType !== "lesson_open_answer" || !isBlank(draft.instructionPl)) return draft;
  return { ...draft, instructionPl: TRANSLATION_INSTRUCTION };
}

/** Powód odrzucenia dla rodzica, przycięty do `MAX_REJECTION_REASON_LENGTH` znaków. */
function rejectionReason(failure: Extract<ElementCheck, { ok: false }>): string {
  const prefix = failure.noContentWord === true ? "tylko słowa pomocnicze: " : "słowo spoza materiału: ";
  const chars = [...`${prefix}${failure.unknown}`];
  return chars.length <= MAX_REJECTION_REASON_LENGTH ? chars.join("") : `${chars.slice(0, MAX_REJECTION_REASON_LENGTH - 1).join("")}…`;
}

function firstFailure(elements: readonly string[], lexicon: ReadonlySet<string>): Extract<ElementCheck, { ok: false }> | undefined {
  for (const element of elements) {
    const result = checkElement(element, lexicon);
    if (!result.ok) return result;
  }
  return undefined;
}

/**
 * Walidacja słownikowa świeżo wygenerowanej puli: ćwiczenie, którego element
 * sprawdzany (lewa strona pary, element grupy, słowo luki lub pułapka, opcja,
 * odpowiedź) ma słowo spoza materiału, jest odrzucane z powodem dla rodzica;
 * w luce i tłumaczeniu warianty spoza materiału są usuwane, a ćwiczenie zostaje.
 * Zachowane ćwiczenie traci niezamówione pola v3, a tłumaczenie bez polecenia
 * dostaje `TRANSLATION_INSTRUCTION`. Ćwiczenie zgodne wraca bez kopii.
 */
export function refineChapterPool(
  drafts: readonly LessonExerciseDraft[],
  ctx: { material: string },
): { kept: LessonExerciseDraft[]; rejected: { exercise: LessonExerciseDraft; reason: string }[] } {
  const lexicon = materialLexicon(ctx.material);
  const kept: LessonExerciseDraft[] = [];
  const rejected: { exercise: LessonExerciseDraft; reason: string }[] = [];
  for (const draft of drafts) {
    const failure = firstFailure(checkedElements(draft), lexicon);
    if (failure !== undefined) {
      rejected.push({ exercise: draft, reason: rejectionReason(failure) });
      continue;
    }
    const clean = withTranslationInstruction(withoutUnsolicitedV3Fields(draft));
    if (!VARIANT_TYPES.has(clean.exerciseType)) {
      kept.push(clean);
      continue;
    }
    const variants = clean.acceptedAnswers.filter((variant) => checkElement(variant, lexicon).ok);
    kept.push(variants.length === clean.acceptedAnswers.length ? clean : { ...clean, acceptedAnswers: variants });
  }
  return { kept, rejected };
}
