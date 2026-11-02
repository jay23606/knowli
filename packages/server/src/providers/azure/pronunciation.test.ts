import { describe, expect, it } from "vitest";
import { AppError } from "../../errors";
import { pcmToWav } from "../audio/wav";
import type { UsageRecorder } from "../../ports/usage";
import { createTestRecorder, createThrowingRecorder } from "../usage/test-recorder";
import { createAzurePronunciationProvider } from "./pronunciation";

// Kształt odpowiedzi potwierdzony próbą techniczną zadania 0 (REST Azure,
// format=detailed): score ląduje bezpośrednio na NBest[0], a nie w zagnieżdżonym
// PronunciationAssessment (to forma SDK, nie REST).
const liveShape = {
  RecognitionStatus: "Success",
  DisplayText: "Wednesday.",
  NBest: [
    {
      Confidence: 0.93967015,
      Lexical: "wednesday",
      Display: "Wednesday.",
      AccuracyScore: 88,
      FluencyScore: 100,
      CompletenessScore: 100,
      PronScore: 92.8,
      Words: [{ Word: "wednesday", AccuracyScore: 88, ErrorType: "None" }],
    },
  ],
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const audio = { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/wav", locale: "en-GB" };

describe("createAzurePronunciationProvider", () => {
  it("odczytuje AccuracyScore bezpośrednio z NBest[0] (kształt z próby zadania 0)", async () => {
    const provider = createAzurePronunciationProvider({
      subscriptionKey: "k",
      region: "r",
      fetchImpl: async () => jsonResponse(liveShape),
    });
    const result = await provider.assess(audio, "wednesday");
    expect(result).toEqual({
      status: "ok",
      overallScore: 88,
      recognizedText: "Wednesday.",
      words: [{ text: "wednesday", accuracyScore: 88, errorType: null, phonemes: [] }],
    });
  });

  it("inne słowo niż expectedText ma niski Confidence — treść rozstrzyga STT", async () => {
    const wrongWord = structuredClone(liveShape);
    wrongWord.NBest[0]!.Confidence = 0.19226873;
    wrongWord.NBest[0]!.AccuracyScore = 61;
    const provider = createAzurePronunciationProvider({
      subscriptionKey: "k",
      region: "r",
      fetchImpl: async () => jsonResponse(wrongWord),
    });
    const result = await provider.assess(audio, "wednesday");
    expect(result.overallScore).toBe(61);
  });

  it("cisza (InitialSilenceTimeout) daje no_speech bez oceny", async () => {
    const provider = createAzurePronunciationProvider({
      subscriptionKey: "k",
      region: "r",
      fetchImpl: async () => jsonResponse({ RecognitionStatus: "InitialSilenceTimeout" }),
    });
    const result = await provider.assess(audio, "wednesday");
    expect(result).toEqual({ status: "no_speech", overallScore: null, recognizedText: null });
  });

  it("odpowiedź bez Success nie jest oceną", async () => {
    const provider = createAzurePronunciationProvider({
      subscriptionKey: "k",
      region: "r",
      fetchImpl: async () => jsonResponse({ RecognitionStatus: "NoMatch" }),
    });
    const result = await provider.assess(audio, "wednesday");
    expect(result.status).toBe("no_speech");
  });

  it("błąd HTTP kończy się failed bez szczegółów odpowiedzi", async () => {
    const provider = createAzurePronunciationProvider({
      subscriptionKey: "k",
      region: "r",
      fetchImpl: async () => jsonResponse({}, 500),
    });
    const result = await provider.assess(audio, "wednesday");
    expect(result).toEqual({ status: "failed", overallScore: null, recognizedText: null });
  });

  it("parsuje Words/Phonemes z Granularity Phoneme i normalizuje ErrorType None", async () => {
    let assessmentHeader = "";
    const provider = createAzurePronunciationProvider({
      subscriptionKey: "k",
      region: "germanywestcentral",
      fetchImpl: async (_url, init) => {
        assessmentHeader = init.headers["Pronunciation-Assessment"]!;
        return jsonResponse({
          RecognitionStatus: "Success",
          DisplayText: "cherry.",
          NBest: [
            {
              AccuracyScore: 82,
              Words: [
                {
                  Word: "cherry",
                  AccuracyScore: 82,
                  ErrorType: "None",
                  Phonemes: [
                    { Phoneme: "tʃ", AccuracyScore: 90 },
                    { Phoneme: "ɛ", AccuracyScore: 61 },
                    { Phoneme: "r", AccuracyScore: 88 },
                    { Phoneme: "i", AccuracyScore: 85 },
                  ],
                },
              ],
            },
          ],
        });
      },
    });
    const result = await provider.assess(audio, "cherry");
    expect(result.status).toBe("ok");
    expect(result.overallScore).toBe(82);
    expect(result.words).toEqual([
      {
        text: "cherry",
        accuracyScore: 82,
        errorType: null,
        phonemes: [
          { phoneme: "tʃ", accuracyScore: 90 },
          { phoneme: "ɛ", accuracyScore: 61 },
          { phoneme: "r", accuracyScore: 88 },
          { phoneme: "i", accuracyScore: 85 },
        ],
      },
    ]);
    expect(JSON.parse(Buffer.from(assessmentHeader, "base64").toString("utf8")).Granularity).toBe("Phoneme");
  });
});

describe("createAzurePronunciationProvider — zapis kosztów", () => {
  const wav = pcmToWav(new Uint8Array(32_000), { sampleRate: 16_000, channels: 1 }); // 1000 ms
  const wavAudio = { bytes: wav, mimeType: "audio/wav", locale: "en-GB" };
  const make = (fetchImpl: () => Promise<Response>, usage?: UsageRecorder) =>
    createAzurePronunciationProvider({ subscriptionKey: "k", region: "r", fetchImpl, ...(usage ? { usage } : {}) });

  it("200: jeden event ok z audioMs z durationMs (provider azure, feature pronunciation)", async () => {
    const rec = createTestRecorder();
    await make(async () => jsonResponse(liveShape), rec).assess({ ...audio, durationMs: 2300 }, "wednesday");
    expect(rec.events).toEqual([{ feature: "pronunciation", provider: "azure", outcome: "ok", httpStatus: 200, audioMs: 2300 }]);
  });

  it("bez durationMs audioMs z nagłówka WAV", async () => {
    const rec = createTestRecorder();
    await make(async () => jsonResponse(liveShape), rec).assess(wavAudio, "wednesday");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "ok", audioMs: 1000 });
  });

  it("WebM bez durationMs: event bez audioMs, bez wyjątku", async () => {
    const rec = createTestRecorder();
    const result = await make(async () => jsonResponse(liveShape), rec).assess({ bytes: new Uint8Array([26, 69, 223, 163]), mimeType: "audio/webm", locale: "en-GB" }, "wednesday");
    expect(result.status).toBe("ok");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]!.audioMs).toBeUndefined();
  });

  it("odpowiedź 2xx o niepoprawnym kształcie: jeden event ok (opłacone), wynik failed", async () => {
    const rec = createTestRecorder();
    const result = await make(async () => jsonResponse({ NBest: "x" }), rec).assess(audio, "wednesday");
    expect(result.status).toBe("failed");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "ok", httpStatus: 200 });
  });

  it("401 i 403: jeden event failed, AppError bez zmian", async () => {
    for (const status of [401, 403]) {
      const rec = createTestRecorder();
      await expect(make(async () => jsonResponse({}, status), rec).assess(audio, "wednesday")).rejects.toBeInstanceOf(AppError);
      expect(rec.events).toHaveLength(1);
      expect(rec.events[0]).toMatchObject({ outcome: "failed", httpStatus: status });
    }
  });

  it("HTTP 500: jeden event failed", async () => {
    const rec = createTestRecorder();
    const result = await make(async () => jsonResponse({}, 500), rec).assess(audio, "wednesday");
    expect(result.status).toBe("failed");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "failed", httpStatus: 500 });
  });

  it("abort: jeden event failed bez kodu HTTP", async () => {
    const rec = createTestRecorder();
    const result = await make(async () => { throw new DOMException("aborted", "AbortError"); }, rec).assess(audio, "wednesday");
    expect(result.status).toBe("failed");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "failed" });
    expect(rec.events[0]!.httpStatus).toBeUndefined();
  });

  it("nieczytelne ciało 2xx: jeden event failed z kodem 200", async () => {
    const rec = createTestRecorder();
    const result = await make(async () => new Response("not json", { status: 200 }), rec).assess(audio, "wednesday");
    expect(result.status).toBe("failed");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "failed", httpStatus: 200 });
  });

  it("recorder, który rzuca, nie zmienia wyniku; bez recordera działa jak dotąd", async () => {
    await expect(make(async () => jsonResponse(liveShape), createThrowingRecorder()).assess(audio, "wednesday")).resolves.toMatchObject({ status: "ok" });
    await expect(make(async () => jsonResponse(liveShape)).assess(audio, "wednesday")).resolves.toMatchObject({ status: "ok" });
  });
});
