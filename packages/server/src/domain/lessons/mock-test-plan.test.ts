import { describe, expect, it } from "vitest";
import { planLessonMockTest } from "./mock-test-plan";
import type { LessonMockPoolEntry } from "./mock-test-plan";

/**
 * Testy planu kartkówki (zadanie 6, requirements 9.3). Czysta domena: wejściem
 * są wpisy puli opisane celem, etapem, typem i `targetKey` (bez bazy i sieci).
 */

let counter = 0;
function entry(overrides: Partial<LessonMockPoolEntry>): LessonMockPoolEntry {
  counter += 1;
  return {
    itemId: `item-${counter}`,
    itemRevisionId: `rev-${counter}`,
    objectiveId: "obj-a",
    exerciseType: "lesson_gap",
    stage: "productive",
    targetKey: `key-${counter}`,
    ...overrides,
  };
}

describe("planLessonMockTest — porcja i proporcje", () => {
  it("rozdziela cele proporcjonalnie (różnica ≤ 1)", () => {
    const pool = [
      entry({ objectiveId: "obj-a" }),
      entry({ objectiveId: "obj-a" }),
      entry({ objectiveId: "obj-a" }),
      entry({ objectiveId: "obj-b" }),
      entry({ objectiveId: "obj-b" }),
      entry({ objectiveId: "obj-b" }),
    ];
    const plan = planLessonMockTest({
      pool,
      objectiveIds: ["obj-a", "obj-b"],
      requestedCount: 4,
      exposedTargetKeys: [],
    });
    expect(plan.length).toBe(4);
    const a = plan.filter((p) => p.objectiveId === "obj-a").length;
    const b = plan.filter((p) => p.objectiveId === "obj-b").length;
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
    expect(a).toBe(2);
    expect(b).toBe(2);
  });

  it("nie przekracza requestedCount", () => {
    const pool = Array.from({ length: 10 }, () => entry({ objectiveId: "obj-a" }));
    const plan = planLessonMockTest({
      pool,
      objectiveIds: ["obj-a"],
      requestedCount: 3,
      exposedTargetKeys: [],
    });
    expect(plan.length).toBe(3);
  });

  it("zwraca mniej gdy pula ma mniej ćwiczeń niż porcja", () => {
    const pool = [entry({ objectiveId: "obj-a" }), entry({ objectiveId: "obj-b" })];
    const plan = planLessonMockTest({
      pool,
      objectiveIds: ["obj-a", "obj-b"],
      requestedCount: 5,
      exposedTargetKeys: [],
    });
    expect(plan.length).toBe(2);
  });
});

describe("planLessonMockTest — preferencje w obrębie celu", () => {
  it("preferuje niewidziane przed widzianymi", () => {
    const seen = entry({ objectiveId: "obj-a", targetKey: "seen", stage: "productive" });
    const unseen = entry({ objectiveId: "obj-a", targetKey: "unseen", stage: "productive" });
    const plan = planLessonMockTest({
      pool: [seen, unseen],
      objectiveIds: ["obj-a"],
      requestedCount: 1,
      exposedTargetKeys: ["seen"],
    });
    expect(plan[0]!.itemId).toBe(unseen.itemId);
  });

  it("preferuje produktywne/samodzielne przed prowadzonymi", () => {
    const guided = entry({ objectiveId: "obj-a", stage: "guided", targetKey: "g" });
    const productive = entry({ objectiveId: "obj-a", stage: "productive", targetKey: "p" });
    const plan = planLessonMockTest({
      pool: [guided, productive],
      objectiveIds: ["obj-a"],
      requestedCount: 1,
      exposedTargetKeys: [],
    });
    expect(plan[0]!.itemId).toBe(productive.itemId);
  });

  it("niewidziane ma priorytet nad etapem", () => {
    // widziane produktywne vs niewidziane prowadzone → niewidziane wygrywa
    const seenProductive = entry({ objectiveId: "obj-a", stage: "productive", targetKey: "sp" });
    const unseenGuided = entry({ objectiveId: "obj-a", stage: "guided", targetKey: "ug" });
    const plan = planLessonMockTest({
      pool: [seenProductive, unseenGuided],
      objectiveIds: ["obj-a"],
      requestedCount: 1,
      exposedTargetKeys: ["sp"],
    });
    expect(plan[0]!.itemId).toBe(unseenGuided.itemId);
  });
});

