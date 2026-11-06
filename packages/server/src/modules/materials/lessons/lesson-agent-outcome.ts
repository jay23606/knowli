import { messages } from "@learning/contracts";
import { AppError } from "../../../errors";
import { outsideStagePath } from "../../../domain/lessons/stages";
import type { DynamicTopicData, LessonExerciseDraft, LessonTopic, SubjectModule } from "../../../domain/lessons/types";
import type { LessonAgentObjectiveProgress, LessonAgentProgress } from "./lesson-agent-checkpoint";
import { CHECK_COUNTER_KEYS } from "./lesson-agent-check-run";
import type { LessonGenerationGap, LessonRunInput } from "./lesson-drafts";
import { CLEANUP_COUNTER_KEYS, type AgentObjectiveSource, type LessonPoolAgentResult, type LessonPoolAgentRunInput } from "./lesson-pool-agent";

export type { LessonGenerationGap };

/**
 * Funkcje czyste ścieżki agenta w `executeLessonGeneration` (spec etapu 2a §3,
 * §7.1, §8.3, §9, §11): wejście kierownika z punktu kontrolnego,
 * scalenie próby z postępem, wynik próby i luki generowania. Bez bazy, czasu i
 * identyfikatorów przedmiotów.
 */

/**
 * Linia logu startu runu (etap 2b §7.4), bez treści: `hintJudge` — przedmiot ma niepustą listę typów sędziego
 * podpowiedzi; `openCheck` — niepusta lista typów kontroli otwartej i worker ma grader (`hasGrader`).
 */
export function agentCheckStartLine(runId: string, subject: SubjectModule, hasGrader: boolean): string {
  const policy = subject.agentPolicy;
  const hintJudge = (policy.hintJudgeTypes?.length ?? 0) > 0;
  const openCheck = (policy.openAnswerCheckTypes?.length ?? 0) > 0 && hasGrader;
  return `[lesson-agent] run=${runId} hintJudge=${hintJudge ? "on" : "off"} openCheck=${openCheck ? "on" : "off"}`;
}

/** Nowe ćwiczenia liczone jak `counts.total` statusu: typy na ścieżce etapów, bez słów kluczowych i słuchowych. */
function stageExerciseCount(drafts: readonly LessonExerciseDraft[]): number {
  return drafts.filter((draft) => !outsideStagePath(draft.exerciseType)).length;
}

/** Wpisy `complete` punktu kontrolnego w kolejności lekcji; zagadnienia spoza lekcji pominięte. */
function completeEntries(progress: LessonAgentProgress | undefined, objectiveOrder: readonly string[]): [string, LessonAgentObjectiveProgress][] {
  return objectiveOrder.flatMap((objectiveId): [string, LessonAgentObjectiveProgress][] => {
    const entry = progress?.objectives[objectiveId];
    return entry?.status === "complete" ? [[objectiveId, entry]] : [];
  });
}

/** Zagadnienia źródła w kolejności lekcji; planer jeszcze ich nie zna. */
function objectiveOrderOf(source: AgentObjectiveSource): string[] {
  if (source.source === "catalog") return source.topic.objectives.map((objective) => objective.id);
  if (source.source === "input") return source.dynamicTopic.objectives.map((objective) => objective.id);
  return [];
}

function hasPlanExamples(progress: LessonAgentProgress | undefined): boolean {
  return progress?.planExamples !== undefined && Object.keys(progress.planExamples).length > 0;
}

export type LessonAgentRunInputArgs = {
  readonly runId: string;
  readonly attempts: number;
  readonly expectedEditNumber: number;
  /** Losowy identyfikator tej próby (UUID) — początek `familyScope`. */
  readonly attemptNonce: string;
  readonly subject: SubjectModule;
  readonly input: LessonRunInput;
  /** `services.generation.graderAvailable` (nie ma go we wpisie runu). */
  readonly graderAvailable: boolean;
  readonly progress: LessonAgentProgress | undefined;
  /** Szkic wersji: ćwiczenia w kolejności lekcji, przykłady i temat z `lesson_context`, zdania historyjki. */
  readonly draft: {
    readonly exercises: readonly LessonExerciseDraft[];
    readonly examples: Readonly<Record<string, string[]>>;
    readonly dynamicTopic?: DynamicTopicData;
    readonly storySentences?: readonly string[];
  };
  /** `resolveLessonTopic` dla tematu katalogowego. */
  readonly catalogTopic?: LessonTopic;
  /** Wynik etapu zagadnień (szkoła), gdy policzony w tej próbie. */
  readonly schoolTopic?: DynamicTopicData;
};

