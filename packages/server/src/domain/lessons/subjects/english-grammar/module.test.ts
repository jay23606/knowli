import { describe, expect, it } from "vitest";
import { ruleOf, type RuleBookContext, type RuleId } from "../../rules/catalog";
import { listenChoiceSibilantErrors } from "../english/listen-audibility";
import { englishGrammarSubject } from "./module";
import { englishGrammarPrompts } from "./prompts";
import {
  PC_COLLOCATIONS,
  PC_EXPLANATION_EXAMPLE,
  PC_FORBIDDEN_MARKERS,
  PC_GUIDANCE,
  PC_NOW_MARKERS,
  PC_EXPLANATION_SCENE_EXAMPLE,
  PC_FORMS_TRANSLATION_GUIDANCE,
  PC_NOW_OR_USUALLY_GUIDANCE,
  PC_NOW_OR_USUALLY_MORE_GUIDANCE,
  PC_STATE_VERB_LIST,
  PC_TENSE_CHOICE_GUIDANCE,
  PC_USUALLY_MARKERS,
  PC_VERB_LISTS,
} from "./present-continuous-guidance";
import { TENSE_CHOICE_OBJECTIVES } from "./present-continuous-tense-choice";
import { PC_FORM_OBJECTIVES } from "./present-continuous-validation";
import { lessonRuleBook, ruleBookContextFor } from "../../rules/rule-book";
import { explanationIssues, explanationTextErrors } from "../../exercise-explanation";
import { validateEnglishGrammarExercise } from "./validators";
import { presentSimpleV1 } from "./topics/present-simple";
import { toBeV1 } from "./topics/to-be";
import { presentContinuousV1, STORY_MIX_SENTENCE } from "./topics/present-continuous";
import { answersEquivalent, validateLessonExercise } from "../../pool-validation";
import { createProductionSubjectRegistry, PRODUCTION_SUBJECTS } from "../index";
import { validateSubject } from "../../catalog-validation";
import type { LessonExerciseDraft } from "../../types";
import { stateVerbIn } from "../english/ing-forms";


