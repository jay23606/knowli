import { z } from "zod";
import { oc } from "@orpc/contract";
import { openapi } from "@orpc/openapi";
import {
  AssignmentPutSchema,
  CalculationSpecSchema,
  ChildDtoSchema,
  ChildInterestsSchema,
  ChildInputSchema,
  ChildPatchSchema,
  CreateEmptyDeckCommandSchema,
  CreateEmptyDeckResultSchema,
  DeckDtoSchema,
  DeckSettingsPatchSchema,
  DeckSummaryDtoSchema,
  DraftDtoSchema,
  DraftPatchSchema,
  GenerationCommandSchema,
  GenerationDtoSchema,
  LessonCommandSchema,
  MaterialLessonCommandSchema,
  SchoolLessonCommandSchema,
  SourceMaterialDtoSchema,
  SourceMaterialInputSchema,
  SourceMaterialPatchSchema,
  SourceMaterialSummaryDtoSchema,
  LessonDynamicTopicPatchSchema,
  LessonDeckDtoSchema,
  LessonDraftDtoSchema,
  LessonExerciseInputSchema,
  LessonStorySchema,
  LessonMockTestReportDtoSchema,
  LessonVerdictDecisionSchema,
  LessonVerdictDtoSchema,
  MockTestReportDtoSchema,
  ObjectiveProgressDtoSchema,
  OmitIllustrationSchema,
  ParentCostsDtoSchema,
  ParentCostsQuerySchema,
  ParentWorkCardDtoSchema,
  ParentWorkCardQuerySchema,
  ProgressDtoSchema,
  PronunciationBandsInputSchema,
  PronunciationSettingsDtoSchema,
  PublishCommandSchema,
  RevisionAssetCommandSchema,
  SubjectCatalogDtoSchema,
  UuidSchema,
} from "@learning/contracts";

/**
 * Kontrakt Parent API pod /api/v1/parent — WEWNĘTRZNY dla apps/web (plan oRPC
 * v2: kontrakt parent nie trafia do @learning/contracts, bo klient jest
 * wyłącznie panel w tej samej aplikacji). Obejmuje wszystkie grupy URL:
 * auth (login/setup/logout), children, decks, drafts, mock-tests, work-card,
 * lesson-catalog, lessons, lesson-verdicts, lesson-drafts, generation,
 * assignments, progress i sources (materiał źródłowy rodzica).
 * Schematy, ścieżki, metody, statusy (201/202/204) i nagłówki (no-store)
 * odwzorowują dekomisjonowane ręczne trasy (`parent/parent-router.ts` +
 * trasy children); prefix montowania dokleja handler przy `handle()`.
 *
 * Upload okładki: surowy strumień obrazu (octet-stream). Kontraktowym typem
 * ciała jest `ReadableStream | Blob` — serwer z meta `requestBodyHint:
 * "octet-stream"` zawsze dostaje surowy strumień (limit 5 MB egzekwuje
 * procedura), a klient panelu może wysłać `File` bez konwersji (Blob jest
 * przepuszczany przez serializator OpenAPILink). `inputStructure: "detailed"`
 * jest obowiązkowe — compact z parametrem ścieżki gubi strumieniowe ciało
 * (spike v2, dywergencja 5).
 */

/** Parametr ścieżki `{childId}` dla operacji na profilu dziecka. */
const ChildPathSchema = z.object({ childId: UuidSchema });
/** Parametr ścieżki `{deckId}` dla operacji na zestawie. */
const DeckPathSchema = z.object({ deckId: UuidSchema });
/** Parametr ścieżki `{draftId}` dla operacji na szkicu wersji. */
const DraftPathSchema = z.object({ draftId: UuidSchema });
/** Parametr ścieżki `{sessionId}` — sesja kartkówki (lista/raport mock-tests). */
const SessionPathSchema = z.object({ sessionId: UuidSchema });
/** Parametr ścieżki `{runId}` — run generacji (generation). */
const RunPathSchema = z.object({ runId: UuidSchema });
/** Parametr ścieżki `{verdictId}` — werdykt oceny odpowiedzi lekcji. */
const VerdictPathSchema = z.object({ verdictId: UuidSchema });
/** Parametr ścieżki `{lessonDraftId}` — wersja szkicu lekcji. */
const LessonDraftPathSchema = z.object({ lessonDraftId: UuidSchema });
/** Parametr ścieżki `{sourceId}` — źródło (materiał źródłowy rodzica). */
const SourcePathSchema = z.object({ sourceId: UuidSchema });
/** Parametry ścieżki `{childId}/{deckId}` — przypisanie zestawu dziecku. */
const ChildDeckPathSchema = z.object({ childId: UuidSchema, deckId: UuidSchema });

