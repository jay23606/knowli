import { describe, expect, it } from "vitest";
import { LessonExerciseInputSchema, type LessonDraftDto } from "@learning/contracts";
import {
  clozeGapCountOf,
  clozeWordsOf,
  createLessonSnapshot,
  filledClozeOf,
  formatRejectedReason,
  otherRejectedCount,
  syncGapAnswers,
  applyCalculationPreview,
  groupCalculationFamilies,
  groupExercisesByObjectiveAndStage,
  lessonThemesPatch,
  lessonExerciseChanged,
  missingListenAudioCount,
  nextGroupId,
  nextRequiredElementId,
  stageOfExerciseType,
  toLessonDraftPatch,
  topRejectedReasons,
} from "./lesson-editor-state";

function draft(overrides: Partial<LessonDraftDto> = {}): LessonDraftDto {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    deckId: "00000000-0000-4000-8000-000000000002",
    editNumber: 3,
    status: "review",
    title: "Present Simple",
    subjectId: "english_grammar",
    topicId: "present_simple",
    topicVersion: 1,
    objectiveIds: ["english_grammar.present_simple.third_person_s"],
    examples: { "english_grammar.present_simple.third_person_s": ["He plays."] },
    exercises: [
      {
        id: "00000000-0000-4000-8000-000000000011",
        revisionId: "00000000-0000-4000-8000-000000000021",
        exerciseType: "lesson_choice",
        objectiveId: "english_grammar.present_simple.third_person_s",
        instructionPl: "Wybierz",
        stem: "He ___ football.",
        answer: "plays",
        acceptedAnswers: [],
        focus: [],
        options: [
          { id: "a", text: "plays" },
          { id: "b", text: "play" },
        ],
        correctOption: "a",
      },
      {
        id: "00000000-0000-4000-8000-000000000012",
        revisionId: "00000000-0000-4000-8000-000000000022",
        exerciseType: "lesson_gap",
        objectiveId: "english_grammar.present_simple.third_person_s",
        instructionPl: "Uzupełnij",
        stem: "She ___ TV.",
        answer: "watches",
        acceptedAnswers: ["watch"],
        focus: ["watches"],
      },
    ],
    assets: [],
    rejectedCount: 2,
    coverage: [
      { objectiveId: "english_grammar.present_simple.third_person_s", stage: "independent", required: 1, actual: 0 },
    ],
    ...overrides,
  };
}

describe("stageOfExerciseType", () => {
  it("maps each exercise type to its learning stage", () => {
    expect(stageOfExerciseType("lesson_card")).toBe("intro");
    expect(stageOfExerciseType("lesson_notice")).toBe("intro");
    expect(stageOfExerciseType("lesson_choice")).toBe("guided");
    expect(stageOfExerciseType("lesson_order")).toBe("guided");
    expect(stageOfExerciseType("lesson_short_answer")).toBe("guided");
    expect(stageOfExerciseType("lesson_gap")).toBe("productive");
    expect(stageOfExerciseType("lesson_error_fix")).toBe("productive");
    expect(stageOfExerciseType("lesson_transform")).toBe("productive");
    expect(stageOfExerciseType("lesson_open_answer")).toBe("independent");
    expect(stageOfExerciseType("lesson_calculation")).toBe("independent");
    expect(stageOfExerciseType("lesson_keywords")).toBe("guided");
    expect(stageOfExerciseType("lesson_match")).toBe("guided");
    expect(stageOfExerciseType("lesson_group")).toBe("guided");
  });
});

describe("createLessonSnapshot", () => {
  it("keeps version id and edit number and gives every exercise a stable client key from its id", () => {
    const snapshot = createLessonSnapshot(draft(), () => "unused");
    expect(snapshot.versionId).toBe("00000000-0000-4000-8000-000000000001");
    expect(snapshot.editNumber).toBe(3);
    expect(snapshot.form.title).toBe("Present Simple");
    expect(snapshot.form.exercises.map((ex) => ex.clientKey)).toEqual([
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000012",
    ]);
  });

  it("joins acceptedAnswers and focus into comma strings for editing", () => {
    const snapshot = createLessonSnapshot(draft(), () => "unused");
    expect(snapshot.form.exercises[1]!.acceptedText).toBe("watch");
    expect(snapshot.form.exercises[1]!.focusText).toBe("watches");
  });

  it("assigns local keys to exercises missing an id without reusing them", () => {
    const base = draft();
    const noId = { ...base, exercises: [{ ...base.exercises[0]!, id: undefined }] } as unknown as LessonDraftDto;
    let n = 0;
    const snapshot = createLessonSnapshot(noId, () => `k${++n}`);
    expect(snapshot.form.exercises[0]!.clientKey).toBe("local:k1");
  });
});

