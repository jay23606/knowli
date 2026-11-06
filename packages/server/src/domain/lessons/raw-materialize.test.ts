import { messages } from "@learning/contracts";
import { describe, expect, it } from "vitest";
import { materializeRawExercise } from "./raw-materialize";
import { randomJson } from "./testing/random-json";

/**
 * Materializacja surowych rekordów agenta (spec katalogu reguł §4.3): kod liczy
 * odpowiedź i treść rachunku, słów kluczowych, par, grup i luk z bankiem. Rekord
 * z napisem `answer` przechodzi bez zmian (idempotencja), a wadliwy daje
 * zgłoszenia reguł zamiast wyjątku.
 */

const MATERIAL = "Skala mapy pozwala przeliczyć odległość na mapie na odległość w terenie.";
const SPEC = { kind: "scale_distance", params: { scaleDenominator: 25000, mapDistanceCm: 3 }, unit: "m", templateFamilyId: "map-scale" };
const CALCULATION = { exerciseType: "lesson_calculation", objectiveId: "o", calculation: SPEC, sourceRefs: [{ quote: MATERIAL }] };
const KEYWORDS = {
  exerciseType: "lesson_keywords", objectiveId: "o", familyId: "def",
  keywordOptions: [{ id: "k1", text: "światło" }, { id: "k2", text: "cukry" }, { id: "k3", text: "tlen" }, { id: "k4", text: "korzenie" }],
  keyOptionIds: ["k2", "k1"], sourceRefs: [{ quote: "przy udziale światła" }],
};
const MATCH = {
  exerciseType: "lesson_match", objectiveId: "o", instructionPl: "Połącz słowo z tłumaczeniem.",
  pairs: [{ left: "cat", right: "kot" }, { left: "dog", right: "pies" }, { left: "cow", right: "krowa" }],
  extraRight: ["koń"],
};
const GROUP = {
  exerciseType: "lesson_group", objectiveId: "o", instructionPl: "",
  groups: [{ id: "g1", label: "ssaki" }, { id: "g2", label: "ptaki" }],
  groupItems: [{ text: "pies", groupId: "g1" }, { text: "kot", groupId: "g1" }, { text: "wróbel", groupId: "g2" }, { text: "sowa", groupId: "g2" }],
  sourceRefs: [{ quote: "Ssaki karmią młode mlekiem." }],
};
const CLOZE = {
  exerciseType: "lesson_cloze", objectiveId: "o", instructionPl: " ",
  clozeText: "Równik dzieli Ziemię na ___, a bieguny łączy ___.", gapAnswers: ["półkule", "południk"], extraWords: ["równoleżnik"],
  sourceRefs: [{ quote: "Równik dzieli Ziemię na półkule." }],
};
const COMPUTED = [CALCULATION, KEYWORDS, MATCH, GROUP, CLOZE] as const;

function materialized(raw: unknown): Record<string, unknown> {
  const result = materializeRawExercise(raw);
  if (!result.ok) throw new Error(`not materialized: ${JSON.stringify(result.issues)}`);
  return result.record;
}

function issuesOf(raw: unknown) {
  const result = materializeRawExercise(raw);
  if (result.ok) throw new Error("materialized");
  return { exerciseType: result.exerciseType, issues: result.issues.map((issue) => [issue.rule as string, issue.field, issue.found]) };
}

