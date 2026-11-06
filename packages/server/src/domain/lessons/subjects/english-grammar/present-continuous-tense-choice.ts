import type { LessonExerciseDraft } from "../../types";
import { normalizeTokens } from "../../normalize";
import { clip, type LessonRuleIssue } from "../../rules/catalog";
import { baseOfIngForm, COLLOCATION_ING_FORMS, ingFormOf, ingRuleOf, STATE_VERBS, type IngRule } from "../english/ing-forms";
import { BE_CONTRACTED_TOKENS, BE_DETERMINERS, BE_FORMS, BE_WH_WORDS } from "./be-agreement";
import { presentSimpleForms } from "./present-simple-forms";
import { grammarIssue } from "./rules";
import type { MarkerGroup } from "./time-markers";

/**
 * Czyste funkcje celów porównania tematu Present Continuous (cele 2 i 6,
 * design „Present Continuous” §5.2, §5.5, §6.2, §6.3): formy Present Simple,
 * rozpoznanie czasu zdania (grupy czasownika) i kształt zdań. Walidator tematu
 * (`present-continuous-validation.ts`) składa z nich reguły; ten plik nie
 * importuje walidatora tematu (bez cyklu).
 */

/** Cele porównania: wybór Present Simple albo Present Continuous ze wskaźnika albo scenki. */
export const TENSE_CHOICE_OBJECTIVES: ReadonlySet<string> = new Set(["now_or_usually", "now_or_usually_more"]);

export type Tense = "simple" | "continuous";

/** Czas wymagany przez grupę wskaźników (§5.2): „teraz” → Present Continuous, „zwykle” → Present Simple. */
const TENSE_OF_MARKER_GROUP: Readonly<Record<MarkerGroup, Tense>> = { now: "continuous", usually: "simple" };

export const TENSE_NAMES: Readonly<Record<Tense, string>> = { simple: "Present Simple", continuous: "Present Continuous" };

/** Spójniki rozpoczynające kolejne zdanie składowe („Mum is cooking and Dad is reading”). */
export const CLAUSE_CONJUNCTIONS: ReadonlySet<string> = new Set(["and", "but", "while", "so", "because", "or"]);

/** Granice zdań w tekście; przecinek nie jest granicą („Look, Mum is cooking”). */
export const SENTENCE_BOUNDARY = /[.!?;:]+/;

const DO_CONTRACTED_TOKENS: Readonly<Record<string, readonly string[]>> = {
  "don't": ["do", "not"],
  "doesn't": ["does", "not"],
  dont: ["do", "not"],
  doesnt: ["does", "not"],
};

/** Tokeny tekstu po rozwinięciu skrótów be (isn't, she's) i do (doesn't, don't). */
export function tenseTokens(text: string): string[] {
  return normalizeTokens(text).flatMap((token) => BE_CONTRACTED_TOKENS[token] ?? DO_CONTRACTED_TOKENS[token] ?? [token]);
}

/**
 * Dopuszczalne formy Present Simple czasownika (§5.2): 3. osoba liczby
 * pojedynczej → forma z -s albo „doesn't X” / „does not X”; pozostałe osoby →
 * forma podstawowa albo „don't X” / „do not X”.
 */
export function presentSimpleFormFor(base: string, thirdPersonSingular: boolean, negative: boolean): readonly string[] {
  if (negative) return thirdPersonSingular ? [`doesn't ${base}`, `does not ${base}`] : [`don't ${base}`, `do not ${base}`];
  if (!thirdPersonSingular) return [base];
  return [...presentSimpleForms(base)].filter((form) => form !== base);
}

/** Czasownik znany tematowi: z tabeli form -ing, z kolokacji („have”, „look”) albo czasownik stanu. */
function isKnownVerb(base: string): boolean {
  return ingFormOf(base) !== undefined || Object.hasOwn(COLLOCATION_ING_FORMS, base) || STATE_VERBS.has(base);
}

/** Forma podstawowa czasownika, którego formą Present Simple jest token (reads → read, watches → watch, has → have). */
export function presentSimpleBaseOf(token: string): string | undefined {
  const candidates = token === "has" ? ["have"] : [token, token.slice(0, -1), token.slice(0, -2), `${token.slice(0, -3)}y`];
  return candidates.find((base) => isKnownVerb(base) && presentSimpleForms(base).has(token));
}

/** Forma podstawowa formy -ing: z tabeli albo z kolokacji („having” → have). */
export function ingBaseOf(token: string): string | undefined {
  return baseOfIngForm(token) ?? Object.keys(COLLOCATION_ING_FORMS).find((base) => COLLOCATION_ING_FORMS[base] === token);
}

