import { defineRules, issueFrom, type RuleBookContext } from "../../rules/catalog";
import { ENGLISH_RULES } from "../english/rules";

/** Temat czasownika „to be”: jego reguły sprawdza walidator tylko w tym temacie (`topic.id === "to_be"`). */
const TO_BE_TOPIC = "to_be";

/** Reguła tematu „to be” trafia do księgi reguł tylko w tym temacie. */
const inToBe = (ctx: RuleBookContext): boolean => ctx.topicId === TO_BE_TOPIC;

/**
 * Wskazówki tematu „to be” i wyboru obrazka (kod ich nie sprawdza) w opisach reguł tego tematu: trafiają do
 * promptu tylko w nim, razem z regułą (dopiski `ruleNotes` dotyczą wyłącznie reguł silnika).
 */
const TO_BE_GUIDANCE =
  " 'To be' questions swap the subject and the form (Is she happy?, Are they ready?); short answers repeat the form " +
  "(Yes, she is. / No, they aren't.). Keep 'to be' sentences very short and concrete, reusing a small set of subjects " +
  "and words from the material so the only new thing is the form of 'to be'.";

const PICTURE_CHOICE_GUIDANCE =
  " Picture choice (only in objectives whose id contains '.affirmative_forms'): some lesson_choice exercises set " +
  "visualSubject to who is pictured; then the stem is a sentence frame with the pronoun missing (___ is happy. / ___ " +
  "are happy.) and the options are pronouns (He, She, It, They), so the child picks the pronoun for the picture.";

/** Reguła luk Present Simple: walidator sprawdza ją poza tematem „to be”. */
const outsideToBe = (ctx: RuleBookContext): boolean => ctx.topicId !== TO_BE_TOPIC;

/**
 * Katalog reguł przedmiotu `english_grammar` (`validateExercise`) ze wspólnym
 * fragmentem angielskim. Opisy po angielsku dla modelu agenta; zgłoszenia
 * składają walidatory przez `grammarIssue`.
 */
