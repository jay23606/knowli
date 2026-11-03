import { afterEach, describe, expect, it, vi } from "vitest";
import { withConfigDefaults } from "@learning/server";
import { createWorkerLoop, reviewerHealthBudgetWarning, workerLoopSettingsFromEnv } from "./loop";

afterEach(() => vi.useRealTimers());

describe("budżety domyślne a próg zdrowia workera", () => {
  it("przebieg generacji lekcji plus faza krytyka mieszczą się w WORKER_HEALTH_STALE_MS", () => {
    const env = withConfigDefaults({});
    const budget = Number(env.UMIEM_LESSON_GENERATION_RUN_TIMEOUT_MS) + Number(env.UMIEM_REVIEWER_PHASE_BUDGET_MS);
    expect(budget).toBeLessThan(workerLoopSettingsFromEnv(env).staleMs);
    expect(reviewerHealthBudgetWarning({ ...env, UMIEM_REVIEWER_ENABLED: "true" })).toBeUndefined();
  });

  it("ostrzega (bez rzucania) przy włączonym krytyku, gdy suma budżetów sięga progu zdrowia", () => {
    const env = withConfigDefaults({ UMIEM_REVIEWER_ENABLED: "true", UMIEM_LESSON_GENERATION_RUN_TIMEOUT_MS: "660000", UMIEM_REVIEWER_PHASE_BUDGET_MS: "240000" });
    expect(reviewerHealthBudgetWarning(env)).toBe(
      "[worker] UMIEM_LESSON_GENERATION_RUN_TIMEOUT_MS (660000) + UMIEM_REVIEWER_PHASE_BUDGET_MS (240000) ≥ WORKER_HEALTH_STALE_MS (900000) — długi przebieg generowania lekcji z krytykiem może oznaczyć workera jako „stale”; podnieś WORKER_HEALTH_STALE_MS albo obniż budżety",
    );
    expect(reviewerHealthBudgetWarning({ ...env, WORKER_HEALTH_STALE_MS: "900001" })).toBeUndefined();
  });

  it("krytyk wyłączony albo nieczytelne liczby: bez ostrzeżenia", () => {
    const tight = { UMIEM_LESSON_GENERATION_RUN_TIMEOUT_MS: "900000", UMIEM_REVIEWER_PHASE_BUDGET_MS: "240000" };
    expect(reviewerHealthBudgetWarning(withConfigDefaults(tight))).toBeUndefined();
    expect(reviewerHealthBudgetWarning(withConfigDefaults({ ...tight, UMIEM_REVIEWER_ENABLED: "false" }))).toBeUndefined();
    expect(reviewerHealthBudgetWarning(withConfigDefaults({ ...tight, UMIEM_REVIEWER_ENABLED: "true", UMIEM_REVIEWER_PHASE_BUDGET_MS: "abc" }))).toBeUndefined();
  });
});

describe("createWorkerLoop", () => {
  it("validates a positive stale threshold and supplies defaults", () => {
    expect(workerLoopSettingsFromEnv({})).toEqual({ pollMs: 2_000, staleMs: 900_000 });
    expect(() => workerLoopSettingsFromEnv({ WORKER_HEALTH_STALE_MS: "0" })).toThrow(/positive integer/);
    expect(() => workerLoopSettingsFromEnv({ WORKER_HEALTH_STALE_MS: "NaN" })).toThrow(/positive integer/);
  });

  it("nie rozpoczyna nakładających się przelotów podczas długiej pracy", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let signal!: AbortSignal;
    const loop = createWorkerLoop({ pollMs: 10, staleMs: 100, now: Date.now, processPass: (nextSignal) => {
      calls += 1;
      signal = nextSignal;
      return new Promise<void>((resolve) => nextSignal.addEventListener("abort", () => resolve(), { once: true }));
    } });
    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);
    await loop.stop();
    expect(signal.aborted).toBe(true);
  });

  it("zatrzymanie abortuje przelot i nie planuje kolejnego", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const loop = createWorkerLoop({ pollMs: 10, staleMs: 100, now: Date.now, processPass: async () => { calls += 1; } });
    loop.start();
    await vi.advanceTimersByTimeAsync(1);
    await loop.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(1);
  });

  it("health jest zdrowy przed pierwszym przelotem, gdy trwa i po świeżym przelocie", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const loop = createWorkerLoop({ pollMs: 100, staleMs: 50, now: Date.now, processPass: () => new Promise<void>((resolve) => { release = resolve; }) });
    expect(loop.health().healthy).toBe(true);
    loop.start();
    expect(loop.health().healthy).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(loop.health().healthy).toBe(true);
    await vi.advanceTimersByTimeAsync(51);
    expect(loop.health().healthy).toBe(false);
    await loop.stop();
  });

  it("utrzymuje health podczas produktywnego długiego przelotu, ale wygasa bez postępu", async () => {
    vi.useFakeTimers();
    let reportProgress!: () => void;
    const loop = createWorkerLoop({
      pollMs: 100,
      staleMs: 50,
      now: Date.now,
      processPass: (signal, progress) => {
        reportProgress = progress;
        return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(49);
    reportProgress();
    await vi.advanceTimersByTimeAsync(49);
    expect(loop.health().healthy).toBe(true);
    await vi.advanceTimersByTimeAsync(51);
    expect(loop.health().healthy).toBe(false);
    await loop.stop();
  });
});
