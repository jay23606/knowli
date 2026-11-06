import { z } from "zod";
import { clip, issueFrom, type LessonRuleIssue } from "./rules/catalog";
import { CORE_RULES } from "./rules/core-rules";

/**
 * Kształt surowego rekordu agenta puli (spec katalogu reguł §4.3): co walidacja
 * semantyczna dereferencuje, zanim rekord stanie się szkicem (`toExerciseDraft`).
 * Dwa sprawdzenia z jednej tabeli pól:
 * - `rawShapeIssues` — zgłoszenia `shape.*` z polem, oczekiwanym kształtem i
 *   otrzymanym typem dla ścieżki agenta, także dla pól v3, które
 *   `toExerciseDraft` po cichu filtruje;
 * - `hasLenientRawShape` — łagodny strażnik punktu kontrolnego z dzisiejszą
 *   semantyką (tylko pola z `guarded`).
 *
 * Pola nieobowiązkowe są `nullish`: structured outputs (json_schema strict)
 * zwraca każde pole schematu, z `null` dla nie dotyczących typu, więc `null`
 * znaczy brak pola. Czysta domena: nie rzuca dla dowolnego JSON.
 */

const shapeIssue = issueFrom(CORE_RULES);

type ShapeRuleId = Extract<keyof typeof CORE_RULES, `shape.${string}`>;

/** Kształt elementu listy: napis, lista napisów albo obiekt z polami-napisami (pola dodatkowe dozwolone). */
export type RawItemShape = "string" | "string_list" | readonly string[];

/** Szczegóły zgłoszenia przekazywane fabryce. */
type ShapeDetails = { readonly field?: string; readonly pl: string; readonly found?: string };

export interface RawListField {
  readonly field: string;
  readonly rule: ShapeRuleId;
  /** Zgłoszenie reguły pola: fabryka z literałem id (zgodność z `rule` pilnuje test). */
  readonly issue: (details: ShapeDetails) => LessonRuleIssue;
  readonly item: RawItemShape;
  /** Pole sprawdza też łagodny strażnik (dzisiejszy schemat kształtu). */
  readonly guarded: boolean;
}

/** Pola listowe rekordu agenta; `guarded: false` — pola v3, które dziś filtruje `toExerciseDraft`. */
export const RAW_LIST_FIELDS: readonly RawListField[] = [
  { field: "acceptedAnswers", rule: "shape.accepted_answers", issue: (details) => shapeIssue("shape.accepted_answers", details), item: "string", guarded: true },
  { field: "focus", rule: "shape.focus", issue: (details) => shapeIssue("shape.focus", details), item: "string", guarded: true },
  { field: "options", rule: "shape.options", issue: (details) => shapeIssue("shape.options", details), item: ["id", "text"], guarded: true },
  { field: "items", rule: "shape.items", issue: (details) => shapeIssue("shape.items", details), item: ["id", "text"], guarded: true },
  { field: "keywordOptions", rule: "shape.keyword_options", issue: (details) => shapeIssue("shape.keyword_options", details), item: ["id", "text"], guarded: true },
  { field: "keyOptionIds", rule: "shape.key_option_ids", issue: (details) => shapeIssue("shape.key_option_ids", details), item: "string", guarded: true },
  { field: "noticeSegments", rule: "shape.notice_segments", issue: (details) => shapeIssue("shape.notice_segments", details), item: "string_list", guarded: true },
  { field: "pairs", rule: "shape.pairs", issue: (details) => shapeIssue("shape.pairs", details), item: ["left", "right"], guarded: true },
  { field: "extraRight", rule: "shape.extra_right", issue: (details) => shapeIssue("shape.extra_right", details), item: "string", guarded: true },
  { field: "groups", rule: "shape.groups", issue: (details) => shapeIssue("shape.groups", details), item: ["id", "label"], guarded: true },
  { field: "groupItems", rule: "shape.group_items", issue: (details) => shapeIssue("shape.group_items", details), item: ["text", "groupId"], guarded: true },
  { field: "gapAnswers", rule: "shape.gap_answers", issue: (details) => shapeIssue("shape.gap_answers", details), item: "string", guarded: true },
  { field: "extraWords", rule: "shape.extra_words", issue: (details) => shapeIssue("shape.extra_words", details), item: "string", guarded: true },
  { field: "requiredElements", rule: "shape.required_elements", issue: (details) => shapeIssue("shape.required_elements", details), item: ["id", "text"], guarded: false },
  { field: "supplementaryElements", rule: "shape.supplementary_elements", issue: (details) => shapeIssue("shape.supplementary_elements", details), item: "string", guarded: false },
  { field: "commonErrors", rule: "shape.common_errors", issue: (details) => shapeIssue("shape.common_errors", details), item: "string", guarded: false },
  { field: "sourceRefs", rule: "shape.source_refs", issue: (details) => shapeIssue("shape.source_refs", details), item: ["quote"], guarded: false },
];

