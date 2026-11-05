import {
  admitBatch,
  precheckBatch,
  removeExercise,
  submitExamples,
  type AdmitEntry,
  type AgentCheckContext,
  type CandidateChecks,
  type CheckResult,
  type PrecheckEntry,
  type Rejection,
} from "../../../domain/lessons/agent/admission";
import { expectedAnswerCount, solverView } from "../../../domain/lessons/agent/solver";
import type { LessonAgentState } from "../../../domain/lessons/agent/state";
import { objectiveStatusFor } from "../../../domain/lessons/agent/status";
import type { LessonExerciseDraft, LessonTopic } from "../../../domain/lessons/types";
import type { LessonAgentToolOutcome, LessonExerciseCheckerProvider, LessonObjectiveAgentTools } from "../../../ports/ai";
import { deadlineSignal, untilAborted, type Semaphore } from "./lesson-agent-timers";
import { isWellShapedRawExercise, stripParentAddedFlags, toExerciseDraft } from "./lesson-drafts";
import type { LessonAgentPolicy, RunBudgetSink } from "./lesson-pool-agent-policy";
import { sanitizeFreshLessonDraft } from "./lesson-pool-acceptance";

/**
 * Narzędzia podagenta jednego zagadnienia (spec etapu 1 §7.1 pkt 4–5): mutex
 * zagadnienia, parsowanie i sanityzacja surowych rekordów, paczkowe wywołania
 * checkera (wspólny semafor, termin), synchroniczne przyjęcie do wspólnego stanu
 * lekcji, budżet i zamknięcie. Teksty dla modelu są po angielsku.
 */

/** Wpis odrzucenia dla kierownika: `code` bez treści (logi), `detail` z treścią tylko w pamięci wyniku. */
export interface RejectionLogEntry {
  readonly objectiveId: string;
  readonly exerciseType: string;
  readonly kind: Rejection["kind"];
  readonly code: string;
  readonly detail: string;
}

/** Odmowa całego wywołania (bez przyjęcia); nie jest odrzuceniem ćwiczenia. */
export type ToolRefusalCode = "refused_budget" | "refused_closed";

/**
 * Przyrosty statystyk runu: `submitted` — rekordy wywołań przetworzonych (bez odmowy na wejściu),
 * `accepted` — przyjęte do puli, `checkerCalls` — faktyczne wywołania checkera, `checkUnavailable` —
 * przyjęte bez wyniku checkera (`unchecked`).
 */
export interface ObjectiveToolsStats {
  readonly submitted: number;
  readonly accepted: number;
  readonly checkerCalls: number;
  readonly checkUnavailable: number;
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
  onRejection(entry: RejectionLogEntry): void;
  /** Opcjonalnie: odmowa całego wywołania (statystyka `refused` kierownika). */
  onRefusal?(code: ToolRefusalCode): void;
  /** Opcjonalnie: przyrosty statystyk runu kierownika. */
  onStats?(delta: Partial<ObjectiveToolsStats>): void;
}

const REFUSAL_TEXT: Readonly<Record<ToolRefusalCode, string>> = {
  refused_closed: "tools are closed",
  refused_budget: "budget exhausted",
};

const CHECKER_TIMEOUT_REASON = "checker_timeout";

type ToolResult = LessonAgentToolOutcome["results"][number];
type ExamplesOutcome = NonNullable<LessonAgentToolOutcome["examples"]>;

type ParsedRecord =
  | { readonly ok: true; readonly draft: LessonExerciseDraft }
  | { readonly ok: false; readonly exerciseType: string; readonly rejection: Rejection };

const noop = () => undefined;

