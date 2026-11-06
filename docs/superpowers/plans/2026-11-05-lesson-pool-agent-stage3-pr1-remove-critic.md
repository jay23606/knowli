# Etap 3 PR 1: usunięcie krytyka lekcji — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Wersja 2 (po przeglądzie trzech krytyków planu).

**Goal:** Usunąć z kodu krytyka lekcji (`LessonReviewerProvider`, `UMIEM_REVIEWER_*`, `lesson_context.review`, UI rodzica), zostawiając potok, ocenę aktywności sesji i zgodność ze starymi danymi.

**Architecture:** Usuwanie w kolejności od UI do konfiguracji, tak żeby po każdym zadaniu `pnpm typecheck` przechodził (typecheck obejmuje `packages/*/src/**` z testami, `apps/*/src/**` z testami i `tests/**`; w repo nie ma `noUnusedLocals` ani ESLint, więc nieużywany import istniejącego symbolu nie szkodzi, a import usuniętego — tak). Nowy kod to wyłącznie testy zgodności i strażników.

**Tech Stack:** TypeScript strict, Vitest (unit; integracja na Postgresie w kontenerze), Playwright, React/Mantine (panel rodzica), Zod.

**Spec:** `docs/superpowers/specs/2026-11-05-lesson-pool-agent-stage3-design.md` (wersja 3), §1, §2, §9. Raporty krytyków (stan sprzed zmian, numery linii przybliżone) w `C:\Users\looka\AppData\Local\Temp\claude\C--Users-looka-IdeaProjects-knowli--claude-worktrees-lesson-new-exercise-type-4e7d8f\072948fd-dbf4-49ca-8897-ff5ee18c371d\scratchpad\`: `map-critic.md`, `critic-a-v2.md`, `plan1-critic1.md`, `plan1-critic2.md`, `plan1-critic3.md`.

## Global Constraints

- Gałąź: `feature/lesson-pool-agent-stage3-237` (zawiera commity specu i planu; baza zmian kodu: `f14e3ce7`). Nie wypychać do `main`, nie scalać PR. Push gałęzi i otwarcie PR tylko po zgodzie właściciela (Task 8).
- Nigdy `npm install`; tylko `corepack pnpm install --prefer-offline --frozen-lockfile`, i tylko gdy brak `node_modules`.
- Żadnych płatnych wywołań modeli (`pnpm probe:*` z kluczem).
- Bez migracji bazy; bez zmian w MCP (`integrations/`, `apps/web/src/integrations`) i `SKILL.md`.
- **Nie usuwać** oceny aktywności sesji: `SessionActivityReviewer`, `FakeSessionActivityReviewer`, `session_activity_review`, `ParentWorkCardDto.reviewService`, `WorkCardPanel` (`work-card-review-service`), `review_failed`, `reviewSessionActivity`, `activityReview`.
- **Nie usuwać**: stanu wersji `review` (`deck_versions.state`, `DeckStateSchema`, komunikaty stanów w `messages.decks`), `nextReviewAt`, `mockTestReview*`, `reviewObjectives`, `findExposureLeaks`, `lesson-pool-acceptance.ts`, `lesson-json-request.ts` (z `cache_control`), `lesson-payload.ts`, `exposure-key`, `exercise-identity`, `withLessonGenerationControl`, `stageTopUpRound` (bez parametrów krytyka), `leakNoticeFor`.
- `withoutRunReports` (`packages/server/src/modules/materials/version-ops.ts`) nadal usuwa klucze `review` i `generationGaps` (komentarz: „dawny raport krytyka”).
- Wyszukiwanie: zawsze `git grep -nE "<wzorzec>" -- <ścieżki>` (pomija nieśledzone `apps/web/.next` i `*.tsbuildinfo`).
- Iteracja E2E: `UMIEM_E2E_WEB_MODE=dev`; pełny przebieg na buildzie produkcyjnym w Task 7.
- Commity po polsku, zakończone `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Kod po angielsku, komentarze i dokumentacja po polsku.

## Review Focus

