import { describe, expect, it } from "vitest";
import { advanceSessionProgress, countsTowardStreak, initialSessionProgress, progressAttempt, progressDone, resultOutcome, type FeedbackOutcome } from "./session-progress-state";

const correct = (attemptId: string) => ({ attemptId, outcome: "correct" as FeedbackOutcome });

describe("session progress state", () => {
  it("takes the largest remaining count of the session as its total", () => {
    let state = advanceSessionProgress(initialSessionProgress, { sessionId: "s1", remainingAssessed: 8, attempt: null }, 3);
    state = advanceSessionProgress(state, { sessionId: "s1", remainingAssessed: 7, attempt: null }, 3);
    expect(state.total).toBe(8);
    expect(progressDone(state.total, 7)).toBe(1);
    expect(progressDone(state.total, 1)).toBe(7);
  });

  it("starts over for a new session", () => {
    let state = advanceSessionProgress(initialSessionProgress, { sessionId: "s1", remainingAssessed: 8, attempt: correct("a1") }, 3);
    state = advanceSessionProgress(state, { sessionId: "s2", remainingAssessed: 4, attempt: null }, 3);
    expect(state).toMatchObject({ sessionId: "s2", total: 4, streak: 0, milestone: 0 });
  });

  it("counts each attempt once and marks every third correct answer in a row", () => {
    let state = initialSessionProgress;
    for (const id of ["a1", "a1", "a2", "a2", "a3"]) {
      state = advanceSessionProgress(state, { sessionId: "s1", remainingAssessed: 5, attempt: correct(id) }, 3);
    }
    expect(state).toMatchObject({ streak: 3, milestone: 1 });
  });

  it("resets the streak on a wrong answer but not on a skip or technical result", () => {
    let state = initialSessionProgress;
    state = advanceSessionProgress(state, { sessionId: "s1", remainingAssessed: 5, attempt: correct("a1") }, 3);
    state = advanceSessionProgress(state, { sessionId: "s1", remainingAssessed: 5, attempt: { attemptId: "a2", outcome: "neutral" } }, 3);
    expect(state.streak).toBe(1);
    state = advanceSessionProgress(state, { sessionId: "s1", remainingAssessed: 5, attempt: { attemptId: "a3", outcome: "wrong" } }, 3);
    expect(state.streak).toBe(0);
  });

  it("follows the tone of the result the child actually sees", () => {
    expect(resultOutcome("correct", "choice")).toBe("correct");
    expect(resultOutcome("incorrect", "text")).toBe("wrong");
    // A matched word with pronunciation to practise is shown as partial: no celebration.
    expect(resultOutcome("partial", "audio")).toBe("wrong");
    expect(resultOutcome("technical", "audio")).toBe("neutral");
    expect(resultOutcome("neutral", "skip")).toBe("neutral");
    expect(resultOutcome("neutral", "dont_remember")).toBe("wrong");
  });

  it("breaks the streak when an answer is revealed after \"nie pamiętam\"", () => {
    let state = initialSessionProgress;
    for (const id of ["a1", "a2"]) {
      state = advanceSessionProgress(state, { sessionId: "s1", remainingAssessed: 5, attempt: correct(id) }, 3);
    }
    const reveal = progressAttempt({ taskId: "t3", feedback: null, feedbackTone: null, revealShown: true });
    expect(reveal).toEqual({ attemptId: "reveal:t3", outcome: "wrong" });
    state = advanceSessionProgress(state, { sessionId: "s1", remainingAssessed: 4, attempt: reveal }, 3);
    state = advanceSessionProgress(state, { sessionId: "s1", remainingAssessed: 3, attempt: correct("a4") }, 3);
    expect(state).toMatchObject({ streak: 1, milestone: 0 });
  });

  it("sees no attempt while a task is simply waiting for an answer", () => {
    expect(progressAttempt({ taskId: "t1", feedback: null, feedbackTone: null, revealShown: false })).toBeNull();
  });

  it("never reports done tasks outside 0..total", () => {
    expect(progressDone(0, 3)).toBe(0);
    expect(progressDone(4, null)).toBe(0);
    expect(progressDone(4, 9)).toBe(0);
    expect(progressDone(4, 0)).toBe(4);
  });

  it("story tasks never count toward the streak; other tasks do", () => {
    expect(countsTowardStreak({ exerciseType: "lesson_choice" })).toBe(true);
    expect(countsTowardStreak({ exerciseType: "recall" })).toBe(true);
    expect(countsTowardStreak({ exerciseType: "lesson_story" })).toBe(false);
    expect(countsTowardStreak({ exerciseType: "lesson_story_question" })).toBe(false);
    // Bez zadania nic nie filtrujemy (próby i tak nie ma).
    expect(countsTowardStreak(null)).toBe(true);
  });
});
