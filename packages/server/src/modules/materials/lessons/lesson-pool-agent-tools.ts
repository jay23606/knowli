import {
  admitBatch,
  precheckBatch,
  rejectionOf,
  removeExercise,
  submitExamples,
  type AdmitEntry,
  type AgentCheckContext,
  type AgentHintVerdict,
  type CandidateChecks,
  type CheckResult,
  type OpenCheckOutcome,
  type OpenGraded,
  type PrecheckEntry,
  type Rejection,
} from "../../../domain/lessons/agent/admission";
import { expectedAnswerCount, solverView } from "../../../domain/lessons/agent/solver";
import type { LessonAgentState } from "../../../domain/lessons/agent/state";
import { objectiveStatusFor } from "../../../domain/lessons/agent/status";
import { validateSchoolVerdict, type SchoolVerdict } from "../../../domain/lessons/evaluate";
import { familyBase } from "../../../domain/lessons/keyword-families";
import { answersEquivalent } from "../../../domain/lessons/pool-validation";
import { materializeRawExercise } from "../../../domain/lessons/raw-materialize";
import { foreignObjectiveIssues, rawShapeIssues } from "../../../domain/lessons/raw-shape";
import { clip, describeRule, ruleOf, type LessonRuleIssue, type RuleId } from "../../../domain/lessons/rules/catalog";
import { ruleTextContextOf } from "../../../domain/lessons/rules/rule-book";
import { formatRuleReason } from "../../../domain/lessons/rules/rule-reason";
import type { LessonExerciseDraft, LessonTopic, SchoolCriteria } from "../../../domain/lessons/types";
import type {
  GraderInput,
  LessonAgentToolOutcome,
  LessonAgentToolResult,
  LessonExerciseCheckerProvider,
  LessonObjectiveAgentTools,
  RunCostSink,
} from "../../../ports/ai";
import {
  gradedFromVerdict,
  hintKey,
  isHintVerdict,
  isOpenPair,
  matchedGraded,
  openKey,
  type AgentCheckGrader,
  type AgentCheckRun,
} from "./lesson-agent-check-run";
import { deadlineSignal, untilAborted, type Semaphore } from "./lesson-agent-timers";
import { stripParentAddedFlags, toExerciseDraft } from "./lesson-drafts";
import { lessonGraderInput, lessonInstructionOf, schoolCriteriaOf } from "./lesson-grader-input";
import type { LessonAgentPolicy, RunBudgetSink } from "./lesson-pool-agent-policy";
import { sanitizeFreshLessonDraft } from "./lesson-pool-acceptance";

/**
 * Narzędzia podagenta jednego zagadnienia (spec etapu 1 §7.1 pkt 4–5): mutex
 * zagadnienia, parsowanie i sanityzacja surowych rekordów, paczkowe wywołania
 * checkera (wspólny semafor, termin), synchroniczne przyjęcie do wspólnego stanu
 * lekcji, budżet i zamknięcie. Teksty dla modelu są po angielsku.
 */

/**
 * Wpis odrzucenia dla kierownika: `code`, `ruleIds` i `exerciseType` bez treści (logi), `detail` z
 * treścią (powody dla modelu) tylko w pamięci wyniku (sonda zapisuje go poza repozytorium).
 */
export interface RejectionLogEntry {
  readonly objectiveId: string;
  readonly exerciseType: string;
  readonly kind: Rejection["kind"];
  readonly code: string;
  readonly ruleIds: readonly string[];
  readonly detail: string;
}

/** Odmowa całego wywołania (bez przyjęcia); nie jest odrzuceniem ćwiczenia. */
export type ToolRefusalCode = "refused_budget" | "refused_closed";

/**
 * Przyrosty statystyk runu: `submitted` — rekordy wywołań przetworzonych (bez odmowy na wejściu),
 * `accepted` — przyjęte do puli, `checkerCalls` — faktyczne wywołania checkera, `checkUnavailable` —
 * przyjęte bez wyniku checkera (`unchecked`). Etap 2b (§7.4): `hintChecks`/`openChecks` — pozycje
 * wysłane do sędziego podpowiedzi i rozwiązującego otwarte, `graderCalls` — faktyczne `grade`,
 * `hintUnavailable`/`openUnavailable` — pozycje bez wyniku tych kontroli, `graderErrors` — błędy i
 * terminy gradera, `graderInvalidVerdicts` — werdykty odrzucone przez `validateSchoolVerdict`.
 */
export interface ObjectiveToolsStats {
  readonly submitted: number;
  readonly accepted: number;
  readonly checkerCalls: number;
  readonly checkUnavailable: number;
  readonly hintChecks: number;
  readonly openChecks: number;
  readonly graderCalls: number;
  readonly hintUnavailable: number;
  readonly openUnavailable: number;
  readonly graderErrors: number;
  readonly graderInvalidVerdicts: number;
  /** Przyjęte z podpowiedzią usuniętą przez regułę `hint.reveals_words` (spec katalogu reguł §5.1). */
  readonly hintsRemoved: number;
  /** Warianty usunięte przez kontrolę wariantów (`check.variants`, §5.3). */
  readonly variantsRemoved: number;
  /** Cytaty zastąpione dokładnym fragmentem materiału (§5.2). */
  readonly quotesSnapped: number;
}

