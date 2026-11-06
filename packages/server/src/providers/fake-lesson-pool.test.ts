import { describe, expect, it } from "vitest";
import { precheckBatch, type AgentCheckContext } from "../domain/lessons/agent/admission";
import { agentObjectivesOf } from "../domain/lessons/agent/capable";
import { createLessonAgentState, orderedLesson, poolOf, withExamples, withPool, allExamples, type LessonAgentState } from "../domain/lessons/agent/state";
import { objectiveStatus } from "../domain/lessons/agent/status";
import { cardExposureSources } from "../domain/lessons/card-exposure-sources";
import { materializeRawExercise } from "../domain/lessons/raw-materialize";
import { rawShapeIssues } from "../domain/lessons/raw-shape";
import { explanationTextErrors } from "../domain/lessons/exercise-explanation";
import { lessonExerciseTargetKey } from "../domain/lessons/exposure-key";
import { findExposureLeaks } from "../domain/lessons/exposure-leaks";
import { stageOf } from "../domain/lessons/stages";
import { englishChapterSubject } from "../domain/lessons/subjects/english-chapter/module";
import { englishGrammarSubject } from "../domain/lessons/subjects/english-grammar/module";
import { schoolSubject } from "../domain/lessons/subjects/school/module";
import { validateDynamicTopicData } from "../domain/lessons/topic-resolution";
import type { AgentObjective, LessonExerciseDraft, LessonTopic, SubjectModule } from "../domain/lessons/types";
import type { LessonObjectiveAgentInput } from "../ports/ai";
import {
  buildDynamicTopicData,
  isWellShapedRawExercise,
  stripParentAddedFlags,
  toExerciseDraft,
  withSubjectObjectiveKinds,
} from "../modules/materials/lessons/lesson-drafts";
import { kindsOf, lessonAgentLimits } from "../modules/materials/lessons/lesson-pool-agent";
import { objectiveAgentInput } from "../modules/materials/lessons/lesson-pool-agent-input";
import { sanitizeFreshLessonDraft } from "../modules/materials/lessons/lesson-pool-acceptance";
import { FakeLlmProvider } from "./fake";
import { fakePlanFromCoverage } from "./fake-lesson-agent";
import { fakeObjectiveExercises } from "./fake-lesson-pool";

/**
 * Generator fake'a agenta puli (etap 3 PR 2 #237, spec §5.2): zgłoszenia przechodzą prawdziwe
 * przyjmowanie (`precheckBatch` na wspólnym stanie lekcji), zagadnienia nie ujawniają sobie
 * rozwiązań, a rozdział domyka wymagane typy, słowa kart i ramy zagadnienia.
 */

/** Materiał rozdziału z sekcjami „Słowa:” i „Zwroty:” (jak `tests/integration/lesson-agent-generation.test.ts`). */
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

/** Małe materiały rozdziału bez sekcji (jak `tests/integration/lesson-chapter.test.ts`): puste pokrycie. */
const WEAR_MATERIAL = "I wear a coat. I wear boots. She wears a dress. We wear a skirt.";
const CARD_MATERIAL = "There is a bed in my room. I like my bed.";

const SCHOOL_MATERIAL = [
  "Zagadnienie 1: Rzeki Polski",
  "Wisła jest najdłuższą rzeką Polski. Odra płynie na zachodzie kraju.",
  "Zagadnienie 2: Góry Polski",
  "Tatry są najwyższymi górami Polski. Sudety leżą na południowym zachodzie.",
  "Zagadnienie 3: Morze",
  "Bałtyk jest morzem śródlądowym. Hel to półwysep.",
].join("\n");

interface Lesson {
  readonly subject: SubjectModule;
  readonly topic: LessonTopic;
  readonly objectives: readonly AgentObjective[];
  readonly material: string;
  readonly examples: Readonly<Record<string, readonly string[]>>;
  readonly examplesFixed: boolean;
  readonly ctx: AgentCheckContext;
}

