import { keywordsAnswer } from "../pool-validation";
import { agentTestSubject } from "./agent-test-subject";
import type { LessonExerciseDraft, LessonTopic } from "../types";
import type { AgentCheckContext, CandidateChecks, ObjectiveAgentLimits } from "../agent/admission";
import { agentObjectivesOf, type AgentCapableSubject } from "../agent/capable";
import { createLessonAgentState, type LessonAgentState, type LessonAgentStateInput } from "../agent/state";

/**
 * Wspólne fixture'y testów przyjmowania paczki (przedmiot testowy agenta).
 * Temat dopuszcza wszystkie typy przedmiotu w obu zagadnieniach; przedmiot ma
 * payload v3 (`familyId` słów kluczowych) i deduplikację po bodźcu — przy
 * deduplikacji po odpowiedzi każde ujawnienie między ćwiczeniami byłoby
 * wcześniej duplikatem odpowiedzi (krok 3), więc krok 4 byłby nieosiągalny.
 */

const baseTopic = agentTestSubject.topics[0]!;
export const topic: LessonTopic = {
  ...baseTopic,
  objectives: baseTopic.objectives.map((objective) => ({ ...objective, exerciseTypes: [...agentTestSubject.exerciseTypes] })),
};
export const subject: AgentCapableSubject = {
  ...agentTestSubject,
  usesV3Payload: true,
  poolDeduplication: "exercise",
  topics: [topic],
};
export const objectives = agentObjectivesOf(topic);
export const [A, B] = objectives.map((objective) => objective.id) as [string, string];

export const DEFAULT_LIMITS: ObjectiveAgentLimits = { targetCount: 8, listenAllowance: 2, maxExercises: 12 };

export function contextFor(
  overrides: { subject?: AgentCapableSubject; limits?: Partial<Record<string, ObjectiveAgentLimits>>; material?: string } = {},
  objectiveIds: readonly string[] = [A, B],
): AgentCheckContext {
  return {
    subject: overrides.subject ?? subject,
    material: overrides.material ?? "",
    limits: new Map(objectiveIds.map((id) => [id, overrides.limits?.[id] ?? DEFAULT_LIMITS])),
  };
}

export function stateWith(overrides: Partial<LessonAgentStateInput> = {}): LessonAgentState {
  return createLessonAgentState({ topic, objectives, fixed: [], examples: {}, fixedSources: {}, ...overrides });
}

export const NA_CHECKS: CandidateChecks = { solve: { kind: "na" }, variants: { kind: "na" } };

export function naChecks(count: number): CandidateChecks[] {
  return Array.from({ length: count }, () => NA_CHECKS);
}

export function choice(objectiveId: string, n: number): LessonExerciseDraft {
  return {
    exerciseType: "lesson_choice",
    objectiveId,
    stem: `Pytanie numer ${n}: ___`,
    options: [
      { id: "a", text: `odpowiedź ${n}` },
      { id: "b", text: `dystraktor ${n}` },
    ],
    correctOption: "a",
    answer: `odpowiedź ${n}`,
    acceptedAnswers: [],
    focus: [],
  };
}

export function open(objectiveId: string, prompt: string, answer: string, familyId?: string): LessonExerciseDraft {
  return {
    exerciseType: "lesson_open_answer",
    objectiveId,
    prompt,
    answer,
    acceptedAnswers: [],
    focus: [answer.split(" ")[0]!],
    ...(familyId ? { familyId } : {}),
  };
}

export function gap(objectiveId: string, stem: string, answer: string): LessonExerciseDraft {
  return { exerciseType: "lesson_gap", objectiveId, stem, answer, acceptedAnswers: [], focus: [answer] };
}

export function keywords(objectiveId: string, familyId: string, n: number): LessonExerciseDraft {
  const keywordOptions = [
    { id: "k1", text: `pojęcie ${n} pierwsze` },
    { id: "k2", text: `pojęcie ${n} drugie` },
    { id: "k3", text: `pojęcie ${n} trzecie` },
    { id: "k4", text: `pojęcie ${n} czwarte` },
  ];
  const keyOptionIds = ["k1", "k2"];
  return {
    exerciseType: "lesson_keywords",
    objectiveId,
    prompt: `Wybierz pojęcia ${n}.`,
    keywordOptions,
    keyOptionIds,
    answer: keywordsAnswer({ keywordOptions, keyOptionIds }),
    acceptedAnswers: [],
    focus: [],
    familyId,
  };
}

export function listen(objectiveId: string, n: number): LessonExerciseDraft {
  return {
    exerciseType: "lesson_listen_choice",
    objectiveId,
    stem: `Mieszko przyjął chrzest w ___ roku numer ${n}.`,
    options: [
      { id: "a", text: "966" },
      { id: "b", text: "1000" },
    ],
    correctOption: "a",
    answer: "966",
    acceptedAnswers: [],
    focus: ["966"],
  };
}
