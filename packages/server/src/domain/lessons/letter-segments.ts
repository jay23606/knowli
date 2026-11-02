import { alignCodePoints } from "../text-distance";
import type { AnswerSegment } from "./evaluate";

/** Segment poprawnej odpowiedzi: `pill` = litery, którymi różni się od zapisu dziecka. */
export interface CorrectSegment {
  readonly text: string;
  readonly state: "plain" | "pill";
}

/** Limit segmentów Kid DTO (`answerSegments`, `correctSegments`). */
const MAX_SEGMENTS = 32;

/** Interpunkcja i symbole na brzegach słowa nie są częścią porównania liter. */
const WORD_EDGES = /^([\p{P}\p{S}]*)(.*?)([\p{P}\p{S}]*)$/su;

interface WordParts {
  readonly lead: string;
  readonly core: string;
  readonly trail: string;
}

function wordParts(text: string): WordParts {
  const match = WORD_EDGES.exec(text)!;
  return { lead: match[1]!, core: match[2]!, trail: match[3]! };
}

function casefoldStable(text: string): boolean {
  return [...text.toLowerCase()].length === [...text].length;
}

function push<S extends string>(segments: { text: string; state: S }[], text: string, state: S): void {
  if (text === "") return;
  const last = segments[segments.length - 1];
  if (last !== undefined && last.state === state) last.text += text;
  else segments.push({ text, state });
}

interface LetterDiff {
  readonly distance: number;
  readonly given: { text: string; state: "plain" | "pill" }[];
  readonly expected: { text: string; state: "plain" | "pill" }[];
}

/** Litery różniące dwa słowa (Damerau–Levenshtein, bez wielkości liter); `null`, gdy słowa są za daleko. */
function letterDiff(given: string, expected: string): LetterDiff | null {
  const givenChars = [...given];
  const expectedChars = [...expected];
  // Próg jak diagnoza pisowni słówek: 1 dla krótkich słów, 2 dla dłuższych.
  const threshold = Math.min(givenChars.length, expectedChars.length) <= 4 ? 1 : 2;
  const { distance, steps } = alignCodePoints(given, expected);
  if (distance === 0 || distance > threshold) return null;
  const diff: LetterDiff = { distance, given: [], expected: [] };
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
 * Zaznaczenie liter w feedbacku lekcji (makieta 2026-11-02): każdy zaznaczony
 * fragment odpowiedzi dziecka, który jest jednym słowem bliskim słowu poprawnej
 * odpowiedzi (próg diagnozy pisowni), zawęża się do różniących się liter,
 * a w poprawnej odpowiedzi zaznaczają się litery, których brakowało albo które
 * były inne. Czysta funkcja nad tekstem serwera; nie zmienia oceny.
 *
 * Fragment, którego nie da się dopasować (kilka słów, inne słowo, różnica tylko
 * wielkości liter), zostaje zaznaczony w całości. Gdy dziecku zabrakło tylko
 * liter (żadna wpisana nie jest błędna), jego słowo też zostaje zaznaczone
 * w całości, bo w zapisie dziecka nie ma czego wskazać. Segmenty składają się
 * dokładnie na teksty wejściowe; ponad limit Kid DTO zwracany jest stan wyjściowy.
 */
export function letterSegments(
  answerSegments: readonly AnswerSegment[],
  correctText: string,
): { answer: AnswerSegment[]; correct: CorrectSegment[] | null } {
  const unchanged = { answer: [...answerSegments], correct: null };
  if (!casefoldStable(correctText)) return unchanged;

  // Słowa poprawnej odpowiedzi z odstępami; dopasowane słowo nie jest używane drugi raz.
  const tokens = correctText.split(/(\s+)/u).filter((token) => token !== "");
  const expectedByToken = new Map<number, LetterDiff["expected"]>();

  const answer: { text: string; state: AnswerSegment["state"] }[] = [];
  for (const segment of answerSegments) {
    const trimmed = segment.text.trim();
    const parts = wordParts(trimmed);
    if (segment.state !== "pill" || parts.core === "" || /\s/u.test(parts.core) || !casefoldStable(parts.core)) {
      push(answer, segment.text, segment.state);
      continue;
    }
    let best: { index: number; diff: LetterDiff; distance: number } | null = null;
    for (const [index, token] of tokens.entries()) {
      if (/^\s/u.test(token) || expectedByToken.has(index)) continue;
      const core = wordParts(token).core;
      if (core === "") continue;
      const diff = letterDiff(parts.core, core);
      if (diff === null) continue;
      if (best === null || diff.distance < best.distance) best = { index, diff, distance: diff.distance };
    }
    if (best === null) {
      push(answer, segment.text, segment.state);
      continue;
    }
    const { index, diff } = best;
    expectedByToken.set(index, diff.expected);
    const leading = segment.text.slice(0, segment.text.indexOf(trimmed));
    const trailing = segment.text.slice(leading.length + trimmed.length);
    push(answer, leading + parts.lead, "plain");
    if (diff.given.some((part) => part.state === "pill")) {
      for (const part of diff.given) push(answer, part.text, part.state);
    } else {
      push(answer, parts.core, "pill");
    }
    push(answer, parts.trail + trailing, "plain");
  }

  if (expectedByToken.size === 0 || answer.length > MAX_SEGMENTS) return unchanged;

  const correct: { text: string; state: CorrectSegment["state"] }[] = [];
  tokens.forEach((token, index) => {
    const expected = expectedByToken.get(index);
    if (expected === undefined) {
      push(correct, token, "plain");
      return;
    }
    const parts = wordParts(token);
    push(correct, parts.lead, "plain");
    for (const part of expected) push(correct, part.text, part.state);
    push(correct, parts.trail, "plain");
  });
  // Zbędna litera dziecka: w poprawnej odpowiedzi nie ma czego zaznaczyć.
  const marked = correct.some((segment) => segment.state === "pill");
  return { answer, correct: marked && correct.length <= MAX_SEGMENTS ? correct : null };
}
