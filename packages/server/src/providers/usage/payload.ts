export interface PayloadUsage {
  inputTokens?: number;
  outputTokens?: number;
  providerCostUsd?: number;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Czyta `usage` z ciała odpowiedzi OpenRouter: czat (`prompt_tokens`,
 * `completion_tokens`, `cost`), obrazy (`input_tokens`, `output_tokens`) i STT (`seconds`, `cost`, bez tokenów). Nigdy nie
 * rzuca; niepoprawne pola (ujemne, nieskończone, nie-liczby) są pomijane.
 */
export function usageFromPayload(payload: unknown): PayloadUsage {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return {};
  const usage = (payload as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return {};
  const { prompt_tokens, completion_tokens, input_tokens, output_tokens, cost } = usage as Record<string, unknown>;

  const result: PayloadUsage = {};
  // czat: prompt/completion; obrazy (OpenAI /images): input/output
  const inputTokens = nonNegativeInteger(prompt_tokens) ?? nonNegativeInteger(input_tokens);
  const outputTokens = nonNegativeInteger(completion_tokens) ?? nonNegativeInteger(output_tokens);
  if (inputTokens !== undefined) result.inputTokens = inputTokens;
  if (outputTokens !== undefined) result.outputTokens = outputTokens;
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) result.providerCostUsd = cost;
  return result;
}
