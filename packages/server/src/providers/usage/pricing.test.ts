import { describe, expect, it } from "vitest";
import type { UsageEvent } from "../../ports/usage";
import { priceUsage } from "./pricing";

const base: UsageEvent = { feature: "answer_grading", provider: "openrouter", outcome: "ok" };
const UNKNOWN = { costUsd: null, costSource: "unknown", priceRef: null };

describe("priceUsage: koszt dostawcy", () => {
  it("koszt z odpowiedzi → provider, sześć miejsc", () => {
    expect(priceUsage({ ...base, providerCostUsd: 0.00012 }, {})).toEqual({ costUsd: "0.000120", costSource: "provider", priceRef: null });
  });

  it("zapis wykładniczy 1.2e-7 zaokrągla się do 0.000000", () => {
    expect(priceUsage({ ...base, providerCostUsd: 1.2e-7 }, {})).toEqual({ costUsd: "0.000000", costSource: "provider", priceRef: null });
  });

  it("koszt dostawcy wygrywa także przy failed", () => {
    expect(priceUsage({ ...base, outcome: "failed", httpStatus: 500, providerCostUsd: 0.5 }, {})).toEqual({
      costUsd: "0.500000",
      costSource: "provider",
      priceRef: null,
    });
  });

  it("ponad zakres numeric(12,6) → unknown", () => {
    expect(priceUsage({ ...base, providerCostUsd: 1e7 }, {})).toEqual(UNKNOWN);
  });

  it("największa dozwolona kwota przechodzi", () => {
    expect(priceUsage({ ...base, providerCostUsd: 999999.999999 }, {}).costUsd).toBe("999999.999999");
  });

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [-1]])("niepoprawny koszt %s → unknown bez wyjątku", (cost) => {
    expect(priceUsage({ ...base, providerCostUsd: cost }, {})).toEqual(UNKNOWN);
  });
});

describe("priceUsage: cennik", () => {
  it("illustration: obrazy × stawka", () => {
    expect(priceUsage({ ...base, feature: "illustration", provider: "openai", images: 2 }, { imageUsd: "0.04" })).toEqual({
      costUsd: "0.080000",
      costSource: "price_table",
      priceRef: "UMIEM_PRICE_IMAGE_USD=0.04",
    });
  });

  it("deck_cover liczy jak obrazy", () => {
    expect(priceUsage({ ...base, feature: "deck_cover", provider: "openai", images: 1 }, { imageUsd: "0.006" })).toEqual({
      costUsd: "0.006000",
      costSource: "price_table",
      priceRef: "UMIEM_PRICE_IMAGE_USD=0.006",
    });
  });

  it("tts: minuty audio × stawka", () => {
    expect(priceUsage({ ...base, feature: "tts", audioMs: 90000 }, { ttsUsdPerMinute: "0.02" })).toEqual({
      costUsd: "0.030000",
      costSource: "price_table",
      priceRef: "UMIEM_PRICE_TTS_USD_PER_MINUTE=0.02",
    });
  });

  it("speech_stt: godziny audio × stawka Azure STT", () => {
    expect(priceUsage({ ...base, feature: "speech_stt", provider: "azure", audioMs: 3_600_000 }, { azureSttUsdPerHour: "1" })).toEqual({
      costUsd: "1.000000",
      costSource: "price_table",
      priceRef: "UMIEM_PRICE_AZURE_STT_USD_PER_HOUR=1",
    });
  });

  it("pronunciation: własna stawka", () => {
    expect(
      priceUsage(
        { ...base, feature: "pronunciation", provider: "azure", audioMs: 1_800_000 },
        { azureSttUsdPerHour: "1", azurePronunciationUsdPerHour: "1.32" },
      ),
    ).toEqual({ costUsd: "0.660000", costSource: "price_table", priceRef: "UMIEM_PRICE_AZURE_PRONUNCIATION_USD_PER_HOUR=1.32" });
  });

  it("zaokrągla połówkowo (1 s przy 1 USD/h = 277,78 mikro)", () => {
    expect(priceUsage({ ...base, feature: "speech_stt", audioMs: 1000 }, { azureSttUsdPerHour: "1" }).costUsd).toBe("0.000278");
  });

  it("ok bez jednostki → unknown", () => {
    expect(priceUsage({ ...base, feature: "illustration" }, { imageUsd: "0.04" })).toEqual(UNKNOWN);
  });

  it("ok bez stawki → unknown", () => {
    expect(priceUsage({ ...base, feature: "tts", audioMs: 1000 }, {})).toEqual(UNKNOWN);
  });

  it("funkcja bez cennika (np. grader bez kosztu) → unknown", () => {
    expect(priceUsage(base, { imageUsd: "0.04" })).toEqual(UNKNOWN);
  });
});

describe("priceUsage: failed", () => {
  it("odpowiedź 5xx bez kosztu → not_billed, 0", () => {
    expect(priceUsage({ ...base, outcome: "failed", httpStatus: 500 }, {})).toEqual({
      costUsd: "0.000000",
      costSource: "not_billed",
      priceRef: null,
    });
  });

  it("odpowiedź 4xx bez kosztu → not_billed", () => {
    expect(priceUsage({ ...base, outcome: "failed", httpStatus: 400 }, {}).costSource).toBe("not_billed");
  });

  it("status 200 z nieczytelnym ciałem → unknown", () => {
    expect(priceUsage({ ...base, outcome: "failed", httpStatus: 200 }, {})).toEqual(UNKNOWN);
  });

  it("bez statusu (timeout, sieć) → unknown", () => {
    expect(priceUsage({ ...base, outcome: "failed" }, {})).toEqual(UNKNOWN);
  });

  it("cennik nie wycenia failed", () => {
    expect(priceUsage({ ...base, feature: "illustration", outcome: "failed", images: 1 }, { imageUsd: "0.04" })).toEqual(UNKNOWN);
  });
});
