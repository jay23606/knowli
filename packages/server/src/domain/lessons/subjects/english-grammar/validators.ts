import type { LessonExerciseDraft, LessonTopic } from "../../types";
import { normalizeTokens } from "../../normalize";
import { clip, type LessonRuleIssue } from "../../rules/catalog";
import { listenChoiceSibilantErrors } from "../english/listen-audibility";
import { englishNormalizer } from "../english/normalizer";
import { grammarIssue } from "./rules";

/**
 * Reguły walidacji specyficzne dla przedmiotu `english_grammar`
 * (design „Generowanie puli” → `subject.validateExercise`). Czysta funkcja:
 * bez bazy, sieci i zegara. Zgłoszenia reguł katalogu gramatyki (`rules.ts`):
 * `pl` to komunikat po polsku, jak w `catalog-validation.ts`, a `found` po
 * angielsku z wartościami dla modelu agenta.
 *
 * Zakres (YAGNI): dla `lesson_gap` z podpowiedzią będącą bezokolicznikiem
 * odpowiedź luki musi być dopuszczalną formą tego czasownika w Present Simple.
 * Dla innych typów brak dodatkowych reguł. NIE implementujemy ogólnej
 * morfologii angielskiej — tylko reguły Present Simple z deklaratywną tabelą
 * wyjątków.
 */

/** Deklaratywna tabela nieregularnych form 3. osoby / „be”. */
const IRREGULAR_THIRD_PERSON: Readonly<Record<string, readonly string[]>> = {
  have: ["has"],
  be: ["am", "is", "are"],
  do: ["does"],
  go: ["goes"],
};

/** Spółgłoski (do reguły y→ies: spółgłoska + y). */
const VOWELS = new Set(["a", "e", "i", "o", "u"]);

/**
 * Dopuszczalne formy czasownika w Present Simple dla danego bezokolicznika:
 * forma podstawowa, 3. osoba (+s / +es / y→ies) oraz wyjątki z tabeli.
 * Zwraca zbiór pojedynczych słów (bez operatora).
 */
function presentSimpleForms(infinitive: string): Set<string> {
  const base = infinitive.toLowerCase();
  const forms = new Set<string>([base]);

  const irregular = IRREGULAR_THIRD_PERSON[base];
  if (irregular) {
    for (const form of irregular) {
      forms.add(form);
    }
    // „be” nie ma regularnej formy +s; „have”/„do”/„go” też używają wyjątku.
    return forms;
  }

  // Regularna 3. osoba.
  const last = base.at(-1) ?? "";
  const prev = base.at(-2) ?? "";
  if (/[sxo]$/.test(base) || base.endsWith("sh") || base.endsWith("ch")) {
    forms.add(`${base}es`); // -s/-sh/-ch/-x/-o → +es
  } else if (last === "y" && !VOWELS.has(prev)) {
    forms.add(`${base.slice(0, -1)}ies`); // spółgłoska + y → +ies
  } else {
    forms.add(`${base}s`);
  }
  return forms;
}

/**
 * Czy odpowiedź luki jest dopuszczalną formą Present Simple podanego czasownika.
 * Akceptuje też formy z operatorem: `does not play`, `doesn't play`, `do not go`.
 */
function isAcceptablePresentSimpleAnswer(infinitive: string, answer: string): boolean {
  const tokens = normalizeTokens(answer);
  if (tokens.length === 0) {
    return false;
  }
  const base = infinitive.toLowerCase();
  const forms = presentSimpleForms(infinitive);

  // Forma prosta: jeden token będący dopuszczalną formą.
  if (tokens.length === 1) {
    return forms.has(tokens[0]!);
  }

  // Forma z operatorem: do/does [not] + forma podstawowa.
  // `doesn't` nie jest tu rozwinięty (normalizacja bazowa go nie rozwija),
  // więc akceptujemy warianty z apostrofem i rozdzielone.
  const operators = ["do", "does", "don't", "doesn't"];
  if (operators.includes(tokens[0]!)) {
    const rest = tokens.slice(1).filter((token) => token !== "not");
    return rest.length === 1 && rest[0] === base;
  }
  return false;
}

function equivalentText(a: string, b: string): boolean {
  const keys = new Set(englishNormalizer.normalize(a).map((tokens) => tokens.join("\u0000")));
  return englishNormalizer.normalize(b).some((tokens) => keys.has(tokens.join("\u0000")));
}

function operatorAnswer(answer: string): { operator: "do" | "does"; negative: boolean } | null {
  const tokens = normalizeTokens(answer);
  if (tokens.length === 1 && (tokens[0] === "do" || tokens[0] === "does")) {
    return { operator: tokens[0], negative: false };
  }
  if (tokens.length === 1 && (tokens[0] === "don't" || tokens[0] === "doesn't")) {
    return { operator: tokens[0] === "don't" ? "do" : "does", negative: true };
  }
  if (tokens.length === 2 && (tokens[0] === "do" || tokens[0] === "does") && tokens[1] === "not") {
    return { operator: tokens[0], negative: true };
  }
  return null;
}