1. Stary szkic z kluczem `review` (sprzed PR 1) generowany **potokiem** (domyślna ścieżka w PR 1): run `succeeded`, surowy klucz zostaje w szkicu, DTO szkicu go nie ma — test w Task 3, Step 1.
2. „Utwórz nową wersję” z wersji opublikowanej z `review` i `generationGaps`: kopia nie ma żadnego, źródło nadal ma oba — test w Task 2, Step 1.
3. Pozostawione, także **błędne**, `UMIEM_REVIEWER_*` w env (`ENABLED=true`, `CONCURRENCY=abc`): składanie zależności i workera się udaje — testy w Task 4, Step 1.
4. Karta pracy nadal pokazuje usługę oceny aktywności (`ParentWorkCardDto.reviewService`) — `session-activity.test.ts` w Task 2, E2E w Task 1 i Task 7.
5. Potok bez fazy przeglądu: nowy szkic bez klucza `review` (test czerwony przed zmianą, Task 3), runda pod etap i bramka bliskiego terminu działają — `lesson-chapter.test.ts` i `lesson-generation.test.ts` bez zmian względem `f14e3ce7` (Task 3).
6. Każdy commit kompiluje się osobno (Task 7, Step 1).

---

### Task 1: Panel rodzica bez krytyka

**Files:**
- Delete: `apps/web/src/parent/lessons/LessonReviewBanner.tsx`, `apps/web/src/parent/lessons/lesson-review-banner.test.tsx`
- Modify: `apps/web/src/parent/lessons/LessonEditor.tsx` (importy banera i notatek, `reviewChangedByExercise`, `reviewNotice`, prop `review=`, `reviewService` dla panelu nadzoru, `<LessonReviewBanner>`)
- Modify: `apps/web/src/parent/lessons/LessonExerciseCard.tsx` (`ExerciseReviewNotice`, `reviewNoticeFor`, `fillTemplate`, prop `review`, porównanie w memo, plakietka, Alert notatki; `leakNoticeFor` zostaje)
- Modify: `apps/web/src/parent/lessons/LessonSupervisionPanel.tsx` (prop `reviewService`, `data-testid="review-service"`)
- Modify: `apps/web/src/parent/lessons/NewLessonForm.tsx` (`data-testid="lesson-review-service"`, jego warunek i komentarz o krytyku)
- Modify: `apps/web/src/parent/sources/SourcePage.tsx` (`showReviewService`, `source-review-service`, komentarz; `checkService` zostaje)
- Modify: `apps/web/src/parent/lessons/lesson-service-info.ts` (komentarz „usługa katalogowa i krytyk”)
- Modify: `apps/web/src/parent/lessons/lesson-panels.css` (`.pp-lesson-review-toggle`)
- Modify tests: `apps/web/src/parent/lessons/lesson-exercise-card.test.tsx` (import `reviewNoticeFor`/`ExerciseReviewNotice`, parametr `review` helpera `render`, describe „automatyczna kontrola jakości”; test „z ujawnieniem i uwagą kontroli” przepisać na sam przypadek ujawnienia z `aria-describedby="exercise-leak-0-text"`), `apps/web/src/parent/lessons/new-lesson-form.test.tsx` (`extras.reviewService` w `renderWithCatalog`, przypadki usługi krytyka; przypadek „przedmiot potoku: komunikat krytyka …” **zmienić** — zostają asercje `themesService` i brak `lesson-check-service`), `apps/web/src/parent/sources/sources-panel.test.tsx` (`reviewService: REVIEW` i przypadki usługi krytyka)
- Modify E2E (projekt `mocked`): `tests/e2e/parent-lesson-editor-layout.spec.ts` (blok banera, plakietek, kontrastu, `review-service`, test „opublikowana lekcja bez szkicu nie pokazuje banera”; stałe `REVIEW_SERVICE`, `reviewed`, `withReview`), `tests/e2e/parent-lessons-layout.spec.ts` (fixture i asercje `lesson-review-service`, tytuły „bez komunikatu krytyka”)

**Interfaces:**
- Consumes: nic nowego. Pola kontraktów `review`/`reviewService` są opcjonalne i zostają w typach do Task 2.
- Produces: web nie czyta `LessonDraftDto.review`, `SubjectCatalogDto.reviewService`, `LessonDeckDto.reviewService` ani `messages.lessons.review*`.

- [ ] **Step 1: Usuń komponenty, użycia i komentarze z Files.**
- [ ] **Step 2: Popraw testy web i E2E z Files.** Nie ruszaj `parent-work-card.spec.ts`, `parent-progress-layout.spec.ts`, `WorkCardPanel`, `parent-router.test.ts`.
- [ ] **Step 3: Sprawdź brak odwołań**

