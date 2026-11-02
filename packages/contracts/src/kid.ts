import { z } from "zod";
import { InstantSchema, UuidSchema } from "./common";
import { isVisualDataValid, RecordingModeSchema, VisualTypeSchema } from "./decks";
import { SessionActivityResultDtoSchema } from "./reward-activity";
import { LessonVisualSubjectSchema } from "./lessons";

const visualPromptFields = {
  visualType: VisualTypeSchema.default("none"),
  visualData: z.record(z.string(), z.unknown()).optional(),
};

function validateVisualPrompt(
  prompt: { visualType: z.infer<typeof VisualTypeSchema>; visualData?: Record<string, unknown>; target: string },
  ctx: z.RefinementCtx,
) {
  if (!isVisualDataValid(prompt.visualType, prompt.visualData, prompt.target)) {
    ctx.addIssue({ code: "custom", path: ["visualData"], message: "visualData does not match visualType" });
  }
}

/**
 * Kontrakty Kid API (architecture.md §9). Publiczne DTO nigdy nie zawierają
 * klucza odpowiedzi, kryteriów oceny ani technicznych score'ów — te zostają
 * wyłącznie po stronie serwera w session_tasks.answer_key.
 */

export const EXERCISE_TYPES = [
  "exposure",
  "listening",
  "reading",
  "reverse_recognition",
  "picture_recognition",
  "recall",
  "speech",
  "letter_completion",
  "spelling",
  // Typy lekcji (design „Typy ćwiczeń i etapy”). Dodane jako nowe warianty,
  // zgodność wsteczna istniejących słówek zachowana.
  "lesson_card",
  "lesson_notice",
  "lesson_choice",
  "lesson_order",
  "lesson_short_answer",
  "lesson_gap",
  "lesson_error_fix",
  "lesson_transform",
  "lesson_open_answer",
  "lesson_calculation",
  "lesson_keywords",
  "lesson_match",
  "lesson_group",
  "lesson_cloze",
  "lesson_listen_choice",
] as const;
export type ExerciseTypeDto = (typeof EXERCISE_TYPES)[number];

export const ChoiceOptionSchema = z.object({
  id: UuidSchema,
  text: z.string().min(1),
});
export type ChoiceOption = z.infer<typeof ChoiceOptionSchema>;

export const MeaningVisualSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("image"), imageAssetId: UuidSchema }).strict(),
  z.object({ kind: z.literal("color"), color: z.string().regex(/^#[0-9a-f]{6}$/) }).strict(),
  z.object({ kind: z.literal("number"), count: z.number().int().min(0).max(50) }).strict(),
]);
export type MeaningVisual = z.infer<typeof MeaningVisualSchema>;

export const PictureChoiceOptionSchema = z.object({
  id: UuidSchema,
  labelPl: z.string().min(1),
  visual: MeaningVisualSchema,
}).strict();
export type PictureChoiceOption = z.infer<typeof PictureChoiceOptionSchema>;

/**
 * Język treści zadania lekcji (atrybut `lang` w Kid UI, czytniki ekranu). Tylko
 * języki, w których powstaje materiał; brak pola = klient zachowuje się jak
 * dotąd (starsze serwery go nie wysyłają).
 */
export const LessonContentLocaleSchema = z.enum(["pl-PL", "en-GB"]);
export type LessonContentLocale = z.infer<typeof LessonContentLocaleSchema>;

/**
 * Publiczny element (`lesson_order`, `lesson_match`, `lesson_group`) —
 * identyfikator i widoczny tekst; `.strict()`, by nic z klucza (np. grupa
 * elementu) nie przeszło do dziecka.
 */
export const LessonItemSchema = z.object({
  id: UuidSchema,
  text: z.string().min(1),
}).strict();
export type LessonItem = z.infer<typeof LessonItemSchema>;

/**
 * „Posłuchaj pytania” (design szkoły §11): gotowe nagranie polecenia i pytania
 * z widocznej treści. Odczyt nie jest ujawnieniem — bez zdarzenia i ekspozycji.
 */
const QuestionAudioSchema = UuidSchema.optional();

/**
 * Fragment tekstu „Uzupełnij tekst” (`lesson_cloze`, design szkoły §13.2):
 * tekst albo luka. Serwer tnie tekst na luki, więc klient nie parsuje
 * podkreśleń; numer luki wynika z kolejności.
 */
export const ClozeSegmentSchema = z.union([
  z.object({ text: z.string().min(1) }).strict(),
  z.object({ gapId: UuidSchema }).strict(),
]);
export type ClozeSegment = z.infer<typeof ClozeSegmentSchema>;

/** Segment zdania `lesson_notice` do wskazania — bez informacji, który jest poprawny. */
export const LessonSegmentSchema = z.object({
  id: UuidSchema,
  text: z.string().min(1),
});
export type LessonSegment = z.infer<typeof LessonSegmentSchema>;

/** Fragment zapisu w porównaniu pisowni; `pill` = fragment do wyróżnienia (issue #9). */
export const SpellingDiffSegmentSchema = z.object({
  text: z.string().min(1),
  /**
   * `pill` = fragment do wyróżnienia (w lekcjach szkolnych: poprawny, ale
   * zbędny); `offtopic` = niezwiązany z pytaniem — tylko segmenty odpowiedzi
   * lekcji (design szkoły §9.2), nigdy diff pisowni słówek.
   */
  state: z.enum(["plain", "pill", "offtopic"]),
});
export type SpellingDiffSegmentDto = z.infer<typeof SpellingDiffSegmentSchema>;

/**
 * Najdłuższa odpowiedź pisemna dziecka: odpowiedź otwarta przedmiotu szkolnego
 * trafia do gradera w całości do 600 znaków (gramatyka nadal tylko do 200).
 */
export const MAX_TEXT_ATTEMPT_LENGTH = 600;

/**
 * Dyktowanie odpowiedzi otwartej (design szkoły §5.4): klient pokazuje
 * mikrofon tylko z tym polem. Bez locale, klucza i kryteriów — serwer sam
 * wybiera język nagrania.
 */
export const SpeechInputSchema = z.object({
  maxSeconds: z.number().int().min(5).max(60),
}).strict();
export type SpeechInputDto = z.infer<typeof SpeechInputSchema>;

/**
 * Wynik dyktowania: tekst do pola odpowiedzi albo powód jego braku. Nie jest
 * próbą ani oceną; bez confidence i innych score'ów.
 */
export const DictationDtoSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("heard"), text: z.string().min(1).max(MAX_TEXT_ATTEMPT_LENGTH) }).strict(),
  z.object({ status: z.enum(["no_speech", "uncertain", "too_long", "unavailable"]) }).strict(),
]);
export type DictationDto = z.infer<typeof DictationDtoSchema>;

