import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createGenerationDepsFromEnv,
  createLesson,
  createLessonFromMaterial,
  createProductionSubjectRegistry,
  createSchoolLesson,
  createServices,
  executeLessonGeneration,
  publishLessonDraft,
  readGeneration,
  readLessonDeck,
  schema,
  withConfigDefaults,
  type LlmProvider,
  type UsageEvent,
  type UsageRecorder,
} from "@learning/server";
import type { LessonDraftDto } from "@learning/contracts";
import { stageOf } from "../../packages/server/src/domain/lessons/stages";
import { UNSOLICITED_V3_FIELDS } from "../../packages/server/src/domain/lessons/subjects/english-chapter/validators";
import type { DynamicTopicData } from "../../packages/server/src/domain/lessons/types";
import { DEFAULT_BASE_URL as LLM_DEFAULT_BASE_URL } from "../../packages/server/src/providers/openai/llm";
import { testDatabase } from "../integration/helpers";
import {
  appendProvisionalCostEntry,
  assertWithinCostCap,
  costCapFromEnv,
  errorClassOf,
  estimateProbeCostUsd,
  initCostLedger,
  ledgerCost,
  probeEndpointHost,
  readCostLedger,
  settleCostEntry,
  sha256File,
} from "./probe-costs";
import { loadDotEnv, resolveOutsideRepoPath } from "./probe-helpers";

const { eq } = createRequire(new URL("../../packages/server/package.json", import.meta.url))("drizzle-orm") as typeof import("../../packages/server/node_modules/drizzle-orm");

/**
 * Próba generowania lekcji na PRAWDZIWYM modelu (design „Angielski — rozdział” §4 i §9:
 * ryzyko wykonalności generowania) i punkt odniesienia dla próby agenta puli (etap 1 issue
 * #237, spec §8). To nie jest test jakości — bez asercji, tylko raport w konsoli (liczby i
 * ostatnie człony identyfikatorów zagadnień) i plik wyników: zagadnienia z rodzajami,
 * ćwiczenia per zagadnienie i etap, odrzucenia z powodami, braki pokrycia, koszt i wynik próby
 * publikacji. Płatne wywołania, więc plik jest pomijany bez `UMIEM_PROBE_MATERIAL` (gramatyka:
 * bez `UMIEM_PROBE_SUBJECT=grammar`) i nie należy do konfiguracji unit ani integration.
 * Materiał leży POZA repozytorium i nie może do niego trafić.
 *
 * Zmienne (poza .env z LLM, którego wartości nigdy nie są wypisywane):
 * - `UMIEM_PROBE_MATERIAL` — plik z materiałem (wymagany dla `chapter` i `school`; dla
 *   `grammar` opcjonalny — bez niego krótki wbudowany materiał zdań w Present Simple);
 * - `UMIEM_PROBE_SUBJECT` — `chapter` (domyślnie), `school` (Geografia) albo `grammar`
 *   (`english_grammar`, temat `present_simple` z katalogu, wszystkie jego zagadnienia);
 * - `UMIEM_PROBE_POOL_SIZE` — wielkość puli (domyślnie 60, jak w panelu);
 * - `UMIEM_PROBE_TOPIC` — tytuł tematu (domyślnie „Unit 1” / „Mapa”; gramatyka: z katalogu);
 * - `UMIEM_PROBE_OUT_DIR` — katalog wyników poza repozytorium (wymagany): plik
 *   `chapter-<czas>.json` na każde uruchomienie (liczby, braki pokrycia, koszt; tu też treść
 *   tytułów zagadnień i odpowiedzi luk — tylko w pliku);
 * - `UMIEM_PROBE_COSTS` — rejestr kosztów prób `costs.json` (wymagany, musi istnieć; nowy zakłada
 *   tylko `UMIEM_PROBE_COSTS_INIT=1`, z limitem `UMIEM_PROBE_COSTS_CAP_USD`, domyślnie 10 USD): przed startem „wydane + szacunek > limit → stop”, przed
 *   pierwszym płatnym wywołaniem wpis tymczasowy z szacunkiem (zabity proces nadal się liczy), po
 *   próbie (także po błędzie) zastąpiony kosztem z `usage.cost`, a gdy go brak albo jest poniżej
 *   0,005 USD na wywołanie — szacunkiem z flagą `estimated`;
 * - `UMIEM_PROBE_ALLOW_HOST` — host usługi inny niż OpenRouter dopuszczony jawnie (domyślnie próba
 *   odmawia wywołania innego hosta i każdego adresu bez https); nagłówek próby wypisuje model i host;
 * - `UMIEM_PROBE_DUMP` — plik JSON z pełnym szkicem i surowym wyjściem modelu do ręcznej oceny;
 * - `UMIEM_PROBE_POOL_DUMP_OUT` — punkt odniesienia agenta: zrzut KOŃCOWEGO szkicu po
 *   `executeLessonGeneration` (po regule twardej i dogenerowaniu) w formacie arkusza
 *   `blind/gen-blind-sheet.cjs` (`subjectId`, `objectives[]` z `title`, `kind`, `card`,
 *   `examples`, `exercises[]`), w tym samym pliku zagadnienia z kartami jako tablicą
 *   (`objectives[].cards: { title, body }[]`, `descriptionEn`), temat i materiał — wejście
 *   `UMIEM_PROBE_AGENT_OBJECTIVES_DUMP` próby agenta. Istniejący plik nie jest nadpisywany.
 * Wszystkie ścieżki plików przechodzą przez `resolveOutsideRepoPath` (ścieżka w checkoucie
 * kończy próbę błędem, zanim zostanie wywołany model).
 */

