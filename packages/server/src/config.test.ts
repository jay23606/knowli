import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LESSON_STT_MODEL, defaultMediaSettings, graderFromEnv, lessonSpeechFromEnv, mediaSettingsFromEnv, sessionActivityFromEnv, ttsInstructionsFor, ttsVoiceFor } from "./config";
import { createTestRecorder } from "./providers/usage/test-recorder";

describe("mediaSettingsFromEnv", () => {
  it("bez env zwraca domyślne ustawienia (low + webp)", () => {
    expect(mediaSettingsFromEnv({})).toEqual(defaultMediaSettings);
    expect(defaultMediaSettings.image).toMatchObject({ quality: "low", format: "webp" });
    expect(defaultMediaSettings.image.model).toBe("gpt-image-2.5-sunburst");
  });

  it("puste UMIEM_TTS_* jak nieustawione — fingerprint opisuje model faktycznie użyty przez adapter", () => {
    expect(mediaSettingsFromEnv({ UMIEM_TTS_PROVIDER: "", UMIEM_TTS_MODEL: "", UMIEM_TTS_VOICE: "" }).tts).toEqual(defaultMediaSettings.tts);
    expect(mediaSettingsFromEnv({ UMIEM_TTS_PROVIDER: "openrouter", UMIEM_TTS_MODEL: "openai/gpt-4o-mini-tts-2025-12-15" }).tts)
      .toMatchObject({ provider: "openrouter", model: "openai/gpt-4o-mini-tts-2025-12-15", voice: "alloy" });
  });

  it("UMIEM_TTS_VOICE_<LANG>_<REGION> przypisuje głos do locale; reszta używa UMIEM_TTS_VOICE", () => {
    const settings = mediaSettingsFromEnv({
      UMIEM_TTS_VOICE: "pl-PL-Harper:MAI-Voice-2.1-Flash",
      UMIEM_TTS_VOICE_EN_GB: "en-GB-Emily:MAI-Voice-2.1-Flash",
      UMIEM_TTS_VOICE_DE_DE: "",
    });
    expect(settings.tts.voices).toEqual({ "en-GB": "en-GB-Emily:MAI-Voice-2.1-Flash" });
    expect(ttsVoiceFor(settings.tts, "en-GB")).toBe("en-GB-Emily:MAI-Voice-2.1-Flash");
    expect(ttsVoiceFor(settings.tts, "pl-PL")).toBe("pl-PL-Harper:MAI-Voice-2.1-Flash");
    // bez zmiennych per locale ustawienia (i fingerprinty) jak dotąd
    expect(mediaSettingsFromEnv({}).tts).not.toHaveProperty("voices");
  });

  it("UMIEM_TTS_FORMAT wybiera mp3 albo wav; inna wartość to błąd startu", () => {
    expect(mediaSettingsFromEnv({}).tts.format).toBe("mp3");
    expect(mediaSettingsFromEnv({ UMIEM_TTS_FORMAT: "" }).tts.format).toBe("mp3");
    expect(mediaSettingsFromEnv({ UMIEM_TTS_FORMAT: "wav" }).tts.format).toBe("wav");
    expect(() => mediaSettingsFromEnv({ UMIEM_TTS_FORMAT: "pcm" })).toThrow(/UMIEM_TTS_FORMAT/);
  });

  it("UMIEM_TTS_STYLE=instructions włącza styl; brak, puste i none to brak pola", () => {
    expect(mediaSettingsFromEnv({}).tts.style).toBeUndefined();
    expect(mediaSettingsFromEnv({ UMIEM_TTS_STYLE: "" }).tts.style).toBeUndefined();
    expect(mediaSettingsFromEnv({ UMIEM_TTS_STYLE: "instructions" }).tts.style).toBe("instructions");
    // „none” nie zmienia kształtu ustawień, więc fingerprinty istniejących zasobów zostają.
    expect(mediaSettingsFromEnv({ UMIEM_TTS_STYLE: "none" }).tts).not.toHaveProperty("style");
    expect(mediaSettingsFromEnv({}).tts).not.toHaveProperty("style");
    expect(() => mediaSettingsFromEnv({ UMIEM_TTS_STYLE: "loud" })).toThrow(
      "UMIEM_TTS_STYLE must be instructions or none",
    );
  });

  it("UMIEM_TTS_INSTRUCTIONS_<LANG>_<REGION> przypisuje instrukcję wymowy do locale", () => {
    const settings = mediaSettingsFromEnv({
      UMIEM_TTS_INSTRUCTIONS_PL_PL: "Mów po polsku, z polską wymową.",
      UMIEM_TTS_INSTRUCTIONS_EN_GB: "Speak British English.",
      UMIEM_TTS_INSTRUCTIONS_DE_DE: "",
    });
    expect(settings.tts.instructions).toEqual({
      "pl-PL": "Mów po polsku, z polską wymową.",
      "en-GB": "Speak British English.",
    });
    expect(ttsInstructionsFor(settings.tts, "en-GB")).toBe("Speak British English.");
    expect(ttsInstructionsFor(settings.tts, "fr-FR")).toBeUndefined();
    expect(mediaSettingsFromEnv({}).tts).not.toHaveProperty("instructions");
  });

  it("zmienne UMIEM_IMAGE_* nadpisują model, rozmiar, jakość i format", () => {
    const settings = mediaSettingsFromEnv({
      UMIEM_IMAGE_MODEL: "gpt-image-1-mini",
      UMIEM_IMAGE_SIZE: "1024x1536",
      UMIEM_IMAGE_QUALITY: "medium",
      UMIEM_IMAGE_FORMAT: "png",
    });
    expect(settings.image).toEqual({
      provider: "openai",
      model: "gpt-image-1-mini",
      size: "1024x1536",
      quality: "medium",
      format: "png",
    });
    expect(settings.tts).toEqual(defaultMediaSettings.tts);
  });
});