function lessonOf(args: {
  subject: SubjectModule;
  topic: LessonTopic;
  material: string;
  kinds?: ReadonlyMap<string, "words" | "frame">;
  examples?: Readonly<Record<string, readonly string[]>>;
  examplesFixed: boolean;
  poolSize?: number;
}): Lesson {
  const limits = new Map(lessonAgentLimits(args.subject, args.topic, args.poolSize ?? 0));
  return {
    subject: args.subject,
    topic: args.topic,
    objectives: agentObjectivesOf(args.topic, args.kinds),
    material: args.material,
    examples: args.examples ?? {},
    examplesFixed: args.examplesFixed,
    ctx: { subject: args.subject, material: args.material, limits },
  };
}

function grammarLesson(): Lesson {
  const topic = englishGrammarSubject.topics.find((candidate) => candidate.id === "present_simple")!;
  return lessonOf({ subject: englishGrammarSubject, topic, material: "", examplesFixed: false });
}

async function schoolLesson(): Promise<Lesson> {
  const { objectives } = await new FakeLlmProvider().generateLessonObjectives({
    subjectTitle: schoolSubject.titlePl,
    topicTitle: "Polska",
    material: SCHOOL_MATERIAL,
    generationRole: schoolSubject.prompts.generationRole,
  });
  const built = buildDynamicTopicData(objectives, schoolSubject.id, "42", "Polska", (objective) =>
    validateDynamicTopicData(schoolSubject, { titlePl: "Polska", objectives: [objective] }),
  );
  const data = withSubjectObjectiveKinds(schoolSubject, built.data!);
  return lessonOf({ subject: schoolSubject, topic: schoolSubject.buildDynamicTopic!(data), material: SCHOOL_MATERIAL, examplesFixed: false });
}

/** Rozdział z planem fake'a z pokrycia (jak planista trybu fake): przykłady kart z planu. */
function chapterLesson(material: string, poolSize = 0): Lesson {
  const plan = fakePlanFromCoverage({
    subjectTitle: englishChapterSubject.titlePl,
    topicTitle: "Unit 1",
    material,
    generationRole: "",
    objectiveCount: { min: 3, max: 6 },
    coverage: englishChapterSubject.agentPolicy.planCoverage!(material),
    maxSteps: 8,
  });
  const built = buildDynamicTopicData(plan.objectives, englishChapterSubject.id, "42", "Unit 1");
  const data = built.data!;
  const examples = Object.fromEntries(
    data.objectives.map((objective, index) => [objective.id, plan.objectives[index]!.examples as string[]]),
  );
  return lessonOf({
    subject: englishChapterSubject,
    topic: englishChapterSubject.buildDynamicTopic!(data),
    material,
    kinds: kindsOf(data),
    examples,
    examplesFixed: true,
    poolSize,
  });
}

function emptyState(lesson: Lesson): LessonAgentState {
  return createLessonAgentState({
    topic: lesson.topic,
    objectives: lesson.objectives,
    fixed: [],
    examples: lesson.examples,
    fixedSources: cardExposureSources(lesson.subject, lesson.topic),
  });
}

/** Wejścia podagentów z jednego stanu (podagenci startują razem, jak u kierownika). */
function inputsOf(lesson: Lesson, state: LessonAgentState): LessonObjectiveAgentInput[] {
  return lesson.objectives.map((objective) =>
    objectiveAgentInput({
      subject: lesson.subject,
      topic: lesson.topic,
      state,
      objective,
      limits: lesson.ctx.limits.get(objective.id)!,
      material: lesson.material,
      graderAvailable: false,
      examplesFixed: lesson.examplesFixed,
      maxSteps: 8,
      callTimeoutMs: 90_000,
    }),
  );
}

