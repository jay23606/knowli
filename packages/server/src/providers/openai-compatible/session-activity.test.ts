import { describe, expect, it } from "vitest";
import { createOpenAiCompatibleSessionActivityReviewer } from "./session-activity";
import type { SessionActivityReviewTask } from "../../ports/ai";
import type { UsageRecorder } from "../../ports/usage";
import { createTestRecorder, createThrowingRecorder } from "../usage/test-recorder";

describe("safe session activity provider diagnostics", () => {
  it.each([
    { status: 429, body: "private-child-answer secret-token", failureKind: "http_error", httpStatus: 429 },
    { status: 200, body: "private-child-answer secret-token", failureKind: "invalid_response", httpStatus: undefined },
    { status: 200, body: JSON.stringify({ choices: [] }), failureKind: "missing_content", httpStatus: undefined },
    { status: 200, body: JSON.stringify({ choices: [{ message: { content: "private-child-answer secret-token" } }] }), failureKind: "invalid_json", httpStatus: undefined },
  ])("classifies $failureKind without leaking the response", async ({ status, body, failureKind, httpStatus }) => {
    const reviewer = createOpenAiCompatibleSessionActivityReviewer({
      baseUrl: "https://test.invalid/v1", apiKey: "secret-token", model: "fake",
      fetchImpl: async () => new Response(body, { status }),
    });
    const error = await reviewer.review({ tasks: [] }, new AbortController().signal).catch((error: unknown) => error);
    expect(error).toMatchObject({ name: "SessionActivityProviderError", failureKind, httpStatus });
    expect(String(error)).not.toContain("private-child-answer");
    expect(String(error)).not.toContain("secret-token");
    expect(JSON.stringify(error)).not.toContain("private-child-answer");
  });
});

/**
 * Adapter oceny aktywności sesji (spec client-reward-time). Wzorzec grader.test.ts:
 * wstrzyknięty `fetch`; poprawny JSON i JSON w płotku ```json; brak `choices` →
 * błąd; HTTP !ok → błąd BEZ treści odpowiedzi w komunikacie; abort przez signal;
 * kształt żądania (temperature 0, response_format json_object, system+user,
 * przekazany signal); odpowiedzi dziecka tylko w wiadomości `user`.
 */

const tasks: SessionActivityReviewTask[] = [
  {
    taskOrdinal: 0,
    instruction: "Przypomnij angielskie słowo",
    stimulus: "kot",
    options: [],
    acceptedAnswers: ["cat"],
    submittedAnswers: [{ modality: "text", text: "cat", uncertain: false, supportDisclosedBefore: false }],
    editCount: 3,
    editWindows: [{ atMs: 1_000, count: 3 }],
    playbacks: [],
    pauses: [],
    activeIntervals: [[0, 30_000]],
  },
  {
    taskOrdinal: 1,
    instruction: "Zapisz angielskie słowo",
    stimulus: "pies",
    options: [],
    acceptedAnswers: ["dog"],
    submittedAnswers: [{ modality: "text", text: "aaa", uncertain: false, supportDisclosedBefore: false }],
    editCount: 0,
    editWindows: [],
    playbacks: [],
    pauses: [],
    activeIntervals: [[30_000, 60_000]],
  },
];

interface CapturedRequest {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal };
}

function capturingFetch(response: () => Response): {
  fetchImpl: (url: string, init: CapturedRequest["init"]) => Promise<Response>;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response();
    },
  };
}

function chatResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const VALID_JSON = JSON.stringify({
  reason: "Jedno zadanie bez rzeczywistej próby.",
  excludedTasks: [{ taskOrdinal: 1, reason: "Jedyna odpowiedź to aaa." }],
});