// .env przed odczytem zmiennych próby (decyzja o pominięciu i o rodzaju przedmiotu).
loadDotEnv();
const materialEnv = process.env.UMIEM_PROBE_MATERIAL?.trim() || undefined;
const subjectEnv = process.env.UMIEM_PROBE_SUBJECT?.trim() || "chapter";
const enabled = Boolean(materialEnv) || subjectEnv === "grammar";

/** Krótki materiał gramatyki (Present Simple), gdy próba nie dostała pliku — tekst własny, nie z podręcznika. */
const DEFAULT_GRAMMAR_MATERIAL = [
  "Tom gets up at seven o'clock. He washes his face and brushes his teeth.",
  "His sister Ann doesn't like milk, so she drinks orange juice for breakfast.",
  "They walk to school together. Their school starts at eight.",
  "Does Tom play football after school? Yes, he does. Ann watches cartoons and tidies her room.",
  "We don't go to school on Sundays. My dad cooks lunch and we visit our grandparents.",
].join("\n");

interface RecordedCall {
  method: "objectives" | "pool";
  ms: number;
  rawExercises: number;
  failed: boolean;
}

/** Opakowuje prawdziwego providera: liczy wywołania i zachowuje surowe wyjście do analizy. */
function recordingLlm(inner: LlmProvider): { llm: LlmProvider; calls: RecordedCall[]; raw: Array<{ objectiveId: string; exercises: unknown[]; examples: unknown }>; rawObjectives: unknown[][] } {
  const calls: RecordedCall[] = [];
  const raw: Array<{ objectiveId: string; exercises: unknown[]; examples: unknown }> = [];
  const rawObjectives: unknown[][] = [];
  const llm: LlmProvider = {
    name: inner.name,
    model: inner.model,
    generateDeck: (input, signal) => inner.generateDeck(input, signal),
    async generateLessonObjectives(input, signal) {
      const started = Date.now();
      try {
        const result = await inner.generateLessonObjectives(input, signal);
        calls.push({ method: "objectives", ms: Date.now() - started, rawExercises: 0, failed: false });
        rawObjectives.push(result.objectives);
        return result;
      } catch (error) {
        calls.push({ method: "objectives", ms: Date.now() - started, rawExercises: 0, failed: true });
        throw error;
      }
    },
    generateLessonStory: () => {
      throw new Error("generateLessonStory is not exercised by this probe");
    },
    async generateLessonPool(input, signal) {
      const started = Date.now();
      try {
        const result = await inner.generateLessonPool(input, signal);
        calls.push({ method: "pool", ms: Date.now() - started, rawExercises: result.exercises.length, failed: false });
        raw.push({ objectiveId: input.objectives.map((objective) => objective.id).join(","), exercises: result.exercises, examples: result.examples });
        return result;
      } catch (error) {
        calls.push({ method: "pool", ms: Date.now() - started, rawExercises: 0, failed: true });
        throw error;
      }
    },
  };
  return { llm, calls, raw, rawObjectives };
}

function line(text = ""): void {
  console.log(text);
}

