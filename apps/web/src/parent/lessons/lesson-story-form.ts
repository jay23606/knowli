import type { LessonPromptAudioDto, LessonStoryDto } from "@learning/contracts";

/**
 * Czyste operacje formularza historyjki lekcji (edytor rodzica). Limity tu są
 * tylko ograniczeniem formularza (maks. 6 zdań i 2 pytania, min. 1 zdanie
 * i 1 pytanie); reguły historyjki (4–6 zdań, 1–2 pytania, 3 odpowiedzi) i ich
 * komunikaty daje serwer (`details.story`).
 */

export const STORY_FORM_MAX_SENTENCES = 6;
export const STORY_FORM_MAX_QUESTIONS = 2;
const OPTION_IDS = ["a", "b", "c"] as const;

type StoryQuestion = LessonStoryDto["questions"][number];

function emptyQuestion(id: string): StoryQuestion {
  return { id, question: "", options: OPTION_IDS.map((optionId) => ({ id: optionId, text: "" })), correctOption: "a" };
}

/** Nowa historyjka do ręcznego wypełnienia: 4 puste zdania i pytanie `q1` z odpowiedziami `a/b/c`. */
export function emptyStory(): LessonStoryDto {
  return { sentences: ["", "", "", ""], questions: [emptyQuestion("q1")] };
}

export function addSentence(story: LessonStoryDto): LessonStoryDto {
  if (story.sentences.length >= STORY_FORM_MAX_SENTENCES) return story;
  return { ...story, sentences: [...story.sentences, ""] };
}

export function removeSentence(story: LessonStoryDto, index: number): LessonStoryDto {
  if (story.sentences.length <= 1) return story;
  return { ...story, sentences: story.sentences.filter((_, i) => i !== index) };
}

export function setSentence(story: LessonStoryDto, index: number, text: string): LessonStoryDto {
  return { ...story, sentences: story.sentences.map((sentence, i) => (i === index ? text : sentence)) };
}

/** Dodaje puste pytanie z pierwszym wolnym identyfikatorem `q<n>` (bez kolizji po usunięciu). */
export function addQuestion(story: LessonStoryDto): LessonStoryDto {
  if (story.questions.length >= STORY_FORM_MAX_QUESTIONS) return story;
  const used = new Set(story.questions.map((question) => question.id));
  let n = 1;
  while (used.has(`q${n}`)) n += 1;
  return { ...story, questions: [...story.questions, emptyQuestion(`q${n}`)] };
}

export function removeQuestion(story: LessonStoryDto, id: string): LessonStoryDto {
  if (story.questions.length <= 1) return story;
  return { ...story, questions: story.questions.filter((question) => question.id !== id) };
}

function mapQuestion(story: LessonStoryDto, id: string, change: (question: StoryQuestion) => StoryQuestion): LessonStoryDto {
  return { ...story, questions: story.questions.map((question) => (question.id === id ? change(question) : question)) };
}

export function setQuestionText(story: LessonStoryDto, id: string, text: string): LessonStoryDto {
  return mapQuestion(story, id, (question) => ({ ...question, question: text }));
}

export function setOptionText(story: LessonStoryDto, questionId: string, optionId: string, text: string): LessonStoryDto {
  return mapQuestion(story, questionId, (question) => ({
    ...question,
    options: question.options.map((option) => (option.id === optionId ? { ...option, text } : option)),
  }));
}

export function setCorrectOption(story: LessonStoryDto, questionId: string, optionId: string): LessonStoryDto {
  return mapQuestion(story, questionId, (question) => ({ ...question, correctOption: optionId }));
}

/** Równość treści historyjek; `null` i `undefined` (brak historyjki) są równe. */
export function storyEquals(a?: LessonStoryDto | null, b?: LessonStoryDto | null): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (a.sentences.length !== b.sentences.length || a.questions.length !== b.questions.length) return false;
  if (a.sentences.some((sentence, i) => sentence !== b.sentences[i])) return false;
  return a.questions.every((question, i) => {
    const other = b.questions[i]!;
    return question.id === other.id
      && question.question === other.question
      && question.correctOption === other.correctOption
      && question.options.length === other.options.length
      && question.options.every((option, j) => option.id === other.options[j]!.id && option.text === other.options[j]!.text);
  });
}

const squashWhitespace = (text: string) => text.trim().replace(/\s+/g, " ");

/**
 * Czy zdania formularza odpowiadają zapisanym (po tej samej normalizacji białych
 * znaków co tekst nagrania, `storyReadText`) — wtedy zapisane nagranie dotyczy
 * tego, co rodzic widzi. Pytania i odpowiedzi nie wpływają na nagranie.
 * `form === undefined` (formularz niezainicjowany) = bez zmian; `null` (usunięta
 * historyjka) przy zapisanej historyjce = zmiana.
 */
export function storySentencesUnchanged(saved: LessonStoryDto | undefined, form: LessonStoryDto | null | undefined): boolean {
  if (form === undefined) return true;
  const savedSentences = saved?.sentences ?? [];
  const formSentences = form?.sentences ?? [];
  if (savedSentences.length !== formSentences.length) return false;
  return savedSentences.every((sentence, i) => squashWhitespace(sentence) === squashWhitespace(formSentences[i]!));
}

/**
 * Widoczność nagrania historyjki w edytorze. Wersja opublikowana: nagranie
 * widać zawsze, a przy `failed` także wskazówkę (nagrać ponownie można dopiero
 * w nowej wersji). Szkic: nagranie widać tylko, gdy zdania formularza są
 * zapisanymi i żaden run historyjki nie przepnie go za chwilę; wskazówki
 * w szkicu nie ma (tam jest „Nagraj ponownie”). Bez nagrania nic nie widać.
 */
export function storyAudioView({ editable, saved, form, storyGenerating, audio }: {
  editable: boolean;
  saved: LessonStoryDto | undefined;
  form: LessonStoryDto | null | undefined;
  storyGenerating: boolean;
  audio: LessonPromptAudioDto | undefined;
}): { show: boolean; publishedFailedHint: boolean } {
  if (!audio) return { show: false, publishedFailedHint: false };
  const show = !editable || (storySentencesUnchanged(saved, form) && !storyGenerating);
  return { show, publishedFailedHint: show && !editable && audio.state === "failed" };
}