describe("toLessonDraftPatch", () => {
  it("zmiana tytułu zachowuje całe warianty zawierające przecinki", () => {
    const source = draft();
    source.exercises[1]!.acceptedAnswers = ["Yes, he does.", "Yes, she does."];
    const snapshot = createLessonSnapshot(source, () => "unused");
    snapshot.form.title = "Nowy tytuł";
    expect(toLessonDraftPatch(snapshot).exercises![1]!.acceptedAnswers).toEqual(source.exercises[1]!.acceptedAnswers);
  });

  it("słowa kluczowe: odpowiedź z zaznaczonych pojęć, bez wariantów i focus", () => {
    const source = draft();
    source.exercises[0] = {
      ...source.exercises[0]!, exerciseType: "lesson_keywords", familyId: "def", answer: "stara", acceptedAnswers: ["x"], focus: ["y"],
      options: undefined, correctOption: undefined,
      keywordOptions: [{ id: "k1", text: "światło" }, { id: "k2", text: "cukry" }, { id: "k3", text: "tlen" }, { id: "k4", text: "korzenie" }],
      keyOptionIds: ["k2", "k1"],
    };
    const snapshot = createLessonSnapshot(source, () => "unused");
    const input = toLessonDraftPatch(snapshot).exercises![0]!;
    expect(input).toMatchObject({ exerciseType: "lesson_keywords", familyId: "def", answer: "cukry, światło", acceptedAnswers: [], focus: [], keyOptionIds: ["k2", "k1"] });
    expect(input.keywordOptions).toHaveLength(4);
  });

  it("pary: odpowiedź z lewych stron, puste wiersze i dystraktory pominięte, bez wariantów i focus", () => {
    const source = draft();
    source.exercises[0] = {
      ...source.exercises[0]!, exerciseType: "lesson_match", answer: "stara", acceptedAnswers: ["x"], focus: ["y"],
      options: undefined, correctOption: undefined,
      pairs: [{ left: "równik", right: "dzieli półkule" }, { left: "południk", right: "łączy bieguny" }, { left: "biegun", right: "koniec osi" }],
      extraRight: ["leży nad morzem"],
    };
    const snapshot = createLessonSnapshot(source, () => "unused");
    snapshot.form.exercises[0]!.pairs!.push({ left: "", right: "" });
    snapshot.form.exercises[0]!.extraRight!.push(" ");
    const input = toLessonDraftPatch(snapshot).exercises![0]!;
    expect(input).toMatchObject({ exerciseType: "lesson_match", answer: "równik, południk, biegun", acceptedAnswers: [], focus: [], extraRight: ["leży nad morzem"] });
    expect(input.pairs).toHaveLength(3);
    expect(input.options).toBeUndefined();
  });

  it("grupy: odpowiedź z etykiet, elementy z przynależnością", () => {
    const source = draft();
    source.exercises[0] = {
      ...source.exercises[0]!, exerciseType: "lesson_group", answer: "stara", acceptedAnswers: [], focus: [],
      options: undefined, correctOption: undefined,
      groups: [{ id: "g1", label: "ssaki" }, { id: "g2", label: "ptaki" }],
      groupItems: [{ text: "pies", groupId: "g1" }, { text: "kot", groupId: "g1" }, { text: "sowa", groupId: "g2" }, { text: "wróbel", groupId: "g2" }],
    };
    const snapshot = createLessonSnapshot(source, () => "unused");
    snapshot.form.exercises[0]!.groups![1]!.label = "ptaszki";
    const input = toLessonDraftPatch(snapshot).exercises![0]!;
    expect(input).toMatchObject({ exerciseType: "lesson_group", answer: "ssaki / ptaszki", acceptedAnswers: [], focus: [] });
    expect(input.groupItems).toEqual(source.exercises[0]!.groupItems);
  });

  it("luki: odpowiedź ze słów luk, puste słowa-pułapki pominięte, bez wariantów i focus", () => {
    const source = draft();
    source.exercises[0] = {
      ...source.exercises[0]!, exerciseType: "lesson_cloze", answer: "stara", acceptedAnswers: ["x"], focus: ["y"],
      options: undefined, correctOption: undefined,
      clozeText: "Roślina pobiera ___ i ___.", gapAnswers: ["wodę", "sole"], extraWords: ["tlen"],
    };
    const snapshot = createLessonSnapshot(source, () => "unused");
    snapshot.form.exercises[0]!.gapAnswers![1] = " sole mineralne ";
    snapshot.form.exercises[0]!.extraWords!.push(" ");
    const input = toLessonDraftPatch(snapshot).exercises![0]!;
    expect(input).toMatchObject({
      exerciseType: "lesson_cloze", clozeText: "Roślina pobiera ___ i ___.", gapAnswers: ["wodę", "sole mineralne"],
      extraWords: ["tlen"], answer: "wodę, sole mineralne", acceptedAnswers: [], focus: [],
    });
    expect(input.options).toBeUndefined();
    expect(lessonExerciseChanged(snapshot.form.exercises[0]!, createLessonSnapshot(source, () => "unused").form.exercises[0]!)).toBe(true);
  });

  it("luki: pola słów podążają za liczbą luk, a podgląd wstawia słowa w tekst", () => {
    expect(clozeGapCountOf("a ___ b ____ c __")).toBe(3);
    expect(syncGapAnswers("a ___ b ___ c ___", ["x"])).toEqual(["x", "", ""]);
    expect(syncGapAnswers("a ___ b ___ c ___ d ___ e ___", [])).toHaveLength(4);
    // Chwilowe usunięcie luki nie kasuje wpisanych słów; do payloadu idą tylko słowa widocznych luk.
    expect(syncGapAnswers("a ___ b", ["x", "y"])).toEqual(["x", "y"]);
    expect(clozeWordsOf({ clozeText: "a ___ b", gapAnswers: ["x", "y"] })).toEqual(["x"]);
    expect(syncGapAnswers("a ___ b ___ c", ["x", "y"])).toEqual(["x", "y"]);
    expect(filledClozeOf("Roślina pobiera ___ i ___.", ["wodę", " "])).toBe("Roślina pobiera wodę i ___.");
  });

  it("nextGroupId omija zajęte identyfikatory", () => {
    expect(nextGroupId([{ id: "g1" }, { id: "g3" }])).toBe("g2");
    expect(nextGroupId([])).toBe("g1");
  });

  it("zachowuje pytanie short_answer zapisane w prompt", () => {
    const source = draft();
    source.exercises[0] = { ...source.exercises[0]!, exerciseType: "lesson_short_answer", prompt: "Does he play?" };
    const snapshot = createLessonSnapshot(source, () => "unused");
    expect(toLessonDraftPatch(snapshot).exercises![0]!.prompt).toBe("Does he play?");
  });
  it("sends expectedEditNumber from the snapshot, not the latest remote", () => {
    const snapshot = createLessonSnapshot(draft({ editNumber: 3 }), () => "unused");
    expect(toLessonDraftPatch(snapshot).expectedEditNumber).toBe(3);
  });

  it("keeps the id of existing exercises and omits id for new ones", () => {
    const snapshot = createLessonSnapshot(draft(), () => "unused");
    snapshot.form.exercises.push({
      clientKey: "local:new-1",
      exerciseType: "lesson_open_answer",
      objectiveId: "english_grammar.present_simple.third_person_s",
      instructionPl: "Odpowiedz",
      prompt: "Opisz dzień.",
      stem: "",
      statement: "",
      hint: "",
      transformId: "",
      answer: "he works",
      acceptedText: "",
      focusText: "works",
      options: null,
      correctOption: "",
      items: null,
      noticeSegments: null,
      visualSubject: "",
      questionType: "",
      requiredElements: null,
      supplementaryElements: null,
      commonErrors: null,
      expectedForm: "",
      familyId: "",
      sourceRefs: null,
    });
    const patch = toLessonDraftPatch(snapshot);
    expect(patch.exercises?.map((ex) => ex.id)).toEqual(["00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000012", undefined]);
  });

it("zachowuje pola v3 ćwiczeń szkolnych w obie strony", () => {
    const snapshot = createLessonSnapshot(draft(), () => "unused");
    const first = snapshot.form.exercises[0]!;
    first.questionType = "definition";
    first.requiredElements = [{ id: "e1", text: "Roślina wytwarza cukry." }];
    first.expectedForm = "one_sentence";
    first.familyId = "fotosynteza-definicja";
    first.sourceRefs = [{ quote: "wytwarza cukry" }];
    const patch = toLessonDraftPatch(snapshot);
    expect(patch.exercises![0]!.requiredElements).toEqual([{ id: "e1", text: "Roślina wytwarza cukry." }]);
    expect(patch.exercises![0]!.expectedForm).toBe("one_sentence");
    expect(patch.exercises![0]!.sourceRefs).toEqual([{ quote: "wytwarza cukry" }]);
    expect(patch.exercises![1]).not.toHaveProperty("sourceRefs");
  });
  it("pola wielowierszowe: surowe wiersze z pisania przycinane dopiero w poleceniu", () => {
    const snapshot = createLessonSnapshot(draft(), () => "unused");
    const first = snapshot.form.exercises[0]!;
    // stan w trakcie pisania: spacja na końcu wiersza i pusty wiersz po Enter
    first.supplementaryElements = ["chlorofil ", "", "  światło"];
    first.commonErrors = ["myli skalę ", ""];
    const patch = toLessonDraftPatch(snapshot);
    expect(patch.exercises![0]!.supplementaryElements).toEqual(["chlorofil", "światło"]);
    expect(patch.exercises![0]!.commonErrors).toEqual(["myli skalę"]);
    // pusty wiersz na końcu nie jest zmianą ćwiczenia
    const base = createLessonSnapshot(draft(), () => "unused").form.exercises[0]!;
    base.commonErrors = ["myli skalę"];
    const typing = { ...base, commonErrors: ["myli skalę", ""] };
    expect(lessonExerciseChanged(typing, base)).toBe(false);
  });
  it("emits visualSubject only for lesson_choice exercises", () => {
    const snapshot = createLessonSnapshot(draft(), () => "unused");
    snapshot.form.exercises[0]!.visualSubject = "girl";
    snapshot.form.exercises[1]!.visualSubject = "girl";
    const patch = toLessonDraftPatch(snapshot);
    expect(patch.exercises![0]!.visualSubject).toBe("girl");
    expect(patch.exercises![1]).not.toHaveProperty("visualSubject");
  });

  it("wybór ze słuchu: zdanie z luką, opcje i poprawna opcja przechodzą do patcha, bez polecenia i piktogramu", () => {
    const base = draft();
    const listen: LessonDraftDto["exercises"][number] = {
      id: "00000000-0000-4000-8000-000000000033",
      revisionId: "00000000-0000-4000-8000-000000000043",
      exerciseType: "lesson_listen_choice",
      objectiveId: "english_grammar.present_simple.third_person_s",
      stem: "He ___ football.",
      answer: "plays",
      acceptedAnswers: [],
      focus: ["plays"],
      options: [{ id: "a", text: "plays" }, { id: "b", text: "play" }],
      correctOption: "a",
    };
    const snapshot = createLessonSnapshot({ ...base, exercises: [listen] }, () => "unused");
    const sent = toLessonDraftPatch(snapshot).exercises![0]!;
    expect(sent).toMatchObject({ exerciseType: "lesson_listen_choice", stem: "He ___ football.", correctOption: "a" });
    expect(sent.options).toEqual([{ id: "a", text: "plays" }, { id: "b", text: "play" }]);
    expect(sent).not.toHaveProperty("instructionPl");
    expect(sent).not.toHaveProperty("visualSubject");
  });

  it("splits acceptedAnswers into lines and focus into words, dropping empty entries", () => {
    const snapshot = createLessonSnapshot(draft(), () => "unused");
    snapshot.form.exercises[1]!.acceptedText = " watch \n \n watchez ";
    snapshot.form.exercises[1]!.focusText = "watches";
    const patch = toLessonDraftPatch(snapshot);
    expect(patch.exercises?.[1]!.acceptedAnswers).toEqual(["watch", "watchez"]);
    expect(patch.exercises?.[1]!.focus).toEqual(["watches"]);
  });

  it("only emits type-relevant optional fields (no empty strings leaking into the payload)", () => {
    const snapshot = createLessonSnapshot(draft(), () => "unused");
    const patch = toLessonDraftPatch(snapshot);
    const choice = patch.exercises![0]!;
    expect(choice.options).toEqual([
      { id: "a", text: "plays" },
      { id: "b", text: "play" },
    ]);
    expect(choice.correctOption).toBe("a");
    expect(choice).not.toHaveProperty("items");
    expect(choice).not.toHaveProperty("noticeSegments");
    const gap = patch.exercises![1]!;
    expect(gap.stem).toBe("She ___ TV.");
    expect(gap).not.toHaveProperty("options");
    expect(gap).not.toHaveProperty("correctOption");
  });

  it("includes a title and omits exercises when editing title only", () => {
    const snapshot = createLessonSnapshot({ ...draft(), exercises: [] }, () => "unused");
    const patch = toLessonDraftPatch(snapshot);
    expect(patch.title).toBe("Present Simple");
    expect(patch.exercises).toEqual([]);
  });

  it("keeps the statement of a lesson_transform exercise when only the title changes (P1-2)", () => {
    const transformDraft = draft({
      exercises: [
        {
          id: "00000000-0000-4000-8000-000000000031",
          revisionId: "00000000-0000-4000-8000-000000000041",
          exerciseType: "lesson_transform",
          objectiveId: "english_grammar.present_simple.negative",
          instructionPl: "Zamień na przeczenie",
          statement: "He plays.",
          transformId: "to_negative",
          answer: "He doesn't play.",
          acceptedAnswers: [],
          focus: ["doesn't"],
        },
      ] as unknown as LessonDraftDto["exercises"],
    });
    const snapshot = createLessonSnapshot(transformDraft, () => "unused");
    snapshot.form.title = "Present Simple — poprawiony tytuł";

    const patch = toLessonDraftPatch(snapshot);
    const transform = patch.exercises![0]!;

    expect(transform.exerciseType).toBe("lesson_transform");
    expect(transform.statement).toBe("He plays.");
    expect(transform).not.toHaveProperty("prompt");
  });
});

