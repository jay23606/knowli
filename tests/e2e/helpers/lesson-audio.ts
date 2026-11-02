import { expect, type Page } from "@playwright/test";
import type { TaskDto } from "@learning/contracts";
import type { KidUiFixture } from "./kid-ui-fixture";

/**
 * Wspólne kroki speców odsłuchu lekcji szkolnej (API zaślepione w przeglądarce):
 * „Posłuchaj pytania” (design szkoły §11.4) i „Posłuchaj karty” (§12.4).
 */

export const LESSON_AUDIO_VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
];

export interface LessonAudioIds {
  childId: string;
  deckId: string;
  sessionId: string;
  deckVersionId: string;
}

/**
 * Sesja treningowa lekcji z podanymi zadaniami. `audioReady: false` — fixture
 * odpowiada na `/media` obrazkiem SVG, którego odtwarzacz nie zdekoduje (błąd
 * odtwarzania); inaczej prawidłowym WAV-em.
 */
export function lessonAudioFixture(ids: LessonAudioIds, tasks: TaskDto[], options: { audioReady?: boolean; assessedTasksIssued?: number } = {}): KidUiFixture {
  const { childId, deckId, sessionId, deckVersionId } = ids;
  const deck = {
    deckId, kind: "lesson" as const, title: "Pająki", subjectTitle: "Przyroda", itemCount: 6, testDate: null,
    independentlyRecalledCount: 0, recommended: true, mockTestAvailable: false, activeSession: null,
  };
  const session = {
    sessionId, childId, deckId, deckVersionId, mode: "training" as const, state: "active" as const, policyId: "lesson-default",
    microphoneEnabled: false, taskBudget: 3, tasksIssued: 1, assessedTasksIssued: options.assessedTasksIssued ?? 1,
    startedAt: "2026-10-30T10:00:00.000Z", resumed: false,
  };
  return {
    profiles: [{ childId, displayName: "Ola", avatarKey: "owl", recordingMode: "hold" }],
    decks: [deck],
    session,
    tasks,
    uiAudio: { ready: options.audioReady ?? true, assets: {} },
  };
}

/**
 * Najgorszy przypadek „Posłuchaj i wybierz” (`lesson_listen_choice`): zdanie
 * z luką bliskie limitowi tekstu (114 znaków) i najdłuższa z czterech opcji,
 * z którą pełne zdanie ma 193 znaki (limit nagrania 200). Treść zmyślona.
 */
export const LISTEN_WORST_CASE = {
  stem: "Every Saturday morning my grandmother and I ___ along the windy beach to the old lighthouse before the cafe opens.",
  options: [
    "were slowly walking hand in hand with our two very old, very tired and sleepy dogs",
    "walk",
    "have been walking quietly",
    "are walking",
  ],
} as const;

/** Zadanie „Posłuchaj i wybierz” (prompt bez polecenia i bez id nagrania — jak Kid DTO). */
export function listenChoiceTask(
  sessionId: string,
  taskId: string,
  optionIds: readonly string[],
  content: { stem: string; options: readonly string[] } = LISTEN_WORST_CASE,
): TaskDto {
  return {
    taskId, sessionId, ordinal: 1, exerciseType: "lesson_listen_choice", direction: null, state: "issued", remainingAssessed: 2,
    prompt: {
      kind: "lesson_listen_choice",
      stem: content.stem,
      options: content.options.map((text, index) => ({ id: optionIds[index]!, text })),
      contentLocale: "en-GB",
    },
  };
}

/**
 * Najgorszy przypadek historyjki na koniec sesji: pięć zdań, łącznie 700 znaków
 * (każde ≤ 160), pytanie po polsku na 160 znaków i trzy opcje po 80 znaków.
 * Treść zmyślona.
 */
