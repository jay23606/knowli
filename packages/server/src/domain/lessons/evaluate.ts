/**
 * Ocena odpowiedzi lekcji (design „Ocena”, „Model oceniający”). Czysta domena:
 * subject-agnostyczna — działa z dowolnym `AnswerNormalizer` (angielski,
 * fixture historyczny). Silnik nie importuje `subjects/`; test (`evaluate.test`)
 * może importować `englishNormalizer`, bo jest wykluczony z testu architektury.
 *
 * Ścieżka deterministyczna: `matchLessonAnswer` (exact → minor_typo → no_match)
 * i typy zamknięte. Ścieżka modelu: `validateVerdict` (Zod) + `gradeFromVerdict`.
 * Odległość liter reużywa `alignCodePoints`/`editDistance` z `../text-distance`.
 */
import { z } from "zod";
import type { OutcomeReason, SkillOutcome } from "../types";
import { editDistance } from "../text-distance";
import type { AnswerNormalizer, LessonExerciseType } from "./types";

/** Klucz odpowiedzi ćwiczenia (design „Ocena”, `LessonAnswerKey`). */
export interface LessonAnswerKey {
  readonly exerciseType: LessonExerciseType;
  readonly objectiveId: string;
  readonly answer: string;
  readonly acceptedAnswers: readonly string[];
  /** Tokeny elementu sprawdzanego w odpowiedzi kanonicznej (surowy zapis). */
  readonly focus: readonly string[];
  readonly correctOptionId?: string;
  readonly itemIds?: readonly string[];
  /** Tekst klocków i elementów (`lesson_order`: identyczne klocki są zamienne). */
  readonly itemValues?: Readonly<Record<string, string>>;
  /** `lesson_keywords`: identyfikatory pojęć kluczowych i dozwolona liczba wyborów. */
  readonly correctOptionIds?: readonly string[];
  readonly minSelected?: number;
  readonly maxSelected?: number;
  /**
   * `lesson_match` / `lesson_group` (design szkoły §10.3) i `lesson_cloze`
   * (§13.3, luka → słowo): poprawne przypisania (element → cel), dozwolone cele
   * i czy cel można użyć tylko raz (pary, luki).
   */
  readonly assignments?: readonly { readonly itemId: string; readonly targetId: string }[];
  readonly targetIds?: readonly string[];
  readonly targetOnce?: boolean;
}

/** Wynik dopasowania deterministycznego. */
export type MatchResult =
  | { kind: "exact"; variant: string }
  | { kind: "minor_typo"; variant: string; typoToken: string }
  | { kind: "no_match" };

/**
 * Progi tolerancji drobnej literówki (design 6.3). Nazwane stałe zamiast
 * rozsianych literałów: token ≤ `shortTokenMaxLength` punktów kodowych znosi
 * OSA ≤ `shortMaxDistance`, dłuższy OSA ≤ `longMaxDistance`.
 */
export const TYPO_TOLERANCE = {
  shortTokenMaxLength: 6,
  shortMaxDistance: 1,
  longMaxDistance: 2,
} as const;

/** Werdykt modelu oceniającego (design „Model oceniający”, `GraderVerdict`). */
export interface GraderVerdict {
  readonly verdict: "correct" | "almost" | "incorrect";
  readonly errorCategory: string | null;
  readonly fragments: readonly string[];
  readonly note: string;
}

/** Kontekst walidacji werdyktu: kategorie celu i surowa odpowiedź dziecka. */
export interface VerdictContext {
  readonly allowedCategories: readonly string[];
  readonly childAnswer: string;
}

/** Ocena celu po dopasowaniu lub werdykcie (design: tabela mapowania). */
export interface ObjectiveGrade {
  readonly outcome: SkillOutcome;
  readonly reason?: OutcomeReason;
  readonly verdict:
    | "exact"
    | "minor_typo"
    | "model_correct"
    | "model_almost"
    | "model_incorrect"
    | "model_other"
    | "unavailable"
    | "closed_correct"
    | "closed_incorrect"
    | "no_match";
  readonly errorCategory?: string;
}

/** Maksymalny rozmiar tablic/napisów werdyktu (design „Model oceniający”). */
const MAX_FRAGMENTS = 4;
const MAX_NOTE_LENGTH = 300;

