# Agent puli lekcji — etap 3: agent jedynym generatorem, usunięcie krytyka (#237)

Wersja 3, 2026-11-05 (po przeglądzie trzech krytyków wersji 2; rozstrzygnięcia
w §9). Zastępuje wersję 1 (płatne porównanie agenta z potokiem), którą
właściciel odrzucił: agent ma generować i dogenerowywać lekcje, a stary sposób
i krytyk mają zniknąć. Etapy 1, 2a i 2b są scalone (#258, #275).

## 1. Cel i decyzje właściciela (2026-11-05)

**Cel.** Pulę ćwiczeń lekcji generuje i dogenerowuje („Dogeneruj +N”) wyłącznie
agent puli. Dzisiejszy sposób jednym wywołaniem z rundami dogenerowania etapów
(„potok”) i krytyk lekcji znikają z kodu.

| Pytanie | Decyzja |
|---|---|
| Płatne porównanie agent kontra potok | nie robimy |
| Stary sposób generowania | usunąć, nie zostawiać jako zapasu |
| Krytyk lekcji | usunąć (dawny etap 4) |
| Podział | dwa PR: PR 1 krytyk, PR 2 agent jedynym generatorem |
| Brak klucza OpenRouter w workerze | worker startuje, lekcje się nie generują, panel mówi dlaczego (§5.4) |
| Test na prawdziwych modelach | płatny przebieg kontrolny: 1 przebieg na przedmiot + jedno „+N”, za zgodą przed startem (§6.4) |

**Skutek dla wdrożeń bez OpenRouter.** Przy domyślnej konfiguracji
(`UMIEM_LLM_BASE_URL` i `UMIEM_TTS_BASE_URL` na OpenRouter) worker bez klucza
OpenRouter nie startuje już dziś. Konfiguracja z modelami bezpośrednio u OpenAI
(`docs/provider-config.md`) dziś generuje lekcje potokiem; po PR 2 traci
generowanie lekcji (słówka i reszta działają). To świadomy skutek decyzji
„usunąć stary sposób”; opis PR 2, `provider-config.md` i `docs/deploy.md`
mówią to wprost jako zmianę niezgodną dla takich wdrożeń.

**Poza zakresem:** strojenie promptów i polityk agenta; przeniesienie treści
`reviewRules` krytyka do polityk agenta (przepada świadomie; kandydat na osobne
zadanie); lematyzator; punkty 2–7 z „Do rozwiązania” w issue; pokazywanie
rodzicowi liczby niesprawdzonych ćwiczeń; zmiany słówek, kartkówek i sesji
dziecka; strażnik w API przed kolejkowaniem runu bez klucza (wystarcza panel i
szybka porażka runu, §5.4).

**Moduł i zależności.** Obszar `materials/lessons` (autorstwo materiału) i
konfiguracja (`config.ts`, `config-defaults.ts`, kompozycje web i worker).
Bez nowych zależności, bez migracji, bez zmian granic modułów. Transakcje
zapisu do szkicu (`finalizeLessonPoolWrite`) i punkt kontrolny agenta bez zmian.

**Kolejność:** PR 1 scala właściciel, PR 2 powstaje na `main` po PR 1.

## 2. PR 1: usunięcie krytyka lekcji

### 2.1. Zakres

Krytyk (PR #236, `LessonReviewerProvider`, `UMIEM_REVIEWER_*`, domyślnie
wyłączony) jest wołany tylko z potoku. Usuwamy go w całości:

- **Panel rodzica:** `LessonReviewBanner.tsx` (z testem; razem z nim
  `fillTemplate`, jeśli nikt inny go nie używa); notatki i plakietki krytyka w
  `LessonExerciseCard.tsx` i `LessonEditor.tsx` (`leakNoticeFor` zostaje);
  informacja o usłudze krytyka w `LessonSupervisionPanel.tsx`,
  `NewLessonForm.tsx`, `SourcePage.tsx`; styl `.pp-lesson-review-toggle`.
- **Kontrakty:** `REVIEW_CATEGORY_VALUES`, schematy i typy `Review*`,
  `LessonDraftDto.review`, `SubjectCatalogDto.reviewService`,
  `LessonDeckDto.reviewService`; wszystkie klucze `review*` w
  `messages.lessons` (`reviewBanner` … `reviewServiceInfo`) i import typów w
  `messages.ts`; w `themesService` i `themesServiceUnknown` wzmianka o
  „automatycznej kontroli jakości” (po PR 1 nieprawdziwa).
- **API i kompozycja:** `reviewDto` i pola `review`/`reviewService` w
  `lesson-api.ts`; `Services.reviewService` i jego wejście w `createServices`;
  `reviewService` w kompozycji web.
- **Potok i domena:** faza przeglądu w `lesson-drafts.ts` (`reviewPhase`,
  `mainReview`, `mergedReview`, `REVIEW_DROP_REASON`,
  `REVIEW_FINALIZATION_RESERVE_MS`, `LessonPoolReview`, `LessonContext.review`,
  parametry `review` w `stageTopUpRound`, `failLessonPoolValidation`,
  `finalizeLessonPoolWrite`; termin fazy = termin runu) oraz to, co po zdjęciu
  raportu jest martwe: `toppedUp`, `stageCountsOf`, `objectiveContext`,
  `StageTopUpContext.review|reviewReserveMs`.
  `modules/materials/lessons/lesson-review.ts`, `domain/lessons/review-criteria.ts`,
  `review-report.ts`, `review-verdicts.ts`, `lesson-fingerprint.ts` (martwy) —
  z testami.
- **Port, adaptery, konfiguracja:** typy krytyka w `ports/ai.ts`;
  `providers/openai/lesson-reviewer.ts`, `lesson-review-schema.ts` (z testem);
  `FakeLessonReviewer`; `fakeReviewerFromEnv` i pole `reviewer` w
  `generation-env.ts`; `GenerationDeps.reviewer`, `ReviewerPolicy|State|Deps`,
  blok `reviewerEnabled` … `reviewerPublicServiceFromEnv` w `config.ts`;
  `UMIEM_REVIEWER_*` w `config-defaults.ts`; eksport w `index.ts`; prefiks
  `UMIEM_REVIEWER` w `chat-request-options.ts` i `openrouter-key.ts`;
  `reviewerHealthBudgetWarning` w workerze (`loop.ts`, `main.ts`).
  `lesson-json-request.ts` zostaje razem z tablicową treścią i
  `cache_control` (tani zapas na cache prefiksu generatora); poprawiamy tylko
  komentarz w `usage-recording.architecture.test.ts`.
- **Reguły przedmiotów:** pole `SubjectModule.reviewRules` (typ, walidacja
  katalogu, teksty w promptach trzech przedmiotów i w
  `testing/history-like-subject.ts`).
- **Sondy:** `tests/probes/lesson-review.probe.test.ts`, skrypt
  `probe:review`; wątki krytyka w `chapter-generation.probe.test.ts` (stan
  krytyka, koszt `lesson_review`, prefiks `[lesson-review]`); komentarz w
  `vitest.probe.config.ts`.
- **Dokumentacja:** `docs/architecture.md` §19.16 i `docs/SPEC.md` §29a.9
  zastępuje jednozdaniowa notka („Krytyk lekcji usunięty w etapie 3 #237,
  2026-11-05; historia: spec 2026-11-02”) — **numeracja sekcji zostaje**, bo
  inne dokumenty odwołują się do §19.17 i §29a.10; odwołania w §19.15 i §19.17.
  `AGENTS.md`: punkt o krytyku, wzmianki w punktach o agencie i tematach zdań,
  zdanie o pomiarze integracji (przeformułować: najdłuższe pliki to
  `learning-algorithm.test.ts` i następny po pomiarze). `.env.example`,
  `docs/folder-structure.md`. Spec krytyka z 2026-11-02 dostaje na początku
  dopisek: „krytyk (PR 2 tego etapu) usunięty w etapie 3 #237 PR 1; reguła
  twarda ujawnień zostaje; runda pod etap usunięta w etapie 3 PR 2”. W
  `2026-11-02-llm-cost-tracking-design.md` przy wierszu `lesson_review` notka
  „usunięty w etapie 3”.

### 2.2. Nie mylić — zostaje

- **Ocena aktywności sesji** (`SessionActivityReviewer`,
  `session_activity_review`, `ParentWorkCardDto.reviewService`, `WorkCardPanel`,
  kody `review_failed`).
- Stan wersji `review` (`deck_versions.state`, grupa „Wymaga Twojej uwagi”),
  `nextReviewAt`, `mockTestReview*`, `reviewObjectives`.
- `findExposureLeaks`, `lesson-pool-acceptance.ts`, `exposure-key`,
  `exercise-identity`, `lesson-payload.ts`, `withLessonGenerationControl`.
- Cały potok bez fazy przeglądu — usuwa go PR 2.

### 2.3. Dane i zgodność

- `lesson_context.review` to klucz w JSONB `deck_versions.lesson_context` —
  **bez migracji** (trigger sprawdza tylko NULL/NOT NULL). Zapisy szkicu
  (`finalizeLessonPoolWrite`, `failedValidationContext`, edycja szkicu,
  historyjka) kopiują surowy kontekst, więc stary klucz zostaje w szkicu do
  „Utwórz nową wersję” (`withoutRunReports` nadal go usuwa), a w wersjach
  opublikowanych na zawsze. Nic go nie czyta; DTO go nie zawiera.
- Stare `rejectedReasons` z kluczem „odrzucone przez kontrolę jakości” zostają
  jako historia (panel pokazuje surowe klucze).
- Wiersze `provider_usage_events` z `operation = 'lesson_review'` zostają
  (kolumna tekstowa, bez CHECK; koszty agregują po `feature`).
- Pozostawione `UMIEM_REVIEWER_*` w `.env` lub Coolify są nieczytane; opis PR
  przypomina o ich usunięciu.
- Rodzic traci linijkę „Dogenerowane ćwiczenia, by uzupełnić brakujące etapy:
  N” — była widoczna tylko przy włączonym krytyku (domyślnie wyłączony).

### 2.4. Testy PR 1

- Usuwamy testy krytyka: unit domeny, modułu i adaptera,
  `tests/integration/lesson-review.test.ts`, sondę, E2E banera i plakietek
  (`parent-lesson-editor-layout.spec.ts`), asercje `lesson-review-service`
  (`parent-lessons-layout.spec.ts`). Pliki mieszane, w których usuwamy tylko
  część: `contracts/lessons.test.ts`, `lesson-drafts.test.ts`, `config.test.ts`,
  `generation-env.test.ts`, `fake.test.ts`, `catalog-validation.test.ts`,
  `apps/worker/src/loop.test.ts`, `new-lesson-form.test.tsx` (asercja tekstu
  `themesService` odwrócona), `sources-panel.test.tsx`,
  `apps/web/src/parent/lessons/lesson-exercise-card.test.tsx`,
  `lesson-agent-generation.test.ts`.
- **Przenosimy** z `lesson-review.test.ts` test „Utwórz nową wersję → kopia
  bez `review` i bez `generationGaps`” (jedyny test `withoutRunReports`) do
  `tests/integration/lesson-generation.test.ts`: zasiew obu kluczy `jsonb_set`,
  publikacja, `createLessonDraftFromPublished`, asercja braku obu kluczy.
  Tam też test „DTO bez `review`”.
- **Zgodność starych danych:** w `lesson-agent-generation.test.ts` dwa testy
  na ścieżce potoku („potok: nowy szkic bez klucza review”, „potok: stary klucz
  review w szkicu”): zasiew `review` w JSONB → run → `readLessonDeck`: run
  `succeeded`, DTO szkicu bez `review`. Testy „potok:” znikają w PR 2 (§6.1).
- **Strażnik limitu runu:** w `loop.test.ts` zostaje prosty test
  `UMIEM_LESSON_GENERATION_RUN_TIMEOUT_MS < WORKER_HEALTH_STALE_MS` na
  wartościach domyślnych (dziś pilnuje tego test ostrzeżenia krytyka).
- Rundy dogenerowania pod etap nie przenosimy: pokrywa ją
  `tests/integration/lesson-chapter.test.ts` (dogenerowanie z rundą, zdanie
  karty w rundzie, braki etapów z zapisanymi przykładami), a testy rundy w
  `lesson-review.test.ts` dotyczą tylko współpracy z krytykiem. Po PR 1
  `lesson-chapter.test.ts` przechodzi bez zmian asercji rundy.
- `tests/integration-buckets.ts`: wpis pliku i komentarz o najdłuższych
  plikach (przeliczenie LPT opcjonalne, odnotowane w PR).
  `tests/ai-sdk-scope.test.ts`: przykładowy plik `lesson-reviewer.ts` zastąpić
  `lesson-json-request.ts`.
- Przed PR: `pnpm check`, `pnpm test:integration`, `pnpm test:e2e:shards`.

### 2.5. Kolejność commitów (każdy się kompiluje)

Typecheck obejmuje `tests/**`, więc kolejność wymuszają importy:

1. Panel rodzica (pola kontraktów są opcjonalne) z testami web i częściami E2E.
2. Kontrakty, komunikaty i DTO: `Review*`, `review*`, `themesService*`,
   `reviewDto`, `Services.reviewService`, kompozycja web, test kontraktów,
   `tests/integration/lesson-review.test.ts` (czyta DTO, więc znika tu, razem z
   wpisem w koszach) i przeniesione testy z §2.4.
3. Potok i domena: faza przeglądu, `lesson-review.ts`, `review-verdicts.ts`,
   `review-report.ts` (bez `review-criteria.ts`, który zostaje do kroku 4, bo
   importuje go adapter), `lesson-fingerprint.ts`, `LessonContext.review`,
   sonda i `probe:review`, zmiana `lesson-agent-generation.test.ts`.
4. Konfiguracja, port i adapter: typy portu, adapter i schemat, `review-criteria.ts`,
   fake, `generation-env.ts`, blok w `config.ts`, `config-defaults.ts`, prefiksy,
   `index.ts`, worker (`loop.ts`, `main.ts`) z testem, `ai-sdk-scope`, wątki w
   `chapter-generation.probe.test.ts`.
5. `reviewRules`: typ, walidacja, teksty przedmiotów i ich testy.
6. Dokumentacja.

### 2.6. API → MCP → SKILL.md

Zmiany dotyczą wyłącznie DTO panelu rodzica (usunięte pola opcjonalne;
`SubjectCatalogDtoSchema` jest `.strict()`, ale web serwuje katalog i klienta z
jednego wdrożenia). Generowanie i szkic nie są częścią MCP ani
`learning-overview`; `integrations/` nie odwołuje się do tych pól. Bez zmian w
MCP i `SKILL.md`.

## 3. PR 2: co znika

- **Wybór ścieżki:** `lessonGeneratorFor`, lista `UMIEM_LESSON_AGENT_SUBJECTS`
  (`agentSubjectIds`, `lessonAgentSubjectsFromEnv`, `LessonAgentDeps.subjects`,
  `LessonAgentSettings.subjects`, `LessonAgentPublic.subjects`, warunek listy w
  `agentServicesOf`), rzutowanie `asAgentCapable` i opcjonalne `agentPolicy?.`
  po §4.3.
- **Potok w `lesson-drafts.ts`:** ciało potoku w `executeLessonGeneration`,
  `stageTopUpRound`, `StageTopUpContext`, `batchesForObjectives`,
  `trimToStageDeficits`, `STAGE_TOP_UP_*`, `EXPOSURE_LEAK_REASON`,
  `withinStageQuotas`, `capListenChoiceOverflow`, `ObjectiveGenerationLimits`,
  `collectBatchExerciseMetadata`, `filterExercisesToRequestedObjective`,
  `summarizeLessonPoolValidation`, `refineGeneratedDrafts`,
  `existingAnswersOf`, `existingExercisesOf`, `uniqueStimuli`; gałąź
  `finalizeLessonPoolWrite`, która czyści punkt kontrolny po zapisie potokiem;
  pola `LessonRunInput.regenerate.existingAnswers|existingExercises` znikają z
  typu, a parser wejścia runu nie odrzuca nadmiarowych kluczy (stare runy w
  kolejce przechodzą).
- **Inne moduły:** `acceptFreshLessonPool` (`sanitizeFreshLessonDraft` i
  `scopeFamiliesToRun` zostają), `resolveGenerationLeaks`, `stageDeficits`,
  `callSoft`, `stageTopUp` w polityce generowania.
- **Port i adaptery:** `LlmProvider.generateLessonPool`,
  `LessonPoolInput.purpose|existingAnswers|existingExercises`; w
  `providers/openai/llm.ts` `generateLessonPool`, `lessonExamplesToRecord` i
  bloki promptu „istniejące odpowiedzi/ćwiczenia” (zdanie o deduplikacji
  „Within this response…” zostaje); w `providers/fake.ts`
  `FakeLlmProvider.generateLessonPool`, `queueLessonTopUp`,
  `#lessonTopUpBehaviors`, routing `purpose` (generator przechodzi do
  fake-agenta, §5.2); parametry `existingAnswers`, `existingExercises`,
  `purpose` funkcji `buildPoolInput`.
- **Zagadnienia przez `generateLessonObjectives`** woła już tylko szkoła (bez
  `objectivesRules`), więc znika: pole `LessonObjectivesInput.objectivesRules`,
  jego przekazanie w `generateDynamicObjectives`, `kind` w
  `lessonObjectivesJsonSchema` i zdania o `kind`/„Subject rules for
  objectives” w `lessonObjectivesSystemPrompt`, `kind` w `fakeLessonObjectives`.

## 4. PR 2: co zostaje i co się zmienia w domenie

### 4.1. Zostaje (agent z tego korzysta)

`buildPoolInput` (bez parametrów potoku), `poolStageCounts`,
`objectiveBatchCounts`, `minimumCountPerObjective`, `meetsStageMinimums`,
`splitStages`, `listenChoiceAllowance` (z `[]`, używa go `lesson-api.ts`),
`lessonSystemPrompt`, `lessonUserMaterial`, `lessonPoolJsonSchema`,
`finalizeLessonPoolWrite`, `failLessonPoolValidation`, `generateDynamicObjectives`
(szkoła), `markLessonRun`, `mergeExamples`, `buildDynamicTopicData`,
historyjka lekcji, `sanitizeFreshLessonDraft`, `validatePool*`,
`refineGeneratedPool`, `materialize*`, `findExposureLeaks`,
`isWellShapedRawExercise`, `toExerciseDraft`, `stripParentAddedFlags`,
`classifyLessonGenerationFailure`, `generationGaps`, `agent_checkpoint`,
`UMIEM_LESSON_GENERATION_*`, `UMIEM_LLM_*` (zagadnienia szkoły, historyjka).

**Planista rozdziału:** `prompts.objectivesRules` rozdziału,
`LessonAgentPlanInput.objectivesRules`, `withSubjectObjectiveKinds` i
`DynamicTopicData.objectives[].kind` **zostają** — planista agenta wkleja te
reguły do instrukcji, a `kind` niesie rodzaj zagadnienia (`words`/`frame`) do
podagentów i dogenerowania szkiców rozdziału.

### 4.2. Testy promptu

Testy `llm.test.ts` sprawdzające treść promptu przez `generateLessonPool`
przenosimy na `lessonSystemPrompt`/`lessonUserMaterial` bez utraty asercji o
treści. `providers/lesson-calculations.test.ts` (materializacja rachunków przez
`generateLessonPool` adaptera i fake'a) przenosimy na materializację adaptera
agenta i generator fake-agenta.

### 4.3. `agentPolicy` obowiązkowe

`SubjectModule.agentPolicy` staje się wymagane (typ i walidacja w
`createSubjectRegistry`; test w `registry.test.ts`: każdy przedmiot rejestru ma
politykę). Trzy przedmioty produkcyjne już ją mają. Fixture'y testowe bez
polityki (`historyLikeSubject`, `agent-test-subject.ts`, `fixtureSubject` w
`lesson-agent-outcome.test.ts`, przedmioty w `pool-validation.test.ts`,
`registry.test.ts`, stuby w `config.test.ts`) dostają wspólną politykę testową
z `domain/lessons/testing/` z typami ślepego rozwiązania i wariantów
dobranymi do typów ćwiczeń `historyLikeSubject` (`choice`, `order`, `gap`,
`open_answer`) i pustymi listami kontroli 2b. `AGENTS.md`: nowy przedmiot
dodaje także `agentPolicy`.

## 5. PR 2: konfiguracja, tryb fake, panel

### 5.1. Konfiguracja

- `UMIEM_LESSON_AGENT_SUBJECTS` znika z `CONFIG_DEFAULTS`, `.env.example` i
  dokumentacji; pozostawiona w `.env` jest ignorowana.
- Pozostałe `UMIEM_LESSON_AGENT_*` bez zmian. **Zmiana zachowania:** dziś przy
  pustej liście nie są walidowane; po PR 2 waliduje je każdy start workera
  (model, wysiłek, routing, „inna rodzina modeli”, liczby), więc nieaktualna
  zła wartość zatrzyma start z nazwą zmiennej. Notatka wdrożenia o tym mówi.
  Web tych wartości nie waliduje (pokazuje je w etykietach).
- Kontrakt zależności: `GenerationDeps.lessonAgent` staje się wymagane w
  workerze i ma typ `LessonAgentDeps | LessonAgentUnavailable`, gdzie
  `LessonAgentUnavailable = { readonly unavailable: "no_openrouter_key" }`.
  `lessonAgentDepsFromEnv` zwraca jedno albo drugie, nigdy `undefined`, i
  traci parametr `llm` (tryb `fromLlm` znika).
- Grader kontroli otwartej szkoły bez zmian (bez pełnego `UMIEM_GRADER_*`
  szkoła działa bez kontroli otwartej, log `openCheck=off`).

### 5.2. Tryb fake (`UMIEM_FAKE_PROVIDERS=1`)

- **Zawsze dostępny:** w trybie fake web i worker nie czytają klucza
  OpenRouter; worker składa fake-agenta, web zwraca
  `lessonGenerationAvailable: true`. `deploy/compose.smoke.yaml` dostaje
  `UMIEM_FAKE_PROVIDERS: "1"` także w web (tam `OPENROUTER_API_KEY=""`).
- **Generator fake-agenta:** deterministyczny generator ćwiczeń z
  `FakeLlmProvider` przenosimy do `providers/fake-lesson-agent.ts` (funkcja
  fake'a, nie metoda portu). Wymagania:
  1. odpowiedzi i bodźce **unikalne w całej lekcji**: numeracja z ziarnem z
     indeksu zagadnienia w temacie (nie od zera w każdym zagadnieniu);
  2. przy „+N” przesunięcie liczone z wejścia podagenta (liczba istniejących
     ćwiczeń zagadnienia albo `avoidSentences`/`cardSentences`), bez stanu
     instancji (fake żyje przez cały proces workera);
  3. jeden krok na zagadnienie, chyba że wynik narzędzia mówi o brakach
     (`missing`, `complete: false`) — wtedy kolejny krok do `maxSteps`, tak jak
     robi to model;
  4. `FAKE_SLOW_MARKER` w materiale opóźnia pierwszy krok zagadnienia o 3 s, a
     `UMIEM_FAKE_LESSON_DELAY_MS` / `UMIEM_FAKE_DELAY_MS` dalej działają
     (czytane w `lessonAgentDepsFromEnv` i przekazywane w opcjach); sen
     przerywa `signal` (anulowanie, termin, zamknięcie workera);
  5. w trybie workera fake nie zapisuje historii wywołań (`calls`,
     `planCalls`) — tylko w testach (opcja).
- **Checker fake:** zostaje `FakeExerciseChecker({ unavailable: true })`, jak
  w 2a: ćwiczenia przechodzą bez kontroli modelem (nota `unchecked`). Checker
  nie zna klucza odpowiedzi, a widoki fake'a go nie niosą, więc tryb „poprawne
  odpowiedzi” wymagałby wyroczni — niepotrzebnej, bo pełną ścieżkę przyjęcia
  pokrywają testy integracyjne ze skryptowanym checkerem. Grader w fake nadal
  nieobecny.
- **Planista rozdziału w fake** daje zagadnienia z pokrycia
  (`fakePlanFromCoverage`, co najmniej 3); tytuły zagadnień rozdziału w testach
  zmieniają się z „Zagadnienie N: …” na tytuły planisty fake.
- **Test przed E2E:** test integracyjny „tryb fake z env” —
  `lessonAgentDepsFromEnv({ UMIEM_FAKE_PROVIDERS: "1" })` — daje publikowalną
  pulę bez `generationGaps` dla gramatyki (trzy zagadnienia), rozdziału (na
  materiale z `parent-sources.spec.ts`) i szkoły, a „+N” dodaje co najmniej N
  ćwiczeń bez duplikatów.

### 5.3. Panel rodzica

- Katalog przedmiotów dostaje wymagane pole `lessonGenerationAvailable: boolean`.
  Web liczy je: tryb fake → `true`; inaczej `lessonAgentKeyFromEnv(env) !==
  undefined`, a wyjątek kształtu klucza → `false` (web nie rzuca).
- Przy `true` katalog opisuje usługi agenta (`generationServices`,
  `checkService`, `checkServiceIncludesMaterial`, `openCheckService`) bez
  warunku listy; przy `false` ich nie ma. Informacja o usłudze tematów zdań
  (`themesService ?? generationService` w formularzu) zostaje, a gdy agent jest
  jedynym generatorem, komunikat `themesService*` wymienia też checkera agenta:
  dostaje gotowe zdania, nie listę tematów (AGENTS.md: checker i krytyk nie
  widzą listy tematów); plan sprawdza,
  co z katalogowym `generationService` potoku zostaje potrzebne (zagadnienia
  szkoły, historyjka) i odpowiednio zmienia fixture'y `mocked`.
- Web i worker muszą widzieć ten sam klucz agenta. W `deploy/compose.yaml`
  czytają ten sam `.env`; przy Coolify z env per serwis klucz musi trafić do
  obu — `docs/deploy.md` to mówi.

### 5.4. Brak klucza OpenRouter

- **Worker** startuje normalnie. Log startu jedną linią: `[config]
  lesson-agent=unavailable reason=no_openrouter_key`. Klucz w złym kształcie
  pozostaje błędem startu.
- **Run lekcji** (pełna generacja i „+N”): `executeLessonGeneration` po
  rozpoznaniu runu historyjki (który nie zależy od agenta) i po claimie
  sprawdza `lessonAgent`; przy `LessonAgentUnavailable` zapisuje `failed` z
  kodem `lesson_agent_unavailable` (nieponawialny), bez odczytu punktu
  kontrolnego, bez wywołań modeli (także zagadnień szkoły), bez zlecenia
  historyjki i bez zmiany szkicu. Nieznany przedmiot nadal daje
  `failed`/`validation`. `errorCode` w kontraktach to wolny tekst — nowy kod
  nie wymaga enumu.
- **Panel:** komunikat w `messages.lessons.generationErrors`:
  „Generowanie lekcji wymaga klucza OpenRouter w konfiguracji serwera. Po
  dodaniu klucza ponów generowanie.” Przy `lessonGenerationAvailable: false`
  formularz nowej lekcji, „Dogeneruj” i „Ponów generowanie” runów lekcji
  pokazują ten komunikat i są wyłączone.

### 5.5. Prywatność

Bez nowych kategorii danych względem 2a/2b. Zmienia się zasięg: domyślnymi
odbiorcami danych **każdej** lekcji stają się generator agenta (OpenRouter,
Gemini) i checker innej rodziny (OpenRouter, DeepSeek; w szkole z materiałem),
a w szkole grader w workerze przy pełnym `UMIEM_GRADER_*`. Nigdy dane dziecka.
Panel nadal informuje o tych usługach. Opis PR i `provider-config.md`
wymieniają nowych domyślnych odbiorców wprost.

### 5.6. Koszt i wdrożenie

- Agent kosztuje więcej niż potok (budżet runu domyślnie 1,00 USD; próba
  2026-11-03: rozdział 0,11–0,15, gramatyka ok. 0,07, szkoła 0,20–0,31 USD plus
  kontrole 2b). `docs/deploy.md` i opis PR mówią to wprost.
- Bez migracji. Web i worker wdrażamy razem. Runy w kolejce sprzed wdrożenia
  przejdą agentem (agent ignoruje pola potoku, start z pustym punktem
  kontrolnym; dogenerowanie szkiców rozdziału z potoku bierze temat i `kind`
  ze szkicu).
- Wycofanie: `git revert` PR 2; zmiennej przełączającej nie ma.

## 6. PR 2: testy

### 6.1. Testy integracyjne

- `tests/integration/fakes.ts`: fake'i generowania składają agenta
  (fake-agent + checker `unavailable`) zamiast `routeLessonRound`; testy z
  własnym scenariuszem używają skryptowanego fake-agenta i checkera, jak
  `lesson-agent-generation.test.ts`.
- **Usuwamy** testy mechaniki potoku: partie, `MAIN_BATCH_ONLY`, rundy
  dogenerowania etapów (`stage_top_up`), liczba żądań puli, reguła twarda po
  fakcie (`resolveGenerationLeaks`), testy „przedmiot spoza listy idzie
  potokiem” w `lesson-agent-generation.test.ts`.
- **Lista obowiązkowa zachowań** (z `lesson-generation.test.ts` i
  `lesson-chapter.test.ts`), które muszą mieć po PR 2 test na ścieżce agenta
  (przepisany albo wskazany istniejący w `lesson-agent-generation.test.ts` lub
  unit); plan przypisuje każdemu decyzję:
  - zgodność starych danych: stary klucz `review` w szkicu (run `succeeded`,
    DTO bez `review`) i kopia wersji bez `review`/`generationGaps` — przenieść
    na ścieżkę agenta, bo testy „potok:” znikają;
  - zapis: `payload_version`, `target_key`, umiejętność zagadnienia, stan
    `review`; ćwiczenia słuchowe w gramatyce bez odrzuceń i czyszczenie
    polecenia/podpowiedzi/piktogramu (`agentPolicy.sanitize`);
  - porzucenie redundantnego wariantu `acceptedAnswers`; hak
    `refineGeneratedPool` nie działa przy edycji rodzica;
  - zły kształt pola, `null` w tablicy, odpowiedź strict-schema z `null`: run
    terminalny, poprawne ćwiczenia zapisane; wadliwe przykłady odrzucone,
    poprawne zostają;
  - przerwanie workera po claimie, odcięcie spóźnionego zapisu, stary SELECT
    przed claimem; restart procesu workera wykonuje run; edycja rodzica
    unieważnia run w kolejce przed wywołaniem providera;
  - błąd trwały po jednym żądaniu; ręczne „Ponów” czyści odroczenie;
    `nextAttemptAt`;
  - `historyLikeSubject` w całym przepływie bez audio; przypadkowe TTS daje
    `superseded`;
  - wyjaśnienia błędów: gramatyka zapisuje, łamiące reguły po cichu usuwa,
    szkoła po cichu odrzuca; szkoła v3 z cytatami; ton lektora w payloadzie,
    kontekście i DTO; rachunki (parametry, odrzucenie wadliwych, niezaufane
    `parentAdded`); publikacja i sesja dziecka szkoły; patch `dynamicTopic`;
  - reguła ujawnień: przykład karty; rodzina pytań otwartych liczona raz;
    usunięcie rodziny razem ze słowami kluczowymi; domyślna pula fake bez
    ujawnień;
  - rozdział: rodzaje zagadnień, v2 bez cytatów, pula do publikacji; słowo
    spoza materiału usuwa ćwiczenie (wariant spoza materiału znika, ćwiczenie
    zostaje); pełne odrzucenie daje `failed`/`validation` z powodami i
    możliwością ponowienia; ujawnienie między zagadnieniami (przykład karty A
    rozwiązuje B; forma skrócona); przy „+N” nowa luka rozwiązująca
    tłumaczenie ze szkicu odpada; zawartość `avoidSentences`.
- **Sesja dziecka rozdziału** (blok testów budujący pulę z jednym zagadnieniem
  i przykładami od generatora): przepisać na zasiew szkicu wprost w bazie (jak
  `lesson-calculation.spec.ts`), bo planista daje co najmniej 3 zagadnienia, a
  przykłady pochodzą z planu.
- **Brak klucza:** `lesson_agent_unavailable` przy pełnej generacji i „+N”;
  zero wywołań modeli (także `generateLessonObjectives` w szkole); brak
  zlecenia historyjki; szkic i `editNumber` bez zmian; brak `queued`.
- **Bez zmian** (niezależne od ścieżki): `createLesson*`, jeden aktywny „+N”,
  tytuł rozdziału, edycje rodzica w `lesson-chapter.test.ts`.
- **Dopasowanie składania i liczb** w: `lesson-story`, `child-interests`,
  `lesson-listen-choice`, `source-materials`, `lesson-parent-api`,
  `lesson-error-explanation`, `lesson-story-audio`, `publish-media-reconcile`,
  `grammar-without-tts`, `lesson-chapter-sentence-audio`,
  `lesson-sentence-audio`, `provider-usage-scope.test.ts` (koszt runu zapisuje
  fake-agent przez `usage`), `generation.test.ts` (szpieg
  `generateLessonPool`).
- Po zmianach przeliczyć `INTEGRATION_BUCKETS` (zasady w `AGENTS.md`).

### 6.2. Unit, E2E, architektura

- **Unit:** `config.test.ts` (lista → dostępność z klucza, tryb fake),
  `lesson-agent-env.test.ts`, `lesson-agent-outcome.test.ts`, `fake.test.ts`,
  `fake-lesson-agent.test.ts` (generator: unikalność w lekcji, „+N”,
  `FAKE_SLOW_MARKER` tylko pierwszy krok, przerwanie snu, opóźnienia z env),
  `lesson-drafts.test.ts`, `lesson-generation-policy.test.ts`, `llm.test.ts`,
  `lesson-calculations.test.ts`, kompozycje web i worker (z kluczem, bez
  klucza, fake bez klucza → dostępne, log startu raz), `registry.test.ts`.
- **E2E `real`:** `lesson-parent.spec.ts` (restart z `FAKE_SLOW_MARKER`, pula
  wielocelowa, luka + „Dogeneruj”), `lesson-mock-test.spec.ts` (pula 20),
  `lesson-real-flow`, `lesson-archive`, `lesson-parent-supervision`,
  `parent-sources` — dopasować do fake-agenta. Po zmianach przeliczyć
  `REAL_BUCKETS`, jeśli czasy plików mocno się zmienią.
- **E2E `mocked`:** fixture katalogu z `lessonGenerationAvailable`; nowe
  przypadki: formularz nowej lekcji i „Dogeneruj” w edytorze
  (`parent-lesson-editor-layout.spec.ts`) wyłączone z komunikatem przy
  `false`; `parent-lessons-layout.spec.ts` (usługa tematów zdań) zgodnie z
  §5.3.
- **Architektura:** `tests/ai-sdk-scope.test.ts` i
  `lesson-agent-imports.architecture.test.ts` bez zmian w regułach; bundle web
  bez SDK (jak w 2a).
- Przed PR: `pnpm check`, brak SDK w bundlu web, `pnpm test:integration`,
  pełny `pnpm test:e2e:shards`.

### 6.3. Sonda

`probe:chapter` po PR 2 generuje agentem. Zmiany:

1. składa `lessonAgentDepsFromEnv(env, registry, usage)` z
   `@learning/server/lesson-agent` (tests/probes mogą ładować SDK);
   `LessonAgentUnavailable` to błąd sondy przed pierwszym wywołaniem;
2. wpis tymczasowy rejestru = budżet runu agenta (nie szacunek potoku);
3. strażnik hosta: agent i checker na stałym OpenRouter, grader przez
   `UMIEM_GRADER_BASE_URL`; dla szkoły pełne `UMIEM_GRADER_*` (`openCheck=on`)
   albo stop bez kosztu;
4. pętla jak worker: dopóki run jest `queued`, sonda czeka do `nextAttemptAt`
   i woła ponownie `executeLessonGeneration`, do limitu prób; liczba prób i
   suma oczekiwań w wynikach;
5. wiersze `[lesson-agent]` do pliku wyników (nie na konsolę);
6. koszt per operacja (`agent_plan`, `agent_objective`, `check_*`,
   `check_grade`, `lesson_objectives`); usunięcie `recordingLlm` dla puli i
   wątków potoku.

`probe:agent` (bez bazy) zostaje do szybkich prób.

### 6.4. Płatny przebieg kontrolny

- **Bramka zgody:** przed uruchomieniem wiadomość do właściciela: 4 przebiegi
  (Unit 3, Present Simple, geografia — materiały z 2026-11-03, ścieżki poza
  repozytorium i SHA-256 — oraz jedno „+N” na lekcji gramatyki z tego
  przebiegu), modele generatora, checkera i gradera, **nowy rejestr**
  (`UMIEM_PROBE_COSTS_INIT=1`, limit 3 USD), górny koszt przebiegu (budżet
  runu) i commit. Bez „tak” nic nie startuje. Każde ponowienie po porażce albo
  po poprawce kodu wymaga nowej zgody.
- **Sprawdzamy (bez ślepej oceny):** stan runu; liczba ćwiczeń per zagadnienie
  i etap; `generationGaps` i braki publikacji; koszt (`usage.cost`) i czas;
  histogram kodów odrzuceń i `checkCounters`; w rozdziale zagadnienia z `kind`;
  w szkole `openCheck=on` i niezerowe `openChecks`; „+N” dodaje ćwiczenia.
- **Porażka** (zatrzymuje PR do decyzji właściciela): run `failed`, wyjątek,
  `queued` po wyczerpaniu prób, zagadnienie bez ćwiczeń, koszt powyżej budżetu
  runu. Luki `generationGaps` i braki publikacji są raportowane, nie
  zatrzymują PR.
- **Wynik** (same liczby, bez treści) trafia do opisu PR 2 i do
  `docs/architecture.md` w miejsce „Etap 2a/2b: niezweryfikowane”. Dane
  przebiegu zostają poza repozytorium.
- Przebieg kontrolny wykonujemy na gałęzi PR 2 po zielonych testach, przed
  otwarciem PR.

## 7. Dokumentacja (PR 2)

- `docs/architecture.md`: §19.3 (agent zamiast partii), §19.15 (bez rund
  dogenerowania etapów), §19.17 (jedyny generator, brak listy, brak klucza,
  `agentPolicy` obowiązkowe, wynik przebiegu kontrolnego), wzmianka o
  `acceptFreshLessonPool` i o wyborze ścieżki.
- `docs/provider-config.md`: sekcja agenta bez listy i bez „powrotu do
  potoku”; brak klucza; tryb fake (checker bez wyniku); nowi domyślni odbiorcy;
  koszt; limit runu w znaczeniu agenta; konfiguracja OpenAI-direct traci
  lekcje.
- `.env.example`: bez `UMIEM_LESSON_AGENT_SUBJECTS`; opisy `UMIEM_LLM_*` bez
  „pul ćwiczeń lekcji” i bez „dotychczasowego potoku”; ścisły `json_schema`
  przy `UMIEM_LLM_PROVIDER_*`.
- `docs/deploy.md`: klucz OpenRouter wymagany do lekcji (web i worker), koszt,
  walidacja `UMIEM_LESSON_AGENT_*` przy starcie, wycofanie przez revert.
- `docs/SPEC.md` §29a.8, §29a.10 i sekcja rozdziału („dogenerowuje brakujące
  ćwiczenia”); `AGENTS.md` (punkty o agencie i `agentPolicy`, usunięcie
  „domyślnie wyłączony”, opis `FAKE_SLOW_MARKER` jako opóźnienia fake-agenta);
  `docs/folder-structure.md`.
- Komentarze kodu wspominające „pule ćwiczeń lekcji” przez `UMIEM_LLM` lub
  potok (`generation-env.ts`, `tests/e2e/global-setup.ts`,
  `tests/e2e/spec-projects.ts`, `fake-lesson-agent.ts`).
- Spece i plany etapów 1–2b zostają jako historia.

## 8. Ryzyka

- **Niepełne pule:** potok gwarantował minima etapów rundami dogenerowania;
  agent kończy z lukami (`generationGaps`) przy terminie lub budżecie. Rodzic
  widzi alert i „Dogeneruj”. Przebieg kontrolny pokaże skalę na trzech
  lekcjach.
- **Koszt i czas lekcji** rosną (§5.6).
- **Zależność od OpenRouter** (§1, §5.4); awaria OpenRouter zatrzymuje
  generowanie lekcji (ponowienia jak dziś).
- **Nadmierne kasowanie:** wspólne elementy z §4.1 łatwo wziąć za kod potoku;
  spec wymienia je jawnie, a testy promptu przenosimy, nie usuwamy.
- **Duża zmiana testów** (ok. 100–150 testów integracyjnych): lista
  obowiązkowa w §6.1 pilnuje, żeby nie zgubić zachowań.
- **Brak porównania jakości:** świadoma decyzja właściciela; jakość agenta
  oceniamy w użyciu.

## 9. Rozstrzygnięcia przeglądu wersji 2

- Krytyk A (PR 1): przeniesienie testu `withoutRunReports`, test zgodności
  starych danych, poprawka `themesService*`, poprawione uzasadnienie testów
  rundy, kolejność commitów, numeracja sekcji, strażnik limitu runu, martwy kod
  już w PR 1, dopiski w specach z 2026-11-02 — przyjęte. `lesson-json-request.ts`
  zostaje z `cache_control`.
- Krytyk B (PR 2): `objectivesRules`/`kind` zostają dla planisty (blokujące);
  checker fake `unavailable`; tryb fake zawsze dostępny; skutek dla
  konfiguracji OpenAI-direct zapisany w §1; kontrakt `LessonAgentUnavailable`
  i miejsce sprawdzenia; „Ponów” wyłączony; walidacja env przy starcie jako
  zmiana zachowania; uzupełnione listy martwego kodu i fixture'ów — przyjęte.
  Strażnik w API — odrzucony (poza zakresem, §1).
- Krytyk C (testy): wymagania generatora fake (unikalność, „+N”, kroki,
  opóźnienia, przerwanie snu, pamięć), lista obowiązkowa zachowań, sesja
  dziecka rozdziału przez zasiew szkicu, zmiany sondy, bramka zgody i definicja
  porażki, „+N” w przebiegu kontrolnym, brakujące specy E2E i fixture'y,
  dokumentacja, kosze; nazwa „płatny przebieg kontrolny” zamiast „test dymny”
  — przyjęte.