/** Przyjęcie zgłoszenia jak narzędzie `submit`: kształt, sanityzacja, `precheckBatch`, potem pula i przykłady. */
function admit(
  lesson: Lesson,
  state: LessonAgentState,
  objectiveId: string,
  generated: { exercises: unknown[]; examples?: string[] },
): { state: LessonAgentState; rejected: string[]; drafts: LessonExerciseDraft[] } {
  expect(generated.exercises.every(isWellShapedRawExercise)).toBe(true);
  // Jak `parseRecord` narzędzi: rekordy fake'a są gotowe (materializacja ich nie zmienia) i mają czysty kształt.
  for (const raw of generated.exercises) {
    expect(materializeRawExercise(raw)).toEqual({ ok: true, record: raw });
    expect(rawShapeIssues(raw)).toEqual([]);
  }
  const drafts = generated.exercises.map(
    (raw) => stripParentAddedFlags([sanitizeFreshLessonDraft(toExerciseDraft(raw), lesson.subject, null).draft])[0]!,
  );
  const results = precheckBatch(state, objectiveId, drafts, lesson.ctx);
  const rejected = results.flatMap((result) => (result.pass ? [] : [`${result.rejection.code}: ${result.rejection.reasons.join("; ")}`]));
  const passed = results.flatMap((result) => (result.pass ? [result.draft] : []));
  const entries = passed.map((draft, offset) => ({ id: `ex${state.nextId + offset}`, draft }));
  let next: LessonAgentState = { ...withPool(state, objectiveId, [...poolOf(state, objectiveId), ...entries]), nextId: state.nextId + passed.length };
  if (generated.examples !== undefined) next = withExamples(next, objectiveId, generated.examples);
  return { state: next, rejected, drafts };
}

/** Cała lekcja z pierwszych kroków wszystkich zagadnień (przesunięcie `index * 1000`). */
function generateLesson(lesson: Lesson): { state: LessonAgentState; rejected: string[]; inputs: LessonObjectiveAgentInput[] } {
  let state = emptyState(lesson);
  const inputs = inputsOf(lesson, state);
  const rejected: string[] = [];
  for (const input of inputs) {
    const outcome = admit(lesson, state, input.objective.id, fakeObjectiveExercises(input, input.objective.index * 1000));
    state = outcome.state;
    rejected.push(...outcome.rejected.map((reason) => `${input.objective.id}: ${reason}`));
  }
  return { state, rejected, inputs };
}

function independentKeys(lesson: Lesson, state: LessonAgentState, objectiveId: string): Set<string> {
  return new Set(
    poolOf(state, objectiveId)
      .map((entry) => entry.draft)
      .filter((draft) => stageOf(draft.exerciseType) === "independent")
      .map((draft) => lessonExerciseTargetKey(lesson.subject, draft)),
  );
}

function expectDisjoint(sets: readonly Set<string>[]): void {
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      expect([...sets[i]!].filter((key) => sets[j]!.has(key))).toEqual([]);
    }
  }
}

function expectNoLeaks(lesson: Lesson, state: LessonAgentState): void {
  expect(
    findExposureLeaks({
      exercises: orderedLesson(state),
      examples: allExamples(state),
      objectiveOrder: lesson.objectives.map((objective) => objective.id),
      subject: lesson.subject,
      mode: "coverage",
    }),
  ).toEqual([]);
}

describe("fakeObjectiveExercises — zagadnienia jednej lekcji nie ujawniają sobie rozwiązań", () => {
  it("wejścia mają indeks z kolejności lekcji i zero istniejących ćwiczeń", () => {
    const lesson = grammarLesson();
    const inputs = inputsOf(lesson, emptyState(lesson));
    expect(inputs.map((input) => input.objective.index)).toEqual(lesson.objectives.map((_objective, index) => index));
    expect(inputs.every((input) => input.objective.existingCount === 0)).toBe(true);
  });

  it("trzy zagadnienia gramatyki nie ujawniają sobie rozwiązań", () => {
    const lesson = grammarLesson();
    expect(lesson.objectives.length).toBeGreaterThanOrEqual(3);
    const { state, rejected } = generateLesson(lesson);
    expect(rejected).toEqual([]);
    expectNoLeaks(lesson, state);
    expectDisjoint(lesson.objectives.map((objective) => independentKeys(lesson, state, objective.id)));
    for (const objective of lesson.objectives) expect(objectiveStatus(state, objective.id, lesson.ctx).missing).toEqual([]);
  });

  it("szkoła: to samo (trzy zagadnienia z materiału)", async () => {
    const lesson = await schoolLesson();
    expect(lesson.objectives).toHaveLength(3);
    const { state, rejected } = generateLesson(lesson);
    expect(rejected).toEqual([]);
    expectNoLeaks(lesson, state);
    expectDisjoint(lesson.objectives.map((objective) => independentKeys(lesson, state, objective.id)));
    for (const objective of lesson.objectives) expect(objectiveStatus(state, objective.id, lesson.ctx).missing).toEqual([]);
  });
});

