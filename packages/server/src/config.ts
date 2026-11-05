import type { Database } from "./db/client";
import type {
  AnswerGraderProvider,
  ImageProvider,
  LessonExerciseCheckerProvider,
  LessonPoolAgentProvider,
  LessonReviewerProvider,
  LlmProvider,
  PronunciationProvider,
  SessionActivityReviewer,
  SttProvider,
  TtsFormat,
  TtsProvider,
} from "./ports/ai";
import type { MediaStore } from "./ports/media";
import type { UsageRecorder } from "./ports/usage";
import { createAzurePronunciationProvider } from "./providers/azure/pronunciation";
import { createAzureSttProvider } from "./providers/azure/stt";
import { createOpenAiLessonReviewer } from "./providers/openai/lesson-reviewer";
import { CONFIG_DEFAULTS } from "./config-defaults";
import { createOpenAiCompatibleGrader } from "./providers/openai-compatible/grader";
import { createOpenAiCompatibleSttProvider } from "./providers/openai-compatible/stt";
import { createOpenAiCompatibleSessionActivityReviewer } from "./providers/openai-compatible/session-activity";
import { chatRequestExtrasFromEnv, openRouterProviderRoutingFromEnv } from "./providers/chat-request-options";
import { endpointKeyFromEnv, lessonAgentKeyFromEnv } from "./providers/openrouter-key";
import { createProductionSubjectRegistry } from "./domain/lessons/subjects";
import type { SubjectRegistry } from "./domain/lessons/registry";
import type { LessonGenerationPolicy } from "./modules/materials/lessons/lesson-generation-policy";
import type { LessonAgentPolicy } from "./modules/materials/lessons/lesson-pool-agent-policy";

/** Zegar jako zależność — domena i moduły nie wołają Date.now() bezpośrednio. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Tryb stylu wypowiedzi TTS: `instructions` dokleja ton do instrukcji dostawcy. */
export type TtsStyleMode = "instructions" | "none";

/**
 * Tożsamość ustawień medialnych używana w fingerprintach. Samo nazewnictwo
 * providerów/modeli nie jest sekretem; klucze API żyją w adapterach.
 */
export interface MediaSettings {
  tts: {
    provider: string;
    model: string;
    /** Głos domyślny; `voices` nadpisuje go dla danego locale treści. */
    voice: string;
    /** Głos per locale (np. `en-GB` → głos brytyjski), z `UMIEM_TTS_VOICE_<LANG>_<REGION>`. */
    voices?: Readonly<Record<string, string>>;
    /**
     * Instrukcja wymowy per locale, z `UMIEM_TTS_INSTRUCTIONS_<LANG>_<REGION>`.
     * Modele wielojęzyczne (Gemini TTS) zgadują język pojedynczego słowa —
     * „pies” czy „1410” bez niej bywają czytane po angielsku.
     */
    instructions?: Readonly<Record<string, string>>;
    /**
     * Wyłącznik operatora stylu wypowiedzi (`UMIEM_TTS_STYLE`, spec §2.2).
     * Brak pola = bez stylu; `none` z env też zapisujemy jako brak pola, więc
     * `defaultMediaSettings` i fingerprinty istniejących zasobów się nie zmieniają.
     */
    style?: TtsStyleMode;
    format: TtsFormat;
  };
  image: { provider: string; model: string; size: string; quality: string; format: string };
}

/** Domyślnie low+webp: karty dziecka wyświetlają obraz ~300 px, więc wyższa
 *  jakość i bezstratny format zwykle nie dają proporcjonalnej korzyści. */
export const defaultMediaSettings: MediaSettings = {
  tts: { provider: "openai", model: "gpt-4o-mini-tts", voice: "alloy", format: "mp3" },
  image: { provider: "openai", model: "gpt-image-2.5-sunburst", size: "1024x1024", quality: "low", format: "webp" },
};

/**
 * Głos TTS dla locale tekstu: głos przypisany do tego locale albo domyślny.
 * Głos wchodzi do fingerprintu i metadanych zasobu, więc słówka po angielsku
 * i polskie nagrania mają osobne nagrania (design szkoły §11.7).
 */
export function ttsVoiceFor(tts: MediaSettings["tts"], locale: string): string {
  return tts.voices?.[locale] ?? tts.voice;
}

/** Instrukcja wymowy dla locale tekstu; wchodzi do fingerprintu i metadanych zasobu. */
export function ttsInstructionsFor(tts: MediaSettings["tts"], locale: string): string | undefined {
  return tts.instructions?.[locale];
}

/** `<prefix>_EN_GB=…` → `{ "en-GB": … }`; puste wartości pomijane. */
function perLocaleFromEnv(env: Record<string, string | undefined>, prefix: string): Record<string, string> {
  const values: Record<string, string> = {};
  const pattern = new RegExp(`^${prefix}_([A-Z]{2})_([A-Z]{2})$`);
  for (const [key, value] of Object.entries(env)) {
    const match = pattern.exec(key);
    if (match && value) values[`${match[1]!.toLowerCase()}-${match[2]}`] = value;
  }
  return values;
}

