import { localDay } from "./local-date";
import type { AttemptQualification, EvaluationContext, IndependenceReason, Policy } from "./types";

/**
 * Kwalifikacja próby jako niezależnego sprawdzenia pamięci (SPEC §18.1–3):
 * pierwsza próba w zadaniu, bez wsparcia i po upływie czasu od ujawnienia
 * rozwiązania. Przerwa 12 godzin i inny dzień lokalny liczone są na absolutnych
 * instantach, więc zmiana czasu (DST) nie zafałszuje wyniku.
 */
export function qualifyAttempt(ctx: EvaluationContext): AttemptQualification {
  const reason = independenceReason(ctx);
  return {
    independent: reason === undefined,
    confirmationEligible: crossBreakEligible(
      ctx.receivedAt,
      ctx.previousSessionContactAt,
      ctx.policy,
      ctx.timezone,
    ),
    ...(reason ? { reason } : {}),
  };
}

function independenceReason(ctx: EvaluationContext): IndependenceReason | undefined {
  if (!ctx.firstTry) return "not_first_try";
  if (ctx.assistance.length > 0) return "assisted";
  if (ctx.lastExposureAt !== null) {
    const elapsedMs = Date.parse(ctx.receivedAt) - Date.parse(ctx.lastExposureAt);
    if (elapsedMs < ctx.policy.independenceAfterSeconds * 1000) return "recent_exposure";
  }
  return undefined;
}

/**
 * Czy sukces w `receivedAt` może potwierdzić opanowanie po przerwie od
 * `previousSessionContactAt` (SPEC §18.3, A30): co najmniej `confirmationMinHours`
 * absolutnych i inny dzień lokalny rodziny. Funkcja współdzielona przez
 * kwalifikację słówek i celów lekcji — bez stałych czasowych poza polityką.
 */
export function crossBreakEligible(
  receivedAt: string,
  previousSessionContactAt: string | null,
  policy: Policy,
  timezone: string,
): boolean {
  if (previousSessionContactAt === null) return false;
  const elapsedMs = Date.parse(receivedAt) - Date.parse(previousSessionContactAt);
  if (elapsedMs < policy.confirmationMinHours * 3_600_000) return false;
  return localDay(receivedAt, timezone) !== localDay(previousSessionContactAt, timezone);
}
