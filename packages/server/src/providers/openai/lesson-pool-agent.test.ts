import { afterEach, describe, expect, it, vi } from "vitest";
import { APICallError, InvalidToolInputError, JSONParseError, NoObjectGeneratedError, NoOutputGeneratedError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type {
  LessonAgentToolOutcome,
  LessonObjectiveAgentInput,
  LessonObjectiveAgentTools,
  LessonPoolInput,
  RunCostSink,
} from "../../ports/ai";
import { GenerationProviderError } from "../../ports/generation-error";
import { currentUsageScope, withUsageScope, type UsageEvent, type UsageScope } from "../../ports/usage";
import { createTestRecorder } from "../usage/test-recorder";
import {
  AiSdkExerciseChecker,
  AiSdkLessonPoolAgent,
  objectiveInstructions,
  OPENROUTER_BASE_URL,
  openRouterCostOf,
  toGenerationProviderError,
  type AiSdkLessonAgentOptions,
} from "./lesson-pool-agent";

/**
 * Testy produkcyjnego adaptera AI SDK agenta puli (issue #237, etap 1 §6.1, etap 2a §4 i §12):
 * model zastępuje `MockLanguageModelV4` z `ai/test` albo zaślepiony `fetch` — bez sieci i bez
 * kluczy. Sprawdza kontrakt adaptera: materializację przed `submit`, zatrzymanie po
 * `shouldStop()`, koszt i zapis kosztów każdego żądania, przerwanie sygnałem, mapowanie błędów
 * na `GenerationProviderError`, opcje dostawcy, jawny klucz i host oraz wyniki checkera.
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

    const result = await new AiSdkLessonPoolAgent({ apiKey: "", model: "test-model", effort: "low", languageModel: model }).runObjective(agentInput(), tools, cost, new AbortController().signal);

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
    const result = await new AiSdkLessonPoolAgent({ apiKey: "", model: "test-model", effort: "low", languageModel: model }).runObjective(agentInput(), tools, recordingCost([]), new AbortController().signal);
    expect(result).toEqual({ steps: 0, stopReason: "stopped" });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("model kończy bez wywołania narzędzia → model_finished; przykłady planu nie trafiają do schematu", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [textResult("done")] });
    const log: string[] = [];
    const { tools } = fakeTools(log);
    const input = agentInput({ objective: { ...agentInput().objective, examplesFromPlan: true } });
    const result = await new AiSdkLessonPoolAgent({ apiKey: "", model: "test-model", effort: "low", languageModel: model }).runObjective(input, tools, recordingCost(log), new AbortController().signal);
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

    await expect(new AiSdkLessonPoolAgent({ apiKey: "", model: "test-model", effort: "low", languageModel: model }).runObjective(agentInput(), tools, cost, controller.signal)).rejects.toThrow("objective_timeout");
    expect(log).toEqual(["cost:0.01", "submit"]);
    expect(cost.values).toEqual([0.01]);
  });

  it("przerwany sygnał przed startem odrzuca wywołanie bez żądania", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [textResult("unused")] });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const { tools } = fakeTools([]);
    await expect(new AiSdkLessonPoolAgent({ apiKey: "", model: "test-model", effort: "low", languageModel: model }).runObjective(agentInput(), tools, recordingCost([]), controller.signal)).rejects.toThrow("cancelled");
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
    await expect(new AiSdkLessonPoolAgent({ apiKey: "", model: "test-model", effort: "low", languageModel: model }).runObjective(agentInput(), tools, cost, new AbortController().signal)).rejects.toThrow("provider down");
    expect(cost.values).toEqual([null]);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("brak usage.cost w metadanych → koszt null; planista oddaje surową propozycję do propose", async () => {
    const plan = { objectives: [{ slug: "animals", titlePl: "Zwierzęta", descriptionEn: "Animals", kind: "words", cards: [], examples: [] }] };
    const model = new MockLanguageModelV4({ doGenerate: [toolCallResult("propose_objectives", plan, null), textResult("ok")] });
    const proposals: unknown[] = [];
    let accepted = false;
    const cost = recordingCost([]);
    const result = await new AiSdkLessonPoolAgent({ apiKey: "", model: "test-model", effort: "medium", languageModel: model }).planObjectives(
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
    const result = await new AiSdkExerciseChecker({ apiKey: "", model: "test-model", effort: "low", languageModel: model }).solve(
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
    const checker = new AiSdkExerciseChecker({ apiKey: "", model: "test-model", effort: "low", languageModel: model });
    await checker.solve({ items: [{ view: "A", expectedAnswers: 1 }] }, recordingCost([]), new AbortController().signal);
    await checker.solve({ items: [{ view: "A", expectedAnswers: 1 }], material: "MATERIAL-TEXT" }, recordingCost([]), new AbortController().signal);
    const prompts = model.doGenerateCalls.map((call) => JSON.stringify(call.prompt));
    expect(prompts[0]).not.toContain("MATERIAL-TEXT");
    expect(prompts[1]).toContain("MATERIAL-TEXT");
  });

  it("judgeVariants mapuje equivalent po pozycjach; zła długość → null", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [textResult(JSON.stringify({ equivalent: [[true, false], [true]] }))] });
    const result = await new AiSdkExerciseChecker({ apiKey: "", model: "test-model", effort: "low", languageModel: model }).judgeVariants(
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
    const result = await new AiSdkExerciseChecker({ apiKey: "", model: "test-model", effort: "low", languageModel: model }).solve(
      { items: ["A", "B", "C", "D"].map((view) => ({ view, expectedAnswers: 1 })) },
      recordingCost([]),
      new AbortController().signal,
    );
    expect(result.answers).toEqual([["cat"], null, null, ["cow"]]);
  });

  it("judgeVariants: zły kształt jednej pozycji daje null tylko dla niej", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [textResult(JSON.stringify({ equivalent: [[true], "yes", [false]] }))] });
    const result = await new AiSdkExerciseChecker({ apiKey: "", model: "test-model", effort: "low", languageModel: model }).judgeVariants(
      { items: ["A", "B", "C"].map((view) => ({ view, answer: "x", variants: ["y"] })) },
      recordingCost([]),
      new AbortController().signal,
    );
    expect(result.equivalent).toEqual([[true], null, [false]]);
  });

  it("maxRetries 0: błąd z isRetryable nie jest ponawiany przez SDK — jedno żądanie, koszt 0 odrzuconego żądania", async () => {
    const retryable = () =>
      new APICallError({ message: "rate limited", url: "https://example.invalid/v1", requestBodyValues: {}, statusCode: 429, isRetryable: true });
    const checkerModel = new MockLanguageModelV4({
      doGenerate: async () => {
        throw retryable();
      },
    });
    const checkerCost = recordingCost([]);
    await expect(
      new AiSdkExerciseChecker({ apiKey: "", model: "test-model", effort: "low", languageModel: checkerModel }).solve({ items: [{ view: "A", expectedAnswers: 1 }] }, checkerCost, new AbortController().signal),
    ).rejects.toMatchObject({ name: "GenerationProviderError", kind: "rate_limit", status: 429 });
    expect(checkerModel.doGenerateCalls).toHaveLength(1);
    expect(checkerCost.values).toEqual([0]);

    const agentModel = new MockLanguageModelV4({
      doGenerate: async () => {
        throw retryable();
      },
    });
    const agentCost = recordingCost([]);
    await expect(
      new AiSdkLessonPoolAgent({ apiKey: "", model: "test-model", effort: "low", languageModel: agentModel }).runObjective(agentInput(), fakeTools([]).tools, agentCost, new AbortController().signal),
    ).rejects.toMatchObject({ name: "GenerationProviderError", kind: "rate_limit", status: 429 });
    expect(agentModel.doGenerateCalls).toHaveLength(1);
    expect(agentCost.values).toEqual([0]);
  });

  it("wyjątek modelu checkera → koszt null i odrzucenie", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("timeout");
      },
    });
    const cost = recordingCost([]);
    await expect(
      new AiSdkExerciseChecker({ apiKey: "", model: "test-model", effort: "low", languageModel: model }).solve({ items: [{ view: "A", expectedAnswers: 1 }] }, cost, new AbortController().signal),
    ).rejects.toThrow("timeout");
    expect(cost.values).toEqual([null]);
  });
});

// ---------------------------------------------------------------------------------------------
// Etap 2a (§4, §12): błędy, koszty, opcje dostawcy, klucz i host

function agentOptions(languageModel: AiSdkLessonAgentOptions["languageModel"], extra: Partial<AiSdkLessonAgentOptions> = {}): AiSdkLessonAgentOptions {
  return { apiKey: "", model: "test-model", effort: "low", ...(languageModel === undefined ? {} : { languageModel }), ...extra };
}

function apiError(statusCode: number | undefined, extra: { responseHeaders?: Record<string, string>; isRetryable?: boolean } = {}): APICallError {
  return new APICallError({
    message: "SECRET-PROMPT failed",
    url: "https://openrouter.ai/api/v1/chat/completions",
    requestBodyValues: { messages: ["SECRET-PROMPT"] },
    ...(statusCode === undefined ? {} : { statusCode }),
    responseBody: "SECRET-BODY",
    ...extra,
  });
}

function throwingModel(error: () => unknown) {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      throw error();
    },
  });
}

/** Rekorder z zakresem kosztów z chwili zapisu (zakres dokłada recorder produkcyjny). */
function scopedRecorder() {
  const events: { event: UsageEvent; scope: UsageScope | undefined }[] = [];
  return {
    events,
    record(event: UsageEvent) {
      events.push({ event, scope: currentUsageScope() });
    },
    flush: async () => {},
  };
}

const SOLVE_INPUT = { items: [{ view: "A", expectedAnswers: 1 }] };
const JUDGE_INPUT = { items: [{ view: "A", answer: "I am", variants: ["I'm"] }] };
const PLAN_INPUT = {
  subjectTitle: "Subject",
  topicTitle: "Unit 1",
  material: "cat — kot",
  generationRole: "role",
  objectiveCount: { min: 3, max: 6 },
  maxSteps: 8,
};

function chatCompletion(content: string, cost = 0.0042) {
  return {
    id: "gen-1",
    object: "chat.completion",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15, cost },
  };
}

