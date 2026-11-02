import { describe, expect, it, vi } from "vitest";
import { messages } from "@learning/contracts";
import { createKidApiClient, KidApiError } from "../api/client";
import type {
  AttemptDto,
  DisclosureDto,
  FeedbackDto,
  KidDeckDto,
  KidProfileDto,
  LessonMockTestSummaryDto,
  PresentationCompletionDto,
  SessionDto,
  SessionSummaryDto,
  TaskDto,
} from "@learning/contracts";
import type { KidApi } from "../api/KidApi";
import type { AudioPlaybackOptions, AudioPlayer, MicrophonePermission, PlatformMedia, RecorderOptions, SpeechRecorder } from "../media/platform";
import { LevelMonitorUnavailableError } from "../media/platform";
import { createMemoryPreferences, MIC_DENIED_KEY, type LocalPreferences } from "../storage";
import { createMemoryActivityDraftStore } from "./activity-draft-store";
import { LearningSessionController, messageForError, type LearningScreen } from "./session-controller";
import { format } from "../format";

/**
 * Testy jednostkowe sterownika przepływu (RF5 i kontrakt e2e zadania 9):
 * logika bez Reacta, na pełnych fake-ach API i mediów.
 */

const PROFILE_A: KidProfileDto = { childId: "11111111-1111-1111-1111-111111111111", displayName: "Ola", avatarKey: "fox", recordingMode: "hold" };
const PROFILE_B: KidProfileDto = { childId: "22222222-2222-2222-2222-222222222222", displayName: "Ewa", avatarKey: "bear", recordingMode: "toggle" };

function sessionDto(childId: string, sessionId: string, microphoneEnabled: boolean): SessionDto {
  return {
    mode: "training",
    sessionId,
    childId,
    deckId: "33333333-3333-3333-3333-333333333333",
    deckVersionId: "44444444-4444-4444-4444-444444444444",
    policyId: "learning-v1",
    microphoneEnabled,
    canRead: true,
    vocabularyFormat: "standard",
    state: "active",
    taskBudget: 12,
    tasksIssued: 0,
    assessedTasksIssued: 0,
    startedAt: "2026-10-07T16:00:00.000Z",
    resumed: false,
  };
}

function taskDto(taskId: string, prompt: TaskDto["prompt"], remaining = 5): TaskDto {
  return {
    taskId,
    sessionId: "55555555-5555-5555-5555-555555555555",
    ordinal: 0,
    exerciseType: prompt.kind as TaskDto["exerciseType"],
    direction: null,
    state: "issued",
    prompt,
    remainingAssessed: remaining,
  };
}

function attemptDto(overrides: Partial<AttemptDto> = {}): AttemptDto {
  return {
    attemptId: "66666666-6666-6666-6666-666666666666",
    taskId: "77777777-7777-7777-7777-777777777777",
    state: "completed",
    modality: "text",
    feedback: { kind: "great" },
    taskState: "completed",
    stepId: "step",
    receivedAt: "2026-10-07T16:00:01.000Z",
    completedAt: "2026-10-07T16:00:01.000Z",
    ...overrides,
  };
}

