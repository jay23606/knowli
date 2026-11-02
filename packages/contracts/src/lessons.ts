import { z } from "zod";
import { InstantSchema, UuidSchema } from "./common";
import { AssignmentDtoSchema, DeckSourceDtoSchema, DeckStateSchema, RevisionAssetDtoSchema, SessionTaskBudgetSchema } from "./decks";
import { GenerationDtoSchema } from "./generation";
import { ChildInterestsSchema } from "./child-interests";
import { CalculationSpecSchema } from "./lesson-calculation";

/**
 * Kontrakty lekcji (`@learning/contracts`) — publiczne DTO silnika lekcji
 * współdzielone przez web, kid-ui i serwer. Silnik jest subject-agnostyczny:
 * kontrakty znają kształt i limity, nie reguły przedmiotu. Walidacja
 * semantyczna (pokrycie focus, duplikaty, poprawność correctOption) zostaje
 * w domenie (`domain/lessons/pool-validation.ts`). Bez importów z serwera/SDK.
 *
 * Limity są zgodne z nazwanymi stałymi domeny (`pool-validation.ts`):
 * pole tekstowe ≤ 120, acceptedAnswers ≤ 40, opcje 2–4, elementy 3–10,
 * notice 2–3 zdania × 1–15 segmentów.
 */

/** Limity współdzielone z `domain/lessons/pool-validation.ts`. */
const MAX_TEXT_LENGTH = 120;
/** Odpowiedź wzorcowa i warianty: dłuższy limit pod odpowiedzi przedmiotów szkolnych. */
export const MAX_LESSON_ANSWER_LENGTH = 300;
/** Maks. długość cytatu źródłowego ćwiczenia szkolnego (osobna stała od limitu odpowiedzi). */
export const MAX_SOURCE_QUOTE_LENGTH = 600;
/** Limit materiału zestawu szkolnego (gramatyka zostaje przy 8000). */
export const MAX_SCHOOL_MATERIAL_LENGTH = 16000;
const MAX_ACCEPTED_ANSWERS = 40;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MIN_ORDER_ITEMS = 3;
const MAX_ORDER_ITEMS = 10;
const MIN_NOTICE_SENTENCES = 2;
const MAX_NOTICE_SENTENCES = 3;
const MIN_NOTICE_SEGMENTS = 1;
const MAX_NOTICE_SEGMENTS = 15;
/** Trener precyzji (`lesson_keywords`): 4–6 pojęć do wyboru, z czego 2–3 kluczowe, każde ≤ 40 znaków. */
export const MIN_KEYWORD_OPTIONS = 4;
export const MAX_KEYWORD_OPTIONS = 6;
export const MIN_KEY_OPTIONS = 2;
export const MAX_KEY_OPTIONS = 3;
export const MAX_KEYWORD_LENGTH = 40;
/** „Połącz w pary” (`lesson_match`, design szkoły §10.1): 3–5 par + 0–2 dystraktory po prawej. */
export const MIN_MATCH_PAIRS = 3;
export const MAX_MATCH_PAIRS = 5;
export const MAX_MATCH_EXTRA = 2;
export const MAX_MATCH_LEFT_LENGTH = 40;
export const MAX_MATCH_RIGHT_LENGTH = 100;
/** „Pogrupuj” (`lesson_group`, design szkoły §10.2): 2–3 grupy, 4–8 elementów, min. 2 na grupę. */
export const MIN_GROUPS = 2;
export const MAX_GROUPS = 3;
export const MIN_GROUP_ITEMS = 4;
export const MAX_GROUP_ITEMS = 8;
export const MIN_ITEMS_PER_GROUP = 2;
export const MAX_GROUP_LABEL_LENGTH = 30;
export const MAX_GROUP_ITEM_LENGTH = 40;
/** „Uzupełnij tekst” (`lesson_cloze`, design szkoły §13.1): tekst ≤300 znaków, 2–4 luki, 1–2 dystraktory. */
export const MAX_CLOZE_TEXT_LENGTH = 300;
export const MIN_CLOZE_GAPS = 2;
export const MAX_CLOZE_GAPS = 4;
export const MIN_CLOZE_EXTRA = 1;
export const MAX_CLOZE_EXTRA = 2;
export const MAX_CLOZE_WORD_LENGTH = 30;

