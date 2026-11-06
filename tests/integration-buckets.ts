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
 * z `--reporter=json`) z pełnego lokalnego przebiegu sekwencyjnego
 * (`UMIEM_INTEGRATION_WORKERS=1`), 2026-11-05 (baza testów w tmpfs bez fsync;
 * 76 plików): suma plików ~332 s, kosze po ~111 s sumy czasów plików (przed
 * przeliczeniem 107 / 77 / 148 s). Najdłuższe pliki:
 * `lesson-agent-generation.test.ts` (~35 s) i `learning-algorithm.test.ts`
 * (~30 s). Pomiar nie obejmuje już `lesson-review.test.ts`, usuniętego razem
 * z krytykiem lekcji (#237).
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
    assignments-api.test.ts
    child-interests.test.ts
    database-teardown.test.ts
    deck-cover.test.ts
    feedback-audio.test.ts
    grammar-without-tts.test.ts
    history.test.ts
    lesson-chapter-sentence-audio.test.ts
    lesson-chapter.test.ts
    lesson-isolation.test.ts
    lesson-parent-api.test.ts
    lesson-present-continuous.test.ts
    lesson-schema.test.ts
    lesson-sessions.test.ts
    lesson-story-session.test.ts
    manual-decks-api.test.ts
    media.test.ts
    mock-test-reporting.test.ts
    recording-mode-migration.test.ts
    session-activity-migration.test.ts
    session-activity.test.ts
    sessions.test.ts
    source-vocabulary.test.ts
    task-transition-queries.test.ts
    training-session-plan.test.ts
    ui-audio.test.ts
  `),
  bucket(`
    db-history-indexes.test.ts
    decks-management.test.ts
    generation.test.ts
    history-policy-scope.test.ts
    learning-mcp.test.ts
    lesson-agent-generation.test.ts
    lesson-attempts.test.ts
    lesson-audio.test.ts
    lesson-deck-overview.test.ts
    lesson-dictation.test.ts
    lesson-error-explanation.test.ts
    lesson-grader-school.test.ts
    lesson-sentence-audio.test.ts
    lesson-story.test.ts
    mock-test-report-access.test.ts
    mock-test-settings.test.ts
    mock-tests.test.ts
    parent-work-card-regressions.test.ts
    parent-work-card.test.ts
    progress-rebuild.test.ts
    projection-facts.test.ts
    provider-usage-scope.test.ts
    provider-usage.test.ts
    source-materials.test.ts
    speech.test.ts
  `),
  bucket(`
    attempts.test.ts
    auth-profiles.test.ts
    deck-learning-overview.test.ts
    integration-tokens.test.ts
    learning-algorithm.test.ts
    learning-overview-concurrency.test.ts
    learning-overview.test.ts
    lesson-assignments.test.ts
    lesson-calculation.test.ts
    lesson-card-audio.test.ts
    lesson-generation.test.ts
    lesson-grader.test.ts
    lesson-listen-choice.test.ts
    lesson-mock-tests.test.ts
    lesson-parent-supervision.test.ts
    lesson-question-audio.test.ts
    lesson-shape.test.ts
    lesson-story-audio.test.ts
    manual-decks.test.ts
    picture-vocabulary.test.ts
    profile-navigation-benchmark.test.ts
    pronunciation-settings.test.ts
    publish-media-reconcile.test.ts
    reporting.test.ts
    revisions.test.ts
  `),
];

export const INTEGRATION_SPECS: readonly string[] = INTEGRATION_BUCKETS.flat();
