import { expect, test, type Page } from "@playwright/test";
import { messages } from "@learning/contracts";

/**
 * Ton lektora i nagrania pytań i kart w edytorze lekcji szkolnej (spec tonu
 * TTS §4.5, §8): „Ton lektora” trafia do patcha (bez stanu nagrań), „Nagraj
 * ponownie” woła nową procedurę, sterowanie zależy od stanu nagrania (w trakcie
 * nagrywania można odsłuchać poprzednie ujęcie), błąd znika po zmianie stanu
 * nagrania, a przy 320 px nic nie wychodzi poza ekran. API rodzica zaślepione w przeglądarce.
 */

const deckId = "00000000-0000-4000-8000-0000000000f1";
const draftId = "00000000-0000-4000-8000-0000000000f2";
const OBJ = "school.map.scale";
const uuid = (n: number) => `00000000-0000-4000-8000-0000000003${String(n).padStart(2, "0")}`;

const openAnswer = (n: number, audio: { state: "ready" | "pending" | "failed"; assetId?: string; previousAssetId?: string }, voiceTone?: string) => ({
  id: uuid(n), revisionId: uuid(n + 50), exerciseType: "lesson_open_answer", objectiveId: OBJ,
  instructionPl: "Odpowiedz jednym zdaniem.", prompt: `Czym jest skala mapy (${n})?`, answer: "Stosunek odległości na mapie do odległości w terenie.",
  acceptedAnswers: [], focus: [], questionType: "definition", expectedForm: "one_sentence",
  requiredElements: [{ id: "e1", text: "stosunek odległości" }, { id: "e2", text: "mapa a teren" }],
  supplementaryElements: [], commonErrors: [],
  sourceRefs: [{ quote: "Skala mapy to stosunek odległości na mapie do odległości w terenie." }],
  promptAudio: audio,
  ...(voiceTone ? { voiceTone } : {}),
});

const draft = {
  id: draftId, deckId, editNumber: 2, status: "draft", title: "Mapa", subjectId: "school", topicId: "map", topicVersion: 1,
  subjectTitlePl: "Geografia", objectiveIds: [OBJ], examples: {},
  voiceTones: { styleEnabled: true } as { styleEnabled: boolean } | undefined,
  dynamicTopic: { titlePl: "Posługuję się mapą", objectives: [{ id: OBJ, titlePl: "Skala mapy", cards: [
    { title: "Skala", body: "Skala mówi, ile razy odległość na mapie jest mniejsza niż w terenie.", voiceTone: "mysterious" },
    { title: "Przykład", body: "1:25 000 — 1 cm to 250 m." },
  ] }] },
  exercises: [
    openAnswer(10, { state: "ready", assetId: uuid(90) }, "cheerful"),
    openAnswer(11, { state: "pending", previousAssetId: uuid(92) }),
    openAnswer(12, { state: "failed", previousAssetId: uuid(93) }),
  ],
  cardAudio: [
    { objectiveId: OBJ, cardIndex: 0, audio: { state: "ready", assetId: uuid(91) } },
    { objectiveId: OBJ, cardIndex: 1, audio: { state: "failed" } },
  ],
  assets: [], rejectedCount: 0, coverage: [],
};

const lesson = {
  id: deckId, title: "Mapa", state: "draft", sessionTaskBudget: 20,
  draft, published: null, generation: null, assignments: [],
  grading: { available: true, model: "test-grader" },
};

interface Calls {
  requests: Array<{ method: string; path: string; body: unknown }>;
  /** Kolejne odczyty lekcji widzą nagranie karty 1 jako trwające. */
  markCardPending: () => void;
}

