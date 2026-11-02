import { feedbackSentenceText } from "./feedback-sentence-text";
import type { AnswerNormalizer, LessonExerciseDraft } from "./types";

/**
 * Historyjka na koniec sesji lekcji (design „Historyjka lekcji” §4–§5): krótki
 * tekst w języku odpowiedzi z 1–2 pytaniami o treść. Czysty model domeny —
 * walidacja i bariera ekspozycji bez bazy, sieci i zegara.
 */

/** Opcja odpowiedzi na pytanie o treść historyjki. */
export interface LessonStoryOption {
  readonly id: string;
  readonly text: string;
}

/** Pytanie o treść historyjki (język poleceń) z dokładnie jedną poprawną opcją. */
export interface LessonStoryQuestion {
  readonly id: string;
  readonly question: string;
  readonly options: readonly LessonStoryOption[];
  readonly correctOption: string;
}

/** Historyjka: zdania w języku odpowiedzi i pytania o treść. */
export interface LessonStory {
  readonly sentences: readonly string[];
  readonly questions: readonly LessonStoryQuestion[];
}

/** Limity historyjki (długości w znakach); `avoidSentencesMax` — ile rozwiązań trafia do promptu „nie powtarzaj”. */
export const LESSON_STORY_LIMITS = {
  minSentences: 4,
  maxSentences: 6,
  sentenceMaxLength: 160,
  textMaxLength: 700,
  minQuestions: 1,
  maxQuestions: 2,
  questionMaxLength: 160,
  optionCount: 3,
  optionMaxLength: 80,
  avoidSentencesMax: 120,
} as const;

/**
 * Rozwiązane zdania puli ćwiczeń: pełne zdanie z `feedbackSentenceText` (luka,
 * wybór, układanka, cloze…), luka wypełniona każdym zaakceptowanym wariantem,
 * tekst poprawnej opcji wyboru bez luki w treści oraz dla typów produktywnych
 * `answer` i każda zaakceptowana odpowiedź. Po `trim`, bez pustych
 * i duplikatów, w kolejności wystąpienia.
 */
export function solvedSentencesOf(drafts: readonly LessonExerciseDraft[]): string[] {
  const seen = new Set<string>();
  const sentences: string[] = [];
  const add = (text: string | null | undefined): void => {
    const sentence = text?.trim();
    if (!sentence || seen.has(sentence)) return;
    seen.add(sentence);
    sentences.push(sentence);
  };
  // Bez limitu długości nagrania: zdanie za długie do odczytu nadal jest rozwiązaniem.
  const unlimited = Number.POSITIVE_INFINITY;
  for (const draft of drafts) {
    add(feedbackSentenceText(draft, unlimited));
    // Luka: każdy zaakceptowany wariant wstawiony w zdanie też je rozwiązuje.
    if (draft.exerciseType === "lesson_gap") {
      for (const accepted of draft.acceptedAnswers) add(feedbackSentenceText({ ...draft, answer: accepted }, unlimited));
    }
    // Wybór bez luki w treści (np. „Które zdanie jest poprawne?”): poprawna opcja sama jest rozwiązaniem.
    if (draft.exerciseType === "lesson_choice" && !/_{2,}/.test(draft.stem ?? "")) {
      add(draft.options?.find((option) => option.id === draft.correctOption)?.text);
    }
    if (
      draft.exerciseType === "lesson_error_fix" ||
      draft.exerciseType === "lesson_transform" ||
      draft.exerciseType === "lesson_open_answer"
    ) {
      add(draft.answer);
      for (const accepted of draft.acceptedAnswers) add(accepted);
    }
  }
  return sentences;
}

