import { readFileSync, readdirSync } from "node:fs";
import { messages } from "@learning/contracts";
import { describe, expect, it } from "vitest";
import { AppError } from "../../../errors";
import { A, B, choice, gap, keywords, listen, subject as fixtureSubject, topic } from "../../../domain/lessons/testing/agent-admission-fixtures";
import { withAgentPolicy } from "../../../domain/lessons/testing/agent-test-subject";
import type { DynamicTopicData, LessonExerciseDraft, SubjectModule } from "../../../domain/lessons/types";
import { emptyLessonAgentProgress, type LessonAgentProgress } from "./lesson-agent-checkpoint";
import {
  acceptedInLessonOrder,
  agentCheckStartLine,
  agentRejectedReasons,
  generationGapsOf,
  lessonAgentRunInputFor,
  lessonAgentRunOutcome,
  mergeAttemptIntoProgress,
  mergeGenerationGaps,
  outcomeObjectivesOf,
  unwrittenRejectionCodes,
  type LessonAgentRunInputArgs,
} from "./lesson-agent-outcome";
import { scopeFamiliesToRun, type LessonRunInput } from "./lesson-drafts";
import { emptyLessonPoolAgentStats, type LessonPoolAgentResult, type SettledObjective } from "./lesson-pool-agent";

/** Przedmioty wg cech, nie identyfikatorów: katalog, dynamiczny z planerem (rozdział), dynamiczny bez (szkoła). */
const catalog: SubjectModule = fixtureSubject;
const planner: SubjectModule = {
  ...fixtureSubject,
  id: "test_planner",
  buildDynamicTopic: () => topic,
  agentPolicy: { ...fixtureSubject.agentPolicy, planCoverage: () => ({ words: [], frames: [] }) },
};
const dynamic: SubjectModule = { ...fixtureSubject, id: "test_dynamic", buildDynamicTopic: () => topic };

const runTopic: DynamicTopicData = { titlePl: "Run", objectives: [] };
const checkpointTopic: DynamicTopicData = { titlePl: "Checkpoint", objectives: [] };
const draftTopic: DynamicTopicData = { titlePl: "Szkic", objectives: [] };
const schoolTopic: DynamicTopicData = { titlePl: "Etap zagadnień", objectives: [] };

function runInput(overrides: Partial<LessonRunInput> = {}): LessonRunInput {
  return {
    deckId: "deck-1",
    deckVersionId: "version-1",
    subjectId: catalog.id,
    topicId: topic.id,
    topicVersion: topic.version,
    objectiveIds: [A, B],
    poolSize: 16,
    material: "Materiał lekcji.",
    instruction: "Polecenie rodzica.",
    interests: ["piłka"],
    topicTitlePl: "Początki państwa",
    ...overrides,
  };
}

/** Identyfikator próby (w produkcji `randomUUID()` na każdą próbę). */
const NONCE = "9f3c1a2b-0000-4000-8000-000000000000";

function args(overrides: Partial<LessonAgentRunInputArgs> = {}): LessonAgentRunInputArgs {
  return {
    runId: "run-1",
    attempts: 2,
    expectedEditNumber: 5,
    attemptNonce: NONCE,
    subject: catalog,
    input: runInput(),
    graderAvailable: true,
    progress: undefined,
    draft: { exercises: [], examples: {} },
    catalogTopic: topic,
    ...overrides,
  };
}

function progressWith(overrides: Partial<LessonAgentProgress> = {}): LessonAgentProgress {
  return { ...emptyLessonAgentProgress(), ...overrides };
}

/** Wejście kierownika (bez kształtów „etap zagadnień” i „nic do dodania”). */
function agentInput(value: ReturnType<typeof lessonAgentRunInputFor>) {
  if ("needsObjectives" in value || "nothingToAdd" in value) throw new Error("expected agent input");
  return value;
}

const choiceA = choice(A, 1);
const gapA = gap(A, "Rok ___.", "966");
const choiceB = choice(B, 2);
const gapB = gap(B, "Drugi rok ___.", "1025");

