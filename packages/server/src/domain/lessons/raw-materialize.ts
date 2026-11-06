import { CalculationSpecSchema, messages } from "@learning/contracts";
import { calculationIssues, computeCalculationAnswer, renderCalculationPrompt } from "./calculation";
import { clozeAnswer } from "./cloze";
import { groupAnswer, keywordsAnswer, matchAnswer } from "./pool-validation";
import { listFieldIssues, rawRecordIssues, textFieldIssues } from "./raw-shape";
import { issueFrom, type LessonRuleIssue } from "./rules/catalog";
import { CORE_RULES } from "./rules/core-rules";

/**
 * Materializacja surowych rekordów agenta puli (spec katalogu reguł §4.3):
 * model w gałęziach rachunku, słów kluczowych, par, grup i luk z bankiem nie
 * podaje `answer` — kod dopisuje polecenie (wspólne albo domyślne), treść
 * rachunku i kanoniczną odpowiedź, zanim rekord trafi do kształtu i walidacji.
 *
 * - Idempotencja (rozstrzygnięcie kontrolera): rekord, którego `answer` równa się
 *   odpowiedzi liczonej przez kod, przechodzi jako wynik materializacji z jego
 *   `explanationPl` (fake agenta i testy wysyłają rekordy gotowe z wyjaśnieniem);
 *   pola, których materializacja nie wydaje, znikają. Inny `answer` (także
 *   wstrzyknięty) — materializacja jak bez `answer`.
 * - Pola, których materializacja dziś nie przenosi (np. `explanationPl` par i
 *   grup, ton rachunku), pomija dalej: zmiana treści dla dziecka wymagałaby
 *   decyzji właściciela (test).
 * - Wadliwy rekord daje zgłoszenia reguł (kształt pól, specyfikacja rachunku),
 *   nie wyjątek. Czysta domena.
 */

export type RawMaterialization =
  | { readonly ok: true; readonly record: Record<string, unknown> }
  | { readonly ok: false; readonly exerciseType: string; readonly issues: LessonRuleIssue[] };

const coreIssue = issueFrom(CORE_RULES);

type Materializer = (record: Record<string, unknown>) => RawMaterialization;

function fail(exerciseType: string, issues: LessonRuleIssue[]): RawMaterialization {
  return { ok: false, exerciseType, issues };
}

/** Lista z rekordu; brak i nie-tablica to pusta lista, jak dziś (liczność sprawdza kontrakt). */
function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Zgłoszenia elementów list (tylko tablice; nie-tablica jest pustą listą). */
function elementIssues(record: Record<string, unknown>, fields: readonly string[]): LessonRuleIssue[] {
  return fields.flatMap((field) => (Array.isArray(record[field]) ? listFieldIssues(record, field) : []));
}

/** Ton lektora z surowego rekordu; `null` i brak pola nie trafiają do wyniku (sanityzacja w szkicu). */
function voiceToneOf(record: Record<string, unknown>): { voiceTone?: string } {
  return typeof record.voiceTone === "string" ? { voiceTone: record.voiceTone } : {};
}

/** Cytaty par, grup i luk: przedmiot bez cytatów dostaje w trybie strict `null`, co oznacza brak pola. */
function quotesOf(record: Record<string, unknown>): { sourceRefs?: unknown } {
  return record.sourceRefs === null || record.sourceRefs === undefined ? {} : { sourceRefs: record.sourceRefs };
}

/** Polecenie modelu albo domyślne, gdy go nie podał (pusty napis też). */
function instructionOf(record: Record<string, unknown>, fallback: string): string {
  return typeof record.instructionPl === "string" && record.instructionPl.trim() !== "" ? record.instructionPl : fallback;
}

/** Specyfikacja z `tolerance: null` traktowanym jak brak pola (tolerancja 0). */
function withoutNullTolerance(spec: unknown): unknown {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec) || (spec as { tolerance?: unknown }).tolerance !== null) {
    return spec;
  }
  const { tolerance: _null, ...rest } = spec as Record<string, unknown>;
  return rest;
}

const materializeCalculation: Materializer = (record) => {
  const spec = withoutNullTolerance(record.calculation);
  const issues = calculationIssues(spec);
  if (issues.length > 0) return fail("lesson_calculation", issues);
  // `calculationIssues` przepuszcza tylko specyfikację, którą kalkulator przyjmie.
  const calculation = CalculationSpecSchema.parse(spec);
  return {
    ok: true,
    record: {
      exerciseType: "lesson_calculation",
      objectiveId: record.objectiveId,
      // Gałąź modelu nie ma polecenia; kod dopisuje wspólne.
      instructionPl: messages.kid.lessonCalculationInstruction,
      calculation,
      prompt: renderCalculationPrompt(calculation),
      answer: computeCalculationAnswer(calculation).answer,
      acceptedAnswers: [],
      focus: [],
      // Cytaty modelu zostają do zwykłej walidacji uziemienia i zdjęcia flag.
      sourceRefs: record.sourceRefs,
    },
  };
};