/** Wejście PATCH /children/{childId}: ścieżka + częściowa edycja profilu. */
const ChildUpdateInputSchema = ChildPatchSchema.extend({ childId: UuidSchema }).strict();
/** Wejście PUT /children/{childId}/pronunciation: ścieżka + progi wymowy. */
const PronunciationPutInputSchema = PronunciationBandsInputSchema.extend({ childId: UuidSchema });
/** Wejście PATCH /decks/{deckId}: ścieżka + ustawienia sesji nauki. */
const DeckSettingsInputSchema = DeckSettingsPatchSchema.extend({ deckId: UuidSchema });
/** Wejście PATCH /sources/{sourceId}: ścieżka + edycja z kontrolą rewizji. */
const SourceUpdateInputSchema = SourceMaterialPatchSchema.extend({ sourceId: UuidSchema });
/** Wynik POST /sources: identyfikator źródła (nowego albo istniejącego przy ponowieniu). */
const SourceCreateResultSchema = z.object({ id: UuidSchema });
/** Wejście PATCH /drafts/{draftId}: ścieżka + poprawki szkicu. */
const DraftEditInputSchema = DraftPatchSchema.extend({ draftId: UuidSchema });
/** Wejście POST /drafts/{draftId}/publish: ścieżka + optimistic locking. */
const DraftPublishInputSchema = PublishCommandSchema.extend({ draftId: UuidSchema });
/** Wejście POST /drafts/{draftId}/assets/regenerate: ścieżka + polecenie. */
const RevisionAssetInputSchema = RevisionAssetCommandSchema.extend({ draftId: UuidSchema });
/** Wejście POST /drafts/{draftId}/assets/omit: ścieżka + pomijana ilustracja. */
const OmitAssetInputSchema = OmitIllustrationSchema.extend({ draftId: UuidSchema });

/** Ciało uploadu okładki: surowe bajty obrazu poza JSON-em. */
const CoverBodySchema = z.union([z.instanceof(ReadableStream), z.instanceof(Blob)]);

/** Detailed input uploadu okładki: params + opcjonalne nagłówki + strumień. */
const CoverUploadInputSchema = z.object({
  params: DeckPathSchema,
  headers: z.object({ "content-type": z.string() }).optional(),
  body: CoverBodySchema,
});

/** Binarna propozycja okładki z Content-Type obrazu i no-store. */
const CoverProposalOutputSchema = z.object({
  status: z.literal(200).optional(),
  headers: z.object({ "content-type": z.string() }).loose(),
  body: z.instanceof(Blob),
});

/**
 * Szczegółowa odpowiedź HTTP (outputStructure: "detailed") z wymuszonym
 * `Cache-Control: no-store` — odczyty danych dziecka na żywo (kartkówki,
 * karta pracy, postęp celów, werdykty). Wzorzec z kontraktu kid API
 * (`packages/contracts/src/kid-api-contract.ts`): nagłówek jest wymagany,
 * więc implementacja, która go opuści, pada na walidacji wyjścia.
 */
function noStoreOutput<T extends z.ZodType>(body: T) {
  return z.object({
    status: z.literal(200).optional(),
    headers: z.object({ "cache-control": z.literal("no-store") }).loose(),
    body,
  });
}

/** Query listy kartkówek: dziecko × zestaw (GET /mock-tests). */
const MockTestsQuerySchema = z.object({ childId: UuidSchema, deckId: UuidSchema });

/** Query postępu słówek: dziecko × zestaw (GET /progress). */
const ProgressQuerySchema = z.object({ childId: UuidSchema, deckId: UuidSchema });

/** Wejście GET /lessons/{deckId}/progress: zestaw ze ścieżki + dziecko z query. */
const LessonProgressInputSchema = z.object({ deckId: UuidSchema, childId: UuidSchema });

