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

  it("wpisy changed i notes z przebiegu zastępują wcześniejsze tego samego ćwiczenia", () => {
    const merged = mergeReviewReport(
      report({
        changed: [{ exerciseId: "e1", fingerprint: "old", category: "ambiguous", reasonPl: "x", beforePl: "b", addedVariants: [] }],
        notes: [{ exerciseId: "e1", fingerprint: "old", category: "other", reasonPl: "y", fixRejected: false }],
      }),
      report({
        changed: [{ exerciseId: "e1", fingerprint: "new", category: "wrong_answer", reasonPl: "z", beforePl: "c", addedVariants: [] }],
        notes: [{ exerciseId: "e1", fingerprint: "new", category: "other", reasonPl: "w", fixRejected: true }],
      }),
      new Set(["e1"]),
    );
    expect(merged.changed).toHaveLength(1);
    expect(merged.changed[0]?.fingerprint).toBe("new");
    expect(merged.notes).toHaveLength(1);
    expect(merged.notes[0]).toMatchObject({ fingerprint: "new", fixRejected: true });
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
  it("łączy bodziec i odpowiedź", () => {
    expect(exerciseSnippet(draft({ stem: "Ala ___ kota", answer: "ma" }))).toBe("Ala ___ kota → ma");
  });

  it("wybiera najbardziej szczegółowy bodziec: stem, prompt, statement, clozeText, instructionPl", () => {
    expect(exerciseSnippet(draft({ stem: "Pytanie", prompt: "Inny", answer: "A" }))).toBe("Pytanie → A");
    expect(exerciseSnippet(draft({ stem: " ", prompt: "Prompt", answer: "A" }))).toBe("Prompt → A");
    expect(exerciseSnippet(draft({ clozeText: "Luka", instructionPl: "Polecenie", answer: "A" }))).toBe("Luka → A");
    expect(exerciseSnippet(draft({ instructionPl: "Polecenie", answer: "A" }))).toBe("Polecenie → A");
  });

  it("długie polecenie nie wypiera odpowiedzi", () => {
    const answer = "to jest odpowiedź o średniej długości";
    const snippet = exerciseSnippet(draft({ instructionPl: "x".repeat(300), answer }));
    expect(snippet.length).toBeLessThanOrEqual(80);
    expect(snippet.endsWith(` → ${answer}`)).toBe(true);
    expect(snippet).toContain("…");
  });

  it("gwarantuje odpowiedzi co najmniej 30 znaków i skraca ją, gdy jest dłuższa", () => {
    const snippet = exerciseSnippet(draft({ stem: "s".repeat(300), answer: "a".repeat(300) }));
    expect(snippet.length).toBeLessThanOrEqual(80);
    const shownAnswer = snippet.split(" → ")[1] ?? "";
    expect(shownAnswer.length).toBeGreaterThanOrEqual(30);
    expect(shownAnswer.endsWith("…")).toBe(true);
  });

  it("zamienia nowe linie i wielokrotne spacje na pojedynczą spację", () => {
    const snippet = exerciseSnippet(draft({ stem: "Ala\n ma\t\tkota", answer: "tak\r\nnie" }));
    expect(snippet).toBe("Ala ma kota → tak nie");
    expect(snippet).not.toMatch(/[\r\n]/);
  });

  it("sama odpowiedź i skracanie do 80 znaków", () => {
    expect(exerciseSnippet(draft({ answer: "Tylko odpowiedź" }))).toBe("Tylko odpowiedź");
    expect(exerciseSnippet(draft({ answer: "y".repeat(200) })).length).toBe(80);
  });

  it("puste ćwiczenie daje pusty tekst", () => {
    expect(exerciseSnippet(draft({ answer: "" }))).toBe("");
  });
});
