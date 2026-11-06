import type { LessonExerciseDraft } from "../../types";
import { normalizeTokens } from "../../normalize";
import { clip, type LessonRuleIssue } from "../../rules/catalog";
import { editDistance } from "../../../text-distance";
import { baseOfIngForm, isCollocationIngForm, isIngFormInTable } from "../english/ing-forms";
import { englishNormalizer } from "../english/normalizer";
import { BE_FORMS } from "./be-agreement";
import { ingBaseOf, presentSimpleBaseOf, SENTENCE_BOUNDARY, tenseTokens } from "./present-continuous-tense-choice";
import { presentSimpleForms } from "./present-simple-forms";
import { grammarIssue, MAX_ERROR_FIX_REGION_TOKENS } from "./rules";
import { movableTimeMarkers } from "./time-markers";

/**
 * Reguły typów ćwiczeń tematu Present Continuous: poprawianie błędu (design
 * „Present Continuous” §6.3), kształt przekształcenia, „Wskaż słowo” (§6.5)
 * „Posłuchaj i wybierz” (§6.6) i rozsypanka. Wydzielone z `present-continuous-validation.ts`,
 * który je woła; ten plik nie importuje walidatora tematu (bez cyklu). Zgłoszenia reguł
 * `grammar.pc_*` katalogu gramatyki (`rules.ts`).
 */

/** Najwięcej zmian liter między błędną a poprawną pisownią -ing (swiming → swimming, lieing → lying). */
const MAX_ING_SPELLING_EDITS = 2;

interface ErrorFixDiff {
  readonly wrong: readonly string[];
  readonly right: readonly string[];
  /** Tokeny odpowiedzi (wariant normalizacji, z którego pochodzi obszar) i początek obszaru w nich. */
  readonly answerTokens: readonly string[];
  readonly start: number;
}

function regionSize(diff: Pick<ErrorFixDiff, "wrong" | "right">): number {
  return Math.max(diff.wrong.length, diff.right.length);
}

/**
 * Obszar różnicy dla każdej pary wariantów normalizacji (skróty dwuznaczne
 * „He's” dają kilka sekwencji) — wygrywa najmniejszy. null, gdy któraś para
 * jest identyczna albo najmniejszy obszar ma więcej niż 3 tokeny po którejś stronie.
 */
function errorFixDiff(statement: string, answer: string): ErrorFixDiff | null {
  let best: ErrorFixDiff | undefined;
  for (const wrongTokens of englishNormalizer.normalize(statement)) {
    for (const answerTokens of englishNormalizer.normalize(answer)) {
      const shorter = Math.min(wrongTokens.length, answerTokens.length);
      let start = 0;
      while (start < shorter && wrongTokens[start] === answerTokens[start]) start++;
      let end = 0;
      while (end < shorter - start && wrongTokens.at(-1 - end) === answerTokens.at(-1 - end)) end++;
      const diff: ErrorFixDiff = {
        wrong: wrongTokens.slice(start, wrongTokens.length - end),
        right: answerTokens.slice(start, answerTokens.length - end),
        answerTokens,
        start,
      };
      if (regionSize(diff) === 0) return null;
      if (best === undefined || regionSize(diff) < regionSize(best)) best = diff;
    }
  }
  return best !== undefined && regionSize(best) <= MAX_ERROR_FIX_REGION_TOKENS ? best : null;
}

/**
 * Obszar różnicy zdania z błędem i odpowiedzi `error_fix` (§6.3): po
 * normalizacji z rozwinięciem skrótów (`englishNormalizer`) tokeny między
 * wspólnym prefiksem a wspólnym sufiksem. null, gdy zdania się nie różnią
 * albo obszar ma więcej niż 3 tokeny po którejś stronie.
 */
export function errorFixRegion(statement: string, answer: string): { readonly wrong: readonly string[]; readonly right: readonly string[] } | null {
  const diff = errorFixDiff(statement, answer);
  return diff === null ? null : { wrong: diff.wrong, right: diff.right };
}

type ErrorFixKind = "missing_be" | "missing_ing" | "wrong_be" | "ing_spelling" | "tense_swap";

const ERROR_FIX_KIND_LABELS: Readonly<Record<ErrorFixKind, string>> = {
  missing_be: "brak am/is/are",
  missing_ing: "brak -ing po am/is/are",
  wrong_be: "zła forma am/is/are",
  ing_spelling: "zła pisownia -ing",
  tense_swap: "Present Simple zamiast Present Continuous albo odwrotnie",
};

