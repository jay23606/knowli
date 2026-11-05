import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptVerdictAsVariant,
  claimQueuedRun,
  createDrizzleUsageRecorder,
  createLesson,
  createLessonFromMaterial,
  createSchoolLesson,
  createServices,
  createSubjectRegistry,
  editLessonDraft,
  englishGrammarSubject,
  executeLessonGeneration,
  historyLikeSubject,
  regenerateObjective,
  retryGeneration,
  runDueGenerationWork,
  type GenerationDeps,
  type LessonAgentDeps,
  type Services,
} from "@learning/server";
import { lessonAgentDepsFromEnv } from "@learning/server/lesson-agent";
import type { LessonCommand } from "@learning/contracts";
import { testDatabase } from "./helpers";
import { ManualClock } from "./helpers";
import { fakeGeneration, type FakeGeneration } from "./fakes";
import type { LessonReviewReport } from "../../packages/server/src/domain/lessons/review-report";
import { GenerationProviderError } from "../../packages/server/src/ports/generation-error";
import { FakeLessonReviewer } from "../../packages/server/src/providers/fake";
import {
  FakeExerciseChecker,
  FakeLessonPoolAgent,
  type FakeAgentStep,
  type FakeLessonPoolAgentOptions,
} from "../../packages/server/src/providers/fake-lesson-agent";
import type { LlmProvider } from "../../packages/server/src/ports/ai";
import {
  DEFAULT_LESSON_GENERATION_POLICY,
  type LessonGenerationPolicy,
} from "../../packages/server/src/modules/materials/lessons/lesson-generation-policy";

import type { LessonExerciseDraft } from "../../packages/server/src/domain/lessons/types";
import { stageOf } from "../../packages/server/src/domain/lessons/stages";
import { solvedSentencesOf } from "../../packages/server/src/domain/lessons/story";
import { supersedeLessonRuns } from "../../packages/server/src/modules/materials/generation-runs";
import {
  emptyLessonAgentProgress,
  LessonAgentCheckpointLostError,
  parseLessonAgentProgress,
  saveLessonAgentCheckpoint,
  type LessonAgentProgress,
} from "../../packages/server/src/modules/materials/lessons/lesson-agent-checkpoint";
import { listenChoiceAllowance, markLessonRun, type LessonRunIdentity } from "../../packages/server/src/modules/materials/lessons/lesson-drafts";

const { pool } = testDatabase();

const OBJECTIVE = "english_grammar.present_simple.third_person_s";

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

function lessonServices(fakes: FakeGeneration, clock = new ManualClock()): Services {
  const { db } = testDatabase();
  return createServices({
    db,
    clock,
    media: fakes.settings,
    generation: fakes.deps,
    subjects: createSubjectRegistry([englishGrammarSubject, historyLikeSubject]),
  });
}

function command(overrides: Partial<LessonCommand> = {}): LessonCommand {
  return {
    subjectId: "english_grammar",
    topicId: "present_simple",
    objectiveIds: [OBJECTIVE],
    material: "He plays football. She watches TV. They study English every day.",
    instruction: "Ćwicz -s w 3. osobie.",
    clientRequestId: randomUUID(),
    ...overrides,
  };
}

const exercise: LessonExerciseDraft = {
  exerciseType: "lesson_choice",
  objectiveId: OBJECTIVE,
  stem: "He ___ football.",
  answer: "plays",
  acceptedAnswers: ["plays"],
  focus: ["-s"],
  options: [{ id: "a", text: "plays" }, { id: "b", text: "play" }],
  correctOption: "a",
};

function progress(overrides: Partial<LessonAgentProgress> = {}): LessonAgentProgress {
  return {
    ...emptyLessonAgentProgress(),
    objectives: { [OBJECTIVE]: { status: "complete", exercises: [exercise], examples: ["He plays."] } },
    budgetSpentUsd: 0.4,
    totalSpentUsd: 0.7,
    rejectionCodes: { solver_mismatch: 1 },
    ...overrides,
  };
}

interface RunRow {
  state: string;
  attempts: number;
  expected_edit_number: number;
  deck_version_id: string;
  agent_checkpoint: unknown;
}

async function runRow(runId: string): Promise<RunRow> {
  const [row] = await query<RunRow>(
    "select state, attempts, expected_edit_number, deck_version_id, agent_checkpoint from learning_app.generation_runs where id = $1",
    [runId],
  );
  return row!;
}

/** Tożsamość bieżącej próby runu, tak jak widzi ją ścieżka wykonania po claimie. */
async function identityOf(runId: string): Promise<LessonRunIdentity> {
  const row = await runRow(runId);
  return { runId, attempts: row.attempts, expectedEditNumber: row.expected_edit_number, deckVersionId: row.deck_version_id };
}

/** Lekcja z runem puli przejętym przez worker (`running`, próba 1). */
async function runningLesson(services: Services): Promise<{ runId: string; deckVersionId: string; run: LessonRunIdentity }> {
  const { runId } = await createLesson(services, command());
  expect(await claimQueuedRun(services.db, runId)).toBe(1);
  const run = await identityOf(runId);
  return { runId, deckVersionId: run.deckVersionId, run };
}