/** Opis reguły katalogu (rdzeń, lekcja albo przedmiot) — tekst, który dostaje model w księdze reguł. */
function ruleText(id: string): string {
  const rule = ruleOf(englishGrammarSubject, id as RuleId);
  if (rule === undefined) throw new Error(`brak reguły ${id}`);
  return typeof rule.description === "string" ? rule.description : rule.description({ answerMaxLength: 120, groundingRequired: false });
}

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
    expect(englishGrammarSubject.exerciseExplanations).toBe(true);
  });

  it("english grammar enables end-of-session story with rules", () => {
    expect(englishGrammarSubject.lessonStory).toBe(true);
    expect(englishGrammarSubject.prompts.storyRules?.trim()).toBeTruthy();
    // Tylko formy celów z żądania, nie wszystkich reguł tematu.
    expect(englishGrammarSubject.prompts.storyRules).toContain("Use only the grammar forms of the objectives listed above");
    expect(englishGrammarSubject.prompts.storyRules).not.toContain("several rules of the topic");
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

  it("fieldRules — migawka", () => {
    // Zdanie na wiersz: diff migawki pokazuje dokładnie zmienione zdania promptu.
    expect((englishGrammarPrompts.fieldRules ?? "").split(/(?<=\.) (?=[A-Z])/)).toMatchInlineSnapshot(`
      [
        "For lesson_open_answer, prompt is the source sentence in the prompt language to translate; answer and acceptedAnswers are in the answer language.",
        "For objectives whose id contains '.present_simple.', set the lesson_gap hint to the English BASE FORM (infinitive) of the verb that fills the gap (hint "play" for answer "plays", hint "study" for answer "studies"), or leave hint null; keep the gap answer short, at most the verb with an auxiliary (never a full sentence with a subject).",
        "In those objectives an operator-only answer (do, does, don't, doesn't, do not, does not) may be used when the remaining sentence supplies the base verb; hint may then be the auxiliary base form do.",
        "In those objectives a translation looks like prompt 'Ona codziennie gra w piłkę.' → answer 'She plays football every day.' Never put Polish words, translations, pronouns or rule explanations in hint — the child sees hint as support.",
        "For objectives whose id contains ".to_be." the checked verb is 'to be': gap answers are am, is or are, in negatives am not, is not, are not, isn't or aren't.",
      ]
    `);
  });

  it("fieldRules opisują temat to_be, a jego sprawdzane formy opisują reguły katalogu tylko w tym temacie", () => {
    const rules = englishGrammarPrompts.fieldRules ?? "";
    expect(rules).toContain(".to_be.");
    expect(rules).toMatch(/gap answers are am, is or are/);
    // Wskazówki tematu i wyboru obrazka w opisach reguł tego tematu (prompt tylko w temacie „to be”).
    expect(rules).not.toMatch(/short answers repeat the form|Picture choice/);
    expect(ruleText("grammar.be_form_subject")).toMatch(/short answers repeat the form/);
    expect(ruleText("grammar.visual_answer_pronoun")).toContain("Picture choice (only in objectives whose id contains '.affirmative_forms')");
    for (const id of ["grammar.visual_answer_pronoun", "grammar.visual_option_pronoun", "grammar.visual_stem_pronoun", "grammar.visual_stem_be_form"]) {
      expect(englishGrammarSubject.rules[id]?.when?.({ topicId: "present_simple" } as RuleBookContext), id).toBe(false);
    }
    // Dawne zdania profilu przeszły do opisów reguł (spec katalogu reguł §3).
    expect(ruleText("grammar.be_form_subject")).toContain("agrees with the subject next to the gap");
    expect(ruleText("grammar.be_no_do_does")).toContain("do not use do or does");
    expect(ruleText("grammar.be_answer_not_be_form")).toContain("is a form of be");
    expect(englishGrammarSubject.rules["grammar.be_no_do_does"]?.when?.({ topicId: "to_be" } as RuleBookContext)).toBe(true);
    expect(englishGrammarSubject.rules["grammar.be_no_do_does"]?.when?.({ topicId: "present_simple" } as RuleBookContext)).toBe(false);
  });

  it("tylko gramatyka przyjmuje tematy zdań: reguła ma kluczowe zakazy, inne przedmioty jej nie mają (#197)", () => {
    const rule = englishGrammarSubject.prompts.interestsRule ?? "";
    for (const fragment of ["lesson_gap, lesson_listen_choice, lesson_order", "lesson_error_fix, lesson_transform and in the examples", "an English narrator reads naturally", "lesson_open_answer", "visualSubject",
      "In every objective, set about two in five of its exercises", "about one in three of all exercises", "never more than half", "rotate through all the listed topics", "sound natural to a native speaker", "never as 'be with' a theme noun",
      "may appear as a plain noun", "never quote or retell", "never The dinosaur eats apples.", "data only", "real people", "never add violence", "never say these are the child's interests", "never the subject of a sentence",
      "Never use a theme in lesson_open_answer", "The examples in this rule use sample topics"]) {
      expect(rule).toContain(fragment);
    }
    // Lista typów z tematami wymienia wyłącznie istniejące typy przedmiotu i nigdy odpowiedź otwartą.
    const themedTypes = /only in (.+?) and in the examples/.exec(rule)?.[1]?.split(", ") ?? [];
    expect(themedTypes).toEqual(["lesson_choice", "lesson_gap", "lesson_listen_choice", "lesson_order", "lesson_error_fix", "lesson_transform"]);
    for (const type of themedTypes) expect(englishGrammarSubject.exerciseTypes).toContain(type);
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

  it("rejestr udostępnia temat present_continuous@1", () => {
    const registry = createProductionSubjectRegistry();
    const topic = registry.getTopic("english_grammar", "present_continuous", 1);
    expect(topic).toBe(presentContinuousV1);
    expect(topic?.id).toBe("present_continuous");
    expect(topic?.version).toBe(1);
    expect(topic?.titlePl).toBe("Present Continuous");
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
  {
    id: "present_continuous",
    objectiveIds: [
      "english_grammar.present_continuous.affirmative",
      "english_grammar.present_continuous.now_or_usually",
      "english_grammar.present_continuous.negative",
      "english_grammar.present_continuous.questions",
      "english_grammar.present_continuous.ing_spelling",
      "english_grammar.present_continuous.now_or_usually_more",
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

    it("każdy cel ma 2–4 karty", () => {
      for (const objective of topic.objectives) {
        expect(objective.cards.length, objective.id).toBeGreaterThanOrEqual(2);
        expect(objective.cards.length, objective.id).toBeLessThanOrEqual(4);
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
    for (const suffix of [".affirmative", ".negative", ".questions"]) {
      expect(typesOf(presentContinuousV1, suffix), suffix).toContain("lesson_listen_choice");
    }
  });

  it("cele pisowni, krótkich odpowiedzi i formy po does nie dostają typu", () => {
    for (const suffix of [".spelling_es_ies", ".short_answers", ".base_form_after_does"]) {
      expect(typesOf(presentSimpleV1, suffix), suffix).not.toContain("lesson_listen_choice");
    }
    for (const suffix of [".contractions", ".short_answers"]) {
      expect(typesOf(toBeV1, suffix), suffix).not.toContain("lesson_listen_choice");
    }
    // Cele porównania: lektor czytałby wskaźnik czasu, więc słuch nie sprawdzałby wyboru czasu; w celu pisowni -ing słuch nie sprawdza pisowni.
    for (const suffix of [".now_or_usually", ".ing_spelling", ".now_or_usually_more"]) {
      expect(typesOf(presentContinuousV1, suffix), suffix).not.toContain("lesson_listen_choice");
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
    expect(presentContinuousV1.version).toBe(1);
    expect(Object.fromEntries(englishGrammarSubject.topics.map((topic) => [topic.id, topic.version]))).toEqual({
      present_simple: 1,
      to_be: 1,
      present_continuous: 1,
    });
  });

  it("blok typu opisuje sens wyboru ze słuchu (słyszalna różnica, jedna poprawna), a ograniczenia typu niesie katalog reguł", () => {
    const rules = englishGrammarPrompts.typeRules?.lesson_listen_choice ?? "";
    expect(englishGrammarPrompts.fieldRules ?? "").not.toContain("lesson_listen_choice");
    expect(rules).toMatch(/at most 12 words/);
    expect(rules).toMatch(/audibly/i);
    expect(rules).toContain("exactly one is correct");
    expect(ruleText("listen.gap_count")).toContain("exactly one gap");
    expect(ruleText("listen.options_equivalent")).toContain("not equivalent");
    expect(ruleText("listen.option_apostrophe")).toContain("apostrophe");
    expect(ruleText("listen.instruction_not_allowed")).toContain("instructionPl");
    expect(ruleText("listen.hint_not_allowed")).toContain("no hint");
  });

  it("sybilant zaraz za luką przy opcjach różnych o -s opisuje reguła wspólnego fragmentu angielskiego", () => {
    const rule = ruleText("english.listen_sibilant_merge");
    expect(rule).toMatch(/-s ending that adds no syllable.*right after the gap.*s, z or sh sound/s);
    // Opis nie jest ostrzejszy niż sprawdzenie: wyjątki, które przyjmuje walidator, są w opisie.
    expect(rule).toContain("watch/watches");
    expect(rule).toContain("do/does");
    for (const [stem, options] of [["___ she play tennis?", ["Does", "Do"]], ["He ___ soccer.", ["watches", "watch"]]] as const) {
      const draft: LessonExerciseDraft = {
        exerciseType: "lesson_listen_choice",
        objectiveId: "english_grammar.present_simple.question",
        stem,
        options: options.map((text, index) => ({ id: String(index), text })),
        correctOption: "0",
        answer: options[0],
        acceptedAnswers: [],
        focus: [options[0]],
      };
      expect(listenChoiceSibilantErrors(draft), stem).toEqual([]);
    }
    expect(englishGrammarPrompts.fieldRules).not.toContain("snakes");
  });
});

describe("temat present_continuous — cele, kategorie i opisy (spec §3, §7.3, §9)", () => {
  const PC = "english_grammar.present_continuous";
  const objective = (suffix: string) => presentContinuousV1.objectives.find((o) => o.id === `${PC}.${suffix}`)!;
  const COMPARISON = ["now_or_usually", "now_or_usually_more"] as const;

  it("typy ćwiczeń celów zgodne z tabelą §3.1", () => {
    const types = Object.fromEntries(
      presentContinuousV1.objectives.map((o) => [o.id.slice(PC.length + 1), [...o.exerciseTypes].sort()]),
    );
    const lesson = (...names: string[]) => names.map((name) => `lesson_${name}`).sort();
    expect(types).toEqual({
      affirmative: lesson("card", "notice", "choice", "listen_choice", "order", "gap", "error_fix", "open_answer"),
      now_or_usually: lesson("card", "choice", "gap", "error_fix", "open_answer"),
      negative: lesson("card", "choice", "listen_choice", "gap", "error_fix", "transform", "open_answer"),
      questions: lesson("card", "choice", "listen_choice", "order", "short_answer", "gap", "transform", "open_answer"),
      ing_spelling: lesson("card", "choice", "gap", "error_fix", "open_answer"),
      now_or_usually_more: lesson("card", "choice", "gap", "error_fix", "open_answer"),
    });
  });

  it("kategorie błędów tematu i ich przypisanie do celów zgodne z §3.3", () => {
    expect(presentContinuousV1.extraErrorCategories.map((c) => c.code)).toEqual([
      "wrong_be_form",
      "missing_be_form",
      "missing_ing",
      "ing_spelling",
      "be_plus_simple",
      "continuous_for_habit",
      "simple_for_now",
    ]);
    const categories = Object.fromEntries(
      presentContinuousV1.objectives.map((o) => [o.id.slice(PC.length + 1), [...o.errorCategories]]),
    );
    expect(categories).toEqual({
      affirmative: ["missing_be_form", "wrong_be_form", "missing_ing"],
      now_or_usually: ["continuous_for_habit", "simple_for_now", "be_plus_simple"],
      negative: ["wrong_negation", "missing_be_form", "wrong_be_form", "missing_ing", "extra_auxiliary"],
      questions: ["word_order", "missing_be_form", "wrong_be_form", "extra_auxiliary", "short_answer_form", "missing_ing"],
      ing_spelling: ["ing_spelling", "missing_ing"],
      now_or_usually_more: ["continuous_for_habit", "simple_for_now", "be_plus_simple"],
    });
  });

  it("przekształcenia mają te same polecenia co Present Simple", () => {
    expect(presentContinuousV1.transforms).toEqual(presentSimpleV1.transforms);
  });

  it("cele porównania nie mają kategorii formy, a opis definiuje werdykt wyboru czasu (§7.3)", () => {
    for (const suffix of COMPARISON) {
      const o = objective(suffix);
      for (const formCategory of ["missing_ending", "wrong_auxiliary", "extra_ending"]) {
        expect(o.errorCategories, `${suffix}: ${formCategory}`).not.toContain(formCategory);
      }
      expect(o.descriptionEn).toContain("The checked element is the choice of tense");
      expect(o.descriptionEn).toContain("'almost' with errorCategory: null");
      for (const code of ["continuous_for_habit", "simple_for_now", "be_plus_simple"]) {
        expect(o.descriptionEn, `${suffix}: ${code}`).toContain(code);
      }
    }
  });

  it("podpowiedzi celów porównania powtarzają refren „teraz czy zwykle?” (§3.3)", () => {
    for (const suffix of COMPARISON) {
      for (const hint of Object.values(objective(suffix).hints)) {
        expect(hint, suffix).toContain("Zapytaj siebie: teraz czy zwykle?");
      }
    }
  });

  it("zdanie o mieszaniu czasów w historyjce jest w opisie dokładnie celów porównania (§9)", () => {
    expect(STORY_MIX_SENTENCE).toBe("The end-of-lesson story may mix present simple and present continuous.");
    const withStoryMix = englishGrammarSubject.topics
      .flatMap((topic) => topic.objectives)
      .filter((o) => o.descriptionEn.includes(STORY_MIX_SENTENCE))
      .map((o) => o.id);
    expect(withStoryMix).toEqual([`${PC}.now_or_usually`, `${PC}.now_or_usually_more`]);
  });

  it("karty uczą trudnej pisowni -ing i pary jedzie/jeździ (§3.2)", () => {
    const text = (suffix: string) => objective(suffix).cards.map((card) => `${card.title} ${card.body}`).join(" ");
    for (const fragment of ["write → writing (jedno t!)", "tie → tying", "jump → jumping", "fix → fixing", "run → running"]) {
      expect(text("ing_spelling")).toContain(fragment);
    }
    expect(text("now_or_usually")).toContain("jedzie");
    expect(text("now_or_usually")).toContain("jeździ");
  });
});

describe("fieldRules — zawężenie Present Simple, bez tematu present_continuous (spec §7)", () => {
  const rules = englishGrammarPrompts.fieldRules ?? "";
  const PS_HEADER = "For objectives whose id contains '.present_simple.'";

  it("reguły luki Present Simple, hint jako bezokolicznik i operator dotyczą tylko celów '.present_simple.' (§7.1)", () => {
    // Jedno zdanie od nagłówka do formy odpowiedzi: model nie czyta reguły jako ogólnej dla przedmiotu.
    expect(rules).toMatch(/For objectives whose id contains '\.present_simple\.'[^.]*BASE FORM[^.]*or leave hint null; keep the gap answer short/);
    const header = rules.indexOf(PS_HEADER);
    const toBe = rules.indexOf('For objectives whose id contains ".to_be."');
    expect(header).toBeGreaterThanOrEqual(0);
    for (const fragment of ["BASE FORM (infinitive)", "keep the gap answer short", "In those objectives an operator-only answer"]) {
      expect(rules.indexOf(fragment), fragment).toBeGreaterThan(header);
      expect(rules.indexOf(fragment), fragment).toBeLessThan(toBe);
    }
    expect(rules.slice(0, header)).not.toMatch(/lesson_gap set hint|operator/);
  });

  it("przykład tłumaczenia w Present Simple stoi w bloku celów '.present_simple.' (w PC to zdanie byłoby odrzucone)", () => {
    const example = rules.indexOf("Ona codziennie gra w piłkę.");
    expect(example).toBeGreaterThan(rules.indexOf(PS_HEADER));
    expect(example).toBeLessThan(rules.indexOf('For objectives whose id contains ".to_be."'));
  });

  it("fieldRules nie mają reguł tematu present_continuous — opisuje go katalog reguł (Task 18)", () => {
    expect(rules).not.toContain("present_continuous");
    expect(rules).not.toMatch(/Look!|tomorrow|Kiedy to się dzieje/);
  });
});

/** Teksty księgi reguł zagadnienia: opisy reguł wszystkich sekcji i bloków typów. */
function ruleBookLines(topicId: string, objectiveId: string): { id: string; text: string }[] {
  const topic = englishGrammarSubject.topics.find((candidate) => candidate.id === topicId)!;
  const types = topic.objectives.find((candidate) => candidate.id === objectiveId)!.exerciseTypes;
  const book = lessonRuleBook(englishGrammarSubject, ruleBookContextFor(englishGrammarSubject, topicId, objectiveId, types, types.includes("lesson_listen_choice")));
  return [book.general, ...book.types.map((block) => block.rules), book.lesson, book.checks].flat();
}

describe("księga reguł — temat present_continuous (spec katalogu reguł §3, Task 18, fala 2 Task 19)", () => {
  /** Listy i wskazówki całego tematu: w księdze każdego celu PC dokładnie raz. */
  const PC_TOPIC_TEXTS = [PC_GUIDANCE, PC_VERB_LISTS, PC_STATE_VERB_LIST, PC_NOW_MARKERS, PC_USUALLY_MARKERS, PC_FORBIDDEN_MARKERS].map((text) => text.trim());
  /** Wskazówki celów porównania i pojedynczych celów porównania — tylko w księgach swoich celów. */
  const PC_OBJECTIVE_TEXTS: [text: string, inObjective: (objective: string) => boolean][] = [
    [PC_FORMS_TRANSLATION_GUIDANCE.trim(), (objective) => PC_FORM_OBJECTIVES.has(objective)],
    [PC_TENSE_CHOICE_GUIDANCE.trim(), (objective) => TENSE_CHOICE_OBJECTIVES.has(objective)],
    [PC_NOW_OR_USUALLY_GUIDANCE.trim(), (objective) => objective === "now_or_usually"],
    [PC_NOW_OR_USUALLY_MORE_GUIDANCE.trim(), (objective) => objective === "now_or_usually_more"],
  ];
  const PC_TEXTS = [...PC_TOPIC_TEXTS, ...PC_OBJECTIVE_TEXTS.map(([text]) => text)];
  const occurrences = (text: string, fragment: string): number => text.split(fragment).length - 1;
  const pcTopic = englishGrammarSubject.topics.find((candidate) => candidate.id === "present_continuous")!;

  it("w każdym zagadnieniu PC księga ma reguły PC, listy i wskazówki tematu raz, wskazówki celów tylko w swoich celach; w PS i „to be” — żadnej", () => {
    for (const topic of englishGrammarSubject.topics) {
      for (const objective of topic.objectives) {
        const lines = ruleBookLines(topic.id, objective.id);
        const text = lines.map((line) => line.text).join(" ");
        const pcRules = lines.filter((line) => line.id.startsWith("grammar.pc_"));
        const last = objective.id.split(".").at(-1)!;
        if (topic.id === "present_continuous") {
          expect(pcRules.length, objective.id).toBeGreaterThan(0);
          for (const fragment of PC_TOPIC_TEXTS) expect(occurrences(text, fragment), `${objective.id}: ${fragment.slice(0, 40)}`).toBe(1);
          for (const [fragment, inObjective] of PC_OBJECTIVE_TEXTS) {
            expect(occurrences(text, fragment), `${objective.id}: ${fragment.slice(0, 40)}`).toBe(inObjective(last) ? 1 : 0);
          }
        } else {
          expect(pcRules, objective.id).toEqual([]);
          for (const fragment of PC_TEXTS) expect(text, `${objective.id}: ${fragment.slice(0, 40)}`).not.toContain(fragment);
          expect(text, objective.id).not.toContain("present_continuous");
        }
      }
    }
  });

  it("reguły jednego celu albo grupy celów trafiają tylko do księgi tych celów (zbiory celów walidatora)", () => {
    const pcForms = (objective: string): boolean => PC_FORM_OBJECTIVES.has(objective);
    const tenseChoice = (objective: string): boolean => TENSE_CHOICE_OBJECTIVES.has(objective);
    const scoped: [id: string, inObjective: (objective: string) => boolean][] = [
      ["grammar.pc_forbidden_marker", () => true],
      ["grammar.pc_now_marker_bare", () => true],
      ["grammar.pc_now_marker_missing", pcForms],
      ["grammar.pc_usually_marker", pcForms],
      ["grammar.pc_state_verb_ing", pcForms],
      ["grammar.pc_translation_now_marker", pcForms],
      ["grammar.pc_choice_distractor_correct", (objective) => pcForms(objective) && objective !== "ing_spelling"],
      ["grammar.pc_ing_spelling_distractor", (objective) => objective === "ing_spelling"],
      ["grammar.pc_collocation_in_ing_spelling", (objective) => objective === "ing_spelling"],
      ["grammar.pc_tense_marker_missing", tenseChoice],
      ["grammar.pc_tense_markers_mixed", tenseChoice],
      ["grammar.pc_tense_marker_mismatch", tenseChoice],
      ["grammar.pc_tense_choice_distractor", tenseChoice],
      ["grammar.pc_tense_choice_gap_question", tenseChoice],
      ["grammar.pc_state_verb_tense_choice", tenseChoice],
      ["grammar.pc_ing_without_be", tenseChoice],
      ["grammar.pc_tense_form_missing", tenseChoice],
      ["grammar.pc_now_usually_key", (objective) => objective === "now_or_usually"],
      ["grammar.pc_now_or_usually_question", (objective) => objective === "now_or_usually"],
      ["grammar.pc_now_or_usually_negative", (objective) => objective === "now_or_usually"],
      ["grammar.pc_tense_choice_question_type", (objective) => objective === "now_or_usually_more"],
    ];
    for (const objective of pcTopic.objectives) {
      const ids = ruleBookLines(pcTopic.id, objective.id).map((line) => line.id);
      const last = objective.id.split(".").at(-1)!;
      for (const [id, inObjective] of scoped) expect(ids.includes(id), `${last}: ${id}`).toBe(inObjective(last));
    }
  });

  it("„tense-choice objectives” mają definicję przy każdym użyciu w księdze celu PC", () => {
    for (const objective of pcTopic.objectives) {
      const text = ruleBookLines(pcTopic.id, objective.id).map((line) => line.text).join(" ");
      expect(occurrences(text, "tense-choice objectives"), objective.id)
        .toBe(occurrences(text, "tense-choice objectives (now_or_usually and now_or_usually_more)"));
    }
  });

  it("listy i wskazówki mają kluczowe fragmenty dawnego bloku `fieldRules` (spec §7.2)", () => {
    const text = PC_TEXTS.join(" ");
    for (const fragment of ["Look!", "every day", "tomorrow", "play", "swim", "Kiedy to się dzieje?", "travel",
      "never write the refrain teraz czy zwykle", "never use teraz, właśnie, zawsze or zwykle as words of the task itself",
      "Polish appears only in instructionPl, explanationPl and the lesson_open_answer prompt", "never Cicho, dziadek śpi.",
      // Ślepa ocena sondy (Task 18): wyjaśnienie z formą z innego zdania, kopia przykładu karty, tłumaczenie bez wariantu „at the moment”.
      "explanationPl is exactly one sentence", "it names only verb forms that stand in this exercise", "Never copy an example from the objective's cards",
      "lists the other now markers the sentence allows as acceptedAnswers", "never a bare teraz"]) {
      expect(text, fragment).toContain(fragment);
    }
    // Dydaktyka tematu w dopisku reguły całego tematu, dydaktyka celów porównania przy regułach tych celów;
    // listy przy regułach, które je sprawdzają (w celach porównania przy ich regułach).
    expect(ruleText("grammar.pc_forbidden_marker").endsWith(PC_FORBIDDEN_MARKERS + PC_GUIDANCE)).toBe(true);
    expect(ruleText("grammar.pc_tense_marker_missing").endsWith(PC_NOW_MARKERS + PC_USUALLY_MARKERS + PC_TENSE_CHOICE_GUIDANCE)).toBe(true);
    expect(ruleText("grammar.pc_translation_now_marker").endsWith(PC_FORMS_TRANSLATION_GUIDANCE)).toBe(true);
    expect(ruleText("grammar.pc_now_or_usually_question").endsWith(PC_NOW_OR_USUALLY_GUIDANCE)).toBe(true);
    expect(ruleText("grammar.pc_tense_choice_question_type").endsWith(PC_NOW_OR_USUALLY_MORE_GUIDANCE)).toBe(true);
    expect(ruleText("grammar.pc_ing_rule_not_allowed").endsWith(PC_VERB_LISTS)).toBe(true);
    expect(ruleText("grammar.pc_state_verb_ing").endsWith(PC_STATE_VERB_LIST)).toBe(true);
    expect(ruleText("grammar.pc_state_verb_tense_choice").endsWith(PC_STATE_VERB_LIST)).toBe(true);
    expect(ruleText("grammar.pc_now_marker_missing").endsWith(PC_NOW_MARKERS)).toBe(true);
    expect(ruleText("grammar.pc_usually_marker").endsWith(PC_USUALLY_MARKERS)).toBe(true);
  });

  const PC = "english_grammar.present_continuous";
  const draft = (objective: string, exerciseType: LessonExerciseDraft["exerciseType"], answer: string, extra: Partial<LessonExerciseDraft>): LessonExerciseDraft => ({
    exerciseType,
    objectiveId: `${PC}.${objective}`,
    answer,
    acceptedAnswers: [],
    // Typy tekstowe wymagają fokusu: całe słowa odpowiedzi.
    focus: exerciseType === "lesson_choice" ? [] : answer.replace(/[.!?]$/u, "").split(" "),
    ...extra,
  });
  const gap = (objective: string, instructionPl: string, stem: string, answer: string): LessonExerciseDraft =>
    draft(objective, "lesson_gap", answer, { instructionPl, stem });
  const choice = (objective: string, instructionPl: string, stem: string, correct: string, wrong: string): LessonExerciseDraft =>
    draft(objective, "lesson_choice", correct, { instructionPl, stem, options: [{ id: "a", text: correct }, { id: "b", text: wrong }], correctOption: "a" });
  const translation = (objective: string, prompt: string, answer: string): LessonExerciseDraft =>
    draft(objective, "lesson_open_answer", answer, { instructionPl: "Przetłumacz na angielski.", prompt });

  type Objective = "affirmative" | "now_or_usually" | "negative" | "questions" | "ing_spelling" | "now_or_usually_more";
  const OBJECTIVES: readonly Objective[] = ["affirmative", "now_or_usually", "negative", "questions", "ing_spelling", "now_or_usually_more"];
  const tenseChoice = (objective: Objective): boolean => TENSE_CHOICE_OBJECTIVES.has(objective);
  /** Luka z czasownikiem zgodna z celem: przeczenie w celach 3 i 6, pisownia -ing z reguły celu 5. */
  const GAP_BY_OBJECTIVE: Readonly<Record<Objective, readonly [stem: string, answer: string]>> = {
    affirmative: ["Grandpa ___ (sleep) on the sofa.", "is sleeping"],
    now_or_usually: ["Grandpa ___ (sleep) on the sofa.", "is sleeping"],
    negative: ["Grandpa ___ (not watch) TV.", "isn't watching"],
    questions: ["Grandpa ___ (sleep) on the sofa.", "is sleeping"],
    ing_spelling: ["Grandpa ___ (sit) on the sofa.", "is sitting"],
    now_or_usually_more: ["Grandpa ___ (not watch) TV.", "isn't watching"],
  };
  const objectiveGap = (objective: Objective, instructionPl: string, prefix = ""): LessonExerciseDraft => {
    const [stem, answer] = GAP_BY_OBJECTIVE[objective];
    return gap(objective, instructionPl, `${prefix}${stem}`, answer);
  };
  const order = (objective: string, instructionPl: string, answer: string): LessonExerciseDraft =>
    draft(objective, "lesson_order", answer, { instructionPl, items: answer.split(" ").map((text, index) => ({ id: `w${index}`, text })) });
  /** Cele z rozsypanką (§3.1): twierdzenia i pytania. */
  const ORDER_BY_OBJECTIVE: readonly [Objective, string][] = [["affirmative", "Grandpa is sleeping on the sofa"], ["questions", "Is Grandpa sleeping on the sofa"]];
  /** Brak wskaźnika „teraz”: w celach form `pc_now_marker_missing`, w celach porównania `pc_tense_marker_missing`. */
  const missingMarker = (objective: Objective): string => (tenseChoice(objective) ? "grammar.pc_tense_marker_missing" : "grammar.pc_now_marker_missing");
  type Quoted = [quoted: string, exercise: LessonExerciseDraft, expected: true | string];
  const inEvery = (quoted: string, entry: (objective: Objective) => [LessonExerciseDraft, true | string]): Quoted[] =>
    OBJECTIVES.map((objective) => [quoted, ...entry(objective)]);
  const inTenseChoice = (quoted: string, entry: (objective: Objective) => [LessonExerciseDraft, true | string]): Quoted[] =>
    OBJECTIVES.filter(tenseChoice).map((objective) => [quoted, ...entry(objective)]);

  /**
   * Angielskie zdania z nawiasów wskazówek i list (dawniej sonda „53/53” bloku `fieldRules`): fragment
   * cytowany w tekście, ćwiczenie z nim i oczekiwanie — przechodzi walidację albo oblewa ją regułą. Fragment
   * sprawdzamy w każdym celu, którego księga go pokazuje (pilnuje test pokrycia poniżej).
   */
  const QUOTED: Quoted[] = [
    ...inEvery("(Cicho! Dziadek śpi. Uzupełnij zdanie.)", (objective) => [objectiveGap(objective, "Cicho! Dziadek śpi. Uzupełnij zdanie."), true]),
    ...inEvery("never Teraz uzupełnij zdanie.", (objective) => [objectiveGap(objective, "Teraz uzupełnij zdanie."), missingMarker(objective)]),
    ...inEvery("never Cicho, dziadek śpi.", (objective) => [objectiveGap(objective, "Cicho, dziadek śpi. Uzupełnij zdanie."), missingMarker(objective)]),
    ...ORDER_BY_OBJECTIVE.map(([objective, answer]): Quoted => [
      "(Cicho! Dziadek śpi. Ułóż zdanie.)",
      order(objective, "Cicho! Dziadek śpi. Ułóż zdanie.", answer),
      true,
    ]),
    ...ORDER_BY_OBJECTIVE.map(([objective]): Quoted => [
      "Tom is reading a book now / Now Tom is reading a book",
      order(objective, "Cicho! Tom czyta. Ułóż zdanie.", "Tom is reading a book now"),
      "grammar.pc_order_movable_marker",
    ]),
    ...inEvery("This is Ola., It is sunny.", (objective) => [objectiveGap(objective, "Patrz! Uzupełnij zdanie.", "This is Ola. It is sunny. "), true]),
    ...inEvery("never The door is open.", (objective) => [
      translation(objective, "Patrz! Drzwi są otwarte.", "Look! The door is open."),
      "grammar.pc_ing_after_be",
    ]),
    ...inTenseChoice("Gdzie jest tata? / Ola codziennie gra w piłkę.", (objective) => [
      choice(objective, "Gdzie jest tata? Wybierz dobrą formę.", "Dad ___ in the garden.", "is working", "works"),
      true,
    ]),
    ...inTenseChoice("Gdzie jest tata? / Ola codziennie gra w piłkę.", (objective) => [
      objective === "now_or_usually"
        ? gap(objective, "Ola codziennie gra w piłkę. Uzupełnij zdanie.", "Ola ___ (play) football.", "plays")
        : gap(objective, "Ola codziennie gra w piłkę. Uzupełnij zdanie.", "Ola ___ (not play) tennis.", "doesn't play"),
      true,
    ]),
    ...inTenseChoice("(reads / is reading)", (objective) => [choice(objective, "Cicho! Ola czyta. Wybierz dobrą formę.", "Ola ___ a comic.", "is reading", "reads"), true]),
    ...inTenseChoice("Grandpa ___ on the sofa.", (objective) => [choice(objective, "Cicho! Dziadek śpi. Wybierz dobrą formę.", "Grandpa ___ on the sofa.", "is sleeping", "sleeps"), true]),
    // Standard „Środek” (fala 1 Task 19): przykład kart celu porównania ma mocny wskaźnik „teraz”.
    ...inTenseChoice("(Look! Ola is reading. / Ola reads comics every day.)", (objective) => [translation(objective, "Patrz! Ola czyta.", "Look! Ola is reading."), true]),
    ...inTenseChoice("(Look! Ola is reading. / Ola reads comics every day.)", (objective) => [
      translation(objective, "Ola codziennie czyta komiksy.", "Ola reads comics every day."),
      true,
    ]),
    // Krytyk końcowy B (Task 16): scenka „zwykle” w poleceniu, bez angielskiego wskaźnika w zdaniu z błędem.
    ...inTenseChoice("with Dad is washing the car. → Dad washes the car.", (objective) => [
      {
        ...draft(objective, "lesson_error_fix", "Dad washes the car.", { instructionPl: "Tata codziennie myje auto. Popraw błąd w zdaniu.", statement: "Dad is washing the car." }),
        focus: ["washes"],
      },
      true,
    ]),
    [
      "(Ola is in a tennis club. → Does Ola play tennis on Mondays?)",
      draft("now_or_usually_more", "lesson_choice", "Does Ola play tennis on Mondays?", {
        instructionPl: "Wybierz poprawne pytanie.",
        stem: "Ola is in a tennis club.",
        options: [{ id: "a", text: "Does Ola play tennis on Mondays?" }, { id: "b", text: "Is Ola playing tennis on Mondays?" }],
        correctOption: "a",
      }),
      true,
    ],
    [
      "(Ola isn't dancing on Fridays. → Ola doesn't dance on Fridays.)",
      {
        ...draft("now_or_usually_more", "lesson_error_fix", "Ola doesn't dance on Fridays.", { instructionPl: "Popraw błąd w zdaniu.", statement: "Ola isn't dancing on Fridays." }),
        focus: ["doesn't", "dance"],
      },
      true,
    ],
    ["Ola is reading a comic. → now", choice("now_or_usually", "Kiedy to się dzieje?", "Ola is reading a comic.", "now", "usually"), true],
    ["Ola reads comics. → usually", choice("now_or_usually", "Kiedy to się dzieje?", "Ola reads comics.", "usually", "now"), true],
    // Zalecenie dydaktyczne bez sprawdzenia w kodzie: zdanie przechodzi walidację.
    ["not Ola reads a comic.", choice("now_or_usually", "Kiedy to się dzieje?", "Ola reads a comic.", "usually", "now"), true],
  ];

  /** Tekst księgi reguł celu PC (`objective` — ostatni segment id). */
  const bookText = (objective: string): string => ruleBookLines(pcTopic.id, `${PC}.${objective}`).map((line) => line.text).join(" ");

  it.each(QUOTED.map(([quoted, exercise, expected]) => [`${exercise.objectiveId.split(".").at(-1)}: ${quoted}`, quoted, exercise, expected] as const))(
    "%s",
    (_name, quoted, exercise, expected) => {
      expect(bookText(exercise.objectiveId.split(".").at(-1)!), quoted).toContain(quoted);
      const issues = englishGrammarSubject.validateExercise(exercise, presentContinuousV1).map((issue) => issue.rule);
      if (expected === true) {
        expect(issues).toEqual([]);
        expect(validateLessonExercise(exercise, englishGrammarSubject, presentContinuousV1)).toEqual([]);
      } else {
        expect(issues).toContain(expected);
      }
    },
  );

  it("każdy cytowany fragment jest sprawdzony w każdym celu, którego księga go pokazuje", () => {
    for (const quoted of new Set(QUOTED.map(([text]) => text))) {
      const shown = OBJECTIVES.filter((objective) => bookText(objective).includes(quoted));
      const checked = new Set(QUOTED.filter(([text]) => text === quoted).map(([, exercise]) => exercise.objectiveId.split(".").at(-1)));
      expect(shown.length, quoted).toBeGreaterThan(0);
      expect(shown.filter((objective) => !checked.has(objective)), quoted).toEqual([]);
    }
  });

  it("wzory wyjaśnienia ze wskazówek mają dokładnie jedno zdanie, więc nie są odrzucane przez explanationTextErrors", () => {
    for (const example of [PC_EXPLANATION_EXAMPLE, PC_EXPLANATION_SCENE_EXAMPLE]) {
      expect(PC_TENSE_CHOICE_GUIDANCE).toContain(example);
      expect(explanationTextErrors(example)).toEqual([]);
    }
  });

  it("scenka-wykrzyknienie w wyjaśnieniu w cudzysłowie nie kończy zdania (bez cudzysłowu wyjaśnienie odpada)", () => {
    const rules = (text: string) => explanationIssues(text).map((issue) => issue.rule);
    expect(rules("Look! mówi, że to dzieje się teraz, więc Ola is reading.")).toEqual(["explanation.one_sentence"]);
    for (const scene of ["„Look!”", "„Cicho!”", "„Gdzie jest tata?”"]) {
      expect(PC_GUIDANCE).toContain(scene);
      expect(rules(`${scene} mówi, że to dzieje się teraz, więc Ola is reading.`), scene).toEqual([]);
    }
    // Całe ćwiczenie celu porównania z wyjaśnieniem ze scenką przechodzi walidację puli.
    const withExplanation: LessonExerciseDraft = {
      ...choice("now_or_usually", "Cicho! Dziadek śpi. Wybierz dobrą formę.", "Grandpa ___ on the sofa.", "is sleeping", "sleeps"),
      explanationPl: PC_EXPLANATION_SCENE_EXAMPLE,
    };
    expect(validateLessonExercise(withExplanation, englishGrammarSubject, presentContinuousV1)).toEqual([]);
  });

  it("kolokacje z listy są dozwolone przez regułę czasowników stanu (§5.3)", () => {
    const collocations = PC_COLLOCATIONS.split(", ");
    expect(PC_STATE_VERB_LIST).toContain(PC_COLLOCATIONS);
    expect(collocations.length).toBeGreaterThan(0);
    for (const phrase of collocations) {
      expect(stateVerbIn(`She is ${phrase} now.`, "ing_form"), phrase).toBeUndefined();
    }
  });
});
