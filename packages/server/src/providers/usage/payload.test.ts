import { describe, expect, it } from "vitest";
import { usageFromPayload } from "./payload";

describe("usageFromPayload", () => {
  it("czyta tokeny i koszt z usage czatu", () => {
    expect(usageFromPayload({ usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00012 } })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      providerCostUsd: 0.00012,
    });
  });

  it("usage STT ({ seconds, cost }) daje sam koszt", () => {
    expect(usageFromPayload({ usage: { seconds: 1.04, cost: 0.0000636 } })).toEqual({ providerCostUsd: 0.0000636 });
  });

  it("brak usage → pusty wynik", () => {
    expect(usageFromPayload({ choices: [] })).toEqual({});
    expect(usageFromPayload({ usage: null })).toEqual({});
    expect(usageFromPayload({ usage: "x" })).toEqual({});
  });

  it.each([[-1], ["0.1"], [Number.NaN], [Number.POSITIVE_INFINITY]])("koszt %s jest pomijany, tokeny zostają", (cost) => {
    expect(usageFromPayload({ usage: { prompt_tokens: 3, completion_tokens: 4, cost } })).toEqual({ inputTokens: 3, outputTokens: 4 });
  });

  it("zero jest poprawnym kosztem", () => {
    expect(usageFromPayload({ usage: { cost: 0 } })).toEqual({ providerCostUsd: 0 });
  });

  it("niepoprawne tokeny są pomijane", () => {
    expect(usageFromPayload({ usage: { prompt_tokens: -1, completion_tokens: 1.5 } })).toEqual({});
  });

  it("null, tablica i prymitywy nie rzucają", () => {
    expect(usageFromPayload(null)).toEqual({});
    expect(usageFromPayload(undefined)).toEqual({});
    expect(usageFromPayload([])).toEqual({});
    expect(usageFromPayload("text")).toEqual({});
  });
});
