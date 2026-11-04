import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { graderConfigured } from "../../packages/server/src/config";
import { withConfigDefaults } from "../../packages/server/src/config-defaults";
import { agentObjectivesOf, asAgentCapable, type AgentCapableSubject } from "../../packages/server/src/domain/lessons/agent/capable";
import { allExamples, createLessonAgentState, orderedLesson, withExamples, withPool, type LessonAgentState } from "../../packages/server/src/domain/lessons/agent/state";
import { lessonInvariantCheck } from "../../packages/server/src/domain/lessons/agent/status";
import { cardExposureSources } from "../../packages/server/src/domain/lessons/card-exposure-sources";
import { findExposureLeaks } from "../../packages/server/src/domain/lessons/exposure-leaks";
import { defaultPoolSize } from "../../packages/server/src/domain/lessons/lesson-policy";
import { validatePool } from "../../packages/server/src/domain/lessons/pool-validation";
import { createProductionSubjectRegistry } from "../../packages/server/src/domain/lessons/subjects";
import type { DynamicObjectiveKind, DynamicTopicData, LessonExerciseDraft, LessonTopic } from "../../packages/server/src/domain/lessons/types";
import { mergeExamples } from "../../packages/server/src/modules/materials/lessons/lesson-drafts";
import {
  runLessonPoolAgent,
  type AgentObjectiveSource,
  type LessonPoolAgentResult,
} from "../../packages/server/src/modules/materials/lessons/lesson-pool-agent";
import { DEFAULT_LESSON_AGENT_POLICY } from "../../packages/server/src/modules/materials/lessons/lesson-pool-agent-policy";
import type { LessonExerciseCheckerProvider, LessonPoolAgentProvider, RunCostSink } from "../../packages/server/src/ports/ai";
import { endpointKeyFromEnv, isSecureOpenRouterEndpoint } from "../../packages/server/src/providers/openrouter-key";
import { AiSdkExerciseChecker, AiSdkLessonPoolAgent } from "./ai-sdk-lesson-agent";
import {
  appendProvisionalCostEntry,
  assertWithinCostCap,
  costCapFromEnv,
  errorClassOf,
  initCostLedger,
  probeEndpointHost,
  readCostLedger,
  settleCostEntry,
  sha256File,
} from "./probe-costs";
import { loadDotEnv, resolveOutsideRepoPath } from "./probe-helpers";

