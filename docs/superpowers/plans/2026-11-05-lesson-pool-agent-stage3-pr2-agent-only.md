# Etap 3 PR 2: agent jedynym generatorem lekcji — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Wersja 2 (po przeglądzie trzech krytyków planu i decyzji właściciela o powodach odrzuceń, 2026-11-05).

**Goal:** Pulę ćwiczeń lekcji generuje i dogenerowuje („Dogeneruj +N”) wyłącznie agent puli; potok, lista `UMIEM_LESSON_AGENT_SUBJECTS` i opcjonalność `agentPolicy` znikają; bez klucza OpenRouter worker (w konfiguracji bez innych zależności od OpenRouter) startuje, runy lekcji kończą się `lesson_agent_unavailable`, a panel to mówi.

**Architecture:** Kolejność trzyma każdy commit w stanie kompilującym się i zielonym: najpierw rzeczy nowe obok starych (obowiązkowa polityka, generator fake-agenta, konfiguracja bez listy, powody odrzuceń agenta), potem przeniesienie testów integracyjnych na agenta, dopiero potem usunięcie potoku i portu `generateLessonPool`. Panel, E2E, sonda, dokumentacja, pełna weryfikacja i na końcu płatny przebieg kontrolny. Reguły zostają tam, gdzie są: wybór i porażka runu w `materials/lessons/lesson-drafts.ts` (`executeLessonGeneration`), zapis runu agenta w `lesson-agent-generation.ts`, składanie w `providers/lesson-agent-env.ts` i kompozycjach, dostępność dla panelu w `lesson-api.ts`. Bez migracji, bez nowych zależności, bez zmian granic modułów i transakcji (`finalizeLessonPoolWrite`).

**Tech Stack:** TypeScript strict, Vitest (unit; integracja na Postgresie w kontenerze), Playwright, React/Mantine (panel rodzica), Zod, oRPC.

