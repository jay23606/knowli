/**
 * Walidacja puli ćwiczeń lekcji (design „Generowanie puli (worker)”). Czysta
 * domena: subject-agnostyczna — reguły ogólne żyją tu, reguły specyficzne dla
 * przedmiotu dokłada `subject.validateExercise`. Bez bazy, sieci i zegara.
 *
 * Walidacja działa jednakowo przy generowaniu puli (worker) i przy edycji
 * ćwiczenia przez rodzica. Komunikaty po polsku (parent-facing), z nazwą pola,
 * spójne stylistycznie z `catalog-validation.ts`. Limity są nazwanymi,
 * eksportowanymi stałymi — żadnych rozsianych literałów.
 */

import {
  LessonExerciseInputSchema,
  MAX_CLOZE_EXTRA,
  MAX_CLOZE_GAPS,
  MAX_GROUP_ITEMS,
  MAX_GROUPS,
  MAX_KEY_OPTIONS,
  MAX_KEYWORD_OPTIONS,
  MAX_MATCH_EXTRA,
  MAX_MATCH_PAIRS,
  MIN_CLOZE_EXTRA,
  MIN_CLOZE_GAPS,
  MIN_GROUP_ITEMS,
  MIN_GROUPS,
  MIN_ITEMS_PER_GROUP,
  MIN_KEY_OPTIONS,
  MIN_KEYWORD_OPTIONS,
  MIN_MATCH_PAIRS,
} from "@learning/contracts";
import { clozeAnswer, clozeGapCount, clozeParts } from "./cloze";
import { FEEDBACK_SENTENCE_MAX_LENGTH, feedbackSentenceText, fillGap } from "./feedback-sentence-text";
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
import { lessonExerciseIdentity, lessonIdentityOptionsOf } from "./exercise-identity";
import type { PoolMinimums } from "./lesson-policy";

/** Znacznik luki w `stem` ćwiczenia `lesson_gap`. */
export const GAP_MARKER = "___";

/** Maksymalna długość pojedynczego pola tekstowego ćwiczenia (znaki). */
export const MAX_TEXT_LENGTH = 120;

/** Maksymalna liczba wariantów `acceptedAnswers`. */
export const MAX_ACCEPTED_ANSWERS = 40;

/** Zakres liczby elementów w `lesson_order`. */
export const MIN_ORDER_ITEMS = 3;
export const MAX_ORDER_ITEMS = 10;

/** Zakres liczby opcji w typach z zamkniętym wyborem. */
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;

/** `lesson_notice`: zakres liczby zdań i segmentów-słów na zdanie. */
export const MIN_NOTICE_SENTENCES = 2;
export const MAX_NOTICE_SENTENCES = 3;
export const MIN_NOTICE_SEGMENTS = 1;
export const MAX_NOTICE_SEGMENTS = 15;

/** `lesson_cloze`: słowo luki i słowo-pułapka mają 1–3 słowa (design szkoły §13.1). */
export const MAX_CLOZE_WORD_TOKENS = 3;

/** Maksymalna liczba tokenów odpowiedzi dla `lesson_gap`. */
export const MAX_GAP_ANSWER_TOKENS = 3;

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

