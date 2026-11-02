import { REVIEW_CATEGORIES } from "../../domain/lessons/review-criteria";

/** Pole nullable w trybie strict: `anyOf` z `null` (bez typów-unii, które nie wszędzie przechodzą). */
function nullable(schema: Record<string, unknown>): Record<string, unknown> {
  return { anyOf: [{ type: "null" }, schema] };
}

/**
 * Schemat werdyktów krytyka lekcji — STAŁY dla wszystkich wywołań lekcji, żeby
 * prefiks żądania (schemat, wiadomość systemowa, część 1) trafiał w cache.
 * Poprawione ćwiczenie wraca jako tekst JSON (`exerciseJson`) zamiast gałęzi
 * schematu puli. Bez limitów długości i wartości — egzekwuje je Zod po
 * stronie serwera.
 */
export const LESSON_REVIEW_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["n", "verdict", "category", "reasonPl", "exerciseJson"],
        properties: {
          n: { type: "integer" },
          verdict: { type: "string", enum: ["ok", "note", "fix", "drop"] },
          category: nullable({ type: "string", enum: [...REVIEW_CATEGORIES] }),
          reasonPl: nullable({ type: "string" }),
          exerciseJson: nullable({ type: "string" }),
        },
      },
    },
  },
};
