import { describe, expect, it } from "vitest";
import { lessonExerciseIdentity, lessonIdentityOptionsOf } from "../../../domain/lessons/exercise-identity";
import { englishGrammarSubject } from "../../../domain/lessons/subjects/english-grammar/module";
import type { LessonTopic, SubjectModule } from "../../../domain/lessons/types";
import { toExerciseDraft } from "./lesson-drafts";
import { acceptFreshLessonPool, sanitizeFreshLessonDraft, type FreshPoolInput } from "./lesson-pool-acceptance";

const OBJECTIVE_ID = "english_grammar.present_simple.third_person_s";

function presentSimpleTopic(): LessonTopic {
  const topic = englishGrammarSubject.topics.find((t) => t.id === "present_simple");
  if (!topic) throw new Error("fixture topic missing");
  return topic;
}

/** Poprawny kształtowo lesson_choice (surowy obiekt z portu); `stem` odróżnia ćwiczenia. */
function choiceRaw(answer: string, stem = `She ___ ${answer}.`) {
  return {
    exerciseType: "lesson_choice",
    objectiveId: OBJECTIVE_ID,
    instructionPl: "Wybierz.",
    stem,
    answer,
    acceptedAnswers: [],
    focus: [],
    options: [
      { id: "a", text: answer },
      { id: "b", text: `${answer}x` },
    ],
    correctOption: "a",
  };
}

/** lesson_choice o złym kształcie: null w tablicy opcji. */
function malformedRaw() {
  return { ...choiceRaw("watches"), options: [null, { id: "b", text: "watch" }] };
}

const REASON = "słowo spoza materiału: goes";

/** Przedmiot z hakiem czyszczenia: odrzuca ćwiczenia z odpowiedzią „goes” (słownik rozdziału); deduplikacja po odpowiedzi. */
const subjectWithRefine: SubjectModule = {
  ...englishGrammarSubject,
  poolDeduplication: "answer",
  refineGeneratedPool: (all) => ({
    kept: all.filter((d) => d.answer !== "goes"),
    rejected: all.filter((d) => d.answer === "goes").map((exercise) => ({ exercise, reason: REASON })),
  }),
};

function input(overrides: Partial<FreshPoolInput>): FreshPoolInput {
  return {
    rawExercises: [],
    subject: subjectWithRefine,
    topic: presentSimpleTopic(),
    material: "material",
    familyScope: null,
    existingDrafts: [],
    existingAnswers: new Set(),
    existingExerciseIdentities: new Set(),
    objectiveLimits: new Map(),
    ...overrides,
  };
}

describe("acceptFreshLessonPool (walidacja świeżej puli)", () => {
  it("liczy odrzucenia: kształt, hak słownikowy, duplikat wobec szkicu i nadmiar ponad zamówioną liczbę", () => {
    const result = acceptFreshLessonPool(input({
      rawExercises: [
        choiceRaw("plays"),
        malformedRaw(),
        choiceRaw("goes"),
        choiceRaw("watches"),
        choiceRaw("eats"),
        choiceRaw("runs"),
      ],
      existingAnswers: new Set(["watches"]),
      objectiveLimits: new Map([[OBJECTIVE_ID, { count: 2, listen: 1 }]]),
    }));
    expect(result.shapeRejected).toBe(1);
    expect(result.refineRejected).toBe(1);
    expect(result.refinedReasons).toEqual({ [REASON]: 1 });
    expect(result.duplicateCount).toBe(1);
    expect(result.accepted.map((e) => e.answer)).toEqual(["plays", "eats"]);
    expect(result.rejected.map((r) => r.exercise.answer)).toEqual(["runs"]);
    expect(result.rejected[0]!.errors[0]).toMatch(/^exerciseType: ćwiczenie ponad zamówioną liczbę 2/);
    expect(result.droppedAcceptedVariants).toBe(0);
    expect(result.droppedExplanations).toBe(0);
  });

  it("odrzucenia z validatePool trafiają do rejected, a poprawne ćwiczenia zostają", () => {
    const noOptions = { ...choiceRaw("sleeps"), options: [] };
    const result = acceptFreshLessonPool(input({ rawExercises: [choiceRaw("plays"), noOptions] }));
    expect(result.accepted.map((e) => e.answer)).toEqual(["plays"]);
    expect(result.rejected.map((r) => r.exercise.answer)).toEqual(["sleeps"]);
    expect(result.rejected[0]!.errors.length).toBeGreaterThan(0);
  });

  it("zlicza porzucone warianty redundantne wobec odpowiedzi kanonicznej", () => {
    const withVariant = { ...choiceRaw("plays"), acceptedAnswers: ["plays", "plays"] };
    const result = acceptFreshLessonPool(input({ rawExercises: [withVariant] }));
    expect(result.droppedAcceptedVariants).toBeGreaterThan(0);
    expect(result.accepted).toHaveLength(1);
  });

  it("sumuje porzucone wyjaśnienia i warianty po wszystkich ćwiczeniach partii", () => {
    const noExplanations: SubjectModule = { ...subjectWithRefine, exerciseExplanations: false };
    const result = acceptFreshLessonPool(input({
      subject: noExplanations,
      rawExercises: [
        { ...choiceRaw("plays"), explanationPl: "Wyjaśnienie pierwsze.", acceptedAnswers: ["plays", "plays"] },
        { ...choiceRaw("eats"), explanationPl: "Wyjaśnienie drugie.", acceptedAnswers: ["eats"] },
      ],
    }));
    expect(result.accepted.map((e) => e.answer)).toEqual(["plays", "eats"]);
    expect(result.droppedExplanations).toBe(2);
    expect(result.droppedAcceptedVariants).toBe(3);
  });

  it("familyScope dopisuje sufiks runu do rodzin; null ich nie rusza", () => {
    const seen: (string | undefined)[] = [];
    const spy: SubjectModule = {
      ...englishGrammarSubject,
      refineGeneratedPool: (all) => {
        seen.push(...all.map((d) => d.familyId));
        return { kept: [...all], rejected: [] };
      },
    };
    const raw = [{ ...choiceRaw("plays"), familyId: "f1" }];
    acceptFreshLessonPool(input({ subject: spy, rawExercises: raw, familyScope: null }));
    acceptFreshLessonPool(input({ subject: spy, rawExercises: raw, familyScope: "3f2a9c1e-0000-4000-8000-000000000000" }));
    expect(seen).toEqual(["f1", "f1-r3f2a9c"]);
  });

  it("poolDeduplication=exercise porównuje tożsamość ćwiczenia, nie odpowiedź", () => {
    const byExercise: SubjectModule = { ...subjectWithRefine, poolDeduplication: "exercise" };
    const raw = choiceRaw("plays");
    const answerOnly = acceptFreshLessonPool(input({
      subject: byExercise, rawExercises: [raw], existingAnswers: new Set(["plays"]),
    }));
    expect(answerOnly.duplicateCount).toBe(0);
    expect(answerOnly.accepted).toHaveLength(1);
    const identity = lessonExerciseIdentity(toExerciseDraft(raw), lessonIdentityOptionsOf(byExercise));
    const clash = acceptFreshLessonPool(input({
      subject: byExercise, rawExercises: [raw], existingExerciseIdentities: new Set([identity]),
    }));
    expect(clash.duplicateCount).toBe(1);
    expect(clash.accepted).toHaveLength(0);
  });
});

