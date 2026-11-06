import type { AnswerNormalizer, LessonExerciseDraft } from "../../types";

/**
 * Bramka podpowiedzi pytania otwartego przedmiotów szkolnych (design etapu 1
 * §4.4, poluzowanie: spec katalogu reguł §5.1): podpowiedź ma kierować
 * rozumowaniem, a nie zawierać odpowiedź, jej wariant ani element wymagany.
 * Brak lematyzatora, więc to przybliżenie oparte na wspólnym prefiksie słów.
 */

/** Najkrótsze słowo uznawane za treściowe (chyba że zawiera cyfrę) i dopuszczające dopasowanie po prefiksie. */
const MIN_CONTENT_LENGTH = 4;
/** Najkrótszy wspólny prefiks dwóch odmian tego samego słowa. */
const MIN_COMMON_PREFIX = 3;
/** O ile liter krótsze ze słów może być dłuższe od wspólnego prefiksu (końcówka fleksyjna). */
const MAX_ENDING_LENGTH = 3;

/**
 * Słowa pomocnicze pomijane w słowach treściowych celu (spec §5.1; dokładne
 * dopasowanie znormalizowanego tokenu). Lista jest już w postaci po
 * normalizatorze przedmiotu (małe litery, NFC) — pilnuje tego test.
 */
export const HINT_STOP_WORDS: readonly string[] = [
  "jest", "są", "był", "była", "było", "były", "będzie", "przez", "które", "który", "która", "którego", "której",
  "oraz", "tego", "tych", "tym", "może", "mogą", "gdzie", "kiedy", "dlaczego", "jaki", "jaka", "jakie", "czyli",
  "także", "również", "więc", "jednak", "bardzo", "ponieważ", "dlatego", "między", "około", "nad", "pod", "przed",
  "za", "się",
];

/** Słowa pomocnicze po normalizatorze bramki (tym samym co tokeny celu); jeden zbiór na normalizator. */
const stopWordsCache = new WeakMap<AnswerNormalizer, ReadonlySet<string>>();

function stopWordsFor(normalizer: AnswerNormalizer): ReadonlySet<string> {
  let words = stopWordsCache.get(normalizer);
  if (words === undefined) {
    words = new Set(HINT_STOP_WORDS.flatMap((word) => normalizer.normalize(word).flat()));
    stopWordsCache.set(normalizer, words);
  }
  return words;
}

const hasDigit = (token: string): boolean => /\p{N}/u.test(token);

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let length = 0;
  while (length < limit && a[length] === b[length]) length += 1;
  return length;
}

/**
 * Czy dwa słowa to to samo słowo w różnych formach: równe albo oba mają co
 * najmniej 4 litery i wspólny prefiks ≥ max(3, krótsze − 3). Liczby (tokeny
 * z cyfrą) pasują tylko przy równości — „1410” i „1411” to różne daty.
 */
export function stemMatches(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left === right) return true;
  if (hasDigit(left) || hasDigit(right)) return false;
  if (left.length < MIN_CONTENT_LENGTH || right.length < MIN_CONTENT_LENGTH) return false;
  return commonPrefixLength(left, right) >= Math.max(MIN_COMMON_PREFIX, Math.min(left.length, right.length) - MAX_ENDING_LENGTH);
}

/** Tokeny po normalizatorze przedmiotu; warianty (np. rozwinięcia skrótów) zlewane w jeden zbiór. */
function tokens(text: string, normalizer: AnswerNormalizer): string[] {
  return normalizer.normalize(text).flat();
}

const isContentToken = (token: string): boolean => token.length >= MIN_CONTENT_LENGTH || hasDigit(token);

/** Próg zawarcia: 1–2 słowa — wszystkie, więcej — połowa w górę. */
const requiredMatches = (count: number): number => (count <= 2 ? count : Math.ceil(count / 2));

/** Dzisiejszy algorytm: słowa treściowe frazy; fraza bez takich słów — wszystkie jej tokeny. */
function todayContentWords(phrase: string, normalizer: AnswerNormalizer): string[] {
  // Fraza (odpowiedź) liczy się po pierwszym, kanonicznym wariancie normalizatora.
  const all = normalizer.normalize(phrase)[0] ?? [];
  const content = all.filter(isContentToken);
  return content.length > 0 ? content : all;
}

