/**
 * Walidacja puli ćwiczeń lekcji (design „Generowanie puli (worker)”). Czysta
 * domena: subject-agnostyczna — reguły ogólne żyją tu, reguły specyficzne dla
 * przedmiotu dokłada `subject.validateExercise`. Bez bazy, sieci i zegara.
 *
 * Walidacja działa jednakowo przy generowaniu puli (worker) i przy edycji
 * ćwiczenia przez rodzica. Każde złamanie reguły to zgłoszenie z katalogu
 * rdzenia (`rules/core-rules.ts`): `pl` — komunikat po polsku dla rodzica, z
 * nazwą pola, spójny stylistycznie z `catalog-validation.ts`; `found` — po
 * angielsku, co konkretnie jest nie tak (dla agenta). Limity są nazwanymi,
 * eksportowanymi stałymi — żadnych rozsianych literałów.
 */

import type { z } from "zod";
import {
  LessonExerciseInputSchema,
  lessonGapCount,
  MAX_CLOZE_EXTRA,
  MAX_CLOZE_GAPS,
  MAX_GROUP_ITEMS,
  MAX_GROUPS,
  MAX_KEY_OPTIONS,
  MAX_KEYWORD_OPTIONS,
  MAX_LESSON_TEXT_LENGTH,
  MAX_MATCH_EXTRA,
  MAX_MATCH_PAIRS,
  MAX_OPTIONS,
  MAX_ORDER_ITEMS,
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
} from "@learning/contracts";
import { clozeAnswer, clozeGapCount, clozeParts } from "./cloze";
import { feedbackSentenceText, fillGap } from "./feedback-sentence-text";
import { ASSESSED_STAGES, outsideStagePath, stageOf } from "./stages";
import type {
  AnswerNormalizer,
  LearningObjective,
  LessonExerciseDraft,
  LessonExerciseType,
  LessonStage,
  LessonTopic,
  SubjectModule,
} from "./types";
import { explanationIssues } from "./exercise-explanation";
import { clip, issueFrom, messagesOf, type LessonRuleIssue } from "./rules/catalog";
import { CORE_RULES } from "./rules/core-rules";
import { LESSON_RULES } from "./rules/lesson-rules";
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
} from "./rules/limits";
import {
  lessonExerciseIdentity,
  lessonExerciseStimulus,
  lessonIdentityOptionsOf,
  type LessonExerciseIdentityOptions,
} from "./exercise-identity";
import type { PoolMinimums } from "./lesson-policy";
import { APOSTROPHE_VARIANTS } from "./normalize";

/** Fabryka zgłoszeń reguł rdzenia. */
const coreIssue = issueFrom(CORE_RULES);

/** Fabryka zgłoszeń reguł lekcji (cała pula). */
const lessonIssue = issueFrom(LESSON_RULES);

/** Znacznik luki w `stem` ćwiczenia `lesson_gap` (stała w `rules/limits.ts`, bo podaje ją opis reguły). */
export { GAP_MARKER };

/** Maksymalna długość pojedynczego pola tekstowego ćwiczenia (znaki), także wyjaśnienia błędu — limit z kontraktów. */
export const MAX_TEXT_LENGTH = MAX_LESSON_TEXT_LENGTH;

/**
 * Limity walidatorów (stałe w `rules/limits.ts`, bo podają je opisy reguł):
 * warianty `acceptedAnswers`, zdania i segmenty `lesson_notice`, tokeny
 * odpowiedzi `lesson_gap`.
 */
export {
  MAX_ACCEPTED_ANSWERS,
  MAX_GAP_ANSWER_TOKENS,
  MAX_NOTICE_SEGMENTS,
  MAX_NOTICE_SENTENCES,
  MIN_NOTICE_SEGMENTS,
  MIN_NOTICE_SENTENCES,
};

/** Zakresy liczby elementów `lesson_order` i opcji wyboru — limity z kontraktów. */
export { MAX_OPTIONS, MAX_ORDER_ITEMS, MIN_OPTIONS, MIN_ORDER_ITEMS };

/** `lesson_cloze`: słowo luki i słowo-pułapka mają 1–3 słowa (design szkoły §13.1; stała w `rules/limits.ts`). */
export { MAX_CLOZE_WORD_TOKENS };

/** Typy tekstowe (wolna odpowiedź dziecka) — wymagają niepustego `focus`. */
const TEXT_TYPES: ReadonlySet<LessonExerciseType> = new Set<LessonExerciseType>([
  "lesson_gap",
  "lesson_error_fix",
  "lesson_transform",
  "lesson_open_answer",
]);

/** Pola tekstowe podlegające limitowi długości (payload „Data Models”). */
const TEXT_FIELDS = ["instructionPl", "stem", "statement", "prompt", "hint"] as const;

/** Typy tekstowe, których odpowiedzi nie może ujawniać zdanie ćwiczenia słuchowego. */
const LISTEN_CROSS_CHECK_TYPES: ReadonlySet<LessonExerciseType> = new Set<LessonExerciseType>([
  "lesson_open_answer",
  "lesson_transform",
  "lesson_error_fix",
]);

/** Klucz wariantu normalizacji (sekwencja tokenów) do porównań zbiorowych. */
function sequenceKey(tokens: readonly string[]): string {
  return tokens.join("\u0000");
}

/**
 * Zbiór kluczy wariantów normalizacji tekstu (dowolny wspólny = równoważność).
 * Pomija puste sekwencje — jak `matchLessonAnswer`, gdzie pusta odpowiedź nigdy nie pasuje.
 */
function variantKeys(text: string, normalizer: AnswerNormalizer): Set<string> {
  const keys = new Set<string>();
  for (const sequence of normalizer.normalize(text)) {
    if (sequence.length > 0) keys.add(sequenceKey(sequence));
  }
  return keys;
}

/**
 * Czy dwa teksty mają wspólny wariant normalizacji (równoważne odpowiedzi).
 * Eksportowane, by materializacja (`modules/lessons/lesson-materialize.ts`)
 * dopasowywała `correctOption` segmentu `lesson_notice` DOKŁADNIE tak samo jak
 * walidator (`validateNotice`) — jedna semantyka równoważności, bez duplikatu.
 */
export function answersEquivalent(a: string, b: string, normalizer: AnswerNormalizer): boolean {
  const keysB = variantKeys(b, normalizer);
  for (const key of variantKeys(a, normalizer)) {
    if (keysB.has(key)) {
      return true;
    }
  }
  return false;
}

/** Czy `needle` jest ciągłą podsekwencją `haystack`. */
function isContiguousSubsequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) {
    return false;
  }
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    let matched = true;
    for (let k = 0; k < needle.length; k++) {
      if (haystack[start + k] !== needle[k]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
  }
  return false;
}

/**
 * Czy `focus` jest ciągłą podsekwencją tokenów odpowiedzi kanonicznej w DOWOLNYM
 * wariancie normalizacji — dla któregokolwiek wariantu `focus` i odpowiedzi.
 */
function focusCoversAnswer(
  focus: readonly string[],
  answer: string,
  normalizer: AnswerNormalizer,
): boolean {
  const focusVariants = normalizer.normalize(focus.join(" ")).filter((seq) => seq.length > 0);
  const answerVariants = normalizer.normalize(answer).filter((seq) => seq.length > 0);
  for (const answerSeq of answerVariants) {
    for (const focusSeq of focusVariants) {
      if (isContiguousSubsequence(answerSeq, focusSeq)) {
        return true;
      }
    }
  }
  return false;
}

/** Pierwszy wariant tokenizacji (dla reguł liczących tokeny bez rozwijania). */
function anyTokens(text: string, normalizer: AnswerNormalizer): readonly string[] {
  const variants = normalizer.normalize(text);
  return variants[0] ?? [];
}

/** Opcja zaczynająca się od apostrofu w dowolnym zapisie: `'`, typograficzne warianty i grawis. */
const LEADING_APOSTROPHE = new RegExp(`^(?:['\\u0060]|${APOSTROPHE_VARIANTS.source})`, "u");

/** Lista identyfikatorów do `found` (wycięta, bez cudzysłowu); pusta lista = „none”. */
function idList(ids: readonly string[]): string {
  return ids.length === 0 ? "none" : clip(ids.join(", "), undefined, { quote: false });
}

/** `found` brakującego albo pustego pola tekstowego. */
function missingText(field: string, value: string | undefined): string {
  return value === undefined ? `${field} is missing` : `${field} is blank`;
}

// ---------------------------------------------------------------------------
// Kontrakt (Zod) → zgłoszenia reguł (spec katalogu reguł §4.2).
// ---------------------------------------------------------------------------

/** Błąd kontraktu z `safeParse` (Zod 4). */
type ContractIssue = z.core.$ZodIssue;

/** Ścieżka pola w zapisie `sourceRefs[1].quote`; pusta ścieżka = `exercise`. */
function fieldPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    out += typeof segment === "number" ? `[${segment}]` : out === "" ? String(segment) : `.${String(segment)}`;
  }
  return out === "" ? "exercise" : out;
}

/** Wartość szkicu pod ścieżką błędu kontraktu (`undefined`, gdy jej nie ma). */
function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = input;
  for (const segment of path) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