/**
 * Próba agenta puli lekcji na PRAWDZIWYCH modelach (`pnpm probe:agent`; etap 1 issue #237,
 * spec §8 i §9.5). Zastępuje `agent-generation-v2` z PoC i NIE MA własnych reguł: woła
 * `runLessonPoolAgent` (kierownik, rdzeń domenowy i polityka przedmiotu), a z modelami łączy
 * go tymczasowa implementacja portów na AI SDK (`ai-sdk-lesson-agent.ts`). Bez bazy.
 *
 * KOSZTY: każde uruchomienie to płatne wywołania OpenRouter (podagenci zagadnień, planista,
 * checker). Przed płatnym przebiegiem wymagana zgoda właściciela. Run ma budżet
 * `UMIEM_PROBE_AGENT_BUDGET_USD` (domyślnie budżet polityki agenta, 1,00 USD; spec §9.5: 0,40 na
 * przebieg) — kierownik przestaje przyjmować pracę po jego wyczerpaniu, ale żądania w locie
 * mogą go przekroczyć. Rejestr kosztów (`UMIEM_PROBE_COSTS`, wymagany) jak w `probe:chapter`:
 * „wydane + budżet runu > limit → stop” przed pierwszym wywołaniem, wpis tymczasowy z
 * budżetem, po próbie (także po błędzie) rozliczenie: zmierzony `usage.cost` + szacunek
 * polityki za każde żądanie bez kosztu (flaga `estimated`).
 *
 * Pomijana bez klucza (`OPENROUTER_API_KEY` z .env, a bez niego `UMIEM_LLM_API_KEY`, gdy
 * `UMIEM_LLM_BASE_URL` to https OpenRouter — ta sama reguła co `endpointKeyFromEnv`) albo bez wejścia (`UMIEM_PROBE_AGENT_MATERIAL`
 * lub `UMIEM_PROBE_AGENT_OBJECTIVES_DUMP`). Zmienne:
 * - `UMIEM_PROBE_AGENT_SUBJECT` — `chapter` (domyślnie; planista + bramki rozdziału), `grammar`
 *   albo `school`; gramatyka i szkoła wymagają zrzutu zagadnień;
 * - `UMIEM_PROBE_AGENT_MATERIAL` — plik materiału (rozdział z planistą; przy zrzucie nadpisuje
 *   jego materiał);
 * - `UMIEM_PROBE_AGENT_OBJECTIVES_DUMP` — zrzut zagadnień `probe:chapter`
 *   (`UMIEM_PROBE_POOL_DUMP_OUT`): zagadnienia z kartami `{ title, body }[]`, materiał i temat;
 *   zagadnienia przechodzą do kierownika jako źródło `input` (temat dynamiczny) albo `catalog`
 *   (gramatyka). Przykłady kart dostarcza wtedy model przez `submit`, jak w potoku;
 * - `UMIEM_PROBE_AGENT_MODEL` (domyślnie DeepSeek V4.1 Flash), `UMIEM_PROBE_AGENT_REASONING`
 *   (`low`), `UMIEM_PROBE_AGENT_SOLVER_MODEL` (checker; domyślnie inna rodzina niż generator),
 *   `UMIEM_PROBE_AGENT_TOPIC` (tytuł tematu planisty, domyślnie ze zrzutu albo „Unit 1”);
 * - `UMIEM_PROBE_AGENT_TIMEOUT_MS` — termin runu (domyślnie polityki), `UMIEM_PROBE_AGENT_BUDGET_USD`,
 *   `UMIEM_PROBE_AGENT_POOL_SIZE` (domyślnie `defaultPoolSize` liczby zagadnień, jak potok;
 *   planista: liczba nieznana przed planem → podstawa 60);
 * - `UMIEM_PROBE_AGENT_DUMP` — `dump.json` (źródło `agent`) w formacie
 *   `blind/gen-blind-sheet.cjs` (+ `objectives[].status`, `rejections[].detail`, statystyki,
 *   kroki, koszt, wynik kontroli końcowej); istniejący plik nie jest nadpisywany;
 * - `UMIEM_PROBE_COSTS` — rejestr `costs.json` (musi istnieć; nowy zakłada `UMIEM_PROBE_COSTS_INIT=1`
 *   z limitem `UMIEM_PROBE_COSTS_CAP_USD`, domyślnie 10 USD; limit istniejącego rejestru się nie zmienia).
 * Wszystkie ścieżki wyłącznie poza repozytorium (`resolveOutsideRepoPath`). Na konsolę idą
 * wyłącznie liczby, statusy i człony identyfikatorów zagadnień — treść ćwiczeń, materiału,
 * kart i `detail` odrzuceń tylko w zrzucie poza repozytorium.
 *
 * Na końcu próba sama sprawdza stan końcowy (spec §9.5): `lessonInvariantCheck` pusty, 0
 * twardych ujawnień (`findExposureLeaks`, tryb `coverage`), `validatePool` i
 * `validatePoolExtra` całej lekcji bez błędów, każde zagadnienie ze statusem; liczbę ujawnień w
 * trybie `generation` raportuje (różnica trybów, bez asercji).
 */

loadDotEnv();
const llmBaseUrl = process.env.UMIEM_LLM_BASE_URL?.trim() || undefined;
// Próba woła wyłącznie https OpenRouter, więc klucz generatora tylko wtedy, gdy i on tam wskazuje.
const apiKey =
  process.env.OPENROUTER_API_KEY?.trim() ||
  (isSecureOpenRouterEndpoint(llmBaseUrl) ? endpointKeyFromEnv(process.env, "UMIEM_LLM", llmBaseUrl)?.trim() : undefined) ||
  undefined;
const materialEnv = process.env.UMIEM_PROBE_AGENT_MATERIAL?.trim() || undefined;
const objectivesDumpEnv = process.env.UMIEM_PROBE_AGENT_OBJECTIVES_DUMP?.trim() || undefined;
const enabled = apiKey !== undefined && (materialEnv !== undefined || objectivesDumpEnv !== undefined);

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash-1017";
const DEFAULT_SOLVER_FOR_GOOGLE = "deepseek/deepseek-v4.1-flash-1017";
const DEFAULT_SOLVER = "google/gemini-3.8-flash";
const SUBJECT_IDS = { chapter: "english_chapter", grammar: "english_grammar", school: "school" } as const;
type SubjectKind = keyof typeof SUBJECT_IDS;

