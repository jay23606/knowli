import type { LessonExerciseDraft } from "./types";

/**
 * Świeże ćwiczenia `lesson_keywords`, których rodzina (zagadnienie + `familyId`) nie ma już żadnego
 * pytania otwartego wśród ćwiczeń szkicu i zachowanych świeżych — odpadają (reguła twarda, kolizje
 * z historyjką albo przycięcie mogły usunąć całą rodzinę; walidator szkoły zablokowałby wtedy
 * publikację: „brak rodziny pytań otwartych”). Słowa kluczowe bez `familyId` zostają, jak w walidatorze.
 */
export function withoutOrphanKeywords(
  existing: readonly LessonExerciseDraft[],
  fresh: readonly LessonExerciseDraft[],
): { kept: LessonExerciseDraft[]; dropped: number } {
  const familyKey = (exercise: LessonExerciseDraft) => JSON.stringify([exercise.objectiveId, exercise.familyId]);
  const openFamilies = new Set(
    [...existing, ...fresh].filter((exercise) => exercise.exerciseType === "lesson_open_answer" && exercise.familyId).map(familyKey),
  );
  const kept = fresh.filter((exercise) => exercise.exerciseType !== "lesson_keywords" || !exercise.familyId || openFamilies.has(familyKey(exercise)));
  return { kept, dropped: fresh.length - kept.length };
}