describe("materializeRawExercise — kod liczy odpowiedź i treść", () => {
  it("rachunek: polecenie, treść i odpowiedź z kodu, bez wariantów i focus", () => {
    expect(materialized(CALCULATION)).toEqual({
      ...CALCULATION,
      instructionPl: messages.kid.lessonCalculationInstruction,
      prompt: "Na mapie w skali 1:25 000 odcinek ma 3 cm. Oblicz odległość w terenie w m.",
      answer: "750 m",
      acceptedAnswers: [],
      focus: [],
    });
  });

  it("słowa kluczowe, pary, grupy i luki: kanoniczna odpowiedź i polecenie domyślne", () => {
    expect(materialized(KEYWORDS)).toMatchObject({
      answer: "cukry, światło", instructionPl: messages.kid.lessonKeywordsInstruction, acceptedAnswers: [], focus: [],
    });
    expect(materialized(MATCH)).toMatchObject({ answer: "cat, dog, cow", instructionPl: MATCH.instructionPl, extraRight: ["koń"] });
    expect(materialized(GROUP)).toMatchObject({ answer: "ssaki / ptaki", instructionPl: messages.kid.lessonGroupInstruction });
    expect(materialized(CLOZE)).toMatchObject({ answer: "półkule, południk", instructionPl: messages.kid.lessonClozeInstruction });
  });

  it("tolerance: null to brak pola (tolerancja 0)", () => {
    const record = materialized({ ...CALCULATION, calculation: { ...SPEC, tolerance: null } });
    expect(record.calculation).toEqual(SPEC);
    expect(record.answer).toBe("750 m");
  });

  it("tolerancja ponad limit → calculation.tolerance z wynikiem i limitem", () => {
    expect(issuesOf({ ...CALCULATION, calculation: { ...SPEC, tolerance: 8 } })).toEqual({
      exerciseType: "lesson_calculation",
      issues: [["calculation.tolerance", "calculation.tolerance", "tolerance 8 m, limit 7,5 m (1% of the result 750 m)"]],
    });
  });

  it("calculation \"x\" i nieznany rodzaj → zgłoszenia rachunku zamiast wyjątku", () => {
    expect(issuesOf({ ...CALCULATION, calculation: "x" }).issues).toEqual([
      ["calculation.params", "calculation", 'calculation is not an object {kind, unit, params, templateFamilyId}; got "x"'],
    ]);
    expect(issuesOf({ ...CALCULATION, calculation: { ...SPEC, kind: "unknown" } }).issues[0]).toEqual(
      expect.arrayContaining(["calculation.params"]),
    );
  });

  it("zły kształt list typów liczonych → reguła kształtu pola", () => {
    expect(issuesOf({ ...MATCH, pairs: [null] })).toEqual({
      exerciseType: "lesson_match",
      issues: [["shape.pairs", "pairs[0]", "expected {left, right}, got null"]],
    });
    expect(issuesOf({ ...GROUP, groupItems: [{ text: "pies" }] }).issues).toEqual([
      ["shape.group_items", "groupItems[0].groupId", "expected a string, got nothing"],
    ]);
    expect(issuesOf({ ...KEYWORDS, keywordOptions: [null] }).issues[0]![0]).toBe("shape.keyword_options");
    expect(issuesOf({ ...CLOZE, gapAnswers: [1] }).issues[0]![0]).toBe("shape.gap_answers");
  });

  it("luki bez tekstu → cloze.text_required; tekst innego typu → shape.text_field", () => {
    expect(issuesOf({ ...CLOZE, clozeText: undefined }).issues).toEqual([["cloze.text_required", "clozeText", "clozeText is missing"]]);
    expect(issuesOf({ ...CLOZE, clozeText: 5 }).issues).toEqual([
      ["shape.text_field", "clozeText", "expected a string or null, got a number"],
    ]);
  });

  it("listy, które nie są tablicami, są puste jak dziś (liczność sprawdza kontrakt)", () => {
    expect(materialized({ ...MATCH, extraRight: "koń" })).toMatchObject({ extraRight: [] });
    expect(materialized({ ...KEYWORDS, keyOptionIds: null })).toMatchObject({ keyOptionIds: [], answer: "" });
  });

  it("cytaty par, grup i luk: null albo brak to brak pola, rachunek i słowa kluczowe przenoszą wartość", () => {
    expect(materialized({ ...MATCH, sourceRefs: null })).not.toHaveProperty("sourceRefs");
    expect(materialized({ ...CLOZE, sourceRefs: undefined })).not.toHaveProperty("sourceRefs");
    expect(materialized({ ...KEYWORDS, sourceRefs: null })).toHaveProperty("sourceRefs", null);
  });

  it("ton lektora: napis przechodzi przez słowa kluczowe, pary, grupy i luki, null i brak nie", () => {
    for (const raw of [KEYWORDS, MATCH, GROUP, CLOZE]) {
      expect(materialized({ ...raw, voiceTone: "gentle" })).toHaveProperty("voiceTone", "gentle");
      expect(materialized({ ...raw, voiceTone: null })).not.toHaveProperty("voiceTone");
    }
  });

  /**
   * Jawny wyjątek (spec §4.3): materializacja pomija pola, których dziś nie
   * przenosi — wyjaśnienie błędu par, grup, luk i słów kluczowych oraz ton
   * rachunku. Przeniesienie zmieniłoby treść dla dziecka (decyzja właściciela).
   */
  it("pola pomijane dziś są pomijane dalej", () => {
    const extra = { explanationPl: "Wyjaśnienie.", hint: "Podpowiedź.", familyId: "fam", prompt: "Model prompt." };
    for (const raw of [MATCH, GROUP, CLOZE]) {
      const record = materialized({ ...raw, ...extra });
      for (const field of ["explanationPl", "hint", "familyId", "prompt"]) expect(record).not.toHaveProperty(field);
    }
    const keywords = materialized({ ...KEYWORDS, ...extra, instructionPl: "Model." });
    expect(keywords).not.toHaveProperty("explanationPl");
    expect(keywords).not.toHaveProperty("hint");
    expect(keywords.instructionPl).toBe(messages.kid.lessonKeywordsInstruction);
    const calculation = materialized({ ...CALCULATION, ...extra, voiceTone: "gentle", instructionPl: "Model." });
    for (const field of ["explanationPl", "hint", "familyId", "voiceTone"]) expect(calculation).not.toHaveProperty(field);
    expect(calculation.prompt).toBe("Na mapie w skali 1:25 000 odcinek ma 3 cm. Oblicz odległość w terenie w m.");
    expect(calculation.instructionPl).toBe(messages.kid.lessonCalculationInstruction);
  });
});

