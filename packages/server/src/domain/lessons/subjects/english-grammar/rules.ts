import { defineRules, issueFrom, type RuleBookContext } from "../../rules/catalog";
import { ENGLISH_RULES } from "../english/rules";
import {
  PC_FORBIDDEN_MARKERS,
  PC_FORMS_TRANSLATION_GUIDANCE,
  PC_GUIDANCE,
  PC_NOW_MARKERS,
  PC_NOW_OR_USUALLY_GUIDANCE,
  PC_NOW_OR_USUALLY_MORE_GUIDANCE,
  PC_STATE_VERB_LIST,
  PC_TENSE_CHOICE_GUIDANCE,
  PC_USUALLY_MARKERS,
  PC_VERB_LISTS,
} from "./present-continuous-guidance";

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

/** Temat Present Continuous: jego reguły sprawdza walidator tylko w tym temacie (`topic.id === "present_continuous"`). */
const PRESENT_CONTINUOUS_TOPIC = "present_continuous";

/** Reguła tematu Present Continuous trafia do księgi reguł tylko w tym temacie. */
const inPresentContinuous = (ctx: RuleBookContext): boolean => ctx.topicId === PRESENT_CONTINUOUS_TOPIC;

/**
 * Reguła wybranych celów Present Continuous (ostatni segment id zagadnienia) trafia do księgi tylko w nich. Zbiory
 * celów są te same co w walidatorze, który zgłasza regułę tylko w tych celach (`PC_FORM_OBJECTIVES`,
 * `TENSE_CHOICE_OBJECTIVES`; pilnuje test modułu), więc w innych celach jej opis byłby szumem promptu.
 */
const inPcObjectives = (...objectives: readonly string[]) => (ctx: RuleBookContext): boolean =>
  inPresentContinuous(ctx) && objectives.includes(ctx.objectiveId.split(".").at(-1) ?? "");

/** Cele form Present Continuous (1, 3, 4, 5): walidator sprawdza w nich kontekst „teraz”. */
const inPcForms = inPcObjectives("affirmative", "negative", "questions", "ing_spelling");

/** Cele porównania (2, 6): walidator sprawdza w nich wybór czasu. */
const inTenseChoice = inPcObjectives("now_or_usually", "now_or_usually_more");

/** Najwięcej tokenów po każdej stronie obszaru różnicy `error_fix` (§6.3). */
export const MAX_ERROR_FIX_REGION_TOKENS = 3;

/**
 * Reguły tematu Present Continuous (design „Present Continuous” §4–§6): walidator
 * tematu (`present-continuous-validation.ts` i pliki, które woła) zgłasza je przez
 * `grammarIssue`. Jedna reguła na jedno sprawdzenie. Listy ze stałych walidatora i dydaktyka
 * tematu (kod jej nie sprawdza) są dopiskami opisów (`present-continuous-guidance.ts`), więc
 * trafiają do promptu tylko w tym temacie; reguły, które walidator zgłasza tylko w części celów, i ich dopiski
 * trafiają tylko do ksiąg tych celów (`inPcObjectives`).
 */
