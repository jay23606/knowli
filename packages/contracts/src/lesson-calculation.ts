import { z } from "zod";

export const LengthUnitSchema = z.enum(["cm", "m", "km"]);
export type LengthUnit = z.infer<typeof LengthUnitSchema>;

/** Największa wartość bezwzględna parametru rachunku. */
export const MAX_CALCULATION_PARAMETER = 1000000;
/** Najwięcej miejsc dziesiętnych parametru rachunku. */
export const MAX_CALCULATION_DECIMALS = 3;
/** Największy mianownik skali mapy. */
export const MAX_SCALE_DENOMINATOR = 1000000000;
/** Najdłuższy identyfikator rodziny szablonu rachunku (`templateFamilyId`). */
export const MAX_TEMPLATE_FAMILY_ID_LENGTH = 64;

// Check decimal precision from the JSON number's decimal representation, not
// floating-point multiplication (e.g. 1.001 * 1000 is not an integer in JS).
const parameter = z.number().finite().min(-MAX_CALCULATION_PARAMETER).max(MAX_CALCULATION_PARAMETER).refine((value) => {
  const [coefficient, exponent = "0"] = String(value).toLowerCase().split("e");
  const decimals = coefficient.split(".")[1]?.length ?? 0;
  return decimals - Number(exponent) <= MAX_CALCULATION_DECIMALS;
}, `Parametr może mieć najwyżej ${MAX_CALCULATION_DECIMALS} miejsca dziesiętne.`);
const nonnegativeParameter = parameter.refine((value) => value >= 0, "Wartość nie może być ujemna.");

const common = {
  unit: LengthUnitSchema,
  tolerance: z.number().finite().nonnegative().optional(),
  templateFamilyId: z.string().min(1).max(MAX_TEMPLATE_FAMILY_ID_LENGTH).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
};

/** Shape and local bounds only; exact relational tolerance belongs to the domain. */
export const CalculationSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    ...common,
    kind: z.literal("scale_distance"),
    params: z.object({
      scaleDenominator: z.number().int().min(1).max(MAX_SCALE_DENOMINATOR),
      mapDistanceCm: nonnegativeParameter,
    }).strict(),
  }).strict(),
  z.object({
    ...common,
    kind: z.literal("height_difference"),
    params: z.object({
      upperHeightM: parameter,
      lowerHeightM: parameter,
    }).strict().refine((params) => params.upperHeightM >= params.lowerHeightM, {
      message: "Punkt wyższy nie może leżeć poniżej punktu niższego.",
      path: ["upperHeightM"],
    }),
  }).strict(),
  z.object({
    ...common,
    kind: z.literal("unit_conversion"),
    params: z.object({
      value: nonnegativeParameter,
      fromUnit: LengthUnitSchema,
    }).strict(),
  }).strict(),
]);
export type CalculationSpec = z.infer<typeof CalculationSpecSchema>;