import { describe, expect, it } from "vitest";
import { findExposureLeaks, resolveGenerationLeaks } from "./exposure-leaks";
import { englishChapterSubject } from "./subjects/english-chapter/module";
import { englishGrammarSubject } from "./subjects/english-grammar/module";
import { schoolSubject } from "./subjects/school/module";
import type { LessonExerciseDraft } from "./types";

const A = "english_chapter.ddeck.home";
const B = "english_chapter.ddeck.feelings";

function draft(overrides: Partial<LessonExerciseDraft>): LessonExerciseDraft {
  return { exerciseType: "lesson_open_answer", objectiveId: A, answer: "", acceptedAnswers: [], focus: [], ...overrides };
}

/** Luka rozdziału: zdanie ze wstawioną odpowiedzią to tekst ekspozycji. */
function gap(stem: string, answer: string, objectiveId = A): LessonExerciseDraft {
  return draft({ exerciseType: "lesson_gap", objectiveId, stem, answer, focus: [answer] });
}

function translation(answer: string, overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return draft({ exerciseType: "lesson_open_answer", prompt: "Przetłumacz.", answer, ...overrides });
}

const MODES = ["coverage", "generation"] as const;

describe("findExposureLeaks", () => {
  it.each(MODES)("rozdział (%s): luka „It's under the ___” → bed ujawnia tłumaczenie „It's under the bed.” — hard, source exercise", (mode) => {
    const leaks = findExposureLeaks({
      exercises: [gap("It's under the ___.", "bed"), translation("It's under the bed.")],
      examples: {},
      objectiveOrder: [A],
      subject: englishChapterSubject,
      mode,
    });
    expect(leaks).toEqual([{ index: 1, kind: "hard", source: { kind: "exercise", index: 0 } }]);
  });

  it.each(MODES)("rozdział (%s): przykład karty zagadnienia A ujawnia tłumaczenie w zagadnieniu B — hard, card_example z objectiveId A", (mode) => {
    const leaks = findExposureLeaks({
      exercises: [translation("I'm hungry.", { objectiveId: B })],
      examples: { [A]: ["I'm hungry."], [B]: ["I'm happy."] },
      objectiveOrder: [A, B],
      subject: englishChapterSubject,
      mode,
    });
    expect(leaks).toEqual([{ index: 0, kind: "hard", source: { kind: "card_example", objectiveId: A, text: "I'm hungry." } }]);
  });

  it.each(MODES)("gramatyka (%s): luka z odpowiedzią „plays” nie ujawnia tłumaczenia „He plays football.”", (mode) => {
    const leaks = findExposureLeaks({
      exercises: [gap("He ___ football.", "plays"), translation("He plays football.")],
      examples: {},
      objectiveOrder: [A],
      subject: englishGrammarSubject,
      mode,
    });
    expect(leaks).toEqual([]);
  });

  it("szkoła: trzy open_answer z jedną odpowiedzią — pierwszy bez wpisu, dwa kolejne soft", () => {
    const same = () => draft({ prompt: "Stolica Polski?", answer: "Warszawa" });
    for (const mode of MODES) {
      const leaks = findExposureLeaks({
        exercises: [same(), same(), same()],
        examples: {},
        objectiveOrder: [A],
        subject: schoolSubject,
        mode,
      });
      expect(leaks).toEqual([
        { index: 1, kind: "soft", source: { kind: "exercise", index: 0 } },
        { index: 2, kind: "soft", source: { kind: "exercise", index: 0 } },
      ]);
    }
  });

  it.each(MODES)("„Posłuchaj i wybierz” (%s) z rozwiązanym zdaniem równym tłumaczeniu → hard", (mode) => {
    const listen = draft({
      exerciseType: "lesson_listen_choice",
      stem: "It's ___ the bed.",
      options: [
        { id: "a", text: "under" },
        { id: "b", text: "on" },
      ],
      correctOption: "a",
      answer: "under",
    });
    const leaks = findExposureLeaks({
      exercises: [listen, translation("It's under the bed.")],
      examples: {},
      objectiveOrder: [A],
      subject: englishChapterSubject,
      mode,
    });
    expect(leaks).toEqual([{ index: 1, kind: "hard", source: { kind: "exercise", index: 0 } }]);
  });

  it("gramatyka: „She goes to school.” vs „She goes to school” — generation: hard; coverage: []", () => {
    const base = {
      exercises: [translation("She goes to school.")],
      examples: { [A]: ["She goes to school"] },
      objectiveOrder: [A],
      subject: englishGrammarSubject,
    } as const;
    expect(findExposureLeaks({ ...base, mode: "coverage" })).toEqual([]);
    expect(findExposureLeaks({ ...base, mode: "generation" })).toEqual([
      { index: 0, kind: "hard", source: { kind: "card_example", objectiveId: A, text: "She goes to school" } },
    ]);
  });

  it("rozdział generation: wariant „Where is the box?” vs przykład karty „Where's the box?” → hard; coverage: []", () => {
    const base = {
      exercises: [translation("Where is the box?")],
      examples: { [A]: ["Where's the box?"] },
      objectiveOrder: [A],
      subject: englishChapterSubject,
    } as const;
    expect(findExposureLeaks({ ...base, mode: "coverage" })).toEqual([]);
    expect(findExposureLeaks({ ...base, mode: "generation" })).toEqual([
      { index: 0, kind: "hard", source: { kind: "card_example", objectiveId: A, text: "Where's the box?" } },
    ]);
    // Zaakceptowany wariant ofiary też ujawnia (generation).
    const viaAccepted = findExposureLeaks({
      ...base,
      exercises: [translation("Where are you?", { acceptedAnswers: ["Where's the box?"] })],
      mode: "generation",
    });
    expect(viaAccepted).toHaveLength(1);
  });

  it("soft po objectiveOrder: grupa w zagadnieniach B (indeks 0) i A (indeks 5), order [A,B] → soft dostaje ćwiczenie z B", () => {
    const filler = (n: number) => translation(`Filler ${n}.`, { objectiveId: A });
    const leaks = findExposureLeaks({
      exercises: [
        translation("Same sentence.", { objectiveId: B }),
        filler(1),
        filler(2),
        filler(3),
        filler(4),
        translation("Same sentence.", { objectiveId: A }),
      ],
      examples: {},
      objectiveOrder: [A, B],
      subject: englishChapterSubject,
      mode: "coverage",
    });
    expect(leaks).toEqual([{ index: 0, kind: "soft", source: { kind: "exercise", index: 5 } }]);
  });

  it("ćwiczenie niesamodzielne nigdy nie jest ofiarą", () => {
    const choice = draft({
      exerciseType: "lesson_choice",
      stem: "I'm ___.",
      options: [
        { id: "a", text: "hungry" },
        { id: "b", text: "happy" },
      ],
      correctOption: "a",
      answer: "hungry",
    });
    for (const mode of MODES) {
      expect(
        findExposureLeaks({
          exercises: [gap("I'm ___.", "hungry"), choice],
          examples: { [A]: ["I'm hungry."] },
          objectiveOrder: [A],
          subject: englishChapterSubject,
          mode,
        }),
      ).toEqual([]);
    }
  });
});