const PRESENT_CONTINUOUS_RULES = defineRules({
  "grammar.pc_gap_hint": {
    when: inPresentContinuous,
    field: "hint",
    kind: "reject",
    types: ["lesson_gap"],
    description: "In the present_continuous topic a lesson_gap has no hint: the base verb stands in brackets right after the gap.",
  },
  "grammar.pc_forbidden_marker": {
    when: inPresentContinuous,
    field: "exercise",
    kind: "reject",
    description:
      "In the present_continuous topic no field uses a future or ambiguous time marker (tomorrow, tonight, next week, today, " +
      "on Monday, jutro, dzisiaj...), in English or Polish." + PC_FORBIDDEN_MARKERS + PC_GUIDANCE,
  },
  "grammar.pc_going_to_future": {
    when: inPresentContinuous,
    field: "exercise",
    kind: "reject",
    description:
      "In the present_continuous topic no sentence uses be going to + a verb (the future), also after the answer is put into " +
      "the gap; going to + a place is fine.",
  },
  "grammar.pc_usually_marker": {
    when: inPcForms,
    field: "exercise",
    kind: "reject",
    description:
      "In the affirmative, negative, questions and ing_spelling objectives no field has a usually marker (every day, always, " +
      "codziennie, zwykle...): the action happens right now." + PC_USUALLY_MARKERS,
  },
  "grammar.pc_now_marker_missing": {
    when: inPcForms,
    field: "exercise",
    kind: "reject",
    description:
      "In the affirmative, negative, questions and ing_spelling objectives a verb gap, a lesson_error_fix, a lesson_transform and " +
      "a lesson_choice whose options are not only am, is or are (in ing_spelling: with a present simple option) have a now marker " +
      "(now, at the moment, Look!, teraz, Cicho!...) in what the child sees before answering: the stem, the statement, the " +
      "prompt, instructionPl or the lesson_notice sentences; a marker only in the answer, an accepted answer or one option does " +
      "not count, and the options count only when every option has a marker of the same group. In questions What + am/is/are + " +
      "subject + doing? is enough. Without the marker another tense would be correct too." + PC_NOW_MARKERS,
  },
  "grammar.pc_now_marker_bare": {
    when: inPresentContinuous,
    field: "exercise",
    kind: "reject",
    description:
      "Where an exercise needs a now marker, a bare now, or the Polish teraz, właśnie or akurat, is not enough in two cases, " +
      "because it can mean nowadays (Tom doesn't watch TV now.): in a negative exercise of the affirmative, negative, questions " +
      "and ing_spelling objectives (a (not verb) gap, a negated answer, accepted answer or option, a negated statement of a " +
      "lesson_error_fix or lesson_transform, or a translation with a negated answer, judged by its Polish prompt) and in every " +
      "exercise of the now_or_usually and now_or_usually_more objectives with the now group. Use right now, at the moment, " +
      "Look!, Listen!, Shh!, Be quiet!, Look at ...! or a Polish scene (Cicho!, Patrz!, Posłuchaj!, w tej chwili, Gdzie jest " +
      "...?). In other affirmatives and questions a bare now still counts. The now / usually meaning check is an exception.",
  },
  "grammar.pc_bracket_outside_gap": {
    when: inPresentContinuous,
    field: "exercise",
    kind: "reject",
    description: "In the present_continuous topic brackets stand only right after the gap of a lesson_gap (He ___ (play) right now.), nowhere else.",
  },
  "grammar.pc_being": {
    when: inPresentContinuous,
    field: "exercise",
    kind: "reject",
    description: "In the present_continuous topic no sentence uses being (He is being silly).",
  },
  "grammar.pc_state_verb_ing": {
    when: inPcForms,
    field: "answer",
    kind: "reject",
    description:
      "In the affirmative, negative, questions and ing_spelling objectives the sentence with the answer has no state verb in " +
      "the -ing form (liking, knowing, wanting...); having breakfast and looking at style collocations are fine." + PC_STATE_VERB_LIST,
  },
  "grammar.pc_state_verb_tense_choice": {
    when: inTenseChoice,
    field: "exercise",
    kind: "reject",
    description:
      "In the now_or_usually and now_or_usually_more objectives no English text uses a state verb in any form (likes, has, " +
      "wants...), except the having and looking collocations and Look!." + PC_STATE_VERB_LIST,
  },
  "grammar.pc_be_form_subject": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    description:
      "In the present_continuous topic every am, is or are agrees with its subject (I am; he, she, it, one name or one thing is; " +
      "you, we, they, two names or a plural noun are).",
  },
  "grammar.pc_be_gap_double_negation": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    description: "In the present_continuous topic a negative be-gap answer (isn't, aren't, am not) never stands where not already follows the gap.",
  },
  "grammar.pc_be_gap_negative_without_no": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    description:
      "In the present_continuous topic a negative be-gap answer needs No before the gap (Is she sleeping? No, she ___.), " +
      "otherwise the affirmative fits too; only in the negative objective may a be gap outside a lesson_gap (choice, " +
      "listening choice, short answer) have a negative key without No.",
  },
  "grammar.pc_be_yes_negative": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    description: "In the present_continuous topic an answer after Yes is not negated.",
  },
  "grammar.pc_be_no_affirmative": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    description: "In the present_continuous topic an answer after No is negated.",
  },
  "grammar.pc_be_negated": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    description:
      "In the affirmative, now_or_usually and ing_spelling objectives, and after the to_affirmative transform, the form of " +
      "am, is or are is not negated.",
  },
  "grammar.pc_be_missing_negation": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    description: "In the negative objective, and after the to_negative transform, the form of am, is or are is negated with not.",
  },
  "grammar.pc_verb_outside_table": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    description:
      "In the present_continuous topic every checked verb and -ing form comes from the topic's verb table (or is a having or " +
      "looking collocation).",
  },
  "grammar.pc_ing_wrong_form": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    types: ["lesson_gap"],
    description: "In the present_continuous topic the -ing form in a verb gap answer is the correct -ing form of the verb in the brackets.",
  },
  "grammar.pc_ing_rule_not_allowed": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    description:
      "In the present_continuous topic the checked verb follows a spelling rule of the objective: plain verbs in affirmative, " +
      "now_or_usually, negative and questions; drop_e, double and ie_to_y in ing_spelling (plain only as a lesson_choice " +
      "contrast); any of them in now_or_usually_more." + PC_VERB_LISTS,
  },
  "grammar.pc_collocation_in_ing_spelling": {
    when: inPcObjectives("ing_spelling"),
    field: "answer",
    kind: "reject",
    description: "In the ing_spelling objective the key never uses a having or looking collocation, which practises no spelling rule.",
  },
  "grammar.pc_verb_gap_be_missing": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    types: ["lesson_gap"],
    description:
      "In the present_continuous topic a present continuous verb gap answer starts with am, is or are (They ___ (play) right now. → are playing).",
  },
  "grammar.pc_gap_negation_bracket": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    types: ["lesson_gap"],
    description:
      "In the present_continuous topic a verb gap answer is negated exactly when the brackets say not (She ___ (not watch) TV right now. → isn't watching).",
  },
  "grammar.pc_ing_after_be": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    description:
      "In the present_continuous topic am, is or are (with not) is followed by one -ing form of the verb (She is playing, never " +
      "She is play or She is plays); a verb gap answer is exactly am/is/are [not] + one -ing form.",
  },
  "grammar.pc_verb_gap_whole_form": {
    when: inPresentContinuous,
    field: "stem",
    kind: "reject",
    types: ["lesson_gap"],
    description:
      "In the present_continuous topic a verb gap stands for the whole verb form, so the clause before the gap has no am, is, are, " +
      "do or does and no contraction with is such as what's, where's or there's (never Is she ___ (read)?).",
  },
  "grammar.pc_gap_bracket_objective": {
    when: inPresentContinuous,
    field: "stem",
    kind: "reject",
    types: ["lesson_gap"],
    description:
      "In the present_continuous topic the brackets of a verb gap say (not verb) in the negative and now_or_usually_more " +
      "objectives and never in the other objectives.",
  },
  "grammar.pc_leading_apostrophe": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    types: ["lesson_gap", "lesson_choice"],
    description: "In the present_continuous topic a gap answer or a choice option never starts with an apostrophe ('re playing): write the full am, is or are.",
  },
  "grammar.pc_gap_shape": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    types: ["lesson_gap"],
    description:
      "In the present_continuous topic a lesson_gap is either a verb gap with the base verb in brackets right after the gap " +
      "(He ___ (play) right now.) or a be gap whose answer is only am, is or are (with not).",
  },
  "grammar.pc_be_gap_objective": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    types: ["lesson_gap"],
    description: "In the present_continuous topic a be gap (the answer is only am, is or are) is used only in the affirmative, negative and questions objectives.",
  },
  "grammar.pc_wh_question": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    description:
      "In the present_continuous topic the only wh-question is What + am/is/are + subject + doing? (What is he doing?); no " +
      "sentence starts with another question word.",
  },
  "grammar.pc_sentence_be_missing": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    description:
      "In the present_continuous topic a present continuous key (with the stem around it when it fills a gap) contains at " +
      "least one am, is or are.",
  },
  "grammar.pc_sentence_not_continuous": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    description:
      "In the present_continuous topic a present continuous key has am/is/are + an -ing verb, not only is as a linking verb " +
      "(Mum is in the kitchen.).",
  },
  "grammar.pc_short_answer_person": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    types: ["lesson_short_answer"],
    description:
      "In the present_continuous topic the person of a short answer matches the question (Is she reading? → she; Are you " +
      "playing? → I; Are the boys playing? → they; Is Tom reading? → he, she or it).",
  },
  "grammar.pc_be_choice_polarity_distractor": {
    when: inPresentContinuous,
    field: "options",
    kind: "reject",
    types: ["lesson_choice", "lesson_listen_choice", "lesson_short_answer"],
    description:
      "In the present_continuous topic a choice between forms of am, is or are never offers two options that differ only by " +
      "not or n't (Is / Isn't) when no Yes/No and no not around the gap decide between them, and the options of a " +
      "lesson_short_answer never start with both Yes and No (Yes, he is. / No, he isn't. are both correct): all options start " +
      "with the same Yes or No (Yes, she is. / Yes, she does.).",
  },
  "grammar.pc_numberless_subject": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    types: ["lesson_gap", "lesson_choice", "lesson_listen_choice", "lesson_short_answer", "lesson_error_fix", "lesson_open_answer"],
    description:
      "In the present_continuous topic fish, sheep and deer are the same in the singular and the plural, so in a key, an " +
      "accepted answer or the correct option (with the stem around it when it fills a gap) of a lesson_gap, lesson_choice, " +
      "lesson_listen_choice, lesson_short_answer, lesson_error_fix or lesson_open_answer such a noun never stands right " +
      "before am, is, are, do, does or a present simple verb, or after the am, is, are, do or does that opens a question " +
      "(Is the sheep eating?), unless a lot of or lots of stands among the three words before it, or the nearest determiner " +
      "or number word among those three words is a number word (a, an, one, this, that, each, every, these, those, many, two " +
      "to ten; One of the fish has the as the nearest one), or the noun is part of a subject joined by and (the cat and the " +
      "fish are): " +
      "otherwise both is and are (eats and eat) are correct. Look! The fish ___ (eat). is wrong; Look! Two fish ___ (eat). → " +
      "are eating is fine. In lesson_order and lesson_transform the tiles or the statement give the form.",
  },
  "grammar.pc_s_contraction": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    description:
      "In the present_continuous topic answers, accepted answers and the correct option never use he's, she's, it's, what's, " +
      "that's, there's, where's or who's: write the full is.",
  },
  "grammar.pc_translation_now_marker": {
    when: inPcForms,
    field: "prompt",
    kind: "reject",
    types: ["lesson_open_answer"],
    description:
      "In the affirmative, negative, questions and ing_spelling objectives the Polish prompt of a translation has a now marker " +
      "(teraz, w tej chwili, Patrz!) and no usually marker." + PC_FORMS_TRANSLATION_GUIDANCE,
  },
  "grammar.pc_translation_key_marker": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    types: ["lesson_open_answer"],
    description:
      "In the present_continuous topic every key of a translation keeps the time marker of the Polish prompt: a prompt with " +
      "teraz, w tej chwili, w tym momencie or a Polish exclamation (Patrz!, Posłuchaj!, Cicho!...) has an English now marker " +
      "(now, right now, at the moment, Look!...), and a prompt with a usually marker (codziennie, zawsze, w poniedziałki...) has " +
      "an English usually marker (every day, always, on Mondays...). Właśnie, akurat and Gdzie jest ...? need no English marker.",
  },
  "grammar.pc_translation_now_variants": {
    when: inPresentContinuous,
    field: "acceptedAnswers",
    kind: "reject",
    types: ["lesson_open_answer"],
    description:
      "In the present_continuous topic, when the answer of a translation has now, right now or at the moment and no " +
      "exclamation such as Look!, acceptedAnswers hold the answer with each of the other two in its place (Ola is reading at the moment. → " +
      "Ola is reading now., Ola is reading right now.; the marker may stand elsewhere in the sentence).",
  },
  "grammar.pc_ing_without_be": {
    when: inTenseChoice,
    field: "answer",
    kind: "reject",
    description: "In the now_or_usually and now_or_usually_more objectives an -ing form in a key is always preceded by am, is or are.",
  },
  "grammar.pc_tense_form_missing": {
    when: inTenseChoice,
    field: "answer",
    kind: "reject",
    description:
      "In the now_or_usually and now_or_usually_more objectives every key is a present simple or present continuous form of a " +
      "verb from the topic's verb table.",
  },
  "grammar.pc_now_usually_stem_marker": {
    when: inPcObjectives("now_or_usually"),
    field: "stem",
    kind: "reject",
    types: ["lesson_choice"],
    description: "In the now / usually meaning check the stem has no time marker: the tense of the sentence alone decides.",
  },
  "grammar.pc_now_usually_instruction": {
    when: inPcObjectives("now_or_usually"),
    field: "instructionPl",
    kind: "reject",
    types: ["lesson_choice"],
    description: "In the now / usually meaning check instructionPl never reveals the answer with a marker or a scene of one group.",
  },
  "grammar.pc_now_usually_stem_shape": {
    when: inPcObjectives("now_or_usually"),
    field: "stem",
    kind: "reject",
    types: ["lesson_choice"],
    description:
      "In the now / usually meaning check the stem is one affirmative sentence in the present simple or the present continuous, " +
      "without a gap, a question or not.",
  },
  "grammar.pc_now_usually_key": {
    when: inPcObjectives("now_or_usually"),
    field: "correctOption",
    kind: "reject",
    types: ["lesson_choice"],
    description: "In the now / usually meaning check the correct option is now for a present continuous stem and usually for a present simple stem.",
  },
  "grammar.pc_tense_choice_gap_question": {
    when: inTenseChoice,
    field: "stem",
    kind: "reject",
    types: ["lesson_choice", "lesson_listen_choice"],
    description:
      "In the now_or_usually and now_or_usually_more objectives a choice never puts the gap in a question: questions appear only " +
      "as whole-sentence options (Do you play...? / Are you playing...?).",
  },
  "grammar.pc_tense_choice_distractor": {
    when: inTenseChoice,
    field: "options",
    kind: "reject",
    types: ["lesson_choice"],
    description:
      "In the now_or_usually and now_or_usually_more objectives no distractor of a lesson_choice fits the time marker and the " +
      "subject as well as the key, and no distractor uses another tense: can, could, will, would, shall, should, must, may, " +
      "might or did + the base form (can read, didn't watch, also in a question: Did Tom swim on Fridays?), was or were + " +
      "-ing, has, have or had + a regular past participle, or a regular past form or read, put, cut, hit (played, read): it " +
      "is a second correct answer.",
  },
  "grammar.pc_choice_distractor_correct": {
    when: inPcObjectives("affirmative", "negative", "questions"),
    field: "options",
    kind: "reject",
    types: ["lesson_choice"],
    description:
      "In the affirmative, negative and questions objectives every distractor of a lesson_choice that is not only am, is or are " +
      "(put into the gap, or the whole sentence) is wrong: a wrong am/is/are, a missing -ing, a present simple form, a usually " +
      "or forbidden marker, the wrong word order (Tom not is watching, Ola reading is, Tom is playing now? or a statement next to " +
      "a question key) or another rule the key keeps. A distractor that is correct too is a second correct answer: another " +
      "verb or object (is drawing next to is reading in Ola ___ now., Look! Tom is reading. next to Look! Ola is reading.), the " +
      "key with only not added or removed when no Yes/No before the gap and no not after it fix the polarity (is reading / " +
      "isn't reading), or another tense that agrees with the subject (can read, will read, did read, was reading, has read, " +
      "played, read).",
  },
  "grammar.pc_distractor_outside_table": {
    when: inPcObjectives("affirmative", "now_or_usually", "negative", "questions", "now_or_usually_more"),
    field: "options",
    kind: "reject",
    types: ["lesson_choice"],
    description:
      "In a lesson_choice of the present_continuous topic (except ing_spelling) a distractor that breaks no rule of the key " +
      "takes its verb from the topic's verb table: with a verb outside the table (is feeding, feeds) it may be a second correct " +
      "answer. A misspelt -ing form of the key's verb (is walkking next to is walking) is a wrong distractor.",
  },
  "grammar.pc_ing_spelling_distractor": {
    when: inPcObjectives("ing_spelling"),
    field: "options",
    kind: "reject",
    types: ["lesson_choice"],
    description:
      "In the ing_spelling objective every distractor of a lesson_choice is the key with its -ing form misspelt (a form outside " +
      "the verb table at most two letters away: is swiming for is swimming); another correct -ing form (is running) or another " +
      "tense is a second correct answer.",
  },
  "grammar.pc_now_or_usually_question": {
    when: inPcObjectives("now_or_usually"),
    field: "exercise",
    kind: "reject",
    description: "In the now_or_usually objective there are no questions: they belong to now_or_usually_more." + PC_NOW_OR_USUALLY_GUIDANCE,
  },
  "grammar.pc_now_or_usually_negative": {
    when: inPcObjectives("now_or_usually"),
    field: "answer",
    kind: "reject",
    description: "In the now_or_usually objective answers are affirmative: negatives belong to now_or_usually_more.",
  },
  "grammar.pc_tense_choice_question_type": {
    when: inPcObjectives("now_or_usually_more"),
    field: "exercise",
    kind: "reject",
    description:
      "In the now_or_usually_more objective questions appear only in lesson_choice and lesson_open_answer." + PC_NOW_OR_USUALLY_MORE_GUIDANCE,
  },
  "grammar.pc_tense_marker_missing": {
    when: inTenseChoice,
    field: "exercise",
    kind: "reject",
    description:
      "In the now_or_usually and now_or_usually_more objectives every exercise, except the now / usually meaning check, has a " +
      "time marker (Look!, every day...) or a Polish scene in instructionPl (Cicho!, codziennie...) in what the child sees before " +
      "answering: the stem, the statement, the prompt or instructionPl. In a stem with a gap only the gap's own clause, other " +
      "parts of its sentence without their own verb and verbless exclamations before it (Look!, Shh!) count, never a sentence or " +
      "clause with its own verb (Tom plays every day. Ola ___ (read).); a marker only in the answer, an accepted answer or one " +
      "option does not count, and the options count only when every option has a marker of the same group. A translation's " +
      "Polish prompt (or a scene in instructionPl) holds the group of its key." + PC_NOW_MARKERS + PC_USUALLY_MARKERS +
      PC_TENSE_CHOICE_GUIDANCE,
  },
  "grammar.pc_tense_markers_mixed": {
    when: inTenseChoice,
    field: "exercise",
    kind: "reject",
    description:
      "In the now_or_usually and now_or_usually_more objectives the markers of one exercise, in every field (also keys and " +
      "options), all belong to one group: now or usually, never both, except the now / usually meaning check.",
  },
  "grammar.pc_tense_marker_mismatch": {
    when: inTenseChoice,
    field: "answer",
    kind: "reject",
    description:
      "In the now_or_usually and now_or_usually_more objectives every verb of a key matches the marker group: present continuous " +
      "with now markers, present simple with usually markers.",
  },
  "grammar.pc_simple_form_subject": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    description:
      "In the present_continuous topic a present simple verb agrees with its subject: -s or does/doesn't for he, she, it or one " +
      "name, the base form or do/don't otherwise.",
  },
  "grammar.pc_simple_base_after_do": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    description: "In the present_continuous topic do or does is followed by the base form of the verb (Does she read?, never Does she reads?).",
  },
  "grammar.pc_error_fix_region": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    types: ["lesson_error_fix"],
    limit: "MAX_ERROR_FIX_REGION_TOKENS",
    description:
      `In the present_continuous topic the statement and every key of a lesson_error_fix differ in one place of at most ${MAX_ERROR_FIX_REGION_TOKENS} ` +
      "words on each side.",
  },
  "grammar.pc_error_fix_kind": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    types: ["lesson_error_fix"],
    description:
      "In the present_continuous topic the difference of a lesson_error_fix is the mistake the objective practises: a missing " +
      "am/is/are, a verb without -ing after am/is/are or a wrong am/is/are; a wrong -ing spelling in ing_spelling; the present " +
      "simple swapped with the present continuous of the same verb in the tense-choice objectives (now_or_usually and " +
      "now_or_usually_more).",
  },
  "grammar.pc_error_fix_do_ing": {
    when: inPresentContinuous,
    field: "statement",
    kind: "reject",
    types: ["lesson_error_fix"],
    description:
      "In the present_continuous topic the statement of a lesson_error_fix never has do or does (also don't, doesn't, do not, " +
      "does not) before an -ing form (Tom doesn't watching TV now., Does she reading?): such a sentence has two correct fixes " +
      "(Tom isn't watching TV now. / Tom doesn't watch TV now.).",
  },
  "grammar.pc_notice_ing_count": {
    when: inPresentContinuous,
    field: "noticeSegments",
    kind: "reject",
    types: ["lesson_notice"],
    description: "In the present_continuous topic the sentences of a lesson_notice have exactly one -ing form in total.",
  },
  "grammar.pc_notice_target": {
    when: inPresentContinuous,
    field: "correctOption",
    kind: "reject",
    types: ["lesson_notice"],
    description: "In the present_continuous topic the correctOption of a lesson_notice is the only -ing form of its sentences.",
  },
  "grammar.pc_transform_statement_question": {
    when: inPresentContinuous,
    field: "statement",
    kind: "reject",
    types: ["lesson_transform"],
    description: "In the present_continuous topic the statement of a to_question transform is not a question.",
  },
  "grammar.pc_transform_question_shape": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    types: ["lesson_transform"],
    description: "In the present_continuous topic every key of a to_question transform is a question that starts with am, is or are and ends with ?.",
  },
  "grammar.pc_transform_question_negative": {
    when: inPresentContinuous,
    field: "statement",
    kind: "reject",
    types: ["lesson_transform"],
    description:
      "In the present_continuous topic the statement of a to_question transform is affirmative: a negative statement has two " +
      "correct questions (Isn't she sleeping? / Is she sleeping?).",
  },
  "grammar.pc_transform_key_statement": {
    when: inPresentContinuous,
    field: "answer",
    kind: "reject",
    types: ["lesson_transform"],
    description:
      "In the present_continuous topic every key of a transform is the statement with only the checked form changed: to_question " +
      "moves am, is or are of the last sentence to its front (Look! Tom is playing now. → Look! Is Tom playing now?, never a " +
      "What question); to_negative adds not right after am, is or are and to_affirmative removes it (Tom is playing right now. ↔ Tom " +
      "isn't playing right now.), in now_or_usually_more also a present simple verb ↔ do/does + not + the base verb; the subject, the " +
      "other words and the time marker stay.",
  },
  "grammar.pc_transform_polarity": {
    when: inPresentContinuous,
    field: "statement",
    kind: "reject",
    types: ["lesson_transform"],
    description:
      "In the present_continuous topic the statement of a to_negative or to_affirmative transform has the opposite polarity " +
      "of the answer.",
  },
  "grammar.pc_listen_choice_options": {
    when: inPresentContinuous,
    field: "options",
    kind: "reject",
    types: ["lesson_listen_choice"],
    description: "In the present_continuous topic the options of a lesson_listen_choice are exactly is / are, isn't / aren't, or Is / Are.",
  },
  "grammar.pc_order_movable_marker": {
    when: inPresentContinuous,
    field: "items",
    kind: "reject",
    types: ["lesson_order"],
    description:
      "In the present_continuous topic the items of a lesson_order never hold a time marker that can stand at the start or at " +
      "the end of the sentence, also split over several items: every now or usually marker except the exclamations (Look!, " +
      "Shh!...) and always and never, which stand only between the subject and the verb. Such a marker gives more than one " +
      "correct order (Tom is reading a book now / Now Tom is reading a book), so the time comes from a Polish scene in " +
      "instructionPl (Cicho! Dziadek śpi. Ułóż zdanie.).",
  },
});

