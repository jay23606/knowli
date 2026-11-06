import { afterEach, describe, expect, it, vi } from "vitest";
import { withConfigDefaults } from "../config-defaults";
import { createGenerationDepsFromEnv, generationPublicServiceFromEnv, imageProviderFromEnv } from "./generation-env";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("UMIEM_FAKE_HOLD_FILE (bramka fake'ów E2E)", () => {
  it("trafia do fake TTS: synteza czeka, dopóki plik bramki istnieje", async () => {
    const dir = mkdtempSync(join(tmpdir(), "knowli-hold-env-"));
    const holdFile = join(dir, "hold");
    try {
      writeFileSync(holdFile, "");
      const deps = createGenerationDepsFromEnv({ UMIEM_FAKE_PROVIDERS: "1", UMIEM_FAKE_HOLD_FILE: holdFile, MEDIA_ROOT: join(dir, "media") })!;
      let settled = false;
      const call = deps.tts.synthesize({ text: "monday", locale: "en-GB", voice: "v", format: "mp3" } as never).then(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(settled).toBe(false);
      rmSync(holdFile);
      await call;
      expect(settled).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
import { createTestRecorder } from "./usage/test-recorder";

/**
 * Kontrakt konfiguracji LLM generującego materiał (zestawy + pule lekcji):
 * `UMIEM_LLM_MODEL`/`UMIEM_LLM_BASE_URL`/`UMIEM_LLM_API_KEY` nadpisują model,
 * endpoint i klucz samego LLM, z fallbackami do wartości domyślnych
 * (`gpt-4o-mini`, `https://api.openai.com/v1`) i `OPENAI_API_KEY`. Wzorzec
 * niezależnych zmiennych jak przy `UMIEM_TTS_*`/`UMIEM_IMAGE_*` (LLM jest
 * obowiązkową zależnością workera, nie opcjonalnym feature'em jak grader).
 * `UMIEM_LLM_BASE_URL` dostaje klucz w nagłówku Authorization, więc poza
 * NODE_ENV test/development wymaga `https://` — jak `UMIEM_GRADER_BASE_URL`.
 * Jak dla TTS: `OPENAI_API_KEY` trafia wyłącznie do api.openai.com — inny
 * BASE_URL wymaga własnego klucza, a klucz OpenRouter wymaga BASE_URL.
 */

/** Wywołuje fabrykę i zwraca komunikat błędu; sprawdza, że nie zawiera wartości kluczy. */
function configError(env: Record<string, string | undefined>): string {
  let message: string | undefined;
  try {
    createGenerationDepsFromEnv(env);
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message, "oczekiwany błąd konfiguracji").toBeDefined();
  for (const [name, value] of Object.entries(env)) {
    if (name.endsWith("_KEY") && value) expect(message).not.toContain(value);
  }
  return message!;
}

function okDeckResponse(): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [] }) } }] }),
    { status: 200 },
  );
}

const DECK_INPUT = { prompt: "kolory", sourceLocale: "pl-PL", targetLocale: "en-GB", maxItems: 5 };

function lastCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  expect(fetchMock).toHaveBeenCalledOnce();
  return fetchMock.mock.calls[0] as [string, RequestInit];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createGenerationDepsFromEnv — konfiguracja LLM przez UMIEM_LLM_*", () => {
  it("bez UMIEM_LLM_* używa domyślnego modelu i api.openai.com z kluczem OPENAI_API_KEY", async () => {
    const fetchMock = vi.fn(async () => okDeckResponse());
    vi.stubGlobal("fetch", fetchMock);

    const deps = createGenerationDepsFromEnv({ OPENAI_API_KEY: "sk-main" });

    expect(deps).toBeDefined();
    expect(deps!.llm.model).toBe("gpt-4o-mini");
    expect(deps!.lessonExecution).toEqual({ requestTimeoutMs: 90_000, runTimeoutMs: 600_000, cancelPollMs: 1_000 });
    await deps!.llm.generateDeck(DECK_INPUT);
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-main");
    expect(JSON.parse(String(init.body)).model).toBe("gpt-4o-mini");
  });

  it("UMIEM_LLM_MODEL nadpisuje model w żądaniu", async () => {
    const fetchMock = vi.fn(async () => okDeckResponse());
    vi.stubGlobal("fetch", fetchMock);

    const deps = createGenerationDepsFromEnv({ OPENAI_API_KEY: "sk-main", UMIEM_LLM_MODEL: "gpt-5-mini" });

    expect(deps!.llm.model).toBe("gpt-5-mini");
    await deps!.llm.generateDeck(DECK_INPUT);
    const [, init] = lastCall(fetchMock);
    expect(JSON.parse(String(init.body)).model).toBe("gpt-5-mini");
  });

  it("UMIEM_LLM_BASE_URL i UMIEM_LLM_API_KEY nadpisują endpoint i klucz samego LLM", async () => {
    const fetchMock = vi.fn(async () => okDeckResponse());
    vi.stubGlobal("fetch", fetchMock);

    const deps = createGenerationDepsFromEnv({
      OPENAI_API_KEY: "sk-main",
      UMIEM_LLM_BASE_URL: "https://llm.example/v1",
      UMIEM_LLM_API_KEY: "sk-llm",
    });

    await deps!.llm.generateDeck(DECK_INPUT);
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://llm.example/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-llm");
  });

  it("puste wartości UMIEM_LLM_* traktowane jak nieustawione", async () => {
    const fetchMock = vi.fn(async () => okDeckResponse());
    vi.stubGlobal("fetch", fetchMock);

    const deps = createGenerationDepsFromEnv({
      OPENAI_API_KEY: "sk-main",
      UMIEM_LLM_MODEL: "",
      UMIEM_LLM_BASE_URL: "",
      UMIEM_LLM_API_KEY: "",
    });

    expect(deps!.llm.model).toBe("gpt-4o-mini");
    await deps!.llm.generateDeck(DECK_INPUT);
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-main");
  });

  it("http:// UMIEM_LLM_BASE_URL odrzucone poza test/development", () => {
    expect(() =>
      createGenerationDepsFromEnv({
        OPENAI_API_KEY: "sk-main",
        UMIEM_LLM_BASE_URL: "http://llm.example/v1",
        NODE_ENV: "production",
      }),
    ).toThrow(/UMIEM_LLM_BASE_URL/);
  });

  it("http:// UMIEM_LLM_BASE_URL dozwolone w development", async () => {
    const fetchMock = vi.fn(async () => okDeckResponse());
    vi.stubGlobal("fetch", fetchMock);

    const deps = createGenerationDepsFromEnv({
      OPENAI_API_KEY: "sk-main",
      UMIEM_LLM_BASE_URL: "http://localhost:9999/v1",
      UMIEM_LLM_API_KEY: "sk-local",
      NODE_ENV: "development",
    });

    await deps!.llm.generateDeck(DECK_INPUT);
    const [url] = lastCall(fetchMock);
    expect(url).toBe("http://localhost:9999/v1/chat/completions");
  });

  it("http:// UMIEM_LLM_BASE_URL dozwolone też w NODE_ENV=test", () => {
    const deps = createGenerationDepsFromEnv({
      OPENAI_API_KEY: "sk-main",
      UMIEM_LLM_BASE_URL: "http://localhost:9999/v1",
      UMIEM_LLM_API_KEY: "sk-local",
      NODE_ENV: "test",
    });
    expect(deps).toBeDefined();
  });

  it("własny UMIEM_LLM_BASE_URL bez UMIEM_LLM_API_KEY to błąd startu — OPENAI_API_KEY nie trafia do innego hosta", () => {
    const fetchMock = vi.fn(async () => okDeckResponse());
    vi.stubGlobal("fetch", fetchMock);
    expect(configError({ OPENAI_API_KEY: "sk-main", UMIEM_LLM_BASE_URL: "https://openrouter.ai/api/v1" }))
      .toBe("UMIEM_LLM_BASE_URL requires UMIEM_LLM_API_KEY or OPENROUTER_API_KEY (OPENAI_API_KEY is never sent to another endpoint)");
    // wspólny klucz nie trafiłby na inny host, więc komunikat go nie podpowiada
    for (const baseUrl of ["https://api.openai.com.evil.example/v1", "https://evil.example/api.openai.com/v1"]) {
      expect(configError({ OPENAI_API_KEY: "sk-main", UMIEM_LLM_BASE_URL: baseUrl }))
        .toBe("UMIEM_LLM_BASE_URL requires UMIEM_LLM_API_KEY (OPENAI_API_KEY is never sent to another endpoint)");
    }
    // także lokalny endpoint w development: klucz OpenAI nie idzie na http://localhost
    expect(configError({ OPENAI_API_KEY: "sk-main", UMIEM_LLM_BASE_URL: "http://localhost:9999/v1", NODE_ENV: "development" }))
      .toMatch(/^UMIEM_LLM_BASE_URL requires UMIEM_LLM_API_KEY/);
    // http://api.openai.com nie jest uznawany za OpenAI (klucz jawnym tekstem)
    expect(configError({ OPENAI_API_KEY: "sk-main", UMIEM_LLM_BASE_URL: "http://api.openai.com/v1", NODE_ENV: "development" }))
      .toMatch(/^UMIEM_LLM_BASE_URL requires UMIEM_LLM_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("jawny UMIEM_LLM_BASE_URL na api.openai.com bez własnego klucza używa OPENAI_API_KEY", async () => {
    const fetchMock = vi.fn(async () => okDeckResponse());
    vi.stubGlobal("fetch", fetchMock);

    const deps = createGenerationDepsFromEnv({ OPENAI_API_KEY: "sk-main", UMIEM_LLM_BASE_URL: "https://api.openai.com/v1" });

    await deps!.llm.generateDeck(DECK_INPUT);
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-main");
  });

  it("własny UMIEM_LLM_API_KEY bez BASE_URL (np. osobny klucz OpenAI) idzie na api.openai.com", async () => {
    const fetchMock = vi.fn(async () => okDeckResponse());
    vi.stubGlobal("fetch", fetchMock);

    const deps = createGenerationDepsFromEnv({ OPENAI_API_KEY: "sk-main", UMIEM_LLM_API_KEY: "sk-proj-llm" });

    await deps!.llm.generateDeck(DECK_INPUT);
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-proj-llm");
  });

  it("klucz OpenRouter w UMIEM_LLM_API_KEY bez BASE_URL OpenRoutera to błąd startu — nie trafia do api.openai.com ani obcego hosta", () => {
    expect(configError({ OPENAI_API_KEY: "sk-main", UMIEM_LLM_API_KEY: "sk-or-v1-secret" }))
      .toBe('UMIEM_LLM_API_KEY for provider "openrouter" requires UMIEM_LLM_BASE_URL (the key is never sent to api.openai.com)');
    for (const baseUrl of ["https://api.openai.com/v1", "https://proxy.example/v1", "http://openrouter.ai/api/v1"]) {
      expect(configError({ OPENAI_API_KEY: "sk-main", UMIEM_LLM_API_KEY: "sk-or-v1-secret", UMIEM_LLM_BASE_URL: baseUrl, NODE_ENV: "development" }), baseUrl)
        .toBe("UMIEM_LLM_API_KEY looks like an OpenRouter key but UMIEM_LLM_BASE_URL is not an https OpenRouter endpoint");
    }
  });

  it("klucz OpenRouter rozpoznawany też z wielką literą i spacjami", () => {
    for (const key of ["SK-OR-v1-secret", "  sk-or-v1-secret"]) {
      expect(configError({ OPENAI_API_KEY: "sk-main", UMIEM_LLM_API_KEY: key })).toMatch(/^UMIEM_LLM_API_KEY for provider "openrouter"/);
    }
  });

  it("host api.openai.com rozpoznawany po sparsowanym URL (wielkość liter, port), nie po tekście", async () => {
    const fetchMock = vi.fn(async () => okDeckResponse());
    vi.stubGlobal("fetch", fetchMock);
    for (const baseUrl of ["https://API.OpenAI.com/v1", "https://api.openai.com:443/v1"]) {
      await createGenerationDepsFromEnv({ OPENAI_API_KEY: "sk-main", UMIEM_LLM_BASE_URL: baseUrl })!.llm.generateDeck(DECK_INPUT);
    }
    for (const [url, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(new URL(url).hostname).toBe("api.openai.com");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-main");
    }
    // userinfo i kropka końcowa wskazują inny host albo są podejrzane → wymagany własny klucz
    for (const baseUrl of ["https://api.openai.com@evil.example/v1", "https://api.openai.com./v1"]) {
      expect(configError({ OPENAI_API_KEY: "sk-main", UMIEM_LLM_BASE_URL: baseUrl })).toMatch(/^UMIEM_LLM_BASE_URL requires UMIEM_LLM_API_KEY/);
    }
  });

  it("klucz OpenRouter w OPENAI_API_KEY to błąd startu — OPENAI_API_KEY zawsze idzie do api.openai.com", () => {
    const message = configError({
      OPENAI_API_KEY: "sk-or-v1-secret",
      UMIEM_LLM_BASE_URL: "https://openrouter.ai/api/v1",
      UMIEM_LLM_API_KEY: "sk-or-v1-llm",
    });
    expect(message).toMatch(/^OPENAI_API_KEY holds an OpenRouter key/);
    expect(() => imageProviderFromEnv({ OPENAI_API_KEY: "sk-or-v1-secret" })).toThrow(/^OPENAI_API_KEY holds an OpenRouter key/);
    expect(imageProviderFromEnv({ OPENAI_API_KEY: "sk-proj-main" })).toBeDefined();
    expect(imageProviderFromEnv({})).toBeUndefined();
  });

  it("konfiguracja produkcyjna (OpenRouter dla LLM i TTS, OPENAI_API_KEY dla obrazów) działa bez zmian", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/audio/speech") ? new Response(new Uint8Array([1]), { status: 200 }) : okDeckResponse());
    vi.stubGlobal("fetch", fetchMock);

    const deps = createGenerationDepsFromEnv({
      NODE_ENV: "production",
      OPENAI_API_KEY: "sk-proj-main",
      UMIEM_LLM_BASE_URL: "https://openrouter.ai/api/v1",
      UMIEM_LLM_API_KEY: "sk-or-v1-llm",
      UMIEM_LLM_MODEL: "google/gemini-3.8-flash",
      UMIEM_LLM_REASONING: "low",
      UMIEM_TTS_PROVIDER: "openrouter",
      UMIEM_TTS_BASE_URL: "https://openrouter.ai/api/v1",
      UMIEM_TTS_API_KEY: "sk-or-v1-tts",
      UMIEM_TTS_MODEL: "microsoft/mai-voice-2.1-flash",
    });

    await deps!.llm.generateDeck(DECK_INPUT);
    await deps!.tts.synthesize({ text: "kot", locale: "pl-PL", voice: "pl-PL-Harper:MAI-Voice-2.1-Flash", format: "mp3" });
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => [url, (init.headers as Record<string, string>).authorization])).toEqual([
      ["https://openrouter.ai/api/v1/chat/completions", "Bearer sk-or-v1-llm"],
      ["https://openrouter.ai/api/v1/audio/speech", "Bearer sk-or-v1-tts"],
    ]);
  });

  it("UMIEM_FAKE_PROVIDERS=1 ignoruje UMIEM_LLM_* (deterministyczny fake)", () => {
    const deps = createGenerationDepsFromEnv({ UMIEM_FAKE_PROVIDERS: "1", UMIEM_LLM_MODEL: "gpt-5-mini" });
    expect(deps!.llm.name).toBe("fake-llm");
    expect(deps!.llm.model).toBe("fake-llm-1");
  });
});

