import type { AgentHintVerdict, OpenCheckOutcome, OpenGraded } from "../../../domain/lessons/agent/admission";
import type { SchoolVerdict } from "../../../domain/lessons/evaluate";
import type { SchoolCriteria } from "../../../domain/lessons/types";
import type { AnswerGraderProvider } from "../../../ports/ai";
import { Semaphore } from "./lesson-agent-timers";
import type { LessonAgentPolicy } from "./lesson-pool-agent-policy";

/**
 * Stan kontroli modelem wspólny dla całego runu agenta puli (etap 2b §6.3, §7.2,
 * §7.4): semafor gradera, pamięć wyników `done` i wyłącznik awarii gradera.
 * Żyje wyłącznie w pamięci procesu (nie w bazie ani w punkcie kontrolnym).
 */

/**
 * Grader kontroli otwartej (strukturalnie `AgentGraderDeps` z `config.ts`; moduł nie importuje
 * konfiguracji): dostawca i termin jednego wywołania.
 */
export interface AgentCheckGrader {
  readonly provider: AnswerGraderProvider;
  readonly timeoutMs: number;
}

/**
 * Liczniki kontroli etapu 2b (§7.4) widoczne w statystykach runu, punkcie kontrolnym i podsumowaniu:
 * wyłącznie liczby, bez treści. Klucze = pola `ObjectiveToolsStats`.
 */
export const CHECK_COUNTER_KEYS = [
  "hintChecks",
  "openChecks",
  "graderCalls",
  "hintUnavailable",
  "openUnavailable",
  "graderErrors",
  "graderInvalidVerdicts",
] as const;

export type CheckCounterKey = (typeof CHECK_COUNTER_KEYS)[number];

export class AgentCheckRun {
  /** Osobny od checkera: grader to inna usługa i nie czeka za długimi wywołaniami etapu 1. */
  readonly graderSemaphore: Semaphore;
  /** Werdykty sędziego podpowiedzi po `hintKey`. */
  readonly hintMemo = new Map<string, AgentHintVerdict>();
  /** Wyniki kontroli otwartej po `openKey` (podpowiedź nie wchodzi do klucza). */
  readonly openMemo = new Map<string, OpenCheckOutcome>();
  private consecutiveFailures = 0;
  private open = false;

  constructor(private readonly policy: LessonAgentPolicy) {
    this.graderSemaphore = new Semaphore(policy.graderConcurrency);
  }

  /** Otwarty wyłącznik: kontrola otwarta nie dotyczy do końca runu. */
  graderOpen(): boolean {
    return this.open;
  }

  recordGraderSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /** `true` = wyłącznik otworzył się właśnie przy tej porażce (log `grader_unavailable` raz na run). */
  recordGraderFailure(): boolean {
    if (this.open) return false;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < this.policy.graderBreakerThreshold) return false;
    this.open = true;
    return true;
  }
}

/** Odcisk werdyktu podpowiedzi: stabilny `JSON.stringify` tablicy pól (granice pól się nie sklejają). */
export function hintKey(view: string, answer: string, requiredElements: readonly string[], hint: string): string {
  return JSON.stringify([view, answer, requiredElements, hint]);
}

/**
 * Odcisk kontroli otwartej; kryteria w stałym porządku pól, brak kryteriów = `null`. Cel i typ
 * wchodzą do klucza, bo wejście gradera zależy od celu (tytuł, polecenie), nie tylko od widoku.
 */
export function openKey(
  scope: { readonly objectiveId: string; readonly exerciseType: string },
  view: string,
  answer: string,
  acceptedAnswers: readonly string[],
  criteria: SchoolCriteria | undefined,
): string {
  const fields =
    criteria === undefined
      ? null
      : [
          criteria.requiredElements.map((element) => [element.id, element.text]),
          criteria.supplementaryElements,
          criteria.commonErrors ?? [],
          criteria.expectedForm ?? null,
          criteria.sourceQuotes,
        ];
  return JSON.stringify([scope.objectiveId, scope.exerciseType, view, answer, acceptedAnswers, fields]);
}

const HINT_FAILURES = new Set(["unsupported", "language", "reveals"]);

/** Kształt werdyktu sędziego z adaptera (zły kształt pozycji = `unavailable`). */
export function isHintVerdict(value: unknown): value is AgentHintVerdict {
  if (value === null || typeof value !== "object") return false;
  const { verdict, reason } = value as { verdict?: unknown; reason?: unknown };
  if (verdict === "ok") return true;
  return typeof verdict === "string" && HINT_FAILURES.has(verdict) && typeof reason === "string";
}

/** Para odpowiedzi rozwiązującego otwarte (dwa teksty). */
export function isOpenPair(value: unknown): value is readonly [string, string] {
  return Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === "string");
}

/** Wynik odpowiedzi dopasowanej deterministycznie do klucza (bez gradera). */
export function matchedGraded(answer: string): OpenGraded {
  return { answer, knowledge: "correct", missing: [], wrong: [] };
}

/**
 * Wynik odpowiedzi z ważnego werdyktu gradera: braki jako teksty elementów wymaganych, błędy jako
 * błędne stwierdzenia i pomylone pojęcia („said → meant”).
 */
export function gradedFromVerdict(answer: string, verdict: SchoolVerdict, criteria: SchoolCriteria): OpenGraded {
  const textOf = (id: string) => criteria.requiredElements.find((element) => element.id === id)?.text ?? id;
  return {
    answer,
    knowledge: verdict.knowledge,
    missing: verdict.missingElementIds.map(textOf),
    wrong: [...verdict.incorrectStatements, ...verdict.confusedConcepts.map((pair) => `${pair.said} → ${pair.meant}`)],
  };
}