/** Sposób wprowadzenia odpowiedzi tekstowej; brak = klawiatura. */
export const InputMethodSchema = z.enum(["keyboard", "speech"]);
export type InputMethodDto = z.infer<typeof InputMethodSchema>;

/** Publiczna treść zadania — discriminated union po polu kind = typ ćwiczenia. */
export const TaskPromptSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exposure"),
    source: z.string().min(1),
    target: z.string().min(1),
    example: z.string().nullable(),
    audioAssetId: UuidSchema.nullable(),
    /**
     * Audio zdania przykładowego przygotowane z zestawem (SPEC §22); null, gdy
     * karta nie ma przykładu. Treść zdania jest już widoczna na prezentacji,
     * więc odsłuch nie wymaga osobnej ekspozycji (arch §12).
     */
    exampleAudioAssetId: UuidSchema.nullable(),
    /**
     * Zatwierdzona przez rodzica ilustracja — pomoc wizualna prezentacji
     * (SPEC §12.1, §24); null, gdy karta nie ma obrazu. Bajty przez route
     * media, bez dodatkowej ekspozycji (arch §12).
     */
    imageAssetId: UuidSchema.nullable(),
    ...visualPromptFields,
  }),
  z.object({ kind: z.literal("picture_exposure"), visual: MeaningVisualSchema, audioAssetId: UuidSchema.nullable() }).strict(),
  z.object({
    kind: z.literal("listening"),
    options: z.array(ChoiceOptionSchema).min(1),
    audioAssetId: UuidSchema,
  }),
  z.object({
    kind: z.literal("picture_listening"),
    options: z.array(PictureChoiceOptionSchema).min(2).max(4),
    audioAssetId: UuidSchema,
  }).strict(),
  z.object({ kind: z.literal("picture_recall"), visual: MeaningVisualSchema }).strict(),
  z.object({
    kind: z.literal("picture_recognition"),
    /**
     * Wizualizacja znaczenia (obraz/kolor/liczba) — zatwierdzona z przygotowaniem
     * materiału. Prompt nie niesie audio angielskiego słowa (SPEC A07): próba
     * pozostaje czystym rozpoznawaniem wzrokowym, a odsłuch poprawnej opcji
     * ujawnia serwer dopiero w feedbacku (`correctAudioAssetId`).
     */
    visual: MeaningVisualSchema,
    /** Polskie słowo źródłowe jako mały podpis pod obrazkiem (np. „koń”). */
    source: z.string().min(1),
    /** Angielskie słowa: jedno poprawne + dystraktory, unikalne teksty (SPEC §13). */
    options: z.array(ChoiceOptionSchema).min(2).max(4),
  }).strict(),
  z.object({
    kind: z.literal("reading"),
    text: z.string().min(1),
    options: z.array(ChoiceOptionSchema).min(1),
  }),
  z.object({
    kind: z.literal("reverse_recognition"),
    prompt: z.string().min(1),
    options: z.array(ChoiceOptionSchema).min(1),
  }),
  z.object({ kind: z.literal("recall"), prompt: z.string().min(1) }),
  z.object({ kind: z.literal("spelling"), prompt: z.string().min(1) }),
  z.object({
    kind: z.literal("letter_completion"),
    prompt: z.string().min(1),
    fragment: z.string().min(1),
  }),
  z.object({
    kind: z.literal("speech"),
    text: z.string().min(1),
    audioAssetId: UuidSchema.nullable(),
    /** Ilustracja karty; cel i tak jest widoczny w treści zadania (SPEC §24). */
    imageAssetId: UuidSchema.nullable(),
    ...visualPromptFields,
  }),
  z.object({ kind: z.literal("picture_speech"), visual: MeaningVisualSchema, audioAssetId: UuidSchema.nullable() }).strict(),
  // Gałęzie lekcji (design „Typy ćwiczeń i etapy” — kolumna Kid prompt).
  // KAŻDA jest `.strict()`: Kid DTO nigdy nie zawiera odpowiedzi, wariantów,
  // elementu sprawdzanego (`focus`), celu ani kategorii błędu. `audioAssetId`
  // (TTS odpowiedzi kanonicznej) jest OPCJONALNE WYŁĄCZNIE przy typach
  // tekstowych (`lesson_gap`/`error_fix`/`transform`/`open_answer`), gdzie —
  // zgodnie z wym. 4.6 i design.md „Odsłuch w zadaniach tekstowych lekcji =
  // wsparcie” — odsłuch zdania wzorcowego PRZED odpowiedzią jest dozwolonym
  // wsparciem (ekspozycja pieczętowana, próba niesamodzielna). Typy zamknięte
  // (`notice`/`choice`/`short_answer`/`order`) NIE niosą audio: odtworzenie
  // kanonicznej odpowiedzi zdradziłoby właściwą opcję/kolejność i obeszłoby
  // deterministyczną ocenę po identyfikatorach (wym. 4.3).
  z.object({
    kind: z.literal("lesson_card"),
    card: z.object({
      title: z.string().min(1),
      body: z.string().min(1),
      examples: z.array(z.string().min(1)),
    }).strict(),
    // „Posłuchaj karty” (design szkoły §12.3): nagranie widocznej treści karty.
    questionAudioAssetId: QuestionAudioSchema,
  }).strict(),
  z.object({
    kind: z.literal("lesson_notice"),
    instructionPl: z.string().min(1),
    segments: z.array(z.array(LessonSegmentSchema).min(1)).min(1),
  }).strict(),
  z.object({
    kind: z.literal("lesson_choice"),
    visualSubject: LessonVisualSubjectSchema.optional(),
    instructionPl: z.string().min(1),
    stem: z.string().min(1),
    options: z.array(ChoiceOptionSchema).min(1),
    /** Język treści zadania (przedmiot ma jeden język odpowiedzi); brak = bez atrybutu `lang`. */
    contentLocale: LessonContentLocaleSchema.optional(),
    questionAudioAssetId: QuestionAudioSchema,
  }).strict(),
  // „Posłuchaj i wybierz” (#198): zdanie z luką czyta lektor, a polecenie dziecka
  // pochodzi z katalogu komunikatów — prompt nie niesie `instructionPl` ani id nagrania
  // (nagranie bodźca odsłania serwer osobną ścieżką po rejestracji ekspozycji).
  z.object({
    kind: z.literal("lesson_listen_choice"),
    stem: z.string().min(1),
    options: z.array(ChoiceOptionSchema).min(1),
    /** Język treści zadania; brak = bez atrybutu `lang`. */
    contentLocale: LessonContentLocaleSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("lesson_order"),
    instructionPl: z.string().min(1),
    items: z.array(LessonItemSchema).min(1),
    /** Język treści zadania (przedmiot ma jeden język odpowiedzi); brak = bez atrybutu `lang`. */
    contentLocale: LessonContentLocaleSchema.optional(),
    questionAudioAssetId: QuestionAudioSchema,
  }).strict(),
  z.object({
    kind: z.literal("lesson_short_answer"),
    question: z.string().min(1),
    options: z.array(ChoiceOptionSchema).min(1),
  }).strict(),
  z.object({
    kind: z.literal("lesson_gap"),
    instructionPl: z.string().min(1),
    stemWithGap: z.string().min(1),
    hint: z.string().min(1).optional(),
    audioAssetId: UuidSchema.optional(),
    /** Język treści zadania (przedmiot ma jeden język odpowiedzi); brak = bez atrybutu `lang`. */
    contentLocale: LessonContentLocaleSchema.optional(),
    questionAudioAssetId: QuestionAudioSchema,
  }).strict(),
  z.object({
    kind: z.literal("lesson_error_fix"),
    instructionPl: z.string().min(1),
    statement: z.string().min(1),
    audioAssetId: UuidSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("lesson_transform"),
    instructionPl: z.string().min(1),
    statement: z.string().min(1),
    audioAssetId: UuidSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("lesson_open_answer"),
    instructionPl: z.string().min(1),
    prompt: z.string().min(1),
    audioAssetId: UuidSchema.optional(),
    questionAudioAssetId: QuestionAudioSchema,
    /**
     * Język pytania, gdy jest jednoznaczny (przedmiot z jednym językiem, np.
     * szkoła: `pl-PL`, albo `openAnswerPromptLocale` przedmiotu, np. rozdział:
     * polski bodziec) — dla czytników ekranu. Brak = dotychczasowe `en-GB`
     * (gramatyka go nie wysyła). Schemat jest ścisły: starszy klient bez tego
     * pola albo bez `answerLocale` odrzuca zadanie, które je niesie, a serwer
     * dołącza `answerLocale` do pytań otwartych każdego przedmiotu o języku
     * `pl-PL`/`en-GB` — web i Kid UI wdrażamy razem.
     */
    promptLocale: LessonContentLocaleSchema.optional(),
    /**
     * Język pola odpowiedzi (przedmiot z jednym językiem odpowiedzi); brak =
     * pole dziedziczy `promptLocale`, jak dotąd.
     */
    answerLocale: LessonContentLocaleSchema.optional(),
    /** Dyktowanie odpowiedzi (przedmiot z mową, trening z mikrofonem); brak = bez mikrofonu. */
    speechInput: SpeechInputSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("lesson_calculation"),
    instructionPl: z.string().min(1),
    prompt: z.string().min(1),
  }).strict(),
  // Trener precyzji: wybór 2–3 pojęć kluczowych przed odpowiedzią otwartą.
  // `prompt` to pytanie zaplanowanej zaraz potem odpowiedzi; DTO nie zdradza,
  // które pojęcia są kluczowe.
  z.object({
    kind: z.literal("lesson_keywords"),
    instructionPl: z.string().min(1),
    prompt: z.string().min(1),
    options: z.array(ChoiceOptionSchema).min(4).max(6),
    minSelected: z.number().int().min(1),
    maxSelected: z.number().int().min(1),
    questionAudioAssetId: QuestionAudioSchema,
  }).strict(),
  // „Połącz w pary” (design szkoły §10.1): obie kolumny tasowane niezależnie,
  // prawa z dystraktorami; DTO nie zdradza, co do czego pasuje.
  z.object({
    kind: z.literal("lesson_match"),
    instructionPl: z.string().min(1),
    left: z.array(LessonItemSchema).min(3).max(5),
    right: z.array(LessonItemSchema).min(3).max(7),
    /** Język treści zadania (przedmiot ma jeden język odpowiedzi); brak = bez atrybutu `lang`. */
    contentLocale: LessonContentLocaleSchema.optional(),
    questionAudioAssetId: QuestionAudioSchema,
  }).strict(),
  // „Pogrupuj” (design szkoły §10.2): grupy w kolejności materiału, elementy
  // tasowane; przynależność zna tylko serwer.
  z.object({
    kind: z.literal("lesson_group"),
    instructionPl: z.string().min(1),
    groups: z.array(LessonItemSchema).min(2).max(3),
    items: z.array(LessonItemSchema).min(4).max(8),
    /** Język treści zadania (przedmiot ma jeden język odpowiedzi); brak = bez atrybutu `lang`. */
    contentLocale: LessonContentLocaleSchema.optional(),
    questionAudioAssetId: QuestionAudioSchema,
  }).strict(),
  // „Uzupełnij tekst” (design szkoły §13.2): tekst pocięty na luki, bank słów
  // tasowany; które słowo pasuje do której luki, wie tylko serwer.
  z.object({
    kind: z.literal("lesson_cloze"),
    instructionPl: z.string().min(1),
    segments: z.array(ClozeSegmentSchema).min(2).max(9),
    words: z.array(LessonItemSchema).min(3).max(6),
    /** Język treści zadania (przedmiot ma jeden język odpowiedzi); brak = bez atrybutu `lang`. */
    contentLocale: LessonContentLocaleSchema.optional(),
    questionAudioAssetId: QuestionAudioSchema,
  }).strict(),
  // Zadanie następcze „Skróć odpowiedź” (technicznie odpowiedź otwarta): własny
  // tekst dziecka z zaznaczonymi fragmentami do usunięcia — nic z klucza.
  z.object({
    kind: z.literal("lesson_shorten"),
    instructionPl: z.string().min(1),
    prompt: z.string().min(1),
    originalAnswer: z.string().min(1).max(MAX_TEXT_ATTEMPT_LENGTH),
    answerSegments: z.array(SpellingDiffSegmentSchema).min(1).max(32),
    speechInput: SpeechInputSchema.optional(),
  }).strict(),
]).superRefine((prompt, ctx) => {
  if (prompt.kind === "lesson_keywords" && (prompt.minSelected > prompt.maxSelected || prompt.maxSelected > prompt.options.length)) {
    ctx.addIssue({ code: "custom", path: ["maxSelected"], message: "selection bounds must fit the options" });
  }
  if (prompt.kind === "lesson_match" && prompt.right.length < prompt.left.length) {
    ctx.addIssue({ code: "custom", path: ["right"], message: "every left item needs a right candidate" });
  }
  if (prompt.kind === "lesson_cloze") {
    const gapIds = prompt.segments.flatMap((segment) => ("gapId" in segment ? [segment.gapId] : []));
    if (gapIds.length < 2 || gapIds.length > 4 || new Set(gapIds).size !== gapIds.length) {
      ctx.addIssue({ code: "custom", path: ["segments"], message: "cloze needs 2-4 unique gaps" });
    }
    if (prompt.words.length <= gapIds.length) {
      ctx.addIssue({ code: "custom", path: ["words"], message: "the word bank needs a distractor" });
    }
  }
  if (prompt.kind === "exposure" || prompt.kind === "speech") {
    validateVisualPrompt({
      visualType: prompt.visualType,
      ...(prompt.visualData === undefined ? {} : { visualData: prompt.visualData }),
      target: prompt.kind === "exposure" ? prompt.target : prompt.text,
    }, ctx);
  }
});
export type TaskPrompt = z.infer<typeof TaskPromptSchema>;

