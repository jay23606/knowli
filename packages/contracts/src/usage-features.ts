import { z } from "zod";

/**
 * Funkcje produktu, które wykonują płatne wywołania usług AI (śledzenie kosztów,
 * spec `2026-11-02-llm-cost-tracking-design.md` §3.1/§4.1). Jedno źródło: port
 * `UsageRecorder` w serwerze i odczyt w panelu rodzica używają tej samej listy.
 */
export const USAGE_FEATURES = [
  "deck_generation",
  "lesson_generation",
  "tts",
  "illustration",
  "deck_cover",
  "answer_grading",
  "session_activity_review",
  "lesson_stt",
  "speech_stt",
  "pronunciation",
] as const;

export type UsageFeature = (typeof USAGE_FEATURES)[number];

export const UsageFeatureSchema = z.enum(USAGE_FEATURES);