describe("lessonExerciseChanged", () => {
  it("reports no change for an untouched round-trip", () => {
    const snapshot = createLessonSnapshot(draft(), () => "unused");
    const base = createLessonSnapshot(draft(), () => "unused");
    expect(lessonExerciseChanged(snapshot.form.exercises[0]!, base.form.exercises[0]!)).toBe(false);
  });

  it("detects an edited answer, instruction, option and focus", () => {
    const base = createLessonSnapshot(draft(), () => "unused").form.exercises[0]!;
    const edited = createLessonSnapshot(draft(), () => "unused").form.exercises[0]!;
    edited.answer = "play";
    expect(lessonExerciseChanged(edited, base)).toBe(true);

    const edited2 = createLessonSnapshot(draft(), () => "unused").form.exercises[1]!;
    edited2.focusText = "watch";
    expect(lessonExerciseChanged(edited2, createLessonSnapshot(draft(), () => "unused").form.exercises[1]!)).toBe(true);
  });
});

describe("groupExercisesByObjectiveAndStage", () => {
  it("groups exercises under their objective and stage in catalogue order", () => {
    const snapshot = createLessonSnapshot(draft(), () => "unused");
    const groups = groupExercisesByObjectiveAndStage(
      snapshot.form.exercises,
      ["english_grammar.present_simple.third_person_s"],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.objectiveId).toBe("english_grammar.present_simple.third_person_s");
    const stages = groups[0]!.stages;
    expect(stages.find((s) => s.stage === "guided")!.exercises.map((e) => e.answer)).toEqual(["plays"]);
    expect(stages.find((s) => s.stage === "productive")!.exercises.map((e) => e.answer)).toEqual(["watches"]);
    expect(stages.find((s) => s.stage === "independent")!.exercises).toEqual([]);
  });
});