/**
 * Słowa, po których forma czasownika jest rzeczownikiem albo bezokolicznikiem
 * („the cook”, „a walk”, „in the rain”, „to play”, „after work”), a nie
 * orzeczeniem zdania.
 */
const NOT_BEFORE_FINITE_VERB: ReadonlySet<string> = new Set([
  ...BE_DETERMINERS,
  "this", "that", "these", "those",
  "to", "of", "at", "in", "on", "after", "before", "from", "for", "with", "by", "about",
]);

/** Orzeczenie zdania składowego: forma be (Present Continuous) albo forma Present Simple z operatorem lub bez. */
export interface VerbGroup {
  readonly tense: Tense;
  /** Pozycja formy be, operatora do/does albo formy Present Simple. */
  readonly index: number;
  /** Pozycja czasownika głównego w Present Simple (dla be — pozycja formy be). */
  readonly verbIndex: number;
  /** Forma podstawowa czasownika w Present Simple. */
  readonly base?: string;
  readonly operator?: "do" | "does";
  /** Tokeny podmiotu (Present Simple): przed orzeczeniem albo między operatorem a czasownikiem w pytaniu. */
  readonly subject: readonly string[];
}

/** Czy pozycja otwiera pytanie z inwersją: początek zdania albo tuż po pytajniku. */
function opensQuestion(tokens: readonly string[], index: number): boolean {
  return index === 0 || (index === 1 && BE_WH_WORDS.has(tokens[0]!));
}

/** `sharedSubject`: podmiot poprzedniego orzeczenia, gdy `start` stoi tuż po spójniku za nim. */
function verbGroupAt(tokens: readonly string[], start: number, index: number, sharedSubject?: readonly string[]): VerbGroup | undefined {
  const token = tokens[index]!;
  if (BE_FORMS.has(token)) return { tense: "continuous", index, verbIndex: index, subject: tokens.slice(start, index) };
  if (token === "do" || token === "does") {
    const afterNot = tokens[index + 1] === "not" ? index + 2 : index + 1;
    // Pytanie („Does Ola play…?”): podmiot między operatorem a czasownikiem; przeczenie: czasownik tuż po „not”.
    const verbIndex = opensQuestion(tokens, index)
      ? tokens.findIndex((candidate, i) => i > afterNot && presentSimpleBaseOf(candidate) !== undefined)
      : afterNot < tokens.length && presentSimpleBaseOf(tokens[afterNot]!) !== undefined ? afterNot : -1;
    if (verbIndex >= 0) {
      const subject = opensQuestion(tokens, index) ? tokens.slice(afterNot, verbIndex) : tokens.slice(start, index);
      return { tense: "simple", index, verbIndex, base: presentSimpleBaseOf(tokens[verbIndex]!), operator: token, subject };
    }
  }
  // Forma bez operatora potrzebuje podmiotu przed sobą — „Listen, …” na początku zdania to wykrzyknienie;
  // tuż po spójniku za orzeczeniem podmiot jest wspólny („Tom is eating bread and drinks milk”). Rzeczownik
  // w tym miejscu („bread and drinks”) też się liczy: ćwiczenie odpada zamiast przepuścić dwa czasy w zdaniu.
  if (index === start ? sharedSubject === undefined : NOT_BEFORE_FINITE_VERB.has(tokens[index - 1]!)) return undefined;
  const base = presentSimpleBaseOf(token);
  const subject = index === start ? sharedSubject! : tokens.slice(start, index);
  return base === undefined ? undefined : { tense: "simple", index, verbIndex: index, base, subject };
}

/**
 * Orzeczenia jednego zdania (tokeny z `tenseTokens`), po jednym na zdanie
 * składowe: po znalezionym orzeczeniu szukanie przeskakuje do spójnika
 * otwierającego kolejne zdanie składowe, więc rzeczownik w dopełnieniu
 * („wearing a watch”) nie liczy się jako drugi czasownik.
 */
export function verbGroupsIn(tokens: readonly string[]): VerbGroup[] {
  const groups: VerbGroup[] = [];
  let start = 0;
  let index = 0;
  let sharedSubject: readonly string[] | undefined;
  while (index < tokens.length) {
    const group = verbGroupAt(tokens, start, index, sharedSubject);
    if (group === undefined) {
      index += 1;
      sharedSubject = undefined;
      continue;
    }
    groups.push(group);
    const conjunction = tokens.findIndex((token, i) => i > group.verbIndex && CLAUSE_CONJUNCTIONS.has(token));
    if (conjunction < 0) break;
    start = conjunction + 1;
    index = start;
    sharedSubject = group.subject;
  }
  return groups;
}

