import { describe, expect, it } from "vitest";

import { bePolarityViolations, expectedBeFormNearGap } from "./be-agreement";

describe("be-agreement", () => {
  it("expectedBeFormNearGap dla podmiotów PC (bodziec po usunięciu nawiasu)", () => {
    expect(expectedBeFormNearGap("Łucja ___ a book now.")).toBe("is");
    expect(expectedBeFormNearGap("James ___ a book now.")).toBe("is");
    expect(expectedBeFormNearGap("The children ___ football now.")).toBe("are");
    expect(expectedBeFormNearGap("The mice ___ cheese now.")).toBe("are");
    expect(expectedBeFormNearGap("Tom and Ola ___ now.")).toBe("are");
    expect(expectedBeFormNearGap("They always ___ football now.")).toBe("are");
    expect(expectedBeFormNearGap("Every day Ola ___ a comic.")).toBe("is");
    expect(expectedBeFormNearGap("What ___ they doing?")).toBe("are");
  });

  it("bePolarityViolations: twierdzenie z przeczeniem, przeczenie bez not i Yes z przeczeniem", () => {
    expect(bePolarityViolations("affirmative", true, undefined)).toEqual(["negated"]);
    expect(bePolarityViolations("negative", false, undefined)).toEqual(["not_negated"]);
    expect(bePolarityViolations("any", true, "yes")).toEqual(["yes_negative"]);
    expect(bePolarityViolations("any", false, "no")).toEqual(["no_affirmative"]);
  });

  it("bePolarityViolations: dowolna biegunowość bez Yes/No nie zgłasza błędu", () => {
    expect(bePolarityViolations("any", true, undefined)).toEqual([]);
    expect(bePolarityViolations("any", false, undefined)).toEqual([]);
  });
});
