import { describe, expect, it } from "vitest";
import { chatRequestExtrasFromEnv, openRouterProviderRoutingFromEnv, withChatRequestExtras } from "./chat-request-options";

const LLM_OR = { UMIEM_LLM_BASE_URL: "https://openrouter.ai/api/v1" };
const GRADER_OR = { UMIEM_GRADER_BASE_URL: "https://openrouter.ai/api/v1" };

describe("chatRequestExtrasFromEnv", () => {
  it("is empty without configuration, so plain OpenAI-compatible requests stay unchanged", () => {
    expect(chatRequestExtrasFromEnv({}, "UMIEM_LLM")).toEqual({});
    expect(chatRequestExtrasFromEnv({ UMIEM_LLM_REASONING: "", UMIEM_LLM_PROVIDER_ORDER: " " }, "UMIEM_LLM")).toEqual({});
    expect(chatRequestExtrasFromEnv({ UMIEM_LLM_REASONING: "default" }, "UMIEM_LLM")).toEqual({});
  });

  it("maps reasoning to OpenRouter's reasoning object and requires a provider that honours it", () => {
    expect(chatRequestExtrasFromEnv({ ...LLM_OR, UMIEM_LLM_REASONING: "off" }, "UMIEM_LLM"))
      .toEqual({ reasoning: { enabled: false }, provider: { require_parameters: true } });
    expect(chatRequestExtrasFromEnv({ ...GRADER_OR, UMIEM_GRADER_REASONING: "Low" }, "UMIEM_GRADER"))
      .toEqual({ reasoning: { effort: "low" }, provider: { require_parameters: true } });
    expect(() => chatRequestExtrasFromEnv({ ...LLM_OR, UMIEM_LLM_REASONING: "max" }, "UMIEM_LLM")).toThrow(/UMIEM_LLM_REASONING/);
  });

  it("accepts OpenRouter endpoint slugs in the provider order, but not in quantizations", () => {
    expect(chatRequestExtrasFromEnv({ ...LLM_OR, UMIEM_LLM_PROVIDER_ORDER: "deepinfra/turbo, google-vertex/us-east5" }, "UMIEM_LLM"))
      .toEqual({ provider: { order: ["deepinfra/turbo", "google-vertex/us-east5"], require_parameters: true } });
    expect(() => chatRequestExtrasFromEnv({ ...LLM_OR, UMIEM_LLM_PROVIDER_ORDER: "deepinfra//turbo" }, "UMIEM_LLM")).toThrow(/PROVIDER_ORDER/);
    expect(() => chatRequestExtrasFromEnv({ ...LLM_OR, UMIEM_LLM_PROVIDER_QUANTIZATIONS: "fp8/turbo" }, "UMIEM_LLM")).toThrow(/QUANTIZATIONS/);
  });

  it("builds provider routing and always requires the sent parameters", () => {
    expect(chatRequestExtrasFromEnv({
      ...LLM_OR,
      UMIEM_LLM_PROVIDER_ORDER: "Nebius, DeepInfra",
      UMIEM_LLM_PROVIDER_QUANTIZATIONS: "FP8,bf16",
      UMIEM_LLM_PROVIDER_ALLOW_FALLBACKS: "false",
      UMIEM_LLM_PROVIDER_DATA_COLLECTION: "deny",
    }, "UMIEM_LLM")).toEqual({
      provider: { order: ["Nebius", "DeepInfra"], quantizations: ["fp8", "bf16"], allow_fallbacks: false, data_collection: "deny", require_parameters: true },
    });
  });

  it("rejects OpenRouter options for any other endpoint, including the OpenAI default", () => {
    expect(() => chatRequestExtrasFromEnv({ UMIEM_LLM_REASONING: "off" }, "UMIEM_LLM")).toThrow(/openrouter.ai/);
    expect(() => chatRequestExtrasFromEnv({ UMIEM_LLM_BASE_URL: "https://api.openai.com/v1", UMIEM_LLM_PROVIDER_ORDER: "Nebius" }, "UMIEM_LLM"))
      .toThrow(/UMIEM_LLM_BASE_URL/);
    expect(() => chatRequestExtrasFromEnv({ UMIEM_GRADER_BASE_URL: "https://openrouter.ai.evil.example/v1", UMIEM_GRADER_REASONING: "low" }, "UMIEM_GRADER"))
      .toThrow(/UMIEM_GRADER_BASE_URL/);
    expect(chatRequestExtrasFromEnv({ UMIEM_LLM_BASE_URL: "https://api.openai.com/v1" }, "UMIEM_LLM")).toEqual({});
  });

  it("accepts the regional OpenRouter endpoints", () => {
    for (const host of ["eu.openrouter.ai", "us.openrouter.ai", "OpenRouter.ai"]) {
      expect(chatRequestExtrasFromEnv({ UMIEM_GRADER_BASE_URL: `https://${host}/api/v1`, UMIEM_GRADER_PROVIDER_DATA_COLLECTION: "deny" }, "UMIEM_GRADER"))
        .toEqual({ provider: { data_collection: "deny", require_parameters: true } });
    }
    expect(() => chatRequestExtrasFromEnv({ UMIEM_GRADER_BASE_URL: "https://xx.openrouter.ai/api/v1", UMIEM_GRADER_REASONING: "low" }, "UMIEM_GRADER"))
      .toThrow(/UMIEM_GRADER_BASE_URL/);
  });

  it("reads only its own prefix and rejects malformed values", () => {
    expect(chatRequestExtrasFromEnv({ UMIEM_LLM_PROVIDER_QUANTIZATIONS: "fp8" }, "UMIEM_GRADER")).toEqual({});
    expect(() => chatRequestExtrasFromEnv({ ...GRADER_OR, UMIEM_GRADER_PROVIDER_ALLOW_FALLBACKS: "no" }, "UMIEM_GRADER")).toThrow(/ALLOW_FALLBACKS/);
    expect(() => chatRequestExtrasFromEnv({ ...GRADER_OR, UMIEM_GRADER_PROVIDER_DATA_COLLECTION: "maybe" }, "UMIEM_GRADER")).toThrow(/DATA_COLLECTION/);
    expect(() => chatRequestExtrasFromEnv({ ...LLM_OR, UMIEM_LLM_PROVIDER_ORDER: "Nebius;rm" }, "UMIEM_LLM")).toThrow(/PROVIDER_ORDER/);
  });
});

