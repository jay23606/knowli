import {
  MAX_CALCULATION_DECIMALS,
  MAX_CALCULATION_PARAMETER,
  MAX_CLOZE_EXTRA,
  MAX_CLOZE_GAPS,
  MAX_COMMON_ERRORS,
  MAX_GROUP_ITEMS,
  MAX_GROUPS,
  MAX_KEY_OPTIONS,
  MAX_KEYWORD_OPTIONS,
  MAX_LESSON_TEXT_LENGTH,
  MAX_MATCH_EXTRA,
  MAX_MATCH_PAIRS,
  MAX_OPTIONS,
  MAX_ORDER_ITEMS,
  MAX_REQUIRED_ELEMENTS,
  MAX_SCALE_DENOMINATOR,
  MAX_SOURCE_REFS,
  MAX_SUPPLEMENTARY_ELEMENTS,
  MAX_TEMPLATE_FAMILY_ID_LENGTH,
  MIN_CLOZE_EXTRA,
  MIN_CLOZE_GAPS,
  MIN_GROUP_ITEMS,
  MIN_GROUPS,
  MIN_ITEMS_PER_GROUP,
  MIN_KEY_OPTIONS,
  MIN_KEYWORD_OPTIONS,
  MIN_MATCH_PAIRS,
  MIN_OPTIONS,
  MIN_ORDER_ITEMS,
  MIN_REQUIRED_ELEMENTS,
  MIN_SOURCE_REFS,
} from "@learning/contracts";
import type { LessonExerciseType } from "../types";
import type { LessonRule, RuleCatalog } from "./catalog";
import {
  FEEDBACK_SENTENCE_MAX_LENGTH,
  GAP_MARKER,
  MAX_ACCEPTED_ANSWERS,
  MAX_CLOZE_WORD_TOKENS,
  MAX_GAP_ANSWER_TOKENS,
  MAX_NOTICE_SEGMENTS,
  MAX_NOTICE_SENTENCES,
  MIN_NOTICE_SEGMENTS,
  MIN_NOTICE_SENTENCES,
  MAX_TOLERANCE_PERCENT,
} from "./limits";

/**
 * Katalog reguł rdzenia (spec katalogu reguł §2.2): kontrakt, kształt rekordu
 * agenta (`raw-shape.ts`, `raw-materialize.ts`), pola wspólne i reguły typów z
 * `pool-validation.ts`, rachunki, `explanationPl`.
 *
 * Bez importu wartości z `./catalog` (cykl przez `ENGINE_CATALOGS`): katalog
 * deklaruje się przez `satisfies RuleCatalog`, a id sprawdza `defineRules`
 * przy składaniu `ENGINE_CATALOGS`. Liczby w opisach biorą się ze stałych
 * kontraktu albo `./limits`.
 */

/**
 * Reguła kształtu pola listowego rekordu agenta (wpis `RAW_LIST_FIELDS` w `raw-shape.ts`).
 * `types` i `when` decydują tylko o obecności opisu w księdze reguł.
 */
function listShapeRule(
  field: string,
  items: string,
  scope: { readonly types?: readonly LessonExerciseType[]; readonly when?: LessonRule["when"] } = {},
): LessonRule {
  return {
    field,
    kind: "reject",
    ...scope,
    promptBrief: true,
    description: `${field}, when present, is a list of ${items}; null means the field is absent.`,
  };
}

/** Typy z wyborem z listy opcji. */
const CHOICE_TYPES: readonly LessonExerciseType[] = ["lesson_choice", "lesson_short_answer", "lesson_listen_choice"];

/** Pola v3 pytania otwartego: tylko przedmioty z payloadem v3. */
const V3_OPEN_SCOPE = { types: ["lesson_open_answer"], when: (ctx) => ctx.usesV3Payload } as const satisfies Pick<LessonRule, "types" | "when">;