describe("resolveGenerationLeaks", () => {
  const base = { existingExamples: {}, newExamples: {}, objectiveOrder: [A], subject: englishChapterSubject } as const;

  it("świeże tłumaczenie = świeża luka → tłumaczenie w droppedFresh, luka zostaje", () => {
    const freshGap = gap("It's under the ___.", "bed");
    const freshTranslation = translation("It's under the bed.");
    const result = resolveGenerationLeaks({ ...base, existing: [], fresh: [freshGap, freshTranslation] });
    expect(result.keptFresh).toEqual([freshGap]);
    expect(result.droppedFresh).toEqual([freshTranslation]);
  });

  it("świeża luka i świeży wybór rozwiązują istniejące tłumaczenie → oba świeże w droppedFresh, istniejące zostaje", () => {
    const existing = translation("It's under the bed.");
    const freshGap = gap("It's under the ___.", "bed");
    const freshChoice = draft({
      exerciseType: "lesson_choice",
      stem: "It's ___ the bed.",
      options: [
        { id: "a", text: "under" },
        { id: "b", text: "on" },
      ],
      correctOption: "a",
      answer: "under",
    });
    const unrelated = gap("I'm ___.", "hungry");
    const result = resolveGenerationLeaks({ ...base, existing: [existing], fresh: [freshGap, freshChoice, unrelated] });
    expect(result.droppedFresh).toEqual([freshGap, freshChoice]);
    expect(result.keptFresh).toEqual([unrelated]);
  });

  it("nowy przykład równy istniejącemu tłumaczeniu → przykład odpada, droppedExampleCount 1; gdy to jedyny nowy przykład zagadnienia — klucza brak w keptNewExamples", () => {
    const existing = translation("I'm hungry.");
    const result = resolveGenerationLeaks({
      ...base,
      existing: [existing],
      fresh: [],
      existingExamples: { [A]: ["I'm happy."] },
      newExamples: { [A]: ["I'm hungry."], [B]: ["I'm tired.", "I'm hungry!"] },
    });
    expect(result.droppedExampleCount).toBe(2);
    expect(result.keptNewExamples).toEqual({ [B]: ["I'm tired."] });
    expect(A in result.keptNewExamples).toBe(false);
  });

  it("nowy przykład ujawniający świeże tłumaczenie → świeże tłumaczenie w droppedFresh, przykład zostaje", () => {
    const freshTranslation = translation("I'm tired.");
    const result = resolveGenerationLeaks({
      ...base,
      existing: [],
      fresh: [freshTranslation],
      newExamples: { [B]: ["I'm tired."] },
    });
    expect(result.droppedFresh).toEqual([freshTranslation]);
    expect(result.keptNewExamples).toEqual({ [B]: ["I'm tired."] });
    expect(result.droppedExampleCount).toBe(0);
  });

  it("szkolna rodzina świeżych open_answer → nic nie usuwa", () => {
    const family = [1, 2, 3].map(() => draft({ prompt: "Stolica Polski?", answer: "Warszawa" }));
    const result = resolveGenerationLeaks({ ...base, subject: schoolSubject, existing: [], fresh: family });
    expect(result.keptFresh).toEqual(family);
    expect(result.droppedFresh).toEqual([]);
    expect(result.droppedExampleCount).toBe(0);
  });

  it("ofiara i źródło istniejące → nic nie usuwa", () => {
    const existing = [gap("It's under the ___.", "bed"), translation("It's under the bed.")];
    const unrelated = gap("I'm ___.", "hungry");
    const result = resolveGenerationLeaks({ ...base, existing, fresh: [unrelated] });
    expect(result.keptFresh).toEqual([unrelated]);
    expect(result.droppedFresh).toEqual([]);
  });

  describe("fixedSources", () => {
    const withExamples = {
      ...base,
      existing: [],
      existingExamples: { [A]: ["Old."] },
      newExamples: { [A]: ["New one."] },
    } as const;

    it("stałe zdanie zagadnienia przeżywa zastąpienie przykładów nowymi → świeże tłumaczenie w droppedFresh, nowe przykłady bez zmian", () => {
      const freshTranslation = translation("We have a cat");
      const result = resolveGenerationLeaks({
        ...withExamples,
        fresh: [freshTranslation],
        fixedSources: { [A]: ["We have a cat."] },
      });
      expect(result.droppedFresh).toEqual([freshTranslation]);
      expect(result.keptFresh).toEqual([]);
      expect(result.keptNewExamples).toEqual({ [A]: ["New one."] });
      expect(result.droppedExampleCount).toBe(0);
    });

    it("bez fixedSources to samo tłumaczenie zostaje w keptFresh (dotychczasowe zachowanie)", () => {
      const freshTranslation = translation("We have a cat");
      const result = resolveGenerationLeaks({ ...withExamples, fresh: [freshTranslation] });
      expect(result.keptFresh).toEqual([freshTranslation]);
      expect(result.droppedFresh).toEqual([]);
    });

    it("pusty fixedSources daje wynik identyczny jak bez parametru", () => {
      const fresh = [translation("We have a cat"), gap("I'm ___.", "hungry")];
      expect(resolveGenerationLeaks({ ...withExamples, fresh, fixedSources: {} })).toEqual(
        resolveGenerationLeaks({ ...withExamples, fresh }),
      );
    });

    it("stałe źródła doklejają się do przykładów zagadnienia (konkatenacja), nie zastępują ich", () => {
      const freshTranslation = translation("We have a cat");
      const result = resolveGenerationLeaks({
        ...base,
        existing: [],
        fresh: [freshTranslation],
        existingExamples: { [A]: ["We have a cat."] },
        newExamples: {},
        fixedSources: { [A]: ["Card."] },
      });
      expect(result.droppedFresh).toEqual([freshTranslation]);
      expect(result.keptFresh).toEqual([]);
    });

    it("zagadnienie bez przykładów: same stałe źródła wystarczają do odrzucenia", () => {
      const freshTranslation = translation("We have a cat");
      const result = resolveGenerationLeaks({
        ...base,
        existing: [],
        fresh: [freshTranslation],
        existingExamples: {},
        fixedSources: { [A]: ["We have a cat."] },
      });
      expect(result.droppedFresh).toEqual([freshTranslation]);
      expect(result.keptFresh).toEqual([]);
    });

    it("stałe zdanie nie wpływa na filtr nowych przykładów: nowy przykład równy stałemu zdaniu zostaje", () => {
      const result = resolveGenerationLeaks({
        ...base,
        existing: [],
        fresh: [],
        newExamples: { [A]: ["We have a cat."] },
        fixedSources: { [A]: ["We have a cat."] },
      });
      expect(result.keptNewExamples).toEqual({ [A]: ["We have a cat."] });
      expect(result.droppedExampleCount).toBe(0);
    });
  });
});
