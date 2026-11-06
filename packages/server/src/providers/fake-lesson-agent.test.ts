import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LessonAgentToolOutcome,
  LessonObjectiveAgentInput,
  LessonObjectiveAgentTools,
  RunCostSink,
} from "../ports/ai";
import { agentObjectivesOf } from "../domain/lessons/agent/capable";
import { validateAgentPlan } from "../domain/lessons/agent/plan";
import { createLessonAgentState } from "../domain/lessons/agent/state";
import { englishChapterSubject } from "../domain/lessons/subjects/english-chapter/module";
import { englishGrammarSubject } from "../domain/lessons/subjects/english-grammar/module";
import { schoolSubject } from "../domain/lessons/subjects/school/module";
import { validateDynamicTopicData } from "../domain/lessons/topic-resolution";
import type { SubjectModule } from "../domain/lessons/types";
import { buildDynamicTopicData, withSubjectObjectiveKinds } from "../modules/materials/lessons/lesson-drafts";
import { lessonAgentLimits, runLessonPoolAgent, type LessonPoolAgentRunInput } from "../modules/materials/lessons/lesson-pool-agent";
import { objectiveAgentInput } from "../modules/materials/lessons/lesson-pool-agent-input";
import { FakeLlmProvider } from "./fake";
import { FakeExerciseChecker, FakeLessonPoolAgent, fakePlanFromCoverage } from "./fake-lesson-agent";
import { FAKE_SLOW_DELAY_MS, FAKE_SLOW_MARKER, fakeObjectiveExercises } from "./fake-lesson-pool";
import { createTestRecorder } from "./usage/test-recorder";

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

  it("calls: drugie wywołanie zagadnienia bierze drugi scenariusz", async () => {
    const agent = new FakeLessonPoolAgent({
      objectives: {
        alpha: { calls: [[{ submit: { exercises: [1] } }], [{ submit: { exercises: [2] } }, { submit: { exercises: [3] } }]] },
        beta: [{ submit: { exercises: [9] } }],
      },
    });
    const signal = new AbortController().signal;
    const first = makeTools([]);
    expect(await agent.runObjective(agentInput("alpha"), first, costSink(), signal)).toEqual({ steps: 1, stopReason: "model_finished" });
    expect(first.submitted).toEqual([{ exercises: [1] }]);
    // Wywołanie innego zagadnienia nie przesuwa licznika `alpha`.
    await agent.runObjective(agentInput("beta"), makeTools([]), costSink(), signal);
    const second = makeTools([]);
    expect(await agent.runObjective(agentInput("alpha"), second, costSink(), signal)).toEqual({ steps: 2, stopReason: "model_finished" });
    expect(second.submitted).toEqual([{ exercises: [2] }, { exercises: [3] }]);
    // Poza listą scenariuszy: wywołanie bez kroków.
    expect(await agent.runObjective(agentInput("alpha"), makeTools([]), costSink(), signal)).toEqual({ steps: 0, stopReason: "model_finished" });
  });

  it("gate: krok czeka, onReached wołane, przerwanie sygnałem odrzuca", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let reached = 0;
    const agent = new FakeLessonPoolAgent({
      objectives: { alpha: [{ gate, onReached: () => (reached += 1) }, { submit: { exercises: [1] } }] },
      stepCostUsd: 0.01,
    });
    const tools = makeTools([]);
    const cost = costSink();
    const running = agent.runObjective(agentInput("alpha"), tools, cost, new AbortController().signal);
    await vi.waitFor(() => expect(reached).toBe(1));
    await delay(5);
    expect(tools.submitted).toEqual([]);
    open();
    expect(await running).toEqual({ steps: 2, stopReason: "model_finished" });
    expect(tools.submitted).toEqual([{ exercises: [1] }]);
    expect(cost.values).toEqual([0.01, 0.01]);

    // Bramka, która się nie otwiera: przerwanie sygnału odrzuca `signal.reason`.
    const closed = new FakeLessonPoolAgent({ objectives: { alpha: [{ gate: new Promise<void>(() => undefined) }] } });
    const controller = new AbortController();
    const waiting = closed.runObjective(agentInput("alpha"), makeTools([]), costSink(), controller.signal);
    await delay(5);
    const reason = new Error("deadline");
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
  });

  it("usage: jeden zapis na krok", async () => {
    const usage = createTestRecorder();
    const agent = new FakeLessonPoolAgent({
      objectives: { alpha: [{ submit: { exercises: [1] } }, { parallel: [{ remove: "x" }, { remove: "y" }] }] },
      plans: [{ p: 1 }],
      stepCostUsd: 0.02,
      usage,
    });
    const signal = new AbortController().signal;
    await agent.runObjective(agentInput("alpha"), makeTools([]), costSink(), signal);
    await agent.planObjectives(
      { maxSteps: 8 } as never,
      { propose: async () => ({ ok: true, errors: [] }), shouldStop: () => false },
      costSink(),
      signal,
    );
    const base = { feature: "lesson_generation", provider: "openrouter", model: agent.model, outcome: "ok", httpStatus: 200, providerCostUsd: 0.02 };
    expect(usage.events).toEqual([
      { ...base, operation: "agent_objective" },
      { ...base, operation: "agent_objective" },
      { ...base, operation: "agent_plan" },
    ]);

    // Koszt nieznany: zdarzenie bez kwoty.
    const unknown = createTestRecorder();
    await new FakeLessonPoolAgent({ objectives: { alpha: [{ remove: "x" }] }, usage: unknown }).runObjective(
      agentInput("alpha"),
      makeTools([]),
      costSink(),
      signal,
    );
    expect(unknown.events).toHaveLength(1);
    expect(unknown.events[0]).not.toHaveProperty("providerCostUsd");
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
  it("checker unavailable → null dla każdej pozycji solve i judgeVariants", async () => {
    const checker = new FakeExerciseChecker({ unavailable: true });
    const solved = await checker.solve(
      { items: [{ view: "a", expectedAnswers: 1 }, { view: "b", expectedAnswers: 2 }] },
      costSink(),
      signal(),
    );
    const judged = await checker.judgeVariants({ items: [{ view: "c", answer: "x", variants: ["y", "z"] }] }, costSink(), signal());
    expect(solved.answers).toEqual([null, null]);
    expect(judged.equivalent).toEqual([null]);
  });

  describe("judgeHints i solveOpen (etap 2b)", () => {
    const hintItem = { view: "v", answer: "a", requiredElements: ["e"], hint: "h" };

    it("domyślnie: werdykt ok i para A/B; wejścia zapisane w hintCalls i openCalls", async () => {
      const checker = new FakeExerciseChecker({});
      const cost = costSink();
      const hintInput = { items: [hintItem, hintItem], material: "mat" };
      const openInput = { items: [{ view: "q1" }, { view: "q2" }] };
      const hints = await checker.judgeHints(hintInput, cost, signal());
      const open = await checker.solveOpen(openInput, cost, signal());
      expect(hints.verdicts).toEqual([{ verdict: "ok" }, { verdict: "ok" }]);
      expect(open.answers).toEqual([["A", "B"], ["A", "B"]]);
      expect(checker.hintCalls).toEqual([hintInput]);
      expect(checker.openCalls).toEqual([openInput]);
      expect(cost.values).toEqual([0, 0]);
    });

    it("judgeHint i solveOpen liczą per pozycja, a null oznacza brak wyniku", async () => {
      const checker = new FakeExerciseChecker({
        judgeHint: (item) => (item.view === "skip" ? null : { verdict: "reveals", reason: `leak in ${item.view}` }),
        solveOpen: (view) => (view === "skip" ? null : [view, `${view}!`]),
      });
      const hints = await checker.judgeHints({ items: [{ ...hintItem, view: "x" }, { ...hintItem, view: "skip" }] }, costSink(), signal());
      const open = await checker.solveOpen({ items: [{ view: "q" }, { view: "skip" }] }, costSink(), signal());
      expect(hints.verdicts).toEqual([{ verdict: "reveals", reason: "leak in x" }, null]);
      expect(open.answers).toEqual([["q", "q!"], null]);
    });

    it('hintBatch i openBatch: "throw" rzuca po zapisie kosztu, "hang" czeka na przerwanie', async () => {
      const throwing = new FakeExerciseChecker({ hintBatch: () => "throw", openBatch: () => "throw", costUsd: 0.04 });
      const cost = costSink();
      await expect(throwing.judgeHints({ items: [hintItem] }, cost, signal())).rejects.toThrow();
      await expect(throwing.solveOpen({ items: [{ view: "q" }] }, cost, signal())).rejects.toThrow();
      expect(cost.values).toEqual([0.04, 0.04]);

      const hanging = new FakeExerciseChecker({ hintBatch: () => "hang", openBatch: () => "hang" });
      const controller = new AbortController();
      const reason = new Error("checker-timeout");
      const hinting = hanging.judgeHints({ items: [hintItem] }, costSink(), controller.signal);
      const solving = hanging.solveOpen({ items: [{ view: "q" }] }, costSink(), controller.signal);
      controller.abort(reason);
      await expect(hinting).rejects.toBe(reason);
      await expect(solving).rejects.toBe(reason);
    });

    it("hintBatch zwracający undefined wraca do judgeHint; wspólny licznik równoległości", async () => {
      const checker = new FakeExerciseChecker({ hintBatch: () => undefined, openBatch: () => undefined });
      const hints = await checker.judgeHints({ items: [hintItem] }, costSink(), signal());
      expect(hints.verdicts).toEqual([{ verdict: "ok" }]);
      await Promise.all([
        checker.judgeHints({ items: [hintItem] }, costSink(), signal()),
        checker.solveOpen({ items: [{ view: "q" }] }, costSink(), signal()),
      ]);
      expect(checker.maxConcurrent).toBe(2);
    });

    it("unavailable → null dla każdej pozycji nowych metod", async () => {
      const checker = new FakeExerciseChecker({ unavailable: true });
      const hints = await checker.judgeHints({ items: [hintItem, hintItem] }, costSink(), signal());
      const open = await checker.solveOpen({ items: [{ view: "q" }, { view: "r" }, { view: "s" }] }, costSink(), signal());
      expect(hints.verdicts).toEqual([null, null]);
      expect(open.answers).toEqual([null, null, null]);
    });
  });
});

