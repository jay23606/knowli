import { describe, expect, it } from "vitest";
import { createOpenAiCompatibleGrader } from "./grader";
import type { GraderInput } from "../../ports/ai";
import type { UsageRecorder } from "../../ports/usage";
import { createTestRecorder, createThrowingRecorder } from "../usage/test-recorder";

/**
 * Adapter modelu oceniającego (design „Model oceniający”). Testy z wstrzykniętym
 * `fetch`: poprawny JSON; JSON w bloku markdown; brak `choices`; HTTP 429/500;
 * timeout (AbortSignal); kształt żądania (temperature 0, response_format, nagłówek
 * autoryzacji, odpowiedź dziecka tylko w wiadomości `user`); brak tokenu i treści
 * odpowiedzi dziecka w komunikatach błędów.
 */

const input: GraderInput = {
  subjectTitle: "Angielski — gramatyka",
  topicTitle: "Present Simple",
  roleProfile: {
    gradingRole: "You grade ONLY whether the child applied the rule.",
    almostDefinition: "Return 'almost' when the rule is applied with a minor typo elsewhere.",
  },
  instruction: "Uzupełnij zdanie.",
  stimulus: "He ___ (play) football.",
  objective: {
    description: "Third person singular -s in Present Simple.",
    errorCategories: [{ code: "missing_s", label: "Brak -s" }],
  },
  acceptedAnswers: ["he plays", "plays"],
  childAnswer: "he play",
};

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
  verdict: "incorrect",
  errorCategory: "missing_s",
  fragments: ["play"],
  note: "Brakuje końcówki -s.",
});