function ttsFormatFromEnv(raw: string | undefined): TtsFormat {
  if (raw === undefined || raw === "") return defaultMediaSettings.tts.format;
  if (raw === "mp3" || raw === "wav") return raw;
  throw new Error("UMIEM_TTS_FORMAT must be mp3 or wav");
}

/** `none` i brak wartości dają `undefined` (brak pola w ustawieniach). */
function ttsStyleFromEnv(raw: string | undefined): TtsStyleMode | undefined {
  if (raw === undefined || raw === "" || raw === "none") return undefined;
  if (raw === "instructions") return raw;
  throw new Error("UMIEM_TTS_STYLE must be instructions or none");
}

/** Nadpisywalne zmiennymi środowiskowymi (nazwy, nie sekrety). */
export function mediaSettingsFromEnv(env: Record<string, string | undefined>): MediaSettings {
  const voices = perLocaleFromEnv(env, "UMIEM_TTS_VOICE");
  const instructions = perLocaleFromEnv(env, "UMIEM_TTS_INSTRUCTIONS");
  const style = ttsStyleFromEnv(env.UMIEM_TTS_STYLE);
  return {
    // Puste UMIEM_TTS_* jak nieustawione — tak samo jak adapter TTS w workerze
    // (generation-env), żeby fingerprint opisywał faktycznie użyty model.
    tts: {
      provider: env.UMIEM_TTS_PROVIDER || defaultMediaSettings.tts.provider,
      model: env.UMIEM_TTS_MODEL || defaultMediaSettings.tts.model,
      voice: env.UMIEM_TTS_VOICE || defaultMediaSettings.tts.voice,
      ...(Object.keys(voices).length > 0 ? { voices } : {}),
      ...(Object.keys(instructions).length > 0 ? { instructions } : {}),
      ...(style ? { style } : {}),
      format: ttsFormatFromEnv(env.UMIEM_TTS_FORMAT),
    },
    image: {
      provider: env.UMIEM_IMAGE_PROVIDER ?? defaultMediaSettings.image.provider,
      model: env.UMIEM_IMAGE_MODEL ?? defaultMediaSettings.image.model,
      size: env.UMIEM_IMAGE_SIZE ?? defaultMediaSettings.image.size,
      quality: env.UMIEM_IMAGE_QUALITY ?? defaultMediaSettings.image.quality,
      format: env.UMIEM_IMAGE_FORMAT ?? defaultMediaSettings.image.format,
    },
  };
}

/** Zależności wykonywania generacji: tylko worker (i testy) je posiadają. */
export interface GenerationDeps {
  llm: LlmProvider;
  tts: TtsProvider;
  image: ImageProvider;
  mediaStore: MediaStore;
  lessonExecution?: LessonGenerationPolicy;
  /**
   * Czy w procesie web będzie model oceniający ({@link graderConfigured} na tym
   * samym env). Steruje tylko preferencją typów ćwiczeń przy generacji puli.
   */
  graderAvailable?: boolean;
  /**
   * Krytyk świeżych ćwiczeń lekcji (faza po walidacji, worker). Nieobecny =
   * jak `state: "disabled"`; brak lub awaria krytyka nigdy nie kończy przebiegu porażką.
   */
  reviewer?: ReviewerDeps;
  /**
   * Agent puli lekcji dla przedmiotów z listy `UMIEM_LESSON_AGENT_SUBJECTS`
   * (składany tylko w workerze, `providers/lesson-agent-env.ts`). Nieobecny =
   * wszystkie lekcje generuje potok.
   */
  lessonAgent?: LessonAgentDeps;
}

/** Zależności agenta puli lekcji w workerze (adapter dostawcy za portami). */
export interface LessonAgentDeps {
  /** Identyfikatory przedmiotów generowanych agentem. */
  readonly subjects: ReadonlySet<string>;
  readonly agent: LessonPoolAgentProvider;
  readonly checker: LessonExerciseCheckerProvider;
  readonly policy: Partial<LessonAgentPolicy>;
  /** Rezerwa na finalizację przed terminem runu (domyślnie `AGENT_FINALIZATION_RESERVE_MS`); nadpisywana w testach. */
  readonly finalizationReserveMs?: number;
}

/** Limity krytyka lekcji (`UMIEM_REVIEWER_*`). */
export interface ReviewerPolicy {
  /** Termin jednego wywołania modelu. */
  readonly timeoutMs: number;
  /** Ile zagadnień krytyk sprawdza równolegle. */
  readonly concurrency: number;
  /** Maksymalna liczba wywołań modelu na przebieg. */
  readonly maxCallsPerRun: number;
  /** Łączny budżet fazy krytyka w przebiegu. */
  readonly phaseBudgetMs: number;
}

/** `not_configured` = włączony, ale bez klucza dla swojego adresu. */
export type ReviewerState = "disabled" | "not_configured" | "ready";

export interface ReviewerDeps {
  state: ReviewerState;
  provider?: LessonReviewerProvider;
  policy: ReviewerPolicy;
}

/**
 * Zależności ścieżki mowy (arch §11): krótkie żądanie web → provider, bez
 * kolejki i bez trwałego audio. `analysisTimeoutMs` pozwala testom skrócić
 * 30-sekundowy deadline produkcyjny.
 */
export interface SpeechDeps {
  stt: SttProvider;
  pronunciation: PronunciationProvider;
  analysisTimeoutMs?: number;
}