/** Typy ćwiczeń lekcji (design „Typy ćwiczeń i etapy”). */
export const LESSON_EXERCISE_TYPES = [
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
export type LessonExerciseTypeDto = (typeof LESSON_EXERCISE_TYPES)[number];
export const LessonExerciseTypeSchema = z.enum(LESSON_EXERCISE_TYPES);

const LessonStageSchema = z.enum(["intro", "guided", "productive", "independent"]);

/** Pole tekstowe ćwiczenia (payload „Data Models”): niepuste, ≤ 120 znaków. */
const text = z.string().min(1).max(MAX_TEXT_LENGTH);

/**
 * Katalog przedmiotów do formularza rodzica (design „Przedmiot i katalog”).
 * Tytuły, identyfikatory i karty rodzica — bez opisów dla modelu (`descriptionEn`),
 * bez puli ćwiczeń. `.strict()` broni przed wyciekiem pól modelowych.
 */
export const SubjectCatalogDtoSchema = z.object({
  subjects: z.array(z.object({
    id: z.string().min(1),
    titlePl: z.string().min(1),
    /**
     * Sposób tworzenia zestawu: `catalog` — temat i reguły z katalogu,
     * `material` — zagadnienia powstają z materiału rodzica (przedmiot bez tematów katalogowych).
     */
    creation: z.enum(["catalog", "material"]),
    /** Czy rodzic nazywa przedmiot własnym tytułem (zestawy szkolne); `false` = stały tytuł przedmiotu. */
    subjectTitleRequired: z.boolean(),
    /** Czy przedmiot przyjmuje tematy zdań z zainteresowań dziecka (pole w formularzu rodzica). */
    acceptsInterests: z.boolean().optional(),
    topics: z.array(z.object({
      id: z.string().min(1),
      version: z.number().int().positive(),
      titlePl: z.string().min(1),
      objectives: z.array(z.object({
        id: z.string().min(1),
        titlePl: z.string().min(1),
  cards: z.array(z.object({ title: z.string().min(1), body: z.string().min(1) }).strict()),
      }).strict()),
    }).strict()),
  }).strict()),
  /**
   * Skonfigurowana etykieta usługi generującej lekcje (host · model, z env procesu web);
   * parent-facing, do informacji o tematach zdań. To opis konfiguracji, nie dowód, że
   * generowanie jest dostępne; brak = etykiety nie da się ustalić.
   */
  generationService: z.string().min(1).optional(),
}).strict();
export type SubjectCatalogDto = z.infer<typeof SubjectCatalogDtoSchema>;

/**
 * Polecenie utworzenia lekcji (design „Data Models → Kontrakty”). `deckId`
 * opcjonalny dla idempotentnego tworzenia jak `CreateEmptyDeckCommand`;
 * `clientRequestId` jest kluczem idempotencji zlecenia (odwzorowanie wzorca
 * `GenerationCommand`). Limity: material 1–8000 (trim), instruction ≤ 500,
 * poolSize 20–120 (int). Co najmniej jeden unikalny cel.
 */
export const LessonCommandSchema = z.object({
  deckId: UuidSchema.optional(),
  subjectId: z.string().min(1),
  topicId: z.string().min(1),
  objectiveIds: z.array(z.string().min(1)).min(1).refine(
    (ids) => new Set(ids).size === ids.length,
    { message: "objectiveIds must be unique" },
  ),
  material: z.string().trim().min(1).max(8000),
  instruction: z.string().max(500).optional(),
  poolSize: z.number().int().min(20).max(120).optional(),
  /** Tematy zdań z zainteresowań dziecka; brak pola = bez tematów (pusta lista nie jest dozwolona). */
  interests: ChildInterestsSchema.min(1).optional(),
  clientRequestId: UuidSchema,
}).strict();
export type LessonCommand = z.infer<typeof LessonCommandSchema>;

/**
 * Polecenie utworzenia zestawu przedmiotu szkolnego: zagadnienia powstają
 * z materiału podczas generowania, więc w poleceniu nie ma celów ani tematu
 * z katalogu — rodzic nazywa przedmiot i temat własnymi tytułami.
 */
export const MAX_SCHOOL_SUBJECT_TITLE_LENGTH = 80;
export const MAX_SCHOOL_TOPIC_TITLE_LENGTH = 120;

/**
 * Źródło tekstu zestawu z materiału: dokładnie jedno z dwóch — wklejony
 * `material` albo `sourceMaterialId` zapisanego źródła (design 2026-10-30,
 * §3.3; serwer kopiuje wtedy jego tekst). Oba albo żadne to `validation`.
 * Brak obu zgłaszamy przy `material` — to pole podświetla formularz rodzica;
 * oba naraz przy `sourceMaterialId` (zbędne odwołanie obok wklejonego tekstu).
 *
 * `expectedSourceRevision` towarzyszy wyłącznie `sourceMaterialId` i jest przy
 * nim wymagane: to rewizja TREŚCI źródła (`SourceMaterialDto.bodyRevision`),
 * z której rodzic widział podgląd. Inna rewizja w chwili tworzenia to
 * `conflict` z `LessonSourceChangedDetails` — serwer nie kopiuje tekstu,
 * którego rodzic nie widział.
 */
function requireExactlyOneTextSource(
  command: { material?: string | undefined; sourceMaterialId?: string | undefined; expectedSourceRevision?: number | undefined },
  ctx: z.core.$RefinementCtx,
): void {
  const hasMaterial = command.material !== undefined;
  const hasSource = command.sourceMaterialId !== undefined;
  if (hasMaterial === hasSource) {
    ctx.addIssue({
      code: "custom",
      path: [hasMaterial ? "sourceMaterialId" : "material"],
      message: "provide exactly one of material or sourceMaterialId",
    });
    return;
  }
  if (hasSource !== (command.expectedSourceRevision !== undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["expectedSourceRevision"],
      message: "expectedSourceRevision is required with sourceMaterialId and only with it",
    });
  }
}

/** Rewizja treści źródła z podglądu rodzica (dodatnia liczba całkowita). */
const ExpectedSourceRevisionSchema = z.number().int().min(1);