Run: `git grep -nE "LessonReviewBanner|reviewNotice|ReviewNotice|reviewChanged|lesson-review-|exercise-review-|data-review-status|\"review-service\"|source-review-service|showReviewService|pp-lesson-review-toggle|lessons\.review[A-Z]|withReview|REVIEW_SERVICE|reviewService" -- apps/web/src/parent/lessons apps/web/src/parent/sources tests/e2e/parent-lesson-editor-layout.spec.ts tests/e2e/parent-lessons-layout.spec.ts`
Expected: brak wyników.

- [ ] **Step 4: Testy i typecheck**

Run: `corepack pnpm typecheck` → PASS.
Run: `corepack pnpm vitest run --config vitest.unit.config.ts apps/web/src/parent` → PASS.
Run: `UMIEM_E2E_WEB_MODE=dev corepack pnpm exec playwright test --project=mocked tests/e2e/parent-lesson-editor-layout.spec.ts tests/e2e/parent-lessons-layout.spec.ts tests/e2e/parent-sources-layout.spec.ts tests/e2e/parent-work-card.spec.ts tests/e2e/parent-progress-layout.spec.ts` → PASS.

- [ ] **Step 5: Commit** — `Panel rodzica: bez raportu i usługi krytyka lekcji (#237)`.

---

### Task 2: Kontrakty, komunikaty i DTO bez krytyka; testy kopii wersji i tekstu tematów

**Files:**
- Modify: `packages/contracts/src/lessons.ts` (`REVIEW_CATEGORY_VALUES`, `ReviewCategorySchema`, `ReviewReasonSchema`, `LessonReviewDtoSchema`, typy `ReviewCategoryDto`, `ReviewReasonDto`, `LessonReviewDto`; pola `SubjectCatalogDto.reviewService`, `LessonDraftDto.review`, `LessonDeckDto.reviewService`)
- Modify: `packages/contracts/src/messages.ts` (import typów `Review*`; klucze `review*` w `messages.lessons` od `reviewBanner` do `reviewServiceInfo`; w `themesService` i `themesServiceUnknown` usuń fragment o automatycznej kontroli jakości, zdanie o usłudze generującej i ocenie odpowiedzi zostaje)
- Modify: `packages/contracts/src/lessons.test.ts` (describe „raport automatycznej kontroli jakości”)
- Modify: `packages/server/src/domain/lessons/review-criteria.test.ts` (describe „kategorie kontroli w kontraktach” i import z `@learning/contracts`; reszta pliku znika w Task 4)
- Modify: `packages/server/src/modules/materials/lessons/lesson-api.ts` (`LessonContextView.review`, rozkład w `readLessonContext`, `reviewDto`, pole `review` DTO szkicu, `reviewService` katalogu i zestawu, importy `exerciseFingerprint`, `LessonReviewReport`, `statusFromObjectives`)
- Modify: `packages/server/src/config.ts` (`Services.reviewService`, wejście i rozkład w `createServices`; `reviewerPublicServiceFromEnv` zostaje do Task 4)
- Modify: `apps/web/src/composition.ts` (import `reviewerPublicServiceFromEnv`, komentarz i wywołanie, przekazanie `reviewService`; komentarz o ocenie aktywności zostaje)
- Delete: `tests/integration/lesson-review.test.ts` (cały plik czyta `LessonDraftDto.review`; jego test „Utwórz nową wersję” przenosi Step 1); wpis i komentarz w `tests/integration-buckets.ts`
- Modify: `tests/integration/lesson-generation.test.ts` (nowy test ze Step 1)
- Modify: `apps/web/src/parent/lessons/new-lesson-form.test.tsx` (nowy test ze Step 1)

**Interfaces:**
- Consumes: Task 1 (web nie czyta usuwanych pól).
- Produces: kontrakty bez typów i pól krytyka; `Services` bez `reviewService`; brak `tests/integration/lesson-review.test.ts`.