describe("planLessonMockTest — notice, determinizm, przeplot", () => {
  it("pomija lesson_notice", () => {
    const notice = entry({ objectiveId: "obj-a", exerciseType: "lesson_notice", stage: "intro" });
    const gap = entry({ objectiveId: "obj-a", exerciseType: "lesson_gap", stage: "productive" });
    const plan = planLessonMockTest({
      pool: [notice, gap],
      objectiveIds: ["obj-a"],
      requestedCount: 5,
      exposedTargetKeys: [],
    });
    expect(plan.length).toBe(1);
    expect(plan[0]!.exerciseType).not.toBe("lesson_notice");
  });

  it("pomija lesson_keywords (wsparcie trenera precyzji, nie sprawdzenie)", () => {
    const keywords = entry({ objectiveId: "obj-a", exerciseType: "lesson_keywords", stage: "guided", targetKey: "kw" });
    const gap = entry({ objectiveId: "obj-a", exerciseType: "lesson_gap", stage: "productive" });
    const plan = planLessonMockTest({ pool: [keywords, gap], objectiveIds: ["obj-a"], requestedCount: 5, exposedTargetKeys: [] });
    expect(plan.map((slot) => slot.exerciseType)).toEqual(["lesson_gap"]);
  });

  it("pomija lesson_listen_choice (ćwiczenie słuchowe poza ścieżką etapów, #198)", () => {
    const listen = entry({ objectiveId: "obj-a", exerciseType: "lesson_listen_choice", stage: "guided", targetKey: "listen" });
    const choice = entry({ objectiveId: "obj-a", exerciseType: "lesson_choice", stage: "guided" });
    const plan = planLessonMockTest({ pool: [listen, choice], objectiveIds: ["obj-a"], requestedCount: 5, exposedTargetKeys: [] });
    expect(plan.map((slot) => slot.exerciseType)).toEqual(["lesson_choice"]);
  });

  it("jest deterministyczny (tie-break po kolejności w puli)", () => {
    const a1 = entry({ objectiveId: "obj-a", stage: "productive", targetKey: "a1" });
    const a2 = entry({ objectiveId: "obj-a", stage: "productive", targetKey: "a2" });
    const input = {
      pool: [a1, a2],
      objectiveIds: ["obj-a"],
      requestedCount: 1,
      exposedTargetKeys: [] as string[],
    };
    const first = planLessonMockTest(input);
    const second = planLessonMockTest(input);
    expect(first).toEqual(second);
    expect(first[0]!.itemId).toBe(a1.itemId);
  });

  it("przeplata cele w kolejności objectiveIds (round-robin)", () => {
    const a1 = entry({ objectiveId: "obj-a", targetKey: "a1" });
    const a2 = entry({ objectiveId: "obj-a", targetKey: "a2" });
    const b1 = entry({ objectiveId: "obj-b", targetKey: "b1" });
    const b2 = entry({ objectiveId: "obj-b", targetKey: "b2" });
    const plan = planLessonMockTest({
      pool: [a1, a2, b1, b2],
      objectiveIds: ["obj-a", "obj-b"],
      requestedCount: 4,
      exposedTargetKeys: [],
    });
    expect(plan.map((p) => p.objectiveId)).toEqual(["obj-a", "obj-b", "obj-a", "obj-b"]);
  });

  it("ignoruje wpisy spoza objectiveIds lekcji", () => {
    const inScope = entry({ objectiveId: "obj-a" });
    const outScope = entry({ objectiveId: "obj-z" });
    const plan = planLessonMockTest({
      pool: [inScope, outScope],
      objectiveIds: ["obj-a"],
      requestedCount: 5,
      exposedTargetKeys: [],
    });
    expect(plan.length).toBe(1);
    expect(plan[0]!.objectiveId).toBe("obj-a");
  });
});


it("includes independent calculations in a mock test", () => {
  const calculation = entry({ exerciseType: "lesson_calculation", stage: "independent" });
  expect(planLessonMockTest({ pool: [calculation], objectiveIds: ["obj-a"], requestedCount: 1, exposedTargetKeys: [] })).toMatchObject([{ exerciseType: "lesson_calculation", itemId: calculation.itemId }]);
});