const materializeKeywords: Materializer = (record) => {
  const issues = elementIssues(record, ["keywordOptions", "keyOptionIds"]);
  if (issues.length > 0) return fail("lesson_keywords", issues);
  const keywordOptions = listOf(record.keywordOptions) as { id: string; text: string }[];
  const keyOptionIds = listOf(record.keyOptionIds) as string[];
  return {
    ok: true,
    record: {
      exerciseType: "lesson_keywords",
      objectiveId: record.objectiveId,
      instructionPl: messages.kid.lessonKeywordsInstruction,
      familyId: record.familyId,
      keywordOptions,
      keyOptionIds,
      answer: keywordsAnswer({ keywordOptions, keyOptionIds }),
      acceptedAnswers: [],
      focus: [],
      sourceRefs: record.sourceRefs,
      ...voiceToneOf(record),
    },
  };
};

const materializeMatch: Materializer = (record) => {
  const issues = elementIssues(record, ["pairs", "extraRight"]);
  if (issues.length > 0) return fail("lesson_match", issues);
  const pairs = listOf(record.pairs) as { left: string; right: string }[];
  return {
    ok: true,
    record: {
      exerciseType: "lesson_match",
      objectiveId: record.objectiveId,
      instructionPl: instructionOf(record, messages.kid.lessonMatchInstruction),
      pairs: pairs.map((pair) => ({ left: pair.left, right: pair.right })),
      extraRight: listOf(record.extraRight),
      answer: matchAnswer({ pairs }),
      acceptedAnswers: [],
      focus: [],
      ...quotesOf(record),
      ...voiceToneOf(record),
    },
  };
};

const materializeGroup: Materializer = (record) => {
  const issues = elementIssues(record, ["groups", "groupItems"]);
  if (issues.length > 0) return fail("lesson_group", issues);
  const groups = listOf(record.groups) as { id: string; label: string }[];
  const groupItems = listOf(record.groupItems) as { text: string; groupId: string }[];
  return {
    ok: true,
    record: {
      exerciseType: "lesson_group",
      objectiveId: record.objectiveId,
      instructionPl: instructionOf(record, messages.kid.lessonGroupInstruction),
      groups: groups.map((group) => ({ id: group.id, label: group.label })),
      groupItems: groupItems.map((item) => ({ text: item.text, groupId: item.groupId })),
      answer: groupAnswer({ groups }),
      acceptedAnswers: [],
      focus: [],
      ...quotesOf(record),
      ...voiceToneOf(record),
    },
  };
};

const materializeCloze: Materializer = (record) => {
  const clozeText = record.clozeText;
  if (typeof clozeText !== "string") {
    const textIssues = textFieldIssues(record, "clozeText");
    return fail("lesson_cloze", textIssues.length > 0 ? textIssues : [coreIssue("cloze.text_required", {
      pl: "clozeText: wymagany tekst z lukami dla „lesson_cloze”",
      found: "clozeText is missing",
    })]);
  }
  const issues = elementIssues(record, ["gapAnswers", "extraWords"]);
  if (issues.length > 0) return fail("lesson_cloze", issues);
  const gapAnswers = listOf(record.gapAnswers) as string[];
  return {
    ok: true,
    record: {
      exerciseType: "lesson_cloze",
      objectiveId: record.objectiveId,
      instructionPl: instructionOf(record, messages.kid.lessonClozeInstruction),
      clozeText,
      gapAnswers,
      extraWords: listOf(record.extraWords),
      answer: clozeAnswer({ gapAnswers }),
      acceptedAnswers: [],
      focus: [],
      ...quotesOf(record),
      ...voiceToneOf(record),
    },
  };
};

/** Typy, których odpowiedź liczy kod. */
const MATERIALIZERS: ReadonlyMap<string, Materializer> = new Map([
  ["lesson_calculation", materializeCalculation],
  ["lesson_keywords", materializeKeywords],
  ["lesson_match", materializeMatch],
  ["lesson_group", materializeGroup],
  ["lesson_cloze", materializeCloze],
]);

/**
 * Rekord gotowy (odpowiedź zgodna z liczoną): wynik materializacji bez pustych list,
 * których rekord nie miał (np. `extraRight`), i z wyjaśnieniem błędu rekordu.
 */
function passedThrough(record: Record<string, unknown>, materialized: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(materialized)) {
    const added = record[key] === undefined && Array.isArray(value) && value.length === 0;
    if (!added) out[key] = value;
  }
  if (record.explanationPl !== undefined) out.explanationPl = record.explanationPl;
  return out;
}

/**
 * Surowy rekord agenta → rekord do kształtu i walidacji. Nie-obiekt daje
 * `shape.record`; typ spoza liczonych przechodzi bez zmian.
 */
export function materializeRawExercise(raw: unknown): RawMaterialization {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fail("unknown", rawRecordIssues(raw));
  const record = raw as Record<string, unknown>;
  const materializer = typeof record.exerciseType === "string" ? MATERIALIZERS.get(record.exerciseType) : undefined;
  if (materializer === undefined) return { ok: true, record };
  const result = materializer(record);
  if (!result.ok || typeof record.answer !== "string" || record.answer !== result.record.answer) return result;
  return { ok: true, record: passedThrough(record, result.record) };
}
