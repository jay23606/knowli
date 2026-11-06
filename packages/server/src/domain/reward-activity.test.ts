import { describe, expect, it } from "vitest";
import { validRewardTimezone } from "./reward-activity";

describe("reward report timezone", () => {
  it("falls back to the family default timezone for invalid values", () => {
    expect(validRewardTimezone(undefined)).toBe("Europe/Warsaw");
    expect(validRewardTimezone(42)).toBe("Europe/Warsaw");
    expect(validRewardTimezone("Not/AZone")).toBe("Europe/Warsaw");
    expect(validRewardTimezone("Europe/Warsaw")).toBe("Europe/Warsaw");
  });
});