describe("lessonAgentRunInputFor — pełna generacja", () => {
  it("pierwsza próba: wszystkie pola z wejścia runu", () => {
    expect(lessonAgentRunInputFor(args())).toEqual({
      runId: "run-1",
      subjectId: catalog.id,
      deckId: "deck-1",
      objectiveSource: { source: "catalog", topic },
      topicTitle: "Początki państwa",
      material: "Materiał lekcji.",
      instruction: "Polecenie rodzica.",
      interests: ["piłka"],
      poolSize: 16,
      graderAvailable: true,
      fixed: [],
      draftExamples: {},
      skipObjectives: [],
      familyScope: `${NONCE}:run-1:5:2`,
      initialSpentUsd: 0,
      initialExamples: {},
      examplesFixed: false,
      target: { mode: "pool" },
    });
  });

  it("bez polecenia i tematów zdań pola opcjonalne są nieobecne, tytuł pusty", () => {
    const { instruction: _i, interests: _t, topicTitlePl: _p, ...bare } = runInput();
    const value = agentInput(lessonAgentRunInputFor(args({ input: bare })));
    expect(value).not.toHaveProperty("instruction");
    expect(value).not.toHaveProperty("interests");
    expect(value.topicTitle).toBe("");
  });

  it("wznowienie: zagadnienia complete pomijane i stałe, pozostałe od zera; wydatek z budżetu", () => {
    const progress = progressWith({
      objectives: {
        [A]: { status: "complete", exercises: [choiceA, gapA], examples: ["Przykład A."] },
        [B]: { status: "incomplete", exercises: [choiceB], examples: ["Przykład B."] },
      },
      budgetSpentUsd: 0.25,
      totalSpentUsd: 0.4,
    });
    const value = agentInput(lessonAgentRunInputFor(args({ progress })));
    expect(value.fixed).toEqual([choiceA, gapA]);
    expect(value.skipObjectives).toEqual([A]);
    expect(value.initialExamples).toEqual({ [A]: ["Przykład A."] });
    expect(value.initialSpentUsd).toBe(0.25);
    expect(value.examplesFixed).toBe(false);
    expect(value.draftExamples).toEqual({});
  });

  it("wznowienie: fixed i skipObjectives w kolejności lekcji, nie w kolejności wpisów punktu kontrolnego", () => {
    const progress = progressWith({
      objectives: {
        [B]: { status: "complete", exercises: [choiceB], examples: ["Przykład B."] },
        [A]: { status: "complete", exercises: [choiceA], examples: ["Przykład A."] },
      },
    });
    const value = agentInput(lessonAgentRunInputFor(args({ progress })));
    expect(value.fixed).toEqual([choiceA, choiceB]);
    expect(value.skipObjectives).toEqual([A, B]);
    // Temat dynamiczny: kolejność jego zagadnień.
    const dynamicTopic: DynamicTopicData = {
      titlePl: "Temat",
      objectives: [B, A].map((id) => ({ id, titlePl: id, descriptionEn: id, cards: [] })),
    };
    const fromTopic = agentInput(lessonAgentRunInputFor(args({ subject: planner, progress: { ...progress, dynamicTopic } })));
    expect(fromTopic.fixed).toEqual([choiceB, choiceA]);
    expect(fromTopic.skipObjectives).toEqual([B, A]);
  });

  it("katalog: temat zawężony do zagadnień lekcji; wpis spoza lekcji pominięty", () => {
    const progress = progressWith({
      objectives: {
        [A]: { status: "complete", exercises: [choiceA], examples: ["Przykład A."] },
        [B]: { status: "complete", exercises: [choiceB], examples: ["Przykład B."] },
      },
    });
    const value = agentInput(lessonAgentRunInputFor(args({ input: runInput({ objectiveIds: [B] }), progress })));
    expect(value.objectiveSource).toEqual({ source: "catalog", topic: { ...topic, objectives: topic.objectives.filter((objective) => objective.id === B) } });
    expect(value.fixed).toEqual([choiceB]);
    expect(value.skipObjectives).toEqual([B]);
    expect(() => lessonAgentRunInputFor(args({ input: runInput({ objectiveIds: ["nieznane"] }) }))).toThrow(AppError);
  });

  it("wznowienie z planExamples → examplesFixed: true, przykłady planu dla wszystkich zagadnień", () => {
    const progress = progressWith({
      dynamicTopic: checkpointTopic,
      planExamples: { [A]: ["Plan A."], [B]: ["Plan B."] },
      objectives: { [A]: { status: "complete", exercises: [choiceA], examples: ["Plan A."] } },
    });
    const value = agentInput(lessonAgentRunInputFor(args({ subject: planner, progress })));
    expect(value.objectiveSource).toEqual({ source: "input", dynamicTopic: checkpointTopic });
    expect(value.examplesFixed).toBe(true);
    expect(value.initialExamples).toEqual({ [A]: ["Plan A."], [B]: ["Plan B."] });
  });

  it("puste planExamples (źródło katalogowe w punkcie kontrolnym) nie ustalają przykładów", () => {
    const value = agentInput(lessonAgentRunInputFor(args({ progress: progressWith({ planExamples: {} }) })));
    expect(value.examplesFixed).toBe(false);
  });

  it("familyScope per próba: ten sam run, edycja i numer próby („Ponów” odroczonego runu) — inne sufiksy rodzin", () => {
    const runId = "3f2a9c1e-0000-4000-8000-000000000000";
    const first = agentInput(lessonAgentRunInputFor(args({ runId, attempts: 1, attemptNonce: NONCE })));
    const retried = agentInput(lessonAgentRunInputFor(args({ runId, attempts: 1, attemptNonce: "c0ffee11-0000-4000-8000-000000000000" })));
    expect(first.familyScope).toBe(`${NONCE}:${runId}:5:1`);
    expect(retried.familyScope).not.toBe(first.familyScope);
    // Sufiks rodziny bierze z zakresu tylko początek — identyfikator próby, nie runu.
    const family = (scope: string) => scopeFamiliesToRun({ ...choiceA, familyId: "pytanie-1" }, scope).familyId;
    expect(family(first.familyScope!)).toBe("pytanie-1-r9f3c1a");
    expect(family(retried.familyScope!)).toBe("pytanie-1-rc0ffee");
  });

  describe("pierwszeństwo objectiveSource", () => {
    it("1: temat w punkcie kontrolnym wygrywa z tematem runu", () => {
      const value = agentInput(lessonAgentRunInputFor(args({
        subject: planner,
        input: runInput({ dynamicTopic: runTopic }),
        progress: progressWith({ dynamicTopic: checkpointTopic }),
      })));
      expect(value.objectiveSource).toEqual({ source: "input", dynamicTopic: checkpointTopic });
    });

    it("2: temat dynamiczny runu wygrywa z planerem", () => {
      const value = agentInput(lessonAgentRunInputFor(args({ subject: planner, input: runInput({ dynamicTopic: runTopic }) })));
      expect(value.objectiveSource).toEqual({ source: "input", dynamicTopic: runTopic });
      expect(value.examplesFixed).toBe(false);
    });

    it("3: przedmiot bez tematów dynamicznych → katalog (resolveLessonTopic); brak tematu → validation", () => {
      expect(agentInput(lessonAgentRunInputFor(args())).objectiveSource).toEqual({ source: "catalog", topic });
      const { catalogTopic: _topic, ...withoutTopic } = args();
      expect(() => lessonAgentRunInputFor(withoutTopic)).toThrow(AppError);
    });

    it("4: przedmiot z planerem (planCoverage) → planner, examplesFixed: true", () => {
      const value = agentInput(lessonAgentRunInputFor(args({ subject: planner })));
      expect(value.objectiveSource).toEqual({ source: "planner" });
      expect(value.examplesFixed).toBe(true);
    });

    it("5: pozostałe dynamiczne → etap zagadnień, potem input z jego wyniku", () => {
      expect(lessonAgentRunInputFor(args({ subject: dynamic }))).toEqual({ needsObjectives: true });
      const value = agentInput(lessonAgentRunInputFor(args({ subject: dynamic, schoolTopic })));
      expect(value.objectiveSource).toEqual({ source: "input", dynamicTopic: schoolTopic });
      expect(value.examplesFixed).toBe(false);
    });
  });
});

