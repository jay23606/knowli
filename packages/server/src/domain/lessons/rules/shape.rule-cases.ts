import { materializeRawExercise } from "../raw-materialize";
import { foreignObjectiveIssues, RAW_LIST_FIELDS, rawShapeIssues } from "../raw-shape";
import { registerRuleCases, type RuleCase } from "../testing/rule-cases";

/**
 * Przypadki reguł kształtu rekordu agenta (`shape.*` w `core-rules.ts`) dla testu
 * kompletności `rule-cases.test.ts`: prawdziwe `rawShapeIssues`,
 * `foreignObjectiveIssues` i `materializeRawExercise` na rekordach łamiących regułę.
 */

const RECORD = {
  exerciseType: "lesson_gap",
  objectiveId: "shape_cases.topic.any",
  stem: "She ___ tennis.",
  answer: "plays",
  acceptedAnswers: [],
  focus: ["plays"],
};

const shape = (overrides: Record<string, unknown>) => () => rawShapeIssues({ ...RECORD, ...overrides });

/** Zgłoszenia materializacji (pusta lista, gdy rekord się zmaterializował). */
const materialized = (raw: unknown) => () => {
  const result = materializeRawExercise(raw);
  return result.ok ? [] : result.issues;
};

const cases: RuleCase[] = [
  { rule: "shape.record", violation: () => rawShapeIssues(null) },
  { rule: "shape.record", violation: shape({ exerciseType: 5 }) },
  { rule: "shape.record", violation: materialized("x") },
  { rule: "shape.objective_id", violation: () => foreignObjectiveIssues("other.topic.b", RECORD.objectiveId) },
  { rule: "shape.answer", violation: shape({ answer: null }) },
  { rule: "shape.text_field", violation: shape({ stem: 5 }) },
  { rule: "shape.text_field", violation: materialized({ exerciseType: "lesson_cloze", objectiveId: "o", clozeText: 5 }) },
  { rule: "shape.calculation", violation: shape({ calculation: "x" }) },
  // Każde pole listowe: element o złym typie.
  ...RAW_LIST_FIELDS.map((entry) => ({
    rule: entry.rule,
    violation: shape({ [entry.field]: [typeof entry.item === "string" ? 7 : "x"] }),
  })),
  { rule: "shape.pairs", violation: materialized({ exerciseType: "lesson_match", objectiveId: "o", pairs: [["a", "b"]] }) },
];

registerRuleCases(cases);
