import { describe, expect, it } from "vitest";
import { GAP_VERB_BRACKET } from "../../feedback-sentence-text";
import { normalizeTokens } from "../../normalize";
import type { LessonTopic } from "../../types";
import { englishGrammarSubject } from "./module";
import { scanTimeMarkers } from "./time-markers";
import { grammarTypeExamples } from "./type-examples";

/**
 * Przykłady typów tematu Present Continuous (`agentPolicy.typeExamples`) nie powtarzają zdań z kart tematu:
 * model kopiuje przykłady, a ćwiczenie równe przykładowi karty niczego nie sprawdza (ślepa ocena
 * sondy Present Continuous: „Tom isn't playing football now.” jak na karcie). Walidację przykładów
 * w ich celach sprawdza `rules/type-cards.test.ts`.
 */

/** Najkrótszy fragment karty traktowany jako zdanie (krótsze to formy, np. „she is”). */
const MIN_SENTENCE_TOKENS = 3;

const joined = (text: string): string => normalizeTokens(text).join(" ");

/** Zdania kart tematu: fragmenty między znakami końca zdania, dwukropkiem, przecinkiem i myślnikiem. */
function cardSentences(topic: LessonTopic): string[] {
  return topic.objectives
    .flatMap((objective) => objective.cards.flatMap((card) => card.body.split(/[.!?:;,—→]/u)))
    .map(joined)
    .filter((sentence) => sentence.split(" ").length >= MIN_SENTENCE_TOKENS);
}

/**
 * Angielskie teksty przykładu: klucz i warianty, bodziec z luką wypełnioną każdym z nich (bez nawiasu
 * z czasownikiem, jak zdanie po odpowiedzi — `GAP_VERB_BRACKET`), zdania, opcje i klocki.
 */
function exampleTexts(example: Readonly<Record<string, unknown>>): string[] {
  const keys = [String(example.answer ?? ""), ...(Array.isArray(example.acceptedAnswers) ? (example.acceptedAnswers as string[]) : [])];
  const stem = typeof example.stem === "string" ? example.stem.replace(GAP_VERB_BRACKET, "$1") : undefined;
  const filled = stem === undefined ? [] : keys.map((key) => stem.replace(/_{2,}/u, key));
  const fields = ["statement", "prompt"].flatMap((key) => (typeof example[key] === "string" ? [example[key] as string] : []));
  const options = Array.isArray(example.options) ? (example.options as { text: string }[]).map((option) => option.text) : [];
  const segments = Array.isArray(example.noticeSegments) ? (example.noticeSegments as string[][]).map((words) => words.join(" ")) : [];
  return [...keys, ...filled, ...fields, ...options, ...segments].map(joined).filter((text) => text !== "");
}

// Karty „to be” wymieniają gołe formy po przecinku („I am not, she is not”), więc test dotyczy tematu Present Continuous.
describe("przykłady typów tematu present_continuous", () => {
  const topicId = "present_continuous";
  const topic = englishGrammarSubject.topics.find((candidate) => candidate.id === topicId)!;
  const sentences = cardSentences(topic);

  it("karty tematu mają zdania do porównania", () => {
    expect(sentences.length).toBeGreaterThan(0);
  });

  it("teksty przykładu: luka bez nawiasu z czasownikiem, wypełniona kluczem i każdym wariantem", () => {
    expect(exampleTexts({ stem: "Look! Tom ___ (not watch) TV.", answer: "isn't watching", acceptedAnswers: ["is not watching"] })).toEqual([
      "isn't watching",
      "is not watching",
      "look tom isn't watching tv",
      "look tom is not watching tv",
    ]);
  });

  it.each(topic.objectives.map((objective) => objective.id))("%s: żaden przykład nie zawiera zdania karty ani nie jest jego częścią", (objectiveId) => {
    const examples = grammarTypeExamples({ topicId, objectiveId });
    expect(examples, objectiveId).toBeDefined();
    const repeated = Object.entries(examples!).flatMap(([type, example]) =>
      exampleTexts(example!).flatMap((text) =>
        sentences
          .filter((sentence) =>
            ` ${text} `.includes(` ${sentence} `) ||
            (text.split(" ").length >= MIN_SENTENCE_TOKENS && ` ${sentence} `.includes(` ${text} `)))
          .map((sentence) => `${type}: „${text}” ~ karta „${sentence}”`),
      ),
    );
    expect(repeated).toEqual([]);
  });

  // Fala 2 Task 19 (krytyk B): przykłady uczą tego, co przyjmuje walidator, a model je kopiuje.
  const example = (objective: string, type: string): Readonly<Record<string, unknown>> =>
    grammarTypeExamples({ topicId, objectiveId: `english_grammar.present_continuous.${objective}` })![type as "lesson_choice"]!;

  it("now_or_usually_more: poprawianie błędu to Present Continuous po scence „zwykle” → Present Simple (Present Simple z now bywa poprawny)", () => {
    const fix = example("now_or_usually_more", "lesson_error_fix");
    expect([...scanTimeMarkers(String(fix.instructionPl), "pl", { instruction: true }).groups]).toEqual(["usually"]);
    expect(String(fix.statement)).toMatch(/\b(?:is|are|isn't|aren't) \w+ing\b/u);
    expect(String(fix.answer)).toMatch(/\b(?:do|does|don't|doesn't) \w+\b/u);
    expect(String(fix.answer)).not.toMatch(/\w+ing\b/u);
  });

  // Krytyk końcowy B (Task 16): model kopiuje przykłady, a w sondzie 2 żadne ćwiczenie celów 2 i 6 nie miało polskiej scenki.
  it.each(["now_or_usually", "now_or_usually_more"])("%s: luka i poprawianie mają czas tylko w polskiej scence polecenia", (objective) => {
    const groups = (["lesson_gap", "lesson_error_fix"] as const).map((type) => {
      const ex = example(objective, type);
      const english = [ex.stem, ex.statement].filter((text): text is string => typeof text === "string");
      expect(english.flatMap((text) => [...scanTimeMarkers(text, "en").groups]), type).toEqual([]);
      const scene = [...scanTimeMarkers(String(ex.instructionPl), "pl", { instruction: true }).groups];
      expect(scene, type).toHaveLength(1);
      return scene[0];
    });
    // Jedna scenka „teraz” i jedna „zwykle”.
    expect(groups.sort()).toEqual(["now", "usually"]);
  });

  it("now_or_usually_more: wybór całych pytań ma polecenie bez czasu i kontekst o podmiocie pytania", () => {
    const choice = example("now_or_usually_more", "lesson_choice");
    expect(choice.instructionPl).toBe("Wybierz poprawne pytanie.");
    const subject = normalizeTokens(String(choice.stem))[0]!;
    for (const option of choice.options as { text: string }[]) expect(normalizeTokens(option.text)).toContain(subject);
  });

  it("negative i questions: wybór ma też dystraktor z do/does (dziecko myli operatory czasów)", () => {
    const texts = (objective: string) => (example(objective, "lesson_choice").options as { text: string }[]).map((option) => option.text);
    expect(texts("negative")).toContain("don't");
    expect(texts("questions")).toContain("Do");
  });
});
