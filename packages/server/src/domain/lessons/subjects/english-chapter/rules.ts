import { defineRules, issueFrom } from "../../rules/catalog";
import { MIN_STIMULUS_INSTRUCTION_LENGTH } from "../../rules/limits";
import { ENGLISH_RULES } from "../english/rules";

/**
 * Katalog reguł przedmiotu `english_chapter` (`validateExercise`,
 * `refineGeneratedPool`, bramki agenta) ze wspólnym fragmentem angielskim.
 * Opisy po angielsku dla modelu agenta; liczby wyłącznie ze stałych sprawdzeń.
 */
export const CHAPTER_RULES = defineRules({
  ...ENGLISH_RULES,
  "chapter.stem_single_gap": {
    field: "stem",
    kind: "reject",
    types: ["lesson_choice"],
    description: "The stem of lesson_choice contains exactly one gap written as three underscores.",
  },
  "chapter.instruction_stimulus": {
    field: "instructionPl",
    kind: "reject",
    types: ["lesson_choice", "lesson_gap", "lesson_order", "lesson_cloze"],
    // W ogólnych przeczyłoby kartom typów bez polecenia (wybór ze słuchu): stoi w blokach swoich typów.
    inEachTypeBlock: true,
    description:
      "In lesson_choice, lesson_gap, lesson_order and lesson_cloze, instructionPl carries the Polish stimulus sentence the " +
      "child translates: a Polish sentence followed by the task " +
      `(for example "Dziś pada deszcz. Wybierz słowo."), at least ${MIN_STIMULUS_INSTRUCTION_LENGTH} characters long. ` +
      "A bare generic task such as \"Wybierz słowo\" or \"Uzupełnij tekst\" is not enough.",
    limit: "MIN_STIMULUS_INSTRUCTION_LENGTH",
  },
  "chapter.translation_instruction_required": {
    field: "instructionPl",
    kind: "reject",
    types: ["lesson_open_answer"],
    description: "lesson_open_answer (translation) has an instructionPl telling the child to translate.",
  },
  "chapter.hint_not_allowed": {
    field: "hint",
    kind: "reject",
    description: "Leave hint out: the Polish stimulus sentence belongs to instructionPl, and a hint would be dropped from the quiz gap.",
  },
  "chapter.order_items_distinct": {
    field: "items",
    kind: "reject",
    types: ["lesson_order"],
    description: "Every item of lesson_order has a different text (compared after normalization), so tiles are never interchangeable.",
  },
  "chapter.word_outside_material": {
    field: "exercise",
    kind: "reject",
    description:
      "Every checked element (left side of a pair, group item, cloze gap word or extra word, option, answer) uses only words " +
      "that appear in the parent's material or are function words.",
  },
  "chapter.function_words_only": {
    field: "exercise",
    kind: "reject",
    description: "Every checked element contains at least one content word of the material, not only function words such as the or is.",
  },
  "chapter.card_word_missing": {
    field: "answer",
    kind: "reject",
    types: ["lesson_match", "lesson_group", "lesson_cloze", "lesson_choice", "lesson_listen_choice", "lesson_order", "lesson_gap", "lesson_open_answer"],
    description:
      "In a words objective the checked part of the exercise (gap words, correct option, answer, left sides of pairs, group items) " +
      "contains a word of THIS objective's cards; other words may only fill the sentence. Pairs and groups need two such words.",
  },
  "chapter.frame_missing": {
    field: "answer",
    kind: "reject",
    types: ["lesson_choice", "lesson_cloze", "lesson_order", "lesson_gap", "lesson_open_answer"],
    description:
      "In a frame objective the solved sentence (answer, assembled order tiles or the gap sentence with the answer inserted) " +
      "contains the fixed part of a sentence frame from THIS objective's cards, not a frame of another objective.",
  },
});

/** Fabryka zgłoszeń katalogu rozdziału. */
export const chapterIssue = issueFrom(CHAPTER_RULES);
