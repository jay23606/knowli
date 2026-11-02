import type { ReactNode } from "react";
import { messages, type TaskDto } from "@learning/contracts";
import { countsTowardStreak, type progressAttempt } from "../components/session-progress-state";

/**
 * Czyste decyzje ekranu nauki (`LearnScreen`) wyjęte do testów jednostkowych:
 * w Vitest nie ma harnessu renderującego cały ekran, a całość potwierdza
 * mocked E2E. Ekran woła te funkcje dokładnie tak, jak robią to testy.
 */

type StreakAttempt = ReturnType<typeof progressAttempt>;

/** Próba widziana przez serię: pytania i historyjka nie ruszają serii ani gwiazdki. */
export function streakAttemptFor(task: TaskDto | null, attempt: StreakAttempt): StreakAttempt {
  return countsTowardStreak(task) ? attempt : null;
}

/**
 * Odsłuch w ramie zadania (wiersz instrukcji albo nagłówek karty/historyjki).
 * Przy widocznym wyniku odsłuch polecenia stoi w panelu wyniku, a odsłuchu
 * pytania/historyjki nie ma wcale — w ramie nie zostaje drugi głośnik.
 */
export function frameGuidance(args: { guidanceInDock: boolean; instruction: ReactNode | null; question: ReactNode | null }): ReactNode | null {
  return args.guidanceInDock ? null : args.instruction ?? args.question;
}

export type PaneMountEffect = "capture_speech" | "play_story" | null;

/**
 * Co robi zamontowanie panelu zadania (`TaskTransition`, `AnimatePresence
 * mode="wait"`): auto-nagrywanie mowy albo jednorazowe autoodtwarzanie
 * historyjki. Tylko dla bieżącego zadania; pytanie historyjki nie gra samo.
 */
export function paneMountEffect(task: Pick<TaskDto, "taskId" | "prompt"> | null, mountedTaskId: string): PaneMountEffect {
  if (task === null || mountedTaskId !== task.taskId) return null;
  switch (task.prompt.kind) {
    case "speech":
    case "picture_speech":
      return "capture_speech";
    case "lesson_story":
      return "play_story";
    default:
      return null;
  }
}

export interface QuestionAudioPresentation {
  label: string;
  errorText: string;
  retryText: string;
  /** Sterowany stan odtwarzania — tylko dla zadań historyjki (autoodtwarzanie kontrolera). */
  playing?: boolean;
}

/**
 * Etykieta, komunikaty błędu ręcznego odsłuchu i stan przycisku „Posłuchaj…”:
 * karta („Posłuchaj karty”), historyjka i jej pytania („Posłuchaj historyjki”,
 * pierścień także przy autoodtwarzaniu) albo pytanie lekcji.
 */
export function questionAudioPresentation(task: Pick<TaskDto, "taskId" | "prompt">, storyAudioPlaying: string | null | undefined): QuestionAudioPresentation {
  const kind = task.prompt.kind;
  if (kind === "lesson_story" || kind === "lesson_story_question") {
    return {
      label: messages.kid.listenLessonStory,
      errorText: messages.kid.storyAudioUnavailable,
      retryText: messages.kid.storyAudioRetry,
      playing: storyAudioPlaying === task.taskId,
    };
  }
  if (kind === "lesson_card") {
    return { label: messages.kid.listenLessonCard, errorText: messages.kid.cardAudioUnavailable, retryText: messages.kid.cardAudioRetry };
  }
  return { label: messages.kid.listenLessonQuestion, errorText: messages.kid.questionAudioUnavailable, retryText: messages.kid.questionAudioRetry };
}
