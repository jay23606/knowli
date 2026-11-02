import { describe, expect, it } from "vitest";
import { currentUsageScope, providerFromBaseUrl, scopeKindOf, withUsageScope } from "./usage";

describe("withUsageScope", () => {
  it("poza zakresem nie ma kontekstu", () => {
    expect(currentUsageScope()).toBeUndefined();
  });

  it("wewnętrzny zakres wygrywa i nie przecieka na zewnątrz", () => {
    withUsageScope({ deckId: "outer" }, () => {
      expect(currentUsageScope()).toEqual({ deckId: "outer" });
      withUsageScope({ sessionId: "s", childId: "c" }, () => {
        expect(currentUsageScope()).toEqual({ sessionId: "s", childId: "c" });
      });
      expect(currentUsageScope()).toEqual({ deckId: "outer" });
    });
    expect(currentUsageScope()).toBeUndefined();
  });

  it("zakres przeżywa await i Promise.resolve().then", async () => {
    await withUsageScope({ generationRunId: "r", deckId: "d" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentUsageScope()).toEqual({ generationRunId: "r", deckId: "d" });
      await Promise.resolve().then(() => {
        expect(currentUsageScope()).toEqual({ generationRunId: "r", deckId: "d" });
      });
    });
  });

  it("zwraca wynik funkcji", () => {
    expect(withUsageScope({ deckId: "d" }, () => 42)).toBe(42);
  });
});

describe("scopeKindOf", () => {
  it("run > session > deck > none", () => {
    expect(scopeKindOf({ generationRunId: "r", deckId: "d" })).toBe("run");
    expect(scopeKindOf({ sessionId: "s", childId: "c" })).toBe("session");
    expect(scopeKindOf({ deckId: "d" })).toBe("deck");
    expect(scopeKindOf(undefined)).toBe("none");
    expect(scopeKindOf({})).toBe("none");
  });
});

describe("providerFromBaseUrl", () => {
  it("rozpoznaje providerów po hoście", () => {
    expect(providerFromBaseUrl("https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(providerFromBaseUrl("https://api.openai.com/v1")).toBe("openai");
    expect(providerFromBaseUrl("https://westeurope.stt.speech.microsoft.com/speech")).toBe("azure");
    expect(providerFromBaseUrl("https://my-res.cognitiveservices.azure.com/")).toBe("azure");
    expect(providerFromBaseUrl("http://localhost:11434/v1")).toBe("localhost");
    expect(providerFromBaseUrl("https://llm.example.org/v1")).toBe("llm.example.org");
  });
});