/** Czy `toLowerCase` zachowuje liczbę punktów kodowych (jak w `compareSpelling`). */
function casefoldStable(text: string): boolean {
  return [...text.toLowerCase()].length === [...text].length;
}

/** Pierwsze dopasowanie w zbiorze sekwencji po obu stronach → exact. */
function sequencesEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((token, i) => token === b[i]);
}

/**
 * Zbiór tokenów „w focus”: każdy token z każdego wariantu znormalizowanego
 * `focus`. Token odpowiedzi jest „w focus”, jeśli należy do tego zbioru.
 */
function focusTokenSet(focus: readonly string[], normalizer: AnswerNormalizer): Set<string> {
  const set = new Set<string>();
  for (const variant of normalizer.normalize(focus.join(" "))) {
    for (const token of variant) {
      set.add(token);
    }
  }
  return set;
}

/** Maksymalny dozwolony OSA dla danego tokenu wg jego długości (punkty kodowe). */
function typoThresholdFor(token: string): number {
  return [...token].length <= TYPO_TOLERANCE.shortTokenMaxLength
    ? TYPO_TOLERANCE.shortMaxDistance
    : TYPO_TOLERANCE.longMaxDistance;
}

/**
 * Dopasowanie odpowiedzi do klucza (design „Ocena”):
 * 1. normalizacja odpowiedzi i wszystkich wariantów normalizatorem przedmiotu,
 * 2. równość dowolnych dwóch sekwencji → exact,
 * 3. sekwencja wariantu tej samej długości różniąca się DOKŁADNIE jednym
 *    tokenem spoza focus, z OSA w progu → minor_typo (token = zapis dziecka),
 * 4. w przeciwnym razie no_match.
 * Pusty focus wyłącza tolerancję literówki (brak informacji o elemencie
 * sprawdzanym — bezpieczny domyślny wybór).
 */
export function matchLessonAnswer(
  answer: string,
  key: LessonAnswerKey,
  normalizer: AnswerNormalizer,
): MatchResult {
  const answerVariants = normalizer.normalize(answer).filter((seq) => seq.length > 0);
  if (answerVariants.length === 0) {
    return { kind: "no_match" };
  }
  const variants = [key.answer, ...key.acceptedAnswers];
  const normalizedVariants = variants.map((variant) => ({
    original: variant,
    sequences: normalizer.normalize(variant),
  }));

  // (2) exact
  for (const variant of normalizedVariants) {
    for (const vSeq of variant.sequences) {
      if (answerVariants.some((aSeq) => sequencesEqual(aSeq, vSeq))) {
        return { kind: "exact", variant: variant.original };
      }
    }
  }

  // (3) minor_typo — wyłączone dla pustego focus
  if (key.focus.length > 0) {
    const focusSet = focusTokenSet(key.focus, normalizer);
    for (const variant of normalizedVariants) {
      for (const vSeq of variant.sequences) {
        for (const aSeq of answerVariants) {
          const typo = singleTypoToken(aSeq, vSeq, focusSet);
          if (typo !== null) {
            return { kind: "minor_typo", variant: variant.original, typoToken: typo };
          }
        }
      }
    }
  }

  return { kind: "no_match" };
}

/**
 * Jeśli sekwencje mają tę samą długość i różnią się dokładnie jednym tokenem,
 * ten token nie jest „w focus” i jego OSA mieści się w progu — zwraca token
 * odpowiedzi dziecka. Inaczej `null`.
 */
function singleTypoToken(
  answerSeq: readonly string[],
  variantSeq: readonly string[],
  focusSet: ReadonlySet<string>,
): string | null {
  if (answerSeq.length !== variantSeq.length) {
    return null;
  }
  let diffIndex = -1;
  for (let i = 0; i < answerSeq.length; i++) {
    if (answerSeq[i] !== variantSeq[i]) {
      if (diffIndex !== -1) {
        return null; // więcej niż jeden różniący się token
      }
      diffIndex = i;
    }
  }
  if (diffIndex === -1) {
    return null; // identyczne — to byłby exact, nie typo
  }
  const answerToken = answerSeq[diffIndex];
  const variantToken = variantSeq[diffIndex];
  // Literówka nie może dotyczyć elementu sprawdzanego (ani po stronie wariantu,
  // ani odpowiedzi — oba warianty rozwinięcia focus są chronione).
  if (focusSet.has(variantToken) || focusSet.has(answerToken)) {
    return null;
  }
  if (editDistance(answerToken, variantToken) <= typoThresholdFor(variantToken)) {
    return answerToken;
  }
  return null;
}

