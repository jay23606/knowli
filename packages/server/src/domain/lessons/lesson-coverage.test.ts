import { describe, expect, it } from "vitest";
import { DISTINCT_OPEN_ANSWERS_PER_OBJECTIVE, lessonCoverageGaps, lessonPoolMinimums } from "./lesson-coverage";
import { DEFAULT_LESSON_POLICY } from "./lesson-policy";
import { poolCoverage, type CoverageGap } from "./pool-validation";
import { englishChapterSubject } from "./subjects/english-chapter/module";
import { englishGrammarSubject } from "./subjects/english-grammar/module";
import { schoolSubject } from "./subjects/school/module";
import type { LessonExerciseDraft, SubjectModule } from "./types";

const A = "english_chapter.ddeck.home";
const B = "english_chapter.ddeck.feelings";

function draft(overrides: Partial<LessonExerciseDraft>): LessonExerciseDraft {
  return { exerciseType: "lesson_open_answer", objectiveId: A, answer: "", acceptedAnswers: [], focus: [], ...overrides };
}

function translation(answer: string, overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return draft({ exerciseType: "lesson_open_answer", prompt: "Przetłumacz.", answer, ...overrides });
}

function choice(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return draft({ exerciseType: "lesson_choice", prompt: "Wybierz.", answer: "x", ...overrides });
}

function gapExercise(stem: string, answer: string, overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return draft({ exerciseType: "lesson_gap", stem, answer, focus: [answer], ...overrides });
}

/** Dawna implementacja z `lesson-api.ts` (przed ujawnieniami) — wzorzec zgodności dla pokrycia bez ujawnień. */
function legacyCoverage(
  subject: SubjectModule,
  drafts: readonly LessonExerciseDraft[],
  objectiveIds: readonly string[],
): CoverageGap[] {
  const base = poolCoverage(drafts, objectiveIds, subject.poolMinimums ?? DEFAULT_LESSON_POLICY.poolMinimums);
  const extra: CoverageGap[] = [];
  if (subject.usesV3Payload === true) {
    for (const objectiveId of objectiveIds) {
      const distinct = new Set(
        drafts
          .filter((d) => d.objectiveId === objectiveId && d.exerciseType === "lesson_open_answer")
          .map((d) => (subject.normalizer.normalize(d.answer)[0] ?? []).join(" ")),
      );
      if (distinct.size < 2) {
        extra.push({ objectiveId, stage: "independent", required: 2, actual: distinct.size });
      }
    }
  }
  return [...base, ...extra.filter((g) => !base.some((b) => b.objectiveId === g.objectiveId && b.stage === g.stage))];
}

describe("lessonPoolMinimums", () => {
  it("przedmiot bez poolMinimums → DEFAULT_LESSON_POLICY.poolMinimums", () => {
    expect(lessonPoolMinimums({})).toEqual(DEFAULT_LESSON_POLICY.poolMinimums);
  });

  it("przedmiot z poolMinimums → jego minima", () => {
    expect(lessonPoolMinimums(englishChapterSubject)).toEqual({ guided: 3, productive: 3, independent: 2 });
  });
});

describe("DISTINCT_OPEN_ANSWERS_PER_OBJECTIVE", () => {
  it("wymaga dwóch różnych odpowiedzi otwartych", () => {
    expect(DISTINCT_OPEN_ANSWERS_PER_OBJECTIVE).toBe(2);
  });
});