/** Zaślepiony `fetch`: kolejne odpowiedzi z listy, zapis adresu, nagłówków i ciała każdego żądania. */
function stubFetch(responses: readonly (() => Response)[]) {
  const calls: { url: string; headers: Headers; body: unknown }[] = [];
  const fetchStub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    });
    const next = responses[calls.length - 1];
    if (next === undefined) throw new Error("unexpected request");
    return next();
  };
  return { calls, fetch: fetchStub as typeof fetch };
}

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("mapowanie błędów (toGenerationProviderError, spec §4)", () => {
  const signal = new AbortController().signal;

  it.each([
    [401, "configuration"],
    [402, "configuration"],
    [403, "configuration"],
    [408, "transient"],
    [500, "transient"],
    [503, "transient"],
    [400, "output"],
    [422, "output"],
  ] as const)("APICallError %i → %s, status zachowany, bez cause i treści", (status, kind) => {
    const mapped = toGenerationProviderError(apiError(status), signal);
    expect(mapped).toBeInstanceOf(GenerationProviderError);
    expect(mapped).toMatchObject({ kind, status });
    expect((mapped as Error).cause).toBeUndefined();
    expect(JSON.stringify({ ...(mapped as object), message: (mapped as Error).message })).not.toMatch(/SECRET/u);
  });

  it("429 → rate_limit z retryAfterMs z nagłówka retry-after", () => {
    expect(toGenerationProviderError(apiError(429, { responseHeaders: { "retry-after": "7" } }), signal)).toMatchObject({
      kind: "rate_limit",
      status: 429,
      retryAfterMs: 7000,
    });
    const withoutHeader = toGenerationProviderError(apiError(429), signal) as GenerationProviderError;
    expect(withoutHeader.kind).toBe("rate_limit");
    expect(withoutHeader.retryAfterMs).toBeUndefined();
  });

  it("błąd sieci (bez statusu) i isRetryable → transient", () => {
    expect(toGenerationProviderError(apiError(undefined, { isRetryable: true }), signal)).toMatchObject({ kind: "transient" });
    expect(toGenerationProviderError(apiError(409, { isRetryable: true }), signal)).toMatchObject({ kind: "transient", status: 409 });
  });

  it("NoObjectGeneratedError, NoOutputGeneratedError, InvalidToolInputError i błąd JSON → output bez cause", () => {
    const errors = [
      new NoObjectGeneratedError({
        message: "SECRET",
        text: "SECRET",
        response: { id: "r", timestamp: new Date(0), modelId: "m" },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as never,
        finishReason: "stop",
      }),
      new NoOutputGeneratedError({ message: "SECRET" }),
      new InvalidToolInputError({ toolName: "submit_exercises", toolInput: "SECRET", cause: new Error("SECRET") }),
      new JSONParseError({ text: "SECRET{", cause: new Error("SECRET") }),
    ];
    for (const error of errors) {
      const mapped = toGenerationProviderError(error, signal);
      expect(mapped, error.name).toBeInstanceOf(GenerationProviderError);
      expect(mapped).toMatchObject({ kind: "output" });
      expect((mapped as Error).cause).toBeUndefined();
      expect((mapped as Error).message).not.toMatch(/SECRET/u);
    }
  });

  it("przerwany sygnał → signal.reason bez zmian, nawet dla błędu SDK", () => {
    const controller = new AbortController();
    const reason = new Error("objective_timeout");
    controller.abort(reason);
    expect(toGenerationProviderError(apiError(500), controller.signal)).toBe(reason);
    expect(toGenerationProviderError(new Error("AbortError"), controller.signal)).toBe(reason);
  });

  it("błąd kodu (TypeError z narzędzia kierownika) przechodzi bez zmian", () => {
    const bug = new TypeError("cannot read properties of undefined");
    expect(toGenerationProviderError(bug, signal)).toBe(bug);
    const plain = new Error("provider down");
    expect(toGenerationProviderError(plain, signal)).toBe(plain);
  });

  it("TypeError w narzędziu kierownika: wywołanie odrzuca ten sam błąd, a jego komunikat nie trafia do modelu", async () => {
    const bug = new TypeError("BUG-IN-TOOL");
    const objectiveModel = new MockLanguageModelV4({ doGenerate: [toolCallResult("submit_exercises", { exercises: [RAW_MATCH] }), textResult("never reached")] });
    const { tools } = fakeTools([], {
      submit: async () => {
        throw bug;
      },
    });
    await expect(new AiSdkLessonPoolAgent(agentOptions(objectiveModel)).runObjective(agentInput(), tools, recordingCost([]), signal)).rejects.toBe(bug);
    expect(objectiveModel.doGenerateCalls).toHaveLength(1);

    const planModel = new MockLanguageModelV4({ doGenerate: [toolCallResult("propose_objectives", { objectives: [] }), textResult("never reached")] });
    await expect(
      new AiSdkLessonPoolAgent(agentOptions(planModel)).planObjectives(
        PLAN_INPUT,
        {
          propose: async () => {
            throw bug;
          },
          shouldStop: () => false,
        },
        recordingCost([]),
        signal,
      ),
    ).rejects.toBe(bug);
    expect(planModel.doGenerateCalls).toHaveLength(1);
  });

  it("adapter rzuca zmapowany błąd z wywołania modelu (agent, planista, checker)", async () => {
    const signal = new AbortController().signal;
    await expect(
      new AiSdkLessonPoolAgent(agentOptions(throwingModel(() => apiError(401)))).runObjective(agentInput(), fakeTools([]).tools, recordingCost([]), signal),
    ).rejects.toMatchObject({ name: "GenerationProviderError", kind: "configuration", status: 401 });
    await expect(
      new AiSdkLessonPoolAgent(agentOptions(throwingModel(() => apiError(503)))).planObjectives(
        PLAN_INPUT,
        { propose: async () => ({ ok: true, errors: [] }), shouldStop: () => false },
        recordingCost([]),
        signal,
      ),
    ).rejects.toMatchObject({ kind: "transient", status: 503 });
    await expect(new AiSdkExerciseChecker(agentOptions(throwingModel(() => apiError(422)))).judgeVariants(JUDGE_INPUT, recordingCost([]), signal)).rejects.toMatchObject({
      kind: "output",
      status: 422,
    });
  });

  it("odpowiedź checkera niezgodna ze schematem wyniku → output", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [textResult("not json at all")] });
    await expect(new AiSdkExerciseChecker(agentOptions(model)).solve(SOLVE_INPUT, recordingCost([]), new AbortController().signal)).rejects.toMatchObject({
      name: "GenerationProviderError",
      kind: "output",
    });
  });
});

