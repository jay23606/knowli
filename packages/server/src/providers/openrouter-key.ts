import { isOpenRouterEndpoint } from "./chat-request-options";

/** Prefiks kluczy OpenRouter — taki klucz nigdy nie powinien trafić do api.openai.com. */
const OPENROUTER_KEY_PREFIX = "sk-or-";

export function isOpenRouterKey(key: string): boolean {
  return key.trim().toLowerCase().startsWith(OPENROUTER_KEY_PREFIX);
}

/** Kształt klucza OpenAI (`sk-…`, ale nie `sk-or-…`). */
function looksLikeOpenAiKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return normalized.startsWith("sk-") && !normalized.startsWith(OPENROUTER_KEY_PREFIX);
}

/** Wspólny klucz idzie wyłącznie po https na host OpenRouter, bez userinfo w URL. */
export function isSecureOpenRouterEndpoint(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined || !isOpenRouterEndpoint(baseUrl)) return false;
  const url = new URL(baseUrl.trim());
  return url.protocol === "https:" && url.username === "" && url.password === "";
}

/**
 * Klucz dla endpointu `<prefix>_BASE_URL`: własny `<prefix>_API_KEY`, a gdy go
 * brak — wspólny `OPENROUTER_API_KEY`, wyłącznie dla
 * bezpiecznego endpointu OpenRouter. Klucz w kształcie OpenAI skierowany na
 * OpenRouter to błąd startu (domyślny BASE_URL wysłałby go do OpenRouter), a
 * własny klucz OpenRouter (`sk-or-…`) przy BASE_URL innym niż https OpenRouter
 * — też (nie trafia do obcego hosta). Bez BASE_URL decyduje wywołujący.
 * Komunikaty podają wyłącznie nazwy zmiennych, nigdy wartości.
 */
export function endpointKeyFromEnv(
  env: Record<string, string | undefined>,
  prefix: "UMIEM_LLM" | "UMIEM_TTS" | "UMIEM_GRADER",
  baseUrl: string | undefined,
): string | undefined {
  const towardOpenRouter = isOpenRouterEndpoint(baseUrl);
  const ownKey = nonEmpty(env[`${prefix}_API_KEY`]);
  if (ownKey !== undefined) {
    if (towardOpenRouter && looksLikeOpenAiKey(ownKey)) {
      throw new Error(`${prefix}_API_KEY looks like an OpenAI key but ${prefix}_BASE_URL points to OpenRouter`);
    }
    if (baseUrl !== undefined && isOpenRouterKey(ownKey) && !isSecureOpenRouterEndpoint(baseUrl)) {
      throw new Error(`${prefix}_API_KEY looks like an OpenRouter key but ${prefix}_BASE_URL is not an https OpenRouter endpoint`);
    }
    return ownKey;
  }
  const shared = nonEmpty(env.OPENROUTER_API_KEY);
  if (shared === undefined || !isSecureOpenRouterEndpoint(baseUrl)) return undefined;
  if (looksLikeOpenAiKey(shared)) {
    throw new Error("OPENROUTER_API_KEY looks like an OpenAI key; put it in OPENAI_API_KEY");
  }
  return shared;
}

/**
 * Klucz agenta puli lekcji (adapter mówi wyłącznie z OpenRouter, więc bez
 * adresu): `UMIEM_LESSON_AGENT_API_KEY` → wspólny `OPENROUTER_API_KEY` →
 * `UMIEM_LLM_API_KEY`, gdy `UMIEM_LLM_BASE_URL` to bezpieczny endpoint
 * OpenRouter. Klucz w kształcie OpenAI to błąd startu (nie trafia do
 * OpenRouter); komunikat podaje nazwę zmiennej, nigdy wartość.
 */
export function lessonAgentKeyFromEnv(env: Record<string, string | undefined>): string | undefined {
  const candidates: readonly (readonly [string, string | undefined])[] = [
    ["UMIEM_LESSON_AGENT_API_KEY", nonEmpty(env.UMIEM_LESSON_AGENT_API_KEY)],
    ["OPENROUTER_API_KEY", nonEmpty(env.OPENROUTER_API_KEY)],
    ["UMIEM_LLM_API_KEY", isSecureOpenRouterEndpoint(env.UMIEM_LLM_BASE_URL) ? nonEmpty(env.UMIEM_LLM_API_KEY) : undefined],
  ];
  for (const [name, key] of candidates) {
    if (key === undefined) continue;
    if (looksLikeOpenAiKey(key)) throw new Error(`${name} looks like an OpenAI key but the lesson agent talks only to OpenRouter`);
    return key;
  }
  return undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}
