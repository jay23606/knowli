import { describe, expect, it } from "vitest";
import { PRODUCTION_SUBJECTS } from "../subjects";
import "../subjects/english/english.rule-cases";
import "../subjects/english-chapter/chapter.rule-cases";
import "../subjects/english-grammar/grammar.rule-cases";
import "../subjects/school/school.rule-cases";
import { allRuleCases, type RuleCase } from "../testing/rule-cases";
import "./core.rule-cases";
import "./lesson.rule-cases";
import "./shape.rule-cases";
import { defineRules, ENGINE_CATALOGS, issueFrom, type LessonRuleIssue, type RuleCatalog } from "./catalog";

/**
 * Kompletność katalogów reguł (spec katalogu reguł §2.4 pkt 2–3): każda reguła
 * `reject`/`sanitize` ma opis i przypadek naruszenia, przy którym prawdziwy
 * walidator zgłasza dokładnie jej id; reguła z limitem ma też przypadek
 * graniczny, który przechodzi. Pliki `*.rule-cases.ts` rejestrują przypadki
 * przy imporcie — każdy nowy plik dopisz do importów poniżej.
 */

interface NamedCatalog {
  readonly name: string;
  readonly catalog: RuleCatalog;
}

/** Katalogi silnika i przedmiotów produkcyjnych. */
function productionCatalogs(): NamedCatalog[] {
  return [
    ...ENGINE_CATALOGS.map((catalog, index) => ({ name: `engine[${index}]`, catalog })),
    ...PRODUCTION_SUBJECTS.map((subject) => ({ name: subject.id, catalog: subject.rules })),
  ];
}

/** Problemy kompletności katalogów względem przypadków; pusta lista = komplet. */
function ruleCaseProblems(catalogs: readonly NamedCatalog[], cases: readonly RuleCase[]): string[] {
  const problems: string[] = [];
  const known = new Set<string>();
  for (const { name, catalog } of catalogs) {
    for (const [id, rule] of Object.entries(catalog)) {
      known.add(id);
      const where = `${name}: ${id}`;
      if (rule.kind === "internal") {
        if (!rule.internalReason?.trim()) {
          problems.push(`${where}: reguła internal bez internalReason`);
        }
        continue;
      }
      const description = typeof rule.description === "string"
        ? rule.description
        : rule.description({ answerMaxLength: 120, groundingRequired: true });
      if (!description.trim()) {
        problems.push(`${where}: pusty description`);
      }
      const ruleCases = cases.filter((ruleCase) => ruleCase.rule === id);
      if (ruleCases.length === 0) {
        problems.push(`${where}: brak przypadku naruszenia`);
        continue;
      }
      for (const ruleCase of ruleCases) {
        const issues = ruleCase.violation().filter((issue) => issue.rule === id);
        const complete = issues.some(
          (issue) => issue.field.trim() !== "" && (rule.fixedMessage === true || (issue.found ?? "").trim() !== ""),
        );
        if (!complete) {
          problems.push(
            `${where}: violation() nie zgłasza reguły z niepustym field${rule.fixedMessage === true ? "" : " i found"}`,
          );
        }
        if (rule.limit !== undefined) {
          if (ruleCase.boundary === undefined) {
            problems.push(`${where}: reguła z limitem ${rule.limit} bez przypadku granicznego`);
          } else if (ruleCase.boundary().some((issue) => issue.rule === id)) {
            problems.push(`${where}: boundary() zgłasza regułę`);
          }
        }
      }
    }
  }
  for (const ruleCase of cases) {
    if (!known.has(ruleCase.rule)) {
      problems.push(`${ruleCase.rule}: przypadek reguły spoza katalogów`);
    }
  }
  return problems;
}

/** Id występujące w kilku katalogach z różnymi obiektami wpisu (wspólny obiekt jest dozwolony). */
function idCollisions(catalogs: readonly NamedCatalog[]): string[] {
  const seen = new Map<string, { readonly name: string; readonly rule: unknown }>();
  const collisions: string[] = [];
  for (const { name, catalog } of catalogs) {
    for (const [id, rule] of Object.entries(catalog)) {
      const first = seen.get(id);
      if (first === undefined) {
        seen.set(id, { name, rule });
      } else if (first.rule !== rule) {
        collisions.push(`${id}: ${first.name} i ${name}`);
      }
    }
  }
  return collisions;
}

describe("kompletność katalogów reguł", () => {
  it("każda reguła produkcyjna ma przypadki i opis", () => {
    expect(ruleCaseProblems(productionCatalogs(), allRuleCases())).toEqual([]);
  });

  it("id reguł są unikalne we wszystkich katalogach razem", () => {
    expect(idCollisions(productionCatalogs())).toEqual([]);
  });
});

/**
 * Dowód czułości sprawdzenia na fikcyjnym katalogu z prostym walidatorem
 * (bez wpływu na kod produkcyjny).
 */
