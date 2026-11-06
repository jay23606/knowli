import { lessonCatalog } from "@learning/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { disposeServerServices, disposeServices, getServerServices } from "./composition";

describe("disposeServices", () => {
  it("flushes usage before closing the pool", async () => {
    const order: string[] = [];
    const step = (name: string) => async () => {
      order.push(`${name}:start`);
      await Promise.resolve();
      order.push(`${name}:end`);
    };

    await disposeServices({ usage: { record: () => {}, flush: step("usage.flush") }, pool: { end: step("pool.end") } });

    expect(order).toEqual(["usage.flush:start", "usage.flush:end", "pool.end:start", "pool.end:end"]);
  });

  it("closes the pool without a recorder (fake providers)", async () => {
    const order: string[] = [];
    await disposeServices({ pool: { end: async () => { order.push("pool.end"); } } });
    expect(order).toEqual(["pool.end"]);
  });
});

describe("getServerServices — opis agenta puli lekcji", () => {
  afterEach(async () => {
    await disposeServerServices();
    vi.unstubAllEnvs();
  });

  /** Pula pg łączy się dopiero przy zapytaniu, więc adres nie musi istnieć; bez kluczy z powłoki. */
  function stubBaseEnv(): void {
    vi.stubEnv("DATABASE_URL", "postgres://test:test@127.0.0.1:1/web-composition");
    vi.stubEnv("UMIEM_FAKE_PROVIDERS", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("UMIEM_LESSON_AGENT_API_KEY", "");
    vi.stubEnv("UMIEM_LLM_API_KEY", "");
  }

  it("tryb fake bez klucza → opis agenta i katalog z dostępnym generowaniem", () => {
    stubBaseEnv();
    vi.stubEnv("UMIEM_FAKE_PROVIDERS", "1");
    const services = getServerServices();
    expect(services.lessonAgentPublic).toBeDefined();
    expect(lessonCatalog(services).lessonGenerationAvailable).toBe(true);
  });

  it("klucz agenta w kształcie OpenAI nie zatrzymuje web; generowanie lekcji niedostępne", () => {
    stubBaseEnv();
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-v1-web");
    vi.stubEnv("UMIEM_LESSON_AGENT_API_KEY", "sk-proj-x");
    let services: ReturnType<typeof getServerServices> | undefined;
    expect(() => { services = getServerServices(); }).not.toThrow();
    expect(services!.lessonAgentPublic).toBeUndefined();
    expect(lessonCatalog(services!).lessonGenerationAvailable).toBe(false);
  });

  it("błędne UMIEM_LESSON_AGENT_MAX_STEPS przy poprawnym kluczu nie zatrzymuje web", () => {
    stubBaseEnv();
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-v1-web");
    vi.stubEnv("UMIEM_LESSON_AGENT_MAX_STEPS", "abc");
    let services: ReturnType<typeof getServerServices> | undefined;
    expect(() => { services = getServerServices(); }).not.toThrow();
    expect(services!.lessonAgentPublic).toBeDefined();
  });
});
