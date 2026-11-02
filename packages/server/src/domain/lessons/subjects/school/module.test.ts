import { describe, expect, it } from "vitest";
import { validateSubject } from "../../catalog-validation";
import { createSubjectRegistry } from "../../registry";
import { resolveLessonTopic, validateDynamicTopicData } from "../../topic-resolution";
import type { DynamicTopicData, LessonExerciseDraft } from "../../types";
import { poolCoverage, validateLessonExercise, validatePool } from "../../pool-validation";
import { renderCalculationPrompt, computeCalculationAnswer } from "../../calculation";
import type { CalculationSpec } from "@learning/contracts";
import { schoolSubject } from "./module";

const MATERIAL =
  "Fotosynteza to proces, w którym roślina z wody i dwutlenku węgla, przy udziale światła, wytwarza cukry. " +
  "Mieszko I przyjął chrzest w 966 roku, aby włączyć państwo do chrześcijańskiej Europy.";

const dynamicData: DynamicTopicData = {
  titlePl: "Przyroda i historia",
  objectives: [
    {
      id: "school.ddeck.fotosynteza",
      titlePl: "Fotosynteza",
      descriptionEn: "Photosynthesis: plants produce sugars from water, carbon dioxide and light.",
      cards: [
        { title: "Co to jest?", body: "Roślina wytwarza cukry z wody i dwutlenku węgla przy świetle." },
        { title: "Po co?", body: "Cukry są pokarmem rośliny." },
      ],
    },
  ],
};

const scale: CalculationSpec = {
  kind: "scale_distance", params: { scaleDenominator: 25000, mapDistanceCm: 3 },
  unit: "m", templateFamilyId: "map-scale",
};
function calculationDraft(calculation: CalculationSpec = scale, overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_calculation", objectiveId: dynamicData.objectives[0]!.id,
    calculation, prompt: renderCalculationPrompt(calculation), answer: computeCalculationAnswer(calculation).answer,
    acceptedAnswers: [], focus: [], sourceRefs: [{ quote: "wytwarza cukry" }], ...overrides,
  };
}

