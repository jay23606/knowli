import { LessonVoiceToneSchema } from "@learning/contracts";
import type { LessonPoolInput } from "../../ports/ai";

const NON_POOL_EXERCISE_TYPES: ReadonlySet<string> = new Set(["lesson_card"]);

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
    properties: { ...(branch.properties as Record<string, unknown>), explanationPl: { type: ["string", "null"] } },
  };
}

export const poolExerciseTypes = (types: readonly string[]): string[] =>
  types.filter((type) => !NON_POOL_EXERCISE_TYPES.has(type));

function lessonExerciseSchema(
  input: LessonPoolInput,
  objective: LessonPoolInput["objectives"][number],
  allowedTypes: string[],
): Record<string, unknown> {
  const quoteItem = { type: "object", additionalProperties: false, required: ["quote"], properties: { quote: { type: "string" } } };
  const idTextItem = {
    type: "object",
    additionalProperties: false,
    required: ["id", "text"],
    properties: { id: { type: "string" }, text: { type: "string" } },
  };
  const nullable = (schema: Record<string, unknown>) => ({
    type: ["null", schema.type],
    ...(schema.items ? { items: schema.items } : {}),
  });
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
      answer: { type: "string" },
      acceptedAnswers: { type: "array", items: { type: "string" } },
      focus: { type: "array", items: { type: "string" } },
      instructionPl: { type: ["null", "string"] },
      stem: { type: ["null", "string"] },
      statement: { type: ["null", "string"] },
      prompt: { type: ["null", "string"] },
      hint: { type: ["null", "string"] },
      transformId: { type: ["null", "string"], enum: [null, ...input.transforms.map((transform) => transform.id)] },
      noticeSegments: { type: ["null", "array"], items: { type: "array", items: { type: "string" } } },
      visualSubject: { type: ["null", "string"], enum: [null, "boy", "girl", "man", "woman", "group", "dog"] },
      options: nullable({ type: "array", items: idTextItem }),
      correctOption: { type: ["null", "string"] },
      items: nullable({ type: "array", items: idTextItem }),
      questionType: { type: ["null", "string"], enum: [null, "definition", "enumeration", "cause", "comparison", "fact", "process"] },
      requiredElements: nullable({ type: "array", items: idTextItem }),
      supplementaryElements: { type: ["null", "array"], items: { type: "string" } },
      commonErrors: { type: ["null", "array"], items: { type: "string" } },
      expectedForm: { type: ["null", "string"], enum: [null, "short", "one_sentence", "explanation", "list"] },
      familyId: { type: ["null", "string"] },
      // Przy uziemieniu tablica cytatów musi być NIEPUSTA już w schemacie: bez
      // minItems model w ok. połowie odpowiedzi zwracał `[]` dla większości ćwiczeń
      // (sonda na prawdziwym LLM), a walidacja odrzucała je potem jako nieuziemione.
      sourceRefs: input.groundingRequired
        ? { type: "array", minItems: 1, maxItems: 3, items: quoteItem }
        : nullable({ type: "array", items: quoteItem }),
    },
  };
}

/** Strict discriminated parameters: neither free-text stimulus nor model answer. */
function calculationExerciseSchema(objectiveId: string): Record<string, unknown> {
  const units = { type: "string", enum: ["cm", "m", "km"] };
  const parameter = { type: "number", minimum: -1000000, maximum: 1000000 };
  const nonnegative = { ...parameter, minimum: 0 };
  const strictObject = (properties: Record<string, unknown>) => ({
    type: "object", additionalProperties: false, required: Object.keys(properties), properties,
  });
  const branch = (kind: string, params: Record<string, unknown>) => strictObject({
    kind: { type: "string", enum: [kind] },
    params: strictObject(params), unit: units,
    tolerance: { type: "number", minimum: 0 },
    templateFamilyId: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
  });
  return strictObject({
    exerciseType: { type: "string", enum: ["lesson_calculation"] },
    objectiveId: { type: "string", enum: [objectiveId] },
    calculation: { anyOf: [
      branch("scale_distance", { scaleDenominator: { type: "integer", minimum: 1, maximum: 1000000000 }, mapDistanceCm: nonnegative }),
      branch("height_difference", { upperHeightM: parameter, lowerHeightM: parameter }),
      branch("unit_conversion", { value: nonnegative, fromUnit: units }),
    ] },
    sourceRefs: { type: "array", minItems: 1, maxItems: 3, items: strictObject({ quote: { type: "string", minLength: 10, maxLength: 600 } }) },
  });
}

