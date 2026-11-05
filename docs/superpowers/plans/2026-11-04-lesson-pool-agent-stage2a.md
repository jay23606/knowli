# Agent puli lekcji — etap 2a: adapter AI SDK i integracja — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pełna generacja i „Dogeneruj” lekcji przedmiotów z listy `UMIEM_LESSON_AGENT_SUBJECTS` idą przez kierownika agenta z produkcyjnym adapterem AI SDK, punktem kontrolnym w runie, wznawianiem i informacją dla rodzica; pozostałe przedmioty — dzisiejszym potokiem bez zmian.

**Architecture:** Wspólny zapis do szkicu wydzielony z potoku; nowa ścieżka `executeLessonAgentGeneration` wołana z `executeLessonGeneration` po wyborze `lessonGeneratorFor`; kierownik z etapu 1 dostaje hak planu, przykłady początkowe, start pod budżetem i tryb „dodaj N”; postęp w `generation_runs.agent_checkpoint` (zapis ze strażą tożsamości, podsumowanie bez treści po zapisie); adapter AI SDK w jednym pliku `providers/openai/lesson-pool-agent.ts`, składany wyłącznie przez eksport `@learning/server/lesson-agent` (worker).

**Tech Stack:** TypeScript strict, Drizzle/PostgreSQL, Vitest (unit, integration na Postgresie), Playwright, AI SDK `ai@7.0.162` + `@openrouter/ai-sdk-provider@3.1.0`, Zod 4, Next.js (panel rodzica, Mantine).

**Spec:** `docs/superpowers/specs/2026-11-04-lesson-pool-agent-stage2a-design.md` (wersja 2, zaakceptowana 2026-11-04). Spec etapu 1: `docs/superpowers/specs/2026-11-04-lesson-pool-agent-stage1-design.md`.

Wersja 2 planu po review trzech krytyków (wykonalność wobec kodu, pokrycie specu, jednoznaczność i testy).

## Global Constraints