describe("fakeObjectiveExercises — idempotencja materializacji (spec katalogu reguł §4.3)", () => {
  it("rekordy wszystkich typów fake'a: dwa przebiegi materializacji dają ten sam rekord", async () => {
    const lessons = [grammarLesson(), await schoolLesson(), chapterLesson(CHAPTER_MATERIAL), chapterLesson(WEAR_MATERIAL)];
    const types = new Set<string>();
    for (const lesson of lessons) {
      for (const input of inputsOf(lesson, emptyState(lesson))) {
        for (const raw of fakeObjectiveExercises(input, input.objective.index * 1000).exercises) {
          const once = materializeRawExercise(raw);
          if (!once.ok) throw new Error(`fake record not materialized: ${JSON.stringify(once.issues)}`);
          expect(once.record).toEqual(raw);
          expect(materializeRawExercise(structuredClone(once.record))).toEqual(once);
          types.add(String(once.record.exerciseType));
        }
      }
    }
    expect([...types].sort()).toEqual(expect.arrayContaining(["lesson_choice", "lesson_cloze", "lesson_gap", "lesson_match", "lesson_open_answer", "lesson_order"]));
  });
});

describe("fakeObjectiveExercises — rozdział zna zagadnienie", () => {
  it.each([0, 40])("rozdział `words` i `frame` na materiale ze Słowa:/Zwroty: (pula %i)", (poolSize) => {
    const lesson = chapterLesson(CHAPTER_MATERIAL, poolSize);
    expect(lesson.objectives.map((objective) => objective.kind)).toEqual(["words", "words", "frame"]);
    const { state, rejected, inputs } = generateLesson(lesson);
    expect(rejected).toEqual([]);
    for (const input of inputs) {
      const types = new Set(poolOf(state, input.objective.id).map((entry) => entry.draft.exerciseType));
      expect(input.targets.requiredTypes.length).toBeGreaterThan(0);
      for (const group of input.targets.requiredTypes) expect(group.some((type) => types.has(type as never))).toBe(true);
      const status = objectiveStatus(state, input.objective.id, lesson.ctx);
      expect(status.missing).toEqual([]);
      expect(status.complete).toBe(true);
    }
    expectNoLeaks(lesson, state);
  });

  it("zagadnienie ramy: każde zdanie rozwiązania (poza słuchaniem i parami) zawiera ramę z kart", () => {
    const lesson = chapterLesson(CHAPTER_MATERIAL);
    const { state } = generateLesson(lesson);
    const frame = lesson.objectives[2]!;
    const sentences = poolOf(state, frame.id)
      .map((entry) => entry.draft)
      .filter((draft) => !["lesson_listen_choice", "lesson_match"].includes(draft.exerciseType))
      .map((draft) => (draft.clozeText ?? draft.stem ?? draft.answer).toLowerCase());
    expect(sentences.length).toBeGreaterThan(0);
    for (const sentence of sentences) expect(sentence.includes("i am wearing") || sentence.includes("put on your")).toBe(true);
  });

  it.each([
    ["WEAR_MATERIAL", WEAR_MATERIAL],
    ["CARD_MATERIAL", CARD_MATERIAL],
  ])("rozdział na małym materiale (%s) — tłumaczenia trzech zagadnień rozłączne", (_name, material) => {
    const lesson = chapterLesson(material);
    expect(lesson.objectives).toHaveLength(3);
    const { state, rejected } = generateLesson(lesson);
    expect(rejected).toEqual([]);
    const translations = lesson.objectives.map((objective) => independentKeys(lesson, state, objective.id));
    for (const set of translations) expect(set.size).toBeGreaterThan(0);
    expectDisjoint(translations);
    expectNoLeaks(lesson, state);
    for (const objective of lesson.objectives) expect(objectiveStatus(state, objective.id, lesson.ctx).complete).toBe(true);
  });
});