- [ ] **Step 1: Napisz testy**
  - `tests/integration/lesson-generation.test.ts`, `it("„Utwórz nową wersję” → kopia bez review i bez generationGaps")`, na potoku gramatyki (wzorzec publikacji i kopii: `tests/integration/child-interests.test.ts` ok. :287–298): `createLesson` + `executeLessonGeneration` → `succeeded`; zasiew w wersji szkicu `jsonb_set(lesson_context, '{review}', '{"status":"reviewed","objectives":[]}')` i `'{generationGaps}'` = `[{"objectiveId": <pierwsze zagadnienie szkicu>, "reason":"incomplete"}]`; `publishLessonDraft(services, draft.id, draft.editNumber)`; `copy = await createLessonDraftFromPublished(services, deckId)`. Asercje: `copy.id !== draft.id`; `lesson_context->'review'` i `->'generationGaps'` kopii są `null`; te same pola wersji źródłowej (opublikowanej) **nie** są `null`; `copy.examples` równe przykładom szkicu; `copy` bez `generationGaps`.
  - Tamże `it("DTO szkicu nie ma review mimo starego klucza w kontekście")`: po udanym runie zasiej `review` = `{"status":"reviewed","objectives":[{"objectiveId": <pierwsze zagadnienie>, "status":"reviewed"}],"notes":[],"changed":[],"dropped":[],"machine":[],"toppedUp":[]}`; `(await readLessonDeck(services, deckId)).draft` → `expect(draft).not.toHaveProperty("review")`.
  - `new-lesson-form.test.tsx`, w describe „tematy zdań”: dla `themesService` (znana usługa) i `themesServiceUnknown` → `expect(text).not.toMatch(/kontrol[aię] jakości/i)` oraz `expect(messages.lessons.themesService).toContain("{service}")` i zachowana wzmianka o usłudze oceniającej odpowiedzi (`toContain("usługa oceniająca odpowiedzi")` — dopasuj do dokładnego brzmienia w `messages.ts`).
- [ ] **Step 2: Uruchom — dwa testy mają nie przejść, kopia ma przejść**

Run: `corepack pnpm test:integration tests/integration/lesson-generation.test.ts` → FAIL tylko „DTO szkicu nie ma review…”; „Utwórz nową wersję” PASS.
Run: `corepack pnpm vitest run --config vitest.unit.config.ts apps/web/src/parent/lessons/new-lesson-form.test.tsx` → FAIL na „kontrola jakości”.

- [ ] **Step 3: Usuń i zmień wszystko z Files.**
- [ ] **Step 4: Testy, typecheck, grep**

Run: `corepack pnpm typecheck` → PASS.
Run: `corepack pnpm vitest run --config vitest.unit.config.ts packages/contracts apps/web/src/parent packages/server/src/modules packages/server/src/domain/lessons tests/integration-buckets.test.ts` → PASS.
Run: `corepack pnpm test:integration tests/integration/lesson-generation.test.ts tests/integration/session-activity.test.ts tests/integration/lesson-parent-api.test.ts` → PASS.
Run: `git grep -nE "LessonReviewDto|ReviewCategoryDto|ReviewReasonDto|REVIEW_CATEGORY_VALUES|reviewService" -- packages/contracts/src packages/server/src/modules/materials apps/web/src/composition.ts`
Expected: tylko `ParentWorkCardDto.reviewService` w `packages/contracts/src/parent-work-card.ts` i `parent-work-card.test.ts`.

- [ ] **Step 5: Commit** — `Kontrakty i DTO lekcji bez raportu krytyka (#237)`.

---

### Task 3: Potok i domena bez fazy krytyka

**Files:**
- Modify: `packages/server/src/modules/materials/lessons/lesson-drafts.ts`: importy krytyka; `LessonContext.review`; `REVIEW_DROP_REASON`, `REVIEW_FINALIZATION_RESERVE_MS`; w `StageTopUpContext` pola `review`, `reviewReserveMs`; w `stageTopUpRound` wynik `reviews`, `toppedUp`, wywołanie `ctx.review`, `droppedCount` (`trimmed.kept` wprost do `resolveGenerationLeaks`, bramka czasu bez rezerwy); `stageCountsOf`; `LessonPoolReview`; parametr `review` w `failedValidationContext`, `failLessonPoolValidation`, `finalizeLessonPoolWrite` i ich użyciach; w głównym potoku `reviewer`, `reviewerReady`, `reviewCallsLeft`, `reviewDeadlineAtMs`, `phaseDeadlineAtMs = runDeadlineAtMs`, usunięcie `reviewPhase`, `mainReview`, `reviewPhases`, `mergedReview`, `objectiveContext`; `fresh.accepted` wprost do `resolveGenerationLeaks`
- Modify: `packages/server/src/modules/materials/lessons/lesson-agent-generation.ts` (komentarze „bez krytyka”, „raport krytyka bez zmian”)
- Modify: `packages/server/src/modules/materials/version-ops.ts` (komentarz `withoutRunReports`: „dawny raport krytyka”)
- Delete: `packages/server/src/modules/materials/lessons/lesson-review.ts` i `lesson-review.test.ts`; `packages/server/src/domain/lessons/review-report.ts`, `review-verdicts.ts` z testami; `packages/server/src/modules/materials/lessons/lesson-fingerprint.ts` i `lesson-fingerprint.test.ts` (po Task 2 `git grep exerciseFingerprint` pokazuje tylko te pliki i `lesson-review*`). **`domain/lessons/review-criteria.ts` zostaje do Task 4** (importuje go adapter).
- Delete: `tests/probes/lesson-review.probe.test.ts`; skrypt `probe:review` w `package.json`
- Modify: `tests/integration/lesson-agent-generation.test.ts`: importy `LessonReviewReport` i `FakeLessonReviewer`, `PRESET_REVIEW`, pole `reviewer` w `AgentWorld`, ustawianie `fakes.deps.reviewer` w `agentWorld`, destrukturyzacja `reviewer`, asercje `reviewer.inputs`/`context.review` i fragment tytułu „krytyk nie wołany i jego raport bez zmian” w teście rozdziału (reszta asercji zostaje); nowe testy ze Step 1

