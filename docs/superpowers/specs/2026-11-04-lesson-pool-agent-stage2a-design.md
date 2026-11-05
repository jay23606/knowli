# Agent generujący pulę lekcji — etap 2a: adapter AI SDK i integracja z generowaniem — design

Data: 2026-11-04. Issue: [#237](https://github.com/lookassh/knowli/issues/237).
Poprzedni etap: [spec etapu 1](2026-11-04-lesson-pool-agent-stage1-design.md)
(rdzeń domenowy, porty, kierownik `runLessonPoolAgent`; scalony w #256).

Decyzje właściciela (czat 2026-11-04):

- etap 2 idzie w **dwóch PR-ach**: **2a** (ten dokument) — adapter AI SDK,
  przełączanie przedmiotów, punkt kontrolny, wznawianie, wynik runu, panel
  rodzica, dla wszystkich przedmiotów z `agentPolicy` (szkoła z kontrolami
  deterministycznymi z etapu 1); **2b** (osobny spec) — kontrole modelem w
  szkole (sędzia podpowiedzi, sprawdzenie otwartych odpowiedzi graderem);
- przyjęte ćwiczenia zagadnień trafiają do **punktu kontrolnego w runie**
  (`generation_runs`), a do szkicu — **jeden atomowy zapis na końcu**, jak dziś;
  rodzic nie widzi zagadnień w trakcie runu;
- niepełny run: przejściowy błąd dostawcy → **ponowienie** runu i wznowienie
  brakujących zagadnień; po wyczerpaniu prób, przy terminie i budżecie →
  **zapis tego, co przyjęte** (`succeeded`); zero przyjętych ćwiczeń → `failed`;
- **„Dogeneruj”** jedno zagadnienie (+N) też idzie przez agenta — nowy tryb
  kierownika;
- agent włączany **listą przedmiotów** `UMIEM_LESSON_AGENT_SUBJECTS`
  (domyślnie pusta = wszędzie dzisiejszy potok);
- modele domyślne: generator **Gemini 3.8 Flash**, checker **DeepSeek V4.1
  Flash** (przebieg kontrolny 2026-11-04: 103 s, 0,142 USD, 74 z 94 przyjętych).

Wersja 2 po review trzech krytyków (zgodność z kodem; architektura,
prywatność i koszty; cel, testy i zakres). Rozstrzygnięcia w §15.

## 1. Problem i zakres

Etap 1 zbudował rdzeń agenta i kierownika w pamięci, a próba `pnpm probe:agent`
woła je przez tymczasowe adaptery AI SDK w `tests/probes`. Etap 2a przenosi
adaptery do kodu produkcyjnego i podpina kierownika do `executeLessonGeneration`
za przełącznikiem per przedmiot, z trwałym punktem kontrolnym, wznawianiem,
zapisem kosztów i informacją dla rodzica.

**W zakresie (jeden PR, kolejność commitów w planie):**

1. Wydzielenie wspólnego zapisu do szkicu z potoku jako czysty refaktor (§10) —
   pierwszy commit, sprawdzony niezmienionymi testami potoku.
2. Adapter `providers/openai/lesson-pool-agent.ts` — oba porty z etapu 1,
   przeniesione z `tests/probes/ai-sdk-lesson-agent.ts`, z mapowaniem błędów i
   `UsageRecorder` (§4).
3. Konfiguracja `UMIEM_LESSON_AGENT_*` i składanie w workerze (§5).
4. Zmiany kierownika: hak planu, przykłady początkowe, start pod budżetem,
   tryb „dodaj N” (§6).
5. Ścieżka agenta w `executeLessonGeneration` (§7), punkt kontrolny i
   wznawianie (§8), wynik próby (§9).
6. Informacja dla rodzica: usługi per przedmiot i alert niepełnej puli (§11).
7. Migracja `generation_runs.agent_checkpoint` (§8.1).
8. Testy (§12) i dokumentacja (§13).

**Poza zakresem:** kontrole modelem w szkole (2b); pomiar odbiorczy i
przełączenie domyślne (etap 3); usunięcie krytyka (etap 4); generowanie
historyjki (bez zmian); automatyczne odzyskiwanie runu `running` po twardej
awarii procesu (dziś też go nie ma — rodzic używa „Ponów”, §8.4); zmiany
zachowania potoku.

**Moduł i zależności.** Obszar `materials`: ścieżka agenta w nowym
`modules/materials/lessons/lesson-agent-generation.ts`, zapis wspólny w
`lesson-drafts.ts`, punkt kontrolny w `lesson-agent-checkpoint.ts` (schemat,
odczyt, zapis), straż i „Ponów” w `generation-runs.ts`/`generation.ts`,
adapter w `providers/openai/`, składanie w `providers/lesson-agent-env.ts`
(eksport `@learning/server/lesson-agent`, wyłącznie worker), parsowanie env w
`config.ts` (bez importu SDK). Brak nowych
zależności między obszarami. Nowe zależności pakietu: `ai@7.0.162` i
`@openrouter/ai-sdk-provider@3.1.0` w `packages/server` (`dependencies`,
wersje dokładne, `pnpm --filter @learning/server add --save-exact`); devDependencies
roota zostają dla próby.

**Granice transakcji.** Bez zmian względem potoku: jedna transakcja końcowa
(blokada wersji, potem runu) zapisuje ćwiczenia, kontekst, `editNumber`,
anulowanie runów i kolejkę historyjki; w tej samej transakcji punkt kontrolny
zamienia się w podsumowanie (§8.1). Zapis punktu kontrolnego w trakcie runu to
osobny `UPDATE` jednego wiersza ze strażą tożsamości (§8.2), poza transakcją
biznesową — punkt kontrolny nie jest stanem szkicu, a utrata zapisu oznacza
tylko powtórzenie pracy.

## 2. Słownik

- **Ścieżka agenta / potok** — generowanie puli przez kierownika
  `runLessonPoolAgent` albo dzisiejsze partie `generateLessonPool`.
- **Punkt kontrolny** — JSONB w wierszu runu z planem i rozliczonymi
  zagadnieniami (§8.1).
- **Próba** — jedno przejęcie runu (`claimQueuedRun`, `attempts + 1`).
- **Tryb „pula” / „dodaj N”** — pełna generacja lekcji albo dogenerowanie
  jednego zagadnienia (§6.4).

## 3. Wybór ścieżki

```ts
lessonGeneratorFor(subject: SubjectModule, agent: LessonAgentDeps | undefined): "agent" | "pipeline"
```

`"agent"` wtedy i tylko wtedy, gdy `agent !== undefined`,
`subject.id ∈ agent.subjects` i `subject.agentPolicy !== undefined`. Lista
przedmiotów pochodzi wyłącznie z konfiguracji; silnik i kierownik nie znają
identyfikatorów przedmiotów.

`executeLessonGeneration` po wspólnym początku (odczyt runu, gałąź historyjki,
`claimQueuedRun`, sprawdzenie unieważnienia, rozwiązanie przedmiotu) wybiera
ścieżkę **przed** sprawdzeniem limitu prób: limit prób na ścieżce agenta
obsługuje §9 (wyczerpane próby z punktem kontrolnym → zapis bez wywołań
modelu). Na ścieżce potoku kolejność kroków zostaje jak dziś.

Wybór zapada przy każdej próbie: run ponowiony po zmianie konfiguracji
przechodzi ścieżką bieżącą. Potok ignoruje kolumnę punktu kontrolnego, a
ścieżka agenta bez punktu kontrolnego startuje od zera.

## 4. Adapter AI SDK (`providers/openai/lesson-pool-agent.ts`)

Jedyny plik produkcyjny importujący `ai` i `@openrouter/ai-sdk-provider`.
Zawiera `AiSdkLessonPoolAgent` i `AiSdkExerciseChecker` przeniesione z
`tests/probes/ai-sdk-lesson-agent.ts`, a jego testy przechodzą do
`providers/openai/lesson-pool-agent.test.ts` (import `ai/test` dozwolony w tym
jednym pliku testu, §12; `vitest.unit.config.ts` dostaje nową ścieżkę zamiast
starej). Próba importuje adapter produkcyjny; plik w `tests/probes` znika.

**Zachowanie** (jak w próbie, kontrakt portów etapu 1):

- `ToolLoopAgent` z narzędziami `submit_exercises`, `remove_exercise`
  (podagent) i `propose_objectives` (planer); checker na `generateText` z
  `Output.object`;
- `stopWhen: [isStepCount(maxSteps), () => tools.shouldStop()]`;
- **`maxRetries: 0`** — jedno wywołanie modelu to jedno żądanie HTTP;
  przejściowy błąd ponawia run (§9), nie SDK;
- surowe rekordy materializowane jak w `generateLessonPool`, bez walidacji
  treści; prompt produkcyjny (`lessonSystemPrompt`, `lessonUserMaterial`) plus
  dopisek przepływu narzędzi;
- `providerOptions.openrouter`: `reasoning.effort` z konfiguracji oraz
  `provider` (routing i prywatność dostawcy, §5) — ta sama struktura co
  `chatRequestExtrasFromEnv`;
- `createOpenRouter({ apiKey, baseURL: "https://openrouter.ai/api/v1" })` z
  jawnym kluczem — biblioteka nie czyta env (test §12);
- adaptery nic nie logują.

**Błędy.** Każdy wyjątek SDK z wywołania modelu adapter zamienia na
`GenerationProviderError` (bez `cause` — błędy SDK niosą
`requestBodyValues`/`responseBody` z materiałem):

| Błąd | `kind` |
|---|---|
| `APICallError` 401, 402, 403 | `configuration` |
| `APICallError` 429 | `rate_limit` (`retryAfterMs` z nagłówka `retry-after`) |
| `APICallError` 408, 5xx, błąd sieci, `isRetryable === true` | `transient` |
| pozostałe `APICallError` 4xx | `output` |
| `NoObjectGeneratedError`, `NoOutputGeneratedError`, `InvalidToolInputError`, błąd JSON | `output` |
| przerwanie sygnałem | rzucany dalej bez zmian (`signal.reason`) |

Błąd kodu (np. `TypeError` w narzędziu kierownika) nie jest błędem SDK —
przechodzi bez zmian. `SettledObjective.failure` dostaje `retryable` i
`retryAfterMs` z `classifyLessonGenerationFailure`.

**Koszty.** Z `onLanguageModelCallEnd` (po odpowiedzi, przed narzędziami
kroku), raz na żądanie:

1. `RunCostSink.record(openRouterCostOf(providerMetadata))`;
2. `UsageRecorder.record` przez istniejący pomocnik zapisu odpowiedzi
   (ten, który liczy inwentarz `usage-recording.architecture.test.ts`):
   `feature: "lesson_generation"`, `operation` ∈ `agent_plan`,
   `agent_objective`, `check_solve`, `check_variants`, `provider:
   providerFromBaseUrl(baseURL)` (= `"openrouter"`), `model`, `outcome: "ok"`,
   tokeny, `providerCostUsd`.

Żądanie rozpoczęte (`onLanguageModelCallStart`) i bez odpowiedzi:

- odpowiedź HTTP z błędem (`APICallError` ze `statusCode`) →
  `RunCostSink.record(0)` (OpenRouter nie rozlicza odrzuconych żądań) i zapis
  `outcome: "failed"` z `httpStatus`;
- brak odpowiedzi (sieć, przerwanie) → `RunCostSink.record(null)` (szacunek
  w budżecie) i zapis porażki transportu bez statusu.

Adapter przyjmuje `usage?: UsageRecorder`; zakres runu (`withUsageScope`)
ustawia już `generation-worker.ts` wokół `executeLessonGeneration`.

**Inwentarz płatnych adapterów.** `usage-recording.architecture.test.ts`
rozszerzam o wykrywanie importu `ai`/`@openrouter/*` obok `fetch(`; adapter
trafia do `PAID_ADAPTERS`.

## 5. Konfiguracja i składanie

**`config-defaults.ts`** (bez sekretów):

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `UMIEM_LESSON_AGENT_SUBJECTS` | `""` | Przedmioty generowane agentem (identyfikatory po przecinku) |
| `UMIEM_LESSON_AGENT_MODEL` | `google/gemini-3.8-flash` | Generator (planer i podagenci) |
| `UMIEM_LESSON_AGENT_REASONING` | `low` | Wysiłek rozumowania generatora |
| `UMIEM_LESSON_AGENT_CHECKER_MODEL` | `deepseek/deepseek-v4.1-flash-1017` | Ślepe rozwiązanie i sędzia wariantów |
| `UMIEM_LESSON_AGENT_CHECKER_REASONING` | `low` | Wysiłek rozumowania checkera |
| `UMIEM_LESSON_AGENT_MAX_STEPS` | `8` | Kroki na zagadnienie i planera |
| `UMIEM_LESSON_AGENT_CONCURRENCY` | `4` | Podagenci naraz |
| `UMIEM_LESSON_AGENT_CHECKER_CONCURRENCY` | `4` | Paczki checkera naraz |
| `UMIEM_LESSON_AGENT_OBJECTIVE_TIMEOUT_MS` | `300000` | Termin zagadnienia |
| `UMIEM_LESSON_AGENT_CHECKER_TIMEOUT_MS` | `90000` | Termin wywołania checkera |
| `UMIEM_LESSON_AGENT_RUN_BUDGET_USD` | `1.00` | Budżet runu (§8.5) |

Termin runu agenta wynika z `UMIEM_LESSON_GENERATION_RUN_TIMEOUT_MS` (§7.2).

**Routing i prywatność dostawcy.** `UMIEM_LESSON_AGENT_PROVIDER_*` i
`UMIEM_LESSON_AGENT_CHECKER_PROVIDER_*` (te same przyrostki co `UMIEM_LLM_*`
w `chatRequestExtrasFromEnv`: `DATA_COLLECTION`, `ORDER`, …); nieustawione
**dziedziczą** wartości `UMIEM_LLM_PROVIDER_*`, żeby operator z
`UMIEM_LLM_PROVIDER_DATA_COLLECTION=deny` nie stracił tej ochrony po
przełączeniu przedmiotu. Przy ustawionym wysiłku rozumowania
`require_parameters: true`.

**Klucz i host.** Adapter mówi wyłącznie z OpenRouter, więc zmiennej adresu
nie ma. Klucz w kolejności `endpointKeyFromEnv` rozszerzonego o prefiks:
`UMIEM_LESSON_AGENT_API_KEY` → `OPENROUTER_API_KEY` → `UMIEM_LLM_API_KEY`, gdy
`UMIEM_LLM_BASE_URL` jest adresem https OpenRouter. Klucz tylko w adapterze,
nigdy w logach.

**Parsowanie (`config.ts`, bez importu SDK):**
`lessonAgentSettingsFromEnv(env, subjects: SubjectRegistry)` →
`LessonAgentSettings | undefined` (lista, modele, wysiłki, routing, polityka,
klucz, nazwy usług):

- pusta lista → `undefined`;
- niepusta lista bez klucza → `undefined` i jedno ostrzeżenie startowe
  (`[config] UMIEM_LESSON_AGENT_SUBJECTS bez klucza OpenRouter — lekcje
  generuje potok`);
- **błąd startu workera** (wyjątek z nazwą zmiennej): nieznany identyfikator
  albo przedmiot bez `agentPolicy`, niepoprawna liczba, nieznany wysiłek,
  generator i checker z tej samej rodziny (ten sam prefiks przed `/`).

**Składanie (tylko worker):** `lessonAgentDepsFromEnv(env, subjects, usage, llm)`
w nowym `providers/lesson-agent-env.ts`, wystawionym jako osobny eksport pakietu
`@learning/server/lesson-agent` (web importuje `@learning/server` i
`generation-env.ts`, więc adapter nie może być osiągalny z nich).
`apps/worker/src/composition.ts` dokłada wynik do zależności generowania
(`{ ...createGenerationDepsFromEnv(env, usage), lessonAgent }`, nota §16 pkt 2)
jako `GenerationDeps.lessonAgent?: LessonAgentDeps`:

```ts
interface LessonAgentDeps {
  readonly subjects: ReadonlySet<string>;
  readonly agent: LessonPoolAgentProvider;
  readonly checker: LessonExerciseCheckerProvider;
  readonly policy: Partial<LessonAgentPolicy>;
}
```

`UMIEM_FAKE_PROVIDERS=1` → `FakeLessonPoolAgent` w trybie domyślnym „jak
LLM”: podagent zgłasza w jednym kroku wynik `FakeLlmProvider.generateLessonPool`
dla swojego zagadnienia (planer — deterministyczny plan z `input.coverage`, nota §16 pkt 3), a
`FakeExerciseChecker` zwraca `null` (kontrola niedostępna, ćwiczenie
przechodzi). Dzięki temu ścieżka agenta działa bez sieci w testach
integracyjnych i E2E.

**Web (nazwy usług, §11):** `lessonAgentPublicFromEnv(env)` →
`{ subjects, generationService, checkService } | undefined` — **nigdy nie
rzuca** (jak `reviewerPublicServiceFromEnv`); nieznane identyfikatory pomija,
a obecność zależy od listy, nie od klucza (web może nie mieć klucza workera).

**Zdrowie workera.** Ścieżka agenta nie wydłuża terminu runu, więc
`reviewerHealthBudgetWarning` zostaje bez zmian.

## 6. Zmiany kierownika (`lesson-pool-agent.ts`)

### 6.1. Hak planu

`LessonPoolAgentRunInput.onObjectivesResolved?: (resolved: { dynamicTopic?;
planExamples; spentUsd }) => Promise<void>` — wołany raz, po planie (źródło
`planner`) albo od razu po rozwiązaniu tematu (`catalog`/`input`), przed
podagentami; błąd przerywa run jak błąd `onObjectiveSettled`. Wynik
`plan_failed` zwraca `spentUsd` jak dziś (ścieżka zapisuje go w §8.2).

### 6.2. Przykłady początkowe

- `initialExamples?: Readonly<Record<string, readonly string[]>>` — przykłady
  kart wstawiane do stanu jak przykłady planu (liczą się do statusu i są
  źródłami ujawnień);
- `examplesFixed?: boolean` — `true` = `submit` ignoruje przykłady z notą
  „examples are fixed by the plan” (dziś wyliczane z `source === "planner"`;
  pole jawne, bo wznowienie rozdziału ma źródło `input`).

### 6.3. Start pod budżetem i wydatek w haku

- `runOne` nie startuje podagenta, gdy `cost.exhausted()` — zagadnienie jest
  rozliczane jak po terminie (`incomplete`, bez wywołań);
- `SettledObjective.spentUsd` = `cost.spentUsd` w chwili rozliczenia (licznik
  zawiera już `initialSpentUsd`);
- `SettledObjective.failure` = `{ errorCode, retryable, retryAfterMs? }`;
- `LessonPoolAgentResult` bez zmian poza tym; `rejections` jak dziś.

### 6.4. Tryb „dodaj N”

```ts
readonly target?:
  | { readonly mode: "pool" }                                   // domyślnie
  | { readonly mode: "add"; readonly objectiveId: string; readonly count: number };
```

W trybie `add`:

- źródło zagadnień `catalog` albo `input`; `planner` albo nieznane zagadnienie
  → `AppError("validation")` bez wywołań;
- uruchamiane jest wyłącznie zagadnienie `objectiveId`;
- `fixed` = ćwiczenia szkicu (całej lekcji) plus nowe ćwiczenia tego runu z
  punktu kontrolnego (§8.3); `initialExamples` = przykłady szkicu,
  `examplesFixed = true`; `extraExposureSources` (nowe pole, lista zdań) =
  zdania historyjki szkicu, jeśli jest — agent nie traci budżetu na
  ćwiczenia, które zapis odrzuciłby kolizją z historyjką;
- **liczby** (`remaining = count − nowe ćwiczenia z punktu kontrolnego`;
  ćwiczenia liczone jak `counts.total` — typy na ścieżce etapów, bez słów
  kluczowych):
  - `stageGap` = suma braków etapów zagadnienia (`objectiveStatus` na starcie,
    pozycje `guided/productive/independent`);
  - limit nowych ćwiczeń (pula, bo `limit_full` liczy tylko pulę) =
    `remaining + stageGap + listenLeft`, gdzie `listenLeft` = dodatek słuchowy
    `listenChoiceAllowance(subject, objective, [])` pomniejszony o ćwiczenia
    słuchowe zagadnienia w `fixed` (przyjmowanie samo liczy `fixed`); `slack`
    = 0;
  - liczby dla promptu (`targets`) z `remaining` i braków etapów, nie z
    `fixed`;
  - `targetCount` dla `objectiveStatus` = ćwiczenia zagadnienia w `fixed` +
    `remaining`;
- **komplet** (`addModeStatus(status, added, remaining)` w
  `domain/lessons/agent/status.ts`, używany przez `settle()` i `shouldStop`)
  = przyjęto co najmniej `remaining` nowych ćwiczeń **i** zagadnienie nie ma
  braków etapów; `missing` dla modelu zaczyna się od `new exercises: k of N`;
  pozostałe braki (`objectiveGaps`, wymagane typy) to wskazówki;
- `familyScope` = `${attemptNonce}:${runId}:${expectedEditNumber}:${attempts}`, nota §16 pkt 1 (rodziny pytań otwartych nie zderzają
  się z rodzinami z wcześniejszych prób ani szkicu);
- wynik i kontrola końcowa jak w trybie `pool`.

## 7. Ścieżka agenta w `executeLessonGeneration`

### 7.1. Wejście kierownika

| Pole | Pełna generacja | Dogenerowanie (`input.regenerate`) |
|---|---|---|
| `target` | `{ mode: "pool" }` | `{ mode: "add", objectiveId, count }` |
| `objectiveSource` | w kolejności: temat w punkcie kontrolnym → `input`; `input.dynamicTopic` runu → `input`; `subject.buildDynamicTopic === undefined` → `catalog` (`resolveLessonTopic`); `agentPolicy.planCoverage` zdefiniowane (dziś rozdział) → `planner`; pozostałe dynamiczne (dziś szkoła) → `input` z wyniku `generateLessonObjectives` (wołanie i budowa tematu jak w potoku: `buildDynamicTopicData`, `validateDynamicTopicData`, `withSubjectObjectiveKinds`; `control.call`) | `catalog` albo `input` z `input.dynamicTopic` runu / `lessonContext.dynamicTopic` szkicu |
| `fixed` | ćwiczenia zagadnień `complete` z punktu kontrolnego | szkic (`orderedDraftExercises` — nowy eksport, kolejność lekcji) + nowe z punktu kontrolnego |
| `skipObjectives` | zagadnienia `complete` z punktu kontrolnego | — |
| `initialExamples` | przykłady z punktu kontrolnego | przykłady szkicu |
| `examplesFixed` | `true`, gdy przykłady pochodzą z planu (punkt kontrolny ma `planExamples`) albo źródłem jest `planner` | `true` |
| `draftExamples` | `{}` | `{}` |
| `familyScope` | `${attemptNonce}:${runId}:${expectedEditNumber}:${attempts}` (nota §16 pkt 1) | tak samo |
| `initialSpentUsd` | `checkpoint.budgetSpentUsd` | `checkpoint.budgetSpentUsd` |
| pozostałe (`poolSize`, `material`, `instruction`, `interests`, `graderAvailable`, `topicTitle`) | z `input` runu | z `input` runu |

Wznawiane zagadnienia `incomplete`/`failed` **startują od zera**: ich
ćwiczenia z poprzedniej próby nie trafiają do `fixed`, a wynik nowej próby
zastępuje ich wpis w punkcie kontrolnym. To świadomy koszt (powtórzona praca)
w zamian za brak rozjazdów limitów, promptu i rodzin (§15).

Przedmiot z planerem rozpoznaję po `agentPolicy.planCoverage` — tej samej
cesze, której kierownik używa dla bramki pokrycia planu.

### 7.2. Sterowanie i terminy

`LessonGenerationControl` dostaje metodę
`run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T>`: sygnał korzenia
kontrolera **bez** terminu pojedynczego żądania (`requestTimeoutMs`); wyjątek
przerwania mapuje na `LessonGenerationCancelledError` z powodem kontrolera
(`shutdown`, `superseded`, `timeout`, anulowanie). Kierownik działa w
`control.run`, a `generateLessonObjectives` jak dziś w `control.call`.

Terminy (wszystkie względem `runStartedAtMs`):

- termin kontrolera = `runStartedAtMs + runTimeoutMs` (jak dziś);
- termin kierownika = czas do terminu kontrolera **minus rezerwa finalizacji**
  `AGENT_FINALIZATION_RESERVE_MS = 30 000`, liczony w chwili startu
  kierownika (`policy.runTimeoutMs` = ta różnica); termin kierownika zawsze
  przychodzi pierwszy, więc kierownik oddaje wynik częściowy zamiast wyjątku;
- zapis do szkicu sprawdza termin kontrolera
  (`assertLessonGenerationFinalizationAllowed`), więc rezerwa jest na zapis.

Wyjątki z `control.run`:

- `LessonGenerationCancelledError("shutdown")` → zapis punktu kontrolnego
  (wydatek, best-effort) i `queued` jak dziś;
- `superseded` → ścieżka sama oznacza run `superseded` (CAS jak
  `markCurrentRun`; nie zostawia go w `running` — dotyczy też podbicia
  `editNumber` bez `supersedeLessonRuns` w `lesson-supervision.ts`);
- `timeout` kontrolera (nie powinien nastąpić przed kierownikiem; gdy
  nastąpi) → jak wyczerpany termin: `failed`/`provider_timeout`, punkt
  kontrolny zostaje do „Ponów”;
- inny wyjątek kierownika (błąd kodu, utrata punktu kontrolnego) →
  `classifyLessonGenerationFailure` i rozliczenie jak błąd partii potoku, z
  zapisem wydatku best-effort.

## 8. Punkt kontrolny i wznawianie

### 8.1. Kolumna i kształt

Migracja `0037_generation_run_agent_checkpoint.sql` (schemat
`learning_app`, z migawką i wpisem w `meta/_journal.json`): `ALTER TABLE
"learning_app"."generation_runs" ADD COLUMN "agent_checkpoint" jsonb`
(nullable). Drizzle: `agentCheckpoint: jsonb("agent_checkpoint")`.

Kształt (wersjonowany; obwiednia walidowana Zod przy odczycie, ćwiczenia strażnikiem kształtu — nota §16 pkt 4; niepoprawny = brak
punktu kontrolnego i log `[lesson-agent] run=… checkpoint=invalid`):

```ts
type LessonAgentCheckpoint =
  | {
      readonly version: 1;
      readonly kind: "progress";
      readonly dynamicTopic?: DynamicTopicData;
      readonly droppedObjectiveCount?: number;
      readonly planExamples?: Record<string, string[]>;
      /** Tryb „dodaj N”: zagadnienie i nowe ćwiczenia (bez szkicu). */
      readonly objectives: Record<string, {
        readonly status: "complete" | "incomplete" | "failed";
        readonly failureCode?: string;
        /** Ćwiczenia zagadnienia z tej próby (tryb `pool`) albo nowe ćwiczenia (tryb `add`). */
        readonly exercises: LessonExerciseDraft[];
        readonly examples: string[];
      }>;
      readonly budgetSpentUsd: number;   // do budżetu; zerowany przez „Ponów”
      readonly totalSpentUsd: number;    // łącznie (log, podsumowanie)
      readonly rejectionCodes: Record<string, number>;   // histogram kodów odrzuceń, bez treści
    }
  | {
      readonly version: 1;
      readonly kind: "summary";          // po zapisie do szkicu, bez treści
      readonly objectives: Record<string, { readonly status: string; readonly accepted: number; readonly failureCode?: string }>;
      readonly totalSpentUsd: number;
      readonly rejectionCodes: Record<string, number>;
      readonly attempts: number;
    };
```

Postęp zawiera wspólny materiał lekcji (szkice, przykłady, temat) — bez danych
dziecka i bez `detail` odrzuceń; nie trafia do DTO, MCP ani logów. Przy zapisie
do szkicu (transakcja końcowa, §10) postęp zamienia się w **podsumowanie** bez
treści — trwały zapis kodów odrzuceń dla etapu 3 (obietnica specu etapu 1
§7.1). `supersedeLessonRuns` zeruje kolumnę runów puli lekcji, które anuluje
(run anulowany nie wraca: „Ponów” zwraca `conflict`). Postęp runu `failed`
zostaje do „Ponów”.

### 8.2. Zapis w trakcie

Ścieżka trzyma postęp w pamięci i zapisuje **całą wartość**
`saveLessonAgentCheckpoint(db, { runId, attempts, expectedEditNumber,
deckVersionId }, checkpoint)`:

```sql
UPDATE generation_runs SET agent_checkpoint = $1
WHERE id = $2 AND state = 'running' AND attempts = $3 AND expected_edit_number = $4
  AND EXISTS (SELECT 1 FROM deck_versions v
              WHERE v.id = $5 AND v.edit_number = $4 AND v.state <> 'published')
```

Zero zmienionych wierszy → `LessonAgentCheckpointLostError`, rozliczany jak
`superseded` (§7.2). Straż sprawdza też numer edycji wersji, bo nie każda
zmiana szkicu anuluje runy (`lesson-supervision.ts`).

Momenty zapisu:

1. `onObjectivesResolved` (temat, przykłady planu, wydatek; także wynik
   etapu zagadnień szkoły — wznowienie nie woła `generateLessonObjectives`);
2. `onObjectiveSettled` (wpis zagadnienia, wydatek, histogram);
3. przed `requeue` (§9) — po kontroli końcowej, z ćwiczeniami z wyniku;
4. best-effort przy każdym innym wyjściu, dopóki run jest `running`
   (wyjątek, `shutdown`, `plan_failed`): przynajmniej wydatek, żeby budżet
   nie zerował się przy awariach.

### 8.3. Wznowienie

Próba z postępem w punkcie kontrolnym:

- temat i przykłady z punktu kontrolnego (planer i etap zagadnień pomijane);
- tryb `pool`: `skipObjectives` i `fixed` = zagadnienia `complete`;
  pozostałe od zera (§7.1);
- tryb `add`: `fixed` = szkic + nowe ćwiczenia z punktu kontrolnego,
  `remaining = count − nowe`;
- `initialSpentUsd` = `budgetSpentUsd`.

### 8.4. „Ponów” rodzica

`retryGeneration` dla runu puli lekcji (wszystkie gałęzie, które wstawiają run
do kolejki: porażka, `running` po awarii, odroczone `queued`) w tej samej
transakcji i pod istniejącym `FOR UPDATE` runu zeruje (czysty SQL `jsonb_set`, bez Zod — nota §16 pkt 4)
`budgetSpentUsd` i zapisuje go z powrotem (świeży budżet na świadomą decyzję
rodzica; `totalSpentUsd` zostaje). Ćwiczenia zostają — szkic między porażką a
„Ponów” się nie zmienił (edycja anuluje run, a „Ponów” anulowanego kończy się
`conflict`). Spóźniony worker starej próby nie zapisze punktu kontrolnego (inne
`attempts` albo `expectedEditNumber`).

### 8.5. Budżet

`UMIEM_LESSON_AGENT_RUN_BUDGET_USD` obejmuje wszystkie automatyczne próby runu
(przez `budgetSpentUsd`). Etap zagadnień szkoły (`generateLessonObjectives`,
`LlmProvider`) jest poza licznikiem agenta — koszt zapisuje jego adapter w
`UsageRecorder` jak dziś.

## 9. Wynik próby

Po powrocie kierownika (bez wyjątku) ścieżka liczy wynik funkcją czystą
`lessonAgentRunOutcome({ result, checkpoint, attempts, maxAttempts, mode })`.
Wiersze w kolejności — pierwszy pasujący wygrywa:

| # | Warunek | Wynik |
|---|---|---|
| 1 | budżet wyczerpany | `finalize`, jeśli przyjęto ≥ 1 ćwiczenie, inaczej `failed`/`validation` |
| 2 | `plan_failed` z kodem przejściowym, `attempts < maxAttempts` | `requeue` (`lessonRetryDelayMs`, `retryAfterMs`) |
| 3 | `plan_failed` | `failed` z kodem planu |
| 4 | któreś zagadnienie `failed` z `retryable`, `attempts < maxAttempts` | `requeue` |
| 5 | przyjęto ≥ 1 ćwiczenie | `finalize` → `succeeded` |
| 6 | 0 ćwiczeń, wszystkie zagadnienia `failed` z jednym kodem dostawcy | `failed` z tym kodem (`attempts_exhausted`, gdy przejściowy i próby wyczerpane) |
| 7 | 0 ćwiczeń | `failed`/`validation` (liczniki do kontekstu jak `failValidation` potoku) |

„Przyjęto” = ćwiczenia w punkcie kontrolnym uzupełnionym wynikiem próby; w
trybie `add` wyłącznie **nowe** ćwiczenia (szkic się nie liczy).

**Wyczerpane próby przed startem** (`attempts > MAX_AUTOMATIC_ATTEMPTS`, np.
`shutdown` w ostatniej próbie): z postępem z ≥ 1 ćwiczeniem → `finalize` z
punktu kontrolnego bez wywołań modelu; inaczej `failed`/`attempts_exhausted`
jak dziś.

Log zakończenia: `[lesson-agent] run=… outcome=<requeue|finalize|failed>
complete=… incomplete=… failed=… accepted=… spentUsd=… attempt=…`.

## 10. Wspólny zapis do szkicu

Z transakcji końcowej `executeLessonGeneration` wydzielam (pierwszy commit,
czysty refaktor):

```ts
finalizeLessonPoolWrite(services, args: {
  runId; attempts; expectedEditNumber; deckVersionId; subject; topicVersion;
  regenerate: boolean;
  existingDrafts: readonly LessonExerciseDraft[];
  accepted: readonly LessonExerciseDraft[];
  context: { dynamicTopic?; newExamples; rejectedCount; rejectedReasons; droppedObjectiveCount; generationGaps? };
  review?: (tx, versionId, previous, saved) => Promise<LessonReviewReport>;   // tylko potok
  checkpointSummary?: LessonAgentCheckpoint & { kind: "summary" };            // tylko agent
  finalizationDeadlineAtMs: number;
  signal?: AbortSignal;
}): Promise<"succeeded" | "failed_validation" | "superseded" | "gone">
```

Wszystkie kroki z dzisiejszej transakcji (blokady wersja → run, straże,
kolizje z historyjką, słowa kluczowe bez rodziny, `applyLessonExercises`,
`lessonContext` z sumowaniem liczników z poprzednim kontekstem,
`reconcileDraftAssetsTx`, podbicie `editNumber`, `supersedeLessonRuns`,
kolejka historyjki, stan `review`, `succeeded`) oraz ścieżka `failValidation`.
Potok woła ją bez zmiany zachowania (istniejące testy przechodzą bez zmian).

Ścieżka agenta przed zapisem:

1. składa `accepted` = ćwiczenia wszystkich zagadnień z punktu kontrolnego
   uzupełnionego wynikiem próby, w kolejności lekcji (tryb `add`: tylko nowe);
2. **kontrola końcowa na całości**: `lessonInvariantCheck` na stanie, w którym
   wszystkie ćwiczenia `accepted` są pulą, a `fixed` to szkic (tryb `add`) —
   łapie migawki sprzed bezpiecznika zapisane przed `shutdown` lub awarią;
   usunięcia liczą się do `rejectedCount`;
3. `context.rejectedCount` = usunięcia po przyjęciu (kontrola końcowa,
   bezpiecznik kierownika; kolizje z historyjką i słowa kluczowe dolicza
   wspólny zapis jak dziś) — **nie** odrzucenia w pętli agenta, które model
   poprawia na bieżąco; sumowany z poprzednim kontekstem jak w potoku;
   `rejectedReasons` bez zmian;
4. `context.generationGaps` (§11) z zagadnień `incomplete`/`failed`;
5. bez `review` — raport krytyka w kontekście zostaje bez zmian.

Ścieżka agenta **nie** woła `acceptFreshLessonPool`,
`resolveGenerationLeaks`, krytyka ani rundy pod etap — reguły ujawnień,
deduplikacja i walidacja puli działają przy przyjmowaniu i w kontroli
końcowej.

## 11. Prywatność i panel rodzica

**Do modeli** (bez zmian względem potoku i etapu 1 §11): generator — materiał,
polecenie, tematy zdań (gramatyka, ogrodzony blok danych), zdania do unikania,
karty i przykłady; checker — widok ćwiczenia, liczba odpowiedzi, odpowiedź i
warianty (sędzia), a w szkole także materiał. Szkoła: etap zagadnień idzie do
usługi `UMIEM_LLM` (jak dziś), ćwiczenia do agenta. Nigdy imię, rok urodzenia,
identyfikatory ani odpowiedzi dziecka. Routing dostawcy (`deny` zbierania
danych) dziedziczony z `UMIEM_LLM_*` (§5).

**Logi:** `[lesson-agent]` i `[lesson]` — liczniki, kody, statusy, slugi
zagadnień, koszty; bez treści ćwiczeń, materiału, kart, tematów i `detail`.

**Panel rodzica — usługi per przedmiot.** Wpis przedmiotu w
`SubjectCatalogDto` dostaje opcjonalne pola (niepuste, wstecznie zgodne):
`generationServices?: string[]` (różne usługi, do których trafia materiał —
dla agenta model agenta, a w szkole także usługa etapu zagadnień) i
`checkService?: string`. Pole katalogowe `generationService` zostaje dla
przedmiotów bez nadpisania. `NewLessonForm` i `SourcePage` przy przedmiocie z
`checkService`:

- komunikat o generowaniu wymienia `generationServices`;
- nowy `messages.lessons.checkServiceInfo`: „Gotowe ćwiczenia trafiają też do
  drugiego modelu, który rozwiązuje je na próbę ({service}). Nie wysyłamy do
  niego imienia, wieku ani odpowiedzi dziecka.”;
  `messages.lessons.checkServiceInfoWithMaterial` (szkoła — polityka checkera
  wymaga materiału): „Materiał lekcji i gotowe ćwiczenia trafiają też do
  drugiego modelu, który rozwiązuje ćwiczenia na próbę ({service}). …”; wybór
  wariantu po `agentPolicy` (czy checker dostaje materiał), nie po
  identyfikatorze;
- komunikat krytyka (`reviewServiceInfo`) nie jest pokazywany — ścieżka agenta
  krytyka nie woła.

**Panel rodzica — niepełna pula.** `LessonContext` i `LessonDeckDto` (szkic
rodzica) dostają opcjonalne `generationGaps?: { objectiveId: string; reason:
"incomplete" | "failed" | "add_short"; added?: number; requested?: number }[]`
— bez treści. Pełna generacja zastępuje listę; dogenerowanie usuwa wpis
zagadnienia, gdy tryb `add` jest kompletny, albo wpisuje `add_short`
(„dodano k z N”). Edytor pokazuje jeden alert: „Generowanie zakończyło się
częściowo: {n} zagadnienia do uzupełnienia. Użyj „Dogeneruj” przy
zagadnieniu.” i znacznik przy zagadnieniu (obok plakietek pokrycia etapów).

**API → MCP → `SKILL.md`:** zmiany dotyczą wyłącznie DTO panelu rodzica
(katalog przedmiotów, szkic lekcji; pola opcjonalne). Generowanie, katalog,
szkic i koszty nie są wystawione w MCP ani w `learning-overview`, więc MCP i
`SKILL.md` bez zmian — uzasadnienie w opisie PR.

## 12. Testy

**Jednostkowe:**

- adapter (`MockLanguageModelV4`, `simulateReadableStream`): limit kroków,
  `shouldStop`, `maxRetries: 0`, koszt i zapis raz na żądanie (`ok`, błąd
  HTTP z `httpStatus` i kosztem 0, brak odpowiedzi z `null`), przerwanie
  sygnałem, mapowanie błędów (każdy wiersz tabeli §4, brak `cause`),
  `providerOptions` (wysiłek, routing, `require_parameters`), jawny klucz i
  `baseURL` (env bez klucza OpenRouter → adapter działa z przekazanym), `null`
  checkera — testy próby przeniesione i rozszerzone;
- `lessonAgentSettingsFromEnv` / `lessonAgentPublicFromEnv`: pusta lista,
  brak klucza (ostrzeżenie), kolejność kluczy, nieznany przedmiot i bez
  polityki (worker rzuca, web pomija), ta sama rodzina, niepoprawne liczby,
  dziedziczenie routingu, `UMIEM_FAKE_PROVIDERS`;
- architektura importów: `config.ts` nie importuje adaptera ani SDK;
- `lessonGeneratorFor`, `lessonAgentRunOutcome` (każdy wiersz §9 i kolejność
  1 przed 4), `addModeStatus`, schemat punktu kontrolnego (poprawny,
  uszkodzony, podsumowanie);
- `control.run`: brak limitu żądania, mapowanie powodów przerwania;
- kierownik (fake'i etapu 1): `onObjectivesResolved` (planer, katalog,
  wejście; błąd haka przerywa run), `initialExamples` + `examplesFixed`, start
  pod wyczerpanym budżetem bez wywołań, `spentUsd` bez podwójnego liczenia;
  tryb `add`: tylko wybrane zagadnienie, komplet po `remaining` nowych i bez
  braków etapów, limit nowych (szkic z 12 ćwiczeniami, +2 → najwyżej
  `2 + stageGap + listenLeft` nowych), `remaining` po wznowieniu, zagadnienie
  już pełne, `planner` odrzucony, zdania historyjki jako źródła ujawnień.

**Architektury:**

- `tests/ai-sdk-scope.test.ts`: SDK dozwolony w `tests/probes/`, w
  `packages/server/src/providers/openai/lesson-pool-agent.ts` i jego teście;
  manifest `packages/server` może deklarować obie zależności (dokładne wersje),
  inne manifesty nie; dowód czułości dla innego pliku w `providers/`;
- `usage-recording.architecture.test.ts`: wykrywanie importu SDK, adapter w
  `PAID_ADAPTERS`;
- `module-boundaries.architecture.test.ts` bez zmian (domena bez SDK).

**Integracyjne (Postgres, fake'i przez `GenerationDeps.lessonAgent`),** nowy
plik `lesson-agent-generation.integration.test.ts` w najlżejszym koszu
`INTEGRATION_BUCKETS`:

1. rozdział (planer) → szkic z ćwiczeniami, `dynamicTopic`, przykładami,
   `editNumber + 1`, run historyjki w kolejce, `succeeded`, punkt kontrolny =
   podsumowanie bez treści;
2. gramatyka (katalog) i szkoła (`generateLessonObjectives` z fake'a LLM);
3. przejściowy błąd dostawcy zagadnienia → `queued` z `nextAttemptAt`,
   postęp z gotowymi zagadnieniami; kolejna próba nie woła gotowych zagadnień,
   planera ani `generateLessonObjectives` (szkoła), przenosi wydatek, kończy
   zapisem;
4. wyczerpane próby → zapis części, `succeeded`, `generationGaps`;
5. `shutdown` w ostatniej próbie → przy następnym przejęciu zapis z punktu
   kontrolnego bez wywołań modelu;
6. budżet wyczerpany → zapis części bez ponowienia, także gdy inne zagadnienie
   ma błąd przejściowy;
7. termin runu → zapis części przed terminem kontrolera (`succeeded`, nie
   `provider_timeout`);
8. zero przyjętych → `failed`/`validation`, liczniki w kontekście; wszystkie
   zagadnienia z błędem konfiguracji → `failed`/`provider_configuration` bez
   ponowienia;
9. edycja rodzica w trakcie → zapis punktu kontrolnego odrzucony, run
   `superseded`, szkic bez zmian; to samo przy podbiciu `editNumber` przez
   nadzór (`acceptVerdictAsVariant`) — run nie zostaje w `running`;
10. „Ponów” rodzica (porażka, `running`, odroczone `queued`) → ćwiczenia
    zostają, budżet wyzerowany; „Ponów” w trakcie próby (dwie karty) →
    spóźniony zapis starej próby odrzucony, nowa próba wznawia poprawnie;
11. dogenerowanie +N → najwyżej N + braki etapów nowych ćwiczeń, szkic
    nietknięty, kolizja z historyjką odrzucona; +N z błędem przejściowym →
    `requeue` → łącznie ≤ limitu nowych, bez duplikatów; +N bez żadnego nowego
    → `failed`, `editNumber` bez zmian;
12. uszkodzony punkt kontrolny → start od zera; przełączenie przedmiotu na
    potok między próbami → potok ignoruje postęp;
13. przedmiot spoza listy → potok bez zmian (fake LLM wołany, agent nie);
14. koszty: zdarzenia `UsageRecorder` w zakresie runu (`provider:
    "openrouter"`, operacje);
15. składanie z env (`createGenerationDepsFromEnv` z `UMIEM_FAKE_PROVIDERS=1`
    i listą przedmiotów) → pełna generacja ścieżką agenta.

**E2E:** pełny `pnpm test:e2e:shards` przed PR. Nowe przypadki w istniejących
specach `mocked` (formularz lekcji, edytor szkicu): komunikat usług przy
przedmiocie z `checkService` (wariant z materiałem i bez), brak komunikatu
krytyka, alert `generationGaps`. Testy jednostkowe komponentów
(`new-lesson-form.test.tsx`, edytor) dla tych samych komunikatów.

**Płatne przebiegi:** brak w etapie 2a (pomiar to etap 3). Opcjonalny jeden
przebieg kontrolny ścieżki zintegrowanej tylko na wyraźne polecenie
właściciela.

## 13. Dokumentacja

- `docs/architecture.md` §19.17 — ścieżka agenta, punkt kontrolny i
  podsumowanie, wynik próby, tryb „dodaj N”, przełącznik per przedmiot,
  terminy; §23 — operacje kosztów agenta;
- `docs/provider-config.md` i `.env.example` — `UMIEM_LESSON_AGENT_*`, klucz,
  routing (dziedziczenie), rodziny modeli;
- `AGENTS.md` — zdanie o `ai`/`@openrouter/*` („wyłącznie w `tests/probes` i w
  jednym pliku adaptera z jego testem”) oraz punkt o agencie w sekcji
  prywatności (usługa checkera, punkt kontrolny bez danych dziecka,
  podsumowanie bez treści);
- `docs/SPEC.md` — informacja o niepełnej puli i usługach (krótko, w sekcji
  generowania lekcji).

## 14. Ryzyka

| Ryzyko | Rozstrzygnięcie |
|---|---|
| Kontroler przerwie kierownika przed zapisem | Termin kierownika = termin kontrolera − 30 s, liczony od startu runu (§7.2) |
| Utracony zapis punktu kontrolnego (błąd bazy) | Wyjątek → ponowienie; powtórzona praca, szkic nietknięty |
| Migawki sprzed bezpiecznika w punkcie kontrolnym | Kontrola końcowa na całości przy zapisie (§10) |
| Błąd konfiguracji dostawcy pali próby | Mapowanie błędów: `configuration` nieprzejściowy (§4) |
| Treść lekcji w trwałym wierszu runu | Podsumowanie bez treści po zapisie; zerowanie przy anulowaniu (§8.1) |
| Zmiana listy przedmiotów między próbami | Wybór przy każdej próbie; potok ignoruje postęp |
| Web pobiera SDK do bundla | Adapter osiągalny tylko z `@learning/server/lesson-agent` (worker); test importów |

## 15. Rozstrzygnięcia po review (wersja 2)

| Uwaga | Rozstrzygnięcie |
|---|---|
| Termin kierownika = termin kontrolera, kontroler przerywa pierwszy; `call` ma limit 90 s (K1, K2, K3) | `control.run` bez limitu żądania; termin kierownika = pozostały czas − 30 s (§7.2); test „termin → zapis części” |
| Błędy SDK klasyfikowane jako przejściowe, z materiałem w `cause` (K1, K2, K3) | Mapowanie na `GenerationProviderError` bez `cause` (§4); `retryable` w `failure`; wiersz 6 §9 |
| Tryb „dodaj N”: punkt kontrolny i wynik liczą szkic, limit liczy tylko pulę (K1, K2, K3) | Punkt kontrolny i wynik — tylko nowe; limit nowych `remaining + stageGap + listenLeft`, `slack` 0; `targets` z `remaining` (§6.4, §9) |
| „Dodaj N” bez rundy pod etap — regresja względem potoku (K3) | Komplet wymaga braku braków etapów; limit obejmuje `stageGap` (§6.4) |
| Wznowienie niepełnych zagadnień: limity, prompt, rodziny (K1) | Start od zera; `familyScope` per próba (§7.1) |
| Brak haka po planie; przykłady planu po wznowieniu (K1, K2) | `onObjectivesResolved`, `initialExamples`, `examplesFixed` (§6.1–6.2) |
| Wynik próby gubi ćwiczenia wcześniejszych prób (K1) | `accepted` z punktu kontrolnego uzupełnionego wynikiem, kolejność lekcji (§10) |
| Wyczerpane próby odrzucają punkt kontrolny (K2, K3) | Wybór ścieżki przed limitem prób; zapis bez wywołań (§3, §9) |
| Straż nie łapie podbicia `editNumber` przez nadzór (K1, K2) | Straż z warunkiem na wersję; ścieżka sama oznacza `superseded` (§8.2, §7.2) |
| `generationService` jeden dla katalogu; komunikat krytyka; materiał u checkera (K1, K2, K3) | Usługi per przedmiot, dwa warianty komunikatu, bez komunikatu krytyka (§11) |
| Brak oznaczenia niepełnej puli (`needs_review` ze specu etapu 1) (K2, K3) | `generationGaps` w kontekście i DTO, alert w edytorze; bez nowego stanu runu (§11) |
| `rejectedCount` zmienia znaczenie (K3) | Liczy tylko usunięcia po przyjęciu; kody pętli w histogramie (§8.1, §10) |
| Trwały zapis kodów odrzuceń (obietnica etapu 1) (K3) | Histogram w postępie i podsumowaniu (§8.1) |
| Budżet: ponowienie mimo wyczerpania, start podagentów, utrata wydatku (K1, K2, K3) | Wiersz 1 §9; start pod budżetem (§6.3); zapis best-effort (§8.2 pkt 4) |
| Ustawienia prywatności dostawcy (`deny`) (K2) | `UMIEM_LESSON_AGENT[_CHECKER]_PROVIDER_*` z dziedziczeniem z `UMIEM_LLM` (§5) |
| Kolejność kluczy, własny klucz, jawny `apiKey`/`baseURL` (K2) | `endpointKeyFromEnv` z prefiksem; jawne opcje i test (§4, §5) |
| Web nie może rzucać przy starcie; bundel SDK (K2) | `lessonAgentPublicFromEnv` nie rzuca; adapter tylko przez eksport `@learning/server/lesson-agent` (§5) |
| Punkt kontrolny bez czyszczenia (K2) | Podsumowanie bez treści; zerowanie przy `supersedeLessonRuns` (§8.1) |
| `UMIEM_FAKE_PROVIDERS` z pustymi fake'ami (K3) | Domyślny scenariusz „jak LLM”, checker `null`; test składania z env (§5, §12) |
| „Ponów”: gałęzie i budżet (K1, K2, K3) | Wszystkie gałęzie kolejkujące, pod `FOR UPDATE` (§8.4); test dwóch kart |
| Nazwy: `"openrouter"`, `generation-env.ts`, `existingDraftsOf`, migracja, `vitest.unit.config.ts`, pomocnik zapisu (K1, K2) | Poprawione (§4, §5, §7.1, §8.1) |
| Zdania historyjki w trybie „dodaj N” (K3) | `extraExposureSources` (§6.4) |
| „+N” do 60, a agent daje ok. 10–12 (K3) | `add_short` „dodano k z N” w `generationGaps` (§11) |
| Rozmiar PR (K3) | Zostaje jeden PR (decyzja właściciela); refaktor zapisu jako pierwszy commit (§1) |

## 16. Nota z implementacji (2026-11-05)

Odstępstwa od tekstu specu, ustalone w trakcie implementacji; kod jest źródłem
prawdy. Opis końcowy: `docs/architecture.md` §19.17 i §23.

1. **`familyScope`** = `${attemptNonce}:${runId}:${expectedEditNumber}:${attempts}`
   z losowym UUID próby (`randomUUID` w powłoce `executeLessonAgentGeneration`,
   do czystej `lessonAgentRunInputFor` przekazywany jawnie). `scopeFamiliesToRun`
   bierze z zakresu tylko 6 pierwszych znaków szesnastkowych, a „Ponów”
   odroczonego runu zeruje `attempts` bez podbicia numeru edycji — para
   `${runId}:${attempts}` (§6.4, §7.1, §15) powtarzałaby się między próbami.
2. **Składanie w workerze:** `base = createGenerationDepsFromEnv(env, usage)`,
   `lessonAgent = lessonAgentDepsFromEnv(env, subjects, usage, base.llm)`,
   `generation = lessonAgent ? { ...base, lessonAgent } : base`.
   `createGenerationDepsFromEnv` nie ma parametru `{ lessonAgent }` (§5).
3. **Tryb fake:** planista to deterministyczny plan z `input.coverage` (trzy
   zagadnienia „Część 1/2/3”, słowa dzielone po równo, ramy w trzecim), nie wynik
   `generateLessonObjectives` (§5). Fake nie zapisuje wierszy kosztów (nie dostaje
   `usage`) i sprawdza tylko listę przedmiotów, nie modele, wysiłki ani routing.
4. **Punkt kontrolny:** ćwiczenia sprawdza strażnik kształtu
   (`isWellShapedRawExercise` / `toExerciseDraft`), obwiednię Zod, temat dynamiczny
   przy wznowieniu `validateDynamicTopicData`; zamiast pełnego Zod ćwiczeń (§8.1).
   `resetLessonAgentBudget` to czysty SQL (`jsonb_set`) bez Zod (§8.4). Log
   `checkpoint=invalid` tylko dla uszkodzonych wartości i innej wersji.
5. **Rezerwa finalizacji** `AGENT_FINALIZATION_RESERVE_MS = 30 000` ms jest
   nadpisywalna w `LessonAgentDeps.finalizationReserveMs` (testy).
6. **DTO:** wpis przedmiotu w katalogu ma dodatkowe pole
   `checkServiceIncludesMaterial` (polityka `checkerNeedsMaterial`, wybór wariantu
   komunikatu bez identyfikatora przedmiotu); `generationGaps` jest w
   `LessonDraftDto` (szkic), nie w DTO wersji opublikowanej (§11).
7. **Adapter AI SDK:** własny błąd narzędzia kierownika zatrzymuje pętlę i jest
   rzucany bez zmian (`toolFailureGuard`; SDK przekazałoby go modelowi).
   `APICallError` ze statusem 2xx (nieczytelne ciało) jest zapisany jako
   nieczytelna odpowiedź z kosztem `null`, nie jako błąd HTTP o koszcie 0 (§4).
8. **Porażka walidacji zapisu** (także gdy wszystkie przyjęte odpadły przez
   kolizje z historyjką lub osierocone słowa kluczowe): w tej samej transakcji
   liczniki punktu kontrolnego są zerowane, a odrzucone ćwiczenia usuwane, żeby
   „Ponów” nie liczyło ich dwa razy. W trybie `pool` taka porażka zostawia
   `generationGaps` bez zmian.
9. **Brak czasu dla kierownika** (termin − rezerwa ≤ 0), nic nie przyjęto i budżet
   nie jest wyczerpany → `failed`/`provider_timeout`; wyczerpany budżet i wspólny
   kod dostawcy z punktu kontrolnego zachowują swoje kody (§9).
10. **„+N” z historyjką (rozstrzygnięcie R8):** przyjmowanie agenta odrzuca tylko
    ćwiczenia samodzielne powtarzające zdanie historyjki, a zapis końcowy
    kolizje każdego typu. Obietnica §6.4, że agent nie traci budżetu na
    ćwiczenia odrzucane potem przy zapisie, jest spełniona tylko częściowo —
    znane ograniczenie, do dopracowania w kolejnym etapie.
11. **Pozostałe doprecyzowania:** `add_short` liczy ćwiczenia faktycznie zapisane
    (po kolizjach z historyjką); temat katalogowy jest zawężony do `objectiveIds`
    lekcji przed uruchomieniem kierownika.
12. **Luki trybu `pool` z zapisanych ćwiczeń:** zagadnienie `complete`, któremu
    kontrola końcowa albo sam zapis (kolizje z historyjką, osierocone słowa
    kluczowe) odrzuciły choć jedno ćwiczenie, dostaje lukę `incomplete` tylko
    wtedy, gdy nie jest kompletem na zapisanej lekcji: status liczony od nowa
    funkcją domeny `completeObjectivesOnLesson` (stan jak w `finalLessonCheck`,
    `objectiveStatus`, własne przykłady kart, pozostałe źródła ujawnień i limity
    puli jak w kierowniku). Odrzucony nadmiar albo duplikat luki nie daje.
    Dogenerowanie liczy dalej zapisane nowe ćwiczenia. Podsumowanie punktu
    kontrolnego zachowuje statusy agenta sprzed zapisu.
13. **Spełnione „+N” usuwa wpis luki zagadnienia** (dodano ≥ N), nawet gdy braki
    etapów zostały; pokazują je nadal znaczniki pokrycia w edytorze. Podpowiedź
    „Dogeneruj” nie wspomina uzupełnienia braków etapów (tekst bez zmian).
    Dogenerowanie agentem nie generuje przykładów kart (`examplesFixed: true`).
14. **DTO i fork:** `generationGaps` w DTO szkicu tylko dla zagadnień z
    `objectiveIds` (zagadnienie usunięte przez rodzica nie ma luki do uzupełnienia);
    nowa wersja z opublikowanej nie dziedziczy `generationGaps` (jak `review`).
15. **Punkt kontrolny i terminy:** wartość nie do użycia jako postęp (uszkodzona
    obwiednia, zły temat) zachowuje nieujemny wydatek (`salvageLessonAgentSpend`);
    sukces zapisu potokiem zeruje `agent_checkpoint`; termin kierownika liczony
    od startu runu (`runStartedAtMs`, §7.2), jak termin finalizacji; odczyty przed
    próbą są w obsłudze błędów (błąd bazy nie zostawia runu w `running`).
16. **Usługi w panelu:** przedmiot z historyjką (`lessonStory`) ma w
    `generationServices` także usługę `UMIEM_LLM` (run historyjki dostaje
    materiał), o ile różni się od usługi agenta; przy kilku usługach komunikat
    jest w liczbie mnogiej (`generationServicesInfo`).
17. **Tematy zdań w panelu:** notka o tematach podaje tylko model agenta
    (pierwsza z `generationServices`); usługa historyjki tematów nie dostaje.