describe("graderFromEnv", () => {
  const base = {
    UMIEM_GRADER_BASE_URL: "https://grader.example/v1",
    UMIEM_GRADER_API_KEY: "secret",
    UMIEM_GRADER_MODEL: "cheap-1",
  };

  it("bez konfiguracji → undefined (model wyłączony to stan poprawny)", () => {
    expect(graderFromEnv({})).toBeUndefined();
  });

  it("komplet trzech wartości → skonfigurowany grader z domyślnymi limitami", () => {
    const grader = graderFromEnv({ ...base });
    expect(grader).toBeDefined();
    expect(grader!.provider.model).toBe("cheap-1");
    expect(grader!.maxCallsPerSession).toBe(20);
    expect(grader!.timeoutMs).toBe(8000);
  });

  it("błędna opcja pośrednika (UMIEM_GRADER_REASONING) zatrzymuje start zamiast cicho ją pominąć", () => {
    expect(() => graderFromEnv({ ...base, UMIEM_GRADER_REASONING: "turbo" })).toThrow(/UMIEM_GRADER_REASONING/);
    expect(() => sessionActivityFromEnv({ ...base, UMIEM_GRADER_PROVIDER_DATA_COLLECTION: "maybe" })).toThrow(/DATA_COLLECTION/);
    const openRouter = { ...base, UMIEM_GRADER_BASE_URL: "https://openrouter.ai/api/v1" };
    expect(graderFromEnv({ ...openRouter, UMIEM_GRADER_REASONING: "low", UMIEM_GRADER_PROVIDER_DATA_COLLECTION: "deny" })).toBeDefined();
    // Opcje OpenRouter dla innego endpointu też zatrzymują start (grader i ocena aktywności).
    expect(() => graderFromEnv({ ...base, UMIEM_GRADER_PROVIDER_DATA_COLLECTION: "deny" })).toThrow(/openrouter/);
    expect(() => sessionActivityFromEnv({ ...base, UMIEM_GRADER_REASONING: "off" })).toThrow(/openrouter/);
  });

  it("UMIEM_GRADER_TIMEOUT_MS i MAX_CALLS_PER_SESSION nadpisują domyślne", () => {
    const grader = graderFromEnv({ ...base, UMIEM_GRADER_TIMEOUT_MS: "3000", UMIEM_GRADER_MAX_CALLS_PER_SESSION: "5" });
    expect(grader!.timeoutMs).toBe(3000);
    expect(grader!.maxCallsPerSession).toBe(5);
  });

  it("wspólny OPENROUTER_API_KEY włącza gradera tylko na https OpenRouter", () => {
    const shared = { UMIEM_GRADER_BASE_URL: "https://openrouter.ai/api/v1", UMIEM_GRADER_MODEL: "cheap-1", OPENROUTER_API_KEY: "sk-or-v1-shared" };
    expect(graderFromEnv(shared)).toBeDefined();
    expect(sessionActivityFromEnv(shared)).toBeDefined();
    // innego hosta wspólny klucz nie dostaje — grader wyłączony
    expect(graderFromEnv({ ...shared, UMIEM_GRADER_BASE_URL: base.UMIEM_GRADER_BASE_URL })).toBeUndefined();
    expect(graderFromEnv({ ...shared, UMIEM_GRADER_BASE_URL: "http://openrouter.ai/api/v1" })).toBeUndefined();
  });

  it("klucz bez BASE_URL albo MODEL → błąd (częściowa konfiguracja)", () => {
    expect(() => graderFromEnv({ UMIEM_GRADER_API_KEY: "secret", UMIEM_GRADER_MODEL: "cheap-1" })).toThrow(/all of BASE_URL, API_KEY and MODEL/);
    expect(() => graderFromEnv({ UMIEM_GRADER_API_KEY: "secret", UMIEM_GRADER_BASE_URL: base.UMIEM_GRADER_BASE_URL })).toThrow(/all of BASE_URL, API_KEY and MODEL/);
  });

  it("BASE_URL i MODEL bez klucza → wyłączony (domyślna konfiguracja zawsze je uzupełnia)", () => {
    expect(graderFromEnv({ UMIEM_GRADER_BASE_URL: base.UMIEM_GRADER_BASE_URL, UMIEM_GRADER_MODEL: base.UMIEM_GRADER_MODEL })).toBeUndefined();
  });

  it("http:// odrzucone w produkcji", () => {
    expect(() => graderFromEnv({ ...base, UMIEM_GRADER_BASE_URL: "http://grader.example/v1", NODE_ENV: "production" })).toThrow();
  });

  it("http:// dozwolone poza produkcją (test/development)", () => {
    const grader = graderFromEnv({ ...base, UMIEM_GRADER_BASE_URL: "http://grader.example/v1", NODE_ENV: "development" });
    expect(grader).toBeDefined();
  });

  it("nieliczbowy albo niedodatni limit/timeout → błąd", () => {
    expect(() => graderFromEnv({ ...base, UMIEM_GRADER_TIMEOUT_MS: "nope" })).toThrow();
    expect(() => graderFromEnv({ ...base, UMIEM_GRADER_MAX_CALLS_PER_SESSION: "0" })).toThrow();
  });
});

