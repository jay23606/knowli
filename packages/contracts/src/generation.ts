import { z } from "zod";
import { UuidSchema, VocabularyFormatSchema } from "./common";
import { MAX_DECK_ITEMS, MAX_GENERATION_INSTRUCTION_LENGTH } from "./limits";

/**
 * Źródło słówek: dokładnie jedno z `prompt` albo `sourceMaterialId`. Brak obu
 * zgłaszamy przy `prompt` (to pole podświetla formularz opisu), oba naraz przy
 * `sourceMaterialId` (zbędne odwołanie obok opisu). Reszta reguł dotyczy trybu
 * ze źródła: `expectedSourceRevision` towarzyszy wyłącznie `sourceMaterialId`
 * i jest przy nim wymagane, `instruction` ma sens tylko przy źródle, a para
 * języków jest stała, więc `locales` jest wtedy zabronione.
 */
function requireExactlyOneGenerationSource(
  command: {
    prompt?: string | undefined;
    sourceMaterialId?: string | undefined;
    expectedSourceRevision?: number | undefined;
    instruction?: string | undefined;
    locales?: unknown;
  },
  ctx: z.core.$RefinementCtx,
): void {
  const hasPrompt = command.prompt !== undefined;
  const hasSource = command.sourceMaterialId !== undefined;
  if (hasPrompt === hasSource) {
    ctx.addIssue({
      code: "custom",
      path: [hasPrompt ? "sourceMaterialId" : "prompt"],
      message: "provide exactly one of prompt or sourceMaterialId",
    });
    return;
  }
  if (hasSource !== (command.expectedSourceRevision !== undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["expectedSourceRevision"],
      message: "expectedSourceRevision is required with sourceMaterialId and only with it",
    });
  }
  if (!hasSource && command.instruction !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["instruction"],
      message: "instruction is allowed only with sourceMaterialId",
    });
  }
  if (hasSource && command.locales !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["locales"],
      message: "locales are fixed for a deck from a source",
    });
  }
}

/**
 * Polecenie wygenerowania zestawu. `idempotencyKey` pochodzi od klienta:
 * powtórzone żądanie o tym samym kluczu dołącza do istniejącego runu.
 * Limity z architecture.md §7 (4000 znaków promptu, maksymalnie 100 elementów).
 *
 * Dwa tryby (design 2026-10-30, §6): „z opisu” (`prompt` — model dobiera słowa)
 * albo „ze źródła” (`sourceMaterialId` — słowa wyłącznie z tekstu zapisanego
 * źródła rodzica). Dokładnie jedno z nich. Tryb ze źródła wymaga
 * `expectedSourceRevision` (rewizja TREŚCI źródła z podglądu rodzica; inna
 * w chwili tworzenia to `conflict`), przyjmuje opcjonalne `instruction`
 * zawężające wybór i ma stałą parę języków (`locales` jest tu zabronione).
 */
export const GenerationCommandSchema = z.object({
  prompt: z.string().min(1).max(4000).optional(),
  sourceMaterialId: UuidSchema.optional(),
  expectedSourceRevision: z.number().int().min(1).optional(),
  instruction: z.string().min(1).max(MAX_GENERATION_INSTRUCTION_LENGTH).optional(),
  idempotencyKey: z.string().min(8).max(200),
  title: z.string().min(1).max(200).optional(),
  vocabularyFormat: VocabularyFormatSchema.default("standard"),
  maxItems: z.number().int().min(1).max(MAX_DECK_ITEMS).optional(),
  locales: z
    .object({
      source: z.string().min(2).max(10),
      target: z.string().min(2).max(10),
    })
    .optional(),
}).superRefine(requireExactlyOneGenerationSource);
export type GenerationCommand = z.input<typeof GenerationCommandSchema>;

export const GenerationStateSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "superseded",
]);

/**
 * Widok runu generacji dla rodzica (polling). Bez treści LLM ani promptu.
 * `rejectedCount` — liczba elementów odrzuconych przy walidacji zestawu ze
 * źródła (elementy spoza tekstu lub niepoprawne); brak pola albo `null` to run
 * bez walidacji per element (tryb „z opisu”) lub jeszcze niezakończony.
 */
export const GenerationDtoSchema = z.object({
  id: UuidSchema,
  deckId: UuidSchema.nullable(),
  deckVersionId: UuidSchema.nullable(),
  state: GenerationStateSchema,
  attempts: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  rejectedCount: z.number().int().nonnegative().nullable().optional(),
});
export type GenerationDto = z.infer<typeof GenerationDtoSchema>;
