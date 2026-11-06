import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentCostEstimates,
  agentLedgerCost,
  appendCostEntry,
  appendProvisionalCostEntry,
  assertWithinCostCap,
  costByOperation,
  costCapFromEnv,
  errorClassOf,
  initCostLedger,
  isAgentRunOperation,
  probeEndpointHost,
  readCostLedger,
  runCosts,
  sanitizedProbeError,
  settleCostEntry,
  sha256File,
  unsettledEvents,
  withLateSettlement,
  type ProbeCostEvent,
} from "./probe-costs";

describe("koszty prób", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "probe-costs-"));

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

describe("koszty przebiegu agenta puli", () => {
  const events: ProbeCostEvent[] = [
    { operation: "lesson_objectives", providerCostUsd: 0.01, runId: "run-a" },
    { operation: "agent_plan", providerCostUsd: 0.02, runId: "run-a" },
    { operation: "agent_objective", providerCostUsd: 0.3, runId: "run-a" },
    { operation: "agent_objective", providerCostUsd: 0.25, runId: "run-a" },
    { operation: "check_solve", providerCostUsd: 0.004, runId: "run-a" },
    { operation: "check_grade", runId: "run-a" },
    { operation: "agent_objective", providerCostUsd: 0.5, runId: "run-b" },
    { operation: "check_variants", runId: "run-b" },
    { operation: "lesson_story", providerCostUsd: 0.003, runId: null },
  ];

  it("isAgentRunOperation: kroki agenta i kontrole liczą się do budżetu runu, etap zagadnień i historyjka nie", () => {
    for (const operation of ["agent_plan", "agent_objective", "check_solve", "check_variants", "check_grade"]) expect(isAgentRunOperation(operation), operation).toBe(true);
    for (const operation of ["lesson_objectives", "lesson_story", undefined]) expect(isAgentRunOperation(operation), String(operation)).toBe(false);
  });

  it("costByOperation: wywołania, zmierzony koszt i wywołania bez usage.cost per operacja", () => {
    expect(costByOperation(events)).toEqual({
      lesson_objectives: { calls: 1, costUsd: 0.01, unknownCostCalls: 0 },
      agent_plan: { calls: 1, costUsd: 0.02, unknownCostCalls: 0 },
      agent_objective: { calls: 3, costUsd: 1.05, unknownCostCalls: 0 },
      check_solve: { calls: 1, costUsd: 0.004, unknownCostCalls: 0 },
      check_grade: { calls: 1, costUsd: 0, unknownCostCalls: 1 },
      check_variants: { calls: 1, costUsd: 0, unknownCostCalls: 1 },
      lesson_story: { calls: 1, costUsd: 0.003, unknownCostCalls: 0 },
    });
    expect(costByOperation([{ runId: null }])).toEqual({ unknown: { calls: 1, costUsd: 0, unknownCostCalls: 1 } });
  });

  const estimates = { unknownCallUsd: 0.02, unknownGraderCallUsd: 0.002 };

  it("runCosts: agent i kontrole porównane z budżetem runu, lesson_objectives osobno, w kolejności runów", () => {
    expect(runCosts(events, 0.55, estimates)).toEqual([
      { runId: "run-a", agentUsd: 0.574, agentEstimatedUsd: 0.576, lessonObjectivesUsd: 0.01, otherUsd: 0, calls: 6, unknownCostCalls: 1, budgetUsd: 0.55, overBudget: true },
      { runId: "run-b", agentUsd: 0.5, agentEstimatedUsd: 0.52, lessonObjectivesUsd: 0, otherUsd: 0, calls: 2, unknownCostCalls: 1, budgetUsd: 0.55, overBudget: false },
      { runId: null, agentUsd: 0, agentEstimatedUsd: 0, lessonObjectivesUsd: 0, otherUsd: 0.003, calls: 1, unknownCostCalls: 0, budgetUsd: 0.55, overBudget: false },
    ]);
    // Etap zagadnień nie zużywa budżetu agenta: sam koszt agenta równy budżetowi to nie przekroczenie.
    expect(runCosts([{ operation: "agent_objective", providerCostUsd: 1, runId: "r" }, { operation: "lesson_objectives", providerCostUsd: 0.2, runId: "r" }], 1, estimates)[0]!.overBudget).toBe(false);
    expect(runCosts([], 1, estimates)).toEqual([]);
  });

  it("runCosts: wywołania agenta bez usage.cost liczą się do budżetu szacunkiem kierownika (grader osobno); etap zagadnień bez kosztu nie", () => {
    const nearLimit: ProbeCostEvent[] = [{ operation: "agent_objective", providerCostUsd: 0.99, runId: "r" }];
    expect(runCosts(nearLimit, 1, estimates)[0]!.overBudget).toBe(false);
    // Jedno wywołanie bez kosztu (szacunek 0,02) przesuwa run ponad budżet — zmierzony koszt sam by tego nie pokazał.
    const unknownStep = runCosts([...nearLimit, { operation: "agent_objective", runId: "r" }], 1, estimates)[0]!;
    expect(unknownStep).toMatchObject({ agentUsd: 0.99, agentEstimatedUsd: 1.01, unknownCostCalls: 1, overBudget: true });
    // Grader bez kosztu: szacunek gradera (0,002), więc 0,99 + 0,002 mieści się w budżecie, a sześć takich wywołań już nie.
    expect(runCosts([...nearLimit, { operation: "check_grade", runId: "r" }], 1, estimates)[0]).toMatchObject({ agentEstimatedUsd: 0.992, overBudget: false });
    const graders = Array.from({ length: 6 }, (): ProbeCostEvent => ({ operation: "check_grade", runId: "r" }));
    expect(runCosts([...nearLimit, ...graders], 1, estimates)[0]).toMatchObject({ agentEstimatedUsd: 1.002, overBudget: true });
    // lesson_objectives bez kosztu jest poza budżetem agenta.
    expect(runCosts([...nearLimit, { operation: "lesson_objectives", runId: "r" }], 1, estimates)[0]).toMatchObject({ agentEstimatedUsd: 0.99, unknownCostCalls: 1, overBudget: false });
  });

  it("agentCostEstimates: szacunki z polityki runu (env), brakujące z wartości domyślnych kierownika", () => {
    expect(agentCostEstimates({})).toEqual({ unknownCallUsd: 0.02, unknownGraderCallUsd: 0.002 });
    expect(agentCostEstimates({ unknownCallEstimateUsd: 0.05 })).toEqual({ unknownCallUsd: 0.05, unknownGraderCallUsd: 0.002 });
    expect(agentCostEstimates({ unknownCallEstimateUsd: 0.05, unknownGraderCallEstimateUsd: 0.01 })).toEqual({ unknownCallUsd: 0.05, unknownGraderCallUsd: 0.01 });
  });

  it("unsettledEvents: rozliczenie bierze wszystko, czego nie rozliczono — bez zakresu runu i spóźnione zdarzenia wcześniejszego runu — i nic dwa razy", () => {
    const settled = new Set<ProbeCostEvent>();
    const log: ProbeCostEvent[] = [
      { operation: "agent_objective", providerCostUsd: 0.3, runId: "run-a" },
      { operation: "lesson_objectives", providerCostUsd: 0.01, runId: null },
    ];
    const first = unsettledEvents(log, settled);
    expect(first).toEqual(log);
    for (const event of first) settled.add(event);
    // Żądanie runu A przerwane terminem kończy się po jego rozliczeniu (zakres runu niesie run A), a w runie „+N” pada wywołanie bez zakresu.
    const late: ProbeCostEvent = { operation: "check_solve", providerCostUsd: 0.004, runId: "run-a" };
    const add: ProbeCostEvent = { operation: "agent_objective", providerCostUsd: 0.2, runId: "run-b" };
    const unscoped: ProbeCostEvent = { operation: "agent_objective", runId: null };
    log.push(late, add, unscoped);
    const second = unsettledEvents(log, settled);
    expect(second).toEqual([late, add, unscoped]);
    expect(agentLedgerCost(second, estimates)).toEqual({ costUsd: 0.224, estimated: true });
    for (const event of second) settled.add(event);
    expect(unsettledEvents(log, settled)).toEqual([]);
  });

  it("agentLedgerCost: zmierzony koszt; wywołanie bez usage.cost → szacunek kierownika (grader osobno) z flagą", () => {
    // 0.01 + 0.02 + 0.3 + 0.25 + 0.004 + 0.5 + 0.003 zmierzone; check_grade 0.002 i check_variants 0.02 szacowane.
    expect(agentLedgerCost(events, estimates)).toEqual({ costUsd: 1.109, estimated: true });
    expect(agentLedgerCost(events.filter((event) => event.providerCostUsd !== undefined), estimates)).toEqual({ costUsd: 1.087, estimated: false });
    expect(agentLedgerCost([], estimates)).toEqual({ costUsd: 0, estimated: false });
    // Tanie wywołania z pełnym usage.cost nie przechodzą na szacunek (przebieg agenta ma ich dziesiątki).
    const cheap = Array.from({ length: 40 }, (): ProbeCostEvent => ({ operation: "check_solve", providerCostUsd: 0.001, runId: "r" }));
    expect(agentLedgerCost(cheap, estimates)).toEqual({ costUsd: 0.04, estimated: false });
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

  it("sanitizedProbeError: klasa i kod-identyfikator bez komunikatu (może cytować materiał)", () => {
    const appError = Object.assign(new Error("dynamic objectives invalid: The cat sits on the mat"), { code: "validation" });
    const sanitized = sanitizedProbeError(appError, "Przebieg");
    expect(sanitized.message).toBe("Przebieg: wyjątek Error kod=validation (komunikat pominięty — może cytować materiał)");
    expect(sanitized.message).not.toContain("cat");
    // Kod, który nie jest identyfikatorem, też może nieść treść.
    expect(sanitizedProbeError(Object.assign(new TypeError("x"), { code: "tekst z materiału" }), "„+N”").message).toBe("„+N”: wyjątek TypeError (komunikat pominięty — może cytować materiał)");
    expect(sanitizedProbeError("tajne", "Przebieg").message).not.toContain("tajne");
    expect(sanitizedProbeError(null, "Przebieg").message).toContain("wyjątek object");
  });

  it("sha256File: skrót SHA-256 zawartości pliku", () => {
    const path = join(mkdtempSync(join(tmpdir(), "probe-costs-")), "wejscie.txt");
    writeFileSync(path, "abc");
    expect(sha256File(path)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("withLateSettlement: rozliczenie zawsze po treści; błąd treści nie jest zasłaniany błędem rozliczenia", async () => {
    const calls: string[] = [];
    await withLateSettlement(async () => void calls.push("body"), () => void calls.push("settle"));
    expect(calls).toEqual(["body", "settle"]);

    const bodyError = new Error("body");
    const reported: unknown[] = [];
    await expect(
      withLateSettlement(
        async () => {
          throw bodyError;
        },
        () => {
          calls.push("settle-after-failure");
          throw new Error("settle");
        },
        (error) => reported.push(error),
      ),
    ).rejects.toBe(bodyError);
    expect(calls).toContain("settle-after-failure");
    expect(reported).toHaveLength(1);

    const settleError = new Error("settle only");
    await expect(
      withLateSettlement(async () => undefined, () => {
        throw settleError;
      }),
    ).rejects.toBe(settleError);
  });
});
