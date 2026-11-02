import { describe, expect, it } from "vitest";
import { AppError } from "../../errors";
import { createTestRecorder, createThrowingRecorder } from "../usage/test-recorder";
import { createOpenAiCompatibleSttProvider, stripAudioEventTags } from "./stt";

type Init = { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const audio = { bytes: new Uint8Array([82, 73, 70, 70]), mimeType: "audio/wav", locale: "pl-PL" };

function recordingFetch(responses: Response[]) {
  const calls: { url: string; init: Init }[] = [];
  const fetchImpl = async (url: string, init: Init) => {
    calls.push({ url, init });
    return responses.shift() ?? jsonResponse({}, 500);
  };
  return { calls, fetchImpl };
}

describe("createOpenAiCompatibleSttProvider", () => {
  it("wysyła do OpenRouter wyłącznie audio, język i model z wymuszonym ZDR", async () => {
    const { calls, fetchImpl } = recordingFetch([
      // kształt Scribe v2 przez OpenRouter (spike 2026-10-29): verbose_json z words[].confidence
      jsonResponse({ text: "Poziomica to linia na mapie.", words: [{ word: "Poziomica", confidence: 1 }, { word: " ", type: "spacing" }, { word: "to", confidence: 0.9 }] }),
    ]);
    const provider = createOpenAiCompatibleSttProvider({ baseUrl: "https://openrouter.ai/api/v1/", apiKey: "secret", model: "elevenlabs/scribe-v2", fetchImpl });

    const result = await provider.transcribe(audio);

    expect(result).toEqual({ status: "ok", text: "Poziomica to linia na mapie.", confidence: 0.95 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(calls[0]!.init.headers.Authorization).toBe("Bearer secret");
    const body = JSON.parse(calls[0]!.init.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["input_audio", "language", "model", "provider", "response_format", "temperature", "timestamp_granularities"]);
    expect(body).toMatchObject({
      model: "elevenlabs/scribe-v2",
      language: "pl",
      input_audio: { data: Buffer.from(audio.bytes).toString("base64"), format: "wav" },
      provider: { zdr: true, data_collection: "deny" },
    });
    expect(provider.name).toBe("elevenlabs/scribe-v2");
  });

  it("poza OpenRouter nie wysyła pola provider", async () => {
    const { calls, fetchImpl } = recordingFetch([jsonResponse({ text: "Równik" })]);
    const provider = createOpenAiCompatibleSttProvider({ baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "whisper-1", fetchImpl });
    await provider.transcribe(audio);
    expect(JSON.parse(calls[0]!.init.body)).not.toHaveProperty("provider");
  });

  it("podaje confidence całej transkrypcji, gdy provider ją zwraca, a brak = null", async () => {
    const withConfidence = createOpenAiCompatibleSttProvider({
      baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "m",
      fetchImpl: recordingFetch([jsonResponse({ text: "Azja", confidence: 0.42 })]).fetchImpl,
    });
    expect(await withConfidence.transcribe(audio)).toEqual({ status: "ok", text: "Azja", confidence: 0.42 });
    const without = createOpenAiCompatibleSttProvider({
      baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "m",
      fetchImpl: recordingFetch([jsonResponse({ text: "Azja" })]).fetchImpl,
    });
    expect(await without.transcribe(audio)).toEqual({ status: "ok", text: "Azja", confidence: null });
  });

  it("sam znacznik zdarzenia dźwiękowego (szum) to brak mowy", async () => {
    const provider = createOpenAiCompatibleSttProvider({
      baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "m",
      fetchImpl: recordingFetch([jsonResponse({ text: "[szum]", words: [{ word: "[szum]", type: "audio_event", confidence: 0.93 }] })]).fetchImpl,
    });
    expect(await provider.transcribe(audio)).toEqual({ status: "no_speech", text: null, confidence: null });
  });

  it("pusty tekst (cisza) to brak mowy", async () => {
    const provider = createOpenAiCompatibleSttProvider({
      baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "m",
      fetchImpl: recordingFetch([jsonResponse({ text: "" })]).fetchImpl,
    });
    expect(await provider.transcribe(audio)).toEqual({ status: "no_speech", text: null, confidence: null });
  });

  it("przy odrzuceniu verbose_json ponawia z formatem json", async () => {
    const { calls, fetchImpl } = recordingFetch([jsonResponse({ error: "unsupported" }, 400), jsonResponse({ text: "Europa" })]);
    const provider = createOpenAiCompatibleSttProvider({ baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "m", fetchImpl });
    expect(await provider.transcribe(audio)).toEqual({ status: "ok", text: "Europa", confidence: null });
    expect(calls.map((call) => (JSON.parse(call.init.body) as { response_format: string }).response_format)).toEqual(["verbose_json", "json"]);
  });

  it("brak endpointu ZDR, błąd usługi i wyjątek sieci to awaria, bez treści odpowiedzi", async () => {
    for (const fetchImpl of [
      recordingFetch([jsonResponse({ error: { message: "No endpoints found matching your data policy" } }, 404)]).fetchImpl,
      recordingFetch([jsonResponse({}, 503)]).fetchImpl,
      async () => { throw new Error("network"); },
    ]) {
      const provider = createOpenAiCompatibleSttProvider({ baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "m", fetchImpl });
      expect(await provider.transcribe(audio)).toEqual({ status: "failed", text: null, confidence: null });
    }
  });

  it("odrzucony klucz rzuca błąd konfiguracji bez szczegółów odpowiedzi", async () => {
    const provider = createOpenAiCompatibleSttProvider({
      baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "m",
      fetchImpl: recordingFetch([jsonResponse({ error: "bad key sk-or-123" }, 401)]).fetchImpl,
    });
    const error = await provider.transcribe(audio).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect(String((error as AppError).message)).not.toContain("sk-or");
  });
});

describe("stripAudioEventTags", () => {
  it("usuwa znaczniki zdarzeń i zostawia wypowiedź", () => {
    expect(stripAudioEventTags("[szum] Równik to [śmiech] najdłuższy równoleżnik")).toBe("Równik to najdłuższy równoleżnik");
    expect(stripAudioEventTags("[szum]")).toBe("");
  });
});

describe("createOpenAiCompatibleSttProvider — zapis kosztów", () => {
  const options = { baseUrl: "https://openrouter.ai/api/v1", apiKey: "secret", model: "elevenlabs/scribe-v2" };
  const timed = { ...audio, durationMs: 4200 };

  it("200: jeden event ok z audioMs z durationMs i kosztem z usage", async () => {
    const { fetchImpl } = recordingFetch([jsonResponse({ text: "Poziomica.", usage: { seconds: 4.2, cost: 0.0000636 } })]);
    const rec = createTestRecorder();
    await createOpenAiCompatibleSttProvider({ ...options, fetchImpl, usage: rec }).transcribe(timed);
    expect(rec.events).toEqual([
      { feature: "lesson_stt", provider: "openrouter", model: "elevenlabs/scribe-v2", outcome: "ok", httpStatus: 200, audioMs: 4200, providerCostUsd: 0.0000636 },
    ]);
  });

  it("400 przy verbose_json, potem 200 przy json: dwa eventy (failed 400, ok z kosztem)", async () => {
    const { calls, fetchImpl } = recordingFetch([jsonResponse({}, 400), jsonResponse({ text: "Dobrze.", usage: { seconds: 4.2, cost: 0.00005 } })]);
    const rec = createTestRecorder();
    const result = await createOpenAiCompatibleSttProvider({ ...options, fetchImpl, usage: rec }).transcribe(timed);
    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(rec.events).toHaveLength(2);
    expect(rec.events[0]).toMatchObject({ outcome: "failed", httpStatus: 400, audioMs: 4200 });
    expect(rec.events[1]).toMatchObject({ outcome: "ok", httpStatus: 200, audioMs: 4200, providerCostUsd: 0.00005 });
  });

  it("400, potem awaria transportu drugiego żądania: dwa eventy failed", async () => {
    let call = 0;
    const fetchImpl = async () => {
      call += 1;
      if (call === 1) return jsonResponse({}, 400);
      throw new Error("network down");
    };
    const rec = createTestRecorder();
    const result = await createOpenAiCompatibleSttProvider({ ...options, fetchImpl, usage: rec }).transcribe(timed);
    expect(result.status).toBe("failed");
    expect(rec.events).toHaveLength(2);
    expect(rec.events[0]).toMatchObject({ outcome: "failed", httpStatus: 400 });
    expect(rec.events[1]).toMatchObject({ outcome: "failed" });
    expect(rec.events[1]!.httpStatus).toBeUndefined();
  });

  it("401 i 403: jeden event failed, AppError bez zmian", async () => {
    for (const status of [401, 403]) {
      const { fetchImpl } = recordingFetch([jsonResponse({}, status)]);
      const rec = createTestRecorder();
      await expect(createOpenAiCompatibleSttProvider({ ...options, fetchImpl, usage: rec }).transcribe(timed)).rejects.toBeInstanceOf(AppError);
      expect(rec.events).toHaveLength(1);
      expect(rec.events[0]).toMatchObject({ outcome: "failed", httpStatus: status });
    }
  });

  it("HTTP 500: jeden event failed, wynik failed", async () => {
    const { fetchImpl } = recordingFetch([jsonResponse({}, 500)]);
    const rec = createTestRecorder();
    const result = await createOpenAiCompatibleSttProvider({ ...options, fetchImpl, usage: rec }).transcribe(timed);
    expect(result.status).toBe("failed");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "failed", httpStatus: 500 });
  });

  it("abort: jeden event failed bez kodu HTTP", async () => {
    const fetchImpl = async () => { throw new DOMException("aborted", "AbortError"); };
    const rec = createTestRecorder();
    const result = await createOpenAiCompatibleSttProvider({ ...options, fetchImpl, usage: rec }).transcribe(timed);
    expect(result.status).toBe("failed");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "failed" });
    expect(rec.events[0]!.httpStatus).toBeUndefined();
  });

  it("nieczytelne ciało 2xx: jeden event failed z kodem 200", async () => {
    const { fetchImpl } = recordingFetch([new Response("not json", { status: 200 })]);
    const rec = createTestRecorder();
    const result = await createOpenAiCompatibleSttProvider({ ...options, fetchImpl, usage: rec }).transcribe(timed);
    expect(result.status).toBe("failed");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "failed", httpStatus: 200 });
  });

  it("bez durationMs i bez nagłówka WAV: event bez audioMs", async () => {
    const { fetchImpl } = recordingFetch([jsonResponse({ text: "ok" })]);
    const rec = createTestRecorder();
    await createOpenAiCompatibleSttProvider({ ...options, fetchImpl, usage: rec }).transcribe(audio);
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]!.audioMs).toBeUndefined();
  });

  it("żądanie nie zmienia się przez zapis kosztów (bez pola usage)", async () => {
    const { calls, fetchImpl } = recordingFetch([jsonResponse({ text: "ok" })]);
    await createOpenAiCompatibleSttProvider({ ...options, fetchImpl, usage: createTestRecorder() }).transcribe(timed);
    expect(JSON.parse(calls[0]!.init.body)).not.toHaveProperty("usage");
  });

  it("recorder, który rzuca, nie zmienia wyniku; bez recordera działa jak dotąd", async () => {
    const first = recordingFetch([jsonResponse({ text: "ok" })]);
    await expect(createOpenAiCompatibleSttProvider({ ...options, fetchImpl: first.fetchImpl, usage: createThrowingRecorder() }).transcribe(timed)).resolves.toMatchObject({ status: "ok" });
    const second = recordingFetch([jsonResponse({ text: "ok" })]);
    await expect(createOpenAiCompatibleSttProvider({ ...options, fetchImpl: second.fetchImpl }).transcribe(timed)).resolves.toMatchObject({ status: "ok" });
  });
});