/** Otrzymana wartość do `found`: napis w cudzysłowie, reszta jako wycięty JSON. */
function describeValue(value: unknown): string {
  if (value === undefined) {
    return "nothing";
  }
  if (typeof value === "string") {
    return clip(value);
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  return clip(json ?? String(value), undefined, { quote: false });
}

/** Dzisiejszy komunikat rodzica dla błędu kontraktu (znak w znak). */
function contractMessage(issue: ContractIssue): string {
  const detail = issue.code === "too_big"
    ? `przekracza limit ${issue.maximum}`
    : issue.code === "too_small"
      ? `wymagane minimum ${issue.minimum}`
      : "nieprawidłowy typ lub wartość";
  return `${issue.path.join(".")}: ${detail}`;
}

/**
 * Liczność listy poza zakresem kontraktu. Listy z własną regułą rdzenia (opcje,
 * klocki, warianty, zdania i segmenty `lesson_notice`, pary, grupy, luki z bankiem,
 * słowa kluczowe) dostają jej id — ta sama
 * granica co w walidatorze, jeden opis dla modelu; pozostałe `field.count`.
 */
function contractCountIssue(issue: ContractIssue, details: { field: string; pl: string; found: string }): LessonRuleIssue {
  const [head] = issue.path;
  if (head === "options" && issue.path.length === 1) return coreIssue("options.count", details);
  if (head === "items" && issue.path.length === 1) return coreIssue("order.items_count", details);
  if (head === "acceptedAnswers" && issue.path.length === 1) return coreIssue("variants.count", details);
  if (head === "noticeSegments" && issue.path.length === 1) return coreIssue("notice.sentence_count", details);
  if (head === "noticeSegments" && issue.path.length === 2) return coreIssue("notice.segment_count", details);
  if (issue.path.length === 1) {
    switch (head) {
      case "pairs": return coreIssue("match.pairs_count", details);
      case "extraRight": return coreIssue("match.extra_count", details);
      case "groups": return coreIssue("group.groups_count", details);
      case "groupItems": return coreIssue("group.items_count", details);
      case "gapAnswers": return coreIssue("cloze.gap_count", details);
      case "extraWords": return coreIssue("cloze.extra_count", details);
      case "keywordOptions": return coreIssue("keywords.options_count", details);
      case "keyOptionIds": return coreIssue("keywords.key_count", details);
      default: break;
    }
  }
  return coreIssue("field.count", details);
}

/**
 * Zgłoszenie reguły dla jednego błędu kontraktu (tabela spec §4.2): pusty napis →
 * `field.empty`; długość napisu → `field.max_length` (odpowiedź i warianty →
 * `answer.max_length`); liczność listy → `field.count` albo reguła listy; reszta →
 * `field.invalid` z otrzymaną wartością odczytaną ze szkicu i oczekiwaniem z Zod.
 */
function contractIssue(issue: ContractIssue, input: unknown): LessonRuleIssue {
  const field = fieldPath(issue.path);
  const pl = contractMessage(issue);
  const value = valueAt(input, issue.path);
  const got = describeValue(value);
  switch (issue.code) {
    case "too_small":
    case "too_big": {
      const bound = issue.code === "too_small" ? `at least ${issue.minimum}` : `at most ${issue.maximum}`;
      if (issue.origin === "string") {
        if (issue.code === "too_small" && Number(issue.minimum) === 1) {
          return coreIssue("field.empty", { field, pl, found: "empty string" });
        }
        const length = typeof value === "string" ? value.length : 0;
        const found = issue.code === "too_small"
          ? `${length} characters, minimum ${issue.minimum}`
          : `${length} characters, limit ${issue.maximum}`;
        const [head] = issue.path;
        if (issue.code === "too_big" && (head === "answer" || head === "acceptedAnswers")) {
          return coreIssue("answer.max_length", { field, pl, found });
        }
        return coreIssue("field.max_length", { field, pl, found });
      }
      if (issue.origin === "array") {
        const count = Array.isArray(value) ? value.length : 0;
        return contractCountIssue(issue, { field, pl, found: `${count} items, ${bound}` });
      }
      return coreIssue("field.invalid", { field, pl, found: `got ${got}; expected ${bound}` });
    }
    case "invalid_type":
      return coreIssue("field.invalid", { field, pl, found: `got ${got}; expected ${issue.expected}` });
    case "invalid_value":
      return coreIssue("field.invalid", {
        field,
        pl,
        found: `got ${got}; expected one of ${clip(issue.values.map((v) => JSON.stringify(v)).join(", "), undefined, { quote: false })}`,
      });
    case "unrecognized_keys":
      return coreIssue("field.invalid", { field, pl, found: `unknown field ${clip(issue.keys.join(", "))}; leave it out` });
    case "invalid_format":
      return coreIssue("field.invalid", { field, pl, found: `got ${got}; expected format ${issue.format}` });
    case "invalid_union":
      return coreIssue("field.invalid", { field, pl, found: `got ${got}; matches none of the allowed shapes` });
    default:
      return coreIssue("field.invalid", { field, pl, found: `got ${got}; fails the contract check` });
  }
}

/**
 * Pola źródłowe odpowiedzi liczonej przez kod (pary, grupy, luki z bankiem,
 * słowa kluczowe, rachunek). Błąd kontraktu o `answer` takiego typu wynika z
 * pola źródłowego, więc dostaje jego ścieżkę (spec §4.2; `pl` bez zmian). Na
 * ścieżce agenta znika, gdy pole źródłowe ma własne zgłoszenie; rodzic dostaje
 * go dalej, żeby zbiór jego komunikatów się nie zmienił.
 */
const COMPUTED_ANSWER_SOURCES: Partial<Record<LessonExerciseType, readonly string[]>> = {
  lesson_match: ["pairs"],
  lesson_group: ["groups"],
  lesson_cloze: ["gapAnswers"],
  lesson_keywords: ["keyOptionIds", "keywordOptions"],
  lesson_calculation: ["calculation"],
};

/**
 * Zgłoszenia kontraktu dla wszystkich błędów `safeParse` naraz (`agent` — ścieżka
 * agenta, zob. `LessonExerciseValidationOptions`). Eksportowane do testów tabeli Zod.
 */
export function contractIssues(
  issues: readonly ContractIssue[],
  input: unknown,
  options: { readonly agent?: boolean } = {},
): LessonRuleIssue[] {
  const exerciseType = valueAt(input, ["exerciseType"]);
  const sources = typeof exerciseType === "string"
    ? COMPUTED_ANSWER_SOURCES[exerciseType as LessonExerciseType]
    : undefined;
  const sourceReported = options.agent === true && sources !== undefined &&
    issues.some((issue) => sources.includes(String(issue.path[0])));
  const result: LessonRuleIssue[] = [];
  for (const issue of issues) {
    const ruleIssue = contractIssue(issue, input);
    if (sources !== undefined && issue.path[0] === "answer") {
      if (sourceReported) {
        continue;
      }
      result.push({ ...ruleIssue, field: sources[0]!, found: `answer computed from ${sources[0]!}: ${ruleIssue.found ?? ""}` });
      continue;
    }
    result.push(ruleIssue);
  }
  return result;
}

/** Opcjonalne pola tekstowe szkicu: pusty napis w nich nie przeszkadza dalszej analizie. */
const OPTIONAL_TEXT_FIELDS: ReadonlySet<string> = new Set([
  "instructionPl",
  "stem",
  "statement",
  "prompt",
  "hint",
  "transformId",
  "correctOption",
  "familyId",
  "clozeText",
  "explanationPl",
]);

/**
 * Pola, które zgłosił kontrakt jako puste, gdy WSZYSTKIE błędy kontraktu to puste
 * napisy w opcjonalnych polach tekstowych; inaczej `null`.
 */
function onlyEmptyOptionalTexts(issues: readonly ContractIssue[], input: unknown): string[] | null {
  const fields: string[] = [];
  for (const issue of issues) {
    const [head] = issue.path;
    if (
      issue.code !== "too_small" || issue.origin !== "string" || issue.path.length !== 1 ||
      typeof head !== "string" || !OPTIONAL_TEXT_FIELDS.has(head) || valueAt(input, issue.path) !== ""
    ) {
      return null;
    }
    fields.push(head);
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Reguły ćwiczenia.
// ---------------------------------------------------------------------------

/** Piktogram bodźca (`visualSubject`) jest dozwolony tylko przy wyborze z listy. */
function validateVisualSubject(ex: LessonExerciseDraft, issues: LessonRuleIssue[]): void {
  if (ex.visualSubject !== undefined && ex.exerciseType !== "lesson_choice") {
    issues.push(coreIssue("visual.choice_only", {
      pl: "visualSubject: piktogram jest dozwolony tylko dla „lesson_choice”",
      found: `visualSubject ${clip(ex.visualSubject)} is set on ${ex.exerciseType}`,
    }));
  }
}

/**
 * Pola v3 szkicu ćwiczenia (przedmioty z `usesV3Payload`); przedmiot bez v3
 * odrzuca ćwiczenie, które któreś niesie. Jedyne źródło listy — czyszczenie
 * świeżego wyjścia modelu w przedmiotach bez v3 (np. `english_chapter`) czyta
 * ją stąd, żeby nowe pole v3 nie rozjechało walidacji z czyszczeniem.
 */
export const V3_EXERCISE_FIELDS = [
  "questionType",
  "requiredElements",
  "supplementaryElements",
  "commonErrors",
  "expectedForm",
  "familyId",
  "sourceRefs",
  "calculation",
] as const satisfies readonly (keyof LessonExerciseDraft)[];

export type V3ExerciseField = (typeof V3_EXERCISE_FIELDS)[number];

/** Pola v3 obecne w szkicu (nazwy do komunikatu walidacji). */
function v3FieldsPresent(ex: LessonExerciseDraft): V3ExerciseField[] {
  return V3_EXERCISE_FIELDS.filter((field) => ex[field] !== undefined);
}

/** Opcje walidacji ćwiczenia. */
export interface LessonExerciseValidationOptions {
  /**
   * Ścieżka agenta (przyjmowanie puli). Rodzic dostaje dzisiejszy zbiór
   * komunikatów, więc API edycji i publikacji tej opcji nie używa. Włącza:
   * - ponowną analizę po pustych napisach: gdy kontrakt odrzuca wyłącznie puste
   *   napisy w opcjonalnych polach tekstowych, pozostałe reguły liczymy raz
   *   jeszcze na kopii bez tych pól i zgłaszamy razem (ćwiczenie i tak jest
   *   odrzucone; agent poprawia wszystko naraz), bez zgłoszeń o zdjętych polach
   *   (te ma już `field.empty`);
   * - pominięcie zgłoszenia kontraktu o `answer` typu liczonego, gdy pole
   *   źródłowe ma własne zgłoszenie (`contractIssues`).
   */
  readonly agent?: boolean;
}

/** Kopia szkicu bez wskazanych pól. */
function withoutFields(ex: LessonExerciseDraft, fields: readonly string[]): LessonExerciseDraft {
  return Object.fromEntries(Object.entries(ex).filter(([key]) => !fields.includes(key))) as unknown as LessonExerciseDraft;
}

/**
 * Szkic do sprawdzeń poza walidacją ćwiczenia na ścieżce agenta (bramka przedmiotu; spec katalogu
 * reguł §4.2): szkic bez zmian, gdy kontrakt przechodzi; kopia bez pustych napisów w opcjonalnych
 * polach tekstowych (`stripped` — zdjęte pola), gdy to jedyne błędy kontraktu — jak ponowna analiza
 * w `validateLessonExerciseIssues`; `null` przy innych błędach kontraktu (dalszych reguł się nie liczy).
 */
export function agentReanalysisDraft(
  ex: LessonExerciseDraft,
): { readonly draft: LessonExerciseDraft; readonly stripped: readonly string[] } | null {
  const shape = LessonExerciseInputSchema.safeParse(ex);
  if (shape.success) return { draft: ex, stripped: [] };
  const empty = onlyEmptyOptionalTexts(shape.error.issues, ex);
  return empty === null ? null : { draft: withoutFields(ex, empty), stripped: empty };
}

/**
 * Reguły ogólne dla ćwiczenia (design „Generowanie puli”), a następnie
 * delegacja do `subject.validateExercise`. Zwraca zgłoszenia reguł; pusta
 * lista = ćwiczenie poprawne. Nie rzuca — zbiera wszystkie naruszenia. Przy
 * błędzie kontraktu dalszych reguł nie sprawdza (wyjątek: ścieżka agenta, `agent`).
 */
export function validateLessonExerciseIssues(
  ex: LessonExerciseDraft,
  subject: SubjectModule,
  topic: LessonTopic,
  options: LessonExerciseValidationOptions = {},
): LessonRuleIssue[] {
  const shape = LessonExerciseInputSchema.safeParse(ex);
  if (!shape.success) {
    const contract = contractIssues(shape.error.issues, ex, { agent: options.agent === true });
    const empty = options.agent === true ? onlyEmptyOptionalTexts(shape.error.issues, ex) : null;
    if (empty === null) {
      return contract;
    }
    const further = validateLessonExerciseIssues(withoutFields(ex, empty), subject, topic, options)
      .filter((issue) => !empty.includes(issue.field));
    return [...contract, ...further];
  }

  const issues: LessonRuleIssue[] = [];
  const normalizer = subject.normalizer;

  // Karta pochodzi z katalogu, nie z puli ćwiczeń.
  if (ex.exerciseType === "lesson_card") {
    issues.push(coreIssue("exercise.card_not_allowed", {
      pl: "exerciseType: „lesson_card” nie jest ćwiczeniem puli (karty pochodzą z katalogu)",
    }));
  }

  // Cel istnieje w temacie.
  const objective = topic.objectives.find((o) => o.id === ex.objectiveId);
  if (objective === undefined) {
    issues.push(coreIssue("exercise.unknown_objective", {
      pl: `objectiveId: cel „${ex.objectiveId}” nie istnieje w temacie „${topic.id}”`,
      found: `${clip(ex.objectiveId)} is not an objective of the topic; objectives: ${idList(topic.objectives.map((o) => o.id))}`,
    }));
  }

  // Typ dozwolony dla przedmiotu i dla celu.
  if (!subject.exerciseTypes.includes(ex.exerciseType)) {
    issues.push(coreIssue("exercise.type_unsupported", {
      pl: `exerciseType: typ „${ex.exerciseType}” nie jest wspierany przez przedmiot`,
      found: `${ex.exerciseType} is not a type of the subject; types: ${idList(subject.exerciseTypes)}`,
    }));
  }
  if (objective !== undefined && !objective.exerciseTypes.includes(ex.exerciseType)) {
    issues.push(coreIssue("exercise.type_not_allowed", {
      pl: `exerciseType: typ „${ex.exerciseType}” nie jest dozwolony dla celu „${objective.id}”`,
      found: `${ex.exerciseType} is not allowed for this objective; allowed: ${idList(objective.exerciseTypes)}`,
    }));
  }

  // Payload v3 i dłuższy limit odpowiedzi tylko dla przedmiotów, które je deklarują
  // (gramatyka zachowuje kontrakt v2: odpowiedź i warianty ≤ 120 znaków).
  if (subject.usesV3Payload !== true) {
    for (const field of v3FieldsPresent(ex)) {
      issues.push(coreIssue("exercise.v3_field_not_allowed", {
        field,
        pl: `${field}: pole v3 niedozwolone dla przedmiotu „${subject.id}”`,
        found: `${field} is set; this subject does not use the extended payload`,
      }));
    }
    const answerLength = [...ex.answer].length;
    if (answerLength > MAX_TEXT_LENGTH) {
      issues.push(coreIssue("answer.max_length", {
        pl: `answer: przekracza ${MAX_TEXT_LENGTH} znaków`,
        found: `${answerLength} characters, limit ${MAX_TEXT_LENGTH}`,
      }));
    }
    const longVariant = ex.acceptedAnswers.findIndex((a) => [...a].length > MAX_TEXT_LENGTH);
    if (longVariant !== -1) {
      issues.push(coreIssue("answer.max_length", {
        field: `acceptedAnswers[${longVariant}]`,
        pl: `acceptedAnswers: przekracza ${MAX_TEXT_LENGTH} znaków`,
        found: `${[...ex.acceptedAnswers[longVariant]!].length} characters, limit ${MAX_TEXT_LENGTH}`,
      }));
    }
  }

  if (ex.voiceTone !== undefined && subject.ttsForPrompts !== true) {
    issues.push(coreIssue("voice_tone.not_allowed", {
      pl: `voiceTone: ton lektora niedozwolony dla przedmiotu „${subject.id}” (brak nagrań pytań)`,
      found: `voiceTone ${clip(ex.voiceTone)} is set; this subject does not record questions`,
    }));
  }
  // Rachunek nie ma nagrania pytania z tonem (edytor go nie pokazuje, generator nie zwraca).
  if (ex.voiceTone !== undefined && ex.exerciseType === "lesson_calculation") {
    issues.push(coreIssue("voice_tone.not_allowed", {
      pl: "voiceTone: ton lektora niedozwolony dla lesson_calculation",
      found: `voiceTone ${clip(ex.voiceTone)} is set on lesson_calculation`,
    }));
  }
  if (ex.explanationPl !== undefined) {
    if (subject.exerciseExplanations !== true) {
      issues.push(coreIssue("explanation.not_allowed", {
        pl: `explanationPl: wyjaśnienie błędu niedozwolone dla przedmiotu „${subject.id}”`,
        found: "explanationPl is set; this subject does not show error explanations",
      }));
    } else {
      issues.push(...explanationIssues(ex.explanationPl));
    }
  }
  validateVisualSubject(ex, issues);
  validateTypeSpecificFields(ex, issues);
  if (ex.exerciseType === "lesson_listen_choice") {
    // Polecenie dziecka jest stałe z katalogu komunikatów; bodźcem jest nagranie, więc
    // podpowiedź (wskazałaby odpowiedź) i polecenie rodzica nie mają miejsca w payloadzie.
    // `visualSubject` odrzuca już `validateVisualSubject` (tylko `lesson_choice`).
    if (ex.instructionPl?.trim()) {
      issues.push(coreIssue("listen.instruction_not_allowed", {
        pl: "instructionPl: niedozwolone dla „lesson_listen_choice” (polecenie jest stałe)",
        found: `instructionPl ${clip(ex.instructionPl)} is set`,
      }));
    }
    if (ex.hint?.trim()) {
      issues.push(coreIssue("listen.hint_not_allowed", {
        pl: "hint: niedozwolona dla „lesson_listen_choice” (podpowiedź zdradzałaby odpowiedź)",
        found: `hint ${clip(ex.hint)} is set`,
      }));
    }
  }
  validateTextFieldLengths(ex, issues);
  validateFocus(ex, normalizer, issues);
  validateByType(ex, topic, objective, normalizer, issues);
  validateAcceptedAnswers(ex, normalizer, issues);

  // Reguły specyficzne dla przedmiotu.
  issues.push(...subject.validateExercise(ex, topic));

  return issues;
}

/**
 * Komunikaty dla rodzica (`pl`) — dzisiejsze napisy walidacji ćwiczenia, bez
 * ponownej analizy po pustych napisach. Opakowanie `validateLessonExerciseIssues`.
 */
export function validateLessonExercise(
  ex: LessonExerciseDraft,
  subject: SubjectModule,
  topic: LessonTopic,
): string[] {
  return messagesOf(validateLessonExerciseIssues(ex, subject, topic));
}

/** Pola typów szczególnych tylko na swoim typie (rachunek, słowa kluczowe, pary, grupy, luki z bankiem). */
function validateTypeSpecificFields(ex: LessonExerciseDraft, issues: LessonRuleIssue[]): void {
  const present = (fields: readonly (keyof LessonExerciseDraft)[]): string =>
    fields.filter((field) => ex[field] !== undefined).join(" and ");
  if (ex.calculation !== undefined && ex.exerciseType !== "lesson_calculation") {
    issues.push(coreIssue("fields.type_specific", {
      field: "calculation",
      pl: "calculation: parametry są dozwolone tylko dla „lesson_calculation”",
      found: `calculation is set on ${ex.exerciseType}`,
    }));
  }
  if ((ex.keywordOptions !== undefined || ex.keyOptionIds !== undefined) && ex.exerciseType !== "lesson_keywords") {
    issues.push(coreIssue("fields.type_specific", {
      field: "keywordOptions",
      pl: "keywordOptions: pojęcia do wyboru są dozwolone tylko dla „lesson_keywords”",
      found: `${present(["keywordOptions", "keyOptionIds"])} set on ${ex.exerciseType}`,
    }));
  }
  if ((ex.pairs !== undefined || ex.extraRight !== undefined) && ex.exerciseType !== "lesson_match") {
    issues.push(coreIssue("fields.type_specific", {
      field: "pairs",
      pl: "pairs: pary są dozwolone tylko dla „lesson_match”",
      found: `${present(["pairs", "extraRight"])} set on ${ex.exerciseType}`,
    }));
  }
  if ((ex.groups !== undefined || ex.groupItems !== undefined) && ex.exerciseType !== "lesson_group") {
    issues.push(coreIssue("fields.type_specific", {
      field: "groups",
      pl: "groups: grupy są dozwolone tylko dla „lesson_group”",
      found: `${present(["groups", "groupItems"])} set on ${ex.exerciseType}`,
    }));
  }
  if ((ex.clozeText !== undefined || ex.gapAnswers !== undefined || ex.extraWords !== undefined) && ex.exerciseType !== "lesson_cloze") {
    issues.push(coreIssue("fields.type_specific", {
      field: "clozeText",
      pl: "clozeText: tekst z lukami jest dozwolony tylko dla „lesson_cloze”",
      found: `${present(["clozeText", "gapAnswers", "extraWords"])} set on ${ex.exerciseType}`,
    }));
  }
}

/**
 * Długości pól tekstowych (ta sama granica co w kontrakcie — po przejściu
 * kontraktu sprawdzenie nie zgłasza; zostaje jako bezpiecznik walidacji).
 */
function validateTextFieldLengths(ex: LessonExerciseDraft, issues: LessonRuleIssue[]): void {
  for (const field of TEXT_FIELDS) {
    const value = ex[field];
    if (typeof value === "string" && [...value].length > MAX_TEXT_LENGTH) {
      issues.push(coreIssue("field.max_length", {
        field,
        pl: `${field}: przekracza ${MAX_TEXT_LENGTH} znaków`,
        found: `${[...value].length} characters, limit ${MAX_TEXT_LENGTH}`,
      }));
    }
  }
}

function validateFocus(
  ex: LessonExerciseDraft,
  normalizer: AnswerNormalizer,
  issues: LessonRuleIssue[],
): void {
  if (!TEXT_TYPES.has(ex.exerciseType)) {
    return;
  }
  if (ex.focus.length === 0) {
    issues.push(coreIssue("focus.empty", {
      pl: "focus: musi być niepusty dla typu tekstowego",
      found: `focus is empty on ${ex.exerciseType}`,
    }));
    return;
  }
  if (!focusCoversAnswer(ex.focus, ex.answer, normalizer)) {
    issues.push(coreIssue("focus.not_contiguous", {
      pl: "focus: nie jest ciągłą podsekwencją tokenów odpowiedzi kanonicznej",
      found: `focus ${clip(ex.focus.join(" "))} is not a contiguous run of the answer words ${clip(anyTokens(ex.answer, normalizer).join(" "))}`,
    }));
  }
}

function validateByType(
  ex: LessonExerciseDraft,
  topic: LessonTopic,
  objective: LearningObjective | undefined,
  normalizer: AnswerNormalizer,
  issues: LessonRuleIssue[],
): void {
  switch (ex.exerciseType) {
    case "lesson_order":
      validateOrder(ex, normalizer, issues);
      break;
    case "lesson_choice":
      if (!ex.stem?.trim()) {
        issues.push(coreIssue("choice.stem_required", {
          pl: "stem: wymagane zdanie dla „lesson_choice”",
          found: missingText("stem", ex.stem),
        }));
      }
      validateOptions(ex, normalizer, issues);
      break;
    case "lesson_listen_choice":
      validateListenChoice(ex, normalizer, issues);
      break;
    case "lesson_short_answer":
      if (!(ex.prompt ?? ex.stem)?.trim()) {
        issues.push(coreIssue("short_answer.prompt_required", {
          pl: "prompt: wymagane pytanie dla „lesson_short_answer”",
          found: missingText("prompt", ex.prompt ?? ex.stem),
        }));
      }
      validateOptions(ex, normalizer, issues);
      break;
    case "lesson_notice":
      validateNotice(ex, normalizer, issues);
      break;
    case "lesson_gap":
      validateGap(ex, normalizer, issues);
      break;
    case "lesson_error_fix":
      validateErrorFix(ex, normalizer, issues);
      break;
    case "lesson_transform":
      validateTransform(ex, topic, issues);
      break;
    case "lesson_open_answer":
      if (!ex.prompt?.trim()) {
        issues.push(coreIssue("open.prompt_required", {
          pl: "prompt: wymagane pytanie dla „lesson_open_answer”",
          found: missingText("prompt", ex.prompt),
        }));
      }
      break;
    case "lesson_keywords":
      validateKeywords(ex, normalizer, issues);
      break;
    case "lesson_match":
      validateMatch(ex, issues);
      validateNoTextAnswers(ex, issues);
      break;
    case "lesson_group":
      validateGroup(ex, issues);
      validateNoTextAnswers(ex, issues);
      break;
    case "lesson_cloze":
      validateCloze(ex, normalizer, issues);
      validateNoTextAnswers(ex, issues);
      break;
    default:
      break;
  }
  void objective;
}

/** Pełne zdanie `lesson_listen_choice` (poprawna opcja w luce) albo `null` — to, co czyta lektor. */
function listenSentenceOf(ex: LessonExerciseDraft): string | null {
  return feedbackSentenceText({
    exerciseType: ex.exerciseType,
    stem: ex.stem,
    options: ex.options,
    correctOption: ex.correctOption,
  });
}

/**
 * `lesson_listen_choice`: zdanie z jedną luką (2+ podkreśleń), 2–4 opcje, a pełne
 * zdanie z poprawną opcją istnieje i mieści się w limicie nagrania. Opcje nie mogą
 * zaczynać się od apostrofu (lektor czyta całe tokeny) i muszą dawać nierównoważne
 * zdania — „doesn't” i „does not” to ta sama odpowiedź, więc zadanie byłoby dwuznaczne.
 */
function validateListenChoice(
  ex: LessonExerciseDraft,
  normalizer: AnswerNormalizer,
  issues: LessonRuleIssue[],
): void {
  const stem = ex.stem ?? "";
  const gaps = lessonGapCount(stem);
  if (gaps !== 1) {
    issues.push(coreIssue("listen.gap_count", {
      pl: `stem: „lesson_listen_choice” wymaga dokładnie jednej luki (ciągu co najmniej dwóch podkreśleń, znaleziono ${gaps})`,
      found: `${gaps} gaps in ${clip(stem)}`,
    }));
  }
  validateOptions(ex, normalizer, issues);
  const options = ex.options ?? [];
  options.forEach((option, index) => {
    if (LEADING_APOSTROPHE.test(option.text.trim())) {
      issues.push(coreIssue("listen.option_apostrophe", {
        field: `options[${index}]`,
        pl: `options: opcja „${option.text}” zaczyna się od apostrofu (skróty tylko jako całe słowa)`,
        found: `option ${clip(option.text)} starts with an apostrophe`,
      }));
    }
  });
  if (gaps !== 1) {
    return;
  }
  for (let i = 0; i < options.length; i++) {
    for (let j = i + 1; j < options.length; j++) {
      const a = fillGap(stem, options[i]!.text);
      const b = fillGap(stem, options[j]!.text);
      if (a !== undefined && b !== undefined && answersEquivalent(a, b, normalizer)) {
        issues.push(coreIssue("listen.options_equivalent", {
          field: `options[${j}]`,
          pl: `options: zdania z opcjami „${options[i]!.text}” i „${options[j]!.text}” są równoważne po normalizacji`,
          found: `options ${clip(options[i]!.text)} and ${clip(options[j]!.text)} give equivalent sentences`,
        }));
      }
    }
  }
  const correct = options.find((option) => option.id === ex.correctOption);
  if (correct !== undefined && listenSentenceOf(ex) === null) {
    // Ta sama postać zdania co w `feedbackSentenceText` (zwinięte spacje, interpunkcja bez spacji).
    const filled = (fillGap(stem, correct.text) ?? "").trim().replace(/\s+/g, " ").replace(/ ([.,!?])/g, "$1");
    issues.push(coreIssue("listen.sentence_length", {
      pl: `stem: zdanie z wstawioną poprawną opcją jest puste albo dłuższe niż ${FEEDBACK_SENTENCE_MAX_LENGTH} znaków (lektor go nie nagra)`,
      found: filled === ""
        ? "the sentence with the correct option is empty"
        : `the sentence with the correct option has ${filled.length} characters, limit ${FEEDBACK_SENTENCE_MAX_LENGTH}`,
    }));
  }
}

/**
 * `lesson_keywords`: 4–6 unikalnych pojęć, 2–3 kluczowe spośród nich, a
 * `answer` to pojęcia kluczowe złączone „, ” w kolejności `keyOptionIds`
 * (źródło `targetKey`; ocena porównuje wyłącznie identyfikatory).
 */
function validateKeywords(
  ex: LessonExerciseDraft,
  normalizer: AnswerNormalizer,
  issues: LessonRuleIssue[],
): void {
  const options = ex.keywordOptions ?? [];
  const keyIds = ex.keyOptionIds ?? [];
  if (options.length < MIN_KEYWORD_OPTIONS || options.length > MAX_KEYWORD_OPTIONS) {
    issues.push(coreIssue("keywords.options_count", {
      pl: `keywordOptions: liczba pojęć (${options.length}) poza zakresem ${MIN_KEYWORD_OPTIONS}–${MAX_KEYWORD_OPTIONS}`,
      found: `${options.length} keywordOptions, allowed ${MIN_KEYWORD_OPTIONS}–${MAX_KEYWORD_OPTIONS}`,
    }));
  }
  const repeatedOption = firstRepeated(options.map((option) => option.id));
  if (repeatedOption !== undefined) {
    issues.push(coreIssue("keywords.option_ids_unique", {
      field: `keywordOptions[${repeatedOption.index}].id`,
      pl: "keywordOptions: identyfikatory pojęć muszą być unikalne",
      found: `id ${clip(repeatedOption.value)} repeats in keywordOptions`,
    }));
  }
  for (let i = 0; i < options.length; i++) {
    for (let j = i + 1; j < options.length; j++) {
      if (answersEquivalent(options[i]!.text, options[j]!.text, normalizer)) {
        issues.push(coreIssue("keywords.option_duplicate", {
          field: `keywordOptions[${j}]`,
          pl: `keywordOptions: pojęcie „${options[j]!.text}” powiela „${options[i]!.text}” po normalizacji`,
          found: `term ${clip(options[j]!.text)} repeats ${clip(options[i]!.text)} after normalization`,
        }));
      }
    }
  }
  if (keyIds.length < MIN_KEY_OPTIONS || keyIds.length > MAX_KEY_OPTIONS) {
    issues.push(coreIssue("keywords.key_count", {
      pl: `keyOptionIds: liczba pojęć kluczowych (${keyIds.length}) poza zakresem ${MIN_KEY_OPTIONS}–${MAX_KEY_OPTIONS}`,
      found: `${keyIds.length} key terms, allowed ${MIN_KEY_OPTIONS}–${MAX_KEY_OPTIONS}`,
    }));
  }
  const repeatedKey = firstRepeated(keyIds);
  if (repeatedKey !== undefined) {
    issues.push(coreIssue("keywords.key_repeated", {
      field: `keyOptionIds[${repeatedKey.index}]`,
      pl: "keyOptionIds: pojęcia kluczowe nie mogą się powtarzać",
      found: `id ${clip(repeatedKey.value)} repeats in keyOptionIds`,
    }));
  }
  const textById = new Map(options.map((option) => [option.id, option.text] as const));
  const unknownKey = keyIds.findIndex((id) => !textById.has(id));
  if (unknownKey !== -1) {
    issues.push(coreIssue("keywords.key_unknown", {
      field: `keyOptionIds[${unknownKey}]`,
      pl: "keyOptionIds: każde pojęcie kluczowe musi być jednym z pojęć do wyboru",
      found: `${clip(keyIds[unknownKey]!)} is not a keywordOptions id; ids: ${idList(options.map((option) => option.id))}`,
    }));
  } else if (keyIds.length > 0 && ex.answer !== keywordsAnswer(ex)) {
    issues.push(coreIssue("keywords.answer_computed", {
      pl: "answer: musi być listą pojęć kluczowych złączonych „, ”",
      found: computedAnswerFound(ex.answer, keywordsAnswer(ex)),
    }));
  }
  if (keyIds.length >= options.length && options.length > 0) {
    issues.push(coreIssue("keywords.distractor_required", {
      pl: "keywordOptions: wśród pojęć musi być co najmniej jeden dystraktor",
      found: `${keyIds.length} key terms among ${options.length} keywordOptions`,
    }));
  }
}

/** Pierwsza wartość powtórzona na liście: indeks powtórzenia i wartość. */
function firstRepeated(values: readonly string[]): { readonly index: number; readonly value: string } | undefined {
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (seen.has(value)) {
      return { index, value };
    }
    seen.add(value);
  }
  return undefined;
}

/** Kanoniczna odpowiedź `lesson_keywords`: pojęcia kluczowe złączone „, ”. */
export function keywordsAnswer(ex: Pick<LessonExerciseDraft, "keywordOptions" | "keyOptionIds">): string {
  const textById = new Map((ex.keywordOptions ?? []).map((option) => [option.id, option.text] as const));
  return (ex.keyOptionIds ?? []).map((id) => textById.get(id) ?? "").join(", ");
}

/** Porównanie tekstów elementów: NFC, białe znaki, wielkość liter. */
function comparableText(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("pl-PL");
}

/** Słowa tekstu (litery i cyfry Unicode) po porównywalnej normalizacji. */
function wordsOfText(text: string): string[] {
  return comparableText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Pary indeksów `[i, j]` (i < j) tekstów powtórzonych albo zawierających drugi
 * jako ciąg CAŁYCH słów („dostarcza energii” w „dostarcza energii słonecznej”) —
 * nie do odróżnienia dla dziecka. Fragment słowa się nie liczy: „tlen” obok
 * „dwutlenek węgla” jest poprawny. Z `normalizer` także teksty równoważne po normalizacji.
 */
function confusableTexts(texts: readonly string[], normalizer?: AnswerNormalizer): [number, number][] {
  const found: [number, number][] = [];
  const words = texts.map(wordsOfText);
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      if (
        isContiguousSubsequence(words[i]!, words[j]!) ||
        isContiguousSubsequence(words[j]!, words[i]!) ||
        (normalizer !== undefined && answersEquivalent(texts[i]!, texts[j]!, normalizer))
      ) {
        found.push([i, j]);
      }
    }
  }
  return found;
}

/** `found` pary tekstów nie do odróżnienia. */
function confusableFound(earlier: string, later: string): string {
  return `${clip(later)} and ${clip(earlier)} repeat or contain each other as whole words`;
}

/** `found` odpowiedzi różnej od liczonej przez kod. */
function computedAnswerFound(answer: string, computed: string): string {
  return `answer ${clip(answer)}, computed ${clip(computed)}`;
}

/** Pary, grupy i luki z bankiem oceniane są z przypisań: bez wariantów tekstowych i fokusa. */
function validateNoTextAnswers(ex: LessonExerciseDraft, issues: LessonRuleIssue[]): void {
  if (ex.acceptedAnswers.length > 0) {
    issues.push(coreIssue("computed.no_variants", {
      pl: `acceptedAnswers: „${ex.exerciseType}” wymaga pustej listy wariantów`,
      found: `${ex.acceptedAnswers.length} variants on ${ex.exerciseType}`,
    }));
  }
  if (ex.focus.length > 0) {
    issues.push(coreIssue("computed.no_variants", {
      field: "focus",
      pl: `focus: „${ex.exerciseType}” wymaga pustej listy`,
      found: `${ex.focus.length} focus words on ${ex.exerciseType}`,
    }));
  }
}

/**
 * Kanoniczna odpowiedź `lesson_match` (źródło `targetKey`, podgląd): lewe
 * elementy par złączone „, ”. Ocena porównuje wyłącznie przypisania.
 */
export function matchAnswer(ex: Pick<LessonExerciseDraft, "pairs">): string {
  return (ex.pairs ?? []).map((pair) => pair.left).join(", ");
}

/** Kanoniczna odpowiedź `lesson_group`: etykiety grup złączone „ / ”. */
export function groupAnswer(ex: Pick<LessonExerciseDraft, "groups">): string {
  return (ex.groups ?? []).map((group) => group.label).join(" / ");
}

/**
 * `lesson_match` (design szkoły §10.1): 3–5 par, 0–2 dystraktory po prawej;
 * teksty po każdej stronie unikalne i nie zawarte jeden w drugim.
 */
function validateMatch(ex: LessonExerciseDraft, issues: LessonRuleIssue[]): void {
  const pairs = ex.pairs ?? [];
  const extra = ex.extraRight ?? [];
  if (pairs.length < MIN_MATCH_PAIRS || pairs.length > MAX_MATCH_PAIRS) {
    issues.push(coreIssue("match.pairs_count", {
      pl: `pairs: liczba par (${pairs.length}) poza zakresem ${MIN_MATCH_PAIRS}–${MAX_MATCH_PAIRS}`,
      found: `${pairs.length} pairs, allowed ${MIN_MATCH_PAIRS}–${MAX_MATCH_PAIRS}`,
    }));
  }
  if (extra.length > MAX_MATCH_EXTRA) {
    issues.push(coreIssue("match.extra_count", {
      pl: `extraRight: najwyżej ${MAX_MATCH_EXTRA} dystraktory`,
      found: `${extra.length} distractors, limit ${MAX_MATCH_EXTRA}`,
    }));
  }
  const lefts = pairs.map((pair) => pair.left);
  for (const [i, j] of confusableTexts(lefts)) {
    issues.push(coreIssue("match.confusable", {
      field: `pairs[${j}].left`,
      pl: `pairs: „${lefts[j]!}” powiela „${lefts[i]!}” albo się w nim zawiera`,
      found: confusableFound(lefts[i]!, lefts[j]!),
    }));
  }
  const rights = [...pairs.map((pair) => pair.right), ...extra];
  for (const [i, j] of confusableTexts(rights)) {
    issues.push(coreIssue("match.confusable", {
      field: j < pairs.length ? `pairs[${j}].right` : `extraRight[${j - pairs.length}]`,
      pl: `pairs: „${rights[j]!}” powiela „${rights[i]!}” albo się w nim zawiera`,
      found: confusableFound(rights[i]!, rights[j]!),
    }));
  }
  if (pairs.length > 0 && ex.answer !== matchAnswer(ex)) {
    issues.push(coreIssue("match.answer_computed", {
      pl: "answer: musi być listą lewych elementów par złączonych „, ”",
      found: computedAnswerFound(ex.answer, matchAnswer(ex)),
    }));
  }
}

/**
 * `lesson_group` (design szkoły §10.2): 2–3 grupy, 4–8 elementów, każda grupa
 * z co najmniej 2 elementami; etykiety i elementy unikalne, element nie jest
 * etykietą grupy.
 */
function validateGroup(ex: LessonExerciseDraft, issues: LessonRuleIssue[]): void {
  const groups = ex.groups ?? [];
  const items = ex.groupItems ?? [];
  if (groups.length < MIN_GROUPS || groups.length > MAX_GROUPS) {
    issues.push(coreIssue("group.groups_count", {
      pl: `groups: liczba grup (${groups.length}) poza zakresem ${MIN_GROUPS}–${MAX_GROUPS}`,
      found: `${groups.length} groups, allowed ${MIN_GROUPS}–${MAX_GROUPS}`,
    }));
  }
  if (items.length < MIN_GROUP_ITEMS || items.length > MAX_GROUP_ITEMS) {
    issues.push(coreIssue("group.items_count", {
      pl: `groupItems: liczba elementów (${items.length}) poza zakresem ${MIN_GROUP_ITEMS}–${MAX_GROUP_ITEMS}`,
      found: `${items.length} groupItems, allowed ${MIN_GROUP_ITEMS}–${MAX_GROUP_ITEMS}`,
    }));
  }
  const repeatedId = firstRepeated(groups.map((group) => group.id));
  if (repeatedId !== undefined) {
    issues.push(coreIssue("group.ids_unique", {
      field: `groups[${repeatedId.index}].id`,
      pl: "groups: identyfikatory grup muszą być unikalne",
      found: `id ${clip(repeatedId.value)} repeats in groups`,
    }));
  }
  const groupIds = new Set(groups.map((group) => group.id));
  const strayItem = items.findIndex((item) => !groupIds.has(item.groupId));
  if (strayItem !== -1) {
    issues.push(coreIssue("group.item_unknown_group", {
      field: `groupItems[${strayItem}].groupId`,
      pl: "groupItems: każdy element musi należeć do jednej z grup",
      found: `groupId ${clip(items[strayItem]!.groupId)} is not a group id; groups: ${idList(groups.map((group) => group.id))}`,
    }));
  }
  for (const group of groups) {
    const count = items.filter((item) => item.groupId === group.id).length;
    if (count < MIN_ITEMS_PER_GROUP) {
      issues.push(coreIssue("group.items_per_group", {
        pl: `groupItems: grupa „${group.label}” ma ${count} elementów (minimum ${MIN_ITEMS_PER_GROUP})`,
        found: `group ${clip(group.id)} has ${count} items, minimum ${MIN_ITEMS_PER_GROUP}`,
      }));
    }
  }
  const labelTexts = groups.map((group) => group.label);
  for (const [i, j] of confusableTexts(labelTexts)) {
    issues.push(coreIssue("group.label_confusable", {
      field: `groups[${j}].label`,
      pl: `groups: etykieta „${labelTexts[j]!}” powiela „${labelTexts[i]!}” albo się w niej zawiera`,
      found: confusableFound(labelTexts[i]!, labelTexts[j]!),
    }));
  }
  const labels = new Set(groups.map((group) => comparableText(group.label)));
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const key = comparableText(item.text);
    if (seen.has(key)) {
      issues.push(coreIssue("group.item_repeated", {
        field: `groupItems[${index}]`,
        pl: `groupItems: element „${item.text}” się powtarza`,
        found: `item ${clip(item.text)} repeats an earlier item`,
      }));
    }
    if (labels.has(key)) {
      issues.push(coreIssue("group.item_is_label", {
        field: `groupItems[${index}]`,
        pl: `groupItems: element „${item.text}” jest etykietą grupy`,
        found: `item ${clip(item.text)} is a group label`,
      }));
    }
    seen.add(key);
  });
  if (groups.length > 0 && ex.answer !== groupAnswer(ex)) {
    issues.push(coreIssue("group.answer_computed", {
      pl: "answer: musi być listą etykiet grup złączonych „ / ”",
      found: computedAnswerFound(ex.answer, groupAnswer(ex)),
    }));
  }
}