/**
 * `details` błędu `conflict` tworzenia lekcji ze źródła, gdy tekst źródła
 * zmieniono po wyświetleniu podglądu (`expectedSourceRevision` różne od
 * bieżącej rewizji treści). Zestaw nie powstał; panel odświeża podgląd, a rodzic
 * potwierdza nowy tekst ponownym utworzeniem. Odróżnia ten konflikt od innych.
 */
export const LessonSourceChangedDetailsSchema = z.object({ reason: z.literal("source_changed") }).strict();
export type LessonSourceChangedDetails = z.infer<typeof LessonSourceChangedDetailsSchema>;

/**
 * Zestaw szkolny; tekst z `material` albo ze źródła (`sourceMaterialId` razem
 * z `expectedSourceRevision`, dokładnie jedno).
 */
export const SchoolLessonCommandSchema = z.object({
  deckId: UuidSchema.optional(),
  subjectTitlePl: z.string().trim().min(1).max(MAX_SCHOOL_SUBJECT_TITLE_LENGTH),
  topicTitlePl: z.string().trim().min(1).max(MAX_SCHOOL_TOPIC_TITLE_LENGTH),
  material: z.string().trim().min(1).max(MAX_SCHOOL_MATERIAL_LENGTH).optional(),
  sourceMaterialId: UuidSchema.optional(),
  expectedSourceRevision: ExpectedSourceRevisionSchema.optional(),
  instruction: z.string().max(500).optional(),
  poolSize: z.number().int().min(20).max(160).optional(),
  clientRequestId: UuidSchema,
}).strict().superRefine(requireExactlyOneTextSource);
export type SchoolLessonCommand = z.infer<typeof SchoolLessonCommandSchema>;

/**
 * Ton lektora nagrania pytania ćwiczenia lub karty nauki (spec TTS §4.1).
 * Brak pola = styl domyślny roli nagrania; wartości „default” celowo nie ma.
 * Ton nie trafia do Kid DTO ani do `SubjectCatalogDtoSchema` i nie wpływa
 * na `payload_version`.
 */
export const LessonVoiceToneSchema = z.enum(["cheerful", "curious", "gentle", "mysterious"]);
export type LessonVoiceTone = z.infer<typeof LessonVoiceToneSchema>;

/**
 * Polecenie utworzenia zestawu z materiału rodzica dla przedmiotu o stałym
 * tytule (np. „Angielski — rozdział”): bez nazwy przedmiotu, bo tytuł zestawu
 * bierze serwer z przedmiotu; rodzic podaje tylko tytuł tematu i materiał.
 * Przedmiot z nazwą od rodzica (szkolny) zostaje przy `SchoolLessonCommandSchema`.
 * Tekst pochodzi z `material` albo ze źródła (`sourceMaterialId` razem
 * z `expectedSourceRevision`) — dokładnie jedno.
 */
export const MaterialLessonCommandSchema = z.object({
  deckId: UuidSchema.optional(),
  subjectId: z.string().min(1).max(64),
  topicTitlePl: z.string().trim().min(1).max(MAX_SCHOOL_TOPIC_TITLE_LENGTH),
  material: z.string().trim().min(1).max(MAX_SCHOOL_MATERIAL_LENGTH).optional(),
  sourceMaterialId: UuidSchema.optional(),
  expectedSourceRevision: ExpectedSourceRevisionSchema.optional(),
  instruction: z.string().max(500).optional(),
  poolSize: z.number().int().min(20).max(160).optional(),
  clientRequestId: UuidSchema,
}).strict().superRefine(requireExactlyOneTextSource);
export type MaterialLessonCommand = z.infer<typeof MaterialLessonCommandSchema>;

/** Rodzaj zagadnienia tematu dynamicznego: grupa słów albo rama zdaniowa (przedmioty, które go używają). */
export const DynamicObjectiveKindSchema = z.enum(["words", "frame"]);
export type DynamicObjectiveKind = z.infer<typeof DynamicObjectiveKindSchema>;

/**
 * Zagadnienie tematu dynamicznego w widoku rodzica (bez pól modelowych).
 * `kind` jest opcjonalne i należy do serwera: patch rodzica go nie zmienia.
 */
export const DynamicObjectiveDtoSchema = z.object({
  id: z.string().min(1).max(200),
  titlePl: z.string().min(1).max(120),
  cards: z.array(z.object({
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(1200),
    /** Ton lektora nagrania karty; brak = styl domyślny roli (spec TTS §4.1). */
    voiceTone: LessonVoiceToneSchema.optional(),
  }).strict()).min(2).max(4),
  kind: DynamicObjectiveKindSchema.optional(),
}).strict();
export type DynamicObjectiveDto = z.infer<typeof DynamicObjectiveDtoSchema>;

export const DynamicTopicDtoSchema = z.object({
  titlePl: z.string().min(1).max(200),
  objectives: z.array(DynamicObjectiveDtoSchema).min(1).max(8),
}).strict();
export type DynamicTopicDto = z.infer<typeof DynamicTopicDtoSchema>;

/**
 * Patch zagadnień tematu dynamicznego w edycji szkicu: rodzic edytuje tytuły
 * i karty istniejących zagadnień oraz usuwa zagadnienia (przez pominięcie).
 * `descriptionEn` (pole modelowe) zachowuje serwer; identyfikatory są stałe.
 */
