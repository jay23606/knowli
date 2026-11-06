import type {
  HintVerdict,
  LessonAgentPlanInput,
  LessonExerciseCheckerProvider,
  LessonObjectiveAgentInput,
  LessonObjectiveAgentTools,
  LessonPoolAgentProvider,
  RunCostSink,
} from "../ports/ai";
import type { UsageRecorder } from "../ports/usage";
import { FAKE_SLOW_DELAY_MS, FAKE_SLOW_MARKER, fakeObjectiveExercises } from "./fake-lesson-pool";
import { recordResponse } from "./usage/record-http";

/**
 * Deterministyczne fake'i agenta puli lekcji i checkera (etap 1 issue #237): sterowane scenariuszem,
 * bez sieci i modeli. Służą testom kierownika agenta i trybowi `UMIEM_FAKE_PROVIDERS=1` (etap 3 PR 2
 * §5.2: pętla generatora `generate` + checker `unavailable`); nie są adapterem żadnej usługi.
 * Scenariusze rozpoznają zagadnienia po slugu z identyfikatora celu.
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
  | { gate: Promise<void>; onReached?: () => void }
  /** Jedno zgłoszenie generatora ({@link fakeObjectiveExercises}) z bieżącym przesunięciem zagadnienia (+100 na krok). */
  | { generate: true }
  /** Zgłoszenie zbudowane z wejścia podagenta w czasie kroku (identyfikatory zagadnień szkoły i rozdziału zawierają `deckId`). */
  | { build: (input: LessonObjectiveAgentInput) => { exercises: unknown[]; examples?: unknown } };

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
   * Pętla generatora (spec etapu 3 §5.2): zagadnienie bez scenariusza zgłasza {@link fakeObjectiveExercises}
   * i dokłada kroki tylko dla braków z wyniku narzędzia (do `maxSteps`); planer bez `plans` — plan
   * z pokrycia. `delayMs` opóźnia każdy krok, a `FAKE_SLOW_MARKER` w materiale — pierwszy krok
   * zagadnienia do co najmniej `FAKE_SLOW_DELAY_MS`; sen przerywa sygnał.
   */
  generate?: { delayMs?: number };
  /** Zapis historii `calls` i `planCalls` (domyślnie `true`); proces workera wyłącza go, żeby nie rosła. */
  record?: boolean;
}

type PlanTools = Parameters<LessonPoolAgentProvider["planObjectives"]>[1];
type SubmitInput = Parameters<LessonObjectiveAgentTools["submit"]>[0];
type FakeStage = "guided" | "productive" | "independent";

/** Odstęp numeracji kolejnych kroków generatora w zagadnieniu. */
const GENERATOR_STEP_OFFSET = 100;

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

/** Sen przerywany sygnałem: przerwanie odrzuca `signal.reason`, a timer i nasłuch są zdejmowane zawsze. */
async function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  const abort = rejectOnAbort(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
      abort.promise,
    ]);
  } finally {
    clearTimeout(timer);
    abort.dispose();
  }
}

/**
 * Przesunięcie numeracji pierwszego kroku zagadnienia: `index · 1000` w puli bez ćwiczeń zagadnienia,
 * a przy istniejących (szkic przy „+N”, przyjęte z punktu kontrolnego) osobne pasmo
 * `index · 1000 + 500 + existingCount · 2`. Kolizje z numerami szkicu po usunięciach rodzica naprawia
 * kolejny krok pętli.
 */
function startOffset(input: LessonObjectiveAgentInput): number {
  const { index, existingCount } = input.objective;
  return existingCount > 0 ? index * 1000 + 500 + existingCount * 2 : index * 1000;
}

/** Zamówienie kolejnego kroku pętli generatora. */
interface GeneratorRequest {
  readonly counts: Record<FakeStage, number>;
  readonly required: readonly (readonly string[])[];
  /** Ponowne przykłady kart (brak „card examples” w wyniku). */
  readonly examples: boolean;
}

const STAGES: readonly FakeStage[] = ["guided", "productive", "independent"];

