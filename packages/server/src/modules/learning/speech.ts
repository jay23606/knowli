import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  AttemptInputSchema,
  type AttemptDto,
  type AttemptInput,
} from "@learning/contracts";
import type { Services } from "../../config";
import {
  attempts,
  deckVersions,
  itemRevisions,
} from "../../db/schema";
import { AppError } from "../../errors";
import { matchWrittenAnswer } from "../../domain/evaluate";
import { buildPronunciationFragments } from "../../domain/pronunciation-fragments";
import { qualifyAttempt } from "../../domain/independence";
import type {
  AnswerKey,
  EvaluationContext,
  Grade,
  PronunciationDetails,
  Skill,
  SkillGrade,
} from "../../domain/types";
import type { SpeechFeedback } from "../../domain/types";
import { normalizeSpokenAnswerText } from "../../domain/spoken-answer";
import type {
  AudioInput,
  PronunciationResult,
  SpeechEvidence,
} from "../../ports/ai";
import { normalizeAudioInput } from "../../providers/audio/normalize";
import { finalizeAttempt, startAttempt } from "./attempts";

/** Łączny deadline analizy nagrania (arch §11). */
export const SPEECH_ANALYSIS_TIMEOUT_MS = 30_000;
/**
 * Minimalna pewność dla niedopasowanej transkrypcji. Zgodne rozpoznanie
 * przyjmujemy niezależnie od confidence (docs/speech-spike.md: Thursday 0.21,
 * Red 0.31); niepewna rozbieżność nie tworzy mylonej pary.
 */
export const MIN_STT_CONFIDENCE = 0.4;

/** Typy zadań przyjmujące odpowiedź ustną (SPEC §12.5–12.6). */
const SPEECH_EXERCISES: ReadonlySet<string> = new Set(["recall", "speech"]);

function unevaluated(reason: SkillGrade["reason"]): SkillGrade {
  return { outcome: "unevaluated", reason, independent: false, confirmationEligible: false };
}

/**
 * Analizuje nagranie poza transakcją (arch §10–11): najpierw STT ustala treść,
 * a ocena wymowy wykonywana jest względem kanonicznej odpowiedzi tylko wtedy,
 * gdy dziecko rzeczywiście ją wypowiedziało. Błędy i przerwania zwracają
 * statusy porażki zamiast wyjątków — bajty i transkrypcja nie trafiają do logów.
 */
export async function analyzeSpeech(
  services: Services,
  audio: AudioInput,
  key: AnswerKey,
  signal?: AbortSignal,
): Promise<SpeechEvidence> {
  const deps = services.speech;
  if (!deps) {
    throw new AppError("internal", { message: "speech providers are not configured" });
  }
  const timeoutMs = deps.analysisTimeoutMs ?? SPEECH_ANALYSIS_TIMEOUT_MS;
  const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);

  const transcription = await deps.stt.transcribe(audio, deadline).then(
    (result) => (deadline.aborted ? { status: "failed" as const, text: null, confidence: null } : result),
    () => ({ status: "failed" as const, text: null, confidence: null }),
  );

  let pronunciation: SpeechEvidence["pronunciation"] = null;
  if (transcription.status === "ok" && transcription.text !== null && normalizeSpokenAnswerText(transcription.text) !== "") {
    const match = matchSpokenAnswer(transcription.text, key);
    if (match.ci && match.matchedVariant && match.matchedVariant.toLowerCase() === key.target.toLowerCase()) {
      const result = await deps.pronunciation.assess(audio, key.target, deadline).then(
        (scored) => (deadline.aborted ? ({ status: "failed", overallScore: null, recognizedText: null } satisfies PronunciationResult) : scored),
        () => ({ status: "failed" as const, overallScore: null, recognizedText: null }),
      );
      pronunciation = { ...result, provider: deps.pronunciation.name, expectedText: key.target };
    }
  }
  return { sttProvider: deps.stt.name, transcription, pronunciation };
}

/**
 * STT may add sentence punctuation around a one-word reply (for example a
 * trailing period). Ignore only boundary punctuation when matching speech;
 * punctuation inside a word remains significant. Typed spelling keeps its
 * existing strict comparison.
 */
function matchSpokenAnswer(answer: string, key: AnswerKey) {
  return matchWrittenAnswer(normalizeSpokenAnswerText(answer), key);
}

function speechFeedbackFor(
  recognition: SpeechFeedback["recognition"],
  pronunciation: SpeechFeedback["pronunciation"],
  referenceText?: string,
): SpeechFeedback {
  return { recognition, pronunciation, ...(referenceText ? { referenceText } : {}) };
}

/**
 * Ocena dowodów z nagrania według klucza i zamrożonego kontekstu (arch §11).
 * Treść zalicza wyłącznie dopasowanie transkrypcji do klucza i zatwierdzonych
 * wariantów — nigdy score wymowy oczekiwanego tekstu. Wynik wymowy względem
 * innego tekstu niż wypowiedziany wariant nie jest przenoszony; bez pasm
 * skalibrowanych w polityce wynik wymowy pozostaje nieocenioną daną.
 */
