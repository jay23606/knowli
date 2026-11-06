import { afterEach, describe, expect, it, vi } from "vitest";
import { GenerationProviderError } from "../../../ports/generation-error";
import { assertLessonGenerationFinalizationAllowed, LessonGenerationCancelledError, withLessonGenerationControl } from "./lesson-generation-control";

afterEach(() => vi.useRealTimers());

describe("withLessonGenerationControl", () => {
  it("rejects finalization after shutdown or the whole-run deadline", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => assertLessonGenerationFinalizationAllowed(100, controller.signal, () => 50)).toThrow(LessonGenerationCancelledError);
    expect(() => assertLessonGenerationFinalizationAllowed(100, undefined, () => 100)).toThrow(GenerationProviderError);
  });

  it("przerywa zawieszony request po deadline i nie czeka na provider ignorujący abort", async () => {
    vi.useFakeTimers();
    let resolveLate!: (value: string) => void;
    let signal!: AbortSignal;
    const pending = new Promise<string>((resolve) => { resolveLate = resolve; });
    const run = withLessonGenerationControl({ requestTimeoutMs: 25, runTimeoutMs: 200, cancelPollMs: 100, assertCurrent: async () => true },
      (control) => control.call((requestSignal) => { signal = requestSignal; return pending; }));
    const assertion = expect(run).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(26);
    await assertion;
    expect(signal.aborted).toBe(true);
    resolveLate("late result");
    await Promise.resolve();
  });

  it("cały run ma jeden wspólny budget dla wielu requestów", async () => {
    vi.useFakeTimers();
    const run = withLessonGenerationControl({ requestTimeoutMs: 100, runTimeoutMs: 20, cancelPollMs: 100, assertCurrent: async () => true }, async (control) => {
      await control.call((signal) => new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 15);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      }));
      await control.call(() => new Promise<void>(() => undefined));
    });
    const assertion = expect(run).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(21);
    await assertion;
  });

  describe("run", () => {
    it("run nie ma limitu pojedynczego żądania", async () => {
      vi.useFakeTimers();
      const run = withLessonGenerationControl({ requestTimeoutMs: 25, runTimeoutMs: 500, cancelPollMs: 1000, assertCurrent: async () => true },
        (control) => control.run(() => new Promise<string>((resolve) => setTimeout(() => resolve("wynik"), 100))));
      await vi.advanceTimersByTimeAsync(101);
      await expect(run).resolves.toBe("wynik");
    });

    it("run mapuje przerwanie: superseded, shutdown, timeout", async () => {
      vi.useFakeTimers();
      const hang = (signal: AbortSignal) => new Promise<never>(() => { void signal; });
      const rethrowReason = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });

      for (const work of [hang, rethrowReason]) {
        const controller = new AbortController();
        const shutdown = withLessonGenerationControl({ requestTimeoutMs: 25, runTimeoutMs: 500, cancelPollMs: 1000, signal: controller.signal, assertCurrent: async () => true },
          (control) => control.run(work));
        const shutdownAssertion = expect(shutdown).rejects.toMatchObject({ reason: "shutdown" });
        controller.abort();
        await vi.advanceTimersByTimeAsync(1);
        await shutdownAssertion;

        let calls = 0;
        const superseded = withLessonGenerationControl({ requestTimeoutMs: 25, runTimeoutMs: 500, cancelPollMs: 10, assertCurrent: async () => ++calls < 2 },
          (control) => control.run(work));
        const supersededAssertion = expect(superseded).rejects.toMatchObject({ reason: "superseded" });
        await vi.advanceTimersByTimeAsync(11);
        await supersededAssertion;

        const timeout = withLessonGenerationControl({ requestTimeoutMs: 25, runTimeoutMs: 200, cancelPollMs: 1000, assertCurrent: async () => true },
          (control) => control.run(work));
        const timeoutAssertion = expect(timeout).rejects.toMatchObject({ kind: "timeout" });
        await vi.advanceTimersByTimeAsync(201);
        await timeoutAssertion;
      }
    });

    it("deadlineAtMs = start + runTimeoutMs", async () => {
      const clock = 1_000;
      const deadline = await withLessonGenerationControl(
        { requestTimeoutMs: 25, runTimeoutMs: 500, cancelPollMs: 1000, assertCurrent: async () => true, now: () => clock },
        async (control) => control.deadlineAtMs,
      );
      expect(deadline).toBe(1_500);
    });
  });

  it("anuluje wszystkie requesty po zmianie tożsamości runu", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const run = withLessonGenerationControl({ requestTimeoutMs: 200, runTimeoutMs: 500, cancelPollMs: 10, assertCurrent: async () => ++calls < 2 },
      (control) => control.call((signal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))));
    const assertion = expect(run).rejects.toThrow(/superseded/);
    await vi.advanceTimersByTimeAsync(11);
    await assertion;
  });

  it("nieudany odczyt tożsamości runu po udanej pracy nie wyrzuca wyniku (#321)", async () => {
    let workDone = false;
    const assertCurrent = async () => {
      if (workDone) throw new Error("connection reset");
      return true;
    };
    const work = async () => {
      workDone = true;
      return "done";
    };
    const options = { requestTimeoutMs: 1_000, runTimeoutMs: 5_000, cancelPollMs: 60_000, assertCurrent };
    await expect(withLessonGenerationControl(options, (control) => control.run(work))).resolves.toBe("done");
    workDone = false;
    await expect(withLessonGenerationControl(options, (control) => control.call(work))).resolves.toBe("done");
  });

  it("zmieniona tożsamość runu po udanej pracy nadal przerywa (superseded)", async () => {
    let workDone = false;
    const options = { requestTimeoutMs: 1_000, runTimeoutMs: 5_000, cancelPollMs: 60_000, assertCurrent: async () => !workDone };
    await expect(withLessonGenerationControl(options, (control) => control.run(async () => {
      workDone = true;
      return "done";
    }))).rejects.toThrow(/superseded/);
  });
});