/**
 * `lesson_cloze` (design szkoły §13.1): 2–4 luki zgodne z liczbą słów, między
 * lukami co najmniej jedno słowo, 1–2 dystraktory; słowa banku unikalne i nie
 * zawarte jedno w drugim, żadne nie występuje w tekście poza lukami (tekst nie
 * może podpowiadać ani wykluczać słowa z banku).
 */
function validateCloze(ex: LessonExerciseDraft, normalizer: AnswerNormalizer, issues: LessonRuleIssue[]): void {
  const text = ex.clozeText;
  const answers = ex.gapAnswers ?? [];
  const extra = ex.extraWords ?? [];
  if (text === undefined || text.trim() === "") {
    issues.push(coreIssue("cloze.text_required", {
      pl: "clozeText: wymagany tekst z lukami dla „lesson_cloze”",
      found: missingText("clozeText", text),
    }));
    return;
  }
  const gaps = clozeGapCount(text);
  if (gaps < MIN_CLOZE_GAPS || gaps > MAX_CLOZE_GAPS) {
    issues.push(coreIssue("cloze.gap_count", {
      pl: `clozeText: liczba luk (${gaps}) poza zakresem ${MIN_CLOZE_GAPS}–${MAX_CLOZE_GAPS}; lukę oznacz „${GAP_MARKER}”`,
      found: `${gaps} gaps in ${clip(text)}, allowed ${MIN_CLOZE_GAPS}–${MAX_CLOZE_GAPS}`,
    }));
  }
  if (answers.length !== gaps) {
    issues.push(coreIssue("cloze.answers_count", {
      pl: `gapAnswers: liczba słów (${answers.length}) różni się od liczby luk (${gaps})`,
      found: `${answers.length} gapAnswers for ${gaps} gaps`,
    }));
  }
  if (extra.length < MIN_CLOZE_EXTRA || extra.length > MAX_CLOZE_EXTRA) {
    issues.push(coreIssue("cloze.extra_count", {
      pl: `extraWords: liczba słów-pułapek (${extra.length}) poza zakresem ${MIN_CLOZE_EXTRA}–${MAX_CLOZE_EXTRA}`,
      found: `${extra.length} extraWords, allowed ${MIN_CLOZE_EXTRA}–${MAX_CLOZE_EXTRA}`,
    }));
  }
  const parts = clozeParts(text);
  const emptyBetween = parts.slice(1, -1).findIndex((part) => wordsOfText(part).length === 0);
  if (emptyBetween !== -1) {
    issues.push(coreIssue("cloze.words_between_gaps", {
      pl: "clozeText: między dwiema lukami musi stać co najmniej jedno słowo",
      found: `no word between gap ${emptyBetween + 1} and gap ${emptyBetween + 2} in ${clip(text)}`,
    }));
  }
  const strayUnderscore = parts.find((part) => part.includes("_"));
  if (strayUnderscore !== undefined) {
    issues.push(coreIssue("cloze.underscore_outside_gap", {
      pl: "clozeText: podkreślenie poza znacznikiem luki",
      found: `a single "_" outside a gap marker in ${clip(strayUnderscore.trim())}`,
    }));
  }
  const bank = [...answers, ...extra];
  const bankField = (index: number): string =>
    index < answers.length ? `gapAnswers[${index}]` : `extraWords[${index - answers.length}]`;
  bank.forEach((word, index) => {
    const count = wordsOfText(word).length;
    if (count === 0) {
      issues.push(coreIssue("cloze.bank_word_empty", {
        field: bankField(index),
        pl: `gapAnswers: „${word}” nie zawiera liter ani cyfr`,
        found: `${clip(word)} has no letters or digits`,
      }));
    } else if (count > MAX_CLOZE_WORD_TOKENS) {
      issues.push(coreIssue("cloze.bank_word_tokens", {
        field: bankField(index),
        pl: `gapAnswers: „${word}” ma więcej niż ${MAX_CLOZE_WORD_TOKENS} słowa`,
        found: `${count} words in ${clip(word)}, limit ${MAX_CLOZE_WORD_TOKENS}`,
      }));
    }
  });
  // Dziecko wybiera konkretny kafelek: kafelek równoważny odpowiedzi po normalizacji (np. „is not” przy „isn't”) byłby oceniony jako błąd (#316).
  for (const [i, j] of confusableTexts(bank, normalizer)) {
    issues.push(coreIssue("cloze.bank_confusable", {
      field: bankField(j),
      pl: `gapAnswers: „${bank[j]!}” powiela „${bank[i]!}” albo się w nim zawiera`,
      found: confusableFound(bank[i]!, bank[j]!),
    }));
  }
  const visible = parts.map(wordsOfText);
  bank.forEach((word, index) => {
    const needle = wordsOfText(word);
    if (visible.some((part) => isContiguousSubsequence(part, needle))) {
      issues.push(coreIssue("cloze.bank_outside_gap", {
        pl: `clozeText: słowo „${word}” z banku występuje w tekście poza luką`,
        found: `bank word ${clip(word)} (${bankField(index)}) appears in the text outside the gaps`,
      }));
    }
  });
  if (answers.length > 0 && ex.answer !== clozeAnswer(ex)) {
    issues.push(coreIssue("cloze.answer_computed", {
      pl: "answer: musi być listą słów luk złączonych „, ”",
      found: computedAnswerFound(ex.answer, clozeAnswer(ex)),
    }));
  }
}

