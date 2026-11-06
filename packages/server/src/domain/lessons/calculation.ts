import {
  CalculationSpecSchema,
  MAX_CALCULATION_DECIMALS,
  MAX_TEMPLATE_FAMILY_ID_LENGTH,
  type CalculationSpec,
  type LengthUnit,
} from "@learning/contracts";
import type { z } from "zod";
import { clip, issueFrom, type LessonRuleIssue } from "./rules/catalog";
import { CORE_RULES } from "./rules/core-rules";
import { MAX_TOLERANCE_PERCENT, MAX_TOLERANCE_SHARE } from "./rules/limits";

/** Exact decimal fractions are private: no bigint crosses the JSON boundary. */
type Fraction = { numerator: bigint; denominator: bigint };
const CENTIMETERS: Record<LengthUnit, bigint> = { cm: 1n, m: 100n, km: 100000n };

function decimalFraction(text: string): Fraction {
  const [coefficient, exponent = "0"] = text.toLowerCase().split("e");
  const [integer, decimal = ""] = coefficient.split(".");
  const numerator = BigInt(integer + decimal);
  const places = decimal.length - Number(exponent);
  return places >= 0
    ? { numerator, denominator: 10n ** BigInt(places) }
    : { numerator: numerator * 10n ** BigInt(-places), denominator: 1n };
}

function fromNumber(value: number): Fraction {
  return decimalFraction(String(value));
}

function convert(value: Fraction, from: LengthUnit, to: LengthUnit): Fraction {
  return {
    numerator: value.numerator * CENTIMETERS[from],
    denominator: value.denominator * CENTIMETERS[to],
  };
}

