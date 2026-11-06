import {
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
  MIN_ORDER_ITEMS,
  type CalculationSpec,
} from "@learning/contracts";
import { calculationIssues } from "../calculation";
import { clozeAnswer } from "../cloze";
import { explanationIssues } from "../exercise-explanation";
import { groupAnswer, keywordsAnswer, matchAnswer, validateLessonExerciseIssues } from "../pool-validation";
import { historyLikeSubject } from "../testing/history-like-subject";
import { registerRuleCases } from "../testing/rule-cases";
import type { LearningObjective, LessonExerciseDraft, LessonExerciseType, LessonTopic, SubjectModule } from "../types";
import {
  FEEDBACK_SENTENCE_MAX_LENGTH,
  MAX_ACCEPTED_ANSWERS,
  MAX_CLOZE_WORD_TOKENS,
  MAX_GAP_ANSWER_TOKENS,
  MAX_NOTICE_SEGMENTS,
  MAX_NOTICE_SENTENCES,
  MAX_TOLERANCE_SHARE,
} from "./limits";

/**
 * Przypadki reguł katalogu rdzenia (`core-rules.ts`) dla testu kompletności
 * `rule-cases.test.ts`. Każdy przypadek woła prawdziwy
 * `validateLessonExerciseIssues` (albo `explanationIssues`, gdy kontrakt nie
 * dopuszcza danych łamiących regułę, i `calculationIssues` dla specyfikacji
 * rachunku) na przedmiocie testowym bez reguł
 * własnych: silnik nie importuje przedmiotów produkcyjnych.
 */

const ALL_TYPES: readonly LessonExerciseType[] = [
  "lesson_card",
  "lesson_notice",
  "lesson_choice",
  "lesson_order",
  "lesson_short_answer",
  "lesson_gap",
  "lesson_error_fix",
  "lesson_transform",
  "lesson_open_answer",
  "lesson_calculation",
  "lesson_keywords",
  "lesson_match",
  "lesson_group",
  "lesson_cloze",
  "lesson_listen_choice",
];

const OBJECTIVE_ID = "core_cases.topic.any";
const GAP_ONLY_OBJECTIVE_ID = "core_cases.topic.gap_only";

function objective(id: string, exerciseTypes: readonly LessonExerciseType[]): LearningObjective {
  return {
    id,
    titlePl: "Cel testowy",
    descriptionEn: "Test objective.",
    cards: [{ title: "Karta", body: "Treść." }, { title: "Druga", body: "Treść." }],
    errorCategories: ["wrong_date"],
    hints: { wrong_date: "Sprawdź." },
    exerciseTypes,
  };
}

const topic: LessonTopic = {
  id: "core_cases",
  version: 1,
  titlePl: "Temat testowy",
  extraErrorCategories: [],
  transforms: [{ id: "negate", instructionPl: "Zaprzecz." }],
  objectives: [objective(OBJECTIVE_ID, ALL_TYPES), objective(GAP_ONLY_OBJECTIVE_ID, ["lesson_gap"])],
};

/** Przedmiot bez payloadu v3, nagrań pytań i wyjaśnień błędu. */
const plainSubject: SubjectModule = {
  ...historyLikeSubject,
  exerciseTypes: ALL_TYPES,
  topics: [topic],
  usesV3Payload: false,
  ttsForPrompts: false,
  exerciseExplanations: false,
  validateExercise: () => [],
};

/** Przedmiot z payloadem v3, nagraniami pytań i wyjaśnieniami błędu. */
const richSubject: SubjectModule = { ...plainSubject, usesV3Payload: true, ttsForPrompts: true, exerciseExplanations: true };

const check = (draft: LessonExerciseDraft, subject: SubjectModule = plainSubject) => () =>
  validateLessonExerciseIssues(draft, subject, topic);

function gap(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_gap",
    objectiveId: OBJECTIVE_ID,
    stem: "She ___ tennis.",
    answer: "plays",
    acceptedAnswers: [],
    focus: ["plays"],
    ...overrides,
  };
}