function validateOrder(
  ex: LessonExerciseDraft,
  normalizer: AnswerNormalizer,
  issues: LessonRuleIssue[],
): void {
  const items = ex.items ?? [];
  if (items.length < MIN_ORDER_ITEMS || items.length > MAX_ORDER_ITEMS) {
    issues.push(coreIssue("order.items_count", {
      pl: `items: liczba elementów (${items.length}) poza zakresem ${MIN_ORDER_ITEMS}–${MAX_ORDER_ITEMS}`,
      found: `${items.length} items, allowed ${MIN_ORDER_ITEMS}–${MAX_ORDER_ITEMS}`,
    }));
  }
  items.forEach((item, index) => {
    if (/[.!?…]$/.test(item.text.trim())) {
      issues.push(coreIssue("order.tile_no_final_punctuation", {
        field: `items[${index}]`,
        pl: `items: element „${item.text}” kończy się znakiem końcowym zdania`,
        found: `item ${clip(item.text)} ends with sentence-final punctuation`,
      }));
    }
  });
  if (items.length > 0) {
    const joined = items.map((item) => item.text).join(" ");
    if (!answersEquivalent(joined, ex.answer, normalizer)) {
      issues.push(coreIssue("order.items_join", {
        pl: "items: złączone elementy nie dają odpowiedzi kanonicznej po normalizacji",
        found: `items join to ${clip(joined)}, the answer is ${clip(ex.answer)}`,
      }));
    }
  }
}

