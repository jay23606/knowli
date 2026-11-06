import { afterEach, describe, expect, it, vi } from "vitest";
import { isLessonAgentAvailable, type LessonAgentDeps } from "../config";
import { withConfigDefaults } from "../config-defaults";
import { agentObjectivesOf } from "../domain/lessons/agent/capable";
import { createLessonAgentState } from "../domain/lessons/agent/state";
import { createProductionSubjectRegistry } from "../domain/lessons/subjects";
import { englishGrammarSubject } from "../domain/lessons/subjects/english-grammar/module";
import { lessonAgentLimits, runLessonPoolAgent } from "../modules/materials/lessons/lesson-pool-agent";
import { objectiveAgentInput } from "../modules/materials/lessons/lesson-pool-agent-input";
import type { LessonAgentToolOutcome, LessonObjectiveAgentInput, LessonObjectiveAgentTools } from "../ports/ai";
import { FakeExerciseChecker, FakeLessonPoolAgent } from "./fake-lesson-agent";
import { lessonAgentDepsFromEnv } from "./lesson-agent-env";
import { createTestRecorder } from "./usage/test-recorder";

const never = new AbortController().signal;
const GRAMMAR_TOPIC = englishGrammarSubject.topics.find((candidate) => candidate.id === "present_simple")!;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Zależności agenta z env, gdy test oczekuje dostępnego agenta. */
function available(deps: ReturnType<typeof lessonAgentDepsFromEnv>): LessonAgentDeps {
  if (!isLessonAgentAvailable(deps)) throw new Error("expected available lesson agent");
  return deps;
}

/** Wejście podagenta gramatyki z prawdziwego `objectiveAgentInput` (pierwsze zagadnienie tematu). */
function grammarInput(): LessonObjectiveAgentInput {
  const objectives = agentObjectivesOf(GRAMMAR_TOPIC);
  const limits = lessonAgentLimits(englishGrammarSubject, GRAMMAR_TOPIC, 0);
  const state = createLessonAgentState({ topic: GRAMMAR_TOPIC, objectives, fixed: [], examples: {}, fixedSources: {} });
  return objectiveAgentInput({
    subject: englishGrammarSubject,
    topic: GRAMMAR_TOPIC,
    state,
    objective: objectives[0]!,
    limits: limits.get(objectives[0]!.id)!,
    material: "",
    graderAvailable: false,
    examplesFixed: false,
    maxSteps: 8,
    callTimeoutMs: 90_000,
  });
}

/** Narzędzia, które po pierwszym zgłoszeniu kończą zagadnienie. */
function completingTools(): LessonObjectiveAgentTools & { readonly submitted: unknown[] } {
  const submitted: unknown[] = [];
  const outcome: LessonAgentToolOutcome = {
    results: [],
    counts: { guided: 0, productive: 0, independent: 0, outsideStages: 0, total: 0 },
    missing: [],
    complete: true,
  };
  return {
    submitted,
    submit: async (raw) => {
      submitted.push(raw);
      return outcome;
    },
    remove: async () => ({ ...outcome, removed: [] }),
    shouldStop: () => false,
  };
}

