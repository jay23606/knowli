import { describe, expect, it } from "vitest";
import type { AgentObjective, LessonExerciseDraft } from "../../types";
import { baseNormalizer } from "../../normalize";
import { createProductionSubjectRegistry } from "..";
import { schoolAgentPolicy } from "./agent-policy";
import { schoolSubject } from "./module";

const objective: AgentObjective = {
  id: "school.dx.geografia",
  titlePl: "Geografia",
  descriptionEn: "Geography.",
  cards: [{ title: "Mapa", body: "Mapa to obraz Ziemi." }],
  exerciseTypes: [],
};

function draft(overrides: Partial<LessonExerciseDraft>): LessonExerciseDraft {
  return { exerciseType: "lesson_open_answer", objectiveId: objective.id, answer: "Mierzeja Wiślana", acceptedAnswers: [], focus: [], ...overrides };
}

const gate = (d: LessonExerciseDraft) => schoolAgentPolicy.exerciseGate!(d, objective, { material: "" });
const sanitize = (d: LessonExerciseDraft) => schoolAgentPolicy.sanitize!(d);

describe("schoolAgentPolicy — wartości i typy", () => {
  it("jest polityką przedmiotu szkolnego", () => {
    expect(schoolSubject.agentPolicy).toBe(schoolAgentPolicy);
  });

  it("bramka podpowiedzi używa normalizatora przedmiotu (skrót `baseNormalizer` w polityce)", () => {
    // Polityka nie importuje modułu (cykl), więc normalizator jest wpisany wprost — musi być tym samym.
    expect(schoolSubject.normalizer).toBe(baseNormalizer);
  });

  it("ma zapas samodzielnych 1 i luz 2, a checker dostaje materiał", () => {
    expect(schoolAgentPolicy.independentReserve).toBe(1);
    expect(schoolAgentPolicy.slack).toBe(2);
    expect(schoolAgentPolicy.checkerNeedsMaterial).toBe(true);
  });

  it("typy ślepe to zamknięte typy z lukami, bez otwartych, układanek, rachunków i słów kluczowych", () => {
    expect(schoolAgentPolicy.blindSolveTypes).toEqual(["lesson_choice", "lesson_match", "lesson_group", "lesson_cloze", "lesson_gap"]);
    expect(schoolAgentPolicy.blindSolveTypes).toContain("lesson_gap");
    for (const type of ["lesson_open_answer", "lesson_order", "lesson_calculation", "lesson_keywords", "lesson_listen_choice"] as const) {
      expect(schoolAgentPolicy.blindSolveTypes).not.toContain(type);
    }
    const subjectTypes = new Set<string>(schoolSubject.exerciseTypes);
    for (const type of schoolAgentPolicy.blindSolveTypes) expect(subjectTypes.has(type)).toBe(true);
  });

  it("warianty sprawdza się tylko przy lukach", () => {
    expect(schoolAgentPolicy.variantCheckTypes).toEqual(["lesson_gap"]);
  });

  it("sędzia podpowiedzi i kontrola otwarta dotyczą wyłącznie pytania otwartego", () => {
    expect(schoolAgentPolicy.hintJudgeTypes).toEqual(["lesson_open_answer"]);
    expect(schoolAgentPolicy.openAnswerCheckTypes).toEqual(["lesson_open_answer"]);
    const subjectTypes = new Set<string>(schoolSubject.exerciseTypes);
    for (const type of [...(schoolAgentPolicy.hintJudgeTypes ?? []), ...(schoolAgentPolicy.openAnswerCheckTypes ?? [])]) {
      expect(subjectTypes.has(type)).toBe(true);
    }
  });

  it("każdy zarejestrowany przedmiot: niepusta lista kontroli ma komplet tekstów odrzuceń, a sędzia podpowiedzi wymaga materiału", () => {
    const policies = createProductionSubjectRegistry()
      .listSubjects()
      .map((subject) => [subject.id, subject.agentPolicy] as const);
    // Szkoła ma obie listy: niezmiennik nie jest pusty.
    expect(policies.map(([id]) => id)).toContain(schoolSubject.id);
    for (const [id, policy] of policies) {
      const texts = policy.rejectionTexts;
      if ((policy.hintJudgeTypes ?? []).length > 0) {
        expect(policy.checkerNeedsMaterial, id).toBe(true);
        for (const text of [texts.hintUnsupported, texts.hintLanguage, texts.hintReveals]) expect(text?.length ?? 0, id).toBeGreaterThan(0);
      }
      if ((policy.openAnswerCheckTypes ?? []).length > 0) {
        for (const text of [texts.openMissing, texts.openWrong]) expect(text?.length ?? 0, id).toBeGreaterThan(0);
      }
    }
  });

  it("teksty odrzuceń wskazują, co poprawić, i nie pozwalają wyrzucić wymaganych elementów", () => {
    const texts = schoolAgentPolicy.rejectionTexts;
    expect(texts.hintUnsupported).toContain("set hint to null");
    expect(texts.hintLanguage).toContain("not correct Polish");
    expect(texts.hintReveals).toContain("Hint at the reasoning, not the content");
    expect(texts.openMissing).toContain("supplementaryElements");
    expect(texts.openMissing).toContain("Do not drop elements the question genuinely requires");
    expect(texts.openWrong).toContain("commonErrors");
  });

  it("leakVictim nie wspomina pokoju i podpowiada inny fakt lub inne sformułowanie", () => {
    expect(schoolAgentPolicy.rejectionTexts.leakVictim).not.toContain("room");
    expect(schoolAgentPolicy.rejectionTexts.leakVictim).toContain("ask about a different fact of the material or phrase the question differently");
    expect(schoolAgentPolicy.rejectionTexts.leakSource.length).toBeGreaterThan(0);
  });

  it("nie ma wymaganych typów, braków ani planu", () => {
    expect(schoolAgentPolicy.requiredTypes).toBeUndefined();
    expect(schoolAgentPolicy.objectiveGaps).toBeUndefined();
    expect(schoolAgentPolicy.planCoverage).toBeUndefined();
    expect(schoolAgentPolicy.planGate).toBeUndefined();
  });
});