export type LessonAgentRunInputResult =
  | Omit<LessonPoolAgentRunInput, "onObjectivesResolved" | "onObjectiveSettled">
  /** Przedmiot dynamiczny bez planera i bez tematu: wołający liczy etap zagadnień i woła ponownie ze `schoolTopic`. */
  | { readonly needsObjectives: true }
  /**
   * Tryb „dodaj N”: punkt kontrolny ma już co najmniej `count` nowych ćwiczeń (np. `shutdown` po rozliczeniu
   * zagadnienia) — kierownik nie przyjmuje `count < 1`, więc wołający zapisuje postęp bez wywołań modelu.
   */
  | { readonly nothingToAdd: true };

/**
 * Temat katalogowy zawężony do zagadnień lekcji (`objectiveIds` runu, kolejność tematu): kierownik
 * uruchamia każde zagadnienie tematu, a limity liczy z ich liczby.
 */
export function lessonCatalogTopic(topic: LessonTopic, objectiveIds: readonly string[]): LessonTopic {
  const selected = new Set(objectiveIds);
  const objectives = topic.objectives.filter((objective) => selected.has(objective.id));
  if (objectives.length === 0) throw new AppError("validation", { message: "lesson objectives not in topic" });
  return { ...topic, objectives };
}

function catalogSource(topic: LessonTopic | undefined, objectiveIds: readonly string[]): AgentObjectiveSource {
  if (topic === undefined) throw new AppError("validation", { message: "lesson topic unresolved" });
  return { source: "catalog", topic: lessonCatalogTopic(topic, objectiveIds) };
}

/**
 * Źródło zagadnień pełnej generacji (§7.1), pierwsza pasująca reguła: temat w punkcie kontrolnym →
 * `input`; temat dynamiczny runu → `input`; przedmiot bez tematów dynamicznych → `catalog`; przedmiot z
 * planerem (`agentPolicy.planCoverage`) → `planner`; pozostałe dynamiczne → `input` z etapu zagadnień.
 */
function poolSource(args: LessonAgentRunInputArgs): AgentObjectiveSource | { readonly needsObjectives: true } {
  const { progress, input, subject } = args;
  if (progress?.dynamicTopic !== undefined) return { source: "input", dynamicTopic: progress.dynamicTopic };
  if (input.dynamicTopic !== undefined) return { source: "input", dynamicTopic: input.dynamicTopic };
  if (subject.buildDynamicTopic === undefined) return catalogSource(args.catalogTopic, input.objectiveIds);
  if (subject.agentPolicy.planCoverage !== undefined) return { source: "planner" };
  if (args.schoolTopic !== undefined) return { source: "input", dynamicTopic: args.schoolTopic };
  return { needsObjectives: true };
}

/** Źródło dogenerowania (§7.1): temat dynamiczny runu albo szkicu, inaczej katalog; nigdy planer. */
function addSource(args: LessonAgentRunInputArgs): AgentObjectiveSource {
  const dynamicTopic = args.input.dynamicTopic ?? args.draft.dynamicTopic;
  if (dynamicTopic !== undefined) return { source: "input", dynamicTopic };
  if (args.subject.buildDynamicTopic !== undefined) {
    throw new AppError("validation", { message: "add mode needs the draft's dynamic topic" });
  }
  return catalogSource(args.catalogTopic, args.input.objectiveIds);
}

/**
 * Wejście kierownika dla próby (tabela §7.1, wznowienie §8.3). Pełna generacja: zagadnienia `complete` z
 * punktu kontrolnego są pomijane i stałe (`fixed`), pozostałe startują od zera. Dogenerowanie: `fixed` =
 * szkic + nowe ćwiczenia z punktu kontrolnego, `count` pomniejszony o te nowe. `familyScope` zaczyna się
 * identyfikatorem próby: `scopeFamiliesToRun` bierze z zakresu tylko 6 pierwszych znaków szesnastkowych
 * (sam identyfikator runu dałby ten sam sufiks w każdej próbie), a „Ponów” odroczonego runu zeruje
 * `attempts` bez podbicia numeru edycji — rodziny nowych ćwiczeń nie mogą się zderzyć z rodzinami
 * wcześniejszych prób (dogenerowanie zachowuje nowe ćwiczenia między próbami).
 */
