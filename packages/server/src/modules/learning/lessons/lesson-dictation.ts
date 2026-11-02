import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DictationDto } from "@learning/contracts";
import type { Services } from "../../../config";
import { learningSessions } from "../../../db/schema";
import { AppError } from "../../../errors";
import {
  classifyDictation,
  comparableDictationText,
  DEFAULT_DICTATION_POLICY,
  type DictationTranscription,
} from "../../../domain/lessons/dictation";
import type { AudioInput } from "../../../ports/ai";
import { withUsageScope } from "../../../ports/usage";
import { normalizeAudioInput } from "../../../providers/audio/normalize";
import { lockTaskWithSession } from "../events";
import { SPEECH_ANALYSIS_TIMEOUT_MS } from "../speech";
import { lessonContextOf } from "./lesson-sessions";

/**
 * Dyktowanie odpowiedzi otwartej lekcji (design szkoły §5.3–5.8). Zwraca tekst
 * do pola odpowiedzi albo powód jego braku; nie tworzy próby, oceny ani
 * ekspozycji. Nagranie żyje wyłącznie w pamięci żądania, a transkrypcja nie
 * trafia do logów ani do bazy — w kontekście sesji zostaje tylko jej skrót,
 * żeby odpowiedź mogła później wiarygodnie zadeklarować `inputMethod: "speech"`.
 */

/** Klucz kontekstu sesji: skróty ostatniego dyktowania per zadanie. */
export interface DictationSessionState {
  dictationCalls: number;
  dictations: Record<string, string>;
}

export function dictationStateOf(context: Record<string, unknown>): DictationSessionState {
  const calls = context.dictationCalls;
  const raw = context.dictations;
  const dictations: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [taskId, fingerprint] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof fingerprint === "string") dictations[taskId] = fingerprint;
    }
  }
  return { dictationCalls: typeof calls === "number" ? calls : 0, dictations };
}

/** Skrót porównywalnej postaci tekstu — tekst dziecka nie trafia do kontekstu sesji. */
export function dictationFingerprint(text: string): string {
  return createHash("sha256").update(comparableDictationText(text)).digest("hex");
}

export async function dictateLessonAnswer(
  services: Services,
  input: { taskId: string },
  audio: AudioInput,
  signal?: AbortSignal,
): Promise<DictationDto> {
  // Limit czasu przed jakimkolwiek zapisem: zbyt długie nagranie to błąd walidacji.
  const normalized = normalizeAudioInput(audio, DEFAULT_DICTATION_POLICY.maxSeconds);

  // T1 (blokada sesji): autoryzacja i księgowanie limitu kosztu.
  const reserved = await services.db.transaction(async (tx) => {
    const { task, session, lessonContext } = await lockTaskWithSession(tx, input.taskId);
    if (!task.exerciseType.startsWith("lesson_") || !lessonContext) {
      throw new AppError("validation", { message: "task does not take dictation" });
    }
    if (session.state !== "active" || task.state !== "issued") {
      throw new AppError("conflict", { message: "task is no longer issued" });
    }
    const subject = services.subjects.getSubject(lessonContextOf({ lessonContext }).subjectId);
    const prompt = task.publicPrompt as { speechInput?: unknown } | null;
    // Zamrożony prompt decyduje: mikrofon był zaoferowany przy wydaniu zadania.
    if (!subject?.spokenAnswers || !prompt?.speechInput || session.mode !== "training" || !session.microphoneEnabled) {
      throw new AppError("validation", { message: "task does not take dictation" });
    }
    if (!services.lessonSpeech) return { kind: "unavailable" as const };
    const state = dictationStateOf(session.context);
    if (state.dictationCalls >= DEFAULT_DICTATION_POLICY.maxCallsPerSession) return { kind: "unavailable" as const };
    await tx.update(learningSessions)
      .set({ context: { ...session.context, dictationCalls: state.dictationCalls + 1 } })
      .where(eq(learningSessions.id, session.id));
    return { kind: "transcribe" as const, sessionId: session.id, childId: session.childId, locale: subject.spokenAnswers.locale };
  });
  if (reserved.kind === "unavailable") return { status: "unavailable" };

  // Poza transakcją: STT z deadlinem i sygnałem przerwania żądania; awaria = brak tekstu.
  const deps = services.lessonSpeech!;
  const deadline = AbortSignal.any([AbortSignal.timeout(deps.timeoutMs ?? SPEECH_ANALYSIS_TIMEOUT_MS), ...(signal ? [signal] : [])]);
  // Koszt dyktowania należy do sesji i dziecka (spec kosztów §4.1); zakres tylko wokół STT.
  const transcription: DictationTranscription = await withUsageScope({ sessionId: reserved.sessionId, childId: reserved.childId }, () => deps.stt
    .transcribe({
      bytes: normalized.bytes,
      mimeType: normalized.mimeType,
      locale: reserved.locale,
      durationMs: Math.round(normalized.durationSeconds * 1000),
    }, deadline))
    .then(
      (result) => (deadline.aborted ? { status: "failed" as const, text: null, confidence: null } : result),
      (error: unknown) => {
        // Odrzucony klucz wygląda dla dziecka jak „nie usłyszałem” — operator dostaje
        // jedną linię bez treści, nagrania i identyfikatorów.
        if (error instanceof AppError) console.error(`[lesson-dictation] STT ${deps.publicService}: ${error.message}`);
        return { status: "failed" as const, text: null, confidence: null };
      },
    );
  const result = classifyDictation(transcription);
  if (result.status !== "heard") return result;

  // T2: skrót tekstu dla późniejszej deklaracji `inputMethod`, tylko gdy zadanie nadal czeka.
  await services.db.transaction(async (tx) => {
    const { task, session } = await lockTaskWithSession(tx, input.taskId);
    if (session.id !== reserved.sessionId || session.state !== "active" || task.state !== "issued") return;
    const state = dictationStateOf(session.context);
    await tx.update(learningSessions)
      .set({ context: { ...session.context, dictations: { ...state.dictations, [task.id]: dictationFingerprint(result.text) } } })
      .where(eq(learningSessions.id, session.id));
  });
  return result;
}
