import { describe, expect, it } from "vitest";
import { retryAfterMs } from "./retry-after";

const now = Date.parse("2026-11-06T12:00:00Z");

describe("retryAfterMs", () => {
  it("czyta sekundy i datę HTTP", () => {
    expect(retryAfterMs("5", now)).toBe(5_000);
    expect(retryAfterMs(" 0 ", now)).toBe(0);
    expect(retryAfterMs("Fri, 06 Nov 2026 12:00:07 GMT", now)).toBe(7_000);
    expect(retryAfterMs("Friday, 06-Nov-26 12:00:07 GMT", now)).toBe(7_000);
    expect(retryAfterMs("Fri, 06 Nov 2026 11:00:00 GMT", now)).toBe(0);
  });

  it("brak, pusta albo niepoprawna wartość to brak wskazówki, nie 0 ms", () => {
    for (const raw of [null, undefined, "", "   ", "-5", "-1.5", "abc", "Fri, 99 Foo 2026", "Infinity", "0x10", "abc 2026", "a 2030"]) {
      expect(retryAfterMs(raw, now), JSON.stringify(raw)).toBeUndefined();
    }
  });
});