**Interfaces:**
- Consumes: Task 2.
- Produces: `finalizeLessonPoolWrite(...)` i `failLessonPoolValidation(...)` bez parametru `review`; `LessonContext` bez `review`. `GenerationDeps.reviewer`, fake i adapter krytyka nadal istnieją (Task 4), ale nikt ich nie czyta.

- [ ] **Step 1: Napisz testy** w `tests/integration/lesson-agent-generation.test.ts` (potok: `agentWorld(["english_chapter"])` + `createLesson(services, command())` — gramatyka spoza listy agenta idzie potokiem, wzorzec z testu „przedmiot spoza listy → potok”):
  - `it("potok: nowy szkic bez klucza review")`: run `succeeded`, `expect((await versionOf(runId)).lesson_context).not.toHaveProperty("review")`.
  - `it("potok: stary klucz review w szkicu — run succeeded, klucz zostaje, DTO go nie ma")`: przed runem `setContextField(before.id, "review", { status: "reviewed", objectives: [] })`; po runie `succeeded`, `expect(after.lesson_context).toHaveProperty("review")`, `expect((await readLessonDeck(services, deckId)).draft).not.toHaveProperty("review")` (dopisz `readLessonDeck` do importu z `@learning/server`).
- [ ] **Step 2: Uruchom — pierwszy ma nie przejść**

Run: `corepack pnpm test:integration tests/integration/lesson-agent-generation.test.ts`
Expected: FAIL tylko „potok: nowy szkic bez klucza review” (potok dziś zapisuje raport ze statusem „disabled”); drugi PASS.

- [ ] **Step 3: Usuń kod i pliki z Files.**
- [ ] **Step 4: Sprawdź brak odwołań**

Run: `git grep -nE "lesson-review\.ts|lesson-review\.test|lesson-review\.probe|/lesson-review\"|LessonReviewReport|mergeReviewReport|reviewFreshExercises|decideObjectiveReview|statusFromObjectives|REVIEW_DROP_REASON|REVIEW_FINALIZATION_RESERVE_MS|LessonPoolReview|exerciseFingerprint|toppedUp|probe:review" -- packages apps tests package.json`
Expected: brak wyników.

- [ ] **Step 5: Testy**

Run: `corepack pnpm typecheck` → PASS.
Run: `corepack pnpm vitest run --config vitest.unit.config.ts packages/server/src/modules packages/server/src/domain/lessons tests/integration-buckets.test.ts` → PASS (obejmuje `module-boundaries.architecture.test.ts`).
Run: `corepack pnpm test:integration tests/integration/lesson-agent-generation.test.ts tests/integration/lesson-chapter.test.ts tests/integration/lesson-generation.test.ts` → PASS.
Run: `git diff f14e3ce7 -- tests/integration/lesson-chapter.test.ts` → pusty; `git diff f14e3ce7 -- tests/integration/lesson-generation.test.ts` → tylko testy dodane w Task 2.

- [ ] **Step 6: Commit** — `Potok lekcji bez fazy krytyka; testy zgodności starych danych (#237)`.

---

### Task 4: Konfiguracja, port i adapter krytyka