/** Ocena typu zamkniętego po id poprawnej opcji. */
export function evaluateChoice(optionId: string, key: LessonAnswerKey): boolean {
  return key.correctOptionId !== undefined && optionId === key.correctOptionId;
}

/** Ocena układania z klocków: ta sama długość i kolejność co `key.itemIds`. */
/**
 * Wybór pojęć kluczowych (`lesson_keywords`): poprawny, gdy każde wskazane
 * pojęcie jest kluczowe. Liczba wyborów spoza [min, max] nie jest oceniana
 * (`null`) — klient pilnuje zakresu, serwer nie karze za błąd transportu.
 */
export function evaluateKeywordSelection(itemIds: readonly string[], key: LessonAnswerKey): boolean | null {
  const correct = new Set(key.correctOptionIds ?? []);
  const min = key.minSelected ?? 1;
  const max = key.maxSelected ?? correct.size;
  if (correct.size === 0 || itemIds.length < min || itemIds.length > max || new Set(itemIds).size !== itemIds.length) {
    return null;
  }
  return itemIds.every((id) => correct.has(id));
}

/**
 * Ocena przypisań (design szkoły §10.3): `true`, gdy każde przypisanie zgadza
 * się z kluczem. `null`, gdy odpowiedź nie pasuje kształtem do zadania (brak
 * lub obcy element, nieznany cel, cel pary użyty dwukrotnie) — to błąd
 * klienta, nie wiedzy dziecka.
 */
export function evaluateAssignment(
  given: readonly { readonly itemId: string; readonly targetId: string }[],
  key: LessonAnswerKey,
): boolean | null {
  const expected = new Map((key.assignments ?? []).map((entry) => [entry.itemId, entry.targetId] as const));
  const targets = new Set(key.targetIds ?? []);
  if (expected.size === 0 || given.length !== expected.size) return null;
  if (new Set(given.map((entry) => entry.itemId)).size !== given.length) return null;
  if (given.some((entry) => !expected.has(entry.itemId) || !targets.has(entry.targetId))) return null;
  if (key.targetOnce === true && new Set(given.map((entry) => entry.targetId)).size !== given.length) return null;
  return given.every((entry) => expected.get(entry.itemId) === entry.targetId);
}

/**
 * Tekst przypisań do feedbacku, omówienia i raportów (design szkoły §10.3).
 * Pary: `element → cel` w kolejności `itemOrder` (domyślnie kolejność wejścia),
 * złączone „; ”. Grupy (`grouped`): `cel: elementy` w kolejności `targetOrder`.
 * Przypisania z nieznanym tekstem są pomijane.
 */
export function assignmentText(
  assignments: readonly { readonly itemId: string; readonly targetId: string }[],
  values: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
  options: { readonly grouped?: boolean; readonly targetOrder?: readonly string[]; readonly itemOrder?: readonly string[] } = {},
): string {
  const valueOf = (id: string): string | undefined => (values instanceof Map ? values.get(id) : (values as Readonly<Record<string, string>>)[id]);
  const position = new Map((options.itemOrder ?? []).map((id, index) => [id, index] as const));
  const ordered = [...assignments].sort((a, b) => (position.get(a.itemId) ?? 0) - (position.get(b.itemId) ?? 0));
  if (options.grouped) {
    const targets = options.targetOrder ?? [...new Set(ordered.map((entry) => entry.targetId))];
    return targets.flatMap((targetId) => {
      const label = valueOf(targetId);
      const items = ordered.filter((entry) => entry.targetId === targetId).map((entry) => valueOf(entry.itemId)).filter((text): text is string => Boolean(text));
      return label && items.length > 0 ? [`${label}: ${items.join(", ")}`] : [];
    }).join("; ");
  }
  return ordered.flatMap((entry) => {
    const item = valueOf(entry.itemId);
    const target = valueOf(entry.targetId);
    return item && target ? [`${item} → ${target}`] : [];
  }).join("; ");
}

