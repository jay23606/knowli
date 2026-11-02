import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createProductionSubjectRegistry, reviewerFromEnv, withConfigDefaults, type UsageEvent, type UsageRecorder } from "@learning/server";
import { findExposureLeaks, resolveGenerationLeaks } from "../../packages/server/src/domain/lessons/exposure-leaks";
import { lessonCoverageGaps } from "../../packages/server/src/domain/lessons/lesson-coverage";
import { exerciseSnippet } from "../../packages/server/src/domain/lessons/review-report";
import type { DynamicTopicData, LessonExerciseDraft, LessonTopic, SubjectModule } from "../../packages/server/src/domain/lessons/types";
import { toExerciseDraft } from "../../packages/server/src/modules/materials/lessons/lesson-drafts";
import { reviewFreshExercises, type ReviewPhaseResult } from "../../packages/server/src/modules/materials/lessons/lesson-review";
import { loadDotEnv, resolveOutsideRepoPath } from "./probe-helpers";

/**
 * Próba „tylko przegląd” krytyka lekcji na PRAWDZIWYM modelu (spec etapu przeglądu §11).
 * Krytyk dostaje stałe wejście — zapisany zrzut szkicu — bez generowania i bez bazy:
 * rejestr przedmiotów w pamięci, `reviewFreshExercises` bez zapisu. Płatne wywołania
 * (jedno na zagadnienie na przebieg), więc plik jest pomijany bez
 * `UMIEM_PROBE_REVIEW_DUMP` i nie należy do konfiguracji unit ani integration.
 * Dane z materiału podręcznika leżą POZA repozytorium (ścieżka w checkoucie kończy
 * próbę błędem, zanim zostanie wywołany model).
 *
 * Zmienne (klucz i model z `UMIEM_REVIEWER_*` albo wspólnego `OPENROUTER_API_KEY`, z .env;
 * wartości nigdy nie są wypisywane — próba sama wymusza `UMIEM_REVIEWER_ENABLED=true`):
 * - `UMIEM_PROBE_REVIEW_DUMP` — JSON wejścia (wymagany):
 *   `{ subjectId, material, topicTitle?, topicId?, objectives: [{ id, title, kind?, card,
 *   examples[], descriptionEn? }], exercises: [<kształt generatora z objectiveId>] }`;
 * - `UMIEM_PROBE_REVIEW_LABELS` — JSON etykiet (opcjonalny; bez niego tylko raport
 *   i asercja zera twardych ujawnień): `{ bad: [{ objectiveId, n }], good: [{ objectiveId, n }] }`,
 *   gdzie `n` to numer ćwiczenia zagadnienia w zrzucie (od 1, w kolejności zrzutu — jak numer
 *   w wejściu krytyka), a `objectiveId` to pełny identyfikator albo jego ostatni człon;
 * - `UMIEM_PROBE_REVIEW_RUNS` — liczba powtórzeń (domyślnie 3).
 *
 * Ograniczenia: zrzut ma być stanem PO przyjęciu puli (`acceptFreshLessonPool`) — próba
 * nie powtarza walidacji puli, więc `n` zgadza się z numeracją krytyka. Dla przedmiotów
 * z materiału temat powstaje z `buildDynamicTopic` z jedną kartą na zagadnienie (tekst
 * `card` wchodzi do krytyka dosłownie); dla przedmiotów z katalogu (gramatyka) temat to
 * `topicId` albo najnowszy temat zawierający wszystkie zagadnienia zrzutu, a `material` jest ignorowany.
 * Zrzut nie zawiera ćwiczeń szkicu spoza przeglądanej partii (`existing` puste).
 */

const dumpEnv = process.env.UMIEM_PROBE_REVIEW_DUMP;

interface DumpObjective {
  id: string;
  title: string;
  kind?: "words" | "frame";
  card: string;
  examples: string[];
  descriptionEn?: string;
}

interface ProbeDump {
  subjectId: string;
  material: string;
  topicTitle?: string;
  topicId?: string;
  objectives: DumpObjective[];
  exercises: unknown[];
}

interface LabelRef {
  objectiveId: string;
  n: number;
}

interface ProbeLabels {
  bad: LabelRef[];
  good: LabelRef[];
}