/** Dzisiejszy algorytm: fraza zawarta w podpowiedzi, gdy zgodne słowo ma co najmniej próg jej słów treściowych. */
function todayPhraseContained(phrase: string, hintTokens: readonly string[], normalizer: AnswerNormalizer): boolean {
  const words = todayContentWords(phrase, normalizer);
  if (words.length === 0) return false;
  const matched = words.filter((word) => hintTokens.some((token) => stemMatches(word, token))).length;
  return matched >= requiredMatches(words.length);
}

/** Cele bramki w kolejności: odpowiedź, warianty, teksty elementów wymaganych. */
function targetsOf(draft: LessonExerciseDraft): { target: HintRevealing["target"]; text: string }[] {
  return [
    { target: "answer", text: draft.answer },
    ...draft.acceptedAnswers.map((text) => ({ target: "acceptedAnswer" as const, text })),
    ...(draft.requiredElements ?? []).map((element) => ({ target: "requiredElement" as const, text: element.text })),
  ];
}

/**
 * Dzisiejszy algorytm bramki (przed poluzowaniem): czy podpowiedź zawiera
 * odpowiedź, wariant albo element wymagany. Zostaje jako warunek konieczny
 * `hintRevealing` (poluzowanie nie może zgłosić więcej niż on) i do testu tej własności.
 *
 * @internal Eksport wyłącznie dla testu; produkcyjnie woła się `hintRevealing`.
 */
export function hintRevealsAnswer(hint: string, draft: LessonExerciseDraft, normalizer: AnswerNormalizer): boolean {
  const hintTokens = tokens(hint, normalizer);
  if (hintTokens.length === 0) return false;
  return targetsOf(draft).some(({ text }) => todayPhraseContained(text, hintTokens, normalizer));
}

/** Zdradzony cel podpowiedzi i jego słowa treściowe obecne w podpowiedzi (do noty dla modelu). */
export interface HintRevealing {
  readonly target: "answer" | "acceptedAnswer" | "requiredElement";
  readonly text: string;
  readonly words: readonly string[];
}

/**
 * Nowy algorytm (spec §5.1) dla jednego celu: słowa treściowe (≥ 4 litery albo
 * z cyfrą) bez słów pomocniczych i bez słów pytania (`prompt`); cel bez
 * takich słów nie może zostać zdradzony. Zwraca słowa obecne w podpowiedzi,
 * gdy jest ich co najmniej próg, inaczej `null`.
 */
function revealedWords(
  phrase: string,
  hintTokens: readonly string[],
  promptTokens: readonly string[],
  normalizer: AnswerNormalizer,
): string[] | null {
  const stopWords = stopWordsFor(normalizer);
  const words = (normalizer.normalize(phrase)[0] ?? [])
    .filter(isContentToken)
    .filter((word) => !stopWords.has(word))
    .filter((word) => !promptTokens.some((token) => stemMatches(word, token)));
  if (words.length === 0) return null;
  const matched = words.filter((word) => hintTokens.some((token) => stemMatches(word, token)));
  return matched.length >= requiredMatches(words.length) ? matched : null;
}

/**
 * Pierwszy cel, który podpowiedź zdradza według OBU algorytmów — dzisiejszego
 * i nowego (zmiana jest wyłącznie poluzowaniem), albo `null`.
 */
export function hintRevealing(hint: string, draft: LessonExerciseDraft, normalizer: AnswerNormalizer): HintRevealing | null {
  const hintTokens = tokens(hint, normalizer);
  if (hintTokens.length === 0) return null;
  const promptTokens = tokens(draft.prompt ?? "", normalizer);
  for (const { target, text } of targetsOf(draft)) {
    if (!todayPhraseContained(text, hintTokens, normalizer)) continue;
    const words = revealedWords(text, hintTokens, promptTokens, normalizer);
    if (words !== null) return { target, text, words };
  }
  return null;
}
