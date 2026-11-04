import type { AgentCapableSubject } from "../agent/capable";
import type { LessonExerciseDraft, SubjectAgentPolicy, SubjectModule } from "../types";
import { historyLikeSubject } from "./history-like-subject";

/**
 * Przedmiot testowy agenta puli (poza skanem domeny, bo importuje przedmioty):
 * `historyLikeSubject` z dodanymi typami `lesson_keywords` i `lesson_listen_choice`
 * oraz polityką agenta i dwoma hakami przedmiotu (`validatePoolExtra`,
 * `refineGeneratedPool`) z deterministycznymi wyzwalaczami dla testów agenta.
 */

/** Zaślepka polityki: wszystkie typy przedmiotu do ślepego rozwiązania i sprawdzania wariantów. */
function defaultPolicy(subject: SubjectModule): SubjectAgentPolicy {
  return {
    blindSolveTypes: subject.exerciseTypes,
    variantCheckTypes: subject.exerciseTypes,
    checkerNeedsMaterial: false,
    independentReserve: 1,
    slack: 2,
    rejectionTexts: { leakVictim: "leak victim", leakSource: "leak source" },
  };
}

/** Owija dowolny przedmiot zaślepką polityki agenta (częściowo nadpisywalną). */
export function withAgentPolicy(
  subject: SubjectModule,
  policy: Partial<SubjectAgentPolicy> = {},
): AgentCapableSubject {
  return { ...subject, agentPolicy: { ...defaultPolicy(subject), ...policy } };
}

function refineGeneratedPool(drafts: readonly LessonExerciseDraft[]): {
  kept: LessonExerciseDraft[];
  rejected: { exercise: LessonExerciseDraft; reason: string }[];
} {
  const kept: LessonExerciseDraft[] = [];
  const rejected: { exercise: LessonExerciseDraft; reason: string }[] = [];
  for (const draft of drafts) {
    if (draft.answer === "REFINE-REJECT") {
      rejected.push({ exercise: draft, reason: "refine reject" });
      continue;
    }
    kept.push(
      draft.acceptedAnswers.includes("DROP")
        ? { ...draft, acceptedAnswers: draft.acceptedAnswers.filter((variant) => variant !== "DROP") }
        : draft,
    );
  }
  return { kept, rejected };
}

/** Rodzina żyje w obrębie zagadnienia (jak `validateSchoolPool` i `withoutOrphanKeywords`). */
function validatePoolExtra(drafts: readonly LessonExerciseDraft[]): ReadonlyMap<number, readonly string[]> {
  const errors = new Map<number, readonly string[]>();
  const familyKey = (draft: LessonExerciseDraft) => JSON.stringify([draft.objectiveId, draft.familyId]);
  const openFamilies = new Set(
    drafts.flatMap((draft) => (draft.exerciseType === "lesson_open_answer" && draft.familyId ? [familyKey(draft)] : [])),
  );
  drafts.forEach((draft, index) => {
    if (draft.exerciseType !== "lesson_keywords") return;
    if (!draft.familyId || !openFamilies.has(familyKey(draft))) errors.set(index, ["keywords without open-answer family"]);
  });
  return errors;
}

const base: SubjectModule = {
  ...historyLikeSubject,
  exerciseTypes: [...historyLikeSubject.exerciseTypes, "lesson_keywords", "lesson_listen_choice"],
  validatePoolExtra,
  refineGeneratedPool,
};

export const agentTestSubject: AgentCapableSubject = withAgentPolicy(base);