/**
 * Słowa kluczowe (trener precyzji): tylko pojęcia, ich klucz i rodzina pytań —
 * odpowiedź (`answer`) składa kod z pojęć kluczowych, model jej nie podaje.
 */
function keywordsExerciseSchema(objectiveId: string): Record<string, unknown> {
  const strictObject = (properties: Record<string, unknown>) => ({
    type: "object", additionalProperties: false, required: Object.keys(properties), properties,
  });
  return strictObject({
    exerciseType: { type: "string", enum: ["lesson_keywords"] },
    objectiveId: { type: "string", enum: [objectiveId] },
    familyId: { type: "string", minLength: 1, maxLength: 64 },
    keywordOptions: {
      type: "array", minItems: 4, maxItems: 6,
      items: strictObject({ id: { type: "string", minLength: 1 }, text: { type: "string", minLength: 1, maxLength: 40 } }),
    },
    keyOptionIds: { type: "array", minItems: 2, maxItems: 3, items: { type: "string", minLength: 1 } },
    sourceRefs: { type: "array", minItems: 1, maxItems: 3, items: strictObject({ quote: { type: "string", minLength: 10, maxLength: 600 } }) },
  });
}

const strictObject = (properties: Record<string, unknown>) => ({
  type: "object", additionalProperties: false, required: Object.keys(properties), properties,
});
const quoteItems = strictObject({ quote: { type: "string", minLength: 10, maxLength: 600 } });

/**
 * Cytaty gałęzi pary/grupy/luki: przy uziemieniu 1–3 obowiązkowe, inaczej
 * nullowalne (tryb strict wymaga pola, więc przedmiot bez cytatów dostaje `null`).
 */
function dedicatedSourceRefs(input: LessonPoolInput): Record<string, unknown> {
  return input.groundingRequired === true
    ? { type: "array", minItems: 1, maxItems: 3, items: quoteItems }
    : { type: ["array", "null"], items: quoteItems };
}

/**
 * „Połącz w pary” (design szkoły §10.6): tylko teksty par i dystraktorów —
 * odpowiedź składa kod, model jej nie podaje.
 */
function matchExerciseSchema(input: LessonPoolInput, objectiveId: string): Record<string, unknown> {
  return strictObject({
    exerciseType: { type: "string", enum: ["lesson_match"] },
    objectiveId: { type: "string", enum: [objectiveId] },
    instructionPl: { type: "string", minLength: 1, maxLength: 120 },
    pairs: {
      type: "array", minItems: 3, maxItems: 5,
      items: strictObject({ left: { type: "string", minLength: 1, maxLength: 40 }, right: { type: "string", minLength: 1, maxLength: 100 } }),
    },
    extraRight: { type: "array", maxItems: 2, items: { type: "string", minLength: 1, maxLength: 100 } },
    sourceRefs: dedicatedSourceRefs(input),
  });
}

/** „Pogrupuj”: grupy i elementy z przynależnością; odpowiedź składa kod. */
function groupExerciseSchema(input: LessonPoolInput, objectiveId: string): Record<string, unknown> {
  return strictObject({
    exerciseType: { type: "string", enum: ["lesson_group"] },
    objectiveId: { type: "string", enum: [objectiveId] },
    instructionPl: { type: "string", minLength: 1, maxLength: 120 },
    groups: {
      type: "array", minItems: 2, maxItems: 3,
      items: strictObject({ id: { type: "string", minLength: 1, maxLength: 40 }, label: { type: "string", minLength: 1, maxLength: 30 } }),
    },
    groupItems: {
      type: "array", minItems: 4, maxItems: 8,
      items: strictObject({ text: { type: "string", minLength: 1, maxLength: 40 }, groupId: { type: "string", minLength: 1, maxLength: 40 } }),
    },
    sourceRefs: dedicatedSourceRefs(input),
  });
}

/** „Uzupełnij tekst” (design szkoły §13.6): tekst z lukami, słowa luk i dystraktory; odpowiedź składa kod. */
function clozeExerciseSchema(input: LessonPoolInput, objectiveId: string): Record<string, unknown> {
  return strictObject({
    exerciseType: { type: "string", enum: ["lesson_cloze"] },
    objectiveId: { type: "string", enum: [objectiveId] },
    instructionPl: { type: "string", minLength: 1, maxLength: 120 },
    clozeText: { type: "string", minLength: 1, maxLength: 300 },
    gapAnswers: { type: "array", minItems: 2, maxItems: 4, items: { type: "string", minLength: 1, maxLength: 30 } },
    extraWords: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", minLength: 1, maxLength: 30 } },
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
            examples: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  };
}
