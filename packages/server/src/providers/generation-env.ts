import type { GenerationDeps } from "../config";
import { fakeGenerationDeps } from "./fake";
import { createLocalMediaStore } from "./media/local";
import { createOpenAiImageProvider } from "./images/openai";
import { createOpenAiLlmProvider, DEFAULT_BASE_URL as LLM_DEFAULT_BASE_URL, DEFAULT_MODEL as LLM_DEFAULT_MODEL } from "./openai/llm";
import { chatRequestExtrasFromEnv } from "./chat-request-options";
import { createOpenAiTtsProvider } from "./openai/tts";
import { endpointKeyFromEnv, isOpenRouterKey, isSecureOpenRouterEndpoint } from "./openrouter-key";
import { graderConfigured } from "../config";
import type { UsageRecorder } from "../ports/usage";
import { lessonGenerationPolicyFromEnv } from "../modules/materials/lessons/lesson-generation-policy";

function nonEmpty(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

/** BASE_URL dostaje klucz w nagłówku Authorization: poza test/development tylko `https://`. */
function secureBaseUrl(env: Record<string, string | undefined>, name: "UMIEM_LLM_BASE_URL" | "UMIEM_TTS_BASE_URL"): string | undefined {
  const baseUrl = nonEmpty(env[name]);
  if (baseUrl === undefined) return undefined;
  const nodeEnv = env.NODE_ENV ?? "production";
  const insecureAllowed = nodeEnv === "test" || nodeEnv === "development";
  if (!baseUrl.startsWith("https://") && !(insecureAllowed && baseUrl.startsWith("http://"))) {
    throw new Error(`${name} must use https:// outside test/development`);
  }
  return baseUrl;
}

const OPENAI_HOST = "api.openai.com";

/**
 * `OPENAI_API_KEY` trafia zawsze do api.openai.com (obrazy; zapas LLM i TTS),
 * więc klucz OpenRouter w nim to błąd startu, a nie wysłanie go do OpenAI.
 */
function openAiKeyFromEnv(env: Record<string, string | undefined>): string | undefined {
  const key = nonEmpty(env.OPENAI_API_KEY);
  if (key !== undefined && isOpenRouterKey(key)) {
    throw new Error(
      "OPENAI_API_KEY holds an OpenRouter key; use UMIEM_LLM_API_KEY/UMIEM_TTS_API_KEY with their BASE_URL (the key is never sent to api.openai.com)",
    );
  }
  return key;
}

function isOpenAiEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && url.hostname.toLowerCase() === OPENAI_HOST;
  } catch {
    return false;
  }
}

/**
 * Endpoint i klucz usługi zgodnej z OpenAI (LLM materiału, TTS). Wspólna reguła:
 * - `<P>_BASE_URL` innego hosta niż api.openai.com wymaga własnego `<P>_API_KEY`
 *   — `OPENAI_API_KEY` nigdy nie trafia do innego hosta;
 * - klucz dostawcy innego niż OpenAI (`UMIEM_TTS_PROVIDER` inny niż `openai`
 *   albo klucz OpenRouter `sk-or-…`) wymaga BASE_URL innego hosta niż
 *   api.openai.com — nie trafia do OpenAI.
 * Bez BASE_URL: api.openai.com z `<P>_API_KEY` albo `OPENAI_API_KEY`.
 * Komunikaty błędów podają wyłącznie nazwy zmiennych, nigdy wartości.
 */
