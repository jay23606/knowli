import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Test architektury katalogu reguł (spec katalogu reguł §2.4 pkt 4): walidatory
 * i przyjmowanie agenta zgłaszają złamane reguły wyłącznie przez fabryki zgłoszeń
 * katalogu (`issueFrom`), więc żaden tekst dla modelu albo rodzica nie omija
 * katalogu. W skanowanych plikach (`SCANNED` niżej):
 * - tablica zgłoszeń — nazwa `errors|issues|reasons|findings`, także z
 *   przedrostkiem (`recordIssues`) — przez `push`/`unshift`/`concat`, literał
 *   tablicy w deklaracji, przypisaniu albo właściwości nie dostaje napisu (literał,
 *   szablon, konkatenacja `+` z napisem, `String(…)`, `join`/`toString`…, zmienna
 *   lokalna z takim inicjalizatorem) ani spreadu wywołania, które nie zwraca zgłoszeń;
 * - funkcja zgłoszeń (jawny typ wyniku ze zgłoszeniami, nazwa tablicy zgłoszeń
 *   albo hak `SubjectAgentPolicy` z wynikiem `string[]`) nie zwraca tak
 *   zbudowanej tablicy;
 * - właściwość `reason:` nie jest literałem napisu ani szablonem.
 * We wszystkich źródłach silnika lekcji i narzędzi agenta wywołanie fabryki
 * zgłoszeń ma pierwszy argument będący literałem napisu (id reguły).
 *
 * Wywołanie „zwraca zgłoszenia”, gdy jego nazwa (identyfikator albo ostatnia
 * właściwość, np. `subject.validateExercise`) jest fabryką zgłoszeń albo funkcją,
 * metodą lub polem z jawnym typem wyniku `LessonRuleIssue`/`RuleReason`/
 * `AgentGateFinding` zadeklarowanym w tych źródłach. Rozpoznanie po nazwie, bez
 * sprawdzania typów: kształt zgłoszeń pilnują typy, ten test — że napis nie
 * omija fabryki. `throw` nie jest ujściem zgłoszeń (np. `computeCalculationAnswer`
 * dalej rzuca, a agent dostaje `calculationIssues`), więc nie ma dla niego wyjątku.
 *
 * Znane granice (analiza składni, bez przepływu danych): napis przekazany przez
 * ogólny pomocnik (`const fail = (m) => issues.push(m); fail("x")`), stała
 * poziomu modułu (`const MSG = "x"`, celowo: kody jak `checker_timeout`), funkcja
 * zwracająca tablicę napisów bez jawnego typu i bez nazwy ujścia oraz alias
 * fabryki nie są wykrywane.
 *
 * TypeScript 5.9 (`import ts from "typescript"`): natywny TS 7 nie ma API kompilatora.
 */

const lessonsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverSrc = join(lessonsDir, "..", "..");
const TOOLS_FILE = "modules/materials/lessons/lesson-pool-agent-tools.ts";

function posix(path: string): string {
  return path.split(sep).join("/");
}

/** Źródła (bez testów) pod katalogiem, ścieżki względem `packages/server/src`. */
function sourceFilesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFilesUnder(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(posix(relative(serverSrc, path)));
  }
  return files;
}

/** Pliki przedmiotów z hakami walidacji i przyjmowania. */
const SUBJECT_HOOK_FILE = /^domain\/lessons\/subjects\/.+\/(?:validators|agent-policy|hint-gate|quote-normalize|listen-audibility)\.ts$/;

/** Pliki walidatorów i przyjmowania agenta objęte zakazem napisów w zgłoszeniach. */
const SCANNED: readonly string[] = [
  "domain/lessons/pool-validation.ts",
  "domain/lessons/calculation.ts",
  "domain/lessons/raw-shape.ts",
  "domain/lessons/raw-materialize.ts",
  ...sourceFilesUnder(join(lessonsDir, "subjects")).filter((file) => SUBJECT_HOOK_FILE.test(file)),
  "domain/lessons/agent/admission.ts",
  "domain/lessons/agent/solver.ts",
  "domain/lessons/agent/status.ts",
  TOOLS_FILE,
];

/** Źródła słownika fabryk i źródeł zgłoszeń oraz sprawdzenia literału id. */
const VOCABULARY_FILES: readonly string[] = [...sourceFilesUnder(lessonsDir), TOOLS_FILE];

