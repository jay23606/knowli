import { describe, expect, it } from "vitest";
import { lessonExerciseIdentity, lessonExerciseStimulus, lessonExerciseStimulusRecord } from "./exercise-identity";
import type { LessonExerciseDraft } from "./types";

function exercise(overrides: Partial<LessonExerciseDraft>): LessonExerciseDraft {
  return {
    exerciseType: "lesson_gap",
    objectiveId: "english_grammar.present_simple.question",
    stem: "___ she play tennis?",
    answer: "does",
    acceptedAnswers: [],
    focus: ["does"],
    ...overrides,
  };
}

describe("lessonExerciseIdentity", () => {
  it("identifies a calculation by kind, named parameters and unit, ignoring tolerance and family", () => {
    const calculation = { kind: "scale_distance", params: { scaleDenominator: 25000, mapDistanceCm: 3 }, unit: "m", templateFamilyId: "map-scale" } as const;
    const first = exercise({ exerciseType: "lesson_calculation", calculation, prompt: "Cosmetic prompt" });
    expect(lessonExerciseIdentity(first)).toBe(lessonExerciseIdentity({ ...first, prompt: "Other prompt", calculation: {
      ...calculation, params: { mapDistanceCm: 3, scaleDenominator: 25000 }, tolerance: 1, templateFamilyId: "other",
    } }));
    for (const changed of [
      { ...calculation, params: { ...calculation.params, mapDistanceCm: 4 } },
      { ...calculation, unit: "km" },
      { kind: "height_difference", params: { upperHeightM: 400, lowerHeightM: 150 }, unit: "m", templateFamilyId: "map-scale" },
    ] as const) {
      expect(lessonExerciseIdentity(first)).not.toBe(lessonExerciseIdentity({ ...first, calculation: changed }));
    }
    const converted = exercise({ exerciseType: "lesson_calculation", calculation: {
      kind: "unit_conversion", params: { value: 2, fromUnit: "km" }, unit: "m", templateFamilyId: "units",
    } });
    expect(lessonExerciseIdentity(converted)).not.toBe(lessonExerciseIdentity({ ...converted, calculation: {
      kind: "unit_conversion", params: { value: 2, fromUnit: "cm" }, unit: "m", templateFamilyId: "units",
    } }));
  });
  it("uses normalized stimulus, objective, and exercise type", () => {
    expect(lessonExerciseIdentity(exercise({}))).toBe(lessonExerciseIdentity(exercise({
      stem: "  ___ SHE   play tennis? ", instructionPl: "Inne polecenie", hint: "play",
    })));
    expect(lessonExerciseIdentity(exercise({ objectiveId: "english_grammar.present_simple.negative" })))
      .not.toBe(lessonExerciseIdentity(exercise({})));
    expect(lessonExerciseIdentity(exercise({ exerciseType: "lesson_open_answer", prompt: "___ she play tennis?" })))
      .not.toBe(lessonExerciseIdentity(exercise({})));
  });

  it("includes transform identity and ignores option presentation IDs", () => {
    const transformed = exercise({ exerciseType: "lesson_transform", statement: "She plays tennis.", transformId: "to_negative" });
    expect(lessonExerciseIdentity(transformed)).not.toBe(lessonExerciseIdentity({ ...transformed, transformId: "to_question" }));
    const choice = exercise({ exerciseType: "lesson_choice", stem: "Do you play?", options: [
      { id: "a", text: "Yes" }, { id: "b", text: "No" },
    ] });
    expect(lessonExerciseIdentity(choice)).toBe(lessonExerciseIdentity({ ...choice, options: [
      { id: "x", text: "Yes" }, { id: "y", text: "No" },
    ] }));
  });

  it("rozróżnia ćwiczenia wyboru po piktogramie bodźca", () => {
    const girl = exercise({ exerciseType: "lesson_choice", stem: "___ is happy.", visualSubject: "girl" });
    const boy = exercise({ exerciseType: "lesson_choice", stem: "___ is happy.", visualSubject: "boy" });
    const plain = exercise({ exerciseType: "lesson_choice", stem: "___ is happy." });
    expect(lessonExerciseIdentity(girl)).not.toBe(lessonExerciseIdentity(boy));
    expect(lessonExerciseIdentity(girl)).not.toBe(lessonExerciseIdentity(plain));
    expect(lessonExerciseIdentity(girl)).toBe(lessonExerciseIdentity({ ...girl }));
  });

  it("uses the displayed question as the short-answer stimulus before a legacy stem", () => {
    const first = exercise({
      exerciseType: "lesson_short_answer",
      prompt: "Does she play tennis?",
      stem: "Legacy stem A",
    });
    const second = { ...first, stem: "Legacy stem B" };
    expect(lessonExerciseIdentity(first)).toBe(lessonExerciseIdentity(second));
  });
});