function openAiCompatibleEndpointFromEnv(
  env: Record<string, string | undefined>,
  prefix: "UMIEM_LLM" | "UMIEM_TTS",
  openAiKey: string,
): { apiKey: string; baseUrl?: string } {
  const baseUrl = secureBaseUrl(env, `${prefix}_BASE_URL`);
  // Własny klucz albo wspólny OPENROUTER_API_KEY (tylko https OpenRouter).
  const ownKey = endpointKeyFromEnv(env, prefix, baseUrl);
  const towardOpenAi = baseUrl === undefined || isOpenAiEndpoint(baseUrl);
  // Jawny powrót TTS na OpenAI przy domyślnym BASE_URL OpenRouter poszedłby po
  // cichu do OpenRouter z fingerprintem „openai” — wymagamy kompletu nadpisań.
  if (prefix === "UMIEM_TTS" && nonEmpty(env.UMIEM_TTS_PROVIDER) === "openai" && !towardOpenAi) {
    throw new Error("UMIEM_TTS_PROVIDER=openai requires UMIEM_TTS_BASE_URL=https://api.openai.com/v1 (and an OpenAI UMIEM_TTS_MODEL/VOICE/FORMAT, see .env.example)");
  }
  if (!towardOpenAi && ownKey === undefined) {
    // wspólny klucz podpowiadamy tylko tam, gdzie zostałby użyty
    const keys = isSecureOpenRouterEndpoint(baseUrl) ? `${prefix}_API_KEY or OPENROUTER_API_KEY` : `${prefix}_API_KEY`;
    throw new Error(`${prefix}_BASE_URL requires ${keys} (OPENAI_API_KEY is never sent to another endpoint)`);
  }
  // Klucz innego dostawcy (np. OpenRouter) bez jego BASE_URL poszedłby do api.openai.com.
  const declaredProvider = prefix === "UMIEM_TTS" ? (nonEmpty(env.UMIEM_TTS_PROVIDER) ?? "openai") : "openai";
  const provider = declaredProvider === "openai" && ownKey !== undefined && isOpenRouterKey(ownKey) ? "openrouter" : declaredProvider;
  if (towardOpenAi && ownKey !== undefined && provider !== "openai") {
    throw new Error(`${prefix}_API_KEY for provider "${provider}" requires ${prefix}_BASE_URL (the key is never sent to api.openai.com)`);
  }
  return { apiKey: ownKey ?? openAiKey, ...(baseUrl === undefined ? {} : { baseUrl }) };
}

/**
 * Czytelna nazwa usługi, do której trafiają materiał i prośby o generację
 * (`host · model`), dla panelu rodzica. Host i model liczone tak samo jak w
 * {@link createGenerationDepsFromEnv}: puste `UMIEM_LLM_*` to domyślne adaptera,
 * tryb fake nie wychodzi do sieci. Bez ścieżki adresu, kluczy i parametrów.
 *
 * To tylko opis: zły adres (http poza test/development, adres uszkodzony) nie
 * może wywrócić składania procesu web, więc zwraca `undefined` (panel pomija
 * informację). Błąd konfiguracji zgłasza i tak worker przy starcie generacji.
 */
export function generationPublicServiceFromEnv(env: Record<string, string | undefined>): string | undefined {
  if (env.UMIEM_FAKE_PROVIDERS === "1") return "fake-llm-1";
  try {
    const baseUrl = secureBaseUrl(env, "UMIEM_LLM_BASE_URL") ?? LLM_DEFAULT_BASE_URL;
    return `${new URL(baseUrl).host} · ${nonEmpty(env.UMIEM_LLM_MODEL) ?? LLM_DEFAULT_MODEL}`;
  } catch {
    return undefined;
  }
}

/** Opcjonalny provider obrazów dla procesu web; nie wymaga LLM ani TTS. */
export function imageProviderFromEnv(
  env: Record<string, string | undefined>,
  usage?: UsageRecorder,
  feature?: "illustration" | "deck_cover",
) {
  if (env.UMIEM_FAKE_PROVIDERS === "1") return fakeGenerationDeps(createLocalMediaStore(env.MEDIA_ROOT ?? "./data/media")).image;
  const apiKey = openAiKeyFromEnv(env);
  return apiKey
    ? createOpenAiImageProvider({ apiKey, ...(usage ? { usage } : {}), ...(feature ? { feature } : {}) })
    : undefined;
}

/**
 * Opóźnienie fake'owej generacji lekcji (tryb `UMIEM_FAKE_PROVIDERS=1`):
 * `UMIEM_FAKE_LESSON_DELAY_MS`, inaczej `UMIEM_FAKE_DELAY_MS`; wartość nieliczbowa → 0.
 * Wspólne dla fake LLM (etap zagadnień szkoły i historyjka) i fake agenta puli (`providers/lesson-agent-env.ts`).
 */
export function fakeLessonDelayMsFromEnv(env: Record<string, string | undefined>): number {
  const delayMs = Number(env.UMIEM_FAKE_LESSON_DELAY_MS ?? env.UMIEM_FAKE_DELAY_MS ?? 0);
  return Number.isFinite(delayMs) ? delayMs : 0;
}

