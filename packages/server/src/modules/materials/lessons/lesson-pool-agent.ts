import { AppError } from "../../../errors";
import { removeExercise, type AgentCheckContext, type ObjectiveAgentLimits } from "../../../domain/lessons/agent/admission";
import { agentObjectivesOf, asAgentCapable, type AgentCapableSubject } from "../../../domain/lessons/agent/capable";
import { createLessonAgentState, orderedEntries, type LessonAgentState } from "../../../domain/lessons/agent/state";
import {
  lessonInvariantCheck,
  objectiveAgentLimits,
  objectiveStatus,
  objectiveStatusFor,
  stageGapOf,
  type ObjectiveStatus,
} from "../../../domain/lessons/agent/status";
import { cardExposureSources } from "../../../domain/lessons/card-exposure-sources";
import { outsideStagePath } from "../../../domain/lessons/stages";
import type { SubjectRegistry } from "../../../domain/lessons/registry";
import type {
  AgentObjective,
  DynamicObjectiveKind,
  DynamicTopicData,
  LessonExerciseDraft,
  LessonTopic,
} from "../../../domain/lessons/types";
import type { LessonExerciseCheckerProvider, LessonPoolAgentProvider, LlmLessonStageCounts, RunCostSink } from "../../../ports/ai";
import { AgentCheckRun, CHECK_COUNTER_KEYS, type AgentCheckGrader, type CheckCounterKey } from "./lesson-agent-check-run";
import { deadlineSignal, Semaphore, untilAborted } from "./lesson-agent-timers";
import { listenChoiceAllowance, mergeExamples, objectiveBatchCounts, poolStageCounts } from "./lesson-drafts";
import { objectiveAgentInput } from "./lesson-pool-agent-input";
import { planAgentObjectives } from "./lesson-pool-agent-plan";
import {
  agentFailureOf,
  DEFAULT_LESSON_AGENT_POLICY,
  OBJECTIVE_TIMEOUT_REASON,
  RUN_TIMEOUT_REASON,
  RunCostMeter,
  type AgentFailure,
  type LessonAgentPolicy,
  type RunBudgetSink,
} from "./lesson-pool-agent-policy";
import { createObjectiveTools, type ObjectiveToolsStats, type RejectionLogEntry } from "./lesson-pool-agent-tools";

/**
 * Kierownik agenta puli lekcji (spec etapu 1 §7, etapu 2a §6): rozwiązuje
 * zagadnienia (plan, katalog albo dane wejścia), woła hak planu, uruchamia
 * podagentów zagadnień równolegle na wspólnym stanie lekcji, zamyka każde
 * zagadnienie, woła hak zapisu szeregowo i kończy kontrolą końcową. Bez bazy i
 * bez identyfikatorów przedmiotów.
 */

export type { AgentFailure };

/** Źródło zagadnień — unia rozłączna (każdy wariant niesie swoje dane). */
export type AgentObjectiveSource =
  | { readonly source: "planner" }
  | { readonly source: "catalog"; readonly topic: LessonTopic }
  | { readonly source: "input"; readonly dynamicTopic: DynamicTopicData };

/**
 * Cel runu: `pool` (domyślnie) — pula wszystkich zagadnień; `add` — `count` nowych ćwiczeń jednego
 * zagadnienia (przycisk „Dogeneruj +N”, spec etapu 2a §6.4). `count` to liczba jeszcze brakujących nowych
 * ćwiczeń (wołający odejmuje nowe ćwiczenia z punktu kontrolnego).
 */
export type LessonPoolAgentTarget =
  | { readonly mode: "pool" }
  | { readonly mode: "add"; readonly objectiveId: string; readonly count: number };

