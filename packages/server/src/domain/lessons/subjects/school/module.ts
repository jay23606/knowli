import { baseNormalizer } from "../../normalize";
import type {
  DynamicTopicData,
  ErrorCategory,
  ErrorCategoryCode,
  LessonExerciseType,
  LessonTopic,
  SubjectModule,
} from "../../types";
import { schoolPrompts } from "./prompts";
import { validateSchoolExercise, validateSchoolPool } from "./validators";

/**
 * Przedmiot `school` — przedmioty szkolne z materiału rodzica. Katalog w kodzie
 * jest pusty: zagadnienia (cele) powstają z materiału konkretnego zestawu
 * i żyją w `lesson_context.dynamicTopic`; `buildDynamicTopic` składa je
 * w `LessonTopic` z generycznymi kategoriami błędów, szablonami podpowiedzi
 * i typami ćwiczeń przedmiotu. Rejestracja = ten obiekt + wpis w rejestrze.
 */

export const SCHOOL_EXERCISE_TYPES: readonly LessonExerciseType[] = [
  "lesson_card",
  "lesson_choice",
  "lesson_order",
  "lesson_match",
  "lesson_group",
  "lesson_cloze",
  "lesson_gap",
  "lesson_open_answer",
  "lesson_calculation",
  "lesson_keywords",
];

export const SCHOOL_ERROR_CATEGORIES: readonly ErrorCategory[] = [
  { code: "missing_element", labelPl: "Brakuje ważnej informacji" },
  { code: "wrong_fact", labelPl: "Błąd rzeczowy" },
  { code: "confused_concept", labelPl: "Pomylone pojęcia" },
];

/** Kategorie przypisywane każdemu zagadnieniu dynamicznemu (przedmiotowe + bazowe używane w podpowiedziach). */
const OBJECTIVE_CATEGORIES: readonly ErrorCategoryCode[] = [
  "missing_element",
  "wrong_fact",
  "confused_concept",
  "incomplete",
];

const OBJECTIVE_HINTS: Readonly<Record<ErrorCategoryCode, string>> = {
  missing_element: "Brakuje jednej ważnej informacji. Przypomnij sobie kartę zagadnienia.",
  wrong_fact: "Coś tu nie zgadza się z materiałem. Sprawdź jeszcze raz na karcie zagadnienia.",
  confused_concept: "Uwaga — to chyba inne pojęcie. Porównaj oba na kartach zagadnień.",
  incomplete: "Odpowiedź jest niepełna. Dodaj brakującą część.",
};

export const schoolSubject: SubjectModule = {
  id: "school",
  titlePl: "Przedmiot szkolny (z materiału)",
  answerLocale: "pl-PL",
  promptLocale: "pl-PL",
  exerciseTypes: SCHOOL_EXERCISE_TYPES,
  errorCategories: SCHOOL_ERROR_CATEGORIES,
  normalizer: baseNormalizer,
  topics: [],
  prompts: schoolPrompts,
  usesV3Payload: true,
  // Rodziny pytań współdzielą odpowiedź wzorcową, więc deduplikacja musi iść po tożsamości ćwiczenia.
  poolDeduplication: "exercise",
  // Każde ćwiczenie opiera się na dokładnym cytacie z materiału rodzica.
  sourceQuotes: true,
  // Rodzic nazywa przedmiot własnym tytułem (np. „Historia”).
  materialSubjectTitle: "parent",
  poolMinimums: { guided: 3, productive: 2, independent: 2 },
  validateExercise: validateSchoolExercise,
  ttsForAnswers: false,
  ttsForPrompts: true,
  ttsForFeedbackSentence: false,
  exerciseExplanations: false,
  // Dyktowanie odpowiedzi otwartej po polsku (Etap 3); bez oceny wymowy.
  spokenAnswers: { locale: "pl-PL", exerciseTypes: ["lesson_open_answer"] },
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
        cards: objective.cards.map((card) => ({
          title: card.title,
          body: card.body,
          ...(card.voiceTone === undefined ? {} : { voiceTone: card.voiceTone }),
        })),
        errorCategories: [...OBJECTIVE_CATEGORIES],
        hints: { ...OBJECTIVE_HINTS },
        exerciseTypes: [...SCHOOL_EXERCISE_TYPES],
      })),
    };
  },
  validatePoolExtra: validateSchoolPool,
};
