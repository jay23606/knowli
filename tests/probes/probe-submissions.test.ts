import { describe, expect, it } from "vitest";
import type { LessonAgentToolOutcome, LessonObjectiveAgentInput, LessonObjectiveAgentTools, LessonPoolAgentProvider } from "../../packages/server/src/ports/ai";
import { recordingAgent, type AgentSubmission } from "./probe-submissions";

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
      submit: async () => outcome([{ index: 0, accepted: "ex-1" }, { index: 1, errors: ["the hint gives away the answer"] }]),
      remove: async () => ({ ...outcome([]), removed: [] }),
      shouldStop: () => false,
    };

    await recordingAgent(fakeAgent({ exercises }), log).runObjective(input, tools, { record: () => undefined }, new AbortController().signal);

    expect(log).toEqual([
      { objective: "rivers", call: 1, index: 0, exerciseType: "lesson_choice", accepted: "ex-1", exercise: exercises[0] },
      { objective: "rivers", call: 1, index: 1, exerciseType: "lesson_open_answer", errors: ["the hint gives away the answer"], exercise: exercises[1] },
    ]);
  });

  it("nie zmienia wyniku narzędzia ani pozostałych narzędzi", async () => {
    const log: AgentSubmission[] = [];
    const expected = outcome([{ index: 0, errors: ["x"] }]);
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