describe("lessonAgentRunInputFor — dogenerowanie", () => {
  const regenerate = { objectiveId: A, count: 4 };
  const draftExercises = [choice(A, 10), choiceB];
  const draft = { exercises: draftExercises, examples: { [A]: ["Szkic A."] }, storySentences: ["Zdanie historyjki."] };

  it("pierwsza próba: wszystkie pola", () => {
    expect(lessonAgentRunInputFor(args({ input: runInput({ regenerate }), draft }))).toEqual({
      runId: "run-1",
      subjectId: catalog.id,
      deckId: "deck-1",
      objectiveSource: { source: "catalog", topic },
      topicTitle: "Początki państwa",
      material: "Materiał lekcji.",
      instruction: "Polecenie rodzica.",
      interests: ["piłka"],
      poolSize: 16,
      graderAvailable: true,
      fixed: draftExercises,
      draftExamples: {},
      skipObjectives: [],
      familyScope: `${NONCE}:run-1:5:2`,
      initialSpentUsd: 0,
      initialExamples: { [A]: ["Szkic A."] },
      examplesFixed: true,
      extraExposureSources: ["Zdanie historyjki."],
      target: { mode: "add", objectiveId: A, count: 4 },
    });
  });

  it("bez historyjki nie ma extraExposureSources", () => {
    const value = agentInput(lessonAgentRunInputFor(args({ input: runInput({ regenerate }), draft: { exercises: [], examples: {} } })));
    expect(value).not.toHaveProperty("extraExposureSources");
  });

  it("wznowienie: count − nowe z punktu kontrolnego (bez typów poza etapami), fixed = szkic + nowe", () => {
    const added = [gapA, listen(A, 1), keywords(A, "f1", 1)];
    const progress = progressWith({ objectives: { [A]: { status: "incomplete", exercises: added, examples: [] } }, budgetSpentUsd: 0.1 });
    const value = agentInput(lessonAgentRunInputFor(args({ input: runInput({ regenerate }), draft, progress })));
    expect(value.target).toEqual({ mode: "add", objectiveId: A, count: 3 });
    expect(value.fixed).toEqual([...draftExercises, ...added]);
    expect(value.initialSpentUsd).toBe(0.1);
    expect(value.examplesFixed).toBe(true);
  });

  it("nowe z punktu kontrolnego pokrywają count → nothingToAdd (kierownik nie przyjmuje count < 1)", () => {
    const added = [gap(A, "Z1 ___.", "a"), gap(A, "Z2 ___.", "b"), gap(A, "Z3 ___.", "c"), gap(A, "Z4 ___.", "d")];
    const progress = progressWith({ objectives: { [A]: { status: "incomplete", exercises: added, examples: [] } } });
    expect(lessonAgentRunInputFor(args({ input: runInput({ regenerate }), draft, progress }))).toEqual({ nothingToAdd: true });
  });

  it("źródło: temat runu, potem temat szkicu, potem katalog; nigdy planer", () => {
    const withRun = agentInput(lessonAgentRunInputFor(args({ subject: planner, input: runInput({ regenerate, dynamicTopic: runTopic }), draft: { ...draft, dynamicTopic: draftTopic } })));
    expect(withRun.objectiveSource).toEqual({ source: "input", dynamicTopic: runTopic });
    const withDraft = agentInput(lessonAgentRunInputFor(args({ subject: planner, input: runInput({ regenerate }), draft: { ...draft, dynamicTopic: draftTopic } })));
    expect(withDraft.objectiveSource).toEqual({ source: "input", dynamicTopic: draftTopic });
    expect(() => lessonAgentRunInputFor(args({ subject: planner, input: runInput({ regenerate }), draft }))).toThrow(AppError);
  });
});

