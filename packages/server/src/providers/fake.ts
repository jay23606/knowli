import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type { GenerationDeps, LessonSpeechDeps, SessionActivityDeps, SpeechDeps } from "../config";
import type {
  AnswerGraderProvider,
  AudioInput,
  GraderInput,
  ImageProvider,
  LessonObjectivesInput,
  LessonStoryInput,
  LlmGeneratedItem,
  LlmGenerateDeckInput,
  LlmProvider,
  PronunciationProvider,
  PronunciationResult,
  RunCostSink,
  SessionActivityReviewTask,
  SessionActivityReviewer,
  SttProvider,
  TranscriptionResult,
  TtsProvider,
  TtsSynthesizeInput,
} from "../ports/ai";
import type { MediaStore } from "../ports/media";
import { letterGroups } from "../domain/pronunciation-fragments";
import { FUNCTION_WORDS } from "../domain/lessons/subjects/english/function-words";
import { isMaterialVocabularyTarget, materialPhraseIndex } from "../domain/lessons/subjects/english/material-phrase";
import { normalizeTokens } from "../domain/lessons/normalize";

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

/**
 * Bramka testów E2E (`UMIEM_FAKE_HOLD_FILE`): dopóki plik istnieje, fake
 * generowanie słówek, TTS i ilustracji czeka. Test, który sprawdza przejściowy
 * stan „generowanie”, tworzy plik przed akcją i usuwa go po asercji — zamiast
 * ścigać się ze sztucznym opóźnieniem wszystkich wywołań. Plik starszy niż
 * FAKE_HOLD_MAX_AGE_MS jest ignorowany: po awarii procesu testu (bez
 * afterEach) kolejne testy świata nie wiszą do swoich limitów czasu.
 */
export const FAKE_HOLD_MAX_AGE_MS = 120_000;

export async function waitWhileFakeHeld(holdFile: string | undefined, now: () => number = Date.now): Promise<void> {
  if (holdFile === undefined) return;
  for (;;) {
    const stat = statSync(holdFile, { throwIfNoEntry: false });
    if (stat === undefined || now() - stat.mtimeMs > FAKE_HOLD_MAX_AGE_MS) return;
    await sleep(50);
  }
}

/** Opcje fake providerów: sztuczne opóźnienia i bramka E2E. */
export interface FakeProviderOptions {
  delayMs?: number;
  lessonDelayMs?: number;
  holdFile?: string;
}

export type LlmBehavior =
  | { items: Array<Record<string, unknown>> }
  | { error: string; retryable: boolean };

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
    };
  });
  // Przykładowy ton pierwszej karty (etap B): tylko gdy generator ma go zwracać.
  if (input.voiceTones === true) {
    const cards = objectives[0]?.cards as Record<string, unknown>[] | undefined;
    if (cards?.[0]) cards[0] = { ...cards[0], voiceTone: "cheerful" };
  }
  return objectives;
}

export class FakeLlmProvider implements LlmProvider {
  readonly name = "fake-llm";
  readonly model = "fake-llm-1";
  readonly requests: LlmGenerateDeckInput[] = [];
  readonly objectiveRequests: LessonObjectivesInput[] = [];
  readonly storyRequests: LessonStoryInput[] = [];
  #behaviors: LlmBehavior[] = [];
  readonly #delayMs: number;
  readonly #lessonDelayMs: number;
  readonly #holdFile: string | undefined;

  constructor(options: FakeProviderOptions = {}) {
    this.#delayMs = options.delayMs ?? 0;
    this.#lessonDelayMs = options.lessonDelayMs ?? this.#delayMs;
    this.#holdFile = options.holdFile;
  }

  /** Zastępuje plan zachowań: kolejne wywołania zjadają elementy z kolejki, ostatni się powtarza. */
  queue(...behaviors: LlmBehavior[]): void {
    this.#behaviors = behaviors;
  }

  async generateDeck(input: LlmGenerateDeckInput): Promise<{ items: LlmGeneratedItem[] }> {
    this.requests.push(input);
    if (this.#delayMs > 0) {
      await sleep(this.#delayMs);
    }
    await waitWhileFakeHeld(this.#holdFile);
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

  async generateLessonStory(input: LessonStoryInput): Promise<{ story: unknown }> {
    this.storyRequests.push(input);
    if (this.#lessonDelayMs > 0) {
      await sleep(this.#lessonDelayMs);
    }
    return {
      story: {
        sentences: ["Sam has a red bike.", "He rides it to the park.", "The bike is fast and shiny.", "Sam is very happy."],
        questions: [
          { question: "Jaki rower ma Sam?", options: ["czerwony", "niebieski", "zielony"], correctOptionIndex: 0 },
        ],
      },
    };
  }
}

export class FakeTtsProvider implements TtsProvider {
  readonly name = "fake-tts";
  readonly model = "fake-tts-1";
  readonly voice = "fake-voice";
  readonly requests: TtsSynthesizeInput[] = [];
  failuresLeft = 0;
  readonly #delayMs: number;
  readonly #holdFile: string | undefined;

  constructor(options: FakeProviderOptions = {}) {
    this.#delayMs = options.delayMs ?? 0;
    this.#holdFile = options.holdFile;
  }

  async synthesize(input: TtsSynthesizeInput): Promise<{ bytes: Uint8Array; mimeType: string }> {
    this.requests.push(input);
    if (this.#delayMs > 0) {
      await sleep(this.#delayMs);
    }
    await waitWhileFakeHeld(this.#holdFile);
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
  readonly #holdFile: string | undefined;
  readonly #output?: { bytes: Uint8Array; mimeType: string };

  constructor(options: FakeProviderOptions & { output?: { bytes: Uint8Array; mimeType: string } } = {}) {
    this.#delayMs = options.delayMs ?? 0;
    this.#holdFile = options.holdFile;
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
    await waitWhileFakeHeld(this.#holdFile);
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
  options: FakeProviderOptions = {},
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
  #costUsd: number | null;

  /** `costUsd` to koszt zgłaszany do `RunCostSink` raz na wywołanie (testy budżetu agenta); `null` = nieznany. */
  constructor(options: { promptVersion?: string; keywordRouting?: boolean; costUsd?: number | null } = {}) {
    this.promptVersion = options.promptVersion ?? "fake-grader-v1";
    this.#keywordRouting = options.keywordRouting ?? false;
    this.#costUsd = options.costUsd === undefined ? 0.0005 : options.costUsd;
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

  async grade(input: GraderInput, signal: AbortSignal, cost?: RunCostSink): Promise<unknown> {
    this.requests.push(input);
    cost?.record(this.#costUsd);
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
