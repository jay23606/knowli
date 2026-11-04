import { describe, expect, it } from "vitest";
import type { LessonExerciseDraft, LessonExerciseType } from "../types";
import { historyLikeSubject } from "../testing/history-like-subject";
import { agentObjectivesOf } from "./capable";
import {
  allExamples,
  createLessonAgentState,
  orderedEntries,
  orderedLesson,
  poolOf,
  takeIds,
  withExamples,
  withPool,
  type AgentPoolEntry,
  type LessonAgentState,
} from "./state";

const topic = historyLikeSubject.topics[0]!;
const objectives = agentObjectivesOf(topic);
const [first, second] = objectives.map((objective) => objective.id) as [string, string];

function draft(objectiveId: string, exerciseType: LessonExerciseType, answer: string): LessonExerciseDraft {
  return { exerciseType, objectiveId, answer, acceptedAnswers: [answer], focus: [] };
}

function entry(id: string, objectiveId: string, exerciseType: LessonExerciseType): AgentPoolEntry {
  return { id, draft: draft(objectiveId, exerciseType, id) };
}

function stateWith(overrides: Partial<Parameters<typeof createLessonAgentState>[0]> = {}): LessonAgentState {
  return createLessonAgentState({
    topic,
    objectives,
    fixed: [],
    examples: {},
    fixedSources: {},
    ...overrides,
  });
}

describe("createLessonAgentState", () => {
  it("buduje pusty stan z pustymi pulami i licznikiem od 1", () => {
    const state = stateWith();
    expect(state.topic).toBe(topic);
    expect(state.objectives).toBe(objectives);
    expect(poolOf(state, first)).toEqual([]);
    expect(orderedLesson(state)).toEqual([]);
    expect(state.nextId).toBe(1);
  });

  it("kopiuje przykłady i stałe źródła do map", () => {
    const state = stateWith({ examples: { [first]: ["a"] }, fixedSources: { [second]: ["b"] } });
    expect(state.examples.get(first)).toEqual(["a"]);
    expect(state.fixedSources.get(second)).toEqual(["b"]);
  });
});

describe("kolejność lekcji", () => {
  it("układa zagadnienia wg planu, a w zagadnieniu etapy intro, guided, productive, independent, poza ścieżką", () => {
    let state = stateWith();
    state = withPool(state, first, [
      entry("ex1", first, "lesson_listen_choice"),
      entry("ex2", first, "lesson_open_answer"),
      entry("ex3", first, "lesson_gap"),
      entry("ex4", first, "lesson_choice"),
      entry("ex5", first, "lesson_keywords"),
      entry("ex6", first, "lesson_card"),
    ]);
    state = withPool(state, second, [entry("ex7", second, "lesson_choice")]);
    expect(orderedEntries(state).map((item) => item.id)).toEqual(["ex6", "ex4", "ex3", "ex2", "ex1", "ex5", "ex7"]);
  });

  it("zagadnienia idą w kolejności planu niezależnie od kolejności ustawiania pul", () => {
    let state = stateWith();
    state = withPool(state, second, [entry("ex2", second, "lesson_card")]);
    state = withPool(state, first, [entry("ex1", first, "lesson_card")]);
    expect(orderedEntries(state).map((item) => item.objectiveId)).toEqual([first, second]);
  });

  it("miesza fixed i pulę stabilnie: ten sam etap — fixed przed pulą, kolejność wejścia w obrębie źródła", () => {
    const fixedGuidedA = draft(first, "lesson_choice", "fixedA");
    const fixedGuidedB = draft(first, "lesson_choice", "fixedB");
    const fixedIntro = draft(first, "lesson_card", "fixedIntro");
    let state = stateWith({ fixed: [fixedGuidedA, fixedIntro, fixedGuidedB] });
    state = withPool(state, first, [entry("ex1", first, "lesson_choice"), entry("ex2", first, "lesson_card")]);
    const entries = orderedEntries(state);
    expect(entries.map((item) => item.draft.answer)).toEqual(["fixedIntro", "ex2", "fixedA", "fixedB", "ex1"]);
    expect(entries.map((item) => item.id)).toEqual([null, "ex2", null, null, "ex1"]);
    expect(entries.every((item) => item.objectiveId === first)).toBe(true);
  });

  it("fixed nieznanych zagadnień trafiają za wszystkie znane, w kolejności wejścia", () => {
    const stray1 = draft("zzz.unknown", "lesson_open_answer", "stray1");
    const stray2 = draft("aaa.other", "lesson_card", "stray2");
    let state = stateWith({ fixed: [stray1, stray2] });
    state = withPool(state, second, [entry("ex1", second, "lesson_choice")]);
    const entries = orderedEntries(state);
    expect(entries.map((item) => item.draft.answer)).toEqual(["ex1", "stray1", "stray2"]);
    expect(entries.slice(1).map((item) => item.objectiveId)).toEqual(["zzz.unknown", "aaa.other"]);
    expect(orderedLesson(state)).toEqual(entries.map((item) => item.draft));
  });

  it("orderedLesson zwraca same szkice w kolejności orderedEntries", () => {
    let state = stateWith({ fixed: [draft(first, "lesson_open_answer", "f")] });
    state = withPool(state, first, [entry("ex1", first, "lesson_card")]);
    expect(orderedLesson(state).map((item) => item.answer)).toEqual(["ex1", "f"]);
  });
});