describe("school calculation validation", () => {
  const topic = schoolSubject.buildDynamicTopic!(dynamicData);
  it.each([
    [scale, "Na mapie w skali 1:25 000 odcinek ma 3 cm. Oblicz odległość w terenie w m.", "750 m"],
    [{ kind: "height_difference", params: { upperHeightM: 400, lowerHeightM: 150 }, unit: "m", templateFamilyId: "height" },
      "Punkt wyższy: 400 m n.p.m., punkt niższy: 150 m n.p.m. Oblicz różnicę wysokości w m.", "250 m"],
    [{ kind: "unit_conversion", params: { value: 2, fromUnit: "km" }, unit: "m", templateFamilyId: "units" },
      "Przelicz 2 km na m.", "2000 m"],
  ] as const)("accepts canonical %j without open-answer fields", (calculation, prompt, answer) => {
    expect(validateLessonExercise(calculationDraft(calculation, { prompt, answer }), schoolSubject, topic)).toEqual([]);
  });
  it.each([
    ["calculation", { calculation: undefined }],
    ["prompt", { prompt: "Oblicz odległość do Warszawy." }],
    ["answer", { answer: "0,75 km" }],
    ["acceptedAnswers", { acceptedAnswers: ["750"] }],
    ["focus", { focus: ["750"] }],
    ["sourceRefs", { sourceRefs: undefined }],
    ["requiredElements", { requiredElements: [{ id: "one", text: "wynik" }] }],
    ["familyId", { familyId: "open-answer-family" }],
  ] as const)("rejects an invalid %s", (field, overrides) => {
    expect(validateLessonExercise(calculationDraft(scale, overrides), schoolSubject, topic).some((error) => error.includes(field))).toBe(true);
  });
  it("collects invalid kind and excessive tolerance without throwing", () => {
    const invalid = { ...scale, kind: "unknown" } as unknown as CalculationSpec;
    expect(validateLessonExercise(calculationDraft(scale, { calculation: invalid }), schoolSubject, topic).some((error) => error.includes("calculation"))).toBe(true);
    expect(validateLessonExercise(calculationDraft(scale, { calculation: { ...scale, tolerance: 8 } }), schoolSubject, topic).some((error) => error.includes("calculation"))).toBe(true);
  });
  it("rejects calculation parameters attached to another exercise type", () => {
    expect(validateLessonExercise(openDraft({ calculation: scale }), schoolSubject, topic).some((error) => error.includes("calculation"))).toBe(true);
  });
  it("checks quote membership at the pool hook with material", () => {
    const forged = calculationDraft(scale, { sourceRefs: [{ quote: "Skala mapy określa stosunek odległości." }] });
    expect(validateLessonExercise(forged, schoolSubject, topic)).toEqual([]);
    expect(schoolSubject.validatePoolExtra!([forged], { material: MATERIAL }).get(0)?.some((error) => error.includes("sourceRefs"))).toBe(true);
  });
  it("allows numeric variants in a shared template family and deduplicates across family IDs", () => {
    const a = calculationDraft();
    const b = calculationDraft({ ...scale, params: { ...scale.params, mapDistanceCm: 4 } });
    expect(schoolSubject.validatePoolExtra!([a, b], { material: MATERIAL }).size).toBe(0);
    const duplicate = calculationDraft({ ...scale, templateFamilyId: "other-family" });
    const result = validatePool([a, b, duplicate], schoolSubject, topic);
    expect(result.valid).toEqual([a, b]);
    expect(result.rejected.map((entry) => entry.exercise)).toEqual([duplicate]);
  });
  it("treats the same template family slug in another objective as a separate family", () => {
    const other = calculationDraft({ kind: "height_difference", params: { upperHeightM: 400, lowerHeightM: 150 }, unit: "m", templateFamilyId: "map-scale" }, { objectiveId: "school.other" });
    expect(schoolSubject.validatePoolExtra!([calculationDraft(), other], { material: MATERIAL }).size).toBe(0);
  });
  it.each([
    { calculation: { kind: "height_difference", params: { upperHeightM: 400, lowerHeightM: 150 }, unit: "m", templateFamilyId: "map-scale" } },
    { calculation: { ...scale, unit: "km" } },
  ] as const)("rejects inconsistent calculation template family %j", (overrides) => {
    const result = schoolSubject.validatePoolExtra!([calculationDraft(), calculationDraft(scale, overrides)], { material: MATERIAL });
    expect(result.get(1)?.some((error) => error.includes("templateFamilyId"))).toBe(true);
  });
  it("requires a common conversion input unit in a template family", () => {
    const conversion: CalculationSpec = { kind: "unit_conversion", params: { value: 2, fromUnit: "km" }, unit: "m", templateFamilyId: "units" };
    const a = calculationDraft(conversion);
    const b = calculationDraft({ ...conversion, params: { value: 3, fromUnit: "cm" } });
    expect(schoolSubject.validatePoolExtra!([a, b], { material: MATERIAL }).get(1)?.some((error) => error.includes("templateFamilyId"))).toBe(true);
  });
  it("counts calculations as independent while retaining the school pool minima", () => {
    const gaps = poolCoverage([calculationDraft()], [dynamicData.objectives[0]!.id], schoolSubject.poolMinimums!);
    expect(gaps.map(({ stage, required, actual }) => ({ stage, required, actual }))).toEqual([
      { stage: "guided", required: 3, actual: 0 },
      { stage: "productive", required: 2, actual: 0 },
      { stage: "independent", required: 2, actual: 1 },
    ]);
  });
});

function openDraft(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_open_answer",
    objectiveId: "school.ddeck.fotosynteza",
    prompt: "Co to jest fotosynteza?",
    answer: "Roślina z wody i dwutlenku węgla, przy udziale światła, wytwarza cukry.",
    acceptedAnswers: [],
    focus: ["wytwarza cukry"],
    questionType: "definition",
    requiredElements: [{ id: "e1", text: "Roślina wytwarza cukry." }],
    expectedForm: "explanation",
    sourceRefs: [{ quote: "wytwarza cukry" }],
    ...overrides,
  };
}

