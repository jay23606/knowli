import type { LessonExerciseType, SubjectAgentPolicy } from "../../types";
import { grammarTypeExamples } from "./type-examples";

/**
 * Polityka agenta puli dla przedmiotu `english_grammar` (design etapu 1 §4.3):
 * tylko typy rozwiązywane na ślepo, dopiski do reguł silnika (`ruleNotes`) i przykłady typów tematu
 * „to be” (`typeExamples`). Bez wymaganych typów,
 * bramek, braków i planu; `hint` zostaje bez zmian (forma podstawowa, np. „go”).
 *
 * Listy to zbiór PoC (gałąź nie-szkolna) przecięty z typami gramatyki (brak
 * `lesson_match`, `lesson_group`, `lesson_cloze`); literały zamiast importu z
 * `module.ts`, który importuje politykę. Zgodność z typami przedmiotu pilnuje test.
 * Bez `lesson_keywords` i `lesson_listen_choice`.
 */

const BLIND_SOLVE_TYPES: readonly LessonExerciseType[] = [
  "lesson_choice",
  "lesson_gap",
  "lesson_open_answer",
  "lesson_order",
  "lesson_error_fix",
  "lesson_transform",
];

const VARIANT_CHECK_TYPES: readonly LessonExerciseType[] = ["lesson_open_answer", "lesson_transform", "lesson_error_fix", "lesson_gap"];

/** Dopisek do ślepego rozwiązania (spec katalogu reguł §3): polskie zdanie źródłowe wskazuje jedno sformułowanie. */
const BLIND_SOLVE_NOTE =
  "The Polish source sentence must point to one English wording (pronoun, tense, word order); " +
  "put common equivalent word orders into acceptedAnswers right away.";

/** Dopisek do duplikatu wariantu: skrócona i pełna forma to ten sam wariant po normalizacji. */
const CONTRACTIONS_NOTE = "Contractions count as the same: doesn't = does not, I'm = I am.";

export const grammarAgentPolicy: SubjectAgentPolicy = {
  blindSolveTypes: BLIND_SOLVE_TYPES,
  variantCheckTypes: VARIANT_CHECK_TYPES,
  checkerNeedsMaterial: false,
  independentReserve: 1,
  slack: 2,
  ruleNotes: {
    "lesson.leak": "An independent answer must be a NEW sentence nobody showed before — use a different subject, verb or object.",
    "lesson.leak_source": "Use a different sentence.",
    "check.blind_solve": BLIND_SOLVE_NOTE,
    "variants.duplicate": CONTRACTIONS_NOTE,
  },
  typeExamples: grammarTypeExamples,
};
