import { feedbackSentenceText } from "./feedback-sentence-text";
import { APOSTROPHE_VARIANTS } from "./normalize";
import type { LessonExerciseDraft, LessonExerciseType, SubjectModule } from "./types";

export interface LessonExerciseStimulus {
  readonly objectiveId: string;
  readonly exerciseType: string;
  readonly stimulus: string;
}

function normalizeStimulus(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-GB");
}

/**
 * Normalizacja tylko do deduplikacji (#323): dodatkowo apostrofy typograficzne i końcowe `.?!…`.
 * Nie zasila `lessonExerciseStimulus`, bo ten wchodzi do zapisywanych kryteriów (`criteria.assignments`).
 */
function dedupStimulus(value: string): string {
  const text = normalizeStimulus(value.replace(APOSTROPHE_VARIANTS, "'"));
  // Pętla zamiast regexu z `+$` (wielomianowy backtracking, CodeQL); po normalizacji jedynym białym znakiem jest spacja.
  let end = text.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(text[end - 1]!)) end -= 1;
  return text.slice(0, end);
}

const TRAILING_PUNCTUATION: ReadonlySet<string> = new Set([" ", ".", "?", "!", "…"]);

type Normalize = (value: string) => string;

/** Opcje tożsamości ćwiczenia pochodzące z przedmiotu (`SubjectModule.instructionIsStimulus`). */
export interface LessonExerciseIdentityOptions {
  /** Polecenie niesie bodziec znaczenia: wchodzi do bodźca wyboru, luki i układanki. */
  readonly instructionIsStimulus?: boolean;
}

/** Typy, których bodziec zawiera polecenie przy `instructionIsStimulus`. */
const INSTRUCTION_STIMULUS_TYPES: ReadonlySet<LessonExerciseType> = new Set<LessonExerciseType>([
  "lesson_choice",
  "lesson_gap",
  "lesson_order",
]);

/** Opcje tożsamości dla przedmiotu — jedno miejsce, z którego korzystają wszystkie wywołania. */
export function lessonIdentityOptionsOf(subject: Pick<SubjectModule, "instructionIsStimulus">): LessonExerciseIdentityOptions {
  return subject.instructionIsStimulus === true ? { instructionIsStimulus: true } : {};
}

/** Wyciąga funkcjonalny bodziec, pomijając kosmetyczne pola prezentacji. */
export function lessonExerciseStimulus(exercise: LessonExerciseDraft, options: LessonExerciseIdentityOptions = {}): string {
  return stimulusWith(exercise, options, normalizeStimulus);
}

function stimulusWith(exercise: LessonExerciseDraft, options: LessonExerciseIdentityOptions, normalizeStimulus: Normalize): string {
  const base = baseStimulus(exercise, normalizeStimulus);
  return options.instructionIsStimulus === true && INSTRUCTION_STIMULUS_TYPES.has(exercise.exerciseType)
    ? JSON.stringify([normalizeStimulus(exercise.instructionPl ?? ""), base])
    : base;
}

function baseStimulus(exercise: LessonExerciseDraft, normalizeStimulus: Normalize): string {
  switch (exercise.exerciseType) {
    case "lesson_calculation": {
      const calculation = exercise.calculation;
      return calculation === undefined ? "" : JSON.stringify([
        calculation.kind,
        Object.entries(calculation.params).sort(([left], [right]) => left.localeCompare(right)),
        calculation.unit,
      ]);
    }
    case "lesson_transform":
      return JSON.stringify([normalizeStimulus(exercise.statement ?? ""), exercise.transformId ?? ""]);
    case "lesson_error_fix":
      return normalizeStimulus(exercise.statement ?? "");
    case "lesson_open_answer":
      return normalizeStimulus(exercise.prompt ?? "");
    case "lesson_short_answer":
      return normalizeStimulus(exercise.prompt ?? exercise.stem ?? "");
    case "lesson_order":
      return JSON.stringify([...(exercise.items ?? []).map((item) => normalizeStimulus(item.text))].sort());
    case "lesson_choice":
      // Piktogram jest częścią bodźca: ten sam stem z innym obrazkiem to inne ćwiczenie.
      return exercise.visualSubject === undefined
        ? normalizeStimulus(exercise.stem ?? "")
        : JSON.stringify([normalizeStimulus(exercise.stem ?? ""), exercise.visualSubject]);
    case "lesson_listen_choice": {
      // Bodźcem jest nagranie pełnego zdania: ten sam stem z inną poprawną opcją to inne ćwiczenie.
      const sentence = feedbackSentenceText({
        exerciseType: exercise.exerciseType,
        stem: exercise.stem,
        options: exercise.options,
        correctOption: exercise.correctOption,
      });
      return JSON.stringify([normalizeStimulus(exercise.stem ?? ""), normalizeStimulus(sentence ?? "")]);
    }
    case "lesson_notice":
      return JSON.stringify((exercise.noticeSegments ?? []).map((sentence) => sentence.map(normalizeStimulus)));
    case "lesson_match":
      // Bodźcem jest zbiór par (kolejność bez znaczenia); dystraktory nie zmieniają ćwiczenia.
      return JSON.stringify((exercise.pairs ?? []).map((pair) => `${normalizeStimulus(pair.left)}=${normalizeStimulus(pair.right)}`).sort((a, b) => a.localeCompare(b)));
    case "lesson_group": {
      // Bodźcem są grupy z elementami (kolejność bez znaczenia).
      const items = exercise.groupItems ?? [];
      return JSON.stringify((exercise.groups ?? []).map((group) => [
        normalizeStimulus(group.label),
        items.filter((item) => item.groupId === group.id).map((item) => normalizeStimulus(item.text)).sort((a, b) => a.localeCompare(b)),
      ]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    }
    case "lesson_cloze":
      // Bodźcem jest tekst z lukami i słowa luk; dystraktory nie zmieniają ćwiczenia.
      return JSON.stringify([normalizeStimulus(exercise.clozeText ?? ""), (exercise.gapAnswers ?? []).map(normalizeStimulus)]);
    case "lesson_keywords":
      // Bodźcem jest rodzina pytań i zbiór pojęć (kolejność opcji bez znaczenia).
      return JSON.stringify([exercise.familyId ?? "", (exercise.keywordOptions ?? []).map((option) => normalizeStimulus(option.text)).sort((a, b) => a.localeCompare(b))]);
    default:
      return normalizeStimulus(exercise.stem ?? exercise.prompt ?? exercise.statement ?? "");
  }
}

/** Stabilna tożsamość ćwiczenia, niezależna od odpowiedzi i wariantów UI. */
export function lessonExerciseIdentity(exercise: LessonExerciseDraft, options: LessonExerciseIdentityOptions = {}): string {
  return JSON.stringify([
    exercise.objectiveId,
    exercise.exerciseType,
    stimulusWith(exercise, options, dedupStimulus),
  ]);
}