function objectiveAllowsOperator(objectiveId: string, negative: boolean): boolean {
  const objective = objectiveId.split(".").at(-1);
  if (objective === "question") return !negative;
  if (objective === "negative") return negative;
  return objective === "short_answers" || objective === "base_form_after_does";
}

function operatorMatchesSubject(stem: string, operator: "do" | "does"): boolean {
  const [before = "", after = ""] = stem.split("___", 2);
  const nearby = [...normalizeTokens(before).reverse(), ...normalizeTokens(after)];
  const pronoun = nearby.find((token) => ["i", "you", "we", "they", "he", "she", "it"].includes(token));
  if (!pronoun) return true;
  return ["he", "she", "it"].includes(pronoun) ? operator === "does" : operator === "do";
}

function hasBaseVerbAfterGap(stem: string, hint?: string): boolean {
  const after = normalizeTokens(stem.split("___", 2)[1] ?? "");
  if (["i", "you", "we", "they", "he", "she", "it"].includes(after[0] ?? "")) after.shift();
  const verb = after[0];
  if (!verb) return false;
  if (hint?.toLowerCase() === "do") {
    const candidates = verb.endsWith("ies") ? [`${verb.slice(0, -3)}y`]
      : verb.endsWith("es") ? [verb.slice(0, -2)]
        : verb.endsWith("s") ? [verb.slice(0, -1)] : [];
    return !candidates.some((candidate) => candidate !== verb && presentSimpleForms(candidate).has(verb));
  }
  if (hint) return verb === hint.toLowerCase();
  const candidates = verb.endsWith("ies") ? [`${verb.slice(0, -3)}y`]
    : verb.endsWith("es") ? [verb.slice(0, -2)]
      : verb.endsWith("s") ? [verb.slice(0, -1)] : [];
  return !candidates.some((candidate) => candidate !== verb && presentSimpleForms(candidate).has(verb));
}

/** Formy „to be” po podmiocie (osoba → jedyna poprawna forma). */
const BE_FORM_BY_SUBJECT: Readonly<Record<string, string>> = {
  i: "am",
  he: "is",
  she: "is",
  it: "is",
  you: "are",
  we: "are",
  they: "are",
};

/** Twierdzące skróty osoba+„to be” — nie mogą kończyć krótkiej odpowiedzi (Yes, I'm. to błąd). */
const BE_AFFIRMATIVE_CONTRACTIONS: ReadonlySet<string> = new Set(["i'm", "you're", "we're", "they're", "he's", "she's", "it's"]);

const BE_CONTRACTED_TOKENS: Readonly<Record<string, readonly string[]>> = {
  "i'm": ["i", "am"],
  "you're": ["you", "are"],
  "we're": ["we", "are"],
  "they're": ["they", "are"],
  "he's": ["he", "is"],
  "she's": ["she", "is"],
  "it's": ["it", "is"],
  "isn't": ["is", "not"],
  "aren't": ["are", "not"],
  isnt: ["is", "not"],
  arent: ["are", "not"],
};

/** Rozkłada odpowiedź luki tematu „to be” na formę i biegunowość; null = to nie jest forma „to be”. */
function parseBeGapAnswer(answer: string): { form: string; negative: boolean; marker?: string; pronoun?: string } | null {
  let tokens = normalizeTokens(answer);
  let marker: string | undefined;
  if (tokens[0] === "yes" || tokens[0] === "no") {
    marker = tokens[0];
    tokens = tokens.slice(1);
  }
  const expanded = tokens.flatMap((token) => BE_CONTRACTED_TOKENS[token] ?? [token]);
  const pronoun = expanded[0] !== undefined && Object.hasOwn(BE_FORM_BY_SUBJECT, expanded[0])
    ? expanded[0]
    : undefined;
  const rest = pronoun === undefined ? expanded : expanded.slice(1);
  const [form, ...tail] = rest;
  if (form === undefined || !BE_FORMS.has(form)) {
    return null;
  }
  if (tail.length === 0) return { form, negative: false, marker, pronoun };
  if (tail.length === 1 && tail[0] === "not") return { form, negative: true, marker, pronoun };
  return null;
}

const BE_FORMS: ReadonlySet<string> = new Set(Object.values(BE_FORM_BY_SUBJECT));

const BE_DEMONSTRATIVE_FORM: Readonly<Record<string, string>> = {
  this: "is",
  that: "is",
  these: "are",
  those: "are",
};

const BE_IRREGULAR_PLURALS: ReadonlySet<string> = new Set(["children", "men", "women", "people", "feet", "teeth"]);

/** Imiona własne kończące się na „s”, które heurystyka liczby wzięłaby za liczbę mnogą. */
const BE_S_ENDING_NAMES: ReadonlySet<string> = new Set(["james", "charles", "lucas", "miles", "lewis", "francis"]);