describe("poprawki review Etapu 2 (W11/W12/W13)", () => {
  it("nextRequiredElementId nie koliduje po usunięciu elementu ze środka", () => {
    expect(nextRequiredElementId([{ id: "e1" }, { id: "e3" }])).toBe("e4");
    expect(nextRequiredElementId([])).toBe("e1");
    expect(nextRequiredElementId([{ id: "custom" }])).toBe("e1");
  });

  it("porzucone puste elementy i cytaty nie trafiają do patcha", () => {
    const snapshot = createLessonSnapshot(draft(), () => "unused");
    const first = snapshot.form.exercises[0]!;
    first.requiredElements = [{ id: "e1", text: "Roślina wytwarza cukry." }, { id: "e2", text: "  " }];
    first.sourceRefs = [{ quote: "wytwarza cukry" }, { quote: "" }];
    const patch = toLessonDraftPatch(snapshot);
    expect(patch.exercises![0]!.requiredElements).toEqual([{ id: "e1", text: "Roślina wytwarza cukry." }]);
    expect(patch.exercises![0]!.sourceRefs).toEqual([{ quote: "wytwarza cukry" }]);
  });

  it("lesson_short_answer: prompt wygrywa ze stem — payload ma jedną wersję pytania", () => {
    const shortDraft = draft({
      exercises: [{
        id: "00000000-0000-4000-8000-000000000051",
        revisionId: "00000000-0000-4000-8000-000000000061",
        exerciseType: "lesson_short_answer",
        objectiveId: "english_grammar.present_simple.third_person_s",
        instructionPl: "Odpowiedz krótko",
        stem: "Stare pytanie?",
        answer: "Yes, he does.",
        acceptedAnswers: [],
        focus: ["does"],
      }] as unknown as LessonDraftDto["exercises"],
    });
    const snapshot = createLessonSnapshot(shortDraft, () => "unused");
    snapshot.form.exercises[0]!.prompt = "Nowe pytanie?";
    const patch = toLessonDraftPatch(snapshot);
    expect(patch.exercises![0]!.prompt).toBe("Nowe pytanie?");
    expect(patch.exercises![0]).not.toHaveProperty("stem");
  });
});