function subtract(left: Fraction, right: Fraction): Fraction {
  return {
    numerator: left.numerator * right.denominator - right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  };
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function withinTolerance(difference: Fraction, tolerance: Fraction): boolean {
  return absolute(difference.numerator) * tolerance.denominator
    <= tolerance.numerator * difference.denominator;
}

/** All denominators come from decimals and cm/m/km, so decimal expansion terminates. */
function formatFraction(value: Fraction): string {
  const numerator = absolute(value.numerator);
  const integer = numerator / value.denominator;
  let remainder = numerator % value.denominator;
  let decimal = "";
  while (remainder !== 0n) {
    remainder *= 10n;
    decimal += String(remainder / value.denominator);
    remainder %= value.denominator;
  }
  return `${value.numerator < 0n ? "-" : ""}${integer}${decimal ? `,${decimal}` : ""}`;
}

function computeExact(spec: CalculationSpec): Fraction {
  switch (spec.kind) {
    case "scale_distance": {
      const distance = fromNumber(spec.params.mapDistanceCm);
      return convert({
        numerator: distance.numerator * BigInt(spec.params.scaleDenominator),
        denominator: distance.denominator,
      }, "cm", spec.unit);
    }
    case "height_difference":
      return convert(subtract(fromNumber(spec.params.upperHeightM), fromNumber(spec.params.lowerHeightM)), "m", spec.unit);
    case "unit_conversion":
      return convert(fromNumber(spec.params.value), spec.params.fromUnit, spec.unit);
  }
}

/** tolerance > abs(result) / MAX_TOLERANCE_SHARE, compared without rounding either side. */
function exceedsToleranceLimit(result: Fraction, tolerance: Fraction): boolean {
  return tolerance.numerator * result.denominator * BigInt(MAX_TOLERANCE_SHARE)
    > absolute(result.numerator) * tolerance.denominator;
}

function validatedCalculation(input: CalculationSpec): { spec: CalculationSpec; result: Fraction; tolerance: Fraction } {
  const spec = CalculationSpecSchema.parse(input);
  const result = computeExact(spec);
  const tolerance = fromNumber(spec.tolerance ?? 0);
  if (exceedsToleranceLimit(result, tolerance)) {
    throw new Error(`Tolerancja nie może przekraczać ${MAX_TOLERANCE_PERCENT}% wartości bezwzględnej wyniku.`);
  }
  return { spec, result, tolerance };
}

// ---------------------------------------------------------------------------
// Zgłoszenia reguł specyfikacji rachunku (spec katalogu reguł §4.4).
// ---------------------------------------------------------------------------

/** Fabryka zgłoszeń reguł rdzenia (rachunek). */
const calculationIssue = issueFrom(CORE_RULES);

/** Klucze specyfikacji i parametry każdego rodzaju — prosto ze schematu kontraktu. */
const SPEC_KEYS: readonly string[] = Object.keys(CalculationSpecSchema.options[0].shape);
const PARAM_KEYS: ReadonlyMap<string, readonly string[]> = new Map(
  CalculationSpecSchema.options.map((option) => [option.shape.kind.value, Object.keys(option.shape.params.shape)] as const),
);

/** Ścieżka w specyfikacji jako pole ćwiczenia, np. `calculation.params.mapDistanceCm`. */
function specField(path: readonly PropertyKey[]): string {
  return ["calculation", ...path.map(String)].join(".");
}

function specValueAt(spec: unknown, path: readonly PropertyKey[]): unknown {
  let current = spec;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

/** Otrzymana wartość do `found`: napis w cudzysłowie, reszta jako wycięty JSON. */
function shown(value: unknown): string {
  if (value === undefined) return "nothing";
  if (typeof value === "string") return clip(value);
  return clip(JSON.stringify(value) ?? String(value), undefined, { quote: false });
}

/** Liczba miejsc dziesiętnych liczby z JSON (jak sprawdzenie kontraktu). */
function decimalPlaces(value: number): number {
  const [coefficient, exponent = "0"] = String(value).toLowerCase().split("e");
  return (coefficient.split(".")[1]?.length ?? 0) - Number(exponent);
}

/** Co jest nie tak z parametrem odrzuconym przez sprawdzenie własne kontraktu (`refine`). */
function customParamProblem(path: readonly PropertyKey[], value: unknown, spec: unknown): string {
  const lower = specValueAt(spec, ["params", "lowerHeightM"]);
  if (path[1] === "upperHeightM" && typeof value === "number" && typeof lower === "number" && value < lower) {
    return `upperHeightM ${value} is below lowerHeightM ${lower}`;
  }
  if (typeof value === "number" && value < 0) {
    return `${value} is negative`;
  }
  if (typeof value === "number" && decimalPlaces(value) > MAX_CALCULATION_DECIMALS) {
    return `${value} has more than ${MAX_CALCULATION_DECIMALS} decimal places`;
  }
  return `got ${shown(value)}; fails the calculator check`;
}

/** Zgłoszenie reguły rachunku dla jednego błędu kontraktu specyfikacji. */
function specIssue(issue: z.core.$ZodIssue, spec: unknown): LessonRuleIssue {
  const field = specField(issue.path);
  const value = specValueAt(spec, issue.path);
  const [head] = issue.path;
  if (issue.code === "unrecognized_keys") {
    const kind = specValueAt(spec, ["kind"]);
    const allowed = issue.path.length === 0 ? SPEC_KEYS : PARAM_KEYS.get(String(kind)) ?? [];
    return calculationIssue("calculation.unknown_key", {
      field,
      pl: `${field}: niedozwolony klucz (${issue.keys.join(", ")})`,
      found: `unknown key ${clip(issue.keys.join(", "))} in ${field}; allowed: ${allowed.join(", ") || "none"}`,
    });
  }
  if (head === "tolerance") {
    return calculationIssue("calculation.tolerance", {
      pl: "calculation.tolerance: tolerancja to nieujemna liczba (albo brak pola)",
      found: `tolerance ${shown(value)}; leave it out or use 0`,
    });
  }
  if (head === "templateFamilyId") {
    return calculationIssue("calculation.family_slug", {
      pl: "calculation.templateFamilyId: identyfikator rodziny to małe litery i cyfry łączone „-”",
      found: typeof value === "string" && [...value].length > MAX_TEMPLATE_FAMILY_ID_LENGTH
        ? `templateFamilyId has ${[...value].length} characters, limit ${MAX_TEMPLATE_FAMILY_ID_LENGTH}`
        : `templateFamilyId ${shown(value)} is not lowercase letters and digits joined by single "-"`,
    });
  }
  const problem = (() => {
    switch (issue.code) {
      case "invalid_type":
        return issue.path.length === 0
          ? `calculation is not an object {kind, unit, params, templateFamilyId}; got ${shown(value)}`
          : `got ${shown(value)}; expected ${issue.expected}`;
      case "too_small":
        return `got ${shown(value)}; expected at least ${issue.minimum}`;
      case "too_big":
        return `got ${shown(value)}; expected at most ${issue.maximum}`;
      case "invalid_value":
        return `got ${shown(value)}; expected one of ${issue.values.map(String).join(", ")}`;
      case "invalid_union":
        return head === "kind"
          ? `got ${shown(value)}; expected one of ${[...PARAM_KEYS.keys()].join(", ")}`
          : `got ${shown(value)}; matches none of the calculation kinds`;
      case "custom":
        return customParamProblem(issue.path, value, spec);
      default:
        return `got ${shown(value)}; fails the calculator check`;
    }
  })();
  return calculationIssue("calculation.params", {
    field,
    pl: `${field}: nieprawidłowe parametry obliczenia`,
    found: problem,
  });
}

/**
 * Zgłoszenia reguł specyfikacji rachunku (`calculation.*`) dla dowolnej wartości:
 * kształt i granice kontraktu, a dla poprawnej specyfikacji tolerancja względem
 * dokładnego wyniku. Pusta lista = kalkulator ją przyjmie. Czysta i nie rzuca;
 * `null` tolerancji jest błędem (zamianę na brak pola robi materializacja).
 */
export function calculationIssues(spec: unknown): LessonRuleIssue[] {
  const parsed = CalculationSpecSchema.safeParse(spec);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => specIssue(issue, spec));
  }
  const result = computeExact(parsed.data);
  const tolerance = fromNumber(parsed.data.tolerance ?? 0);
  if (!exceedsToleranceLimit(result, tolerance)) {
    return [];
  }
  const unit = parsed.data.unit;
  const limit = { numerator: absolute(result.numerator), denominator: result.denominator * BigInt(MAX_TOLERANCE_SHARE) };
  return [calculationIssue("calculation.tolerance", {
    pl: `calculation.tolerance: tolerancja przekracza ${MAX_TOLERANCE_PERCENT}% wartości bezwzględnej wyniku`,
    found:
      `tolerance ${formatFraction(tolerance)} ${unit}, limit ${formatFraction(limit)} ${unit} ` +
      `(${MAX_TOLERANCE_PERCENT}% of the result ${formatFraction(result)} ${unit})`,
  })];
}

