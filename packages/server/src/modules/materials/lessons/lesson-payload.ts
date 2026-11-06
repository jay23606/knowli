import type { LessonExerciseDraft, SubjectModule } from "../../../domain/lessons/types";

/**
 * Payload `lesson_exercise` (payload_version 2) z locale przedmiotu. Moduł-liść bez zależności
 * od generowania i API (zapis, nadzór).
 */
export function buildLessonPayload(
  ex: LessonExerciseDraft,
  subject: SubjectModule,
): Record<string, unknown> {
  return {
    exerciseType: ex.exerciseType,
    objectiveId: ex.objectiveId,
    ...(ex.instructionPl === undefined ? {} : { instructionPl: ex.instructionPl }),
    ...(ex.stem === undefined ? {} : { stem: ex.stem }),
    ...(ex.statement === undefined ? {} : { statement: ex.statement }),
    ...(ex.prompt === undefined ? {} : { prompt: ex.prompt }),
    ...(ex.hint === undefined ? {} : { hint: ex.hint }),
    ...(ex.explanationPl === undefined ? {} : { explanationPl: ex.explanationPl }),
    ...(ex.transformId === undefined ? {} : { transformId: ex.transformId }),
    ...(ex.noticeSegments === undefined ? {} : { noticeSegments: ex.noticeSegments }),
    ...(ex.visualSubject === undefined ? {} : { visualSubject: ex.visualSubject }),
    answer: ex.answer,
    acceptedAnswers: [...ex.acceptedAnswers],
    focus: [...ex.focus],
    ...(ex.options === undefined ? {} : { options: ex.options }),
    ...(ex.correctOption === undefined ? {} : { correctOption: ex.correctOption }),
    ...(ex.items === undefined ? {} : { items: ex.items }),
    ...(ex.questionType === undefined ? {} : { questionType: ex.questionType }),
    ...(ex.requiredElements === undefined ? {} : { requiredElements: ex.requiredElements }),
    ...(ex.supplementaryElements === undefined ? {} : { supplementaryElements: ex.supplementaryElements }),
    ...(ex.commonErrors === undefined ? {} : { commonErrors: ex.commonErrors }),
    ...(ex.expectedForm === undefined ? {} : { expectedForm: ex.expectedForm }),
    ...(ex.familyId === undefined ? {} : { familyId: ex.familyId }),
    ...(ex.voiceTone === undefined ? {} : { voiceTone: ex.voiceTone }),
    ...(ex.sourceRefs === undefined ? {} : { sourceRefs: ex.sourceRefs }),
    ...(ex.calculation === undefined ? {} : { calculation: ex.calculation }),
    ...(ex.keywordOptions === undefined ? {} : { keywordOptions: ex.keywordOptions.map((option) => ({ id: option.id, text: option.text })) }),
    ...(ex.keyOptionIds === undefined ? {} : { keyOptionIds: [...ex.keyOptionIds] }),
    ...(ex.pairs === undefined ? {} : { pairs: ex.pairs.map((pair) => ({ left: pair.left, right: pair.right })) }),
    ...(ex.extraRight === undefined ? {} : { extraRight: [...ex.extraRight] }),
    ...(ex.groups === undefined ? {} : { groups: ex.groups.map((group) => ({ id: group.id, label: group.label })) }),
    ...(ex.groupItems === undefined ? {} : { groupItems: ex.groupItems.map((item) => ({ text: item.text, groupId: item.groupId })) }),
    ...(ex.clozeText === undefined ? {} : { clozeText: ex.clozeText }),
    ...(ex.gapAnswers === undefined ? {} : { gapAnswers: [...ex.gapAnswers] }),
    ...(ex.extraWords === undefined ? {} : { extraWords: [...ex.extraWords] }),
    answerLocale: subject.answerLocale,
    promptLocale: subject.promptLocale,
  };
}