/** Tekst do pomiaru długości i porównań: po `trim` i scaleniu białych znaków. */
function squash(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** Wariant zdania po normalizatorze jako klucz porównania. */
function normalizedVariants(text: string, normalizer: AnswerNormalizer): string[] {
  return normalizer.normalize(text).map((tokens) => tokens.join(" "));
}

/**
 * Bariera ekspozycji: indeksy zdań historyjki równych (po normalizatorze
 * przedmiotu, w którymkolwiek wariancie) rozwiązanemu zdaniu ćwiczenia — takie
 * zdanie ujawniłoby odpowiedź przed samodzielnym sprawdzeniem.
 */
export function storyCollisions(
  sentences: readonly string[],
  solvedSentences: readonly string[],
  normalizer: AnswerNormalizer,
): number[] {
  const solved = new Set(solvedSentences.flatMap((sentence) => normalizedVariants(sentence, normalizer)));
  const collisions: number[] = [];
  sentences.forEach((sentence, index) => {
    if (normalizedVariants(sentence, normalizer).some((variant) => solved.has(variant))) collisions.push(index);
  });
  return collisions;
}

/**
 * Błędy historyjki po polsku (pusta lista = poprawna), w kolejności: zdania,
 * potem pytania. Pojedyncze zdania są sprawdzane także przy złej liczbie zdań,
 * żeby rodzic widział wszystkie błędy naraz.
 */
export function validateLessonStory(
  story: LessonStory,
  ctx: { normalizer: AnswerNormalizer; solvedSentences: readonly string[] },
): string[] {
  const limits = LESSON_STORY_LIMITS;
  const errors: string[] = [];

  if (story.sentences.length < limits.minSentences || story.sentences.length > limits.maxSentences) {
    errors.push(`Historyjka ma mieć od ${limits.minSentences} do ${limits.maxSentences} zdań.`);
  }
  story.sentences.forEach((sentence, index) => {
    const text = squash(sentence);
    if (!text) errors.push(`Zdanie ${index + 1} jest puste.`);
    else if (text.length > limits.sentenceMaxLength) {
      errors.push(`Zdanie ${index + 1} jest dłuższe niż ${limits.sentenceMaxLength} znaków.`);
    }
  });
  if (storyReadText(story).length > limits.textMaxLength) {
    errors.push(`Historyjka jest dłuższa niż ${limits.textMaxLength} znaków.`);
  }
  for (const index of storyCollisions(story.sentences, ctx.solvedSentences, ctx.normalizer)) {
    errors.push(`Zdanie ${index + 1} powtarza rozwiązanie ćwiczenia.`);
  }

  if (story.questions.length < limits.minQuestions || story.questions.length > limits.maxQuestions) {
    errors.push(`Historyjka ma mieć ${limits.minQuestions} lub ${limits.maxQuestions} pytania.`);
  }
  if (new Set(story.questions.map((question) => question.id)).size !== story.questions.length) {
    errors.push("Pytania mają powtarzające się identyfikatory.");
  }
  story.questions.forEach((question, index) => validateQuestion(question, index + 1, errors));

  return errors;
}

function validateQuestion(question: LessonStoryQuestion, number: number, errors: string[]): void {
  const limits = LESSON_STORY_LIMITS;
  const text = squash(question.question);
  if (!text) errors.push(`Pytanie ${number} jest puste.`);
  else if (text.length > limits.questionMaxLength) {
    errors.push(`Pytanie ${number} jest dłuższe niż ${limits.questionMaxLength} znaków.`);
  }

  if (question.options.length !== limits.optionCount) {
    errors.push(`Pytanie ${number} ma mieć dokładnie ${limits.optionCount} odpowiedzi.`);
  }
  const texts: string[] = [];
  question.options.forEach((option, index) => {
    const optionText = squash(option.text);
    if (!optionText) errors.push(`Pytanie ${number}: odpowiedź ${index + 1} jest pusta.`);
    else {
      texts.push(optionText.toLocaleLowerCase("pl-PL"));
      if (optionText.length > limits.optionMaxLength) {
        errors.push(`Pytanie ${number}: odpowiedź ${index + 1} jest dłuższa niż ${limits.optionMaxLength} znaków.`);
      }
    }
  });
  if (new Set(texts).size !== texts.length) errors.push(`Pytanie ${number} ma powtarzające się odpowiedzi.`);
  if (new Set(question.options.map((option) => option.id)).size !== question.options.length) {
    errors.push(`Pytanie ${number} ma powtarzające się identyfikatory odpowiedzi.`);
  }
  if (!question.options.some((option) => option.id === question.correctOption)) {
    errors.push(`Pytanie ${number} nie ma wskazanej poprawnej odpowiedzi.`);
  }
}

/** Tekst odczytu historyjki: zdania po `trim` i scaleniu białych znaków, złączone spacją. */
export function storyReadText(story: LessonStory): string {
  return story.sentences.map(squash).join(" ");
}
