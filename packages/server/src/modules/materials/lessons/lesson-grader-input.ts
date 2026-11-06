import { BASE_ERROR_CATEGORIES } from "../../../domain/lessons/base-error-categories";
import type { LessonExerciseDraft, LessonTopic, SchoolCriteria, SubjectModule } from "../../../domain/lessons/types";
import type { GraderInput } from "../../../ports/ai";

/**
 * Wspólne wejście gradera dla odpowiedzi otwartych: jedna derywacja pól oceny i
 * `GraderInput` dla odpowiedzi dziecka (obszar `learning`) i kontroli agenta
 * puli (obszar `materials`). Funkcja leży w `materials`, bo `learning` importuje
 * `materials` przez barrel, a nie odwrotnie; zwraca `GraderInput` z portu,
 * więc nie może mieszkać w `domain/`.
 */

/**
 * Pola ćwiczenia, z których liczymy polecenie i kryteria oceny. Struktura po
 * polach wspólnych szkicu (`LessonExerciseDraft`) i payloadu rewizji
 * (`LessonExercisePayload`); `expectedForm` jest tu zwykłym tekstem, bo payload
 * zapisany w bazie nie zawęża go do unii szkicu.
 */
export type OpenAnswerFields = Pick<
  LessonExerciseDraft,
  | "exerciseType"
  | "objectiveId"
  | "instructionPl"
  | "transformId"
  | "requiredElements"
  | "supplementaryElements"
  | "commonErrors"
  | "sourceRefs"
> & { readonly expectedForm?: string };

/**
 * Polecenie widoczne dla dziecka: `instructionPl`, inaczej polecenie
 * przekształcenia z tematu, inaczej tytuł celu, inaczej pusty tekst.
 */
export function lessonInstructionOf(topic: LessonTopic, fields: OpenAnswerFields): string {
  const transform =
    fields.exerciseType === "lesson_transform" && fields.transformId
      ? topic.transforms.find((t) => t.id === fields.transformId)?.instructionPl
      : undefined;
  const objective = topic.objectives.find((o) => o.id === fields.objectiveId);
  return fields.instructionPl ?? transform ?? objective?.titlePl ?? "";
}

/** Kryteria v3 pytania otwartego; brak (albo pusta lista elementów wymaganych) = `undefined`. */
export function schoolCriteriaOf(fields: OpenAnswerFields): SchoolCriteria | undefined {
  if (!fields.requiredElements || fields.requiredElements.length === 0) return undefined;
  return {
    requiredElements: fields.requiredElements.map((el) => ({ ...el })),
    supplementaryElements: [...(fields.supplementaryElements ?? [])],
    commonErrors: [...(fields.commonErrors ?? [])],
    ...(fields.expectedForm ? { expectedForm: fields.expectedForm } : {}),
    sourceQuotes: (fields.sourceRefs ?? []).map((ref) => ref.quote),
  };
}

/** Etykiety kategorii dla celu: bazowe ∪ przedmiotu ∪ tematu, po kodzie. */
export function lessonCategoryLabels(subject: SubjectModule, topic: LessonTopic): Map<string, string> {
  const labels = new Map<string, string>();
  for (const category of BASE_ERROR_CATEGORIES) labels.set(category.code, category.labelPl);
  for (const category of subject.errorCategories) labels.set(category.code, category.labelPl);
  for (const category of topic.extraErrorCategories) labels.set(category.code, category.labelPl);
  return labels;
}

/** Buduje wejście modelu oceniającego (odpowiedź jako dane: dziecka albo rozwiązującego). */
export function lessonGraderInput(args: {
  readonly subject: SubjectModule;
  readonly topic: LessonTopic;
  readonly objective: { readonly descriptionEn: string; readonly errorCategories: readonly string[] };
  readonly instruction: string;
  readonly stimulus: string | null;
  readonly answer: string;
  readonly acceptedAnswers: readonly string[];
  readonly schoolCriteria: SchoolCriteria | undefined;
  readonly answerText: string;
}): GraderInput {
  const { subject, topic, objective, instruction, stimulus, answer, acceptedAnswers, schoolCriteria, answerText } = args;
  const labels = lessonCategoryLabels(subject, topic);
  const school = schoolCriteria
    ? {
        question: stimulus ?? instruction,
        modelAnswer: answer,
        requiredElements: schoolCriteria.requiredElements.map((el) => ({ ...el })),
        supplementaryElements: [...schoolCriteria.supplementaryElements],
        commonErrors: [...(schoolCriteria.commonErrors ?? [])],
        expectedForm: schoolCriteria.expectedForm ?? "explanation",
        sourceQuotes: [...schoolCriteria.sourceQuotes],
      }
    : undefined;
  return {
    subjectTitle: subject.titlePl,
    topicTitle: topic.titlePl,
    roleProfile: { gradingRole: subject.prompts.gradingRole, almostDefinition: subject.prompts.almostDefinition },
    instruction,
    stimulus,
    objective: {
      description: objective.descriptionEn,
      errorCategories: objective.errorCategories.map((code) => ({ code, label: labels.get(code) ?? code })),
    },
    acceptedAnswers: [answer, ...acceptedAnswers],
    // Limit ścieżki szkolnej 600 znaków (odpowiedzi otwarte), lekcje bez zmian 200.
    childAnswer: answerText.slice(0, school ? 600 : 200),
    ...(school ? { school } : {}),
  };
}
