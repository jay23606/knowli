import { isLessonAgentAvailable } from "@learning/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWorkerServices } from "./composition";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("buildWorkerServices", () => {
  it("worker composition shares one recorder", async () => {
    // Pula pg łączy się dopiero przy zapytaniu, więc adres nie musi istnieć.
    vi.stubEnv("DATABASE_URL", "postgres://test:test@127.0.0.1:1/worker-composition");
    vi.stubEnv("UMIEM_FAKE_PROVIDERS", "");
    vi.stubEnv("OPENAI_API_KEY", "sk-test-images");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test-shared");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [] }) } }], usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0.0001 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    const { services, pool, usage } = buildWorkerServices();
    try {
      expect(services.usage).toBe(usage);
      // Bez zapisu do nieistniejącej bazy: liczy się, że adapter woła ten sam recorder.
      const record = vi.spyOn(usage, "record").mockImplementation(() => {});

      await services.generation!.llm.generateDeck({ prompt: "Dni tygodnia", maxItems: 3, sourceLocale: "pl-PL", targetLocale: "en-GB" });

      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0]![0]).toMatchObject({ feature: "deck_generation", provider: "openrouter", outcome: "ok" });
    } finally {
      await pool.end();
    }
  });

  it("pozostawione błędne UMIEM_REVIEWER_* nie zatrzymują workera", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://test:test@127.0.0.1:1/worker-composition");
    vi.stubEnv("UMIEM_FAKE_PROVIDERS", "1");
    vi.stubEnv("UMIEM_REVIEWER_ENABLED", "true");
    vi.stubEnv("UMIEM_REVIEWER_CONCURRENCY", "abc");
    vi.stubEnv("UMIEM_REVIEWER_REASONING", "turbo");

    let built: ReturnType<typeof buildWorkerServices> | undefined;
    expect(() => { built = buildWorkerServices(); }).not.toThrow();
    await built?.pool.end();
  });

  describe("agent puli lekcji", () => {
    const UNAVAILABLE_LINE = "[config] lesson-agent=unavailable reason=no_openrouter_key";

    /**
     * LLM i TTS na OpenAI-direct (docs/provider-config.md), bez żadnego klucza OpenRouter: jedyna
     * konfiguracja, w której worker bez klucza OpenRouter w ogóle się składa (rozstrzygnięcie 11).
     */
    function stubOpenAiDirectEnv(): void {
      vi.stubEnv("DATABASE_URL", "postgres://test:test@127.0.0.1:1/worker-composition");
      vi.stubEnv("UMIEM_FAKE_PROVIDERS", "");
      vi.stubEnv("OPENAI_API_KEY", "sk-test-images");
      vi.stubEnv("OPENROUTER_API_KEY", "");
      vi.stubEnv("UMIEM_LESSON_AGENT_API_KEY", "");
      vi.stubEnv("UMIEM_LLM_API_KEY", "");
      vi.stubEnv("UMIEM_TTS_API_KEY", "");
      vi.stubEnv("UMIEM_LLM_BASE_URL", "https://api.openai.com/v1");
      vi.stubEnv("UMIEM_LLM_MODEL", "gpt-4o-mini");
      vi.stubEnv("UMIEM_TTS_PROVIDER", "openai");
      vi.stubEnv("UMIEM_TTS_BASE_URL", "https://api.openai.com/v1");
      vi.stubEnv("UMIEM_TTS_MODEL", "gpt-4o-mini-tts");
      vi.stubEnv("UMIEM_TTS_VOICE", "alloy");
      vi.stubEnv("UMIEM_TTS_FORMAT", "mp3");
    }

    function configLines(log: { mock: { calls: unknown[][] } }): unknown[][] {
      return log.mock.calls.filter((call) => typeof call[0] === "string" && call[0].startsWith("[config]"));
    }

    it("z kluczem agenta → zależności agenta", async () => {
      stubOpenAiDirectEnv();
      vi.stubEnv("UMIEM_LESSON_AGENT_API_KEY", "sk-or-test");
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { services, pool } = buildWorkerServices();
      try {
        const lessonAgent = services.generation!.lessonAgent;
        expect(isLessonAgentAvailable(lessonAgent)).toBe(true);
        expect(configLines(log)).toEqual([]);
      } finally {
        await pool.end();
      }
    });

    it("bez klucza OpenRouter worker się składa, agent niedostępny i jedna linia logu", async () => {
      stubOpenAiDirectEnv();
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { services, pool } = buildWorkerServices();
      try {
        expect(services.generation!.lessonAgent).toEqual({ unavailable: "no_openrouter_key" });
        expect(log).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith(UNAVAILABLE_LINE);
      } finally {
        await pool.end();
      }
    });

    it("tryb fake bez klucza → zależności agenta, bez linii [config]", async () => {
      vi.stubEnv("DATABASE_URL", "postgres://test:test@127.0.0.1:1/worker-composition");
      vi.stubEnv("UMIEM_FAKE_PROVIDERS", "1");
      vi.stubEnv("OPENROUTER_API_KEY", "");
      vi.stubEnv("UMIEM_LESSON_AGENT_API_KEY", "");
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { services, pool } = buildWorkerServices();
      try {
        expect(isLessonAgentAvailable(services.generation!.lessonAgent)).toBe(true);
        expect(configLines(log)).toEqual([]);
      } finally {
        await pool.end();
      }
    });

    it("klucz agenta w kształcie OpenAI zatrzymuje start z nazwą zmiennej", () => {
      stubOpenAiDirectEnv();
      vi.stubEnv("UMIEM_LESSON_AGENT_API_KEY", "sk-proj-x");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(() => buildWorkerServices()).toThrow(/UMIEM_LESSON_AGENT_API_KEY/u);
    });
  });
});
