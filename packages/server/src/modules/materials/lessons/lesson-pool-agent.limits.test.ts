import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { A, B, open, subject as fixtureSubject, topic } from "../../../domain/lessons/testing/agent-admission-fixtures";
import { withAgentPolicy } from "../../../domain/lessons/testing/agent-test-subject";
import type { LessonTopic, SubjectModule } from "../../../domain/lessons/types";
import { FakeExerciseChecker, FakeLessonPoolAgent, type FakeAgentStep, type FakeLessonPoolAgentOptions } from "../../../providers/fake-lesson-agent";
import { runLessonPoolAgent, type LessonPoolAgentRunInput } from "./lesson-pool-agent";
import type { LessonAgentPolicy } from "./lesson-pool-agent-policy";

/**
 * Budżet, terminy, przerwanie, równoległość i logi kierownika agenta puli (spec etapu 1 §7.3–7.4).
 * Fake agent zapisuje koszt wywołania modelu PRZED narzędziami (jak onLanguageModelCallEnd w AI SDK).
 */

const SLUG_A = A.split(".").at(-1)!;
const SLUG_B = B.split(".").at(-1)!;

/** Przedmiot ze ślepym rozwiązaniem pytań otwartych: każde `submit` z takim pytaniem woła checker. */
const solving = withAgentPolicy(fixtureSubject, { blindSolveTypes: ["lesson_open_answer"], variantCheckTypes: [] });

function runInput(overrides: Partial<LessonPoolAgentRunInput> = {}): LessonPoolAgentRunInput {
  return {
    runId: "run-1",
    subjectId: solving.id,
    deckId: "42",
    objectiveSource: { source: "catalog", topic },
    topicTitle: "Początki państwa",
    material: "",
    poolSize: 0,
    graderAvailable: false,
    // Jedno zagadnienie (A), chyba że test mówi inaczej.
    fixed: [],
    draftExamples: {},
    skipObjectives: [B],
    familyScope: null,
    initialSpentUsd: 0,
    ...overrides,
  };
}

function setup(options: {
  agent?: FakeLessonPoolAgentOptions;
  checker?: FakeExerciseChecker;
  subjects?: SubjectModule[];
  policy?: Partial<LessonAgentPolicy>;
} = {}) {
  const agent = new FakeLessonPoolAgent(options.agent);
  const checker = options.checker ?? new FakeExerciseChecker({ costUsd: 0 });
  const subjects = options.subjects ?? [solving];
  const deps = {
    agent,
    checker,
    subjects: { getSubject: (id: string) => subjects.find((subject) => subject.id === id) },
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  };
  return { agent, checker, deps };
}

