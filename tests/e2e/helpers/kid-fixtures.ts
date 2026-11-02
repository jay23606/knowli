import type { FeedbackDto, KidDeckDto, TaskDto } from "@learning/contracts";
import type { Page } from "@playwright/test";
import { installKidUiFixture, type KidUiFixture } from "./kid-ui-fixture";
import { lessonAudioFixture } from "./lesson-audio";

/** Shared builders of mocked Kid UI sessions: one profile, one deck, a written recall task. */

export const childId = "10000000-0000-4000-8000-000000000001";
export const deckId = "10000000-0000-4000-8000-000000000002";
export const sessionId = "10000000-0000-4000-8000-000000000003";
export const taskId = "10000000-0000-4000-8000-000000000004";
export const attemptId = "10000000-0000-4000-8000-000000000010";
const assetId = "10000000-0000-4000-8000-000000000006";
const optionIds = ["10000000-0000-4000-8000-000000000007", "10000000-0000-4000-8000-000000000008", "10000000-0000-4000-8000-000000000009"];

export function baseFixture() {
  return {
    profiles: [{ childId, displayName: "Szymon", avatarKey: "cat", recordingMode: "hold" as const }],
    decks: [{ deckId, title: "Dni tygodnia", itemCount: 7, independentlyRecalledCount: 0, testDate: null,
      recommended: true, mockTestAvailable: false, activeSession: null }],
    session: { mode: "training" as const, sessionId, childId, deckId, deckVersionId: "10000000-0000-4000-8000-000000000005",
      policyId: "default", microphoneEnabled: false, state: "active" as const, taskBudget: 1, tasksIssued: 1,
      assessedTasksIssued: 1, startedAt: "2026-10-11T10:00:00.000Z", resumed: false },
  };
}

/** The base session with one written recall task (nothing answered yet); `recordingMode` is the profile's. */
export function recallFixture(recordingMode: "hold" | "toggle" = "hold") {
  const base = baseFixture();
  return {
    ...base,
    profiles: [{ ...base.profiles[0]!, recordingMode }],
    tasks: [{ taskId, sessionId, ordinal: 0, exerciseType: "recall" as const, direction: "source_to_target" as const,
      state: "issued" as const, prompt: { kind: "recall" as const, prompt: "kot" }, remainingAssessed: 1 }],
  };
}

/** A letter-completion task: `fragment` is the word or phrase in which "_" marks a missing letter. */
export function letterTask(prompt: string, fragment: string): TaskDto {
  return { taskId, sessionId, ordinal: 0, state: "issued", remainingAssessed: 1, exerciseType: "letter_completion",
    direction: "source_to_target", prompt: { kind: "letter_completion", prompt, fragment } };
}

/**
 * One issued task of the given prompt kind with fixed texts (the layout specs only need its shape). The picture tasks
 * show a colour and have no recording.
 */
export function taskFor(kind: TaskDto["prompt"]["kind"]): TaskDto {
  const common = { taskId, sessionId, ordinal: 0, state: "issued" as const, remainingAssessed: 1 };
  const visual = { kind: "color" as const, color: "#ff0000" };
  if (kind === "picture_exposure") return { ...common, exerciseType: "exposure", direction: null, prompt: { kind, visual, audioAssetId: null } };
  if (kind === "picture_recall") return { ...common, exerciseType: "recall", direction: null, prompt: { kind, visual } };
  if (kind === "picture_speech") return { ...common, exerciseType: "speech", direction: null, prompt: { kind, visual, audioAssetId: null } };
  if (kind === "exposure") return { ...common, exerciseType: "exposure" as const, direction: null, prompt: {
    kind: "exposure" as const, source: "kot", target: "cat", example: "The cat is sleeping.", audioAssetId: assetId,
    exampleAudioAssetId: assetId, imageAssetId: assetId, visualType: "image" as const,
  } };
  if (kind === "listening") return { ...common, exerciseType: "listening" as const, direction: "target_to_source" as const, prompt: {
    kind: "listening" as const, audioAssetId: assetId,
    options: ["marzec", "kwiecień", "październik"].map((text, index) => ({ id: optionIds[index]!, text })),
  } };
  if (kind === "reading") return { ...common, exerciseType: kind, direction: "target_to_source", prompt: {
    kind, text: "cat", options: ["kot", "pies", "ptak"].map((text, index) => ({ id: optionIds[index]!, text })),
  } };
  if (kind === "reverse_recognition") return { ...common, exerciseType: kind, direction: "target_to_source", prompt: {
    kind, prompt: "kot", options: ["cat", "dog", "bird"].map((text, index) => ({ id: optionIds[index]!, text })),
  } };
  if (kind === "spelling") return { ...common, exerciseType: "spelling" as const, direction: "source_to_target" as const, prompt: { kind, prompt: "kot" } };
  if (kind === "letter_completion") return letterTask("kot", "c_t");
  if (kind === "speech") return { ...common, exerciseType: "speech" as const, direction: "source_to_target" as const, prompt: { kind, text: "cat", audioAssetId: assetId, imageAssetId: null, visualType: "none" as const } };
  return { ...common, exerciseType: "recall" as const, direction: "source_to_target" as const, prompt: { kind: "recall" as const, prompt: "kot" } };
}

