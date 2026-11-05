import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendCostEntry,
  appendProvisionalCostEntry,
  assertWithinCostCap,
  costCapFromEnv,
  errorClassOf,
  estimateProbeCostUsd,
  initCostLedger,
  ledgerCost,
  probeEndpointHost,
  readCostLedger,
  settleCostEntry,
  sha256File,
} from "./probe-costs";

describe("koszty prób", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "probe-costs-"));

  it("szacunek: 0,40 USD na generowanie", () => {
    expect(estimateProbeCostUsd({ generations: 0 })).toBe(0);
    expect(estimateProbeCostUsd({ generations: 1 })).toBeCloseTo(0.4, 10);
    expect(estimateProbeCostUsd({ generations: 3 })).toBeCloseTo(1.2, 10);
  });

  it("wpis tymczasowy (szacunek) przed płatnym wywołaniem liczy się do wydanych; rozliczenie zastępuje go zmierzonym w tym samym miejscu", () => {
    const path = join(dir(), "costs.json");
    initCostLedger(path);
    appendCostEntry(path, { at: "a", probe: "review", dump: "x.json", costUsd: 0.1 });
    const id = appendProvisionalCostEntry(path, { at: "b", probe: "chapter:grammar", dump: "m.txt", costUsd: 0.4 });
    appendCostEntry(path, { at: "c", probe: "review", dump: "y.json", costUsd: 0.2 });
    // Proces zabity po wpisie tymczasowym: szacunek zostaje w rejestrze i w kontroli limitu.
    const killed = readCostLedger(path);
    expect(killed.spentUsd).toBeCloseTo(0.7, 10);
    expect(killed.entries[1]).toEqual({ id, at: "b", probe: "chapter:grammar", dump: "m.txt", costUsd: 0.4, estimated: true, provisional: true });
    const settled = settleCostEntry(path, id, { at: "d", probe: "chapter:grammar", dump: "m.txt", costUsd: 0.31 });
    expect(settled.entries.map((entry) => entry.costUsd)).toEqual([0.1, 0.31, 0.2]);
    expect(settled.entries[1]).toEqual({ id, at: "d", probe: "chapter:grammar", dump: "m.txt", costUsd: 0.31 });
    expect(settled.spentUsd).toBeCloseTo(0.61, 10);
    expect(readCostLedger(path)).toEqual(settled);
    // Rozliczenie szacunkiem zachowuje flagę estimated; nieznany id → dopisanie (nic nie ginie).
    expect(settleCostEntry(path, id, { at: "e", probe: "chapter:grammar", dump: "m.txt", costUsd: 0.4, estimated: true }).entries[1]!.estimated).toBe(true);
    expect(settleCostEntry(path, "brak", { at: "f", probe: "p", dump: "d", costUsd: 0.05 }).entries).toHaveLength(4);
  });

  it("brak pliku → błąd (literówka w ścieżce nie zakłada nowego rejestru)", () => {
    const path = join(dir(), "costs.json");
    expect(() => readCostLedger(path)).toThrow(/UMIEM_PROBE_COSTS_INIT=1/);
    expect(() => appendCostEntry(path, { at: "x", probe: "p", dump: "d", costUsd: 1 })).toThrow(/UMIEM_PROBE_COSTS_INIT=1/);
    expect(existsSync(path)).toBe(false);
  });

  it("jawna inicjalizacja tworzy pusty rejestr z limitem 10 USD; ponowna nie nadpisuje", () => {
    const path = join(dir(), "costs.json");
    expect(initCostLedger(path)).toEqual({ capUsd: 10, spentUsd: 0, entries: [] });
    expect(readCostLedger(path)).toEqual({ capUsd: 10, spentUsd: 0, entries: [] });
    appendCostEntry(path, { at: "x", probe: "p", dump: "d", costUsd: 1 });
    expect(initCostLedger(path).spentUsd).toBe(1);
  });

  it("limit z UMIEM_PROBE_COSTS_CAP_USD: nowy rejestr dostaje podany limit, istniejący zachowuje swój", () => {
    expect(costCapFromEnv(undefined)).toBe(10);
    expect(costCapFromEnv("  ")).toBe(10);
    expect(costCapFromEnv("2.5")).toBe(2.5);
    for (const bad of ["abc", "0", "-1", "Infinity", "1,5"]) expect(() => costCapFromEnv(bad), bad).toThrow(/UMIEM_PROBE_COSTS_CAP_USD/u);

    const path = join(dir(), "costs.json");
    expect(initCostLedger(path, costCapFromEnv("2.5"))).toEqual({ capUsd: 2.5, spentUsd: 0, entries: [] });
    expect(readCostLedger(path).capUsd).toBe(2.5);
    // Ponowna inicjalizacja z innym limitem nie zmienia istniejącego rejestru.
    expect(initCostLedger(path, 50).capUsd).toBe(2.5);
  });

  it("dopisuje wpis i przelicza wydane z wpisów (zaokrąglenie do mikrodolara)", () => {
    const path = join(dir(), "costs.json");
    initCostLedger(path);
    appendCostEntry(path, { at: "2026-11-03T10:00:00.000Z", probe: "review", dump: "a.json", costUsd: 0.1 });
    const ledger = appendCostEntry(path, { at: "2026-11-03T11:00:00.000Z", probe: "chapter", dump: "m.txt", costUsd: 0.2, estimated: true });
    expect(ledger.spentUsd).toBe(0.3);
    expect(ledger.entries).toHaveLength(2);
    expect(ledger.entries[1]!.estimated).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(ledger);
  });

  it("zachowuje limit z pliku; zepsuty plik → błąd zamiast nadpisania", () => {
    const base = dir();
    const path = join(base, "costs.json");
    writeFileSync(path, JSON.stringify({ capUsd: 5, spentUsd: 1, entries: [{ at: "x", probe: "p", dump: "d", costUsd: 1 }] }));
    expect(appendCostEntry(path, { at: "y", probe: "p", dump: "d", costUsd: 0.5 }).capUsd).toBe(5);
    const broken = join(base, "broken.json");
    writeFileSync(broken, "{ nie json");
    expect(() => readCostLedger(broken)).toThrow(/costs/);
    expect(() => initCostLedger(broken)).toThrow();
    expect(() => appendCostEntry(broken, { at: "z", probe: "p", dump: "d", costUsd: 0.1 })).toThrow();
    expect(readFileSync(broken, "utf8")).toBe("{ nie json");
  });

  it("kontrola limitu: wydane + szacunek > limit → błąd z liczbami", () => {
    const ledger = { capUsd: 10, spentUsd: 9.5, entries: [] };
    expect(() => assertWithinCostCap(ledger, 0.5, "review")).not.toThrow();
    expect(() => assertWithinCostCap(ledger, 0.51, "review")).toThrow(/9\.50.*0\.51.*10\.00/);
  });

  it("ledgerCost: zmierzony koszt; przy wywołaniach bez usage.cost albo poniżej 0,005 USD na wywołanie — szacunek z flagą", () => {
    expect(ledgerCost({ measuredUsd: 0.12, calls: 3, fallbackUsd: 0.18 })).toEqual({ costUsd: 0.12, estimated: false });
    expect(ledgerCost({ measuredUsd: 0, calls: 3, fallbackUsd: 0.18 })).toEqual({ costUsd: 0.18, estimated: true });
    expect(ledgerCost({ measuredUsd: 0, calls: 0, fallbackUsd: 0.18 })).toEqual({ costUsd: 0, estimated: false });
    // Częściowy usage.cost (część wywołań bez kosztu): suma poniżej 3 × 0,005 USD → szacunek.
    expect(ledgerCost({ measuredUsd: 0.0149, calls: 3, fallbackUsd: 0.18 })).toEqual({ costUsd: 0.18, estimated: true });
    expect(ledgerCost({ measuredUsd: 0.015, calls: 3, fallbackUsd: 0.18 })).toEqual({ costUsd: 0.015, estimated: false });
  });

  it("readCostLedger: zepsuty JSON — błąd z klasą błędu, bez komunikatu parsera (może cytować treść pliku)", () => {
    const path = join(dir(), "costs.json");
    writeFileSync(path, "{ \"capUsd\": 10, tajne-dane");
    let message = "";
    try {
      readCostLedger(path);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/nieczytelny \(SyntaxError\)/u);
    expect(message).not.toContain("tajne");
    expect(message).not.toMatch(/position|Unexpected|token/iu);
  });
});

