import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiImageProvider } from "./openai";
import { createTestRecorder, createThrowingRecorder } from "../usage/test-recorder";

function okResponse(b64: string) {
  return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 });
}

const REQUEST = {
  prompt: "Simple child-friendly illustration of \"apple\" (jabłko). No text in the image.",
  model: "gpt-image-1-mini",
  size: "1024x1024",
  quality: "low",
  format: "webp",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createOpenAiImageProvider", () => {
  it("używa Sunbursta jako modelu awaryjnego adaptera", () => {
    const provider = createOpenAiImageProvider({ apiKey: "test-key" });
    expect(provider.model).toBe("gpt-image-2.5-sunburst");
  });

  it("wysyła model, jakość i output_format z żądania i zwraca webp", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      okResponse(Buffer.from("webp-bytes").toString("base64")),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAiImageProvider({ apiKey: "test-key" });
    const result = await provider.generate(REQUEST);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/v1/images/generations");
    expect(init!.headers).toMatchObject({ authorization: "Bearer test-key" });
    expect(JSON.parse(init!.body as string)).toEqual({
      model: "gpt-image-1-mini",
      prompt: REQUEST.prompt,
      size: "1024x1024",
      quality: "low",
      output_format: "webp",
    });
    expect(Array.from(result.bytes)).toEqual(Array.from(Buffer.from("webp-bytes")));
    expect(result.mimeType).toBe("image/webp");
  });

  it("zwraca image/png dla formatu png", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(Buffer.from("png").toString("base64"))));
    const provider = createOpenAiImageProvider({ apiKey: "k" });
    const result = await provider.generate({ ...REQUEST, format: "png" });
    expect(result.mimeType).toBe("image/png");
  });

  it("nie przekazuje body dostawcy w błędzie HTTP", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("credit_balance_exhausted", { status: 400 })),
    );
    const provider = createOpenAiImageProvider({ apiKey: "k" });
    const failure = provider.generate(REQUEST);
    await expect(failure).rejects.toThrow(/400/);
    await expect(failure).rejects.not.toThrow(/credit_balance_exhausted/);
  });
});

describe("createOpenAiImageProvider — zapis kosztów", () => {
  const b64 = Buffer.from("img").toString("base64");

  it("jeden b64_json: event ok z images 1 i tokenami z usage, feature illustration", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: b64 }], usage: { input_tokens: 40, output_tokens: 1056 } }), { status: 200 })));
    const rec = createTestRecorder();
    const provider = createOpenAiImageProvider({ apiKey: "k", usage: rec });
    await provider.generate(REQUEST);
    expect(rec.events).toEqual([
      { feature: "illustration", provider: "openai", model: "gpt-image-1-mini", outcome: "ok", httpStatus: 200, images: 1, inputTokens: 40, outputTokens: 1056 },
    ]);
  });

  it("bez usage w odpowiedzi: tylko images", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(b64)));
    const rec = createTestRecorder();
    await createOpenAiImageProvider({ apiKey: "k", usage: rec }).generate(REQUEST);
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "ok", images: 1 });
    expect(rec.events[0]!.inputTokens).toBeUndefined();
  });

  it("opcja feature deck_cover", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(b64)));
    const rec = createTestRecorder();
    await createOpenAiImageProvider({ apiKey: "k", usage: rec, feature: "deck_cover" }).generate(REQUEST);
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ feature: "deck_cover", outcome: "ok" });
  });

  it("odpowiedź bez obrazu: event zapisany (opłacone), potem błąd", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const rec = createTestRecorder();
    await expect(createOpenAiImageProvider({ apiKey: "k", usage: rec }).generate(REQUEST)).rejects.toThrow("openai images returned no data");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "ok", images: 0 });
  });

  it("HTTP 500: jeden event failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 500 })));
    const rec = createTestRecorder();
    await expect(createOpenAiImageProvider({ apiKey: "k", usage: rec }).generate(REQUEST)).rejects.toThrow("provider_http_500");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "failed", httpStatus: 500 });
  });

  it("abort: jeden event failed bez kodu", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("aborted", "AbortError"); }));
    const rec = createTestRecorder();
    await expect(createOpenAiImageProvider({ apiKey: "k", usage: rec }).generate(REQUEST)).rejects.toThrow("aborted");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "failed" });
    expect(rec.events[0]!.httpStatus).toBeUndefined();
  });

  it("nieczytelne ciało 2xx: jeden event failed z kodem 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
    const rec = createTestRecorder();
    await expect(createOpenAiImageProvider({ apiKey: "k", usage: rec }).generate(REQUEST)).rejects.toThrow();
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "failed", httpStatus: 200 });
  });

  it("recorder, który rzuca, nie zmienia wyniku; bez recordera działa jak dotąd", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(b64)));
    await expect(createOpenAiImageProvider({ apiKey: "k", usage: createThrowingRecorder() }).generate(REQUEST)).resolves.toMatchObject({ mimeType: "image/webp" });
    await expect(createOpenAiImageProvider({ apiKey: "k" }).generate(REQUEST)).resolves.toMatchObject({ mimeType: "image/webp" });
  });
});