/**
 * Rozpoznawanie mowy dla dyktowania odpowiedzi lekcji (design szkoły §5.2).
 * Osobne od `speech` słówek: odpowiedzi szkolne nie potrzebują oceny wymowy.
 * Nieobecność = lekcje bez mikrofonu.
 */
export interface LessonSpeechDeps {
  stt: SttProvider;
  /** Publiczna nazwa usługi dla panelu rodzica (model, nigdy URL ani klucz). */
  publicService: string;
  timeoutMs?: number;
}

/**
 * Zależności modelu oceniającego odpowiedzi lekcji (design „Model oceniający”),
 * proces web. `maxCallsPerSession` ogranicza liczbę płatnych wywołań na sesję
 * (księgowane w `learning_sessions.context.graderCalls`); `timeoutMs` to łączny
 * deadline jednego wywołania. Nieobecność = model wyłączony (stan poprawny:
 * niedopasowana odpowiedź → nieocenione). Worker gradera nie potrzebuje.
 */
export interface GraderDeps {
  provider: AnswerGraderProvider;
  maxCallsPerSession: number;
  timeoutMs: number;
}

/**
 * Zależności oceny aktywności sesji (spec client-reward-time). Współdzieli
 * połączenie `UMIEM_GRADER_*` z graderem lekcji, ale ma osobny port, prompt i
 * deadline (domyślnie 20 s). Nieobecność = ocena wyłączona (zapis błędu, bez
 * punktów). Bez cache i bez limitu wywołań odpowiedzi lekcyjnych.
 */
export interface SessionActivityDeps {
  provider: SessionActivityReviewer;
  timeoutMs: number;
  /** Bezpieczna, publiczna nazwa hosta/modelu; nigdy URL z credentials ani klucz. */
  publicService?: string;
}

/**
 * Zależności serwowe przekazywane do przypadków użycia. `media` pozwala webowi
 * uzgadniać zasoby w transakcji edycji; `generation` wykonuje pracę w tle;
 * `mediaStore` służy webowi do wydawania gotowych zasobów (podgląd rodzica);
 * `speech` obsługuje odpowiedzi ustne dziecka.
 */
export interface Services {
  db: Database;
  clock: Clock;
  media?: MediaSettings;
  generation?: GenerationDeps;
  mediaStore?: MediaStore;
  /** Obraz provider dostępny w web dla jawnej propozycji okładki rodzica. */
  imageProvider?: ImageProvider;
  speech?: SpeechDeps;
  /** Dyktowanie odpowiedzi otwartych lekcji (Etap 3 przedmiotów szkolnych). */
  lessonSpeech?: LessonSpeechDeps;
  /**
   * Model oceniający otwarte odpowiedzi lekcji (zadanie 15). Nieobecny =
   * ocena dowolnych odpowiedzi wyłączona (niedopasowanie → nieocenione);
   * `graderAvailable` selektora i modułu prób wynika WYŁĄCZNIE z jego obecności.
   */
  grader?: GraderDeps;
  /**
   * Ocena aktywności sesji (raport FE → wykluczenia zadań → punkty). Proces
   * web; nieobecność = polityka błędu bez punktów.
   */
  sessionActivity?: SessionActivityDeps;
  /**
   * Nazwa usługi generującej materiał (`host · model`) dla panelu rodzica.
   * Web nie ma instancji LLM (generuje worker), więc opisuje wspólną konfigurację.
   */
  generationService?: string;
  /** Nazwa usługi krytyka lekcji (`host · model`), gdy jest gotowy; nieobecna = krytyk wyłączony. */
  reviewService?: string;
  /**
   * Opis agenta puli lekcji dla panelu rodzica (przedmioty z listy i etykiety usług, z env
   * procesu web); nieobecny = wszystkie przedmioty idą potokiem. To opis konfiguracji, nie klient modelu.
   */
  lessonAgentPublic?: LessonAgentPublic;
  /**
   * Recorder kosztów usług AI (spec llm-cost-tracking §4). Nieobecny = brak
   * zapisu kosztów; `flush()` przy zamykaniu procesu i w testach.
   */
  usage?: UsageRecorder;
  /**
   * Rejestr przedmiotów lekcji (zadanie 9). Wstrzykiwany jako wartość, nie
   * importowany globalnie w modułach — `createServices` nadaje mu produkcyjną
   * domyślkę `createProductionSubjectRegistry()`, więc żaden wywołujący nie
   * musi go dostarczać, a testy mogą podmienić rejestr. Czysta, deterministyczna
   * zależność bez env/sekretów, więc zawsze obecna (inaczej niż media/speech).
   */
  subjects: SubjectRegistry;
}

