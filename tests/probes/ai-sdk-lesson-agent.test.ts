import { describe, expect, it } from "vitest";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type {
  LessonAgentToolOutcome,
  LessonObjectiveAgentInput,
  LessonObjectiveAgentTools,
  LessonPoolInput,
  RunCostSink,
} from "../../packages/server/src/ports/ai";
import { AiSdkExerciseChecker, AiSdkLessonPoolAgent, objectiveInstructions, openRouterCostOf } from "./ai-sdk-lesson-agent";

/**
 * Test dymny tymczasowych adapterów AI SDK (etap 1 issue #237, spec §6.1): model zastępuje
 * `MockLanguageModelV4` z `ai/test` — bez sieci i bez kluczy. Sprawdza kontrakt adaptera:
 * materializację przed `submit`, zatrzymanie po `shouldStop()`, koszt każdego żądania przed
 * wykonaniem narzędzi, przerwanie sygnałem i mapowanie wyników checkera po pozycjach.
 */

type MockOptions = NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>;
type GenerateResult = Awaited<ReturnType<Extract<NonNullable<MockOptions["doGenerate"]>, (...args: never[]) => unknown>>>;

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function toolCallResult(toolName: string, input: unknown, cost: number | null = 0.01): GenerateResult {
  return {
    content: [{ type: "tool-call", toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage: USAGE,
    ...(cost === null ? {} : { providerMetadata: { openrouter: { usage: { cost } } } }),
    warnings: [],
  };
}

function textResult(text: string, cost = 0.002): GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: USAGE,
    providerMetadata: { openrouter: { usage: { cost } } },
    warnings: [],
  };
}

const POOL: LessonPoolInput = {
  subjectId: "subject",
  subjectTitle: "Subject",
  answerLocale: "en-GB",
  promptLocale: "pl-PL",
  promptProfile: { generationRole: "role", gradingRole: "grade", almostDefinition: "almost" },
  exerciseTypes: ["lesson_card", "lesson_choice", "lesson_match", "lesson_gap"],
  transforms: [],
  objectives: [{ id: "subject.topic.animals", descriptionEn: "Animals", exerciseTypes: ["lesson_choice", "lesson_match", "lesson_gap"], errorCategories: [] }],
  material: "cat — kot",
  countPerObjective: 6,
  stageCounts: { guided: 2, productive: 2, independent: 2 },
  graderAvailable: false,
};

function agentInput(overrides: Partial<LessonObjectiveAgentInput> = {}): LessonObjectiveAgentInput {
  return {
    pool: POOL,
    objective: { id: "subject.topic.animals", title: "Zwierzęta", cards: [{ title: "Słowa", body: "cat — kot" }], examplesFromPlan: false },
    otherObjectives: [],
    cardSentences: [],
    targets: { guided: 2, productive: 2, independent: 3, requiredTypes: [], targetCount: 6, listenAllowance: 0, maxExercises: 8 },
    maxSteps: 8,
    ...overrides,
  };
}

const OUTCOME: LessonAgentToolOutcome = {
  results: [{ index: 0, accepted: "ex1" }],
  counts: { guided: 1, productive: 0, independent: 0, outsideStages: 0, total: 1 },
  missing: ["productive: 0 of 2"],
  complete: false,
};

/** Surowy rekord dopasowania z fałszywą odpowiedzią: materializacja składa ją z par. */
const RAW_MATCH = {
  exerciseType: "lesson_match",
  objectiveId: "subject.topic.animals",
  instructionPl: "Połącz słowo z tłumaczeniem.",
  pairs: [
    { left: "cat", right: "kot" },
    { left: "dog", right: "pies" },
    { left: "cow", right: "krowa" },
  ],
  extraRight: ["koń"],
  answer: "zmyślona",
};

function recordingCost(log: string[]): RunCostSink & { values: (number | null)[] } {
  const values: (number | null)[] = [];
  return {
    values,
    record(usd) {
      values.push(usd);
      log.push(`cost:${usd}`);
    },
  };
}

