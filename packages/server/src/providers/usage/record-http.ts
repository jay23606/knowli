import type { UsageEvent, UsageRecorder } from "../../ports/usage";
import { usageFromPayload } from "./payload";

/**
 * Wspólne zapisy kosztów dla adapterów HTTP (spec `2026-11-02-llm-cost-tracking-design.md`
 * §4.2): jedno żądanie HTTP = jeden `record`. Adapter trzyma lokalną flagę
 * `recorded`, ustawia ją po wywołaniu jednego z helperów i w `catch` transportu
 * woła `recordTransportFailure` tylko przy `!recorded` — błąd 5xx rzucony we
 * własnym `try` nie zostaje więc zapisany drugi raz. Każdy helper sam łapie
 * wyjątek z `usage.record` (podwójna ochrona obok recordera, który też nie
 * rzuca): zapis kosztów nigdy nie zmienia wyniku adaptera. Helpery nie czytają
 * ani nie przechowują treści odpowiedzi poza liczbami z `usage`.
 */
export type UsageEventBase = Omit<UsageEvent, "outcome" | "httpStatus">;

function safeRecord(usage: UsageRecorder | undefined, event: UsageEvent): void {
  if (!usage) return;
  try {
    usage.record(event);
  } catch {
    // zapis kosztów jest best-effort; wynik adaptera zostaje bez zmian
  }
}

/** Odpowiedź 2xx z odczytanym ciałem: `ok` z tokenami i kosztem z `usage` (treść jeszcze niezwalidowana). */
export function recordResponse(
  usage: UsageRecorder | undefined,
  base: UsageEventBase,
  status: number,
  payload: unknown,
): void {
  safeRecord(usage, { ...base, ...usageFromPayload(payload), outcome: "ok", httpStatus: status });
}

/** Ciało odpowiedzi 2xx nie dało się odczytać: `failed` z kodem HTTP (wycena da `unknown`). */
export function recordUnreadable(usage: UsageRecorder | undefined, base: UsageEventBase, status: number): void {
  safeRecord(usage, { ...base, outcome: "failed", httpStatus: status });
}

/** Odpowiedź nie-2xx: `failed` z kodem HTTP. */
export function recordHttpError(usage: UsageRecorder | undefined, base: UsageEventBase, status: number): void {
  safeRecord(usage, { ...base, outcome: "failed", httpStatus: status });
}

/** Brak odpowiedzi (sieć, abort, timeout): `failed` bez kodu HTTP. */
export function recordTransportFailure(usage: UsageRecorder | undefined, base: UsageEventBase): void {
  safeRecord(usage, { ...base, outcome: "failed" });
}
