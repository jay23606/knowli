import { describe, expect, it } from "vitest";
import { foreignObjectiveIssues, hasLenientRawShape, RAW_LIST_FIELDS, RAW_TEXT_FIELDS, rawShapeIssues } from "./raw-shape";
import { CORE_RULES } from "./rules/core-rules";
import { randomJson } from "./testing/random-json";

/** Poprawny kształtowo rekord wyboru (kontrakt i reguły puli to osobne sprawdzenia). */
const CHOICE = {
  exerciseType: "lesson_choice",
  objectiveId: "subject.topic.any",
  stem: "She ___ tennis.",
  answer: "plays",
  acceptedAnswers: [],
  focus: [],
  options: [{ id: "a", text: "plays" }, { id: "b", text: "play" }],
  correctOption: "a",
};

/** Rekord strict-schema: każde pole, które nie dotyczy typu, ma `null` (structured outputs). */
const STRICT_NULLS = {
  ...CHOICE,
  instructionPl: null,
  statement: null,
  prompt: null,
  hint: null,
  transformId: null,
  noticeSegments: null,
  visualSubject: null,
  items: null,
  questionType: null,
  requiredElements: null,
  supplementaryElements: null,
  commonErrors: null,
  expectedForm: null,
  familyId: null,
  sourceRefs: null,
  explanationPl: null,
  voiceTone: null,
};

/** Pojedyncze zgłoszenie (rule, field, found) rekordu wyboru z nadpisanymi polami. */
function onlyIssue(overrides: Record<string, unknown>) {
  const issues = rawShapeIssues({ ...CHOICE, ...overrides });
  expect(issues).toHaveLength(1);
  const [issue] = issues;
  return { rule: issue!.rule as string, field: issue!.field, found: issue!.found };
}

