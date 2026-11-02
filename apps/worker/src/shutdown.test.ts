import { afterEach, describe, expect, it, vi } from "vitest";
import { shutdownWorker } from "./shutdown";

describe("shutdownWorker", () => {
  it("shutdown flushes usage before closing pool", async () => {
    const order: string[] = [];
    // Każdy krok kończy się dopiero po mikrozadaniu: następny nie może ruszyć przed jego końcem.
    const step = (name: string) => async () => {
      order.push(`${name}:start`);
      await Promise.resolve();
      order.push(`${name}:end`);
    };

    await shutdownWorker({
      loop: { stop: step("loop.stop") },
      usage: { record: () => {}, flush: step("usage.flush") },
      pool: { end: step("pool.end") },
    });

    expect(order).toEqual([
      "loop.stop:start", "loop.stop:end",
      "usage.flush:start", "usage.flush:end",
      "pool.end:start", "pool.end:end",
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes the pool even when flushing usage fails and logs only the step and code", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const order: string[] = [];
    await shutdownWorker({
      loop: { stop: async () => { order.push("loop.stop"); } },
      usage: { record: () => {}, flush: async () => { throw Object.assign(new Error("flush failed: secret payload"), { code: "57P01" }); } },
      pool: { end: async () => { order.push("pool.end"); } },
    });
    expect(order).toEqual(["loop.stop", "pool.end"]);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledWith("[worker] shutdown step failed", { step: "usage.flush", code: "57P01" });
    expect(JSON.stringify(errors.mock.calls)).not.toContain("secret payload");
  });

  it("logs a failed loop stop by error class when there is no code", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const order: string[] = [];
    await shutdownWorker({
      loop: { stop: async () => { throw new TypeError("loop exploded"); } },
      usage: { record: () => {}, flush: async () => { order.push("usage.flush"); } },
      pool: { end: async () => { order.push("pool.end"); } },
    });
    expect(order).toEqual(["usage.flush", "pool.end"]);
    expect(errors).toHaveBeenCalledWith("[worker] shutdown step failed", { step: "loop.stop", code: "TypeError" });
  });
});