export interface SettledObjective {
  readonly objectiveId: string;
  readonly status: "complete" | "incomplete" | "failed";
  readonly missing: readonly string[];
  /** Tylko przy `failed`: kod i ponawialność z `classifyLessonGenerationFailure`. */
  readonly failure?: AgentFailure;
  /** Przyjęte ćwiczenia puli zagadnienia w kolejności lekcji (bez `fixed`). */
  readonly exercises: readonly LessonExerciseDraft[];
  readonly examples: readonly string[];
  readonly steps: number;
  /** Wydatek runu w chwili rozliczenia (`cost.spentUsd`, zawiera już `initialSpentUsd`). */
  readonly spentUsd: number;
}

/** Wynik rozwiązania zagadnień dla haka planu (spec etapu 2a §6.1). */
export interface ResolvedObjectives {
  /** Temat planu (`planner`) albo temat wejścia (`input`); brak przy katalogu. */
  readonly dynamicTopic?: DynamicTopicData;
  /** Przykłady kart z planu; `{}` poza źródłem `planner`. */
  readonly planExamples: Readonly<Record<string, readonly string[]>>;
  readonly spentUsd: number;
}

export interface LessonPoolAgentRunInput {
  readonly runId: string;
  readonly subjectId: string;
  readonly deckId: string;
  readonly objectiveSource: AgentObjectiveSource;
  readonly topicTitle: string;
  readonly material: string;
  readonly instruction?: string;
  readonly interests?: readonly string[];
  readonly poolSize: number;
  readonly graderAvailable: boolean;
  readonly fixed: readonly LessonExerciseDraft[];
  readonly draftExamples: Readonly<Record<string, readonly string[]>>;
  /** Zagadnienia już zapisane: pomijane, ich ćwiczenia są w `fixed`. */
  readonly skipObjectives: readonly string[];
  readonly familyScope: string | null;
  readonly initialSpentUsd: number;
  /**
   * Przykłady kart wstawiane do stanu jak przykłady planu (liczą się do statusu i są źródłami
   * ujawnień), np. z punktu kontrolnego albo szkicu; przykłady planu wygrywają per zagadnienie.
   */
  readonly initialExamples?: Readonly<Record<string, readonly string[]>>;
  /** `true` = `submit` ignoruje przykłady (ustalone); brak = `objectiveSource.source === "planner"`. */
  readonly examplesFixed?: boolean;
  /** Stałe źródła ujawnień spoza zagadnień (np. zdania historyjki szkicu). */
  readonly extraExposureSources?: readonly string[];
  /** Brak = `{ mode: "pool" }`. W trybie `add` `skipObjectives` nie ma znaczenia: działa tylko `objectiveId`. */
  readonly target?: LessonPoolAgentTarget;
  /**
   * Wołany raz, po przyjęciu planu (`planner`) albo od razu po rozwiązaniu tematu (`catalog`/`input`),
   * przed podagentami; błąd przerywa run jak błąd `onObjectiveSettled`. Nie jest wołany przy `plan_failed`.
   */
  readonly onObjectivesResolved?: (resolved: ResolvedObjectives) => Promise<void>;
  /**
   * Wołany szeregowo, w kolejności zakończenia zagadnień; błąd przerywa run. Dostaje migawkę zagadnienia
   * sprzed kontroli końcowej (`lessonInvariantCheck`): usunięcia bezpiecznika widać dopiero w wyniku runu,
   * a uzgodnienie zapisanych zagadnień z tymi usunięciami należy do etapu 2.
   */
  readonly onObjectiveSettled?: (settled: SettledObjective) => Promise<void>;
}

/**
 * Statystyki runu. Od etapu 2b także liczniki kontroli (`CHECK_COUNTER_KEYS`, §7.4): sędzia podpowiedzi,
 * kontrola otwarta i grader (wywołania, pozycje bez wyniku, błędy i odrzucone werdykty).
 */
export type LessonPoolAgentStats = {
  submitted: number;
  accepted: number;
  rejectedByKind: Record<string, number>;
  checkUnavailable: number;
  checkerCalls: number;
  invariantViolations: number;
  refused: number;
} & Record<CheckCounterKey, number>;