function validateOptions(
  ex: LessonExerciseDraft,
  normalizer: AnswerNormalizer,
  issues: LessonRuleIssue[],
): void {
  const options = ex.options ?? [];
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    issues.push(coreIssue("options.count", {
      pl: `options: liczba opcji (${options.length}) poza zakresem ${MIN_OPTIONS}–${MAX_OPTIONS}`,
      found: `${options.length} options, allowed ${MIN_OPTIONS}–${MAX_OPTIONS}`,
    }));
  }
  // Unikalność po normalizacji (dowolny wspólny wariant = duplikat).
  for (let i = 0; i < options.length; i++) {
    for (let j = i + 1; j < options.length; j++) {
      if (answersEquivalent(options[i]!.text, options[j]!.text, normalizer)) {
        issues.push(coreIssue("options.duplicate", {
          field: `options[${j}]`,
          pl: `options: opcja „${options[j]!.text}” powiela „${options[i]!.text}” po normalizacji`,
          found: `option ${clip(options[j]!.text)} repeats ${clip(options[i]!.text)} after normalization`,
        }));
      }
    }
  }
  const correct = options.find((option) => option.id === ex.correctOption);
  if (ex.correctOption === undefined || correct === undefined) {
    issues.push(coreIssue("options.correct_unknown", {
      pl: "correctOption: poprawna opcja nie jest jedną z opcji",
      found: `correctOption ${ex.correctOption === undefined ? "is missing" : clip(ex.correctOption)}; option ids: ${idList(options.map((option) => option.id))}`,
    }));
  } else if (!answersEquivalent(ex.answer, correct.text, normalizer)) {
    issues.push(coreIssue("answer.correct_option_text", {
      pl: `answer: odpowiedź „${ex.answer}” nie jest tekstem poprawnej opcji „${correct.text}”`,
      found: `answer ${clip(ex.answer)}, correct option ${clip(correct.id)} is ${clip(correct.text)}`,
    }));
  }
}