describe("lessonAgentRunOutcome", () => {
  const base = { planStatus: "not_needed" as const, objectives: [], accepted: 0, budgetExhausted: false, attempts: 1, maxAttempts: 3 };
  const transient = { errorCode: "provider_unavailable", retryable: true, retryAfterMs: 2000 };
  const permanent = { errorCode: "provider_refused", retryable: false };

  it("wiersz 1: budżet wyczerpany → finalize przy ≥ 1 przyjętym, inaczej failed/validation", () => {
    expect(lessonAgentRunOutcome({ ...base, budgetExhausted: true, accepted: 1 })).toEqual({ kind: "finalize" });
    expect(lessonAgentRunOutcome({ ...base, budgetExhausted: true })).toEqual({ kind: "failed", errorCode: "validation" });
  });

  it("wiersz 2: plan_failed przejściowy przy wolnych próbach → requeue z retryAfterMs", () => {
    expect(lessonAgentRunOutcome({ ...base, planStatus: "plan_failed", planFailure: transient })).toEqual({
      kind: "requeue",
      errorCode: "provider_unavailable",
      retryAfterMs: 2000,
    });
  });

  it("wiersz 3: plan_failed trwały albo bez prób → failed z kodem planu", () => {
    expect(lessonAgentRunOutcome({ ...base, planStatus: "plan_failed", planFailure: permanent })).toEqual({ kind: "failed", errorCode: "provider_refused" });
    expect(lessonAgentRunOutcome({ ...base, planStatus: "plan_failed", planFailure: transient, attempts: 3 })).toEqual({
      kind: "failed",
      errorCode: "provider_unavailable",
    });
  });

  it("wiersz 4: zagadnienie failed z retryable przy wolnych próbach → requeue (najdłuższe retryAfterMs)", () => {
    const objectives = [
      { status: "complete" as const },
      { status: "failed" as const, failure: { errorCode: "provider_rate_limited", retryable: true, retryAfterMs: 500 } },
      { status: "failed" as const, failure: transient },
    ];
    expect(lessonAgentRunOutcome({ ...base, objectives, accepted: 5 })).toEqual({ kind: "requeue", errorCode: "provider_rate_limited", retryAfterMs: 2000 });
    expect(lessonAgentRunOutcome({ ...base, objectives, accepted: 5, attempts: 3 })).toEqual({ kind: "finalize" });
  });

  it("wiersz 5: przyjęto ≥ 1 ćwiczenie → finalize", () => {
    const objectives = [{ status: "incomplete" as const }, { status: "failed" as const, failure: permanent }];
    expect(lessonAgentRunOutcome({ ...base, objectives, accepted: 1 })).toEqual({ kind: "finalize" });
  });

  it("wiersz 6: 0 ćwiczeń, wszystkie failed z jednym kodem → ten kod (attempts_exhausted przy przejściowym)", () => {
    expect(lessonAgentRunOutcome({ ...base, objectives: [{ status: "failed", failure: permanent }, { status: "failed", failure: permanent }] })).toEqual({
      kind: "failed",
      errorCode: "provider_refused",
    });
    expect(lessonAgentRunOutcome({ ...base, attempts: 3, objectives: [{ status: "failed", failure: transient }, { status: "failed", failure: transient }] })).toEqual({
      kind: "failed",
      errorCode: "attempts_exhausted",
    });
  });

  it("wiersz 7: 0 ćwiczeń bez wspólnego kodu → failed/validation", () => {
    expect(lessonAgentRunOutcome({ ...base, objectives: [{ status: "failed", failure: permanent }, { status: "incomplete" }] })).toEqual({
      kind: "failed",
      errorCode: "validation",
    });
    expect(lessonAgentRunOutcome({ ...base, objectives: [{ status: "failed", failure: permanent }, { status: "failed", failure: { errorCode: "provider_timeout", retryable: false } }] })).toEqual({
      kind: "failed",
      errorCode: "validation",
    });
    expect(lessonAgentRunOutcome(base)).toEqual({ kind: "failed", errorCode: "validation" });
  });

  it("wiersz 1 wygrywa z 4", () => {
    expect(lessonAgentRunOutcome({ ...base, budgetExhausted: true, accepted: 2, objectives: [{ status: "failed", failure: transient }] })).toEqual({
      kind: "finalize",
    });
  });

  it("wiersz 6 liczony po scaleniu postępu", () => {
    // Próba 2: B pada trwale bez ćwiczeń, ale A z próby 1 jest complete — po scaleniu wiersz 5, nie 6.
    const start = progressWith({ objectives: { [A]: { status: "complete", exercises: [choiceA], examples: [] } } });
    const result = attemptResult([settled(B, "failed", [], permanent)]);
    const merged = mergeAttemptIntoProgress(start, result, "pool");
    const outcome = lessonAgentRunOutcome({
      ...base,
      objectives: outcomeObjectivesOf(merged, result),
      accepted: acceptedInLessonOrder(merged, [A, B]).length,
    });
    expect(outcome).toEqual({ kind: "finalize" });
    // Bez A z punktu kontrolnego ta sama próba kończy się kodem B (wiersz 6).
    const alone = mergeAttemptIntoProgress(emptyLessonAgentProgress(), result, "pool");
    expect(lessonAgentRunOutcome({ ...base, objectives: outcomeObjectivesOf(alone, result), accepted: 0 })).toEqual({
      kind: "failed",
      errorCode: "provider_refused",
    });
  });
});

