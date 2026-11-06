import { describe, expect, it } from "vitest";
import { createServices } from "../../../config";
import { LessonDraftDtoSchema, type CalculationSpec } from "@learning/contracts";
import { englishGrammarSubject } from "../../../domain/lessons/subjects/english-grammar/module";
import { validatePool } from "../../../domain/lessons/pool-validation";
import type { DynamicTopicData, LessonExerciseDraft, LessonTopic, SubjectModule } from "../../../domain/lessons/types";
import { schoolSubject } from "../../../domain/lessons/subjects/school/module";
import { validateDynamicTopicData } from "../../../domain/lessons/topic-resolution";
import { buildDynamicTopicData, buildPoolInput, createLessonFromMaterial, createMaterialLesson, buildObjectiveCriteria, listenChoiceAllowance, minimumCountPerObjective, objectiveBatchCounts, isWellShapedRawExercise, lessonPayloadVersion, poolStageCounts, scopeFamiliesToRun, splitStages, stripParentAddedFlags, sumRejectedReasons, toExerciseDraft, withoutEmptyOptionalArrays, withoutOrphanKeywords, withoutInvalidExplanation, withoutVoiceToneUnlessAllowed, withSubjectObjectiveKinds } from "./lesson-drafts";
import { buildLessonPayload } from "./lesson-payload";

describe("calculation persistence and grading criteria", () => {
  const calculation = { kind: "scale_distance" as const, params: { scaleDenominator: 25000, mapDistanceCm: 3 }, unit: "m" as const, templateFamilyId: "scale" };
  const draft: LessonExerciseDraft = {
    exerciseType: "lesson_calculation", objectiveId: "school.dx.scale",
    prompt: "Oblicz odległość.", answer: "750 m", acceptedAnswers: [], focus: [],
    calculation,
  };
  const hash = (exercise: LessonExerciseDraft) => buildObjectiveCriteria(exercise, schoolSubject, 1).criteriaHash;

  it("retains the private calculation through draft/payload conversion and marks payload v3", () => {
    const mapped = toExerciseDraft(draft);
    expect(mapped.calculation).toEqual(draft.calculation);
    expect(buildLessonPayload(mapped, schoolSubject).calculation).toEqual(draft.calculation);
    expect(toExerciseDraft(buildLessonPayload(mapped, schoolSubject)).calculation).toEqual(draft.calculation);
    expect(lessonPayloadVersion(mapped, schoolSubject)).toBe(3);
  });

  it("changes the criteria hash for parameters, kind, result unit and tolerance", () => {
    const spec = calculation;
    const alternatives: CalculationSpec[] = [
      { ...spec, params: { scaleDenominator: 25000, mapDistanceCm: 4 } },
      { ...spec, unit: "km" as const },
      { ...spec, tolerance: 1 },
      { kind: "height_difference" as const, params: { upperHeightM: 900, lowerHeightM: 150 }, unit: "m" as const, templateFamilyId: "height" },
    ];
    for (const calculation of alternatives) expect(hash({ ...draft, calculation })).not.toBe(hash(draft));
  });

  it("ignores template family, parameter key order and an explicit default tolerance", () => {
    expect(hash({ ...draft, calculation: { ...calculation, templateFamilyId: "another-family", tolerance: 0,
      params: { mapDistanceCm: 3, scaleDenominator: 25000 } } })).toBe(hash(draft));
  });
});

const OBJECTIVE_ID = "english_grammar.present_simple.third_person_s";

/** Minimalny temat zgodny z celem używanym przez przedmiot english_grammar. */
function presentSimpleTopic(): LessonTopic {
  const topic = englishGrammarSubject.topics.find((t) => t.id === "present_simple");
  if (!topic) throw new Error("fixture topic missing");
  return topic;
}