export const GRAMMAR_RULES = defineRules({
  ...ENGLISH_RULES,
  "grammar.visual_answer_pronoun": {
    // Piktogram ma tylko temat „to be” (wskazówka w dopisku reguły); poza nim opis dostaje model w wyniku narzędzia.
    when: inToBe,
    field: "answer",
    kind: "reject",
    description:
      "When visualSubject is set, the answer starts with the personal pronoun the picture requires " +
      "(boy and man: he, girl and woman: she, group: they, dog: it)." + PICTURE_CHOICE_GUIDANCE,
  },
  "grammar.visual_option_pronoun": {
    // Piktogram ma tylko temat „to be” (wskazówka w dopisku reguły); poza nim opis dostaje model w wyniku narzędzia.
    when: inToBe,
    field: "options",
    kind: "reject",
    description: "When visualSubject is set, the option marked correct starts with the personal pronoun the picture requires.",
  },
  "grammar.visual_stem_pronoun": {
    // Piktogram ma tylko temat „to be” (wskazówka w dopisku reguły); poza nim opis dostaje model w wyniku narzędzia.
    when: inToBe,
    field: "stem",
    kind: "reject",
    description:
      "When visualSubject is set, a subject pronoun in the stem (next to a form of be or right before the gap) is the one the picture requires.",
  },
  "grammar.visual_stem_be_form": {
    // Piktogram ma tylko temat „to be” (wskazówka w dopisku reguły); poza nim opis dostaje model w wyniku narzędzia.
    when: inToBe,
    field: "stem",
    kind: "reject",
    description: "When visualSubject is set, every form of be in the stem agrees with the person in the picture.",
  },
  "grammar.translation_prompt_equals_answer": {
    field: "prompt",
    kind: "reject",
    types: ["lesson_open_answer"],
    description: "The prompt of a translation exercise is never equal to the answer or to an accepted answer (compared after normalization).",
  },
  "grammar.be_gap_hint": {
    field: "hint",
    kind: "reject",
    when: inToBe,
    types: ["lesson_gap"],
    description: "In the to_be topic the hint of a lesson_gap is either \"be\" or empty.",
  },
  "grammar.be_bare_not": {
    field: "answer",
    kind: "reject",
    when: inToBe,
    types: ["lesson_gap"],
    description: "In the to_be topic a gap answer consisting only of \"not\" is allowed only in the negative_forms objective, where the form of be already stands in the sentence.",
  },
  "grammar.be_adverb_before_gap": {
    field: "stem",
    kind: "reject",
    when: inToBe,
    types: ["lesson_gap"],
    description: "In the to_be topic a frequency adverb (always, usually, often, never...) stands after am, is or are, so the gap cannot directly follow it.",
  },
  "grammar.be_answer_not_be_form": {
    field: "answer",
    kind: "reject",
    when: inToBe,
    types: ["lesson_gap"],
    description: "In the to_be topic every gap answer and accepted variant is a form of be (am, is, are), possibly contracted or negated.",
  },
  "grammar.be_contraction_person": {
    field: "answer",
    kind: "reject",
    when: inToBe,
    description: "In the to_be topic a contracted answer (I'm, he's, they're...) pairs the pronoun with the matching form of be.",
  },
  "grammar.be_short_answer_contraction": {
    field: "answer",
    kind: "reject",
    when: inToBe,
    description: "In the to_be topic an affirmative short answer does not end with a contraction (write Yes, I am, not Yes, I'm); negative short answers may contract.",
  },
  "grammar.be_short_answer_you": {
    field: "answer",
    kind: "reject",
    when: inToBe,
    description: "In the to_be topic a short answer to a question about you speaks about the speaker: it uses I, not you.",
  },
  "grammar.be_answer_person": {
    field: "answer",
    kind: "reject",
    when: inToBe,
    description: "In the to_be topic the pronoun in the answer matches the subject next to the gap; a short answer follows the perspective of the question.",
  },
  "grammar.be_form_subject": {
    field: "answer",
    kind: "reject",
    when: inToBe,
    description:
      "In the to_be topic the form of be in the answer agrees with the subject next to the gap (am, is or are)." + TO_BE_GUIDANCE,
  },
  "grammar.be_sentence_person_form": {
    field: "answer",
    kind: "reject",
    when: inToBe,
    description: "In the to_be topic the form of be in a full sentence agrees with its subject pronoun; a compound subject takes are.",
  },
  "grammar.be_no_do_does": {
    field: "answer",
    kind: "reject",
    when: inToBe,
    description: "In the to_be topic sentences do not use do or does.",
  },
  "grammar.be_yes_negative": {
    field: "answer",
    kind: "reject",
    when: inToBe,
    description: "In the to_be topic an answer that starts with Yes is not negated.",
  },
  "grammar.be_no_affirmative": {
    field: "answer",
    kind: "reject",
    when: inToBe,
    description: "In the to_be topic an answer that starts with No is negated.",
  },
  "grammar.be_negative_in_affirmative_objective": {
    field: "answer",
    kind: "reject",
    when: inToBe,
    description: "In the to_be topic an answer for the affirmative_forms or contractions objective is not negated.",
  },
  "grammar.be_missing_negation": {
    field: "answer",
    kind: "reject",
    when: inToBe,
    description: "In the to_be topic an answer for the negative_forms objective contains the negation not.",
  },
  "grammar.gap_operator_mismatch": {
    field: "answer",
    kind: "reject",
    when: outsideToBe,
    types: ["lesson_gap"],
    description:
      "A gap answered with an operator (do, does, don't, doesn't) fits the objective, agrees with the subject near the gap " +
      "and is followed by the base form of the verb.",
  },
  "grammar.gap_present_simple_form": {
    field: "answer",
    kind: "reject",
    when: outsideToBe,
    types: ["lesson_gap"],
    description: "When the hint of a lesson_gap is a verb, the gap answer is a Present Simple form of that verb (base form, third person singular, or with do and does).",
  },
});

/** Fabryka zgłoszeń reguł gramatyki (także `english.*` dzielone z rozdziałem). */
export const grammarIssue = issueFrom(GRAMMAR_RULES);
