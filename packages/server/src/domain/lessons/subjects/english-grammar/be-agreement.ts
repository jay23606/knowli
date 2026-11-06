import { normalizeTokens } from "../../normalize";

/**
 * Zgodność formy „to be” z podmiotem przy luce (heurystyki podmiotu i liczby)
 * wydzielona z walidatora gramatyki, żeby korzystały z niej też inne
 * walidatory bez cyklu importów.
 */

/** Formy „to be” po podmiocie (osoba → jedyna poprawna forma). */
export const BE_FORM_BY_SUBJECT: Readonly<Record<string, string>> = {
  i: "am",
  he: "is",
  she: "is",
  it: "is",
  you: "are",
  we: "are",
  they: "are",
};

/** Twierdzące skróty osoba+„to be” — nie mogą kończyć krótkiej odpowiedzi (Yes, I'm. to błąd). */
export const BE_AFFIRMATIVE_CONTRACTIONS: ReadonlySet<string> = new Set(["i'm", "you're", "we're", "they're", "he's", "she's", "it's"]);

export const BE_CONTRACTED_TOKENS: Readonly<Record<string, readonly string[]>> = {
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
export function parseBeGapAnswer(answer: string): { form: string; negative: boolean; marker?: string; pronoun?: string } | null {
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

export const BE_FORMS: ReadonlySet<string> = new Set(Object.values(BE_FORM_BY_SUBJECT));

const BE_DEMONSTRATIVE_FORM: Readonly<Record<string, string>> = {
  this: "is",
  that: "is",
  these: "are",
  those: "are",
};

const BE_IRREGULAR_PLURALS: ReadonlySet<string> = new Set(["children", "men", "women", "people", "police", "mice", "feet", "teeth"]);

/** Imiona własne kończące się na „s”, które heurystyka liczby wzięłaby za liczbę mnogą. */
const BE_S_ENDING_NAMES: ReadonlySet<string> = new Set(["james", "charles", "lucas", "miles", "lewis", "francis"]);

/** Rzeczowniki niepoliczalne na „s” łączące się z „is” (tematy zdań z zainteresowań, #197); jawna lista, bo comics/picnics/topics to liczba mnoga. */
const BE_UNCOUNTABLE_S_NOUNS: ReadonlySet<string> = new Set([
  "gymnastics", "athletics", "mathematics", "maths", "physics", "politics", "economics", "electronics",
  "robotics", "aerobics", "acrobatics",
]);

/** Czy rzeczownik przy luce wygląda na liczbę mnogą (prosta heurystyka dla materiału dziecięcego). */
export function looksPlural(token: string): boolean {
  if (BE_S_ENDING_NAMES.has(token)) return false;
  if (BE_IRREGULAR_PLURALS.has(token)) return true;
  if (BE_UNCOUNTABLE_S_NOUNS.has(token)) return false;
  return token.length > 1 && token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("us") && !token.endsWith("is") && token !== "news";
}

export const BE_DETERMINERS: ReadonlySet<string> = new Set(["the", "a", "an", "my", "his", "her", "its", "our", "your", "their"]);

export const BE_WH_WORDS: ReadonlySet<string> = new Set(["what", "where", "when", "who", "whom", "whose", "why", "how"]);

/** Tokeny przed luką, które nie są podmiotem (pytajniki, „there”, spójnik). */
const BE_NON_SUBJECT_BEFORE: ReadonlySet<string> = new Set([...BE_WH_WORDS, "there", "and", "yes", "no"]);

/** Tokeny po luce pomijane przy szukaniu podmiotu (określniki i liczebniki słowne). */
export const BE_AFTER_SKIP: ReadonlySet<string> = new Set([
  ...BE_DETERMINERS,
  "this", "that", "these", "those",
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
]);

/** Przysłówki, które mogą stać między podmiotem a luką (She always ___). */
export const BE_ADVERBS: ReadonlySet<string> = new Set([
  "always", "usually", "often", "sometimes", "never", "rarely", "seldom", "also", "just", "still", "really", "very",
]);

/** Tokeny przed luką bez przysłówków — na nich szukamy podmiotu. */
export function beSubjectTokensBefore(stem: string): string[] {
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

export interface BeNearPronoun {
  readonly pronoun: string;
  /** Czy zaimek pochodzi z części pytajnej bodźca (wtedy odpowiedź zmienia perspektywę). */
  readonly fromQuestion: boolean;
}

/** Czy zaimek odpowiedzi pasuje do podmiotu przy luce, z uwzględnieniem perspektywy pytania. */
export function beAnswerPronounAllowed(answerPronoun: string, near: BeNearPronoun): boolean {
  const allowed = near.fromQuestion ? (BE_ANSWER_PERSONS[near.pronoun] ?? [near.pronoun]) : [near.pronoun];
  return allowed.includes(answerPronoun);
}

/**
 * Zaimek osobowy bezpośrednio przy luce: ostatni token przed luką (zdanie)
 * albo pierwszy po niej (pytanie z inwersją). Tylko sąsiedztwo — zaimek
 * z innej części zdania (np. dopełnienie „for you”) nie jest podmiotem.
 */
export function bePronounNearGap(stem: string): BeNearPronoun | undefined {
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
export function expectedBeFormNearGap(stem: string): string | undefined {
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
export function beStemContext(stem: string | undefined): { negative: boolean; marker?: string } {
  if (stem === undefined) return { negative: false };
  const tokens = normalizeTokens(stem).flatMap((token) => BE_CONTRACTED_TOKENS[token] ?? [token]);
  return {
    negative: tokens.includes("not"),
    marker: tokens[0] === "yes" || tokens[0] === "no" ? tokens[0] : undefined,
  };
}

/** Biegunowość wymagana od formy „to be”: z celu tematu albo z przekształcenia. */
export type BePolarity = "affirmative" | "negative" | "any";

/** Biegunowość wymagana przez przekształcenie (pierwszeństwo przed celem). */
export const TRANSFORM_POLARITY: Readonly<Record<string, BePolarity>> = {
  to_affirmative: "affirmative",
  to_negative: "negative",
  to_question: "any",
};

/** Złamanie biegunowości formy „to be” (wspólne dla tematów „to be” i Present Continuous). */
export type BePolarityViolation = "yes_negative" | "no_affirmative" | "negated" | "not_negated";

/** Komunikat dla rodzica (po polsku) dla złamania biegunowości; wołający dopisuje przed nim pole. */
export const BE_POLARITY_PL: Readonly<Record<BePolarityViolation, string>> = {
  yes_negative: "odpowiedź po „Yes” nie może być przeczeniem",
  no_affirmative: "odpowiedź po „No” musi być przeczeniem",
  negated: "forma przecząca nie pasuje do celu twierdzącego",
  not_negated: "brak przeczenia (not) wymaganego przez cel",
};

/**
 * Złamania biegunowości formy „to be”: znacznik Yes/No niezgodny z przeczeniem
 * i biegunowość niezgodna z wymaganą (cel albo przekształcenie). Zgłoszenia
 * reguł składa wołający, bo każdy temat ma własne reguły katalogu.
 */
export function bePolarityViolations(
  polarity: BePolarity,
  effectiveNegative: boolean,
  marker: string | undefined,
): BePolarityViolation[] {
  const violations: BePolarityViolation[] = [];
  if (marker === "yes" && effectiveNegative) violations.push("yes_negative");
  if (marker === "no" && !effectiveNegative) violations.push("no_affirmative");
  if (polarity === "affirmative" && effectiveNegative) violations.push("negated");
  if (polarity === "negative" && !effectiveNegative) violations.push("not_negated");
  return violations;
}