/**
 * Pola tekstowe (napis albo `null`, reguła `shape.text_field`). Poza tabelą
 * celowo `explanationPl` i `voiceTone`: zły typ znaczy „brak pola” z notą
 * sanityzacji szkicu, nie odrzucenie całego ćwiczenia.
 */
export const RAW_TEXT_FIELDS: readonly { readonly field: string; readonly guarded: boolean }[] = [
  { field: "instructionPl", guarded: true },
  { field: "stem", guarded: true },
  { field: "statement", guarded: true },
  { field: "prompt", guarded: true },
  { field: "hint", guarded: true },
  { field: "transformId", guarded: true },
  { field: "correctOption", guarded: true },
  { field: "clozeText", guarded: true },
  { field: "questionType", guarded: false },
  { field: "expectedForm", guarded: false },
  { field: "familyId", guarded: false },
  { field: "visualSubject", guarded: false },
];

/** Rodzaj otrzymanej wartości do `found` (bez treści). */
function kindOf(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  switch (typeof value) {
    case "string":
      return "a string";
    case "number":
      return "a number";
    case "boolean":
      return "a boolean";
    case "object":
      return "an object";
    default:
      return `a ${typeof value}`;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function itemText(item: RawItemShape): string {
  if (item === "string") return "a string";
  if (item === "string_list") return "a list of strings";
  return `{${item.join(", ")}}`;
}

/** Liczba mnoga kształtu elementu (`a list of …`). */
function itemsText(item: RawItemShape): string {
  if (item === "string") return "strings";
  if (item === "string_list") return "lists of strings";
  return itemText(item);
}

function itemTextPl(item: RawItemShape): string {
  if (item === "string") return "listy napisów";
  if (item === "string_list") return "listy list napisów";
  return `listy obiektów {${item.join(", ")}}`;
}

/** Pierwszy problem elementu listy: ścieżka względem elementu i co nie pasuje; `null` = poprawny. */
function itemProblem(value: unknown, item: RawItemShape): { readonly path: string; readonly found: string } | null {
  if (item === "string") {
    return typeof value === "string" ? null : { path: "", found: `expected a string, got ${kindOf(value)}` };
  }
  if (item === "string_list") {
    if (!Array.isArray(value)) return { path: "", found: `expected a list of strings, got ${kindOf(value)}` };
    const index = value.findIndex((entry) => typeof entry !== "string");
    return index < 0 ? null : { path: `[${index}]`, found: `expected a string, got ${kindOf(value[index])}` };
  }
  if (!isObject(value)) return { path: "", found: `expected ${itemText(item)}, got ${kindOf(value)}` };
  const key = item.find((name) => typeof value[name] !== "string");
  return key === undefined ? null : { path: `.${key}`, found: `expected a string, got ${kindOf(value[key])}` };
}

/** Zgłoszenia jednego pola listowego (najwyżej jedno: pierwszy zły element); nieznane pole → []. */
export function listFieldIssues(record: Readonly<Record<string, unknown>>, field: string): LessonRuleIssue[] {
  const entry = RAW_LIST_FIELDS.find((candidate) => candidate.field === field);
  const value = record[field];
  if (entry === undefined || value === null || value === undefined) return [];
  const pl = `${field}: oczekiwano ${itemTextPl(entry.item)}`;
  if (!Array.isArray(value)) {
    return [entry.issue({
      field,
      pl,
      found: `expected a list of ${itemsText(entry.item)} or null, got ${kindOf(value)}`,
    })];
  }
  for (const [index, element] of value.entries()) {
    const problem = itemProblem(element, entry.item);
    if (problem !== null) {
      const path = `${field}[${index}]${problem.path}`;
      return [entry.issue({ field: path, pl, found: problem.found })];
    }
  }
  return [];
}

/** Zgłoszenie pola tekstowego, które nie jest napisem ani `null`. */
export function textFieldIssues(record: Readonly<Record<string, unknown>>, field: string): LessonRuleIssue[] {
  const value = record[field];
  if (value === null || value === undefined || typeof value === "string") return [];
  return [shapeIssue("shape.text_field", {
    field,
    pl: `${field}: pole tekstowe musi być napisem`,
    found: `expected a string or null, got ${kindOf(value)}`,
  })];
}

/**
 * Pola, które ma tylko jeden typ ćwiczenia. Przebieg kontrolny 2026-11-06: pary i grupy często
 * przychodziły bez `exerciseType`, a typ wynikał jednoznacznie z pól — komunikat go wskazuje.
 */
const TYPE_BY_FIELD: Readonly<Record<string, string>> = {
  pairs: "lesson_match",
  extraRight: "lesson_match",
  groups: "lesson_group",
  groupItems: "lesson_group",
  clozeText: "lesson_cloze",
  gapAnswers: "lesson_cloze",
  extraWords: "lesson_cloze",
  keywordOptions: "lesson_keywords",
  keyOptionIds: "lesson_keywords",
  calculation: "lesson_calculation",
  items: "lesson_order",
  noticeSegments: "lesson_notice",
};

/** Dopisek do braku typu: typ, do którego należą pola rekordu, gdy jest dokładnie jeden. */
function typeHint(record: Readonly<Record<string, unknown>>): string {
  const fields = Object.keys(TYPE_BY_FIELD).filter((field) => record[field] !== null && record[field] !== undefined);
  const types = [...new Set(fields.map((field) => TYPE_BY_FIELD[field]))];
  if (types.length !== 1) return "";
  return `; the fields ${fields.join(", ")} belong to ${types[0]}, so send "exerciseType": "${types[0]}"`;
}

/** Zgłoszenia `shape.record`: rekord nie jest obiektem albo `exerciseType`/`objectiveId` nie są napisami. */
export function rawRecordIssues(raw: unknown): LessonRuleIssue[] {
  if (!isObject(raw)) {
    return [shapeIssue("shape.record", {
      pl: "ćwiczenie: rekord nie jest obiektem",
      found: `the exercise is ${kindOf(raw)}, not an object`,
    })];
  }
  return (["exerciseType", "objectiveId"] as const).flatMap((field) =>
    typeof raw[field] === "string"
      ? []
      : [shapeIssue("shape.record", {
        field,
        pl: `${field}: wymagany napis`,
        found: `expected a string, got ${kindOf(raw[field])}${field === "exerciseType" ? typeHint(raw) : ""}`,
      })],
  );
}

/**
 * Zgłoszenia kształtu rekordu agenta (po materializacji): `shape.record`, potem
 * `answer` (tylko przy napisie `exerciseType`), pola tekstowe, listy (`RAW_LIST_FIELDS`) i `calculation`. Pusta lista =
 * `toExerciseDraft` niczego nie zgubi po cichu; treść sprawdza walidacja ćwiczenia.
 */
export function rawShapeIssues(raw: unknown): LessonRuleIssue[] {
  const recordIssues = rawRecordIssues(raw);
  if (!isObject(raw)) return recordIssues;
  const issues = [...recordIssues];
  // Bez typu nie wiadomo, czy odpowiedź podaje model, czy liczy ją kod (materializacja pomija rekord).
  if (typeof raw.exerciseType === "string" && typeof raw.answer !== "string") {
    issues.push(shapeIssue("shape.answer", {
      pl: "answer: odpowiedź musi być napisem",
      found: `expected a string, got ${kindOf(raw.answer)}`,
    }));
  }
  for (const { field } of RAW_TEXT_FIELDS) issues.push(...textFieldIssues(raw, field));
  for (const { field } of RAW_LIST_FIELDS) issues.push(...listFieldIssues(raw, field));
  const calculation = raw.calculation;
  if (calculation !== null && calculation !== undefined && !isObject(calculation)) {
    issues.push(shapeIssue("shape.calculation", {
      pl: "calculation: oczekiwano obiektu specyfikacji obliczenia",
      found: `expected an object {kind, unit, params, templateFamilyId}, got ${kindOf(calculation)}`,
    }));
  }
  return issues;
}

/** Zgłoszenie ćwiczenia innego zagadnienia niż to, nad którym pracuje podagent. */
export function foreignObjectiveIssues(objectiveId: string, expected: string): LessonRuleIssue[] {
  if (objectiveId === expected) return [];
  return [shapeIssue("shape.objective_id", {
    pl: "objectiveId: ćwiczenie innego zagadnienia",
    found: `objectiveId must be "${expected}" (this objective), not ${clip(objectiveId)}`,
  })];
}

function itemSchema(item: RawItemShape): z.ZodType {
  if (item === "string") return z.string();
  if (item === "string_list") return z.array(z.string());
  return z.object(Object.fromEntries(item.map((key) => [key, z.string()]))).passthrough();
}

/**
 * Dzisiejszy schemat KSZTAŁTU surowego ćwiczenia (nie semantyki), z tej samej
 * tabeli: wymagane napisy `exerciseType`, `objectiveId` i `answer`, pola
 * tekstowe i listy z `guarded`. Chroni walidację semantyczną przed rekordami,
 * których tablice mają zły typ elementów (np. `options=[null,{…}]`), bez
 * wywracania całego runu (wymóg 2.5). `passthrough` — pól dodatkowych nie odrzuca.
 */
const rawExerciseShapeSchema = z
  .object({
    exerciseType: z.string(),
    objectiveId: z.string(),
    answer: z.string(),
    ...Object.fromEntries(RAW_TEXT_FIELDS.filter((entry) => entry.guarded).map((entry) => [entry.field, z.string().nullish()])),
    ...Object.fromEntries(
      RAW_LIST_FIELDS.filter((entry) => entry.guarded).map((entry) => [entry.field, z.array(itemSchema(entry.item)).nullish()]),
    ),
  })
  .passthrough();

/**
 * Łagodny strażnik kształtu (punkt kontrolny agenta i ścieżki bez zgłoszeń):
 * dzisiejsza semantyka — pól v3 spoza `guarded` nie sprawdza.
 */
export function hasLenientRawShape(raw: unknown): boolean {
  return isObject(raw) && rawExerciseShapeSchema.safeParse(raw).success;
}
