import { z } from "zod";
import { UuidSchema, VocabularyFormatSchema } from "./common";
import { GenerationDtoSchema } from "./generation";
import { TestGoalsSchema, MockTestTaskCountSchema } from "./mock-tests";
import { ChildInterestsSchema } from "./child-interests";
import { MAX_DECK_ITEMS } from "./limits";

export const RecordingModeSchema = z.enum(["hold", "toggle"]);
export type RecordingModeDto = z.infer<typeof RecordingModeSchema>;

/**
 * Profil dziecka. Input pochodzi od rodzica; DTO dodaje identyfikator.
 * Ograniczenia odzwierciedlają CHECK-i w learning_app.child_profiles.
 */
export const ChildInputSchema = z.object({
  displayName: z.string().min(1).max(80),
  avatarKey: z.string().min(1).max(40),
  birthYear: z.number().int().min(1900).max(2200).optional(),
  canRead: z.boolean().default(true),
});
export type ChildInput = z.input<typeof ChildInputSchema>;

/** Częściowa edycja danych profilu, bez zmiany tożsamości i historii. */
export const ChildPatchSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  avatarKey: z.string().min(1).max(40).optional(),
  recordingMode: RecordingModeSchema.optional(),
  canRead: z.boolean().optional(),
  interests: ChildInterestsSchema.optional(),
}).strict().refine((input) => input.recordingMode !== undefined || input.displayName !== undefined || input.avatarKey !== undefined || input.canRead !== undefined || input.interests !== undefined, {
  message: "At least one profile field is required",
});
export type ChildPatch = z.infer<typeof ChildPatchSchema>;

export const ChildDtoSchema = ChildInputSchema.extend({
  id: UuidSchema,
  recordingMode: RecordingModeSchema,
  canRead: z.boolean(),
  /** Zainteresowania zapisane w profilu; DTO nie normalizuje (robi to wejście `ChildPatch`). */
  interests: z.array(z.string()),
});
export type ChildDto = z.infer<typeof ChildDtoSchema>;

export const PronunciationAttemptDtoSchema = z.object({
  word: z.string().min(1),
  score: z.number(),
  band: z.enum(["correct", "partial", "below"]).nullable(),
  attemptedAt: z.string().min(1),
});

export const PronunciationSettingsDtoSchema = z.object({
  pronunciationAvailable: z.boolean(),
  thresholds: z.object({ correctMinScore: z.number(), partialMinScore: z.number() }).nullable(),
  attempts: z.array(PronunciationAttemptDtoSchema).max(20),
});

export const PronunciationBandsInputSchema = z.object({
  correctMinScore: z.number().int().min(0).max(100),
  partialMinScore: z.number().int().min(0).max(100),
}).refine((input) => input.correctMinScore > input.partialMinScore, {
  message: "correctMinScore must be greater than partialMinScore",
});

export type PronunciationSettingsDto = z.infer<typeof PronunciationSettingsDtoSchema>;
export type PronunciationBandsInput = z.infer<typeof PronunciationBandsInputSchema>;

export function toChildDto(row: {
  id: string;
  displayName: string;
  avatarKey: string;
  birthYear: number | null;
  recordingMode: RecordingModeDto;
  canRead: boolean;
  interests: string[];
}): ChildDto {
  return {
    id: row.id,
    displayName: row.displayName,
    avatarKey: row.avatarKey,
    recordingMode: row.recordingMode,
    canRead: row.canRead,
    interests: row.interests,
    ...(row.birthYear === null ? {} : { birthYear: row.birthYear }),
  };
}

/** Typ wizualizacji: obraz/czynność przez provider, reszta renderowana deterministycznie. */
export const VisualTypeSchema = z.enum(["image", "color", "number", "sequence", "none"]);
export type VisualType = z.infer<typeof VisualTypeSchema>;

export const ColorVisualDataSchema = z.object({
  color: z.string().regex(/^#[\da-f]{6}$/i),
}).strict();
export const NumberVisualDataSchema = z.object({
  count: z.number().int().min(0).max(50),
}).strict();
export const SequenceVisualDataSchema = z.object({
  position: z.number().int().min(1).max(12),
  total: z.number().int().min(1).max(12),
  sequenceStart: z.string().min(1).max(40),
}).strict().refine(({ position, total }) => position <= total);

const WEEKDAY_POSITIONS: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

const ENGLISH_NUMBER_VALUES: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
};