export function evaluateSequence(itemIds: readonly string[], key: LessonAnswerKey): boolean {
  const expected = key.itemIds;
  if (expected === undefined || expected.length !== itemIds.length) {
    return false;
  }
  const values = key.itemValues;
  if (values === undefined) {
    return expected.every((id, i) => id === itemIds[i]);
  }
  // Klocki o tym samym tekście są zamienne (#298): permutacja klocków, potem tekst na każdej pozycji.
  const known = new Set(expected);
  const isPermutation = new Set(itemIds).size === itemIds.length && itemIds.every((id) => known.has(id));
  return isPermutation && expected.every((id, i) => values[id] === values[itemIds[i]!]);
}

/** Schemat werdyktu modelu — nadmiarowe pola odcięte (`.strip` domyślny w zod). */
const verdictSchema = z.object({
  verdict: z.enum(["correct", "almost", "incorrect"]),
  errorCategory: z.string().nullable(),
  fragments: z.array(z.string().min(1)).max(MAX_FRAGMENTS),
  note: z.string().max(MAX_NOTE_LENGTH),
});

/**
 * Walidacja werdyktu modelu (design „Model oceniający”, wymagania 6.7).
 * Zwraca `GraderVerdict` tylko gdy: schemat się zgadza; kategoria ∈
 * `allowedCategories` ∪ {other} albo null; `correct` ⇒ kategoria null i brak
 * fragmentów; `incorrect` ⇒ kategoria niepusta; każdy fragment jest dokładnym
 * (z rozróżnieniem wielkości liter), niepustym podciągiem `childAnswer` po NFC.
 * Naruszenie → `null`. Nadmiarowe pola są odcięte, nie przekazywane dalej.
 */
export function validateVerdict(raw: unknown, ctx: VerdictContext): GraderVerdict | null {
  const parsed = verdictSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const { verdict, errorCategory, fragments, note } = parsed.data;

  if (errorCategory !== null) {
    const allowed = errorCategory === "other" || ctx.allowedCategories.includes(errorCategory);
    if (!allowed) {
      return null;
    }
  }

  if (verdict === "correct" && (errorCategory !== null || fragments.length > 0)) {
    return null;
  }
  if (verdict === "incorrect" && errorCategory === null) {
    return null;
  }

  const childAnswerNfc = ctx.childAnswer.normalize("NFC");
  for (const fragment of fragments) {
    if (!childAnswerNfc.includes(fragment.normalize("NFC"))) {
      return null;
    }
  }

  return { verdict, errorCategory, fragments, note };
}


/**
 * Werdykt dwuwymiarowy przedmiotów szkolnych (Etap 2): wiedza steruje wynikiem,
 * precyzja tylko raportuje. `partial` jest odpowiedzią częściowo poprawną
 * (część elementów wymaganych + brak istotnego błędu jako jedynej treści).
 */
export interface SchoolVerdict {
  readonly knowledge: "correct" | "partial" | "incorrect";
  readonly precision: "concise" | "verbose" | "unfocused";
  readonly matchedElementIds: readonly string[];
  readonly missingElementIds: readonly string[];
  readonly incorrectStatements: readonly string[];
  /** Poprawne, ale zbędne (źródło §5.5). */
  readonly redundantFragments: readonly string[];
  /** Niezwiązane z pytaniem (v3, design §9.1); werdykty v2 mają pustą listę. */
  readonly offTopicFragments: readonly string[];
  /** Pomylone pojęcia: `said` z odpowiedzi zamiast `meant` (v3); wyłącznie dla rodzica i selektora. */
  readonly confusedConcepts: readonly ConfusedConcept[];
  readonly note: string;
}

export interface ConfusedConcept {
  readonly said: string;
  readonly meant: string;
}

export interface SchoolVerdictContext {
  readonly requiredElementIds: readonly string[];
  readonly childAnswer: string;
  /** Czy odpowiedź spełnia oczekiwaną formę zdaniową (null = forma bez znaczenia / niezweryfikowana). */
  readonly formOk?: boolean | null;
}

const schoolVerdictSchema = z.object({
  knowledge: z.enum(["correct", "partial", "incorrect"]),
  precision: z.enum(["concise", "verbose", "unfocused"]),
  matchedElementIds: z.array(z.string().min(1)).max(6),
  missingElementIds: z.array(z.string().min(1)).max(6),
  incorrectStatements: z.array(z.string().min(1)).max(4),
  redundantFragments: z.array(z.string().min(1)).max(4),
  // v3 (design §9.1): brak pól = werdykt v2, czyli puste listy
  offTopicFragments: z.array(z.string().min(1)).max(4).default([]),
  confusedConcepts: z.array(z.object({
    said: z.string().min(1).max(60),
    meant: z.string().min(1).max(60),
  })).max(2).default([]),
  note: z.string().max(MAX_NOTE_LENGTH),
});

