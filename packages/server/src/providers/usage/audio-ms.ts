import type { AudioInput } from "../../ports/ai";
import { wavDurationMs } from "../audio/wav";

/**
 * Długość nagrania do zapisu kosztów mowy: `durationMs` z przypadku użycia
 * (z metadanych także WebM), a bez niego nagłówek WAV. Inny format bez długości
 * daje `undefined` — event bez `audioMs` wyceni się jako `unknown`, nigdy nie
 * rzuca. Czyta tylko nagłówek, nie treść nagrania.
 */
export function audioMsOf(audio: AudioInput): number | undefined {
  if (typeof audio.durationMs === "number" && Number.isFinite(audio.durationMs) && audio.durationMs >= 0) {
    return Math.round(audio.durationMs);
  }
  if (/^audio\/(x-)?wa(v|ve)\b/i.test(audio.mimeType)) {
    try {
      return wavDurationMs(audio.bytes) ?? undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
