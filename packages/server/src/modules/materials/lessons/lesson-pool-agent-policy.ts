import type { RunCostSink } from "../../../ports/ai";
import { GenerationProviderError } from "../../../ports/generation-error";
import { classifyLessonGenerationFailure } from "./lesson-generation-errors";
import { DEFAULT_LESSON_GENERATION_POLICY } from "./lesson-generation-policy";

/**
 * Polityka kierownika agenta puli lekcji (spec etapu 1 §7): kroki, równoległość,
 * terminy i budżet runu. Wartości domyślne w kodzie; konfiguracja z env od etapu 2.
 */
export interface LessonAgentPolicy {
  readonly maxStepsPerObjective: number;
  readonly planMaxSteps: number;
  /** Najwyżej tylu podagentów naraz. */
  readonly concurrency: number;
  /** Miejsca semafora checkera: jedno na wywołanie `solve` albo `judgeVariants`. */
  readonly checkerConcurrency: number;
  readonly checkerTimeoutMs: number;
  /** Limit jednego żądania modelu generatora i planisty; po przekroczeniu jedno ponowienie kroku. */
  readonly callTimeoutMs: number;
  /** Liczony od faktycznego startu podagenta. */
  readonly objectiveTimeoutMs: number;
  /** Agent nie trwa dłużej niż kontroler runu (`withLessonGenerationControl`). */
  readonly runTimeoutMs: number;
  /** Budżet wyczerpany przy wydatku ≥ `runBudgetUsd`. */
  readonly runBudgetUsd: number;
  /** Szacunek kosztu żądania o nieznanym koszcie (`record(null)`). */
  readonly unknownCallEstimateUsd: number;
  /** Miejsca osobnego semafora gradera kontroli otwartej (etap 2b §7.2); bez env. */
  readonly graderConcurrency: number;
  /** Limit etapu 2 paczki (grader) liczony od startu etapu; po nim pozycje niesprawdzone. */
  readonly graderStageTimeoutMs: number;
  /** Szacunek kosztu wywołania gradera o nieznanym koszcie (zamiast `unknownCallEstimateUsd`). */
  readonly unknownGraderCallEstimateUsd: number;
  /** Wyłącznik gradera po tylu kolejnych porażkach (błąd, termin, werdykt odrzucony walidacją). */
  readonly graderBreakerThreshold: number;
}

export const DEFAULT_LESSON_AGENT_POLICY: LessonAgentPolicy = {
  maxStepsPerObjective: 8,
  planMaxSteps: 8,
  concurrency: 4,
  checkerConcurrency: 4,
  checkerTimeoutMs: 90_000,
  callTimeoutMs: 90_000,
  objectiveTimeoutMs: 300_000,
  runTimeoutMs: DEFAULT_LESSON_GENERATION_POLICY.runTimeoutMs,
  runBudgetUsd: 1,
  unknownCallEstimateUsd: 0.02,
  graderConcurrency: 4,
  graderStageTimeoutMs: 30_000,
  unknownGraderCallEstimateUsd: 0.002,
  graderBreakerThreshold: 3,
};

/** Powody przerwania terminem runu i zagadnienia (`deadlineSignal`). */
export const RUN_TIMEOUT_REASON = "run_timeout";
export const OBJECTIVE_TIMEOUT_REASON = "objective_timeout";

/** Porażka planu albo zagadnienia: kod i ponawialność z klasyfikacji błędów generacji (`classifyLessonGenerationFailure`). */
export interface AgentFailure {
  readonly errorCode: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

/**
 * Klasyfikacja porażki agenta przez `classifyLessonGenerationFailure`; przerwanie terminem runu albo
 * zagadnienia (powód z `deadlineSignal`, nie wyjątek dostawcy) to `provider_timeout` bez ponowienia.
 */
export function agentFailureOf(error: unknown): AgentFailure {
  if (error === RUN_TIMEOUT_REASON || error === OBJECTIVE_TIMEOUT_REASON) {
    return { errorCode: classifyLessonGenerationFailure(new GenerationProviderError("timeout")).errorCode, retryable: false };
  }
  const { errorCode, retryable, retryAfterMs } = classifyLessonGenerationFailure(error);
  return { errorCode, retryable, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

/** Licznik kosztu z odczytem wyczerpania budżetu (narzędzia podagenta zgłaszają koszt checkera i sprawdzają budżet). */
export interface RunBudgetSink extends RunCostSink {
  exhausted(): boolean;
}

/**
 * Licznik wydatku runu (§7.3): `initialSpentUsd` + zgłoszenia adapterów; koszt
 * nieznany (`null` albo wartość nieskończona/ujemna) liczony szacunkiem.
 */
export class RunCostMeter implements RunBudgetSink {
  private spent: number;
  private unknown = 0;

  constructor(
    initialSpentUsd: number,
    private readonly budgetUsd: number,
    private readonly unknownEstimateUsd: number,
  ) {
    this.spent = initialSpentUsd;
  }

  get spentUsd(): number {
    return this.spent;
  }

  get unknownCalls(): number {
    return this.unknown;
  }

  record(usd: number | null): void {
    if (usd === null || !Number.isFinite(usd) || usd < 0) {
      this.unknown += 1;
      this.spent += this.unknownEstimateUsd;
      return;
    }
    this.spent += usd;
  }

  exhausted(): boolean {
    return this.spent >= this.budgetUsd;
  }
}
