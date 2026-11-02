import { createHash } from "node:crypto";
import type { GenerationDeps, LessonSpeechDeps, SessionActivityDeps, SpeechDeps } from "../config";
import type {
  AnswerGraderProvider,
  AudioInput,
  GraderInput,
  ImageProvider,
  LessonObjectivesInput,
  LessonPoolInput,
  LlmGeneratedItem,
  LlmGenerateDeckInput,
  LlmProvider,
  PronunciationProvider,
  PronunciationResult,
  SessionActivityReviewTask,
  SessionActivityReviewer,
  SttProvider,
  TranscriptionResult,
  TtsProvider,
  TtsSynthesizeInput,
} from "../ports/ai";
import type { MediaStore } from "../ports/media";
import { letterGroups } from "../domain/pronunciation-fragments";
import { checkElement, materialLexicon } from "../domain/lessons/subjects/english-chapter/lexicon";
import { FUNCTION_WORDS } from "../domain/lessons/subjects/english/function-words";
import { isMaterialVocabularyTarget, materialPhraseIndex } from "../domain/lessons/subjects/english/material-phrase";
import { normalizeTokens } from "../domain/lessons/normalize";
import { englishChapterSubject } from "../domain/lessons/subjects/english-chapter/module";
import { materializeGeneratedCalculations } from "./lesson-calculations";

/**
 * Deterministyczni providerzy bez sieci: te same dane wejściowe dają te same
 * bajty, więc content-addressed store naturalnie deduplikuje wyniki. Służą
 * testom integracyjnym/E2E i trybowi UMIEM_FAKE_PROVIDERS=1 (środowisko bez
 * kluczy API); nie są adapterem żadnego serwisu produkcyjnego.
 */

/** Deterministyczne bajty: ten sam seed → te same bajty. */
export function deterministicBytes(seed: string): Uint8Array {
  const digest = createHash("sha256").update(seed).digest();
  return Uint8Array.from(Buffer.concat([digest, digest]));
}

/**
 * Domyślny zestaw fake LLM: siedem dni tygodnia pl→en z celową literówką
 * „thirsday" do poprawienia przez rodzica oraz wariantami odpowiedzi.
 */
export const DEFAULT_FAKE_DECK_ITEMS: Array<Record<string, unknown>> = [
  {
    source: "poniedziałek",
    target: "monday",
    acceptedAnswers: ["Monday"],
    example: "I go to school on monday.",
    visualType: "image",
  },
  { source: "wtorek", target: "tuesday", acceptedAnswers: [], visualType: "image" },
  { source: "środa", target: "wednesday", acceptedAnswers: [], visualType: "image" },
  { source: "czwartek", target: "thirsday", acceptedAnswers: [], visualType: "image" },
  {
    source: "piątek",
    target: "friday",
    acceptedAnswers: ["Friday", "Fri."],
    example: "Friday is my favourite day.",
    visualType: "image",
  },
  { source: "sobota", target: "saturday", acceptedAnswers: [], visualType: "none" },
  { source: "niedziela", target: "sunday", acceptedAnswers: ["Sunday"], visualType: "none" },
];

export const DEFAULT_FAKE_PICTURE_DECK_ITEMS: Array<Record<string, unknown>> = [
  { source: "czerwony", target: "red", acceptedAnswers: [], visualType: "color", visualData: { color: "#ff0000" } },
  { source: "niebieski", target: "blue", acceptedAnswers: [], visualType: "color", visualData: { color: "#0000ff" } },
  { source: "jeden", target: "one", acceptedAnswers: [], visualType: "number", visualData: { count: 1 } },
  { source: "dwa", target: "two", acceptedAnswers: [], visualType: "number", visualData: { count: 2 } },
];

/** Słowo tekstu źródła kandydujące na domyślny element fake'a: same litery, co najmniej 3. */
const FAKE_SOURCE_WORD = /^\p{L}{3,}$/u;

/**
 * Domyślny wynik fake'a w trybie ze źródła (design 2026-10-30 §6.2): do
 * `maxItems` różnych słów tekstu w kolejności występowania — tokeny z samych
 * liter (≥ 3), spoza `FUNCTION_WORDS`, przechodzące walidację serwera
 * (`isMaterialVocabularyTarget`), więc żaden element nie jest odrzucany.
 * `source` = `„<słowo>” po polsku`, `example` = pierwsze zdanie tekstu z tym
 * słowem. Format obrazkowy dostaje `visualType: "image"` (ilustracja fake'a),
 * standardowy — `none`.
 */