export const LessonDynamicTopicPatchSchema = z.object({
  objectives: z.array(DynamicObjectiveDtoSchema).min(1).max(8),
}).strict();
export type LessonDynamicTopicPatch = z.infer<typeof LessonDynamicTopicPatchSchema>;

const ExerciseOptionSchema = z.object({
  id: z.string().min(1),
  text: text,
});

/**
 * Piktogram osoby/zwierzęcia jako bodziec obrazkowy wyboru (`lesson_choice`):
 * dziecko dopasowuje zaimek do tego, kto jest na piktogramie. Katalog wartości
 * jest wspólny dla przedmiotów; mapowanie piktogram → zaimek należy do
 * przedmiotu (walidator gramatyki), nie do kontraktu.
 */
export const LessonVisualSubjectSchema = z.enum(["boy", "girl", "man", "woman", "group", "dog"]);
export type LessonVisualSubject = z.infer<typeof LessonVisualSubjectSchema>;

const ExerciseItemSchema = z.object({
  id: z.string().min(1),
  text: text,
});

/**
 * Edycja ćwiczenia przez rodzica (design „Data Models” → payload
 * `lesson_exercise`). Kontrakt sprawdza KSZTAŁT i LIMITY; walidacja semantyczna
 * (focus pokrywa odpowiedź, correctOption ∈ options, duplikaty) zostaje w
 * domenie. `id?` wskazuje istniejący element przy edycji. `.strict()` — żadnych
 * pól spoza payloadu. `noticeSegments`: 2–3 zdania po 1–15 segmentów;
 * `correctOption` dla notice = słowo do wskazania, bez `options`.
 */
/**
 * Pola payloadu v3 przedmiotów szkolnych (design „Przedmioty szkolne” pkt 3).
 * Wszystkie opcjonalne na poziomie kształtu; wymagalność per typ i przedmiot
 * egzekwuje walidacja puli w domenie. Gramatyka ich nie używa.
 */
export const LessonQuestionTypeSchema = z.enum([
  "definition",
  "enumeration",
  "cause",
  "comparison",
  "fact",
  "process",
]);
export type LessonQuestionTypeDto = z.infer<typeof LessonQuestionTypeSchema>;

export const LessonExpectedFormSchema = z.enum(["short", "one_sentence", "explanation", "list"]);
export type LessonExpectedFormDto = z.infer<typeof LessonExpectedFormSchema>;

const RequiredElementSchema = z.object({
  id: z.string().min(1).max(40),
  text: text,
}).strict();

const SourceRefSchema = z.object({
  quote: z.string().min(1).max(MAX_SOURCE_QUOTE_LENGTH),
  /** Cytat dopisany przez rodzica (jego własne źródło), nie z materiału. */
  parentAdded: z.boolean().optional(),
}).strict();
export const LessonExerciseInputSchema = z.object({
  id: UuidSchema.optional(),
  exerciseType: LessonExerciseTypeSchema,
  objectiveId: z.string().min(1),
  instructionPl: text.optional(),
  stem: text.optional(),
  statement: text.optional(),
  prompt: text.optional(),
  hint: text.optional(),
  transformId: z.string().min(1).optional(),
  visualSubject: LessonVisualSubjectSchema.optional(),
  noticeSegments: z.array(
    z.array(text).min(MIN_NOTICE_SEGMENTS).max(MAX_NOTICE_SEGMENTS),
  ).min(MIN_NOTICE_SENTENCES).max(MAX_NOTICE_SENTENCES).optional(),
  answer: z.string().min(1).max(MAX_LESSON_ANSWER_LENGTH),
  acceptedAnswers: z.array(z.string().min(1).max(MAX_LESSON_ANSWER_LENGTH)).max(MAX_ACCEPTED_ANSWERS),
  focus: z.array(z.string().min(1).max(MAX_TEXT_LENGTH)),
  options: z.array(ExerciseOptionSchema).min(MIN_OPTIONS).max(MAX_OPTIONS).optional(),
  correctOption: z.string().min(1).optional(),
  items: z.array(ExerciseItemSchema).min(MIN_ORDER_ITEMS).max(MAX_ORDER_ITEMS).optional(),
  questionType: LessonQuestionTypeSchema.optional(),
  requiredElements: z.array(RequiredElementSchema).min(1).max(6).optional(),
  supplementaryElements: z.array(text).max(4).optional(),
  commonErrors: z.array(text).max(4).optional(),
  expectedForm: LessonExpectedFormSchema.optional(),
  familyId: z.string().min(1).max(64).optional(),
  sourceRefs: z.array(SourceRefSchema).min(1).max(3).optional(),
  calculation: CalculationSpecSchema.optional(),
  /** `lesson_keywords`: pojęcia do wyboru i identyfikatory kluczowych (klucz tylko dla serwera i rodzica). */
  keywordOptions: z.array(z.object({ id: z.string().min(1), text: z.string().min(1).max(MAX_KEYWORD_LENGTH) }).strict())
    .min(MIN_KEYWORD_OPTIONS).max(MAX_KEYWORD_OPTIONS).optional(),
  keyOptionIds: z.array(z.string().min(1)).min(MIN_KEY_OPTIONS).max(MAX_KEY_OPTIONS).optional(),
  /** `lesson_match`: pary w kolejności materiału (klucz tylko dla serwera i rodzica). */
  pairs: z.array(z.object({
    left: z.string().min(1).max(MAX_MATCH_LEFT_LENGTH),
    right: z.string().min(1).max(MAX_MATCH_RIGHT_LENGTH),
  }).strict()).min(MIN_MATCH_PAIRS).max(MAX_MATCH_PAIRS).optional(),
  /** `lesson_match`: dystraktory po prawej (bez pary). */
  extraRight: z.array(z.string().min(1).max(MAX_MATCH_RIGHT_LENGTH)).max(MAX_MATCH_EXTRA).optional(),
  /** `lesson_group`: grupy (`id` — slug w obrębie ćwiczenia). */
  groups: z.array(z.object({
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(MAX_GROUP_LABEL_LENGTH),
  }).strict()).min(MIN_GROUPS).max(MAX_GROUPS).optional(),
  /** `lesson_group`: elementy z przynależnością do grupy (klucz tylko dla serwera i rodzica). */
  groupItems: z.array(z.object({
    text: z.string().min(1).max(MAX_GROUP_ITEM_LENGTH),
    groupId: z.string().min(1).max(40),
  }).strict()).min(MIN_GROUP_ITEMS).max(MAX_GROUP_ITEMS).optional(),
  /** `lesson_cloze`: tekst z lukami (ciąg 2+ podkreśleń w miejscu luki). */
  clozeText: z.string().min(1).max(MAX_CLOZE_TEXT_LENGTH).optional(),
  /** `lesson_cloze`: słowo do każdej luki w kolejności tekstu (klucz tylko dla serwera i rodzica). */
  gapAnswers: z.array(z.string().min(1).max(MAX_CLOZE_WORD_LENGTH)).min(MIN_CLOZE_GAPS).max(MAX_CLOZE_GAPS).optional(),
  /** `lesson_cloze`: dystraktory w banku słów. */
  extraWords: z.array(z.string().min(1).max(MAX_CLOZE_WORD_LENGTH)).min(MIN_CLOZE_EXTRA).max(MAX_CLOZE_EXTRA).optional(),
  /** Ton lektora nagrania pytania; brak = styl domyślny roli (spec TTS §4.1). */
  voiceTone: LessonVoiceToneSchema.optional(),
}).strict();
export type LessonExerciseInput = z.infer<typeof LessonExerciseInputSchema>;