export function computeCalculationAnswer(spec: CalculationSpec): { value: number; unit: LengthUnit; answer: string } {
  const { spec: validated, result } = validatedCalculation(spec);
  const exactText = formatFraction(result);
  return {
    // Approximation for JSON consumers only; formatting and evaluation use result.
    value: Number(exactText.replace(",", ".")),
    unit: validated.unit,
    answer: `${exactText} ${validated.unit}`,
  };
}

/** "25000" → "25 000": groups of three digits from the right, without a regex. */
function groupThousands(digits: string): string {
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
  return groups.join(" ");
}

export function renderCalculationPrompt(input: CalculationSpec): string {
  const { spec } = validatedCalculation(input);
  const format = (value: number) => formatFraction(fromNumber(value));
  switch (spec.kind) {
    case "scale_distance": {
      const denominator = groupThousands(String(spec.params.scaleDenominator));
      return `Na mapie w skali 1:${denominator} odcinek ma ${format(spec.params.mapDistanceCm)} cm. Oblicz odległość w terenie w ${spec.unit}.`;
    }
    case "height_difference":
      return `Punkt wyższy: ${format(spec.params.upperHeightM)} m n.p.m., punkt niższy: ${format(spec.params.lowerHeightM)} m n.p.m. Oblicz różnicę wysokości w ${spec.unit}.`;
    case "unit_conversion":
      return `Przelicz ${format(spec.params.value)} ${spec.params.fromUnit} na ${spec.unit}.`;
  }
}

/** Unit symbol or its Polish word form (metr, metry, metr\u00f3w, metra\u2026). */
const UNIT_PATTERN = "cm|centymetr(?:a|y|\u00f3w)?|km|kilometr(?:a|y|\u00f3w)?|m|metr(?:a|y|\u00f3w)?";
// Only the listed spaces can group digits. No partial parsing, decimal dot,
// exponent or free-form explanation is accepted as a numeric answer. Accepted
// school notation around the number: a typographic minus, "m n.p.m." (copied
// from height prompts) and one closing period, as in "750 m.".
const ANSWER_PATTERN = new RegExp(
  "^([+\\-\\u2212]?(?:[0-9]{1,3}(?:[ \\u00a0\\u202f][0-9]{3})+|[0-9]+)(?:,[0-9]{1,9})?)" +
    `[ \\u00a0\\u202f]*(?:(${UNIT_PATTERN})(?:[ \\u00a0\\u202f]*n\\.?[ \\u00a0\\u202f]*p\\.?[ \\u00a0\\u202f]*m)?)?` +
    "[ \\u00a0\\u202f]*\\.?$",
  "iu",
);

function unitOf(token: string | undefined): LengthUnit | null {
  if (token === undefined) return null;
  const lower = token.toLowerCase();
  if (lower.startsWith("c")) return "cm";
  if (lower.startsWith("k")) return "km";
  return "m";
}

function parseExactAnswer(text: string): { value: Fraction; unit: LengthUnit | null } | null {
  const match = ANSWER_PATTERN.exec(text.trim());
  if (!match) return null;
  const numberText = match[1].replace(/[ \u00a0\u202f]/g, "").replace("\u2212", "-").replace(",", ".");
  if (!Number.isFinite(Number(numberText))) return null;
  return { value: decimalFraction(numberText), unit: unitOf(match[2]) };
}

export function evaluateCalculationAnswer(text: string, input: CalculationSpec): "correct" | "incorrect" | "unevaluated" {
  const { spec, result, tolerance } = validatedCalculation(input);
  const parsed = parseExactAnswer(text);
  if (!parsed) return "unevaluated";
  const candidate = convert(parsed.value, parsed.unit ?? spec.unit, spec.unit);
  return withinTolerance(subtract(candidate, result), tolerance) ? "correct" : "incorrect";
}