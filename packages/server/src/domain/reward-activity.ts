/**
 * Pomocnicze strefy czasowe i daty lokalne dla raportów nagrody. Rozliczanie
 * czasu/punktów żyje w kontraktach (`sessionActivityAward`) i module
 * `session-activity`; tutaj zostają tylko deterministyczne przeliczenia dat.
 */

export function validRewardTimezone(value: unknown): string {
  if (typeof value !== "string") return "Europe/Warsaw";
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return value;
  } catch {
    return "Europe/Warsaw";
  }
}