describe("sessionActivityFromEnv", () => {
  const base = {
    UMIEM_GRADER_BASE_URL: "https://grader.example/v1",
    UMIEM_GRADER_API_KEY: "secret",
    UMIEM_GRADER_MODEL: "cheap-1",
  };

  it("bez konfiguracji gradera → undefined (ocena aktywności wyłączona)", () => {
    expect(sessionActivityFromEnv({})).toBeUndefined();
  });

  it("komplet UMIEM_GRADER_* → provider z domyślnym terminem 60 s", () => {
    const deps = sessionActivityFromEnv({ ...base });
    expect(deps).toBeDefined();
    expect(deps!.provider.model).toBe("cheap-1");
    expect(deps!.timeoutMs).toBe(60_000);
    expect(deps!.publicService).toBe("grader.example · cheap-1");
    expect(deps!.publicService).not.toContain("secret");
  });

  it("public service identity strips URL credentials, path and query", () => {
    const deps = sessionActivityFromEnv({
      ...base,
      UMIEM_GRADER_BASE_URL: "https://user:pass@grader.example:8443/v1?token=hidden",
    });
    expect(deps!.publicService).toBe("grader.example:8443 · cheap-1");
    expect(deps!.publicService).not.toContain("hidden");
    expect(deps!.publicService).not.toContain("pass");
  });

  it("częściowa konfiguracja → rzut (współdzielone zmienne gradera)", () => {
    expect(() => sessionActivityFromEnv({ UMIEM_GRADER_BASE_URL: base.UMIEM_GRADER_BASE_URL, UMIEM_GRADER_API_KEY: "k" })).toThrow();
  });

  it("http:// odrzucone w produkcji niezależnie od graderFromEnv; dozwolone w development", () => {
    expect(() => sessionActivityFromEnv({ ...base, UMIEM_GRADER_BASE_URL: "http://grader.example/v1", NODE_ENV: "production" }))
      .toThrow("UMIEM_GRADER_BASE_URL must use https:// outside test/development");
    expect(sessionActivityFromEnv({ ...base, UMIEM_GRADER_BASE_URL: "http://grader.example/v1", NODE_ENV: "development" })).toBeDefined();
  });

  it("pusty UMIEM_SESSION_ACTIVITY_TIMEOUT_MS → default 60000; własna wartość → użyta", () => {
    expect(sessionActivityFromEnv({ ...base, UMIEM_SESSION_ACTIVITY_TIMEOUT_MS: "" })!.timeoutMs).toBe(60_000);
    expect(sessionActivityFromEnv({ ...base, UMIEM_SESSION_ACTIVITY_TIMEOUT_MS: "45000" })!.timeoutMs).toBe(45_000);
    expect(() => sessionActivityFromEnv({ ...base, UMIEM_SESSION_ACTIVITY_TIMEOUT_MS: "-1" })).toThrow();
  });
});

