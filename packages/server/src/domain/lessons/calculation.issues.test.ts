import { describe, expect, it } from "vitest";
import type { CalculationSpec } from "@learning/contracts";
import { calculationIssues, computeCalculationAnswer } from "./calculation";
import { MAX_TOLERANCE_PERCENT, MAX_TOLERANCE_SHARE } from "./rules/limits";

/**
 * Zgłoszenia reguł specyfikacji rachunku (`calculationIssues`, spec katalogu
 * reguł §4.4): tolerancja z wynikiem i limitem, zły slug, niedozwolony klucz,
 * parametry. Funkcja jest czysta i nie rzuca; `computeCalculationAnswer` rzuca dalej.
 */

const scale: CalculationSpec = {
  kind: "scale_distance",
  params: { scaleDenominator: 25000, mapDistanceCm: 3 },
  unit: "m",
  templateFamilyId: "map-scale",
};

/** Wynik `scale`: 750 m, więc limit tolerancji to 750 / MAX_TOLERANCE_SHARE. */
const LIMIT = 750 / MAX_TOLERANCE_SHARE;

const rules = (spec: unknown) => calculationIssues(spec).map((issue) => issue.rule as string);

describe("calculationIssues", () => {
  it("poprawna specyfikacja (także z tolerancją 0) → brak zgłoszeń", () => {
    expect(calculationIssues(scale)).toEqual([]);
    expect(calculationIssues({ ...scale, tolerance: 0 })).toEqual([]);
  });

  it("tolerancja dokładnie na granicy przechodzi, a ponad nią daje calculation.tolerance z wynikiem i limitem", () => {
    expect(calculationIssues({ ...scale, tolerance: LIMIT })).toEqual([]);
    const [issue, ...rest] = calculationIssues({ ...scale, tolerance: LIMIT + 0.5 });
    expect(rest).toEqual([]);
    expect(issue).toMatchObject({ rule: "calculation.tolerance", field: "calculation.tolerance" });
    expect(issue!.found).toBe(`tolerance 8 m, limit 7,5 m (${MAX_TOLERANCE_PERCENT}% of the result 750 m)`);
    // Kalkulator dalej rzuca przy tej samej granicy.
    expect(() => computeCalculationAnswer({ ...scale, tolerance: LIMIT + 0.5 })).toThrow();
    expect(computeCalculationAnswer({ ...scale, tolerance: LIMIT }).answer).toBe("750 m");
  });

  it("tolerance: null → calculation.tolerance z „null” (zamianę na brak pola robi materializacja)", () => {
    const [issue, ...rest] = calculationIssues({ ...scale, tolerance: null });
    expect(rest).toEqual([]);
    expect(issue).toMatchObject({ rule: "calculation.tolerance", field: "calculation.tolerance" });
    expect(issue!.found).toContain("null");
  });

  it("templateFamilyId z podkreśleniem → calculation.family_slug z wartością", () => {
    const [issue, ...rest] = calculationIssues({ ...scale, templateFamilyId: "scale_distance-1" });
    expect(rest).toEqual([]);
    expect(issue).toMatchObject({ rule: "calculation.family_slug", field: "calculation.templateFamilyId" });
    expect(issue!.found).toContain('"scale_distance-1"');
  });

  it("obcy klucz w params → calculation.unknown_key z dozwolonymi parametrami rodzaju", () => {
    const [issue, ...rest] = calculationIssues({ ...scale, params: { ...scale.params, zoom: 2 } });
    expect(rest).toEqual([]);
    expect(issue).toMatchObject({ rule: "calculation.unknown_key", field: "calculation.params" });
    expect(issue!.found).toContain('"zoom"');
    expect(issue!.found).toContain("scaleDenominator, mapDistanceCm");
  });

  it("obcy klucz specyfikacji → calculation.unknown_key na polu calculation", () => {
    const [issue] = calculationIssues({ ...scale, note: "x" });
    expect(issue).toMatchObject({ rule: "calculation.unknown_key", field: "calculation" });
    expect(issue!.found).toContain("templateFamilyId");
  });

  it.each([
    ["ujemna odległość", { ...scale, params: { scaleDenominator: 25000, mapDistanceCm: -1 } }, "calculation.params.mapDistanceCm", "-1 is negative"],
    ["za dużo miejsc dziesiętnych", { ...scale, params: { scaleDenominator: 25000, mapDistanceCm: 1.0001 } }, "calculation.params.mapDistanceCm", "decimal places"],
    [
      "punkt wyższy poniżej niższego",
      { kind: "height_difference", params: { upperHeightM: 100, lowerHeightM: 400 }, unit: "m", templateFamilyId: "height" },
      "calculation.params.upperHeightM",
      "below lowerHeightM 400",
    ],
    ["brak parametru", { ...scale, params: { scaleDenominator: 25000 } }, "calculation.params.mapDistanceCm", "got nothing"],
    ["nieznany rodzaj", { ...scale, kind: "area" }, "calculation.kind", "scale_distance, height_difference, unit_conversion"],
    ["zła jednostka", { ...scale, unit: "mm" }, "calculation.unit", '"mm"'],
  ] as const)("%s → calculation.params z polem i wartością", (_name, spec, field, foundPart) => {
    const issues = calculationIssues(spec);
    expect(issues.map((issue) => [issue.rule, issue.field])).toEqual([["calculation.params", field]]);
    expect(issues[0]!.found).toContain(foundPart);
  });

  it("nie rzuca dla dowolnej wartości", () => {
    for (const value of [undefined, null, "x", 3, [], {}, { kind: "scale_distance" }, { ...scale, params: null }]) {
      expect(() => calculationIssues(value)).not.toThrow();
      expect(rules(value).length).toBeGreaterThan(0);
    }
  });
});