/** Ciało POST /lesson-verdicts/{verdictId}/decision — decyzja rodzica. */
const VerdictDecisionInputSchema = VerdictPathSchema.extend({
  decision: LessonVerdictDecisionSchema,
}).strict();

/**
 * Polecenie dogenerowania ćwiczeń celu w szkicu lekcji — hoisted z inline
 * schematu legacy routera (`POST /lesson-drafts/:id/regenerate`). `deckId`
 * dokleja implementacja z `deckIdOfLessonVersion` — `regenerateObjective`
 * bierze deckId, nie identyfikator wersji.
 */
export const LessonRegenerateCommandSchema = z.object({
  objectiveId: z.string().min(1),
  count: z.number().int().positive(),
  expectedEditNumber: z.number().int().positive(),
  clientRequestId: UuidSchema,
}).strict();

/** Wejście POST /lesson-drafts/{lessonDraftId}/prompt-audio/regenerate: ścieżka + rewizja ćwiczenia. */
const LessonPromptAudioRegenerateInputSchema = z.object({
  lessonDraftId: UuidSchema,
  itemRevisionId: UuidSchema,
  /** Które nagranie ćwiczenia: pytanie (brak pola) albo wyjaśnienie błędu. Bez `.default()` — brak roli to wywołanie jak dotąd. */
  role: z.enum(["prompt_audio", "explanation_audio"]).optional(),
}).strict();

/** Wejście POST /lesson-drafts/{lessonDraftId}/card-audio/regenerate: ścieżka + miejsce karty w temacie. */
const LessonCardAudioRegenerateInputSchema = z.object({
  lessonDraftId: UuidSchema,
  objectiveId: z.string().min(1).max(200),
  cardIndex: z.number().int().nonnegative(),
}).strict();

/** Wejście POST /lesson-drafts/{lessonDraftId}/story-audio/regenerate: tylko ścieżka (jedno nagranie na wersję). */
const LessonStoryAudioRegenerateInputSchema = z.object({
  lessonDraftId: UuidSchema,
}).strict();

/** Wejście POST /lesson-drafts/{lessonDraftId}/story/regenerate: ścieżka + optimistic locking + idempotencja. */
const LessonStoryRegenerateInputSchema = z.object({
  lessonDraftId: UuidSchema,
  expectedEditNumber: z.number().int().positive(),
  clientRequestId: UuidSchema,
}).strict();

/** Wejście POST /lesson-drafts/{lessonDraftId}/regenerate: ścieżka + polecenie. */
const LessonRegenerateInputSchema = LessonRegenerateCommandSchema.extend({ lessonDraftId: UuidSchema });

/**
 * Patch edycji szkicu lekcji (PATCH /lesson-drafts/{lessonDraftId}) — kształt
 * `LessonDraftPatch` z domeny (`lesson-editor-state.ts` ma ten sam interfejs
 * po stronie klienta); semantyczną walidacją ćwiczeń dalej zajmuje się
 * `editLessonDraft`, granica pilnuje kształtu i limitów jak przy słówkach.
 */
const LessonDraftPatchContractSchema = z.object({
  expectedEditNumber: z.number().int().positive(),
  title: z.string().min(1).max(200).optional(),
  exercises: z.array(LessonExerciseInputSchema).optional(),
  examples: z.record(z.string(), z.array(z.string())).optional(),
  dynamicTopic: LessonDynamicTopicPatchSchema.optional(),
  /** Historyjka: obiekt zastępuje, null usuwa, brak pola nie zmienia. */
  story: LessonStorySchema.nullable().optional(),
  /** Historyjka, od której zaczęto edycję (null = bez historyjki); inna niż bieżąca przy `story` → conflict. */
  expectedStory: LessonStorySchema.nullable().optional(),
  interests: ChildInterestsSchema.optional(),
}).refine(
  (patch) =>
    patch.title !== undefined || patch.exercises !== undefined || patch.examples !== undefined ||
    patch.dynamicTopic !== undefined || patch.story !== undefined || patch.interests !== undefined,
  { message: "patch must change title, exercises, examples, dynamicTopic, story or interests" },
);

/** Wejście PATCH /lesson-drafts/{lessonDraftId}: ścieżka + patch edycji. */
const LessonDraftEditInputSchema = LessonDraftPatchContractSchema.extend({ lessonDraftId: UuidSchema });

