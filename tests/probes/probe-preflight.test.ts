import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withConfigDefaults } from "@learning/server";
import { probePreflight } from "./probe-preflight";

// Bez sieci i bez `.env`: środowisko budujemy jawnie, a `fetch` rzuca — preflight nie może wołać usług.
const KEY = "sk-or-v1-probe-preflight-test";
const fetchSpy = vi.fn(() => {
  throw new Error("preflight nie może wołać sieci");
});

beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

/** Środowisko jak w próbie (po `withConfigDefaults`), bez żadnego klucza z powłoki. */
function probeEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return withConfigDefaults({ NODE_ENV: "test", ...overrides });
}

describe("probePreflight", () => {
  it("brak klucza OpenRouter → błąd, zanim próba dotknie rejestru albo usług", () => {
    for (const subject of ["chapter", "grammar"] as const) {
      expect(() => probePreflight(probeEnv(), { subject })).toThrow(/Brak klucza OpenRouter/u);
    }
    // Klucz LLM na innym hoście nie jest kluczem agenta.
    expect(() => probePreflight(probeEnv({ UMIEM_LLM_BASE_URL: "https://api.openai.com/v1", UMIEM_LLM_API_KEY: "sk-proj-x" }), { subject: "chapter" }))
      .toThrow(/Brak klucza OpenRouter/u);
  });

  it("tryb fake i klucz w kształcie OpenAI → błąd z nazwą, bez kosztu", () => {
    expect(() => probePreflight(probeEnv({ OPENROUTER_API_KEY: KEY, UMIEM_FAKE_PROVIDERS: "1" }), { subject: "chapter" })).toThrow(/UMIEM_FAKE_PROVIDERS/u);
    expect(() => probePreflight(probeEnv({ UMIEM_LESSON_AGENT_API_KEY: "sk-proj-abc" }), { subject: "chapter" })).toThrow(/UMIEM_LESSON_AGENT_API_KEY/u);
  });

  it("agent i checker idą na stały OpenRouter; szkoła dokłada host UMIEM_LLM i gradera", () => {
    expect(probePreflight(probeEnv({ OPENROUTER_API_KEY: KEY }), { subject: "chapter" }).hosts).toEqual(["openrouter.ai"]);
    expect(probePreflight(probeEnv({ OPENROUTER_API_KEY: KEY }), { subject: "school" }).hosts).toEqual(["openrouter.ai"]);
  });

  it("host spoza OpenRouter albo bez https → błąd; inny host tylko przez jawne allowHost", () => {
    const llmElsewhere = probeEnv({ OPENROUTER_API_KEY: KEY, UMIEM_LLM_BASE_URL: "https://llm.example.com/v1", UMIEM_LLM_API_KEY: "local-key" });
    expect(() => probePreflight(llmElsewhere, { subject: "school" })).toThrow(/UMIEM_LLM_BASE_URL: host llm\.example\.com nie jest OpenRouter/u);
    expect(probePreflight(llmElsewhere, { subject: "school", allowHost: "llm.example.com" }).hosts).toEqual(["openrouter.ai", "llm.example.com"]);
    // Rozdział nie woła UMIEM_LLM (zagadnienia planuje agent) — host LLM go nie zatrzymuje.
    expect(probePreflight(llmElsewhere, { subject: "chapter" }).hosts).toEqual(["openrouter.ai"]);

    const graderElsewhere = probeEnv({
      OPENROUTER_API_KEY: KEY,
      UMIEM_GRADER_BASE_URL: "https://grader.example.com/v1",
      UMIEM_GRADER_API_KEY: "grader-key",
    });
    // Złożony grader może zostać wywołany — jego host jest sprawdzany w każdym przedmiocie.
    expect(() => probePreflight(graderElsewhere, { subject: "chapter" })).toThrow(/UMIEM_GRADER_BASE_URL: host grader\.example\.com/u);
    const graderHttp = probeEnv({ OPENROUTER_API_KEY: KEY, UMIEM_GRADER_BASE_URL: "http://localhost:9999/v1", UMIEM_GRADER_API_KEY: "grader-key" });
    expect(() => probePreflight(graderHttp, { subject: "school", allowHost: "localhost:9999" })).toThrow(/UMIEM_GRADER_BASE_URL: próba wymaga https/u);
  });

  it("szkoła bez pełnego UMIEM_GRADER_* → błąd z nazwą brakującej zmiennej", () => {
    // Bez `withConfigDefaults` — domyślne wartości uzupełniłyby model i adres.
    const base = { NODE_ENV: "test", OPENROUTER_API_KEY: KEY, UMIEM_LLM_BASE_URL: "https://openrouter.ai/api/v1", UMIEM_GRADER_BASE_URL: "https://openrouter.ai/api/v1", UMIEM_GRADER_MODEL: "google/gemini-3.8-flash" };
    expect(() => probePreflight({ ...base, UMIEM_GRADER_MODEL: undefined }, { subject: "school" })).toThrow(/brak: UMIEM_GRADER_MODEL\./u);
    expect(() => probePreflight({ ...base, UMIEM_GRADER_BASE_URL: "" }, { subject: "school" })).toThrow(/brak: UMIEM_GRADER_BASE_URL, UMIEM_GRADER_API_KEY/u);
    // Klucz agenta osobno, bez wspólnego klucza: grader nie ma klucza.
    const ownAgentKey = { NODE_ENV: "test", UMIEM_LESSON_AGENT_API_KEY: KEY, UMIEM_GRADER_BASE_URL: base.UMIEM_GRADER_BASE_URL, UMIEM_GRADER_MODEL: base.UMIEM_GRADER_MODEL };
    expect(() => probePreflight(ownAgentKey, { subject: "school" })).toThrow(/brak: UMIEM_GRADER_API_KEY/u);
    expect(probePreflight(base, { subject: "school" }).hosts).toEqual(["openrouter.ai"]);
    // Inne przedmioty działają bez gradera.
    expect(probePreflight({ NODE_ENV: "test", UMIEM_LESSON_AGENT_API_KEY: KEY }, { subject: "grammar" }).hosts).toEqual(["openrouter.ai"]);
  });

  it("szacunek = budżet runu agenta, ×2 z „+N”; zła liczba „+N” → błąd", () => {
    expect(probePreflight(probeEnv({ OPENROUTER_API_KEY: KEY }), { subject: "grammar" }).estimateUsd).toBe(1);
    expect(probePreflight(probeEnv({ OPENROUTER_API_KEY: KEY }), { subject: "grammar", addCount: 12 }).estimateUsd).toBe(2);
    const budget = probeEnv({ OPENROUTER_API_KEY: KEY, UMIEM_LESSON_AGENT_RUN_BUDGET_USD: "0.4" });
    expect(probePreflight(budget, { subject: "chapter" }).estimateUsd).toBeCloseTo(0.4, 10);
    expect(probePreflight(budget, { subject: "chapter", addCount: 5 }).estimateUsd).toBeCloseTo(0.8, 10);
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      expect(() => probePreflight(budget, { subject: "chapter", addCount: bad }), String(bad)).toThrow(/UMIEM_PROBE_ADD_COUNT/u);
    }
    expect(() => probePreflight(probeEnv({ OPENROUTER_API_KEY: KEY, UMIEM_LESSON_AGENT_RUN_BUDGET_USD: "abc" }), { subject: "chapter" }))
      .toThrow(/UMIEM_LESSON_AGENT_RUN_BUDGET_USD/u);
  });
});
