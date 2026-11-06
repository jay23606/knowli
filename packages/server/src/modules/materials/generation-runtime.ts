import { z } from "zod";
import type { GenerationDeps, Services } from "../../config";
import { AppError } from "../../errors";
import { classifyLessonGenerationFailure, lessonRetryDelayMs } from "./lessons/lesson-generation-errors";

/** Maksymalnie trzy automatyczne próby; dalsze tylko po ręcznym ponowieniu. */
export const MAX_AUTOMATIC_ATTEMPTS = 3;

/** Termin ponowienia zestawu i mediów: ten sam backoff co w lekcjach, z `Retry-After` providera (#300). */
export function retryAt(services: Services, attempts: number, error: unknown): Date {
  const delay = lessonRetryDelayMs(attempts, classifyLessonGenerationFailure(error).retryAfterMs, Math.random);
  return new Date(services.clock.now().getTime() + delay);
}

export function requireGeneration(services: Services): GenerationDeps {
  if (!services.generation) {
    throw new AppError("internal", { message: "generation dependencies not configured" });
  }
  return services.generation;
}

/** Walidacja wyniku AI to porażka terminalna; pozostałe błędy są powtarzalne. */
export function errorCodeOf(error: unknown): string {
  if (error instanceof z.ZodError) {
    return "validation";
  }
  if (error instanceof AppError && error.code === "validation") {
    return "validation";
  }
  return "provider";
}