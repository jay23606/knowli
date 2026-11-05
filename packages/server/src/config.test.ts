import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LESSON_STT_MODEL, agentGraderFromEnv, defaultMediaSettings, graderFromEnv, lessonAgentPublicFromEnv, lessonAgentSettingsFromEnv, lessonSpeechFromEnv, mediaSettingsFromEnv, reviewerFromEnv, reviewerPublicServiceFromEnv, sessionActivityFromEnv, speechFromEnv, ttsInstructionsFor, ttsVoiceFor } from "./config";
import { withConfigDefaults } from "./config-defaults";
import { createProductionSubjectRegistry } from "./domain/lessons/subjects";
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

describe("fabryki mowy — zapis kosztów (usage)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("factory passes usage to adapter (lessonSpeechFromEnv)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ text: "ok", usage: { seconds: 2, cost: 0.0001 } }), { status: 200 })));
    const rec = createTestRecorder();
    const deps = lessonSpeechFromEnv({ UMIEM_LESSON_STT_BASE_URL: "https://openrouter.ai/api/v1", UMIEM_LESSON_STT_API_KEY: "k" }, rec)!;
    await deps.stt.transcribe({ bytes: new Uint8Array([1]), mimeType: "audio/wav", locale: "pl-PL", durationMs: 2000 });
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ feature: "lesson_stt", provider: "openrouter", audioMs: 2000, providerCostUsd: 0.0001 });
  });

  it("factory passes usage to adapter (speechFromEnv: STT i wymowa)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ RecognitionStatus: "Success", DisplayText: "cat", NBest: [{ Confidence: 0.9, AccuracyScore: 80 }] }), { status: 200 })));
    const rec = createTestRecorder();
    const deps = speechFromEnv({ AZURE_SPEECH_KEY: "k", AZURE_SPEECH_REGION: "westeurope" }, rec)!;
    const audio = { bytes: new Uint8Array([1]), mimeType: "audio/webm", locale: "en-GB", durationMs: 1500 };
    await deps.stt.transcribe(audio);
    await deps.pronunciation.assess(audio, "cat");
    expect(rec.events.map((event) => [event.feature, event.provider, event.audioMs])).toEqual([
      ["speech_stt", "azure", 1500],
      ["pronunciation", "azure", 1500],
    ]);
  });
});

