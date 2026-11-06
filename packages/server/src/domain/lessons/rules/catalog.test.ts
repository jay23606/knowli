import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { PRODUCTION_SUBJECTS } from "../subjects";
import { ENGLISH_RULES } from "../subjects/english/rules";
import {
  clip,
  defineRules,
  describeRule,
  issueFrom,
  messagesOf,
  ruleOf,
  type LessonRule,
  type RuleCatalog,
  type RuleId,
  type RuleTextContext,
} from "./catalog";
import { CORE_RULES } from "./core-rules";
import { LESSON_RULES } from "./lesson-rules";

const catalog = defineRules({
  "x.y": { field: "answer", kind: "reject", description: "Answer must be short." },
  "x.limit": {
    field: "options",
    kind: "reject",
    description: (ctx) => `Answer is at most ${ctx.answerMaxLength} characters.`,
  },
});
const issue = issueFrom(catalog);

describe("defineRules", () => {
  it.each(["Bad-Id", "single", "a..b", "a.", ".a", "a.B"])("rzuca dla id „%s”", (id) => {
    expect(() => defineRules({ [id]: { field: "answer", kind: "reject", description: "d" } })).toThrow(id);
  });

  it("przyjmuje id `obszar.nazwa` z cyframi i podkreśleniem", () => {
    expect(() =>
      defineRules({ "cloze.gap_count": { field: "clozeText", kind: "reject", description: "d" }, "a1.b2.c_3": { field: "x", kind: "internal", description: "", internalReason: "r" } }),
    ).not.toThrow();
  });
});

describe("issueFrom", () => {
  it("bierze `field` z wpisu reguły, gdy zgłoszenie go nie podaje", () => {
    expect(issue("x.y", { pl: "p" })).toEqual({ rule: "x.y", field: "answer", pl: "p" });
  });

  it("przenosi `field` i `found` zgłoszenia", () => {
    expect(issue("x.y", { field: "sourceRefs[1].quote", pl: "p", found: '"q"' })).toEqual({
      rule: "x.y",
      field: "sourceRefs[1].quote",
      pl: "p",
      found: '"q"',
    });
  });

  it("typy: tylko klucze katalogu, a `RuleId` nie powstaje z napisu", () => {
    // @ts-expect-error — reguły spoza katalogu nie da się zgłosić.
    expect(() => issue("x.missing", { pl: "p" })).toThrow("x.missing");
    // @ts-expect-error — `RuleId` powstaje wyłącznie w fabryce zgłoszeń.
    const forged: RuleId = "x.y";
    expect(forged).toBe("x.y");
  });
});

describe("clip", () => {
  it("zamienia nowe linie i tabulatory na spację i zwija spacje", () => {
    expect(clip("a\nb")).toBe('"a b"');
    expect(clip("a\r\n\tb  c", 120, { quote: false })).toBe("a b c");
  });

  it("przycina do 120 znaków treści z wielokropkiem, w cudzysłowie", () => {
    const clipped = clip("x".repeat(200));
    expect(clipped).toHaveLength(123);
    expect(clipped).toBe(`"${"x".repeat(120)}…"`);
  });

  it("własny limit bez cudzysłowu", () => {
    expect(clip("x".repeat(60), 40, { quote: false })).toHaveLength(41);
    expect(clip("x".repeat(40), 40, { quote: false })).toBe("x".repeat(40));
  });
});

describe("messagesOf", () => {
  it("zwraca komunikaty `pl` w kolejności zgłoszeń", () => {
    expect(messagesOf([issue("x.y", { pl: "pierwszy" }), issue("x.limit", { pl: "drugi" })])).toEqual([
      "pierwszy",
      "drugi",
    ]);
    expect(messagesOf([])).toEqual([]);
  });

  it("pomija komunikat identyczny z wcześniejszym, zachowując kolejność", () => {
    expect(
      messagesOf([
        issue("x.y", { pl: "wspólny" }),
        issue("x.limit", { pl: "inny" }),
        issue("x.limit", { pl: "wspólny" }),
      ]),
    ).toEqual(["wspólny", "inny"]);
  });
});

