import { describe, expect, it } from "vitest";
import {
  LESSON_EXERCISE_TYPES,
  LessonExerciseTypeSchema,
  SubjectCatalogDtoSchema,
  LessonVoiceToneSchema,
  DynamicObjectiveDtoSchema,
  LessonCommandSchema,
  SchoolLessonCommandSchema,
  MaterialLessonCommandSchema,
  LessonSourceChangedDetailsSchema,
  LessonExerciseInputSchema,
  LessonDraftDtoSchema,
  LessonDeckDtoSchema,
  ObjectiveProgressDtoSchema,
  LessonVerdictDtoSchema,
  LessonVerdictDecisionSchema,
  LessonMockTestReportDtoSchema,
  LessonMockTestSummaryDtoSchema,
} from "./lessons";

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";
const UUID3 = "33333333-3333-4333-8333-333333333333";
const INSTANT = "2026-10-12T15:00:00.000Z";

describe("calculation exercise input", () => {
  const calculation = {
    kind: "scale_distance", params: { scaleDenominator: 25000, mapDistanceCm: 3 },
    unit: "m", templateFamilyId: "map-scale",
  };
  const input = {
    exerciseType: "lesson_calculation", objectiveId: "school.map-scale",
    prompt: "Na mapie w skali 1:25 000 odcinek ma 3 cm. Oblicz odległość w terenie w m.",
    calculation, answer: "750 m", acceptedAnswers: [], focus: [],
    sourceRefs: [{ quote: "Skala mapy określa stosunek odległości." }],
  };
  it("accepts the private parameters without open-answer grading fields", () => {
    expect(LessonExerciseInputSchema.safeParse(input).success).toBe(true);
  });
  it("rejects an unknown calculation kind and extra parameters", () => {
    expect(LessonExerciseInputSchema.safeParse({ ...input, calculation: { ...calculation, kind: "division" } }).success).toBe(false);
    expect(LessonExerciseInputSchema.safeParse({ ...input, calculation: { ...calculation, params: { ...calculation.params, extra: 1 } } }).success).toBe(false);
  });
});

describe("LESSON_EXERCISE_TYPES", () => {
  it("has exactly the 15 lesson_* types", () => {
    expect([...LESSON_EXERCISE_TYPES].sort()).toEqual([
      "lesson_calculation",
      "lesson_card",
      "lesson_choice",
      "lesson_cloze",
      "lesson_error_fix",
      "lesson_gap",
      "lesson_group",
      "lesson_keywords",
      "lesson_listen_choice",
      "lesson_match",
      "lesson_notice",
      "lesson_open_answer",
      "lesson_order",
      "lesson_short_answer",
      "lesson_transform",
    ]);
  });
  it("schema accepts a lesson type and rejects a vocabulary type", () => {
    expect(LessonExerciseTypeSchema.safeParse("lesson_gap").success).toBe(true);
    expect(LessonExerciseTypeSchema.safeParse("exposure").success).toBe(false);
  });
});

describe("SubjectCatalogDtoSchema", () => {
  const catalog = {
    subjects: [{
      id: "english_grammar",
      titlePl: "Angielski — gramatyka",
      creation: "catalog",
      subjectTitleRequired: false,
      topics: [{
        id: "present_simple",
        version: 1,
        titlePl: "Present Simple",
        objectives: [{ id: "english_grammar.present_simple.third_person_s", titlePl: "-s w 3. osobie", cards: [{ title: "Dodaj -s", body: "He plays." }] }],
      }],
    }],
  };
  it("accepts a well-formed catalog", () => {
    expect(SubjectCatalogDtoSchema.safeParse(catalog).success).toBe(true);
  });
  it("is strict (no model-facing descriptions)", () => {
    const parsed = SubjectCatalogDtoSchema.safeParse({
      subjects: [{ ...catalog.subjects[0], descriptionEn: "leak" }],
    });
    expect(parsed.success).toBe(false);
  });
  it("wymaga sposobu tworzenia (creation) i znacznika nazwy przedmiotu od rodzica", () => {
    const { creation: _creation, ...withoutCreation } = catalog.subjects[0]!;
    expect(SubjectCatalogDtoSchema.safeParse({ subjects: [withoutCreation] }).success).toBe(false);
    const { subjectTitleRequired: _required, ...withoutRequired } = catalog.subjects[0]!;
    expect(SubjectCatalogDtoSchema.safeParse({ subjects: [withoutRequired] }).success).toBe(false);
    expect(SubjectCatalogDtoSchema.safeParse({ subjects: [{ ...catalog.subjects[0], creation: "dynamic" }] }).success).toBe(false);
  });
  it("przyjmuje przedmiot tworzony z materiału bez tematów katalogowych", () => {
    const chapter = { id: "english_chapter", titlePl: "Angielski — rozdział", creation: "material", subjectTitleRequired: false, topics: [] };
    const school = { id: "school", titlePl: "Przedmiot szkolny", creation: "material", subjectTitleRequired: true, topics: [] };
    expect(SubjectCatalogDtoSchema.safeParse({ subjects: [chapter, school] }).success).toBe(true);
  });
});