/** A written recall task answered by one completed attempt; `feedback` is what the dock shows, `prompt` the source word or sentence. */
export function completedRecallFixture({ feedback = { kind: "great" }, prompt = "kot" }: { feedback?: FeedbackDto; prompt?: string } = {}) {
  return {
    ...baseFixture(),
    tasks: [{ taskId, sessionId, ordinal: 0, exerciseType: "recall" as const, direction: "source_to_target" as const,
      state: "issued" as const, prompt: { kind: "recall" as const, prompt }, remainingAssessed: 1 }],
    attempts: [{ attemptId, taskId, state: "completed" as const, modality: "text" as const,
      feedback, taskState: "completed" as const, stepId: null,
      receivedAt: "2026-10-11T10:00:00.000Z", completedAt: "2026-10-11T10:00:01.000Z" }],
  };
}

const HINT_START = "The children walked along the old wooden bridge near the river, ";
const HINT_FIX = "counting the little boats";
const HINT_END = " that sailed slowly towards the harbour before the sun went down behind the hills and the lights came on.";

/**
 * A spelling hint with a long sentence and one wrong fragment: about 600 inner px of card. Under a short prompt the card
 * grows into the free space (spec 2026-10-31-kid-ui-dock-followups §3.1); under the long prompt of
 * `kid-large-screen.spec.ts` there is none, the card keeps the 300 px limit and its dock (about 382 inner px over a
 * 54 px footer) covers the answer form.
 */
export const longSpellingHintFeedback: FeedbackDto = {
  kind: "spelling_hint",
  correctText: HINT_START + HINT_FIX + HINT_END,
  spellingDiff: {
    given: [{ text: HINT_START, state: "plain" }, { text: "cownting the litle bots", state: "pill" }, { text: HINT_END, state: "plain" }],
    expected: [{ text: HINT_START, state: "plain" }, { text: HINT_FIX, state: "pill" }, { text: HINT_END, state: "plain" }],
  },
};

const MEDIUM_HINT_START = "The children walked ";
const MEDIUM_HINT_END = " near the old bridge.";

/**
 * A spelling hint of medium length (spec 2026-10-31-kid-ui-dock-followups §5): each row is three segments of 20–25
 * characters, so in the 720 px column every segment takes a line of its own and each row has exactly three lines.
 * Measured (Windows, 2026-10-31): the row is 552 inner px wide, a segment 278–356 px, two neighbours with the gap at
 * least 572 px. The card is 363 inner px, taller than the 300 px card limit, and fits the free space under the answer
 * of a short prompt at 3440x1440 (card limit there 393 px).
 */
export const mediumSpellingHintFeedback: FeedbackDto = {
  kind: "spelling_hint",
  correctText: MEDIUM_HINT_START + HINT_FIX + MEDIUM_HINT_END,
  spellingDiff: {
    given: [
      { text: MEDIUM_HINT_START, state: "plain" }, { text: "cownting the litle bots", state: "pill" },
      { text: MEDIUM_HINT_END, state: "plain" },
    ],
    expected: [
      { text: MEDIUM_HINT_START, state: "plain" }, { text: HINT_FIX, state: "pill" }, { text: MEDIUM_HINT_END, state: "plain" },
    ],
  },
};

