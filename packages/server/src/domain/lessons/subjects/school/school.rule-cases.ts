import { MIN_SOURCE_QUOTE_LENGTH, type CalculationSpec } from "@learning/contracts";
import { computeCalculationAnswer, renderCalculationPrompt } from "../../calculation";
import { registerRuleCases } from "../../testing/rule-cases";
import type { LessonExerciseDraft, LessonTopic } from "../../types";
import { schoolSubject } from "./module";

/**
 * Przypadki reguł katalogu szkoły (`rules.ts`) dla testu kompletności
 * `rules/rule-cases.test.ts`. Każdy przypadek woła prawdziwy hak przedmiotu
 * (`validateExercise`, `validatePoolExtra`, `agentPolicy.sanitize`).
 */

const OBJECTIVE_ID = "school.cases.fotosynteza";
const QUOTE = "wytwarza cukry";
const MATERIAL = `Fotosynteza to proces, w którym roślina z wody i dwutlenku węgla, przy udziale światła, ${QUOTE}.`;

const topic: LessonTopic = schoolSubject.buildDynamicTopic!({
  titlePl: "Przyroda",
  objectives: [
    {
      id: OBJECTIVE_ID,
      titlePl: "Fotosynteza",
      descriptionEn: "Photosynthesis.",
      cards: [
        { title: "Co to jest?", body: "Roślina wytwarza cukry." },
        { title: "Po co?", body: "Cukry są pokarmem rośliny." },
      ],
    },
  ],
});

function openDraft(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_open_answer",
    objectiveId: OBJECTIVE_ID,
    prompt: "Co to jest fotosynteza?",
    answer: "Roślina z wody i dwutlenku węgla, przy udziale światła, wytwarza cukry.",
    acceptedAnswers: [],
    focus: ["wytwarza cukry"],
    questionType: "definition",
    requiredElements: [{ id: "e1", text: "Roślina wytwarza cukry." }],
    expectedForm: "explanation",
    sourceRefs: [{ quote: QUOTE }],
    ...overrides,
  };
}

const scale: CalculationSpec = {
  kind: "scale_distance",
  params: { scaleDenominator: 25000, mapDistanceCm: 3 },
  unit: "m",
  templateFamilyId: "map-scale",
};

function calculationDraft(calculation: CalculationSpec = scale, overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_calculation",
    objectiveId: OBJECTIVE_ID,
    calculation,
    prompt: renderCalculationPrompt(calculation),
    answer: computeCalculationAnswer(calculation).answer,
    acceptedAnswers: [],
    focus: [],
    sourceRefs: [{ quote: QUOTE }],
    ...overrides,
  };
}

function keywordsDraft(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_keywords",
    objectiveId: OBJECTIVE_ID,
    familyId: "def",
    keywordOptions: [
      { id: "k1", text: "światło" }, { id: "k2", text: "cukry" }, { id: "k3", text: "tlen" }, { id: "k4", text: "korzenie" },
    ],
    keyOptionIds: ["k1", "k2"],
    answer: "światło, cukry",
    acceptedAnswers: [],
    focus: [],
    sourceRefs: [{ quote: QUOTE }],
    ...overrides,
  };
}

const exercise = (draft: LessonExerciseDraft) => () => schoolSubject.validateExercise(draft, topic);
const pool = (drafts: readonly LessonExerciseDraft[], rejectedFamilies?: ReadonlySet<string>) => () =>
  [...schoolSubject.validatePoolExtra!(drafts, { material: MATERIAL, ...(rejectedFamilies ? { rejectedFamilies } : {}) }).values()].flat();
const sanitizeNotes = (draft: LessonExerciseDraft) => () =>
  schoolSubject.agentPolicy.sanitize!(draft, { material: MATERIAL }).notes ?? [];

const family = openDraft({ familyId: "def" });

