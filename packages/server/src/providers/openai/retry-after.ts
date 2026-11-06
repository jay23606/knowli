/**
 * `Retry-After` w sekundach albo jako data HTTP; brak, pusta lub nieczytelna
 * wartość = brak wskazówki (wywołujący bierze własny odstęp), nie 0 ms.
 */
export function retryAfterMs(raw: string | null | undefined, now = Date.now()): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1_000;
  // Wszystkie trzy formaty daty HTTP zaczynają się nazwą dnia i mają hh:mm:ss; bez tego V8 czyta „-5” albo „a 2030” jako rok.
  if (!/^[a-z]+,? .*\d\d:\d\d:\d\d/i.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}
