/**
 * Partycja speców E2E na dwa projekty Playwright.
 *
 * `mocked` — spec nie dotyka prawdziwego backendu: całe API jest zaślepione
 * w przeglądarce (`installKidUiFixture` albo route dla `/api/v1/parent`),
 * więc testy są bezstanowe i mogą biec równolegle na wielu workerach.
 *
 * `real` — spec korzysta z prawdziwej bazy/workera świata E2E (API rodzica,
 * seedowanie przez `worldPool`, generacja przez workera). Świat jest jeden na
 * przebieg, a dane narastają między testami, więc projekt biegnie szeregowo
 * na jednym workerze; równoległość daje dopiero podział na wiele światów
 * (`pnpm test:e2e:shards` lokalnie, matrix w CI).
 *
 * Specy `real` są pogrupowane w kosze czasowe (REAL_BUCKETS): Playwright
 * dzieli `--shard` po liczbie testów, a nie po czasie, więc ciężkie pliki
 * potrafiły wylądować w jednym shardzie (lokalnie 98/58/105 s). Kosze są
 * ułożone zachłannie (LPT) wg zmierzonych sum czasów testów per plik
 * z przebiegu CI (szczegóły przy REAL_BUCKETS) i wybierane przez
 * `UMIEM_E2E_BUCKET` (1..N) w playwright.config.ts. Gdy czasy plików
 * mocno urosną, przelicz sumy z logów jobów `e2e (real-N)` i ułóż kosze od
 * nowa; kompletności podziału pilnuje `spec-projects.test.ts`.
 *
 * Projekt `mocked` jest bezstanowy, więc w CI dzieli go zwykły `--shard`
 * Playwrighta (po liczbie testów — przy `fullyParallel` wystarczająco równo);
 * lokalnie biegnie w jednym procesie na wielu workerach.
 *
 * Nowy spec trzeba dopisać do jednej z list (real: do wybranego kosza) —
 * pilnuje tego `spec-projects.test.ts`. Spec mieszany (część testów
 * mockowana, część realna) należy do `real`.
 */
export const MOCKED_SPECS: readonly string[] = [
  "kid-activity-lifecycle.spec.ts",
  "kid-answer-contrast.spec.ts",
  "kid-decks-layout.spec.ts",
  "kid-end-confirm.spec.ts",
  "kid-feedback-dock.spec.ts",
  "kid-feedback-layout.spec.ts",
  "kid-flow-screens.spec.ts",
  "kid-large-screen.spec.ts",
  "kid-layout-stability.spec.ts",
  "kid-motion.spec.ts",
    "kid-responsive.spec.ts",
  "kid-theme-scope.spec.ts",
  "kid-ui-layout.spec.ts",
  "lesson-assignment-layout.spec.ts",
  "lesson-calculation-layout.spec.ts",
  "lesson-card-audio-layout.spec.ts",
  "lesson-cloze-layout.spec.ts",
  "lesson-dictation-layout.spec.ts",
  "lesson-kid.spec.ts",
  "lesson-listen-choice.spec.ts",
  "lesson-mock-precision-layout.spec.ts",
  "lesson-precision-layout.spec.ts",
  "lesson-question-audio-layout.spec.ts",
  "lesson-sentence-audio.spec.ts",
  "parent-children.spec.ts",
  "parent-deck-editor-layout.spec.ts",
  "parent-lesson-editor-layout.spec.ts",
  "parent-lesson-voice-tone.spec.ts",
  "parent-lessons-layout.spec.ts",
  "parent-progress-layout.spec.ts",
  "parent-shell-layout.spec.ts",
  "parent-source-vocabulary-layout.spec.ts",
  "parent-sources-layout.spec.ts",
  "parent-work-card.spec.ts",
  "picture-choice-layout.spec.ts",
  "picture-recognition-layout.spec.ts",
  "picture-recognition.spec.ts",
  "picture-vocabulary.spec.ts",
  "progress-panel.spec.ts",
];

/**
 * Kosze czasowe speców `real`, ułożone LPT z sum czasów testów per plik w CI
 * (run PR #206, 2026-10-31: łącznie 490 s; kosze po ok. 122–124 s zamiast
 * 111/144/115/121 s). Najdłuższy plik, `kid-flow.spec.ts` (104 s), wyznacza
 * dolną granicę swojego kosza. Komentarz przy koszu to jego suma czasów testów
 * w CI — zmierzonych na pozycjach ze starego układu, a pierwszy plik świata płaci
 * jego rozgrzewkę, więc po zmianie przelicz kosze z kolejnego logu CI.
 * Pliki w koszu biegną alfabetycznie w jednym świecie, którego dane narastają.
 * Dwa przeglądy całego świata (`learning-mcp-http`, `learning-overview-api`)
 * stoją na początku swojego kosza, a `lesson-mock-test` (limit asercji 2 s przy
 * pierwszym kontakcie z backendem) nie jest pierwszy — pilnuje tego spec-projects.test.
 */
export const REAL_BUCKETS: readonly (readonly string[])[] = [
  // ok. 122 s
  [
    "kid-flow.spec.ts",
    "lesson-archive.spec.ts",
    "privacy.spec.ts",
    "spelling-diff-feedback.spec.ts",
  ],
  // ok. 124 s
  [
    "manual-deck-flow.spec.ts",
    "mock-test-parent.spec.ts",
    "navigation.spec.ts",
    "parent-edit-protection.spec.ts",
    "speech-recording-ux.spec.ts",
  ],
  // ok. 123 s
  [
    "learning-mcp-http.spec.ts",
    "learning-overview-api.spec.ts",
    "lesson-calculation.spec.ts",
    "lesson-parent-supervision.spec.ts",
    "lesson-parent.spec.ts",
    "parent-flow.spec.ts",
    "parent-sources.spec.ts",
    "test-preparation.spec.ts",
  ],
  // ok. 122 s
  [
    "deck-cover-image.spec.ts",
    "generation-request-retry.spec.ts",
    "learning-algorithm.spec.ts",
    "lesson-mock-test.spec.ts",
    "lesson-real-flow.spec.ts",
    "mock-test.spec.ts",
  ],
];

export const REAL_SPECS: readonly string[] = REAL_BUCKETS.flat();