describe("ton lektora (voiceTone)", () => {
  const exercise = {
    exerciseType: "lesson_gap", objectiveId: "o1", stem: "He ___ football.",
    answer: "plays", acceptedAnswers: [], focus: ["plays"],
  };
  const objective = {
    id: "school.d1.obj", titlePl: "Zagadnienie",
    cards: [{ title: "Karta 1", body: "Treść 1" }, { title: "Karta 2", body: "Treść 2" }],
  };

  it("schema accepts the four tones and rejects others, including a default value", () => {
    for (const tone of ["cheerful", "curious", "gentle", "mysterious"]) {
      expect(LessonVoiceToneSchema.safeParse(tone).success).toBe(true);
    }
    expect(LessonVoiceToneSchema.safeParse("loud").success).toBe(false);
    expect(LessonVoiceToneSchema.safeParse("default").success).toBe(false);
  });
  it("exercise input accepts voiceTone, accepts its absence, rejects an unknown tone", () => {
    expect(LessonExerciseInputSchema.safeParse({ ...exercise, voiceTone: "curious" }).success).toBe(true);
    expect(LessonExerciseInputSchema.safeParse(exercise).success).toBe(true);
    expect(LessonExerciseInputSchema.safeParse({ ...exercise, voiceTone: "loud" }).success).toBe(false);
  });
  it("dynamic objective card accepts voiceTone, accepts its absence, rejects an unknown tone", () => {
    const withTone = { ...objective, cards: [{ ...objective.cards[0], voiceTone: "curious" }, objective.cards[1]] };
    expect(DynamicObjectiveDtoSchema.safeParse(withTone).success).toBe(true);
    expect(DynamicObjectiveDtoSchema.safeParse(objective).success).toBe(true);
    const loud = { ...objective, cards: [{ ...objective.cards[0], voiceTone: "loud" }, objective.cards[1]] };
    expect(DynamicObjectiveDtoSchema.safeParse(loud).success).toBe(false);
  });
  it("static subject catalog does not get a tone (its strict card rejects voiceTone)", () => {
    const parsed = SubjectCatalogDtoSchema.safeParse({
      subjects: [{
        id: "english_grammar", titlePl: "Angielski — gramatyka",
        topics: [{
          id: "present_simple", version: 1, titlePl: "Present Simple",
          objectives: [{
            id: "english_grammar.present_simple.third_person_s", titlePl: "-s w 3. osobie",
            cards: [{ title: "Dodaj -s", body: "He plays.", voiceTone: "curious" }],
          }],
        }],
      }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("LessonCommandSchema", () => {
  const base = {
    subjectId: "english_grammar",
    topicId: "present_simple",
    objectiveIds: ["english_grammar.present_simple.third_person_s"],
    material: "He plays football every day.",
    clientRequestId: UUID,
  };
  it("accepts a minimal command and trims material", () => {
    const parsed = LessonCommandSchema.parse({ ...base, material: "  He plays.  " });
    expect(parsed.material).toBe("He plays.");
  });
  it("accepts optional deckId, instruction, poolSize", () => {
    expect(LessonCommandSchema.safeParse({ ...base, deckId: UUID2, instruction: "Zrób 30", poolSize: 30 }).success).toBe(true);
  });
  it("requires at least one objective and unique objectives", () => {
    expect(LessonCommandSchema.safeParse({ ...base, objectiveIds: [] }).success).toBe(false);
    expect(LessonCommandSchema.safeParse({ ...base, objectiveIds: ["a", "a"] }).success).toBe(false);
  });
  it("enforces material length 1-8000", () => {
    expect(LessonCommandSchema.safeParse({ ...base, material: "" }).success).toBe(false);
    expect(LessonCommandSchema.safeParse({ ...base, material: "x".repeat(8001) }).success).toBe(false);
  });
  it("enforces instruction <= 500", () => {
    expect(LessonCommandSchema.safeParse({ ...base, instruction: "x".repeat(501) }).success).toBe(false);
  });
  it("enforces poolSize integer 20-120", () => {
    expect(LessonCommandSchema.safeParse({ ...base, poolSize: 19 }).success).toBe(false);
    expect(LessonCommandSchema.safeParse({ ...base, poolSize: 121 }).success).toBe(false);
    expect(LessonCommandSchema.safeParse({ ...base, poolSize: 20.5 }).success).toBe(false);
    expect(LessonCommandSchema.safeParse({ ...base, poolSize: 20 }).success).toBe(true);
  });
  it("is strict", () => {
    expect(LessonCommandSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});

describe("LessonExerciseInputSchema", () => {
  it("accepts a lesson_gap edit payload", () => {
    const parsed = LessonExerciseInputSchema.safeParse({
      exerciseType: "lesson_gap",
      objectiveId: "o1",
      instructionPl: "Uzupełnij",
      stem: "He ___ football.",
      answer: "plays",
      acceptedAnswers: [],
      focus: ["plays"],
    });
    expect(parsed.success).toBe(true);
  });
  it("accepts visualSubject from the pictogram catalog and rejects values outside it", () => {
    const base = {
      exerciseType: "lesson_choice", objectiveId: "o1", stem: "___ is happy.",
      answer: "She", acceptedAnswers: [], focus: ["She"],
      options: [{ id: "a", text: "She" }, { id: "b", text: "He" }], correctOption: "a",
    };
    expect(LessonExerciseInputSchema.safeParse({ ...base, visualSubject: "girl" }).success).toBe(true);
    expect(LessonExerciseInputSchema.safeParse({ ...base, visualSubject: "teacher" }).success).toBe(false);
  });
  it("accepts an optional id of an existing item", () => {
    expect(LessonExerciseInputSchema.safeParse({
      id: UUID, exerciseType: "lesson_open_answer", objectiveId: "o1",
      prompt: "Przetłumacz", answer: "He plays.", acceptedAnswers: [], focus: ["plays"],
    }).success).toBe(true);
  });
  it("enforces text field length <= 120", () => {
    expect(LessonExerciseInputSchema.safeParse({
      exerciseType: "lesson_gap", objectiveId: "o1", stem: "x".repeat(121),
      answer: "plays", acceptedAnswers: [], focus: ["plays"],
    }).success).toBe(false);
  });
  it("enforces acceptedAnswers <= 40 variants", () => {
    expect(LessonExerciseInputSchema.safeParse({
      exerciseType: "lesson_open_answer", objectiveId: "o1", prompt: "p",
      answer: "a", acceptedAnswers: Array.from({ length: 41 }, (_, i) => `v${i}`), focus: ["a"],
    }).success).toBe(false);
  });
  it("enforces 2-4 options", () => {
    const opt = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `${i}`, text: `t${i}` }));
    expect(LessonExerciseInputSchema.safeParse({
      exerciseType: "lesson_choice", objectiveId: "o1", stem: "s",
      answer: "a", acceptedAnswers: [], focus: [], options: opt(1), correctOption: "0",
    }).success).toBe(false);
    expect(LessonExerciseInputSchema.safeParse({
      exerciseType: "lesson_choice", objectiveId: "o1", stem: "s",
      answer: "a", acceptedAnswers: [], focus: [], options: opt(5), correctOption: "0",
    }).success).toBe(false);
    expect(LessonExerciseInputSchema.safeParse({
      exerciseType: "lesson_choice", objectiveId: "o1", stem: "s",
      answer: "a", acceptedAnswers: [], focus: [], options: opt(3), correctOption: "0",
    }).success).toBe(true);
  });
  it("enforces 3-10 order items", () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `${i}`, text: `t${i}` }));
    expect(LessonExerciseInputSchema.safeParse({
      exerciseType: "lesson_order", objectiveId: "o1", answer: "a", acceptedAnswers: [], focus: [], items: items(2),
    }).success).toBe(false);
    expect(LessonExerciseInputSchema.safeParse({
      exerciseType: "lesson_order", objectiveId: "o1", answer: "a", acceptedAnswers: [], focus: [], items: items(11),
    }).success).toBe(false);
    expect(LessonExerciseInputSchema.safeParse({
      exerciseType: "lesson_order", objectiveId: "o1", answer: "a", acceptedAnswers: [], focus: [], items: items(3),
    }).success).toBe(true);
  });
  it("accepts lesson_notice with noticeSegments and correctOption (no options)", () => {
    expect(LessonExerciseInputSchema.safeParse({
      exerciseType: "lesson_notice", objectiveId: "o1", instructionPl: "Dotknij",
      noticeSegments: [["He", "plays"], ["She", "runs"]],
      correctOption: "plays", answer: "plays", acceptedAnswers: [], focus: [],
    }).success).toBe(true);
  });
  it("enforces notice 2-3 sentences of 1-15 segments", () => {
    expect(LessonExerciseInputSchema.safeParse({
      exerciseType: "lesson_notice", objectiveId: "o1",
      noticeSegments: [["He"]], correctOption: "He", answer: "He", acceptedAnswers: [], focus: [],
    }).success).toBe(false);
    expect(LessonExerciseInputSchema.safeParse({
      exerciseType: "lesson_notice", objectiveId: "o1",
      noticeSegments: [Array.from({ length: 16 }, (_, i) => `w${i}`), ["ok"]],
      correctOption: "ok", answer: "ok", acceptedAnswers: [], focus: [],
    }).success).toBe(false);
  });
  it("is strict", () => {
    expect(LessonExerciseInputSchema.safeParse({
      exerciseType: "lesson_open_answer", objectiveId: "o1", prompt: "p",
      answer: "a", acceptedAnswers: [], focus: ["a"], extra: 1,
    }).success).toBe(false);
  });
});

describe("LessonDraftDtoSchema", () => {
  it("accepts a draft with exercises, coverage, examples", () => {
    const parsed = LessonDraftDtoSchema.safeParse({
      id: UUID, deckId: UUID2, editNumber: 1, status: "draft", title: "Present Simple",
      subjectId: "english_grammar", topicId: "present_simple", topicVersion: 1,
      objectiveIds: ["o1"], examples: { o1: ["He plays."] },
      exercises: [{
        id: UUID3, revisionId: UUID, exerciseType: "lesson_gap", objectiveId: "o1",
        stem: "He ___.", answer: "plays", acceptedAnswers: [], focus: ["plays"],
      }],
      assets: [{ itemRevisionId: UUID, role: "target_audio", state: "pending", assetId: null }],
      rejectedCount: 2,
      coverage: [{ objectiveId: "o1", stage: "guided", required: 1, actual: 0 }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("LessonDraftDtoSchema — powody odrzuceń", () => {
  const draft = {
    id: UUID, deckId: UUID2, editNumber: 1, status: "review", title: "Rozdział 3",
    subjectId: "english_chapter", topicId: "chapter", topicVersion: 1,
    objectiveIds: ["o1"], examples: {}, exercises: [], assets: [], rejectedCount: 3, coverage: [],
  };

  it("rejectedReasons jest opcjonalne", () => {
    const parsed = LessonDraftDtoSchema.parse(draft);
    expect(parsed.rejectedReasons).toBeUndefined();
    expect(LessonDraftDtoSchema.parse({ ...draft, rejectedReasons: {} }).rejectedReasons).toEqual({});
  });

  it("przyjmuje zliczenia po powodzie", () => {
    const parsed = LessonDraftDtoSchema.parse({ ...draft, rejectedReasons: { "słowo spoza materiału: raining": 2, "inny powód": 1 } });
    expect(parsed.rejectedReasons).toEqual({ "słowo spoza materiału: raining": 2, "inny powód": 1 });
  });

  it("liczby muszą być dodatnie i całkowite", () => {
    for (const bad of [0, -1, 1.5, "2"]) {
      expect(LessonDraftDtoSchema.safeParse({ ...draft, rejectedReasons: { powód: bad } }).success).toBe(false);
    }
  });
});

describe("DynamicObjectiveDtoSchema — rodzaj zagadnienia", () => {
  const objective = {
    id: "english_chapter.ddeck.clothes", titlePl: "Ubrania",
    cards: [{ title: "Słowa", body: "coat — płaszcz" }, { title: "Zwroty", body: "I'm wearing a coat." }],
  };

  it("rodzaj jest opcjonalny: words, frame albo brak", () => {
    expect(DynamicObjectiveDtoSchema.safeParse(objective).success).toBe(true);
    expect(DynamicObjectiveDtoSchema.safeParse({ ...objective, kind: "words" }).success).toBe(true);
    expect(DynamicObjectiveDtoSchema.safeParse({ ...objective, kind: "frame" }).success).toBe(true);
    expect(DynamicObjectiveDtoSchema.safeParse({ ...objective, kind: "other" }).success).toBe(false);
    expect(DynamicObjectiveDtoSchema.safeParse({ ...objective, kind: null }).success).toBe(false);
  });

  it("nadal odrzuca nieznane pola zagadnienia", () => {
    expect(DynamicObjectiveDtoSchema.safeParse({ ...objective, descriptionEn: "x" }).success).toBe(false);
  });
});

describe("LessonDeckDtoSchema", () => {
  const draft = {
    id: UUID, deckId: UUID2, editNumber: 1, status: "draft", title: "Present Simple",
    subjectId: "english_grammar", topicId: "present_simple", topicVersion: 1,
    objectiveIds: ["o1"], examples: {}, exercises: [], assets: [], rejectedCount: 0, coverage: [],
  };
  const base = {
    id: UUID, title: "Present Simple", state: "draft",
    draft, published: null, generation: null, assignments: [],
  };
  it("carries the typed grading provider info", () => {
    const parsed = LessonDeckDtoSchema.parse({ ...base, grading: { available: true, model: "gpt-x" } });
    expect(parsed.grading).toEqual({ available: true, model: "gpt-x" });
  });
  it("accepts grading unavailable with no model", () => {
    const parsed = LessonDeckDtoSchema.parse({ ...base, grading: { available: false } });
    expect(parsed.grading.available).toBe(false);
  });
  it("requires the grading field", () => {
    expect(LessonDeckDtoSchema.safeParse(base).success).toBe(false);
  });
  it("domyśla sessionTaskBudget do 20 i przyjmuje wartość zestawu", () => {
    const withGrading = { ...base, grading: { available: false } };
    expect(LessonDeckDtoSchema.parse(withGrading).sessionTaskBudget).toBe(20);
    expect(LessonDeckDtoSchema.parse({ ...withGrading, sessionTaskBudget: 7 }).sessionTaskBudget).toBe(7);
  });
  describe("source (pochodzenie z materiału źródłowego)", () => {
    const withGrading = { ...base, grading: { available: false } };
    const source = { id: UUID3, title: "Rozdział 4: Pogoda", copiedRevision: 1, currentRevision: 2 };
    it("jest opcjonalne: zestaw bez źródła nie ma pola", () => {
      expect(LessonDeckDtoSchema.parse(withGrading)).not.toHaveProperty("source");
    });
    it("przyjmuje tytuł i obie rewizje", () => {
      expect(LessonDeckDtoSchema.parse({ ...withGrading, source }).source).toEqual(source);
    });
    it("odrzuca niepełne lub błędne źródło", () => {
      expect(LessonDeckDtoSchema.safeParse({ ...withGrading, source: { ...source, id: "x" } }).success).toBe(false);
      expect(LessonDeckDtoSchema.safeParse({ ...withGrading, source: { ...source, copiedRevision: 0 } }).success).toBe(false);
      expect(LessonDeckDtoSchema.safeParse({ ...withGrading, source: { ...source, currentRevision: 1.5 } }).success).toBe(false);
      const { title: _title, ...withoutTitle } = source;
      expect(LessonDeckDtoSchema.safeParse({ ...withGrading, source: withoutTitle }).success).toBe(false);
      expect(LessonDeckDtoSchema.safeParse({ ...withGrading, source: { ...source, extra: 1 } }).success).toBe(false);
    });
  });
});

describe("ObjectiveProgressDtoSchema", () => {
  it("accepts a parent-facing objective progress row", () => {
    expect(ObjectiveProgressDtoSchema.safeParse({
      objectiveId: "o1", titlePl: "-s w 3. osobie", status: "mastered",
      lastIndependentAt: INSTANT, nextReviewAt: INSTANT, poolExhausted: false,
      topErrors: [{ category: "missing_s", labelPl: "Brak -s", count: 3, examples: ["he play"] }],
    }).success).toBe(true);
  });
  it("caps topError examples at 3", () => {
    expect(ObjectiveProgressDtoSchema.safeParse({
      objectiveId: "o1", titlePl: "t", status: "learning",
      lastIndependentAt: null, nextReviewAt: null, poolExhausted: false,
      topErrors: [{ category: "c", labelPl: "l", count: 4, examples: ["a", "b", "c", "d"] }],
    }).success).toBe(false);
  });
  it("carries the exhausted-pool hint", () => {
    const parsed = ObjectiveProgressDtoSchema.parse({
      objectiveId: "o1", titlePl: "t", status: "mastered",
      lastIndependentAt: null, nextReviewAt: null, poolExhausted: true, topErrors: [],
    });
    expect(parsed.poolExhausted).toBe(true);
  });
});

describe("LessonVerdictDtoSchema", () => {
  it("accepts a verdict with a parent decision", () => {
    expect(LessonVerdictDtoSchema.safeParse({
      id: UUID, exerciseRevisionId: UUID2, objectiveId: "o1", childAnswer: "he play",
      verdict: "incorrect", errorCategory: "missing_s", note: "brak -s", graderModel: "gpt-x",
      parentDecision: "overridden_correct", createdAt: INSTANT,
    }).success).toBe(true);
  });
  it("accepts null errorCategory/parentDecision", () => {
    expect(LessonVerdictDtoSchema.safeParse({
      id: UUID, exerciseRevisionId: UUID2, objectiveId: "o1", childAnswer: "he plays",
      verdict: "correct", errorCategory: null, note: "", graderModel: "gpt-x",
      parentDecision: null, createdAt: INSTANT,
    }).success).toBe(true);
  });
  it("decision schema has the three literals", () => {
    for (const d of ["confirmed", "overridden_correct", "overridden_incorrect"]) {
      expect(LessonVerdictDecisionSchema.safeParse(d).success).toBe(true);
    }
    expect(LessonVerdictDecisionSchema.safeParse("confirmed_x").success).toBe(false);
  });
});

describe("LessonMockTestReportDtoSchema", () => {
  const base = {
    sessionId: UUID,
    objectives: [{
      objectiveId: "o1", titlePl: "t", total: 5, correct: 3, incorrect: 1, unassessed: 1, skipped: 0, modelGraded: 2,
      errorCategories: [{ category: "missing_s", labelPl: "Brak -s", count: 1 }],
    }],
    complete: true, taskBudget: 10, startedAt: INSTANT, endedAt: INSTANT,
  };
  it("accepts a per-objective mock-test report with sessionId and dates", () => {
    expect(LessonMockTestReportDtoSchema.safeParse(base).success).toBe(true);
  });
  it("accepts an optional school precision block and keeps old reports valid", () => {
    const school = { knowledge: { correct: 1, partial: 1, incorrect: 0 }, precision: { concise: 1, verbose: 1, unfocused: 0 }, formViolations: 1, missingElements: [{ text: "Roślina wytwarza cukry", count: 1 }] };
    expect(LessonMockTestReportDtoSchema.safeParse({ ...base, objectives: [{ ...base.objectives[0], school }] }).success).toBe(true);
    expect(LessonMockTestReportDtoSchema.safeParse({ ...base, objectives: [{ ...base.objectives[0], school: { ...school, note: "x" } }] }).success).toBe(false);
    expect(LessonMockTestReportDtoSchema.safeParse({ ...base, objectives: [{ ...base.objectives[0], school: { ...school, missingElements: Array.from({ length: 6 }, (_, i) => ({ text: `e${i}`, count: 1 })) } }] }).success).toBe(false);
  });

  it("requires sessionId, startedAt and endedAt", () => {
    for (const field of ["sessionId", "startedAt", "endedAt"] as const) {
      const { [field]: _omit, ...rest } = base;
      expect(LessonMockTestReportDtoSchema.safeParse(rest).success).toBe(false);
    }
  });
});

describe("LessonMockTestSummaryDtoSchema", () => {
  const base = {
    sessionId: UUID, deckId: UUID2, state: "completed", complete: true,
    taskBudget: 3, answeredCount: 2,
    solutions: [{
      taskId: UUID3, objectiveId: "o1", titlePl: "-s w 3. osobie", exerciseType: "lesson_gap",
      prompt: "He ___ (play).", childAnswer: "play", correctAnswer: "plays", outcome: "incorrect",
    }],
  };
  it("accepts a child-review summary", () => {
    expect(LessonMockTestSummaryDtoSchema.safeParse(base).success).toBe(true);
  });
  it("accepts skipped and unassessed outcomes with empty child answer", () => {
    expect(LessonMockTestSummaryDtoSchema.safeParse({
      ...base,
      solutions: [{ ...base.solutions[0], childAnswer: "", outcome: "skipped" }],
    }).success).toBe(true);
    expect(LessonMockTestSummaryDtoSchema.safeParse({
      ...base,
      solutions: [{ ...base.solutions[0], outcome: "unassessed" }],
    }).success).toBe(true);
  });
  it("accepts a precision hint and objectives worth reviewing, without extra fields", () => {
    const withHints = { ...base, solutions: [{ ...base.solutions[0], hintPl: "Dobrze! Następnym razem spróbuj krócej." }], reviewObjectives: [{ objectiveId: "o1", titlePl: "-s w 3. osobie" }] };
    expect(LessonMockTestSummaryDtoSchema.safeParse(withHints).success).toBe(true);
    expect(LessonMockTestSummaryDtoSchema.safeParse({ ...withHints, reviewObjectives: [{ objectiveId: "o1", titlePl: "t", status: "weak" }] }).success).toBe(false);
    expect(LessonMockTestSummaryDtoSchema.safeParse({ ...withHints, solutions: [{ ...base.solutions[0], hintPl: "" }] }).success).toBe(false);
  });

  it("rejects a non-lesson exercise type and a not_tested outcome", () => {
    expect(LessonMockTestSummaryDtoSchema.safeParse({
      ...base, solutions: [{ ...base.solutions[0], exerciseType: "recall" }],
    }).success).toBe(false);
    expect(LessonMockTestSummaryDtoSchema.safeParse({
      ...base, solutions: [{ ...base.solutions[0], outcome: "not_tested" }],
    }).success).toBe(false);
  });
});
describe("MaterialLessonCommandSchema (zestaw z materiału bez nazwy przedmiotu od rodzica)", () => {
  const base = {
    subjectId: "english_chapter",
    topicTitlePl: "Unit 1",
    material: "I like pizza.",
    clientRequestId: UUID,
  };
  it("przyjmuje materiał 16 000 znaków i odrzuca 16 001", () => {
    expect(MaterialLessonCommandSchema.safeParse({ ...base, material: "x".repeat(16000) }).success).toBe(true);
    expect(MaterialLessonCommandSchema.safeParse({ ...base, material: "x".repeat(16001) }).success).toBe(false);
  });
  it("przycina materiał i tytuł rozdziału, odrzuca puste", () => {
    const parsed = MaterialLessonCommandSchema.parse({ ...base, topicTitlePl: "  Unit 1  ", material: "  I like pizza.  " });
    expect(parsed.topicTitlePl).toBe("Unit 1");
    expect(parsed.material).toBe("I like pizza.");
    expect(MaterialLessonCommandSchema.safeParse({ ...base, topicTitlePl: "" }).success).toBe(false);
    expect(MaterialLessonCommandSchema.safeParse({ ...base, topicTitlePl: "   " }).success).toBe(false);
    expect(MaterialLessonCommandSchema.safeParse({ ...base, material: "   " }).success).toBe(false);
    expect(MaterialLessonCommandSchema.safeParse({ ...base, topicTitlePl: "x".repeat(121) }).success).toBe(false);
  });
  it("wymaga niepustego subjectId do 64 znaków", () => {
    expect(MaterialLessonCommandSchema.safeParse({ ...base, subjectId: "" }).success).toBe(false);
    expect(MaterialLessonCommandSchema.safeParse({ ...base, subjectId: "x".repeat(65) }).success).toBe(false);
    expect(MaterialLessonCommandSchema.safeParse({ ...base, subjectId: "x".repeat(64) }).success).toBe(true);
  });
  it("przyjmuje deckId, instrukcję do 500 znaków i pulę 20–160", () => {
    expect(MaterialLessonCommandSchema.safeParse({ ...base, deckId: UUID2, instruction: "x".repeat(500), poolSize: 160 }).success).toBe(true);
    expect(MaterialLessonCommandSchema.safeParse({ ...base, instruction: "x".repeat(501) }).success).toBe(false);
    for (const poolSize of [19, 161, 20.5]) {
      expect(MaterialLessonCommandSchema.safeParse({ ...base, poolSize }).success, String(poolSize)).toBe(false);
    }
    expect(MaterialLessonCommandSchema.safeParse({ ...base, poolSize: 20 }).success).toBe(true);
  });
  it("wymaga clientRequestId i jest ścisłe (bez nazwy przedmiotu i dodatkowych pól)", () => {
    const { clientRequestId: _id, ...withoutId } = base;
    expect(MaterialLessonCommandSchema.safeParse(withoutId).success).toBe(false);
    expect(MaterialLessonCommandSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(MaterialLessonCommandSchema.safeParse({ ...base, subjectTitlePl: "Angielski" }).success).toBe(false);
  });
  describe("źródło tekstu: dokładnie jedno z material / sourceMaterialId", () => {
    const { material: _material, ...withoutMaterial } = base;
    it("przyjmuje sourceMaterialId z rewizją podglądu zamiast materiału", () => {
      const parsed = MaterialLessonCommandSchema.parse({ ...withoutMaterial, sourceMaterialId: UUID3, expectedSourceRevision: 2 });
      expect(parsed.sourceMaterialId).toBe(UUID3);
      expect(parsed.expectedSourceRevision).toBe(2);
      expect(parsed.material).toBeUndefined();
    });
    it("wymaga expectedSourceRevision przy sourceMaterialId i tylko przy nim", () => {
      const missing = MaterialLessonCommandSchema.safeParse({ ...withoutMaterial, sourceMaterialId: UUID3 });
      expect(missing.success).toBe(false);
      expect(missing.error?.issues.map((issue) => issue.path)).toEqual([["expectedSourceRevision"]]);
      const withMaterial = MaterialLessonCommandSchema.safeParse({ ...base, expectedSourceRevision: 1 });
      expect(withMaterial.success).toBe(false);
      expect(withMaterial.error?.issues.map((issue) => issue.path)).toEqual([["expectedSourceRevision"]]);
      for (const expectedSourceRevision of [0, 1.5, "1"]) {
        expect(MaterialLessonCommandSchema.safeParse({ ...withoutMaterial, sourceMaterialId: UUID3, expectedSourceRevision }).success, String(expectedSourceRevision)).toBe(false);
      }
    });
    it("przyjmuje sam wklejony materiał jak dotąd", () => {
      const parsed = MaterialLessonCommandSchema.parse(base);
      expect(parsed.material).toBe("I like pizza.");
      expect(parsed.sourceMaterialId).toBeUndefined();
    });
    it("odrzuca oba pola naraz (błąd przy sourceMaterialId)", () => {
      const result = MaterialLessonCommandSchema.safeParse({ ...base, sourceMaterialId: UUID3 });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path)).toEqual([["sourceMaterialId"]]);
    });
    it("odrzuca brak obu pól (błąd przy material — polu, które podświetla formularz)", () => {
      const result = MaterialLessonCommandSchema.safeParse(withoutMaterial);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path)).toEqual([["material"]]);
    });
    it("odrzuca sourceMaterialId, które nie jest uuid, i pusty materiał z sourceMaterialId", () => {
      expect(MaterialLessonCommandSchema.safeParse({ ...withoutMaterial, sourceMaterialId: "nie-uuid", expectedSourceRevision: 1 }).success).toBe(false);
      expect(MaterialLessonCommandSchema.safeParse({ ...withoutMaterial, sourceMaterialId: UUID3, expectedSourceRevision: 1, material: "   " }).success).toBe(false);
    });
    it("zostaje ścisłe przy sourceMaterialId", () => {
      expect(MaterialLessonCommandSchema.safeParse({ ...withoutMaterial, sourceMaterialId: UUID3, expectedSourceRevision: 1, extra: 1 }).success).toBe(false);
    });
  });
});

describe("SchoolLessonCommandSchema i pola v3", () => {
  it("przyjmuje komendę szkolną z materiałem do 16000 znaków", () => {
    const ok = SchoolLessonCommandSchema.safeParse({
      subjectTitlePl: "Geografia",
      topicTitlePl: "Posługuję się mapą",
      material: "x".repeat(16000),
      clientRequestId: UUID,
    });
    expect(ok.success).toBe(true);
    const tooLong = SchoolLessonCommandSchema.safeParse({
      subjectTitlePl: "Geografia",
      topicTitlePl: "Mapa",
      material: "x".repeat(16001),
      clientRequestId: UUID,
    });
    expect(tooLong.success).toBe(false);
  });

  describe("źródło tekstu: dokładnie jedno z material / sourceMaterialId", () => {
    const base = { subjectTitlePl: "Geografia", topicTitlePl: "Mapa", clientRequestId: UUID };
    it("przyjmuje sourceMaterialId z rewizją podglądu zamiast materiału", () => {
      expect(SchoolLessonCommandSchema.parse({ ...base, sourceMaterialId: UUID3, expectedSourceRevision: 1 })).toMatchObject({ sourceMaterialId: UUID3, expectedSourceRevision: 1 });
    });
    it("wymaga expectedSourceRevision przy sourceMaterialId i tylko przy nim", () => {
      const missing = SchoolLessonCommandSchema.safeParse({ ...base, sourceMaterialId: UUID3 });
      expect(missing.success).toBe(false);
      expect(missing.error?.issues.map((issue) => issue.path)).toEqual([["expectedSourceRevision"]]);
      expect(SchoolLessonCommandSchema.safeParse({ ...base, material: "Skala mapy.", expectedSourceRevision: 1 }).success).toBe(false);
    });
    it("przyjmuje sam wklejony materiał jak dotąd", () => {
      expect(SchoolLessonCommandSchema.safeParse({ ...base, material: "Skala mapy." }).success).toBe(true);
    });
    it("odrzuca oba pola naraz (błąd przy sourceMaterialId) oraz brak obu (błąd przy material)", () => {
      const both = SchoolLessonCommandSchema.safeParse({ ...base, material: "Skala mapy.", sourceMaterialId: UUID3 });
      expect(both.success).toBe(false);
      expect(both.error?.issues.map((issue) => issue.path)).toEqual([["sourceMaterialId"]]);
      const neither = SchoolLessonCommandSchema.safeParse(base);
      expect(neither.success).toBe(false);
      expect(neither.error?.issues.map((issue) => issue.path)).toEqual([["material"]]);
    });
    it("odrzuca sourceMaterialId, które nie jest uuid, oraz dodatkowe pola", () => {
      expect(SchoolLessonCommandSchema.safeParse({ ...base, sourceMaterialId: "nie-uuid", expectedSourceRevision: 1 }).success).toBe(false);
      expect(SchoolLessonCommandSchema.safeParse({ ...base, sourceMaterialId: UUID3, expectedSourceRevision: 1, extra: 1 }).success).toBe(false);
    });
  });

  describe("LessonSourceChangedDetailsSchema", () => {
    it("rozpoznaje wyłącznie konflikt zmienionego źródła", () => {
      expect(LessonSourceChangedDetailsSchema.safeParse({ reason: "source_changed" }).success).toBe(true);
      expect(LessonSourceChangedDetailsSchema.safeParse({ reason: "other" }).success).toBe(false);
      expect(LessonSourceChangedDetailsSchema.safeParse({ reason: "source_changed", extra: 1 }).success).toBe(false);
      expect(LessonSourceChangedDetailsSchema.safeParse(undefined).success).toBe(false);
    });
  });

  it("przyjmuje ćwiczenie otwarte z polami v3 i dłuższą odpowiedzią wzorcową", () => {
    const parsed = LessonExerciseInputSchema.safeParse({
      exerciseType: "lesson_open_answer",
      objectiveId: "school.d1.fotosynteza",
      prompt: "Co to jest fotosynteza?",
      answer: "a".repeat(250),
      acceptedAnswers: [],
      focus: ["a"],
      questionType: "definition",
      requiredElements: [{ id: "e1", text: "Roślina wytwarza cukry." }],
      supplementaryElements: ["Uwalniany jest tlen."],
      expectedForm: "one_sentence",
      familyId: "fotosynteza-definicja",
      sourceRefs: [{ quote: "Roślina wytwarza cukry." }],
    });
    expect(parsed.success).toBe(true);
  });

  it("odrzuca nieznany questionType i zbyt wiele elementów wymaganych", () => {
    const base = {
      exerciseType: "lesson_open_answer",
      objectiveId: "school.d1.x",
      prompt: "P?",
      answer: "odpowiedź",
      acceptedAnswers: [],
      focus: ["odpowiedź"],
    };
    expect(LessonExerciseInputSchema.safeParse({ ...base, questionType: "esej" }).success).toBe(false);
    expect(LessonExerciseInputSchema.safeParse({
      ...base,
      requiredElements: Array.from({ length: 7 }, (_, i) => ({ id: `e${i}`, text: "el" })),
    }).success).toBe(false);
  });
});

describe("tematy zdań z zainteresowań dziecka (#197)", () => {
  const command = {
    subjectId: "english_grammar",
    topicId: "present_simple",
    objectiveIds: ["english_grammar.present_simple.third_person_s"],
    material: "He plays football every day.",
    clientRequestId: UUID,
  };

  it("LessonCommandSchema przyjmuje niepustą listę tematów i normalizuje elementy", () => {
    expect(LessonCommandSchema.parse({ ...command, interests: ["dinozaury"] }).interests).toEqual(["dinozaury"]);
    expect(LessonCommandSchema.parse({ ...command, interests: ["  piłka   nożna "] }).interests).toEqual(["piłka nożna"]);
    expect(LessonCommandSchema.parse(command).interests).toBeUndefined();
  });

  it("LessonCommandSchema odrzuca pustą listę, duplikaty i więcej niż 5 tematów", () => {
    expect(LessonCommandSchema.safeParse({ ...command, interests: [] }).success).toBe(false);
    expect(LessonCommandSchema.safeParse({ ...command, interests: ["a", "A"] }).success).toBe(false);
    expect(LessonCommandSchema.safeParse({ ...command, interests: ["a", "b", "c", "d", "e", "f"] }).success).toBe(false);
  });

  it("polecenia zestawów szkolnych i z materiału nie przyjmują tematów (strict)", () => {
    expect(SchoolLessonCommandSchema.safeParse({
      subjectTitlePl: "Historia", topicTitlePl: "Rzym", material: "Tekst.", clientRequestId: UUID, interests: ["dinozaury"],
    }).success).toBe(false);
    expect(MaterialLessonCommandSchema.safeParse({
      subjectId: "english_chapter", topicTitlePl: "Unit 1", material: "I like pizza.", clientRequestId: UUID, interests: ["dinozaury"],
    }).success).toBe(false);
  });

  it("SubjectCatalogDtoSchema przyjmuje katalog z nowymi polami i bez nich", () => {
    const subject = { id: "english_grammar", titlePl: "Angielski — gramatyka", creation: "catalog", subjectTitleRequired: false, topics: [] };
    expect(SubjectCatalogDtoSchema.safeParse({ subjects: [subject] }).success).toBe(true);
    expect(SubjectCatalogDtoSchema.safeParse({
      subjects: [{ ...subject, acceptsInterests: true }], generationService: "openrouter.ai",
    }).success).toBe(true);
    expect(SubjectCatalogDtoSchema.safeParse({ subjects: [{ ...subject, acceptsInterests: "yes" }] }).success).toBe(false);
  });

  it("LessonDraftDtoSchema przyjmuje tematy szkicu", () => {
    const draft = {
      id: UUID, deckId: UUID2, editNumber: 1, status: "draft", title: "Present Simple",
      subjectId: "english_grammar", topicId: "present_simple", topicVersion: 1,
      objectiveIds: ["o1"], examples: {}, exercises: [], assets: [], rejectedCount: 0, coverage: [],
    };
    expect(LessonDraftDtoSchema.parse({ ...draft, interests: ["dinozaury"] }).interests).toEqual(["dinozaury"]);
    expect(LessonDraftDtoSchema.parse(draft).interests).toBeUndefined();
  });
});
