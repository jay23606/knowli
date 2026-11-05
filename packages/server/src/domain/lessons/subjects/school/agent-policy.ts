import { baseNormalizer } from "../../normalize";
import type { LessonExerciseDraft, LessonExerciseType, SubjectAgentPolicy } from "../../types";
import { hintRevealsAnswer } from "./hint-gate";

/**
 * Polityka agenta puli dla przedmiotu `school` (design etapu 1 §4.4): typy
 * rozwiązywane na ślepo, sanityzacja podpowiedzi i bramka podpowiedzi pytania
 * otwartego. Tylko reguły domenowe nad przekazanymi danymi.
 *
 * Listy typów są literałami, nie importem z `module.ts` (ten importuje politykę;
 * cykl zostawiłby stałą w strefie martwej). Zgodność z typami przedmiotu pilnuje test.
 */

/** Zamknięte typy z jednoznaczną odpowiedzią; otwarte, układanki, rachunki i słowa kluczowe bez ślepego rozwiązania. */
const BLIND_SOLVE_TYPES: readonly LessonExerciseType[] = ["lesson_choice", "lesson_match", "lesson_group", "lesson_cloze", "lesson_gap"];

/** Warianty odpowiedzi sprawdza niezależny model tylko przy lukach. */
const VARIANT_CHECK_TYPES: readonly LessonExerciseType[] = ["lesson_gap"];

/** Podpowiedź ma sens wyłącznie przy pytaniu otwartym; rodzic dopisuje ją innym typom w edytorze. */
const HINT_TYPE: LessonExerciseType = "lesson_open_answer";

/** Kontrola otwarta (rozwiązujący + grader) dotyczy wyłącznie pytania otwartego. */
const OPEN_CHECK_TYPE: LessonExerciseType = "lesson_open_answer";

const normalizer = baseNormalizer;

/** Dopisek dla podagenta: odpowiednik `sanitize` (podpowiedź poza pytaniem otwartym i tak jest usuwana). */
const PROMPT_NOTES: readonly string[] = [
  "Hint only for lesson_open_answer: the hint field must be null for every other exercise type.",
];

export const schoolAgentPolicy: SubjectAgentPolicy = {
  blindSolveTypes: BLIND_SOLVE_TYPES,
  variantCheckTypes: VARIANT_CHECK_TYPES,
  hintJudgeTypes: [HINT_TYPE],
  openAnswerCheckTypes: [OPEN_CHECK_TYPE],
  checkerNeedsMaterial: true,
  independentReserve: 1,
  slack: 2,
  promptNotes: PROMPT_NOTES,
  rejectionTexts: {
    leakVictim:
      "An independent answer must not be visible earlier — ask about a different fact of the material or phrase the question differently.",
    leakSource: "Use a different fact or phrase the question differently.",
    hintUnsupported:
      "The hint states something the material does not support. Rewrite the hint using only facts from the material, or set hint to null.",
    hintLanguage: "The hint is not correct Polish. Fix the wording, or set hint to null.",
    hintReveals:
      "The hint gives away the answer or a required element in other words. Hint at the reasoning, not the content, or set hint to null.",
    openMissing:
      "A correct answer that follows the question was not accepted: it lacks required elements the question does not actually demand. " +
      "Make requiredElements match what the question asks (for “any two”, require what every valid choice satisfies and move specific examples to supplementaryElements), " +
      "or make the question ask for exactly those elements. Do not drop elements the question genuinely requires; " +
      "if the answer below is wrong according to the material, make the question more precise.",
    openWrong:
      "An answer based on the material was graded as containing errors. Check that the model answer and the criteria agree with the material; " +
      "if the answer below is wrong according to the material, make the question more precise or add the mistake to commonErrors.",
  },
  sanitize(draft: LessonExerciseDraft) {
    if (draft.exerciseType === HINT_TYPE || draft.hint === undefined) return { draft, removed: [] };
    const { hint: _hint, ...rest } = draft;
    return { draft: rest, removed: ["hint"] };
  },
  exerciseGate(draft) {
    if (draft.exerciseType !== HINT_TYPE || draft.hint === undefined || draft.hint.trim() === "") return [];
    if (!hintRevealsAnswer(draft.hint, draft, normalizer)) return [];
    return [
      {
        code: "hint_reveals_answer",
        reason: "the hint gives away the answer or a required element; hint at the reasoning, not the content",
      },
    ];
  },
};