/** Wyjątek: konkretne wyrażenie (źródło ze zwiniętymi białymi znakami) w danej funkcji. */
interface SinkException {
  readonly fn: string;
  readonly expression: string;
  readonly reason: string;
}

const EXAMPLES_REASON =
  "przykłady kart nie są ćwiczeniami: odpowiedź narzędzia o liniach przykładów, poza katalogiem reguł ćwiczeń";
const examplesText = (expression: string): SinkException => ({ fn: "submitExamples", expression, reason: EXAMPLES_REASON });

/**
 * Nazwane wyjątki (plik → wyrażenia z uzasadnieniem): tekst poza katalogiem reguł,
 * bo nie jest odrzuceniem ćwiczenia. Wyjątek obejmuje tylko to jedno wyrażenie,
 * więc nowy napis w tej samej funkcji pada. Nie kopiuj ich jako wzorca. Każdy wpis
 * musi coś wyłączać (test pilnuje, że lista nie zostaje nieaktualna).
 */
const EXCEPTIONS: Readonly<Record<string, readonly SinkException[]>> = {
  "domain/lessons/agent/admission.ts": [
    examplesText('"examples must be an array of strings"'),
    examplesText("`${label}: must be a string`"),
    examplesText("`${label}: is empty`"),
    examplesText("`${label}: is longer than ${MAX_TEXT_LENGTH} characters`"),
    examplesText("`${label}: duplicates an earlier example; this line was ignored`"),
    // Linia przykładu ujawnia rozwiązanie: powód z fabryki (`formatRuleReason`) z etykietą i cytatem linii.
    examplesText("...victims.map((victim) => `${label} ${quoted(text)}: ${formatRuleReason(leakSourceIssue(victim, ctx))}`)"),
    examplesText("`${label}: an objective has at most ${MAX_CARD_EXAMPLES} card examples; this line was ignored`"),
  ],
  "domain/lessons/subjects/english-chapter/agent-policy.ts": [
    {
      fn: "objectiveGaps",
      expression: '`card words not used in any exercise yet: ${uncovered.join(", ")}`',
      reason: "luka zagadnienia dla statusu narzędzia (`missing`), nie odrzucenie ćwiczenia; hak ma typ `string[]`",
    },
    {
      fn: "planGate",
      expression: '`material words on no card: ${uncoveredWords.join(", ")}`',
      reason: "bramka planu dla planisty (słowa materiału bez karty), nie odrzucenie ćwiczenia; hak ma typ `string[]`",
    },
    {
      fn: "planGate",
      expression: '`material frames on no card: ${uncoveredFrames.join(" | ")}`',
      reason: "bramka planu dla planisty (ramy materiału bez karty), nie odrzucenie ćwiczenia; hak ma typ `string[]`",
    },
  ],
  [TOOLS_FILE]: [
    {
      fn: "cappedReasons",
      expression: "`+${reasons.length - MAX_REASONS} more`",
      reason: "znacznik pominiętych powodów w wyniku narzędzia, nie powód odrzucenia",
    },
    {
      fn: "submit",
      expression: '"exercises must be an array"',
      reason: "odmowa całego wywołania narzędzia przed walidacją ćwiczeń",
    },
    {
      fn: "submit",
      expression: '"examples were not processed because exercises must be an array"',
      reason: "odmowa całego wywołania narzędzia: przykłady nieprzetworzone razem z odrzuconym wywołaniem",
    },
    {
      fn: "submit",
      expression: '"examples are fixed by the plan"',
      reason: "przykłady kart ustalone planem: odpowiedź o przykładach, nie odrzucenie ćwiczenia",
    },
    {
      fn: "remove",
      expression: "`there is no exercise \"${text}\" in this objective's pool`",
      reason: "odmowa narzędzia usuwania: w puli zagadnienia nie ma ćwiczenia o tym id",
    },
  ],
};

/** Typ wyniku, który oznacza zgłoszenia katalogu. */
const ISSUE_RESULT_TYPE = /\b(?:LessonRuleIssue|RuleReason|AgentGateFinding)\b/;
/** Nazwa tablicy zgłoszeń (także z przedrostkiem: `recordIssues`, `victimIssues`). */
const SINK_NAME = /(?:^|[a-z])(?:errors|issues|reasons|findings|Errors|Issues|Reasons|Findings)$/;
/** Nazwy pasujące do `SINK_NAME`, które nie są zgłoszeniami. */
const NOT_SINKS: ReadonlySet<string> = new Set([
  // Pole ćwiczenia szkoły: typowe błędy ucznia (treść), nie zgłoszenia.
  "commonErrors",
]);