/**
 * `lesson_notice` (design „Typy ćwiczeń i etapy”): payload `noticeSegments`
 * (2–3 zdania, każde 1–15 niepustych segmentów-słów ≤ limitu długości) oraz
 * `correctOption` = słowo do wskazania, równe (po normalizatorze, dowolny
 * wariant) któremuś segmentowi w którymś zdaniu. `options` jest zabronione —
 * wskazanie, nie wybór z listy opcji.
 */
function validateNotice(
  ex: LessonExerciseDraft,
  normalizer: AnswerNormalizer,
  issues: LessonRuleIssue[],
): void {
  if (ex.options !== undefined) {
    issues.push(coreIssue("notice.options_not_allowed", {
      pl: "options: „lesson_notice” nie używa opcji (wskazanie, nie wybór z listy)",
      found: `${ex.options.length} options are set`,
    }));
  }

  const sentences = ex.noticeSegments;
  if (sentences === undefined) {
    issues.push(coreIssue("notice.segments_required", {
      pl: "noticeSegments: wymagane dla „lesson_notice”",
      found: "noticeSegments is missing",
    }));
    return;
  }
  if (sentences.length < MIN_NOTICE_SENTENCES || sentences.length > MAX_NOTICE_SENTENCES) {
    issues.push(coreIssue("notice.sentence_count", {
      pl: `noticeSegments: liczba zdań (${sentences.length}) poza zakresem ${MIN_NOTICE_SENTENCES}–${MAX_NOTICE_SENTENCES}`,
      found: `${sentences.length} sentences, allowed ${MIN_NOTICE_SENTENCES}–${MAX_NOTICE_SENTENCES}`,
    }));
  }
  sentences.forEach((sentence, sentenceIndex) => {
    if (sentence.length < MIN_NOTICE_SEGMENTS || sentence.length > MAX_NOTICE_SEGMENTS) {
      issues.push(coreIssue("notice.segment_count", {
        field: `noticeSegments[${sentenceIndex}]`,
        pl: `noticeSegments: liczba segmentów w zdaniu (${sentence.length}) poza zakresem ${MIN_NOTICE_SEGMENTS}–${MAX_NOTICE_SEGMENTS}`,
        found: `${sentence.length} segments, allowed ${MIN_NOTICE_SEGMENTS}–${MAX_NOTICE_SEGMENTS}`,
      }));
    }
    sentence.forEach((segment, segmentIndex) => {
      const field = `noticeSegments[${sentenceIndex}][${segmentIndex}]`;
      if (segment.trim() === "") {
        issues.push(coreIssue("notice.segment_empty", { field, pl: "noticeSegments: pusty segment", found: "blank segment" }));
      } else if ([...segment].length > MAX_TEXT_LENGTH) {
        // Ta sama granica co w kontrakcie (pole tekstowe), więc ta sama reguła.
        issues.push(coreIssue("field.max_length", {
          field,
          pl: `noticeSegments: segment przekracza ${MAX_TEXT_LENGTH} znaków`,
          found: `${[...segment].length} characters, limit ${MAX_TEXT_LENGTH}`,
        }));
      }
    });
  });

  if (ex.correctOption === undefined || ex.correctOption.trim() === "") {
    issues.push(coreIssue("notice.correct_required", {
      pl: "correctOption: wymagane dla „lesson_notice” (słowo do wskazania)",
      found: missingText("correctOption", ex.correctOption),
    }));
    return;
  }
  const correctOption = ex.correctOption;
  const matchesSegment = sentences.some((sentence) =>
    sentence.some((segment) => answersEquivalent(segment, correctOption, normalizer)),
  );
  if (!matchesSegment) {
    issues.push(coreIssue("notice.correct_not_segment", {
      pl: "correctOption: nie jest równe (po normalizacji) żadnemu segmentowi zdań",
      found: `correctOption ${clip(correctOption)} is not a segment of the sentences`,
    }));
  } else if (!answersEquivalent(ex.answer, correctOption, normalizer)) {
    issues.push(coreIssue("answer.correct_option_text", {
      pl: `answer: odpowiedź „${ex.answer}” nie jest wskazywanym słowem „${correctOption}”`,
      found: `answer ${clip(ex.answer)}, correctOption is ${clip(correctOption)}`,
    }));
  }
}

