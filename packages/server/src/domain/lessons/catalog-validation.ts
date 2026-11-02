import { BASE_ERROR_CATEGORY_CODES } from "./base-error-categories";
import { ASSESSED_STAGES, outsideStagePath, stageOf } from "./stages";
import type { ErrorCategoryCode, LearningObjective, LessonTopic, SubjectModule } from "./types";

const MIN_CARDS = 2;
const MAX_CARDS = 4;

/** Dokleja błąd ze stałym prefiksem lokalizującym go w katalogu. */
function reportDuplicates(values: readonly string[], label: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      errors.push(`${label}: zduplikowany identyfikator „${value}”`);
    }
    seen.add(value);
  }
}

/**
 * Ogólne reguły spójności katalogu przedmiotu (design „Przedmiot i katalog”).
 * Zwraca listę błędów po polsku; pusta lista = przedmiot poprawny. Czysta
 * funkcja — bez bazy, sieci i zegara. Reguły specyficzne dla przedmiotu
 * (np. forma czasownika) żyją w `subject.validateExercise`, nie tutaj.
 */
export function validateSubject(module: SubjectModule): string[] {
  const errors: string[] = [];
  const subjectTypes = new Set(module.exerciseTypes);

  // Unikalne id tematów per wersja (ten sam id w innej wersji jest dozwolony).
  reportDuplicates(
    module.topics.map((topic) => `${topic.id}@${topic.version}`),
    "Temat",
    errors,
  );

  // Kody kategorii dostępne celom: baza ∪ przedmiot ∪ temat.
  reportDuplicates(
    module.errorCategories.map((category) => category.code),
    "Kategoria przedmiotu",
    errors,
  );

  // Tworzenie z materiału wymaga obu opcji naraz: tematu dynamicznego i źródła
  // tytułu przedmiotu. Jedna bez drugiej to przedmiot, którego nie da się
  // utworzyć z materiału (katalog i formularz rodzica patrzą na obie).
  if ((module.buildDynamicTopic === undefined) !== (module.materialSubjectTitle === undefined)) {
    errors.push(
      module.buildDynamicTopic === undefined
        ? "Przedmiot: materialSubjectTitle wymaga buildDynamicTopic"
        : "Przedmiot: buildDynamicTopic wymaga materialSubjectTitle",
    );
  }

  // Nagranie zdania to jedyny bodziec wyboru ze słuchu: bez TTS zdania zadanie nie byłoby wydawalne.
  if (module.exerciseTypes.includes("lesson_listen_choice") && module.ttsForFeedbackSentence !== true) {
    errors.push("Przedmiot: „lesson_listen_choice” wymaga ttsForFeedbackSentence (nagrania zdania)");
  }

  for (const topic of module.topics) {
    validateTopic(topic, module, subjectTypes, errors);
  }

  return errors;
}

function validateTopic(
  topic: LessonTopic,
  module: SubjectModule,
  subjectTypes: ReadonlySet<string>,
  errors: string[],
): void {
  const where = `Temat „${topic.id}@${topic.version}”`;

  reportDuplicates(
    topic.extraErrorCategories.map((category) => category.code),
    `${where}: kategoria tematu`,
    errors,
  );
  // Kategoria tematu nie może powielać kodu bazowego ani przedmiotowego —
  // unikalność dotyczy całego zbioru baza ∪ przedmiot ∪ temat.
  const baseOrSubjectCodes = new Set<ErrorCategoryCode>([
    ...BASE_ERROR_CATEGORY_CODES,
    ...module.errorCategories.map((category) => category.code),
  ]);
  for (const category of topic.extraErrorCategories) {
    if (baseOrSubjectCodes.has(category.code)) {
      errors.push(`${where}: kategoria tematu „${category.code}” powiela kod bazowy lub przedmiotu`);
    }
  }
  reportDuplicates(
    topic.transforms.map((transform) => transform.id),
    `${where}: przekształcenie`,
    errors,
  );
  reportDuplicates(
    topic.objectives.map((objective) => objective.id),
    `${where}: cel`,
    errors,
  );

  if (topic.objectives.length === 0) {
    errors.push(`${where}: temat nie ma żadnego celu`);
  }

  const knownCategories: ReadonlySet<ErrorCategoryCode> = new Set<ErrorCategoryCode>([
    ...BASE_ERROR_CATEGORY_CODES,
    ...module.errorCategories.map((category) => category.code),
    ...topic.extraErrorCategories.map((category) => category.code),
  ]);
  const hasTransforms = topic.transforms.length > 0;

  for (const objective of topic.objectives) {
    validateObjective(objective, { where, knownCategories, subjectTypes, hasTransforms }, errors);
  }
}

function validateObjective(
  objective: LearningObjective,
  ctx: {
    where: string;
    knownCategories: ReadonlySet<ErrorCategoryCode>;
    subjectTypes: ReadonlySet<string>;
    hasTransforms: boolean;
  },
  errors: string[],
): void {
  const where = `${ctx.where}, cel „${objective.id}”`;

  if (objective.cards.length < MIN_CARDS || objective.cards.length > MAX_CARDS) {
    errors.push(`${where}: liczba kart (${objective.cards.length}) poza zakresem ${MIN_CARDS}–${MAX_CARDS}`);
  }

  for (const category of objective.errorCategories) {
    if (!ctx.knownCategories.has(category)) {
      errors.push(`${where}: kategoria „${category}” spoza bazy, przedmiotu i tematu`);
    }
    if (ctx.knownCategories.has(category) && !(category in objective.hints)) {
      errors.push(`${where}: brak szablonu podpowiedzi dla kategorii „${category}”`);
    }
  }

  for (const type of objective.exerciseTypes) {
    if (!ctx.subjectTypes.has(type)) {
      errors.push(`${where}: typ „${type}” spoza typów przedmiotu`);
    }
    if (type === "lesson_transform" && !ctx.hasTransforms) {
      errors.push(`${where}: „lesson_transform” wymaga niepustego „transforms” w temacie`);
    }
  }

  // Typy poza ścieżką etapów (np. wybór ze słuchu) nie pokrywają etapu: mogą być niewydawalne.
  const coveredStages = new Set(
    objective.exerciseTypes.filter((type) => !outsideStagePath(type)).map((type) => stageOf(type)),
  );
  for (const stage of ASSESSED_STAGES) {
    if (!coveredStages.has(stage)) {
      errors.push(`${where}: brak typu ćwiczenia z etapu ocenianego „${stage}”`);
    }
  }
}
