/**
 * Terminy i ograniczenie równoległości agenta puli lekcji (etap 1 issue #237).
 * Terminy stoją na `setTimeout` + `AbortController` (wzór
 * `lesson-generation-control.ts`), nigdy `AbortSignal.timeout` — testy sterują
 * czasem przez fake timers, a `dispose` zdejmuje zegar i nasłuch rodzica.
 */

/**
 * Sygnał przerwany przez rodzica (z jego powodem) albo po `ms` z powodem `reason`.
 * Wołający musi wywołać `dispose()` po zakończeniu operacji, także po błędzie.
 */
export function deadlineSignal(parent: AbortSignal, ms: number, reason: string): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent.reason);
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (parent.aborted) {
    controller.abort(parent.reason);
  } else {
    parent.addEventListener("abort", onParentAbort, { once: true });
    timer = setTimeout(() => controller.abort(reason), ms);
  }
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      parent.removeEventListener("abort", onParentAbort);
    },
  };
}

/**
 * Wyścig obietnicy dostawcy z sygnałem: przerwanie odrzuca wynik z `signal.reason`, nawet gdy
 * dostawca ignoruje sygnał i nigdy się nie kończy (terminy nie zależą od uczciwości adaptera).
 * Spóźniony wynik albo błąd porzuconej obietnicy są pochłaniane; nasłuch zdejmowany po rozstrzygnięciu.
 */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(signal.reason as Error);
  }
  return new Promise<T>((resolve, reject) => {
    // Po przerwaniu późniejsze `resolve`/`reject` niżej nic nie zmieniają (obietnica już odrzucona).
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error as Error);
      },
    );
  });
}

/** Semafor FIFO: najwyżej `limit` zadań naraz; `maxConcurrent` to zaobserwowane maksimum. */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private observedMax = 0;

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`invalid semaphore limit ${limit}`);
  }

  get maxConcurrent(): number {
    return this.observedMax;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.take();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.take();
        resolve();
      });
    });
  }

  private take(): void {
    this.active += 1;
    this.observedMax = Math.max(this.observedMax, this.active);
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }
}
