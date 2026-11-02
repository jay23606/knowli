import { describe, expect, it } from "vitest";
import { USAGE_FEATURES, UsageFeatureSchema } from "./usage-features";

describe("UsageFeatureSchema", () => {
  it("akceptuje wszystkie dziesięć funkcji", () => {
    expect(USAGE_FEATURES).toHaveLength(10);
    for (const feature of USAGE_FEATURES) expect(UsageFeatureSchema.parse(feature)).toBe(feature);
  });

  it("odrzuca nieznaną funkcję", () => {
    expect(UsageFeatureSchema.safeParse("other").success).toBe(false);
  });
});