export const SessionInputSchema = z.object({
  mode: z.enum(["training", "mock_test"]).optional(),
  childId: UuidSchema,
  deckId: UuidSchema,
  microphoneEnabled: z.boolean(),
  supportsPictureVocabulary: z.boolean().default(false),
  /**
   * Klient rozumie typ `picture_recognition` (obrazek → angielskie słowo).
   * Klient bez flagi (domyślnie false) nie otrzymuje tego typu w sesji —
   * degradacja zgodna z wzorcem `supportsPictureVocabulary` (arch §20).
   */
  supportsPictureRecognition: z.boolean().default(false),
});
export type SessionInput = z.input<typeof SessionInputSchema>;

export const SessionDtoSchema = z.object({
  mode: z.enum(["training", "mock_test", "daily_round"]),
  sessionId: UuidSchema,
  childId: UuidSchema,
  deckId: UuidSchema,
  deckVersionId: UuidSchema,
  policyId: z.string().min(1),
  microphoneEnabled: z.boolean(),
  canRead: z.boolean().default(true),
  vocabularyFormat: z.enum(["standard", "picture"]).default("standard"),
  state: z.enum(["active", "completed", "ended"]),
  /** Maksymalny budżet zadań ocenianych; prezentacje go nie powiększają. */
  taskBudget: z.number().int().positive(),
  tasksIssued: z.number().int().nonnegative(),
  assessedTasksIssued: z.number().int().nonnegative(),
  startedAt: InstantSchema,
  /** True, gdy zwrócono istniejącą aktywną sesję zamiast tworzyć nową. */
  resumed: z.boolean(),
});
export type SessionDto = z.input<typeof SessionDtoSchema>;

