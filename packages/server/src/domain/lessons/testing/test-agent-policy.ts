import type { LessonExerciseType, SubjectAgentPolicy } from "../types";

/** Typy ćwiczeń `historyLikeSubject` (tu, żeby polityka nie importowała przedmiotu cyklicznie). */
export const HISTORY_LIKE_EXERCISE_TYPES: readonly LessonExerciseType[] = [
  "lesson_card",
  "lesson_choice",
  "lesson_order",
  "lesson_gap",
  "lesson_open_answer",
];

/**
 * Wspólna polityka agenta dla przedmiotu testowego `historyLikeSubject`:
 * wszystkie jego typy do ślepego rozwiązania i sprawdzania wariantów, bez
 * kontroli modelem w szkole.
 */
export const testAgentPolicy: SubjectAgentPolicy = {
  blindSolveTypes: HISTORY_LIKE_EXERCISE_TYPES,
  variantCheckTypes: HISTORY_LIKE_EXERCISE_TYPES,
  hintJudgeTypes: [],
  openAnswerCheckTypes: [],
  checkerNeedsMaterial: false,
  independentReserve: 1,
  slack: 2,
  rejectionTexts: { leakVictim: "leak victim", leakSource: "leak source" },
};