/**
 * Stan nagrania pytania lub karty w panelu rodzica (spec tonu TTS §4.5): stan
 * najnowszej generacji o oczekiwanym fingerprincie; `assetId` tylko dla gotowej
 * (odsłuch przez `/api/v1/media/:id`). `previousAssetId` tylko przy `pending`
 * i `failed`: najnowsze gotowe ujęcie tego samego tekstu, które słyszy dziecko,
 * dopóki nowe się nagrywa albo gdy nowe się nie udało.
 */
export const LessonPromptAudioDtoSchema = z.object({
  state: z.enum(["pending", "ready", "failed"]),
  assetId: UuidSchema.optional(),
  previousAssetId: UuidSchema.optional(),
}).strict();
export type LessonPromptAudioDto = z.infer<typeof LessonPromptAudioDtoSchema>;

const LessonExerciseDraftDtoSchema = LessonExerciseInputSchema.extend({
  revisionId: UuidSchema,
  /** Nagranie pytania; brak = ćwiczenie nie ma nagrania dla tego tekstu. Tylko do odczytu. */
  promptAudio: LessonPromptAudioDtoSchema.optional(),
  /**
   * Nagranie zdania „Posłuchaj i wybierz” (`lesson_listen_choice`, rola `feedback_audio`
   * dla `feedbackSentenceText`); brak = to ćwiczenie nie ma bodźca słuchowego. Tylko do odczytu.
   */
  sentenceAudio: LessonPromptAudioDtoSchema.optional(),
});

/** Nagranie karty zagadnienia w szkicu (miejsce karty w temacie + stan). */
export const LessonCardAudioDtoSchema = z.object({
  objectiveId: z.string().min(1),
  cardIndex: z.number().int().nonnegative(),
  audio: LessonPromptAudioDtoSchema,
}).strict();
export type LessonCardAudioDto = z.infer<typeof LessonCardAudioDtoSchema>;

/** Brak pokrycia publikacyjnego per cel i etap (design „Generowanie puli”). */
export const CoverageGapDtoSchema = z.object({
  objectiveId: z.string().min(1),
  stage: LessonStageSchema,
  required: z.number().int().nonnegative(),
  actual: z.number().int().nonnegative(),
});
export type CoverageGapDto = z.infer<typeof CoverageGapDtoSchema>;

/**
 * Widok szkicu lekcji dla panelu rodzica (design „Data Models → Kontrakty”).
 * `examples` to przykłady z lekcji per cel; `exercises` to zedytowane payloady
 * z `revisionId`; `coverage` wskazuje braki etapów do publikacji.
 */
