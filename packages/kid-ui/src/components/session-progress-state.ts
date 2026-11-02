import { isLessonStoryTaskType, type TaskDto } from "@learning/contracts";

/** Client-side view of session progress: the bar and the correct-answer
 * streak are decoration only; nothing here is sent to the server or
 * affects grading. Total = the largest remaining count seen in a session
 * (the server's task budget minus tasks assessed before the first one
 * this client saw), so a resumed session starts part-way, never past full. */
export interface SessionProgressState {
  sessionId: string | null;
  total: number;
  /** Attempts already counted, so re-renders never count one twice. */
  lastAttemptId: string | null;
  streak: number;
  /** Bumps each time the streak reaches a multiple of the streak length. */
  milestone: number;
}

export const initialSessionProgress: SessionProgressState = {
  sessionId: null,
  total: 0,
  lastAttemptId: null,
  streak: 0,
  milestone: 0,
};

export type FeedbackOutcome = "correct" | "wrong" | "neutral";

/** Tone of the result the child actually sees (the feedback dock tone). */
export type ShownResultTone = "correct" | "incorrect" | "partial" | "technical" | "neutral";

/** Correct / wrong exactly as the shown result says, so a celebration never
 * contradicts the dock (e.g. a matched word with pronunciation to practise
 * is "partial", not correct). Skip and technical results never break the
 * streak; "nie pamiętam" is a difficulty, so it does. */
export function resultOutcome(tone: ShownResultTone, modality: string): FeedbackOutcome {
  if (modality === "skip") return "neutral";
  if (modality === "dont_remember") return "wrong";
  switch (tone) {
    case "correct": return "correct";
    case "incorrect":
    case "partial": return "wrong";
    default: return "neutral";
  }
}

/** The attempt the streak should see on this screen: a shown result, or a
 * revealed answer after "nie pamiętam" (that path skips the result dock). */
export function progressAttempt(screen: {
  taskId: string | null;
  feedback: { attemptId: string; modality: string } | null;
  feedbackTone: ShownResultTone | null;
  revealShown: boolean;
}): { attemptId: string; outcome: FeedbackOutcome } | null {
  if (screen.feedback !== null && screen.feedbackTone !== null) {
    return { attemptId: screen.feedback.attemptId, outcome: resultOutcome(screen.feedbackTone, screen.feedback.modality) };
  }
  if (screen.revealShown && screen.taskId !== null) {
    return { attemptId: `reveal:${screen.taskId}`, outcome: "wrong" };
  }
  return null;
}

/** Whether a task's results may move the streak and its milestone star.
 * Story tasks (the closing story and its questions) are answered outside the
 * session budget and progress, so they never change the streak (stage 3,
 * ruling 12). Without a task there is no attempt to filter. */
export function countsTowardStreak(task: Pick<TaskDto, "exerciseType"> | null): boolean {
  return task === null || !isLessonStoryTaskType(task.exerciseType);
}

export function advanceSessionProgress(
  state: SessionProgressState,
  event: {
    sessionId: string;
    remainingAssessed: number | null;
    attempt: { attemptId: string; outcome: FeedbackOutcome } | null;
  },
  streakLength: number,
): SessionProgressState {
  let next = state.sessionId === event.sessionId ? state : { ...initialSessionProgress, sessionId: event.sessionId };
  if (event.remainingAssessed !== null && event.remainingAssessed > next.total) {
    next = { ...next, total: event.remainingAssessed };
  }
  const attempt = event.attempt;
  if (attempt === null || attempt.attemptId === next.lastAttemptId) return next;
  if (attempt.outcome === "correct") {
    const streak = next.streak + 1;
    return { ...next, lastAttemptId: attempt.attemptId, streak, milestone: streak % streakLength === 0 ? next.milestone + 1 : next.milestone };
  }
  return { ...next, lastAttemptId: attempt.attemptId, streak: attempt.outcome === "wrong" ? 0 : next.streak };
}

/** Assessed tasks already done: total minus the tasks still waiting, within 0..total. */
export function progressDone(total: number, remainingAssessed: number | null): number {
  if (total <= 0 || remainingAssessed === null) return 0;
  return Math.min(total, Math.max(0, total - remainingAssessed));
}
