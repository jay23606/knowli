/**
 * Luka w tekście lekcji (`lesson_gap`, `lesson_listen_choice`, `lesson_cloze`):
 * ciąg 2+ podkreśleń. Jedna definicja dla walidacji serwera i ekranu dziecka (#322).
 */
const LESSON_GAP = /_{2,}/u;

/** Fragmenty tekstu między lukami: zawsze o jeden więcej niż luk (puste na brzegach). */
export function lessonGapParts(text: string): string[] {
  return text.split(new RegExp(LESSON_GAP.source, "gu"));
}

export function lessonGapCount(text: string): number {
  return lessonGapParts(text).length - 1;
}

/** Część przed i po pierwszej luce. */
export function splitLessonGap(text: string): { before: string; after: string; hasGap: boolean } {
  const match = LESSON_GAP.exec(text);
  if (match === null) return { before: text, after: "", hasGap: false };
  return { before: text.slice(0, match.index), after: text.slice(match.index + match[0].length), hasGap: true };
}