export const TaskDtoSchema = z.object({
  taskId: UuidSchema,
  sessionId: UuidSchema,
  ordinal: z.number().int().nonnegative(),
  exerciseType: z.enum(EXERCISE_TYPES),
  direction: z.enum(["target_to_source", "source_to_target"]).nullable(),
  state: z.enum(["issued", "answered", "completed", "skipped"]),
  prompt: TaskPromptSchema,
  /** Zadania oceniane łącznie z bieżącym — podstawa komunikatu „Jeszcze N”. */
  remainingAssessed: z.number().int().positive(),
  pendingAttemptId: UuidSchema.optional(),
});
export type TaskDto = z.infer<typeof TaskDtoSchema>;

export const EventInputSchema = z.object({
  taskId: UuidSchema,
  clientEventId: UuidSchema,
  kind: z.enum(["display_confirmed", "audio_played"]),
  stepId: z.string().min(1).optional(),
});
export type EventInput = z.infer<typeof EventInputSchema>;

export const DisclosureInputSchema = z.object({
  taskId: UuidSchema,
  kind: z.enum(["audio", "hint"]),
});
export type DisclosureInput = z.infer<typeof DisclosureInputSchema>;

export const DisclosureDtoSchema = z.object({
  taskId: UuidSchema,
  /** Serwerowy identyfikator kroku — wspólne pole odpowiedzi i późniejszych ACK. */
  stepId: z.string().min(1),
  kind: z.enum(["audio", "hint"]),
  /** Rozwiązanie własnego zadania; tylko dla podpowiedzi (SPEC §16). */
  reveal: z.object({ target: z.string().min(1) }).nullable(),
  audioAssetId: UuidSchema.optional(),
});
export type DisclosureDto = z.infer<typeof DisclosureDtoSchema>;

