import type {
  LessonAgentPlanInput,
  LessonExerciseCheckerProvider,
  LessonObjectiveAgentInput,
  LessonObjectiveAgentTools,
  LessonPoolAgentProvider,
  LlmProvider,
  RunCostSink,
} from "../ports/ai";
import type { UsageRecorder } from "../ports/usage";
import { recordResponse } from "./usage/record-http";

/**
 * Deterministyczne fake'i agenta puli lekcji i checkera (etap 1 issue #237): sterowane scenariuszem,
 * bez sieci i modeli. Służą testom kierownika agenta i trybowi `UMIEM_FAKE_PROVIDERS=1` (etap 2a §5:
 * `fromLlm` + checker `unavailable`); nie są adapterem żadnej usługi. Nie znają identyfikatorów
 * przedmiotów — zagadnienia rozpoznają po slugu z identyfikatora celu.
 */

/** Krok scenariusza podagenta: jedno „wywołanie modelu” z narzędziami albo awarią. */
export type FakeAgentStep =
  | { submit: { exercises: unknown; examples?: unknown } }
  | { remove: string }
  | { parallel: FakeAgentStep[] }
  | { throw: Error }
  | { hang: true }
  /** Dostawca ignorujący przerwanie: krok nigdy się nie kończy, także po przerwaniu sygnału. */
  | { stall: true }
  /**
   * „Wywołanie w locie”: `onReached` sygnalizuje dojście do kroku, potem krok czeka na `gate`;
   * przerwanie sygnału odrzuca `signal.reason`. Koszt kroku jest zapisany przed czekaniem.
   */
  | { gate: Promise<void>; onReached?: () => void };

/** Krok wewnętrzny trybu `fromLlm`: jedno „wywołanie modelu” z wynikiem `generateLessonPool`. */
type FakeObjectiveStep = FakeAgentStep | { fromLlm: LlmProvider };

/** Scenariusz zagadnienia: jeden dla każdego wywołania albo `calls[i]` dla i-tego wywołania (ponowienia). */
export type FakeObjectiveScript = FakeAgentStep[] | { calls: FakeAgentStep[][] };

export interface FakeLessonPoolAgentOptions {
  /**
   * Scenariusze per zagadnienie; klucz = slug, czyli `objective.id.split(".").at(-1)`. Przy `calls`
   * wywołanie spoza listy nie ma kroków.
   */
  objectives?: Record<string, FakeObjectiveScript>;
  /** Kolejne propozycje planu przekazywane do `propose`. */
  plans?: unknown[];
  /** Koszt jednego kroku zapisywany w `RunCostSink`; brak = `null` (koszt nieznany). */
  stepCostUsd?: number | null;
  /**
   * Dziennik kosztów: jeden `recordResponse` na krok (jak adapter na żądanie HTTP), `provider`
   * `"openrouter"`, operacje `agent_objective` i `agent_plan`.
   */
  usage?: UsageRecorder;
  /**
   * Tryb „jak LLM” (tryb fake workera): zagadnienie bez scenariusza zgłasza w jednym kroku wynik
   * `generateLessonPool` dla swojego zagadnienia, a planer bez `plans` — deterministyczny plan z pokrycia
   * materiału ({@link fakePlanFromCoverage}).
   */
  fromLlm?: LlmProvider;
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

/**
 * `count` ciągłych, zrównoważonych kawałków listy po kolei (rozmiary różnią się najwyżej o 1, nadmiar
 * w pierwszych). Lista krótsza niż `count` (ale niepusta) — każdy kawałek dostaje jeden element po kolei
 * z powtórzeniem, więc żaden nie jest pusty; pusta lista daje puste kawałki.
 */
function chunks<T>(items: readonly T[], count: number): T[][] {
  if (items.length === 0) return Array.from({ length: count }, () => []);
  if (items.length < count) return Array.from({ length: count }, (_unused, index) => [items[index % items.length]!]);
  const base = Math.floor(items.length / count);
  const extra = items.length % count;
  let start = 0;
  return Array.from({ length: count }, (_unused, index) => {
    const size = base + (index < extra ? 1 : 0);
    const chunk = items.slice(start, start + size);
    start += size;
    return chunk;
  });
}

/** Nagłówki materiału (linie kończące się „:”), gdy przedmiot nie ma pokrycia planu; brak → niepuste linie. */
function materialHeadings(material: string): string[] {
  const lines = material.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "");
  const headings = lines.filter((line) => line.endsWith(":")).map((line) => line.slice(0, -1).trim()).filter((line) => line !== "");
  return headings.length > 0 ? headings : lines;
}

/**
 * Deterministyczny plan trybu `fromLlm`: trzy zagadnienia „Część 1/2/3”. Słowa pokrycia (gdy brak —
 * nagłówki materiału) dzielone po kolei i po równo na dwa zagadnienia `words`, ramy w trzecim `frame`; bez
 * ram trzecie też jest zagadnieniem słów. Przy mniejszej liczbie słów niż zagadnień słowa się powtarzają,
 * więc każda karta ma słowo materiału. Karta „Words”/„Frames” z listą pokrywa cały materiał (bramka planu),
 * druga karta to temat (plan wymaga 2–4 kart), a jedyny przykład to pierwsze słowo albo rama.
 */