function readJson(path: string, name: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`${name}: nie można odczytać JSON z ${path} (${error instanceof Error ? error.message : String(error)})`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseDump(raw: unknown): ProbeDump {
  if (!isRecord(raw)) throw new Error("UMIEM_PROBE_REVIEW_DUMP: oczekiwano obiektu");
  const { subjectId, material, topicTitle, topicId, objectives, exercises } = raw;
  if (typeof subjectId !== "string" || subjectId === "") throw new Error("UMIEM_PROBE_REVIEW_DUMP: brak subjectId");
  if (typeof material !== "string") throw new Error("UMIEM_PROBE_REVIEW_DUMP: brak material (tekst, może być pusty)");
  if (!Array.isArray(objectives) || objectives.length === 0) throw new Error("UMIEM_PROBE_REVIEW_DUMP: objectives musi być niepustą tablicą");
  if (!Array.isArray(exercises) || exercises.length === 0) throw new Error("UMIEM_PROBE_REVIEW_DUMP: exercises musi być niepustą tablicą");
  const parsed: DumpObjective[] = objectives.map((item, index) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.title !== "string" || typeof item.card !== "string") {
      throw new Error(`UMIEM_PROBE_REVIEW_DUMP: objectives[${index}] wymaga id, title, card (teksty)`);
    }
    if (item.kind !== undefined && item.kind !== "words" && item.kind !== "frame") {
      throw new Error(`UMIEM_PROBE_REVIEW_DUMP: objectives[${index}].kind to words albo frame`);
    }
    if (!Array.isArray(item.examples) || !item.examples.every((example) => typeof example === "string")) {
      throw new Error(`UMIEM_PROBE_REVIEW_DUMP: objectives[${index}].examples musi być tablicą tekstów`);
    }
    return {
      id: item.id,
      title: item.title,
      card: item.card,
      examples: item.examples as string[],
      ...(item.kind === undefined ? {} : { kind: item.kind }),
      ...(typeof item.descriptionEn === "string" ? { descriptionEn: item.descriptionEn } : {}),
    };
  });
  if (new Set(parsed.map((objective) => objective.id)).size !== parsed.length) throw new Error("UMIEM_PROBE_REVIEW_DUMP: zduplikowane id zagadnienia");
  return {
    subjectId,
    material,
    objectives: parsed,
    exercises,
    ...(typeof topicTitle === "string" ? { topicTitle } : {}),
    ...(typeof topicId === "string" ? { topicId } : {}),
  };
}

function parseLabels(raw: unknown): ProbeLabels {
  if (!isRecord(raw)) throw new Error("UMIEM_PROBE_REVIEW_LABELS: oczekiwano obiektu { bad, good }");
  const list = (name: "bad" | "good"): LabelRef[] => {
    const value = raw[name] ?? [];
    if (!Array.isArray(value)) throw new Error(`UMIEM_PROBE_REVIEW_LABELS: ${name} musi być tablicą`);
    return value.map((item, index) => {
      if (!isRecord(item) || typeof item.objectiveId !== "string" || typeof item.n !== "number" || !Number.isInteger(item.n) || item.n < 1) {
        throw new Error(`UMIEM_PROBE_REVIEW_LABELS: ${name}[${index}] wymaga objectiveId (tekst) i n (liczba całkowita ≥ 1)`);
      }
      return { objectiveId: item.objectiveId, n: item.n };
    });
  };
  return { bad: list("bad"), good: list("good") };
}

/** Pełny identyfikator zagadnienia z etykiety: dokładny albo jednoznaczny ostatni człon. */
function resolveObjectiveId(label: string, objectiveIds: readonly string[]): string {
  if (objectiveIds.includes(label)) return label;
  const bySlug = objectiveIds.filter((id) => id.split(".").at(-1) === label);
  if (bySlug.length === 1) return bySlug[0]!;
  throw new Error(`UMIEM_PROBE_REVIEW_LABELS: zagadnienie „${label}” nie istnieje w zrzucie albo nie jest jednoznaczne`);
}

