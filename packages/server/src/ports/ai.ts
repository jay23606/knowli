/**
 * Porty dostawców AI. SDK żyje wyłącznie w adapterach za tymi interfejsami;
 * domena i moduły nie znają Azure/OpenAI. Sygnał przerwania przekazuje worker.
 */

/**
 * Wejście generacji zestawu słówek. Tryb „z opisu”: `prompt` rodzica, model
 * dobiera słowa do tematu. Tryb ze źródła (design 2026-10-30 §6.2): tekst źródła
 * w `material` i opcjonalne zawężenie `instruction` — model ma wypisać wyłącznie
 * słowa z tekstu, ale gwarancją jest walidacja per element w module generacji.
 */
export type LlmGenerateDeckInput = {
  sourceLocale: string;
  targetLocale: string;
  maxItems: number;
  vocabularyFormat?: "standard" | "picture";
} & ({ prompt: string } | { material: string; instruction?: string });

/** Surowy element od LLM; moduł generacji waliduje go Zodem przed zapisem. */
export interface LlmGeneratedItem {
  source: string;
  target: string;
  acceptedAnswers: string[];
  example?: string;
  visualType: "image" | "color" | "number" | "sequence" | "none";
  visualData?: Record<string, unknown>;
}

/**
 * Wejście generacji puli lekcji (design „Generowanie puli (worker)”). Port nie
 * zna żadnego przedmiotu ani gramatyki — dostaje opis przedmiotu, celów,
 * dozwolone typy i materiał jako zwykłe dane, a adapter składa z nich prompt.
 * Przedmiot opisany polami (`subjectTitle`, `promptProfile`, `answerLocale`,
 * `promptLocale`, `exerciseTypes`, `transforms`), nie obiektem `SubjectModule`,
 * żeby adapter nie zależał od domeny lekcji.
 */
export interface LlmLessonObjectiveInput {
  readonly id: string;
  readonly descriptionEn: string;
  readonly exerciseTypes: readonly string[];
  readonly errorCategories: readonly string[];
}

export interface LlmLessonTransformInput {
  readonly id: string;
  readonly instructionPl: string;
}

export interface LlmPromptProfileInput {
  readonly generationRole: string;
  readonly gradingRole: string;
  readonly almostDefinition: string;
  /** Dziedzinowe reguły semantyki pól ćwiczeń (opcjonalne, od przedmiotu). */
  readonly fieldRules?: string;
  /** Semantyka typów par, grup i luk (opcjonalna, od przedmiotu); adapter dokłada ją do części strukturalnej bloku. */
  readonly typeRules?: Partial<Record<"lesson_match" | "lesson_group" | "lesson_cloze", string>>;
  /** Reguła użycia tematów zdań (opcjonalna, od przedmiotu); adapter dokłada ją do promptu systemowego tylko razem z `interests`. */
  readonly interestsRule?: string;
}

/** Ile ćwiczeń danego etapu wygenerować dla jednego celu (partia per cel). */
export interface LlmLessonStageCounts {
  readonly guided: number;
  readonly productive: number;
  readonly independent: number;
}

