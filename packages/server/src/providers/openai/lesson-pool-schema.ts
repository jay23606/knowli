import {
  LessonVoiceToneSchema,
  MAX_ACCEPTED_ANSWERS,
  MAX_CALCULATION_PARAMETER,
  MAX_CLOZE_EXTRA,
  MAX_CLOZE_GAPS,
  MAX_CLOZE_TEXT_LENGTH,
  MAX_CLOZE_WORD_LENGTH,
  MAX_COMMON_ERRORS,
  MAX_ELEMENT_ID_LENGTH,
  MAX_FAMILY_ID_LENGTH,
  MAX_GROUP_ID_LENGTH,
  MAX_GROUP_ITEM_LENGTH,
  MAX_GROUP_ITEMS,
  MAX_GROUP_LABEL_LENGTH,
  MAX_GROUPS,
  MAX_KEY_OPTIONS,
  MAX_KEYWORD_LENGTH,
  MAX_KEYWORD_OPTIONS,
  MAX_LESSON_TEXT_LENGTH,
  MAX_MATCH_EXTRA,
  MAX_MATCH_LEFT_LENGTH,
  MAX_MATCH_PAIRS,
  MAX_MATCH_RIGHT_LENGTH,
  MAX_NOTICE_SEGMENTS,
  MAX_NOTICE_SENTENCES,
  MAX_OPTIONS,
  MAX_ORDER_ITEMS,
  MAX_REQUIRED_ELEMENTS,
  MAX_SCALE_DENOMINATOR,
  MAX_SOURCE_QUOTE_LENGTH,
  MAX_SOURCE_REFS,
  MAX_SUPPLEMENTARY_ELEMENTS,
  MAX_TEMPLATE_FAMILY_ID_LENGTH,
  MIN_CLOZE_EXTRA,
  MIN_CLOZE_GAPS,
  MIN_GROUP_ITEMS,
  MIN_GROUPS,
  MIN_KEY_OPTIONS,
  MIN_KEYWORD_OPTIONS,
  MIN_MATCH_PAIRS,
  MIN_NOTICE_SEGMENTS,
  MIN_NOTICE_SENTENCES,
  MIN_OPTIONS,
  MIN_ORDER_ITEMS,
  MIN_REQUIRED_ELEMENTS,
  MIN_SOURCE_QUOTE_LENGTH,
  MIN_SOURCE_REFS,
} from "@learning/contracts";
import { MAX_CARD_EXAMPLES } from "../../domain/lessons/agent/admission";
import type { LessonPoolInput } from "../../ports/ai";

const NON_POOL_EXERCISE_TYPES: ReadonlySet<string> = new Set(["lesson_card"]);

/**
 * Limity schematu narzędzia z tych samych stałych co walidacja (spec katalogu reguł §3): napisy
 * `minLength: 1` i `maxLength`, listy `minItems`/`maxItems`. Schemat nie jest egzekwowany przez SDK —
 * walidacja zostaje po stronie serwera; limity mówią modelowi, czego oczekuje sprawdzenie.
 */
const text = (maxLength: number = MAX_LESSON_TEXT_LENGTH): Record<string, unknown> => ({ type: "string", minLength: 1, maxLength });
const nullableText = (maxLength: number = MAX_LESSON_TEXT_LENGTH): Record<string, unknown> => ({ type: ["null", "string"], minLength: 1, maxLength });
const list = (items: Record<string, unknown>, minItems: number | undefined, maxItems: number): Record<string, unknown> => ({
  type: "array",
  ...(minItems === undefined ? {} : { minItems }),
  maxItems,
  items,
});
/** Lista, której brak (`null`) znaczy „pole nie dotyczy” (gałąź regularna trybu strict wymaga każdego pola). */
const nullableList = (items: Record<string, unknown>, minItems: number | undefined, maxItems: number): Record<string, unknown> => ({
  ...list(items, minItems, maxItems),
  type: ["null", "array"],
});

/**
 * Strict-mode pole tonu lektora: nullable enum z kontraktu (`null` = styl roli).
 * `whisper: false` (ćwiczenia) pomija `mysterious` — pytania nie są szeptane (spec tonu TTS §4.3).
 */
export const voiceToneProperty = ({ whisper = true }: { whisper?: boolean } = {}): Record<string, unknown> => ({
  type: ["null", "string"],
  enum: [null, ...LessonVoiceToneSchema.options.filter((tone) => whisper || tone !== "mysterious")],
});