export const LessonDraftDtoSchema = z.object({
  id: UuidSchema,
  deckId: UuidSchema,
  editNumber: z.number().int().positive(),
  status: z.enum(["draft", "review", "published"]),
  title: z.string(),
  subjectId: z.string().min(1),
  topicId: z.string().min(1),
  topicVersion: z.number().int().positive(),
  objectiveIds: z.array(z.string().min(1)),
  /** Nazwa przedmiotu nadana przez rodzica (tylko zestawy szkolne). */
  subjectTitlePl: z.string().min(1).optional(),
  /** Tematy zdań z zainteresowań dziecka (tylko przedmioty, które je przyjmują); brak pola = bez tematów. */
  interests: z.array(z.string()).optional(),
  /** Temat dynamiczny z materiału (tylko zestawy szkolne, po generacji). */
  dynamicTopic: DynamicTopicDtoSchema.optional(),
  examples: z.record(z.string(), z.array(z.string())),
  exercises: z.array(LessonExerciseDraftDtoSchema),
  assets: z.array(RevisionAssetDtoSchema),
  /** Nagrania kart zagadnień (tylko karty z wierszem nagrania); brak pola = brak nagrań kart. */
  cardAudio: z.array(LessonCardAudioDtoSchema).optional(),
  /**
   * Ton lektora (spec tonu TTS §4): pole tylko dla przedmiotu z nagraniami pytań i kart.
   * `styleEnabled` — serwer nagrywa z tonem (`UMIEM_TTS_STYLE=instructions`); przy `none`
   * ton się zapisuje, ale nagrania brzmią domyślnie.
   */
  voiceTones: z.object({ styleEnabled: z.boolean() }).strict().optional(),
  rejectedCount: z.number().int().nonnegative(),
  /**
   * Powody odrzuceń przy czyszczeniu świeżo wygenerowanej puli (przedmiot z
   * `refineGeneratedPool`) z licznikami; tekst powodu jest dla rodzica, bez danych dziecka.
   */
  rejectedReasons: z.record(z.string(), z.number().int().positive()).optional(),
  /** Zagadnienia odrzucone/pominięte na etapie generowania tematu (zestawy szkolne). */
  droppedObjectiveCount: z.number().int().nonnegative().optional(),
  coverage: z.array(CoverageGapDtoSchema),
});
export type LessonDraftDto = z.infer<typeof LessonDraftDtoSchema>;

/**
 * Pochodzenie zestawu-lekcji z materiału źródłowego rodzica (design 2026-10-30,
 * §3.3). Kształt i opis pól: `DeckSourceDtoSchema` w `decks.ts` — wspólny
 * z zestawami słówek ze źródła; ta nazwa zostaje dla dotychczasowych użytkowników.
 */
export const LessonDeckSourceDtoSchema = DeckSourceDtoSchema;
export type LessonDeckSourceDto = z.infer<typeof LessonDeckSourceDtoSchema>;

/**
 * Pełny widok zestawu-lekcji dla panelu rodzica (`GET /parent/lessons/:deckId`):
 * edytowalny szkic (lub null), opublikowana wersja (lub null), najnowszy run
 * generacji szkicu i przypisania dzieci — odpowiednik `DeckDto` dla lekcji,
 * z `LessonDraftDto` zamiast `DraftDto`.
 */
export const LessonDeckDtoSchema = z.object({
  id: UuidSchema,
  title: z.string(),
  state: DeckStateSchema,
  /** Budżet zadań ocenianych sesji nauki tej lekcji; parse-time default 20
   * dla starszych ładunków, serwer zawsze wysyła bieżącą wartość. */
  sessionTaskBudget: SessionTaskBudgetSchema.default(20),
  draft: LessonDraftDtoSchema.nullable(),
  published: LessonDraftDtoSchema.nullable(),
  generation: GenerationDtoSchema.nullable(),
  assignments: z.array(AssignmentDtoSchema),
  /** Pochodzenie z materiału źródłowego rodzica; brak pola — wklejony tekst albo źródło usunięto. */
  source: LessonDeckSourceDtoSchema.optional(),
  /**
   * Informacja o providerze oceny dowolnych odpowiedzi (wymaganie 10.1). Bez
   * sekretów — tylko czy model jest dostępny i jego nazwa z konfiguracji.
   */
  grading: z.object({
    available: z.boolean(),
    model: z.string().min(1).optional(),
  }),
});
export type LessonDeckDto = z.infer<typeof LessonDeckDtoSchema>;

/**
 * Szczegóły błędu publikacji przy brakującym pokryciu (409): lista braków per
 * cel i etap. Trafia do `ApiError.details.coverage` (wspólny format błędu §12).
 */
export const LessonCoverageErrorSchema = z.object({
  coverage: z.array(CoverageGapDtoSchema),
});
export type LessonCoverageError = z.infer<typeof LessonCoverageErrorSchema>;

/**
 * Szczegóły błędu edycji ćwiczeń (400): dla każdego niepoprawnego ćwiczenia
 * jego indeks na liście i lista komunikatów walidacji. Trafia do
 * `ApiError.details.exercises`.
 */
export const LessonExerciseErrorsSchema = z.object({
  exercises: z.array(z.object({
    index: z.number().int().nonnegative(),
    errors: z.array(z.string().min(1)),
  })),
});
export type LessonExerciseErrors = z.infer<typeof LessonExerciseErrorsSchema>;

const ObjectiveStatusSchema = z.enum([
  "not_assessed",
  "learning",
  "needs_confirmation",
  "needs_reconfirmation",
  "mastered",
]);
/**
 * Agregat szkolny postępu celu (Etap 2): wiedza i precyzja OSOBNO; precyzja
 * nigdy nie wpływa na status ani opanowanie. Tylko zestawy z odpowiedziami
 * otwartymi szkoły; gramatyka pola nie niesie.
 */