function choice(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_choice",
    objectiveId: OBJECTIVE_ID,
    stem: "She ___ tennis.",
    options: [{ id: "a", text: "plays" }, { id: "b", text: "play" }],
    correctOption: "a",
    answer: "plays",
    acceptedAnswers: [],
    focus: [],
    ...overrides,
  };
}

function listen(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return choice({ exerciseType: "lesson_listen_choice", ...overrides });
}

function shortAnswer(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return choice({ exerciseType: "lesson_short_answer", stem: undefined, prompt: "What does she do?", ...overrides });
}

function notice(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_notice",
    objectiveId: OBJECTIVE_ID,
    noticeSegments: [["She", "plays"], ["He", "runs"]],
    correctOption: "plays",
    answer: "plays",
    acceptedAnswers: [],
    focus: [],
    ...overrides,
  };
}

function order(itemTexts: readonly string[], answer = itemTexts.join(" ")): LessonExerciseDraft {
  return {
    exerciseType: "lesson_order",
    objectiveId: OBJECTIVE_ID,
    items: itemTexts.map((text, index) => ({ id: `i${index}`, text })),
    answer,
    acceptedAnswers: [],
    focus: [],
  };
}

function errorFix(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_error_fix",
    objectiveId: OBJECTIVE_ID,
    statement: "She play tennis.",
    answer: "She plays tennis.",
    acceptedAnswers: [],
    focus: ["plays"],
    ...overrides,
  };
}

function transform(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_transform",
    objectiveId: OBJECTIVE_ID,
    statement: "She plays.",
    transformId: "negate",
    answer: "She does not play.",
    acceptedAnswers: [],
    focus: ["does", "not"],
    ...overrides,
  };
}

function open(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_open_answer",
    objectiveId: OBJECTIVE_ID,
    prompt: "Co wytwarza roślina?",
    answer: "Roślina wytwarza cukry.",
    acceptedAnswers: [],
    focus: ["wytwarza", "cukry"],
    ...overrides,
  };
}

/** Odpowiedź ze słów „ab” o długości `length` znaków (focus „ab” pozostaje ciągły). */
function wordyAnswer(length: number): string {
  return `${"ab ".repeat(Math.floor((length - 2) / 3))}${"a".repeat(2 + ((length - 2) % 3))}`;
}

/** `lesson_match` z odpowiedzią liczoną z par (jak materializacja). */
function match(pairs: readonly { left: string; right: string }[], extraRight?: readonly string[]): LessonExerciseDraft {
  return {
    exerciseType: "lesson_match",
    objectiveId: OBJECTIVE_ID,
    pairs: [...pairs],
    ...(extraRight === undefined ? {} : { extraRight: [...extraRight] }),
    answer: matchAnswer({ pairs: [...pairs] }) || "-",
    acceptedAnswers: [],
    focus: [],
  };
}

const RIVERS = [
  { left: "Wisła", right: "rzeka" },
  { left: "Rysy", right: "szczyt" },
  { left: "Kraków", right: "miasto" },
];

/** `n` par o rozróżnialnych tekstach. */
const pairsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ left: `lewy${i}`, right: `prawy${i}` }));

/** `lesson_group` z odpowiedzią liczoną z grup. */
function group(
  groups: readonly { id: string; label: string }[],
  groupItems: readonly { text: string; groupId: string }[],
): LessonExerciseDraft {
  return {
    exerciseType: "lesson_group",
    objectiveId: OBJECTIVE_ID,
    groups: [...groups],
    groupItems: [...groupItems],
    answer: groupAnswer({ groups: [...groups] }) || "-",
    acceptedAnswers: [],
    focus: [],
  };
}

const ANIMAL_GROUPS = [{ id: "g1", label: "Ssaki" }, { id: "g2", label: "Ptaki" }];
const ANIMALS = [
  { text: "Pies", groupId: "g1" },
  { text: "Kot", groupId: "g1" },
  { text: "Wróbel", groupId: "g2" },
  { text: "Sowa", groupId: "g2" },
];