function validateGap(
  ex: LessonExerciseDraft,
  normalizer: AnswerNormalizer,
  issues: LessonRuleIssue[],
): void {
  const markers = ex.stem === undefined ? 0 : lessonGapCount(ex.stem);
  if (markers !== 1) {
    issues.push(coreIssue("gap.marker_count", {
      pl: `stem: „lesson_gap” wymaga dokładnie jednego znacznika luki „${GAP_MARKER}” (znaleziono ${markers})`,
      found: `${markers} gap markers in ${ex.stem === undefined ? "a missing stem" : clip(ex.stem)}`,
    }));
  }
  const answerTokens = anyTokens(ex.answer, normalizer);
  if (answerTokens.length > MAX_GAP_ANSWER_TOKENS) {
    issues.push(coreIssue("gap.answer_tokens", {
      pl: `answer: odpowiedź luki ma więcej niż ${MAX_GAP_ANSWER_TOKENS} tokeny`,
      found: `${answerTokens.length} words in ${clip(ex.answer)}, limit ${MAX_GAP_ANSWER_TOKENS}`,
    }));
  }
  // Element sprawdzany pokrywa odpowiedź luki: tokeny odpowiedzi ⊆ focus
  // lub odwrotnie (w dowolnym wariancie normalizacji).
  if (ex.focus.length > 0 && !gapFocusCoversAnswer(ex.focus, ex.answer, normalizer)) {
    issues.push(coreIssue("gap.focus", {
      pl: "focus: nie pokrywa odpowiedzi luki (ani odpowiedź nie pokrywa focus)",
      found: `focus ${clip(ex.focus.join(" "))} and the answer ${clip(ex.answer)} do not cover each other`,
    }));
  }
}

/** Zbiór tokenów we wszystkich wariantach normalizacji tekstu. */
function tokenSet(text: string, normalizer: AnswerNormalizer): Set<string> {
  const set = new Set<string>();
  for (const sequence of normalizer.normalize(text)) {
    for (const token of sequence) {
      set.add(token);
    }
  }
  return set;
}

/** `lesson_gap`: tokeny odpowiedzi ⊆ tokeny focus lub odwrotnie. */
function gapFocusCoversAnswer(
  focus: readonly string[],
  answer: string,
  normalizer: AnswerNormalizer,
): boolean {
  const focusSet = tokenSet(focus.join(" "), normalizer);
  const answerSet = tokenSet(answer, normalizer);
  if (answerSet.size === 0 || focusSet.size === 0) {
    return false;
  }
  const answerSubsetOfFocus = [...answerSet].every((token) => focusSet.has(token));
  const focusSubsetOfAnswer = [...focusSet].every((token) => answerSet.has(token));
  return answerSubsetOfFocus || focusSubsetOfAnswer;
}

function validateErrorFix(
  ex: LessonExerciseDraft,
  normalizer: AnswerNormalizer,
  issues: LessonRuleIssue[],
): void {
  if (!ex.statement?.trim()) {
    issues.push(coreIssue("error_fix.statement_required", {
      pl: "statement: wymagany dla „lesson_error_fix”",
      found: missingText("statement", ex.statement),
    }));
    return;
  }
  if (answersEquivalent(ex.statement, ex.answer, normalizer)) {
    issues.push(coreIssue("error_fix.same_as_answer", {
      pl: "statement: zdanie z błędem jest identyczne z odpowiedzią po normalizacji",
      found: `statement ${clip(ex.statement)} equals the answer ${clip(ex.answer)} after normalization`,
    }));
  }
}

function validateTransform(ex: LessonExerciseDraft, topic: LessonTopic, issues: LessonRuleIssue[]): void {
  if (!ex.statement?.trim()) {
    issues.push(coreIssue("transform.statement_required", {
      pl: "statement: wymagany dla „lesson_transform”",
      found: missingText("statement", ex.statement),
    }));
  }
  if (ex.transformId === undefined || !topic.transforms.some((t) => t.id === ex.transformId)) {
    issues.push(coreIssue("transform.unknown", {
      pl: `transformId: przekształcenie „${ex.transformId ?? ""}” nie istnieje w temacie „${topic.id}”`,
      found: `transformId ${ex.transformId === undefined ? "is missing" : clip(ex.transformId)}; topic transforms: ${idList(topic.transforms.map((t) => t.id))}`,
    }));
  }
}

function validateAcceptedAnswers(
  ex: LessonExerciseDraft,
  normalizer: AnswerNormalizer,
  issues: LessonRuleIssue[],
): void {
  if (ex.acceptedAnswers.length > MAX_ACCEPTED_ANSWERS) {
    issues.push(coreIssue("variants.count", {
      pl: `acceptedAnswers: więcej niż ${MAX_ACCEPTED_ANSWERS} wariantów`,
      found: `${ex.acceptedAnswers.length} variants, limit ${MAX_ACCEPTED_ANSWERS}`,
    }));
  }
  ex.acceptedAnswers.forEach((variant, index) => {
    const field = `acceptedAnswers[${index}]`;
    if (variantKeys(variant, normalizer).size === 0) {
      issues.push(coreIssue("variants.empty", { field, pl: "acceptedAnswers: pusty wariant", found: "blank variant" }));
      return;
    }
    if (answersEquivalent(variant, ex.answer, normalizer)) {
      issues.push(coreIssue("variants.duplicate", {
        field,
        pl: `acceptedAnswers: wariant „${variant}” duplikuje odpowiedź kanoniczną po normalizacji`,
        found: `variant ${clip(variant)} equals the answer ${clip(ex.answer)} after normalization`,
      }));
    }
  });
}

/**
 * Kopia ćwiczenia bez wariantów `acceptedAnswers` redundantnych wobec odpowiedzi
 * kanonicznej (równoważnych po normalizatorze przedmiotu — dokładnie ta sama
 * relacja co reguła `validateAcceptedAnswers`). Generacja porzuca takie warianty
 * przy przyjęciu puli zamiast tracić CAŁE ćwiczenie: odpowiedź kanoniczna jest
 * akceptowana automatycznie, więc wariant równoważny nie zmienia werdyktu
 * deterministycznego. Uwaga: przy skrócie dwuznacznym („She's” → is|has) wariant
 * dzielący JEDNĄ sekwencję z odpowiedzią niesie też dodatkowe sekwencje — taki
 * wpis i tak nigdy nie mógł zostać zapisany (reguła walidacji odrzucałaby całe
 * ćwiczenie), więc porzucenie go jest ściśle lepsze od utraty ćwiczenia
 * (incydent prod 2026-10-26: przeczenia „to be” traciły wszystkie ćwiczenia
 * samodzielne, bo model konsekwentnie podawał wariant skrótowy — „They're not…”
 * przy odpowiedzi „They aren't…”). Walidacja pozostaje egzekwatorem przy edycji
 * i publikacji. Ćwiczenie bez wariantów redundantnych zwracane bez kopii.
 */
export function withoutRedundantAcceptedVariants(
  ex: LessonExerciseDraft,
  normalizer: AnswerNormalizer,
): LessonExerciseDraft {
  if (ex.acceptedAnswers.length === 0) return ex;
  const kept = ex.acceptedAnswers.filter((variant) => !answersEquivalent(variant, ex.answer, normalizer));
  return kept.length === ex.acceptedAnswers.length ? ex : { ...ex, acceptedAnswers: kept };
}

/**
 * Grupuje INDEKSY odpowiedzi mających wspólny wariant znormalizowanej odpowiedzi
 * kanonicznej. Pierwszy element każdej grupy to pierwsze wystąpienie, kolejne —
 * duplikaty. Relacja „wspólny wariant” nie jest przechodnia, więc grupujemy
 * zachłannie: pierwszy niezgrupowany element zakłada grupę, kolejne równoważne
 * mu dołączają. Deterministyczne (kolejność wejścia). Jedna implementacja
 * wykrywania duplikatów — używana przez `findDuplicateAnswers` i `validatePool`.
 */
function groupEquivalentAnswers(
  answers: readonly string[],
  normalizer: AnswerNormalizer,
): number[][] {
  const grouped = new Array<boolean>(answers.length).fill(false);
  const groups: number[][] = [];

  for (let i = 0; i < answers.length; i++) {
    if (grouped[i]) {
      continue;
    }
    const group: number[] = [i];
    for (let j = i + 1; j < answers.length; j++) {
      if (grouped[j]) {
        continue;
      }
      if (answersEquivalent(answers[i]!, answers[j]!, normalizer)) {
        grouped[j] = true;
        group.push(j);
      }
    }
    if (group.length > 1) {
      grouped[i] = true;
      groups.push(group);
    }
  }
  return groups;
}

/**
 * Grupy ćwiczeń o wspólnym wariancie znormalizowanej odpowiedzi kanonicznej.
 * Każda grupa to lista odpowiedzi (surowych) uznanych za duplikaty; grupa ma
 * ≥ 2 elementy. Deterministyczne (kolejność wejścia).
 */
export function findDuplicateAnswers(
  exercises: readonly LessonExerciseDraft[],
  subject: SubjectModule,
): string[][] {
  const answers = exercises.map((ex) => ex.answer);
  return groupEquivalentAnswers(answers, subject.normalizer).map((group) =>
    group.map((index) => answers[index]!),
  );
}

