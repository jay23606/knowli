import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../errors";
import { A, B, choice, gap, open, subject as fixtureSubject, topic } from "../../../domain/lessons/testing/agent-admission-fixtures";
import { withAgentPolicy } from "../../../domain/lessons/testing/agent-test-subject";
import { chapterAgentPolicy } from "../../../domain/lessons/subjects/english-chapter/agent-policy";
import { englishChapterSubject } from "../../../domain/lessons/subjects/english-chapter/module";
import { englishGrammarSubject } from "../../../domain/lessons/subjects/english-grammar/module";
import { schoolAgentPolicy } from "../../../domain/lessons/subjects/school/agent-policy";
import { schoolSubject } from "../../../domain/lessons/subjects/school/module";
import type { DynamicTopicData, LessonExerciseDraft, LessonTopic, SubjectModule } from "../../../domain/lessons/types";
import type { LessonAgentPlanInput, LessonPoolAgentProvider, RunCostSink } from "../../../ports/ai";
import { GenerationProviderError } from "../../../ports/generation-error";
import { FakeAnswerGrader } from "../../../providers/fake";
import {
  FakeExerciseChecker,
  FakeLessonPoolAgent,
  type FakeAgentStep,
  type FakeLessonPoolAgentOptions,
} from "../../../providers/fake-lesson-agent";
import { objectiveBatchCounts } from "./lesson-drafts";
import { classifyLessonGenerationFailure } from "./lesson-generation-errors";
import { runLessonPoolAgent, type LessonPoolAgentRunInput, type SettledObjective } from "./lesson-pool-agent";

/** Temat fixture'ów: dwa zagadnienia (A, B) z wszystkimi typami przedmiotu testowego. */
const SLUG_A = A.split(".").at(-1)!;
const SLUG_B = B.split(".").at(-1)!;

/** Przedmiot testowy bez checkera (ślepe rozwiązanie i warianty wyłączone). */
const plain = withAgentPolicy(fixtureSubject, { blindSolveTypes: [], variantCheckTypes: [] });

function registryOf(...subjects: SubjectModule[]) {
  return { getSubject: (id: string) => subjects.find((subject) => subject.id === id) };
}