describe("koszty żądań (UsageRecorder i RunCostSink, spec §4)", () => {
  it("usage ok raz na żądanie dla każdej operacji; zdarzenie ma zakres runu", async () => {
    const usage = scopedRecorder();
    const signal = new AbortController().signal;
    await withUsageScope({ generationRunId: "run-1" }, async () => {
      // agent_objective: dwa żądania (wywołanie narzędzia i zakończenie tekstem).
      const objectiveModel = new MockLanguageModelV4({
        doGenerate: [toolCallResult("submit_exercises", { exercises: [RAW_MATCH] }, 0.01), textResult("done", 0.002)],
      });
      await new AiSdkLessonPoolAgent(agentOptions(objectiveModel, { usage })).runObjective(agentInput(), fakeTools([]).tools, recordingCost([]), signal);
      const planModel = new MockLanguageModelV4({ doGenerate: [textResult("no plan", 0.003)] });
      await new AiSdkLessonPoolAgent(agentOptions(planModel, { usage })).planObjectives(
        PLAN_INPUT,
        { propose: async () => ({ ok: true, errors: [] }), shouldStop: () => false },
        recordingCost([]),
        signal,
      );
      const solveModel = new MockLanguageModelV4({ doGenerate: [textResult(JSON.stringify({ answers: [["a"]] }), 0.004)] });
      await new AiSdkExerciseChecker(agentOptions(solveModel, { usage })).solve(SOLVE_INPUT, recordingCost([]), signal);
      const judgeModel = new MockLanguageModelV4({ doGenerate: [textResult(JSON.stringify({ equivalent: [[true]] }), 0.005)] });
      await new AiSdkExerciseChecker(agentOptions(judgeModel, { usage })).judgeVariants(JUDGE_INPUT, recordingCost([]), signal);
    });

    const ok = (operation: string, providerCostUsd: number): UsageEvent => ({
      feature: "lesson_generation",
      operation,
      provider: "openrouter",
      model: "test-model",
      outcome: "ok",
      httpStatus: 200,
      inputTokens: 10,
      outputTokens: 5,
      providerCostUsd,
    });
    expect(usage.events.map((entry) => entry.event)).toEqual([
      ok("agent_objective", 0.01),
      ok("agent_objective", 0.002),
      ok("agent_plan", 0.003),
      ok("check_solve", 0.004),
      ok("check_variants", 0.005),
    ]);
    expect(usage.events.every((entry) => entry.scope?.generationRunId === "run-1")).toBe(true);
  });

  it("brak usage.cost w metadanych → zdarzenie ok bez providerCostUsd, RunCostSink null", async () => {
    const usage = createTestRecorder();
    const cost = recordingCost([]);
    const model = new MockLanguageModelV4({ doGenerate: [toolCallResult("submit_exercises", { exercises: [] }, null), textResult("done")] });
    const { tools } = fakeTools([], { stopAfterSubmit: true });
    await new AiSdkLessonPoolAgent(agentOptions(model, { usage })).runObjective(agentInput(), tools, cost, new AbortController().signal);
    expect(cost.values).toEqual([null]);
    expect(usage.events).toHaveLength(1);
    expect(usage.events[0]).not.toHaveProperty("providerCostUsd");
    expect(usage.events[0]).toMatchObject({ outcome: "ok", operation: "agent_objective", inputTokens: 10, outputTokens: 5 });
  });

  it("błąd HTTP: recordHttpError z httpStatus, RunCostSink 0", async () => {
    const usage = createTestRecorder();
    const cost = recordingCost([]);
    await expect(
      new AiSdkExerciseChecker(agentOptions(throwingModel(() => apiError(500)), { usage })).solve(SOLVE_INPUT, cost, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "transient" });
    expect(cost.values).toEqual([0]);
    expect(usage.events).toEqual([
      { feature: "lesson_generation", operation: "check_solve", provider: "openrouter", model: "test-model", outcome: "failed", httpStatus: 500 },
    ]);
  });

  it("odpowiedź po kroku z wywołaniem narzędzia, potem błąd HTTP: koszt pierwszego żądania i 0 za drugie", async () => {
    const usage = createTestRecorder();
    const cost = recordingCost([]);
    let call = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call += 1;
        if (call === 1) return toolCallResult("submit_exercises", { exercises: [RAW_MATCH] }, 0.01);
        throw apiError(429, { responseHeaders: { "retry-after": "3" } });
      },
    });
    await expect(
      new AiSdkLessonPoolAgent(agentOptions(model, { usage })).runObjective(agentInput(), fakeTools([]).tools, cost, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "rate_limit", retryAfterMs: 3000 });
    expect(cost.values).toEqual([0.01, 0]);
    expect(usage.events.map((event) => [event.outcome, event.httpStatus])).toEqual([
      ["ok", 200],
      ["failed", 429],
    ]);
  });

  it("brak odpowiedzi: recordTransportFailure, RunCostSink null", async () => {
    const usage = createTestRecorder();
    const cost = recordingCost([]);
    await expect(
      new AiSdkLessonPoolAgent(agentOptions(throwingModel(() => apiError(undefined, { isRetryable: true })), { usage })).planObjectives(
        PLAN_INPUT,
        { propose: async () => ({ ok: true, errors: [] }), shouldStop: () => false },
        cost,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "transient" });
    expect(cost.values).toEqual([null]);
    expect(usage.events).toEqual([{ feature: "lesson_generation", operation: "agent_plan", provider: "openrouter", model: "test-model", outcome: "failed" }]);
  });

  it("przerwanie w trakcie żądania: signal.reason, RunCostSink null, porażka transportu", async () => {
    const usage = createTestRecorder();
    const cost = recordingCost([]);
    const controller = new AbortController();
    const reason = new Error("run_deadline");
    const model = new MockLanguageModelV4({
      doGenerate: () => {
        controller.abort(reason);
        return new Promise<GenerateResult>(() => undefined);
      },
    });
    await expect(new AiSdkExerciseChecker(agentOptions(model, { usage })).judgeVariants(JUDGE_INPUT, cost, controller.signal)).rejects.toBe(reason);
    expect(cost.values).toEqual([null]);
    expect(usage.events).toEqual([{ feature: "lesson_generation", operation: "check_variants", provider: "openrouter", model: "test-model", outcome: "failed" }]);
  });
});

