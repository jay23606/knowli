import { describe, expect, it } from "vitest";
import { computeTargetKey } from "../target-key";
import { exerciseExposureText, lessonExerciseTargetKey, lessonTextTargetKey } from "./exposure-key";
import { englishGrammarSubject } from "./subjects/english-grammar/module";
import { historyLikeSubject } from "./testing/history-like-subject";
import type { LessonExerciseDraft } from "./types";

function draft(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_gap",
    objectiveId: "o1",
    stem: "It's ___ today.",
    answer: "snowing",
    acceptedAnswers: [],
    focus: ["snowing"],
    ...overrides,
  };
}

describe("lessonExerciseTargetKey", () => {
  it("bez exposureText to computeTargetKey(answer, answerLocale) — gramatyka i inne przedmioty bez zmian", () => {
    expect(lessonExerciseTargetKey(englishGrammarSubject, draft())).toBe(computeTargetKey("snowing", "en-GB"));
    expect(lessonExerciseTargetKey(historyLikeSubject, draft({ answer: "966" }))).toBe(computeTargetKey("966", "pl-PL"));
  });

  it("z exposureText klucz pochodzi z jego wyniku, w języku odpowiedzi przedmiotu", () => {
    const subject = { ...englishGrammarSubject, exposureText: (d: LessonExerciseDraft) => `It's ${d.answer} today.` };
    const key = lessonExerciseTargetKey(subject, draft());
    expect(key).toBe(computeTargetKey("It's snowing today.", "en-GB"));
    expect(key).not.toBe(computeTargetKey("snowing", "en-GB"));
  });

  it("exposureText dostaje cały szkic", () => {
    const seen: LessonExerciseDraft[] = [];
    const subject = { ...englishGrammarSubject, exposureText: (d: LessonExerciseDraft) => { seen.push(d); return d.answer; } };
    const exercise = draft();
    lessonExerciseTargetKey(subject, exercise);
    expect(seen).toEqual([exercise]);
  });
});

describe("lessonTextTargetKey (tekst ujawniany wprost, np. przykład karty)", () => {
  /** Przedmiot z hakiem normalizacji: bez końcowej kropki. */
  const trimmingSubject = { ...englishGrammarSubject, normalizeExposureText: (text: string) => text.replace(/\.$/u, "") };

  it("przedmiot bez normalizeExposureText ma klucz computeTargetKey(text, answerLocale) — bez zmian", () => {
    expect(lessonTextTargetKey(englishGrammarSubject, "I'm wearing a coat.")).toBe(computeTargetKey("I'm wearing a coat.", "en-GB"));
    expect(lessonTextTargetKey(historyLikeSubject, "Mieszko I.")).toBe(computeTargetKey("Mieszko I.", "pl-PL"));
  });

  it("normalizeExposureText przedmiotu działa przed computeTargetKey", () => {
    expect(lessonTextTargetKey(trimmingSubject, "It's snowing.")).toBe(computeTargetKey("It's snowing", "en-GB"));
  });

  it("klucz ćwiczenia przechodzi przez tę samą normalizację (także domyślna odpowiedź)", () => {
    expect(lessonExerciseTargetKey(trimmingSubject, draft({ answer: "snowing." }))).toBe(computeTargetKey("snowing", "en-GB"));
    const withText = { ...trimmingSubject, exposureText: (d: LessonExerciseDraft) => `It's ${d.answer} today.` };
    expect(lessonExerciseTargetKey(withText, draft())).toBe(lessonTextTargetKey(withText, "It's snowing today."));
  });
});

describe("exerciseExposureText", () => {
  it("bez exposureText to odpowiedź kanoniczna", () => {
    expect(exerciseExposureText(englishGrammarSubject, draft())).toBe("snowing");
  });

  it("z exposureText to jego wynik dla całego szkicu", () => {
    const subject = { exposureText: (d: LessonExerciseDraft) => `It's ${d.answer} today.` };
    expect(exerciseExposureText(subject, draft())).toBe("It's snowing today.");
  });

  it("klucz celu ćwiczenia liczy się z tego samego tekstu", () => {
    const subject = { ...englishGrammarSubject, exposureText: (d: LessonExerciseDraft) => `It's ${d.answer} today.` };
    expect(lessonExerciseTargetKey(subject, draft())).toBe(computeTargetKey(exerciseExposureText(subject, draft()), "en-GB"));
  });
});