async function openLesson(page: Page, options: { cardRegenerateFails?: boolean; subjectId?: string; styleEnabled?: boolean; explanations?: boolean } = {}): Promise<Calls> {
  // Przedmiot bez nagrań pytań i kart nie dostaje `voiceTones` (jak z serwera).
  let current: typeof draft = options.subjectId ? { ...draft, subjectId: options.subjectId, voiceTones: undefined }
    : options.styleEnabled === false ? { ...draft, voiceTones: { styleEnabled: false } }
      : options.explanations ? {
        ...draft,
        exerciseExplanations: true,
        exercises: draft.exercises.map((exercise, index) => (index === 0
          ? { ...exercise, explanationPl: "Skala pokazuje, ile razy zmniejszono teren.", explanationAudio: { state: "ready", assetId: uuid(94) } }
          : exercise)),
      } as unknown as typeof draft : draft;
  const calls: Calls = {
    requests: [],
    markCardPending: () => {
      current = { ...current, cardAudio: [current.cardAudio[0]!, { objectiveId: OBJ, cardIndex: 1, audio: { state: "pending" } }] };
    },
  };
  await page.route("**/api/v1/parent/**", (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    calls.requests.push({ method, path, body: method === "GET" ? null : request.postDataJSON() });
    if (path.endsWith("/login")) return route.fulfill({ json: { authenticated: true, setupRequired: false } });
    if (path.endsWith("/lesson-catalog")) return route.fulfill({ json: { subjects: [] } });
    if (path.endsWith("/decks")) return route.fulfill({ json: [{ deckId, title: lesson.title, state: "draft", kind: "lesson", editableVersionId: draftId, publishedVersionId: null }] });
    if (path.endsWith(`/lessons/${deckId}`)) return route.fulfill({ json: { ...lesson, draft: current } });
    if (method === "PATCH" && path.endsWith(`/lesson-drafts/${draftId}`)) {
      const body = request.postDataJSON() as { exercises: Array<{ voiceTone?: string }> };
      current = {
        ...current,
        editNumber: current.editNumber + 1,
        exercises: current.exercises.map((exercise, index) => {
          const { voiceTone: _previous, ...rest } = exercise as typeof exercise & { voiceTone?: string };
          const tone = body.exercises[index]?.voiceTone;
          return { ...rest, ...(tone ? { voiceTone: tone } : {}) };
        }),
      };
      return route.fulfill({ json: current });
    }
    if (method === "POST" && path.endsWith(`/lesson-drafts/${draftId}/prompt-audio/regenerate`)) {
      return route.fulfill({ status: 202, json: { assetId: uuid(95) } });
    }
    if (method === "POST" && path.endsWith(`/lesson-drafts/${draftId}/card-audio/regenerate`)) {
      if (options.cardRegenerateFails) {
        return route.fulfill({ status: 500, json: { code: "internal", message: "Błąd serwera.", retryable: true, requestId: "r" } });
      }
      return route.fulfill({ status: 202, json: { assetId: uuid(96) } });
    }
    return route.fulfill({ json: [] });
  });
  // Spec w partycji mocked: odsłuch (`new Audio`) nie może sięgać do prawdziwego serwera mediów.
  await page.route("**/api/v1/media/**", (route) => route.fulfill({ status: 200, contentType: "audio/mpeg", body: "" }));
  await page.goto(`/parent/decks/${deckId}`);
  await expect(page.getByTestId("lesson-editor")).toBeVisible();
  await expect(page.getByTestId(`examples-${OBJ}`)).toBeVisible();
  return calls;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

test("ton lektora trafia do patcha bez stanu nagrań, a „Nagraj ponownie” woła procedurę nagrania pytania", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const calls = await openLesson(page);

  await page.getByTestId("exercise-edit-0").click();
  const tone = page.getByTestId("exercise-voice-tone-0");
  await expect(tone).toHaveValue("cheerful");
  await tone.selectOption("gentle");
  // Niezapisana zmiana: serwer nagrałby zapisany tekst i ton, więc „Nagraj ponownie” jest zablokowane.
  await expect(page.getByTestId("exercise-prompt-audio-1-regenerate")).toBeDisabled();
  await expect(page.getByTestId(`lesson-card-audio-${OBJ}-0-regenerate`)).toBeDisabled();
  await page.getByTestId("save-lesson").click();
  await expect.poll(() => calls.requests.filter((request) => request.method === "PATCH").length).toBe(1);

  const patch = calls.requests.find((request) => request.method === "PATCH")!.body as { exercises: Array<{ voiceTone?: string }> };
  expect(patch.exercises[0]!.voiceTone).toBe("gentle");
  expect(patch.exercises[1]!.voiceTone).toBeUndefined();
  expect(JSON.stringify(patch)).not.toContain("promptAudio");
  expect(JSON.stringify(patch)).not.toContain("cardAudio");

  // po zapisie nagranie bez zmian wraca do kontrolek, a „Nagraj ponownie” woła nową procedurę
  const regenerate = page.getByTestId("exercise-prompt-audio-0-regenerate");
  await expect(regenerate).toBeEnabled();
  await regenerate.click();
  await expect.poll(() => calls.requests.filter((request) => request.method === "POST" && request.path.endsWith("/prompt-audio/regenerate")).length).toBe(1);
  const call = calls.requests.find((request) => request.path.endsWith("/prompt-audio/regenerate"))!;
  expect(call.path).toBe(`/api/v1/parent/lesson-drafts/${draftId}/prompt-audio/regenerate`);
  expect(call.body).toMatchObject({ itemRevisionId: uuid(60) });
  // nagranie pytania wysyła to samo wejście co dotąd: bez roli
  expect(call.body).not.toHaveProperty("role");
});

