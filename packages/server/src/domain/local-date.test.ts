import { describe, expect, it } from "vitest";
import { addDays, isLocalDate, localDay, localMidnight } from "./local-date";

describe("local date helpers", () => {
  it("maps an instant to the local calendar date", () => {
    expect(localDay(new Date("2026-10-19T22:30:00Z"), "Europe/Warsaw")).toBe("2026-10-20");
    expect(localDay("2026-10-19T22:30:00Z", "UTC")).toBe("2026-10-19");
    expect(() => localDay(0, "Not/AZone")).toThrow(RangeError);
  });

  it("switches the local day at midnight on both Warsaw DST changes", () => {
    // Wiosna: 2026-03-28 23:59:59 CET = 22:59:59Z; jesień: 2026-10-25 00:00 CEST = 2026-10-24 22:00Z.
    expect(localDay("2026-03-28T22:59:59.999Z", "Europe/Warsaw")).toBe("2026-03-28");
    expect(localDay("2026-03-28T23:00:00.000Z", "Europe/Warsaw")).toBe("2026-03-29");
    expect(localDay("2026-10-24T21:59:59.999Z", "Europe/Warsaw")).toBe("2026-10-24");
    expect(localDay("2026-10-24T22:00:00.000Z", "Europe/Warsaw")).toBe("2026-10-25");
  });

  it("finds local midnight across DST and gives the real day length", () => {
    const hours = (day: string) => (localMidnight(addDays(day, 1), "Europe/Warsaw") - localMidnight(day, "Europe/Warsaw")) / 3_600_000;
    expect(new Date(localMidnight("2026-03-29", "Europe/Warsaw")).toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(new Date(localMidnight("2026-10-25", "Europe/Warsaw")).toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(hours("2026-03-29")).toBe(23);
    expect(hours("2026-10-25")).toBe(25);
  });

  it("rejects a local midnight skipped by the clock change", () => {
    // Chile przestawia zegar z 00:00 na 01:00 w pierwszą niedzielę września.
    expect(() => localMidnight("2024-09-08", "America/Santiago")).toThrow(RangeError);
    expect(new Date(localMidnight("2024-09-09", "America/Santiago")).toISOString()).toBe("2024-09-09T03:00:00.000Z");
  });

  it("validates calendar dates and adds days across month ends", () => {
    expect(isLocalDate("2028-02-29")).toBe(true);
    expect(isLocalDate("2027-02-29")).toBe(false);
    expect(isLocalDate("2026-13-01")).toBe(false);
    expect(isLocalDate("2026-1-01")).toBe(false);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});