function settled(
  objectiveId: string,
  status: SettledObjective["status"],
  exercises: LessonExerciseDraft[],
  failure?: SettledObjective["failure"],
): SettledObjective {
  return { objectiveId, status, missing: [], exercises, examples: [`Przykład ${objectiveId}.`], steps: 1, spentUsd: 0, ...(failure ? { failure } : {}) };
}

function attemptResult(objectives: SettledObjective[], overrides: Partial<LessonPoolAgentResult> = {}): LessonPoolAgentResult {
  return {
    planStatus: "not_needed",
    objectives,
    stats: emptyLessonPoolAgentStats(),
    rejections: [],
    spentUsd: 0,
    unknownCostCalls: 0,
    ...overrides,
  };
}

describe("outcomeObjectivesOf", () => {
  it("porażka tej próby z ponawialnością wyniku, wcześniejsza jako nieponawialna", () => {
    const transient = { errorCode: "provider_unavailable", retryable: true };
    const progress = progressWith({
      objectives: {
        [A]: { status: "failed", failureCode: "provider_unavailable", exercises: [], examples: [] },
        [B]: { status: "failed", failureCode: "provider_timeout", exercises: [], examples: [] },
      },
    });
    expect(outcomeObjectivesOf(progress, attemptResult([settled(A, "failed", [], transient)]))).toEqual([
      { status: "failed", failure: transient },
      { status: "failed", failure: { errorCode: "provider_timeout", retryable: false } },
    ]);
  });
});

