import { describe, expect, it } from "vitest";
import { isMaterialVocabularyTarget, materialPhraseIndex } from "../domain/lessons/subjects/english/material-phrase";
import type { GraderInput } from "../ports/ai";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_FAKE_DECK_ITEMS, FAKE_HOLD_MAX_AGE_MS, FakeAnswerGrader, FakeImageProvider, FakeLlmProvider, FakeTtsProvider, waitWhileFakeHeld } from "./fake";

describe("FakeAnswerGrader — koszt runu", () => {
  const input: GraderInput = {
    subjectTitle: "Angielski", topicTitle: "Present Simple",
    roleProfile: { gradingRole: "grade", almostDefinition: "almost" },
    instruction: "Uzupełnij.", stimulus: "He ___ (play).",
    objective: { description: "-s", errorCategories: [{ code: "missing_s", label: "Brak -s" }] },
    acceptedAnswers: ["plays"], childAnswer: "plays",
  };
  const sink = () => {
    const recorded: (number | null)[] = [];
    return { recorded, record: (usd: number | null) => { recorded.push(usd); } };
  };

  it("zgłasza domyślny koszt 0.0005 raz na wywołanie i zapisuje wywołanie", async () => {
    const grader = new FakeAnswerGrader();
    const cost = sink();
    await grader.grade(input, AbortSignal.timeout(1000), cost);
    expect(cost.recorded).toEqual([0.0005]);
    expect(grader.requests).toHaveLength(1);
  });

  it("costUsd z opcji, także null", async () => {
    const cost = sink();
    await new FakeAnswerGrader({ costUsd: 0.01 }).grade(input, AbortSignal.timeout(1000), cost);
    await new FakeAnswerGrader({ costUsd: null }).grade(input, AbortSignal.timeout(1000), cost);
    expect(cost.recorded).toEqual([0.01, null]);
  });

  it("bez sinka nic się nie zmienia", async () => {
    const grader = new FakeAnswerGrader();
    await expect(grader.grade(input, AbortSignal.timeout(1000))).resolves.toBeDefined();
    expect(grader.callCount).toBe(1);
  });
});

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

describe("FakeLlmProvider — zagadnienia tematu dynamicznego", () => {
  const MATERIAL = [
    "Zagadnienie 1: Ubrania",
    "coat, boots, dress, skirt, t-shirt",
    "Zagadnienie 2: Pogoda",
    "It's raining. It's snowing. What's the weather like?",
  ].join("\n");
  const objectivesInput = { subjectTitle: "Szkoła", topicTitle: "Mapa", material: "Pierwsze zdanie. Drugie zdanie.", generationRole: "role" };

  it("gives the first card cheerful only when voiceTones is set", async () => {
    const llm = new FakeLlmProvider();
    const cardsOn = (await llm.generateLessonObjectives({ ...objectivesInput, voiceTones: true })).objectives as { cards: Record<string, unknown>[] }[];
    expect(cardsOn[0]!.cards.map((c) => c.voiceTone)).toEqual(["cheerful", undefined]);
    const cardsOff = (await llm.generateLessonObjectives(objectivesInput)).objectives as { cards: Record<string, unknown>[] }[];
    for (const card of cardsOff[0]!.cards) expect(card).not.toHaveProperty("voiceTone");
  });

  it("zagadnienia z nagłówków materiału, bez rodzaju zagadnienia (rodzaj daje tylko planista agenta)", async () => {
    const llm = new FakeLlmProvider();
    const base = { subjectTitle: "Szkoła", topicTitle: "Unit 1", material: MATERIAL, generationRole: "role" };
    const objectives = (await llm.generateLessonObjectives(base)).objectives as { titlePl: string; kind?: string }[];
    expect(objectives.map((objective) => objective.titlePl)).toEqual(["Ubrania", "Pogoda"]);
    expect(objectives.every((objective) => !("kind" in objective))).toBe(true);
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