export interface LessonPoolInput {
  readonly subjectId: string;
  readonly subjectTitle: string;
  readonly answerLocale: string;
  readonly promptLocale: string;
  readonly promptProfile: LlmPromptProfileInput;
  /** Typy wspierane przez przedmiot (ograniczenie dla modelu). */
  readonly exerciseTypes: readonly string[];
  /** Przekształcenia dostępne w temacie (dla `lesson_transform`). */
  readonly transforms: readonly LlmLessonTransformInput[];
  /** Cele tej partii — zwykle jeden (generacja per cel). */
  readonly objectives: readonly LlmLessonObjectiveInput[];
  readonly material: string;
  readonly instruction?: string;
  /** Tematy zdań z zainteresowań dziecka (dane od rodzica); adapter wstawia je do wiadomości użytkownika tylko przy `promptProfile.interestsRule`. */
  readonly interests?: readonly string[];
  /** Łączna liczba ćwiczeń per cel i jej rozkład na etapy. */
  readonly countPerObjective: number;
  readonly stageCounts: LlmLessonStageCounts;
  /**
   * Ile DODATKOWYCH ćwiczeń `lesson_listen_choice` (0–2) wolno wygenerować na cel partii: leżą poza
   * podziałem etapów i poza `countPerObjective`, a prompt podnosi o nie limit partii. Brak pola = adapter
   * nie prosi o ten typ (przedmiot bez nagrań zdań albo cel bez typu na liście).
   */
  readonly listenChoicePerObjective?: number;
  /** Ile miejsc etapu samodzielnego zastrzec dla różnych pytań otwartych (przedmioty v3). */
  readonly minDistinctOpenAnswers?: number;
  readonly graderAvailable: boolean;
  /** Czy każde ćwiczenie MUSI nieść cytaty źródłowe z materiału (przedmioty z uziemieniem). */
  readonly groundingRequired?: boolean;
  /** Tożsamość duplikatu w obrębie puli; domyślnie zgodność odpowiedzi. */
  readonly deduplication?: "answer" | "exercise";
  /** Odpowiedzi już w puli (dla dogenerowania bez duplikatów). */
  readonly existingAnswers?: readonly string[];
  /** Bodźce już w puli, używane gdy przedmiot deduplikuje całe ćwiczenia. */
  readonly existingExercises?: readonly { objectiveId: string; exerciseType: string; stimulus: string }[];
  /** Czy generator ma zwracać `voiceTone` ćwiczenia (przedmiot z `ttsForPrompts`); bez flagi schemat i prompt nie mają pola. */
  readonly voiceTones?: boolean;
}

/**
 * Wejście generacji zagadnień tematu dynamicznego (przedmioty szkolne):
 * model wyprowadza z materiału cele nauki z kartami. Zwraca surowe obiekty;
 * kształt i semantykę waliduje serwer (Zod + reguły katalogu).
 */
export interface LessonObjectivesInput {
  readonly subjectTitle: string;
  readonly topicTitle: string;
  readonly material: string;
  readonly instruction?: string;
  readonly generationRole: string;
  /** Czy karty zagadnień niosą `voiceTone` (przedmiot z `ttsForPrompts`); bez flagi schemat i prompt nie mają pola. */
  readonly voiceTones?: boolean;
  /** Reguły przedmiotu dla podziału materiału na zagadnienia (opcjonalne). */
  readonly objectivesRules?: string;
}
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generateDeck(
    input: LlmGenerateDeckInput,
    signal?: AbortSignal,
  ): Promise<{ items: LlmGeneratedItem[] }>;
  generateLessonObjectives(
    input: LessonObjectivesInput,
    signal?: AbortSignal,
  ): Promise<{ objectives: unknown[] }>;
  /**
   * Generacja surowej puli ćwiczeń jednego celu (design „Generowanie puli”).
   * Zwraca ćwiczenia do walidacji w domenie (`pool-validation.ts`) oraz
   * przykłady per cel do kart lekcji. Adapter materializuje surowe parametry
   * lesson_calculation do kanonicznego prompt/answer przed wspólną walidacją;
   * wadliwe rekordy pozostawia do indywidualnego odrzucenia.
   */
  generateLessonPool(
    input: LessonPoolInput,
    signal?: AbortSignal,
  ): Promise<{ exercises: unknown[]; examples: Record<string, string[]> }>;
}

/** `wav` = PCM od providera opakowane w WAV (Gemini TTS); `mp3` = gotowy plik providera. */
export type TtsFormat = "mp3" | "wav";

export interface TtsSynthesizeInput {
  text: string;
  locale: string;
  voice: string;
  format: TtsFormat;
  /** Model zapisany w zasobie (fingerprint); brak = model adaptera. */
  model?: string;
  /** Instrukcja wymowy zapisana w zasobie (np. język); nie jest czytana na głos. */
  instructions?: string;
}