function isSinkName(name: string | undefined): boolean {
  return name !== undefined && SINK_NAME.test(name) && !NOT_SINKS.has(name);
}

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

interface IssueVocabulary {
  /** Nazwy fabryk zgłoszeń (`const x = issueFrom(...)`). */
  readonly factories: ReadonlySet<string>;
  /** Nazwy funkcji, metod i pól z jawnym typem wyniku zgłoszeń. */
  readonly issueSources: ReadonlySet<string>;
  /** Haki `SubjectAgentPolicy` z wynikiem `string[]` (tekst dla modelu bez katalogu). */
  readonly textHooks: ReadonlySet<string>;
}

/** Fabryki, źródła zgłoszeń i haki tekstowe zadeklarowane w podanych źródłach. */
function issueVocabulary(sources: readonly ts.SourceFile[]): IssueVocabulary {
  const factories = new Set<string>();
  const issueSources = new Set<string>();
  const textHooks = new Set<string>();
  for (const ast of sources) {
    const returnsIssues = (type: ts.TypeNode | undefined): boolean =>
      type !== undefined && ISSUE_RESULT_TYPE.test(type.getText(ast));
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
        const init = node.initializer;
        if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "issueFrom") {
          factories.add(node.name.text);
        } else if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && returnsIssues(init.type)) {
          issueSources.add(node.name.text);
        }
      } else if (
        (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node))
        && node.name !== undefined
      ) {
        const name = propertyName(node.name);
        if (name !== undefined && returnsIssues(node.type)) issueSources.add(name);
        if (
          name !== undefined
          && ts.isMethodSignature(node)
          && ts.isInterfaceDeclaration(node.parent)
          && node.parent.name.text === "SubjectAgentPolicy"
          && node.type !== undefined
          && /^(?:readonly )?string\[\]$/.test(node.type.getText(ast))
        ) {
          textHooks.add(name);
        }
      } else if (
        ts.isPropertySignature(node)
        && node.type !== undefined
        && ts.isFunctionTypeNode(node.type)
        && returnsIssues(node.type.type)
      ) {
        const name = propertyName(node.name);
        if (name !== undefined) issueSources.add(name);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return { factories, issueSources, textHooks };
}

interface Violation {
  readonly file: string;
  /** Najbliższa nazwana funkcja (`<module>` poza funkcją). */
  readonly fn: string;
  readonly line: number;
  /** Zgłaszane wyrażenie (źródło ze zwiniętymi białymi znakami) — klucz wyjątku. */
  readonly expression: string;
  readonly text: string;
}

/** Źródło węzła ze zwiniętymi białymi znakami. */
function flatText(node: ts.Node, ast: ts.SourceFile): string {
  return node.getText(ast).replace(/\s+/g, " ");
}

/** Nazwa wywoływanej funkcji albo ujścia: identyfikator albo ostatnia właściwość. */
function terminalName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

/** Nazwa funkcji: deklaracja, metoda albo funkcja strzałkowa w zmiennej lub właściwości; anonimowa → `undefined`. */
function functionName(fn: ts.SignatureDeclaration): string | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name !== undefined) return propertyName(fn.name);
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    const parent = fn.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isPropertyAssignment(parent)) return propertyName(parent.name);
  }
  return undefined;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression {
  return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/** Najbliższa nazwana funkcja węzła; anonimowe wywołania zwrotne przechodzą do funkcji wyżej. */
function enclosingFunction(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (isFunctionLike(current)) {
      const name = functionName(current);
      if (name !== undefined) return name;
    }
  }
  return "<module>";
}

/** Najbliższa funkcja węzła (także anonimowa). */
function directFunction(node: ts.Node): ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (isFunctionLike(current)) return current;
  }
  return undefined;
}

function unwrap(value: ts.Expression): ts.Expression {
  let inner = value;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner)) {
    inner = inner.expression;
  }
  return inner;
}

/**
 * Wywołania fabryki bez literału id (we wszystkich podanych źródłach):
 * `issue(idVar, …)` składa id dynamicznie, z pominięciem literału katalogu.
 */
