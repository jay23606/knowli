import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../errors";
import { A, B, choice, gap, listen, open, subject as fixtureSubject, topic } from "../../../domain/lessons/testing/agent-admission-fixtures";
import { withAgentPolicy } from "../../../domain/lessons/testing/agent-test-subject";
import { schoolSubject } from "../../../domain/lessons/subjects/school/module";
import type { LessonExerciseDraft, SubjectModule } from "../../../domain/lessons/types";
import type { LessonAgentToolOutcome } from "../../../ports/ai";
import { FakeExerciseChecker, FakeLessonPoolAgent, type FakeLessonPoolAgentOptions } from "../../../providers/fake-lesson-agent";
import { runLessonPoolAgent, type LessonPoolAgentRunInput, type SettledObjective } from "./lesson-pool-agent";

/**
 * Tryb „dodaj N” kierownika (spec etapu 2a §6.4): jedno zagadnienie, limit nowych ćwiczeń
 * `remaining + stageGap + listenLeft`, komplet po `remaining` nowych bez braków etapów.
 */

const SLUG_A = A.split(".").at(-1)!;
const SLUG_B = B.split(".").at(-1)!;

/** Przedmiot testowy bez checkera (minima 3/4/2, rezerwa samodzielnych 1 → wymagane 3/4/3). */
const plain = withAgentPolicy(fixtureSubject, { blindSolveTypes: [], variantCheckTypes: [] });
/** Ten sam przedmiot z dodatkiem słuchowym (dwa `lesson_listen_choice` na zagadnienie). */
const listening = withAgentPolicy({ ...fixtureSubject, ttsForFeedbackSentence: true }, { blindSolveTypes: [], variantCheckTypes: [] });

/** Pełna paczka zagadnienia: 3 wybory, 4 luki, 3 pytania otwarte; `k` rozdziela numerację. */
function fullBatch(objectiveId: string, k: number): LessonExerciseDraft[] {
  const n = (i: number) => k + i;
  return [
    ...[1, 2, 3].map((i) => choice(objectiveId, n(i))),
    ...[1, 2, 3, 4].map((i) => gap(objectiveId, `Zdanie ${n(i)}: ___.`, `luka ${n(i)}`)),
    ...[1, 2, 3].map((i) => open(objectiveId, `Pytanie otwarte ${n(i)}?`, `wynik ${n(i)}`)),
  ];
}

/** Szkic zagadnienia z 12 ćwiczeniami i pełnymi etapami (pełna paczka i dwie luki więcej). */
function draftOf(objectiveId: string, k: number): LessonExerciseDraft[] {
  return [...fullBatch(objectiveId, k), gap(objectiveId, `Zdanie ${k + 5}: ___.`, `luka ${k + 5}`), gap(objectiveId, `Zdanie ${k + 6}: ___.`, `luka ${k + 6}`)];
}

/** Nowa luka (etap produktywny) bez kolizji ze szkicem. */
function extra(objectiveId: string, n: number): LessonExerciseDraft {
  return gap(objectiveId, `Dodatkowe zdanie ${n}: ___.`, `dodatek ${n}`);
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
    fixed: draftOf(A, 0),
    draftExamples: {},
    skipObjectives: [],
    familyScope: null,
    initialSpentUsd: 0,
    initialExamples: { [A]: ["Przykład karty A."], [B]: ["Przykład karty B."] },
    examplesFixed: true,
    target: { mode: "add", objectiveId: A, count: 2 },
    ...overrides,
  };
}

function setup(options: { agent?: FakeLessonPoolAgentOptions; subjects?: SubjectModule[] } = {}) {
  const agent = new FakeLessonPoolAgent(options.agent);
  const checker = new FakeExerciseChecker();
  const subjects = options.subjects ?? [plain];
  const deps = { agent, checker, subjects: { getSubject: (id: string) => subjects.find((subject) => subject.id === id) } };
  return { agent, checker, deps };
}

function outcomeOf(agent: FakeLessonPoolAgent, call: number, step: number): LessonAgentToolOutcome {
  return agent.calls[call]!.outcomes[step] as LessonAgentToolOutcome;
}

/** Podział etapów promptu: suma = remaining + braki etapów i nie przekracza limitu nowych ćwiczeń. */
function expectStagesWithin(
  targets: { guided: number; productive: number; independent: number; maxExercises: number },
  promptTargetCount: number,
): void {
  const sum = targets.guided + targets.productive + targets.independent;
  expect(sum).toBe(promptTargetCount);
  expect(sum).toBeLessThanOrEqual(targets.maxExercises);
}