export const STORY_WORST_CASE = {
  sentences: [
    "On a windy Saturday morning, Tom and his little sister Mia packed sandwiches, apples and a big blue blanket for a picnic by the old river.",
    "They walked slowly along the narrow path past the bakery, the library and the noisy playground, and they counted every red car on the way.",
    "At the river they found a quiet place under a tall tree, but a hungry grey goose came out of the water and looked at their lunch for a while.",
    "Mia laughed and gave the goose a small piece of bread, and soon three more geese and a family of brown ducks were standing around the blanket.",
    "When the sun went down, Tom and Mia folded the blanket, waved goodbye to all the birds and ran home to tell Mum about their lovely afternoon.",
  ],
  question: "Co zrobiła Mia, kiedy głodna szara gęś wyszła z wody i długo patrzyła na ich jedzenie leżące na dużym niebieskim kocu pod wysokim drzewem nad starą cichą rzeką?",
  options: [
    "Dała gęsi mały kawałek chleba, a potem przyszły trzy gęsi i cała rodzina kaczek.",
    "Zabrała koc i szybko pobiegła z bratem do domu, żeby opowiedzieć wszystko mamie.",
    "Policzyła czerwone auta, które mijali po drodze przez całe stare, gwarne miasto.",
  ],
} as const;

/** Historyjka na koniec sesji (`lesson_story`, poza budżetem: `remainingAssessed: 0`). */
export function storyTask(
  sessionId: string,
  taskId: string,
  options: { audioAssetId?: string; sentences?: readonly string[] } = {},
): TaskDto {
  return {
    taskId, sessionId, ordinal: 1, exerciseType: "lesson_story", direction: null, state: "issued", remainingAssessed: 0,
    prompt: {
      kind: "lesson_story",
      story: { sentences: [...(options.sentences ?? STORY_WORST_CASE.sentences)] },
      contentLocale: "en-GB",
      ...(options.audioAssetId ? { questionAudioAssetId: options.audioAssetId } : {}),
    },
  };
}

/** Pytanie o treść historyjki (`lesson_story_question`): trzy opcje bez znacznika poprawności, jak Kid DTO. */
export function storyQuestionTask(
  sessionId: string,
  taskId: string,
  optionIds: readonly string[],
  content: { question: string; options: readonly string[]; sentences: readonly string[] } = STORY_WORST_CASE,
  audioAssetId?: string,
): TaskDto {
  return {
    taskId, sessionId, ordinal: 2, exerciseType: "lesson_story_question", direction: null, state: "issued", remainingAssessed: 0,
    prompt: {
      kind: "lesson_story_question",
      question: content.question,
      options: content.options.map((text, index) => ({ id: optionIds[index]!, text })),
      story: { sentences: [...content.sentences] },
      contentLocale: "en-GB",
      ...(audioAssetId ? { questionAudioAssetId: audioAssetId } : {}),
    },
  };
}

/**
 * Atrapa odtwarzania dla bodźca słuchowego: `HTMLMediaElement.play` jest
 * podmienione (test liczy wywołania, nie słyszy dźwięku). `hold` — odtwarzanie
 * zaczyna się (`playing`) i trwa do `endListenPlayback`; `end` — kończy się
 * (`ended`) po 50 ms; `reject` — przeglądarka blokuje autoodtwarzanie
 * (`NotAllowedError`). Tryb zmienia `setListenAudioMode` w trakcie testu.
 * `pause()` nic nie robi, ale zapamiętuje element w `paused` (`listenAudioPausedWatched`)
 * i oznacza przerwanie bieżącego odtworzenia (`listenAudioPausedCurrent`).
 */
export type ListenAudioMode = "hold" | "end" | "reject";

interface ListenAudioState {
  mode: ListenAudioMode; plays: number; current: HTMLMediaElement | null; watched: HTMLMediaElement | null; paused: HTMLMediaElement[];
  /** `pause()` na `current` po jego ostatnim `play()`. */
  currentPaused: boolean;
}