/** Rzeczowniki niepoliczalne na „s” łączące się z „is” (tematy zdań z zainteresowań, #197); jawna lista, bo comics/picnics/topics to liczba mnoga. */
const BE_UNCOUNTABLE_S_NOUNS: ReadonlySet<string> = new Set([
  "gymnastics", "athletics", "mathematics", "maths", "physics", "politics", "economics", "electronics",
  "robotics", "aerobics", "acrobatics",
]);

/** Czy rzeczownik przy luce wygląda na liczbę mnogą (prosta heurystyka dla materiału dziecięcego). */
function looksPlural(token: string): boolean {
  if (BE_S_ENDING_NAMES.has(token)) return false;
  if (BE_IRREGULAR_PLURALS.has(token)) return true;
  if (BE_UNCOUNTABLE_S_NOUNS.has(token)) return false;
  return token.length > 1 && token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("us") && !token.endsWith("is") && token !== "news";
}

const BE_DETERMINERS: ReadonlySet<string> = new Set(["the", "a", "an", "my", "his", "her", "its", "our", "your", "their"]);

const BE_WH_WORDS: ReadonlySet<string> = new Set(["what", "where", "when", "who", "whom", "whose", "why", "how"]);

/** Tokeny przed luką, które nie są podmiotem (pytajniki, „there”, spójnik). */
const BE_NON_SUBJECT_BEFORE: ReadonlySet<string> = new Set([...BE_WH_WORDS, "there", "and", "yes", "no"]);

/** Tokeny po luce pomijane przy szukaniu podmiotu (określniki i liczebniki słowne). */
const BE_AFTER_SKIP: ReadonlySet<string> = new Set([
  ...BE_DETERMINERS,
  "this", "that", "these", "those",
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
]);

/**
 * Zaimek osobowy bezpośrednio przy luce: ostatni token przed luką (zdanie)
 * albo pierwszy po niej (pytanie z inwersją). Tylko sąsiedztwo — zaimek
 * z innej części zdania (np. dopełnienie „for you”) nie jest podmiotem.
 */
/** Przysłówki, które mogą stać między podmiotem a luką (She always ___). */
const BE_ADVERBS: ReadonlySet<string> = new Set([
  "always", "usually", "often", "sometimes", "never", "rarely", "seldom", "also", "just", "still", "really", "very",
]);

/** Tokeny przed luką bez przysłówków — na nich szukamy podmiotu. */
function beSubjectTokensBefore(stem: string): string[] {
  const [before = ""] = stem.split("___", 2);
  return normalizeTokens(before).filter((token) => !BE_ADVERBS.has(token));
}

/** Dozwolone osoby odpowiedzi dla zaimka z części pytajnej bodźca (zmiana perspektywy). */
const BE_ANSWER_PERSONS: Readonly<Record<string, readonly string[]>> = {
  i: ["you"],
  you: ["i", "we"],
  we: ["we", "you"],
  he: ["he"],
  she: ["she"],
  it: ["it"],
  they: ["they"],
};

interface BeNearPronoun {
  readonly pronoun: string;
  /** Czy zaimek pochodzi z części pytajnej bodźca (wtedy odpowiedź zmienia perspektywę). */
  readonly fromQuestion: boolean;
}

/** Czy zaimek odpowiedzi pasuje do podmiotu przy luce, z uwzględnieniem perspektywy pytania. */
function beAnswerPronounAllowed(answerPronoun: string, near: BeNearPronoun): boolean {
  const allowed = near.fromQuestion ? (BE_ANSWER_PERSONS[near.pronoun] ?? [near.pronoun]) : [near.pronoun];
  return allowed.includes(answerPronoun);
}

function bePronounNearGap(stem: string): BeNearPronoun | undefined {
  const [, after = ""] = stem.split("___", 2);
  const beforeTokens = beSubjectTokensBefore(stem);
  const prev = beforeTokens.at(-1);
  if (prev !== undefined && Object.hasOwn(BE_FORM_BY_SUBJECT, prev)) return { pronoun: prev, fromQuestion: false };
  const next = normalizeTokens(after)[0];
  if (next !== undefined && Object.hasOwn(BE_FORM_BY_SUBJECT, next)) return { pronoun: next, fromQuestion: false };
  // Bodziec krótkiej odpowiedzi niesie podmiot w części pytajnej sprzed luki
  // („Is he ready? Yes, ___.”): zaimek przy formie „to be”, najbliżej luki.
  for (let i = beforeTokens.length - 2; i >= 0; i--) {
    const token = beforeTokens[i]!;
    const following = beforeTokens[i + 1]!;
    if (BE_FORMS.has(token) && Object.hasOwn(BE_FORM_BY_SUBJECT, following)) return { pronoun: following, fromQuestion: true };
    if (Object.hasOwn(BE_FORM_BY_SUBJECT, token) && BE_FORMS.has(following)) return { pronoun: token, fromQuestion: true };
  }
  return undefined;
}

