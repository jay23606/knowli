import { registerRuleCases } from "../../testing/rule-cases";
import type { LessonExerciseDraft } from "../../types";
import { englishGrammarSubject } from "./module";
import { presentContinuousV1 } from "./topics/present-continuous";

/**
 * Przypadki reguł tematu Present Continuous (`PRESENT_CONTINUOUS_RULES` w `rules.ts`) dla
 * testu kompletności `rules/rule-cases.test.ts`. Każdy przypadek woła prawdziwy
 * `englishGrammarSubject.validateExercise` z tematem Present Continuous.
 */

type Objective = "affirmative" | "now_or_usually" | "negative" | "questions" | "ing_spelling" | "now_or_usually_more";

const check = (draft: LessonExerciseDraft) => () => englishGrammarSubject.validateExercise(draft, presentContinuousV1);

const objectiveId = (objective: Objective): string => `english_grammar.present_continuous.${objective}`;

function gap(objective: Objective, stem: string, answer: string, extra: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return { exerciseType: "lesson_gap", objectiveId: objectiveId(objective), stem, answer, acceptedAnswers: [], focus: answer.split(" "), ...extra };
}

function sentence(
  exerciseType: LessonExerciseDraft["exerciseType"],
  objective: Objective,
  answer: string,
  extra: Partial<LessonExerciseDraft> = {},
): LessonExerciseDraft {
  return { exerciseType, objectiveId: objectiveId(objective), answer, acceptedAnswers: [], focus: [], ...extra };
}

function choice(objective: Objective, stem: string, correct: string, wrong: string, type: "lesson_choice" | "lesson_listen_choice" = "lesson_choice"): LessonExerciseDraft {
  return sentence(type, objective, correct, { stem, options: [{ id: "a", text: correct }, { id: "b", text: wrong }], correctOption: "a" });
}

const translation = (objective: Objective, prompt: string, answer: string): LessonExerciseDraft =>
  sentence("lesson_open_answer", objective, answer, { prompt });

const order = (objective: Objective, answer: string): LessonExerciseDraft =>
  sentence("lesson_order", objective, answer, { items: answer.split(" ").map((text, index) => ({ id: `w${index}`, text })) });

const errorFix = (objective: Objective, statement: string, answer: string): LessonExerciseDraft =>
  sentence("lesson_error_fix", objective, answer, { statement });

const transform = (objective: Objective, transformId: string, statement: string, answer: string): LessonExerciseDraft =>
  sentence("lesson_transform", objective, answer, { statement, transformId });

const shortAnswer = (prompt: string, correct: string, wrong: string): LessonExerciseDraft =>
  sentence("lesson_short_answer", "questions", correct, { prompt, options: [{ id: "a", text: correct }, { id: "b", text: wrong }], correctOption: "a" });

function nowUsually(stem: string, key: "now" | "usually", extra: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return sentence("lesson_choice", "now_or_usually", key, {
    instructionPl: "Kiedy to się dzieje?",
    stem,
    options: [{ id: "a", text: key }, { id: "b", text: key === "now" ? "usually" : "now" }],
    correctOption: "a",
    ...extra,
  });
}

const notice = (noticeSegments: readonly (readonly string[])[], correctOption: string): LessonExerciseDraft =>
  sentence("lesson_notice", "affirmative", correctOption, { noticeSegments, correctOption });