/**
 * Kontekst walidacji dopisywanej puli (dogenerowanie): ćwiczenia już zapisane w szkicu. Nie są
 * walidowane ani zwracane — służą tylko regule krzyżowej ćwiczeń słuchowych.
 */
export interface PoolValidationContext {
  readonly existingExercises?: readonly LessonExerciseDraft[];
}

/** Wynik walidacji puli: ćwiczenia poprawne i odrzucone z powodami. */
export interface PoolValidationResult {
  readonly valid: LessonExerciseDraft[];
  readonly rejected: { exercise: LessonExerciseDraft; errors: string[] }[];
}

/** Wynik walidacji puli ze zgłoszeniami reguł (ścieżka agenta). */
export interface PoolValidationIssuesResult {
  readonly valid: LessonExerciseDraft[];
  readonly rejected: { exercise: LessonExerciseDraft; issues: LessonRuleIssue[] }[];
}

/** Opcje walidacji puli: kontekst dogenerowania i opcje walidacji ćwiczenia (`agent`). */
export type PoolValidationOptions = PoolValidationContext & LessonExerciseValidationOptions;

/** Długość wycinka bodźca w `found` reguł puli. */
const STIMULUS_CLIP = 40;

/** Krótki opis ćwiczenia do `found`: typ i początek bodźca (bez treści spoza ćwiczenia). */
function exerciseLabel(ex: LessonExerciseDraft, options: LessonExerciseIdentityOptions): string {
  return `${ex.exerciseType} ${clip(lessonExerciseStimulus(ex, options), STIMULUS_CLIP)}`;
}

/**
 * Waliduje całą pulę i zwraca zgłoszenia reguł. Najpierw reguły pojedynczego
 * ćwiczenia; następnie ujawnienie odpowiedzi przez ćwiczenie słuchowe i
 * duplikaty (bodźca albo znormalizowanej odpowiedzi — ta sama implementacja co
 * `findDuplicateAnswers`, przez `groupEquivalentAnswers`) — przy duplikacie
 * zachowuje PIERWSZE poprawne wystąpienie, kolejne odrzuca. Deterministyczne
 * (kolejność wejścia).
 */
export function validatePoolIssues(
  exercises: readonly LessonExerciseDraft[],
  subject: SubjectModule,
  topic: LessonTopic,
  options: PoolValidationOptions = {},
): PoolValidationIssuesResult {
  const rejected: { exercise: LessonExerciseDraft; issues: LessonRuleIssue[] }[] = [];
  const exerciseOptions: LessonExerciseValidationOptions = options.agent === true ? { agent: true } : {};

  // Faza 1: reguły pojedynczego ćwiczenia. Zachowujemy pozycje w `exercises`,
  // by faza 2 mogła wskazać PIERWSZE poprawne wystąpienie każdej odpowiedzi.
  const singleValid: { exercise: LessonExerciseDraft; index: number }[] = [];
  exercises.forEach((exercise, index) => {
    const issues = validateLessonExerciseIssues(exercise, subject, topic, exerciseOptions);
    if (issues.length > 0) {
      rejected.push({ exercise, issues });
    } else {
      singleValid.push({ exercise, index });
    }
  });

  // Ćwiczenie słuchowe, którego pełne zdanie jest odpowiedzią ćwiczenia tekstowego tej
  // samej puli, ujawniłoby je przed samodzielnym sprawdzeniem. Klucz ekspozycji łapie
  // tylko identyczny tekst, więc tu porównujemy normalizatorem przedmiotu.
  // Przy dogenerowaniu reguła obejmuje też szkic: nowe ćwiczenie słuchowe nie może czytać odpowiedzi
  // tekstowej szkicu, a nowe ćwiczenie tekstowe nie może mieć odpowiedzi równej zdaniu słuchowemu szkicu.
  const existing = options.existingExercises ?? [];
  const textAnswers = [...existing, ...singleValid.map((entry) => entry.exercise)]
    .filter((ex) => LISTEN_CROSS_CHECK_TYPES.has(ex.exerciseType))
    .flatMap((ex) => [ex.answer, ...ex.acceptedAnswers]);
  const existingListenSentences = existing
    .filter((ex) => ex.exerciseType === "lesson_listen_choice")
    .map(listenSentenceOf)
    .filter((sentence): sentence is string => sentence !== null);
  const eligible = singleValid.filter(({ exercise }) => {
    if (exercise.exerciseType !== "lesson_listen_choice") {
      if (existingListenSentences.length > 0 && LISTEN_CROSS_CHECK_TYPES.has(exercise.exerciseType)) {
        for (const answer of [exercise.answer, ...exercise.acceptedAnswers]) {
          const sentence = existingListenSentences.find((listen) => answersEquivalent(listen, answer, subject.normalizer));
          if (sentence !== undefined) {
            rejected.push({
              exercise,
              issues: [lessonIssue("lesson.listen_reveals_answer", {
                field: "answer",
                pl: "answer: odpowiedź jest zdaniem ćwiczenia słuchowego w tej lekcji (ćwiczenie słuchowe by ją ujawniło)",
                found: `answer ${clip(answer)} is the sentence of a lesson_listen_choice already in the lesson`,
              })],
            });
            return false;
          }
        }
      }
      return true;
    }
    const sentence = listenSentenceOf(exercise);
    const revealed = sentence === null
      ? undefined
      : textAnswers.find((answer) => answersEquivalent(sentence, answer, subject.normalizer));
    if (sentence !== null && revealed !== undefined) {
      rejected.push({
        exercise,
        issues: [lessonIssue("lesson.listen_reveals_answer", {
          pl: "stem: zdanie ćwiczenia słuchowego jest odpowiedzią ćwiczenia tekstowego w tej lekcji (ujawniłoby ją)",
          found: `the sentence ${clip(sentence)} is the answer ${clip(revealed)} of a text exercise in the lesson`,
        })],
      });
      return false;
    }
    return true;
  });

  // Różne przedmioty mogą potrzebować tożsamości zadania zamiast odpowiedzi.
  // To nie zmienia target_key ani kwalifikacji ujawnienia odpowiedzi.
  if (subject.poolDeduplication === "exercise") {
    const firstByIdentity = new Map<string, LessonExerciseDraft>();
    const valid: LessonExerciseDraft[] = [];
    const identityOptions = lessonIdentityOptionsOf(subject);
    for (const { exercise } of eligible) {
      const identity = lessonExerciseIdentity(exercise, identityOptions);
      const first = firstByIdentity.get(identity);
      if (first !== undefined) {
        rejected.push({
          exercise,
          issues: [lessonIssue("lesson.duplicate_stimulus", {
            pl: "stimulus: zduplikowany bodziec ćwiczenia w tej samej regule",
            found: `same stimulus as the earlier ${exerciseLabel(first, identityOptions)} in this objective`,
          })],
        });
      } else {
        firstByIdentity.set(identity, exercise);
        valid.push(exercise);
      }
    }
    return { valid, rejected };
  }

  // Domyślna polityka: niejęzykowe przedmioty zachowują unikalność odpowiedzi.
  const answers = eligible.map((entry) => entry.exercise.answer);
  const duplicateLaterPositions = new Set<number>();
  for (const group of groupEquivalentAnswers(answers, subject.normalizer)) {
    for (let k = 1; k < group.length; k++) {
      duplicateLaterPositions.add(group[k]!);
    }
  }

  const valid: LessonExerciseDraft[] = [];
  eligible.forEach((entry, position) => {
    if (duplicateLaterPositions.has(position)) {
      const firstPosition = findFirstGroupPosition(answers, position, subject.normalizer);
      const keptAnswer = firstPosition === -1 ? entry.exercise.answer : answers[firstPosition]!;
      rejected.push({
        exercise: entry.exercise,
        issues: [lessonIssue("lesson.duplicate_answer", {
          pl: `answer: duplikat odpowiedzi „${keptAnswer}” już obecnej w puli`,
          found: `answer ${clip(entry.exercise.answer)} is equivalent to the answer ${clip(keptAnswer)} of an earlier exercise`,
        })],
      });
    } else {
      valid.push(entry.exercise);
    }
  });

  return { valid, rejected };
}

/**
 * Waliduje całą pulę (komunikaty rodzica, `pl`) — opakowanie `validatePoolIssues`
 * bez ścieżki agenta: te same ćwiczenia poprawne i odrzucone, powody jak dziś.
 */
export function validatePool(
  exercises: readonly LessonExerciseDraft[],
  subject: SubjectModule,
  topic: LessonTopic,
  context: PoolValidationContext = {},
): PoolValidationResult {
  const result = validatePoolIssues(
    exercises,
    subject,
    topic,
    context.existingExercises === undefined ? {} : { existingExercises: context.existingExercises },
  );
  return {
    valid: result.valid,
    rejected: result.rejected.map(({ exercise, issues }) => ({ exercise, errors: messagesOf(issues) })),
  };
}

/** Pozycja pierwszego wystąpienia równoważnego `answers[position]` przed nią. */
function findFirstGroupPosition(
  answers: readonly string[],
  position: number,
  normalizer: AnswerNormalizer,
): number {
  for (let i = 0; i < position; i++) {
    if (answersEquivalent(answers[i]!, answers[position]!, normalizer)) {
      return i;
    }
  }
  return -1;
}

/** Brak pokrycia: ile ćwiczeń ocenianego etapu brakuje dla danego celu. */
export interface CoverageGap {
  readonly objectiveId: string;
  readonly stage: LessonStage;
  readonly required: number;
  readonly actual: number;
}

/**
 * Pokrycie publikacyjne: dla każdego celu i każdego etapu ocenianego liczy
 * ćwiczenia tego etapu i porównuje z minimum. Zwraca TYLKO braki (pusta tablica
 * = pokrycie spełnione). `lesson_notice` (intro) nie liczy się do żadnego etapu
 * ocenianego. Deterministyczne: kolejność `objectiveIds` × `ASSESSED_STAGES`.
 */
export function poolCoverage(
  exercises: readonly LessonExerciseDraft[],
  objectiveIds: readonly string[],
  minimums: PoolMinimums,
): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const objectiveId of objectiveIds) {
    const forObjective = exercises.filter((ex) => ex.objectiveId === objectiveId);
    for (const stage of ASSESSED_STAGES) {
      const required = minimums[stage as keyof PoolMinimums];
      // Typy poza ścieżką etapów (słowa kluczowe, wybór ze słuchu) są dodatkiem,
      // nie pokrywają minimum etapu.
      const actual = forObjective.filter((ex) => !outsideStagePath(ex.exerciseType) && stageOf(ex.exerciseType) === stage).length;
      if (actual < required) {
        gaps.push({ objectiveId, stage, required, actual });
      }
    }
  }
  return gaps;
}
