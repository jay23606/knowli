import { describe, expect, it } from "vitest";
import type { CalculationSpec, LengthUnit } from "@learning/contracts";
import { computeCalculationAnswer, renderCalculationPrompt, evaluateCalculationAnswer } from "./calculation";

const scale: CalculationSpec = {
  kind: "scale_distance", params: { scaleDenominator: 25000, mapDistanceCm: 3 },
  unit: "m", templateFamilyId: "map-scale",
};
const height: CalculationSpec = {
  kind: "height_difference", params: { upperHeightM: 400, lowerHeightM: 150 },
  unit: "m", templateFamilyId: "height",
};
const conversion: CalculationSpec = {
  kind: "unit_conversion", params: { value: 0.75, fromUnit: "km" },
  unit: "m", templateFamilyId: "conversion",
};

describe("exact calculation answers and prompts", () => {
  it.each([
    [scale, { value: 750, unit: "m", answer: "750 m" }, "Na mapie w skali 1:25 000 odcinek ma 3 cm. Oblicz odległość w terenie w m."],
    [height, { value: 250, unit: "m", answer: "250 m" }, "Punkt wyższy: 400 m n.p.m., punkt niższy: 150 m n.p.m. Oblicz różnicę wysokości w m."],
    [conversion, { value: 750, unit: "m", answer: "750 m" }, "Przelicz 0,75 km na m."],
    [{ ...height, params: { upperHeightM: -50, lowerHeightM: -100 } }, { value: 50, unit: "m", answer: "50 m" }, "Punkt wyższy: -50 m n.p.m., punkt niższy: -100 m n.p.m. Oblicz różnicę wysokości w m."],
  ] as const)("computes and renders %j", (spec, answer, prompt) => {
    expect(computeCalculationAnswer(spec)).toEqual(answer);
    expect(renderCalculationPrompt(spec)).toBe(prompt);
  });

  it.each([[1, "1:1 "], [500, "1:500 "], [1000, "1:1 000 "], [25000, "1:25 000 "], [1000000000, "1:1 000 000 000 "]])(
    "groups the scale denominator %i into thousands", (scaleDenominator, expected) => {
      expect(renderCalculationPrompt({ ...scale, params: { ...scale.params, scaleDenominator } })).toContain(`w skali ${expected}odcinek`);
    });

  it("keeps fractional and large answers exact instead of formatting the approximate number", () => {
    const large: CalculationSpec = { ...scale, params: { mapDistanceCm: 999999.999, scaleDenominator: 999999999 } };
    expect(computeCalculationAnswer(large).answer).toBe("9999999980000,00001 m");
    expect(evaluateCalculationAnswer("9999999980000,00001 m", large)).toBe("correct");
    expect(evaluateCalculationAnswer("9999999980000 m", large)).toBe("incorrect");
    expect(evaluateCalculationAnswer("9999999980000,000010001 m", large)).toBe("incorrect");
    expect(computeCalculationAnswer({ ...conversion, params: { value: 0.001, fromUnit: "cm" }, unit: "km" }).answer).toBe("0,00000001 km");
  });
});

describe("Polish calculation answer parser", () => {
  // Exact answer in a unit other than the parsed one, so a dropped unit fails;
  // a unitless answer is read in the spec unit.
  const exactly = (value: number, unit: LengthUnit | null): CalculationSpec => ({
    ...conversion, params: { value, fromUnit: unit ?? "cm" }, unit: unit === null ? "cm" : unit === "cm" ? "m" : "cm", tolerance: 0,
  });

  it.each([
    ["1\u00a0234,5 m", 1234.5, "m"],
    ["+1\u202f234,567 KM", 1234.567, "km"],
    ["1\u202f234", 1234, null],
    ["750m", 750, "m"],
    ["0", 0, null],
    // School notation children actually write.
    ["750 m.", 750, "m"],
    ["750.", 750, null],
    ["250 m n.p.m.", 250, "m"],
    ["250m npm", 250, "m"],
    ["750 metrów", 750, "m"],
    ["0,75 kilometra", 0.75, "km"],
    ["12 Centymetrów.", 12, "cm"],
  ] as const)("parses the entire answer %j", (text, value, unit) => {
    expect(evaluateCalculationAnswer(text, exactly(value, unit))).toBe("correct");
  });

  it.each([
    [" -1 234,5 cm ", 1234.5, "cm"],
    ["-0,001", 0.001, null],
    ["\u2212250 m", 250, "m"],
  ] as const)("keeps the sign of %j", (text, magnitude, unit) => {
    expect(evaluateCalculationAnswer(text, exactly(magnitude, unit))).toBe("incorrect");
    expect(evaluateCalculationAnswer(text.replace(/[-−]/, ""), exactly(magnitude, unit))).toBe("correct");
  });

  it("parses repeated thousands separators", () => {
    const spec: CalculationSpec = { ...scale, params: { mapDistanceCm: 123456.7, scaleDenominator: 1000 }, tolerance: 0 };
    expect(evaluateCalculationAnswer("+1 234 567 M", spec)).toBe("correct");
  });

  it.each(["1,2,3", "12 34", "750 m bo tak", "NaN", "Infinity", "1e3", "1.234", "1.5", "1,", ",5", "1,1234567890", "750 mm", "", " ", "--1", "1 2345", "1\n234", "750 m\nbo tak",
    "750 m..", "750 m bo tak.", "750 metrami bo tak", "n.p.m. 250", "250 n.p.m.", "750 milimetrów"])("rejects ambiguous or partial input %j", (text) => {
    expect(evaluateCalculationAnswer(text, scale)).toBe("unevaluated");
  });
});

