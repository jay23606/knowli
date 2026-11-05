import type { LearningObjective, LessonTopic, SubjectModule } from "../types";
import { baseNormalizer } from "../normalize";

/**
 * Fixture przedmiotu nie-językowego („history-like”) — dowód, że silnik lekcji
 * nie zakłada angielskiego ani gramatyki. Używa bazowego normalizatora (bez
 * rozwijania skrótów), własnej kategorii błędu i typów bez `lesson_transform`.
 * Przeznaczony do testów kolejnych zadań; nie jest produkcyjnym przedmiotem.
 */

const foundationCards: LearningObjective["cards"] = [
  { title: "Chrzest Polski", body: "Mieszko I przyjął chrzest w 966 roku." },
  { title: "Znaczenie", body: "Chrzest włączył państwo w krąg kultury łacińskiej." },
];

const foundationObjective: LearningObjective = {
  id: "test_history.piast_origins.chrzest_966",
  titlePl: "Data chrztu Polski",
  descriptionEn: "The baptism of Poland took place in 966 under Mieszko I.",
  cards: foundationCards,
  errorCategories: ["wrong_date", "incomplete"],
  hints: {
    wrong_date: "Sprawdź rok — chodzi o X wiek.",
    incomplete: "Podaj pełną datę roczną.",
  },
  exerciseTypes: ["lesson_card", "lesson_choice", "lesson_gap", "lesson_open_answer"],
};

const peopleObjective: LearningObjective = {
  id: "test_history.piast_origins.mieszko_dynasty",
  titlePl: "Dynastia Piastów",
  descriptionEn: "Mieszko I belonged to the Piast dynasty, the first rulers of Poland.",
  cards: [
    { title: "Piastowie", body: "Mieszko I był pierwszym historycznym władcą z dynastii Piastów." },
    { title: "Następca", body: "Jego synem był Bolesław Chrobry." },
  ],
  errorCategories: ["wrong_date", "wrong_order"],
  hints: {
    wrong_date: "To pytanie o dynastię, nie o rok.",
    wrong_order: "Ułóż władców chronologicznie.",
  },
  exerciseTypes: ["lesson_card", "lesson_order", "lesson_gap", "lesson_open_answer"],
};

const piastOriginsTopic: LessonTopic = {
  id: "piast_origins",
  version: 1,
  titlePl: "Początki państwa Piastów",
  extraErrorCategories: [],
  transforms: [],
  objectives: [foundationObjective, peopleObjective],
};

export const historyLikeSubject: SubjectModule = {
  id: "test_history",
  titlePl: "Historia (testowy)",
  answerLocale: "pl-PL",
  promptLocale: "pl-PL",
  exerciseTypes: ["lesson_card", "lesson_choice", "lesson_order", "lesson_gap", "lesson_open_answer"],
  errorCategories: [{ code: "wrong_date", labelPl: "Zła data" }],
  normalizer: baseNormalizer,
  topics: [piastOriginsTopic],
  prompts: {
    generationRole: "Jesteś autorem ćwiczeń z historii Polski dla dzieci.",
    gradingRole: "Oceniasz, czy dziecko poprawnie podało fakt historyczny, nie styl wypowiedzi.",
    almostDefinition: "„almost”, gdy fakt jest zasadniczo trafny, ale niepełny lub z drobną nieścisłością.",
  },
  validateExercise: () => [],
  ttsForAnswers: false,
  ttsForPrompts: false,
  ttsForFeedbackSentence: false,
  exerciseExplanations: false,
};