describe("lessonSpeechFromEnv", () => {
  it("bez zmiennych lekcje nie mają dyktowania", () => {
    expect(lessonSpeechFromEnv({})).toBeUndefined();
  });

  it("adres i klucz dają STT z domyślnym modelem Scribe v2, nazwa publiczna bez sekretów", () => {
    const deps = lessonSpeechFromEnv({ UMIEM_LESSON_STT_BASE_URL: "https://openrouter.ai/api/v1", UMIEM_LESSON_STT_API_KEY: "sk-or-secret" });
    expect(deps?.stt.name).toBe(DEFAULT_LESSON_STT_MODEL);
    expect(deps?.publicService).toBe("elevenlabs/scribe-v2");
    expect(JSON.stringify(deps?.publicService)).not.toContain("sk-or");
  });

  it("model z env nadpisuje domyślny", () => {
    const deps = lessonSpeechFromEnv({
      UMIEM_LESSON_STT_BASE_URL: "https://openrouter.ai/api/v1", UMIEM_LESSON_STT_API_KEY: "k", UMIEM_LESSON_STT_MODEL: "mistralai/voxtral-small-transcribe-3-0",
    });
    expect(deps?.publicService).toBe("mistralai/voxtral-small-transcribe-3-0");
  });

  it("niepełna konfiguracja i http poza dev/test to błąd startu", () => {
    expect(() => lessonSpeechFromEnv({ UMIEM_LESSON_STT_API_KEY: "k" })).toThrow(/BASE_URL and API_KEY/);
    expect(() => lessonSpeechFromEnv({ UMIEM_LESSON_STT_BASE_URL: "http://stt.local/v1", UMIEM_LESSON_STT_API_KEY: "k" })).toThrow(/https/);
    expect(lessonSpeechFromEnv({ NODE_ENV: "test", UMIEM_LESSON_STT_BASE_URL: "http://stt.local/v1", UMIEM_LESSON_STT_API_KEY: "k" })).toBeDefined();
  });
});

describe("fabryki czatu — zapis kosztów (usage)", () => {
  const env = {
    UMIEM_GRADER_BASE_URL: "https://openrouter.ai/api/v1",
    UMIEM_GRADER_API_KEY: "secret",
    UMIEM_GRADER_MODEL: "google/gemini-3.8-flash",
  };
  const stubChat = () =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: "not json" } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } }),
      { status: 200 },
    )));
  afterEach(() => vi.unstubAllGlobals());

  it("factory passes usage to adapter (grader)", async () => {
    stubChat();
    const rec = createTestRecorder();
    const deps = graderFromEnv(env, rec)!;
    await deps.provider.grade({
      subjectTitle: "s", topicTitle: "t", roleProfile: { gradingRole: "r", almostDefinition: "a" }, instruction: "i", stimulus: "x",
      objective: { description: "d", errorCategories: [] }, acceptedAnswers: ["a"], childAnswer: "b",
    }, AbortSignal.timeout(1000)).catch(() => undefined);
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ feature: "answer_grading", operation: "grade", provider: "openrouter", outcome: "ok", providerCostUsd: 0.001 });
  });

  it("factory passes usage to adapter (session activity)", async () => {
    stubChat();
    const rec = createTestRecorder();
    const deps = sessionActivityFromEnv(env, rec)!;
    await deps.provider.review({ tasks: [] }, AbortSignal.timeout(1000)).catch(() => undefined);
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ feature: "session_activity_review", operation: "review", provider: "openrouter", outcome: "ok" });
  });
});