describe("mergeAttemptIntoProgress", () => {
  const rejection = (code: string) => ({ objectiveId: A, exerciseType: "lesson_gap", kind: "rule" as const, code, detail: "treść" });

  it("pula: wznowione zastępuje wpis, complete zostaje; wydatek, histogram i usunięcia sumowane", () => {
    const start = progressWith({
      objectives: {
        [A]: { status: "complete", exercises: [choiceA], examples: ["A."] },
        [B]: { status: "failed", failureCode: "provider_timeout", exercises: [choiceB], examples: ["B stary."] },
      },
      budgetSpentUsd: 0.25,
      totalSpentUsd: 0.5,
      rejectionCodes: { leak: 2 },
      removedAfterAcceptance: 1,
    });
    const result = attemptResult([settled(B, "incomplete", [gapB])], {
      spentUsd: 0.375,
      rejections: [rejection("leak"), rejection("duplicate")],
      stats: { ...emptyLessonPoolAgentStats(), submitted: 3, accepted: 1, invariantViolations: 2 },
    });
    expect(mergeAttemptIntoProgress(start, result, "pool")).toEqual({
      ...start,
      objectives: {
        [A]: { status: "complete", exercises: [choiceA], examples: ["A."] },
        [B]: { status: "incomplete", exercises: [gapB], examples: [`Przykład ${B}.`] },
      },
      budgetSpentUsd: 0.375,
      totalSpentUsd: 0.625,
      rejectionCodes: { leak: 3, duplicate: 1 },
      removedAfterAcceptance: 3,
    });
  });

  it("liczniki kontroli: sumowane między próbami jak histogram, bez pola gdy nic nie policzono", () => {
    const counted = (stats: Partial<LessonPoolAgentResult["stats"]>) =>
      attemptResult([], { stats: { ...emptyLessonPoolAgentStats(), ...stats } });
    // Zero liczników (jak w 2a) nie dodaje pola do punktu kontrolnego.
    expect(mergeAttemptIntoProgress(emptyLessonAgentProgress(), counted({}), "pool")).not.toHaveProperty("checkCounters");
    const first = mergeAttemptIntoProgress(emptyLessonAgentProgress(), counted({ hintChecks: 2, openChecks: 1, graderCalls: 3 }), "pool");
    expect(first.checkCounters).toEqual({ hintChecks: 2, openChecks: 1, graderCalls: 3 });
    const second = mergeAttemptIntoProgress(first, counted({ hintChecks: 1, graderCalls: 2, graderErrors: 1, openUnavailable: 1 }), "pool");
    expect(second.checkCounters).toEqual({ hintChecks: 3, openChecks: 1, graderCalls: 5, graderErrors: 1, openUnavailable: 1 });
    // Próba bez nowych liczników zachowuje dotychczasowe.
    expect(mergeAttemptIntoProgress(second, counted({}), "pool").checkCounters).toEqual(second.checkCounters);
  });

  it("pula: kod porażki zagadnienia i temat planu z wyniku", () => {
    const merged = mergeAttemptIntoProgress(
      emptyLessonAgentProgress(),
      attemptResult([settled(A, "failed", [], { errorCode: "provider_unavailable", retryable: true })], { dynamicTopic: runTopic }),
      "pool",
    );
    expect(merged.objectives[A]).toEqual({ status: "failed", failureCode: "provider_unavailable", exercises: [], examples: [`Przykład ${A}.`] });
    expect(merged.dynamicTopic).toEqual(runTopic);
  });

  it("add: dopisuje nowe ćwiczenia do wcześniejszych nowych", () => {
    const start = progressWith({ objectives: { [A]: { status: "incomplete", exercises: [gapA], examples: [] } } });
    const merged = mergeAttemptIntoProgress(start, attemptResult([settled(A, "complete", [choiceA])]), "add", A);
    expect(merged.objectives[A]).toEqual({ status: "complete", exercises: [gapA, choiceA], examples: [`Przykład ${A}.`] });
  });
});

describe("acceptedInLessonOrder", () => {
  it("ćwiczenia zagadnień w kolejności lekcji, zagadnienia spoza kolejności pominięte", () => {
    const progress = progressWith({
      objectives: {
        [B]: { status: "complete", exercises: [choiceB, gapB], examples: [] },
        other: { status: "complete", exercises: [choice("other", 9)], examples: [] },
        [A]: { status: "incomplete", exercises: [choiceA, gapA], examples: [] },
      },
    });
    expect(acceptedInLessonOrder(progress, [A, B])).toEqual([choiceA, gapA, choiceB, gapB]);
  });
});