describe("sanitizeFreshLessonDraft (wspólna sanityzacja świeżego ćwiczenia)", () => {
  const draftOf = (raw: Record<string, unknown>) => toExerciseDraft(raw as Parameters<typeof toExerciseDraft>[0]);

  it("usuwa pustą tablicę opcjonalną (options: [])", () => {
    const draft = draftOf({ ...choiceRaw("plays"), options: [] });
    expect(draft.options).toEqual([]);
    const result = sanitizeFreshLessonDraft(draft, englishGrammarSubject, null);
    expect(result.draft).not.toHaveProperty("options");
    expect(result.droppedExplanation).toBe(false);
    expect(result.droppedVariants).toBe(0);
  });

  it("usuwa dodatki modelu z ćwiczenia słuchowego (polecenie, podpowiedź, piktogram)", () => {
    const draft = draftOf({
      ...choiceRaw("plays"),
      exerciseType: "lesson_listen_choice",
      instructionPl: "Posłuchaj.",
      hint: "Podpowiedź.",
      visualSubject: "cat",
    });
    expect(draft.instructionPl).toBe("Posłuchaj.");
    const { draft: out } = sanitizeFreshLessonDraft(draft, englishGrammarSubject, null);
    expect(out).not.toHaveProperty("instructionPl");
    expect(out).not.toHaveProperty("hint");
    expect(out).not.toHaveProperty("visualSubject");
  });

  it("familyScope dopisuje sufiks runu do rodziny; null jej nie rusza", () => {
    const draft = draftOf({ ...choiceRaw("plays"), familyId: "f1" });
    expect(sanitizeFreshLessonDraft(draft, englishGrammarSubject, null).draft.familyId).toBe("f1");
    expect(sanitizeFreshLessonDraft(draft, englishGrammarSubject, "3f2a9c1e-0000-4000-8000-000000000000").draft.familyId)
      .toBe("f1-r3f2a9c");
  });

  it("usuwa i zlicza wariant redundantny wobec odpowiedzi kanonicznej", () => {
    const draft = draftOf({ ...choiceRaw("plays"), acceptedAnswers: ["plays", "plays"] });
    const result = sanitizeFreshLessonDraft(draft, englishGrammarSubject, null);
    expect(result.droppedVariants).toBe(2);
    expect(result.draft.acceptedAnswers).toEqual([]);
  });

  it("usuwa ton głosu dla przedmiotu bez TTS promptów, a zostawia go dla przedmiotu z TTS", () => {
    const draft = draftOf({ ...choiceRaw("plays"), voiceTone: "curious" });
    expect(draft.voiceTone).toBe("curious");
    expect(sanitizeFreshLessonDraft(draft, englishGrammarSubject, null).draft).not.toHaveProperty("voiceTone");
    const withTts: SubjectModule = { ...englishGrammarSubject, ttsForPrompts: true };
    expect(sanitizeFreshLessonDraft(draft, withTts, null).draft.voiceTone).toBe("curious");
  });

  it("niepoprawne wyjaśnienie jest usuwane i oznaczone; poprawne zostaje", () => {
    const bad = draftOf({ ...choiceRaw("plays"), explanationPl: "Pierwsze zdanie. Drugie zdanie." });
    const dropped = sanitizeFreshLessonDraft(bad, englishGrammarSubject, null);
    expect(dropped.droppedExplanation).toBe(true);
    expect(dropped.draft).not.toHaveProperty("explanationPl");
    const good = draftOf({ ...choiceRaw("plays"), explanationPl: "Przy he, she, it dodajemy -s." });
    const kept = sanitizeFreshLessonDraft(good, englishGrammarSubject, null);
    expect(kept.droppedExplanation).toBe(false);
    expect(kept.draft.explanationPl).toBe("Przy he, she, it dodajemy -s.");
  });
});
