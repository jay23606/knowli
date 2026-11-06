import { z } from "zod";
import { oc } from "@orpc/contract";
import { openapi } from "@orpc/openapi";
import { UuidSchema } from "./common";
import {
  AttemptDtoSchema,
  AttemptInputSchema,
  DictationDtoSchema,
  DisclosureDtoSchema,
  DisclosureInputSchema,
  EventInputSchema,
  FeedbackAudioDtoSchema,
  KidDeckDtoSchema,
  KidProfileDtoSchema,
  PresentationCompletionDtoSchema,
  PresentationCompletionInputSchema,
  SessionDtoSchema,
  SessionInputSchema,
  SessionSummaryDtoSchema,
  TaskDtoSchema,
} from "./kid";
import { LessonMockTestSummaryDtoSchema } from "./lessons";
import { MockTestSummaryDtoSchema } from "./mock-tests";
import { SessionActivityResultDtoSchema, SessionEndInputSchema } from "./reward-activity";
import { UiAudioCatalogDtoSchema } from "./ui-audio";

/**
 * Kontrakt Kid API pod /api/v1/kid (arch §12) w podejściu contract-first oRPC
 * v2: schematy + meta openapi, bez żadnego kodu serwera — ten plik importuje
 * też kid-ui w przeglądarce. Statusy, nagłówki i kształt ciał odwzorowują
 * router serwera `apps/web/src/orpc/kid-router.ts` (jedyny serwer kontraktu
 * po dekomisji legacy `kid/kid-router.ts`); prefix montowania (/api/v1/kid)
 * dokleja handler przy `handle()`, nie kontrakt.
 */

/**
 * Query listy zestawów dziecka. Wartości query przychodzą jako stringi
 * (spike v2: liście nie są JSON-parsowane), więc `microphoneEnabled`
 * dekoduje `z.stringbool()` — klient wysyła literal "true"/"false",
 * a śmieci typu "abc" pada na walidacji granicy.
 */
export const KidDecksQuerySchema = z.object({
  childId: UuidSchema,
  microphoneEnabled: z.stringbool().optional(),
});

/** Rodzaj ujawnienia: podpowiedź tekstowa albo ponowny odsłuch (arch §12). */
export const DisclosureKindSchema = z.enum(["hint", "audio"]);

/**
 * Ciało complete-presentation bez identyfikatora zadania z parametru ścieżki:
 * opcjonalny klucz idempotencji polecenia klienta. Pełne wejście procedury
 * to `PresentationCompletionInputSchema` (taskId dokleja ścieżka przy scaleniu).
 */
export const CompletePresentationInputSchema = PresentationCompletionInputSchema.omit({ taskId: true });

/** Parametr ścieżki `{attemptId}`: odczyt próby i autoryzacja odsłuchu feedbacku. */
export const FeedbackAudioPathSchema = z.object({ attemptId: UuidSchema });

/** Nagranie dziecka z multipartu — webowy `File` (globalny też w Node ≥ 20). */
export interface RecordingFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}
// Pakiet kompiluje się bez lib.dom, więc wystarczy strukturalny konstruktor;
// w runtime identyfikator rozwiązuje się na globalny `File`.
declare const File: new (bits: readonly unknown[], name: string, options?: { type?: string }) => RecordingFile;

/**
 * Odpowiedź ustna: multipart z bajtami nagrania poza JSON-em (arch §11–12).
 * `taskId` dokleja parametr ścieżki `{taskId}` przy scaleniu compact.
 */
export const SpeechAttemptMultipartInputSchema = z.object({
  taskId: UuidSchema,
  clientAttemptId: UuidSchema,
  audio: z.instanceof(File),
});

/**
 * Dyktowanie odpowiedzi lekcji (design szkoły §5.4): multipart z nagraniem,
 * bez `clientAttemptId` — to nie jest próba, tylko tekst do pola odpowiedzi.
 */
export const DictationMultipartInputSchema = z.object({
  taskId: UuidSchema,
  audio: z.instanceof(File),
});

/** Parametr ścieżki `{sessionId}` dla operacji na konkretnej sesji. */
const SessionPathInputSchema = z.object({ sessionId: UuidSchema });

/** Wejście końca sesji: parametr ścieżki + opcjonalny raport aktywności z ciała. */
const SessionEndRouteInputSchema = SessionEndInputSchema.extend({ sessionId: UuidSchema });

/**
 * Szczegółowa odpowiedź HTTP (outputStructure: "detailed") — procedura zwraca
 * `{status?, headers?, body}`; pominięty status spada do successStatus
 * (spike v2). Używana dla stałych statusów; dynamiczne warianty deklarują
 * literały statusów jawnie, bo z nich czyta je specyfikacja OpenAPI.
 */
function detailedOutput<T extends z.ZodType>(body: T) {
  return z.object({
    status: z.number().int().min(200).max(399).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body,
  });
}

/**
 * Odpowiedź 200 z wymuszonym `Cache-Control: no-store` — odczyty danych
 * dziecka (regresja R04). Nagłówek jest wymagany, więc implementacja, która
 * go opuści, pada na walidacji wyjścia zamiast przejść bezgłośnie.
 */
function noStoreOutput<T extends z.ZodType>(body: T) {
  return detailedOutput(body).extend({
    status: z.literal(200).optional(),
    headers: z.object({ "cache-control": z.literal("no-store") }).loose(),
  });
}