describe("createOpenAiCompatibleSessionActivityReviewer", () => {
  it("zwraca surowy obiekt dla poprawnego JSON", async () => {
    const { fetchImpl } = capturingFetch(() => chatResponse(VALID_JSON));
    const reviewer = createOpenAiCompatibleSessionActivityReviewer({ baseUrl: "https://g.example/v1", apiKey: "secret-token", model: "cheap-1", fetchImpl });
    const raw = await reviewer.review({ tasks }, AbortSignal.timeout(1000));
    expect(raw).toEqual({
      reason: "Jedno zadanie bez rzeczywistej próby.",
      excludedTasks: [{ taskOrdinal: 1, reason: "Jedyna odpowiedź to aaa." }],
    });
  });

  it("wyciąga JSON z bloku markdown", async () => {
    const fenced = "```json\n" + VALID_JSON + "\n```";
    const { fetchImpl } = capturingFetch(() => chatResponse(fenced));
    const reviewer = createOpenAiCompatibleSessionActivityReviewer({ baseUrl: "https://g.example/v1", apiKey: "t", model: "m", fetchImpl });
    const raw = (await reviewer.review({ tasks }, AbortSignal.timeout(1000))) as { reason: string };
    expect(raw.reason).toBe("Jedno zadanie bez rzeczywistej próby.");
  });

  it("żądanie niesie temperature 0, response_format json_object, Bearer, system+user i przekazany signal", async () => {
    const { fetchImpl, calls } = capturingFetch(() => chatResponse(VALID_JSON));
    const reviewer = createOpenAiCompatibleSessionActivityReviewer({ baseUrl: "https://g.example/v1", apiKey: "secret-token", model: "cheap-1", fetchImpl });
    const signal = AbortSignal.timeout(1000);
    await reviewer.review({ tasks }, signal);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://g.example/v1/chat/completions");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers.authorization ?? call.init.headers.Authorization).toBe("Bearer secret-token");
    expect(call.init.signal).toBe(signal);
    const body = JSON.parse(call.init.body) as {
      model: string;
      temperature: number;
      response_format: { type: string };
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe("cheap-1");
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: "json_object" });
    const system = body.messages.find((m) => m.role === "system")!;
    const user = body.messages.find((m) => m.role === "user")!;
    expect(system.content.length).toBeGreaterThan(0);
    // Odpowiedzi dziecka tylko w wiadomości user; token nigdy w treści promptu.
    expect(system.content).not.toContain("aaa");
    expect(system.content).not.toContain("secret-token");
    expect(user.content).toContain("aaa");
    expect(user.content).toContain("cat");
    expect(user.content).not.toContain("secret-token");
    // Dane zadań trafiają do wiadomości user jako odgrodzony JSON.
    expect(user.content).toContain("```json");
  });

  it("brak choices → wyjątek bez tokenu i bez odpowiedzi dziecka", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "content-type": "application/json" } });
    const reviewer = createOpenAiCompatibleSessionActivityReviewer({ baseUrl: "https://g.example/v1", apiKey: "secret-token", model: "m", fetchImpl });
    await reviewer.review({ tasks }, AbortSignal.timeout(1000)).then(
      () => {
        throw new Error("oczekiwano wyjątku");
      },
      (error: unknown) => {
        const message = String((error as Error).message);
        expect(message).not.toContain("secret-token");
        expect(message).not.toContain("aaa");
      },
    );
  });

  it("HTTP !ok → wyjątek BEZ treści odpowiedzi w komunikacie", async () => {
    const leaking = new Response(JSON.stringify({ error: { echo: "aaa secret-token" } }), { status: 429, headers: { "content-type": "application/json" } });
    const fetchImpl = async () => leaking;
    const reviewer = createOpenAiCompatibleSessionActivityReviewer({ baseUrl: "https://g.example/v1", apiKey: "secret-token", model: "m", fetchImpl });
    await expect(reviewer.review({ tasks }, AbortSignal.timeout(1000))).rejects.toSatisfy(
      (error: unknown) => {
        const message = String((error as Error).message);
        return !message.includes("secret-token") && !message.includes("aaa") && message.includes("429");
      },
    );
  });

  it("przekazuje AbortSignal do fetch (abort kończy się wyjątkiem)", async () => {
    const fetchImpl = async (_url: string, init: CapturedRequest["init"]) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const reviewer = createOpenAiCompatibleSessionActivityReviewer({ baseUrl: "https://g.example/v1", apiKey: "t", model: "m", fetchImpl });
    await expect(reviewer.review({ tasks }, AbortSignal.timeout(10))).rejects.toThrow();
  });

  it("promptVersion jest stałą adaptera", () => {
    const reviewer = createOpenAiCompatibleSessionActivityReviewer({ baseUrl: "https://g.example/v1", apiKey: "t", model: "m" });
    expect(typeof reviewer.promptVersion).toBe("string");
    expect(reviewer.promptVersion.length).toBeGreaterThan(0);
  });
});