/** Para pomylonych pojęć z liczbą wystąpień (raport rodzica, design szkoły §9.4). */
export const ConfusionCountSchema = z.object({
  said: z.string().min(1).max(60),
  meant: z.string().min(1).max(60),
  count: z.number().int().positive(),
}).strict();
export type ConfusionCountDto = z.infer<typeof ConfusionCountSchema>;

export const SchoolProgressSchema = z.object({
  knowledge: z.object({
    correct: z.number().int().nonnegative(),
    partial: z.number().int().nonnegative(),
    incorrect: z.number().int().nonnegative(),
  }),
  precision: z.object({
    concise: z.number().int().nonnegative(),
    verbose: z.number().int().nonnegative(),
    unfocused: z.number().int().nonnegative(),
  }),
  /** Najczęściej brakujące elementy wymagane (teksty), malejąco. */
  topMissing: z.array(z.object({ text: z.string().min(1), count: z.number().int().nonnegative() })).max(5),
  /** Ostatnie odpowiedzi dziecka (podgląd dla rodzica). */
  recentAnswers: z.array(z.object({
    text: z.string(),
    knowledge: z.enum(["correct", "partial", "incorrect"]),
    precision: z.enum(["concise", "verbose", "unfocused"]).nullable(),
    /** Sposób wprowadzenia (Etap 3); brak = starszy serwer, czyli klawiatura. */
    inputMethod: z.enum(["keyboard", "speech"]).optional(),
  })).max(5),
  /**
   * Wiedza osobno dla odpowiedzi pisanych i dyktowanych (wym. 6.3). Suma obu
   * równa się `knowledge`; `speech.edited` liczy dyktowania poprawione przed
   * wysłaniem. Brak = starszy serwer.
   */
  byInputMethod: z.object({
    keyboard: z.object({
      correct: z.number().int().nonnegative(),
      partial: z.number().int().nonnegative(),
      incorrect: z.number().int().nonnegative(),
    }),
    speech: z.object({
      correct: z.number().int().nonnegative(),
      partial: z.number().int().nonnegative(),
      incorrect: z.number().int().nonnegative(),
      edited: z.number().int().nonnegative(),
    }),
  }).optional(),
  /**
   * Usługa rozpoznawania mowy obecnej konfiguracji (nazwa modelu, bez adresu
   * i klucza), do której trafia głos dziecka przy dyktowaniu; null = dyktowanie
   * wyłączone. Brak = starszy serwer.
   */
  speechService: z.string().min(1).nullable().optional(),
  /** Pomylone pojęcia z ocen odpowiedzi otwartych (werdykt v3), malejąco; brak = starszy serwer. */
  topConfusions: z.array(ConfusionCountSchema).max(5).optional(),
  /** Oceny z fragmentami „poprawne, ale zbędne” i „nie na temat” (v3); brak = starszy serwer. */
  fragmentKinds: z.object({
    redundant: z.number().int().nonnegative(),
    offTopic: z.number().int().nonnegative(),
  }).optional(),
  /**
   * Trener precyzji: zaproponowane skrócenia (zadania następcze), podjęte
   * poprawki i udane (krótsze, bez utraty elementu wymaganego) oraz ostatnie
   * pary oryginał → poprawka. Poprawki nie wchodzą do liczników wiedzy wyżej.
   */
  shortening: z.object({
    offered: z.number().int().nonnegative(),
    attempted: z.number().int().nonnegative(),
    successful: z.number().int().nonnegative(),
    recent: z.array(z.object({
      original: z.string(),
      revision: z.string(),
      lostElements: z.array(z.string()).max(6),
      successful: z.boolean(),
    })).max(3),
  }).optional(),
});


/** Postęp celu dla rodzica (design „Kwalifikacja i projekcja celów”). */
export const ObjectiveProgressDtoSchema = z.object({
  objectiveId: z.string().min(1),
  titlePl: z.string().min(1),
  status: ObjectiveStatusSchema,
  lastIndependentAt: InstantSchema.nullable(),
  nextReviewAt: InstantSchema.nullable(),
  /** Pula ćwiczeń celu wyczerpana dla dziecka (podpowiedź „Dogeneruj”). */
  poolExhausted: z.boolean(),
  topErrors: z.array(z.object({
    category: z.string().min(1),
    labelPl: z.string().min(1),
    count: z.number().int().nonnegative(),
    examples: z.array(z.string()).max(3),
  })),
  school: SchoolProgressSchema.optional(),
});
export type ObjectiveProgressDto = z.infer<typeof ObjectiveProgressDtoSchema>;

/** Decyzja rodzica nad werdyktem modelu (design `lesson_verdicts`). */
export const LessonVerdictDecisionSchema = z.enum([
  "confirmed",
  "overridden_correct",
  "overridden_incorrect",
]);
export type LessonVerdictDecision = z.infer<typeof LessonVerdictDecisionSchema>;

/**
 * Werdykt oceny dowolnej odpowiedzi dla rodzica (design `lesson_verdicts`).
 * `childAnswer` to `normalized_answer` (materiał wspólny, bez kolumn dziecka).
 */