/** `n` kolejnych `submit` z jednym pytaniem otwartym o unikalnej odpowiedzi (każdy woła checker). */
function submits(objectiveId: string, n: number): FakeAgentStep[] {
  return Array.from({ length: n }, (_, i) => ({
    submit: { exercises: [open(objectiveId, `Pytanie numer ${objectiveId.length + i}?`, `wynik ${i}`)] },
  }));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((done) => setTimeout(done, 0));
const never = new AbortController().signal;

/** Temat z `count` zagadnieniami o tych samych zasadach co fixture (typy ćwiczeń przedmiotu testowego). */
function topicOf(count: number): { topic: LessonTopic; ids: string[] } {
  const prefix = A.slice(0, A.lastIndexOf(".") + 1);
  const ids = Array.from({ length: count }, (_, i) => `${prefix}limit${i + 1}`);
  return { topic: { ...topic, objectives: ids.map((id) => ({ ...topic.objectives[0]!, id })) }, ids };
}

beforeEach(() => {
  for (const method of ["log", "error", "warn", "info"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runLessonPoolAgent — budżet runu", () => {
  it("budżet 0,05 przy kroku 0,02: trzecie wywołanie modelu wyczerpuje budżet, trzeci submit dostaje refused_budget", async () => {
    const { agent, checker, deps } = setup({
      agent: { stepCostUsd: 0.02, objectives: { [SLUG_A]: submits(A, 5) } },
      policy: { runBudgetUsd: 0.05 },
    });
    const result = await runLessonPoolAgent(deps, runInput(), never);
    expect(result.spentUsd).toBeCloseTo(0.06, 10);
    expect(result.objectives[0]!.steps).toBe(3);
    expect(checker.solveCalls).toHaveLength(2);
    expect(result.stats).toMatchObject({ refused: 1, checkerCalls: 2 });
    expect(JSON.stringify(agent.calls[0]!.outcomes[2])).toContain("budget exhausted");
    expect(agent.calls[0]!.tools.shouldStop()).toBe(true);
    expect(result.objectives[0]!.status).toBe("incomplete");
  });

  it("przerwanie zagadnienia po „wywołaniu modelu” w trakcie submit: koszt tego wywołania jest w spentUsd", async () => {
    vi.useFakeTimers();
    const checker = new FakeExerciseChecker({ costUsd: 0, solveBatch: () => "hang" });
    const { deps } = setup({
      checker,
      agent: { stepCostUsd: 0.02, objectives: { [SLUG_A]: submits(A, 1) } },
      policy: { objectiveTimeoutMs: 1000 },
    });
    const run = runLessonPoolAgent(deps, runInput(), never);
    await vi.advanceTimersByTimeAsync(0);
    expect(checker.solveCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await run;
    expect(result.spentUsd).toBeCloseTo(0.02, 10);
    expect(result.objectives[0]).toMatchObject({ status: "incomplete", steps: 1 });
    expect(result.objectives[0]!.exercises).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("koszt nieznany (null): każdy krok liczony szacunkiem 0,02, unknownCostCalls = liczba kroków", async () => {
    const { deps } = setup({ agent: { stepCostUsd: null, objectives: { [SLUG_A]: submits(A, 3) } } });
    const result = await runLessonPoolAgent(deps, runInput(), never);
    expect(result.spentUsd).toBeCloseTo(0.06, 10);
    expect(result.unknownCostCalls).toBe(3);
    expect(result.objectives[0]!.steps).toBe(3);
  });

  it("initialSpentUsd 0,99 przy budżecie 1,00: jeden krok, spentUsd 1,01", async () => {
    const { deps } = setup({ agent: { stepCostUsd: 0.02, objectives: { [SLUG_A]: submits(A, 5) } } });
    const result = await runLessonPoolAgent(deps, runInput({ initialSpentUsd: 0.99 }), never);
    expect(result.objectives[0]!.steps).toBe(1);
    expect(result.spentUsd).toBeCloseTo(1.01, 10);
  });

  it("granica przekroczenia: dwa równoległe zagadnienia nie przekraczają budżetu o więcej niż jedno wywołanie na zagadnienie", async () => {
    const { deps } = setup({
      agent: { stepCostUsd: 0.03, objectives: { [SLUG_A]: submits(A, 5), [SLUG_B]: submits(B, 5) } },
      policy: { runBudgetUsd: 0.05, concurrency: 2 },
    });
    const result = await runLessonPoolAgent(deps, runInput({ skipObjectives: [] }), never);
    expect(result.objectives).toHaveLength(2);
    expect(result.spentUsd).toBeLessThanOrEqual(0.05 + 2 * 0.03 + 1e-9);
    expect(result.spentUsd).toBeGreaterThanOrEqual(0.05);
  });
});

describe("runLessonPoolAgent — terminy i przerwanie", () => {
  it("hang agenta + objectiveTimeoutMs 1000: po 1000 ms zagadnienie incomplete (nie failed), run zwraca wynik", async () => {
    vi.useFakeTimers();
    const { deps } = setup({ agent: { objectives: { [SLUG_A]: [{ hang: true }] } }, policy: { objectiveTimeoutMs: 1000 } });
    const run = runLessonPoolAgent(deps, runInput(), never);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void run.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await run;
    expect(result.objectives).toHaveLength(1);
    expect(result.objectives[0]).toMatchObject({ objectiveId: A, status: "incomplete" });
    expect(result.objectives[0]!.failure).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("agent ignorujący przerwanie (stall): termin zagadnienia i tak kończy je jako incomplete, run wraca przed runTimeoutMs", async () => {
    vi.useFakeTimers();
    const { agent, deps } = setup({
      agent: { objectives: { [SLUG_A]: [{ stall: true }] } },
      policy: { objectiveTimeoutMs: 1000, runTimeoutMs: 10_000 },
    });
    let settled = false;
    const run = runLessonPoolAgent(deps, runInput(), never).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const result = await run;
    expect(result.objectives[0]).toMatchObject({ objectiveId: A, status: "incomplete" });
    expect(result.objectives[0]!.failure).toBeUndefined();
    expect(agent.calls[0]!.tools.shouldStop()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checker ignorujący przerwanie (stall): po checkerTimeoutMs paczka unavailable, miejsce w semaforze zwolnione", async () => {
    vi.useFakeTimers();
    let calls = 0;
    // Pierwsze wywołanie nigdy się nie kończy; kolejne odpowiadają zwykle.
    const checker = new FakeExerciseChecker({ costUsd: 0, solveBatch: () => (calls++ === 0 ? "stall" : [["inna"]]) });
    const { deps } = setup({
      checker,
      agent: { objectives: { [SLUG_A]: submits(A, 1), [SLUG_B]: submits(B, 1) } },
      policy: { checkerConcurrency: 1, checkerTimeoutMs: 1000, concurrency: 2 },
    });
    let settled = false;
    const run = runLessonPoolAgent(deps, runInput({ skipObjectives: [] }), never).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    // Jedno miejsce checkera: drugie zagadnienie czeka na zawieszone wywołanie.
    expect(checker.solveCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(checker.solveCalls).toHaveLength(2);
    expect(settled).toBe(true);
    const result = await run;
    expect(result.objectives).toHaveLength(2);
    expect(result.stats).toMatchObject({ checkerCalls: 2, checkUnavailable: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("termin zagadnienia liczy się od startu podagenta, nie od startu runu (zagadnienie czekające na miejsce)", async () => {
    vi.useFakeTimers();
    const { agent, deps } = setup({
      agent: { objectives: { [SLUG_A]: [{ hang: true }], [SLUG_B]: [{ hang: true }] } },
      policy: { objectiveTimeoutMs: 1000, concurrency: 1 },
    });
    const run = runLessonPoolAgent(deps, runInput({ skipObjectives: [] }), never);
    await vi.advanceTimersByTimeAsync(0);
    expect(agent.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    // A skończył się terminem; B startuje dopiero teraz i dostaje własne 1000 ms.
    expect(agent.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(agent.calls[1]!.tools.shouldStop()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await run;
    expect(result.objectives.map((objective) => objective.status)).toEqual(["incomplete", "incomplete"]);
  });

  it("termin runu 2000 ms przy dwóch zawieszonych zagadnieniach: oba incomplete, wynik zwrócony", async () => {
    vi.useFakeTimers();
    const { deps } = setup({
      agent: { objectives: { [SLUG_A]: [{ hang: true }], [SLUG_B]: [{ hang: true }] } },
      policy: { runTimeoutMs: 2000 },
    });
    const run = runLessonPoolAgent(deps, runInput({ skipObjectives: [] }), never);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await run;
    expect(result.planStatus).toBe("not_needed");
    expect(result.objectives.map((objective) => [objective.objectiveId, objective.status])).toEqual([
      [A, "incomplete"],
      [B, "incomplete"],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("przerwanie sygnału runu: run odrzuca signal.reason, narzędzia zagadnień zamknięte, zegary zdjęte", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { agent, deps } = setup({ agent: { objectives: { [SLUG_A]: [{ hang: true }], [SLUG_B]: [{ hang: true }] } } });
    const run = runLessonPoolAgent(deps, runInput({ skipObjectives: [] }), controller.signal);
    const rejection = expect(run).rejects.toBe("superseded");
    await vi.advanceTimersByTimeAsync(0);
    expect(agent.calls).toHaveLength(2);
    controller.abort("superseded");
    await rejection;
    for (const call of agent.calls) expect(call.tools.shouldStop()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sygnał przerwany przed startem: odrzucenie bez żadnego wywołania dostawcy", async () => {
    const controller = new AbortController();
    controller.abort("superseded");
    const { agent, checker, deps } = setup({ agent: { objectives: { [SLUG_A]: submits(A, 1) } } });
    await expect(runLessonPoolAgent(deps, runInput(), controller.signal)).rejects.toBe("superseded");
    expect(agent.calls).toEqual([]);
    expect(checker.solveCalls).toEqual([]);
  });
});

describe("runLessonPoolAgent — równoległość", () => {
  it("sześć zagadnień: najwyżej 4 podagentów i 4 wywołania checkera naraz (domyślna polityka)", async () => {
    const six = topicOf(6);
    const gate = deferred();
    const checker = new FakeExerciseChecker({ costUsd: 0, gate: gate.promise });
    const { agent, deps } = setup({
      checker,
      agent: { objectives: Object.fromEntries(six.ids.map((id) => [id.split(".").at(-1)!, submits(id, 1)])) },
    });
    const run = runLessonPoolAgent(deps, runInput({ objectiveSource: { source: "catalog", topic: six.topic }, skipObjectives: [] }), never);
    await vi.waitFor(() => expect(checker.solveCalls).toHaveLength(4));
    await flush();
    // Piąte i szóste zagadnienie czekają na miejsce, więc checker nie dostał więcej wywołań.
    expect(agent.calls).toHaveLength(4);
    expect(checker.solveCalls).toHaveLength(4);
    gate.resolve();
    const result = await run;
    expect(result.objectives).toHaveLength(6);
    expect(agent.calls).toHaveLength(6);
    expect(agent.maxConcurrent).toBe(4);
    expect(checker.maxConcurrent).toBe(4);
  });

  it("checkerConcurrency 2 przy 6 podagentach: checker obsługuje najwyżej 2 wywołania naraz, a agent 6", async () => {
    const six = topicOf(6);
    const gate = deferred();
    const checker = new FakeExerciseChecker({ costUsd: 0, gate: gate.promise });
    const { agent, deps } = setup({
      checker,
      policy: { concurrency: 6, checkerConcurrency: 2 },
      agent: { objectives: Object.fromEntries(six.ids.map((id) => [id.split(".").at(-1)!, submits(id, 1)])) },
    });
    const run = runLessonPoolAgent(deps, runInput({ objectiveSource: { source: "catalog", topic: six.topic }, skipObjectives: [] }), never);
    await vi.waitFor(() => expect(agent.calls).toHaveLength(6));
    await vi.waitFor(() => expect(checker.solveCalls).toHaveLength(2));
    await flush();
    expect(checker.solveCalls).toHaveLength(2);
    gate.resolve();
    await run;
    expect(checker.solveCalls).toHaveLength(6);
    expect(checker.maxConcurrent).toBe(2);
    expect(agent.maxConcurrent).toBe(6);
  });
});

describe("runLessonPoolAgent — logi", () => {
  it("żaden wpis nie zawiera treści ćwiczeń, materiału, kart ani detail; podsumowanie ma ustalony format", async () => {
    const markers = ["ANSWER-MARKER", "PROMPT-MARKER", "MATERIAL-MARKER", "CARD-MARKER", "EXAMPLE-MARKER", "ERROR-MARKER", "INSTRUCTION-MARKER"];
    const marked: LessonTopic = {
      ...topic,
      objectives: topic.objectives.map((objective) => ({
        ...objective,
        cards: [...objective.cards, { title: "Karta CARD-MARKER", body: "Treść CARD-MARKER." }],
      })),
    };
    const { deps, checker } = setup({
      agent: {
        stepCostUsd: 0.02,
        objectives: {
          [SLUG_A]: [
            { submit: { exercises: [open(A, "Pytanie PROMPT-MARKER?", "ANSWER-MARKER 966")], examples: ["Zdanie EXAMPLE-MARKER."] } },
            { submit: { exercises: [{ exerciseType: "lesson_choice" }] } },
          ],
          [SLUG_B]: [{ throw: new Error("ERROR-MARKER") }],
        },
      },
    });
    const result = await runLessonPoolAgent(
      deps,
      runInput({
        objectiveSource: { source: "catalog", topic: marked },
        skipObjectives: [],
        material: "Materiał MATERIAL-MARKER",
        instruction: "Polecenie INSTRUCTION-MARKER",
        runId: "run-77",
      }),
      never,
    );
    expect(checker.solveCalls.length).toBeGreaterThan(0);
    expect(result.rejections.length).toBeGreaterThan(0);

    const written = (["log", "error", "warn", "info"] as const).flatMap((method) =>
      vi.mocked(console[method]).mock.calls.map((call) => call.map(String).join(" ")),
    );
    expect(written.length).toBeGreaterThan(0);
    for (const line of written) {
      for (const marker of markers) expect(line).not.toContain(marker);
      for (const rejection of result.rejections) expect(line).not.toContain(rejection.detail);
    }

    const summaries = written.filter((line) => line.includes(" obj="));
    expect(summaries).toHaveLength(2);
    const FORMAT =
      /^\[lesson-agent\] run=run-77 obj=[a-z0-9_]+ status=(complete|incomplete|failed)( error=[a-z_]+)? steps=\d+ accepted=\d+ rejected=(-|[a-z_]+:\d+(,[a-z_]+:\d+)*) costUsd=\d+\.\d{4}$/u;
    for (const line of summaries) expect(line).toMatch(FORMAT);
    expect(summaries.find((line) => line.includes(`obj=${SLUG_A} `))).toMatch(/status=incomplete steps=2 accepted=0 rejected=\S*shape_malformed:1\S* costUsd=0\.0400$/u);
    expect(summaries.find((line) => line.includes(`obj=${SLUG_B} `))).toMatch(/status=failed error=\S+ steps=1 accepted=0 rejected=- costUsd=0\.0200$/u);
  });
});