describe("fakeObjectiveExercises — „+N” i liczby", () => {
  const COUNTS = { guided: 8, productive: 8, independent: 4 } as const;

  function answersOf(generated: { exercises: unknown[] }): Set<string> {
    return new Set(generated.exercises.map((raw) => String((raw as { answer: unknown }).answer).toLowerCase()));
  }

  function at(input: LessonObjectiveAgentInput, existingCount: number): LessonObjectiveAgentInput {
    return { ...input, objective: { ...input.objective, existingCount } };
  }

  it.each([
    ["gramatyka", async () => grammarLesson()],
    ["szkoła", schoolLesson],
  ])("+N (%s): przesunięcie rozłączne z pierwszą pulą", async (_name, make) => {
    const lesson = await make();
    const input = inputsOf(lesson, emptyState(lesson))[1]!;
    const first = fakeObjectiveExercises(at(input, 0), 1000, COUNTS);
    const added = fakeObjectiveExercises(at(input, 20), 1000 + 500 + 20 * 2, COUNTS);
    expect(first.exercises.length).toBeGreaterThanOrEqual(20);
    expect(added.exercises.length).toBeGreaterThanOrEqual(20);
    expect([...answersOf(first)].filter((answer) => answersOf(added).has(answer))).toEqual([]);
  });

  it("jawne liczby: tylko zamówione etapy, bez dodatku słuchowego i przykładów przy przykładach planu", () => {
    const lesson = chapterLesson(CHAPTER_MATERIAL);
    const input = inputsOf(lesson, emptyState(lesson))[0]!;
    const generated = fakeObjectiveExercises(input, 100, { independent: 3 });
    const types = generated.exercises.map((raw) => (raw as { exerciseType: string }).exerciseType);
    expect(types).toEqual(["lesson_open_answer", "lesson_open_answer", "lesson_open_answer"]);
    expect(generated.examples).toBeUndefined();
  });

  it("gramatyka: przykłady kart, wyjaśnienia i ton jak w potoku; tylko własne zagadnienie", () => {
    const lesson = grammarLesson();
    const input = inputsOf(lesson, emptyState(lesson))[0]!;
    const pool = { ...input.pool, exerciseExplanations: true, voiceTones: true };
    const generated = fakeObjectiveExercises({ ...input, pool }, 0);
    expect(generated.examples).toEqual([`Example for ${input.objective.id}.`]);
    const exercises = generated.exercises as { objectiveId: string; explanationPl?: string; voiceTone?: string; exerciseType: string; options?: { id: string }[] }[];
    expect(exercises.every((exercise) => exercise.objectiveId === input.objective.id)).toBe(true);
    expect(exercises.every((exercise) => exercise.explanationPl === "Ta reguła mówi, jak zbudować poprawne zdanie.")).toBe(true);
    expect(exercises[0]!.voiceTone).toBe("curious");
    const listen = exercises.filter((exercise) => exercise.exerciseType === "lesson_listen_choice");
    expect(listen).toHaveLength(input.targets.listenAllowance);
    for (const exercise of listen) expect(exercise.options!.map((option) => option.id)).toEqual(["a", "b"]);
  });

  it("szkoła: pola szkoły i polecenie tłumaczenia w odpowiedzi otwartej", async () => {
    const lesson = await schoolLesson();
    const input = inputsOf(lesson, emptyState(lesson))[0]!;
    const open = fakeObjectiveExercises(input, 0).exercises.find(
      (raw) => (raw as { exerciseType: string }).exerciseType === "lesson_open_answer",
    ) as { prompt: string; sourceRefs: unknown[]; requiredElements: unknown[] };
    expect(open.prompt.startsWith("Przetłumacz")).toBe(true);
    expect(open.sourceRefs).toHaveLength(1);
    expect(open.requiredElements).toHaveLength(1);
  });
});

