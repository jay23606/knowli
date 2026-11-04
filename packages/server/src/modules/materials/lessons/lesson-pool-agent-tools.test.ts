import { afterEach, describe, expect, it, vi } from "vitest";
import { agentObjectivesOf } from "../../../domain/lessons/agent/capable";
import { poolOf, type LessonAgentState } from "../../../domain/lessons/agent/state";
import { schoolAgentPolicy } from "../../../domain/lessons/subjects/school/agent-policy";
import {
  A,
  B,
  choice,
  contextFor,
  gap,
  open,
  stateWith,
  subject,
  topic,
} from "../../../domain/lessons/testing/agent-admission-fixtures";
import { withAgentPolicy } from "../../../domain/lessons/testing/agent-test-subject";
import type { AgentCapableSubject } from "../../../domain/lessons/agent/capable";
import type { LessonExerciseDraft, LessonTopic } from "../../../domain/lessons/types";
import type { LessonAgentToolOutcome } from "../../../ports/ai";
import { FakeExerciseChecker, type FakeExerciseCheckerOptions } from "../../../providers/fake-lesson-agent";
import { deadlineSignal, Semaphore } from "./lesson-agent-timers";
import { DEFAULT_LESSON_AGENT_POLICY, RunCostMeter } from "./lesson-pool-agent-policy";
import { createObjectiveTools, type RejectionLogEntry } from "./lesson-pool-agent-tools";
import { DEFAULT_LESSON_GENERATION_POLICY } from "./lesson-generation-policy";

/** Rozwiązujący fake'a: „Pytanie numer N” → `odpowiedź N`, inne widoki → „966”. */
function solveByNumber(view: string): string[] {
  const match = /numer (\d+)/u.exec(view);
  return [match ? `odpowiedź ${match[1]}` : "966"];
}

interface SetupOptions {
  checker?: FakeExerciseCheckerOptions;
  subject?: AgentCapableSubject;
  state?: LessonAgentState;
  cost?: RunCostMeter;
  examplesFromPlan?: boolean;
  material?: string;
  signal?: AbortSignal;
  semaphore?: Semaphore;
}