describe("ruleCaseProblems — fikstura", () => {
  const MAX_WORDS = 3;
  const fixture = defineRules({
    "fixture.too_long": {
      field: "answer",
      kind: "reject",
      description: `Answer has at most ${MAX_WORDS} words.`,
      limit: "MAX_WORDS",
    },
    "fixture.card": { field: "exerciseType", kind: "reject", description: "No cards.", fixedMessage: true },
    "fixture.computed": { field: "audio", kind: "internal", description: "", internalReason: "Code sets it." },
  });
  const issue = issueFrom(fixture);

  /** Walidator fikstury: liczba słów odpowiedzi i zakaz kart. */
  function validate(answer: string, card = false): LessonRuleIssue[] {
    const issues: LessonRuleIssue[] = [];
    const words = answer.split(" ").length;
    if (words > MAX_WORDS) {
      issues.push(issue("fixture.too_long", { pl: "za długa odpowiedź", found: `${words} words` }));
    }
    if (card) {
      issues.push(issue("fixture.card", { pl: "karta" }));
    }
    return issues;
  }

  const catalogs = [{ name: "fixture", catalog: fixture }];
  const goodCases: RuleCase[] = [
    { rule: "fixture.too_long", violation: () => validate("a b c d"), boundary: () => validate("a b c") },
    { rule: "fixture.card", violation: () => validate("a", true) },
  ];

  it("komplet przypadków przechodzi", () => {
    expect(ruleCaseProblems(catalogs, goodCases)).toEqual([]);
  });

  it("pada, gdy reguła nie ma przypadku", () => {
    expect(ruleCaseProblems(catalogs, goodCases.slice(0, 1))).toEqual(["fixture: fixture.card: brak przypadku naruszenia"]);
  });

  it("pada, gdy violation() nie zgłasza reguły albo nie podaje found", () => {
    const silent: RuleCase[] = [{ ...goodCases[0]!, violation: () => validate("a") }, goodCases[1]!];
    expect(ruleCaseProblems(catalogs, silent)).toEqual([
      "fixture: fixture.too_long: violation() nie zgłasza reguły z niepustym field i found",
    ]);
    const withoutFound: RuleCase[] = [
      { ...goodCases[0]!, violation: () => [issue("fixture.too_long", { pl: "p" })] },
      goodCases[1]!,
    ];
    expect(ruleCaseProblems(catalogs, withoutFound)).toHaveLength(1);
    const emptyField: RuleCase[] = [
      { ...goodCases[0]!, violation: () => [issue("fixture.too_long", { field: " ", pl: "p", found: "4 words" })] },
      goodCases[1]!,
    ];
    expect(ruleCaseProblems(catalogs, emptyField)).toHaveLength(1);
  });

  it("pada, gdy reguła z limitem nie ma boundary albo boundary() ją zgłasza", () => {
    const { boundary: _omitted, ...withoutBoundary } = goodCases[0]!;
    expect(ruleCaseProblems(catalogs, [withoutBoundary, goodCases[1]!])).toEqual([
      "fixture: fixture.too_long: reguła z limitem MAX_WORDS bez przypadku granicznego",
    ]);
    const failingBoundary: RuleCase[] = [{ ...goodCases[0]!, boundary: () => validate("a b c d") }, goodCases[1]!];
    expect(ruleCaseProblems(catalogs, failingBoundary)).toEqual(["fixture: fixture.too_long: boundary() zgłasza regułę"]);
  });

  it("pada przy regule internal bez internalReason i pustym description", () => {
    const broken = defineRules({
      "fixture.internal": { field: "audio", kind: "internal", description: "" },
      "fixture.blank": { field: "answer", kind: "sanitize", description: () => "  " },
    });
    const blankCase: RuleCase = {
      rule: "fixture.blank",
      violation: () => [issueFrom(broken)("fixture.blank", { pl: "p", found: "x" })],
    };
    expect(ruleCaseProblems([{ name: "broken", catalog: broken }], [blankCase])).toEqual([
      "broken: fixture.internal: reguła internal bez internalReason",
      "broken: fixture.blank: pusty description",
    ]);
  });

  it("pada przy przypadku reguły spoza katalogów", () => {
    expect(ruleCaseProblems(catalogs, [...goodCases, { rule: "fixture.gone", violation: () => [] }])).toEqual([
      "fixture.gone: przypadek reguły spoza katalogów",
    ]);
  });

  it("unikalność id: wspólny obiekt wpisu dozwolony, inny obiekt to kolizja", () => {
    const shared = { "fixture.shared": fixture["fixture.too_long"] };
    expect(idCollisions([{ name: "a", catalog: shared }, { name: "b", catalog: { ...shared } }])).toEqual([]);
    expect(
      idCollisions([{ name: "a", catalog: shared }, { name: "b", catalog: { "fixture.shared": { ...fixture["fixture.too_long"] } } }]),
    ).toEqual(["fixture.shared: a i b"]);
  });
});
