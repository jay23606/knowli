import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiTtsProvider } from "./tts";
import { pcmToWav } from "../audio/wav";
import { createTestRecorder, createThrowingRecorder } from "../usage/test-recorder";

afterEach(() => vi.unstubAllGlobals());

function bodyOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("createOpenAiTtsProvider", () => {
  it("does not expose provider response bodies in HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private provider detail", { status: 400 })));
    const provider = createOpenAiTtsProvider({ apiKey: "test" });
    const failure = provider.synthesize({ text: "hello", locale: "en-GB", voice: "alloy", format: "mp3" });
    await expect(failure).rejects.toThrow(/400/);
    await expect(failure).rejects.not.toThrow(/private provider detail/);
  });

  it("wysyła model zapisany w zasobie zamiast bieżącego modelu adaptera", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createOpenAiTtsProvider({ apiKey: "test", model: "openai/gpt-4o-mini-tts-2025-12-15" });
    await provider.synthesize({ text: "Ile nóg ma pająk?", locale: "pl-PL", voice: "alloy", format: "mp3", model: "gpt-4o-mini-tts" });
    expect(bodyOf(fetchMock).model).toBe("gpt-4o-mini-tts");
  });

  it("mp3 bez instrukcji: żądanie mp3 bez pola instructions, wynik audio/mpeg", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createOpenAiTtsProvider({ apiKey: "test" });
    const result = await provider.synthesize({ text: "cat", locale: "en-GB", voice: "alloy", format: "mp3" });
    expect(bodyOf(fetchMock)).toEqual({ model: "gpt-4o-mini-tts", voice: "alloy", input: "cat", response_format: "mp3" });
    expect(result.mimeType).toBe("audio/mpeg");
  });

  it("mp3: inny typ audio od providera (np. PCM przy złym UMIEM_TTS_FORMAT) to błąd, a nie gotowe nagranie", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "audio/pcm;rate=24000;channels=1" } })));
    const provider = createOpenAiTtsProvider({ apiKey: "test" });
    await expect(provider.synthesize({ text: "cat", locale: "en-GB", voice: "Kore", format: "mp3" })).rejects.toThrow("provider_unexpected_audio");
  });

  it("wav: prosi o pcm, przekazuje instrukcję i opakowuje odpowiedź nagłówkiem WAV", async () => {
    const pcm = new Uint8Array([0, 1, 2, 3]);
    const fetchMock = vi.fn(async () => new Response(pcm, { status: 200, headers: { "content-type": "audio/pcm;rate=24000;channels=1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createOpenAiTtsProvider({ apiKey: "test", model: "google/gemini-3.8-flash-tts" });
    const result = await provider.synthesize({
      text: "pies", locale: "pl-PL", voice: "Kore", format: "wav", instructions: "Mów po polsku, z polską wymową.",
    });
    expect(bodyOf(fetchMock)).toEqual({
      model: "google/gemini-3.8-flash-tts",
      voice: "Kore",
      input: "pies",
      response_format: "pcm",
      instructions: "Mów po polsku, z polską wymową.",
    });
    expect(result.mimeType).toBe("audio/wav");
    expect(String.fromCharCode(...result.bytes.subarray(0, 4))).toBe("RIFF");
    expect(new DataView(result.bytes.buffer, result.bytes.byteOffset).getUint32(24, true)).toBe(24000);
    expect([...result.bytes.subarray(44)]).toEqual([...pcm]);
  });

  it("wav: poprawna odpowiedź już w WAV przechodzi bez zmian", async () => {
    const wav = pcmToWav(new Uint8Array(480), { sampleRate: 24000, channels: 1 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(wav, { status: 200, headers: { "content-type": "audio/wav" } })));
    const provider = createOpenAiTtsProvider({ apiKey: "test" });
    const result = await provider.synthesize({ text: "kot", locale: "pl-PL", voice: "Kore", format: "wav" });
    expect(result).toEqual({ bytes: wav, mimeType: "audio/wav" });
  });

  it("wav: strumieniowy WAV (rozmiary 0xFFFFFFFF) jest przyjmowany z poprawionym nagłówkiem", async () => {
    const wav = pcmToWav(new Uint8Array(480), { sampleRate: 24000, channels: 1 });
    const streamed = wav.slice();
    new DataView(streamed.buffer).setUint32(4, 0xffffffff, true);
    new DataView(streamed.buffer).setUint32(40, 0xffffffff, true);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(streamed, { status: 200, headers: { "content-type": "audio/wav" } })));
    const provider = createOpenAiTtsProvider({ apiKey: "test" });
    const result = await provider.synthesize({ text: "kot", locale: "pl-PL", voice: "Kore", format: "wav" });
    expect(result).toEqual({ bytes: wav, mimeType: "audio/wav" });
  });

  it("wav: ucięty WAV albo puste PCM to błąd — zasób nie może zostać gotowy bez dźwięku", async () => {
    const provider = createOpenAiTtsProvider({ apiKey: "test" });
    const full = pcmToWav(new Uint8Array(480), { sampleRate: 24000, channels: 1 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(full.subarray(0, 100), { status: 200, headers: { "content-type": "audio/wav" } })));
    await expect(provider.synthesize({ text: "kot", locale: "pl-PL", voice: "Kore", format: "wav" })).rejects.toThrow("provider_unexpected_audio");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(0), { status: 200, headers: { "content-type": "audio/pcm;rate=24000;channels=1" } })));
    await expect(provider.synthesize({ text: "kot", locale: "pl-PL", voice: "Kore", format: "wav" })).rejects.toThrow("provider_unexpected_audio");
  });

  it("wav: audio/L16 (big-endian) jest odrzucane, a nie zapisywane jako zniekształcony WAV", async () => {
    const provider = createOpenAiTtsProvider({ apiKey: "test" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([0, 1, 2, 3]), { status: 200, headers: { "content-type": "audio/L16;rate=24000" } })));
    await expect(provider.synthesize({ text: "kot", locale: "pl-PL", voice: "Kore", format: "wav" })).rejects.toThrow("provider_unexpected_audio");
  });

  it("wav: inny typ odpowiedzi albo PCM bez częstotliwości to błąd, a nie zgadywanie formatu", async () => {
    const provider = createOpenAiTtsProvider({ apiKey: "test" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "audio/mpeg" } })));
    await expect(provider.synthesize({ text: "kot", locale: "pl-PL", voice: "Kore", format: "wav" })).rejects.toThrow("provider_unexpected_audio");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "audio/pcm" } })));
    await expect(provider.synthesize({ text: "kot", locale: "pl-PL", voice: "Kore", format: "wav" })).rejects.toThrow("provider_unexpected_audio");
  });
});