/**
 * Składanie zależności generacji ze zmiennych środowiskowych (worker, E2E):
 * UMIEM_FAKE_PROVIDERS=1 wyłącza sieciowe adaptery; bez klucza API wynik jest
 * undefined i proces wykonawczy nie wystartuje. Nazwy providerów w env muszą
 * zgadzać się z faktycznymi adapterami, bo wchodzą do fingerprintów mediów.
 *
 * LLM (materiał: zestawy słówek, etap zagadnień szkoły i historyjka lekcji; same ćwiczenia lekcji pisze agent puli, `lesson-agent-env.ts`) konfigurują opcjonalne,
 * niezależne `UMIEM_LLM_MODEL`/`UMIEM_LLM_BASE_URL`/`UMIEM_LLM_API_KEY` z
 * fallbackami do wartości domyślnych adaptera i `OPENAI_API_KEY` (ten ostatni
 * tylko dla api.openai.com, patrz {@link openAiCompatibleEndpointFromEnv}) — wzorzec jak
 * przy `UMIEM_TTS_*`/`UMIEM_IMAGE_*`, bo LLM jest obowiązkową zależnością
 * workera (nie opcjonalnym feature'em jak grader). TTS analogicznie:
 * `UMIEM_TTS_MODEL`/`UMIEM_TTS_BASE_URL`/`UMIEM_TTS_API_KEY` (np. OpenRouter,
 * design szkoły §11.2). `OPENAI_API_KEY` pozostaje wymagany, bo obrazy używają
 * tylko jego. Puste wartości traktowane są jak nieustawione. BASE_URL dostaje
 * klucz w nagłówku Authorization, więc poza NODE_ENV test/development wymaga
 * `https://` (jak UMIEM_GRADER_BASE_URL).
 */
export function createGenerationDepsFromEnv(
  env: Record<string, string | undefined>,
  usage?: UsageRecorder,
): GenerationDeps | undefined {
  const mediaRoot = env.MEDIA_ROOT ?? "./data/media";
  const mediaStore = createLocalMediaStore(mediaRoot);
  const lessonExecution = lessonGenerationPolicyFromEnv(env);
  if (env.UMIEM_FAKE_PROVIDERS === "1") {
    const delayMs = Number(env.UMIEM_FAKE_DELAY_MS ?? 0);
    return {
      ...fakeGenerationDeps(mediaStore, {
        delayMs: Number.isFinite(delayMs) ? delayMs : 0,
        lessonDelayMs: fakeLessonDelayMsFromEnv(env),
        // bramka E2E: plik wstrzymuje fake'owe generowanie zestawu i mediów (fake.ts)
        ...(env.UMIEM_FAKE_HOLD_FILE ? { holdFile: env.UMIEM_FAKE_HOLD_FILE } : {}),
      }),
      lessonExecution,
      // tryb fake nie wymaga konfiguracji gradera (web bierze wtedy fake gradera)
      graderAvailable: false,
    };
  }
  const apiKey = openAiKeyFromEnv(env);
  if (!apiKey) {
    return undefined;
  }
  return {
    llm: createOpenAiLlmProvider({
      ...openAiCompatibleEndpointFromEnv(env, "UMIEM_LLM", apiKey),
      model: nonEmpty(env.UMIEM_LLM_MODEL),
      lessonRequestTimeoutMs: lessonExecution.requestTimeoutMs,
      requestExtras: chatRequestExtrasFromEnv(env, "UMIEM_LLM"),
      ...(usage ? { usage } : {}),
    }),
    // TTS (np. OpenRouter /audio/speech): model z UMIEM_TTS_MODEL, tym samym,
    // który wchodzi do fingerprintu nagrań (mediaSettingsFromEnv).
    tts: createOpenAiTtsProvider({ ...openAiCompatibleEndpointFromEnv(env, "UMIEM_TTS", apiKey), model: nonEmpty(env.UMIEM_TTS_MODEL), ...(usage ? { usage } : {}) }),
    image: createOpenAiImageProvider({ apiKey, feature: "illustration", ...(usage ? { usage } : {}) }),
    mediaStore,
    lessonExecution,
    graderAvailable: graderConfigured(env),
  };
}
