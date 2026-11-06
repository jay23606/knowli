import type { LessonObjectiveAgentTools, LessonPoolAgentProvider } from "../../packages/server/src/ports/ai";

/**
 * Jedno ćwiczenie wysłane przez agenta puli w `submit` i odpowiedź walidacji, którą model dostał
 * z powrotem (`accepted` albo `errors`). Zawiera treść ćwiczenia — wyłącznie do pliku wyników próby
 * poza repozytorium, nigdy na konsolę.
 */
export type AgentSubmission = {
  readonly objective: string;
  /** Numer wywołania `submit` w zagadnieniu (od 1). */
  readonly call: number;
  readonly index: number;
  readonly exerciseType: string | null;
  readonly exercise: unknown;
} & ({ readonly accepted: string; readonly note?: string } | { readonly errors: readonly string[] });

const slugOf = (objectiveId: string) => objectiveId.split(".").at(-1) ?? objectiveId;

/**
 * Agent puli, który zapisuje do `log` każde wysłane ćwiczenie z wynikiem narzędzia (próba
 * `chapter-generation.probe.test.ts`: przyczyny odrzuceń nie trafiają do punktu kontrolnego ani
 * dziennika). Wynik narzędzia i pozostałe narzędzia przechodzą bez zmian.
 */
export function recordingAgent(agent: LessonPoolAgentProvider, log: AgentSubmission[]): LessonPoolAgentProvider {
  return {
    name: agent.name,
    model: agent.model,
    planObjectives: (input, tools, cost, signal) => agent.planObjectives(input, tools, cost, signal),
    runObjective: (input, tools, cost, signal) => {
      const objective = slugOf(input.objective.id);
      let call = 0;
      const recorded: LessonObjectiveAgentTools = {
        submit: async (raw) => {
          call += 1;
          const current = call;
          const outcome = await tools.submit(raw);
          for (const result of outcome.results) {
            const exercise = raw.exercises[result.index];
            const exerciseType =
              exercise !== null && typeof exercise === "object" && typeof (exercise as { exerciseType?: unknown }).exerciseType === "string"
                ? (exercise as { exerciseType: string }).exerciseType
                : null;
            log.push("accepted" in result
              ? { objective, call: current, index: result.index, exerciseType, accepted: result.accepted, ...(result.note === undefined ? {} : { note: result.note }), exercise }
              : { objective, call: current, index: result.index, exerciseType, errors: result.errors, exercise });
          }
          return outcome;
        },
        remove: (id) => tools.remove(id),
        shouldStop: () => tools.shouldStop(),
      };
      return agent.runObjective(input, recorded, cost, signal);
    },
  };
}