/** Dokłada wymagane pole `voiceTone` do gałęzi ćwiczenia (strict mode: pole także w `required`). */
function withVoiceTone(branch: Record<string, unknown>): Record<string, unknown> {
  return {
    ...branch,
    required: [...(branch.required as string[]), "voiceTone"],
    properties: { ...(branch.properties as Record<string, unknown>), voiceTone: voiceToneProperty({ whisper: false }) },
  };
}

/** Dokłada wymagane pole `explanationPl` (strict mode: także w `required`; `null` = brak wyjaśnienia). */
function withExplanation(branch: Record<string, unknown>): Record<string, unknown> {
  return {
    ...branch,
    required: [...(branch.required as string[]), "explanationPl"],
    properties: { ...(branch.properties as Record<string, unknown>), explanationPl: nullableText() },
  };
}

export const poolExerciseTypes = (types: readonly string[]): string[] =>
  types.filter((type) => !NON_POOL_EXERCISE_TYPES.has(type));

const strictObject = (properties: Record<string, unknown>) => ({
  type: "object", additionalProperties: false, required: Object.keys(properties), properties,
});
const quoteItems = strictObject({ quote: { type: "string", minLength: MIN_SOURCE_QUOTE_LENGTH, maxLength: MAX_SOURCE_QUOTE_LENGTH } });
/** Niepusty identyfikator (opcje, klocki, pojęcia); limit długości tylko tam, gdzie ma go kontrakt. */
const id = (maxLength?: number): Record<string, unknown> => (maxLength === undefined ? { type: "string", minLength: 1 } : text(maxLength));
const idTextItem = (maxLength: number = MAX_LESSON_TEXT_LENGTH, idMaxLength?: number) =>
  strictObject({ id: id(idMaxLength), text: text(maxLength) });

function lessonExerciseSchema(
  input: LessonPoolInput,
  objective: LessonPoolInput["objectives"][number],
  allowedTypes: string[],
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "exerciseType", "objectiveId", "answer", "acceptedAnswers", "focus", "instructionPl",
      "stem", "statement", "prompt", "hint", "transformId", "noticeSegments", "visualSubject", "options",
      "correctOption", "items", "questionType", "requiredElements", "supplementaryElements",
      "commonErrors", "expectedForm", "familyId", "sourceRefs",
    ],
    properties: {
      exerciseType: { type: "string", enum: allowedTypes },
      objectiveId: { type: "string", enum: [objective.id] },
      // Limit odpowiedzi przedmiotu (jak `answer.max_length` w księdze reguł), nie stały limit kontraktu.
      answer: text(input.answerMaxLength),
      acceptedAnswers: list(text(input.answerMaxLength), undefined, MAX_ACCEPTED_ANSWERS),
      focus: { type: "array", items: text() },
      instructionPl: nullableText(),
      stem: nullableText(),
      statement: nullableText(),
      prompt: nullableText(),
      hint: nullableText(),
      transformId: { type: ["null", "string"], enum: [null, ...input.transforms.map((transform) => transform.id)] },
      noticeSegments: nullableList(list(text(), MIN_NOTICE_SEGMENTS, MAX_NOTICE_SEGMENTS), MIN_NOTICE_SENTENCES, MAX_NOTICE_SENTENCES),
      visualSubject: { type: ["null", "string"], enum: [null, "boy", "girl", "man", "woman", "group", "dog"] },
      options: nullableList(idTextItem(), MIN_OPTIONS, MAX_OPTIONS),
      correctOption: { type: ["null", "string"], minLength: 1 },
      items: nullableList(idTextItem(), MIN_ORDER_ITEMS, MAX_ORDER_ITEMS),
      questionType: { type: ["null", "string"], enum: [null, "definition", "enumeration", "cause", "comparison", "fact", "process"] },
      requiredElements: nullableList(idTextItem(MAX_LESSON_TEXT_LENGTH, MAX_ELEMENT_ID_LENGTH), MIN_REQUIRED_ELEMENTS, MAX_REQUIRED_ELEMENTS),
      supplementaryElements: nullableList(text(), undefined, MAX_SUPPLEMENTARY_ELEMENTS),
      commonErrors: nullableList(text(), undefined, MAX_COMMON_ERRORS),
      expectedForm: { type: ["null", "string"], enum: [null, "short", "one_sentence", "explanation", "list"] },
      familyId: nullableText(MAX_FAMILY_ID_LENGTH),
      // Przy uziemieniu tablica cytatów musi być NIEPUSTA już w schemacie: bez
      // minItems model w ok. połowie odpowiedzi zwracał `[]` dla większości ćwiczeń
      // (sonda na prawdziwym LLM), a walidacja odrzucała je potem jako nieuziemione.
      sourceRefs: input.groundingRequired
        ? list(quoteItems, MIN_SOURCE_REFS, MAX_SOURCE_REFS)
        : nullableList(quoteItems, undefined, MAX_SOURCE_REFS),
    },
  };
}

