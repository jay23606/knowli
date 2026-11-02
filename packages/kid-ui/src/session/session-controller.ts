import {
  messages,
  type Assignment,
  type MockTestSummaryDto,
  type LessonMockTestSummaryDto,
  type AttemptDto,
  type DictationDto,
  type FeedbackDto,
  type KidDeckDto,
  type KidProfileDto,
  type KidValidationReason,
  type UiAudioCatalogDto,
  type UiAudioKey,
  type RecordingModeDto,
  type SessionActivityResultDto,
  type SessionActivityReport,
  type SessionDto,
  type SessionSummaryDto,
  type TaskDto,
} from "@learning/contracts";
import { format } from "../format";
import type { KidApi } from "../api/KidApi";
import { isNetworkError, KidApiError } from "../api/client";
import { LevelMonitorUnavailableError, SLOW_PLAYBACK_RATE, type MicrophonePermission, type PlatformMedia, type RecorderOptions, type SpeechRecorder } from "../media/platform";
import { createSpeechVad, type SpeechVad } from "../media/vad";
import { MIC_DENIED_KEY, type LocalPreferences } from "../storage";
import { randomUUID } from "./uuid";
import { createGuidanceAudio } from "./guidance-audio";
import { SessionActivityReporter, type ActivityClock } from "./activity-report";
import { createMemoryActivityDraftStore, type PendingActivityResult, type SessionActivityDraftStore } from "./activity-draft-store";

/**
 * Sterownik przepływu nauki (plan zadania 9): czysta maszyna stanu nad
 * Kid API, bez Reacta — komponenty subskrybują snapshoty przez hook.
 *
 * Zasady wynikające ze SPEC/architektury, pilnowane tutaj:
 * - autoryzacja serwerowa PRZED odtworzeniem wzorca i podpowiedzią, także
 *   z cache (arch §9.2) — znaczenie odsłuchu zależy od typu zadania (§13.2);
 * - utrata sieci ukrywa wzorce, blokuje odsłuchy i oceniane próby; sukces
 *   pochodzi wyłącznie z odpowiedzi serwera, nigdy lokalnie;
 * - retry po awarii sieci używa tego samego clientAttemptId (A20);
 * - odmowa mikrofonu przełącza na tryb bez nagrywania i jest zapamiętywana;
 * - po obiecanej liczbie zadań nie dokładamy nowych (banner „Jeszcze N”);
 * - opuszczenie widoku zatrzymuje nagrywanie i odtwarzanie (RF5).
 */

/**
 * Ostatni wynik dyktowania odpowiedzi lekcji (design szkoły §5.3): tekst do
 * pola albo powód jego braku. `seq` rośnie z każdym wynikiem, aby widok
 * wstawił tekst tylko raz; `failures` liczy nieudane dyktowania z rzędu.
 */
export interface DictationState {
  taskId: string;
  seq: number;
  status: DictationDto["status"];
  text?: string;
  failures: number;
}

/** Tempo odczytu zdania w feedbacku lekcji: autoodczyt i „Posłuchaj zdania” = normal, żółw = slow. */
export type SentenceRate = "normal" | "slow";

/** Sposób wprowadzenia odpowiedzi tekstowej zgłaszany serwerowi. */
export type TextInputMethod = "keyboard" | "speech";

export interface LearningScreen {
  answerSaved?: boolean;
  /** Neutral client-side selection while the server decides the outcome. */
  pendingChoiceId?: string | null;
  /** A transition request is pending; keep the current task visible and stable. */
  transitioning?: boolean;
  kind: "learning";
  session: SessionDto;
  task: TaskDto | null;
  /**
   * Feedback po próbie; retry=true, gdy zadanie ma drugie podejście.
   * `chosenOptionId` różni próbę wyboru od pozostałych i zasila
   * podświetlenie opcji w siatce odpowiedzi (design 2026-10-09).
   * `sentencePlaying` — tempo odczytu zdania, które faktycznie gra (od startu
   * odtwarzacza do końca/przerwania); `sentenceAudioError` — ostatni nieudany
   * RĘCZNY odsłuch zdania, `seq` rośnie z każdym błędem (klucz animacji).
   * Autoodczyt nigdy nie ustawia błędu; znika przy udanym starcie albo z feedbackiem.
   */
  feedback: {
    dto: FeedbackDto | null;
    retry: boolean;
    attemptId: string;
    modality: AttemptDto["modality"];
    chosenOptionId?: string;
    audioError?: boolean;
    sentencePlaying?: SentenceRate | null;
    sentenceAudioError?: { rate: SentenceRate; seq: number } | null;
  } | null;
  /** Ujawniona podpowiedź czekająca na potwierdzenie dziecka. */
  reveal: { target: string; visual?: import("@learning/contracts").MeaningVisual; audioAssetId?: string } | null;
  offline: boolean;
  busy: boolean;
  micDenied: boolean;
  microphoneReady: boolean;
  recordingPhase: "idle" | "preparing" | "starting" | "recording" | "stopping";
  inputLevel: number | null;
  recordingNotice: string | null;
  technicalRecordingIssue?: boolean;
  recordingMode: RecordingModeDto;
  recording: boolean;
  /** Automatyczną próbę można porzucić, aby odsłuchać wzorzec lub pominąć. */
  automaticRecording?: boolean;
  /** Odpowiedź ustna w drodze/oceniana przez serwer. */
  processing: boolean;
  /** Błąd aplikacji (nie sieci) z przyciskiem ponowienia. */
  error: string | null;
  guidanceError?: boolean;
  taskAudioError?: "blocked" | "failed" | null;
  /**
   * Bodziec „Posłuchaj i wybierz” (`lesson_listen_choice`) wydanego zadania: `pending` — czeka na
   * pierwszy odsłuch, `blocked` — autoodtwarzanie zablokowane, `unavailable` — nagranie niedostępne
   * (dziecko może pominąć), `open` — odsłuchano, opcje aktywne. Brak = zadanie bez bodźca.
   */
  listenStimulus?: { taskId: string; state: "pending" | "blocked" | "unavailable" | "open"; playing: boolean } | null;
  /** „Posłuchaj pytania” nie odtworzyło nagrania (komunikat w pasku statusu, nie w wierszu instrukcji). */
  questionAudioError?: boolean;
  /** Dyktowanie odpowiedzi lekcji; brak = zadanie bez dyktowania. */
  dictation?: DictationState | null;
}

export type KidScreen =
  | { kind: "mockTestReady"; session: SessionDto }
  | { kind: "mockTestSummary"; childId: string; summary: MockTestSummaryDto; detailsLoading?: boolean; detailsError?: boolean }
  | { kind: "lessonMockTestSummary"; childId: string; summary: LessonMockTestSummaryDto; detailsLoading?: boolean; detailsError?: boolean }
  | { kind: "sessionConflict"; active: KidDeckDto; childId: string }
  | { kind: "loading" }
  | { kind: "initError"; message: string }
  | { kind: "profile"; profiles: KidProfileDto[] }
  | {
      kind: "deck";
      profiles: KidProfileDto[];
      childId: string;
      decks: KidDeckDto[];
      microphone: boolean;
      micDenied: boolean;
    }
  | LearningScreen
  | { kind: "summary"; childId: string; profiles: KidProfileDto[]; summary: SessionSummaryDto };

export interface LearningSessionDeps {
  api: KidApi;
  media: PlatformMedia;
  storage: LocalPreferences;
  /** Profile requested by the host route; ignored if it is no longer available. */
  initialChildId?: string;
  /** Odstęp odpytywania o wynik oceny mowy (testy skracają). */
  pollIntervalMs?: number;
  /**
   * Magazyn roboczej kopii raportu aktywności (localStorage w przeglądarce).
   * Domyślnie pamięciowy — host produkcyjny przekazuje `createBrowserActivityDraftStore()`.
   */
  activityDrafts?: SessionActivityDraftStore;
  /** Podmienialny zegar pomiaru aktywności (testy kontrolują czas). */
  activityClock?: ActivityClock;
}

/** Payload odpowiedzi bez kluczy transportowych — audio ma osobną ścieżkę. */
type AnswerPayload =
  | { modality: "choice"; optionId: string }
  | { modality: "text"; text: string; inputMethod?: TextInputMethod }
  | { modality: "sequence"; itemIds: string[] }
  | { modality: "selection"; itemIds: string[] }
  | { modality: "assignment"; assignments: Assignment[] }
  | { modality: "dont_remember" }
  | { modality: "skip" };

const POLL_INTERVAL_MS = 1_000;
const POLL_DEADLINE_MS = 90_000;
const REMAINING_BANNER_FROM = 3;
/** „Posłuchaj i wybierz”: bez startu odtwarzania po tym czasie od żądania autoryzacji — „Pomiń”. */
const LISTEN_NO_START_MS = 6_000;
/** Zapas odblokowania opcji, gdy `ended` nie nadejdzie: długość nagrania + 1 s albo 8 s. */
const LISTEN_UNLOCK_MARGIN_MS = 1_000;
const LISTEN_UNLOCK_FALLBACK_MS = 8_000;

type ListenStimulus = NonNullable<LearningScreen["listenStimulus"]>;

export function messageForError(error: unknown): string {
  if (error instanceof KidApiError) {
    const byReason: Partial<Record<KidValidationReason, string>> = messages.errors;
    if (error.reason && byReason[error.reason]) return byReason[error.reason]!;
    return messages.errors[error.code] ?? messages.errors.internal!;
  }
  return messages.errors.internal!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function audioAssetOf(task: TaskDto): string | null {
  if (task.prompt.kind === "exposure" || task.prompt.kind === "listening" || task.prompt.kind === "speech" ||
    task.prompt.kind === "picture_exposure" || task.prompt.kind === "picture_listening" || task.prompt.kind === "picture_speech") {
    return task.prompt.audioAssetId;
  }
  // Audio lekcji jest opcjonalne (przedmiot z TTS) i oferowane WYŁĄCZNIE w
  // ćwiczeniach tekstowych — odsłuch zdania wzorcowego przed odpowiedzią jest
  // dozwolonym wsparciem (wym. 4.6). Typy zamknięte nie niosą pola audioAssetId.
  if (
    task.prompt.kind === "lesson_gap" ||
    task.prompt.kind === "lesson_error_fix" ||
    task.prompt.kind === "lesson_transform" ||
    task.prompt.kind === "lesson_open_answer"
  ) {
    return task.prompt.audioAssetId ?? null;
  }
  return null;
}

/** Gotowe nagranie „Posłuchaj pytania” zadania lekcji, jeśli serwer je dołączył. */
export function questionAudioOf(task: TaskDto): string | null {
  const prompt = task.prompt;
  return "questionAudioAssetId" in prompt && typeof prompt.questionAudioAssetId === "string" ? prompt.questionAudioAssetId : null;
}

/** Zadanie modułu lekcji (`lesson_*`) — tylko ono dostaje odczyt zdania w feedbacku. */
export function isLessonTask(task: TaskDto | null | undefined): boolean {
  return task !== null && task !== undefined && task.exerciseType.startsWith("lesson_");
}

const AUDIO_DISCLOSURE_EXERCISES = new Set(["recall", "spelling", "letter_completion", "speech", "picture_speech", "lesson_gap", "lesson_error_fix", "lesson_transform", "lesson_open_answer"]);

/**
 * Identyfikatory obrazów zadania do ogrzania cache przy prefetchu: pola
 * `imageAssetId` występują jako wizualizacja promptu, opcje obrazkowe
 * i ilustracja karty — zbieramy je rekurencyjnie z publicznego promptu,
 * bez znajomości poszczególnych rodzajów ćwiczeń.
 */
export function imageAssetIdsOf(task: TaskDto): string[] {
  const found = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key === "imageAssetId" && typeof entry === "string") found.add(entry);
      else visit(entry, depth + 1);
    }
  };
  visit(task.prompt, 0);
  return [...found];
}

export class LearningSessionController {
  readonly #api: KidApi;
  readonly #media: PlatformMedia;
  readonly #storage: LocalPreferences;
  readonly #pollIntervalMs: number;
  readonly #initialChildId: string | undefined;
  readonly #activityDrafts: SessionActivityDraftStore;
  readonly #activityClock: ActivityClock;

  #screen: KidScreen = { kind: "loading" };
  #listeners = new Set<() => void>();
  #profiles: KidProfileDto[] = [];
  #childId: string | null = null;
  #micDenied = false;
  /** Rodzaj zestawu aktywnej kartkówki — decyduje o kształcie omówienia
   * (lekcja = per cel, słówka = per umiejętność). SessionDto nie niesie
   * rodzaju, więc zapamiętujemy go z karty zestawu, z której wystartowano. */
  #mockDeckKind: "vocabulary" | "lesson" = "vocabulary";
  #recordingMode: RecordingModeDto = "hold";
  #recorder: SpeechRecorder | null = null;
  /** Maszyna VAD aktywnej auto-próby; null poza trybem auto (quick 261021-lsw). */
  #vad: SpeechVad | null = null;
  /** True wyłącznie od auto-startu do zatrzymania auto-próby. */
  #autoCaptureActive = false;
  #autoBeepCancellation: AbortController | null = null;
  /** Nowe przygotowanie unieważnia stare; sam blur nie odrzuca ręcznej zgody. */
  #microphonePreparationGeneration = 0;
  /** Sygnał „teraz mów" grany w startRecording przez hook onMicrophoneReady. */
  #autoStartBeep: (() => Promise<void>) | null = null;
  /** Zadanie, na którym auto-start już padł — raz na wyświetlenie zadania (SPEC §16). */
  #autoCaptureTaskId: string | null = null;
  /** Sesja z otwartym potwierdzeniem „Koniec”: auto-start czeka na zamknięcie panelu. */
  #endConfirmSessionId: string | null = null;
  /** Otwarcie potwierdzenia „Koniec” unieważnia auto-start w toku, także po zamknięciu panelu. */
  #autoCaptureGeneration = 0;
  /** Ostatnia operacja do ponowienia po powrocie sieci/błędzie aplikacji. */
  #resume: { run: () => Promise<void>; keepsTaskVisible: boolean } | null = null;
  /** Wybrana opcja próby w toku; do podświetlenia w feedbacku (design 2026-10-09). */
  #pendingChoice: string | null = null;
  /**
   * Następne zadanie pobrane w tle przy feedbacku zakończonej próby: klik
   * „Dalej” pokazuje je bez czekania na sieć i pobranie obrazów. Ważne tylko
   * dla epoki i sesji, dla których je pobrano; błąd pobrania jest odrzucany
   * po cichu, a `continueLearning` wraca wtedy do zwykłego pobrania.
   */
  #nextTaskPrefetch: { epoch: number; sessionId: string; promise: Promise<TaskDto | null> } | null = null;
  /** Wycofuje operacje zdążające po zmianie ekranu/teardown. */
  #epoch = 0;
  #profileRequestSequence = 0;
  #profileRefreshPromise: Promise<boolean> | null = null;
  #recordingGeneration = 0;
  #recordingStartedAt = 0;
  #dictationSeq = 0;
  /** Odliczanie ostatnich sekund nagrania dyktowania; null poza nim. */
  #countdownHandle: ReturnType<typeof setInterval> | null = null;
  #playbackGeneration = 0;
  /**
   * Stopery bodźca „Posłuchaj i wybierz” (brak startu 6 s, zapas odblokowania) —
   * należą do jednej generacji odtwarzania; każde #stopPlayback je kasuje.
   */
  #listenTimers: ReturnType<typeof setTimeout>[] = [];
  /** Generacja odtwarzania, która ustawiła `listenStimulus.playing`; null = nic nie gra. */
  #listenPlayingGeneration: number | null = null;
  /**
   * Numer ostatniego przebiegu odczytu zdania. Licznik jest niezależny od
   * `#playbackGeneration`, bo `#stopPlayback` podbija tę generację przy każdym
   * innym odtwarzaniu; numer przebiegu odróżnia od siebie kolejne odczyty
   * zdania (np. przełączenie tempa w trakcie).
   */
  #sentenceRun = 0;
  /** Rośnie z każdym błędem ręcznego odsłuchu zdania (`sentenceAudioError.seq`). */
  #sentenceErrorSeq = 0;
  #uiAudio: UiAudioCatalogDto = { ready: false, assets: {} };
  #guidance: ReturnType<typeof createGuidanceAudio> | null = null;
  /** Lokalny pomiar aktywności bieżącej sesji; powstaje przy pierwszym zadaniu. */
  #activity: SessionActivityReporter | null = null;
  #activitySessionId: string | null = null;
  /**
   * Raport zamrożony RAZ na sesję (retry końca wysyła ten sam obiekt —
   * identyczny fingerprint zwraca zapisany wynik zamiast konfliktu).
   * undefined = jeszcze nie zamrożony; null = brak raportu (sesja bez zadań).
   */
  #frozenActivityReport: SessionActivityReport | null | undefined = undefined;
  /** Wynik oceny aktywności ostatnio zakończonej sesji (punkty/błąd). */
  #lastActivityResult: SessionActivityResultDto | null = null;
  #lastActivitySessionId: string | null = null;
  #lastActivityChildId: string | null = null;
  #activityResultTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #activityResultPolling = new Map<string, number>();
  #activityResultRetryAttempts = new Map<string, number>();
  #disposed = false;
  /** Numer ostatniego wywołania `#playCountedAudio` i przebiegu, którego odsłuch jest otwarty w raporcie. */
  #countedPlaybackSeq = 0;
  #openCountedPlayback: number | null = null;