describe("calculation editor", () => {
  function calculationDraft(): LessonDraftDto {
    const base = draft();
    base.exercises = [{
      ...base.exercises[1]!, exerciseType: "lesson_calculation", stem: undefined,
      prompt: "Podgląd początkowy", answer: "750 m", acceptedAnswers: [], focus: [],
      calculation: { kind: "scale_distance", params: { mapDistanceCm: 3.5, scaleDenominator: 25000 }, unit: "m", tolerance: 0.5, templateFamilyId: "scale" },
      sourceRefs: [{ quote: "Skala 1:25 000 oznacza, że 1 cm odpowiada 250 m." }],
    }];
    return base;
  }

  it("round-trips decimal parameters, tolerance, family and source without comma splitting", () => {
    const source = calculationDraft();
    const snapshot = createLessonSnapshot(source, () => "unused");
    const patch = toLessonDraftPatch(snapshot).exercises![0]!;
    expect(patch.calculation).toEqual(source.exercises[0]!.calculation);
    expect(patch.sourceRefs).toEqual(source.exercises[0]!.sourceRefs);
    expect(patch.prompt).toBe("Podgląd początkowy");
    expect(patch.acceptedAnswers).toEqual([]);
    expect(patch.focus).toEqual([]);
  });

  it("applies a supplied preview only to matching parameters without computing in client state", () => {
    const snapshot = createLessonSnapshot(calculationDraft(), () => "unused");
    const exercise = snapshot.form.exercises[0]!;
    const original = structuredClone(exercise.calculation!);
    if (original.kind !== "scale_distance") throw new Error("Expected scale fixture");
    exercise.calculation = { ...original, params: { mapDistanceCm: 4, scaleDenominator: 25000 } };
    expect(applyCalculationPreview(exercise, original, { prompt: "Stary podgląd", answer: "875 m" })).toEqual(exercise);
    const refreshed = applyCalculationPreview(exercise, exercise.calculation!, { prompt: "Dostarczony podgląd dla 4 cm", answer: "1000 m" });
    expect(refreshed.prompt).toBe("Dostarczony podgląd dla 4 cm");
    expect(refreshed.answer).toBe("1000 m");
    snapshot.form.exercises[0] = refreshed;
    expect(toLessonDraftPatch(snapshot).exercises![0]).toMatchObject({ prompt: "Dostarczony podgląd dla 4 cm", answer: "1000 m", acceptedAnswers: [], focus: [] });
  });

  it("keeps variants grouped by objective and template family after removing one", () => {
    const ex = createLessonSnapshot(calculationDraft(), () => "unused").form.exercises[0]!;
    const variants = [ex, { ...ex, clientKey: "variant-2" }, { ...ex, clientKey: "other-objective", objectiveId: "other" }];
    expect(groupCalculationFamilies(variants).map(g => g.exercises.length)).toEqual([2, 1]);
    expect(groupCalculationFamilies(variants.filter(e => e.clientKey !== ex.clientKey)).map(g => g.exercises.length)).toEqual([1, 1]);
  });
});