describe("ruleOf", () => {
  it("znajduje regułę przedmiotu i dokleja id", () => {
    const id = issue("x.y", { pl: "p" }).rule;
    expect(ruleOf({ rules: catalog }, id)).toEqual({ ...catalog["x.y"], id: "x.y" });
  });

  it("nieznana reguła → undefined", () => {
    const id = issue("x.y", { pl: "p" }).rule;
    expect(ruleOf({ rules: {} }, id)).toBeUndefined();
    expect(ruleOf({ rules: catalog }, "toString" as string as RuleId)).toBeUndefined();
  });
});

describe("describeRule", () => {
  const rule: LessonRule = catalog["x.limit"];

  it("funkcja opisu korzysta z `answerMaxLength` kontekstu", () => {
    expect(describeRule(rule, { answerMaxLength: 120, groundingRequired: false })).toBe(
      "Answer is at most 120 characters.",
    );
    expect(describeRule(rule, { answerMaxLength: 300, groundingRequired: true })).toBe(
      "Answer is at most 300 characters.",
    );
  });

  it("dokleja dopisek przedmiotu po spacji", () => {
    expect(describeRule(catalog["x.y"], { answerMaxLength: 120, groundingRequired: false }, "Change the room.")).toBe(
      "Answer must be short. Change the room.",
    );
  });
});

