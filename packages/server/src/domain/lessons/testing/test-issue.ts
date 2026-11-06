import { defineRules, issueFrom, type LessonRuleIssue } from "../rules/catalog";

/**
 * Zgłoszenie reguły dla testów haków przedmiotów, które zwracają tylko tekst
 * (bramki, `validatePoolExtra`, `refineGeneratedPool` podstawione w testach):
 * jedna reguła pomocnicza, `pl` i `found` podane wprost.
 */
const TEST_RULES = defineRules({
  "test.issue": {
    field: "exercise",
    kind: "reject",
    description: "Rule used only by tests of subject hooks.",
  },
});

const issueOfTestRule = issueFrom(TEST_RULES);

export function testIssue(pl: string, found?: string): LessonRuleIssue {
  return issueOfTestRule("test.issue", { pl, ...(found === undefined ? {} : { found }) });
}
