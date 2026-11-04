import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
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
  // Bez uruchamiania `git` (PATH): w worktree `.git` jest plikiem „gitdir: …”, a katalog gitdir
  // ma plik `commondir` ze ścieżką wspólnego katalogu `.git` głównego checkoutu.
  try {
    const dotGit = join(here, ".git");
    if (statSync(dotGit).isFile()) {
      const firstLine = readFileSync(dotGit, "utf8").split("\n")[0]!.trim();
      if (firstLine.startsWith("gitdir:")) {
        const gitdir = resolve(here, firstLine.slice("gitdir:".length).trim());
        const common = resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim());
        roots.push(resolve(common, ".."));
      }
    }
  } catch {
    // brak gita albo nietypowy układ: wystarcza katalog tego checkoutu
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

/**
 * Ścieżka po rozwiązaniu dowiązań: istniejąca — `realpath` jej samej; nieistniejąca — `realpath`
 * najbliższego istniejącego przodka z dołożonymi brakującymi członami. Wiszące dowiązanie (cel nie
 * istnieje) jest rozwijane do swojego celu, bo zapis przez nie utworzyłby plik w celu.
 */
function realpathOfNearest(path: string): string {
  const missing: string[] = [];
  let current = path;
  for (let guard = 0; guard < 64; guard += 1) {
    if (existsSync(current)) return join(realpathOrSelf(current), ...missing);
    let linkTarget: string | undefined;
    try {
      if (lstatSync(current).isSymbolicLink()) linkTarget = resolve(dirname(current), readlinkSync(current));
    } catch {
      // brak wpisu — idziemy do przodka
    }
    if (linkTarget !== undefined) {
      current = linkTarget;
      continue;
    }
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  return join(current, ...missing);
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
  // Po rozwiązaniu dowiązań/junction, żeby link do repozytorium nie ominął sprawdzenia.
  const candidates = [resolved, realpathOfNearest(resolved)];
  for (const root of repositoryRoots().flatMap((item) => [item, realpathOrSelf(item)])) {
    if (candidates.some((candidate) => isInside(root, candidate))) {
      throw new Error(`${name} wskazuje wewnątrz repozytorium (${root}) — plik z danymi podręcznika albo surowym wyjściem modelu nie może leżeć w checkoucie. Podaj ścieżkę poza repozytorium.`);
    }
  }
  return resolved;
}

/** Lista katalogów z `;` (ścieżki Windows mają `:`), każdy poza repozytorium. */
export function runDirsOf(raw: string, name: string): string[] {
  const dirs = raw.split(";").map((item) => item.trim()).filter((item) => item !== "");
  if (dirs.length === 0) throw new Error(`${name}: pusta lista katalogów`);
  return dirs.map((dir) => resolveOutsideRepoPath(dir, name)!);
}