describe("deterministic calculation evaluation", () => {
  it.each([
    ["750", "correct"], ["0,75 km", "correct"], ["75 000 cm", "correct"],
    ["750 km", "incorrect"], ["-750 m", "incorrect"], ["749,999999999 m", "incorrect"],
    ["nie wiem", "unevaluated"], ["750 m bo tak", "unevaluated"],
    ["750 m.", "correct"], ["750 metrów", "correct"], ["0,75 kilometra", "correct"], ["749 metrów", "incorrect"],
  ])("evaluates %j as %s", (text, result) => {
    expect(evaluateCalculationAnswer(text, scale)).toBe(result);
  });

  it("includes the exact tolerance boundary without adding an epsilon", () => {
    const spec = { ...scale, tolerance: 0.5 };
    expect(evaluateCalculationAnswer("750,5", spec)).toBe("correct");
    expect(evaluateCalculationAnswer("749,5", spec)).toBe("correct");
    expect(evaluateCalculationAnswer("0,7505 km", spec)).toBe("correct");
    expect(evaluateCalculationAnswer("750,500000001", spec)).toBe("incorrect");
    expect(evaluateCalculationAnswer("749,499999999", spec)).toBe("incorrect");
  });

  it("checks the one-percent tolerance limit using the exact result", () => {
    expect(computeCalculationAnswer({ ...scale, tolerance: 7.5 }).answer).toBe("750 m");
    const fractional: CalculationSpec = { ...conversion, params: { value: 0.1, fromUnit: "m" }, tolerance: 0.001 };
    expect(evaluateCalculationAnswer("0,101", fractional)).toBe("correct");
    expect(() => computeCalculationAnswer({ ...fractional, tolerance: 0.001000000001 })).toThrow();
    const large: CalculationSpec = { ...scale, params: { mapDistanceCm: 999999.999, scaleDenominator: 999999999 }, tolerance: 99999999800.0000001 };
    // JS rounds this tolerance to 99999999800: below the exact 1% boundary.
    expect(evaluateCalculationAnswer("10099999979800,00001 m", large)).toBe("correct");
    expect(evaluateCalculationAnswer("10099999979800,000010001 m", large)).toBe("incorrect");
  });

  it.each([
    { ...scale, tolerance: 7.500000001 },
    { ...height, params: { upperHeightM: 0, lowerHeightM: 0 }, tolerance: 0.001 },
    { ...scale, params: { ...scale.params, scaleDenominator: 0 } },
    { ...height, params: { upperHeightM: -100, lowerHeightM: -50 } },
    { ...scale, extra: true },
  ])("validates persisted JSONB input in every spec-taking function: %j", (invalid) => {
    const spec = invalid as CalculationSpec;
    expect(() => computeCalculationAnswer(spec)).toThrow();
    expect(() => renderCalculationPrompt(spec)).toThrow();
    expect(() => evaluateCalculationAnswer("750", spec)).toThrow();
    expect(() => evaluateCalculationAnswer("unparseable", spec)).toThrow();
  });

  it("accepts zero with zero tolerance", () => {
    const zero = { ...height, params: { upperHeightM: -100, lowerHeightM: -100 }, tolerance: 0 };
    expect(computeCalculationAnswer(zero)).toEqual({ value: 0, unit: "m", answer: "0 m" });
    expect(evaluateCalculationAnswer("0 km", zero)).toBe("correct");
  });
});