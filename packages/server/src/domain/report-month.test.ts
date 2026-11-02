import { describe, expect, it } from "vitest";
import { currentMonth, monthBounds } from "./report-month";

describe("monthBounds", () => {
  it("handles DST and local midnight", () => {
    // Październik: koniec DST (CEST → CET), miesiąc ma 31 dni i 745 godzin.
    expect(monthBounds("2026-10", "Europe/Warsaw")).toEqual({
      startUtc: "2026-09-30T22:00:00.000Z",
      endExclusiveUtc: "2026-10-31T23:00:00.000Z",
    });
    // Marzec: początek DST, koniec miesiąca już w CEST.
    expect(monthBounds("2026-03", "Europe/Warsaw").endExclusiveUtc).toBe("2026-03-31T22:00:00.000Z");
  });

  it("rolls December over to January of the next year", () => {
    expect(monthBounds("2026-12", "Europe/Warsaw")).toEqual({
      startUtc: "2026-11-30T23:00:00.000Z",
      endExclusiveUtc: "2026-12-31T23:00:00.000Z",
    });
  });

  it("rejects an invalid month", () => {
    expect(() => monthBounds("2026-13", "Europe/Warsaw")).toThrow(RangeError);
    expect(() => monthBounds("2026-1", "Europe/Warsaw")).toThrow(RangeError);
    expect(() => monthBounds("2026-00", "Europe/Warsaw")).toThrow(RangeError);
  });
});

describe("currentMonth", () => {
  it("uses the local calendar month of the family timezone", () => {
    expect(currentMonth(new Date("2026-10-31T23:30:00Z"), "Europe/Warsaw")).toBe("2026-11");
    expect(currentMonth(new Date("2026-10-31T22:30:00Z"), "Europe/Warsaw")).toBe("2026-10");
  });
});
