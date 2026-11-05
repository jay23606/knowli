import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * Granica składania agenta puli (spec etapu 2a §5, #237): adapter AI SDK
 * (`providers/openai/lesson-pool-agent.ts`) importuje wyłącznie
 * `providers/lesson-agent-env.ts`, wystawiony jako osobny eksport
 * `@learning/server/lesson-agent` i używany tylko przez worker. `config.ts`,
 * `generation-env.ts` i `index.ts` (z nich korzysta web) nie sięgają ani do
 * `lesson-agent-env.ts`, ani do adaptera — także pośrednio, przez graf importów
 * względnych (z importami typów, bo granica dotyczy kodu, nie tylko runtime).
 */

const serverSrc = join(__dirname, "..");
const repoRoot = join(serverSrc, "..", "..", "..");

const ADAPTER = "providers/openai/lesson-pool-agent.ts";
const COMPOSITION = "providers/lesson-agent-env.ts";
/** Jedyni importerzy adaptera w `packages/server/src` (sondy w `tests/probes` są poza pakietem). */
const ADAPTER_IMPORTERS = new Set([COMPOSITION, "providers/openai/lesson-pool-agent.test.ts"]);
const WEB_ROOTS = ["config.ts", "providers/generation-env.ts", "index.ts"];
const SUBPATH = "@learning/server/lesson-agent";
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/u;

/** Specyfikatory modułów pliku: import/export (także typów), `import()`, `require()`, `import x = require()`. */
function moduleSpecifiers(file: string, source: string): string[] {
  const found: string[] = [];
  const record = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node)) found.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      record(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      record(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      record(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  return found;
}

/** Ścieżka pliku (względem `src`) dla specyfikatora względnego; `undefined` dla pakietów i plików spoza drzewa. */
function resolveRelative(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(file), specifier)).replace(/\.js$/u, "");
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
  return candidates.find((candidate) => {
    const path = join(serverSrc, candidate);
    return existsSync(path) && statSync(path).isFile();
  });
}

function readSource(file: string): string {
  return readFileSync(join(serverSrc, file), "utf8");
}

/** Pliki osiągalne z `entry` po importach względnych (BFS), razem z `entry`. */
function reachableFrom(entry: string, read: (file: string) => string = readSource): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const specifier of moduleSpecifiers(file, read(file))) {
      const target = resolveRelative(file, specifier);
      if (target !== undefined && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return seen;
}

function walk(dir: string, base: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".next") return [];
    const path = join(dir, name);
    const relative = base === "" ? name : `${base}/${name}`;
    if (statSync(path).isDirectory()) return walk(path, relative);
    return SOURCE_FILE.test(name) ? [relative] : [];
  });
}

describe("granica składania agenta puli (@learning/server/lesson-agent)", () => {
  it("skan rozpoznaje importy typów, reeksporty, import() i require() oraz rozwiązuje ścieżki względne", () => {
    const source = [
      'import type { X } from "./a";',
      'export * from "../b";',
      'const c = await import("./c");',
      'const d = require("./d");',
      'import e = require("./e");',
      'import { f } from "@learning/server/lesson-agent";',
    ].join("\n");
    expect(moduleSpecifiers("x.ts", source)).toEqual(["./a", "../b", "./c", "./d", "./e", SUBPATH]);
    expect(resolveRelative("config.ts", "./providers/lesson-agent-env")).toBe(COMPOSITION);
    expect(resolveRelative("providers/lesson-agent-env.ts", "./openai/lesson-pool-agent")).toBe(ADAPTER);
    expect(resolveRelative("index.ts", "./domain/lessons/subjects")).toBe("domain/lessons/subjects/index.ts");
  });

  it("skan grafu widzi pośredni import (czułość)", () => {
    const fixture: Record<string, string> = {
      "config.ts": 'import { a } from "./providers/fake";',
      "providers/fake.ts": 'export * from "./lesson-agent-env";',
      "providers/lesson-agent-env.ts": 'import { b } from "./openai/lesson-pool-agent";',
      "providers/openai/lesson-pool-agent.ts": "",
    };
    const reachable = reachableFrom("config.ts", (file) => fixture[file] ?? "");
    expect(reachable.has(COMPOSITION)).toBe(true);
    expect(reachable.has(ADAPTER)).toBe(true);
  });

  it.each(WEB_ROOTS)("%s nie osiąga lesson-agent-env.ts ani adaptera (także pośrednio)", (entry) => {
    const reachable = reachableFrom(entry);
    expect(reachable.size).toBeGreaterThan(1);
    expect(reachable.has(COMPOSITION)).toBe(false);
    expect(reachable.has(ADAPTER)).toBe(false);
  });

  it("adapter importuje wyłącznie lesson-agent-env.ts (i test adaptera)", () => {
    const importers = walk(serverSrc, "").filter((file) =>
      moduleSpecifiers(file, readSource(file)).some((specifier) => resolveRelative(file, specifier) === ADAPTER),
    );
    expect(new Set(importers)).toEqual(ADAPTER_IMPORTERS);
  });

  it("eksport pakietu wskazuje lesson-agent-env.ts", () => {
    const manifest = JSON.parse(readFileSync(join(serverSrc, "..", "package.json"), "utf8")) as { exports: Record<string, string> };
    expect(manifest.exports).toEqual({ ".": "./src/index.ts", "./lesson-agent": `./src/${COMPOSITION}` });
  });

  it("żaden plik apps/web nie importuje @learning/server/lesson-agent; składanie workera importuje", () => {
    const webRoot = join(repoRoot, "apps", "web");
    const offenders = walk(webRoot, "apps/web").filter((file) =>
      moduleSpecifiers(file, readFileSync(join(repoRoot, file), "utf8")).some(
        (specifier) => specifier === SUBPATH || specifier.startsWith(`${SUBPATH}/`),
      ),
    );
    expect(offenders).toEqual([]);
    const composition = "apps/worker/src/composition.ts";
    expect(moduleSpecifiers(composition, readFileSync(join(repoRoot, composition), "utf8"))).toContain(SUBPATH);
  });
});