/** Cytaty gałęzi z własnym schematem: przy uziemieniu obowiązkowe, inaczej nullowalne (strict wymaga pola). */
function dedicatedSourceRefs(input: LessonPoolInput): Record<string, unknown> {
  return input.groundingRequired === true
    ? list(quoteItems, MIN_SOURCE_REFS, MAX_SOURCE_REFS)
    : { ...list(quoteItems, undefined, MAX_SOURCE_REFS), type: ["array", "null"] };
}

/**
 * Rachunek: ścisłe parametry metody, bez bodźca i odpowiedzi modelu. `tolerance` jest opcjonalne
 * (brak = 0, kod liczy dokładny wynik), więc nie leży w `required`.
 */
function calculationExerciseSchema(objectiveId: string): Record<string, unknown> {
  const units = { type: "string", enum: ["cm", "m", "km"] };
  const parameter = { type: "number", minimum: -MAX_CALCULATION_PARAMETER, maximum: MAX_CALCULATION_PARAMETER };
  const nonnegative = { ...parameter, minimum: 0 };
  const branch = (kind: string, params: Record<string, unknown>) => {
    const properties = {
      kind: { type: "string", enum: [kind] },
      params: strictObject(params),
      unit: units,
      tolerance: { type: "number", minimum: 0 },
      templateFamilyId: { type: "string", minLength: 1, maxLength: MAX_TEMPLATE_FAMILY_ID_LENGTH, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
    };
    return { type: "object", additionalProperties: false, required: ["kind", "params", "unit", "templateFamilyId"], properties };
  };
  return strictObject({
    exerciseType: { type: "string", enum: ["lesson_calculation"] },
    objectiveId: { type: "string", enum: [objectiveId] },
    calculation: { anyOf: [
      branch("scale_distance", { scaleDenominator: { type: "integer", minimum: 1, maximum: MAX_SCALE_DENOMINATOR }, mapDistanceCm: nonnegative }),
      branch("height_difference", { upperHeightM: parameter, lowerHeightM: parameter }),
      branch("unit_conversion", { value: nonnegative, fromUnit: units }),
    ] },
    sourceRefs: list(quoteItems, MIN_SOURCE_REFS, MAX_SOURCE_REFS),
  });
}

/**
 * Słowa kluczowe (trener precyzji): tylko pojęcia, ich klucz i rodzina pytań —
 * odpowiedź (`answer`) składa kod z pojęć kluczowych, model jej nie podaje.
 */
function keywordsExerciseSchema(objectiveId: string): Record<string, unknown> {
  return strictObject({
    exerciseType: { type: "string", enum: ["lesson_keywords"] },
    objectiveId: { type: "string", enum: [objectiveId] },
    familyId: text(MAX_FAMILY_ID_LENGTH),
    keywordOptions: list(idTextItem(MAX_KEYWORD_LENGTH), MIN_KEYWORD_OPTIONS, MAX_KEYWORD_OPTIONS),
    keyOptionIds: list(id(), MIN_KEY_OPTIONS, MAX_KEY_OPTIONS),
    sourceRefs: list(quoteItems, MIN_SOURCE_REFS, MAX_SOURCE_REFS),
  });
}

/**
 * „Połącz w pary” (design szkoły §10.6): tylko teksty par i dystraktorów —
 * odpowiedź składa kod, model jej nie podaje.
 */
function matchExerciseSchema(input: LessonPoolInput, objectiveId: string): Record<string, unknown> {
  return strictObject({
    exerciseType: { type: "string", enum: ["lesson_match"] },
    objectiveId: { type: "string", enum: [objectiveId] },
    instructionPl: text(),
    pairs: list(strictObject({ left: text(MAX_MATCH_LEFT_LENGTH), right: text(MAX_MATCH_RIGHT_LENGTH) }), MIN_MATCH_PAIRS, MAX_MATCH_PAIRS),
    extraRight: list(text(MAX_MATCH_RIGHT_LENGTH), undefined, MAX_MATCH_EXTRA),
    sourceRefs: dedicatedSourceRefs(input),
  });
}

/** „Pogrupuj”: grupy i elementy z przynależnością; odpowiedź składa kod. */
function groupExerciseSchema(input: LessonPoolInput, objectiveId: string): Record<string, unknown> {
  return strictObject({
    exerciseType: { type: "string", enum: ["lesson_group"] },
    objectiveId: { type: "string", enum: [objectiveId] },
    instructionPl: text(),
    groups: list(strictObject({ id: text(MAX_GROUP_ID_LENGTH), label: text(MAX_GROUP_LABEL_LENGTH) }), MIN_GROUPS, MAX_GROUPS),
    groupItems: list(strictObject({ text: text(MAX_GROUP_ITEM_LENGTH), groupId: text(MAX_GROUP_ID_LENGTH) }), MIN_GROUP_ITEMS, MAX_GROUP_ITEMS),
    sourceRefs: dedicatedSourceRefs(input),
  });
}

/** „Uzupełnij tekst” (design szkoły §13.6): tekst z lukami, słowa luk i dystraktory; odpowiedź składa kod. */
function clozeExerciseSchema(input: LessonPoolInput, objectiveId: string): Record<string, unknown> {
  return strictObject({
    exerciseType: { type: "string", enum: ["lesson_cloze"] },
    objectiveId: { type: "string", enum: [objectiveId] },
    instructionPl: text(),
    clozeText: text(MAX_CLOZE_TEXT_LENGTH),
    gapAnswers: list(text(MAX_CLOZE_WORD_LENGTH), MIN_CLOZE_GAPS, MAX_CLOZE_GAPS),
    extraWords: list(text(MAX_CLOZE_WORD_LENGTH), MIN_CLOZE_EXTRA, MAX_CLOZE_EXTRA),
    sourceRefs: dedicatedSourceRefs(input),
  });
}

/** Typy z własną ścisłą gałęzią (bez pól wspólnej gałęzi „regularnej”). */
const DEDICATED_BRANCH_TYPES: ReadonlySet<string> = new Set(["lesson_calculation", "lesson_keywords", "lesson_match", "lesson_group", "lesson_cloze"]);

/** Strict JSON Schema: każda gałąź wiąże typ ćwiczenia z jednym celem. */
export function lessonPoolJsonSchema(input: LessonPoolInput): Record<string, unknown> {
  if (input.objectives.length === 0) throw new Error("lesson pool requires at least one objective");
  const branches = input.objectives.flatMap((objective) => {
    const types = poolExerciseTypes(objective.exerciseTypes.filter((type) => input.exerciseTypes.includes(type)));
    if (types.length === 0) throw new Error(`objective ${objective.id} has no supported pool exercise types`);
    const regularTypes = types.filter((type) => !DEDICATED_BRANCH_TYPES.has(type));
    // Ton lektora dotyczy każdej gałęzi poza kalkulacją (jej treść składa kod z szablonu).
    // Wyjaśnienie błędu dotyczy tych samych gałęzi co ton: kalkulacja składa treść z szablonu.
    const toned = (branch: Record<string, unknown>) => {
      const withTone = input.voiceTones === true ? withVoiceTone(branch) : branch;
      return input.exerciseExplanations === true ? withExplanation(withTone) : withTone;
    };
    return [
      ...(regularTypes.length > 0 ? [toned(lessonExerciseSchema(input, objective, regularTypes))] : []),
      ...(types.includes("lesson_calculation") ? [calculationExerciseSchema(objective.id)] : []),
      ...(types.includes("lesson_keywords") ? [toned(keywordsExerciseSchema(objective.id))] : []),
      ...(types.includes("lesson_match") ? [toned(matchExerciseSchema(input, objective.id))] : []),
      ...(types.includes("lesson_group") ? [toned(groupExerciseSchema(input, objective.id))] : []),
      ...(types.includes("lesson_cloze") ? [toned(clozeExerciseSchema(input, objective.id))] : []),
    ];
  });
  const objectiveIds = input.objectives.map((objective) => objective.id);
  return {
    type: "object",
    additionalProperties: false,
    required: ["exercises", "examples"],
    properties: {
      exercises: { type: "array", items: branches.length === 1 ? branches[0] : { anyOf: branches } },
      examples: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["objectiveId", "examples"],
          properties: {
            objectiveId: { type: "string", enum: objectiveIds },
            examples: list(text(), undefined, MAX_CARD_EXAMPLES),
          },
        },
      },
    },
  };
}
