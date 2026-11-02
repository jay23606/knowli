import { clozeGapCount, fillCloze } from "./cloze";

/** Pola payloadu ćwiczenia potrzebne do zbudowania poprawnego zdania do odczytu po odpowiedzi. */
export interface FeedbackSentenceSource {
  readonly exerciseType: string;
  readonly stem?: string;
  readonly answer?: string;
  readonly options?: readonly { readonly id: string; readonly text: string }[];
  /** Id poprawnej opcji (nie jej tekst). */
  readonly correctOption?: string;
  /** Klocki `lesson_order` w kolejności kanonicznej (jak w payloadzie). */
  readonly items?: readonly { readonly id: string; readonly text: string }[];
  /** `lesson_cloze`: tekst z lukami (2+ podkreśleń) i słowa luk w kolejności luk. */
  readonly clozeText?: string;
  readonly gapAnswers?: readonly string[];
}

/** Najdłuższe zdanie, które nagrywamy (jak limit odpowiedzi dziecka). */
export const FEEDBACK_SENTENCE_MAX_LENGTH = 200;

/**
 * Pełne, poprawne zdanie ćwiczenia lekcji w języku odpowiedzi (albo krótki
 * tekst luk z bankiem słów), czytane dziecku po odpowiedzi. `null`, gdy typ
 * nie ma pojedynczego zdania do przeczytania, luka jest niejednoznaczna,
 * słowa luk nie pasują do tekstu albo zdanie przekracza limit.
 */
export function feedbackSentenceText(source: FeedbackSentenceSource): string | null {
  let raw: string | undefined;
  switch (source.exerciseType) {
    case "lesson_gap":
      raw = fillGap(source.stem, source.answer);
      break;
    case "lesson_choice":
    case "lesson_listen_choice":
      raw = fillGap(source.stem, source.options?.find((option) => option.id === source.correctOption)?.text);
      break;
    case "lesson_order":
      raw = joinOrderItems(source.items);
      break;
    case "lesson_cloze":
      raw = fillClozeText(source.clozeText, source.gapAnswers);
      break;
    case "lesson_error_fix":
    case "lesson_transform":
    case "lesson_open_answer":
      raw = source.answer;
      break;
    default:
      return null;
  }
  const sentence = raw?.trim().replace(/\s+/g, " ").replace(/ ([.,!?])/g, "$1");
  if (!sentence || sentence.length > FEEDBACK_SENTENCE_MAX_LENGTH) return null;
  return sentence;
}

/** Klocki w kolejności kanonicznej; pusta lista albo pusty klocek → `undefined` (jak `lesson_cloze`). */
function joinOrderItems(items: FeedbackSentenceSource["items"]): string | undefined {
  if (!items || items.length === 0 || items.some((item) => !item.text.trim())) return undefined;
  return items.map((item) => item.text).join(" ");
}

/** Wstawia tekst w jedyną lukę (2+ podkreśleń); inaczej `undefined`. */
export function fillGap(stem: string | undefined, fill: string | undefined): string | undefined {
  if (!stem || !fill?.trim()) return undefined;
  if ((stem.match(/_{2,}/g) ?? []).length !== 1) return undefined;
  return stem.replace(/_{2,}/, () => fill.trim());
}

/**
 * Tekst luk z bankiem z poprawnymi słowami — ten sam `fillCloze` co `filledText`
 * klucza zadania (omówienie). Każda luka musi mieć niepuste słowo i żadne słowo
 * nie może zostać bez luki; inaczej `undefined`.
 */
function fillClozeText(text: string | undefined, words: readonly string[] | undefined): string | undefined {
  if (!text || !words) return undefined;
  const gaps = clozeGapCount(text);
  if (gaps === 0 || words.length !== gaps || words.some((word) => !word.trim())) return undefined;
  return fillCloze(text, words);
}
