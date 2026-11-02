import { describe, expect, it } from "vitest";
import { compareMoney, currentMonth, formatUnits, formatUsd, monthLabel, pluralForm, shiftMonth } from "./cost-format";

const NBSP = " ";
const EMPTY = { inputTokens: 0, outputTokens: 0, characters: 0, audioMs: 0, images: 0 };

describe("formatUsd", () => {
  it("rounds half up to cents without floats", () => {
    expect(formatUsd("4.123456")).toBe("4,12 USD");
    expect(formatUsd("0.005000")).toBe("0,01 USD");
    expect(formatUsd("0.004999")).toBe("< 0,01 USD");
    expect(formatUsd("1.995000")).toBe("2,00 USD");
    // wartość nieosiągalna dla Number: 17 cyfr znaczących
    expect(formatUsd("123456789012.345000")).toBe(`123${NBSP}456${NBSP}789${NBSP}012,35 USD`);
  });

  it("marks positive amounts below one cent and shows zero", () => {
    expect(formatUsd("0.004000")).toBe("< 0,01 USD");
    expect(formatUsd("0.000001")).toBe("< 0,01 USD");
    expect(formatUsd("0.000000")).toBe("0,00 USD");
  });

  it("groups thousands with a non-breaking space", () => {
    expect(formatUsd("1234.505000")).toBe(`1${NBSP}234,51 USD`);
    expect(formatUsd("999.994999")).toBe("999,99 USD");
  });
});

describe("formatUnits", () => {
  it("chat features show input plus output tokens", () => {
    expect(formatUnits("deck_generation", { ...EMPTY, inputTokens: 900_000, outputTokens: 300_000 })).toBe("1,2 mln tokenów");
    expect(formatUnits("answer_grading", { ...EMPTY, inputTokens: 4000, outputTokens: 300 })).toBe(`4${NBSP}300 tokenów`);
    expect(formatUnits("lesson_generation", { ...EMPTY, inputTokens: 1_000_000 })).toBe("1 mln tokenów");
    expect(formatUnits("session_activity_review", { ...EMPTY, inputTokens: 1 })).toBe("1 token");
  });

  it("audio features show minutes of audio", () => {
    expect(formatUnits("speech_stt", { ...EMPTY, audioMs: 38 * 60_000 })).toBe("38 min audio");
    expect(formatUnits("tts", { ...EMPTY, audioMs: 10_000 })).toBe("< 1 min audio");
    expect(formatUnits("pronunciation", { ...EMPTY, audioMs: 0 })).toBe("0 min audio");
    expect(formatUnits("lesson_stt", { ...EMPTY, audioMs: 90_000 })).toBe("2 min audio");
  });

  it("tts without audio length falls back to characters", () => {
    expect(formatUnits("tts", { ...EMPTY, characters: 4300 })).toBe(`4${NBSP}300 znaków`);
    expect(formatUnits("tts", { ...EMPTY, characters: 1 })).toBe("1 znak");
  });

  it("image features use Polish plural forms", () => {
    expect(formatUnits("illustration", { ...EMPTY, images: 1 })).toBe("1 obraz");
    expect(formatUnits("deck_cover", { ...EMPTY, images: 3 })).toBe("3 obrazy");
    expect(formatUnits("illustration", { ...EMPTY, images: 5 })).toBe("5 obrazów");
    expect(formatUnits("illustration", { ...EMPTY, images: 12 })).toBe("12 obrazów");
    expect(formatUnits("illustration", { ...EMPTY, images: 22 })).toBe("22 obrazy");
  });
});

describe("months", () => {
  it("shifts across year boundaries", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2025-12", 1)).toBe("2026-01");
    expect(shiftMonth("2026-11", -1)).toBe("2026-10");
  });

  it("labels a month in Polish with a capital letter", () => {
    expect(monthLabel("2026-11")).toBe("Listopad 2026");
    expect(monthLabel("2026-01")).toBe("Styczeń 2026");
  });

  it("reads the current month from the local date", () => {
    expect(currentMonth(new Date(2026, 10, 15, 12))).toBe("2026-11");
    expect(currentMonth(new Date(2026, 0, 1, 0, 5))).toBe("2026-01");
  });
});

describe("pluralForm and compareMoney", () => {
  it("picks Polish plural forms", () => {
    const forms = ["wywołanie", "wywołania", "wywołań"] as const;
    expect([1, 2, 4, 5, 12, 22, 0].map((n) => pluralForm(n, forms)))
      .toEqual(["wywołanie", "wywołania", "wywołania", "wywołań", "wywołań", "wywołania", "wywołań"]);
  });

  it("compares amounts without floats", () => {
    expect(compareMoney("0.000001", "0.000000")).toBe(1);
    expect(compareMoney("2.500000", "10.000000")).toBe(-1);
    expect(compareMoney("1.000000", "1.000000")).toBe(0);
  });
});