describe("wybór ze słuchu (#198): payload i licznik nagrań", () => {
  const OBJ = "english_grammar.present_simple.third_person_s";
  const listen = (n: number, sentenceAudio?: LessonDraftDto["exercises"][number]["sentenceAudio"]): LessonDraftDto["exercises"][number] => ({
    id: `00000000-0000-4000-8000-0000000000${n}3`,
    revisionId: `00000000-0000-4000-8000-0000000000${n}4`,
    exerciseType: "lesson_listen_choice",
    objectiveId: OBJ,
    stem: "He ___ football.",
    answer: "plays",
    acceptedAnswers: [],
    focus: ["plays"],
    options: [{ id: "a", text: "plays" }, { id: "b", text: "play" }],
    correctOption: "a",
    ...(sentenceAudio ? { sentenceAudio } : {}),
  });

  it("payload nie niesie sentenceAudio ani promptAudio i przechodzi schemat wejścia", () => {
    const exercise = listen(1, { state: "ready", assetId: "00000000-0000-4000-8000-0000000000aa", previousAssetId: "00000000-0000-4000-8000-0000000000ab" });
    const snapshot = createLessonSnapshot(draft({ exercises: [exercise] }), () => "unused");
    const sent = toLessonDraftPatch(snapshot).exercises![0]!;
    expect(sent).not.toHaveProperty("sentenceAudio");
    expect(sent).not.toHaveProperty("promptAudio");
    expect(LessonExerciseInputSchema.safeParse(sent).success).toBe(true);
    expect(JSON.stringify(sent)).not.toContain("Audio");
  });

  it("polecenie, podpowiedź i piktogram wpisane w ćwiczeniu słuchowym nie trafiają do payloadu", () => {
    const snapshot = createLessonSnapshot(draft({ exercises: [listen(1)] }), () => "unused");
    const ex = snapshot.form.exercises[0]!;
    ex.instructionPl = "Wybierz";
    ex.hint = "podpowiedź";
    ex.visualSubject = "girl";
    const sent = toLessonDraftPatch(snapshot).exercises![0]!;
    expect(sent).not.toHaveProperty("instructionPl");
    expect(sent).not.toHaveProperty("hint");
    expect(sent).not.toHaveProperty("visualSubject");
    expect(sent).toMatchObject({ stem: "He ___ football.", correctOption: "a" });
    expect(LessonExerciseInputSchema.safeParse(sent).success).toBe(true);
  });

  it("licznik liczy ćwiczenia słuchowe bez gotowego nagrania (pending, failed, brak wpisu)", () => {
    const exercises = [
      listen(1, { state: "ready", assetId: "00000000-0000-4000-8000-0000000000aa" }),
      listen(2, { state: "pending" }),
      listen(3, { state: "failed" }),
      listen(4),
      draft().exercises[0]!,
    ];
    expect(missingListenAudioCount(exercises)).toBe(3);
    expect(missingListenAudioCount([exercises[0]!, exercises[4]!])).toBe(0);
    expect(missingListenAudioCount([])).toBe(0);
  });
});