**Files:**
- Modify: `packages/server/src/ports/ai.ts` (`LessonReviewExerciseInput`, `LessonReviewInput`, `LessonReviewerProvider`)
- Delete: `packages/server/src/providers/openai/lesson-reviewer.ts`, `lesson-reviewer.test.ts`, `lesson-review-schema.ts`; `packages/server/src/domain/lessons/review-criteria.ts` i `review-criteria.test.ts`
- Modify: `packages/server/src/providers/fake.ts` (`FakeReviewBehavior`, `FakeLessonReviewer`, importy), `fake.test.ts` (describe fake krytyka)
- Modify: `packages/server/src/providers/generation-env.ts` (`fakeReviewerFromEnv`, pola `reviewer`, importy, komentarze), `generation-env.test.ts` (describe krytyka zastępuje test ze Step 1)
- Modify: `packages/server/src/config.ts` (`GenerationDeps.reviewer`, `ReviewerPolicy`, `ReviewerState`, `ReviewerDeps`, `reviewerEnabled`, `defaultReviewerPolicy`, `reviewerPolicyFromEnv`, `reviewerConnectionFromEnv`, `validatedReviewerConfig`, `reviewerFromEnv`, `reviewerPublicServiceFromEnv`, importy), `config.test.ts` (describe `reviewerFromEnv`/`reviewerPublicServiceFromEnv`)
- Modify: `packages/server/src/config-defaults.ts` (8 wpisów `UMIEM_REVIEWER_*`: `ENABLED`, `BASE_URL`, `MODEL`, `TIMEOUT_MS`, `CONCURRENCY`, `MAX_OUTPUT_TOKENS`, `MAX_CALLS_PER_RUN`, `PHASE_BUDGET_MS`, z komentarzami; komentarz przy `WORKER_HEALTH_STALE_MS` przepisz na „limit runu generacji lekcji mieści się w progu zdrowia; pilnuje `apps/worker/src/loop.test.ts`”)
- Modify: `packages/server/src/index.ts` (cała linia eksportu `reviewerFromEnv`, `reviewerPublicServiceFromEnv`, `ReviewerDeps`, `ReviewerPolicy`, `ReviewerState`)
- Modify: `packages/server/src/providers/chat-request-options.ts`, `providers/openrouter-key.ts` (prefiks `"UMIEM_REVIEWER"`)
- Modify: `packages/server/src/providers/openai/lesson-json-request.ts` (komentarz „generatora i krytyka” → „generatora”), `packages/server/src/providers/usage-recording.architecture.test.ts` (komentarz „generator i krytyk lekcji” → „generator lekcji”)
- Modify: `apps/worker/src/loop.ts` (`reviewerHealthBudgetWarning`, import `reviewerEnabled`), `apps/worker/src/main.ts` (wywołanie), `apps/worker/src/loop.test.ts`, `apps/worker/src/composition.test.ts`
- Modify: `tests/ai-sdk-scope.test.ts` (przykładowy plik `providers/openai/lesson-reviewer.ts` → `providers/openai/lesson-json-request.ts`)
- Modify: `tests/probes/chapter-generation.probe.test.ts` (stan krytyka, `deps.reviewer`, koszt `lesson_review`, prefiks `[lesson-review]`, etykieta `+review`), `tests/probes/probe-costs.test.ts` (etykieta `UMIEM_REVIEWER_BASE_URL` → `UMIEM_GRADER_BASE_URL`), `vitest.probe.config.ts` (komentarz o `probe:review`)

**Interfaces:**
- Consumes: Task 3 (nikt nie czyta `GenerationDeps.reviewer`).
- Produces: `GenerationDeps` bez `reviewer`; `CONFIG_DEFAULTS` bez `UMIEM_REVIEWER_*`; brak `review-criteria.ts` (Task 5 usuwa `reviewRules`, które on czytał).

- [ ] **Step 1: Napisz testy**
  - `packages/server/src/providers/generation-env.test.ts`, w miejsce describe krytyka: `it("pozostawione, także błędne, UMIEM_REVIEWER_* są ignorowane")`: `expect(() => createGenerationDepsFromEnv(withConfigDefaults({ UMIEM_FAKE_PROVIDERS: "1", UMIEM_REVIEWER_ENABLED: "true", UMIEM_REVIEWER_CONCURRENCY: "abc" }))).not.toThrow()`; wariant produkcyjny z kluczami jak w istniejących testach produkcyjnych pliku + `UMIEM_REVIEWER_ENABLED: "true", UMIEM_REVIEWER_CONCURRENCY: "0", UMIEM_REVIEWER_REASONING: "turbo"` → `not.toThrow()`; `expect(withConfigDefaults({})).not.toHaveProperty("UMIEM_REVIEWER_ENABLED")`.
  - `apps/worker/src/composition.test.ts`: `it("pozostawione błędne UMIEM_REVIEWER_* nie zatrzymują workera")`: `vi.stubEnv` tych samych zmiennych (wariant fake), `buildWorkerServices()` nie rzuca.
  - `apps/worker/src/loop.test.ts`: describe krytyka zastąp `it("domyślny limit runu generacji lekcji mieści się w WORKER_HEALTH_STALE_MS")`: `const env = withConfigDefaults({}); expect(Number(env.UMIEM_LESSON_GENERATION_RUN_TIMEOUT_MS)).toBeLessThan(workerLoopSettingsFromEnv(env).staleMs)`; import bez `reviewerHealthBudgetWarning`.