const slugOf = (objectiveId: string) => objectiveId.split(".").at(-1) ?? objectiveId;

/** Pole modelu niepuste: nie null/undefined ani pusta tablica (jak `withoutEmptyOptionalArrays`). */
function isFilled(value: unknown): boolean {
  return value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0);
}

/** Ile surowych ćwiczeń niesie którekolwiek pole v3, którego przedmiot nie żąda (czyszczone przez `refineChapterPool`). */
function countUnsolicitedV3(rawExercises: readonly unknown[]): number {
  return rawExercises.filter((exercise) =>
    exercise !== null && typeof exercise === "object" &&
    UNSOLICITED_V3_FIELDS.some((field) => isFilled((exercise as Record<string, unknown>)[field])),
  ).length;
}

/** Raport szkicu: na konsolę liczby i człony identyfikatorów; treść (tytuły, odpowiedzi luk) tylko do pliku wyników. */
function reportDraft(draft: LessonDraftDto): Record<string, unknown> {
  const objectives = draft.dynamicTopic?.objectives ?? [];
  const objectiveIds = objectives.length > 0 ? objectives.map((objective) => objective.id) : [...new Set(draft.exercises.map((exercise) => exercise.objectiveId))];
  const kindOf = (id: string) => objectives.find((objective) => objective.id === id)?.kind;
  line(`Zagadnienia (${objectiveIds.length}): ${objectiveIds.map((id) => `${slugOf(id)}[${kindOf(id) ?? "-"}]`).join(", ")}`);
  line("Ćwiczenia per zagadnienie i etap (guided/productive/independent) oraz typy:");
  const perObjective = objectiveIds.map((id) => {
    const own = draft.exercises.filter((exercise) => exercise.objectiveId === id);
    const stages = { guided: 0, productive: 0, independent: 0 };
    const types: Record<string, number> = {};
    for (const exercise of own) {
      const stage = stageOf(exercise.exerciseType);
      if (stage === "guided" || stage === "productive" || stage === "independent") stages[stage] += 1;
      types[exercise.exerciseType] = (types[exercise.exerciseType] ?? 0) + 1;
    }
    line(`  - ${slugOf(id)}: ${own.length} = ${stages.guided}/${stages.productive}/${stages.independent}  ${JSON.stringify(types)}`);
    // Odpowiedzi luk (treść) — tylko do pliku.
    const gaps = new Map<string, number>();
    for (const exercise of own) {
      if (exercise.exerciseType !== "lesson_gap") continue;
      const key = exercise.answer.toLowerCase();
      gaps.set(key, (gaps.get(key) ?? 0) + 1);
    }
    return {
      objective: slugOf(id),
      kind: kindOf(id) ?? null,
      titlePl: objectives.find((objective) => objective.id === id)?.titlePl ?? null,
      count: own.length,
      stages,
      types,
      gapAnswers: Object.fromEntries([...gaps.entries()].sort((a, b) => b[1] - a[1])),
    };
  });
  const orders = draft.exercises.filter((exercise) => exercise.exerciseType === "lesson_order");
  line(`Układanki (lesson_order): ${orders.length}; klocki: ${orders.map((exercise) => (exercise.items ?? []).length).join(", ") || "-"}; ` +
    `z kropką/pytajnikiem na końcu klocka: ${orders.filter((exercise) => (exercise.items ?? []).some((item) => /[.?!]$/u.test(item.text))).length}`);
  const kept = draft.exercises.length;
  const rejectedRate = kept + draft.rejectedCount === 0 ? 0 : draft.rejectedCount / (kept + draft.rejectedCount);
  line(`Ćwiczeń w szkicu: ${kept}; rejectedCount: ${draft.rejectedCount} (${(rejectedRate * 100).toFixed(1)}% wszystkich ocenionych)`);
  const reasons = Object.entries(draft.rejectedReasons ?? {}).sort((a, b) => b[1] - a[1]);
  // Teksty powodów (mogą cytować treść ćwiczeń) tylko w pliku wyników; na konsolę same liczby.
  line(`rejectedReasons: ${reasons.length} różnych, łącznie ${reasons.reduce((sum, [, count]) => sum + count, 0)} (teksty w pliku wyników)`);
  const coverage = draft.coverage.map((gap) => ({ objective: slugOf(gap.objectiveId), stage: gap.stage, actual: gap.actual, required: gap.required }));
  line(`Braki pokrycia (coverage): ${coverage.length === 0 ? "brak" : coverage.map((gap) => `${gap.objective}/${gap.stage}: ${gap.actual} z ${gap.required}`).join("; ")}`);
  return { perObjective, exercises: kept, rejectedCount: draft.rejectedCount, rejectedReasons: Object.fromEntries(reasons), coverage, lessonOrder: orders.length };
}