/**
 * Forma „to be” wymagana przez podmiot sąsiadujący z luką; undefined = nie
 * da się ustalić (np. po luce jest sam orzecznik „happy”). Kolejność reguł:
 * podmiot złożony z „and” tuż przed luką → are; zaimek/wskazujący przy luce;
 * rzeczownik przed luką w kontekście podmiotu (po określniku albo na
 * początku zdania, nie po pytajniku); rzeczownik po luce, gdy poprzedza go
 * określnik/liczebnik albo sam jest liczbą mnogą. Liczbę rzeczownika daje
 * prosta heurystyka (dog → is, dogs → are). Własności prototypu JS (np.
 * „constructor”) nie są podmiotami — stąd Object.hasOwn zamiast `in`.
 */
function expectedBeFormNearGap(stem: string): string | undefined {
  const [, after = ""] = stem.split("___", 2);
  const beforeTokens = beSubjectTokensBefore(stem);
  const afterTokens = normalizeTokens(after);
  const prev = beforeTokens.at(-1);
  const prev2 = beforeTokens.at(-2);
  const next = afterTokens[0];
  if (prev !== undefined && prev !== "and" && prev2 === "and") return "are";
  if (prev !== undefined && Object.hasOwn(BE_FORM_BY_SUBJECT, prev)) return BE_FORM_BY_SUBJECT[prev];
  if (prev !== undefined && Object.hasOwn(BE_DEMONSTRATIVE_FORM, prev)) return BE_DEMONSTRATIVE_FORM[prev];
  if (next !== undefined && Object.hasOwn(BE_FORM_BY_SUBJECT, next)) return BE_FORM_BY_SUBJECT[next];
  if (next !== undefined && Object.hasOwn(BE_DEMONSTRATIVE_FORM, next)) return BE_DEMONSTRATIVE_FORM[next];
  if (prev !== undefined && !BE_DETERMINERS.has(prev) && !BE_NON_SUBJECT_BEFORE.has(prev)) {
    const inSubjectContext = beforeTokens.length === 1 || (prev2 !== undefined && !BE_WH_WORDS.has(prev2));
    if (inSubjectContext) return looksPlural(prev) ? "are" : "is";
  }
  const afterSubjectIndex = afterTokens.findIndex((token) => !BE_AFTER_SKIP.has(token) && !/^\d+$/.test(token));
  if (afterSubjectIndex >= 0) {
    const nounAfter = afterTokens[afterSubjectIndex]!;
    if (afterSubjectIndex > 0 || looksPlural(nounAfter)) {
      return looksPlural(nounAfter) ? "are" : "is";
    }
  }
  return undefined;
}

/** Czy zdanie-otoczenie luki samo niesie przeczenie albo znacznik Yes/No. */
function beStemContext(stem: string | undefined): { negative: boolean; marker?: string } {
  if (stem === undefined) return { negative: false };
  const tokens = normalizeTokens(stem).flatMap((token) => BE_CONTRACTED_TOKENS[token] ?? [token]);
  return {
    negative: tokens.includes("not"),
    marker: tokens[0] === "yes" || tokens[0] === "no" ? tokens[0] : undefined,
  };
}

/** Ścieżka pola zgłoszenia: etykieta „lesson_gap” w komunikatach oznacza odpowiedź luki. */
function pathOf(label: string): string {
  return label === "lesson_gap" ? "answer" : label;
}

function checkBePolarity(
  objective: string,
  effectiveNegative: boolean,
  marker: string | undefined,
  field: string,
  answer: string,
  issues: LessonRuleIssue[],
): void {
  const path = pathOf(field);
  if (marker === "yes" && effectiveNegative) {
    issues.push(grammarIssue("grammar.be_yes_negative", {
      field: path,
      pl: `${field}: odpowiedź po „Yes” nie może być przeczeniem`,
      found: `${path} ${clip(answer)} is negated although the reply starts with "Yes"`,
    }));
  }
  if (marker === "no" && !effectiveNegative) {
    issues.push(grammarIssue("grammar.be_no_affirmative", {
      field: path,
      pl: `${field}: odpowiedź po „No” musi być przeczeniem`,
      found: `${path} ${clip(answer)} is not negated although the reply starts with "No"`,
    }));
  }
  if ((objective === "affirmative_forms" || objective === "contractions") && effectiveNegative) {
    issues.push(grammarIssue("grammar.be_negative_in_affirmative_objective", {
      field: path,
      pl: `${field}: forma przecząca nie pasuje do celu twierdzącego`,
      found: `${path} ${clip(answer)} is negated, but the objective ${clip(objective)} is affirmative`,
    }));
  }
  if (objective === "negative_forms" && !effectiveNegative) {
    issues.push(grammarIssue("grammar.be_missing_negation", {
      field: path,
      pl: `${field}: brak przeczenia (not) wymaganego przez cel`,
      found: `${path} ${clip(answer)} has no negation, but the objective ${clip(objective)} requires "not"`,
    }));
  }
}

