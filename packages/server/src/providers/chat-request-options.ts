/**
 * Opcjonalne pola zapytania chat completions dla pośrednika OpenRouter,
 * składane ze zmiennych środowiskowych z prefiksem `UMIEM_LLM` (generator)
 * albo `UMIEM_GRADER` (grader i ocena aktywności). Bez ustawionych zmiennych
 * wynik jest pusty i zapytanie pozostaje takie jak dotąd — zwykłe API
 * zgodne z OpenAI mogłoby odrzucić nieznane pola `reasoning` i `provider`.
 *
 * - `<P>_REASONING`: `off` (wyłączone rozumowanie) albo `minimal|low|medium|high`.
 * - `<P>_PROVIDER_ORDER`: lista dostawców po przecinku (kolejność preferencji).
 * - `<P>_PROVIDER_QUANTIZATIONS`: dozwolone kwantyzacje, np. `fp8,bf16`.
 * - `<P>_PROVIDER_ALLOW_FALLBACKS`: `true|false` — czy wolno wyjść poza listę.
 * - `<P>_PROVIDER_DATA_COLLECTION`: `deny` wyklucza dostawców zbierających
 *   dane z zapytań niezależnie od ustawień konta (odpowiedzi dzieci w graderze).
 *
 * Opcje wymagają `<P>_BASE_URL` na hoście OpenRouter (`openrouter.ai`, `eu.`/`us.openrouter.ai`) — inaczej start
 * kończy się błędem konfiguracji zamiast wysyłać nieznane pola do zwykłego API.
 *
 * Ustawienie dowolnej opcji dostawcy albo `REASONING` dokłada
 * `require_parameters: true`, żeby routing trafiał tylko do dostawców
 * obsługujących wysyłane parametry (np. ścisły `json_schema` puli lekcji,
 * wybrany poziom rozumowania) — bez takiego dostawcy zapytanie jawnie się nie uda.
 */
export type ChatRequestExtras = Readonly<Record<string, unknown>>;

const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high"]);
const SLUG = /^[a-z0-9][a-z0-9._ -]*$/i;
/** Provider order also accepts endpoint slugs such as `deepinfra/turbo` or `google-vertex/us-east5`. */
const PROVIDER_ENDPOINT_SLUG = /^[a-z0-9][a-z0-9._ -]*(?:\/[a-z0-9][a-z0-9._ -]*)*$/i;

/** OpenRouter hosts, including the regional (in-region routing) endpoints. */
const OPENROUTER_HOSTS: ReadonlySet<string> = new Set(["openrouter.ai", "eu.openrouter.ai", "us.openrouter.ai"]);

