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
});
