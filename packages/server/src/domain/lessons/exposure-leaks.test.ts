import { describe, expect, it } from "vitest";
import { findExposureLeaks, sameQuestionFamily } from "./exposure-leaks";
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

  it("szkoła, familyRepeatsAllowed: rodzina pytań bez wpisów; pytanie spoza rodziny i inna rodzina nadal soft", () => {
    const family = (familyId: string | undefined, objectiveId = A) =>
      draft({ objectiveId, prompt: "Stolica Polski?", answer: "Warszawa", ...(familyId === undefined ? {} : { familyId }) });
    for (const mode of MODES) {
      const leaks = (exercises: LessonExerciseDraft[], objectiveOrder = [A]) =>
        findExposureLeaks({ exercises, examples: {}, objectiveOrder, subject: schoolSubject, mode, familyRepeatsAllowed: true });
      expect(leaks([family("f1"), family("f1"), family("f1")])).toEqual([]);
      // Inna rodzina, brak rodziny albo pusta rodzina: zwykłe miękkie ujawnienie.
      expect(leaks([family("f1"), family("f2")])).toEqual([{ index: 1, kind: "soft", source: { kind: "exercise", index: 0 } }]);
      expect(leaks([family(undefined), family("f1")])).toEqual([{ index: 1, kind: "soft", source: { kind: "exercise", index: 0 } }]);
      expect(leaks([family(" "), family(" ")])).toEqual([{ index: 1, kind: "soft", source: { kind: "exercise", index: 0 } }]);
      // Ta sama nazwa rodziny w innym zagadnieniu to inna rodzina.
      expect(leaks([family("f1", B), family("f1", A)], [B, A])).toEqual([{ index: 1, kind: "soft", source: { kind: "exercise", index: 0 } }]);
      // Najwcześniejsze źródło z tej samej rodziny nie zasłania późniejszego źródła spoza rodziny.
      expect(leaks([family("f1"), family(undefined), family("f1")])).toEqual([
        { index: 1, kind: "soft", source: { kind: "exercise", index: 0 } },
        { index: 2, kind: "soft", source: { kind: "exercise", index: 1 } },
      ]);
      // Źródła twarde (przykład karty) działają także w rodzinie.
      expect(findExposureLeaks({
        exercises: [family("f1"), family("f1")], examples: { [A]: ["Warszawa"] }, objectiveOrder: [A], subject: schoolSubject, mode, familyRepeatsAllowed: true,
      }).map((leak) => leak.kind)).toEqual(["hard", "hard"]);
    }
  });

  it("sameQuestionFamily: to samo zagadnienie i ta sama niepusta familyId", () => {
    expect(sameQuestionFamily(draft({ familyId: "f1" }), draft({ familyId: "f1" }))).toBe(true);
    expect(sameQuestionFamily(draft({ familyId: "f1" }), draft({ familyId: "f2" }))).toBe(false);
    expect(sameQuestionFamily(draft({ familyId: "f1" }), draft({ familyId: "f1", objectiveId: B }))).toBe(false);
    expect(sameQuestionFamily(draft({}), draft({}))).toBe(false);
    expect(sameQuestionFamily(draft({ familyId: "" }), draft({ familyId: "" }))).toBe(false);
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