describe("lessonAgentDepsFromEnv", () => {
  it("tryb fake bez klucza → fake'i: generator, checker niedostępny, polityka z env, bez ostrzeżeń", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = withConfigDefaults({ UMIEM_FAKE_PROVIDERS: "1", UMIEM_LESSON_AGENT_MAX_STEPS: "5" });
    const deps = available(lessonAgentDepsFromEnv(env, createTestRecorder()));
    expect(deps.agent).toBeInstanceOf(FakeLessonPoolAgent);
    expect(deps.checker).toBeInstanceOf(FakeExerciseChecker);
    expect(deps.policy).toMatchObject({ maxStepsPerObjective: 5, planMaxSteps: 5, concurrency: 4 });
    expect(deps).not.toHaveProperty("grader");
    const solved = await deps.checker.solve({ items: [{ view: "v", expectedAnswers: 1 }] }, { record: () => undefined }, never);
    expect(solved.answers).toEqual([null]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("tryb fake: przebieg lekcji bez historii wywołań, z zerowym kosztem i bez zdarzeń kosztów", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const usage = createTestRecorder();
    const deps = available(lessonAgentDepsFromEnv(withConfigDefaults({ UMIEM_FAKE_PROVIDERS: "1" }), usage));
    const result = await runLessonPoolAgent(
      { agent: deps.agent, checker: deps.checker, subjects: createProductionSubjectRegistry(), policy: deps.policy },
      {
        runId: "run-1",
        subjectId: englishGrammarSubject.id,
        deckId: "42",
        objectiveSource: { source: "catalog", topic: GRAMMAR_TOPIC },
        topicTitle: GRAMMAR_TOPIC.titlePl,
        material: "",
        poolSize: 0,
        graderAvailable: false,
        fixed: [],
        draftExamples: {},
        skipObjectives: [],
        familyScope: null,
        initialSpentUsd: 0,
      },
      never,
    );
    const agent = deps.agent as FakeLessonPoolAgent;
    expect(result.objectives.length).toBeGreaterThan(0);
    expect(result.objectives.every((objective) => objective.exercises.length > 0)).toBe(true);
    // record: false — worker nie gromadzi historii wywołań fake'a
    expect(agent.calls).toHaveLength(0);
    expect(agent.planCalls).toHaveLength(0);
    // stepCostUsd: 0 — kroki fake'a nie zużywają budżetu runu (koszt znany, nie szacunek)
    expect(result.spentUsd).toBe(0);
    expect(result.unknownCostCalls).toBe(0);
    expect(usage.events).toEqual([]);
  });

  it("tryb fake: opóźnienie kroku z UMIEM_FAKE_LESSON_DELAY_MS (przed UMIEM_FAKE_DELAY_MS)", async () => {
    vi.useFakeTimers();
    const env = withConfigDefaults({ UMIEM_FAKE_PROVIDERS: "1", UMIEM_FAKE_LESSON_DELAY_MS: "200", UMIEM_FAKE_DELAY_MS: "5000" });
    const deps = available(lessonAgentDepsFromEnv(env));
    const tools = completingTools();
    const run = deps.agent.runObjective(grammarInput(), tools, { record: () => undefined }, never);
    await vi.advanceTimersByTimeAsync(199);
    expect(tools.submitted).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(tools.submitted).toHaveLength(1);
    await expect(run).resolves.toEqual({ steps: 1, stopReason: "model_finished" });
  });

  it("tryb fake: bez UMIEM_FAKE_LESSON_DELAY_MS opóźnienie z UMIEM_FAKE_DELAY_MS", async () => {
    vi.useFakeTimers();
    const deps = available(lessonAgentDepsFromEnv({ UMIEM_FAKE_PROVIDERS: "1", UMIEM_FAKE_DELAY_MS: "300" }));
    const tools = completingTools();
    const run = deps.agent.runObjective(grammarInput(), tools, { record: () => undefined }, never);
    await vi.advanceTimersByTimeAsync(299);
    expect(tools.submitted).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(run).resolves.toEqual({ steps: 1, stopReason: "model_finished" });
  });

  it("tryb fake: nieliczbowe opóźnienie → bez opóźnienia", async () => {
    vi.useFakeTimers();
    const deps = available(lessonAgentDepsFromEnv({ UMIEM_FAKE_PROVIDERS: "1", UMIEM_FAKE_LESSON_DELAY_MS: "abc" }));
    const tools = completingTools();
    const run = deps.agent.runObjective(grammarInput(), tools, { record: () => undefined }, never);
    await vi.advanceTimersByTimeAsync(0);
    expect(tools.submitted).toHaveLength(1);
    await expect(run).resolves.toEqual({ steps: 1, stopReason: "model_finished" });
  });

  it("bez klucza poza trybem fake → niedostępny, bez logu", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const deps = lessonAgentDepsFromEnv(withConfigDefaults({}));
    expect(deps).toEqual({ unavailable: "no_openrouter_key" });
    expect(isLessonAgentAvailable(deps)).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("pozostawione UMIEM_LESSON_AGENT_SUBJECTS nie zmienia wyniku", () => {
    expect(lessonAgentDepsFromEnv(withConfigDefaults({ UMIEM_LESSON_AGENT_SUBJECTS: "english_grammar" }))).toEqual({ unavailable: "no_openrouter_key" });
    expect(isLessonAgentAvailable(lessonAgentDepsFromEnv(withConfigDefaults({ UMIEM_FAKE_PROVIDERS: "1", UMIEM_LESSON_AGENT_SUBJECTS: "history" })))).toBe(true);
  });

  it("klucz w kształcie OpenAI to błąd z nazwą zmiennej", () => {
    expect(() => lessonAgentDepsFromEnv(withConfigDefaults({ UMIEM_LESSON_AGENT_API_KEY: "sk-proj-x" }))).toThrow(/UMIEM_LESSON_AGENT_API_KEY/u);
  });

  it("z kluczem → instancje adaptera AI SDK z modelami z env", () => {
    const env = withConfigDefaults({
      OPENROUTER_API_KEY: "sk-or-v1-test",
      UMIEM_LESSON_AGENT_MODEL: "google/gemini-test",
      UMIEM_LESSON_AGENT_CHECKER_MODEL: "deepseek/deepseek-test",
      UMIEM_LESSON_AGENT_CONCURRENCY: "2",
    });
    const deps = available(lessonAgentDepsFromEnv(env, createTestRecorder()));
    expect(deps).not.toHaveProperty("subjects");
    // Adapter bez importu w teście: jedynym importerem adaptera jest lesson-agent-env.ts (test architektury).
    expect(deps.agent.constructor.name).toBe("AiSdkLessonPoolAgent");
    expect(deps.agent.name).toBe("ai-sdk-openrouter");
    expect(deps.agent.model).toBe("google/gemini-test");
    expect(deps.checker.constructor.name).toBe("AiSdkExerciseChecker");
    expect(deps.checker.model).toBe("deepseek/deepseek-test");
    expect(deps.policy).toMatchObject({ concurrency: 2 });
  });

  describe("grader kontroli otwartej (etap 2b)", () => {
    const base = { OPENROUTER_API_KEY: "sk-or-v1-test" };

    it("tryb rzeczywisty z UMIEM_GRADER_* → grader z timeoutMs z env", () => {
      const env = withConfigDefaults({
        ...base,
        UMIEM_GRADER_BASE_URL: "https://grader.example/v1",
        UMIEM_GRADER_API_KEY: "secret",
        UMIEM_GRADER_MODEL: "cheap-1",
        UMIEM_GRADER_TIMEOUT_MS: "1234",
      });
      const deps = available(lessonAgentDepsFromEnv(env, createTestRecorder()));
      expect(deps.grader?.timeoutMs).toBe(1234);
      expect(deps.grader?.provider.model).toBe("cheap-1");
    });

    it("domyślna konfiguracja z kluczem OpenRouter też składa grader (domyślny timeout)", () => {
      const deps = available(lessonAgentDepsFromEnv(withConfigDefaults(base), createTestRecorder()));
      expect(deps.grader).toBeDefined();
      expect(deps.grader?.timeoutMs).toBe(8000);
    });

    it("bez konfiguracji gradera → brak pola (kontrola otwarta nie dotyczy)", () => {
      // Bez domyślnych (withConfigDefaults) i bez adresu/modelu gradera: tylko klucz agenta.
      const deps = available(lessonAgentDepsFromEnv({ ...base, UMIEM_LESSON_AGENT_MODEL: "m", UMIEM_LESSON_AGENT_CHECKER_MODEL: "c" }));
      expect(deps.grader).toBeUndefined();
    });

    it("UMIEM_FAKE_PROVIDERS=1 → brak gradera nawet z pełną konfiguracją", () => {
      const env = withConfigDefaults({
        UMIEM_FAKE_PROVIDERS: "1",
        UMIEM_GRADER_BASE_URL: "https://grader.example/v1",
        UMIEM_GRADER_API_KEY: "secret",
        UMIEM_GRADER_MODEL: "cheap-1",
      });
      expect(available(lessonAgentDepsFromEnv(env, createTestRecorder())).grader).toBeUndefined();
    });
  });
});