/** Zbiór kluczy wariantów normalizacji tekstu (dowolny wspólny = równoważność). */
function variantKeys(text: string, normalizer: AnswerNormalizer): Set<string> {
  const keys = new Set<string>();
  for (const sequence of normalizer.normalize(text)) {
    keys.add(sequenceKey(sequence));
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

/** Luka `lesson_listen_choice`: ciąg 2+ podkreśleń (jak `feedbackSentenceText` i Kid UI `splitGap`). */
const LISTEN_GAP_PATTERN = /_{2,}/g;

/** Liczba wystąpień `GAP_MARKER` w tekście. */
function countGapMarkers(stem: string): number {
  return stem.split(GAP_MARKER).length - 1;
}

/**
 * Reguły ogólne dla ćwiczenia (design „Generowanie puli”), a następnie
 * delegacja do `subject.validateExercise`. Zwraca listę błędów po polsku;
 * pusta lista = ćwiczenie poprawne. Nie rzuca — zbiera wszystkie naruszenia.
 */
/** Piktogram bodźca (`visualSubject`) jest dozwolony tylko przy wyborze z listy. */
function validateVisualSubject(ex: LessonExerciseDraft, errors: string[]): void {
  if (ex.visualSubject !== undefined && ex.exerciseType !== "lesson_choice") {
    errors.push("visualSubject: piktogram jest dozwolony tylko dla „lesson_choice”");
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
export function validateLessonExercise(
  ex: LessonExerciseDraft,
  subject: SubjectModule,
  topic: LessonTopic,
): string[] {
  const errors: string[] = [];
  const normalizer = subject.normalizer;
  const shape = LessonExerciseInputSchema.safeParse(ex);
  if (!shape.success) {
    return shape.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.code === "too_big" ? `przekracza limit ${issue.maximum}` : issue.code === "too_small" ? `wymagane minimum ${issue.minimum}` : "nieprawidłowy typ lub wartość"}`);
  }

  // Karta pochodzi z katalogu, nie z puli ćwiczeń.
  if (ex.exerciseType === "lesson_card") {
    errors.push("exerciseType: „lesson_card” nie jest ćwiczeniem puli (karty pochodzą z katalogu)");
  }

  // Cel istnieje w temacie.
  const objective = topic.objectives.find((o) => o.id === ex.objectiveId);
  if (objective === undefined) {
    errors.push(`objectiveId: cel „${ex.objectiveId}” nie istnieje w temacie „${topic.id}”`);
  }

  // Typ dozwolony dla przedmiotu i dla celu.
  if (!subject.exerciseTypes.includes(ex.exerciseType)) {
    errors.push(`exerciseType: typ „${ex.exerciseType}” nie jest wspierany przez przedmiot`);
  }
  if (objective !== undefined && !objective.exerciseTypes.includes(ex.exerciseType)) {
    errors.push(`exerciseType: typ „${ex.exerciseType}” nie jest dozwolony dla celu „${objective.id}”`);
  }

  // Payload v3 i dłuższy limit odpowiedzi tylko dla przedmiotów, które je deklarują
  // (gramatyka zachowuje kontrakt v2: odpowiedź i warianty ≤ 120 znaków).
  if (subject.usesV3Payload !== true) {
    for (const field of v3FieldsPresent(ex)) {
      errors.push(`${field}: pole v3 niedozwolone dla przedmiotu „${subject.id}”`);
    }
    if ([...ex.answer].length > MAX_TEXT_LENGTH) {
      errors.push(`answer: przekracza ${MAX_TEXT_LENGTH} znaków`);
    }
    if (ex.acceptedAnswers.some((a) => [...a].length > MAX_TEXT_LENGTH)) {
      errors.push(`acceptedAnswers: przekracza ${MAX_TEXT_LENGTH} znaków`);
    }
  }

  if (ex.voiceTone !== undefined && subject.ttsForPrompts !== true) {
    errors.push(`voiceTone: ton lektora niedozwolony dla przedmiotu „${subject.id}” (brak nagrań pytań)`);
  }
  // Rachunek nie ma nagrania pytania z tonem (edytor go nie pokazuje, generator nie zwraca).
  if (ex.voiceTone !== undefined && ex.exerciseType === "lesson_calculation") {
    errors.push("voiceTone: ton lektora niedozwolony dla lesson_calculation");
  }
  validateVisualSubject(ex, errors);
  if (ex.calculation !== undefined && ex.exerciseType !== "lesson_calculation") {
    errors.push("calculation: parametry są dozwolone tylko dla „lesson_calculation”");
  }
  if ((ex.keywordOptions !== undefined || ex.keyOptionIds !== undefined) && ex.exerciseType !== "lesson_keywords") {
    errors.push("keywordOptions: pojęcia do wyboru są dozwolone tylko dla „lesson_keywords”");
  }
  if ((ex.pairs !== undefined || ex.extraRight !== undefined) && ex.exerciseType !== "lesson_match") {
    errors.push("pairs: pary są dozwolone tylko dla „lesson_match”");
  }
  if ((ex.groups !== undefined || ex.groupItems !== undefined) && ex.exerciseType !== "lesson_group") {
    errors.push("groups: grupy są dozwolone tylko dla „lesson_group”");
  }
  if ((ex.clozeText !== undefined || ex.gapAnswers !== undefined || ex.extraWords !== undefined) && ex.exerciseType !== "lesson_cloze") {
    errors.push("clozeText: tekst z lukami jest dozwolony tylko dla „lesson_cloze”");
  }
  if (ex.exerciseType === "lesson_listen_choice") {
    // Polecenie dziecka jest stałe z katalogu komunikatów; bodźcem jest nagranie, więc
    // podpowiedź (wskazałaby odpowiedź) i polecenie rodzica nie mają miejsca w payloadzie.
    // `visualSubject` odrzuca już `validateVisualSubject` (tylko `lesson_choice`).
    if (ex.instructionPl?.trim()) {
      errors.push("instructionPl: niedozwolone dla „lesson_listen_choice” (polecenie jest stałe)");
    }
    if (ex.hint?.trim()) {
      errors.push("hint: niedozwolona dla „lesson_listen_choice” (podpowiedź zdradzałaby odpowiedź)");
    }
  }
  validateTextFieldLengths(ex, errors);
  validateFocus(ex, normalizer, errors);
  validateByType(ex, topic, objective, normalizer, errors);
  validateAcceptedAnswers(ex, normalizer, errors);

  // Reguły specyficzne dla przedmiotu.
  for (const error of subject.validateExercise(ex, topic)) {
    errors.push(error);
  }

  return errors;
}

function validateTextFieldLengths(ex: LessonExerciseDraft, errors: string[]): void {
  for (const field of TEXT_FIELDS) {
    const value = ex[field];
    if (typeof value === "string" && [...value].length > MAX_TEXT_LENGTH) {
      errors.push(`${field}: przekracza ${MAX_TEXT_LENGTH} znaków`);
    }
  }
}

function validateFocus(
  ex: LessonExerciseDraft,
  normalizer: AnswerNormalizer,
  errors: string[],
): void {
  if (!TEXT_TYPES.has(ex.exerciseType)) {
    return;
  }
  if (ex.focus.length === 0) {
    errors.push("focus: musi być niepusty dla typu tekstowego");
    return;
  }
  if (!focusCoversAnswer(ex.focus, ex.answer, normalizer)) {
    errors.push("focus: nie jest ciągłą podsekwencją tokenów odpowiedzi kanonicznej");
  }
}

function validateByType(
  ex: LessonExerciseDraft,
  topic: LessonTopic,
  objective: LearningObjective | undefined,
  normalizer: AnswerNormalizer,
  errors: string[],
): void {
  switch (ex.exerciseType) {
    case "lesson_order":
      validateOrder(ex, normalizer, errors);
      break;
    case "lesson_choice":
      if (!ex.stem?.trim()) errors.push("stem: wymagane zdanie dla „lesson_choice”");
      validateOptions(ex, normalizer, errors);
      break;
    case "lesson_listen_choice":
      validateListenChoice(ex, normalizer, errors);
      break;
    case "lesson_short_answer":
      if (!(ex.prompt ?? ex.stem)?.trim()) errors.push("prompt: wymagane pytanie dla „lesson_short_answer”");
      validateOptions(ex, normalizer, errors);
      break;
    case "lesson_notice":
      validateNotice(ex, normalizer, errors);
      break;
    case "lesson_gap":
      validateGap(ex, normalizer, errors);
      break;
    case "lesson_error_fix":
      validateErrorFix(ex, normalizer, errors);
      break;
    case "lesson_transform":
      validateTransform(ex, topic, errors);
      break;
    case "lesson_open_answer":
      if (!ex.prompt?.trim()) errors.push("prompt: wymagane pytanie dla „lesson_open_answer”");
      break;
    case "lesson_keywords":
      validateKeywords(ex, normalizer, errors);
      break;
    case "lesson_match":
      validateMatch(ex, errors);
      validateNoTextAnswers(ex, errors);
      break;
    case "lesson_group":
      validateGroup(ex, errors);
      validateNoTextAnswers(ex, errors);
      break;
    case "lesson_cloze":
      validateCloze(ex, errors);
      validateNoTextAnswers(ex, errors);
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
  errors: string[],
): void {
  const stem = ex.stem ?? "";
  const gaps = (stem.match(LISTEN_GAP_PATTERN) ?? []).length;
  if (gaps !== 1) {
    errors.push(`stem: „lesson_listen_choice” wymaga dokładnie jednej luki (ciągu co najmniej dwóch podkreśleń, znaleziono ${gaps})`);
  }
  validateOptions(ex, normalizer, errors);
  const options = ex.options ?? [];
  for (const option of options) {
    if (/^['\u2019]/u.test(option.text.trim())) {
      errors.push(`options: opcja „${option.text}” zaczyna się od apostrofu (skróty tylko jako całe słowa)`);
    }
  }
  if (gaps !== 1) {
    return;
  }
  for (let i = 0; i < options.length; i++) {
    for (let j = i + 1; j < options.length; j++) {
      const a = fillGap(stem, options[i]!.text);
      const b = fillGap(stem, options[j]!.text);
      if (a !== undefined && b !== undefined && answersEquivalent(a, b, normalizer)) {
        errors.push(`options: zdania z opcjami „${options[i]!.text}” i „${options[j]!.text}” są równoważne po normalizacji`);
      }
    }
  }
  if (options.some((option) => option.id === ex.correctOption) && listenSentenceOf(ex) === null) {
    errors.push(`stem: zdanie z wstawioną poprawną opcją jest puste albo dłuższe niż ${FEEDBACK_SENTENCE_MAX_LENGTH} znaków (lektor go nie nagra)`);
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
  errors: string[],
): void {
  const options = ex.keywordOptions ?? [];
  const keyIds = ex.keyOptionIds ?? [];
  if (options.length < MIN_KEYWORD_OPTIONS || options.length > MAX_KEYWORD_OPTIONS) {
    errors.push(`keywordOptions: liczba pojęć (${options.length}) poza zakresem ${MIN_KEYWORD_OPTIONS}–${MAX_KEYWORD_OPTIONS}`);
  }
  if (new Set(options.map((option) => option.id)).size !== options.length) {
    errors.push("keywordOptions: identyfikatory pojęć muszą być unikalne");
  }
  for (let i = 0; i < options.length; i++) {
    for (let j = i + 1; j < options.length; j++) {
      if (answersEquivalent(options[i]!.text, options[j]!.text, normalizer)) {
        errors.push(`keywordOptions: pojęcie „${options[j]!.text}” powiela „${options[i]!.text}” po normalizacji`);
      }
    }
  }
  if (keyIds.length < MIN_KEY_OPTIONS || keyIds.length > MAX_KEY_OPTIONS) {
    errors.push(`keyOptionIds: liczba pojęć kluczowych (${keyIds.length}) poza zakresem ${MIN_KEY_OPTIONS}–${MAX_KEY_OPTIONS}`);
  }
  if (new Set(keyIds).size !== keyIds.length) {
    errors.push("keyOptionIds: pojęcia kluczowe nie mogą się powtarzać");
  }
  const textById = new Map(options.map((option) => [option.id, option.text] as const));
  if (keyIds.some((id) => !textById.has(id))) {
    errors.push("keyOptionIds: każde pojęcie kluczowe musi być jednym z pojęć do wyboru");
  } else if (keyIds.length > 0 && ex.answer !== keywordsAnswer(ex)) {
    errors.push("answer: musi być listą pojęć kluczowych złączonych „, ”");
  }
  if (keyIds.length >= options.length && options.length > 0) {
    errors.push("keywordOptions: wśród pojęć musi być co najmniej jeden dystraktor");
  }
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
 * Teksty powtórzone albo zawierające drugi jako ciąg CAŁYCH słów („dostarcza
 * energii” w „dostarcza energii słonecznej”) — nie do odróżnienia dla dziecka.
 * Fragment słowa się nie liczy: „tlen” obok „dwutlenek węgla” jest poprawny.
 */
function confusableTexts(texts: readonly string[]): [string, string][] {
  const found: [string, string][] = [];
  const words = texts.map(wordsOfText);
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      if (isContiguousSubsequence(words[i]!, words[j]!) || isContiguousSubsequence(words[j]!, words[i]!)) {
        found.push([texts[i]!, texts[j]!]);
      }
    }
  }
  return found;
}

/** Pary, grupy i luki z bankiem oceniane są z przypisań: bez wariantów tekstowych i fokusa. */
function validateNoTextAnswers(ex: LessonExerciseDraft, errors: string[]): void {
  if (ex.acceptedAnswers.length > 0) {
    errors.push(`acceptedAnswers: „${ex.exerciseType}” wymaga pustej listy wariantów`);
  }
  if (ex.focus.length > 0) {
    errors.push(`focus: „${ex.exerciseType}” wymaga pustej listy`);
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
function validateMatch(ex: LessonExerciseDraft, errors: string[]): void {
  const pairs = ex.pairs ?? [];
  const extra = ex.extraRight ?? [];
  if (pairs.length < MIN_MATCH_PAIRS || pairs.length > MAX_MATCH_PAIRS) {
    errors.push(`pairs: liczba par (${pairs.length}) poza zakresem ${MIN_MATCH_PAIRS}–${MAX_MATCH_PAIRS}`);
  }
  if (extra.length > MAX_MATCH_EXTRA) {
    errors.push(`extraRight: najwyżej ${MAX_MATCH_EXTRA} dystraktory`);
  }
  for (const [a, b] of confusableTexts(pairs.map((pair) => pair.left))) {
    errors.push(`pairs: „${b}” powiela „${a}” albo się w nim zawiera`);
  }
  for (const [a, b] of confusableTexts([...pairs.map((pair) => pair.right), ...extra])) {
    errors.push(`pairs: „${b}” powiela „${a}” albo się w nim zawiera`);
  }
  if (pairs.length > 0 && ex.answer !== matchAnswer(ex)) {
    errors.push("answer: musi być listą lewych elementów par złączonych „, ”");
  }
}

/**
 * `lesson_group` (design szkoły §10.2): 2–3 grupy, 4–8 elementów, każda grupa
 * z co najmniej 2 elementami; etykiety i elementy unikalne, element nie jest
 * etykietą grupy.
 */
function validateGroup(ex: LessonExerciseDraft, errors: string[]): void {
  const groups = ex.groups ?? [];
  const items = ex.groupItems ?? [];
  if (groups.length < MIN_GROUPS || groups.length > MAX_GROUPS) {
    errors.push(`groups: liczba grup (${groups.length}) poza zakresem ${MIN_GROUPS}–${MAX_GROUPS}`);
  }
  if (items.length < MIN_GROUP_ITEMS || items.length > MAX_GROUP_ITEMS) {
    errors.push(`groupItems: liczba elementów (${items.length}) poza zakresem ${MIN_GROUP_ITEMS}–${MAX_GROUP_ITEMS}`);
  }
  if (new Set(groups.map((group) => group.id)).size !== groups.length) {
    errors.push("groups: identyfikatory grup muszą być unikalne");
  }
  const groupIds = new Set(groups.map((group) => group.id));
  if (items.some((item) => !groupIds.has(item.groupId))) {
    errors.push("groupItems: każdy element musi należeć do jednej z grup");
  }
  for (const group of groups) {
    const count = items.filter((item) => item.groupId === group.id).length;
    if (count < MIN_ITEMS_PER_GROUP) {
      errors.push(`groupItems: grupa „${group.label}” ma ${count} elementów (minimum ${MIN_ITEMS_PER_GROUP})`);
    }
  }
  for (const [a, b] of confusableTexts(groups.map((group) => group.label))) {
    errors.push(`groups: etykieta „${b}” powiela „${a}” albo się w niej zawiera`);
  }
  const labels = new Set(groups.map((group) => comparableText(group.label)));
  const seen = new Set<string>();
  for (const item of items) {
    const key = comparableText(item.text);
    if (seen.has(key)) errors.push(`groupItems: element „${item.text}” się powtarza`);
    if (labels.has(key)) errors.push(`groupItems: element „${item.text}” jest etykietą grupy`);
    seen.add(key);
  }
  if (groups.length > 0 && ex.answer !== groupAnswer(ex)) {
    errors.push("answer: musi być listą etykiet grup złączonych „ / ”");
  }
}

/**
 * `lesson_cloze` (design szkoły §13.1): 2–4 luki zgodne z liczbą słów, między
 * lukami co najmniej jedno słowo, 1–2 dystraktory; słowa banku unikalne i nie
 * zawarte jedno w drugim, żadne nie występuje w tekście poza lukami (tekst nie
 * może podpowiadać ani wykluczać słowa z banku).
 */
function validateCloze(ex: LessonExerciseDraft, errors: string[]): void {
  const text = ex.clozeText;
  const answers = ex.gapAnswers ?? [];
  const extra = ex.extraWords ?? [];
  if (text === undefined || text.trim() === "") {
    errors.push("clozeText: wymagany tekst z lukami dla „lesson_cloze”");
    return;
  }
  const gaps = clozeGapCount(text);
  if (gaps < MIN_CLOZE_GAPS || gaps > MAX_CLOZE_GAPS) {
    errors.push(`clozeText: liczba luk (${gaps}) poza zakresem ${MIN_CLOZE_GAPS}–${MAX_CLOZE_GAPS}; lukę oznacz „${GAP_MARKER}”`);
  }
  if (answers.length !== gaps) {
    errors.push(`gapAnswers: liczba słów (${answers.length}) różni się od liczby luk (${gaps})`);
  }
  if (extra.length < MIN_CLOZE_EXTRA || extra.length > MAX_CLOZE_EXTRA) {
    errors.push(`extraWords: liczba słów-pułapek (${extra.length}) poza zakresem ${MIN_CLOZE_EXTRA}–${MAX_CLOZE_EXTRA}`);
  }
  const parts = clozeParts(text);
  if (parts.slice(1, -1).some((part) => wordsOfText(part).length === 0)) {
    errors.push("clozeText: między dwiema lukami musi stać co najmniej jedno słowo");
  }
  if (parts.some((part) => part.includes("_"))) {
    errors.push("clozeText: podkreślenie poza znacznikiem luki");
  }
  const bank = [...answers, ...extra];
  for (const word of bank) {
    const count = wordsOfText(word).length;
    if (count === 0) errors.push(`gapAnswers: „${word}” nie zawiera liter ani cyfr`);
    else if (count > MAX_CLOZE_WORD_TOKENS) errors.push(`gapAnswers: „${word}” ma więcej niż ${MAX_CLOZE_WORD_TOKENS} słowa`);
  }
  for (const [a, b] of confusableTexts(bank)) {
    errors.push(`gapAnswers: „${b}” powiela „${a}” albo się w nim zawiera`);
  }
  const visible = parts.map(wordsOfText);
  for (const word of bank) {
    const needle = wordsOfText(word);
    if (visible.some((part) => isContiguousSubsequence(part, needle))) {
      errors.push(`clozeText: słowo „${word}” z banku występuje w tekście poza luką`);
    }
  }
  if (answers.length > 0 && ex.answer !== clozeAnswer(ex)) {
    errors.push("answer: musi być listą słów luk złączonych „, ”");
  }
}

function validateOrder(
  ex: LessonExerciseDraft,
  normalizer: AnswerNormalizer,
  errors: string[],
): void {
  const items = ex.items ?? [];
  if (items.length < MIN_ORDER_ITEMS || items.length > MAX_ORDER_ITEMS) {
    errors.push(`items: liczba elementów (${items.length}) poza zakresem ${MIN_ORDER_ITEMS}–${MAX_ORDER_ITEMS}`);
  }
  if (items.length > 0) {
    const joined = items.map((item) => item.text).join(" ");
    if (!answersEquivalent(joined, ex.answer, normalizer)) {
      errors.push("items: złączone elementy nie dają odpowiedzi kanonicznej po normalizacji");
    }
  }
}

function validateOptions(
  ex: LessonExerciseDraft,
  normalizer: AnswerNormalizer,
  errors: string[],
): void {
  const options = ex.options ?? [];
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    errors.push(`options: liczba opcji (${options.length}) poza zakresem ${MIN_OPTIONS}–${MAX_OPTIONS}`);
  }
  // Unikalność po normalizacji (dowolny wspólny wariant = duplikat).
  for (let i = 0; i < options.length; i++) {
    for (let j = i + 1; j < options.length; j++) {
      if (answersEquivalent(options[i]!.text, options[j]!.text, normalizer)) {
        errors.push(`options: opcja „${options[j]!.text}” powiela „${options[i]!.text}” po normalizacji`);
      }
    }
  }
  if (ex.correctOption === undefined || !options.some((option) => option.id === ex.correctOption)) {
    errors.push("correctOption: poprawna opcja nie jest jedną z opcji");
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
  errors: string[],
): void {
  if (ex.options !== undefined) {
    errors.push("options: „lesson_notice” nie używa opcji (wskazanie, nie wybór z listy)");
  }

  const sentences = ex.noticeSegments;
  if (sentences === undefined) {
    errors.push("noticeSegments: wymagane dla „lesson_notice”");
    return;
  }
  if (sentences.length < MIN_NOTICE_SENTENCES || sentences.length > MAX_NOTICE_SENTENCES) {
    errors.push(
      `noticeSegments: liczba zdań (${sentences.length}) poza zakresem ${MIN_NOTICE_SENTENCES}–${MAX_NOTICE_SENTENCES}`,
    );
  }
  for (const sentence of sentences) {
    if (sentence.length < MIN_NOTICE_SEGMENTS || sentence.length > MAX_NOTICE_SEGMENTS) {
      errors.push(
        `noticeSegments: liczba segmentów w zdaniu (${sentence.length}) poza zakresem ${MIN_NOTICE_SEGMENTS}–${MAX_NOTICE_SEGMENTS}`,
      );
    }
    for (const segment of sentence) {
      if (segment.trim() === "") {
        errors.push("noticeSegments: pusty segment");
      } else if ([...segment].length > MAX_TEXT_LENGTH) {
        errors.push(`noticeSegments: segment przekracza ${MAX_TEXT_LENGTH} znaków`);
      }
    }
  }

  if (ex.correctOption === undefined || ex.correctOption.trim() === "") {
    errors.push("correctOption: wymagane dla „lesson_notice” (słowo do wskazania)");
    return;
  }
  const matchesSegment = sentences.some((sentence) =>
    sentence.some((segment) => answersEquivalent(segment, ex.correctOption!, normalizer)),
  );
  if (!matchesSegment) {
    errors.push("correctOption: nie jest równe (po normalizacji) żadnemu segmentowi zdań");
  }
}

function validateGap(
  ex: LessonExerciseDraft,
  normalizer: AnswerNormalizer,
  errors: string[],
): void {
  const markers = ex.stem === undefined ? 0 : countGapMarkers(ex.stem);
  if (markers !== 1) {
    errors.push(`stem: „lesson_gap” wymaga dokładnie jednego znacznika luki „${GAP_MARKER}” (znaleziono ${markers})`);
  }
  const answerTokens = anyTokens(ex.answer, normalizer);
  if (answerTokens.length > MAX_GAP_ANSWER_TOKENS) {
    errors.push(`answer: odpowiedź luki ma więcej niż ${MAX_GAP_ANSWER_TOKENS} tokeny`);
  }
  // Element sprawdzany pokrywa odpowiedź luki: tokeny odpowiedzi ⊆ focus
  // lub odwrotnie (w dowolnym wariancie normalizacji).
  if (ex.focus.length > 0 && !gapFocusCoversAnswer(ex.focus, ex.answer, normalizer)) {
    errors.push("focus: nie pokrywa odpowiedzi luki (ani odpowiedź nie pokrywa focus)");
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
  errors: string[],
): void {
  if (!ex.statement?.trim()) {
    errors.push("statement: wymagany dla „lesson_error_fix”");
    return;
  }
  if (answersEquivalent(ex.statement, ex.answer, normalizer)) {
    errors.push("statement: zdanie z błędem jest identyczne z odpowiedzią po normalizacji");
  }
}

function validateTransform(ex: LessonExerciseDraft, topic: LessonTopic, errors: string[]): void {
  if (!ex.statement?.trim()) errors.push("statement: wymagany dla „lesson_transform”");
  if (ex.transformId === undefined || !topic.transforms.some((t) => t.id === ex.transformId)) {
    errors.push(`transformId: przekształcenie „${ex.transformId ?? ""}” nie istnieje w temacie „${topic.id}”`);
  }
}

function validateAcceptedAnswers(
  ex: LessonExerciseDraft,
  normalizer: AnswerNormalizer,
  errors: string[],
): void {
  if (ex.acceptedAnswers.length > MAX_ACCEPTED_ANSWERS) {
    errors.push(`acceptedAnswers: więcej niż ${MAX_ACCEPTED_ANSWERS} wariantów`);
  }
  for (const variant of ex.acceptedAnswers) {
    if (variant.trim() === "") {
      errors.push("acceptedAnswers: pusty wariant");
      continue;
    }
    if (answersEquivalent(variant, ex.answer, normalizer)) {
      errors.push(`acceptedAnswers: wariant „${variant}” duplikuje odpowiedź kanoniczną po normalizacji`);
    }
  }
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

/**
 * Waliduje całą pulę. Najpierw reguły pojedynczego ćwiczenia; następnie
 * duplikaty znormalizowanych odpowiedzi (ta sama implementacja co
 * `findDuplicateAnswers`, przez `groupEquivalentAnswers`) — przy duplikacie
 * zachowuje PIERWSZE poprawne wystąpienie, kolejne odrzuca. Deterministyczne
 * (kolejność wejścia).
 */
export function validatePool(
  exercises: readonly LessonExerciseDraft[],
  subject: SubjectModule,
  topic: LessonTopic,
  context: PoolValidationContext = {},
): PoolValidationResult {
  const rejected: { exercise: LessonExerciseDraft; errors: string[] }[] = [];

  // Faza 1: reguły pojedynczego ćwiczenia. Zachowujemy pozycje w `exercises`,
  // by faza 2 mogła wskazać PIERWSZE poprawne wystąpienie każdej odpowiedzi.
  const singleValid: { exercise: LessonExerciseDraft; index: number }[] = [];
  exercises.forEach((exercise, index) => {
    const errors = validateLessonExercise(exercise, subject, topic);
    if (errors.length > 0) {
      rejected.push({ exercise, errors });
    } else {
      singleValid.push({ exercise, index });
    }
  });

  // Ćwiczenie słuchowe, którego pełne zdanie jest odpowiedzią ćwiczenia tekstowego tej
  // samej puli, ujawniłoby je przed samodzielnym sprawdzeniem. Klucz ekspozycji łapie
  // tylko identyczny tekst, więc tu porównujemy normalizatorem przedmiotu.
  // Przy dogenerowaniu reguła obejmuje też szkic: nowe ćwiczenie słuchowe nie może czytać odpowiedzi
  // tekstowej szkicu, a nowe ćwiczenie tekstowe nie może mieć odpowiedzi równej zdaniu słuchowemu szkicu.
  const existing = context.existingExercises ?? [];
  const textAnswers = [...existing, ...singleValid.map((entry) => entry.exercise)]
    .filter((ex) => LISTEN_CROSS_CHECK_TYPES.has(ex.exerciseType))
    .flatMap((ex) => [ex.answer, ...ex.acceptedAnswers]);
  const existingListenSentences = existing
    .filter((ex) => ex.exerciseType === "lesson_listen_choice")
    .map(listenSentenceOf)
    .filter((sentence): sentence is string => sentence !== null);
  const eligible = singleValid.filter(({ exercise }) => {
    if (exercise.exerciseType !== "lesson_listen_choice") {
      if (
        existingListenSentences.length > 0 &&
        LISTEN_CROSS_CHECK_TYPES.has(exercise.exerciseType) &&
        [exercise.answer, ...exercise.acceptedAnswers].some((answer) =>
          existingListenSentences.some((sentence) => answersEquivalent(sentence, answer, subject.normalizer)))
      ) {
        rejected.push({
          exercise,
          errors: ["answer: odpowiedź jest zdaniem ćwiczenia słuchowego w tej lekcji (ćwiczenie słuchowe by ją ujawniło)"],
        });
        return false;
      }
      return true;
    }
    const sentence = listenSentenceOf(exercise);
    if (sentence !== null && textAnswers.some((answer) => answersEquivalent(sentence, answer, subject.normalizer))) {
      rejected.push({
        exercise,
        errors: ["stem: zdanie ćwiczenia słuchowego jest odpowiedzią ćwiczenia tekstowego w tej lekcji (ujawniłoby ją)"],
      });
      return false;
    }
    return true;
  });

  // Różne przedmioty mogą potrzebować tożsamości zadania zamiast odpowiedzi.
  // To nie zmienia target_key ani kwalifikacji ujawnienia odpowiedzi.
  if (subject.poolDeduplication === "exercise") {
    const seen = new Set<string>();
    const valid: LessonExerciseDraft[] = [];
    const identityOptions = lessonIdentityOptionsOf(subject);
    for (const { exercise } of eligible) {
      const identity = lessonExerciseIdentity(exercise, identityOptions);
      if (seen.has(identity)) {
        rejected.push({ exercise, errors: ["stimulus: zduplikowany bodziec ćwiczenia w tej samej regule"] });
      } else {
        seen.add(identity);
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
        errors: [`answer: duplikat odpowiedzi „${keptAnswer}” już obecnej w puli`],
      });
    } else {
      valid.push(entry.exercise);
    }
  });

  return { valid, rejected };
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