function makeRecorder(opts: { failStartWith?: unknown; startGate?: Promise<void>; sharedLog?: string[] } = {}): SpeechRecorder & {
  cancelled: number;
  stopped: number;
  started: number;
  fail(): void;
  setFailureHandler(callback?: () => void): void;
  hitLimit(): void;
  setLimitHandler(callback?: () => void): void;
  setLevelHandler(callback?: (level: number) => void): void;
  setMicrophoneReadyHandler(callback?: () => Promise<void> | void): void;
  pushLevel(level: number): void;
} {
  const state = { cancelled: 0, stopped: 0, started: 0 };
  let onError: (() => void) | undefined;
  let onLimit: (() => void) | undefined;
  let onLevel: ((level: number) => void) | undefined;
  let onMicrophoneReady: (() => Promise<void> | void) | undefined;
  return {
    fail() { onError?.(); },
    setFailureHandler(callback) { onError = callback; },
    hitLimit() { onLimit?.(); },
    setLimitHandler(callback) { onLimit = callback; },
    setLevelHandler(callback) { onLevel = callback; },
    setMicrophoneReadyHandler(callback) { onMicrophoneReady = callback; },
    pushLevel(level: number) { onLevel?.(level); },
    get cancelled() {
      return state.cancelled;
    },
    get stopped() {
      return state.stopped;
    },
    get started() {
      return state.started;
    },
    get active() {
      return false;
    },
    async start() {
      // awaria startu przerywa PRZED hookiem „teraz mów” i PRZED rozpoczęciem
      // przechwytywania (PR #109, P1 #2) — licznik started rośnie tylko przy
      // udanym starcie; awaria jest jednorazowa, kolejna próba działa
      if (opts.failStartWith !== undefined) {
        const failure = opts.failStartWith;
        opts.failStartWith = undefined;
        throw failure;
      }
      state.started += 1;
      await opts.startGate;
      // symetrycznie do BrowserRecorder: sygnał „teraz mów” awaitujemy PRZED
      // rozpoczęciem przechwytywania (quick 261021-lsw)
      await onMicrophoneReady?.();
      opts.sharedLog?.push("capture");
    },
    async stop() {
      state.stopped += 1;
      return { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/webm" };
    },
    cancel() {
      state.cancelled += 1;
    },
  };
}

function makeMedia(recorder: ReturnType<typeof makeRecorder>, playGate?: Promise<void>, onStopPlayback?: () => void, failPlaybackBeforeStart = false, playbackDurationMs: number | null = null, sharedLog?: string[], microphonePermission: MicrophonePermission = "granted"): PlatformMedia & { playUrls: string[]; playOptions: (AudioPlaybackOptions | undefined)[]; rejectNextPlays: number; deferStart: boolean; pendingStarts: ((durationMs: number | null) => void)[]; stops: number; failPlayback: boolean; beeps: string[]; preloadedImages: string[]; lastRecorderOptions?: RecorderOptions; permissionQueries: number; setMicrophonePermission(next: MicrophonePermission): void } {
  // Każde wywołanie play() czeka na bramkę albo na stop() — jak `#settle` adaptera.
  const interruptions = new Set<() => void>();
  const media = {
    playUrls: [] as string[],
    playOptions: [] as (AudioPlaybackOptions | undefined)[],
    /** Tyle kolejnych wywołań play() rzuci błąd przed `onStarted`. */
    rejectNextPlays: 0,
    /** Start (`onStarted`) odkładany do `pendingStarts` — test woła go sam, także spóźniony. */
    deferStart: false,
    pendingStarts: [] as ((durationMs: number | null) => void)[],
    stops: 0,
    failPlayback: failPlaybackBeforeStart,
    beeps: [] as string[],
    preloadedImages: [] as string[],
    async preloadImage(url: string) {
      media.preloadedImages.push(url);
    },
    lastRecorderOptions: undefined as RecorderOptions | undefined,
    permissionQueries: 0,
    setMicrophonePermission(next: MicrophonePermission) {
      microphonePermission = next;
    },
    async prepareMicrophone() {
      sharedLog?.push("prepareMicrophone");
    },
    async getMicrophonePermission() {
      media.permissionQueries += 1;
      sharedLog?.push(`permission:${microphonePermission}`);
      return microphonePermission;
    },
    async playBeep(kind: "start" | "end") {
      media.beeps.push(kind);
      sharedLog?.push(`beep:${kind}`);
    },
    createRecorder: (options?: RecorderOptions) => {
      recorder.setFailureHandler(options?.onError);
      recorder.setLimitHandler(options?.onLimitReached);
      recorder.setLevelHandler(options?.onLevel);
      recorder.setMicrophoneReadyHandler(options?.onMicrophoneReady);
      media.lastRecorderOptions = options;
      return recorder;
    },
    player: {
      async play(url: string, onStarted?: (durationMs: number | null) => void, options?: AudioPlaybackOptions) {
        media.playUrls.push(url);
        media.playOptions.push(options);
        if (media.failPlayback) throw new Error("autoplay blocked");
        if (media.rejectNextPlays > 0) {
          media.rejectNextPlays -= 1;
          throw new Error("autoplay blocked");
        }
        let interrupt!: () => void;
        const interrupted = new Promise<void>((resolve) => { interrupt = resolve; });
        interruptions.add(interrupt);
        if (media.deferStart) {
          if (onStarted) media.pendingStarts.push(onStarted);
        } else {
          onStarted?.(playbackDurationMs);
        }
        try {
          await Promise.race([playGate, interrupted]);
        } finally {
          interruptions.delete(interrupt);
        }
      },
      stop() {
        media.stops += 1;
        for (const interrupt of interruptions) interrupt();
        interruptions.clear();
        if (media.playUrls.length > 0) onStopPlayback?.();
      },
    } satisfies AudioPlayer,
  };
  return media;
}

interface ApiState {
  submitError?: unknown;
  profiles: KidProfileDto[];
  listProfilesFailureCount?: number;
  listProfilesGate?: Promise<void>;
  decks: KidDeckDto[];
  tasks: TaskDto[];
  attempts: AttemptDto[];
  disclosures: { taskId: string; kind: string }[];
  presentations: string[];
  endedSessions: string[];
  disabledSessions: string[];
  startedSessions: { childId: string; microphoneEnabled: boolean; supportsPictureVocabulary: boolean }[];
  listDeckRequests?: { childId: string; microphoneEnabled?: boolean }[];
  listDeckResponses?: KidDeckDto[][];
  listDecksError?: unknown;
  startSessionResponse?: Partial<SessionDto>;
  submissions: { taskId: string; clientAttemptId: string; modality: string }[];
  speechSubmissions: { taskId: string; clientAttemptId: string }[];
  observations: string[];
  /** Gdy ustawione, submitAnswer rzuca TypeError (brak sieci). */
  networkDown: boolean;
  disclosureGate?: Promise<void>;
  readAttemptGate?: Promise<void>;
  endSessionGate?: Promise<void>;
  mockSummaryGate?: Promise<void>;
  lessonMockSummaryGate?: Promise<void>;
  mockSummaryError?: unknown;
  lessonMockSummaryError?: unknown;
  disclosureError?: unknown;
  feedbackAudioGate?: Promise<void>;
  feedbackAudioError?: unknown;
  feedbackAudioAssetId?: string;
  feedbackAudioCalls: string[];
  /** Zamrożone raporty aktywności dostarczone przy końcu sesji. */
  endReports: import("@learning/contracts").SessionActivityReport[];
  endSessionError?: unknown;
  endActivityResult?: import("@learning/contracts").SessionActivityResultDto;
  activityResults: Array<import("@learning/contracts").SessionActivityResultDto | Error>;
  activityResultCalls: string[];
  uiAudioReady?: boolean;
  uiAudioReadFailureCount?: number;
  uiAudioReadCalls?: number;
  lessonMockSummary?: LessonMockTestSummaryDto;
  disableError?: unknown;
  disableGate?: Promise<void>;
  startSessionIds?: string[];
  nextTaskCalls?: number;
  nextTaskGate?: Promise<void>;
}

function makeApi(state: ApiState): KidApi {
  return {
    async readUiAudio() {
      state.uiAudioReadCalls = (state.uiAudioReadCalls ?? 0) + 1;
      if ((state.uiAudioReadFailureCount ?? 0) > 0) {
        state.uiAudioReadFailureCount = state.uiAudioReadFailureCount! - 1;
        throw new TypeError("fetch failed");
      }
      return state.uiAudioReady ? { ready: true, assets: { recall: "asset-guidance" } } : { ready: false, assets: {} };
    },
    async listProfiles() {
      await state.listProfilesGate;
      if ((state.listProfilesFailureCount ?? 0) > 0) {
        state.listProfilesFailureCount = state.listProfilesFailureCount! - 1;
        throw new TypeError("fetch failed");
      }
      if (state.networkDown) throw new TypeError("fetch failed");
      return state.profiles;
    },
    async listDecks(childId, options) {
      state.listDeckRequests?.push({ childId, microphoneEnabled: options?.microphoneEnabled });
      if (state.listDecksError !== undefined) throw state.listDecksError;
      return state.listDeckResponses?.shift() ?? state.decks;
    },
    async startSession(input) {
      state.startedSessions.push({ childId: input.childId, microphoneEnabled: input.microphoneEnabled, supportsPictureVocabulary: input.supportsPictureVocabulary === true });
      const profile = state.profiles.find((item) => item.childId === input.childId);
      const deck = state.decks.find((item) => item.deckId === input.deckId);
      const sessionId = state.startSessionIds?.shift() ?? "55555555-5555-5555-5555-555555555555";
      return { ...sessionDto(input.childId, sessionId, input.microphoneEnabled), canRead: profile?.canRead ?? true, vocabularyFormat: deck?.vocabularyFormat ?? "standard", mode: input.mode ?? "training", ...state.startSessionResponse };
    },
    async nextTask() {
      state.nextTaskCalls = (state.nextTaskCalls ?? 0) + 1;
      await state.nextTaskGate;
      return state.tasks.shift() ?? null;
    },
    async submitAnswer(input) {
      if (state.submitError) throw state.submitError;
      if (state.networkDown) throw new TypeError("fetch failed");
      state.submissions.push({ taskId: input.taskId, clientAttemptId: input.clientAttemptId, modality: input.modality });
      return state.attempts.length > 0 ? (state.attempts.shift()!) : attemptDto({ taskId: input.taskId, modality: input.modality });
    },
    async submitSpeech(taskId, clientAttemptId) {
      state.speechSubmissions.push({ taskId, clientAttemptId });
      return state.attempts.length > 0 ? (state.attempts.shift()!) : attemptDto({ taskId, modality: "audio" });
    },
    async readAttempt(attemptId) {
      await state.readAttemptGate;
      return state.attempts.length > 0 ? (state.attempts.shift()!) : attemptDto({ attemptId });
    },
    async authorizeDisclosure(taskId, kind): Promise<DisclosureDto> {
      state.disclosures.push({ taskId, kind });
      if (state.disclosureError !== undefined) throw state.disclosureError;
      await state.disclosureGate;
      return { taskId, stepId: "d1", kind, reveal: kind === "hint" ? { target: "Thursday" } : null, audioAssetId: "88888888-8888-4888-8888-888888888888" };
    },
    async authorizeFeedbackAudio(attemptId) {
      state.feedbackAudioCalls.push(attemptId);
      await state.feedbackAudioGate;
      if (state.feedbackAudioError !== undefined) throw state.feedbackAudioError;
      return { attemptId, taskId: "77777777-7777-7777-7777-777777777777", stepId: "f-audio", audioAssetId: state.feedbackAudioAssetId ?? "reference-audio" };
    },
    async completePresentation(taskId): Promise<PresentationCompletionDto> {
      state.presentations.push(taskId);
      return { taskId, state: "completed", completedAt: "2026-10-07T16:00:02.000Z" };
    },
    async recordObservation(input) {
      state.observations.push(input.kind);
      return undefined;
    },
    async endSession(sessionId, activityReport): Promise<SessionSummaryDto> {
      await state.endSessionGate;
      if (state.endSessionError !== undefined) throw state.endSessionError;
      state.endedSessions.push(sessionId);
      if (activityReport !== undefined) state.endReports.push(activityReport);
      return { sessionId, state: "completed", tasksIssued: 3, assessedTasksIssued: 2, endedAt: "2026-10-07T16:05:00.000Z",
        independentSuccesses: { recall: 0, spelling: 0 }, practiceItems: [],
        ...(state.endActivityResult === undefined ? {} : { activity: state.endActivityResult }) };
    },
    async disableMicrophone(sessionId) {
      state.disabledSessions.push(sessionId);
      await state.disableGate;
      if (state.disableError !== undefined) throw state.disableError;
      return { ...sessionDto(PROFILE_A.childId, sessionId, false), canRead: false, vocabularyFormat: "picture" };
    },
    async readMockTestSummary(sessionId) {
      await state.mockSummaryGate;
      if (state.mockSummaryError !== undefined) throw state.mockSummaryError;
      if (state.networkDown) throw new TypeError("fetch failed");
      return { sessionId, deckId: DECK.deckId, state: "completed", complete: true, taskBudget: 2, answeredCount: 2, solutions: [] };
    },
    async readLessonMockTestSummary(sessionId) {
      await state.lessonMockSummaryGate;
      if (state.lessonMockSummaryError !== undefined) throw state.lessonMockSummaryError;
      if (state.networkDown) throw new TypeError("fetch failed");
      return state.lessonMockSummary ?? { sessionId, deckId: LESSON_DECK.deckId, state: "completed", complete: true, taskBudget: 2, answeredCount: 2, solutions: [] };
    },
    async readSessionActivityResult(sessionId) {
      state.activityResultCalls.push(sessionId);
      const result = state.activityResults.shift() ?? state.endActivityResult ?? { status: "already_started", pointsAwarded: 0, errorCode: null };
      if (result instanceof Error) throw result;
      return result;
    },
    mediaUrl(assetId) {
      return `https://media.test/${assetId}`;
    },
  };
}

const DECK: KidDeckDto = {
  mockTestAvailable: true,
  activeSession: null,
  deckId: "33333333-3333-3333-3333-333333333333",
  title: "Dni tygodnia",
  itemCount: 7,
  independentlyRecalledCount: 0,
  testDate: null,
  recommended: true,
};

const LESSON_DECK: KidDeckDto = {
  mockTestAvailable: true,
  activeSession: null,
  deckId: "66666666-6666-6666-6666-666666666666",
  title: "Czas Present Simple",
  itemCount: 0,
  independentlyRecalledCount: 0,
  testDate: null,
  recommended: true,
  kind: "lesson",
  subjectTitle: "Angielski",
};

function makeHarness(
  state: ApiState,
  options: { api?: KidApi; failStartWith?: unknown; startGate?: Promise<void>; initialChildId?: string; playGate?: Promise<void>; onStopPlayback?: () => void; failPlaybackBeforeStart?: boolean; playbackDurationMs?: number | null; storage?: LocalPreferences; activityClock?: import("./activity-report").ActivityClock; activityDrafts?: ReturnType<typeof createMemoryActivityDraftStore>; sharedLog?: string[]; microphonePermission?: MicrophonePermission } = {},
) {
  const recorder = makeRecorder(options);
  const media = makeMedia(recorder, options.playGate, options.onStopPlayback, options.failPlaybackBeforeStart, options.playbackDurationMs, options.sharedLog, options.microphonePermission ?? "granted");
  const storage = options.storage ?? createMemoryPreferences();
  const api = options.api ?? makeApi(state);
  const activityDrafts = options.activityDrafts ?? createMemoryActivityDraftStore();
  const controller = new LearningSessionController({
    api,
    media,
    storage,
    activityDrafts,
    ...(options.initialChildId === undefined ? {} : { initialChildId: options.initialChildId }),
    ...(options.activityClock === undefined ? {} : { activityClock: options.activityClock }),
    pollIntervalMs: 1,
  });
  return { controller, recorder, media, storage, state, api, activityDrafts };
}

async function startAtTask(state: ApiState, task: TaskDto, recorderOpts?: { failStartWith?: unknown; startGate?: Promise<void>; playGate?: Promise<void>; onStopPlayback?: () => void; failPlaybackBeforeStart?: boolean; playbackDurationMs?: number | null; storage?: LocalPreferences; microphone?: boolean; activityDrafts?: ReturnType<typeof createMemoryActivityDraftStore>; activityClock?: import("./activity-report").ActivityClock; sharedLog?: string[]; microphonePermission?: MicrophonePermission }) {
  state.tasks = [task];
  const harness = makeHarness(state, recorderOpts);
  await harness.controller.start();
  await harness.controller.selectProfile(state.profiles[0]!.childId);
  if (recorderOpts?.microphone !== false) harness.controller.setMicrophone(true);
  await harness.controller.startLearning(DECK.deckId);
  return harness;
}

describe("LearningSessionController", () => {
  it("nie pozwala, by start sprzed teardown nadpisał nowszy wybór profilu", async () => {
    let releaseFirst!: () => void;
    const state = baseState();
    state.listProfilesGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const harness = makeHarness(state);
    const firstStart = harness.controller.start();
    await Promise.resolve();

    harness.controller.teardown();
    state.listProfilesGate = undefined;
    await harness.controller.start();
    await harness.controller.selectProfile(PROFILE_B.childId);
    releaseFirst();
    await firstStart;

    expect(harness.controller.getScreen()).toMatchObject({ kind: "deck", childId: PROFILE_B.childId });
    harness.controller.teardown();
  });

  it("starts learning without waiting for a background profile refresh when microphone is off", async () => {
    const state = baseState();
    let release!: () => void;
    const harness = makeHarness(state);
    await harness.controller.start();
    state.listProfilesGate = new Promise<void>(resolve => { release = resolve; });
    await harness.controller.selectProfile(PROFILE_A.childId);
    const starting = harness.controller.startLearning(DECK.deckId);
    await Promise.resolve();
    await Promise.resolve();
    expect(state.startedSessions).toEqual([{ childId: PROFILE_A.childId, microphoneEnabled: false, supportsPictureVocabulary: true }]);
    release();
    await starting;
    harness.controller.teardown();
  });

  it("zachowuje zgodność ze starszym hostem KidApi bez endpointu wyniku asynchronicznego", async () => {
    const state = baseState();
    state.tasks = [taskDto("legacy-host", { kind: "recall", prompt: "czwartek" })];
    state.endActivityResult = { status: "already_started", pointsAwarded: 0, errorCode: null };
    const { readSessionActivityResult: _readResult, ...legacyApi } = makeApi(state);
    const harness = makeHarness(state, { api: legacyApi });

    await harness.controller.start();
    await harness.controller.selectProfile(PROFILE_A.childId);
    await harness.controller.startLearning(DECK.deckId);
    await harness.controller.endNow();

    expect(harness.controller.getScreen()).toMatchObject({ kind: "summary", summary: { activity: { status: "already_started" } } });
    expect(state.activityResultCalls).toEqual([]);
    harness.controller.teardown();
  });

  it("applies the newest same-epoch profile response and uses its recording mode", async () => {
    const state = baseState();
    const harness = makeHarness(state);
    await harness.controller.start();
    await harness.controller.selectProfile(PROFILE_A.childId);
    await new Promise(resolve => setTimeout(resolve, 0));
    let resolveOlder!: (profiles: KidProfileDto[]) => void;
    let resolveNewer!: (profiles: KidProfileDto[]) => void;
    const older = new Promise<KidProfileDto[]>(resolve => { resolveOlder = resolve; });
    const newerProfiles = [{ ...PROFILE_A, displayName: "Ola aktualna", recordingMode: "toggle" as const }, PROFILE_B];
    const newer = new Promise<KidProfileDto[]>(resolve => { resolveNewer = resolve; });
    vi.spyOn(harness.api, "listProfiles")
      .mockImplementationOnce(() => older)
      .mockImplementationOnce(() => newer)
      .mockResolvedValue(newerProfiles);
    const olderRefresh = harness.controller.refreshProfiles();
    const newerRefresh = harness.controller.refreshProfiles();
    resolveNewer(newerProfiles);
    await newerRefresh;
    resolveOlder([PROFILE_A, PROFILE_B]);
    await olderRefresh;
    expect(harness.controller.getScreen()).toMatchObject({ kind: "deck" });
    expect((harness.controller.getScreen() as Extract<ReturnType<typeof harness.controller.getScreen>, { kind: "deck" }>).profiles[0])
      .toMatchObject({ displayName: "Ola aktualna", recordingMode: "toggle" });
    state.tasks = [taskDto("fresh-mode", { kind: "recall", prompt: "Thursday" })];
    harness.controller.setMicrophone(true);
    await harness.controller.startLearning(DECK.deckId);
    expect(harness.controller.getScreen()).toMatchObject({ kind: "learning", recordingMode: "toggle" });
    harness.controller.teardown();
  });

  it("keeps the last confirmed daily activity when its refresh is unavailable", async () => {
    const confirmed = { ...PROFILE_A, todayActivitySeconds: 25 * 60 };
    const state = baseState();
    state.profiles = [confirmed, PROFILE_B];
    const harness = makeHarness(state);
    await harness.controller.start();
    await harness.controller.selectProfile(PROFILE_A.childId);
    await new Promise(resolve => setTimeout(resolve, 0));

    state.profiles = [{ ...PROFILE_A, todayActivityUnavailable: true }, PROFILE_B];
    await harness.controller.refreshProfiles();

    const screen = harness.controller.getScreen();
    expect(screen.kind).toBe("deck");
    if (screen.kind !== "deck") throw new Error("Expected deck screen");
    expect(screen.profiles[0]).toMatchObject({
      childId: PROFILE_A.childId,
      todayActivitySeconds: 25 * 60,
      todayActivityUnavailable: false,
    });
    harness.controller.teardown();
  });

  it.each(["answer", "presentation"])("locks %s while the server accepts the step", async (operation) => {
    const task = taskDto("telemetry-gate", operation === "answer" ? { kind: "recall", prompt: "czwartek" } : { kind: "exposure", source: "czwartek", target: "Thursday", audioAssetId: "audio", example: null, exampleAudioAssetId: null, imageAssetId: null, visualType: "none" });
    const harness = await startAtTask(baseState(), task);
    await new Promise((resolve) => setTimeout(resolve, 0));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    if (operation === "answer") {
      vi.spyOn(harness.api, "submitAnswer").mockImplementation(async (input) => { await gate; return makeApi(harness.state).submitAnswer(input); });
    } else {
      vi.spyOn(harness.api, "completePresentation").mockImplementation(async (taskId) => { await gate; return makeApi(harness.state).completePresentation(taskId); });
    }
    const act = () => operation === "answer" ? harness.controller.answerText("Thursday") : harness.controller.completePresentation();
    const first = act();
    const second = act();
    expect(harness.controller.getScreen()).toMatchObject({ busy: true, transitioning: true });
    release();
    await Promise.all([first, second]);
    expect(operation === "answer" ? harness.state.submissions : harness.state.presentations).toHaveLength(1);
    harness.controller.teardown();
  });

  it("shows neutral choice and transition state before grading responds", async () => {
    const chosen = "88888888-8888-8888-8888-888888888888";
    const task = taskDto("instant-neutral-choice", {
      kind: "listening", options: [{ id: chosen, text: "czwartek" }],
      audioAssetId: "99999999-9999-4999-8999-999999999999",
    });
    const harness = await startAtTask(baseState(), task);
    await new Promise((resolve) => setTimeout(resolve, 0));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(harness.api, "submitAnswer").mockImplementation(async (input) => { await gate; return makeApi(harness.state).submitAnswer(input); });

    const answer = harness.controller.answerChoice(chosen);
    expect(harness.controller.getScreen()).toMatchObject({
      kind: "learning", busy: true, transitioning: true, pendingChoiceId: chosen,
    });
    expect(harness.state.submissions).toHaveLength(0);

    release();
    await answer;
    expect(harness.controller.getScreen()).toMatchObject({ transitioning: false, pendingChoiceId: null });
    harness.controller.teardown();
  });

  it("refreshes profile rewards after a session and when returning to profiles", async () => {
    const harness = await startAtTask(baseState(), taskDto("profile-refresh", { kind: "recall", prompt: "czwartek" }));
    const updated = { ...PROFILE_A, displayName: "Ola po sesji" };
    harness.state.profiles = [updated];
    await harness.controller.endNow();
    expect(harness.controller.getScreen()).toMatchObject({ kind: "summary", profiles: [updated] });
    harness.state.profiles = [{ ...updated, displayName: "Ola po powrocie" }];
    await harness.controller.switchProfile();
    expect(harness.controller.getScreen()).toMatchObject({ kind: "profile", profiles: [{ displayName: "Ola po powrocie" }] });
    harness.controller.teardown();
  });

  it("wybiera polskie komunikaty dla znanych przyczyn walidacji obrazkowej", () => {
    expect(messageForError(new KidApiError("validation", false, "picture_client_update_required"))).toContain("Zaktualizuj aplikację");
    expect(messageForError(new KidApiError("validation", false, "vocabulary_requires_reading"))).toContain("wymaga umiejętności czytania");
    expect(messageForError(new KidApiError("validation", false, "non_reader_mock_test_unavailable"))).toContain("Kartkówka nie jest dostępna");
    expect(messageForError(new KidApiError("validation", false, "picture_guidance_unavailable"))).toContain("Instrukcje głosowe");
    expect(messageForError(new KidApiError("validation", false, "picture_audio_unavailable"))).toContain("Nagranie jest chwilowo niedostępne");
    expect(messageForError(new KidApiError("validation", false))).toBe(messages.errors.validation);
  });
  it("autoryzuje wzorzec z bieżącego wyniku przed odtworzeniem", async () => {
    const state = baseState();
    const task = taskDto("77777777-7777-7777-7777-777777777777", { kind: "recall", prompt: "czwartek" });
    state.attempts = [attemptDto({ taskId: task.taskId, attemptId: "66666666-6666-6666-6666-666666666666", modality: "audio", feedback: { kind: "almost", referenceAudioAvailable: true } })];
    const harness = await startAtTask(state, task);
    await harness.controller.answerText("Thursday");
    await harness.controller.playFeedbackAudio();
    expect(state.feedbackAudioCalls).toEqual(["66666666-6666-6666-6666-666666666666"]);
    expect(harness.media.playUrls).toEqual(["https://media.test/reference-audio"]);
  });

  it("wysyła zaznaczone pojęcia kluczowe jako odpowiedź selection bez duplikatów", async () => {
    const keywords = taskDto("keywords-task", { kind: "lesson_keywords", instructionPl: "Wybierz.", prompt: "Na czym polega fotosynteza?",
      options: ["a", "b", "c", "d"].map((letter) => ({ id: `opt-${letter}`, text: letter })), minSelected: 2, maxSelected: 3 });
    const harness = await startAtTask(baseState(), keywords);
    const submit = vi.spyOn(harness.api, "submitAnswer");
    await harness.controller.answerSelection(["opt-c", "opt-a", "opt-c"]);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]![0]).toMatchObject({ taskId: "keywords-task", modality: "selection", itemIds: ["opt-c", "opt-a"] });
    expect(harness.state.submissions.at(-1)).toMatchObject({ modality: "selection" });
    harness.controller.teardown();
  });

  it("deklaruje wsparcie zestawów obrazkowych i odtwarza słuchanie po jawnej akcji", async () => {
    const listening = taskDto("picture-listening", { kind: "picture_listening", audioAssetId: "asset-listening", options: [
      { id: "option-1", labelPl: "czerwony", visual: { kind: "color", color: "#ff0000" } },
      { id: "option-2", labelPl: "niebieski", visual: { kind: "color", color: "#0000ff" } },
    ] });
    const harness = await startAtTask(baseState(), listening);
    expect(harness.state.startedSessions[0]).toMatchObject({ supportsPictureVocabulary: true });
    expect(harness.media.playUrls).toEqual([]);
    await harness.controller.playTaskAudio();
    expect(harness.media.playUrls).toEqual(["https://media.test/asset-listening"]);
  });

  it("nie odtwarza instrukcji podczas uruchamiania ani nagrywania mikrofonu", async () => {
    const state = baseState();
    state.uiAudioReady = true;
    const speech = taskDto("picture-speech-guidance", {
      kind: "picture_speech", audioAssetId: "asset-pattern", visual: { kind: "color", color: "#ff0000" },
    });
    let release!: () => void;
    const startGate = new Promise<void>((resolve) => { release = resolve; });
    const harness = await startAtTask(state, speech, { startGate });
    harness.media.playUrls.length = 0;
    await harness.controller.prepareMicrophone();
    const recording = harness.controller.startRecording();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "starting" });
    await harness.controller.playGuidance("recall");
    expect(harness.media.playUrls).toEqual([]);
    release();
    await recording;
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "recording" });
    await harness.controller.playGuidance("recall");
    expect(harness.media.playUrls).toEqual([]);
    harness.controller.teardown();
  });

  it("ponawia pobranie katalogu instrukcji po błędzie i pustym katalogu", async () => {
    const state = baseState();
    state.uiAudioReadFailureCount = 1;
    const recall = taskDto("guidance-retry", { kind: "recall", prompt: "czwartek" });
    const harness = await startAtTask(state, recall);
    expect(state.uiAudioReadCalls).toBe(1);

    await expect(harness.controller.playGuidance("recall")).rejects.toThrow("UI audio unavailable");
    expect(state.uiAudioReadCalls).toBe(2);
    state.uiAudioReady = true;
    await harness.controller.playGuidance("recall");

    expect(state.uiAudioReadCalls).toBe(3);
    expect(harness.media.playUrls).toEqual(["https://media.test/asset-guidance"]);
  });

  it("odświeża niegotowy katalog instrukcji przy ponownej próbie", async () => {
    const state = baseState();
    const recall = taskDto("guidance-catalog-not-ready", { kind: "recall", prompt: "czwartek" });
    const harness = await startAtTask(state, recall);
    expect(state.uiAudioReadCalls).toBe(1);

    state.uiAudioReady = true;
    await harness.controller.playGuidance("recall");

    expect(state.uiAudioReadCalls).toBe(2);
    expect(harness.media.playUrls).toEqual(["https://media.test/asset-guidance"]);
  });

  it("udostępnia ponowienie i zakończenie, gdy odtwarzacz nie dekoduje audio zadania", async () => {
    const speech = taskDto("picture-speech-audio-error", {
      kind: "picture_speech", audioAssetId: "asset-pattern", visual: { kind: "color", color: "#ff0000" },
    });
    const harness = await startAtTask(baseState(), speech);
    harness.media.player.play = async () => { throw new Error("decode failed"); };
    await harness.controller.playTaskAudio();
    expect(harness.controller.getScreen()).toMatchObject({ taskAudioError: "failed" });
  });

  it("komunikat o audio zadania obrazkowego zostaje po wysłaniu odpowiedzi (stabilny układ do werdyktu)", async () => {
    const state = baseState();
    const speech = taskDto("picture-speech-audio-error-keep", {
      kind: "picture_speech", audioAssetId: "asset-pattern", visual: { kind: "color", color: "#ff0000" },
    });
    state.attempts = [attemptDto({ taskId: speech.taskId, modality: "skip", taskState: "answered", feedback: { kind: "not_assessed" } })];
    const harness = await startAtTask(state, speech);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(harness.api, "submitAnswer").mockImplementation(async (input) => { await gate; return makeApi(harness.state).submitAnswer(input); });
    harness.media.player.play = async () => { throw new Error("decode failed"); };
    await harness.controller.playTaskAudio();
    expect(harness.controller.getScreen()).toMatchObject({ taskAudioError: "failed" });
    const pending = harness.controller.skip();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.controller.getScreen()).toMatchObject({ busy: true, taskAudioError: "failed" });
    release();
    await pending;
  });

  it("nie odtwarza autoryzacji, która wróciła już po zmianie karty", async () => {
    const state = baseState();
    const first = taskDto("77777777-7777-7777-7777-777777777777", { kind: "recall", prompt: "czwartek" });
    const second = taskDto("88888888-8888-8888-8888-888888888888", { kind: "recall", prompt: "wtorek" });
    state.tasks = [second];
    state.attempts = [attemptDto({ taskId: first.taskId, attemptId: "66666666-6666-6666-6666-666666666666", modality: "audio", feedback: { kind: "almost", referenceAudioAvailable: true } })];
    let release!: () => void;
    state.feedbackAudioGate = new Promise<void>((resolve) => { release = resolve; });
    const harness = await startAtTask(state, first);
    // następne zadanie istnieje już przy feedbacku — kontroler pobiera je w tle
    state.tasks = [second];
    await harness.controller.answerText("Thursday");
    const pending = harness.controller.playFeedbackAudio();
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.tasks = [second];
    await harness.controller.continueLearning();
    release();
    await pending;
    expect(harness.controller.getScreen()).toMatchObject({ task: { taskId: second.taskId }, feedback: null });
    expect(harness.media.playUrls).toEqual([]);
  });

  it("zatrzymuje aktywne odtwarzanie natychmiast po przejściu z retry", async () => {
    const state = baseState();
    const task = taskDto("77777777-7777-7777-7777-777777777777", { kind: "recall", prompt: "czwartek" });
    state.attempts = [attemptDto({ taskId: task.taskId, modality: "audio", taskState: "issued", feedback: { kind: "almost", referenceAudioAvailable: true } })];
    let release!: () => void;
    const playGate = new Promise<void>((resolve) => { release = resolve; });
    const harness = await startAtTask(state, task, { playGate });
    await harness.controller.answerText("Thursday");
    const playing = harness.controller.playFeedbackAudio();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stopsBeforeRetry = harness.media.stops;
    const continuing = harness.controller.continueLearning();
    expect(harness.media.stops).toBeGreaterThan(stopsBeforeRetry);
    await continuing;
    release();
    await playing;
  });

  it("zatrzymuje odsłuch zanim serwer zakończy sesję", async () => {
    const state = baseState();
    const task = taskDto("77777777-7777-7777-7777-777777777777", { kind: "listening", options: [], audioAssetId: "question-audio" });
    let releasePlay!: () => void;
    const playGate = new Promise<void>((resolve) => { releasePlay = resolve; });
    const harness = await startAtTask(state, task, { playGate });
    await new Promise((resolve) => setTimeout(resolve, 0));
    let releaseEnd!: () => void;
    state.endSessionGate = new Promise<void>((resolve) => { releaseEnd = resolve; });
    const stopsBeforeEnd = harness.media.stops;
    const ending = harness.controller.endNow();
    expect(harness.media.stops).toBeGreaterThan(stopsBeforeEnd);
    releaseEnd();
    releasePlay();
    await ending;
  });

  it("przenosi długość odtwarzacza do raportu aktywności", async () => {
    const state = baseState();
    const task = taskDto("duration-forwarding", { kind: "exposure", source: "kot", target: "cat", example: null, audioAssetId: "question-audio", exampleAudioAssetId: null, imageAssetId: null, visualType: "none" });
    let now = 0;
    let finishPlayback!: () => void;
    const playGate = new Promise<void>((resolve) => { finishPlayback = resolve; });
    const harness = await startAtTask(state, task, { playbackDurationMs: 2_000, playGate, activityClock: { now: () => now } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    now = 2_000;
    finishPlayback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.controller.endNow();
    expect(state.endReports[0]?.tasks[0]?.playbacks).toEqual([
      expect.objectContaining({ assetId: "question-audio", toMs: 2_000 }),
    ]);
  });

  it("anuluje mikrofon przed oczekiwaniem na zakończenie sesji i nie wysyła próby po limicie", async () => {
    const state = baseState();
    const task = taskDto("speech", { kind: "speech", text: "apple", visualType: "none", imageAssetId: null, audioAssetId: null });
    const harness = await startAtTask(state, task);
    await harness.controller.prepareMicrophone();
    await harness.controller.startRecording();
    let releaseEnd!: () => void;
    state.endSessionGate = new Promise<void>((resolve) => { releaseEnd = resolve; });
    const ending = harness.controller.endNow();
    expect(harness.recorder.cancelled).toBe(1);
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "idle", busy: true });
    harness.recorder.hitLimit();
    releaseEnd();
    await ending;
    expect(state.speechSubmissions).toHaveLength(0);
  });

  it("unieważnia spóźniony start mikrofonu, gdy dziecko kończy sesję", async () => {
    const state = baseState();
    const task = taskDto("speech", { kind: "speech", text: "apple", visualType: "none", imageAssetId: null, audioAssetId: null });
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const harness = await startAtTask(state, task, { startGate });
    await harness.controller.prepareMicrophone();
    const starting = harness.controller.startRecording();
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "starting" });

    let releaseEnd!: () => void;
    state.endSessionGate = new Promise<void>((resolve) => { releaseEnd = resolve; });
    const ending = harness.controller.endNow();
    expect(harness.recorder.cancelled).toBe(1);
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "idle", busy: true });
    releaseStart();
    await starting;
    harness.recorder.hitLimit();
    releaseEnd();
    await ending;
    expect(state.speechSubmissions).toHaveLength(0);
  });

  it("nie uruchamia opóźnionego audio zadania po anulowaniu nagrania", async () => {
    const state = baseState();
    let release!: () => void;
    state.disclosureGate = new Promise<void>((resolve) => { release = resolve; });
    const task = taskDto("77777777-7777-7777-7777-777777777777", { kind: "speech", text: "Thursday", visualType: "none", imageAssetId: null, audioAssetId: "task-audio" });
    const harness = await startAtTask(state, task);
    await harness.controller.prepareMicrophone();
    const pendingAudio = harness.controller.playTaskAudio();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const starting = harness.controller.startRecording();
    harness.controller.cancelRecording();
    await starting;
    release();
    await pendingAudio;
    expect(harness.media.playUrls).toEqual([]);
  });

  it("asynchroniczna awaria rejestratora wraca do idle bez wysyłania próby", async () => {
    const task = taskDto("speech", { kind: "speech", text: "apple", visualType: "none", imageAssetId: null, audioAssetId: null });
    const harness = await startAtTask(baseState(), task);
    await harness.controller.prepareMicrophone();
    await harness.controller.startRecording();
    harness.recorder.fail();
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "idle", recording: false, recordingNotice: expect.any(String) });
    expect(harness.state.speechSubmissions).toHaveLength(0);
  });

  it("potwierdzenie „Koniec” przerywa nagranie bez wysyłania i wycisza odtwarzanie, nie kończąc sesji", async () => {
    const state = baseState();
    const task = taskDto("speech", { kind: "speech", text: "apple", visualType: "none", imageAssetId: null, audioAssetId: null });
    const harness = await startAtTask(state, task);
    await harness.controller.prepareMicrophone();
    await harness.controller.startRecording();
    const stopsBefore = harness.media.stops;

    harness.controller.holdForEndConfirm();

    expect(harness.recorder.cancelled).toBe(1);
    expect(harness.media.stops).toBeGreaterThan(stopsBefore);
    expect(harness.controller.getScreen()).toMatchObject({ kind: "learning", recordingPhase: "idle", busy: false, task: { taskId: task.taskId } });
    harness.recorder.hitLimit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.speechSubmissions).toHaveLength(0);
    expect(state.endedSessions).toHaveLength(0);
    expect(harness.recorder.started).toBe(1);
  });

  it("potwierdzenie „Koniec” bez nagrania tylko wycisza odtwarzanie", async () => {
    const state = baseState();
    const task = taskDto("speech", { kind: "speech", text: "apple", visualType: "none", imageAssetId: null, audioAssetId: null });
    const harness = await startAtTask(state, task);
    const stopsBefore = harness.media.stops;

    harness.controller.holdForEndConfirm();

    expect(harness.recorder.cancelled).toBe(0);
    expect(harness.media.stops).toBeGreaterThan(stopsBefore);
    expect(harness.controller.getScreen()).toMatchObject({ kind: "learning", recordingPhase: "idle", busy: false });
    expect(state.endedSessions).toHaveLength(0);
  });

  it("starts mock test only after confirming server budget and advances without correctness feedback", async () => {
    const state = baseState();
    const first = taskDto("mock-1", { kind: "recall", prompt: "poniedziałek" }), second = { ...taskDto("mock-2", { kind: "recall", prompt: "wtorek" }), ordinal: 1 };
    state.tasks = [first, second];
    state.attempts = [attemptDto({ taskId: first.taskId, feedback: null, taskState: "answered" })];
    const { controller } = makeHarness(state);
    await controller.start(); await controller.selectProfile(PROFILE_A.childId); controller.setMicrophone(false);
    await controller.startMockTest(DECK.deckId);
    expect(controller.getScreen()).toMatchObject({ kind: "mockTestReady", session: { mode: "mock_test", taskBudget: 12 } });
    await controller.beginMockTest();
    expect(controller.getScreen()).toMatchObject({ kind: "learning", task: { taskId: first.taskId } });
    await controller.answerText("wrong");
    expect(controller.getScreen()).toMatchObject({ kind: "learning", task: { taskId: second.taskId }, feedback: null, processing: false });
    await controller.endNow();
    expect(controller.getScreen()).toMatchObject({ kind: "mockTestSummary", summary: { answeredCount: 2 } });
  });

  it("mock offline retry keeps identity and does not pretend to complete an answer", async () => {
    const state = baseState(); state.tasks = [taskDto("mock-1", { kind: "recall", prompt: "poniedziałek" })];
    const { controller } = makeHarness(state);
    await controller.start(); await controller.selectProfile(PROFILE_A.childId); await controller.startMockTest(DECK.deckId); await controller.beginMockTest();
    state.networkDown = true;
    await controller.answerText("Monday");
    expect(controller.getScreen()).toMatchObject({ kind: "learning", offline: true, feedback: null });
    state.networkDown = false; state.attempts = [attemptDto({ feedback: null, taskState: "answered" })];
    await controller.retry();
    expect(controller.getScreen()).toMatchObject({ kind: "mockTestSummary" });
  });
  it("mock notRemember submits difficulty without opening a hint", async () => {
    const state = baseState(); state.tasks = [taskDto("mock-1", { kind: "recall", prompt: "poniedziałek" }), taskDto("mock-2", { kind: "recall", prompt: "wtorek" })];
    state.attempts = [attemptDto({ feedback: null, taskState: "answered" })];
    const { controller } = makeHarness(state); await controller.start(); await controller.selectProfile(PROFILE_A.childId);
    await controller.startMockTest(DECK.deckId); await controller.beginMockTest(); await controller.notRemember();
    expect(controller.getScreen()).toMatchObject({ kind: "learning", task: { taskId: "mock-2" }, reveal: null });
  });
  it("conflicting answer from another browser refreshes the task instead of resending stale knowledge", async () => {
    const state = baseState(); state.tasks = [taskDto("mock-1", { kind: "recall", prompt: "poniedziałek" }), taskDto("mock-2", { kind: "recall", prompt: "wtorek" })];
    const { controller } = makeHarness(state); await controller.start(); await controller.selectProfile(PROFILE_A.childId);
    await controller.startMockTest(DECK.deckId); await controller.beginMockTest();
    state.submitError = new KidApiError("conflict", false);
    await controller.answerText("Monday"); await controller.retry();
    expect(controller.getScreen()).toMatchObject({ kind: "learning", task: { taskId: "mock-2" }, error: null, feedback: null });
  });
  it("does not play audio after authorization resolves for a task that has already advanced", async () => {
    const optionId = "88888888-8888-8888-8888-888888888888";
    const first = taskDto("mock-1", { kind: "listening", options: [{ id: optionId, text: "poniedziałek" }], audioAssetId: "old-audio" });
    const second = taskDto("mock-2", { kind: "recall", prompt: "wtorek" });
    const state = baseState(); state.tasks = [first, second];
    state.attempts = [attemptDto({ taskId: first.taskId, modality: "choice", feedback: null, taskState: "answered" })];
    let release!: () => void;
    state.disclosureGate = new Promise<void>(resolve => { release = resolve; });
    const { controller, media } = makeHarness(state);
    await controller.start(); await controller.selectProfile(PROFILE_A.childId);
    await controller.startMockTest(DECK.deckId); await controller.beginMockTest();
    expect(state.disclosures).toContainEqual({ taskId: first.taskId, kind: "audio" });

    await controller.answerChoice(optionId);
    expect(controller.getScreen()).toMatchObject({ kind: "learning", task: { taskId: second.taskId } });
    release();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(media.playUrls).not.toContain("https://media.test/old-audio");
  });
  it("does not acknowledge listening audio when playback is stopped for microphone recording", async () => {
    const listening = taskDto("t1", { kind: "listening", options: [], audioAssetId: "asset-1" });
    const state = baseState();
    let releasePlayback!: () => void;
    const playGate = new Promise<void>(resolve => { releasePlayback = resolve; });
    const harness = await startAtTask(state, listening, { playGate, onStopPlayback: releasePlayback });

    const stopsBeforePreparation = harness.media.stops;
    await harness.controller.prepareMicrophone();
    expect(harness.media.stops).toBe(stopsBeforePreparation + 1);
    await harness.controller.startRecording();
    await Promise.resolve();

    expect(state.observations).not.toContain("audio_played");
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "recording" });
    harness.controller.cancelRecording();
  });
  it("shows offline state when mock audio disclosure authorization fails and retries playback", async () => {
    const state = baseState();
    state.tasks = [taskDto("mock-1", { kind: "listening", options: [{ id: "option-1", text: "poniedziałek" }], audioAssetId: "audio-1" })];
    state.disclosureError = new TypeError("fetch failed");
    const { controller, media } = makeHarness(state);
    await controller.start(); await controller.selectProfile(PROFILE_A.childId);
    await controller.startMockTest(DECK.deckId); await controller.beginMockTest();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(controller.getScreen()).toMatchObject({ kind: "learning", offline: true, error: null, busy: false });
    expect(media.playUrls).toEqual([]);
    await controller.answerChoice("option-1");
    expect(state.submissions).toEqual([]);

    state.disclosureError = undefined;
    await controller.retry();
    expect(media.playUrls).toEqual(["https://media.test/audio-1"]);
    expect(controller.getScreen()).toMatchObject({ kind: "learning", offline: false });
  });
  it("refreshes a closed mock listening slot after disclosure authorization conflicts", async () => {
    const state = baseState();
    state.tasks = [
      taskDto("mock-1", { kind: "listening", options: [], audioAssetId: "audio-1" }),
      taskDto("mock-2", { kind: "recall", prompt: "wtorek" }),
    ];
    state.disclosureError = new KidApiError("conflict", false);
    const { controller } = makeHarness(state);
    await controller.start(); await controller.selectProfile(PROFILE_A.childId);
    await controller.startMockTest(DECK.deckId); await controller.beginMockTest();
    await new Promise(resolve => setTimeout(resolve, 0));
    const failedScreen = controller.getScreen();
    expect(failedScreen).toMatchObject({ kind: "learning", task: { taskId: "mock-1" } });
    expect(failedScreen.kind === "learning" && failedScreen.error).toBeTruthy();

    state.disclosureError = undefined;
    await controller.retry();
    expect(controller.getScreen()).toMatchObject({ kind: "learning", task: { taskId: "mock-2" }, error: null });
  });
  it("refreshes the task when a transport retry discovers that the mock slot already closed", async () => {
    const state = baseState(); state.tasks = [taskDto("mock-1", { kind: "recall", prompt: "poniedziałek" }), taskDto("mock-2", { kind: "recall", prompt: "wtorek" })];
    const { controller } = makeHarness(state); await controller.start(); await controller.selectProfile(PROFILE_A.childId);
    await controller.startMockTest(DECK.deckId); await controller.beginMockTest();
    state.networkDown = true;
    await controller.answerText("Monday");
    expect(controller.getScreen()).toMatchObject({ kind: "learning", offline: true, task: { taskId: "mock-1" } });

    state.networkDown = false; state.submitError = new KidApiError("conflict", false);
    await expect(controller.retry()).resolves.toBeUndefined();

    expect(controller.getScreen()).toMatchObject({ kind: "learning", task: { taskId: "mock-2" }, offline: false, error: null });
  });
  it("mediaUrl deleguje do klienta API — wspólne źródło URL obrazka i audio", () => {
    const harness = makeHarness(baseState());
    expect(harness.controller.mediaUrl("asset-1")).toBe("https://media.test/asset-1");
  });

  it("kartkówka lekcji kończy się omówieniem per cel (lessonMockTestSummary), nie słówkowym", async () => {
    const state = baseState();
    state.decks = [DECK, LESSON_DECK];
    state.tasks = [taskDto("mock-1", { kind: "recall", prompt: "I ___ (go) to school." })];
    state.attempts = [attemptDto({ taskId: "mock-1", feedback: null, taskState: "answered" })];
    state.lessonMockSummary = {
      sessionId: "55555555-5555-5555-5555-555555555555",
      deckId: LESSON_DECK.deckId,
      state: "completed",
      complete: true,
      taskBudget: 1,
      answeredCount: 1,
      solutions: [{ taskId: "mock-1", objectiveId: "obj-present-simple", titlePl: "Present Simple", exerciseType: "lesson_short_answer", prompt: "I ___ (go) to school.", childAnswer: "go", correctAnswer: "go", outcome: "correct" }],
    };
    const { controller } = makeHarness(state);
    await controller.start(); await controller.selectProfile(PROFILE_A.childId); controller.setMicrophone(false);
    await controller.startMockTest(LESSON_DECK.deckId);
    await controller.beginMockTest();
    await controller.answerText("go");
    // kompletność bierzemy z complete=true (stan completed po Fix round 1)
    await vi.waitFor(() => expect(controller.getScreen()).toMatchObject({ kind: "lessonMockTestSummary", summary: { complete: true, deckId: LESSON_DECK.deckId, solutions: [{ objectiveId: "obj-present-simple", outcome: "correct" }] } }));
  });

  it("kartkówka słówek nadal kończy się słówkowym omówieniem (bez regresji)", async () => {
    const state = baseState();
    state.tasks = [taskDto("mock-1", { kind: "recall", prompt: "poniedziałek" })];
    state.attempts = [attemptDto({ taskId: "mock-1", feedback: null, taskState: "answered" })];
    const { controller } = makeHarness(state);
    await controller.start(); await controller.selectProfile(PROFILE_A.childId); controller.setMicrophone(false);
    await controller.startMockTest(DECK.deckId);
    await controller.beginMockTest();
    await controller.answerText("Monday");
    expect(controller.getScreen()).toMatchObject({ kind: "mockTestSummary" });
  });

  it.each([
    { label: "słówek", deck: DECK, screen: "mockTestSummary", gate: "mockSummaryGate" as const },
    { label: "lekcji", deck: LESSON_DECK, screen: "lessonMockTestSummary", gate: "lessonMockSummaryGate" as const },
  ])("pokazuje pending podsumowanie kartkówki $label przed odczytem szczegółów", async ({ deck, screen, gate }) => {
    const state = baseState();
    state.decks = [DECK, LESSON_DECK];
    state.tasks = [taskDto("mock-pending", { kind: "recall", prompt: "poniedziałek" })];
    state.endActivityResult = { status: "already_started", pointsAwarded: 0, errorCode: null };
    let release!: () => void;
    state[gate] = new Promise<void>(resolve => { release = resolve; });
    const { controller } = makeHarness(state);
    await controller.start(); await controller.selectProfile(PROFILE_A.childId);
    await controller.startMockTest(deck.deckId); await controller.beginMockTest();

    const ending = controller.endNow();
    await Promise.resolve(); await Promise.resolve();
    expect(controller.getScreen().kind).toBe(screen);
    expect(controller.getActivityResult()).toMatchObject({ status: "already_started" });

    release();
    await ending;
    await vi.waitFor(() => expect(controller.getScreen()).toMatchObject({ kind: screen, summary: { answeredCount: 2 } }));
    controller.teardown();
  });

  it.each([
    { label: "słówek", deck: DECK, screen: "mockTestSummary", error: "mockSummaryError" as const },
    { label: "lekcji", deck: LESSON_DECK, screen: "lessonMockTestSummary", error: "lessonMockSummaryError" as const },
  ])("nie cofa pending podsumowania kartkówki $label po błędzie GET szczegółów", async ({ deck, screen, error }) => {
    const state = baseState();
    state.decks = [DECK, LESSON_DECK];
    state.tasks = [taskDto("mock-details-error", { kind: "recall", prompt: "poniedziałek" })];
    state.endActivityResult = { status: "already_started", pointsAwarded: 0, errorCode: null };
    state[error] = new TypeError("fetch failed");
    const { controller } = makeHarness(state);
    await controller.start(); await controller.selectProfile(PROFILE_A.childId);
    await controller.startMockTest(deck.deckId); await controller.beginMockTest();

    await controller.endNow();
    await Promise.resolve(); await Promise.resolve();

    expect(controller.getScreen()).toMatchObject({ kind: screen, childId: PROFILE_A.childId, detailsError: true, summary: { sessionId: "55555555-5555-5555-5555-555555555555" } });
    expect(controller.getActivityResult()).toMatchObject({ status: "already_started" });
    delete state[error];
    await controller.retryMockTestSummaryDetails();
    expect(controller.getScreen()).toMatchObject({ kind: screen, detailsLoading: false, detailsError: false });
    controller.teardown();
  });

  it.each([
    { label: "słówek", deck: DECK },
    { label: "lekcji", deck: LESSON_DECK },
  ])("polling aktualizuje wynik kartkówki $label na evaluated albo error", async ({ deck }) => {
    vi.useFakeTimers();
    try {
      for (const result of [
        { status: "evaluated" as const, pointsAwarded: 3, errorCode: null },
        { status: "error" as const, pointsAwarded: 0, errorCode: "review_failed" },
      ]) {
        const state = baseState();
        state.decks = [DECK, LESSON_DECK];
        state.tasks = [taskDto("mock-terminal", { kind: "recall", prompt: "poniedziałek" })];
        state.endActivityResult = { status: "already_started", pointsAwarded: 0, errorCode: null };
        state.activityResults = [result];
        const { controller } = makeHarness(state);
        await controller.start(); await controller.selectProfile(PROFILE_A.childId);
        await controller.startMockTest(deck.deckId); await controller.beginMockTest();
        await controller.endNow();
        expect(controller.getScreen()).toMatchObject({ kind: deck.kind === "lesson" ? "lessonMockTestSummary" : "mockTestSummary", childId: PROFILE_A.childId });

        await vi.advanceTimersByTimeAsync(2);

        expect(controller.getActivityResult()).toEqual(result);
        controller.teardown();
      }
    } finally { vi.useRealTimers(); }
  });

  it.each([
    { label: "słówek", deck: DECK },
    { label: "lekcji", deck: LESSON_DECK },
  ])("wynik kartkówki $label po zmianie profilu nie trafia do aktywnego dziecka", async ({ deck }) => {
    vi.useFakeTimers();
    try {
      const state = baseState();
      state.decks = [DECK, LESSON_DECK];
      state.tasks = [taskDto("mock-owner", { kind: "recall", prompt: "poniedziałek" })];
      state.endActivityResult = { status: "already_started", pointsAwarded: 0, errorCode: null };
      state.activityResults = [{ status: "evaluated", pointsAwarded: 5, errorCode: null }];
      const { controller } = makeHarness(state);
      await controller.start(); await controller.selectProfile(PROFILE_A.childId);
      await controller.startMockTest(deck.deckId); await controller.beginMockTest();
      await controller.endNow();
      await controller.switchProfile(); await controller.selectProfile(PROFILE_B.childId);
      state.profiles = [{ ...PROFILE_A, rewardPoints: 5 }, PROFILE_B];

      await vi.advanceTimersByTimeAsync(2);

      expect(state.activityResultCalls).toEqual(["55555555-5555-5555-5555-555555555555"]);
      const screen = controller.getScreen();
      expect(screen).toMatchObject({ kind: "deck", childId: PROFILE_B.childId });
      expect(screen.kind === "deck" && screen.profiles.find(profile => profile.childId === PROFILE_A.childId)?.rewardPoints).toBe(5);
      expect(controller.getActivityResult()).toBeNull();
      controller.teardown();
    } finally { vi.useRealTimers(); }
  });

  it("pojedynczy profil bez initialChildId zatrzymuje się na ekranie wyboru profilu", async () => {
    const harness = makeHarness({ ...baseState(), profiles: [PROFILE_A] });
    await harness.controller.start();
    expect(harness.controller.getScreen()).toMatchObject({ kind: "profile", profiles: [PROFILE_A] });
  });

  it("link z profilem otwiera wskazane dziecko bez ekranu wyboru", async () => {
    const harness = makeHarness(baseState(), { initialChildId: PROFILE_B.childId });

    await harness.controller.start();

    expect(harness.controller.getScreen()).toMatchObject({ kind: "deck", childId: PROFILE_B.childId });
  });

  it("nieaktualny link z profilem pokazuje dostępne profile", async () => {
    const harness = makeHarness(
      { ...baseState(), profiles: [PROFILE_A] },
      { initialChildId: "99999999-9999-9999-9999-999999999999" },
    );

    await harness.controller.start();

    expect(harness.controller.getScreen()).toMatchObject({ kind: "profile", profiles: [PROFILE_A] });
  });

  it("dwa profile wymagają wyboru i prowadzą osobne sesje", async () => {
    const state = baseState();
    const harness = makeHarness(state);
    await harness.controller.start();
    expect(harness.controller.getScreen()).toMatchObject({ kind: "profile" });

    await harness.controller.selectProfile(PROFILE_A.childId);
    state.tasks = [taskDto("t1", { kind: "listening", options: [], audioAssetId: "a1" })];
    await harness.controller.startLearning(DECK.deckId);
    expect(harness.state.startedSessions[0]).toMatchObject({ childId: PROFILE_A.childId, microphoneEnabled: false });

    await harness.controller.switchProfile();
    expect(harness.controller.getScreen()).toMatchObject({ kind: "profile" });
    await harness.controller.selectProfile(PROFILE_B.childId);
    state.tasks = [taskDto("t2", { kind: "recall", prompt: "czwartek" })];
    await harness.controller.startLearning(DECK.deckId);
    expect(harness.state.startedSessions[1]).toMatchObject({ childId: PROFILE_B.childId, microphoneEnabled: false });
  });

  it("domyślnie wyłącza mikrofon przed startem zestawu", async () => {
    const state = baseState();
    state.listDeckRequests = [];
    const harness = makeHarness(state);
    await harness.controller.start();
    await harness.controller.selectProfile(PROFILE_A.childId);

    expect(harness.controller.getScreen()).toMatchObject({ kind: "deck", microphone: false });
    expect(state.listDeckRequests).toContainEqual({ childId: PROFILE_A.childId, microphoneEnabled: false });
    await harness.controller.startLearning(DECK.deckId);
    expect(harness.state.startedSessions[0]).toMatchObject({ microphoneEnabled: false });
  });

  it("pokazuje błąd po nieudanym pobraniu zestawów zamiast pozostawiać ekran loading", async () => {
    const state = baseState();
    state.listDecksError = new TypeError("fetch failed");
    const harness = makeHarness(state);
    await harness.controller.start();
    await harness.controller.selectProfile(PROFILE_A.childId);
    expect(harness.controller.getScreen()).toMatchObject({ kind: "initError" });
  });

  it("pokazuje zestawy przed zakończeniem odświeżenia profili i ignoruje jego wynik po zmianie profilu", async () => {
    const state = baseState();
    const harness = makeHarness(state);
    await harness.controller.start();
    let releaseProfiles!: () => void;
    state.listProfilesGate = new Promise<void>((resolve) => { releaseProfiles = resolve; });

    await harness.controller.selectProfile(PROFILE_A.childId);
    expect(harness.controller.getScreen()).toMatchObject({ kind: "deck", childId: PROFILE_A.childId });

    await harness.controller.selectProfile(PROFILE_B.childId);
    expect(harness.controller.getScreen()).toMatchObject({ kind: "deck", childId: PROFILE_B.childId });
    releaseProfiles();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.controller.getScreen()).toMatchObject({ kind: "deck", childId: PROFILE_B.childId });
    harness.controller.teardown();
  });

  it("zachowuje zapamiętaną odmowę mikrofonu po wznowieniu sesji z mikrofonem włączonym po stronie serwera", async () => {
    const state = baseState();
    state.startSessionResponse = { microphoneEnabled: true, resumed: true };
    state.tasks = [taskDto("resumed-recall", { kind: "recall", prompt: "czwartek" })];
    const storage = createMemoryPreferences();
    storage.write(MIC_DENIED_KEY, "1");
    const harness = makeHarness(state, { storage });
    await harness.controller.start();
    await harness.controller.selectProfile(PROFILE_A.childId);

    await harness.controller.startLearning(DECK.deckId);

    expect(harness.controller.getScreen()).toMatchObject({
      kind: "learning",
      session: { microphoneEnabled: true, resumed: true },
      micDenied: true,
    });
  });

  it("wyłącza mikrofon po stronie serwera przy wznowieniu picture sesji nieczytającego profilu z zapisaną odmową", async () => {
    const state = baseState();
    state.profiles = [{ ...PROFILE_A, canRead: false }];
    state.decks = [{ ...DECK, vocabularyFormat: "picture" }];
    state.startSessionResponse = { microphoneEnabled: true, resumed: true, canRead: false, vocabularyFormat: "picture" };
    const recall = taskDto("resumed-picture-recall", { kind: "picture_recall", visual: { kind: "number", count: 2 } });
    state.tasks = [recall];
    state.disableError = new TypeError("fetch failed");
    const storage = createMemoryPreferences();
    storage.write(MIC_DENIED_KEY, "1");
    const harness = makeHarness(state, { storage });
    await harness.controller.start();
    await harness.controller.selectProfile(PROFILE_A.childId);

    await harness.controller.startLearning(DECK.deckId);

    expect(state.startedSessions.at(-1)).toMatchObject({ microphoneEnabled: false });
    expect(state.disabledSessions).toEqual(["55555555-5555-5555-5555-555555555555"]);
    expect(harness.controller.getScreen()).toMatchObject({
      kind: "learning",
      session: { microphoneEnabled: true },
      task: null,
      micDenied: true,
      error: messages.errors.picture_microphone_disable_failed,
    });

    state.disableError = undefined;
    await harness.controller.retry();

    expect(state.disabledSessions).toEqual([
      "55555555-5555-5555-5555-555555555555",
      "55555555-5555-5555-5555-555555555555",
    ]);
    expect(harness.controller.getScreen()).toMatchObject({
      kind: "learning",
      session: { microphoneEnabled: false },
      task: { taskId: recall.taskId },
      micDenied: true,
      error: null,
    });
  });

  it("exposure zamyka prezentację bez próby; koniec zadań kończy sesję", async () => {
    const exposure = taskDto("t1", { kind: "exposure", source: "czwartek", target: "Thursday", example: null, audioAssetId: null, exampleAudioAssetId: null, imageAssetId: null, visualType: "none" });
    const state = baseState();
    const harness = await startAtTask(state, exposure);
    // brak audioAssetId → bez autoodtwarzania i bez próby
    await harness.controller.completePresentation();
    expect(state.presentations).toEqual(["t1"]);
    expect(state.submissions).toHaveLength(0);
    expect(harness.controller.getScreen()).toMatchObject({ kind: "summary" });
    expect(state.endedSessions).toHaveLength(1);
  });

  it("awaria sieci nie dopisuje sukcesu; retry używa tego samego clientAttemptId", async () => {
    const recall = taskDto("t1", { kind: "recall", prompt: "czwartek" });
    const state = baseState();
    const harness = await startAtTask(state, recall);
    state.networkDown = true;
    await harness.controller.answerText("Thursday");
    const screen = harness.controller.getScreen();
    expect(screen).toMatchObject({ kind: "learning", offline: true, feedback: null });
    expect(state.submissions).toHaveLength(0);

    state.networkDown = false;
    await harness.controller.retry();
    expect(state.submissions).toHaveLength(1);
    expect(harness.controller.getScreen()).toMatchObject({
      kind: "learning",
      offline: false,
      feedback: { dto: { kind: "great" }, retry: false },
    });
  });

  it("spóźniona awaria submitu sesji A nie zmienia raportu ani ekranu sesji B", async () => {
    const taskA = taskDto("stale-session-a", { kind: "recall", prompt: "kot" });
    const taskB = taskDto("current-session-b", { kind: "recall", prompt: "pies" });
    const state = baseState();
    state.tasks = [taskA, taskB];
    state.startSessionIds = ["55555555-5555-5555-5555-555555555555", "77777777-7777-4777-8777-777777777777"];
    const harness = makeHarness(state);
    await harness.controller.start();
    await harness.controller.selectProfile(PROFILE_A.childId);
    await harness.controller.startLearning(DECK.deckId);
    let failSubmit!: (error: Error) => void;
    const waiting = new Promise<void>((_resolve, reject) => { failSubmit = reject; });
    vi.spyOn(harness.api, "submitAnswer").mockImplementation(async () => { await waiting; throw new TypeError("fetch failed"); });
    const staleAnswer = harness.controller.answerText("cat");
    await harness.controller.selectProfile(PROFILE_B.childId);
    await harness.controller.startLearning(DECK.deckId);
    expect(harness.controller.getScreen()).toMatchObject({ kind: "learning", session: { sessionId: "77777777-7777-4777-8777-777777777777" }, task: { taskId: taskB.taskId }, offline: false });
    failSubmit(new TypeError("late network failure"));
    await staleAnswer;
    expect(harness.controller.getScreen()).toMatchObject({ kind: "learning", task: { taskId: taskB.taskId }, offline: false, feedback: null });
    const currentDraft = harness.activityDrafts.load("77777777-7777-4777-8777-777777777777");
    expect(currentDraft && "state" in currentDraft && currentDraft.state.tasks.map((task) => task.taskId)).toEqual([taskB.taskId]);
    harness.controller.teardown();
  });

  it("spóźniony sukces submitu A po retry i starcie B nie trafia do raportu B", async () => {
    const taskA = taskDto("stale-success-a", { kind: "recall", prompt: "kot" });
    const taskB = taskDto("current-success-b", { kind: "recall", prompt: "pies" });
    const state = baseState();
    state.tasks = [taskA, taskB];
    state.startSessionIds = ["55555555-5555-5555-5555-555555555555", "77777777-7777-4777-8777-777777777777"];
    const harness = makeHarness(state);
    await harness.controller.start();
    await harness.controller.selectProfile(PROFILE_A.childId);
    await harness.controller.startLearning(DECK.deckId);
    let finishSubmit!: (attempt: AttemptDto) => void;
    const waiting = new Promise<AttemptDto>((resolve) => { finishSubmit = resolve; });
    vi.spyOn(harness.api, "submitAnswer").mockImplementation(async () => waiting);
    const staleAnswer = harness.controller.answerText("cat");
    await harness.controller.selectProfile(PROFILE_B.childId);
    await harness.controller.startLearning(DECK.deckId);
    finishSubmit(attemptDto({ attemptId: "66666666-6666-4666-8666-666666666661", taskId: taskA.taskId }));
    await staleAnswer;
    await harness.controller.endNow();
    const reportB = state.endReports.find((report) => report.tasks.some((task) => task.taskId === taskB.taskId));
    expect(reportB?.tasks.find((task) => task.taskId === taskB.taskId)?.submittedAttempts).not.toContain("66666666-6666-4666-8666-666666666661");
    harness.controller.teardown();
  });

  it("odmowa mikrofonu przełącza na tryb bez nagrywania i jest zapamiętywana", async () => {
    const recall = taskDto("t1", { kind: "recall", prompt: "czwartek" });
    const state = baseState();
    const harness = await startAtTask(state, recall, {
      failStartWith: new DOMException("Permission dismissed", "NotAllowedError"),
    });
    await harness.controller.prepareMicrophone();

    await harness.controller.startRecording();
    let screen = harness.controller.getScreen();
    expect(screen).toMatchObject({ kind: "learning", micDenied: true, recording: false });
    expect(harness.storage.read(MIC_DENIED_KEY)).toBe("1");

    // sesja dalej działa pisemnie
    await harness.controller.answerText("Thursday");
    expect(state.submissions[0]).toMatchObject({ modality: "text" });

    // kolejna sesja startuje bez mikrofonu
    await harness.controller.endNow();
    state.tasks = [recall];
    await harness.controller.learnAgain();
    await harness.controller.startLearning(DECK.deckId);
    expect(state.startedSessions.at(-1)).toMatchObject({ microphoneEnabled: false });
    screen = harness.controller.getScreen();
    expect(screen).toMatchObject({ kind: "learning" });
  });

  it("ignoruje spóźnioną odmowę z poprzedniej sesji po przygotowaniu mikrofonu w nowej", async () => {
    const oldVoiceTask = taskDto("old-picture-voice", { kind: "picture_recall", visual: { kind: "number", count: 2 } });
    const newVoiceTask = taskDto("new-picture-voice", { kind: "picture_recall", visual: { kind: "number", count: 2 } });
    const state = baseState();
    state.profiles = [{ ...PROFILE_A, canRead: false }];
    state.decks = [{ ...DECK, vocabularyFormat: "picture" }];
    state.tasks = [oldVoiceTask, newVoiceTask];
    state.startSessionIds = ["55555555-5555-5555-5555-555555555555", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"];
    let releaseDisable!: () => void;
    state.disableGate = new Promise<void>((resolve) => { releaseDisable = resolve; });
    const harness = await startAtTask(state, oldVoiceTask);
    harness.media.prepareMicrophone = async () => { throw new DOMException("Permission dismissed", "NotAllowedError"); };

    const oldPreparation = harness.controller.prepareMicrophone();
    await expect.poll(() => state.disabledSessions).toEqual(["55555555-5555-5555-5555-555555555555"]);
    await harness.controller.endNow();
    state.tasks = [newVoiceTask];
    await harness.controller.learnAgain();
    await harness.controller.setMicrophone(true);
    await harness.controller.startLearning(DECK.deckId);
    harness.media.prepareMicrophone = async () => undefined;
    await harness.controller.prepareMicrophone();
    expect(harness.controller.getScreen()).toMatchObject({ kind: "learning", microphoneReady: true, micDenied: false });

    releaseDisable();
    await oldPreparation;
    expect(harness.controller.getScreen()).toMatchObject({
      kind: "learning",
      session: { sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", microphoneEnabled: true },
      task: { taskId: newVoiceTask.taskId },
      microphoneReady: true,
      micDenied: false,
    });
  });

  it("ignoruje spóźnioną odmowę recorder.start po przygotowaniu mikrofonu w nowej sesji", async () => {
    const oldVoiceTask = taskDto("old-recorder-voice", { kind: "picture_recall", visual: { kind: "number", count: 2 } });
    const newVoiceTask = taskDto("new-recorder-voice", { kind: "picture_recall", visual: { kind: "number", count: 2 } });
    const state = baseState();
    state.profiles = [{ ...PROFILE_A, canRead: false }];
    state.decks = [{ ...DECK, vocabularyFormat: "picture" }];
    state.tasks = [oldVoiceTask, newVoiceTask];
    state.startSessionIds = ["55555555-5555-5555-5555-555555555555", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
    let releaseDisable!: () => void;
    state.disableGate = new Promise<void>((resolve) => { releaseDisable = resolve; });
    const harness = await startAtTask(state, oldVoiceTask, {
      failStartWith: new DOMException("Permission dismissed", "NotAllowedError"),
    });
    await harness.controller.prepareMicrophone();

    const oldStart = harness.controller.startRecording();
    await expect.poll(() => state.disabledSessions).toEqual(["55555555-5555-5555-5555-555555555555"]);
    await harness.controller.endNow();
    state.tasks = [newVoiceTask];
    await harness.controller.learnAgain();
    await harness.controller.setMicrophone(true);
    await harness.controller.startLearning(DECK.deckId);
    await harness.controller.prepareMicrophone();
    expect(harness.controller.getScreen()).toMatchObject({ kind: "learning", microphoneReady: true, micDenied: false });

    releaseDisable();
    await oldStart;
    expect(harness.controller.getScreen()).toMatchObject({
      kind: "learning",
      session: { sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", microphoneEnabled: true },
      task: { taskId: newVoiceTask.taskId },
      microphoneReady: true,
      micDenied: false,
    });
  });

  it("awaria mikrofonu inna niż odmowa wyłącza nagrywanie tylko do końca sesji", async () => {
    const recall = taskDto("t1", { kind: "recall", prompt: "czwartek" });
    const state = baseState();
    const harness = await startAtTask(state, recall, {
      failStartWith: new DOMException("Requested device not found", "NotFoundError"),
    });
    await harness.controller.prepareMicrophone();

    await harness.controller.startRecording();
    expect(harness.controller.getScreen()).toMatchObject({
      kind: "learning",
      micDenied: false,
      recording: false,
    });
    expect(harness.storage.read(MIC_DENIED_KEY)).toBeNull();

    // sesja dalej działa pisemnie, a kolejna może ponownie poprosić o mikrofon
    await harness.controller.answerText("Thursday");
    await harness.controller.endNow();
    state.tasks = [recall];
    await harness.controller.learnAgain();
    harness.controller.setMicrophone(true);
    await harness.controller.startLearning(DECK.deckId);
    expect(state.startedSessions.at(-1)).toMatchObject({ microphoneEnabled: true });
  });

  it("włączenie mikrofonu na ekranie zestawów czyści zapamiętaną odmowę", async () => {
    const recall = taskDto("t1", { kind: "recall", prompt: "czwartek" });
    const state = baseState();
    const harness = await startAtTask(state, recall, {
      failStartWith: new DOMException("Permission dismissed", "NotAllowedError"),
    });
    await harness.controller.prepareMicrophone();

    await harness.controller.startRecording();
    expect(harness.storage.read(MIC_DENIED_KEY)).toBe("1");

    await harness.controller.answerText("Thursday");
    await harness.controller.endNow();
    state.tasks = [recall];
    await harness.controller.learnAgain();
    let screen = harness.controller.getScreen();
    expect(screen).toMatchObject({ kind: "deck", microphone: false, micDenied: true });

    await harness.controller.setMicrophone(true);
    screen = harness.controller.getScreen();
    expect(screen).toMatchObject({ kind: "deck", microphone: true, micDenied: false });
    expect(harness.storage.read(MIC_DENIED_KEY)).toBeNull();

    await harness.controller.startLearning(DECK.deckId);
    expect(state.startedSessions.at(-1)).toMatchObject({ microphoneEnabled: true });
  });

  it("odmowa mikrofonu wyłącza go dla sesji obrazkowej i pomija zamkniętą kartę", async () => {
    const state = baseState();
    state.profiles = [{ ...PROFILE_A, canRead: false }];
    state.decks = [{ ...DECK, vocabularyFormat: "picture" }];
    const task = taskDto("picture-voice", { kind: "picture_recall", visual: { kind: "number", count: 2 } });
    const next = taskDto("picture-listening", { kind: "picture_listening", audioAssetId: "audio-listening", options: [
      { id: "one", labelPl: "jeden", visual: { kind: "number", count: 1 } },
      { id: "two", labelPl: "dwa", visual: { kind: "number", count: 2 } },
    ] });
    state.tasks = [task, next];
    const harness = makeHarness(state, { failStartWith: new DOMException("Permission denied", "NotAllowedError") });
    await harness.controller.start();
    await harness.controller.selectProfile(PROFILE_A.childId);
    await harness.controller.startLearning(DECK.deckId);
    await harness.controller.startRecording();
    await harness.controller.startRecording();
    expect(harness.controller.getScreen()).toMatchObject({ kind: "learning", session: { sessionId: "55555555-5555-5555-5555-555555555555", microphoneEnabled: false }, task: { taskId: next.taskId }, micDenied: true });
    expect(state.disabledSessions).toEqual(["55555555-5555-5555-5555-555555555555"]);
    expect(state.endedSessions).toHaveLength(0);
    expect(state.speechSubmissions).toHaveLength(0);
  });

  it("brak urządzenia wyłącza mikrofon w profilu bez czytania i wraca do zadań obrazkowych", async () => {
    const state = baseState();
    state.profiles = [{ ...PROFILE_A, canRead: false }];
    state.decks = [{ ...DECK, vocabularyFormat: "picture" }];
    const task = taskDto("picture-recall-no-device", { kind: "picture_recall", visual: { kind: "number", count: 2 } });
    const next = taskDto("picture-listening-no-device", { kind: "picture_listening", audioAssetId: "audio-listening", options: [
      { id: "one", labelPl: "jeden", visual: { kind: "number", count: 1 } },
      { id: "two", labelPl: "dwa", visual: { kind: "number", count: 2 } },
    ] });
    state.tasks = [task, next];
    const harness = makeHarness(state, { failStartWith: new DOMException("Requested device not found", "NotFoundError") });
    await harness.controller.start();
    await harness.controller.selectProfile(PROFILE_A.childId);
    await harness.controller.startLearning(DECK.deckId);
    await harness.controller.prepareMicrophone();
    await harness.controller.startRecording();

    expect(state.disabledSessions).toEqual(["55555555-5555-5555-5555-555555555555"]);
    expect(harness.controller.getScreen()).toMatchObject({
      kind: "learning", session: { microphoneEnabled: false }, task: { taskId: next.taskId }, micDenied: false,
    });
    expect(harness.storage.read(MIC_DENIED_KEY)).toBeNull();
    expect(state.speechSubmissions).toHaveLength(0);
  });

  it("po awarii disable-microphone pozwala ponowić zmianę i dopiero wtedy przechodzi dalej", async () => {
    const state = baseState();
    state.profiles = [{ ...PROFILE_A, canRead: false }];
    state.decks = [{ ...DECK, vocabularyFormat: "picture" }];
    const task = taskDto("picture-voice", { kind: "picture_recall", visual: { kind: "number", count: 2 } });
    const next = taskDto("picture-listening", { kind: "picture_listening", audioAssetId: "audio-listening", options: [
      { id: "one", labelPl: "jeden", visual: { kind: "number", count: 1 } },
      { id: "two", labelPl: "dwa", visual: { kind: "number", count: 2 } },
    ] });
    state.tasks = [task, next];
    state.disableError = new TypeError("fetch failed");
    const harness = makeHarness(state, { failStartWith: new DOMException("Permission denied", "NotAllowedError") });
    await harness.controller.start();
    await harness.controller.selectProfile(PROFILE_A.childId);
    await harness.controller.startLearning(DECK.deckId);
    await harness.controller.startRecording();
    await harness.controller.startRecording();
    expect(harness.controller.getScreen()).toMatchObject({ kind: "learning", task: { taskId: task.taskId }, error: messages.errors.picture_microphone_disable_failed });

    state.disableError = undefined;
    await harness.controller.retry();
    expect(harness.controller.getScreen()).toMatchObject({
      kind: "learning",
      session: { microphoneEnabled: false },
      task: { taskId: next.taskId },
      error: null,
    });
  });

  it("ręczne wyłączenie mikrofonu na ekranie zestawów jest zapamiętywane", async () => {
    const recall = taskDto("t1", { kind: "recall", prompt: "czwartek" });
    const state = baseState();
    const harness = await startAtTask(state, recall);
    await harness.controller.answerText("Thursday");
    await harness.controller.endNow();

    await harness.controller.learnAgain();
    await harness.controller.setMicrophone(false);
    expect(harness.storage.read(MIC_DENIED_KEY)).toBe("1");
    expect(harness.controller.getScreen()).toMatchObject({
      kind: "deck",
      microphone: false,
      micDenied: true,
    });

    state.tasks = [recall];
    await harness.controller.startLearning(DECK.deckId);
    expect(state.startedSessions.at(-1)).toMatchObject({ microphoneEnabled: false });
  });

  it("opuszczenie widoku anuluje nagrywanie i zatrzymuje odtwarzanie", async () => {
    const recall = taskDto("t1", { kind: "recall", prompt: "czwartek" });
    const harness = await startAtTask(baseState(), recall);
    await harness.controller.prepareMicrophone();

    await harness.controller.startRecording();
    expect(harness.controller.getScreen()).toMatchObject({ recording: true });
    harness.controller.teardown();
    expect(harness.recorder.cancelled).toBe(1);
    expect(harness.media.stops).toBeGreaterThanOrEqual(1);
    expect(harness.controller.getScreen()).toMatchObject({ recording: false });
  });

  it("odpowiedź ustna przechodzi przez polling aż do wyniku", async () => {
    vi.useFakeTimers();
    try {
      const recall = taskDto("t1", { kind: "recall", prompt: "czwartek" });
      const state = baseState();
      state.attempts = [
        attemptDto({ state: "processing", feedback: null, taskState: "issued", modality: "audio", attemptId: "proc-1" }),
        attemptDto({ modality: "audio", feedback: { kind: "not_assessed" }, taskState: "issued" }),
      ];
      const harness = await startAtTask(state, recall);
      await harness.controller.prepareMicrophone();

      await harness.controller.startRecording();
      await vi.advanceTimersByTimeAsync(301);
      await harness.controller.stopRecording();
      expect(state.speechSubmissions).toHaveLength(1);
      const screen = harness.controller.getScreen() as { kind: string; feedback?: unknown };
      expect(screen.kind).toBe("learning");
      expect(screen).toMatchObject({ feedback: { dto: { kind: "not_assessed" } } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("wysyła jeden zamrożony raport aktywności przy końcu sesji i usuwa kopię roboczą", async () => {
    const state = baseState();
    const task = taskDto("report-task", { kind: "recall", prompt: "czwartek" });
    state.endActivityResult = { status: "evaluated", pointsAwarded: 3, errorCode: null };
    const harness = await startAtTask(state, task);
    await harness.controller.answerText("Thursday");
    await new Promise((resolve) => setTimeout(resolve, 0));
    // kopia robocza istnieje w trakcie sesji...
    expect(harness.activityDrafts.load("55555555-5555-5555-5555-555555555555")).not.toBeNull();
    await harness.controller.endNow();
    const report = harness.state.endReports[0]!;
    expect(harness.state.endReports).toHaveLength(1);
    expect(report.version).toBe(1);
    expect(report.tasks.map((entry) => entry.taskId)).toContain(task.taskId);
    expect(report.tasks[0]!.submittedAttempts).toContain("66666666-6666-6666-6666-666666666666");
    // ...i znika po potwierdzonym zapisie
    expect(harness.activityDrafts.load("55555555-5555-5555-5555-555555555555")).toBeNull();
    expect(harness.controller.getActivityResult()).toMatchObject({ status: "evaluated", pointsAwarded: 3 });
    harness.controller.teardown();
  });

  it("zachowuje kopię roboczą, gdy żądanie końca sesji straci sieć", async () => {
    const state = baseState();
    const harness = await startAtTask(state, taskDto("report-keep", { kind: "recall", prompt: "czwartek" }));
    state.endSessionError = new TypeError("fetch failed");
    await harness.controller.endNow();
    // Awaria sieci ukrywa treść i pozwala ponowić — raport nie został dostarczony.
    expect(harness.controller.getScreen()).toMatchObject({ kind: "learning", offline: true });
    expect(harness.state.endReports).toHaveLength(0);
    expect(harness.activityDrafts.load("55555555-5555-5555-5555-555555555555")).not.toBeNull();
    state.endSessionError = undefined;
    await harness.controller.retry();
    expect(harness.state.endReports).toHaveLength(1);
    expect(harness.activityDrafts.load("55555555-5555-5555-5555-555555555555")).toBeNull();
    harness.controller.teardown();
  });

  it("odzyskuje finalny raport przez nową instancję kontrolera po utracie odpowiedzi", async () => {
    const state = baseState();
    const drafts = createMemoryActivityDraftStore();
    const first = await startAtTask(state, taskDto("final-recovery", { kind: "recall", prompt: "czwartek" }), { activityDrafts: drafts });
    state.endSessionError = new TypeError("fetch failed");
    await first.controller.endNow();
    const saved = drafts.listForChild(PROFILE_A.childId)[0]!;
    expect(saved.finalPayload).toBeDefined();
    const exactPayload = saved.finalPayload;
    first.controller.teardown();

    state.endSessionError = undefined;
    const restored = makeHarness(state, { activityDrafts: drafts, initialChildId: PROFILE_A.childId });
    await restored.controller.start();
    expect(state.endReports).toHaveLength(1);
    expect(state.endReports[0]).toEqual(exactPayload);
    expect(drafts.load("55555555-5555-5555-5555-555555555555")).toBeNull();
    restored.controller.teardown();
  });

  it("odświeża deck po odzyskaniu ACK, zanim wznowi kartkówkę z pierwszego snapshotu", async () => {
    const state = baseState();
    const oldSessionId = "88888888-8888-4888-8888-888888888888";
    const activeDeck = { ...DECK, activeSession: { sessionId: oldSessionId, mode: "mock_test" as const } };
    const drafts = createMemoryActivityDraftStore();
    drafts.save({ sessionId: oldSessionId, childId: PROFILE_A.childId, savedAtMs: Date.now(), state: {
      version: 1, startedAtMs: 0, lastActivityAtMs: 0, lastEventAtMs: 0, activeStartMs: null, openPlayback: null,
      pendingPause: null, currentTaskId: null, compacted: false, incomplete: undefined, tasks: [],
    }, finalPayload: { version: 1, elapsedMs: 1, activeMs: 0, compacted: false, tasks: [] } });
    state.listDeckRequests = [];
    state.listDeckResponses = [[activeDeck], [DECK]];
    state.endActivityResult = { status: "evaluated", pointsAwarded: 1, errorCode: null };
    const harness = makeHarness(state, { activityDrafts: drafts });
    await harness.controller.start();
    await harness.controller.selectProfile(PROFILE_A.childId);
    expect(state.listDeckRequests).toHaveLength(2);
    expect(state.startedSessions).toHaveLength(0);
    expect(drafts.load(oldSessionId)).toBeNull();
    harness.controller.teardown();
  });

  it("zamienia zaakceptowany draft already_started na minimalny znacznik pending", async () => {
    const state = baseState();
    const sessionId = "88888888-8888-4888-8888-888888888888";
    const drafts = createMemoryActivityDraftStore();
    drafts.save({ sessionId, childId: PROFILE_A.childId, savedAtMs: Date.now(), state: {
      version: 1, startedAtMs: 0, lastActivityAtMs: 0, lastEventAtMs: 0, activeStartMs: null, openPlayback: null,
      pendingPause: null, currentTaskId: null, compacted: false, incomplete: undefined, tasks: [],
    }, finalPayload: { version: 1, elapsedMs: 1, activeMs: 0, compacted: false, tasks: [] } });
    state.listDeckResponses = [[DECK], [DECK], [DECK]];
    state.endActivityResult = { status: "already_started", pointsAwarded: 0, errorCode: null };
    const harness = makeHarness(state, { activityDrafts: drafts });
    await harness.controller.start();
    await harness.controller.selectProfile(PROFILE_A.childId);
    expect(drafts.load(sessionId)).toMatchObject({ version: 1, sessionId, childId: PROFILE_A.childId });
    harness.controller.teardown();
    expect(drafts.load(sessionId)).toMatchObject({ version: 1, sessionId, childId: PROFILE_A.childId });
  });

  it("prowadzi bieżący polling, gdy zapis znacznika w localStorage się nie powiedzie", async () => {
    vi.useFakeTimers();
    try {
      const state = baseState();
      state.endActivityResult = { status: "already_started", pointsAwarded: 0, errorCode: null };
      state.activityResults = [{ status: "evaluated", pointsAwarded: 4, errorCode: null }];
      const drafts = createMemoryActivityDraftStore();
      vi.spyOn(drafts, "savePendingResult").mockReturnValue(false);
      const harness = await startAtTask(state, taskDto("pending-storage-failure", { kind: "recall", prompt: "czwartek" }), { activityDrafts: drafts });

      await harness.controller.endNow();
      await vi.advanceTimersByTimeAsync(2);

      expect(state.activityResultCalls).toEqual(["55555555-5555-5555-5555-555555555555"]);
      expect(harness.controller.getActivityResult()).toMatchObject({ status: "evaluated", pointsAwarded: 4 });
    } finally { vi.useRealTimers(); }
  });

  it("wznawia polling oczekującego wyniku po ponownym uruchomieniu tego samego kontrolera", async () => {
    vi.useFakeTimers();
    try {
      const state = baseState();
      const drafts = createMemoryActivityDraftStore();
      drafts.savePendingResult({ version: 1, sessionId: "pending-remount", childId: PROFILE_A.childId, savedAtMs: Date.now() });
      state.activityResults = [{ status: "evaluated", pointsAwarded: 2, errorCode: null }];
      const { controller } = makeHarness(state, { activityDrafts: drafts });

      await controller.start();
      controller.teardown();
      await controller.start();
      await vi.advanceTimersByTimeAsync(2);

      expect(state.activityResultCalls).toEqual(["pending-remount"]);
      expect(drafts.load("pending-remount")).toBeNull();
      controller.teardown();
    } finally { vi.useRealTimers(); }
  });

  it("zachowuje znacznik do skutecznego odświeżenia punktów profilu", async () => {
    vi.useFakeTimers();
    try {
      const state = baseState();
      state.endActivityResult = { status: "already_started", pointsAwarded: 0, errorCode: null };
      state.activityResults = Array.from({ length: 10 }, () => ({ status: "evaluated" as const, pointsAwarded: 4, errorCode: null }));
      const harness = await startAtTask(state, taskDto("pending-profile-refresh", { kind: "recall", prompt: "czwartek" }));
      await harness.controller.endNow();
      state.networkDown = true;
      await vi.advanceTimersByTimeAsync(2);
      expect(harness.activityDrafts.load("55555555-5555-5555-5555-555555555555")).toMatchObject({ version: 1 });

      state.profiles = [{ ...PROFILE_A, rewardPoints: 4 }, PROFILE_B];
      state.networkDown = false;
      await vi.advanceTimersByTimeAsync(10);

      expect(state.activityResultCalls.length).toBeGreaterThanOrEqual(2);
      expect(harness.activityDrafts.load("55555555-5555-5555-5555-555555555555")).toBeNull();
      expect(harness.controller.getScreen()).toMatchObject({ kind: "summary", profiles: expect.arrayContaining([expect.objectContaining({ childId: PROFILE_A.childId, rewardPoints: 4 })]) });
    } finally { vi.useRealTimers(); }
  });

  it("pokazuje pending od razu, a polling przeżywa zmianę profilu i odświeża właściciela sesji", async () => {
    vi.useFakeTimers();
    try {
      const state = baseState();
      state.endActivityResult = { status: "already_started", pointsAwarded: 0, errorCode: null };
      state.activityResults = [new TypeError("fetch failed"), { status: "evaluated", pointsAwarded: 4, errorCode: null }];
      const harness = await startAtTask(state, taskDto("pending-result", { kind: "recall", prompt: "czwartek" }));

      await harness.controller.endNow();
      expect(harness.controller.getScreen()).toMatchObject({ kind: "summary", summary: { activity: { status: "already_started" } } });
      expect(harness.activityDrafts.load("55555555-5555-5555-5555-555555555555")).toEqual({
        version: 1, sessionId: "55555555-5555-5555-5555-555555555555", childId: PROFILE_A.childId, savedAtMs: expect.any(Number),
      });

      await harness.controller.switchProfile();
      await harness.controller.selectProfile(PROFILE_B.childId);
      state.profiles = [{ ...PROFILE_A, rewardPoints: 4 }, PROFILE_B];
      await vi.advanceTimersByTimeAsync(2);
      await vi.advanceTimersByTimeAsync(2);

      expect(state.activityResultCalls).toEqual(["55555555-5555-5555-5555-555555555555", "55555555-5555-5555-5555-555555555555"]);
      expect(harness.activityDrafts.load("55555555-5555-5555-5555-555555555555")).toBeNull();
    const screen = harness.controller.getScreen();
    expect(screen).toMatchObject({ kind: "deck", childId: PROFILE_B.childId });
    expect(screen.kind === "deck" && screen.profiles.find(profile => profile.childId === PROFILE_A.childId)?.rewardPoints).toBe(4);
    } finally { vi.useRealTimers(); }
  });

  it("resumes a persisted pending result after reload without sending the report again", async () => {
    vi.useFakeTimers();
    try {
      const state = baseState();
      const drafts = createMemoryActivityDraftStore();
      drafts.savePendingResult({ version: 1, sessionId: "pending-reload", childId: PROFILE_A.childId, savedAtMs: Date.now() });
      state.activityResults = [{ status: "error", pointsAwarded: 0, errorCode: "review_failed" }];
      const restored = makeHarness(state, { activityDrafts: drafts, initialChildId: PROFILE_B.childId });

      await restored.controller.start();
      await vi.advanceTimersByTimeAsync(2);

      expect(state.activityResultCalls).toEqual(["pending-reload"]);
      expect(state.endReports).toEqual([]);
      expect(drafts.load("pending-reload")).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("usuwa trwały znacznik po nieponawialnym błędzie API wyniku", async () => {
    vi.useFakeTimers();
    try {
      const state = baseState();
      const drafts = createMemoryActivityDraftStore();
      drafts.savePendingResult({ version: 1, sessionId: "pending-deleted-session", childId: PROFILE_A.childId, savedAtMs: Date.now() });
      state.activityResults = [new KidApiError("not_found", false)];
      const { controller } = makeHarness(state, { activityDrafts: drafts });

      await controller.start();
      await vi.advanceTimersByTimeAsync(2);
      await vi.advanceTimersByTimeAsync(10);

      expect(state.activityResultCalls).toEqual(["pending-deleted-session"]);
      expect(drafts.load("pending-deleted-session")).toBeNull();
      controller.teardown();
    } finally { vi.useRealTimers(); }
  });

  it("zachowuje znacznik po błędach internal i ponawia odczyt z rosnącym odstępem", async () => {
    vi.useFakeTimers();
    try {
      const state = baseState();
      const drafts = createMemoryActivityDraftStore();
      drafts.savePendingResult({ version: 1, sessionId: "pending-transient-error", childId: PROFILE_A.childId, savedAtMs: Date.now() });
      state.activityResults = [
        new TypeError("fetch failed"),
        new KidApiError("internal", false),
        { status: "evaluated", pointsAwarded: 2, errorCode: null },
      ];
      const harness = makeHarness(state, { activityDrafts: drafts });
      await harness.controller.start();

      await vi.advanceTimersByTimeAsync(1);
      expect(state.activityResultCalls).toHaveLength(1);
      expect(drafts.load("pending-transient-error")).not.toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(state.activityResultCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(state.activityResultCalls).toHaveLength(2);
      expect(drafts.load("pending-transient-error")).not.toBeNull();
      await vi.advanceTimersByTimeAsync(3);
      expect(state.activityResultCalls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);

      expect(state.activityResultCalls).toHaveLength(3);
      expect(drafts.load("pending-transient-error")).toBeNull();
      harness.controller.teardown();
    } finally { vi.useRealTimers(); }
  });

  it("sprawdza already_started ze stałym interwałem, bez opóźniania końcowego wyniku", async () => {
    vi.useFakeTimers();
    try {
      const state = baseState();
      const drafts = createMemoryActivityDraftStore();
      drafts.savePendingResult({ version: 1, sessionId: "pending-long-review", childId: PROFILE_A.childId, savedAtMs: Date.now() });
      state.activityResults = [
        { status: "already_started", pointsAwarded: 0, errorCode: null },
        { status: "already_started", pointsAwarded: 0, errorCode: null },
        { status: "evaluated", pointsAwarded: 3, errorCode: null },
      ];
      const harness = makeHarness(state, { activityDrafts: drafts });
      await harness.controller.start();

      await vi.advanceTimersByTimeAsync(1);
      expect(state.activityResultCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(state.activityResultCalls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);

      expect(state.activityResultCalls).toHaveLength(3);
      expect(drafts.load("pending-long-review")).toBeNull();
      harness.controller.teardown();
    } finally { vi.useRealTimers(); }
  });

  it("zeruje backoff po teardown, aby ponowne uruchomienie wznowiło szybki polling", async () => {
    vi.useFakeTimers();
    try {
      const state = baseState();
      const drafts = createMemoryActivityDraftStore();
      drafts.savePendingResult({ version: 1, sessionId: "pending-remount-backoff", childId: PROFILE_A.childId, savedAtMs: Date.now() });
      state.activityResults = [new TypeError("fetch failed"), { status: "evaluated", pointsAwarded: 1, errorCode: null }];
      const harness = makeHarness(state, { activityDrafts: drafts });
      await harness.controller.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(state.activityResultCalls).toHaveLength(1);

      harness.controller.teardown();
      await harness.controller.start();
      await vi.advanceTimersByTimeAsync(1);

      expect(state.activityResultCalls).toHaveLength(2);
      expect(drafts.load("pending-remount-backoff")).toBeNull();
      harness.controller.teardown();
    } finally { vi.useRealTimers(); }
  });

  it("wznawia polling po teardown, nawet gdy odczyt poprzedniej generacji nadal trwa", async () => {
    vi.useFakeTimers();
    let finishOldRead!: (value: import("@learning/contracts").SessionActivityResultDto) => void;
    try {
      const state = baseState();
      const drafts = createMemoryActivityDraftStore();
      drafts.savePendingResult({ version: 1, sessionId: "pending-inflight-remount", childId: PROFILE_A.childId, savedAtMs: Date.now() });
      const baseApi = makeApi(state);
      const api: KidApi = {
        ...baseApi,
        async readSessionActivityResult(sessionId) {
          state.activityResultCalls.push(sessionId);
          if (state.activityResultCalls.length === 1) return new Promise((resolve) => { finishOldRead = resolve; });
          return { status: "evaluated", pointsAwarded: 2, errorCode: null };
        },
      };
      const harness = makeHarness(state, { api, activityDrafts: drafts });
      await harness.controller.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(state.activityResultCalls).toHaveLength(1);

      harness.controller.teardown();
      await harness.controller.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(state.activityResultCalls).toHaveLength(2);

      finishOldRead({ status: "already_started", pointsAwarded: 0, errorCode: null });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
      expect(state.activityResultCalls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(drafts.load("pending-inflight-remount")).toBeNull();
      harness.controller.teardown();
    } finally { vi.useRealTimers(); }
  });

  it("nie dołącza raportu, gdy sesja zakończyła się przed pierwszym zadaniem", async () => {
    const state = baseState();
    state.tasks = [];
    const harness = makeHarness(state);
    await harness.controller.start();
    await harness.controller.selectProfile(state.profiles[0]!.childId);
    await harness.controller.startLearning(DECK.deckId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.controller.getScreen()).toMatchObject({ kind: "summary" });
    expect(harness.state.endReports).toHaveLength(0);
    expect(harness.controller.getActivityResult()).toBeNull();
    harness.controller.teardown();
  });

  it("release przed 300 ms nie wysyła odpowiedzi i pokazuje neutralną wskazówkę", async () => {
    const recall = taskDto("t1", { kind: "recall", prompt: "czwartek" });
    const harness = await startAtTask(baseState(), recall);
    await harness.controller.prepareMicrophone();
    expect(harness.controller.getScreen()).toMatchObject({ microphoneReady: true, recordingPhase: "idle" });
    await harness.controller.startRecording();
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "recording", recording: true });
    await harness.controller.stopRecording();
    expect(harness.state.speechSubmissions).toHaveLength(0);
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "idle", recordingNotice: expect.any(String) });
    expect(harness.recorder.cancelled).toBe(1);
  });

  it("anuluje intent startu, gdy rejestrator odpowie po puszczeniu", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const recall = taskDto("t1", { kind: "recall", prompt: "czwartek" });
    const harness = await startAtTask(baseState(), recall, { startGate });
    await harness.controller.prepareMicrophone();
    const starting = harness.controller.startRecording();
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "starting" });
    harness.controller.cancelRecording();
    releaseStart();
    await starting;
    expect(harness.recorder.cancelled).toBe(1);
    expect(harness.state.speechSubmissions).toHaveLength(0);
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "idle", recording: false });
  });

  it("po 300 ms stop wysyła dokładnie jedną odpowiedź ustną", async () => {
    vi.useFakeTimers();
    try {
      const recall = taskDto("t1", { kind: "recall", prompt: "czwartek" });
      const harness = await startAtTask(baseState(), recall);
      await harness.controller.prepareMicrophone();

    await harness.controller.startRecording();
      await vi.advanceTimersByTimeAsync(300);
      await harness.controller.stopRecording();
      expect(harness.state.speechSubmissions).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses each selected profile mode and ignores the legacy local preference", async () => {
    const staleStorage = createMemoryPreferences({ "umiem.recordingMode": "toggle" });
    const state = baseState();
    state.tasks = [taskDto("hold", { kind: "speech", text: "apple", visualType: "none", imageAssetId: null, audioAssetId: null })];
    const harness = makeHarness(state, { initialChildId: PROFILE_A.childId, storage: staleStorage });

    await harness.controller.start();
    await harness.controller.startLearning(DECK.deckId);
    expect(harness.controller.getScreen()).toMatchObject({ kind: "learning", session: { childId: PROFILE_A.childId }, recordingMode: "hold" });

    await harness.controller.backToDecks();
    await harness.controller.selectProfile(PROFILE_B.childId);
    state.tasks = [taskDto("toggle", { kind: "speech", text: "apple", visualType: "none", imageAssetId: null, audioAssetId: null })];
    await harness.controller.startLearning(DECK.deckId);
    expect(harness.controller.getScreen()).toMatchObject({ kind: "learning", session: { childId: PROFILE_B.childId }, recordingMode: "toggle" });
    expect(staleStorage.read("umiem.recordingMode")).toBe("toggle");
  });

  it("„Nie pamiętam” ujawnia słowo po zgody serwera i wysyła trudność", async () => {
    const recall = taskDto("t1", { kind: "recall", prompt: "czwartek" });
    const state = baseState();
    const harness = await startAtTask(state, recall);
    await harness.controller.notRemember();
    expect(state.disclosures).toEqual([{ taskId: "t1", kind: "hint" }]);
    expect(harness.controller.getScreen()).toMatchObject({ reveal: { target: "Thursday" } });
    state.tasks = [taskDto("support", { kind: "exposure", source: "czwartek", target: "Thursday", example: null, exampleAudioAssetId: null, audioAssetId: null, visualType: "none", imageAssetId: null })];
    state.attempts = [attemptDto({ taskId: "t1", modality: "dont_remember", taskState: "answered", feedback: { kind: "incorrect", correctText: "Thursday" } })];
    await harness.controller.confirmReveal();
    expect(state.submissions[0]).toMatchObject({ modality: "dont_remember" });
    expect(harness.controller.getScreen()).toMatchObject({ task: { taskId: "support" }, reveal: null, feedback: null, busy: false });
  });

  it("zachowuje ujawnione słowo podczas pobierania następnego zadania", async () => {
    const state = baseState();
    const harness = await startAtTask(state, taskDto("t1", { kind: "recall", prompt: "czwartek" }));
    await harness.controller.notRemember();
    let releaseNext!: () => void;
    state.nextTaskGate = new Promise<void>((resolve) => { releaseNext = resolve; });
    state.tasks = [taskDto("next", { kind: "recall", prompt: "piątek" })];
    state.attempts = [attemptDto({ taskId: "t1", modality: "dont_remember", taskState: "answered" })];
    const confirming = harness.controller.confirmReveal();
    await vi.waitFor(() => expect(state.nextTaskCalls).toBe(2));
    expect(harness.controller.getScreen()).toMatchObject({ reveal: { target: "Thursday" }, busy: true, feedback: null });
    releaseNext();
    await confirming;
    expect(harness.controller.getScreen()).toMatchObject({ task: { taskId: "next" }, reveal: null, busy: false });
  });

  it("ponawia zapis trudności po utracie sieci i przechodzi bez powtórnego feedbacku", async () => {
    const state = baseState();
    const harness = await startAtTask(state, taskDto("t1", { kind: "recall", prompt: "czwartek" }));
    await harness.controller.notRemember();
    state.networkDown = true;
    await harness.controller.confirmReveal();
    expect(harness.controller.getScreen()).toMatchObject({ offline: true });
    state.networkDown = false;
    state.tasks = [taskDto("retry-recall", { kind: "recall", prompt: "czwartek" })];
    state.attempts = [attemptDto({ taskId: "t1", modality: "dont_remember", taskState: "answered" })];
    await harness.controller.retry();
    expect(harness.controller.getScreen()).toMatchObject({ task: { taskId: "retry-recall" }, reveal: null, feedback: null, busy: false, offline: false });
    await harness.controller.answerText("Thursday");
    expect(state.submissions).toMatchObject([{ taskId: "t1", modality: "dont_remember" }, { taskId: "retry-recall", modality: "text" }]);
  });

  it("po błędzie i ponowieniu podpowiedzi usuwa stan przejścia po ujawnieniu", async () => {
    const state = baseState();
    state.disclosureError = new TypeError("fetch failed");
    const harness = await startAtTask(state, taskDto("hint-retry", { kind: "recall", prompt: "czwartek" }));
    await harness.controller.notRemember();
    state.disclosureError = undefined;
    await harness.controller.retry();
    expect(harness.controller.getScreen()).toMatchObject({
      kind: "learning", reveal: { target: "Thursday" }, busy: false, transitioning: false,
    });
  });

  it("ujawnia wizualizację dla obrazkowego przypomnienia i przed dźwiękiem ponownie autoryzuje ekspozycję", async () => {
    const recall = taskDto("picture-recall", { kind: "picture_recall", visual: { kind: "color", color: "#ff0000" } });
    const harness = await startAtTask(baseState(), recall);
    await harness.controller.notRemember();
    expect(harness.controller.getScreen()).toMatchObject({ reveal: { visual: { kind: "color", color: "#ff0000" }, audioAssetId: expect.any(String) } });
    await harness.controller.playRevealAudio();
    expect(harness.state.disclosures.map((d) => d.kind)).toEqual(["hint", "audio"]);
    expect(harness.media.playUrls).toEqual(["https://media.test/88888888-8888-4888-8888-888888888888"]);
  });

  it("po przeładowaniu poluje na oczekującą próbę zamiast pozwolić nagrać drugi raz", async () => {
    const pendingTask = { ...taskDto("pending-task", { kind: "picture_recall", visual: { kind: "number", count: 3 } }), pendingAttemptId: "66666666-6666-4666-8666-666666666666" };
    const state = baseState();
    state.tasks = [pendingTask];
    state.attempts = [attemptDto({ taskId: pendingTask.taskId, attemptId: pendingTask.pendingAttemptId, modality: "audio" })];
    let releaseAttempt!: () => void;
    state.readAttemptGate = new Promise<void>((resolve) => { releaseAttempt = resolve; });
    const harness = makeHarness(state);
    await harness.controller.start();
    await harness.controller.selectProfile(PROFILE_A.childId);
    const starting = harness.controller.startLearning(DECK.deckId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.controller.getScreen()).toMatchObject({ kind: "learning", processing: true, busy: true });
    const pendingDraft = harness.activityDrafts.load("55555555-5555-5555-5555-555555555555");
    expect(pendingDraft && "state" in pendingDraft && pendingDraft.state.pendingPause?.kind).toBe("technical_wait");
    releaseAttempt();
    await starting;
    expect(harness.controller.getScreen()).toMatchObject({ kind: "learning", feedback: { attemptId: pendingTask.pendingAttemptId }, busy: false, processing: false });
    expect(state.speechSubmissions).toHaveLength(0);
    expect(state.submissions).toHaveLength(0);
  });

  it("pytanie słuchowe odtwarza się samo po wyświetleniu (SPEC §12.2)", async () => {
    const listening = taskDto("t1", { kind: "listening", options: [], audioAssetId: "asset-q" });
    const listenHarness = await startAtTask(baseState(), listening);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listenHarness.media.playUrls).toEqual(["https://media.test/asset-q"]);

    // zadanie tekstowe nie ma audio — nic nie gra samo z siebie
    const reading = taskDto("t2", { kind: "reading", text: "Thursday", options: [] });
    const readHarness = await startAtTask(baseState(), reading);
    expect(readHarness.media.playUrls).toEqual([]);
  });

  it("przycisk przykładu odtwarza audio zdania bez zgody serwera (SPEC §22)", async () => {
    const exposure = taskDto("t1", {
      kind: "exposure",
      source: "czereśnia",
      target: "cherry",
      example: "Cherries are perfect for making pie.",
      audioAssetId: "asset-word",
      exampleAudioAssetId: "asset-example",
      imageAssetId: null,
      visualType: "none",
    });
    const harness = await startAtTask(baseState(), exposure);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.controller.playExampleAudio();
    // prezentacja sama odtwarza słowo; przycisk dokładuje zdanie przykładowe
    expect(harness.media.playUrls).toEqual(["https://media.test/asset-word", "https://media.test/asset-example"]);
    expect(harness.state.disclosures).toHaveLength(0);
  });

  it("wzorzec w recall wymaga zgody serwera; pytanie słuchowe nie", async () => {
    const recall = taskDto("t1", { kind: "recall", prompt: "czwartek" });
    const recallHarness = await startAtTask(baseState(), recall);
    await recallHarness.controller.playTaskAudio();
    // recall nie ma audioAssetId w prompcie — brak odtworzenia i zgody
    expect(recallHarness.state.disclosures).toHaveLength(0);

    const listening = taskDto("t2", { kind: "listening", options: [], audioAssetId: "asset-1" });
    const listenHarness = await startAtTask(baseState(), listening);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // pytanie słuchowe odtwarza się już samo po wyświetleniu (SPEC §12.2)
    expect(listenHarness.media.playUrls).toEqual(["https://media.test/asset-1"]);
    await listenHarness.controller.playTaskAudio();
    expect(listenHarness.state.disclosures).toHaveLength(0);

    const speech = taskDto("t3", { kind: "speech", text: "Thursday", audioAssetId: "asset-2", imageAssetId: null, visualType: "none" });
    const speechHarness = await startAtTask(baseState(), speech);
    await speechHarness.controller.playTaskAudio();
    expect(speechHarness.state.disclosures).toEqual([{ taskId: "t3", kind: "audio" }]);
    expect(speechHarness.media.playUrls).toEqual(["https://media.test/asset-2"]);
  });

  it("pokazuje błąd sieci przy autoryzacji wzorca picture Recall i ponawia playback", async () => {
    const state = baseState();
    const recall = taskDto("picture-audio-offline", { kind: "picture_recall", visual: { kind: "color", color: "#ff0000" } });
    state.disclosureError = new TypeError("fetch failed");
    const harness = await startAtTask(state, recall);

    await harness.controller.playTaskAudio();
    expect(harness.controller.getScreen()).toMatchObject({ kind: "learning", offline: true, error: null });
    expect(harness.media.playUrls).toEqual([]);

    state.disclosureError = new KidApiError("conflict", false);
    await harness.controller.retry();
    expect(harness.controller.getScreen()).toMatchObject({ kind: "learning", busy: false, transitioning: false });

    state.disclosureError = undefined;
    await harness.controller.retry();
    expect(state.disclosures).toHaveLength(3);
    expect(harness.media.playUrls).toHaveLength(1);
    expect(harness.controller.getScreen()).toMatchObject({ kind: "learning", offline: false, busy: false, transitioning: false });

    state.disclosureError = new TypeError("fetch failed");
    harness.controller.markOffline();
    await harness.controller.retry();
    expect(harness.controller.getScreen()).toMatchObject({ kind: "learning", offline: true, busy: false, transitioning: false });
    state.disclosureError = undefined;
    await harness.controller.retry();
    expect(harness.controller.getScreen()).toMatchObject({ kind: "learning", offline: false, busy: false, transitioning: false });
  });

  it("autoryzuje odsłuch picture Recall tylko raz", async () => {
    const state = baseState();
    const recall = { ...taskDto("picture-recall-audio", { kind: "picture_recall", visual: { kind: "color", color: "#ff0000" } }), exerciseType: "recall" as const };
    const harness = await startAtTask(state, recall);

    await harness.controller.playTaskAudio();

    expect(state.disclosures).toEqual([{ taskId: recall.taskId, kind: "audio" }]);
    expect(harness.media.playUrls).toHaveLength(1);
  });

  it("odsłuch lekcji tekstowej wymaga zgody serwera PRZED odtworzeniem (wsparcie wym. 4.6)", async () => {
    const gap = taskDto("tg", { kind: "lesson_gap", instructionPl: "Uzupełnij", stemWithGap: "He ___ (go).", audioAssetId: "asset-gap" });
    const gapHarness = await startAtTask(baseState(), gap);
    // lekcja tekstowa NIE odtwarza się sama — dopiero „Posłuchaj”
    expect(gapHarness.media.playUrls).toEqual([]);
    await gapHarness.controller.playTaskAudio();
    expect(gapHarness.state.disclosures).toEqual([{ taskId: "tg", kind: "audio" }]);
    expect(gapHarness.media.playUrls).toEqual(["https://media.test/asset-gap"]);

    // Typ zamknięty bez audioAssetId: żadnego odtworzenia ani zgody.
    const choice = taskDto("tc", { kind: "lesson_choice", instructionPl: "Wybierz", stem: "He ___.", options: [{ id: "o1", text: "goes" }] });
    const choiceHarness = await startAtTask(baseState(), choice);
    await choiceHarness.controller.playTaskAudio();
    expect(choiceHarness.state.disclosures).toHaveLength(0);
    expect(choiceHarness.media.playUrls).toEqual([]);
  });

  it("„Posłuchaj pytania” odtwarza nagranie bez zgody serwera i nie gra samo (design szkoły §11.3)", async () => {
    const choice = taskDto("tq", { kind: "lesson_choice", instructionPl: "Wybierz", stem: "Ile nóg ma pająk?", options: [{ id: "o1", text: "osiem" }], questionAudioAssetId: "asset-question" });
    const harness = await startAtTask(baseState(), choice);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.media.playUrls).toEqual([]);
    await harness.controller.playQuestionAudio();
    expect(harness.media.playUrls).toEqual(["https://media.test/asset-question"]);
    expect(harness.state.disclosures).toHaveLength(0);
    // „Posłuchaj” odpowiedzi nie dotyczy nagrania pytania
    await harness.controller.playTaskAudio();
    expect(harness.media.playUrls).toEqual(["https://media.test/asset-question"]);
  });

  it("błąd odtwarzania pytania trafia do stanu ekranu, a nowa próba go czyści", async () => {
    const choice = taskDto("tq", { kind: "lesson_choice", instructionPl: "Wybierz", stem: "Ile nóg ma pająk?", options: [{ id: "o1", text: "osiem" }], questionAudioAssetId: "asset-question" });
    const harness = await startAtTask(baseState(), choice, { failPlaybackBeforeStart: true });
    await harness.controller.playQuestionAudio();
    expect(harness.controller.getScreen()).toMatchObject({ questionAudioError: true, offline: false });
    harness.media.failPlayback = false;
    await harness.controller.playQuestionAudio();
    expect(harness.controller.getScreen()).toMatchObject({ questionAudioError: false });
    expect(harness.media.playUrls).toEqual(["https://media.test/asset-question", "https://media.test/asset-question"]);
  });

  it("komunikat błędu odsłuchu pytania znika po wysłaniu odpowiedzi", async () => {
    const choice = taskDto("tq", { kind: "lesson_choice", instructionPl: "Wybierz", stem: "Ile nóg ma pająk?", options: [{ id: "o1", text: "osiem" }], questionAudioAssetId: "asset-question" });
    const state = baseState();
    const harness = await startAtTask(state, choice, { failPlaybackBeforeStart: true });
    await harness.controller.playQuestionAudio();
    expect(harness.controller.getScreen()).toMatchObject({ questionAudioError: true });
    state.attempts = [attemptDto({ taskId: "tq", modality: "choice", taskState: "issued", feedback: { kind: "incorrect", correctText: "osiem" } })];
    await harness.controller.answerChoice("o1");
    expect(harness.controller.getScreen()).toMatchObject({ questionAudioError: false });
  });

  it("„Posłuchaj karty” odtwarza nagranie karty bez zgody serwera, a „Dalej” je zatrzymuje (design szkoły §12.4)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const card = taskDto("tcard", { kind: "lesson_card", card: { title: "Pająki", body: "Pająk ma osiem nóg.", examples: [] }, questionAudioAssetId: "asset-card" });
    const harness = await startAtTask(baseState(), card, { playGate: gate });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.media.playUrls).toEqual([]);
    const playing = harness.controller.playQuestionAudio();
    expect(harness.media.playUrls).toEqual(["https://media.test/asset-card"]);
    expect(harness.state.disclosures).toHaveLength(0);
    // Zatrzymanie musi nastąpić przed `complete-presentation` — wstrzymane API
    // wyklucza późniejsze zatrzymanie przy ładowaniu następnego zadania.
    let releaseCompletion!: () => void;
    const completionGate = new Promise<void>((resolve) => { releaseCompletion = resolve; });
    const completion = vi.spyOn(harness.api, "completePresentation").mockImplementation(async (taskId) => {
      await completionGate;
      return makeApi(harness.state).completePresentation(taskId);
    });
    const stopsBefore = harness.media.stops;
    const advancing = harness.controller.completePresentation();
    expect(completion).toHaveBeenCalledOnce();
    expect(harness.media.stops).toBeGreaterThan(stopsBefore);
    releaseCompletion();
    await advancing;
    release();
    await playing;
  });

  it("„Nie pamiętam” zatrzymuje trwający odsłuch pytania", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gap = taskDto("tq", { kind: "lesson_gap", instructionPl: "Uzupełnij", stemWithGap: "Pająk ma ___ nóg.", questionAudioAssetId: "asset-question" });
    const harness = await startAtTask(baseState(), gap, { playGate: gate });
    const playing = harness.controller.playQuestionAudio();
    const stopsBefore = harness.media.stops;
    await harness.controller.notRemember();
    expect(harness.media.stops).toBeGreaterThan(stopsBefore);
    release();
    await playing;
  });

  it("feedback wyboru pamięta wybraną opcję także przez awarię sieci i retry", async () => {
    const chosen = "88888888-8888-8888-8888-888888888888";
    const listening = taskDto("t1", {
      kind: "listening",
      options: [{ id: chosen, text: "czwartek" }],
      audioAssetId: "99999999-9999-9999-9999-999999999999",
    });
    const state = baseState();
    const harness = await startAtTask(state, listening);

    state.networkDown = true;
    await harness.controller.answerChoice(chosen);
    expect(harness.controller.getScreen()).toMatchObject({ offline: true, feedback: null });

    state.networkDown = false;
    state.attempts = [attemptDto({
      modality: "choice",
      feedback: { kind: "incorrect", correctText: "czwartek" },
      taskState: "issued",
    })];
    await harness.controller.retry();
    expect(harness.controller.getScreen()).toMatchObject({
      feedback: { dto: { kind: "incorrect" }, retry: true, chosenOptionId: chosen },
    });

    // druga próba zaczyna bez podświetlenia; poprawny wybór znów je zapamiętuje
    await harness.controller.continueLearning();
    expect(harness.controller.getScreen()).toMatchObject({ feedback: null });
    state.attempts = [attemptDto({ modality: "choice", feedback: { kind: "great" }, taskState: "completed" })];
    await harness.controller.answerChoice(chosen);
    expect(harness.controller.getScreen()).toMatchObject({
      feedback: { dto: { kind: "great" }, retry: false, chosenOptionId: chosen },
    });
  });

  it("feedback próby innej niż wybór nie niesie wybranej opcji", async () => {
    const recall = taskDto("t1", { kind: "recall", prompt: "czwartek" });
    const harness = await startAtTask(baseState(), recall);
    await harness.controller.answerText("Thursday");
    const screen = harness.controller.getScreen() as {
      feedback: { dto: FeedbackDto | null; retry: boolean; chosenOptionId?: string } | null;
    };
    expect(screen.feedback?.dto).toMatchObject({ kind: "great" });
    expect(screen.feedback?.chosenOptionId).toBeUndefined();
  });

  it("próba wymowy w nowej sesji nie dziedziczy wybranej opcji po awarii", async () => {
    const chosen = "88888888-8888-8888-8888-888888888888";
    const listening = taskDto("t1", {
      kind: "listening",
      options: [{ id: chosen, text: "czwartek" }],
      audioAssetId: "99999999-9999-9999-9999-999999999999",
    });
    const state = baseState();
    const harness = await startAtTask(state, listening);

    // wybór rozbija się o brak sieci; „Koniec" domyka sesję z wiszącym wyborem
    state.networkDown = true;
    await harness.controller.answerChoice(chosen);
    expect(harness.controller.getScreen()).toMatchObject({ offline: true });
    state.networkDown = false;
    await harness.controller.endNow();
    expect(harness.controller.getScreen()).toMatchObject({ kind: "summary" });

    // nowa sesja zaczyna od odpowiedzi ustnej — feedback wymowy pełny,
    // bez dziedziczenia chosenOptionId (pasek wyboru nie zjada heardText)
    state.tasks = [taskDto("t2", { kind: "recall", prompt: "czwartek" })];
    state.attempts = [attemptDto({ modality: "audio", feedback: { kind: "not_assessed" }, taskState: "issued" })];
    await harness.controller.learnAgain();
    await harness.controller.startLearning(DECK.deckId);
    await harness.controller.prepareMicrophone();
    vi.useFakeTimers();
    try {
      await harness.controller.startRecording();
      await vi.advanceTimersByTimeAsync(301);
      await harness.controller.stopRecording();
      const screen = harness.controller.getScreen() as {
        feedback: { dto: FeedbackDto | null; chosenOptionId?: string } | null;
      };
      expect(screen.feedback?.dto).toMatchObject({ kind: "not_assessed" });
      expect(screen.feedback?.chosenOptionId).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("druga próba po błędzie zostaje na zadaniu, a koniec nie dokładuje zadań", async () => {
    const recall = taskDto("t1", { kind: "recall", prompt: "czwartek" });
    const state = baseState();
    state.attempts = [attemptDto({ feedback: { kind: "incorrect", correctText: "Thursday" }, taskState: "issued" })];
    const harness = await startAtTask(state, recall);
    await harness.controller.answerText("Tusday");
    expect(harness.controller.getScreen()).toMatchObject({ feedback: { retry: true } });
    await harness.controller.continueLearning();
    const afterRetry = harness.controller.getScreen();
    expect(afterRetry).toMatchObject({ kind: "learning", feedback: null, task: { taskId: "t1" } });

    // koniec: endSession raz, bez kolejnych zadań
    state.tasks = [];
    state.attempts = [];
    await harness.controller.answerText("Thursday");
    await harness.controller.continueLearning();
    expect(harness.controller.getScreen()).toMatchObject({ kind: "summary" });
    expect(state.endedSessions).toHaveLength(1);
  });

  it("po zakończonej próbie pobiera następne zadanie i jego obrazy w tle, jeszcze przy feedbacku", async () => {
    const optionA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const optionB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const first = taskDto("t1", {
      kind: "picture_listening",
      audioAssetId: "99999999-9999-9999-9999-999999999999",
      options: [
        { id: optionA, labelPl: "kot", visual: { kind: "image", imageAssetId: "11111111-1111-4111-8111-111111111111" } },
        { id: optionB, labelPl: "pies", visual: { kind: "image", imageAssetId: "22222222-2222-4222-8222-222222222222" } },
      ],
    });
    const second = taskDto("t2", {
      kind: "picture_recognition",
      visual: { kind: "image", imageAssetId: "33333333-3333-4333-8333-333333333333" },
      source: "kot",
      options: [{ id: optionA, text: "cat" }, { id: optionB, text: "dog" }],
    });
    const state = baseState();
    const harness = await startAtTask(state, first);
    state.tasks = [second];
    state.attempts = [attemptDto({ modality: "choice", feedback: { kind: "great" }, taskState: "answered" })];
    const callsBefore = state.nextTaskCalls ?? 0;

    await harness.controller.answerChoice(optionA);
    expect(harness.controller.getScreen()).toMatchObject({ feedback: { dto: { kind: "great" }, retry: false } });
    // prefetch dzieje się przy widocznym feedbacku, bez kliknięcia „Dalej”
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.nextTaskCalls).toBe(callsBefore + 1);
    expect(harness.media.preloadedImages).toEqual(["https://media.test/33333333-3333-4333-8333-333333333333"]);

    // „Dalej” używa pobranego zadania — bez drugiego żądania do serwera
    await harness.controller.continueLearning();
    expect(state.nextTaskCalls).toBe(callsBefore + 1);
    expect(harness.controller.getScreen()).toMatchObject({ kind: "learning", feedback: null, task: { taskId: "t2" } });
  });

  it("nie pobiera następnego zadania przy feedbacku mowy z odsłuchem wzorca", async () => {
    // #showResult rozstrzyga o prefetachu po samym feedbacku próby; próba
    // z referenceAudioAvailable musi zostać najnowszym zadaniem sesji, bo
    // serwer tylko dla niego autoryzuje odsłuch wzorca (feedback-audio).
    const recall = taskDto("t1", { kind: "recall", prompt: "czwartek" });
    const state = baseState();
    state.attempts = [attemptDto({ modality: "audio", taskState: "answered", feedback: { kind: "great", referenceAudioAvailable: true } })];
    const harness = await startAtTask(state, recall);
    const callsBefore = state.nextTaskCalls ?? 0;
    await harness.controller.answerText("Thursday");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.controller.getScreen()).toMatchObject({ feedback: { dto: { kind: "great" }, retry: false } });
    expect(state.nextTaskCalls).toBe(callsBefore);
  });

  it("nie pobiera następnego zadania, gdy próba ma drugie podejście", async () => {
    const recall = taskDto("t1", { kind: "recall", prompt: "czwartek" });
    const state = baseState();
    state.attempts = [attemptDto({ feedback: { kind: "incorrect", correctText: "Thursday" }, taskState: "issued" })];
    const harness = await startAtTask(state, recall);
    const callsBefore = state.nextTaskCalls ?? 0;
    await harness.controller.answerText("Tusday");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.controller.getScreen()).toMatchObject({ feedback: { retry: true } });
    expect(state.nextTaskCalls).toBe(callsBefore);
  });
});

