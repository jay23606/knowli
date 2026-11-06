import { messages } from "@learning/contracts";

/** Pola payloadu ćwiczenia potrzebne do nagrania pytania (design szkoły §11.1). */
export interface QuestionReadSource {
  readonly exerciseType: string;
  readonly instructionPl?: string;
  readonly stem?: string;
  readonly prompt?: string;
  readonly groups?: readonly { readonly label: string }[];
  readonly clozeText?: string;
}

/** Słowo czytane zamiast luki w zdaniu (`lesson_gap`). */
export const SPOKEN_GAP = "luka";

/**
 * Tekst nagrania „Posłuchaj pytania” (design szkoły §11.1) z zatwierdzonego
 * payloadu: polecenie i bodziec, wyłącznie w kolejności niezależnej od
 * tasowania przy wydaniu zadania (bez opcji, pojęć, klocków i par) i nigdy
 * wskazówka. Polecenie tylko z payloadu albo stałe polecenie typu — zastępczy
 * tytuł celu nie trafia do nagrania. `null`, gdy typ nie ma nagrania
 * (`lesson_calculation`, typy gramatyki) albo nie ma czego czytać.
 */
export function questionReadText(source: QuestionReadSource): string | null {
  const instruction = clean(source.instructionPl);
  let parts: (string | undefined)[];
  switch (source.exerciseType) {
    case "lesson_choice":
      parts = [instruction, clean(source.stem)];
      break;
    case "lesson_gap":
      // Luka jak w Kid UI (`splitLessonGap`): ciąg 2+ podkreśleń, nie tylko `GAP_MARKER`.
      parts = [instruction, clean(source.stem?.replace(/_{2,}/g, SPOKEN_GAP))];
      break;
    case "lesson_open_answer":
      parts = [instruction, clean(source.prompt)];
      break;
    case "lesson_order":
      parts = [instruction];
      break;
    case "lesson_keywords":
      parts = [instruction ?? messages.kid.lessonKeywordsInstruction];
      break;
    case "lesson_match":
      parts = [instruction ?? messages.kid.lessonMatchInstruction];
      break;
    case "lesson_group":
      parts = [
        instruction ?? messages.kid.lessonGroupInstruction,
        ...(source.groups ?? []).map((group) => clean(group.label)),
      ];
      break;
    case "lesson_cloze":
      // Tekst z „luka” w miejscu luk; bank słów jest tasowany, więc go nie czytamy.
      parts = [
        instruction ?? messages.kid.lessonClozeInstruction,
        clean(source.clozeText?.replace(/_{2,}/g, SPOKEN_GAP)),
      ];
      break;
    default:
      return null;
  }
  const spoken = parts.filter((part): part is string => part !== undefined).map(withStop);
  return spoken.length === 0 ? null : spoken.join(" ");
}

function clean(text: string | undefined): string | undefined {
  const trimmed = text?.trim().replace(/\s+/g, " ");
  return trimmed ? trimmed : undefined;
}

/** Kropka po fragmencie bez znaku końca zdania, żeby lektor zrobił pauzę. */
function withStop(text: string): string {
  return /[.!?:…]$/.test(text) ? text : `${text}.`;
}