export function lessonAgentRunInputFor(args: LessonAgentRunInputArgs): LessonAgentRunInputResult {
  const { runId, input, progress, subject } = args;
  const common = {
    runId,
    subjectId: subject.id,
    deckId: input.deckId,
    topicTitle: input.topicTitlePl ?? "",
    material: input.material,
    ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
    ...(input.interests === undefined ? {} : { interests: input.interests }),
    poolSize: input.poolSize,
    graderAvailable: args.graderAvailable,
    draftExamples: {},
    familyScope: `${args.attemptNonce}:${runId}:${args.expectedEditNumber}:${args.attempts}`,
    initialSpentUsd: progress?.budgetSpentUsd ?? 0,
  };

  const regenerate = input.regenerate;
  if (regenerate !== undefined) {
    const added = progress?.objectives[regenerate.objectiveId]?.exercises ?? [];
    const remaining = regenerate.count - stageExerciseCount(added);
    if (remaining <= 0) return { nothingToAdd: true };
    const storySentences = args.draft.storySentences ?? [];
    return {
      ...common,
      objectiveSource: addSource(args),
      fixed: [...args.draft.exercises, ...added],
      skipObjectives: [],
      initialExamples: args.draft.examples,
      examplesFixed: true,
      ...(storySentences.length === 0 ? {} : { extraExposureSources: storySentences }),
      target: { mode: "add", objectiveId: regenerate.objectiveId, count: remaining },
    };
  }

  const objectiveSource = poolSource(args);
  if ("needsObjectives" in objectiveSource) return objectiveSource;
  const complete = completeEntries(progress, objectiveOrderOf(objectiveSource));
  // Przykłady planu dla wszystkich zagadnień (ustalone), własne przykłady tylko zagadnień `complete`.
  const initialExamples: Record<string, string[]> = { ...progress?.planExamples };
  for (const [objectiveId, entry] of complete) initialExamples[objectiveId] = [...entry.examples];
  return {
    ...common,
    objectiveSource,
    fixed: complete.flatMap(([, entry]) => entry.exercises),
    skipObjectives: complete.map(([objectiveId]) => objectiveId),
    initialExamples,
    examplesFixed: hasPlanExamples(progress) || objectiveSource.source === "planner",
    target: { mode: "pool" },
  };
}

export type LessonAgentOutcome =
  | { readonly kind: "requeue"; readonly errorCode: string; readonly retryAfterMs?: number }
  | { readonly kind: "finalize" }
  | { readonly kind: "failed"; readonly errorCode: string };

export interface LessonAgentOutcomeObjective {
  readonly status: "complete" | "incomplete" | "failed";
  readonly failure?: { readonly errorCode: string; readonly retryable: boolean; readonly retryAfterMs?: number };
}

/**
 * Wynik próby (tabela §9, pierwszy pasujący wiersz wygrywa). `objectives` i `accepted` pochodzą z postępu
 * PO scaleniu z próbą (tryb „dodaj N”: wyłącznie nowe ćwiczenia); `budgetExhausted` =
 * `result.spentUsd >= policy.runBudgetUsd`. Opóźnienie `requeue` liczy wołający (`lessonRetryDelayMs`).
 */
export function lessonAgentRunOutcome(args: {
  readonly planStatus: LessonPoolAgentResult["planStatus"];
  readonly planFailure?: LessonPoolAgentResult["planFailure"];
  readonly objectives: readonly LessonAgentOutcomeObjective[];
  readonly accepted: number;
  readonly budgetExhausted: boolean;
  readonly attempts: number;
  readonly maxAttempts: number;
}): LessonAgentOutcome {
  const attemptsLeft = args.attempts < args.maxAttempts;
  // 1: budżet wyczerpany — kolejna próba nic by nie wydała.
  if (args.budgetExhausted) return args.accepted >= 1 ? { kind: "finalize" } : { kind: "failed", errorCode: "validation" };
  if (args.planStatus === "plan_failed") {
    const failure = args.planFailure;
    // 2–3: porażka planu — przejściowa ponawiana, inaczej kod planu.
    if (failure?.retryable === true && attemptsLeft) {
      return { kind: "requeue", errorCode: failure.errorCode, ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }) };
    }
    return { kind: "failed", errorCode: failure?.errorCode ?? "validation" };
  }
  // 4: przejściowa porażka zagadnienia — kod pierwszego, najdłuższe `retryAfterMs` dostawcy.
  const retryable = args.objectives.flatMap((objective) =>
    objective.status === "failed" && objective.failure?.retryable === true ? [objective.failure] : [],
  );
  if (retryable.length > 0 && attemptsLeft) {
    const waits = retryable.flatMap((failure) => (failure.retryAfterMs === undefined ? [] : [failure.retryAfterMs]));
    return { kind: "requeue", errorCode: retryable[0]!.errorCode, ...(waits.length === 0 ? {} : { retryAfterMs: Math.max(...waits) }) };
  }
  // 5: cokolwiek przyjęte → zapis do szkicu.
  if (args.accepted >= 1) return { kind: "finalize" };
  // 6: same porażki z jednym kodem dostawcy.
  const failures = args.objectives.map((objective) => (objective.status === "failed" ? objective.failure : undefined));
  const first = failures[0];
  if (first !== undefined && failures.every((failure) => failure?.errorCode === first.errorCode)) {
    return { kind: "failed", errorCode: first.retryable ? "attempts_exhausted" : first.errorCode };
  }
  // 7: nic nie przyjęto.
  return { kind: "failed", errorCode: "validation" };
}

