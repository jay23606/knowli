import { describe, expect, it, vi } from "vitest";
import { lessonExerciseIdentity, lessonExerciseStimulusRecord } from "../domain/lessons/exercise-identity";
import { explanationTextErrors } from "../domain/lessons/exercise-explanation";
import { poolCoverage, validatePool } from "../domain/lessons/pool-validation";
import { stageOf } from "../domain/lessons/stages";
import { englishChapterSubject } from "../domain/lessons/subjects/english-chapter/module";
import { refineChapterPool } from "../domain/lessons/subjects/english-chapter/validators";
import { englishGrammarSubject } from "../domain/lessons/subjects/english-grammar/module";
import { presentSimpleV1 } from "../domain/lessons/subjects/english-grammar/topics/present-simple";
import { toBeV1 } from "../domain/lessons/subjects/english-grammar/topics/to-be";
import type { LessonPoolInput, LessonReviewInput } from "../ports/ai";
import { findExposureLeaks } from "../domain/lessons/exposure-leaks";
import { schoolSubject } from "../domain/lessons/subjects/school/module";
import type { LessonExerciseDraft, LessonTopic, SubjectModule } from "../domain/lessons/types";
import { objectiveBatchCounts, poolStageCounts, toExerciseDraft } from "../modules/materials/lessons/lesson-drafts";
import { isMaterialVocabularyTarget, materialPhraseIndex } from "../domain/lessons/subjects/english/material-phrase";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_FAKE_DECK_ITEMS, FAKE_HOLD_MAX_AGE_MS, FAKE_SLOW_DELAY_MS, FAKE_SLOW_MARKER, FakeImageProvider, FakeLessonReviewer, FakeLlmProvider, FakeTtsProvider, waitWhileFakeHeld } from "./fake";