describe("rawShapeIssues — kształt rekordu agenta (spec katalogu reguł §4.3)", () => {
  it("poprawny rekord i rekord strict-schema z nullami nie mają zgłoszeń", () => {
    expect(rawShapeIssues(CHOICE)).toEqual([]);
    expect(rawShapeIssues(STRICT_NULLS)).toEqual([]);
  });

  it.each([
    [null, "exercise", "the exercise is null, not an object"],
    ["x", "exercise", "the exercise is a string, not an object"],
    [[CHOICE], "exercise", "the exercise is an array, not an object"],
    [{ ...CHOICE, exerciseType: 5 }, "exerciseType", "expected a string, got a number"],
    [{ ...CHOICE, objectiveId: undefined }, "objectiveId", "expected a string, got nothing"],
  ])("shape.record: %j", (raw, field, found) => {
    expect(rawShapeIssues(raw).map((issue) => [issue.rule, issue.field, issue.found])).toEqual([["shape.record", field, found]]);
  });

  it("brak exerciseType: bez shape.answer (typ decyduje, czy odpowiedź liczy kod), z typem wskazanym przez pola", () => {
    // Przebieg kontrolny 2026-11-06: pary i grupy bez typu dostawały też „answer: expected a string”,
    // więc model dopisywał `answer` do typów, których odpowiedź liczy kod.
    const match = { objectiveId: "o", instructionPl: "Połącz.", pairs: [{ left: "a", right: "b" }], extraRight: [] };
    expect(rawShapeIssues(match).map((issue) => [issue.rule, issue.field, issue.found])).toEqual([[
      "shape.record",
      "exerciseType",
      'expected a string, got nothing; the fields pairs, extraRight belong to lesson_match, so send "exerciseType": "lesson_match"',
    ]]);
    const group = { objectiveId: "o", groups: [{ id: "g", label: "G" }], groupItems: [{ text: "x", groupId: "g" }], sourceRefs: null };
    expect(rawShapeIssues(group)[0]!.found).toContain('so send "exerciseType": "lesson_group"');
    expect(rawShapeIssues({ ...CHOICE, exerciseType: null, items: [{ id: "a", text: "x" }], options: null })[0]!.found)
      .toContain('"exerciseType": "lesson_order"');
    expect(rawShapeIssues({ objectiveId: "o", calculation: { kind: "x" } })[0]!.found).toContain('"exerciseType": "lesson_calculation"');
  });

  it("brak exerciseType bez jednoznacznych pól: komunikat bez wskazania typu", () => {
    const { exerciseType: _type, ...untyped } = CHOICE;
    expect(rawShapeIssues(untyped).map((issue) => [issue.rule, issue.found])).toEqual([["shape.record", "expected a string, got nothing"]]);
    // Pola dwóch typów naraz: wskazanie byłoby zgadywaniem.
    expect(rawShapeIssues({ objectiveId: "o", pairs: [], groups: [] })[0]!.found).toBe("expected a string, got nothing");
  });

  it("shape.answer i shape.text_field: napis albo null", () => {
    expect(onlyIssue({ answer: null })).toEqual({ rule: "shape.answer", field: "answer", found: "expected a string, got null" });
    expect(onlyIssue({ stem: 5 })).toEqual({
      rule: "shape.text_field",
      field: "stem",
      found: "expected a string or null, got a number",
    });
    expect(onlyIssue({ familyId: ["def"] })).toMatchObject({ rule: "shape.text_field", field: "familyId" });
    // Poza strażnikiem: zły typ wyjaśnienia i tonu sanityzuje szkic (nota), nie kształt.
    expect(rawShapeIssues({ ...CHOICE, explanationPl: 5, voiceTone: 7 })).toEqual([]);
  });

  it("przypadki z planu: konkretna reguła, pole i otrzymany typ", () => {
    expect(onlyIssue({ requiredElements: [null] })).toEqual({
      rule: "shape.required_elements",
      field: "requiredElements[0]",
      found: "expected {id, text}, got null",
    });
    expect(onlyIssue({ sourceRefs: [null] })).toEqual({
      rule: "shape.source_refs",
      field: "sourceRefs[0]",
      found: "expected {quote}, got null",
    });
    expect(onlyIssue({ sourceRefs: ["quote"] })).toEqual({
      rule: "shape.source_refs",
      field: "sourceRefs[0]",
      found: "expected {quote}, got a string",
    });
    expect(onlyIssue({ pairs: [["a", "b"]] })).toEqual({
      rule: "shape.pairs",
      field: "pairs[0]",
      found: "expected {left, right}, got an array",
    });
    expect(onlyIssue({ calculation: "x" })).toEqual({
      rule: "shape.calculation",
      field: "calculation",
      found: "expected an object {kind, unit, params, templateFamilyId}, got a string",
    });
    expect(onlyIssue({ options: ["Warszawa"] })).toEqual({
      rule: "shape.options",
      field: "options[0]",
      found: "expected {id, text}, got a string",
    });
  });

  it("requiredElements: null to brak pola (strict-schema), nie zgłoszenie", () => {
    expect(rawShapeIssues({ ...CHOICE, requiredElements: null, sourceRefs: null, calculation: null })).toEqual([]);
  });

  it("brakujące pole elementu, wnętrze listy list i lista zamiast napisu", () => {
    expect(onlyIssue({ options: [{ id: "a", text: "plays" }, { id: "b" }] })).toEqual({
      rule: "shape.options",
      field: "options[1].text",
      found: "expected a string, got nothing",
    });
    expect(onlyIssue({ noticeSegments: [["She", "plays"], ["He", null]] })).toEqual({
      rule: "shape.notice_segments",
      field: "noticeSegments[1][1]",
      found: "expected a string, got null",
    });
    expect(onlyIssue({ focus: "plays" })).toEqual({
      rule: "shape.focus",
      field: "focus",
      found: "expected a list of strings or null, got a string",
    });
  });

  it("fabryka wpisu tabeli zgłasza regułę z jego `rule`; opis shape.text_field wymienia każde pole tekstowe", () => {
    for (const entry of RAW_LIST_FIELDS) expect(entry.issue({ pl: "p", found: "f" }).rule).toBe(entry.rule);
    const description = CORE_RULES["shape.text_field"].description;
    for (const { field } of RAW_TEXT_FIELDS) expect(description).toContain(field);
  });

  describe.each(RAW_LIST_FIELDS)("pole listowe $field", (entry) => {
    it("element o złym typie i nie-lista dają jego regułę i pole", () => {
      const element = typeof entry.item === "string" ? 7 : "x";
      expect(onlyIssue({ [entry.field]: [element] })).toMatchObject({ rule: entry.rule, field: `${entry.field}[0]` });
      expect(onlyIssue({ [entry.field]: 7 })).toMatchObject({ rule: entry.rule, field: entry.field });
    });

    it("null, brak i pusta lista przechodzą", () => {
      expect(rawShapeIssues({ ...CHOICE, [entry.field]: null })).toEqual([]);
      expect(rawShapeIssues({ ...CHOICE, [entry.field]: [] })).toEqual([]);
    });
  });

  it("jedno zgłoszenie na pole (pierwszy zły element), wszystkie pola naraz", () => {
    const issues = rawShapeIssues({ ...CHOICE, options: [1, 2], sourceRefs: [null], stem: 5 });
    expect(issues.map((issue) => issue.rule)).toEqual(["shape.text_field", "shape.options", "shape.source_refs"]);
  });

  it("found jest przycięty: długi klucz obiektu nie rozpycha komunikatu", () => {
    const [issue] = rawShapeIssues({ ...CHOICE, answer: { ["x".repeat(500)]: 1 } });
    expect(issue!.found).toBe("expected a string, got an object");
  });
});