/** Temat dla `reviewFreshExercises`: dynamiczny (przedmioty z materiału) albo z katalogu przedmiotu. */
function buildTopic(subject: SubjectModule, dump: ProbeDump): LessonTopic {
  if (subject.buildDynamicTopic !== undefined) {
    const data: DynamicTopicData = {
      titlePl: dump.topicTitle ?? "Próba przeglądu",
      objectives: dump.objectives.map((objective) => ({
        id: objective.id,
        titlePl: objective.title,
        descriptionEn: objective.descriptionEn ?? objective.title,
        cards: [{ title: objective.title, body: objective.card }],
        ...(objective.kind === undefined ? {} : { kind: objective.kind }),
      })),
    };
    return subject.buildDynamicTopic(data);
  }
  const ids = dump.objectives.map((objective) => objective.id);
  const candidates = subject.topics
    .filter((topic) => (dump.topicId === undefined || topic.id === dump.topicId) && ids.every((id) => topic.objectives.some((objective) => objective.id === id)))
    .sort((a, b) => b.version - a.version);
  const topic = candidates[0];
  if (topic === undefined) {
    throw new Error(`Przedmiot „${subject.id}” nie ma tematu z katalogu zawierającego wszystkie zagadnienia zrzutu${dump.topicId ? ` (topicId=${dump.topicId})` : ""}`);
  }
  return topic;
}

type Outcome = "ok" | "note" | "fixed" | "dropped" | "unreviewed";

/**
 * Los każdego zrzuconego ćwiczenia po przeglądzie. Wynik fazy jest podciągiem wejścia
 * (ćwiczenia bez zmian to ten sam obiekt, poprawka ma wpis `changed.beforePl` = skrót
 * oryginału), więc wystarczy jeden przebieg wskaźnikiem.
 */
function classify(fresh: readonly LessonExerciseDraft[], result: ReviewPhaseResult): Outcome[] {
  const unreviewed = new Set(result.objectives.filter((objective) => objective.status === "unreviewed").map((objective) => objective.objectiveId));
  let pointer = 0;
  const outcomes = fresh.map((original): Outcome => {
    const current = result.exercises[pointer];
    if (current === original) {
      pointer += 1;
      if (unreviewed.has(original.objectiveId)) return "unreviewed";
      return result.meta.get(original)?.note !== undefined ? "note" : "ok";
    }
    const changed = current === undefined ? undefined : result.meta.get(current)?.changed;
    if (current !== undefined && changed !== undefined && current.objectiveId === original.objectiveId &&
      current.exerciseType === original.exerciseType && changed.beforePl === exerciseSnippet(original)) {
      pointer += 1;
      return "fixed";
    }
    return "dropped";
  });
  if (pointer !== result.exercises.length) throw new Error("Nie udało się uzgodnić wyniku przeglądu z wejściem (kolejność ćwiczeń)");
  if (outcomes.filter((outcome) => outcome === "dropped").length !== result.droppedCount) {
    throw new Error("Liczba usuniętych z uzgodnienia różni się od droppedCount fazy przeglądu");
  }
  return outcomes;
}

interface WireUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
}

/** Liczby z odpowiedzi `chat/completions` (UsageEvent nie niesie pól cache); treść odpowiedzi nigdzie nie trafia. */
function wireUsageOf(body: unknown): WireUsage | undefined {
  if (!isRecord(body) || !isRecord(body.usage)) return undefined;
  const { usage } = body;
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  return {
    promptTokens: number(usage.prompt_tokens),
    completionTokens: number(usage.completion_tokens),
    cachedTokens: number(details.cached_tokens),
    costUsd: number(usage.cost),
  };
}

interface RunMetrics {
  run: number;
  bad: number;
  good: number;
  fixedOrDroppedBad: number;
  noteOnlyBad: number;
  missedBad: number;
  goodTouched: number;
  goodNoted: number;
  unreviewedLabelled: number;
  hardLeaksAfter: number;
  hardRuleDropped: number;
  coverageGaps: string[];
  calls: number;
  failedCalls: number;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
}

function line(text = ""): void {
  console.log(text);
}

