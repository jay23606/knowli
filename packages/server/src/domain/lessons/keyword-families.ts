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

/**
 * Sufiks rodzin pytań nowej partii (`scopeFamiliesToRun`): `-r` i do 6 pierwszych
 * znaków szesnastkowych zakresu runu, małymi literami.
 */
export function familyRunSuffix(scope: string): string {
  return `-r${scope.replace(/[^0-9a-f]/gi, "").slice(0, 6).toLowerCase()}`;
}

/**
 * Slug rodziny bez sufiksu runu (do komunikatów dla modelu, który pisał slug bez
 * sufiksu). Sufiks zdejmowany tylko przy znanym zakresie; bez zakresu albo bez
 * sufiksu slug zostaje. Baza może być przycięta przez `scopeFamiliesToRun`
 * (limit długości slugu) — tak zostaje.
 */
export function familyBase(slug: string, scope: string | null): string {
  if (scope === null) return slug;
  const suffix = familyRunSuffix(scope);
  return slug.endsWith(suffix) ? slug.slice(0, -suffix.length) : slug;
}
