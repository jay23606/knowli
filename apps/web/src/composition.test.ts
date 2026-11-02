import { describe, expect, it } from "vitest";
import { disposeServices } from "./composition";

describe("disposeServices", () => {
  it("flushes usage before closing the pool", async () => {
    const order: string[] = [];
    const step = (name: string) => async () => {
      order.push(`${name}:start`);
      await Promise.resolve();
      order.push(`${name}:end`);
    };

    await disposeServices({ usage: { record: () => {}, flush: step("usage.flush") }, pool: { end: step("pool.end") } });

    expect(order).toEqual(["usage.flush:start", "usage.flush:end", "pool.end:start", "pool.end:end"]);
  });

  it("closes the pool without a recorder (fake providers)", async () => {
    const order: string[] = [];
    await disposeServices({ pool: { end: async () => { order.push("pool.end"); } } });
    expect(order).toEqual(["pool.end"]);
  });
});
