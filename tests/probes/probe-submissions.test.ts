import { describe, expect, it } from "vitest";
import type { LessonAgentToolOutcome, LessonObjectiveAgentInput, LessonObjectiveAgentTools, LessonPoolAgentProvider } from "../../packages/server/src/ports/ai";
import { cleanupCounters, recordingAgent, submissionMetrics, type AgentSubmission } from "./probe-submissions";

const outcome = (results: LessonAgentToolOutcome["results"]): LessonAgentToolOutcome => ({
  results,
  counts: { guided: 0, productive: 0, independent: 0, outsideStages: 0, total: 0 },
  missing: [],
  complete: false,
});

function fakeAgent(submitted: { exercises: unknown[] }): LessonPoolAgentProvider {
  return {
    name: "fake",
    model: "fake-model",
    async runObjective(_input: LessonObjectiveAgentInput, tools: LessonObjectiveAgentTools) {
      await tools.submit(submitted);
      return { steps: 1, stopReason: "model_finished" };
    },
    planObjectives: async () => ({ steps: 0, stopReason: "model_finished" }),
  } as unknown as LessonPoolAgentProvider;
}

const input = { objective: { id: "deck.topic.rivers" } } as unknown as LessonObjectiveAgentInput;

describe("recordingAgent", () => {
  it("zapisuje każde wysłane ćwiczenie z wynikiem walidacji i ostatnim członem zagadnienia", async () => {
    const log: AgentSubmission[] = [];
    const exercises = [{ exerciseType: "lesson_choice", answer: "a" }, { exerciseType: "lesson_open_answer", answer: "b" }];
    const tools: LessonObjectiveAgentTools = {
      submit: async () => outcome([
        { index: 0, exerciseType: "lesson_choice", stimulus: "a", accepted: "ex-1", notes: ["[check.variants] acceptedAnswers[0]: removed"] },
        { index: 1, exerciseType: "lesson_open_answer", stimulus: "b", errors: ["[check.hint_judge] hint: gives the answer away"] },
      ]),
      remove: async () => ({ ...outcome([]), removed: [] }),
      shouldStop: () => false,
    };

    await recordingAgent(fakeAgent({ exercises }), log).runObjective(input, tools, { record: () => undefined }, new AbortController().signal);

    expect(log).toEqual([
      { run: "main", objective: "rivers", call: 1, index: 0, exerciseType: "lesson_choice", accepted: "ex-1", notes: ["[check.variants] acceptedAnswers[0]: removed"], exercise: exercises[0] },
      { run: "main", objective: "rivers", call: 1, index: 1, exerciseType: "lesson_open_answer", errors: ["[check.hint_judge] hint: gives the answer away"], exercise: exercises[1] },
    ]);
  });

  it("nie zmienia wyniku narzędzia ani pozostałych narzędzi", async () => {
    const log: AgentSubmission[] = [];
    const expected = outcome([{ index: 0, exerciseType: null, stimulus: "", errors: ["x"] }]);
    let seen: LessonAgentToolOutcome | undefined;
    const agent = {
      ...fakeAgent({ exercises: [{}] }),
      async runObjective(_input: LessonObjectiveAgentInput, tools: LessonObjectiveAgentTools) {
        seen = await tools.submit({ exercises: [{}] });
        expect(tools.shouldStop()).toBe(true);
        return { steps: 1, stopReason: "stopped" as const };
      },
    } as unknown as LessonPoolAgentProvider;
    const tools: LessonObjectiveAgentTools = {
      submit: async () => expected,
      remove: async () => ({ ...outcome([]), removed: [] }),
      shouldStop: () => true,
    };

    await recordingAgent(agent, log).runObjective(input, tools, { record: () => undefined }, new AbortController().signal);

    expect(seen).toBe(expected);
    expect(log[0]).toMatchObject({ exerciseType: null, errors: ["x"] });
  });
});

const accepted = (objective: string, call: number, index: number, exerciseType: string, exercise: unknown, notes?: string[]): AgentSubmission =>
  ({ run: "main", objective, call, index, exerciseType, accepted: `ex-${objective}-${call}-${index}`, ...(notes === undefined ? {} : { notes }), exercise });
const rejected = (objective: string, call: number, index: number, exerciseType: string | null, errors: string[]): AgentSubmission =>
  ({ run: "main", objective, call, index, exerciseType, errors, exercise: {} });

