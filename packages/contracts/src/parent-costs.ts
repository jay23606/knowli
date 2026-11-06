import { z } from "zod";
import { UuidSchema } from "./common";
import { UsageFeatureSchema } from "./usage-features";

const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/**
 * Zapytanie raportu kosztów: miesiąc kalendarzowy `YYYY-MM` w strefie rodziny.
 * Bez `month` serwer bierze bieżący miesiąc rodziny (zegar serwera, nie przeglądarki).
 */
export const ParentCostsQuerySchema = z.object({ month: MonthSchema.optional() }).strict();

/** Kwota w USD jako ciąg dziesiętny z dokładnością do mikrodolara (np. `"0.003333"`). */
export const MoneySchema = z.string().regex(/^\d+\.\d{6}$/);
export type Money = z.infer<typeof MoneySchema>;

const Count = z.number().int().nonnegative();

/**
 * Raport kosztów usług AI (spec `2026-11-02-llm-cost-tracking-design.md` §6.3):
 * nagłówek, funkcje i dzieci dla wybranego miesiąca oraz materiały z kwotami
 * od początku (`totalUsd` i rozbicie) i z wybranego miesiąca (`monthUsd`).
 */
export const ParentCostsDtoSchema = z.object({
  month: MonthSchema,
  /** Bieżący miesiąc w strefie rodziny wg zegara serwera — najpóźniejszy dozwolony. */
  currentMonth: MonthSchema,
  timezone: z.string(),
  totals: z.object({
    costUsd: MoneySchema,
    /** Część sumy pochodząca z wiersza wycenionego z cennika (`price_table`). */
    estimatedUsd: MoneySchema,
    calls: Count,
    unknownCalls: Count,
    failedCalls: Count,
    /** Wywołania funkcji nauki bez przypisania do sesji (`scope_kind = none`). */
    unscopedCalls: Count,
  }).strict(),
  features: z.array(z.object({
    feature: UsageFeatureSchema,
    calls: Count,
    inputTokens: Count,
    outputTokens: Count,
    characters: Count,
    audioMs: Count,
    images: Count,
    costUsd: MoneySchema,
    estimated: z.boolean(),
    unknownCalls: Count,
    sharePercent: z.number().int().min(0).max(100),
  }).strict()),
  decks: z.array(z.object({
    /** `deck` — talia; `shared_ui` — media bez talii (głos interfejsu); `other` — reszta bez talii. */
    bucket: z.enum(["deck", "shared_ui", "other"]),
    deckId: UuidSchema.nullable(),
    title: z.string().nullable(),
    kind: z.enum(["vocabulary", "lesson"]).nullable(),
    /** Od początku: generowanie (zestawy i lekcje), lektor, ilustracje i okładki. */
    generationUsd: MoneySchema,
    ttsUsd: MoneySchema,
    imagesUsd: MoneySchema,
    totalUsd: MoneySchema,
    /** Tylko wybrany miesiąc. */
    monthUsd: MoneySchema,
    /** Flagi dotyczą wszystkich wierszy od początku (kwot rozbicia i `totalUsd`). */
    estimated: z.boolean(),
    unknownCalls: Count,
  }).strict()),
  children: z.array(z.object({
    /** `null` i `deleted: true` — zgrubione koszty usuniętych profili. */
    childId: UuidSchema.nullable(),
    name: z.string().nullable(),
    deleted: z.boolean(),
    sessions: Count,
    costUsd: MoneySchema,
    gradingUsd: MoneySchema,
    speechUsd: MoneySchema,
    activityUsd: MoneySchema,
    /** Średnio na sesję; `null` przy zerze sesji. */
    perSessionUsd: MoneySchema.nullable(),
    estimated: z.boolean(),
    unknownCalls: Count,
  }).strict()),
}).strict();
export type ParentCostsDto = z.infer<typeof ParentCostsDtoSchema>;
