import { AppError } from "../../../errors";
import { AGENT_PLAN_MAX_OBJECTIVES, AGENT_PLAN_MIN_OBJECTIVES, validateAgentPlan } from "../../../domain/lessons/agent/plan";
import { MAX_TEXT_LENGTH } from "../../../domain/lessons/pool-validation";
import { validateDynamicTopicData } from "../../../domain/lessons/topic-resolution";
import type { DynamicTopicData, RawPlanObjective, SubjectModule } from "../../../domain/lessons/types";
import type { LessonAgentPlanInput, LessonPoolAgentProvider, RunCostSink } from "../../../ports/ai";
import { buildDynamicTopicData, withSubjectObjectiveKinds } from "./lesson-drafts";
import { untilAborted } from "./lesson-agent-timers";
import { agentFailureOf, type AgentFailure, type RunBudgetSink } from "./lesson-pool-agent-policy";

/**
 * Plan zagadnień kierownika agenta puli (spec etapu 1 §7.1 pkt 2): planista
 * proponuje zagadnienia, a `propose` składa temat wspólną ścieżką tematów dynamicznych
 * (`validateAgentPlan` → `buildDynamicTopicData` → `withSubjectObjectiveKinds` →
 * `validateDynamicTopicData`). Błędy wracają do modelu; pierwsza poprawna
 * propozycja wygrywa.
 */

export interface PlanArgs {
  readonly agent: LessonPoolAgentProvider;
  readonly subject: SubjectModule;
  readonly deckId: string;
  readonly topicTitle: string;
  readonly material: string;
  readonly instruction?: string;
  readonly cost: RunBudgetSink;
  readonly maxSteps: number;
  readonly signal: AbortSignal;
}

export type PlanOutcome =
  | {
      readonly status: "accepted";
      readonly dynamicTopic: DynamicTopicData;
      /** Przykłady kart z planu: identyfikator zagadnienia tematu → linie. */
      readonly examples: Readonly<Record<string, readonly string[]>>;
      readonly steps: number;
    }
  | { readonly status: "plan_failed"; readonly failure: AgentFailure; readonly steps: number };

/** Górna granica przykładów zagadnienia (pilnuje jej `validateAgentPlan`); tu tylko w tekście dla modelu. */
const MAX_PLAN_EXAMPLES = 3;

/** Brak przyjętej propozycji po wszystkich krokach: ten sam kod (`validation`) co niepoprawne zagadnienia etapu zagadnień. */
const NOT_ACCEPTED_FAILURE = agentFailureOf(new AppError("validation"));

/** Linie przykładów planu: przycięte, niepuste, najwyżej `MAX_TEXT_LENGTH` znaków (limit tekstów lekcji). */
function planExampleLines(objective: RawPlanObjective): string[] {
  return objective.examples
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.length <= MAX_TEXT_LENGTH);
}

export async function planAgentObjectives(args: PlanArgs): Promise<PlanOutcome> {
  const { subject, topicTitle, material } = args;
  let accepted: { dynamicTopic: DynamicTopicData; examples: Record<string, string[]> } | undefined;
  let requests = 0;
  const cost: RunCostSink = {
    record: (usd) => {
      requests += 1;
      args.cost.record(usd);
    },
  };

  const propose = async (raw: unknown): Promise<{ ok: boolean; errors: string[] }> => {
    if (accepted !== undefined) return { ok: false, errors: ["a plan was already accepted"] };
    const plan = validateAgentPlan(raw, subject, material);
    if (!plan.ok) return { ok: false, errors: plan.errors };
    // Przy przykładach z planu `submit` ich nie przyjmuje, a status wymaga 1–3: zagadnienie bez przykładu
    // nigdy nie byłoby kompletne, więc taka propozycja wraca do modelu.
    const lines = plan.objectives.map(planExampleLines);
    const exampleErrors = lines.flatMap((list, index) =>
      list.length === 0 ? [`objective ${index + 1}: needs 1-${MAX_PLAN_EXAMPLES} card examples (non-empty, at most ${MAX_TEXT_LENGTH} characters)`] : [],
    );
    if (exampleErrors.length > 0) return { ok: false, errors: exampleErrors };
    const built = buildDynamicTopicData(
      plan.objectives,
      subject.id,
      args.deckId,
      topicTitle,
      (objective) => validateDynamicTopicData(subject, { titlePl: topicTitle, objectives: [objective] }),
      subject.ttsForPrompts === true,
    );
    // Odrzucone pojedyncze zagadnienie zmieniłoby pokrycie planu: cała propozycja wraca do modelu.
    if (built.data === undefined || built.errors.length > 0) return { ok: false, errors: built.errors };
    const data = withSubjectObjectiveKinds(subject, built.data);
    const topicErrors = validateDynamicTopicData(subject, data);
    if (topicErrors.length > 0) return { ok: false, errors: topicErrors };
    // Przykłady po INDEKSIE: `buildDynamicTopicData` zachowuje kolejność, a odrzucenie całej propozycji przy
    // porzuconym zagadnieniu gwarantuje parę 1:1 (slug tematu po sanityzacji może się różnić od surowego).
    const examples: Record<string, string[]> = {};
    data.objectives.forEach((objective, index) => {
      examples[objective.id] = lines[index]!;
    });
    accepted = { dynamicTopic: data, examples };
    return { ok: true, errors: [] };
  };

  const input: LessonAgentPlanInput = {
    subjectTitle: subject.titlePl,
    topicTitle,
    material,
    ...(args.instruction === undefined ? {} : { instruction: args.instruction }),
    generationRole: subject.prompts.generationRole,
    ...(subject.prompts.objectivesRules === undefined ? {} : { objectivesRules: subject.prompts.objectivesRules }),
    objectiveCount: { min: AGENT_PLAN_MIN_OBJECTIVES, max: AGENT_PLAN_MAX_OBJECTIVES },
    ...(subject.agentPolicy.planCoverage === undefined ? {} : { coverage: subject.agentPolicy.planCoverage(material) }),
    maxSteps: args.maxSteps,
  };

  let steps: number;
  try {
    // Wyścig z sygnałem: planista ignorujący przerwanie nie wstrzyma runu po terminie.
    steps = (
      await untilAborted(
        args.agent.planObjectives(
          input,
          { propose, shouldStop: () => accepted !== undefined || args.cost.exhausted() || args.signal.aborted },
          cost,
          args.signal,
        ),
        args.signal,
      )
    ).steps;
  } catch (error) {
    // Przyjęty plan przed wyjątkiem (np. termin po ostatnim kroku) nadal obowiązuje. Przerwanie terminem
    // (powód `deadlineSignal`) to `provider_timeout` bez ponowienia (`agentFailureOf`).
    if (accepted === undefined) return { status: "plan_failed", failure: agentFailureOf(error), steps: requests };
    steps = requests;
  }
  if (accepted === undefined) return { status: "plan_failed", failure: NOT_ACCEPTED_FAILURE, steps };
  return { status: "accepted", dynamicTopic: accepted.dynamicTopic, examples: accepted.examples, steps };
}