/** Wybór „now / usually” (§5.5): wybór z opcjami dokładnie „now” i „usually”. */
export function isNowUsuallyChoice(ex: LessonExerciseDraft): boolean {
  if (ex.exerciseType !== "lesson_choice" || ex.options?.length !== 2) return false;
  const texts = ex.options.map((option) => normalizeTokens(option.text).join(" "));
  return texts.includes("now") && texts.includes("usually");
}

/**
 * Czy bodziec z luką jest pytaniem: znak zapytania, luka na początku zdania
 * albo tuż po pytajniku („___ you play…”, „What ___ you doing”), albo
 * operator / forma be na początku („Does Ola ___ …”).
 */
export function isGapQuestion(stem: string): boolean {
  if (!stem.includes("___")) return false;
  if (stem.includes("?")) return true;
  const before = normalizeTokens(stem.split("___", 2)[0] ?? "");
  const first = tenseTokens(stem)[0];
  return before.length === 0 || (before.length === 1 && BE_WH_WORDS.has(before[0]!)) ||
    (first !== undefined && (BE_FORMS.has(first) || first === "do" || first === "does"));
}

/** Typy, w których cel 6 dopuszcza pytania (§3.1: w luce forma po podmiocie zdradza odpowiedź). */
const QUESTION_TYPES_MORE: ReadonlySet<string> = new Set(["lesson_choice", "lesson_open_answer"]);

/**
 * Kształt zdań celów porównania (§6.3): cel 2 — tylko zdania twierdzące (bez
 * pytajnika i bez „not” / „n't” w odpowiedziach); cel 6 — pytania tylko
 * w wyborze i tłumaczeniu.
 */
export function tenseChoiceShapeErrors(ex: LessonExerciseDraft, objective: string): LessonRuleIssue[] {
  const correct = ex.options?.find((option) => option.id === ex.correctOption)?.text;
  const answers = [ex.answer, ...ex.acceptedAnswers, ...(correct === undefined ? [] : [correct])];
  const texts = [ex.stem, ex.statement, ...answers, ...(ex.options ?? []).map((option) => option.text)];
  const question = texts.find((text) => text?.includes("?") === true);
  const errors: LessonRuleIssue[] = [];
  if (objective === "now_or_usually") {
    if (question !== undefined) {
      errors.push(grammarIssue("grammar.pc_now_or_usually_question", {
        pl: "w celu „Teraz czy zwykle?” są tylko zdania twierdzące — pytania należą do celu 6",
        found: `the now_or_usually exercise has the question ${clip(question)}`,
      }));
    }
    const negative = answers.find((text) => tenseTokens(text).includes("not"));
    if (negative !== undefined) {
      errors.push(grammarIssue("grammar.pc_now_or_usually_negative", {
        pl: "w celu „Teraz czy zwykle?” są tylko zdania twierdzące — przeczenia należą do celu 6",
        found: `the now_or_usually key ${clip(negative)} is negated`,
      }));
    }
  } else if (objective === "now_or_usually_more" && question !== undefined && !QUESTION_TYPES_MORE.has(ex.exerciseType)) {
    errors.push(grammarIssue("grammar.pc_tense_choice_question_type", {
      pl: "pytania w tym celu tylko w wyborze i tłumaczeniu (w luce forma po podmiocie zdradza odpowiedź)",
      found: `${ex.exerciseType} has the question ${clip(question)} in the now_or_usually_more objective`,
    }));
  }
  return errors;
}

/** Wskaźniki czasu jednego pola (`scanTimeMarkers`). */
export interface FieldMarkers {
  readonly text: string;
  readonly groups: ReadonlySet<MarkerGroup>;
  readonly strongNow: boolean;
}

/**
 * Zgłoszenie gołego „now” (standard „Środek” właściciela, 2026-11-06): w przeczeniach i celach
 * porównania goły now / teraz / właśnie / akurat nie wystarcza, bo bywa „obecnie” („Tom doesn't watch
 * TV now.”, „Mój brat teraz nie pracuje.”).
 */
