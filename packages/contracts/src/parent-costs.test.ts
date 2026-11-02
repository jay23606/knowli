import { describe, expect, it } from "vitest";
import { ParentCostsDtoSchema, ParentCostsQuerySchema } from "./parent-costs";

describe("ParentCostsQuerySchema", () => {
  it("akceptuje miesiąc YYYY-MM", () => {
    expect(ParentCostsQuerySchema.parse({ month: "2026-11" })).toEqual({ month: "2026-11" });
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
    timezone: "Europe/Warsaw",
    totals: { costUsd: "0.000000", estimatedUsd: "0.000000", calls: 0, unknownCalls: 0, failedCalls: 0, unscopedCalls: 0 },
    features: [],
    decks: [],
    children: [],
  };

  it("akceptuje pusty raport", () => {
    expect(ParentCostsDtoSchema.safeParse(empty).success).toBe(true);
  });

  it("odrzuca kwotę bez sześciu miejsc po przecinku", () => {
    const broken = { ...empty, totals: { ...empty.totals, costUsd: "1.5" } };
    expect(ParentCostsDtoSchema.safeParse(broken).success).toBe(false);
  });
});