/**
 * Sprawdzany element celu w obszarze różnicy (§6.3). Zła forma be to kategoria
 * błędów celów 1, 3, 4 (zgodność klucza z podmiotem sprawdza reguła be); cele
 * porównania (2, 6) ćwiczą zamianę PS ↔ PC. Do/does zamiast be nie jest już
 * obszarem celów 3 i 4: takie zdanie z błędem ma dwie poprawki (`doBeforeIng`).
 */
export const ERROR_FIX_KINDS: Readonly<Record<string, readonly ErrorFixKind[]>> = {
  affirmative: ["missing_be", "missing_ing", "wrong_be"],
  now_or_usually: ["tense_swap"],
  negative: ["missing_be", "missing_ing", "wrong_be"],
  questions: ["missing_be", "missing_ing", "wrong_be"],
  ing_spelling: ["ing_spelling"],
  now_or_usually_more: ["tense_swap"],
};

/** Brak formy be: odpowiedź to zdanie z błędem z jedną dodaną formą am/is/are („He playing” → „He is playing”). */
function isMissingBe({ wrong, right }: ErrorFixDiff): boolean {
  if (right.length !== wrong.length + 1) return false;
  const wrongText = wrong.join(" ");
  return right.some((token, i) => BE_FORMS.has(token) && right.toSpliced(i, 1).join(" ") === wrongText);
}

/** Forma podstawowa formy -ing na pozycji `index`: z tabeli albo z kolokacji „having/looking”. */
function ingBaseAt(tokens: readonly string[], index: number): string | undefined {
  const token = tokens[index];
  if (token === undefined) return undefined;
  const fromTable = baseOfIngForm(token);
  if (fromTable !== undefined || !isCollocationIngForm(tokens, index)) return fromTable;
  return ingBaseOf(token);
}

/**
 * Brak -ing po be: forma podstawowa albo forma Present Simple zamiast formy
 * -ing tego samego czasownika, a przed nią w odpowiedzi stoi am/is/are
 * („She is play/plays” → „She is playing”, „Is she read?” → „Is she reading?”).
 */
function isMissingIng({ wrong, right, answerTokens, start }: ErrorFixDiff): boolean {
  if (wrong.length !== 1 || right.length !== 1) return false;
  const base = ingBaseAt(answerTokens, start);
  if (base === undefined || !presentSimpleForms(base).has(wrong[0]!)) return false;
  return answerTokens.slice(0, start).some((token) => BE_FORMS.has(token));
}

/** Zła forma be: po jednym tokenie z każdej strony, oba to am/is/are („He are playing” → „He is playing”). */
function isWrongBe({ wrong, right }: ErrorFixDiff): boolean {
  return wrong.length === 1 && right.length === 1 && BE_FORMS.has(wrong[0]!) && BE_FORMS.has(right[0]!);
}

/**
 * do/does (także z not) przed formą -ing w zdaniu z błędem (ślepa ocena sondy, Task 18): „Tom doesn't
 * watching TV now.” ma dwie poprawki (isn't watching albo doesn't watch), a „Does she reading?” — „Is she
 * reading?” albo „Does she read?”. Między do/does a formą -ing mogą stać not i podmiot pytania, ale nie
 * forma be ani inny czasownik („Does she go swimming?” to nie ten błąd). Zwraca znalezioną parę albo undefined.
 */
function doBeforeIng(statement: string): string | undefined {
  for (const tokens of statement.split(SENTENCE_BOUNDARY).map(tenseTokens)) {
    for (const [index, token] of tokens.entries()) {
      if (token !== "do" && token !== "does") continue;
      for (let next = index + 1; next < tokens.length; next++) {
        const candidate = tokens[next]!;
        if (isIngFormInTable(candidate) || isCollocationIngForm(tokens, next)) return `${token} ${tokens.slice(index + 1, next + 1).join(" ")}`;
        if (BE_FORMS.has(candidate) || presentSimpleBaseOf(candidate) !== undefined) break;
      }
    }
  }
  return undefined;
}