/** Zgłoszenie: skrócona krótka odpowiedź twierdząca (wspólne dla luki i odpowiedzi tekstowej). */
function shortAnswerContractionIssue(field: string, rawLast: string, answer: string): LessonRuleIssue {
  return grammarIssue("grammar.be_short_answer_contraction", {
    field: pathOf(field),
    pl: `${field}: krótka odpowiedź twierdząca nie może kończyć się skrótem „${rawLast}” — zapisz pełną formę (Yes, I am)`,
    found: `the affirmative short answer ${clip(answer)} ends with the contraction ${clip(rawLast)}`,
  });
}

/** Zgłoszenie: forma „to be” niezgodna z osobą skrótu (wspólne dla luki i odpowiedzi tekstowej). */
function contractionPersonIssue(field: string, form: string, pronoun: string, answer: string): LessonRuleIssue {
  return grammarIssue("grammar.be_contraction_person", {
    field: pathOf(field),
    pl: `${field}: forma „${form}” nie pasuje do osoby „${pronoun}” ze skrótu`,
    found: `${clip(answer)} pairs the form ${clip(form)} with the pronoun ${clip(pronoun)}`,
  });
}

/** Zgłoszenie: osoba odpowiedzi niezgodna z podmiotem przy luce. */
function answerPersonIssue(field: string, pronoun: string, subject: string, answer: string): LessonRuleIssue {
  return grammarIssue("grammar.be_answer_person", {
    field: pathOf(field),
    pl: `${field}: osoba „${pronoun}” w odpowiedzi nie pasuje do podmiotu „${subject}”`,
    found: `${clip(answer)} uses the person ${clip(pronoun)}, but the subject next to the gap is ${clip(subject)}`,
  });
}

/** Zgłoszenie: forma „to be” niezgodna z podmiotem przy luce. */
function answerFormIssue(field: string, form: string, expected: string, answer: string): LessonRuleIssue {
  return grammarIssue("grammar.be_form_subject", {
    field: pathOf(field),
    pl: `${field}: forma „${form}” nie pasuje do podmiotu (poprawnie: ${expected})`,
    found: `${clip(answer)} uses ${clip(form)}, but the subject requires ${clip(expected)}`,
  });
}

/** Zgłoszenie: forma „to be” niezgodna z osobą w pełnym zdaniu (obie kolejności podmiotu i formy). */
function sentencePersonFormIssue(field: string, form: string, person: string, expected: string, answer: string): LessonRuleIssue {
  return grammarIssue("grammar.be_sentence_person_form", {
    field: pathOf(field),
    pl: `${field}: forma „${form}” nie pasuje do osoby „${person}” (poprawnie: ${expected})`,
    found: `in ${clip(answer)} the form ${clip(form)} does not agree with ${clip(person)} (expected ${clip(expected)})`,
  });
}

/**
 * Reguła luki tematu „to be”: odpowiedź (i każdy wariant) musi być formą
 * am/is/are zgodną z podmiotem przy luce i biegunowością celu. Samo „not”
 * jest poprawne tylko dla celu przeczeń (forma stoi już w zdaniu).
 */
function validateBeGapAnswer(ex: LessonExerciseDraft, answer: string, field: string, issues: LessonRuleIssue[]): void {
  const path = pathOf(field);
  const objective = ex.objectiveId.split(".").at(-1) ?? "";
  const stemCtx = beStemContext(ex.stem);
  if (normalizeTokens(answer).join(" ") === "not") {
    if (objective !== "negative_forms") {
      issues.push(grammarIssue("grammar.be_bare_not", {
        field: path,
        pl: `${field}: odpowiedź „${answer}” nie jest formą czasownika „be” w temacie „to be”`,
        found: `${path} ${clip(answer)} is only "not", allowed in the objective "negative_forms" but not in ${clip(objective)}`,
      }));
    }
    return;
  }
  const lastBeforeGap = ex.stem === undefined
    ? undefined
    : normalizeTokens(ex.stem.split("___", 2)[0] ?? "").at(-1);
  if (lastBeforeGap !== undefined && BE_ADVERBS.has(lastBeforeGap)) {
    issues.push(grammarIssue("grammar.be_adverb_before_gap", {
      field: "stem",
      pl: `${field}: przysłówek „${lastBeforeGap}” stoi po am/is/are (She is always happy), nie przed luką`,
      found: `the adverb ${clip(lastBeforeGap)} stands directly before the gap in ${clip(ex.stem ?? "")}`,
    }));
  }
  const parsed = parseBeGapAnswer(answer);
  if (parsed === null) {
    issues.push(grammarIssue("grammar.be_answer_not_be_form", {
      field: path,
      pl: `${field}: odpowiedź „${answer}” nie jest formą czasownika „be” (am, is, are)`,
      found: `${path} ${clip(answer)} is not a form of "be"`,
    }));
    return;
  }
  if (parsed.pronoun !== undefined && BE_FORM_BY_SUBJECT[parsed.pronoun] !== parsed.form) {
    issues.push(contractionPersonIssue(field, parsed.form, parsed.pronoun, answer));
  }
  if (objective === "short_answers" && !parsed.negative) {
    const rawLast = normalizeTokens(answer).at(-1);
    if (rawLast !== undefined && BE_AFFIRMATIVE_CONTRACTIONS.has(rawLast)) {
      issues.push(shortAnswerContractionIssue(field, rawLast, answer));
    }
  }
  const stemPronoun = ex.stem === undefined ? undefined : bePronounNearGap(ex.stem);
  if (parsed.pronoun !== undefined && stemPronoun !== undefined && !beAnswerPronounAllowed(parsed.pronoun, stemPronoun)) {
    issues.push(answerPersonIssue(field, parsed.pronoun, stemPronoun.pronoun, answer));
  }
  const expected = ex.stem === undefined ? undefined : expectedBeFormNearGap(ex.stem);
  if (expected !== undefined && expected !== parsed.form) {
    issues.push(answerFormIssue(field, parsed.form, expected, answer));
  }
  checkBePolarity(objective, parsed.negative || stemCtx.negative, parsed.marker ?? stemCtx.marker, field, answer, issues);
}