const never = new AbortController().signal;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runLessonPoolAgent — tryb „dodaj N”: zakres i walidacja", () => {
  it("uruchamia tylko wybrane zagadnienie", async () => {
    const { agent, deps } = setup({
      agent: {
        objectives: {
          [SLUG_A]: [{ submit: { exercises: [extra(A, 1)] } }],
          [SLUG_B]: [{ submit: { exercises: [extra(B, 1), extra(B, 2)] } }],
        },
      },
    });
    const settled: SettledObjective[] = [];
    const result = await runLessonPoolAgent(
      deps,
      runInput({
        fixed: [...draftOf(A, 0), ...draftOf(B, 100)],
        target: { mode: "add", objectiveId: B, count: 2 },
        onObjectiveSettled: async (objective) => {
          settled.push(objective);
        },
      }),
      never,
    );
    expect(agent.calls.map((call) => call.objectiveId)).toEqual([B]);
    expect(result.objectives.map((objective) => [objective.objectiveId, objective.status])).toEqual([[B, "complete"]]);
    expect(result.objectives[0]!.exercises).toHaveLength(2);
    expect(settled.map((objective) => objective.objectiveId)).toEqual([B]);
  });

  it("planner w trybie add → validation bez wywołań", async () => {
    const school = withAgentPolicy(schoolSubject, { blindSolveTypes: [], variantCheckTypes: [] });
    const { agent, checker, deps } = setup({ subjects: [school] });
    const resolved = vi.fn(async () => undefined);
    const error = await runLessonPoolAgent(
      deps,
      runInput({
        subjectId: school.id,
        objectiveSource: { source: "planner" },
        fixed: [],
        target: { mode: "add", objectiveId: `${school.id}.d42.rzeki`, count: 2 },
        onObjectivesResolved: resolved,
      }),
      never,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("validation");
    expect(agent.planCalls).toEqual([]);
    expect(agent.calls).toEqual([]);
    expect(checker.solveCalls).toEqual([]);
    expect(resolved).not.toHaveBeenCalled();
  });

  it("nieznane zagadnienie → validation", async () => {
    const { agent, deps } = setup({ agent: { objectives: { [SLUG_A]: [{ submit: { exercises: [extra(A, 1)] } }] } } });
    const resolved = vi.fn(async () => undefined);
    const error = await runLessonPoolAgent(
      deps,
      runInput({ target: { mode: "add", objectiveId: `${A}_missing`, count: 2 }, onObjectivesResolved: resolved }),
      never,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("validation");
    expect(agent.calls).toEqual([]);
    expect(resolved).not.toHaveBeenCalled();
  });

  it("liczba ćwiczeń spoza liczb całkowitych ≥ 1 → validation bez wywołań", async () => {
    for (const count of [0, -1, 1.5, Number.NaN]) {
      const { agent, deps } = setup();
      await expect(runLessonPoolAgent(deps, runInput({ target: { mode: "add", objectiveId: A, count } }), never)).rejects.toMatchObject({
        code: "validation",
      });
      expect(agent.calls).toEqual([]);
    }
  });
});

