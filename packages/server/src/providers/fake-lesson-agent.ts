import type {
  LessonAgentPlanInput,
  LessonExerciseCheckerProvider,
  LessonObjectiveAgentInput,
  LessonObjectiveAgentTools,
  LessonPoolAgentProvider,
  RunCostSink,
} from "../ports/ai";

/**
 * Deterministyczne fake'i agenta puli lekcji i checkera (etap 1 issue #237): sterowane scenariuszem,
 * bez sieci i modeli. Służą testom kierownika agenta; nie są adapterem żadnej usługi. Nie znają
 * identyfikatorów przedmiotów — zagadnienia rozpoznają po slugu z identyfikatora celu.
 */

/** Krok scenariusza podagenta: jedno „wywołanie modelu” z narzędziami albo awarią. */
export type FakeAgentStep =
  | { submit: { exercises: unknown; examples?: unknown } }
  | { remove: string }
  | { parallel: FakeAgentStep[] }
  | { throw: Error }
  | { hang: true }
  /** Dostawca ignorujący przerwanie: krok nigdy się nie kończy, także po przerwaniu sygnału. */
  | { stall: true };

export interface FakeLessonPoolAgentOptions {
  /** Scenariusze per zagadnienie; klucz = slug, czyli `objective.id.split(".").at(-1)`. */
  objectives?: Record<string, FakeAgentStep[]>;
  /** Kolejne propozycje planu przekazywane do `propose`. */
  plans?: unknown[];
  /** Koszt jednego kroku zapisywany w `RunCostSink`; brak = `null` (koszt nieznany). */
  stepCostUsd?: number | null;
}

type PlanTools = Parameters<LessonPoolAgentProvider["planObjectives"]>[1];

/**
 * Czeka na przerwanie sygnału i odrzuca `signal.reason`; przerwany wcześniej odrzuca od razu.
 * `dispose` zdejmuje nasłuch, więc wyścig z innym zdarzeniem nie zostawia listenerów na wspólnym sygnale.
 */
function rejectOnAbort(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    dispose: () => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    },
  };
}

/** Obietnica, która nigdy się nie rozstrzyga (dostawca ignorujący `signal`). */
function stalled(): Promise<never> {
  return new Promise<never>(() => undefined);
}

/** Śledzi największą liczbę jednocześnie trwających wywołań. */
class ConcurrencyMeter {
  private active = 0;
  max = 0;

  async track<T>(run: () => Promise<T>): Promise<T> {
    this.active += 1;
    this.max = Math.max(this.max, this.active);
    try {
      return await run();
    } finally {
      this.active -= 1;
    }
  }
}

export class FakeLessonPoolAgent implements LessonPoolAgentProvider {
  readonly name = "fake-lesson-agent";
  readonly model = "fake-lesson-agent-model";
  /**
   * Zapis wywołań `runObjective`. Przy kroku `parallel` `outcomes` są w kolejności ZAKOŃCZENIA narzędzi,
   * nie startu. Wynik wywołania: `model_finished`, gdy scenariusz się skończył; `max_steps`, gdy limit
   * kroków wejścia zostanie osiągnięty przed końcem scenariusza; `stopped` po `shouldStop()`.
   * Przerwany `signal` (sprawdzany przed każdym krokiem i przed narzędziami) odrzuca `signal.reason`.
   */
  readonly calls: {
    objectiveId: string;
    input: LessonObjectiveAgentInput;
    tools: LessonObjectiveAgentTools;
    outcomes: unknown[];
  }[] = [];
  readonly planCalls: { input: LessonAgentPlanInput; proposals: unknown[] }[] = [];
  private readonly meter = new ConcurrencyMeter();

  constructor(private readonly options: FakeLessonPoolAgentOptions = {}) {}

  /** Największa liczba jednocześnie trwających wywołań `runObjective`. */
  get maxConcurrent(): number {
    return this.meter.max;
  }

  runObjective(
    input: LessonObjectiveAgentInput,
    tools: LessonObjectiveAgentTools,
    cost: RunCostSink,
    signal: AbortSignal,
  ): Promise<{ steps: number; stopReason: "stopped" | "max_steps" | "model_finished" }> {
    const slug = input.objective.id.split(".").at(-1) ?? input.objective.id;
    const script = this.options.objectives?.[slug] ?? [];
    const outcomes: unknown[] = [];
    this.calls.push({ objectiveId: input.objective.id, input, tools, outcomes });
    return this.meter.track(async () => {
      let steps = 0;
      for (const step of script) {
        signal.throwIfAborted();
        if (steps >= input.maxSteps) return { steps, stopReason: "max_steps" as const };
        if (tools.shouldStop()) return { steps, stopReason: "stopped" as const };
        // „Wywołanie modelu”: koszt odpowiedzi jest zapisany przed narzędziami, więc przerwanie w trakcie
        // narzędzi go nie gubi (jak onLanguageModelCallEnd w AI SDK).
        cost.record(this.options.stepCostUsd ?? null);
        steps += 1;
        await this.executeStep(step, tools, outcomes, signal);
      }
      return { steps, stopReason: "model_finished" as const };
    });
  }