function runInput(overrides: Partial<LessonPoolAgentRunInput> = {}): LessonPoolAgentRunInput {
  return {
    runId: "run-1",
    subjectId: plain.id,
    deckId: "42",
    objectiveSource: { source: "catalog", topic },
    topicTitle: "Początki państwa",
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

/**
 * Pełna paczka zagadnienia przedmiotu testowego (minima 3/4/2, rezerwa samodzielnych 1, 9 ćwiczeń):
 * 3 wybory, 4 luki i 3 pytania otwarte z unikalnymi odpowiedziami; `k` rozdziela numerację zagadnień.
 */
function fullBatch(objectiveId: string, k: number): LessonExerciseDraft[] {
  const n = (i: number) => k + i;
  return [
    ...[1, 2, 3].map((i) => choice(objectiveId, n(i))),
    ...[1, 2, 3, 4].map((i) => gap(objectiveId, `Zdanie ${n(i)}: ___.`, `luka ${n(i)}`)),
    ...[1, 2, 3].map((i) => open(objectiveId, `Pytanie otwarte ${n(i)}?`, `wynik ${n(i)}`)),
  ];
}

function completeScript(objectiveId: string, k: number): FakeAgentStep[] {
  return [{ submit: { exercises: fullBatch(objectiveId, k), examples: [`Przykład karty ${k}.`] } }];
}

function setup(options: {
  agent?: FakeLessonPoolAgentOptions;
  agentProvider?: LessonPoolAgentProvider;
  checker?: FakeExerciseChecker;
  subjects?: SubjectModule[];
} = {}) {
  const agent = new FakeLessonPoolAgent(options.agent);
  const checker = options.checker ?? new FakeExerciseChecker();
  const deps = {
    agent: options.agentProvider ?? agent,
    checker,
    subjects: registryOf(...(options.subjects ?? [plain])),
  };
  return { agent, checker, deps };
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

beforeEach(() => {
  // Logi kierownika wycisza każdy test; test logów czyta je z tego samego szpiega.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runLessonPoolAgent — przebieg zagadnień", () => {
  it("dwa zagadnienia complete; objectives w kolejności lekcji, przykłady i ćwiczenia w wyniku", async () => {
    const { agent, deps } = setup({ agent: { objectives: { [SLUG_A]: completeScript(A, 0), [SLUG_B]: completeScript(B, 100) } } });
    const result = await runLessonPoolAgent(deps, runInput(), never);
    expect(result.planStatus).toBe("not_needed");
    expect(result.objectives.map((objective) => [objective.objectiveId, objective.status])).toEqual([
      [A, "complete"],
      [B, "complete"],
    ]);
    expect(result.objectives[0]!.missing).toEqual([]);
    expect(result.objectives[0]!.examples).toEqual(["Przykład karty 0."]);
    expect(result.objectives[0]!.exercises).toHaveLength(10);
    expect(result.objectives[0]!.steps).toBe(1);
    expect(result.stats).toMatchObject({ submitted: 20, accepted: 20, invariantViolations: 0, refused: 0, checkerCalls: 0 });
    expect(agent.calls[0]!.input.objective.examplesFromPlan).toBe(false);
  });

  it("maxSteps przy scenariuszu bez poprawki → incomplete z brakami", async () => {
    const malformed: FakeAgentStep = { submit: { exercises: [{ exerciseType: "lesson_choice" }] } };
    const { agent, deps } = setup({ agent: { objectives: { [SLUG_A]: Array.from({ length: 9 }, () => malformed) } } });
    const result = await runLessonPoolAgent(deps, runInput({ skipObjectives: [B] }), never);
    expect(agent.calls[0]!.input.maxSteps).toBe(8);
    expect(result.objectives).toHaveLength(1);
    expect(result.objectives[0]).toMatchObject({ objectiveId: A, status: "incomplete", steps: 8 });
    expect(result.objectives[0]!.missing.length).toBeGreaterThan(0);
    expect(result.stats.rejectedByKind).toEqual({ shape: 8 });
  });

  it("throw w jednym zagadnieniu → failed z kodem klasyfikacji, drugie complete", async () => {
    const { deps } = setup({ agent: { objectives: { [SLUG_A]: [{ throw: new Error("x") }], [SLUG_B]: completeScript(B, 100) } } });
    const result = await runLessonPoolAgent(deps, runInput(), never);
    expect(result.objectives[0]).toMatchObject({
      objectiveId: A,
      status: "failed",
      failure: { errorCode: classifyLessonGenerationFailure(new Error("x")).errorCode },
    });
    expect(result.objectives[1]).toMatchObject({ objectiveId: B, status: "complete" });
  });

  it("błąd kodu przy budowaniu wejścia podagenta odrzuca run (nie jest awarią dostawcy `failed`)", async () => {
    const bug = new Error("prompt builder bug");
    // `topic.transforms` czyta tylko budowanie wejścia podagenta (`buildPoolInput`) i widok checkera (tu nieużywany).
    const broken = Object.defineProperty({ ...topic }, "transforms", {
      get: () => {
        throw bug;
      },
    }) as LessonTopic;
    const { agent, deps } = setup({ agent: { objectives: { [SLUG_A]: completeScript(A, 0), [SLUG_B]: completeScript(B, 100) } } });
    await expect(runLessonPoolAgent(deps, runInput({ objectiveSource: { source: "catalog", topic: broken } }), never)).rejects.toBe(bug);
    expect(agent.calls).toEqual([]);
  });

  it("dwa zagadnienia równolegle z tym samym ujawnieniem: oba prechecki przed przyjęciem → jedno przyjęte, drugie leak_*", async () => {
    const gate = deferred();
    const checker = new FakeExerciseChecker({ solve: () => ["966"], gate: gate.promise });
    const withChecker = withAgentPolicy(fixtureSubject, { blindSolveTypes: ["lesson_open_answer"], variantCheckTypes: [] });
    const { deps } = setup({
      checker,
      subjects: [withChecker],
      agent: {
        objectives: {
          [SLUG_A]: [{ submit: { exercises: [open(A, "Rok chrztu?", "966")] } }],
          [SLUG_B]: [{ submit: { exercises: [open(B, "Rok, w którym rządził Mieszko?", "966")] } }],
        },
      },
    });
    const run = runLessonPoolAgent(deps, runInput({ subjectId: withChecker.id }), never);
    await vi.waitFor(() => expect(checker.solveCalls).toHaveLength(2));
    gate.resolve();
    const result = await run;
    const accepted = result.objectives.flatMap((objective) => objective.exercises);
    expect(accepted).toHaveLength(1);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]!.kind).toBe("leak");
    expect(result.rejections[0]!.code).toMatch(/^leak_/);
    expect(result.stats.invariantViolations).toBe(0);
    expect(result.stats.checkerCalls).toBe(2);
  });

  it("skipObjectives + fixed: pominięte zagadnienie bez wywołania agenta, jego fixed blokuje ujawnienie w innym", async () => {
    const { agent, deps } = setup({
      agent: { objectives: { [SLUG_B]: [{ submit: { exercises: [open(B, "Rok, w którym rządził Mieszko?", "966")] } }] } },
    });
    const result = await runLessonPoolAgent(
      deps,
      runInput({ skipObjectives: [A], fixed: [open(A, "Rok chrztu?", "966")] }),
      never,
    );
    expect(agent.calls.map((call) => call.objectiveId)).toEqual([B]);
    expect(result.objectives.map((objective) => objective.objectiveId)).toEqual([B]);
    expect(result.objectives[0]!.exercises).toEqual([]);
    expect(result.rejections.map((entry) => entry.code)).toEqual(["leak_victim"]);
  });

  it("log: jedna linia na zagadnienie z licznikami i kodami odrzuceń, bez treści `detail`", async () => {
    const log = vi.mocked(console.log);
    const duplicate = choice(A, 1);
    const { deps } = setup({
      agent: { objectives: { [SLUG_A]: [{ submit: { exercises: [duplicate, duplicate] } }], [SLUG_B]: [{ throw: new Error("x") }] } },
      checker: new FakeExerciseChecker({ costUsd: 0 }),
    });
    const result = await runLessonPoolAgent(deps, runInput(), never);
    const lines = log.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("[lesson-agent]"));
    // Kolejność zakończenia (B rzuca od razu); porównanie bez kolejności. Odrzucenie: kod, typ i id reguł, bez treści.
    const rejection = result.rejections[0]!;
    expect([...lines].sort()).toEqual([
      `[lesson-agent] run=run-1 obj=${SLUG_A} rejected code=${rejection.code} type=lesson_choice rules=${rejection.ruleIds.join(",")}`,
      `[lesson-agent] run=run-1 obj=${SLUG_A} status=incomplete steps=1 accepted=1 rejected=${rejection.code}:1 hintsRemoved=0 variantsRemoved=0 quotesSnapped=0 costUsd=0.0200`,
      `[lesson-agent] run=run-1 obj=${SLUG_B} status=failed error=provider steps=1 accepted=0 rejected=- hintsRemoved=0 variantsRemoved=0 quotesSnapped=0 costUsd=0.0200`,
    ]);
    expect(rejection.ruleIds.length).toBeGreaterThan(0);
    const detail = result.rejections[0]!.detail;
    expect(detail.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(detail);
    expect(lines.join("\n")).not.toContain("Pytanie numer");
  });

  it("prywatność logów: odrzucenie z cytatem treści w `found` loguje tylko kod, id reguł i typ — bez `found`, `pl` i treści", async () => {
    const quoted = { ...choice(A, 1), options: [{ id: "a", text: "CYTAT-MARKER" }, { id: "b", text: "CYTAT-MARKER" }], correctOption: "a", answer: "CYTAT-MARKER" };
    const { deps } = setup({ agent: { objectives: { [SLUG_A]: [{ submit: { exercises: [quoted] } }], [SLUG_B]: [] } } });
    const result = await runLessonPoolAgent(deps, runInput(), never);
    const rejection = result.rejections.find((entry) => entry.objectiveId === A)!;
    // Powód dla modelu cytuje treść ćwiczenia (found), więc test sprawdza właściwy przypadek.
    expect(rejection.detail).toContain("CYTAT-MARKER");
    const written = (["log", "error", "warn", "info", "debug"] as const).flatMap((method) =>
      vi.isMockFunction(console[method]) ? vi.mocked(console[method]).mock.calls.map((call) => call.map(String).join(" ")) : [],
    );
    expect(written.join("\n")).not.toContain("CYTAT-MARKER");
    for (const line of written) expect(line).not.toContain(rejection.detail);
    const line = written.find((entry) => entry.includes(" rejected code="))!;
    expect(line).toBe(`[lesson-agent] run=run-1 obj=${SLUG_A} rejected code=${rejection.code} type=lesson_choice rules=${rejection.ruleIds.join(",")}`);
    expect(line).not.toMatch(/[ąćęłńóśźż]/iu);
  });

  it("prywatność: do checkera nie trafiają polecenie, tematy zdań, karty, przykłady ani materiał", async () => {
    const markers = ["INSTRUCTION-MARKER", "INTEREST-MARKER", "CARD-MARKER", "EXAMPLE-MARKER", "DRAFT-MARKER", "MATERIAL-MARKER"];
    const marked = {
      ...topic,
      objectives: topic.objectives.map((objective) => ({
        ...objective,
        cards: [...objective.cards, { title: "Karta CARD-MARKER", body: "Treść CARD-MARKER." }],
      })),
    };
    const checker = new FakeExerciseChecker({ solve: () => ["966"] });
    const withChecker = withAgentPolicy(fixtureSubject, { blindSolveTypes: ["lesson_open_answer"], variantCheckTypes: ["lesson_gap"] });
    const variantGap = { ...gap(A, "Rok koronacji: ___.", "1025"), acceptedAnswers: ["w 1025 roku"] };
    const { deps } = setup({
      checker,
      subjects: [withChecker],
      agent: {
        objectives: {
          [SLUG_A]: [{ submit: { exercises: [open(A, "Rok chrztu?", "966"), variantGap], examples: ["Zdanie EXAMPLE-MARKER."] } }],
        },
      },
    });
    await runLessonPoolAgent(
      deps,
      runInput({
        subjectId: withChecker.id,
        objectiveSource: { source: "catalog", topic: marked },
        skipObjectives: [B],
        instruction: "Polecenie INSTRUCTION-MARKER",
        interests: ["INTEREST-MARKER"],
        material: "Materiał MATERIAL-MARKER",
        draftExamples: { [B]: ["Szkic DRAFT-MARKER."] },
      }),
      never,
    );
    expect(checker.solveCalls.length).toBeGreaterThan(0);
    expect(checker.judgeCalls.length).toBeGreaterThan(0);
    const sent = JSON.stringify([checker.solveCalls, checker.judgeCalls]);
    for (const marker of markers) expect(sent).not.toContain(marker);
  });

  it("wejście podagenta: targets z liczb partii, pool z tymi samymi liczbami, zdania kart i inne zagadnienia", async () => {
    const { agent, deps } = setup({ agent: { objectives: { [SLUG_A]: [], [SLUG_B]: [] } } });
    await runLessonPoolAgent(deps, runInput({ draftExamples: { [B]: ["Zdanie szkicu."] } }), never);
    const [first] = agent.calls;
    const target = objectiveBatchCounts(0, 2, plain)[0]!;
    expect(first!.input.targets).toMatchObject({ targetCount: target, listenAllowance: 0, maxExercises: target + 2, requiredTypes: [] });
    const { guided, productive, independent } = first!.input.targets;
    expect(first!.input.pool.stageCounts).toEqual({ guided, productive, independent });
    // Liczba partii w prompcie = suma etapów (tekst promptu mówi, że podział obejmuje tyle ćwiczeń).
    expect(first!.input.pool.countPerObjective).toBe(guided + productive + independent);
    expect(first!.input.cardSentences).toEqual(["Zdanie szkicu."]);
    expect(first!.input.otherObjectives.map((other) => other.title)).toEqual([topic.objectives[1]!.titlePl]);
  });

  it("targets.independent obejmuje rezerwę samodzielnych (jak status): pula 60 na 6 zagadnień → 4/4/3", async () => {
    const prefix = A.slice(0, A.lastIndexOf(".") + 1);
    const six: LessonTopic = { ...topic, objectives: Array.from({ length: 6 }, (_, i) => ({ ...topic.objectives[0]!, id: `${prefix}six${i + 1}` })) };
    const { agent, deps } = setup();
    const result = await runLessonPoolAgent(deps, runInput({ objectiveSource: { source: "catalog", topic: six }, poolSize: 60 }), never);
    expect(agent.calls).toHaveLength(6);
    for (const call of agent.calls) {
      // Podział partii 10 ćwiczeń daje 2 samodzielne; status wymaga minimum 2 + rezerwa 1.
      expect(call.input.targets).toMatchObject({ guided: 4, productive: 4, independent: 3, targetCount: 10 });
      expect(call.input.pool.stageCounts).toEqual({ guided: 4, productive: 4, independent: 3 });
      expect(call.input.pool.countPerObjective).toBe(11);
    }
    expect(result.objectives[0]!.missing).toContain("independent: 0 of 3");
  });

  it("wejście podagenta niesie księgę reguł zagadnienia i minima publikacji; bez promptNotes", async () => {
    const run = setup();
    await runLessonPoolAgent(run.deps, runInput(), never);
    expect(run.agent.calls.length).toBeGreaterThan(0);
    for (const call of run.agent.calls) {
      expect(call.input).not.toHaveProperty("promptNotes");
      expect(call.input.pool.ruleBook.general.length + call.input.pool.ruleBook.types.length).toBeGreaterThan(0);
      expect(call.input.targets.publicationMinima).toEqual(expect.objectContaining({ guided: expect.any(Number), independent: expect.any(Number) }));
    }
    for (const subject of [schoolSubject, englishGrammarSubject, englishChapterSubject]) {
      expect(subject.agentPolicy).not.toHaveProperty("promptNotes");
    }
  });
});

describe("runLessonPoolAgent — przedmiot i źródło zagadnień", () => {
  it("nieznany przedmiot w rejestrze → AppError validation bez wywołań", async () => {
    const { agent, deps } = setup();
    await expect(runLessonPoolAgent(deps, runInput({ subjectId: "unknown_subject" }), never)).rejects.toMatchObject({
      code: "validation",
    });
    expect(agent.calls).toEqual([]);
  });

  it("źródło input (szkoła): temat z buildDynamicTopic, przykłady przez submit.examples, targetCount z objectiveBatchCounts (≥ 8)", async () => {
    const school = withAgentPolicy(schoolSubject, { blindSolveTypes: [], variantCheckTypes: [] });
    const dynamicTopic: DynamicTopicData = {
      titlePl: "Rzeki",
      objectives: [
        {
          id: `${school.id}.d42.rzeki`,
          titlePl: "Rzeki Polski",
          descriptionEn: "Main rivers of Poland.",
          cards: [
            { title: "Wisła", body: "Wisła jest najdłuższą rzeką Polski." },
            { title: "Odra", body: "Odra płynie na zachodzie kraju." },
          ],
        },
        {
          id: `${school.id}.d42.gory`,
          titlePl: "Góry Polski",
          descriptionEn: "Mountains of Poland.",
          cards: [
            { title: "Tatry", body: "Tatry są najwyższymi górami Polski." },
            { title: "Sudety", body: "Sudety leżą na południowym zachodzie." },
          ],
        },
      ],
    };
    const { agent, deps } = setup({
      subjects: [school],
      agent: { objectives: { rzeki: [{ submit: { exercises: [], examples: ["Wisła płynie przez Warszawę."] } }] } },
    });
    const result = await runLessonPoolAgent(
      deps,
      runInput({ subjectId: school.id, objectiveSource: { source: "input", dynamicTopic }, material: "Wisła i Odra." }),
      never,
    );
    expect(result.planStatus).toBe("not_needed");
    expect(result.dynamicTopic).toBeUndefined();
    expect(result.objectives[0]!.examples).toEqual(["Wisła płynie przez Warszawę."]);
    const counts = objectiveBatchCounts(0, 2, school);
    expect(agent.calls.map((call) => call.input.targets.targetCount)).toEqual(counts);
    expect(counts[0]).toBeGreaterThanOrEqual(8);
  });

  it("zdanie karty rozdziału jest stałym źródłem: tłumaczenie z tą odpowiedzią → leak_victim", async () => {
    const chapter = withAgentPolicy(englishChapterSubject, { blindSolveTypes: [], variantCheckTypes: [] });
    const objectiveId = `${chapter.id}.d42.room`;
    const dynamicTopic: DynamicTopicData = {
      titlePl: "Pokój",
      objectives: [
        {
          id: objectiveId,
          titlePl: "Mój pokój",
          descriptionEn: "Things in my room.",
          kind: "words",
          cards: [
            { title: "Zdanie", body: "There is a bed in my room." },
            { title: "Słowa", body: "łóżko, pokój" },
          ],
        },
      ],
    };
    const translation = {
      exerciseType: "lesson_open_answer",
      objectiveId,
      instructionPl: "Przetłumacz na angielski.",
      prompt: "W moim pokoju jest łóżko.",
      answer: "There is a bed in my room",
      acceptedAnswers: [],
      focus: ["bed"],
    };
    const { agent, deps } = setup({ subjects: [chapter], agent: { objectives: { room: [{ submit: { exercises: [translation] } }] } } });
    const result = await runLessonPoolAgent(
      deps,
      runInput({ subjectId: chapter.id, objectiveSource: { source: "input", dynamicTopic }, material: "There is a bed in my room. I like my bed." }),
      never,
    );
    expect(agent.calls[0]!.input.cardSentences).toContain("There is a bed in my room.");
    expect(result.rejections.map((entry) => entry.code)).toEqual(["leak_victim"]);
    expect(result.objectives[0]!.exercises).toEqual([]);
  });
});

/** Rozdział z prawdziwym planem i bramką planu (zaślepka polityki nie ma `planGate`). */
const chapter = withAgentPolicy(englishChapterSubject, {
  blindSolveTypes: [],
  variantCheckTypes: [],
  planCoverage: chapterAgentPolicy.planCoverage!,
  planGate: chapterAgentPolicy.planGate!,
});

function planObjective(slug: string, body: string, examples: string[] = []) {
  return {
    slug,
    titlePl: `Zagadnienie ${slug}`,
    descriptionEn: `Objective ${slug}.`,
    kind: "words",
    cards: [
      { title: "Słowa", body },
      { title: "Ćwiczymy", body: "Ćwiczymy zdania z tymi słowami." },
    ],
    examples,
  };
}

/** Fake zapamiętujący wyniki `propose` (fake agenta zapisuje tylko propozycje). */
class RecordingPlanAgent extends FakeLessonPoolAgent {
  readonly proposeResults: { ok: boolean; errors: readonly string[] }[] = [];

  override planObjectives(
    input: LessonAgentPlanInput,
    tools: Parameters<LessonPoolAgentProvider["planObjectives"]>[1],
    cost: RunCostSink,
    signal: AbortSignal,
  ) {
    return super.planObjectives(
      input,
      {
        propose: async (raw) => {
          const outcome = await tools.propose(raw);
          this.proposeResults.push(outcome);
          return outcome;
        },
        shouldStop: () => tools.shouldStop(),
      },
      cost,
      signal,
    );
  }
}

const ID_PATTERN = /^.+\.d42\.[a-z0-9_]{1,40}$/u;

describe("runLessonPoolAgent — plan zagadnień", () => {
  const LISTS = "Słowa:\ncoat — płaszcz\nboots — buty";

  it("propozycja z niepokrytym słowem → błąd ze słowem; druga przyjęta, identyfikatory tematu i przykłady z planu", async () => {
    const uncovered = { objectives: [planObjective("coat", "Płaszcz to coat."), planObjective("dom", "Dom i ogród."), planObjective("las", "Las i łąka.")] };
    const covered = {
      objectives: [
        planObjective("coat", "Płaszcz to coat.", ["I like my coat."]),
        planObjective("boots", "Buty to boots.", ["My boots are new."]),
        planObjective("las", "Las i łąka.", ["The forest is green."]),
      ],
    };
    const agent = new RecordingPlanAgent({ plans: [uncovered, covered] });
    const { deps } = setup({ agentProvider: agent, subjects: [chapter] });
    const result = await runLessonPoolAgent(
      deps,
      runInput({ subjectId: chapter.id, objectiveSource: { source: "planner" }, material: LISTS, topicTitle: "Unit 1" }),
      never,
    );
    expect(agent.planCalls[0]!.input).toMatchObject({
      objectiveCount: { min: 3, max: 6 },
      coverage: { words: ["coat", "boots"], frames: [] },
      maxSteps: 8,
      objectivesRules: englishChapterSubject.prompts.objectivesRules,
    });
    expect(agent.proposeResults[0]!.ok).toBe(false);
    expect(agent.proposeResults[0]!.errors.join(" ")).toContain("boots");
    expect(agent.proposeResults[1]).toEqual({ ok: true, errors: [] });
    expect(result.planStatus).toBe("accepted");
    const ids = result.dynamicTopic!.objectives.map((objective) => objective.id);
    expect(ids).toHaveLength(3);
    for (const id of ids) expect(id).toMatch(ID_PATTERN);
    expect(result.objectives.map((objective) => objective.objectiveId)).toEqual(ids);
    expect(result.objectives.map((objective) => objective.examples)).toEqual([["I like my coat."], ["My boots are new."], ["The forest is green."]]);
    expect(agent.calls[0]!.input.objective.examplesFromPlan).toBe(true);
    expect(agent.calls[0]!.input.objective.kind).toBe("words");
  });

  it("przykłady planu po indeksie: slug zmieniony przez sanityzację zachowuje przykłady", async () => {
    const plan = {
      objectives: [
        planObjective("coat__words_", "Płaszcz to coat.", ["I like my coat."]),
        planObjective("boots", "Buty to boots.", ["My boots are new."]),
        planObjective("las", "Las i łąka.", ["The forest is green."]),
      ],
    };
    const agent = new RecordingPlanAgent({ plans: [plan] });
    const { deps } = setup({ agentProvider: agent, subjects: [chapter] });
    const result = await runLessonPoolAgent(
      deps,
      runInput({ subjectId: chapter.id, objectiveSource: { source: "planner" }, material: LISTS, topicTitle: "Unit 1" }),
      never,
    );
    expect(agent.proposeResults).toEqual([{ ok: true, errors: [] }]);
    expect(result.dynamicTopic!.objectives[0]!.id).toBe(`${chapter.id}.d42.coat_words`);
    expect(result.objectives[0]!.examples).toEqual(["I like my coat."]);
  });

  it("zagadnienie planu bez użytecznego przykładu (pusta lista albo same puste linie) → propozycja odrzucona", async () => {
    const withoutExamples = {
      objectives: [
        planObjective("coat", "Płaszcz to coat.", ["I like my coat."]),
        planObjective("boots", "Buty to boots.", ["   "]),
        planObjective("las", "Las i łąka."),
      ],
    };
    const agent = new RecordingPlanAgent({ plans: [withoutExamples] });
    const { deps } = setup({ agentProvider: agent, subjects: [chapter] });
    const result = await runLessonPoolAgent(
      deps,
      runInput({ subjectId: chapter.id, objectiveSource: { source: "planner" }, material: LISTS, topicTitle: "Unit 1" }),
      never,
    );
    expect(agent.proposeResults[0]!.ok).toBe(false);
    expect(agent.proposeResults[0]!.errors).toEqual([
      expect.stringMatching(/^objective 2: needs 1-3 card examples/u),
      expect.stringMatching(/^objective 3: needs 1-3 card examples/u),
    ]);
    expect(result.planStatus).toBe("plan_failed");
  });

  it("brak przyjętego planu po 8 krokach → plan_failed, bez podagentów", async () => {
    const bad = { objectives: [] };
    const agent = new RecordingPlanAgent({ plans: Array.from({ length: 9 }, () => bad) });
    const { deps } = setup({ agentProvider: agent, subjects: [chapter] });
    const result = await runLessonPoolAgent(
      deps,
      runInput({ subjectId: chapter.id, objectiveSource: { source: "planner" }, material: LISTS, topicTitle: "Unit 1" }),
      never,
    );
    expect(result.planStatus).toBe("plan_failed");
    expect(result.planFailure).toEqual({ errorCode: "validation", retryable: false });
    expect(agent.planCalls[0]!.proposals).toHaveLength(8);
    expect(agent.calls).toEqual([]);
    expect(result.objectives).toEqual([]);
  });

  it("planObjectives rzuca → plan_failed z kodem klasyfikacji", async () => {
    class ThrowingPlanAgent extends FakeLessonPoolAgent {
      override planObjectives(): Promise<{ steps: number }> {
        return Promise.reject(new Error("x"));
      }
    }
    const agent = new ThrowingPlanAgent();
    const { deps } = setup({ agentProvider: agent, subjects: [chapter] });
    const result = await runLessonPoolAgent(
      deps,
      runInput({ subjectId: chapter.id, objectiveSource: { source: "planner" }, material: LISTS, topicTitle: "Unit 1" }),
      never,
    );
    expect(result).toMatchObject({
      planStatus: "plan_failed",
      planFailure: { errorCode: classifyLessonGenerationFailure(new Error("x")).errorCode },
      objectives: [],
    });
    expect(agent.calls).toEqual([]);
  });

  describe("planista ignorujący przerwanie (nigdy się nie kończy)", () => {
    class StallingPlanAgent extends FakeLessonPoolAgent {
      constructor(private readonly proposals: readonly unknown[]) {
        super();
      }

      override async planObjectives(
        _input: LessonAgentPlanInput,
        tools: Parameters<LessonPoolAgentProvider["planObjectives"]>[1],
      ): Promise<{ steps: number }> {
        for (const proposal of this.proposals) await tools.propose(proposal);
        return new Promise<{ steps: number }>(() => undefined);
      }
    }

    const planInput = () =>
      runInput({ subjectId: chapter.id, objectiveSource: { source: "planner" }, material: LISTS, topicTitle: "Unit 1" });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("bez przyjętego planu: po runTimeoutMs plan_failed, bez zawieszenia i bez zegarów", async () => {
      vi.useFakeTimers();
      const { deps } = setup({ agentProvider: new StallingPlanAgent([]), subjects: [chapter] });
      const run = runLessonPoolAgent({ ...deps, policy: { runTimeoutMs: 2000 } }, planInput(), never);
      await vi.advanceTimersByTimeAsync(1999);
      let settled = false;
      void run.then(
        () => (settled = true),
        () => (settled = true),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await run;
      expect(result.planStatus).toBe("plan_failed");
      expect(result.objectives).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("plan przerwany terminem → plan_failed provider_timeout, retryable false", async () => {
      vi.useFakeTimers();
      const hook = vi.fn(async () => undefined);
      const { deps } = setup({ agentProvider: new StallingPlanAgent([]), subjects: [chapter] });
      const run = runLessonPoolAgent({ ...deps, policy: { runTimeoutMs: 2000 } }, { ...planInput(), onObjectivesResolved: hook }, never);
      await vi.advanceTimersByTimeAsync(2000);
      const result = await run;
      expect(result.planStatus).toBe("plan_failed");
      expect(result.planFailure).toEqual({ errorCode: "provider_timeout", retryable: false });
      expect(hook).not.toHaveBeenCalled();
    });

    it("plan przyjęty przed przerwaniem nadal obowiązuje, mimo że planista się nie kończy", async () => {
      vi.useFakeTimers();
      const covered = {
        objectives: [
          planObjective("coat", "Płaszcz to coat.", ["I like my coat."]),
          planObjective("boots", "Buty to boots.", ["My boots are new."]),
          planObjective("las", "Las i łąka.", ["The forest is green."]),
        ],
      };
      const { deps } = setup({ agentProvider: new StallingPlanAgent([covered]), subjects: [chapter] });
      const run = runLessonPoolAgent({ ...deps, policy: { runTimeoutMs: 2000 } }, planInput(), never);
      await vi.advanceTimersByTimeAsync(2000);
      const result = await run;
      expect(result.planStatus).toBe("accepted");
    });
  });

  it("materiał rozdziału bez list: plan przyjęty, zagadnienia complete przy pełnych scenariuszach", async () => {
    const material = "I have a coat. I have boots. She has a dress. We have a skirt. I can see a hat and a scarf.";
    const words = ["coat", "boots", "dress", "skirt", "hat", "scarf"];
    const slugs = ["clothes_a", "clothes_b", "clothes_c"];
    const idOf = (slug: string) => `${chapter.id}.d42.${slug}`;
    let number = 0;
    const script = (slug: string, offset: number): FakeAgentStep[] => {
      const objectiveId = idOf(slug);
      const exercises: Record<string, unknown>[] = [];
      for (let i = 0; i < 3; i++) {
        number += 1;
        const answer = words[(offset + i) % words.length]!;
        const other = words[(offset + i + 1) % words.length]!;
        exercises.push({
          exerciseType: "lesson_choice",
          objectiveId,
          instructionPl: `Zdanie numer ${number} ma lukę. Wybierz słowo.`,
          stem: "I can see the ___.",
          answer,
          options: [
            { id: "a", text: answer },
            { id: "b", text: other },
          ],
          correctOption: "a",
          acceptedAnswers: [],
          focus: [],
        });
      }
      for (let i = 0; i < 3; i++) {
        number += 1;
        const answer = words[(offset + i) % words.length]!;
        exercises.push({
          exerciseType: "lesson_gap",
          objectiveId,
          instructionPl: `Zdanie numer ${number} ma lukę. Wpisz brakujące słowo.`,
          stem: "I have the ___.",
          answer,
          acceptedAnswers: [],
          focus: [answer],
        });
      }
      for (let i = 0; i < 3; i++) {
        number += 1;
        const first = words[offset]!;
        const second = words[(offset + i + 1) % words.length]!;
        exercises.push({
          exerciseType: "lesson_open_answer",
          objectiveId,
          instructionPl: "Przetłumacz na angielski.",
          prompt: `Przetłumacz zdanie numer ${number}.`,
          answer: `We have the ${first} and the ${second}`,
          acceptedAnswers: [],
          focus: [first],
        });
      }
      return [{ submit: { exercises } }];
    };
    const plan = {
      objectives: slugs.map((slug, index) => planObjective(slug, "Słowa o ubraniach.", [`I like my ${words[index]}.`])),
    };
    const agent = new FakeLessonPoolAgent({
      plans: [plan],
      objectives: { clothes_a: script("clothes_a", 0), clothes_b: script("clothes_b", 1), clothes_c: script("clothes_c", 2) },
    });
    const { deps } = setup({ agentProvider: agent, subjects: [chapter] });
    const result = await runLessonPoolAgent(
      deps,
      runInput({ subjectId: chapter.id, objectiveSource: { source: "planner" }, material, topicTitle: "Unit 1" }),
      never,
    );
    expect(result.planStatus).toBe("accepted");
    expect(result.rejections.map((entry) => `${entry.code}: ${entry.detail}`)).toEqual([]);
    expect(result.objectives.map((objective) => [objective.objectiveId, objective.status, objective.missing])).toEqual(
      slugs.map((slug) => [idOf(slug), "complete", []]),
    );
  });
});

describe("runLessonPoolAgent — hak onObjectiveSettled", () => {
  it("wołany raz na zagadnienie, szeregowo, w kolejności zakończenia", async () => {
    // A ma dodatkowy krok, więc kończy po B.
    const slowA: FakeAgentStep[] = [{ submit: { exercises: [{ exerciseType: "lesson_choice" }] } }, ...completeScript(A, 0)];
    const { deps } = setup({ agent: { objectives: { [SLUG_A]: slowA, [SLUG_B]: completeScript(B, 100) } } });
    const seen: string[] = [];
    let active = 0;
    let maxActive = 0;
    const onObjectiveSettled = async (settled: SettledObjective) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      seen.push(settled.objectiveId);
      await flush();
      await flush();
      active -= 1;
    };
    const result = await runLessonPoolAgent(deps, runInput({ onObjectiveSettled }), never);
    expect(seen).toEqual([B, A]);
    expect(maxActive).toBe(1);
    expect(result.objectives.map((objective) => objective.objectiveId)).toEqual([A, B]);
  });

  it("błąd haka przerywa pozostałe zagadnienia i odrzuca run tym błędem", async () => {
    const { agent, deps } = setup({ agent: { objectives: { [SLUG_A]: completeScript(A, 0), [SLUG_B]: [{ hang: true }] } } });
    const failure = new Error("hook failed");
    const calls: string[] = [];
    const onObjectiveSettled = async (settled: SettledObjective) => {
      calls.push(settled.objectiveId);
      throw failure;
    };
    await expect(runLessonPoolAgent(deps, runInput({ onObjectiveSettled }), never)).rejects.toBe(failure);
    expect(calls).toEqual([A]);
    expect(agent.calls).toHaveLength(2);
    expect(agent.calls[1]!.tools.shouldStop()).toBe(true);
  });

  it("przerwanie sygnału runu → odrzucenie z signal.reason, bez wywołań haka", async () => {
    const controller = new AbortController();
    const { agent, deps } = setup({ agent: { objectives: { [SLUG_A]: [{ hang: true }], [SLUG_B]: [{ hang: true }] } } });
    const hook = vi.fn(async () => undefined);
    const run = runLessonPoolAgent(deps, runInput({ onObjectiveSettled: hook }), controller.signal);
    await vi.waitFor(() => expect(agent.calls).toHaveLength(2));
    controller.abort("superseded");
    await expect(run).rejects.toBe("superseded");
    expect(hook).not.toHaveBeenCalled();
  });
});

/** Temat szkoły ze źródła `input` (dwa zagadnienia: `rzeki`, `gory`). */
function schoolDynamicTopic(subjectId: string): DynamicTopicData {
  return {
    titlePl: "Rzeki",
    objectives: [
      {
        id: `${subjectId}.d42.rzeki`,
        titlePl: "Rzeki Polski",
        descriptionEn: "Main rivers of Poland.",
        cards: [
          { title: "Wisła", body: "Wisła jest najdłuższą rzeką Polski." },
          { title: "Odra", body: "Odra płynie na zachodzie kraju." },
        ],
      },
      {
        id: `${subjectId}.d42.gory`,
        titlePl: "Góry Polski",
        descriptionEn: "Mountains of Poland.",
        cards: [
          { title: "Tatry", body: "Tatry są najwyższymi górami Polski." },
          { title: "Sudety", body: "Sudety leżą na południowym zachodzie." },
        ],
      },
    ],
  };
}

/** Rozdział z jednym zagadnieniem `room`, którego karty NIE zawierają zdania „There is a bed in my room.”. */
const roomChapter = withAgentPolicy(englishChapterSubject, { blindSolveTypes: [], variantCheckTypes: [] });
const ROOM_ID = `${roomChapter.id}.d42.room`;
const roomTopic: DynamicTopicData = {
  titlePl: "Pokój",
  objectives: [
    {
      id: ROOM_ID,
      titlePl: "Mój pokój",
      descriptionEn: "Things in my room.",
      kind: "words",
      cards: [{ title: "Słowa", body: "łóżko, pokój" }],
    },
  ],
};
/** Tłumaczenie (ćwiczenie samodzielne), którego odpowiedzią jest zdanie „There is a bed in my room”. */
const bedTranslation = {
  exerciseType: "lesson_open_answer",
  objectiveId: ROOM_ID,
  instructionPl: "Przetłumacz na angielski.",
  prompt: "W moim pokoju jest łóżko.",
  answer: "There is a bed in my room",
  acceptedAnswers: [],
  focus: ["bed"],
};

function roomInput(overrides: Partial<LessonPoolAgentRunInput> = {}): LessonPoolAgentRunInput {
  return runInput({
    subjectId: roomChapter.id,
    objectiveSource: { source: "input", dynamicTopic: roomTopic },
    material: "There is a bed in my room. I like my bed.",
    ...overrides,
  });
}

describe("runLessonPoolAgent — hak planu, przykłady początkowe i porażki (etap 2a)", () => {
  const LISTS = "Słowa:\ncoat — płaszcz\nboots — buty";
  const covered = {
    objectives: [
      planObjective("coat", "Płaszcz to coat.", ["I like my coat."]),
      planObjective("boots", "Buty to boots.", ["My boots are new."]),
      planObjective("las", "Las i łąka.", ["The forest is green."]),
    ],
  };

  it("onObjectivesResolved: planer — przed pierwszym podagentem, spentUsd planera", async () => {
    const agent = new FakeLessonPoolAgent({ plans: [covered], stepCostUsd: 0.05 });
    const { deps } = setup({ agentProvider: agent, subjects: [chapter] });
    const coatId = `${chapter.id}.d42.coat`;
    const seen: { calls: number; resolved: unknown }[] = [];
    const result = await runLessonPoolAgent(
      deps,
      runInput({
        subjectId: chapter.id,
        objectiveSource: { source: "planner" },
        material: LISTS,
        topicTitle: "Unit 1",
        initialSpentUsd: 0.1,
        // Przykład początkowy zagadnienia z planu przegrywa z przykładami planu.
        initialExamples: { [coatId]: ["An old coat example."] },
        onObjectivesResolved: async (resolved) => {
          seen.push({ calls: agent.calls.length, resolved });
        },
      }),
      never,
    );
    expect(result.planStatus).toBe("accepted");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.calls).toBe(0);
    const ids = result.dynamicTopic!.objectives.map((objective) => objective.id);
    expect(ids[0]).toBe(coatId);
    expect(seen[0]!.resolved).toEqual({
      dynamicTopic: result.dynamicTopic,
      planExamples: { [ids[0]!]: ["I like my coat."], [ids[1]!]: ["My boots are new."], [ids[2]!]: ["The forest is green."] },
      spentUsd: expect.closeTo(0.15, 10),
    });
    expect(result.objectives[0]!.examples).toEqual(["I like my coat."]);
    expect(agent.calls).toHaveLength(3);
  });

  it("onObjectivesResolved: katalog (bez dynamicTopic) i wejście", async () => {
    const catalog = setup();
    const catalogSeen: { calls: number; resolved: unknown }[] = [];
    await runLessonPoolAgent(
      catalog.deps,
      runInput({
        initialSpentUsd: 0.2,
        onObjectivesResolved: async (resolved) => {
          catalogSeen.push({ calls: catalog.agent.calls.length, resolved });
        },
      }),
      never,
    );
    expect(catalogSeen).toEqual([{ calls: 0, resolved: { planExamples: {}, spentUsd: 0.2 } }]);
    expect(catalog.agent.calls).toHaveLength(2);

    const school = withAgentPolicy(schoolSubject, { blindSolveTypes: [], variantCheckTypes: [] });
    const dynamicTopic = schoolDynamicTopic(school.id);
    const input = setup({ subjects: [school] });
    const inputSeen: { calls: number; resolved: unknown }[] = [];
    await runLessonPoolAgent(
      input.deps,
      runInput({
        subjectId: school.id,
        objectiveSource: { source: "input", dynamicTopic },
        onObjectivesResolved: async (resolved) => {
          inputSeen.push({ calls: input.agent.calls.length, resolved });
        },
      }),
      never,
    );
    expect(inputSeen).toEqual([{ calls: 0, resolved: { dynamicTopic, planExamples: {}, spentUsd: 0 } }]);
    expect(input.agent.calls).toHaveLength(2);
  });

  it("błąd onObjectivesResolved przerywa run bez podagentów", async () => {
    const { agent, deps } = setup({ agent: { objectives: { [SLUG_A]: completeScript(A, 0), [SLUG_B]: completeScript(B, 100) } } });
    const failure = new Error("checkpoint lost");
    const settled = vi.fn(async () => undefined);
    const run = runLessonPoolAgent(
      deps,
      runInput({
        onObjectivesResolved: async () => {
          throw failure;
        },
        onObjectiveSettled: settled,
      }),
      never,
    );
    await expect(run).rejects.toBe(failure);
    expect(agent.calls).toEqual([]);
    expect(settled).not.toHaveBeenCalled();
  });

  it("initialExamples liczą się do statusu i są źródłem ujawnień", async () => {
    // Status: pełna paczka bez przykładów z `submit` jest kompletna dzięki przykładowi początkowemu.
    const status = setup({ agent: { objectives: { [SLUG_A]: [{ submit: { exercises: fullBatch(A, 0) } }] } } });
    const statusResult = await runLessonPoolAgent(
      status.deps,
      runInput({ skipObjectives: [B], initialExamples: { [A]: ["Przykład początkowy."] } }),
      never,
    );
    expect(statusResult.objectives[0]).toMatchObject({ objectiveId: A, status: "complete", missing: [], examples: ["Przykład początkowy."] });
    expect(status.agent.calls[0]!.input.cardSentences).toContain("Przykład początkowy.");

    // Ujawnienie: przykład początkowy rozwiązuje tłumaczenie zdania (karta go nie zawiera).
    const leak = setup({ subjects: [roomChapter], agent: { objectives: { room: [{ submit: { exercises: [bedTranslation] } }] } } });
    const leakResult = await runLessonPoolAgent(
      leak.deps,
      roomInput({ initialExamples: { [ROOM_ID]: ["There is a bed in my room."] } }),
      never,
    );
    expect(leakResult.rejections.map((entry) => entry.code)).toEqual(["leak_victim"]);
    expect(leakResult.objectives[0]!.exercises).toEqual([]);
  });

  it("examplesFixed przy źródle input: submit ignoruje przykłady, prompt nie prosi o przykłady", async () => {
    const school = withAgentPolicy(schoolSubject, { blindSolveTypes: [], variantCheckTypes: [] });
    const dynamicTopic = schoolDynamicTopic(school.id);
    const rzeki = dynamicTopic.objectives[0]!.id;
    const { agent, deps } = setup({
      subjects: [school],
      agent: { objectives: { rzeki: [{ submit: { exercises: [], examples: ["Wisła płynie przez Warszawę."] } }] } },
    });
    const result = await runLessonPoolAgent(
      deps,
      runInput({
        subjectId: school.id,
        objectiveSource: { source: "input", dynamicTopic },
        material: "Wisła i Odra.",
        examplesFixed: true,
        initialExamples: { [rzeki]: ["Odra płynie przez Wrocław."] },
      }),
      never,
    );
    expect(agent.calls[0]!.input.objective.examplesFromPlan).toBe(true);
    expect(agent.calls[0]!.outcomes[0]).toMatchObject({ examples: { accepted: 0, errors: ["examples are fixed by the plan"] } });
    expect(result.objectives[0]!.examples).toEqual(["Odra płynie przez Wrocław."]);
  });

  it("extraExposureSources odrzucają ćwiczenie samodzielne z tym zdaniem", async () => {
    const runWith = async (overrides: Partial<LessonPoolAgentRunInput>) => {
      const { agent, deps } = setup({ subjects: [roomChapter], agent: { objectives: { room: [{ submit: { exercises: [bedTranslation] } }] } } });
      return { agent, result: await runLessonPoolAgent(deps, roomInput(overrides), never) };
    };
    // Bez stałych zdań to samo ćwiczenie jest przyjmowane.
    const control = await runWith({});
    expect(control.result.objectives[0]!.exercises).toHaveLength(1);

    const story = await runWith({ extraExposureSources: ["There is a bed in my room."] });
    expect(story.result.rejections.map((entry) => entry.code)).toEqual(["leak_victim"]);
    expect(story.result.objectives[0]!.exercises).toEqual([]);
    expect(story.agent.calls[0]!.input.cardSentences).toContain("There is a bed in my room.");
  });

  it("failure niesie retryable", async () => {
    const { deps } = setup({
      agent: {
        objectives: {
          [SLUG_A]: [{ throw: new GenerationProviderError("rate_limit", { status: 429, retryAfterMs: 5000 }) }],
          [SLUG_B]: [{ throw: new GenerationProviderError("configuration", { status: 401 }) }],
        },
      },
    });
    const result = await runLessonPoolAgent(deps, runInput(), never);
    expect(result.objectives[0]).toMatchObject({ objectiveId: A, status: "failed" });
    expect(result.objectives[0]!.failure).toEqual({ errorCode: "provider_rate_limit", retryable: true, retryAfterMs: 5000 });
    expect(result.objectives[1]).toMatchObject({ objectiveId: B, status: "failed" });
    expect(result.objectives[1]!.failure).toEqual({ errorCode: "provider_configuration", retryable: false });
  });
});

describe("runLessonPoolAgent — grader kontroli otwartej (etap 2b)", () => {
  // Przedmiot testowy z listami szkoły: sędzia podpowiedzi i kontrola otwarta dla pytań otwartych.
  const school = withAgentPolicy(fixtureSubject, {
    blindSolveTypes: schoolAgentPolicy.blindSolveTypes,
    variantCheckTypes: schoolAgentPolicy.variantCheckTypes,
    hintJudgeTypes: schoolAgentPolicy.hintJudgeTypes!,
    openAnswerCheckTypes: schoolAgentPolicy.openAnswerCheckTypes!,
    checkerNeedsMaterial: true,
    ruleNotes: schoolAgentPolicy.ruleNotes!,
  });
  const ELEMENTS = [
    { id: "e1", text: "Wisła" },
    { id: "e2", text: "płynie przez Kraków" },
  ];
  const IDS = ELEMENTS.map((element) => element.id);
  const correctVerdict = {
    knowledge: "correct",
    precision: "concise",
    matchedElementIds: IDS,
    missingElementIds: [],
    incorrectStatements: [],
    redundantFragments: [],
    offTopicFragments: [],
    confusedConcepts: [],
    note: "",
  };
  const schoolOpen = (objectiveId: string, n: number, extra: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft => ({
    ...open(objectiveId, `Pytanie otwarte numer ${n}?`, `odpowiedź wzorcowa ${n}`),
    requiredElements: ELEMENTS,
    ...extra,
  });
  const withGrader = (grader: FakeAnswerGrader) => ({ grader: { provider: grader, timeoutMs: 60_000 } });
  const schoolInput = (overrides: Partial<LessonPoolAgentRunInput> = {}) => runInput({ subjectId: school.id, skipObjectives: [B], ...overrides });
  const graderLines = () =>
    vi.mocked(console.log).mock.calls.map((call) => String(call[0])).filter((line) => line.includes("grader_unavailable"));

  it("deps.grader dociera do narzędzi, a liczniki kontroli trafiają do stats", async () => {
    const grader = new FakeAnswerGrader().onDefault({ raw: correctVerdict });
    const { checker, deps } = setup({
      subjects: [school],
      agent: { objectives: { [SLUG_A]: [{ submit: { exercises: [schoolOpen(A, 1, { hint: "Pomyśl o rzekach." })] } }] } },
    });
    const result = await runLessonPoolAgent({ ...deps, ...withGrader(grader) }, schoolInput(), never);
    expect(grader.requests).toHaveLength(2);
    expect(checker.openCalls).toHaveLength(1);
    expect(result.objectives[0]!.exercises).toHaveLength(1);
    expect(result.stats).toMatchObject({
      hintChecks: 1,
      openChecks: 1,
      graderCalls: 2,
      hintUnavailable: 0,
      openUnavailable: 0,
      graderErrors: 0,
      graderInvalidVerdicts: 0,
    });
    // Grader nie wlicza się do wywołań checkera (sędzia + rozwiązujący otwarte).
    expect(result.stats.checkerCalls).toBeGreaterThan(0);
  });

  it("bez deps.grader kontrola otwarta nie dotyczy, a liczniki gradera zostają zerowe", async () => {
    const { checker, deps } = setup({
      subjects: [school],
      agent: { objectives: { [SLUG_A]: [{ submit: { exercises: [schoolOpen(A, 1)] } }] } },
    });
    const result = await runLessonPoolAgent(deps, schoolInput(), never);
    expect(checker.openCalls).toHaveLength(0);
    expect(result.stats).toMatchObject({ openChecks: 0, graderCalls: 0 });
    expect(result.objectives[0]!.exercises).toHaveLength(1);
  });

  it("jedna instancja AgentCheckRun na run: pamięć kontroli działa między zagadnieniami", async () => {
    const grader = new FakeAnswerGrader().onDefault({ raw: correctVerdict });
    const same = (objectiveId: string) => schoolOpen(objectiveId, 1);
    const { checker, deps } = setup({
      subjects: [school],
      // Jedno zagadnienie naraz: wynik pierwszego trafia do pamięci runu, zanim drugie wyśle to samo ćwiczenie.
      agent: { objectives: { [SLUG_A]: [{ submit: { exercises: [same(A)] } }], [SLUG_B]: [{ submit: { exercises: [same(B)] } }] } },
    });
    const result = await runLessonPoolAgent(
      { ...deps, ...withGrader(grader), policy: { concurrency: 1 } },
      schoolInput({ skipObjectives: [] }),
      never,
    );
    expect(result.objectives.map((objective) => objective.objectiveId)).toEqual([A, B]);
    // To samo ćwiczenie w dwóch zagadnieniach: jedno `solveOpen` i jedna para wywołań gradera.
    expect(checker.openCalls).toHaveLength(1);
    expect(grader.requests).toHaveLength(2);
    expect(result.stats.openChecks).toBe(1);
  });

  it("wyłącznik gradera: grader_unavailable w logu dokładnie raz na run, kontrola otwarta wyłączona do końca", async () => {
    const grader = new FakeAnswerGrader().onDefault({ error: "boom" });
    const { checker, deps } = setup({
      subjects: [school],
      agent: {
        objectives: {
          [SLUG_A]: [1, 2, 3, 4].map((n) => ({ submit: { exercises: [schoolOpen(A, n)] } })),
        },
      },
    });
    const result = await runLessonPoolAgent({ ...deps, ...withGrader(grader) }, schoolInput(), never);
    expect(graderLines()).toEqual(["[lesson-agent] run=run-1 grader_unavailable"]);
    // Trzecia i czwarta paczka po otwarciu wyłącznika: bez `solveOpen` i bez wywołań gradera.
    expect(checker.openCalls).toHaveLength(2);
    expect(result.stats.graderErrors).toBe(grader.requests.length);
    expect(result.stats.openUnavailable).toBe(2);
    expect(result.objectives[0]!.exercises).toHaveLength(4);
  });

  it("bez awarii gradera nie ma logu grader_unavailable", async () => {
    const grader = new FakeAnswerGrader().onDefault({ raw: correctVerdict });
    const { deps } = setup({
      subjects: [school],
      agent: { objectives: { [SLUG_A]: [{ submit: { exercises: [schoolOpen(A, 1)] } }] } },
    });
    await runLessonPoolAgent({ ...deps, ...withGrader(grader) }, schoolInput(), never);
    expect(graderLines()).toEqual([]);
  });
});