describe("createOpenAiCompatibleGrader", () => {
  it("zwraca surowy obiekt dla poprawnego JSON", async () => {
    const { fetchImpl } = capturingFetch(() => chatResponse(VALID_JSON));
    const grader = createOpenAiCompatibleGrader({ baseUrl: "https://g.example/v1", apiKey: "secret-token", model: "cheap-1", fetchImpl });
    const raw = await grader.grade(input, AbortSignal.timeout(1000));
    expect(raw).toEqual({ verdict: "incorrect", errorCategory: "missing_s", fragments: ["play"], note: "Brakuje końcówki -s." });
  });

  it("dokłada opcje pośrednika z konfiguracji, ale nie pozwala im nadpisać modelu ani formatu", async () => {
    const { fetchImpl, calls } = capturingFetch(() => chatResponse(VALID_JSON));
    const grader = createOpenAiCompatibleGrader({
      baseUrl: "https://g.example/v1", apiKey: "t", model: "cheap-1", fetchImpl,
      requestExtras: { reasoning: { effort: "low" }, provider: { data_collection: "deny", require_parameters: true }, model: "other" },
    });
    await grader.grade(input, AbortSignal.timeout(1000));
    const body = JSON.parse(calls[0]!.init.body) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "cheap-1", reasoning: { effort: "low" }, provider: { data_collection: "deny", require_parameters: true } });
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("wyciąga JSON z bloku markdown", async () => {
    const fenced = "```json\n" + VALID_JSON + "\n```";
    const { fetchImpl } = capturingFetch(() => chatResponse(fenced));
    const grader = createOpenAiCompatibleGrader({ baseUrl: "https://g.example/v1", apiKey: "t", model: "m", fetchImpl });
    const raw = (await grader.grade(input, AbortSignal.timeout(1000))) as { verdict: string };
    expect(raw.verdict).toBe("incorrect");
  });

  it("żądanie niesie temperature 0, response_format json_object i Bearer; odpowiedź dziecka tylko w user", async () => {
    const { fetchImpl, calls } = capturingFetch(() => chatResponse(VALID_JSON));
    const grader = createOpenAiCompatibleGrader({ baseUrl: "https://g.example/v1", apiKey: "secret-token", model: "cheap-1", fetchImpl });
    await grader.grade(input, AbortSignal.timeout(1000));
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://g.example/v1/chat/completions");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers.authorization ?? call.init.headers.Authorization).toBe("Bearer secret-token");
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
    expect(system.content).not.toContain("he play");
    expect(user.content).toContain("he play");
    // token nigdy w treści promptu
    expect(system.content).not.toContain("secret-token");
    expect(user.content).not.toContain("secret-token");
  });

  it("brak choices → wyjątek bez tokenu i bez odpowiedzi dziecka", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "content-type": "application/json" } });
    const grader = createOpenAiCompatibleGrader({ baseUrl: "https://g.example/v1", apiKey: "secret-token", model: "m", fetchImpl });
    await grader.grade(input, AbortSignal.timeout(1000)).then(
      () => {
        throw new Error("oczekiwano wyjątku");
      },
      (error: unknown) => {
        const message = String((error as Error).message);
        expect(message).not.toContain("secret-token");
        expect(message).not.toContain("he play");
      },
    );
  });

  it("HTTP 429 → wyjątek bez tokenu", async () => {
    const fetchImpl = async () => chatResponse("", 429);
    const grader = createOpenAiCompatibleGrader({ baseUrl: "https://g.example/v1", apiKey: "secret-token", model: "m", fetchImpl });
    await expect(grader.grade(input, AbortSignal.timeout(1000))).rejects.toSatisfy(
      (error: unknown) => !String((error as Error).message).includes("secret-token"),
    );
  });

  it("HTTP 500 → wyjątek", async () => {
    const fetchImpl = async () => chatResponse("", 500);
    const grader = createOpenAiCompatibleGrader({ baseUrl: "https://g.example/v1", apiKey: "t", model: "m", fetchImpl });
    await expect(grader.grade(input, AbortSignal.timeout(1000))).rejects.toThrow();
  });

  it("przekazuje AbortSignal do fetch (timeout kończy się wyjątkiem)", async () => {
    const fetchImpl = async (_url: string, init: CapturedRequest["init"]) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const grader = createOpenAiCompatibleGrader({ baseUrl: "https://g.example/v1", apiKey: "t", model: "m", fetchImpl });
    await expect(grader.grade(input, AbortSignal.timeout(10))).rejects.toThrow();
  });

  it("ścieżka szkolna używa werdyktu v3 z kategoriami fragmentów i pomylonymi pojęciami (design §9.1)", async () => {
    const { calls, fetchImpl } = capturingFetch(() => chatResponse(VALID_JSON));
    const grader = createOpenAiCompatibleGrader({ baseUrl: "https://g.example/v1", apiKey: "t", model: "m", fetchImpl });
    const school = {
      question: "Co to jest południk?", modelAnswer: "Linia łącząca bieguny.", requiredElements: [{ id: "e1", text: "łączy bieguny" }],
      supplementaryElements: [], commonErrors: [], expectedForm: "short", sourceQuotes: [],
    };
    expect(grader.promptVersionForInput?.({ ...input, school })).toBe("school-grader-v3");
    await grader.grade({ ...input, school }, AbortSignal.timeout(1000));
    const system = (JSON.parse(calls[0]!.init.body) as { messages: { role: string; content: string }[] }).messages[0]!.content;
    expect(system).toContain("offTopicFragments");
    expect(system).toContain("confusedConcepts");
  });

  it("promptVersion jest stałą adaptera", () => {
    const grader = createOpenAiCompatibleGrader({ baseUrl: "https://g.example/v1", apiKey: "t", model: "m" });
    expect(typeof grader.promptVersion).toBe("string");
    expect(grader.promptVersion.length).toBeGreaterThan(0);
  });
});