const ENGLISH_NUMBER_UNITS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
};

const ENGLISH_COLOR_HEXES: Record<string, string> = {
  red: "#ff0000",
  blue: "#0000ff",
  green: "#008000",
  yellow: "#ffff00",
  orange: "#ffa500",
  purple: "#800080",
  pink: "#ffc0cb",
  black: "#000000",
  white: "#ffffff",
  brown: "#a52a2a",
  gray: "#808080",
  grey: "#808080",
};

function knownEnglishNumber(target: string | undefined): number | undefined {
  const word = target?.trim().toLowerCase().replace(/[\s-]/g, "");
  if (!word) return undefined;
  if (/^\d+$/.test(word)) {
    const numeric = Number(word);
    return Number.isInteger(numeric) && numeric >= 0 && numeric <= 50 ? numeric : undefined;
  }
  const exact = ENGLISH_NUMBER_VALUES[word];
  if (exact !== undefined) return exact;
  for (const [tensWord, tensValue] of Object.entries(ENGLISH_NUMBER_VALUES)) {
    if (tensValue < 20 || tensValue % 10 !== 0 || !word.startsWith(tensWord)) continue;
    const unitValue = ENGLISH_NUMBER_UNITS[word.slice(tensWord.length) ?? ""];
    if (unitValue !== undefined) return tensValue + unitValue;
  }
  return undefined;
}

/** Waliduje dane rendererów deterministycznych przy granicy kontraktu. */
export function isVisualDataValid(
  visualType: VisualType,
  visualData: Record<string, unknown> | undefined,
  target?: string,
): boolean {
  if (visualData === undefined) {
    return visualType !== "color" && visualType !== "number" && visualType !== "sequence";
  }
  switch (visualType) {
    case "color": {
      const parsed = ColorVisualDataSchema.safeParse(visualData);
      if (!parsed.success) return false;
      const expectedColor = target === undefined ? undefined : ENGLISH_COLOR_HEXES[target.trim().toLowerCase()];
      return expectedColor === undefined || parsed.data.color.toLowerCase() === expectedColor;
    }
    case "number": {
      const parsed = NumberVisualDataSchema.safeParse(visualData);
      if (!parsed.success) return false;
      const expectedCount = knownEnglishNumber(target);
      return expectedCount === undefined || parsed.data.count === expectedCount;
    }
    case "sequence": {
      const parsed = SequenceVisualDataSchema.safeParse(visualData);
      if (!parsed.success) return false;
      const weekdayPosition = target === undefined ? undefined : WEEKDAY_POSITIONS[target.trim().toLowerCase()];
      if (weekdayPosition === undefined) return true;
      return parsed.data.position === weekdayPosition &&
        parsed.data.total === 7 &&
        parsed.data.sequenceStart.trim().toLowerCase() === "monday";
    }
    case "image":
    case "none":
      return true;
  }
}

export const LocalesSchema = z.object({
  source: z.string().min(2).max(10),
  target: z.string().min(2).max(10),
});

/**
 * Słownik zestawu. `id` opcjonalnie wskazuje istniejący learning_item przy
 * edycji szkicu; brak id oznacza nowy element. Limity z architecture.md §7
 * (120 znaków celu/źródła, 300 przykładu).
 */
export const VocabularyItemInputSchema = z.object({
  id: UuidSchema.optional(),
  source: z.string().min(1).max(120),
  target: z.string().min(1).max(120),
  acceptedAnswers: z.array(z.string().min(1).max(120)).max(20),
  locales: LocalesSchema,
  example: z.string().min(1).max(300).optional(),
  visualType: VisualTypeSchema,
  visualData: z.record(z.string(), z.unknown()).optional(),
}).refine((item) => isVisualDataValid(item.visualType, item.visualData, item.target), {
  path: ["visualData"],
  message: "visualData does not match visualType",
});
export type VocabularyItemInput = z.infer<typeof VocabularyItemInputSchema>;

export const DraftInputSchema = z.object({
  title: z.string().min(1).max(200),
  items: z.array(VocabularyItemInputSchema).min(1).max(MAX_DECK_ITEMS),
  vocabularyFormat: VocabularyFormatSchema.default("standard"),
});
export type DraftInput = z.input<typeof DraftInputSchema>;