/** `n` grup po dwa elementy. */
function groupsOf(n: number): LessonExerciseDraft {
  const groups = Array.from({ length: n }, (_, i) => ({ id: `g${i}`, label: `grupa${i}` }));
  return group(groups, groups.flatMap((g) => [{ text: `${g.id}a`, groupId: g.id }, { text: `${g.id}b`, groupId: g.id }]));
}

/** `n` elementów rozłożonych na dwie grupy zwierząt. */
const animalsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `zwierzę${i}`, groupId: i % 2 === 0 ? "g1" : "g2" }));

/** `lesson_cloze` z odpowiedzią liczoną ze słów luk. */
function cloze(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  const draft: LessonExerciseDraft = {
    exerciseType: "lesson_cloze",
    objectiveId: OBJECTIVE_ID,
    clozeText: "Roślina pobiera ___ z gleby i ___ z powietrza.",
    gapAnswers: ["wodę", "dwutlenek węgla"],
    extraWords: ["tlen"],
    answer: "",
    acceptedAnswers: [],
    focus: [],
    ...overrides,
  };
  return { ...draft, answer: overrides.answer ?? (clozeAnswer(draft) || "-") };
}

/** Tekst z `gaps` lukami rozdzielonymi słowami i `answers` słów luk. */
function clozeWithGaps(gaps: number, answers = gaps): LessonExerciseDraft {
  return cloze({
    clozeText: `${Array.from({ length: gaps }, (_, i) => `słowo${i} ___`).join(" ")} koniec.`,
    gapAnswers: Array.from({ length: answers }, (_, i) => `luka${i}`),
  });
}

/** `lesson_keywords` z odpowiedzią liczoną z pojęć kluczowych. */
function keywords(
  keywordOptions: readonly { id: string; text: string }[] | undefined,
  keyOptionIds: readonly string[] | undefined,
): LessonExerciseDraft {
  const fields = {
    ...(keywordOptions === undefined ? {} : { keywordOptions: [...keywordOptions] }),
    ...(keyOptionIds === undefined ? {} : { keyOptionIds: [...keyOptionIds] }),
  };
  return {
    exerciseType: "lesson_keywords",
    objectiveId: OBJECTIVE_ID,
    ...fields,
    answer: keywordsAnswer(fields) || "-",
    acceptedAnswers: [],
    focus: [],
  };
}

const TERMS = [
  { id: "k1", text: "fotosynteza" },
  { id: "k2", text: "chlorofil" },
  { id: "k3", text: "korzeń" },
  { id: "k4", text: "kwiat" },
];

/** `n` pojęć o rozróżnialnych tekstach. */
const termsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, text: `pojęcie${i}` }));

/** Specyfikacja rachunku: 3 cm w skali 1:25 000 = 750 m. */
const scale: CalculationSpec = {
  kind: "scale_distance",
  params: { scaleDenominator: 25000, mapDistanceCm: 3 },
  unit: "m",
  templateFamilyId: "map-scale",
};

/** Tolerancja dokładnie na granicy dla wyniku `scale` (750 m). */
const SCALE_TOLERANCE_LIMIT = 750 / MAX_TOLERANCE_SHARE;

/** Zdanie z jedną luką: `head` liter, spacja, luka, kropka. */
const longListenStem = `${"A".repeat(100)} ___.`;
/** Opcja tak długa, że zdanie z nią ma dokładnie `length` znaków. */
const listenOptionFor = (length: number) => "b".repeat(length - 102);