export interface LessonPoolAgentResult {
  readonly planStatus: "accepted" | "plan_failed" | "not_needed";
  readonly planFailure?: AgentFailure;
  readonly dynamicTopic?: DynamicTopicData;
  /** Zagadnienia uruchomione w tym runie (bez pominiętych), w kolejności lekcji. */
  readonly objectives: readonly SettledObjective[];
  readonly stats: LessonPoolAgentStats;
  readonly rejections: readonly RejectionLogEntry[];
  readonly spentUsd: number;
  readonly unknownCostCalls: number;
}

export interface LessonPoolAgentDeps {
  readonly agent: LessonPoolAgentProvider;
  readonly checker: LessonExerciseCheckerProvider;
  /** Grader kontroli otwartej (etap 2b); brak = kontrola otwarta nie dotyczy. Strukturalnie `AgentGraderDeps`. */
  readonly grader?: AgentCheckGrader;
  readonly subjects: Pick<SubjectRegistry, "getSubject">;
  /** Brak pól = `DEFAULT_LESSON_AGENT_POLICY`. */
  readonly policy?: Partial<LessonAgentPolicy>;
}

/** Klucz stałych źródeł ujawnień spoza zagadnień (`extraExposureSources`) w `fixedSources` stanu. */
const EXTRA_SOURCES_KEY = "__extra";

function slugOf(objectiveId: string): string {
  return objectiveId.slice(objectiveId.lastIndexOf(".") + 1);
}

/** Zerowe statystyki runu (także wynik „bez kierownika” w `lesson-agent-generation.ts`). */
export function emptyLessonPoolAgentStats(): LessonPoolAgentStats {
  return {
    submitted: 0,
    accepted: 0,
    rejectedByKind: {},
    checkUnavailable: 0,
    checkerCalls: 0,
    invariantViolations: 0,
    refused: 0,
    ...Object.fromEntries(CHECK_COUNTER_KEYS.map((key) => [key, 0])),
  } as LessonPoolAgentStats;
}

/** Przedmiot z rejestru, zdolny do agenta i obsługujący źródło zagadnień; inaczej błąd walidacji bez wywołań. */
function resolveSubject(deps: LessonPoolAgentDeps, input: LessonPoolAgentRunInput): AgentCapableSubject {
  const subject = deps.subjects.getSubject(input.subjectId);
  if (subject === undefined) throw new AppError("validation", { message: `unknown subject ${input.subjectId}` });
  if (subject.agentPolicy === undefined) {
    throw new AppError("validation", { message: `subject ${subject.id} cannot be generated by the pool agent` });
  }
  if (input.objectiveSource.source !== "catalog" && subject.buildDynamicTopic === undefined) {
    throw new AppError("validation", { message: `subject ${subject.id} has no dynamic topics` });
  }
  const target = input.target;
  if (target?.mode === "add") {
    // Dogenerowanie dotyczy zagadnienia istniejącego szkicu: plan stworzyłby nowe zagadnienia.
    if (input.objectiveSource.source === "planner") {
      throw new AppError("validation", { message: "add mode needs catalog or input objectives, not a plan" });
    }
    if (!Number.isInteger(target.count) || target.count < 1) {
      throw new AppError("validation", { message: "add mode count must be a positive integer" });
    }
  }
  return asAgentCapable(subject);
}

/** Rodzaje zagadnień tematu dynamicznego (rozdział) do `agentObjectivesOf`. */
export function kindsOf(data: DynamicTopicData | undefined): Map<string, DynamicObjectiveKind> {
  const kinds = new Map<string, DynamicObjectiveKind>();
  for (const objective of data?.objectives ?? []) if (objective.kind !== undefined) kinds.set(objective.id, objective.kind);
  return kinds;
}

function formatCodes(codes: ReadonlyMap<string, number>): string {
  return codes.size === 0 ? "-" : [...codes].map(([code, count]) => `${code}:${count}`).join(",");
}

