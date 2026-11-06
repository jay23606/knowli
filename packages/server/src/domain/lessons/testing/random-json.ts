/**
 * Deterministyczny generator dowolnego JSON do testów własności „nigdy nie
 * rzuca” (bez zależności: ziarno → ten sam wynik). Z `base` zwraca zwykle kopię
 * rekordu z kilkoma polami podmienionymi na losowy JSON (także znane nazwy pól,
 * więc trafia w zagnieżdżone ścieżki walidatorów), czasem zupełnie losową wartość.
 */

/** Generator mulberry32: liczby z [0, 1). */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = [
  "exerciseType", "objectiveId", "answer", "options", "items", "pairs", "groups", "groupItems", "calculation",
  "kind", "unit", "params", "tolerance", "templateFamilyId", "sourceRefs", "quote", "id", "text", "left", "right",
  "label", "groupId", "keywordOptions", "keyOptionIds", "gapAnswers", "extraWords", "clozeText", "noticeSegments",
  "scaleDenominator", "mapDistanceCm", "upperHeightM", "lowerHeightM", "value", "fromUnit",
];
const STRINGS = [
  "", "x", "lesson_calculation", "lesson_match", "lesson_group", "lesson_cloze", "lesson_keywords",
  "scale_distance", "height_difference", "unit_conversion", "m", "km", "cm", "map-scale", "___",
];
const NUMBERS = [0, -1, 1, 0.5, 3, 1e21, -1e-7, 25000, 1000000, 1000000000, 0.001, Number.MAX_SAFE_INTEGER];

function value(next: () => number, depth: number): unknown {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const roll = next();
  if (depth >= 4 || roll < 0.15) return pick([null, true, false]);
  if (roll < 0.35) return pick(STRINGS);
  if (roll < 0.5) return pick(NUMBERS);
  if (roll < 0.75) return Array.from({ length: Math.floor(next() * 4) }, () => value(next, depth + 1));
  const out: Record<string, unknown> = {};
  for (let index = Math.floor(next() * 5); index > 0; index -= 1) out[pick(KEYS)] = value(next, depth + 1);
  return out;
}

export function randomJson(seed: number, options: { readonly base?: Record<string, unknown> } = {}): unknown {
  const next = prng(seed);
  if (options.base === undefined || next() < 0.2) return value(next, 0);
  const out: Record<string, unknown> = { ...options.base };
  for (let index = 1 + Math.floor(next() * 3); index > 0; index -= 1) {
    out[KEYS[Math.floor(next() * KEYS.length)]!] = value(next, 1);
  }
  return out;
}