registerRuleCases([
  // Kontrakt.
  { rule: "field.empty", violation: check(gap({ hint: "" })) },
  {
    rule: "field.max_length",
    violation: check(gap({ prompt: "p".repeat(MAX_LESSON_TEXT_LENGTH + 1) })),
    boundary: check(gap({ prompt: "p".repeat(MAX_LESSON_TEXT_LENGTH) })),
  },
  {
    rule: "field.count",
    violation: check(open({ commonErrors: Array.from({ length: MAX_COMMON_ERRORS + 1 }, (_, i) => `błąd ${i}`) }), richSubject),
    boundary: check(open({ commonErrors: Array.from({ length: MAX_COMMON_ERRORS }, (_, i) => `błąd ${i}`) }), richSubject),
  },
  { rule: "field.invalid", violation: check({ ...open(), questionType: "riddle" } as unknown as LessonExerciseDraft) },

  // Ćwiczenie.
  { rule: "exercise.card_not_allowed", violation: check(gap({ exerciseType: "lesson_card" })) },
  { rule: "exercise.unknown_objective", violation: check(gap({ objectiveId: "core_cases.topic.missing" })) },
  { rule: "exercise.type_unsupported", violation: check(gap(), { ...plainSubject, exerciseTypes: ["lesson_choice"] }) },
  { rule: "exercise.type_not_allowed", violation: check(choice({ objectiveId: GAP_ONLY_OBJECTIVE_ID })) },
  { rule: "exercise.v3_field_not_allowed", violation: check(open({ questionType: "definition" })) },
  {
    rule: "answer.max_length",
    violation: check(open({ answer: wordyAnswer(MAX_LESSON_TEXT_LENGTH + 1), focus: ["ab"] })),
    boundary: check(open({ answer: wordyAnswer(MAX_LESSON_TEXT_LENGTH), focus: ["ab"] })),
  },
  {
    rule: "answer.max_length",
    violation: check(open({ acceptedAnswers: [wordyAnswer(MAX_LESSON_TEXT_LENGTH + 1)] })),
    boundary: check(open({ acceptedAnswers: [wordyAnswer(MAX_LESSON_TEXT_LENGTH)] })),
  },
  { rule: "voice_tone.not_allowed", violation: check(gap({ voiceTone: "gentle" })) },
  {
    rule: "voice_tone.not_allowed",
    violation: check({ ...open({ voiceTone: "gentle" }), exerciseType: "lesson_calculation" }, richSubject),
  },

  // Wyjaśnienie błędu.
  { rule: "explanation.not_allowed", violation: check(gap({ explanationPl: "Przy she dodajemy -s." })) },
  { rule: "explanation.empty", violation: check(gap({ explanationPl: "   " }), richSubject) },
  {
    // Kontrakt nie przepuszcza dłuższego pola, więc limit po przycięciu sprawdza sama reguła treści.
    rule: "explanation.max_length",
    violation: () => explanationIssues("a".repeat(MAX_LESSON_TEXT_LENGTH + 1)),
    boundary: () => explanationIssues("a".repeat(MAX_LESSON_TEXT_LENGTH)),
  },
  { rule: "explanation.line_break", violation: check(gap({ explanationPl: "Przy she\ndodajemy -s." }), richSubject) },
  { rule: "explanation.markup", violation: check(gap({ explanationPl: "Przy *she* dodajemy -s." }), richSubject) },
  { rule: "explanation.one_sentence", violation: check(gap({ explanationPl: "Dodajemy -s. Tak mówimy." }), richSubject) },

  // Pola wspólne.
  {
    rule: "fields.type_specific",
    violation: check(gap({ pairs: [{ left: "a", right: "b" }, { left: "c", right: "d" }, { left: "e", right: "f" }] })),
  },
  { rule: "visual.choice_only", violation: check(gap({ visualSubject: "girl" })) },
  { rule: "focus.empty", violation: check(gap({ focus: [] })) },
  { rule: "focus.not_contiguous", violation: check(open({ focus: ["cukry", "wytwarza"] })) },
  {
    rule: "variants.count",
    violation: check(gap({ acceptedAnswers: Array.from({ length: MAX_ACCEPTED_ANSWERS + 1 }, (_, i) => `v${i}`) })),
    boundary: check(gap({ acceptedAnswers: Array.from({ length: MAX_ACCEPTED_ANSWERS }, (_, i) => `v${i}`) })),
  },
  { rule: "variants.empty", violation: check(gap({ acceptedAnswers: ["  "] })) },
  { rule: "variants.duplicate", violation: check(gap({ acceptedAnswers: ["Plays"] })) },

  // Wybór.
  { rule: "choice.stem_required", violation: check(choice({ stem: undefined })) },
  { rule: "short_answer.prompt_required", violation: check(shortAnswer({ prompt: undefined })) },
  {
    rule: "options.count",
    violation: check(choice({ options: undefined })),
    boundary: check(choice({
      options: Array.from({ length: MAX_OPTIONS }, (_, i) => ({ id: i === 0 ? "a" : `o${i}`, text: i === 0 ? "plays" : `word${i}` })),
    })),
  },
  {
    // Ponad limit: zgłasza kontrakt, pod id reguły rdzenia.
    rule: "options.count",
    violation: check(choice({
      options: Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => ({ id: i === 0 ? "a" : `o${i}`, text: i === 0 ? "plays" : `word${i}` })),
    })),
    boundary: check(choice({
      options: Array.from({ length: MAX_OPTIONS }, (_, i) => ({ id: i === 0 ? "a" : `o${i}`, text: i === 0 ? "plays" : `word${i}` })),
    })),
  },
  { rule: "options.duplicate", violation: check(choice({ options: [{ id: "a", text: "plays" }, { id: "b", text: "Plays" }] })) },
  { rule: "options.correct_unknown", violation: check(choice({ correctOption: "z" })) },

  // Wybór ze słuchu.
  { rule: "listen.instruction_not_allowed", violation: check(listen({ instructionPl: "Wybierz słowo." })) },
  { rule: "listen.hint_not_allowed", violation: check(listen({ hint: "play" })) },
  { rule: "listen.gap_count", violation: check(listen({ stem: "She plays tennis." })) },
  { rule: "listen.option_apostrophe", violation: check(listen({ options: [{ id: "a", text: "plays" }, { id: "b", text: "'s" }] })) },
  { rule: "listen.options_equivalent", violation: check(listen({ options: [{ id: "a", text: "plays" }, { id: "b", text: "Plays" }] })) },
  {
    rule: "listen.sentence_length",
    violation: check(listen({
      stem: longListenStem,
      options: [{ id: "a", text: listenOptionFor(FEEDBACK_SENTENCE_MAX_LENGTH + 1) }, { id: "b", text: "c" }],
    })),
    boundary: check(listen({
      stem: longListenStem,
      options: [{ id: "a", text: listenOptionFor(FEEDBACK_SENTENCE_MAX_LENGTH) }, { id: "b", text: "c" }],
    })),
  },

  // Wskazanie słowa.
  { rule: "notice.options_not_allowed", violation: check(notice({ options: [{ id: "a", text: "plays" }, { id: "b", text: "runs" }] })) },
  { rule: "notice.segments_required", violation: check(notice({ noticeSegments: undefined })) },
  {
    rule: "notice.sentence_count",
    violation: check(notice({ noticeSegments: Array.from({ length: MAX_NOTICE_SENTENCES + 1 }, () => ["She", "plays"]) })),
    boundary: check(notice({ noticeSegments: Array.from({ length: MAX_NOTICE_SENTENCES }, () => ["She", "plays"]) })),
  },
  {
    rule: "notice.segment_count",
    violation: check(notice({ noticeSegments: [["plays", ...Array.from({ length: MAX_NOTICE_SEGMENTS }, (_, i) => `w${i}`)], ["He", "runs"]] })),
    boundary: check(notice({ noticeSegments: [["plays", ...Array.from({ length: MAX_NOTICE_SEGMENTS - 1 }, (_, i) => `w${i}`)], ["He", "runs"]] })),
  },
  { rule: "notice.segment_empty", violation: check(notice({ noticeSegments: [["She", "  "], ["He", "plays"]] })) },
  { rule: "notice.correct_required", violation: check(notice({ correctOption: undefined })) },
  { rule: "notice.correct_not_segment", violation: check(notice({ correctOption: "swims" })) },

  // Kolejność.
  {
    rule: "order.items_count",
    violation: check({ ...order(["She", "plays", "tennis"]), items: undefined }),
    boundary: check(order(Array.from({ length: MIN_ORDER_ITEMS }, (_, i) => `w${i}`))),
  },
  {
    // Ponad limit: zgłasza kontrakt, pod id reguły rdzenia.
    rule: "order.items_count",
    violation: check(order(Array.from({ length: MAX_ORDER_ITEMS + 1 }, (_, i) => `w${i}`))),
    boundary: check(order(Array.from({ length: MAX_ORDER_ITEMS }, (_, i) => `w${i}`))),
  },
  { rule: "order.items_join", violation: check(order(["She", "plays", "tennis"], "She plays football")) },

  // Typy tekstowe.
  { rule: "gap.marker_count", violation: check(gap({ stem: "She plays tennis." })) },
  {
    rule: "gap.answer_tokens",
    violation: check(gap({
      answer: Array.from({ length: MAX_GAP_ANSWER_TOKENS + 1 }, (_, i) => `w${i}`).join(" "),
      focus: [Array.from({ length: MAX_GAP_ANSWER_TOKENS + 1 }, (_, i) => `w${i}`).join(" ")],
    })),
    boundary: check(gap({
      answer: Array.from({ length: MAX_GAP_ANSWER_TOKENS }, (_, i) => `w${i}`).join(" "),
      focus: [Array.from({ length: MAX_GAP_ANSWER_TOKENS }, (_, i) => `w${i}`).join(" ")],
    })),
  },
  { rule: "gap.focus", violation: check(gap({ focus: ["tennis"] })) },
  { rule: "error_fix.statement_required", violation: check(errorFix({ statement: undefined })) },
  { rule: "error_fix.same_as_answer", violation: check(errorFix({ statement: "She plays tennis." })) },
  { rule: "transform.statement_required", violation: check(transform({ statement: undefined })) },
  { rule: "transform.unknown", violation: check(transform({ transformId: "reverse" })) },
  { rule: "open.prompt_required", violation: check(open({ prompt: undefined })) },

  // Słowa kluczowe. Liczności ponad limit zgłasza kontrakt pod id reguły rdzenia.
  {
    rule: "keywords.options_count",
    violation: check(keywords(undefined, ["k1", "k2"])),
    boundary: check(keywords(termsOf(MAX_KEYWORD_OPTIONS), ["t0", "t1"])),
  },
  {
    rule: "keywords.options_count",
    violation: check(keywords(termsOf(MAX_KEYWORD_OPTIONS + 1), ["t0", "t1"])),
    boundary: check(keywords(termsOf(MAX_KEYWORD_OPTIONS), ["t0", "t1"])),
  },
  { rule: "keywords.option_ids_unique", violation: check(keywords([...TERMS.slice(0, 3), { id: "k1", text: "kwiat" }], ["k2", "k3"])) },
  { rule: "keywords.option_duplicate", violation: check(keywords([...TERMS.slice(0, 3), { id: "k4", text: "Fotosynteza" }], ["k1", "k2"])) },
  {
    rule: "keywords.key_count",
    violation: check(keywords(TERMS, undefined)),
    boundary: check(keywords(TERMS, TERMS.slice(0, MAX_KEY_OPTIONS).map((term) => term.id))),
  },
  {
    rule: "keywords.key_count",
    violation: check(keywords(termsOf(MAX_KEYWORD_OPTIONS), termsOf(MAX_KEY_OPTIONS + 1).map((term) => term.id))),
    boundary: check(keywords(termsOf(MAX_KEYWORD_OPTIONS), termsOf(MAX_KEY_OPTIONS).map((term) => term.id))),
  },
  { rule: "keywords.key_repeated", violation: check(keywords(TERMS, ["k1", "k1"])) },
  { rule: "keywords.key_unknown", violation: check(keywords(TERMS, ["k1", "k9"])) },

  // Pary. Liczności ponad limit zgłasza kontrakt pod id reguły rdzenia.
  {
    rule: "match.pairs_count",
    violation: check({ ...match(RIVERS), pairs: undefined }),
    boundary: check(match(pairsOf(MAX_MATCH_PAIRS))),
  },
  {
    rule: "match.pairs_count",
    violation: check(match(pairsOf(MAX_MATCH_PAIRS + 1))),
    boundary: check(match(pairsOf(MAX_MATCH_PAIRS))),
  },
  {
    rule: "match.extra_count",
    violation: check(match(RIVERS, Array.from({ length: MAX_MATCH_EXTRA + 1 }, (_, i) => `dystraktor${i}`))),
    boundary: check(match(RIVERS, Array.from({ length: MAX_MATCH_EXTRA }, (_, i) => `dystraktor${i}`))),
  },
  { rule: "match.confusable", violation: check(match([...RIVERS.slice(0, 2), { left: "Wisła", right: "miasto" }])) },
  { rule: "match.confusable", violation: check(match(RIVERS, ["długa rzeka"])) },

  // Grupy. Liczności ponad limit zgłasza kontrakt pod id reguły rdzenia.
  {
    rule: "group.groups_count",
    violation: check({ ...group(ANIMAL_GROUPS, ANIMALS), groups: undefined }),
    boundary: check(groupsOf(MAX_GROUPS)),
  },
  { rule: "group.groups_count", violation: check(groupsOf(MAX_GROUPS + 1)), boundary: check(groupsOf(MAX_GROUPS)) },
  {
    rule: "group.items_count",
    violation: check({ ...group(ANIMAL_GROUPS, ANIMALS), groupItems: undefined }),
    boundary: check(group(ANIMAL_GROUPS, animalsOf(MAX_GROUP_ITEMS))),
  },
  {
    rule: "group.items_count",
    violation: check(group(ANIMAL_GROUPS, animalsOf(MAX_GROUP_ITEMS + 1))),
    boundary: check(group(ANIMAL_GROUPS, animalsOf(MAX_GROUP_ITEMS))),
  },
  { rule: "group.ids_unique", violation: check(group([{ id: "g1", label: "Ssaki" }, { id: "g1", label: "Ptaki" }], ANIMALS)) },
  {
    rule: "group.item_unknown_group",
    violation: check(group(ANIMAL_GROUPS, [...ANIMALS.slice(0, 3), { text: "Sowa", groupId: "g4" }])),
  },
  {
    rule: "group.items_per_group",
    violation: check(group(ANIMAL_GROUPS, [...ANIMALS.slice(0, 3).map((item) => ({ ...item, groupId: "g1" })), ANIMALS[3]!])),
    boundary: check(group(ANIMAL_GROUPS, ANIMALS)),
  },
  { rule: "group.label_confusable", violation: check(group([{ id: "g1", label: "Ssaki" }, { id: "g2", label: "Ssaki morskie" }], ANIMALS)) },
  { rule: "group.item_repeated", violation: check(group(ANIMAL_GROUPS, [...ANIMALS.slice(0, 3), { text: "pies", groupId: "g2" }])) },
  { rule: "group.item_is_label", violation: check(group(ANIMAL_GROUPS, [...ANIMALS.slice(0, 3), { text: "Ptaki", groupId: "g2" }])) },

  // Tekst z lukami i bankiem słów.
  { rule: "cloze.text_required", violation: check(cloze({ clozeText: undefined })) },
  {
    // Słów luk jest najwyżej MAX_CLOZE_GAPS (kontrakt), więc nadmiar luk zgłasza walidator.
    rule: "cloze.gap_count",
    violation: check(clozeWithGaps(MAX_CLOZE_GAPS + 1, MAX_CLOZE_GAPS)),
    boundary: check(clozeWithGaps(MAX_CLOZE_GAPS)),
  },
  {
    // Słów luk ponad limit: zgłasza kontrakt pod id reguły rdzenia.
    rule: "cloze.gap_count",
    violation: check(clozeWithGaps(MAX_CLOZE_GAPS + 1)),
    boundary: check(clozeWithGaps(MAX_CLOZE_GAPS)),
  },
  { rule: "cloze.answers_count", violation: check(cloze({ gapAnswers: ["wodę", "dwutlenek węgla", "sole"] })) },
  {
    rule: "cloze.extra_count",
    violation: check(cloze({ extraWords: undefined })),
    boundary: check(cloze({ extraWords: Array.from({ length: MAX_CLOZE_EXTRA }, (_, i) => `pułapka${i}`) })),
  },
  {
    rule: "cloze.extra_count",
    violation: check(cloze({ extraWords: Array.from({ length: MAX_CLOZE_EXTRA + 1 }, (_, i) => `pułapka${i}`) })),
    boundary: check(cloze({ extraWords: Array.from({ length: MAX_CLOZE_EXTRA }, (_, i) => `pułapka${i}`) })),
  },
  { rule: "cloze.words_between_gaps", violation: check(cloze({ clozeText: "Roślina pobiera ___ ___ z powietrza." })) },
  { rule: "cloze.underscore_outside_gap", violation: check(cloze({ clozeText: "Roślina_pobiera ___ z gleby i ___ z powietrza." })) },
  { rule: "cloze.bank_word_empty", violation: check(cloze({ extraWords: ["!!"] })) },
  {
    rule: "cloze.bank_word_tokens",
    violation: check(cloze({ extraWords: [Array.from({ length: MAX_CLOZE_WORD_TOKENS + 1 }, (_, i) => `dąb${i}`).join(" ")] })),
    boundary: check(cloze({ extraWords: [Array.from({ length: MAX_CLOZE_WORD_TOKENS }, (_, i) => `dąb${i}`).join(" ")] })),
  },
  { rule: "cloze.bank_confusable", violation: check(cloze({ extraWords: ["wodę morską"] })) },
  { rule: "cloze.bank_outside_gap", violation: check(cloze({ extraWords: ["gleby"] })) },

  // Specyfikacja rachunku.
  {
    rule: "calculation.tolerance",
    violation: () => calculationIssues({ ...scale, tolerance: SCALE_TOLERANCE_LIMIT + 0.1 }),
    boundary: () => calculationIssues({ ...scale, tolerance: SCALE_TOLERANCE_LIMIT }),
  },
  {
    rule: "calculation.tolerance",
    violation: () => calculationIssues({ ...scale, tolerance: null }),
    boundary: () => calculationIssues({ ...scale, tolerance: 0 }),
  },
  { rule: "calculation.family_slug", violation: () => calculationIssues({ ...scale, templateFamilyId: "scale_distance-1" }) },
  { rule: "calculation.params", violation: () => calculationIssues({ ...scale, params: { scaleDenominator: 25000, mapDistanceCm: -1 } }) },
  { rule: "calculation.unknown_key", violation: () => calculationIssues({ ...scale, params: { ...scale.params, zoom: 2 } }) },
]);