const STAGE_GAP = /^(guided|productive|independent): (\d+) of (\d+)$/u;
const NEW_EXERCISES = /^new exercises: (\d+) of (\d+)$/u;
const DISTINCT_OPEN = /^distinct open answers: (\d+) of (\d+)$/u;
const EXERCISES = /^exercises: (\d+) of (\d+)$/u;
const NEEDS_TYPE = /^needs at least one (.+)$/u;

/** `b − a` z dopasowania `"… a of b"` (grupy 1 i 2). */
function shortfall(match: RegExpExecArray): number {
  return Math.max(0, Number(match[2]) - Number(match[1]));
}

/**
 * Kolejny krok z braków wyniku narzędzia (`objectiveStatus`): `"<etap>: a of b"` → `b − a` ćwiczeń etapu,
 * `"distinct open answers: a of b"` → tyle samodzielnych więcej, `"exercises: a of b"` → reszta braku
 * jako wspomagane, `"needs at least one …"` → po jednym ćwiczeniu typu, `"card examples"` → przykłady.
 * W „+N” `"new exercises: k of N"` → `N − k` rozłożone po równo na etapy z braków (żaden — samodzielny),
 * co najmniej braki etapów; `"exercises"` wtedy pomijany. Brak rozpoznanego braku → `undefined` (koniec).
 */
function nextGeneratorRequest(missing: readonly string[]): GeneratorRequest | undefined {
  const counts: Record<FakeStage, number> = { guided: 0, productive: 0, independent: 0 };
  const listed = new Set<FakeStage>();
  const required: string[][] = [];
  let remaining: number | undefined;
  let total = 0;
  let examples = false;
  for (const line of missing) {
    const stage = STAGE_GAP.exec(line);
    const added = NEW_EXERCISES.exec(line);
    const distinct = DISTINCT_OPEN.exec(line);
    const exercises = EXERCISES.exec(line);
    const needs = NEEDS_TYPE.exec(line);
    if (stage !== null) {
      const name = stage[1] as FakeStage;
      counts[name] += Math.max(0, Number(stage[3]) - Number(stage[2]));
      listed.add(name);
    } else if (added !== null) remaining = shortfall(added);
    else if (distinct !== null) counts.independent += shortfall(distinct);
    else if (exercises !== null) total = shortfall(exercises);
    else if (needs !== null) required.push(needs[1]!.split(" or "));
    else if (line.startsWith("card examples:")) examples = true;
  }
  const sum = () => counts.guided + counts.productive + counts.independent;
  if (remaining !== undefined) {
    const stages = listed.size > 0 ? STAGES.filter((stage) => listed.has(stage)) : (["independent"] as const);
    const extra = Math.max(0, remaining - sum());
    stages.forEach((stage, position) => {
      counts[stage] += Math.floor(extra / stages.length) + (position < extra % stages.length ? 1 : 0);
    });
  } else {
    counts.guided += Math.max(0, total - sum());
  }
  if (sum() === 0 && required.length === 0 && !examples) return undefined;
  return { counts, required, examples };
}

