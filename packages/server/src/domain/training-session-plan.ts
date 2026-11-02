import { TaskPromptSchema, isLessonStoryTaskType, type TaskPrompt } from "@learning/contracts";
import { z } from "zod";

/** Prywatny, niezmienny slot treningu. answerKey nigdy nie trafia do Kid DTO. */
export interface TrainingSessionSlot {
  taskId: string;
  itemId: string;
  itemRevisionId: string;
  ordinal: number;
  exerciseType: string;
  direction: string | null;
  assessed: boolean;
  prompt: TaskPrompt;
  answerKey: Record<string, unknown>;
  reason: string;
  supportCycleId?: string;
  skillAtIssue?: string;
  statusAtIssue?: string | null;
  assessmentSkills?: readonly string[];
  revealsTargetKeys: readonly string[];
  keepsReservations: readonly string[];
}

/** Snapshot utworzony przy starcie i utrwalany do końca życia sesji. */
export interface TrainingSessionPlanSnapshot {
  version: 1;
  taskBudget: number;
  slots: readonly TrainingSessionSlot[];
}

/** Rodzaj slotu lekcji; `story`/`story_question` to zadania historyjki na końcu sesji (poza oceną). */
export type LessonTaskKind = "card" | "support_card" | "exercise" | "story" | "story_question";

/** Wspólny protokół trwałego planu dla lekcji; kontekst jest prywatny jak answerKey. */
export interface LessonTrainingSessionSlot extends Omit<TrainingSessionSlot, "keepsReservations"> {
  taskKind: LessonTaskKind;
  context: Record<string, unknown>;
}
export interface LessonTrainingSessionPlanSnapshot {
  version: 1;
  kind: "lesson";
  taskBudget: number;
  slots: readonly LessonTrainingSessionSlot[];
}
export type StoredTrainingSessionPlan = TrainingSessionPlanSnapshot | LessonTrainingSessionPlanSnapshot;

const TrainingSessionSlotSchema = z.object({
  taskId: z.string().uuid(), itemId: z.string().uuid(), itemRevisionId: z.string().uuid(),
  ordinal: z.number().int().nonnegative(), exerciseType: z.string().min(1), direction: z.string().nullable(),
  assessed: z.boolean(), prompt: TaskPromptSchema, answerKey: z.record(z.string(), z.unknown()), reason: z.string().min(1),
  supportCycleId: z.string().optional(), skillAtIssue: z.string().optional(), statusAtIssue: z.string().nullable().optional(),
  assessmentSkills: z.array(z.string()).optional(), revealsTargetKeys: z.array(z.string()), keepsReservations: z.array(z.string()),
});
const TrainingSessionPlanSchema = z.object({
  version: z.literal(1), taskBudget: z.number().int().positive(), slots: z.array(TrainingSessionSlotSchema).min(1).max(256),
});
const LessonTrainingSessionPlanSchema = z.object({
  version: z.literal(1), kind: z.literal("lesson"), taskBudget: z.number().int().positive(),
  slots: z.array(z.object({
    taskId: z.string().uuid(), itemId: z.string().uuid(), itemRevisionId: z.string().uuid(),
    ordinal: z.number().int().nonnegative(), exerciseType: z.string().min(1), direction: z.null(),
    assessed: z.boolean(), prompt: TaskPromptSchema, answerKey: z.record(z.string(), z.unknown()),
    reason: z.string().min(1), taskKind: z.enum(["card", "support_card", "exercise", "story", "story_question"]), context: z.record(z.string(), z.unknown()),
    revealsTargetKeys: z.array(z.string()),
  })).min(1).max(256),
});

/** Nie regenerujemy innego planu, jeśli aplikacja nie zna zapisanej wersji. */
export function readTrainingSessionPlan(value: unknown): TrainingSessionPlanSnapshot | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || (value as { version?: unknown }).version !== 1) {
    throw new Error("unsupported_training_session_plan_version");
  }
  const parsed = TrainingSessionPlanSchema.safeParse(value);
  if (!parsed.success || parsed.data.slots.some((slot, ordinal) => slot.ordinal !== ordinal) ||
      new Set(parsed.data.slots.map((slot) => slot.taskId)).size !== parsed.data.slots.length ||
      parsed.data.slots.filter((slot) => slot.assessed).length > parsed.data.taskBudget) {
    throw new Error("invalid_training_session_plan");
  }
  return parsed.data as TrainingSessionPlanSnapshot;
}

export function readLessonTrainingSessionPlan(value: unknown): LessonTrainingSessionPlanSnapshot | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || (value as { version?: unknown }).version !== 1 || (value as { kind?: unknown }).kind !== "lesson") {
    throw new Error("unsupported_training_session_plan_version");
  }
  const parsed = LessonTrainingSessionPlanSchema.safeParse(value);
  if (!parsed.success || parsed.data.slots.some((slot, ordinal) => slot.ordinal !== ordinal) ||
      new Set(parsed.data.slots.map((slot) => slot.taskId)).size !== parsed.data.slots.length ||
      parsed.data.slots.filter((slot) => slot.assessed).length > parsed.data.taskBudget) {
    throw new Error("invalid_training_session_plan");
  }
  if (!hasValidStorySuffix(parsed.data.slots)) throw new Error("invalid_training_session_plan");
  return parsed.data as LessonTrainingSessionPlanSnapshot;
}

/** Typ ćwiczenia, który musi nieść slot danego rodzaju historyjki. */
const STORY_EXERCISE_TYPE = { story: "lesson_story", story_question: "lesson_story_question" } as const;

/**
 * Sloty historyjki to jeden ciągły blok na końcu planu: najpierw dokładnie jeden
 * `story`, potem same `story_question`, wszystkie nieoceniane, z typem
 * ćwiczenia i rodzajem promptu zgodnymi z rodzajem slotu. Plan bez historyjki jest poprawny.
 */
function hasValidStorySuffix(slots: readonly { taskKind: LessonTaskKind; assessed: boolean; exerciseType: string; prompt: TaskPrompt }[]): boolean {
  const isStory = (kind: LessonTaskKind): boolean => kind === "story" || kind === "story_question";
  // Typ albo prompt historyjki bez slotu historyjki (np. `exercise` z `lesson_story`) też jest błędem.
  if (slots.some((slot) => !isStory(slot.taskKind) && (isLessonStoryTaskType(slot.exerciseType) || isLessonStoryTaskType(slot.prompt.kind)))) {
    return false;
  }
  const first = slots.findIndex((slot) => isStory(slot.taskKind));
  if (first === -1) return true;
  return slots.slice(first).every((slot, index) => {
    const expected = index === 0 ? "story" : "story_question";
    const exerciseType = STORY_EXERCISE_TYPE[expected];
    return slot.taskKind === expected && !slot.assessed && slot.exerciseType === exerciseType && slot.prompt.kind === exerciseType;
  });
}
