import { describe, expect, it } from "vitest";
import { schoolSubject } from "../subjects/school/module";
import { A, B, choice, contextFor, gap, keywords, listen, naChecks, open, stateWith, topic } from "../testing/agent-admission-fixtures";
import { withAgentPolicy } from "../testing/agent-test-subject";
import type { AgentObjective, LessonExerciseDraft, LessonExerciseType } from "../types";
import { admitBatch, precheckBatch } from "./admission";
import { agentObjectivesOf } from "./capable";
import { orderedLesson, poolOf, withPool, type AgentPoolEntry, type LessonAgentState } from "./state";
import { lessonInvariantCheck, objectiveAgentLimits, objectiveStatus } from "./status";

/** Szkoła (minima 3/2/2, rezerwa samodzielnych 1 → wymagane 3/2/3); fixture'y służą tylko do pokrycia. */
const school = withAgentPolicy(schoolSubject);
const schoolCtx = contextFor({ subject: school });

/** Dokłada szkice do puli zagadnienia z kolejnymi identyfikatorami (bez kontroli przyjęcia). */
function pooled(state: LessonAgentState, objectiveId: string, drafts: readonly LessonExerciseDraft[]): LessonAgentState {
  const existing = poolOf(state, objectiveId);
  const entries: AgentPoolEntry[] = drafts.map((draft, index) => ({ id: `ex${state.nextId + index}`, draft }));
  return { ...withPool(state, objectiveId, [...existing, ...entries]), nextId: state.nextId + drafts.length };
}

const guidedThree = [choice(A, 1), choice(A, 2), choice(A, 3)];
const productiveTwo = [gap(A, "Pierwszy rok ___.", "966"), gap(A, "Drugi rok ___.", "1025")];
const independentThree = [open(A, "Pytanie 1?", "Gniezno"), open(A, "Pytanie 2?", "Poznań"), open(A, "Pytanie 3?", "Kraków")];

describe("objectiveAgentLimits", () => {
  it("maxExercises = targetCount + listenAllowance + slack", () => {
    expect(objectiveAgentLimits({ targetCount: 8, listenAllowance: 2 }, { slack: 2 })).toEqual({
      targetCount: 8,
      listenAllowance: 2,
      maxExercises: 12,
    });
  });
});

describe("objectiveStatus — pokrycie etapów", () => {
  it("pełna pula szkoły (3/2/3, osiem ćwiczeń, przykład) jest kompletna", () => {
    let state = stateWith({ examples: { [A]: ["Stolica Piastów."] } });
    state = pooled(state, A, [...guidedThree, ...productiveTwo, ...independentThree]);
    expect(objectiveStatus(state, A, schoolCtx)).toEqual({
      counts: { guided: 3, productive: 2, independent: 3, outsideStages: 0, total: 8 },
      missing: [],
      complete: true,
    });
  });

  it("pula 3/2/2 → braki w etapie samodzielnym (rezerwa), bez innych etapów", () => {
    let state = stateWith({ examples: { [A]: ["Stolica."] } });
    state = pooled(state, A, [...guidedThree, ...productiveTwo, ...independentThree.slice(0, 2)]);
    const status = objectiveStatus(state, A, schoolCtx);
    expect(status.missing).toContain("independent: 2 of 3");
    expect(status.missing.some((line) => line.startsWith("guided") || line.startsWith("productive"))).toBe(false);
    expect(status.complete).toBe(false);
  });

  it("brakujące etapy mają postać `<etap>: <jest> of <wymagane>`", () => {
    const state = pooled(stateWith(), A, [choice(A, 1)]);
    const status = objectiveStatus(state, A, schoolCtx);
    expect(status.missing).toEqual(expect.arrayContaining(["guided: 1 of 3", "productive: 0 of 2", "independent: 0 of 3"]));
  });

  it("ćwiczenie ujawnione (odpowiedź równa przykładowi karty) nie liczy się do etapu, ale jest w counts", () => {
    let state = stateWith({ examples: { [A]: ["Gniezno"] } });
    state = pooled(state, A, [...guidedThree, ...productiveTwo, ...independentThree]);
    const status = objectiveStatus(state, A, schoolCtx);
    expect(status.counts.independent).toBe(3);
    expect(status.missing).toContain("independent: 2 of 3");
  });

  it("pytania otwarte z tą samą odpowiedzią liczą się jako jedno (reguła szkoły)", () => {
    let state = stateWith({ examples: { [A]: ["Stolica."] } });
    const same = [open(A, "Pytanie 1?", "Gniezno"), open(A, "Pytanie 2?", "Gniezno"), open(A, "Pytanie 3?", "Kraków")];
    state = pooled(state, A, [...guidedThree, ...productiveTwo, ...same]);
    expect(objectiveStatus(state, A, schoolCtx).missing).toContain("independent: 2 of 3");
  });

  it("brak różnych pytań otwartych przy pełnym etapie samodzielnym → osobny komunikat, nie zaniżone `independent`", () => {
    const calculation = (n: number): LessonExerciseDraft => ({
      exerciseType: "lesson_calculation",
      objectiveId: A,
      prompt: `Oblicz ${n} + ${n}.`,
      answer: String(2 * n),
      acceptedAnswers: [],
      focus: [],
    });
    let state = stateWith({ examples: { [A]: ["Stolica."] } });
    // Etap samodzielny 3/3 (jedno pytanie otwarte i dwa rachunki), ale tylko jedna odpowiedź otwarta.
    state = pooled(state, A, [...guidedThree, ...productiveTwo, open(A, "Pytanie 1?", "Gniezno"), calculation(21), calculation(34)]);
    const status = objectiveStatus(state, A, schoolCtx);
    expect(status.missing).toContain("distinct open answers: 1 of 2");
    expect(status.missing.some((line) => line.startsWith("independent"))).toBe(false);
    expect(status.complete).toBe(false);
  });

  it("ćwiczenia fixed liczą się do etapów i do total", () => {
    let state = stateWith({ fixed: [gap(A, "Fixed ___.", "966")], examples: { [A]: ["Stolica."] } });
    state = pooled(state, A, [...guidedThree, gap(A, "Pula ___.", "1025"), ...independentThree]);
    const status = objectiveStatus(state, A, schoolCtx);
    expect(status.counts).toMatchObject({ productive: 2, total: 8 });
    expect(status.missing).toEqual([]);
  });

  it("liczy tylko ćwiczenia swojego zagadnienia", () => {
    let state = stateWith({ examples: { [A]: ["Stolica."] } });
    state = pooled(state, B, guidedThree.map((draft) => ({ ...draft, objectiveId: B })));
    expect(objectiveStatus(state, A, schoolCtx).counts.total).toBe(0);
  });
});

