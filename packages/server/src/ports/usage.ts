import { AsyncLocalStorage } from "node:async_hooks";
import type { UsageFeature } from "@learning/contracts";

/**
 * Port śledzenia kosztów usług AI (spec `2026-11-02-llm-cost-tracking-design.md`
 * §4.1). Jedyny plik w `ports/` z kodem wykonywalnym: zakres kosztów niesie
 * `AsyncLocalStorage`. Zakres nie wpływa na żadną decyzję domenową, więc ukryty
 * kontekst nie łamie zasady jawnego przekazywania danych decyzyjnych.
 */
export type { UsageFeature };

/** Dane jednego wywołania płatnej usługi, bez kontekstu (ten dokłada recorder z zakresu). */
export interface UsageEvent {
  feature: UsageFeature;
  operation?: string;
  provider: string;
  model?: string;
  outcome: "ok" | "failed";
  /** Status odpowiedzi HTTP, gdy ją dostano (także przy `failed`). */
  httpStatus?: number;
  inputTokens?: number;
  outputTokens?: number;
  characters?: number;
  audioMs?: number;
  images?: number;
  /** Koszt w USD zwrócony przez dostawcę (liczba z odpowiedzi, np. `usage.cost`). */
  providerCostUsd?: number;
}

/** `record` nie czeka na zapis i nie rzuca; `flush` kończy zaległe zapisy (zamykanie procesu, testy). */
export interface UsageRecorder {
  record(event: UsageEvent): void;
  flush(): Promise<void>;
}

export interface UsageScope {
  generationRunId?: string;
  deckId?: string;
  sessionId?: string;
  childId?: string;
}

export type UsageScopeKind = "run" | "session" | "deck" | "none";

const storage = new AsyncLocalStorage<UsageScope>();

/** Wewnętrzny zakres zastępuje zewnętrzny na czas `fn` (także po `await`). */
export function withUsageScope<T>(scope: UsageScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function currentUsageScope(): UsageScope | undefined {
  return storage.getStore();
}

/** Rodzaj zakresu zapisywany jako `scope_kind`: run > session > deck > none. */
export function scopeKindOf(scope: UsageScope | undefined): UsageScopeKind {
  if (scope?.generationRunId) return "run";
  if (scope?.sessionId) return "session";
  if (scope?.deckId) return "deck";
  return "none";
}

/** Nazwa providera zapisywana w zdarzeniu na podstawie hosta `baseUrl`; nieznany host zostaje jak jest. */
export function providerFromBaseUrl(baseUrl: string): string {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return baseUrl;
  }
  if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) return "openrouter";
  if (host === "api.openai.com") return "openai";
  if (host.endsWith(".microsoft.com") || host.endsWith(".azure.com")) return "azure";
  return host;
}