- Nie wypychaj do `main`, nie scalaj PR; nie uruchamiaj płatnych wywołań modeli (żadnych `pnpm probe:*` z kluczem).
- Instalacja wyłącznie `pnpm install --prefer-offline --frozen-lockfile`; dodanie zależności: `pnpm --filter @learning/server add --save-exact --prefer-offline ai@7.0.162 @openrouter/ai-sdk-provider@3.1.0`. Nigdy `npm install`.
- `ai` i `@openrouter/*` importują wyłącznie: `tests/probes/**`, `packages/server/src/providers/openai/lesson-pool-agent.ts` i `packages/server/src/providers/openai/lesson-pool-agent.test.ts`.
- Adapter osiągalny tylko z `packages/server/src/providers/lesson-agent-env.ts` (eksport `@learning/server/lesson-agent`; importuje go wyłącznie `apps/worker`); `config.ts`, `generation-env.ts`, `src/index.ts` i `apps/web/**` nie importują go nawet pośrednio.
- Domena (`src/domain/**`) bez I/O, SDK, env; kierownik bez identyfikatorów przedmiotów; lista przedmiotów tylko z konfiguracji.
- `generation.ts` nie importuje `lesson-drafts` (reguła `generation-worker.architecture.test.ts`) — także pośrednio przez nowe pliki.
- Do modeli nigdy imię, rok urodzenia, identyfikatory ani odpowiedzi dziecka; logi `[lesson-agent]`/`[lesson]` bez treści ćwiczeń, materiału, kart, tematów zdań i `detail`.
- Koszty: `UsageRecorder` raz na żądanie HTTP przez helpery `recordResponse`/`recordHttpError`/`recordTransportFailure` (`providers/usage/record-http.ts`), `feature: "lesson_generation"`, `provider: "openrouter"`, operacje `agent_plan`, `agent_objective`, `check_solve`, `check_variants`.
- Wartości domyślne env: `UMIEM_LESSON_AGENT_SUBJECTS=""`, `UMIEM_LESSON_AGENT_MODEL=google/gemini-3.8-flash`, `UMIEM_LESSON_AGENT_REASONING=low`, `UMIEM_LESSON_AGENT_CHECKER_MODEL=deepseek/deepseek-v4.1-flash-1017`, `UMIEM_LESSON_AGENT_CHECKER_REASONING=low`, `UMIEM_LESSON_AGENT_MAX_STEPS=8`, `UMIEM_LESSON_AGENT_CONCURRENCY=4`, `UMIEM_LESSON_AGENT_CHECKER_CONCURRENCY=4`, `UMIEM_LESSON_AGENT_OBJECTIVE_TIMEOUT_MS=300000`, `UMIEM_LESSON_AGENT_CHECKER_TIMEOUT_MS=90000`, `UMIEM_LESSON_AGENT_RUN_BUDGET_USD=1.00`.
- Rezerwa finalizacji: `AGENT_FINALIZATION_RESERVE_MS = 30_000`, nadpisywalna w `LessonAgentDeps.finalizationReserveMs` (testy).
- Teksty UI po polsku, w `packages/contracts/src/messages.ts`; kod, nazwy i klucze po angielsku; komentarze w stylu otoczenia (po polsku).
- Potok (przedmioty spoza listy): istniejące testy potoku (jednostkowe, integracyjne, E2E) przechodzą bez zmian asercji; zmiany asercji dozwolone tylko w testach agenta z etapu 1 dotkniętych zmianą nazwy pól.
- Komendy: pojedynczy plik integracyjny `pnpm test:integration tests/integration/<plik>.test.ts` (bez `--`); testy weba i jednostkowe z aliasami `pnpm test:unit <ścieżka>`; serwerowe jednostkowe `pnpm vitest run --config vitest.unit.config.ts <ścieżka>` (gdy `pnpm test:unit <ścieżka>` też działa — użyj go).
- Komunikaty commitów po polsku w stylu repo („Lekcje: …”) z sufiksem `(#237)` i stopką `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Każdy commit zostawia zielone `pnpm typecheck` i testy dotkniętych obszarów.

## Review Focus

1. Run, któremu kontroler kończy czas w trakcie podagentów, zapisuje część (`succeeded`), a nie `failed`/`provider_timeout` — Task 10, test „termin runu” (termin 3000 ms, rezerwa 1000 ms).
2. „Dogeneruj +2” w zagadnieniu z 12 ćwiczeniami nie dodaje więcej niż `2 + stageGap + listenLeft` — Task 4 (jednostkowy), Task 12 (integracyjny).
3. Edycja szkicu w trakcie runu (także podbicie `editNumber` przez nadzór) nie zostawia runu w `running`, nie zapisuje na starej wersji i zeruje treść punktu kontrolnego — Task 5, Task 11.
4. Zły klucz OpenRouter (401) nie ponawia runu i nie zgłasza `validation` — Task 6 (mapowanie), Task 8 (wiersz 6), Task 9 (test).
5. Restart workera w ostatniej próbie z zapisanym postępem kończy się zapisem części, nie `attempts_exhausted`; potok przy `attempts > MAX` zachowuje dzisiejszy kod — Task 9, Task 10.

---

### Task 1: Wspólny zapis do szkicu (czysty refaktor)

**Files:**
- Modify: `packages/server/src/modules/materials/lessons/lesson-drafts.ts` (transakcja końcowa i `failValidation` w `executeLessonGeneration`, ok. l. 1931–2100; `markCurrentRun` l. 1554; `existingDraftsOf` ok. l. 1329)

**Interfaces:**
- Produces:
  ```ts
  export interface LessonPoolWriteContext {
    readonly dynamicTopic?: DynamicTopicData;
    readonly newExamples: Record<string, string[]>;
    readonly rejectedCount: number;                 // tej próby; sumowany z poprzednim kontekstem
    readonly rejectedReasons: Record<string, number>;
    readonly droppedObjectiveCount: number;
  }
  export interface LessonRunIdentity { readonly runId: string; readonly attempts: number; readonly expectedEditNumber: number; readonly deckVersionId: string }
  export async function markLessonRun(db: Executor, run: LessonRunIdentity, state: "failed" | "succeeded" | "superseded" | "queued", errorCode: string | null, nextAttemptAt?: Date | null): Promise<void>;  // straż i log jak dzisiejsze markCurrentRun
  export async function finalizeLessonPoolWrite(services: Services, args: {
    run: LessonRunIdentity; subject: SubjectModule; topicVersion: number | undefined; regenerate: boolean;
    existingDrafts: readonly LessonExerciseDraft[]; accepted: readonly LessonExerciseDraft[];
    context: LessonPoolWriteContext;
    /** Brak = raport krytyka w kontekście zostaje bez zmian (ścieżka agenta). */
    review?: (tx: Tx, versionId: string, previous: LessonReviewReport | undefined,
              saved: readonly { draft: LessonExerciseDraft; exerciseId: string }[]) => Promise<LessonReviewReport>;
    /** Ścieżka agenta: dodatkowe pola kontekstu i zapis w tej samej transakcji (Task 10). */
    extendContext?: (next: LessonContext) => LessonContext;
    onSuccessTransaction?: (tx: Tx) => Promise<void>;
    finalizationDeadlineAtMs: number; signal?: AbortSignal;
  }): Promise<"succeeded" | "failed_validation" | "superseded" | "gone">;
  export async function failLessonPoolValidation(services: Services, args: { run: LessonRunIdentity; context: LessonPoolWriteContext; review?: …; extendContext?: … }): Promise<void>;
  export async function orderedDraftExercises(db: Executor, deckVersionId: string): Promise<LessonExerciseDraft[]>;  // kolejność lekcji
  ```
  `onSuccessTransaction` wołany wyłącznie w gałęzi sukcesu: po blokadach, strażach i `applyLessonExercises`, **przed** podbiciem `editNumber`, `supersedeLessonRuns` i `markLessonRun("succeeded")`; zapisuje zwykłym `UPDATE … WHERE id` (wiersz runu jest już zablokowany `FOR UPDATE`). Gałąź „0 po kolizjach z historyjką” (`failed_validation` w transakcji) go nie woła.

- [ ] **Step 1:** Zanotuj wynik testów potoku przed refaktorem: `pnpm test:unit packages/server/src/modules/materials/lessons` i `pnpm test:integration tests/integration/lesson-generation.test.ts tests/integration/lesson-review.test.ts tests/integration/lesson-story.test.ts tests/integration/lesson-chapter.test.ts tests/integration/generation.test.ts` — Expected: PASS.
- [ ] **Step 2:** Przenieś kroki transakcji końcowej (blokady wersja → run, straże, kolizje z historyjką, `withoutOrphanKeywords`, `applyLessonExercises`, `lessonContext` z sumowaniem liczników, `reconcileDraftAssetsTx`, `editNumber + 1`, `supersedeLessonRuns` z `includeStoryRuns: !regenerate`, `queueLessonStoryRunTx`, stan `review`, `succeeded`) do `finalizeLessonPoolWrite`, `failValidation` do `failLessonPoolValidation`, `markCurrentRun` do `markLessonRun`. `executeLessonGeneration` woła je z dzisiejszymi wartościami (`review: mergedReview`). Bez `review` pole `review` kontekstu nie jest dotykane.
- [ ] **Step 3:** Testy ze Step 1 i `pnpm typecheck` — Expected: PASS bez zmian asercji.
- [ ] **Step 4:** Commit: `Lekcje: wspólny zapis puli do szkicu wydzielony z generowania (#237)`.

### Task 2: `control.run` w kontrolerze generowania

**Files:**
- Modify: `packages/server/src/modules/materials/lessons/lesson-generation-control.ts`
- Test: `packages/server/src/modules/materials/lessons/lesson-generation-control.test.ts`

**Interfaces:**
- Produces: `LessonGenerationControl.run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T>` oraz `LessonGenerationControl.deadlineAtMs: number` (= `startedAt + runTimeoutMs`, zegar `now`). Mapowanie przerwania jak w `invoke`: `superseded`/`shutdown` → `LessonGenerationCancelledError`, termin runu → `GenerationProviderError("timeout")` (spec §7.2: timeout kontrolera kończy się `failed`/`provider_timeout`).

- [ ] **Step 1: Testy** (`describe("run")`, `vi.useFakeTimers()` jak istniejące testy): `"run nie ma limitu pojedynczego żądania"` (`requestTimeoutMs: 25, runTimeoutMs: 500`, praca 100 ms → wynik); `"run mapuje przerwanie: superseded, shutdown, timeout"` (praca rzucająca `signal.reason` też mapowana); `"deadlineAtMs = start + runTimeoutMs"`.
- [ ] **Step 2:** `pnpm test:unit packages/server/src/modules/materials/lessons/lesson-generation-control.test.ts` — FAIL.
- [ ] **Step 3:** Implementuj (`verifyCurrent`, wyścig z `root.signal` bez `requestTimer`, `verifyCurrent` po sukcesie).
- [ ] **Step 4:** Test — PASS.
- [ ] **Step 5:** Commit: `Lekcje: kontroler generowania uruchamia długą pracę bez limitu żądania (#237)`.

### Task 3: Kierownik — hak planu, przykłady, budżet, porażki; rozszerzenia fake'ów

**Files:**
- Modify: `packages/server/src/modules/materials/lessons/lesson-pool-agent.ts`, `lesson-pool-agent-tools.ts`, `lesson-pool-agent-plan.ts`, `lesson-pool-agent-input.ts`, `packages/server/src/providers/fake-lesson-agent.ts`
- Test: `lesson-pool-agent.test.ts`, `lesson-pool-agent.limits.test.ts`, `lesson-pool-agent-tools.test.ts`, `packages/server/src/providers/fake-lesson-agent.test.ts`

**Interfaces:**
- Produces (pola `LessonPoolAgentRunInput`, opcjonalne):
  ```ts
  readonly initialExamples?: Readonly<Record<string, readonly string[]>>;
  readonly examplesFixed?: boolean;                   // brak = (source === "planner")
  readonly extraExposureSources?: readonly string[];  // stałe źródła ujawnień (zdania historyjki)
  readonly onObjectivesResolved?: (resolved: { readonly dynamicTopic?: DynamicTopicData; readonly planExamples: Readonly<Record<string, readonly string[]>>; readonly spentUsd: number }) => Promise<void>;
  ```
  `SettledObjective.spentUsd: number` (= `cost.spentUsd`); `SettledObjective.failure?: { errorCode; retryable: boolean; retryAfterMs?: number }`; `LessonPoolAgentResult.planFailure?: { errorCode; retryable; retryAfterMs? }`. Przerwanie terminem runu/zagadnienia (powody `"run_timeout"`, `"objective_timeout"`) w planerze klasyfikowane jako `provider_timeout`, `retryable: false`. `examplesFixed` przechodzi do narzędzi (`ObjectiveToolsArgs.examplesFixed`, dawniej `examplesFromPlan`) **i** do wejścia podagenta (`LessonObjectiveAgentInput.objective.examplesFromPlan`, prompt).
  Fake'i:
  ```ts
  FakeLessonPoolAgentOptions.objectives?: Record<string, FakeAgentStep[] | { calls: FakeAgentStep[][] }>;  // calls[i] = scenariusz i-tego wywołania runObjective dla sluga (ponowienia)
  FakeAgentStep |= { gate: Promise<void>; onReached?: () => void };   // krok czeka na gate (z przerwaniem), onReached sygnalizuje dojście
  FakeLessonPoolAgentOptions.usage?: UsageRecorder;  // jeden recordResponse na krok: provider "openrouter", operation "agent_objective" / "agent_plan"
  ```

- [ ] **Step 1: Testy kierownika** (fake'i): `"onObjectivesResolved: planer — przed pierwszym podagentem, spentUsd planera"`; `"onObjectivesResolved: katalog (bez dynamicTopic) i wejście"`; `"błąd onObjectivesResolved przerywa run bez podagentów"`; `"initialExamples liczą się do statusu i są źródłem ujawnień"`; `"examplesFixed przy źródle input: submit ignoruje przykłady, prompt nie prosi o przykłady"`; `"extraExposureSources odrzucają ćwiczenie samodzielne z tym zdaniem"`; `"wyczerpany budżet (katalog): zagadnienia nie startują, status incomplete"`; `"spentUsd bez podwójnego liczenia initialSpentUsd"` (0.3 + krok 0.1 → 0.4); `"failure niesie retryable"` (`rate_limit` z `retryAfterMs` 5000 → retryable; `configuration` → nie); `"plan przerwany terminem → plan_failed provider_timeout, retryable false"`.
- [ ] **Step 2: Testy fake'ów:** `"calls: drugie wywołanie zagadnienia bierze drugi scenariusz"`; `"gate: krok czeka, onReached wołane, przerwanie sygnałem odrzuca"`; `"usage: jeden zapis na krok"`.
- [ ] **Step 3:** `pnpm test:unit packages/server/src/modules/materials/lessons/lesson-pool-agent packages/server/src/providers/fake-lesson-agent.test.ts` — FAIL.
- [ ] **Step 4:** Implementuj (`initialExamples` scalane do stanu, przykłady planu wygrywają per zagadnienie; `extraExposureSources` do `fixedSources` pod kluczem `"__extra"`; `runOne` sprawdza `cost.exhausted()` przed startem i rozlicza jak termin; hak po rozwiązaniu tematu).
- [ ] **Step 5:** Testy — PASS (także istniejące testy kierownika i narzędzi po zmianie nazwy pola).
- [ ] **Step 6:** Commit: `Lekcje: kierownik agenta — hak planu, przykłady początkowe i start pod budżetem (#237)`.

### Task 4: Tryb „dodaj N” w kierowniku

**Files:**
- Modify: `packages/server/src/domain/lessons/agent/status.ts`, `packages/server/src/modules/materials/lessons/lesson-pool-agent.ts`, `lesson-pool-agent-tools.ts`, `lesson-pool-agent-input.ts`
- Test: `packages/server/src/domain/lessons/agent/status.test.ts`, `packages/server/src/modules/materials/lessons/lesson-pool-agent.add.test.ts` (nowy)

**Interfaces:**
- Consumes: Task 3.
- Produces:
  ```ts
  // ObjectiveStatus dostaje: readonly stageGaps: { guided: number; productive: number; independent: number }  // required − actual, ≥ 0
  export function stageGapOf(status: ObjectiveStatus): number;
  export function addModeStatus(status: ObjectiveStatus, added: number, remaining: number): { readonly missing: string[]; readonly complete: boolean };
  //   complete = added >= remaining && stageGapOf(status) === 0; missing = [`new exercises: ${added} of ${remaining}`, ...status.missing]
  readonly target?: { readonly mode: "pool" } | { readonly mode: "add"; readonly objectiveId: string; readonly count: number };  // LessonPoolAgentRunInput
  // objectiveAgentInput(args) dostaje opcjonalne `promptTargetCount?: number` (targets.targetCount i podział etapów z niego zamiast z limits.targetCount)
  ```
  Tryb `add` w kierowniku (bez `objectiveAgentLimits`): `remaining = count`; `listenAllowance = listenChoiceAllowance(subject, objective, [])`; `listenLeft = max(0, listenAllowance − słuchowe zagadnienia w fixed)`; `stageGap0 = stageGapOf(status na starcie)`; limity `{ targetCount: fixedOnStagePath + remaining, listenAllowance, maxExercises: remaining + stageGap0 + listenLeft }`; `promptTargetCount = remaining + stageGap0`; `shouldStop` i `settle()` używają `addModeStatus`.

- [ ] **Step 1: Testy domeny:** `"stageGaps zgodne z missing etapów"`; `"addModeStatus: komplet tylko przy remaining nowych i bez braków etapów"`; `"addModeStatus: missing zaczyna się od new exercises"`.
- [ ] **Step 2: Testy kierownika:** `"uruchamia tylko wybrane zagadnienie"`; `"planner w trybie add → validation bez wywołań"`; `"nieznane zagadnienie → validation"`; `"limit nowych: 12 w szkicu, +2, pełne etapy → najwyżej 2 + listenLeft"` (jeden krok zgłasza 8; reszta `limit_full`); `"brak etapu: komplet po remaining i uzupełnieniu etapu"`; `"zagadnienie już pełne: shouldStop dopiero po remaining nowych"`; `"targets promptu: 12 w szkicu, +2, pełne etapy → targets.targetCount === 2"`; `"ćwiczenia szkicu innych zagadnień są źródłem ujawnień"`.
- [ ] **Step 3:** `pnpm test:unit packages/server/src/domain/lessons/agent packages/server/src/modules/materials/lessons/lesson-pool-agent` — FAIL.
- [ ] **Step 4:** Implementuj (bez identyfikatorów przedmiotów).
- [ ] **Step 5:** Testy i `pnpm test:unit packages/server/src/modules/module-boundaries.architecture.test.ts packages/server/src/domain/lessons` — PASS.
- [ ] **Step 6:** Commit: `Lekcje: kierownik agenta — tryb dogenerowania zagadnienia o N ćwiczeń (#237)`.

### Task 5: Punkt kontrolny — kolumna, schemat, zapis ze strażą, czyszczenie, „Ponów”

**Files:**
- Create: `packages/server/drizzle/0037_generation_run_agent_checkpoint.sql` (**ręcznie**, bez `db:generate` — migawki po 0017 to znany dług, zob. `0031_generation_rejected_count.sql`), wpis idx 37 w `packages/server/drizzle/meta/_journal.json` (ręcznie, `when` większe od poprzedniego), `packages/server/src/modules/materials/lessons/lesson-agent-checkpoint.ts`, `lesson-agent-checkpoint.test.ts`, `tests/integration/lesson-agent-generation.test.ts` (nowy; dopisz do **trzeciego** kosza `INTEGRATION_BUCKETS` — bez świeżego pomiaru kosze są zrównoważone; nota w komentarzu nie jest potrzebna)
- Modify: `packages/server/src/db/schema.ts` (`agentCheckpoint: jsonb("agent_checkpoint").$type<Record<string, unknown>>()`), `packages/server/src/modules/materials/generation-runs.ts` (`supersedeLessonRuns` zeruje kolumnę; nowe `resetLessonAgentBudget`), `packages/server/src/modules/materials/generation.ts` (`retryGeneration`), `packages/server/src/modules/materials/lessons/lesson-drafts.ts` (`markLessonRun(…, "superseded")` zeruje kolumnę), `docs/schema.sql`

**Interfaces:**
- Produces (`lesson-agent-checkpoint.ts`):
  ```ts
  export type LessonAgentProgress = { version: 1; kind: "progress"; dynamicTopic?: DynamicTopicData; droppedObjectiveCount?: number;
    planExamples?: Record<string, string[]>;
    objectives: Record<string, { status: "complete" | "incomplete" | "failed"; failureCode?: string; exercises: LessonExerciseDraft[]; examples: string[] }>;
    budgetSpentUsd: number; totalSpentUsd: number; rejectionCodes: Record<string, number>; removedAfterAcceptance: number };
  export type LessonAgentSummary = { version: 1; kind: "summary"; objectives: Record<string, { status: string; accepted: number; failureCode?: string }>;
    totalSpentUsd: number; rejectionCodes: Record<string, number>; attempts: number };
  export function parseLessonAgentProgress(value: unknown): LessonAgentProgress | undefined;   // Zod dla obwiedni + guard kształtu ćwiczeń (isWellShapedRawExercise/toExerciseDraft); uszkodzony/summary/inna wersja → undefined + log `[lesson-agent] run=… checkpoint=invalid` (bez treści)
  export function summarizeLessonAgentProgress(progress: LessonAgentProgress, attempts: number): LessonAgentSummary;
  export function emptyLessonAgentProgress(): LessonAgentProgress;
  export class LessonAgentCheckpointLostError extends Error {}
  export async function saveLessonAgentCheckpoint(db: Executor, run: LessonRunIdentity, value: LessonAgentProgress): Promise<void>;   // SQL straży ze specu §8.2; 0 wierszy → LessonAgentCheckpointLostError
  ```
  `generation-runs.ts`: `export async function resetLessonAgentBudget(tx: Executor, runId: string): Promise<void>` — czysty SQL `jsonb_set(agent_checkpoint, '{budgetSpentUsd}', '0') WHERE id = $1 AND agent_checkpoint->>'kind' = 'progress'` (bez importu `lesson-drafts`).

- [ ] **Step 1: Testy jednostkowe:** `"parse: poprawny postęp"`, `"parse: podsumowanie → undefined"`, `"parse: uszkodzone ćwiczenie → undefined i log bez treści"`, `"parse: inna wersja → undefined"`, `"summarize: bez treści"` (`JSON.stringify(summary)` nie zawiera tekstu ćwiczenia z fixture).
- [ ] **Step 2: Testy integracyjne** (`describe("punkt kontrolny")`): `"zapis przechodzi dla bieżącej próby"`; `"odrzucony po edycji rodzica (superseded)"`; `"odrzucony po podbiciu editNumber bez anulowania runów"`; `"odrzucony dla starej próby (inne attempts)"`; `"supersedeLessonRuns zeruje kolumnę"`; `"markLessonRun superseded zeruje kolumnę"`; `"Ponów: porażka, running i odroczone queued — postęp zostaje, budżet 0, totalSpentUsd bez zmian"`.
- [ ] **Step 3:** `pnpm test:unit packages/server/src/modules/materials/lessons/lesson-agent-checkpoint.test.ts` i `pnpm test:integration tests/integration/lesson-agent-generation.test.ts` — FAIL.
- [ ] **Step 4:** Implementuj; `retryGeneration` woła `resetLessonAgentBudget` w każdej gałęzi runu puli lekcji ustawiającej `queued`, pod istniejącym `FOR UPDATE`.
- [ ] **Step 5:** Testy, `pnpm test:unit tests/integration-buckets.test.ts packages/server/src/modules/materials/generation-worker.architecture.test.ts` — PASS.
- [ ] **Step 6:** Commit: `Lekcje: punkt kontrolny agenta w runie generowania ze strażą tożsamości (#237)`.

### Task 6: Produkcyjny adapter AI SDK

**Files:**
- Create (przez `git mv`): `packages/server/src/providers/openai/lesson-pool-agent.ts` ← `tests/probes/ai-sdk-lesson-agent.ts`; `packages/server/src/providers/openai/lesson-pool-agent.test.ts` ← `tests/probes/ai-sdk-lesson-agent.test.ts`
- Modify: `tests/probes/agent-generation.probe.test.ts` (import i wywołania konstruktorów, l. 267–268), `vitest.unit.config.ts` (ścieżka testu), `packages/server/package.json`, `pnpm-lock.yaml`, `tests/ai-sdk-scope.test.ts` (dozwolone pliki; `SENSITIVITY_FIXTURES` += `packages/server/src/providers/usage-recording.architecture.test.ts`), `packages/server/src/providers/usage-recording.architecture.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
  export interface AiSdkLessonAgentOptions {
    readonly apiKey: string; readonly model: string; readonly effort: string;
    readonly provider?: Readonly<Record<string, unknown>>;   // providerOptions.openrouter.provider
    readonly usage?: UsageRecorder;
    /** Szwy testowe: gotowy model (MockLanguageModelV4) albo fetch przekazany do createOpenRouter. */
    readonly languageModel?: LanguageModel;
    readonly fetch?: typeof fetch;
  }
  export class AiSdkLessonPoolAgent implements LessonPoolAgentProvider { constructor(options: AiSdkLessonAgentOptions) }
  export class AiSdkExerciseChecker implements LessonExerciseCheckerProvider { constructor(options: AiSdkLessonAgentOptions) }
  export function toGenerationProviderError(error: unknown, signal: AbortSignal): unknown;   // tabela §4 specu; bez cause
  export function openRouterCostOf(meta: ProviderMetadata | undefined): number | null;
  ```
  Model: `languageModel ?? createOpenRouter({ apiKey, baseURL: OPENROUTER_BASE_URL, ...(fetch ? { fetch } : {}) }).chat(model, { usage: { include: true } })`. `providerOptions.openrouter = { ...(effort !== "none" ? { reasoning: { effort } } : {}), ...(provider ? { provider } : {}) }`.

- [ ] **Step 1:** `pnpm --filter @learning/server add --save-exact --prefer-offline ai@7.0.162 @openrouter/ai-sdk-provider@3.1.0`; `git diff pnpm-lock.yaml` — tylko importer `packages/server`.
- [ ] **Step 2:** `git mv` obu plików; importy; konstruktory w próbie dostają `{ apiKey: "", model: modelId, effort, languageModel: openrouter.chat(...) }`; `vitest.unit.config.ts`. `pnpm test:unit packages/server/src/providers/openai/lesson-pool-agent.test.ts` — PASS (przeniesione testy przez `languageModel`).
- [ ] **Step 3: Nowe testy:**
  - `"mapowanie błędów"` — tabela: 401/402/403 → `configuration`; 429 z `retry-after: 7` → `rate_limit`, 7000; 408/500/503, błąd sieci i `isRetryable` → `transient`; 400/422 → `output`; `NoObjectGeneratedError`, `NoOutputGeneratedError`, `InvalidToolInputError`, błąd JSON → `output`; bez `cause`; przerwanie → `signal.reason`; `TypeError` z narzędzia → bez zmian;
  - `"maxRetries 0: odpowiedź 500 → dokładnie jedno żądanie"`;
  - `"usage ok raz na żądanie dla każdej operacji"` — `agent_plan`, `agent_objective`, `check_solve`, `check_variants`; `provider: "openrouter"`; `providerCostUsd` z metadanych; w `withUsageScope({ runId })` zdarzenie ma zakres;
  - `"błąd HTTP: recordHttpError z httpStatus, RunCostSink 0"`; `"brak odpowiedzi: recordTransportFailure, RunCostSink null"`;
  - `"providerOptions: wysiłek, routing; effort none bez reasoning"`;
  - `"klucz i baseURL jawne"` — opcja `fetch` (stub zwracający gotowe ciało chat-completions), `process.env` bez kluczy OpenRouter; asercja hosta `openrouter.ai`, ścieżki `/api/v1/chat/completions` i nagłówka `Authorization: Bearer test-key`;
  - `"adaptery nic nie logują"` (szpieg `console.log/warn/error`).
- [ ] **Step 4:** Testy — FAIL dla nowych.
- [ ] **Step 5:** Implementuj (lokalna flaga `recorded` jak w `record-http.ts`; `recordResponse(usage, base, 200, { usage: { prompt_tokens, completion_tokens, cost } })`).
- [ ] **Step 6: Testy architektury:** `ai-sdk-scope`: dozwolone `tests/probes/` i oba pliki adaptera; `packages/server/package.json` może deklarować obie zależności w dokładnej wersji, inne manifesty nie; dowód czułości dla innego pliku w `providers/`. `usage-recording`: wykrywanie importu `ai`/`@openrouter/*`; `"openai/lesson-pool-agent.ts"` w `PAID_ADAPTERS`; dla pliku SDK `recordCalls ≥ 3`.
- [ ] **Step 7:** `pnpm test:unit tests/ai-sdk-scope.test.ts packages/server/src/providers` i `pnpm typecheck` — PASS.
- [ ] **Step 8:** Commit: `Lekcje: produkcyjny adapter AI SDK agenta puli z mapowaniem błędów i kosztami (#237)`.

### Task 7: Konfiguracja agenta (parsowanie, bez SDK)

**Files:**
- Modify: `packages/server/src/config-defaults.ts`, `packages/server/src/config.ts`, `packages/server/src/providers/openrouter-key.ts`, `packages/server/src/providers/chat-request-options.ts`, `packages/server/src/index.ts`
- Test: `packages/server/src/config.test.ts`, `packages/server/src/providers/openrouter-key.test.ts`, `packages/server/src/providers/chat-request-options.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // chat-request-options.ts — nowe, bez wymogu BASE_URL
  export function openRouterProviderRoutingFromEnv(env: Record<string, string | undefined>, prefix: string, inheritFrom?: string): Readonly<Record<string, unknown>> | undefined;
  //   klucze `${prefix}_PROVIDER_*` (te same przyrostki co chatRequestExtrasFromEnv); każdy nieustawiony dziedziczy `${inheritFrom}_PROVIDER_*` osobno
  // openrouter-key.ts
  export function lessonAgentKeyFromEnv(env: Record<string, string | undefined>): string | undefined;   // UMIEM_LESSON_AGENT_API_KEY → OPENROUTER_API_KEY → UMIEM_LLM_API_KEY (gdy isSecureOpenRouterEndpoint(UMIEM_LLM_BASE_URL))
  // config.ts
  export interface LessonAgentSettings {
    readonly subjects: ReadonlySet<string>; readonly apiKey: string;
    readonly model: string; readonly effort: string; readonly provider?: Readonly<Record<string, unknown>>;
    readonly checkerModel: string; readonly checkerEffort: string; readonly checkerProvider?: Readonly<Record<string, unknown>>;
    readonly policy: Partial<LessonAgentPolicy>;   // maxStepsPerObjective = planMaxSteps = MAX_STEPS, concurrency, checkerConcurrency, objectiveTimeoutMs, checkerTimeoutMs, runBudgetUsd
  }
  export function lessonAgentSettingsFromEnv(env, subjects: Pick<SubjectRegistry, "getSubject">): LessonAgentSettings | undefined;
  export function lessonAgentPublicFromEnv(env, subjects): { readonly subjects: ReadonlySet<string>; readonly generationService: string; readonly checkService: string } | undefined;
  export interface LessonAgentDeps { readonly subjects: ReadonlySet<string>; readonly agent: LessonPoolAgentProvider; readonly checker: LessonExerciseCheckerProvider; readonly policy: Partial<LessonAgentPolicy>; readonly finalizationReserveMs?: number }
  // GenerationDeps.lessonAgent?: LessonAgentDeps
  ```
  Kolejność w `lessonAgentSettingsFromEnv`: pusta lista → `undefined`; walidacja listy (nieznany identyfikator albo bez `agentPolicy` → rzuca), liczb, wysiłków (`xhigh|high|medium|low|minimal|none`), rodzin (ten sam prefiks przed `/` → rzuca z `UMIEM_LESSON_AGENT_CHECKER_MODEL`); potem klucz — brak → `undefined` + jedno `console.warn` „[config] UMIEM_LESSON_AGENT_SUBJECTS bez klucza OpenRouter — lekcje generuje potok”. Routing: `openRouterProviderRoutingFromEnv(env, "UMIEM_LESSON_AGENT", "UMIEM_LLM")` i `(…, "UMIEM_LESSON_AGENT_CHECKER", "UMIEM_LLM")`; `require_parameters: true` dokładany, gdy wysiłek ≠ `none`. Nazwy usług: `"openrouter.ai · <model>"`, `"openrouter.ai · <checkerModel>"`. `lessonAgentPublicFromEnv` nigdy nie rzuca: pomija nieznane i bez polityki, nie wymaga klucza, pusta lista po filtrze → `undefined`; `UMIEM_FAKE_PROVIDERS=1` → nazwy `"fake-lesson-agent-model"`, `"fake-lesson-checker-model"`.

- [ ] **Step 1: Testy:** `config.test.ts`: pusta lista; lista bez klucza (ostrzeżenie); kolejność kluczy; nieznany przedmiot; bez polityki; ta sama rodzina; `MAX_STEPS=abc`; nieznany wysiłek; routing: własne `ORDER` + odziedziczone `DATA_COLLECTION=deny`, `require_parameters` przy `low`, brak przy `none`; brak `UMIEM_LESSON_AGENT_BASE_URL` nie rzuca. `lessonAgentPublicFromEnv`: nieznany i bez polityki pominięte bez wyjątku, brak klucza → nazwy usług, fake → nazwy fake. `openrouter-key.test.ts` i `chat-request-options.test.ts` dla nowych funkcji.
- [ ] **Step 2:** `pnpm test:unit packages/server/src/config.test.ts packages/server/src/providers/openrouter-key.test.ts packages/server/src/providers/chat-request-options.test.ts` — FAIL.
- [ ] **Step 3:** Implementuj; `config-defaults.ts` sekcja z komentarzem jak inne.
- [ ] **Step 4:** Testy i `pnpm typecheck` — PASS.
- [ ] **Step 5:** Commit: `Lekcje: konfiguracja agenta puli per przedmiot (#237)`.

### Task 8: Składanie w workerze i tryb fake

**Files:**
- Create: `packages/server/src/providers/lesson-agent-env.ts`, `lesson-agent-env.test.ts`, `packages/server/src/providers/lesson-agent-imports.architecture.test.ts`
- Modify: `packages/server/src/providers/fake-lesson-agent.ts`, `packages/server/src/providers/generation-env.ts`, `packages/server/package.json` (`"exports": { ".": "./src/index.ts", "./lesson-agent": "./src/providers/lesson-agent-env.ts" }`), `apps/worker/src/composition.ts`
- Test: `packages/server/src/providers/fake-lesson-agent.test.ts`

**Interfaces:**
- Consumes: Task 3 (fake), Task 6 (adapter), Task 7 (`lessonAgentSettingsFromEnv`, `LessonAgentDeps`).
- Produces:
  ```ts
  // lesson-agent-env.ts
  export function lessonAgentDepsFromEnv(env, subjects: Pick<SubjectRegistry, "getSubject">, usage?: UsageRecorder, llm?: LlmProvider): LessonAgentDeps | undefined;
  //   UMIEM_FAKE_PROVIDERS=1 i niepusta lista (po walidacji listy, bez wymogu klucza) → FakeLessonPoolAgent({ fromLlm: llm, usage }) + FakeExerciseChecker({ unavailable: true })
  //   inaczej → lessonAgentSettingsFromEnv; undefined → undefined; settings → AiSdkLessonPoolAgent/AiSdkExerciseChecker
  // generation-env.ts
  export function createGenerationDepsFromEnv(env, usage?, options?: { readonly lessonAgent?: LessonAgentDeps }): GenerationDeps | undefined;   // wstawia lessonAgent
  // fake-lesson-agent.ts
  FakeLessonPoolAgentOptions.fromLlm?: LlmProvider;
  FakeExerciseCheckerOptions.unavailable?: true;   // solve/judge → null dla każdej pozycji
  ```
  `fromLlm` (gdy brak scenariusza dla sluga):
  - podagent: jeden krok `submit({ exercises: res.exercises.filter(e => e.objectiveId === input.objective.id), examples: input.objective.examplesFromPlan ? undefined : res.examples?.[input.objective.id] })` z `res = await llm.generateLessonPool(input.pool, signal)`;
  - planer: deterministyczny plan z `input.coverage` (gdy brak — z nagłówków materiału): 3 zagadnienia; słowa `coverage.words` dzielone po kolei na 2 zagadnienia `kind: "words"` (karta: „Words” + lista słów), ramy `coverage.frames` w trzecim `kind: "frame"` (karta: „Frames” + lista ram; przy braku ram — trzecie zagadnienie słów); każde z jednym przykładem = pierwsze słowo lub rama; tytuły „Część 1/2/3”; wynik przez `propose`.
  `apps/worker/src/composition.ts`: `const base = createGenerationDepsFromEnv(env, usage)`; `const lessonAgent = lessonAgentDepsFromEnv(env, subjects, usage, base?.llm)`; `const generation = base && createGenerationDepsFromEnv(env, usage, { lessonAgent })` (albo `{ ...base, lessonAgent }` — wybierz wariant opcji, zgodny ze specem).

- [ ] **Step 1: Testy:** `fake-lesson-agent.test.ts`: `"fromLlm: rozdział (planer) — plan przechodzi validateAgentPlan i bramkę pokrycia; run daje ≥ 1 przyjęte ćwiczenie"`, `"fromLlm: gramatyka (katalog) ≥ 1"`, `"fromLlm: szkoła (wejście z fake generateLessonObjectives) ≥ 1"` (prawdziwy kierownik, `FakeLlmProvider`, checker `unavailable`); `"checker unavailable → null"`. `lesson-agent-env.test.ts`: fake + lista → fake'i (bez klucza); bez listy → `undefined`; z kluczem → instancje adaptera z modelami z env. Architektura importów: tylko `lesson-agent-env.ts` (poza testem adaptera i `tests/probes`) importuje `providers/openai/lesson-pool-agent`; `config.ts`, `generation-env.ts`, `index.ts` nie importują `lesson-agent-env` (także pośrednio — skan grafu importów względnych); żaden plik `apps/web/**` nie importuje `@learning/server/lesson-agent`; `apps/worker/src/composition.ts` importuje.
- [ ] **Step 2:** `pnpm test:unit packages/server/src/providers` — FAIL.
- [ ] **Step 3:** Implementuj.
- [ ] **Step 4:** Testy, `pnpm typecheck` i dym importu: `pnpm --filter @learning/worker exec tsx -e "await import('@learning/server/lesson-agent')"` — PASS.
- [ ] **Step 5:** Commit: `Lekcje: składanie agenta puli w workerze i tryb fake (#237)`.

### Task 9: Funkcje czyste ścieżki agenta

**Files:**
- Create: `packages/server/src/modules/materials/lessons/lesson-agent-outcome.ts`, `lesson-agent-outcome.test.ts`
- Modify: `packages/server/src/domain/lessons/agent/status.ts` (`finalLessonCheck`), `status.test.ts`, `packages/server/src/modules/materials/lessons/lesson-drafts.ts` (`LessonContext.generationGaps?`, typ `LessonGenerationGap`)

**Interfaces:**
- Consumes: Task 3, Task 5 (`LessonAgentProgress`), Task 7 (`LessonAgentDeps`).
- Produces:
  ```ts
  export type LessonGenerationGap = { objectiveId: string; reason: "incomplete" | "failed" | "add_short"; added?: number; requested?: number };
  export function lessonGeneratorFor(subject: SubjectModule, agent: LessonAgentDeps | undefined): "agent" | "pipeline";
  export function lessonAgentRunInputFor(args: {
    runId: string; attempts: number; expectedEditNumber: number; subject: SubjectModule; input: LessonRunInput;
    progress: LessonAgentProgress | undefined; draft: { exercises: readonly LessonExerciseDraft[]; examples: Record<string, string[]>; dynamicTopic?: DynamicTopicData; storySentences?: readonly string[] };
    catalogTopic?: LessonTopic;   // resolveLessonTopic dla katalogu
    schoolTopic?: DynamicTopicData;   // wynik etapu zagadnień (szkoła), gdy policzony w tej próbie
  }): Omit<LessonPoolAgentRunInput, "onObjectivesResolved" | "onObjectiveSettled"> | { needsObjectives: true };
  //   tabela §7.1 specu, oba tryby; examplesFixed = true gdy progress.planExamples albo source planner albo add; familyScope = `${runId}:${expectedEditNumber}:${attempts}`;
  //   tryb add: count = count − nowe z progress; fixed = szkic + nowe z progress; extraExposureSources = storySentences
  export type LessonAgentOutcome = { kind: "requeue"; errorCode: string; retryAfterMs?: number } | { kind: "finalize" } | { kind: "failed"; errorCode: string };
  export function lessonAgentRunOutcome(args: {
    planStatus: LessonPoolAgentResult["planStatus"]; planFailure?: LessonPoolAgentResult["planFailure"];
    objectives: readonly { status: "complete" | "incomplete" | "failed"; failure?: { errorCode: string; retryable: boolean; retryAfterMs?: number } }[];  // z postępu PO scaleniu z próbą
    accepted: number; budgetExhausted: boolean; attempts: number; maxAttempts: number;
  }): LessonAgentOutcome;   // wiersze 1–7 §9 w kolejności; budgetExhausted = result.spentUsd >= policy.runBudgetUsd
  export function mergeAttemptIntoProgress(progress: LessonAgentProgress, result: LessonPoolAgentResult, mode: "pool" | "add", addObjectiveId?: string): LessonAgentProgress;
  export function acceptedInLessonOrder(progress: LessonAgentProgress, objectiveOrder: readonly string[]): LessonExerciseDraft[];
  export function generationGapsOf(progress: LessonAgentProgress, objectiveIds: readonly string[], mode: "pool" | { add: { objectiveId: string; count: number } }): LessonGenerationGap[];  // zagadnienie bez wpisu → incomplete
  export function mergeGenerationGaps(previous: readonly LessonGenerationGap[] | undefined, next: readonly LessonGenerationGap[], mode: "pool" | "add", objectiveId?: string): LessonGenerationGap[];
  // domain/lessons/agent/status.ts
  export function finalLessonCheck(args: { subject: AgentCapableSubject; topic: LessonTopic; objectives: readonly AgentObjective[]; material: string; fixed: readonly LessonExerciseDraft[]; accepted: readonly { objectiveId: string; draft: LessonExerciseDraft }[]; examples: Readonly<Record<string, readonly string[]>>; limits: ReadonlyMap<string, ObjectiveAgentLimits> }): { kept: LessonExerciseDraft[]; removed: number };
  ```

- [ ] **Step 1: Testy:** jeden `it` na wiersz §9 (`"wiersz 1: budżet …"` … `"wiersz 7: …"`), `"wiersz 1 wygrywa z 4"`, `"wiersz 6 liczony po scaleniu postępu"`; `lessonGeneratorFor` (lista, brak polityki, brak deps); `lessonAgentRunInputFor`: każde pole w obu kolumnach, pięć reguł pierwszeństwa `objectiveSource`, wznowienie z `planExamples` → `examplesFixed: true`, `familyScope` różny po „Ponów” (`attempts` 1 przy innym `expectedEditNumber`), tryb add `count − nowe`; `mergeAttemptIntoProgress` (wznowione zastępuje wpis, `complete` zostaje, add dopisuje nowe, histogram i `removedAfterAcceptance` sumowane); `acceptedInLessonOrder`; `generationGapsOf` (incomplete, failed, add_short, zagadnienie bez wpisu); `mergeGenerationGaps` (pula zastępuje; add usuwa wpis przy komplecie); `finalLessonCheck`: ujawnienie między zagadnieniami z różnych prób usuwa ofiarę z `accepted`, duplikat między próbami usuwa późniejszy, `fixed` nigdy nie usuwany.
- [ ] **Step 2:** `pnpm test:unit packages/server/src/modules/materials/lessons/lesson-agent-outcome.test.ts packages/server/src/domain/lessons/agent/status.test.ts` — FAIL.
- [ ] **Step 3:** Implementuj (`finalLessonCheck` buduje stan z `createLessonAgentState` z `accepted` jako pulą i woła `lessonInvariantCheck` + `removeExercise`).
- [ ] **Step 4:** Testy — PASS.
- [ ] **Step 5:** Commit: `Lekcje: wejście, wynik próby i luki generowania agenta jako funkcje czyste (#237)`.

### Task 10: Ścieżka agenta — przebieg główny i wybór ścieżki

**Files:**
- Create: `packages/server/src/modules/materials/lessons/lesson-agent-generation.ts`
- Modify: `packages/server/src/modules/materials/lessons/lesson-drafts.ts`
- Test: `tests/integration/lesson-agent-generation.test.ts`

**Interfaces:**
- Consumes: Task 1, 2, 3, 5, 7, 8, 9.
- Produces: `export async function executeLessonAgentGeneration(services: Services, args: { run: typeof generationRuns.$inferSelect; attempts: number; subject: SubjectModule; input: LessonRunInput; runStartedAtMs: number; signal?: AbortSignal }): Promise<void>`.

Wybór ścieżki w `executeLessonGeneration`: po `claimQueuedRun` odczytaj przedmiot z rejestru (bez I/O) i `lessonGeneratorFor`; `"pipeline"` → dzisiejsza kolejność bez zmian (limit prób, unieważnienie, temat…); `"agent"` → sprawdzenie unieważnienia, potem `executeLessonAgentGeneration` (limit prób obsługuje ona).

Przebieg (spec §7–§10): `parseLessonAgentProgress` → przy `attempts > MAX_AUTOMATIC_ATTEMPTS`: postęp z ≥ 1 ćwiczeniem → zapis bez modelu, inaczej `markLessonRun failed attempts_exhausted` → `withLessonGenerationControl` → `lessonAgentRunInputFor` (szkoła bez tematu: `control.call(generateLessonObjectives)` → budowa tematu jak w potoku → zapis postępu) → pozostały czas `ms = control.deadlineAtMs − (deps.finalizationReserveMs ?? AGENT_FINALIZATION_RESERVE_MS) − now()`; `ms ≤ 0` → **bez** wywołania kierownika, wynik z samego postępu; inaczej `control.run(signal => runLessonPoolAgent({ agent, checker, subjects: services.subjects, policy: { ...deps.policy, runTimeoutMs: ms } }, runInput, signal))` z hakami zapisującymi postęp → `mergeAttemptIntoProgress` → `lessonAgentRunOutcome` → `requeue` (zapis postępu, `markLessonRun queued` z `lessonRetryDelayMs`) / `failed` (zapis postępu, `failLessonPoolValidation` albo `markLessonRun failed`) / `finalize`: `acceptedInLessonOrder` → `finalLessonCheck` → `finalizeLessonPoolWrite` bez `review`, z `extendContext` (`generationGaps` przez `mergeGenerationGaps`; przy pełnej generacji bez luk — pole usunięte) i `onSuccessTransaction` (`UPDATE generation_runs SET agent_checkpoint = <summary> WHERE id`), `context.rejectedCount = removedAfterAcceptance + removed z finalLessonCheck`. Wyjątki: `shutdown` → zapis postępu best-effort, `queued`; `superseded` i `LessonAgentCheckpointLostError` → `markLessonRun superseded`; inne → `classifyLessonGenerationFailure` jak potok, zapis wydatku best-effort. Log zakończenia §9.

- [ ] **Step 1: Testy integracyjne** (fake'i przez `services.generation.lessonAgent`; scenariusze per slug):
  - `"rozdział: planer → szkic, dynamicTopic, przykłady, editNumber+1, historyjka w kolejce, podsumowanie bez treści, krytyk nie wołany i jego raport bez zmian"`;
  - `"gramatyka (katalog) i szkoła (etap zagadnień z fake LLM)"`;
  - `"zero przyjętych → failed validation, liczniki w kontekście"`; `"wszystkie zagadnienia provider_configuration → failed provider_configuration bez ponowienia"`;
  - `"uszkodzony punkt kontrolny → start od zera"`; `"przełączenie przedmiotu na potok między próbami → potok ignoruje postęp, pełny zapis usuwa generationGaps"`;
  - `"przedmiot spoza listy → potok bez zmian (fake LLM wołany, agent nie)"`;
  - `"potok: attempts > MAX przy złożonym agencie i przedmiocie spoza listy → attempts_exhausted bez wywołań"`;
  - `"składanie z env: lessonAgentDepsFromEnv(UMIEM_FAKE_PROVIDERS=1 + lista) → pełna generacja ścieżką agenta"`;
  - `"rejectedCount = usunięcia po przyjęciu, nie odrzucenia w pętli"`.
- [ ] **Step 2:** `pnpm test:integration tests/integration/lesson-agent-generation.test.ts` — FAIL.
- [ ] **Step 3:** Implementuj.
- [ ] **Step 4:** Nowy plik i regresja potoku (`lesson-generation`, `lesson-review`, `lesson-story`, `lesson-chapter`, `generation`) oraz `pnpm test:unit packages/server/src/modules` — PASS.
- [ ] **Step 5:** Commit: `Lekcje: generowanie puli agentem w przebiegu lekcji (#237)`.

### Task 11: Ścieżka agenta — wznawianie, próby, terminy, budżet, straże, „Ponów”

**Files:**
- Modify: `packages/server/src/modules/materials/lessons/lesson-agent-generation.ts` (tylko poprawki wykryte testami)
- Test: `tests/integration/lesson-agent-generation.test.ts`

Sterowanie w testach: `lessonExecution` z `cancelPollMs: 20`; ponowne przejęcie po `requeue` — wyzeruj `next_attempt_at` SQL-em (albo przesuń `ManualClock`, jeśli plik tak robi) i wywołaj `executeLessonGeneration` ponownie; scenariusze ponowień przez `{ calls: [...] }`; moment „w trakcie” przez krok `{ gate, onReached }`.

- [ ] **Step 1: Testy:**
  - `"błąd przejściowy zagadnienia → queued; kolejna próba pomija gotowe, planera i etap zagadnień szkoły, przenosi wydatek, kończy zapisem"`;
  - `"wyczerpane próby → zapis części, generationGaps z zagadnieniem incomplete/failed"`;
  - `"shutdown w ostatniej próbie (gate + abort sygnału) → następne przejęcie zapisuje z punktu kontrolnego bez wywołań modelu; gap dla nierozliczonego zagadnienia"`;
  - `"budżet wyczerpany przy błędzie przejściowym innego zagadnienia → zapis części bez ponowienia"`;
  - `"termin runu → succeeded z częścią"` — `runTimeoutMs: 3000`, `finalizationReserveMs: 1000`, zagadnienie A `complete`, B `{ gate: never }`; asercja `succeeded`, gap dla B, nie `provider_timeout`;
  - `"edycja rodzica w trakcie (gate) → superseded, szkic bez zmian, agent_checkpoint NULL"`;
  - `"podbicie editNumber przez acceptVerdictAsVariant w trakcie → run superseded (nie running), agent_checkpoint NULL"`;
  - `"Ponów w trakcie próby (druga karta: retryGeneration przy gate) → spóźniony zapis starej próby odrzucony, nowa próba wznawia"`;
  - `"Ponów po częściowym runie → wznowienie bez zduplikowanych familyId"`;
  - `"koszty: zdarzenia UsageRecorder (fake z usage) w zakresie runu, totalSpentUsd w podsumowaniu"`.
- [ ] **Step 2:** Uruchom — popraw implementację, aż PASS; regresja jak w Task 10 Step 4.
- [ ] **Step 3:** Commit: `Lekcje: wznawianie, terminy i budżet agenta puli w generowaniu (#237)`.

### Task 12: Ścieżka agenta — dogenerowanie +N

**Files:**
- Modify: `packages/server/src/modules/materials/lessons/lesson-agent-generation.ts` (poprawki)
- Test: `tests/integration/lesson-agent-generation.test.ts`

- [ ] **Step 1: Testy:** `"dogeneruj +2 → najwyżej 2+stageGap+listenLeft nowych, szkic nietknięty, generationGaps bez wpisu zagadnienia"`; `"dogeneruj ze zdaniem historyjki → agent dostaje je jako źródło ujawnień; kolizja w zapisie odrzucona"`; `"dogeneruj z błędem przejściowym → requeue → łącznie ≤ limitu, bez duplikatów"`; `"dogeneruj bez nowych → failed, editNumber bez zmian"`; `"dogeneruj z niedoborem → add_short dodano k z N"`.
- [ ] **Step 2:** Uruchom — popraw, aż PASS; regresja jak w Task 10 Step 4.
- [ ] **Step 3:** Commit: `Lekcje: dogenerowanie zagadnienia agentem puli (#237)`.

### Task 13: Kontrakty i API panelu rodzica

**Files:**
- Modify: `packages/contracts/src/lessons.ts` (wpis przedmiotu w `SubjectCatalogDtoSchema`: `generationServices?: z.array(z.string().min(1)).min(1)`, `checkService?: z.string().min(1)`, `checkServiceIncludesMaterial?: z.boolean()`; `LessonDeckDtoSchema.generationGaps?`), `packages/server/src/config.ts` (`Services.lessonAgentPublic?`, `createServices`), `packages/server/src/modules/materials/lessons/lesson-api.ts` (`lessonCatalog`, mapowanie szkicu), `apps/web/src/composition.ts` (składa `lessonAgentPublicFromEnv(env, subjects)`)
- Test: `packages/contracts/src/lessons.test.ts`, `packages/server/src/modules/materials/lessons/lesson-api.test.ts`

**Interfaces:**
- Consumes: Task 7 (`lessonAgentPublicFromEnv`), Task 9 (`LessonGenerationGap`).
- Produces: `lessonCatalog` dla przedmiotu z listy: `generationServices` = `[generationService agenta]` + usługa `UMIEM_LLM` (`services.generationService`), gdy przedmiot ma temat dynamiczny bez `agentPolicy.planCoverage` i usługa jest inna; `checkService`; `checkServiceIncludesMaterial = agentPolicy.checkerNeedsMaterial`. DTO szkicu: `generationGaps` z `lessonContext`.

- [ ] **Step 1: Testy:** kontrakty (pola opcjonalne, puste odrzucone, stare ładunki przechodzą); `lesson-api.test.ts`: `"przedmiot z agentem: usługi per przedmiot"`, `"szkoła: dwie usługi i wariant z materiałem"`, `"przedmiot poza listą: bez pól"`, `"szkic: generationGaps w DTO"`.
- [ ] **Step 2:** `pnpm test:unit packages/contracts packages/server/src/modules/materials/lessons/lesson-api.test.ts` — FAIL.
- [ ] **Step 3:** Implementuj.
- [ ] **Step 4:** Testy i `pnpm typecheck` — PASS.
- [ ] **Step 5:** Commit: `Lekcje: usługi generowania per przedmiot i luki generowania w API rodzica (#237)`.

### Task 14: Panel rodzica — komunikaty i alert

**Files:**
- Modify: `packages/contracts/src/messages.ts`, `apps/web/src/parent/lessons/NewLessonForm.tsx`, `apps/web/src/parent/sources/SourcePage.tsx`, `apps/web/src/parent/lessons/LessonEditor.tsx`
- Test: `apps/web/src/parent/lessons/new-lesson-form.test.tsx`, `apps/web/src/parent/sources/sources-panel.test.tsx`, testy edytora (`lesson-editor-state` / plik testów `LessonEditor`), E2E `mocked`: `tests/e2e/parent-lessons-layout.spec.ts`, `tests/e2e/parent-lesson-editor-layout.spec.ts`

**Interfaces:**
- Consumes: Task 13.
- Produces (dokładne teksty w `messages.lessons`):
  - `checkServiceInfo`: „Gotowe ćwiczenia trafiają też do drugiego modelu, który rozwiązuje je na próbę ({service}). Nie wysyłamy do niego imienia, wieku ani odpowiedzi dziecka.”
  - `checkServiceInfoWithMaterial`: „Materiał lekcji i gotowe ćwiczenia trafiają też do drugiego modelu, który rozwiązuje ćwiczenia na próbę ({service}). Nie wysyłamy do niego imienia, wieku ani odpowiedzi dziecka.”
  - `generationGapsAlert`: „Generowanie zakończyło się częściowo: {n} zagadnienia do uzupełnienia. Użyj „Dogeneruj” przy zagadnieniu.”
  - `generationGapIncomplete`: „Niepełne po generowaniu”; `generationGapFailed`: „Nie udało się wygenerować”; `generationGapAddShort`: „Dodano {added} z {requested}”.
  Formularz i `SourcePage` przy przedmiocie z `checkService`: komunikat o generowaniu z `generationServices.join(", ")` (zamiast katalogowego `generationService`), wariant checkera wg `checkServiceIncludesMaterial`, bez `reviewServiceInfo`. Edytor: alert przy niepustym `generationGaps`, znacznik przy zagadnieniu obok plakietek pokrycia.

- [ ] **Step 1: Testy:** `new-lesson-form.test.tsx` (oba warianty checkera, usługi per przedmiot, brak komunikatu krytyka przy agencie, komunikat krytyka przy przedmiocie potoku); `sources-panel.test.tsx` (to samo dla przycisków lekcji); edytor (`"alert z liczbą zagadnień"`, znacznik dla każdego `reason`, `add_short` z liczbami).
- [ ] **Step 2:** `pnpm test:unit apps/web/src/parent` — FAIL.
- [ ] **Step 3:** Implementuj.
- [ ] **Step 4:** Testy — PASS; dopisz przypadki do obu speców `mocked` (fixture katalogu z `checkService`, szkic z `generationGaps`) i `UMIEM_E2E_WEB_MODE=dev pnpm exec playwright test tests/e2e/parent-lessons-layout.spec.ts tests/e2e/parent-lesson-editor-layout.spec.ts --project=mocked` — PASS.
- [ ] **Step 5:** Commit: `Panel rodzica: usługi generowania per przedmiot i informacja o niepełnej puli (#237)`.

### Task 15: Dokumentacja

**Files:**
- Modify: `docs/architecture.md` (§19.17, §23), `docs/provider-config.md`, `.env.example`, `AGENTS.md`, `docs/SPEC.md`, `docs/superpowers/specs/2026-11-04-lesson-pool-agent-stage2a-design.md` (nota: walidacja ćwiczeń punktu kontrolnego guardem kształtu zamiast pełnego Zod; pole DTO `checkServiceIncludesMaterial`; `familyScope` z `expectedEditNumber`; rezerwa nadpisywalna w testach)

- [ ] **Step 1:** `architecture.md` §19.17: ścieżka agenta, wybór per przedmiot, terminy (rezerwa 30 s), punkt kontrolny i podsumowanie, wynik próby (tabela), tryb „dodaj N”, `generationGaps`; §23: operacje kosztów agenta, `RunCostSink` vs `UsageRecorder`, koszt 0 dla błędów HTTP.
- [ ] **Step 2:** `provider-config.md` i `.env.example`: `UMIEM_LESSON_AGENT_*` (wartości z Global Constraints), klucz i kolejność, routing z dziedziczeniem kluczami, wymóg różnych rodzin; bez sekretów.
- [ ] **Step 3:** `AGENTS.md`: zdanie o `ai`/`@openrouter/*` → „wyłącznie w `tests/probes` oraz w `providers/openai/lesson-pool-agent.ts` z jego testem (składany przez `@learning/server/lesson-agent`, tylko worker)”; w sekcji prywatności punkt o agencie (checker: widok ćwiczenia, w szkole materiał; punkt kontrolny bez danych dziecka, po zapisie podsumowanie bez treści, zerowany przy anulowaniu; logi bez treści).
- [ ] **Step 4:** `SPEC.md`: krótko w sekcji generowania lekcji — niepełna pula i usługi; nota w specu etapu 2a.
- [ ] **Step 5:** Commit: `Dokumentacja: agent puli lekcji w generowaniu — konfiguracja, punkt kontrolny i prywatność (#237)`.

### Task 16: Weryfikacja całości i opis PR

- [ ] **Step 1:** `pnpm typecheck` — PASS.
- [ ] **Step 2:** `pnpm test:unit` — PASS.
- [ ] **Step 3:** `pnpm test:integration` — PASS.
- [ ] **Step 4:** `pnpm build` — PASS; kontrola bundla weba z kontrolą pozytywną: `rg -l "@mantine/core" apps/web/.next/server` znajduje pliki, a `rg -l "@openrouter/ai-sdk-provider|ToolLoopAgent" apps/web/.next/server` — brak.
- [ ] **Step 5:** `pnpm test:e2e:shards` — PASS (komplet; zrzuty pominięte).
- [ ] **Step 6:** Szkic opisu PR w pliku scratchpada: zakres, wpływ API → MCP → `SKILL.md` (zmiany tylko w DTO panelu rodzica; generowanie, katalog, szkic i koszty poza MCP i `learning-overview` — bez zmian MCP/skilla), wykonane sprawdzenia, czego nie sprawdzono (płatne przebiegi i odbiór na prawdziwym modelu — etap 3), wymagane wdrożenia (migracja 0037, nowe env, domyślnie wyłączone).
- [ ] **Step 7:** Końcowy przegląd gałęzi przez trzech niezależnych krytyków (praktyka właściciela), poprawki, ponowna weryfikacja dotkniętych testów.
