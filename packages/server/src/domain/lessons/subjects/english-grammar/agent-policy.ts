import type { LessonExerciseType, SubjectAgentPolicy } from "../../types";

/**
 * Polityka agenta puli dla przedmiotu `english_grammar` (design etapu 1 §4.3):
 * tylko typy rozwiązywane na ślepo i teksty odrzuceń. Bez wymaganych typów,
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

export const grammarAgentPolicy: SubjectAgentPolicy = {
  blindSolveTypes: BLIND_SOLVE_TYPES,
  variantCheckTypes: VARIANT_CHECK_TYPES,
  checkerNeedsMaterial: false,
  independentReserve: 1,
  slack: 2,
  rejectionTexts: {
    leakVictim: "An independent answer must be a NEW sentence nobody showed before — use a different subject, verb or object.",
    leakSource: "Use a different sentence.",
  },
};