describe("reviewerFromEnv — krytyk lekcji", () => {
  const withKey = { UMIEM_REVIEWER_ENABLED: "true", OPENROUTER_API_KEY: "sk-or-v1-shared" };

  afterEach(() => vi.restoreAllMocks());

  it("domyślnie wyłączony, nawet z kluczem OpenRouter", () => {
    const result = reviewerFromEnv(withConfigDefaults({ OPENROUTER_API_KEY: "sk-or-v1-shared" }));
    expect(result.state).toBe("disabled");
    expect(result.provider).toBeUndefined();
    expect(result.policy).toEqual({ timeoutMs: 120_000, concurrency: 3, maxCallsPerRun: 12, phaseBudgetMs: 240_000 });
  });

  it("ENABLED=true + wspólny OPENROUTER_API_KEY → ready z domyślnym modelem Sonnet", () => {
    const result = reviewerFromEnv(withConfigDefaults(withKey));
    expect(result.state).toBe("ready");
    expect(result.provider!.model).toBe("anthropic/claude-sonnet-5.5");
  });

  it("ENABLED=true bez klucza → not_configured i ostrzeżenie", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = reviewerFromEnv(withConfigDefaults({ UMIEM_REVIEWER_ENABLED: "true" }));
    expect(result.state).toBe("not_configured");
    expect(result.provider).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain("UMIEM_REVIEWER");
  });

  it("ostrzeżenie not_configured nie zawiera żadnego klucza obecnego w env", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // wspólny klucz jest, ale adres obcy → klucz nie jest używany i nie może wyciec do logu
    const result = reviewerFromEnv(withConfigDefaults({
      ...withKey, UMIEM_REVIEWER_BASE_URL: "https://reviewer.example/v1",
    }));
    expect(result.state).toBe("not_configured");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls.flat().map(String).join(" ")).not.toContain("sk-or-v1-shared");
  });

  it("wyłączony krytyk nie czyta limitów: zbłąkana błędna liczba nie przerywa startu", () => {
    const result = reviewerFromEnv(withConfigDefaults({ UMIEM_REVIEWER_CONCURRENCY: "abc", UMIEM_REVIEWER_TIMEOUT_MS: "-1" }));
    expect(result.state).toBe("disabled");
    expect(result.policy).toEqual({ timeoutMs: 120_000, concurrency: 3, maxCallsPerRun: 12, phaseBudgetMs: 240_000 });
    expect(reviewerFromEnv({ UMIEM_REVIEWER_CONCURRENCY: "abc" }).state).toBe("disabled");
  });

  it("adres nie-OpenRouter bez własnego klucza → not_configured (wspólny klucz tam nie trafia)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = reviewerFromEnv(withConfigDefaults({ ...withKey, UMIEM_REVIEWER_BASE_URL: "https://reviewer.example/v1" }));
    expect(result.state).toBe("not_configured");
  });

  it("własny UMIEM_REVIEWER_API_KEY wygrywa i działa dla innego hosta oraz modelu", () => {
    const result = reviewerFromEnv(withConfigDefaults({
      UMIEM_REVIEWER_ENABLED: "true",
      UMIEM_REVIEWER_BASE_URL: "https://reviewer.example/v1",
      UMIEM_REVIEWER_API_KEY: "own-secret",
      UMIEM_REVIEWER_MODEL: "big-1",
      OPENROUTER_API_KEY: "sk-or-v1-shared",
    }));
    expect(result.state).toBe("ready");
    expect(result.provider!.model).toBe("big-1");
  });

  it("limity z env nadpisują domyślne; zła liczba zatrzymuje start", () => {
    const result = reviewerFromEnv(withConfigDefaults({
      ...withKey, UMIEM_REVIEWER_TIMEOUT_MS: "5000", UMIEM_REVIEWER_CONCURRENCY: "2",
      UMIEM_REVIEWER_MAX_CALLS_PER_RUN: "4", UMIEM_REVIEWER_PHASE_BUDGET_MS: "9000",
    }));
    expect(result.policy).toEqual({ timeoutMs: 5000, concurrency: 2, maxCallsPerRun: 4, phaseBudgetMs: 9000 });
    expect(() => reviewerFromEnv(withConfigDefaults({ ...withKey, UMIEM_REVIEWER_CONCURRENCY: "0" }))).toThrow(/UMIEM_REVIEWER_CONCURRENCY/);
  });

  it("błędna opcja pośrednika (UMIEM_REVIEWER_REASONING) zatrzymuje start", () => {
    expect(() => reviewerFromEnv(withConfigDefaults({ ...withKey, UMIEM_REVIEWER_REASONING: "turbo" }))).toThrow(/UMIEM_REVIEWER_REASONING/);
    expect(reviewerFromEnv(withConfigDefaults({ ...withKey, UMIEM_REVIEWER_REASONING: "low" })).state).toBe("ready");
    // bez withConfigDefaults: domyślny adres OpenRouter też dopuszcza opcje pośrednika
    expect(reviewerFromEnv({ ...withKey, UMIEM_REVIEWER_REASONING: "low" }).state).toBe("ready");
  });

  it("http poza test/development zatrzymuje start", () => {
    expect(() => reviewerFromEnv(withConfigDefaults({
      ...withKey, NODE_ENV: "production", UMIEM_REVIEWER_BASE_URL: "http://reviewer.example/v1", UMIEM_REVIEWER_API_KEY: "own-secret",
    }))).toThrow(/UMIEM_REVIEWER_BASE_URL/);
  });
});