/** Reguła luk Present Simple: walidator sprawdza ją poza tematami „to be” i Present Continuous. */
const presentSimpleGaps = (ctx: RuleBookContext): boolean => ctx.topicId !== TO_BE_TOPIC && ctx.topicId !== PRESENT_CONTINUOUS_TOPIC;

/**
 * Katalog reguł przedmiotu `english_grammar` (`validateExercise`) ze wspólnym
 * fragmentem angielskim i regułami tematu Present Continuous. Opisy po
 * angielsku dla modelu agenta; zgłoszenia składają walidatory przez `grammarIssue`.
 */
export const GRAMMAR_RULES = defineRules({
  ...ENGLISH_RULES,
  ...PRESENT_CONTINUOUS_RULES,
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
    when: presentSimpleGaps,
    types: ["lesson_gap"],
    description:
      "A gap answered with an operator (do, does, don't, doesn't) fits the objective, agrees with the subject near the gap " +
      "and is followed by the base form of the verb.",
  },
  "grammar.gap_present_simple_form": {
    field: "answer",
    kind: "reject",
    when: presentSimpleGaps,
    types: ["lesson_gap"],
    description: "When the hint of a lesson_gap is a verb, the gap answer is a Present Simple form of that verb (base form, third person singular, or with do and does).",
  },
});

/** Fabryka zgłoszeń reguł gramatyki (także `english.*` dzielone z rozdziałem). */
export const grammarIssue = issueFrom(GRAMMAR_RULES);