/** Przyjęte ćwiczenia puli zagadnienia w kolejności lekcji. */
function poolExercises(state: LessonAgentState, objectiveId: string): LessonExerciseDraft[] {
  return orderedEntries(state)
    .filter((entry) => entry.objectiveId === objectiveId && entry.id !== null)
    .map((entry) => entry.draft);
}

/** Limity przyjmowania i liczby promptu zagadnienia w trybie „dodaj N” (§6.4). */
interface AddModePlan {
  readonly limits: ObjectiveAgentLimits;
  readonly promptTargets: { readonly stages: LlmLessonStageCounts; readonly listenAllowance: number };
}

/**
 * Tryb „dodaj N” (§6.4), braki etapów ze statusu zagadnienia na starcie (`start`):
 * - limity: `targetCount` statusu = ćwiczenia zagadnienia w `fixed` na ścieżce etapów + `count`; dodatek
 *   słuchowy jako łączny limit (przyjmowanie samo liczy `fixed`); `maxExercises` = `count` + suma braków
 *   etapów + reszta dodatku słuchowego (`slack` 0; `limit_full` liczy tylko pulę);
 * - prompt: podział etapów = braki etapów + `count` rozłożone podziałem partii, bez podnoszenia etapu
 *   samodzielnego (`fixed` już się liczy), więc suma = `count` + braki ≤ `maxExercises`; dodatek słuchowy
 *   w prompcie = to, co jeszcze można przyjąć.
 */
function addModePlan(
  subject: AgentCapableSubject,
  objective: LessonTopic["objectives"][number],
  fixed: readonly LessonExerciseDraft[],
  count: number,
  start: ObjectiveStatus,
): AddModePlan {
  const own = fixed.filter((draft) => draft.objectiveId === objective.id);
  const fixedOnStagePath = own.filter((draft) => !outsideStagePath(draft.exerciseType)).length;
  const listenAllowance = listenChoiceAllowance(subject, objective, []);
  const listenLeft = Math.max(0, listenAllowance - own.filter((draft) => draft.exerciseType === "lesson_listen_choice").length);
  const split = poolStageCounts(subject, objective.exerciseTypes, count);
  const stages = {
    guided: start.stageGaps.guided + split.guided,
    productive: start.stageGaps.productive + split.productive,
    independent: start.stageGaps.independent + split.independent,
  };
  const stageGap = stageGapOf(start);
  return {
    limits: { targetCount: fixedOnStagePath + count, listenAllowance, maxExercises: count + stageGap + listenLeft },
    promptTargets: { stages, listenAllowance: listenLeft },
  };
}

/**
 * Limity zagadnień trybu „pula” z liczb partii potoku: `targetCount` z puli rodzica, dodatek słuchowy jako
 * łączny limit zagadnienia (przyjmowanie samo liczy ćwiczenia słuchowe `fixed`), `limit_full` liczy tylko
 * pulę. Wspólne z kontrolą końcową ścieżki agenta przed zapisem do szkicu.
 */
export function lessonAgentLimits(
  subject: AgentCapableSubject,
  topic: LessonTopic,
  poolSize: number,
): ReadonlyMap<string, ObjectiveAgentLimits> {
  const counts = objectiveBatchCounts(poolSize, topic.objectives.length, subject);
  return new Map(
    topic.objectives.map((objective, index) => [
      objective.id,
      objectiveAgentLimits(
        { targetCount: counts[index]!, listenAllowance: listenChoiceAllowance(subject, objective, []) },
        subject.agentPolicy,
      ),
    ]),
  );
}