export interface ObjectiveToolsArgs {
  readonly objectiveId: string;
  getState(): LessonAgentState;
  setState(state: LessonAgentState): void;
  readonly ctx: AgentCheckContext;
  readonly checker: LessonExerciseCheckerProvider;
  /** Wspólny dla runu: jedno miejsce na wywołanie `solve` albo `judgeVariants`. */
  readonly checkerSemaphore: Semaphore;
  /** Licznik runu (albo jego nakładka per zagadnienie): koszt checkera i odczyt budżetu. */
  readonly cost: RunBudgetSink;
  /** Sygnał zagadnienia (run, termin runu i termin zagadnienia). */
  readonly objectiveSignal: AbortSignal;
  readonly policy: LessonAgentPolicy;
  readonly familyScope: string | null;
  /** `true` = przykłady kart są ustalone (plan albo wznowienie); przykłady z `submit` są ignorowane. */
  readonly examplesFixed: boolean;
  /**
   * Tryb „dodaj N” (spec etapu 2a §6.4): status dla modelu i `shouldStop` z `addModeStatus` — komplet po
   * `remaining` nowych ćwiczeniach bez braków etapów. Brak = tryb puli.
   */
  readonly addMode?: { readonly remaining: number };
  /** Grader kontroli otwartej (etap 2b); brak = kontrola otwarta nie dotyczy, `solveOpen` niewołany. */
  readonly grader?: AgentCheckGrader;
  /** Wspólny dla runu: semafor gradera, pamięć wyników kontroli i wyłącznik gradera. */
  readonly checkRun: AgentCheckRun;
  onRejection(entry: RejectionLogEntry): void;
  /** Opcjonalnie: odmowa całego wywołania (statystyka `refused` kierownika). */
  onRefusal?(code: ToolRefusalCode): void;
  /** Opcjonalnie: przyrosty statystyk runu kierownika. */
  onStats?(delta: Partial<ObjectiveToolsStats>): void;
  /** Opcjonalnie: wyłącznik gradera właśnie się otworzył (raz na run; log `grader_unavailable`). */
  onGraderBreaker?(): void;
}

const REFUSAL_TEXT: Readonly<Record<ToolRefusalCode, string>> = {
  refused_closed: "tools are closed",
  refused_budget: "budget exhausted",
};

const CHECKER_TIMEOUT_REASON = "checker_timeout";
const GRADER_TIMEOUT_REASON = "grader_timeout";
const GRADER_STAGE_TIMEOUT_REASON = "grader_stage_timeout";

type ToolResult = LessonAgentToolResult;
type ExamplesOutcome = NonNullable<LessonAgentToolOutcome["examples"]>;

type ParsedRecord =
  | { readonly ok: true; readonly draft: LessonExerciseDraft; readonly notes: readonly LessonRuleIssue[] }
  | { readonly ok: false; readonly exerciseType: string; readonly rejection: Rejection };

const noop = () => undefined;

function rawExerciseType(raw: unknown): string {
  return exerciseTypeOf(raw) ?? "unknown";
}

/** `exerciseType` surowego rekordu, gdy jest napisem (echo w wyniku dla modelu). */
function exerciseTypeOf(raw: unknown): string | null {
  const type = raw !== null && typeof raw === "object" ? (raw as { exerciseType?: unknown }).exerciseType : undefined;
  return typeof type === "string" ? type : null;
}

/** Najwyżej tyle powodów odrzucenia na ćwiczenie w wyniku dla modelu; reszta jako `+N more`. */
const MAX_REASONS = 6;

/** Długość echa bodźca w wyniku dla modelu (spec katalogu reguł §4.1). */
const STIMULUS_ECHO_LENGTH = 40;

/** Pola bodźca w kolejności: pierwsze niepuste trafia do echa w wyniku. */
const STIMULUS_FIELDS = ["stem", "statement", "prompt", "clozeText", "instructionPl", "familyId"] as const;

/** Reguła, której nota oznacza usuniętą podpowiedź pytania otwartego (licznik `hintsRemoved`). */
const HINT_REMOVED_RULE = "hint.reveals_words";

/**
 * Początek bodźca surowego rekordu (ok. 40 znaków treści modelu, jedna linia), żeby model wiedział,
 * którego ćwiczenia dotyczy wynik; rachunek — slug rodziny; brak bodźca — pusty napis.
 */
function stimulusOf(raw: unknown): string {
  if (raw === null || typeof raw !== "object") return "";
  const record = raw as Record<string, unknown>;
  const calculation = record.calculation;
  const family = calculation !== null && typeof calculation === "object" ? (calculation as { templateFamilyId?: unknown }).templateFamilyId : undefined;
  const text = [...STIMULUS_FIELDS.map((field) => record[field]), family].find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  return text === undefined ? "" : clip(text.trim(), STIMULUS_ECHO_LENGTH, { quote: false });
}