describe("FakeLessonPoolAgent — generator z prawdziwym kierownikiem (checker niedostępny)", () => {
  const never = new AbortController().signal;

  function registryOf(...subjects: SubjectModule[]) {
    return { getSubject: (id: string) => subjects.find((subject) => subject.id === id) };
  }

  function runInput(overrides: Partial<LessonPoolAgentRunInput>): LessonPoolAgentRunInput {
    return {
      runId: "run-1",
      subjectId: englishGrammarSubject.id,
      deckId: "42",
      objectiveSource: { source: "planner" },
      topicTitle: "Unit 1",
      material: "",
      poolSize: 0,
      graderAvailable: false,
      fixed: [],
      draftExamples: {},
      skipObjectives: [],
      familyScope: null,
      initialSpentUsd: 0,
      ...overrides,
    };
  }

  function setup(subject: SubjectModule) {
    const agent = new FakeLessonPoolAgent({ generate: {} });
    const checker = new FakeExerciseChecker({ unavailable: true });
    return { agent, checker, deps: { agent, checker, subjects: registryOf(subject) } };
  }

  const accepted = (result: Awaited<ReturnType<typeof runLessonPoolAgent>>) =>
    result.objectives.reduce((sum, objective) => sum + objective.exercises.length, 0);

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rozdział (planer) — plan przechodzi validateAgentPlan i bramkę pokrycia; run daje ≥ 1 przyjęte ćwiczenie", async () => {
    const material = [
      "Słowa:",
      "coat — płaszcz",
      "boots — buty",
      "scarf — szalik",
      "gloves — rękawiczki",
      "Zwroty:",
      "I am wearing …",
      "Put on your …",
    ].join("\n");
    const { agent, deps } = setup(englishChapterSubject);
    const result = await runLessonPoolAgent(deps, runInput({ subjectId: englishChapterSubject.id, material }), never);

    const planCall = agent.planCalls[0]!;
    expect(planCall.input.coverage).toEqual({ words: ["coat", "boots", "scarf", "gloves"], frames: ["I am wearing …", "Put on your …"] });
    expect(planCall.proposals).toHaveLength(1);
    const plan = planCall.proposals[0] as {
      objectives: { slug: string; titlePl: string; kind: string; cards: { title: string; body: string }[]; examples: string[] }[];
    };
    expect(plan.objectives.map((objective) => [objective.slug, objective.titlePl, objective.kind])).toEqual([
      ["part_1", "Część 1", "words"],
      ["part_2", "Część 2", "words"],
      ["part_3", "Część 3", "frame"],
    ]);
    expect(plan.objectives.map((objective) => objective.cards[0])).toEqual([
      { title: "Words", body: "coat, boots" },
      { title: "Words", body: "scarf, gloves" },
      { title: "Frames", body: "I am wearing …\nPut on your …" },
    ]);
    expect(plan.objectives.map((objective) => objective.examples)).toEqual([["coat"], ["scarf"], ["I am wearing …"]]);
    const validated = validateAgentPlan(plan, englishChapterSubject, material);
    expect(validated.ok).toBe(true);
    // Bramka pokrycia przedmiotu (część validateAgentPlan) — sprawdzona też wprost.
    expect(englishChapterSubject.agentPolicy!.planGate!(validated.ok ? validated.objectives : [], material)).toEqual([]);

    expect(result.planStatus).toBe("accepted");
    // Generator zgłosił ćwiczenia każdego zagadnienia (wynik narzędzia zapisany po `submit`).
    expect(agent.calls.length).toBeGreaterThan(0);
    expect(agent.calls.every((call) => call.outcomes.length > 0)).toBe(true);
    expect(agent.calls.every((call) => call.input.objective.examplesFromPlan)).toBe(true);
    expect(accepted(result)).toBeGreaterThanOrEqual(1);
  });

  it("rozdział bez ram — trzecie zagadnienie słów", async () => {
    const material = ["Słowa:", "coat — płaszcz", "boots — buty", "scarf — szalik"].join("\n");
    const { agent, deps } = setup(englishChapterSubject);
    const result = await runLessonPoolAgent(deps, runInput({ subjectId: englishChapterSubject.id, material }), never);
    const plan = agent.planCalls[0]!.proposals[0] as { objectives: { kind: string; cards: { body: string }[] }[] };
    expect(plan.objectives.map((objective) => [objective.kind, objective.cards[0]!.body])).toEqual([
      ["words", "coat"],
      ["words", "boots"],
      ["words", "scarf"],
    ]);
    expect(result.planStatus).toBe("accepted");
  });

  it("gramatyka (katalog) ≥ 1", async () => {
    const topic = englishGrammarSubject.topics.find((candidate) => candidate.id === "present_simple")!;
    const { agent, deps } = setup(englishGrammarSubject);
    const result = await runLessonPoolAgent(
      deps,
      runInput({ subjectId: englishGrammarSubject.id, objectiveSource: { source: "catalog", topic }, topicTitle: topic.titlePl }),
      never,
    );
    expect(result.planStatus).toBe("not_needed");
    expect(agent.calls.length).toBe(topic.objectives.length);
    expect(accepted(result)).toBeGreaterThanOrEqual(1);
    // Przykłady kart z wyniku generatora (zagadnienie bez przykładów z planu).
    expect(result.objectives[0]!.examples.length).toBeGreaterThan(0);
  });

  it("szkoła (wejście z fake generateLessonObjectives) ≥ 1", async () => {
    const material = [
      "Zagadnienie 1: Rzeki Polski",
      "Wisła jest najdłuższą rzeką Polski. Odra płynie na zachodzie kraju.",
      "Zagadnienie 2: Góry Polski",
      "Tatry są najwyższymi górami Polski. Sudety leżą na południowym zachodzie.",
    ].join("\n");
    const llm = new FakeLlmProvider();
    const { objectives } = await llm.generateLessonObjectives({
      subjectTitle: schoolSubject.titlePl,
      topicTitle: "Polska",
      material,
      generationRole: schoolSubject.prompts.generationRole,
    });
    const built = buildDynamicTopicData(objectives, schoolSubject.id, "42", "Polska", (objective) =>
      validateDynamicTopicData(schoolSubject, { titlePl: "Polska", objectives: [objective] }),
    );
    const dynamicTopic = withSubjectObjectiveKinds(schoolSubject, built.data!);
    const { deps } = setup(schoolSubject);
    const result = await runLessonPoolAgent(
      deps,
      runInput({ subjectId: schoolSubject.id, objectiveSource: { source: "input", dynamicTopic }, topicTitle: "Polska", material }),
      never,
    );
    expect(result.objectives).toHaveLength(2);
    expect(accepted(result)).toBeGreaterThanOrEqual(1);
  });

  it("scenariusz sluga ma pierwszeństwo przed generatorem", async () => {
    const agent = new FakeLessonPoolAgent({ generate: {}, objectives: { alpha: [] } });
    const tools = makeTools([]);
    const result = await agent.runObjective(agentInput("alpha"), tools, costSink(), never);
    expect(result).toEqual({ steps: 0, stopReason: "model_finished" });
    expect(tools.submitted).toEqual([]);
  });

  it.each([
    { words: ["coat", "boots", "scarf", "gloves"], bodies: ["coat, boots", "scarf", "gloves"] },
    { words: ["coat"], bodies: ["coat", "coat", "coat"] },
  ])("plan bez ram z $words.length słowami: podział po równo, żadne zagadnienie bez słowa materiału", ({ words, bodies }) => {
    const material = ["Słowa:", ...words.map((word) => `${word} — tłumaczenie`)].join("\n");
    const plan = fakePlanFromCoverage({
      subjectTitle: "Angielski",
      topicTitle: "Unit 1",
      material,
      generationRole: "",
      objectiveCount: { min: 3, max: 6 },
      coverage: { words, frames: [] },
      maxSteps: 8,
    });
    expect(plan.objectives.map((objective) => (objective.cards as { body: string }[])[0]!.body)).toEqual(bodies);
    expect(plan.objectives.map((objective) => (objective.examples as string[])[0])).toEqual(bodies.map((body) => body.split(", ")[0]));
    expect(validateAgentPlan(plan, englishChapterSubject, material)).toMatchObject({ ok: true });
  });

  it("plan bez pokrycia przedmiotu bierze nagłówki materiału (trzy zagadnienia słów)", () => {
    const plan = fakePlanFromCoverage({
      subjectTitle: "Historia",
      topicTitle: "Polska",
      material: "Rzeki:\nWisła płynie.\nGóry:\nTatry są wysokie.\nMiasta:\nKraków.",
      generationRole: "",
      objectiveCount: { min: 3, max: 6 },
      maxSteps: 8,
    });
    expect(plan.objectives.map((objective) => [objective.kind, (objective.cards as { body: string }[])[0]!.body, objective.examples])).toEqual([
      ["words", "Rzeki", ["Rzeki"]],
      ["words", "Góry", ["Góry"]],
      ["words", "Miasta", ["Miasta"]],
    ]);
  });
});