/** Edycja szkicu z optimistic locking: wymagany expectedEditNumber. */
export const DraftPatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  items: z.array(VocabularyItemInputSchema).min(1).max(MAX_DECK_ITEMS).optional(),
  expectedEditNumber: z.number().int().positive(),
});
export type DraftPatch = z.infer<typeof DraftPatchSchema>;

export const DraftItemDtoSchema = VocabularyItemInputSchema.extend({
  revisionId: UuidSchema,
});
export type DraftItemDto = z.infer<typeof DraftItemDtoSchema>;

export const RevisionAssetDtoSchema = z.object({
  itemRevisionId: UuidSchema,
  role: z.enum(["target_audio", "example_audio", "illustration"]),
  /** failed = wyczerpane próby generacji; rodzic widzi porażkę, nie wieczny spinner */
  state: z.enum(["pending", "approved", "failed", "omitted"]),
  assetId: UuidSchema.nullable(),
});

export const DraftDtoSchema = z.object({
  id: UuidSchema,
  deckId: UuidSchema,
  editNumber: z.number().int().positive(),
  status: z.enum(["draft", "review", "published"]),
  vocabularyFormat: VocabularyFormatSchema.default("standard"),
  title: z.string(),
  items: z.array(DraftItemDtoSchema),
  assets: z.array(RevisionAssetDtoSchema),
});
export type DraftDto = z.infer<typeof DraftDtoSchema>;

/** Lokalna data rodziny (termin sprawdzianu): YYYY-MM-DD w strefie rodziny. */
export function isFamilyDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export const DeckStateSchema = z.enum(["draft", "review", "published", "archived"]);
export type DeckState = z.infer<typeof DeckStateSchema>;

/**
 * Budżet zadań ocenianych sesji nauki zestawu (`decks.session_task_budget`).
 * Te same granice co `MockTestTaskCountSchema` (1–100); domyślnie 20.
 */
export const SessionTaskBudgetSchema = z.number().int().min(1).max(100);

/** Aktywne przypisanie dziecka w skrócie listy zestawów (podzbiór AssignmentDto). */
export const DeckAssignedChildDtoSchema = z.object({
  childId: UuidSchema,
  displayName: z.string(),
  testDate: z.string().nullable(),
});
export type DeckAssignedChildDto = z.infer<typeof DeckAssignedChildDtoSchema>;

export const DeckSummaryDtoSchema = z.object({
  deckId: UuidSchema,
  title: z.string(),
  state: DeckStateSchema,
  /** Rodzaj zestawu; OPCJONALNE — brak pola oznacza „vocabulary” (zgodność wsteczna typu). */
  kind: z.enum(["vocabulary", "lesson"]).optional(),
  coverAssetId: UuidSchema.nullable().optional(),
  vocabularyFormat: VocabularyFormatSchema.default("standard"),
  editableVersionId: UuidSchema.nullable(),
  publishedVersionId: UuidSchema.nullable(),
  /** Meta listy; OPCJONALNE — starszy serwer może nie wysyłać. Liczba pozycji wersji
   * reprezentatywnej (published ?? editable; 0 gdy brak wersji). */
  itemCount: z.number().int().min(0).optional(),
  /** Budżet zadań ocenianych sesji nauki tego zestawu; parse-time default 20
   * dla starszych ładunków, serwer zawsze wysyła bieżącą wartość. */
  sessionTaskBudget: SessionTaskBudgetSchema.default(20),
  /** Aktywne przypisania dzieci, kolejność jak w widoku szczegółu zestawu. */
  assignedChildren: z.array(DeckAssignedChildDtoSchema).optional(),
});
export type DeckSummaryDto = z.infer<typeof DeckSummaryDtoSchema>;

export const AssignmentDtoSchema = z.object({
  testGoals: TestGoalsSchema.nullable(),
  mockTestTaskCount: MockTestTaskCountSchema,
  childId: UuidSchema,
  displayName: z.string(),
  testDate: z.string().nullable(),
  active: z.boolean(),
});
export type AssignmentDto = z.infer<typeof AssignmentDtoSchema>;