describe("przedmiot school", () => {
  it("przechodzi walidację katalogu z pustą listą tematów", () => {
    expect(validateSubject(schoolSubject)).toEqual([]);
  });

  it("jawnie włącza cytaty źródłowe i tytuł przedmiotu od rodzica oraz niesie reguły typów w profilu", () => {
    expect(schoolSubject.sourceQuotes).toBe(true);
    expect(schoolSubject.materialSubjectTitle).toBe("parent");
    expect(Object.keys(schoolSubject.prompts.typeRules ?? {}).sort()).toEqual(["lesson_cloze", "lesson_group", "lesson_match"]);
    expect(schoolSubject.prompts.typeRules?.lesson_match).toContain("taken from the parent material");
    // Zagadnienia szkoły nie mają rodzaju ani własnych reguł etapu zagadnień.
    expect(schoolSubject.prompts.objectivesRules).toBeUndefined();
  });

  it("składa temat dynamiczny i rozwiązuje go przez rejestr", () => {
    const topic = schoolSubject.buildDynamicTopic!(dynamicData);
    expect(topic.id).toBe("dynamic");
    expect(topic.objectives[0]?.hints.missing_element).toBeTruthy();

    const registry = createSubjectRegistry([schoolSubject]);
    const resolved = resolveLessonTopic(registry, {
      subjectId: "school",
      topicId: "dynamic",
      topicVersion: 1,
      dynamicTopic: dynamicData,
    });
    expect(resolved?.topic.objectives[0]?.id).toBe("school.ddeck.fotosynteza");
  });

  it("waliduje dane dynamiczne regułami katalogu (karty 2–4)", () => {
    expect(validateDynamicTopicData(schoolSubject, dynamicData)).toEqual([]);
    const bad: DynamicTopicData = {
      ...dynamicData,
      objectives: [{ ...dynamicData.objectives[0]!, cards: [{ title: "Jedna", body: "Karta." }] }],
    };
    expect(validateDynamicTopicData(schoolSubject, bad).length).toBeGreaterThan(0);
  });

  it("akceptuje ćwiczenie otwarte z polami v3 i uziemionym cytatem", () => {
    const topic = schoolSubject.buildDynamicTopic!(dynamicData);
    const { valid, rejected } = validatePool([openDraft()], schoolSubject, topic);
    expect(rejected).toEqual([]);
    expect(valid).toHaveLength(1);
    const extra = schoolSubject.validatePoolExtra!([openDraft()], { material: MATERIAL });
    expect(extra.size).toBe(0);
  });

  it.each([
    ["7 elementów wymaganych", { requiredElements: Array.from({ length: 7 }, (_, i) => ({ id: `e${i + 1}`, text: `element ${i + 1}` })) }],
    ["odpowiedź wzorcowa ponad 300 znaków", { answer: "a".repeat(301) }],
    ["cytat ponad 600 znaków", { sourceRefs: [{ quote: "b".repeat(601) }] }],
    ["4 cytaty", { sourceRefs: Array.from({ length: 4 }, () => ({ quote: "wytwarza cukry" })) }],
    ["5 typowych błędów", { commonErrors: ["a", "b", "c", "d", "e"] }],
  ])("odrzuca ćwiczenie łamiące limit kontraktu DTO (%s), zanim trafi do szkicu", (_label, overrides) => {
    // Szkic z polami ponad limit nie przeszedłby walidacji odpowiedzi API rodzica.
    const topic = schoolSubject.buildDynamicTopic!(dynamicData);
    const { valid, rejected } = validatePool([openDraft(overrides as Partial<LessonExerciseDraft>)], schoolSubject, topic);
    expect(valid).toEqual([]);
    expect(rejected).toHaveLength(1);
  });

  it("odrzuca cytat spoza materiału, a cytat rodzica przepuszcza", () => {
    const forged = openDraft({ sourceRefs: [{ quote: "Rośliny jedzą słońce na śniadanie." }] });
    const extra = schoolSubject.validatePoolExtra!([forged], { material: MATERIAL });
    expect(extra.get(0)?.some((e) => e.includes("sourceRefs"))).toBe(true);

    const parent = openDraft({ sourceRefs: [{ quote: "Rośliny jedzą słońce na śniadanie.", parentAdded: true }] });
    expect(schoolSubject.validatePoolExtra!([parent], { material: MATERIAL }).size).toBe(0);
  });

  it("porównuje cytat z materiałem z wielkością liter, ale bez różnic białych znaków", () => {
    const spaced = openDraft({ sourceRefs: [{ quote: "przy  udziale\nświatła, wytwarza cukry" }] });
    expect(schoolSubject.validatePoolExtra!([spaced], { material: MATERIAL }).size).toBe(0);
    const recased = openDraft({ sourceRefs: [{ quote: "Przy udziale światła, wytwarza cukry" }] });
    expect(schoolSubject.validatePoolExtra!([recased], { material: MATERIAL }).get(0)?.some((e) => e.includes("sourceRefs"))).toBe(true);
  });

  it("wymaga elementów wymaganych i formy dla odpowiedzi otwartej", () => {
    const topic = schoolSubject.buildDynamicTopic!(dynamicData);
    const { rejected } = validatePool(
      [openDraft({ requiredElements: undefined, expectedForm: undefined })],
      schoolSubject,
      topic,
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.errors.some((e) => e.includes("requiredElements"))).toBe(true);
  });

  it("pilnuje spójności rodziny pytań", () => {
    const a = openDraft({ familyId: "fam", prompt: "Co to jest fotosynteza?" });
    const b = openDraft({ familyId: "fam", prompt: "Wyjaśnij fotosyntezę.", answer: "Inny wzorzec odpowiedzi, wytwarza cukry.", focus: ["cukry"] });
    const extra = schoolSubject.validatePoolExtra!([a, b], { material: MATERIAL });
    expect(extra.get(1)?.some((e) => e.includes("familyId"))).toBe(true);
  });
  it("rodzina sformułowań przechodzi PEŁNĄ walidację puli (regresja deduplikacji)", () => {
    const topic = schoolSubject.buildDynamicTopic!(dynamicData);
    const a = openDraft({ familyId: "foto-def", prompt: "Co to jest fotosynteza?" });
    const b = openDraft({ familyId: "foto-def", prompt: "Wyjaśnij własnymi słowami, czym jest fotosynteza." });
    const extra = schoolSubject.validatePoolExtra!([a, b], { material: MATERIAL });
    expect(extra.size).toBe(0);
    const { valid, rejected } = validatePool([a, b], schoolSubject, topic);
    expect(rejected).toEqual([]);
    expect(valid).toHaveLength(2);
  });

  it("ten sam slug rodziny w dwóch zagadnieniach to dwie niezależne rodziny (partie per cel)", () => {
    // Model generuje każdy cel osobno i powtarza slugi typu „f1” — nie wolno przez to odrzucić drugiego celu.
    const a = openDraft({ familyId: "f1", prompt: "Co to jest fotosynteza?" });
    const b = openDraft({ familyId: "f1", objectiveId: "school.ddeck.chrzest", prompt: "Kiedy Mieszko przyjął chrzest?", answer: "W 966 roku.", focus: ["966"], requiredElements: [{ id: "e1", text: "966 rok" }] });
    expect(schoolSubject.validatePoolExtra!([a, b], { material: MATERIAL }).size).toBe(0);
  });

  it("rodzina z identycznym tekstem pytania jest odrzucana", () => {
    const a = openDraft({ familyId: "fam", prompt: "Co to jest fotosynteza?" });
    const b = openDraft({ familyId: "fam", prompt: "Co to jest fotosynteza?" });
    const extra = schoolSubject.validatePoolExtra!([a, b], { material: MATERIAL });
    expect(extra.get(1)?.some((e) => e.includes("familyId"))).toBe(true);
    // Różnica samej wielkości liter to nadal to samo pytanie (w odróżnieniu od cytatów).
    const lower = openDraft({ familyId: "fam", prompt: "co to jest  FOTOSYNTEZA?" });
    expect(schoolSubject.validatePoolExtra!([a, lower], { material: MATERIAL }).get(1)?.some((e) => e.includes("powiela"))).toBe(true);
  });

  it("za krótki cytat nie uziemia ćwiczenia", () => {
    const ex = openDraft({ sourceRefs: [{ quote: "966" }] });
    const extra = schoolSubject.validatePoolExtra!([ex], { material: MATERIAL });
    expect(extra.get(0)?.some((e) => e.includes("za krótki"))).toBe(true);
  });

  it("expectedForm na typie zamkniętym jest odrzucane", () => {
    const topic = schoolSubject.buildDynamicTopic!(dynamicData);
    const choice = openDraft({
      exerciseType: "lesson_choice",
      stem: "Co wytwarza roślina?",
      prompt: undefined,
      questionType: undefined,
      requiredElements: undefined,
      expectedForm: "short",
      focus: [],
      options: [{ id: "a", text: "cukry" }, { id: "b", text: "tlen" }],
      correctOption: "a",
      answer: "cukry",
    });
    const { rejected } = validatePool([choice], schoolSubject, topic);
    expect(rejected[0]?.errors.some((e) => e.includes("expectedForm"))).toBe(true);
  });});

