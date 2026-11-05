import { describe, expect, it } from "vitest";
import { endpointKeyFromEnv, isSecureOpenRouterEndpoint, lessonAgentKeyFromEnv } from "./openrouter-key";

const OR = "https://openrouter.ai/api/v1";
const SHARED = { OPENROUTER_API_KEY: "sk-or-v1-shared" };

describe("endpointKeyFromEnv — wspólny OPENROUTER_API_KEY", () => {
  it("trafia tylko na https OpenRouter, także regionalny i pisany wielkimi literami", () => {
    for (const url of [OR, "https://eu.openrouter.ai/api/v1", "https://us.openrouter.ai/api/v1", "https://OpenRouter.AI/api/v1"]) {
      expect(endpointKeyFromEnv(SHARED, "UMIEM_TTS", url), url).toBe("sk-or-v1-shared");
    }
  });

  it("nigdy nie trafia na inny host, po http ani z userinfo w URL", () => {
    for (const url of [
      undefined,
      "https://api.openai.com/v1",
      "http://openrouter.ai/api/v1",
      "https://openrouter.ai.evil.example/v1",
      "https://openrouter.ai@evil.example/v1",
      "https://user:pass@openrouter.ai/api/v1",
      "nie-url",
    ]) {
      expect(endpointKeyFromEnv(SHARED, "UMIEM_LLM", url), String(url)).toBeUndefined();
      expect(isSecureOpenRouterEndpoint(url), String(url)).toBe(false);
    }
  });

  it("własny klucz ma pierwszeństwo; pusty wspólny nie jest używany", () => {
    expect(endpointKeyFromEnv({ ...SHARED, UMIEM_LLM_API_KEY: "sk-or-v1-own" }, "UMIEM_LLM", OR)).toBe("sk-or-v1-own");
    expect(endpointKeyFromEnv({ ...SHARED, OPENROUTER_API_KEY: " " }, "UMIEM_TTS", OR)).toBeUndefined();
  });

  it("klucz w kształcie OpenAI skierowany na OpenRouter to błąd bez wartości klucza", () => {
    const own = () => endpointKeyFromEnv({ UMIEM_TTS_API_KEY: "sk-proj-secret" }, "UMIEM_TTS", OR);
    expect(own).toThrow("UMIEM_TTS_API_KEY looks like an OpenAI key");
    expect(own).not.toThrow(/sk-proj-secret/);
    expect(() => endpointKeyFromEnv({ OPENROUTER_API_KEY: "sk-proj-secret" }, "UMIEM_LLM", OR))
      .toThrow("OPENROUTER_API_KEY looks like an OpenAI key");
    // ten sam klucz na api.openai.com jest poprawny
    expect(endpointKeyFromEnv({ UMIEM_TTS_API_KEY: "sk-proj-secret" }, "UMIEM_TTS", "https://api.openai.com/v1")).toBe("sk-proj-secret");
  });

  it("własny klucz OpenRouter tylko na https OpenRouter — nie trafia do obcego hosta", () => {
    for (const url of ["https://grader.example/v1", "https://api.openai.com/v1", "http://openrouter.ai/api/v1", "https://user:pass@openrouter.ai/api/v1"]) {
      const call = () => endpointKeyFromEnv({ UMIEM_GRADER_API_KEY: "sk-or-v1-own" }, "UMIEM_GRADER", url);
      expect(call, url).toThrow("UMIEM_GRADER_API_KEY looks like an OpenRouter key but UMIEM_GRADER_BASE_URL is not an https OpenRouter endpoint");
      expect(call, url).not.toThrow(/sk-or-v1-own/);
    }
    expect(endpointKeyFromEnv({ UMIEM_GRADER_API_KEY: "sk-or-v1-own" }, "UMIEM_GRADER", OR)).toBe("sk-or-v1-own");
    // inny klucz na własnym endpoincie bez zmian
    expect(endpointKeyFromEnv({ UMIEM_GRADER_API_KEY: "gsk-own" }, "UMIEM_GRADER", "https://grader.example/v1")).toBe("gsk-own");
  });
});

describe("lessonAgentKeyFromEnv", () => {
  it("kolejność: własny klucz agenta, wspólny OPENROUTER_API_KEY, UMIEM_LLM_API_KEY przy https OpenRouter", () => {
    const all = {
      UMIEM_LESSON_AGENT_API_KEY: "sk-or-v1-agent", OPENROUTER_API_KEY: "sk-or-v1-shared",
      UMIEM_LLM_API_KEY: "sk-or-v1-llm", UMIEM_LLM_BASE_URL: OR,
    };
    expect(lessonAgentKeyFromEnv(all)).toBe("sk-or-v1-agent");
    expect(lessonAgentKeyFromEnv({ ...all, UMIEM_LESSON_AGENT_API_KEY: " " })).toBe("sk-or-v1-shared");
    expect(lessonAgentKeyFromEnv({ ...all, UMIEM_LESSON_AGENT_API_KEY: undefined, OPENROUTER_API_KEY: "" })).toBe("sk-or-v1-llm");
  });

  it("klucz UMIEM_LLM_API_KEY nie opuszcza https OpenRouter; bez żadnego klucza undefined", () => {
    expect(lessonAgentKeyFromEnv({ UMIEM_LLM_API_KEY: "sk-or-v1-llm" })).toBeUndefined();
    expect(lessonAgentKeyFromEnv({ UMIEM_LLM_API_KEY: "key", UMIEM_LLM_BASE_URL: "https://api.openai.com/v1" })).toBeUndefined();
    expect(lessonAgentKeyFromEnv({})).toBeUndefined();
  });

  it("klucz w kształcie OpenAI to błąd z nazwą zmiennej, bez wartości klucza", () => {
    const call = () => lessonAgentKeyFromEnv({ UMIEM_LESSON_AGENT_API_KEY: "sk-proj-secret" });
    expect(call).toThrow("UMIEM_LESSON_AGENT_API_KEY looks like an OpenAI key");
    expect(call).not.toThrow(/sk-proj-secret/);
    expect(() => lessonAgentKeyFromEnv({ OPENROUTER_API_KEY: "sk-proj-secret" })).toThrow("OPENROUTER_API_KEY looks like an OpenAI key");
  });
});
