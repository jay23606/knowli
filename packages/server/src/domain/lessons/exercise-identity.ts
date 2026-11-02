import { feedbackSentenceText } from "./feedback-sentence-text";
import type { LessonExerciseDraft, LessonExerciseType, SubjectModule } from "./types";

export interface LessonExerciseStimulus {
  readonly objectiveId: string;
  readonly exerciseType: string;
  readonly stimulus: string;
}

function normalizeStimulus(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-GB");
}

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
  const base = baseStimulus(exercise);
  return options.instructionIsStimulus === true && INSTRUCTION_STIMULUS_TYPES.has(exercise.exerciseType)
    ? JSON.stringify([normalizeStimulus(exercise.instructionPl ?? ""), base])
    : base;
}

function baseStimulus(exercise: LessonExerciseDraft): string {
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
    lessonExerciseStimulus(exercise, options),
  ]);
}

export function lessonExerciseStimulusRecord(exercise: LessonExerciseDraft, options: LessonExerciseIdentityOptions = {}): LessonExerciseStimulus {
  return {
    objectiveId: exercise.objectiveId,
    exerciseType: exercise.exerciseType,
    stimulus: lessonExerciseStimulus(exercise, options),
  };
}
