import { z } from "zod";
import { InstantSchema, UuidSchema } from "./common";
import { DeckStateSchema } from "./decks";
import { MAX_SCHOOL_MATERIAL_LENGTH } from "./lessons";

/**
 * Kontrakty źródeł (materiał źródłowy rodzica; design 2026-10-30, §3, §7).
 * Źródło to wklejony tekst rozdziału, z którego rodzic tworzy lekcje i zestawy.
 * Dotyczy wyłącznie Parent API — źródeł nie ma w Kid API ani w MCP.
 *
 * Limity odzwierciedlają CHECK-i w `learning_app.source_materials`; teksty
 * są przycinane (trim) przed sprawdzeniem długości.
 */

export const MAX_SOURCE_TITLE_LENGTH = 120;

const SourceTitleSchema = z.string().trim().min(1).max(MAX_SOURCE_TITLE_LENGTH);
const SourceBodySchema = z.string().trim().min(1).max(MAX_SCHOOL_MATERIAL_LENGTH);

/** Tworzenie źródła; `clientRequestId` czyni ponowienie idempotentnym. */
export const SourceMaterialInputSchema = z
  .object({
    clientRequestId: UuidSchema,
    title: SourceTitleSchema,
    body: SourceBodySchema,
  })
  .strict();
export type SourceMaterialInput = z.infer<typeof SourceMaterialInputSchema>;

/**
 * Edycja źródła z kontrolą rewizji (`expectedRevision` = `revision` z odczytu);
 * co najmniej jedno z pól `title` / `body`. Edycja, w której każde podane pole
 * jest równe zapisanemu (po trim), niczego nie zmienia i niczego nie podbija.
 */
export const SourceMaterialPatchSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    title: SourceTitleSchema.optional(),
    body: SourceBodySchema.optional(),
  })
  .strict()
  .refine((patch) => patch.title !== undefined || patch.body !== undefined, {
    message: "Provide title or body",
  });
export type SourceMaterialPatch = z.infer<typeof SourceMaterialPatchSchema>;

/**
 * Pozycja listy źródeł; `deckCount` pomija zestawy zarchiwizowane. `revision`
 * to rewizja współbieżności — rośnie przy każdej zmianie (także samego tytułu)
 * i jest `expectedRevision` następnej edycji.
 */
export const SourceMaterialSummaryDtoSchema = z.object({
  id: UuidSchema,
  title: z.string(),
  revision: z.number().int().min(1),
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
  deckCount: z.number().int().min(0),
});
export type SourceMaterialSummaryDto = z.infer<typeof SourceMaterialSummaryDtoSchema>;

/**
 * Zestaw utworzony ze źródła. `copiedRevision` to rewizja TREŚCI źródła
 * skopiowana przy tworzeniu zestawu (nie `revision`), a `stale` — tekst źródła
 * zmieniono od tamtej chwili. Zmiana samego tytułu źródła nie ustawia `stale`.
 */
export const SourceMaterialDeckDtoSchema = z.object({
  deckId: UuidSchema,
  title: z.string(),
  kind: z.enum(["lesson", "vocabulary"]),
  state: DeckStateSchema,
  copiedRevision: z.number().int().min(1).nullable(),
  stale: z.boolean(),
});

/**
 * Pełne źródło: tekst i zestawy utworzone z niego (także zarchiwizowane).
 * `bodyRevision` to rewizja TREŚCI (rośnie tylko przy zmianie tekstu) —
 * formularz lekcji ze źródła odsyła ją jako `expectedSourceRevision`, żeby
 * serwer skopiował dokładnie ten tekst, który rodzic widział w podglądzie.
 */
export const SourceMaterialDtoSchema = SourceMaterialSummaryDtoSchema.extend({
  bodyRevision: z.number().int().min(1),
  body: z.string(),
  decks: z.array(SourceMaterialDeckDtoSchema),
});
export type SourceMaterialDto = z.infer<typeof SourceMaterialDtoSchema>;