export const FeedbackAudioDtoSchema = z.object({
  attemptId: UuidSchema,
  taskId: UuidSchema,
  stepId: z.string().min(1),
  audioAssetId: UuidSchema,
});
export type FeedbackAudioDto = z.infer<typeof FeedbackAudioDtoSchema>;

export const PresentationCompletionInputSchema = z.object({
  taskId: UuidSchema,
  clientCommandId: UuidSchema.optional(),
});
export type PresentationCompletionInput = z.infer<typeof PresentationCompletionInputSchema>;

export const PresentationCompletionDtoSchema = z.object({
  taskId: UuidSchema,
  state: z.literal("completed"),
  completedAt: InstantSchema,
});
export type PresentationCompletionDto = z.infer<typeof PresentationCompletionDtoSchema>;

export const SessionSummaryResultsSchema = z.object({
  independentSuccesses: z.object({
    recall: z.number().int().nonnegative(),
    spelling: z.number().int().nonnegative(),
  }),
  practiceItems: z.array(z.object({
    itemId: UuidSchema,
    target: z.string().min(1),
    skills: z.array(z.enum(["recall", "spelling"])).min(1),
  })),
});
export type SessionSummaryResults = z.infer<typeof SessionSummaryResultsSchema>;

export const SessionSummaryDtoSchema = SessionSummaryResultsSchema.extend({
  sessionId: UuidSchema,
  state: z.enum(["completed", "ended"]),
  tasksIssued: z.number().int().nonnegative(),
  assessedTasksIssued: z.number().int().nonnegative(),
  endedAt: InstantSchema,
  /**
   * Wynik oceny aktywności (punkty/albo jawny brak oceny). OPCJONALNY:
   * zamrożony raport wiedzy w `context.summary` go NIE zawiera — dołączamy go
   * do odpowiedzi HTTP z `learning_sessions.activity_review`, więc powtórne
   * zakończenie zwraca ten sam wynik bez ponownego modelu. Brak pola = sesja
   * zakończona bez raportu (nie jest to dowód braku nauki).
   */
  activity: SessionActivityResultDtoSchema.optional(),
  /**
   * Wariant lekcji (design „Kwalifikacja i projekcja celów”, req 7.7): podsumowanie
   * per cel — ile ćwiczeń celu wykonano i ile poprawnie. BEZ procentów, bez statusów
   * technicznych i bez kategorii błędów (prywatność: `.strict()` broni przed wyciekiem
   * takiego pola). Opcjonalne — podsumowanie słówek go nie niesie (zgodność wsteczna).
   */
  objectives: z.array(z.object({
    objectiveId: z.string().min(1),
    titlePl: z.string().min(1),
    practiced: z.number().int().nonnegative(),
    correct: z.number().int().nonnegative(),
  }).strict()).optional(),
});
export type SessionSummaryDto = z.infer<typeof SessionSummaryDtoSchema>;