describe("generationGapsOf", () => {
  const progress = progressWith({
    objectives: {
      [A]: { status: "incomplete", exercises: [choiceA], examples: [] },
      [B]: { status: "failed", failureCode: "provider_timeout", exercises: [], examples: [] },
      done: { status: "complete", exercises: [choice("done", 3)], examples: [] },
    },
  });

  it("pula: incomplete, failed i zagadnienie bez wpisu; complete bez luki", () => {
    expect(generationGapsOf(progress, [A, B, "done", "missing"], "pool")).toEqual([
      { objectiveId: A, reason: "incomplete" },
      { objectiveId: B, reason: "failed" },
      { objectiveId: "missing", reason: "incomplete" },
    ]);
  });

  it("add: niepełne → add_short z liczbą nowych (bez typów poza etapami); komplet ze statusu → brak luki", () => {
    const short = progressWith({ objectives: { [A]: { status: "incomplete", exercises: [gapA, listen(A, 1)], examples: [] } } });
    expect(generationGapsOf(short, [A, B], { add: { objectiveId: A, count: 4 } })).toEqual([
      { objectiveId: A, reason: "add_short", added: 1, requested: 4 },
    ]);
    const complete = progressWith({ objectives: { [A]: { status: "complete", exercises: [gapA], examples: [] } } });
    expect(generationGapsOf(complete, [A, B], { add: { objectiveId: A, count: 1 } })).toEqual([]);
    expect(generationGapsOf(emptyLessonAgentProgress(), [A], { add: { objectiveId: A, count: 2 } })).toEqual([
      { objectiveId: A, reason: "add_short", added: 0, requested: 2 },
    ]);
  });

  it("add: dodano co najmniej N przy pozostałych brakach etapów → brak luki (to nie add_short)", () => {
    const satisfied = progressWith({ objectives: { [A]: { status: "incomplete", exercises: [gapA, choiceA], examples: [] } } });
    expect(generationGapsOf(satisfied, [A, B], { add: { objectiveId: A, count: 2 } })).toEqual([]);
    expect(generationGapsOf(satisfied, [A, B], { add: { objectiveId: A, count: 1 } })).toEqual([]);
  });
});

describe("mergeGenerationGaps", () => {
  const previous = [
    { objectiveId: A, reason: "incomplete" as const },
    { objectiveId: B, reason: "failed" as const },
  ];

  it("pula zastępuje listę", () => {
    expect(mergeGenerationGaps(previous, [{ objectiveId: "x", reason: "incomplete" }], "pool")).toEqual([{ objectiveId: "x", reason: "incomplete" }]);
    expect(mergeGenerationGaps(previous, [], "pool")).toEqual([]);
  });

  it("add: komplet usuwa wpis zagadnienia, niepełne go podmienia", () => {
    expect(mergeGenerationGaps(previous, [], "add", A)).toEqual([{ objectiveId: B, reason: "failed" }]);
    const short = { objectiveId: A, reason: "add_short" as const, added: 1, requested: 3 };
    expect(mergeGenerationGaps(previous, [short], "add", A)).toEqual([{ objectiveId: B, reason: "failed" }, short]);
    expect(mergeGenerationGaps(undefined, [short], "add", A)).toEqual([short]);
  });
});


describe("agentCheckStartLine", () => {
  const grammar = withAgentPolicy(fixtureSubject, {});
  const school = withAgentPolicy(fixtureSubject, { hintJudgeTypes: ["lesson_open_answer"], openAnswerCheckTypes: ["lesson_open_answer"] });

  it("szkoła z graderem → hintJudge=on openCheck=on", () => {
    expect(agentCheckStartLine("run-1", school, true)).toBe("[lesson-agent] run=run-1 hintJudge=on openCheck=on");
  });

  it("szkoła bez gradera → openCheck=off, sędzia podpowiedzi zostaje", () => {
    expect(agentCheckStartLine("run-1", school, false)).toBe("[lesson-agent] run=run-1 hintJudge=on openCheck=off");
  });

  it("gramatyka (bez list etapu 2b), z graderem albo bez → oba off", () => {
    expect(agentCheckStartLine("run-1", grammar, true)).toBe("[lesson-agent] run=run-1 hintJudge=off openCheck=off");
    expect(agentCheckStartLine("run-1", grammar, false)).toBe("[lesson-agent] run=run-1 hintJudge=off openCheck=off");
    expect(agentCheckStartLine("run-1", withAgentPolicy(fixtureSubject, { hintJudgeTypes: [], openAnswerCheckTypes: [] }), true))
      .toBe("[lesson-agent] run=run-1 hintJudge=off openCheck=off");
  });
});

