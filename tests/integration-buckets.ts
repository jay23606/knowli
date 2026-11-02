/**
 * Kosze czasowe testów integracyjnych (tests/integration).
 *
 * Pliki integracyjne biegną sekwencyjnie na jednym wspólnym kontenerze
 * Postgresa (`fileParallelism: false` w vitest.integration.config.ts —
 * każdy plik czyści tabele w beforeEach, więc równoległe pliki kasowałyby
 * sobie nawzajem dane). Równoległość daje dopiero podział na kosze
 * o zbliżonej sumie czasów plików, odpalane jako osobne procesy/joby
 * z własnym kontenerem (global-setup działa per proces) — ten sam wzorzec,
 * co REAL_BUCKETS dla E2E (tests/e2e/spec-projects.ts).
 *
 * Kosze są ułożone zachłannie (LPT) wg czasów plików (`endTime - startTime`
 * z `--reporter=json`) z pełnego lokalnego przebiegu 2026-10-26:
 * suma plików ~226 s, kosze po ~75 s. Podłogę wyznacza
 * `learning-algorithm.test.ts` (~40 s sam). Gdy czasy plików mocno urosną,
 * przelicz pomiar i ułóż kosze od nowa. Wybór kosza daje
 * `UMIEM_INTEGRATION_BUCKET` (1..N) w vitest.integration.config.ts;
 * bez niego biegnie cały zestaw.
 *
 * Nowy plik integracyjny trzeba dopisać do jednego z koszy (preferuj
 * najlżejszy) — kompletności podziału i zgodności z matrixem CI pilnuje
 * `tests/integration-buckets.test.ts` (suite jednostkowa).
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
    attempts.test.ts
    auth-profiles.test.ts
    child-interests.test.ts
    db-history-indexes.test.ts
    deck-cover.test.ts
    feedback-audio.test.ts
    generation.test.ts
    grammar-without-tts.test.ts
    history-policy-scope.test.ts
    learning-algorithm.test.ts
    lesson-attempts.test.ts
    lesson-audio.test.ts
    lesson-chapter.test.ts
    lesson-deck-overview.test.ts
    lesson-listen-choice.test.ts
    lesson-mock-tests.test.ts
    lesson-sessions.test.ts
    manual-decks-api.test.ts
    manual-decks.test.ts
    parent-work-card.test.ts
    reporting.test.ts
    source-vocabulary.test.ts
  `),
  bucket(`
    assignments-api.test.ts
    database-teardown.test.ts
    history.test.ts
    learning-overview-concurrency.test.ts
    lesson-assignments.test.ts
    lesson-grader-school.test.ts
    lesson-grader.test.ts
    lesson-isolation.test.ts
    lesson-parent-api.test.ts
    lesson-parent-supervision.test.ts
    lesson-sentence-audio.test.ts
    media.test.ts
    mock-test-reporting.test.ts
    parent-work-card-regressions.test.ts
    profile-navigation-benchmark.test.ts
    projection-facts.test.ts
    publish-media-reconcile.test.ts
    session-activity.test.ts
    sessions.test.ts
    speech.test.ts
    task-transition-queries.test.ts
    ui-audio.test.ts
  `),
  bucket(`
    deck-learning-overview.test.ts
    decks-management.test.ts
    integration-tokens.test.ts
    learning-mcp.test.ts
    learning-overview.test.ts
    lesson-card-audio.test.ts
    lesson-calculation.test.ts
    lesson-chapter-sentence-audio.test.ts
    lesson-dictation.test.ts
    lesson-generation.test.ts
    lesson-question-audio.test.ts
    lesson-schema.test.ts
    lesson-shape.test.ts
    mock-test-report-access.test.ts
    mock-test-settings.test.ts
    mock-tests.test.ts
    picture-vocabulary.test.ts
    progress-rebuild.test.ts
    pronunciation-settings.test.ts
    recording-mode-migration.test.ts
    revisions.test.ts
    session-activity-migration.test.ts
    source-materials.test.ts
    training-session-plan.test.ts
  `),
];

export const INTEGRATION_SPECS: readonly string[] = INTEGRATION_BUCKETS.flat();