/** Zrzut zagadnień `probe:chapter` (`UMIEM_PROBE_POOL_DUMP_OUT`); karty jako tablica. */
interface ObjectivesDump {
  readonly subjectId: string;
  readonly topicId: string;
  readonly topicVersion?: number;
  readonly topicTitle: string;
  readonly material: string;
  readonly objectives: readonly {
    readonly id: string;
    readonly title: string;
    readonly kind?: DynamicObjectiveKind | null;
    readonly descriptionEn: string;
    readonly cards: readonly { readonly title: string; readonly body: string }[];
  }[];
}

function line(text = ""): void {
  console.log(text);
}

const slugOf = (id: string): string => id.split(".").at(-1) ?? id;

function readObjectivesDump(path: string): ObjectivesDump {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ObjectivesDump>;
  const valid =
    typeof raw.subjectId === "string" && typeof raw.topicId === "string" && typeof raw.topicTitle === "string" && typeof raw.material === "string" &&
    Array.isArray(raw.objectives) &&
    raw.objectives.every((objective) => typeof objective?.id === "string" && typeof objective.title === "string" && Array.isArray(objective.cards));
  if (!valid) throw new Error(`${basename(path)}: zły kształt zrzutu zagadnień (oczekiwano wyjścia UMIEM_PROBE_POOL_DUMP_OUT z probe:chapter, karty jako tablica)`);
  return raw as ObjectivesDump;
}

/** Źródło zagadnień kierownika ze zrzutu: przedmiot katalogowy → `catalog`, z tematem dynamicznym → `input`. */
function sourceFromDump(subject: AgentCapableSubject, dump: ObjectivesDump): { source: AgentObjectiveSource; topic: LessonTopic } {
  if (subject.buildDynamicTopic === undefined) {
    const candidates = subject.topics.filter((topic) => topic.id === dump.topicId && (dump.topicVersion === undefined || topic.version === dump.topicVersion));
    const catalog = candidates.sort((a, b) => b.version - a.version)[0];
    if (catalog === undefined) throw new Error(`brak tematu ${dump.topicId} w katalogu przedmiotu ${subject.id}`);
    const ids = new Set(dump.objectives.map((objective) => objective.id));
    const topic: LessonTopic = { ...catalog, objectives: catalog.objectives.filter((objective) => ids.has(objective.id)) };
    return { source: { source: "catalog", topic }, topic };
  }
  const dynamicTopic: DynamicTopicData = {
    titlePl: dump.topicTitle,
    objectives: dump.objectives.map((objective) => ({
      id: objective.id,
      titlePl: objective.title,
      descriptionEn: objective.descriptionEn,
      cards: objective.cards.map((card) => ({ title: card.title, body: card.body })),
      ...(objective.kind ? { kind: objective.kind } : {}),
    })),
  };
  return { source: { source: "input", dynamicTopic }, topic: subject.buildDynamicTopic(dynamicTopic) };
}

/** Licznik próby: przechwytuje koszt każdego żądania (generator, checker) obok licznika kierownika. */
class ProbeMeter {
  readonly usd = { generator: 0, checker: 0 };
  readonly calls = { generator: 0, checker: 0 };
  unknownCalls = 0;

  sink(role: "generator" | "checker", inner: RunCostSink): RunCostSink {
    return {
      record: (usd) => {
        this.calls[role] += 1;
        if (usd === null) this.unknownCalls += 1;
        else this.usd[role] += usd;
        inner.record(usd);
      },
    };
  }

  get measuredUsd(): number {
    return this.usd.generator + this.usd.checker;
  }
}

function meteredAgent(inner: LessonPoolAgentProvider, meter: ProbeMeter): LessonPoolAgentProvider {
  return {
    name: inner.name,
    model: inner.model,
    runObjective: (input, tools, cost, signal) => inner.runObjective(input, tools, meter.sink("generator", cost), signal),
    planObjectives: (input, tools, cost, signal) => inner.planObjectives(input, tools, meter.sink("generator", cost), signal),
  };
}