  async planObjectives(
    input: LessonAgentPlanInput,
    tools: PlanTools,
    cost: RunCostSink,
    signal: AbortSignal,
  ): Promise<{ steps: number }> {
    const proposals: unknown[] = [];
    this.planCalls.push({ input, proposals });
    let steps = 0;
    for (const plan of this.options.plans ?? []) {
      signal.throwIfAborted();
      if (steps >= input.maxSteps || tools.shouldStop()) break;
      cost.record(this.options.stepCostUsd ?? null);
      steps += 1;
      proposals.push(plan);
      await tools.propose(plan);
    }
    return { steps };
  }

  private async executeStep(
    step: FakeAgentStep,
    tools: LessonObjectiveAgentTools,
    outcomes: unknown[],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if ("submit" in step) {
      const raw = step.submit as Parameters<LessonObjectiveAgentTools["submit"]>[0];
      outcomes.push(await tools.submit(raw));
    } else if ("remove" in step) {
      outcomes.push(await tools.remove(step.remove));
    } else if ("parallel" in step) {
      // Wywołania startują synchronicznie jedno po drugim i nie czekają na siebie (AI SDK: Promise.all).
      await Promise.all(step.parallel.map((inner) => this.executeStep(inner, tools, outcomes, signal)));
    } else if ("throw" in step) {
      throw step.throw;
    } else if ("stall" in step) {
      await stalled();
    } else {
      await rejectOnAbort(signal).promise;
    }
  }
}

type SolveInput = Parameters<LessonExerciseCheckerProvider["solve"]>[0];
type JudgeInput = Parameters<LessonExerciseCheckerProvider["judgeVariants"]>[0];

export interface FakeExerciseCheckerOptions {
  /** `view → odpowiedzi` (null = brak wyniku); domyślnie pusta lista, czyli rozjazd. */
  solve?: (view: string) => string[] | null;
  /**
   * Wynik całej paczki zamiast `solve` per pozycja; `"throw"` rzuca, `"hang"` czeka na przerwanie,
   * `"stall"` nigdy się nie kończy (dostawca ignorujący przerwanie).
   */
  solveBatch?: (items: readonly { view: string }[]) => (string[] | null)[] | "throw" | "hang" | "stall";
  /** Werdykt dla jednego wariantu (null = brak wyniku pozycji); domyślnie `true`. */
  judge?: (variant: string) => boolean | null;
  judgeBatch?: (items: readonly unknown[]) => (boolean[] | null)[] | "throw" | "hang" | "stall";
  /** Koszt jednego wywołania; domyślnie 0, `null` = nieznany. */
  costUsd?: number | null;
  /** Wywołania czekają na tę obietnicę (testy równoległości); przerwanie sygnału przerywa oczekiwanie. */
  gate?: Promise<void>;
}

export class FakeExerciseChecker implements LessonExerciseCheckerProvider {
  readonly name = "fake-lesson-checker";
  readonly model = "fake-lesson-checker-model";
  readonly solveCalls: SolveInput[] = [];
  readonly judgeCalls: JudgeInput[] = [];
  private readonly meter = new ConcurrencyMeter();

  constructor(private readonly options: FakeExerciseCheckerOptions = {}) {}

  /** Największa liczba jednocześnie trwających wywołań `solve` i `judgeVariants` razem. */
  get maxConcurrent(): number {
    return this.meter.max;
  }

  solve(input: SolveInput, cost: RunCostSink, signal: AbortSignal): Promise<{ answers: (string[] | null)[] }> {
    this.solveCalls.push(input);
    return this.meter.track(async () => {
      await this.admit(cost, signal);
      const batch = this.options.solveBatch?.(input.items);
      if (batch === "throw") throw new Error("fake checker: solve failed");
      if (batch === "hang") return rejectOnAbort(signal).promise;
      if (batch === "stall") return stalled();
      if (batch) return { answers: batch };
      const solve = this.options.solve ?? (() => []);
      return { answers: input.items.map((item) => solve(item.view)) };
    });
  }

  judgeVariants(input: JudgeInput, cost: RunCostSink, signal: AbortSignal): Promise<{ equivalent: (boolean[] | null)[] }> {
    this.judgeCalls.push(input);
    return this.meter.track(async () => {
      await this.admit(cost, signal);
      const batch = this.options.judgeBatch?.(input.items);
      if (batch === "throw") throw new Error("fake checker: judgeVariants failed");
      if (batch === "hang") return rejectOnAbort(signal).promise;
      if (batch === "stall") return stalled();
      if (batch) return { equivalent: batch };
      const judge = this.options.judge ?? (() => true);
      return {
        equivalent: input.items.map((item) => {
          const verdicts = item.variants.map((variant) => judge(variant));
          return verdicts.every((verdict): verdict is boolean => verdict !== null) ? verdicts : null;
        }),
      };
    });
  }

  /** Czeka na `gate` (z przerwaniem), potem zapisuje koszt żądania — także gdy wynik będzie wyjątkiem. */
  private async admit(cost: RunCostSink, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.options.gate) {
      const abort = rejectOnAbort(signal);
      try {
        await Promise.race([this.options.gate, abort.promise]);
      } finally {
        abort.dispose();
      }
    }
    cost.record(this.options.costUsd === undefined ? 0 : this.options.costUsd);
  }
}
