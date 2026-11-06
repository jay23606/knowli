import { ZodError } from "zod";
import { AppError } from "../../../errors";
import { GenerationProviderError } from "../../../ports/generation-error";

export interface LessonGenerationFailure {
  errorCode: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export function classifyLessonGenerationFailure(error: unknown): LessonGenerationFailure {
  if (error instanceof ZodError || (error instanceof AppError && error.code === "validation")) {
    return { errorCode: "validation", retryable: false };
  }
  if (error instanceof GenerationProviderError) {
    const errorCode: Record<GenerationProviderError["kind"], string> = {
      configuration: "provider_configuration",
      rate_limit: "provider_rate_limit",
      transient: "provider",
      timeout: "provider_timeout",
      refusal: "provider_refusal",
      incomplete: "provider_incomplete",
      output: "provider_output",
    };
    const retryable = error.kind === "rate_limit" || error.kind === "transient";
    return {
      errorCode: errorCode[error.kind],
      retryable,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    };
  }
  // Błąd w kodzie (np. narzędzie agenta na nietypowym wyjściu modelu) jest deterministyczny: ponowienie płaci za to samo (#320).
  if (error instanceof TypeError || error instanceof RangeError || error instanceof AppError) {
    return { errorCode: "internal", retryable: false };
  }
  const legacyRetryable = (error as { retryable?: unknown } | null)?.retryable;
  return { errorCode: "provider", retryable: legacyRetryable !== false };
}

export function lessonRetryDelayMs(
  attempt: number,
  retryAfterMs: number | undefined,
  random: () => number,
): number {
  const safeAttempt = Math.max(1, Math.min(10, Math.floor(attempt)));
  const base = Math.min(30_000, 1_000 * 2 ** (safeAttempt - 1));
  const jitter = Math.floor(base * 0.2 * Math.max(0, Math.min(1, random())));
  const backoff = base + jitter;
  return Number.isFinite(retryAfterMs) && retryAfterMs! > 0 ? Math.max(backoff, Math.floor(retryAfterMs!)) : backoff;
}