function meteredChecker(inner: LessonExerciseCheckerProvider, meter: ProbeMeter): LessonExerciseCheckerProvider {
  return {
    name: inner.name,
    model: inner.model,
    solve: (input, cost, signal) => inner.solve(input, meter.sink("checker", cost), signal),
    judgeVariants: (input, cost, signal) => inner.judgeVariants(input, meter.sink("checker", cost), signal),
  };
}

/** Stan lekcji odtworzony z wyniku kierownika (pule i przykłady zagadnień) do niezależnej kontroli końcowej. */
function finalState(subject: AgentCapableSubject, topic: LessonTopic, kinds: ReadonlyMap<string, DynamicObjectiveKind>, result: LessonPoolAgentResult): LessonAgentState {
  let state = createLessonAgentState({
    topic,
    objectives: agentObjectivesOf(topic, kinds),
    fixed: [],
    examples: {},
    fixedSources: mergeExamples(cardExposureSources(subject, topic), {}),
  });
  let next = 1;
  for (const settled of result.objectives) {
    state = withPool(state, settled.objectiveId, settled.exercises.map((draft) => ({ id: `ex${next++}`, draft })));
    state = withExamples(state, settled.objectiveId, settled.examples);
  }
  return state;
}

function kindsOf(data: DynamicTopicData | undefined): Map<string, DynamicObjectiveKind> {
  return new Map((data?.objectives ?? []).flatMap((objective) => (objective.kind === undefined ? [] : [[objective.id, objective.kind] as const])));
}

