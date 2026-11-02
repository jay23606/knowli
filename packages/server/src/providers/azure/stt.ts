import type { AudioInput, SttProvider, TranscriptionResult } from "../../ports/ai";
import { AppError } from "../../errors";
import type { UsageRecorder } from "../../ports/usage";
import { audioMsOf } from "../usage/audio-ms";
import { recordHttpError, recordResponse, recordTransportFailure, recordUnreadable } from "../usage/record-http";

/**
 * Adapter Azure Speech-to-text (REST, arch §11, SPEC §23). Rozpoznaje treść —
 * nie ocenia wymowy. Kształty odpowiedzi (w tym cisza jako Success z pustym
 * DisplayText) potwierdzone próbą techniczną zadania 0; klient musi wysyłać
 * WAV PCM, bo kompresja zwraca pusty wynik zamiast błędu (docs/speech-spike.md).
 */
export interface AzureSttOptions {
  subscriptionKey: string;
  region: string;
  /** Zapis kosztów wywołań (spec cost-tracking §4.2); bez niego adapter działa jak dotąd. */
  usage?: UsageRecorder;
  fetchImpl?: (
    url: string,
    init: { method: "POST"; headers: Record<string, string>; body: Uint8Array; signal?: AbortSignal },
  ) => Promise<Response>;
}

interface AzureRecognition {
  RecognitionStatus?: string;
  DisplayText?: string;
  NBest?: { Confidence?: number }[];
}

function failed(): TranscriptionResult {
  // bez szczegółów odpowiedzi usługi w błędzie — transkrypcja nie trafia do logów
  return { status: "failed", text: null, confidence: null };
}

export function createAzureSttProvider(options: AzureSttOptions): SttProvider {
  const doFetch = options.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit));
  return {
    name: "azure-stt",
    transcribe: async (audio: AudioInput, signal?: AbortSignal): Promise<TranscriptionResult> => {
      const url =
        `https://${options.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1` +
        `?language=${encodeURIComponent(audio.locale)}&format=detailed`;
      // jedno żądanie HTTP = jeden zapis; catch transportu zapisuje tylko, gdy odpowiedzi nie było
      const audioMs = audioMsOf(audio);
      const base = { feature: "speech_stt" as const, provider: "azure", ...(audioMs === undefined ? {} : { audioMs }) };
      let recorded = false;
      try {
        const response = await doFetch(url, {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": options.subscriptionKey,
            "Content-Type": audio.mimeType,
            Accept: "application/json",
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
        let payload: AzureRecognition;
        try {
          payload = (await response.json()) as AzureRecognition;
        } catch (error) {
          recorded = true;
          recordUnreadable(options.usage, base, response.status);
          throw error;
        }
        recorded = true;
        recordResponse(options.usage, base, response.status, payload);
        if (payload.RecognitionStatus === "Success") {
          return {
            status: "ok",
            text: payload.DisplayText?.trim() || null,
            confidence: payload.NBest?.[0]?.Confidence ?? null,
          };
        }
        // InitialSilenceTimeout/NoMatch/CandidateHasOnlyOffense itp. — nic
        // wiarygodnego nie rozpoznano; to nie jest błąd wiedzy dziecka
        return { status: "no_speech", text: null, confidence: null };
      } catch (error) {
        if (!recorded) recordTransportFailure(options.usage, base);
        if (error instanceof AppError) throw error;
        return failed();
      }
    },
  };
}