/**
 * Polskie skróty z kropką, które zwykle nie kończą zdania (porównanie bez
 * końcowej kropki, małymi literami). Pojedyncza litera z kropką (inicjał,
 * „r.”, „w.”) też nie kończy zdania.
 */
const NON_TERMINAL_ABBREVIATIONS = new Set([
  "np", "itp", "itd", "tzn", "tj", "tzw", "m.in", "ok", "wg", "dr", "prof", "mgr", "inż",
  "św", "ul", "al", "nr", "str", "zob", "por", "ww", "jw", "n.p.m", "p.n.e", "n.e",
  "godz", "min", "tys", "mln", "mld", "ang", "łac", "gr", "ds", "im", "wyd", "rys",
  "tab", "pkt", "ust", "art", "tel", "wsp", "pow",
]);
const SENTENCE_TERMINATORS = new Set([".", "!", "?", "…"]);
const CLOSING_MARKS = new Set(["\"", "”", "’", "»", ")", "]"]);
const OPENING_MARKS = new Set(["\"", "„", "“", "‘", "«", "(", "["]);

/** Indeks końca początkowej serii znaków z `chars`. */
function leadingRunEnd(word: string, chars: ReadonlySet<string>): number {
  let end = 0;
  while (end < word.length && chars.has(word[end]!)) end += 1;
  return end;
}

/** Indeks początku końcowej serii znaków z `chars` (liniowo, bez regexu z backtrackingiem). */
function trailingRunStart(word: string, chars: ReadonlySet<string>): number {
  let start = word.length;
  while (start > 0 && chars.has(word[start - 1]!)) start -= 1;
  return start;
}

/**
 * Deterministyczne liczenie zdań (forma `one_sentence`): granica zdania to
 * słowo zakończone terminatorem `. ! ? …`, po którym następuje kolejne słowo;
 * brak terminatora końcowego nadal liczy ostatnie zdanie. Kropka w skrócie
 * („np.”, „m.in.”, inicjał) ani w liczbie („3.5”) nie kończy zdania. Wynik
 * jest wskazówką ograniczającą precyzję, nigdy wiedzę.
 */
export function countSentences(text: string): number {
  const words = text.normalize("NFC").trim().split(/\s+/u).filter((w) => w !== "");
  if (words.length === 0) return 0;
  let sentences = 1;
  for (const word of words.slice(0, -1)) {
    // Cudzysłowy i nawiasy wokół słowa („(np.”, „cukry.)”) nie zmieniają granicy.
    const bare = word.slice(0, trailingRunStart(word, CLOSING_MARKS));
    const terminatorStart = trailingRunStart(bare, SENTENCE_TERMINATORS);
    if (terminatorStart === bare.length) continue;
    const stem = bare.slice(leadingRunEnd(bare, OPENING_MARKS), terminatorStart).toLowerCase();
    const abbreviation = bare.slice(terminatorStart) === "." && (NON_TERMINAL_ABBREVIATIONS.has(stem) || /^\p{L}$/u.test(stem));
    if (!abbreviation && stem !== "") sentences += 1;
  }
  return sentences;
}

/**
 * Walidacja werdyktu szkolnego. Naruszenie którejkolwiek reguły → `null`
 * (odpowiedź zostaje „nieoceniona”, bez kary): identyfikatory tylko z listy
 * elementów ćwiczenia; KAŻDY element wymagany musi wystąpić w dokładnie
 * jednej z list matched/missing (pełna partycja — element niewymieniony nie
 * może po cichu zaliczyć wiedzy); `correct` bez braków i błędnych stwierdzeń;
 * `partial` z co najmniej jednym trafionym elementem oraz brakiem lub
 * nieścisłością; kompletna, poprawna treść nie może być partial/incorrect;
 * fragmenty (błędne i zbędne) jako
 * dokładne podciągi odpowiedzi po NFC; `formOk === false` ogranicza precyzję
 * co najwyżej do `verbose` (klamp, nie odrzucenie).
 */