export function nowMarkerBareIssue(field: string, text: string): LessonRuleIssue {
  return grammarIssue("grammar.pc_now_marker_bare", {
    field,
    pl:
      `${field}: samo „now” (teraz, właśnie, akurat) nie wystarcza w przeczeniu ani w wyborze teraz/zwykle — może znaczyć „obecnie”; ` +
      "użyj right now, at the moment, Look!, Shh! albo scenki (Cicho!, Patrz!, w tej chwili…)",
    found: `the only now marker in ${clip(text)} is a bare now, teraz, właśnie or akurat`,
  });
}

/**
 * Grupa wskaźników ćwiczenia celu porównania (§5.2). `seen` to pola, które dziecko widzi przed
 * odpowiedzią (bez klucza, wariantów i pojedynczej opcji), `all` — wszystkie skanowane pola.
 * Wskaźnik musi stać w `seen`, wszystkie wskaźniki (`seen` i `all`) należą do jednej grupy, a grupa
 * „teraz” potrzebuje mocnego wskaźnika (`nowMarkerBareIssue`). undefined (z komunikatem) przy braku
 * wskaźnika, grupach mieszanych albo samym gołym „now”.
 */
export function tenseChoiceMarkerGroup(
  seen: readonly (FieldMarkers & { readonly field: string })[],
  all: readonly FieldMarkers[],
  errors: LessonRuleIssue[],
): MarkerGroup | undefined {
  const groups = new Set(seen.flatMap((scan) => [...scan.groups]));
  if (groups.size === 0) {
    errors.push(grammarIssue("grammar.pc_tense_marker_missing", {
      pl: "ćwiczenie potrzebuje wskaźnika czasu w tym, co dziecko widzi przed odpowiedzią (Look!, every day…), albo scenki w poleceniu (Cicho!, codziennie…)",
      found: "the exercise has no time marker in what the child sees before answering (stem, statement, prompt or a scene in instructionPl)",
    }));
    return undefined;
  }
  const scans = [...seen, ...all];
  if (new Set(scans.flatMap((scan) => [...scan.groups])).size > 1) {
    errors.push(grammarIssue("grammar.pc_tense_markers_mixed", {
      pl: "wskaźniki „teraz” i „zwykle” naraz — czas odpowiedzi musi wynikać z jednej grupy",
      // Skaner zwraca same grupy, więc `found` cytuje pierwsze pole ze wskaźnikiem każdej grupy.
      found: (["now", "usually"] as const)
        .map((markerGroup) => `a ${markerGroup} marker in ${clip(scans.find((scan) => scan.groups.has(markerGroup))!.text)}`)
        .join(" and "),
    }));
    return undefined;
  }
  const group = [...groups][0]!;
  const now = seen.filter((scan) => scan.groups.has("now"));
  if (group === "now" && !now.some((scan) => scan.strongNow)) {
    errors.push(nowMarkerBareIssue(now[0]!.field, now[0]!.text));
    return undefined;
  }
  return group;
}

/** Zdania surowego tekstu razem z kończącą je interpunkcją (granice jak `SENTENCE_BOUNDARY`). */
const RAW_SENTENCE = /[^.!?;:]+[.!?;:]*/gu;

/** Spójnik między zdaniami składowymi w surowym tekście (`CLAUSE_CONJUNCTIONS`). */
const RAW_CLAUSE_CONJUNCTION = new RegExp(String.raw`\s(?:${[...CLAUSE_CONJUNCTIONS].join("|")})\s`, "iu");

/** Czy tekst nie ma orzeczenia (wykrzyknienie „Look!”, „Shh!”, podmiot „Tom” przed „and”). */
function isVerbless(text: string): boolean {
  return tenseSentences(text).every(({ groups }) => groups.length === 0);
}

/**
 * Części bodźca z luką, których wskaźnik czasu dotyczy luki (cele 2 i 6): zdanie składowe luki, inne
 * części jej zdania bez własnego orzeczenia i wcześniejsze wykrzyknienia bez orzeczenia („Look!”,
 * „Shh!”). Zdanie z własnym orzeczeniem („Tom plays football every day.”, „Mum is cooking now and …”)
 * mówi o innej czynności, więc jego wskaźnik nie rozstrzyga czasu luki.
 */
export function gapContextTexts(stem: string): string[] {
  const sentences = stem.match(RAW_SENTENCE) ?? [stem];
  const index = sentences.findIndex((sentence) => sentence.includes("___"));
  if (index < 0) return [stem];
  const exclamations = sentences.slice(0, index).filter((sentence) => sentence.trim().endsWith("!") && isVerbless(sentence));
  const clauses = sentences[index]!.split(RAW_CLAUSE_CONJUNCTION).filter((clause) => clause.includes("___") || isVerbless(clause));
  return [...exclamations, ...clauses];
}

