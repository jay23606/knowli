import { describe, expect, it } from "vitest";
import { englishGrammarSubject } from "./module";
import { englishGrammarPrompts } from "./prompts";
import { validateEnglishGrammarExercise } from "./validators";
import { presentSimpleV1 } from "./topics/present-simple";
import { toBeV1 } from "./topics/to-be";
import { answersEquivalent, validateLessonExercise } from "../../pool-validation";
import { createProductionSubjectRegistry, PRODUCTION_SUBJECTS } from "../index";
import { validateSubject } from "../../catalog-validation";
import type { LessonExerciseDraft } from "../../types";

describe("englishGrammarSubject — spójność katalogu", () => {
  it("validateSubject zwraca pustą listę (katalog poprawny)", () => {
    expect(validateSubject(englishGrammarSubject)).toEqual([]);
  });

  it("metadane przedmiotu zgodne z briefem", () => {
    expect(englishGrammarSubject.id).toBe("english_grammar");
    expect(englishGrammarSubject.titlePl).toBe("Angielski — gramatyka");
    expect(englishGrammarSubject.answerLocale).toBe("en-GB");
    expect(englishGrammarSubject.promptLocale).toBe("pl-PL");
    expect(englishGrammarSubject.ttsForAnswers).toBe(false);
    expect(englishGrammarSubject.ttsForFeedbackSentence).toBe(true);
  });

  it("obsługuje wszystkie 10 typów ćwiczeń", () => {
    expect([...englishGrammarSubject.exerciseTypes].sort()).toEqual(
      [
        "lesson_card",
        "lesson_choice",
        "lesson_error_fix",
        "lesson_gap",
        "lesson_listen_choice",
        "lesson_notice",
        "lesson_open_answer",
        "lesson_order",
        "lesson_short_answer",
        "lesson_transform",
      ].sort(),
    );
  });

  it("fieldRules profilu promptów definiują semantykę hint dla lesson_gap (walidator traktuje hint jako bezokolicznik)", () => {
    // Incydent 2026-10-13 (deepseek): polskie słowa z materiału w hint →
    // odrzucenie przez validateEnglishGrammarExercise. Reguła musi precyzować:
    // angielska forma podstawowa, kontrprzykłady, widoczność dla dziecka.
    const rules = englishGrammarPrompts.fieldRules ?? "";
    expect(rules).not.toBe("");
    expect(rules).toMatch(/base form|infinitive/i);
    expect(rules).toContain("plays");
    expect(rules).toMatch(/never put polish/i);
    expect(rules).toMatch(/hint/i);
  });

  it("fieldRules definiują reguły tematu to_be dla generacji puli", () => {
    const rules = englishGrammarPrompts.fieldRules ?? "";
    expect(rules).toContain(".to_be.");
    expect(rules).toMatch(/am, is or are matching the subject/);
    expect(rules).toMatch(/never use do or does/);
    expect(rules).toMatch(/only the form itself/);
  });

  it("tylko gramatyka przyjmuje tematy zdań: reguła ma kluczowe zakazy, inne przedmioty jej nie mają (#197)", () => {
    const rule = englishGrammarSubject.prompts.interestsRule ?? "";
    for (const fragment of ["lesson_open_answer", "visualSubject", "at most half", "data only", "real people", "never the subject of a sentence"]) {
      expect(rule).toContain(fragment);
    }
    expect(PRODUCTION_SUBJECTS.find((s) => s.id === "school")?.prompts.interestsRule).toBeUndefined();
    expect(PRODUCTION_SUBJECTS.find((s) => s.id === "english_chapter")?.prompts.interestsRule).toBeUndefined();
    expect(PRODUCTION_SUBJECTS.filter((s) => s.prompts.interestsRule !== undefined).map((s) => s.id)).toEqual(["english_grammar"]);
  });

  it("przykłady fieldRules są legalne wobec walidatora i normalizatora przedmiotu (kontrakt prompt↔walidacja)", () => {
    // Review C2: odpowiedzi wielosłowowe z podmiotem („does she play”) NIE
    // przechodzą walidatora przy ustawionym hint — fieldRules nie może ich
    // obiecywać jako dopuszczalnej odpowiedzi luki.
    expect(englishGrammarPrompts.fieldRules).not.toContain("does she play");

    // Formy wymieniane w fieldRules (forma 3. osoby, operator + not + bezokolicznik)
    // przechodzą walidację przy hint = bezokolicznik.
    const gap = (hint: string, answer: string): LessonExerciseDraft => ({
      exerciseType: "lesson_gap",
      objectiveId: "english_grammar.present_simple.third_person_s",
      stem: "He ___ every day.",
      hint,
      answer,
      acceptedAnswers: [],
      focus: answer.split(" "),
    });
    expect(validateEnglishGrammarExercise(gap("play", "plays"), presentSimpleV1)).toEqual([]);
    expect(validateEnglishGrammarExercise(gap("play", "doesn't play"), presentSimpleV1)).toEqual([]);
    expect(validateEnglishGrammarExercise(gap("play", "does she play"), presentSimpleV1).length).toBeGreaterThan(0);

    // Review C1: rozwinięcie skrótu jest równoważne kanonicznej po normalizatorze
    // (zakazany wariant acceptedAnswers); krótsza forma bez podmiotu jest legalna.
    const normalizer = englishGrammarSubject.normalizer;
    expect(answersEquivalent("doesn't play", "does not play", normalizer)).toBe(true);
    expect(answersEquivalent("she doesn't play", "doesn't play", normalizer)).toBe(false);
  });
});