export function validateSchoolVerdict(raw: unknown, ctx: SchoolVerdictContext): SchoolVerdict | null {
  const parsed = schoolVerdictSchema.safeParse(raw);
  if (!parsed.success) return null;
  const v = parsed.data;
  const required = new Set(ctx.requiredElementIds);
  const matched = [...new Set(v.matchedElementIds)];
  const missing = [...new Set(v.missingElementIds)];
  if (!matched.every((id) => required.has(id)) || !missing.every((id) => required.has(id))) return null;
  if (matched.some((id) => missing.includes(id))) return null;
  // Pełna partycja: rozłączne podzbiory listy wymaganej o sumie równej jej rozmiarowi.
  if (matched.length + missing.length !== required.size) return null;
  // Pomylenie pojęć to luka w treści nawet przy komplecie elementów (design §9.1).
  const hasGap = missing.length > 0 || v.incorrectStatements.length > 0 || v.confusedConcepts.length > 0;
  if (v.knowledge === "correct" && hasGap) return null;
  if (v.knowledge === "partial" && (matched.length === 0 || !hasGap)) return null;
  if (v.knowledge === "incorrect" && !hasGap) return null;
  const answerNfc = ctx.childAnswer.normalize("NFC");
  for (const fragment of [...v.incorrectStatements, ...v.redundantFragments, ...v.offTopicFragments]) {
    if (!answerNfc.includes(fragment.normalize("NFC"))) return null;
  }
  // Kategorie fragmentów są rozłączne: ten sam tekst nie może być naraz błędem, zbędnym i nie na temat
  // — także częściowo (fragment jednej kategorii zawarty w fragmencie innej albo nachodzący na niego).
  const categorized = [...v.incorrectStatements, ...v.redundantFragments, ...v.offTopicFragments].map((f) => f.normalize("NFC"));
  if (new Set(categorized).size !== categorized.length) return null;
  if (categoriesOverlap(answerNfc, [v.incorrectStatements, v.redundantFragments, v.offTopicFragments])) return null;
  // Pomylenie pojęć to błąd treści: nigdy przy wiedzy poprawnej; `said` pochodzi z odpowiedzi.
  if (v.confusedConcepts.length > 0 && v.knowledge === "correct") return null;
  const confusedConcepts: ConfusedConcept[] = [];
  const seenPairs = new Set<string>();
  for (const pair of v.confusedConcepts) {
    const said = pair.said.normalize("NFC").trim();
    const meant = pair.meant.normalize("NFC").trim();
    const saidKey = said.toLocaleLowerCase("pl-PL");
    const meantKey = meant.toLocaleLowerCase("pl-PL");
    if (said === "" || meant === "" || saidKey === meantKey) return null;
    if (!answerNfc.toLocaleLowerCase("pl-PL").includes(saidKey)) return null;
    // ta sama para dwa razy to jedno pomylenie (raport liczy oceny, nie powtórzenia)
    if (seenPairs.has(`${saidKey}|${meantKey}`)) continue;
    seenPairs.add(`${saidKey}|${meantKey}`);
    confusedConcepts.push({ said, meant });
  }
  const precision = ctx.formOk === false && v.precision === "concise" ? "verbose" : v.precision;
  return {
    knowledge: v.knowledge,
    precision,
    matchedElementIds: matched,
    missingElementIds: missing,
    incorrectStatements: [...v.incorrectStatements],
    redundantFragments: [...v.redundantFragments],
    offTopicFragments: [...v.offTopicFragments],
    confusedConcepts,
    note: v.note,
  };
}

/**
 * Czy zakresy fragmentów różnych kategorii na siebie nachodzą. Zakres to
 * pierwsze wystąpienie bez rozróżniania wielkości liter — dokładnie tak, jak
 * zaznacza je `buildAnswerSegments` (inaczej „Kot” i „kot” trafiłyby w dziecku
 * na to samo słowo). Nachodzenie w obrębie jednej kategorii jest dozwolone —
 * segmenty scalają je w jeden.
 */
function categoriesOverlap(answerNfc: string, categories: readonly (readonly string[])[]): boolean {
  const haystack = answerNfc.toLowerCase();
  const spans = categories.flatMap((fragments, category) => fragments.map((fragment) => {
    const text = fragment.normalize("NFC").toLowerCase();
    const start = haystack.indexOf(text);
    return { category, start, end: start + text.length };
  }));
  return spans.some((a, i) => spans.some((b, j) => j > i && a.category !== b.category && a.start < b.end && b.start < a.end));
}

