import type { ObjectiveAgentLimits } from "../../../domain/lessons/agent/admission";
import { allExamples, orderedEntries, orderedLesson, type LessonAgentState } from "../../../domain/lessons/agent/state";
import { avoidSentencesFor } from "../../../domain/lessons/avoid-sentences";
import { DISTINCT_OPEN_ANSWERS_PER_OBJECTIVE, lessonPoolMinimums } from "../../../domain/lessons/lesson-coverage";
import type { AgentObjective, LessonTopic, SubjectModule } from "../../../domain/lessons/types";
import type { LessonObjectiveAgentInput, LlmLessonStageCounts } from "../../../ports/ai";
import { buildPoolInput, poolStageCounts } from "./lesson-drafts";

/**
 * Wejście podagenta zagadnienia (spec etapu 1 §6.1, §7): pola promptu z
 * `buildPoolInput` (z księgą reguł zagadnienia) z liczbami z `targets` (jedyne
 * źródło liczb, także minima publikacji), lista zdań do unikania i zdania kart
 * CAŁEJ lekcji z bieżącego stanu (w chwili startu podagenta). Pozycja zagadnienia
 * i liczba jego ćwiczeń w stanie (`objective.index`, `objective.existingCount`)
 * służą wyłącznie fake'owi agenta. Czysta funkcja nad przekazanymi danymi.
 */
export interface ObjectiveAgentInputArgs {
  readonly subject: SubjectModule;
  readonly topic: LessonTopic;
  readonly state: LessonAgentState;
  readonly objective: AgentObjective;
  readonly limits: ObjectiveAgentLimits;
  readonly material: string;
  readonly instruction?: string;
  readonly interests?: readonly string[];
  readonly graderAvailable: boolean;
  /** `true` = przykłady kart są ustalone (plan albo wznowienie); w porcie pole `objective.examplesFromPlan`. */
  readonly examplesFixed: boolean;
  readonly maxSteps: number;
  readonly callTimeoutMs: number;
  /**
   * Liczby promptu wyliczone przez wołającego zamiast z `limits` — tryb „dodaj N” (spec etapu 2a §6.4):
   * podział etapów z braków etapów i `remaining` (bez `fixed` i bez podnoszenia etapu samodzielnego),
   * `targetCount` = suma etapów, `listenAllowance` = reszta dodatku słuchowego. `maxExercises` z `limits`.
   */
  readonly promptTargets?: { readonly stages: LlmLessonStageCounts; readonly listenAllowance: number };
}

function cardsText(objective: AgentObjective): string {
  return objective.cards.map((card) => `${card.title}: ${card.body}`).join("\n");
}

/**
 * Podział etapów zagadnienia dla modelu: podział `poolStageCounts` z etapem samodzielnym podniesionym do
 * minimum publikacji z rezerwą (`independentReserve`) — tego samego progu, którego wymaga
 * `objectiveStatus`. Pozostałe etapy bez zmian, więc suma może przekroczyć `targetCount`.
 */
function agentStageCounts(subject: SubjectModule, objective: AgentObjective, targetCount: number) {
  const split = poolStageCounts(subject, objective.exerciseTypes, targetCount);
  const independent = Math.max(split.independent, lessonPoolMinimums(subject).independent + subject.agentPolicy.independentReserve);
  return { ...split, independent };
}

export function objectiveAgentInput(args: ObjectiveAgentInputArgs): LessonObjectiveAgentInput {
  const { subject, topic, state, objective, limits } = args;
  const examples = allExamples(state);
  const stages = args.promptTargets?.stages ?? agentStageCounts(subject, objective, limits.targetCount);
  const targetCount = args.promptTargets === undefined ? limits.targetCount : stages.guided + stages.productive + stages.independent;
  const base = buildPoolInput(
    subject,
    topic,
    objective.id,
    targetCount,
    args.material,
    args.instruction,
    args.graderAvailable,
    args.interests,
    { avoidSentences: avoidSentencesFor({ examples, exercises: orderedLesson(state), subject }) },
  );
  // Ten sam podział w prompcie co w `targets`; liczba ćwiczeń = suma etapów (prompt: „podział obejmuje N ćwiczeń”).
  const pool = { ...base, stageCounts: stages, countPerObjective: stages.guided + stages.productive + stages.independent };
  // Wymagane typy po filtrze typów zagadnienia (jak w statusie); pusta grupa nie jest wymaganiem.
  const requiredTypes = (subject.agentPolicy.requiredTypes?.(objective) ?? [])
    .map((group) => group.filter((type) => objective.exerciseTypes.includes(type)))
    .filter((group) => group.length > 0);
  const minima = lessonPoolMinimums(subject);
  return {
    pool,
    objective: {
      id: objective.id,
      title: objective.titlePl,
      ...(objective.kind === undefined ? {} : { kind: objective.kind }),
      cards: objective.cards,
      examplesFromPlan: args.examplesFixed,
      index: state.objectives.findIndex((item) => item.id === objective.id),
      existingCount: orderedEntries(state).filter((entry) => entry.objectiveId === objective.id).length,
    },
    otherObjectives: state.objectives
      .filter((other) => other.id !== objective.id)
      .map((other) => ({ title: other.titlePl, ...(other.kind === undefined ? {} : { kind: other.kind }), cards: cardsText(other) })),
    cardSentences: [...new Set(Object.values(examples).flat())],
    targets: {
      ...stages,
      requiredTypes,
      ...limits,
      targetCount,
      ...(args.promptTargets === undefined ? {} : { listenAllowance: args.promptTargets.listenAllowance }),
      publicationMinima: {
        guided: minima.guided,
        productive: minima.productive,
        independent: minima.independent,
        // Różne pytania otwarte wymaga przedmiot z payloadem v3 (`distinctOpenAnswerGaps` pokrycia publikacji).
        ...(subject.usesV3Payload === true ? { distinctOpenAnswers: DISTINCT_OPEN_ANSWERS_PER_OBJECTIVE } : {}),
      },
    },
    maxSteps: args.maxSteps,
    callTimeoutMs: args.callTimeoutMs,
  };
}