export function createServices(
  input: {
    db: Database;
    clock?: Clock;
    media?: MediaSettings;
    generation?: GenerationDeps;
    mediaStore?: MediaStore;
    imageProvider?: ImageProvider;
    speech?: SpeechDeps;
    lessonSpeech?: LessonSpeechDeps;
    grader?: GraderDeps;
    sessionActivity?: SessionActivityDeps;
    generationService?: string;
    reviewService?: string;
    lessonAgentPublic?: LessonAgentPublic;
    usage?: UsageRecorder;
    subjects?: SubjectRegistry;
  },
): Services {
  return {
    db: input.db,
    clock: input.clock ?? systemClock,
    subjects: input.subjects ?? createProductionSubjectRegistry(),
    ...(input.media ? { media: input.media } : {}),
    ...(input.generation ? { generation: input.generation } : {}),
    ...(input.mediaStore ? { mediaStore: input.mediaStore } : {}),
    ...(input.imageProvider ? { imageProvider: input.imageProvider } : {}),
    ...(input.speech ? { speech: input.speech } : {}),
    ...(input.lessonSpeech ? { lessonSpeech: input.lessonSpeech } : {}),
    ...(input.grader ? { grader: input.grader } : {}),
    ...(input.sessionActivity ? { sessionActivity: input.sessionActivity } : {}),
    ...(input.generationService ? { generationService: input.generationService } : {}),
    ...(input.reviewService ? { reviewService: input.reviewService } : {}),
    ...(input.lessonAgentPublic ? { lessonAgentPublic: input.lessonAgentPublic } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
  };
}

/**
 * Providerzy mowy ze zmiennych środowiskowych. Azure jest pierwszym kandydatem
 * (arch §11); bez kluczy zależność pozostaje nieobecna i próby ustne kończą
 * się wynikiem technicznym zamiast udawanej oceny.
 */
export function speechFromEnv(env: Record<string, string | undefined>, usage?: UsageRecorder): SpeechDeps | undefined {
  const subscriptionKey = env.AZURE_SPEECH_KEY;
  const region = env.AZURE_SPEECH_REGION;
  if (!subscriptionKey || !region) {
    return undefined;
  }
  return {
    stt: createAzureSttProvider({ subscriptionKey, region, ...(usage ? { usage } : {}) }),
    pronunciation: createAzurePronunciationProvider({ subscriptionKey, region, ...(usage ? { usage } : {}) }),
  };
}

/** Domyślny model dyktowania lekcji (spike 2026-10-29, design szkoły §5.2). */
export const DEFAULT_LESSON_STT_MODEL = "elevenlabs/scribe-v2";

/**
 * Dyktowanie lekcji ze zmiennych `UMIEM_LESSON_STT_BASE_URL`, `_API_KEY`
 * i opcjonalnego `_MODEL` (domyślnie {@link DEFAULT_LESSON_STT_MODEL}). Adres
 * i klucz razem albo wcale; https poza test/development jak dla gradera.
 */
export function lessonSpeechFromEnv(env: Record<string, string | undefined>, usage?: UsageRecorder): LessonSpeechDeps | undefined {
  const baseUrl = env.UMIEM_LESSON_STT_BASE_URL;
  const apiKey = env.UMIEM_LESSON_STT_API_KEY;
  const present = [baseUrl, apiKey].filter((v) => v !== undefined && v !== "").length;
  if (present === 0) {
    return undefined;
  }
  if (present < 2) {
    throw new Error("UMIEM_LESSON_STT_* requires both BASE_URL and API_KEY, or none");
  }
  const nodeEnv = env.NODE_ENV ?? "production";
  const insecureAllowed = nodeEnv === "test" || nodeEnv === "development";
  if (!baseUrl!.startsWith("https://") && !(insecureAllowed && baseUrl!.startsWith("http://"))) {
    throw new Error("UMIEM_LESSON_STT_BASE_URL must use https:// outside test/development");
  }
  const model = env.UMIEM_LESSON_STT_MODEL?.trim() || DEFAULT_LESSON_STT_MODEL;
  return {
    stt: createOpenAiCompatibleSttProvider({ baseUrl: baseUrl!, apiKey: apiKey!, model, ...(usage ? { usage } : {}) }),
    publicService: model,
  };
}

/** Domyślne limity gradera (design „Model oceniający”). */
export const DEFAULT_GRADER_TIMEOUT_MS = 8000;
export const DEFAULT_GRADER_MAX_CALLS_PER_SESSION = 20;

/** Termin asynchronicznej oceny; zostawia zapas przed finalizacją po 120 s. */
export const DEFAULT_SESSION_ACTIVITY_TIMEOUT_MS = 60_000;

/** Dodatnia liczba całkowita z env albo błąd (nazwa zmiennej w komunikacie). */
function positiveIntEnv(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Połączenie modelu oceniającego (grader lekcji i ocena aktywności sesji),
 * design `2026-11-01-config-defaults-design.md` §2.3. Włączone, gdy jest
 * własny `UMIEM_GRADER_API_KEY` albo wspólny `OPENROUTER_API_KEY` (ten tylko
 * dla https OpenRouter). Bez klucza — wyłączone; klucz bez `BASE_URL`/`MODEL`
 * (wywołania bez domyślnej konfiguracji) to błąd konfiguracji. `https://`
 * wymagane poza `NODE_ENV` test/development.
 */
function graderConnectionFromEnv(env: Record<string, string | undefined>): { baseUrl: string; apiKey: string; model: string } | undefined {
  const baseUrl = env.UMIEM_GRADER_BASE_URL || undefined;
  const model = env.UMIEM_GRADER_MODEL || undefined;
  const apiKey = endpointKeyFromEnv(env, "UMIEM_GRADER", baseUrl);
  if (apiKey === undefined) return undefined;
  if (baseUrl === undefined || model === undefined) {
    throw new Error("UMIEM_GRADER_* requires all of BASE_URL, API_KEY and MODEL, or none");
  }
  const nodeEnv = env.NODE_ENV ?? "production";
  const insecureAllowed = nodeEnv === "test" || nodeEnv === "development";
  if (!baseUrl.startsWith("https://") && !(insecureAllowed && baseUrl.startsWith("http://"))) {
    throw new Error("UMIEM_GRADER_BASE_URL must use https:// outside test/development");
  }
  return { baseUrl, apiKey, model };
}

/**
 * Czy proces web będzie miał model oceniający — ta sama reguła co
 * {@link graderFromEnv}; worker używa jej do preferencji typów przy generacji.
 */
export function graderConfigured(env: Record<string, string | undefined>): boolean {
  return graderConnectionFromEnv(env) !== undefined;
}

/**
 * Model oceniający ze zmiennych środowiskowych (proces web, design „Model
 * oceniający”). Reguły połączenia: {@link graderConnectionFromEnv}. Liczby
 * dodatnie. Brak konfiguracji → undefined (model wyłączony to stan poprawny).
 * Sekret żyje tylko w adapterze; tu wyłącznie go przekazujemy.
 */
export function graderFromEnv(env: Record<string, string | undefined>, usage?: UsageRecorder): GraderDeps | undefined {
  const connection = graderConnectionFromEnv(env);
  if (connection === undefined) {
    return undefined;
  }
  const { baseUrl, apiKey, model } = connection;
  const timeoutMs = positiveIntEnv("UMIEM_GRADER_TIMEOUT_MS", env.UMIEM_GRADER_TIMEOUT_MS, DEFAULT_GRADER_TIMEOUT_MS);
  const maxCallsPerSession = positiveIntEnv(
    "UMIEM_GRADER_MAX_CALLS_PER_SESSION",
    env.UMIEM_GRADER_MAX_CALLS_PER_SESSION,
    DEFAULT_GRADER_MAX_CALLS_PER_SESSION,
  );
  return {
    provider: createOpenAiCompatibleGrader({
      baseUrl, apiKey, model, requestExtras: chatRequestExtrasFromEnv(env, "UMIEM_GRADER"),
      ...(usage ? { usage } : {}),
    }),
    maxCallsPerSession,
    timeoutMs,
  };
}

interface ReviewerConnection {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxOutputTokens: number;
}

/** Włączony tylko przez jawne `true`; domyślnie (też pusta wartość) wyłączony. */
export function reviewerEnabled(env: Record<string, string | undefined>): boolean {
  return env.UMIEM_REVIEWER_ENABLED?.trim().toLowerCase() === "true";
}

type ReviewerLimitName =
  | "UMIEM_REVIEWER_TIMEOUT_MS"
  | "UMIEM_REVIEWER_CONCURRENCY"
  | "UMIEM_REVIEWER_MAX_CALLS_PER_RUN"
  | "UMIEM_REVIEWER_PHASE_BUDGET_MS";

/** Domyślne limity krytyka z {@link CONFIG_DEFAULTS} — bez czytania env (krytyk wyłączony). */
export function defaultReviewerPolicy(): ReviewerPolicy {
  return {
    timeoutMs: Number(CONFIG_DEFAULTS.UMIEM_REVIEWER_TIMEOUT_MS),
    concurrency: Number(CONFIG_DEFAULTS.UMIEM_REVIEWER_CONCURRENCY),
    maxCallsPerRun: Number(CONFIG_DEFAULTS.UMIEM_REVIEWER_MAX_CALLS_PER_RUN),
    phaseBudgetMs: Number(CONFIG_DEFAULTS.UMIEM_REVIEWER_PHASE_BUDGET_MS),
  };
}

/** Limity z env; błędna liczba to błąd startu. Wołać tylko przy włączonym krytyku. */
export function reviewerPolicyFromEnv(env: Record<string, string | undefined>): ReviewerPolicy {
  const get = (name: ReviewerLimitName) => positiveIntEnv(name, env[name], Number(CONFIG_DEFAULTS[name]));
  return {
    timeoutMs: get("UMIEM_REVIEWER_TIMEOUT_MS"),
    concurrency: get("UMIEM_REVIEWER_CONCURRENCY"),
    maxCallsPerRun: get("UMIEM_REVIEWER_MAX_CALLS_PER_RUN"),
    phaseBudgetMs: get("UMIEM_REVIEWER_PHASE_BUDGET_MS"),
  };
}

/**
 * Połączenie krytyka lekcji: własny `UMIEM_REVIEWER_API_KEY` albo wspólny
 * `OPENROUTER_API_KEY` (tylko https OpenRouter). Brak klucza dla adresu →
 * undefined. `https://` wymagane poza `NODE_ENV` test/development. Brakujące
 * adres i model biorą wartości z {@link CONFIG_DEFAULTS}.
 */
function reviewerConnectionFromEnv(env: Record<string, string | undefined>): ReviewerConnection | undefined {
  const baseUrl = env.UMIEM_REVIEWER_BASE_URL || CONFIG_DEFAULTS.UMIEM_REVIEWER_BASE_URL;
  const model = env.UMIEM_REVIEWER_MODEL || CONFIG_DEFAULTS.UMIEM_REVIEWER_MODEL;
  const apiKey = endpointKeyFromEnv(env, "UMIEM_REVIEWER", baseUrl);
  if (apiKey === undefined) return undefined;
  const nodeEnv = env.NODE_ENV ?? "production";
  const insecureAllowed = nodeEnv === "test" || nodeEnv === "development";
  if (!baseUrl.startsWith("https://") && !(insecureAllowed && baseUrl.startsWith("http://"))) {
    throw new Error("UMIEM_REVIEWER_BASE_URL must use https:// outside test/development");
  }
  const maxOutputTokens = positiveIntEnv(
    "UMIEM_REVIEWER_MAX_OUTPUT_TOKENS",
    env.UMIEM_REVIEWER_MAX_OUTPUT_TOKENS,
    Number(CONFIG_DEFAULTS.UMIEM_REVIEWER_MAX_OUTPUT_TOKENS),
  );
  return { baseUrl, apiKey, model, maxOutputTokens };
}

/**
 * Krytyk lekcji ze zmiennych środowiskowych (worker). Wyłączony (domyślnie) →
 * `disabled`; włączony bez klucza → `not_configured` z ostrzeżeniem w logu
 * (bez wartości klucza); inaczej `ready` z providerem. Błędne liczby, opcje
 * pośrednika i http poza test/development zatrzymują start jak przy graderze.
 */
/**
 * Wspólna walidacja włączonego krytyka dla workera i etykiety w panelu: limity,
 * połączenie i opcje pośrednika. Rzuca przy błędnej konfiguracji; `connection`
 * undefined, gdy brak klucza.
 */
function validatedReviewerConfig(env: Record<string, string | undefined>): {
  readonly policy: ReviewerPolicy;
  readonly connection: ReviewerConnection | undefined;
  readonly requestExtras: ReturnType<typeof chatRequestExtrasFromEnv> | undefined;
} {
  const policy = reviewerPolicyFromEnv(env);
  const connection = reviewerConnectionFromEnv(env);
  // Rozstrzygnięty adres (z domyślnym), żeby opcje OpenRouter działały także bez withConfigDefaults.
  const requestExtras = connection === undefined
    ? undefined
    : chatRequestExtrasFromEnv({ ...env, UMIEM_REVIEWER_BASE_URL: connection.baseUrl }, "UMIEM_REVIEWER");
  return { policy, connection, requestExtras };
}

export function reviewerFromEnv(env: Record<string, string | undefined>, usage?: UsageRecorder): ReviewerDeps {
  // wyłączony krytyk nie czyta limitów: zbłąkana wartość UMIEM_REVIEWER_* nie przerywa startu
  if (!reviewerEnabled(env)) return { state: "disabled", policy: defaultReviewerPolicy() };
  const { policy, connection, requestExtras } = validatedReviewerConfig(env);
  if (connection === undefined) {
    console.warn(
      "[reviewer] UMIEM_REVIEWER_ENABLED=true, ale brak klucza (UMIEM_REVIEWER_API_KEY albo OPENROUTER_API_KEY dla https OpenRouter) — krytyk lekcji pominięty",
    );
    return { state: "not_configured", policy };
  }
  const { baseUrl, apiKey, model, maxOutputTokens } = connection;
  return {
    state: "ready",
    policy,
    provider: createOpenAiLessonReviewer({
      baseUrl,
      apiKey,
      model,
      maxOutputTokens,
      timeoutMs: policy.timeoutMs,
      ...(requestExtras ? { requestExtras } : {}),
      ...(usage ? { usage } : {}),
    }),
  };
}

/**
 * Nazwa usługi krytyka (`host · model`) dla panelu rodzica; tylko gdy krytyk
 * jest gotowy w tym env (jak `generationPublicServiceFromEnv` — web opisuje
 * konfigurację wspólną z workerem). Ta sama walidacja co w workerze
 * (`validatedReviewerConfig`): konfiguracja, której worker nie utworzy, nie dostaje
 * etykiety. Tylko opis: błąd daje `undefined`. Bez ścieżki adresu, kluczy i parametrów.
 */
export function reviewerPublicServiceFromEnv(env: Record<string, string | undefined>): string | undefined {
  if (!reviewerEnabled(env)) return undefined;
  if (env.UMIEM_FAKE_PROVIDERS === "1") return "fake-reviewer-1";
  try {
    const { connection } = validatedReviewerConfig(env);
    return connection === undefined ? undefined : `${new URL(connection.baseUrl).host} · ${connection.model}`;
  } catch {
    return undefined;
  }
}

/**
 * Ocena aktywności sesji ze zmiennych środowiskowych. Świadomie współdzieli
 * `UMIEM_GRADER_BASE_URL/API_KEY/MODEL` z graderem lekcji (decyzja handoff.md
 * §4): brak konfiguracji gradera = ocena aktywności również wyłączona. Osobny
 * deadline `UMIEM_SESSION_ACTIVITY_TIMEOUT_MS` (domyślnie 60 s).
 */
export function sessionActivityFromEnv(env: Record<string, string | undefined>, usage?: UsageRecorder): SessionActivityDeps | undefined {
  // to samo połączenie co graderFromEnv — nie polegamy na tym, że kompozycja wywoła go wcześniej
  const connection = graderConnectionFromEnv(env);
  if (connection === undefined) {
    return undefined;
  }
  const { baseUrl, apiKey, model } = connection;
  const timeoutMs = positiveIntEnv(
    "UMIEM_SESSION_ACTIVITY_TIMEOUT_MS",
    env.UMIEM_SESSION_ACTIVITY_TIMEOUT_MS,
    DEFAULT_SESSION_ACTIVITY_TIMEOUT_MS,
  );
  return {
    provider: createOpenAiCompatibleSessionActivityReviewer({
      baseUrl, apiKey, model, requestExtras: chatRequestExtrasFromEnv(env, "UMIEM_GRADER"),
      ...(usage ? { usage } : {}),
    }),
    timeoutMs,
    publicService: `${new URL(baseUrl).host} · ${model}`,
  };
}

/** Wysiłki rozumowania akceptowane przez agenta (`none` = bez rozumowania). */
const AGENT_EFFORTS: ReadonlySet<string> = new Set(["xhigh", "high", "medium", "low", "minimal", "none"]);

/** Ustawienia agenta puli lekcji po walidacji env (bez SDK; adapter składa `providers/lesson-agent-env.ts`). */
export interface LessonAgentSettings {
  readonly subjects: ReadonlySet<string>;
  readonly apiKey: string;
  readonly model: string;
  readonly effort: string;
  readonly provider?: Readonly<Record<string, unknown>>;
  readonly checkerModel: string;
  readonly checkerEffort: string;
  readonly checkerProvider?: Readonly<Record<string, unknown>>;
  readonly policy: Partial<LessonAgentPolicy>;
}

type AgentStringName =
  | "UMIEM_LESSON_AGENT_MODEL"
  | "UMIEM_LESSON_AGENT_CHECKER_MODEL"
  | "UMIEM_LESSON_AGENT_REASONING"
  | "UMIEM_LESSON_AGENT_CHECKER_REASONING";

function agentStringEnv(env: Record<string, string | undefined>, name: AgentStringName): string {
  const value = env[name]?.trim();
  return value ? value : CONFIG_DEFAULTS[name];
}

/** Identyfikatory z listy po przecinku: przycięte, bez pustych i duplikatów. */
function agentSubjectIds(env: Record<string, string | undefined>): string[] {
  const ids = (env.UMIEM_LESSON_AGENT_SUBJECTS ?? "").split(",").map((id) => id.trim()).filter((id) => id !== "");
  return [...new Set(ids)];
}

function agentEffortEnv(
  env: Record<string, string | undefined>,
  name: "UMIEM_LESSON_AGENT_REASONING" | "UMIEM_LESSON_AGENT_CHECKER_REASONING",
): string {
  const effort = agentStringEnv(env, name).toLowerCase();
  if (!AGENT_EFFORTS.has(effort)) throw new Error(`${name} must be one of ${[...AGENT_EFFORTS].join(", ")}`);
  return effort;
}

function positiveNumberEnv(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

/** Routing OpenRouter agenta/checkera: własny z dziedziczeniem `UMIEM_LLM_PROVIDER_*`; `require_parameters` przy wysiłku ≠ `none`. */
function agentProviderRouting(
  env: Record<string, string | undefined>,
  prefix: "UMIEM_LESSON_AGENT" | "UMIEM_LESSON_AGENT_CHECKER",
  effort: string,
): Readonly<Record<string, unknown>> | undefined {
  const routing = openRouterProviderRoutingFromEnv(env, prefix, "UMIEM_LLM");
  return effort === "none" ? routing : { ...routing, require_parameters: true };
}

/**
 * Lista przedmiotów agenta (`UMIEM_LESSON_AGENT_SUBJECTS`) po walidacji: pusta
 * lista → pusty zbiór; nieznany przedmiot albo przedmiot bez `agentPolicy` to
 * błąd startu z nazwą zmiennej. Wspólna dla ustawień z kluczem i trybu fake
 * (`providers/lesson-agent-env.ts`), który klucza nie wymaga.
 */
export function lessonAgentSubjectsFromEnv(
  env: Record<string, string | undefined>,
  subjects: Pick<SubjectRegistry, "getSubject">,
): ReadonlySet<string> {
  const ids = agentSubjectIds(env);
  for (const id of ids) {
    const subject = subjects.getSubject(id);
    if (subject === undefined) throw new Error(`UMIEM_LESSON_AGENT_SUBJECTS: unknown subject „${id}”`);
    if (subject.agentPolicy === undefined) throw new Error(`UMIEM_LESSON_AGENT_SUBJECTS: subject „${id}” has no agent policy`);
  }
  return new Set(ids);
}

/** Limity agenta z env (`UMIEM_LESSON_AGENT_MAX_STEPS`, współbieżność, terminy, budżet); zła liczba to błąd startu. */
export function lessonAgentPolicyFromEnv(env: Record<string, string | undefined>): Partial<LessonAgentPolicy> {
  const int = (name: keyof typeof CONFIG_DEFAULTS & `UMIEM_LESSON_AGENT_${string}`) =>
    positiveIntEnv(name, env[name], Number(CONFIG_DEFAULTS[name]));
  const maxSteps = int("UMIEM_LESSON_AGENT_MAX_STEPS");
  return {
    maxStepsPerObjective: maxSteps,
    planMaxSteps: maxSteps,
    concurrency: int("UMIEM_LESSON_AGENT_CONCURRENCY"),
    checkerConcurrency: int("UMIEM_LESSON_AGENT_CHECKER_CONCURRENCY"),
    objectiveTimeoutMs: int("UMIEM_LESSON_AGENT_OBJECTIVE_TIMEOUT_MS"),
    checkerTimeoutMs: int("UMIEM_LESSON_AGENT_CHECKER_TIMEOUT_MS"),
    runBudgetUsd: positiveNumberEnv(
      "UMIEM_LESSON_AGENT_RUN_BUDGET_USD",
      env.UMIEM_LESSON_AGENT_RUN_BUDGET_USD,
      Number(CONFIG_DEFAULTS.UMIEM_LESSON_AGENT_RUN_BUDGET_USD),
    ),
  };
}

/**
 * Agent puli lekcji z env (worker). Pusta lista → `undefined`. Błędna
 * konfiguracja (nieznany przedmiot albo bez `agentPolicy`, zła liczba,
 * nieznany wysiłek, generator i checker z tej samej rodziny modeli, zła opcja
 * routingu) to błąd startu z nazwą zmiennej. Niepusta lista bez klucza
 * OpenRouter → `undefined` i jedno ostrzeżenie (lekcje generuje potok). Brakujące
 * wartości biorą {@link CONFIG_DEFAULTS}, więc działa też bez `withConfigDefaults`.
 * Tryb fake (`UMIEM_FAKE_PROVIDERS=1`) obsługuje `providers/lesson-agent-env.ts`.
 */
export function lessonAgentSettingsFromEnv(
  env: Record<string, string | undefined>,
  subjects: Pick<SubjectRegistry, "getSubject">,
): LessonAgentSettings | undefined {
  const ids = lessonAgentSubjectsFromEnv(env, subjects);
  if (ids.size === 0) return undefined;
  const policy = lessonAgentPolicyFromEnv(env);

  const effort = agentEffortEnv(env, "UMIEM_LESSON_AGENT_REASONING");
  const checkerEffort = agentEffortEnv(env, "UMIEM_LESSON_AGENT_CHECKER_REASONING");
  const model = agentStringEnv(env, "UMIEM_LESSON_AGENT_MODEL");
  const checkerModel = agentStringEnv(env, "UMIEM_LESSON_AGENT_CHECKER_MODEL");
  // Checker z tej samej rodziny co generator rozwiązywałby ćwiczenia „jak ich autor”.
  if (model.split("/")[0] === checkerModel.split("/")[0]) {
    throw new Error("UMIEM_LESSON_AGENT_CHECKER_MODEL must come from a different model family than UMIEM_LESSON_AGENT_MODEL");
  }
  const provider = agentProviderRouting(env, "UMIEM_LESSON_AGENT", effort);
  const checkerProvider = agentProviderRouting(env, "UMIEM_LESSON_AGENT_CHECKER", checkerEffort);

  const apiKey = lessonAgentKeyFromEnv(env);
  if (apiKey === undefined) {
    console.warn("[config] UMIEM_LESSON_AGENT_SUBJECTS bez klucza OpenRouter — lekcje generuje potok");
    return undefined;
  }
  return {
    subjects: ids,
    apiKey,
    model,
    effort,
    ...(provider ? { provider } : {}),
    checkerModel,
    checkerEffort,
    ...(checkerProvider ? { checkerProvider } : {}),
    policy,
  };
}

/** Opis agenta puli dla panelu rodzica: przedmioty z listy i etykiety usług (`host · model`). */
export interface LessonAgentPublic {
  readonly subjects: ReadonlySet<string>;
  readonly generationService: string;
  readonly checkService: string;
}

/**
 * Opis agenta dla panelu rodzica (web): przedmioty z listy i nazwy usług.
 * Nigdy nie rzuca — nieznane identyfikatory i przedmioty bez polityki pomija,
 * a obecność zależy od listy, nie od klucza (web może go nie mieć). Tryb fake
 * pokazuje nazwy fake.
 */
export function lessonAgentPublicFromEnv(
  env: Record<string, string | undefined>,
  subjects: Pick<SubjectRegistry, "getSubject">,
): LessonAgentPublic | undefined {
  const known = agentSubjectIds(env).filter((id) => subjects.getSubject(id)?.agentPolicy !== undefined);
  if (known.length === 0) return undefined;
  if (env.UMIEM_FAKE_PROVIDERS === "1") {
    return { subjects: new Set(known), generationService: "fake-lesson-agent-model", checkService: "fake-lesson-checker-model" };
  }
  return {
    subjects: new Set(known),
    generationService: `openrouter.ai · ${agentStringEnv(env, "UMIEM_LESSON_AGENT_MODEL")}`,
    checkService: `openrouter.ai · ${agentStringEnv(env, "UMIEM_LESSON_AGENT_CHECKER_MODEL")}`,
  };
}