describe("lessonCoverageGaps", () => {
  it("tłumaczenie = przykład karty nie liczy się do independent → { stage: 'independent', actual: 1, required: 2, excluded: 1 }", () => {
    const gaps = lessonCoverageGaps({
      subject: englishChapterSubject,
      exercises: [
        choice(), choice(), choice(),
        gapExercise("It's under the ___.", "bed"), gapExercise("I am ___.", "happy"), gapExercise("She is ___.", "sad"),
        translation("I'm hungry."),
        translation("I'm thirsty."),
      ],
      examples: { [A]: ["I'm hungry."] },
      objectiveIds: [A],
    });
    expect(gaps).toEqual([{ objectiveId: A, stage: "independent", actual: 1, required: 2, excluded: 1 }]);
  });

  it("rodzina szkolna: trzy open_answer z jedną odpowiedzią → brak independent (2 różne wymagane), excluded 2", () => {
    const same = () => draft({ prompt: "Stolica Polski?", answer: "Warszawa" });
    const gaps = lessonCoverageGaps({
      subject: schoolSubject,
      exercises: [choice(), choice(), choice(), gapExercise("Rzeka to ___.", "Wisła"), gapExercise("Miasto to ___.", "Kraków"), same(), same(), same()],
      examples: {},
      objectiveIds: [A],
    });
    expect(gaps).toEqual([{ objectiveId: A, stage: "independent", actual: 1, required: 2, excluded: 2 }]);
  });

  it("bez ujawnień wynik równy dawnemu mergeCoverage(poolCoverage, distinctOpenAnswerGaps) — tabela 3 przedmiotów", () => {
    const base = [choice(), choice(), choice(), gapExercise("We have ___ cat.", "a"), gapExercise("I like ___.", "tea"), gapExercise("It is ___.", "red"), gapExercise("You ___ here.", "are")];
    const cases: { name: string; subject: SubjectModule; exercises: LessonExerciseDraft[] }[] = [];
    for (const [name, subject] of [["chapter", englishChapterSubject], ["grammar", englishGrammarSubject], ["school", schoolSubject]] as const) {
      cases.push({ name: `${name}: pusta pula`, subject, exercises: [] });
      cases.push({ name: `${name}: bez samodzielnych`, subject, exercises: base });
      cases.push({ name: `${name}: jedno pytanie otwarte`, subject, exercises: [...base, translation("Pierwsza odpowiedź")] });
      cases.push({ name: `${name}: dwa różne pytania`, subject, exercises: [...base, translation("Pierwsza odpowiedź"), translation("Druga odpowiedź")] });
    }
    for (const { name, subject, exercises } of cases) {
      const expected = legacyCoverage(subject, exercises, [A]);
      const actual = lessonCoverageGaps({ subject, exercises, examples: {}, objectiveIds: [A] });
      expect(actual, name).toEqual(expected);
    }
  });

  it("większy brak wygrywa: poolCoverage brak 0, reguła różnych odpowiedzi brak 1 → jeden wpis z brakiem 1", () => {
    const gaps = lessonCoverageGaps({
      subject: schoolSubject,
      exercises: [
        choice(), choice(), choice(),
        gapExercise("A ___.", "x"), gapExercise("B ___.", "y"),
        draft({ exerciseType: "lesson_calculation", prompt: "2+2", answer: "4" }),
        draft({ exerciseType: "lesson_calculation", prompt: "3+3", answer: "6" }),
        draft({ prompt: "Stolica Polski?", answer: "Warszawa" }),
      ],
      examples: {},
      objectiveIds: [A],
    });
    const independent = gaps.filter((gap) => gap.stage === "independent");
    expect(independent).toEqual([{ objectiveId: A, stage: "independent", required: 2, actual: 1 }]);
  });

  it("uwzględnia wiele zagadnień: wykluczenie liczone per zagadnienie", () => {
    const gaps = lessonCoverageGaps({
      subject: englishChapterSubject,
      exercises: [
        translation("I'm hungry.", { objectiveId: B }),
        translation("I'm cold.", { objectiveId: B }),
      ],
      examples: { [A]: ["I'm hungry."] },
      objectiveIds: [A, B],
    });
    expect(gaps.find((gap) => gap.objectiveId === B && gap.stage === "independent")).toEqual({
      objectiveId: B,
      stage: "independent",
      required: 2,
      actual: 1,
      excluded: 1,
    });
    expect(gaps.find((gap) => gap.objectiveId === A && gap.stage === "independent")?.excluded).toBeUndefined();
  });
});

describe("lessonCoverageGaps: ignoreExposure (raport przed/po)", () => {
  it("ignoreExposure liczy ujawnione ćwiczenia jak dawniej: brak znika i nie ma excluded", () => {
    const input = {
      subject: englishChapterSubject,
      exercises: [
        choice(), choice(), choice(),
        gapExercise("It's under the ___.", "bed"), gapExercise("I am ___.", "happy"), gapExercise("She is ___.", "sad"),
        translation("I'm hungry."),
        translation("I'm thirsty."),
      ],
      examples: { [A]: ["I'm hungry."] },
      objectiveIds: [A],
    };
    expect(lessonCoverageGaps(input)).toHaveLength(1);
    expect(lessonCoverageGaps({ ...input, ignoreExposure: true })).toEqual([]);
  });

  it("ignoreExposure równa się legacyCoverage także przy ujawnieniach", () => {
    const subject = schoolSubject;
    const exercises = [
      choice(), choice(), choice(), gapExercise("A ___.", "x"), gapExercise("B ___.", "y"), gapExercise("C ___.", "z"), gapExercise("D ___.", "w"),
      translation("Warszawa"), translation("Kraków"),
    ];
    expect(lessonCoverageGaps({ subject, exercises, examples: { [A]: ["Warszawa"] }, objectiveIds: [A], ignoreExposure: true }))
      .toEqual(legacyCoverage(subject, exercises, [A]));
  });
});