function rawExerciseType(raw: unknown): string {
  const type = raw !== null && typeof raw === "object" ? (raw as { exerciseType?: unknown }).exerciseType : undefined;
  return typeof type === "string" ? type : "unknown";
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isVerdictList(value: unknown, length: number): value is readonly boolean[] {
  return Array.isArray(value) && value.length === length && value.every((item) => typeof item === "boolean");
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
      ? exercises.map((_raw, index) => ({ index, errors: [message] }))
      : [{ index: 0, errors: [message] }];
    return {
      results,
      ...(examples === undefined ? {} : { examples: { accepted: 0, errors: [message] } }),
      ...statusOf(args.getState()),
    };
  }

  function parseRecord(raw: unknown): ParsedRecord {
    if (!isWellShapedRawExercise(raw)) {
      return {
        ok: false,
        exerciseType: rawExerciseType(raw),
        rejection: {
          kind: "shape",
          code: "shape_malformed",
          reasons: [
            "the exercise record is malformed: exerciseType, objectiveId and answer must be strings, and list fields must be arrays of the expected objects",
          ],
        },
      };
    }
    const draft = toExerciseDraft(raw);
    if (draft.objectiveId !== objectiveId) {
      return {
        ok: false,
        exerciseType: draft.exerciseType,
        rejection: {
          kind: "shape",
          code: "shape_objective",
          reasons: [`objectiveId must be "${objectiveId}" (this objective), not "${draft.objectiveId}"`],
        },
      };
    }
    const sanitized = sanitizeFreshLessonDraft(draft, ctx.subject, args.familyScope).draft;
    return { ok: true, draft: stripParentAddedFlags([sanitized])[0]! };
  }

  /**
   * Jedno wywołanie checkera pod semaforem i terminem; `null` = cała paczka `unavailable`. `request`
   * tylko woła dostawcę: wejście (widoki) buduje wołający przed wywołaniem, więc błąd w budowaniu
   * widoku jest wyjątkiem, a nie maskowanym `unavailable`.
   */
  async function callChecker(request: (signal: AbortSignal) => Promise<readonly unknown[]>): Promise<readonly unknown[] | null> {
    return args.checkerSemaphore.run(async () => {
      // Budżet sprawdzany przed każdym wywołaniem (po oczekiwaniu na semafor).
      if (args.cost.exhausted() || isClosed()) return null;
      args.onStats?.({ checkerCalls: 1 });
      const deadline = deadlineSignal(checkerParent, policy.checkerTimeoutMs, CHECKER_TIMEOUT_REASON);
      try {
        // Wyścig z terminem: checker ignorujący sygnał nie trzyma miejsca w semaforze ani `close()`.
        const values = await untilAborted(request(deadline.signal), deadline.signal);
        return Array.isArray(values) ? values : null;
      } catch {
        return null;
      } finally {
        deadline.dispose();
      }
    });
  }

  /** Krok 5: jedno `solve` i jedno `judgeVariants` na paczkę, równolegle; tylko widoki, liczby, odpowiedź i warianty. */
  async function runChecks(prechecked: readonly PrecheckEntry[], topic: LessonTopic): Promise<CandidateChecks[]> {
    const solveIndexes: number[] = [];
    const judgeIndexes: number[] = [];
    prechecked.forEach((entry, index) => {
      if (!entry.pass) return;
      if (agentPolicy.blindSolveTypes.includes(entry.draft.exerciseType)) solveIndexes.push(index);
      if (agentPolicy.variantCheckTypes.includes(entry.draft.exerciseType) && entry.draft.acceptedAnswers.length > 0) {
        judgeIndexes.push(index);
      }
    });
    const draftAt = (index: number) => (prechecked[index] as Extract<PrecheckEntry, { pass: true }>).draft;
    const material = agentPolicy.checkerNeedsMaterial ? { material: ctx.material } : {};
    // Wejścia checkera powstają poza obsługą błędów dostawcy (błąd widoku to błąd kodu, nie `unavailable`).
    const solveItems = solveIndexes.map((index) => ({
      view: solverView(draftAt(index), topic),
      expectedAnswers: expectedAnswerCount(draftAt(index)),
    }));
    const judgeItems = judgeIndexes.map((index) => ({
      view: solverView(draftAt(index), topic),
      answer: draftAt(index).answer,
      variants: [...draftAt(index).acceptedAnswers],
    }));
    const [solved, judged] = await Promise.all([
      solveItems.length === 0
        ? null
        : callChecker(async (signal) => (await args.checker.solve({ items: solveItems, ...material }, args.cost, signal)).answers),
      judgeItems.length === 0
        ? null
        : callChecker(
            async (signal) => (await args.checker.judgeVariants({ items: judgeItems, ...material }, args.cost, signal)).equivalent,
          ),
    ]);
    return prechecked.map((entry, index) => ({
      solve: checkAt(solveIndexes, solved, index, isStringList),
      variants: checkAt(judgeIndexes, judged, index, (value): value is readonly boolean[] =>
        entry.pass && isVerdictList(value, entry.draft.acceptedAnswers.length),
      ),
    }));
  }

  function logRejection(exerciseType: string, rejection: Rejection): void {
    args.onRejection({
      objectiveId,
      exerciseType,
      kind: rejection.kind,
      code: rejection.code,
      detail: rejection.reasons.join("; "),
    });
  }

  function admittedResult(index: number, entry: AdmitEntry, draft: LessonExerciseDraft): ToolResult {
    if ("rejected" in entry) {
      logRejection(draft.exerciseType, entry.rejected);
      return { index, errors: entry.rejected.reasons };
    }
    const notes = [...entry.sanitized, ...(entry.unchecked ? ["unchecked"] : [])];
    return notes.length === 0 ? { index, accepted: entry.accepted } : { index, accepted: entry.accepted, note: notes.join(", ") };
  }

  async function submit(raw: unknown): Promise<LessonAgentToolOutcome> {
    const input = raw !== null && typeof raw === "object" ? (raw as { exercises?: unknown; examples?: unknown }) : {};
    const { exercises, examples } = input;

    // 1. Odmowa bez przyjęcia.
    if (isClosed()) return refuse("refused_closed", exercises, examples);
    if (args.cost.exhausted()) return refuse("refused_budget", exercises, examples);
    if (!Array.isArray(exercises)) {
      return {
        results: [{ index: 0, errors: ["exercises must be an array"] }],
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
    const checks = await runChecks(prechecked, working.topic);

    // 6. Zamknięte narzędzia albo przerwane zagadnienie: odmowa bez przyjęcia, stan bez zmian.
    if (isClosed()) return refuse("refused_closed", exercises, examples);

    // SEKCJA KRYTYCZNA: od odczytu stanu do podmiany NIE MA żadnego `await` — inne zagadnienia
    // zmieniają wspólny stan wyłącznie między naszymi `await`, więc przyjęcie widzi bieżący stan
    // i nie nadpisuje cudzych zmian. Nie dopisuj tu operacji asynchronicznych.
    const current = args.getState();
    const examplesStep = ownExamples ? submitExamples(current, objectiveId, examples, ctx) : undefined;
    const admitted = admitBatch(examplesStep?.state ?? current, objectiveId, prechecked, checks, ctx);
    args.setState(admitted.state);
    // Koniec sekcji krytycznej.

    const acceptedEntries = admitted.results.filter((entry) => "accepted" in entry);
    args.onStats?.({
      accepted: acceptedEntries.length,
      checkUnavailable: acceptedEntries.filter((entry) => "accepted" in entry && entry.unchecked).length,
    });

    const results = parsed.map((record, index): ToolResult => {
      if (!record.ok) {
        logRejection(record.exerciseType, record.rejection);
        return { index, errors: record.rejection.reasons };
      }
      const draftIndex = draftIndexOf.get(index)!;
      return admittedResult(index, admitted.results[draftIndex]!, drafts[draftIndex]!);
    });
    let examplesOutcome: ExamplesOutcome | undefined;
    if (examplesStep !== undefined) examplesOutcome = { accepted: examplesStep.accepted, errors: examplesStep.errors };
    else if (examples !== undefined) examplesOutcome = { accepted: 0, errors: ["examples are fixed by the plan"] };
    return {
      results,
      ...(examplesOutcome === undefined ? {} : { examples: examplesOutcome }),
      ...statusOf(admitted.state),
    };
  }

  async function remove(id: unknown): Promise<LessonAgentToolOutcome & { readonly removed: readonly string[] }> {
    if (isClosed()) {
      args.onRefusal?.("refused_closed");
      return { results: [{ index: 0, errors: [REFUSAL_TEXT.refused_closed] }], removed: [], ...statusOf(args.getState()) };
    }
    const text = String(id);
    // Synchronicznie: odczyt i podmiana stanu bez `await` pomiędzy.
    const outcome = removeExercise(args.getState(), objectiveId, text, ctx);
    if (outcome.removed.length === 0) {
      return {
        results: [{ index: 0, errors: [`there is no exercise "${text}" in this objective's pool`] }],
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
