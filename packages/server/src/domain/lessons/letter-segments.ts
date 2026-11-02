import { alignCodePoints } from "../text-distance";
import type { AnswerSegment } from "./evaluate";

/** Segment poprawnej odpowiedzi: `pill` = litery, którymi różni się od zapisu dziecka. */
export interface CorrectSegment {
  readonly text: string;
  readonly state: "plain" | "pill";
}

/** Limit segmentów Kid DTO (`answerSegments`, `correctSegments`). */
const MAX_SEGMENTS = 32;

/** Najwięcej różnic w parze słów stojących na tym samym miejscu zdania. */
const MAX_LETTER_DISTANCE = 2;

/** Interpunkcja i symbole na brzegach słowa nie są częścią porównania liter. */
const WORD_EDGES = /^([\p{P}\p{S}]*)(.*?)([\p{P}\p{S}]*)$/su;

/** Słowo tekstu: rdzeń bez interpunkcji na brzegach i jego położenie (indeksy UTF-16). */
interface Word {
  readonly core: string;
  readonly key: string;
  readonly coreStart: number;
  readonly coreEnd: number;
  readonly lead: string;
  readonly trail: string;
  readonly start: number;
  readonly end: number;
}

function wordsOf(text: string): Word[] {
  const words: Word[] = [];
  for (const match of text.matchAll(/\S+/gu)) {
    const [, lead, core, trail] = WORD_EDGES.exec(match[0])!;
    if (core === "") continue;
    const coreStart = match.index + lead!.length;
    words.push({
      core: core!, key: core!.toLowerCase(), coreStart, coreEnd: coreStart + core!.length,
      lead: lead!, trail: trail!, start: match.index, end: match.index + match[0].length,
    });
  }
  return words;
}

/**
 * Tekst nadaje się do diffu liter: małe litery nie zmieniają liczby punktów
 * kodowych (indeksy wyrównania) i zapis jest w NFC (litera z osobnym znakiem
 * diakrytycznym dałaby zaznaczenie samego akcentu).
 */
function diffable(text: string): boolean {
  return [...text.toLowerCase()].length === [...text].length && text === text.normalize("NFC");
}

/**
 * Pary słów na tym samym miejscu zdania: najdłuższy wspólny podciąg jednakowych
 * słów wyznacza kotwice, a między kolejnymi kotwicami słowa łączą się po kolei
 * tylko przy równej liczbie po obu stronach (brakujące albo dodatkowe słowo
 * nie przesuwa par). Klucz: indeks słowa dziecka → indeks słowa poprawnego.
 */
function pairWords(child: readonly Word[], correct: readonly Word[]): Map<number, number> {
  const n = child.length;
  const m = correct.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = child[i]!.key === correct[j]!.key ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const anchors: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (child[i]!.key === correct[j]!.key) anchors.push([i++, j++]);
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++;
    else j++;
  }
  const pairs = new Map<number, number>();
  let previous: [number, number] = [-1, -1];
  for (const anchor of [...anchors, [n, m] as [number, number]]) {
    const childGap = anchor[0] - previous[0] - 1;
    const correctGap = anchor[1] - previous[1] - 1;
    if (childGap > 0 && childGap === correctGap) {
      for (let k = 1; k <= childGap; k++) pairs.set(previous[0] + k, previous[1] + k);
    } else if (childGap > 0 && correctGap > 0) {
      // Różna liczba słów w luce (dopisane albo brakujące słowo): para tylko
      // z najbliższym słowem tej samej luki, każde słowo poprawne najwyżej raz.
      const used = new Set<number>();
      for (let i = previous[0] + 1; i < anchor[0]; i++) {
        let best: { j: number; distance: number } | null = null;
        for (let j = previous[1] + 1; j < anchor[1]; j++) {
          if (used.has(j)) continue;
          const distance = alignCodePoints(child[i]!.core, correct[j]!.core).distance;
          if (distance <= MAX_LETTER_DISTANCE && (best === null || distance < best.distance)) best = { j, distance };
        }
        if (best !== null) {
          used.add(best.j);
          pairs.set(i, best.j);
        }
      }
    }
    previous = anchor;
  }
  return pairs;
}

function push<S extends string>(segments: { text: string; state: S }[], text: string, state: S): void {
  if (text === "") return;
  const last = segments[segments.length - 1];
  if (last !== undefined && last.state === state) last.text += text;
  else segments.push({ text, state });
}

interface LetterDiff {
  readonly given: { text: string; state: "plain" | "pill" }[];
  readonly expected: { text: string; state: "plain" | "pill" }[];
}

/**
 * Litery różniące dwa słowa z tego samego miejsca zdania (Damerau–Levenshtein,
 * bez wielkości liter); `null`, gdy słowa są równe albo zbyt różne (inne słowo).
 */
