import { describe, expect, it } from "vitest";
import { agentObjectivesOf } from "../../../domain/lessons/agent/capable";
import { createLessonAgentState, withPool } from "../../../domain/lessons/agent/state";
import { englishGrammarSubject } from "../../../domain/lessons/subjects/english-grammar/module";
import type { LessonExerciseDraft } from "../../../domain/lessons/types";
import { lessonAgentLimits } from "./lesson-pool-agent";
import { objectiveAgentInput } from "./lesson-pool-agent-input";

const TOPIC = englishGrammarSubject.topics.find((candidate) => candidate.id === "present_simple")!;
const OBJECTIVES = agentObjectivesOf(TOPIC);
const LIMITS = lessonAgentLimits(englishGrammarSubject, TOPIC, 0);

function draft(objectiveId: string, answer: string): LessonExerciseDraft {
  return { exerciseType: "lesson_open_answer", objectiveId, prompt: `Przetłumacz: ${answer}.`, answer, acceptedAnswers: [], focus: [answer] };
}

function inputFor(state: ReturnType<typeof createLessonAgentState>, position: number) {
  const objective = OBJECTIVES[position]!;
  return objectiveAgentInput({
    subject: englishGrammarSubject,
    topic: TOPIC,
    state,
    objective,
    limits: LIMITS.get(objective.id)!,
    material: "",
    graderAvailable: false,
    examplesFixed: false,
    maxSteps: 8,
  });
}

describe("objectiveAgentInput — pozycja i liczba ćwiczeń zagadnienia", () => {
  it("index = pozycja w kolejności lekcji; bez ćwiczeń existingCount = 0", () => {
    const state = createLessonAgentState({ topic: TOPIC, objectives: OBJECTIVES, fixed: [], examples: {}, fixedSources: {} });
    expect(OBJECTIVES.length).toBeGreaterThanOrEqual(3);
    OBJECTIVES.forEach((objective, position) => {
      const input = inputFor(state, position);
      expect(input.objective.id).toBe(objective.id);
      expect(input.objective.index).toBe(position);
      expect(input.objective.existingCount).toBe(0);
    });
  });

  it("existingCount = ćwiczenia zagadnienia w `fixed` + przyjęte (także poza ścieżką etapów); inne zagadnienia się nie liczą", () => {
    const [first, second] = OBJECTIVES.map((objective) => objective.id) as [string, string];
    let state = createLessonAgentState({
      topic: TOPIC,
      objectives: OBJECTIVES,
      fixed: [draft(second, "one"), draft(second, "two"), draft(first, "three")],
      examples: {},
      fixedSources: {},
    });
    state = withPool(state, second, [
      { id: "ex1", draft: draft(second, "four") },
      { id: "ex2", draft: { exerciseType: "lesson_listen_choice", objectiveId: second, stem: "I ___ it.", answer: "five", acceptedAnswers: [], focus: [] } },
    ]);
    expect(inputFor(state, 1).objective).toMatchObject({ index: 1, existingCount: 4 });
    expect(inputFor(state, 0).objective).toMatchObject({ index: 0, existingCount: 1 });
    expect(inputFor(state, 2).objective).toMatchObject({ index: 2, existingCount: 0 });
  });
});