describe("ton lektora (voiceTone)", () => {
  const withTone = () => {
    const base = draft();
    base.exercises[0]!.voiceTone = "curious";
    base.exercises[0]!.promptAudio = { state: "ready", assetId: "00000000-0000-4000-8000-0000000000aa" };
    return base;
  };

  it("carries the exercise tone through the form into the patch and never sends promptAudio", () => {
    const snapshot = createLessonSnapshot(withTone(), () => "unused");
    expect(snapshot.form.exercises[0]!.voiceTone).toBe("curious");
    const patch = toLessonDraftPatch(snapshot);
    expect(patch.exercises![0]!.voiceTone).toBe("curious");
    expect(patch.exercises![1]).not.toHaveProperty("voiceTone");
    expect(JSON.stringify(patch)).not.toContain("promptAudio");
  });

  it("drops the tone from the patch when the parent picks the default", () => {
    const snapshot = createLessonSnapshot(withTone(), () => "unused");
    snapshot.form.exercises[0]!.voiceTone = undefined;
    expect(toLessonDraftPatch(snapshot).exercises![0]).not.toHaveProperty("voiceTone");
  });

  it("treats a tone-only edit as a change of the exercise", () => {
    const base = createLessonSnapshot(draft(), () => "unused").form.exercises[0]!;
    const edited = { ...base, voiceTone: "gentle" as const };
    expect(lessonExerciseChanged(edited, base)).toBe(true);
    expect(lessonExerciseChanged(base, base)).toBe(false);
  });

  const dynamicDraft = () => draft({
    dynamicTopic: {
      titlePl: "Rzeki",
      objectives: [{
        id: "o1",
        titlePl: "Rzeki Polski",
        cards: [
          { title: "Wisła", body: "Najdłuższa rzeka.", voiceTone: "mysterious" },
          { title: "Odra", body: "Druga rzeka." },
        ],
      }],
    },
    cardAudio: [{ objectiveId: "o1", cardIndex: 0, audio: { state: "ready", assetId: "00000000-0000-4000-8000-0000000000bb" } }],
  });

  it("carries card tones through the form into the patch without card audio", () => {
    const snapshot = createLessonSnapshot(dynamicDraft(), () => "unused");
    expect(snapshot.form.dynamicObjectives![0]!.cards[0]!.voiceTone).toBe("mysterious");
    const cards = toLessonDraftPatch(snapshot).dynamicTopic!.objectives[0]!.cards;
    expect(cards[0]).toEqual({ title: "Wisła", body: "Najdłuższa rzeka.", voiceTone: "mysterious" });
    expect(cards[1]).toEqual({ title: "Odra", body: "Druga rzeka." });
    expect(JSON.stringify(cards)).not.toContain("audio");
  });

  it("removes a card tone from the patch when the parent picks the default", () => {
    const snapshot = createLessonSnapshot(dynamicDraft(), () => "unused");
    const card = snapshot.form.dynamicObjectives![0]!.cards[0]!;
    snapshot.form.dynamicObjectives![0]!.cards[0] = { title: card.title, body: card.body };
    expect(toLessonDraftPatch(snapshot).dynamicTopic!.objectives[0]!.cards[0]).not.toHaveProperty("voiceTone");
  });
});