describe("withChatRequestExtras", () => {
  it("never lets configuration override the adapter's own fields", () => {
    const body = withChatRequestExtras({ model: "other", reasoning: { enabled: false } }, { model: "deepseek", messages: [] });
    expect(body).toEqual({ reasoning: { enabled: false }, model: "deepseek", messages: [] });
    expect(withChatRequestExtras(undefined, { model: "m" })).toEqual({ model: "m" });
  });
});

describe("openRouterProviderRoutingFromEnv", () => {
  it("czyta przyrostki _PROVIDER_* bez wymogu BASE_URL i bez require_parameters", () => {
    expect(openRouterProviderRoutingFromEnv({
      UMIEM_LESSON_AGENT_PROVIDER_ORDER: "deepinfra/turbo, Nebius",
      UMIEM_LESSON_AGENT_PROVIDER_QUANTIZATIONS: "FP8",
      UMIEM_LESSON_AGENT_PROVIDER_ALLOW_FALLBACKS: "false",
      UMIEM_LESSON_AGENT_PROVIDER_DATA_COLLECTION: "deny",
    }, "UMIEM_LESSON_AGENT")).toEqual({
      order: ["deepinfra/turbo", "Nebius"], quantizations: ["fp8"], allow_fallbacks: false, data_collection: "deny",
    });
  });

  it("bez ustawień (także pustych) zwraca undefined", () => {
    expect(openRouterProviderRoutingFromEnv({}, "UMIEM_LESSON_AGENT", "UMIEM_LLM")).toBeUndefined();
    expect(openRouterProviderRoutingFromEnv({ UMIEM_LESSON_AGENT_PROVIDER_ORDER: " " }, "UMIEM_LESSON_AGENT")).toBeUndefined();
  });

  it("każdy nieustawiony przyrostek dziedziczy wartość prefiksu bazowego osobno", () => {
    const env = { UMIEM_LLM_PROVIDER_DATA_COLLECTION: "deny", UMIEM_LLM_PROVIDER_ORDER: "Nebius", UMIEM_LESSON_AGENT_PROVIDER_ORDER: "Together" };
    expect(openRouterProviderRoutingFromEnv(env, "UMIEM_LESSON_AGENT", "UMIEM_LLM"))
      .toEqual({ order: ["Together"], data_collection: "deny" });
    expect(openRouterProviderRoutingFromEnv(env, "UMIEM_LESSON_AGENT")).toEqual({ order: ["Together"] });
  });

  it("zła wartość podaje nazwę zmiennej, z której pochodzi (także odziedziczonej)", () => {
    expect(() => openRouterProviderRoutingFromEnv({ UMIEM_LESSON_AGENT_PROVIDER_DATA_COLLECTION: "maybe" }, "UMIEM_LESSON_AGENT"))
      .toThrow(/UMIEM_LESSON_AGENT_PROVIDER_DATA_COLLECTION/);
    expect(() => openRouterProviderRoutingFromEnv({ UMIEM_LLM_PROVIDER_ALLOW_FALLBACKS: "no" }, "UMIEM_LESSON_AGENT", "UMIEM_LLM"))
      .toThrow(/UMIEM_LLM_PROVIDER_ALLOW_FALLBACKS/);
  });
});
