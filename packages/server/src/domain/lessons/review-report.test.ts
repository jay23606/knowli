import { describe, expect, it } from "vitest";
import { exerciseSnippet, mergeReviewReport, type LessonReviewReport } from "./review-report";
import type { LessonExerciseDraft } from "./types";

function report(overrides: Partial<LessonReviewReport> = {}): LessonReviewReport {
  return {
    status: "reviewed",
    objectives: [],
    changed: [],
    dropped: [],
    notes: [],
    toppedUp: [],
    machine: [],
    ...overrides,
  };
}

function dropped(index: number) {
  return { objectiveId: "o1", category: "ambiguous" as const, reasonPl: `Powód ${index}.`, snippet: `ćw. ${index}` };
}

describe("mergeReviewReport", () => {
  it("bez poprzedniego raportu zwraca przebieg z przeliczonym statusem", () => {
    const merged = mergeReviewReport(
      undefined,
      report({ status: "unreviewed", objectives: [{ objectiveId: "o1", status: "reviewed" }] }),
      new Set(),
    );
    expect(merged.status).toBe("reviewed");
    expect(merged.objectives).toEqual([{ objectiveId: "o1", status: "reviewed" }]);
  });

  it("nadpisuje zagadnienie z przebiegu i zachowuje pozostałe", () => {
    const merged = mergeReviewReport(
      report({
        objectives: [
          { objectiveId: "o1", status: "unreviewed", reason: "failed" },
          { objectiveId: "o2", status: "reviewed" },
        ],
      }),
      report({ objectives: [{ objectiveId: "o1", status: "reviewed" }, { objectiveId: "o3", status: "suspicious" }] }),
      new Set(),
    );
    expect(merged.objectives).toEqual([
      { objectiveId: "o1", status: "reviewed" },
      { objectiveId: "o2", status: "reviewed" },
      { objectiveId: "o3", status: "suspicious" },
    ]);
    expect(merged.status).toBe("reviewed");
  });

  it("łączy listy i przycina changed/notes/machine do żywych ćwiczeń", () => {
    const merged = mergeReviewReport(
      report({
        changed: [{ exerciseId: "e1", fingerprint: "f1", category: "ambiguous", reasonPl: "x", beforePl: "b", addedVariants: [] }],
        notes: [{ exerciseId: "e2", fingerprint: "f2", category: "other", reasonPl: "y", fixRejected: false }],
        machine: [{ exerciseId: "e1", fingerprint: "f1", reviewed: true }],
      }),
      report({
        changed: [{ exerciseId: "e3", fingerprint: "f3", category: "wrong_answer", reasonPl: "z", beforePl: "c", addedVariants: ["v"] }],
        notes: [{ exerciseId: "e4", fingerprint: "f4", category: "other", reasonPl: "w", fixRejected: true }],
        machine: [{ exerciseId: "e3", fingerprint: "f3", reviewed: false }],
      }),
      new Set(["e1", "e3", "e4"]),
    );
    expect(merged.changed.map((c) => c.exerciseId)).toEqual(["e1", "e3"]);
    expect(merged.notes.map((n) => n.exerciseId)).toEqual(["e4"]);
    expect(merged.machine.map((m) => m.exerciseId)).toEqual(["e1", "e3"]);
  });

  it("wpis machine z przebiegu zastępuje poprzedni dla tego samego ćwiczenia", () => {
    const merged = mergeReviewReport(
      report({ machine: [{ exerciseId: "e1", fingerprint: "old", reviewed: false }] }),
      report({ machine: [{ exerciseId: "e1", fingerprint: "new", reviewed: true }] }),
      new Set(["e1"]),
    );
    expect(merged.machine).toEqual([{ exerciseId: "e1", fingerprint: "new", reviewed: true }]);
  });

  it("dropped i toppedUp: limit 200, najstarsze obcinane", () => {
    const previous = report({ dropped: Array.from({ length: 150 }, (_, i) => dropped(i)) });
    const run = report({
      dropped: Array.from({ length: 100 }, (_, i) => dropped(150 + i)),
      toppedUp: Array.from({ length: 205 }, (_, i) => ({ objectiveId: `o${i}`, guided: 1, productive: 0, independent: 0 })),
    });
    const merged = mergeReviewReport(previous, run, new Set());
    expect(merged.dropped).toHaveLength(200);
    expect(merged.dropped[0]?.snippet).toBe("ćw. 50");
    expect(merged.dropped[199]?.snippet).toBe("ćw. 249");
    expect(merged.toppedUp).toHaveLength(200);
    expect(merged.toppedUp[0]?.objectiveId).toBe("o5");
  });

  it("status: wszystkie reviewed/suspicious to reviewed, mieszane to partial", () => {
    const base = report({ objectives: [{ objectiveId: "o1", status: "reviewed" }] });
    expect(
      mergeReviewReport(base, report({ objectives: [{ objectiveId: "o2", status: "suspicious" }] }), new Set()).status,
    ).toBe("reviewed");
    expect(
      mergeReviewReport(
        base,
        report({ objectives: [{ objectiveId: "o2", status: "unreviewed", reason: "timeout" }] }),
        new Set(),
      ).status,
    ).toBe("partial");
  });

  it("status: brak sprawdzonych zagadnień to unreviewed (także same disabled)", () => {
    const merged = mergeReviewReport(
      undefined,
      report({
        status: "reviewed",
        objectives: [
          { objectiveId: "o1", status: "unreviewed", reason: "disabled" },
          { objectiveId: "o2", status: "unreviewed", reason: "disabled" },
        ],
      }),
      new Set(),
    );
    expect(merged.status).toBe("unreviewed");
  });

  it("zachowuje model z przebiegu, a gdy go brak, z poprzedniego raportu", () => {
    expect(mergeReviewReport(report({ model: "a" }), report({ model: "b" }), new Set()).model).toBe("b");
    expect(mergeReviewReport(report({ model: "a" }), report(), new Set()).model).toBe("a");
  });
});

function draft(overrides: Partial<LessonExerciseDraft>): LessonExerciseDraft {
  return {
    exerciseType: "lesson_text",
    objectiveId: "o1",
    answer: "odp",
    acceptedAnswers: [],
    focus: [],
    ...overrides,
  } as LessonExerciseDraft;
}

describe("exerciseSnippet", () => {
  it("używa treści ćwiczenia i skraca do 80 znaków", () => {
    const snippet = exerciseSnippet(draft({ stem: "x".repeat(200) }));
    expect(snippet.length).toBeLessThanOrEqual(80);
    expect(snippet.startsWith("xxx")).toBe(true);
  });

  it("zamienia nowe linie i wielokrotne spacje na pojedynczą spację", () => {
    const snippet = exerciseSnippet(draft({ stem: "Ala\n ma\t\tkota" }));
    expect(snippet).toBe("Ala ma kota");
    expect(snippet).not.toMatch(/[\r\n]/);
  });

  it("wybiera pierwsze niepuste pole: stem, prompt, instrukcja, odpowiedź", () => {
    expect(exerciseSnippet(draft({ stem: "Pytanie", prompt: "Inny" }))).toBe("Pytanie");
    expect(exerciseSnippet(draft({ stem: " ", prompt: "Prompt" }))).toBe("Prompt");
    expect(exerciseSnippet(draft({ instructionPl: "Polecenie" }))).toBe("Polecenie");
    expect(exerciseSnippet(draft({ answer: "Tylko odpowiedź" }))).toBe("Tylko odpowiedź");
  });

  it("nie zwraca pustego tekstu", () => {
    expect(exerciseSnippet(draft({ answer: "" }))).toBe("(bez treści)");
  });
});