export function assessSpeechEvidence(
  evidence: SpeechEvidence,
  key: AnswerKey,
  ctx: EvaluationContext,
): Grade {
  const t = evidence.transcription;
  // w ćwiczeniu wymowy wzorzec jest oczekiwaną częścią nauki (SPEC §13.2)
  const attempt = qualifyAttempt(
    key.exerciseType === "speech"
      ? { ...ctx, assistance: ctx.assistance.filter((kind) => kind !== "model_audio") }
      : ctx,
  );
  const skills: Partial<Record<Skill, SkillGrade>> = {};
  const assessesContent = key.exerciseType !== "speech";

  if (t.status !== "ok" || t.text === null || normalizeSpokenAnswerText(t.text) === "") {
    const reason: SkillGrade["reason"] = "technical";
    if (assessesContent) skills.recall = unevaluated(reason);
    skills.pronunciation = unevaluated(reason);
    return {
      skills,
      attempt,
      speechFeedback: speechFeedbackFor(t.status === "no_speech" || (t.status === "ok" && (t.text === null || normalizeSpokenAnswerText(t.text) === "")) ? "no_speech" : "unavailable", "not_applicable"),
    };
  }

  const match = matchSpokenAnswer(t.text!, key);
  if (!match.ci && t.confidence !== null && t.confidence < MIN_STT_CONFIDENCE) {
    if (assessesContent) skills.recall = unevaluated("ambiguous");
    skills.pronunciation = unevaluated("ambiguous");
    return { skills, attempt, speechFeedback: speechFeedbackFor("uncertain", "not_applicable") };
  }
  // Pokazujemy dziecku rozpoznany tekst wyłącznie wtedy, gdy nie został
  // odrzucony jako niepewny. To wynik STT, nie zapis dźwięku ani score.
  // W mowie wielkość liter nie jest cechą fonetyczną — dopasowujemy wielkość liter
  // do wariantu wzorca, aby uniknąć mylących komunikatów (np. Purple vs purple).
  const rawRecognized = normalizeSpokenAnswerText(t.text).slice(0, 200) || undefined;
  const trimmedTarget = key.target.trim();
  const targetIsLowercase = trimmedTarget.length > 0 && trimmedTarget[0] === trimmedTarget[0]!.toLowerCase();
  const recognizedText = match.ci && match.matchedVariant
    ? match.matchedVariant
    : rawRecognized !== undefined && targetIsLowercase
      ? rawRecognized.toLowerCase()
      : rawRecognized;
  const recognized = recognizedText ? { recognizedText } : {};

  // ćwiczenie wymowy: treść wypowiedzi decyduje o wykonaniu zadania —
  // ocena wymowy może pozostać nieoceniona (§12.6, §15.4)
  const speechAttempt = key.exerciseType === "speech" ? { contentMatched: match.ci } : undefined;
  const recognition: SpeechFeedback["recognition"] = match.ci ? "matched" : "different";
  const referenceText = match.matchedVariant ?? key.target;
  const pronunciationStatus = (): SpeechFeedback["pronunciation"] => {
    if (!match.ci || !match.matchedVariant || match.matchedVariant.toLowerCase() !== key.target.toLowerCase()) return "not_applicable";
    const result = evidence.pronunciation;
    if (!result || result.status !== "ok" || result.overallScore === null) return result?.status === "failed" ? "unavailable" : "unavailable";
    const configured = ctx.policy.pronunciationBands[result.provider];
    if (!configured) return "not_configured";
    if (result.overallScore >= configured.correctMinScore) return "good";
    if (result.overallScore >= configured.partialMinScore) return "practice";
    return "unreliable";
  };
  const speechFeedback = speechFeedbackFor(recognition, pronunciationStatus(), referenceText);
  if (assessesContent) {
    skills.recall = {
      outcome: match.ci ? "correct" : "incorrect",
      independent: attempt.independent,
      confirmationEligible: attempt.independent && attempt.confirmationEligible && match.ci,
    };
  }

  const p = evidence.pronunciation;
  if (!match.ci || !match.matchedVariant) {
    // wiarygodny tekst spoza zatwierdzonego zbioru: wynik wymowy oczekiwanego
    // słowa byłby nieadekwatny — w ogóle go nie oceniamy (Review Focus 3)
    return { skills, attempt, ...recognized, speechFeedback, ...(speechAttempt ? { speechAttempt } : {}) };
  }
  if (!p || p.status !== "ok" || p.overallScore === null || p.expectedText.toLowerCase() !== match.matchedVariant.toLowerCase()) {
    // oceny nie ma albo dotyczy innego wariantu — pronunciation nieocenione
    skills.pronunciation = unevaluated(p?.status === "failed" ? "technical" : undefined);
    return { skills, attempt, ...recognized, speechFeedback, ...(speechAttempt ? { speechAttempt } : {}) };
  }

  const details: PronunciationDetails = { provider: p.provider, score: p.overallScore };
  const bands = ctx.policy.pronunciationBands[p.provider];
  if (!bands) {
    skills.pronunciation = { ...unevaluated(undefined), details: { pronunciation: details } };
    return { skills, attempt, ...recognized, speechFeedback, ...(speechAttempt ? { speechAttempt } : {}) };
  }
  const band: PronunciationDetails["band"] =
    p.overallScore >= bands.correctMinScore
      ? "correct"
      : p.overallScore >= bands.partialMinScore
        ? "partial"
        : "below";
  if (band === "below") {
    // poniżej progu „prawie” to niepewna ocena, nie błąd wiedzy (design
    // 2026-10-09, docs/speech-spike.md) — wynik zostaje w details dla rodzica
    skills.pronunciation = { ...unevaluated(undefined), details: { pronunciation: { ...details, band } } };
  } else {
    skills.pronunciation = {
      outcome: band === "correct" ? "correct" : "incorrect",
      independent: attempt.independent,
      confirmationEligible: attempt.independent && attempt.confirmationEligible && band === "correct",
      details: { pronunciation: { ...details, band } },
    };
  }
  const word =
    p.words?.length === 1 && p.words[0]!.text.toLowerCase() === match.matchedVariant.toLowerCase()
      ? p.words[0]
      : undefined;
  const speechFragments =
    band === "below"
      ? undefined
      : buildPronunciationFragments(match.matchedVariant, word, bands, band === "correct" ? "correct" : "partial");
  return {
    skills,
    attempt,
    ...recognized,
    speechFeedback,
    ...(speechAttempt ? { speechAttempt } : {}),
    ...(speechFragments ? { speechFragments } : {}),
  };
}