describe("bramka fake providerów E2E (holdFile)", () => {
  it("zestaw, TTS i obraz czekają, dopóki plik bramki istnieje", async () => {
    const dir = mkdtempSync(join(tmpdir(), "knowli-fake-hold-"));
    const holdFile = join(dir, "hold");
    try {
      writeFileSync(holdFile, "");
      const settled: string[] = [];
      const calls = [
        new FakeLlmProvider({ holdFile }).generateDeck({ prompt: "dni tygodnia", count: 2, vocabularyFormat: "standard" } as never).then(() => settled.push("deck")),
        new FakeTtsProvider({ holdFile }).synthesize({ text: "monday" } as never).then(() => settled.push("tts")),
        new FakeImageProvider({ holdFile }).generate({ prompt: "monday", model: "m", size: "s", quality: "q", format: "png" }).then(() => settled.push("image")),
      ];
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(settled).toEqual([]);
      rmSync(holdFile);
      await Promise.all(calls);
      expect(settled.sort()).toEqual(["deck", "image", "tts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignoruje plik bramki starszy niż FAKE_HOLD_MAX_AGE_MS (awaria testu bez zwolnienia)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "knowli-fake-hold-"));
    const holdFile = join(dir, "hold");
    try {
      writeFileSync(holdFile, "");
      // Świeży plik wstrzymałby wywołanie bez końca; stary kończy czekanie od razu.
      await expect(waitWhileFakeHeld(holdFile, () => Date.now() + FAKE_HOLD_MAX_AGE_MS + 1_000)).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("FakeLlmProvider lesson pool", () => {
  it("produces a publishable 3/4/2 grammar pool after functional-stimulus deduplication", async () => {
    const objective = presentSimpleV1.objectives.find((item) => item.id.endsWith("third_person_s"))!;
    const input: LessonPoolInput = {
      subjectId: englishGrammarSubject.id,
      subjectTitle: englishGrammarSubject.titlePl,
      answerLocale: englishGrammarSubject.answerLocale,
      promptLocale: englishGrammarSubject.promptLocale,
      promptProfile: { generationRole: "lesson", gradingRole: "grammar", almostDefinition: "close" },
      exerciseTypes: englishGrammarSubject.exerciseTypes,
      transforms: [],
      objectives: [{
        id: objective.id,
        descriptionEn: objective.descriptionEn,
        exerciseTypes: objective.exerciseTypes,
        errorCategories: objective.errorCategories,
      }],
      material: "play football school music pets",
      countPerObjective: 20,
      stageCounts: { guided: 6, productive: 10, independent: 4 },
      graderAvailable: false,
      deduplication: "exercise",
    };
    const raw = await new FakeLlmProvider().generateLessonPool(input);
    const drafts = raw.exercises.map(toExerciseDraft);
    const result = validatePool(drafts, englishGrammarSubject, presentSimpleV1);
    expect(result.rejected).toEqual([]);
    expect(result.valid).toHaveLength(20);
    expect(result.valid.filter((item) => stageOf(item.exerciseType) === "guided")).toHaveLength(6);
    expect(result.valid.filter((item) => stageOf(item.exerciseType) === "productive")).toHaveLength(10);
    expect(result.valid.filter((item) => stageOf(item.exerciseType) === "independent")).toHaveLength(4);
  });
});

describe("FakeLlmProvider — wybór ze słuchu (listenChoicePerObjective)", () => {
  function grammarInput(topic: typeof presentSimpleV1, objectiveSuffix: string, overrides: Partial<LessonPoolInput> = {}): LessonPoolInput {
    const objective = topic.objectives.find((item) => item.id.endsWith(objectiveSuffix))!;
    return {
      subjectId: englishGrammarSubject.id,
      subjectTitle: englishGrammarSubject.titlePl,
      answerLocale: englishGrammarSubject.answerLocale,
      promptLocale: englishGrammarSubject.promptLocale,
      promptProfile: { generationRole: "lesson", gradingRole: "grammar", almostDefinition: "close" },
      exerciseTypes: englishGrammarSubject.exerciseTypes,
      transforms: [],
      objectives: [{
        id: objective.id,
        descriptionEn: objective.descriptionEn,
        exerciseTypes: objective.exerciseTypes,
        errorCategories: objective.errorCategories,
      }],
      material: "play football school music pets",
      countPerObjective: 9,
      stageCounts: { guided: 3, productive: 4, independent: 2 },
      graderAvailable: false,
      deduplication: "exercise",
      ...overrides,
    };
  }

  it.each([
    [presentSimpleV1, "third_person_s"],
    [presentSimpleV1, "negative"],
    [presentSimpleV1, "question"],
    [toBeV1, "affirmative_forms"],
    [toBeV1, "negative_forms"],
    [toBeV1, "questions"],
  ] as const)("dokłada 2 poprawne ćwiczenia słuchowe na cel: %#", async (topic, suffix) => {
    const input = grammarInput(topic, suffix, { listenChoicePerObjective: 2 });
    const raw = await new FakeLlmProvider().generateLessonPool(input);
    const drafts = raw.exercises.map(toExerciseDraft);
    const listen = drafts.filter((draft) => draft.exerciseType === "lesson_listen_choice");
    expect(listen).toHaveLength(2);
    for (const draft of listen) {
      expect(draft.instructionPl).toBeUndefined();
      expect(draft.hint).toBeUndefined();
      expect(draft.visualSubject).toBeUndefined();
    }
    // Pozostałe ćwiczenia fake'a nie są budowane pod reguły „to be”, więc oceniamy ćwiczenia słuchowe w pełnej puli.
    const result = validatePool(drafts, englishGrammarSubject, topic);
    expect(result.rejected.filter(({ exercise }) => exercise.exerciseType === "lesson_listen_choice")).toEqual([]);
    expect(result.valid.filter((draft) => draft.exerciseType === "lesson_listen_choice")).toHaveLength(2);
    // Dodatek leży poza podziałem etapów: reszta puli ma dotychczasową liczbę ćwiczeń.
    expect(drafts).toHaveLength(9 + 2);
  });

  it("znacznik wolnej lekcji w materiale opóźnia pulę mimo zerowego lessonDelayMs", async () => {
    vi.useFakeTimers();
    try {
      const input = grammarInput(presentSimpleV1, "third_person_s");
      const llm = new FakeLlmProvider();
      await expect(llm.generateLessonPool(input)).resolves.toBeDefined();
      let settled = false;
      const slow = llm.generateLessonPool({ ...input, material: `${input.material} ${FAKE_SLOW_MARKER}` })
        .then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(FAKE_SLOW_DELAY_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await slow;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bez pola (albo z zerem) nie dokłada ćwiczeń słuchowych", async () => {
    for (const overrides of [{}, { listenChoicePerObjective: 0 }]) {
      const raw = await new FakeLlmProvider().generateLessonPool(grammarInput(presentSimpleV1, "third_person_s", overrides));
      expect(raw.exercises.map((exercise) => (exercise as { exerciseType: string }).exerciseType)).not.toContain("lesson_listen_choice");
    }
  });

  it("pomija cele, których lista nie zawiera typu, i ma unikalne tożsamości także przy dogenerowaniu", async () => {
    const llm = new FakeLlmProvider();
    const first = await llm.generateLessonPool(grammarInput(presentSimpleV1, "third_person_s", { listenChoicePerObjective: 2 }));
    const withoutType = grammarInput(presentSimpleV1, "third_person_s", { listenChoicePerObjective: 2 });
    const stripped = { ...withoutType, objectives: [{ ...withoutType.objectives[0]!, exerciseTypes: withoutType.objectives[0]!.exerciseTypes.filter((type) => type !== "lesson_listen_choice") }] };
    const none = await llm.generateLessonPool(stripped);
    expect(none.exercises.map((exercise) => (exercise as { exerciseType: string }).exerciseType)).not.toContain("lesson_listen_choice");

    const existingExercises = first.exercises.map((exercise) => lessonExerciseStimulusRecord(toExerciseDraft(exercise)));
    const second = await llm.generateLessonPool(grammarInput(presentSimpleV1, "third_person_s", { listenChoicePerObjective: 2, existingExercises }));
    const identities = [...first.exercises, ...second.exercises].map((exercise) => lessonExerciseIdentity(toExerciseDraft(exercise)));
    expect(new Set(identities).size).toBe(identities.length);
  });

  it("rozdział: ćwiczenia słuchowe ze słów materiału przechodzą słownik i walidację puli", async () => {
    const material = ["Zagadnienie 1: Ubrania", "coat, boots, dress, skirt, t-shirt"].join("\n");
    const topic = englishChapterSubject.buildDynamicTopic!({
      titlePl: "Unit 1",
      objectives: [{
        id: "english_chapter.ddeck.clothes",
        titlePl: "Ubrania",
        descriptionEn: "Clothes",
        kind: "words",
        cards: [{ title: "Słówka", body: "coat — płaszcz" }, { title: "Jeszcze", body: "boots — buty" }],
      }],
    });
    const raw = await new FakeLlmProvider().generateLessonPool({
      subjectId: englishChapterSubject.id,
      subjectTitle: englishChapterSubject.titlePl,
      answerLocale: englishChapterSubject.answerLocale,
      promptLocale: englishChapterSubject.promptLocale,
      promptProfile: { generationRole: "lesson", gradingRole: "chapter", almostDefinition: "close" },
      exerciseTypes: englishChapterSubject.exerciseTypes,
      transforms: [],
      objectives: [{ id: topic.objectives[0]!.id, descriptionEn: "Clothes", exerciseTypes: topic.objectives[0]!.exerciseTypes, errorCategories: [] }],
      material,
      countPerObjective: 14,
      stageCounts: { guided: 4, productive: 7, independent: 3 },
      graderAvailable: false,
      deduplication: "exercise",
      listenChoicePerObjective: 2,
    });
    const drafts = raw.exercises.map(toExerciseDraft);
    expect(refineChapterPool(drafts, { material }).rejected).toEqual([]);
    const result = validatePool(drafts, englishChapterSubject, topic);
    expect(result.rejected).toEqual([]);
    expect(result.valid.filter((draft) => draft.exerciseType === "lesson_listen_choice")).toHaveLength(2);
  });
});

describe("FakeLlmProvider voice tones", () => {
  const poolInput = {
    subjectId: "school",
    subjectTitle: "Szkoła",
    answerLocale: "pl-PL",
    promptLocale: "pl-PL",
    promptProfile: { generationRole: "lesson", gradingRole: "grade", almostDefinition: "close" },
    exerciseTypes: ["lesson_open_answer", "lesson_choice"],
    transforms: [],
    objectives: [{ id: "o1", descriptionEn: "d", exerciseTypes: ["lesson_open_answer", "lesson_choice"], errorCategories: [] }],
    material: "Skala mapy pozwala przeliczyć odległość.",
    countPerObjective: 3,
    stageCounts: { guided: 1, productive: 0, independent: 2 },
    graderAvailable: false,
  } satisfies LessonPoolInput;
  const objectivesInput = { subjectTitle: "Szkoła", topicTitle: "Mapa", material: "Pierwsze zdanie. Drugie zdanie.", generationRole: "role" };

  it("gives the first exercise curious and the first card cheerful only when voiceTones is set", async () => {
    const llm = new FakeLlmProvider();
    const on = await llm.generateLessonPool({ ...poolInput, voiceTones: true });
    expect(on.exercises.map((e) => (e as { voiceTone?: unknown }).voiceTone)).toEqual(["curious", undefined, undefined]);
    const off = await llm.generateLessonPool(poolInput);
    for (const exercise of off.exercises) expect(exercise).not.toHaveProperty("voiceTone");

    const cardsOn = (await llm.generateLessonObjectives({ ...objectivesInput, voiceTones: true })).objectives as { cards: Record<string, unknown>[] }[];
    expect(cardsOn[0]!.cards.map((c) => c.voiceTone)).toEqual(["cheerful", undefined]);
    const cardsOff = (await llm.generateLessonObjectives(objectivesInput)).objectives as { cards: Record<string, unknown>[] }[];
    for (const card of cardsOff[0]!.cards) expect(card).not.toHaveProperty("voiceTone");
  });
});

describe("FakeLlmProvider — wyjaśnienie błędu (explanationPl)", () => {
  const grammarInput = {
    subjectId: englishGrammarSubject.id,
    subjectTitle: englishGrammarSubject.titlePl,
    answerLocale: englishGrammarSubject.answerLocale,
    promptLocale: englishGrammarSubject.promptLocale,
    promptProfile: { generationRole: "lesson", gradingRole: "grade", almostDefinition: "close" },
    exerciseTypes: englishGrammarSubject.exerciseTypes,
    transforms: [],
    objectives: [{
      id: presentSimpleV1.objectives[0]!.id,
      descriptionEn: "d",
      exerciseTypes: presentSimpleV1.objectives[0]!.exerciseTypes,
      errorCategories: [],
    }],
    material: "play run jump swim",
    countPerObjective: 3,
    stageCounts: { guided: 1, productive: 1, independent: 1 },
    graderAvailable: false,
  } satisfies LessonPoolInput;

  it("przy fladze każde ćwiczenie ma poprawne wyjaśnienie, bez flagi żadne", async () => {
    const llm = new FakeLlmProvider();
    const on = await llm.generateLessonPool({ ...grammarInput, exerciseExplanations: true });
    expect(on.exercises.length).toBeGreaterThan(0);
    for (const exercise of on.exercises) {
      const text = (exercise as { explanationPl?: unknown }).explanationPl;
      expect(typeof text).toBe("string");
      expect(explanationTextErrors(text as string)).toEqual([]);
    }
    const off = await llm.generateLessonPool(grammarInput);
    for (const exercise of off.exercises) expect(exercise).not.toHaveProperty("explanationPl");
  });

  it("pula rozdziału też niesie wyjaśnienia przy fladze", async () => {
    const topic = englishChapterSubject.buildDynamicTopic!({
      titlePl: "Unit 1",
      objectives: [{
        id: "english_chapter.ddeck.clothes", titlePl: "Ubrania", descriptionEn: "Clothes", kind: "words",
        cards: [{ title: "Słówka", body: "coat — płaszcz" }, { title: "Jeszcze", body: "boots — buty" }],
      }],
    });
    const chapter: LessonPoolInput = {
      subjectId: englishChapterSubject.id,
      subjectTitle: englishChapterSubject.titlePl,
      answerLocale: englishChapterSubject.answerLocale,
      promptLocale: englishChapterSubject.promptLocale,
      promptProfile: { generationRole: "lesson", gradingRole: "chapter", almostDefinition: "close" },
      exerciseTypes: englishChapterSubject.exerciseTypes,
      transforms: [],
      objectives: [{ id: topic.objectives[0]!.id, descriptionEn: "Clothes", exerciseTypes: topic.objectives[0]!.exerciseTypes, errorCategories: [] }],
      material: ["Zagadnienie 1: Ubrania", "coat, boots, dress, skirt, t-shirt"].join("\n"),
      countPerObjective: 6,
      stageCounts: { guided: 2, productive: 2, independent: 2 },
      graderAvailable: false,
      deduplication: "exercise",
    };
    const on = await new FakeLlmProvider().generateLessonPool({ ...chapter, exerciseExplanations: true });
    expect(on.exercises.length).toBeGreaterThan(0);
    for (const exercise of on.exercises) {
      expect(explanationTextErrors((exercise as { explanationPl: string }).explanationPl)).toEqual([]);
    }
    const off = await new FakeLlmProvider().generateLessonPool(chapter);
    for (const exercise of off.exercises) expect(exercise).not.toHaveProperty("explanationPl");
  });
});

describe("FakeLlmProvider — historyjka lekcji", () => {
  it("fake generateLessonStory returns 4 sentences and 1 question with index in range", async () => {
    const llm = new FakeLlmProvider();
    const { story } = await llm.generateLessonStory({
      subjectTitle: "Angielski",
      topicTitle: "Unit 1",
      answerLocale: "en-GB",
      promptLocale: "pl-PL",
      objectives: [],
      material: "coat — płaszcz",
      generationRole: "role",
      storyRules: "rules",
      avoidSentences: [],
    });
    const raw = story as { sentences: string[]; questions: { question: string; options: string[]; correctOptionIndex: number }[] };
    expect(raw.sentences).toHaveLength(4);
    expect(raw.sentences[0]).toBe("Sam has a red bike.");
    expect(raw.questions).toHaveLength(1);
    const [question] = raw.questions;
    expect(question!.question).toBe("Jaki rower ma Sam?");
    expect(question!.options).toEqual(["czerwony", "niebieski", "zielony"]);
    expect(question!.correctOptionIndex).toBe(0);
    expect(question!.correctOptionIndex).toBeGreaterThanOrEqual(0);
    expect(question!.correctOptionIndex).toBeLessThan(question!.options.length);
  });
});

describe("FakeLlmProvider — rozdział angielskiego", () => {
  const MATERIAL = [
    "Zagadnienie 1: Ubrania",
    "coat, boots, dress, skirt, t-shirt",
    "Zagadnienie 2: Pogoda",
    "It's raining. It's snowing. What's the weather like?",
  ].join("\n");

  const topic = englishChapterSubject.buildDynamicTopic!({
    titlePl: "Unit 1",
    objectives: [{
      id: "english_chapter.ddeck.clothes",
      titlePl: "Ubrania",
      descriptionEn: "Clothes",
      kind: "words",
      cards: [{ title: "Słówka", body: "coat — płaszcz" }, { title: "Jeszcze", body: "boots — buty" }],
    }],
  });

  function chapterInput(overrides: Partial<LessonPoolInput> = {}): LessonPoolInput {
    return {
      subjectId: englishChapterSubject.id,
      subjectTitle: englishChapterSubject.titlePl,
      answerLocale: englishChapterSubject.answerLocale,
      promptLocale: englishChapterSubject.promptLocale,
      promptProfile: { generationRole: "lesson", gradingRole: "chapter", almostDefinition: "close" },
      exerciseTypes: englishChapterSubject.exerciseTypes,
      transforms: [],
      objectives: [{
        id: topic.objectives[0]!.id,
        descriptionEn: "Clothes",
        exerciseTypes: topic.objectives[0]!.exerciseTypes,
        errorCategories: [],
      }],
      material: MATERIAL,
      countPerObjective: 14,
      stageCounts: { guided: 4, productive: 7, independent: 3 },
      graderAvailable: false,
      deduplication: "exercise",
      ...overrides,
    };
  }

  it("buduje pulę ze słów materiału: przechodzi słownik, walidację puli i pokrycie 3/3/2", async () => {
    const raw = await new FakeLlmProvider().generateLessonPool(chapterInput());
    const drafts = raw.exercises.map(toExerciseDraft);

    expect(refineChapterPool(drafts, { material: MATERIAL }).rejected).toEqual([]);
    const result = validatePool(drafts, englishChapterSubject, topic);
    expect(result.rejected).toEqual([]);
    expect(result.valid).toHaveLength(14);
    expect(poolCoverage(result.valid, [topic.objectives[0]!.id], englishChapterSubject.poolMinimums!)).toEqual([]);
  });

  it("nie dodaje cytatów ani podpowiedzi, a polecenia są unikalne i niosą polskie zdanie", async () => {
    const raw = await new FakeLlmProvider().generateLessonPool(chapterInput());
    const exercises = raw.exercises as Record<string, unknown>[];
    for (const exercise of exercises) {
      expect(exercise).not.toHaveProperty("sourceRefs");
      expect(exercise).not.toHaveProperty("hint");
    }
    const instructions = exercises
      .filter((exercise) => exercise.exerciseType !== "lesson_open_answer")
      .map((exercise) => exercise.instructionPl);
    expect(new Set(instructions).size).toBe(instructions.length);
    expect(instructions.every((text) => typeof text === "string" && /Zdanie numer \d+/u.test(text))).toBe(true);
  });

  it("dogenerowanie kontynuuje numerację, więc tożsamości ćwiczeń się nie powtarzają", async () => {
    const llm = new FakeLlmProvider();
    const options = { instructionIsStimulus: true };
    const first = await llm.generateLessonPool(chapterInput());
    const existingExercises = first.exercises.map((exercise) => lessonExerciseStimulusRecord(toExerciseDraft(exercise), options));
    const second = await llm.generateLessonPool(chapterInput({ existingExercises }));
    const identities = [...first.exercises, ...second.exercises].map((exercise) => lessonExerciseIdentity(toExerciseDraft(exercise), options));
    expect(new Set(identities).size).toBe(identities.length);
  });

  it("zagadnienia z regułami podziału dostają rodzaj: pierwsze words, kolejne frame; bez reguł bez rodzaju", async () => {
    const llm = new FakeLlmProvider();
    const base = { subjectTitle: "Angielski — rozdział", topicTitle: "Unit 1", material: MATERIAL, generationRole: "role" };
    const withRules = (await llm.generateLessonObjectives({ ...base, objectivesRules: "kinds" })).objectives as { kind?: string }[];
    expect(withRules.map((objective) => objective.kind)).toEqual(["words", "frame"]);
    const withoutRules = (await llm.generateLessonObjectives(base)).objectives as { kind?: string }[];
    expect(withoutRules.every((objective) => !("kind" in objective))).toBe(true);
  });
});

describe("FakeLlmProvider — zestaw słówek ze źródła", () => {
  const SOURCE_TEXT = [
    "What's the weather like? It's sunny. It's raining.",
    "I'm wearing a coat and boots. She is wearing a pink T-shirt. Don't forget your coat!",
  ].join("\n");
  const sourceInput = (overrides: Partial<{ maxItems: number; vocabularyFormat: "standard" | "picture" }> = {}) => ({
    material: SOURCE_TEXT,
    sourceLocale: "pl-PL",
    targetLocale: "en-GB",
    maxItems: 50,
    vocabularyFormat: "standard" as const,
    ...overrides,
  });

  it("bez kolejki: różne słowa treści z tekstu (≥ 3 litery), znaczenie i pierwsze zdanie z tym słowem", async () => {
    const llm = new FakeLlmProvider();
    const { items } = await llm.generateDeck(sourceInput());

    expect(items.map((item) => item.target)).toEqual(["weather", "like", "sunny", "raining", "wearing", "coat", "boots", "pink", "shirt", "forget"]);
    expect(items.find((item) => item.target === "coat")).toEqual({
      source: "„coat” po polsku",
      target: "coat",
      acceptedAnswers: [],
      example: "I'm wearing a coat and boots.",
      visualType: "none",
    });
    expect(items.find((item) => item.target === "shirt")!.example).toBe("She is wearing a pink T-shirt.");
    // każdy element przechodzi walidację serwera trybu ze źródła
    const index = materialPhraseIndex(SOURCE_TEXT);
    expect(items.every((item) => isMaterialVocabularyTarget(item.target, index))).toBe(true);
    expect(llm.requests).toEqual([sourceInput()]);
  });

  it("limit maxItems; format obrazkowy daje ilustracje dopuszczalne w zestawie obrazkowym", async () => {
    const llm = new FakeLlmProvider();
    const limited = await llm.generateDeck(sourceInput({ maxItems: 3 }));
    expect(limited.items.map((item) => item.target)).toEqual(["weather", "like", "sunny"]);

    const picture = await llm.generateDeck(sourceInput({ vocabularyFormat: "picture", maxItems: 2 }));
    expect(picture.items.map((item) => item.visualType)).toEqual(["image", "image"]);
  });

  it("kolejka zachowań nadal ma pierwszeństwo przed elementami z tekstu; tryb opisu bez zmian", async () => {
    const llm = new FakeLlmProvider();
    const queued = [{ source: "parasol", target: "umbrella", acceptedAnswers: [], visualType: "none" }];
    llm.queue({ items: queued });
    expect((await llm.generateDeck(sourceInput())).items).toEqual(queued);

    const description = new FakeLlmProvider();
    const { items } = await description.generateDeck({ prompt: "dni tygodnia", sourceLocale: "pl-PL", targetLocale: "en-GB", maxItems: 10 });
    expect(items).toEqual(DEFAULT_FAKE_DECK_ITEMS);
  });
});

describe("FakeTtsProvider", () => {
  const base = { text: "Świetnie!", locale: "pl-PL", voice: "fake-voice", format: "mp3" as const };

  it("różne instrukcje dają różne bajty", async () => {
    const tts = new FakeTtsProvider();
    const plain = await tts.synthesize(base);
    const styled = await tts.synthesize({ ...base, instructions: "Powiedz radośnie." });
    const other = await tts.synthesize({ ...base, instructions: "Powiedz ciepło." });
    expect(styled.bytes).not.toEqual(plain.bytes);
    expect(other.bytes).not.toEqual(styled.bytes);
  });

  it("bez instrukcji bajty pozostają takie jak dotąd", async () => {
    const tts = new FakeTtsProvider();
    const first = await tts.synthesize(base);
    const second = await tts.synthesize({ ...base });
    expect(second.bytes).toEqual(first.bytes);
  });
});

/** Materiał rozdziału w trzech zagadnieniach (jak w teście integracyjnym rozdziału). */
const LEAK_CHAPTER_MATERIAL = [
  "Zagadnienie 1: Ubrania",
  "coat, boots, dress, skirt, t-shirt",
  "Zagadnienie 2: Pogoda",
  "It's raining. It's snowing. What's the weather like?",
  "Zagadnienie 3: Co mam na sobie",
  "I'm wearing a coat. I'm wearing boots.",
].join("\n");

function poolInputFor(subject: SubjectModule, topic: LessonTopic, objectiveIndex: number, count: number, overrides: Partial<LessonPoolInput> = {}): LessonPoolInput {
  const objective = topic.objectives[objectiveIndex]!;
  return {
    subjectId: subject.id,
    subjectTitle: subject.titlePl,
    answerLocale: subject.answerLocale,
    promptLocale: subject.promptLocale,
    promptProfile: { generationRole: "lesson", gradingRole: "grammar", almostDefinition: "close" },
    exerciseTypes: subject.exerciseTypes,
    transforms: [],
    objectives: [{ id: objective.id, descriptionEn: objective.descriptionEn, exerciseTypes: objective.exerciseTypes, errorCategories: [] }],
    material: LEAK_CHAPTER_MATERIAL,
    countPerObjective: count,
    stageCounts: poolStageCounts(subject, objective.exerciseTypes, count),
    graderAvailable: false,
    deduplication: "exercise",
    ...overrides,
  };
}

describe("FakeLlmProvider — domyślna pula bez ujawnionych rozwiązań", () => {
  const chapterTopic = englishChapterSubject.buildDynamicTopic!({
    titlePl: "Unit 1",
    objectives: [
      { id: "english_chapter.ddeck.a", titlePl: "Ubrania", descriptionEn: "Clothes", kind: "words", cards: [{ title: "Słówka", body: "coat — płaszcz" }] },
      { id: "english_chapter.ddeck.b", titlePl: "Pogoda", descriptionEn: "Weather", kind: "words", cards: [{ title: "Słówka", body: "rain — deszcz" }] },
      { id: "english_chapter.ddeck.c", titlePl: "Co mam na sobie", descriptionEn: "Wearing", kind: "frame", cards: [{ title: "Rama", body: "I'm wearing" }] },
    ],
  });

  it("rozdział (3 zagadnienia, pula 40): suma partii z narastającym existingExercises nie ma ujawnień (coverage i generation)", async () => {
    const counts = objectiveBatchCounts(40, chapterTopic.objectives.length, englishChapterSubject);
    const llm = new FakeLlmProvider();
    const drafts: LessonExerciseDraft[] = [];
    const examples: Record<string, string[]> = {};
    for (const [index, count] of counts.entries()) {
      const existingExercises = drafts.map((draft) => lessonExerciseStimulusRecord(draft, { instructionIsStimulus: true }));
      const raw = await llm.generateLessonPool(poolInputFor(englishChapterSubject, chapterTopic, index, count, {
        existingExercises,
        listenChoicePerObjective: 2,
      }));
      drafts.push(...raw.exercises.map(toExerciseDraft));
      Object.assign(examples, raw.examples);
    }
    expect(drafts.length).toBeGreaterThanOrEqual(40);
    const objectiveOrder = chapterTopic.objectives.map((objective) => objective.id);
    for (const mode of ["coverage", "generation"] as const) {
      expect(findExposureLeaks({ exercises: drafts, examples, objectiveOrder, subject: englishChapterSubject, mode })).toEqual([]);
    }
  });

  it("gramatyka i szkoła: domyślna pula nie ma ujawnień twardych z przykładami kart", async () => {
    const llm = new FakeLlmProvider();
    const grammarObjective = presentSimpleV1.objectives.find((item) => item.id.endsWith("third_person_s"))!;
    const grammarRaw = await llm.generateLessonPool(poolInputFor(englishGrammarSubject, presentSimpleV1, presentSimpleV1.objectives.indexOf(grammarObjective), 20, {
      material: "play football school music pets",
    }));
    expect(findExposureLeaks({
      exercises: grammarRaw.exercises.map(toExerciseDraft),
      examples: grammarRaw.examples,
      objectiveOrder: [grammarObjective.id],
      subject: englishGrammarSubject,
      mode: "generation",
    }).filter((leak) => leak.kind === "hard")).toEqual([]);

    const schoolTopic = schoolSubject.buildDynamicTopic!({
      titlePl: "Historia",
      objectives: [{ id: "school.ddeck.a", titlePl: "Piastowie", descriptionEn: "Piasts", cards: [{ title: "Piastowie", body: "Mieszko I przyjął chrzest w 966 roku." }] }],
    });
    const schoolRaw = await llm.generateLessonPool(poolInputFor(schoolSubject, schoolTopic, 0, 14, {
      material: "Mieszko I przyjął chrzest w 966 roku. Bolesław Chrobry został koronowany w 1025 roku.",
    }));
    expect(findExposureLeaks({
      exercises: schoolRaw.exercises.map(toExerciseDraft),
      examples: schoolRaw.examples,
      objectiveOrder: ["school.ddeck.a"],
      subject: schoolSubject,
      mode: "generation",
    }).filter((leak) => leak.kind === "hard")).toEqual([]);
  });

  it("avoidSentences: zdanie z listy zastąpione innym, liczba ćwiczeń bez zmian", async () => {
    const llm = new FakeLlmProvider();
    const base = await llm.generateLessonPool(poolInputFor(englishChapterSubject, chapterTopic, 0, 14));
    const answers = (raw: { exercises: unknown[] }): string[] =>
      raw.exercises.map(toExerciseDraft).filter((draft) => draft.exerciseType === "lesson_open_answer").map((draft) => draft.answer);
    const baseAnswers = answers(base);
    expect(baseAnswers.length).toBeGreaterThan(0);
    const avoided = baseAnswers[0]!;
    const replaced = await llm.generateLessonPool(poolInputFor(englishChapterSubject, chapterTopic, 0, 14, {
      avoidSentences: [`  ${avoided.toUpperCase()}.  `],
    }));
    const replacedAnswers = answers(replaced);
    expect(replaced.exercises).toHaveLength(base.exercises.length);
    expect(replacedAnswers).toHaveLength(baseAnswers.length);
    const normalise = (text: string): string => text.toLowerCase().trim().replace(/\.$/u, "");
    expect(replacedAnswers.map(normalise)).not.toContain(normalise(avoided));
    expect(new Set(replacedAnswers.map(normalise)).size).toBe(replacedAnswers.length);
  });

  it("queueLesson nie dotyczy purpose=stage_top_up; queueLessonTopUp dotyczy tylko rundy", async () => {
    const llm = new FakeLlmProvider();
    llm.queueLesson({ error: "pool boom", retryable: false });
    llm.queueLessonTopUp({ error: "top-up boom", retryable: false });
    // Runda nie zjada kolejki puli i odwrotnie.
    await expect(llm.generateLessonPool(poolInputFor(englishChapterSubject, chapterTopic, 0, 14, { purpose: "stage_top_up" }))).rejects.toThrow("top-up boom");
    await expect(llm.generateLessonPool(poolInputFor(englishChapterSubject, chapterTopic, 0, 14, { purpose: "pool" }))).rejects.toThrow("pool boom");
    await expect(llm.generateLessonPool(poolInputFor(englishChapterSubject, chapterTopic, 0, 14))).rejects.toThrow("pool boom");

    // Bez kolejki rundy — domyślna deterministyczna pula, mimo kolejki puli.
    const onlyPool = new FakeLlmProvider();
    onlyPool.queueLesson({ error: "pool boom", retryable: false });
    const topUp = await onlyPool.generateLessonPool(poolInputFor(englishChapterSubject, chapterTopic, 0, 14, { purpose: "stage_top_up" }));
    expect(topUp.exercises.length).toBeGreaterThan(0);
  });
});

describe("FakeLessonReviewer", () => {
  const reviewInput = (objectiveId: string, ns: readonly number[]): LessonReviewInput => ({
    subjectTitle: "English",
    answerLocale: "en-GB",
    promptLocale: "pl-PL",
    reviewRole: "role",
    material: "material",
    cardExamples: {},
    objective: { id: objectiveId, title: objectiveId, card: "card" },
    existingExercises: [],
    exercises: ns.map((n) => ({ n, exercise: { exerciseType: "fill_gap" } })),
    findings: [],
  });

  it("domyślnie zwraca ok dla każdego ćwiczenia", async () => {
    const reviewer = new FakeLessonReviewer();
    const result = await reviewer.reviewLessonObjective(reviewInput("o1", [1, 2, 3]), new AbortController().signal);
    expect(result.verdicts).toEqual([
      { n: 1, verdict: "ok" },
      { n: 2, verdict: "ok" },
      { n: 3, verdict: "ok" },
    ]);
  });

  it("behavior może zwracać werdykty zależne od zagadnienia", async () => {
    const reviewer = new FakeLessonReviewer();
    reviewer.behavior = (input) =>
      input.objective.id === "bad" ? [{ n: 1, verdict: "drop", reasonPl: "powód" }] : [{ n: 1, verdict: "ok" }];
    const signal = new AbortController().signal;
    expect((await reviewer.reviewLessonObjective(reviewInput("bad", [1]), signal)).verdicts).toEqual([
      { n: 1, verdict: "drop", reasonPl: "powód" },
    ]);
    expect((await reviewer.reviewLessonObjective(reviewInput("good", [1]), signal)).verdicts).toEqual([
      { n: 1, verdict: "ok" },
    ]);
  });

  it("delayMs i abort odrzucają AbortError bez czekania do końca", async () => {
    const reviewer = new FakeLessonReviewer();
    reviewer.delayMs = 10_000;
    const controller = new AbortController();
    const started = Date.now();
    const pending = reviewer.reviewLessonObjective(reviewInput("o1", [1]), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("już przerwany sygnał odrzuca od razu", async () => {
    const reviewer = new FakeLessonReviewer();
    reviewer.delayMs = 10_000;
    const controller = new AbortController();
    controller.abort();
    await expect(reviewer.reviewLessonObjective(reviewInput("o1", [1]), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    // po odrzuceniu licznik równoległych wywołań wraca do zera
    reviewer.delayMs = 0;
    await reviewer.reviewLessonObjective(reviewInput("o1", [1]), new AbortController().signal);
    expect(reviewer.maxInFlight).toBe(1);
  });

  it("rejestruje wejścia i najwyższą liczbę równoległych wywołań", async () => {
    const reviewer = new FakeLessonReviewer();
    reviewer.delayMs = 20;
    const signal = new AbortController().signal;
    await Promise.all([
      reviewer.reviewLessonObjective(reviewInput("a", [1]), signal),
      reviewer.reviewLessonObjective(reviewInput("b", [1]), signal),
      reviewer.reviewLessonObjective(reviewInput("c", [1]), signal),
    ]);
    expect(reviewer.inputs.map((input) => input.objective.id)).toEqual(["a", "b", "c"]);
    expect(reviewer.maxInFlight).toBe(3);
    await reviewer.reviewLessonObjective(reviewInput("d", [1]), signal);
    expect(reviewer.maxInFlight).toBe(3);
  });
});
