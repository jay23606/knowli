import type { AudioInput, PronunciationProvider, PronunciationResult } from "../../ports/ai";
import { AppError } from "../../errors";
import type { UsageRecorder } from "../../ports/usage";
import { audioMsOf } from "../usage/audio-ms";
import { recordHttpError, recordResponse, recordTransportFailure, recordUnreadable } from "../usage/record-http";
import { z } from "zod";

/**
 * Adapter Azure Pronunciation Assessment (REST, arch §11, SPEC §23). Ocenia
 * wymowę względem JEDNEGO oczekiwanego tekstu — poprawności treści rozstrzyga
 * osobna transkrypcja STT, nigdy ten wynik. Kształt odpowiedzi (score na
 * NBest[0]) potwierdzony próbą techniczną zadania 0; progi pasm opisuje
 * docs/speech-spike.md.
 */
export interface AzurePronunciationOptions {
  subscriptionKey: string;
  region: string;
  /** Zapis kosztów wywołań (spec cost-tracking §4.2); bez niego adapter działa jak dotąd. */
  usage?: UsageRecorder;
  fetchImpl?: (
    url: string,
    init: { method: "POST"; headers: Record<string, string>; body: Uint8Array; signal?: AbortSignal },
  ) => Promise<Response>;
}

const WordSchema = z.object({
  Word: z.string(),
  AccuracyScore: z.number().nullish(),
  ErrorType: z.string().nullish(),
  Phonemes: z.array(z.object({ Phoneme: z.string(), AccuracyScore: z.number().nullish() })).optional(),
});

const ResponseSchema = z.object({
  RecognitionStatus: z.string().optional(),
  DisplayText: z.string().optional(),
  NBest: z.array(
    z.object({
      Confidence: z.number().optional(),
      AccuracyScore: z.number().optional(),
      Words: z.array(WordSchema).optional(),
    }),
  ).optional(),
});

function failed(): PronunciationResult {
  return { status: "failed", overallScore: null, recognizedText: null };
}

export function createAzurePronunciationProvider(options: AzurePronunciationOptions): PronunciationProvider {
  const doFetch = options.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit));
  return {
    name: "azure-pronunciation",
    assess: async (
      audio: AudioInput,
      expectedText: string,
      signal?: AbortSignal,
    ): Promise<PronunciationResult> => {
      const url =
        `https://${options.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1` +
        `?language=${encodeURIComponent(audio.locale)}&format=detailed`;
      // parametry oceny jadą w nagłówku base64 — ReferenceText to tekst klucza
      // odpowiedzi zadania, nie dane dziecka; bajty nagrania tylko w body
      const assessmentParams = Buffer.from(
        JSON.stringify({
          ReferenceText: expectedText,
          GradingSystem: "HundredMark",
          Granularity: "Phoneme",
          Dimension: "Comprehensive",
        }),
        "utf8",
      ).toString("base64");
      // jedno żądanie HTTP = jeden zapis; catch transportu zapisuje tylko, gdy odpowiedzi nie było
      const audioMs = audioMsOf(audio);
      const base = { feature: "pronunciation" as const, provider: "azure", ...(audioMs === undefined ? {} : { audioMs }) };
      let recorded = false;
      try {
        const response = await doFetch(url, {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": options.subscriptionKey,
            "Content-Type": audio.mimeType,
            Accept: "application/json",
            "Pronunciation-Assessment": assessmentParams,
          },
          body: audio.bytes,
          signal,
        });
        if (response.status === 401 || response.status === 403) {
          recorded = true;
          recordHttpError(options.usage, base, response.status);
          throw new AppError("internal", { message: "azure speech credentials rejected" });
        }
        if (!response.ok) {
          recorded = true;
          recordHttpError(options.usage, base, response.status);
          return failed();
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch (error) {
          recorded = true;
          recordUnreadable(options.usage, base, response.status);
          throw error;
        }
        // płatna odpowiedź jest zapisana zanim kształt zostanie zwalidowany
        recorded = true;
        recordResponse(options.usage, base, response.status, body);
        const payload = ResponseSchema.parse(body);
        const best = payload.NBest?.[0];
        if (payload.RecognitionStatus !== "Success" || !best) {
          return { status: "no_speech", overallScore: null, recognizedText: null };
        }
        const score = best.AccuracyScore;
        return {
          status: "ok",
          overallScore: typeof score === "number" ? score : null,
          recognizedText: payload.DisplayText?.trim() || null,
          ...(best.Words
            ? {
                words: best.Words.map((word) => ({
                  text: word.Word.toLowerCase(),
                  accuracyScore: word.AccuracyScore ?? null,
                  errorType: word.ErrorType && word.ErrorType !== "None" ? word.ErrorType : null,
                  phonemes: (word.Phonemes ?? []).map((phoneme) => ({
                    phoneme: phoneme.Phoneme,
                    accuracyScore: phoneme.AccuracyScore ?? null,
                  })),
                })),
              }
            : {}),
        };
      } catch (error) {
        if (!recorded) recordTransportFailure(options.usage, base);
        if (error instanceof AppError) throw error;
        return failed();
      }
    },
  };
}