export async function runLessonPoolAgent(
  deps: LessonPoolAgentDeps,
  input: LessonPoolAgentRunInput,
  signal: AbortSignal,
): Promise<LessonPoolAgentResult> {
  const subject = resolveSubject(deps, input);
  signal.throwIfAborted();
  const policy: LessonAgentPolicy = { ...DEFAULT_LESSON_AGENT_POLICY, ...deps.policy };
  const cost = new RunCostMeter(input.initialSpentUsd, policy.runBudgetUsd, policy.unknownCallEstimateUsd);
  const runDeadline = deadlineSignal(signal, policy.runTimeoutMs, RUN_TIMEOUT_REASON);
  try {
    const source = input.objectiveSource;
    let topic: LessonTopic;
    let dynamicTopic: DynamicTopicData | undefined;
    let planExamples: Readonly<Record<string, readonly string[]>> = {};
    if (source.source === "planner") {
      const planStartUsd = cost.spentUsd;
      const plan = await planAgentObjectives({
        agent: deps.agent,
        subject,
        deckId: input.deckId,
        topicTitle: input.topicTitle,
        material: input.material,
        ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
        cost,
        maxSteps: policy.planMaxSteps,
        signal: runDeadline.signal,
      });
      if (signal.aborted) throw signal.reason;
      console.log(
        `[lesson-agent] run=${input.runId} plan status=${plan.status}${plan.status === "plan_failed" ? ` error=${plan.failure.errorCode}` : ""} steps=${plan.steps} costUsd=${(cost.spentUsd - planStartUsd).toFixed(4)}`,
      );
      if (plan.status === "plan_failed") {
        return {
          planStatus: "plan_failed",
          planFailure: plan.failure,
          objectives: [],
          stats: emptyLessonPoolAgentStats(),
          rejections: [],
          spentUsd: cost.spentUsd,
          unknownCostCalls: cost.unknownCalls,
        };
      }
      dynamicTopic = plan.dynamicTopic;
      planExamples = plan.examples;
      topic = subject.buildDynamicTopic!(plan.dynamicTopic);
    } else if (source.source === "catalog") {
      topic = source.topic;
    } else {
      topic = subject.buildDynamicTopic!(source.dynamicTopic);
    }
    const resolvedTopic = dynamicTopic ?? (source.source === "input" ? source.dynamicTopic : undefined);
    const target = input.target;
    if (target?.mode === "add" && !topic.objectives.some((objective) => objective.id === target.objectiveId)) {
      // Przed hakiem planu i podagentami: nieznane zagadnienie nie zapisuje nic i nie woła dostawcy.
      throw new AppError("validation", { message: `unknown objective ${target.objectiveId}` });
    }
    if (input.onObjectivesResolved !== undefined) {
      // Przed podagentami: ścieżka zapisuje temat, przykłady planu i wydatek (punkt kontrolny).
      await input.onObjectivesResolved({
        ...(resolvedTopic === undefined ? {} : { dynamicTopic: resolvedTopic }),
        planExamples,
        spentUsd: cost.spentUsd,
      });
      if (signal.aborted) throw signal.reason;
    }
    const objectives = agentObjectivesOf(topic, kindsOf(resolvedTopic));
    const result = await superviseObjectives({
      deps,
      input,
      subject,
      topic,
      objectives,
      planExamples,
      policy,
      cost,
      runSignal: signal,
      runDeadline: runDeadline.signal,
    });
    return {
      planStatus: source.source === "planner" ? "accepted" : "not_needed",
      ...(dynamicTopic === undefined ? {} : { dynamicTopic }),
      ...result,
      spentUsd: cost.spentUsd,
      unknownCostCalls: cost.unknownCalls,
    };
  } finally {
    runDeadline.dispose();
  }
}

interface SuperviseArgs {
  readonly deps: LessonPoolAgentDeps;
  readonly input: LessonPoolAgentRunInput;
  readonly subject: AgentCapableSubject;
  readonly topic: LessonTopic;
  readonly objectives: readonly AgentObjective[];
  readonly planExamples: Readonly<Record<string, readonly string[]>>;
  readonly policy: LessonAgentPolicy;
  readonly cost: RunCostMeter;
  readonly runSignal: AbortSignal;
  /** Sygnał runu z terminem runu. */
  readonly runDeadline: AbortSignal;
}

