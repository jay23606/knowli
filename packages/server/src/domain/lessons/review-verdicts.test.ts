import { describe, expect, it } from "vitest";
import { decideObjectiveReview, type ParsedVerdict } from "./review-verdicts";

const none = new Set<number>();

function decide(
  freshCount: number,
  objectiveTotal: number,
  verdicts: ParsedVerdict[],
  extra: { calculationIndexes?: Set<number>; hardLeakIndexes?: Set<number> } = {},
) {
  return decideObjectiveReview({
    freshCount,
    objectiveTotal,
    verdicts,
    calculationIndexes: extra.calculationIndexes ?? none,
    hardLeakIndexes: extra.hardLeakIndexes ?? none,
  });
}

describe("decideObjectiveReview", () => {
  it("brak werdyktu i ok dają keep", () => {
    const result = decide(3, 6, [{ n: 2, verdict: "ok" }]);
    expect(result.outcomes).toEqual([{ kind: "keep" }, { kind: "keep" }, { kind: "keep" }]);
    expect(result.status).toBe("reviewed");
    expect(result.invalidVerdicts).toBe(0);
  });

  it("note daje keep_with_note bez odrzuconej poprawki", () => {
    const result = decide(2, 6, [{ n: 1, verdict: "note", category: "unnatural_language", reasonPl: "Dziwne zdanie." }]);
    expect(result.outcomes[0]).toEqual({
      kind: "keep_with_note",
      category: "unnatural_language",
      reasonPl: "Dziwne zdanie.",
      fixRejected: false,
    });
    expect(result.outcomes[1]).toEqual({ kind: "keep" });
  });

  it("duplikat werdyktu i n poza zakresem zwiększają invalidVerdicts", () => {
    const result = decide(2, 6, [
      { n: 1, verdict: "note", category: "other", reasonPl: "Pierwsza." },
      { n: 1, verdict: "drop", category: "ambiguous", reasonPl: "Druga." },
      { n: 0, verdict: "ok" },
      { n: 3, verdict: "ok" },
      { n: 2.5, verdict: "ok" },
    ]);
    expect(result.invalidVerdicts).toBe(4);
    expect(result.outcomes[0]).toMatchObject({ kind: "keep_with_note", reasonPl: "Pierwsza." });
    expect(result.outcomes[1]).toEqual({ kind: "keep" });
  });

  it("too_hard zawsze zostaje jako uwaga, także przy fix i drop", () => {
    const result = decide(3, 6, [
      { n: 1, verdict: "fix", category: "too_hard", reasonPl: "Trudne.", fixValid: true },
      { n: 2, verdict: "drop", category: "too_hard", reasonPl: "Trudne." },
    ]);
    expect(result.outcomes[0]).toMatchObject({ kind: "keep_with_note", category: "too_hard" });
    expect(result.outcomes[1]).toMatchObject({ kind: "keep_with_note", category: "too_hard" });
  });

  it("calculation + fix to keep_with_note bez odrzucenia poprawki", () => {
    const result = decide(
      2,
      6,
      [{ n: 2, verdict: "fix", category: "wrong_answer", reasonPl: "Zła liczba.", fixValid: true }],
      { calculationIndexes: new Set([1]) },
    );
    expect(result.outcomes[1]).toEqual({
      kind: "keep_with_note",
      category: "wrong_answer",
      reasonPl: "Zła liczba.",
      fixRejected: false,
    });
  });

  it("calculation + fix z fixValid false to także keep_with_note bez odrzucenia poprawki", () => {
    const result = decide(
      1,
      6,
      [{ n: 1, verdict: "fix", category: "ambiguous", reasonPl: "Niejasne.", fixValid: false }],
      { calculationIndexes: new Set([0]) },
    );
    expect(result.outcomes[0]).toEqual({
      kind: "keep_with_note",
      category: "ambiguous",
      reasonPl: "Niejasne.",
      fixRejected: false,
    });
  });

  it("calculation + drop nadal usuwa ćwiczenie", () => {
    const result = decide(
      1,
      6,
      [{ n: 1, verdict: "drop", category: "wrong_answer", reasonPl: "Zła liczba." }],
      { calculationIndexes: new Set([0]) },
    );
    expect(result.outcomes[0]).toMatchObject({ kind: "drop", category: "wrong_answer" });
  });

  it("fix poprawny daje replace", () => {
    const result = decide(1, 6, [
      { n: 1, verdict: "fix", category: "ambiguous", reasonPl: "Niejednoznaczne.", fixValid: true },
    ]);
    expect(result.outcomes[0]).toEqual({ kind: "replace", category: "ambiguous", reasonPl: "Niejednoznaczne." });
    expect(result.status).toBe("reviewed");
  });

  it("treść nieodpowiednia dla dziecka (unsuitable_content) jest twarda: drop usuwa, nieważny fix usuwa, ważny fix zamienia", () => {
    const result = decide(3, 6, [
      { n: 1, verdict: "drop", category: "unsuitable_content", reasonPl: "Przemoc w zdaniu." },
      { n: 2, verdict: "fix", category: "unsuitable_content", reasonPl: "Straszne zdanie.", fixValid: false },
      { n: 3, verdict: "fix", category: "unsuitable_content", reasonPl: "Prawdziwa osoba.", fixValid: true },
    ]);
    expect(result.outcomes).toEqual([
      { kind: "drop", category: "unsuitable_content", reasonPl: "Przemoc w zdaniu." },
      { kind: "drop", category: "unsuitable_content", reasonPl: "Straszne zdanie." },
      { kind: "replace", category: "unsuitable_content", reasonPl: "Prawdziwa osoba." },
    ]);
    expect(result.status).toBe("reviewed");
  });

  it("fix niepoprawny: twarda kategoria odpada, miękka zostaje z odrzuconą poprawką", () => {
    const result = decide(2, 6, [
      { n: 1, verdict: "fix", category: "leaked_solution", reasonPl: "Zdradza.", fixValid: false },
      { n: 2, verdict: "fix", category: "unclear_instruction", reasonPl: "Niejasne.", fixValid: false },
    ]);
    expect(result.outcomes[0]).toEqual({ kind: "drop", category: "leaked_solution", reasonPl: "Zdradza." });
    expect(result.outcomes[1]).toEqual({
      kind: "keep_with_note",
      category: "unclear_instruction",
      reasonPl: "Niejasne.",
      fixRejected: true,
    });
  });

  it("drop: twarda kategoria odpada, miękka zostaje jako uwaga", () => {
    const result = decide(2, 6, [
      { n: 1, verdict: "drop", category: "wrong_answer", reasonPl: "Błędna." },
      { n: 2, verdict: "drop", category: "off_material", reasonPl: "Spoza materiału." },
    ]);
    expect(result.outcomes[0]).toEqual({ kind: "drop", category: "wrong_answer", reasonPl: "Błędna." });
    expect(result.outcomes[1]).toEqual({
      kind: "keep_with_note",
      category: "off_material",
      reasonPl: "Spoza materiału.",
      fixRejected: false,
    });
  });

  describe("bezpiecznik", () => {
    it("jedna poprawka przy 1 świeżym i 6 ćwiczeniach to replace, nie suspicious", () => {
      const result = decide(1, 6, [
        { n: 1, verdict: "fix", category: "wrong_answer", reasonPl: "Błąd.", fixValid: true },
      ]);
      expect(result.status).toBe("reviewed");
      expect(result.outcomes[0]).toMatchObject({ kind: "replace" });
    });

    it("3 twarde drop przy 4 z 4 dają suspicious i wszystkie keep", () => {
      const result = decide(4, 4, [
        { n: 1, verdict: "drop", category: "ambiguous", reasonPl: "A." },
        { n: 2, verdict: "drop", category: "wrong_answer", reasonPl: "B." },
        { n: 3, verdict: "drop", category: "wrong_answer", reasonPl: "C." },
      ]);
      expect(result.status).toBe("suspicious");
      expect(result.outcomes).toEqual([{ kind: "keep" }, { kind: "keep" }, { kind: "keep" }, { kind: "keep" }]);
    });

    it("zachowuje invalidVerdicts także przy suspicious", () => {
      const result = decide(4, 4, [
        { n: 1, verdict: "drop", category: "ambiguous", reasonPl: "A." },
        { n: 2, verdict: "drop", category: "wrong_answer", reasonPl: "B." },
        { n: 3, verdict: "drop", category: "wrong_answer", reasonPl: "C." },
        { n: 9, verdict: "ok" },
      ]);
      expect(result.status).toBe("suspicious");
      expect(result.invalidVerdicts).toBe(1);
    });

    it("te same 3 drop na hardLeakIndexes nie uruchamiają bezpiecznika", () => {
      const result = decide(
        4,
        4,
        [
          { n: 1, verdict: "drop", category: "leaked_solution", reasonPl: "A." },
          { n: 2, verdict: "drop", category: "leaked_solution", reasonPl: "B." },
          { n: 3, verdict: "drop", category: "leaked_solution", reasonPl: "C." },
        ],
        { hardLeakIndexes: new Set([0, 1, 2]) },
      );
      expect(result.status).toBe("reviewed");
      expect(result.outcomes.filter((o) => o.kind === "drop")).toHaveLength(3);
    });

    it("dokładnie połowa nie uruchamia bezpiecznika", () => {
      const result = decide(4, 4, [
        { n: 1, verdict: "drop", category: "ambiguous", reasonPl: "A." },
        { n: 2, verdict: "fix", category: "wrong_answer", reasonPl: "B.", fixValid: true },
      ]);
      expect(result.status).toBe("reviewed");
      expect(result.outcomes[0]).toMatchObject({ kind: "drop" });
      expect(result.outcomes[1]).toMatchObject({ kind: "replace" });
    });

    it("replace na indeksie z twardym ujawnieniem też się nie liczy (jak drop)", () => {
      const result = decide(
        4,
        4,
        [
          { n: 1, verdict: "fix", category: "leaked_solution", reasonPl: "A.", fixValid: true },
          { n: 2, verdict: "fix", category: "leaked_solution", reasonPl: "B.", fixValid: true },
          { n: 3, verdict: "drop", category: "leaked_solution", reasonPl: "C." },
        ],
        { hardLeakIndexes: new Set([0, 1, 2]) },
      );
      expect(result.status).toBe("reviewed");
      expect(result.outcomes.map((o) => o.kind)).toEqual(["replace", "replace", "drop", "keep"]);
    });

    it("replace poza hardLeakIndexes liczy się do bezpiecznika", () => {
      const result = decide(
        4,
        4,
        [
          { n: 1, verdict: "fix", category: "wrong_answer", reasonPl: "A.", fixValid: true },
          { n: 2, verdict: "fix", category: "wrong_answer", reasonPl: "B.", fixValid: true },
          { n: 3, verdict: "fix", category: "wrong_answer", reasonPl: "C.", fixValid: true },
          { n: 4, verdict: "fix", category: "wrong_answer", reasonPl: "D.", fixValid: true },
        ],
        { hardLeakIndexes: new Set([0]) },
      );
      expect(result.status).toBe("suspicious");
    });

    it("nieparzysta liczba ćwiczeń: 3 z 5 uruchamia bezpiecznik, 2 z 5 nie", () => {
      const drops = (count: number): ParsedVerdict[] =>
        Array.from({ length: count }, (_, i) => ({
          n: i + 1,
          verdict: "drop" as const,
          category: "wrong_answer" as const,
          reasonPl: "X.",
        }));
      expect(decide(5, 5, drops(3)).status).toBe("suspicious");
      expect(decide(5, 5, drops(2)).status).toBe("reviewed");
    });

    it("uwagi i miękkie drop nie liczą się do bezpiecznika", () => {
      const result = decide(2, 2, [
        { n: 1, verdict: "drop", category: "off_material", reasonPl: "A." },
        { n: 2, verdict: "note", category: "other", reasonPl: "B." },
      ]);
      expect(result.status).toBe("reviewed");
    });
  });
});
