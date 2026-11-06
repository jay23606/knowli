import { afterEach, describe, expect, it, vi } from "vitest";
import type { LessonExerciseDraft } from "../../../domain/lessons/types";
import {
  emptyLessonAgentProgress,
  parseLessonAgentProgress,
  salvageLessonAgentSpend,
  summarizeLessonAgentProgress,
  type LessonAgentProgress,
} from "./lesson-agent-checkpoint";
import { toExerciseDraft } from "./lesson-drafts";

const OBJECTIVE = "english_grammar.present_simple.third_person_s";
const SECRET_STEM = "Tajne zdanie ćwiczenia: He ___ football every Sunday.";

const exercise: LessonExerciseDraft = {
  exerciseType: "lesson_choice",
  objectiveId: OBJECTIVE,
  stem: SECRET_STEM,
  answer: "plays",
  acceptedAnswers: ["plays"],
  focus: ["-s"],
  options: [{ id: "a", text: "plays" }, { id: "b", text: "play" }],
  correctOption: "a",
  voiceTone: "curious",
};

/** Szkice wszystkich typów puli w dzisiejszym zapisie punktu kontrolnego (pola v3, cytaty, ton, wyjaśnienie). */
const ALL_TYPE_EXERCISES: readonly LessonExerciseDraft[] = [
  exercise,
  { ...exercise, exerciseType: "lesson_listen_choice", explanationPl: "Końcówka -s po he." },
  { ...exercise, exerciseType: "lesson_short_answer", stem: undefined, prompt: "What does he do?" },
  {
    exerciseType: "lesson_notice", objectiveId: OBJECTIVE, noticeSegments: [["He", "plays"], ["She", "runs"]],
    correctOption: "plays", answer: "plays", acceptedAnswers: [], focus: [],
  },
  {
    exerciseType: "lesson_order", objectiveId: OBJECTIVE, items: [{ id: "i1", text: "He" }, { id: "i2", text: "plays" }],
    answer: "He plays", acceptedAnswers: [], focus: [],
  },
  { exerciseType: "lesson_gap", objectiveId: OBJECTIVE, stem: "He ___ football.", answer: "plays", acceptedAnswers: ["play"], focus: ["plays"] },
  { exerciseType: "lesson_error_fix", objectiveId: OBJECTIVE, statement: "He play.", answer: "He plays.", acceptedAnswers: [], focus: ["plays"] },
  {
    exerciseType: "lesson_transform", objectiveId: OBJECTIVE, statement: "He plays.", transformId: "negate",
    answer: "He does not play.", acceptedAnswers: [], focus: ["does", "not"],
  },
  {
    exerciseType: "lesson_open_answer", objectiveId: OBJECTIVE, prompt: "Co wytwarza roślina?", answer: "Roślina wytwarza cukry.",
    acceptedAnswers: [], focus: [], hint: "Pomyśl o liściach.", questionType: "fact", expectedForm: "one_sentence", familyId: "cukry",
    requiredElements: [{ id: "e1", text: "cukry" }], supplementaryElements: ["tlen"], commonErrors: ["skrobia"],
    sourceRefs: [{ quote: "Roślina wytwarza cukry w liściach.", parentAdded: true }],
  },
  {
    exerciseType: "lesson_calculation", objectiveId: OBJECTIVE, instructionPl: "Oblicz.", prompt: "Oblicz odległość.",
    answer: "750 m", acceptedAnswers: [], focus: [],
    calculation: { kind: "scale_distance", params: { scaleDenominator: 25000, mapDistanceCm: 3 }, unit: "m", templateFamilyId: "map-scale" },
    sourceRefs: [{ quote: "Skala mapy pozwala przeliczyć odległość." }],
  },
  {
    exerciseType: "lesson_keywords", objectiveId: OBJECTIVE, familyId: "cukry", answer: "cukry, światło", acceptedAnswers: [], focus: [],
    keywordOptions: [{ id: "k1", text: "światło" }, { id: "k2", text: "cukry" }, { id: "k3", text: "tlen" }, { id: "k4", text: "korzenie" }],
    keyOptionIds: ["k2", "k1"],
  },
  {
    exerciseType: "lesson_match", objectiveId: OBJECTIVE, instructionPl: "Połącz.", answer: "cat, dog, cow", acceptedAnswers: [], focus: [],
    pairs: [{ left: "cat", right: "kot" }, { left: "dog", right: "pies" }, { left: "cow", right: "krowa" }], extraRight: ["koń"],
  },
  {
    exerciseType: "lesson_group", objectiveId: OBJECTIVE, instructionPl: "Pogrupuj.", answer: "ssaki / ptaki", acceptedAnswers: [], focus: [],
    groups: [{ id: "g1", label: "ssaki" }, { id: "g2", label: "ptaki" }],
    groupItems: [{ text: "pies", groupId: "g1" }, { text: "kot", groupId: "g1" }, { text: "sowa", groupId: "g2" }, { text: "wróbel", groupId: "g2" }],
  },
  {
    exerciseType: "lesson_cloze", objectiveId: OBJECTIVE, instructionPl: "Uzupełnij.", answer: "półkule, południk", acceptedAnswers: [], focus: [],
    clozeText: "Równik dzieli Ziemię na ___, a bieguny łączy ___.", gapAnswers: ["półkule", "południk"], extraWords: ["równoleżnik"],
  },
];