/** Echo ćwiczenia w wyniku: typ i początek bodźca z surowego rekordu. */
function echoOf(raw: unknown): { readonly exerciseType: string | null; readonly stimulus: string } {
  return { exerciseType: exerciseTypeOf(raw), stimulus: stimulusOf(raw) };
}

/** Powody dla modelu: najwyżej `MAX_REASONS`, dalej jeden wpis `+N more`. */
function cappedReasons(reasons: readonly string[]): string[] {
  const shown = reasons.slice(0, MAX_REASONS);
  return reasons.length > MAX_REASONS ? [...shown, `+${reasons.length - MAX_REASONS} more`] : shown;
}

/**
 * Id reguł pokazanych powodów odrzucenia (do mapy opisów): powody odpowiadają zgłoszeniom pozycja po
 * pozycji (`rejectionOf`), więc to reguły pierwszych `MAX_REASONS` zgłoszeń; inaczej wszystkie id odrzucenia.
 */
function shownRuleIds(rejection: Rejection): readonly string[] {
  if (rejection.reasons.length !== rejection.issues.length) return rejection.ruleIds;
  return [...new Set(rejection.issues.slice(0, MAX_REASONS).map((issue) => issue.rule as string))];
}

/** Wynik zbudowany dla modelu i skutki, które `submit` wykona dopiero po podmianie stanu. */
interface BuiltResult {
  readonly result: ToolResult;
  /** Id reguł, których opisy należą się modelowi w tym wyniku. */
  readonly ruleIds: readonly string[];
  readonly rejection?: RejectionLogEntry;
}