describe("foreignObjectiveIssues — ćwiczenie innego zagadnienia", () => {
  it("obce objectiveId: shape.objective_id z oczekiwanym i otrzymanym id", () => {
    const [issue] = foreignObjectiveIssues("other.topic.b", "subject.topic.a");
    expect(issue).toMatchObject({
      rule: "shape.objective_id",
      field: "objectiveId",
      found: 'objectiveId must be "subject.topic.a" (this objective), not "other.topic.b"',
    });
    expect(foreignObjectiveIssues("subject.topic.a", "subject.topic.a")).toEqual([]);
  });
});

describe("hasLenientRawShape — łagodny strażnik punktu kontrolnego (dzisiejsza semantyka)", () => {
  it("pola v3 spoza dzisiejszego schematu nie unieważniają rekordu", () => {
    for (const field of ["requiredElements", "supplementaryElements", "commonErrors", "sourceRefs"]) {
      expect(hasLenientRawShape({ ...CHOICE, [field]: [null] })).toBe(true);
    }
    expect(hasLenientRawShape({ ...CHOICE, familyId: 5, calculation: "x" })).toBe(true);
  });

  it("pola dzisiejszego schematu dalej go unieważniają", () => {
    expect(hasLenientRawShape(STRICT_NULLS)).toBe(true);
    expect(hasLenientRawShape(null)).toBe(false);
    expect(hasLenientRawShape({ ...CHOICE, answer: undefined })).toBe(false);
    for (const entry of RAW_LIST_FIELDS.filter((field) => field.guarded)) {
      expect(hasLenientRawShape({ ...CHOICE, [entry.field]: [null] })).toBe(false);
    }
    for (const entry of RAW_TEXT_FIELDS.filter((field) => field.guarded)) {
      expect(hasLenientRawShape({ ...CHOICE, [entry.field]: 5 })).toBe(false);
    }
  });
});

describe("rawShapeIssues — dowolny JSON (własność)", () => {
  it("nigdy nie rzuca, a zgłoszenie ma regułę shape.*, pole i found", () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const raw = randomJson(seed, { base: CHOICE });
      const issues = rawShapeIssues(raw);
      for (const issue of issues) {
        expect(issue.rule).toMatch(/^shape\./u);
        expect(issue.field.trim()).not.toBe("");
        expect((issue.found ?? "").trim()).not.toBe("");
      }
      expect(() => hasLenientRawShape(raw)).not.toThrow();
    }
  });
});