/**
 * Kontrakt kid API — zagnieżdżenie odzwierciedla segmenty URL. Każda
 * procedura: `oc.input(...).output(...).meta(openapi({...}))`.
 */
export const kidApiContract = {
  uiAudio: oc
    .output(noStoreOutput(UiAudioCatalogDtoSchema))
    .meta(openapi({ method: "GET", path: "/ui-audio", outputStructure: "detailed" })),

  profiles: oc
    .output(noStoreOutput(KidProfileDtoSchema.array()))
    .meta(openapi({ method: "GET", path: "/profiles", outputStructure: "detailed" })),

  decks: oc
    .input(KidDecksQuerySchema)
    .output(noStoreOutput(KidDeckDtoSchema.array()))
    .meta(openapi({ method: "GET", path: "/decks", outputStructure: "detailed" })),

  sessions: {
    create: oc
      .input(SessionInputSchema)
      .output(SessionDtoSchema)
      .meta(openapi({ method: "POST", path: "/sessions" })),

    next: oc
      .input(SessionPathInputSchema)
      // Nominalny sukces to wyczerpany budżet (204, puste ciało); wydane
      // zadanie wraca jako dynamiczny 200 przez detailed output — dokładnie
      // jak w kid-router.ts (regresja R05: 204 nie może spłaszczyć się do 200).
      .output(z.object({
        status: z.union([z.literal(200), z.literal(204)]),
        headers: z.record(z.string(), z.string()).optional(),
        body: TaskDtoSchema.nullish(),
      }))
      .meta(openapi({
        method: "POST",
        path: "/sessions/{sessionId}/next",
        successStatus: 204,
        outputStructure: "detailed",
      })),

    end: oc
      .input(SessionEndRouteInputSchema)
      .output(SessionSummaryDtoSchema)
      .meta(openapi({ method: "POST", path: "/sessions/{sessionId}/end" })),

    disableMicrophone: oc
      .input(SessionPathInputSchema)
      .output(SessionDtoSchema)
      .meta(openapi({ method: "POST", path: "/sessions/{sessionId}/disable-microphone" })),

    activityResult: oc
      .input(SessionPathInputSchema)
      .output(noStoreOutput(SessionActivityResultDtoSchema))
      .meta(openapi({ method: "GET", path: "/sessions/{sessionId}/activity-result", outputStructure: "detailed" })),

    mockTestSummary: oc
      .input(SessionPathInputSchema)
      // Lekcja → omówienie per cel; słówka → omówienie słówkowe (arch §12).
      .output(noStoreOutput(z.union([MockTestSummaryDtoSchema, LessonMockTestSummaryDtoSchema])))
      .meta(openapi({ method: "GET", path: "/sessions/{sessionId}/mock-test-summary", outputStructure: "detailed" })),
  },

  tasks: {
    events: oc
      .input(EventInputSchema)
      .output(z.void())
      .meta(openapi({ method: "POST", path: "/tasks/{taskId}/events", successStatus: 204 })),

    disclosures: oc
      .input(DisclosureInputSchema)
      .output(DisclosureDtoSchema)
      .meta(openapi({ method: "POST", path: "/tasks/{taskId}/disclosures" })),

    completePresentation: oc
      .input(PresentationCompletionInputSchema)
      .output(PresentationCompletionDtoSchema)
      .meta(openapi({ method: "POST", path: "/tasks/{taskId}/complete-presentation" })),

    attempts: oc
      // Jedna procedura, dwie formy wejścia: JSON (AttemptInput) albo multipart
      // z nagraniem (spike v2 potwierdził form-data + File). Parsowanie ciała
      // rozstrzyga Content-Type żądania — `requestBodyHint` z meta NIE jest
      // neutralnym hintem speki: w beta.45 kodek przekazuje go do parsera
      // żądania i wymusiłby formData() także dla JSON (udowodnione testem:
      // TypeError → 400). Multipart w spece OpenAPI wynika z detekcji pola
      // File w schemacie unii, więc hint jest zbędny po obu stronach.
      .input(z.union([AttemptInputSchema, SpeechAttemptMultipartInputSchema]))
      // Próba audio wraca 202 dopóki trwa analiza; literały statusów trafiają
      // do specyfikacji (regresja R05).
      .output(z.object({
        status: z.union([z.literal(200), z.literal(202)]),
        headers: z.record(z.string(), z.string()).optional(),
        body: AttemptDtoSchema,
      }))
      .meta(openapi({
        method: "POST",
        path: "/tasks/{taskId}/attempts",
        outputStructure: "detailed",
      })),

    dictation: oc
      .input(DictationMultipartInputSchema)
      .output(noStoreOutput(DictationDtoSchema))
      .meta(openapi({ method: "POST", path: "/tasks/{taskId}/dictation", outputStructure: "detailed" })),
  },

  attempts: {
    get: oc
      .input(FeedbackAudioPathSchema)
      .output(AttemptDtoSchema)
      .meta(openapi({ method: "GET", path: "/attempts/{attemptId}" })),

    feedbackAudio: oc
      .input(FeedbackAudioPathSchema)
      .output(noStoreOutput(FeedbackAudioDtoSchema))
      .meta(openapi({ method: "POST", path: "/attempts/{attemptId}/feedback-audio", outputStructure: "detailed" })),
  },
};