describe("topRejectedReasons (powody odrzuceń przy generowaniu)", () => {
  it("zwraca najczęstsze powody malejąco, przy remisie alfabetycznie, do limitu 5", () => {
    const reasons = {
      "słowo spoza materiału: raining": 3,
      "inny powód": 1,
      "słowo spoza materiału: boots": 3,
      "zdanie bez słownictwa z materiału": 2,
      "powód A": 1,
      "powód B": 1,
      "powód C": 1,
    };
    expect(topRejectedReasons(reasons)).toEqual([
      { reason: "słowo spoza materiału: boots", count: 3 },
      { reason: "słowo spoza materiału: raining", count: 3 },
      { reason: "zdanie bez słownictwa z materiału", count: 2 },
      { reason: "inny powód", count: 1 },
      { reason: "powód A", count: 1 },
    ]);
    expect(topRejectedReasons(reasons, 2)).toHaveLength(2);
  });

  it("brak powodów (undefined albo pusty obiekt) daje pustą listę", () => {
    expect(topRejectedReasons(undefined)).toEqual([]);
    expect(topRejectedReasons({})).toEqual([]);
  });
});

describe("otherRejectedCount (odrzucenia spoza wypisanych powodów)", () => {
  const listed = [{ reason: "słowo spoza materiału: raining", count: 3 }, { reason: "tylko słowa pomocnicze: the", count: 2 }];

  it("to różnica liczby odrzuconych i sumy wypisanych powodów (inne powody walidacji, powody spoza pierwszej piątki)", () => {
    expect(otherRejectedCount(12, listed)).toBe(7);
    expect(otherRejectedCount(6, listed)).toBe(1);
  });

  it("gdy wypisane powody pokrywają wszystkie odrzucenia, nie ma innych powodów", () => {
    expect(otherRejectedCount(5, listed)).toBe(0);
    expect(otherRejectedCount(0, [])).toBe(0);
  });

  it("nigdy nie jest ujemna (liczniki z kilku przebiegów mogą się rozjechać)", () => {
    expect(otherRejectedCount(3, listed)).toBe(0);
  });
});

describe("formatRejectedReason (wiersz raportu odrzuceń)", () => {
  const TEMPLATE = "{reason} ×{n}";

  it("podstawia powód i liczbę do szablonu komunikatu", () => {
    expect(formatRejectedReason(TEMPLATE, "słowo spoza materiału: raining", 3)).toBe("słowo spoza materiału: raining ×3");
  });

  it("powód z $&, $$, $` i {n} trafia do tekstu dosłownie (nie jest wzorcem podstawienia ani szablonem)", () => {
    expect(formatRejectedReason(TEMPLATE, "słowo spoza materiału: a$&b", 2)).toBe("słowo spoza materiału: a$&b ×2");
    expect(formatRejectedReason(TEMPLATE, "cena $$ i $` i $'", 1)).toBe("cena $$ i $` i $' ×1");
    expect(formatRejectedReason(TEMPLATE, "tylko słowa pomocnicze: {n}", 5)).toBe("tylko słowa pomocnicze: {n} ×5");
    expect(formatRejectedReason(TEMPLATE, "{reason}", 4)).toBe("{reason} ×4");
  });
});

describe("lessonThemesPatch (usuwanie tematów zdań)", () => {
  it("nie dokłada interests przy zwykłym zapisie ćwiczeń", () => {
    expect(lessonThemesPatch(["dinozaury", "Minecraft"], ["dinozaury", "Minecraft"])).toBeUndefined();
    expect(lessonThemesPatch(undefined, [])).toBeUndefined();
    expect(lessonThemesPatch(undefined, undefined)).toBeUndefined();
    expect(lessonThemesPatch(["dinozaury"], null)).toBeUndefined();
  });

  it("po usunięciu tematów zwraca pustą listę", () => {
    expect(lessonThemesPatch(["dinozaury", "Minecraft"], [])).toEqual([]);
  });
});
