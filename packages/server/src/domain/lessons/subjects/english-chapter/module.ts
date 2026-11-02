import type {
  DynamicObjectiveKind,
  DynamicTopicData,
  ErrorCategory,
  ErrorCategoryCode,
  LessonExerciseType,
  LessonTopic,
  SubjectModule,
} from "../../types";
import { englishNormalizer } from "../english/normalizer";
import { chapterExposureText, normalizeChapterExposureText } from "./exposure";
import { englishChapterPrompts } from "./prompts";
import { refineChapterPool, validateChapterExercise } from "./validators";

/**
 * Przedmiot `english_chapter` — „Angielski — rozdział” (design §4). Rodzic
 * wkleja rozdział podręcznika (listy słów, zwroty, ramy zdaniowe), a lekcja
 * ćwiczy je zadaniami jak w zeszycie ćwiczeń: odpowiedzi po angielsku,
 * polskie zdanie-bodziec w poleceniu. Katalog w kodzie jest pusty: zagadnienia
 * powstają z materiału (`lesson_context.dynamicTopic`), a `buildDynamicTopic`
 * dobiera typy ćwiczeń do rodzaju zagadnienia (`words` albo `frame`). Bez
 * cytatów źródłowych, payloadu v3 i oceny dwuwymiarowej. Rejestracja = ten
 * obiekt + wpis w `subjects/index.ts`.
 */

/** Typy ćwiczeń przedmiotu (karta plus zadania etapów guided, productive i independent). */
export const CHAPTER_EXERCISE_TYPES: readonly LessonExerciseType[] = [
  "lesson_card",
  "lesson_match",
  "lesson_group",
  "lesson_cloze",
  "lesson_choice",
  "lesson_listen_choice",
  "lesson_order",
  "lesson_gap",
  "lesson_open_answer",
];

/** Typy zagadnienia według rodzaju (§4.2): grupa słów albo rama zdaniowa. */
const TYPES_BY_KIND: Readonly<Record<DynamicObjectiveKind, readonly LessonExerciseType[]>> = {
  words: ["lesson_card", "lesson_match", "lesson_group", "lesson_choice", "lesson_listen_choice", "lesson_cloze", "lesson_gap", "lesson_open_answer"],
  frame: ["lesson_card", "lesson_match", "lesson_order", "lesson_choice", "lesson_listen_choice", "lesson_cloze", "lesson_gap", "lesson_open_answer"],
};

/** Kategorie przedmiotu; brakujące słowo i szyk to bazowe `incomplete` i `wrong_order`. */
export const CHAPTER_ERROR_CATEGORIES: readonly ErrorCategory[] = [
  { code: "wrong_word", labelPl: "Pomylone słowo" },
  { code: "spelling", labelPl: "Pisownia" },
];

/** Kategorie każdego zagadnienia (przedmiotowe + bazowe). */
const OBJECTIVE_CATEGORIES: readonly ErrorCategoryCode[] = ["wrong_word", "spelling", "incomplete", "wrong_order"];

/** Podpowiedzi dla dziecka: krótko, po polsku, bez zdradzania odpowiedzi. */
const OBJECTIVE_HINTS: Readonly<Record<ErrorCategoryCode, string>> = {
  // Karty nie da się otworzyć w trakcie sesji — podpowiedź odsyła do pamięci, nie do karty.
  wrong_word: "To inne słowo. Przypomnij sobie słowa z karty.",
  spelling: "Sprawdź litery w tym słowie.",
  incomplete: "Brakuje słowa. Dopisz je.",
  wrong_order: "Słowa są w złej kolejności.",
  other: "Spróbuj jeszcze raz.",
};

export const englishChapterSubject: SubjectModule = {
  id: "english_chapter",
  titlePl: "Angielski — rozdział",
  answerLocale: "en-GB",
  promptLocale: "pl-PL",
  // Tłumaczenie: polskie zdanie, angielska odpowiedź.
  openAnswerPromptLocale: "pl-PL",
  exerciseTypes: CHAPTER_EXERCISE_TYPES,
  errorCategories: CHAPTER_ERROR_CATEGORIES,
  normalizer: englishNormalizer,
  topics: [],
  prompts: englishChapterPrompts,
  // To samo zdanie z innym polskim bodźcem to inne ćwiczenie; krótkie odpowiedzi się powtarzają.
  poolDeduplication: "exercise",
  poolMinimums: { guided: 3, productive: 3, independent: 2 },
  // Zgodność z materiałem sprawdza słownik rozdziału, nie cytaty.
  sourceQuotes: false,
  // Tytuł przedmiotu zestawu to stałe „Angielski — rozdział”.
  materialSubjectTitle: "fixed",
  instructionIsStimulus: true,
  exposureText: chapterExposureText,
  // Ta sama normalizacja dla ćwiczeń i przykładów kart (jeden klucz zdania).
  normalizeExposureText: normalizeChapterExposureText,
  refineGeneratedPool: refineChapterPool,
  validateExercise: validateChapterExercise,
  // Audio odpowiedzi ujawniałoby rozwiązanie; polecenia są krótkie i po polsku.
  ttsForAnswers: false,
  ttsForPrompts: false,
  // Po ocenionej odpowiedzi lektor czyta pełne poprawne zdanie po angielsku (en-GB, bez stylu pl-PL):
  // wybór z luką, luka, luki z bankiem, układanka, tłumaczenie (spec 2026-10-30-lesson-sentence-readback).
  ttsForFeedbackSentence: true,
  buildDynamicTopic(data: DynamicTopicData): LessonTopic {
    return {
      id: "dynamic",
      version: 1,
      titlePl: data.titlePl,
      extraErrorCategories: [],
      transforms: [],
      objectives: data.objectives.map((objective) => ({
        id: objective.id,
        titlePl: objective.titlePl,
        descriptionEn: objective.descriptionEn,
        cards: objective.cards.map((card) => ({ title: card.title, body: card.body })),
        errorCategories: [...OBJECTIVE_CATEGORIES],
        hints: { ...OBJECTIVE_HINTS },
        exerciseTypes: [...TYPES_BY_KIND[objective.kind ?? "words"]],
      })),
    };
  },
};
