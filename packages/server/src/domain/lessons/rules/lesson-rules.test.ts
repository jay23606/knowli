import { describe, expect, it } from "vitest";
import { validatePoolIssues } from "../pool-validation";
import { historyLikeSubject } from "../testing/history-like-subject";
import { testAgentPolicy } from "../testing/test-agent-policy";
import type { LessonExerciseDraft } from "../types";
import type { PoolDeduplication, RuleBookContext } from "./catalog";
import { LESSON_RULES } from "./lesson-rules";

/**
 * Warunki `when` reguł duplikatów puli: w prompcie jest dokładnie ta reguła,
 * którą `validatePoolIssues` zgłasza w trybie duplikatów przedmiotu.
 */

function context(deduplication: PoolDeduplication): RuleBookContext {
  return {
    exerciseTypes: historyLikeSubject.exerciseTypes,
    text: { answerMaxLength: 120, groundingRequired: false },
    policy: testAgentPolicy,
    listenChoice: false,
    voiceTones: false,
    exerciseExplanations: false,
    usesV3Payload: false,
    deduplication,
    topicId: historyLikeSubject.topics[0]!.id,
    objectiveId: historyLikeSubject.topics[0]!.objectives[0]!.id,
  };
}

const topic = historyLikeSubject.topics[0]!;
const objectiveId = topic.objectives[0]!.id;
const gapOf = (stem: string, answer: string): LessonExerciseDraft =>
  ({ exerciseType: "lesson_gap", objectiveId, stem, answer, acceptedAnswers: [], focus: [answer] });

/** Pula z powtórzonym bodźcem i powtórzoną odpowiedzią naraz. */
const pool = [
  gapOf("Chrzest Polski odbył się w ___ roku.", "966"),
  gapOf("Chrzest Polski odbył się w ___ roku.", "966"),
];

describe("when reguł duplikatów puli", () => {
  it.each([
    ["exercise", true, false],
    ["answer", false, true],
  ] as const)("tryb %s: duplicate_stimulus %s, duplicate_answer %s", (mode, stimulus, answer) => {
    expect(LESSON_RULES["lesson.duplicate_stimulus"].when(context(mode))).toBe(stimulus);
    expect(LESSON_RULES["lesson.duplicate_answer"].when(context(mode))).toBe(answer);
  });

  it.each(["exercise", "answer"] as const)("tryb %s: validatePoolIssues zgłasza tylko regułę z prawdziwym when", (mode) => {
    const subject = { ...historyLikeSubject, poolDeduplication: mode };
    const emitted = validatePoolIssues(pool, subject, topic).rejected.flatMap((entry) => entry.issues.map((issue) => issue.rule as string));
    const gated = (["lesson.duplicate_stimulus", "lesson.duplicate_answer"] as const)
      .filter((id) => LESSON_RULES[id].when(context(mode)));
    expect(emitted).toEqual(gated);
  });

  it("przedmiot bez poolDeduplication zgłasza duplikat odpowiedzi (tryb answer)", () => {
    const emitted = validatePoolIssues(pool, historyLikeSubject, topic).rejected.flatMap((entry) => entry.issues.map((issue) => issue.rule));
    expect(emitted).toEqual(["lesson.duplicate_answer"]);
  });
});