describe("objectiveStatus — liczba, typy poza etapami, przykłady", () => {
  it("total poniżej targetCount → `exercises: 6 of 8`", () => {
    let state = stateWith({ examples: { [A]: ["Stolica."] } });
    state = pooled(state, A, [...guidedThree, ...productiveTwo, independentThree[0]!]);
    expect(objectiveStatus(state, A, schoolCtx).missing).toContain("exercises: 6 of 8");
  });

  it("lesson_listen_choice i lesson_keywords idą do outsideStages i nie liczą się do total", () => {
    let state = stateWith({ examples: { [A]: ["Stolica."] } });
    state = pooled(state, A, [listen(A, 1), keywords(A, "f1", 1), open(A, "Pytanie?", "Gniezno", "f1")]);
    expect(objectiveStatus(state, A, schoolCtx).counts).toMatchObject({ outsideStages: 2, independent: 1, total: 1 });
  });

  it("brak przykładów → `card examples: 0 of 1-3`, cztery → `4 of 1-3`", () => {
    expect(objectiveStatus(stateWith(), A, schoolCtx).missing).toContain("card examples: 0 of 1-3");
    const many = objectiveStatus(stateWith({ examples: { [A]: ["a", "b", "c", "d"] } }), A, schoolCtx).missing;
    expect(many).toContain("card examples: 4 of 1-3");
  });

  it("do przykładów liczą się tylko własne przykłady zagadnienia, nie stałe źródła", () => {
    const state = stateWith({ fixedSources: { [A]: ["Zdanie karty."] } });
    expect(objectiveStatus(state, A, schoolCtx).missing).toContain("card examples: 0 of 1-3");
  });

  it("zagadnienie bez limitów w kontekście to błąd wołającego", () => {
    expect(() => objectiveStatus(stateWith(), A, contextFor({}, [B]))).toThrow("no limits");
  });
});