function fakeTools(log: string[], options: { stopAfterSubmit?: boolean; submit?: () => Promise<LessonAgentToolOutcome> } = {}) {
  const submitted: { exercises: readonly unknown[]; examples?: readonly unknown[] }[] = [];
  let stop = false;
  const tools: LessonObjectiveAgentTools = {
    async submit(raw) {
      log.push("submit");
      submitted.push(raw);
      if (options.stopAfterSubmit) stop = true;
      return options.submit ? options.submit() : OUTCOME;
    },
    async remove() {
      return { ...OUTCOME, removed: [] };
    },
    shouldStop: () => stop,
  };
  return { tools, submitted };
}

describe("openRouterCostOf", () => {
  const meta = (cost: unknown) => ({ openrouter: { usage: { cost } } }) as never;

  it("koszt liczbowy ≥ 0 przechodzi, brak, nie-liczba i wartość ujemna to nieznany", () => {
    expect(openRouterCostOf(meta(0.0123))).toBe(0.0123);
    expect(openRouterCostOf(meta(0))).toBe(0);
    expect(openRouterCostOf(meta(-0.01))).toBeNull();
    expect(openRouterCostOf(meta(Number.NaN))).toBeNull();
    expect(openRouterCostOf(meta("0.01"))).toBeNull();
    expect(openRouterCostOf(undefined)).toBeNull();
  });
});

describe("objectiveInstructions (dopisek przepływu narzędzi)", () => {
  it("dopisuje promptNotes przedmiotu; bez nich nie ma reguły o podpowiedzi (gramatyka zachowuje hint)", () => {
    const noted = objectiveInstructions(agentInput({ promptNotes: ["NOTE-ONE about hints.", "NOTE-TWO."] }));
    expect(noted).toContain("NOTE-ONE about hints.");
    expect(noted).toContain("NOTE-TWO.");
    const plain = objectiveInstructions(agentInput());
    expect(plain).not.toContain("NOTE-ONE");
    expect(plain).not.toContain("Hint only for lesson_open_answer");
  });
});