/**
 * Widok profilu dla ekranu dziecka: nazwa, awatar (arch §12) oraz jeden ogólny
 * licznik dorobku punktów. Bez salda do wydania, dziennych celów i pakietów.
 */
export const KidProfileDtoSchema = z.object({
  childId: UuidSchema,
  displayName: z.string().min(1),
  avatarKey: z.string().min(1),
  recordingMode: RecordingModeSchema,
  canRead: z.boolean().default(true),
  /** Suma zatwierdzonych sekund sesji zakończonych dzisiaj; brak oznacza starszy serwer lub niedostępne dane. */
  todayActivitySeconds: z.number().int().nonnegative().optional(),
  /** Distinguishes an unavailable report from an older server that omits the activity field. */
  todayActivityUnavailable: z.boolean().optional(),
  /** Ogólny dorobek dziecka (1 pkt / pełna zatwierdzona minuta nauki). */
  rewardPoints: z.number().int().nonnegative().default(0),
});
export type KidProfileDto = z.input<typeof KidProfileDtoSchema>;

/** Zestaw przypisany dziecku, dostępny do nauki (arch §12). */
export const KidDeckDtoSchema = z.object({
  mockTestAvailable: z.boolean().default(false),
  activeSession: z.object({ sessionId: UuidSchema, mode: z.enum(["training", "mock_test", "daily_round"]) }).nullable().default(null),
  /**
   * Rodzaj zestawu. OPCJONALNE dla zgodności wstecznej — brak pola oznacza
   * „vocabulary” (konsumenci traktują `undefined` jak słówka). Nie `.default()`,
   * by nie poszerzać typu wyjściowego o nowe pole WYMAGANE w każdym miejscu
   * konstrukcji DTO (server/kid-ui/e2e) — to byłaby niezgodność wsteczna typu.
   */
  kind: z.enum(["vocabulary", "lesson"]).optional(),
  vocabularyFormat: z.enum(["standard", "picture"]).default("standard"),
  coverVisual: MeaningVisualSchema.nullable().default(null),
  /** Opcjonalna okładka zestawu; brak pola zachowuje zgodność starszych serwerów. */
  coverAssetId: UuidSchema.nullable().optional(),
  resumeOnly: z.boolean().default(false),
  /** Tytuł przedmiotu dla lekcji; brak/undefined dla słówek (zgodność wsteczna). */
  subjectTitle: z.string().min(1).nullable().optional(),
  deckId: UuidSchema,
  title: z.string().min(1),
  /** Liczba słów w przypiętej, opublikowanej wersji zestawu. */
  itemCount: z.number().int().nonnegative(),
  /** Elementy z opanowaną umiejętnością samodzielnego Recall. */
  independentlyRecalledCount: z.number().int().nonnegative(),
  /** Termin sprawdzianu z przypisania (lokalna data rodziny) lub null. */
  testDate: z.string().nullable(),
  /**
   * Czy harmonogram ma teraz dla dziecka zaplanowaną pracę w tym zestawie
   * (należne sprawdzenia/powtórki albo nowy materiał)? Podstawa sekcji
   * „Rekomendowane”; ćwiczyć można każdy zestaw w dowolnym momencie.
   */
  recommended: z.boolean(),
});
export type KidDeckDto = z.input<typeof KidDeckDtoSchema>;

export const KidValidationReasonSchema = z.enum([
  "picture_client_update_required",
  "vocabulary_requires_reading",
  "non_reader_mock_test_unavailable",
  "picture_guidance_unavailable",
  "picture_audio_unavailable",
  /** Raport aktywności ma nieznaną wersję formatu — klient musi się odświeżyć. */
  "activity_report_update_required",
]);
export type KidValidationReason = z.infer<typeof KidValidationReasonSchema>;
export const KidValidationDetailsSchema = z.object({ reason: KidValidationReasonSchema }).strict();
export type KidValidationDetails = z.infer<typeof KidValidationDetailsSchema>;

/**
 * Feedback dla dziecka po próbie — wybór treści pochodzi z reguł domeny
 * (SPEC §16). `correctText` to rozwiązanie własnego zadania, ujawniane
 * wyłącznie wraz z ekspozycją zapisaną przed odpowiedzią HTTP.
 */
export const PronunciationFragmentDtoSchema = z.object({
  text: z.string().min(1),
  verdict: z.enum(["good", "almost", "unknown"]),
});
export type PronunciationFragmentDto = z.infer<typeof PronunciationFragmentDtoSchema>;