function keywordsDraft(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_keywords",
    objectiveId: "school.ddeck.fotosynteza",
    familyId: "def",
    keywordOptions: [
      { id: "k1", text: "światło" }, { id: "k2", text: "cukry" }, { id: "k3", text: "tlen" }, { id: "k4", text: "korzenie" },
    ],
    keyOptionIds: ["k1", "k2"],
    answer: "światło, cukry",
    acceptedAnswers: [],
    focus: [],
    sourceRefs: [{ quote: "wytwarza cukry" }],
    ...overrides,
  };
}

describe("słowa kluczowe (lesson_keywords)", () => {
  const topic = schoolSubject.buildDynamicTopic!(dynamicData);
  const family = openDraft({ familyId: "def" });

  it("przechodzi walidację ćwiczenia i puli z rodziną pytań otwartych", () => {
    expect(validateLessonExercise(keywordsDraft(), schoolSubject, topic)).toEqual([]);
    expect(schoolSubject.validatePoolExtra!([family, keywordsDraft()], { material: MATERIAL }).size).toBe(0);
  });

  it.each([
    ["za mało pojęć", { keywordOptions: [{ id: "k1", text: "światło" }, { id: "k2", text: "cukry" }, { id: "k3", text: "tlen" }] }, "keywordOptions"],
    ["powtórzone pojęcie", { keywordOptions: [{ id: "k1", text: "światło" }, { id: "k2", text: "cukry" }, { id: "k3", text: "Cukry" }, { id: "k4", text: "tlen" }] }, "powiela"],
    ["jedno kluczowe", { keyOptionIds: ["k1"], answer: "światło" }, "keyOptionIds"],
    ["kluczowe spoza listy", { keyOptionIds: ["k1", "k9"] }, "keyOptionIds"],
    ["odpowiedź niezgodna z kluczem", { answer: "cukry, światło" }, "answer"],
    ["brak rodziny", { familyId: undefined }, "familyId"],
    ["warianty odpowiedzi", { acceptedAnswers: ["światło"] }, "acceptedAnswers"],
  ] as const)("odrzuca: %s", (_label, overrides, field) => {
    const errors = validateLessonExercise(keywordsDraft(overrides as Partial<LessonExerciseDraft>), schoolSubject, topic);
    expect(errors.some((error) => error.includes(field))).toBe(true);
  });

  it("odrzuca pola słów kluczowych w innym typie", () => {
    const errors = validateLessonExercise(openDraft({ keyOptionIds: ["k1", "k2"] }), schoolSubject, topic);
    expect(errors.some((error) => error.includes("keywordOptions"))).toBe(true);
  });

  it("wymaga rodziny pytań otwartych w tym samym zagadnieniu", () => {
    const extra = schoolSubject.validatePoolExtra!([openDraft({ familyId: "inna" }), keywordsDraft()], { material: MATERIAL });
    expect(extra.get(1)?.some((error) => error.includes("brak rodziny"))).toBe(true);
  });

  it("wymaga pojęć kluczowych z odpowiedzi wzorcowej albo materiału, a dystraktory sprawdza rodzic", () => {
    const outside = keywordsDraft({
      keywordOptions: [{ id: "k1", text: "chlorofil" }, { id: "k2", text: "cukry" }, { id: "k3", text: "tlen" }, { id: "k4", text: "korzenie" }],
      answer: "chlorofil, cukry",
    });
    const extra = schoolSubject.validatePoolExtra!([family, outside], { material: MATERIAL });
    expect(extra.get(1)?.some((error) => error.includes("chlorofil"))).toBe(true);
  });

  it("nie łączy słów kluczowych z rodziną pytań w kontroli spójności rodziny", () => {
    const extra = schoolSubject.validatePoolExtra!([family, openDraft({ familyId: "def", prompt: "Wyjaśnij fotosyntezę." }), keywordsDraft()], { material: MATERIAL });
    expect(extra.size).toBe(0);
  });

  it("nie liczy słów kluczowych do minimum etapu prowadzonego", () => {
    const gaps = poolCoverage([keywordsDraft(), keywordsDraft()], ["school.ddeck.fotosynteza"], { guided: 1, productive: 0, independent: 0 });
    expect(gaps).toEqual([{ objectiveId: "school.ddeck.fotosynteza", stage: "guided", required: 1, actual: 0 }]);
  });
});

