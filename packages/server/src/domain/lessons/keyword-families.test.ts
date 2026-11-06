import { describe, expect, it } from "vitest";
import { familyBase, familyRunSuffix } from "./keyword-families";

describe("familyRunSuffix i familyBase (slug rodziny bez sufiksu runu)", () => {
  const scope = "A1b2-C3d4:9f8e7d6c-0000:3:0";

  it("sufiks: „-r” i 6 pierwszych znaków szesnastkowych zakresu małymi literami", () => {
    expect(familyRunSuffix(scope)).toBe("-ra1b2c3");
    expect(familyRunSuffix("xyz")).toBe("-r");
  });

  it("zdejmuje sufiks znanego zakresu", () => {
    expect(familyBase(`foto-def${familyRunSuffix(scope)}`, scope)).toBe("foto-def");
  });

  it("bez zakresu (`null`) slug bez zmian", () => {
    expect(familyBase(`foto-def${familyRunSuffix(scope)}`, null)).toBe(`foto-def${familyRunSuffix(scope)}`);
  });

  it("slug bez sufiksu albo z sufiksem innego zakresu bez zmian", () => {
    expect(familyBase("foto-def", scope)).toBe("foto-def");
    expect(familyBase("foto-def-rffffff", scope)).toBe("foto-def-rffffff");
  });
});
