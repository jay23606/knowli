import { isOpenRouterEndpoint } from "./providers/chat-request-options";

/**
 * Domyślna konfiguracja Umiem! (design `2026-11-01-config-defaults-design.md`).
 *
 * Jedno miejsce z wybraną konfiguracją providerów i limitów; `.env` instancji
 * tylko ją nadpisuje. Bez sekretów: klucze (`OPENAI_API_KEY`,
 * `OPENROUTER_API_KEY`, `AZURE_SPEECH_KEY`…) zawsze pochodzą z `.env`.
 *
 * Web i worker składają zależności z `withConfigDefaults(process.env)` — ten
 * sam kod i te same wartości, więc fingerprinty mediów się zgadzają. Wartości
 * awaryjne w parserach (`defaultMediaSettings`, `DEFAULT_*`) dotyczą wyłącznie
 * wywołań bez tej funkcji (testy jednostkowe).
 */
export const CONFIG_DEFAULTS = {
  // ── TTS: OpenRouter, Gemini 3.8 Flash TTS, głos Kore (decyzja 2026-10-30) ──
  // Gemini na OpenRouter zwraca wyłącznie PCM, opakowywane w WAV.
  UMIEM_TTS_PROVIDER: "openrouter",
  UMIEM_TTS_MODEL: "google/gemini-3.8-flash-tts",
  UMIEM_TTS_VOICE: "Kore",
  UMIEM_TTS_FORMAT: "wav",
  UMIEM_TTS_BASE_URL: "https://openrouter.ai/api/v1",
  // Instrukcja wymowy per locale (osobne pole, nie jest czytana): bez niej model
  // wielojęzyczny czyta pojedyncze polskie słowa po angielsku.
  UMIEM_TTS_INSTRUCTIONS_PL_PL: "Mów po polsku, z polską wymową.",
  UMIEM_TTS_INSTRUCTIONS_EN_GB: "Speak British English with a clear, natural British (Received Pronunciation) accent.",
  // Ton lektora (komunikaty Kid UI, pytania i karty lekcji); `none` wyłącza.
  UMIEM_TTS_STYLE: "instructions",

  // ── Generator materiału (worker): Gemini 3.8 Flash przez OpenRouter ──
  UMIEM_LLM_MODEL: "google/gemini-3.8-flash",
  UMIEM_LLM_BASE_URL: "https://openrouter.ai/api/v1",

  // ── Grader i ocena aktywności sesji (web) ──
  // Połączenie i limity; włączony z UMIEM_GRADER_API_KEY albo wspólnym
  // OPENROUTER_API_KEY. Prywatność odpowiedzi dzieci ustawia się w OpenRouter
  // albo przez UMIEM_GRADER_PROVIDER_DATA_COLLECTION=deny.
  UMIEM_GRADER_BASE_URL: "https://openrouter.ai/api/v1",
  UMIEM_GRADER_MODEL: "google/gemini-3.8-flash",
  UMIEM_GRADER_TIMEOUT_MS: "8000",
  UMIEM_GRADER_MAX_CALLS_PER_SESSION: "20",
  UMIEM_SESSION_ACTIVITY_TIMEOUT_MS: "60000",

  // ── Krytyk lekcji (worker): przegląd świeżych ćwiczeń po walidacji ──
  // Domyślnie wyłączony; włączony z UMIEM_REVIEWER_API_KEY albo wspólnym
  // OPENROUTER_API_KEY (tylko https OpenRouter). Do modelu trafia wyłącznie
  // materiał rodzica i ćwiczenia — bez danych dziecka. Rozumowanie
  // (UMIEM_REVIEWER_REASONING) zostaje nieustawione.
  UMIEM_REVIEWER_ENABLED: "false",
  UMIEM_REVIEWER_BASE_URL: "https://openrouter.ai/api/v1",
  UMIEM_REVIEWER_MODEL: "anthropic/claude-sonnet-5.5",
  UMIEM_REVIEWER_TIMEOUT_MS: "120000",
  UMIEM_REVIEWER_CONCURRENCY: "3",
  UMIEM_REVIEWER_MAX_OUTPUT_TOKENS: "6000",
  UMIEM_REVIEWER_MAX_CALLS_PER_RUN: "12",
  // Budżet fazy krytyka; razem z limitem przebiegu generacji musi mieścić się
  // w WORKER_HEALTH_STALE_MS (pilnuje apps/worker/src/loop.test.ts).
  UMIEM_REVIEWER_PHASE_BUDGET_MS: "240000",

  // ── Obrazy (OpenAI, klucz OPENAI_API_KEY) ──
  UMIEM_IMAGE_PROVIDER: "openai",
  UMIEM_IMAGE_MODEL: "gpt-image-2.5-sunburst",
  UMIEM_IMAGE_SIZE: "1024x1024",
  UMIEM_IMAGE_QUALITY: "low",
  UMIEM_IMAGE_FORMAT: "webp",

  // ── Stawki kosztów (USD; `none` wyłącza → koszt `unknown`) ──
  // Azure Speech, standard real-time (STT) i pronunciation assessment (przyjęto
  // rozliczenie jak standardowe STT). Przybliżenie ok. 1 USD za godzinę audio, stawka
  // zależna od regionu. Sprawdzano 2026-11-02, bez potwierdzenia w oficjalnym cenniku;
  // do weryfikacji: https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/
  UMIEM_PRICE_AZURE_STT_USD_PER_HOUR: "1",
  UMIEM_PRICE_AZURE_PRONUNCIATION_USD_PER_HOUR: "1",

  // ── Generacja lekcji (worker) ──
  UMIEM_LESSON_GENERATION_REQUEST_TIMEOUT_MS: "90000",
  UMIEM_LESSON_GENERATION_RUN_TIMEOUT_MS: "600000",
  UMIEM_LESSON_GENERATION_CANCEL_POLL_MS: "1000",

  // ── Agent puli lekcji (worker; etap 2 #237) ──
  // Lista przedmiotów generowanych agentem (identyfikatory po przecinku); pusta =
  // wszystkie lekcje generuje potok. Adapter mówi wyłącznie z OpenRouter; routing
  // dostawcy `UMIEM_LESSON_AGENT[_CHECKER]_PROVIDER_*` dziedziczy `UMIEM_LLM_PROVIDER_*`.
  // Klucz: UMIEM_LESSON_AGENT_API_KEY → OPENROUTER_API_KEY → UMIEM_LLM_API_KEY (nie tutaj).
  UMIEM_LESSON_AGENT_SUBJECTS: "",
  UMIEM_LESSON_AGENT_MODEL: "google/gemini-3.8-flash",
  UMIEM_LESSON_AGENT_REASONING: "low",
  UMIEM_LESSON_AGENT_CHECKER_MODEL: "deepseek/deepseek-v4.1-flash-1017",
  UMIEM_LESSON_AGENT_CHECKER_REASONING: "low",
  UMIEM_LESSON_AGENT_MAX_STEPS: "8",
  UMIEM_LESSON_AGENT_CONCURRENCY: "4",
  UMIEM_LESSON_AGENT_CHECKER_CONCURRENCY: "4",
  UMIEM_LESSON_AGENT_OBJECTIVE_TIMEOUT_MS: "300000",
  UMIEM_LESSON_AGENT_CHECKER_TIMEOUT_MS: "90000",
  UMIEM_LESSON_AGENT_RUN_BUDGET_USD: "1.00",

  // ── Worker ──
  WORKER_POLL_MS: "2000",
  WORKER_HEALTH_STALE_MS: "900000",
} as const satisfies Record<string, string>;