describe.skipIf(!dumpEnv)("próba „tylko przegląd” krytyka lekcji na prawdziwym modelu", () => {
  it("przegląda zrzut szkicu i raportuje jakość, ujawnienia i koszt", async () => {
    loadDotEnv();
    // Przed wywołaniem modelu: zła ścieżka albo zły kształt wejścia nie mogą kosztować przebiegu.
    const dumpPath = resolveOutsideRepoPath(dumpEnv, "UMIEM_PROBE_REVIEW_DUMP")!;
    const labelsPath = resolveOutsideRepoPath(process.env.UMIEM_PROBE_REVIEW_LABELS, "UMIEM_PROBE_REVIEW_LABELS");
    const runs = Number(process.env.UMIEM_PROBE_REVIEW_RUNS ?? 3);
    if (!Number.isInteger(runs) || runs < 1) throw new Error("UMIEM_PROBE_REVIEW_RUNS musi być liczbą całkowitą ≥ 1");

    const dump = parseDump(readJson(dumpPath, "UMIEM_PROBE_REVIEW_DUMP"));
    const subject = createProductionSubjectRegistry().getSubject(dump.subjectId);
    if (subject === undefined) throw new Error(`Nieznany przedmiot „${dump.subjectId}” w zrzucie`);
    const topic = buildTopic(subject, dump);
    const objectiveOrder = dump.objectives.map((objective) => objective.id);
    // objectiveId ćwiczenia: pełny identyfikator albo jego ostatni człon (jak w etykietach).
    const fresh = dump.exercises.map((raw, index) => {
      const draft = toExerciseDraft(raw);
      try {
        return { ...draft, objectiveId: resolveObjectiveId(draft.objectiveId, objectiveOrder) };
      } catch {
        throw new Error(`UMIEM_PROBE_REVIEW_DUMP: exercises[${index}].objectiveId „${draft.objectiveId}” nie ma w objectives`);
      }
    });
    const examples = Object.fromEntries(dump.objectives.map((objective) => [objective.id, objective.examples]));
    const cardOf = new Map(dump.objectives.map((objective) => [objective.id, objective] as const));

    // Etykiety: (zagadnienie, n) → indeks w zrzucie.
    const indexOf = (ref: LabelRef): number => {
      const objectiveId = resolveObjectiveId(ref.objectiveId, objectiveOrder);
      const own = fresh.flatMap((exercise, index) => (exercise.objectiveId === objectiveId ? [index] : []));
      const index = own[ref.n - 1];
      if (index === undefined) throw new Error(`UMIEM_PROBE_REVIEW_LABELS: zagadnienie „${ref.objectiveId}” ma ${own.length} ćwiczeń, brak n=${ref.n}`);
      return index;
    };
    const labels = labelsPath === undefined ? { bad: [], good: [] } : parseLabels(readJson(labelsPath, "UMIEM_PROBE_REVIEW_LABELS"));
    const badIndexes = new Set(labels.bad.map(indexOf));
    const goodIndexes = new Set(labels.good.map(indexOf));
    if (badIndexes.size !== labels.bad.length || goodIndexes.size !== labels.good.length) throw new Error("UMIEM_PROBE_REVIEW_LABELS: powtórzona etykieta");
    if ([...badIndexes].some((index) => goodIndexes.has(index))) throw new Error("UMIEM_PROBE_REVIEW_LABELS: to samo ćwiczenie jest oznaczone jako złe i dobre");

    // Krytyk: stan `ready` wymuszony; zużycie do pamięci, liczby z odpowiedzi przez opakowany fetch.
    const env = withConfigDefaults({ ...process.env, UMIEM_REVIEWER_ENABLED: "true" });
    delete env.UMIEM_FAKE_PROVIDERS;
    const events: UsageEvent[] = [];
    const usage: UsageRecorder = { record: (event) => void events.push(event), flush: async () => undefined };
    const reviewer = reviewerFromEnv(env, usage);
    if (reviewer.state !== "ready") throw new Error("Krytyk nie jest gotowy (brak UMIEM_REVIEWER_API_KEY / OPENROUTER_API_KEY w .env) — próba nie ma czego wywołać.");

    const wire: WireUsage[] = [];
    const pending: Promise<void>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/chat/completions") && response.ok) {
        pending.push(
          response.clone().json().then(
            (body: unknown) => {
              const measured = wireUsageOf(body);
              if (measured !== undefined) wire.push(measured);
            },
            () => undefined,
          ),
        );
      }
      return response;
    };

    line("");
    line(`=== Próba „tylko przegląd”: ${subject.titlePl} ===`);
    line(`zagadnień=${dump.objectives.length} ćwiczeń=${fresh.length} etykiety: złe=${badIndexes.size} dobre=${goodIndexes.size} powtórzeń=${runs}`);

    const metrics: RunMetrics[] = [];
    try {
      for (let run = 1; run <= runs; run += 1) {
        const eventsBefore = events.length;
        const wireBefore = wire.length;
        const started = Date.now();
        const result = await reviewFreshExercises({
          reviewer,
          subject,
          topic,
          material: dump.material,
          fresh,
          existing: [],
          examples,
          objectiveOrder,
          // Karta dosłownie ze zrzutu (jedna karta tematu = jeden tekst).
          objectiveContext: (objectiveId) => {
            const objective = cardOf.get(objectiveId)!;
            return { title: objective.title, ...(objective.kind === undefined ? {} : { kind: objective.kind }), card: objective.card };
          },
          familyScope: null,
          callsLeft: { value: reviewer.policy.maxCallsPerRun },
          reviewDeadlineAtMs: Date.now() + reviewer.policy.phaseBudgetMs,
          cancelPollMs: 2000,
          assertCurrent: async () => true,
          runId: randomUUID(),
        });
        const durationMs = Date.now() - started;
        await Promise.all(pending.splice(0));

        const outcomes = classify(fresh, result);
        const count = (indexes: ReadonlySet<number>, wanted: readonly Outcome[]) => [...indexes].filter((index) => wanted.includes(outcomes[index]!)).length;

        // Reguła twarda po przeglądzie, jak w generowaniu; ćwiczeń szkicu spoza partii brak.
        const resolution = resolveGenerationLeaks({ existing: [], fresh: result.exercises, existingExamples: examples, newExamples: {}, objectiveOrder, subject });
        const hardLeaksAfter = findExposureLeaks({ exercises: resolution.keptFresh, examples, objectiveOrder, subject, mode: "generation" })
          .filter((leak) => leak.kind === "hard").length;
        const gaps = lessonCoverageGaps({ subject, exercises: resolution.keptFresh, examples, objectiveIds: objectiveOrder })
          .map((gap) => `${gap.objectiveId.split(".").at(-1)}/${gap.stage}: ${gap.actual} z ${gap.required}${gap.excluded ? ` (ujawnionych ${gap.excluded})` : ""}`);

        const runEvents = events.slice(eventsBefore);
        const runWire = wire.slice(wireBefore);
        const sum = (pick: (item: WireUsage) => number) => runWire.reduce((total, item) => total + pick(item), 0);
        const entry: RunMetrics = {
          run,
          bad: badIndexes.size,
          good: goodIndexes.size,
          fixedOrDroppedBad: count(badIndexes, ["fixed", "dropped"]),
          noteOnlyBad: count(badIndexes, ["note"]),
          missedBad: count(badIndexes, ["ok", "unreviewed"]),
          goodTouched: count(goodIndexes, ["fixed", "dropped"]),
          goodNoted: count(goodIndexes, ["note"]),
          unreviewedLabelled: count(new Set([...badIndexes, ...goodIndexes]), ["unreviewed"]),
          hardLeaksAfter,
          hardRuleDropped: resolution.droppedFresh.length,
          coverageGaps: gaps,
          calls: runEvents.length,
          failedCalls: runEvents.filter((event) => event.outcome === "failed").length,
          durationMs,
          promptTokens: sum((item) => item.promptTokens) || runEvents.reduce((total, event) => total + (event.inputTokens ?? 0), 0),
          completionTokens: sum((item) => item.completionTokens) || runEvents.reduce((total, event) => total + (event.outputTokens ?? 0), 0),
          cachedTokens: sum((item) => item.cachedTokens),
          costUsd: sum((item) => item.costUsd) || runEvents.reduce((total, event) => total + (event.providerCostUsd ?? 0), 0),
        };
        metrics.push(entry);

        line("");
        line(`--- Przebieg ${run}/${runs} ---`);
        line(`złe: naprawione/usunięte ${entry.fixedOrDroppedBad}/${entry.bad} (próg ${Math.ceil(0.9 * entry.bad)}), tylko uwaga ${entry.noteOnlyBad}, pominięte ${entry.missedBad}`);
        line(`dobre: zmienione/usunięte ${entry.goodTouched}/${entry.good} (próg ≤ 1), z uwagą ${entry.goodNoted}; etykietowane bez przeglądu: ${entry.unreviewedLabelled}`);
        line(`twarde ujawnienia po regule: ${entry.hardLeaksAfter} (reguła usunęła ${entry.hardRuleDropped})`);
        line(`braki pokrycia po scaleniu i regule twardej: ${gaps.length === 0 ? "brak" : ""}`);
        for (const gap of gaps) line(`  - ${gap}`);
        line(`zagadnienia: ${result.objectives.map((objective) => `${objective.objectiveId.split(".").at(-1)}=${objective.status}${"reason" in objective && objective.reason ? `(${objective.reason})` : ""}`).join(", ")}`);
        line(`wywołania=${entry.calls} (nieudane ${entry.failedCalls}); czas=${(durationMs / 1000).toFixed(1)} s; tokeny we/wy=${entry.promptTokens}/${entry.completionTokens}; ` +
          `z cache=${entry.cachedTokens}; koszt=${entry.costUsd > 0 ? `${entry.costUsd.toFixed(4)} USD` : "n/d"}`);
        // Dobre ćwiczenia ruszone przez krytyka: powód do ręcznej oceny (bez treści ćwiczeń).
        outcomes.forEach((outcome, index) => {
          if (!goodIndexes.has(index) || (outcome !== "fixed" && outcome !== "dropped")) return;
          const exercise = fresh[index]!;
          const objectiveSlug = exercise.objectiveId.split(".").at(-1);
          const nth = fresh.filter((candidate, at) => candidate.objectiveId === exercise.objectiveId && at <= index).length;
          const reason = outcome === "dropped"
            ? result.dropped.find((item) => item.objectiveId === exercise.objectiveId && item.snippet === exerciseSnippet(exercise))
            : [...result.meta.values()].find((item) => item.changed?.beforePl === exerciseSnippet(exercise))?.changed;
          line(`  dobre ruszone: ${objectiveSlug} n=${nth} ${outcome} [${reason?.category ?? "?"}] ${reason?.reasonPl ?? ""}`);
        });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    const total = (pick: (item: RunMetrics) => number) => metrics.reduce((sum, item) => sum + pick(item), 0);
    line("");
    line("=== Łącznie ===");
    line(`przebiegi=${metrics.length}; złe naprawione/usunięte ${total((m) => m.fixedOrDroppedBad)}/${total((m) => m.bad)}; ` +
      `tylko uwaga ${total((m) => m.noteOnlyBad)}; pominięte ${total((m) => m.missedBad)}; ` +
      `dobre zmienione/usunięte ${total((m) => m.goodTouched)}; twarde ujawnienia po regule ${total((m) => m.hardLeaksAfter)}; ` +
      `przebiegi z brakami pokrycia ${metrics.filter((m) => m.coverageGaps.length > 0).length}`);
    line(`wywołania=${total((m) => m.calls)}; czas=${(total((m) => m.durationMs) / 1000).toFixed(1)} s; tokeny we/wy=${total((m) => m.promptTokens)}/${total((m) => m.completionTokens)}; ` +
      `z cache=${total((m) => m.cachedTokens)}; koszt=${total((m) => m.costUsd) > 0 ? `${total((m) => m.costUsd).toFixed(4)} USD` : "n/d"}`);
    line("");

    // Kryteria akceptacji (spec §11) per przebieg; braki pokrycia tylko raportowane (zadanie dla rundy pod etap).
    for (const entry of metrics) {
      if (entry.bad > 0) {
        expect(entry.fixedOrDroppedBad, `przebieg ${entry.run}: złe naprawione lub usunięte`).toBeGreaterThanOrEqual(Math.ceil(0.9 * entry.bad));
        expect(entry.goodTouched, `przebieg ${entry.run}: dobre zmienione lub usunięte`).toBeLessThanOrEqual(1);
      }
      expect(entry.hardLeaksAfter, `przebieg ${entry.run}: twarde ujawnienia po regule`).toBe(0);
    }
  });
});