describe("fakeObjectiveExercises — flagi przedmiotu, cytaty i zdania do unikania", () => {
  it("wyjaśnienia: przy fladze każde ćwiczenie ma poprawne wyjaśnienie (gramatyka i rozdział), bez flagi żadne", () => {
    for (const lesson of [grammarLesson(), chapterLesson(CHAPTER_MATERIAL)]) {
      const input = inputsOf(lesson, emptyState(lesson))[0]!;
      const on = fakeObjectiveExercises({ ...input, pool: { ...input.pool, exerciseExplanations: true } }, 0).exercises;
      expect(on.length).toBeGreaterThan(0);
      for (const exercise of on) expect(explanationTextErrors((exercise as { explanationPl: string }).explanationPl)).toEqual([]);
      const off = fakeObjectiveExercises({ ...input, pool: { ...input.pool, exerciseExplanations: false } }, 0).exercises;
      for (const exercise of off) expect(exercise).not.toHaveProperty("explanationPl");
    }
  });

  it("ton lektora: tylko pierwsze ćwiczenie `curious` przy fladze, bez flagi brak pola", () => {
    const lesson = grammarLesson();
    const input = inputsOf(lesson, emptyState(lesson))[0]!;
    const on = fakeObjectiveExercises({ ...input, pool: { ...input.pool, voiceTones: true } }, 0).exercises as { voiceTone?: string }[];
    expect(on.map((exercise) => exercise.voiceTone)).toEqual(["curious", ...on.slice(1).map(() => undefined)]);
    const off = fakeObjectiveExercises({ ...input, pool: { ...input.pool, voiceTones: false } }, 0).exercises;
    for (const exercise of off) expect(exercise).not.toHaveProperty("voiceTone");
  });

  it("rozdział: bez cytatów i podpowiedzi", () => {
    const lesson = chapterLesson(CHAPTER_MATERIAL);
    for (const input of inputsOf(lesson, emptyState(lesson))) {
      for (const exercise of fakeObjectiveExercises(input, input.objective.index * 1000).exercises) {
        expect(exercise).not.toHaveProperty("sourceRefs");
        expect(exercise).not.toHaveProperty("hint");
      }
    }
  });

  it("avoidSentences: zdanie z listy zastąpione innym, liczba ćwiczeń bez zmian", () => {
    const lesson = chapterLesson(CHAPTER_MATERIAL);
    const input = inputsOf(lesson, emptyState(lesson))[0]!;
    const answers = (generated: { exercises: unknown[] }): string[] =>
      generated.exercises
        .filter((raw) => (raw as { exerciseType: string }).exerciseType === "lesson_open_answer")
        .map((raw) => (raw as { answer: string }).answer);
    const base = fakeObjectiveExercises(input, 0);
    const baseAnswers = answers(base);
    expect(baseAnswers.length).toBeGreaterThan(0);
    const avoided = baseAnswers[0]!;
    const replaced = fakeObjectiveExercises({ ...input, pool: { ...input.pool, avoidSentences: [`  ${avoided.toUpperCase()}.  `] } }, 0);
    const replacedAnswers = answers(replaced);
    expect(replaced.exercises).toHaveLength(base.exercises.length);
    expect(replacedAnswers).toHaveLength(baseAnswers.length);
    const normalise = (text: string): string => text.toLowerCase().trim().replace(/\.$/u, "");
    expect(replacedAnswers.map(normalise)).not.toContain(normalise(avoided));
    expect(new Set(replacedAnswers.map(normalise)).size).toBe(replacedAnswers.length);
  });
});
