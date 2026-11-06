import type { UsageFeature } from "@learning/contracts";
import { GenerationProviderError } from "../../ports/generation-error";
import type { UsageRecorder } from "../../ports/usage";
import { withChatRequestExtras, type ChatRequestExtras } from "../chat-request-options";
import {
  recordHttpError,
  recordResponse,
  recordTransportFailure,
  recordUnreadable,
  type UsageEventBase,
} from "../usage/record-http";
import { retryAfterMs } from "./retry-after";

/**
 * Wspólna koperta żądań lekcyjnych (strict `json_schema`) generatora
 * lekcji: timeout, fetch, mapowanie błędów HTTP/odmowy/długości, parsowanie
 * treści i zapis kosztów (jedno żądanie HTTP = jeden zapis).
 */

/** Część treści wiadomości chat; `cache_control` oznacza koniec prefiksu cache (Anthropic przez OpenRouter). */
export type ChatContentPart = {
  readonly type: "text";
  readonly text: string;
  readonly cache_control?: { readonly type: "ephemeral" };
};

export interface LessonJsonRequestConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly provider: string;
  readonly timeoutMs: number;
  readonly requestExtras?: ChatRequestExtras;
  readonly usage?: UsageRecorder;
  readonly usageFeature: UsageFeature;
}

async function lessonHttpError(response: Response): Promise<GenerationProviderError> {
  let kind: "configuration" | "rate_limit" | "transient" =
    response.status === 429 ? "rate_limit" : response.status === 408 || response.status >= 500 ? "transient" : "configuration";
  if (response.status === 429) {
    try {
      const body: unknown = await response.clone().json();
      const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
      const fields = error && typeof error === "object" ? error as { code?: unknown; type?: unknown } : {};
      const signals = [fields.code, fields.type].filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase());
      const rateLimitCodes = new Set(["rate_limit_exceeded", "requests_rate_limit_exceeded", "tokens_rate_limit_exceeded"]);
      const quotaCodes = new Set(["insufficient_quota", "billing_hard_limit_reached", "billing_not_active", "spend_limit_reached", "quota_exceeded"]);
      if (signals.some((signal) => rateLimitCodes.has(signal))) {
        kind = "rate_limit";
      } else if (signals.some((signal) => quotaCodes.has(signal))) {
        kind = "configuration";
      }
    } catch {
      // A provider's diagnostic body is untrusted and never enters logs or errors.
    }
  }
  return new GenerationProviderError(kind, {
    status: response.status,
    ...(kind === "rate_limit" ? { retryAfterMs: retryAfterMs(response.headers.get("retry-after")) } : {}),
  });
}

function asLessonTransportError(error: unknown): GenerationProviderError {
  if (error instanceof GenerationProviderError) return error;
  return new GenerationProviderError(
    error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError") ? "timeout" : "transient",
  );
}

/**
 * Jedno żądanie chat completions ze ścisłym schematem. Zwraca sparsowany JSON;
 * `accept` sprawdza kształt (niezgodny = błąd `output`). Bez `maxTokens` ciało
 * nie ma pola `max_tokens` (generator wysyła je jak dotąd).
 */
export async function postLessonJson(
  config: LessonJsonRequestConfig,
  args: {
    operation: string;
    schemaName: string;
    schema: Record<string, unknown>;
    system: string | readonly ChatContentPart[];
    user: string | readonly ChatContentPart[];
    maxTokens?: number;
    signal?: AbortSignal;
    accept: (parsed: unknown) => boolean;
  },
): Promise<unknown> {
  const base: UsageEventBase = { feature: config.usageFeature, operation: args.operation, provider: config.provider, model: config.model };
  // ciało przed `try`: błąd jego budowy to błąd programu, nie wywołanie dostawcy (bez zapisu `failed`)
  const body = JSON.stringify(withChatRequestExtras(config.requestExtras, {
    model: config.model,
    response_format: {
      type: "json_schema",
      json_schema: { name: args.schemaName, strict: true, schema: args.schema },
    },
    messages: [
      { role: "system", content: args.system },
      { role: "user", content: args.user },
    ],
    ...(args.maxTokens === undefined ? {} : { max_tokens: args.maxTokens }),
  }));
  // jedno żądanie HTTP = jeden zapis; catch transportu zapisuje tylko, gdy odpowiedzi nie było
  let recorded = false;
  try {
    const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
    const requestSignal = args.signal ? AbortSignal.any([args.signal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body,
      signal: requestSignal,
    });
    if (!response.ok) {
      recorded = true;
      recordHttpError(config.usage, base, response.status);
      throw await lessonHttpError(response);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      recorded = true;
      recordUnreadable(config.usage, base, response.status);
      throw new GenerationProviderError("output", { status: response.status });
    }
    // płatna odpowiedź jest zapisana zanim treść zostanie zwalidowana
    recorded = true;
    recordResponse(config.usage, base, response.status, payload);
    const choices = (payload as { choices?: unknown } | null)?.choices;
    if (!Array.isArray(choices) || choices.length === 0 || choices[0] === null || typeof choices[0] !== "object") {
      throw new GenerationProviderError("output", { status: response.status });
    }
    const choice = choices[0] as { finish_reason?: string | null; message?: { content?: string | null; refusal?: string | null } };
    if (choice?.message?.refusal) throw new GenerationProviderError("refusal", { status: response.status });
    if (choice?.finish_reason === "content_filter") throw new GenerationProviderError("refusal", { status: response.status });
    if (choice?.finish_reason === "length") throw new GenerationProviderError("incomplete", { status: response.status });
    const content = choice?.message?.content;
    if (typeof content !== "string" || content.trim() === "") throw new GenerationProviderError("output", { status: response.status });
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new GenerationProviderError("output", { status: response.status });
    }
    if (!args.accept(parsed)) throw new GenerationProviderError("output", { status: response.status });
    return parsed;
  } catch (error) {
    if (!recorded) recordTransportFailure(config.usage, base);
    throw asLessonTransportError(error);
  }
}
