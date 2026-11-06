export interface LessonGenerationPolicy {
  requestTimeoutMs: number;
  runTimeoutMs: number;
  cancelPollMs: number;
}

export const DEFAULT_LESSON_GENERATION_POLICY: LessonGenerationPolicy = {
  requestTimeoutMs: 90_000,
  runTimeoutMs: 600_000,
  cancelPollMs: 1_000,
};

function positiveInteger(value: string | undefined, fallback: number, key: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${key} must be a positive integer`);
  return parsed;
}

export function lessonGenerationPolicyFromEnv(env: Record<string, string | undefined>): LessonGenerationPolicy {
  const policy = {
    requestTimeoutMs: positiveInteger(env.UMIEM_LESSON_GENERATION_REQUEST_TIMEOUT_MS, DEFAULT_LESSON_GENERATION_POLICY.requestTimeoutMs, "UMIEM_LESSON_GENERATION_REQUEST_TIMEOUT_MS"),
    runTimeoutMs: positiveInteger(env.UMIEM_LESSON_GENERATION_RUN_TIMEOUT_MS, DEFAULT_LESSON_GENERATION_POLICY.runTimeoutMs, "UMIEM_LESSON_GENERATION_RUN_TIMEOUT_MS"),
    cancelPollMs: positiveInteger(env.UMIEM_LESSON_GENERATION_CANCEL_POLL_MS, DEFAULT_LESSON_GENERATION_POLICY.cancelPollMs, "UMIEM_LESSON_GENERATION_CANCEL_POLL_MS"),
  };
  if (policy.requestTimeoutMs > policy.runTimeoutMs) {
    throw new Error("UMIEM_LESSON_GENERATION_REQUEST_TIMEOUT_MS must not exceed UMIEM_LESSON_GENERATION_RUN_TIMEOUT_MS");
  }
  return policy;
}
