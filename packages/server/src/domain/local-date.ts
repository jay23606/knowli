/** Daty lokalne (YYYY-MM-DD) i granice dnia w strefie czasowej rodziny. */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function cachedFormatter(
  cache: Map<string, Intl.DateTimeFormat>,
  locale: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  let formatter = cache.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, { timeZone, ...options });
    cache.set(timeZone, formatter);
  }
  return formatter;
}

/** Dzień lokalny chwili (`en-CA` formatuje jako YYYY-MM-DD); nieznana strefa rzuca `RangeError`. */
export function localDay(instant: Date | string | number, timeZone: string): string {
  return cachedFormatter(dayFormatters, "en-CA", timeZone, { year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(instant));
}

export function isLocalDate(day: string): boolean {
  if (!DATE_PATTERN.test(day)) return false;
  const parsed = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === day;
}

export function addDays(day: string, count: number): string {
  const stamp = Date.parse(`${day}T00:00:00.000Z`);
  return new Date(stamp + count * 86_400_000).toISOString().slice(0, 10);
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function partsAt(format: Intl.DateTimeFormat, instant: number): LocalParts {
  const parts = Object.fromEntries(
    format.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]),
  );
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
  };
}

function dateString({ year, month, day }: LocalParts): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Chwila (ms) lokalnej północy dnia `day`. Przelicza czas zegarowy na chwilę,
 * korygując o rzeczywisty offset strefy po każdym kroku, więc DST wynika z reguł
 * kalendarza, a nie ze stałego offsetu ani 24-godzinnej doby. Gdy północ w danej
 * strefie nie istnieje (przeskok zegara o 00:00), rzuca `RangeError`.
 */
export function localMidnight(day: string, timeZone: string): number {
  const format = cachedFormatter(timeFormatters, "en-GB", timeZone, {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const [year, month, date] = day.split("-").map(Number);
  const target = Date.UTC(year, month - 1, date);
  let candidate = target;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = partsAt(format, candidate);
    const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    candidate += target - represented;
    const resolved = partsAt(format, candidate);
    if (dateString(resolved) === day && resolved.hour === 0 && resolved.minute === 0 && resolved.second === 0) {
      return candidate;
    }
  }
  throw new RangeError(`Local midnight does not exist for ${day}`);
}