  constructor(deps: LearningSessionDeps) {
    this.#api = deps.api;
    this.#media = deps.media;
    this.#storage = deps.storage;
    this.#pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.#initialChildId = deps.initialChildId;
    this.#activityDrafts = deps.activityDrafts ?? createMemoryActivityDraftStore();
    this.#activityClock = deps.activityClock ?? { now: () => Date.now() };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getScreen = (): KidScreen => this.#screen;

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }

  #learning(): LearningScreen | null {
    return this.#screen.kind === "learning" ? this.#screen : null;
  }

  #setLearning(patch: Partial<LearningScreen>): void {
    if (this.#screen.kind !== "learning") return;
    const recordingPhase = patch.recordingPhase ?? (patch.recording === undefined
      ? this.#screen.recordingPhase
      : patch.recording ? "recording" : "idle");
    this.#screen = {
      ...this.#screen,
      ...patch,
      recordingPhase,
      recording: recordingPhase === "recording",
      automaticRecording: this.#autoCaptureActive && (recordingPhase === "starting" || recordingPhase === "recording"),
    };
    this.#emit();
  }

  #setResume(run: () => Promise<void>, keepsTaskVisible = false): void {
    this.#resume = { run, keepsTaskVisible };
  }

  #stopPlayback(): void {
    this.#playbackGeneration += 1;
    // Przerwane odtwarzanie bodźca nie odblokowuje opcji i nie zostawia pierścienia dźwięku.
    this.#clearListenTimers();
    this.#releaseListenPlaying(this.#listenPlayingGeneration);
    if (this.#guidance) this.#guidance.stop();
    else this.#media.player.stop();
    // Wskaźnik odczytu zdania gaśnie synchronicznie przy każdym innym
    // odtwarzaniu, „Dalej”, nowym zadaniu, pauzie i offline — bez czekania na
    // rozstrzygnięcie play(). Błąd ręcznego odsłuchu zostaje (design §4.1 pkt 3, 5).
    // Po teardown widok już odszedł — bez emisji stanu do słuchaczy.
    const feedback = this.#learning()?.feedback;
    if (!this.#disposed && feedback && (feedback.sentencePlaying ?? null) !== null) {
      this.#setLearning({ feedback: { ...feedback, sentencePlaying: null } });
    }
  }

  #clearListenTimers(): void {
    for (const timer of this.#listenTimers) clearTimeout(timer);
    this.#listenTimers = [];
  }

  /**
   * Zmienia stan bodźca bieżącego zadania „Posłuchaj i wybierz” (tworzy go jako
   * `pending`, gdy brak). `open` raz osiągnięty zostaje do końca zadania.
   */
  #patchListenStimulus(taskId: string, patch: Partial<Omit<ListenStimulus, "taskId">>): void {
    const screen = this.#learning();
    if (!screen || screen.task?.taskId !== taskId || screen.task.prompt.kind !== "lesson_listen_choice") return;
    const current: ListenStimulus = screen.listenStimulus?.taskId === taskId
      ? screen.listenStimulus
      : { taskId, state: "pending", playing: false };
    const next: ListenStimulus = {
      taskId,
      state: current.state === "open" ? "open" : patch.state ?? current.state,
      playing: patch.playing ?? current.playing,
    };
    if (screen.listenStimulus?.taskId === taskId && next.state === current.state && next.playing === current.playing) return;
    this.#setLearning({ listenStimulus: next });
  }

  /** Gasi `playing`, jeśli ustawiła je ta generacja odtwarzania (nowsza zostaje nietknięta). */
  #releaseListenPlaying(generation: number | null): void {
    if (generation === null || this.#listenPlayingGeneration !== generation) return;
    this.#listenPlayingGeneration = null;
    const stimulus = this.#learning()?.listenStimulus;
    if (stimulus?.playing) this.#setLearning({ listenStimulus: { ...stimulus, playing: false } });
  }

  /** Start odtwarzania bodźca lub odczytu zdania zadania „Posłuchaj i wybierz” zapala pierścień. */
  #markListenPlaying(generation: number, taskId: string): void {
    if (generation !== this.#playbackGeneration) return;
    const task = this.#learning()?.task;
    if (task?.taskId !== taskId || task.prompt.kind !== "lesson_listen_choice") return;
    this.#listenPlayingGeneration = generation;
    this.#patchListenStimulus(taskId, { playing: true });
  }

  /**
   * Odtwarza plik audio rejestrując rzeczywisty odsłuch w lokalnym raporcie.
   * `options.onStarted` (z długością w ms, gdy znana) wołany w tym samym start-callbacku odtwarzacza co pomiar
   * aktywności; `options.rate` trafia do odtwarzacza (brak = tempo 1, bez opcji).
   */
  async #playCountedAudio(url: string, assetId: string, options: { rate?: number; onStarted?: (durationMs: number | null) => void } = {}): Promise<void> {
    const playback = ++this.#countedPlaybackSeq;
    const onStarted = (durationMs: number | null): void => {
      this.#openCountedPlayback = playback;
      this.#activity?.playbackStarted(assetId, durationMs);
      options.onStarted?.(durationMs);
    };
    try {
      if (options.rate === undefined) await this.#media.player.play(url, onStarted);
      else await this.#media.player.play(url, onStarted, { rate: options.rate });
    } finally {
      // Odrzucenie po uruchomieniu start-callbacku też domyka odsłuch —
      // wiszący playback tłumiłby domknięcie bezczynności. Tylko własny:
      // raport dopasowuje koniec po samym `assetId`, więc przerwany przebieg
      // tego samego nagrania (np. zmiana tempa) nie może zamknąć nowego,
      // który zdążył już wystartować.
      if (this.#openCountedPlayback === playback) {
        this.#openCountedPlayback = null;
        this.#activity?.playbackEnded(assetId);
      }
    }
  }

  async playGuidance(key: UiAudioKey): Promise<void> {
    if (this.#autoCaptureActive) this.cancelRecording();
    const screen = this.#learning();
    if (screen && (screen.offline || screen.busy || screen.processing || screen.recordingPhase !== "idle")) return;
    this.#stopPlayback();
    const playbackGeneration = this.#playbackGeneration;
    const epoch = this.#epoch;
    try {
      if (!this.#guidance || !this.#uiAudio?.ready || !this.#uiAudio.assets[key]) {
        try {
          this.#uiAudio = await this.#api.readUiAudio();
          this.#guidance = createGuidanceAudio(this.#uiAudio, this.#media.player, (id) => this.#api.mediaUrl(id));
        } catch {
          this.#uiAudio = { ready: false, assets: {} };
          this.#guidance = null;
        }
      }
      if (playbackGeneration !== this.#playbackGeneration || epoch !== this.#epoch) return;
      if (!this.#guidance || !this.#uiAudio?.ready || !this.#uiAudio.assets[key]) throw new Error("UI audio unavailable");
      await this.#guidance.play(key);
      if (playbackGeneration !== this.#playbackGeneration || epoch !== this.#epoch) return;
      this.#setLearning({ guidanceError: false });
    } catch (error) {
      if (playbackGeneration !== this.#playbackGeneration || epoch !== this.#epoch) return;
      this.#setLearning({ guidanceError: true });
      throw error;
    }
  }

  stopGuidance(): void {
    this.#guidance?.stop();
  }

  #beginPlayback(): number {
    this.#stopPlayback();
    return this.#playbackGeneration;
  }

  /**
   * Start/wznowienie lokalnego pomiaru aktywności sesji. Przy odświeżeniu
   * wznawiamy zapisaną kopię roboczą; przerwa od ostatniego zapisu do powrotu
   * jest oznaczana jako brak obserwacji (design §4). Brak/awaria magazynu nie
   * blokuje nauki — raport odnotuje niepełność.
   */
  #beginActivityMeasurement(sessionId: string): void {
    if (this.#activitySessionId === sessionId) return;
    this.#activity = null;
    this.#activitySessionId = sessionId;
    this.#lastActivityResult = null;
    this.#lastActivitySessionId = null;
    this.#lastActivityChildId = null;
    this.#frozenActivityReport = undefined;
    const draft = this.#activityDrafts.load(sessionId);
    if (draft && "state" in draft) {
      this.#activity = SessionActivityReporter.resume(this.#activityClock, draft.state);
      return;
    }
    this.#activity = new SessionActivityReporter(this.#activityClock);
  }

  #saveActivityDraft(): void {
    const activity = this.#activity;
    const sessionId = this.#activitySessionId;
    if (!activity || sessionId === null || !activity.started) return;
    const existing = this.#activityDrafts.load(sessionId);
    // Po ACK serwera szkic nie może nadpisać znacznika odzyskiwania wyniku
    // podczas blur/teardown.
    if (existing && "version" in existing) return;
    const saved = this.#activityDrafts.save({
      sessionId,
      savedAtMs: this.#activityClock.now(),
      state: activity.state,
      childId: this.#learning()?.session.childId ?? existing?.childId,
      ...(existing && "state" in existing && existing.finalPayload !== undefined ? { finalPayload: existing.finalPayload } : {}),
    });
    if (!saved) activity.markStorageUnavailable();
  }

  #rememberPendingActivityResult(sessionId: string, childId: string): void {
    const pending: PendingActivityResult = { version: 1, sessionId, childId, savedAtMs: this.#activityClock.now() };
    this.#activityDrafts.savePendingResult(pending);
    // Bieżące polling działa także bez localStorage; zapis decyduje tylko o
    // możliwości wznowienia go po przeładowaniu aplikacji.
    this.#scheduleActivityResultPoll(pending);
  }

  #resumePendingActivityResults(): void {
    for (const pending of this.#activityDrafts.listPendingResults()) this.#scheduleActivityResultPoll(pending);
  }

  #scheduleActivityResultPoll(pending: PendingActivityResult): void {
    if (this.#disposed || !this.#api.readSessionActivityResult
      || this.#activityResultTimers.has(pending.sessionId)
      || this.#activityResultPolling.get(pending.sessionId) === this.#epoch) return;
    const attempt = this.#activityResultRetryAttempts.get(pending.sessionId) ?? 0;
    const delay = Math.min(this.#pollIntervalMs * 2 ** attempt, 30_000);
    const timer = setTimeout(() => {
      this.#activityResultTimers.delete(pending.sessionId);
      void this.#pollActivityResult(pending);
    }, delay);
    this.#activityResultTimers.set(pending.sessionId, timer);
  }

  async #pollActivityResult(pending: PendingActivityResult): Promise<void> {
    const epoch = this.#epoch;
    if (this.#disposed || this.#activityResultPolling.get(pending.sessionId) === epoch) return;
    const readActivityResult = this.#api.readSessionActivityResult;
    if (!readActivityResult) return;
    this.#activityResultPolling.set(pending.sessionId, epoch);
    let retry = false;
    let backoffRetry = false;
    try {
      const result = await readActivityResult.call(this.#api, pending.sessionId);
      if (this.#disposed || epoch !== this.#epoch) return;
      if (result.status === "already_started") {
        // To normalny stan oczekiwania na ocenę, nie błąd. Zachowaj krótki,
        // stały interwał, by szybko pokazać wynik po zakończeniu modelu.
        this.#activityResultRetryAttempts.delete(pending.sessionId);
        retry = true;
        return;
      }
      const visibleSummary = this.#screen.kind === "summary"
        && this.#screen.childId === pending.childId && this.#screen.summary.sessionId === pending.sessionId;
      const visibleQuizSummary = (this.#screen.kind === "mockTestSummary" || this.#screen.kind === "lessonMockTestSummary")
        && this.#screen.childId === pending.childId && this.#screen.summary.sessionId === pending.sessionId;
      if (visibleSummary || visibleQuizSummary) {
        this.#lastActivityResult = result;
        this.#lastActivitySessionId = pending.sessionId;
        this.#lastActivityChildId = pending.childId;
        if (this.#screen.kind === "summary") this.#screen = { ...this.#screen, summary: { ...this.#screen.summary, activity: result } };
        this.#emit();
      }
      // listProfiles odświeża wszystkie profile, lecz owner wyniku pozostaje
      // przypięty do znacznika; nigdy nie wiążemy go z aktualnym wyborem UI.
      // Zachowujemy marker i ponawiamy GET terminalnego wyniku, jeśli nie udało
      // się odświeżyć salda właściwego dziecka.
      if (result.status === "evaluated" && this.#profiles.some(profile => profile.childId === pending.childId)) {
        if (!await this.refreshProfiles()) {
          retry = !this.#disposed && epoch === this.#epoch;
          backoffRetry = retry;
          return;
        }
      }
      this.#activityDrafts.remove(pending.sessionId);
      this.#activityResultRetryAttempts.delete(pending.sessionId);
    } catch (error) {
      if (this.#disposed || epoch !== this.#epoch) return;
      // Tylko jawne błędy domenowe są trwałe. Odpowiedź HTML z proxy 502/503
      // i niepoprawne JSON klient mapuje na `internal`; takie błędy są chwilowe.
      if (error instanceof KidApiError && !error.retryable && error.code !== "internal") {
        this.#activityDrafts.remove(pending.sessionId);
        this.#activityResultRetryAttempts.delete(pending.sessionId);
        return;
      }
      // Błędy transportu i serwera ponawiamy z backoffem, zachowując źródło prawdy.
      retry = !this.#disposed;
      backoffRetry = retry;
    } finally {
      if (this.#activityResultPolling.get(pending.sessionId) === epoch) {
        this.#activityResultPolling.delete(pending.sessionId);
      }
      if (retry) {
        if (backoffRetry) {
          this.#activityResultRetryAttempts.set(pending.sessionId, (this.#activityResultRetryAttempts.get(pending.sessionId) ?? 0) + 1);
        }
        this.#scheduleActivityResultPoll(pending);
      }
    }
  }

  /** Ostatni wynik oceny aktywności (punkty/błąd) dla ekranów podsumowania. */
  getActivityResult(): SessionActivityResultDto | null {
    const screenOwner = this.#screen.kind === "summary"
      ? { sessionId: this.#screen.summary.sessionId, childId: this.#screen.childId }
      : this.#screen.kind === "mockTestSummary" || this.#screen.kind === "lessonMockTestSummary"
        ? { sessionId: this.#screen.summary.sessionId, childId: this.#screen.childId }
        : null;
    return screenOwner?.sessionId === this.#lastActivitySessionId && screenOwner.childId === this.#lastActivityChildId
      ? this.#lastActivityResult : null;
  }

  async start(): Promise<void> {
    // React StrictMode może ponownie uruchomić efekt z tym samym kontrolerem.
    this.#disposed = false;
    const epoch = this.#epoch;
    try {
      const profiles = await this.#api.listProfiles();
      if (this.#disposed || epoch !== this.#epoch) return;
      this.#profiles = profiles;
      this.#resumePendingActivityResults();
      try {
        this.#uiAudio = await this.#api.readUiAudio();
        this.#guidance = createGuidanceAudio(this.#uiAudio, this.#media.player, (id) => this.#api.mediaUrl(id));
      } catch {
        this.#uiAudio = { ready: false, assets: {} };
        this.#guidance = null;
      }
      if (this.#disposed || epoch !== this.#epoch) return;
      if (this.#initialChildId !== undefined) {
        const requestedProfile = this.#profiles.find((profile) => profile.childId === this.#initialChildId);
        if (requestedProfile) {
          await this.#openDeckScreen(requestedProfile.childId);
          if (this.#disposed || epoch !== this.#epoch) return;
          await this.#deliverPendingActivity(requestedProfile.childId, epoch);
          if (this.#disposed || epoch !== this.#epoch) return;
          await this.#resumeMockFromDecks();
          return;
        }
        // A stale or mistyped profile URL falls back to the available profiles.
        this.#screen = { kind: "profile", profiles: this.#profiles };
      } else {
        this.#screen = { kind: "profile", profiles: this.#profiles };
      }
    } catch (error) {
      if (this.#disposed || epoch !== this.#epoch) return;
      this.#screen = { kind: "initError", message: messageForError(error) };
    }
    this.#emit();
  }

  async selectProfile(childId: string): Promise<void> {
    this.#epoch += 1;
    const epoch = this.#epoch;
    this.#teardownRecording();
    this.#stopPlayback();
    this.#screen = { kind: "loading" };
    this.#emit();
    await this.#openDeckScreen(childId);
    await this.#deliverPendingActivity(childId, epoch);
    await this.#resumeMockFromDecks();
  }

  /** Redelivers an exact final report left by a closed tab; no new evaluation is made. */
  async #deliverPendingActivity(childId: string, epoch: number): Promise<void> {
    const pendingDrafts = this.#activityDrafts.listForChild(childId);
    let acknowledged = false;
    const acknowledgedSessionIds = new Set<string>();
    for (const draft of pendingDrafts) {
      if (!draft.finalPayload) continue;
      try {
        const summary = await this.#api.endSession(draft.sessionId, draft.finalPayload);
        acknowledged = true;
        acknowledgedSessionIds.add(draft.sessionId);
        if (summary.activity?.status === "already_started") {
          this.#rememberPendingActivityResult(draft.sessionId, childId);
          continue;
        }
        if (epoch === this.#epoch && this.#childId === childId) this.#lastActivityResult = summary.activity ?? null;
        this.#activityDrafts.remove(draft.sessionId);
      } catch {
        // Keep the exact payload for a later profile selection/network retry.
      }
    }
    // The first deck snapshot may still advertise a mock test whose /end ACK
    // was lost. Refresh only after a successful redelivery, and never let this
    // asynchronous result overwrite a later profile/view selection.
    if (acknowledged && epoch === this.#epoch && this.#screen.kind === "deck" && this.#screen.childId === childId) {
      try {
        const decks = await this.#api.listDecks(childId, { microphoneEnabled: false });
        if (epoch === this.#epoch && this.#screen.kind === "deck" && this.#screen.childId === childId) {
          this.#screen = { ...this.#screen, decks };
          this.#emit();
        }
      } catch {
        // Do not auto-resume a mock session known to have ended using the stale
        // pre-recovery deck snapshot if refreshing that snapshot failed.
        if (epoch === this.#epoch && this.#screen.kind === "deck" && this.#screen.childId === childId) {
          this.#screen = { ...this.#screen, decks: this.#screen.decks.map((deck) =>
            deck.activeSession && acknowledgedSessionIds.has(deck.activeSession.sessionId)
              ? { ...deck, activeSession: null } : deck) };
          this.#emit();
        }
      }
    }
    void this.refreshProfiles();
  }

  async #openDeckScreen(childId: string): Promise<void> {
    const epoch = this.#epoch;
    try {
      this.#micDenied = this.#storage.read(MIC_DENIED_KEY) === "1";
      const decks = await this.#api.listDecks(childId, { microphoneEnabled: false });
      if (epoch !== this.#epoch) return;
      this.#childId = childId;
      this.#recordingMode = this.#profiles.find((profile) => profile.childId === childId)?.recordingMode ?? "hold";
      this.#screen = {
        kind: "deck",
        profiles: this.#profiles,
        childId,
        decks,
        microphone: false,
        micDenied: this.#micDenied,
      };
    } catch (error) {
      if (epoch !== this.#epoch) return;
      this.#screen = { kind: "initError", message: messageForError(error) };
    }
    if (epoch !== this.#epoch) return;
    this.#emit();
    if (this.#screen.kind === "deck" && this.#screen.childId === childId) {
      void this.refreshProfiles().then(() => {
        if (epoch !== this.#epoch || this.#screen.kind !== "deck" || this.#screen.childId !== childId) return;
        this.#recordingMode = this.#profiles.find((profile) => profile.childId === childId)?.recordingMode ?? "hold";
      });
    }
  }

  async #resumeMockFromDecks(): Promise<void> {
    if (this.#screen.kind !== "deck") return;
    const activeMock = this.#screen.decks.find(d => d.activeSession?.mode === "mock_test");
    if (activeMock) await this.startMockTest(activeMock.deckId);
  }

  async setMicrophone(on: boolean): Promise<void> {
    if (this.#screen.kind !== "deck") return;
    // jawny wybór rodzica/dziecka nadpisuje zapamiętaną odmowę w obie strony —
    // po odmowie przełącznik nadal pozwala wrócić do nagrywania (SPEC §14)
    this.#micDenied = !on;
    if (on) {
      this.#storage.remove(MIC_DENIED_KEY);
    } else {
      this.#storage.write(MIC_DENIED_KEY, "1");
    }
    this.#screen = { ...this.#screen, microphone: on, micDenied: !on };
    this.#emit();
    const epoch = ++this.#epoch;
    try {
      const decks = await this.#api.listDecks(this.#screen.childId, { microphoneEnabled: on });
      if (epoch !== this.#epoch || this.#screen.kind !== "deck") return;
      this.#screen = { ...this.#screen, decks };
      this.#emit();
    } catch {
      // A temporary refresh failure does not discard the explicit local choice.
    }
  }

  async startMockTest(deckId: string): Promise<void> {
    await this.startLearning(deckId, "mock_test");
  }

  async backToDecks(): Promise<void> {
    this.#epoch += 1;
    this.#teardownRecording(); this.#stopPlayback();
    if (this.#childId !== null) await this.#openDeckScreen(this.#childId);
    else await this.start();
  }

  async startLearning(deckId: string, mode: "training" | "mock_test" = "training"): Promise<void> {
    if (this.#screen.kind !== "deck") return;
    const deckScreen = this.#screen;
    const startingEpoch = this.#epoch;
    const microphone = mode !== "mock_test" && deckScreen.microphone && this.#storage.read(MIC_DENIED_KEY) !== "1";
    if (microphone) {
      this.#screen = { kind: "loading" };
      this.#emit();
      await this.refreshProfiles();
      if (startingEpoch !== this.#epoch || this.#screen.kind !== "loading") return;
      this.#screen = { ...deckScreen, profiles: this.#profiles };
      this.#emit();
    }
    if (startingEpoch !== this.#epoch || this.#screen.kind !== "deck") return;
    const { childId } = deckScreen;
    this.#recordingMode = this.#profiles.find((profile) => profile.childId === childId)?.recordingMode ?? "hold";
    const selectedDeck = deckScreen.decks.find((deck) => deck.deckId === deckId);
    if (selectedDeck?.resumeOnly && selectedDeck.activeSession?.mode === "mock_test") mode = "mock_test";
    if (mode === "mock_test") {
      this.#mockDeckKind = deckScreen.decks.find(d => d.deckId === deckId)?.kind === "lesson" ? "lesson" : "vocabulary";
    }
    this.#epoch += 1;
    const epoch = this.#epoch;
    this.#screen = { kind: "loading" };
    this.#emit();
    // nowa sesja nie dziedziczy wyboru z poprzedniej (np. przerwanego awarią)
    this.#pendingChoice = null;
    try {
      const session = await this.#api.startSession({ childId, deckId, microphoneEnabled: mode === "mock_test" ? false : microphone, mode, supportsPictureVocabulary: true, supportsPictureRecognition: true });
      if (epoch !== this.#epoch) return;
      this.#beginActivityMeasurement(session.sessionId);
      if (session.mode === "mock_test" && (!session.resumed || session.tasksIssued === 0)) {
        this.#screen = { kind: "mockTestReady", session }; this.#emit(); return;
      }
      this.#screen = {
        kind: "learning",
        session,
        task: null,
        feedback: null,
        reveal: null,
        offline: false,
        busy: true,
        micDenied: this.#micDenied,
        recordingMode: this.#recordingMode,
        microphoneReady: false,
        recordingPhase: "idle",
        inputLevel: null,
        recordingNotice: null, technicalRecordingIssue: false,
        recording: false,
        processing: false,
        error: null,
        guidanceError: false,
      };
      this.#emit();
      if (session.resumed && session.microphoneEnabled && this.#micDenied && !session.canRead && session.vocabularyFormat === "picture") {
        await this.#disableSessionMicrophone(session, true);
        return;
      }
      await this.#loadNext(epoch, session.sessionId);
    } catch (error) {
      if (epoch !== this.#epoch) return;
      if (error instanceof KidApiError && error.code === "conflict") {
        const decks = await this.#api.listDecks(childId);
        if (epoch !== this.#epoch) return;
        const active = decks.find(d => d.activeSession);
        if (active) { this.#screen = { kind: "sessionConflict", active, childId }; this.#emit(); return; }
      }
      this.#screen = { kind: "initError", message: messageForError(error) };
      this.#emit();
    }
  }

  async beginMockTest(): Promise<void> {
    if (this.#screen.kind !== "mockTestReady") return;
    const session = this.#screen.session;
    this.#screen = { kind: "learning", session, task: null, feedback: null, reveal: null, offline: false, busy: true,
      micDenied: false, microphoneReady: false, recordingPhase: "idle", inputLevel: null, recordingNotice: null, technicalRecordingIssue: false,
      recordingMode: this.#recordingMode,
      recording: false, processing: false, error: null, guidanceError: false };
    this.#emit(); await this.#loadNext(this.#epoch, session.sessionId);
  }

  async cancelMockTest(): Promise<void> {
    if (this.#screen.kind !== "mockTestReady") return;
    const { sessionId, childId } = this.#screen.session;
    await this.#api.endSession(sessionId);
    await this.#openDeckScreen(childId);
    await this.#resumeMockFromDecks();
  }

  async resumeConflictingSession(): Promise<void> {
    if (this.#screen.kind !== "sessionConflict") return;
    const { childId, active } = this.#screen;
    this.#screen = { kind: "deck", childId, profiles: this.#profiles, decks: [active], microphone: false, micDenied: false };
    if (active.activeSession!.mode === "daily_round") {
      await this.#api.endSession(active.activeSession!.sessionId);
      await this.startLearning(active.deckId, "training");
      return;
    }
    await this.startLearning(active.deckId, active.activeSession!.mode);
  }

  async closeConflictingSession(): Promise<void> {
    if (this.#screen.kind !== "sessionConflict") return;
    const { childId, active } = this.#screen;
    await this.#api.endSession(active.activeSession!.sessionId);
    await this.#openDeckScreen(childId);
  }

  async endActiveSession(deckId: string): Promise<void> {
    if (this.#screen.kind !== "deck") return;
    const deck = this.#screen.decks.find((item) => item.deckId === deckId);
    if (!deck?.resumeOnly || !deck.activeSession) return;
    await this.#api.endSession(deck.activeSession.sessionId);
    await this.#openDeckScreen(this.#screen.childId);
  }

  /**
   * Prefetch następnego zadania przy feedbacku ZAKOŃCZONEJ próby (nie retry,
   * nie kartkówka — ta nie pokazuje feedbacku): serwer wydaje zadanie
   * i pieczętuje ekspozycje tak samo jak przy zwykłym pobraniu, a klient
   * trzyma je w pamięci do kliknięcia „Dalej”. Obrazy zadania ogrzewamy
   * od razu, żeby nie pobierały się dopiero po przejściu. Zadanie nie jest
   * pokazywane ani mierzone jako wyświetlone przed kliknięciem.
   */
  #prefetchNextTask(epoch: number, sessionId: string): void {
    if (this.#nextTaskPrefetch?.epoch === epoch && this.#nextTaskPrefetch.sessionId === sessionId) return;
    const promise = this.#api.nextTask(sessionId);
    this.#nextTaskPrefetch = { epoch, sessionId, promise };
    void promise.then((task) => {
      if (task === null || this.#nextTaskPrefetch?.promise !== promise) return;
      for (const assetId of imageAssetIdsOf(task)) {
        void this.#media.preloadImage?.(this.#api.mediaUrl(assetId)).catch(() => undefined);
      }
    }, () => undefined);
  }

  /** Pobiera wynik prefetchu dla bieżącej epoki/sesji albo zgłasza jego brak. */
  async #takePrefetchedTask(epoch: number, sessionId: string): Promise<{ hit: true; task: TaskDto | null } | { hit: false }> {
    const prefetch = this.#nextTaskPrefetch;
    if (!prefetch || prefetch.epoch !== epoch || prefetch.sessionId !== sessionId) return { hit: false };
    this.#nextTaskPrefetch = null;
    try {
      return { hit: true, task: await prefetch.promise };
    } catch {
      // Prefetch nie zmienia semantyki błędu: zwykłe pobranie w #loadNext
      // ponawia żądanie i przechodzi normalną obsługę awarii/sieci.
      return { hit: false };
    }
  }

  async #loadNext(epoch: number, sessionId: string): Promise<void> {
    this.#setResume(() => this.#loadNext(epoch, sessionId));
    try {
      const prefetched = await this.#takePrefetchedTask(epoch, sessionId);
      const task = prefetched.hit ? prefetched.task : await this.#api.nextTask(sessionId);
      if (epoch !== this.#epoch || this.#screen.kind !== "learning") return;
      if (task === null) {
        await this.#finishSession(epoch);
        return;
      }
      // odsłuch poprzedniego zadania nie przenosi się do następnego
      this.#stopPlayback();
      // nowo wyświetlone zadanie dopuszcza auto-start; stan auto-próby
      // poprzedniej karty nie przetrwa przejścia (SPEC §16)
      this.#resetAutoCapture();
      this.#autoCaptureTaskId = null;
      this.#screen = {
        ...this.#screen,
        task,
        feedback: null,
        reveal: null,
        busy: false,
        transitioning: false,
        pendingChoiceId: null,
        offline: false,
        processing: false,
        recordingPhase: "idle",
        inputLevel: null,
        recordingNotice: null, technicalRecordingIssue: false,
        error: null,
        taskAudioError: null,
        questionAudioError: false,
        // „Posłuchaj i wybierz”: opcje czekają na pierwszy odsłuch nowego zadania.
        listenStimulus: task.prompt.kind === "lesson_listen_choice" ? { taskId: task.taskId, state: "pending", playing: false } : null,
      };
      this.#emit();
      // Pierwsze otrzymane zadanie uruchamia lokalny pomiar (design §2) — także
      // wznowione z pendingAttemptId (ocena w trakcie po odświeżeniu), żeby czas
      // tego zadania był mierzony, a jego próba trafiła do właściwego zadania.
      this.#activity?.taskShown(task.taskId, task.exerciseType);
      this.#saveActivityDraft();
      if (task.pendingAttemptId) {
        this.#activity?.pause("technical_wait");
        this.#saveActivityDraft();
        this.#setLearning({ processing: true, busy: true });
        await this.#pollAttempt(task.pendingAttemptId, epoch, Date.now() + POLL_DEADLINE_MS, task.taskId);
        return;
      }
      // prezentacja od razu odtwarza wzorcową wymowę, a pytanie słuchowe
      // stanowi treść zadania (SPEC §12.1, §12.2); ograniczenia urządzenia
      // łapiemy cicho — pozostaje widoczny przycisk odsłuchu
      if (task.exerciseType === "exposure" || task.exerciseType === "listening") {
        void this.playTaskAudio().catch(() => undefined);
      }
      // „Posłuchaj i wybierz”: zdanie jest treścią zadania — gramy je raz od razu
      // (także zadanie z prefetchu; nie w kartkówce i nie przy pendingAttemptId).
      if (task.prompt.kind === "lesson_listen_choice" && this.#screen.session.mode !== "mock_test") {
        void this.playListenStimulus({ auto: true }).catch(() => undefined);
        // Po powrocie z offline (`markOffline` → `retry`) zadanie zostaje — bez ponownego
        // pobrania i autoodtwarzania (spec §8); nieotwarty bodziec przechodzi w `blocked`.
        this.#setResume(this.#listenResume(task.taskId), true);
      }
    } catch (error) {
      if (epoch !== this.#epoch || this.#screen.kind !== "learning") return;
      this.#handleFailure(error);
    }
  }

  async #finishSession(epoch: number): Promise<void> {
    if (this.#screen.kind !== "learning") return;
    const { sessionId, childId, mode } = this.#screen.session;
    this.#setResume(() => this.#finishSession(epoch));
    // Zamrożenie raportu PRZED zakończeniem, dokładnie raz na sesję: retry
    // transportowe ponawia żądanie z tym SAMYM obiektem (identyczny fingerprint),
    // więc serwer zwraca zapisany wynik zamiast konfliktu (macierz „Retry transportu").
    if (this.#frozenActivityReport === undefined) {
      this.#frozenActivityReport = this.#activity !== null && this.#activity.started ? this.#activity.freeze() : null;
      if (this.#frozenActivityReport) {
        const state = this.#activity!.state;
        if (!this.#activityDrafts.save({
          sessionId,
          childId,
          savedAtMs: this.#activityClock.now(),
          state,
          finalPayload: this.#frozenActivityReport,
        })) this.#activity!.markStorageUnavailable();
      }
    }
    const report = this.#frozenActivityReport ?? undefined;
    try {
      const summary = await this.#api.endSession(sessionId, report);
      if (epoch !== this.#epoch) return;
      this.#lastActivityResult = summary.activity ?? null;
      this.#lastActivitySessionId = sessionId;
      this.#lastActivityChildId = childId;
      // Po zaakceptowaniu raportu nie zachowujemy już payloadu aktywności.
      // Pending zawiera tylko identyfikator sesji i właściciela wyniku.
      if (report !== undefined && summary.activity?.status === "already_started") {
        this.#rememberPendingActivityResult(sessionId, childId);
      } else if (report !== undefined) {
        this.#activityDrafts.remove(sessionId);
      }
      if (mode !== "mock_test") {
        this.#teardownRecording();
        this.#stopPlayback();
        this.#screen = { kind: "summary", childId, profiles: this.#profiles, summary };
        this.#emit();
        void this.refreshProfiles();
        return;
      }
      void this.refreshProfiles();
      if (mode === "mock_test" && this.#mockDeckKind === "lesson") {
        this.#teardownRecording();
        this.#stopPlayback();
        const pendingSummary: LessonMockTestSummaryDto = {
          sessionId, deckId: this.#screen.session.deckId, state: summary.state, complete: summary.state === "completed",
          taskBudget: this.#screen.session.taskBudget, answeredCount: summary.assessedTasksIssued, solutions: [],
        };
        this.#screen = { kind: "lessonMockTestSummary", childId, summary: pendingSummary, detailsLoading: true, detailsError: false };
        this.#emit();
        void this.retryMockTestSummaryDetails();
        return;
      }
      this.#teardownRecording();
      this.#stopPlayback();
      const pendingSummary: MockTestSummaryDto = {
        sessionId, deckId: this.#screen.session.deckId, state: summary.state, complete: summary.state === "completed",
        taskBudget: this.#screen.session.taskBudget, answeredCount: summary.assessedTasksIssued, solutions: [],
      };
      this.#screen = { kind: "mockTestSummary", childId, summary: pendingSummary, detailsLoading: true, detailsError: false };
      this.#emit();
      void this.retryMockTestSummaryDetails();
    } catch (error) {
      if (epoch !== this.#epoch || this.#screen.kind !== "learning") return;
      this.#handleFailure(error);
    }
  }

  /** Ponawia pobranie szczegółów kartkówki bez opuszczania podsumowania. */
  async retryMockTestSummaryDetails(): Promise<void> {
    const initial = this.#screen;
    if (initial.kind !== "mockTestSummary" && initial.kind !== "lessonMockTestSummary") return;
    const epoch = this.#epoch;
    const { sessionId } = initial.summary;
    this.#screen = { ...initial, detailsLoading: true, detailsError: false };
    this.#emit();
    try {
      if (initial.kind === "mockTestSummary") {
        const summary = await this.#api.readMockTestSummary(sessionId);
        if (this.#disposed || epoch !== this.#epoch || this.#screen.kind !== "mockTestSummary"
          || this.#screen.summary.sessionId !== sessionId || this.#screen.childId !== initial.childId) return;
        this.#screen = { ...this.#screen, summary, detailsLoading: false, detailsError: false };
      } else {
        const summary = await this.#api.readLessonMockTestSummary(sessionId);
        if (this.#disposed || epoch !== this.#epoch || this.#screen.kind !== "lessonMockTestSummary"
          || this.#screen.summary.sessionId !== sessionId || this.#screen.childId !== initial.childId) return;
        this.#screen = { ...this.#screen, summary, detailsLoading: false, detailsError: false };
      }
    } catch {
      if (this.#disposed || epoch !== this.#epoch || this.#screen.kind !== initial.kind
        || this.#screen.summary.sessionId !== sessionId || this.#screen.childId !== initial.childId) return;
      this.#screen = { ...this.#screen, detailsLoading: false, detailsError: true };
    }
    this.#emit();
  }

  /** Dalej po feedbacku albo ponowne podejście, gdy zadanie na to pozwala. */
  async continueLearning(): Promise<void> {
    const screen = this.#learning();
    if (!screen || screen.busy) return;
    this.#stopPlayback();
    if (screen.feedback?.retry) {
      this.#setLearning({ feedback: null });
      return;
    }
    this.#setLearning({ busy: true, transitioning: true, pendingChoiceId: null });
    await this.#loadNext(this.#epoch, screen.session.sessionId);
  }

  async endNow(): Promise<void> {
    const screen = this.#learning();
    if (!screen || screen.busy) return;
    this.#teardownRecording();
    this.#stopPlayback();
    this.#setLearning({ busy: true, transitioning: true });
    await this.#finishSession(this.#epoch);
  }

  /**
   * Otwarcie potwierdzenia „Koniec”: trwające nagranie przepada bez wysłania,
   * odtwarzanie milknie. Wysyłane już nagranie („stopping”) kończy się zwykłym
   * trybem, a mikrofon nie startuje ponownie sam po powrocie do zadania.
   * Do `releaseEndConfirm` auto-start jest wstrzymany: także ten, który czeka
   * na odczyt uprawnienia, bo po każdym oczekiwaniu ponownie pyta
   * `#autoCaptureAllowed`, a osobna generacja auto-startu unieważnia go także
   * wtedy, gdy panel zamknięto przed końcem oczekiwania. Generacja nagrania
   * zostaje, żeby nie unieważnić obsługi błędu wysłanej już próby.
   */
  holdForEndConfirm(): void {
    const screen = this.#learning();
    if (!screen) return;
    this.#endConfirmSessionId = screen.session.sessionId;
    this.#autoCaptureGeneration += 1;
    if (screen.recordingPhase === "preparing" || screen.recordingPhase === "starting" || screen.recordingPhase === "recording") {
      this.cancelRecording();
    }
    this.#stopPlayback();
    this.#interruptListenStimulus();
  }

  /** Zamknięcie potwierdzenia „Koniec”: znosi blokadę auto-startu, niczego nie uruchamia. */
  releaseEndConfirm(): void {
    this.#endConfirmSessionId = null;
  }

  async completePresentation(): Promise<void> {
    const screen = this.#learning();
    if (!screen?.task || screen.busy || (screen.task.exerciseType !== "exposure" && screen.task.exerciseType !== "lesson_card")) return;
    const epoch = this.#epoch;
    const sessionId = screen.session.sessionId;
    const taskId = screen.task.taskId;
    // „Dalej” kończy odsłuch karty przed przejściem (design szkoły §12.4).
    this.#stopPlayback();
    this.#setLearning({ busy: true, transitioning: true, questionAudioError: false });
    this.#activity?.recordInteraction();
    this.#activity?.pause("technical_wait");
    this.#setResume(async () => {
      await this.#api.completePresentation(taskId);
      await this.#loadNext(epoch, sessionId);
    });
    try {
      await this.#api.completePresentation(taskId);
      await this.#loadNext(epoch, sessionId);
    } catch (error) {
      if (epoch !== this.#epoch || this.#screen.kind !== "learning") return;
      this.#handleFailure(error);
    }
  }

  async answerChoice(optionId: string): Promise<void> {
    // „Posłuchaj i wybierz”: bez odsłuchu odpowiedź byłaby nieoceniona — opcje czekają na `open`.
    // Kartkówka nigdy nie dostaje tego typu (serwer go wyklucza), więc strażnik jej nie blokuje.
    const screen = this.#learning();
    if (screen?.task?.prompt.kind === "lesson_listen_choice" &&
        (screen.listenStimulus?.taskId !== screen.task.taskId || screen.listenStimulus.state !== "open")) return;
    await this.#submitAnswer({ modality: "choice", optionId });
  }

  /**
   * Odpowiedź tekstowa; `speech` = tekst pochodzi z dyktowania w tym zadaniu
   * (serwer sprawdza, że dyktowanie było, i sam liczy, czy tekst poprawiono).
   */
  async answerText(text: string, inputMethod: TextInputMethod = "keyboard"): Promise<void> {
    await this.#submitAnswer({ modality: "text", text: text.trim(), ...(inputMethod === "speech" ? { inputMethod } : {}) });
  }

  /** Odpowiedź `sequence` (ułożone klocki `lesson_order`). */
  async answerSequence(itemIds: string[]): Promise<void> {
    await this.#submitAnswer({ modality: "sequence", itemIds });
  }

  /** Odpowiedź `selection` (zaznaczone pojęcia `lesson_keywords`; zbiór bez kolejności). */
  async answerSelection(itemIds: string[]): Promise<void> {
    await this.#submitAnswer({ modality: "selection", itemIds: [...new Set(itemIds)] });
  }

  /** Przypisania „Połącz w pary” / „Pogrupuj”; kompletność i poprawność sprawdza serwer. */
  async answerAssignment(assignments: Assignment[]): Promise<void> {
    await this.#submitAnswer({ modality: "assignment", assignments: assignments.map((entry) => ({ itemId: entry.itemId, targetId: entry.targetId })) });
  }

  /** „Nie pamiętam — pokaż”: ujawnienie z zapisem ekspozycji przed treścią (SPEC §15.1). */
  async notRemember(): Promise<void> {
    const screen = this.#learning();
    if (!screen?.task || screen.busy || screen.offline) return;
    if (screen.session.mode === "mock_test") { await this.#submitAnswer({ modality: "dont_remember" }); return; }
    const epoch = this.#epoch;
    const taskId = screen.task.taskId;
    const task = screen.task;
    // Podpowiedź po „Nie pamiętam” nie może grać razem z nagraniem pytania.
    this.#stopPlayback();
    this.#setLearning({ taskAudioError: null, questionAudioError: false });
    this.#setLearning({ busy: true });
    const disclose = async (): Promise<void> => {
      const disclosure = await this.#api.authorizeDisclosure(taskId, "hint");
      if (epoch !== this.#epoch || this.#learning() === null) return;
      this.#setLearning({ reveal: { target: disclosure.reveal?.target ?? "", ...(task.prompt.kind === "picture_recall" ? { visual: task.prompt.visual, ...(disclosure.audioAssetId ? { audioAssetId: disclosure.audioAssetId } : {}) } : {}) }, busy: false, transitioning: false });
    };
    this.#setResume(disclose);
    try {
      await disclose();
    } catch (error) {
      if (epoch !== this.#epoch || this.#screen.kind !== "learning") return;
      this.#handleFailure(error);
    }
  }

  /** Potwierdzenie ujawnionego słowa wysyła zadeklarowaną trudność. */
  async confirmReveal(): Promise<void> {
    await this.#submitAnswer({ modality: "dont_remember" });
  }

  async playRevealAudio(): Promise<void> {
    const screen = this.#learning();
    const reveal = screen?.reveal;
    const task = screen?.task;
    if (!screen || !task || !reveal?.audioAssetId || screen.offline || screen.busy) return;
    const generation = this.#beginPlayback();
    const epoch = this.#epoch;
    try {
      const authorization = await this.#api.authorizeDisclosure(task.taskId, "audio");
      const current = this.#learning();
      if (generation !== this.#playbackGeneration || epoch !== this.#epoch || current?.task?.taskId !== task.taskId || !authorization.audioAssetId) return;
      await this.#playCountedAudio(this.#api.mediaUrl(authorization.audioAssetId), authorization.audioAssetId);
    } catch {
      if (generation === this.#playbackGeneration && epoch === this.#epoch) this.#handleFailure(new Error("Audio playback failed"));
    }
  }

  async skip(): Promise<void> {
    if (this.#autoCaptureActive) this.cancelRecording();
    await this.#submitAnswer({ modality: "skip" });
  }

  async #submitAnswer(input: AnswerPayload): Promise<void> {
    const screen = this.#learning();
    if (!screen?.task || screen.busy || screen.offline) return;
    const epoch = this.#epoch;
    const taskId = screen.task.taskId;
    // Komunikat o audio zadania gaśnie przy odpowiedzi tylko w „Posłuchaj i wybierz” (nie wisi nad
    // feedbackiem pominięcia); w pozostałych typach zostaje, żeby układ był stabilny do werdyktu.
    const clearTaskAudioError = screen.task.prompt.kind === "lesson_listen_choice";
    this.#setLearning({ busy: true, transitioning: true, questionAudioError: false,
      ...(clearTaskAudioError ? { taskAudioError: null } : {}),
      pendingChoiceId: input.modality === "choice" ? input.optionId : null });
    this.#activity?.recordInteraction();
    this.#activity?.pause("technical_wait");
    this.#stopPlayback();
    this.#pendingChoice = input.modality === "choice" ? input.optionId : null;
    const clientAttemptId = randomUUID();
    const send = async (): Promise<void> => {
      const attempt = await this.#api.submitAnswer({ ...input, taskId, clientAttemptId });
      await this.#applyAttempt(attempt, epoch, taskId);
    };
    this.#setResume(send);
    try {
      await send();
    } catch (error) {
      if (epoch !== this.#epoch || this.#screen.kind !== "learning") return;
      if (screen.session.mode === "mock_test" && error instanceof KidApiError && error.code === "conflict") {
        this.#setResume(() => this.#loadNext(epoch, screen.session.sessionId));
      }
      this.#handleFailure(error);
    }
  }

  async #applyAttempt(attempt: AttemptDto, epoch: number, expectedTaskId: string): Promise<void> {
    if (epoch !== this.#epoch || this.#screen.kind !== "learning" || this.#screen.task?.taskId !== expectedTaskId) return;
    // Próba przyjęta przez serwer: łączymy raport z faktyczną odpowiedzią.
    this.#activity?.attemptSubmitted(attempt.attemptId);
    if (attempt.state === "processing") {
      this.#setLearning({ processing: true, busy: true });
      await this.#pollAttempt(attempt.attemptId, epoch, Date.now() + POLL_DEADLINE_MS, expectedTaskId);
      return;
    }
    await this.#showResult(attempt, epoch);
  }

  async #pollAttempt(attemptId: string, epoch: number, deadline: number, expectedTaskId?: string): Promise<void> {
    const taskId = expectedTaskId ?? (this.#learning()?.task?.taskId ?? "");
    this.#setResume(() => this.#pollAttempt(attemptId, epoch, deadline, taskId));
    try {
      const attempt = await this.#api.readAttempt(attemptId);
      if (epoch !== this.#epoch || this.#screen.kind !== "learning" || this.#screen.task?.taskId !== taskId) return;
      if (attempt.state === "processing" && Date.now() < deadline) {
        await sleep(this.#pollIntervalMs);
        if (epoch !== this.#epoch) return;
        await this.#pollAttempt(attemptId, epoch, deadline, taskId);
        return;
      }
      await this.#showResult(attempt, epoch);
    } catch (error) {
      if (epoch !== this.#epoch || this.#screen.kind !== "learning") return;
      this.#handleFailure(error);
    }
  }

  async #showResult(attempt: AttemptDto, epoch: number): Promise<void> {
    if (epoch !== this.#epoch || this.#screen.kind !== "learning") return;
    this.#resume = null;
    const chosenOptionId = this.#pendingChoice;
    this.#pendingChoice = null;
    if (this.#screen.session.mode === "mock_test") {
      this.#setLearning({ feedback: null, reveal: null, processing: false, busy: true, answerSaved: true });
      await this.#loadNext(epoch, this.#screen.session.sessionId); return;
    }
    // „Rozumiem” potwierdziło już pokazany wzorzec. Po zapisaniu trudności
    // przechodzimy do wsparcia, bez drugiego feedbacku na zamkniętym formularzu.
    // Wyjątek: lekcja z nagraniem zdania — pokazujemy wynik z odczytem
    // i „Posłuchaj zdania” do kliknięcia „Dalej” (design odczytu zdania §1, §7).
    const sentenceReadback = attempt.feedback?.correctAudioAssetId !== undefined && isLessonTask(this.#screen.task);
    if (attempt.modality === "dont_remember" && this.#screen.reveal !== null && attempt.taskState !== "issued" && !sentenceReadback) {
      // Zachowaj wzorzec do atomowej podmiany zadania w #loadNext:
      // usunięcie reveal wcześniej odsłoniłoby poprzedni formularz na czas sieci.
      this.#setLearning({ feedback: null, processing: false, busy: true });
      await this.#loadNext(epoch, this.#screen.session.sessionId);
      return;
    }
    this.#screen = {
      ...this.#screen,
      busy: false,
      transitioning: false,
      pendingChoiceId: null,
      processing: false,
      // feedback zastępuje panel ujawnienia podpowiedzi
      reveal: null,
      feedback: {
        dto: attempt.feedback,
        retry: attempt.taskState === "issued",
        attemptId: attempt.attemptId,
        modality: attempt.modality,
        ...(chosenOptionId !== null ? { chosenOptionId } : {}),
      },
    };
    // Drugie podejście tego samego zadania: pomiar trwa dalej bez zmiany zadania.
    this.#emit();
    // Zakończona próba: następne zadanie i jego obrazy pobieramy już teraz,
    // w czasie oglądania feedbacku — klik „Dalej” nie czeka na sieć (przy
    // retry zadanie zostaje to samo, więc nie ma czego pobierać).
    // Wyjątek: feedback mowy z odsłuchem wzorca — serwer autoryzuje go tylko
    // dla najnowszego zadania sesji, więc wydanie następnego przed kliknięciem
    // „Posłuchaj” kończyłoby się konfliktem i błędem audio na karcie wyniku.
    if (attempt.taskState !== "issued" && attempt.feedback?.referenceAudioAvailable !== true) {
      this.#prefetchNextTask(epoch, this.#screen.session.sessionId);
    }
    // Lekcja: feedback z rozwiązaniem niesie nagranie pełnego zdania — gramy je
    // raz od razu (design odczytu zdania §7). Zablokowane autoodtwarzanie i błąd
    // pliku są ciche; zostaje przycisk „Posłuchaj zdania” w doku.
    if (sentenceReadback) {
      void this.#playSentence("normal", { manual: false });
    }
  }

  /**
   * Odczyt pełnego zdania w feedbacku lekcji (automatycznie po wyniku i ręcznie
   * z doku). Identyfikator przyszedł z oceną, a serwer zapieczętował ujawnienie
   * (`audio_issued`) przed odpowiedzią HTTP — odtwarzamy plik bezpośrednio.
   * `picture_recognition` ma własny, ręczny odsłuch słowa (`playCorrectOptionAudio`).
   */
  async playSentenceAudio(rate: SentenceRate = "normal"): Promise<void> {
    await this.#playSentence(rate, { manual: true });
  }

  /**
   * Jeden przebieg odczytu zdania (design kontynuacji odczytu §4.1). Wskaźnik
   * i błąd zapisujemy tylko, gdy przebieg jest nadal ostatni, niezakończony,
   * nieprzerwany przez `#stopPlayback` i dotyczy tego samego wyniku (`attemptId`)
   * — spóźniony start lub koniec nie dotknie nowego odczytu ani następnego
   * zadania. Każdy zapis robi spread z BIEŻĄCEGO feedbacku w chwili zapisu.
   * Strażnik sprawdza oprócz `#sentenceRun` także `#playbackGeneration` i epokę:
   * każde zatrzymanie podbija generację, więc spóźnione `onStarted` po przerwaniu
   * przez „?” albo odsłuch pytania (ten sam wynik, ten sam numer przebiegu) nie
   * zapali zgaszonego już wskaźnika — nie upraszczaj go do samego numeru przebiegu.
   * Autoodczyt (`manual: false`) nigdy nie ustawia błędu: zablokowane
   * autoodtwarzanie jest ciche, zostaje przycisk w doku.
   */
  async #playSentence(rate: SentenceRate, { manual }: { manual: boolean }): Promise<void> {
    const screen = this.#learning();
    const feedback = screen?.feedback;
    const assetId = feedback?.dto?.correctAudioAssetId;
    if (this.#disposed || !screen || !isLessonTask(screen.task) || feedback === null || feedback === undefined ||
        assetId === undefined || screen.offline || screen.busy || screen.recordingPhase !== "idle") return;
    const run = ++this.#sentenceRun;
    const attemptId = feedback.attemptId;
    const epoch = this.#epoch;
    const taskId = screen.task!.taskId;
    // Poprzednie odtwarzanie (np. pytanie, odczyt w innym tempie) ustępuje;
    // „Dalej”, nowe zadanie i każde inne odtwarzanie przerywają odczyt przez #stopPlayback.
    const playbackGeneration = this.#beginPlayback();
    let finished = false;
    const currentFeedback = (): NonNullable<LearningScreen["feedback"]> | null => {
      if (finished || run !== this.#sentenceRun || playbackGeneration !== this.#playbackGeneration || epoch !== this.#epoch) return null;
      const now = this.#learning()?.feedback;
      return now && now.attemptId === attemptId ? now : null;
    };
    let failed = false;
    try {
      await this.#playCountedAudio(this.#api.mediaUrl(assetId), assetId, {
        ...(rate === "slow" ? { rate: SLOW_PLAYBACK_RATE } : {}),
        onStarted: () => {
          // „Posłuchaj i wybierz”: odczyt gra z przycisku w poleceniu — pierścień dźwięku na czas odczytu.
          this.#markListenPlaying(playbackGeneration, taskId);
          const now = currentFeedback();
          if (now) this.#setLearning({ feedback: { ...now, sentencePlaying: rate, sentenceAudioError: null } });
        },
      });
    } catch {
      // Błąd sieci traktujemy jak każdy inny błąd odsłuchu: bez trybu offline —
      // utratę połączenia wykrywają inne ścieżki kontrolera (§4.1 pkt 5).
      failed = true;
    }
    this.#releaseListenPlaying(playbackGeneration);
    const now = currentFeedback();
    finished = true;
    if (!now) return;
    if (failed && manual) {
      this.#setLearning({ feedback: { ...now, sentencePlaying: null, sentenceAudioError: { rate, seq: ++this.#sentenceErrorSeq } } });
    } else if ((now.sentencePlaying ?? null) !== null) {
      this.#setLearning({ feedback: { ...now, sentencePlaying: null } });
    }
  }

  /** Odtwarza wzorzec wskazany przez serwer dla nadal widocznej karty wyniku. */
  async playFeedbackAudio(): Promise<void> {
    const screen = this.#learning();
    const feedback = screen?.feedback;
    if (!screen || !screen.task || !feedback?.dto?.referenceAudioAvailable || screen.offline ||
        screen.recordingPhase !== "idle" || screen.processing || screen.busy) return;
    const epoch = this.#epoch;
    const taskId = screen.task.taskId;
    const attemptId = feedback.attemptId;
    const playbackGeneration = this.#beginPlayback();
    // Spread z bieżącego feedbacku: #beginPlayback mógł właśnie zgasić wskaźnik odczytu zdania.
    this.#setLearning({ feedback: { ...(this.#learning()?.feedback ?? feedback), audioError: false } });
    try {
      const authorization = await this.#api.authorizeFeedbackAudio(attemptId);
      const current = this.#learning();
      if (playbackGeneration !== this.#playbackGeneration || epoch !== this.#epoch || !current ||
          current.offline || current.recordingPhase !== "idle" || current.processing ||
          current.task?.taskId !== taskId || current.feedback?.attemptId !== attemptId) return;
      if (authorization.attemptId !== attemptId || authorization.taskId !== taskId) return;
      await this.#playCountedAudio(this.#api.mediaUrl(authorization.audioAssetId), authorization.audioAssetId);
      const afterPlay = this.#learning();
      if (playbackGeneration !== this.#playbackGeneration || epoch !== this.#epoch || !afterPlay ||
          afterPlay.task?.taskId !== taskId || afterPlay.feedback?.attemptId !== attemptId) return;
    } catch {
      const current = this.#learning();
      if (playbackGeneration === this.#playbackGeneration && epoch === this.#epoch && current?.task?.taskId === taskId && current.feedback?.attemptId === attemptId) {
        this.#setLearning({ feedback: { ...current.feedback, audioError: true } });
      }
    }
  }

  /**
   * Odsłuch poprawnego słowa w feedbacku `picture_recognition`: identyfikator
   * wysłał serwer razem z oceną (z pieczęcią audio_issued przed HTTP), więc
   * odtwarzamy plik bezpośrednio, bez ponownej autoryzacji ujawnienia.
   */
  async playCorrectOptionAudio(): Promise<void> {
    const screen = this.#learning();
    const feedback = screen?.feedback;
    const assetId = feedback?.dto?.correctAudioAssetId;
    const taskId = screen?.task?.taskId;
    if (!screen || !screen.task || taskId === undefined || feedback === null || feedback === undefined ||
        assetId === undefined || screen.offline || screen.busy) return;
    const epoch = this.#epoch;
    const playbackGeneration = this.#beginPlayback();
    const feedbackAttemptId = feedback.attemptId;
    try {
      await this.#playCountedAudio(this.#api.mediaUrl(assetId), assetId);
      const current = this.#learning();
      if (playbackGeneration !== this.#playbackGeneration || epoch !== this.#epoch ||
          current?.task?.taskId !== taskId || current.feedback?.attemptId !== feedbackAttemptId) return;
    } catch {
      // Odsłuch jest dodatkiem wzmacniającym skojarzenie: awaria pliku nie
      // psuje feedbacku ani przebiegu — przycisk po prostu nic nie odtwarza.
    }
  }

  /**
   * Odtworzenie audio zadania — znaczenie zależy od typu ćwiczenia (SPEC §13.2):
   * pytanie słuchowe i prezentacja są częścią zadania; wzorzec w recall/
   * pisowni/ćwiczeniu wymowy wymaga zgody serwera PRZED odtworzeniem, także
   * gdy plik jest już w cache przeglądarki (arch §9.2).
   */
  async playTaskAudio(): Promise<void> {
    if (this.#autoCaptureActive) this.cancelRecording();
    const screen = this.#learning();
    if (!screen?.task || screen.offline || screen.recordingPhase !== "idle" || screen.processing) return;
    if (screen.task.prompt.kind === "lesson_listen_choice") {
      await this.playListenStimulus();
      return;
    }
    const task = screen.task;
    this.#setLearning({ taskAudioError: null });
    const playbackGeneration = this.#beginPlayback();
    const epoch = this.#epoch;
    let assetId = audioAssetOf(task);
    if (task.prompt.kind === "picture_recall") {
      try {
        const authorization = await this.#api.authorizeDisclosure(task.taskId, "audio");
        const current = this.#learning();
        if (playbackGeneration !== this.#playbackGeneration || epoch !== this.#epoch || !current || current.offline || current.recordingPhase !== "idle" || current.processing || current.task?.taskId !== task.taskId) return;
        assetId = authorization.audioAssetId ?? null;
      } catch (error) {
        const current = this.#learning();
        if (playbackGeneration === this.#playbackGeneration && epoch === this.#epoch &&
            current?.session.sessionId === screen.session.sessionId && current.task?.taskId === task.taskId) {
          this.#setResume(() => this.playTaskAudio(), true);
          this.#handleFailure(error);
        }
        return;
      }
    }
    if (!assetId) return;
    if (task.prompt.kind !== "picture_recall" && (screen.session.mode === "mock_test" || AUDIO_DISCLOSURE_EXERCISES.has(task.exerciseType))) {
      try {
        await this.#api.authorizeDisclosure(task.taskId, "audio");
      } catch (error) {
        const current = this.#learning();
        if (playbackGeneration === this.#playbackGeneration && epoch === this.#epoch && current?.session.sessionId === screen.session.sessionId && current.task?.taskId === task.taskId) {
          const resumeIsNextTask = screen.session.mode === "mock_test" && error instanceof KidApiError && error.code === "conflict";
          this.#setResume(
            resumeIsNextTask ? () => this.#loadNext(epoch, screen.session.sessionId) : () => this.playTaskAudio(),
            !resumeIsNextTask,
          );
          this.#handleFailure(error);
        }
        return;
      }
      const current = this.#learning();
      if (playbackGeneration !== this.#playbackGeneration || epoch !== this.#epoch || !current || current.offline || current.recordingPhase !== "idle" || current.processing || current.session.sessionId !== screen.session.sessionId || current.task?.taskId !== task.taskId) return;
    }
    try {
      await this.#playCountedAudio(this.#api.mediaUrl(assetId), assetId);
      const current = this.#learning();
      if (playbackGeneration !== this.#playbackGeneration || epoch !== this.#epoch || !current || current.offline || current.recordingPhase !== "idle" || current.task?.taskId !== task.taskId) return;
      if (task.exerciseType === "listening") {
        // liczba odsłuchów pytania jest zapisywana jako obserwacja (§13.2);
        // tylko faktycznie rozpoczęte odtwarzanie — zablokowany autoplay
        // nie jest odsłuchem
        void this.#api
          .recordObservation({ taskId: task.taskId, clientEventId: randomUUID(), kind: "audio_played" })
          .catch(() => undefined);
      }
    } catch (error) {
      // Rozróżniamy blokadę autoplay od uszkodzonego/niedostępnego pliku.
      const current = this.#learning();
      if (playbackGeneration !== this.#playbackGeneration || epoch !== this.#epoch || current?.task?.taskId !== task.taskId) return;
      if (isNetworkError(error)) {
        this.#handleFailure(error);
      } else {
        this.#setLearning({ taskAudioError: (error as { name?: unknown } | null)?.name === "NotAllowedError" ? "blocked" : "failed" });
      }
    }
  }

  /**
   * Przerwany bodziec „Posłuchaj i wybierz” (potwierdzenie końca, tło, utrata fokusu):
   * `#stopPlayback` kasuje stoper braku startu, a nieotwarty bodziec zostałby w cichym
   * `pending` z zablokowanymi opcjami, a bodziec już `blocked` — bez licznika „Pomiń”.
   * Przechodzi więc ścieżką wznowienia z offline: `blocked` (status i wyróżniony głośnik),
   * a po 6 s „Pomiń”. Bodziec otwarty i zadanie z wynikiem zostają bez zmian.
   */
  #interruptListenStimulus(): void {
    const screen = this.#learning();
    const stimulus = screen?.listenStimulus;
    if (!screen?.task || screen.offline || screen.feedback !== null || stimulus?.taskId !== screen.task.taskId ||
        (stimulus.state !== "pending" && stimulus.state !== "blocked")) return;
    void this.#listenResume(stimulus.taskId)();
  }

  /**
   * Wznowienie zadania słuchowego po powrocie z offline: bez autoodtwarzania. Bodziec, który
   * nie był otwarty (`pending` albo już `blocked`), przechodzi w `blocked` — status i wyróżniony głośnik — a po
   * 6 s bez naciśnięcia w `unavailable` („Pomiń”), jak przy zablokowanym autoodtwarzaniu.
   */
  #listenResume(taskId: string): () => Promise<void> {
    return async () => {
      const stimulus = this.#learning()?.listenStimulus;
      if (stimulus?.taskId !== taskId || (stimulus.state !== "pending" && stimulus.state !== "blocked")) return;
      // Także już zablokowany bodziec: #stopPlayback skasował jego licznik, więc uzbrajamy go od nowa.
      this.#patchListenStimulus(taskId, { state: "blocked", playing: false });
      const epoch = this.#epoch;
      this.#listenTimers.push(setTimeout(() => {
        const current = this.#learning();
        if (epoch !== this.#epoch || !current || current.offline || current.feedback !== null ||
            current.listenStimulus?.taskId !== taskId || current.listenStimulus.state !== "blocked") return;
        this.#patchListenStimulus(taskId, { state: "unavailable" });
      }, LISTEN_NO_START_MS));
    };
  }

  /**
   * Bodziec „Posłuchaj i wybierz” (`lesson_listen_choice`, spec §8): autoryzacja
   * nagrania (`audio_issued` przed wydaniem id), potem odtworzenie. Opcje otwiera
   * (`open`) dopiero koniec odtwarzania przy niezmienionej generacji — przerwanie
   * rozstrzyga `play()` tak samo jak koniec, więc go nie odblokowuje — albo zapas
   * `durationMs + 1 s` (8 s bez długości) od startu. Bez startu po 6 s od żądania
   * autoryzacji: `unavailable` („Pomiń”, przycisk nadal działa). `NotAllowedError`:
   * `blocked` przy autoodtwarzaniu (status, po 6 s „Pomiń”), `unavailable`
   * z komunikatem przy ręcznym naciśnięciu. Odmowa autoryzacji i błąd pliku:
   * `unavailable` — cicho przy autoodtwarzaniu, z komunikatem przy ręcznym naciśnięciu. Błąd sieci: zwykła
   * ścieżka offline, a ponowienie niczego samo nie odtwarza. Po odpowiedzi nic nie
   * robi — odczyt zdania z feedbacku gra `playSentenceAudio`.
   */
  async playListenStimulus(options: { auto?: boolean } = {}): Promise<void> {
    const auto = options.auto === true;
    const screen = this.#learning();
    const task = screen?.task;
    if (!screen || !task || task.prompt.kind !== "lesson_listen_choice" || screen.feedback !== null ||
        screen.offline || screen.busy || screen.processing || screen.recordingPhase !== "idle") return;
    const taskId = task.taskId;
    const epoch = this.#epoch;
    const generation = this.#beginPlayback();
    const previous = this.#learning()?.listenStimulus;
    // Nowa próba gasi status blokady; `unavailable` zostaje („Pomiń”) do udanego odsłuchu.
    this.#setLearning({
      taskAudioError: null,
      listenStimulus: {
        taskId,
        state: previous?.taskId === taskId && previous.state !== "blocked" ? previous.state : "pending",
        playing: false,
      },
    });
    const stale = (): boolean => {
      const current = this.#learning();
      return generation !== this.#playbackGeneration || epoch !== this.#epoch || !current ||
        current.task?.taskId !== taskId || current.feedback !== null || current.offline;
    };
    this.#listenTimers.push(setTimeout(() => {
      if (!stale()) this.#patchListenStimulus(taskId, { state: "unavailable" });
    }, LISTEN_NO_START_MS));
    const fail = (error: unknown): void => {
      if (isNetworkError(error)) {
        this.#clearListenTimers();
        // Ponowienie po powrocie sieci zostawia zadanie i przycisk — bez autoodtwarzania.
        this.#setResume(this.#listenResume(taskId), true);
        this.#handleFailure(error);
        return;
      }
      const blocked = (error as { name?: unknown } | null)?.name === "NotAllowedError";
      if (blocked && auto) {
        // Zablokowane autoodtwarzanie: status i wyróżniony głośnik. Licznik 6 s biegnie dalej,
        // więc bez naciśnięcia pojawia się „Pomiń”. Gdy licznik już wygasł (spóźniona autoryzacja),
        // „Pomiń” zostaje — powrót do `blocked` nie miałby już licznika.
        const expired = this.#learning()?.listenStimulus?.state === "unavailable";
        this.#patchListenStimulus(taskId, { state: expired ? "unavailable" : "blocked", playing: false });
        return;
      }
      // Ręczne naciśnięcie zablokowane albo błąd: „Pomiń” od razu, a przy ręcznym widoczny komunikat.
      this.#clearListenTimers();
      this.#patchListenStimulus(taskId, { state: "unavailable", playing: false });
      if (!auto) this.#setLearning({ taskAudioError: blocked ? "blocked" : "failed" });
    };
    let assetId: string;
    try {
      const authorization = await this.#api.authorizeDisclosure(taskId, "audio");
      if (stale()) return;
      if (!authorization.audioAssetId) throw new Error("Listen stimulus unavailable");
      assetId = authorization.audioAssetId;
    } catch (error) {
      if (!stale()) fail(error);
      return;
    }
    try {
      await this.#playCountedAudio(this.#api.mediaUrl(assetId), assetId, { onStarted: (durationMs) => {
        if (stale()) return;
        this.#clearListenTimers();
        this.#markListenPlaying(generation, taskId);
        const unlockMs = durationMs !== null && durationMs > 0 ? durationMs + LISTEN_UNLOCK_MARGIN_MS : LISTEN_UNLOCK_FALLBACK_MS;
        this.#listenTimers.push(setTimeout(() => {
          if (!stale()) this.#patchListenStimulus(taskId, { state: "open", playing: false });
        }, unlockMs));
      } });
    } catch (error) {
      this.#releaseListenPlaying(generation);
      if (!stale()) fail(error);
      return;
    }
    this.#releaseListenPlaying(generation);
    if (stale()) return;
    this.#clearListenTimers();
    this.#patchListenStimulus(taskId, { state: "open", playing: false });
  }

  /**
   * Odsłuch zdania przykładowego prezentacji (SPEC §22): plik przygotowany
   * z zestawem, treść zdania jest już widoczna na karcie, więc odtworzenie
   * nie wymaga zgody serwera ani nie ujawnia niczego nowego.
   */
  async playExampleAudio(): Promise<void> {
    const screen = this.#learning();
    if (!screen?.task || screen.offline || screen.recordingPhase !== "idle" || screen.processing) return;
    if (screen.task.prompt.kind !== "exposure") return;
    const assetId = screen.task.prompt.exampleAudioAssetId;
    if (assetId === null) return;
    const epoch = this.#epoch;
    const taskId = screen.task.taskId;
    const playbackGeneration = this.#beginPlayback();
    try {
      await this.#playCountedAudio(this.#api.mediaUrl(assetId), assetId);
      const current = this.#learning();
      if (playbackGeneration !== this.#playbackGeneration || epoch !== this.#epoch || !current || current.offline || current.recordingPhase !== "idle" || current.task?.taskId !== taskId) return;
    } catch (error) {
      if (isNetworkError(error)) {
        this.#handleFailure(error);
      }
    }
  }

  /**
   * „Posłuchaj pytania” (design szkoły §11): nagranie polecenia i pytania,
   * które dziecko już widzi — bez zgody serwera, zdarzenia i ekspozycji.
   * Błąd odtwarzania ustawia `questionAudioError` (komunikat w pasku statusu
   * z przewijaniem ramy); awaria sieci idzie zwykłą ścieżką offline.
   */
  async playQuestionAudio(): Promise<void> {
    if (this.#autoCaptureActive) this.cancelRecording();
    const screen = this.#learning();
    if (!screen?.task || screen.offline || screen.busy || screen.recordingPhase !== "idle" || screen.processing) return;
    const assetId = questionAudioOf(screen.task);
    if (assetId === null) return;
    const epoch = this.#epoch;
    const taskId = screen.task.taskId;
    const playbackGeneration = this.#beginPlayback();
    this.#setLearning({ questionAudioError: false });
    try {
      await this.#playCountedAudio(this.#api.mediaUrl(assetId), assetId);
    } catch (error) {
      const current = this.#learning();
      if (playbackGeneration !== this.#playbackGeneration || epoch !== this.#epoch || current?.task?.taskId !== taskId) return;
      if (isNetworkError(error)) {
        this.#handleFailure(error);
        return;
      }
      this.#setLearning({ questionAudioError: true });
    }
  }

  async prepareMicrophone(options: { automatic?: boolean } = {}): Promise<void> {
    const screen = this.#learning();
    if (!screen?.task || screen.offline || screen.busy || screen.recordingPhase !== "idle" || screen.microphoneReady) return;
    this.#stopPlayback();
    const epoch = this.#epoch;
    const generation = this.#recordingGeneration;
    const preparation = ++this.#microphonePreparationGeneration;
    const taskId = screen.task.taskId;
    const isCurrent = () => preparation === this.#microphonePreparationGeneration &&
      epoch === this.#epoch && this.#learning()?.task?.taskId === taskId &&
      (!options.automatic || generation === this.#recordingGeneration);
    this.#setLearning({ recordingPhase: "preparing", recordingNotice: null, technicalRecordingIssue: false, inputLevel: null });
    try {
      await this.#media.prepareMicrophone();
      if (!isCurrent()) return;
      this.#micDenied = false;
      this.#storage.remove(MIC_DENIED_KEY);
      this.#setLearning({ microphoneReady: true, recordingPhase: "idle", micDenied: false, recordingNotice: null, technicalRecordingIssue: false });
    } catch (error) {
      if (!isCurrent()) return;
      const denied = (error as { name?: unknown } | null)?.name === "NotAllowedError" ||
        (error as { name?: unknown } | null)?.name === "PermissionDeniedError";
      const disableForPicture = !options.automatic && !screen.session.canRead && screen.session.vocabularyFormat === "picture";
      if (denied) {
        this.#micDenied = true;
        this.#storage.write(MIC_DENIED_KEY, "1");
      }
      if (denied || disableForPicture) await this.#disableSessionMicrophone(screen.session);
      const current = this.#learning();
      if (preparation !== this.#microphonePreparationGeneration || epoch !== this.#epoch || !current || current.session.sessionId !== screen.session.sessionId) return;
      const taskUnchanged = current.task?.taskId === screen.task.taskId;
      this.#setLearning({
        recordingPhase: "idle",
        microphoneReady: false,
        micDenied: denied,
        recordingNotice: taskUnchanged ? denied ? messages.kid.micDenied : messages.kid.recordingUnavailable : null,
        technicalRecordingIssue: taskUnchanged,
      });
    }
  }

  /**
   * Automatyczna próba mowy (quick 261021-lsw): na świeżo wyświetlonym zadaniu
   * speech/picture_speech nagrywanie startuje samo, bez naciskania przycisku.
   * Sygnałem „teraz mów" jest bip startu grany wewnątrz startu rejestratora
   * (onMicrophoneReady) — po udanym getUserMedia i PRZED przechwytywaniem, więc
   * szybka reakcja dziecka nie wyprzedza gotowości rejestratora (D-04), a bip
   * nie trafia do nagrania. Auto-stop prowadzi VAD na poziomach mikrofonu
   * (mowa + ~1,2 s ciszy); cisza bez mowy nie tworzy próby (SPEC §15) — limit
   * anuluje nagrywanie i zostawia przycisk jako fallback. Po „Nagraj jeszcze
   * raz" mikrofon nie startuje sam — auto-start wyłącznie na nowym zadaniu
   * (SPEC §16); zadania pisemne (WrittenView) i kartkówka pozostają ręczne (D-02).
   *
   * WR-02 (decyzja właściciela 2026-10-21): automat woła getUserMedia wyłącznie
   * przy już nadanym uprawnieniu mikrofonu (lub gdy mikrofon był już używany w
   * tej sesji — wtedy nowy prompt nie jest możliwy). Pierwsze nadanie zgody
   * dzieje się świadomym naciśnięciem przycisku nagrywania; po nadaniu zgody
   * kolejne zadanie mowy wystartuje samo (zapytanie o stan zwróci "granted").
   */
  async autoCaptureSpeech(): Promise<void> {
    const screen = this.#learning();
    if (!screen?.task) return;
    if (!this.#autoCaptureAllowed(screen)) return;
    if (this.#autoCaptureTaskId === screen.task.taskId) return;
    const epoch = this.#epoch;
    const generation = this.#recordingGeneration;
    const autoGeneration = this.#autoCaptureGeneration;
    const taskId = screen.task.taskId;
    if (!screen.microphoneReady) {
      // wyłącznie zapytanie o STAN uprawnienia (bez promptu, bez getUserMedia);
      // awaria API rozstrzyga się bezpiecznie jako brak zgody
      let permission: MicrophonePermission;
      try {
        permission = await this.#media.getMicrophonePermission();
      } catch {
        permission = "unknown";
      }
      const probed = this.#learning();
      if (generation !== this.#recordingGeneration || autoGeneration !== this.#autoCaptureGeneration || !probed || epoch !== this.#epoch || probed.task?.taskId !== taskId) return;
      // Odczyt uprawnienia mógł czekać na ręczne włączenie mikrofonu.
      // Takie przygotowanie pozostawia start pod kontrolą przycisku.
      if (probed.microphoneReady || !this.#autoCaptureAllowed(probed)) return;
      if (permission !== "granted") {
        // cichy skip auto dla tego zadania: bez sondy getUserMedia i bez
        // zapamiętania micDenied — odmowa/prompt należą wyłącznie do ścieżki
        // ręcznej (przycisk); nic nie blokuje kolejnych zadań po nadaniu zgody
        return;
      }
      // zgoda już nadana — sonda nie wywoła promptu; ewentualna odmowa na poziomie
      // urządzenia zostaje przy istniejącej ścieżce micDenied, bez pętli ponowień
      await this.prepareMicrophone({ automatic: true });
      const current = this.#learning();
      if (generation !== this.#recordingGeneration || autoGeneration !== this.#autoCaptureGeneration || !current || epoch !== this.#epoch || current.task?.taskId !== taskId) return;
      if (!current.microphoneReady || !this.#autoCaptureAllowed(current)) return;
    }
    this.#autoCaptureTaskId = taskId;
    this.#autoCaptureActive = true;
    this.#vad = createSpeechVad();
    const beepCancellation = new AbortController();
    this.#autoBeepCancellation = beepCancellation;
    this.#autoStartBeep = () => this.#media.playBeep("start", beepCancellation.signal).catch(() => undefined);
    await this.startRecording();
    // Własność stanu auto (PR #109 runda 3): ogon sprawdza fazę tylko wtedy,
    // gdy ta próba wciąż jest właścicielem — późny start POPRZEDNIEGO zadania
    // (wiszące getUserMedia rozwiązane po przejściu dalej) nie może skasować
    // VAD/bipu nowego zadania: bez VAD onLimitReached uznałby auto za wyłączone
    // i stopRecording wysłał ciszę jako próbę (SPEC §15). Latch
    // #autoCaptureTaskId przeżywa resety — jego cyklem życia zarządza
    // wyświetlanie zadań, nie #resetAutoCapture.
    if (this.#autoCaptureTaskId !== taskId) return;
    const current = this.#learning();
    if (!current || current.recordingPhase !== "recording") {
      // start nie doszedł do skutku (błąd urządzenia, anulowanie) — przywracamy
      // czysty stan; ponowna próba należy do przycisku, nie do automatyki
      this.#resetAutoCapture();
    }
  }

  #autoCaptureAllowed(screen: LearningScreen): boolean {
    if (screen.task?.prompt.kind !== "speech" && screen.task?.prompt.kind !== "picture_speech") return false;
    if (screen.session.mode === "mock_test" || !screen.session.microphoneEnabled || screen.micDenied) return false;
    if (this.#endConfirmSessionId === screen.session.sessionId) return false;
    if (screen.offline || screen.busy || screen.processing) return false;
    if (screen.feedback !== null || screen.reveal !== null) return false;
    if (screen.recordingPhase !== "idle" || this.#recorder !== null) return false;
    return true;
  }

  #resetAutoCapture(): void {
    this.#autoBeepCancellation?.abort();
    this.#autoBeepCancellation = null;
    this.#vad = null;
    this.#autoCaptureActive = false;
    this.#autoStartBeep = null;
  }

  async startRecording(): Promise<void> {
    const screen = this.#learning();
    if (!screen?.task || screen.offline || screen.busy || screen.processing || this.#recorder !== null || screen.recordingPhase !== "idle") return;
    if (!screen.microphoneReady) {
      await this.prepareMicrophone();
      return;
    }
    this.#stopPlayback();
    const epoch = this.#epoch;
    const taskId = screen.task.taskId;
    const generation = ++this.#recordingGeneration;
    const dictationLimitMs = this.#dictationLimitMs(screen);
    const options: RecorderOptions = {
      // dyktowanie lekcji ma własny limit nagrania (speechInput.maxSeconds)
      ...(dictationLimitMs !== null ? { maxDurationMs: dictationLimitMs } : {}),
      // auto-próba: bip startu gra wewnątrz BrowserRecorder.start — PO udanym
      // getUserMedia i PRZED MediaRecorder.start; ścieżka ręczna (pole null)
      // nie przekazuje hooka i nie gra bipu (D-04). Auto wymaga też sprawnego
      // monitora poziomów (PR #109, P1 #2): bez poziomów VAD słyszy ciszę i
      // limit anuluje dobrą wypowiedź — start odrzuca
      // LevelMonitorUnavailableError zanim zagra bip i zacznie przechwytywanie;
      // ręczna próba działa bez analizatora (monitor best-effort).
      ...(this.#autoStartBeep !== null ? { onMicrophoneReady: this.#autoStartBeep, requireLevelMonitor: true } : {}),
      onLevel: (level) => {
        if (generation !== this.#recordingGeneration || !Number.isFinite(level)) return;
        this.#setLearning({ inputLevel: Math.max(0, Math.min(1, level)) });
        // VAD zamyka auto-próbę po wykryciu mowy i ~1,2 s ciszy; guard
        // generacji w stopRecording chroni przed podwójnym zatrzymaniem
        const action = this.#vad?.sample(level);
        if (action === "auto_stop") void this.stopRecording();
      },
      onLimitReached: () => {
        if (generation !== this.#recordingGeneration) return;
        // cisza bez wykrytej mowy nie tworzy próby (SPEC §15) — limit w trybie
        // auto anuluje nagrywanie z komunikatem i zostawia przycisk; realna
        // wypowiedź (także ręczna) idzie normalną ścieżką stopRecording
        if (this.#autoCaptureActive && this.#vad?.speechDetected === false) {
          this.cancelRecording(messages.kid.autoCaptureNoSpeech, true);
        } else {
          void this.stopRecording();
        }
      },
      onError: () => {
        if (generation !== this.#recordingGeneration) return;
        this.#recordingGeneration += 1;
        this.#recorder = null;
        this.#stopCountdown();
        // pełny reset stanu auto (PR #109, P2 #3): zgubny #autoStartBeep i #vad
        // nie mogą przetrwać do ręcznej próby po awarii urządzenia (jak WR-01)
        this.#resetAutoCapture();
        this.#setLearning({ recordingPhase: "idle", microphoneReady: false, inputLevel: null, recordingNotice: messages.kid.recordingUnavailable, technicalRecordingIssue: true });
      },
    };
    const recorder = this.#media.createRecorder(options);
    this.#recorder = recorder;
    this.#setLearning({ recordingPhase: "starting", recordingNotice: null, technicalRecordingIssue: false, inputLevel: null });
    try {
      await recorder.start();
      const current = this.#learning();
      if (generation !== this.#recordingGeneration || epoch !== this.#epoch || !current || current.task?.taskId !== taskId) {
        return;
      }
      this.#recordingStartedAt = Date.now();
      this.#setLearning({ recordingPhase: "recording", micDenied: false });
      if (dictationLimitMs !== null) this.#startCountdown(dictationLimitMs, generation);
    } catch (error) {
      if (generation !== this.#recordingGeneration || epoch !== this.#epoch) return;
      this.#recorder = null;
      // Niedostępny monitor poziomów (PR #109, P1 #2 + runda 4): czysta przerwa
      // PRÓBY AUTOMATYCZNEJ, obsługana PRZED wspólnym torem odmowy — w sesjach
      // obrazkowych nieczytającego disableForPicture wyłączyłoby mikrofon
      // CAŁEJ sesji serwerowo i dziecko straciłoby przycisk mimo komunikatu
      // „Nagraj przyciskiem.” Bez próby, bez micDenied, bez wyłączenia sesji;
      // ręczne nagrywanie działa bez analizatora.
      if (error instanceof LevelMonitorUnavailableError) {
        const aborted = this.#learning();
        if (epoch !== this.#epoch || !aborted || aborted.session.sessionId !== screen.session.sessionId) return;
        const abortedTaskUnchanged = aborted.task?.taskId === taskId;
        if (generation !== this.#recordingGeneration && abortedTaskUnchanged) return;
        this.#setLearning({
          recordingPhase: "idle",
          microphoneReady: false,
          inputLevel: null,
          micDenied: false,
          recordingNotice: abortedTaskUnchanged ? messages.kid.autoCaptureListenUnavailable : null,
          technicalRecordingIssue: abortedTaskUnchanged,
        });
        return;
      }
      const denied = (error as { name?: unknown } | null)?.name === "NotAllowedError" ||
        (error as { name?: unknown } | null)?.name === "PermissionDeniedError";
      const disableForPicture = !screen.session.canRead && screen.session.vocabularyFormat === "picture";
      if (denied) {
        this.#micDenied = true;
        this.#storage.write(MIC_DENIED_KEY, "1");
      }
      if (denied || disableForPicture) await this.#disableSessionMicrophone(screen.session);
      const current = this.#learning();
      if (epoch !== this.#epoch || !current || current.session.sessionId !== screen.session.sessionId) return;
      const taskUnchanged = current.task?.taskId === taskId;
      if (generation !== this.#recordingGeneration && taskUnchanged) return;
      this.#setLearning({
        recordingPhase: "idle",
        microphoneReady: false,
        inputLevel: null,
        micDenied: denied,
        recordingNotice: taskUnchanged ? denied ? messages.kid.micDenied : messages.kid.recordingUnavailable : null,
        technicalRecordingIssue: taskUnchanged,
      });
    }
  }

  async stopRecording(): Promise<void> {
    const screen = this.#learning();
    const recorder = this.#recorder;
    if (!screen?.task || !recorder) return;
    if (screen.recordingPhase === "starting") {
      this.cancelRecording(messages.kid.recordingStartCancelled);
      return;
    }
    if (screen.recordingPhase !== "recording") return;
    // Każdy sposób zakończenia automatycznej próby musi respektować VAD,
    // także przycisk i klawiatura: sama cisza nigdy nie jest próbą dziecka.
    if (this.#autoCaptureActive && !this.#vad?.speechDetected) {
      this.cancelRecording(messages.kid.autoCaptureNoSpeech, true);
      return;
    }
    const epoch = this.#epoch;
    const taskId = screen.task.taskId;
    const generation = ++this.#recordingGeneration;
    const dictation = this.#dictationLimitMs(screen) !== null;
    this.#stopCountdown();
    // auto-próba konsumowana na początku zatrzymania — dotyczy także ręcznego
    // domknięcia auto-nagrania (toggle), nie dotyczy czysto ręcznych nagrań.
    // Pełny reset stanu auto (vad, bip startu): ręczna próba po udanej auto
    // („Nagraj jeszcze raz") nie może grać bipu startu ani wołać hooka (D-04).
    // Bezpieczne — #recordingGeneration już awansował, więc spóźnione poziomy
    // starego rejestratora nie widzą wyzerowanego VAD.
    const autoCapture = this.#autoCaptureActive;
    this.#resetAutoCapture();
    this.#setLearning({ recordingPhase: "stopping", inputLevel: null });
    if (Date.now() - this.#recordingStartedAt < 300) {
      this.#recorder = null;
      recorder.cancel();
      this.#setLearning({ recordingPhase: "idle", recordingNotice: dictation ? messages.kid.dictationNotHeard : messages.kid.recordingTooShort, technicalRecordingIssue: false });
      return;
    }
    try {
      const audio = await recorder.stop();
      const current = this.#learning();
      if (generation !== this.#recordingGeneration || epoch !== this.#epoch || !current || current.task?.taskId !== taskId) {
        audio.bytes.fill(0);
        return;
      }
      if (dictation) {
        this.#recorder = null;
        await this.#dictate(taskId, audio, epoch);
        return;
      }
      // bip końca PO zebraniu bajtów nagrania i przed wysyłką — sygnał „koniec"
      // dla dziecka, nigdy w nagraniu i nigdy blokada submitSpeech
      if (autoCapture) void this.#media.playBeep("end").catch(() => undefined);
      this.#recorder = null;
      this.#setLearning({ recordingPhase: "idle", recordingNotice: null, technicalRecordingIssue: false, processing: true, busy: true });
      const clientAttemptId = randomUUID();
      this.#activity?.recordInteraction();
      this.#activity?.pause("technical_wait");
      const send = async (): Promise<void> => {
        this.#pendingChoice = null;
        const attempt = await this.#api.submitSpeech(taskId, clientAttemptId, audio);
        await this.#applyAttempt(attempt, epoch, taskId);
      };
      this.#setResume(send);
      await send();
    } catch (error) {
      if (generation !== this.#recordingGeneration || epoch !== this.#epoch || this.#screen.kind !== "learning") return;
      this.#recorder = null;
      if (dictation) {
        // nieudane zebranie nagrania (np. konwersja) to brak tekstu, nie błąd sesji
        this.#setLearning({ recordingPhase: "idle", inputLevel: null, recordingNotice: messages.kid.dictationUnavailable, technicalRecordingIssue: true });
        return;
      }
      this.#setLearning({ recordingPhase: "idle", inputLevel: null });
      this.#handleFailure(error);
    }
  }

  /**
   * Dyktowanie (design szkoły §5.3): nagranie idzie do serwera wyłącznie po
   * tekst do pola — bez próby, oceny i ponowienia. Bajty są zerowane po
   * wysłaniu; awaria sieci lub serwera kończy się komunikatem, nigdy lokalnym
   * sukcesem ani zapamiętanym nagraniem.
   */
  async #dictate(taskId: string, audio: { bytes: Uint8Array; mimeType: string }, epoch: number): Promise<void> {
    this.#setLearning({ recordingPhase: "stopping", recordingNotice: messages.kid.dictationRecognizing, technicalRecordingIssue: false, inputLevel: null });
    this.#activity?.recordInteraction();
    let result: DictationDto;
    try {
      result = this.#api.dictate ? await this.#api.dictate(taskId, audio) : { status: "unavailable" };
    } catch {
      result = { status: "unavailable" };
    } finally {
      audio.bytes.fill(0);
    }
    const current = this.#learning();
    if (epoch !== this.#epoch || !current || current.task?.taskId !== taskId) return;
    const previousFailures = current.dictation?.taskId === taskId ? current.dictation.failures : 0;
    const failures = result.status === "heard" ? 0 : previousFailures + 1;
    const base = result.status === "heard" ? messages.kid.dictationHeard
      : result.status === "too_long" ? messages.kid.dictationTooLong
        : result.status === "unavailable" ? messages.kid.dictationUnavailable : messages.kid.dictationNotHeard;
    // po dwóch nieudanych dyktowaniach z rzędu wskazujemy pisanie (pole zostaje aktywne)
    const notice = failures >= 2 && result.status !== "unavailable" ? `${base} ${messages.kid.dictationTypeInstead}` : base;
    this.#setLearning({
      recordingPhase: "idle",
      recordingNotice: notice,
      technicalRecordingIssue: result.status === "unavailable",
      dictation: { taskId, seq: ++this.#dictationSeq, status: result.status, ...(result.status === "heard" ? { text: result.text } : {}), failures },
    });
  }

  /** Limit nagrania dyktowania bieżącego zadania (ms) albo null, gdy to nie dyktowanie. */
  #dictationLimitMs(screen: LearningScreen): number | null {
    const prompt = screen.task?.prompt;
    if (!prompt || (prompt.kind !== "lesson_open_answer" && prompt.kind !== "lesson_shorten")) return null;
    // Brak `dictate` w hoście nie przełącza na próbę mowy: `#dictate` zwróci wtedy „unavailable”.
    if (!prompt.speechInput || screen.session.mode === "mock_test") return null;
    return prompt.speechInput.maxSeconds * 1000;
  }

  #startCountdown(limitMs: number, generation: number): void {
    this.#stopCountdown();
    const startedAt = this.#recordingStartedAt;
    this.#countdownHandle = globalThis.setInterval(() => {
      if (generation !== this.#recordingGeneration || this.#learning()?.recordingPhase !== "recording") {
        this.#stopCountdown();
        return;
      }
      const left = Math.ceil((limitMs - (Date.now() - startedAt)) / 1000);
      if (left > 0 && left <= 10) this.#setLearning({ recordingNotice: format(messages.kid.dictationCountdown, { seconds: left }) });
    }, 1000);
  }

  #stopCountdown(): void {
    if (this.#countdownHandle !== null) globalThis.clearInterval(this.#countdownHandle);
    this.#countdownHandle = null;
  }

  cancelRecording(notice: string | null = null, technicalIssue = false): void {
    this.#stopCountdown();
    this.#recordingGeneration += 1;
    const recorder = this.#recorder;
    this.#recorder = null;
    this.#resetAutoCapture();
    recorder?.cancel();
    this.#setLearning({ recordingPhase: "idle", inputLevel: null, recordingNotice: notice, technicalRecordingIssue: technicalIssue });
  }

  async #disableSessionMicrophone(session: SessionDto, continueAfterDisable = false): Promise<void> {
    if (session.canRead || session.vocabularyFormat !== "picture") return;
    try {
      const updated = await this.#api.disableMicrophone(session.sessionId);
      const current = this.#learning();
      if (current?.session.sessionId !== session.sessionId) return;
      const closedVoiceTask = current.task?.prompt.kind === "picture_recall" || current.task?.prompt.kind === "picture_speech";
      this.#setLearning({ session: updated, error: null });
      if (closedVoiceTask || continueAfterDisable) await this.#loadNext(this.#epoch, session.sessionId);
    } catch {
      const current = this.#learning();
      if (current?.session.sessionId !== session.sessionId) return;
      this.#setResume(() => this.#disableSessionMicrophone(session, continueAfterDisable));
      this.#setLearning({ error: messages.errors.picture_microphone_disable_failed, busy: false });
    }
  }

  /** Powrót z tła: idempotentne odświeżenie bieżącego kroku (plan zadania 9). */
  async refreshStep(): Promise<void> {
    const screen = this.#learning();
    if (!screen || screen.busy || screen.feedback !== null || screen.processing || screen.offline) return;
    this.#setLearning({ busy: true });
    await this.#loadNext(this.#epoch, screen.session.sessionId);
  }

  markOffline(): void {
    if (this.#learning() === null) return;
    this.#stopPlayback();
    this.#activity?.pause("offline");
    this.#setLearning({ offline: true });
  }

  /** Ponowienie po powrocie sieci albo po błędzie aplikacji. */
  async retry(): Promise<void> {
    const screen = this.#learning();
    if (screen === null) return;
    this.#setLearning({ offline: false, error: null,
      ...(this.#resume && !this.#resume.keepsTaskVisible ? { busy: true, transitioning: true } : {}) });
    if (this.#resume) {
      const resume = this.#resume;
      try {
        await resume.run();
      } catch (error) {
        const current = this.#learning();
        if (current?.session.mode === "mock_test" && error instanceof KidApiError && error.code === "conflict") {
          await this.#loadNext(this.#epoch, current.session.sessionId);
          return;
        }
        this.#handleFailure(error);
      }
      return;
    }
    await this.refreshStep();
  }

  async learnAgain(): Promise<void> {
    if ((this.#screen.kind !== "summary" && this.#screen.kind !== "mockTestSummary" && this.#screen.kind !== "lessonMockTestSummary") || this.#childId === null) return;
    const deckId = this.#screen.kind === "mockTestSummary" ? this.#screen.summary.deckId
      : this.#screen.kind === "lessonMockTestSummary" ? this.#screen.summary.deckId
      : null;
    await this.selectProfile(this.#childId);
    if (deckId) await this.startLearning(deckId);
  }

  async switchProfile(): Promise<void> {
    this.#epoch += 1;
    this.#teardownRecording();
    this.#stopPlayback();
    this.#screen = { kind: "profile", profiles: this.#profiles };
    this.#emit();
    await this.refreshProfiles();
  }

  /** Refresh reward balances and parent-managed profile settings without discarding a usable screen. */
  async refreshProfiles(): Promise<boolean> {
    const epoch = this.#epoch;
    const requestSequence = ++this.#profileRequestSequence;
    const refresh = (async (): Promise<boolean> => {
    try {
      const profiles = await this.#api.listProfiles();
      if (epoch !== this.#epoch || requestSequence !== this.#profileRequestSequence) return false;
      const previousByChild = new Map(this.#profiles.map(profile => [profile.childId, profile]));
      this.#profiles = profiles.map(profile => {
        if (!profile.todayActivityUnavailable) return profile;
        const previous = previousByChild.get(profile.childId);
        return previous?.todayActivitySeconds !== undefined && !previous.todayActivityUnavailable
          ? { ...profile, todayActivitySeconds: previous.todayActivitySeconds, todayActivityUnavailable: false }
          : profile;
      });
      if (this.#screen.kind === "profile" || this.#screen.kind === "deck" || this.#screen.kind === "summary") {
        this.#screen = { ...this.#screen, profiles: this.#profiles };
        this.#emit();
      }
      return true;
    } catch { /* Keep the last confirmed balances during a temporary network failure. */ return false; }
    })();
    this.#profileRefreshPromise = refresh;
    const succeeded = await refresh;
    if (epoch === this.#epoch && requestSequence !== this.#profileRequestSequence) {
      return await this.#profileRefreshPromise ?? succeeded;
    }
    return succeeded;
  }

  /** Czy banner „Jeszcze N i koniec!” jest widoczny dla bieżącego zadania. */
  remainingFor(task: TaskDto | null): number | null {
    if (this.#screen.kind === "learning" && this.#screen.session.mode === "mock_test") return task?.remainingAssessed ?? null;
    return task !== null && task.remainingAssessed <= REMAINING_BANNER_FROM ? task.remainingAssessed : null;
  }

  async reviewMockTest(sessionId: string): Promise<void> {
    if (this.#childId === null) return;
    const epoch = this.#epoch;
    const childId = this.#childId;
    const summary = await this.#api.readMockTestSummary(sessionId);
    if (epoch !== this.#epoch) return;
    this.#screen = { kind: "mockTestSummary", childId, summary }; this.#emit();
  }

  async playMockTestSolution(taskId: string): Promise<void> {
    if (this.#screen.kind !== "mockTestSummary") return;
    const epoch = this.#epoch;
    const summary = await this.#api.readMockTestSummary(this.#screen.summary.sessionId);
    if (epoch !== this.#epoch) return;
    const solution = summary.solutions.find(s => s.taskId === taskId);
    if (solution?.audioAssetId) await this.#media.player.play(this.#api.mediaUrl(solution.audioAssetId));
  }

  /** URL niezmiennej treści medialnej (audio, ilustracja) przez klienta API. */
  mediaUrl(assetId: string): string {
    return this.#api.mediaUrl(assetId);
  }

  #handleFailure(error: unknown): void {
    if (this.#screen.kind !== "learning") return;
    if (isNetworkError(error)) {
      this.#stopPlayback();
      this.#screen = { ...this.#screen, offline: true, busy: false, transitioning: false };
    } else {
      this.#screen = { ...this.#screen, error: messageForError(error), busy: false, transitioning: false };
    }
    this.#emit();
  }

  /** Opuszczenie widoku: zatrzymuje strumień mikrofonu i odtwarzanie (RF5). */
  teardown(): void {
    this.pauseActivity("background");
    this.#disposed = true;
    for (const timer of this.#activityResultTimers.values()) clearTimeout(timer);
    this.#activityResultTimers.clear();
    this.#activityResultRetryAttempts.clear();
    this.#epoch += 1;
    this.#teardownRecording();
    this.#stopPlayback();
    this.stopGuidance();
  }

  /**
   * Pauza lokalnego pomiaru (tło/blur/offline). Bez sieciowych heartbeatów —
   * raport idzie wyłącznie na koniec sesji (spec client-reward-time).
   */
  pauseActivity(reason: "background" | "blur" | "offline" = "background"): void {
    this.#stopPlayback();
    // Offline wznawia bodziec po „Spróbuj ponownie” (#listenResume).
    if (reason !== "offline") this.#interruptListenStimulus();
    this.#activity?.pause(reason);
    this.#saveActivityDraft();
  }

  /** Powrót do widoku: sam fakt widoczności NIE wznawia pomiaru — dopiero działanie. */
  resumeActivity(): void {
    // Celowo bez wznowienia: wznowienie wymaga interakcji albo odsłuchu.
  }

  /**
   * Interakcja z właściwego pola/działania ćwiczenia. Ruch myszy i kliknięcia
   * w puste miejsce nie podtrzymują pracy — wywołują to wyłącznie widoki ćwiczeń.
   */
  recordInteraction(): void {
    this.#activity?.recordInteraction();
  }

  /** Edycja pola/układanie odpowiedzi: liczba zmian bez treści wpisów. */
  recordEdit(): void {
    this.#activity?.recordEdit();
  }

  #teardownRecording(): void {
    this.#stopCountdown();
    this.#recordingGeneration += 1;
    const recorder = this.#recorder;
    this.#recorder = null;
    this.#resetAutoCapture();
    recorder?.cancel();
    if (this.#screen.kind === "learning") {
      this.#screen = { ...this.#screen, recording: false, automaticRecording: false, recordingPhase: "idle", inputLevel: null };
    }
  }
}