describe("objectiveStatus — wymagane typy i braki przedmiotu", () => {
  it("grupa wymaganych typów bez ćwiczenia → `needs at least one <typ1> or <typ2>`", () => {
    const ctx = contextFor({
      subject: withAgentPolicy(schoolSubject, { requiredTypes: () => [["lesson_open_answer", "lesson_keywords"]] }),
    });
    const state = pooled(stateWith(), A, [choice(A, 1)]);
    expect(objectiveStatus(state, A, ctx).missing).toContain("needs at least one lesson_open_answer or lesson_keywords");
    const satisfied = pooled(stateWith(), A, [keywords(A, "f1", 1)]);
    expect(objectiveStatus(satisfied, A, ctx).missing.some((line) => line.startsWith("needs at least one"))).toBe(false);
  });

  it("typ spoza objective.exerciseTypes jest odfiltrowany, a pusta grupa pominięta", () => {
    const narrow: AgentObjective[] = agentObjectivesOf(topic).map((objective) => ({
      ...objective,
      exerciseTypes: ["lesson_choice", "lesson_gap"] as LessonExerciseType[],
    }));
    const required: LessonExerciseType[][] = [["lesson_keywords"], ["lesson_open_answer", "lesson_choice"]];
    const ctx = contextFor({ subject: withAgentPolicy(schoolSubject, { requiredTypes: () => required }) });
    const status = objectiveStatus(stateWith({ objectives: narrow }), A, ctx);
    expect(status.missing).toContain("needs at least one lesson_choice");
    expect(status.missing.filter((line) => line.startsWith("needs at least one"))).toHaveLength(1);
  });

  it("objectiveGaps przedmiotu dołączone na końcu, z pulą zagadnienia (fixed i pula)", () => {
    const seen: number[] = [];
    const ctx = contextFor({
      subject: withAgentPolicy(schoolSubject, {
        objectiveGaps: (pool) => {
          seen.push(pool.length);
          return ["subject gap"];
        },
      }),
    });
    const state = pooled(stateWith({ fixed: [gap(A, "Fixed ___.", "966")] }), A, [choice(A, 1)]);
    expect(objectiveStatus(state, A, ctx).missing.at(-1)).toBe("subject gap");
    expect(seen).toEqual([2]);
  });
});

describe("lessonInvariantCheck", () => {
  const ctx = contextFor();

  it("pusty dla stanu zbudowanego przez admitBatch", () => {
    const start = stateWith({ examples: { [A]: ["Stolica."] } });
    const drafts = [choice(A, 1), gap(A, "Rok ___.", "966"), open(A, "Rok chrztu?", "1025")];
    const { state } = admitBatch(start, A, precheckBatch(start, A, drafts, ctx), naChecks(drafts.length), ctx);
    expect(poolOf(state, A)).toHaveLength(3);
    expect(lessonInvariantCheck(state, ctx)).toEqual([]);
  });

  it("ofiara ujawnienia w puli → do usunięcia", () => {
    const state = pooled(stateWith({ examples: { [A]: ["966"] } }), A, [open(A, "Rok chrztu?", "966")]);
    expect(lessonInvariantCheck(state, ctx)).toEqual([{ objectiveId: A, id: "ex1" }]);
  });

  it("ofiara fixed → do usunięcia świeże źródło z puli, fixed nietknięte", () => {
    const state = pooled(stateWith({ fixed: [open(A, "Rok chrztu?", "966")] }), A, [gap(A, "Chrzest Polski w roku ___.", "966")]);
    expect(lessonInvariantCheck(state, ctx)).toEqual([{ objectiveId: A, id: "ex1" }]);
    expect(orderedLesson(state)).toHaveLength(2);
  });

  it("ofiara fixed ujawniona przykładem karty nie daje nic do usunięcia (źródło nie jest z puli)", () => {
    const state = stateWith({ fixed: [open(A, "Rok chrztu?", "966")], examples: { [A]: ["966"] } });
    expect(lessonInvariantCheck(state, ctx)).toEqual([]);
  });

  it("wpis puli odrzucony przez validatePool (duplikat) → do usunięcia", () => {
    const state = pooled(stateWith(), A, [choice(A, 1), choice(A, 1)]);
    expect(lessonInvariantCheck(state, ctx)).toEqual([{ objectiveId: A, id: "ex2" }]);
  });

  it("wpis puli odrzucony przez validatePoolExtra (słowa kluczowe bez rodziny) → do usunięcia", () => {
    const state = pooled(stateWith(), A, [keywords(A, "f9", 1)]);
    expect(lessonInvariantCheck(state, ctx)).toEqual([{ objectiveId: A, id: "ex1" }]);
  });

  it("nigdy nie zwraca ćwiczeń fixed, także gdy same są wadliwe", () => {
    const state = stateWith({ fixed: [choice(A, 1), choice(A, 1)] });
    expect(lessonInvariantCheck(state, ctx)).toEqual([]);
  });
});