/** Liczniki zagadnienia do logu (bez treści). */
interface ObjectiveTrack {
  accepted: number;
  readonly rejected: Map<string, number>;
  costUsd: number;
  requests: number;
}

/** Podagenci zagadnień, zamknięcie, hak zapisu i kontrola końcowa (§7.1 pkt 3–7). */
async function superviseObjectives(args: SuperviseArgs): Promise<Pick<LessonPoolAgentResult, "objectives" | "stats" | "rejections">> {
  const { deps, input, subject, topic, objectives, policy, cost } = args;
  const examplesFixed = input.examplesFixed ?? input.objectiveSource.source === "planner";

  const limits = new Map(lessonAgentLimits(subject, topic, input.poolSize));
  const ctx: AgentCheckContext = { subject, material: input.material, limits };
  const addTarget = input.target?.mode === "add" ? input.target : undefined;
  const addMode = addTarget === undefined ? undefined : { remaining: addTarget.count };

  const extraSources = input.extraExposureSources ?? [];
  let state = createLessonAgentState({
    topic,
    objectives,
    fixed: input.fixed,
    // Przykłady planu wygrywają z początkowymi per zagadnienie.
    examples: { ...input.initialExamples, ...args.planExamples },
    fixedSources: mergeExamples(
      mergeExamples(cardExposureSources(subject, topic), input.draftExamples),
      extraSources.length === 0 ? {} : { [EXTRA_SOURCES_KEY]: extraSources },
    ),
  });
  // Tryb „dodaj N”: braki etapów na starcie (nie zależą od `targetCount`, więc wystarczą limity puli w ctx),
  // potem limity zagadnienia ustawiane raz.
  let promptTargets: AddModePlan["promptTargets"] | undefined;
  if (addTarget !== undefined) {
    const objective = topic.objectives.find((item) => item.id === addTarget.objectiveId)!;
    const start = objectiveStatus(state, addTarget.objectiveId, ctx);
    const plan = addModePlan(subject, objective, input.fixed, addTarget.count, start);
    limits.set(addTarget.objectiveId, plan.limits);
    promptTargets = plan.promptTargets;
  }
  const getState = () => state;
  const setState = (next: LessonAgentState) => {
    state = next;
  };

  const stats = emptyLessonPoolAgentStats();
  const rejections: RejectionLogEntry[] = [];
  const checkerSemaphore = new Semaphore(policy.checkerConcurrency);
  // Wspólne dla runu: semafor gradera, pamięć wyników kontroli i wyłącznik gradera (etap 2b).
  const checkRun = new AgentCheckRun(policy);
  const objectiveSemaphore = new Semaphore(policy.concurrency);

  // Błąd haka (albo kierownika) przerywa wszystkie zagadnienia przez wspólny sygnał.
  const failing = new AbortController();
  let failure: { readonly error: unknown } | undefined;
  const active = new Set<{ close(): Promise<void> }>();
  const fail = (error: unknown): void => {
    if (failure !== undefined) return;
    failure = { error };
    failing.abort(error);
    for (const handle of active) void handle.close();
  };
  const stopped = () => failure !== undefined || args.runSignal.aborted;
  const objectivesParent = AbortSignal.any([args.runDeadline, failing.signal]);

  const settledById = new Map<string, SettledObjective>();
  let hooks: Promise<void> = Promise.resolve();
  const enqueueHook = (settled: SettledObjective): void => {
    const hook = input.onObjectiveSettled;
    if (hook === undefined) return;
    // Kolejka szeregowa w kolejności zakończenia; nie wstrzymuje startu kolejnych podagentów.
    hooks = hooks.then(async () => {
      if (stopped()) return;
      try {
        await hook(settled);
      } catch (error) {
        fail(error);
      }
    });
  };

  const addStats = (track: ObjectiveTrack) => (delta: Partial<ObjectiveToolsStats>) => {
    stats.submitted += delta.submitted ?? 0;
    stats.accepted += delta.accepted ?? 0;
    stats.checkerCalls += delta.checkerCalls ?? 0;
    stats.checkUnavailable += delta.checkUnavailable ?? 0;
    for (const key of CHECK_COUNTER_KEYS) stats[key] += delta[key] ?? 0;
    track.accepted += delta.accepted ?? 0;
  };

  /** Nakładka licznika runu: koszt zagadnienia do logu, budżet wspólny. */
  const objectiveCost = (track: ObjectiveTrack): RunBudgetSink => ({
    record: (usd) => {
      const before = cost.spentUsd;
      cost.record(usd);
      track.costUsd += cost.spentUsd - before;
    },
    exhausted: () => cost.exhausted(),
  });

  const settle = (objective: AgentObjective, steps: number, error: { readonly error: unknown } | undefined): SettledObjective => {
    const status = objectiveStatusFor(state, objective.id, ctx, addMode);
    const base = {
      objectiveId: objective.id,
      missing: status.missing,
      exercises: poolExercises(state, objective.id),
      examples: [...(state.examples.get(objective.id) ?? [])],
      steps,
      spentUsd: cost.spentUsd,
    };
    if (error !== undefined) return { ...base, status: "failed", failure: agentFailureOf(error.error) };
    return { ...base, status: status.complete ? "complete" : "incomplete" };
  };

  const runOne = async (objective: AgentObjective): Promise<void> => {
    if (stopped()) return;
    // Termin zagadnienia liczy się od faktycznego startu podagenta (po miejscu w semaforze).
    const deadline = deadlineSignal(objectivesParent, policy.objectiveTimeoutMs, OBJECTIVE_TIMEOUT_REASON);
    try {
      const settled = await superviseObjective(objective, deadline.signal);
      enqueueHook(settled);
    } finally {
      // Zegar i nasłuch terminu zdejmowane także przy błędzie budowy narzędzi albo wejścia.
      deadline.dispose();
    }
  };

  const superviseObjective = async (objective: AgentObjective, objectiveSignal: AbortSignal): Promise<SettledObjective> => {
    const track: ObjectiveTrack = { accepted: 0, rejected: new Map(), costUsd: 0, requests: 0 };
    const budget = objectiveCost(track);
    const agentCost: RunCostSink = {
      record: (usd) => {
        track.requests += 1;
        budget.record(usd);
      },
    };
    // Wejście budowane przed narzędziami i poza obsługą błędów dostawcy: błąd kodu (np. w budowaniu
    // promptu) odrzuca run, zamiast oznaczać zagadnienie jako `failed`. Zagadnienie, którego termin
    // (np. runu) minął albo budżet runu wyczerpał się przed startem, nie woła dostawcy i jest
    // rozliczane jak po terminie (`incomplete`).
    const agentInput =
      objectiveSignal.aborted || cost.exhausted()
        ? undefined
        : objectiveAgentInput({
            subject,
            topic,
            state,
            objective,
            limits: limits.get(objective.id)!,
            material: input.material,
            ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
            ...(input.interests === undefined ? {} : { interests: input.interests }),
            graderAvailable: input.graderAvailable,
            examplesFixed,
            maxSteps: policy.maxStepsPerObjective,
            ...(promptTargets === undefined ? {} : { promptTargets }),
          });
    const handle = createObjectiveTools({
      objectiveId: objective.id,
      getState,
      setState,
      ctx,
      checker: deps.checker,
      checkerSemaphore,
      checkRun,
      ...(deps.grader === undefined ? {} : { grader: deps.grader }),
      cost: budget,
      objectiveSignal,
      policy,
      familyScope: input.familyScope,
      examplesFixed,
      ...(addMode === undefined ? {} : { addMode }),
      onRejection: (entry) => {
        rejections.push(entry);
        stats.rejectedByKind[entry.kind] = (stats.rejectedByKind[entry.kind] ?? 0) + 1;
        track.rejected.set(entry.code, (track.rejected.get(entry.code) ?? 0) + 1);
      },
      onRefusal: () => {
        stats.refused += 1;
      },
      onStats: addStats(track),
      // Wyłącznik otwiera się raz na run (`AgentCheckRun.recordGraderFailure`), więc log jest jednorazowy.
      onGraderBreaker: () => {
        console.log(`[lesson-agent] run=${input.runId} grader_unavailable`);
      },
    });
    active.add(handle);
    let steps = 0;
    let providerError: { readonly error: unknown } | undefined;
    try {
      if (agentInput !== undefined) {
        // Wyścig z sygnałem zagadnienia: dostawca ignorujący przerwanie nie wstrzymuje terminu ani runu.
        steps = (await untilAborted(deps.agent.runObjective(agentInput, handle.tools, agentCost, objectiveSignal), objectiveSignal)).steps;
      }
    } catch (error) {
      // `failed` tylko dla wyjątku dostawcy przy nieprzerwanym sygnale zagadnienia; termin → `incomplete`.
      // Sygnał sprawdzany TERAZ, przed `close()`: przerwanie w trakcie zamykania nie zmienia klasyfikacji.
      if (!objectiveSignal.aborted) providerError = { error };
      // Kroki przerwanego wywołania nie wracają z dostawcy: liczba jego żądań to najlepsze przybliżenie.
      steps = track.requests;
    } finally {
      // Zamknięcie od razu po powrocie: spóźnione wywołania narzędzi kończą się odmową bez przyjęcia.
      // `close()` czeka na trwające wywołanie narzędzia; jego checker przerywa zamknięcie (wyścig w `callChecker`).
      await handle.close();
      active.delete(handle);
    }
    const settled = settle(objective, steps, providerError);
    settledById.set(objective.id, settled);
    console.log(
      `[lesson-agent] run=${input.runId} obj=${slugOf(objective.id)} status=${settled.status}${settled.failure === undefined ? "" : ` error=${settled.failure.errorCode}`} steps=${steps} accepted=${track.accepted} rejected=${formatCodes(track.rejected)} costUsd=${track.costUsd.toFixed(4)}`,
    );
    return settled;
  };

  const skipped = new Set(input.skipObjectives);
  const toRun = objectives.filter((objective) =>
    addTarget === undefined ? !skipped.has(objective.id) : objective.id === addTarget.objectiveId,
  );
  await Promise.all(toRun.map((objective) => objectiveSemaphore.run(() => runOne(objective)).catch(fail)));
  await hooks;
  if (failure !== undefined) throw failure.error;
  if (args.runSignal.aborted) throw args.runSignal.reason;

  // Kontrola końcowa: bezpiecznik niezmiennika przyjmowania — usunięcia bez rund naprawczych.
  const violations = lessonInvariantCheck(state, ctx);
  for (const violation of violations) {
    state = removeExercise(state, violation.objectiveId, violation.id, ctx).state;
    console.log(`[lesson-agent] run=${input.runId} obj=${slugOf(violation.objectiveId)} invariant_violation id=${violation.id}`);
  }
  stats.invariantViolations = violations.length;

  const finalObjectives = toRun.flatMap((objective) => {
    const settled = settledById.get(objective.id);
    if (settled === undefined) return [];
    if (violations.length === 0) return [settled];
    const status = objectiveStatusFor(state, objective.id, ctx, addMode);
    return [
      {
        ...settled,
        exercises: poolExercises(state, objective.id),
        missing: status.missing,
        ...(settled.status === "failed" ? {} : { status: status.complete ? ("complete" as const) : ("incomplete" as const) }),
      },
    ];
  });
  return { objectives: finalObjectives, stats, rejections };
}