describe("createOpenAiTtsProvider — zapis kosztów", () => {
  const PCM_FORMAT = "audio/pcm;rate=24000;channels=1";
  const mp3Frames = (() => {
    const frame = new Uint8Array(417);
    frame.set([0xff, 0xfb, 0x90, 0x64]);
    const bytes = new Uint8Array(417 * 2);
    bytes.set(frame);
    bytes.set(frame, 417);
    return bytes;
  })();

  it("PCM 24 kHz 1,5 s: jeden event ok ze znakami i audioMs, bez kosztu dostawcy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(72_000), { status: 200, headers: { "content-type": PCM_FORMAT } })));
    const rec = createTestRecorder();
    const provider = createOpenAiTtsProvider({ apiKey: "test", baseUrl: "https://openrouter.ai/api/v1", model: "google/gemini-3.8-flash-tts", usage: rec });
    await provider.synthesize({ text: "pies", locale: "pl-PL", voice: "Kore", format: "wav" });
    expect(rec.events).toEqual([
      { feature: "tts", provider: "openrouter", model: "google/gemini-3.8-flash-tts", outcome: "ok", httpStatus: 200, characters: 4, audioMs: 1500 },
    ]);
  });

  it("model z żądania (zasób) trafia do eventu zamiast modelu adaptera", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(480), { status: 200, headers: { "content-type": PCM_FORMAT } })));
    const rec = createTestRecorder();
    const provider = createOpenAiTtsProvider({ apiKey: "test", model: "adapter-model", usage: rec });
    await provider.synthesize({ text: "kot", locale: "pl-PL", voice: "Kore", format: "wav", model: "resource-model" });
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ provider: "openai", model: "resource-model" });
  });

  it("mp3: audioMs z nagłówków ramek", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(mp3Frames, { status: 200, headers: { "content-type": "audio/mpeg" } })));
    const rec = createTestRecorder();
    const provider = createOpenAiTtsProvider({ apiKey: "test", usage: rec });
    await provider.synthesize({ text: "cat", locale: "en-GB", voice: "alloy", format: "mp3" });
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ feature: "tts", outcome: "ok", characters: 3, audioMs: 52 });
  });

  it("mp3 z jawnie innym typem audio: jeden event bez audioMs z ramek, potem błąd formatu", async () => {
    // bajty wyglądają na ramki mp3, ale dostawca deklaruje PCM — długość z ramek byłaby fikcją
    vi.stubGlobal("fetch", vi.fn(async () => new Response(mp3Frames, { status: 200, headers: { "content-type": "audio/pcm" } })));
    const rec = createTestRecorder();
    const provider = createOpenAiTtsProvider({ apiKey: "test", usage: rec });
    await expect(provider.synthesize({ text: "cat", locale: "en-GB", voice: "Kore", format: "mp3" })).rejects.toThrow("provider_unexpected_audio");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "ok", httpStatus: 200, characters: 3 });
    expect(rec.events[0]!.audioMs).toBeUndefined();
  });

  it("nieznany content-type: opłacone wywołanie jest zapisane jako ok, a potem błąd formatu", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "audio/pcm" } })));
    const rec = createTestRecorder();
    const provider = createOpenAiTtsProvider({ apiKey: "test", usage: rec });
    await expect(provider.synthesize({ text: "kot", locale: "pl-PL", voice: "Kore", format: "wav" })).rejects.toThrow("provider_unexpected_audio");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "ok", httpStatus: 200, characters: 3 });
    expect(rec.events[0]!.audioMs).toBeUndefined();
  });

  it("HTTP 500: jeden event failed, błąd bez zmian", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("detail", { status: 500 })));
    const rec = createTestRecorder();
    const provider = createOpenAiTtsProvider({ apiKey: "test", usage: rec });
    await expect(provider.synthesize({ text: "kot", locale: "pl-PL", voice: "Kore", format: "mp3" })).rejects.toThrow("provider_http_500");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "failed", httpStatus: 500 });
  });

  it("abort: jeden event failed bez kodu HTTP", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("aborted", "AbortError"); }));
    const rec = createTestRecorder();
    const provider = createOpenAiTtsProvider({ apiKey: "test", usage: rec });
    await expect(provider.synthesize({ text: "kot", locale: "pl-PL", voice: "Kore", format: "mp3" })).rejects.toThrow("aborted");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "failed" });
    expect(rec.events[0]!.httpStatus).toBeUndefined();
  });

  it("przerwanie podczas czytania ciała 2xx: jeden event failed z kodem 200", async () => {
    const response = { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => { throw new DOMException("aborted", "AbortError"); } };
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const rec = createTestRecorder();
    const provider = createOpenAiTtsProvider({ apiKey: "test", usage: rec });
    await expect(provider.synthesize({ text: "kot", locale: "pl-PL", voice: "Kore", format: "mp3" })).rejects.toThrow("aborted");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ outcome: "failed", httpStatus: 200 });
  });

  it("recorder, który rzuca, nie zmienia wyniku; bez recordera działa jak dotąd", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(mp3Frames, { status: 200, headers: { "content-type": "audio/mpeg" } })));
    const input = { text: "cat", locale: "en-GB", voice: "alloy", format: "mp3" } as const;
    await expect(createOpenAiTtsProvider({ apiKey: "test", usage: createThrowingRecorder() }).synthesize(input)).resolves.toMatchObject({ mimeType: "audio/mpeg" });
    await expect(createOpenAiTtsProvider({ apiKey: "test" }).synthesize(input)).resolves.toMatchObject({ mimeType: "audio/mpeg" });
  });
});