describe("generacja: pytania porównawcze i odpowiedź mówiona (Etapy 3 i 6)", () => {
  it("reguły pól proszą o pytanie porównawcze dla par łatwo mylonych pojęć", () => {
    const rules = schoolSubject.prompts.fieldRules ?? "";
    expect(rules).toContain("łatwo mylonych pojęć");
    expect(rules).toContain("questionType: comparison");
  });

  it("szkoła przyjmuje dyktowanie wyłącznie dla odpowiedzi otwartej po polsku", () => {
    expect(schoolSubject.spokenAnswers).toEqual({ locale: "pl-PL", exerciseTypes: ["lesson_open_answer"] });
  });
});

function matchDraft(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_match",
    objectiveId: "school.ddeck.fotosynteza",
    instructionPl: "Połącz w pary.",
    pairs: [
      { left: "światło", right: "dostarcza energii" },
      { left: "woda", right: "pobierana korzeniami" },
      { left: "cukry", right: "powstają w liściach" },
    ],
    extraRight: ["oddycha skrzelami"],
    answer: "światło, woda, cukry",
    acceptedAnswers: [],
    focus: [],
    sourceRefs: [{ quote: "wytwarza cukry" }],
    ...overrides,
  };
}

function groupDraft(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_group",
    objectiveId: "school.ddeck.fotosynteza",
    instructionPl: "Pogrupuj.",
    groups: [{ id: "in", label: "substraty" }, { id: "out", label: "produkty" }],
    groupItems: [
      { text: "woda", groupId: "in" }, { text: "dwutlenek węgla", groupId: "in" },
      { text: "cukry", groupId: "out" }, { text: "tlen", groupId: "out" },
    ],
    answer: "substraty / produkty",
    acceptedAnswers: [],
    focus: [],
    sourceRefs: [{ quote: "wytwarza cukry" }],
    ...overrides,
  };
}