export interface TenseSentence {
  readonly tokens: string[];
  readonly groups: VerbGroup[];
}

/** Zdania tekstu z orzeczeniami (tokeny po rozwinięciu skrótów be i do). */
export function tenseSentences(text: string): TenseSentence[] {
  return text.split(SENTENCE_BOUNDARY).map(tenseTokens).filter((tokens) => tokens.length > 0)
    .map((tokens) => ({ tokens, groups: verbGroupsIn(tokens) }));
}

/**
 * Czas każdego orzeczenia zgodny z grupą wskaźników (§5.2) — także w drugim
 * zdaniu składowym („Mum cooks dinner and Dad is reading now.”).
 */
export function validateTenseOfGroups(
  sentences: readonly TenseSentence[],
  group: MarkerGroup | undefined,
  field: string,
  errors: LessonRuleIssue[],
): void {
  if (group === undefined) return;
  const expected = TENSE_OF_MARKER_GROUP[group];
  const wrongSentence = sentences.find(({ groups }) => groups.some((verbGroup) => verbGroup.tense !== expected));
  const wrong = wrongSentence?.groups.find((verbGroup) => verbGroup.tense !== expected);
  if (wrongSentence !== undefined && wrong !== undefined) {
    errors.push(grammarIssue("grammar.pc_tense_marker_mismatch", {
      field,
      pl: `${field}: zdanie ma ${TENSE_NAMES[wrong.tense]}, a wskaźnik „${group === "now" ? "teraz" : "zwykle"}” wymaga ${TENSE_NAMES[expected]}`,
      found:
        `${field} ${clip(wrongSentence.tokens.join(" "))} has a ${TENSE_NAMES[wrong.tense]} verb, ` +
        `but the ${group} markers require ${TENSE_NAMES[expected]}`,
    }));
  }
}

/** Reguły z walidatora tematu potrzebne regułom Present Simple: osoba podmiotu przy luce i klasy pisowni celu. */
export interface PresentSimpleContext {
  /** Forma be wymagana przez podmiot przy luce („Ola ___” → is); undefined = nie da się ustalić. */
  readonly expectedBeForm: (stemWithGap: string) => string | undefined;
  readonly allowedRules: readonly IngRule[];
}

/** Czasownik w Present Simple z tabeli i klasy pisowni celu (§4 — także przy odpowiedzi PS) albo kolokacja „have/look”. */
function validatePresentSimpleVerb(base: string, context: PresentSimpleContext, field: string, errors: LessonRuleIssue[]): void {
  const rule = ingRuleOf(base);
  if (rule === undefined) {
    // Czasownik stanu poza kolokacją zgłasza reguła stanu; „has lunch”, „looks at” są dozwolone.
    if (!Object.hasOwn(COLLOCATION_ING_FORMS, base) && !STATE_VERBS.has(base)) {
      errors.push(grammarIssue("grammar.pc_verb_outside_table", {
        field,
        pl: `${field}: czasownik „${base}” jest spoza tabeli form -ing`,
        found: `the verb ${clip(base)} in ${field} is not in the verb table`,
      }));
    }
    return;
  }
  if (!context.allowedRules.includes(rule)) {
    errors.push(grammarIssue("grammar.pc_ing_rule_not_allowed", {
      field,
      pl: `${field}: czasownik „${base}” (pisownia ${rule}) nie pasuje do celu (dozwolone: ${context.allowedRules.join(", ")})`,
      found: `the verb ${clip(base)} follows the ${rule} spelling rule; the objective allows ${context.allowedRules.join(", ")}`,
    }));
  }
}

/**
 * Orzeczenie w Present Simple w całym zdaniu zgodne z osobą podmiotu (§5.2):
 * 3. osoba liczby pojedynczej → forma z -s / does, pozostałe → forma
 * podstawowa / do; po do/does forma podstawowa.
 */