describe("providerOptions (spec §4, §5)", () => {
  it("wysiłek i routing dostawcy trafiają do providerOptions.openrouter każdego wywołania", async () => {
    const provider = { data_collection: "deny", order: ["x"], require_parameters: true };
    const agentModel = new MockLanguageModelV4({ doGenerate: [textResult("done")] });
    await new AiSdkLessonPoolAgent(agentOptions(agentModel, { effort: "medium", provider })).runObjective(
      agentInput(),
      fakeTools([]).tools,
      recordingCost([]),
      new AbortController().signal,
    );
    const checkerModel = new MockLanguageModelV4({ doGenerate: [textResult(JSON.stringify({ answers: [["a"]] }))] });
    await new AiSdkExerciseChecker(agentOptions(checkerModel, { provider })).solve(SOLVE_INPUT, recordingCost([]), new AbortController().signal);
    expect(agentModel.doGenerateCalls[0]!.providerOptions).toEqual({ openrouter: { reasoning: { effort: "medium" }, provider } });
    expect(checkerModel.doGenerateCalls[0]!.providerOptions).toEqual({ openrouter: { reasoning: { effort: "low" }, provider } });
  });

  it("effort none → bez reasoning; bez routingu → bez provider", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [textResult(JSON.stringify({ equivalent: [[true]] }))] });
    await new AiSdkExerciseChecker(agentOptions(model, { effort: "none" })).judgeVariants(JUDGE_INPUT, recordingCost([]), new AbortController().signal);
    expect(model.doGenerateCalls[0]!.providerOptions).toEqual({ openrouter: {} });
  });
});