export const SpeechFeedbackDtoSchema = z.object({
  recognition: z.enum(["matched", "different", "uncertain", "no_speech", "unavailable"]),
  pronunciation: z.enum(["good", "practice", "unreliable", "unavailable", "not_configured", "not_applicable"]),
  referenceText: z.string().min(1).max(200).optional(),
}).strict().superRefine((speech, ctx) => {
  if (["uncertain", "no_speech", "unavailable"].includes(speech.recognition) && speech.referenceText !== undefined) {
    ctx.addIssue({ code: "custom", path: ["referenceText"], message: "uncertain recognition cannot disclose a reference text" });
  }
});
export type SpeechFeedbackDto = z.infer<typeof SpeechFeedbackDtoSchema>;

/**
 * Porównanie zapisu dziecka z właściwym wariantem: dwa zsegmentowane wiersze.
 * Segmenty `expected` składają się dokładnie na `correctText`; bez odległości
 * i technicznych score'ów (dziecko nie widzi liczb).
 */
/** Segment diffu pisowni: tylko `plain`/`pill` (kategoria „nie na temat” dotyczy lekcji). */
const SpellingSegmentSchema = SpellingDiffSegmentSchema.refine((segment) => segment.state !== "offtopic", {
  message: "spelling diff segments are plain or pill",
});

export const SpellingDiffSchema = z.object({
  given: z.array(SpellingSegmentSchema).min(1).max(32),
  expected: z.array(SpellingSegmentSchema).min(1).max(32),
  capitalizationHint: z.boolean().optional(),
});
export type SpellingDiff = z.infer<typeof SpellingDiffSchema>;

export const FeedbackDtoSchema = z.object({
  kind: z.enum(["great", "capitalization_hint", "almost", "incorrect", "content_matched", "not_assessed", "spelling_hint", "lesson_hint", "lesson_almost", "lesson_precision_hint"]),
  correctText: z.string().min(1).optional(),
  heardText: z.string().min(1).max(200).optional(),
  fragments: z.array(PronunciationFragmentDtoSchema).max(6).optional(),
  speech: SpeechFeedbackDtoSchema.optional(),
  spellingDiff: SpellingDiffSchema.optional(),
  /**
   * Zsegmentowana odpowiedź dziecka z zaznaczonymi fragmentami (reuse
   * `SpellingDiffSegmentSchema`) — tylko dla rodzajów lekcji `lesson_almost`
   * i `lesson_hint`.
   */
  answerSegments: z.array(SpellingDiffSegmentSchema).min(1).max(32).optional(),
  /** Szablon podpowiedzi kategorii celu (po polsku) — wymagany dla `lesson_hint`. */
  hintPl: z.string().min(1).optional(),
  /** Wskazówka prezentacji; endpoint odsłuchu zawsze ponownie sprawdza uprawnienie. */
  referenceAudioAvailable: z.boolean().optional(),
  /**
   * Nagranie rozwiązania ujawniane WYŁĄCZNIE w feedbacku wraz z oceną próby
   * (poprawna opcja `picture_recognition`, pełne zdanie ćwiczenia lekcji
   * gramatyki w treningu). Serwer zamyka zdarzenie `audio_issued` przed
   * odpowiedzią HTTP; przed odpowiedzią prompt nie niesie tego nagrania
   * (SPEC A07).
   */
  correctAudioAssetId: UuidSchema.optional(),
}).strict().superRefine((feedback, ctx) => {
  if (feedback.kind === "spelling_hint" && feedback.spellingDiff === undefined) {
    ctx.addIssue({ code: "custom", path: ["spellingDiff"], message: "spelling_hint requires spellingDiff" });
  }
  if (feedback.kind !== "spelling_hint" && feedback.spellingDiff !== undefined) {
    ctx.addIssue({ code: "custom", path: ["spellingDiff"], message: "spellingDiff is only allowed with spelling_hint" });
  }
  if (feedback.kind === "spelling_hint" && feedback.spellingDiff !== undefined) {
    const expected = feedback.spellingDiff.expected.map((segment) => segment.text).join("");
    if (expected !== feedback.correctText) {
      ctx.addIssue({ code: "custom", path: ["spellingDiff"], message: "expected segments must compose into correctText" });
    }
  }
  // Reguły lekcji: answerSegments tylko dla rodzajów lekcji; lesson_hint
  // wymaga hintPl. correctText jest dozwolone (najbliższy zatwierdzony wariant).
  const LESSON_SEGMENT_KINDS = ["lesson_almost", "lesson_hint"];
  if (feedback.answerSegments !== undefined && !LESSON_SEGMENT_KINDS.includes(feedback.kind)) {
    ctx.addIssue({ code: "custom", path: ["answerSegments"], message: "answerSegments is only allowed with lesson_almost or lesson_hint" });
  }
  // `lesson_precision_hint` = poprawna wiedza, ale odpowiedź do skrócenia
  // (trener precyzji); niesie szablon zachęty jak lesson_hint.
  const HINT_KINDS = ["lesson_hint", "lesson_precision_hint"];
  if (HINT_KINDS.includes(feedback.kind) && feedback.hintPl === undefined) {
    ctx.addIssue({ code: "custom", path: ["hintPl"], message: `${feedback.kind} requires hintPl` });
  }
  if (feedback.hintPl !== undefined && !HINT_KINDS.includes(feedback.kind)) {
    ctx.addIssue({ code: "custom", path: ["hintPl"], message: "hintPl is only allowed with lesson_hint or lesson_precision_hint" });
  }
  if (feedback.speech && ["uncertain", "no_speech", "unavailable"].includes(feedback.speech.recognition)) {
    for (const field of ["heardText", "correctText", "fragments"] as const) {
      if (feedback[field] !== undefined) {
        ctx.addIssue({ code: "custom", path: [field], message: "uncertain recognition cannot disclose speech content" });
      }
    }
  }
  // Odsłuch poprawnego słowa ujawnia rozwiązanie: nie towarzyszy feedbackowi,
  // który niczego nie ujawnia (próba nieoceniona, „Pomiń”, awaria techniczna).
  if (feedback.kind === "not_assessed" && feedback.correctAudioAssetId !== undefined) {
    ctx.addIssue({ code: "custom", path: ["correctAudioAssetId"], message: "not_assessed cannot disclose the correct word audio" });
  }
});
export type FeedbackDto = z.infer<typeof FeedbackDtoSchema>;