describe("createOpenAiCompatibleGrader — zapis kosztów (usage)", () => {
  const COST = { prompt_tokens: 30, completion_tokens: 10, cost: 0.0007 };
  const school = {
    question: "Co to jest południk?", modelAnswer: "Linia łącząca bieguny.", requiredElements: [{ id: "e1", text: "łączy bieguny" }],
    supplementaryElements: [], commonErrors: [], expectedForm: "short", sourceQuotes: [],
  };
  const make = (fetchImpl: (url: string, init: CapturedRequest["init"]) => Promise<Response>, usage?: UsageRecorder) =>
    createOpenAiCompatibleGrader({
      baseUrl: "https://openrouter.ai/api/v1", apiKey: "secret-token", model: "google/gemini-3.8-flash", fetchImpl,
      ...(usage ? { usage } : {}),
    });
  const grade = (grader: ReturnType<typeof make>, signal: AbortSignal = AbortSignal.timeout(1000), withSchool = false) =>
    grader.grade(withSchool ? { ...input, school } : input, signal);

  it("records paid response even when content is not JSON", async () => {
    const rec = createTestRecorder();
    const grader = make(async () => new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }], usage: COST }), { status: 200 }), rec);
    await expect(grade(grader)).rejects.toThrow("grader returned non-JSON content");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toEqual({
      feature: "answer_grading", operation: "grade", provider: "openrouter", model: "google/gemini-3.8-flash",
      outcome: "ok", httpStatus: 200, inputTokens: 30, outputTokens: 10, providerCostUsd: 0.0007,
    });
  });

  it("records paid response even when there are no choices", async () => {
    const rec = createTestRecorder();
    const grader = make(async () => new Response(JSON.stringify({ choices: [], usage: COST }), { status: 200 }), rec);
    await expect(grade(grader)).rejects.toThrow("grader returned no content");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "ok", providerCostUsd: 0.0007 });
  });

  it("records ok for a valid verdict", async () => {
    const rec = createTestRecorder();
    const grader = make(async () => new Response(JSON.stringify({ choices: [{ message: { content: VALID_JSON } }], usage: COST }), { status: 200 }), rec);
    await grade(grader);
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "ok", providerCostUsd: 0.0007 });
  });

  it("uses grade_school for the school path", async () => {
    const rec = createTestRecorder();
    const grader = make(async () => new Response(JSON.stringify({ choices: [{ message: { content: VALID_JSON } }], usage: COST }), { status: 200 }), rec);
    await grade(grader, undefined, true);
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ feature: "answer_grading", operation: "grade_school" });
  });

  it("records one failed event with httpStatus for HTTP 500 and keeps the error message", async () => {
    const rec = createTestRecorder();
    const grader = make(async () => new Response("private-child-answer", { status: 500 }), rec);
    await expect(grade(grader)).rejects.toThrow("grader request failed: 500");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toEqual({
      feature: "answer_grading", operation: "grade", provider: "openrouter", model: "google/gemini-3.8-flash",
      outcome: "failed", httpStatus: 500,
    });
  });

  it("records one failed event with httpStatus 200 when the body is unreadable", async () => {
    const rec = createTestRecorder();
    const grader = make(async () => new Response("<html>", { status: 200 }), rec);
    await expect(grade(grader)).rejects.toBeInstanceOf(SyntaxError);
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "failed", httpStatus: 200 });
    expect(rec.events[0]).not.toHaveProperty("providerCostUsd");
  });

  it("records one failed event without httpStatus on abort and rethrows the original error", async () => {
    const rec = createTestRecorder();
    const abortError = new DOMException("aborted", "AbortError");
    const grader = make(async () => { throw abortError; }, rec);
    await expect(grade(grader, AbortSignal.abort())).rejects.toBe(abortError);
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "failed" });
    expect(rec.events[0]).not.toHaveProperty("httpStatus");
  });

  it("records one failed event on a network error", async () => {
    const rec = createTestRecorder();
    const grader = make(async () => { throw new TypeError("fetch failed"); }, rec);
    await expect(grade(grader)).rejects.toThrow("fetch failed");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).not.toHaveProperty("httpStatus");
  });

  it("throwing recorder does not change adapter result", async () => {
    const ok = async () => new Response(JSON.stringify({ choices: [{ message: { content: VALID_JSON } }], usage: COST }), { status: 200 });
    const plain = await grade(make(ok));
    expect(await grade(make(ok, createThrowingRecorder()))).toEqual(plain);
    const failing = async () => new Response("x", { status: 500 });
    await expect(grade(make(failing, createThrowingRecorder()))).rejects.toThrow("grader request failed: 500");
  });

  it("without usage the request is made and nothing changes", async () => {
    const { fetchImpl, calls } = capturingFetch(() => chatResponse(VALID_JSON));
    await expect(grade(make(fetchImpl))).resolves.toMatchObject({ verdict: "incorrect" });
    expect(calls).toHaveLength(1);
  });
});