describe("reviewerPublicServiceFromEnv", () => {
  it("ready → host · model, bez ścieżki i sekretów", () => {
    const env = withConfigDefaults({ UMIEM_REVIEWER_ENABLED: "true", OPENROUTER_API_KEY: "sk-or-v1-shared" });
    const label = reviewerPublicServiceFromEnv(env);
    expect(label).toBe("openrouter.ai · anthropic/claude-sonnet-5.5");
    expect(label).not.toContain("sk-or");
  });

  it("wyłączony, bez klucza albo zły adres → undefined (nie rzuca)", () => {
    expect(reviewerPublicServiceFromEnv(withConfigDefaults({ OPENROUTER_API_KEY: "sk-or-v1-shared" }))).toBeUndefined();
    expect(reviewerPublicServiceFromEnv(withConfigDefaults({ UMIEM_REVIEWER_ENABLED: "true" }))).toBeUndefined();
    expect(reviewerPublicServiceFromEnv(withConfigDefaults({
      UMIEM_REVIEWER_ENABLED: "true", NODE_ENV: "production", UMIEM_REVIEWER_BASE_URL: "http://x.example/v1", UMIEM_REVIEWER_API_KEY: "k",
    }))).toBeUndefined();
  });

  it("błędna opcja pośrednika → undefined, jak odrzucenie w reviewerFromEnv", () => {
    const env = withConfigDefaults({ UMIEM_REVIEWER_ENABLED: "true", OPENROUTER_API_KEY: "sk-or-v1-shared", UMIEM_REVIEWER_REASONING: "turbo" });
    expect(() => reviewerFromEnv(env)).toThrow(/UMIEM_REVIEWER_REASONING/);
    expect(reviewerPublicServiceFromEnv(env)).toBeUndefined();
  });

  it("błędny limit krytyka → undefined, jak odrzucenie w reviewerFromEnv", () => {
    const env = withConfigDefaults({ UMIEM_REVIEWER_ENABLED: "true", OPENROUTER_API_KEY: "sk-or-v1-shared", UMIEM_REVIEWER_CONCURRENCY: "abc" });
    expect(() => reviewerFromEnv(env)).toThrow(/UMIEM_REVIEWER_CONCURRENCY/);
    expect(reviewerPublicServiceFromEnv(env)).toBeUndefined();
  });

  it("tryb fake z ENABLED=true pokazuje fake, bez ENABLED nic", () => {
    expect(reviewerPublicServiceFromEnv({ UMIEM_FAKE_PROVIDERS: "1", UMIEM_REVIEWER_ENABLED: "true" })).toBe("fake-reviewer-1");
    expect(reviewerPublicServiceFromEnv({ UMIEM_FAKE_PROVIDERS: "1" })).toBeUndefined();
  });
});

