import { createHash } from "node:crypto";

/** Kanoniczny JSON: klucze sortowane rekurencyjnie, pola `undefined` pomijane (jak w jsonb). */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : canonical(item)));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        // Kolejność jednostek kodu UTF-16 (jak domyślne `sort`), niezależna od ustawień regionalnych.
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}

/**
 * Odcisk payloadu ćwiczenia: sha256 kanonicznego JSON. Ten sam dla payloadu z
 * `buildLessonPayload` i dla payloadu odczytanego z bazy (jsonb zmienia kolejność kluczy).
 */
export function exerciseFingerprint(payload: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
}