describe("połącz w pary (lesson_match)", () => {
  const topic = schoolSubject.buildDynamicTopic!(dynamicData);

  it("przechodzi walidację ćwiczenia i liczy się do etapu prowadzonego", () => {
    expect(validateLessonExercise(matchDraft(), schoolSubject, topic)).toEqual([]);
    expect(validateLessonExercise(matchDraft({ extraRight: undefined }), schoolSubject, topic)).toEqual([]);
    expect(poolCoverage([matchDraft()], ["school.ddeck.fotosynteza"], { guided: 1, productive: 0, independent: 0 })).toEqual([]);
  });

  it.each([
    ["za mało par", { pairs: [{ left: "a", right: "b" }, { left: "c", right: "d" }], answer: "a, c" }, "pairs"],
    ["powtórzona lewa strona", { pairs: [{ left: "woda", right: "x1" }, { left: "Woda", right: "x2" }, { left: "cukry", right: "x3" }], answer: "woda, Woda, cukry" }, "powiela"],
    ["prawa zawiera inną prawą", { extraRight: ["dostarcza energii słonecznej"] }, "powiela"],
    ["trzy dystraktory", { extraRight: ["a1", "a2", "a3"] }, "extraRight"],
    ["odpowiedź niezgodna z parami", { answer: "woda, światło, cukry" }, "answer"],
    ["warianty odpowiedzi", { acceptedAnswers: ["światło"] }, "acceptedAnswers"],
    ["za długa lewa strona", { pairs: [{ left: "x".repeat(41), right: "b" }, { left: "c", right: "d" }, { left: "e", right: "f" }] }, "pairs"],
  ] as const)("odrzuca: %s", (_label, overrides, field) => {
    const errors = validateLessonExercise(matchDraft(overrides as Partial<LessonExerciseDraft>), schoolSubject, topic);
    expect(errors.some((error) => error.includes(field))).toBe(true);
  });

  it("fragment słowa nie jest powtórzeniem: „tlen” obok „dwutlenek węgla” przechodzi", () => {
    const draft = matchDraft({
      pairs: [{ left: "tlen", right: "powstaje w liściach" }, { left: "dwutlenek węgla", right: "roślina pobiera z powietrza" }, { left: "woda", right: "pobierana korzeniami" }],
      extraRight: [],
      answer: "tlen, dwutlenek węgla, woda",
    });
    expect(validateLessonExercise(draft, schoolSubject, topic)).toEqual([]);
  });

  it("odrzuca pary w innym typie", () => {
    const errors = validateLessonExercise(groupDraft({ pairs: matchDraft().pairs }), schoolSubject, topic);
    expect(errors.some((error) => error.includes("pairs"))).toBe(true);
  });
});

