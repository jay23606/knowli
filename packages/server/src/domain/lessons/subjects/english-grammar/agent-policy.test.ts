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
    for (const key of ["hintUnsupported", "hintLanguage", "hintReveals", "openMissing", "openWrong"] as const) {
      expect(grammarAgentPolicy.rejectionTexts[key]).toBeUndefined();
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

  it("leakVictim podpowiada zmianę podmiotu, czasownika lub dopełnienia", () => {
    expect(grammarAgentPolicy.rejectionTexts.leakVictim).toContain("use a different subject, verb or object");
    expect(grammarAgentPolicy.rejectionTexts.leakSource).toBe("Use a different sentence.");
  });
});
