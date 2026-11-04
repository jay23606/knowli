import { describe, expect, it, vi } from "vitest";
import type {
  LessonAgentToolOutcome,
  LessonObjectiveAgentInput,
  LessonObjectiveAgentTools,
  RunCostSink,
} from "../ports/ai";
import { FakeExerciseChecker, FakeLessonPoolAgent } from "./fake-lesson-agent";

const OUTCOME: LessonAgentToolOutcome = {
  results: [],
  counts: { guided: 0, productive: 0, independent: 0, outsideStages: 0, total: 0 },
  missing: [],
  complete: false,
};

function agentInput(slug: string, maxSteps = 8): LessonObjectiveAgentInput {
  return { objective: { id: `lesson.topic.${slug}` }, maxSteps } as unknown as LessonObjectiveAgentInput;
}

function costSink(log: string[] = []): RunCostSink & { readonly values: (number | null)[] } {
  const values: (number | null)[] = [];
  return {
    values,
    record(usd) {
      values.push(usd);
      log.push(`cost:${usd}`);
    },
  };
}

function makeTools(
  log: string[],
  options: { stopAfterSubmits?: number; submit?: LessonObjectiveAgentTools["submit"] } = {},
): LessonObjectiveAgentTools & { readonly submitted: unknown[]; readonly removed: string[] } {
  const submitted: unknown[] = [];
  const removed: string[] = [];
  return {
    submitted,
    removed,
    submit:
      options.submit ??
      (async (raw) => {
        log.push("submit");
        submitted.push(raw);
        return OUTCOME;
      }),
    async remove(id) {
      log.push(`remove:${id}`);
      removed.push(id);
      return { ...OUTCOME, removed: [id] };
    },
    shouldStop: () => options.stopAfterSubmits !== undefined && submitted.length >= options.stopAfterSubmits,
  };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("FakeLessonPoolAgent", () => {
  it("wykonuje kroki zagadnienia po slugu i kończy jako model_finished", async () => {
    const agent = new FakeLessonPoolAgent({
      objectives: { alpha: [{ submit: { exercises: [1] } }, { remove: "x" }], beta: [{ submit: { exercises: [2] } }] },
    });
    const log: string[] = [];
    const tools = makeTools(log);
    const result = await agent.runObjective(agentInput("alpha"), tools, costSink(), new AbortController().signal);
    expect(result).toEqual({ steps: 2, stopReason: "model_finished" });
    expect(tools.submitted).toEqual([{ exercises: [1] }]);
    expect(tools.removed).toEqual(["x"]);
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]!.objectiveId).toBe("lesson.topic.alpha");
    expect(agent.calls[0]!.tools).toBe(tools);
    expect(agent.calls[0]!.outcomes).toHaveLength(2);
  });

  it("zagadnienie bez scenariusza kończy od razu bez kroków", async () => {
    const agent = new FakeLessonPoolAgent({});
    const result = await agent.runObjective(agentInput("nope"), makeTools([]), costSink(), new AbortController().signal);
    expect(result).toEqual({ steps: 0, stopReason: "model_finished" });
  });

  it("wykonuje kroki dopóki shouldStop() nie zwróci true i wtedy kończy jako stopped", async () => {
    const steps = Array.from({ length: 4 }, (_, index) => ({ submit: { exercises: [index] } }));
    const agent = new FakeLessonPoolAgent({ objectives: { alpha: steps } });
    const tools = makeTools([], { stopAfterSubmits: 2 });
    const cost = costSink();
    const result = await agent.runObjective(agentInput("alpha"), tools, cost, new AbortController().signal);
    expect(result).toEqual({ steps: 2, stopReason: "stopped" });
    expect(tools.submitted).toHaveLength(2);
    // Po zatrzymaniu nie ma kolejnego „wywołania modelu”.
    expect(cost.values).toHaveLength(2);
  });

  it("zatrzymuje się po maxSteps jako max_steps", async () => {
    const steps = Array.from({ length: 4 }, (_, index) => ({ submit: { exercises: [index] } }));
    const agent = new FakeLessonPoolAgent({ objectives: { alpha: steps } });
    const tools = makeTools([]);
    const result = await agent.runObjective(agentInput("alpha", 3), tools, costSink(), new AbortController().signal);
    expect(result).toEqual({ steps: 3, stopReason: "max_steps" });
    expect(tools.submitted).toHaveLength(3);
  });

  it("zapisuje koszt kroku przed narzędziami, a brak stepCostUsd daje null", async () => {
    const agent = new FakeLessonPoolAgent({ objectives: { alpha: [{ submit: { exercises: [] } }] } });
    const log: string[] = [];
    const cost = costSink(log);
    await agent.runObjective(agentInput("alpha"), makeTools(log), cost, new AbortController().signal);
    expect(log).toEqual(["cost:null", "submit"]);

    const priced = new FakeLessonPoolAgent({ objectives: { alpha: [{ submit: { exercises: [] } }] }, stepCostUsd: 0.05 });
    const pricedLog: string[] = [];
    await priced.runObjective(agentInput("alpha"), makeTools(pricedLog), costSink(pricedLog), new AbortController().signal);
    expect(pricedLog).toEqual(["cost:0.05", "submit"]);
  });

  it("koszt jest zapisany przed narzędziem także wtedy, gdy narzędzie zostanie przerwane", async () => {
    const agent = new FakeLessonPoolAgent({ objectives: { alpha: [{ submit: { exercises: [] } }] }, stepCostUsd: 0.01 });
    const log: string[] = [];
    const cost = costSink(log);
    const controller = new AbortController();
    const tools = makeTools(log, {
      submit: (_raw) =>
        new Promise((_resolve, reject) => {
          log.push("submit-start");
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason));
        }),
    });
    const running = agent.runObjective(agentInput("alpha"), tools, cost, controller.signal);
    await delay(5);
    controller.abort(new Error("timeout"));
    await expect(running).rejects.toThrow("timeout");
    expect(log).toEqual(["cost:0.01", "submit-start"]);
    expect(cost.values).toEqual([0.01]);
  });

  it("parallel uruchamia narzędzia kroków bez czekania i zapisuje koszt raz", async () => {
    const agent = new FakeLessonPoolAgent({
      objectives: { alpha: [{ parallel: [{ submit: { exercises: [1] } }, { submit: { exercises: [2] } }] }] },
      stepCostUsd: 0.02,
    });
    const log: string[] = [];
    const cost = costSink(log);
    const tools = makeTools(log, {
      submit: async (raw) => {
        const id = (raw.exercises[0] as number).toString();
        log.push(`start:${id}`);
        await delay(id === "1" ? 20 : 1);
        log.push(`end:${id}`);
        return OUTCOME;
      },
    });
    const result = await agent.runObjective(agentInput("alpha"), tools, cost, new AbortController().signal);
    expect(result).toEqual({ steps: 1, stopReason: "model_finished" });
    expect(log.slice(0, 3)).toEqual(["cost:0.02", "start:1", "start:2"]);
    expect(log.indexOf("start:2")).toBeLessThan(log.indexOf("end:1"));
    expect(cost.values).toEqual([0.02]);
    expect(agent.calls[0]!.outcomes).toHaveLength(2);
  });

  it("throw rzuca błąd kroku po zapisaniu kosztu", async () => {
    const boom = new Error("boom");
    const agent = new FakeLessonPoolAgent({ objectives: { alpha: [{ throw: boom }] } });
    const cost = costSink();
    await expect(
      agent.runObjective(agentInput("alpha"), makeTools([]), cost, new AbortController().signal),
    ).rejects.toBe(boom);
    expect(cost.values).toEqual([null]);
  });

  it("hang czeka na przerwanie i odrzuca signal.reason", async () => {
    const agent = new FakeLessonPoolAgent({ objectives: { alpha: [{ hang: true }] }, stepCostUsd: 0.03 });
    const controller = new AbortController();
    const cost = costSink();
    let settled = false;
    const running = agent.runObjective(agentInput("alpha"), makeTools([]), cost, controller.signal);
    running.catch(() => {
      settled = true;
    });
    await delay(10);
    expect(settled).toBe(false);
    const reason = new Error("deadline");
    controller.abort(reason);
    await expect(running).rejects.toBe(reason);
    expect(cost.values).toEqual([0.03]);
  });

  it("hang odrzuca od razu, gdy sygnał jest już przerwany", async () => {
    const agent = new FakeLessonPoolAgent({ objectives: { alpha: [{ hang: true }] } });
    const controller = new AbortController();
    const reason = new Error("early");
    controller.abort(reason);
    await expect(agent.runObjective(agentInput("alpha"), makeTools([]), costSink(), controller.signal)).rejects.toBe(reason);
  });

  it("maxConcurrent zlicza równoległe wywołania runObjective", async () => {
    const agent = new FakeLessonPoolAgent({
      objectives: { a: [{ hang: true }], b: [{ hang: true }], c: [{ hang: true }] },
    });
    const controller = new AbortController();
    const runs = ["a", "b", "c"].map((slug) =>
      agent.runObjective(agentInput(slug), makeTools([]), costSink(), controller.signal).catch(() => undefined),
    );
    await delay(5);
    expect(agent.maxConcurrent).toBe(3);
    controller.abort(new Error("stop"));
    await Promise.all(runs);

    await agent.runObjective(agentInput("none"), makeTools([]), costSink(), new AbortController().signal);
    expect(agent.maxConcurrent).toBe(3);
  });

  it("przerwany sygnał odrzuca signal.reason przed krokiem i nie woła narzędzi ani kosztu", async () => {
    const agent = new FakeLessonPoolAgent({ objectives: { alpha: [{ submit: { exercises: [1] } }] } });
    const controller = new AbortController();
    const reason = new Error("aborted-before");
    controller.abort(reason);
    const tools = makeTools([]);
    const cost = costSink();
    await expect(agent.runObjective(agentInput("alpha"), tools, cost, controller.signal)).rejects.toBe(reason);
    expect(tools.submitted).toEqual([]);
    expect(cost.values).toEqual([]);
  });

  it("sygnał przerwany po koszcie kroku, a przed narzędziami, odrzuca signal.reason bez wołania narzędzia", async () => {
    const agent = new FakeLessonPoolAgent({ objectives: { alpha: [{ submit: { exercises: [1] } }] }, stepCostUsd: 0.01 });
    const controller = new AbortController();
    const reason = new Error("aborted-after-cost");
    const cost: RunCostSink & { values: (number | null)[] } = {
      values: [],
      record(usd) {
        this.values.push(usd);
        controller.abort(reason);
      },
    };
    const tools = makeTools([]);
    await expect(agent.runObjective(agentInput("alpha"), tools, cost, controller.signal)).rejects.toBe(reason);
    expect(cost.values).toEqual([0.01]);
    expect(tools.submitted).toEqual([]);
  });

  it("przerwany sygnał odrzuca signal.reason także w planObjectives", async () => {
    const agent = new FakeLessonPoolAgent({ plans: [1] });
    const controller = new AbortController();
    const reason = new Error("plan-aborted");
    controller.abort(reason);
    await expect(
      agent.planObjectives(
        { maxSteps: 8 } as never,
        { propose: async () => ({ ok: true, errors: [] }), shouldStop: () => false },
        costSink(),
        controller.signal,
      ),
    ).rejects.toBe(reason);
  });

  it("planObjectives proponuje kolejne plany do shouldStop() i zapisuje wejścia", async () => {
    const agent = new FakeLessonPoolAgent({ plans: [{ p: 1 }, { p: 2 }, { p: 3 }], stepCostUsd: 0.01 });
    const proposed: unknown[] = [];
    const log: string[] = [];
    const cost = costSink(log);
    const result = await agent.planObjectives(
      { maxSteps: 8 } as never,
      {
        propose: async (raw) => {
          log.push("propose");
          proposed.push(raw);
          return { ok: proposed.length >= 2, errors: proposed.length >= 2 ? [] : ["bad"] };
        },
        shouldStop: () => proposed.length >= 2,
      },
      cost,
      new AbortController().signal,
    );
    expect(result).toEqual({ steps: 2 });
    expect(proposed).toEqual([{ p: 1 }, { p: 2 }]);
    expect(log).toEqual(["cost:0.01", "propose", "cost:0.01", "propose"]);
    expect(agent.planCalls).toHaveLength(1);
  });

  it("planObjectives szanuje maxSteps", async () => {
    const agent = new FakeLessonPoolAgent({ plans: [1, 2, 3] });
    let count = 0;
    const result = await agent.planObjectives(
      { maxSteps: 2 } as never,
      {
        propose: async () => {
          count++;
          return { ok: false, errors: ["x"] };
        },
        shouldStop: () => false,
      },
      costSink(),
      new AbortController().signal,
    );
    expect(result).toEqual({ steps: 2 });
    expect(count).toBe(2);
  });
});