export const CORE_RULES = {
  // Kontrakt (Zod, spec §4.2). Odstępstwo od tabeli §4.2 (decyzja kontrolera,
  // Task 3): liczności list i długości odpowiedzi, które sprawdza też własna
  // reguła rdzenia, kontrakt zgłasza pod jej id — options → options.count,
  // items → order.items_count, acceptedAnswers → variants.count, noticeSegments →
  // notice.sentence_count, noticeSegments[i] → notice.segment_count, za długie
  // answer i acceptedAnswers[i] → answer.max_length. Jedna granica ma jeden opis
  // dla modelu, a reguła ma osiągalny przypadek naruszenia. Tak samo listy par, grup,
  // luk z bankiem i słów kluczowych (Task 4): pairs → match.pairs_count, extraRight →
  // match.extra_count, groups → group.groups_count, groupItems → group.items_count,
  // gapAnswers → cloze.gap_count, extraWords → cloze.extra_count, keywordOptions →
  // keywords.options_count, keyOptionIds → keywords.key_count. Reszta list i napisów:
  // field.count i field.max_length.
  "field.empty": {
    field: "exercise",
    kind: "reject",
    description:
      "Never send an empty string: a text field that does not apply is null (or left out), and required text fields and " +
      "list entries are never empty.",
  },
  "field.max_length": {
    field: "exercise",
    kind: "reject",
    description:
      `Each text field (instructionPl, stem, statement, prompt, hint, explanationPl, focus words, option and item texts) ` +
      `has at most ${MAX_LESSON_TEXT_LENGTH} characters; other text fields keep the length limits of the tool schema.`,
    limit: "MAX_LESSON_TEXT_LENGTH",
  },
  "field.count": {
    field: "exercise",
    kind: "reject",
    promptBrief: true,
    when: (ctx) => ctx.usesV3Payload,
    description:
      `Lists keep the item counts of the tool schema: requiredElements ${MIN_REQUIRED_ELEMENTS}–${MAX_REQUIRED_ELEMENTS}, ` +
      `supplementaryElements up to ${MAX_SUPPLEMENTARY_ELEMENTS}, commonErrors up to ${MAX_COMMON_ERRORS}, ` +
      `sourceRefs ${MIN_SOURCE_REFS}–${MAX_SOURCE_REFS}.`,
    limit: "MAX_COMMON_ERRORS",
  },
  "field.invalid": {
    field: "exercise",
    kind: "reject",
    promptBrief: true,
    description:
      "Every field has the type and allowed values of the tool schema (enums take only the listed values), and the " +
      "exercise has no fields outside the schema.",
  },

  // Kształt surowego rekordu agenta (`raw-shape.ts`, spec §4.3): przed
  // materializacją i kontraktem, tylko ścieżka agenta. Listy: `RAW_LIST_FIELDS`.
  "shape.record": {
    field: "exercise",
    kind: "reject",
    promptBrief: true,
    description:
      "Each exercise is a JSON object whose exerciseType and objectiveId are strings. Every record names its type in " +
      "exerciseType, also lesson_match, lesson_group, lesson_cloze, lesson_keywords and lesson_calculation, whose answer " +
      "the code computes.",
  },
  "shape.objective_id": {
    field: "objectiveId",
    kind: "reject",
    promptBrief: true,
    description: "Submit only exercises of your own objective: objectiveId is exactly the id of the objective you work on.",
  },
  "shape.answer": {
    field: "answer",
    kind: "reject",
    promptBrief: true,
    description:
      "answer is a string in every exercise type except lesson_calculation, lesson_keywords, lesson_match, lesson_group " +
      "and lesson_cloze, whose answer the code computes.",
  },
  "shape.text_field": {
    field: "exercise",
    kind: "reject",
    promptBrief: true,
    description:
      "Text fields (instructionPl, stem, statement, prompt, hint, transformId, correctOption, clozeText, questionType, " +
      "expectedForm, familyId, visualSubject) are strings, or null when they do not apply.",
  },
  "shape.calculation": {
    field: "calculation",
    kind: "reject",
    promptBrief: true,
    types: ["lesson_calculation"],
    priority: "calculation_shape",
    description: "calculation, when present, is an object {kind, unit, params, templateFamilyId}.",
  },
  "shape.accepted_answers": listShapeRule("acceptedAnswers", "strings"),
  "shape.focus": listShapeRule("focus", "strings"),
  "shape.options": listShapeRule("options", "objects {id, text}", { types: CHOICE_TYPES }),
  "shape.items": listShapeRule("items", "objects {id, text}", { types: ["lesson_order"] }),
  "shape.keyword_options": listShapeRule("keywordOptions", "objects {id, text}", { types: ["lesson_keywords"] }),
  "shape.key_option_ids": listShapeRule("keyOptionIds", "strings", { types: ["lesson_keywords"] }),
  "shape.notice_segments": listShapeRule("noticeSegments", "lists of strings", { types: ["lesson_notice"] }),
  "shape.pairs": listShapeRule("pairs", "objects {left, right}", { types: ["lesson_match"] }),
  "shape.extra_right": listShapeRule("extraRight", "strings", { types: ["lesson_match"] }),
  "shape.groups": listShapeRule("groups", "objects {id, label}", { types: ["lesson_group"] }),
  "shape.group_items": listShapeRule("groupItems", "objects {text, groupId}", { types: ["lesson_group"] }),
  "shape.gap_answers": listShapeRule("gapAnswers", "strings", { types: ["lesson_cloze"] }),
  "shape.extra_words": listShapeRule("extraWords", "strings", { types: ["lesson_cloze"] }),
  "shape.required_elements": listShapeRule("requiredElements", "objects {id, text}", V3_OPEN_SCOPE),
  "shape.supplementary_elements": listShapeRule("supplementaryElements", "strings", V3_OPEN_SCOPE),
  "shape.common_errors": listShapeRule("commonErrors", "strings", V3_OPEN_SCOPE),
  "shape.source_refs": listShapeRule("sourceRefs", "objects {quote}", { when: (ctx) => ctx.text.groundingRequired }),

  // Ćwiczenie jako całość.
  "exercise.card_not_allowed": {
    field: "exerciseType",
    kind: "reject",
    promptBrief: true,
    description: "Never submit lesson_card: cards come from the topic, not from the exercise pool.",
    fixedMessage: true,
  },
  "exercise.unknown_objective": {
    field: "objectiveId",
    kind: "reject",
    promptBrief: true,
    description: "objectiveId is the id of an objective of the topic, copied exactly.",
  },
  "exercise.type_unsupported": {
    field: "exerciseType",
    kind: "reject",
    promptBrief: true,
    description: "exerciseType is one of the exercise types of the subject.",
  },
  "exercise.type_not_allowed": {
    field: "exerciseType",
    kind: "reject",
    promptBrief: true,
    description: "exerciseType is one of the types allowed for the objective of the exercise.",
  },
  "exercise.v3_field_not_allowed": {
    field: "exercise",
    kind: "reject",
    when: (ctx) => !ctx.usesV3Payload,
    description:
      "Subjects without the extended payload leave out questionType, requiredElements, supplementaryElements, " +
      "commonErrors, expectedForm, familyId, sourceRefs and calculation.",
  },
  "answer.max_length": {
    field: "answer",
    kind: "reject",
    description: (ctx) => `answer and every acceptedAnswers variant have at most ${ctx.answerMaxLength} characters.`,
    limit: "MAX_TEXT_LENGTH",
  },
  "voice_tone.not_allowed": {
    field: "voiceTone",
    kind: "reject",
    promptBrief: true,
    // Przedmiot z nagraniami pytań łamie regułę tylko tonem rachunku.
    when: (ctx) => !ctx.voiceTones || ctx.exerciseTypes.includes("lesson_calculation"),
    description: "voiceTone is set only in subjects that record questions, and never on lesson_calculation.",
  },

  // Wyjaśnienie błędu (`explanationPl`): agent dostaje ćwiczenie bez pola i notę.
  "explanation.not_allowed": {
    field: "explanationPl",
    kind: "sanitize",
    promptBrief: true,
    when: (ctx) => !ctx.exerciseExplanations,
    description: "explanationPl is set only in subjects that show error explanations; elsewhere leave it out.",
  },
  "explanation.empty": {
    field: "explanationPl",
    kind: "sanitize",
    when: (ctx) => ctx.exerciseExplanations,
    description: "explanationPl, when set, is not blank.",
  },
  "explanation.max_length": {
    field: "explanationPl",
    kind: "sanitize",
    when: (ctx) => ctx.exerciseExplanations,
    description: `explanationPl has at most ${MAX_LESSON_TEXT_LENGTH} characters after trimming.`,
    limit: "MAX_LESSON_TEXT_LENGTH",
  },
  "explanation.line_break": {
    field: "explanationPl",
    kind: "sanitize",
    when: (ctx) => ctx.exerciseExplanations,
    description: "explanationPl is a single line without line breaks.",
  },
  "explanation.markup": {
    field: "explanationPl",
    kind: "sanitize",
    when: (ctx) => ctx.exerciseExplanations,
    description: "explanationPl is plain text without the markup characters * and _.",
  },
  "explanation.one_sentence": {
    field: "explanationPl",
    kind: "sanitize",
    when: (ctx) => ctx.exerciseExplanations,
    description: "explanationPl is exactly one sentence.",
  },

  // Pola wspólne.
  "fields.type_specific": {
    field: "exercise",
    kind: "reject",
    promptBrief: true,
    description:
      "Type-specific fields stay on their type: calculation on lesson_calculation, keywordOptions and keyOptionIds on " +
      "lesson_keywords, pairs and extraRight on lesson_match, groups and groupItems on lesson_group, clozeText, " +
      "gapAnswers and extraWords on lesson_cloze.",
  },
  "visual.choice_only": {
    field: "visualSubject",
    kind: "reject",
    promptBrief: true,
    description: "visualSubject (a pictogram of the person or animal) is used only with lesson_choice.",
  },
  "focus.empty": {
    field: "focus",
    kind: "reject",
    promptBrief: true,
    types: ["lesson_gap", "lesson_error_fix", "lesson_transform", "lesson_open_answer"],
    description: "Free-text types (lesson_gap, lesson_error_fix, lesson_transform, lesson_open_answer) list the checked words of the answer in focus.",
  },
  "focus.not_contiguous": {
    field: "focus",
    kind: "reject",
    types: ["lesson_gap", "lesson_error_fix", "lesson_transform", "lesson_open_answer"],
    description: "focus is a contiguous run of words of the answer, in the same order.",
  },
  "variants.count": {
    field: "acceptedAnswers",
    kind: "reject",
    promptBrief: true,
    description: `acceptedAnswers has at most ${MAX_ACCEPTED_ANSWERS} variants.`,
    limit: "MAX_ACCEPTED_ANSWERS",
  },
  "variants.empty": {
    field: "acceptedAnswers",
    kind: "reject",
    promptBrief: true,
    description: "No acceptedAnswers variant is blank.",
  },
  "variants.duplicate": {
    field: "acceptedAnswers",
    kind: "reject",
    description:
      "No acceptedAnswers variant equals the answer after normalization: the answer itself is always accepted, so never " +
      "list it again as a variant.",
  },
  "computed.no_variants": {
    field: "acceptedAnswers",
    kind: "internal",
    types: ["lesson_match", "lesson_group", "lesson_cloze"],
    description: "Pairs, groups and cloze with a word bank are graded by assignments, so acceptedAnswers and focus stay empty.",
    internalReason:
      "Materialization of lesson_match, lesson_group and lesson_cloze sets acceptedAnswers and focus to empty lists; the agent does not send them.",
  },

  // Typy z wyborem.
  "choice.stem_required": {
    field: "stem",
    kind: "reject",
    promptBrief: true,
    types: ["lesson_choice"],
    description: "lesson_choice has the sentence or question in stem.",
  },
  "short_answer.prompt_required": {
    field: "prompt",
    kind: "reject",
    promptBrief: true,
    types: ["lesson_short_answer"],
    description: "lesson_short_answer has the question in prompt (or in stem).",
  },
  "options.count": {
    field: "options",
    kind: "reject",
    types: CHOICE_TYPES,
    description: `Choice exercises (lesson_choice, lesson_short_answer, lesson_listen_choice) have ${MIN_OPTIONS}–${MAX_OPTIONS} options.`,
    limit: "MAX_OPTIONS",
  },
  "options.duplicate": {
    field: "options",
    kind: "reject",
    types: CHOICE_TYPES,
    description: "Option texts are distinct after normalization.",
  },
  "options.correct_unknown": {
    field: "correctOption",
    kind: "reject",
    promptBrief: true,
    types: CHOICE_TYPES,
    description: "correctOption is the id of one of the options.",
  },

  // Wybór ze słuchu.
  "listen.instruction_not_allowed": {
    field: "instructionPl",
    kind: "reject",
    types: ["lesson_listen_choice"],
    description: "lesson_listen_choice has a fixed instruction, so instructionPl is left out.",
  },
  "listen.hint_not_allowed": {
    field: "hint",
    kind: "reject",
    promptBrief: true,
    types: ["lesson_listen_choice"],
    description: "lesson_listen_choice has no hint, because the child hears the sentence and a hint would give the answer away.",
  },
  "listen.gap_count": {
    field: "stem",
    kind: "reject",
    types: ["lesson_listen_choice"],
    description: "The stem of lesson_listen_choice has exactly one gap written as a run of underscores (at least two).",
  },
  "listen.option_apostrophe": {
    field: "options",
    kind: "reject",
    types: ["lesson_listen_choice"],
    description: "Options of lesson_listen_choice are whole words: none starts with an apostrophe.",
  },
  "listen.options_equivalent": {
    field: "options",
    kind: "reject",
    types: ["lesson_listen_choice"],
    description:
      "Each option of lesson_listen_choice put into the gap gives a sentence that is not equivalent to the sentence of " +
      "another option after normalization (doesn't and does not count as the same).",
  },
  "listen.sentence_length": {
    field: "stem",
    kind: "reject",
    types: ["lesson_listen_choice"],
    description:
      `The stem of lesson_listen_choice with the correct option in the gap is a non-empty sentence of at most ` +
      `${FEEDBACK_SENTENCE_MAX_LENGTH} characters, because it is recorded.`,
    limit: "FEEDBACK_SENTENCE_MAX_LENGTH",
  },

  // Wskazanie słowa (`lesson_notice`).
  "notice.options_not_allowed": {
    field: "options",
    kind: "reject",
    types: ["lesson_notice"],
    description: "lesson_notice has no options: the child points at a word in the sentences.",
  },
  "notice.segments_required": {
    field: "noticeSegments",
    kind: "reject",
    promptBrief: true,
    types: ["lesson_notice"],
    description: "lesson_notice carries its sentences, split into word segments, in noticeSegments.",
  },
  "notice.sentence_count": {
    field: "noticeSegments",
    kind: "reject",
    types: ["lesson_notice"],
    description: `noticeSegments of lesson_notice has ${MIN_NOTICE_SENTENCES}–${MAX_NOTICE_SENTENCES} sentences.`,
    limit: "MAX_NOTICE_SENTENCES",
  },
  "notice.segment_count": {
    field: "noticeSegments",
    kind: "reject",
    types: ["lesson_notice"],
    description: `Each sentence in noticeSegments has ${MIN_NOTICE_SEGMENTS}–${MAX_NOTICE_SEGMENTS} segments.`,
    limit: "MAX_NOTICE_SEGMENTS",
  },
  "notice.segment_empty": {
    field: "noticeSegments",
    kind: "reject",
    types: ["lesson_notice"],
    description: "No segment in noticeSegments is blank.",
  },
  "notice.correct_required": {
    field: "correctOption",
    kind: "reject",
    promptBrief: true,
    types: ["lesson_notice"],
    description: "correctOption of lesson_notice is the word the child points at.",
  },
  "notice.correct_not_segment": {
    field: "correctOption",
    kind: "reject",
    types: ["lesson_notice"],
    description: "correctOption of lesson_notice equals one of the segments of the sentences after normalization.",
  },

  // Kolejność (`lesson_order`).
  "order.items_count": {
    field: "items",
    kind: "reject",
    types: ["lesson_order"],
    description: `lesson_order has ${MIN_ORDER_ITEMS}–${MAX_ORDER_ITEMS} items.`,
    limit: "MIN_ORDER_ITEMS",
  },
  "order.items_join": {
    field: "items",
    kind: "reject",
    promptBrief: true,
    types: ["lesson_order"],
    description: "The items of lesson_order joined with spaces in their order give the answer (after normalization).",
  },

  // Typy tekstowe.
  "gap.marker_count": {
    field: "stem",
    kind: "reject",
    types: ["lesson_gap"],
    description: `The stem of lesson_gap has exactly one gap marker ${GAP_MARKER}.`,
  },
  "gap.answer_tokens": {
    field: "answer",
    kind: "reject",
    types: ["lesson_gap"],
    description: `The answer of lesson_gap has at most ${MAX_GAP_ANSWER_TOKENS} words.`,
    limit: "MAX_GAP_ANSWER_TOKENS",
  },
  "gap.focus": {
    field: "focus",
    kind: "reject",
    types: ["lesson_gap"],
    description: "In lesson_gap the words of focus and of the gap answer cover each other: all words of one appear in the other.",
  },
  "error_fix.statement_required": {
    field: "statement",
    kind: "reject",
    promptBrief: true,
    types: ["lesson_error_fix"],
    description: "lesson_error_fix has the sentence with the mistake in statement.",
  },
  "error_fix.same_as_answer": {
    field: "statement",
    kind: "reject",
    types: ["lesson_error_fix"],
    description: "The statement of lesson_error_fix differs from the corrected answer after normalization.",
  },
  "transform.statement_required": {
    field: "statement",
    kind: "reject",
    promptBrief: true,
    types: ["lesson_transform"],
    description: "lesson_transform has the sentence to transform in statement.",
  },
  "transform.unknown": {
    field: "transformId",
    kind: "reject",
    types: ["lesson_transform"],
    description: "transformId of lesson_transform is the id of one of the transforms of the topic.",
  },
  "open.prompt_required": {
    field: "prompt",
    kind: "reject",
    promptBrief: true,
    types: ["lesson_open_answer"],
    description: "lesson_open_answer has the question in prompt.",
  },

  // Słowa kluczowe (`lesson_keywords`).
  "keywords.options_count": {
    field: "keywordOptions",
    kind: "reject",
    types: ["lesson_keywords"],
    description: `lesson_keywords has ${MIN_KEYWORD_OPTIONS}–${MAX_KEYWORD_OPTIONS} keywordOptions.`,
    limit: "MAX_KEYWORD_OPTIONS",
  },
  "keywords.option_ids_unique": {
    field: "keywordOptions",
    kind: "reject",
    promptBrief: true,
    types: ["lesson_keywords"],
    description: "The ids of keywordOptions are unique.",
  },
  "keywords.option_duplicate": {
    field: "keywordOptions",
    kind: "reject",
    types: ["lesson_keywords"],
    description: "No two keywordOptions have equivalent texts after normalization.",
  },
  "keywords.key_count": {
    field: "keyOptionIds",
    kind: "reject",
    types: ["lesson_keywords"],
    description: `keyOptionIds lists ${MIN_KEY_OPTIONS}–${MAX_KEY_OPTIONS} key terms.`,
    limit: "MAX_KEY_OPTIONS",
  },
  "keywords.key_repeated": {
    field: "keyOptionIds",
    kind: "reject",
    promptBrief: true,
    types: ["lesson_keywords"],
    description: "No id repeats in keyOptionIds.",
  },
  "keywords.key_unknown": {
    field: "keyOptionIds",
    kind: "reject",
    promptBrief: true,
    types: ["lesson_keywords"],
    description: "Every id in keyOptionIds is the id of one of the keywordOptions.",
  },
  "keywords.distractor_required": {
    field: "keywordOptions",
    kind: "internal",
    types: ["lesson_keywords"],
    description: "At least one of the keywordOptions is a distractor that keyOptionIds does not list.",
    internalReason:
      "Unreachable behind the contract: keywordOptions has more entries than keyOptionIds may list, so a distractor always remains; the check is a safeguard.",
  },
  "keywords.answer_computed": {
    field: "answer",
    kind: "internal",
    types: ["lesson_keywords"],
    description: "The answer of lesson_keywords is the key terms joined with a comma, in the order of keyOptionIds.",
    internalReason: "Materialization of lesson_keywords computes the answer from keyOptionIds; the agent does not send it.",
  },

  // Pary (`lesson_match`).
  "match.pairs_count": {
    field: "pairs",
    kind: "reject",
    types: ["lesson_match"],
    description: `lesson_match has ${MIN_MATCH_PAIRS}–${MAX_MATCH_PAIRS} pairs.`,
    limit: "MAX_MATCH_PAIRS",
  },
  "match.extra_count": {
    field: "extraRight",
    kind: "reject",
    types: ["lesson_match"],
    description: `extraRight of lesson_match has at most ${MAX_MATCH_EXTRA} distractors.`,
    limit: "MAX_MATCH_EXTRA",
  },
  "match.confusable": {
    field: "pairs",
    kind: "reject",
    types: ["lesson_match"],
    description:
      "On each side of lesson_match (the left texts; the right texts together with extraRight) no text repeats another " +
      "or contains it as whole words, so the child can tell them apart.",
  },
  "match.answer_computed": {
    field: "answer",
    kind: "internal",
    types: ["lesson_match"],
    description: "The answer of lesson_match is the left texts of the pairs joined with a comma.",
    internalReason: "Materialization of lesson_match computes the answer from pairs; the agent does not send it.",
  },

  // Grupy (`lesson_group`).
  "group.groups_count": {
    field: "groups",
    kind: "reject",
    types: ["lesson_group"],
    description: `lesson_group has ${MIN_GROUPS}–${MAX_GROUPS} groups.`,
    limit: "MAX_GROUPS",
  },
  "group.items_count": {
    field: "groupItems",
    kind: "reject",
    types: ["lesson_group"],
    description: `lesson_group has ${MIN_GROUP_ITEMS}–${MAX_GROUP_ITEMS} groupItems.`,
    limit: "MAX_GROUP_ITEMS",
  },
  "group.ids_unique": {
    field: "groups",
    kind: "reject",
    promptBrief: true,
    types: ["lesson_group"],
    description: "The ids of groups are unique.",
  },
  "group.item_unknown_group": {
    field: "groupItems",
    kind: "reject",
    promptBrief: true,
    types: ["lesson_group"],
    description: "The groupId of every item in groupItems is the id of one of the groups.",
  },
  "group.items_per_group": {
    field: "groupItems",
    kind: "reject",
    types: ["lesson_group"],
    description: `Each group of lesson_group has at least ${MIN_ITEMS_PER_GROUP} items in groupItems.`,
    limit: "MIN_ITEMS_PER_GROUP",
  },
  "group.label_confusable": {
    field: "groups",
    kind: "reject",
    types: ["lesson_group"],
    description: "No group label repeats another label or contains it as whole words.",
  },
  "group.item_repeated": {
    field: "groupItems",
    kind: "reject",
    types: ["lesson_group"],
    description: "No text in groupItems repeats another item text (letter case and spacing ignored).",
  },
  "group.item_is_label": {
    field: "groupItems",
    kind: "reject",
    types: ["lesson_group"],
    description: "No text in groupItems is the label of a group.",
  },
  "group.answer_computed": {
    field: "answer",
    kind: "internal",
    types: ["lesson_group"],
    description: "The answer of lesson_group is the group labels joined with a slash.",
    internalReason: "Materialization of lesson_group computes the answer from groups; the agent does not send it.",
  },

  // Tekst z lukami i bankiem słów (`lesson_cloze`).
  "cloze.text_required": {
    field: "clozeText",
    kind: "reject",
    promptBrief: true,
    types: ["lesson_cloze"],
    description: "lesson_cloze carries its text with gaps in clozeText.",
  },
  "cloze.gap_count": {
    field: "clozeText",
    kind: "reject",
    types: ["lesson_cloze"],
    description: `clozeText has ${MIN_CLOZE_GAPS}–${MAX_CLOZE_GAPS} gaps, each written as ${GAP_MARKER}.`,
    limit: "MAX_CLOZE_GAPS",
  },
  "cloze.answers_count": {
    field: "gapAnswers",
    kind: "reject",
    promptBrief: true,
    types: ["lesson_cloze"],
    description: "gapAnswers has exactly one word for each gap of clozeText, in text order.",
  },
  "cloze.extra_count": {
    field: "extraWords",
    kind: "reject",
    types: ["lesson_cloze"],
    description: `extraWords has ${MIN_CLOZE_EXTRA}–${MAX_CLOZE_EXTRA} distractor words for the word bank.`,
    limit: "MAX_CLOZE_EXTRA",
  },
  "cloze.words_between_gaps": {
    field: "clozeText",
    kind: "reject",
    types: ["lesson_cloze"],
    description: "At least one word stands between two gaps of clozeText.",
  },
  "cloze.underscore_outside_gap": {
    field: "clozeText",
    kind: "reject",
    promptBrief: true,
    types: ["lesson_cloze"],
    description: "clozeText has no underscore outside the gap markers.",
  },
  "cloze.bank_word_empty": {
    field: "gapAnswers",
    kind: "reject",
    promptBrief: true,
    types: ["lesson_cloze"],
    description: "Each entry of the word bank (gapAnswers and extraWords) contains a letter or a digit.",
  },
  "cloze.bank_word_tokens": {
    field: "gapAnswers",
    kind: "reject",
    types: ["lesson_cloze"],
    description: `Each entry of gapAnswers and extraWords is at most ${MAX_CLOZE_WORD_TOKENS} words long.`,
    limit: "MAX_CLOZE_WORD_TOKENS",
  },
  "cloze.bank_confusable": {
    field: "gapAnswers",
    kind: "reject",
    types: ["lesson_cloze"],
    description: "No word of the bank repeats another bank word or contains it as whole words.",
  },
  "cloze.bank_outside_gap": {
    field: "clozeText",
    kind: "reject",
    types: ["lesson_cloze"],
    description:
      "No word of the bank appears in clozeText outside the gaps, so the text neither gives away nor rules out a bank word.",
  },
  "cloze.answer_computed": {
    field: "answer",
    kind: "internal",
    types: ["lesson_cloze"],
    description: "The answer of lesson_cloze is the gap words joined with a comma.",
    internalReason: "Materialization of lesson_cloze computes the answer from gapAnswers; the agent does not send it.",
  },

  // Specyfikacja rachunku (`calculationIssues` w `calculation.ts`). Wynik, polecenie,
  // brak parametrów i rodzinę rachunków sprawdzają reguły szkoły (`school.calculation_*`).
  "calculation.tolerance": {
    field: "calculation.tolerance",
    kind: "reject",
    types: ["lesson_calculation"],
    priority: "calculation_shape",
    description:
      "Leave calculation.tolerance out or set it to zero, because the code computes the exact result; " +
      `a non-zero tolerance is at most ${MAX_TOLERANCE_PERCENT}% of the absolute result.`,
    limit: "MAX_TOLERANCE_SHARE",
  },
  "calculation.family_slug": {
    field: "calculation.templateFamilyId",
    kind: "reject",
    types: ["lesson_calculation"],
    priority: "calculation_shape",
    description:
      `calculation.templateFamilyId is lowercase letters and digits joined by single hyphens, at most ${MAX_TEMPLATE_FAMILY_ID_LENGTH} ` +
      "characters (e.g. scale-distance-km), even though calculation kinds use underscores.",
  },
  "calculation.params": {
    field: "calculation.params",
    kind: "reject",
    types: ["lesson_calculation"],
    priority: "calculation_shape",
    description:
      "calculation.kind is scale_distance, height_difference or unit_conversion and unit is cm, m or km; params holds the " +
      `numbers of the kind: scaleDenominator (a positive whole number up to ${MAX_SCALE_DENOMINATOR}) and mapDistanceCm, ` +
      "upperHeightM not below lowerHeightM, or value and fromUnit. Numbers have at most " +
      `${MAX_CALCULATION_DECIMALS} decimal places and lie within ±${MAX_CALCULATION_PARAMETER}; distances and values are not negative.`,
  },
  "calculation.unknown_key": {
    field: "calculation",
    kind: "reject",
    promptBrief: true,
    types: ["lesson_calculation"],
    priority: "calculation_shape",
    description:
      "calculation has only the keys kind, unit, params, templateFamilyId and tolerance, and params only the parameters of its kind.",
  },
} as const satisfies RuleCatalog;