describe("submissionMetrics", () => {
  it("dla pustego dziennika zwraca zera", () => {
    expect(submissionMetrics([])).toEqual({
      submitted: 0,
      accepted: 0,
      acceptedFirstCall: 0,
      rejectedByCode: {},
      rejectedByRule: {},
      acceptedWithNotes: {},
      submitCalls: 0,
      openAnswers: 0,
      openAnswersWithHint: 0,
    });
  });

  it("liczy wysłane, przyjęte, przyjęte w pierwszym wywołaniu i wywołania submit", () => {
    const log = [
      accepted("rivers", 1, 0, "lesson_choice", {}),
      rejected("rivers", 1, 1, "lesson_choice", ["[check.variants] x: y"]),
      accepted("rivers", 2, 0, "lesson_choice", {}),
      accepted("lakes", 1, 0, "lesson_choice", {}),
    ];

    expect(submissionMetrics(log)).toMatchObject({ submitted: 4, accepted: 3, acceptedFirstCall: 2, submitCalls: 3 });
  });

  it("odrzucenia per reguła: raz na wysłane ćwiczenie i id; błędy bez prefiksu pomija; kody bierze z wierszy dziennika", () => {
    const log = [
      rejected("rivers", 1, 0, "lesson_gap", ["[gap.blank_count] clozeText: a", "[gap.blank_count] clozeText: b", "[check.variants] acceptedAnswers: c"]),
      rejected("rivers", 1, 1, null, ["exercises must be an array"]),
      rejected("lakes", 1, 0, "lesson_gap", ["[gap.blank_count] clozeText: d"]),
    ];

    const metrics = submissionMetrics(log, [
      "[lesson-agent] run=abc obj=rivers status=done steps=3 accepted=5 rejected=duplicate:2,schema:1 hintsRemoved=0 variantsRemoved=0 quotesSnapped=0 costUsd=0.1",
      "[lesson-agent] run=abc obj=lakes status=done steps=3 accepted=5 rejected=duplicate:1 hintsRemoved=0 variantsRemoved=0 quotesSnapped=0 costUsd=0.1",
      "[lesson-agent] run=abc obj=ponds status=done steps=3 accepted=5 rejected=- hintsRemoved=0 variantsRemoved=0 quotesSnapped=0 costUsd=0.1",
    ]);

    expect(metrics.rejectedByRule).toEqual({ "gap.blank_count": 2, "check.variants": 1 });
    expect(metrics.rejectedByCode).toEqual({ duplicate: 3, schema: 1 });
  });

  it("przyjęte z notami per id reguły; noty bez prefiksu nie liczą się do reguł", () => {
    const log = [
      accepted("rivers", 1, 0, "lesson_choice", {}, ["[check.variants] acceptedAnswers[0]: removed", "[quote.snap] quote: x"]),
      accepted("rivers", 1, 1, "lesson_choice", {}, ["[check.variants] acceptedAnswers[1]: removed", "unchecked: a check by another model was unavailable; accepted without it"]),
      accepted("rivers", 1, 2, "lesson_choice", {}),
    ];

    expect(submissionMetrics(log).acceptedWithNotes).toEqual({ "check.variants": 2, "quote.snap": 1 });
  });

  it("openAnswersWithHint: przyjęte pytania otwarte z niepustą podpowiedzią bez noty hint.reveals_words", () => {
    const log = [
      accepted("rivers", 1, 0, "lesson_open_answer", { hint: "Think of the sea." }),
      accepted("rivers", 1, 1, "lesson_open_answer", { hint: "The Vistula." }, ["[hint.reveals_words] hint: removed"]),
      accepted("rivers", 1, 2, "lesson_open_answer", { hint: "  " }),
      accepted("rivers", 1, 3, "lesson_open_answer", {}),
      accepted("rivers", 1, 4, "lesson_choice", { hint: "ignored" }),
      rejected("rivers", 1, 5, "lesson_open_answer", ["[hint.judge] hint: bad"]),
    ];

    expect(submissionMetrics(log)).toMatchObject({ openAnswers: 4, openAnswersWithHint: 1 });
  });
});

describe("cleanupCounters", () => {
  it("sumuje liczniki oczyszczeń z wierszy dziennika zagadnień i pomija inne wiersze", () => {
    const lines = [
      "[lesson-agent] run=abc obj=rivers status=done steps=3 accepted=5 rejected=- hintsRemoved=1 variantsRemoved=2 quotesSnapped=3 costUsd=0.1000",
      "[lesson-agent] run=abc obj=lakes status=done steps=2 accepted=4 rejected=duplicate:1 hintsRemoved=0 variantsRemoved=1 quotesSnapped=0 costUsd=0.0500",
      "[lesson] run=abc something hintsRemoved=9",
    ];

    expect(cleanupCounters(lines)).toEqual({ hintsRemoved: 1, variantsRemoved: 3, quotesSnapped: 3 });
  });

  it("dla braku wierszy zwraca zera", () => {
    expect(cleanupCounters([])).toEqual({ hintsRemoved: 0, variantsRemoved: 0, quotesSnapped: 0 });
  });
});

