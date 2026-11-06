import { registerRuleCases } from "../../testing/rule-cases";
import type { AgentObjective, DynamicTopicData, LessonExerciseDraft } from "../../types";
import { englishChapterSubject } from "./module";

/**
 * Przypadki reguł katalogu rozdziału (`rules.ts`) dla testu kompletności
 * `rules/rule-cases.test.ts`. Każdy przypadek woła prawdziwy hak przedmiotu
 * (`validateExercise`, `refineGeneratedPool`, `agentPolicy.exerciseGate`).
 */

const WEATHER = "english_chapter.ddeck.weather";
const ROOM = "english_chapter.ddeck.room";
const WEARING = "english_chapter.ddeck.wearing";

const MATERIAL = ["Pogoda:", "raining — pada deszcz", "sunny — słonecznie", "Pokój:", "bed — łóżko", "lamp — lampa", "Zwroty:", "I'm wearing a …"].join("\n");

const DATA: DynamicTopicData = {
  titlePl: "Unit 1",
  objectives: [
    {
      id: WEATHER,
      titlePl: "Pogoda",
      descriptionEn: "Weather words.",
      kind: "words",
      cards: [{ title: "Słówka", body: "raining — pada deszcz\nsunny — słonecznie" }],
    },
  ],
};
const topic = englishChapterSubject.buildDynamicTopic!(DATA);

/** Zagadnienia bramek: słówka pokoju i rama „I'm wearing”. */
const roomObjective: AgentObjective = {
  id: ROOM,
  titlePl: "Pokój",
  descriptionEn: "Room words.",
  kind: "words",
  cards: [{ title: "Słówka", body: "bed — łóżko" }],
  exerciseTypes: [],
};
const frameObjective: AgentObjective = {
  id: WEARING,
  titlePl: "Co mam na sobie?",
  descriptionEn: "Frame: I'm wearing.",
  kind: "frame",
  cards: [{ title: "Rama", body: "I'm wearing a …\nNa przykład: I'm wearing a coat." }],
  exerciseTypes: [],
};

function draft(overrides: Partial<LessonExerciseDraft>): LessonExerciseDraft {
  return { exerciseType: "lesson_gap", objectiveId: WEATHER, answer: "sunny", acceptedAnswers: [], focus: [], ...overrides };
}

const choice = (overrides: Partial<LessonExerciseDraft> = {}) =>
  draft({
    exerciseType: "lesson_choice",
    instructionPl: "Dziś pada deszcz. Wybierz słowo.",
    stem: "It's ___ today.",
    options: [{ id: "a", text: "raining" }, { id: "b", text: "sunny" }],
    correctOption: "a",
    answer: "raining",
    ...overrides,
  });

const gap = (overrides: Partial<LessonExerciseDraft> = {}) =>
  draft({ instructionPl: "Dziś jest słonecznie. Wpisz brakujące słowo.", stem: "It's ___ today.", ...overrides });

const order = (overrides: Partial<LessonExerciseDraft> = {}) =>
  draft({
    exerciseType: "lesson_order",
    objectiveId: WEARING,
    instructionPl: "Ułóż zdanie: Mam na sobie płaszcz.",
    items: ["I'm", "wearing", "a", "coat"].map((text, index) => ({ id: `i${index}`, text })),
    answer: "I'm wearing a coat",
    ...overrides,
  });

const translation = (overrides: Partial<LessonExerciseDraft> = {}) =>
  draft({
    exerciseType: "lesson_open_answer",
    objectiveId: WEARING,
    instructionPl: "Przetłumacz na angielski.",
    prompt: "Mam na sobie płaszcz.",
    answer: "I'm wearing a coat.",
    ...overrides,
  });

const validate = (exercise: LessonExerciseDraft) => () => englishChapterSubject.validateExercise(exercise, topic);
const refine = (exercise: LessonExerciseDraft) => () =>
  englishChapterSubject.refineGeneratedPool!([exercise], { material: MATERIAL }).rejected.flatMap((item) => item.issues);
const gate = (exercise: LessonExerciseDraft, objective: AgentObjective) => () =>
  englishChapterSubject.agentPolicy.exerciseGate!(exercise, objective, { material: MATERIAL }).map((finding) => finding.issue);

/** Polecenie o najmniejszej dozwolonej długości: granica zdania, dalszy tekst, nie stałe polecenie. */
const SHORTEST_STIMULUS = "Mam to. Tak.";

registerRuleCases([
  { rule: "chapter.stem_single_gap", violation: validate(choice({ stem: "It's sunny today." })) },
  {
    rule: "chapter.instruction_stimulus",
    violation: validate(gap({ instructionPl: "Wybierz właściwe słowo." })),
    boundary: validate(gap({ instructionPl: SHORTEST_STIMULUS })),
  },
  { rule: "chapter.translation_instruction_required", violation: validate(translation({ instructionPl: undefined })) },
  { rule: "chapter.hint_not_allowed", violation: validate(gap({ hint: "sun" })) },
  {
    rule: "chapter.order_items_distinct",
    violation: validate(order({ items: ["I'm", "wearing", "a", "A", "coat"].map((text, index) => ({ id: `i${index}`, text })) })),
  },
  { rule: "chapter.word_outside_material", violation: refine(gap({ answer: "foggy", focus: ["foggy"] })) },
  { rule: "chapter.function_words_only", violation: refine(gap({ answer: "the", focus: ["the"] })) },
  { rule: "chapter.card_word_missing", violation: gate(gap({ objectiveId: ROOM, stem: "I turn on the ___.", answer: "lamp" }), roomObjective) },
  { rule: "chapter.frame_missing", violation: gate(order({ answer: "There's a cat in the garden", items: undefined }), frameObjective) },
]);