- [ ] **Step 2: Uruchom — testy ignorowania mają nie przejść**

Run: `corepack pnpm vitest run --config vitest.unit.config.ts packages/server/src/providers/generation-env.test.ts apps/worker/src/composition.test.ts`
Expected: FAIL (dziś `CONCURRENCY=abc`/`0` i `REASONING=turbo` zatrzymują składanie, a `UMIEM_REVIEWER_ENABLED` jest w wartościach domyślnych).

- [ ] **Step 3: Usuń kod z Files.**
- [ ] **Step 4: Sprawdź brak odwołań**

Run: `git grep -nE "UMIEM_REVIEWER|LessonReviewerProvider|FakeLessonReviewer|reviewerFromEnv|reviewerPublicServiceFromEnv|reviewerEnabled|ReviewerDeps|ReviewerPolicy|ReviewerState|reviewerHealthBudgetWarning|review-criteria|reviewRoleFor|lesson-reviewer|lesson-review-schema|lesson_review\b|\[lesson-review\]" -- packages apps tests vitest.probe.config.ts`
Expected: wyłącznie literały `UMIEM_REVIEWER_*` w testach ze Step 1 (`generation-env.test.ts`, `composition.test.ts`).

- [ ] **Step 5: Testy**

Run: `corepack pnpm typecheck` → PASS.
Run: `corepack pnpm test:unit` → PASS.

- [ ] **Step 6: Commit** — `Konfiguracja i adapter: usunięty krytyk lekcji i UMIEM_REVIEWER_* (#237)`.

---

### Task 5: `reviewRules` przedmiotów

**Files:**
- Modify: `packages/server/src/domain/lessons/types.ts` (pole `reviewRules` w promptach `SubjectModule`)
- Modify: `packages/server/src/domain/lessons/catalog-validation.ts` (wymóg `reviewRules`), `catalog-validation.test.ts` (przypadki `reviewRules`)
- Modify: `packages/server/src/domain/lessons/subjects/english-chapter/prompts.ts` (teksty `reviewRules` i komentarz „jedna lista dla generatora i krytyka”), `subjects/english-grammar/prompts.ts`, `subjects/school/prompts.ts`, `domain/lessons/testing/history-like-subject.ts`
- Modify: `packages/server/src/modules/materials/lessons/lesson-drafts.test.ts` (przypadki `reviewRules`)

**Interfaces:**
- Consumes: Task 4 (`review-criteria.ts`, jedyny czytelnik `reviewRules`, usunięty).
- Produces: `SubjectModule.prompts` bez `reviewRules`.

- [ ] **Step 1: Usuń pole, walidację, teksty i testy z Files.** Treść reguł przepada świadomie (spec §1).
- [ ] **Step 2: Sprawdź i przetestuj**

Run: `git grep -n "reviewRules" -- packages apps tests` → brak wyników.
Run: `corepack pnpm typecheck` → PASS.
Run: `corepack pnpm vitest run --config vitest.unit.config.ts packages/server/src/domain/lessons packages/server/src/modules` → PASS.

- [ ] **Step 3: Commit** — `Przedmioty lekcji bez reguł krytyka (#237)`.

---

### Task 6: Dokumentacja i resztki w komentarzach

