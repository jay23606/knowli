import { describe, expect, it } from "vitest";
import { exerciseFingerprint } from "./lesson-fingerprint";

describe("exerciseFingerprint", () => {
  it("nie zależy od kolejności kluczy (także zagnieżdżonych) ani od pól undefined; przetrwa JSON jak jsonb", () => {
    const a = { b: 1, a: { y: [1, { q: 2, p: 1 }], x: "t" }, c: undefined };
    const b = { a: { x: "t", y: [1, { p: 1, q: 2 }] }, b: 1 };
    expect(exerciseFingerprint(a)).toBe(exerciseFingerprint(b));
    expect(exerciseFingerprint(JSON.parse(JSON.stringify(a)) as Record<string, unknown>)).toBe(exerciseFingerprint(a));
    expect(exerciseFingerprint({ ...b, b: 2 })).not.toBe(exerciseFingerprint(b));
    expect(exerciseFingerprint(a)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("kolejność elementów tablic ma znaczenie", () => {
    expect(exerciseFingerprint({ list: [1, 2] })).not.toBe(exerciseFingerprint({ list: [2, 1] }));
  });
});