export async function stubListenAudio(page: Page, mode: ListenAudioMode): Promise<void> {
  await page.addInitScript((initial: ListenAudioMode) => {
    const state: ListenAudioState = { mode: initial, plays: 0, current: null, watched: null, paused: [], currentPaused: false };
    (window as unknown as { __listenAudio: ListenAudioState }).__listenAudio = state;
    HTMLMediaElement.prototype.play = function play() {
      state.plays += 1;
      if (state.mode === "reject") return Promise.reject(new DOMException("blocked", "NotAllowedError"));
      state.current = this;
      state.currentPaused = false;
      this.dispatchEvent(new Event("playing"));
      if (state.mode === "end") setTimeout(() => this.dispatchEvent(new Event("ended")), 50);
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function pause() {
      state.paused.push(this);
      if (this === state.current) state.currentPaused = true;
    };
  }, mode);
}

/**
 * Zapamiętuje element odtwarzany teraz (ostatnie `play()`); `false`, gdy nic nie gra.
 * Potem `listenAudioPausedWatched` mówi, czy na tym elemencie wołano `pause()` — element
 * rozpoznajemy po referencji, bo odtwarzacz gra z adresów `blob:`.
 */
export async function watchListenPlayback(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const state = (window as unknown as { __listenAudio: ListenAudioState }).__listenAudio;
    state.watched = state.current;
    state.paused = [];
    return state.watched !== null;
  });
}

export async function listenAudioPausedWatched(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const state = (window as unknown as { __listenAudio: ListenAudioState }).__listenAudio;
    return state.watched !== null && state.paused.includes(state.watched);
  });
}

/** Czy element odtwarzany teraz (ostatnie udane `play()`) dostał `pause()` już po tym odtworzeniu. */
export async function listenAudioPausedCurrent(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const state = (window as unknown as { __listenAudio: ListenAudioState }).__listenAudio;
    return state.current !== null && state.currentPaused;
  });
}

export async function setListenAudioMode(page: Page, mode: ListenAudioMode): Promise<void> {
  await page.evaluate((next) => { (window as unknown as { __listenAudio: ListenAudioState }).__listenAudio.mode = next; }, mode);
}

/** Kończy trwające odtwarzanie (`ended` na ostatnio odtwarzanym elemencie). */
export async function endListenPlayback(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = (window as unknown as { __listenAudio: ListenAudioState }).__listenAudio;
    state.current?.dispatchEvent(new Event("ended"));
  });
}

export async function listenAudioPlays(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __listenAudio: ListenAudioState }).__listenAudio.plays);
}

/** Po `installKidUiFixture` otwiera pierwsze zadanie sesji w portrecie i czeka na `readyTestId`. */
export async function openLessonTask(page: Page, readyTestId: string): Promise<void> {
  await page.setViewportSize(LESSON_AUDIO_VIEWPORTS[0]!);
  await page.goto("/");
  await page.getByTestId("kid-profile").click();
  await page.getByTestId("kid-deck").click();
  await expect(page.getByTestId(readyTestId)).toBeVisible();
}

/**
 * Przy 320×480 każdy element da się przewinąć do widoku w całości, bez
 * poziomego przepełnienia strony; `minHeights` — minimalny cel dotykowy.
 */
export async function expectReachableOnSmallPhone(page: Page, minHeights: Record<string, number>): Promise<void> {
  for (const [testId, minHeight] of Object.entries(minHeights)) {
    const element = page.getByTestId(testId);
    await element.scrollIntoViewIfNeeded();
    const bounds = (await element.boundingBox())!;
    expect(bounds.y, `${testId} top`).toBeGreaterThanOrEqual(-1);
    expect(bounds.y + bounds.height, `${testId} bottom`).toBeLessThanOrEqual(481);
    expect(bounds.x + bounds.width, `${testId} right`).toBeLessThanOrEqual(321);
    expect(bounds.height, `${testId} height`).toBeGreaterThanOrEqual(minHeight);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
}
