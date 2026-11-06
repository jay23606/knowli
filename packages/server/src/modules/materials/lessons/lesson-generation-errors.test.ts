import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError } from "../../../errors";
import { GenerationProviderError } from "../../../ports/generation-error";
import { classifyLessonGenerationFailure, lessonRetryDelayMs } from "./lesson-generation-errors";

describe("classifyLessonGenerationFailure", () => {
  it.each([
    ["configuration", "provider_configuration", false],
    ["rate_limit", "provider_rate_limit", true],
    ["transient", "provider", true],
    ["timeout", "provider_timeout", false],
    ["refusal", "provider_refusal", false],
    ["incomplete", "provider_incomplete", false],
    ["output", "provider_output", false],
  ] as const)("mapuje %s bez niebezpiecznego body", (kind, errorCode, retryable) => {
    const result = classifyLessonGenerationFailure(new GenerationProviderError(kind, { status: 429, retryAfterMs: 60_000 }));
    expect(result).toEqual(expect.objectContaining({ errorCode, retryable }));
    if (kind === "rate_limit") expect(result.retryAfterMs).toBe(60_000);
  });

  it("nie ponawia błędów walidacji domenowej", () => {
    let error: unknown;
    try { z.string().parse(1); } catch (cause) { error = cause; }
    expect(classifyLessonGenerationFailure(error)).toMatchObject({ errorCode: "validation", retryable: false });
  });

  it("błąd w kodzie (TypeError, RangeError, AppError) to błąd wewnętrzny bez ponowienia (#320)", () => {
    expect(classifyLessonGenerationFailure(new TypeError("x is undefined"))).toEqual({ errorCode: "internal", retryable: false });
    expect(classifyLessonGenerationFailure(new RangeError("bad length"))).toEqual({ errorCode: "internal", retryable: false });
    expect(classifyLessonGenerationFailure(new AppError("internal"))).toEqual({ errorCode: "internal", retryable: false });
  });

  it("przejściowy błąd bazy (pole code) pozostaje ponawiany", () => {
    const pgError = Object.assign(new Error("terminating connection"), { code: "57P01" });
    expect(classifyLessonGenerationFailure(pgError)).toEqual({ errorCode: "provider", retryable: true });
    expect(classifyLessonGenerationFailure(Object.assign(new Error("x"), { retryable: false }))).toEqual({ errorCode: "provider", retryable: false });
  });
});

describe("lessonRetryDelayMs", () => {
  it("stosuje wykładniczy backoff z jitterem i nie skraca Retry-After", () => {
    expect(lessonRetryDelayMs(1, undefined, () => 0)).toBe(1_000);
    expect(lessonRetryDelayMs(2, undefined, () => 1)).toBe(2_400);
    expect(lessonRetryDelayMs(2, 60_000, () => 0)).toBe(60_000);
  });
});