/** Strona obszaru w Present Simple: forma czasownika albo do/does + not + forma podstawowa. */
function presentSimpleSide(tokens: readonly string[]): { base: string; negative: boolean } | undefined {
  if (tokens.length === 1) {
    const base = presentSimpleBaseOf(tokens[0]!);
    return base === undefined ? undefined : { base, negative: false };
  }
  const [operator, not, verb] = tokens;
  if (tokens.length !== 3 || (operator !== "do" && operator !== "does") || not !== "not") return undefined;
  return presentSimpleBaseOf(verb!) === verb ? { base: verb!, negative: true } : undefined;
}

/** Strona obszaru w Present Continuous: am/is/are [not] + forma -ing. */
function presentContinuousSide(tokens: readonly string[]): { base: string; negative: boolean } | undefined {
  const negative = tokens[1] === "not";
  if (tokens.length !== (negative ? 3 : 2) || !BE_FORMS.has(tokens[0]!)) return undefined;
  const base = ingBaseOf(tokens.at(-1)!);
  return base === undefined ? undefined : { base, negative };
}

/**
 * Zamiana PS ↔ PC (cele 2, 6): jedna strona to forma Present Simple
 * czasownika, druga be + jego forma -ing, z tą samą biegunowością („Look!
 * Ola reads.” → „Look! Ola is reading.”). Zgodność strony poprawnej z grupą
 * wskaźnika sprawdza reguła czasu odpowiedzi.
 */
function isTenseSwap({ wrong, right }: ErrorFixDiff): boolean {
  return [[wrong, right], [right, wrong]].some(([simpleTokens, continuousTokens]) => {
    const simple = presentSimpleSide(simpleTokens!);
    const continuous = presentContinuousSide(continuousTokens!);
    return simple !== undefined && continuous !== undefined && simple.base === continuous.base && simple.negative === continuous.negative;
  });
}

/** Zła pisownia -ing (cel 5): forma błędna spoza tabeli, poprawna z tabeli, różnica kilku liter. */
function isIngSpelling({ wrong, right }: Pick<ErrorFixDiff, "wrong" | "right">): boolean {
  if (wrong.length !== 1 || right.length !== 1) return false;
  return !isIngFormInTable(wrong[0]!) && isIngFormInTable(right[0]!) && editDistance(wrong[0]!, right[0]!) <= MAX_ING_SPELLING_EDITS;
}

/**
 * Czy opcja to klucz z błędnie zapisaną formą -ing (cel 5, wybór): po normalizacji różni się od klucza
 * jednym tokenem, a ten jest jak w `error_fix` złą pisownią formy -ing klucza („is swiming” przy „is
 * swimming”). Inna poprawna forma („is running”) albo inny czas to drugi poprawny wybór.
 */
export function isIngMisspellingOf(option: string, key: string): boolean {
  const wrong = normalizeTokens(option);
  const right = normalizeTokens(key);
  if (wrong.length !== right.length) return false;
  const differing = wrong.flatMap((token, i) => (token === right[i] ? [] : [i]));
  return differing.length === 1 && isIngSpelling({ wrong: [wrong[differing[0]!]!], right: [right[differing[0]!]!] });
}

const ERROR_FIX_MATCHERS: Readonly<Record<ErrorFixKind, (diff: ErrorFixDiff) => boolean>> = {
  missing_be: isMissingBe,
  missing_ing: isMissingIng,
  wrong_be: isWrongBe,
  ing_spelling: isIngSpelling,
  tense_swap: isTenseSwap,
};

/**
 * `error_fix` (§6.3): zdanie z błędem i każdy klucz różnią się jednym spójnym
 * obszarem (najwyżej 3 tokeny po każdej stronie), a obszar to sprawdzany
 * element celu. Cele bez wpisu w `ERROR_FIX_KINDS` sprawdzają tylko obszar.
 */
