/** Stawki w USD jako stringi dziesiętne (bez floatów); brak pola = brak stawki, wiersz `unknown`. */
export interface UsagePrices {
  /** USD za obraz (`illustration`, `deck_cover`). */
  imageUsd?: string;
  /** USD za minutę audio (`tts`, gdy odpowiedź nie niesie kosztu). */
  ttsUsdPerMinute?: string;
  /** USD za godzinę audio (`speech_stt`). */
  azureSttUsdPerHour?: string;
  /** USD za godzinę audio (`pronunciation`). */
  azurePronunciationUsdPerHour?: string;
}

const DECIMAL = /^\d+(\.\d+)?$/;

function priceFromEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const raw = env[name]?.trim();
  if (!raw || raw.toLowerCase() === "none") return undefined;
  if (!DECIMAL.test(raw)) throw new Error(`${name} must be a non-negative decimal number or "none" (got "${raw}")`);
  return raw;
}

/** Stawki z env (po `withConfigDefaults`); `none` lub brak wyłącza stawkę, niepoprawna wartość to błąd startu. */
export function pricesFromEnv(env: Record<string, string | undefined>): UsagePrices {
  const prices: UsagePrices = {};
  const imageUsd = priceFromEnv(env, "UMIEM_PRICE_IMAGE_USD");
  const ttsUsdPerMinute = priceFromEnv(env, "UMIEM_PRICE_TTS_USD_PER_MINUTE");
  const azureSttUsdPerHour = priceFromEnv(env, "UMIEM_PRICE_AZURE_STT_USD_PER_HOUR");
  const azurePronunciationUsdPerHour = priceFromEnv(env, "UMIEM_PRICE_AZURE_PRONUNCIATION_USD_PER_HOUR");
  if (imageUsd !== undefined) prices.imageUsd = imageUsd;
  if (ttsUsdPerMinute !== undefined) prices.ttsUsdPerMinute = ttsUsdPerMinute;
  if (azureSttUsdPerHour !== undefined) prices.azureSttUsdPerHour = azureSttUsdPerHour;
  if (azurePronunciationUsdPerHour !== undefined) prices.azurePronunciationUsdPerHour = azurePronunciationUsdPerHour;
  return prices;
}