test("„Nagraj ponownie” wyjaśnienia wysyła rolę explanation_audio dla rewizji ćwiczenia", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const calls = await openLesson(page, { explanations: true });
  const controls = page.getByTestId("exercise-0").getByTestId("lesson-explanation-audio");
  await expect(controls).toHaveAttribute("data-audio-state", "ready");
  await controls.getByTestId("lesson-explanation-audio-regenerate").click();
  await expect.poll(() => calls.requests.filter((request) => request.method === "POST" && request.path.endsWith("/prompt-audio/regenerate")).length).toBe(1);
  const call = calls.requests.find((request) => request.path.endsWith("/prompt-audio/regenerate"))!;
  expect(call.path).toBe(`/api/v1/parent/lesson-drafts/${draftId}/prompt-audio/regenerate`);
  expect(call.body).toEqual({ itemRevisionId: uuid(60), role: "explanation_audio" });
});

test("sterowanie nagraniami zależy od stanu: gotowe, trwające i nieudane, także dla kart", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openLesson(page);

  const ready = page.getByTestId("exercise-prompt-audio-0");
  await expect(ready).toHaveAttribute("data-audio-state", "ready");
  await expect(page.getByTestId("exercise-prompt-audio-0-listen")).toHaveText(messages.lessons.promptAudioListen);
  await expect(page.getByTestId("exercise-prompt-audio-0-regenerate")).toHaveText(messages.lessons.promptAudioRegenerate);

  await expect(page.getByTestId("exercise-prompt-audio-1")).toHaveAttribute("data-audio-state", "pending");
  await expect(page.getByTestId("exercise-prompt-audio-1-pending")).toHaveText(messages.lessons.promptAudioPending);
  // „Nagraj ponownie” także w trakcie: wyjście z nagrania zleconego w starej konfiguracji lektora.
  await expect(page.getByTestId("exercise-prompt-audio-1-regenerate")).toBeVisible();
  await expect(page.getByTestId("exercise-prompt-audio-1-listen")).toHaveCount(0);
  await expect(page.getByTestId("exercise-prompt-audio-1-listen-previous")).toHaveText(messages.lessons.promptAudioListenPrevious);

  await expect(page.getByTestId("exercise-prompt-audio-2")).toHaveAttribute("data-audio-state", "failed");
  await expect(page.getByTestId("exercise-prompt-audio-2-failed")).toHaveText(messages.lessons.promptAudioFailed);
  await expect(page.getByTestId("exercise-prompt-audio-2-regenerate")).toBeVisible();
  await expect(page.getByTestId("exercise-prompt-audio-2-listen")).toHaveCount(0);
  await expect(page.getByTestId("exercise-prompt-audio-2-listen-previous")).toHaveText(messages.lessons.promptAudioListenPrevious);

  await expect(page.getByTestId(`lesson-card-audio-${OBJ}-0-listen`)).toBeVisible();
  await expect(page.getByTestId(`lesson-card-audio-${OBJ}-0-regenerate`)).toBeVisible();
  await expect(page.getByTestId(`lesson-card-audio-${OBJ}-1-failed`)).toHaveText(messages.lessons.promptAudioFailed);
  await expect(page.getByTestId(`lesson-card-audio-${OBJ}-1-regenerate`)).toBeVisible();

  // karta ma własną podpowiedź tonu, ćwiczenie — własną
  await expect(page.getByTestId(`dynamic-card-voice-tone-${OBJ}-0`)).toHaveValue("mysterious");
  await expect(page.getByTestId(`examples-${OBJ}`)).toContainText(messages.lessons.voiceToneCardHint);
  await page.getByTestId("exercise-edit-0").click();
  await expect(page.getByTestId("exercise-0")).toContainText(messages.lessons.voiceToneHint);
  // Wiele przycisków „Posłuchaj” na stronie: nazwa dostępności mówi, czego dotyczy.
  await expect(page.getByTestId("exercise-prompt-audio-0-listen")).toHaveAccessibleName("Posłuchaj: Ćwiczenie 1");
  await expect(page.getByTestId("exercise-prompt-audio-2-listen-previous")).toHaveAccessibleName("Posłuchaj poprzedniego: Ćwiczenie 3");
  await expect(page.getByTestId(`lesson-card-audio-${OBJ}-0-listen`)).toHaveAccessibleName("Posłuchaj: Skala mapy, karta 1 — Skala");
  await expect(page.getByTestId(`lesson-card-audio-${OBJ}-1-regenerate`)).toHaveAccessibleName("Nagraj ponownie: Skala mapy, karta 2 — Przykład");
  // Pytania nie są szeptane: „Tajemniczo” tylko przy karcie.
  await expect(page.getByTestId("exercise-voice-tone-0").locator('option[value="mysterious"]')).toHaveCount(0);
  await expect(page.getByTestId(`dynamic-card-voice-tone-${OBJ}-0`).locator('option[value="mysterious"]')).toHaveCount(1);
});