function progress(overrides: Partial<LessonAgentProgress> = {}): LessonAgentProgress {
  return {
    ...emptyLessonAgentProgress(),
    dynamicTopic: {
      titlePl: "Czas teraźniejszy",
      objectives: [{ id: OBJECTIVE, titlePl: "Końcówka -s", descriptionEn: "Third person -s", cards: [{ title: "Reguła", body: "He plays." }] }],
    },
    droppedObjectiveCount: 1,
    planExamples: { [OBJECTIVE]: ["He plays."] },
    objectives: {
      [OBJECTIVE]: { status: "incomplete", exercises: [exercise], examples: ["He plays."] },
      "english_grammar.present_simple.negatives": { status: "failed", failureCode: "provider", exercises: [], examples: [] },
    },
    budgetSpentUsd: 0.25,
    totalSpentUsd: 0.4,
    rejectionCodes: { solver_mismatch: 2 },
    removedAfterAcceptance: 1,
    ...overrides,
  };
}

/** Wartość po przejściu przez kolumnę jsonb (bez `undefined`, czyste obiekty). */
function stored(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("punkt kontrolny agenta — odczyt i podsumowanie", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parse: poprawny postęp", () => {
    const value = progress();
    expect(parseLessonAgentProgress(stored(value), "run-1")).toEqual(value);
    expect(parseLessonAgentProgress(stored(emptyLessonAgentProgress()), "run-1")).toEqual(emptyLessonAgentProgress());
  });

  it("zgodność: punkt kontrolny w dzisiejszym formacie z ćwiczeniami wszystkich typów wczytuje się bez zmian", () => {
    const value = progress({
      objectives: {
        [OBJECTIVE]: { status: "complete", exercises: ALL_TYPE_EXERCISES.map(toExerciseDraft), examples: ["He plays."] },
      },
    });
    const parsed = parseLessonAgentProgress(stored(value), "run-1");
    expect(parsed).toEqual(stored(value));
    expect(parsed!.objectives[OBJECTIVE]!.exercises.map((draft) => draft.exerciseType)).toEqual(
      ALL_TYPE_EXERCISES.map((draft) => draft.exerciseType),
    );
  });

  it("legacy checkpoint without checkCounters: punkt kontrolny etapu 2a parsuje się, pole nieobecne", () => {
    const legacy = stored(progress()) as Record<string, unknown>;
    expect(legacy).not.toHaveProperty("checkCounters");
    const parsed = parseLessonAgentProgress(legacy, "run-1");
    expect(parsed).toBeDefined();
    expect(parsed).not.toHaveProperty("checkCounters");
  });

  it("checkCounters: odczyt zachowuje liczniki, zły kształt unieważnia punkt kontrolny", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const counters = { hintChecks: 3, openChecks: 2, graderCalls: 4 };
    const value = progress({ checkCounters: counters });
    expect(parseLessonAgentProgress(stored(value), "run-1")?.checkCounters).toEqual(counters);
    expect(parseLessonAgentProgress({ ...(stored(value) as object), checkCounters: { hintChecks: -1 } }, "run-1")).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("parse: rejectionCodesWritten przechodzi przez kolumnę jsonb, brak pola zostaje brakiem", () => {
    const value = progress({ rejectionCodesWritten: { solver_mismatch: 2 } });
    expect(parseLessonAgentProgress(stored(value), "run-1")).toEqual(value);
    expect(parseLessonAgentProgress(stored(progress()), "run-1")).not.toHaveProperty("rejectionCodesWritten");
  });

  it("parse: podsumowanie → undefined", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const summary = summarizeLessonAgentProgress(progress(), 2);
    expect(parseLessonAgentProgress(stored(summary), "run-1")).toBeUndefined();
    // brak punktu kontrolnego i podsumowanie nie są uszkodzeniem
    expect(parseLessonAgentProgress(null, "run-1")).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it("parse: uszkodzone ćwiczenie → undefined i log bez treści", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const broken = stored(progress()) as { objectives: Record<string, { exercises: Record<string, unknown>[] }> };
    broken.objectives[OBJECTIVE]!.exercises[0]!.options = "plays";
    expect(parseLessonAgentProgress(broken, "run-1")).toBeUndefined();
    expect(parseLessonAgentProgress({ ...(stored(progress()) as object), budgetSpentUsd: "dużo" }, "run-1")).toBeUndefined();
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual(["[lesson-agent] run=run-1 checkpoint=invalid", "[lesson-agent] run=run-1 checkpoint=invalid"]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("football");
  });

  it("parse: inna wersja → undefined", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(parseLessonAgentProgress({ ...(stored(progress()) as object), version: 2 }, "run-1")).toBeUndefined();
    expect(log.mock.calls.map((call) => String(call[0]))).toEqual(["[lesson-agent] run=run-1 checkpoint=invalid"]);
  });

  it("salvage: z wartości nie do użycia zostaje sam wydatek (nieujemne liczby), bez treści", () => {
    const broken = stored(progress()) as { objectives: Record<string, { exercises: Record<string, unknown>[] }> };
    broken.objectives[OBJECTIVE]!.exercises[0]!.options = "plays";
    expect(salvageLessonAgentSpend(broken)).toEqual({ ...emptyLessonAgentProgress(), budgetSpentUsd: 0.25, totalSpentUsd: 0.4 });
    // zła liczba = 0, łącznie nie mniej niż budżet
    expect(salvageLessonAgentSpend({ kind: "progress", budgetSpentUsd: 0.3, totalSpentUsd: "dużo" })).toEqual({
      ...emptyLessonAgentProgress(), budgetSpentUsd: 0.3, totalSpentUsd: 0.3,
    });
    expect(salvageLessonAgentSpend({ kind: "progress", budgetSpentUsd: -1, totalSpentUsd: 0.2 })).toEqual({
      ...emptyLessonAgentProgress(), budgetSpentUsd: 0, totalSpentUsd: 0.2,
    });
    // brak wydatku, podsumowanie, brak wartości i nie-obiekt → nic
    expect(salvageLessonAgentSpend({ kind: "progress", objectives: "x" })).toBeUndefined();
    expect(salvageLessonAgentSpend(stored(summarizeLessonAgentProgress(progress(), 1)))).toBeUndefined();
    expect(salvageLessonAgentSpend(null)).toBeUndefined();
    expect(salvageLessonAgentSpend("x")).toBeUndefined();
  });

  it("summarize: bez treści", () => {
    const summary = summarizeLessonAgentProgress(progress(), 3);
    expect(summary).toEqual({
      version: 1,
      kind: "summary",
      objectives: {
        [OBJECTIVE]: { status: "incomplete", accepted: 1 },
        "english_grammar.present_simple.negatives": { status: "failed", accepted: 0, failureCode: "provider" },
      },
      totalSpentUsd: 0.4,
      rejectionCodes: { solver_mismatch: 2 },
      attempts: 3,
    });
    const text = JSON.stringify(summary);
    expect(text).not.toContain("football");
    expect(text).not.toContain("He plays");
    expect(text).not.toContain("Czas teraźniejszy");
  });

  it("summarize: przenosi checkCounters (sam licznik, bez treści); bez pola w postępie podsumowanie go nie ma", () => {
    const counters = { hintChecks: 3, openChecks: 2, graderCalls: 4, graderErrors: 1 };
    expect(summarizeLessonAgentProgress(progress({ checkCounters: counters }), 1).checkCounters).toEqual(counters);
    expect(summarizeLessonAgentProgress(progress(), 1)).not.toHaveProperty("checkCounters");
  });
});