/**
 * Zagadnienia postępu do `lessonAgentRunOutcome`: porażki tej próby z ponawialnością z wyniku, porażki
 * wcześniejszych prób (sam kod w punkcie kontrolnym) jako nieponawialne.
 */
export function outcomeObjectivesOf(progress: LessonAgentProgress, result: LessonPoolAgentResult): LessonAgentOutcomeObjective[] {
  const failures = new Map(result.objectives.flatMap((settled) => (settled.failure === undefined ? [] : [[settled.objectiveId, settled.failure] as const])));
  return Object.entries(progress.objectives).map(([objectiveId, entry]) => {
    if (entry.status !== "failed") return { status: entry.status };
    const failure = failures.get(objectiveId);
    if (failure !== undefined) return { status: "failed", failure };
    return entry.failureCode === undefined ? { status: "failed" } : { status: "failed", failure: { errorCode: entry.failureCode, retryable: false } };
  });
}

/**
 * Scalenie wyniku próby z postępem Z POCZĄTKU próby (tym, z którego zbudowano wejście): wpis zagadnienia
 * uruchomionego w próbie zastępuje poprzedni (pula) albo dopisuje nowe ćwiczenia (dodaj N); zagadnienia
 * `complete` pominięte w próbie zostają. Wydatek: budżet = licznik kierownika (zawiera `initialSpentUsd`),
 * łącznie + przyrost próby; histogram kodów odrzuceń, liczniki kontroli (2b) i usunięcia bezpiecznika kierownika sumowane.
 */
export function mergeAttemptIntoProgress(
  progress: LessonAgentProgress,
  result: LessonPoolAgentResult,
  mode: "pool" | "add",
  addObjectiveId?: string,
): LessonAgentProgress {
  const objectives: Record<string, LessonAgentObjectiveProgress> = { ...progress.objectives };
  for (const settled of result.objectives) {
    if (mode === "add" && settled.objectiveId !== addObjectiveId) continue;
    const earlier = mode === "add" ? (progress.objectives[settled.objectiveId]?.exercises ?? []) : [];
    objectives[settled.objectiveId] = {
      status: settled.status,
      ...(settled.failure === undefined ? {} : { failureCode: settled.failure.errorCode }),
      exercises: [...earlier, ...settled.exercises],
      examples: [...settled.examples],
    };
  }
  const rejectionCodes = { ...progress.rejectionCodes };
  for (const rejection of result.rejections) rejectionCodes[rejection.code] = (rejectionCodes[rejection.code] ?? 0) + 1;
  // Liczniki kontroli (etap 2b): sumowane jak histogram; pole powstaje dopiero po pierwszym niezerowym liczniku.
  const checkCounters: Record<string, number> = { ...progress.checkCounters };
  for (const key of CHECK_COUNTER_KEYS) {
    const delta = result.stats[key];
    if (delta > 0) checkCounters[key] = (checkCounters[key] ?? 0) + delta;
  }
  // Oczyszczenia przy przyjmowaniu: sumowane jak liczniki kontroli, do zapisu w kontekście szkicu.
  const cleanupCounts: Record<string, number> = { ...progress.cleanupCounts };
  for (const key of CLEANUP_COUNTER_KEYS) {
    const delta = result.stats[key];
    if (delta > 0) cleanupCounts[key] = (cleanupCounts[key] ?? 0) + delta;
  }
  const attemptSpentUsd = Math.max(0, result.spentUsd - progress.budgetSpentUsd);
  const dynamicTopic = progress.dynamicTopic ?? result.dynamicTopic;
  return {
    ...progress,
    ...(dynamicTopic === undefined ? {} : { dynamicTopic }),
    objectives,
    budgetSpentUsd: progress.budgetSpentUsd + attemptSpentUsd,
    totalSpentUsd: progress.totalSpentUsd + attemptSpentUsd,
    rejectionCodes,
    ...(Object.keys(checkCounters).length === 0 ? {} : { checkCounters }),
    ...(Object.keys(cleanupCounts).length === 0 ? {} : { cleanupCounts }),
    removedAfterAcceptance: progress.removedAfterAcceptance + result.stats.invariantViolations,
  };
}

