import { localDateBounds } from "./report-period";

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * Granice miesiąca kalendarzowego (`YYYY-MM`) w strefie rodziny jako półotwarty
 * przedział UTC: lokalna północ pierwszego dnia miesiąca do lokalnej północy
 * pierwszego dnia następnego (DST liczy `localDateBounds`).
 */
export function monthBounds(month: string, timezone: string): { startUtc: string; endExclusiveUtc: string } {
  const match = MONTH_PATTERN.exec(month);
  if (!match) throw new RangeError("Invalid month");
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    startUtc: localDateBounds(`${match[1]}-${pad(monthNumber)}-01`, timezone).startUtc,
    endExclusiveUtc: localDateBounds(`${String(nextYear).padStart(4, "0")}-${pad(nextMonth)}-01`, timezone).startUtc,
  };
}

/** Bieżący miesiąc kalendarzowy `YYYY-MM` w strefie rodziny. */
export function currentMonth(now: Date, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit" })
      .formatToParts(now)
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}`;
}