describe("createGenerationDepsFromEnv — TTS przez UMIEM_TTS_* (np. OpenRouter)", () => {
  const SPEECH_INPUT = { text: "Ile nóg ma pająk?", locale: "pl-PL", voice: "alloy", format: "mp3" as const };

  it("bez UMIEM_TTS_* wysyła domyślny model na api.openai.com z kluczem OPENAI_API_KEY", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const deps = createGenerationDepsFromEnv({ OPENAI_API_KEY: "sk-main" });

    await deps!.tts.synthesize(SPEECH_INPUT);
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-main");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "gpt-4o-mini-tts", voice: "alloy", input: "Ile nóg ma pająk?" });
  });

  it("UMIEM_TTS_BASE_URL, UMIEM_TTS_API_KEY i UMIEM_TTS_MODEL kierują nagrania do OpenRouter", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const deps = createGenerationDepsFromEnv({
      OPENAI_API_KEY: "sk-main",
      UMIEM_TTS_BASE_URL: "https://openrouter.ai/api/v1",
      UMIEM_TTS_API_KEY: "sk-or-v1-test",
      UMIEM_TTS_MODEL: "openai/gpt-4o-mini-tts-2025-12-15",
    });

    expect(deps!.tts.model).toBe("openai/gpt-4o-mini-tts-2025-12-15");
    await deps!.tts.synthesize(SPEECH_INPUT);
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://openrouter.ai/api/v1/audio/speech");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-or-v1-test");
    expect(JSON.parse(String(init.body)).model).toBe("openai/gpt-4o-mini-tts-2025-12-15");
  });

  it("puste UMIEM_TTS_* traktowane jak nieustawione", () => {
    const deps = createGenerationDepsFromEnv({ OPENAI_API_KEY: "sk-main", UMIEM_TTS_BASE_URL: "", UMIEM_TTS_API_KEY: "", UMIEM_TTS_MODEL: "" });
    expect(deps!.tts.model).toBe("gpt-4o-mini-tts");
  });

  it("http:// UMIEM_TTS_BASE_URL odrzucone poza test/development", () => {
    expect(() => createGenerationDepsFromEnv({ OPENAI_API_KEY: "sk-main", UMIEM_TTS_BASE_URL: "http://tts.example/v1", UMIEM_TTS_API_KEY: "sk-tts" }))
      .toThrow("UMIEM_TTS_BASE_URL must use https:// outside test/development");
  });

  it("klucz OpenRouter bez UMIEM_TTS_BASE_URL to błąd konfiguracji — nie trafia do api.openai.com", () => {
    expect(() => createGenerationDepsFromEnv({ OPENAI_API_KEY: "sk-main", UMIEM_TTS_PROVIDER: "openrouter", UMIEM_TTS_API_KEY: "sk-or" }))
      .toThrow('UMIEM_TTS_API_KEY for provider "openrouter" requires UMIEM_TTS_BASE_URL');
    // własny klucz OpenAI bez BASE_URL nadal dozwolony
    expect(() => createGenerationDepsFromEnv({ OPENAI_API_KEY: "sk-main", UMIEM_TTS_API_KEY: "sk-tts" })).not.toThrow();
  });

  it("własny UMIEM_TTS_BASE_URL bez UMIEM_TTS_API_KEY to błąd konfiguracji — klucz OpenAI nie trafia do innego hosta", () => {
    expect(configError({ OPENAI_API_KEY: "sk-main", UMIEM_TTS_BASE_URL: "https://openrouter.ai/api/v1" }))
      .toBe("UMIEM_TTS_BASE_URL requires UMIEM_TTS_API_KEY or OPENROUTER_API_KEY (OPENAI_API_KEY is never sent to another endpoint)");
  });

  it("jawny UMIEM_TTS_BASE_URL na api.openai.com bez własnego klucza używa OPENAI_API_KEY", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const deps = createGenerationDepsFromEnv({ OPENAI_API_KEY: "sk-main", UMIEM_TTS_BASE_URL: "https://api.openai.com/v1" });

    await deps!.tts.synthesize(SPEECH_INPUT);
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-main");
  });

  it("klucz OpenRouter w UMIEM_TTS_API_KEY przy domyślnym providerze bez BASE_URL to błąd konfiguracji", () => {
    expect(configError({ OPENAI_API_KEY: "sk-main", UMIEM_TTS_API_KEY: "sk-or-v1-secret" }))
      .toBe('UMIEM_TTS_API_KEY for provider "openrouter" requires UMIEM_TTS_BASE_URL (the key is never sent to api.openai.com)');
    expect(configError({ OPENAI_API_KEY: "sk-main", UMIEM_TTS_API_KEY: "sk-or-v1-secret", UMIEM_TTS_BASE_URL: "https://api.openai.com/v1" }))
      .toBe("UMIEM_TTS_API_KEY looks like an OpenRouter key but UMIEM_TTS_BASE_URL is not an https OpenRouter endpoint");
  });
});