export function validatePresentSimpleGroup(
  tokens: readonly string[],
  group: VerbGroup,
  context: PresentSimpleContext,
  field: string,
  errors: LessonRuleIssue[],
): void {
  const verb = tokens[group.verbIndex]!;
  const base = group.base!;
  const expected = context.expectedBeForm(`${group.subject.join(" ")} ___`);
  if (expected !== undefined) {
    const thirdPerson = expected === "is";
    const agrees = group.operator === undefined
      ? presentSimpleFormFor(base, thirdPerson, false).includes(verb)
      : group.operator === (thirdPerson ? "does" : "do");
    if (!agrees) {
      errors.push(grammarIssue("grammar.pc_simple_form_subject", {
        field,
        pl: `${field}: forma „${group.operator ?? verb}” nie pasuje do podmiotu „${group.subject.join(" ")}”`,
        found: `${field} uses ${clip(group.operator ?? verb)}, which does not agree with the subject ${clip(group.subject.join(" "))}`,
      }));
    }
  }
  if (group.operator !== undefined && verb !== base) {
    errors.push(grammarIssue("grammar.pc_simple_base_after_do", {
      field,
      pl: `${field}: po do/does stoi forma podstawowa „${base}”, nie „${verb}”`,
      found: `${field} has ${clip(verb)} after ${group.operator}, not the base form ${clip(base)}`,
    }));
  }
  validatePresentSimpleVerb(base, context, field, errors);
}

/** Forma podstawowa z odpowiedzi w Present Simple: „reads” → read, „doesn't watch” → watch. */
function presentSimpleBaseOfAnswer(tokens: readonly string[]): string | undefined {
  const operatorForm = tokens.length > 1 && (tokens[0] === "do" || tokens[0] === "does");
  return tokens.length === 1 || operatorForm ? presentSimpleBaseOf(tokens.at(-1)!) : undefined;
}

/**
 * Odpowiedź luki albo opcja wyboru formy w Present Simple (§6.2): jedna
 * z `presentSimpleFormFor` dla osoby z bodźca, przeczenie zgodne z nawiasem,
 * czasownik z nawiasu (w wyborze — z samej odpowiedzi).
 */
export function validatePresentSimpleFormAnswer(
  answer: string,
  gap: { readonly stem: string; readonly verb?: string; readonly negative?: boolean },
  context: PresentSimpleContext,
  field: string,
  errors: LessonRuleIssue[],
): void {
  const tokens = tenseTokens(answer);
  const negative = tokens.includes("not");
  if (gap.negative !== undefined && negative !== gap.negative) {
    errors.push(grammarIssue("grammar.pc_gap_negation_bracket", {
      field,
      pl: gap.negative
        ? `${field}: nawias ma „not”, więc odpowiedź musi być przeczeniem`
        : `${field}: przeczenie w odpowiedzi wymaga „not” w nawiasie (She ___ (not watch) TV every morning.)`,
      found: gap.negative
        ? `${field} ${clip(answer)} is not negated, but the brackets say not`
        : `${field} ${clip(answer)} is negated, but the brackets have no not`,
    }));
    return;
  }
  const verb = gap.verb ?? presentSimpleBaseOfAnswer(tokens);
  if (verb === undefined) {
    errors.push(grammarIssue("grammar.pc_tense_form_missing", {
      field,
      pl: `${field}: „${answer}” nie jest formą Present Simple ani Present Continuous czasownika z tabeli`,
      found: `${field} ${clip(answer)} is not a present simple or present continuous form of a table verb`,
    }));
    return;
  }
  const accepts = (thirdPerson: boolean): boolean =>
    presentSimpleFormFor(verb, thirdPerson, negative).some((form) => tenseTokens(form).join(" ") === tokens.join(" "));
  const expected = context.expectedBeForm(gap.stem);
  const agrees = expected === undefined ? accepts(true) || accepts(false) : accepts(expected === "is");
  if (agrees) {
    validatePresentSimpleVerb(verb, context, field, errors);
  } else if (expected !== undefined && accepts(expected !== "is")) {
    errors.push(grammarIssue("grammar.pc_simple_form_subject", {
      field,
      pl: `${field}: forma „${answer}” nie pasuje do podmiotu (osoba jak przy „${expected}”)`,
      found: `${field} ${clip(answer)} does not agree with the subject (the person of ${clip(expected)})`,
    }));
  } else if (tokens.some((token) => ingBaseOf(token) !== undefined)) {
    errors.push(grammarIssue("grammar.pc_ing_without_be", {
      field,
      pl: `${field}: przed formą -ing brak am/is/are („${answer}”)`,
      found: `${field} ${clip(answer)} has an -ing form without am/is/are`,
    }));
  } else {
    errors.push(grammarIssue("grammar.pc_tense_form_missing", {
      field,
      pl: `${field}: „${answer}” nie jest formą Present Simple ani Present Continuous czasownika „${verb}”`,
      found: `${field} ${clip(answer)} is not a present simple or present continuous form of ${clip(verb)}`,
    }));
  }
}
