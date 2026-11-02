import type { Money, UsageFeature } from "@learning/contracts";

/**
 * Formatowanie raportu kosztów (spec 2026-11-02-llm-cost-tracking §6.2): kwoty
 * w USD liczone na `bigint` mikrodolarów (bez `Number` na kwocie), liczby
 * w polskim formacie z niełamliwą spacją jako separatorem tysięcy.
 */

const NBSP = " ";
const MICRO = 1_000_000n;

/** Liczba całkowita z separatorem tysięcy (U+00A0); `Intl` pl-PL nie grupuje liczb czterocyfrowych. */
function groupInt(value: bigint | number): string {
  const digits = String(value);
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/** Mikrodolary z ciągu `"4.123456"` (kontrakt `MoneySchema`: sześć miejsc po kropce). */
function toMicro(amount: Money | string): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, "0").slice(0, 6));
}

/** `true`, gdy kwota jest większa od zera. */
export function isPositive(amount: Money | string): boolean {
  return toMicro(amount) > 0n;
}

/**
 * „4,12 USD”: zaokrąglenie połówkowe do centów; dodatnia kwota poniżej pół centa
 * (która zaokrągliłaby się do zera) to „< 0,01 USD”, zero to „0,00 USD”.
 */
export function formatUsd(amount: Money | string): string {
  const micro = toMicro(amount);
  if (micro > 0n && micro < 5000n) return "< 0,01 USD";
  const cents = (micro + 5000n) / 10_000n;
  const fraction = String(cents % 100n).padStart(2, "0");
  return `${groupInt(cents / 100n)},${fraction} USD`;
}

/** Polska odmiana: 1 / 2–4 (z wyjątkiem 12–14) / reszta. */
function plural(count: number, one: string, few: string, many: string): string {
  if (count === 1) return one;
  const lastTwo = count % 100;
  const last = count % 10;
  return last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14) ? few : many;
}

function tokens(total: number): string {
  if (total >= 1_000_000) {
    const tenths = Math.round(total / 100_000);
    const whole = Math.floor(tenths / 10);
    const fraction = tenths % 10;
    return `${whole}${fraction === 0 ? "" : `,${fraction}`} mln tokenów`;
  }
  return `${groupInt(total)} ${plural(total, "token", "tokeny", "tokenów")}`;
}

export interface CostUnitsRow {
  inputTokens: number;
  outputTokens: number;
  characters: number;
  audioMs: number;
  images: number;
}

const CHAT_FEATURES: readonly UsageFeature[] = ["deck_generation", "lesson_generation", "answer_grading", "session_activity_review"];
const IMAGE_FEATURES: readonly UsageFeature[] = ["illustration", "deck_cover"];

/**
 * Jednostki wiersza funkcji: tokeny (czat), minuty audio (mowa, lektor),
 * obrazy (ilustracje, okładki). Lektor bez długości audio pokazuje znaki,
 * a przy braku obu — tokeny modelu mowy.
 */
export function formatUnits(feature: UsageFeature, row: CostUnitsRow): string {
  if (CHAT_FEATURES.includes(feature)) return tokens(row.inputTokens + row.outputTokens);
  if (IMAGE_FEATURES.includes(feature)) return `${groupInt(row.images)} ${plural(row.images, "obraz", "obrazy", "obrazów")}`;
  if (row.audioMs === 0 && row.characters > 0) {
    return `${groupInt(row.characters)} ${plural(row.characters, "znak", "znaki", "znaków")}`;
  }
  if (row.audioMs === 0 && row.inputTokens + row.outputTokens > 0) return tokens(row.inputTokens + row.outputTokens);
  if (row.audioMs > 0 && row.audioMs < 60_000) return "< 1 min audio";
  return `${groupInt(Math.round(row.audioMs / 60_000))} min audio`;
}

/** Poprzedni lub następny miesiąc kalendarzowy w formacie `YYYY-MM`. */
export function shiftMonth(month: string, delta: -1 | 1): string {
  const [year = 0, mon = 1] = month.split("-").map(Number);
  const index = year * 12 + (mon - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** Bieżący miesiąc według lokalnego czasu przeglądarki (`YYYY-MM`). */
export function currentMonth(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

const MONTH_FORMAT = new Intl.DateTimeFormat("pl-PL", { month: "long", year: "numeric", timeZone: "UTC" });

/** „Listopad 2026”. */
export function monthLabel(month: string): string {
  const [year = 0, mon = 1] = month.split("-").map(Number);
  const label = MONTH_FORMAT.format(new Date(Date.UTC(year, mon - 1, 1)));
  return label.charAt(0).toUpperCase() + label.slice(1);
}