export function fakePlanFromCoverage(input: LessonAgentPlanInput): { objectives: Record<string, unknown>[] } {
  const coverage = input.coverage ?? { words: materialHeadings(input.material), frames: [] };
  const fallback = input.topicTitle.trim() || "Lesson";
  const groups: { kind: "words" | "frame"; items: readonly string[] }[] =
    coverage.frames.length > 0
      ? [...chunks(coverage.words, 2).map((items) => ({ kind: "words" as const, items })), { kind: "frame", items: coverage.frames }]
      : chunks(coverage.words, 3).map((items) => ({ kind: "words" as const, items }));
  return {
    objectives: groups.map((group, index) => ({
      slug: `part_${index + 1}`,
      titlePl: `Część ${index + 1}`,
      descriptionEn: `Part ${index + 1} of ${fallback}.`,
      kind: group.kind,
      cards: [
        {
          title: group.kind === "words" ? "Words" : "Frames",
          body: group.items.length > 0 ? group.items.join(group.kind === "words" ? ", " : "\n") : fallback,
        },
        { title: "Topic", body: fallback },
      ],
      examples: [group.items[0] ?? fallback],
    })),
  };
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
  /** Liczba dotychczasowych wywołań `runObjective` per slug (wybór scenariusza z `calls`). */
  private readonly callCounts = new Map<string, number>();

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
    const script = this.scriptFor(slug) ?? (this.options.fromLlm ? [{ fromLlm: this.options.fromLlm }] : []);
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
        this.recordStep(cost, "agent_objective");
        steps += 1;
        await this.executeStep(step, tools, outcomes, signal, input);
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
    const plans = this.options.plans ?? (this.options.fromLlm ? [fakePlanFromCoverage(input)] : []);
    for (const plan of plans) {
      signal.throwIfAborted();
      if (steps >= input.maxSteps || tools.shouldStop()) break;
      this.recordStep(cost, "agent_plan");
      steps += 1;
      proposals.push(plan);
      await tools.propose(plan);
    }
    return { steps };
  }

  /** Scenariusz wywołania; `undefined` = zagadnienie bez scenariusza (wtedy `fromLlm` albo brak kroków). */
  private scriptFor(slug: string): FakeObjectiveStep[] | undefined {
    const script = this.options.objectives?.[slug];
    const call = this.callCounts.get(slug) ?? 0;
    this.callCounts.set(slug, call + 1);
    if (script === undefined) return undefined;
    return Array.isArray(script) ? script : (script.calls[call] ?? []);
  }

  /** Koszt „wywołania modelu”: licznik runu i dziennik kosztów z tego samego zdarzenia (jak adapter). */
  private recordStep(cost: RunCostSink, operation: "agent_objective" | "agent_plan"): void {
    const usd = this.options.stepCostUsd ?? null;
    cost.record(usd);
    recordResponse(
      this.options.usage,
      { feature: "lesson_generation", operation, provider: "openrouter", model: this.model },
      200,
      { usage: usd === null ? {} : { cost: usd } },
    );
  }

  private async executeStep(
    step: FakeObjectiveStep,
    tools: LessonObjectiveAgentTools,
    outcomes: unknown[],
    signal: AbortSignal,
    input: LessonObjectiveAgentInput,
  ): Promise<void> {
    signal.throwIfAborted();
    if ("fromLlm" in step) {
      // Wynik generatora potoku dla wejścia podagenta, zawężony do jego zagadnienia.
      const objective = input.objective;
      const res = await step.fromLlm.generateLessonPool(input.pool, signal);
      signal.throwIfAborted();
      const exercises = res.exercises.filter((exercise) => (exercise as { objectiveId?: unknown } | null)?.objectiveId === objective.id);
      const examples = objective.examplesFromPlan ? undefined : res.examples?.[objective.id];
      outcomes.push(await tools.submit({ exercises, ...(examples === undefined ? {} : { examples }) }));
    } else if ("submit" in step) {
      const raw = step.submit as Parameters<LessonObjectiveAgentTools["submit"]>[0];
      outcomes.push(await tools.submit(raw));
    } else if ("remove" in step) {
      outcomes.push(await tools.remove(step.remove));
    } else if ("parallel" in step) {
      // Wywołania startują synchronicznie jedno po drugim i nie czekają na siebie (AI SDK: Promise.all).
      await Promise.all(step.parallel.map((inner) => this.executeStep(inner, tools, outcomes, signal, input)));
    } else if ("throw" in step) {
      throw step.throw;
    } else if ("stall" in step) {
      await stalled();
    } else if ("gate" in step) {
      step.onReached?.();
      const abort = rejectOnAbort(signal);
      try {
        await Promise.race([step.gate, abort.promise]);
      } finally {
        abort.dispose();
      }
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
  /** Kontrola niedostępna (tryb fake workera): `solve` i `judgeVariants` dają `null` dla każdej pozycji. */
  unavailable?: true;
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
      if (this.options.unavailable) return { answers: input.items.map(() => null) };
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
      if (this.options.unavailable) return { equivalent: input.items.map(() => null) };
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
