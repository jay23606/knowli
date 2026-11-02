import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GRADER_MAX_CALLS_PER_SESSION,
  DEFAULT_GRADER_TIMEOUT_MS,
  DEFAULT_SESSION_ACTIVITY_TIMEOUT_MS,
  defaultMediaSettings,
  graderConfigured,
  graderFromEnv,
  mediaSettingsFromEnv,
  sessionActivityFromEnv,
} from "./config";
import { CONFIG_DEFAULTS, withConfigDefaults } from "./config-defaults";
import { chatRequestExtrasFromEnv } from "./providers/chat-request-options";
import { createGenerationDepsFromEnv } from "./providers/generation-env";
import { pricesFromEnv } from "./providers/usage/prices-env";
import { DEFAULT_LESSON_GENERATION_POLICY, lessonGenerationPolicyFromEnv } from "./modules/materials/lessons/lesson-generation-policy";

/** Design `2026-11-01-config-defaults-design.md`: domyślna konfiguracja w repo, `.env` tylko nadpisuje. */

const KEYS = { OPENAI_API_KEY: "sk-main", OPENROUTER_API_KEY: "sk-or-v1-shared" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("withConfigDefaults", () => {
  it("pusty env dostaje całą domyślną konfigurację", () => {
    const env = withConfigDefaults({});
    for (const [name, value] of Object.entries(CONFIG_DEFAULTS)) expect(env[name], name).toBe(value);
  });

  it("niepusta wartość wygrywa, pusta znaczy „nie ustawiono”, inne klucze bez zmian, wejście nietknięte", () => {
    const input = { UMIEM_TTS_VOICE: "Puck", UMIEM_TTS_STYLE: "", DATABASE_URL: "postgres://x", OPENAI_API_KEY: "sk-main" };
    const env = withConfigDefaults(input);
    expect(env.UMIEM_TTS_VOICE).toBe("Puck");
    expect(env.UMIEM_TTS_STYLE).toBe("instructions");
    expect(env.DATABASE_URL).toBe("postgres://x");
    expect(env.OPENAI_API_KEY).toBe("sk-main");
    expect(input.UMIEM_TTS_STYLE).toBe("");
    expect(env).not.toBe(input);
  });

  it("opcje pośrednika OpenRouter tylko przy endpoincie OpenRouter (warunek widzi nadpisany BASE_URL)", () => {
    expect(withConfigDefaults({}).UMIEM_LLM_REASONING).toBe("low");
    expect(withConfigDefaults({}).UMIEM_GRADER_REASONING).toBe("low");
    const openAi = withConfigDefaults({ UMIEM_LLM_BASE_URL: "https://api.openai.com/v1", UMIEM_GRADER_BASE_URL: "https://grader.example/v1" });
    expect(openAi.UMIEM_LLM_REASONING).toBeUndefined();
    expect(openAi.UMIEM_GRADER_REASONING).toBeUndefined();
    expect(() => chatRequestExtrasFromEnv(openAi, "UMIEM_LLM")).not.toThrow();
    expect(() => chatRequestExtrasFromEnv(openAi, "UMIEM_GRADER")).not.toThrow();
    expect(withConfigDefaults({ UMIEM_LLM_REASONING: "medium" }).UMIEM_LLM_REASONING).toBe("medium");
    // inny model na OpenRouter może nie obsługiwać rozumowania — bez domyślnej opcji
    expect(withConfigDefaults({ UMIEM_LLM_MODEL: "openai/gpt-4o-mini" }).UMIEM_LLM_REASONING).toBeUndefined();
    expect(withConfigDefaults({ UMIEM_GRADER_MODEL: "openai/gpt-4o-mini" }).UMIEM_GRADER_REASONING).toBeUndefined();
  });
});

describe("złożenie produkcyjne: domyślne + .env z samymi kluczami", () => {
  it("TTS: Gemini, Kore, WAV, styl i instrukcje wymowy", () => {
    const tts = mediaSettingsFromEnv(withConfigDefaults(KEYS)).tts;
    expect(tts).toMatchObject({ provider: "openrouter", model: "google/gemini-3.8-flash-tts", voice: "Kore", format: "wav", style: "instructions" });
    expect(tts.instructions?.["pl-PL"]).toBe(CONFIG_DEFAULTS.UMIEM_TTS_INSTRUCTIONS_PL_PL);
    expect(tts.instructions?.["en-GB"]).toBe(CONFIG_DEFAULTS.UMIEM_TTS_INSTRUCTIONS_EN_GB);
  });

  it("LLM i TTS idą do OpenRouter ze wspólnym kluczem", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/audio/speech")
        ? new Response(new Uint8Array([1]), { status: 200 })
        : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [] }) } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const deps = createGenerationDepsFromEnv(withConfigDefaults(KEYS))!;
    expect(deps.llm.model).toBe("google/gemini-3.8-flash");
    expect(deps.tts.model).toBe("google/gemini-3.8-flash-tts");
    await deps.llm.generateDeck({ prompt: "kolory", sourceLocale: "pl-PL", targetLocale: "en-GB", maxItems: 5 });
    // mp3: zaślepka odpowiedzi nie jest prawdziwym PCM; test sprawdza routing i klucz
    await deps.tts.synthesize({ text: "pies", locale: "pl-PL", voice: "Kore", format: "mp3" });
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => new URL(url).host)).toEqual(["openrouter.ai", "openrouter.ai"]);
    for (const [, init] of calls) expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-or-v1-shared");
    expect(JSON.parse(String(calls[0]![1].body)).reasoning).toEqual({ effort: "low" });
  });

  it("samo UMIEM_TTS_PROVIDER=openai przy domyślnym BASE_URL OpenRouter → jawny błąd zamiast cichego routingu", () => {
    expect(() => createGenerationDepsFromEnv(withConfigDefaults({ ...KEYS, UMIEM_TTS_PROVIDER: "openai" })))
      .toThrow("UMIEM_TTS_PROVIDER=openai requires UMIEM_TTS_BASE_URL=https://api.openai.com/v1");
    const openAi = withConfigDefaults({
      ...KEYS,
      UMIEM_TTS_PROVIDER: "openai", UMIEM_TTS_MODEL: "gpt-4o-mini-tts", UMIEM_TTS_VOICE: "alloy", UMIEM_TTS_FORMAT: "mp3",
      UMIEM_TTS_BASE_URL: "https://api.openai.com/v1",
    });
    expect(createGenerationDepsFromEnv(openAi)!.tts.model).toBe("gpt-4o-mini-tts");
  });

  it("samo OPENAI_API_KEY: worker nie startuje, a błąd wskazuje OPENROUTER_API_KEY bez wartości klucza", () => {
    let message = "";
    try {
      createGenerationDepsFromEnv(withConfigDefaults({ OPENAI_API_KEY: "sk-main" }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("OPENROUTER_API_KEY");
    expect(message).not.toContain("sk-main");
  });

  it("grader: wspólny klucz włącza go domyślnie na OpenRouter", () => {
    const env = withConfigDefaults(KEYS);
    expect(graderFromEnv(env)?.provider.model).toBe("google/gemini-3.8-flash");
    expect(sessionActivityFromEnv(env)?.publicService).toBe("openrouter.ai · google/gemini-3.8-flash");
    expect(graderConfigured(env)).toBe(true);
    // bez żadnego klucza OpenRouter — wyłączony, bez błędu startu
    expect(graderConfigured(withConfigDefaults({ OPENAI_API_KEY: KEYS.OPENAI_API_KEY }))).toBe(false);
  });

  it("worker przekazuje dostępność gradera tą samą regułą co web", () => {
    expect(createGenerationDepsFromEnv(withConfigDefaults(KEYS))!.graderAvailable).toBe(true);
    // tryb fake nie ocenia prawdziwej konfiguracji gradera
    expect(createGenerationDepsFromEnv(withConfigDefaults({ ...KEYS, UMIEM_FAKE_PROVIDERS: "1" }))!.graderAvailable).toBe(false);
  });
});

describe("zgodność z wartościami awaryjnymi parserów", () => {
  it("limity i obrazy w pliku domyślnych są równe stałym w kodzie", () => {
    const env = withConfigDefaults({});
    expect(lessonGenerationPolicyFromEnv(env)).toEqual(DEFAULT_LESSON_GENERATION_POLICY);
    expect(mediaSettingsFromEnv(env).image).toEqual(defaultMediaSettings.image);
    expect(Number(CONFIG_DEFAULTS.UMIEM_GRADER_TIMEOUT_MS)).toBe(DEFAULT_GRADER_TIMEOUT_MS);
    expect(Number(CONFIG_DEFAULTS.UMIEM_GRADER_MAX_CALLS_PER_SESSION)).toBe(DEFAULT_GRADER_MAX_CALLS_PER_SESSION);
    expect(Number(CONFIG_DEFAULTS.UMIEM_SESSION_ACTIVITY_TIMEOUT_MS)).toBe(DEFAULT_SESSION_ACTIVITY_TIMEOUT_MS);
  });
});

describe("stawki kosztów usług AI", () => {
  it("image price default applies only to default image config", () => {
    expect(withConfigDefaults({}).UMIEM_PRICE_IMAGE_USD).toBeTruthy();
    expect(withConfigDefaults({ UMIEM_IMAGE_MODEL: "other" }).UMIEM_PRICE_IMAGE_USD).toBeUndefined();
    expect(withConfigDefaults({ UMIEM_IMAGE_QUALITY: "high" }).UMIEM_PRICE_IMAGE_USD).toBeUndefined();
    expect(withConfigDefaults({ UMIEM_IMAGE_SIZE: "1536x1024" }).UMIEM_PRICE_IMAGE_USD).toBeUndefined();
    expect(withConfigDefaults({ UMIEM_IMAGE_MODEL: "other", UMIEM_PRICE_IMAGE_USD: "0.5" }).UMIEM_PRICE_IMAGE_USD).toBe("0.5");
  });

  it("tts price default applies only to default tts model", () => {
    expect(withConfigDefaults({}).UMIEM_PRICE_TTS_USD_PER_MINUTE).toBeTruthy();
    expect(withConfigDefaults({ UMIEM_TTS_MODEL: "other" }).UMIEM_PRICE_TTS_USD_PER_MINUTE).toBeUndefined();
    expect(withConfigDefaults({ UMIEM_TTS_MODEL: "other", UMIEM_PRICE_TTS_USD_PER_MINUTE: "0.1" }).UMIEM_PRICE_TTS_USD_PER_MINUTE).toBe("0.1");
  });

  it("stawki Azure są zawsze, a domyślne stawki są poprawne dla parsera", () => {
    const env = withConfigDefaults({ UMIEM_IMAGE_MODEL: "other", UMIEM_TTS_MODEL: "other" });
    expect(env.UMIEM_PRICE_AZURE_STT_USD_PER_HOUR).toBeTruthy();
    expect(env.UMIEM_PRICE_AZURE_PRONUNCIATION_USD_PER_HOUR).toBeTruthy();
    const prices = pricesFromEnv(withConfigDefaults({}));
    expect(Object.keys(prices).sort()).toEqual(["azurePronunciationUsdPerHour", "azureSttUsdPerHour", "imageUsd", "ttsUsdPerMinute"]);
  });
});