describe("FakeLessonPoolAgent — generator (pętla kroków, etap 3 PR 2)", () => {
  const never = new AbortController().signal;
  const GRAMMAR_TOPIC = englishGrammarSubject.topics.find((candidate) => candidate.id === "present_simple")!;

  /** Wejście podagenta gramatyki z prawdziwego `objectiveAgentInput` (pierwsze zagadnienie tematu). */
  function grammarInput(overrides: { material?: string; maxSteps?: number } = {}): LessonObjectiveAgentInput {
    const objectives = agentObjectivesOf(GRAMMAR_TOPIC);
    const limits = lessonAgentLimits(englishGrammarSubject, GRAMMAR_TOPIC, 0);
    const state = createLessonAgentState({ topic: GRAMMAR_TOPIC, objectives, fixed: [], examples: {}, fixedSources: {} });
    return objectiveAgentInput({
      subject: englishGrammarSubject,
      topic: GRAMMAR_TOPIC,
      state,
      objective: objectives[0]!,
      limits: limits.get(objectives[0]!.id)!,
      material: overrides.material ?? "",
      graderAvailable: false,
      examplesFixed: false,
      maxSteps: overrides.maxSteps ?? 8,
      callTimeoutMs: 90_000,
    });
  }

  function outcome(missing: string[], complete = false): LessonAgentToolOutcome {
    return { ...OUTCOME, missing, complete };
  }

  /** Narzędzia z kolejnymi wynikami `submit` (ostatni się powtarza). */
  function scriptedTools(outcomes: LessonAgentToolOutcome[], log: string[] = []) {
    const submitted: { exercises: unknown[]; examples?: unknown }[] = [];
    const tools = makeTools(log, {
      submit: async (raw) => {
        log.push("submit");
        submitted.push(raw as { exercises: unknown[]; examples?: unknown });
        return outcomes[Math.min(submitted.length - 1, outcomes.length - 1)]!;
      },
    });
    return { tools, submitted };
  }

  const typesOf = (raw: { exercises: unknown[] }) => raw.exercises.map((exercise) => (exercise as { exerciseType: string }).exerciseType);
  const answersOf = (raw: { exercises: unknown[] }) => raw.exercises.map((exercise) => (exercise as { answer: string }).answer);

  it("pętla: kolejny krok tylko dla braku", async () => {
    const agent = new FakeLessonPoolAgent({ generate: {} });
    const { tools, submitted } = scriptedTools([outcome(["independent: 0 of 3"]), outcome([], true)]);
    const result = await agent.runObjective(grammarInput(), tools, costSink(), never);
    expect(result).toEqual({ steps: 2, stopReason: "model_finished" });
    expect(submitted).toHaveLength(2);
    expect(typesOf(submitted[0]!).length).toBeGreaterThan(3);
    expect(submitted[0]!.examples).toBeDefined();
    expect(typesOf(submitted[1]!)).toEqual(["lesson_open_answer", "lesson_open_answer", "lesson_open_answer"]);
    expect(submitted[1]!.examples).toBeUndefined();
    // Drugi krok ma inne odpowiedzi niż pierwszy (przesunięcie +100).
    expect(answersOf(submitted[1]!).filter((answer) => answersOf(submitted[0]!).includes(answer))).toEqual([]);
  });

  it("+N: `new exercises: 2 of 12` i `independent: 1 of 3` → drugi krok zamawia 10 z etapu samodzielnego", async () => {
    const agent = new FakeLessonPoolAgent({ generate: {} });
    const { tools, submitted } = scriptedTools([outcome(["new exercises: 2 of 12", "independent: 1 of 3", "exercises: 9 of 20"]), outcome([], true)]);
    await agent.runObjective(grammarInput(), tools, costSink(), never);
    expect(submitted).toHaveLength(2);
    expect(typesOf(submitted[1]!)).toEqual(Array.from({ length: 10 }, () => "lesson_open_answer"));
  });

  it("brak wymaganego typu → jedno ćwiczenie tego typu; brak przykładów kart → przykłady ponownie", async () => {
    const agent = new FakeLessonPoolAgent({ generate: {} });
    const { tools, submitted } = scriptedTools([
      outcome(["needs at least one lesson_listen_choice or lesson_choice", "card examples: 0 of 1-3"]),
      outcome([], true),
    ]);
    await agent.runObjective(grammarInput(), tools, costSink(), never);
    expect(typesOf(submitted[1]!)).toEqual(["lesson_listen_choice"]);
    expect(submitted[1]!.examples).toBeDefined();
  });

  it("przy stale complete: false kroków = maxSteps; bez rozpoznanego braku pętla kończy", async () => {
    const agent = new FakeLessonPoolAgent({ generate: {} });
    const stale = scriptedTools([outcome(["independent: 0 of 3"])]);
    expect(await agent.runObjective(grammarInput({ maxSteps: 3 }), stale.tools, costSink(), never)).toEqual({ steps: 3, stopReason: "max_steps" });
    expect(stale.submitted).toHaveLength(3);

    const unknown = scriptedTools([outcome(["something the fake cannot fix"])]);
    expect(await agent.runObjective(grammarInput(), unknown.tools, costSink(), never)).toEqual({ steps: 1, stopReason: "model_finished" });
  });

  it("shouldStop() kończy pętlę jako stopped", async () => {
    const agent = new FakeLessonPoolAgent({ generate: {} });
    const log: string[] = [];
    const { tools } = scriptedTools([outcome(["independent: 0 of 3"])], log);
    const stopping = { ...tools, shouldStop: () => log.length > 0 };
    expect(await agent.runObjective(grammarInput(), stopping, costSink(), never)).toEqual({ steps: 1, stopReason: "stopped" });
  });

  it("krok `generate` w scenariuszu zgłasza generator z przesunięciem zagadnienia", async () => {
    const agent = new FakeLessonPoolAgent({ objectives: { affirmative_base: [{ generate: true }] } });
    const { tools, submitted } = scriptedTools([outcome([], true)]);
    const input = grammarInput();
    expect(input.objective.id.endsWith(".affirmative_base")).toBe(true);
    await agent.runObjective(input, tools, costSink(), never);
    expect(submitted).toEqual([fakeObjectiveExercises(input, 0)]);
  });

  it("krok `build` dostaje wejście podagenta", async () => {
    const seen: LessonObjectiveAgentInput[] = [];
    const agent = new FakeLessonPoolAgent({
      objectives: {
        alpha: [
          {
            build: (input) => {
              seen.push(input);
              return { exercises: [input.objective.id] };
            },
          },
        ],
      },
    });
    const { tools, submitted } = scriptedTools([outcome([], true)]);
    const input = agentInput("alpha");
    await agent.runObjective(input, tools, costSink(), never);
    expect(seen).toEqual([input]);
    expect(submitted).toEqual([{ exercises: ["lesson.topic.alpha"] }]);
  });

  describe("opóźnienia", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("FAKE_SLOW_MARKER opóźnia tylko pierwszy krok", async () => {
      vi.useFakeTimers();
      const agent = new FakeLessonPoolAgent({ generate: {} });
      const { tools, submitted } = scriptedTools([outcome(["independent: 0 of 3"]), outcome([], true)]);
      const run = agent.runObjective(grammarInput({ material: `Lekcja ${FAKE_SLOW_MARKER}` }), tools, costSink(), never);
      await vi.advanceTimersByTimeAsync(FAKE_SLOW_DELAY_MS - 1);
      expect(submitted).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await expect(run).resolves.toEqual({ steps: 2, stopReason: "model_finished" });
      expect(submitted).toHaveLength(2);
    });

    it("delayMs opóźnia każdy krok", async () => {
      vi.useFakeTimers();
      const agent = new FakeLessonPoolAgent({ generate: { delayMs: 50 } });
      const { tools, submitted } = scriptedTools([outcome(["independent: 0 of 3"]), outcome([], true)]);
      const run = agent.runObjective(grammarInput(), tools, costSink(), never);
      await vi.advanceTimersByTimeAsync(50);
      expect(submitted).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(49);
      expect(submitted).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(run).resolves.toEqual({ steps: 2, stopReason: "model_finished" });
    });

    it("abort przerywa sen: odrzucenie signal.reason i brak wiszących timerów", async () => {
      vi.useFakeTimers();
      const agent = new FakeLessonPoolAgent({ generate: { delayMs: 10_000 } });
      const { tools, submitted } = scriptedTools([outcome([], true)]);
      const controller = new AbortController();
      const run = agent.runObjective(grammarInput(), tools, costSink(), controller.signal);
      const settled = expect(run).rejects.toThrow("stop");
      await vi.advanceTimersByTimeAsync(1);
      expect(vi.getTimerCount()).toBe(1);
      controller.abort(new Error("stop"));
      await settled;
      expect(vi.getTimerCount()).toBe(0);
      expect(submitted).toHaveLength(0);
    });
  });

  it("record: false nie zapisuje historii", async () => {
    const agent = new FakeLessonPoolAgent({ generate: {}, record: false });
    const { tools } = scriptedTools([outcome([], true)]);
    await agent.runObjective(grammarInput(), tools, costSink(), never);
    const planInput = { subjectTitle: "Angielski", topicTitle: "Unit 1", material: "Słowa:\ncoat — płaszcz", generationRole: "", objectiveCount: { min: 3, max: 6 }, maxSteps: 8 };
    await agent.planObjectives(planInput, { propose: async () => ({ ok: true, errors: [] }), shouldStop: () => false }, costSink(), never);
    expect(agent.calls).toEqual([]);
    expect(agent.planCalls).toEqual([]);

    const recording = new FakeLessonPoolAgent({ generate: {} });
    await recording.runObjective(grammarInput(), scriptedTools([outcome([], true)]).tools, costSink(), never);
    expect(recording.calls).toHaveLength(1);
  });

  it("planista bez plans przy generate daje plan z pokrycia", async () => {
    const agent = new FakeLessonPoolAgent({ generate: {} });
    const proposals: unknown[] = [];
    const planInput = {
      subjectTitle: "Angielski",
      topicTitle: "Unit 1",
      material: "Słowa:\ncoat — płaszcz\nboots — buty\nscarf — szalik",
      generationRole: "",
      objectiveCount: { min: 3, max: 6 },
      coverage: { words: ["coat", "boots", "scarf"], frames: [] },
      maxSteps: 8,
    };
    const result = await agent.planObjectives(
      planInput,
      {
        propose: async (raw) => {
          proposals.push(raw);
          return { ok: true, errors: [] };
        },
        shouldStop: () => false,
      },
      costSink(),
      never,
    );
    expect(result).toEqual({ steps: 1 });
    expect(proposals).toEqual([fakePlanFromCoverage(planInput)]);
  });

  describe("prawdziwy kierownik, checker niedostępny: jeden krok na zagadnienie, bez odrzuceń", () => {
    function runInput(overrides: Partial<LessonPoolAgentRunInput>): LessonPoolAgentRunInput {
      return {
        runId: "run-1",
        subjectId: englishGrammarSubject.id,
        deckId: "42",
        objectiveSource: { source: "planner" },
        topicTitle: "Unit 1",
        material: "",
        poolSize: 0,
        graderAvailable: false,
        fixed: [],
        draftExamples: {},
        skipObjectives: [],
        familyScope: null,
        initialSpentUsd: 0,
        ...overrides,
      };
    }

    beforeEach(() => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    async function run(subject: SubjectModule, overrides: Partial<LessonPoolAgentRunInput>) {
      const agent = new FakeLessonPoolAgent({ generate: {} });
      const checker = new FakeExerciseChecker({ unavailable: true });
      const result = await runLessonPoolAgent(
        { agent, checker, subjects: { getSubject: (id: string) => (id === subject.id ? subject : undefined) } },
        runInput({ subjectId: subject.id, ...overrides }),
        never,
      );
      expect(result.rejections.map((entry) => entry.code)).toEqual([]);
      expect(result.objectives.map((objective) => [objective.status, objective.missing])).toEqual(result.objectives.map(() => ["complete", []]));
      expect(agent.calls.every((call) => call.outcomes.length === 1)).toBe(true);
      return { agent, result };
    }

    it("gramatyka (katalog)", async () => {
      const { result } = await run(englishGrammarSubject, { objectiveSource: { source: "catalog", topic: GRAMMAR_TOPIC }, topicTitle: GRAMMAR_TOPIC.titlePl });
      expect(result.objectives).toHaveLength(GRAMMAR_TOPIC.objectives.length);
    });

    it.each([
      ["Słowa:/Zwroty:", ["Słowa:", "coat — płaszcz", "boots — buty", "scarf — szalik", "gloves — rękawiczki", "Zwroty:", "I am wearing …", "Put on your …"].join("\n")],
      ["bez sekcji", "I wear a coat. I wear boots. She wears a dress. We wear a skirt."],
    ])("rozdział (planer, %s)", async (_name, material) => {
      const { result } = await run(englishChapterSubject, { material, poolSize: 40 });
      expect(result.planStatus).toBe("accepted");
      expect(result.objectives).toHaveLength(3);
    });

    it("szkoła (wejście z fake generateLessonObjectives)", async () => {
      const material = [
        "Zagadnienie 1: Rzeki Polski",
        "Wisła jest najdłuższą rzeką Polski. Odra płynie na zachodzie kraju.",
        "Zagadnienie 2: Góry Polski",
        "Tatry są najwyższymi górami Polski. Sudety leżą na południowym zachodzie.",
      ].join("\n");
      const { objectives } = await new FakeLlmProvider().generateLessonObjectives({
        subjectTitle: schoolSubject.titlePl,
        topicTitle: "Polska",
        material,
        generationRole: schoolSubject.prompts.generationRole,
      });
      const built = buildDynamicTopicData(objectives, schoolSubject.id, "42", "Polska", (objective) =>
        validateDynamicTopicData(schoolSubject, { titlePl: "Polska", objectives: [objective] }),
      );
      const dynamicTopic = withSubjectObjectiveKinds(schoolSubject, built.data!);
      const { result } = await run(schoolSubject, { objectiveSource: { source: "input", dynamicTopic }, topicTitle: "Polska", material });
      expect(result.objectives).toHaveLength(2);
    });
  });
});
