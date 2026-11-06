import { isLocalDate, localDay, localMidnight } from "./local-date";

const PREPARATION_WINDOW_MS = 48 * 60 * 60 * 1000;

export function isTestPreparationWindow(input: {
  now: string;
  testDate: string | null;
  timezone: string;
}): boolean {
  const now = Date.parse(input.now);
  if (!Number.isFinite(now) || input.testDate === null || !isLocalDate(input.testDate)) {
    return false;
  }

  try {
    const today = localDay(now, input.timezone);
    if (today === input.testDate) return true;
    if (today > input.testDate) return false;

    const start = localMidnight(input.testDate, input.timezone);
    return now < start && start - now <= PREPARATION_WINDOW_MS;
  } catch {
    // Unknown zone or skipped local midnight: no priority from an ambiguous boundary.
    return false;
  }
}
