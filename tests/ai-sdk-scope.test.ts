import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Zakres AI SDK (#237; etap 1, etap 2a spec §4 i §12): `ai` i `@openrouter/*`
 * wolno importować wyłącznie w `tests/probes/**` oraz w produkcyjnym adapterze
 * agenta puli `packages/server/src/providers/openai/lesson-pool-agent.ts` i jego
 * teście. Żaden inny plik źródłowy repozytorium (pakiety, aplikacje, skrypty,
 * testy, integracje) ich nie importuje. Zależności deklarują tylko devDependencies
 * roota (sondy) i manifest `packages/server` (dokładne wersje); inne manifesty
 * pakietów i aplikacji ich nie deklarują.
 * Lista plików pochodzi z gita (śledzone i nieignorowane), więc skan nie wchodzi
 * w `.claude/worktrees/*` ani inne ignorowane katalogi.
 */

const root = join(__dirname, "..");
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/u;
/** Katalogi pomijane po ścieżce względem korzenia: sondy, gdzie SDK jest dozwolone. */
const ALLOWED_PREFIXES = ["tests/probes/"];
/** Jedyne pliki produkcyjne z SDK: adapter agenta puli i jego test (MockLanguageModelV4 z `ai/test`). */
const ALLOWED_FILES = new Set([
  "packages/server/src/providers/openai/lesson-pool-agent.ts",
  "packages/server/src/providers/openai/lesson-pool-agent.test.ts",
]);
/** Manifest, który może deklarować SDK, z wymaganymi dokładnymi wersjami. */
const SDK_MANIFEST = "packages/server/package.json";
const SDK_VERSIONS: Readonly<Record<string, string>> = { ai: "7.0.162", "@openrouter/ai-sdk-provider": "3.1.0" };
/** Katalogi pomijane na każdej głębokości (pas bezpieczeństwa obok `git ls-files`) oraz kopie robocze agentów. */
const SKIPPED_SEGMENTS = new Set(["node_modules"]);
const SKIPPED_ROOT_PREFIXES = [".claude/"];
// Nazwane wyjątki (ścieżka względem korzenia repozytorium): testy architektury zawierają nazwy SDK
// wyłącznie jako dane w dowodach czułości swoich skanów.
const SENSITIVITY_FIXTURES = new Set([
  "packages/server/src/domain/lessons/architecture.test.ts",
  "packages/server/src/providers/usage-recording.architecture.test.ts",
  "tests/ai-sdk-scope.test.ts",
]);

function relativeToRoot(path: string): string {
  return path.slice(root.length + 1).replaceAll("\\", "/");
}

/** Czy plik o danej ścieżce względem korzenia podlega skanowi importów SDK. */
function isScannedPath(path: string): boolean {
  if (!SOURCE_FILE.test(path)) return false;
  if (SKIPPED_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  if (ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  if (ALLOWED_FILES.has(path)) return false;
  if (path.split("/").some((segment) => SKIPPED_SEGMENTS.has(segment))) return false;
  return !SENSITIVITY_FIXTURES.has(path);
}

/** Pliki śledzone i nieignorowane (git), przefiltrowane do skanowanych źródeł. */
function sourceFiles(): string[] {
  const listed = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return listed
    .split("\u0000")
    .filter((path) => path.length > 0 && isScannedPath(path))
    .filter((path) => existsSync(join(root, path)))
    .map((path) => join(root, path));
}

/** Specyfikatory z `from "x"`, `import "x"`, `import("x")` i `require("x")`. */
function importSpecifiers(source: string): string[] {
  const pattern = /\b(?:from|import|require)\s*\(?\s*["']([^"']+)["']/gu;
  return [...source.matchAll(pattern)].map((match) => match[1]!);
}

function isAiSdkName(name: string): boolean {
  return name === "ai" || name.startsWith("ai/") || name.startsWith("@openrouter/");
}

function workspaceDirs(parent: string): string[] {
  const dir = join(root, parent);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
    .map((entry) => join(dir, entry.name));
}

const workspaces = [...workspaceDirs("packages"), ...workspaceDirs("apps")];

describe("zakres AI SDK", () => {
  it("żaden plik źródłowy repozytorium poza tests/probes i adapterem agenta puli nie importuje ai ani @openrouter/*", () => {
    const files = sourceFiles();
    // Dowód, że skan rzeczywiście obejmuje całe repozytorium (nie fałszywie zielony).
    expect(files.length).toBeGreaterThan(100);
    const scanned = new Set(files.map(relativeToRoot));
    for (const sample of [
      "packages/server/src/index.ts",
      "packages/server/src/providers/openai/llm.ts",
      "packages/server/src/providers/openai/lesson-json-request.ts",
      "tests/integration-buckets.test.ts",
      "vitest.unit.config.ts",
    ]) {
      expect(scanned.has(sample), sample).toBe(true);
    }
    expect([...scanned].some((path) => path.startsWith("tests/probes/"))).toBe(false);
    expect([...scanned].some((path) => ALLOWED_FILES.has(path))).toBe(false);
    expect([...scanned].some((path) => path.includes("node_modules/"))).toBe(false);

    const offenders = files.flatMap((file) =>
      importSpecifiers(readFileSync(file, "utf8"))
        .filter(isAiSdkName)
        .map((specifier) => `${relativeToRoot(file)}: "${specifier}"`),
    );
    expect(offenders).toEqual([]);
  });

  it("tylko manifest packages/server deklaruje ai i @openrouter/* (dokładne wersje); inne manifesty nie", () => {
    const manifests = workspaces.map((workspace) => join(workspace, "package.json")).filter(existsSync);
    expect(manifests.length).toBeGreaterThanOrEqual(5);

    const declaredIn = (manifest: string) => {
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, Record<string, string> | undefined>;
      return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((field) =>
        Object.entries(pkg[field] ?? {}).map(([name, version]) => ({ field, name, version })),
      );
    };
    const offenders = manifests
      .filter((manifest) => relativeToRoot(manifest) !== SDK_MANIFEST)
      .flatMap((manifest) => declaredIn(manifest).filter(({ name }) => isAiSdkName(name)).map(({ name }) => `${relativeToRoot(manifest)}: ${name}`));
    expect(offenders).toEqual([]);

    const server = declaredIn(join(root, SDK_MANIFEST)).filter(({ name }) => isAiSdkName(name));
    expect(server.map(({ field, name, version }) => `${field}:${name}@${version}`).sort()).toEqual(
      Object.entries(SDK_VERSIONS).map(([name, version]) => `dependencies:${name}@${version}`).sort(),
    );
  });

  it("filtr ścieżek pomija kopie robocze agentów, sondy, node_modules i wyjątki czułości", () => {
    expect(isScannedPath(".claude/worktrees/x/packages/a.ts")).toBe(false);
    expect(isScannedPath("tests/probes/agent.probe.test.ts")).toBe(false);
    expect(isScannedPath("packages/a/node_modules/ai/index.js")).toBe(false);
    expect(isScannedPath("tests/ai-sdk-scope.test.ts")).toBe(false);
    expect(isScannedPath("packages/server/src/domain/lessons/architecture.test.ts")).toBe(false);
    expect(isScannedPath("packages/server/src/providers/usage-recording.architecture.test.ts")).toBe(false);
    expect(isScannedPath("packages/server/src/providers/openai/lesson-pool-agent.ts")).toBe(false);
    expect(isScannedPath("packages/server/src/providers/openai/lesson-pool-agent.test.ts")).toBe(false);
    // Dowód czułości dla innych plików w providers/: ten sam katalog i podobne nazwy nadal są skanowane.
    expect(isScannedPath("packages/server/src/providers/openai/llm.ts")).toBe(true);
    expect(isScannedPath("packages/server/src/providers/openai/lesson-pool-agent-helpers.ts")).toBe(true);
    expect(isScannedPath("packages/server/src/providers/lesson-pool-agent.ts")).toBe(true);
    expect(isScannedPath("apps/worker/src/providers/openai/lesson-pool-agent.ts")).toBe(true);
    expect(isScannedPath("packages/a/README.md")).toBe(false);
    expect(isScannedPath("packages/server/src/index.ts")).toBe(true);
    expect(isScannedPath("tests/probes-helper.ts")).toBe(true);
  });

  it("wykrywa importy SDK w różnych formach (dowód czułości testu)", () => {
    const found = (source: string) => importSpecifiers(source).filter(isAiSdkName);
    expect(found('import { generateText } from "ai";')).toEqual(["ai"]);
    expect(found("import { x } from 'ai/rsc';")).toEqual(["ai/rsc"]);
    expect(found('import "@openrouter/ai-sdk-provider";')).toEqual(["@openrouter/ai-sdk-provider"]);
    expect(found('const m = await import("ai");')).toEqual(["ai"]);
    expect(found('const m = require("@openrouter/sdk");')).toEqual(["@openrouter/sdk"]);
    expect(found('import { a } from "./airline";\nimport { z } from "zod";')).toEqual([]);
    expect(isAiSdkName("ai")).toBe(true);
    expect(isAiSdkName("aixyz")).toBe(false);
  });
});