describe("AiSdkLessonPoolAgent (MockLanguageModelV4, bez sieci)", () => {
  it("materializuje surowe rekordy przed submit i kończy pętlę po kroku, gdy shouldStop() zwraca true", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [toolCallResult("submit_exercises", { exercises: [RAW_MATCH], examples: ["I have a cat."] }), textResult("never reached")],
    });
    const log: string[] = [];
    const { tools, submitted } = fakeTools(log, { stopAfterSubmit: true });
    const cost = recordingCost(log);

    const result = await new AiSdkLessonPoolAgent({ model, effort: "low" }).runObjective(agentInput(), tools, cost, new AbortController().signal);

    expect(result).toEqual({ steps: 1, stopReason: "stopped" });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.examples).toEqual(["I have a cat."]);
    expect(submitted[0]!.exercises[0]).toMatchObject({ exerciseType: "lesson_match", answer: "cat, dog, cow", acceptedAnswers: [], focus: [] });
    expect(cost.values).toEqual([0.01]);
    // Opcje dostawcy, bez ponowień SDK.
    expect(model.doGenerateCalls[0]!.providerOptions).toEqual({ openrouter: { reasoning: { effort: "low" } } });
  });

  it("nie woła modelu, gdy zagadnienie jest zamknięte przed pierwszym krokiem", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [textResult("unused")] });
    const tools: LessonObjectiveAgentTools = { submit: async () => OUTCOME, remove: async () => ({ ...OUTCOME, removed: [] }), shouldStop: () => true };
    const result = await new AiSdkLessonPoolAgent({ model, effort: "low" }).runObjective(agentInput(), tools, recordingCost([]), new AbortController().signal);
    expect(result).toEqual({ steps: 0, stopReason: "stopped" });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("model kończy bez wywołania narzędzia → model_finished; przykłady planu nie trafiają do schematu", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [textResult("done")] });
    const log: string[] = [];
    const { tools } = fakeTools(log);
    const input = agentInput({ objective: { ...agentInput().objective, examplesFromPlan: true } });
    const result = await new AiSdkLessonPoolAgent({ model, effort: "low" }).runObjective(input, tools, recordingCost(log), new AbortController().signal);
    expect(result).toEqual({ steps: 1, stopReason: "model_finished" });
    const submitTool = model.doGenerateCalls[0]!.tools?.find((candidate) => candidate.name === "submit_exercises") as { inputSchema: { properties: object } } | undefined;
    expect(Object.keys(submitTool!.inputSchema.properties)).toEqual(["exercises"]);
  });

  it("zapisuje koszt żądania przed wykonaniem narzędzia; przerwanie sygnałem w trakcie narzędzia odrzuca wywołanie", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [toolCallResult("submit_exercises", { exercises: [RAW_MATCH] })] });
    const log: string[] = [];
    const controller = new AbortController();
    // Narzędzie z opóźnieniem, które nigdy się nie kończy samo: przerwanie przychodzi w jego trakcie.
    const { tools } = fakeTools(log, {
      submit: () => {
        controller.abort(new Error("objective_timeout"));
        return new Promise<LessonAgentToolOutcome>(() => undefined);
      },
    });
    const cost = recordingCost(log);

    await expect(new AiSdkLessonPoolAgent({ model, effort: "low" }).runObjective(agentInput(), tools, cost, controller.signal)).rejects.toThrow("objective_timeout");
    expect(log).toEqual(["cost:0.01", "submit"]);
    expect(cost.values).toEqual([0.01]);
  });

  it("przerwany sygnał przed startem odrzuca wywołanie bez żądania", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [textResult("unused")] });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const { tools } = fakeTools([]);
    await expect(new AiSdkLessonPoolAgent({ model, effort: "low" }).runObjective(agentInput(), tools, recordingCost([]), controller.signal)).rejects.toThrow("cancelled");
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("żądanie bez odpowiedzi (wyjątek modelu) zgłasza koszt null i rzuca dalej", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("provider down");
      },
    });
    const log: string[] = [];
    const { tools } = fakeTools(log);
    const cost = recordingCost(log);
    await expect(new AiSdkLessonPoolAgent({ model, effort: "low" }).runObjective(agentInput(), tools, cost, new AbortController().signal)).rejects.toThrow("provider down");
    expect(cost.values).toEqual([null]);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("brak usage.cost w metadanych → koszt null; planista oddaje surową propozycję do propose", async () => {
    const plan = { objectives: [{ slug: "animals", titlePl: "Zwierzęta", descriptionEn: "Animals", kind: "words", cards: [], examples: [] }] };
    const model = new MockLanguageModelV4({ doGenerate: [toolCallResult("propose_objectives", plan, null), textResult("ok")] });
    const proposals: unknown[] = [];
    let accepted = false;
    const cost = recordingCost([]);
    const result = await new AiSdkLessonPoolAgent({ model, effort: "medium" }).planObjectives(
      {
        subjectTitle: "Subject",
        topicTitle: "Unit 1",
        material: "cat — kot",
        generationRole: "role",
        objectiveCount: { min: 3, max: 6 },
        maxSteps: 8,
      },
      {
        propose: async (raw) => {
          proposals.push(raw);
          accepted = true;
          return { ok: true, errors: [] };
        },
        shouldStop: () => accepted,
      },
      cost,
      new AbortController().signal,
    );
    expect(result).toEqual({ steps: 1 });
    expect(proposals).toEqual([plan]);
    expect(cost.values).toEqual([null]);
  });
});