/**
 * Reguła odpowiedzi tekstowych tematu „to be” poza luką: zgodność osoby z
 * formą w pełnym zdaniu (z podmiotami złożonymi), brak do/does oraz
 * biegunowość celu — przy przekształceniu biegunowość celu wyznacza
 * przekształcenie (to_negative/to_affirmative), nie reguła ćwiczenia.
 * Forma będąca odpowiedzią na bodziec z luką (wybór odpowiedzi) jest
 * sprawdzana względem podmiotu w bodźcu.
 */
function validateBeAnswerText(ex: LessonExerciseDraft, answer: string, field: string, issues: LessonRuleIssue[]): void {
  const path = pathOf(field);
  const objective = ex.objectiveId.split(".").at(-1) ?? "";
  const tokens = normalizeTokens(answer).flatMap((token) => BE_CONTRACTED_TOKENS[token] ?? [token]);
  if (tokens.includes("do") || tokens.includes("does")) {
    issues.push(grammarIssue("grammar.be_no_do_does", {
      field: path,
      pl: `${field}: zdanie z „to be” nie używa „do/does”`,
      found: `${path} ${clip(answer)} uses do/does in a "to be" sentence`,
    }));
    return;
  }
  if (objective === "short_answers") {
    // Twierdząca krótka odpowiedź nie może kończyć się samym skrótem (Yes, I'm. jest błędem);
    // przeczenie No, I'm not. jest poprawne, bo po skrócie stoi „not”.
    const rawLast = normalizeTokens(answer).at(-1);
    if (rawLast !== undefined && BE_AFFIRMATIVE_CONTRACTIONS.has(rawLast)) {
      issues.push(shortAnswerContractionIssue(field, rawLast, answer));
      return;
    }
    // Na pytanie o „you” odpowiada się o sobie („I”), nie z perspektywy pytającego.
    const questionTokens = normalizeTokens(ex.prompt ?? ex.stem ?? "");
    const asksAboutYou = BE_FORMS.has(questionTokens[0] ?? "") && questionTokens[1] === "you";
    if (asksAboutYou && tokens.includes("you")) {
      issues.push(grammarIssue("grammar.be_short_answer_you", {
        field: path,
        pl: `${field}: po pytaniu o „you” odpowiedź musi używać osoby „I” (Yes, I am)`,
        found: `${path} ${clip(answer)} answers a question about "you" with "you" instead of "I"`,
      }));
      return;
    }
  }
  const gapContext = ex.stem ?? ex.prompt ?? ex.statement;
  if (gapContext !== undefined && gapContext.includes("___")) {
    // Odpowiedź na bodziec z luką (wybór, krótka odpowiedź) może być wielotokenowa
    // (isn't, am not) — sprawdzamy ją tym samym parserem co odpowiedź luki.
    const parsed = parseBeGapAnswer(answer);
    if (parsed !== null) {
      if (parsed.pronoun !== undefined && BE_FORM_BY_SUBJECT[parsed.pronoun] !== parsed.form) {
        issues.push(contractionPersonIssue(field, parsed.form, parsed.pronoun, answer));
      }
      const stemPronoun = bePronounNearGap(gapContext);
      if (parsed.pronoun !== undefined && stemPronoun !== undefined && !beAnswerPronounAllowed(parsed.pronoun, stemPronoun)) {
        issues.push(answerPersonIssue(field, parsed.pronoun, stemPronoun.pronoun, answer));
      }
      const expected = expectedBeFormNearGap(gapContext);
      if (expected !== undefined && expected !== parsed.form) {
        issues.push(answerFormIssue(field, parsed.form, expected, answer));
      }
      const stemCtx = beStemContext(gapContext);
      checkBePolarity(objective, parsed.negative || stemCtx.negative, parsed.marker ?? stemCtx.marker, field, answer, issues);
      return;
    }
  }
  const firstBeIndex = tokens.findIndex((token) => BE_FORMS.has(token));
  let hasBe = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const next = tokens[i + 1];
    if (next === undefined) continue;
    if (Object.hasOwn(BE_FORM_BY_SUBJECT, token) && BE_FORMS.has(next)) {
      hasBe = true;
      // Podmiot złożony przed pierwszym orzeczeniem: „Tom and I are” — forma to are.
      const compoundSubject = tokens[i - 1] === "and" && firstBeIndex === i + 1;
      const expected = compoundSubject ? "are" : BE_FORM_BY_SUBJECT[token]!;
      if (expected !== next) {
        issues.push(sentencePersonFormIssue(field, next, token, expected, answer));
      }
    }
    if (BE_FORMS.has(token) && Object.hasOwn(BE_FORM_BY_SUBJECT, next)) {
      hasBe = true;
      // Podmiot złożony po inwersji: „Are he and Tom” — forma też musi być are.
      const compoundSubject = tokens[i + 2] === "and";
      const expected = compoundSubject ? "are" : BE_FORM_BY_SUBJECT[next]!;
      if (expected !== token) {
        issues.push(sentencePersonFormIssue(field, token, next, expected, answer));
      }
    }
  }
  if (!hasBe) return;
  const marker = tokens[0] === "yes" || tokens[0] === "no" ? tokens[0] : undefined;
  const polarityObjective = ex.transformId === "to_affirmative"
    ? "affirmative_forms"
    : ex.transformId === "to_negative"
      ? "negative_forms"
      : ex.transformId === "to_question"
        ? ""
        : objective;
  checkBePolarity(polarityObjective, tokens.includes("not"), marker, field, answer, issues);
}