export function validateErrorFix(ex: LessonExerciseDraft, objective: string, errors: LessonRuleIssue[]): void {
  const statement = ex.statement;
  // Brak zdania z błędem zgłasza walidacja ogólna typu.
  if (statement === undefined || statement.trim() === "") return;
  const doIng = doBeforeIng(statement);
  if (doIng !== undefined) {
    errors.push(grammarIssue("grammar.pc_error_fix_do_ing", {
      pl:
        `statement: do/does przed formą -ing („${doIng}”) daje dwie poprawki (am/is/are + -ing albo do/does + forma podstawowa) ` +
        "— wybierz inny błąd",
      found: `the statement ${clip(statement)} has ${clip(doIng)}: do/does before an -ing form`,
    }));
    return;
  }
  const kinds = Object.hasOwn(ERROR_FIX_KINDS, objective) ? ERROR_FIX_KINDS[objective]! : undefined;
  const keys = [{ field: "answer", text: ex.answer }, ...ex.acceptedAnswers.map((text) => ({ field: "acceptedAnswers", text }))];
  for (const { field, text } of keys) {
    const diff = errorFixDiff(statement, text);
    if (diff === null) {
      errors.push(grammarIssue("grammar.pc_error_fix_region", {
        field,
        pl: `${field}: zdanie z błędem i poprawne muszą różnić się jednym miejscem (najwyżej ${MAX_ERROR_FIX_REGION_TOKENS} słowa po każdej stronie)`,
        found: `${field} ${clip(text)} and the statement ${clip(statement)} differ in no place or in more than ${MAX_ERROR_FIX_REGION_TOKENS} words on a side`,
      }));
      continue;
    }
    if (kinds === undefined || kinds.some((kind) => ERROR_FIX_MATCHERS[kind](diff))) continue;
    const shown = (tokens: readonly string[]): string => (tokens.length === 0 ? "(nic)" : tokens.join(" "));
    const shownEn = (tokens: readonly string[]): string => (tokens.length === 0 ? "(nothing)" : clip(tokens.join(" ")));
    errors.push(grammarIssue("grammar.pc_error_fix_kind", {
      field,
      pl:
        `${field}: różnica „${shown(diff.wrong)}” → „${shown(diff.right)}” nie jest błędem ćwiczonym w celu ` +
        `(${kinds.map((kind) => ERROR_FIX_KIND_LABELS[kind]).join(", ")})`,
      found: `the difference ${shownEn(diff.wrong)} → ${shownEn(diff.right)} is not a mistake the objective ${clip(objective)} practises`,
    }));
  }
}

/**
 * „Wskaż słowo” (§6.5): we wszystkich zdaniach dokładnie jeden token z formą
 * -ing (z tabeli albo z kolokacji „having lunch”, „looking at”) i jest nim
 * `correctOption` — inaczej dziecko wskazałoby inną poprawną formę i dostało
 * błąd (materializacja bierze pierwszy pasujący segment).
 */
export function validateNotice(ex: LessonExerciseDraft, errors: LessonRuleIssue[]): void {
  const ingForms = (ex.noticeSegments ?? []).flatMap((sentence) => {
    const tokens = sentence.flatMap(normalizeTokens);
    return tokens.filter((token, i) => isIngFormInTable(token) || isCollocationIngForm(tokens, i));
  });
  if (ingForms.length !== 1) {
    errors.push(grammarIssue("grammar.pc_notice_ing_count", {
      pl: `noticeSegments: liczba form -ing w zdaniach: ${ingForms.length} — potrzebna dokładnie jedna`,
      found: `the sentences have ${ingForms.length} -ing forms`,
    }));
    return;
  }
  const target = normalizeTokens(ex.correctOption ?? "");
  if (target.length !== 1 || target[0] !== ingForms[0]) {
    errors.push(grammarIssue("grammar.pc_notice_target", {
      pl: `correctOption: słowem do wskazania musi być forma -ing „${ingForms[0]}”`,
      found: `correctOption ${clip(ex.correctOption ?? "")} is not the -ing form ${clip(ingForms[0]!)}`,
    }));
  }
}

/** Czy tekst zawiera przeczenie (po rozwinięciu isn't / aren't / doesn't / don't). */
function isNegative(text: string): boolean {
  return tenseTokens(text).includes("not");
}

/** Czy ostatnie zdanie tekstu to pytanie z inwersją: am/is/are (także isn't/aren't) na początku i „?” na końcu. */
function isInvertedQuestion(text: string): boolean {
  if (!/\?\s*$/.test(text)) return false;
  const tokens = tenseTokens(text.trim().replace(/\?\s*$/, "").split(SENTENCE_BOUNDARY).at(-1) ?? "");
  return BE_FORMS.has(tokens[0] ?? "");
}

/**
 * Tokeny zdania przekształcenia: `tenseTokens` i „X's” → „x is” („Tom's playing” → „tom is playing”).
 * Dzierżawcze „Tom's dog” rozwija się tak samo w zdaniu wyjściowym i w kluczu, więc porównanie się zgadza.
 */