**Files:**
- Modify: `docs/architecture.md` (§19.16 → notka „Krytyk lekcji usunięty w etapie 3 #237, 2026-11-05; historia: `docs/superpowers/specs/2026-11-02-lesson-review-stage-design.md`.”; odwołania w §19.15 i §19.17; numeracja zostaje)
- Modify: `docs/SPEC.md` (§29a.9 → ta sama notka; wskazania „PR 2” krytyka; numeracja zostaje)
- Modify: `AGENTS.md` (punkt „Krytyk lekcji …”; wzmianki o krytyku w punktach o agencie puli, kluczu OpenRouter, tematach zdań; zdanie o pomiarze integracji — „dolną granicę dają najdłuższe pliki, m.in. `learning-algorithm.test.ts`”; liczby testów E2E po Task 7, Step 3)
- Modify: `.env.example` (blok `UMIEM_REVIEWER_*`), `docs/folder-structure.md` (zdanie o `pnpm probe:review`)
- Modify: `docs/superpowers/specs/2026-11-02-lesson-review-stage-design.md` i `docs/superpowers/plans/2026-11-02-lesson-review-stage-pr2-critic.md` (dopisek na początku: „Krytyk (PR 2 tego etapu) usunięty w etapie 3 #237 PR 1 (2026-11-05); reguła twarda ujawnień zostaje; runda pod etap usunięta w etapie 3 PR 2.”), `docs/superpowers/specs/2026-11-02-llm-cost-tracking-design.md` (przy wierszu `lesson_review`: „usunięty w etapie 3 #237”)
- Modify: `docs/superpowers/specs/2026-11-05-lesson-pool-agent-stage3-design.md` §2.4 i §2.5 (kolejność commitów zgodna z tym planem: `lesson-review.test.ts` usuwany w kroku 2, `review-criteria.ts` w kroku 4; `lesson-exercise-card.test.tsx` na liście plików mieszanych)

**Interfaces:** brak.

- [ ] **Step 1: Wprowadź zmiany z Files.**
- [ ] **Step 2: Sprawdź dokumenty i kod**

Run: `git grep -nE "UMIEM_REVIEWER|probe:review|lesson-review" -- AGENTS.md .env.example docs/architecture.md docs/SPEC.md docs/folder-structure.md docs/provider-config.md` → wyłącznie notki „usunięty w etapie 3”.
Run: `git grep -n -i -E "krytyk|kontrol[aię] jakości" -- packages apps tests` → wyłącznie komentarz `withoutRunReports` w `version-ops.ts` („dawny raport krytyka”); każdy inny wynik poprawić.

- [ ] **Step 3: Commit** — `Dokumentacja: krytyk lekcji usunięty (#237)`.

---

### Task 7: Weryfikacja końcowa

- [ ] **Step 1: Każdy commit się kompiluje.** Dla każdego commitu z `git rev-list --reverse f14e3ce7..HEAD`: `git checkout -q <sha>` i `corepack pnpm typecheck` → PASS; na końcu `git checkout -q feature/lesson-pool-agent-stage3-237`. Przy porażce popraw commit (nowy commit naprawczy albo przebudowa gałęzi przed push) i powtórz.
- [ ] **Step 2:** `corepack pnpm check` → PASS (typecheck, unit, build).
- [ ] **Step 3:** `corepack pnpm test:integration` → PASS; zanotuj liczbę testów i pominiętych.
- [ ] **Step 4:** `corepack pnpm test:e2e:shards` → PASS (przy `net::ERR_NO_BUFFER_SPACE` powtórz spec osobno i odnotuj); zanotuj liczby `mocked` i `real` i wpisz je do `AGENTS.md` (commit „Dokumentacja: liczby testów E2E po usunięciu krytyka (#237)”).
- [ ] **Step 5:** `git grep -nE "reviewService" -- apps/web/src packages/contracts/src packages/server/src` → wyłącznie karta pracy / ocena aktywności.
- [ ] **Step 6:** `git status` czysty; `apps/web/next-env.d.ts` bez zmian (przywróć, jeśli zmienił go przebieg dev).

---

### Task 8: Opis PR

- [ ] **Step 1: Szkic opisu** w scratchpadzie sesji (`pr-237-stage3-pr1.md`), po polsku, z sekcjami:
  - zakres (usunięty krytyk: port, adapter, env, raport w szkicu, UI, sonda, dokumentacja);
  - zostaje: ocena aktywności sesji, potok bez fazy przeglądu, reguła twarda ujawnień;
  - zgodność danych: bez migracji, stary klucz `review` zostaje w JSONB i nie jest czytany, wiersze kosztów `lesson_review` jako historia, stare `rejectedReasons`;
  - wdrożenie: usunąć `UMIEM_REVIEWER_*` z `.env`/Coolify (nieszkodliwe, ale mylące); rodzic traci linijkę „Dogenerowane ćwiczenia…” (widoczną tylko przy włączonym krytyku);
  - API → MCP → `SKILL.md`: bez zmian, z uzasadnieniem (§2.6 specu);
  - sprawdzenia z Task 7 z liczbami; kosze integracji bez przeliczenia LPT (odnotowane), ewentualne powtórki E2E;
  - zakończenie `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- [ ] **Step 2:** zapytaj właściciela o zgodę na push gałęzi i otwarcie PR do `main` (bez scalania).
