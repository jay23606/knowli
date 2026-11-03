import { reviewerEnabled } from "@learning/server";

export interface WorkerLoopOptions {
  pollMs: number;
  staleMs: number;
  processPass: (signal: AbortSignal, reportProgress: () => void) => Promise<void>;
  now: () => number;
  onError?: (error: unknown) => void;
}

export interface WorkerLoopHealth {
  healthy: boolean;
  lastPassAt: number | null;
  passStartedAt: number | null;
}

export interface WorkerLoop {
  start(): void;
  stop(): Promise<void>;
  health(): WorkerLoopHealth;
}

function positiveSetting(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
  return value;
}

export function workerLoopSettingsFromEnv(env: Record<string, string | undefined>): { pollMs: number; staleMs: number } {
  return {
    pollMs: positiveSetting(env, "WORKER_POLL_MS", 2_000),
    staleMs: positiveSetting(env, "WORKER_HEALTH_STALE_MS", 900_000),
  };
}

/**
 * Ostrzeżenie startowe (bez przerywania startu): przy włączonym krytyku lekcji najdłuższy przebieg
 * generowania (`UMIEM_LESSON_GENERATION_RUN_TIMEOUT_MS` + `UMIEM_REVIEWER_PHASE_BUDGET_MS`) nie mieści się
 * w progu zdrowia `WORKER_HEALTH_STALE_MS`, więc health mógłby zgłosić „stale” w trakcie poprawnego przebiegu.
 * `env` po `withConfigDefaults`; nieczytelne liczby zostawiamy walidacji przy składaniu usług.
 */
export function reviewerHealthBudgetWarning(env: Record<string, string | undefined>): string | undefined {
  if (!reviewerEnabled(env)) return undefined;
  const runTimeoutMs = Number(env.UMIEM_LESSON_GENERATION_RUN_TIMEOUT_MS);
  const phaseBudgetMs = Number(env.UMIEM_REVIEWER_PHASE_BUDGET_MS);
  if (!Number.isFinite(runTimeoutMs) || !Number.isFinite(phaseBudgetMs)) return undefined;
  const { staleMs } = workerLoopSettingsFromEnv(env);
  if (runTimeoutMs + phaseBudgetMs < staleMs) return undefined;
  return `[worker] UMIEM_LESSON_GENERATION_RUN_TIMEOUT_MS (${runTimeoutMs}) + UMIEM_REVIEWER_PHASE_BUDGET_MS (${phaseBudgetMs}) ≥ WORKER_HEALTH_STALE_MS (${staleMs}) — długi przebieg generowania lekcji z krytykiem może oznaczyć workera jako „stale”; podnieś WORKER_HEALTH_STALE_MS albo obniż budżety`;
}

/** Single-flight poll loop; the next pass is scheduled after the current one ends. */
export function createWorkerLoop(options: WorkerLoopOptions): WorkerLoop {
  const startedAt = options.now();
  let started = false;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let active: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let lastPassAt: number | null = null;
  let passStartedAt: number | null = null;
  let lastProgressAt: number | null = null;

  const schedule = () => {
    if (stopping) return;
    timer = setTimeout(() => void runPass(), options.pollMs);
  };

  const runPass = (): Promise<void> => {
    if (stopping) return Promise.resolve();
    passStartedAt = options.now();
    lastProgressAt = passStartedAt;
    controller = new AbortController();
    const passController = controller;
    let work: Promise<void>;
    try {
      work = Promise.resolve(options.processPass(passController.signal, () => { lastProgressAt = options.now(); }));
    } catch (error) {
      work = Promise.reject(error);
    }
    active = work
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        lastPassAt = options.now();
        passStartedAt = null;
        controller = undefined;
        active = undefined;
        schedule();
      });
    return active;
  };

  return {
    start() {
      if (started || stopping) return;
      started = true;
      void runPass();
    },
    async stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
      stopPromise = active?.catch(() => undefined) ?? Promise.resolve();
      await stopPromise;
    },
    health() {
      const reference = passStartedAt === null ? lastPassAt ?? startedAt : lastProgressAt ?? passStartedAt;
      return {
        healthy: options.now() - reference <= options.staleMs,
        lastPassAt,
        passStartedAt,
      };
    },
  };
}
