import { describe, expect, it } from "vitest";
import { validateSubject } from "./catalog-validation";
import { createProductionSubjectRegistry, PRODUCTION_SUBJECTS } from "./subjects";
import { historyLikeSubject } from "./testing/history-like-subject";
import type { SubjectModule } from "./types";

/** Rekurencyjnie zdejmuje `readonly` — do mutowalnych kopii testowych. */
type DeepWritable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? DeepWritable<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: DeepWritable<T[K]> }
      : T;

type WritableSubject = DeepWritable<SubjectModule>;

/** Głęboko klonuje dane JSON (temat, cele) jako mutowalne. */
function cloneData<T>(value: T): DeepWritable<T> {
  return JSON.parse(JSON.stringify(value)) as DeepWritable<T>;
}

/**
 * Mutowalna kopia fiksstury do punktowego psucia pojedynczej reguły. Dane
 * (topics, errorCategories, exerciseTypes) są głęboko kopiowane; `normalizer`
 * i `validateExercise` (funkcje) przechodzą przez referencję. Zwrócony obiekt
 * jest przypisywalny do `SubjectModule` (mutowalny ⊆ readonly), więc trafia
 * wprost do `validateSubject` bez rzutowań.
 */
function cloneSubject(): WritableSubject {
  return {
    ...historyLikeSubject,
    exerciseTypes: cloneData(historyLikeSubject.exerciseTypes),
    errorCategories: cloneData(historyLikeSubject.errorCategories),
    topics: cloneData(historyLikeSubject.topics),
    spokenAnswers: historyLikeSubject.spokenAnswers ? cloneData(historyLikeSubject.spokenAnswers) : undefined,
  };
}

function firstTopic(subject: WritableSubject): WritableSubject["topics"][number] {
  return subject.topics[0]!;
}

function firstObjective(subject: WritableSubject): ReturnType<typeof firstTopic>["objectives"][number] {
  return firstTopic(subject).objectives[0]!;
}

describe("validateSubject — poprawny przedmiot", () => {
  it("fixture history-like przechodzi bez błędów", () => {
    expect(validateSubject(historyLikeSubject)).toEqual([]);
  });
});

describe("validateSubject — reguły (po jednym przypadku negatywnym)", () => {
  it("odrzuca zduplikowane id tematów (per wersja)", () => {
    const subject = cloneSubject();
    subject.topics = [firstTopic(subject), cloneData(firstTopic(subject))];
    expect(validateSubject(subject).length).toBeGreaterThan(0);
  });

  it("dopuszcza ten sam id tematu w różnych wersjach", () => {
    const subject = cloneSubject();
    const older = cloneData(firstTopic(subject));
    older.version = 0;
    subject.topics = [older, firstTopic(subject)];
    expect(validateSubject(subject)).toEqual([]);
  });

  it("odrzuca zduplikowane id celów", () => {
    const subject = cloneSubject();
    const topic = firstTopic(subject);
    topic.objectives = [firstObjective(subject), cloneData(firstObjective(subject))];
    expect(validateSubject(subject).length).toBeGreaterThan(0);
  });

  it("odrzuca zduplikowane kody kategorii (przedmiot ∪ temat)", () => {
    const subject = cloneSubject();
    firstTopic(subject).extraErrorCategories = [{ code: "wrong_date", labelPl: "Duplikat" }];
    expect(validateSubject(subject).length).toBeGreaterThan(0);
  });

  it("odrzuca zduplikowane id przekształceń", () => {
    const subject = cloneSubject();
    firstTopic(subject).transforms = [
      { id: "to_negative", instructionPl: "Zamień na przeczenie." },
      { id: "to_negative", instructionPl: "Powtórka." },
    ];
    expect(validateSubject(subject).length).toBeGreaterThan(0);
  });

  it("odrzuca kategorię celu spoza bazy ∪ przedmiotu ∪ tematu", () => {
    const subject = cloneSubject();
    firstObjective(subject).errorCategories = ["nieistniejaca"];
    firstObjective(subject).hints = { nieistniejaca: "x" };
    expect(validateSubject(subject).length).toBeGreaterThan(0);
  });

  it("odrzuca kategorię celu bez szablonu podpowiedzi", () => {
    const subject = cloneSubject();
    firstObjective(subject).hints = {};
    expect(validateSubject(subject).length).toBeGreaterThan(0);
  });

  it("odrzuca cel z liczbą kart poza 2–4 (1 karta)", () => {
    const subject = cloneSubject();
    firstObjective(subject).cards = [{ title: "jedna", body: "za mało" }];
    expect(validateSubject(subject).length).toBeGreaterThan(0);
  });

  it("odrzuca cel z liczbą kart poza 2–4 (5 kart)", () => {
    const subject = cloneSubject();
    const card = { title: "k", body: "b" };
    firstObjective(subject).cards = [card, card, card, card, card];
    expect(validateSubject(subject).length).toBeGreaterThan(0);
  });

  it("odrzuca cel bez pokrycia wszystkich etapów ocenianych", () => {
    const subject = cloneSubject();
    // tylko guided (choice) — brak productive i independent
    firstObjective(subject).exerciseTypes = ["lesson_card", "lesson_choice"];
    expect(validateSubject(subject).length).toBeGreaterThan(0);
  });

  it("odrzuca typy celu spoza typów przedmiotu", () => {
    const subject = cloneSubject();
    firstObjective(subject).exerciseTypes = ["lesson_choice", "lesson_gap", "lesson_short_answer"];
    expect(validateSubject(subject).length).toBeGreaterThan(0);
  });

  it("odrzuca lesson_transform w temacie bez przekształceń", () => {
    const subject = cloneSubject();
    subject.exerciseTypes = [...subject.exerciseTypes, "lesson_transform"];
    firstObjective(subject).exerciseTypes = [
      "lesson_card",
      "lesson_choice",
      "lesson_transform",
      "lesson_open_answer",
    ];
    expect(validateSubject(subject).length).toBeGreaterThan(0);
  });

  it("dopuszcza lesson_transform gdy temat ma przekształcenia", () => {
    const subject = cloneSubject();
    subject.exerciseTypes = [...subject.exerciseTypes, "lesson_transform"];
    firstTopic(subject).transforms = [{ id: "to_negative", instructionPl: "Zamień na przeczenie." }];
    firstObjective(subject).exerciseTypes = [
      "lesson_card",
      "lesson_choice",
      "lesson_transform",
      "lesson_open_answer",
    ];
    expect(validateSubject(subject)).toEqual([]);
  });

  it("odrzuca temat bez celów", () => {
    const subject = cloneSubject();
    firstTopic(subject).objectives = [];
    expect(validateSubject(subject).length).toBeGreaterThan(0);
  });
});