export const AttemptModalitySchema = z.enum(["choice", "text", "audio", "dont_remember", "skip", "sequence", "selection", "assignment"]);

/**
 * Przypisanie (`lesson_match`: lewy element → prawy, `lesson_group`: element →
 * grupa, `lesson_cloze`: luka → słowo). Kompletność i zgodność z zadaniem sprawdza serwer.
 */
export const AssignmentSchema = z.object({ itemId: UuidSchema, targetId: UuidSchema }).strict();
export type Assignment = z.infer<typeof AssignmentSchema>;
export type AttemptModality = z.infer<typeof AttemptModalitySchema>;

/**
 * Odpowiedź dziecka na zadanie (arch §12). `clientAttemptId` zabezpiecza retry
 * transportowy; ponowne użycie tego samego klucza z inną treścią daje 409.
 * Odpowiedź audio idzie multipartem (bajty nagrania poza JSON) i jest
 * oceniana ścieżką mowy: rezerwacja processing → analiza → finalizacja.
 */
export const AttemptInputSchema = z.discriminatedUnion("modality", [
  z.object({
    taskId: UuidSchema,
    clientAttemptId: UuidSchema,
    modality: z.literal("choice"),
    optionId: UuidSchema,
  }),
  z.object({
    taskId: UuidSchema,
    clientAttemptId: UuidSchema,
    modality: z.literal("text"),
    text: z.string().max(MAX_TEXT_ATTEMPT_LENGTH),
    /** „speech” = tekst z dyktowania (serwer weryfikuje, że dyktowanie było). */
    inputMethod: InputMethodSchema.optional(),
  }),
  z.object({
    taskId: UuidSchema,
    clientAttemptId: UuidSchema,
    modality: z.literal("audio"),
  }),
  z.object({
    taskId: UuidSchema,
    clientAttemptId: UuidSchema,
    modality: z.literal("dont_remember"),
  }),
  z.object({
    taskId: UuidSchema,
    clientAttemptId: UuidSchema,
    modality: z.literal("skip"),
  }),
  z.object({
    taskId: UuidSchema,
    clientAttemptId: UuidSchema,
    modality: z.literal("sequence"),
    /** Kolejność wskazana przez dziecko (`lesson_order`): 1–10 unikalnych id. */
    itemIds: z.array(UuidSchema).min(1).max(10).refine(
      (ids) => new Set(ids).size === ids.length,
      { message: "itemIds must be unique" },
    ),
  }),
  z.object({
    taskId: UuidSchema,
    clientAttemptId: UuidSchema,
    modality: z.literal("selection"),
    /** Zbiór wskazany przez dziecko (`lesson_keywords`): 1–6 unikalnych id, kolejność bez znaczenia. */
    itemIds: z.array(UuidSchema).min(1).max(6).refine(
      (ids) => new Set(ids).size === ids.length,
      { message: "itemIds must be unique" },
    ),
  }),
  z.object({
    taskId: UuidSchema,
    clientAttemptId: UuidSchema,
    modality: z.literal("assignment"),
    /**
     * Przypisania dziecka (`lesson_match`, `lesson_group`, `lesson_cloze`):
     * 2–8, każdy element raz; dokładną liczbę dla zadania sprawdza serwer.
     */
    assignments: z.array(AssignmentSchema).min(2).max(8).refine(
      (list) => new Set(list.map((entry) => entry.itemId)).size === list.length,
      { message: "each item can be assigned once" },
    ),
  }),
]);
export type AttemptInput = z.infer<typeof AttemptInputSchema>;

export const AttemptDtoSchema = z.object({
  attemptId: UuidSchema,
  taskId: UuidSchema,
  state: z.enum(["processing", "completed"]),
  modality: AttemptModalitySchema,
  /** Reguły domeny; null dopóki ocena trwa (audio). */
  feedback: FeedbackDtoSchema.nullable(),
  /** Stan zadania po próbie: „issued” pozwala na drugie podejście. */
  taskState: z.enum(["issued", "answered", "completed", "skipped"]),
  /** Serwerowy krok ujawnienia feedbacku — pole dla późniejszych ACK obserwacji. */
  stepId: z.string().min(1).nullable(),
  receivedAt: InstantSchema,
  completedAt: InstantSchema.nullable(),
});
export type AttemptDto = z.infer<typeof AttemptDtoSchema>;