function letterDiff(given: string, expected: string): LetterDiff | null {
  const givenChars = [...given];
  const expectedChars = [...expected];
  const { distance, steps } = alignCodePoints(given, expected);
  if (distance === 0 || distance > MAX_LETTER_DISTANCE || distance >= Math.max(givenChars.length, expectedChars.length)) return null;
  const diff: LetterDiff = { given: [], expected: [] };
  for (const step of steps) {
    switch (step.op) {
      case "match":
        push(diff.given, givenChars[step.a]!, "plain");
        push(diff.expected, expectedChars[step.b]!, "plain");
        break;
      case "substitute":
        push(diff.given, givenChars[step.a]!, "pill");
        push(diff.expected, expectedChars[step.b]!, "pill");
        break;
      case "delete":
        push(diff.given, givenChars[step.a]!, "pill");
        break;
      case "insert":
        push(diff.expected, expectedChars[step.b]!, "pill");
        break;
      case "transpose":
        push(diff.given, givenChars[step.a]! + givenChars[step.a + 1]!, "pill");
        push(diff.expected, expectedChars[step.b]! + expectedChars[step.b + 1]!, "pill");
        break;
    }
  }
  return diff;
}

/**
 * Zaznaczenie liter w feedbacku lekcji (makieta 2026-11-02): zaznaczony
 * fragment odpowiedzi dziecka, który jest dokładnie jednym słowem, porównuje
 * się ze słowem poprawnej odpowiedzi z tego samego miejsca zdania (`pairWords`).
 * Gdy różnią się najwyżej dwiema literami, fragment zawęża się do różniących się
 * liter, a w poprawnej odpowiedzi zaznaczają się litery, których brakowało albo
 * które były inne. Czysta funkcja nad tekstem serwera; nie zmienia oceny.
 *
 * Fragment bez pary albo z innym słowem w parze (kilka słów, część słowa, inne
 * słowo, sama wielkość liter) zostaje zaznaczony w całości. Gdy dziecku
 * zabrakło tylko liter, jego słowo też zostaje zaznaczone w całości, bo w zapisie
 * nie ma czego wskazać. Segmenty składają się dokładnie na teksty wejściowe;
 * gdy którakolwiek strona przekroczyłaby limit Kid DTO, wynik jest wyjściowy.
 */
export function letterSegments(
  answerSegments: readonly AnswerSegment[],
  correctText: string,
): { answer: AnswerSegment[]; correct: CorrectSegment[] | null } {
  const unchanged = { answer: [...answerSegments], correct: null };
  const answerText = answerSegments.map((segment) => segment.text).join("");
  if (!diffable(answerText) || !diffable(correctText)) return unchanged;

  const childWords = wordsOf(answerText);
  const correctWords = wordsOf(correctText);
  const pairs = pairWords(childWords, correctWords);
  const expectedByWord = new Map<number, LetterDiff["expected"]>();

  const answer: { text: string; state: AnswerSegment["state"] }[] = [];
  let offset = 0;
  for (const segment of answerSegments) {
    const start = offset;
    offset += segment.text.length;
    const childIndex = segment.state === "pill"
      ? childWords.findIndex((word) => word.start >= start && word.end <= offset && answerText.slice(start, offset).trim() === answerText.slice(word.start, word.end))
      : -1;
    const correctIndex = childIndex >= 0 ? pairs.get(childIndex) : undefined;
    const diff = correctIndex === undefined ? null : letterDiff(childWords[childIndex]!.core, correctWords[correctIndex]!.core);
    if (diff === null) {
      push(answer, segment.text, segment.state);
      continue;
    }
    const word = childWords[childIndex]!;
    expectedByWord.set(correctIndex!, diff.expected);
    push(answer, answerText.slice(start, word.coreStart), "plain");
    if (diff.given.some((part) => part.state === "pill")) {
      for (const part of diff.given) push(answer, part.text, part.state);
    } else {
      push(answer, word.core, "pill");
    }
    push(answer, answerText.slice(word.coreEnd, offset), "plain");
  }

  if (expectedByWord.size === 0) return unchanged;

  const correct: { text: string; state: CorrectSegment["state"] }[] = [];
  let cursor = 0;
  for (const [index, expected] of [...expectedByWord].sort(([a], [b]) => a - b)) {
    const word = correctWords[index]!;
    push(correct, correctText.slice(cursor, word.coreStart), "plain");
    for (const part of expected) push(correct, part.text, part.state);
    cursor = word.coreEnd;
  }
  push(correct, correctText.slice(cursor), "plain");

  // Zbędna litera dziecka: w poprawnej odpowiedzi nie ma czego zaznaczyć.
  if (!correct.some((segment) => segment.state === "pill")) {
    return answer.length > MAX_SEGMENTS ? unchanged : { answer, correct: null };
  }
  if (answer.length > MAX_SEGMENTS || correct.length > MAX_SEGMENTS) return unchanged;
  return { answer, correct };
}