describe("lessonAgentSettingsFromEnv", () => {
  const subjects = createProductionSubjectRegistry();
  const KEY = { OPENROUTER_API_KEY: "sk-or-v1-shared" };
  const agentSubject = () => subjects.listSubjects().find((s) => s.agentPolicy !== undefined)!;
  const base = (extra: Record<string, string | undefined> = {}) =>
    withConfigDefaults({ UMIEM_LESSON_AGENT_SUBJECTS: agentSubject().id, ...KEY, ...extra });
  const withoutPolicy = {
    getSubject: (id: string) => (id === "plain" ? { ...agentSubject(), id: "plain", agentPolicy: undefined } : subjects.getSubject(id)),
  };

  afterEach(() => vi.restoreAllMocks());

  it("pusta lista → undefined, bez ostrzeżenia i bez czytania reszty", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(lessonAgentSettingsFromEnv(withConfigDefaults(KEY), subjects)).toBeUndefined();
    expect(lessonAgentSettingsFromEnv({ UMIEM_LESSON_AGENT_SUBJECTS: " , ", UMIEM_LESSON_AGENT_MAX_STEPS: "abc" }, subjects)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("lista bez klucza → undefined i jedno ostrzeżenie", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = withConfigDefaults({ UMIEM_LESSON_AGENT_SUBJECTS: agentSubject().id });
    expect(lessonAgentSettingsFromEnv(env, subjects)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[config] UMIEM_LESSON_AGENT_SUBJECTS bez klucza OpenRouter — lekcje generuje potok");
  });

  it("wartości domyślne, lista bez duplikatów i polityka z env", () => {
    const id = agentSubject().id;
    const settings = lessonAgentSettingsFromEnv(base({ UMIEM_LESSON_AGENT_SUBJECTS: ` ${id}, ${id},` }), subjects)!;
    expect(settings.subjects).toEqual(new Set([id]));
    expect(settings).toMatchObject({
      apiKey: "sk-or-v1-shared", model: "google/gemini-3.8-flash", effort: "low",
      checkerModel: "deepseek/deepseek-v4.1-flash-1017", checkerEffort: "low",
      provider: { require_parameters: true }, checkerProvider: { require_parameters: true },
    });
    expect(settings.policy).toEqual({
      maxStepsPerObjective: 8, planMaxSteps: 8, concurrency: 4, checkerConcurrency: 4,
      objectiveTimeoutMs: 300_000, checkerTimeoutMs: 90_000, runBudgetUsd: 1,
    });
    const tuned = lessonAgentSettingsFromEnv(base({
      UMIEM_LESSON_AGENT_MAX_STEPS: "5", UMIEM_LESSON_AGENT_CONCURRENCY: "2", UMIEM_LESSON_AGENT_RUN_BUDGET_USD: "0.25",
    }), subjects)!;
    expect(tuned.policy).toMatchObject({ maxStepsPerObjective: 5, planMaxSteps: 5, concurrency: 2, runBudgetUsd: 0.25 });
  });

  it("działa na surowym env, bez withConfigDefaults", () => {
    const id = agentSubject().id;
    expect(lessonAgentSettingsFromEnv({ UMIEM_LESSON_AGENT_SUBJECTS: id, ...KEY }, subjects)?.model).toBe("google/gemini-3.8-flash");
  });

  it("klucz: własny klucz agenta wygrywa nad wspólnym", () => {
    expect(lessonAgentSettingsFromEnv(base({ UMIEM_LESSON_AGENT_API_KEY: "sk-or-v1-agent" }), subjects)?.apiKey).toBe("sk-or-v1-agent");
  });

  it("nieznany przedmiot i przedmiot bez polityki to błąd startu z nazwą zmiennej", () => {
    expect(() => lessonAgentSettingsFromEnv(base({ UMIEM_LESSON_AGENT_SUBJECTS: `${agentSubject().id},nie_ma_takiego` }), subjects))
      .toThrow(/UMIEM_LESSON_AGENT_SUBJECTS.*nie_ma_takiego/);
    expect(() => lessonAgentSettingsFromEnv(base({ UMIEM_LESSON_AGENT_SUBJECTS: "plain" }), withoutPolicy))
      .toThrow(/UMIEM_LESSON_AGENT_SUBJECTS.*plain.*no agent policy/);
  });

  it("błędna liczba, wysiłek albo budżet to błąd z nazwą zmiennej", () => {
    expect(() => lessonAgentSettingsFromEnv(base({ UMIEM_LESSON_AGENT_MAX_STEPS: "abc" }), subjects)).toThrow(/UMIEM_LESSON_AGENT_MAX_STEPS/);
    expect(() => lessonAgentSettingsFromEnv(base({ UMIEM_LESSON_AGENT_CONCURRENCY: "0" }), subjects)).toThrow(/UMIEM_LESSON_AGENT_CONCURRENCY/);
    expect(() => lessonAgentSettingsFromEnv(base({ UMIEM_LESSON_AGENT_RUN_BUDGET_USD: "-1" }), subjects)).toThrow(/UMIEM_LESSON_AGENT_RUN_BUDGET_USD/);
    expect(() => lessonAgentSettingsFromEnv(base({ UMIEM_LESSON_AGENT_REASONING: "turbo" }), subjects)).toThrow(/UMIEM_LESSON_AGENT_REASONING/);
    expect(() => lessonAgentSettingsFromEnv(base({ UMIEM_LESSON_AGENT_CHECKER_REASONING: "max" }), subjects))
      .toThrow(/UMIEM_LESSON_AGENT_CHECKER_REASONING/);
  });

  it("generator i checker z tej samej rodziny to błąd z nazwą zmiennej checkera", () => {
    expect(() => lessonAgentSettingsFromEnv(base({ UMIEM_LESSON_AGENT_CHECKER_MODEL: "google/gemini-3.8-pro" }), subjects))
      .toThrow(/UMIEM_LESSON_AGENT_CHECKER_MODEL/);
  });

  it("błędna wartość jest odrzucana także bez klucza (walidacja przed kluczem)", () => {
    const env = withConfigDefaults({ UMIEM_LESSON_AGENT_SUBJECTS: agentSubject().id, UMIEM_LESSON_AGENT_MAX_STEPS: "abc" });
    expect(() => lessonAgentSettingsFromEnv(env, subjects)).toThrow(/UMIEM_LESSON_AGENT_MAX_STEPS/);
  });

  it("routing: własne ORDER, odziedziczone DATA_COLLECTION, require_parameters przy wysiłku ≠ none", () => {
    const settings = lessonAgentSettingsFromEnv(base({
      UMIEM_LESSON_AGENT_PROVIDER_ORDER: "Together",
      UMIEM_LLM_PROVIDER_DATA_COLLECTION: "deny",
      UMIEM_LLM_PROVIDER_ORDER: "Nebius",
    }), subjects)!;
    expect(settings.provider).toEqual({ order: ["Together"], data_collection: "deny", require_parameters: true });
    expect(settings.checkerProvider).toEqual({ order: ["Nebius"], data_collection: "deny", require_parameters: true });
  });

  it("routing: wysiłek none nie dokłada require_parameters, a bez routingu provider znika", () => {
    const none = lessonAgentSettingsFromEnv(base({
      UMIEM_LESSON_AGENT_REASONING: "none", UMIEM_LESSON_AGENT_CHECKER_REASONING: "none", UMIEM_LLM_PROVIDER_DATA_COLLECTION: "deny",
    }), subjects)!;
    expect(none.provider).toEqual({ data_collection: "deny" });
    const bare = lessonAgentSettingsFromEnv(base({ UMIEM_LESSON_AGENT_REASONING: "none", UMIEM_LESSON_AGENT_CHECKER_REASONING: "none" }), subjects)!;
    expect(bare).not.toHaveProperty("provider");
    expect(bare).not.toHaveProperty("checkerProvider");
  });

  it("brak UMIEM_LESSON_AGENT_BASE_URL (i UMIEM_LLM_BASE_URL na innym hoście) nie rzuca", () => {
    expect(() => lessonAgentSettingsFromEnv(base({ UMIEM_LLM_BASE_URL: "https://api.openai.com/v1", UMIEM_LLM_PROVIDER_ORDER: "Nebius" }), subjects))
      .not.toThrow();
  });
});

describe("lessonAgentPublicFromEnv", () => {
  const subjects = createProductionSubjectRegistry();
  const id = subjects.listSubjects().find((s) => s.agentPolicy !== undefined)!.id;

  it("nazwy usług bez klucza (obecność zależy od listy)", () => {
    expect(lessonAgentPublicFromEnv(withConfigDefaults({ UMIEM_LESSON_AGENT_SUBJECTS: id }), subjects)).toEqual({
      subjects: new Set([id]),
      generationService: "openrouter.ai · google/gemini-3.8-flash",
      checkService: "openrouter.ai · deepseek/deepseek-v4.1-flash-1017",
    });
    expect(lessonAgentPublicFromEnv({ UMIEM_LESSON_AGENT_SUBJECTS: id, UMIEM_LESSON_AGENT_MODEL: "x/y" }, subjects)?.generationService)
      .toBe("openrouter.ai · x/y");
  });

  it("pusta lista → undefined; nieznane i bez polityki pomijane bez wyjątku", () => {
    expect(lessonAgentPublicFromEnv(withConfigDefaults({}), subjects)).toBeUndefined();
    expect(lessonAgentPublicFromEnv({ UMIEM_LESSON_AGENT_SUBJECTS: "nie_ma_takiego" }, subjects)).toBeUndefined();
    const plain = {
      getSubject: (x: string) => (x === "plain" ? { ...subjects.getSubject(id)!, id: "plain", agentPolicy: undefined } : subjects.getSubject(x)),
    };
    expect(lessonAgentPublicFromEnv({ UMIEM_LESSON_AGENT_SUBJECTS: `plain,nie_ma_takiego,${id}` }, plain)?.subjects).toEqual(new Set([id]));
  });

  it("nie rzuca na błędnych liczbach i wysiłkach", () => {
    const env = withConfigDefaults({ UMIEM_LESSON_AGENT_SUBJECTS: id, UMIEM_LESSON_AGENT_MAX_STEPS: "abc", UMIEM_LESSON_AGENT_REASONING: "turbo" });
    expect(() => lessonAgentPublicFromEnv(env, subjects)).not.toThrow();
  });

  it("tryb fake pokazuje nazwy fake", () => {
    expect(lessonAgentPublicFromEnv({ UMIEM_FAKE_PROVIDERS: "1", UMIEM_LESSON_AGENT_SUBJECTS: id }, subjects)).toMatchObject({
      generationService: "fake-lesson-agent-model", checkService: "fake-lesson-checker-model",
    });
    expect(lessonAgentPublicFromEnv({ UMIEM_FAKE_PROVIDERS: "1" }, subjects)).toBeUndefined();
  });

  describe("openCheckService (usługa oceny odpowiedzi próbnych)", () => {
    const grader = { UMIEM_GRADER_BASE_URL: "https://openrouter.ai/api/v1", UMIEM_GRADER_MODEL: "cheap-1", UMIEM_GRADER_API_KEY: "secret" };

    it("z graderem: host · model, bez klucza", () => {
      const result = lessonAgentPublicFromEnv({ UMIEM_LESSON_AGENT_SUBJECTS: id, ...grader }, subjects);
      expect(result?.openCheckService).toBe("openrouter.ai · cheap-1");
      expect(JSON.stringify(result)).not.toContain("secret");
    });

    it("wspólny OPENROUTER_API_KEY też włącza pole", () => {
      const env = { UMIEM_LESSON_AGENT_SUBJECTS: id, UMIEM_GRADER_BASE_URL: grader.UMIEM_GRADER_BASE_URL, UMIEM_GRADER_MODEL: "m/1", OPENROUTER_API_KEY: "sk-or-v1-x" };
      expect(lessonAgentPublicFromEnv(env, subjects)?.openCheckService).toBe("openrouter.ai · m/1");
    });

    it("bez gradera → brak pola", () => {
      expect(lessonAgentPublicFromEnv({ UMIEM_LESSON_AGENT_SUBJECTS: id }, subjects)).not.toHaveProperty("openCheckService");
    });

    it("niepełna konfiguracja gradera → brak pola i bez wyjątku", () => {
      const env = { UMIEM_LESSON_AGENT_SUBJECTS: id, UMIEM_GRADER_API_KEY: "secret", UMIEM_GRADER_MODEL: "cheap-1" };
      let result: ReturnType<typeof lessonAgentPublicFromEnv>;
      expect(() => { result = lessonAgentPublicFromEnv(env, subjects); }).not.toThrow();
      expect(result!).toBeDefined();
      expect(result!).not.toHaveProperty("openCheckService");
    });

    it("tryb fake → brak pola", () => {
      expect(lessonAgentPublicFromEnv({ UMIEM_FAKE_PROVIDERS: "1", UMIEM_LESSON_AGENT_SUBJECTS: id, ...grader }, subjects))
        .not.toHaveProperty("openCheckService");
    });
  });
});

describe("agentGraderFromEnv", () => {
  const base = {
    UMIEM_GRADER_BASE_URL: "https://grader.example/v1",
    UMIEM_GRADER_API_KEY: "secret",
    UMIEM_GRADER_MODEL: "cheap-1",
  };

  it("pełna konfiguracja → provider i domyślny timeout 8000", () => {
    const deps = agentGraderFromEnv({ ...base });
    expect(deps?.timeoutMs).toBe(8000);
    expect(deps?.provider.model).toBe("cheap-1");
  });

  it("UMIEM_GRADER_TIMEOUT_MS nadpisuje timeout", () => {
    expect(agentGraderFromEnv({ ...base, UMIEM_GRADER_TIMEOUT_MS: "1234" })?.timeoutMs).toBe(1234);
  });

  it("brak klucza → undefined", () => {
    expect(agentGraderFromEnv({ UMIEM_GRADER_BASE_URL: base.UMIEM_GRADER_BASE_URL, UMIEM_GRADER_MODEL: base.UMIEM_GRADER_MODEL })).toBeUndefined();
    expect(agentGraderFromEnv({})).toBeUndefined();
  });

  it("klucz bez MODEL → ten sam błąd co graderFromEnv", () => {
    const env = { UMIEM_GRADER_API_KEY: "secret", UMIEM_GRADER_BASE_URL: base.UMIEM_GRADER_BASE_URL };
    expect(() => agentGraderFromEnv(env)).toThrow(/all of BASE_URL, API_KEY and MODEL/);
    expect(() => graderFromEnv(env)).toThrow(/all of BASE_URL, API_KEY and MODEL/);
  });

  it("adapter zapisuje zdarzenia z etykietą lesson_generation/check_grade", async () => {
    const events: { feature: string; operation?: string }[] = [];
    const usage = { record: (event: { feature: string; operation?: string }) => { events.push(event); }, flush: async () => {} };
    const deps = agentGraderFromEnv({ ...base }, usage as never)!;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("x", { status: 500 })) as typeof fetch;
    try {
      await expect(deps.provider.grade({
        subjectTitle: "s", topicTitle: "t", roleProfile: { gradingRole: "g", almostDefinition: "a" },
        instruction: "i", stimulus: null, objective: { description: "d", errorCategories: [] },
        acceptedAnswers: ["a"], childAnswer: "x",
      }, AbortSignal.timeout(1000))).rejects.toThrow();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(events).toEqual([expect.objectContaining({ feature: "lesson_generation", operation: "check_grade" })]);
  });
});
