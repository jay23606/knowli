import { afterEach, describe, expect, it, vi } from "vitest";
import { withConfigDefaults } from "@learning/server";
import { createWorkerLoop, workerLoopSettingsFromEnv } from "./loop";

afterEach(() => vi.useRealTimers());

describe("budżety domyślne a próg zdrowia workera", () => {
  it("domyślny limit runu generacji lekcji mieści się w WORKER_HEALTH_STALE_MS", () => {
    const env = withConfigDefaults({});
    expect(Number(env.UMIEM_LESSON_GENERATION_RUN_TIMEOUT_MS)).toBeLessThan(workerLoopSettingsFromEnv(env).staleMs);
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