// Long enough that the written-answer material scrolls before any verdict at 1536x730 and at 390x750.
const OVERFLOWING_RECALL_PROMPT = "Przeczytaj uważnie całą historyjkę, a potem przetłumacz ostatnie zdanie na angielski. "
  + "Rano dzieci spakowały plecaki, zabrały kanapki, wodę i stary aparat dziadka, a potem wyszły z domu, zanim ktokolwiek "
  + "zdążył je zatrzymać. Szły długo polną drogą, minęły młyn, sad pełen jabłek i małą kapliczkę na rozstaju dróg, "
  + "aż w końcu dotarły nad rzekę, gdzie wiatr kołysał trzcinami, a kaczki pływały blisko brzegu. Tam usiadły na trawie, "
  + "zjadły kanapki i długo patrzyły na wodę. Dzieci szły starym drewnianym mostem nad rzeką i liczyły łódki, które "
  + "powoli płynęły do portu, zanim słońce schowało się za wzgórzami, a w miasteczku zapaliły się wszystkie światła.";

/** A written recall task whose long prompt already scrolls the material before the verdict; the dock shows `feedback`. */
export function overflowingRecallFixture(feedback: FeedbackDto = longSpellingHintFeedback): KidUiFixture {
  return completedRecallFixture({ feedback, prompt: OVERFLOWING_RECALL_PROMPT });
}

const textChoiceOptionIds = [31, 32, 33, 34].map((suffix) => `10000000-0000-4000-8000-0000000000${suffix}`);

/** A text choice (reading) with four options; the first one is answered correctly and the result panel is a real footer (flow feedback). */
export function completedTextChoiceFixture() {
  return {
    ...baseFixture(),
    tasks: [{ taskId, sessionId, ordinal: 0, exerciseType: "reading" as const, direction: "target_to_source" as const,
      state: "issued" as const, prompt: { kind: "reading" as const, text: "cat",
        options: ["kot", "pies", "ptak", "ryba"].map((text, index) => ({ id: textChoiceOptionIds[index]!, text })) },
      remainingAssessed: 1 }],
    attempts: [{ attemptId, taskId, state: "completed" as const, modality: "choice" as const,
      feedback: { kind: "great" as const }, taskState: "completed" as const, stepId: null,
      receivedAt: "2026-10-11T10:00:00.000Z", completedAt: "2026-10-11T10:00:01.000Z" }],
  };
}

/** Ids of the "Uzupełnij tekst" task below: the 0008xx range, as in lesson-cloze-layout.spec.ts (session ...803, task ...811, gaps ...820-823). */
export const clozeUid = (n: number) => `10000000-0000-4000-8000-0000000008${String(n).padStart(2, "0")}`;

/** A lesson cloze task: text with four gaps and a bank of six words (the correct ones are 'dwutlenek węgla', 'światła słonecznego', 'cukry', 'tlen'). */
export const clozeTask: TaskDto = {
  taskId: "10000000-0000-4000-8000-000000000811", sessionId: "10000000-0000-4000-8000-000000000803", ordinal: 0,
  exerciseType: "lesson_cloze", direction: null, state: "issued", remainingAssessed: 2,
  prompt: {
    kind: "lesson_cloze",
    instructionPl: "Uzupełnij tekst. Wybierz słowo do każdej luki.",
    segments: [
      { text: "Roślina pobiera z powietrza " },
      { gapId: clozeUid(20) },
      { text: ", a korzeniami czerpie z gleby wodę i rozpuszczone w niej sole mineralne. W zielonych liściach, dzięki energii " },
      { gapId: clozeUid(21) },
      { text: ", powstają " },
      { gapId: clozeUid(22) },
      { text: ". Do powietrza roślina oddaje przy tym " },
      { gapId: clozeUid(23) },
      { text: ", którym oddychają zwierzęta i ludzie." },
    ],
    words: [
      { id: clozeUid(30), text: "światła słonecznego" },
      { id: clozeUid(31), text: "tlen" },
      { id: clozeUid(32), text: "dwutlenek węgla" },
      { id: clozeUid(33), text: "azot" },
      { id: clozeUid(34), text: "cukry" },
      { id: clozeUid(35), text: "chlorofil" },
    ],
  },
};

/**
 * `clozeTask` with a longer text for the cases that need a material scrolling before the verdict: the same gaps, bank
 * and answers, the text added only after the last gap. With the gaps in the sentence (no slot list under the text) the
 * four-gap text no longer scrolls the material at 1536x730 (spec 2026-11-02-lesson-cloze-match-ux §8).
 */