describe("runLessonPoolAgent — tryb „dodaj N”: limity i komplet", () => {
  it("limit nowych: 12 w szkicu, +2, pełne etapy → najwyżej 2 + listenLeft", async () => {
    // Dodatek słuchowy 2, w szkicu jedno ćwiczenie słuchowe zagadnienia → listenLeft = 1, stageGap = 0.
    const eight = Array.from({ length: 8 }, (_, i) => extra(A, i + 1));
    const { agent, deps } = setup({ subjects: [listening], agent: { objectives: { [SLUG_A]: [{ submit: { exercises: eight } }] } } });
    const result = await runLessonPoolAgent(deps, runInput({ fixed: [...draftOf(A, 0), listen(A, 1)] }), never);
    // Prompt widzi tylko resztę dodatku słuchowego; przyjmowanie liczy łączny dodatek razem z `fixed`.
    expect(agent.calls[0]!.input.targets).toMatchObject({ targetCount: 2, listenAllowance: 1, maxExercises: 3 });
    expectStagesWithin(agent.calls[0]!.input.targets, 2);
    expect(result.objectives[0]!.exercises).toEqual(eight.slice(0, 3));
    expect(result.rejections.map((entry) => entry.code)).toEqual(Array.from({ length: 5 }, () => "limit_full"));
    expect(result.objectives[0]!.status).toBe("complete");
  });

  it("brak etapu: komplet po remaining i uzupełnieniu etapu", async () => {
    // Szkic bez trzeciego pytania otwartego: etap samodzielny 2 z 3 → stageGap = 1.
    const fixed = fullBatch(A, 0).slice(0, 9);
    const { agent, deps } = setup({
      agent: {
        objectives: {
          [SLUG_A]: [
            { submit: { exercises: [extra(A, 1), extra(A, 2)] } },
            { submit: { exercises: [open(A, "Nowe pytanie otwarte?", "nowy wynik")] } },
            { submit: { exercises: [extra(A, 3)] } },
          ],
        },
      },
    });
    const result = await runLessonPoolAgent(deps, runInput({ fixed }), never);
    const { targets } = agent.calls[0]!.input;
    expect(targets).toMatchObject({ targetCount: 3, maxExercises: 3 });
    expectStagesWithin(targets, 3);
    // Etap z brakiem dostaje w prompcie co najmniej brak.
    expect(targets.independent).toBeGreaterThanOrEqual(1);
    const first = outcomeOf(agent, 0, 0);
    expect(first.complete).toBe(false);
    expect(first.missing[0]).toBe("new exercises: 2 of 2");
    expect(first.missing).toContain("independent: 2 of 3");
    expect(outcomeOf(agent, 0, 1).complete).toBe(true);
    expect(result.objectives[0]).toMatchObject({ status: "complete", steps: 2 });
    expect(result.objectives[0]!.exercises).toHaveLength(3);
  });

  it("brak etapu bez uzupełnienia: remaining nowych nie wystarcza do kompletu", async () => {
    const fixed = fullBatch(A, 0).slice(0, 9);
    const { deps } = setup({ agent: { objectives: { [SLUG_A]: [{ submit: { exercises: [extra(A, 1), extra(A, 2)] } }] } } });
    const result = await runLessonPoolAgent(deps, runInput({ fixed }), never);
    expect(result.objectives[0]!.status).toBe("incomplete");
    expect(result.objectives[0]!.missing[0]).toBe("new exercises: 2 of 2");
    expect(result.objectives[0]!.missing).toContain("independent: 2 of 3");
  });

  it("zagadnienie już pełne: shouldStop dopiero po remaining nowych", async () => {
    const steps = [1, 2, 3].map((n) => ({ submit: { exercises: [extra(A, n)] } }));
    const { agent, deps } = setup({ agent: { objectives: { [SLUG_A]: steps } } });
    const result = await runLessonPoolAgent(deps, runInput(), never);
    const first = outcomeOf(agent, 0, 0);
    expect(first.complete).toBe(false);
    expect(first.missing[0]).toBe("new exercises: 1 of 2");
    // `targetCount` statusu = ćwiczenia zagadnienia w szkicu (12) + remaining (2).
    expect(first.missing).toContain("exercises: 13 of 14");
    expect(outcomeOf(agent, 0, 1).complete).toBe(true);
    expect(result.objectives[0]).toMatchObject({ status: "complete", steps: 2, missing: ["new exercises: 2 of 2"] });
    expect(result.objectives[0]!.exercises).toEqual([extra(A, 1), extra(A, 2)]);

    // Kontrola: w trybie puli to samo zagadnienie jest kompletne od startu — podagent nie robi kroku.
    const pool = setup({ agent: { objectives: { [SLUG_A]: steps } } });
    const poolResult = await runLessonPoolAgent(pool.deps, runInput({ target: { mode: "pool" }, skipObjectives: [B] }), never);
    expect(poolResult.objectives[0]).toMatchObject({ status: "complete", steps: 0 });
  });

  it("targets promptu: 12 w szkicu, +2, pełne etapy → targets.targetCount === 2", async () => {
    const { agent, deps } = setup({ agent: { objectives: { [SLUG_A]: [] } } });
    await runLessonPoolAgent(deps, runInput(), never);
    const { input } = agent.calls[0]!;
    expect(input.targets).toMatchObject({ targetCount: 2, listenAllowance: 0, maxExercises: 2 });
    // Bez podnoszenia etapu samodzielnego do minimum zagadnienia: `fixed` już je spełnia.
    expectStagesWithin(input.targets, 2);
    const { guided, productive, independent } = input.targets;
    expect(input.pool.stageCounts).toEqual({ guided, productive, independent });
    expect(input.pool.countPerObjective).toBe(guided + productive + independent);
    expect(input.objective.examplesFromPlan).toBe(true);
  });

  it("ćwiczenia szkicu innych zagadnień są źródłem ujawnień", async () => {
    // Dogenerowanie B; ćwiczenie szkicu A (wcześniej w lekcji) ujawnia odpowiedź nowego ćwiczenia B.
    const victim = open(B, "Rok, w którym rządził Mieszko?", "966");
    const runWith = async (fixed: LessonExerciseDraft[]) => {
      const { deps } = setup({ agent: { objectives: { [SLUG_B]: [{ submit: { exercises: [victim] } }] } } });
      return runLessonPoolAgent(deps, runInput({ fixed, target: { mode: "add", objectiveId: B, count: 2 } }), never);
    };
    // Bez kolizji ćwiczenie jest przyjmowane.
    const control = await runWith([...draftOf(A, 0), ...draftOf(B, 100)]);
    expect(control.objectives[0]!.exercises).toEqual([victim]);

    const result = await runWith([...draftOf(A, 0), open(A, "Rok chrztu?", "966"), ...draftOf(B, 100)]);
    expect(result.objectives.map((objective) => objective.objectiveId)).toEqual([B]);
    expect(result.rejections.map((entry) => entry.code)).toEqual(["leak_victim"]);
    expect(result.objectives[0]!.exercises).toEqual([]);
  });
});
