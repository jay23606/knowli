import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimQueuedRun,
  createLesson,
  createLessonDraftFromPublished,
  createSchoolLesson,
  createServices,
  createSubjectRegistry,
  editLessonDraft,
  englishGrammarSubject,
  executeLessonGeneration,
  publishLessonDraft,
  readGeneration,
  readLessonDeck,
  regenerateLessonStory,
  regenerateObjective,
  retryGeneration,
  schoolSubject,
  type Services,
} from "@learning/server";
import type { LessonCommand, LessonExerciseInput } from "@learning/contracts";
import { ManualClock, testDatabase } from "./helpers";
import { fakeGeneration, type FakeGeneration } from "./fakes";
import type { FakeObjectiveScript } from "../../packages/server/src/providers/fake-lesson-agent";
import { fakeObjectiveExercises } from "../../packages/server/src/providers/fake-lesson-pool";
import type { LessonObjectiveAgentInput } from "../../packages/server/src/ports/ai";

import { GenerationProviderError } from "../../packages/server/src/ports/generation-error";
import { solvedSentencesOf } from "../../packages/server/src/domain/lessons/story";
import { toExerciseDraft } from "../../packages/server/src/modules/materials/lessons/lesson-drafts";
import { latestLessonStoryRun } from "../../packages/server/src/modules/materials/lessons/lesson-story-generation";

const { pool, db } = testDatabase();
const OBJECTIVE = "english_grammar.present_simple.third_person_s";
/** Slug zagadnienia — klucz scenariusza fake'a agenta. */
const OBJECTIVE_SLUG = "third_person_s";

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

function lessonServices(fakes: FakeGeneration, clock = new ManualClock()): Services {
  return createServices({
    db,
    clock,
    media: fakes.settings,
    generation: fakes.deps,
    subjects: createSubjectRegistry([englishGrammarSubject, schoolSubject]),
  });
}

function command(overrides: Partial<LessonCommand> = {}): LessonCommand {
  return {
    subjectId: "english_grammar",
    topicId: "present_simple",
    objectiveIds: [OBJECTIVE],
    material: "He plays football. She watches TV. They study English every day.",
    poolSize: 20,
    clientRequestId: randomUUID(),
    ...overrides,
  };
}

interface StoryRunRow {
  id: string;
  kind: string;
  state: string;
  dedupe_key: string;
  attempts: number;
  error_code: string | null;
  expected_edit_number: number;
  next_attempt_at: Date | null;
  input: Record<string, unknown>;
}

async function storyRuns(versionId: string): Promise<StoryRunRow[]> {
  return query<StoryRunRow>(
    `select id, kind, state, dedupe_key, attempts, error_code, expected_edit_number, next_attempt_at, input
       from learning_app.generation_runs
      where deck_version_id = $1 and input->>'purpose' = 'story'
      order by created_at`,
    [versionId],
  );
}

async function versionRow(versionId: string): Promise<{ edit_number: number; state: string; lesson_context: Record<string, unknown> }> {
  const [row] = await query<{ edit_number: number; state: string; lesson_context: Record<string, unknown> }>(
    "select edit_number, state, lesson_context from learning_app.deck_versions where id = $1",
    [versionId],
  );
  return row!;
}

/** Poprawna historyjka rodzica (zdania spoza puli fake: materiał to „He plays football…”). */
const PARENT_STORY = {
  sentences: ["Tom has a small dog.", "The dog is brown and fast.", "Every morning they run in the park.", "Tom loves his dog."],
  questions: [
    {
      id: "q1",
      question: "Jaki jest pies Toma?",
      options: [
        { id: "a", text: "brązowy" },
        { id: "b", text: "biały" },
        { id: "c", text: "czarny" },
      ],
      correctOption: "a",
    },
  ],
};

/** Krok fake'a agenta: zgłoszenie generatora fake'a z dodatkowymi ćwiczeniami (np. kolizją z historyjką). */
function generatedWith(extra: LessonExerciseInput[]): { build: (input: LessonObjectiveAgentInput) => { exercises: unknown[]; examples?: unknown } } {
  return {
    build: (input) => {
      const generated = fakeObjectiveExercises(input, 9_000);
      // Dodatkowe na początku: agent przyjmuje je przed limitem zagadnienia, a kolizję z historyjką odrzuca zapis.
      return { exercises: [...extra, ...generated.exercises], ...(generated.examples === undefined ? {} : { examples: generated.examples }) };
    },
  };
}

/** DTO ćwiczenia → wejście patcha (schemat wejścia jest `strict`). */
function stripToInput(ex: Record<string, unknown>): LessonExerciseInput {
  // Nagrania pytania, zdania i wyjaśnienia (`promptAudio`, `sentenceAudio`, `explanationAudio`) są tylko do odczytu i nie wracają w patchu.
  const { revisionId: _r, promptAudio: _a, sentenceAudio: _s, explanationAudio: _e, ...rest } = ex as { revisionId?: string; promptAudio?: unknown; sentenceAudio?: unknown; explanationAudio?: unknown } & Record<string, unknown>;
  return rest as LessonExerciseInput;
}

/** Luka „She ___ football.” — rozwiązane zdanie „She plays football.”. */
const SHE_PLAYS_GAP: LessonExerciseInput = {
  exerciseType: "lesson_gap",
  objectiveId: OBJECTIVE,
  instructionPl: "Uzupełnij.",
  stem: "She ___ football.",
  answer: "plays",
  acceptedAnswers: [],
  focus: ["plays"],
};

/**
 * Patch jak z edytora rodzica przy zapisie samych ćwiczeń: tytuł, wszystkie
 * ćwiczenia (pierwsze zmienione) i przykłady — bez pola `story`.
 */
function editorExercisePatch(
  draft: { editNumber: number; title: string; exercises: unknown[]; examples: Record<string, string[]> },
  extra: LessonExerciseInput[] = [],
) {
  const [first, ...rest] = draft.exercises.map((ex) => stripToInput(ex as Record<string, unknown>));
  return {
    expectedEditNumber: draft.editNumber,
    title: draft.title,
    exercises: [{ ...first!, instructionPl: "Poprawione polecenie rodzica." }, ...rest, ...extra],
    examples: draft.examples,
  };
}

const SCHOOL_MATERIAL = [
  "Zagadnienie 1: Fotosynteza",
  "Wyjaśnienie: Fotosynteza to proces, w którym roślina z wody i dwutlenku węgla, przy udziale światła, wytwarza cukry. Cukry są pokarmem rośliny.",
  "Zagadnienie 2: Chrzest Polski",
  "Wyjaśnienie: Mieszko I przyjął chrzest w 966 roku. Chrzest włączył państwo do chrześcijańskiej Europy i wzmocnił władzę księcia.",
].join("\n");