describe("createOpenAiCompatibleSessionActivityReviewer — zapis kosztów (usage)", () => {
  const COST = { prompt_tokens: 50, completion_tokens: 20, cost: 0.0012 };
  const make = (fetchImpl: (url: string, init: CapturedRequest["init"]) => Promise<Response>, usage?: UsageRecorder) =>
    createOpenAiCompatibleSessionActivityReviewer({
      baseUrl: "https://openrouter.ai/api/v1", apiKey: "secret-token", model: "google/gemini-3.8-flash", fetchImpl,
      ...(usage ? { usage } : {}),
    });
  const review = (reviewer: ReturnType<typeof make>, signal: AbortSignal = AbortSignal.timeout(1000)) => reviewer.review({ tasks }, signal);
  const withUsage = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: COST }), { status: 200 });

  it("records paid response even when content is not JSON", async () => {
    const rec = createTestRecorder();
    await expect(review(make(async () => withUsage("not json"), rec))).rejects.toMatchObject({ failureKind: "invalid_json" });
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toEqual({
      feature: "session_activity_review", operation: "review", provider: "openrouter", model: "google/gemini-3.8-flash",
      outcome: "ok", httpStatus: 200, inputTokens: 50, outputTokens: 20, providerCostUsd: 0.0012,
    });
  });

  it("records paid response even when content is missing", async () => {
    const rec = createTestRecorder();
    const fetchImpl = async () => new Response(JSON.stringify({ choices: [], usage: COST }), { status: 200 });
    await expect(review(make(fetchImpl, rec))).rejects.toMatchObject({ failureKind: "missing_content" });
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "ok", providerCostUsd: 0.0012 });
  });

  it("records ok for a valid verdict", async () => {
    const rec = createTestRecorder();
    await review(make(async () => withUsage(VALID_JSON), rec));
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "ok", providerCostUsd: 0.0012 });
  });

  it("records one failed event with httpStatus for HTTP 500 and keeps the error", async () => {
    const rec = createTestRecorder();
    await expect(review(make(async () => new Response("private-child-answer", { status: 500 }), rec)))
      .rejects.toMatchObject({ failureKind: "http_error", httpStatus: 500 });
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toEqual({
      feature: "session_activity_review", operation: "review", provider: "openrouter", model: "google/gemini-3.8-flash",
      outcome: "failed", httpStatus: 500,
    });
  });

  it("records one failed event with httpStatus 200 when the body is unreadable", async () => {
    const rec = createTestRecorder();
    await expect(review(make(async () => new Response("<html>", { status: 200 }), rec)))
      .rejects.toMatchObject({ failureKind: "invalid_response" });
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "failed", httpStatus: 200 });
    expect(rec.events[0]).not.toHaveProperty("providerCostUsd");
  });

  it("records one failed event when the abort happens while reading the body", async () => {
    const rec = createTestRecorder();
    const controller = new AbortController();
    const abortError = new DOMException("aborted", "AbortError");
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => { controller.abort(); throw abortError; },
    }) as unknown as Response;
    await expect(review(make(fetchImpl, rec), controller.signal)).rejects.toBe(abortError);
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "failed" });
  });

  it("records one failed event without httpStatus on abort before the response and rethrows the original", async () => {
    const rec = createTestRecorder();
    const abortError = new DOMException("aborted", "AbortError");
    await expect(review(make(async () => { throw abortError; }, rec), AbortSignal.abort())).rejects.toBe(abortError);
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "failed" });
    expect(rec.events[0]).not.toHaveProperty("httpStatus");
  });

  it("records one failed event on a network error", async () => {
    const rec = createTestRecorder();
    await expect(review(make(async () => { throw new TypeError("fetch failed"); }, rec))).rejects.toThrow("fetch failed");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).not.toHaveProperty("httpStatus");
  });

  it("throwing recorder does not change adapter result", async () => {
    const plain = await review(make(async () => withUsage(VALID_JSON)));
    expect(await review(make(async () => withUsage(VALID_JSON), createThrowingRecorder()))).toEqual(plain);
    await expect(review(make(async () => new Response("x", { status: 500 }), createThrowingRecorder())))
      .rejects.toMatchObject({ failureKind: "http_error", httpStatus: 500 });
  });

  it("without usage the request is made and nothing changes", async () => {
    const { fetchImpl, calls } = capturingFetch(() => chatResponse(VALID_JSON));
    await expect(review(make(fetchImpl))).resolves.toMatchObject({ reason: expect.any(String) });
    expect(calls).toHaveLength(1);
  });
});