describe("objectiveInstructions — przykłady zagadnienia", () => {
  it("przykłady ustalone (examplesFromPlan) → prompt nie prosi o przykłady; inaczej prosi", () => {
    const fixed = objectiveInstructions(agentInput({ objective: { ...agentInput().objective, examplesFromPlan: true } }));
    expect(fixed).toContain("Card examples are fixed by the lesson plan: do not send them.");
    expect(fixed).not.toContain("in the examples field of submit_exercises");
    const own = objectiveInstructions(agentInput());
    expect(own).toContain("in the examples field of submit_exercises");
    expect(own).not.toContain("do not send them");
  });
});

describe("jawny klucz i host OpenRouter (zaślepiony fetch)", () => {
  const KEYS = ["OPENROUTER_API_KEY", "UMIEM_LLM_API_KEY", "UMIEM_LESSON_AGENT_API_KEY"] as const;
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    saved.clear();
  });

  function withoutEnvKeys(): void {
    for (const name of KEYS) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  }

  it("klucz i baseURL jawne: host openrouter.ai, ścieżka /api/v1/chat/completions, Bearer z opcji; koszt z odpowiedzi", async () => {
    withoutEnvKeys();
    const usage = createTestRecorder();
    const cost = recordingCost([]);
    const stub = stubFetch([jsonResponse(chatCompletion(JSON.stringify({ answers: [["cat"]] }), 0.0042))]);
    const checker = new AiSdkExerciseChecker({ apiKey: "test-key", model: "vendor/checker", effort: "low", provider: { data_collection: "deny" }, usage, fetch: stub.fetch });

    const result = await checker.solve(SOLVE_INPUT, cost, new AbortController().signal);

    expect(result.answers).toEqual([["cat"]]);
    expect(stub.calls).toHaveLength(1);
    const url = new URL(stub.calls[0]!.url);
    expect(url.host).toBe("openrouter.ai");
    expect(url.pathname).toBe("/api/v1/chat/completions");
    expect(stub.calls[0]!.headers.get("authorization")).toBe("Bearer test-key");
    expect(stub.calls[0]!.body).toMatchObject({ model: "vendor/checker", reasoning: { effort: "low" }, provider: { data_collection: "deny" } });
    expect(OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(cost.values).toEqual([0.0042]);
    expect(usage.events).toEqual([
      {
        feature: "lesson_generation",
        operation: "check_solve",
        provider: "openrouter",
        model: "vendor/checker",
        outcome: "ok",
        httpStatus: 200,
        inputTokens: 11,
        outputTokens: 4,
        providerCostUsd: 0.0042,
      },
    ]);
  });

  it("maxRetries 0: odpowiedź 500 → dokładnie jedno żądanie, transient, koszt 0", async () => {
    withoutEnvKeys();
    const usage = createTestRecorder();
    const cost = recordingCost([]);
    const stub = stubFetch([jsonResponse({ error: { message: "upstream", code: 500 } }, 500), jsonResponse(chatCompletion("{}"))]);
    await expect(
      new AiSdkExerciseChecker({ apiKey: "test-key", model: "vendor/checker", effort: "low", usage, fetch: stub.fetch }).solve(SOLVE_INPUT, cost, new AbortController().signal),
    ).rejects.toMatchObject({ name: "GenerationProviderError", kind: "transient", status: 500 });
    expect(stub.calls).toHaveLength(1);
    expect(cost.values).toEqual([0]);
    expect(usage.events.map((event) => [event.outcome, event.httpStatus])).toEqual([["failed", 500]]);
  });

  it("429 z retry-after przez prawdziwy klient → rate_limit z retryAfterMs", async () => {
    withoutEnvKeys();
    const stub = stubFetch([jsonResponse({ error: { message: "slow down", code: 429 } }, 429, { "retry-after": "7" })]);
    await expect(
      new AiSdkExerciseChecker({ apiKey: "test-key", model: "vendor/checker", effort: "low", fetch: stub.fetch }).solve(SOLVE_INPUT, recordingCost([]), new AbortController().signal),
    ).rejects.toMatchObject({ kind: "rate_limit", status: 429, retryAfterMs: 7000 });
    expect(stub.calls).toHaveLength(1);
  });

  it("błąd sieci (fetch failed) → transient, porażka transportu, koszt null", async () => {
    withoutEnvKeys();
    const usage = createTestRecorder();
    const cost = recordingCost([]);
    const failing = (async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    }) as typeof fetch;
    await expect(
      new AiSdkExerciseChecker({ apiKey: "test-key", model: "vendor/checker", effort: "low", usage, fetch: failing }).solve(SOLVE_INPUT, cost, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "transient" });
    expect(cost.values).toEqual([null]);
    expect(usage.events.map((event) => [event.outcome, event.httpStatus])).toEqual([["failed", undefined]]);
  });
});

