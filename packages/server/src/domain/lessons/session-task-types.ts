import { LESSON_STORY_TASK_TYPES, type LessonStoryTaskTypeDto } from "@learning/contracts";
import type { LessonExerciseType } from "./types";

/**
 * Typy zadań sesji lekcji poza oceną (jeden predykat zamiast literałów
 * `lesson_card` w licznikach): karta i zadania historyjki nie zużywają budżetu
 * ocenianych zadań, nie zmieniają postępu reguł ani cyklu wsparcia.
 */
export type LessonStoryTaskType = LessonStoryTaskTypeDto;
/** Typ zadania sesji lekcji: ćwiczenie z katalogu albo zadanie historyjki. */
export type LessonSessionTaskType = LessonExerciseType | LessonStoryTaskType;

export const NON_ASSESSED_LESSON_TASK_TYPES: readonly string[] = ["lesson_card", ...LESSON_STORY_TASK_TYPES];

export function isNonAssessedLessonTaskType(type: string): boolean {
  return NON_ASSESSED_LESSON_TASK_TYPES.includes(type);
}