/**
 * Domyślne zależne od efektywnej konfiguracji: opcje pośrednika OpenRouter
 * tylko przy endpoincie OpenRouter (przy innym `chatRequestExtrasFromEnv`
 * odrzuca je błędem startu) i domyślnym modelu (inny model może nie obsługiwać
 * rozumowania, a opcje wymuszają dostawców z tym parametrem). Warunek widzi env
 * po nadpisaniach i domyślnych.
 */
const CONDITIONAL_DEFAULTS: readonly { name: string; value: string; when: (env: Record<string, string | undefined>) => boolean }[] = [
  {
    name: "UMIEM_LLM_REASONING",
    value: "low",
    when: (env) => isOpenRouterEndpoint(env.UMIEM_LLM_BASE_URL) && env.UMIEM_LLM_MODEL === CONFIG_DEFAULTS.UMIEM_LLM_MODEL,
  },
  {
    name: "UMIEM_GRADER_REASONING",
    value: "low",
    when: (env) => isOpenRouterEndpoint(env.UMIEM_GRADER_BASE_URL) && env.UMIEM_GRADER_MODEL === CONFIG_DEFAULTS.UMIEM_GRADER_MODEL,
  },
  // Stawka obrazu dotyczy tylko domyślnego modelu, jakości i rozmiaru; po zmianie
  // obrazu bez własnej stawki koszty obrazów są `unknown`, a nie liczone starą.
  // gpt-image jest prawdopodobnie naliczany per token, więc stała stawka za obraz
  // to przybliżenie. Sprawdzano 2026-11-02, bez potwierdzenia w oficjalnym cenniku;
  // do weryfikacji: https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst
  {
    name: "UMIEM_PRICE_IMAGE_USD",
    value: "0.006",
    when: (env) =>
      env.UMIEM_IMAGE_MODEL === CONFIG_DEFAULTS.UMIEM_IMAGE_MODEL &&
      env.UMIEM_IMAGE_QUALITY === CONFIG_DEFAULTS.UMIEM_IMAGE_QUALITY &&
      env.UMIEM_IMAGE_SIZE === CONFIG_DEFAULTS.UMIEM_IMAGE_SIZE,
  },
  // TTS OpenRouter nie zwraca kosztu. Rozliczenie jest prawdopodobnie tokenowe, więc
  // stawka za minutę to przybliżenie. Sprawdzano 2026-11-02, bez potwierdzenia
  // w oficjalnym cenniku; do weryfikacji: https://openrouter.ai/google/gemini-3.8-flash-tts
  {
    name: "UMIEM_PRICE_TTS_USD_PER_MINUTE",
    value: "0.0135",
    when: (env) => env.UMIEM_TTS_MODEL === CONFIG_DEFAULTS.UMIEM_TTS_MODEL,
  },
];

/**
 * Env procesu z domyślną konfiguracją pod spodem: niepusta wartość z `env`
 * wygrywa, pusta (`X=`) znaczy „nie ustawiono”. Nowy obiekt — `process.env`
 * zostaje nietknięty.
 */
export function withConfigDefaults(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = { ...env };
  for (const [name, value] of Object.entries(CONFIG_DEFAULTS)) {
    if (!result[name]) result[name] = value;
  }
  for (const { name, value, when } of CONDITIONAL_DEFAULTS) {
    if (!result[name] && when(result)) result[name] = value;
  }
  return result;
}