/** Odrzucenie kształtu: zgłoszenia reguł `shape.*` i powody `[id] pole: found`. */
function shapeRejection(
  exerciseType: string,
  code: "shape_malformed" | "shape_objective",
  issues: readonly LessonRuleIssue[],
): ParsedRecord {
  return { ok: false, exerciseType, rejection: rejectionOf("shape", code, issues) };
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isVerdictList(value: unknown, length: number): value is readonly boolean[] {
  return Array.isArray(value) && value.length === length && value.every((item) => typeof item === "boolean");
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Wynik wywołania pod semaforem: `skipped` — bez wywołania (budżet, zamknięcie, blokada), `failed` — błąd albo termin. */
type GuardedOutcome<T> = { readonly kind: "done"; readonly value: T } | { readonly kind: "skipped" } | { readonly kind: "failed" };

/** Pozycja kontroli otwartej: dane potrzebne w etapie 2 (wejście gradera bez odpowiedzi i kryteria). */
interface OpenItem {
  readonly index: number;
  readonly key: string;
  readonly draft: LessonExerciseDraft;
  readonly criteria: SchoolCriteria;
  readonly graderInputFor: (answerText: string) => GraderInput;
}

/** Wynik pozycji paczki: spoza paczki `na`; brak paczki, brak pary albo zły kształt `unavailable`; nadmiar pomijany. */
function checkAt<T>(
  batchIndexes: readonly number[],
  values: readonly unknown[] | null,
  index: number,
  valid: (value: unknown) => value is T,
): CheckResult<T> {
  const position = batchIndexes.indexOf(index);
  if (position < 0) return { kind: "na" };
  if (values === null) return { kind: "unavailable" };
  const value = values[position];
  return valid(value) ? { kind: "done", value } : { kind: "unavailable" };
}

export function createObjectiveTools(args: ObjectiveToolsArgs): { tools: LessonObjectiveAgentTools; close(): Promise<void> } {
  const { objectiveId, ctx, policy } = args;
  const agentPolicy = ctx.subject.agentPolicy;
  let closed = false;
  // Zamknięcie przerywa też trwające wywołania checkera: ich wynik i tak skończy się odmową.
  const closing = new AbortController();
  // Jeden sygnał rodzica terminów checkera na całe zagadnienie (nie per wywołanie).
  const checkerParent = AbortSignal.any([args.objectiveSignal, closing.signal]);

  // Mutex zagadnienia: kolejka FIFO obietnic; każde wywołanie czeka na poprzednie (także nieudane).
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn);
    tail = run.then(noop, noop);
    return run;
  };

  const isClosed = () => closed || args.objectiveSignal.aborted;

  const statusOf = (state: LessonAgentState) => {
    const status = objectiveStatusFor(state, objectiveId, ctx, args.addMode);
    return { counts: status.counts, missing: status.missing, complete: status.complete };
  };

  function refuse(code: ToolRefusalCode, exercises: unknown, examples: unknown): LessonAgentToolOutcome {
    args.onRefusal?.(code);
    const message = REFUSAL_TEXT[code];
    const results: ToolResult[] = Array.isArray(exercises)
      ? exercises.map((raw, index) => ({ index, ...echoOf(raw), errors: [message] }))
      : [{ index: 0, exerciseType: null, stimulus: "", errors: [message] }];
    return {
      results,
      ...(examples === undefined ? {} : { examples: { accepted: 0, errors: [message] } }),
      ...statusOf(args.getState()),
    };
  }

  /**
   * Surowy rekord → szkic (spec katalogu reguł §4.3): materializacja typów liczonych przez kod,
   * kształt rekordu i zagadnienie. Zgłoszenia materializacji i kształtu mają kod `shape_malformed`,
   * obce zagadnienie `shape_objective`. Noty wspólnej sanityzacji (usunięte wyjaśnienie) trafiają do
   * wyniku przyjęcia razem z notami przyjmowania.
   */
  function parseRecord(raw: unknown): ParsedRecord {
    const materialized = materializeRawExercise(raw);
    if (!materialized.ok) return shapeRejection(materialized.exerciseType, "shape_malformed", materialized.issues);
    const shapeIssues = rawShapeIssues(materialized.record);
    if (shapeIssues.length > 0) return shapeRejection(rawExerciseType(raw), "shape_malformed", shapeIssues);
    const draft = toExerciseDraft(materialized.record);
    const foreign = foreignObjectiveIssues(draft.objectiveId, objectiveId);
    if (foreign.length > 0) return shapeRejection(draft.exerciseType, "shape_objective", foreign);
    const sanitized = sanitizeFreshLessonDraft(draft, ctx.subject, args.familyScope);
    return { ok: true, draft: stripParentAddedFlags([sanitized.draft])[0]!, notes: sanitized.explanationNotes };
  }

  /**
   * Wspólna osłona wywołań checkera i gradera (§7.2): miejsce w semaforze, po jego zajęciu budżet,
   * zamknięcie, przerwany rodzic terminu i blokada wołającego (`skipped`, bez wywołania); termin
   * liczony od zajęcia miejsca. Wyścig z terminem: dostawca ignorujący sygnał nie trzyma miejsca w
   * semaforze ani `close()`.
   */
  async function guarded<T>(
    semaphore: Semaphore,
    call: {
      readonly parent: AbortSignal;
      readonly timeoutMs: number;
      readonly reason: string;
      blocked?(): boolean;
      onStart(): void;
      request(signal: AbortSignal): Promise<T>;
    },
  ): Promise<GuardedOutcome<T>> {
    return semaphore.run(async () => {
      // Budżet sprawdzany przed każdym wywołaniem (po oczekiwaniu na semafor).
      if (args.cost.exhausted() || isClosed() || call.parent.aborted || call.blocked?.() === true) return { kind: "skipped" };
      call.onStart();
      const deadline = deadlineSignal(call.parent, call.timeoutMs, call.reason);
      try {
        return { kind: "done", value: await untilAborted(call.request(deadline.signal), deadline.signal) };
      } catch {
        return { kind: "failed" };
      } finally {
        deadline.dispose();
      }
    });
  }

  /**
   * Jedno wywołanie checkera pod semaforem i terminem (kontrakt 2a); `null` = cała paczka
   * `unavailable` (pominięcie, błąd, termin albo zły kształt wyniku). `request` tylko woła dostawcę:
   * wejście (widoki) buduje wołający przed wywołaniem, więc błąd w budowaniu widoku jest wyjątkiem,
   * a nie maskowanym `unavailable`.
   */
  async function callChecker<T>(request: (signal: AbortSignal) => Promise<unknown>, valid: (value: unknown) => value is T): Promise<T | null> {
    const outcome = await guarded(args.checkerSemaphore, {
      parent: checkerParent,
      timeoutMs: policy.checkerTimeoutMs,
      reason: CHECKER_TIMEOUT_REASON,
      onStart: () => args.onStats?.({ checkerCalls: 1 }),
      request,
    });
    return outcome.kind === "done" && valid(outcome.value) ? outcome.value : null;
  }

  // Koszt gradera do licznika runu; nieznany koszt liczony małym szacunkiem gradera (§7.3).
  const graderCost: RunCostSink = {
    record: (usd) => args.cost.record(usd === null || !Number.isFinite(usd) || usd < 0 ? policy.unknownGraderCallEstimateUsd : usd),
  };

  function graderFailure(stat: "graderErrors" | "graderInvalidVerdicts"): void {
    args.onStats?.({ [stat]: 1 });
    if (args.checkRun.recordGraderFailure()) args.onGraderBreaker?.();
  }

  /**
   * Jedno wywołanie gradera (§7.2) pod semaforem gradera runu; po zajęciu miejsca także wyłącznik.
   * Termin: limit etapu (`stageSignal`, potomek sygnału zamknięcia) i własny `timeoutMs` gradera.
   * `null` = odpowiedź niesprawdzona; błąd, własny termin gradera i werdykt odrzucony walidacją
   * liczą się do wyłącznika, zamknięcie narzędzi i limit etapu nie.
   */
  async function callGrader(grader: AgentCheckGrader, input: GraderInput, criteria: SchoolCriteria, stageSignal: AbortSignal): Promise<SchoolVerdict | null> {
    const outcome = await guarded(args.checkRun.graderSemaphore, {
      parent: stageSignal,
      timeoutMs: grader.timeoutMs,
      reason: GRADER_TIMEOUT_REASON,
      blocked: () => args.checkRun.graderOpen(),
      onStart: () => args.onStats?.({ graderCalls: 1 }),
      request: (signal) => grader.provider.grade(input, signal, graderCost),
    });
    if (outcome.kind === "skipped") return null;
    if (outcome.kind === "failed") {
      // Zamknięcie narzędzi i limit etapu nie są awarią gradera: wywołanie mogło dostać miejsce w
      // semaforze runu późno, a wiszący grader łapie jego własny `timeoutMs`. Pozycja jest niesprawdzona.
      if (!isClosed() && !stageSignal.aborted) graderFailure("graderErrors");
      return null;
    }
    const verdict = validateSchoolVerdict(outcome.value, {
      requiredElementIds: criteria.requiredElements.map((element) => element.id),
      childAnswer: input.childAnswer,
      formOk: null,
    });
    if (verdict === null) {
      graderFailure("graderInvalidVerdicts");
      return null;
    }
    args.checkRun.recordGraderSuccess();
    return verdict;
  }

  /** Odpowiedź równoważna kluczowi albo wariantowi po normalizatorze przedmiotu (jak u dziecka). */
  function matchesKey(answer: string, draft: LessonExerciseDraft): boolean {
    return [draft.answer, ...draft.acceptedAnswers].some((key) => answersEquivalent(answer, key, ctx.subject.normalizer));
  }

  /**
   * Etap 2 (§6.2 pkt 3): każda odpowiedź pary — dopasowanie deterministyczne bez gradera, druga
   * równa pierwszej po normalizacji dziedziczy jej wynik, reszta przez `callGrader`. Wszystkie
   * wywołania paczki startują razem (w granicach semafora gradera) pod limitem etapu.
   */
  async function gradeOpen(
    grader: AgentCheckGrader,
    pairs: readonly { readonly item: OpenItem; readonly pair: readonly [string, string] }[],
  ): Promise<CheckResult<OpenCheckOutcome>[]> {
    if (pairs.length === 0) return [];
    const stage = deadlineSignal(checkerParent, policy.graderStageTimeoutMs, GRADER_STAGE_TIMEOUT_REASON);
    try {
      return await Promise.all(
        pairs.map(async ({ item, pair: [first, second] }): Promise<CheckResult<OpenCheckOutcome>> => {
          const gradeOne = async (answer: string): Promise<OpenGraded | null> => {
            if (matchesKey(answer, item.draft)) return matchedGraded(answer);
            const verdict = await callGrader(grader, item.graderInputFor(answer), item.criteria, stage.signal);
            return verdict === null ? null : gradedFromVerdict(answer, verdict, item.criteria);
          };
          const firstGraded = gradeOne(first);
          const secondGraded = answersEquivalent(second, first, ctx.subject.normalizer)
            ? firstGraded.then((graded) => (graded === null ? null : { ...graded, answer: second }))
            : gradeOne(second);
          const [a, b] = await Promise.all([firstGraded, secondGraded]);
          return a !== null && b !== null ? { kind: "done", value: { answers: [a, b] } } : { kind: "unavailable" };
        }),
      );
    } finally {
      stage.dispose();
    }
  }

  /**
   * Kroki 5–7 (§6.2): pamięć runu, etap 1 — `solve`, `judgeVariants`, `judgeHints`, `solveOpen`
   * równolegle, po jednym wywołaniu na paczkę — potem etap 2 (grader). Checker dostaje tylko widoki,
   * liczby, odpowiedź, warianty, teksty elementów wymaganych i podpowiedź (plus materiał, gdy przedmiot
   * go wymaga); grader — wejście ścieżki szkolnej z odpowiedzią rozwiązującego. Liczniki
   * niesprawdzonych pozycji zwraca wołającemu: liczą się tylko w paczce, która nie kończy się odmową.
   */
  async function runChecks(
    prechecked: readonly PrecheckEntry[],
    topic: LessonTopic,
  ): Promise<{ readonly checks: CandidateChecks[]; readonly hintUnavailable: number; readonly openUnavailable: number }> {
    const hintTypes = agentPolicy.hintJudgeTypes ?? [];
    const openTypes = agentPolicy.openAnswerCheckTypes ?? [];
    const grader = args.grader;
    const { checkRun } = args;
    const solveIndexes: number[] = [];
    const judgeIndexes: number[] = [];
    const hintIndexes: number[] = [];
    const hintKeys: string[] = [];
    const hintItems: { view: string; answer: string; requiredElements: readonly string[]; hint: string }[] = [];
    const openItems: (OpenItem & { readonly view: string })[] = [];
    const hintMemoHits = new Map<number, AgentHintVerdict>();
    const openMemoHits = new Map<number, OpenCheckOutcome>();

    // Wejścia checkera i gradera powstają poza obsługą błędów dostawcy (błąd widoku to błąd kodu, nie `unavailable`).
    prechecked.forEach((entry, index) => {
      if (!entry.pass) return;
      const { draft } = entry;
      if (agentPolicy.blindSolveTypes.includes(draft.exerciseType)) solveIndexes.push(index);
      if (agentPolicy.variantCheckTypes.includes(draft.exerciseType) && draft.acceptedAnswers.length > 0) judgeIndexes.push(index);
      if (hintTypes.includes(draft.exerciseType) && draft.hint !== undefined && draft.hint.trim() !== "") {
        const view = solverView(draft, topic);
        const requiredElements = (draft.requiredElements ?? []).map((element) => element.text);
        const key = hintKey(view, draft.answer, requiredElements, draft.hint);
        const memo = checkRun.hintMemo.get(key);
        if (memo !== undefined) {
          hintMemoHits.set(index, memo);
        } else {
          hintIndexes.push(index);
          hintKeys.push(key);
          hintItems.push({ view, answer: draft.answer, requiredElements, hint: draft.hint });
        }
      }
      if (grader !== undefined && openTypes.includes(draft.exerciseType)) {
        // Brak celu albo kryteriów: kontrola otwarta nie dotyczy pozycji.
        const objective = topic.objectives.find((item) => item.id === draft.objectiveId);
        const criteria = schoolCriteriaOf(draft);
        if (objective === undefined || criteria === undefined) return;
        const view = solverView(draft, topic);
        const key = openKey(draft, view, draft.answer, draft.acceptedAnswers, criteria);
        const memo = checkRun.openMemo.get(key);
        if (memo !== undefined) {
          openMemoHits.set(index, memo);
          return;
        }
        // Otwarty wyłącznik: bez `solveOpen` i gradera (zapamiętany wynik nadal obowiązuje).
        if (checkRun.graderOpen()) return;
        const instruction = lessonInstructionOf(topic, draft);
        openItems.push({
          index,
          key,
          view,
          draft,
          criteria,
          graderInputFor: (answerText) =>
            lessonGraderInput({
              subject: ctx.subject,
              topic,
              objective,
              instruction,
              stimulus: draft.prompt ?? "",
              answer: draft.answer,
              acceptedAnswers: draft.acceptedAnswers,
              schoolCriteria: criteria,
              answerText,
            }),
        });
      }
    });

    const draftAt = (index: number) => (prechecked[index] as Extract<PrecheckEntry, { pass: true }>).draft;
    const material = agentPolicy.checkerNeedsMaterial ? { material: ctx.material } : {};
    const solveItems = solveIndexes.map((index) => ({
      view: solverView(draftAt(index), topic),
      expectedAnswers: expectedAnswerCount(draftAt(index)),
    }));
    const judgeItems = judgeIndexes.map((index) => ({
      view: solverView(draftAt(index), topic),
      answer: draftAt(index).answer,
      variants: [...draftAt(index).acceptedAnswers],
    }));
    const openRequestItems = openItems.map((item) => ({ view: item.view }));

    // Etap 1: miejsca semafora checkera zwalniają się przed etapem 2.
    const [solved, judged, hinted, solvedOpen] = await Promise.all([
      solveItems.length === 0
        ? null
        : callChecker(async (signal) => (await args.checker.solve({ items: solveItems, ...material }, args.cost, signal)).answers, isList),
      judgeItems.length === 0
        ? null
        : callChecker(
            async (signal) => (await args.checker.judgeVariants({ items: judgeItems, ...material }, args.cost, signal)).equivalent,
            isList,
          ),
      hintItems.length === 0
        ? null
        : callChecker(async (signal) => {
            // Liczone tylko przy faktycznym wywołaniu (pozycje wysłane).
            args.onStats?.({ hintChecks: hintItems.length });
            return (await args.checker.judgeHints({ items: hintItems, ...material }, args.cost, signal)).verdicts;
          }, isList),
      openRequestItems.length === 0
        ? null
        : callChecker(async (signal) => {
            args.onStats?.({ openChecks: openRequestItems.length });
            return (await args.checker.solveOpen({ items: openRequestItems, ...material }, args.cost, signal)).answers;
          }, isList),
    ]);

    // Etap 2: grader dla pozycji z parą odpowiedzi; pozycja bez pary jest niesprawdzona.
    const openResults = new Map<number, CheckResult<OpenCheckOutcome>>();
    const pairs: { item: OpenItem; pair: readonly [string, string] }[] = [];
    openItems.forEach((item, position) => {
      const pair = solvedOpen === null ? undefined : solvedOpen[position];
      if (isOpenPair(pair)) pairs.push({ item, pair });
      else openResults.set(item.index, { kind: "unavailable" });
    });
    // Wyłącznik otwarty w trakcie etapu 1 (np. przez inne zagadnienie): pozycje jeszcze bez oceny
    // nie dotyczą (`na`, bez noty i bez `openUnavailable`), jak paczka po otwarciu wyłącznika.
    if (checkRun.graderOpen()) pairs.length = 0;
    const graded = grader === undefined ? [] : await gradeOpen(grader, pairs);
    pairs.forEach(({ item }, position) => {
      const result = graded[position]!;
      openResults.set(item.index, result);
      // Pamięć runu: tylko wyniki `done`.
      if (result.kind === "done") checkRun.openMemo.set(item.key, result.value);
    });

    const hintResults = new Map<number, CheckResult<AgentHintVerdict>>();
    hintIndexes.forEach((index, position) => {
      const result = checkAt(hintIndexes, hinted, index, isHintVerdict);
      hintResults.set(index, result);
      if (result.kind === "done") checkRun.hintMemo.set(hintKeys[position]!, result.value);
    });

    const hintUnavailable = [...hintResults.values()].filter((result) => result.kind === "unavailable").length;
    const openUnavailable = [...openResults.values()].filter((result) => result.kind === "unavailable").length;

    const memoOr = <T>(memo: ReadonlyMap<number, T>, results: ReadonlyMap<number, CheckResult<T>>, index: number): CheckResult<T> => {
      const remembered = memo.get(index);
      if (remembered !== undefined) return { kind: "done", value: remembered };
      return results.get(index) ?? { kind: "na" };
    };
    const checks = prechecked.map((entry, index) => ({
      solve: checkAt(solveIndexes, solved, index, isStringList),
      variants: checkAt(judgeIndexes, judged, index, (value): value is readonly boolean[] =>
        entry.pass && isVerdictList(value, entry.draft.acceptedAnswers.length),
      ),
      hint: memoOr(hintMemoHits, hintResults, index),
      open: memoOr(openMemoHits, openResults, index),
    }));
    return { checks, hintUnavailable, openUnavailable };
  }

  // Opisy reguł wysłane już modelowi w tym zagadnieniu: każdy id najwyżej raz (spec katalogu reguł §4.1).
  const describedRules = new Set<string>();
  const textContext = ruleTextContextOf(ctx.subject);

  /** Tekst dla modelu bez sufiksu runu w slugach rodzin (model pisał slug bez sufiksu, `familyBase`). */
  const withoutRunSuffix = (text: string): string =>
    args.familyScope === null ? text : text.replace(/[A-Za-z0-9_-]+/g, (token) => familyBase(token, args.familyScope));

  /** Odrzucenie jako wynik dla modelu i wpis dziennika (bez skutków ubocznych). */
  function rejectedResult(index: number, raw: unknown, exerciseType: string, rejection: Rejection): BuiltResult {
    const detail = rejection.reasons.map(withoutRunSuffix);
    return {
      result: { index, ...echoOf(raw), errors: cappedReasons(detail) },
      ruleIds: shownRuleIds(rejection),
      rejection: {
        objectiveId,
        exerciseType,
        kind: rejection.kind,
        code: rejection.code,
        ruleIds: rejection.ruleIds,
        detail: detail.join("; "),
      },
    };
  }

  /**
   * Wynik przyjęcia z notami: oczyszczenia reguł (`[id] pole: found`; najpierw noty parsowania, potem
   * przyjmowania), pola usunięte bez reguły i brak kontroli.
   */
  function acceptedResult(
    index: number,
    raw: unknown,
    entry: Extract<AdmitEntry, { accepted: string }>,
    parseNotes: readonly LessonRuleIssue[],
  ): BuiltResult {
    const issues = [...parseNotes, ...entry.notes];
    const noted = new Set(issues.map((issue) => issue.field));
    const notes = [
      ...issues.map((issue) => withoutRunSuffix(formatRuleReason(issue))),
      ...entry.sanitized.filter((field) => !noted.has(field)).map((field) => `${field} removed`),
      ...(entry.unchecked ? ["unchecked: a check by another model was unavailable; accepted without it"] : []),
    ];
    return {
      result: { index, ...echoOf(raw), accepted: entry.accepted, ...(notes.length === 0 ? {} : { notes }) },
      ruleIds: [...new Set(issues.map((issue) => issue.rule as string))],
    };
  }

  /**
   * Mapa opisów reguł wyniku: reguły jeszcze nieopisane w zagadnieniu, z dopiskiem przedmiotu. Czysta —
   * pamięć `describedRules` uzupełnia `submit` dopiero po podmianie stanu.
   */
  function rulesMap(built: readonly BuiltResult[]): Record<string, string> {
    const notes = ctx.subject.agentPolicy.ruleNotes ?? {};
    const rules: Record<string, string> = {};
    for (const id of built.flatMap((item) => item.ruleIds)) {
      if (describedRules.has(id) || Object.hasOwn(rules, id)) continue;
      const rule = ruleOf(ctx.subject, id as RuleId);
      if (rule !== undefined) rules[id] = describeRule(rule, textContext, notes[id]);
    }
    return rules;
  }

  async function submit(raw: unknown): Promise<LessonAgentToolOutcome> {
    const input = raw !== null && typeof raw === "object" ? (raw as { exercises?: unknown; examples?: unknown }) : {};
    const { exercises, examples } = input;

    // 1. Odmowa bez przyjęcia.
    if (isClosed()) return refuse("refused_closed", exercises, examples);
    if (args.cost.exhausted()) return refuse("refused_budget", exercises, examples);
    if (!Array.isArray(exercises)) {
      return {
        results: [{ index: 0, exerciseType: null, stimulus: "", errors: ["exercises must be an array"] }],
        ...(examples === undefined ? {} : { examples: { accepted: 0, errors: ["examples were not processed because exercises must be an array"] } }),
        ...statusOf(args.getState()),
      };
    }

    args.onStats?.({ submitted: exercises.length });

    // 2. Parsowanie i wspólna sanityzacja (§7.2).
    const parsed = exercises.map(parseRecord);
    const drafts: LessonExerciseDraft[] = [];
    const draftIndexOf = new Map<number, number>();
    parsed.forEach((record, index) => {
      if (!record.ok) return;
      draftIndexOf.set(index, drafts.length);
      drafts.push(record.draft);
    });

    // 3–4. Przykłady i precheck na roboczej kopii bieżącego stanu.
    const ownExamples = !args.examplesFixed && examples !== undefined;
    const base = args.getState();
    const working = ownExamples ? submitExamples(base, objectiveId, examples, ctx).state : base;
    const prechecked = precheckBatch(working, objectiveId, drafts, ctx);

    // 5. Checker.
    const { checks, hintUnavailable, openUnavailable } = await runChecks(prechecked, working.topic);

    // 6. Zamknięte narzędzia albo przerwane zagadnienie: odmowa bez przyjęcia, stan bez zmian
    // (bez liczników niesprawdzonych pozycji — paczka nie została rozpatrzona).
    if (isClosed()) return refuse("refused_closed", exercises, examples);
    if (hintUnavailable > 0 || openUnavailable > 0) args.onStats?.({ hintUnavailable, openUnavailable });

    // SEKCJA KRYTYCZNA: od odczytu stanu do podmiany NIE MA żadnego `await` — inne zagadnienia
    // zmieniają wspólny stan wyłącznie między naszymi `await`, więc przyjęcie widzi bieżący stan
    // i nie nadpisuje cudzych zmian. Nie dopisuj tu operacji asynchronicznych. Wynik dla modelu
    // powstaje PRZED podmianą stanu: wyjątek formatowania zostawia stan (i pamięć opisów) bez zmian.
    const current = args.getState();
    const examplesStep = ownExamples ? submitExamples(current, objectiveId, examples, ctx) : undefined;
    const admitted = admitBatch(examplesStep?.state ?? current, objectiveId, prechecked, checks, ctx);
    const built = parsed.map((record, index): BuiltResult => {
      const raw: unknown = exercises[index];
      if (!record.ok) return rejectedResult(index, raw, record.exerciseType, record.rejection);
      const draftIndex = draftIndexOf.get(index)!;
      const entry = admitted.results[draftIndex]!;
      return "rejected" in entry
        ? rejectedResult(index, raw, drafts[draftIndex]!.exerciseType, entry.rejected)
        : acceptedResult(index, raw, entry, record.notes);
    });
    const rules = rulesMap(built);
    let examplesOutcome: ExamplesOutcome | undefined;
    if (examplesStep !== undefined) examplesOutcome = { accepted: examplesStep.accepted, errors: examplesStep.errors };
    else if (examples !== undefined) examplesOutcome = { accepted: 0, errors: ["examples are fixed by the plan"] };
    const outcome: LessonAgentToolOutcome = {
      results: built.map((item) => item.result),
      ...(Object.keys(rules).length === 0 ? {} : { rules }),
      ...(examplesOutcome === undefined ? {} : { examples: examplesOutcome }),
      ...statusOf(admitted.state),
    };
    args.setState(admitted.state);
    for (const id of Object.keys(rules)) describedRules.add(id);
    // Koniec sekcji krytycznej.

    for (const item of built) if (item.rejection !== undefined) args.onRejection(item.rejection);
    const acceptedEntries = admitted.results.filter((entry): entry is Extract<AdmitEntry, { accepted: string }> => "accepted" in entry);
    args.onStats?.({
      accepted: acceptedEntries.length,
      checkUnavailable: acceptedEntries.filter((entry) => entry.unchecked).length,
      hintsRemoved: acceptedEntries.filter((entry) => entry.notes.some((issue) => issue.rule === HINT_REMOVED_RULE)).length,
      variantsRemoved: acceptedEntries.reduce((sum, entry) => sum + entry.removedVariants.length, 0),
      quotesSnapped: acceptedEntries.reduce((sum, entry) => sum + entry.quotesSnapped, 0),
    });
    return outcome;
  }

  async function remove(id: unknown): Promise<LessonAgentToolOutcome & { readonly removed: readonly string[] }> {
    if (isClosed()) {
      args.onRefusal?.("refused_closed");
      return { results: [{ index: 0, exerciseType: null, stimulus: "", errors: [REFUSAL_TEXT.refused_closed] }], removed: [], ...statusOf(args.getState()) };
    }
    const text = String(id);
    // Synchronicznie: odczyt i podmiana stanu bez `await` pomiędzy.
    const outcome = removeExercise(args.getState(), objectiveId, text, ctx);
    if (outcome.removed.length === 0) {
      return {
        results: [{ index: 0, exerciseType: null, stimulus: "", errors: [`there is no exercise "${text}" in this objective's pool`] }],
        removed: [],
        ...statusOf(outcome.state),
      };
    }
    args.setState(outcome.state);
    return { results: [], removed: outcome.removed, ...statusOf(outcome.state) };
  }

  const tools: LessonObjectiveAgentTools = {
    submit: (raw) => exclusive(() => submit(raw)),
    remove: (id) => exclusive(() => remove(id)),
    shouldStop: () => isClosed() || args.cost.exhausted() || objectiveStatusFor(args.getState(), objectiveId, ctx, args.addMode).complete,
  };

  return {
    tools,
    close: async () => {
      closed = true;
      closing.abort(REFUSAL_TEXT.refused_closed);
      await tail;
    },
  };
}
