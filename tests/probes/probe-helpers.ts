import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Wspólne narzędzia prób na prawdziwych providerach (`*.probe.test.ts`); nie jest testem. */

/** Wczytuje .env (wzór `scripts/evaluate-school-grader.mts`) bez nadpisywania środowiska. */
export function loadDotEnv(): void {
  let text = "";
  try {
    text = readFileSync(new URL("../../.env", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]!] === undefined) {
      process.env[match[1]!] = match[2]!.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    }
  }
}

/** Katalogi główne repozytorium: ten checkout oraz główny checkout, gdy to worktree. */
function repositoryRoots(): string[] {
  const here = resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const roots = [here];
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: here, encoding: "utf8" }).trim();
    if (common.length > 0) roots.push(resolve(common, ".."));
  } catch {
    // brak gita: wystarcza katalog tego checkoutu
  }
  return [...new Set(roots)];
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Ścieżka z zmiennej `name` (rozwiązana) albo błąd, gdy leży w repozytorium; brak zmiennej = `undefined`.
 * Dotyczy zrzutów surowego wyjścia modelu i danych z materiału podręcznika: nie mogą trafić do checkoutu.
 */
export function resolveOutsideRepoPath(raw: string | undefined, name: string): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const resolved = resolve(raw);
  // Katalog nadrzędny po rozwiązaniu dowiązań/junction, żeby link do repozytorium nie ominął sprawdzenia.
  const directory = existsSync(dirname(resolved)) ? realpathOrSelf(dirname(resolved)) : dirname(resolved);
  const candidates = [resolved, join(directory, basename(resolved))];
  for (const root of repositoryRoots().flatMap((item) => [item, realpathOrSelf(item)])) {
    if (candidates.some((candidate) => isInside(root, candidate))) {
      throw new Error(`${name} wskazuje wewnątrz repozytorium (${root}) — plik z danymi podręcznika albo surowym wyjściem modelu nie może leżeć w checkoucie. Podaj ścieżkę poza repozytorium.`);
    }
  }
  return resolved;
}
