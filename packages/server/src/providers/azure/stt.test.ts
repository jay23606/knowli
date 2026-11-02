import { describe, expect, it } from "vitest";
import { AppError } from "../../errors";
import { pcmToWav } from "../audio/wav";
import type { UsageRecorder } from "../../ports/usage";
import { createTestRecorder, createThrowingRecorder } from "../usage/test-recorder";
import { createAzureSttProvider } from "./stt";

// Kształty odpowiedzi potwierdzone próbą techniczną zadania 0 (REST Azure,
// format=detailed), w tym obserwacja, że cisza potrafi wrócić jako Success
// z pustym DisplayText — pusty tekst to brak odpowiedzi, nie pomyłka.
const liveShape = {
  RecognitionStatus: "Success",
  DisplayText: "Wednesday.",
  NBest: [{ Confidence: 0.6453759, Lexical: "wednesday", Display: "Wednesday." }],
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const audio = { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/wav", locale: "en-GB" };

describe("createAzureSttProvider", () => {
  it("rozpoznaje treść z Confidence z NBest[0]", async () => {
    const provider = createAzureSttProvider({
      subscriptionKey: "k",
      region: "r",
      fetchImpl: async () => jsonResponse(liveShape),
    });
    const result = await provider.transcribe(audio);
    expect(result).toEqual({ status: "ok", text: "Wednesday.", confidence: 0.6453759 });
  });

  it("Success z pustym DisplayText (cisza w próbie) daje ok bez tekstu", async () => {
    const provider = createAzureSttProvider({
      subscriptionKey: "k",
      region: "r",
      fetchImpl: async () =>
        jsonResponse({ RecognitionStatus: "Success", DisplayText: "", NBest: [{ Confidence: 0 }] }),
    });
    const result = await provider.transcribe(audio);
    expect(result).toEqual({ status: "ok", text: null, confidence: 0 });
  });

  it("InitialSilenceTimeout to no_speech, nie błąd wiedzy dziecka", async () => {
    const provider = createAzureSttProvider({
      subscriptionKey: "k",
      region: "r",
      fetchImpl: async () => jsonResponse({ RecognitionStatus: "InitialSilenceTimeout" }),
    });
    const result = await provider.transcribe(audio);
    expect(result).toEqual({ status: "no_speech", text: null, confidence: null });
  });

  it("odrzucone poświadczenia to błąd techniczny, nie failed", async () => {
    const provider = createAzureSttProvider({
      subscriptionKey: "k",
      region: "r",
      fetchImpl: async () => jsonResponse({}, 401),
    });
    await expect(provider.transcribe(audio)).rejects.toMatchObject({ code: "internal" });
  });

  it("błąd HTTP kończy się failed bez szczegółów odpowiedzi", async () => {
    const provider = createAzureSttProvider({
      subscriptionKey: "k",
      region: "r",
      fetchImpl: async () => jsonResponse({}, 500),
    });
    const result = await provider.transcribe(audio);
    expect(result).toEqual({ status: "failed", text: null, confidence: null });
  });
});

describe("createAzureSttProvider — zapis kosztów", () => {
  const wav = pcmToWav(new Uint8Array(32_000), { sampleRate: 16_000, channels: 1 }); // 1000 ms
  const wavAudio = { bytes: wav, mimeType: "audio/wav", locale: "en-GB" };
  const make = (fetchImpl: () => Promise<Response>, usage?: UsageRecorder) =>
    createAzureSttProvider({ subscriptionKey: "k", region: "r", fetchImpl, ...(usage ? { usage } : {}) });

  it("200: jeden event ok z audioMs z durationMs (provider azure, feature speech_stt)", async () => {
    const rec = createTestRecorder();
    await make(async () => jsonResponse(liveShape), rec).transcribe({ ...audio, durationMs: 2300 });
    expect(rec.events).toEqual([{ feature: "speech_stt", provider: "azure", outcome: "ok", httpStatus: 200, audioMs: 2300 }]);
  });

  it("durationMs ma pierwszeństwo przed nagłówkiem WAV", async () => {
    const rec = createTestRecorder();
    await make(async () => jsonResponse(liveShape), rec).transcribe({ ...wavAudio, durationMs: 2300 });
    expect(rec.events[0]).toMatchObject({ audioMs: 2300 });
  });

  it("bez durationMs audioMs z nagłówka WAV", async () => {
    const rec = createTestRecorder();
    await make(async () => jsonResponse(liveShape), rec).transcribe(wavAudio);
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "ok", audioMs: 1000 });
  });

  it("WebM bez durationMs: event bez audioMs, bez wyjątku", async () => {
    const rec = createTestRecorder();
    const result = await make(async () => jsonResponse(liveShape), rec).transcribe({ bytes: new Uint8Array([26, 69, 223, 163]), mimeType: "audio/webm", locale: "en-GB" });
    expect(result.status).toBe("ok");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]!.audioMs).toBeUndefined();
  });

  it("401 i 403: jeden event failed, AppError bez zmian", async () => {
    for (const status of [401, 403]) {
      const rec = createTestRecorder();
      await expect(make(async () => jsonResponse({}, status), rec).transcribe(audio)).rejects.toBeInstanceOf(AppError);
      expect(rec.events).toHaveLength(1);
      expect(rec.events[0]).toMatchObject({ outcome: "failed", httpStatus: status });
    }
  });

  it("HTTP 500: jeden event failed", async () => {
    const rec = createTestRecorder();
    const result = await make(async () => jsonResponse({}, 500), rec).transcribe(audio);
    expect(result.status).toBe("failed");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "failed", httpStatus: 500 });
  });

  it("abort: jeden event failed bez kodu HTTP", async () => {
    const rec = createTestRecorder();
    const result = await make(async () => { throw new DOMException("aborted", "AbortError"); }, rec).transcribe(audio);
    expect(result.status).toBe("failed");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "failed" });
    expect(rec.events[0]!.httpStatus).toBeUndefined();
  });

  it("nieczytelne ciało 2xx: jeden event failed z kodem 200", async () => {
    const rec = createTestRecorder();
    const result = await make(async () => new Response("not json", { status: 200 }), rec).transcribe(audio);
    expect(result.status).toBe("failed");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "failed", httpStatus: 200 });
  });

  it("recorder, który rzuca, nie zmienia wyniku; bez recordera działa jak dotąd", async () => {
    await expect(make(async () => jsonResponse(liveShape), createThrowingRecorder()).transcribe(audio)).resolves.toMatchObject({ status: "ok" });
    await expect(make(async () => jsonResponse(liveShape)).transcribe(audio)).resolves.toMatchObject({ status: "ok" });
  });
});