describe("generationPublicServiceFromEnv — nazwa usługi generującej dla rodzica", () => {
  it("domyślna konfiguracja repo daje host i model OpenRouter", () => {
    expect(generationPublicServiceFromEnv(withConfigDefaults({}))).toBe("openrouter.ai · google/gemini-3.8-flash");
  });

  it("tryb fake nie pokazuje prawdziwej usługi", () => {
    expect(generationPublicServiceFromEnv(withConfigDefaults({ UMIEM_FAKE_PROVIDERS: "1" }))).toBe("fake-llm-1");
  });

  it("własny adres i model są pokazane jako host · model, bez ścieżki i klucza", () => {
    expect(generationPublicServiceFromEnv({
      UMIEM_LLM_BASE_URL: "https://llm.example.test:8443/v1",
      UMIEM_LLM_MODEL: "model-x",
      UMIEM_LLM_API_KEY: "sk-secret",
    })).toBe("llm.example.test:8443 · model-x");
  });

  it("puste wartości oznaczają domyślne adaptera", () => {
    expect(generationPublicServiceFromEnv({})).toBe("api.openai.com · gpt-4o-mini");
    expect(generationPublicServiceFromEnv({ UMIEM_LLM_BASE_URL: "", UMIEM_LLM_MODEL: "" })).toBe("api.openai.com · gpt-4o-mini");
  });

  it("zły adres nie rzuca (etykieta jest tylko opisem): http poza test/development i adres uszkodzony dają undefined", () => {
    expect(generationPublicServiceFromEnv({ NODE_ENV: "production", UMIEM_LLM_BASE_URL: "http://llm.example.test/v1" })).toBeUndefined();
    expect(generationPublicServiceFromEnv({ UMIEM_LLM_BASE_URL: "https://" })).toBeUndefined();
    expect(generationPublicServiceFromEnv({ UMIEM_LLM_BASE_URL: "not a url" })).toBeUndefined();
    // http w test/development nadal jest opisywany
    expect(generationPublicServiceFromEnv({ NODE_ENV: "development", UMIEM_LLM_BASE_URL: "http://localhost:9000/v1", UMIEM_LLM_MODEL: "m" }))
      .toBe("localhost:9000 · m");
  });
});