**Spec:** `docs/superpowers/specs/2026-11-05-lesson-pool-agent-stage3-design.md` (wersja 3), §1, §3–§8. Załącznik: `docs/superpowers/plans/2026-11-05-lesson-pool-agent-stage3-pr2-test-map.md` (klasyfikacja każdego testu integracyjnego; plan ma pierwszeństwo). Mapy kodu (stan 3b4c1ec0, numery linii przybliżone) i raporty krytyków w `C:\Users\looka\AppData\Local\Temp\claude\C--Users-looka-IdeaProjects-knowli--claude-worktrees-lesson-new-exercise-type-4e7d8f\072948fd-dbf4-49ca-8897-ff5ee18c371d\scratchpad\`: `pr2-map-code.md`, `pr2-map-fake-config.md`, `plan2-critic1.md`, `plan2-critic2.md`, `plan2-critic3.md`.

## Global Constraints

- Gałąź `feature/lesson-pool-agent-stage3-pr2-237` od `main` 3b4c1ec0. Nie wypychać do `main`, nie scalać PR. Push i PR tylko po zgodzie właściciela (Task 15).
- Nigdy `npm install`; tylko `corepack pnpm install --prefer-offline --frozen-lockfile`, i tylko gdy brak `node_modules`.
- Żadnych płatnych wywołań modeli poza Task 15, i tam wyłącznie po wyraźnym „tak” właściciela na konkretną wiadomość bramki (spec §6.4). Każde ponowienie wymaga nowej zgody. Nie uruchamiać `pnpm probe:*` w żadnym innym zadaniu (sondy wczytują `.env` worktree z kluczem).
- Bez migracji bazy. MCP (`integrations/`, `apps/web/src/integrations`) i `SKILL.md` bez zmian.
- Prywatność (spec §5.5, AGENTS.md): do generatora i checkera nigdy imię, rok urodzenia, identyfikatory ani odpowiedzi dziecka; dzienniki `[lesson-agent]` i `[config]` bez treści ćwiczeń i materiału; klucz tylko w adapterze.
- **Nie usuwać** (spec §4.1): `buildPoolInput` (bez parametrów potoku), `poolStageCounts`, `objectiveBatchCounts`, `minimumCountPerObjective`, `meetsStageMinimums`, `splitStages`, `listenChoiceAllowance`, `LISTEN_CHOICE_PER_OBJECTIVE`, `lessonSystemPrompt`, `lessonUserMaterial`, `lessonPoolJsonSchema`, `finalizeLessonPoolWrite`, `failLessonPoolValidation`, `generateDynamicObjectives`, `markLessonRun`, `lessonRunIsCurrent`, `orderedDraftExercises`, `mergeExamples`, `buildDynamicTopicData`, `withSubjectObjectiveKinds`, `sanitizeFreshLessonDraft`, `scopeFamiliesToRun`, `validatePool*`, hak `refineGeneratedPool`, `findExposureLeaks`, `isWellShapedRawExercise`, `toExerciseDraft`, `stripParentAddedFlags`, `sumRejectedReasons`, `splitByPoolExtra`, `ORPHAN_KEYWORDS_REASON`, `reasonCount`, `classifyLessonGenerationFailure`, `generationGaps`, `agent_checkpoint`, `withLessonGenerationControl` (`call`, `run`), `UMIEM_LESSON_GENERATION_*`, `UMIEM_LLM_*`, `FakeLlmProvider.generateLessonObjectives`/`generateLessonStory`/`objectiveRequests`/`storyRequests`, `fakeLessonObjectives` (bez `kind`), `prompts.objectivesRules` rozdziału, `LessonAgentPlanInput.objectivesRules`, `DynamicTopicData.objectives[].kind`.
- `withoutRunReports` (`version-ops.ts`) nadal usuwa `review` i `generationGaps`.
- Stałe teksty i identyfikatory (dokładnie):
  - kod błędu runu: `lesson_agent_unavailable`;
  - typ: `export type LessonAgentUnavailable = { readonly unavailable: "no_openrouter_key" };`
  - log startu workera bez klucza (dokładnie jedna linia, `console.log`): `[config] lesson-agent=unavailable reason=no_openrouter_key`;
  - komunikat (`messages.lessons.generationErrors.lesson_agent_unavailable`, także przy wyłączonych przyciskach): „Generowanie lekcji wymaga klucza OpenRouter w konfiguracji serwera. Po dodaniu klucza ponów generowanie.”;
  - pole katalogu: `lessonGenerationAvailable: boolean` (wymagane, w korzeniu `SubjectCatalogDto`).
- Wyszukiwanie: `git grep -nE "<wzorzec>" -- <ścieżki>` (pomija `apps/web/.next` i `*.tsbuildinfo`); dla wzorców z negacją `git grep -nP`.
- Po każdym zadaniu `pnpm typecheck` przechodzi (sześć projektów, w tym `tests/**` i `tests/probes`). Testy unit: `pnpm exec vitest run --config vitest.unit.config.ts <ścieżki>` (przy zmianach w `packages/server/src` uruchamiaj cały katalog — są tam testy architektoniczne); integracja `pnpm test:integration <plik>`; E2E do iteracji `UMIEM_E2E_WEB_MODE=dev pnpm exec playwright test --project=<mocked|real> <spec>`.
- Asercje „bez odrzuceń” na ścieżce agenta sprawdzają `rejectionCodes` z `generation_runs.agent_checkpoint` (podsumowanie po zapisie, pełny postęp po porażce walidacji), nie `rejectedCount` — ten liczy tylko usunięcia po przyjęciu. `rejectionCodes` kumulują się w obrębie runu (także po „Ponów”).
- Commity po polsku z `(#237)` w tytule, zakończone `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Kod po angielsku, komentarze i dokumentacja po polsku; gęstość komentarzy jak w otaczającym kodzie.

## Rozstrzygnięcia planu

1. **Indeks i liczba ćwiczeń zagadnienia w wejściu podagenta.** Do `LessonObjectiveAgentInput.objective` dochodzą `index: number` (pozycja w kolejności lekcji, od 0; liczba zagadnień = `otherObjectives.length + 1`) i `existingCount: number` (ćwiczenia zagadnienia już w stanie runu: szkic przy „+N” i przyjęte z punktu kontrolnego). Adapter modelu ich nie wysyła. Kolizje numerów fake'a przy „+N” po usunięciach rodzica są możliwe — naprawia je pętla kroków kosztem jednego kroku.
2. **Generator fake w `providers/fake-lesson-pool.ts`** (czyste funkcje), z którego korzysta fake-agent; do Task 10 używa go też `FakeLlmProvider.generateLessonPool` (z dotychczasową numeracją od `existingExercises.length` i deduplikacją przez `existingAnswers`). Odstępstwo plikowe od spec §5.2 („do `fake-lesson-agent.ts`”) dopisujemy w specu (Task 13).
3. **Generator rozdziału zna zagadnienie** (krytycy 1 i 3, B1): słowa i ramy z kart zagadnienia (`input.objective.cards`, te same `parseMaterialLexicon`/`frameKey` co polityka rozdziału), co najmniej jedno ćwiczenie każdej grupy `targets.requiredTypes` (`lesson_match`, `lesson_cloze`/`lesson_group`, `lesson_order`, `lesson_listen_choice`), każde słowo kart użyte przynajmniej raz, w zagadnieniu ramy zdania zawierające ramę. Na materiale bez sekcji „Słowa:”/„Zwroty:” (puste pokrycie) — słowa materiału jak dziś, numeracja tłumaczeń przeplatana po zagadnieniach (`i = k * objectiveCount + index`). Dzięki temu spec §5.2 („publikowalna pula bez `generationGaps` dla rozdziału”) zostaje bez zmian.
4. **`GenerationDeps.lessonAgent` w typie opcjonalne** (`LessonAgentDeps | LessonAgentUnavailable | undefined`), bo `GenerationDeps` składają web i fabryki testowe; „wymagane w workerze” pilnuje test kompozycji, a `executeLessonGeneration` traktuje `undefined` jak `LessonAgentUnavailable`.
5. **Powody odrzuceń (decyzja właściciela 2026-11-05):** agent zapisuje do szkicu `rejectedReasons` — liczby odrzuceń według kodu, z polskimi etykietami z `messages.lessons.agentRejectionReasons` (kody bez etykiety sumowane pod `messages.lessons.agentRejectionOther`), bez treści ćwiczeń i bez słów. Zapis przy sukcesie i przy porażce walidacji; wartości z kumulowanych `rejectionCodes` runu. `rejectedCount` bez zmian znaczenia. Panel („Powody odrzuceń przy generowaniu”) działa bez zmian.
6. **`fixtureSubject` w `lesson-agent-outcome.test.ts` już ma politykę** — spec §4.3 się myli. Wspólna polityka testowa trafia tylko do `historyLikeSubject`; `withAgentPolicy` zostaje per przedmiot (`blindSolveTypes` = typy przedmiotu).
7. **`asAgentCapable` i `AgentCapableSubject` znikają** (12 plików, w tym `tests/probes/agent-generation.probe.test.ts`) — zastąpione `SubjectModule`.
8. **Fake-agent: `record` domyślnie `true`**, `lessonAgentDepsFromEnv` w trybie fake przekazuje `record: false` i `stepCostUsd: 0` (inaczej szacunek 0,02 USD na krok zużywa budżet runu).
9. **`lesson-chapter.test.ts:453` — DELETE**: w „+N” przykłady są zawsze ustalone (`lesson-agent-outcome.ts:172`). Z tego samego powodu z 558 znika asercja „nowe przykłady zastępują stare”.
10. **Kolejność po claimie:** nieznany przedmiot → `failed`/`validation`; potem brak agenta → `failed`/`lesson_agent_unavailable`. Run historyjki rozpoznawany przed claimem (bez zmian).
11. **Worker bez klucza startuje tylko w konfiguracji bez innych zależności od OpenRouter** (LLM i TTS na OpenAI-direct, spec §1). Przy domyślnych adresach brak klucza nadal zatrzymuje start na `UMIEM_LLM_BASE_URL`/`UMIEM_TTS_BASE_URL` — tak testujemy i tak opisujemy w `deploy.md`.
12. **Web z kluczem w złym kształcie:** przy domyślnym graderze na OpenRouter web nie wstaje już dziś (`graderFromEnv`). Testujemy więc: `lessonAgentPublicFromEnv` nigdy nie rzuca, a web z `UMIEM_LESSON_AGENT_API_KEY=sk-proj-…` (czyta go tylko agent) się składa i podaje `lessonGenerationAvailable: false`.
13. **Formularz nowej lekcji przy `false`:** wyłączone także „Ponów wysyłkę” (`hasPending`) — polecenie utworzyłoby run skazany na porażkę.
14. **`deploy/compose.smoke.yaml`:** `web.environment.UMIEM_FAKE_PROVIDERS: "1"` (spec §5.2) i poprawiony komentarz o pustych kluczach.
15. **Martwe drobiazgi z PR 1** w Task 9: nieużywane identyfikatory zwracane z `applyLessonExercises`; w `english-chapter/prompts.ts` usuwamy tylko `export` przy `CHAPTER_FUNCTION_WORDS` (stała jest używana w pliku).
16. **`lesson-archive.spec.ts`** (spec §6.2) bez zmian — nie generuje lekcji (`tests/fixtures/lesson-world.ts`).

## Review Focus

1. **Run w kolejce sprzed wdrożenia z polami potoku** (`regenerate.existingAnswers`, `existingExercises`, `purpose`): agent wykonuje go w trybie add, dopisuje ≥ N ćwiczeń zagadnienia z `regenerate`, rewizje sprzed runu bez zmian — test w Task 9, Step 1.
2. **Worker bez klucza i stare runy w kolejce:** każdy run lekcji kończy się `failed`/`lesson_agent_unavailable` po claimie, nie zostaje w `running`, punkt kontrolny nietknięty; run historyjki z kolejki się wykonuje — testy w Task 9, Step 1.
3. **Klucz dodany po porażce:** ręczne „Ponów” runu `lesson_agent_unavailable` przy dostępnym agencie → `succeeded` — test w Task 9, Step 1.
4. **Klucz agenta w złym kształcie w web** (`UMIEM_LESSON_AGENT_API_KEY=sk-proj-…`): web się składa, katalog `lessonGenerationAvailable: false`; w workerze ten sam klucz zatrzymuje start z nazwą zmiennej — testy w Task 3, Step 1.
5. **„+N” na szkicu rozdziału sprzed agenta** (tytuły „Zagadnienie N: …”, zagadnienie `frame` jako drugie, pusty punkt kontrolny): agent bierze temat i `kind` ze szkicu — test w Task 8, Step 3.

---

### Task 1: `agentPolicy` obowiązkowe

**Files:**
- Create: `packages/server/src/domain/lessons/testing/test-agent-policy.ts`
- Modify: `domain/lessons/types.ts` (`agentPolicy` wymagane; doc „brak = nie jest generowany agentem” usunąć), `domain/lessons/registry.ts`, `domain/lessons/testing/history-like-subject.ts`, `domain/lessons/agent/capable.ts` (bez `asAgentCapable`, `AgentCapableSubject`; `agentObjectivesOf` zostaje), pliki z `git grep -nE "AgentCapableSubject|asAgentCapable" -- packages apps tests` (w tym `tests/probes/agent-generation.probe.test.ts`), miejsca `agentPolicy?.`/`agentPolicy === undefined` z `pr2-map-code.md` §3.4 (oprócz `lessonGeneratorFor` i `config.ts` — Task 3)
- Test: `registry.test.ts`, `agent/capable.test.ts` (test „bez polityki → throw” usunąć), `pool-validation.test.ts`, `catalog-validation.test.ts` (typ `Omit<…"agentPolicy">` uprościć), `lesson-pool-agent.test.ts:301` (przypadek „bez polityki” usunąć), `config.test.ts:295,413` (stuby `agentPolicy: undefined` i ich testy usunąć), `lesson-agent-outcome.test.ts:102-105` (test „potok dla przedmiotu bez polityki” usunąć)

**Interfaces:**
- Produces: `export const testAgentPolicy: SubjectAgentPolicy` — ślepe rozwiązanie i warianty dla typów `historyLikeSubject`, `hintJudgeTypes: []`, `openAnswerCheckTypes: []`, `checkerNeedsMaterial: false`, `independentReserve: 1`, `slack: 2`, `rejectionTexts` jak w `agent-test-subject.ts`. `historyLikeSubject.agentPolicy === testAgentPolicy`. `withAgentPolicy` i jego `defaultPolicy(subject)` bez zmian. `SubjectModule.agentPolicy: SubjectAgentPolicy`.

- [ ] **Step 1: Testy** w `registry.test.ts`: (czerwony) „przedmiot bez polityki agenta jest odrzucany” — `createSubjectRegistry([{ ...historyLikeSubject, agentPolicy: undefined } as unknown as SubjectModule])` rzuca `/agentPolicy/`; (czerwony) „historyLikeSubject ma wspólną politykę testową” — `toBe(testAgentPolicy)`; (strażnik, zielony od razu) „każdy przedmiot produkcyjny ma politykę”.
- [ ] **Step 2: Uruchom** `registry.test.ts` — dwa pierwsze FAIL.
- [ ] **Step 3: Zaimplementuj** (komunikat walidacji zawiera `agentPolicy` i id przedmiotu).
- [ ] **Step 4: Uruchom** `pnpm typecheck`, unit `packages/server/src`, `pnpm test:integration tests/integration/child-interests.test.ts` — PASS.
- [ ] **Step 5: Commit** „Przedmioty lekcji: polityka agenta obowiązkowa (#237)”.

### Task 2: Generator fake-agenta

**Files:**
- Create: `packages/server/src/providers/fake-lesson-pool.ts`, `packages/server/src/providers/fake-lesson-pool.test.ts`
- Modify: `providers/fake.ts` (funkcje generatora z `pr2-map-fake-config.md` §1.5 przenoszone; `generateLessonPool` korzysta z nich z numeracją od `existingExercises.length` i deduplikacją `existingAnswers` jak dziś), `providers/fake-lesson-agent.ts`, `ports/ai.ts` (`objective.index`, `objective.existingCount`), `modules/materials/lessons/lesson-pool-agent-input.ts`, `packages/server/src/index.ts` (eksport stałych z nowego miejsca)
- Test: `fake-lesson-agent.test.ts`, `lesson-pool-agent-input.test.ts`, `openai/lesson-pool-agent.test.ts`

**Interfaces:**
- Produces (`fake-lesson-pool.ts`):
  - `fakeObjectiveExercises(input: LessonObjectiveAgentInput, offset: number, counts?: Partial<Record<"guided" | "productive" | "independent", number>>): { exercises: unknown[]; examples?: string[] }` — surowe rekordy po `materializeGeneratedCalculations`, tylko dla `input.objective` (z jego `id`); przykłady pominięte przy `examplesFromPlan`. Gramatyka i szkoła jak dziś (wyjaśnienia `FAKE_EXPLANATION` przy `pool.exerciseExplanations`, `voiceTone: "curious"` przy `pool.voiceTones`, `targets.listenAllowance` ćwiczeń `lesson_listen_choice` z opcjami a/b, open answer z poleceniem „Przetłumacz…”, przykłady `Example for <id>.`, pola szkoły z `schoolSubject.id` z importu — nie literał). Rozdział wg Rozstrzygnięcia 3.
  - stałe `FAKE_SLOW_MARKER`, `FAKE_SLOW_DELAY_MS`, `FAKE_EXPLANATION` (eksport stąd; `fake.ts` reeksportuje do Task 10).
- Produces (`fake-lesson-agent.ts`):
  - kroki `FakeAgentStep`: `{ generate: true }` (jedno zgłoszenie `fakeObjectiveExercises` z bieżącym przesunięciem) i `{ build: (input: LessonObjectiveAgentInput) => { exercises: unknown[]; examples?: unknown } }` (zgłoszenie zbudowane z wejścia w czasie kroku — potrzebne, bo id zagadnień szkoły i rozdziału zawierają `deckId`);
  - opcje `generate?: { delayMs?: number }` (zagadnienie bez skryptu dostaje pętlę generatora; planista bez `plans` używa `fakePlanFromCoverage`), `record?: boolean` (domyślnie `true`), `stepCostUsd` jak dziś; `fromLlm` zostaje do Task 10.
- Produces (port): `LessonObjectiveAgentInput.objective.index: number`, `.existingCount: number`.

Pętla generatora (spec §5.2 pkt 3–4):
- przesunięcie startowe: `index * 1000` w puli bez istniejących ćwiczeń; przy `existingCount > 0`: `index * 1000 + 500 + existingCount * 2`;
- krok 1: liczby z `pool.stageCounts`; po każdym `tools.submit` czyta wynik: `complete === true` → koniec; inaczej kolejny krok (`offset += 100`) z liczbami z `missing`: `"<stage>: a of b"` → `b - a` dla etapu; w „+N” `"new exercises: k of N"` → `N - k` rozłożone na etapy wymienione w `missing` (gdy żadnego — `independent`); `"needs at least one …"` → po jednym ćwiczeniu brakującego typu; do `input.maxSteps`;
- opóźnienie każdego kroku `delayMs`; pierwszy krok zagadnienia, gdy `pool.material` zawiera `FAKE_SLOW_MARKER`: `max(delayMs, FAKE_SLOW_DELAY_MS)`; sen to `setTimeout` w wyścigu z `rejectOnAbort(signal)`, timer czyszczony po abort.

- [ ] **Step 1: Testy (czerwone):**
  - `fake-lesson-pool.test.ts` „trzy zagadnienia gramatyki nie ujawniają sobie rozwiązań”: połączona pula trzech wejść (`index` 0/1/2, `present_simple`) przechodzi `findExposureLeaks` bez ujawnień, a zbiory znormalizowanych odpowiedzi samodzielnych są rozłączne; to samo dla szkoły;
  - „rozdział `words` i `frame` na materiale ze Słowa:/Zwroty:” (stała `CHAPTER_MATERIAL` z `tests/integration/lesson-agent-generation.test.ts:283`): wynik każdego zagadnienia przechodzi `precheckBatch` z polityką rozdziału bez odrzuceń, zawiera typ z każdej grupy `targets.requiredTypes`, a status (`objectiveStatus`) jest `complete`;
  - „rozdział na małym materiale (`WEAR_MATERIAL`, `CARD_MATERIAL` z `lesson-chapter.test.ts`) — tłumaczenia trzech zagadnień rozłączne”;
  - „+N: przesunięcie rozłączne z pierwszą pulą” — jawne `counts` 8/8/4 i `existingCount: 20` vs pula z `existingCount: 0`: rozłączne odpowiedzi;
  - `fake-lesson-agent.test.ts`: „pętla: kolejny krok tylko dla braku” — narzędzie zwraca `{ complete: false, missing: ["independent: 0 of 3"] }`, potem `complete: true` → dwa zgłoszenia, drugie ma 3 ćwiczenia samodzielne i żadnych innych etapów; „+N: `new exercises: 2 of 12` + `independent: 1 of 3`” → drugi krok zamawia 10 z etapu samodzielnego; przy stale `complete: false` kroków = `maxSteps`;
  - „krok `build` dostaje wejście podagenta” (id zagadnienia z wejścia);
  - „FAKE_SLOW_MARKER opóźnia tylko pierwszy krok” (`vi.useFakeTimers`, `advanceTimersByTimeAsync`); „abort przerywa sen” — odrzucenie i `vi.getTimerCount() === 0`;
  - „record: false nie zapisuje historii”; „planista bez plans przy generate daje plan z pokrycia”;
  - `lesson-pool-agent-input.test.ts`: `index` = pozycja w kolejności lekcji, `existingCount` = ćwiczenia zagadnienia w `fixed` + przyjęte;
  - `openai/lesson-pool-agent.test.ts`: prompt podagenta nie zawiera `index` ani `existingCount`.
- [ ] **Step 2: Uruchom** — FAIL.
- [ ] **Step 3: Zaimplementuj.**
- [ ] **Step 4: Uruchom** `pnpm typecheck` i unit `packages/server/src` (cały, z `domain/lessons/architecture.test.ts`) — PASS.
- [ ] **Step 5: Commit** „Fake agenta puli: generator ćwiczeń z pętlą kroków i opóźnieniami (#237)”.

### Task 3: Konfiguracja bez listy przedmiotów; worker bez klucza OpenRouter

**Files:**
- Modify: `packages/server/src/config.ts` (usunąć `agentSubjectIds`, `lessonAgentSubjectsFromEnv`, `subjects` z `LessonAgentDeps`/`LessonAgentSettings`/`LessonAgentPublic`; dodać `LessonAgentUnavailable`, `isLessonAgentAvailable`; `GenerationDeps.lessonAgent?: LessonAgentDeps | LessonAgentUnavailable`), `config-defaults.ts` (bez `UMIEM_LESSON_AGENT_SUBJECTS`), `providers/lesson-agent-env.ts`, `providers/generation-env.ts` (wspólne parsowanie opóźnień fake, jeśli potrzebne), `packages/server/src/index.ts` (eksport `LessonAgentUnavailable`, `isLessonAgentAvailable`), `apps/worker/src/composition.ts`, `apps/web/src/composition.ts`, `modules/materials/lessons/lesson-agent-outcome.ts` (`lessonGeneratorFor`), `modules/materials/lessons/lesson-agent-generation.ts` (zawężenie przez `isLessonAgentAvailable`; rzut `internal` zostaje do Task 9), `modules/materials/lessons/lesson-api.ts`, `packages/contracts/src/lessons.ts`, `.env.example` (linie listy), fixture'y katalogu w testach web (`new-lesson-form.test.tsx`, `sources-panel.test.tsx`, `lesson-service-info.test.ts`) i w E2E `mocked` (`parent-lessons-layout`, `parent-lesson-editor-layout`, `parent-sources-layout`, `parent-source-vocabulary-layout`, `parent-deck-editor-layout`, `parent-lesson-voice-tone`) — dopisać `lessonGenerationAvailable: true`
- Test: `config.test.ts`, `lesson-agent-env.test.ts`, `apps/worker/src/composition.test.ts`, `apps/web/src/composition.test.ts`, `lesson-api.test.ts`, `lesson-agent-outcome.test.ts`, `packages/contracts/src/lessons.test.ts`, `apps/web/src/orpc/parent-router.test.ts`, `tests/integration/lesson-parent-api.test.ts`, `tests/integration/lesson-agent-generation.test.ts` (`agentWorld` bez `subjects`; testy listy)

**Interfaces:**
- Consumes: `FakeLessonPoolAgent({ generate, record, stepCostUsd })` z Task 2.
- Produces:
  - `lessonAgentDepsFromEnv(env: Record<string, string | undefined>, usage?: UsageRecorder): LessonAgentDeps | LessonAgentUnavailable` — fake: `{ agent: new FakeLessonPoolAgent({ generate: { delayMs }, record: false, stepCostUsd: 0 }), checker: new FakeExerciseChecker({ unavailable: true }), policy }`, `delayMs = Number(UMIEM_FAKE_LESSON_DELAY_MS ?? UMIEM_FAKE_DELAY_MS ?? 0)` (NaN → 0), bez gradera; poza fake: brak klucza → `{ unavailable: "no_openrouter_key" }` (bez logu), klucz w złym kształcie → wyjątek z nazwą zmiennej.
  - `lessonAgentSettingsFromEnv(env): LessonAgentSettings | undefined` — walidacja modeli, wysiłku, routingu, rodziny i liczb zawsze, przed kluczem; `undefined` tylko przy braku klucza; `console.warn` znika.
  - `lessonAgentPublicFromEnv(env): LessonAgentPublic | undefined` — fake → etykiety fake; inaczej `undefined`, gdy klucza nie ma albo `lessonAgentKeyFromEnv` rzuca; nigdy nie rzuca.
  - `isLessonAgentAvailable(agent: GenerationDeps["lessonAgent"]): agent is LessonAgentDeps`.
  - `lessonGeneratorFor(agent: GenerationDeps["lessonAgent"]): "agent" | "pipeline"` — „pipeline” tylko bez agenta (stan przejściowy, znika w Task 9).
  - Katalog: `lessonGenerationAvailable = services.lessonAgentPublic !== undefined`; usługi agenta (`generationServices`, `checkService`, `checkServiceIncludesMaterial`, `openCheckService`) tylko przy `true`, dla każdego przedmiotu. Korzeniowe `generationService` (`UMIEM_LLM_*`) zostaje: zagadnienia szkoły, historyjka gramatyki (w `generationServices` przedmiotu jak dziś) i awaryjny adresat tematów zdań.
  - Worker: `buildWorkerServices` zawsze ustawia `generation.lessonAgent`; przy `LessonAgentUnavailable` jeden `console.log` z linią z Global Constraints.

- [ ] **Step 1: Testy (czerwone):**
  - `config.test.ts`: `UMIEM_LESSON_AGENT_MAX_STEPS=abc` rzuca z nazwą zmiennej także bez klucza; `UMIEM_LESSON_AGENT_SUBJECTS=english_grammar` nie zmienia wyniku; brak klucza → `undefined`; `lessonAgentPublicFromEnv({ OPENROUTER_API_KEY: "sk-proj-abc" })` → `undefined` bez wyjątku; fake bez klucza → etykiety fake. Testy listy usunąć.
  - `lesson-agent-env.test.ts`: bez klucza → `{ unavailable: "no_openrouter_key" }`; fake bez klucza → przebieg na lekcji testowej daje `calls.length === 0` (record false) i zero kosztu w punkcie kontrolnym; opóźnienie z `UMIEM_FAKE_LESSON_DELAY_MS` sprawdzone fałszywym zegarem; z kluczem → adaptery AI SDK; grader 2b jak dziś.
  - `apps/worker/src/composition.test.ts` (env OpenAI-direct z `docs/provider-config.md`: `UMIEM_LLM_BASE_URL=https://api.openai.com/v1`, `UMIEM_LLM_MODEL`, `UMIEM_TTS_PROVIDER=openai`, `UMIEM_TTS_BASE_URL=https://api.openai.com/v1`, model/głos/format TTS OpenAI, `OPENAI_API_KEY`, `OPENROUTER_API_KEY=""`): (a) z `UMIEM_LESSON_AGENT_API_KEY=sk-or-test` → `LessonAgentDeps`; (b) bez klucza → worker się składa, `lessonAgent` równe `{ unavailable: "no_openrouter_key" }`, `console.log` dokładnie raz z linią z Global Constraints; (c) fake bez klucza → `LessonAgentDeps`, brak linii `[config]`; (d) `UMIEM_LESSON_AGENT_API_KEY=sk-proj-x` → `buildWorkerServices` rzuca z nazwą zmiennej.
  - `apps/web/src/composition.test.ts`: fake bez klucza → `lessonAgentPublic` zdefiniowane; z `UMIEM_LESSON_AGENT_API_KEY=sk-proj-x` (reszta poprawna) → web się składa, `lessonAgentPublic` `undefined`; `UMIEM_LESSON_AGENT_MAX_STEPS=abc` przy poprawnym kluczu nie zatrzymuje web.
  - `lesson-api.test.ts`: bez `lessonAgentPublic` → `false`, przedmioty bez usług agenta; z nim → `true` i usługi dla każdego przedmiotu.
  - `lessons.test.ts`: katalog bez `lessonGenerationAvailable` odrzucony; pole dopisane w istniejących `parse`.
- [ ] **Step 2: Uruchom** — FAIL.
- [ ] **Step 3: Zaimplementuj.** `executeLessonGeneration` wybiera agenta przez `lessonGeneratorFor(deps.lessonAgent)`. W `lesson-agent-generation.test.ts`: `agentWorld` bez `subjects` (parametr usunąć z wywołań); testy „przedmiot spoza listy → potok” (629, 662) usunąć; 676, 688, 705 przenieść na agenta (676: nowy szkic bez klucza `review`; 688: stary `review` → `succeeded`, klucz zostaje, DTO bez `review`; 705: `attempts > MAX` → `attempts_exhausted`, `agent.calls` puste).
- [ ] **Step 4: Uruchom** `pnpm typecheck`, unit z Files, `pnpm test:integration tests/integration/lesson-agent-generation.test.ts tests/integration/lesson-parent-api.test.ts`, E2E `mocked` z Files — PASS.
- [ ] **Step 5: Commit** „Agent puli: bez listy przedmiotów, worker bez klucza OpenRouter startuje (#237)”.

### Task 4: Powody odrzuceń agenta w szkicu

**Files:**
- Modify: `packages/contracts/src/messages.ts` (`lessons.agentRejectionReasons: Record<string, string>`, `lessons.agentRejectionOther`), `modules/materials/lessons/lesson-agent-outcome.ts` (czysta funkcja), `modules/materials/lessons/lesson-agent-generation.ts` (dwa miejsca `rejectedReasons: {}`)
- Test: `lesson-agent-outcome.test.ts`, `tests/integration/lesson-agent-generation.test.ts`

**Interfaces:**
- Produces: `agentRejectedReasons(codes: Readonly<Record<string, number>>): Record<string, number>` — klucze to polskie etykiety; kody bez etykiety sumowane pod `agentRejectionOther`; zerowe pomijane. Etykiety dla kodów zwracanych przez `admission.ts`, `lesson-pool-agent-tools.ts`, kontrole 2b (`lesson-agent-check-run.ts`) i bramki `exerciseGate` trzech przedmiotów (zbierz `git grep -nE "code: \"" -- packages/server/src/domain/lessons packages/server/src/modules/materials/lessons`), np. `limit_full` „za dużo ćwiczeń w etapie”, `limit_listen` „za dużo ćwiczeń słuchowych”, `leak_victim` „rozwiązanie widoczne wcześniej”, `card_word_missing` „brak słowa z kart zagadnienia”, `frame_missing` „brak zwrotu zagadnienia”, `shape_malformed` „zły format ćwiczenia”, `blind_mismatch` „drugi model rozwiązał inaczej”, `duplicate` „powtórzone ćwiczenie”. Bez treści ćwiczeń i słów.

- [ ] **Step 1: Testy (czerwone):** unit — mapowanie znanych kodów, suma nieznanych pod „inne”, pomijanie zer, brak kluczy-kodów w wyniku; integracja — (a) rozdział ze skryptem, w którym 2 z 6 ćwiczeń mają słowo spoza kart: `draft.rejectedReasons` zawiera etykietę `card_word_missing` z wartością 2 i nie zawiera słowa; (b) pełne odrzucenie → `failed`/`validation`, szkic ma `rejectedReasons` z etykietą; (c) „Ponów” po porażce sumuje kody obu prób.
- [ ] **Step 2: Uruchom** — FAIL.
- [ ] **Step 3: Zaimplementuj** (wartości z kumulowanych `rejectionCodes` postępu runu).
- [ ] **Step 4: Uruchom** — PASS; `pnpm typecheck`.
- [ ] **Step 5: Commit** „Agent puli: powody odrzuceń w szkicu dla rodzica (#237)”.

### Task 5: Fake'i integracyjne z agentem; `lesson-agent-generation.test.ts` bez `fromLlm`

**Files:**
- Modify: `tests/integration/fakes.ts`, `tests/integration/lesson-agent-generation.test.ts`

**Interfaces:**
- Produces: `fakeGeneration(options?: { withAgent?: boolean; agent?: FakeLessonPoolAgentOptions; checker?: FakeExerciseChecker; policy?: Partial<LessonAgentPolicy> }): Promise<FakeGeneration & { agent: FakeLessonPoolAgent }>` — przy `withAgent: true` `deps.lessonAgent = { agent: new FakeLessonPoolAgent({ generate: {}, ...options.agent }), checker: options.checker ?? new FakeExerciseChecker({ unavailable: true }), policy: options.policy ?? {} }`; bez niej `lessonAgent` nieustawione (pliki nieprzeniesione idą potokiem). Opcję `withAgent` usuwa Task 8.

- [ ] **Step 1:** `agentWorld` z `generate: {}` zamiast `fromLlm`; kroki `llmStep(fakes.llm)` → `{ generate: true }`; wrappery `oneFamily`, `addGenerator`, `openPool` → kroki `{ build: (input) => … }` korzystające z `fakeObjectiveExercises(input, offset, counts)`; `AgentScript` bez wariantu funkcji od `fakes`; `fakes.llm.lessonRequests` → `agent.calls`. Wypisz w raporcie testy zależne od liczby kroków lub kosztu (m.in. `:995`, `:1023`, `:1262`, `:1290`, `:1306`, `:857`) i potwierdź, że po zamianie przechodzą bez osłabiania asercji (pętla generatora może dodać kroki — wtedy skrypt `{ generate: true }` zamiast pętli albo `maxSteps` w polityce testu).
- [ ] **Step 2:** `fakes.ts` jak w Interfaces.
- [ ] **Step 3: Uruchom** `pnpm test:integration tests/integration/lesson-agent-generation.test.ts`, potem `pnpm test:integration` — PASS.
- [ ] **Step 4: Commit** „Testy agenta puli bez fake'a LLM potoku (#237)”.

### Task 6: `lesson-generation.test.ts` na ścieżce agenta

**Files:** Modify `tests/integration/lesson-generation.test.ts`.

**Interfaces:** Consumes `fakeGeneration({ withAgent: true, agent: … })`, kroki `submit`/`build`/`generate`, `withAgentPolicy`, `agentRejectedReasons` (Task 4).

- [ ] **Step 1:** Wg załącznika §1 z poprawkami:
  - **DELETE**: 324, 430, 726, 745, 786, 1017, 1711, blok 1755–2046, `describe FakeLlmProvider.generateLessonPool` (2062), helpery `MAIN_BATCH_ONLY`, `hangLessonRequests`, import `routeLessonRound`;
  - **KEEP**: 135, 172, 184, 696, 948, 979, 1119;
  - **PORT**: pozostałe. Asercje „bez odrzuceń” (252, 281, 1739) → `rejectionCodes` bez wymienionych kodów (`limit_listen`, `leak_*`, `duplicate`); wadliwe wejście (537, 596, 635, 1355) → oczekiwany kod w `rejectionCodes` i etykieta w `draft.rejectedReasons`; 823 (strict-schema z `null`) — skrypt `submit` z polami `null` przechodzi przez `submit` narzędzia: wskaż w raporcie, gdzie zdejmowane są nulle (`isWellShapedRawExercise`/`toExerciseDraft`/adapter), a gdy w adapterze AI SDK — dopisz unit adaptera; asercje logów potoku usuń; testy szkoły i rozdziału z id zawierającym `deckId` przez `build`.
- [ ] **Step 2: Uruchom** `pnpm test:integration tests/integration/lesson-generation.test.ts` — PASS; `git grep -nE "lessonRequests|queueLesson|MAIN_BATCH_ONLY|routeLessonRound|generateLessonPool" -- tests/integration/lesson-generation.test.ts` — pusto.
- [ ] **Step 3: Commit** „Testy generowania lekcji na ścieżce agenta (#237)”.

### Task 7: Rozdział na ścieżce agenta

**Files:**
- Modify: `tests/integration/lesson-chapter.test.ts`, `tests/integration/lesson-chapter-sentence-audio.test.ts`
- Create: `tests/integration/chapter-lesson-helpers.ts`

**Interfaces:**
- Produces: `seedChapterDraft(services: Services, args: { material: string; objectives: { slug: string; titlePl: string; kind: "words" | "frame"; cards: { title: string; body: string }[]; exercises: (deckId: string, objectiveId: string) => unknown[] }[]; examples?: Record<string, string[]> }): Promise<{ deckId: string; versionId: string; objectiveIds: string[] }>` — `createLessonFromMaterial`, temat dynamiczny i ćwiczenia przez `editLessonDraft` (ścieżka produkcyjna: `target_key`, umiejętności), bez generacji.

- [ ] **Step 1:** Wg załącznika §2 z poprawkami: DELETE 409, 453, 593, część „+N bez rundy” z 627; KEEP 691, 734, 749, część edycji z 627; 708 i 118 — rodzaje podane przez `plans` z mieszanymi `kind` (np. `["frame","words","frame"]`): 708 po usunięciu pierwszego zagadnienia oczekuje `["words","frame"]`; PORT pozostałe — skrypty lub `plans` dla **wszystkich** zagadnień (nie tylko `part_1`), żeby wynik nie zależał od równoległości; 163/231 z etykietami w `draft.rejectedReasons` (Task 4); 492 dodatkowo „+N dostaje rozwiązania całego szkicu” (`calls.find(c => c.objectiveId === first)` w runie +N, `pool.avoidSentences` zawiera tłumaczenia ze szkicu); 558 bez asercji o zastąpieniu przykładów; 118/683 bez `rejectedCount === 0` — `rejectionCodes` i `coverage === []`; blok sesji dziecka (780–1084) przez `seedChapterDraft`. `lesson-chapter-sentence-audio`: szkic przez `seedChapterDraft`.
- [ ] **Step 2: Uruchom** oba pliki — PASS.
- [ ] **Step 3: Commit** „Testy rozdziału na agencie; szkic rozdziału z zasiewu (#237)”.

### Task 8: Pozostałe pliki integracyjne i agent domyślny

**Files:** `tests/integration/fakes.ts` (agent zawsze; bez `withAgent`, `routeLessonRound`, `LessonPoolRequest`), `lesson-story.test.ts`, `child-interests.test.ts`, `lesson-listen-choice.test.ts`, `source-materials.test.ts`, `lesson-parent-api.test.ts`, `lesson-error-explanation.test.ts`, `lesson-story-audio.test.ts`, `publish-media-reconcile.test.ts`, `grammar-without-tts.test.ts`, `lesson-sentence-audio.test.ts`, `provider-usage-scope.test.ts`, `generation.test.ts`, `lesson-agent-generation.test.ts`, `lesson-chapter.test.ts`

- [ ] **Step 1:** `fakes.ts`: agent domyślny (`generate: {}`), uchwyt `fakes.agent`.
- [ ] **Step 2:** Pliki wg załącznika §4. Ustalenia: `grammar-without-tts` — `assets.length === draft.exercises.length` i 2 słuchowe zamiast stałego 22; `lesson-listen-choice` — skrypt z 5 słuchowymi → w szkicu najwyżej `listenAllowance`, `limit_listen` w `rejectionCodes`; `provider-usage-scope` — `fakeGeneration({ agent: { generate: {}, usage: recorder } })`, koszt runu lekcji z operacją `agent_objective`; `generation.test.ts` — szpieg na `fakes.agent.runObjective`; `child-interests` — `agent.calls[*].input.pool.interests` i `JSON.stringify(agent.calls.map(c => c.input))` bez imienia, roku i id; `lesson-story` — błąd `configuration` krokiem `{ throw: new GenerationProviderError("configuration") }`, kolizja z historyjką krokiem `build`.
- [ ] **Step 3: Test (Review Focus 5)** w `lesson-chapter.test.ts`: `seedChapterDraft` z tytułami „Zagadnienie 1: Ubrania” (`words`) i „Zagadnienie 2: Co mam na sobie” (`frame`), bez `agent_checkpoint`; `regenerateObjective(count: 4)` dla drugiego; `executeLessonGeneration` → `succeeded`, ćwiczeń drugiego zagadnienia przybywa ≥ 4, `agent.calls[0].input.objective.kind === "frame"`, `dynamicTopic` szkicu bez zmian.
- [ ] **Step 4: Test „tryb fake z env” (spec §5.2)** w `lesson-agent-generation.test.ts`: `lessonAgent: lessonAgentDepsFromEnv({ UMIEM_FAKE_PROVIDERS: "1" })`; (a) gramatyka `present_simple`, trzy zagadnienia, pula 60; (b) rozdział na `CHAPTER_BODY` z `tests/e2e/parent-sources.spec.ts` (kopia stałej), pula 40; (c) szkoła na `SCHOOL_MATERIAL`; (d) „+6” na pierwszym zagadnieniu gramatyki; (e) rozdział na `CHAPTER_MATERIAL` ze „Słowa:”/„Zwroty:” → rodzaje `["words","words","frame"]`. W każdym: `succeeded`, brak `generationGaps`, każde zagadnienie `complete` w podsumowaniu punktu kontrolnego, `rejectionCodes` bez `duplicate` i `leak_*`, `publishLessonDraft` przechodzi; w (d) przybywa ≥ 6 ćwiczeń. Bliźniaczy przypadek z `new FakeLessonPoolAgent({ generate: {} })` (z historią): w gramatyce i szkole `calls.every(c => c.outcomes.length === 1)`.
- [ ] **Step 5: Uruchom** `pnpm test:integration` — PASS; `git grep -nP "lessonRequests|queueLesson|MAIN_BATCH_ONLY|routeLessonRound|stageTopUp|generateLessonPool|withAgent(?!Policy)" -- tests/integration` — pusto.
- [ ] **Step 6: Commit** „Testy integracyjne lekcji na agencie domyślnym (#237)”.

### Task 9: Usunięcie potoku; `lesson_agent_unavailable`

**Files:**
- Modify: `lesson-drafts.ts` (ciało potoku i symbole z spec §3 — lista z liniami w `pr2-map-code.md` §1.5; `regenerateObjective` bez `existingAnswersOf`/`existingExercisesOf`; `LessonRunInput.regenerate: { objectiveId: string; count: number }`; `finalizeLessonPoolWrite.onSuccessTransaction` wymagane; nagłówek pliku; martwe identyfikatory z `applyLessonExercises`), `lesson-agent-outcome.ts` (`lessonGeneratorFor` znika), `lesson-agent-generation.ts` (rzut `internal` znika), `lesson-pool-acceptance.ts` (`acceptFreshLessonPool`, `FreshPoolInput`, `FreshPoolResult`), `domain/lessons/exposure-leaks.ts` (`resolveGenerationLeaks`, `GenerationLeakResolution`), `domain/lessons/lesson-coverage.ts` (`stageDeficits`, `StageDeficits`), `lesson-generation-control.ts` (`callSoft`, parametr `soft`), `lesson-generation-policy.ts` (`stageTopUp`), `domain/lessons/subjects/english-chapter/prompts.ts` (`export` przy `CHAPTER_FUNCTION_WORDS`)
- Test: `tests/integration/lesson-agent-generation.test.ts` (`describe("brak agenta (#237 etap 3)")`), `lesson-drafts.test.ts` (testy usuniętych funkcji; przydział słuchowych przy istniejących ćwiczeniach → wprost `listenChoiceAllowance`), `lesson-pool-acceptance.test.ts`, `exposure-leaks.test.ts` (175–311), `lesson-coverage.test.ts` (177–216), `lesson-generation-control.test.ts` (44–73), `lesson-generation-policy.test.ts`, `lesson-agent-outcome.test.ts` (fixture `regenerate` bez `existingAnswers`)

**Interfaces:**
- Produces: `executeLessonGeneration` po claimie: `subject === undefined` → `failed`/`validation`; `!isLessonAgentAvailable(deps.lessonAgent)` → `markCurrentRun(…, "failed", "lesson_agent_unavailable", null)` bez odczytu punktu kontrolnego i wywołań modeli; inaczej `executeLessonAgentGeneration` (z `lessonRunIsCurrent` jak dziś).

- [ ] **Step 1: Testy (czerwone)** — usługi z `lessonAgent: { unavailable: "no_openrouter_key" }` i osobno `lessonAgent: undefined`:
  - pełna generacja gramatyki: `failed`, `errorCode === "lesson_agent_unavailable"`, `attempts === 1`, `next_attempt_at` NULL; `fakes.agent.calls`, `fakes.llm.objectiveRequests`, `fakes.llm.storyRequests` puste; szkic bez ćwiczeń, `editNumber` bez zmian; brak runów historyjki; uszkodzony `agent_checkpoint` ustawiony przed runem (`setCheckpoint`) zostaje bajt w bajt;
  - szkoła: zero `generateLessonObjectives`;
  - „+N”: `failed`/`lesson_agent_unavailable`, szkic i `editNumber` bez zmian;
  - run historyjki w kolejce → `succeeded`;
  - nieznany przedmiot → `failed`/`validation`;
  - „Ponów” po dodaniu klucza: `retryGeneration`, usługi z dostępnym fake-agentem → `succeeded` (Review Focus 3);
  - run z wejściem potoku (`regenerate: { objectiveId, count: 4, existingAnswers: ["x"], existingExercises: [{…}] }` i pełny z `purpose: "pool"`) w `generation_runs.input`: `succeeded`; przy „+N” `agent.calls[0].input.objective.id === objectiveId`, ćwiczeń zagadnienia +≥ 4, identyfikatory rewizji sprzed runu nadal w szkicu (Review Focus 1).
- [ ] **Step 2: Uruchom** — testy „brak agenta” FAIL.
- [ ] **Step 3: Usuń** potok i symbole; zaimplementuj sprawdzenie. `git grep -nE "stageTopUpRound|StageTopUpContext|batchesForObjectives|trimToStageDeficits|STAGE_TOP_UP|EXPOSURE_LEAK_REASON|withinStageQuotas|capListenChoiceOverflow|ObjectiveGenerationLimits|collectBatchExerciseMetadata|filterExercisesToRequestedObjective|summarizeLessonPoolValidation|refineGeneratedDrafts|existingAnswersOf|existingExercisesOf|uniqueStimuli|acceptFreshLessonPool|resolveGenerationLeaks|stageDeficits|callSoft|stageTopUp|lessonGeneratorFor" -- packages apps tests` — pusto.
- [ ] **Step 4: Uruchom** `pnpm typecheck`, unit `packages/server/src`, `pnpm test:integration` — PASS.
- [ ] **Step 5: Commit** „Lekcje: agent jedynym generatorem, potok usunięty; brak klucza → lesson_agent_unavailable (#237)”.

### Task 10: Port i adaptery bez `generateLessonPool`

**Files:**
- Modify: `ports/ai.ts` (`LlmProvider.generateLessonPool`; `LessonPoolInput.purpose|existingAnswers|existingExercises`; `LessonObjectivesInput.objectivesRules`), `providers/openai/llm.ts` (`generateLessonPool`, `lessonExamplesToRecord`, bloki istniejących odpowiedzi/ćwiczeń — zdanie „Within this response…” zostaje; `kind` w `lessonObjectivesJsonSchema`, zdania o `kind` i „Subject rules for objectives”), `providers/fake.ts` (`generateLessonPool`, `queueLesson`, `queueLessonTopUp`, `#lessonBehaviors`, `#lessonTopUpBehaviors`, `lessonRequests`, `LlmLessonBehavior`, `fakeInvalidExercise`, `kind` w `fakeLessonObjectives`, reeksporty), `providers/fake-lesson-agent.ts` (`fromLlm`), `lesson-drafts.ts` (`buildPoolInput` bez `existingAnswers`, `existingExercises`, `purpose`; `generateDynamicObjectives` bez `objectivesRules`), `lesson-pool-agent-input.ts`, `packages/server/src/index.ts`, `providers/usage-recording.architecture.test.ts` (liczba zapisów w `llm.ts`), `tests/probes/chapter-generation.probe.test.ts` (tylko kompilacja: bez wrappera `generateLessonPool`; do Task 12 sonda kończy się `lesson_agent_unavailable` — nieuruchamiana)
- Test: `openai/llm.test.ts` (testy treści promptu → `lessonSystemPrompt`/`lessonUserMaterial` bez utraty asercji, spec §4.2; testy `objectivesRules` → prompt zagadnień bez „Subject rules for objectives” i `kind`; tabela kosztów `:1067-1081` bez przypadku `generateLessonPool`), `fake.test.ts`, `lesson-calculations.test.ts` (materializacja przez `fakeObjectiveExercises` i adapter agenta), `fake-lesson-agent.test.ts` (sekcja `fromLlm` 634–790 → `generate`), `lesson-drafts.test.ts`

**Interfaces:** `buildPoolInput(subject, topic, objectiveId, count, material, instruction, graderAvailable, interests?: readonly string[], options: { avoidSentences?: readonly string[] } = {}): LessonPoolInput`.

- [ ] **Step 1:** Przenieś testy promptu i rachunków na nowe API przy żywej metodzie.
- [ ] **Step 2: Uruchom** przeniesione — PASS.
- [ ] **Step 3:** Usuń symbole. `git grep -nE "generateLessonPool|lessonExamplesToRecord|queueLesson|lessonRequests|LlmLessonBehavior|fromLlm|existingAnswers|existingExercises|objectivesRules" -- packages apps tests` — zostają tylko: `prompts.objectivesRules` rozdziału, `LessonAgentPlanInput.objectivesRules`, `withSubjectObjectiveKinds` z testami oraz test Review Focus 1 (Task 9) z wejściem starego runu; komentarze „jak generateLessonPool” w `openai/lesson-pool-agent.ts` przepisz.
- [ ] **Step 4: Uruchom** `pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration` — PASS.
- [ ] **Step 5: Commit** „Port LLM bez puli lekcji; testy promptu na lessonSystemPrompt (#237)”.

### Task 11: Panel rodzica — dostępność generowania

**Files:**
- Modify: `packages/contracts/src/messages.ts` (`generationErrors.lesson_agent_unavailable`; `themesService`/`themesServiceUnknown`), `NewLessonForm.tsx` (przy `catalog?.lessonGenerationAvailable === false`: `Alert` `data-testid="lesson-generation-unavailable"`, przycisk `lesson-create-submit` wyłączony także przy `hasPending` — warunek poza `!hasPending &&`), `LessonEditor.tsx` („Dogeneruj”: `regenDisabled` także przy `false`, komunikat przy `regen-open-*` i w modalu; `generation-retry` i `retry-stalled-generation` dla runów lekcji wyłączone z komunikatem `data-testid="generation-unavailable"`; runy historyjki bez zmian), `LessonSupervisionPanel.tsx` (`pool-regen-*` wyłączone), `SourcePage.tsx` (tworzenie lekcji ze źródła wyłączone z komunikatem), `lesson-service-info.ts`
- Test: `new-lesson-form.test.tsx`, `sources-panel.test.tsx`, test panelu nadzoru (istniejący plik testów komponentu; brak → przypadek w E2E), E2E `mocked`: `parent-lessons-layout.spec.ts`, `parent-lesson-editor-layout.spec.ts`, `parent-sources-layout.spec.ts`

**Interfaces:** tekst `themesService` (dokładnie): „Tematy zdań trafią do usługi: {service}. Z profilu wysyłamy tylko tematy — bez imienia i roku urodzenia. Drugi model sprawdzający ćwiczenia dostaje gotowe zdania, nie listę tematów. Zdania z tymi tematami może też zobaczyć usługa oceniająca odpowiedzi.”; `themesServiceUnknown` analogicznie z „do usługi generującej”.

- [ ] **Step 1: Testy (czerwone):** formularz przy `false` — alert, przycisk wyłączony (także z niewysłanym poleceniem); przy `true` — brak alertu; `sources-panel` — tworzenie ze źródła wyłączone; E2E `mocked`: „bez klucza formularz nowej lekcji pokazuje komunikat i nie pozwala wysłać”, „bez klucza „Dogeneruj”, „Dogeneruj ćwiczenia” w nadzorze i „Ponów generowanie” są wyłączone z komunikatem” (szkic z `generation.state: "failed"`, `errorCode: "lesson_agent_unavailable"` — `generation-failed` pokazuje komunikat), tematy zdań z nowym tekstem.
- [ ] **Step 2: Uruchom** — FAIL.
- [ ] **Step 3: Zaimplementuj.**
- [ ] **Step 4: Uruchom** testy web i E2E `mocked` z Files — PASS.
- [ ] **Step 5: Commit** „Panel rodzica: generowanie lekcji niedostępne bez klucza OpenRouter (#237)”.

### Task 12: E2E `real`, smoke i sonda

**Files:** `tests/e2e/lesson-parent.spec.ts`, `lesson-mock-test.spec.ts`, `lesson-real-flow.spec.ts`, `lesson-parent-supervision.spec.ts`, `parent-sources.spec.ts` (tylko asercje zależne od potoku, `pr2-map-fake-config.md` §4), `tests/e2e/global-setup.ts`, `tests/e2e/spec-projects.ts`, `tests/e2e/helpers/fake-hold.ts` (komentarze), `deploy/compose.smoke.yaml` (Rozstrzygnięcie 14), `tests/probes/chapter-generation.probe.test.ts`, `tests/probes/probe-preflight.ts` (nowy), `tests/probes/probe-preflight.test.ts` (nowy), `tests/probes/probe-costs.ts` (+ test)

**Interfaces (sonda, spec §6.3):**
- `probePreflight(env: Record<string, string | undefined>, options: { subject: "chapter" | "school" | "grammar"; addCount?: number }): { estimateUsd: number; hosts: string[] }` — czysta: `lessonAgentDepsFromEnv` → `unavailable` rzuca („brak klucza OpenRouter”); strażnik hostów: agent i checker na stałym `https://openrouter.ai`, `UMIEM_LLM_BASE_URL` (zagadnienia szkoły) i `UMIEM_GRADER_BASE_URL` przez `probeEndpointHost`; szkoła bez pełnego `UMIEM_GRADER_*` rzuca z nazwą brakującej zmiennej; `estimateUsd = runBudgetUsd × (addCount ? 2 : 1)`. Sonda woła ją przed rejestrem kosztów i przed wpisem tymczasowym.
- pętla: dopóki run `queued`, sonda czyta `generation_runs.next_attempt_at` zapytaniem, czeka i woła `executeLessonGeneration`, najwyżej `MAX_AUTOMATIC_ATTEMPTS` razy; w wynikach `attempts`, `waitedMs`;
- `UMIEM_PROBE_ADD_COUNT`: po `succeeded` osobny wpis tymczasowy rejestru (`assertWithinCostCap`), `regenerateObjective` dla pierwszego zagadnienia, raport `addedExercises`;
- linie `[lesson]` i `[lesson-agent]` do pliku wyników (`log`), nie na konsolę;
- koszt per operacja z `usage` i per run (`generation_run_id`): suma `agent_*`/`check_*` porównywana z budżetem runu, `lesson_objectives` osobno; `recordingLlm` dla puli i wątki potoku usunięte.

- [ ] **Step 1:** E2E `real`: dopasuj asercje do fake-agenta; uruchom każdy zmieniony spec (`--project=real`) — PASS.
- [ ] **Step 2:** `probe-preflight.test.ts` (bez sieci, bez `.env`): brak klucza → rzuca przed czymkolwiek; host spoza OpenRouter → rzuca; szkoła bez `UMIEM_GRADER_MODEL` → rzuca z nazwą; szacunek z „+N” = 2 × budżet. `probe-costs.test.ts` uzupełniony. **Nie uruchamiaj `pnpm probe:*`.**
- [ ] **Step 3:** `pnpm typecheck` — PASS.
- [ ] **Step 4: Commit** „E2E i sonda rozdziału na agencie puli (#237)”.

### Task 13: Dokumentacja

**Files i treść** (spec §7):
- `docs/architecture.md`: §19.3, §19.15, §19.17 (jedyny generator, brak listy, brak klucza i log, `agentPolicy` obowiązkowe, powody odrzuceń w szkicu), wzmianki o `acceptFreshLessonPool` i wyborze ścieżki, §23 (`lesson_pool` historyczna).
- `docs/provider-config.md`: sekcja agenta bez listy i „powrotu do potoku”; brak klucza; tryb fake (checker bez wyniku, koszt 0); nowi domyślni odbiorcy (spec §5.5); koszt; limit runu w znaczeniu agenta; konfiguracja OpenAI-direct traci lekcje.
- `docs/deploy.md`: klucz OpenRouter wymagany do lekcji w web i worker (ten sam klucz i te same `UMIEM_LESSON_AGENT_MODEL`/`CHECKER_MODEL` w obu serwisach — etykiety w panelu pochodzą z web); po dodaniu klucza restart web i worker; przy domyślnych adresach brak klucza nadal zatrzymuje start (LLM/TTS); walidacja `UMIEM_LESSON_AGENT_*` przy każdym starcie; usunąć pozostawione `UMIEM_LESSON_AGENT_SUBJECTS`; koszt agenta; wycofanie przez `git revert`; zmiana niezgodna dla OpenAI-direct.
- `.env.example` (opisy `UMIEM_LLM_*` bez „pul ćwiczeń lekcji” i „dotychczasowego potoku”; ścisły `json_schema` przy `UMIEM_LLM_PROVIDER_*`), `docs/SPEC.md` (§29a.8, §29a.10, :828, sekcja rozdziału), `AGENTS.md` (:135, :187 — bez „domyślnie wyłączony” i listy; nowy przedmiot dodaje `agentPolicy`; `FAKE_SLOW_MARKER` = 3 s na pierwszy krok każdego zagadnienia fake-agenta, `UMIEM_FAKE_LESSON_DELAY_MS` na krok; „pula fake LLM trwa 3 s” przepisać), `docs/folder-structure.md`, `docs/superpowers/specs/2026-11-02-llm-cost-tracking-design.md:49` (dopisek: `generateLessonPool`/`lesson_pool` usunięte w etapie 3 #237 PR 2, stare wiersze zostają), komentarze kodu (`generation-env.ts`, `fake-lesson-agent.ts`, `fake-lesson-pool.ts`), spec etapu 3: §5.3 („checker i krytyk” → „checker”), §5.2 (generator w `fake-lesson-pool.ts`), §9 dopisek z decyzją o powodach odrzuceń i Rozstrzygnięciami 3, 11, 12.

- [ ] **Step 1:** Edytuj. `git grep -nE "UMIEM_LESSON_AGENT_SUBJECTS|generateLessonPool|stage_top_up|dogenerowanie pod etap|domyślnie \**wyłączon|dotychczasow[a-z]* potok|generowanie potokiem|generuje potok" -- docs AGENTS.md .env.example packages apps tests ':!docs/superpowers'` — tylko wzmianki historyczne opisane jako takie.
- [ ] **Step 2: Commit** „Dokumentacja: agent jedynym generatorem lekcji (#237)”.

### Task 14: Pełna weryfikacja

- [ ] **Step 1:** Czyste drzewo; `git rebase --exec "pnpm typecheck" 3b4c1ec0`. Przy porażce: `git rebase --abort`, poprawka w nowym commicie na czubku, powtórka. Obietnica: każdy commit się kompiluje.
- [ ] **Step 2:** `pnpm check` — PASS (w tym `tests/ai-sdk-scope.test.ts`, `lesson-agent-imports.architecture.test.ts`).
- [ ] **Step 3:** `pnpm test:integration` — PASS; przelicz `INTEGRATION_BUCKETS` z pomiaru `UMIEM_INTEGRATION_WORKERS=1 pnpm exec vitest run --config vitest.integration.config.ts --reporter=json` (LPT); `integration-buckets.test.ts` — PASS.
- [ ] **Step 4:** `pnpm test:e2e:shards` — PASS; gdy czasy plików `real` mocno się zmieniły, przelicz `REAL_BUCKETS`; `spec-projects.test.ts` — PASS.
- [ ] **Step 5:** `deploy/smoke.sh` (Docker lokalnie) — PASS; jeśli niewykonalne, zapisz powód do opisu PR.
- [ ] **Step 6: Commit** „Kosze testów i liczby w AGENTS.md (#237)” (liczby testów E2E i integracji, czasy pomiaru).

### Task 15: Płatny przebieg kontrolny i PR

- [ ] **Step 1: Bramka zgody (spec §6.4)** — wiadomość do właściciela: 4 runy (rozdział Unit 3, gramatyka Present Simple, szkoła geografia — materiały z 2026-11-03 poza repo, ścieżki i SHA-256; „+6” na lekcji gramatyki z tego przebiegu), rozmiary pul, modele generatora, checkera i gradera, nowy rejestr (`UMIEM_PROBE_COSTS_INIT=1`, `UMIEM_PROBE_COSTS_CAP_USD=3`), koszt: ≤ 1,00 USD na run (budżet agenta; szkoła dodatkowo etap zagadnień poza budżetem), łącznie ≤ 3 USD (twardy limit — ostatni run może zostać zatrzymany), commit HEAD po Task 14. **Bez „tak” nic nie startuje.**
- [ ] **Step 2:** Po zgodzie runy kolejno; porażka (run `failed`, wyjątek, `queued` po wyczerpaniu prób, zagadnienie bez ćwiczeń, suma `agent_*`/`check_*` runu ponad budżet) — stop i pytanie o decyzję.
- [ ] **Step 3:** Wynik (same liczby: stan, ćwiczenia per zagadnienie i etap, `generationGaps`, braki publikacji, koszt, czas, histogram kodów odrzuceń, `checkCounters`, `kind` w rozdziale, `openCheck=on` i `openChecks` w szkole, ćwiczenia z „+N”) do `docs/architecture.md` §19.17 w miejsce „Etap 2a/2b: niezweryfikowane”. Commit „Dokumentacja: wynik płatnego przebiegu kontrolnego agenta (#237)”. Dane przebiegu poza repo.
- [ ] **Step 4:** Szkic opisu PR w scratchpadzie: zakres; co zostaje; zmiana niezgodna dla OpenAI-direct; nowi domyślni odbiorcy (§5.5); koszt (§5.6); walidacja env przy starcie; powody odrzuceń w szkicu; wdrożenie (web i worker razem, ten sam klucz i modele w obu, restart po dodaniu klucza, bez migracji, usunąć `UMIEM_LESSON_AGENT_SUBJECTS`, `git revert`); API → MCP → SKILL.md (nowe wymagane pole katalogu i kod `errorCode` — katalog serwuje jedno wdrożenie web, lekcji nie ma w MCP ani `learning-overview`, `errorCode` to wolny tekst; wdrożenia u konsumentów: brak); wynik przebiegu; sprawdzenia. Zapytaj właściciela o push i PR.

---

## Załącznik: lista obowiązkowa §6.1 → testy po PR 2

| Zachowanie (§6.1) | Test po PR 2 |
|---|---|
| stary `review` w szkicu; kopia bez `review`/`generationGaps` | `lesson-agent-generation` 688 (Task 3); `lesson-generation` 1540, 1562 (Task 6) |
| zapis: `payload_version`, `target_key`, umiejętność, stan `review` | `lesson-generation` 196 (Task 6) |
| słuchowe w gramatyce bez odrzuceń; sanityzacja polecenia/podpowiedzi/piktogramu | `lesson-generation` 252, 281 (Task 6; `rejectionCodes`) |
| redundantny `acceptedAnswers`; `refineGeneratedPool` nie działa przy edycji | `lesson-generation` 368, 454 (część edycji) (Task 6) |
| zły kształt, `null` w tablicy, strict-schema z `null`; przykłady | `lesson-generation` 537, 596, 823, 635 (Task 6) |
| przerwanie po claimie, spóźniony zapis, stary SELECT, restart, edycja w kolejce | `lesson-generation` 651, 696, 920, 1003 (Task 6); `lesson-agent-generation` 1105 (spóźniony zapis), 1043 (edycja w trakcie) |
| błąd trwały, „Ponów” czyści odroczenie, `nextAttemptAt` | `lesson-agent-generation` 578, 238/270, 629/855/934; `lesson-generation` 861, 883, 903 (Task 6) |
| `historyLikeSubject` bez audio; przypadkowe TTS → `superseded` | `lesson-generation` 1049, 1077 (Task 6) |
| wyjaśnienia: gramatyka zapisuje / usuwa łamiące; szkoła odrzuca | `lesson-generation` 1164, 1184, 1224 (Task 6) |
| szkoła v3 z cytatami; ton lektora; rachunki; publikacja i sesja szkoły; patch `dynamicTopic` | `lesson-generation` 1254, 1311, 1355, 1412, 1485 (Task 6) |
| ujawnienia: przykład karty; rodzina pytań otwartych raz; usunięcie rodziny ze słowami kluczowymi; domyślna pula bez ujawnień | `lesson-generation` 1606, 1648, 1676, 1739 (Task 6); tryb fake z env (Task 8) |
| rozdział: rodzaje, v2 bez cytatów, publikacja | `lesson-chapter` 118 (Task 7); tryb fake z env (b), (e) (Task 8) |
| słowo spoza materiału; pełne odrzucenie z powodami i „Ponów” | `lesson-chapter` 163, 231 (Task 7); Task 4 integracja |
| ujawnienie między zagadnieniami; forma skrócona | `lesson-chapter` 328, 352 (Task 7) |
| „+N”: nowa luka rozwiązująca tłumaczenie ze szkicu odpada; `avoidSentences` | `lesson-chapter` 375, 492, 532, 552, 558 (Task 7) |
| sesja dziecka rozdziału | blok 780–1084 przez `seedChapterDraft` (Task 7) |
| brak klucza (pełna, „+N”, szkoła, historyjka, punkt kontrolny) | `describe("brak agenta")` (Task 9) |
| bez zmian: `createLesson*`, jeden aktywny „+N”, tytuł rozdziału, edycje rodzica | `lesson-generation` 135, 172, 184, 948, 979, 1119; `lesson-chapter` 691, 708, 734, 749 |
