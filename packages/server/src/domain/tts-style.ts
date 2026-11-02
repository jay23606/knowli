import type { LessonVoiceTone } from "@learning/contracts";

/** Rola komunikatu lub nagrania lekcji, od której zależy styl wypowiedzi TTS (spec tonu TTS §2.1). */
export type TtsRoleStyle =
  | "ui_praise" | "ui_gentle" | "ui_guidance" | "ui_closing"
  | "lesson_question" | "lesson_card" | "lesson_explanation";

/** Semantyczny styl wypowiedzi: rola albo ton lekcji; zdanie dla modelu dobiera profil przy adapterze. */
export type TtsStyle = TtsRoleStyle | LessonVoiceTone;

/**
 * Polskie skróty, po których kropka z odstępem nie kończy zdania („np. sowy”). Niedoszacowanie liczby
 * zdań jest bezpieczne (szept wymaga co najmniej dwóch), a przeszacowanie zaszeptałoby jedno zdanie.
 */
const ABBREVIATION_DOT = /(?<![\p{L}\d])(np|itp|itd|tzn|tzw|tj|m\.in|p\.n\.e|n\.e|r|w|ok|godz|dr|prof|tys|mln|mld|św|ul|ks)\.(?=\s)/giu;

/**
 * Liczba zdań w tekście nagrania (spec tonu TTS §4.3): po normalizacji odstępów zdanie to fragment
 * zakończony `.`, `!`, `?` lub `…` (albo końcem tekstu). Ciąg znaków kończących, np. „…?”, to jedna granica;
 * znak kończący liczy się, gdy po nim jest odstęp lub koniec tekstu (kropka w „3.5” ani w skrócie
 * „np.”, „itp.”, „m.in.” nie dzieli).
 */
export function sentenceCount(text: string): number {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(ABBREVIATION_DOT, "$1\uE000")
    .split(/[.!?…]+(?=\s|$)/)
    .filter((fragment) => /[^\s.!?…]/.test(fragment))
    .length;
}

/**
 * Styl nagrania pytania lub karty lekcji: ton autora, a bez niego rola. Reguła szeptu (spec tonu
 * TTS §4.3): `mysterious` daje `curious` dla pytania — jego czytany tekst zaczyna się od polecenia,
 * więc szept padłby na polecenie, a nie na treść — oraz dla tekstu z mniej niż dwoma zdaniami.
 */
export function lessonPromptStyle(
  role: "lesson_question" | "lesson_card",
  tone: LessonVoiceTone | undefined,
  text: string,
): TtsStyle {
  if (!tone) return role;
  if (tone === "mysterious" && (role === "lesson_question" || sentenceCount(text) < 2)) return "curious";
  return tone;
}