describe("validateSubject — lesson_listen_choice", () => {
  const listenErrors = (subject: SubjectModule) => validateSubject(subject).filter((error) => error.includes("lesson_listen_choice"));

  it("odrzuca przedmiot z typem słuchowym bez ttsForFeedbackSentence", () => {
    const subject = cloneSubject();
    subject.exerciseTypes = [...subject.exerciseTypes, "lesson_listen_choice"];
    expect(listenErrors(subject).some((error) => error.includes("ttsForFeedbackSentence"))).toBe(true);
  });

  it("dopuszcza typ słuchowy, gdy przedmiot ma ttsForFeedbackSentence i guided z innego typu", () => {
    const subject = cloneSubject();
    subject.ttsForFeedbackSentence = true;
    subject.exerciseTypes = [...subject.exerciseTypes, "lesson_listen_choice"];
    firstObjective(subject).exerciseTypes = [...firstObjective(subject).exerciseTypes, "lesson_listen_choice"];
    expect(validateSubject(subject)).toEqual([]);
  });

  it("odrzuca cel, którego jedynym typem guided jest lesson_listen_choice", () => {
    const subject = cloneSubject();
    subject.ttsForFeedbackSentence = true;
    subject.exerciseTypes = [...subject.exerciseTypes, "lesson_listen_choice"];
    firstObjective(subject).exerciseTypes = ["lesson_card", "lesson_listen_choice", "lesson_gap", "lesson_open_answer"];
    expect(validateSubject(subject).some((error) => error.includes("guided"))).toBe(true);
  });
});

describe("validateSubject — spójność opcji tworzenia z materiału", () => {
  const buildDynamicTopic: SubjectModule["buildDynamicTopic"] = () => historyLikeSubject.topics[0]!;
  const materialErrors = (subject: SubjectModule) => validateSubject(subject).filter((error) => error.includes("materialSubjectTitle"));

  it("odrzuca buildDynamicTopic bez materialSubjectTitle", () => {
    expect(materialErrors({ ...cloneSubject(), buildDynamicTopic })).toHaveLength(1);
  });

  it("odrzuca materialSubjectTitle bez buildDynamicTopic", () => {
    expect(materialErrors({ ...cloneSubject(), materialSubjectTitle: "parent" })).toHaveLength(1);
    expect(materialErrors({ ...cloneSubject(), materialSubjectTitle: "fixed" })).toHaveLength(1);
  });

  it("dopuszcza obie opcje razem albo żadną (przedmiot katalogowy)", () => {
    expect(validateSubject({ ...cloneSubject(), buildDynamicTopic, materialSubjectTitle: "fixed" })).toEqual([]);
    expect(validateSubject(historyLikeSubject)).toEqual([]);
  });

  it("przedmioty produkcyjne są spójne (rejestr się buduje)", () => {
    for (const subject of PRODUCTION_SUBJECTS) expect(validateSubject(subject), subject.id).toEqual([]);
    expect(() => createProductionSubjectRegistry()).not.toThrow();
  });
});