/** Zaimek wymagany przez piktogram bodźca obrazkowego (kto jest na obrazku). */
const VISUAL_SUBJECT_PRONOUN: Readonly<Record<string, string>> = {
  boy: "he",
  girl: "she",
  man: "he",
  woman: "she",
  group: "they",
  dog: "it",
};

/**
 * Ćwiczenie z piktogramem: odpowiedź musi zaczynać się zaimkiem osoby z
 * obrazka, a forma „to be” w bodźcu musi zgadzać się z tą osobą.
 */
function validateVisualPronoun(ex: LessonExerciseDraft, issues: LessonRuleIssue[]): void {
  if (ex.visualSubject === undefined || !Object.hasOwn(VISUAL_SUBJECT_PRONOUN, ex.visualSubject)) return;
  const pronoun = VISUAL_SUBJECT_PRONOUN[ex.visualSubject]!;
  const picture = `the picture (${ex.visualSubject}) requires ${clip(pronoun)}`;
  const answerPronoun = normalizeTokens(ex.answer)[0];
  if (answerPronoun !== undefined && Object.hasOwn(BE_FORM_BY_SUBJECT, answerPronoun) && answerPronoun !== pronoun) {
    issues.push(grammarIssue("grammar.visual_answer_pronoun", {
      pl: `visualSubject: odpowiedź zaczyna się od „${answerPronoun}”, a obrazek wymaga „${pronoun}”`,
      found: `the answer starts with ${clip(answerPronoun)}, ${picture}`,
    }));
  }
  // Opcja oznaczona jako poprawna musi nieść ten sam zaimek co odpowiedź kanoniczna.
  const correctText = ex.options?.find((option) => option.id === ex.correctOption)?.text;
  const correctPronoun = correctText === undefined ? undefined : normalizeTokens(correctText)[0];
  if (correctPronoun !== undefined && Object.hasOwn(BE_FORM_BY_SUBJECT, correctPronoun) && correctPronoun !== pronoun) {
    issues.push(grammarIssue("grammar.visual_option_pronoun", {
      pl: `visualSubject: opcja poprawna zaczyna się od „${correctPronoun}”, a obrazek wymaga „${pronoun}”`,
      found: `the correct option starts with ${clip(correctPronoun)}, ${picture}`,
    }));
  }
  const stemTokens = normalizeTokens(ex.stem ?? "");
  stemTokens.forEach((token, index) => {
    // Podmiotem jest zaimek sąsiadujący z formą „to be” (przed nią albo po niej
    // w pytaniu z inwersją) — zaimki w dopełnieniu („see you”) nie liczą się.
    const next = stemTokens[index + 1];
    const prev = stemTokens[index - 1];
    const isSubject = (next !== undefined && BE_FORMS.has(next)) || (prev !== undefined && BE_FORMS.has(prev));
    if (Object.hasOwn(BE_FORM_BY_SUBJECT, token) && token !== pronoun && isSubject) {
      issues.push(grammarIssue("grammar.visual_stem_pronoun", {
        pl: `visualSubject: zaimek „${token}” w bodźcu nie pasuje do obrazka (poprawnie: ${pronoun})`,
        found: `the stem uses the subject pronoun ${clip(token)}, ${picture}`,
      }));
    }
  });
  // Zaimek tuż przed luką (tylko gdy luka istnieje; marker ___ znika w tokenizacji).
  const stemRaw = ex.stem ?? "";
  const gapIndex = stemRaw.indexOf("___");
  const beforeGapLast = gapIndex < 0 ? undefined : normalizeTokens(stemRaw.slice(0, gapIndex)).at(-1);
  if (beforeGapLast !== undefined && Object.hasOwn(BE_FORM_BY_SUBJECT, beforeGapLast) && beforeGapLast !== pronoun) {
    issues.push(grammarIssue("grammar.visual_stem_pronoun", {
      pl: `visualSubject: zaimek „${beforeGapLast}” w bodźcu nie pasuje do obrazka (poprawnie: ${pronoun})`,
      found: `the stem has ${clip(beforeGapLast)} right before the gap, ${picture}`,
    }));
  }
  const expectedForm = BE_FORM_BY_SUBJECT[pronoun]!;
  for (const form of normalizeTokens(ex.stem ?? "").filter((token) => BE_FORMS.has(token))) {
    if (form !== expectedForm) {
      issues.push(grammarIssue("grammar.visual_stem_be_form", {
        pl: `visualSubject: forma „${form}” w bodźcu nie pasuje do osoby z obrazka (poprawnie: ${expectedForm})`,
        found: `the stem uses the form ${clip(form)}, but the person in the picture (${ex.visualSubject}) requires ${clip(expectedForm)}`,
      }));
    }
  }
}

