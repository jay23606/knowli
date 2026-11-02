import type { UsageEvent } from "../../ports/usage";
import type { UsagePrices } from "./prices-env";

export type CostSource = "provider" | "price_table" | "not_billed" | "unknown";

export interface PricedUsage {
  costUsd: string | null;
  costSource: CostSource;
  priceRef: string | null;
}

/** Zakres kolumny `numeric(12,6)` w mikrodolarach (999 999,999999 USD). */
const MAX_MICRO = 999_999_999_999n;
const MS_PER_MINUTE = 60_000n;
const MS_PER_HOUR = 3_600_000n;

const UNKNOWN: PricedUsage = { costUsd: null, costSource: "unknown", priceRef: null };

/** Mikrodolary jako string dziesiętny `X.XXXXXX`; `null` poza zakresem kolumny. */
function formatMicro(micro: bigint): string | null {
  if (micro < 0n || micro > MAX_MICRO) return null;
  const digits = micro.toString().padStart(7, "0");
  return `${digits.slice(0, -6)}.${digits.slice(-6)}`;
}

/** Stawka dziesiętna (`"0.04"`) → mikrodolary bez floatów; cyfry za szóstym miejscem zaokrąglane połówkowo w górę. */
function rateToMicro(rate: string): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(rate);
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(7, "0");
  const micro = BigInt(match[1]!) * 1_000_000n + BigInt(fraction.slice(0, 6));
  return fraction.charCodeAt(6) >= 53 /* '5' */ ? micro + 1n : micro;
}

/** `numerator / denominator` z zaokrągleniem połówkowym w górę (liczby nieujemne). */
function divideRounded(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator);
}

function unitAmount(value: number | undefined): bigint | null {
  if (value === undefined || !Number.isFinite(value) || value < 0) return null;
  return BigInt(Math.round(value));
}

interface TableCost {
  micro: bigint;
  priceRef: string;
}

/** Stawka × jednostki; `null`, gdy brak stawki albo jednostki. */
function tableCost(
  name: string,
  rate: string | undefined,
  unit: "image" | "minute" | "hour",
  event: UsageEvent,
): TableCost | null {
  const rateMicro = rate !== undefined ? rateToMicro(rate) : null;
  const amount = unitAmount(unit === "image" ? event.images : event.audioMs);
  if (rateMicro === null || amount === null) return null;
  const divisor = unit === "minute" ? MS_PER_MINUTE : unit === "hour" ? MS_PER_HOUR : 1n;
  return { micro: divideRounded(amount * rateMicro, divisor), priceRef: `${name}=${rate}` };
}

function costFromTable(event: UsageEvent, prices: UsagePrices): TableCost | null {
  switch (event.feature) {
    case "illustration":
    case "deck_cover":
      return tableCost("UMIEM_PRICE_IMAGE_USD", prices.imageUsd, "image", event);
    case "tts":
      return tableCost("UMIEM_PRICE_TTS_USD_PER_MINUTE", prices.ttsUsdPerMinute, "minute", event);
    case "speech_stt":
      return tableCost("UMIEM_PRICE_AZURE_STT_USD_PER_HOUR", prices.azureSttUsdPerHour, "hour", event);
    case "pronunciation":
      return tableCost("UMIEM_PRICE_AZURE_PRONUNCIATION_USD_PER_HOUR", prices.azurePronunciationUsdPerHour, "hour", event);
    default:
      return null;
  }
}

/**
 * Wycena jednego wywołania (spec §4.4), czysta funkcja na mikrodolarach `bigint`:
 * koszt dostawcy wygrywa, cennik tylko dla udanych wywołań, błąd z odpowiedzią
 * 4xx/5xx jest `not_billed`, reszta `unknown`. Nie rzuca.
 */
export function priceUsage(event: UsageEvent, prices: UsagePrices): PricedUsage {
  if (event.providerCostUsd !== undefined) {
    const cost = event.providerCostUsd;
    if (!Number.isFinite(cost) || cost < 0) return UNKNOWN;
    const costUsd = formatMicro(BigInt(Math.round(cost * 1e6)));
    return costUsd === null ? UNKNOWN : { costUsd, costSource: "provider", priceRef: null };
  }

  if (event.outcome === "failed") {
    if (event.httpStatus !== undefined && event.httpStatus >= 400) {
      return { costUsd: formatMicro(0n), costSource: "not_billed", priceRef: null };
    }
    return UNKNOWN;
  }

  const fromTable = costFromTable(event, prices);
  if (fromTable === null) return UNKNOWN;
  const costUsd = formatMicro(fromTable.micro);
  return costUsd === null ? UNKNOWN : { costUsd, costSource: "price_table", priceRef: fromTable.priceRef };
}