function transformTokens(text: string): string[] {
  return tenseTokens(text).flatMap((token) => (/^[\p{L}]+'s$/u.test(token) ? [token.slice(0, -2), "is"] : [token]));
}

/** Zdania tekstu jako tokeny przekształcenia (`transformTokens`), bez pustych. */
function sentenceTokensOf(text: string): string[][] {
  return text.split(SENTENCE_BOUNDARY).map(transformTokens).filter((tokens) => tokens.length > 0);
}

/**
 * Czy `negative` to `affirmative` z „not” po jednej formie am/is/are, a w celu 6 (`withSimple`)
 * także z formą Present Simple zastąpioną do/does + not + formą podstawową („Tom plays” → „Tom
 * does not play”). Zgodność do/does z podmiotem sprawdza reguła Present Simple.
 */
function isNegationOf(affirmative: readonly string[], negative: readonly string[], withSimple: boolean): boolean {
  const target = negative.join(" ");
  return affirmative.some((token, i) => {
    const replaced = (middle: readonly string[]): boolean => [...affirmative.slice(0, i), ...middle, ...affirmative.slice(i + 1)].join(" ") === target;
    if (BE_FORMS.has(token)) return replaced([token, "not"]);
    const base = withSimple ? presentSimpleBaseOf(token) : undefined;
    return base !== undefined && (replaced(["does", "not", base]) || replaced(["do", "not", base]));
  });
}

/** Czy `question` to `statement` z formą am/is/are ostatniego zdania przeniesioną na jego początek (wcześniejsze zdania bez zmian). */
function isQuestionOf(statement: string, question: string): boolean {
  const from = sentenceTokensOf(statement);
  const to = sentenceTokensOf(question);
  if (from.length === 0 || from.length !== to.length) return false;
  if (from.slice(0, -1).some((tokens, i) => tokens.join(" ") !== to[i]!.join(" "))) return false;
  const last = from.at(-1)!;
  const target = to.at(-1)!.join(" ");
  return last.some((token, i) => BE_FORMS.has(token) && [token, ...last.toSpliced(i, 1)].join(" ") === target);
}

/** Zgłoszenie: klucz przekształcenia nie powstaje ze zdania wyjściowego zamianą sprawdzanej formy. */
function transformKeyIssue(field: string, text: string, statement: string, transformId: string): LessonRuleIssue {
  return grammarIssue("grammar.pc_transform_key_statement", {
    field,
    pl:
      transformId === "to_question"
        ? `${field}: pytanie to zdanie wyjściowe z am/is/are przeniesionym na początek (He is playing now. → Is he playing now?), bez innych zmian`
        : `${field}: odpowiedź to zdanie wyjściowe z dodanym albo usuniętym „not” po am/is/are (He is playing now. → He isn't playing now.), bez innych zmian`,
    found: `${field} ${clip(text)} is not the statement ${clip(statement)} with only the checked form changed (${transformId})`,
  });
}

/**
 * Kształt przekształcenia (§3.1, fala 1 Task 19): `to_question` — zdanie wyjściowe jest twierdzeniem
 * (nie pytaniem ani przeczeniem), a każdy klucz to pytanie z inwersją powstałe z niego przez
 * przeniesienie am/is/are na początek ostatniego zdania („Look! Tom is playing.” → „Look! Is Tom
 * playing?”; bez pytań z „What”). `to_negative` / `to_affirmative` — zdanie wyjściowe ma przeciwną
 * biegunowość niż odpowiedź, a każdy klucz różni się od niego tylko „not” po am/is/are (w celu 6 także
 * do/does + not + forma podstawowa w miejsce formy Present Simple); biegunowość odpowiedzi sprawdza reguła be.
 */
export function validateTransformShape(ex: LessonExerciseDraft, objective: string, errors: LessonRuleIssue[]): void {
  const statement = ex.statement;
  // Brak zdania wyjściowego zgłasza walidacja ogólna typu.
  if (statement === undefined || statement.trim() === "") return;
  const keys = [{ field: "answer", text: ex.answer }, ...ex.acceptedAnswers.map((text) => ({ field: "acceptedAnswers", text }))];
  if (ex.transformId === "to_question") {
    if (/\?\s*$/.test(statement)) {
      errors.push(grammarIssue("grammar.pc_transform_statement_question", {
        pl: "statement: zdanie do zamiany na pytanie nie może być pytaniem",
        found: `statement ${clip(statement)} is already a question`,
      }));
      return;
    }
    if (isNegative(statement)) {
      errors.push(grammarIssue("grammar.pc_transform_question_negative", {
        pl: "statement: zdanie do zamiany na pytanie jest twierdzeniem — z przeczenia powstają dwa pytania (Isn't she…? / Is she…?)",
        found: `statement ${clip(statement)} is negated`,
      }));
      return;
    }
    for (const { field, text } of keys) {
      if (!isInvertedQuestion(text)) {
        errors.push(grammarIssue("grammar.pc_transform_question_shape", {
          field,
          pl: `${field}: pytanie zaczyna się od am/is/are i kończy znakiem „?”`,
          found: `${field} ${clip(text)} is not a question that starts with am/is/are and ends with ?`,
        }));
      } else if (!isQuestionOf(statement, text)) {
        errors.push(transformKeyIssue(field, text, statement, ex.transformId));
      }
    }
    return;
  }
  const direction = ex.transformId === "to_negative" ? "twierdzenie → przeczenie" : ex.transformId === "to_affirmative" ? "przeczenie → twierdzenie" : undefined;
  if (direction === undefined) return;
  if (isNegative(statement) === isNegative(ex.answer)) {
    errors.push(grammarIssue("grammar.pc_transform_polarity", {
      pl: `statement: zdanie do przekształcenia ma przeciwną biegunowość niż odpowiedź (${ex.transformId}: ${direction})`,
      found: `statement ${clip(statement)} has the same polarity as the answer ${clip(ex.answer)} (${ex.transformId})`,
    }));
    return;
  }
  const from = transformTokens(statement);
  for (const { field, text } of keys) {
    const to = transformTokens(text);
    const tied = ex.transformId === "to_negative" ? isNegationOf(from, to, objective === "now_or_usually_more") : isNegationOf(to, from, objective === "now_or_usually_more");
    if (!tied) errors.push(transformKeyIssue(field, text, statement, ex.transformId!));
  }
}

/** Pary opcji „Posłuchaj i wybierz” po normalizacji (Is / Are = is / are): różnica słyszalna i w sprawdzanym elemencie. */
const LISTEN_CHOICE_PAIRS: readonly (readonly string[])[] = [["is", "are"], ["isn't", "aren't"]];

/** „Posłuchaj i wybierz” (§6.6): opcje to para is / are, isn't / aren't albo Is / Are. */
export function validateListenChoiceOptions(ex: LessonExerciseDraft, errors: LessonRuleIssue[]): void {
  const options = (ex.options ?? []).map((option) => normalizeTokens(option.text).join(" "));
  const isPair = LISTEN_CHOICE_PAIRS.some((pair) => options.length === pair.length && pair.every((text) => options.includes(text)));
  if (!isPair) {
    errors.push(grammarIssue("grammar.pc_listen_choice_options", {
      pl: "options: w „Posłuchaj i wybierz” opcje to para is / are, isn't / aren't albo Is / Are (nie „He's” / „He”)",
      found: `options ${clip((ex.options ?? []).map((option) => option.text).join(" / "))} are not is / are, isn't / aren't or Is / Are`,
    }));
  }
}

/**
 * Rozsypanka (sonda 2, ślepa ocena): klocek ze wskaźnikiem czasu, który może stać na początku albo na końcu
 * zdania (`movableTimeMarkers`, także wskaźnik rozbity na kilka klocków), daje kilka poprawnych szyków
 * („Tom is reading a book now” / „Now Tom is reading a book”) — czas ustala scenka w poleceniu.
 */
export function validateOrderMarkers(ex: LessonExerciseDraft, errors: LessonRuleIssue[]): void {
  const tiles = (ex.items ?? []).map((item) => item.text).join(" ");
  const markers = movableTimeMarkers(tiles);
  if (markers.length > 0) {
    errors.push(grammarIssue("grammar.pc_order_movable_marker", {
      pl: `items: wskaźnik czasu „${markers.join("”, „")}” w klockach może stać na początku albo na końcu zdania, więc poprawny byłby więcej niż jeden szyk — czas pokaż scenką w poleceniu (Cicho! Dziadek śpi. Ułóż zdanie.)`,
      found: `items ${clip(tiles)} hold the movable time marker ${markers.map((marker) => clip(marker)).join(", ")}`,
    }));
  }
}
