import { describe, expect, it } from "vitest";
import { pricesFromEnv } from "./prices-env";

describe("pricesFromEnv", () => {
  it("brak i pusta wartość → brak stawki", () => {
    expect(pricesFromEnv({})).toEqual({});
    expect(pricesFromEnv({ UMIEM_PRICE_IMAGE_USD: "" })).toEqual({});
  });

  it("none wyłącza stawkę", () => {
    expect(pricesFromEnv({ UMIEM_PRICE_IMAGE_USD: "none" })).toEqual({});
  });

  it("czyta wszystkie cztery stawki jako stringi", () => {
    expect(
      pricesFromEnv({
        UMIEM_PRICE_IMAGE_USD: "0.04",
        UMIEM_PRICE_TTS_USD_PER_MINUTE: "0.0135",
        UMIEM_PRICE_AZURE_STT_USD_PER_HOUR: "1",
        UMIEM_PRICE_AZURE_PRONUNCIATION_USD_PER_HOUR: "1.2",
      }),
    ).toEqual({ imageUsd: "0.04", ttsUsdPerMinute: "0.0135", azureSttUsdPerHour: "1", azurePronunciationUsdPerHour: "1.2" });
  });

  it.each([["-1"], ["abc"], ["1e3"], ["0,04"]])("niepoprawna wartość %s → błąd z nazwą zmiennej", (value) => {
    expect(() => pricesFromEnv({ UMIEM_PRICE_AZURE_STT_USD_PER_HOUR: value })).toThrow(/UMIEM_PRICE_AZURE_STT_USD_PER_HOUR/);
  });
});