describe("createOpenAiCompatibleGrader — kontrola agenta puli (usageLabel i koszt runu)", () => {
  const usageLabel = { feature: "lesson_generation", operation: "check_grade" } as const;
  const make = (
    fetchImpl: (url: string, init: CapturedRequest["init"]) => Promise<Response>,
    extra: { usage?: UsageRecorder; withLabel?: boolean } = {},
  ) =>
    createOpenAiCompatibleGrader({
      baseUrl: "https://openrouter.ai/api/v1", apiKey: "secret-token", model: "google/gemini-3.8-flash", fetchImpl,
      ...(extra.usage ? { usage: extra.usage } : {}),
      ...(extra.withLabel === false ? {} : { usageLabel }),
    });
  const sink = () => {
    const recorded: (number | null)[] = [];
    return { recorded, record: (usd: number | null) => { recorded.push(usd); } };
  };
  const withUsage = (cost?: number) => new Response(
    JSON.stringify({ choices: [{ message: { content: VALID_JSON } }], usage: { prompt_tokens: 5, completion_tokens: 2, ...(cost === undefined ? {} : { cost }) } }),
    { status: 200 },
  );

  it("usageLabel zastępuje etykietę zapisu w UsageRecorder (także dla ścieżki szkolnej)", async () => {
    const rec = createTestRecorder();
    const grader = make(async () => withUsage(0.0012), { usage: rec });
    await grader.grade(input, AbortSignal.timeout(1000));
    await grader.grade({ ...input, school: {
      question: "Q?", modelAnswer: "A.", requiredElements: [{ id: "e1", text: "t" }],
      supplementaryElements: [], commonErrors: [], expectedForm: "short", sourceQuotes: [],
    } }, AbortSignal.timeout(1000));
    expect(rec.events).toHaveLength(2);
    for (const event of rec.events) expect(event).toMatchObject({ feature: "lesson_generation", operation: "check_grade", provider: "openrouter" });
  });

  it("2xx z usage.cost → cost.record(koszt) raz", async () => {
    const cost = sink();
    await make(async () => withUsage(0.0012)).grade(input, AbortSignal.timeout(1000), cost);
    expect(cost.recorded).toEqual([0.0012]);
  });

  it("2xx bez usage.cost → cost.record(null) raz", async () => {
    const cost = sink();
    await make(async () => withUsage()).grade(input, AbortSignal.timeout(1000), cost);
    expect(cost.recorded).toEqual([null]);
  });

  it("HTTP 500 → cost.record(0) raz", async () => {
    const cost = sink();
    await expect(make(async () => new Response("x", { status: 500 })).grade(input, AbortSignal.timeout(1000), cost))
      .rejects.toThrow("grader request failed: 500");
    expect(cost.recorded).toEqual([0]);
  });

  it("błąd sieci → cost.record(null) raz", async () => {
    const cost = sink();
    await expect(make(async () => { throw new TypeError("fetch failed"); }).grade(input, AbortSignal.timeout(1000), cost))
      .rejects.toThrow("fetch failed");
    expect(cost.recorded).toEqual([null]);
  });

  it("nieczytelne ciało 2xx → cost.record(null) raz", async () => {
    const cost = sink();
    await expect(make(async () => new Response("<html>", { status: 200 })).grade(input, AbortSignal.timeout(1000), cost))
      .rejects.toBeInstanceOf(SyntaxError);
    expect(cost.recorded).toEqual([null]);
  });

  it("2xx z niepoprawną treścią modelu też zgłasza koszt (płatna odpowiedź)", async () => {
    const cost = sink();
    const response = new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }], usage: { cost: 0.003 } }), { status: 200 });
    await expect(make(async () => response).grade(input, AbortSignal.timeout(1000), cost)).rejects.toThrow("non-JSON");
    expect(cost.recorded).toEqual([0.003]);
  });

  it("bez usageLabel i bez cost zachowanie jest dotychczasowe (answer_grading/grade)", async () => {
    const rec = createTestRecorder();
    const grader = make(async () => withUsage(0.0012), { usage: rec, withLabel: false });
    await expect(grader.grade(input, AbortSignal.timeout(1000))).resolves.toMatchObject({ verdict: "incorrect" });
    expect(rec.events[0]).toMatchObject({ feature: "answer_grading", operation: "grade" });
  });

  it("wyjątek z cost.record nie zmienia wyniku adaptera", async () => {
    const throwing = { record: () => { throw new Error("sink"); } };
    await expect(make(async () => withUsage(0.001)).grade(input, AbortSignal.timeout(1000), throwing))
      .resolves.toMatchObject({ verdict: "incorrect" });
  });
});
