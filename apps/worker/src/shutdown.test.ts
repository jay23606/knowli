import { describe, expect, it } from "vitest";
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

  it("closes the pool even when flushing usage fails", async () => {
    const order: string[] = [];
    await shutdownWorker({
      loop: { stop: async () => { order.push("loop.stop"); } },
      usage: { record: () => {}, flush: async () => { throw new Error("flush failed"); } },
      pool: { end: async () => { order.push("pool.end"); } },
    });
    expect(order).toEqual(["loop.stop", "pool.end"]);
  });
});