function factoryIdViolations(file: string, source: string, vocabulary: IssueVocabulary): Violation[] {
  const ast = parse(file, source);
  const violations: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && vocabulary.factories.has(node.expression.text)) {
      const first = node.arguments[0];
      if (first === undefined || !ts.isStringLiteral(first)) {
        violations.push({
          file,
          fn: enclosingFunction(node),
          line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
          expression: flatText(node, ast),
          text: `fabryka bez literału id: ${flatText(node, ast).slice(0, 100)}`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return violations;
}

/** Metody dokładające elementy do tablicy zgłoszeń. */
const SINK_MUTATORS: ReadonlySet<string> = new Set(["push", "unshift", "concat"]);
/** Metody, których wynik jest zawsze napisem. */
const TEXT_METHODS: ReadonlySet<string> = new Set(["join", "toString", "toUpperCase", "toLowerCase", "trim"]);

/**
 * Inicjalizator zmiennej lokalnej o nazwie identyfikatora: szukany w funkcjach
 * otaczających węzeł (od najbliższej), bez poziomu modułu — stałe modułu (np.
 * kody `checker_timeout`) nie są tekstem zgłoszenia.
 */
function localInitializer(id: ts.Identifier): ts.Expression | undefined {
  for (let current: ts.Node | undefined = id.parent; current !== undefined; current = current.parent) {
    if (!isFunctionLike(current)) continue;
    let found: ts.Expression | undefined;
    const search = (node: ts.Node): void => {
      if (found !== undefined) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === id.text && node.initializer !== undefined) {
        found = node.initializer;
        return;
      }
      ts.forEachChild(node, search);
    };
    if (current.body !== undefined) search(current.body);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Wyrażenie, które jest napisem: literał, szablon, konkatenacja `+` z napisem po
 * którejś stronie, `String(…)`, metoda dająca napis (`join`, `toString`…) albo
 * zmienna lokalna z takim inicjalizatorem.
 */
function isTextExpression(value: ts.Expression, seen: Set<ts.Node>): boolean {
  const inner = unwrap(value);
  if (seen.has(inner)) return false;
  seen.add(inner);
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) || ts.isTemplateExpression(inner)) return true;
  if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return isTextExpression(inner.left, seen) || isTextExpression(inner.right, seen);
  }
  if (ts.isCallExpression(inner)) {
    if (ts.isIdentifier(inner.expression) && inner.expression.text === "String") return true;
    if (ts.isPropertyAccessExpression(inner.expression) && TEXT_METHODS.has(inner.expression.name.text)) return true;
  }
  if (ts.isIdentifier(inner)) {
    const initializer = localInitializer(inner);
    return initializer !== undefined && isTextExpression(initializer, seen);
  }
  return false;
}

/** Napisy, szablony i spready wywołań spoza źródeł zgłoszeń w ujściach zgłoszeń jednego źródła. */
function sinkViolations(file: string, source: string, vocabulary: IssueVocabulary): Violation[] {
  const ast = parse(file, source);
  const violations: Violation[] = [];
  const report = (node: ts.Node, what: string): void => {
    violations.push({
      file,
      fn: enclosingFunction(node),
      line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      expression: flatText(node, ast),
      text: `${what}: ${flatText(node, ast).slice(0, 100)}`,
    });
  };
  const returnsIssues = (call: ts.CallExpression): boolean => {
    const name = terminalName(call.expression);
    return name !== undefined && (vocabulary.factories.has(name) || vocabulary.issueSources.has(name));
  };
  const isIssueFunction = (fn: ts.SignatureDeclaration | undefined): boolean => {
    if (fn === undefined) return false;
    const name = functionName(fn);
    return (fn.type !== undefined && ISSUE_RESULT_TYPE.test(fn.type.getText(ast)))
      || (name !== undefined && (vocabulary.issueSources.has(name) || vocabulary.textHooks.has(name) || isSinkName(name)));
  };
  const checkSpread = (spread: ts.Expression, at: ts.Node, where: string): void => {
    const inner = unwrap(spread);
    if (ts.isCallExpression(inner) && !returnsIssues(inner)) report(at, `${where}: spread wywołania spoza źródeł zgłoszeń`);
    else checkValue(inner, where);
  };
  /** Wartość trafiająca do zgłoszeń: bez napisu, szablonu i spreadu wywołania spoza źródeł zgłoszeń. */
  const checkValue = (value: ts.Expression, where: string): void => {
    const inner = unwrap(value);
    if (isTextExpression(inner, new Set())) {
      report(inner, `${where}: napis`);
    } else if (ts.isConditionalExpression(inner)) {
      checkValue(inner.whenTrue, where);
      checkValue(inner.whenFalse, where);
    } else if (
      ts.isBinaryExpression(inner)
      && (inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || inner.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      checkValue(inner.right, where);
    } else if (ts.isArrayLiteralExpression(inner)) {
      for (const element of inner.elements) {
        if (ts.isSpreadElement(element)) checkSpread(element.expression, element, where);
        else checkValue(element, where);
      }
    }
  };
  /** Zwracana tablica funkcji zgłoszeń (także w gałęzi warunku); sam zwracany napis nie jest zgłoszeniem. */
  const checkReturned = (value: ts.Expression): void => {
    const inner = unwrap(value);
    if (ts.isConditionalExpression(inner)) {
      checkReturned(inner.whenTrue);
      checkReturned(inner.whenFalse);
    } else if (ts.isArrayLiteralExpression(inner)) {
      checkValue(inner, "return");
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && SINK_MUTATORS.has(node.expression.name.text)) {
      const name = terminalName(node.expression.expression);
      if (isSinkName(name)) {
        for (const argument of node.arguments) {
          const where = `${name}.${node.expression.name.text}`;
          if (ts.isSpreadElement(argument)) checkSpread(argument.expression, argument, where);
          else checkValue(argument, where);
        }
      }
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      if (isSinkName(node.name.text)) checkValue(node.initializer, node.name.text);
    } else if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (isSinkName(name)) checkValue(node.initializer, `${name}:`);
      if (name === "reason") checkValue(node.initializer, "reason:");
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const name = terminalName(node.left);
      if (isSinkName(name)) checkValue(node.right, `${name} =`);
    } else if (ts.isReturnStatement(node) && node.expression !== undefined) {
      if (isIssueFunction(directFunction(node))) checkReturned(node.expression);
    } else if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      if (isIssueFunction(node)) checkReturned(node.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return violations;
}

function read(file: string): string {
  return readFileSync(join(serverSrc, file), "utf8");
}

function productionVocabulary(): IssueVocabulary {
  return issueVocabulary(VOCABULARY_FILES.map((file) => parse(file, read(file))));
}

function exceptionFor(
  violation: Violation,
  exceptions: Readonly<Record<string, readonly SinkException[]>>,
): SinkException | undefined {
  return exceptions[violation.file]?.find((entry) => entry.fn === violation.fn && entry.expression === violation.expression);
}

/** Naruszenia bez wyjątku. */
function unexcepted(violations: readonly Violation[], exceptions: Readonly<Record<string, readonly SinkException[]>>): Violation[] {
  return violations.filter((violation) => exceptionFor(violation, exceptions) === undefined);
}

function describeViolation(violation: Violation): string {
  return `${violation.file}:${violation.line} (${violation.fn}) ${violation.text}`;
}

describe("zgłoszenia walidatorów wyłącznie przez fabryki katalogu reguł", () => {
  const vocabulary = productionVocabulary();
  const violations = SCANNED.flatMap((file) => sinkViolations(file, read(file), vocabulary));

  it("skan widzi pliki, fabryki i źródła zgłoszeń (nie jest fałszywie zielony)", () => {
    expect(SCANNED.filter((file) => SUBJECT_HOOK_FILE.test(file)).length).toBeGreaterThanOrEqual(8);
    for (const file of SCANNED) expect(() => read(file), file).not.toThrow();
    expect([...vocabulary.factories]).toEqual(
      expect.arrayContaining(["coreIssue", "lessonIssue", "shapeIssue", "calculationIssue", "englishIssue", "chapterIssue", "grammarIssue", "schoolIssue"]),
    );
    expect([...vocabulary.issueSources]).toEqual(expect.arrayContaining(["validateExercise", "exerciseGate", "formatRuleReason"]));
    expect([...vocabulary.textHooks].sort()).toEqual(["objectiveGaps", "planGate"]);
  });

  it("w ujściach zgłoszeń nie ma napisów ani spreadów spoza fabryk (poza wyjątkami)", () => {
    expect(unexcepted(violations, EXCEPTIONS).map(describeViolation)).toEqual([]);
  });

  it("każdy wyjątek coś wyłącza", () => {
    const used = new Set(violations.map((violation) => exceptionFor(violation, EXCEPTIONS)));
    const stale = Object.entries(EXCEPTIONS).flatMap(([file, entries]) =>
      entries.filter((entry) => !used.has(entry)).map((entry) => `${file} (${entry.fn}) ${entry.expression}`),
    );
    expect(stale).toEqual([]);
  });

  it("fabryki zgłoszeń dostają literał id we wszystkich źródłach silnika lekcji i narzędzi", () => {
    expect(VOCABULARY_FILES.flatMap((file) => factoryIdViolations(file, read(file), vocabulary)).map(describeViolation)).toEqual([]);
  });
});

describe("test zgłoszeń — czułość (fikcyjne źródło)", () => {
  const fixture = `
    import { issueFrom, type LessonRuleIssue } from "./catalog";
    const issue = issueFrom(RULES);
    function nestedIssues(): LessonRuleIssue[] { return []; }
    export function validateThing(idVar: string): LessonRuleIssue[] {
      const errors: LessonRuleIssue[] = [];
      errors.push("x");
      errors.push(\`x\`);
      errors.push(...f());
      errors.push(issue(idVar, { pl: "p" }));
      errors.push(issue("thing.ok", { pl: "p" }));
      errors.push(...nestedIssues());
      errors.push("x: " + n);
      errors.push(n + \`: x\`);
      errors.push(String(n));
      const msg = "x";
      errors.push(msg);
      errors.unshift(names.join(", "));
      errors.push(n + 1);
      return errors;
    }
    export function thingFindings(ok: boolean): LessonRuleIssue[] {
      return ok ? [] : [\`bad \${ok}\`];
    }
    const result = { reason: "free text" };
    const joined = { reason: "bad " + n };
    const fine = { reason: REASON_CODE, issues: [issue("thing.ok", { pl: "p" })] };
    function words(): string[] { return ["a", ...list.map(String)]; }
  `;
  const ast = parse("fixture.ts", fixture);
  const vocabulary = issueVocabulary([ast]);

  it("wykrywa napis, szablon, konkatenację, `String`, zmienną z napisem, spread obcego wywołania, napis w zwracanej tablicy i w `reason:`", () => {
    expect(sinkViolations("fixture.ts", fixture, vocabulary).map((violation) => violation.text)).toEqual([
      'errors.push: napis: "x"',
      "errors.push: napis: `x`",
      "errors.push: spread wywołania spoza źródeł zgłoszeń: ...f()",
      'errors.push: napis: "x: " + n',
      "errors.push: napis: n + `: x`",
      "errors.push: napis: String(n)",
      "errors.push: napis: msg",
      'errors.unshift: napis: names.join(", ")',
      "return: napis: `bad ${ok}`",
      'reason:: napis: "free text"',
      'reason:: napis: "bad " + n',
    ]);
  });

  it("wyjątek obejmuje tylko wskazane wyrażenie: nowy napis w tej samej funkcji pada", () => {
    const source = `
      function submit(raw) {
        if (!Array.isArray(raw)) return { errors: ["exercises must be an array"] };
        if (raw.length === 0) return { errors: ["a new refusal"] };
        return { errors: [] };
      }
    `;
    const exceptions = { "f.ts": [{ fn: "submit", expression: '"exercises must be an array"', reason: "odmowa" }] };
    expect(unexcepted(sinkViolations("f.ts", source, vocabulary), exceptions).map((violation) => violation.text)).toEqual([
      'errors:: napis: "a new refusal"',
    ]);
  });

  it("wykrywa fabrykę z id ze zmiennej", () => {
    expect(factoryIdViolations("fixture.ts", fixture, vocabulary).map((violation) => violation.text)).toEqual([
      'fabryka bez literału id: issue(idVar, { pl: "p" })',
    ]);
  });

  it("wyjątek obejmuje funkcję, w której leży naruszenie (także w anonimowym wywołaniu zwrotnym)", () => {
    const source = "function submitExamples(lines) { const errors = []; lines.forEach(() => { errors.push(`x`); }); }";
    expect(sinkViolations("f.ts", source, vocabulary).map((violation) => violation.fn)).toEqual(["submitExamples"]);
  });
});