describe("schoolAgentPolicy.sanitize", () => {
  it.each(["lesson_gap", "lesson_choice", "lesson_cloze", "lesson_order"] as const)("usuwa podpowiedź przy %s", (exerciseType) => {
    const result = sanitize(draft({ exerciseType, hint: "Pomyśl o rzekach." }));
    expect(result.removed).toEqual(["hint"]);
    expect(result.draft).not.toHaveProperty("hint");
    expect(result.draft.exerciseType).toBe(exerciseType);
  });

  it("zostawia podpowiedź przy pytaniu otwartym", () => {
    const result = sanitize(draft({ hint: "Pomyśl o rzekach." }));
    expect(result.removed).toEqual([]);
    expect(result.draft.hint).toBe("Pomyśl o rzekach.");
  });

  it("niezmienione ćwiczenie zwraca puste removed", () => {
    const original = draft({ exerciseType: "lesson_gap" });
    const result = sanitize(original);
    expect(result.removed).toEqual([]);
    expect(result.draft).toBe(original);
  });
});

describe("schoolAgentPolicy.exerciseGate", () => {
  it("zgłasza podpowiedź ujawniającą odpowiedź", () => {
    expect(gate(draft({ hint: "Przykładem jest Mierzeja Wiślana" }))).toEqual([
      {
        code: "hint_reveals_answer",
        reason: "the hint gives away the answer or a required element; hint at the reasoning, not the content",
      },
    ]);
  });

  it("przepuszcza podpowiedź kierującą rozumowaniem i brak podpowiedzi", () => {
    expect(gate(draft({ hint: "Pomyśl o piaszczystym pasie lądu." }))).toEqual([]);
    expect(gate(draft({}))).toEqual([]);
  });

  it("nie sprawdza podpowiedzi przy innych typach (sanitize je usuwa)", () => {
    expect(gate(draft({ exerciseType: "lesson_gap", hint: "Mierzeja Wiślana" }))).toEqual([]);
  });
});
