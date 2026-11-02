import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Strażnik inwentarza płatnych adapterów (spec `2026-11-02-llm-cost-tracking-design.md`
 * §4.2 i §8.1): każdy plik w `providers/` z wywołaniem HTTP (`fetch(` / `doFetch(`)
 * to jeden z adapterów z §2 (albo wspólna koperta żądań lekcji
 * `openai/lesson-json-request.ts`, z której korzysta generator i krytyk lekcji)
 * i musi wołać helpery zapisu kosztów co najmniej tyle razy, ile ma miejsc wywołania. Test pilnuje inwentarza — nowy adapter
 * z `fetch` albo adapter bez zapisu wyjdzie tu na jaw. Kompletność ścieżek
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
  "openai/llm.ts",
  "openai/tts.ts",
];

const FETCH_SITE = /\b(?:fetch|doFetch)\(/g;
const RECORD_CALL = /\brecord(?:Response|Unreadable|HttpError|TransportFailure)\(/g;

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
    const withFetch = productionFiles(PROVIDERS_DIR)
      .filter((path) => (readFileSync(path, "utf8").match(FETCH_SITE) ?? []).length > 0)
      .map(posixRelative)
      .sort();
    expect(withFetch).toEqual([...PAID_ADAPTERS].sort());

    for (const adapter of PAID_ADAPTERS) {
      const source = readFileSync(join(PROVIDERS_DIR, adapter), "utf8");
      const fetchSites = (source.match(FETCH_SITE) ?? []).length;
      const recordCalls = (source.match(RECORD_CALL) ?? []).length;
      expect(recordCalls, `${adapter}: ${recordCalls} wywołań recordX przy ${fetchSites} miejscach fetch`).toBeGreaterThanOrEqual(fetchSites);
    }
  });
});