registerRuleCases([
  { rule: "grammar.pc_gap_hint", violation: check(gap("affirmative", "Tom ___ (play) football now.", "is playing", { hint: "play" })) },
  { rule: "grammar.pc_forbidden_marker", violation: check(gap("affirmative", "He ___ (play) tennis tomorrow.", "is playing")) },
  { rule: "grammar.pc_going_to_future", violation: check(gap("affirmative", "Tom ___ (go) to play football now.", "is going")) },
  { rule: "grammar.pc_usually_marker", violation: check(gap("affirmative", "Tom ___ (play) football every day.", "is playing")) },
  { rule: "grammar.pc_now_marker_missing", violation: check(gap("affirmative", "Tom ___ (play) football.", "is playing")) },
  { rule: "grammar.pc_now_marker_bare", violation: check(gap("negative", "She ___ (not watch) TV now.", "isn't watching")) },
  { rule: "grammar.pc_bracket_outside_gap", violation: check(gap("affirmative", "He ___ football (play) now.", "is playing")) },
  { rule: "grammar.pc_being", violation: check(gap("affirmative", "He ___ (be) silly now.", "is being")) },
  { rule: "grammar.pc_state_verb_ing", violation: check(gap("affirmative", "She ___ (like) it now.", "is liking")) },
  { rule: "grammar.pc_state_verb_tense_choice", violation: check(gap("now_or_usually", "Ola ___ (like) comics every day.", "likes")) },
  { rule: "grammar.pc_be_form_subject", violation: check(gap("affirmative", "They ___ (play) football now.", "is playing")) },
  { rule: "grammar.pc_be_gap_double_negation", violation: check(gap("negative", "She ___ not sleeping now.", "isn't")) },
  { rule: "grammar.pc_be_gap_negative_without_no", violation: check(gap("questions", "___ she reading a book?", "Isn't")) },
  { rule: "grammar.pc_be_yes_negative", violation: check(shortAnswer("Is she reading?", "Yes, she isn't.", "No, she is.")) },
  { rule: "grammar.pc_be_no_affirmative", violation: check(gap("questions", "Is she reading? No, she ___.", "is")) },
  { rule: "grammar.pc_be_negated", violation: check(order("affirmative", "He isn't playing now.")) },
  { rule: "grammar.pc_be_missing_negation", violation: check(gap("negative", "She ___ sleeping now.", "is")) },
  { rule: "grammar.pc_verb_outside_table", violation: check(gap("affirmative", "The plant ___ (photosynthesise) now.", "is photosynthesising")) },
  { rule: "grammar.pc_ing_wrong_form", violation: check(gap("affirmative", "Tom ___ (play) football now.", "is plaing")) },
  { rule: "grammar.pc_ing_rule_not_allowed", violation: check(translation("affirmative", "On teraz pisze.", "He is writing now.")) },
  { rule: "grammar.pc_collocation_in_ing_spelling", violation: check(translation("ing_spelling", "Ona teraz je obiad.", "She is having lunch now.")) },
  { rule: "grammar.pc_verb_gap_be_missing", violation: check(gap("affirmative", "Tom ___ (play) football now.", "playing")) },
  { rule: "grammar.pc_gap_negation_bracket", violation: check(gap("affirmative", "Tom ___ (play) football now.", "isn't playing")) },
  { rule: "grammar.pc_ing_after_be", violation: check(gap("affirmative", "Tom ___ (play) football now.", "is")) },
  { rule: "grammar.pc_verb_gap_whole_form", violation: check(gap("questions", "Is she ___ (read) a book now?", "reading")) },
  { rule: "grammar.pc_gap_bracket_objective", violation: check(gap("affirmative", "She ___ (not watch) TV now.", "isn't watching")) },
  { rule: "grammar.pc_leading_apostrophe", violation: check(gap("affirmative", "They ___ playing now.", "'re")) },
  { rule: "grammar.pc_gap_shape", violation: check(gap("affirmative", "Tom ___ football now.", "is playing")) },
  { rule: "grammar.pc_be_gap_objective", violation: check(gap("ing_spelling", "He ___ swimming now.", "is")) },
  { rule: "grammar.pc_wh_question", violation: check(order("questions", "Where is he going?")) },
  { rule: "grammar.pc_sentence_be_missing", violation: check(translation("affirmative", "On teraz gra.", "He playing now.")) },
  { rule: "grammar.pc_sentence_not_continuous", violation: check(translation("affirmative", "Mama jest teraz w kuchni.", "Mum is in the kitchen now.")) },
  { rule: "grammar.pc_short_answer_person", violation: check(shortAnswer("Is she reading?", "Yes, he is.", "No, she isn't.")) },
  { rule: "grammar.pc_be_choice_polarity_distractor", violation: check(choice("questions", "___ she reading a book?", "Is", "Isn't")) },
  { rule: "grammar.pc_numberless_subject", violation: check(gap("affirmative", "Look! The fish ___ (eat).", "is eating")) },
  { rule: "grammar.pc_s_contraction", violation: check(translation("affirmative", "On teraz gra.", "He's playing now.")) },
  { rule: "grammar.pc_translation_now_marker", violation: check(translation("affirmative", "Tata gotuje obiad.", "Dad is cooking dinner now.")) },
  { rule: "grammar.pc_translation_key_marker", violation: check(translation("affirmative", "Ola teraz czyta.", "Ola is reading.")) },
  { rule: "grammar.pc_translation_now_variants", violation: check(translation("affirmative", "Ola teraz czyta.", "Ola is reading now.")) },
  { rule: "grammar.pc_ing_without_be", violation: check(translation("now_or_usually", "Ola teraz czyta.", "Ola reading now.")) },
  { rule: "grammar.pc_tense_form_missing", violation: check(gap("now_or_usually", "Ola ___ (read) a comic every day.", "red")) },
  { rule: "grammar.pc_now_usually_stem_marker", violation: check(nowUsually("Ola is reading now.", "now")) },
  { rule: "grammar.pc_now_usually_instruction", violation: check(nowUsually("Ola is reading a book.", "now", { instructionPl: "Cicho! Ola czyta." })) },
  { rule: "grammar.pc_now_usually_stem_shape", violation: check(nowUsually("Is Ola reading a book?", "now")) },
  { rule: "grammar.pc_now_usually_key", violation: check(nowUsually("Ola is reading a book.", "usually")) },
  { rule: "grammar.pc_tense_choice_gap_question", violation: check(choice("now_or_usually_more", "___ you play football on Saturdays?", "Do", "Are")) },
  {
    rule: "grammar.pc_choice_distractor_correct",
    violation: check(sentence("lesson_choice", "affirmative", "Look! Ola is reading.", {
      options: [{ id: "a", text: "Look! Ola is reading." }, { id: "b", text: "Look! Tom is reading." }],
      correctOption: "a",
    })),
  },
  { rule: "grammar.pc_distractor_outside_table", violation: check(choice("affirmative", "Look! Ola ___ the dog.", "is walking", "is feeding")) },
  { rule: "grammar.pc_ing_spelling_distractor", violation: check(choice("ing_spelling", "Look! Tom ___ in the lake.", "is swimming", "is running")) },
  { rule: "grammar.pc_tense_choice_distractor", violation: check(choice("now_or_usually", "Ola ___ comics every day.", "reads", "cooks")) },
  { rule: "grammar.pc_now_or_usually_question", violation: check(translation("now_or_usually", "Czy Ola codziennie czyta?", "Does Ola read every day?")) },
  { rule: "grammar.pc_now_or_usually_negative", violation: check(translation("now_or_usually", "Ola codziennie nie czyta.", "Ola doesn't read every day.")) },
  { rule: "grammar.pc_tense_choice_question_type", violation: check(order("now_or_usually_more", "Does Ola read every day?")) },
  { rule: "grammar.pc_tense_marker_missing", violation: check(gap("now_or_usually", "Ola ___ (read) a comic.", "reads")) },
  { rule: "grammar.pc_tense_markers_mixed", violation: check(gap("now_or_usually", "Look! Ola ___ (read) a comic every evening.", "is reading")) },
  { rule: "grammar.pc_tense_marker_mismatch", violation: check(gap("now_or_usually", "Look! Ola ___ (read).", "reads")) },
  { rule: "grammar.pc_simple_form_subject", violation: check(gap("now_or_usually", "He ___ (play) every day.", "play")) },
  { rule: "grammar.pc_simple_base_after_do", violation: check(translation("now_or_usually_more", "Czy Ola codziennie czyta?", "Does Ola reads every day?")) },
  {
    rule: "grammar.pc_error_fix_region",
    violation: check(errorFix("affirmative", "He is play football in the park now.", "He is playing football in the garden now.")),
    // Obszar dokładnie MAX_ERROR_FIX_REGION_TOKENS słów po każdej stronie.
    boundary: check(errorFix("affirmative", "He is play the ball now.", "He is playing a game now.")),
  },
  { rule: "grammar.pc_error_fix_kind", violation: check(errorFix("affirmative", "Tom is playing now.", "Ola is playing now.")) },
  { rule: "grammar.pc_error_fix_do_ing", violation: check(errorFix("negative", "Tom doesn't watching TV now.", "Tom isn't watching TV now.")) },
  { rule: "grammar.pc_notice_ing_count", violation: check(notice([["Tom", "is", "playing", "now."], ["Ola", "is", "reading."]], "playing")) },
  { rule: "grammar.pc_notice_target", violation: check(notice([["Tom", "is", "playing", "now."], ["Good", "morning!"]], "is")) },
  { rule: "grammar.pc_transform_statement_question", violation: check(transform("questions", "to_question", "Is he playing now?", "Is he playing now?")) },
  { rule: "grammar.pc_transform_question_shape", violation: check(transform("questions", "to_question", "He is playing now.", "He is playing now!")) },
  { rule: "grammar.pc_transform_question_negative", violation: check(transform("questions", "to_question", "She isn't sleeping now.", "Is she sleeping now?")) },
  { rule: "grammar.pc_transform_key_statement", violation: check(transform("negative", "to_negative", "Tom is playing right now.", "Ola isn't playing right now.")) },
  { rule: "grammar.pc_transform_polarity", violation: check(transform("negative", "to_negative", "He isn't playing now.", "He isn't playing now!")) },
  { rule: "grammar.pc_listen_choice_options", violation: check(choice("affirmative", "___ playing football now.", "He's", "He", "lesson_listen_choice")) },
  { rule: "grammar.pc_order_movable_marker", violation: check(order("affirmative", "Tom is reading a book now")) },
]);
