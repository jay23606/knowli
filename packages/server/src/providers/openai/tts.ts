import type { TtsProvider, TtsSynthesizeInput } from "../../ports/ai";
import { providerFromBaseUrl, type UsageRecorder } from "../../ports/usage";
import { mp3DurationMs } from "../audio/mp3-duration";
import { normalizeWav, pcmToWav, wavDurationMs } from "../audio/wav";
import { recordHttpError, recordResponse, recordTransportFailure, recordUnreadable } from "../usage/record-http";

export interface OpenAiTtsOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Zapis kosztów wywołań (spec cost-tracking §4.2); bez niego adapter działa jak dotąd. */
  usage?: UsageRecorder;
}

const DEFAULT_MODEL = "gpt-4o-mini-tts";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * `audio/pcm;rate=24000;channels=1` → format próbek; brak częstotliwości = nieznany
 * format. `audio/L16` celowo odrzucony: jest big-endian, a nagłówek WAV deklaruje
 * little-endian.
 */
function pcmFormatOf(contentType: string): { sampleRate: number; channels: number } | null {
  const [type, ...params] = contentType.split(";").map((part) => part.trim().toLowerCase());
  if (type !== "audio/pcm") return null;
  const values = Object.fromEntries(params.map((param) => param.split("=") as [string, string]));
  const sampleRate = Number(values.rate);
  const channels = values.channels === undefined ? 1 : Number(values.channels);
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || !Number.isInteger(channels) || channels <= 0) return null;
  return { sampleRate, channels };
}

/** Jawnie zadeklarowany typ audio inny niż mp3 (np. PCM Gemini przy formacie `mp3`). */
function isOtherAudioThanMp3(contentType: string): boolean {
  return /^audio\//i.test(contentType) && !/^audio\/(mpeg|mp3)\b/i.test(contentType);
}

/**
 * Długość odebranego audio do zapisu kosztów; liczona zanim format zostanie
 * zwalidowany, więc nigdy nie rzuca (nieznany format lub jawnie inny typ audio
 * niż żądany mp3 = brak `audioMs`, bez fikcyjnej długości z „ramek”).
 */
function receivedAudioMs(bytes: Uint8Array, format: "mp3" | "wav", contentType: string): number | undefined {
  try {
    if (format === "mp3") return isOtherAudioThanMp3(contentType) ? undefined : mp3DurationMs(bytes) ?? undefined;
    const pcm = pcmFormatOf(contentType);
    const wav = /^audio\/(wav|x-wav|wave)\b/i.test(contentType) ? normalizeWav(bytes) : pcm && pcmToWav(bytes, pcm);
    return (wav ? wavDurationMs(wav) : null) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Adapter TTS (/v1/audio/speech). Głos bierze z żądania (fingerprint uwzględnia
 * provider/model/głos). Format `wav` prosi o surowe PCM (jedyny format Gemini
 * TTS na OpenRouter) i opakowuje je nagłówkiem WAV; `instructions` (np. język
 * wymowy) idzie osobnym polem, nie w czytanym tekście.
 */
export function createOpenAiTtsProvider(options: OpenAiTtsOptions): TtsProvider {
  const model = options.model ?? DEFAULT_MODEL;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const provider = providerFromBaseUrl(baseUrl);
  return {
    name: "openai",
    model,
    async synthesize(input: TtsSynthesizeInput, signal?: AbortSignal) {
      const requestModel = input.model || model;
      // jedno żądanie HTTP = jeden zapis; płatność dotyczy znaków tekstu
      const base = { feature: "tts" as const, provider, model: requestModel, characters: input.text.length };
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/audio/speech`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: requestModel,
            voice: input.voice,
            input: input.text,
            response_format: input.format === "wav" ? "pcm" : input.format,
            ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
          }),
          signal,
        });
      } catch (error) {
        recordTransportFailure(options.usage, base);
        throw error;
      }
      if (!response.ok) {
        recordHttpError(options.usage, base, response.status);
        throw new Error(`provider_http_${response.status}`);
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        recordUnreadable(options.usage, base, response.status);
        throw error;
      }
      const contentType = response.headers.get("content-type") ?? "";
      // opłacone audio jest zapisane zanim format zostanie zwalidowany
      const audioMs = receivedAudioMs(bytes, input.format, contentType);
      recordResponse(options.usage, { ...base, ...(audioMs === undefined ? {} : { audioMs }) }, response.status, undefined);
      if (input.format === "mp3") {
        // Jawnie inny typ audio (np. PCM Gemini przy pominiętym UMIEM_TTS_FORMAT=wav)
        // zostałby zapisany jako niedekodowalne „mp3” bez ponowienia.
        if (isOtherAudioThanMp3(contentType)) throw new Error("provider_unexpected_audio");
        return { bytes, mimeType: "audio/mpeg" };
      }
      const pcm = pcmFormatOf(contentType);
      const wav = /^audio\/(wav|x-wav|wave)\b/i.test(contentType) ? normalizeWav(bytes) : pcm && pcmToWav(bytes, pcm);
      // Zgadnięty format albo ucięty/pusty plik zostałby zapisany jako gotowe
      // nagranie bez ponowienia. Komunikat to sam kod, bez treści odpowiedzi.
      if (wav === null || wavDurationMs(wav) === null) throw new Error("provider_unexpected_audio");
      return { bytes: wav, mimeType: "audio/wav" };
    },
  };
}