describe.skipIf(!enabled)("próba agenta puli lekcji na prawdziwych modelach", () => {
  it("buduje lekcję przez runLessonPoolAgent i sprawdza stan końcowy", async () => {
    // Przed płatnym wywołaniem: przedmiot, ścieżki, wejścia, host i limit kosztu.
    const subjectEnv = process.env.UMIEM_PROBE_AGENT_SUBJECT?.trim() || "chapter";
    if (!(subjectEnv in SUBJECT_IDS)) throw new Error("UMIEM_PROBE_AGENT_SUBJECT: chapter | grammar | school");
    const subjectKind = subjectEnv as SubjectKind;
    const materialPath = resolveOutsideRepoPath(materialEnv, "UMIEM_PROBE_AGENT_MATERIAL");
    const objectivesDumpPath = resolveOutsideRepoPath(objectivesDumpEnv, "UMIEM_PROBE_AGENT_OBJECTIVES_DUMP");
    const dumpPath = resolveOutsideRepoPath(process.env.UMIEM_PROBE_AGENT_DUMP, "UMIEM_PROBE_AGENT_DUMP");
    const costsPath = resolveOutsideRepoPath(process.env.UMIEM_PROBE_COSTS, "UMIEM_PROBE_COSTS");
    if (costsPath === undefined) throw new Error("UMIEM_PROBE_COSTS jest wymagany (rejestr kosztów costs.json poza repozytorium)");
    if (dumpPath !== undefined && existsSync(dumpPath)) throw new Error(`${dumpPath} już istnieje — zrzut płatnej próby nie jest nadpisywany`);
    if (subjectKind !== "chapter" && objectivesDumpPath === undefined) throw new Error("grammar i school wymagają UMIEM_PROBE_AGENT_OBJECTIVES_DUMP");

    const subject = asAgentCapable(createProductionSubjectRegistry().getSubject(SUBJECT_IDS[subjectKind])!);
    const objectivesDump = objectivesDumpPath === undefined ? undefined : readObjectivesDump(objectivesDumpPath);
    if (objectivesDump !== undefined && objectivesDump.subjectId !== subject.id) {
      throw new Error(`zrzut zagadnień jest dla ${objectivesDump.subjectId}, próba dla ${subject.id}`);
    }
    const material = materialPath !== undefined ? readFileSync(materialPath, "utf8") : objectivesDump!.material;
    const fromDump = objectivesDump === undefined ? undefined : sourceFromDump(subject, objectivesDump);
    const objectiveSource: AgentObjectiveSource = fromDump?.source ?? { source: "planner" };
    const topicTitle = process.env.UMIEM_PROBE_AGENT_TOPIC?.trim() || objectivesDump?.topicTitle || "Unit 1";
    const poolSize = Number(process.env.UMIEM_PROBE_AGENT_POOL_SIZE ?? defaultPoolSize(fromDump?.topic.objectives.length ?? 0));
    const runBudgetUsd = Number(process.env.UMIEM_PROBE_AGENT_BUDGET_USD ?? DEFAULT_LESSON_AGENT_POLICY.runBudgetUsd);
    const runTimeoutMs = Number(process.env.UMIEM_PROBE_AGENT_TIMEOUT_MS ?? DEFAULT_LESSON_AGENT_POLICY.runTimeoutMs);
    if (!(poolSize > 0) || !(runBudgetUsd > 0) || !(runTimeoutMs > 0)) throw new Error("UMIEM_PROBE_AGENT_POOL_SIZE, _BUDGET_USD i _TIMEOUT_MS muszą być dodatnie");
    const modelId = process.env.UMIEM_PROBE_AGENT_MODEL?.trim() || DEFAULT_MODEL;
    const solverId = process.env.UMIEM_PROBE_AGENT_SOLVER_MODEL?.trim() || (modelId.startsWith("google/") ? DEFAULT_SOLVER_FOR_GOOGLE : DEFAULT_SOLVER);
    const effort = (process.env.UMIEM_PROBE_AGENT_REASONING?.trim() || "low").toLowerCase();
    // Dane idą wyłącznie do OpenRouter po https (adres stały, sprawdzony tą samą funkcją co w probe:chapter).
    const host = probeEndpointHost(OPENROUTER_BASE_URL, "OpenRouter", undefined);
    // Jak potok: preferencja typów otwartych zależy od obecności modelu oceniającego w konfiguracji.
    const graderAvailable = graderConfigured(withConfigDefaults(process.env));

    const ledger =
      process.env.UMIEM_PROBE_COSTS_INIT === "1"
        ? initCostLedger(costsPath, costCapFromEnv(process.env.UMIEM_PROBE_COSTS_CAP_USD))
        : readCostLedger(costsPath);
    assertWithinCostCap(ledger, runBudgetUsd, `agent ${subjectKind}`);
    if (dumpPath !== undefined) mkdirSync(dirname(dumpPath), { recursive: true });
    const inputLabel = objectivesDumpPath !== undefined ? basename(objectivesDumpPath) : basename(materialPath!);
    const costEntry = { probe: `agent:${subjectKind}`, dump: inputLabel };

    const openrouter = createOpenRouter({ apiKey, baseURL: OPENROUTER_BASE_URL });
    const meter = new ProbeMeter();
    const agent = meteredAgent(new AiSdkLessonPoolAgent({ model: openrouter.chat(modelId, { usage: { include: true } }), effort }), meter);
    const checker = meteredChecker(new AiSdkExerciseChecker({ model: openrouter.chat(solverId, { usage: { include: true } }), effort: "low" }), meter);

    line("");
    line(`=== Próba agenta puli [${subjectKind}, zagadnienia=${objectiveSource.source}] ===`);
    line(
      `model=${modelId} reasoning=${effort} checker=${solverId} host=${host} pula=${poolSize} materiał=${material.length} znaków grader=${graderAvailable}; ` +
        `budżet runu=${runBudgetUsd.toFixed(2)} USD, termin=${(runTimeoutMs / 1000).toFixed(0)} s, wydane dotąd=${ledger.spentUsd.toFixed(4)} z ${ledger.capUsd} USD`,
    );

    // Wpis tymczasowy (budżet runu) przed pierwszym płatnym wywołaniem: zabity proces nadal liczy się do limitu.
    const provisionalId = appendProvisionalCostEntry(costsPath, { at: new Date().toISOString(), ...costEntry, costUsd: runBudgetUsd });
    const started = Date.now();
    let result: LessonPoolAgentResult | undefined;
    let failure: unknown;
    try {
      result = await runLessonPoolAgent(
        {
          agent,
          checker,
          subjects: createProductionSubjectRegistry(),
          policy: { runBudgetUsd, runTimeoutMs },
        },
        {
          runId: randomUUID(),
          subjectId: subject.id,
          deckId: randomUUID(),
          objectiveSource,
          topicTitle,
          material,
          poolSize,
          graderAvailable,
          fixed: [],
          draftExamples: {},
          skipObjectives: [],
          familyScope: null,
          initialSpentUsd: 0,
        },
        new AbortController().signal,
      );
    } catch (error) {
      failure = error;
    } finally {
      // Koszt zawsze do rejestru — także po błędzie: zmierzony + szacunek polityki za żądania bez `usage.cost`.
      const costUsd = meter.measuredUsd + meter.unknownCalls * DEFAULT_LESSON_AGENT_POLICY.unknownCallEstimateUsd;
      const updated = settleCostEntry(costsPath, provisionalId, {
        at: new Date().toISOString(),
        ...costEntry,
        costUsd,
        ...(meter.unknownCalls > 0 ? { estimated: true } : {}),
      });
      line(
        `koszt próby=${costUsd.toFixed(4)} USD (generator ${meter.usd.generator.toFixed(4)} / ${meter.calls.generator} żądań, checker ${meter.usd.checker.toFixed(4)} / ${meter.calls.checker} żądań, ` +
          `bez kosztu: ${meter.unknownCalls}); łącznie wydane=${updated.spentUsd.toFixed(4)} z ${updated.capUsd} USD`,
      );
    }
    const durationMs = Date.now() - started;
    const header = {
      schema: "agent-generation-probe/v1",
      source: "agent",
      at: new Date().toISOString(),
      subjectKind,
      subjectId: subject.id,
      objectiveSource: objectiveSource.source,
      input: objectivesDumpPath !== undefined ? { file: basename(objectivesDumpPath), sha256: sha256File(objectivesDumpPath) } : { file: basename(materialPath!), sha256: sha256File(materialPath!) },
      modelId,
      effort,
      solverId,
      poolSize,
      graderAvailable,
      policy: { runBudgetUsd, runTimeoutMs },
      durationMs,
      costUsd: meter.measuredUsd + meter.unknownCalls * DEFAULT_LESSON_AGENT_POLICY.unknownCallEstimateUsd,
      costs: { generatorUsd: meter.usd.generator, checkerUsd: meter.usd.checker, calls: meter.calls, unknownCalls: meter.unknownCalls },
    };

    if (result === undefined) {
      if (dumpPath !== undefined) writeFileSync(dumpPath, `${JSON.stringify({ ...header, errors: [`${errorClassOf(failure)}: ${failure instanceof Error ? failure.message : String(failure)}`] }, null, 2)}\n`, "utf8");
      line(`Przebieg zakończony wyjątkiem (${errorClassOf(failure)}) po ${(durationMs / 1000).toFixed(0)} s`);
      throw failure;
    }

    const topic = result.dynamicTopic !== undefined ? subject.buildDynamicTopic!(result.dynamicTopic) : fromDump?.topic;
    const kinds = kindsOf(result.dynamicTopic ?? (objectiveSource.source === "input" ? objectiveSource.dynamicTopic : undefined));
    line(`Przebieg: plan=${result.planStatus}${result.planFailure ? ` kod=${result.planFailure.errorCode}` : ""}; czas=${(durationMs / 1000).toFixed(0)} s; ` +
      `wydane wg kierownika=${result.spentUsd.toFixed(4)} USD (bez kosztu: ${result.unknownCostCalls})`);
    line(`Statystyki: ${JSON.stringify(result.stats)}`);
    for (const settled of result.objectives) {
      line(`  ${slugOf(settled.objectiveId)}: ${settled.status}${settled.failure ? ` (${settled.failure.errorCode})` : ""} ćwiczeń=${settled.exercises.length} przykładów=${settled.examples.length} kroki=${settled.steps} braki=${settled.missing.length}`);
    }

    // Kontrola końcowa na stanie odtworzonym z wyniku (niezależna od kierownika).
    let finalCheck: Record<string, unknown> = {};
    let exercises: { id: string; draft: LessonExerciseDraft }[] = [];
    let counts = { invariant: 0, hardCoverage: 0, hardGeneration: 0, softCoverage: 0, poolRejected: 0, extraRejected: 0 };
    if (topic !== undefined) {
      const state = finalState(subject, topic, kinds, result);
      const lesson = orderedLesson(state);
      const examples = allExamples(state);
      const objectiveOrder = state.objectives.map((objective) => objective.id);
      const invariant = lessonInvariantCheck(state, { subject, material, limits: new Map() });
      const coverage = findExposureLeaks({ exercises: lesson, examples, objectiveOrder, subject, mode: "coverage" });
      const generation = findExposureLeaks({ exercises: lesson, examples, objectiveOrder, subject, mode: "generation" });
      const pool = validatePool(lesson, subject, topic, { existingExercises: [] });
      const extra = [...(subject.validatePoolExtra?.(lesson, { material }) ?? new Map<number, readonly string[]>())].filter(([, errors]) => errors.length > 0);
      counts = {
        invariant: invariant.length,
        hardCoverage: coverage.filter((leak) => leak.kind === "hard").length,
        hardGeneration: generation.filter((leak) => leak.kind === "hard").length,
        softCoverage: coverage.filter((leak) => leak.kind === "soft").length,
        poolRejected: pool.rejected.length,
        extraRejected: extra.length,
      };
      exercises = lesson.map((draft, index) => ({ id: `ex${index + 1}`, draft }));
      finalCheck = {
        ...counts,
        invariantViolations: invariant,
        leaks: { coverage, generation },
        validatePool: { valid: pool.valid.length, rejected: pool.rejected.map((item) => ({ index: lesson.indexOf(item.exercise), errors: item.errors })) },
        validatePoolExtra: extra.map(([index, errors]) => ({ index, errors })),
      };
      line(
        `Kontrola końcowa: ćwiczeń=${lesson.length}; niezmiennik=${counts.invariant}; twarde ujawnienia coverage=${counts.hardCoverage}, generation=${counts.hardGeneration} ` +
          `(różnica trybów ${counts.hardGeneration - counts.hardCoverage}); miękkie coverage=${counts.softCoverage}; validatePool odrzucone=${counts.poolRejected}; validatePoolExtra=${counts.extraRejected}`,
      );
    }

    if (dumpPath !== undefined) {
      const byId = new Map(result.objectives.map((settled) => [settled.objectiveId, settled]));
      const dump = {
        ...header,
        planStatus: result.planStatus,
        ...(result.planFailure ? { planFailure: result.planFailure } : {}),
        errors: [],
        spentUsd: result.spentUsd,
        unknownCostCalls: result.unknownCostCalls,
        agentSteps: Object.fromEntries(result.objectives.map((settled) => [slugOf(settled.objectiveId), settled.steps])),
        stats: result.stats,
        rejections: result.rejections,
        objectives: (topic?.objectives ?? []).map((objective) => {
          const settled = byId.get(objective.id);
          return {
            id: objective.id,
            title: objective.titlePl,
            titlePl: objective.titlePl,
            kind: kinds.get(objective.id) ?? null,
            descriptionEn: objective.descriptionEn,
            card: objective.cards.map((card) => `[${card.title}] ${card.body}`).join("\n"),
            cards: objective.cards.map((card) => ({ title: card.title, body: card.body })),
            examples: settled?.examples ?? [],
            status: settled?.status ?? null,
            missing: settled?.missing ?? [],
            ...(settled?.failure ? { failure: settled.failure } : {}),
          };
        }),
        exercises: exercises.map((entry) => ({ id: entry.id, ...entry.draft })),
        statuses: Object.fromEntries(result.objectives.map((settled) => [slugOf(settled.objectiveId), { status: settled.status, missing: settled.missing }])),
        finalCheck,
      };
      writeFileSync(dumpPath, `${JSON.stringify(dump, null, 2)}\n`, "utf8");
      line(`Zrzut: ${dumpPath}`);
    }

    // Kryteria spec §9.5 (liczby w asercjach; treść tylko w zrzucie).
    expect(result.planStatus).not.toBe("plan_failed");
    expect(topic).toBeDefined();
    expect(result.objectives.map((settled) => settled.objectiveId)).toEqual(topic!.objectives.map((objective) => objective.id));
    expect(result.objectives.every((settled) => ["complete", "incomplete", "failed"].includes(settled.status))).toBe(true);
    expect(counts.invariant).toBe(0);
    expect(counts.hardCoverage).toBe(0);
    expect(counts.poolRejected).toBe(0);
    expect(counts.extraRejected).toBe(0);
  });
});
