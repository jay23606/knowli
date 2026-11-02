import { GenerationProviderError } from "../../../ports/generation-error";

export class LessonGenerationCancelledError extends Error {
  constructor(readonly reason: "superseded" | "shutdown") {
    super(`lesson_generation_${reason}`);
  }
}

export interface LessonGenerationControlOptions {
  requestTimeoutMs: number;
  runTimeoutMs: number;
  cancelPollMs: number;
  assertCurrent: () => Promise<boolean>;
  signal?: AbortSignal;
  now?: () => number;
}

export interface LessonGenerationControl {
  assertCurrent(): Promise<void>;
  call<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /**
   * Jak call, ale przekroczenie requestTimeoutMs przerywa tylko to żądanie (abort własnego
   * kontrolera, bez abort korzenia) i rzuca GenerationProviderError("timeout"); deadline
   * przebiegu, assertCurrent i zamknięcie procesu jak w call.
   */
  callSoft<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

export function assertLessonGenerationFinalizationAllowed(
  runDeadlineAtMs: number,
  signal?: AbortSignal,
  now: () => number = Date.now,
): void {
  if (signal?.aborted) throw new LessonGenerationCancelledError("shutdown");
  if (now() >= runDeadlineAtMs) throw new GenerationProviderError("timeout");
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

/** Bounds a whole multi-request run and interrupts it when its DB identity changes. */
export async function withLessonGenerationControl<T>(
  options: LessonGenerationControlOptions,
  work: (control: LessonGenerationControl) => Promise<T>,
): Promise<T> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const root = new AbortController();
  let abortReason: "timeout" | "superseded" | "shutdown" | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let runTimer: ReturnType<typeof setTimeout> | undefined;

  const abort = (reason: "timeout" | "superseded" | "shutdown") => {
    if (abortReason !== null) return;
    abortReason = reason;
    root.abort();
  };
  const onCallerAbort = () => abort("shutdown");
  if (options.signal?.aborted) onCallerAbort();
  else options.signal?.addEventListener("abort", onCallerAbort, { once: true });

  const verifyCurrent = async (): Promise<void> => {
    if (abortReason === "timeout") throw new GenerationProviderError("timeout");
    if (abortReason === "superseded") throw new LessonGenerationCancelledError("superseded");
    if (abortReason === "shutdown") throw new LessonGenerationCancelledError("shutdown");
    if (!(await options.assertCurrent())) {
      abort("superseded");
      throw new LessonGenerationCancelledError("superseded");
    }
  };

  const poll = async () => {
    if (root.signal.aborted) return;
    try {
      if (!(await options.assertCurrent())) abort("superseded");
    } catch { /* transient DB read failure: keep polling until cancellation or deadline */ }
    if (!root.signal.aborted) pollTimer = setTimeout(() => void poll(), options.cancelPollMs);
  };

  runTimer = setTimeout(() => abort("timeout"), options.runTimeoutMs);
  pollTimer = setTimeout(() => void poll(), options.cancelPollMs);

  /** `soft`: limit żądania przerywa tylko to żądanie; bez tego zamyka cały zakres (timeout runu). */
  const invoke = async <R>(request: (signal: AbortSignal) => Promise<R>, soft: boolean): Promise<R> => {
    await verifyCurrent();
    const elapsed = now() - startedAt;
    const remaining = options.runTimeoutMs - elapsed;
    if (remaining <= 0) {
      abort("timeout");
      throw new GenerationProviderError("timeout");
    }
    const requestTimedOut = { value: false };
    const requestAbort = new AbortController();
    const timeoutDelay = Math.min(options.requestTimeoutMs, remaining);
    const requestTimer = setTimeout(() => {
      requestTimedOut.value = options.requestTimeoutMs <= remaining;
      if (requestTimedOut.value && !soft) abort("timeout");
      else requestAbort.abort();
    }, timeoutDelay);
    const combined = AbortSignal.any([root.signal, requestAbort.signal]);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(
        requestTimedOut.value || abortReason === "timeout"
          ? new GenerationProviderError("timeout")
          : abortReason === "superseded"
            ? new LessonGenerationCancelledError("superseded")
            : abortReason === "shutdown"
              ? new LessonGenerationCancelledError("shutdown")
              : new GenerationProviderError("timeout"),
      );
      combined.addEventListener("abort", onAbort, { once: true });
      if (combined.aborted) onAbort();
    });
    const pending = Promise.resolve().then(() => request(combined));
    try {
      const result = await Promise.race([pending, aborted]);
      await verifyCurrent();
      return result;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new GenerationProviderError("timeout");
      }
      throw error;
    } finally {
      clearTimeout(requestTimer);
      if (onAbort) combined.removeEventListener("abort", onAbort);
    }
  };
  const control: LessonGenerationControl = {
    assertCurrent: verifyCurrent,
    call: (request) => invoke(request, false),
    callSoft: (request) => invoke(request, true),
  };

  try {
    await verifyCurrent();
    return await work(control);
  } finally {
    clearTimeout(pollTimer);
    clearTimeout(runTimer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}