/**
 * Mapowanie wiedzy na ocenę celu: correct zalicza jak model_correct; partial
 * jest „prawie” (`model_almost` w szczegółach) — nie zalicza opanowania
 * i — jak każdy niepełny wynik samodzielnego sprawdzenia — przerywa serię
 * (reguła silnika „błąd przerywa serię”); incorrect jak model_incorrect.
 * Precyzja CELOWO nie występuje w tym mapowaniu (test jednostkowy).
 */
export function gradeFromSchoolVerdict(verdict: SchoolVerdict | null): ObjectiveGrade {
  if (verdict === null) {
    return { outcome: "unevaluated", reason: "technical", verdict: "unavailable" };
  }
  switch (verdict.knowledge) {
    case "correct":
      return { outcome: "correct", verdict: "model_correct" };
    case "partial":
      // Kategoria z faktycznego powodu: pomylone pojęcia, brak elementu albo nieścisłe stwierdzenie.
      return {
        outcome: "incorrect",
        verdict: "model_almost",
        errorCategory: verdict.confusedConcepts.length > 0 ? "confused_concept"
          : verdict.missingElementIds.length > 0 ? "missing_element" : "wrong_fact",
      };
    case "incorrect":
      return {
        outcome: "incorrect",
        verdict: "model_incorrect",
        errorCategory: verdict.confusedConcepts.length > 0 ? "confused_concept"
          : verdict.incorrectStatements.length > 0 ? "wrong_fact" : "incomplete",
      };
  }
}
/**
 * Mapowanie dopasowania deterministycznego na ocenę celu (design: tabela).
 * `no_match` NIE jest oceną — zwracamy `null`, żeby wywołujący musiał
 * eskalować do zapisanego werdyktu / modelu. `null` nigdy nie zostanie
 * pomylone z `ObjectiveGrade` (brak pola `outcome`), więc kształt jest
 * jednoznaczny (decyzja opisana w raporcie).
 */
export function gradeFromMatch(match: MatchResult): ObjectiveGrade | null {
  switch (match.kind) {
    case "exact":
      return { outcome: "correct", verdict: "exact" };
    case "minor_typo":
      return { outcome: "correct", verdict: "minor_typo" };
    case "no_match":
      return null;
  }
}

/**
 * Mapowanie werdyktu modelu (lub jego braku) na ocenę celu (design: tabela).
 * `null` (model niedostępny / timeout / odrzucony wynik) → nieocenione,
 * powód techniczny, bez kary.
 */
export function gradeFromVerdict(verdict: GraderVerdict | null): ObjectiveGrade {
  if (verdict === null) {
    return { outcome: "unevaluated", reason: "technical", verdict: "unavailable" };
  }
  switch (verdict.verdict) {
    case "correct":
      return { outcome: "correct", verdict: "model_correct" };
    case "almost":
      // `almost` zalicza regułę TYLKO gdy błąd NIE dotyczy sprawdzanego
      // elementu — spójnie z tolerancją literówki (literówka nie może dotyczyć
      // focusa). Niepusta kategoria celu (≠ other) znaczy, że model stwierdził
      // błąd na sprawdzanej regule (np. 'he play' + missing_ending): to NIE jest
      // sukces reguły, lecz błąd celu (wymóg 6.4/6.9). `null`/`other` → błąd
      // poza celem lub drobna nieścisłość: dalej liczy się jako sukces.
      if (verdict.errorCategory !== null && verdict.errorCategory !== "other") {
        return { outcome: "incorrect", verdict: "model_incorrect", errorCategory: verdict.errorCategory };
      }
      return { outcome: "correct", verdict: "model_almost" };
    case "incorrect":
      if (verdict.errorCategory !== null && verdict.errorCategory !== "other") {
        return { outcome: "incorrect", verdict: "model_incorrect", errorCategory: verdict.errorCategory };
      }
      // kategoria `other`: błąd poza celem → nieoceniane (design)
      return { outcome: "unevaluated", verdict: "model_other" };
  }
}

/** Suma OSA po tokenach przy wyrównaniu — tylko dla sekwencji tej samej długości. */
function tokenDistance(a: readonly string[], b: readonly string[]): number {
  if (a.length !== b.length) {
    // Różna długość: brak wyrównania tokenów. Kara proporcjonalna do różnicy
    // długości plus niezgodnych tokenów, by nadal wybrać „najbliższy”.
    const shared = Math.min(a.length, b.length);
    let distance = Math.abs(a.length - b.length);
    for (let i = 0; i < shared; i++) {
      distance += editDistance(a[i], b[i]);
    }
    return distance;
  }
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    distance += editDistance(a[i], b[i]);
  }
  return distance;
}