/** Dowody „nagranie było, analizy nie było” — np. brak skonfigurowanych kluczy. */
function unavailableEvidence(): SpeechEvidence {
  return {
    sttProvider: "none",
    transcription: { status: "failed", text: null, confidence: null },
    pronunciation: null,
  };
}

export interface SpeechAttemptInput {
  taskId: string;
  clientAttemptId: string;
}

/**
 * Ścieżka mowy (arch §10): rezerwuje próbę processing z zamrożonym kontekstem,
 * analizuje nagranie poza transakcją i atomowo finalizuje wynik. Retry dla
 * próby processing zwraca ten sam rekord bez drugiej płatnej analizy; awaria
 * kończy się próbą techniczną — bez fałszywego sukcesu i bez obniżania postępu.
 */
export async function submitSpeechAttempt(
  services: Services,
  input: SpeechAttemptInput,
  audio: AudioInput,
  signal?: AbortSignal,
): Promise<AttemptDto> {
  const valid = AttemptInputSchema.parse({ ...input, modality: "audio" }) as Extract<
    AttemptInput,
    { modality: "audio" }
  >;
  const normalized = normalizeAudioInput(audio);

  const reserved = await services.db.transaction(async (tx) => {
    const started = await startAttempt(tx, services, valid);
    if (started.kind !== "fresh") {
      return started;
    }
    if (!SPEECH_EXERCISES.has(started.task.exerciseType)) {
      throw new AppError("validation", { message: "task does not take speech answers" });
    }
    const targetLocale = (
      await tx
        .select({ locale: deckVersions.targetLocale })
        .from(itemRevisions)
        .innerJoin(deckVersions, eq(deckVersions.id, itemRevisions.deckVersionId))
        .where(eq(itemRevisions.id, started.task.itemRevisionId))
    )[0]!.locale;
    const attemptId = randomUUID();
    await tx.insert(attempts).values({
      id: attemptId,
      childId: started.task.childId,
      taskId: started.task.id,
      itemRevisionId: started.task.itemRevisionId,
      clientAttemptId: valid.clientAttemptId,
      requestHash: started.requestHash,
      attemptNumber: started.attemptNumber,
      modality: "audio",
      state: "processing",
      answer: null,
      context: started.frozen as unknown as Record<string, unknown>,
      policyId: started.session.policyId,
      receivedAt: started.receivedAt,
    });
    return { ...started, attemptId, targetLocale };
  });
  if (reserved.kind !== "fresh") {
    return reserved.dto;
  }

  const analyze: AudioInput = {
    ...normalized,
    locale: reserved.targetLocale,
    durationMs: Math.round(normalized.durationSeconds * 1000),
  };
  const evidence = services.speech ? await analyzeSpeech(services, analyze, reserved.key, signal) : unavailableEvidence();
  const grade = assessSpeechEvidence(evidence, reserved.key, {
    ...reserved.frozen,
    policy: reserved.policy,
  });
  return finalizeAttempt(services, reserved.attemptId, grade, {
    transcript: evidence.transcription.text,
    sttProvider: evidence.sttProvider,
    pronunciationProvider: evidence.pronunciation?.provider ?? null,
  });
}