describe("katalogi silnika bez importu wartości z catalog.ts", () => {
  // `catalog.ts` importuje katalogi silnika do `ENGINE_CATALOGS`; import wartości
  // w drugą stronę byłby cyklem modułów (strefa martwa `const` przy ładowaniu).
  const dir = dirname(fileURLToPath(import.meta.url));
  const VALUE_IMPORT_OF_CATALOG = /^import\s+(?!type\b)[^;]*from\s+["']\.\/catalog["']/m;

  it.each(["core-rules.ts", "lesson-rules.ts", "limits.ts"])("%s", (file) => {
    expect(VALUE_IMPORT_OF_CATALOG.test(readFileSync(join(dir, file), "utf8"))).toBe(false);
  });

  it("regex wykrywa import wartości (dowód czułości)", () => {
    expect(VALUE_IMPORT_OF_CATALOG.test('import { defineRules } from "./catalog";')).toBe(true);
    expect(VALUE_IMPORT_OF_CATALOG.test('import type { RuleCatalog } from "./catalog";')).toBe(false);
  });
});

/*
 * Gwarancje katalogów produkcyjnych (spec katalogu reguł §2.4 pkt 2): liczby w
 * opisach tylko ze stałych sprawdzenia, opisy rozróżnialne, `internal` tylko z
 * uzasadnionej listy, żaden katalog nie jest pusty.
 */
const rulesDir = dirname(fileURLToPath(import.meta.url));
const lessonsDir = join(rulesDir, "..");

/** Pliki z katalogami reguł: `rules/*.ts` i `subjects/<przedmiot>/rules.ts` (bez testów). */
function catalogSourceFiles(): string[] {
  const own = readdirSync(rulesDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => join(rulesDir, name));
  const subjects = readdirSync(join(lessonsDir, "subjects"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(lessonsDir, "subjects", entry.name, "rules.ts")))
    .map((entry) => join(lessonsDir, "subjects", entry.name, "rules.ts"));
  return [...own, ...subjects];
}

/** Tekst literałów napisów i szablonów w poddrzewie (bez podstawień `${…}`). */
function literalTexts(node: ts.Node): string[] {
  const texts: string[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
      texts.push(current.text);
    } else if (ts.isTemplateExpression(current)) {
      texts.push(current.head.text, ...current.templateSpans.map((span) => span.literal.text));
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return texts;
}

interface DescriptionLiteral {
  readonly where: string;
  readonly texts: readonly string[];
}

/** Klucz wpisu reguły w katalogu (`"obszar.nazwa": …`). */
const RULE_ENTRY_KEY = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

/**
 * Literały opisów w źródle: każda właściwość `description` (także w funkcjach
 * opisu i w pomocniku budującym wpis, np. `listShapeRule`) oraz argumenty wpisu
 * reguły zbudowanego wywołaniem pomocnika (`"shape.items": listShapeRule("items", …)`),
 * bo trafiają do opisu przez podstawienie. `entries` — liczba wpisów reguł w źródle.
 */
function descriptionLiterals(file: string, source: string): { literals: DescriptionLiteral[]; entries: number } {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const literals: DescriptionLiteral[] = [];
  let entries = 0;
  const at = (node: ts.Node): string => `${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "description") {
      literals.push({ where: at(node), texts: literalTexts(node.initializer) });
    } else if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && RULE_ENTRY_KEY.test(node.name.text)) {
      entries += 1;
      if (ts.isCallExpression(node.initializer)) literals.push({ where: at(node), texts: literalTexts(node.initializer) });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return { literals, entries };
}

/**
 * Fragmenty z cyframi dopuszczone w opisach (nazwy, nie liczby limitów), np.
 * kod locale. Każdy wpis musi coś wyłączać; dziś żaden opis nie potrzebuje cyfry.
 */
const DIGIT_EXCEPTIONS: readonly string[] = [];

/** Fragmenty literałów opisów z cyfrą (po usunięciu wyjątków). */
function digitProblems(literals: readonly DescriptionLiteral[], exceptions: readonly string[]): string[] {
  return literals.flatMap(({ where, texts }) =>
    texts
      .filter((text) => /\d/.test(exceptions.reduce((rest, allowed) => rest.split(allowed).join(""), text)))
      .map((text) => `${where}: ${text}`),
  );
}

describe("opisy reguł bez literałów liczb", () => {
  const scanned = catalogSourceFiles().map((file) =>
    descriptionLiterals(relative(lessonsDir, file).split(sep).join("/"), readFileSync(file, "utf8")),
  );
  const literals = scanned.flatMap((result) => result.literals);

  it("skan widzi opisy reguł rdzenia, lekcji i przedmiotów", () => {
    const files = new Set(literals.map(({ where }) => where.replace(/:\d+$/, "")));
    expect([...files].sort()).toEqual([
      "rules/core-rules.ts",
      "rules/lesson-rules.ts",
      "subjects/english-chapter/rules.ts",
      "subjects/english-grammar/rules.ts",
      "subjects/english/rules.ts",
      "subjects/school/rules.ts",
    ]);
    // Skan widzi wpis każdej reguły produkcyjnej (wspólny fragment angielski raz, w swoim pliku).
    expect(scanned.reduce((sum, result) => sum + result.entries, 0)).toBe(productionRulesById().size);
  });

  it("literały opisów (także w funkcjach opisu) nie zawierają cyfr; liczby tylko przez `${STAŁA}`", () => {
    expect(digitProblems(literals, DIGIT_EXCEPTIONS)).toEqual([]);
  });

  it("każdy wyjątek cyfr coś wyłącza", () => {
    const all = literals.flatMap(({ texts }) => texts);
    expect(DIGIT_EXCEPTIONS.filter((allowed) => !all.some((text) => text.includes(allowed)))).toEqual([]);
  });

  it("wykrywa cyfrę w napisie, szablonie, funkcji opisu i argumencie pomocnika, a pomija podstawienie i wyjątek (dowód czułości)", () => {
    const source = [
      'const a = { description: "At most 3 words." };',
      "const b = { description: `At most ${MAX} words.` };",
      'const c = { description: (ctx) => (ctx.flag ? `Up to 40 characters.` : "Short.") };',
      'const d = { description: "Answer " + "in 2 words." };',
      'const e = { description: "Scale 1:5." };',
      'const f = { "shape.x": listRule("x", "lists of 2 strings") };',
    ].join("\n");
    expect(digitProblems(descriptionLiterals("f.ts", source).literals, ["1:5"])).toEqual([
      "f.ts:1: At most 3 words.",
      "f.ts:3: Up to 40 characters.",
      "f.ts:4: in 2 words.",
      "f.ts:6: lists of 2 strings",
    ]);
  });
});

/** Katalogi produkcyjne z nazwą: rdzeń, lekcja, wspólny fragment angielski i przedmioty. */
const PRODUCTION_CATALOGS: readonly { readonly name: string; readonly catalog: RuleCatalog }[] = [
  { name: "core", catalog: CORE_RULES },
  { name: "lesson", catalog: LESSON_RULES },
  { name: "english", catalog: ENGLISH_RULES },
  ...PRODUCTION_SUBJECTS.map((subject) => ({ name: subject.id, catalog: subject.rules })),
];

/** Reguły po id; wspólny wpis kilku katalogów (fragment angielski) liczy się raz. */
function productionRulesById(): Map<string, LessonRule> {
  const rules = new Map<string, LessonRule>();
  for (const { catalog } of PRODUCTION_CATALOGS) {
    for (const [id, rule] of Object.entries(catalog)) rules.set(id, rule);
  }
  return rules;
}

/** Konteksty opisów zależnych od przedmiotu. */
const TEXT_CONTEXTS: readonly RuleTextContext[] = [
  { answerMaxLength: 120, groundingRequired: false },
  { answerMaxLength: 600, groundingRequired: true },
];

/** Pary reguł z równym opisem albo opisem zawartym w drugim (w tym samym kontekście). */
function overlappingDescriptions(rules: ReadonlyMap<string, LessonRule>): string[] {
  const problems = new Set<string>();
  for (const ctx of TEXT_CONTEXTS) {
    const described = [...rules]
      .map(([id, rule]) => ({ id, text: describeRule(rule, ctx).trim() }))
      .filter(({ text }) => text !== "");
    for (const a of described) {
      for (const b of described) {
        if (a.id !== b.id && a.text.includes(b.text)) {
          problems.add(a.text === b.text ? `${a.id} = ${b.id}` : `${a.id} zawiera ${b.id}`);
        }
      }
    }
  }
  return [...problems];
}

/**
 * Reguły `internal` (nieosiągalne dla agenta, poza promptem) z uzasadnieniem.
 * Nowa reguła `internal` wymaga wpisu tutaj: inaczej opis reguły, którą agent
 * może złamać, po cichu wypadłby z promptu.
 */
const INTERNAL_RULES: Readonly<Record<string, string>> = {
  "computed.no_variants":
    "materializacja par, grup i luk z bankiem słów sama ustawia puste acceptedAnswers i focus; agent ich nie wysyła",
  "keywords.distractor_required":
    "nieosiągalna za kontraktem: keywordOptions ma więcej wpisów, niż może wskazać keyOptionIds, więc dystraktor zawsze zostaje",
  "keywords.answer_computed": "odpowiedź lesson_keywords wylicza kod z keyOptionIds; agent jej nie wysyła",
  "match.answer_computed": "odpowiedź lesson_match wylicza kod z pairs; agent jej nie wysyła",
  "group.answer_computed": "odpowiedź lesson_group wylicza kod z groups; agent jej nie wysyła",
  "cloze.answer_computed": "odpowiedź lesson_cloze wylicza kod z gapAnswers; agent jej nie wysyła",
  "lesson.refine_unnamed": "bezpiecznik kontraktu haka refineGeneratedPool: przedmioty produkcyjne zawsze nazywają regułę",
};

describe("gwarancje katalogów produkcyjnych", () => {
  const rules = productionRulesById();

  it.each(PRODUCTION_CATALOGS.map(({ name, catalog }) => [name, catalog] as const))(
    "katalog %s ma co najmniej jedną regułę",
    (_name, catalog) => {
      expect(Object.keys(catalog).length).toBeGreaterThan(0);
    },
  );

  it("opisy różnych reguł nie są równe ani nie zawierają jeden drugiego", () => {
    expect(overlappingDescriptions(rules)).toEqual([]);
  });

  it("wykrywa równe i zawarte opisy (dowód czułości)", () => {
    const fixture = new Map<string, LessonRule>([
      ["a.one", { field: "x", kind: "reject", description: "Answer is short." }],
      ["a.two", { field: "x", kind: "reject", description: "Answer is short." }],
      ["a.three", { field: "x", kind: "reject", description: (ctx) => `Answer is short. At most ${ctx.answerMaxLength}.` }],
      ["a.four", { field: "x", kind: "reject", description: "Other." }],
    ]);
    expect(overlappingDescriptions(fixture).sort()).toEqual(
      ["a.one = a.two", "a.two = a.one", "a.three zawiera a.one", "a.three zawiera a.two"].sort(),
    );
  });

  it("`internal` mają wyłącznie reguły z uzasadnionej listy", () => {
    const internal = [...rules].filter(([, rule]) => rule.kind === "internal").map(([id]) => id);
    expect(internal.sort()).toEqual(Object.keys(INTERNAL_RULES).sort());
  });
});