describe("poolOf", () => {
  it("nie zawiera ćwiczeń fixed", () => {
    let state = stateWith({ fixed: [draft(first, "lesson_card", "fixed")] });
    expect(poolOf(state, first)).toEqual([]);
    state = withPool(state, first, [entry("ex1", first, "lesson_choice")]);
    expect(poolOf(state, first).map((item) => item.id)).toEqual(["ex1"]);
  });

  it("dla nieznanego zagadnienia zwraca pustą listę", () => {
    expect(poolOf(stateWith(), "nope")).toEqual([]);
  });
});

describe("allExamples", () => {
  it("łączy przykłady i stałe źródła per zagadnienie bez duplikatów", () => {
    const state = stateWith({
      examples: { [first]: ["a", "b"], [second]: ["x"] },
      fixedSources: { [first]: ["b", "c"], "other.objective": ["z", "z"] },
    });
    expect(allExamples(state)).toEqual({
      [first]: ["a", "b", "c"],
      [second]: ["x"],
      "other.objective": ["z"],
    });
  });

  it("uwzględnia przykłady dodane przez withExamples", () => {
    const state = withExamples(stateWith({ fixedSources: { [first]: ["f"] } }), first, ["n1", "f"]);
    expect(allExamples(state)[first]).toEqual(["n1", "f"]);
  });
});

describe("niemutowalność", () => {
  it("withPool, withExamples i takeIds nie zmieniają wejścia", () => {
    const state = stateWith({
      fixed: [draft(first, "lesson_card", "f")],
      examples: { [first]: ["a"] },
      fixedSources: { [first]: ["s"] },
    });
    const pool = [entry("ex1", first, "lesson_choice")];
    const lines = ["e1"];
    const stateBefore = structuredClone(state);
    const poolBefore = structuredClone(pool);
    const linesBefore = structuredClone(lines);

    const afterPool = withPool(state, first, pool);
    const afterExamples = withExamples(state, first, lines);
    const taken = takeIds(state, 3);

    expect(state).toEqual(stateBefore);
    expect(pool).toEqual(poolBefore);
    expect(lines).toEqual(linesBefore);
    expect(afterPool).not.toBe(state);
    expect(afterExamples).not.toBe(state);
    expect(taken.state).not.toBe(state);
    expect(afterPool.pools).not.toBe(state.pools);
    expect(afterExamples.examples).not.toBe(state.examples);
  });

  it("withPool i withExamples zastępują wpis zagadnienia i zachowują resztę", () => {
    let state = stateWith({ examples: { [first]: ["a"], [second]: ["x"] } });
    state = withPool(state, first, [entry("ex1", first, "lesson_card")]);
    state = withPool(state, first, [entry("ex2", first, "lesson_choice")]);
    state = withExamples(state, first, ["new"]);
    expect(poolOf(state, first).map((item) => item.id)).toEqual(["ex2"]);
    expect(state.examples.get(first)).toEqual(["new"]);
    expect(state.examples.get(second)).toEqual(["x"]);
  });
});

describe("nieznane zagadnienie", () => {
  it("withPool i withExamples rzucają i nie zmieniają stanu", () => {
    const state = stateWith({ examples: { [first]: ["a"] } });
    const before = structuredClone(state);
    expect(() => withPool(state, "nope", [entry("ex1", "nope", "lesson_card")])).toThrow("unknown objective nope");
    expect(() => withExamples(state, "nope", ["x"])).toThrow("unknown objective nope");
    expect(state).toEqual(before);
    expect(poolOf(state, "nope")).toEqual([]);
    expect(allExamples(state)).toEqual({ [first]: ["a"] });
  });
});

describe("takeIds", () => {
  it("rzuca dla ujemnej lub niecałkowitej liczby", () => {
    const state = stateWith();
    expect(() => takeIds(state, -1)).toThrow("invalid id count");
    expect(() => takeIds(state, 1.5)).toThrow("invalid id count");
    expect(() => takeIds(state, Number.NaN)).toThrow("invalid id count");
    expect(state.nextId).toBe(1);
  });

  it("nadaje deterministyczne ex1, ex2 i kontynuuje numerację", () => {
    const state = stateWith();
    const firstTake = takeIds(state, 2);
    expect(firstTake.ids).toEqual(["ex1", "ex2"]);
    const secondTake = takeIds(firstTake.state, 1);
    expect(secondTake.ids).toEqual(["ex3"]);
    expect(secondTake.state.nextId).toBe(4);
  });

  it("n = 0 nie przesuwa licznika", () => {
    const taken = takeIds(stateWith(), 0);
    expect(taken.ids).toEqual([]);
    expect(taken.state.nextId).toBe(1);
  });
});