/**
 * Zagadnienia końcowego szkicu z kartami jako tablicą i `descriptionEn`: temat dynamiczny z
 * `lesson_context` wersji (DTO szkicu nie niesie `descriptionEn`), temat katalogowy z rejestru
 * (tylko zagadnienia szkicu).
 */
async function draftObjectives(draft: LessonDraftDto): Promise<{ topicTitle: string; objectives: DynamicTopicData["objectives"] }> {
  const rows = await testDatabase()
    .db.select({ lessonContext: schema.deckVersions.lessonContext })
    .from(schema.deckVersions)
    .where(eq(schema.deckVersions.id, draft.id));
  const dynamicTopic = (rows[0]?.lessonContext as { dynamicTopic?: DynamicTopicData } | null | undefined)?.dynamicTopic;
  if (dynamicTopic !== undefined) return { topicTitle: dynamicTopic.titlePl, objectives: dynamicTopic.objectives };
  const topic = createProductionSubjectRegistry()
    .getSubject(draft.subjectId)
    ?.topics.find((candidate) => candidate.id === draft.topicId && candidate.version === draft.topicVersion);
  if (topic === undefined) throw new Error(`Brak tematu ${draft.topicId} v${draft.topicVersion} — zrzut puli niemożliwy`);
  const ids = new Set(draft.objectiveIds);
  return {
    topicTitle: topic.titlePl,
    objectives: topic.objectives
      .filter((objective) => ids.has(objective.id))
      .map((objective) => ({ id: objective.id, titlePl: objective.titlePl, descriptionEn: objective.descriptionEn, cards: objective.cards })),
  };
}

/** Zrzut punktu odniesienia: format arkusza `gen-blind-sheet.cjs` + karty jako tablica, temat i materiał (wejście próby agenta). */
async function poolDumpOf(draft: LessonDraftDto, material: string, meta: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { topicTitle, objectives } = await draftObjectives(draft);
  return {
    schema: "lesson-pool-dump/v1",
    source: "pipeline",
    ...meta,
    subjectId: draft.subjectId,
    topicId: draft.topicId,
    topicVersion: draft.topicVersion,
    topicTitle,
    material,
    objectives: objectives.map((objective) => ({
      id: objective.id,
      title: objective.titlePl,
      kind: objective.kind ?? null,
      descriptionEn: objective.descriptionEn,
      card: objective.cards.map((card) => `[${card.title}] ${card.body}`).join("\n"),
      cards: objective.cards.map((card) => ({ title: card.title, body: card.body })),
      examples: draft.examples[objective.id] ?? [],
    })),
    exercises: draft.exercises,
    coverage: draft.coverage,
    rejectedCount: draft.rejectedCount,
    exposureLeaks: draft.exposureLeaks ?? [],
  };
}

