import { describe, expect, it } from "vitest";
import { clip, defineRules, issueFrom } from "./catalog";
import { formatRuleReason, formatVictimReason, type RuleReason } from "./rule-reason";

const rules = defineRules({
  "fixture.reason": { field: "answer", kind: "reject", description: "Fixture rule." },
});
const issue = issueFrom(rules);

describe("formatRuleReason", () => {
  it("[id] pole: found, a bez found — [id] pole", () => {
    expect(formatRuleReason(issue("fixture.reason", { pl: "p", found: 'answer "x" is wrong' }))).toBe('[fixture.reason] answer: answer "x" is wrong');
    expect(formatRuleReason(issue("fixture.reason", { field: "sourceRefs[1].quote", pl: "p" }))).toBe("[fixture.reason] sourceRefs[1].quote");
  });

  it("found z nową linią, tabulatorem i cudzysłowem w środku daje jeden wiersz bez rozbicia formatu", () => {
    const found = `quote ${clip('line one\n\tline "two"')} does not occur`;
    const reason = formatRuleReason(issue("fixture.reason", { pl: "p\nq", found: `${found}\r\nand more` }));
    expect(reason).not.toMatch(/[\r\n\t]/u);
    expect(reason).toBe('[fixture.reason] answer: quote "line one line "two"" does not occur and more');
  });

  it("długi tekst w found zostaje wycięty przez clip (≤ 120 znaków treści z …)", () => {
    const reason = formatRuleReason(issue("fixture.reason", { pl: "p", found: `answer ${clip("a".repeat(500))}` }));
    expect(reason).toBe(`[fixture.reason] answer: answer "${"a".repeat(120)}…"`);
  });

  it("typ znakowany: zwykły napis nie jest powodem reguły", () => {
    // @ts-expect-error — RuleReason powstaje wyłącznie w formaterach.
    const reason: RuleReason = "[fixture.reason] answer";
    expect(reason).toBe("[fixture.reason] answer");
  });
});

describe("formatVictimReason", () => {
  it("prefiks ofiary przed powodem reguły", () => {
    expect(formatVictimReason("exercise ex3", issue("fixture.reason", { pl: "p", found: "x" }))).toBe(
      "adding this exercise would make the lesson reject exercise ex3: [fixture.reason] answer: x",
    );
  });
});