describe("pogrupuj (lesson_group)", () => {
  const topic = schoolSubject.buildDynamicTopic!(dynamicData);

  it("przechodzi walidację ćwiczenia", () => {
    expect(validateLessonExercise(groupDraft(), schoolSubject, topic)).toEqual([]);
  });

  it.each([
    ["jedna grupa", { groups: [{ id: "in", label: "substraty" }], answer: "substraty" }, "groups"],
    ["grupa z jednym elementem", { groupItems: [
      { text: "woda", groupId: "in" }, { text: "dwutlenek węgla", groupId: "in" }, { text: "światło", groupId: "in" }, { text: "tlen", groupId: "out" },
    ] }, "minimum"],
    ["nieznana grupa", { groupItems: [
      { text: "woda", groupId: "in" }, { text: "dwutlenek węgla", groupId: "in" }, { text: "cukry", groupId: "out" }, { text: "tlen", groupId: "xx" },
    ] }, "jednej z grup"],
    ["powtórzony element", { groupItems: [
      { text: "woda", groupId: "in" }, { text: "Woda ", groupId: "in" }, { text: "cukry", groupId: "out" }, { text: "tlen", groupId: "out" },
    ] }, "powtarza"],
    ["element jest etykietą", { groupItems: [
      { text: "woda", groupId: "in" }, { text: "produkty", groupId: "in" }, { text: "cukry", groupId: "out" }, { text: "tlen", groupId: "out" },
    ] }, "etykietą"],
    ["odpowiedź niezgodna z grupami", { answer: "produkty / substraty" }, "answer"],
  ] as const)("odrzuca: %s", (_label, overrides, field) => {
    const errors = validateLessonExercise(groupDraft(overrides as Partial<LessonExerciseDraft>), schoolSubject, topic);
    expect(errors.some((error) => error.includes(field))).toBe(true);
  });

  it("kolejność par i grup nie zmienia tożsamości ćwiczenia (deduplikacja puli)", () => {
    const reversed = groupDraft({ groups: [{ id: "out", label: "produkty" }, { id: "in", label: "substraty" }], answer: "produkty / substraty" });
    const { valid } = validatePool([groupDraft(), reversed], schoolSubject, topic);
    expect(valid).toHaveLength(1);
    const shuffledPairs = matchDraft({ pairs: [...matchDraft().pairs!].reverse(), answer: "cukry, woda, światło" });
    expect(validatePool([matchDraft(), shuffledPairs], schoolSubject, topic).valid).toHaveLength(1);
  });
});

function clozeDraft(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_cloze",
    objectiveId: "school.ddeck.fotosynteza",
    instructionPl: "Uzupełnij tekst.",
    clozeText: "Roślina pobiera ___ z powietrza, a korzeniami pobiera ___. W liściach powstają ___.",
    gapAnswers: ["dwutlenek węgla", "wodę", "cukry"],
    extraWords: ["tlen"],
    answer: "dwutlenek węgla, wodę, cukry",
    acceptedAnswers: [],
    focus: [],
    sourceRefs: [{ quote: "wytwarza cukry" }],
    ...overrides,
  };
}

