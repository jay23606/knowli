import { describe, expect, it } from "vitest";
import {
  recordHttpError,
  recordResponse,
  recordTransportFailure,
  recordUnreadable,
} from "./record-http";
import { createTestRecorder, createThrowingRecorder } from "./test-recorder";

const base = { feature: "answer_grading", operation: "grade", provider: "openrouter", model: "m-1" } as const;

describe("record-http", () => {
  it("recordResponse zapisuje ok z tokenami i kosztem z payloadu", () => {
    const rec = createTestRecorder();
    recordResponse(rec, base, 200, { usage: { prompt_tokens: 7, completion_tokens: 3, cost: 0.002 } });
    expect(rec.events).toEqual([
      { ...base, outcome: "ok", httpStatus: 200, inputTokens: 7, outputTokens: 3, providerCostUsd: 0.002 },
    ]);
  });

  it("recordResponse bez usage w payloadzie zapisuje ok bez liczb", () => {
    const rec = createTestRecorder();
    recordResponse(rec, base, 200, { choices: [] });
    expect(rec.events).toEqual([{ ...base, outcome: "ok", httpStatus: 200 }]);
  });

  it("recordUnreadable i recordHttpError zapisują failed z kodem HTTP, bez kosztu", () => {
    const rec = createTestRecorder();
    recordUnreadable(rec, base, 200);
    recordHttpError(rec, base, 500);
    expect(rec.events).toEqual([
      { ...base, outcome: "failed", httpStatus: 200 },
      { ...base, outcome: "failed", httpStatus: 500 },
    ]);
  });

  it("recordTransportFailure zapisuje failed bez kodu HTTP", () => {
    const rec = createTestRecorder();
    recordTransportFailure(rec, base);
    expect(rec.events).toEqual([{ ...base, outcome: "failed" }]);
    expect("httpStatus" in rec.events[0]!).toBe(false);
  });

  it("bez recordera nic nie robi, a rzucający recorder nie przerywa wywołującego", () => {
    expect(() => recordResponse(undefined, base, 200, {})).not.toThrow();
    expect(() => recordTransportFailure(undefined, base)).not.toThrow();
    const throwing = createThrowingRecorder();
    expect(() => recordResponse(throwing, base, 200, {})).not.toThrow();
    expect(() => recordUnreadable(throwing, base, 200)).not.toThrow();
    expect(() => recordHttpError(throwing, base, 500)).not.toThrow();
    expect(() => recordTransportFailure(throwing, base)).not.toThrow();
  });
});