describe("createGenerationDepsFromEnv — zapis kosztów (usage)", () => {
  it("factory passes usage to adapter", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okDeckResponse()));
    const rec = createTestRecorder();
    const deps = createGenerationDepsFromEnv({
      OPENAI_API_KEY: "sk-main",
      UMIEM_LLM_BASE_URL: "https://openrouter.ai/api/v1",
      UMIEM_LLM_API_KEY: "or-test-key",
      UMIEM_LLM_MODEL: "google/gemini-3.8-flash",
    }, rec);
    await deps!.llm.generateDeck(DECK_INPUT);
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({
      feature: "deck_generation", operation: "deck", provider: "openrouter", model: "google/gemini-3.8-flash", outcome: "ok",
    });
  });

  it("bez usage fabryka działa jak dotąd i nic nie zapisuje", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okDeckResponse()));
    const deps = createGenerationDepsFromEnv({ OPENAI_API_KEY: "sk-main" });
    await expect(deps!.llm.generateDeck(DECK_INPUT)).resolves.toEqual({ items: [] });
  });
});

describe("createGenerationDepsFromEnv — zapis kosztów mediów (usage)", () => {
  const MEDIA_ENV = {
    OPENAI_API_KEY: "sk-main",
    UMIEM_TTS_BASE_URL: "https://openrouter.ai/api/v1",
    UMIEM_TTS_API_KEY: "or-tts-key",
    UMIEM_TTS_MODEL: "google/gemini-3.8-flash-tts",
  };
  const IMAGE_INPUT = { prompt: "apple", model: "gpt-image-1-mini", size: "1024x1024", quality: "low", format: "webp" };
  afterEach(() => vi.unstubAllGlobals());

  it("factory passes usage to adapter (tts i obrazy)", async () => {
    const rec = createTestRecorder();
    const deps = createGenerationDepsFromEnv(MEDIA_ENV, rec)!;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(480), { status: 200, headers: { "content-type": "audio/pcm;rate=24000;channels=1" } })));
    await deps.tts.synthesize({ text: "pies", locale: "pl-PL", voice: "Kore", format: "wav" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: "aW1n" }] }), { status: 200 })));
    await deps.image.generate(IMAGE_INPUT);
    expect(rec.events).toHaveLength(2);
    expect(rec.events[0]).toMatchObject({ feature: "tts", provider: "openrouter", outcome: "ok" });
    expect(rec.events[1]).toMatchObject({ feature: "illustration", provider: "openai", outcome: "ok", images: 1 });
  });

  it("imageProviderFromEnv przekazuje usage i feature", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: "aW1n" }] }), { status: 200 })));
    const rec = createTestRecorder();
    await imageProviderFromEnv({ OPENAI_API_KEY: "sk-main" }, rec, "deck_cover")!.generate(IMAGE_INPUT);
    await imageProviderFromEnv({ OPENAI_API_KEY: "sk-main" }, rec)!.generate(IMAGE_INPUT);
    expect(rec.events.map((event) => event.feature)).toEqual(["deck_cover", "illustration"]);
  });

  it("bez usage fabryka nic nie zapisuje i działa jak dotąd", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: "aW1n" }] }), { status: 200 })));
    await expect(imageProviderFromEnv({ OPENAI_API_KEY: "sk-main" })!.generate(IMAGE_INPUT)).resolves.toMatchObject({ mimeType: "image/webp" });
  });
});

describe("createGenerationDepsFromEnv — dawny krytyk lekcji (UMIEM_REVIEWER_*)", () => {
  it("pozostawione, także błędne, UMIEM_REVIEWER_* są ignorowane", () => {
    expect(() => createGenerationDepsFromEnv(withConfigDefaults({
      UMIEM_FAKE_PROVIDERS: "1", UMIEM_REVIEWER_ENABLED: "true", UMIEM_REVIEWER_CONCURRENCY: "abc",
    }))).not.toThrow();
  });

  it("wariant produkcyjny: błędne UMIEM_REVIEWER_* nie zatrzymują składania", () => {
    expect(() => createGenerationDepsFromEnv(withConfigDefaults({
      OPENROUTER_API_KEY: "sk-or-v1-shared", OPENAI_API_KEY: "sk-main",
      UMIEM_REVIEWER_ENABLED: "true", UMIEM_REVIEWER_CONCURRENCY: "0", UMIEM_REVIEWER_REASONING: "turbo",
    }))).not.toThrow();
  });

  it("wartości domyślne nie zawierają UMIEM_REVIEWER_*", () => {
    expect(withConfigDefaults({})).not.toHaveProperty("UMIEM_REVIEWER_ENABLED");
  });
});