describe("FakeExerciseChecker", () => {
  const signal = () => new AbortController().signal;

  it("domyślnie solve zwraca pustą listę (rozjazd), a judge true", async () => {
    const checker = new FakeExerciseChecker({});
    const solved = await checker.solve({ items: [{ view: "v1", expectedAnswers: 1 }] }, costSink(), signal());
    expect(solved.answers).toEqual([[]]);
    const judged = await checker.judgeVariants(
      { items: [{ view: "v", answer: "a", variants: ["x", "y"] }] },
      costSink(),
      signal(),
    );
    expect(judged.equivalent).toEqual([[true, true]]);
  });

  it("solve i judge liczą per pozycja, a null oznacza brak wyniku", async () => {
    const checker = new FakeExerciseChecker({
      solve: (view) => (view === "skip" ? null : [view.toUpperCase()]),
      judge: (variant) => (variant === "maybe" ? null : variant === "yes"),
    });
    const solved = await checker.solve(
      { items: [{ view: "a", expectedAnswers: 1 }, { view: "skip", expectedAnswers: 1 }] },
      costSink(),
      signal(),
    );
    expect(solved.answers).toEqual([["A"], null]);
    const judged = await checker.judgeVariants(
      {
        items: [
          { view: "v", answer: "a", variants: ["yes", "no"] },
          { view: "v", answer: "a", variants: ["yes", "maybe"] },
        ],
      },
      costSink(),
      signal(),
    );
    expect(judged.equivalent).toEqual([[true, false], null]);
  });

  it("solveBatch ma pierwszeństwo, a krótsza lista jest przekazana 1:1", async () => {
    const checker = new FakeExerciseChecker({
      solve: () => ["ignored"],
      solveBatch: () => [["x"]],
    });
    const result = await checker.solve(
      { items: [{ view: "a", expectedAnswers: 1 }, { view: "b", expectedAnswers: 1 }, { view: "c", expectedAnswers: 1 }] },
      costSink(),
      signal(),
    );
    expect(result.answers).toEqual([["x"]]);
  });

  it("judgeBatch ma pierwszeństwo i dostaje pozycje wejścia", async () => {
    let seen: readonly unknown[] = [];
    const checker = new FakeExerciseChecker({
      judge: () => true,
      judgeBatch: (items) => {
        seen = items;
        return [null];
      },
    });
    const input = { items: [{ view: "v", answer: "a", variants: ["b"] }] };
    const result = await checker.judgeVariants(input, costSink(), signal());
    expect(result.equivalent).toEqual([null]);
    expect(seen).toEqual(input.items);
  });

  it('tryb "throw" rzuca wyjątek, ale koszt żądania jest zapisany', async () => {
    const checker = new FakeExerciseChecker({ solveBatch: () => "throw", judgeBatch: () => "throw", costUsd: 0.04 });
    const cost = costSink();
    await expect(checker.solve({ items: [] }, cost, signal())).rejects.toThrow();
    await expect(checker.judgeVariants({ items: [] }, cost, signal())).rejects.toThrow();
    expect(cost.values).toEqual([0.04, 0.04]);
  });

  it('tryb "hang" czeka na przerwanie i odrzuca signal.reason', async () => {
    const checker = new FakeExerciseChecker({ solveBatch: () => "hang", judgeBatch: () => "hang" });
    const controller = new AbortController();
    const reason = new Error("checker-timeout");
    const solving = checker.solve({ items: [] }, costSink(), controller.signal);
    const judging = checker.judgeVariants({ items: [] }, costSink(), controller.signal);
    controller.abort(reason);
    await expect(solving).rejects.toBe(reason);
    await expect(judging).rejects.toBe(reason);
  });

  it("zapisuje pełne wejścia wywołań i koszt (domyślnie 0, null przekazywany dalej)", async () => {
    const checker = new FakeExerciseChecker({});
    const cost = costSink();
    const solveInput = { items: [{ view: "v", expectedAnswers: 2 }], material: "mat" };
    const judgeInput = { items: [{ view: "v", answer: "a", variants: ["b"] }] };
    await checker.solve(solveInput, cost, signal());
    await checker.judgeVariants(judgeInput, cost, signal());
    expect(checker.solveCalls).toEqual([solveInput]);
    expect(checker.judgeCalls).toEqual([judgeInput]);
    expect(cost.values).toEqual([0, 0]);

    const unknownCost = new FakeExerciseChecker({ costUsd: null });
    const nullSink = costSink();
    await unknownCost.solve({ items: [] }, nullSink, signal());
    expect(nullSink.values).toEqual([null]);
  });

  it("gate wstrzymuje wywołania do rozwiązania obietnicy, a maxConcurrent liczy równoległość", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const checker = new FakeExerciseChecker({ gate });
    const cost = costSink();
    let done = 0;
    const calls = [
      checker.solve({ items: [{ view: "a", expectedAnswers: 1 }] }, cost, signal()),
      checker.solve({ items: [{ view: "b", expectedAnswers: 1 }] }, cost, signal()),
      checker.judgeVariants({ items: [{ view: "c", answer: "x", variants: ["y"] }] }, cost, signal()),
    ].map((call) => call.then(() => void done++));
    await delay(10);
    expect(done).toBe(0);
    expect(checker.maxConcurrent).toBe(3);
    open();
    await Promise.all(calls);
    expect(done).toBe(3);
    expect(checker.maxConcurrent).toBe(3);
  });

  it("gate odrzuca signal.reason, gdy wywołanie zostanie przerwane w oczekiwaniu", async () => {
    const checker = new FakeExerciseChecker({ gate: new Promise<void>(() => undefined) });
    const controller = new AbortController();
    const reason = new Error("aborted-at-gate");
    const call = checker.solve({ items: [] }, costSink(), controller.signal);
    controller.abort(reason);
    await expect(call).rejects.toBe(reason);
  });

  it("wywołanie z już przerwanym sygnałem odrzuca signal.reason bez zapisu kosztu", async () => {
    const checker = new FakeExerciseChecker({});
    const controller = new AbortController();
    const reason = new Error("checker-pre-aborted");
    controller.abort(reason);
    const cost = costSink();
    await expect(checker.solve({ items: [] }, cost, controller.signal)).rejects.toBe(reason);
    await expect(checker.judgeVariants({ items: [] }, cost, controller.signal)).rejects.toBe(reason);
    expect(cost.values).toEqual([]);
  });

  it("gate nie zostawia nasłuchów abort na wspólnym, nieprzerwanym sygnale", async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    const added = vi.spyOn(signal, "addEventListener");
    const removed = vi.spyOn(signal, "removeEventListener");
    const checker = new FakeExerciseChecker({ gate: Promise.resolve() });
    for (let index = 0; index < 20; index += 1) {
      await checker.solve({ items: [{ view: `v${index}`, expectedAnswers: 1 }] }, costSink(), signal);
    }
    const listenersAdded = added.mock.calls.filter(([type]) => type === "abort").length;
    const listenersRemoved = removed.mock.calls.filter(([type]) => type === "abort").length;
    expect(listenersAdded).toBe(20);
    expect(listenersRemoved).toBe(listenersAdded);
  });
});