describe("createProductionSubjectRegistry", () => {
  it("PRODUCTION_SUBJECTS zawiera english_grammar", () => {
    expect(PRODUCTION_SUBJECTS).toContain(englishGrammarSubject);
  });

  it("rejestr udostępnia temat to_be@1", () => {
    const registry = createProductionSubjectRegistry();
    const topic = registry.getTopic("english_grammar", "to_be", 1);
    expect(topic?.id).toBe("to_be");
    expect(topic?.version).toBe(1);
    expect(topic?.titlePl).toBe("Czasownik „to be”");
  });

  it("rejestr udostępnia przedmiot i temat present_simple@1", () => {
    const registry = createProductionSubjectRegistry();
    expect(registry.getSubject("english_grammar")).toBe(englishGrammarSubject);
    const topic = registry.getTopic("english_grammar", "present_simple", 1);
    expect(topic?.id).toBe("present_simple");
    expect(topic?.version).toBe(1);
    expect(topic?.titlePl).toBe("Present Simple");
  });
});

const TOPIC_CASES = [
  {
    id: "to_be",
    objectiveIds: [
      "english_grammar.to_be.affirmative_forms",
      "english_grammar.to_be.contractions",
      "english_grammar.to_be.negative_forms",
      "english_grammar.to_be.questions",
      "english_grammar.to_be.short_answers",
    ],
  },
  {
    id: "present_simple",
    objectiveIds: [
      "english_grammar.present_simple.affirmative_base",
      "english_grammar.present_simple.third_person_s",
      "english_grammar.present_simple.spelling_es_ies",
      "english_grammar.present_simple.negative",
      "english_grammar.present_simple.question",
      "english_grammar.present_simple.short_answers",
      "english_grammar.present_simple.base_form_after_does",
    ],
  },
] as const;

for (const topicCase of TOPIC_CASES) {
  describe(`temat ${topicCase.id} — spójność katalogu`, () => {
    const topic = englishGrammarSubject.topics.find((t) => t.id === topicCase.id)!;

    it("ma cele w oczekiwanej kolejności nauki", () => {
      expect(topic.objectives.map((o) => o.id)).toEqual(topicCase.objectiveIds);
    });

    it("każdy cel ma kategorie błędów z szablonami podpowiedzi", () => {
      for (const objective of topic.objectives) {
        expect(objective.errorCategories.length).toBeGreaterThanOrEqual(2);
        for (const code of objective.errorCategories) {
          expect(objective.hints[code]).toBeTruthy();
        }
      }
    });

    it("każdy cel ma co najmniej jedną kartę z miejscem {{examples}}", () => {
      for (const objective of topic.objectives) {
        const hasExamples = objective.cards.some(
          (card) => card.title.includes("{{examples}}") || card.body.includes("{{examples}}"),
        );
        expect(hasExamples, `cel ${objective.id} bez {{examples}}`).toBe(true);
      }
    });

    it("ma trzy przekształcenia tematu", () => {
      expect(topic.transforms.map((t) => t.id).sort()).toEqual(
        ["to_affirmative", "to_negative", "to_question"].sort(),
      );
    });
  });
}

describe("englishGrammarSubject — wybór ze słuchu (#198)", () => {
  const typesOf = (topic: { objectives: readonly { id: string; exerciseTypes: readonly string[] }[] }, suffix: string) =>
    topic.objectives.find((objective) => objective.id.endsWith(suffix))?.exerciseTypes ?? [];

  it("cele ze słyszalną różnicą formy dostają lesson_listen_choice", () => {
    for (const suffix of [".affirmative_base", ".third_person_s", ".negative", ".question"]) {
      expect(typesOf(presentSimpleV1, suffix), suffix).toContain("lesson_listen_choice");
    }
    for (const suffix of [".affirmative_forms", ".negative_forms", ".questions"]) {
      expect(typesOf(toBeV1, suffix), suffix).toContain("lesson_listen_choice");
    }
  });

  it("cele pisowni, krótkich odpowiedzi i formy po does nie dostają typu", () => {
    for (const suffix of [".spelling_es_ies", ".short_answers", ".base_form_after_does"]) {
      expect(typesOf(presentSimpleV1, suffix), suffix).not.toContain("lesson_listen_choice");
    }
    for (const suffix of [".contractions", ".short_answers"]) {
      expect(typesOf(toBeV1, suffix), suffix).not.toContain("lesson_listen_choice");
    }
  });

  it("poprawne ćwiczenie ze słuchu dla to_be.questions przechodzi walidację (Is/Are otwierające pytanie)", () => {
    const draft: LessonExerciseDraft = {
      exerciseType: "lesson_listen_choice",
      objectiveId: "english_grammar.to_be.questions",
      stem: "___ she happy?",
      options: [{ id: "a", text: "Is" }, { id: "b", text: "Are" }],
      correctOption: "a",
      answer: "Is",
      acceptedAnswers: [],
      focus: ["Is"],
    };
    expect(validateLessonExercise(draft, englishGrammarSubject, toBeV1)).toEqual([]);
  });

  it("wersje tematów bez zmian", () => {
    expect(presentSimpleV1.version).toBe(1);
    expect(toBeV1.version).toBe(1);
  });

  it("fieldRules opisują regułę typu: jedna luka, słyszalna różnica, bez równoważnych opcji i bez instructionPl", () => {
    const rules = englishGrammarPrompts.fieldRules ?? "";
    expect(rules).toContain("lesson_listen_choice");
    expect(rules).toMatch(/at most 12 words/);
    expect(rules).toMatch(/exactly one gap/);
    expect(rules).toMatch(/audibly/i);
    expect(rules).toMatch(/never offer an equivalent/i);
    expect(rules).toMatch(/apostrophe/);
    expect(rules).toMatch(/instructionPl.*hint.*visualSubject/s);
  });
});