describe("adaptery nic nie logują", () => {
  it("sukces, błąd HTTP, błąd sieci i przerwanie bez console.*", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    try {
      const signal = new AbortController().signal;
      const okModel = new MockLanguageModelV4({
        doGenerate: [toolCallResult("submit_exercises", { exercises: [RAW_MATCH], examples: ["I have a cat."] }), textResult("done")],
      });
      await new AiSdkLessonPoolAgent(agentOptions(okModel, { usage: createTestRecorder() })).runObjective(agentInput(), fakeTools([]).tools, recordingCost([]), signal);
      await new AiSdkExerciseChecker({ apiKey: "test-key", model: "m", effort: "low", fetch: stubFetch([jsonResponse(chatCompletion(JSON.stringify({ answers: [["a"]] })))]).fetch })
        .solve(SOLVE_INPUT, recordingCost([]), signal);
      await new AiSdkExerciseChecker({ apiKey: "test-key", model: "m", effort: "low", fetch: stubFetch([jsonResponse({ error: { message: "x" } }, 503)]).fetch })
        .solve(SOLVE_INPUT, recordingCost([]), signal)
        .catch(() => undefined);
      await new AiSdkExerciseChecker(agentOptions(throwingModel(() => apiError(undefined, { isRetryable: true }))))
        .judgeVariants(JUDGE_INPUT, recordingCost([]), signal)
        .catch(() => undefined);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
