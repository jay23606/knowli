import { describe, expect, it } from "vitest";
import { grammarAgentPolicy } from "./agent-policy";
import { englishGrammarSubject } from "./module";

describe("grammarAgentPolicy", () => {
  it("jest polityką przedmiotu gramatyki", () => {
    expect(englishGrammarSubject.agentPolicy).toBe(grammarAgentPolicy);
  });

  it("ma zapas samodzielnych 1 i luz 2, bez materiału dla checkera", () => {
    expect(grammarAgentPolicy.independentReserve).toBe(1);
    expect(grammarAgentPolicy.slack).toBe(2);
    expect(grammarAgentPolicy.checkerNeedsMaterial).toBe(false);
  });

  it("nie ma sędziego podpowiedzi ani kontroli otwartej (zachowanie jak w 2a)", () => {
    expect(grammarAgentPolicy.hintJudgeTypes).toBeUndefined();
    expect(grammarAgentPolicy.openAnswerCheckTypes).toBeUndefined();
    for (const key of ["check.hint_judge", "check.open_answer"]) {
      expect(grammarAgentPolicy.ruleNotes?.[key]).toBeUndefined();
    }
  });

  it("typy ślepe to zbiór PoC (gałąź nie-szkolna) przecięty z typami gramatyki", () => {
    expect(grammarAgentPolicy.blindSolveTypes).toEqual([
      "lesson_choice",
      "lesson_gap",
      "lesson_open_answer",
      "lesson_order",
      "lesson_error_fix",
      "lesson_transform",
    ]);
  });

  it("warianty sprawdza się dla zbioru PoC przeciętego z typami gramatyki", () => {
    expect(grammarAgentPolicy.variantCheckTypes).toEqual(["lesson_open_answer", "lesson_transform", "lesson_error_fix", "lesson_gap"]);
  });

  it("typy należą do przedmiotu, bez keywords, listen_choice i match", () => {
    const subjectTypes = new Set<string>(englishGrammarSubject.exerciseTypes);
    for (const type of [...grammarAgentPolicy.blindSolveTypes, ...grammarAgentPolicy.variantCheckTypes]) {
      expect(subjectTypes.has(type)).toBe(true);
    }
    for (const type of ["lesson_keywords", "lesson_listen_choice", "lesson_match"] as const) {
      expect(grammarAgentPolicy.blindSolveTypes).not.toContain(type);
    }
  });

  it("nie ma sanitize, bramek, braków ani planu", () => {
    expect(grammarAgentPolicy.sanitize).toBeUndefined();
    expect(grammarAgentPolicy.exerciseGate).toBeUndefined();
    expect(grammarAgentPolicy.requiredTypes).toBeUndefined();
    expect(grammarAgentPolicy.objectiveGaps).toBeUndefined();
    expect(grammarAgentPolicy.planCoverage).toBeUndefined();
    expect(grammarAgentPolicy.planGate).toBeUndefined();
  });

  it("przykłady typów: w tematach „to be” i Present Continuous każdy cel ma przykład każdego swojego typu, poza nimi przykłady kart", () => {
    for (const topic of englishGrammarSubject.topics) {
      for (const objective of topic.objectives) {
        const examples = grammarAgentPolicy.typeExamples?.({ topicId: topic.id, objectiveId: objective.id });
        if (topic.id !== "to_be" && topic.id !== "present_continuous") {
          expect(examples, objective.id).toBeUndefined();
          continue;
        }
        expect(Object.keys(examples ?? {}).sort(), objective.id)
          .toEqual(objective.exerciseTypes.filter((type) => type !== "lesson_card").sort());
        for (const [type, example] of Object.entries(examples ?? {})) expect(example?.exerciseType, objective.id).toBe(type);
      }
    }
    expect(grammarAgentPolicy.typeExamples?.({ topicId: "to_be", objectiveId: "english_grammar.to_be.unknown" })).toBeUndefined();
    // Cele o tej samej nazwie w dwóch tematach (questions) mają przykłady swojego tematu.
    expect(grammarAgentPolicy.typeExamples?.({ topicId: "present_continuous", objectiveId: "english_grammar.present_continuous.questions" })?.lesson_choice)
      .not.toEqual(grammarAgentPolicy.typeExamples?.({ topicId: "to_be", objectiveId: "english_grammar.to_be.questions" })?.lesson_choice);
  });

  it("dopiski ujawnień podpowiadają zmianę podmiotu, czasownika lub dopełnienia", () => {
    expect(grammarAgentPolicy.ruleNotes?.["lesson.leak"]).toContain("use a different subject, verb or object");
    expect(grammarAgentPolicy.ruleNotes?.["lesson.leak_source"]).toBe("Use a different sentence.");
  });

  it("dopisek check.blind_solve: polskie zdanie źródłowe wskazuje jedno sformułowanie, szyki w acceptedAnswers", () => {
    expect(grammarAgentPolicy.ruleNotes?.["check.blind_solve"]).toContain("(pronoun, tense, word order)");
    expect(grammarAgentPolicy.ruleNotes?.["check.blind_solve"]).toContain("acceptedAnswers");
  });
});
