import { addDays, isLocalDate, localDay, localMidnight } from "./local-date";

export type ReportPeriod = {
  from: string;
  to: string;
  days: number;
  dates: readonly string[];
  startUtc: string;
  endExclusiveUtc: string;
};

function assertTimezone(timezone: string): void {
  try {
    // Force ICU to validate the zone before deriving any date boundaries.
    localDay(0, timezone);
  } catch {
    throw new RangeError("Invalid IANA timezone");
  }
}

export function localDateBounds(day: string, timezone: string): { startUtc: string; endExclusiveUtc: string } {
  if (!isLocalDate(day)) throw new RangeError("Invalid local date");
  assertTimezone(timezone);
  return {
    startUtc: new Date(localMidnight(day, timezone)).toISOString(),
    endExclusiveUtc: new Date(localMidnight(addDays(day, 1), timezone)).toISOString(),
  };
}

export function buildReportPeriod(now: string, timezone: string, days: number): ReportPeriod {
  const instant = Date.parse(now);
  if (!Number.isFinite(instant)) throw new RangeError("Invalid report instant");
  if (!Number.isInteger(days) || days < 1 || days > 31) throw new RangeError("Invalid report period length");

  assertTimezone(timezone);

  const to = localDay(instant, timezone);
  const from = addDays(to, 1 - days);
  const dates = Array.from({ length: days }, (_, index) => addDays(from, index));
  const start = localMidnight(from, timezone);
  const end = localMidnight(addDays(to, 1), timezone);
  return {
    from,
    to,
    days,
    dates,
    startUtc: new Date(start).toISOString(),
    endExclusiveUtc: new Date(end).toISOString(),
  };
}