describe.skipIf(!enabled)("próba generowania lekcji na prawdziwym modelu", () => {
  afterAll(async () => {
    if (enabled) await testDatabase().pool.end();
  });

  it("generuje pulę i raportuje wynik", async () => {
    if (process.env.UMIEM_FAKE_PROVIDERS) {
      line("UWAGA: UMIEM_FAKE_PROVIDERS było ustawione — wyłączam je, próba ma użyć prawdziwego modelu.");
      delete process.env.UMIEM_FAKE_PROVIDERS;
    }
    // Bezwarunkowo, po wczytaniu .env: próba nigdy nie wskaże prawdziwego wolumenu mediów.
    process.env.MEDIA_ROOT = mkdtempSync(join(tmpdir(), "knowli-probe-media-"));
    // Przed wywołaniem modelu: zła ścieżka, rodzaj przedmiotu albo limit kosztu nie mogą kosztować przebiegu.
    if (subjectEnv !== "chapter" && subjectEnv !== "school" && subjectEnv !== "grammar") {
      throw new Error("UMIEM_PROBE_SUBJECT: chapter | school | grammar");
    }
    const subjectKind = subjectEnv;
    const materialPath = resolveOutsideRepoPath(materialEnv, "UMIEM_PROBE_MATERIAL");
    if (materialPath === undefined && subjectKind !== "grammar") throw new Error("UMIEM_PROBE_MATERIAL jest wymagany dla chapter i school");
    const dumpPath = resolveOutsideRepoPath(process.env.UMIEM_PROBE_DUMP, "UMIEM_PROBE_DUMP");
    const poolDumpPath = resolveOutsideRepoPath(process.env.UMIEM_PROBE_POOL_DUMP_OUT, "UMIEM_PROBE_POOL_DUMP_OUT");
    const outDir = resolveOutsideRepoPath(process.env.UMIEM_PROBE_OUT_DIR, "UMIEM_PROBE_OUT_DIR");
    const costsPath = resolveOutsideRepoPath(process.env.UMIEM_PROBE_COSTS, "UMIEM_PROBE_COSTS");
    if (outDir === undefined) throw new Error("UMIEM_PROBE_OUT_DIR jest wymagany (katalog wyników poza repozytorium)");
    if (costsPath === undefined) throw new Error("UMIEM_PROBE_COSTS jest wymagany (rejestr kosztów costs.json poza repozytorium)");
    if (poolDumpPath !== undefined && existsSync(poolDumpPath)) throw new Error(`${poolDumpPath} już istnieje — zrzut płatnego generowania nie jest nadpisywany`);

    const material = materialPath === undefined ? DEFAULT_GRAMMAR_MATERIAL : readFileSync(materialPath, "utf8");
    const poolSize = Number(process.env.UMIEM_PROBE_POOL_SIZE ?? 60);
    const env = withConfigDefaults({ ...process.env });
    const events: UsageEvent[] = [];
    const usage: UsageRecorder = { record: (event) => void events.push(event), flush: async () => undefined };
    const deps = createGenerationDepsFromEnv(env, usage);
    if (!deps) throw new Error("Brak konfiguracji LLM (UMIEM_LLM_* / OPENAI_API_KEY) w .env — próba nie ma czego wywołać.");
    // Przed płatnym wywołaniem: dane idą tylko do OpenRouter po https (inny host — jawne UMIEM_PROBE_ALLOW_HOST).
    const allowHost = process.env.UMIEM_PROBE_ALLOW_HOST;
    const llmHost = probeEndpointHost(env.UMIEM_LLM_BASE_URL?.trim() || LLM_DEFAULT_BASE_URL, "UMIEM_LLM_BASE_URL", allowHost);

    const estimateUsd = estimateProbeCostUsd({ generations: 1 });
    const ledger =
      process.env.UMIEM_PROBE_COSTS_INIT === "1"
        ? initCostLedger(costsPath, costCapFromEnv(process.env.UMIEM_PROBE_COSTS_CAP_USD))
        : readCostLedger(costsPath);
    assertWithinCostCap(ledger, estimateUsd, `generowanie ${subjectKind}`);
    const costEntry = {
      probe: `chapter:${subjectKind}`,
      dump: materialPath === undefined ? "default-grammar-material" : basename(materialPath),
    };
    // Katalogi wszystkich plików wyjściowych przed płatnym wywołaniem: brak katalogu nie może zmarnować generowania.
    for (const directory of [outDir, ...[poolDumpPath, dumpPath].flatMap((path) => (path === undefined ? [] : [dirname(path)]))]) {
      mkdirSync(directory, { recursive: true });
    }

    const recorded = recordingLlm(deps.llm);
    const services = createServices({
      db: testDatabase().db,
      generation: { ...deps, llm: recorded.llm },
    });

    const titleOf = { chapter: "Angielski — rozdział", school: "szkoła (Geografia)", grammar: "Angielski — gramatyka (Present Simple)" } as const;
    line("");
    line(`=== Próba generowania: ${titleOf[subjectKind]} ===`);
    line(`model=${recorded.llm.model} host=${llmHost} pula=${poolSize} materiał=${material.length} znaków; ` +
      `szacunek=${estimateUsd.toFixed(2)} USD, wydane dotąd=${ledger.spentUsd.toFixed(4)} z ${ledger.capUsd} USD`);

    // Odrzucenia reguł puli widać tylko w dzienniku generacji ("walidacja puli ... reguły:").
    // Wiersze dziennika (mogą nieść powody odrzuceń) tylko do pliku wyników, nie na konsolę.
    const lessonLog: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      const text = args.map(String).join(" ");
      if (text.startsWith("[lesson]")) {
        lessonLog.push(text);
        return;
      }
      originalLog(...args);
    };
    // Wpis tymczasowy (szacunek) przed pierwszym płatnym wywołaniem: zabity proces nadal liczy się do limitu.
    const provisionalId = appendProvisionalCostEntry(costsPath, { at: new Date().toISOString(), ...costEntry, costUsd: estimateUsd });

    const started = Date.now();
    const clientRequestId = randomUUID();
    let runId: string;
    let deckId: string;
    const costOf = () => events.reduce((sum, event) => sum + (event.providerCostUsd ?? 0), 0);
    const resultsPath = join(outDir, `chapter-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
    /** Plik wyników: wspólna część (wejście, model, czas, wywołania, koszt) i stan przebiegu. */
    const resultsOf = (run: { state: string; errorCode: string | null; durationMs: number } & Record<string, unknown>): Record<string, unknown> => ({
      schema: "chapter-generation-probe-results/v1",
      at: new Date().toISOString(),
      subjectKind,
      material: materialPath === undefined ? { file: null, chars: material.length } : { file: basename(materialPath), sha256: sha256File(materialPath), chars: material.length },
      model: recorded.llm.model,
      poolSize,
      ...run,
      calls: recorded.calls,
      costUsd: { total: costOf() },
      tokens: {
        in: events.reduce((sum, event) => sum + (event.inputTokens ?? 0), 0),
        out: events.reduce((sum, event) => sum + (event.outputTokens ?? 0), 0),
      },
      estimateUsd,
    });
    try {
      if (subjectKind === "grammar") {
        const subject = createProductionSubjectRegistry().getSubject("english_grammar");
        const topic = subject?.topics.filter((candidate) => candidate.id === "present_simple").sort((a, b) => b.version - a.version)[0];
        if (topic === undefined) throw new Error("Katalog english_grammar nie ma tematu present_simple");
        ({ runId, deckId } = await createLesson(services, {
          subjectId: "english_grammar",
          topicId: topic.id,
          objectiveIds: topic.objectives.map((objective) => objective.id),
          material,
          poolSize,
          clientRequestId,
        }));
      } else {
        const topicTitlePl = process.env.UMIEM_PROBE_TOPIC ?? (subjectKind === "school" ? "Mapa" : "Unit 1");
        ({ runId, deckId } = subjectKind === "school"
          ? await createSchoolLesson(services, { subjectTitlePl: "Geografia", topicTitlePl, material, poolSize, clientRequestId })
          : await createLessonFromMaterial(services, { subjectId: "english_chapter", topicTitlePl, material, poolSize, clientRequestId }));
      }
      await executeLessonGeneration(services, runId);
    } catch (error) {
      // Wyjątek przebiegu: plik wyników (czas, wywołania, klasa błędu, koszt) powstaje przed ponownym rzuceniem.
      // Komunikat błędu (może cytować treść) nie trafia ani do pliku, ani na konsolę z próby.
      writeFileSync(resultsPath, `${JSON.stringify(resultsOf({ state: "threw", errorCode: null, errorClass: errorClassOf(error), durationMs: Date.now() - started }), null, 2)}\n`, "utf8");
      line(`Przebieg zakończony wyjątkiem (${errorClassOf(error)}); wyniki: ${resultsPath}`);
      throw error;
    } finally {
      console.log = originalLog;
      // Koszt zawsze do rejestru — także po błędzie (pieniądze są wydane); brak usage.cost przy wywołaniach → szacunek.
      const { costUsd, estimated } = ledgerCost({
        measuredUsd: costOf(),
        calls: events.length,
        fallbackUsd: estimateProbeCostUsd({ generations: events.length > 0 ? 1 : 0 }),
      });
      if (estimated) line(`UWAGA: ${events.length} wywołań bez usage.cost — do rejestru wpisany szacunek ${costUsd.toFixed(4)} USD`);
      const updated = settleCostEntry(costsPath, provisionalId, {
        at: new Date().toISOString(),
        ...costEntry,
        costUsd,
        ...(estimated ? { estimated } : {}),
      });
      line(`koszt próby=${costOf().toFixed(4)} USD; ` +
        `łącznie wydane=${updated.spentUsd.toFixed(4)} z ${updated.capUsd} USD`);
    }
    const durationMs = Date.now() - started;

    const run = await readGeneration(services, runId);
    // Próba raportuje jakość bez asercji; wymaga tylko, by generacja się zakończyła.
    expect(["succeeded", "failed"]).toContain(run.state);
    line("");
    line(`Przebieg: stan=${run.state}${run.errorCode ? ` kod=${run.errorCode}` : ""}; czas=${(durationMs / 1000).toFixed(1)} s`);
    const poolCalls = recorded.calls.filter((call) => call.method === "pool");
    line(`Wywołania LLM: zagadnienia=${recorded.calls.filter((call) => call.method === "objectives").length}, pule=${poolCalls.length}; ` +
      `surowych ćwiczeń z modelu: ${poolCalls.reduce((sum, call) => sum + call.rawExercises, 0)}; ` +
      `czasy pul [s]: ${poolCalls.map((call) => (call.ms / 1000).toFixed(0)).join(", ")}; nieudane: ${recorded.calls.filter((call) => call.failed).length}`);

    const results = resultsOf({ state: run.state, errorCode: run.errorCode ?? null, durationMs });
    const writeResults = () => writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");

    const deck = await readLessonDeck(services, deckId);
    const draft = deck.draft;
    if (!draft) {
      writeResults();
      if (poolDumpPath !== undefined) throw new Error(`Brak szkicu po generacji (stan=${run.state}) — brak puli do zrzutu ${basename(poolDumpPath)}`);
      line("Brak szkicu po generacji — nie ma co raportować.");
      return;
    }
    line(`Dziennik generacji: ${lessonLog.length} wierszy (tylko w pliku wyników)`);
    results.draft = reportDraft(draft);
    const rawAll = recorded.raw.flatMap((pool) => pool.exercises);
    const unsolicitedV3 = countUnsolicitedV3(rawAll);
    if (subjectKind === "chapter") {
      line(`unsolicited v3 fields: ${unsolicitedV3} of ${rawAll.length} (stripped)`);
    }

    // Zrzut końcowego szkicu PRZED próbą publikacji (stan szkicu po `executeLessonGeneration`).
    if (poolDumpPath !== undefined) {
      const poolDump = await poolDumpOf(draft, material, {
        probe: "chapter-generation",
        at: new Date().toISOString(),
        subjectKind,
        materialSha256: materialPath === undefined ? null : sha256File(materialPath),
        model: recorded.llm.model,
        runState: run.state,
        phase: "final draft after executeLessonGeneration (hard exposure rule and top-up applied)",
      });
      writeFileSync(poolDumpPath, `${JSON.stringify(poolDump, null, 2)}\n`, "utf8");
      results.poolDump = { file: basename(poolDumpPath), sha256: sha256File(poolDumpPath), exercises: draft.exercises.length, objectives: (poolDump.objectives as unknown[]).length };
      line(`Zrzut puli i zagadnień (${draft.exercises.length} ćwiczeń, ${(poolDump.objectives as unknown[]).length} zagadnień): ${poolDumpPath}`);
    }

    let publishable: string;
    try {
      await publishLessonDraft(services, draft.id, draft.editNumber);
      publishable = "TAK (publishLessonDraft przeszedł; baza próby jest jednorazowa)";
    } catch (error) {
      // Na konsolę tylko kod i klasa błędu; komunikat (może cytować ćwiczenia) wyłącznie w pliku wyników.
      const appError = error as { code?: string; message?: string; details?: unknown };
      publishable = `NIE (${appError.code ?? "błąd"}, ${errorClassOf(error)})`;
      results.publishableMessage = appError.message ?? null;
    }
    line(`Publikowalny: ${publishable}`);
    results.publishable = publishable;
    results.lessonLog = lessonLog.map((text) => text.replace(/run=[0-9a-f-]+ /u, ""));
    writeResults();
    line(`Wyniki: ${resultsPath}`);
    line("");

    if (dumpPath) {
      writeFileSync(
        dumpPath,
        JSON.stringify(
          {
            draft,
            rawObjectives: recorded.rawObjectives,
            rawPools: recorded.raw,
            calls: recorded.calls,
            publishable,
            unsolicitedV3,
            lessonLog,
            durationMs,
          },
          null,
          2,
        ),
        "utf8",
      );
      line(`Zrzut pełnego szkicu i surowego wyjścia modelu: ${dumpPath}`);
    }
  });
});