describe("lessonExerciseIdentity — polecenie jako bodziec (instructionIsStimulus)", () => {
  const withInstruction = { instructionIsStimulus: true } as const;
  const gap = (instructionPl: string) => exercise({
    exerciseType: "lesson_gap", stem: "It's ___ today.", answer: "snowing", focus: ["snowing"], instructionPl,
  });

  it("bez opcji polecenie nie wpływa na tożsamość (zachowanie dzisiejsze)", () => {
    const first = gap("Dziś pada śnieg. Wpisz brakujące słowo.");
    const second = gap("Dziś jest zimno. Wpisz brakujące słowo.");
    expect(lessonExerciseIdentity(first)).toBe(lessonExerciseIdentity(second));
    expect(lessonExerciseIdentity(first, {})).toBe(lessonExerciseIdentity(second));
    expect(lessonExerciseIdentity(first, { instructionIsStimulus: false })).toBe(lessonExerciseIdentity(second));
  });

  it("z opcją to samo zdanie z innym poleceniem to dwa ćwiczenia", () => {
    const first = gap("Dziś pada śnieg. Wpisz brakujące słowo.");
    const second = gap("Dziś jest zimno. Wpisz brakujące słowo.");
    expect(lessonExerciseIdentity(first, withInstruction)).not.toBe(lessonExerciseIdentity(second, withInstruction));
  });

  it("z opcją polecenie jest normalizowane (spacje, wielkość liter)", () => {
    expect(lessonExerciseIdentity(gap("Dziś pada śnieg."), withInstruction))
      .toBe(lessonExerciseIdentity(gap("  DZIŚ   pada	śnieg. "), withInstruction));
  });

  it("z opcją dotyczy lesson_choice, lesson_gap i lesson_order", () => {
    const choice = (instructionPl: string) => exercise({
      exerciseType: "lesson_choice", stem: "It's ___ today.", instructionPl,
      options: [{ id: "a", text: "snowing" }, { id: "b", text: "raining" }],
    });
    const order = (instructionPl: string) => exercise({
      exerciseType: "lesson_order", instructionPl, items: [{ id: "a", text: "I'm" }, { id: "b", text: "cold" }],
    });
    for (const make of [choice, order, gap]) {
      expect(lessonExerciseIdentity(make("Pierwsze polecenie."), withInstruction))
        .not.toBe(lessonExerciseIdentity(make("Drugie polecenie."), withInstruction));
      expect(lessonExerciseIdentity(make("Pierwsze polecenie."))).toBe(lessonExerciseIdentity(make("Drugie polecenie.")));
    }
  });

  it("bodziec z opcją to para [polecenie, dotychczasowy bodziec]", () => {
    const first = gap("Dziś pada śnieg.");
    expect(lessonExerciseStimulus(first, withInstruction))
      .toBe(JSON.stringify(["dziś pada śnieg.", lessonExerciseStimulus(first)]));
    expect(lessonExerciseStimulusRecord(first, withInstruction).stimulus).toBe(lessonExerciseStimulus(first, withInstruction));
    expect(lessonExerciseStimulusRecord(first).stimulus).toBe(lessonExerciseStimulus(first));
  });

  it("z opcją brak polecenia daje pusty składnik, nie błąd", () => {
    const bare = exercise({ exerciseType: "lesson_gap", stem: "It's ___ today.", instructionPl: undefined });
    expect(lessonExerciseStimulus(bare, withInstruction)).toBe(JSON.stringify(["", lessonExerciseStimulus(bare)]));
  });

  it("opcja nie zmienia tożsamości innych typów ćwiczeń", () => {
    const match = exercise({ exerciseType: "lesson_match", instructionPl: "Połącz.", pairs: [{ left: "coat", right: "płaszcz" }] });
    const open = exercise({ exerciseType: "lesson_open_answer", prompt: "Przetłumacz: Mam płaszcz.", instructionPl: "Przetłumacz." });
    for (const other of [match, open]) {
      expect(lessonExerciseIdentity(other, withInstruction)).toBe(lessonExerciseIdentity(other));
    }
  });
});

describe("lessonExerciseIdentity — lesson_listen_choice", () => {
  const listen = (overrides: Partial<LessonExerciseDraft> = {}) => exercise({
    exerciseType: "lesson_listen_choice",
    stem: "I can see a ___.",
    options: [{ id: "a", text: "cat" }, { id: "b", text: "dog" }],
    correctOption: "a",
    answer: "cat",
    ...overrides,
  });

  it("is [objectiveId, type, [normalized stem, normalized full sentence]]", () => {
    expect(lessonExerciseIdentity(listen({ stem: "  She ___   MILK. ", options: [{ id: "a", text: "Doesn't like" }, { id: "b", text: "likes" }], correctOption: "a" }))).toBe(
      JSON.stringify(["english_grammar.present_simple.question", "lesson_listen_choice", JSON.stringify(["she ___ milk.", "she doesn't like milk."])]),
    );
  });

  it("differs when the correct option differs (the recording differs)", () => {
    expect(lessonExerciseIdentity(listen())).not.toBe(lessonExerciseIdentity(listen({ correctOption: "b", answer: "dog" })));
  });

  it("differs from lesson_choice with the same stem", () => {
    expect(lessonExerciseIdentity(listen())).not.toBe(lessonExerciseIdentity(listen({ exerciseType: "lesson_choice" })));
  });

  it("ignores instructionIsStimulus and the instruction text", () => {
    expect(lessonExerciseIdentity(listen(), { instructionIsStimulus: true })).toBe(lessonExerciseIdentity(listen({ instructionPl: "Inne polecenie" }), { instructionIsStimulus: true }));
    expect(lessonExerciseIdentity(listen(), { instructionIsStimulus: true })).toBe(lessonExerciseIdentity(listen()));
  });
});