/** Missing base URL means the adapter default (api.openai.com), which is not OpenRouter. */
export function isOpenRouterEndpoint(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined || baseUrl.trim() === "") return false;
  try {
    return OPENROUTER_HOSTS.has(new URL(baseUrl.trim()).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function list(name: string, value: string | undefined, pattern: RegExp = SLUG): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const items = value.split(",").map((item) => item.trim()).filter((item) => item !== "");
  for (const item of items) {
    if (!pattern.test(item)) throw new Error(`${name}: niedozwolona wartość „${item}”`);
  }
  return items.length > 0 ? items : undefined;
}

export function chatRequestExtrasFromEnv(
  env: Record<string, string | undefined>,
  prefix: "UMIEM_LLM" | "UMIEM_GRADER" | "UMIEM_REVIEWER",
): ChatRequestExtras {
  const extras: Record<string, unknown> = {};

  const reasoning = env[`${prefix}_REASONING`]?.trim().toLowerCase();
  if (reasoning !== undefined && reasoning !== "" && reasoning !== "default") {
    if (reasoning === "off") extras.reasoning = { enabled: false };
    else if (REASONING_EFFORTS.has(reasoning)) extras.reasoning = { effort: reasoning };
    else throw new Error(`${prefix}_REASONING must be off, minimal, low, medium or high`);
  }

  const provider = providerRoutingFields((suffix) => ({ name: `${prefix}_PROVIDER_${suffix}`, value: env[`${prefix}_PROVIDER_${suffix}`] }));
  // A configured reasoning level must be honoured too, so it also requires
  // providers that support every sent parameter (it may then fail loudly).
  if (Object.keys(provider).length > 0 || extras.reasoning !== undefined) {
    // These fields are OpenRouter's; a plain OpenAI-compatible API may reject
    // the whole request, so a mismatched configuration stops startup instead.
    if (!isOpenRouterEndpoint(env[`${prefix}_BASE_URL`])) {
      throw new Error(`${prefix}_REASONING and ${prefix}_PROVIDER_* require ${prefix}_BASE_URL on ${[...OPENROUTER_HOSTS].join(", ")}`);
    }
    provider.require_parameters = true;
    extras.provider = provider;
  }
  return extras;
}

type ProviderRoutingSuffix = "ORDER" | "QUANTIZATIONS" | "ALLOW_FALLBACKS" | "DATA_COLLECTION";

/**
 * Pola routingu dostawcy (`order`, `quantizations`, `allow_fallbacks`,
 * `data_collection`) z jednej listy przyrostków `_PROVIDER_*`. `read` zwraca
 * nazwę zmiennej (do komunikatu błędu) i jej wartość — dzięki temu ten sam kod
 * obsługuje prefiks jawny i dziedziczony.
 */
function providerRoutingFields(
  read: (suffix: ProviderRoutingSuffix) => { name: string; value: string | undefined },
): Record<string, unknown> {
  const provider: Record<string, unknown> = {};
  const order = read("ORDER");
  const orderList = list(order.name, order.value, PROVIDER_ENDPOINT_SLUG);
  if (orderList) provider.order = orderList;
  const quantizations = read("QUANTIZATIONS");
  const quantizationList = list(quantizations.name, quantizations.value);
  if (quantizationList) provider.quantizations = quantizationList.map((q) => q.toLowerCase());
  const fallbacks = read("ALLOW_FALLBACKS");
  const fallbacksValue = fallbacks.value?.trim().toLowerCase();
  if (fallbacksValue !== undefined && fallbacksValue !== "") {
    if (fallbacksValue !== "true" && fallbacksValue !== "false") throw new Error(`${fallbacks.name} must be true or false`);
    provider.allow_fallbacks = fallbacksValue === "true";
  }
  const dataCollection = read("DATA_COLLECTION");
  const dataCollectionValue = dataCollection.value?.trim().toLowerCase();
  if (dataCollectionValue !== undefined && dataCollectionValue !== "") {
    if (dataCollectionValue !== "deny" && dataCollectionValue !== "allow") throw new Error(`${dataCollection.name} must be deny or allow`);
    provider.data_collection = dataCollectionValue;
  }
  return provider;
}

/**
 * Routing dostawcy OpenRouter z `<prefix>_PROVIDER_*` bez wymogu `BASE_URL`
 * (adapter agenta mówi wyłącznie z OpenRouter). Nieustawiony przyrostek
 * dziedziczy `<inheritFrom>_PROVIDER_*` osobno — operator z
 * `UMIEM_LLM_PROVIDER_DATA_COLLECTION=deny` nie traci ochrony po przełączeniu
 * przedmiotu na agenta. Bez `require_parameters` (dokłada wywołujący, gdy ustawił
 * wysiłek rozumowania); pusty wynik → `undefined`.
 */
export function openRouterProviderRoutingFromEnv(
  env: Record<string, string | undefined>,
  prefix: string,
  inheritFrom?: string,
): Readonly<Record<string, unknown>> | undefined {
  const provider = providerRoutingFields((suffix) => {
    const own = env[`${prefix}_PROVIDER_${suffix}`];
    if (own !== undefined && own.trim() !== "") return { name: `${prefix}_PROVIDER_${suffix}`, value: own };
    return inheritFrom === undefined
      ? { name: `${prefix}_PROVIDER_${suffix}`, value: undefined }
      : { name: `${inheritFrom}_PROVIDER_${suffix}`, value: env[`${inheritFrom}_PROVIDER_${suffix}`] };
  });
  return Object.keys(provider).length > 0 ? provider : undefined;
}

/** Pola z env najpierw, pola adaptera (model, wiadomości, format) zawsze wygrywają. */
export function withChatRequestExtras<T extends Record<string, unknown>>(extras: ChatRequestExtras | undefined, body: T): T {
  return extras === undefined ? body : { ...extras, ...body };
}