describe("submissionMetrics: powody z ofiarą, indeksy pól i obcięcie listy", () => {
  it("liczy id reguły z powodu z ofiarą i nie liczy indeksów pól ani znacznika +N more", () => {
    const log = [
      rejected("rivers", 1, 0, "lesson_choice", [
        "adding this exercise would make the lesson reject exercise ex3: [pool.duplicate_stem] stem: same",
        "[check.variants] acceptedAnswers[0]: removed",
        "+4 more",
      ]),
    ];

    expect(submissionMetrics(log).rejectedByRule).toEqual({ "pool.duplicate_stem": 1, "check.variants": 1 });
  });
});

describe("submissionMetrics: dwa runy z nakładającą się numeracją wywołań", () => {
  const inRun = (run: string, entry: AgentSubmission): AgentSubmission => ({ ...entry, run });
  const log = [
    accepted("rivers", 1, 0, "lesson_choice", {}),
    rejected("rivers", 1, 1, "lesson_choice", ["[check.variants] x: y"]),
    accepted("rivers", 2, 0, "lesson_choice", {}),
    inRun("add", accepted("rivers", 1, 0, "lesson_choice", {})),
    inRun("add", rejected("rivers", 1, 1, "lesson_choice", ["[gap.blank_count] x: y"])),
  ];
  const lessonLogByRun = {
    main: ["[lesson-agent] run=a obj=rivers status=done steps=2 accepted=2 rejected=schema:1 hintsRemoved=1 variantsRemoved=0 quotesSnapped=2 costUsd=0.1"],
    add: ["[lesson-agent] run=b obj=rivers status=done steps=1 accepted=1 rejected=duplicate:1 hintsRemoved=0 variantsRemoved=3 quotesSnapped=0 costUsd=0.1"],
  };
  const of = (run: string) => submissionMetrics(log.filter((entry) => entry.run === run), lessonLogByRun[run as "main" | "add"]);

  it("miary liczone per run nie mieszą wywołań ani kodów", () => {
    expect(of("main")).toMatchObject({ submitted: 3, accepted: 2, acceptedFirstCall: 1, submitCalls: 2, rejectedByCode: { schema: 1 }, rejectedByRule: { "check.variants": 1 } });
    expect(of("add")).toMatchObject({ submitted: 2, accepted: 1, acceptedFirstCall: 1, submitCalls: 1, rejectedByCode: { duplicate: 1 }, rejectedByRule: { "gap.blank_count": 1 } });
  });

  it("zliczone razem numeracja zlewa wywołania (dlatego miary są per run)", () => {
    expect(submissionMetrics(log)).toMatchObject({ submitCalls: 2, acceptedFirstCall: 2 });
  });

  it("recordingAgent znakuje wpisy etykietą runu z chwili startu zagadnienia", async () => {
    const entries: AgentSubmission[] = [];
    let current = "main";
    const tools: LessonObjectiveAgentTools = {
      submit: async () => outcome([{ index: 0, exerciseType: "lesson_choice", stimulus: "a", accepted: "ex-1" }]),
      remove: async () => ({ ...outcome([]), removed: [] }),
      shouldStop: () => false,
    };
    const agent = recordingAgent(fakeAgent({ exercises: [{ exerciseType: "lesson_choice" }] }), entries, () => current);

    await agent.runObjective(input, tools, { record: () => undefined }, new AbortController().signal);
    current = "add";
    await agent.runObjective(input, tools, { record: () => undefined }, new AbortController().signal);

    expect(entries.map((entry) => [entry.run, entry.call])).toEqual([["main", 1], ["add", 1]]);
  });
});

describe("zgodność oczyszczeń z dziennika i not", () => {
  it("hintsRemoved z dziennika zgadza się z notami hint.reveals_words na tych samych danych", () => {
    const log = [
      accepted("rivers", 1, 0, "lesson_open_answer", { hint: "a" }, ["[hint.reveals_words] hint: removed"]),
      accepted("rivers", 1, 1, "lesson_open_answer", { hint: "b" }, ["[hint.reveals_words] hint: removed"]),
      accepted("rivers", 1, 2, "lesson_open_answer", { hint: "c" }),
    ];
    const lessonLog = ["[lesson-agent] run=a obj=rivers status=done steps=2 accepted=3 rejected=- hintsRemoved=2 variantsRemoved=0 quotesSnapped=0 costUsd=0.1"];

    expect(cleanupCounters(lessonLog).hintsRemoved).toBe(submissionMetrics(log).acceptedWithNotes["hint.reveals_words"]);
  });
});