/** Poprawne szkice przypadków (test pilnuje, że bez naruszenia przechodzą bez zgłoszeń). */
export const CORE_CASE_BASELINES: readonly { readonly name: string; readonly issues: () => readonly unknown[] }[] = [
  { name: "gap", issues: check(gap()) },
  { name: "choice", issues: check(choice()) },
  { name: "listen", issues: check(listen()) },
  { name: "shortAnswer", issues: check(shortAnswer()) },
  { name: "notice", issues: check(notice()) },
  { name: "order", issues: check(order(["She", "plays", "tennis"])) },
  { name: "errorFix", issues: check(errorFix()) },
  { name: "transform", issues: check(transform()) },
  { name: "open", issues: check(open()) },
  { name: "open (v3)", issues: check(open({ commonErrors: ["błąd"] }), richSubject) },
  { name: "gap z wyjaśnieniem", issues: check(gap({ explanationPl: "Przy she dodajemy -s." }), richSubject) },
  { name: "match", issues: check(match(RIVERS, ["jezioro"])) },
  { name: "group", issues: check(group(ANIMAL_GROUPS, ANIMALS)) },
  { name: "cloze", issues: check(cloze()) },
  { name: "keywords", issues: check(keywords(TERMS, ["k1", "k2"])) },
  { name: "calculation", issues: () => calculationIssues(scale) },
];