describe("run historyjki lekcji (integracja)", () => {
  const disposers: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    await pool.query(
      `truncate learning_app.generation_runs, learning_app.revision_assets, learning_app.media_assets,
              learning_app.item_revision_skills, learning_app.item_revisions, learning_app.skill_versions,
              learning_app.learning_items, learning_app.deck_versions, learning_app.decks cascade`,
    );
  });

  afterEach(async () => {
    for (const dispose of disposers.splice(0)) await dispose();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function generatedGrammarLesson(clock = new ManualClock()) {
    // Scenariusze fake'a agenta czytane przy każdym wywołaniu (test może dopisać scenariusz dogenerowania).
    const scripts: Record<string, FakeObjectiveScript> = {};
    const fakes = await fakeGeneration({ agent: { generate: {}, objectives: scripts } });
    disposers.push(fakes.dispose);
    const services = lessonServices(fakes, clock);
    const { runId, deckId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);
    const versionId = (await readGeneration(services, runId)).deckVersionId!;
    const [storyRun] = await storyRuns(versionId);
    return { fakes, scripts, services, clock, lessonRunId: runId, deckId, versionId, storyRunId: storyRun?.id };
  }

  async function generatedSchoolLesson() {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = lessonServices(fakes);
    const { runId, deckId } = await createSchoolLesson(services, {
      subjectTitlePl: "Przyroda i historia",
      topicTitlePl: "Materiał pilotażowy",
      material: SCHOOL_MATERIAL,
      poolSize: 40,
      clientRequestId: randomUUID(),
    });
    await executeLessonGeneration(services, runId);
    expect((await readGeneration(services, runId)).state).toBe("succeeded");
    const versionId = (await readGeneration(services, runId)).deckVersionId!;
    return { services, deckId, versionId };
  }

  it("full lesson run queues a story run for grammar", async () => {
    const { services, lessonRunId, deckId, versionId } = await generatedGrammarLesson();

    const runs = await storyRuns(versionId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      kind: "lesson",
      state: "queued",
      dedupe_key: `lesson-story:${lessonRunId}`,
      expected_edit_number: 2,
    });
    expect(runs[0]!.input).toMatchObject({ purpose: "story", deckId, deckVersionId: versionId, subjectId: "english_grammar" });

    // Panel: `generation` pokazuje run lekcji, nie run historyjki.
    expect((await readLessonDeck(services, deckId)).generation?.id).toBe(lessonRunId);
    expect((await latestLessonStoryRun(db, versionId))?.id).toBe(runs[0]!.id);
  });

  it("no story run for subject without lessonStory", async () => {
    const { versionId } = await generatedSchoolLesson();
    expect(await storyRuns(versionId)).toEqual([]);
  });

  it("regenerate objective run does not queue a story run", async () => {
    const { services, deckId, versionId, storyRunId } = await generatedGrammarLesson();
    await executeLessonGeneration(services, storyRunId!);

    const regen = await regenerateObjective(services, {
      deckId, objectiveId: OBJECTIVE, count: 4, expectedEditNumber: 2, clientRequestId: randomUUID(),
    });
    await executeLessonGeneration(services, regen.runId);
    expect((await readGeneration(services, regen.runId)).state).toBe("succeeded");

    const runs = await storyRuns(versionId);
    expect(runs.map((run) => run.id)).toEqual([storyRunId]);
  });

  it("story run writes story without bumping editNumber", async () => {
    const { fakes, services, versionId, storyRunId } = await generatedGrammarLesson();

    await executeLessonGeneration(services, storyRunId!);

    const run = await readGeneration(services, storyRunId!);
    expect(run.state).toBe("succeeded");
    const version = await versionRow(versionId);
    expect(version.edit_number).toBe(2);
    expect(version.state).toBe("review");
    const story = version.lesson_context.story as {
      sentences: string[];
      questions: { id: string; question: string; options: { id: string; text: string }[]; correctOption: string }[];
    };
    expect(story.sentences).toHaveLength(4);
    expect(story.questions).toEqual([
      {
        id: "q1",
        question: "Jaki rower ma Sam?",
        options: [
          { id: "a", text: "czerwony" },
          { id: "b", text: "niebieski" },
          { id: "c", text: "zielony" },
        ],
        correctOption: "a",
      },
    ]);
    // Wejście modelu: temat i cele lekcji, rozwiązania puli do pominięcia.
    const request = fakes.llm.storyRequests[0]!;
    expect(request.objectives.map((objective) => objective.id)).toEqual([OBJECTIVE]);
    expect(request.answerLocale).toBe("en-GB");
    expect(request.storyRules.trim()).not.toBe("");
    expect(request.avoidSentences.length).toBeGreaterThan(0);
    expect(request.avoidSentences.length).toBeLessThanOrEqual(120);
  });

  it("story run survives exercise edit", async () => {
    const { services, deckId, versionId, storyRunId } = await generatedGrammarLesson();
    const draft = (await readLessonDeck(services, deckId)).draft!;

    const edited = await editLessonDraft(services, versionId, editorExercisePatch(draft));
    expect(edited.editNumber).toBe(3);
    expect(edited.exercises[0]!.instructionPl).toBe("Poprawione polecenie rodzica.");
    expect((await readGeneration(services, storyRunId!)).state).toBe("queued");

    await executeLessonGeneration(services, storyRunId!);

    expect((await readGeneration(services, storyRunId!)).state).toBe("succeeded");
    const version = await versionRow(versionId);
    expect(version.edit_number).toBe(3);
    expect((version.lesson_context.story as { sentences: string[] }).sentences).toHaveLength(4);
  });

  it("story patch supersedes active story run", async () => {
    const { services, versionId, storyRunId } = await generatedGrammarLesson();
    expect((await readGeneration(services, storyRunId!)).state).toBe("queued");

    await editLessonDraft(services, versionId, { expectedEditNumber: 2, story: PARENT_STORY });

    expect((await readGeneration(services, storyRunId!)).state).toBe("superseded");
    // Spóźniony worker nie nadpisze wyboru rodzica.
    await executeLessonGeneration(services, storyRunId!);
    expect((await versionRow(versionId)).lesson_context.story).toEqual(PARENT_STORY);
  });

  it("story run whose version gets published during the model call ends superseded", async () => {
    const { fakes, services, deckId, versionId, storyRunId } = await generatedGrammarLesson();
    const original = fakes.llm.generateLessonStory.bind(fakes.llm);
    fakes.llm.generateLessonStory = async (input) => {
      const draft = (await readLessonDeck(services, deckId)).draft!;
      await publishLessonDraft(services, versionId, draft.editNumber);
      return original(input);
    };

    await executeLessonGeneration(services, storyRunId!);

    expect((await readGeneration(services, storyRunId!)).state).toBe("superseded");
    expect((await versionRow(versionId)).lesson_context.story).toBeUndefined();
  });

  it("exercise edit during the model call that solves a story sentence fails the run and keeps the previous story", async () => {
    const { fakes, services, deckId, versionId, storyRunId } = await generatedGrammarLesson();
    await executeLessonGeneration(services, storyRunId!);
    const previous = (await versionRow(versionId)).lesson_context.story;
    expect(previous).toBeDefined();
    const payloads = await query<{ payload: unknown }>("select payload from learning_app.item_revisions where deck_version_id = $1", [versionId]);
    // Przed edycją historyjka z „She plays football.” byłaby poprawna.
    expect(solvedSentencesOf(payloads.map((row) => toExerciseDraft(row.payload)))).not.toContain("She plays football.");

    const { runId } = await regenerateLessonStory(services, { deckVersionId: versionId, expectedEditNumber: 2, clientRequestId: randomUUID() });
    fakes.llm.generateLessonStory = async () => {
      // Rodzic zapisuje ćwiczenia, gdy model jeszcze pisze historyjkę.
      const draft = (await readLessonDeck(services, deckId)).draft!;
      await editLessonDraft(services, versionId, editorExercisePatch(draft, [SHE_PLAYS_GAP]));
      return {
        story: {
          sentences: ["She plays football.", "Tom rides a green bike.", "The park is big.", "They are happy."],
          questions: [{ question: "Co robi Tom?", options: ["jeździ na rowerze", "pływa", "śpi"], correctOptionIndex: 0 }],
        },
      };
    };

    await executeLessonGeneration(services, runId);

    const run = await readGeneration(services, runId);
    expect(run.state).toBe("failed");
    expect(run.errorCode).toBe("story_invalid");
    const version = await versionRow(versionId);
    expect(version.edit_number).toBe(3);
    expect(version.lesson_context.story).toEqual(previous);
  });

  it("story run becomes superseded when version is published", async () => {
    const { fakes, services, deckId, versionId, storyRunId } = await generatedGrammarLesson();
    const draft = (await readLessonDeck(services, deckId)).draft!;
    await publishLessonDraft(services, versionId, draft.editNumber);
    // Publikacja unieważnia run od razu, zanim worker go przejmie (bez zużycia kolejki).
    expect((await readGeneration(services, storyRunId!)).state).toBe("superseded");

    await executeLessonGeneration(services, storyRunId!);

    expect((await readGeneration(services, storyRunId!)).state).toBe("superseded");
    expect(fakes.llm.storyRequests).toHaveLength(0);
    expect((await versionRow(versionId)).lesson_context.story).toBeUndefined();
  });

  it("invalid generated story fails with story_invalid and keeps previous story", async () => {
    const { fakes, services, versionId, storyRunId } = await generatedGrammarLesson();
    await executeLessonGeneration(services, storyRunId!);
    const previous = (await versionRow(versionId)).lesson_context.story;
    expect(previous).toBeDefined();

    const payloads = await query<{ payload: unknown }>("select payload from learning_app.item_revisions where deck_version_id = $1", [versionId]);
    const solved = solvedSentencesOf(payloads.map((row) => toExerciseDraft(row.payload)));
    expect(solved.length).toBeGreaterThan(0);
    fakes.llm.generateLessonStory = async () => ({
      story: {
        sentences: [solved[0]!, "Sam rides to the park.", "The park is big and green.", "Sam is very happy."],
        questions: [{ question: "Dokąd jedzie Sam?", options: ["do parku", "do szkoły", "do domu"], correctOptionIndex: 0 }],
      },
    });

    const { runId } = await regenerateLessonStory(services, { deckVersionId: versionId, expectedEditNumber: 2, clientRequestId: randomUUID() });
    await executeLessonGeneration(services, runId);

    const run = await readGeneration(services, runId);
    expect(run.state).toBe("failed");
    expect(run.errorCode).toBe("story_invalid");
    expect((await versionRow(versionId)).lesson_context.story).toEqual(previous);
  });

  it("malformed generated story fails with story_invalid", async () => {
    const { fakes, services, versionId, storyRunId } = await generatedGrammarLesson();
    fakes.llm.generateLessonStory = async () => ({
      story: { sentences: ["One.", "Two.", "Three.", "Four."], questions: [{ question: "?", options: ["a", "b", "c"], correctOptionIndex: 3 }] },
    });

    await executeLessonGeneration(services, storyRunId!);

    const run = await readGeneration(services, storyRunId!);
    expect(run.state).toBe("failed");
    expect(run.errorCode).toBe("story_invalid");
    expect((await versionRow(versionId)).lesson_context.story).toBeUndefined();
  });

  it("provider refusal fails story run without retry", async () => {
    const { fakes, services, storyRunId } = await generatedGrammarLesson();
    let calls = 0;
    fakes.llm.generateLessonStory = async () => {
      calls += 1;
      throw new GenerationProviderError("refusal");
    };

    await executeLessonGeneration(services, storyRunId!);
    await executeLessonGeneration(services, storyRunId!);

    const run = await readGeneration(services, storyRunId!);
    expect(run.state).toBe("failed");
    expect(run.errorCode).toBe("provider_refusal");
    expect(calls).toBe(1);
  });

  it("transient provider error requeues story run with nextAttemptAt", async () => {
    const { fakes, services, clock, versionId, storyRunId } = await generatedGrammarLesson();
    fakes.llm.generateLessonStory = async () => {
      throw new GenerationProviderError("transient");
    };

    await executeLessonGeneration(services, storyRunId!);

    const [run] = await storyRuns(versionId);
    expect(run!.state).toBe("queued");
    expect(run!.attempts).toBe(1);
    expect(run!.error_code).toBe("provider");
    expect(run!.next_attempt_at!.getTime()).toBeGreaterThan(clock.now().getTime());
  });

  it("transient error while preparing story input requeues the run instead of leaving it running", async () => {
    const { services, clock, versionId, storyRunId } = await generatedGrammarLesson();
    // Przejściowy błąd po przejęciu runu, przed wywołaniem modelu (jak awaria odczytu z bazy).
    const failing = {
      ...services,
      subjects: { ...services.subjects, getSubject: () => { throw new Error("connection reset"); } },
    } as typeof services;

    await executeLessonGeneration(failing, storyRunId!);

    const [run] = await storyRuns(versionId);
    expect(run!.state).toBe("queued");
    expect(run!.attempts).toBe(1);
    expect(run!.next_attempt_at!.getTime()).toBeGreaterThan(clock.now().getTime());
  });

  describe("regenerateLessonStory", () => {
    it("published → immutable", async () => {
      const { services, deckId, versionId } = await generatedGrammarLesson();
      const draft = (await readLessonDeck(services, deckId)).draft!;
      await publishLessonDraft(services, versionId, draft.editNumber);
      await expect(regenerateLessonStory(services, {
        deckVersionId: versionId, expectedEditNumber: draft.editNumber, clientRequestId: randomUUID(),
      })).rejects.toMatchObject({ code: "immutable" });
    });

    it("wrong expectedEditNumber → conflict", async () => {
      const { services, versionId, storyRunId } = await generatedGrammarLesson();
      await executeLessonGeneration(services, storyRunId!);
      await expect(regenerateLessonStory(services, {
        deckVersionId: versionId, expectedEditNumber: 1, clientRequestId: randomUUID(),
      })).rejects.toMatchObject({ code: "conflict" });
    });

    it("active lesson run → conflict", async () => {
      const fakes = await fakeGeneration();
      disposers.push(fakes.dispose);
      const services = lessonServices(fakes);
      const { runId } = await createLesson(services, command());
      const versionId = (await readGeneration(services, runId)).deckVersionId!;
      await expect(regenerateLessonStory(services, {
        deckVersionId: versionId, expectedEditNumber: 1, clientRequestId: randomUUID(),
      })).rejects.toMatchObject({ code: "conflict" });
    });

    it("active story run → conflict", async () => {
      const { services, versionId } = await generatedGrammarLesson();
      await expect(regenerateLessonStory(services, {
        deckVersionId: versionId, expectedEditNumber: 2, clientRequestId: randomUUID(),
      })).rejects.toMatchObject({ code: "conflict" });
    });

    it("subject without lessonStory → validation", async () => {
      const { services, deckId, versionId } = await generatedSchoolLesson();
      const draft = (await readLessonDeck(services, deckId)).draft!;
      await expect(regenerateLessonStory(services, {
        deckVersionId: versionId, expectedEditNumber: draft.editNumber, clientRequestId: randomUUID(),
      })).rejects.toMatchObject({ code: "validation" });
    });

    it("same clientRequestId twice → same runId", async () => {
      const { services, deckId, versionId, storyRunId } = await generatedGrammarLesson();
      await executeLessonGeneration(services, storyRunId!);
      const clientRequestId = randomUUID();

      const first = await regenerateLessonStory(services, { deckVersionId: versionId, expectedEditNumber: 2, clientRequestId });
      const second = await regenerateLessonStory(services, { deckVersionId: versionId, expectedEditNumber: 2, clientRequestId });

      expect(second).toEqual(first);
      expect(first.deckId).toBe(deckId);
      const runs = await storyRuns(versionId);
      expect(runs.map((run) => run.id)).toEqual([storyRunId, first.runId]);
      expect(runs[1]).toMatchObject({ state: "queued", dedupe_key: `lesson-story:${clientRequestId}`, expected_edit_number: 2 });
      expect((await versionRow(versionId)).edit_number).toBe(2);
    });
  });

  it("retryGeneration of failed story run requeues without bumping editNumber", async () => {
    const { fakes, services, versionId, storyRunId } = await generatedGrammarLesson();
    const original = fakes.llm.generateLessonStory.bind(fakes.llm);
    fakes.llm.generateLessonStory = async () => {
      throw new GenerationProviderError("refusal");
    };
    await executeLessonGeneration(services, storyRunId!);
    expect((await readGeneration(services, storyRunId!)).state).toBe("failed");
    await editLessonDraft(services, versionId, { expectedEditNumber: 2, title: "Poprawka rodzica" });

    await retryGeneration(services, storyRunId!);

    const [run] = await storyRuns(versionId);
    expect(run).toMatchObject({ state: "queued", attempts: 0, error_code: null, next_attempt_at: null, expected_edit_number: 3 });
    expect((await versionRow(versionId)).edit_number).toBe(3);

    fakes.llm.generateLessonStory = original;
    await executeLessonGeneration(services, storyRunId!);
    expect((await readGeneration(services, storyRunId!)).state).toBe("succeeded");
    expect((await versionRow(versionId)).edit_number).toBe(3);
  });

  it("regenerateObjective is not blocked by a queued story run", async () => {
    const { services, deckId, versionId, storyRunId } = await generatedGrammarLesson();
    expect((await readGeneration(services, storyRunId!)).state).toBe("queued");

    const regen = await regenerateObjective(services, {
      deckId, objectiveId: OBJECTIVE, count: 4, expectedEditNumber: 2, clientRequestId: randomUUID(),
    });
    await executeLessonGeneration(services, regen.runId);

    expect((await readGeneration(services, regen.runId)).state).toBe("succeeded");
    // Dogenerowanie nie anuluje runu historyjki.
    expect((await readGeneration(services, storyRunId!)).state).toBe("queued");
    expect((await versionRow(versionId)).edit_number).toBe(3);
  });
  /** Pełny run lekcji kończy się porażką (błąd konfiguracji providera): wersja bez ćwiczeń. */
  async function failedFullLesson() {
    // Scenariusze fake'a agenta czytane przy każdym wywołaniu: po usunięciu wpisu zagadnienie wraca do generatora.
    const scripts: Record<string, FakeObjectiveScript> = {
      [OBJECTIVE_SLUG]: [{ throw: new GenerationProviderError("configuration", { status: 400 }) }],
    };
    const fakes = await fakeGeneration({ agent: { generate: {}, objectives: scripts } });
    disposers.push(fakes.dispose);
    const services = lessonServices(fakes);
    const { runId, deckId } = await createLesson(services, command());
    await executeLessonGeneration(services, runId);
    expect((await readGeneration(services, runId)).state).toBe("failed");
    delete scripts[OBJECTIVE_SLUG];
    const versionId = (await readGeneration(services, runId)).deckVersionId!;
    return { fakes, scripts, services, lessonRunId: runId, deckId, versionId };
  }

  /** Run historyjki wstawiony wprost (stan, którego nie da się dziś osiągnąć przyciskiem bez puli). */
  async function insertQueuedStoryRun(versionId: string, deckId: string, editNumber: number): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `insert into learning_app.generation_runs (id, deck_version_id, expected_edit_number, kind, dedupe_key, state, input)
       values ($1, $2, $3, 'lesson', $4, 'queued', $5::jsonb)`,
      [id, versionId, editNumber, `lesson-story:${randomUUID()}`, JSON.stringify({
        deckId, deckVersionId: versionId, subjectId: "english_grammar", topicId: "present_simple", topicVersion: 1,
        objectiveIds: [OBJECTIVE], poolSize: 20, material: "He plays football.", purpose: "story",
      })],
    );
    return id;
  }

  it("retrying a full run supersedes an active story run", async () => {
    const { services, lessonRunId, deckId, versionId } = await failedFullLesson();
    const staleStoryRunId = await insertQueuedStoryRun(versionId, deckId, 1);

    await retryGeneration(services, lessonRunId);

    expect((await readGeneration(services, staleStoryRunId)).state).toBe("superseded");
    await executeLessonGeneration(services, lessonRunId);
    expect((await readGeneration(services, lessonRunId)).state).toBe("succeeded");
    // Pełny run po ponowieniu zleca świeżą historyjkę do nowej puli.
    const active = (await storyRuns(versionId)).filter((run) => run.state === "queued");
    expect(active.map((run) => run.dedupe_key)).toEqual([`lesson-story:${lessonRunId}`]);
  });

  it("retrying a failed top-up run keeps the active story run", async () => {
    const { scripts, services, deckId, versionId, storyRunId } = await generatedGrammarLesson();
    scripts[OBJECTIVE_SLUG] = [{ throw: new GenerationProviderError("configuration", { status: 400 }) }];
    const regen = await regenerateObjective(services, {
      deckId, objectiveId: OBJECTIVE, count: 4, expectedEditNumber: 2, clientRequestId: randomUUID(),
    });
    await executeLessonGeneration(services, regen.runId);
    expect((await readGeneration(services, regen.runId)).state).toBe("failed");
    delete scripts[OBJECTIVE_SLUG];

    await retryGeneration(services, regen.runId);

    expect((await readGeneration(services, storyRunId!)).state).toBe("queued");
  });

  it("regenerateLessonStory rejects a version without exercises", async () => {
    const { services, versionId } = await failedFullLesson();
    await expect(regenerateLessonStory(services, {
      deckVersionId: versionId, expectedEditNumber: 1, clientRequestId: randomUUID(),
    })).rejects.toMatchObject({ code: "validation", message: expect.stringContaining("lesson has no exercises") });
    expect(await storyRuns(versionId)).toEqual([]);
  });

  it("retry of a running story run supersedes it and queues a new run; the stale attempt cannot finalize", async () => {
    const { services, versionId, storyRunId } = await generatedGrammarLesson();
    // Worker przejął run i padł: run utknął w `running` z próbą 1.
    expect(await claimQueuedRun(db, storyRunId!)).toBe(1);
    await editLessonDraft(services, versionId, { expectedEditNumber: 2, title: "Poprawka rodzica" });
    const [stuck] = await storyRuns(versionId);

    const { runId: newRunId } = await retryGeneration(services, storyRunId!);

    expect(newRunId).not.toBe(storyRunId);
    const [old, fresh] = await storyRuns(versionId);
    expect(old).toMatchObject({ id: storyRunId, state: "superseded" });
    expect(fresh).toMatchObject({
      id: newRunId,
      kind: "lesson",
      state: "queued",
      attempts: 0,
      error_code: null,
      next_attempt_at: null,
      expected_edit_number: 3,
      dedupe_key: `lesson-story:retry:${newRunId}`,
    });
    expect(fresh!.input).toEqual(stuck!.input);
    expect(fresh!.input.purpose).toBe("story");
    expect((await latestLessonStoryRun(db, versionId))?.id).toBe(newRunId);
    expect((await versionRow(versionId)).edit_number).toBe(3);

    // CAS spóźnionego workera (próba 1) nic nie dopasuje.
    const stale = await pool.query(
      "update learning_app.generation_runs set state = 'succeeded' where id = $1 and state = 'running' and attempts = 1",
      [storyRunId],
    );
    expect(stale.rowCount).toBe(0);
    // Ponowienie zastąpionego runu to konflikt.
    await expect(retryGeneration(services, storyRunId!)).rejects.toMatchObject({ code: "conflict" });

    await executeLessonGeneration(services, newRunId);
    expect((await readGeneration(services, newRunId)).state).toBe("succeeded");
    expect((await versionRow(versionId)).lesson_context.story).toBeDefined();
  });

  it("a story run retried while its model call is in flight cannot write its result", async () => {
    const { fakes, services, versionId, storyRunId } = await generatedGrammarLesson();
    const original = fakes.llm.generateLessonStory.bind(fakes.llm);
    let newRunId: string | undefined;
    fakes.llm.generateLessonStory = async (input) => {
      // Rodzic ponawia „zawieszony” run, zanim model odpowie.
      newRunId = (await retryGeneration(services, storyRunId!)).runId;
      return original(input);
    };

    await executeLessonGeneration(services, storyRunId!);

    expect((await readGeneration(services, storyRunId!)).state).toBe("superseded");
    expect((await versionRow(versionId)).lesson_context.story).toBeUndefined();
    expect((await readGeneration(services, newRunId!)).state).toBe("queued");
    fakes.llm.generateLessonStory = original;
    await executeLessonGeneration(services, newRunId!);
    expect((await readGeneration(services, newRunId!)).state).toBe("succeeded");
    expect((await versionRow(versionId)).lesson_context.story).toBeDefined();
  });

  it("retry of a running story run conflicts while another story run is active", async () => {
    const { services, deckId, versionId, storyRunId } = await generatedGrammarLesson();
    expect(await claimQueuedRun(db, storyRunId!)).toBe(1);
    const otherId = await insertQueuedStoryRun(versionId, deckId, 2);

    await expect(retryGeneration(services, storyRunId!)).rejects.toMatchObject({ code: "conflict" });
    expect((await readGeneration(services, storyRunId!)).state).toBe("running");
    expect((await readGeneration(services, otherId)).state).toBe("queued");
    expect(await storyRuns(versionId)).toHaveLength(2);
  });

  it("retry of a deferred queued story run resets the attempt budget", async () => {
    const { fakes, services, versionId, storyRunId } = await generatedGrammarLesson();
    fakes.llm.generateLessonStory = async () => {
      throw new GenerationProviderError("transient");
    };
    await executeLessonGeneration(services, storyRunId!);
    const [deferred] = await storyRuns(versionId);
    expect(deferred).toMatchObject({ state: "queued", attempts: 1, error_code: "provider" });
    expect(deferred!.next_attempt_at).not.toBeNull();

    await retryGeneration(services, storyRunId!);

    const [reset] = await storyRuns(versionId);
    expect(reset).toMatchObject({ state: "queued", attempts: 0, error_code: null, next_attempt_at: null, expected_edit_number: 2 });
  });

  it("retry of a failed story run conflicts while another story run is active", async () => {
    const { fakes, services, versionId, storyRunId } = await generatedGrammarLesson();
    const original = fakes.llm.generateLessonStory.bind(fakes.llm);
    fakes.llm.generateLessonStory = async () => {
      throw new GenerationProviderError("refusal");
    };
    await executeLessonGeneration(services, storyRunId!);
    expect((await readGeneration(services, storyRunId!)).state).toBe("failed");
    fakes.llm.generateLessonStory = original;
    const { runId: activeRunId } = await regenerateLessonStory(services, {
      deckVersionId: versionId, expectedEditNumber: 2, clientRequestId: randomUUID(),
    });

    await expect(retryGeneration(services, storyRunId!)).rejects.toMatchObject({ code: "conflict" });
    expect((await readGeneration(services, storyRunId!)).state).toBe("failed");
    expect((await readGeneration(services, activeRunId)).state).toBe("queued");
  });

  it("retried full run keeps the parent story and rejects exercises that solve its sentences", async () => {
    const { scripts, services, lessonRunId, deckId, versionId } = await failedFullLesson();
    // Dziś nieosiągalne przez API (patch historyjki podbija editNumber, więc ponowienie
    // pełnego runu daje conflict) — niezmiennik bariery pilnujemy dla każdego zapisu puli.
    await pool.query(
      `update learning_app.deck_versions set lesson_context = lesson_context || jsonb_build_object('story', $2::jsonb) where id = $1`,
      [versionId, JSON.stringify(PARENT_STORY)],
    );
    scripts[OBJECTIVE_SLUG] = [generatedWith([{ ...SHE_PLAYS_GAP, stem: "Tom ___ a small dog.", answer: "has", focus: ["has"] }])];

    await retryGeneration(services, lessonRunId);
    await executeLessonGeneration(services, lessonRunId);

    expect((await readGeneration(services, lessonRunId)).state).toBe("succeeded");
    const draft = (await readLessonDeck(services, deckId)).draft!;
    expect(draft.exercises.length).toBeGreaterThan(0);
    expect(draft.exercises.some((ex) => ex.stem === "Tom ___ a small dog.")).toBe(false);
    expect(draft.rejectedCount).toBeGreaterThanOrEqual(1);
    expect(draft.story).toEqual(PARENT_STORY);
    // Wersja ma historyjkę, więc pełny run nie zleca nowej.
    expect((await storyRuns(versionId)).filter((run) => run.state === "queued")).toEqual([]);
  });

  describe("edycja historyjki (editLessonDraft)", () => {
    it("edit saves valid story and bumps editNumber", async () => {
      const { services, versionId } = await generatedGrammarLesson();

      const dto = await editLessonDraft(services, versionId, { expectedEditNumber: 2, story: PARENT_STORY });

      expect(dto.editNumber).toBe(3);
      expect(dto.story).toEqual(PARENT_STORY);
      const version = await versionRow(versionId);
      expect(version.edit_number).toBe(3);
      expect(version.lesson_context.story).toEqual(PARENT_STORY);
    });

    it("story edit based on an older story conflicts after a story run wrote a new one", async () => {
      // Karta A zaczęła edycję szkicu bez historyjki; w karcie B run historyjki zapisał wynik
      // (bez podbicia editNumber), więc expectedEditNumber karty A nadal się zgadza.
      const { services, versionId, storyRunId } = await generatedGrammarLesson();
      await executeLessonGeneration(services, storyRunId!);
      const generated = (await versionRow(versionId)).lesson_context.story;
      expect(generated).toBeTruthy();

      await expect(
        editLessonDraft(services, versionId, { expectedEditNumber: 2, story: PARENT_STORY, expectedStory: null }),
      ).rejects.toMatchObject({ code: "conflict" });
      const version = await versionRow(versionId);
      expect(version.edit_number).toBe(2);
      expect(version.lesson_context.story).toEqual(generated);
    });

    it("story edit based on the current story saves", async () => {
      const { services, versionId, storyRunId } = await generatedGrammarLesson();
      await executeLessonGeneration(services, storyRunId!);
      const generated = (await versionRow(versionId)).lesson_context.story;

      const dto = await editLessonDraft(services, versionId, { expectedEditNumber: 2, story: PARENT_STORY, expectedStory: generated });

      expect(dto.story).toEqual(PARENT_STORY);
      // Usunięcie też porównuje bazę edycji.
      await expect(
        editLessonDraft(services, versionId, { expectedEditNumber: 3, story: null, expectedStory: generated }),
      ).rejects.toMatchObject({ code: "conflict" });
      const removed = await editLessonDraft(services, versionId, { expectedEditNumber: 3, story: null, expectedStory: PARENT_STORY });
      expect(removed.story).toBeUndefined();
    });

    it("edit with story null removes story", async () => {
      const { services, versionId, storyRunId } = await generatedGrammarLesson();
      await executeLessonGeneration(services, storyRunId!);
      expect((await versionRow(versionId)).lesson_context.story).toBeDefined();

      const dto = await editLessonDraft(services, versionId, { expectedEditNumber: 2, story: null });

      expect(dto.editNumber).toBe(3);
      expect(dto.story).toBeUndefined();
      expect("story" in (await versionRow(versionId)).lesson_context).toBe(false);
    });

    it("edit with 3 sentences fails validation with details.story", async () => {
      const { services, versionId } = await generatedGrammarLesson();

      const error = await editLessonDraft(services, versionId, {
        expectedEditNumber: 2,
        story: { ...PARENT_STORY, sentences: PARENT_STORY.sentences.slice(0, 3) },
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: "validation" });
      expect((error as { details: { story: string[] } }).details.story).toContain("Historyjka ma mieć od 4 do 6 zdań.");
      const version = await versionRow(versionId);
      expect(version.edit_number).toBe(2);
      expect(version.lesson_context.story).toBeUndefined();
    });

    it("edit rejects story sentence equal to an exercise solved in the same patch", async () => {
      const { services, deckId, versionId } = await generatedGrammarLesson();
      const draft = (await readLessonDeck(services, deckId)).draft!;
      const exercises = [...draft.exercises.map((ex) => stripToInput(ex)), SHE_PLAYS_GAP];

      const error = await editLessonDraft(services, versionId, {
        expectedEditNumber: 2,
        exercises,
        story: { ...PARENT_STORY, sentences: ["She plays football.", ...PARENT_STORY.sentences.slice(1)] },
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: "validation" });
      expect((error as { details: { story: string[] } }).details.story).toContain("Zdanie 1 powtarza rozwiązanie ćwiczenia.");
      // Nic nie zapisano: ani ćwiczeń, ani historyjki.
      const after = (await readLessonDeck(services, deckId)).draft!;
      expect(after.editNumber).toBe(2);
      expect(after.exercises).toHaveLength(draft.exercises.length);
      expect(after.story).toBeUndefined();
    });

    it("exercise edit that solves a sentence of the saved story fails validation unless the story is removed", async () => {
      const { services, deckId, versionId } = await generatedGrammarLesson();
      await editLessonDraft(services, versionId, { expectedEditNumber: 2, story: PARENT_STORY });
      const draft = (await readLessonDeck(services, deckId)).draft!;
      // Rozwiązanie „Tom has a small dog.” = zdanie 1 zapisanej historyjki.
      const exercises = [
        ...draft.exercises.map((ex) => stripToInput(ex)),
        { ...SHE_PLAYS_GAP, stem: "Tom ___ a small dog.", answer: "has", focus: ["has"] },
      ];

      const error = await editLessonDraft(services, versionId, { expectedEditNumber: 3, exercises }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: "validation" });
      expect((error as { details: { story: string[] } }).details.story).toContain("Zdanie 1 powtarza rozwiązanie ćwiczenia.");
      const after = (await readLessonDeck(services, deckId)).draft!;
      expect(after.editNumber).toBe(3);
      expect(after.exercises).toHaveLength(draft.exercises.length);
      expect(after.story).toEqual(PARENT_STORY);

      // Ten sam patch z usunięciem historyjki przechodzi.
      const saved = await editLessonDraft(services, versionId, { expectedEditNumber: 3, exercises, story: null, expectedStory: PARENT_STORY });
      expect(saved.exercises).toHaveLength(draft.exercises.length + 1);
      expect(saved.story).toBeUndefined();
    });

    it("edit without story field keeps story and does not supersede story run", async () => {
      const { services, deckId, versionId, storyRunId } = await generatedGrammarLesson();
      await executeLessonGeneration(services, storyRunId!);
      const story = (await versionRow(versionId)).lesson_context.story;
      const { runId: activeRunId } = await regenerateLessonStory(services, {
        deckVersionId: versionId, expectedEditNumber: 2, clientRequestId: randomUUID(),
      });
      const draft = (await readLessonDeck(services, deckId)).draft!;

      const dto = await editLessonDraft(services, versionId, editorExercisePatch(draft));

      expect(dto.story).toEqual(story);
      expect((await versionRow(versionId)).lesson_context.story).toEqual(story);
      expect((await readGeneration(services, activeRunId)).state).toBe("queued");
    });

    it("story patch supersedes failed story runs so the failure banner disappears", async () => {
      const { fakes, services, versionId, storyRunId } = await generatedGrammarLesson();
      fakes.llm.generateLessonStory = async () => {
        throw new GenerationProviderError("refusal");
      };
      await executeLessonGeneration(services, storyRunId!);
      expect((await readGeneration(services, storyRunId!)).state).toBe("failed");

      // Zapis bez pola `story` nie rusza porażki.
      await editLessonDraft(services, versionId, { expectedEditNumber: 2, title: "Tylko tytuł" });
      expect((await readGeneration(services, storyRunId!)).state).toBe("failed");

      await editLessonDraft(services, versionId, { expectedEditNumber: 3, story: PARENT_STORY });

      expect((await readGeneration(services, storyRunId!)).state).toBe("superseded");
      expect((await latestLessonStoryRun(db, versionId))?.state).toBe("superseded");
      // Zastąpionej porażki nie da się już ponowić (nie nadpisze historyjki rodzica).
      await expect(retryGeneration(services, storyRunId!)).rejects.toMatchObject({ code: "conflict" });
      expect((await versionRow(versionId)).lesson_context.story).toEqual(PARENT_STORY);
    });

    it("story null patch supersedes failed story runs but not failed pool runs", async () => {
      const { services, deckId, lessonRunId, versionId } = await failedFullLesson();
      const failedStoryId = await insertQueuedStoryRun(versionId, deckId, 1);
      await pool.query("update learning_app.generation_runs set state = 'failed', error_code = 'provider_refusal' where id = $1", [failedStoryId]);

      await editLessonDraft(services, versionId, { expectedEditNumber: 1, story: null });

      expect((await readGeneration(services, failedStoryId)).state).toBe("superseded");
      expect((await readGeneration(services, lessonRunId)).state).toBe("failed");
    });

    it("edit with story on subject without lessonStory fails validation", async () => {
      const { services, deckId, versionId } = await generatedSchoolLesson();
      const draft = (await readLessonDeck(services, deckId)).draft!;

      await expect(editLessonDraft(services, versionId, { expectedEditNumber: draft.editNumber, story: PARENT_STORY }))
        .rejects.toMatchObject({ code: "validation" });
      await expect(editLessonDraft(services, versionId, { expectedEditNumber: draft.editNumber, story: null }))
        .rejects.toMatchObject({ code: "validation" });
      expect((await versionRow(versionId)).edit_number).toBe(draft.editNumber);
    });
  });

  describe("publikacja historyjki (publishLessonDraft)", () => {
    it("publish rejects story colliding with exercise", async () => {
      const { services, deckId, versionId } = await generatedGrammarLesson();
      const payloads = await query<{ payload: unknown }>("select payload from learning_app.item_revisions where deck_version_id = $1", [versionId]);
      const solved = solvedSentencesOf(payloads.map((row) => toExerciseDraft(row.payload)));
      // Stare dane: historyjka z kolizją zapisana z pominięciem walidacji edycji.
      await pool.query(
        `update learning_app.deck_versions set lesson_context = lesson_context || jsonb_build_object('story', $2::jsonb) where id = $1`,
        [versionId, JSON.stringify({ ...PARENT_STORY, sentences: [solved[0]!, ...PARENT_STORY.sentences.slice(1)] })],
      );
      const draft = (await readLessonDeck(services, deckId)).draft!;

      const error = await publishLessonDraft(services, versionId, draft.editNumber).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: "validation" });
      expect((error as { details: { story: string[] } }).details.story).toContain("Zdanie 1 powtarza rozwiązanie ćwiczenia.");
      expect((await versionRow(versionId)).state).toBe("review");
    });

    it("publish without story succeeds", async () => {
      const { services, deckId, versionId } = await generatedGrammarLesson();
      const draft = (await readLessonDeck(services, deckId)).draft!;
      expect(draft.story).toBeUndefined();

      await publishLessonDraft(services, versionId, draft.editNumber);

      expect((await versionRow(versionId)).state).toBe("published");
    });

    it("publish with story does not wait for audio", async () => {
      const { services, deckId, versionId, storyRunId } = await generatedGrammarLesson();
      await executeLessonGeneration(services, storyRunId!);
      const draft = (await readLessonDeck(services, deckId)).draft!;
      expect(draft.story).toBeDefined();

      await publishLessonDraft(services, versionId, draft.editNumber);

      const deck = await readLessonDeck(services, deckId);
      expect(deck.state).toBe("published");
      expect(deck.published?.story).toEqual(draft.story);
    });

    it("copy of published version keeps story and republishes", async () => {
      const { services, deckId, versionId } = await generatedGrammarLesson();
      const edited = await editLessonDraft(services, versionId, { expectedEditNumber: 2, story: PARENT_STORY });
      await publishLessonDraft(services, versionId, edited.editNumber);

      const copy = await createLessonDraftFromPublished(services, deckId);

      expect(copy.id).not.toBe(versionId);
      expect(copy.story).toEqual(PARENT_STORY);
      await publishLessonDraft(services, copy.id, copy.editNumber);
      const deck = await readLessonDeck(services, deckId);
      expect(deck.published?.id).toBe(copy.id);
      expect(deck.published?.story).toEqual(PARENT_STORY);
    });
  });

  describe("DTO historyjki", () => {
    it("draft dto exposes story and storyEnabled", async () => {
      const grammar = await generatedGrammarLesson();
      await executeLessonGeneration(grammar.services, grammar.storyRunId!);
      const grammarDraft = (await readLessonDeck(grammar.services, grammar.deckId)).draft!;
      expect(grammarDraft.storyEnabled).toBe(true);
      expect(grammarDraft.story?.sentences).toHaveLength(4);
      expect(grammarDraft.story).toEqual((await versionRow(grammar.versionId)).lesson_context.story);

      const school = await generatedSchoolLesson();
      const schoolDraft = (await readLessonDeck(school.services, school.deckId)).draft!;
      expect(schoolDraft.storyEnabled).toBe(false);
      expect(schoolDraft.story).toBeUndefined();
    });

    it("deck dto exposes storyGeneration separately from generation", async () => {
      const { services, deckId, lessonRunId, storyRunId } = await generatedGrammarLesson();

      const deck = await readLessonDeck(services, deckId);

      expect(deck.generation).toMatchObject({ id: lessonRunId, state: "succeeded" });
      expect(deck.storyGeneration).toMatchObject({ id: storyRunId, state: "queued" });
    });

    it("deck dto has null storyGeneration without an editable draft", async () => {
      const { services, deckId, versionId } = await generatedGrammarLesson();
      const draft = (await readLessonDeck(services, deckId)).draft!;
      await publishLessonDraft(services, versionId, draft.editNumber);

      expect((await readLessonDeck(services, deckId)).storyGeneration).toBeNull();
    });
  });

  it("regenerated exercise colliding with story is rejected and counted", async () => {
    const { scripts, services, deckId, versionId, storyRunId } = await generatedGrammarLesson();
    await executeLessonGeneration(services, storyRunId!);
    const story = (await versionRow(versionId)).lesson_context.story as { sentences: string[] };
    expect(story.sentences[0]).toBe("Sam has a red bike.");
    const before = (await readLessonDeck(services, deckId)).draft!;
    // Zgłoszenie dogenerowania: zwykłe ćwiczenia fake + luka, której rozwiązanie to zdanie historyjki.
    scripts[OBJECTIVE_SLUG] = [generatedWith([{ ...SHE_PLAYS_GAP, stem: "Sam ___ a red bike.", answer: "has", focus: ["has"] }])];

    const regen = await regenerateObjective(services, {
      deckId, objectiveId: OBJECTIVE, count: 4, expectedEditNumber: 2, clientRequestId: randomUUID(),
    });
    await executeLessonGeneration(services, regen.runId);

    expect((await readGeneration(services, regen.runId)).state).toBe("succeeded");
    const after = (await readLessonDeck(services, deckId)).draft!;
    expect(after.exercises.length).toBeGreaterThan(before.exercises.length);
    expect(after.exercises.some((ex) => ex.stem === "Sam ___ a red bike.")).toBe(false);
    expect(after.rejectedCount).toBe(before.rejectedCount + 1);
    expect(after.story).toEqual(story);
  });

  it("top-up whose only exercise collides with story fails validation and counts the rejection", async () => {
    const { scripts, services, deckId, versionId, storyRunId } = await generatedGrammarLesson();
    await executeLessonGeneration(services, storyRunId!);
    const before = (await readLessonDeck(services, deckId)).draft!;
    scripts[OBJECTIVE_SLUG] = [{ submit: { exercises: [{ ...SHE_PLAYS_GAP, stem: "Sam ___ a red bike.", answer: "has", focus: ["has"] }] } }];

    const regen = await regenerateObjective(services, {
      deckId, objectiveId: OBJECTIVE, count: 4, expectedEditNumber: 2, clientRequestId: randomUUID(),
    });
    await executeLessonGeneration(services, regen.runId);

    const run = await readGeneration(services, regen.runId);
    expect(run).toMatchObject({ state: "failed", errorCode: "validation" });
    const after = (await readLessonDeck(services, deckId)).draft!;
    expect(after.editNumber).toBe(2);
    expect(after.exercises).toHaveLength(before.exercises.length);
    expect(after.rejectedCount).toBe(before.rejectedCount + 1);

    expect((await versionRow(versionId)).lesson_context.story).toBeDefined();
  });
});