describe("LearningSessionController — automatyczna próba mowy z VAD (quick 261021-lsw)", () => {
  const speechTask = () => taskDto("auto-speech", { kind: "speech", text: "apple", visualType: "none", imageAssetId: null, audioAssetId: null });

  it.each([false, true])("ręczna zgoda po blur zachowuje wynik (odmowa: %s)", async (denied) => {
    const harness = await startAtTask(baseState(), speechTask());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    harness.media.prepareMicrophone = async () => {
      await gate;
      if (denied) throw new DOMException("Permission denied", "NotAllowedError");
    };
    const preparation = harness.controller.prepareMicrophone();
    harness.controller.cancelRecording();
    release();
    await preparation;
    expect(harness.controller.getScreen()).toMatchObject({ microphoneReady: !denied, micDenied: denied, recordingPhase: "idle" });
    expect(harness.recorder.started).toBe(0);
    harness.controller.teardown();
  });

  it("awaria automatycznej sondy urządzenia nie wyłącza sesji obrazkowej ani nie pomija zadania", async () => {
    const state = baseState();
    state.profiles = [{ ...PROFILE_A, canRead: false }];
    state.decks = [{ ...DECK, vocabularyFormat: "picture" }];
    const task = taskDto("auto-device-error", { kind: "picture_speech", audioAssetId: "pattern", visual: { kind: "color", color: "#ff0000" } });
    const harness = await startAtTask(state, task);
    harness.media.prepareMicrophone = async () => { throw new DOMException("Device missing", "NotFoundError"); };
    await harness.controller.autoCaptureSpeech();
    expect(state.disabledSessions).toEqual([]);
    expect(harness.controller.getScreen()).toMatchObject({ task: { taskId: task.taskId }, session: { microphoneEnabled: true }, recordingPhase: "idle", micDenied: false });
    expect(state.speechSubmissions).toHaveLength(0);
    harness.controller.teardown();
  });

  it.each([false, true])("spóźnione ręczne przygotowanie nie zmienia nowszego nagrania (błąd: %s)", async (fail) => {
    const harness = await startAtTask(baseState(), speechTask());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    harness.media.prepareMicrophone = async () => {
      await gate;
      if (fail) throw new DOMException("Permission denied", "NotAllowedError");
    };
    const oldPreparation = harness.controller.prepareMicrophone();
    harness.controller.cancelRecording();
    harness.media.prepareMicrophone = async () => undefined;
    await harness.controller.prepareMicrophone();
    await harness.controller.startRecording();
    release();
    await oldPreparation;
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "recording", microphoneReady: true, micDenied: false });
    expect(harness.state.disabledSessions).toEqual([]);
    expect(harness.storage.read(MIC_DENIED_KEY)).toBeNull();
    harness.controller.cancelRecording();
  });

  it("spóźniony odczyt uprawnienia nie uruchamia autostartu po ręcznym włączeniu mikrofonu", async () => {
    const harness = await startAtTask(baseState(), speechTask());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    harness.media.getMicrophonePermission = async () => { await gate; return "granted"; };
    const autoCapture = harness.controller.autoCaptureSpeech();
    await harness.controller.prepareMicrophone();
    release();
    await autoCapture;
    expect(harness.recorder.started).toBe(0);
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "idle", microphoneReady: true });
    harness.controller.teardown();
  });

  it("potwierdzenie „Koniec” unieważnia autostart czekający na odczyt uprawnienia", async () => {
    const harness = await startAtTask(baseState(), speechTask());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    harness.media.getMicrophonePermission = async () => { await gate; return "granted"; };
    const autoCapture = harness.controller.autoCaptureSpeech();
    harness.controller.holdForEndConfirm();
    release();
    await autoCapture;
    expect(harness.recorder.started).toBe(0);
    expect(harness.media.beeps).toEqual([]);
    harness.controller.releaseEndConfirm();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.recorder.started).toBe(0);
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "idle" });
    harness.controller.teardown();
  });

  it("autostart czekający na uprawnienie nie rusza po otwarciu i zamknięciu panelu „Koniec”", async () => {
    const harness = await startAtTask(baseState(), speechTask());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    harness.media.getMicrophonePermission = async () => { await gate; return "granted"; };
    const autoCapture = harness.controller.autoCaptureSpeech();
    harness.controller.holdForEndConfirm();
    harness.controller.releaseEndConfirm();
    release();
    await autoCapture;
    expect(harness.recorder.started).toBe(0);
    expect(harness.media.beeps).toEqual([]);
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "idle" });
    harness.controller.teardown();
  });

  it("potwierdzenie „Koniec” blokuje autostart do zamknięcia panelu", async () => {
    const harness = await startAtTask(baseState(), speechTask());
    harness.controller.holdForEndConfirm();
    await harness.controller.autoCaptureSpeech();
    expect(harness.recorder.started).toBe(0);
    harness.controller.releaseEndConfirm();
    await harness.controller.autoCaptureSpeech();
    expect(harness.recorder.started).toBe(1);
    harness.controller.teardown();
  });

  it("ręczne zakończenie cichego autostartu nie wysyła próby", async () => {
    const harness = await startAtTask(baseState(), speechTask());
    await harness.controller.autoCaptureSpeech();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 500);
    try {
      await harness.controller.stopRecording();
      expect(harness.state.speechSubmissions).toHaveLength(0);
      expect(harness.recorder.cancelled).toBe(1);
      expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "idle" });
    } finally { clock.mockRestore(); harness.controller.teardown(); }
  });

  it("anulowanie startu przekazuje anulowanie do oczekującego bipa", async () => {
    const harness = await startAtTask(baseState(), speechTask());
    let entered!: () => void;
    let release!: () => void;
    let signal: AbortSignal | undefined;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    harness.media.playBeep = async (_kind, cancellation) => { signal = cancellation; entered(); await gate; };
    const capture = harness.controller.autoCaptureSpeech();
    await reached;
    harness.controller.cancelRecording();
    expect(signal?.aborted).toBe(true);
    release();
    await capture;
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "idle" });
    expect(harness.state.speechSubmissions).toHaveLength(0);
    harness.controller.teardown();
  });

  it.each(["pattern", "guidance", "skip"])("%s przerywa autostart bez wysyłki audio i wykonuje żądaną akcję", async (action) => {
    const state = baseState();
    state.uiAudioReady = true;
    const task = taskDto("auto-interrupted", { kind: "speech", text: "apple", visualType: "none", imageAssetId: null, audioAssetId: "pattern" });
    const harness = await startAtTask(state, task);
    harness.media.playUrls.length = 0;
    await harness.controller.autoCaptureSpeech();
    if (action === "pattern") await harness.controller.playTaskAudio();
    else if (action === "guidance") await harness.controller.playGuidance("recall");
    else await harness.controller.skip();
    expect(harness.recorder.cancelled).toBeGreaterThan(0);
    expect(state.speechSubmissions).toHaveLength(0);
    if (action === "skip") expect(state.submissions).toContainEqual(expect.objectContaining({ modality: "skip" }));
    else expect(harness.media.playUrls).toHaveLength(1);
    harness.controller.teardown();
  });

  it("auto-próba: bip startu po gotowości mikrofonu i przed rozpoczęciem przechwytywania (D-04)", async () => {
    const log: string[] = [];
    const harness = await startAtTask(baseState(), speechTask(), { sharedLog: log });
    await harness.controller.prepareMicrophone();
    await harness.controller.autoCaptureSpeech();
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "recording" });
    // kolejność: prepareMicrophone → playBeep("start") → marker przechwytywania
    expect(log).toEqual(["prepareMicrophone", "beep:start", "capture"]);
    harness.controller.teardown();
  });

  it("odrzucenie bipu startu nie blokuje nagrywania (bip opcjonalny, nagrywanie obowiązkowe)", async () => {
    const harness = await startAtTask(baseState(), speechTask());
    await harness.controller.prepareMicrophone();
    harness.media.playBeep = async () => {
      throw new Error("autoplay blocked");
    };
    await harness.controller.autoCaptureSpeech();
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "recording" });
    expect(harness.recorder.started).toBe(1);
    harness.controller.teardown();
  });

  it("ręczne startRecording nie przekazuje hooka i nie gra bipu startu", async () => {
    const log: string[] = [];
    const harness = await startAtTask(baseState(), speechTask(), { sharedLog: log });
    await harness.controller.prepareMicrophone();
    await harness.controller.startRecording();
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "recording" });
    expect(harness.media.lastRecorderOptions?.onMicrophoneReady).toBeUndefined();
    expect(harness.media.beeps).toEqual([]);
    harness.controller.cancelRecording();
  });

  it("auto-stop po mowie i ~1,2 s ciszy: jedno stopRecording, jedna próba audio, bip końca (D-03)", async () => {
    vi.useFakeTimers();
    try {
      const task = speechTask();
      const harness = await startAtTask(baseState(), task);
      await harness.controller.prepareMicrophone();
      await harness.controller.autoCaptureSpeech();
      expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "recording" });
      await vi.advanceTimersByTimeAsync(300);
      let releaseSubmit!: () => void;
      const submitGate = new Promise<void>((resolve) => { releaseSubmit = resolve; });
      vi.spyOn(harness.api, "submitSpeech").mockImplementation(async (taskId, clientAttemptId, audio) => {
        await submitGate;
        return makeApi(harness.state).submitSpeech(taskId, clientAttemptId, audio);
      });
      // mowa 2 próbki (bez martwej strefy — PR #109 P1 #1), cisza 12
      for (let index = 0; index < 3; index += 1) harness.recorder.pushLevel(1);
      for (let index = 0; index < 2; index += 1) harness.recorder.pushLevel(0.2);
      for (let index = 0; index < 12; index += 1) harness.recorder.pushLevel(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.recorder.stopped).toBe(1);
      expect(harness.recorder.cancelled).toBe(0);
      // bip końca po zebraniu bajtów, przed wysyłką (nie blokuje submitSpeech)
      expect(harness.media.beeps).toEqual(["start", "end"]);
      expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "idle", processing: true, busy: true });
      releaseSubmit();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.state.speechSubmissions).toHaveLength(1);
      expect(harness.state.speechSubmissions[0]).toMatchObject({ taskId: task.taskId });
      expect(harness.controller.getScreen()).toMatchObject({ feedback: { modality: "audio" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cisza bez mowy: limit 15 s anuluje nagrywanie z komunikatem i bez próby (SPEC §15)", async () => {
    const harness = await startAtTask(baseState(), speechTask());
    await harness.controller.prepareMicrophone();
    await harness.controller.autoCaptureSpeech();
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "recording" });
    harness.recorder.hitLimit();
    expect(harness.recorder.cancelled).toBe(1);
    expect(harness.recorder.stopped).toBe(0);
    expect(harness.state.speechSubmissions).toHaveLength(0);
    expect(harness.controller.getScreen()).toMatchObject({
      recordingPhase: "idle",
      recordingNotice: messages.kid.autoCaptureNoSpeech,
    });
  });

  it("limit po usłyszanej mowie prowadzi do stopRecording — realna mowa nie zostaje porzucona", async () => {
    vi.useFakeTimers();
    try {
      const harness = await startAtTask(baseState(), speechTask());
      await harness.controller.prepareMicrophone();
      await harness.controller.autoCaptureSpeech();
      await vi.advanceTimersByTimeAsync(400);
      // 5 próbek mowy → speechDetected (sustain 2); bez ciszy limit domyka nagranie
      for (let index = 0; index < 5; index += 1) harness.recorder.pushLevel(0.3);
      harness.recorder.hitLimit();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.recorder.stopped).toBe(1);
      expect(harness.recorder.cancelled).toBe(0);
      expect(harness.state.speechSubmissions).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("odmowa mikrofonu w trybie auto: ścieżka micDenied, zero próby, brak pętli ponowień", async () => {
    const harness = await startAtTask(baseState(), speechTask());
    harness.media.prepareMicrophone = async () => {
      throw new DOMException("Permission dismissed", "NotAllowedError");
    };
    await harness.controller.autoCaptureSpeech();
    expect(harness.controller.getScreen()).toMatchObject({ micDenied: true, recordingPhase: "idle", recording: false });
    expect(harness.recorder.started).toBe(0);
    expect(harness.state.speechSubmissions).toHaveLength(0);
    expect(harness.storage.read(MIC_DENIED_KEY)).toBe("1");
    // ponowne wywołanie nie odpala kolejnej próby — tylko przycisk
    await harness.controller.autoCaptureSpeech();
    expect(harness.recorder.started).toBe(0);
  });

  it("teardown w trakcie auto-nagrywania anuluje bez próby; drugie autoCaptureSpeech to no-op (RF5)", async () => {
    const harness = await startAtTask(baseState(), speechTask());
    await harness.controller.prepareMicrophone();
    await harness.controller.autoCaptureSpeech();
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "recording" });
    await harness.controller.autoCaptureSpeech();
    expect(harness.recorder.started).toBe(1);
    harness.controller.teardown();
    expect(harness.recorder.cancelled).toBe(1);
    expect(harness.state.speechSubmissions).toHaveLength(0);
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "idle" });
  });

  it("autoCaptureSpeech nic nie robi dla zadania pisemnego i w kartkówce (D-02)", async () => {
    const written = await startAtTask(baseState(), taskDto("written", { kind: "recall", prompt: "czwartek" }));
    await written.controller.autoCaptureSpeech();
    expect(written.recorder.started).toBe(0);
    expect(written.media.beeps).toEqual([]);

    const state = baseState();
    state.tasks = [speechTask()];
    const mockHarness = makeHarness(state);
    await mockHarness.controller.start();
    await mockHarness.controller.selectProfile(PROFILE_A.childId);
    await mockHarness.controller.startMockTest(DECK.deckId);
    await mockHarness.controller.beginMockTest();
    expect(mockHarness.controller.getScreen()).toMatchObject({ kind: "learning" });
    await mockHarness.controller.autoCaptureSpeech();
    expect(mockHarness.recorder.started).toBe(0);
    expect(mockHarness.media.beeps).toEqual([]);
  });

  it("po powrocie do ćwiczenia z retry (Nagraj jeszcze raz) autoCaptureSpeech nie startuje samo (SPEC §16)", async () => {
    vi.useFakeTimers();
    try {
      const task = speechTask();
      const state = baseState();
      state.attempts = [attemptDto({ taskId: task.taskId, modality: "audio", feedback: { kind: "almost" }, taskState: "issued" })];
      const harness = await startAtTask(state, task);
      await harness.controller.prepareMicrophone();
      await harness.controller.autoCaptureSpeech();
      await vi.advanceTimersByTimeAsync(300);
      for (let index = 0; index < 3; index += 1) harness.recorder.pushLevel(1);
      for (let index = 0; index < 2; index += 1) harness.recorder.pushLevel(0.2);
      for (let index = 0; index < 12; index += 1) harness.recorder.pushLevel(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.state.speechSubmissions).toHaveLength(1);
      expect(harness.controller.getScreen()).toMatchObject({ feedback: { retry: true } });
      // retry tego samego zadania: feedback znika, ale mikrofon nie startuje sam
      await harness.controller.continueLearning();
      expect(harness.controller.getScreen()).toMatchObject({ feedback: null, task: { taskId: task.taskId } });
      await harness.controller.autoCaptureSpeech();
      expect(harness.recorder.started).toBe(1);
      expect(harness.state.speechSubmissions).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ręczne nagrywanie po cichu auto-anulowania działa i nie gra bipów", async () => {
    vi.useFakeTimers();
    try {
      const harness = await startAtTask(baseState(), speechTask());
      await harness.controller.prepareMicrophone();
      await harness.controller.autoCaptureSpeech();
      harness.recorder.hitLimit();
      expect(harness.controller.getScreen()).toMatchObject({ recordingNotice: messages.kid.autoCaptureNoSpeech, technicalRecordingIssue: true });
      // przycisk pozostaje fallbackiem: ręczna próba po auto-anulowaniu
      await harness.controller.startRecording();
      await vi.advanceTimersByTimeAsync(301);
      await harness.controller.stopRecording();
      expect(harness.state.speechSubmissions).toHaveLength(1);
      expect(harness.media.beeps).toEqual(["start"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("po udanej auto-próbie ręczne „Nagraj jeszcze raz” nie gra bipu startu (reset stanu auto, D-04)", async () => {
    vi.useFakeTimers();
    try {
      const task = speechTask();
      const state = baseState();
      state.attempts = [attemptDto({ taskId: task.taskId, modality: "audio", feedback: { kind: "almost" }, taskState: "issued" })];
      const harness = await startAtTask(state, task);
      await harness.controller.prepareMicrophone();
      await harness.controller.autoCaptureSpeech();
      await vi.advanceTimersByTimeAsync(300);
      // pełny cykl auto: mowa + cisza → auto-stop → jedyna próba audio
      for (let index = 0; index < 3; index += 1) harness.recorder.pushLevel(1);
      for (let index = 0; index < 2; index += 1) harness.recorder.pushLevel(0.2);
      for (let index = 0; index < 12; index += 1) harness.recorder.pushLevel(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.state.speechSubmissions).toHaveLength(1);
      expect(harness.controller.getScreen()).toMatchObject({ feedback: { retry: true } });
      await harness.controller.continueLearning();
      expect(harness.controller.getScreen()).toMatchObject({ feedback: null, task: { taskId: task.taskId } });

      // ręczna próba na tym samym kontrolerze: bez hooka onMicrophoneReady
      // i bez kolejnego bipu startu — stan auto-próby skonsumował stopRecording
      await harness.controller.startRecording();
      expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "recording" });
      expect(harness.recorder.started).toBe(2);
      expect(harness.media.lastRecorderOptions?.onMicrophoneReady).toBeUndefined();
      expect(harness.media.beeps).toEqual(["start", "end"]);
      harness.controller.cancelRecording();
      expect(harness.state.speechSubmissions).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("WR-02: uprawnienie „prompt” pomija auto-start — bez sondy i bez getUserMedia; micDenied nie zostaje zapamiętane", async () => {
    const log: string[] = [];
    const harness = await startAtTask(baseState(), speechTask(), { sharedLog: log, microphonePermission: "prompt" });
    await harness.controller.autoCaptureSpeech();
    expect(harness.media.permissionQueries).toBe(1);
    // cichy skip: żadnej sondy prepareMicrophone ani startu rejestratora
    expect(log).toEqual(["permission:prompt"]);
    expect(harness.recorder.started).toBe(0);
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "idle", micDenied: false, feedback: null });
    expect(harness.state.speechSubmissions).toHaveLength(0);
    // świadome naciśnięcie przycisku pozostaje pełną ścieżką: przygotowanie…
    await harness.controller.startRecording();
    expect(harness.controller.getScreen()).toMatchObject({ microphoneReady: true, recordingPhase: "idle" });
    // …a kolejne wciśnięcie rozpoczyna nagrywanie ręczne
    await harness.controller.startRecording();
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "recording" });
    expect(harness.recorder.started).toBe(1);
    harness.controller.cancelRecording();
  });

  it("WR-02: uprawnienie „denied” również pomija auto-start bez zapamiętania odmowy", async () => {
    const harness = await startAtTask(baseState(), speechTask(), { microphonePermission: "denied" });
    await harness.controller.autoCaptureSpeech();
    expect(harness.recorder.started).toBe(0);
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "idle", micDenied: false });
  });

  it("WR-02: nieznany stan uprawnień („unknown”) pomija auto-start — bezpieczne domyślnie", async () => {
    const harness = await startAtTask(baseState(), speechTask(), { microphonePermission: "unknown" });
    await harness.controller.autoCaptureSpeech();
    expect(harness.recorder.started).toBe(0);
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "idle" });
  });

  it("WR-02: uprawnienie „granted” — auto-start przebiega jak dotychczas", async () => {
    const log: string[] = [];
    const harness = await startAtTask(baseState(), speechTask(), { sharedLog: log, microphonePermission: "granted" });
    await harness.controller.autoCaptureSpeech();
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "recording" });
    expect(log).toEqual(["permission:granted", "prepareMicrophone", "beep:start", "capture"]);
    harness.controller.teardown();
  });

  it.each(["permission", "preparation"])("anulowanie podczas %s blokuje oczekujący auto-start", async (stage) => {
    const harness = await startAtTask(baseState(), speechTask());
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    if (stage === "permission") {
      harness.media.getMicrophonePermission = async () => { entered(); await pending; return "granted"; };
    } else {
      harness.media.prepareMicrophone = async () => { entered(); await pending; };
    }
    const capture = harness.controller.autoCaptureSpeech();
    await reached;
    harness.controller.cancelRecording();
    release();
    await capture;
    expect(harness.recorder.started).toBe(0);
    expect(harness.media.beeps).toEqual([]);
    expect(harness.state.speechSubmissions).toHaveLength(0);
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "idle", microphoneReady: false });
    harness.controller.teardown();
  });

  it("WR-02: mikrofon już gotowy w sesji — auto-start bez pytania o uprawnienie", async () => {
    const log: string[] = [];
    const harness = await startAtTask(baseState(), speechTask(), { sharedLog: log });
    await harness.controller.prepareMicrophone();
    harness.media.permissionQueries = 0;
    log.length = 0;
    await harness.controller.autoCaptureSpeech();
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "recording" });
    expect(harness.media.permissionQueries).toBe(0);
    expect(log).toEqual(["beep:start", "capture"]);
    harness.controller.teardown();
  });

  it("PR #109 P1 #2: niedostępny monitor poziomów przerywa auto-próbę bez bipu, próby i odmowy — przycisk działa", async () => {
    const log: string[] = [];
    const harness = await startAtTask(baseState(), speechTask(), {
      sharedLog: log,
      failStartWith: new LevelMonitorUnavailableError(),
    });
    await harness.controller.autoCaptureSpeech();
    // czysta przerwa: żadnego bipu startu, żadnego przechwytywania, zero prób
    expect(log).toEqual(["permission:granted", "prepareMicrophone"]);
    expect(harness.recorder.started).toBe(0);
    expect(harness.media.beeps).toEqual([]);
    expect(harness.state.speechSubmissions).toHaveLength(0);
    // dziecko widzi komunikat i niezmienioną ścieżkę ręczną (bez micDenied)
    expect(harness.controller.getScreen()).toMatchObject({
      recordingPhase: "idle",
      micDenied: false,
      recordingNotice: messages.kid.autoCaptureListenUnavailable,
    });
    // świadomy przycisk: przygotowanie i nagrywanie działają bez analizatora
    await harness.controller.startRecording();
    await harness.controller.startRecording();
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "recording" });
    expect(harness.recorder.started).toBe(1);
    expect(harness.media.lastRecorderOptions?.onMicrophoneReady).toBeUndefined();
    expect(harness.media.beeps).toEqual([]);
    harness.controller.cancelRecording();
  });

  it("PR #109 runda 4: monitor niedostępny w obrazkowej sesji nieczytającego nie wyłącza mikrofonu sesji", async () => {
    // główny przypadek picture_speech: nieczytający + zestaw obrazkowy; awaria
    // monitora (autoplay/interrupted) musi zostać przy auto-próbie — wspólne
    // disableForPicture wyłączyłoby mikrofon CAŁEJ sesji i dziecko straciło
    // przycisk mimo komunikatu „Nagraj przyciskiem.”
    const state = baseState();
    state.profiles = [{ ...PROFILE_A, canRead: false }];
    state.decks = [{ ...DECK, vocabularyFormat: "picture" }];
    const spoken = taskDto("r4-picture-speech", {
      kind: "picture_speech",
      audioAssetId: "asset-pattern",
      visual: { kind: "color", color: "#ff0000" },
    });
    const harness = await startAtTask(state, spoken, {
      failStartWith: new LevelMonitorUnavailableError(),
    });
    await harness.controller.autoCaptureSpeech();
    // czysta przerwa auto: bez próby, bez odmowy i BEZ wyłączenia mikrofonu sesji
    expect(harness.recorder.started).toBe(0);
    expect(harness.state.speechSubmissions).toHaveLength(0);
    expect(harness.state.disabledSessions).toEqual([]);
    expect(harness.controller.getScreen()).toMatchObject({
      kind: "learning",
      recordingPhase: "idle",
      micDenied: false,
      recordingNotice: messages.kid.autoCaptureListenUnavailable,
    });
    // przycisk pozostaje: mikrofon sesji wciąż włączony, ręczna próba działa
    expect(harness.controller.getScreen()).toMatchObject({
      session: { microphoneEnabled: true, canRead: false, vocabularyFormat: "picture" },
    });
    await harness.controller.startRecording();
    await harness.controller.startRecording();
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "recording" });
    harness.controller.cancelRecording();
  });

  it("PR #109 P2 #3: awaria urządzenia w auto-próbie zeruje stan auto — ręczne „Nagraj jeszcze raz” bez bipu startu", async () => {
    const harness = await startAtTask(baseState(), speechTask());
    await harness.controller.autoCaptureSpeech();
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "recording" });
    expect(harness.media.beeps).toEqual(["start"]);
    // awaria urządzenia w trakcie auto-nagrania (onError, nie próba dziecka)
    harness.recorder.fail();
    expect(harness.controller.getScreen()).toMatchObject({
      recordingPhase: "idle",
      recordingNotice: messages.kid.recordingUnavailable,
    });
    // ręczna próba na tym samym kontrolerze: bez hooka i bez kolejnego bipu
    await harness.controller.startRecording();
    await harness.controller.startRecording();
    expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "recording" });
    expect(harness.media.lastRecorderOptions?.onMicrophoneReady).toBeUndefined();
    expect(harness.media.beeps).toEqual(["start"]);
    harness.controller.cancelRecording();
  });

  it("runda 3: późny start auto zadania A nie kasuje VAD zadania B — mowa daje dokładnie jedną próbę", async () => {
    vi.useFakeTimers();
    try {
      const taskA = speechTask();
      const taskB = taskDto("auto-speech-b", { kind: "speech", text: "bee", visualType: "none", imageAssetId: null, audioAssetId: null });
      let releaseA!: () => void;
      let releaseB!: () => void;
      const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
      const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
      const recorderOpts: { startGate?: Promise<void> } = { startGate: gateA };
      const state = baseState();
      const harness = await startAtTask(state, taskA, recorderOpts);
      const phaseOf = (): string => {
        const screen = harness.controller.getScreen();
        return screen.kind === "learning" ? screen.recordingPhase : "inny-ekran";
      };
      const taskIdOf = (): string | null => {
        const screen = harness.controller.getScreen();
        return screen.kind === "learning" ? (screen.task?.taskId ?? null) : null;
      };
      // A: auto-start wisi na bramce getUserMedia (faza starting)
      const autoA = harness.controller.autoCaptureSpeech();
      for (let index = 0; index < 10 && phaseOf() !== "starting"; index += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(phaseOf()).toBe("starting");
      // użytkownik przerywa A i przechodzi do następnego zadania
      harness.controller.cancelRecording();
      expect(phaseOf()).toBe("idle");
      recorderOpts.startGate = gateB;
      state.tasks.push(taskB);
      await harness.controller.skip();
      await harness.controller.continueLearning();
      expect(taskIdOf()).toBe(taskB.taskId);
      // B: własna auto-próba wisi w starting (start B na drugiej bramce)
      const autoB = harness.controller.autoCaptureSpeech();
      for (let index = 0; index < 10 && phaseOf() !== "starting"; index += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(phaseOf()).toBe("starting");
      // późne rozwiązanie bramki A: ogon A nie może wyzerować stanu auto B
      releaseA();
      await autoA;
      releaseB();
      await autoB;
      expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "recording", task: { taskId: taskB.taskId } });
      // pełna wypowiedź B: mowa + ~1,2 s ciszy → auto-stop z JEDNĄ próbą audio
      await vi.advanceTimersByTimeAsync(300);
      harness.recorder.pushLevel(0.3);
      harness.recorder.pushLevel(0.3);
      for (let index = 0; index < 12; index += 1) harness.recorder.pushLevel(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.recorder.stopped).toBe(1);
      expect(harness.state.speechSubmissions).toHaveLength(1);
      expect(harness.state.speechSubmissions[0]).toMatchObject({ taskId: taskB.taskId });
    } finally {
      vi.useRealTimers();
    }
  });

  it("runda 3: późny start auto zadania A nie kasuje VAD zadania B — cisza nie tworzy próby (SPEC §15)", async () => {
    vi.useFakeTimers();
    try {
      const taskA = speechTask();
      const taskB = taskDto("auto-speech-b", { kind: "speech", text: "bee", visualType: "none", imageAssetId: null, audioAssetId: null });
      let releaseA!: () => void;
      let releaseB!: () => void;
      const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
      const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
      const recorderOpts: { startGate?: Promise<void> } = { startGate: gateA };
      const state = baseState();
      const harness = await startAtTask(state, taskA, recorderOpts);
      const phaseOf = (): string => {
        const screen = harness.controller.getScreen();
        return screen.kind === "learning" ? screen.recordingPhase : "inny-ekran";
      };
      const taskIdOf = (): string | null => {
        const screen = harness.controller.getScreen();
        return screen.kind === "learning" ? (screen.task?.taskId ?? null) : null;
      };
      const autoA = harness.controller.autoCaptureSpeech();
      for (let index = 0; index < 10 && phaseOf() !== "starting"; index += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(phaseOf()).toBe("starting");
      harness.controller.cancelRecording();
      recorderOpts.startGate = gateB;
      state.tasks.push(taskB);
      await harness.controller.skip();
      await harness.controller.continueLearning();
      const autoB = harness.controller.autoCaptureSpeech();
      for (let index = 0; index < 10 && phaseOf() !== "starting"; index += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(phaseOf()).toBe("starting");
      releaseA();
      await autoA;
      releaseB();
      await autoB;
      expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "recording" });
      // cisza przez cały limit: bez VAD ogon wysłałby milczenie jako próbę
      await vi.advanceTimersByTimeAsync(300);
      harness.recorder.hitLimit();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.state.speechSubmissions).toHaveLength(0);
      expect(harness.controller.getScreen()).toMatchObject({
        recordingPhase: "idle",
        recordingNotice: messages.kid.autoCaptureNoSpeech,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

function baseState(): ApiState {
  return {
    profiles: [PROFILE_A, PROFILE_B],
    decks: [DECK],
    tasks: [],
    attempts: [],
    disclosures: [],
    presentations: [],
    endedSessions: [],
    disabledSessions: [],
    startedSessions: [],
    submissions: [],
    speechSubmissions: [],
    observations: [],
    feedbackAudioCalls: [],
    endReports: [],
    activityResults: [],
    activityResultCalls: [],
    networkDown: false,
  };
}

describe("LearningSessionController — dyktowanie odpowiedzi lekcji (Etap 3 szkoły)", () => {
  const openAnswer = (taskId = "dict-1", speechInput: { maxSeconds: number } | null = { maxSeconds: 45 }) => taskDto(taskId, {
    kind: "lesson_open_answer", instructionPl: "Odpowiedz.", prompt: "Co to jest poziomica?", promptLocale: "pl-PL",
    ...(speechInput ? { speechInput } : {}),
  });

  async function dictationHarness(results: Array<import("@learning/contracts").DictationDto | Error>, task = openAnswer()) {
    const state = baseState();
    state.tasks = [task];
    const calls: { taskId: string; bytes: Uint8Array }[] = [];
    const answers: unknown[] = [];
    const base = makeApi(state);
    const api: KidApi = {
      ...base,
      async dictate(taskId, audio) {
        calls.push({ taskId, bytes: audio.bytes });
        const next = results.shift() ?? { status: "unavailable" };
        if (next instanceof Error) throw next;
        return next;
      },
      async submitAnswer(input) {
        answers.push(input);
        return base.submitAnswer(input);
      },
    };
    const harness = makeHarness(state, { api });
    await harness.controller.start();
    await harness.controller.selectProfile(state.profiles[0]!.childId);
    harness.controller.setMicrophone(true);
    await harness.controller.startLearning(DECK.deckId);
    await harness.controller.prepareMicrophone();
    return { ...harness, calls, answers };
  }

  async function record(harness: Awaited<ReturnType<typeof dictationHarness>>): Promise<void> {
    await harness.controller.startRecording();
    await vi.advanceTimersByTimeAsync(400);
    await harness.controller.stopRecording();
  }

  it("rozpoznany tekst trafia do stanu ekranu bez próby; bajty są zerowane, limit nagrania to 45 s", async () => {
    vi.useFakeTimers();
    try {
      const harness = await dictationHarness([{ status: "heard", text: "Poziomica to linia na mapie." }]);
      await record(harness);
      expect(harness.media.lastRecorderOptions?.maxDurationMs).toBe(45_000);
      expect(harness.calls).toHaveLength(1);
      expect([...harness.calls[0]!.bytes]).toEqual([0, 0, 0]);
      expect(harness.state.speechSubmissions).toEqual([]);
      expect(harness.state.submissions).toEqual([]);
      expect(harness.controller.getScreen()).toMatchObject({
        recordingPhase: "idle",
        busy: false,
        feedback: null,
        recordingNotice: messages.kid.dictationHeard,
        dictation: { taskId: "dict-1", status: "heard", text: "Poziomica to linia na mapie.", failures: 0 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("niepewne i nieudane dyktowania liczą się z rzędu i po dwóch wskazują pisanie", async () => {
    vi.useFakeTimers();
    try {
      const harness = await dictationHarness([{ status: "uncertain" }, { status: "no_speech" }, { status: "too_long" }]);
      await record(harness);
      expect(harness.controller.getScreen()).toMatchObject({ recordingNotice: messages.kid.dictationNotHeard, dictation: { status: "uncertain", failures: 1 } });
      expect((harness.controller.getScreen() as { dictation?: { text?: string } }).dictation?.text).toBeUndefined();
      await record(harness);
      expect(harness.controller.getScreen()).toMatchObject({
        recordingNotice: `${messages.kid.dictationNotHeard} ${messages.kid.dictationTypeInstead}`,
        dictation: { status: "no_speech", failures: 2 },
      });
      await record(harness);
      expect(harness.controller.getScreen()).toMatchObject({ dictation: { status: "too_long", failures: 3 } });
      expect(harness.state.submissions).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("utrata sieci kończy się komunikatem, bez lokalnego sukcesu i bez zapamiętanego nagrania", async () => {
    vi.useFakeTimers();
    try {
      const harness = await dictationHarness([new TypeError("fetch failed")]);
      await record(harness);
      expect([...harness.calls[0]!.bytes]).toEqual([0, 0, 0]);
      expect(harness.controller.getScreen()).toMatchObject({
        recordingPhase: "idle",
        feedback: null,
        recordingNotice: messages.kid.dictationUnavailable,
        dictation: { status: "unavailable" },
      });
      expect(harness.state.submissions).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("odlicza ostatnie 10 sekund i zatrzymuje odliczanie po anulowaniu", async () => {
    vi.useFakeTimers();
    try {
      const harness = await dictationHarness([]);
      await harness.controller.startRecording();
      await vi.advanceTimersByTimeAsync(34_000);
      // przed ostatnimi 10 sekundami bez odliczania
      expect((harness.controller.getScreen() as { recordingNotice: string | null }).recordingNotice).toBeNull();
      await vi.advanceTimersByTimeAsync(1_000);
      expect((harness.controller.getScreen() as { recordingNotice: string | null }).recordingNotice).toBe(format(messages.kid.dictationCountdown, { seconds: 10 }));
      harness.controller.cancelRecording();
      expect(harness.recorder.cancelled).toBe(1);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(harness.controller.getScreen()).toMatchObject({ recordingPhase: "idle", recordingNotice: null });
      expect(harness.calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("odpowiedź z dyktowania zgłasza sposób wprowadzenia, klawiatura go pomija", async () => {
    const harness = await dictationHarness([]);
    await harness.controller.answerText("  Linia na mapie. ", "speech");
    expect(harness.answers[0]).toMatchObject({ modality: "text", text: "Linia na mapie.", inputMethod: "speech" });
    const keyboard = await dictationHarness([]);
    await keyboard.controller.answerText("Linia");
    expect(keyboard.answers[0]).not.toHaveProperty("inputMethod");
  });

  it("host bez `dictate` nie wysyła nagrania lekcji jako próby ustnej — dziecko dostaje „nie udało się”", async () => {
    vi.useFakeTimers();
    try {
      const state = baseState();
      state.tasks = [openAnswer()];
      const { dictate: _omitted, ...api } = makeApi(state);
      const harness = makeHarness(state, { api: api as KidApi });
      await harness.controller.start();
      await harness.controller.selectProfile(state.profiles[0]!.childId);
      harness.controller.setMicrophone(true);
      await harness.controller.startLearning(DECK.deckId);
      await harness.controller.prepareMicrophone();
      await harness.controller.startRecording();
      await vi.advanceTimersByTimeAsync(400);
      await harness.controller.stopRecording();
      expect(state.speechSubmissions).toEqual([]);
      expect(harness.controller.getScreen()).toMatchObject({
        recordingPhase: "idle",
        recordingNotice: messages.kid.dictationUnavailable,
        dictation: { taskId: "dict-1", status: "unavailable" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bez speechInput nagranie idzie zwykłą ścieżką próby ustnej, nie do dyktowania", async () => {
    vi.useFakeTimers();
    try {
      const harness = await dictationHarness([], openAnswer("plain-1", null));
      await record(harness);
      expect(harness.calls).toEqual([]);
      expect(harness.media.lastRecorderOptions?.maxDurationMs).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("LearningSessionController — odczyt zdania po odpowiedzi w lekcji", () => {
  const SENTENCE = "abababab-abab-4bab-8bab-abababababab";
  const SENTENCE_URL = `https://media.test/${SENTENCE}`;
  const gap = () => taskDto("tg", { kind: "lesson_gap", instructionPl: "Uzupełnij", stemWithGap: "He ___ (go).", audioAssetId: "asset-gap" });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("odtwarza nagranie zdania raz, bez akcji dziecka, po zakończonej odpowiedzi", async () => {
    const state = baseState();
    state.attempts = [attemptDto({ taskId: "tg", taskState: "answered", feedback: { kind: "great", correctAudioAssetId: SENTENCE } })];
    const harness = await startAtTask(state, gap());
    await harness.controller.answerText("goes");
    await tick();
    expect(harness.media.playUrls).toEqual([SENTENCE_URL]);
    // bez autoryzacji — ujawnienie zapieczętował serwer przy ocenie
    expect(state.disclosures).toHaveLength(0);
    expect(state.feedbackAudioCalls).toHaveLength(0);
  });

  it("feedback bez nagrania zdania nic nie odtwarza", async () => {
    const state = baseState();
    state.attempts = [attemptDto({ taskId: "tg", taskState: "answered", feedback: { kind: "great" } })];
    const harness = await startAtTask(state, gap());
    await harness.controller.answerText("goes");
    await tick();
    expect(harness.media.playUrls).toEqual([]);
  });

  it("zablokowane autoodtwarzanie (NotAllowedError) nie pokazuje błędu", async () => {
    const state = baseState();
    state.attempts = [attemptDto({ taskId: "tg", taskState: "answered", feedback: { kind: "incorrect", correctText: "He goes.", correctAudioAssetId: SENTENCE } })];
    const harness = await startAtTask(state, gap());
    const play = vi.spyOn(harness.media.player, "play").mockRejectedValue(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
    await harness.controller.answerText("go");
    await tick();
    expect(play).toHaveBeenCalledWith(SENTENCE_URL, expect.any(Function));
    const screen = harness.controller.getScreen() as { feedback: { audioError?: boolean } | null; error: unknown; taskAudioError?: unknown };
    expect(screen.feedback).not.toBeNull();
    expect(screen.feedback?.audioError).not.toBe(true);
    expect(screen.error).toBeNull();
    expect(screen.taskAudioError ?? null).toBeNull();
  });

  it("„Posłuchaj zdania” odtwarza nagranie ponownie", async () => {
    const state = baseState();
    state.attempts = [attemptDto({ taskId: "tg", taskState: "answered", feedback: { kind: "great", correctAudioAssetId: SENTENCE } })];
    const harness = await startAtTask(state, gap());
    await harness.controller.answerText("goes");
    await tick();
    await harness.controller.playSentenceAudio();
    expect(harness.media.playUrls).toEqual([SENTENCE_URL, SENTENCE_URL]);
  });

  // stop() fake'a rozstrzyga play() od razu, więc koniec odczytu ściga się tu z #loadNext
  // (release() niczego już nie kończy); spóźniony start po „Dalej” pokrywa
  // „Dalej gasi i nie przenosi stanu” w bloku „odczyt zdania: stan, wolne tempo, błąd”.
  it("„Dalej” w trakcie odczytu zatrzymuje go, a koniec przerwanego odczytu nie zmienia nowego zadania", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const state = baseState();
    state.attempts = [attemptDto({ taskId: "tg", taskState: "answered", feedback: { kind: "great", correctAudioAssetId: SENTENCE } })];
    const harness = await startAtTask(state, gap(), { playGate: gate });
    state.tasks = [taskDto("tn", { kind: "lesson_gap", instructionPl: "Uzupełnij", stemWithGap: "She ___ (read).", audioAssetId: "asset-next" })];
    await harness.controller.answerText("goes");
    await tick();
    expect(harness.media.playUrls).toEqual([SENTENCE_URL]);
    const stopsBefore = harness.media.stops;
    await harness.controller.continueLearning();
    expect(harness.media.stops).toBeGreaterThan(stopsBefore);
    const next = harness.controller.getScreen();
    expect(next).toMatchObject({ kind: "learning", task: { taskId: "tn" }, feedback: null });
    release();
    await tick();
    expect(harness.controller.getScreen()).toBe(next);
    expect(harness.media.playUrls).toEqual([SENTENCE_URL]);
  });

  it("„Nie pamiętam” w lekcji z nagraniem zdania pokazuje wynik z odczytem i czeka na „Dalej”", async () => {
    const state = baseState();
    state.attempts = [attemptDto({ taskId: "tg", modality: "dont_remember", taskState: "answered", feedback: { kind: "incorrect", correctText: "He goes.", correctAudioAssetId: SENTENCE } })];
    const harness = await startAtTask(state, gap());
    state.tasks = [taskDto("tn", { kind: "lesson_gap", instructionPl: "Uzupełnij", stemWithGap: "She ___ (read).", audioAssetId: "asset-next" })];
    await harness.controller.notRemember();
    expect(harness.controller.getScreen()).toMatchObject({ reveal: { target: "Thursday" } });
    await harness.controller.confirmReveal();
    await tick();
    expect(harness.controller.getScreen()).toMatchObject({
      task: { taskId: "tg" }, reveal: null, busy: false,
      feedback: { modality: "dont_remember", retry: false, dto: { kind: "incorrect", correctAudioAssetId: SENTENCE } },
    });
    expect(harness.media.playUrls).toEqual([SENTENCE_URL]);
    await harness.controller.continueLearning();
    expect(harness.controller.getScreen()).toMatchObject({ task: { taskId: "tn" }, feedback: null });
  });

  it("„Nie pamiętam” w lekcji bez nagrania zdania przechodzi dalej jak dotąd", async () => {
    const state = baseState();
    state.attempts = [attemptDto({ taskId: "tg", modality: "dont_remember", taskState: "answered", feedback: { kind: "incorrect", correctText: "He goes." } })];
    const harness = await startAtTask(state, gap());
    state.tasks = [taskDto("tn", { kind: "lesson_gap", instructionPl: "Uzupełnij", stemWithGap: "She ___ (read).", audioAssetId: "asset-next" })];
    await harness.controller.notRemember();
    await harness.controller.confirmReveal();
    await tick();
    expect(harness.controller.getScreen()).toMatchObject({ task: { taskId: "tn" }, feedback: null, reveal: null });
    expect(harness.media.playUrls).toEqual([]);
  });

  it("picture_recognition nie odtwarza poprawnego słowa samo (odsłuch zostaje ręczny)", async () => {
    const option = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const recognition = taskDto("tr", {
      kind: "picture_recognition",
      visual: { kind: "image", imageAssetId: "33333333-3333-4333-8333-333333333333" },
      source: "kot",
      options: [{ id: option, text: "cat" }],
    });
    const state = baseState();
    state.attempts = [attemptDto({ taskId: "tr", modality: "choice", taskState: "answered", feedback: { kind: "great", correctAudioAssetId: SENTENCE } })];
    const harness = await startAtTask(state, recognition);
    await harness.controller.answerChoice(option);
    await tick();
    expect(harness.media.playUrls).toEqual([]);
    // ręczna powtórka zdania nie dotyczy słownictwa
    await harness.controller.playSentenceAudio();
    expect(harness.media.playUrls).toEqual([]);
  });

  describe("odczyt zdania: stan, wolne tempo, błąd", () => {
    type SentenceFeedback = { attemptId: string; sentencePlaying?: "normal" | "slow" | null; sentenceAudioError?: { rate: "normal" | "slow"; seq: number } | null };
    const feedbackOf = (harness: { controller: { getScreen(): unknown } }) =>
      (harness.controller.getScreen() as { feedback: SentenceFeedback | null }).feedback;
    const playing = (harness: { controller: { getScreen(): unknown } }) => feedbackOf(harness)?.sentencePlaying ?? null;
    const failure = (harness: { controller: { getScreen(): unknown } }) => feedbackOf(harness)?.sentenceAudioError ?? null;
    const gated = () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      return { gate, release };
    };
    const answered = async (opts: { playGate?: Promise<void>; playbackDurationMs?: number | null; activityClock?: import("./activity-report").ActivityClock } = {}, before?: (harness: Awaited<ReturnType<typeof startAtTask>>) => void) => {
      const state = baseState();
      state.attempts = [attemptDto({ taskId: "tg", taskState: "answered", feedback: { kind: "great", correctAudioAssetId: SENTENCE } })];
      const harness = await startAtTask(state, gap(), opts);
      state.tasks = [taskDto("tn", { kind: "lesson_gap", instructionPl: "Uzupełnij", stemWithGap: "She ___ (read).", audioAssetId: "asset-next" })];
      before?.(harness);
      await harness.controller.answerText("goes");
      await tick();
      return harness;
    };

    it("wskaźnik od startu do końca", async () => {
      const { gate, release } = gated();
      const harness = await answered({ playGate: gate });
      expect(playing(harness)).toBe("normal");
      expect(harness.media.playOptions).toEqual([undefined]);
      release();
      await tick();
      expect(playing(harness)).toBeNull();
      expect(failure(harness)).toBeNull();
    });

    it("zablokowany autoodczyt nie zapala wskaźnika i nie ustawia błędu", async () => {
      // Subskrypcja przed odpowiedzią: widzimy każdą emisję ekranu wyniku,
      // także tę między kliknięciem a odrzuceniem play().
      const seen: { playing: unknown; failure: unknown }[] = [];
      const harness = await answered({}, (h) => {
        h.media.rejectNextPlays = 1;
        h.controller.subscribe(() => {
          if (feedbackOf(h) !== null) seen.push({ playing: playing(h), failure: failure(h) });
        });
      });
      await tick();
      expect(harness.media.playUrls).toEqual([SENTENCE_URL]);
      expect(playing(harness)).toBeNull();
      expect(failure(harness)).toBeNull();
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((entry) => entry.playing === null && entry.failure === null)).toBe(true);
    });

    it("po teardown odczyt zdania nie woła odtwarzacza", async () => {
      const { gate, release } = gated();
      const harness = await answered({ playGate: gate });
      const urls = harness.media.playUrls.length;
      harness.controller.teardown();
      await harness.controller.playSentenceAudio("slow");
      expect(harness.media.playUrls).toHaveLength(urls);
      release();
    });

    it("przełączenie tempa nie ucina nowego odsłuchu w raporcie aktywności", async () => {
      // Nowy przebieg startuje (onStarted) przed `finally` przerwanego — koniec
      // starego odsłuchu tego samego nagrania nie może zamknąć nowego.
      let now = 0;
      const { gate, release } = gated();
      const state = baseState();
      state.attempts = [attemptDto({ taskId: "tg", taskState: "answered", feedback: { kind: "great", correctAudioAssetId: SENTENCE } })];
      const harness = await startAtTask(state, gap(), { playGate: gate, playbackDurationMs: 3_000, activityClock: { now: () => now } });
      await harness.controller.answerText("goes");
      await tick();
      expect(playing(harness)).toBe("normal");
      void harness.controller.playSentenceAudio("slow");
      await tick();
      now = 2_000;
      release();
      await tick();
      await harness.controller.endNow();
      const playbacks = state.endReports[0]?.tasks.flatMap((task) => task.playbacks) ?? [];
      expect(playbacks).toEqual([expect.objectContaining({ assetId: SENTENCE, toMs: 2_000 })]);
    });

    it("wolno: rate 0.75 i wskaźnik slow", async () => {
      const { gate, release } = gated();
      const harness = await answered({ playGate: gate });
      void harness.controller.playSentenceAudio("slow");
      await tick();
      expect(harness.media.playOptions.at(-1)).toEqual({ rate: 0.75 });
      expect(playing(harness)).toBe("slow");
      release();
      await tick();
      expect(playing(harness)).toBeNull();
    });

    it("przełączenie tempa w trakcie", async () => {
      const { gate, release } = gated();
      const harness = await answered({ playGate: gate });
      expect(playing(harness)).toBe("normal");
      void harness.controller.playSentenceAudio("slow");
      expect(playing(harness)).toBe("slow");
      // spóźnione zakończenie pierwszego przebiegu (przerwanego przez stop) nie gasi wolnego
      await tick();
      expect(playing(harness)).toBe("slow");
      release();
      await tick();
      expect(playing(harness)).toBeNull();
    });

    it("przerwanie przez komunikat gasi synchronicznie", async () => {
      const { gate } = gated();
      const harness = await answered({ playGate: gate });
      expect(playing(harness)).toBe("normal");
      const guidance = harness.controller.playGuidance("recall");
      expect(playing(harness)).toBeNull();
      await guidance.catch(() => undefined);
      await tick();
      expect(playing(harness)).toBeNull();
    });

    it("teardown w trakcie odczytu gasi wskaźnik, a potem nic nie emituje", async () => {
      const { gate } = gated();
      const harness = await answered({ playGate: gate });
      expect(playing(harness)).toBe("normal");
      harness.controller.teardown();
      expect(playing(harness)).toBeNull();
      let emissions = 0;
      harness.controller.subscribe(() => { emissions += 1; });
      harness.controller.pauseActivity("blur");
      await tick();
      expect(emissions).toBe(0);
    });

    it("Dalej gasi i nie przenosi stanu", async () => {
      const { gate } = gated();
      const harness = await answered({ playGate: gate });
      harness.media.deferStart = true;
      void harness.controller.playSentenceAudio("slow");
      await tick();
      expect(harness.media.pendingStarts).toHaveLength(1);
      harness.media.pendingStarts[0]!(null);
      expect(playing(harness)).toBe("slow");
      await harness.controller.continueLearning();
      const next = harness.controller.getScreen();
      expect(next).toMatchObject({ kind: "learning", task: { taskId: "tn" }, feedback: null });
      // spóźnione zdarzenie startu poprzedniego przebiegu niczego nie ustawia
      harness.media.pendingStarts[0]!(null);
      await tick();
      expect(harness.controller.getScreen()).toBe(next);
    });

    it("spóźniony start po przerwaniu nie zapala wskaźnika na tym samym wyniku", async () => {
      const { gate } = gated();
      const harness = await answered({ playGate: gate });
      harness.media.deferStart = true;
      void harness.controller.playSentenceAudio("slow");
      await tick();
      const guidance = harness.controller.playGuidance("recall");
      await guidance.catch(() => undefined);
      harness.media.pendingStarts[0]!(null);
      await tick();
      expect(playing(harness)).toBeNull();
    });

    it("ręczny błąd: tempo i rosnący seq", async () => {
      const harness = await answered();
      harness.media.rejectNextPlays = 2;
      await harness.controller.playSentenceAudio("slow");
      expect(failure(harness)).toEqual({ rate: "slow", seq: 1 });
      expect(playing(harness)).toBeNull();
      await harness.controller.playSentenceAudio("slow");
      expect(failure(harness)).toEqual({ rate: "slow", seq: 2 });
    });

    it("błąd znika przy udanym starcie, nie przy próbie", async () => {
      const { gate, release } = gated();
      const harness = await answered({ playGate: gate });
      harness.media.rejectNextPlays = 1;
      await harness.controller.playSentenceAudio("slow");
      expect(failure(harness)).toEqual({ rate: "slow", seq: 1 });
      harness.media.deferStart = true;
      void harness.controller.playSentenceAudio("normal");
      await tick();
      expect(failure(harness)).toEqual({ rate: "slow", seq: 1 });
      harness.media.pendingStarts.at(-1)!(null);
      expect(failure(harness)).toBeNull();
      expect(playing(harness)).toBe("normal");
      release();
      await tick();
      expect(playing(harness)).toBeNull();
    });

    it("inne odtwarzanie na tym samym wyniku nie przywraca zgaszonego wskaźnika", async () => {
      const { gate } = gated();
      const state = baseState();
      state.attempts = [attemptDto({ taskId: "tg", taskState: "answered", feedback: { kind: "great", correctAudioAssetId: SENTENCE, referenceAudioAvailable: true } })];
      const harness = await startAtTask(state, gap(), { playGate: gate });
      await harness.controller.answerText("goes");
      await tick();
      expect(playing(harness)).toBe("normal");
      harness.media.deferStart = true;
      void harness.controller.playFeedbackAudio();
      expect(playing(harness)).toBeNull();
      await tick();
      expect(playing(harness)).toBeNull();
    });

    it("komunikat „?” nie zmienia błędu", async () => {
      const harness = await answered();
      harness.media.rejectNextPlays = 1;
      await harness.controller.playSentenceAudio("normal");
      expect(failure(harness)).toEqual({ rate: "normal", seq: 1 });
      await harness.controller.playGuidance("recall").catch(() => undefined);
      expect(failure(harness)).toEqual({ rate: "normal", seq: 1 });
    });
  });
});

describe("LearningSessionController — „Posłuchaj i wybierz” (lesson_listen_choice)", () => {
  // Fake API autoryzuje każde ujawnienie tym samym nagraniem.
  const STIMULUS_URL = "https://media.test/88888888-8888-4888-8888-888888888888";
  const SENTENCE = "abababab-abab-4bab-8bab-abababababab";
  const SENTENCE_URL = `https://media.test/${SENTENCE}`;
  const listen = (taskId = "tl") => taskDto(taskId, {
    kind: "lesson_listen_choice", stem: "He ___ football.", contentLocale: "en-GB",
    options: [{ id: "o1", text: "plays" }, { id: "o2", text: "play" }],
  });
  const choice = (taskId = "tc") => taskDto(taskId, { kind: "lesson_choice", instructionPl: "Wybierz", stem: "He ___.", options: [{ id: "o1", text: "goes" }] });
  const flush = () => vi.advanceTimersByTimeAsync(0);
  type Play = { url: string; onStarted?: (durationMs: number | null) => void; resolve: () => void; reject: (error: unknown) => void };

  /** Kontroler z odtwarzaczem, którego start, koniec i błąd steruje test. */
  async function startListen(state: ApiState, task: TaskDto, mode: "training" | "mock_test" = "training") {
    state.tasks = [task];
    const harness = makeHarness(state);
    const plays: Play[] = [];
    vi.spyOn(harness.media.player, "play").mockImplementation((url, onStarted) => new Promise<void>((resolve, reject) => {
      harness.media.playUrls.push(url);
      plays.push({ url, ...(onStarted ? { onStarted } : {}), resolve, reject });
    }));
    await harness.controller.start();
    await harness.controller.selectProfile(PROFILE_A.childId);
    if (mode === "mock_test") {
      await harness.controller.startMockTest(DECK.deckId);
      await harness.controller.beginMockTest();
    } else {
      await harness.controller.startLearning(DECK.deckId);
    }
    await flush();
    return { ...harness, plays };
  }

  const screenOf = (harness: { controller: LearningSessionController }) => harness.controller.getScreen() as LearningScreen;
  const stimulusOf = (harness: { controller: LearningSessionController }) => screenOf(harness).listenStimulus;

  it("po wyświetleniu autoryzuje raz i odtwarza zdanie; opcje otwiera dopiero koniec odsłuchu", async () => {
    vi.useFakeTimers();
    try {
      const state = baseState();
      const harness = await startListen(state, listen());
      expect(state.disclosures).toEqual([{ taskId: "tl", kind: "audio" }]);
      expect(harness.plays.map((play) => play.url)).toEqual([STIMULUS_URL]);
      expect(stimulusOf(harness)).toEqual({ taskId: "tl", state: "pending", playing: false });
      harness.plays[0]!.onStarted?.(3_000);
      expect(stimulusOf(harness)).toEqual({ taskId: "tl", state: "pending", playing: true });
      harness.plays[0]!.resolve();
      await flush();
      expect(stimulusOf(harness)).toEqual({ taskId: "tl", state: "open", playing: false });
      expect(screenOf(harness)).toMatchObject({ error: null, offline: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("powtórka w połowie nie odblokowuje opcji — dopiero koniec drugiego odsłuchu", async () => {
    vi.useFakeTimers();
    try {
      const state = baseState();
      const harness = await startListen(state, listen());
      harness.plays[0]!.onStarted?.(3_000);
      void harness.controller.playTaskAudio();
      await flush();
      expect(state.disclosures).toHaveLength(2);
      expect(harness.plays).toHaveLength(2);
      // przerwane odtwarzanie rozstrzyga się jak koniec — nie może otworzyć opcji
      harness.plays[0]!.resolve();
      await flush();
      expect(stimulusOf(harness)?.state).toBe("pending");
      // zapas pierwszego odsłuchu (3000 + 1000 ms) nie działa po przerwaniu
      await vi.advanceTimersByTimeAsync(4_500);
      expect(stimulusOf(harness)?.state).toBe("pending");
      harness.plays[1]!.onStarted?.(3_000);
      expect(stimulusOf(harness)).toMatchObject({ state: "pending", playing: true });
      harness.plays[1]!.resolve();
      await flush();
      expect(stimulusOf(harness)).toEqual({ taskId: "tl", state: "open", playing: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bez zdarzenia końca otwiera opcje po długości nagrania + 1 s", async () => {
    vi.useFakeTimers();
    try {
      const harness = await startListen(baseState(), listen());
      harness.plays[0]!.onStarted?.(3_000);
      await vi.advanceTimersByTimeAsync(3_999);
      expect(stimulusOf(harness)?.state).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(stimulusOf(harness)?.state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bez znanej długości nagrania zapas wynosi 8 s", async () => {
    vi.useFakeTimers();
    try {
      const harness = await startListen(baseState(), listen());
      harness.plays[0]!.onStarted?.(null);
      await vi.advanceTimersByTimeAsync(7_999);
      expect(stimulusOf(harness)?.state).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(stimulusOf(harness)?.state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("autoryzacja wisząca 6 s daje „unavailable” (Pomiń), a przycisk nadal działa", async () => {
    vi.useFakeTimers();
    try {
      const state = baseState();
      let release!: () => void;
      state.disclosureGate = new Promise<void>((resolve) => { release = resolve; });
      const harness = await startListen(state, listen());
      await vi.advanceTimersByTimeAsync(5_999);
      expect(stimulusOf(harness)?.state).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(stimulusOf(harness)).toEqual({ taskId: "tl", state: "unavailable", playing: false });
      expect(screenOf(harness)).toMatchObject({ error: null, offline: false });
      expect(screenOf(harness).taskAudioError ?? null).toBeNull();
      // ręczna powtórka: nowa autoryzacja; spóźniona pierwsza nic nie odtwarza
      void harness.controller.playListenStimulus();
      await flush();
      expect(state.disclosures).toHaveLength(2);
      release();
      await flush();
      expect(harness.plays).toHaveLength(1);
      harness.plays[0]!.onStarted?.(2_000);
      harness.plays[0]!.resolve();
      await flush();
      expect(stimulusOf(harness)?.state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("spóźniona autoryzacja po „Pomiń”: zablokowane autoodtwarzanie nie cofa do „blocked”, udane otwiera opcje", async () => {
    for (const outcome of ["blocked", "played"] as const) {
      vi.useFakeTimers();
      try {
        const state = baseState();
        let release!: () => void;
        state.disclosureGate = new Promise<void>((resolve) => { release = resolve; });
        const harness = await startListen(state, listen());
        await vi.advanceTimersByTimeAsync(6_000);
        expect(stimulusOf(harness)?.state, outcome).toBe("unavailable");
        release();
        await flush();
        expect(harness.plays, outcome).toHaveLength(1);
        if (outcome === "blocked") {
          harness.plays[0]!.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
          await flush();
          // „Pomiń” zostaje — licznik już wygasł, więc powrót do „blocked” nie miałby wyjścia.
          expect(stimulusOf(harness), outcome).toEqual({ taskId: "tl", state: "unavailable", playing: false });
          await vi.advanceTimersByTimeAsync(10_000);
          expect(stimulusOf(harness)?.state, outcome).toBe("unavailable");
        } else {
          harness.plays[0]!.onStarted?.(2_000);
          harness.plays[0]!.resolve();
          await flush();
          expect(stimulusOf(harness)?.state, outcome).toBe("open");
        }
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("NotAllowedError daje „blocked”; ręczne naciśnięcie odtwarza i otwiera opcje", async () => {
    vi.useFakeTimers();
    try {
      const harness = await startListen(baseState(), listen());
      harness.plays[0]!.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
      await flush();
      expect(stimulusOf(harness)).toEqual({ taskId: "tl", state: "blocked", playing: false });
      expect(screenOf(harness).taskAudioError ?? null).toBeNull();
      expect(screenOf(harness).error).toBeNull();
      void harness.controller.playTaskAudio();
      await flush();
      expect(stimulusOf(harness)?.state).toBe("pending");
      harness.plays[1]!.onStarted?.(2_000);
      harness.plays[1]!.resolve();
      await flush();
      expect(stimulusOf(harness)?.state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("„blocked” bez naciśnięcia: po 6 s od żądania „unavailable” (Pomiń), przycisk nadal działa", async () => {
    vi.useFakeTimers();
    try {
      const harness = await startListen(baseState(), listen());
      harness.plays[0]!.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
      await flush();
      await vi.advanceTimersByTimeAsync(5_900);
      expect(stimulusOf(harness)?.state).toBe("blocked");
      await vi.advanceTimersByTimeAsync(100);
      expect(stimulusOf(harness)).toEqual({ taskId: "tl", state: "unavailable", playing: false });
      expect(screenOf(harness).taskAudioError ?? null).toBeNull();
      void harness.controller.playListenStimulus();
      await flush();
      harness.plays[1]!.onStarted?.(2_000);
      harness.plays[1]!.resolve();
      await flush();
      expect(stimulusOf(harness)?.state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ręczne naciśnięcie zablokowane przez przeglądarkę: „unavailable” (Pomiń) i widoczny komunikat, bez pętli „blocked”", async () => {
    vi.useFakeTimers();
    try {
      const state = baseState();
      const harness = await startListen(state, listen());
      harness.plays[0]!.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
      await flush();
      expect(stimulusOf(harness)?.state).toBe("blocked");
      void harness.controller.playListenStimulus();
      await flush();
      harness.plays[1]!.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
      await flush();
      expect(stimulusOf(harness)).toEqual({ taskId: "tl", state: "unavailable", playing: false });
      expect(screenOf(harness)).toMatchObject({ error: null, offline: false, taskAudioError: "blocked" });
      // „Pomiń” wysyła pominięcie i gasi komunikat o nagraniu (feedback nie niesie starego błędu).
      state.attempts = [attemptDto({ taskId: "tl", modality: "skip", taskState: "answered", feedback: { kind: "not_assessed" } })];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      vi.spyOn(harness.api, "submitAnswer").mockImplementation(async (input) => { await gate; return makeApi(harness.state).submitAnswer(input); });
      const pending = harness.controller.skip();
      await flush();
      // komunikat gaśnie już przy wysłaniu (tylko w „Posłuchaj i wybierz”), przed werdyktem
      expect(screenOf(harness)).toMatchObject({ busy: true });
      expect(screenOf(harness).taskAudioError ?? null).toBeNull();
      release();
      await pending;
      await flush();
      expect(state.submissions).toMatchObject([{ taskId: "tl", modality: "skip" }]);
      expect(screenOf(harness).taskAudioError ?? null).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("odmowa autoryzacji (409) przy autoodtwarzaniu: „unavailable” bez ekranu błędu; ręczna — widoczny komunikat", async () => {
    vi.useFakeTimers();
    try {
      const state = baseState();
      state.disclosureError = new KidApiError("conflict", false);
      const harness = await startListen(state, listen());
      expect(harness.plays).toEqual([]);
      expect(stimulusOf(harness)).toEqual({ taskId: "tl", state: "unavailable", playing: false });
      expect(screenOf(harness)).toMatchObject({ error: null, offline: false, busy: false });
      expect(screenOf(harness).taskAudioError ?? null).toBeNull();
      await harness.controller.playTaskAudio();
      await flush();
      expect(stimulusOf(harness)?.state).toBe("unavailable");
      expect(screenOf(harness)).toMatchObject({ error: null, taskAudioError: "failed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("błąd pliku przy autoodtwarzaniu jest cichy, ręczny daje komunikat", async () => {
    vi.useFakeTimers();
    try {
      const harness = await startListen(baseState(), listen());
      harness.plays[0]!.reject(new Error("decode failed"));
      await flush();
      expect(stimulusOf(harness)?.state).toBe("unavailable");
      expect(screenOf(harness).taskAudioError ?? null).toBeNull();
      void harness.controller.playListenStimulus();
      await flush();
      harness.plays[1]!.reject(new Error("decode failed"));
      await flush();
      expect(stimulusOf(harness)?.state).toBe("unavailable");
      expect(screenOf(harness).taskAudioError).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("błąd sieci idzie ścieżką offline; ponowienie nie autoodtwarza i zostawia zadanie", async () => {
    vi.useFakeTimers();
    try {
      const state = baseState();
      state.disclosureError = new TypeError("fetch failed");
      const harness = await startListen(state, listen());
      expect(screenOf(harness)).toMatchObject({ offline: true, task: { taskId: "tl" } });
      expect(stimulusOf(harness)?.state).toBe("pending");
      state.disclosureError = undefined;
      const nextTaskCalls = state.nextTaskCalls;
      await harness.controller.retry();
      await flush();
      expect(screenOf(harness)).toMatchObject({ offline: false, busy: false, task: { taskId: "tl" } });
      expect(state.disclosures).toHaveLength(1);
      expect(state.nextTaskCalls).toBe(nextTaskCalls);
      expect(harness.plays).toEqual([]);
      // Bez odsłuchu po powrocie: status i wyróżniony głośnik zamiast cichego „pending”.
      expect(stimulusOf(harness)?.state).toBe("blocked");
    } finally {
      vi.useRealTimers();
    }
  });

  it("po powrocie z offline (markOffline → retry) bez ponownego autoodtwarzania; stan bodźca zostaje", async () => {
    vi.useFakeTimers();
    try {
      const state = baseState();
      const harness = await startListen(state, listen());
      const nextTaskCalls = state.nextTaskCalls;
      // offline w trakcie autoodtwarzania: przerwane odtwarzanie nie otwiera opcji
      harness.plays[0]!.onStarted?.(3_000);
      harness.controller.markOffline();
      harness.plays[0]!.resolve();
      await harness.controller.retry();
      await flush();
      expect(screenOf(harness)).toMatchObject({ offline: false, busy: false, task: { taskId: "tl" } });
      // Bodziec nieotwarty: „blocked” (status + wyróżniony głośnik), po 6 s „Pomiń”.
      expect(stimulusOf(harness)).toEqual({ taskId: "tl", state: "blocked", playing: false });
      await vi.advanceTimersByTimeAsync(5_900);
      expect(stimulusOf(harness)?.state).toBe("blocked");
      await vi.advanceTimersByTimeAsync(100);
      expect(stimulusOf(harness)).toEqual({ taskId: "tl", state: "unavailable", playing: false });
      expect(state.disclosures).toHaveLength(1);
      expect(state.nextTaskCalls).toBe(nextTaskCalls);
      expect(harness.plays).toHaveLength(1);
      // ręczne odsłuchanie otwiera opcje; kolejne offline → retry ich nie resetuje
      void harness.controller.playListenStimulus();
      await flush();
      harness.plays[1]!.onStarted?.(2_000);
      harness.plays[1]!.resolve();
      await flush();
      expect(stimulusOf(harness)?.state).toBe("open");
      harness.controller.markOffline();
      await harness.controller.retry();
      await flush();
      expect(screenOf(harness)).toMatchObject({ offline: false, task: { taskId: "tl" } });
      expect(stimulusOf(harness)).toEqual({ taskId: "tl", state: "open", playing: false });
      expect(state.disclosures).toHaveLength(2);
      expect(state.nextTaskCalls).toBe(nextTaskCalls);
      expect(harness.plays).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("przerwany odsłuch (potwierdzenie końca, tło, blur) przechodzi w „blocked”, a po 6 s w „Pomiń”", async () => {
    for (const interrupt of ["endConfirm", "background", "blur"] as const) {
      vi.useFakeTimers();
      try {
        const harness = await startListen(baseState(), listen());
        harness.plays[0]!.onStarted?.(3_000);
        if (interrupt === "endConfirm") harness.controller.holdForEndConfirm();
        else harness.controller.pauseActivity(interrupt);
        harness.plays[0]!.resolve();
        await flush();
        // Przerwanie nie otwiera opcji i nie zostawia cichego „pending” bez wyjścia.
        expect(stimulusOf(harness), interrupt).toEqual({ taskId: "tl", state: "blocked", playing: false });
        if (interrupt === "endConfirm") harness.controller.releaseEndConfirm();
        await vi.advanceTimersByTimeAsync(5_900);
        expect(stimulusOf(harness)?.state, interrupt).toBe("blocked");
        await vi.advanceTimersByTimeAsync(100);
        expect(stimulusOf(harness)?.state, interrupt).toBe("unavailable");
        expect(harness.plays, interrupt).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("kolejne przerwanie bodźca już zablokowanego uzbraja „Pomiń” od nowa", async () => {
    for (const second of ["blur", "endConfirm", "offlineRetry"] as const) {
      vi.useFakeTimers();
      try {
        const harness = await startListen(baseState(), listen());
        // zablokowane autoodtwarzanie → „blocked” z licznikiem 6 s
        harness.plays[0]!.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
        await flush();
        expect(stimulusOf(harness)?.state, second).toBe("blocked");
        await vi.advanceTimersByTimeAsync(3_000);
        if (second === "blur") harness.controller.pauseActivity("blur");
        else if (second === "endConfirm") {
          harness.controller.holdForEndConfirm();
          harness.controller.releaseEndConfirm();
        } else {
          harness.controller.markOffline();
          await harness.controller.retry();
        }
        await flush();
        expect(stimulusOf(harness)?.state, second).toBe("blocked");
        // licznik liczy od przerwania, nie zostaje skasowany
        await vi.advanceTimersByTimeAsync(5_900);
        expect(stimulusOf(harness)?.state, second).toBe("blocked");
        await vi.advanceTimersByTimeAsync(100);
        expect(stimulusOf(harness)?.state, second).toBe("unavailable");
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("przerwanie nie rusza bodźca otwartego ani pauzy offline", async () => {
    vi.useFakeTimers();
    try {
      const harness = await startListen(baseState(), listen());
      // pauza offline ma własne wznowienie (#listenResume po „Spróbuj ponownie”)
      harness.controller.pauseActivity("offline");
      await flush();
      expect(stimulusOf(harness)?.state).toBe("pending");
      void harness.controller.playListenStimulus();
      await flush();
      harness.plays[1]!.onStarted?.(2_000);
      harness.plays[1]!.resolve();
      await flush();
      expect(stimulusOf(harness)?.state).toBe("open");
      harness.controller.holdForEndConfirm();
      harness.controller.pauseActivity("blur");
      await flush();
      expect(stimulusOf(harness)?.state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("zadanie listen z prefetchu po „Dalej” dostaje dokładnie jedną autoryzację", async () => {
    vi.useFakeTimers();
    try {
      const state = baseState();
      state.attempts = [attemptDto({ taskId: "tl", modality: "choice", taskState: "answered", feedback: { kind: "great" } })];
      const harness = await startListen(state, listen("tl"));
      harness.plays[0]!.onStarted?.(2_000);
      harness.plays[0]!.resolve();
      await flush();
      state.tasks = [listen("tl2")];
      await harness.controller.answerChoice("o1");
      await flush();
      // następne zadanie pobrane w tle przy feedbacku — jeszcze bez autoryzacji
      expect(state.tasks).toEqual([]);
      expect(state.disclosures).toEqual([{ taskId: "tl", kind: "audio" }]);
      const nextTaskCalls = state.nextTaskCalls;
      await harness.controller.continueLearning();
      await flush();
      expect(state.nextTaskCalls).toBe(nextTaskCalls);
      expect(screenOf(harness)).toMatchObject({ task: { taskId: "tl2" }, listenStimulus: { taskId: "tl2", state: "pending" } });
      expect(state.disclosures).toEqual([{ taskId: "tl", kind: "audio" }, { taskId: "tl2", kind: "audio" }]);
      expect(harness.plays).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("w trakcie autoryzacji nie da się odpowiedzieć, a spóźniona autoryzacja po zmianie zadania nic nie odtwarza", async () => {
    vi.useFakeTimers();
    try {
      const state = baseState();
      let release!: () => void;
      state.disclosureGate = new Promise<void>((resolve) => { release = resolve; });
      const harness = await startListen(state, listen());
      expect(stimulusOf(harness)?.state).toBe("pending");
      await harness.controller.answerChoice("o1");
      expect(state.submissions).toEqual([]);
      state.tasks = [choice()];
      await harness.controller.skip();
      expect(state.submissions).toMatchObject([{ taskId: "tl", modality: "skip" }]);
      await harness.controller.continueLearning();
      expect(screenOf(harness)).toMatchObject({ task: { taskId: "tc" }, listenStimulus: null });
      release();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.plays).toEqual([]);
      expect(state.disclosures).toHaveLength(1);
      expect(screenOf(harness)).toMatchObject({ task: { taskId: "tc" }, listenStimulus: null, error: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("zmiana zadania gasi odtwarzanie i stopery poprzedniego — nowe zadanie czeka na własny odsłuch", async () => {
    vi.useFakeTimers();
    try {
      const state = baseState();
      const harness = await startListen(state, listen("tl"));
      harness.plays[0]!.onStarted?.(3_000);
      state.tasks = [listen("tl2")];
      await harness.controller.skip();
      expect(stimulusOf(harness)).toMatchObject({ taskId: "tl", playing: false });
      await harness.controller.continueLearning();
      await flush();
      expect(screenOf(harness)).toMatchObject({ task: { taskId: "tl2" }, listenStimulus: { taskId: "tl2", state: "pending" } });
      expect(state.disclosures).toEqual([{ taskId: "tl", kind: "audio" }, { taskId: "tl2", kind: "audio" }]);
      // stoper zapasu poprzedniego zadania (4000 ms) nie otwiera nowego
      harness.plays[0]!.resolve();
      await vi.advanceTimersByTimeAsync(4_500);
      expect(stimulusOf(harness)).toMatchObject({ taskId: "tl2", state: "pending" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stan „open” zostaje po nieocenionej próbie; odczyt zdania po odpowiedzi pokazuje odtwarzanie", async () => {
    vi.useFakeTimers();
    try {
      const state = baseState();
      state.attempts = [
        attemptDto({ taskId: "tl", modality: "choice", taskState: "issued", feedback: { kind: "not_assessed" } }),
        attemptDto({ taskId: "tl", modality: "choice", taskState: "answered", feedback: { kind: "great", correctAudioAssetId: SENTENCE } }),
      ];
      const harness = await startListen(state, listen());
      harness.plays[0]!.onStarted?.(2_000);
      harness.plays[0]!.resolve();
      await flush();
      await harness.controller.answerChoice("o1");
      await harness.controller.continueLearning();
      expect(stimulusOf(harness)).toEqual({ taskId: "tl", state: "open", playing: false });
      await harness.controller.answerChoice("o1");
      await flush();
      expect(state.submissions).toHaveLength(2);
      // automatyczny odczyt zdania z feedbacku (bez nowej autoryzacji bodźca)
      expect(harness.plays.map((play) => play.url)).toEqual([STIMULUS_URL, SENTENCE_URL]);
      expect(state.disclosures).toHaveLength(1);
      harness.plays[1]!.onStarted?.(2_000);
      expect(stimulusOf(harness)).toEqual({ taskId: "tl", state: "open", playing: true });
      harness.plays[1]!.resolve();
      await flush();
      expect(stimulusOf(harness)).toEqual({ taskId: "tl", state: "open", playing: false });
      // po odpowiedzi przycisk bodźca nie autoryzuje ponownie
      await harness.controller.playListenStimulus();
      expect(state.disclosures).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bez autoodtwarzania w kartkówce, przy pendingAttemptId i w zwykłym wyborze", async () => {
    vi.useFakeTimers();
    try {
      const mock = baseState();
      const mockHarness = await startListen(mock, listen(), "mock_test");
      expect(screenOf(mockHarness)).toMatchObject({ task: { taskId: "tl" }, session: { mode: "mock_test" } });
      expect(mock.disclosures).toEqual([]);
      expect(mockHarness.plays).toEqual([]);

      const pending = baseState();
      const harness = await startListen(pending, { ...listen(), pendingAttemptId: "99999999-9999-4999-8999-999999999999" });
      expect(pending.disclosures).toEqual([]);
      expect(harness.plays).toEqual([]);

      const plain = baseState();
      const choiceHarness = await startListen(plain, choice());
      expect(screenOf(choiceHarness)).toMatchObject({ task: { taskId: "tc" } });
      expect(stimulusOf(choiceHarness) ?? null).toBeNull();
      expect(plain.disclosures).toEqual([]);
      expect(choiceHarness.plays).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