test("„Posłuchaj poprzedniego” odtwarza poprzednie ujęcie, gdy nowe się nagrywa", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    const played: string[] = [];
    (window as unknown as { __played: string[] }).__played = played;
    HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
      played.push(this.src);
      return Promise.resolve();
    };
  });
  await openLesson(page);
  await page.getByTestId("exercise-prompt-audio-1-listen-previous").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __played: string[] }).__played))
    .toEqual([expect.stringContaining(`/api/v1/media/${uuid(92)}`)]);
});

test("błąd „Nagraj ponownie” karty znika, gdy zmieni się stan nagrania", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const calls = await openLesson(page, { cardRegenerateFails: true });
  await page.getByTestId(`lesson-card-audio-${OBJ}-1-regenerate`).click();
  await expect.poll(() => calls.requests.some((request) => request.path.endsWith("/card-audio/regenerate"))).toBe(true);
  const call = calls.requests.find((request) => request.path.endsWith("/card-audio/regenerate"))!;
  expect(call.body).toMatchObject({ objectiveId: OBJ, cardIndex: 1 });
  await expect(page.getByTestId(`lesson-card-audio-${OBJ}-1-error`)).toBeVisible();
  // Nagranie karty rusza mimo błędu odpowiedzi (np. z innej karty przeglądarki); odpytywanie
  // (trwa przez nagrywające się pytanie) przynosi nowy stan karty i czyści błąd.
  calls.markCardPending();
  await expect(page.getByTestId(`lesson-card-audio-${OBJ}-1-pending`)).toBeVisible();
  await expect(page.getByTestId(`lesson-card-audio-${OBJ}-1-error`)).toHaveCount(0);
});

test("ton wyłączony na serwerze (UMIEM_TTS_STYLE=none): pola tonu zostają, podpowiedź mówi, że nagrania brzmią domyślnie", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openLesson(page, { styleEnabled: false });
  await expect(page.getByTestId(`dynamic-card-voice-tone-${OBJ}-0`)).toHaveValue("mysterious");
  await expect(page.getByTestId(`examples-${OBJ}`)).toContainText(messages.lessons.voiceToneStyleOff);
  await expect(page.getByTestId(`examples-${OBJ}`)).not.toContainText(messages.lessons.voiceToneCardHint);
});

test("przedmiot bez nagrań (rozdział angielskiego): karty bez pola „Ton lektora”", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openLesson(page, { subjectId: "english_chapter" });
  await expect(page.getByTestId(`dynamic-card-title-${OBJ}-0`)).toBeVisible();
  await expect(page.getByTestId(`dynamic-card-voice-tone-${OBJ}-0`)).toHaveCount(0);
});

test("telefon 320 px: ton i sterowanie nagraniami bez przepełnienia poziomego", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openLesson(page);
  await expectNoHorizontalOverflow(page);
  await page.getByTestId(`stage-${OBJ}-independent`).getByRole("button").first().click();
  await expect(page.getByTestId("exercise-prompt-audio-0")).toBeVisible();
  await expect(page.getByTestId("exercise-prompt-audio-2")).toBeVisible();
  await page.getByTestId("exercise-edit-0").click();
  await expect(page.getByTestId("exercise-voice-tone-0")).toBeVisible();
  for (const id of ["exercise-prompt-audio-0-listen", "exercise-prompt-audio-0-regenerate", "exercise-prompt-audio-2-regenerate", "exercise-voice-tone-0", `dynamic-card-voice-tone-${OBJ}-0`, `lesson-card-audio-${OBJ}-0-regenerate`]) {
    const box = (await page.getByTestId(id).boundingBox())!;
    expect(box.x, id).toBeGreaterThanOrEqual(-0.5);
    expect(box.x + box.width, id).toBeLessThanOrEqual(320.5);
  }
  await expectNoHorizontalOverflow(page);
});
