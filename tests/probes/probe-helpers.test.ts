import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveOutsideRepoPath, runDirsOf } from "./probe-helpers";

const repoDir = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const outside = realpathSync(mkdtempSync(join(tmpdir(), "probe-helpers-")));
// Junction (Windows bez uprawnień administratora) albo dowiązanie katalogu do katalogu w repozytorium.
const link = join(outside, "link-to-repo");
symlinkSync(join(repoDir, "tests"), link, "junction");

afterAll(() => {
  rmSync(outside, { recursive: true, force: true });
});

describe("resolveOutsideRepoPath", () => {
  it("brak zmiennej albo same spacje → undefined", () => {
    expect(resolveOutsideRepoPath(undefined, "X")).toBeUndefined();
    expect(resolveOutsideRepoPath("  ", "X")).toBeUndefined();
  });

  it("ścieżka poza repozytorium (istniejąca i nie) jest przyjęta", () => {
    expect(resolveOutsideRepoPath(outside, "X")).toBe(outside);
    expect(resolveOutsideRepoPath(join(outside, "nowy", "plik.json"), "X")).toBe(join(outside, "nowy", "plik.json"));
  });

  it("ścieżka w repozytorium → błąd", () => {
    expect(() => resolveOutsideRepoPath(join(repoDir, "tests", "x.json"), "X")).toThrow(/wewnątrz repozytorium/u);
  });

  it("istniejące dowiązanie do repozytorium jako sam cel → błąd (realpath celu, nie tylko katalogu nadrzędnego)", () => {
    expect(() => resolveOutsideRepoPath(link, "UMIEM_PROBE_OUT_DIR")).toThrow(/UMIEM_PROBE_OUT_DIR wskazuje wewnątrz repozytorium/u);
  });

  it("nieistniejąca ścieżka kilka poziomów pod dowiązaniem → błąd (realpath najbliższego istniejącego przodka)", () => {
    expect(() => resolveOutsideRepoPath(join(link, "nowy", "głębiej", "plik.json"), "X")).toThrow(/wewnątrz repozytorium/u);
  });

  it("zwykły katalog poza repozytorium z nieistniejącymi podkatalogami → przyjęty", () => {
    mkdirSync(join(outside, "dane"), { recursive: true });
    expect(resolveOutsideRepoPath(join(outside, "dane", "a", "b", "c.json"), "X")).toBe(join(outside, "dane", "a", "b", "c.json"));
  });
});

describe("runDirsOf", () => {
  it("lista katalogów rozdzielona średnikami (spacje i puste człony pominięte)", () => {
    const a = join(outside, "a");
    const b = join(outside, "b");
    expect(runDirsOf(` ${a} ; ${b};;`, "X")).toEqual([a, b]);
    expect(runDirsOf(a, "X")).toEqual([a]);
  });

  it("pusta lista → błąd", () => {
    expect(() => runDirsOf(" ; ", "UMIEM_PROBE_RUN_DIRS")).toThrow(/UMIEM_PROBE_RUN_DIRS: pusta lista/u);
  });

  it("ścieżka w repozytorium (także jako jeden z członów) → błąd", () => {
    expect(() => runDirsOf(`${outside};${join(repoDir, "tests", "run")}`, "X")).toThrow(/wewnątrz repozytorium/u);
    expect(() => runDirsOf(join(link, "nowy"), "X")).toThrow(/wewnątrz repozytorium/u);
  });
});