/**
 * Walidator ćwiczeń przedmiotu. Zwraca zgłoszenia reguł katalogu gramatyki (pusta lista = poprawne).
 */
export function validateEnglishGrammarExercise(
  ex: LessonExerciseDraft,
  topic: LessonTopic,
): LessonRuleIssue[] {
  const issues: LessonRuleIssue[] = [];

  validateVisualPronoun(ex, issues);
  issues.push(...listenChoiceSibilantErrors(ex));

  if (ex.exerciseType === "lesson_open_answer" && ex.prompt !== undefined) {
    const equalAnswer = [ex.answer, ...ex.acceptedAnswers].find((answer) => equivalentText(ex.prompt!, answer));
    if (equalAnswer !== undefined) {
      issues.push(grammarIssue("grammar.translation_prompt_equals_answer", {
        pl: "prompt: bodziec tłumaczenia nie może być równy odpowiedzi ani jej wariantowi",
        found: `prompt ${clip(ex.prompt)} equals the answer ${clip(equalAnswer)}`,
      }));
    }
  }

  if (topic.id === "to_be" && ex.exerciseType === "lesson_gap") {
    const beHint = ex.hint?.trim().toLowerCase() ?? "";
    if (beHint !== "" && beHint !== "be") {
      issues.push(grammarIssue("grammar.be_gap_hint", {
        pl: "lesson_gap: hint dla tematu „to be” musi mieć wartość „be” albo być pusty",
        found: `hint ${clip(ex.hint ?? "")} on a "to be" gap`,
      }));
    }
    validateBeGapAnswer(ex, ex.answer, "lesson_gap", issues);
    for (const variant of ex.acceptedAnswers) validateBeGapAnswer(ex, variant, "acceptedAnswers", issues);
  } else if (topic.id === "to_be" && ex.exerciseType !== "lesson_card" && ex.exerciseType !== "lesson_notice") {
    validateBeAnswerText(ex, ex.answer, "answer", issues);
    for (const variant of ex.acceptedAnswers) validateBeAnswerText(ex, variant, "acceptedAnswers", issues);
  } else if (ex.exerciseType === "lesson_gap") {
    const hint = ex.hint?.trim() ?? "";
    const infinitive = hint ? normalizeTokens(hint)[0] : undefined;
    const operator = operatorAnswer(ex.answer);
    const objective = ex.objectiveId.split(".").at(-1);
    const hasAuxiliaryRules = objective === "question" || objective === "negative" || objective === "short_answers" || objective === "base_form_after_does";
    const operatorOnlyIsValid = operator !== null && ex.stem !== undefined &&
      objectiveAllowsOperator(ex.objectiveId, operator.negative) &&
      operatorMatchesSubject(ex.stem, operator.operator) &&
      (objective === "short_answers" || hasBaseVerbAfterGap(ex.stem, infinitive));
    if (operator !== null && hasAuxiliaryRules && !operatorOnlyIsValid) {
      issues.push(grammarIssue("grammar.gap_operator_mismatch", {
        pl: "lesson_gap: operator nie pasuje do celu, podmiotu lub formy czasownika",
        found: `the operator ${clip(ex.answer)} does not fit the objective ${clip(objective ?? "")}, the subject or the verb form in ${clip(ex.stem ?? "")}`,
      }));
    } else if (infinitive !== undefined && !operatorOnlyIsValid && !isAcceptablePresentSimpleAnswer(infinitive, ex.answer)) {
      issues.push(grammarIssue("grammar.gap_present_simple_form", {
        pl: `lesson_gap: odpowiedź „${ex.answer}” nie jest formą czasownika „${infinitive}” w Present Simple`,
        found: `answer ${clip(ex.answer)} is not a Present Simple form of the verb ${clip(infinitive)}`,
      }));
    }
  }

  return issues;
}
