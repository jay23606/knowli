import { describe, expect, it } from "vitest";
import { messages, type TaskDto, type TaskPrompt } from "@learning/contracts";
import { advanceSessionProgress, initialSessionProgress, progressAttempt } from "../components/session-progress-state";
import { frameGuidance, paneMountEffect, questionAudioPresentation, streakAttemptFor } from "./learn-screen-state";

const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const options = [{ id: id(10), text: "Sam" }, { id: id(11), text: "Mama" }, { id: id(12), text: "Nikt" }];
const story = { sentences: ["Sam has a red bike."] };

function task(n: number, prompt: TaskPrompt, remainingAssessed = 3): TaskDto {
  return { taskId: id(n), sessionId: id(1), ordinal: n, exerciseType: prompt.kind as TaskDto["exerciseType"], direction: null, state: "issued", prompt, remainingAssessed };
}
const choice = (n: number) => task(n, { kind: "lesson_choice", instructionPl: "Wybierz", stem: "He ___.", options: options.slice(0, 2) });
const storyQuestion = (n: number) => task(n, { kind: "lesson_story_question", question: "Kto ma rower?", options, story, questionAudioAssetId: id(50) }, 0);
const storyTask = (n: number) => task(n, { kind: "lesson_story", story, questionAudioAssetId: id(50) }, 0);
const card = (n: number) => task(n, { kind: "lesson_card", card: { title: "Reguła", body: "Dodaj -s", examples: [] }, questionAudioAssetId: id(51) } as TaskPrompt);
const shortAnswer = (n: number) => task(n, { kind: "lesson_short_answer", question: "Does he play?", options: options.slice(0, 2), questionAudioAssetId: id(52) } as TaskPrompt);

/** Tak jak `LearnScreen`: wynik pokazany w doku → próba serii przez selektor. */
function shownCorrect(state: typeof initialSessionProgress, shown: TaskDto, attemptId: string) {
  return advanceSessionProgress(state, {
    sessionId: shown.sessionId,
    remainingAssessed: shown.remainingAssessed,
    attempt: streakAttemptFor(shown, progressAttempt({
      taskId: shown.taskId,
      feedback: { attemptId, modality: "choice" },
      feedbackTone: "correct",
      revealShown: false,
    })),
  }, 3);
}

describe("learn screen state", () => {
  it("story question attempts do not change the streak or milestone", () => {
    let state = initialSessionProgress;
    state = shownCorrect(state, choice(2), "a1");
    state = shownCorrect(state, choice(3), "a2");
    expect(state).toMatchObject({ streak: 2, milestone: 0 });
    // Trzecia poprawna odpowiedź z rzędu dałaby gwiazdkę — ale to pytanie historyjki.
    state = shownCorrect(state, storyQuestion(4), "a3");
    expect(state).toMatchObject({ streak: 2, milestone: 0 });
    // Kolejne ocenione zadanie liczy się dalej od tej samej serii.
    state = shownCorrect(state, choice(5), "a4");
    expect(state).toMatchObject({ streak: 3, milestone: 1 });
  });

  it("a wrong story answer does not break the streak either", () => {
    const attempt = progressAttempt({ taskId: id(4), feedback: { attemptId: "a3", modality: "choice" }, feedbackTone: "incorrect", revealShown: false });
    expect(attempt).not.toBeNull();
    expect(streakAttemptFor(storyQuestion(4), attempt)).toBeNull();
    expect(streakAttemptFor(storyTask(4), attempt)).toBeNull();
    expect(streakAttemptFor(choice(4), attempt)).toBe(attempt);
    expect(streakAttemptFor(null, attempt)).toBe(attempt);
  });

  it("feedback hides the story listen button", () => {
    const listen = "story-listen";
    expect(frameGuidance({ guidanceInDock: true, instruction: null, question: listen })).toBeNull();
    expect(frameGuidance({ guidanceInDock: false, instruction: null, question: listen })).toBe(listen);
  });

  it("instruction guidance wins over the question audio outside the dock", () => {
    expect(frameGuidance({ guidanceInDock: false, instruction: "guidance", question: "question" })).toBe("guidance");
    expect(frameGuidance({ guidanceInDock: true, instruction: "guidance", question: "question" })).toBeNull();
    expect(frameGuidance({ guidanceInDock: false, instruction: null, question: null })).toBeNull();
  });

  it("pane mount autoplays only the current lesson story", () => {
    expect(paneMountEffect(storyTask(4), id(4))).toBe("play_story");
    expect(paneMountEffect(storyTask(4), id(3))).toBeNull();
    expect(paneMountEffect(storyQuestion(5), id(5))).toBeNull();
    expect(paneMountEffect(card(6), id(6))).toBeNull();
    expect(paneMountEffect(task(7, { kind: "speech", visualType: "none", text: "cat", audioAssetId: null, imageAssetId: null }), id(7))).toBe("capture_speech");
    expect(paneMountEffect(null, id(7))).toBeNull();
  });

  it("controlled playing is passed only for story tasks", () => {
    expect(questionAudioPresentation(storyTask(4), id(4)).playing).toBe(true);
    expect(questionAudioPresentation(storyTask(4), id(9)).playing).toBe(false);
    expect(questionAudioPresentation(storyQuestion(5), id(5)).playing).toBe(true);
    expect(questionAudioPresentation(storyQuestion(5), null).playing).toBe(false);
    expect(questionAudioPresentation(storyQuestion(5), undefined).playing).toBe(false);
    expect("playing" in questionAudioPresentation(card(6), id(6))).toBe(false);
    expect("playing" in questionAudioPresentation(shortAnswer(7), id(7))).toBe(false);
  });

  it("story tasks use the story listen label and error texts", () => {
    for (const storyKind of [storyTask(4), storyQuestion(5)]) {
      expect(questionAudioPresentation(storyKind, null)).toMatchObject({
        label: messages.kid.listenLessonStory,
        errorText: messages.kid.storyAudioUnavailable,
        retryText: messages.kid.storyAudioRetry,
      });
    }
    expect(questionAudioPresentation(card(6), null)).toMatchObject({
      label: messages.kid.listenLessonCard,
      errorText: messages.kid.cardAudioUnavailable,
      retryText: messages.kid.cardAudioRetry,
    });
    expect(questionAudioPresentation(shortAnswer(7), null)).toMatchObject({
      label: messages.kid.listenLessonQuestion,
      errorText: messages.kid.questionAudioUnavailable,
      retryText: messages.kid.questionAudioRetry,
    });
  });
});