registerRuleCases([
  { rule: "school.quote_required", violation: exercise(openDraft({ sourceRefs: undefined })) },
  { rule: "school.quote_required", violation: exercise(calculationDraft(scale, { sourceRefs: [] })) },
  {
    rule: "school.quote_too_short",
    violation: pool([openDraft({ sourceRefs: [{ quote: QUOTE.slice(0, MIN_SOURCE_QUOTE_LENGTH - 1) }] })]),
    boundary: pool([openDraft({ sourceRefs: [{ quote: QUOTE.slice(0, MIN_SOURCE_QUOTE_LENGTH) }] })]),
  },
  { rule: "school.quote_in_material", violation: pool([openDraft({ sourceRefs: [{ quote: "Rośliny jedzą słońce na śniadanie." }] })]) },
  { rule: "school.open_required_fields", violation: exercise(openDraft({ questionType: undefined })) },
  { rule: "school.open_required_fields", violation: exercise(openDraft({ requiredElements: [] })) },
  { rule: "school.open_required_fields", violation: exercise(openDraft({ expectedForm: undefined })) },
  {
    rule: "school.element_ids_unique",
    violation: exercise(openDraft({ requiredElements: [{ id: "e1", text: "Cukry." }, { id: "e1", text: "Światło." }] })),
  },
  { rule: "school.v3_field_type", violation: exercise(calculationDraft(scale, { expectedForm: "explanation" })) },
  { rule: "school.v3_field_type", violation: exercise(calculationDraft(scale, { familyId: "def" })) },
  { rule: "school.calculation_params_required", violation: exercise(calculationDraft(scale, { calculation: undefined })) },
  { rule: "school.calculation_invalid", violation: exercise(calculationDraft(scale, { calculation: { ...scale, tolerance: 8 } })) },
  { rule: "school.calculation_answer_computed", violation: exercise(calculationDraft(scale, { answer: "0,75 km" })) },
  { rule: "school.calculation_prompt_template", violation: exercise(calculationDraft(scale, { prompt: "Oblicz odległość do Warszawy." })) },
  { rule: "school.computed_lists_empty", violation: exercise(calculationDraft(scale, { acceptedAnswers: ["750"] })) },
  { rule: "school.computed_lists_empty", violation: exercise(keywordsDraft({ focus: ["cukry"] })) },
  { rule: "school.keywords_family_required", violation: exercise(keywordsDraft({ familyId: undefined })) },
  {
    rule: "school.family_prompt_repeated",
    violation: pool([openDraft({ familyId: "fam" }), openDraft({ familyId: "fam" })]),
  },
  {
    rule: "school.family_answer_differs",
    violation: pool([openDraft({ familyId: "fam" }), openDraft({ familyId: "fam", prompt: "Wyjaśnij fotosyntezę.", answer: "Roślina wytwarza cukry." })]),
  },
  {
    rule: "school.family_elements_differ",
    violation: pool([
      openDraft({ familyId: "fam" }),
      openDraft({ familyId: "fam", prompt: "Wyjaśnij fotosyntezę.", requiredElements: [{ id: "e2", text: "Roślina wytwarza cukry." }] }),
    ]),
  },
  { rule: "school.keywords_family_missing", violation: pool([openDraft({ familyId: "inna" }), keywordsDraft()]) },
  // Kaskada: pytanie otwarte rodziny „def” odpadło w tym samym wywołaniu agenta.
  { rule: "school.keywords_family_rejected", violation: pool([openDraft({ familyId: "inna" }), keywordsDraft()], new Set(["def"])) },
  {
    rule: "school.keyword_not_in_answer",
    violation: pool([
      family,
      keywordsDraft({
        keywordOptions: [{ id: "k1", text: "chlorofil" }, { id: "k2", text: "cukry" }, { id: "k3", text: "tlen" }, { id: "k4", text: "korzenie" }],
        answer: "chlorofil, cukry",
      }),
    ]),
  },
  {
    rule: "school.calculation_family_mismatch",
    violation: pool([calculationDraft(), calculationDraft({ ...scale, unit: "km" })]),
  },
  {
    rule: "school.hint_open_answer_only",
    violation: sanitizeNotes({
      exerciseType: "lesson_gap",
      objectiveId: OBJECTIVE_ID,
      stem: "Rośliny wytwarzają cukry w procesie ___.",
      answer: "fotosyntezy",
      acceptedAnswers: [],
      focus: ["fotosyntezy"],
      hint: "proces",
    }),
  },
  {
    rule: "hint.reveals_words",
    violation: sanitizeNotes(
      openDraft({ answer: "Mierzeja Wiślana", requiredElements: [{ id: "e1", text: "Mierzeja Wiślana" }], hint: "Przykładem jest Mierzeja Wiślana" }),
    ),
  },
]);