describe("agent puli lekcji (integracja)", () => {
  const disposers: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    await pool.query(
      `truncate learning_app.generation_runs, learning_app.revision_assets, learning_app.media_assets,
              learning_app.item_revision_skills, learning_app.item_revisions, learning_app.skill_versions,
              learning_app.learning_items, learning_app.deck_versions, learning_app.decks cascade`,
    );
  });

  afterEach(async () => {
    for (const dispose of disposers.splice(0)) {
      await dispose();
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  async function setup(): Promise<Services> {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    return lessonServices(fakes);
  }

  describe("punkt kontrolny", () => {
    it("zapis przechodzi dla bieżącej próby", async () => {
      const services = await setup();
      const { runId, run } = await runningLesson(services);
      await saveLessonAgentCheckpoint(services.db, run, progress());
      expect(parseLessonAgentProgress((await runRow(runId)).agent_checkpoint, runId)).toEqual(progress());
      // cała wartość zastępuje poprzednią
      await saveLessonAgentCheckpoint(services.db, run, progress({ budgetSpentUsd: 0.5, totalSpentUsd: 0.8 }));
      expect((await runRow(runId)).agent_checkpoint).toMatchObject({ budgetSpentUsd: 0.5, totalSpentUsd: 0.8 });
    });

    it("odrzucony po edycji rodzica (superseded)", async () => {
      const services = await setup();
      const { runId, deckVersionId, run } = await runningLesson(services);
      await saveLessonAgentCheckpoint(services.db, run, progress());
      await editLessonDraft(services, deckVersionId, { expectedEditNumber: run.expectedEditNumber, examples: {} });
      expect((await runRow(runId)).state).toBe("superseded");
      await expect(saveLessonAgentCheckpoint(services.db, run, progress())).rejects.toBeInstanceOf(LessonAgentCheckpointLostError);
      expect((await runRow(runId)).agent_checkpoint).toBeNull();
    });

    it("odrzucony po podbiciu editNumber bez anulowania runów", async () => {
      const services = await setup();
      const { runId, deckVersionId, run } = await runningLesson(services);
      // nie każda zmiana szkicu anuluje runy (nadzór rodzica) — straż patrzy na numer edycji wersji
      await pool.query("update learning_app.deck_versions set edit_number = edit_number + 1 where id = $1", [deckVersionId]);
      await expect(saveLessonAgentCheckpoint(services.db, run, progress())).rejects.toBeInstanceOf(LessonAgentCheckpointLostError);
      const row = await runRow(runId);
      expect(row.state).toBe("running");
      expect(row.agent_checkpoint).toBeNull();
    });

    it("odrzucony dla starej próby (inne attempts)", async () => {
      const services = await setup();
      const { runId, run: first } = await runningLesson(services);
      await markLessonRun(services.db, services.clock, first, "queued", "provider");
      expect(await claimQueuedRun(services.db, runId)).toBe(2);
      await expect(saveLessonAgentCheckpoint(services.db, first, progress())).rejects.toBeInstanceOf(LessonAgentCheckpointLostError);
      expect((await runRow(runId)).agent_checkpoint).toBeNull();
      await saveLessonAgentCheckpoint(services.db, await identityOf(runId), progress());
      expect((await runRow(runId)).agent_checkpoint).not.toBeNull();
    });

    it("supersedeLessonRuns zeruje kolumnę", async () => {
      const services = await setup();
      const { runId, deckVersionId, run } = await runningLesson(services);
      await saveLessonAgentCheckpoint(services.db, run, progress());
      await supersedeLessonRuns(services.db, deckVersionId, services.clock.now());
      const row = await runRow(runId);
      expect(row.state).toBe("superseded");
      expect(row.agent_checkpoint).toBeNull();
    });

    it("markLessonRun superseded zeruje kolumnę", async () => {
      const services = await setup();
      const { runId, run } = await runningLesson(services);
      await saveLessonAgentCheckpoint(services.db, run, progress());
      await markLessonRun(services.db, services.clock, run, "superseded", null);
      const row = await runRow(runId);
      expect(row.state).toBe("superseded");
      expect(row.agent_checkpoint).toBeNull();
    });

    it("markLessonRun failed zostawia postęp do „Ponów”", async () => {
      const services = await setup();
      const { runId, run } = await runningLesson(services);
      await saveLessonAgentCheckpoint(services.db, run, progress());
      await markLessonRun(services.db, services.clock, run, "failed", "provider");
      expect(parseLessonAgentProgress((await runRow(runId)).agent_checkpoint, runId)).toEqual(progress());
    });

    it("Ponów: porażka, running i odroczone queued — postęp zostaje, budżet 0, totalSpentUsd bez zmian", async () => {
      const services = await setup();
      const expected = progress({ budgetSpentUsd: 0 });

      // porażka
      const failed = await runningLesson(services);
      await saveLessonAgentCheckpoint(services.db, failed.run, progress());
      await markLessonRun(services.db, services.clock, failed.run, "failed", "provider");
      await retryGeneration(services, failed.runId);
      expect((await runRow(failed.runId)).state).toBe("queued");
      expect(parseLessonAgentProgress((await runRow(failed.runId)).agent_checkpoint, failed.runId)).toEqual(expected);

      // running po awarii workera
      const running = await runningLesson(services);
      await saveLessonAgentCheckpoint(services.db, running.run, progress());
      await retryGeneration(services, running.runId);
      expect((await runRow(running.runId)).state).toBe("queued");
      expect(parseLessonAgentProgress((await runRow(running.runId)).agent_checkpoint, running.runId)).toEqual(expected);
      // spóźniony worker starej próby nie nadpisze punktu kontrolnego
      await expect(saveLessonAgentCheckpoint(services.db, running.run, progress())).rejects.toBeInstanceOf(LessonAgentCheckpointLostError);

      // odroczone queued (automatyczne ponowienie z opóźnieniem)
      const deferred = await runningLesson(services);
      await saveLessonAgentCheckpoint(services.db, deferred.run, progress());
      await markLessonRun(services.db, services.clock, deferred.run, "queued", "provider", new Date(services.clock.now().getTime() + 60_000));
      await retryGeneration(services, deferred.runId);
      const deferredRow = await runRow(deferred.runId);
      expect(deferredRow.state).toBe("queued");
      expect(deferredRow.attempts).toBe(0);
      expect(parseLessonAgentProgress(deferredRow.agent_checkpoint, deferred.runId)).toEqual(expected);
    });

    it("Ponów: run bez punktu kontrolnego zostaje bez niego", async () => {
      const services = await setup();
      const { runId, run } = await runningLesson(services);
      await markLessonRun(services.db, services.clock, run, "failed", "provider");
      await retryGeneration(services, runId);
      const row = await runRow(runId);
      expect(row.state).toBe("queued");
      expect(row.agent_checkpoint).toBeNull();
    });
  });

  describe("ścieżka agenta w executeLessonGeneration", () => {
    const NEGATIVE = "english_grammar.present_simple.negative";
    const CHAPTER_MATERIAL = [
      "Słowa:",
      "coat — płaszcz",
      "boots — buty",
      "scarf — szalik",
      "gloves — rękawiczki",
      "Zwroty:",
      "I am wearing …",
      "Put on your …",
    ].join("\n");
    const SCHOOL_MATERIAL = [
      "Zagadnienie 1: Rzeki Polski",
      "Wisła jest najdłuższą rzeką Polski. Odra płynie na zachodzie kraju.",
      "Zagadnienie 2: Góry Polski",
      "Tatry są najwyższymi górami Polski. Sudety leżą na południowym zachodzie.",
    ].join("\n");
    const PRESET_REVIEW: LessonReviewReport = {
      status: "reviewed",
      model: "fake-reviewer-1",
      objectives: [],
      changed: [],
      dropped: [],
      notes: [],
      toppedUp: [],
      machine: [],
    };

    interface AgentWorld {
      fakes: FakeGeneration;
      services: Services;
      agent: FakeLessonPoolAgent;
      reviewer: FakeLessonReviewer;
      clock: ManualClock;
    }

    function servicesWith(fakes: FakeGeneration, generation: GenerationDeps, clock: ManualClock): Services {
      return createServices({ db: testDatabase().db, clock, media: fakes.settings, generation });
    }

    /** Scenariusz fake'a agenta: stały albo budowany z fake'ów świata (kroki „jak LLM” w ponowieniach). */
    type AgentScript = Omit<FakeLessonPoolAgentOptions, "fromLlm"> | ((fakes: FakeGeneration) => FakeLessonPoolAgentOptions);

    interface WorldOptions {
      readonly policy?: LessonAgentDeps["policy"];
      readonly finalizationReserveMs?: number;
      readonly execution?: Partial<LessonGenerationPolicy>;
    }

    /**
     * Produkcyjny rejestr, fake LLM, fake agenta (domyślnie „jak LLM”), checker niedostępny, gotowy krytyk.
     * Kontroler sprawdza bieżącość próby co 20 ms (edycja i „Ponów” w trakcie przerywają próbę od razu).
     */
    async function agentWorld(subjects: string[], agentOptions: AgentScript = {}, world: WorldOptions = {}): Promise<AgentWorld> {
      const fakes = await fakeGeneration();
      disposers.push(fakes.dispose);
      const options = typeof agentOptions === "function" ? agentOptions(fakes) : agentOptions;
      const agent = new FakeLessonPoolAgent({ fromLlm: fakes.llm, ...options });
      const lessonAgent: LessonAgentDeps = {
        subjects: new Set(subjects),
        agent,
        checker: new FakeExerciseChecker({ unavailable: true }),
        policy: world.policy ?? {},
        ...(world.finalizationReserveMs === undefined ? {} : { finalizationReserveMs: world.finalizationReserveMs }),
      };
      fakes.deps.lessonExecution = { ...DEFAULT_LESSON_GENERATION_POLICY, cancelPollMs: 20, ...world.execution };
      const reviewer = new FakeLessonReviewer();
      fakes.deps.reviewer = {
        state: "ready",
        provider: reviewer,
        policy: { timeoutMs: 60_000, concurrency: 3, maxCallsPerRun: 12, phaseBudgetMs: 240_000 },
      };
      fakes.deps.lessonAgent = lessonAgent;
      const clock = new ManualClock();
      return { fakes, services: servicesWith(fakes, fakes.deps, clock), agent, reviewer, clock };
    }

    interface VersionRow {
      id: string;
      edit_number: number;
      state: string;
      lesson_context: Record<string, unknown>;
    }

    interface FullRunRow extends RunRow {
      error_code: string | null;
      next_attempt_at: Date | null;
    }

    async function fullRun(runId: string): Promise<FullRunRow> {
      const [row] = await query<FullRunRow>(
        "select state, attempts, expected_edit_number, deck_version_id, agent_checkpoint, error_code, next_attempt_at from learning_app.generation_runs where id = $1",
        [runId],
      );
      return row!;
    }

    async function versionOf(runId: string): Promise<VersionRow> {
      const [row] = await query<VersionRow>(
        `select v.id, v.edit_number, v.state, v.lesson_context from learning_app.deck_versions v
         join learning_app.generation_runs r on r.deck_version_id = v.id where r.id = $1`,
        [runId],
      );
      return row!;
    }

    async function exerciseCount(versionId: string): Promise<number> {
      const [row] = await query<{ count: string }>("select count(*) from learning_app.item_revisions where deck_version_id = $1", [versionId]);
      return Number(row!.count);
    }

    async function setCheckpoint(runId: string, value: unknown): Promise<void> {
      await pool.query("update learning_app.generation_runs set agent_checkpoint = $1::jsonb where id = $2", [JSON.stringify(value), runId]);
    }

    async function setContextField(versionId: string, field: string, value: unknown): Promise<void> {
      await pool.query(
        "update learning_app.deck_versions set lesson_context = jsonb_set(lesson_context, $1::text[], $2::jsonb) where id = $3",
        [[field], JSON.stringify(value), versionId],
      );
    }

    async function storyRunStates(versionId: string): Promise<string[]> {
      const rows = await query<{ state: string }>(
        "select state from learning_app.generation_runs where deck_version_id = $1 and input->>'purpose' = 'story'",
        [versionId],
      );
      return rows.map((row) => row.state);
    }

    function expectSummaryWithoutContent(checkpoint: unknown, attempts: number): void {
      const summary = checkpoint as { kind: string; objectives: Record<string, Record<string, unknown>>; attempts: number };
      expect(summary.kind).toBe("summary");
      expect(summary.attempts).toBe(attempts);
      expect(Object.keys(summary).sort()).toEqual(["attempts", "kind", "objectives", "rejectionCodes", "totalSpentUsd", "version"]);
      for (const entry of Object.values(summary.objectives)) {
        for (const key of Object.keys(entry)) expect(["status", "accepted", "failureCode"]).toContain(key);
      }
    }

    /** Przejściowy błąd dostawcy (ponawialny, kod `provider`). */
    const transient = (): FakeAgentStep => ({ throw: new GenerationProviderError("transient") });

    /**
     * Krok „jak LLM” w scenariuszu ponowień: wywołanie spoza listy `calls` nie ma kroków (nie wraca do
     * `fromLlm`), więc wynik generatora w ponowieniu podaje się jawnie (krok wewnętrzny fake'a).
     */
    const llmStep = (llm: LlmProvider): FakeAgentStep => ({ fromLlm: llm }) as unknown as FakeAgentStep;

    /** Wywołanie „w locie”, które kończy tylko przerwanie sygnału. */
    const never = (): FakeAgentStep => ({ gate: new Promise<void>(() => undefined) });

    interface Gate {
      readonly step: FakeAgentStep;
      readonly reached: Promise<void>;
      open(): void;
    }

    /** Wywołanie „w locie”: `reached` po dojściu fake'a do kroku, `open()` kończy krok. */
    function gate(): Gate {
      let open!: () => void;
      let reach!: () => void;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        reach = resolve;
      });
      return { step: { gate: opened, onReached: reach }, reached, open };
    }

    /** Ponowienie z opóźnieniem wymagalne od razu (kolejne przejęcie bez czekania na zegar). */
    async function dueNow(runId: string): Promise<void> {
      await pool.query("update learning_app.generation_runs set next_attempt_at = null where id = $1", [runId]);
    }

    async function progressOf(runId: string): Promise<LessonAgentProgress | undefined> {
      return parseLessonAgentProgress((await fullRun(runId)).agent_checkpoint, runId);
    }

    /** Czeka, aż hak rozliczenia zapisze zagadnienie w punkcie kontrolnym (próba nadal trwa). */
    async function untilSettled(runId: string, objectiveId: string): Promise<void> {
      await vi.waitFor(async () => {
        expect((await progressOf(runId))?.objectives[objectiveId]).toBeDefined();
      }, { timeout: 10_000, interval: 10 });
    }

    /** Zagadnienia ćwiczeń szkicu (bez powtórzeń, w kolejności pozycji). */
    async function draftObjectives(versionId: string): Promise<string[]> {
      const rows = await query<{ objective_id: string }>(
        `select payload->>'objectiveId' as objective_id from learning_app.item_revisions
          where deck_version_id = $1 order by position`,
        [versionId],
      );
      return [...new Set(rows.map((row) => row.objective_id))];
    }

    const slugOf = (objectiveId: string) => objectiveId.split(".").at(-1)!;

    interface DraftContext {
      rejectedCount?: number;
      droppedObjectiveCount?: number;
      generationGaps?: unknown;
    }

    const contextOf = (version: VersionRow) => version.lesson_context as DraftContext;
    const summaryOf = (row: FullRunRow) =>
      row.agent_checkpoint as { totalSpentUsd: number; objectives: Record<string, { status: string; accepted: number }> };

    it("rozdział: planer → szkic, dynamicTopic, przykłady, editNumber+1, podsumowanie bez treści, krytyk nie wołany i jego raport bez zmian", async () => {
      const { fakes, services, agent, reviewer } = await agentWorld(["english_chapter"]);
      const { runId, deckId } = await createLessonFromMaterial(services, {
        subjectId: "english_chapter",
        topicTitlePl: "Unit 1",
        material: CHAPTER_MATERIAL,
        poolSize: 40,
        clientRequestId: randomUUID(),
      });
      const before = await versionOf(runId);
      await setContextField(before.id, "review", PRESET_REVIEW);

      await executeLessonGeneration(services, runId);

      const row = await fullRun(runId);
      expect(row.state).toBe("succeeded");
      expect(agent.planCalls).toHaveLength(1);
      expect(fakes.llm.lessonRequests.length).toBeGreaterThan(0);
      const after = await versionOf(runId);
      expect(after.edit_number).toBe(before.edit_number + 1);
      expect(after.state).toBe("review");
      expect(await exerciseCount(after.id)).toBeGreaterThan(0);
      const context = after.lesson_context as {
        dynamicTopic: { objectives: { id: string; kind?: string }[] };
        objectiveIds: string[];
        examples: Record<string, string[]>;
        review: unknown;
      };
      const objectiveIds = context.dynamicTopic.objectives.map((objective) => objective.id);
      expect(objectiveIds).toEqual([1, 2, 3].map((n) => `english_chapter.d${deckId}.part_${n}`));
      expect(context.dynamicTopic.objectives.map((objective) => objective.kind)).toEqual(["words", "words", "frame"]);
      expect(context.objectiveIds).toEqual(objectiveIds);
      for (const id of objectiveIds) expect(context.examples[id]!.length).toBeGreaterThan(0);
      // Krytyk nie jest wołany na ścieżce agenta, a raport w kontekście zostaje bez zmian.
      expect(reviewer.inputs).toEqual([]);
      expect(context.review).toEqual(PRESET_REVIEW);
      expectSummaryWithoutContent(row.agent_checkpoint, 1);
      // Rozdział nie ma historyjki — kolejkę historyjki sprawdza test gramatyki (przedmiot z `lessonStory`).
      expect(await storyRunStates(after.id)).toEqual([]);
    });

    it("gramatyka (katalog) i szkoła (etap zagadnień z fake LLM)", async () => {
      const { fakes, services, agent } = await agentWorld(["english_grammar", "school"]);

      const grammar = await createLesson(services, command());
      await executeLessonGeneration(services, grammar.runId);
      const grammarRow = await fullRun(grammar.runId);
      expect(grammarRow.state).toBe("succeeded");
      // Temat katalogu zawężony do zagadnień lekcji: tylko wybrane zagadnienie, nie cały temat.
      expect(agent.calls.map((call) => call.objectiveId)).toEqual([OBJECTIVE]);
      const grammarVersion = await versionOf(grammar.runId);
      const objectiveRows = await query<{ objective_id: string }>(
        "select payload->>'objectiveId' as objective_id from learning_app.item_revisions where deck_version_id = $1",
        [grammarVersion.id],
      );
      expect(objectiveRows.length).toBeGreaterThan(0);
      expect(new Set(objectiveRows.map((item) => item.objective_id))).toEqual(new Set([OBJECTIVE]));
      expectSummaryWithoutContent(grammarRow.agent_checkpoint, 1);
      // Nowa pula przedmiotu z historyjką zleca run historyjki (wspólny zapis).
      expect(await storyRunStates(grammarVersion.id)).toEqual(["queued"]);

      const school = await createSchoolLesson(services, {
        subjectTitlePl: "Geografia",
        topicTitlePl: "Polska",
        material: SCHOOL_MATERIAL,
        poolSize: 40,
        clientRequestId: randomUUID(),
      });
      await executeLessonGeneration(services, school.runId);
      const schoolRow = await fullRun(school.runId);
      expect(schoolRow.state).toBe("succeeded");
      expect(fakes.llm.objectiveRequests).toHaveLength(1);
      const schoolVersion = await versionOf(school.runId);
      const schoolContext = schoolVersion.lesson_context as { dynamicTopic: { objectives: { id: string }[] }; objectiveIds: string[] };
      expect(schoolContext.dynamicTopic.objectives).toHaveLength(2);
      for (const id of schoolContext.objectiveIds) expect(id.startsWith(`school.d${school.deckId}.`)).toBe(true);
      expect(await exerciseCount(schoolVersion.id)).toBeGreaterThan(0);
      expectSummaryWithoutContent(schoolRow.agent_checkpoint, 1);
    });

    it("zero przyjętych → failed validation, liczniki w kontekście", async () => {
      const { services } = await agentWorld(["english_grammar"], { objectives: { third_person_s: [] } });
      const { runId } = await createLesson(services, command());
      const before = await versionOf(runId);
      // Wcześniejsza próba usunęła 2 ćwiczenia po przyjęciu (bezpiecznik); ta nic nie przyjmuje.
      await setCheckpoint(runId, { ...emptyLessonAgentProgress(), removedAfterAcceptance: 2, budgetSpentUsd: 0.1, totalSpentUsd: 0.1 });

      await executeLessonGeneration(services, runId);

      const row = await fullRun(runId);
      expect(row.state).toBe("failed");
      expect(row.error_code).toBe("validation");
      const after = await versionOf(runId);
      expect(after.edit_number).toBe(before.edit_number);
      expect(await exerciseCount(after.id)).toBe(0);
      expect((after.lesson_context as { rejectedCount: number }).rejectedCount).toBe(
        ((before.lesson_context as { rejectedCount?: number }).rejectedCount ?? 0) + 2,
      );
      // Postęp zostaje do „Ponów” (z wpisem zagadnienia tej próby); liczniki już są w kontekście.
      const progressAfter = parseLessonAgentProgress(row.agent_checkpoint, runId);
      expect(progressAfter?.objectives[OBJECTIVE]?.status).toBe("incomplete");
      expect(progressAfter?.removedAfterAcceptance).toBe(0);
    });

    it("wszystkie zagadnienia provider_configuration → failed provider_configuration bez ponowienia", async () => {
      const refused = () => [{ throw: new GenerationProviderError("configuration", { status: 401 }) }];
      const { services, agent } = await agentWorld(["english_grammar"], { objectives: { third_person_s: refused(), negative: refused() } });
      const { runId } = await createLesson(services, command({ objectiveIds: [OBJECTIVE, NEGATIVE] }));

      await executeLessonGeneration(services, runId);

      const row = await fullRun(runId);
      expect(row.state).toBe("failed");
      expect(row.error_code).toBe("provider_configuration");
      expect(row.attempts).toBe(1);
      expect(row.next_attempt_at).toBeNull();
      expect(agent.calls).toHaveLength(2);
      expect(Object.values(parseLessonAgentProgress(row.agent_checkpoint, runId)!.objectives).map((entry) => entry.failureCode)).toEqual([
        "provider_configuration",
        "provider_configuration",
      ]);
    });

    it("uszkodzony punkt kontrolny → start od zera z zachowanym wydatkiem", async () => {
      const { services, agent } = await agentWorld(["english_grammar", "english_chapter"]);
      // Zła obwiednia; wydatek wcześniejszych prób zostaje (ta próba tylko go powiększa).
      const grammar = await createLesson(services, command());
      await setCheckpoint(grammar.runId, { version: 1, kind: "progress", objectives: "x", budgetSpentUsd: 0.3, totalSpentUsd: 0.5 });
      await executeLessonGeneration(services, grammar.runId);
      const grammarRow = await fullRun(grammar.runId);
      expect(grammarRow.state).toBe("succeeded");
      expect(agent.calls.map((call) => call.objectiveId)).toEqual([OBJECTIVE]);
      expect(summaryOf(grammarRow).totalSpentUsd).toBeGreaterThanOrEqual(0.5);

      // Dobra obwiednia, temat łamiący reguły katalogu → planer od zera.
      const chapter = await createLessonFromMaterial(services, {
        subjectId: "english_chapter",
        topicTitlePl: "Unit 1",
        material: CHAPTER_MATERIAL,
        poolSize: 40,
        clientRequestId: randomUUID(),
      });
      await setCheckpoint(chapter.runId, {
        ...emptyLessonAgentProgress(),
        dynamicTopic: { titlePl: "", objectives: [] },
        budgetSpentUsd: 0.2,
        totalSpentUsd: 0.2,
      });
      await executeLessonGeneration(services, chapter.runId);
      const chapterRow = await fullRun(chapter.runId);
      expect(chapterRow.state).toBe("succeeded");
      expect(agent.planCalls).toHaveLength(1);
      expect(summaryOf(chapterRow).totalSpentUsd).toBeGreaterThanOrEqual(0.2);
    });

    it("przełączenie przedmiotu na potok między próbami → potok ignoruje postęp, pełny zapis usuwa generationGaps", async () => {
      const transient = { calls: [[{ throw: new GenerationProviderError("transient") }]] };
      const { fakes, services, agent, clock } = await agentWorld(["english_grammar"], { objectives: { third_person_s: transient } });
      const { runId } = await createLesson(services, command());

      await executeLessonGeneration(services, runId);
      const requeued = await fullRun(runId);
      expect(requeued.state).toBe("queued");
      expect(requeued.error_code).toBe("provider");
      expect(requeued.next_attempt_at).not.toBeNull();
      const saved = parseLessonAgentProgress(requeued.agent_checkpoint, runId);
      expect(saved?.objectives[OBJECTIVE]?.status).toBe("failed");
      expect(fakes.llm.lessonRequests).toHaveLength(0);

      const version = await versionOf(runId);
      await setContextField(version.id, "generationGaps", [{ objectiveId: OBJECTIVE, reason: "failed" }]);
      // Konfiguracja bez agenta: kolejna próba idzie potokiem.
      const pipelineServices = servicesWith(fakes, { ...fakes.deps, lessonAgent: undefined }, clock);
      clock.advanceMs(10 * 60_000);
      await executeLessonGeneration(pipelineServices, runId);

      const row = await fullRun(runId);
      expect(row.state).toBe("succeeded");
      expect(row.attempts).toBe(2);
      expect(agent.calls).toHaveLength(1);
      expect(fakes.llm.lessonRequests.length).toBeGreaterThan(0);
      // Potok nie czyta punktu kontrolnego, a jego sukces usuwa postęp agenta (treść ćwiczeń) z wiersza runu.
      expect(row.agent_checkpoint).toBeNull();
      const after = await versionOf(runId);
      expect(after.lesson_context).not.toHaveProperty("generationGaps");
      expect(await exerciseCount(after.id)).toBeGreaterThan(0);
    });

    it("przedmiot spoza listy → potok bez zmian (fake LLM wołany, agent nie)", async () => {
      const { fakes, services, agent } = await agentWorld(["english_chapter"]);
      const { runId } = await createLesson(services, command());

      await executeLessonGeneration(services, runId);

      const row = await fullRun(runId);
      expect(row.state).toBe("succeeded");
      expect(row.agent_checkpoint).toBeNull();
      expect(agent.calls).toEqual([]);
      expect(agent.planCalls).toEqual([]);
      expect(fakes.llm.lessonRequests.length).toBeGreaterThan(0);
    });

    it("potok: attempts > MAX przy złożonym agencie i przedmiocie spoza listy → attempts_exhausted bez wywołań", async () => {
      const { fakes, services, agent } = await agentWorld(["english_chapter"]);
      const { runId } = await createLesson(services, command());
      await pool.query("update learning_app.generation_runs set attempts = 3 where id = $1", [runId]);

      await executeLessonGeneration(services, runId);

      const row = await fullRun(runId);
      expect(row.state).toBe("failed");
      expect(row.error_code).toBe("attempts_exhausted");
      expect(row.attempts).toBe(4);
      expect(fakes.llm.lessonRequests).toEqual([]);
      expect(agent.calls).toEqual([]);
    });

    it("składanie z env: lessonAgentDepsFromEnv(UMIEM_FAKE_PROVIDERS=1 + lista) → pełna generacja ścieżką agenta", async () => {
      const fakes = await fakeGeneration();
      disposers.push(fakes.dispose);
      const registry = createSubjectRegistry([englishGrammarSubject, historyLikeSubject]);
      const lessonAgent = lessonAgentDepsFromEnv(
        { UMIEM_FAKE_PROVIDERS: "1", UMIEM_LESSON_AGENT_SUBJECTS: "english_grammar" },
        registry,
        undefined,
        fakes.llm,
      );
      expect(lessonAgent?.subjects).toEqual(new Set(["english_grammar"]));
      const services = createServices({
        db: testDatabase().db,
        clock: new ManualClock(),
        media: fakes.settings,
        generation: { ...fakes.deps, lessonAgent },
        subjects: registry,
      });
      const { runId } = await createLesson(services, command());

      await executeLessonGeneration(services, runId);

      const row = await fullRun(runId);
      expect(row.state).toBe("succeeded");
      // Podsumowanie punktu kontrolnego zapisuje tylko ścieżka agenta.
      expectSummaryWithoutContent(row.agent_checkpoint, 1);
      expect(fakes.llm.lessonRequests.length).toBeGreaterThan(0);
      expect(await exerciseCount((await versionOf(runId)).id)).toBeGreaterThan(0);
    });

    it("rejectedCount = usunięcia po przyjęciu, nie odrzucenia w pętli", async () => {
      // Zagadnienie B: w próbie 1 błąd przejściowy, w próbie 2 tylko ćwiczenie o złym kształcie (odrzucenie w pętli).
      const malformed = [{ submit: { exercises: [{ exerciseType: "lesson_choice", objectiveId: NEGATIVE }] } }];
      const negative = { calls: [[{ throw: new GenerationProviderError("transient") }], malformed] };
      const { services, clock } = await agentWorld(["english_grammar"], { objectives: { negative } });
      const { runId } = await createLesson(services, command({ objectiveIds: [OBJECTIVE, NEGATIVE] }));
      const before = await versionOf(runId);
      await executeLessonGeneration(services, runId);
      const first = await fullRun(runId);
      expect(first.state).toBe("queued");
      const firstProgress = parseLessonAgentProgress(first.agent_checkpoint, runId)!;
      const own = firstProgress.objectives[OBJECTIVE]!;
      expect(own.exercises.length).toBeGreaterThan(0);
      // Punkt kontrolny jak po migawce sprzed bezpiecznika: zagadnienie A gotowe z duplikatem ćwiczenia
      // i 2 usunięcia bezpiecznika kierownika we wcześniejszych próbach.
      await setCheckpoint(runId, {
        ...firstProgress,
        objectives: { [OBJECTIVE]: { ...own, status: "complete", exercises: [...own.exercises, own.exercises[0]] } },
        removedAfterAcceptance: 2,
      });
      clock.advanceMs(10 * 60_000);

      await executeLessonGeneration(services, runId);

      const row = await fullRun(runId);
      expect(row.state).toBe("succeeded");
      const after = await versionOf(runId);
      expect(await exerciseCount(after.id)).toBe(own.exercises.length);
      const context = after.lesson_context as { rejectedCount: number; generationGaps?: unknown };
      // 2 (bezpiecznik) + 1 (kontrola końcowa: duplikat); odrzucenie w pętli się nie liczy.
      expect(context.rejectedCount).toBe(((before.lesson_context as { rejectedCount?: number }).rejectedCount ?? 0) + 3);
      // Zagadnienie A straciło w kontroli końcowej tylko duplikat — na zapisanej lekcji nadal jest kompletem.
      expect(context.generationGaps).toEqual([{ objectiveId: NEGATIVE, reason: "incomplete" }]);
      const summary = row.agent_checkpoint as { rejectionCodes: Record<string, number> };
      expect(Object.values(summary.rejectionCodes).reduce((sum, value) => sum + value, 0)).toBeGreaterThanOrEqual(1);
    });

    it("pełna pula: zapis odrzuca ćwiczenia potrzebne do minimum etapu → luka incomplete mimo kompletu u agenta", async () => {
      // Próba 1: A gotowe, B błąd przejściowy (punkt kontrolny z kompletem A); próba 2: B bez ćwiczeń.
      const malformed = [{ submit: { exercises: [{ exerciseType: "lesson_choice", objectiveId: NEGATIVE }] } }];
      const negative = { calls: [[{ throw: new GenerationProviderError("transient") }], malformed] };
      const { services, clock } = await agentWorld(["english_grammar"], { objectives: { negative } });
      const { runId } = await createLesson(services, command({ objectiveIds: [OBJECTIVE, NEGATIVE] }));
      await executeLessonGeneration(services, runId);
      const first = await fullRun(runId);
      expect(first.state).toBe("queued");
      const own = parseLessonAgentProgress(first.agent_checkpoint, runId)!.objectives[OBJECTIVE]!;
      expect(own.status).toBe("complete");
      // Historyjka szkicu powtarza rozwiązania wszystkich ćwiczeń etapu samodzielnego A — zapis je odrzuca.
      const independent = own.exercises.filter((exercise) => stageOf(exercise.exerciseType) === "independent");
      expect(independent.length).toBeGreaterThan(0);
      const version = await versionOf(runId);
      await setContextField(version.id, "story", {
        sentences: solvedSentencesOf(independent),
        questions: [{ id: "q1", question: "Kto?", options: [{ id: "a", text: "Tom" }, { id: "b", text: "Ola" }], correctOption: "a" }],
      });
      clock.advanceMs(10 * 60_000);

      await executeLessonGeneration(services, runId);

      expect((await fullRun(runId)).state).toBe("succeeded");
      const after = await versionOf(runId);
      const written = await query<{ exercise_type: string }>(
        "select payload->>'exerciseType' as exercise_type from learning_app.item_revisions where deck_version_id = $1",
        [after.id],
      );
      expect(written.length).toBeGreaterThan(0);
      expect(written.filter((row) => stageOf(row.exercise_type as LessonExerciseDraft["exerciseType"]) === "independent")).toEqual([]);
      // Na zapisanej lekcji A nie spełnia minimum etapu samodzielnego: luka mimo kompletu u agenta.
      expect(contextOf(after).generationGaps).toEqual([
        { objectiveId: OBJECTIVE, reason: "incomplete" },
        { objectiveId: NEGATIVE, reason: "incomplete" },
      ]);
    });

    it("podsumowanie punktu kontrolnego wycofane razem z nieudanym zapisem końcowym", async () => {
      const { services } = await agentWorld(["english_grammar"]);
      const { runId } = await createLesson(services, command());
      const before = await versionOf(runId);
      // Awaria transakcji końcowej PO zapisie podsumowania (podbicie numeru edycji).
      await pool.query(`create or replace function learning_app.test_fail_edit_number() returns trigger language plpgsql as $$
        begin raise exception 'test: final write failed'; end $$`);
      await pool.query(`create trigger test_fail_edit_number before update of edit_number on learning_app.deck_versions
        for each row execute function learning_app.test_fail_edit_number()`);
      try {
        await executeLessonGeneration(services, runId);
      } finally {
        await pool.query("drop trigger if exists test_fail_edit_number on learning_app.deck_versions");
        await pool.query("drop function if exists learning_app.test_fail_edit_number()");
      }

      const row = await fullRun(runId);
      expect(row.state).toBe("queued");
      // Podsumowanie wycofane: zostaje postęp (z ćwiczeniami) do kolejnej próby.
      const progressAfter = parseLessonAgentProgress(row.agent_checkpoint, runId);
      expect(progressAfter?.objectives[OBJECTIVE]?.exercises.length).toBeGreaterThan(0);
      const after = await versionOf(runId);
      expect(after.edit_number).toBe(before.edit_number);
      expect(await exerciseCount(after.id)).toBe(0);
      expect(after.lesson_context).toEqual(before.lesson_context);
    });

    describe("wznawianie, próby, terminy, budżet, straże i „Ponów”", () => {
      const QUESTION = "english_grammar.present_simple.question";

      it("błąd przejściowy zagadnienia → queued; kolejna próba pomija gotowe, planera i etap zagadnień szkoły, przenosi wydatek, kończy zapisem", async () => {
        // Drugie zagadnienie rozdziału i szkoły: w próbie 1 błąd przejściowy, w próbie 2 wynik generatora.
        const flaky = (fakes: FakeGeneration) => ({ calls: [[transient()], [llmStep(fakes.llm)]] });
        const { fakes, services, agent } = await agentWorld(["english_chapter", "school"], (fakes) => ({
          stepCostUsd: 0.01,
          objectives: { part_2: flaky(fakes), gory_polski: flaky(fakes) },
        }));
        const callsOf = (prefix: string) => agent.calls.filter((call) => call.objectiveId.startsWith(prefix)).map((call) => slugOf(call.objectiveId));

        // Rozdział (planer).
        const chapter = await createLessonFromMaterial(services, {
          subjectId: "english_chapter",
          topicTitlePl: "Unit 1",
          material: CHAPTER_MATERIAL,
          poolSize: 40,
          clientRequestId: randomUUID(),
        });
        await executeLessonGeneration(services, chapter.runId);
        const requeued = await fullRun(chapter.runId);
        expect(requeued.state).toBe("queued");
        expect(requeued.error_code).toBe("provider");
        expect(requeued.next_attempt_at).not.toBeNull();
        const saved = parseLessonAgentProgress(requeued.agent_checkpoint, chapter.runId)!;
        // Fake generatora rozdziału nie domyka zagadnień słów i ram — `incomplete` startują od zera jak `failed`.
        expect(Object.fromEntries(Object.entries(saved.objectives).map(([id, entry]) => [slugOf(id), entry.status]))).toEqual({
          part_1: "incomplete",
          part_2: "failed",
          part_3: "incomplete",
        });
        expect(saved.dynamicTopic?.objectives).toHaveLength(3);
        expect(Object.keys(saved.planExamples ?? {})).toHaveLength(3);
        // Planer i trzy zagadnienia — po jednym kroku.
        expect(saved.budgetSpentUsd).toBeCloseTo(0.04, 6);
        expect(saved.totalSpentUsd).toBeCloseTo(0.04, 6);

        await dueNow(chapter.runId);
        await executeLessonGeneration(services, chapter.runId);
        const chapterRow = await fullRun(chapter.runId);
        expect(chapterRow.state).toBe("succeeded");
        expect(chapterRow.attempts).toBe(2);
        // Planer pominięty: temat i przykłady planu z punktu kontrolnego.
        expect(agent.planCalls).toHaveLength(1);
        expect(callsOf("english_chapter.")).toEqual(["part_1", "part_2", "part_3", "part_1", "part_2", "part_3"]);
        expectSummaryWithoutContent(chapterRow.agent_checkpoint, 2);
        // Wydatek przeniesiony: 0,04 z próby 1 + trzy kroki próby 2.
        expect(summaryOf(chapterRow).totalSpentUsd).toBeCloseTo(0.07, 6);
        const chapterVersion = await versionOf(chapter.runId);
        const chapterContext = chapterVersion.lesson_context as { dynamicTopic: unknown };
        expect(chapterContext.dynamicTopic).toEqual(saved.dynamicTopic);
        expect(await draftObjectives(chapterVersion.id)).toEqual(saved.dynamicTopic!.objectives.map((objective) => objective.id));

        // Szkoła (etap zagadnień poza agentem).
        const school = await createSchoolLesson(services, {
          subjectTitlePl: "Geografia",
          topicTitlePl: "Polska",
          material: SCHOOL_MATERIAL,
          poolSize: 40,
          clientRequestId: randomUUID(),
        });
        await executeLessonGeneration(services, school.runId);
        const schoolRequeued = await fullRun(school.runId);
        expect(schoolRequeued.state).toBe("queued");
        const schoolSaved = parseLessonAgentProgress(schoolRequeued.agent_checkpoint, school.runId)!;
        expect(Object.fromEntries(Object.entries(schoolSaved.objectives).map(([id, entry]) => [slugOf(id), entry.status]))).toEqual({
          rzeki_polski: "complete",
          gory_polski: "failed",
        });
        expect(schoolSaved.budgetSpentUsd).toBeCloseTo(0.02, 6);

        await dueNow(school.runId);
        await executeLessonGeneration(services, school.runId);
        const schoolRow = await fullRun(school.runId);
        expect(schoolRow.state).toBe("succeeded");
        expect(fakes.llm.objectiveRequests).toHaveLength(1);
        expect(callsOf("school.")).toEqual(["rzeki_polski", "gory_polski", "gory_polski"]);
        expect(summaryOf(schoolRow).totalSpentUsd).toBeCloseTo(0.03, 6);
        expect(await draftObjectives((await versionOf(school.runId)).id)).toEqual(schoolSaved.dynamicTopic!.objectives.map((objective) => objective.id));
      });

      it("wyczerpane próby → zapis części, generationGaps z zagadnieniem incomplete/failed", async () => {
        // A: wynik generatora; B: błąd przejściowy w każdej próbie; C: model kończy bez zgłoszeń.
        const { services, agent } = await agentWorld(["english_grammar"], { objectives: { negative: [transient()], question: [] } });
        const { runId } = await createLesson(services, command({ objectiveIds: [OBJECTIVE, NEGATIVE, QUESTION] }));
        for (const attempt of [1, 2]) {
          await executeLessonGeneration(services, runId);
          expect((await fullRun(runId)).state, `próba ${attempt}`).toBe("queued");
          await dueNow(runId);
        }

        await executeLessonGeneration(services, runId);

        const row = await fullRun(runId);
        expect(row.state).toBe("succeeded");
        expect(row.attempts).toBe(3);
        expect(row.error_code).toBeNull();
        // Gotowe zagadnienie nie jest ponawiane; pozostałe startują od zera w każdej próbie.
        expect(agent.calls.filter((call) => call.objectiveId === OBJECTIVE)).toHaveLength(1);
        expect(agent.calls.filter((call) => call.objectiveId === NEGATIVE)).toHaveLength(3);
        const version = await versionOf(runId);
        expect(contextOf(version).generationGaps).toEqual([
          { objectiveId: NEGATIVE, reason: "failed" },
          { objectiveId: QUESTION, reason: "incomplete" },
        ]);
        expect(await draftObjectives(version.id)).toEqual([OBJECTIVE]);
        expectSummaryWithoutContent(row.agent_checkpoint, 3);
        expect(summaryOf(row).objectives[NEGATIVE]).toMatchObject({ status: "failed", accepted: 0 });
      });

      it("shutdown w ostatniej próbie (gate + abort sygnału) → następne przejęcie zapisuje z punktu kontrolnego bez wywołań modelu; gap dla nierozliczonego zagadnienia", async () => {
        const { services, agent } = await agentWorld(["english_grammar"], { objectives: { negative: [never()] } });
        const { runId } = await createLesson(services, command({ objectiveIds: [OBJECTIVE, NEGATIVE] }));
        // Ostatnia automatyczna próba.
        await pool.query("update learning_app.generation_runs set attempts = 2 where id = $1", [runId]);
        const shutdown = new AbortController();
        const running = executeLessonGeneration(services, runId, { signal: shutdown.signal });
        await untilSettled(runId, OBJECTIVE);
        shutdown.abort();
        await running;

        const stopped = await fullRun(runId);
        expect(stopped.state).toBe("queued");
        expect(stopped.attempts).toBe(3);
        expect(stopped.next_attempt_at).toBeNull();
        const saved = parseLessonAgentProgress(stopped.agent_checkpoint, runId)!;
        expect(saved.objectives[OBJECTIVE]!.exercises.length).toBeGreaterThan(0);
        expect(saved.objectives[NEGATIVE]).toBeUndefined();
        const calls = agent.calls.length;

        await executeLessonGeneration(services, runId);

        const row = await fullRun(runId);
        expect(row.state).toBe("succeeded");
        expect(row.attempts).toBe(4);
        expect(agent.calls).toHaveLength(calls);
        const version = await versionOf(runId);
        expect(await exerciseCount(version.id)).toBe(saved.objectives[OBJECTIVE]!.exercises.length);
        expect(contextOf(version).generationGaps).toEqual([{ objectiveId: NEGATIVE, reason: "incomplete" }]);
        expectSummaryWithoutContent(row.agent_checkpoint, 4);
      });

      it("budżet wyczerpany przy błędzie przejściowym innego zagadnienia → zapis części bez ponowienia", async () => {
        // Krok kosztuje 0,01 USD, budżet runu 0,025: próba 1 wydaje 0,02 (A gotowe, B przejściowy → ponowienie),
        // w próbie 2 przejściowy błąd B przekracza budżet — kolejna próba nic by nie wydała.
        const { services, agent } = await agentWorld(
          ["english_grammar"],
          { stepCostUsd: 0.01, objectives: { negative: [transient()] } },
          { policy: { runBudgetUsd: 0.025 } },
        );
        const { runId } = await createLesson(services, command({ objectiveIds: [OBJECTIVE, NEGATIVE] }));
        await executeLessonGeneration(services, runId);
        const first = await fullRun(runId);
        expect(first.state).toBe("queued");
        expect(parseLessonAgentProgress(first.agent_checkpoint, runId)!.budgetSpentUsd).toBeCloseTo(0.02, 6);
        await dueNow(runId);

        await executeLessonGeneration(services, runId);

        const row = await fullRun(runId);
        expect(row.state).toBe("succeeded");
        expect(row.attempts).toBe(2);
        expect(row.next_attempt_at).toBeNull();
        expect(agent.calls.map((call) => call.objectiveId)).toEqual([OBJECTIVE, NEGATIVE, NEGATIVE]);
        const version = await versionOf(runId);
        expect(await draftObjectives(version.id)).toEqual([OBJECTIVE]);
        expect(contextOf(version).generationGaps).toEqual([{ objectiveId: NEGATIVE, reason: "failed" }]);
        expect(summaryOf(row).totalSpentUsd).toBeCloseTo(0.03, 6);
      });

      it("termin runu → succeeded z częścią", async () => {
        // Termin kierownika = 6000 − 1000 ms rezerwy; B nie kończy się sam, A jest gotowe wcześniej.
        // A ma 5 s z zapisem do bazy (wcześniej 2 s — za mało przy obciążonym procesorze).
        const { services } = await agentWorld(
          ["english_grammar"],
          { objectives: { negative: [never()] } },
          { finalizationReserveMs: 1000, execution: { requestTimeoutMs: 6000, runTimeoutMs: 6000 } },
        );
        const { runId } = await createLesson(services, command({ objectiveIds: [OBJECTIVE, NEGATIVE] }));

        await executeLessonGeneration(services, runId);

        const row = await fullRun(runId);
        expect(row.state).toBe("succeeded");
        expect(row.error_code).toBeNull();
        const version = await versionOf(runId);
        expect(await draftObjectives(version.id)).toEqual([OBJECTIVE]);
        expect(contextOf(version).generationGaps).toEqual([{ objectiveId: NEGATIVE, reason: "incomplete" }]);
      }, 15_000);

      it("edycja rodzica w trakcie (gate) → superseded, szkic bez zmian, agent_checkpoint NULL", async () => {
        const inFlight = gate();
        const { services, agent } = await agentWorld(["english_grammar"], { objectives: { third_person_s: [inFlight.step] } });
        const { runId } = await createLesson(services, command());
        const before = await versionOf(runId);
        const running = executeLessonGeneration(services, runId);
        await inFlight.reached;
        await editLessonDraft(services, before.id, { expectedEditNumber: before.edit_number, examples: { [OBJECTIVE]: ["She reads."] } });
        const edited = await versionOf(runId);
        await running;

        const row = await fullRun(runId);
        expect(row.state).toBe("superseded");
        expect(row.agent_checkpoint).toBeNull();
        expect(agent.calls).toHaveLength(1);
        // Szkic tylko z edycją rodzica: bez ćwiczeń i zmian kontekstu z generowania.
        const after = await versionOf(runId);
        expect(after.edit_number).toBe(before.edit_number + 1);
        expect(after.lesson_context).toEqual(edited.lesson_context);
        expect(await exerciseCount(after.id)).toBe(0);
      });

      it("podbicie editNumber przez acceptVerdictAsVariant w trakcie → run superseded (nie running), agent_checkpoint NULL", async () => {
        const inFlight = gate();
        // Wywołanie 1: pula lekcji; wywołanie 2: dogenerowanie, w trakcie którego rodzic przyjmuje wariant.
        const { services } = await agentWorld(["english_grammar"], (fakes) => ({
          objectives: { third_person_s: { calls: [[llmStep(fakes.llm)], [inFlight.step]] } },
        }));
        const lesson = await createLesson(services, command());
        await executeLessonGeneration(services, lesson.runId);
        expect((await fullRun(lesson.runId)).state).toBe("succeeded");
        const draft = await versionOf(lesson.runId);
        const exercisesBefore = await exerciseCount(draft.id);
        const [revision] = await query<{ id: string }>(
          "select id from learning_app.item_revisions where deck_version_id = $1 order by position limit 1",
          [draft.id],
        );
        const add = await regenerateObjective(services, {
          deckId: lesson.deckId,
          objectiveId: OBJECTIVE,
          count: 2,
          expectedEditNumber: draft.edit_number,
          clientRequestId: randomUUID(),
        });
        const running = executeLessonGeneration(services, add.runId);
        await inFlight.reached;
        const verdictId = randomUUID();
        await pool.query(
          `insert into learning_app.lesson_verdicts (id, item_revision_id, normalized_answer, prompt_version, grader_model, verdict)
           values ($1, $2, 'he does play it', 'pv-test', 'fake-grader', 'correct')`,
          [verdictId, revision!.id],
        );
        expect((await acceptVerdictAsVariant(services, verdictId)).added).toBe(true);
        expect((await versionOf(add.runId)).edit_number).toBe(draft.edit_number + 1);
        await running;

        const row = await fullRun(add.runId);
        expect(row.state).toBe("superseded");
        expect(row.agent_checkpoint).toBeNull();
        expect(await exerciseCount(draft.id)).toBe(exercisesBefore);
      });

      it("Ponów w trakcie próby (druga karta: retryGeneration przy gate) → spóźniony zapis starej próby odrzucony, nowa próba wznawia", async () => {
        const inFlight = gate();
        // Długi odstęp sprawdzania bieżącości: starą próbę kończy wyłącznie straż zapisu punktu kontrolnego.
        const { services, agent } = await agentWorld(
          ["english_grammar"],
          (fakes) => ({ stepCostUsd: 0.01, objectives: { negative: { calls: [[inFlight.step], [llmStep(fakes.llm)]] } } }),
          { execution: { cancelPollMs: 60_000 } },
        );
        const { runId } = await createLesson(services, command({ objectiveIds: [OBJECTIVE, NEGATIVE] }));
        const before = await fullRun(runId);
        const running = executeLessonGeneration(services, runId);
        await inFlight.reached;
        await untilSettled(runId, OBJECTIVE);
        const saved = (await progressOf(runId))!;

        await retryGeneration(services, runId);
        inFlight.open();
        await running;

        const retried = await fullRun(runId);
        expect(retried.state).toBe("queued");
        expect(retried.attempts).toBe(0);
        expect(retried.expected_edit_number).toBe(before.expected_edit_number + 1);
        // Zakończone B starej próby nie trafiło do punktu kontrolnego; „Ponów” wyzerował budżet.
        expect(parseLessonAgentProgress(retried.agent_checkpoint, runId)).toEqual({ ...saved, budgetSpentUsd: 0 });

        await executeLessonGeneration(services, runId);

        const row = await fullRun(runId);
        expect(row.state).toBe("succeeded");
        expect(row.attempts).toBe(1);
        expect(agent.calls.map((call) => call.objectiveId)).toEqual([OBJECTIVE, NEGATIVE, NEGATIVE]);
        expect(await draftObjectives((await versionOf(runId)).id)).toEqual([OBJECTIVE, NEGATIVE]);
        expect(summaryOf(row).totalSpentUsd).toBeCloseTo(0.03, 6);
      });

      it("Ponów po częściowym runie → wznowienie bez zduplikowanych familyId", async () => {
        /**
         * Generator dogenerowania: jedno pytanie otwarte z rodziną o stałym slugu — model powtarza slug w każdej
         * próbie, więc rozdzielić rodziny musi zakres runu (`familyScope`) per próba. Fake proszony o jedno
         * ćwiczenie etapu samodzielnego; `offset` przesuwa jego indeks odpowiedzi za pulę (inaczej odpowiedź
         * powtarza odpowiedź puli i odpada jako ujawniona).
         */
        const oneFamily = (llm: LlmProvider, offset: number): LlmProvider =>
          ({
            generateLessonPool: async (input: Parameters<LlmProvider["generateLessonPool"]>[0], signal?: AbortSignal) => {
              const existingExercises = Array.from({ length: offset }, () => ({})) as unknown as typeof input.existingExercises;
              const stageCounts = { guided: 0, productive: 0, independent: 1 };
              const result = await llm.generateLessonPool({ ...input, existingExercises, stageCounts }, signal);
              const open = result.exercises
                .filter((exercise) => (exercise as { exerciseType?: unknown }).exerciseType === "lesson_open_answer")
                .slice(0, 1)
                .map((exercise) => ({ ...(exercise as Record<string, unknown>), familyId: "pytanie-1" }));
              return { ...result, exercises: open };
            },
          }) as unknown as LlmProvider;
        // Wywołanie 1: pula lekcji; 2: dogenerowanie — jedno pytanie, potem błąd przejściowy; 3: wznowienie po „Ponów”.
        const { services, agent } = await agentWorld(["school"], (fakes) => ({
          objectives: {
            rzeki_polski: { calls: [[llmStep(fakes.llm)], [llmStep(oneFamily(fakes.llm, 100)), transient()], [llmStep(oneFamily(fakes.llm, 200))]] },
          },
        }));
        const school = await createSchoolLesson(services, {
          subjectTitlePl: "Geografia",
          topicTitlePl: "Polska",
          material: SCHOOL_MATERIAL,
          poolSize: 40,
          clientRequestId: randomUUID(),
        });
        await executeLessonGeneration(services, school.runId);
        expect((await fullRun(school.runId)).state).toBe("succeeded");
        const draft = await versionOf(school.runId);
        const rivers = (draft.lesson_context as { objectiveIds: string[] }).objectiveIds.find((id) => slugOf(id) === "rzeki_polski")!;
        const add = await regenerateObjective(services, {
          deckId: school.deckId,
          objectiveId: rivers,
          count: 3,
          expectedEditNumber: draft.edit_number,
          clientRequestId: randomUUID(),
        });

        // Częściowy run: jedno nowe ćwiczenie w punkcie kontrolnym, ponowienie odroczone.
        await executeLessonGeneration(services, add.runId);
        const partial = await fullRun(add.runId);
        expect(partial.state).toBe("queued");
        const firstFamilies = parseLessonAgentProgress(partial.agent_checkpoint, add.runId)!.objectives[rivers]!.exercises.map((exercise) => exercise.familyId);
        expect(firstFamilies).toHaveLength(1);

        // „Ponów” odroczonego runu: nowy budżet prób bez podbicia numeru edycji.
        await retryGeneration(services, add.runId);
        expect((await fullRun(add.runId)).attempts).toBe(0);
        await executeLessonGeneration(services, add.runId);

        const row = await fullRun(add.runId);
        expect(row.state).toBe("succeeded");
        expect(agent.calls.filter((call) => call.objectiveId === rivers)).toHaveLength(3);
        const families = await query<{ family_id: string }>(
          `select payload->>'familyId' as family_id from learning_app.item_revisions
            where deck_version_id = $1 and payload->>'objectiveId' = $2 and payload->>'familyId' is not null`,
          [draft.id, rivers],
        );
        // Oba nowe pytania zapisane, każde we własnej rodzinie: wznowienie nie dokleja się do rodziny wcześniejszej próby.
        expect(families.map((family) => family.family_id)).toHaveLength(2);
        expect(new Set(families.map((family) => family.family_id)).size).toBe(2);
        expect(families.map((family) => family.family_id)).toContain(firstFamilies[0]);
      });

      it("porażka walidacji, potem „Ponów” i sukces → liczniki usunięć w kontekście raz", async () => {
        // Próba 1 nic nie przyjmuje (porażka walidacji), próba po „Ponów” — wynik generatora.
        const { services } = await agentWorld(["english_grammar"], (fakes) => ({
          objectives: { third_person_s: { calls: [[], [llmStep(fakes.llm)]] } },
        }));
        const { runId } = await createLesson(services, command());
        const before = contextOf(await versionOf(runId));
        // Wcześniejsza próba: 2 usunięcia bezpiecznika i 1 zagadnienie odrzucone przy budowie tematu.
        await setCheckpoint(runId, { ...emptyLessonAgentProgress(), removedAfterAcceptance: 2, droppedObjectiveCount: 1 });
        await executeLessonGeneration(services, runId);
        expect((await fullRun(runId)).error_code).toBe("validation");
        const failedContext = contextOf(await versionOf(runId));
        expect(failedContext.rejectedCount).toBe((before.rejectedCount ?? 0) + 2);
        expect(failedContext.droppedObjectiveCount).toBe((before.droppedObjectiveCount ?? 0) + 1);

        await retryGeneration(services, runId);
        await executeLessonGeneration(services, runId);

        expect((await fullRun(runId)).state).toBe("succeeded");
        const context = contextOf(await versionOf(runId));
        expect(context.rejectedCount).toBe((before.rejectedCount ?? 0) + 2);
        expect(context.droppedObjectiveCount).toBe((before.droppedObjectiveCount ?? 0) + 1);
      });

      it("awaria transakcji porażki walidacji → liczniki zostają w punkcie kontrolnym (kontekst wycofany)", async () => {
        const { services } = await agentWorld(["english_grammar"], { objectives: { third_person_s: [] } });
        const { runId } = await createLesson(services, command());
        const before = await versionOf(runId);
        await setCheckpoint(runId, { ...emptyLessonAgentProgress(), removedAfterAcceptance: 2, droppedObjectiveCount: 1 });
        // Zapis liczników do kontekstu szkicu rzuca błąd spoza straży — transakcja porażki wycofana.
        await pool.query(`create or replace function learning_app.test_fail_lesson_context() returns trigger language plpgsql as $$
          begin raise exception 'test: validation failure write failed'; end $$`);
        await pool.query(`create trigger test_fail_lesson_context before update of lesson_context on learning_app.deck_versions
          for each row execute function learning_app.test_fail_lesson_context()`);
        try {
          await executeLessonGeneration(services, runId);
        } finally {
          await pool.query("drop trigger if exists test_fail_lesson_context on learning_app.deck_versions");
          await pool.query("drop function if exists learning_app.test_fail_lesson_context()");
        }

        const row = await fullRun(runId);
        expect(row.state).toBe("queued");
        expect((await versionOf(runId)).lesson_context).toEqual(before.lesson_context);
        // Zapis best-effort po błędzie nie zeruje liczników, których kontekst nie dostał.
        const saved = parseLessonAgentProgress(row.agent_checkpoint, runId)!;
        expect(saved.removedAfterAcceptance).toBe(2);
        expect(saved.droppedObjectiveCount).toBe(1);
      });

      it("brak czasu na kierownika: termin tylko dla „nic nie przyjęto”, budżet i kody dostawcy z punktu kontrolnego zostają", async () => {
        // Termin runu równy rezerwie: kierownik nie startuje, wynik z samego punktu kontrolnego.
        const { services, agent } = await agentWorld(["english_grammar"], {}, {
          finalizationReserveMs: 1000,
          execution: { requestTimeoutMs: 1000, runTimeoutMs: 1000 },
        });
        const cases: { checkpoint: LessonAgentProgress; errorCode: string }[] = [
          { checkpoint: emptyLessonAgentProgress(), errorCode: "provider_timeout" },
          { checkpoint: { ...emptyLessonAgentProgress(), budgetSpentUsd: 1, totalSpentUsd: 1 }, errorCode: "validation" },
          {
            checkpoint: {
              ...emptyLessonAgentProgress(),
              objectives: { [OBJECTIVE]: { status: "failed", failureCode: "provider_configuration", exercises: [], examples: [] } },
            },
            errorCode: "provider_configuration",
          },
        ];
        for (const { checkpoint, errorCode } of cases) {
          const { runId } = await createLesson(services, command());
          await setCheckpoint(runId, checkpoint);
          await executeLessonGeneration(services, runId);
          const row = await fullRun(runId);
          expect(row.state, errorCode).toBe("failed");
          expect(row.error_code, errorCode).toBe(errorCode);
        }
        expect(agent.calls).toEqual([]);
      });

      it("koszty: zdarzenia UsageRecorder (fake z usage) w zakresie runu, totalSpentUsd w podsumowaniu", async () => {
        await pool.query("truncate learning_app.provider_usage_events");
        const recorder = createDrizzleUsageRecorder({ db: testDatabase().db, clock: new ManualClock(), prices: {} });
        const { services } = await agentWorld(["english_grammar"], { stepCostUsd: 0.01, usage: recorder });
        const { runId, deckId } = await createLesson(services, command({ objectiveIds: [OBJECTIVE, NEGATIVE] }));

        // Zakres kosztów jak w workerze (`runDueGenerationWork`).
        await runDueGenerationWork(services, { total: 1, deck: 0, lesson: 1, tts: 0, images: 0 });
        await recorder.flush();

        const row = await fullRun(runId);
        expect(row.state).toBe("succeeded");
        const events = await query<Record<string, unknown>>(
          `select feature, operation, provider, scope_kind, generation_run_id, deck_id, cost_usd
             from learning_app.provider_usage_events where operation like 'agent_%' order by occurred_at, id`,
        );
        expect(events).toHaveLength(2);
        for (const event of events) {
          expect(event).toMatchObject({
            feature: "lesson_generation",
            operation: "agent_objective",
            provider: "openrouter",
            scope_kind: "run",
            generation_run_id: runId,
            deck_id: deckId,
          });
        }
        const eventsUsd = events.reduce((sum, event) => sum + Number(event.cost_usd), 0);
        expect(eventsUsd).toBeCloseTo(0.02, 6);
        expect(summaryOf(row).totalSpentUsd).toBeCloseTo(eventsUsd, 6);
      });
    });

    describe("dogenerowanie +N", () => {
      interface DraftRow {
        id: string;
        position: number;
        payload: Record<string, unknown>;
      }

      async function draftRows(versionId: string): Promise<DraftRow[]> {
        return query<DraftRow>(
          "select id, position, payload from learning_app.item_revisions where deck_version_id = $1 order by position",
          [versionId],
        );
      }

      /**
       * Generator dogenerowania (fake LLM): indeks odpowiedzi przesunięty za pulę (`offset`; inaczej odpowiedzi
       * powtarzają pulę i odpadają jako duplikaty), liczby etapów i dodatku słuchowego zamiast liczb promptu
       * (`stages`, `listen`), najwyżej `take` pierwszych ćwiczeń, `extra` przed wynikiem generatora.
       */
      function addGenerator(
        llm: LlmProvider,
        options: {
          offset: number;
          stages?: { guided: number; productive: number; independent: number };
          listen?: number;
          take?: number;
          extra?: readonly LessonExerciseDraft[];
        },
      ): LlmProvider {
        return {
          generateLessonPool: async (input: Parameters<LlmProvider["generateLessonPool"]>[0], signal?: AbortSignal) => {
            const existingExercises = Array.from({ length: options.offset }, () => ({})) as unknown as typeof input.existingExercises;
            const result = await llm.generateLessonPool(
              {
                ...input,
                existingExercises,
                ...(options.stages === undefined ? {} : { stageCounts: options.stages }),
                ...(options.listen === undefined ? {} : { listenChoicePerObjective: options.listen }),
              },
              signal,
            );
            const generated = options.take === undefined ? result.exercises : result.exercises.slice(0, options.take);
            return { ...result, exercises: [...(options.extra ?? []), ...generated] };
          },
        } as unknown as LlmProvider;
      }

      /** Lekcja gramatyki z pulą z pierwszego wywołania agenta i run „Dogeneruj +N” zagadnienia w kolejce. */
      async function draftWithAdd(services: Services, count: number, prepare?: (versionId: string) => Promise<void>) {
        const lesson = await createLesson(services, command());
        await executeLessonGeneration(services, lesson.runId);
        expect((await fullRun(lesson.runId)).state).toBe("succeeded");
        const draft = await versionOf(lesson.runId);
        await prepare?.(draft.id);
        const add = await regenerateObjective(services, {
          deckId: lesson.deckId,
          objectiveId: OBJECTIVE,
          count,
          expectedEditNumber: draft.edit_number,
          clientRequestId: randomUUID(),
        });
        return { draft, add, before: await draftRows(draft.id), poolRunId: lesson.runId };
      }

      /** Luka gramatyki zagadnienia; rozwiązane zdanie = `stem` z `answer` w miejscu luki. */
      const gapExercise = (stem: string, answer: string): LessonExerciseDraft => ({
        exerciseType: "lesson_gap",
        objectiveId: OBJECTIVE,
        instructionPl: "Uzupełnij.",
        stem,
        answer,
        acceptedAnswers: [],
        focus: [answer],
      });

      const storyOf = (sentences: string[]) => ({
        sentences,
        questions: [
          {
            id: "q1",
            question: "Kto jest w historyjce?",
            options: [
              { id: "a", text: "Tom" },
              { id: "b", text: "Ola" },
              { id: "c", text: "Ewa" },
            ],
            correctOption: "a",
          },
        ],
      });

      /** Historyjka szkicu na starcie runu (zdania spoza puli fake: materiał to „He plays football…”). */
      const STORY_START = storyOf(["Tom has a small dog.", "The dog is brown and fast.", "Every morning they run in the park.", "Tom loves his dog."]);
      /** Historyjka zapisana w trakcie runu (run historyjki nie podbija numeru edycji). */
      const STORY_LATE = storyOf(["Sam rides his red bike.", "The bike is fast and shiny.", "They go to the park.", "Sam is very happy."]);

      it("dogeneruj +2 → najwyżej 2+stageGap+listenLeft nowych, szkic nietknięty, generationGaps bez wpisu zagadnienia", async () => {
        // Wywołanie 2: generator zgłasza znacznie więcej ćwiczeń, niż wolno przyjąć.
        const { services, agent } = await agentWorld(["english_grammar"], (fakes) => ({
          objectives: {
            third_person_s: {
              calls: [
                [llmStep(fakes.llm)],
                [llmStep(addGenerator(fakes.llm, { offset: 100, stages: { guided: 4, productive: 4, independent: 4 }, listen: 3 }))],
              ],
            },
          },
        }));
        const { draft, add, before, poolRunId } = await draftWithAdd(services, 2, (versionId) =>
          // Luki z wcześniejszego generowania: wpis tego zagadnienia znika, wpis innego zostaje.
          setContextField(versionId, "generationGaps", [
            { objectiveId: OBJECTIVE, reason: "incomplete" },
            { objectiveId: NEGATIVE, reason: "failed" },
          ]),
        );
        const contextBefore = contextOf(await versionOf(add.runId));

        await executeLessonGeneration(services, add.runId);

        const row = await fullRun(add.runId);
        expect(row.state).toBe("succeeded");
        const call = agent.calls.at(-1)!;
        expect(call.objectiveId).toBe(OBJECTIVE);
        const { targets } = call.input;
        // Oczekiwane liczby ze szkicu, niezależnie od celów promptu: pula pierwszego runu jest kompletem
        // (brak braków etapów → stageGap = 0), a reszta dodatku słuchowego = limit zagadnienia − ćwiczenia
        // słuchowe zagadnienia w szkicu.
        expect(summaryOf(await fullRun(poolRunId)).objectives[OBJECTIVE]!.status).toBe("complete");
        const stageGap = 0;
        const listenInDraft = before.filter((item) => item.payload.objectiveId === OBJECTIVE && item.payload.exerciseType === "lesson_listen_choice").length;
        const catalogObjective = englishGrammarSubject.topics
          .flatMap((topic) => topic.objectives)
          .find((objective) => objective.id === OBJECTIVE)!;
        const listenLeft = Math.max(0, listenChoiceAllowance(englishGrammarSubject, catalogObjective, []) - listenInDraft);
        // Prompt: etapy = 2 + braki etapów; limit nowych = 2 + braki etapów + reszta dodatku słuchowego.
        const stagesTarget = targets.guided + targets.productive + targets.independent;
        expect(stagesTarget).toBe(2 + stageGap);
        expect(targets.listenAllowance).toBe(listenLeft);
        expect(targets.maxExercises).toBe(2 + stageGap + listenLeft);
        const after = await draftRows(draft.id);
        // Szkic nietknięty: wcześniejsze ćwiczenia bez zmian, nowe dopisane za nimi.
        expect(after.slice(0, before.length)).toEqual(before);
        const added = after.length - before.length;
        expect(added).toBeGreaterThanOrEqual(2);
        expect(added).toBeLessThanOrEqual(targets.maxExercises);
        // Kontrola końcowa (limity puli) nie usunęła żadnego z przyjętych nowych ćwiczeń.
        expect(summaryOf(row).objectives[OBJECTIVE]).toMatchObject({ accepted: added });
        const version = await versionOf(add.runId);
        expect(version.edit_number).toBe(draft.edit_number + 1);
        expect(contextOf(version).rejectedCount).toBe(contextBefore.rejectedCount ?? 0);
        expect(contextOf(version).generationGaps).toEqual([{ objectiveId: NEGATIVE, reason: "failed" }]);
        expectSummaryWithoutContent(row.agent_checkpoint, 1);
      });

      it("dogeneruj ze zdaniem historyjki → agent dostaje je jako źródło ujawnień; kolizja w zapisie odrzucona", async () => {
        const inFlight = gate();
        // Wywołanie 2: luka z rozwiązaniem ze zdania historyjki zapisanej w trakcie runu (agent jej nie zna)
        // i jedno zwykłe ćwiczenie — agent przyjmuje oba, zapis odrzuca kolizję.
        const lateCollision = gapExercise("Sam ___ his red bike.", "rides");
        const { services, agent } = await agentWorld(["english_grammar"], (fakes) => ({
          objectives: {
            third_person_s: {
              calls: [
                [llmStep(fakes.llm)],
                [
                  inFlight.step,
                  llmStep(addGenerator(fakes.llm, { offset: 100, stages: { guided: 1, productive: 0, independent: 0 }, take: 1, extra: [lateCollision] })),
                ],
              ],
            },
          },
        }));
        const { draft, add, before } = await draftWithAdd(services, 2, (versionId) => setContextField(versionId, "story", STORY_START));
        const contextBefore = contextOf(await versionOf(add.runId));

        const running = executeLessonGeneration(services, add.runId);
        await inFlight.reached;
        // Zdania historyjki ze startu są źródłami ujawnień podagenta: zdania kart i zdania do unikania w prompcie.
        const input = agent.calls.at(-1)!.input;
        expect(input.cardSentences).toEqual(expect.arrayContaining(STORY_START.sentences));
        expect(input.pool.avoidSentences).toEqual(expect.arrayContaining(STORY_START.sentences));
        // Run historyjki zapisuje nową historyjkę w trakcie (bez podbicia numeru edycji).
        await setContextField(draft.id, "story", STORY_LATE);
        inFlight.open();
        await running;

        const row = await fullRun(add.runId);
        expect(row.state).toBe("succeeded");
        expect(summaryOf(row).objectives[OBJECTIVE]).toMatchObject({ accepted: 2 });
        const after = await draftRows(draft.id);
        expect(after).toHaveLength(before.length + 1);
        expect(after.map((item) => item.payload.stem)).not.toContain(lateCollision.stem);
        const version = await versionOf(add.runId);
        expect(contextOf(version).rejectedCount).toBe((contextBefore.rejectedCount ?? 0) + 1);
        // „Dodano k z N” liczy ćwiczenia zapisane, nie przyjęte przez agenta.
        expect(contextOf(version).generationGaps).toEqual([{ objectiveId: OBJECTIVE, reason: "add_short", added: 1, requested: 2 }]);
        expect((version.lesson_context as { story?: unknown }).story).toEqual(STORY_LATE);
      });

      it("pełna pula: kolizja z historyjką w zapisie, zapisana pula nadal pełna → bez luki", async () => {
        // Pula z fake LLM (komplet) i jedno dodatkowe ćwiczenie, którego rozwiązanie powtarza zdanie historyjki
        // szkicu — agent w trybie puli historyjki nie zna, przyjmuje je; zapis je odrzuca.
        const collision = gapExercise("Sam ___ his red bike.", "rides");
        const { services } = await agentWorld(["english_grammar"], (fakes) => ({
          objectives: { third_person_s: { calls: [[llmStep(addGenerator(fakes.llm, { offset: 0, extra: [collision] }))]] } },
        }));
        const { runId } = await createLesson(services, command());
        const before = await versionOf(runId);
        await setContextField(before.id, "story", STORY_LATE);

        await executeLessonGeneration(services, runId);

        const row = await fullRun(runId);
        expect(row.state).toBe("succeeded");
        // Agent uznał zagadnienie za komplet…
        expect(summaryOf(row).objectives[OBJECTIVE]!.status).toBe("complete");
        const version = await versionOf(runId);
        expect((await draftRows(version.id)).map((item) => item.payload.stem)).not.toContain(collision.stem);
        expect(contextOf(version).rejectedCount).toBe((contextOf(before).rejectedCount ?? 0) + 1);
        // …zapis odrzucił nadmiarowe ćwiczenie, a status liczony od nowa na zapisanej lekcji to nadal komplet.
        expect(contextOf(version).generationGaps).toBeUndefined();
      });

      it("dogeneruj z błędem przejściowym → requeue → łącznie ≤ limitu, bez duplikatów", async () => {
        // Wywołanie 2: jedno ćwiczenie, potem błąd przejściowy; wywołanie 3 (ponowienie) zaczyna od tego samego
        // ćwiczenia (ten sam indeks odpowiedzi) i zgłasza dużo więcej.
        const { services, agent } = await agentWorld(["english_grammar"], (fakes) => ({
          objectives: {
            third_person_s: {
              calls: [
                [llmStep(fakes.llm)],
                [llmStep(addGenerator(fakes.llm, { offset: 100, stages: { guided: 1, productive: 0, independent: 0 }, take: 1 })), transient()],
                [llmStep(addGenerator(fakes.llm, { offset: 100, stages: { guided: 4, productive: 4, independent: 4 }, listen: 3 }))],
              ],
            },
          },
        }));
        const { draft, add, before } = await draftWithAdd(services, 3);

        await executeLessonGeneration(services, add.runId);
        const requeued = await fullRun(add.runId);
        expect(requeued.state).toBe("queued");
        expect(requeued.error_code).toBe("provider");
        const firstAttempt = parseLessonAgentProgress(requeued.agent_checkpoint, add.runId)!.objectives[OBJECTIVE]!;
        expect(firstAttempt.status).toBe("failed");
        expect(firstAttempt.exercises).toHaveLength(1);
        // Szkic bez zmian do zapisu końcowego.
        expect(await draftRows(draft.id)).toEqual(before);
        await dueNow(add.runId);

        await executeLessonGeneration(services, add.runId);

        const row = await fullRun(add.runId);
        expect(row.state).toBe("succeeded");
        expect(row.attempts).toBe(2);
        const [, firstCall, secondCall] = agent.calls;
        // Ponowienie prosi o resztę (+2), a limit liczy z ćwiczeniem z punktu kontrolnego jako stałym.
        expect(secondCall!.input.targets.maxExercises).toBeLessThanOrEqual(firstCall!.input.targets.maxExercises - 1);
        const after = await draftRows(draft.id);
        expect(after.slice(0, before.length)).toEqual(before);
        const added = after.slice(before.length);
        expect(added.length).toBeGreaterThanOrEqual(3);
        expect(added.length).toBeLessThanOrEqual(firstCall!.input.targets.maxExercises);
        // Ćwiczenie pierwszej próby zapisane raz; jego powtórka w ponowieniu odrzucona.
        expect(added.filter((item) => item.payload.stem === firstAttempt.exercises[0]!.stem)).toHaveLength(1);
        const answers = after.map((item) => String(item.payload.answer).toLowerCase());
        expect(new Set(answers).size).toBe(answers.length);
      });

      it("dogeneruj bez nowych → failed, editNumber bez zmian", async () => {
        const { services, agent } = await agentWorld(["english_grammar"], (fakes) => ({
          objectives: { third_person_s: { calls: [[llmStep(fakes.llm)], []] } },
        }));
        const { draft, add, before } = await draftWithAdd(services, 2);

        await executeLessonGeneration(services, add.runId);

        const row = await fullRun(add.runId);
        expect(row.state).toBe("failed");
        expect(row.error_code).toBe("validation");
        expect(row.next_attempt_at).toBeNull();
        expect(agent.calls).toHaveLength(2);
        const version = await versionOf(add.runId);
        expect(version.edit_number).toBe(draft.edit_number);
        expect(await draftRows(draft.id)).toEqual(before);
        expect(contextOf(version).generationGaps).toBeUndefined();
      });

      it("dogeneruj z niedoborem → add_short dodano k z N", async () => {
        // Wywołanie 2: model kończy po jednym ćwiczeniu.
        const { services } = await agentWorld(["english_grammar"], (fakes) => ({
          objectives: {
            third_person_s: {
              calls: [[llmStep(fakes.llm)], [llmStep(addGenerator(fakes.llm, { offset: 100, stages: { guided: 1, productive: 0, independent: 0 }, take: 1 }))]],
            },
          },
        }));
        const { draft, add, before } = await draftWithAdd(services, 3);

        await executeLessonGeneration(services, add.runId);

        const row = await fullRun(add.runId);
        expect(row.state).toBe("succeeded");
        expect(await draftRows(draft.id)).toHaveLength(before.length + 1);
        const version = await versionOf(add.runId);
        expect(version.edit_number).toBe(draft.edit_number + 1);
        expect(contextOf(version).generationGaps).toEqual([{ objectiveId: OBJECTIVE, reason: "add_short", added: 1, requested: 3 }]);
      });

      it("wszystkie nowe odpadły na kolizji z historyjką → failed validation; „Ponów” → sukces, liczniki usunięć w kontekście raz", async () => {
        const inFlight = gate();
        const lateCollision = gapExercise("Sam ___ his red bike.", "rides");
        // Wywołanie 2: jedyne zgłoszone ćwiczenie koliduje z historyjką zapisaną w trakcie; wywołanie 3 po „Ponów”.
        const { services } = await agentWorld(["english_grammar"], (fakes) => ({
          objectives: {
            third_person_s: {
              calls: [
                [llmStep(fakes.llm)],
                [inFlight.step, { submit: { exercises: [lateCollision] } }],
                [llmStep(addGenerator(fakes.llm, { offset: 200 }))],
              ],
            },
          },
        }));
        const { draft, add, before } = await draftWithAdd(services, 2);
        const contextBefore = contextOf(await versionOf(add.runId));
        // Wcześniejsza próba: 2 usunięcia bezpiecznika kierownika.
        await setCheckpoint(add.runId, { ...emptyLessonAgentProgress(), removedAfterAcceptance: 2 });

        const running = executeLessonGeneration(services, add.runId);
        await inFlight.reached;
        await setContextField(draft.id, "story", STORY_LATE);
        inFlight.open();
        await running;

        const failed = await fullRun(add.runId);
        expect(failed.state).toBe("failed");
        expect(failed.error_code).toBe("validation");
        expect(await draftRows(draft.id)).toEqual(before);
        // 2 (bezpiecznik) + 1 (kolizja w zapisie).
        expect(contextOf(await versionOf(add.runId)).rejectedCount).toBe((contextBefore.rejectedCount ?? 0) + 3);
        // Punkt kontrolny bez policzonych już usunięć i bez odrzuconych ćwiczeń (inaczej „Ponów” liczyłby je znowu).
        const saved = parseLessonAgentProgress(failed.agent_checkpoint, add.runId)!;
        expect(saved.removedAfterAcceptance).toBe(0);
        expect(saved.objectives[OBJECTIVE]!.exercises).toEqual([]);

        await retryGeneration(services, add.runId);
        await executeLessonGeneration(services, add.runId);

        expect((await fullRun(add.runId)).state).toBe("succeeded");
        const after = await draftRows(draft.id);
        expect(after.length).toBeGreaterThanOrEqual(before.length + 2);
        expect(after.map((item) => item.payload.stem)).not.toContain(lateCollision.stem);
        expect(contextOf(await versionOf(add.runId)).rejectedCount).toBe((contextBefore.rejectedCount ?? 0) + 3);
      });
    });
  });
});
