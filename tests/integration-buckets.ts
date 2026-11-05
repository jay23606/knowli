/**
 * Kosze czasowe testów integracyjnych (tests/integration).
 *
 * Kosze dzielą pliki między równoległe joby CI `integration (N)`, każdy
 * z własnym kontenerem Postgresa (global-setup działa per proces) — ten sam
 * wzorzec, co REAL_BUCKETS dla E2E (tests/e2e/spec-projects.ts). W obrębie
 * przebiegu pliki biegną dodatkowo równolegle na workerach Vitesta, każdy
 * z własną bazą (tests/integration-worker-databases.ts). Lokalnie kosze nie
 * są potrzebne: `pnpm test:integration` uruchamia cały zestaw szybciej niż
 * dawne lokalne kosze.
 *
 * Kosze ułożono zachłannie (LPT) wg czasów plików (`endTime - startTime`
 * z `--reporter=json`) z pełnego lokalnego przebiegu sekwencyjnego sprzed baz
 * workerów, 2026-11-04 (baza testów w tmpfs bez fsync): suma plików ~326 s, kosze po
 * ~109 s sumy czasów plików (czas zegarowy kosza ze startem kontenera
 * i importem modułów to ok. 145 s przy trzech koszach naraz). Najdłuższy plik:
 * `learning-algorithm.test.ts` (~30 s); pomiar obejmował jeszcze `lesson-review.test.ts` (~34 s),
 * usunięty razem z krytykiem lekcji (#237).
 * Gdy czasy plików mocno urosną, przelicz pomiar i ułóż kosze od nowa.
 * Wybór kosza daje `UMIEM_INTEGRATION_BUCKET` (1..N)
 * w vitest.integration.config.ts; bez niego biegnie cały zestaw.
 *
 * Nowy plik integracyjny trzeba dopisać do jednego z koszy (preferuj
 * najlżejszy) — kompletności podziału i zgodności z matrixem CI pilnuje
 * `tests/integration-buckets.test.ts` (suite jednostkowa). Taki plik biegnie
 * równolegle z innymi: z bazą łączy się tylko przez `testDatabaseUrl()` /
 * `testDatabase()` z `tests/integration/helpers.ts` (zasady: AGENTS.md,
 * „Running and verifying”).
 *
 * Nazwy plików są zapisane jako bloki tekstowe (jedna nazwa w linii),
 * a nie jako tablica literałów: detekcja duplikacji Sonara (CPD) abstrahuje
 * wartości stringów, więc długa lista literałów uchodzi za duplikat
 * analogicznych list z tests/e2e/spec-projects.ts i wywraca bramkę jakości
 * na nowym kodzie (SonarCloud działa tu w trybie Automatic Analysis, bez
 * konfiguracji wykluczeń w repo).
 */
function bucket(names: string): string[] {
  return names
    .trim()
    .split("\n")
    .map((name) => `tests/integration/${name.trim()}`);
}

export const INTEGRATION_BUCKETS: readonly (readonly string[])[] = [
  bucket(`
    deck-cover.test.ts
    deck-learning-overview.test.ts
    feedback-audio.test.ts
    grammar-without-tts.test.ts
    history.test.ts
    integration-tokens.test.ts
    learning-overview-concurrency.test.ts
    learning-overview.test.ts
    lesson-attempts.test.ts
    lesson-chapter-sentence-audio.test.ts
    lesson-deck-overview.test.ts
    lesson-dictation.test.ts
    lesson-error-explanation.test.ts
    lesson-generation.test.ts
    lesson-grader.test.ts
    lesson-mock-tests.test.ts
    lesson-parent-supervision.test.ts
    manual-decks.test.ts
    mock-test-reporting.test.ts
    picture-vocabulary.test.ts
    profile-navigation-benchmark.test.ts
    provider-usage.test.ts
    revisions.test.ts
    sessions.test.ts
    source-materials.test.ts
    speech.test.ts
    task-transition-queries.test.ts
  `),
  bucket(`
    auth-profiles.test.ts
    generation.test.ts
    learning-mcp.test.ts
    lesson-assignments.test.ts
    lesson-audio.test.ts
    lesson-calculation.test.ts
    lesson-exposure-report.test.ts
    lesson-listen-choice.test.ts
    lesson-question-audio.test.ts
    lesson-sentence-audio.test.ts
    lesson-sessions.test.ts
    lesson-story-session.test.ts
    lesson-story.test.ts
    mock-test-settings.test.ts
    parent-work-card-regressions.test.ts
    parent-work-card.test.ts
    projection-facts.test.ts
    pronunciation-settings.test.ts
    provider-usage-scope.test.ts
    publish-media-reconcile.test.ts
    reporting.test.ts
    session-activity.test.ts
    ui-audio.test.ts
  `),
  bucket(`
    assignments-api.test.ts
    attempts.test.ts
    child-interests.test.ts
    database-teardown.test.ts
    db-history-indexes.test.ts
    decks-management.test.ts
    history-policy-scope.test.ts
    learning-algorithm.test.ts
    lesson-agent-generation.test.ts
    lesson-card-audio.test.ts
    lesson-chapter.test.ts
    lesson-grader-school.test.ts
    lesson-isolation.test.ts
    lesson-parent-api.test.ts
    lesson-schema.test.ts
    lesson-shape.test.ts
    lesson-story-audio.test.ts
    manual-decks-api.test.ts
    media.test.ts
    mock-test-report-access.test.ts
    mock-tests.test.ts
    progress-rebuild.test.ts
    recording-mode-migration.test.ts
    session-activity-migration.test.ts
    source-vocabulary.test.ts
    training-session-plan.test.ts
  `),
];

export const INTEGRATION_SPECS: readonly string[] = INTEGRATION_BUCKETS.flat();