/**
 * Najbliższy zatwierdzony wariant (najmniejsza odległość tokenowa; przy równej
 * odległości pierwszy w kolejności `answer, ...acceptedAnswers`). Zwraca
 * ORYGINALNY zapis wariantu (nie znormalizowany) — to on jest pokazywany
 * dziecku jako „poprawna odpowiedź”. Odległość liczona po najbliższej parze
 * sekwencji (odpowiedź × wariant) z normalizatora.
 */
export function closestApprovedVariant(
  answer: string,
  key: LessonAnswerKey,
  normalizer: AnswerNormalizer,
): string {
  const answerSequences = normalizer.normalize(answer);
  const variants = [key.answer, ...key.acceptedAnswers];
  let best = variants[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const variant of variants) {
    const variantSequences = normalizer.normalize(variant);
    let variantBest = Number.POSITIVE_INFINITY;
    for (const aSeq of answerSequences) {
      for (const vSeq of variantSequences) {
        variantBest = Math.min(variantBest, tokenDistance(aSeq, vSeq));
      }
    }
    if (variantBest < bestDistance) {
      bestDistance = variantBest;
      best = variant;
    }
  }
  return best;
}

/** Segment feedbacku: `pill` = fragment do wyróżnienia, `offtopic` = niezwiązany z pytaniem (v3). */
export interface AnswerSegment {
  readonly text: string;
  readonly state: "plain" | "pill" | "offtopic";
}

/**
 * Buduje segmenty `plain`/`pill` z odpowiedzi dziecka i listy fragmentów
 * (design „Ocena”, feedback). Fragmenty szukane po PIERWSZYM wystąpieniu, po
 * punktach kodowych; nakładające się fragmenty scalone; sąsiednie segmenty
 * tego samego stanu scalone; segmenty składają się dokładnie na `childAnswer`
 * i zachowują oryginalne znaki dziecka.
 *
 * Dopasowanie fragmentu jest bez rozróżniania wielkości liter (model/typo może
 * zwrócić token znormalizowany, a odpowiedź dziecka mieć wielkie litery), ale
 * TYLKO przy stabilnym `casefold` (jak `compareSpelling`); gdy casefold zmienia
 * liczbę punktów kodowych, indeksy by się rozjechały → zwracamy `null`.
 */
export function buildAnswerSegments(
  childAnswer: string,
  fragments: readonly string[],
  offTopicFragments: readonly string[] = [],
): AnswerSegment[] | null {
  const chars = [...childAnswer];
  const n = chars.length;

  if (!casefoldStable(childAnswer) || [...fragments, ...offTopicFragments].some((fragment) => !casefoldStable(fragment))) {
    return null;
  }

  const lowerChars = chars.map((char) => char.toLowerCase());
  const marks = new Array<AnswerSegment["state"]>(n).fill("plain");

  const tagged = [
    ...fragments.map((fragment) => ({ fragment, state: "pill" as const })),
    ...offTopicFragments.map((fragment) => ({ fragment, state: "offtopic" as const })),
  ];
  for (const { fragment, state: mark } of tagged) {
    const fragChars = [...fragment].map((char) => char.toLowerCase());
    if (fragChars.length === 0) {
      continue;
    }
    // pierwsze wystąpienie
    for (let start = 0; start + fragChars.length <= n; start++) {
      let matched = true;
      for (let k = 0; k < fragChars.length; k++) {
        if (lowerChars[start + k] !== fragChars[k]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        for (let k = 0; k < fragChars.length; k++) {
          // nakładające się fragmenty naturalnie scalone; „nie na temat” wygrywa z „zbędne”
          if (marks[start + k] !== "offtopic") marks[start + k] = mark;
        }
        break;
      }
    }
  }

  const segments: AnswerSegment[] = [];
  for (let i = 0; i < n; i++) {
    const state = marks[i]!;
    const last = segments[segments.length - 1];
    if (last !== undefined && last.state === state) {
      segments[segments.length - 1] = { text: last.text + chars[i], state };
    } else {
      segments.push({ text: chars[i], state });
    }
  }
  return segments.length > 0 ? segments : [{ text: "", state: "plain" }];
}