describe("AiSdkExerciseChecker (MockLanguageModelV4, bez sieci)", () => {
  it("solve mapuje answers po pozycjach; brakująca albo zła pozycja → null; koszt żądania zapisany", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [textResult(JSON.stringify({ answers: [["cat"], ["dog", "cow"]] }), 0.003)] });
    const cost = recordingCost([]);
    const result = await new AiSdkExerciseChecker({ model, effort: "low" }).solve(
      { items: [{ view: "A", expectedAnswers: 1 }, { view: "B", expectedAnswers: 2 }, { view: "C", expectedAnswers: 1 }] },
      cost,
      new AbortController().signal,
    );
    expect(result.answers).toEqual([["cat"], ["dog", "cow"], null]);
    expect(cost.values).toEqual([0.003]);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("solve dołącza materiał tylko, gdy jest w wejściu", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [textResult(JSON.stringify({ answers: [["a"]] })), textResult(JSON.stringify({ answers: [["a"]] }))],
    });
    const checker = new AiSdkExerciseChecker({ model, effort: "low" });
    await checker.solve({ items: [{ view: "A", expectedAnswers: 1 }] }, recordingCost([]), new AbortController().signal);
    await checker.solve({ items: [{ view: "A", expectedAnswers: 1 }], material: "MATERIAL-TEXT" }, recordingCost([]), new AbortController().signal);
    const prompts = model.doGenerateCalls.map((call) => JSON.stringify(call.prompt));
    expect(prompts[0]).not.toContain("MATERIAL-TEXT");
    expect(prompts[1]).toContain("MATERIAL-TEXT");
  });

  it("judgeVariants mapuje equivalent po pozycjach; zła długość → null", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [textResult(JSON.stringify({ equivalent: [[true, false], [true]] }))] });
    const result = await new AiSdkExerciseChecker({ model, effort: "low" }).judgeVariants(
      {
        items: [
          { view: "A", answer: "I am", variants: ["I'm", "I was"] },
          { view: "B", answer: "it is", variants: ["it's", "its"] },
        ],
      },
      recordingCost([]),
      new AbortController().signal,
    );
    expect(result.equivalent).toEqual([[true, false], null]);
  });

  it("solve: zły kształt jednej pozycji daje null tylko dla niej, reszta paczki przechodzi", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [textResult(JSON.stringify({ answers: [["cat"], [1, 2], null, ["cow"]] }))] });
    const result = await new AiSdkExerciseChecker({ model, effort: "low" }).solve(
      { items: ["A", "B", "C", "D"].map((view) => ({ view, expectedAnswers: 1 })) },
      recordingCost([]),
      new AbortController().signal,
    );
    expect(result.answers).toEqual([["cat"], null, null, ["cow"]]);
  });

  it("judgeVariants: zły kształt jednej pozycji daje null tylko dla niej", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [textResult(JSON.stringify({ equivalent: [[true], "yes", [false]] }))] });
    const result = await new AiSdkExerciseChecker({ model, effort: "low" }).judgeVariants(
      { items: ["A", "B", "C"].map((view) => ({ view, answer: "x", variants: ["y"] })) },
      recordingCost([]),
      new AbortController().signal,
    );
    expect(result.equivalent).toEqual([[true], null, [false]]);
  });

  it("maxRetries 0: błąd z isRetryable nie jest ponawiany przez SDK — jedno żądanie, jeden koszt null", async () => {
    const retryable = () =>
      new APICallError({ message: "rate limited", url: "https://example.invalid/v1", requestBodyValues: {}, statusCode: 429, isRetryable: true });
    const checkerModel = new MockLanguageModelV4({
      doGenerate: async () => {
        throw retryable();
      },
    });
    const checkerCost = recordingCost([]);
    await expect(
      new AiSdkExerciseChecker({ model: checkerModel, effort: "low" }).solve({ items: [{ view: "A", expectedAnswers: 1 }] }, checkerCost, new AbortController().signal),
    ).rejects.toThrow("rate limited");
    expect(checkerModel.doGenerateCalls).toHaveLength(1);
    expect(checkerCost.values).toEqual([null]);

    const agentModel = new MockLanguageModelV4({
      doGenerate: async () => {
        throw retryable();
      },
    });
    const agentCost = recordingCost([]);
    await expect(
      new AiSdkLessonPoolAgent({ model: agentModel, effort: "low" }).runObjective(agentInput(), fakeTools([]).tools, agentCost, new AbortController().signal),
    ).rejects.toThrow("rate limited");
    expect(agentModel.doGenerateCalls).toHaveLength(1);
    expect(agentCost.values).toEqual([null]);
  });

  it("wyjątek modelu checkera → koszt null i odrzucenie", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("timeout");
      },
    });
    const cost = recordingCost([]);
    await expect(
      new AiSdkExerciseChecker({ model, effort: "low" }).solve({ items: [{ view: "A", expectedAnswers: 1 }] }, cost, new AbortController().signal),
    ).rejects.toThrow("timeout");
    expect(cost.values).toEqual([null]);
  });
});