export const longClozeTask: TaskDto = (() => {
  const { prompt } = clozeTask;
  if (prompt.kind !== "lesson_cloze") throw new Error("cloze fixture expected");
  const last = prompt.segments.at(-1)!;
  if ("gapId" in last) throw new Error("cloze fixture ends with text");
  const more = " Tlen powstaje w liściach i przez aparaty szparkowe trafia do powietrza. Część cukrów roślina zużywa od razu"
    + " na oddychanie i wzrost, a resztę magazynuje jako skrobię w korzeniach, bulwach, nasionach i owocach. Dlatego"
    + " rośliny są pierwszym ogniwem prawie każdego łańcucha pokarmowego na Ziemi.";
  return { ...clozeTask, prompt: { ...prompt, segments: [...prompt.segments.slice(0, -1), { text: last.text + more }] } };
})();

/** The text of a lesson card, read-only: the shared cards are frozen, so one test cannot change them for another. */
export interface LessonCardText { readonly title: string; readonly body: string; readonly examples: readonly string[] }

/** The longest lesson card: a long title, a body at the schema limit (1200 characters, bulleted) and three examples. */
export const LONG_LESSON_CARD: LessonCardText = Object.freeze({
  title: "Czym różnią się pająki od owadów żyjących w ogrodzie za domem?",
  body: (
    "Pająki nie są owadami, chociaż wiele osób tak myśli. • Pająk ma osiem nóg, a owad sześć. "
    + "• Ciało pająka składa się z dwóch części: głowotułowia i odwłoka. • Pająki nie mają czułków ani skrzydeł. "
    + "Większość pająków tka sieci z cienkich, mocnych nici, które wytwarzają kądziołki na końcu odwłoka. "
  ).repeat(5).slice(0, 1200).trim(),
  examples: Object.freeze(["Pająk krzyżak tka okrągłą sieć.", "Mucha ma sześć nóg i skrzydła.", "Kosarz ma bardzo długie nogi."]),
});

/** A lesson session whose only task is the given card (by default the longest one) with its recording. */
export function lessonCardFixture(text: LessonCardText = LONG_LESSON_CARD): KidUiFixture {
  const ids = {
    childId: "10000000-0000-4000-8000-000000000b01",
    deckId: "10000000-0000-4000-8000-000000000b02",
    sessionId: "10000000-0000-4000-8000-000000000b03",
    deckVersionId: "10000000-0000-4000-8000-000000000b04",
  };
  const card: TaskDto = {
    taskId: "10000000-0000-4000-8000-000000000b11", sessionId: ids.sessionId, ordinal: 0, exerciseType: "lesson_card",
    direction: null, state: "issued", remainingAssessed: 2,
    prompt: {
      kind: "lesson_card",
      card: { ...text, examples: [...text.examples] },
      questionAudioAssetId: "10000000-0000-4000-8000-000000000b21",
    },
  };
  return lessonAudioFixture(ids, [card], { assessedTasksIssued: 0 });
}

export function makeDeck(index: number, options: Partial<KidDeckDto> = {}): KidDeckDto {
  return {
    deckId: `10000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
    title: `Angielski zestaw ${index + 1}`,
    itemCount: 12,
    independentlyRecalledCount: 3,
    testDate: "2026-10-23",
    recommended: index % 2 === 0,
    mockTestAvailable: true,
    activeSession: null,
    ...options,
  };
}

/** Opens the deck screen of a single profile with the given decks (no task is issued). */
export async function openDeckScreen(page: Page, decks: KidDeckDto[]) {
  page.setDefaultTimeout(5_000);
  await installKidUiFixture(page, {
    profiles: [{ childId, displayName: "Szymon", avatarKey: "cat", recordingMode: "hold" }],
    decks,
    session: { mode: "training", sessionId, childId, deckId: decks[0]?.deckId ?? makeDeck(0).deckId,
      deckVersionId: "10000000-0000-4000-8000-000000000004", policyId: "default", microphoneEnabled: false,
      state: "active", taskBudget: 1, tasksIssued: 0, assessedTasksIssued: 0,
      startedAt: "2026-10-11T10:00:00.000Z", resumed: false },
    tasks: [],
  });
  await page.goto("/");
  await page.getByTestId("kid-profile").click();
}