describe("materializeRawExercise — rekord z odpowiedzią", () => {
  const EXTRA = { hint: "Podpowiedź.", prompt: "Model prompt.", familyId: "fam", explanationPl: "Wyjaśnienie błędu.", acceptedAnswers: ["x"], focus: ["x"] };

  it("zgodna odpowiedź: zostają pola materializacji i explanationPl, reszta znika", () => {
    const match = materialized({ ...MATCH, ...EXTRA, answer: "cat, dog, cow", voiceTone: "gentle" });
    expect(match).toEqual({ ...materialized(MATCH), voiceTone: "gentle", explanationPl: EXTRA.explanationPl });
    const calculation = materialized({ ...CALCULATION, ...EXTRA, answer: "750 m", instructionPl: "Model.", voiceTone: "gentle" });
    expect(calculation).toEqual({ ...materialized(CALCULATION), explanationPl: EXTRA.explanationPl });
    const keywords = materialized({ ...KEYWORDS, ...EXTRA, answer: "cukry, światło", instructionPl: "Model." });
    expect(keywords).toEqual({ ...materialized(KEYWORDS), familyId: "fam", explanationPl: EXTRA.explanationPl });
    for (const record of [match, calculation, keywords]) expect(record).not.toHaveProperty("hint");
  });

  it("zgodna odpowiedź bez list domyślnych: materializacja ich nie dopisuje (rekordy fake'a)", () => {
    const ready = { exerciseType: "lesson_match", objectiveId: "o", instructionPl: "Połącz.", pairs: MATCH.pairs, answer: "cat, dog, cow", focus: [] };
    expect(materialized(ready)).toEqual(ready);
  });

  it("inna odpowiedź (także wstrzyknięta): materializacja jak bez answer, bez explanationPl", () => {
    for (const raw of COMPUTED) {
      const injected = { ...raw, ...EXTRA, familyId: (raw as { familyId?: string }).familyId, answer: "zmyślona" };
      expect(materialized(injected)).toEqual(materialized(raw));
    }
  });

  it("zgodna odpowiedź nie omija kształtu: zły element listy dalej daje zgłoszenie", () => {
    expect(issuesOf({ ...MATCH, answer: "cat, dog, cow", pairs: [...MATCH.pairs, null] }).issues[0]![0]).toBe("shape.pairs");
  });
});

describe("materializeRawExercise — przejście bez zmian", () => {
  it("inne typy i obcy exerciseType przechodzą bez zmian; nie-obiekt → shape.record", () => {
    const gap = { exerciseType: "lesson_gap", objectiveId: "o", answer: "x" };
    expect(materialized(gap)).toBe(gap);
    const odd = { exerciseType: 5, objectiveId: "o" };
    expect(materialized(odd)).toBe(odd);
    expect(issuesOf(null)).toEqual({ exerciseType: "unknown", issues: [["shape.record", "exercise", "the exercise is null, not an object"]] });
    expect(issuesOf(["x"]).issues[0]![0]).toBe("shape.record");
  });
});

describe("materializeRawExercise — idempotencja", () => {
  /** Rekordy jak w `tests/integration/lesson-generation.test.ts`: rachunek z `parentAdded` i strict-schema z nullami. */
  const INTEGRATION = [
    { ...CALCULATION, sourceRefs: [{ quote: MATERIAL, parentAdded: true }] },
    { ...CALCULATION, calculation: { ...SPEC, params: { scaleDenominator: 25000, mapDistanceCm: 5 } } },
    {
      exerciseType: "lesson_gap", objectiveId: "english_grammar.present_simple.third_person_s", answer: "plays",
      acceptedAnswers: ["play"], focus: ["plays"], instructionPl: "Uzupełnij lukę.", stem: "She ___ tennis.",
      statement: null, prompt: null, hint: null, transformId: null, noticeSegments: null, options: null, correctOption: null, items: null,
    },
  ];

  it.each([...COMPUTED, ...INTEGRATION].map((raw) => [raw.exerciseType, raw] as const))(
    "%s: dwa przebiegi dają ten sam rekord",
    (_type, raw) => {
      const once = materialized(raw);
      expect(materialized(once)).toEqual(once);
      expect(materialized(structuredClone(once))).toEqual(once);
    },
  );
});

describe("materializeRawExercise — dowolny JSON (własność)", () => {
  it("nigdy nie rzuca; odrzucenie ma zgłoszenia z regułą, polem i found", () => {
    const bases = COMPUTED.map((raw) => ({ ...raw }) as Record<string, unknown>);
    for (let seed = 1; seed <= 1000; seed += 1) {
      // Co drugie ziarno: rachunek z losowo zmienioną specyfikacją albo jej parametrami (granice kalkulatora).
      const spec = seed % 4 === 0 ? randomJson(seed, { base: SPEC }) : { ...SPEC, params: randomJson(seed, { base: SPEC.params }) };
      const raw = seed % 2 === 0 ? { ...CALCULATION, calculation: spec } : randomJson(seed, { base: bases[seed % bases.length]! });
      const result = materializeRawExercise(raw);
      if (!result.ok) {
        expect(result.issues.length).toBeGreaterThan(0);
        for (const issue of result.issues) {
          expect(issue.field.trim()).not.toBe("");
          expect((issue.found ?? "").trim()).not.toBe("");
        }
      }
    }
  });
});