export const LessonVerdictDtoSchema = z.object({
  id: UuidSchema,
  exerciseRevisionId: UuidSchema,
  objectiveId: z.string().min(1),
  childAnswer: z.string(),
  verdict: z.enum(["correct", "almost", "incorrect"]),
  errorCategory: z.string().min(1).nullable(),
  note: z.string(),
  graderModel: z.string().min(1),
  parentDecision: LessonVerdictDecisionSchema.nullable(),
  createdAt: InstantSchema,
  /** Wymiar szkolny werdyktu v2 (null dla werdyktów gramatyki). */
  school: z.object({
    knowledge: z.enum(["correct", "partial", "incorrect"]),
    precision: z.enum(["concise", "verbose", "unfocused"]),
    matchedElementIds: z.array(z.string()),
    missingElementIds: z.array(z.string()),
  }).nullable().optional(),
});
export type LessonVerdictDto = z.infer<typeof LessonVerdictDtoSchema>;

/** Raport próbnej kartkówki lekcji per cel (design „Testing”, requirements 9.4). */
export const LessonMockTestReportDtoSchema = z.object({
  /** Identyfikator sesji kartkówki — klucz do otwarcia szczegółów na liście rodzica. */
  sessionId: UuidSchema,
  objectives: z.array(z.object({
    objectiveId: z.string().min(1),
    titlePl: z.string().min(1),
    total: z.number().int().nonnegative(),
    correct: z.number().int().nonnegative(),
    incorrect: z.number().int().nonnegative(),
    unassessed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    modelGraded: z.number().int().nonnegative(),
    errorCategories: z.array(z.object({
      category: z.string().min(1),
      labelPl: z.string().min(1),
      count: z.number().int().nonnegative(),
    })),
    /**
     * Przedmiot szkolny (design §8.1): wiedza i precyzja odpowiedzi otwartych
     * tej kartkówki. Brak pola = brak ocenionych odpowiedzi otwartych albo
     * raport zamrożony przed Etapem 5.
     */
    school: z.object({
      knowledge: z.object({
        correct: z.number().int().nonnegative(),
        partial: z.number().int().nonnegative(),
        incorrect: z.number().int().nonnegative(),
      }).strict(),
      precision: z.object({
        concise: z.number().int().nonnegative(),
        verbose: z.number().int().nonnegative(),
        unfocused: z.number().int().nonnegative(),
      }).strict(),
      formViolations: z.number().int().nonnegative(),
      missingElements: z.array(z.object({ text: z.string().min(1), count: z.number().int().positive() }).strict()).max(5),
      /** Pomylone pojęcia w tej kartkówce (werdykt v3, design §9.4); brak = raport sprzed Etapu 6. */
      confusions: z.array(ConfusionCountSchema).max(3).optional(),
    }).strict().optional(),
  })),
  complete: z.boolean(),
  taskBudget: z.number().int().nonnegative(),
  /** Początek i koniec kartkówki (jak w `MockTestReportDto` słówek) — data na liście rodzica. */
  startedAt: InstantSchema,
  endedAt: InstantSchema,
});
export type LessonMockTestReportDto = z.infer<typeof LessonMockTestReportDtoSchema>;

/**
 * Omówienie kartkówki lekcji dla dziecka po zamknięciu (requirements 9.4,
 * SPEC §19.1). Lista rozwiązanych slotów z odpowiedzią dziecka i poprawną
 * odpowiedzią oraz prostym wynikiem per zadanie (bez procentów, bez kategorii
 * błędów, bez werdyktu modelu). `score`/`answeredCount` dają wynik X/Y
 * (wyjątek procentowy omówienia liczy UI). Odpowiada roli `MockTestSummaryDto`
 * słówek, ale per cel lekcji zamiast per umiejętność słówkową.
 */
export const LessonMockTestSummaryDtoSchema = z.object({
  sessionId: UuidSchema,
  deckId: UuidSchema,
  state: z.enum(["completed", "ended"]),
  complete: z.boolean(),
  taskBudget: z.number().int().nonnegative(),
  answeredCount: z.number().int().nonnegative(),
  solutions: z.array(z.object({
    taskId: UuidSchema,
    objectiveId: z.string().min(1),
    titlePl: z.string().min(1),
    exerciseType: LessonExerciseTypeSchema,
    /** Treść promptu pokazywana dziecku (bez klucza odpowiedzi). */
    prompt: z.string(),
    /** Odpowiedź dziecka jako tekst (puste dla pominiętego slotu). */
    childAnswer: z.string(),
    correctAnswer: z.string(),
    outcome: z.enum(["correct", "incorrect", "skipped", "unassessed"]),
    /** Wskazówka precyzji (design §8.2) — gotowe zdanie z katalogu, bez kategorii i liczb. */
    hintPl: z.string().min(1).optional(),
  })),
  /** „Warto powtórzyć” (design §8.3): zagadnienia z błędną, niepełną albo pominiętą odpowiedzią. */
  reviewObjectives: z.array(z.object({ objectiveId: z.string().min(1), titlePl: z.string().min(1) }).strict()).max(8).optional(),
});
export type LessonMockTestSummaryDto = z.infer<typeof LessonMockTestSummaryDtoSchema>;
