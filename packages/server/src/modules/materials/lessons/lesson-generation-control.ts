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
  /**
   * Długa praca (kierownik puli): sygnał korzenia kontrolera bez limitu pojedynczego żądania
   * (requestTimeoutMs). Przerwanie mapowane jak w call: superseded/shutdown →
   * LessonGenerationCancelledError, termin runu → GenerationProviderError("timeout").
   */
  run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /** Termin runu (startedAt + runTimeoutMs) w zegarze kontrolera. */
  readonly deadlineAtMs: number;
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

  /** Wyjątek odpowiadający przerwaniu; `requestTimedOut` — limit pojedynczego żądania. */
  const abortFailure = (requestTimedOut: boolean): Error =>
    requestTimedOut || abortReason === "timeout"
      ? new GenerationProviderError("timeout")
      : abortReason === "superseded"
        ? new LessonGenerationCancelledError("superseded")
        : abortReason === "shutdown"
          ? new LessonGenerationCancelledError("shutdown")
          : new GenerationProviderError("timeout");

  /** Wyścig pracy z sygnałem przerwania (wspólny dla call/callSoft/run), z weryfikacją po sukcesie. */
  const race = async <R>(
    request: (signal: AbortSignal) => Promise<R>,
    signal: AbortSignal,
    requestTimedOut: { value: boolean },
  ): Promise<R> => {
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(abortFailure(requestTimedOut.value));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    const pending = Promise.resolve().then(() => request(signal));
    try {
      const result = await Promise.race([pending, aborted]);
      await verifyCurrent();
      return result;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw abortFailure(requestTimedOut.value);
      }
      throw error;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  };

  /** Czas pozostały do terminu runu; po jego upływie zamyka zakres (timeout runu). */
  const remainingRunMs = (): number => {
    const remaining = options.runTimeoutMs - (now() - startedAt);
    if (remaining <= 0) {
      abort("timeout");
      throw new GenerationProviderError("timeout");
    }
    return remaining;
  };

  /** `soft`: limit żądania przerywa tylko to żądanie; bez tego zamyka cały zakres (timeout runu). */
  const invoke = async <R>(request: (signal: AbortSignal) => Promise<R>, soft: boolean): Promise<R> => {
    await verifyCurrent();
    const remaining = remainingRunMs();
    const requestTimedOut = { value: false };
    const requestAbort = new AbortController();
    const timeoutDelay = Math.min(options.requestTimeoutMs, remaining);
    const requestTimer = setTimeout(() => {
      requestTimedOut.value = options.requestTimeoutMs <= remaining;
      if (requestTimedOut.value && !soft) abort("timeout");
      else requestAbort.abort();
    }, timeoutDelay);
    try {
      return await race(request, AbortSignal.any([root.signal, requestAbort.signal]), requestTimedOut);
    } finally {
      clearTimeout(requestTimer);
    }
  };

  /** Długa praca (np. kierownik puli): tylko sygnał korzenia, bez limitu pojedynczego żądania. */
  const runLong = async <R>(request: (signal: AbortSignal) => Promise<R>): Promise<R> => {
    await verifyCurrent();
    remainingRunMs();
    return race(request, root.signal, { value: false });
  };

  const control: LessonGenerationControl = {
    assertCurrent: verifyCurrent,
    call: (request) => invoke(request, false),
    callSoft: (request) => invoke(request, true),
    run: runLong,
    deadlineAtMs: startedAt + options.runTimeoutMs,
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
