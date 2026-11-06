import { describe, expect, it } from "vitest";
import { messages } from "@learning/contracts";
import { materializeGeneratedCalculations } from "./lesson-calculations";
import { isWellShapedRawExercise } from "../modules/materials/lessons/lesson-drafts";

/**
 * Opakowanie materializacji rachunków dla generatora fake'a agenta (`fakeObjectiveExercises`) i testu
 * integracyjnego; ścieżka agenta materializuje w narzędziach (`materializeRawExercise`, test w
 * `domain/lessons/raw-materialize.test.ts`). Kod liczy odpowiedź i treść; wadliwe rekordy zostają do odrzucenia.
 */

const material = "Skala mapy pozwala przeliczyć odległość na mapie na odległość w terenie.";
const raw = {
  exerciseType: "lesson_calculation", objectiveId: "scale",
  calculation: { kind: "scale_distance", params: { scaleDenominator: 25000, mapDistanceCm: 3 }, unit: "m", templateFamilyId: "map-scale" },
  sourceRefs: [{ quote: material }],
};

describe("materializeGeneratedCalculations", () => {
  it("renders canonical content and computes the answer instead of trusting model fields", () => {
    const injected = { ...raw, answer: "999 km", prompt: "Nowe fakty geograficzne", focus: ["999"], acceptedAnswers: ["999"] };
    const [exercise] = materializeGeneratedCalculations([injected]);
    expect(exercise).toMatchObject({
      ...raw, answer: "750 m", focus: [], acceptedAnswers: [],
      prompt: "Na mapie w skali 1:25 000 odcinek ma 3 cm. Oblicz odległość w terenie w m.",
      instructionPl: messages.kid.lessonCalculationInstruction,
    });
  });

  it("keeps invalid calculation records available for individual rejection, alongside valid exercises", () => {
    const invalid = { ...raw, calculation: { ...raw.calculation, kind: "unknown" } };
    const exercises = materializeGeneratedCalculations([invalid, raw, { exerciseType: "lesson_gap", answer: "mapa" }]);
    expect(exercises).toHaveLength(3);
    expect(exercises[1]).toMatchObject({ answer: "750 m" });
    expect(exercises[2]).toEqual({ exerciseType: "lesson_gap", answer: "mapa" });
  });

  it("forces malformed parameters with an injected answer through individual shape rejection", () => {
    const exercises = materializeGeneratedCalculations([{ ...raw, answer: "750 m", calculation: {
      kind: "unit_conversion", params: null, unit: "m", templateFamilyId: "conversion",
    } }, raw]);
    expect(exercises).toHaveLength(2);
    expect(isWellShapedRawExercise(exercises[0])).toBe(false);
    expect(isWellShapedRawExercise(exercises[1])).toBe(true);
  });
});