/** Poprawny kształtowo lesson_choice (surowy obiekt z portu). */
function validChoiceRaw(answer: string) {
  return {
    exerciseType: "lesson_choice",
    objectiveId: OBJECTIVE_ID,
    instructionPl: "Wybierz.",
    stem: "She ___ football.",
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
function malformedOptionsRaw() {
  return {
    exerciseType: "lesson_choice",
    objectiveId: OBJECTIVE_ID,
    instructionPl: "Wybierz.",
    answer: "watches",
    acceptedAnswers: [],
    focus: [],
    options: [null, { id: "b", text: "watch" }],
    correctOption: "b",
  };
}

describe("P2-7: strażnik kształtu surowego ćwiczenia (isWellShapedRawExercise)", () => {
  it.each(["acceptedAnswers", "focus"])("odrzuca null w %s zamiast wywracać walidację puli", (field) => {
    const raw = { ...validChoiceRaw("watches"), [field]: [null] };
    expect(isWellShapedRawExercise(raw)).toBe(false);
    const rows = [validChoiceRaw("plays"), raw].filter(isWellShapedRawExercise).map(toExerciseDraft);
    expect(validatePool(rows, englishGrammarSubject, presentSimpleTopic()).valid.map((r) => r.answer)).toEqual(["plays"]);
  });
  it("validatePool odrzuca zły kształt bez wyjątku i zachowuje poprawne rekordy", () => {
    const topic = presentSimpleTopic();
    const drafts = [validChoiceRaw("plays"), malformedOptionsRaw()].map(toExerciseDraft);
    const result = validatePool(drafts, englishGrammarSubject, topic);
    expect(result.valid.map((ex) => ex.answer)).toEqual(["plays"]);
    expect(result.rejected).toHaveLength(1);
  });

  it("strażnik odrzuca ćwiczenie z null w options", () => {
    expect(isWellShapedRawExercise(malformedOptionsRaw())).toBe(false);
  });

  it("strażnik odrzuca options z elementem bez pola text", () => {
    expect(
      isWellShapedRawExercise({ ...validChoiceRaw("plays"), options: [{ id: "a" }, { id: "b", text: "x" }] }),
    ).toBe(false);
  });

  it("strażnik odrzuca items z elementem o złym typie", () => {
    expect(
      isWellShapedRawExercise({
        exerciseType: "lesson_order",
        objectiveId: OBJECTIVE_ID,
        answer: "a b c",
        acceptedAnswers: [],
        focus: [],
        items: [{ id: "i1", text: "a" }, 42, { id: "i3", text: "c" }],
      }),
    ).toBe(false);
  });

  it("strażnik odrzuca noticeSegments o złym kształcie (null segment)", () => {
    expect(
      isWellShapedRawExercise({
        exerciseType: "lesson_notice",
        objectiveId: OBJECTIVE_ID,
        answer: "plays",
        acceptedAnswers: [],
        focus: [],
        noticeSegments: [["plays", null], ["two"]],
        correctOption: "plays",
      }),
    ).toBe(false);
  });

  it("strażnik przepuszcza poprawny kształtowo lesson_choice", () => {
    expect(isWellShapedRawExercise(validChoiceRaw("plays"))).toBe(true);
  });

  it("strażnik przepuszcza ćwiczenie bez pól tablicowych (gap)", () => {
    expect(
      isWellShapedRawExercise({
        exerciseType: "lesson_gap",
        objectiveId: OBJECTIVE_ID,
        answer: "plays",
        acceptedAnswers: [],
        focus: ["plays"],
        stem: "___ here.",
      }),
    ).toBe(true);
  });

  it("top-level null in model output is rejected before mapping, preserving valid siblings", () => {
    const raws: unknown[] = [validChoiceRaw("plays"), null];
    const wellShaped = raws.filter(isWellShapedRawExercise).map(toExerciseDraft);
    expect(wellShaped).toHaveLength(1);
    expect(validatePool(wellShaped, englishGrammarSubject, presentSimpleTopic()).valid.map((ex) => ex.answer)).toEqual(["plays"]);
  });

  it("GREEN: po odfiltrowaniu strażnikiem validatePool nie rzuca i zwraca poprawne", () => {
    const topic = presentSimpleTopic();
    const raws = [validChoiceRaw("plays"), malformedOptionsRaw()];
    const wellShaped = raws.filter(isWellShapedRawExercise).map(toExerciseDraft);
    const { valid } = validatePool(wellShaped, englishGrammarSubject, topic);
    expect(valid.map((v) => v.answer)).toEqual(["plays"]);
  });
});

describe("ton lektora (voiceTone) z wyjścia modelu", () => {
  const rawExercise = {
    exerciseType: "lesson_open_answer",
    objectiveId: "school.dx.foto",
    prompt: "Co to jest fotosynteza?",
    answer: "Roślina wytwarza cukry.",
    acceptedAnswers: [],
    focus: ["cukry"],
  };

  it("zachowuje znany ton ćwiczenia, a nieznany albo null pomija", () => {
    expect(toExerciseDraft({ ...rawExercise, voiceTone: "gentle" }).voiceTone).toBe("gentle");
    expect("voiceTone" in toExerciseDraft({ ...rawExercise, voiceTone: "loud" })).toBe(false);
    expect("voiceTone" in toExerciseDraft({ ...rawExercise, voiceTone: null })).toBe(false);
    expect("voiceTone" in toExerciseDraft({ ...rawExercise, voiceTone: 3 })).toBe(false);
    expect("voiceTone" in toExerciseDraft(rawExercise)).toBe(false);
  });

  it("przenosi ton do payloadu rewizji i z powrotem", () => {
    const payload = buildLessonPayload(toExerciseDraft({ ...rawExercise, voiceTone: "curious" }), schoolSubject);
    expect(payload.voiceTone).toBe("curious");
    expect(toExerciseDraft(payload).voiceTone).toBe("curious");
    expect("voiceTone" in buildLessonPayload(toExerciseDraft(rawExercise), schoolSubject)).toBe(false);
  });

  it("nie zmienia kryteriów celu ani wersji payloadu", () => {
    const plain = toExerciseDraft(rawExercise);
    const toned = toExerciseDraft({ ...rawExercise, voiceTone: "mysterious" });
    expect(buildObjectiveCriteria(toned, schoolSubject, 1)).toEqual(buildObjectiveCriteria(plain, schoolSubject, 1));
    expect(lessonPayloadVersion(toned, schoolSubject)).toBe(lessonPayloadVersion(plain, schoolSubject));
  });

  it("karty zagadnień: znany ton zachowany, nieznany i null pominięte", () => {
    const raw = {
      slug: "a",
      titlePl: "Zagadnienie",
      descriptionEn: "Topic description.",
      cards: [
        { title: "Karta 1", body: "Treść 1.", voiceTone: "cheerful" },
        { title: "Karta 2", body: "Treść 2.", voiceTone: "loud" },
        { title: "Karta 3", body: "Treść 3.", voiceTone: null },
        { title: "Karta 4", body: "Treść 4." },
      ],
    };
    const cards = buildDynamicTopicData([raw], "school", "deck", "Temat").data!.objectives[0]!.cards;
    expect(cards[0]!.voiceTone).toBe("cheerful");
    expect(cards.slice(1).every((card) => !("voiceTone" in card))).toBe(true);
  });

  it("przedmiot bez ttsForPrompts: ton z wyjścia modelu jest odrzucany, nie psuje ćwiczenia ani karty", () => {
    const toned = toExerciseDraft({ ...rawExercise, voiceTone: "gentle" });
    expect(toned.voiceTone).toBe("gentle");
    expect("voiceTone" in withoutVoiceToneUnlessAllowed(toned, englishGrammarSubject)).toBe(false);
    expect(withoutVoiceToneUnlessAllowed(toned, schoolSubject).voiceTone).toBe("gentle");
    const plain = toExerciseDraft(rawExercise);
    expect(withoutVoiceToneUnlessAllowed(plain, englishGrammarSubject)).toBe(plain);
    // Pytania nie są szeptane: `mysterious` z modelu staje się `curious` (tak brzmi nagranie).
    expect(withoutVoiceToneUnlessAllowed(toExerciseDraft({ ...rawExercise, voiceTone: "mysterious" }), schoolSubject).voiceTone).toBe("curious");

    const raw = { slug: "a", titlePl: "Zagadnienie", descriptionEn: "Topic description.", cards: [{ title: "K", body: "T.", voiceTone: "cheerful" }] };
    const cards = buildDynamicTopicData([raw], "school", "deck", "Temat", () => [], false).data!.objectives[0]!.cards;
    expect("voiceTone" in cards[0]!).toBe(false);
  });
});

describe("wyjaśnienie błędu (explanationPl) z wyjścia modelu", () => {
  const rawExercise = {
    exerciseType: "lesson_gap",
    objectiveId: "english_grammar.present_simple.third_person_s",
    stem: "She ___ football.",
    answer: "plays",
    acceptedAnswers: [],
    focus: ["plays"],
  };

  it("toExerciseDraft: null i pusty tekst oznaczają brak pola, tekst jest przycinany", () => {
    expect("explanationPl" in toExerciseDraft({ ...rawExercise, explanationPl: null })).toBe(false);
    expect("explanationPl" in toExerciseDraft({ ...rawExercise, explanationPl: "   " })).toBe(false);
    expect("explanationPl" in toExerciseDraft({ ...rawExercise, explanationPl: 3 })).toBe(false);
    expect("explanationPl" in toExerciseDraft(rawExercise)).toBe(false);
    expect(toExerciseDraft({ ...rawExercise, explanationPl: "  Tekst.  " }).explanationPl).toBe("Tekst.");
  });

  it("wyjaśnienie złego typu nie odrzuca ćwiczenia — ćwiczenie zostaje bez pola", () => {
    const raw = { ...rawExercise, explanationPl: 5 };
    expect(isWellShapedRawExercise(raw)).toBe(true);
    const draft = toExerciseDraft(raw);
    expect("explanationPl" in draft).toBe(false);
    expect(draft.answer).toBe("plays");
  });

  it("buildLessonPayload przenosi pole, a toExerciseDraft odczytuje je z payloadu", () => {
    const payload = buildLessonPayload(toExerciseDraft({ ...rawExercise, explanationPl: "Po she dodajemy s." }), englishGrammarSubject);
    expect(payload.explanationPl).toBe("Po she dodajemy s.");
    expect(toExerciseDraft(payload).explanationPl).toBe("Po she dodajemy s.");
    expect("explanationPl" in buildLessonPayload(toExerciseDraft(rawExercise), englishGrammarSubject)).toBe(false);
  });

  it("withoutInvalidExplanation: poprawne zostaje, dwa zdania i przedmiot bez flagi usuwają pole", () => {
    const good = toExerciseDraft({ ...rawExercise, explanationPl: "Po she dodajemy s." });
    expect(withoutInvalidExplanation(good, englishGrammarSubject)).toBe(good);
    const two = toExerciseDraft({ ...rawExercise, explanationPl: "Po she dodajemy s. To ważne." });
    const stripped = withoutInvalidExplanation(two, englishGrammarSubject);
    expect("explanationPl" in stripped).toBe(false);
    const { explanationPl: _dropped, ...withoutField } = two;
    expect(stripped).toEqual(withoutField);
    expect("explanationPl" in withoutInvalidExplanation(good, schoolSubject)).toBe(false);
    const plain = toExerciseDraft(rawExercise);
    expect(withoutInvalidExplanation(plain, schoolSubject)).toBe(plain);
  });
});

describe("stripParentAddedFlags (generacja nie jest źródłem rodzica)", () => {
  it("usuwa flagę parentAdded z cytatów ćwiczeń generowanych", () => {
    const draft = toExerciseDraft({
      exerciseType: "lesson_open_answer",
      objectiveId: "school.dx.foto",
      prompt: "Co to jest fotosynteza?",
      answer: "Roślina wytwarza cukry.",
      acceptedAnswers: [],
      focus: ["cukry"],
      sourceRefs: [{ quote: "cytat spoza materiału, wystarczająco długi", parentAdded: true }],
    });
    expect(draft.sourceRefs?.[0]?.parentAdded).toBe(true);
    const [stripped] = stripParentAddedFlags([draft]);
    expect(stripped!.sourceRefs).toEqual([{ quote: "cytat spoza materiału, wystarczająco długi" }]);
  });
});

describe("objectiveBatchCounts (pula strukturalnie publikowalna i nieprzekraczana, W3)", () => {
  it("każda partia spełnia minima każdego etapu szkoły (3/2/2), także przy małej puli i wielu zagadnieniach", () => {
    for (const objectiveCount of [1, 3, 8]) {
      for (const count of objectiveBatchCounts(20, objectiveCount, schoolSubject)) {
        const split = splitStages(count);
        expect(split.guided).toBeGreaterThanOrEqual(3);
        expect(split.productive).toBeGreaterThanOrEqual(2);
        expect(split.independent).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("suma partii równa się zamówionej puli, gdy pula mieści minima (bez nadwyżki z zaokrągleń)", () => {
    const minimum = minimumCountPerObjective(schoolSubject);
    for (const poolSize of [20, 30, 60, 100, 120, 160]) {
      for (const objectiveCount of [1, 2, 3, 5, 6, 7, 8]) {
        const counts = objectiveBatchCounts(poolSize, objectiveCount, schoolSubject);
        const sum = counts.reduce((a, b) => a + b, 0);
        expect(counts).toHaveLength(objectiveCount);
        expect(sum, `pula ${poolSize}, cele ${objectiveCount}`).toBe(Math.max(poolSize, minimum * objectiveCount));
      }
    }
  });

  it("przy puli mniejszej niż minima podnosi ją do minimum publikacji (8 celów × minimum)", () => {
    const minimum = minimumCountPerObjective(schoolSubject);
    expect(objectiveBatchCounts(20, 8, schoolSubject)).toEqual(Array(8).fill(minimum));
    expect(objectiveBatchCounts(160, 3, schoolSubject).reduce((a, b) => a + b, 0)).toBe(160);
  });
});

describe("buildPoolInput — opcje przedmiotu w wejściu generacji", () => {
  const topic = (subject: SubjectModule) => {
    if (subject.buildDynamicTopic) {
      return subject.buildDynamicTopic({
        titlePl: "T",
        objectives: [{
          id: "x.dd.a", titlePl: "A", descriptionEn: "A.",
          cards: [{ title: "1", body: "1" }, { title: "2", body: "2" }],
        }],
      });
    }
    return subject.topics[0]!;
  };
  const build = (subject: SubjectModule) => {
    const resolved = topic(subject);
    return buildPoolInput(subject, resolved, resolved.objectives[0]!.id, 4, "material", undefined, true);
  };

  it("groundingRequired wynika z sourceQuotes przedmiotu, nie z obecności validatePoolExtra", () => {
    expect(build(schoolSubject).groundingRequired).toBe(true);
    expect(build(englishGrammarSubject).groundingRequired).toBe(false);
    // validatePoolExtra bez sourceQuotes nie wymusza już cytatów.
    const extraOnly: SubjectModule = { ...schoolSubject, sourceQuotes: undefined };
    expect(extraOnly.validatePoolExtra).toBeDefined();
    expect(build(extraOnly).groundingRequired).toBe(false);
    expect(build({ ...schoolSubject, sourceQuotes: false }).groundingRequired).toBe(false);
  });

  it("listenChoicePerObjective = 2 dla przedmiotu z nagraniami zdań i celu z typem; poza tym pole pominięte", () => {
    const grammarTopic = englishGrammarSubject.topics.find((t) => t.id === "present_simple")!;
    const withType = grammarTopic.objectives.find((o) => o.exerciseTypes.includes("lesson_listen_choice"))!;
    const withoutType = grammarTopic.objectives.find((o) => !o.exerciseTypes.includes("lesson_listen_choice"));
    const input = buildPoolInput(englishGrammarSubject, grammarTopic, withType.id, 9, "material", undefined, true);
    expect(input.listenChoicePerObjective).toBe(2);
    // Dodatek leży poza podziałem etapów i licznością partii.
    expect(input.countPerObjective).toBe(9);
    expect(input.stageCounts).toEqual(poolStageCounts(englishGrammarSubject, withType.exerciseTypes, 9));
    if (withoutType) {
      expect(buildPoolInput(englishGrammarSubject, grammarTopic, withoutType.id, 9, "material", undefined, true)).not.toHaveProperty("listenChoicePerObjective");
    }
    // Cel bez typu na liście (lista zawężona) nie dostaje pola.
    const narrowed: LessonTopic = {
      ...grammarTopic,
      objectives: grammarTopic.objectives.map((o) => ({ ...o, exerciseTypes: o.exerciseTypes.filter((type) => type !== "lesson_listen_choice") })),
    };
    expect(buildPoolInput(englishGrammarSubject, narrowed, withType.id, 9, "material", undefined, true)).not.toHaveProperty("listenChoicePerObjective");
    // Przedmiot bez nagrań zdań feedbacku (szkoła) nie dostaje pola.
    expect(build(schoolSubject)).not.toHaveProperty("listenChoicePerObjective");
    // Przedmiot bez typu na liście, choć z nagraniami zdań, też nie.
    const noTypeSubject: SubjectModule = { ...englishGrammarSubject, exerciseTypes: englishGrammarSubject.exerciseTypes.filter((type) => type !== "lesson_listen_choice") };
    expect(buildPoolInput(noTypeSubject, grammarTopic, withType.id, 9, "material", undefined, true)).not.toHaveProperty("listenChoicePerObjective");
  });

  it("listenChoiceAllowance odejmuje obecne ćwiczenia słuchowe celu (0, gdy limit wyczerpany)", () => {
    const grammarTopic = englishGrammarSubject.topics.find((t) => t.id === "present_simple")!;
    const withType = grammarTopic.objectives.find((o) => o.exerciseTypes.includes("lesson_listen_choice"))!;
    const listenOf = (objectiveId: string, stimulus: string) => ({ objectiveId, exerciseType: "lesson_listen_choice", stimulus });
    const other = { objectiveId: withType.id, exerciseType: "lesson_choice", stimulus: "x" };
    const foreign = listenOf("english_grammar.other", "f");
    const allowance = (existing: { objectiveId: string; exerciseType: string; stimulus: string }[]) =>
      listenChoiceAllowance(englishGrammarSubject, withType, existing);
    expect(allowance([other, foreign])).toBe(2);
    expect(allowance([listenOf(withType.id, "a"), other])).toBe(1);
    expect(allowance([listenOf(withType.id, "a"), listenOf(withType.id, "b")])).toBe(0);
    expect(allowance([listenOf(withType.id, "a"), listenOf(withType.id, "b"), listenOf(withType.id, "c")])).toBe(0);
  });

  it("przenosi reguły typów z profilu przedmiotu do profilu promptu, a brak reguł pomija pola", () => {
    const withRules = build(schoolSubject).promptProfile;
    expect(withRules.typeRules).toEqual(schoolSubject.prompts.typeRules);
    expect(withRules).not.toHaveProperty("objectivesRules");
    const bare = build({ ...schoolSubject, prompts: { ...schoolSubject.prompts, typeRules: undefined } }).promptProfile;
    expect(bare).not.toHaveProperty("typeRules");
    expect(build(englishGrammarSubject).promptProfile).not.toHaveProperty("typeRules");
  });

  describe("tematy zdań z zainteresowań dziecka", () => {
    const buildWith = (subject: SubjectModule, interests?: readonly string[]) => {
      const resolved = topic(subject);
      return buildPoolInput(subject, resolved, resolved.objectives[0]!.id, 4, "material", undefined, true, interests);
    };

    it("przedmiot z regułą i niepusta lista: lista oraz reguła trafiają do wejścia", () => {
      const input = buildWith(englishGrammarSubject, ["dinozaury"]);
      expect(input.interests).toEqual(["dinozaury"]);
      expect(input.promptProfile.interestsRule).toBe(englishGrammarSubject.prompts.interestsRule);
    });

    it("bez listy albo z pustą listą nie ma żadnego z pól", () => {
      for (const interests of [undefined, []]) {
        const input = buildWith(englishGrammarSubject, interests);
        expect(input).not.toHaveProperty("interests");
        expect(input.promptProfile).not.toHaveProperty("interestsRule");
      }
    });

    it("przedmiot bez reguły ignoruje listę", () => {
      const input = buildWith(schoolSubject, ["dinozaury"]);
      expect(input).not.toHaveProperty("interests");
      expect(input.promptProfile).not.toHaveProperty("interestsRule");
    });
  });
});

describe("buildPoolInput — zdania do unikania", () => {
  const resolved = englishGrammarSubject.topics[0]!;
  const build = (options?: Parameters<typeof buildPoolInput>[8]) =>
    buildPoolInput(englishGrammarSubject, resolved, resolved.objectives[0]!.id, 4, "material", undefined, true, undefined, options);

  it("niepusta lista trafia do wejścia", () => {
    const input = build({ avoidSentences: ["He plays football."] });
    expect(input.avoidSentences).toEqual(["He plays football."]);
  });

  it("brak opcji albo pusta lista: bez pola", () => {
    for (const input of [build(), build({}), build({ avoidSentences: [] })]) {
      expect(input).not.toHaveProperty("avoidSentences");
    }
  });
});

describe("withoutOrphanKeywords (słowa kluczowe bez rodziny pytań otwartych)", () => {
  const exercise = (exerciseType: LessonExerciseDraft["exerciseType"], answer: string, familyId?: string, objectiveId = "o1"): LessonExerciseDraft => ({
    exerciseType, objectiveId, answer, acceptedAnswers: [], focus: [], ...(familyId === undefined ? {} : { familyId }),
  });

  it("odrzuca świeże słowa kluczowe bez pytania otwartego tej rodziny w tym zagadnieniu", () => {
    const fresh = [
      exercise("lesson_keywords", "k-orphan", "f1"),
      exercise("lesson_keywords", "k-fresh-family", "f2"),
      exercise("lesson_open_answer", "open-f2", "f2"),
      exercise("lesson_keywords", "k-existing-family", "f3"),
      exercise("lesson_keywords", "k-other-objective", "f3", "o2"),
      exercise("lesson_keywords", "k-no-family"),
    ];
    const existing = [exercise("lesson_open_answer", "open-f3", "f3"), exercise("lesson_keywords", "k-old-orphan", "f9")];
    const result = withoutOrphanKeywords(existing, fresh);
    expect(result.kept.map((item) => item.answer)).toEqual(["k-fresh-family", "open-f2", "k-existing-family", "k-no-family"]);
    expect(result.dropped).toBe(2);
  });
});

describe("buildDynamicTopicData (wadliwe zagadnienie nie przerywa generacji)", () => {
  const card = (n: number) => ({ title: `Karta ${n}`, body: `Treść karty ${n}.` });
  const raw = (slug: string, cards = [card(1), card(2)], titlePl = `Zagadnienie ${slug}`) =>
    ({ slug, titlePl, descriptionEn: "Topic description.", cards });
  const validate = (objective: Parameters<NonNullable<Parameters<typeof buildDynamicTopicData>[4]>>[0]) =>
    validateDynamicTopicData(schoolSubject, { titlePl: "Temat", objectives: [objective] });

  it("pomija zagadnienie z jedną kartą albo pustym tytułem, a pozostałe zachowuje", () => {
    const built = buildDynamicTopicData([raw("a"), raw("b", [card(1)]), raw("c", undefined, "  "), raw("d")], "school", "deck", "Temat", validate);
    expect(built.data?.objectives.map((o) => o.id)).toEqual(["school.ddeck.a", "school.ddeck.d"]);
    expect(built.errors).toHaveLength(2);
    expect(validateDynamicTopicData(schoolSubject, built.data!)).toEqual([]);
  });

  it("nadaje unikalne identyfikatory także wtedy, gdy sufiks koliduje z innym slugiem", () => {
    const built = buildDynamicTopicData([raw("a"), raw("a_3"), raw("a")], "school", "deck", "Temat", validate);
    const ids = built.data!.objectives.map((o) => o.id);
    expect(new Set(ids).size).toBe(3);
    expect(validateDynamicTopicData(schoolSubject, built.data!)).toEqual([]);
  });

  it("prefiks identyfikatora celu pochodzi z przedmiotu, a szkoła zachowuje dotychczasowy", () => {
    const chapter = buildDynamicTopicData([raw("clothes")], "english_chapter", "deck1", "T");
    expect(chapter.data?.objectives.map((o) => o.id)).toEqual(["english_chapter.ddeck1.clothes"]);
    const school = buildDynamicTopicData([raw("clothes")], "school", "deck1", "T");
    expect(school.data?.objectives.map((o) => o.id)).toEqual(["school.ddeck1.clothes"]);
  });

  it("przenosi rodzaj zagadnienia (words/frame), a null, brak i nieznana wartość dają brak pola", () => {
    const built = buildDynamicTopicData(
      [{ ...raw("a"), kind: "words" }, { ...raw("b"), kind: "frame" }, { ...raw("c"), kind: null }, raw("d"), { ...raw("e"), kind: "other" }],
      "english_chapter", "deck1", "T",
    );
    const objectives = built.data!.objectives;
    expect(objectives.map((o) => o.kind)).toEqual(["words", "frame", undefined, undefined, undefined]);
    for (const objective of objectives.slice(2)) expect(objective).not.toHaveProperty("kind");
  });
});

describe("withSubjectObjectiveKinds (rodzaj zagadnienia zapisuje tylko przedmiot, który z niego korzysta)", () => {
  const data: DynamicTopicData = {
    titlePl: "Temat",
    objectives: [
      { id: "x.d1.a", titlePl: "A", descriptionEn: "A.", cards: [{ title: "t", body: "b" }, { title: "t2", body: "b2" }], kind: "words" },
      { id: "x.d1.b", titlePl: "B", descriptionEn: "B.", cards: [{ title: "t", body: "b" }, { title: "t2", body: "b2" }] },
    ],
  };

  it("przedmiot bez prompts.objectivesRules (szkoła) nigdy nie zapisuje kind", () => {
    expect(schoolSubject.prompts.objectivesRules).toBeUndefined();
    const stored = withSubjectObjectiveKinds(schoolSubject, data);
    for (const objective of stored.objectives) expect(objective).not.toHaveProperty("kind");
    expect(stored.objectives.map((o) => o.id)).toEqual(["x.d1.a", "x.d1.b"]);
    expect(stored.titlePl).toBe("Temat");
  });

  it("przedmiot z prompts.objectivesRules zachowuje kind", () => {
    const optedIn: SubjectModule = { ...schoolSubject, prompts: { ...schoolSubject.prompts, objectivesRules: "3–5 zagadnień." } };
    const stored = withSubjectObjectiveKinds(optedIn, data);
    expect(stored).toBe(data);
    expect(stored.objectives.map((o) => o.kind)).toEqual(["words", undefined]);
  });

  it("nie zmienia danych wejściowych", () => {
    withSubjectObjectiveKinds(schoolSubject, data);
    expect(data.objectives[0]!.kind).toBe("words");
  });
});

describe("sumRejectedReasons (liczniki powodów odrzuceń kolejnych przebiegów)", () => {
  it("powody o nazwach z prototypu obiektu (constructor, toString, __proto__) są liczone jak każde inne", () => {
    const expected: [string, number][] = [["constructor", 1], ["toString", 1], ["__proto__", 2], ["hasOwnProperty", 1]];
    // Liczniki odczytane z JSONB (JSON.parse daje własne pola, także „__proto__”).
    const stored = JSON.parse('{"constructor":1,"toString":1,"__proto__":2,"hasOwnProperty":1}') as Record<string, number>;
    expect(Object.entries(stored)).toEqual(expected);
    const summed = sumRejectedReasons(stored, stored);
    expect(Object.entries(summed)).toEqual(expected.map(([reason, count]) => [reason, 2 * count]));
    // Zwykły obiekt (JSONB, DTO), którego prototypu nie podmienił klucz „__proto__”.
    expect(Object.getPrototypeOf(summed)).toBe(Object.prototype);
    expect(LessonDraftDtoSchema.shape.rejectedReasons.safeParse(summed).success).toBe(true);
    const first = sumRejectedReasons(undefined, stored);
    expect(Object.entries(first)).toEqual(expected);
    expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
  });
});

describe("withoutEmptyOptionalArrays (puste tablice strict output to brak pola)", () => {
  it("nie odrzuca poprawnej luki gramatyki za puste tablice innych typów i v3 z modelu", () => {
    const grammarTopic = englishGrammarSubject.topics[0]!;
    const objective = grammarTopic.objectives.find((o) => o.exerciseTypes.includes("lesson_gap"))!;
    const raw = {
      exerciseType: "lesson_gap", objectiveId: objective.id, instructionPl: "Uzupełnij.", stem: "He ___ football.",
      answer: "plays", acceptedAnswers: [], focus: ["plays"],
      options: [], items: [], noticeSegments: [],
      requiredElements: [], supplementaryElements: [], commonErrors: [], sourceRefs: [],
      questionType: null, expectedForm: null, familyId: null,
    };
    // Bez czyszczenia poprawne ćwiczenie odpada (np. `options: []` łamie minimum kontraktu).
    expect(validatePool([toExerciseDraft(raw)], englishGrammarSubject, grammarTopic).rejected).toHaveLength(1);
    const cleaned = withoutEmptyOptionalArrays(toExerciseDraft(raw));
    for (const field of ["options", "items", "noticeSegments", "requiredElements", "supplementaryElements", "commonErrors", "sourceRefs"]) {
      expect(cleaned).not.toHaveProperty(field);
    }
    const result = validatePool([cleaned], englishGrammarSubject, grammarTopic);
    expect(result.rejected.flatMap((r) => r.errors)).toEqual([]);
    expect(result.valid).toHaveLength(1);
  });

  it("wybór bez opcji nadal jest odrzucany — pusta tablica nie ukrywa prawdziwego braku", () => {
    const grammarTopic = englishGrammarSubject.topics[0]!;
    const objective = grammarTopic.objectives.find((o) => o.exerciseTypes.includes("lesson_choice"))!;
    const cleaned = withoutEmptyOptionalArrays(toExerciseDraft({
      exerciseType: "lesson_choice", objectiveId: objective.id, instructionPl: "Wybierz.", stem: "He ___ football.",
      answer: "plays", acceptedAnswers: [], focus: ["plays"], options: [], correctOption: "a",
    }));
    expect(validatePool([cleaned], englishGrammarSubject, grammarTopic).rejected).toHaveLength(1);
  });
});

describe("scopeFamiliesToRun (dogenerowanie nie dołącza do istniejących rodzin)", () => {
  it("dodaje sufiks runu do familyId i templateFamilyId, zachowując poprawny slug", () => {
    const runId = "3f2a9c1e-0000-4000-8000-000000000000";
    const open = scopeFamiliesToRun({ exerciseType: "lesson_open_answer", objectiveId: "o", answer: "a", acceptedAnswers: [], focus: [], familyId: "f1" }, runId);
    expect(open.familyId).toBe("f1-r3f2a9c");
    const long = "a".repeat(56) + "-b";
    const calc = scopeFamiliesToRun({ exerciseType: "lesson_calculation", objectiveId: "o", answer: "750 m", acceptedAnswers: [], focus: [],
      calculation: { kind: "scale_distance", params: { scaleDenominator: 25000, mapDistanceCm: 3 }, unit: "m", templateFamilyId: long } }, runId);
    const slug = calc.calculation!.templateFamilyId;
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(slug.endsWith("-r3f2a9c")).toBe(true);
  });
});

describe("poolStageCounts (rachunek nie zabiera miejsca wymaganym pytaniom otwartym)", () => {
  it("przy celu z rachunkami przesuwa jedno miejsce z produktywnego do samodzielnego, zachowując budżet i minima", () => {
    // 60 ćwiczeń na 6 zagadnień (sonda na prawdziwym LLM): 4/4/2 — oba samodzielne potrzebne pytaniom otwartym.
    expect(splitStages(10)).toEqual({ guided: 4, productive: 4, independent: 2 });
    expect(poolStageCounts(schoolSubject, ["lesson_open_answer", "lesson_calculation"], 10)).toEqual({ guided: 4, productive: 3, independent: 3 });
  });

  it("nie zmienia podziału bez rachunków, przy zapasie samodzielnym ani kosztem minimum produktywnego", () => {
    expect(poolStageCounts(schoolSubject, ["lesson_open_answer"], 10)).toEqual(splitStages(10));
    expect(poolStageCounts(schoolSubject, ["lesson_open_answer", "lesson_calculation"], 15)).toEqual(splitStages(15));
    // 5 → 2/2/1: przesunięcie zabrałoby produktywnemu minimum 2, więc podział zostaje.
    expect(poolStageCounts(schoolSubject, ["lesson_open_answer", "lesson_calculation"], 5)).toEqual(splitStages(5));
  });
});

describe("createLessonFromMaterial / createMaterialLesson (zestaw z materiału tylko dla przedmiotów o stałym tytule)", () => {
  // Odrzucenie następuje przed jakimkolwiek zapisem, więc baza nie jest potrzebna.
  const services = createServices({ db: {} as never });
  const command = {
    topicTitlePl: "Unit 1",
    material: "I like pizza.",
    clientRequestId: "11111111-1111-4111-8111-111111111111",
  };

  it("przedmiot katalogowy (bez buildDynamicTopic) kończy się validation", async () => {
    await expect(createLessonFromMaterial(services, { ...command, subjectId: "english_grammar" })).rejects.toMatchObject({ code: "validation" });
    await expect(createMaterialLesson(services, { ...command, subjectId: "english_grammar" })).rejects.toMatchObject({ code: "validation" });
  });

  it("przedmiot z nazwą od rodzica (szkoła) idzie ścieżką szkolną, nie tą", async () => {
    await expect(createLessonFromMaterial(services, { ...command, subjectId: "school" })).rejects.toMatchObject({ code: "validation" });
  });

  it("nieznany przedmiot kończy się validation", async () => {
    await expect(createLessonFromMaterial(services, { ...command, subjectId: "history" })).rejects.toMatchObject({ code: "validation" });
  });

  it("createMaterialLesson wymaga dokładnie jednego z material / sourceMaterialId (przed zapisem)", async () => {
    const { material, ...withoutMaterial } = command;
    const sourceMaterialId = "33333333-3333-4333-8333-333333333333";
    await expect(createMaterialLesson(services, { ...withoutMaterial, subjectId: "english_chapter" })).rejects.toMatchObject({ code: "validation" });
    await expect(createMaterialLesson(services, { ...command, subjectId: "english_chapter", material, sourceMaterialId, expectedSourceRevision: 1 })).rejects.toMatchObject({ code: "validation" });
  });

  it("createMaterialLesson wymaga rewizji podglądu przy źródle i tylko przy nim (przed zapisem)", async () => {
    const { material: _material, ...withoutMaterial } = command;
    const sourceMaterialId = "33333333-3333-4333-8333-333333333333";
    await expect(createMaterialLesson(services, { ...withoutMaterial, subjectId: "english_chapter", sourceMaterialId })).rejects.toMatchObject({ code: "validation" });
    await expect(createMaterialLesson(services, { ...command, subjectId: "english_chapter", expectedSourceRevision: 1 })).rejects.toMatchObject({ code: "validation" });
  });
});