/** Odpowiedzi zgłoszonych ćwiczeń: kolejne kroki unikają ich jak zdań lekcji (`avoidSentences`). */
function answersOf(exercises: readonly unknown[]): string[] {
  return exercises.flatMap((exercise) => {
    const answer = (exercise as { answer?: unknown } | null)?.answer;
    return typeof answer === "string" ? [answer] : [];
  });
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
 * Deterministyczny plan generatora (`generate`): trzy zagadnienia „Część 1/2/3”. Słowa pokrycia (gdy brak —
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
    const scripted = this.scriptFor(slug);
    const outcomes: unknown[] = [];
    if (this.options.record !== false) this.calls.push({ objectiveId: input.objective.id, input, tools, outcomes });
    if (scripted === undefined && this.options.generate !== undefined) {
      return this.meter.track(() => this.runGenerator(input, tools, cost, signal, outcomes));
    }
    const script = scripted ?? [];
    const progress = { generated: 0 };
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
        await this.executeStep(step, tools, outcomes, signal, input, progress);
      }
      return { steps, stopReason: "model_finished" as const };
    });
  }

  /**
   * Pętla generatora: krok 1 z liczbami `pool.stageCounts` (wymagane typy i dodatek słuchowy), kolejne
   * tylko dla braków z wyniku `submit` ({@link nextGeneratorRequest}), z przesunięciem +100 i odpowiedziami
   * wcześniejszych kroków w `avoidSentences`. Koniec: `complete`, brak rozpoznanego braku (`model_finished`),
   * `maxSteps` albo `shouldStop()`. Koszt kroku zapisany po „odpowiedzi” (po śnie), przed narzędziem.
   */
  private async runGenerator(
    input: LessonObjectiveAgentInput,
    tools: LessonObjectiveAgentTools,
    cost: RunCostSink,
    signal: AbortSignal,
    outcomes: unknown[],
  ): Promise<{ steps: number; stopReason: "stopped" | "max_steps" | "model_finished" }> {
    let steps = 0;
    let offset = startOffset(input);
    let request: GeneratorRequest | undefined;
    let stepInput = input;
    for (;;) {
      signal.throwIfAborted();
      if (steps >= input.maxSteps) return { steps, stopReason: "max_steps" };
      if (tools.shouldStop()) return { steps, stopReason: "stopped" };
      await this.pause(input, steps === 0, signal);
      this.recordStep(cost, "agent_objective");
      steps += 1;
      const generated = fakeObjectiveExercises(stepInput, offset, request?.counts, request?.required);
      const examples = request === undefined || request.examples ? generated.examples : undefined;
      signal.throwIfAborted();
      const outcome = await tools.submit({ exercises: generated.exercises, ...(examples === undefined ? {} : { examples }) });
      outcomes.push(outcome);
      if (outcome.complete) return { steps, stopReason: "model_finished" };
      request = nextGeneratorRequest(outcome.missing);
      if (request === undefined) return { steps, stopReason: "model_finished" };
      offset += GENERATOR_STEP_OFFSET;
      const pool = stepInput.pool;
      stepInput = { ...stepInput, pool: { ...pool, avoidSentences: [...(pool.avoidSentences ?? []), ...answersOf(generated.exercises)] } };
    }
  }

  /** Opóźnienie kroku generatora: `delayMs`, a pierwszy krok materiału z `FAKE_SLOW_MARKER` co najmniej `FAKE_SLOW_DELAY_MS`. */
  private async pause(input: LessonObjectiveAgentInput, first: boolean, signal: AbortSignal): Promise<void> {
    const base = this.options.generate?.delayMs ?? 0;
    const ms = first && input.pool.material.includes(FAKE_SLOW_MARKER) ? Math.max(base, FAKE_SLOW_DELAY_MS) : base;
    if (ms > 0) await sleepUnlessAborted(ms, signal);
  }

  async planObjectives(
    input: LessonAgentPlanInput,
    tools: PlanTools,
    cost: RunCostSink,
    signal: AbortSignal,
  ): Promise<{ steps: number }> {
    const proposals: unknown[] = [];
    if (this.options.record !== false) this.planCalls.push({ input, proposals });
    let steps = 0;
    const plans = this.options.plans ?? (this.options.generate !== undefined ? [fakePlanFromCoverage(input)] : []);
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

  /** Scenariusz wywołania; `undefined` = zagadnienie bez scenariusza (wtedy generator albo brak kroków). */
  private scriptFor(slug: string): FakeAgentStep[] | undefined {
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
    step: FakeAgentStep,
    tools: LessonObjectiveAgentTools,
    outcomes: unknown[],
    signal: AbortSignal,
    input: LessonObjectiveAgentInput,
    progress: { generated: number },
  ): Promise<void> {
    signal.throwIfAborted();
    if ("generate" in step) {
      const first = progress.generated === 0;
      const offset = startOffset(input) + GENERATOR_STEP_OFFSET * progress.generated;
      progress.generated += 1;
      await this.pause(input, first, signal);
      const generated = fakeObjectiveExercises(input, offset);
      signal.throwIfAborted();
      outcomes.push(await tools.submit(generated));
    } else if ("build" in step) {
      outcomes.push(await tools.submit(step.build(input) as SubmitInput));
    } else if ("submit" in step) {
      const raw = step.submit as SubmitInput;
      outcomes.push(await tools.submit(raw));
    } else if ("remove" in step) {
      outcomes.push(await tools.remove(step.remove));
    } else if ("parallel" in step) {
      // Wywołania startują synchronicznie jedno po drugim i nie czekają na siebie (AI SDK: Promise.all).
      await Promise.all(step.parallel.map((inner) => this.executeStep(inner, tools, outcomes, signal, input, progress)));
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
type HintInput = Parameters<LessonExerciseCheckerProvider["judgeHints"]>[0];
type OpenInput = Parameters<LessonExerciseCheckerProvider["solveOpen"]>[0];

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
  /** Werdykt sędziego podpowiedzi dla pozycji (null = niesprawdzone); domyślnie `{ verdict: "ok" }`. */
  judgeHint?: (item: HintInput["items"][number]) => HintVerdict | null;
  /** Tryb awarii całej paczki `judgeHints` (`undefined` = liczy `judgeHint` per pozycja); jak `solveBatch`. */
  hintBatch?: (items: HintInput["items"]) => (HintVerdict | null)[] | "throw" | "hang" | "stall" | undefined;
  /** Dwie odpowiedzi rozwiązującego otwarte dla widoku (null = brak wyniku); domyślnie `["A", "B"]`. */
  solveOpen?: (view: string) => readonly [string, string] | null;
  /** Tryb awarii całej paczki `solveOpen` (`undefined` = liczy `solveOpen` per pozycja). */
  openBatch?: (items: OpenInput["items"]) => ((readonly [string, string]) | null)[] | "throw" | "hang" | "stall" | undefined;
  /** Koszt jednego wywołania; domyślnie 0, `null` = nieznany. */
  costUsd?: number | null;
  /** Wywołania czekają na tę obietnicę (testy równoległości); przerwanie sygnału przerywa oczekiwanie. */
  gate?: Promise<void>;
  /** Kontrola niedostępna (tryb fake workera): wszystkie metody dają `null` dla każdej pozycji. */
  unavailable?: true;
}

export class FakeExerciseChecker implements LessonExerciseCheckerProvider {
  readonly name = "fake-lesson-checker";
  readonly model = "fake-lesson-checker-model";
  readonly solveCalls: SolveInput[] = [];
  readonly judgeCalls: JudgeInput[] = [];
  readonly hintCalls: HintInput[] = [];
  readonly openCalls: OpenInput[] = [];
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

  judgeHints(input: HintInput, cost: RunCostSink, signal: AbortSignal): Promise<{ verdicts: (HintVerdict | null)[] }> {
    this.hintCalls.push(input);
    return this.meter.track(async () => {
      await this.admit(cost, signal);
      if (this.options.unavailable) return { verdicts: input.items.map(() => null) };
      const batch = this.options.hintBatch?.(input.items);
      if (batch === "throw") throw new Error("fake checker: judgeHints failed");
      if (batch === "hang") return rejectOnAbort(signal).promise;
      if (batch === "stall") return stalled();
      if (batch) return { verdicts: batch };
      const judge = this.options.judgeHint ?? (() => ({ verdict: "ok" }) as const);
      return { verdicts: input.items.map((item) => judge(item)) };
    });
  }

  solveOpen(input: OpenInput, cost: RunCostSink, signal: AbortSignal): Promise<{ answers: ((readonly [string, string]) | null)[] }> {
    this.openCalls.push(input);
    return this.meter.track(async () => {
      await this.admit(cost, signal);
      if (this.options.unavailable) return { answers: input.items.map(() => null) };
      const batch = this.options.openBatch?.(input.items);
      if (batch === "throw") throw new Error("fake checker: solveOpen failed");
      if (batch === "hang") return rejectOnAbort(signal).promise;
      if (batch === "stall") return stalled();
      if (batch) return { answers: batch };
      const solve = this.options.solveOpen ?? (() => ["A", "B"] as const);
      return { answers: input.items.map((item) => solve(item.view)) };
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