/**
 * Powody odrzuceń agenta dla rodzica (`rejectedReasons` szkicu, decyzja właściciela 2026-11-05): liczby według
 * polskiej etykiety kodu. Kody bez etykiety sumowane pod „inne powody”, zerowe pomijane; wynik nie niesie treści
 * ćwiczeń ani słów — tylko etykiety z katalogu komunikatów. Klucze to etykiety, nie kody (panel pokazuje je wprost).
 */
export function agentRejectedReasons(codes: Readonly<Record<string, number>>): Record<string, number> {
  const labels: Readonly<Record<string, string>> = messages.lessons.agentRejectionReasons;
  const reasons = new Map<string, number>();
  for (const [code, count] of Object.entries(codes)) {
    if (count <= 0) continue;
    const label = Object.hasOwn(labels, code) ? labels[code]! : messages.lessons.agentRejectionOther;
    reasons.set(label, (reasons.get(label) ?? 0) + count);
  }
  return Object.fromEntries(reasons);
}

/** Kody odrzuceń jeszcze niezapisane w `rejectedReasons` szkicu: kumulowane kody runu minus `rejectionCodesWritten`. */
export function unwrittenRejectionCodes(progress: Pick<LessonAgentProgress, "rejectionCodes" | "rejectionCodesWritten">): Record<string, number> {
  const unwritten: Record<string, number> = {};
  for (const [code, count] of Object.entries(progress.rejectionCodes)) {
    const delta = count - (progress.rejectionCodesWritten?.[code] ?? 0);
    if (delta > 0) unwritten[code] = delta;
  }
  return unwritten;
}

/**
 * Przyjęte ćwiczenia wszystkich zagadnień postępu w kolejności lekcji (w trybie „dodaj N” postęp ma tylko
 * nowe ćwiczenia). Zagadnienia spoza `objectiveOrder` są pomijane — nie należą do tematu lekcji.
 */
export function acceptedInLessonOrder(progress: LessonAgentProgress, objectiveOrder: readonly string[]): LessonExerciseDraft[] {
  return objectiveOrder.flatMap((objectiveId) => progress.objectives[objectiveId]?.exercises ?? []);
}

/**
 * Luki generowania (§11) z postępu po scaleniu, ze `status` (nie z `missing`: w trybie „dodaj N” komplet
 * ma niepuste `missing`). Pula: zagadnienie `incomplete`/`failed` albo bez wpisu (nieuruchomione) → luka.
 * Dodaj N: zagadnienie nie `complete` i mniej niż N nowych ćwiczeń na ścieżce etapów → `add_short`
 * (pozostałe braki etapów po spełnionym +N to nie niedobór dodatku).
 */
export function generationGapsOf(
  progress: LessonAgentProgress,
  objectiveIds: readonly string[],
  mode: "pool" | { readonly add: { readonly objectiveId: string; readonly count: number } },
): LessonGenerationGap[] {
  if (mode !== "pool") {
    const { objectiveId, count } = mode.add;
    const entry = progress.objectives[objectiveId];
    const added = stageExerciseCount(entry?.exercises ?? []);
    if (entry?.status === "complete" || added >= count) return [];
    return [{ objectiveId, reason: "add_short", added, requested: count }];
  }
  return objectiveIds.flatMap((objectiveId): LessonGenerationGap[] => {
    const status = progress.objectives[objectiveId]?.status ?? "incomplete";
    return status === "complete" ? [] : [{ objectiveId, reason: status }];
  });
}

/** Pełna generacja zastępuje listę; dogenerowanie podmienia wpis swojego zagadnienia (komplet go usuwa). */
export function mergeGenerationGaps(
  previous: readonly LessonGenerationGap[] | undefined,
  next: readonly LessonGenerationGap[],
  mode: "pool" | "add",
  objectiveId?: string,
): LessonGenerationGap[] {
  if (mode === "pool") return [...next];
  return [...(previous ?? []).filter((gap) => gap.objectiveId !== objectiveId), ...next];
}
