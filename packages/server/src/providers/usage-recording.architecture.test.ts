import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Strażnik inwentarza płatnych adapterów (spec `2026-11-02-llm-cost-tracking-design.md`
 * §4.2 i §8.1): każdy plik w `providers/` z wywołaniem HTTP (`fetch(` / `doFetch(`)
 * albo z importem AI SDK (`ai`, `@openrouter/*` — żądania HTTP wysyła wtedy biblioteka;
 * agent puli lekcji, spec `2026-11-04-lesson-pool-agent-stage2a-design.md` §4)
 * to jeden z adapterów z §2 (albo wspólna koperta żądań lekcji
 * `openai/lesson-json-request.ts`, z której korzysta generator i krytyk lekcji)
 * i musi wołać helpery zapisu kosztów co najmniej tyle razy, ile ma miejsc wywołania
 * (plik SDK: co najmniej 3 — odpowiedź, błąd HTTP, porażka transportu). Test pilnuje inwentarza — nowy adapter
 * z `fetch` albo SDK albo adapter bez zapisu wyjdzie tu na jaw. Kompletność ścieżek
 * (sukces, błąd HTTP, nieczytelne ciało, abort) pilnują testy behawioralne
 * przy każdym adapterze, a wzorzec helperów to regex, nie podciąg `record`
 * (ten łapie też `Record<…>`).
 */

const PROVIDERS_DIR = dirname(fileURLToPath(import.meta.url));

const PAID_ADAPTERS = [
  "azure/pronunciation.ts",
  "azure/stt.ts",
  "images/openai.ts",
  "openai-compatible/grader.ts",
  "openai-compatible/session-activity.ts",
  "openai-compatible/stt.ts",
  "openai/lesson-json-request.ts",
  "openai/lesson-pool-agent.ts",
  "openai/llm.ts",
  "openai/tts.ts",
];

const FETCH_SITE = /\b(?:fetch|doFetch)\(/g;
const RECORD_CALL = /\brecord(?:Response|Unreadable|HttpError|TransportFailure)\(/g;
/** Import AI SDK (`from "x"`, `import "x"`, `import("x")`, `require("x")`) — jak skan `tests/ai-sdk-scope.test.ts`. */
const SDK_IMPORT = /\b(?:from|import|require)\s*\(?\s*["'](?:ai|ai\/[^"']+|@openrouter\/[^"']+)["']/u;
/** Plik SDK ma jedno wywołanie biblioteki, ale trzy ścieżki zapisu: odpowiedź, błąd HTTP i porażka transportu. */
const SDK_MIN_RECORD_CALLS = 3;

function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return productionFiles(path);
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts") || entry.name === "fake.ts") return [];
    return [path];
  });
}

function posixRelative(path: string): string {
  return relative(PROVIDERS_DIR, path).split("\\").join("/");
}

describe("zapis kosztów w adapterach providers/", () => {
  it("every paid adapter records usage", () => {
    const paid = productionFiles(PROVIDERS_DIR)
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return (source.match(FETCH_SITE) ?? []).length > 0 || SDK_IMPORT.test(source);
      })
      .map(posixRelative)
      .sort();
    expect(paid).toEqual([...PAID_ADAPTERS].sort());

    for (const adapter of PAID_ADAPTERS) {
      const source = readFileSync(join(PROVIDERS_DIR, adapter), "utf8");
      const fetchSites = (source.match(FETCH_SITE) ?? []).length;
      const required = SDK_IMPORT.test(source) ? Math.max(fetchSites, SDK_MIN_RECORD_CALLS) : fetchSites;
      const recordCalls = (source.match(RECORD_CALL) ?? []).length;
      expect(recordCalls, `${adapter}: ${recordCalls} wywołań recordX przy ${fetchSites} miejscach fetch (wymagane ${required})`).toBeGreaterThanOrEqual(required);
    }
  });

  it("wykrywa import AI SDK jako płatny adapter (dowód czułości)", () => {
    expect(SDK_IMPORT.test('import { generateText } from "ai";')).toBe(true);
    expect(SDK_IMPORT.test("import { MockLanguageModelV4 } from 'ai/test';")).toBe(true);
    expect(SDK_IMPORT.test('import { createOpenRouter } from "@openrouter/ai-sdk-provider";')).toBe(true);
    expect(SDK_IMPORT.test('const sdk = await import("ai");')).toBe(true);
    expect(SDK_IMPORT.test('const sdk = require("@openrouter/sdk");')).toBe(true);
    expect(SDK_IMPORT.test('import { a } from "./airline";\nimport { z } from "zod";')).toBe(false);
    expect(SDK_IMPORT.test('import type { Thing } from "aixyz";')).toBe(false);
  });
});