/**
 * Pochodzenie zestawu z materiału źródłowego rodzica (design 2026-10-30, §3.3):
 * tytuł źródła i rewizja jego TREŚCI skopiowana przy tworzeniu zestawu obok
 * bieżącej rewizji treści (`source_materials.body_revision`). Zmiana samego
 * tytułu źródła nie zmienia `currentRevision` — `currentRevision >
 * copiedRevision` znaczy, że tekst źródła zmieniono po skopiowaniu. Wspólny dla
 * zestawów-lekcji (`LessonDeckDto.source`) i zestawów słówek (`DeckDto.source`);
 * żyje tu (moduł niższy niż `lessons.ts` i `source-materials.ts`), by serwer
 * i panel rodzica typowały go z kontraktu bez cyklu importów.
 */
export const DeckSourceDtoSchema = z.object({
  id: UuidSchema,
  title: z.string(),
  copiedRevision: z.number().int().min(1),
  currentRevision: z.number().int().min(1),
}).strict();
export type DeckSourceDto = z.infer<typeof DeckSourceDtoSchema>;

/**
 * Widok zestawu dla panelu rodzica: edytowalny szkic (lub null), opublikowana
 * wersja, najnowszy run generacji szkicu oraz przypisania dzieci.
 */
export const DeckDtoSchema = z.object({
  id: UuidSchema,
  title: z.string(),
  state: DeckStateSchema,
  coverAssetId: UuidSchema.nullable().default(null),
  /** Budżet zadań ocenianych sesji nauki tego zestawu; parse-time default 20
   * dla starszych ładunków, serwer zawsze wysyła bieżącą wartość. */
  sessionTaskBudget: SessionTaskBudgetSchema.default(20),
  draft: DraftDtoSchema.nullable(),
  published: DraftDtoSchema.nullable(),
  generation: GenerationDtoSchema.nullable(),
  assignments: z.array(AssignmentDtoSchema),
  /** Pochodzenie ze źródła rodzica (tylko zestaw słówek ze źródła); brak pola — opis, ręczny zestaw albo źródło usunięto. */
  source: DeckSourceDtoSchema.optional(),
});
export type DeckDto = z.infer<typeof DeckDtoSchema>;

/**
 * PATCH /parent/decks/:id — ustawienia sesji nauki zestawu. Konfiguracja
 * runtime (jak `assignments`), nie treść: mutacja bez nowego szkicu wersji.
 * Pole jest wymagane — brak pola to błąd walidacji, a nie cicha zmiana.
 */
export const DeckSettingsPatchSchema = z.object({
  sessionTaskBudget: SessionTaskBudgetSchema,
});
export type DeckSettingsPatch = z.infer<typeof DeckSettingsPatchSchema>;

/** Polecenie usunięcia współdzielonej okładki zestawu. */
export const DeckCoverCommandSchema = z.object({ action: z.literal("clear") }).strict();

/** POST /parent/decks — tworzy nowy pusty szkic do ręcznej edycji. */
export const CreateEmptyDeckCommandSchema = z.object({
  deckId: UuidSchema,
  title: z.string().trim().min(1).max(200).optional(),
}).strict();
export type CreateEmptyDeckCommand = z.infer<typeof CreateEmptyDeckCommandSchema>;

/** Odpowiedź z utworzenia lub bezpiecznego ponowienia ręcznego szkicu. */
export const CreateEmptyDeckResultSchema = z.object({ deckId: UuidSchema }).strict();
export type CreateEmptyDeckResult = z.infer<typeof CreateEmptyDeckResultSchema>;

/** PUT /parent/assignments/:childId/:deckId — przypisanie i termin sprawdzianu. */
export const AssignmentPutSchema = z.object({
  testGoals: TestGoalsSchema.nullable().optional(),
  mockTestTaskCount: MockTestTaskCountSchema.optional(),
  testDate: z
    .string()
    .nullable()
    .refine((value) => value === null || isFamilyDate(value), {
      message: "testDate must be YYYY-MM-DD or null",
    }),
});
export type AssignmentPut = z.infer<typeof AssignmentPutSchema>;

export const PublishCommandSchema = z.object({
  expectedEditNumber: z.number().int().positive(),
});

export const RevisionAssetCommandSchema = z.object({
  itemRevisionId: UuidSchema,
  role: z.enum(["target_audio", "example_audio", "illustration"]),
});

export const OmitIllustrationSchema = z.object({
  itemRevisionId: UuidSchema,
});
