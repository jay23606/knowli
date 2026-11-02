import { describe, expect, it } from "vitest";
import { messages } from "./messages";
import { ParentCostsDtoSchema, ParentCostsQuerySchema } from "./parent-costs";
import { USAGE_FEATURES } from "./usage-features";

describe("ParentCostsQuerySchema", () => {
  it("akceptuje miesiąc YYYY-MM", () => {
    expect(ParentCostsQuerySchema.parse({ month: "2026-11" })).toEqual({ month: "2026-11" });
  });

  it("akceptuje brak miesiąca (serwer bierze bieżący)", () => {
    expect(ParentCostsQuerySchema.parse({})).toEqual({});
  });

  it("odrzuca nadmiarowe klucze", () => {
    expect(ParentCostsQuerySchema.safeParse({ month: "2026-11", token: "x" }).success).toBe(false);
  });

  it("odrzuca nieistniejący miesiąc", () => {
    expect(ParentCostsQuerySchema.safeParse({ month: "2026-13" }).success).toBe(false);
    expect(ParentCostsQuerySchema.safeParse({ month: "2026-00" }).success).toBe(false);
  });
});

describe("ParentCostsDtoSchema", () => {
  const empty = {
    month: "2026-11",
    currentMonth: "2026-11",
    timezone: "Europe/Warsaw",
    totals: { costUsd: "0.000000", estimatedUsd: "0.000000", calls: 0, unknownCalls: 0, failedCalls: 0, unscopedCalls: 0 },
    features: [],
    decks: [],
    children: [],
  };

  it("akceptuje pusty raport", () => {
    expect(ParentCostsDtoSchema.safeParse(empty).success).toBe(true);
  });

  it("wymaga bieżącego miesiąca serwera", () => {
    const { currentMonth: _omitted, ...withoutCurrent } = empty;
    expect(ParentCostsDtoSchema.safeParse(withoutCurrent).success).toBe(false);
  });

  it("odrzuca kwotę bez sześciu miejsc po przecinku", () => {
    const broken = { ...empty, totals: { ...empty.totals, costUsd: "1.5" } };
    expect(ParentCostsDtoSchema.safeParse(broken).success).toBe(false);
  });
});

describe("messages.costs.featureNames", () => {
  it("nazywa każdą funkcję bez nazw dostawców (hosty mogą się zmienić)", () => {
    for (const feature of USAGE_FEATURES) {
      const name = messages.costs.featureNames[feature];
      expect(name, feature).toBeTruthy();
      expect(name, feature).not.toMatch(/openrouter|azure|openai/i);
    }
    expect(messages.costs.featureNames.lesson_stt).toBe("Dyktowanie i odpowiedzi ustne (lekcje)");
    expect(messages.costs.featureNames.speech_stt).toBe("Rozpoznawanie mowy (słówka)");
  });
});
