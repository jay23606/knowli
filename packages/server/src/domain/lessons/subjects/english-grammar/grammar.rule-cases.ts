import { registerRuleCases } from "../../testing/rule-cases";
import type { LessonExerciseDraft, LessonTopic } from "../../types";
import { englishGrammarSubject } from "./module";
import { presentSimpleV1 } from "./topics/present-simple";
import { toBeV1 } from "./topics/to-be";

/**
 * Przypadki reguł katalogu gramatyki (`rules.ts`) dla testu kompletności
 * `rules/rule-cases.test.ts`. Każdy przypadek woła prawdziwy
 * `englishGrammarSubject.validateExercise`.
 */

const AFF = "english_grammar.to_be.affirmative_forms";
const NEG = "english_grammar.to_be.negative_forms";
const SHORT = "english_grammar.to_be.short_answers";

const check = (draft: LessonExerciseDraft, topic: LessonTopic) => () =>
  englishGrammarSubject.validateExercise(draft, topic);

/** Luka tematu „to be”. */
function beGap(objectiveId: string, stem: string, answer: string, hint = "be"): LessonExerciseDraft {
  return { exerciseType: "lesson_gap", objectiveId, stem, hint, answer, acceptedAnswers: [], focus: [answer] };
}

/** Wybór z piktogramem: opcje She/He, poprawna wskazana przez `correct`. */
function visualChoice(visualSubject: "girl" | "boy", stem: string, answer: string, correct: "a" | "b"): LessonExerciseDraft {
  return {
    exerciseType: "lesson_choice",
    objectiveId: AFF,
    stem,
    visualSubject,
    answer,
    acceptedAnswers: [],
    focus: [answer],
    options: [{ id: "a", text: "She" }, { id: "b", text: "He" }],
    correctOption: correct,
  };
}

/** Zdanie „to be” poza luką (error_fix). */
function beSentence(objectiveId: string, answer: string): LessonExerciseDraft {
  return {
    exerciseType: "lesson_error_fix",
    objectiveId,
    statement: "She is happy.",
    answer,
    acceptedAnswers: [],
    focus: [],
  };
}

/** Luka Present Simple z podpowiedzią-bezokolicznikiem. */
function simpleGap(objectiveId: string, stem: string, answer: string, hint: string): LessonExerciseDraft {
  return { exerciseType: "lesson_gap", objectiveId, stem, hint, answer, acceptedAnswers: [], focus: [answer] };
}

registerRuleCases([
  { rule: "grammar.visual_answer_pronoun", violation: check(visualChoice("girl", "___ is happy.", "He", "a"), toBeV1) },
  { rule: "grammar.visual_option_pronoun", violation: check(visualChoice("boy", "___ is happy.", "He", "a"), toBeV1) },
  { rule: "grammar.visual_stem_pronoun", violation: check(visualChoice("girl", "He is happy.", "She", "a"), toBeV1) },
  { rule: "grammar.visual_stem_pronoun", violation: check(visualChoice("boy", "She ___ happy.", "is", "b"), toBeV1) },
  { rule: "grammar.visual_stem_be_form", violation: check(visualChoice("girl", "She are happy.", "She", "a"), toBeV1) },
  {
    rule: "grammar.translation_prompt_equals_answer",
    violation: check({
      exerciseType: "lesson_open_answer",
      objectiveId: "english_grammar.present_simple.third_person_s",
      prompt: "She plays football.",
      answer: "She plays football.",
      acceptedAnswers: [],
      focus: [],
    }, presentSimpleV1),
  },
  { rule: "grammar.be_gap_hint", violation: check(beGap(AFF, "She ___ happy.", "is", "do"), toBeV1) },
  { rule: "grammar.be_bare_not", violation: check(beGap(AFF, "She is ___ happy.", "not"), toBeV1) },
  { rule: "grammar.be_adverb_before_gap", violation: check(beGap(AFF, "She always ___ happy.", "is"), toBeV1) },
  { rule: "grammar.be_answer_not_be_form", violation: check(beGap(AFF, "She ___ happy.", "plays"), toBeV1) },
  { rule: "grammar.be_contraction_person", violation: check(beGap(AFF, "He ___ happy.", "he am"), toBeV1) },
  { rule: "grammar.be_short_answer_contraction", violation: check(beGap(SHORT, "Yes, I ___.", "I'm"), toBeV1) },
  {
    rule: "grammar.be_short_answer_you",
    violation: check({
      exerciseType: "lesson_short_answer",
      objectiveId: SHORT,
      prompt: "Are you ready?",
      answer: "Yes, you are.",
      acceptedAnswers: [],
      focus: [],
    }, toBeV1),
  },
  { rule: "grammar.be_answer_person", violation: check(beGap(SHORT, "Is he ready? Yes, ___.", "she is"), toBeV1) },
  { rule: "grammar.be_form_subject", violation: check(beGap(AFF, "She ___ happy.", "are"), toBeV1) },
  { rule: "grammar.be_sentence_person_form", violation: check(beSentence(AFF, "She are happy."), toBeV1) },
  { rule: "grammar.be_no_do_does", violation: check(beSentence(AFF, "She does not happy."), toBeV1) },
  { rule: "grammar.be_yes_negative", violation: check(beGap(SHORT, "Am I late? ___", "Yes, I am not."), toBeV1) },
  { rule: "grammar.be_no_affirmative", violation: check(beGap(SHORT, "Am I late? ___", "No, I am."), toBeV1) },
  { rule: "grammar.be_negative_in_affirmative_objective", violation: check(beGap(AFF, "She ___ happy.", "isn't"), toBeV1) },
  { rule: "grammar.be_missing_negation", violation: check(beGap(NEG, "She ___ happy.", "is"), toBeV1) },
  {
    rule: "grammar.gap_operator_mismatch",
    violation: check(simpleGap("english_grammar.present_simple.question", "___ she play tennis?", "do", "do"), presentSimpleV1),
  },
  {
    rule: "grammar.gap_present_simple_form",
    violation: check(simpleGap("english_grammar.present_simple.third_person_s", "He ___ every day.", "played", "play"), presentSimpleV1),
  },
]);