function setup(options: SetupOptions = {}) {
  let state = options.state ?? stateWith();
  const rejections: RejectionLogEntry[] = [];
  const refusals: string[] = [];
  const checker = new FakeExerciseChecker({ solve: solveByNumber, ...options.checker });
  const cost = options.cost ?? new RunCostMeter(0, 1, 0.02);
  const semaphore = options.semaphore ?? new Semaphore(4);
  const handle = createObjectiveTools({
    objectiveId: A,
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    ctx: contextFor({ subject: options.subject ?? subject, material: options.material ?? "" }),
    checker,
    checkerSemaphore: semaphore,
    cost,
    objectiveSignal: options.signal ?? new AbortController().signal,
    policy: DEFAULT_LESSON_AGENT_POLICY,
    familyScope: null,
    examplesFromPlan: options.examplesFromPlan ?? true,
    onRejection: (entry) => rejections.push(entry),
    onRefusal: (code) => refusals.push(code),
  });
  return { ...handle, state: () => state, rejections, refusals, checker, cost, semaphore };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((done) => setTimeout(done, 0));

function poolIds(state: LessonAgentState): string[] {
  return poolOf(state, A).map((entry) => entry.id);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("polityka agenta i licznik kosztu", () => {
  it("wartości domyślne z planu etapu 1", () => {
    expect(DEFAULT_LESSON_AGENT_POLICY).toEqual({
      maxStepsPerObjective: 8,
      planMaxSteps: 8,
      concurrency: 4,
      checkerConcurrency: 4,
      checkerTimeoutMs: 90_000,
      objectiveTimeoutMs: 300_000,
      runTimeoutMs: DEFAULT_LESSON_GENERATION_POLICY.runTimeoutMs,
      runBudgetUsd: 1,
      unknownCallEstimateUsd: 0.02,
    });
  });

  it("RunCostMeter(0, 0.05, 0.02): po 3 × 0.02 budżet wyczerpany (wydatek ≥ budżet)", () => {
    const meter = new RunCostMeter(0, 0.05, 0.02);
    meter.record(0.02);
    meter.record(0.02);
    expect(meter.exhausted()).toBe(false);
    meter.record(0.02);
    expect(meter.exhausted()).toBe(true);
    expect(meter.spentUsd).toBeCloseTo(0.06);
    expect(meter.unknownCalls).toBe(0);
  });

  it("koszt null liczy szacunkiem, a wydatek startuje od initialSpentUsd; równy budżetowi = wyczerpany", () => {
    const meter = new RunCostMeter(0.5, 1, 0.25);
    meter.record(null);
    expect(meter.spentUsd).toBeCloseTo(0.75);
    expect(meter.unknownCalls).toBe(1);
    meter.record(null);
    expect(meter.spentUsd).toBeCloseTo(1);
    expect(meter.exhausted()).toBe(true);
  });
});

describe("Semaphore i deadlineSignal", () => {
  it("najwyżej `limit` zadań naraz, kolejka FIFO", async () => {
    const semaphore = new Semaphore(2);
    const gate = deferred();
    const order: number[] = [];
    const runs = [1, 2, 3, 4].map((n) =>
      semaphore.run(async () => {
        order.push(n);
        await gate.promise;
        return n;
      }),
    );
    await flush();
    expect(order).toEqual([1, 2]);
    gate.resolve();
    expect(await Promise.all(runs)).toEqual([1, 2, 3, 4]);
    expect(order).toEqual([1, 2, 3, 4]);
    expect(semaphore.maxConcurrent).toBe(2);
  });

  it("błąd zadania zwalnia miejsce", async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await semaphore.run(async () => "ok")).toBe("ok");
  });

  it("termin przerywa z podanym powodem; dispose zdejmuje zegar", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const deadline = deadlineSignal(parent.signal, 1_000, "checker_timeout");
    await vi.advanceTimersByTimeAsync(999);
    expect(deadline.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBe("checker_timeout");
    deadline.dispose();
    expect(vi.getTimerCount()).toBe(0);

    const second = deadlineSignal(parent.signal, 1_000, "checker_timeout");
    parent.abort("cancelled");
    expect(second.signal.reason).toBe("cancelled");
    second.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("submit — parsowanie i wynik dla modelu", () => {
  it("paczka z błędem wraca z powodem, poprawiona zostaje przyjęta jako ex1", async () => {
    const tools = setup();
    const broken = { ...open(A, "Kiedy?", "w 966 roku"), prompt: "" };
    const first = await tools.tools.submit({ exercises: [broken] });
    expect(first.results).toHaveLength(1);
    const errors = (first.results[0] as { readonly errors: readonly string[] }).errors;
    expect(errors.length).toBeGreaterThan(0);
    expect(tools.rejections).toEqual([
      { objectiveId: A, exerciseType: "lesson_open_answer", kind: "rule", code: "rule_exercise", detail: errors.join("; ") },
    ]);

    const second = await tools.tools.submit({ exercises: [choice(A, 1)] });
    expect(second.results).toEqual([{ index: 0, accepted: "ex1" }]);
    expect(poolIds(tools.state())).toEqual(["ex1"]);
    expect(second.counts.total).toBe(1);
    expect(second.complete).toBe(false);
    expect(second.missing.length).toBeGreaterThan(0);
  });

  it("exercises niebędące tablicą: jeden wynik z błędem, stan bez zmian", async () => {
    const tools = setup();
    const before = tools.state();
    const outcome = await tools.tools.submit({ exercises: "x" as unknown as unknown[] });
    expect(outcome.results).toEqual([{ index: 0, errors: ["exercises must be an array"] }]);
    expect(tools.state()).toBe(before);
    expect(tools.checker.solveCalls).toHaveLength(0);
  });

  it("obce objectiveId → shape_objective; null w polu wymaganym → shape_malformed; wyniki w indeksach wejścia", async () => {
    const tools = setup();
    const outcome = await tools.tools.submit({
      exercises: [choice(B, 1), { ...choice(A, 2), answer: null }, choice(A, 3), null],
    });
    expect(outcome.results[0]).toEqual({ index: 0, errors: [expect.stringContaining(A)] });
    expect(outcome.results[1]).toEqual({ index: 1, errors: [expect.any(String)] });
    expect(outcome.results[2]).toEqual({ index: 2, accepted: "ex1" });
    expect(outcome.results[3]).toEqual({ index: 3, errors: [expect.any(String)] });
    expect(tools.rejections.map((entry) => [entry.code, entry.kind, entry.exerciseType])).toEqual([
      ["shape_objective", "shape", "lesson_choice"],
      ["shape_malformed", "shape", "lesson_choice"],
      ["shape_malformed", "shape", "unknown"],
    ]);
    // Tylko poprawny kształt trafia do checkera.
    expect(tools.checker.solveCalls).toHaveLength(1);
    expect(tools.checker.solveCalls[0]!.items).toHaveLength(1);
  });

  it("examples: \"x\" → błąd przykładów; przykłady z planu są ignorowane z notą", async () => {
    const own = setup({ examplesFromPlan: false });
    const bad = await own.tools.submit({ exercises: [], examples: "x" as unknown as unknown[] });
    expect(bad.examples).toEqual({ accepted: 0, errors: ["examples must be an array of strings"] });
    const good = await own.tools.submit({ exercises: [], examples: ["Mieszko I rządził Polską."] });
    expect(good.examples).toEqual({ accepted: 1, errors: [] });
    expect(own.state().examples.get(A)).toEqual(["Mieszko I rządził Polską."]);

    const fromPlan = setup({ examplesFromPlan: true });
    const ignored = await fromPlan.tools.submit({ exercises: [], examples: ["Mieszko I rządził Polską."] });
    expect(ignored.examples).toEqual({ accepted: 0, errors: ["examples are fixed by the plan"] });
    expect(fromPlan.state().examples.get(A)).toBeUndefined();

    const none = await fromPlan.tools.submit({ exercises: [] });
    expect(none.examples).toBeUndefined();
  });

  it("wynik dla modelu nie zawiera pól szkicu", async () => {
    const tools = setup();
    const outcome = await tools.tools.submit({ exercises: [choice(A, 1), { ...open(A, "Kiedy?", "w 966 roku"), prompt: "" }] });
    const json = JSON.stringify(outcome);
    expect(json).not.toContain('"answer"');
    expect(json).not.toContain('"acceptedAnswers"');
    expect(json).not.toContain("odpowiedź 1");
    expect(Object.keys(outcome).sort()).toEqual(["complete", "counts", "missing", "results"]);
  });
});

describe("submit — checker", () => {
  const gapWithVariant: LessonExerciseDraft = { ...gap(A, "Chrzest w roku ___.", "966"), acceptedAnswers: ["dziewięćset sześćdziesiąt sześć"] };

  it("checker tylko dla `pass` i typów polityki: jedno solve i jedno judgeVariants na submit", async () => {
    const policySubject = withAgentPolicy(subject, { blindSolveTypes: ["lesson_choice"], variantCheckTypes: ["lesson_gap"] });
    const tools = setup({ subject: policySubject });
    const invalid = { ...open(A, "Kiedy?", "w 966 roku"), prompt: "" };
    const outcome = await tools.tools.submit({
      // Drugi `choice(A, 1)` to duplikat w paczce: odpada już w precheck, więc nie trafia do checkera.
      exercises: [choice(A, 1), gapWithVariant, open(A, "Kto?", "Mieszko I"), invalid, choice(A, 2), gap(A, "Rok ___ to chrzest.", "966"), choice(A, 1)],
    });
    expect(outcome.results.map((result) => ("accepted" in result ? "ok" : "rejected"))).toEqual(["ok", "ok", "ok", "rejected", "ok", "ok", "rejected"]);
    expect(tools.rejections.map((entry) => entry.code)).toContain("lesson_pool");
    expect(tools.checker.solveCalls).toHaveLength(1);
    expect(tools.checker.solveCalls[0]!.items).toHaveLength(2);
    expect(tools.checker.solveCalls[0]!.items.map((item) => item.view)).toEqual([
      expect.stringContaining("Pytanie numer 1"),
      expect.stringContaining("Pytanie numer 2"),
    ]);
    expect(tools.checker.solveCalls[0]!.items.every((item) => item.expectedAnswers === 1)).toBe(true);
    // Warianty tylko dla luki z niepustymi wariantami.
    expect(tools.checker.judgeCalls).toHaveLength(1);
    expect(tools.checker.judgeCalls[0]!.items).toEqual([
      { view: expect.stringContaining("Chrzest w roku ___."), answer: "966", variants: ["dziewięćset sześćdziesiąt sześć"] },
    ]);
  });

  it("material tylko przy checkerNeedsMaterial", async () => {
    const without = setup({ material: "MATERIAŁ LEKCJI" });
    await without.tools.submit({ exercises: [choice(A, 1), gapWithVariant] });
    expect(without.checker.solveCalls[0]).not.toHaveProperty("material");
    expect(without.checker.judgeCalls[0]).not.toHaveProperty("material");

    const needsMaterial = withAgentPolicy(subject, { checkerNeedsMaterial: true });
    const withMaterial = setup({ subject: needsMaterial, material: "MATERIAŁ LEKCJI" });
    await withMaterial.tools.submit({ exercises: [choice(A, 1), gapWithVariant] });
    expect(withMaterial.checker.solveCalls[0]!.material).toBe("MATERIAŁ LEKCJI");
    expect(withMaterial.checker.judgeCalls[0]!.material).toBe("MATERIAŁ LEKCJI");
  });

  it("checker dostaje oczyszczony szkic (sanityzacja szkoły: bez hint), a nota wymienia usunięte pole", async () => {
    const schoolLike = withAgentPolicy(subject, { sanitize: schoolAgentPolicy.sanitize });
    const tools = setup({ subject: schoolLike });
    const outcome = await tools.tools.submit({ exercises: [{ ...choice(A, 1), hint: "ZNACZNIK-PODPOWIEDZI" }] });
    expect(outcome.results).toEqual([{ index: 0, accepted: "ex1", note: "hint" }]);
    expect(JSON.stringify(tools.checker.solveCalls)).not.toContain("ZNACZNIK-PODPOWIEDZI");
    expect(poolOf(tools.state(), A)[0]!.draft).not.toHaveProperty("hint");
  });

  it("wejście checkera nie zawiera kart, przykładów ani zdań kart lekcji", async () => {
    const markedTopic: LessonTopic = {
      ...topic,
      objectives: topic.objectives.map((objective) => ({
        ...objective,
        cards: [{ title: "ZNACZNIK-KARTY", body: "ZNACZNIK-TREŚCI-KARTY" }],
      })),
    };
    const state = stateWith({
      topic: markedTopic,
      objectives: agentObjectivesOf(markedTopic),
      fixedSources: { [A]: ["ZNACZNIK-ZDANIA-KARTY"] },
    });
    const tools = setup({ state, examplesFromPlan: false, material: "ZNACZNIK-MATERIAŁU" });
    await tools.tools.submit({ exercises: [choice(A, 1), gapWithVariant], examples: ["ZNACZNIK-PRZYKŁADU jest tutaj."] });
    expect(tools.checker.solveCalls).toHaveLength(1);
    expect(tools.checker.judgeCalls).toHaveLength(1);
    const sent = JSON.stringify([tools.checker.solveCalls, tools.checker.judgeCalls]);
    expect(sent).not.toContain("ZNACZNIK");
  });

  it("solveBatch krótsza o 1: ostatnie przyjęte jako unchecked", async () => {
    const tools = setup({ checker: { solveBatch: () => [["odpowiedź 1"], ["odpowiedź 2"]] } });
    const outcome = await tools.tools.submit({ exercises: [choice(A, 1), choice(A, 2), choice(A, 3)] });
    expect(outcome.results).toEqual([
      { index: 0, accepted: "ex1" },
      { index: 1, accepted: "ex2" },
      { index: 2, accepted: "ex3", note: "unchecked" },
    ]);
  });

  it("solveBatch dłuższa: nadmiar ignorowany", async () => {
    const tools = setup({ checker: { solveBatch: () => [["odpowiedź 1"], ["odpowiedź 2"], ["nadmiar"]] } });
    const outcome = await tools.tools.submit({ exercises: [choice(A, 1), choice(A, 2)] });
    expect(outcome.results).toEqual([
      { index: 0, accepted: "ex1" },
      { index: 1, accepted: "ex2" },
    ]);
  });

  it("null na pozycji: ta pozycja unchecked; rozjazd odrzuca jako blind", async () => {
    const tools = setup({ checker: { solveBatch: () => [["odpowiedź 1"], null, ["coś innego"]] } });
    const outcome = await tools.tools.submit({ exercises: [choice(A, 1), choice(A, 2), choice(A, 3)] });
    expect(outcome.results[0]).toEqual({ index: 0, accepted: "ex1" });
    expect(outcome.results[1]).toEqual({ index: 1, accepted: "ex2", note: "unchecked" });
    expect(outcome.results[2]).toEqual({ index: 2, errors: [expect.stringContaining("independent solver")] });
    expect(tools.rejections.map((entry) => entry.code)).toEqual(["blind_mismatch"]);
  });

  it("wyjątek checkera: cała paczka unchecked, bez porażki", async () => {
    const tools = setup({ checker: { solveBatch: () => "throw", judgeBatch: () => "throw" } });
    const outcome = await tools.tools.submit({ exercises: [choice(A, 1), gapWithVariant] });
    expect(outcome.results).toEqual([
      { index: 0, accepted: "ex1", note: "unchecked" },
      { index: 1, accepted: "ex2", note: "unchecked" },
    ]);
  });

  it("odrzucony wariant → variant_rejected", async () => {
    const tools = setup({ checker: { judge: () => false } });
    const outcome = await tools.tools.submit({ exercises: [gapWithVariant] });
    expect(outcome.results[0]).toEqual({ index: 0, errors: [expect.stringContaining("dziewięćset sześćdziesiąt sześć")] });
    expect(tools.rejections.map((entry) => entry.code)).toEqual(["variant_rejected"]);
  });

  it("termin checkera (fake timers): po checkerTimeoutMs pozycje unchecked, zegary zdjęte", async () => {
    vi.useFakeTimers();
    const tools = setup({ checker: { solveBatch: () => "hang" } });
    let settled: LessonAgentToolOutcome | undefined;
    void tools.tools.submit({ exercises: [choice(A, 1)] }).then((outcome) => {
      settled = outcome;
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_LESSON_AGENT_POLICY.checkerTimeoutMs - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled?.results).toEqual([{ index: 0, accepted: "ex1", note: "unchecked" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("semafor checkera jest wspólny: najwyżej `limit` wywołań naraz", async () => {
    const gate = deferred();
    const semaphore = new Semaphore(1);
    const tools = setup({ checker: { gate: gate.promise }, semaphore });
    const pending = tools.tools.submit({ exercises: [choice(A, 1), gapWithVariant] });
    await flush();
    expect(tools.checker.solveCalls.length + tools.checker.judgeCalls.length).toBe(1);
    gate.resolve();
    await pending;
    expect(tools.checker.solveCalls).toHaveLength(1);
    expect(tools.checker.judgeCalls).toHaveLength(1);
    expect(tools.checker.maxConcurrent).toBe(1);
    expect(semaphore.maxConcurrent).toBe(1);
  });
});

describe("submit — budżet", () => {
  it("wyczerpany budżet: submit → budget exhausted dla każdego indeksu, checker niewołany", async () => {
    const cost = new RunCostMeter(0, 0.05, 0.02);
    for (let call = 0; call < 3; call += 1) cost.record(0.02);
    const tools = setup({ cost });
    const before = tools.state();
    const outcome = await tools.tools.submit({ exercises: [choice(A, 1), choice(A, 2)] });
    expect(outcome.results).toEqual([
      { index: 0, errors: ["budget exhausted"] },
      { index: 1, errors: ["budget exhausted"] },
    ]);
    expect(tools.state()).toBe(before);
    expect(tools.checker.solveCalls).toHaveLength(0);
    expect(tools.rejections).toEqual([]);
    expect(tools.refusals).toEqual(["refused_budget"]);
    expect(tools.tools.shouldStop()).toBe(true);
  });

  it("budżet sprawdzany przed każdym wywołaniem checkera: drugie wywołanie po wyczerpaniu → unchecked", async () => {
    const cost = new RunCostMeter(0, 0.05, 0.02);
    const tools = setup({ cost, checker: { costUsd: 0.05 }, semaphore: new Semaphore(1) });
    const outcome = await tools.tools.submit({ exercises: [choice(A, 1), gapWithVariantFor()] });
    expect(tools.checker.solveCalls).toHaveLength(1);
    expect(tools.checker.judgeCalls).toHaveLength(0);
    expect(outcome.results).toEqual([
      { index: 0, accepted: "ex1" },
      { index: 1, accepted: "ex2", note: "unchecked" },
    ]);
  });
});

function gapWithVariantFor(): LessonExerciseDraft {
  return { ...gap(A, "Chrzest w roku ___.", "966"), acceptedAnswers: ["dziewięćset sześćdziesiąt sześć"] };
}

describe("mutex zagadnienia", () => {
  it("dwa submit naraz (checker za bramką) dają wynik sekwencyjny w kolejności wywołań", async () => {
    const batches = [[choice(A, 1), choice(A, 2)], [choice(A, 2), choice(A, 3)]];

    const sequential = setup();
    const expected: LessonAgentToolOutcome[] = [];
    for (const exercises of batches) expected.push(await sequential.tools.submit({ exercises }));

    const gate = deferred();
    const parallel = setup({ checker: { solve: solveByNumber, gate: gate.promise } });
    const pending = batches.map((exercises) => parallel.tools.submit({ exercises }));
    await flush();
    // Drugie wywołanie czeka na mutex — checker widzi tylko pierwszą paczkę.
    expect(parallel.checker.solveCalls).toHaveLength(1);
    gate.resolve();
    expect(await Promise.all(pending)).toEqual(expected);
    expect(poolIds(parallel.state())).toEqual(poolIds(sequential.state()));
    expect(expected[1]!.results[0]).toEqual({ index: 0, errors: expect.any(Array) });
  });

  it("submit i remove(\"ex1\") naraz: remove widzi przyjęte ex1", async () => {
    const gate = deferred();
    const tools = setup({ checker: { solve: solveByNumber, gate: gate.promise } });
    const submitted = tools.tools.submit({ exercises: [choice(A, 1), choice(A, 2)] });
    const removed = tools.tools.remove("ex1");
    await flush();
    gate.resolve();
    expect((await submitted).results.map((result) => ("accepted" in result ? result.accepted : null))).toEqual(["ex1", "ex2"]);
    const outcome = await removed;
    expect(outcome.removed).toEqual(["ex1"]);
    expect(outcome.counts.total).toBe(1);
    expect(poolIds(tools.state())).toEqual(["ex2"]);
  });

  it("remove nieznanego identyfikatora: removed [] i błąd dla modelu", async () => {
    const tools = setup();
    const before = tools.state();
    const outcome = await tools.tools.remove("ex9");
    expect(outcome.removed).toEqual([]);
    expect(outcome.results).toEqual([{ index: 0, errors: [expect.stringContaining("ex9")] }]);
    expect(tools.state()).toBe(before);
  });
});

describe("zamknięcie narzędzi", () => {
  it("close() w trakcie wiszącego checkera: submit kończy się odmową, stan bez zmian", async () => {
    const tools = setup({ checker: { solveBatch: () => "hang" } });
    const before = tools.state();
    const pending = tools.tools.submit({ exercises: [choice(A, 1), choice(A, 2)] });
    await flush();
    expect(tools.checker.solveCalls).toHaveLength(1);
    await tools.close();
    expect(await pending).toMatchObject({
      results: [
        { index: 0, errors: ["tools are closed"] },
        { index: 1, errors: ["tools are closed"] },
      ],
    });
    expect(tools.state()).toBe(before);
    expect(tools.rejections).toEqual([]);
    expect(tools.refusals).toEqual(["refused_closed"]);
  });

  it("wywołanie po close() → odmowa bez checkera; shouldStop() = true", async () => {
    const tools = setup();
    expect(tools.tools.shouldStop()).toBe(false);
    await tools.close();
    const outcome = await tools.tools.submit({ exercises: [choice(A, 1)] });
    expect(outcome.results).toEqual([{ index: 0, errors: ["tools are closed"] }]);
    expect(tools.checker.solveCalls).toHaveLength(0);
    expect(tools.tools.shouldStop()).toBe(true);
    const removal = await tools.tools.remove("ex1");
    expect(removal.removed).toEqual([]);
    expect(removal.results).toEqual([{ index: 0, errors: ["tools are closed"] }]);
  });

  it("przerwany sygnał zagadnienia w trakcie checkera → odmowa bez przyjęcia", async () => {
    const controller = new AbortController();
    const tools = setup({ signal: controller.signal, checker: { solveBatch: () => "hang" } });
    const before = tools.state();
    const pending = tools.tools.submit({ exercises: [choice(A, 1)] });
    await flush();
    controller.abort("objective_timeout");
    expect((await pending).results).toEqual([{ index: 0, errors: ["tools are closed"] }]);
    expect(tools.state()).toBe(before);
    expect(tools.tools.shouldStop()).toBe(true);
  });

  it("wywołanie czekające w kolejce mutexu w chwili close() kończy się odmową", async () => {
    const tools = setup();
    const pending = tools.tools.submit({ exercises: [choice(A, 1)] });
    await tools.close();
    expect((await pending).results).toEqual([{ index: 0, errors: ["tools are closed"] }]);
  });
});

describe("sekcja krytyczna przyjęcia", () => {
  it("między getState() a setState() w submit nie ma await (podmiana na bieżącym stanie)", async () => {
    // Inne zagadnienie zmienia stan w trakcie checkera; przyjęcie widzi tę zmianę.
    let state = stateWith();
    const gate = deferred();
    const checker = new FakeExerciseChecker({ solve: solveByNumber, gate: gate.promise });
    const events: string[] = [];
    const { tools } = createObjectiveTools({
      objectiveId: A,
      getState: () => {
        events.push("get");
        return state;
      },
      setState: (next) => {
        events.push("set");
        state = next;
      },
      ctx: contextFor(),
      checker,
      checkerSemaphore: new Semaphore(4),
      cost: new RunCostMeter(0, 1, 0.02),
      objectiveSignal: new AbortController().signal,
      policy: DEFAULT_LESSON_AGENT_POLICY,
      familyScope: null,
      examplesFromPlan: true,
      onRejection: () => undefined,
    });
    const pending = tools.submit({ exercises: [choice(A, 1)] });
    await flush();
    // Równoległe zagadnienie B dopisuje ćwiczenie: id ex1 zajęte.
    const other = createObjectiveTools({
      objectiveId: B,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      ctx: contextFor(),
      checker: new FakeExerciseChecker({ solve: solveByNumber }),
      checkerSemaphore: new Semaphore(4),
      cost: new RunCostMeter(0, 1, 0.02),
      objectiveSignal: new AbortController().signal,
      policy: DEFAULT_LESSON_AGENT_POLICY,
      familyScope: null,
      examplesFromPlan: true,
      onRejection: () => undefined,
    });
    expect((await other.tools.submit({ exercises: [choice(B, 7)] })).results).toEqual([{ index: 0, accepted: "ex1" }]);
    events.length = 0;
    gate.resolve();
    expect((await pending).results).toEqual([{ index: 0, accepted: "ex2" }]);
    expect(poolOf(state, B).map((entry) => entry.id)).toEqual(["ex1"]);
    expect(poolOf(state, A).map((entry) => entry.id)).toEqual(["ex2"]);
    // Po checkerze: jeden odczyt stanu do przyjęcia, zaraz potem podmiana (status liczony po niej).
    expect(events.slice(0, 2)).toEqual(["get", "set"]);
  });
});