describe("probeEndpointHost", () => {
  it("OpenRouter po https: zwraca host (bez ścieżki i klucza)", () => {
    expect(probeEndpointHost("https://openrouter.ai/api/v1", "UMIEM_GRADER_BASE_URL")).toBe("openrouter.ai");
    expect(probeEndpointHost(" https://eu.openrouter.ai/api/v1 ", "UMIEM_LLM_BASE_URL")).toBe("eu.openrouter.ai");
  });

  it("inny host https: odmowa, chyba że UMIEM_PROBE_ALLOW_HOST wskazuje dokładnie ten host", () => {
    expect(() => probeEndpointHost("https://api.example.com/v1", "UMIEM_LLM_BASE_URL")).toThrow(/UMIEM_PROBE_ALLOW_HOST=api\.example\.com/u);
    expect(() => probeEndpointHost("https://api.example.com/v1", "UMIEM_LLM_BASE_URL", "other.example.com")).toThrow(/UMIEM_PROBE_ALLOW_HOST/u);
    expect(probeEndpointHost("https://api.example.com/v1", "UMIEM_LLM_BASE_URL", " API.example.com ")).toBe("api.example.com");
  });

  it("bez https albo zły adres: odmowa także z UMIEM_PROBE_ALLOW_HOST", () => {
    expect(() => probeEndpointHost("http://openrouter.ai/api/v1", "UMIEM_LLM_BASE_URL")).toThrow(/https/u);
    expect(() => probeEndpointHost("http://localhost:1234/v1", "UMIEM_LLM_BASE_URL", "localhost:1234")).toThrow(/https/u);
    expect(() => probeEndpointHost("nie-adres", "UMIEM_LLM_BASE_URL")).toThrow(/UMIEM_LLM_BASE_URL/u);
    expect(() => probeEndpointHost(undefined, "UMIEM_LLM_BASE_URL")).toThrow(/UMIEM_LLM_BASE_URL/u);
  });
});

describe("errorClassOf / sha256File", () => {
  it("errorClassOf: nazwa klasy błędu bez komunikatu; nie-błąd → typ", () => {
    expect(errorClassOf(new SyntaxError("tajne-dane"))).toBe("SyntaxError");
    expect(errorClassOf(new Error("x"))).toBe("Error");
    expect(errorClassOf("tekst")).toBe("string");
    expect(errorClassOf(undefined)).toBe("undefined");
  });

  it("sha256File: skrót SHA-256 zawartości pliku", () => {
    const path = join(mkdtempSync(join(tmpdir(), "probe-costs-")), "wejscie.txt");
    writeFileSync(path, "abc");
    expect(sha256File(path)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