export interface TtsProvider {
  readonly name: string;
  readonly model: string;
  synthesize(
    input: TtsSynthesizeInput,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

export interface ImageGenerateInput {
  prompt: string;
  model: string;
  size: string;
  quality: string;
  format: string;
}

export interface ImageProvider {
  readonly name: string;
  readonly model: string;
  generate(
    input: ImageGenerateInput,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

/**
 * Krótkotrwałe nagranie dziecka (arch §11). Bajty żyją wyłącznie w pamięci
 * żądania: nie trafiają do bazy, kolejki, plików ani logów.
 */
export interface AudioInput {
  bytes: Uint8Array;
  mimeType: string;
  /** Wariant języka nagrania, np. „en-GB” — serwer nadpisze wartością zestawu. */
  locale: string;
}

/**
 * Wynik zwykłego STT — rozpoznanie treści, nie ocena wymowy (SPEC §23).
 * Wyniki muszą umieć reprezentować brak wiarygodnego rozpoznania: zero ani
 * pusty tekst nie zastępują informacji o ciszy czy awarii.
 */
export interface TranscriptionResult {
  status: "ok" | "no_speech" | "failed";
  text: string | null;
  /** Pewność 0–1, gdy provider ją zwraca; null = usługa jej nie podaje. */
  confidence: number | null;
}

/** Pojedynczy fonem oceny wymowy (Azure, Granularity Phoneme). */
export interface PronunciationPhoneme {
  phoneme: string;
  accuracyScore: number | null;
}

/** Jedno słowo oceny wymowy z fonemami; ErrorType null = bez zastrzeżeń. */
export interface PronunciationWord {
  text: string;
  accuracyScore: number | null;
  errorType: string | null;
  phonemes: PronunciationPhoneme[];
}

/** Wynik oceny wymowy względem JEDNEGO oczekiwanego tekstu (SPEC §23). */
export interface PronunciationResult {
  status: "ok" | "no_speech" | "failed";
  /** Wynik ogólny w skali providera; null przy ciszy, awarii i niepewności. */
  overallScore: number | null;
  /** Tekst rozpoznany przez usługę wymowy — odrębny od transkrypcji STT. */
  recognizedText: string | null;
  /** Szczegóły fonemów, jeśli provider je zwraca. */
  words?: PronunciationWord[];
}

export interface SttProvider {
  readonly name: string;
  transcribe(audio: AudioInput, signal?: AbortSignal): Promise<TranscriptionResult>;
}

/**
 * Wejście modelu oceniającego (design „Model oceniający”, `GraderInput`). Port
 * nie zna gramatyki ani przedmiotu — adapter dostaje gotowe fragmenty profilu
 * przedmiotu, polecenie, bodziec, opis celu z kategoriami oraz odpowiedź
 * dziecka JAKO DANE. Odpowiedź dziecka trafia wyłącznie do wiadomości `user`;
 * nigdy do promptu systemowego ani do logów.
 */
export interface GraderInput {
  readonly subjectTitle: string;
  readonly topicTitle: string;
  readonly roleProfile: {
    readonly gradingRole: string;
    readonly almostDefinition: string;
  };
  readonly instruction: string;
  readonly stimulus: string | null;
  readonly objective: {
    readonly description: string;
    readonly errorCategories: readonly { readonly code: string; readonly label: string }[];
  };
  /** Zatwierdzone warianty poprawnej odpowiedzi (dane referencyjne). */
  readonly acceptedAnswers: readonly string[];
  /** Odpowiedź dziecka przekazywana jako dane: ≤ 200 znaków (lekcje), ≤ 600 (odpowiedzi szkolne). */
  readonly childAnswer: string;
  /**
   * Dane ścieżki szkolnej (Etap 2): elementy wymagane ćwiczenia, forma i cytaty
   * źródłowe. Obecność przełącza adapter na werdykt dwuwymiarowy i prompt
   * `school-grader-v3` (design §9.1); brak = dotychczasowy werdykt v1.
   */
  readonly school?: {
    readonly question: string;
    readonly modelAnswer: string;
    readonly requiredElements: readonly { readonly id: string; readonly text: string }[];
    readonly supplementaryElements: readonly string[];
    /** Typowe błędne odpowiedzi/stwierdzenia (dane referencyjne oceny). */
    readonly commonErrors: readonly string[];
    readonly expectedForm: string;
    readonly sourceQuotes: readonly string[];
  };
}

/**
 * Model oceniający zgodny z OpenAI (design „Model oceniający”). Zwraca SUROWY
 * obiekt JSON — walidację robi domena (`validateVerdict`), żeby adapter nie
 * interpretował treści. `promptVersion` jest stałą adaptera i wchodzi do klucza
 * cache werdyktów (zmiana promptu unieważnia zapisane werdykty).
 */
export interface AnswerGraderProvider {
  readonly name: string;
  readonly model: string;
  readonly promptVersion: string;
  /** Wersja promptu dla konkretnego wejścia (szkoła/grupa); brak = `promptVersion`. */
  promptVersionForInput?(input: GraderInput): string;
  grade(input: GraderInput, signal: AbortSignal): Promise<unknown>;
}

/**
 * Jedno zadanie w wejściu oceny aktywności sesji (spec client-reward-time).
 * Zadania i odpowiedzi pochodzą z bazy serwera, ponumerowane ordinalami —
 * model nie dostaje imion dziecka, identyfikatorów ani kluczy transportowych.
 */
export interface SessionActivityReviewTask {
  readonly taskOrdinal: number;
  /** Instrukcja/bodziec ćwiczenia jako dane (tekst widoczny dla dziecka). */
  readonly instruction: string;
  readonly stimulus: string | null;
  readonly options: readonly string[];
  readonly acceptedAnswers: readonly string[];
  /** Faktycznie wysłane odpowiedzi; `uncertain` oznacza niepewne rozpoznanie STT. */
  readonly submittedAnswers: readonly {
    readonly modality: string;
    readonly text: string | null;
    readonly uncertain: boolean;
    /** Czy przed tą próbą ujawniono podpowiedź/odpowiedź (osobna pozycja czasowa). */
    readonly supportDisclosedBefore: boolean;
  }[];
  readonly editCount: number;
  readonly editWindows: readonly { readonly atMs: number; readonly count: number }[];
  readonly playbacks: readonly { readonly fromMs: number; readonly toMs: number }[];
  readonly pauses: readonly { readonly kind: string; readonly fromMs: number; readonly toMs: number }[];
  readonly activeIntervals: readonly (readonly [number, number])[];
}

/**
 * Wąski port oceny aktywności sesji — osobny od `AnswerGraderProvider` i
 * `lesson_verdicts`; bez cache i limitu wywołań odpowiedzi lekcyjnych. Model
 * wskazuje WYŁĄCZNIE zadania bez podstaw do zaliczenia pracy; nie zwraca
 * sekund, punktów ani mnożników. Walidację kształtu robi moduł domeny.
 */
export interface SessionActivityReviewer {
  readonly name: string;
  readonly model: string;
  readonly promptVersion: string;
  review(input: { tasks: readonly SessionActivityReviewTask[] }, signal: AbortSignal): Promise<unknown>;
}

export interface PronunciationProvider {
  readonly name: string;
  assess(
    audio: AudioInput,
    expectedText: string,
    signal?: AbortSignal,
  ): Promise<PronunciationResult>;
}

/**
 * Dowody z jednego nagrania (zadanie 8). Ocena wymowy wykonuje się względem
 * `expectedText`; wyniku nie przenosi się na inny wypowiedziany wariant.
 */
export interface SpeechEvidence {
  sttProvider: string;
  transcription: TranscriptionResult;
  pronunciation: (PronunciationResult & { provider: string; expectedText: string }) | null;
}