/** Wejście POST /lesson-drafts/{lessonDraftId}/publish: ścieżka + optimistic locking. */
const LessonDraftPublishInputSchema = PublishCommandSchema.extend({ lessonDraftId: UuidSchema });

/** Wejście PUT /assignments/{childId}/{deckId}: ścieżka + ustawienia przypisania. */
const AssignmentPutInputSchema = AssignmentPutSchema.extend({
  childId: UuidSchema,
  deckId: UuidSchema,
});

/** Wejście POST /login i POST /setup: sekret PIN/hasła rodzica. */
const SecretInputSchema = z.object({ secret: z.string().min(1) }).strict();

/** Stan ekranu logowania (GET /login): czy pokazać setup pierwszego uruchomienia. */
const AuthStateOutputSchema = z.object({
  authenticated: z.boolean(),
  setupRequired: z.boolean(),
});

/**
 * Kontrakt Parent API — zagnieżdżenie odzwierciedla grupy URL pierwszego
 * segmentu ścieżki (children, decks, drafts, …, progress).
 */
export const parentApiContract = {
  children: {
    list: oc
      .output(ChildDtoSchema.array())
      .meta(openapi({ method: "GET", path: "/children" })),

    create: oc
      .input(ChildInputSchema)
      .output(ChildDtoSchema)
      .meta(openapi({ method: "POST", path: "/children", successStatus: 201 })),

    update: oc
      .input(ChildUpdateInputSchema)
      .output(ChildDtoSchema)
      .meta(openapi({ method: "PATCH", path: "/children/{childId}" })),

    remove: oc
      .input(ChildPathSchema)
      .output(z.void())
      .meta(openapi({ method: "DELETE", path: "/children/{childId}", successStatus: 204 })),

    getPronunciation: oc
      .input(ChildPathSchema)
      .output(PronunciationSettingsDtoSchema)
      .meta(openapi({ method: "GET", path: "/children/{childId}/pronunciation" })),

    putPronunciation: oc
      .input(PronunciationPutInputSchema)
      .output(z.void())
      .meta(openapi({ method: "PUT", path: "/children/{childId}/pronunciation", successStatus: 204 })),
  },

  decks: {
    list: oc
      .output(DeckSummaryDtoSchema.array())
      .meta(openapi({ method: "GET", path: "/decks" })),

    generate: oc
      .input(GenerationCommandSchema)
      .output(z.object({ generationRunId: UuidSchema, deckId: UuidSchema }))
      .meta(openapi({ method: "POST", path: "/decks/generate", successStatus: 202 })),

    create: oc
      .input(CreateEmptyDeckCommandSchema)
      // 201 przy utworzeniu, 200 przy bezpiecznym ponowieniu tego samego
      // polecenia — status wynika z `created` w wyniku przypadku użycia.
      .output(z.object({
        status: z.union([z.literal(201), z.literal(200)]),
        headers: z.record(z.string(), z.string()).optional(),
        body: CreateEmptyDeckResultSchema,
      }))
      .meta(openapi({ method: "POST", path: "/decks", outputStructure: "detailed" })),

    get: oc
      .input(DeckPathSchema)
      .output(DeckDtoSchema)
      .meta(openapi({ method: "GET", path: "/decks/{deckId}" })),

    updateSettings: oc
      .input(DeckSettingsInputSchema)
      .output(DeckSettingsPatchSchema)
      .meta(openapi({ method: "PATCH", path: "/decks/{deckId}" })),

    setCover: oc
      .input(CoverUploadInputSchema)
      .output(z.object({ coverAssetId: UuidSchema }))
      .meta(openapi({
        method: "POST",
        path: "/decks/{deckId}/cover",
        inputStructure: "detailed",
        requestBodyHint: "octet-stream",
      })),

    clearCover: oc
      .input(DeckPathSchema)
      .output(z.void())
      .meta(openapi({ method: "DELETE", path: "/decks/{deckId}/cover", successStatus: 204 })),

    generateCover: oc
      .input(DeckPathSchema)
      .output(CoverProposalOutputSchema)
      .meta(openapi({
        method: "POST",
        path: "/decks/{deckId}/cover/generate",
        outputStructure: "detailed",
        responseBodyHint: "file",
      })),

    createDraft: oc
      .input(DeckPathSchema)
      .output(DraftDtoSchema)
      .meta(openapi({ method: "POST", path: "/decks/{deckId}/draft", successStatus: 201 })),

    archive: oc
      .input(DeckPathSchema)
      .output(z.void())
      .meta(openapi({ method: "POST", path: "/decks/{deckId}/archive", successStatus: 204 })),
  },

  drafts: {
    get: oc
      .input(DraftPathSchema)
      .output(DraftDtoSchema)
      .meta(openapi({ method: "GET", path: "/drafts/{draftId}" })),

    edit: oc
      .input(DraftEditInputSchema)
      .output(DraftDtoSchema)
      .meta(openapi({ method: "PATCH", path: "/drafts/{draftId}" })),

    publish: oc
      .input(DraftPublishInputSchema)
      .output(z.object({ deckVersionId: UuidSchema }))
      .meta(openapi({ method: "POST", path: "/drafts/{draftId}/publish" })),

    regenerateAsset: oc
      .input(RevisionAssetInputSchema)
      .output(z.object({ assetId: UuidSchema }))
      .meta(openapi({ method: "POST", path: "/drafts/{draftId}/assets/regenerate", successStatus: 202 })),

    omitAsset: oc
      .input(OmitAssetInputSchema)
      .output(z.void())
      .meta(openapi({ method: "POST", path: "/drafts/{draftId}/assets/omit", successStatus: 204 })),
  },

  /**
   * Kartkówki (mock-tests): lista per dziecko×zestaw i raport jednej sesji.
   * Wybór kształtu (słówka vs lekcja) robi publiczna operacja raportowania
   * serwera, więc output jest unią raportów obu rodzajów.
   */
  mockTests: {
    list: oc
      .input(MockTestsQuerySchema)
      .output(noStoreOutput(z.union([
        MockTestReportDtoSchema.array(),
        LessonMockTestReportDtoSchema.array(),
      ])))
      .meta(openapi({ method: "GET", path: "/mock-tests", outputStructure: "detailed" })),

    get: oc
      .input(SessionPathSchema)
      .output(noStoreOutput(z.union([MockTestReportDtoSchema, LessonMockTestReportDtoSchema])))
      .meta(openapi({ method: "GET", path: "/mock-tests/{sessionId}", outputStructure: "detailed" })),
  },

  /** Karta pracy dnia (work-card): dane dnia wyliczane per żądanie. */
  workCard: {
    get: oc
      .input(ParentWorkCardQuerySchema)
      .output(noStoreOutput(ParentWorkCardDtoSchema))
      .meta(openapi({ method: "GET", path: "/work-card", outputStructure: "detailed" })),
  },

  /** Koszty usług AI (miesiąc, funkcje, materiały, dzieci): dane administracyjne rodzica, odczyt na żywo. */
  costs: {
    get: oc
      .input(ParentCostsQuerySchema)
      .output(noStoreOutput(ParentCostsDtoSchema))
      .meta(openapi({ method: "GET", path: "/costs", outputStructure: "detailed" })),
  },

  /** Katalog przedmiotów/tematów/reguł dla formularza nowej lekcji. */
  lessonCatalog: {
    get: oc
      .output(SubjectCatalogDtoSchema)
      .meta(openapi({ method: "GET", path: "/lesson-catalog" })),
  },

  /** Zestawy-lekcje: tworzenie, widok, postęp celów, werdykty, nowy szkic. */
  lessons: {
    previewCalculation: oc
      .input(CalculationSpecSchema)
      .output(z.object({ prompt: z.string(), answer: z.string() }).strict())
      .meta(openapi({ method: "POST", path: "/lessons/preview-calculation" })),

    create: oc
      .input(LessonCommandSchema)
      .output(z.object({ runId: UuidSchema, deckId: UuidSchema }))
      .meta(openapi({ method: "POST", path: "/lessons", successStatus: 202 })),

    createSchool: oc
      .input(SchoolLessonCommandSchema)
      .output(z.object({ runId: UuidSchema, deckId: UuidSchema }))
      .meta(openapi({ method: "POST", path: "/lessons/school", successStatus: 202 })),

    createFromMaterial: oc
      .input(MaterialLessonCommandSchema)
      .output(z.object({ runId: UuidSchema, deckId: UuidSchema }))
      .meta(openapi({ method: "POST", path: "/lessons/material", successStatus: 202 })),

    get: oc
      .input(DeckPathSchema)
      .output(LessonDeckDtoSchema)
      .meta(openapi({ method: "GET", path: "/lessons/{deckId}" })),

    progress: oc
      .input(LessonProgressInputSchema)
      .output(noStoreOutput(ObjectiveProgressDtoSchema.array()))
      .meta(openapi({ method: "GET", path: "/lessons/{deckId}/progress", outputStructure: "detailed" })),

    verdicts: oc
      .input(DeckPathSchema)
      .output(noStoreOutput(LessonVerdictDtoSchema.array()))
      .meta(openapi({ method: "GET", path: "/lessons/{deckId}/verdicts", outputStructure: "detailed" })),

    draft: oc
      .input(DeckPathSchema)
      .output(LessonDraftDtoSchema)
      .meta(openapi({ method: "POST", path: "/lessons/{deckId}/draft", successStatus: 201 })),
  },

  /** Werdykty oceny odpowiedzi lekcji — decyzje rodzica. */
  lessonVerdicts: {
    decision: oc
      .input(VerdictDecisionInputSchema)
      .output(LessonVerdictDtoSchema)
      .meta(openapi({ method: "POST", path: "/lesson-verdicts/{verdictId}/decision" })),

    acceptAsVariant: oc
      .input(VerdictPathSchema)
      .output(z.object({ deckVersionId: UuidSchema, added: z.boolean() }))
      .meta(openapi({ method: "POST", path: "/lesson-verdicts/{verdictId}/accept-as-variant" })),
  },

  /** Szkice wersji lekcji: edycja, publikacja, dogenerowanie celu. */
  lessonDrafts: {
    edit: oc
      .input(LessonDraftEditInputSchema)
      .output(LessonDraftDtoSchema)
      .meta(openapi({ method: "PATCH", path: "/lesson-drafts/{lessonDraftId}" })),

    publish: oc
      .input(LessonDraftPublishInputSchema)
      .output(z.object({ deckVersionId: UuidSchema }))
      .meta(openapi({ method: "POST", path: "/lesson-drafts/{lessonDraftId}/publish" })),

    regenerate: oc
      .input(LessonRegenerateInputSchema)
      .output(z.object({ generationRunId: UuidSchema, deckId: UuidSchema }))
      .meta(openapi({ method: "POST", path: "/lesson-drafts/{lessonDraftId}/regenerate", successStatus: 202 })),

    /** „Nagraj ponownie” pytania (spec tonu TTS §4.5): nowa generacja nagrania; tylko szkic. */
    regeneratePromptAudio: oc
      .input(LessonPromptAudioRegenerateInputSchema)
      .output(z.object({ assetId: UuidSchema }))
      .meta(openapi({ method: "POST", path: "/lesson-drafts/{lessonDraftId}/prompt-audio/regenerate", successStatus: 202 })),

    /** „Nagraj ponownie” karty zagadnienia (spec tonu TTS §4.5): nowa generacja nagrania; tylko szkic. */
    regenerateCardAudio: oc
      .input(LessonCardAudioRegenerateInputSchema)
      .output(z.object({ assetId: UuidSchema }))
      .meta(openapi({ method: "POST", path: "/lesson-drafts/{lessonDraftId}/card-audio/regenerate", successStatus: 202 })),

    /** „Nagraj ponownie” historyjki (design „Historyjka lekcji” §7): nowa generacja nagrania lektora; tylko szkic. */
    regenerateStoryAudio: oc
      .input(LessonStoryAudioRegenerateInputSchema)
      .output(z.object({ assetId: UuidSchema }))
      .meta(openapi({ method: "POST", path: "/lesson-drafts/{lessonDraftId}/story-audio/regenerate", successStatus: 202 })),

    /** „Wygeneruj historyjkę” (spec historyjki lekcji): zleca run generowania; tylko szkic. */
    regenerateStory: oc
      .input(LessonStoryRegenerateInputSchema)
      .output(z.object({ runId: UuidSchema, deckId: UuidSchema }))
      .meta(openapi({ method: "POST", path: "/lesson-drafts/{lessonDraftId}/story/regenerate", successStatus: 202 })),
  },

  /** Runy generacji materiałów: odczyt statusu i ponowienie nieudanego. */
  generation: {
    get: oc
      .input(RunPathSchema)
      .output(GenerationDtoSchema)
      .meta(openapi({ method: "GET", path: "/generation/{runId}" })),

    retry: oc
      .input(RunPathSchema)
      .output(z.object({ runId: UuidSchema }))
      .meta(openapi({ method: "POST", path: "/generation/{runId}/retry" })),
  },

  /** Przypisania zestawów dzieciom z terminami sprawdzianów. */
  assignments: {
    put: oc
      .input(AssignmentPutInputSchema)
      .output(z.void())
      .meta(openapi({ method: "PUT", path: "/assignments/{childId}/{deckId}", successStatus: 204 })),

    remove: oc
      .input(ChildDeckPathSchema)
      .output(z.void())
      .meta(openapi({ method: "DELETE", path: "/assignments/{childId}/{deckId}", successStatus: 204 })),
  },

  /** Postęp nauki słówek dla pary dziecko × zestaw (panel postępów). */
  progress: {
    get: oc
      .input(ProgressQuerySchema)
      .output(ProgressDtoSchema)
      .meta(openapi({ method: "GET", path: "/progress" })),
  },

  /**
   * Źródła (materiał źródłowy rodzica): wklejony tekst rozdziału, z którego
   * powstają lekcje. Wyłącznie Parent API — źródeł nie ma w Kid API ani w MCP.
   */
  sources: {
    list: oc
      .output(SourceMaterialSummaryDtoSchema.array())
      .meta(openapi({ method: "GET", path: "/sources" })),

    create: oc
      .input(SourceMaterialInputSchema)
      // 201 przy utworzeniu, 200 przy bezpiecznym ponowieniu z tym samym
      // `clientRequestId` i treścią — status wynika z `created` przypadku użycia.
      .output(z.object({
        status: z.union([z.literal(201), z.literal(200)]),
        headers: z.record(z.string(), z.string()).optional(),
        body: SourceCreateResultSchema,
      }))
      .meta(openapi({ method: "POST", path: "/sources", outputStructure: "detailed" })),

    get: oc
      .input(SourcePathSchema)
      .output(SourceMaterialDtoSchema)
      .meta(openapi({ method: "GET", path: "/sources/{sourceId}" })),

    update: oc
      .input(SourceUpdateInputSchema)
      .output(SourceMaterialDtoSchema)
      .meta(openapi({ method: "PATCH", path: "/sources/{sourceId}" })),

    delete: oc
      .input(SourcePathSchema)
      .output(z.void())
      .meta(openapi({ method: "DELETE", path: "/sources/{sourceId}", successStatus: 204 })),
  },

  /**
   * Bootstrap autoryzacji rodzica (dekomisjonowane trasy statyczne
   * login/setup/logout). Te procedury celowo NIE wymagają sesji rodzica —
   * kontrakt jest obsługiwany przez osobny implementer bez
   * `parentSessionMiddleware` w `../orpc/parent-router`. Login/logout
   * wystawiają `set-cookie` przez `outputStructure: "detailed"` (spike v2:
   * klucze nagłówków małymi literami); atrybuty ciastka buduje `sessionCookie`/
   * `clearingSessionCookie`, więc są bajt w bajt jak w legacy. Setup NIE
   * loguje — cookie wystawia dopiero POST /login (paritet z ParentApp).
   */
  auth: {
    state: oc
      .output(AuthStateOutputSchema)
      .meta(openapi({ method: "GET", path: "/login" })),

    login: oc
      .input(SecretInputSchema)
      .output(z.object({
        status: z.literal(200).optional(),
        headers: z.object({ "set-cookie": z.string() }),
        body: z.object({ expiresAt: z.string() }),
      }))
      .meta(openapi({ method: "POST", path: "/login", outputStructure: "detailed" })),

    logout: oc
      // 204 nie może nieść ciała (wzorzec sessions.next) — samo czyszczące cookie.
      .output(z.object({
        status: z.literal(204),
        headers: z.object({ "set-cookie": z.string() }),
      }))
      .meta(openapi({ method: "POST", path: "/logout", outputStructure: "detailed" })),

    setup: oc
      .input(SecretInputSchema)
      .output(z.object({ ok: z.literal(true) }))
      .meta(openapi({ method: "POST", path: "/setup", successStatus: 201 })),
  },
};