function fakeSourceDeckItems(input: { material: string; maxItems: number; vocabularyFormat?: "standard" | "picture" }): LlmGeneratedItem[] {
  const index = materialPhraseIndex(input.material);
  const sentences = input.material.split(/(?<=[.!?])\s+|\n+/u).map((sentence) => sentence.trim()).filter(Boolean);
  const words: string[] = [];
  for (const token of normalizeTokens(input.material)) {
    if (words.length >= input.maxItems) break;
    if (words.includes(token) || !FAKE_SOURCE_WORD.test(token) || FUNCTION_WORDS.has(token)) continue;
    if (isMaterialVocabularyTarget(token, index)) words.push(token);
  }
  return words.map((word) => {
    const example = sentences.find((sentence) => normalizeTokens(sentence).includes(word));
    return {
      source: `„${word}” po polsku`,
      target: word,
      acceptedAnswers: [],
      ...(example === undefined ? {} : { example: example.slice(0, 300) }),
      visualType: input.vocabularyFormat === "picture" ? "image" : "none",
    };
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type LlmBehavior =
  | { items: Array<Record<string, unknown>> }
  | { error: string; retryable: boolean };

/**
 * Zachowanie fake'a dla generacji puli lekcji: albo surowe ćwiczenia + przykłady
 * do zwrócenia, albo błąd (retryable jak dla decków), albo deterministyczna pula
 * domyślna generowana z wejścia. `invalid: true` zmusza fake do wygenerowania
 * ćwiczeń odrzucanych przez walidację (dowód odrzuceń pojedynczych).
 */
export type LlmLessonBehavior =
  | { exercises: unknown[]; examples?: Record<string, string[]> }
  | { error: string; retryable: boolean }
  | { invalid: true };

/** Deterministyczne słowo z materiału (pierwszy token) dla danego indeksu. */
function materialWord(material: string, index: number): string {
  const words = material
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const base = words.length > 0 ? words[index % words.length]! : "word";
  // Unikalność odpowiedzi w puli: dołączamy sufiks indeksu (po normalizacji
  // nadal jeden token, bo cyfry są częścią tokenu).
  return index === 0 ? base.toLowerCase() : `${base.toLowerCase()}${index}`;
}

/** Typy ćwiczeń fake'a według etapu: budowany jest pierwszy typ dozwolony przez cel. */
const FAKE_STAGE_TYPES: Record<"guided" | "productive" | "independent", readonly string[]> = {
  guided: ["lesson_choice", "lesson_short_answer", "lesson_order"],
  productive: ["lesson_gap", "lesson_error_fix", "lesson_transform"],
  independent: ["lesson_open_answer"],
};

/**
 * Słowa treści materiału rozdziału w kolejności występowania, bez powtórzeń:
 * wyłącznie takie, które przechodzą walidację słownikową przedmiotu (są
 * w słowniku materiału i nie są słowami funkcyjnymi), więc ćwiczenia fake'a
 * nie są odrzucane przez `refineGeneratedPool`.
 */
function chapterContentWords(material: string): string[] {
  const lexicon = materialLexicon(material);
  const words: string[] = [];
  for (const token of material.normalize("NFC").toLowerCase().match(/\p{L}{3,}/gu) ?? []) {
    if (!words.includes(token) && checkElement(token, lexicon).ok) words.push(token);
  }
  return words;
}

/**
 * Jedno ćwiczenie rozdziału zbudowane wyłącznie ze słów materiału: bez
 * `sourceRefs` i `hint`, z unikalnym polskim zdaniem-bodźcem (numer ćwiczenia)
 * w `instructionPl`, jedną luką w zdaniu i opcjami ze słów materiału.
 */
function fakeChapterExercise(
  type: string,
  objectiveId: string,
  words: readonly string[],
  index: number,
  sequence: number,
): Record<string, unknown> {
  const answer = words[index % words.length]!;
  const number = sequence + 1;
  const base = { exerciseType: type, objectiveId, acceptedAnswers: [] as string[] };
  switch (type) {
    case "lesson_choice": {
      const options = [0, 1, 2]
        .map((step) => words[(index + step) % words.length]!)
        .filter((word, position, all) => all.indexOf(word) === position);
      return {
        ...base,
        instructionPl: `Zdanie numer ${number} ma lukę. Wybierz słowo.`,
        stem: "I can see the ___.",
        answer,
        focus: [],
        options: options.map((text, position) => ({ id: String.fromCharCode(97 + position), text })),
        correctOption: "a",
      };
    }
    case "lesson_gap":
      return {
        ...base,
        instructionPl: `Zdanie numer ${number} ma lukę. Wpisz brakujące słowo.`,
        stem: "I have the ___.",
        answer,
        focus: [answer],
      };
    default:
      return {
        ...base,
        exerciseType: "lesson_open_answer",
        instructionPl: "Przetłumacz na angielski.",
        prompt: `Przetłumacz zdanie numer ${number}.`,
        answer: `We have the ${answer}`,
        focus: [answer],
      };
  }
}

/**
 * Pula rozdziału: etapy guided/productive/independent dają wybór, lukę
 * i tłumaczenie ze słów materiału; przykłady do kart to angielskie zdania.
 */
function fakeChapterPool(input: LessonPoolInput): {
  exercises: Record<string, unknown>[];
  examples: Record<string, string[]>;
} {
  const words = chapterContentWords(input.material);
  const exercises: Record<string, unknown>[] = [];
  const examples: Record<string, string[]> = {};
  // Numeracja i dobór słów kontynuują partie wcześniejsze (dogenerowanie).
  const offset = input.existingExercises?.length ?? 0;
  let index = offset;
  for (const objective of input.objectives) {
    examples[objective.id] = words.slice(0, 3).map((word) => `I have the ${word}.`);
    const allowed = new Set(objective.exerciseTypes);
    for (const stage of ["guided", "productive", "independent"] as const) {
      const type = FAKE_STAGE_TYPES[stage].find((candidate) => allowed.has(candidate));
      if (type === undefined || words.length === 0) continue;
      for (let i = 0; i < input.stageCounts[stage]; i++) {
        exercises.push(fakeChapterExercise(type, objective.id, words, index, offset + exercises.length));
        index += 1;
      }
    }
    // Dodatek poza podziałem etapów: wybór ze słuchu ze słów materiału (zdanie czytane w całości).
    if (allowed.has(LISTEN_CHOICE_TYPE) && words.length >= 2) {
      for (let i = 0; i < (input.listenChoicePerObjective ?? 0); i++) {
        const answer = words[index % words.length]!;
        const other = words[(index + 1) % words.length]!;
        exercises.push(fakeListenChoice(objective.id, index % 2 === 0 ? "I can see the ___." : "I have the ___.", answer, other));
        index += 1;
      }
    }
  }
  return { exercises, examples };
}

/**
 * Deterministyczna pula ćwiczeń dla jednego wejścia `generateLessonPool`.
 * Działa dla DOWOLNEGO przedmiotu: wybiera typy ćwiczeń z celu i etapu, buduje
 * poprawne ćwiczenia (focus = odpowiedź, luka z jednym znacznikiem, opcje
 * unikalne) z unikalnymi odpowiedziami także wobec `existingAnswers`.
 */
function fakeLessonExercises(input: LessonPoolInput): {
  exercises: Record<string, unknown>[];
  examples: Record<string, string[]>;
} {
  // Pula rozdziału musi przejść walidację słownikową, więc ma własną gałąź (infrastruktura testowa, nie silnik).
  if (input.subjectId === englishChapterSubject.id) {
    return fakeChapterPool(input);
  }
  const exercises: Record<string, unknown>[] = [];
  const examples: Record<string, string[]> = {};
  // Odpowiedzi już w puli, znormalizowane naiwnie (lowercase) — fake trzyma je,
  // by nie wygenerować duplikatu przy dogenerowaniu.
  const used = new Set<string>((input.existingAnswers ?? []).map((a) => a.toLowerCase()));
  // Przy dogenerowaniu kontynuuj indeks bodźców wcześniejszych partii, aby
  // testowy provider nie wysyłał tej samej luki tylko z nowym ID.
  let seq = input.existingExercises?.length ?? 0;

  const nextAnswer = (material: string): string => {
    let answer = materialWord(material, seq++);
    while (used.has(answer.toLowerCase())) {
      answer = materialWord(material, seq++);
    }
    used.add(answer.toLowerCase());
    return answer;
  };

  for (const objective of input.objectives) {
    examples[objective.id] = [`Example for ${objective.id}.`];
    const allowed = new Set(objective.exerciseTypes);
    for (const stage of ["guided", "productive", "independent"] as const) {
      const count = input.stageCounts[stage];
      // Preferuj najprostszy do poprawnego zbudowania typ danego etapu:
      // choice (guided), gap bez hintu (productive), open_answer (independent).
      const type = FAKE_STAGE_TYPES[stage].find((t) => allowed.has(t));
      if (type === undefined) {
        continue;
      }
      for (let i = 0; i < count; i++) {
        const answer = nextAnswer(input.material);
        exercises.push(fakeExercise(type, objective.id, answer, input, (input.existingExercises?.length ?? 0) + exercises.length));
      }
    }
    // Dodatek poza podziałem etapów: wybór ze słuchu na każdy cel, którego lista zawiera typ.
    if (allowed.has(LISTEN_CHOICE_TYPE)) {
      for (let i = 0; i < (input.listenChoicePerObjective ?? 0); i++) {
        const answer = nextAnswer(input.material);
        const number = (input.existingExercises?.length ?? 0) + exercises.length + 1;
        exercises.push(fakeListenChoice(objective.id, `Listen and choose: ___ (${number}).`, answer, FAKE_LISTEN_DISTRACTORS.find((word) => word !== answer.toLowerCase())!));
      }
    }
  }

  // Gwarancja ≥ 1 ćwiczenia: jeśli etapy nic nie dały (nietypowy cel), dołóż
  // jedno open_answer, jeśli dozwolone, inaczej pierwszy dozwolony typ.
  if (exercises.length === 0 && input.objectives.length > 0) {
    const objective = input.objectives[0]!;
    const type = objective.exerciseTypes[0] ?? "lesson_open_answer";
    exercises.push(fakeExercise(type, objective.id, nextAnswer(input.material), input, input.existingExercises?.length ?? 0));
  }

  // Przykładowy ton lektora (etap B): tylko gdy generator ma go zwracać.
  if (input.voiceTones === true && exercises.length > 0) exercises[0] = { ...exercises[0]!, voiceTone: "curious" };

  return { exercises, examples };
}

/** Typ wyboru ze słuchu: dodatek poza podziałem etapów (`listenChoicePerObjective`). */
const LISTEN_CHOICE_TYPE = "lesson_listen_choice";

/** Słowa dystraktorów fake'a: brzmią inaczej niż jakikolwiek token materiału testów. */
const FAKE_LISTEN_DISTRACTORS: readonly string[] = ["orange", "window"];

/**
 * Ćwiczenie wyboru ze słuchu: zdanie z jedną luką, dwie słyszalnie różne opcje, odpowiedź = tekst poprawnej
 * opcji. Bez polecenia, podpowiedzi i piktogramu (jak po `stripListenChoiceExtras`); zdanie z lukiem
 * wypełnioną poprawną opcją nie może równać się odpowiedzi ćwiczenia tekstowego puli.
 */
function fakeListenChoice(objectiveId: string, stem: string, answer: string, other: string): Record<string, unknown> {
  return {
    exerciseType: LISTEN_CHOICE_TYPE,
    objectiveId,
    stem,
    answer,
    acceptedAnswers: [],
    focus: [answer],
    options: [
      { id: "a", text: answer },
      { id: "b", text: other },
    ],
    correctOption: "a",
  };
}

/** Jedno poprawne ćwiczenie danego typu (lub najbliższe poprawnemu). */
function fakeExercise(
  type: string,
  objectiveId: string,
  answer: string,
  input: LessonPoolInput,
  sequence: number,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    exerciseType: type,
    objectiveId,
    instructionPl: "Uzupełnij.",
    answer,
    acceptedAnswers: [],
    focus: [answer],
    ...(input.subjectId === "school" ? schoolFieldsForFake(type, answer, input.material) : {}),
  };
  switch (type) {
    case "lesson_choice":
    case "lesson_short_answer":
      return {
        ...base,
        focus: [],
        stem: `Wybierz poprawną odpowiedź (${sequence + 1}).`,
        options: [
          { id: "a", text: answer },
          { id: "b", text: `${answer}x` },
        ],
        correctOption: "a",
      };
    case "lesson_order":
      return {
        ...base,
        focus: [],
        answer: `${answer} one two`,
        items: [
          { id: "i1", text: answer },
          { id: "i2", text: "one" },
          { id: "i3", text: "two" },
        ],
      };
    case "lesson_gap":
      // bez `hint`: unikamy reguły przedmiotu wiążącej odpowiedź z czasownikiem.
      return { ...base, stem: `___ here (${answer}).` };
    case "lesson_error_fix":
      return { ...base, statement: `${answer}x wrong.` };
    case "lesson_transform":
      return {
        ...base,
        transformId: input.transforms[0]?.id ?? "unknown_transform",
        statement: `Przekształć zdanie (${sequence + 1}).`,
      };
    case "lesson_notice":
      return {
        exerciseType: type,
        objectiveId,
        instructionPl: "Wskaż słowo.",
        answer,
        acceptedAnswers: [],
        focus: [],
        noticeSegments: [[answer, "one"], ["two", "three"]],
        correctOption: answer,
      };
    case "lesson_open_answer":
    default:
      return { ...base, prompt: `Przetłumacz zdanie (${sequence + 1}).` };
  }
}

/** Celowo niepoprawne ćwiczenie (puste pola) — do dowodu odrzuceń walidacji. */
function fakeInvalidExercise(objectiveId: string): Record<string, unknown> {
  return {
    exerciseType: "lesson_gap",
    objectiveId,
    answer: "a b c d e", // > 3 tokeny → odrzucone
    acceptedAnswers: [],
    focus: [],
    stem: "no gap marker here",
  };
}

/** Slug zagadnienia z tytułu (ASCII, podkreślniki) — do fake celów dynamicznych. */
function slugifyTitle(title: string, fallback: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    // Runs are already collapsed to one "_", so trimming one per end is enough (no backtracking).
    .replace(/^_/, "")
    .replace(/_$/, "")
    .slice(0, 40);
  return slug.length > 0 ? slug : fallback;
}

/**
 * Deterministyczne zagadnienia fake: z nagłówków „Zagadnienie N:” materiału
 * (format opracowań rodzica) albo jedno zagadnienie z początku materiału.
 * Karty buduje z fragmentów materiału, więc cytaty ćwiczeń mają pokrycie.
 */
function fakeLessonObjectives(input: LessonObjectivesInput): Record<string, unknown>[] {
  // Disjoint classes around the colon keep matching linear on long whitespace runs.
  const headings = [...input.material.matchAll(/^Zagadnienie[ \t]*\d+[ \t]*:[ \t]*(\S.*)$/gim)];
  const sections: { title: string; body: string }[] = [];
  if (headings.length > 0) {
    headings.forEach((match, i) => {
      const start = (match.index ?? 0) + match[0].length;
      const end = i + 1 < headings.length ? (headings[i + 1]!.index ?? input.material.length) : input.material.length;
      sections.push({ title: match[1]!.trim(), body: input.material.slice(start, end).trim() });
    });
  } else {
    sections.push({ title: input.topicTitle, body: input.material.trim() });
  }
  const objectives = sections.map((section, i) => {
    const sentences = section.body.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    const first = (sentences[0] ?? section.title).slice(0, 280);
    const second = (sentences[1] ?? sentences[0] ?? section.title).slice(0, 280);
    return {
      slug: slugifyTitle(section.title, `zagadnienie_${i + 1}`),
      titlePl: section.title.slice(0, 120),
      descriptionEn: `School objective: ${section.title}`,
      cards: [
        { title: "Wyjaśnienie", body: first },
        { title: "Do zapamiętania", body: second },
      ],
      // Rodzaj zagadnienia zwraca tylko model, któremu przedmiot dał reguły podziału (rozdział):
      // pierwsze to grupa słów, kolejne to ramy zdaniowe.
      ...(input.objectivesRules === undefined ? {} : { kind: i === 0 ? "words" : "frame" }),
    };
  });
  // Przykładowy ton pierwszej karty (etap B): tylko gdy generator ma go zwracać.
  if (input.voiceTones === true) {
    const cards = objectives[0]?.cards as Record<string, unknown>[] | undefined;
    if (cards?.[0]) cards[0] = { ...cards[0], voiceTone: "cheerful" };
  }
  return objectives;
}

/** Pola v3 dla fake puli przedmiotu szkolnego (uziemienie = początek materiału). */
function schoolFieldsForFake(type: string, answer: string, material: string): Record<string, unknown> {
  const quote = material.trim().slice(0, 120);
  const base: Record<string, unknown> = { sourceRefs: [{ quote }] };
  if (type === "lesson_open_answer") {
    return {
      ...base,
      questionType: "fact",
      requiredElements: [{ id: "e1", text: `Podaje: ${answer}`.slice(0, 120) }],
      supplementaryElements: [],
      commonErrors: [],
      expectedForm: "short",
    };
  }
  return base;
}

export class FakeLlmProvider implements LlmProvider {
  readonly name = "fake-llm";
  readonly model = "fake-llm-1";
  readonly requests: LlmGenerateDeckInput[] = [];
  readonly lessonRequests: LessonPoolInput[] = [];
  readonly objectiveRequests: LessonObjectivesInput[] = [];
  #behaviors: LlmBehavior[] = [];
  #lessonBehaviors: LlmLessonBehavior[] = [];
  readonly #delayMs: number;
  readonly #lessonDelayMs: number;

  constructor(options: { delayMs?: number; lessonDelayMs?: number } = {}) {
    this.#delayMs = options.delayMs ?? 0;
    this.#lessonDelayMs = options.lessonDelayMs ?? this.#delayMs;
  }

  /** Zastępuje plan zachowań: kolejne wywołania zjadają elementy z kolejki, ostatni się powtarza. */
  queue(...behaviors: LlmBehavior[]): void {
    this.#behaviors = behaviors;
  }

  /** Plan zachowań generacji puli lekcji (jedna partia per cel = jedno wywołanie). */
  queueLesson(...behaviors: LlmLessonBehavior[]): void {
    this.#lessonBehaviors = behaviors;
  }

  async generateDeck(input: LlmGenerateDeckInput): Promise<{ items: LlmGeneratedItem[] }> {
    this.requests.push(input);
    if (this.#delayMs > 0) {
      await sleep(this.#delayMs);
    }
    const behavior =
      this.#behaviors.length > 1 ? this.#behaviors.shift()! : this.#behaviors[0] ?? null;
    if (!behavior) {
      if ("material" in input) return { items: fakeSourceDeckItems(input) };
      const defaults = input.vocabularyFormat === "picture" ? DEFAULT_FAKE_PICTURE_DECK_ITEMS : DEFAULT_FAKE_DECK_ITEMS;
      return { items: defaults as unknown as LlmGeneratedItem[] };
    }
    if ("error" in behavior) {
      const error = new Error(behavior.error) as Error & { retryable?: boolean };
      error.retryable = behavior.retryable;
      throw error;
    }
    return { items: behavior.items as unknown as LlmGeneratedItem[] };
  }

  async generateLessonObjectives(input: LessonObjectivesInput): Promise<{ objectives: unknown[] }> {
    this.objectiveRequests.push(input);
    if (this.#lessonDelayMs > 0) {
      await sleep(this.#lessonDelayMs);
    }
    return { objectives: fakeLessonObjectives(input) };
  }

  async generateLessonPool(
    input: LessonPoolInput,
  ): Promise<{ exercises: unknown[]; examples: Record<string, string[]> }> {
    this.lessonRequests.push(input);
    if (this.#lessonDelayMs > 0) {
      await sleep(this.#lessonDelayMs);
    }
    const behavior =
      this.#lessonBehaviors.length > 1
        ? this.#lessonBehaviors.shift()!
        : this.#lessonBehaviors[0] ?? null;
    if (!behavior) {
      const result = fakeLessonExercises(input);
      return { ...result, exercises: materializeGeneratedCalculations(result.exercises) };
    }
    if ("error" in behavior) {
      const error = new Error(behavior.error) as Error & { retryable?: boolean };
      error.retryable = behavior.retryable;
      throw error;
    }
    if ("invalid" in behavior) {
      // Mieszanka: połowa poprawnych, połowa odrzucanych — dowód odrzuceń pojedynczych.
      const good = fakeLessonExercises(input);
      const bad = input.objectives.map((o) => fakeInvalidExercise(o.id));
      return { exercises: materializeGeneratedCalculations([...good.exercises, ...bad]), examples: good.examples };
    }
    return { exercises: materializeGeneratedCalculations(behavior.exercises), examples: behavior.examples ?? {} };
  }
}

export class FakeTtsProvider implements TtsProvider {
  readonly name = "fake-tts";
  readonly model = "fake-tts-1";
  readonly voice = "fake-voice";
  readonly requests: TtsSynthesizeInput[] = [];
  failuresLeft = 0;
  readonly #delayMs: number;

  constructor(options: { delayMs?: number } = {}) {
    this.#delayMs = options.delayMs ?? 0;
  }

  async synthesize(input: TtsSynthesizeInput): Promise<{ bytes: Uint8Array; mimeType: string }> {
    this.requests.push(input);
    if (this.#delayMs > 0) {
      await sleep(this.#delayMs);
    }
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error("tts unavailable");
    }
    // Instrukcja wchodzi do ziarna tylko, gdy jest podana — bajty bez instrukcji pozostają jak przed wprowadzeniem stylu.
    const instructionsSeed = input.instructions === undefined ? "" : `|${input.instructions}`;
    return {
      bytes: deterministicBytes(`tts|${input.text}|${input.locale}|${input.voice}|${input.format}${instructionsSeed}`),
      mimeType: "audio/mpeg",
    };
  }

  callsFor(text: string): number {
    return this.requests.filter((r) => r.text === text).length;
  }
}

export class FakeImageProvider implements ImageProvider {
  readonly name = "fake-image";
  readonly model = "fake-image-1";
  failuresLeft = 0;
  readonly requests: Array<{
    prompt: string;
    model: string;
    size: string;
    quality: string;
    format: string;
  }> = [];
  readonly #delayMs: number;
  readonly #output?: { bytes: Uint8Array; mimeType: string };

  constructor(options: { delayMs?: number; output?: { bytes: Uint8Array; mimeType: string } } = {}) {
    this.#delayMs = options.delayMs ?? 0;
    this.#output = options.output;
  }

  async generate(input: {
    prompt: string;
    model: string;
    size: string;
    quality: string;
    format: string;
  }): Promise<{ bytes: Uint8Array; mimeType: string }> {
    this.requests.push(input);
    if (this.#delayMs > 0) {
      await sleep(this.#delayMs);
    }
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error("image unavailable");
    }
    if (this.#output) return this.#output;
    const mimeType = "image/png";
    return {
      bytes: Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==", "base64")),
      mimeType,
    };
  }
}

/** Fake'owe ustawienia medialne — muszą zgadzać się z fingerprintami fake'ów. */
export const fakeMediaSettings = {
  tts: { provider: "fake-tts", model: "fake-tts-1", voice: "fake-voice", format: "mp3" },
  image: { provider: "fake-image", model: "fake-image-1", size: "512x512", quality: "low", format: "webp" },
} as const;

/**
 * Fake STT zwraca stałą wiarygodną transkrypcję „monday” (pierwsze słowo
 * fake'owego zestawu) — audio nie niesie treści, więc dopasowanie do klucza
 * zadziała dla tego słowa, a dla pozostałych domknie zadanie dopiero druga
 * rozbieżność (SPEC §15.3). Wystarcza do przejścia pełnego cyklu mowy w E2E.
 */
export class FakeSttProvider implements SttProvider {
  readonly name = "fake-stt";
  async transcribe(): Promise<{ status: "ok"; text: string; confidence: number }> {
    return { status: "ok", text: "monday", confidence: 0.9 };
  }
}

/** Fake oceny wymowy: wysoki wynik i fonemy zgrane z grupami liter. */
export class FakePronunciationProvider implements PronunciationProvider {
  readonly name = "fake-pron";
  async assess(_audio: AudioInput, expectedText: string): Promise<PronunciationResult> {
    const word = expectedText.trim().toLowerCase();
    return {
      status: "ok",
      overallScore: 95,
      recognizedText: expectedText,
      words: [
        {
          text: word,
          accuracyScore: 95,
          errorType: null,
          phonemes: letterGroups(word).map((group) => ({ phoneme: group, accuracyScore: 96 })),
        },
      ],
    };
  }
}

/** Zależności ścieżki mowy na fake'ach — tryb bez kluczy (E2E, lokalny smoke). */
/**
 * Fake dyktowania lekcji (tryb E2E bez kluczy): stały polski tekst z wysoką
 * pewnością, deterministyczny i bez zależności od bajtów nagrania.
 */
export class FakeDictationSttProvider implements SttProvider {
  readonly name = "fake-dictation";
  constructor(private readonly result: TranscriptionResult = { status: "ok", text: "Poziomica to linia łącząca punkty o tej samej wysokości.", confidence: 0.97 }) {}
  async transcribe(): Promise<TranscriptionResult> {
    return { ...this.result };
  }
}

export function fakeLessonSpeechDeps(stt: SttProvider = new FakeDictationSttProvider()): LessonSpeechDeps {
  return { stt, publicService: stt.name };
}

export function fakeSpeechDeps(): SpeechDeps {
  return {
    stt: new FakeSttProvider(),
    pronunciation: new FakePronunciationProvider(),
  };
}

/** Komplet zależności generacji na fake'ach dla wskazanego magazynu mediów. */
export function fakeGenerationDeps(
  mediaStore: MediaStore,
  options: { delayMs?: number; lessonDelayMs?: number } = {},
): GenerationDeps {
  return {
    llm: new FakeLlmProvider(options),
    tts: new FakeTtsProvider(options),
    image: new FakeImageProvider(options),
    mediaStore,
  };
}

/**
 * Zachowanie fake gradera dla jednej odpowiedzi (po znormalizowanej treści albo
 * domyślne). `raw` to surowy obiekt zwracany przez provider (jak prawdziwy
 * adapter — walidacja w domenie), więc test może podać też kształt niepoprawny
 * (invalid JSON / kategoria spoza listy). `delayMs` symuluje opóźnienie modelu;
 * `error` symuluje awarię HTTP/sieci (moduł zamieni na `unevaluated`).
 */
export type FakeGraderBehavior =
  | { raw: unknown; delayMs?: number }
  | { error: string; delayMs?: number };

/**
 * Deterministyczny fake modelu oceniającego dla integracji/E2E: liczy wywołania
 * i mapuje znormalizowaną (naiwnie: lowercase + trim) odpowiedź dziecka na
 * zaprogramowany surowy werdykt. Bez zachowania → werdykt `correct`. Tryb
 * E2E może włączyć prosty routing po słowach kluczowych w odpowiedzi.
 */
export class FakeAnswerGrader implements AnswerGraderProvider {
  readonly name = "fake-grader";
  readonly model = "fake-grader-1";
  readonly promptVersion: string;
  readonly requests: GraderInput[] = [];
  #byAnswer = new Map<string, FakeGraderBehavior>();
  #default: FakeGraderBehavior | null = null;
  #keywordRouting = false;

  constructor(options: { promptVersion?: string; keywordRouting?: boolean } = {}) {
    this.promptVersion = options.promptVersion ?? "fake-grader-v1";
    this.#keywordRouting = options.keywordRouting ?? false;
  }

  /** Programuje werdykt dla konkretnej (surowej) odpowiedzi dziecka. */
  onAnswer(childAnswer: string, behavior: FakeGraderBehavior): this {
    this.#byAnswer.set(childAnswer.trim().toLowerCase(), behavior);
    return this;
  }

  /** Werdykt domyślny, gdy brak dopasowania po odpowiedzi. */
  onDefault(behavior: FakeGraderBehavior): this {
    this.#default = behavior;
    return this;
  }

  promptVersionForInput(input: GraderInput): string {
    return input.school ? "fake-school-grader-v3" : this.promptVersion;
  }

  get callCount(): number {
    return this.requests.length;
  }

  async grade(input: GraderInput, signal: AbortSignal): Promise<unknown> {
    this.requests.push(input);
    const key = input.childAnswer.trim().toLowerCase();
    const behavior = this.#byAnswer.get(key) ?? this.#default ?? (input.school ? this.#schoolVerdict(input) : this.#keywordVerdict(input));
    if (behavior.delayMs && behavior.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, behavior.delayMs);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    if ("error" in behavior) {
      throw new Error(behavior.error);
    }
    return behavior.raw;
  }

  /**
   * Routing po słowach kluczowych (E2E bez konfiguracji per odpowiedź): odpowiedź
   * zawierająca „almost” → almost z pierwszym tokenem jako fragment; „wrong” →
   * incorrect z pierwszą kategorią celu; inaczej correct.
   */
/**
   * Heurystyka fake dla ścieżki szkolnej: element trafiony, gdy większość jego
   * dłuższych słów występuje w odpowiedzi. Tylko do testów integracyjnych —
   * jakość ocenia ewaluacja na prawdziwym modelu, nie ten fake.
   */
  #schoolVerdict(input: GraderInput): FakeGraderBehavior {
    const school = input.school!;
    const answerTokens = new Set(
      input.childAnswer.toLowerCase().normalize("NFC").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3),
    );
    const matchedElementIds: string[] = [];
    const missingElementIds: string[] = [];
    const elementWords = new Set<string>();
    for (const element of school.requiredElements) {
      const words = element.text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
      for (const word of words) elementWords.add(word);
      const hits = words.filter((w) => answerTokens.has(w)).length;
      (words.length > 0 && hits / words.length >= 0.5 ? matchedElementIds : missingElementIds).push(element.id);
    }
    const knowledge = missingElementIds.length === 0 ? "correct" : matchedElementIds.length > 0 ? "partial" : "incorrect";
    const verbose = input.childAnswer.length > 200;
    // Rozwlekła odpowiedź: do usunięcia są zdania bez żadnego słowa elementów
    // wymaganych (dokładne podciągi odpowiedzi, więc trener precyzji może je
    // zaznaczyć). Zdanie z rdzeniem słowa pytania lub odpowiedzi wzorcowej jest
    // „poprawne, ale zbędne”, inne — „nie na temat” (v3, design §9.1).
    const words = (text: string) => text.toLowerCase().normalize("NFC").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
    const topicStems = new Set([...words(school.question), ...words(school.modelAnswer)].map((w) => w.slice(0, 5)));
    const extra = verbose
      ? input.childAnswer.split(/(?<=[.!?])\s+/u).map((sentence) => sentence.trim()).filter((sentence) =>
          sentence.length > 0 && !words(sentence).some((word) => elementWords.has(word))).slice(0, 4)
      : [];
    const onTopic = (sentence: string) => words(sentence).some((word) => topicStems.has(word.slice(0, 5)));
    return {
      raw: {
        knowledge,
        precision: verbose ? "verbose" : "concise",
        matchedElementIds,
        missingElementIds,
        incorrectStatements: [],
        redundantFragments: extra.filter(onTopic),
        offTopicFragments: extra.filter((sentence) => !onTopic(sentence)),
        confusedConcepts: [],
        note: "fake",
      },
    };
  }

  #keywordVerdict(input: GraderInput): FakeGraderBehavior {
    if (!this.#keywordRouting) {
      return { raw: { verdict: "correct", errorCategory: null, fragments: [], note: "ok" } };
    }
    const answer = input.childAnswer;
    const firstToken = answer.trim().split(/\s+/)[0] ?? answer;
    if (/almost/i.test(answer)) {
      return { raw: { verdict: "almost", errorCategory: null, fragments: [firstToken], note: "almost" } };
    }
    if (/wrong/i.test(answer)) {
      const category = input.objective.errorCategories[0]?.code ?? "other";
      return { raw: { verdict: "incorrect", errorCategory: category, fragments: [firstToken], note: "wrong" } };
    }
    return { raw: { verdict: "correct", errorCategory: null, fragments: [], note: "ok" } };
  }
}
/** Zależności gradera na fake'u — do integracji i trybu UMIEM_FAKE_PROVIDERS. */
export function fakeGraderDeps(
  options: { provider?: FakeAnswerGrader; maxCallsPerSession?: number; timeoutMs?: number } = {},
): { provider: FakeAnswerGrader; maxCallsPerSession: number; timeoutMs: number } {
  return {
    provider: options.provider ?? new FakeAnswerGrader(),
    maxCallsPerSession: options.maxCallsPerSession ?? 20,
    timeoutMs: options.timeoutMs ?? 8000,
  };
}

/**
 * Zachowanie fake oceny aktywności sesji: surowy wynik, awaria albo opóźnienie
 * (symulacja timeoutu 20 s — moduł domeny przerywa wywołanie).
 */
export type FakeSessionActivityBehavior =
  | { raw: unknown; delayMs?: number }
  | { error: string; delayMs?: number };

/**
 * Deterministyczny fake `SessionActivityReviewer`: liczy wywołania i zwraca
 * zaprogramowany surowy wynik (walidację robi domena). Bez zachowania stosuje
 * heurystykę: wyklucza zadania, których JEDYNE wysłane odpowiedzi tekstowe są
 * identyczne, krótkie i nie należą do wariantów poprawnych (wzorzec „aaa”).
 */
export class FakeSessionActivityReviewer implements SessionActivityReviewer {
  readonly name = "fake-session-activity";
  readonly model = "fake-session-activity-1";
  readonly promptVersion = "fake-session-activity-v1";
  readonly requests: Array<{ tasks: readonly SessionActivityReviewTask[] }> = [];
  #behaviors: FakeSessionActivityBehavior[] = [];

  queue(...behaviors: FakeSessionActivityBehavior[]): void {
    this.#behaviors = behaviors;
  }

  promptVersionForInput(input: GraderInput): string {
    return input.school ? "fake-school-grader-v3" : this.promptVersion;
  }

  get callCount(): number {
    return this.requests.length;
  }

  async review(input: { tasks: readonly SessionActivityReviewTask[] }, signal: AbortSignal): Promise<unknown> {
    this.requests.push(input);
    const behavior = this.#behaviors.length > 1 ? this.#behaviors.shift()! : this.#behaviors[0] ?? null;
    if (behavior?.delayMs && behavior.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, behavior.delayMs);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    if (behavior && "error" in behavior) {
      throw new Error(behavior.error);
    }
    if (behavior) {
      return behavior.raw;
    }
    const excludedTasks = input.tasks
      .filter((task) => {
        const answers = task.submittedAnswers.filter((answer) => answer.text !== null && !answer.uncertain);
        if (answers.length === 0 || answers.some((answer) => answer.modality !== "text")) return false;
        const texts = [...new Set(answers.map((answer) => answer.text!.trim().toLowerCase()))];
        if (texts.length !== 1) return false;
        const text = texts[0]!;
        const accepted = task.acceptedAnswers.map((answer) => answer.trim().toLowerCase());
        return text.length <= 3 && !accepted.includes(text) && !accepted.includes(task.stimulus?.trim().toLowerCase() ?? "\u0000");
      })
      .map((task) => ({
        taskOrdinal: task.taskOrdinal,
        reason: `Jedyna odpowiedź to „${task.submittedAnswers[0]?.text ?? ""}”, niezwiązana z poleceniem.`,
      }));
    return {
      reason: excludedTasks.length > 0
        ? "Część zadań zawierała wyłącznie odpowiedzi niezwiązane z poleceniami."
        : "Próby są związane z zadaniami.",
      excludedTasks,
    };
  }
}

/** Zależności oceny aktywności na fake'u — do integracji i trybu UMIEM_FAKE_PROVIDERS. */
export function fakeSessionActivityDeps(
  options: { provider?: FakeSessionActivityReviewer; timeoutMs?: number } = {},
): SessionActivityDeps {
  return {
    provider: options.provider ?? new FakeSessionActivityReviewer(),
    timeoutMs: options.timeoutMs ?? 20_000,
  };
}