describe("agentRejectedReasons", () => {
  const labels = messages.lessons.agentRejectionReasons;

  it("mapuje znane kody na polskie etykiety; bez kluczy-kodów w wyniku", () => {
    const reasons = agentRejectedReasons({ card_word_missing: 2, limit_full: 1, leak_victim: 3 });
    expect(reasons).toEqual({
      [labels.card_word_missing!]: 2,
      [labels.limit_full!]: 1,
      [labels.leak_victim!]: 3,
    });
    expect(Object.keys(reasons)).not.toContain("card_word_missing");
  });

  it("kody o tej samej etykiecie sumuje, nieznane zbiera pod „inne powody”, zerowe pomija", () => {
    const reasons = agentRejectedReasons({ refine: 1, rule_exercise: 2, brand_new: 4, other_new: 1, blind_mismatch: 0 });
    expect(reasons).toEqual({
      [labels.refine!]: 3,
      [messages.lessons.agentRejectionOther]: 5,
    });
  });

  it("kody spoza katalogu nie trafiają do prototypu zwykłego obiektu", () => {
    expect(agentRejectedReasons({ constructor: 1, __proto__: 1 })).toEqual({ [messages.lessons.agentRejectionOther]: 1 });
    expect(agentRejectedReasons({})).toEqual({});
  });

  it("kody o nazwach z prototypu jako własne pola (JSON.parse, jak z JSONB) idą do „inne powody” bez podmiany prototypu", () => {
    // Literał obiektu z `__proto__` ustawia prototyp; JSON.parse daje własne pole „__proto__”.
    const stored = JSON.parse('{"constructor":1,"__proto__":2,"toString":1,"leak_victim":1}') as Record<string, number>;
    expect(Object.hasOwn(stored, "__proto__")).toBe(true);
    const reasons = agentRejectedReasons(stored);
    expect(reasons).toEqual({ [messages.lessons.agentRejectionOther]: 4, [labels.leak_victim!]: 1 });
    expect(Object.getPrototypeOf(reasons)).toBe(Object.prototype);
    expect(Object.keys(reasons)).not.toContain("__proto__");
  });

  it("każdy kod odrzucenia emitowany przez przyjęcie, narzędzia agenta, bramki przedmiotów i kontrole 2b ma etykietę", () => {
    // Skan źródeł emiterów kodów: `reject(rodzaj, "kod"`, `code: "kod"` (odrzucenia narzędzi, bramki
    // przedmiotów, kontrola otwarta) i krotki `["hint_…", …]` sędziego podpowiedzi. Nowy kod bez etykiety
    // pokazałby się rodzicowi jako „inne powody”.
    const subjectsDir = new URL("../../../domain/lessons/subjects/", import.meta.url);
    const policies = readdirSync(subjectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && readdirSync(new URL(`${entry.name}/`, subjectsDir)).includes("agent-policy.ts"))
      .map((entry) => new URL(`${entry.name}/agent-policy.ts`, subjectsDir));
    const files = [new URL("../../../domain/lessons/agent/admission.ts", import.meta.url), new URL("./lesson-pool-agent-tools.ts", import.meta.url), ...policies];
    const codes = new Set<string>();
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const pattern of [/reject\(\s*"[a-z]+",\s*"([a-z_]+)"/gu, /\bcode: "([a-z_]+)"/gu, /\["(hint_[a-z_]+)",/gu]) {
        for (const match of text.matchAll(pattern)) codes.add(match[1]!);
      }
    }
    // Skan działa: znajduje kody z każdego źródła (przyjęcie, narzędzia, bramki rozdziału i szkoły, kontrole 2b).
    for (const known of ["limit_full", "leak_victim", "variant_rejected", "refine", "open_not_accepted", "shape_malformed", "card_word_missing", "hint_reveals_answer", "hint_language"]) {
      expect(codes, known).toContain(known);
    }
    expect(policies.length).toBeGreaterThanOrEqual(2);
    expect([...codes].filter((code) => !Object.hasOwn(labels, code))).toEqual([]);
  });

  it("każdy kod z katalogu ma etykietę bez treści ćwiczeń (krótka, bez cudzysłowów)", () => {
    for (const label of Object.values(labels)) expect(label).toMatch(/^[^"„”]{3,60}$/u);
  });
});

describe("unwrittenRejectionCodes", () => {
  it("odejmuje kody już zapisane w szkicu; zerowe różnice pomija", () => {
    expect(unwrittenRejectionCodes({ rejectionCodes: { a: 3, b: 2, c: 1 }, rejectionCodesWritten: { a: 3, b: 1 } })).toEqual({ b: 1, c: 1 });
    expect(unwrittenRejectionCodes({ rejectionCodes: { a: 2 } })).toEqual({ a: 2 });
  });
});