describe("uzupełnij tekst (lesson_cloze)", () => {
  const topic = schoolSubject.buildDynamicTopic!(dynamicData);

  it("przechodzi walidację, jest typem szkoły i liczy się do etapu prowadzonego", () => {
    expect(schoolSubject.exerciseTypes).toContain("lesson_cloze");
    expect(validateLessonExercise(clozeDraft(), schoolSubject, topic)).toEqual([]);
    expect(poolCoverage([clozeDraft()], ["school.ddeck.fotosynteza"], { guided: 1, productive: 0, independent: 0 })).toEqual([]);
  });

  it.each([
    ["jedna luka", { clozeText: "Roślina pobiera ___ z powietrza.", gapAnswers: ["dwutlenek węgla"], answer: "dwutlenek węgla" }, "gapAnswers"],
    ["dwie luki, trzy słowa", { clozeText: "Roślina pobiera ___ i ___.", answer: "dwutlenek węgla, wodę, cukry" }, "liczba słów"],
    ["pięć luk", {
      clozeText: "a ___ b ___ c ___ d ___ e ___ f", gapAnswers: ["w1", "w2", "w3", "w4", "w5"], answer: "w1, w2, w3, w4, w5",
    }, "gapAnswers"],
    ["słów mniej niż luk", { gapAnswers: ["dwutlenek węgla", "wodę"], answer: "dwutlenek węgla, wodę" }, "różni się"],
    ["bez dystraktora", { extraWords: undefined }, "extraWords"],
    ["trzy dystraktory", { extraWords: ["tlen", "azot", "sól"] }, "extraWords"],
    ["luki obok siebie", { clozeText: "Roślina pobiera ___, ___ i wytwarza ___." }, "co najmniej jedno słowo"],
    ["słowo z banku w tekście", { clozeText: "Roślina pobiera ___ z powietrza i wodę, a korzeniami ___. Powstają ___." }, "poza luką"],
    ["dystraktor w tekście", { clozeText: "Roślina pobiera ___, a nie tlen. Korzeniami pobiera ___. Powstają ___." }, "poza luką"],
    ["powtórzone słowo", { extraWords: ["Wodę"] }, "powiela"],
    ["słowo z samych znaków", { gapAnswers: ["dwutlenek węgla", "wodę", ">"], answer: "dwutlenek węgla, wodę, >" }, "liter ani cyfr"],
    ["pułapka z samych spacji", { extraWords: [" "] }, "liter ani cyfr"],
    ["słowo dłuższe niż 3 słowa", { extraWords: ["o wiele większa niż"] }, "więcej niż 3"],
    ["podkreślenie poza luką", { clozeText: "Roślina pobiera ___ z powietrza, korzeniami ___. Powstają ___ _" }, "podkreślenie"],
    ["odpowiedź niezgodna ze słowami", { answer: "wodę, cukry, dwutlenek węgla" }, "answer"],
    ["warianty odpowiedzi", { acceptedAnswers: ["wodę"] }, "acceptedAnswers"],
    ["za długi tekst", { clozeText: `${"x ".repeat(150)}___ y ___ z ___` }, "clozeText"],
  ] as const)("odrzuca: %s", (_label, overrides, field) => {
    const errors = validateLessonExercise(clozeDraft(overrides as Partial<LessonExerciseDraft>), schoolSubject, topic);
    expect(errors.some((error) => error.includes(field))).toBe(true);
  });

  it("fragment słowa nie podpowiada: „tlen” w banku obok „dwutlenek” w tekście przechodzi", () => {
    const draft = clozeDraft({
      clozeText: "Dwutlenek węgla roślina bierze z powietrza. Oddaje ___, a korzeniami pobiera ___.",
      gapAnswers: ["tlen", "wodę"],
      extraWords: ["cukry"],
      answer: "tlen, wodę",
    });
    expect(validateLessonExercise(draft, schoolSubject, topic)).toEqual([]);
  });

  it("odrzuca tekst z lukami w innym typie", () => {
    const errors = validateLessonExercise(matchDraft({ clozeText: "a ___ b ___" }), schoolSubject, topic);
    expect(errors.some((error) => error.includes("clozeText"))).toBe(true);
  });

  it("dystraktory nie zmieniają tożsamości, a inne luki ją zmieniają", () => {
    expect(validatePool([clozeDraft(), clozeDraft({ extraWords: ["azot"] })], schoolSubject, topic).valid).toHaveLength(1);
    const other = clozeDraft({ gapAnswers: ["dwutlenek węgla", "wodę", "skrobia"], extraWords: ["tlen"], answer: "dwutlenek węgla, wodę, skrobia" });
    expect(validatePool([clozeDraft(), other], schoolSubject, topic).valid).toHaveLength(2);
  });

  it("prompt generatora opisuje luki z bankiem słów", () => {
    expect(schoolSubject.prompts.fieldRules).toContain("lesson_cloze");
  });
});

describe("schoolSubject — zdanie feedbacku", () => {
  it("nie nagrywa zdania po odpowiedzi", () => {
    expect(schoolSubject.ttsForFeedbackSentence).toBe(false);
  });

  it("nie przyjmuje wyjaśnień błędu", () => {
    expect(schoolSubject.exerciseExplanations).toBe(false);
  });
});
