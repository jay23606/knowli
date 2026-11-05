# Agent generujący pulę lekcji — etap 1 — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reguły agenta puli lekcji w domenie, polityki trzech przedmiotów, porty z fake'ami i kierownik w pamięci, a próba `pnpm probe:agent` działa na tym kodzie.

**Architecture:** Funkcyjny rdzeń `domain/lessons/agent/` (niemutowalny stan lekcji, przyjmowanie paczki z kontrolą całej lekcji, status, widok rozwiązującego, plan) parametryzowany `SubjectModule.agentPolicy`. Kierownik w `modules/materials/lessons/` składa narzędzia podagentów z rdzenia i portu checkera, pilnuje mutexów, budżetu i terminów. AI SDK występuje wyłącznie w plikach próby (`tests/probes`).

**Tech Stack:** TypeScript strict, Vitest, Zod, pnpm; w próbie `ai@7.0.162`, `@openrouter/ai-sdk-provider@3.1.0`, `zod@4.6.5` (devDependencies roota).

**Spec:** `docs/superpowers/specs/2026-11-04-lesson-pool-agent-stage1-design.md` (wersja 2 z poprawkami po review planów; § poniżej odnoszą się do niego).

**Gałąź:** od gałęzi PR wstępnego (plan `2026-11-04-lesson-card-sentences-generation.md`; rdzeń używa `cardExposureSources`). PR do `main` po scaleniu PR wstępnego (rebase).

## Global Constraints

- Kod i identyfikatory po angielsku; komentarze, dokumentacja i opisy PR po polsku.
- `domain/lessons/agent/**` nie importuje `ai`, `@openrouter/*`, `drizzle-orm`, `modules/`, `providers/`, `ports/`, `config*`; bez `Date.now`, `Math.random`, `process.env`.
- Silnik, kierownik i `providers/fake-lesson-agent.ts` nie zawierają literałów `english_chapter`, `english_grammar`, `school` (istniejący skan `domain/lessons/architecture.test.ts`).
- `ai`, `@openrouter/*` tylko w `tests/probes/**` i jako devDependencies roota, przypięte dokładnie.
- Wartości: `independentReserve` 1, `slack` 2, `maxStepsPerObjective` 8, `planMaxSteps` 8, `concurrency` 4, `checkerConcurrency` 4 (jedno miejsce na wywołanie `solve` albo `judgeVariants`), `checkerTimeoutMs` 90 000, `objectiveTimeoutMs` 300 000 (od startu podagenta), `runTimeoutMs` = `DEFAULT_LESSON_GENERATION_POLICY.runTimeoutMs`, `runBudgetUsd` 1,00 (wyczerpany przy wydatku ≥ budżet), `unknownCallEstimateUsd` 0,02; plan 3–6 zagadnień.
- Terminy przez helper na `setTimeout` + `AbortController` (wzór `lesson-generation-control.ts:83-103`), nigdy `AbortSignal.timeout` w kodzie produkcyjnym.
- Do checkera trafiają wyłącznie widoki, liczby odpowiedzi, odpowiedź i warianty oraz materiał przy `checkerNeedsMaterial` (§11).
- Logi `[lesson-agent]` bez treści ćwiczeń, materiału, kart, tematów zdań i `detail` (§7.4).
- Po każdej zmianie w `modules/` uruchom `packages/server/src/modules/module-boundaries.architecture.test.ts`.
- Instalacja tylko `pnpm add -D -w --save-exact` / `pnpm install --prefer-offline --frozen-lockfile`; nigdy `npm install`.
- Płatne wywołania tylko w Task 17 i tylko po wyraźnej zgodzie właściciela w czacie.
- Nie wypychaj do `main`, nie scalaj PR; nie wypychaj `feat/lesson-review-probe`.

## Review Focus

- Model zwraca rekord z `objectiveId` innego zagadnienia, `exercises` niebędące tablicą, `null` w polach albo `examples` jako napis — odrzucenie `shape_*` z powodem, bez wyjątku (test w Task 12).
- Lekcja z ok. 90 ćwiczeniami — `precheckBatch` + `admitBatch` paczki 12 w szkole z `validatePoolExtra` poniżej 2 s (lokalnie ok. 0,3 s; test w Task 6).
- `remove` z nieznanym id, id cudzym albo `fixed`; ponowne wysłanie identycznego ćwiczenia — `removed: []`; duplikat odrzucony z kodem `lesson_pool` (testy w Task 5).
- Checker zwraca paczkę krótszą, dłuższą, z `null` albo rzuca — pozycje bez pary `unavailable`, nadmiar ignorowany, wyjątek = cała paczka `unavailable` (testy w Task 12).
- Materiał rozdziału bez linii „en — pl” i sekcji ram — `planCoverage` puste, `planGate` przechodzi, `objectiveGaps` puste, run kończy się `complete` (testy w Task 8 i Task 13).

---

### Task 1: Testy architektury agenta i zakresu AI SDK

**Files:**
- Modify: `packages/server/src/domain/lessons/architecture.test.ts`
- Create: `tests/ai-sdk-scope.test.ts`; Modify: `vitest.unit.config.ts` (dopisz plik do `include`)

- [ ] **Step 1: Testy**: pliki `domain/lessons/agent/**` (gdy istnieją) nie importują modułów z listy Global Constraints i nie zawierają `Date.now(`, `Math.random(`, `process.env`; `tests/ai-sdk-scope.test.ts` — w `packages/**/src/**` i `apps/**/src/**` (bez `node_modules`) brak importów `"ai"`, `"ai/…"`, `"@openrouter/…"`, a `packages/*/package.json` i `apps/*/package.json` nie mają tych zależności.
- [ ] **Step 2: PASS** — `pnpm exec vitest run --config vitest.unit.config.ts packages/server/src/domain/lessons/architecture.test.ts tests/ai-sdk-scope.test.ts`. Kontrola: tymczasowy plik `domain/lessons/agent/tmp.ts` z `import "ai";` → FAIL → usuń.
- [ ] **Step 3: Commit** — „Testy: granice agenta puli i zakres AI SDK (#237)”.

### Task 2: Typy polityki agenta i przedmiot testowy

**Files:**
- Modify: `packages/server/src/domain/lessons/types.ts`
- Create: `packages/server/src/domain/lessons/agent/capable.ts`, `packages/server/src/domain/lessons/testing/agent-test-subject.ts`
- Test: `packages/server/src/domain/lessons/agent/capable.test.ts`

**Interfaces:**
- Produces (`types.ts`): `AgentObjective` (§3.1, z `exerciseTypes`), `RawPlanObjective = { slug: string; titlePl: string; descriptionEn: string; kind: DynamicObjectiveKind; cards: { title: string; body: string }[]; examples: string[] }`, `AgentGateFinding = { readonly code: string; readonly reason: string }`, `SubjectAgentPolicy` (§4, `exerciseGate` zwraca `readonly AgentGateFinding[]`), `SubjectModule.agentPolicy?: SubjectAgentPolicy`.
- Produces (`capable.ts`): `type AgentCapableSubject = SubjectModule & { readonly agentPolicy: SubjectAgentPolicy }`; `asAgentCapable(subject): AgentCapableSubject` (rzuca `Error("subject has no agentPolicy")`); `agentObjectivesOf(topic: LessonTopic, kinds?: ReadonlyMap<string, DynamicObjectiveKind>): AgentObjective[]`.
- Produces (`testing/agent-test-subject.ts`, poza skanem domeny): `agentTestSubject: AgentCapableSubject` — `historyLikeSubject` rozszerzony o: `agentPolicy` (wszystkie typy przedmiotu w `blindSolveTypes` i `variantCheckTypes`, `checkerNeedsMaterial: false`, `independentReserve: 1`, `slack: 2`, teksty `"leak victim"`/`"leak source"`), `validatePoolExtra` (słowo kluczowe `lesson_keywords` bez `lesson_open_answer` tej samej `familyId` → błąd `"keywords without open-answer family"`), `refineGeneratedPool` (usuwa wariant `"DROP"` z `acceptedAnswers`; odrzuca ćwiczenie z `answer === "REFINE-REJECT"` z powodem `"refine reject"`); `withAgentPolicy(subject: SubjectModule, policy?: Partial<SubjectAgentPolicy>): AgentCapableSubject` (owija dowolny przedmiot zaślepką polityki — do testów z regułami rozdziału przed Task 8). Typy `lesson_keywords`/`lesson_listen_choice` dodaj do przedmiotu testowego, jeśli `historyLikeSubject` ich nie ma.

- [ ] **Step 1: Test** `capable.test.ts`: `asAgentCapable` przepuszcza `agentTestSubject`, rzuca dla `historyLikeSubject`; `agentObjectivesOf` zachowuje kolejność, karty, `exerciseTypes`, `kind` z mapy.
- [ ] **Step 2: FAIL → Step 3: implementacja → Step 4: PASS** — `pnpm exec vitest run --config vitest.unit.config.ts packages/server/src/domain/lessons/agent/capable.test.ts`; `pnpm exec tsc --noEmit -p packages/server/tsconfig.json`.
- [ ] **Step 5: Commit** — „Lekcje: typy polityki agenta w SubjectModule (#237)”.

### Task 3: Stan lekcji agenta

**Files:**
- Create: `packages/server/src/domain/lessons/agent/state.ts`; Test: `.../agent/state.test.ts`

**Interfaces:**
- Consumes: Task 2; `stageOf`, `outsideStagePath`.
- Produces: `LessonAgentState` (§3.1); `createLessonAgentState(input: { topic: LessonTopic; objectives: readonly AgentObjective[]; fixed: readonly LessonExerciseDraft[]; examples: Readonly<Record<string, readonly string[]>>; fixedSources: Readonly<Record<string, readonly string[]>> }): LessonAgentState`; `orderedEntries(state): readonly { objectiveId: string; id: string | null; draft: LessonExerciseDraft }[]` (`id: null` = `fixed`); `orderedLesson(state): readonly LessonExerciseDraft[]`; `poolOf(state, objectiveId)`; `withPool(state, objectiveId, pool)`; `withExamples(state, objectiveId, lines)`; `allExamples(state): Record<string, string[]>` (`examples` ∪ `fixedSources` per zagadnienie, bez duplikatów); `takeIds(state, n): { ids: string[]; state }` (`ex1`, `ex2`…).

- [ ] **Step 1: Testy**: kolejność (zagadnienia wg planu; w zagadnieniu `intro` < `guided` < `productive` < `independent` < poza ścieżką; `fixed` i pula razem, stabilnie); `fixed` nie w `poolOf`; `allExamples`; `withPool`/`withExamples` nie zmieniają wejścia (porównanie `structuredClone` przed/po); `takeIds` → `["ex1","ex2"]`, potem `["ex3"]`.
- [ ] **Step 2: FAIL → Step 3: implementacja → Step 4: PASS** — `pnpm exec vitest run --config vitest.unit.config.ts packages/server/src/domain/lessons/agent/state.test.ts`.
- [ ] **Step 5: Commit** — „Lekcje: stan lekcji agenta (#237)”.

### Task 4: Widok rozwiązującego i ślepe porównanie

**Files:**
- Create: `packages/server/src/domain/lessons/agent/solver.ts`; Test: `.../agent/solver.test.ts`

**Interfaces:**
- Produces: `solverView(draft: LessonExerciseDraft, topic: LessonTopic): string`; `expectedAnswerCount(draft): number`; `blindMatches(draft, answers: readonly string[], normalizer: AnswerNormalizer): boolean`; `SOLVER_FIELD_CLASS: Readonly<Record<keyof LessonExerciseDraft, "view" | "key" | "mixed" | "meta">>`.

Klasyfikacja: `view` — pole widoczne dla dziecka przed odpowiedzią w Kid DTO (`modules/learning/lessons/lesson-materialize.ts`); `key` — wyłącznie klucz/ocena; `mixed` — widoczne w przekształconej postaci: `gapAnswers` (tylko w posortowanym banku `lesson_cloze`, nigdy w `clozeText`), `pairs` (lewe w kolejności, prawe posortowane, bez powiązań), `groupItems` (`text` tak, `groupId` nie), `items` (posortowane), `options` (bez `correctOption`); `meta` — nie wpływa na widok (`objectiveId`, `familyId`, `questionType`, `voiceTone` itp.). `hint` = `key` (pierwszy widok bez podpowiedzi; ryzyko fałszywych rozjazdów w lukach gramatyki mierzy etap 3). Każde pole `LessonExerciseDraft` musi mieć klasę — rozstrzygnij pozostałe pola regułą Kid DTO i wpisz w stałej.

- [ ] **Step 1: Testy**:
  - `SOLVER_FIELD_CLASS satisfies Record<keyof LessonExerciseDraft, …>` + runtime: klucze = klucze pełnego szkicu-fixture ze wszystkimi polami;
  - dla szkiców-fixture każdego typu: żadna wartość pola `key` (teksty ≥ 3 znaki) nie występuje w widoku; `lesson_cloze`: `clozeText` w widoku bez wstawionych odpowiedzi, bank = `[...gapAnswers, ...extraWords].sort()`; `lesson_match`: prawe posortowane, żaden wiersz nie łączy lewej z jej prawą; `lesson_group`: brak `groupId`; `lesson_order`: bloki posortowane;
  - `lesson_transform` — widok zawiera `topic.transforms[…].instructionPl`; `visualSubject` w widoku;
  - `expectedAnswerCount`: cloze 3 luki → 3, para 4 → 4, grupa 5 elementów → 5, wybór → 1;
  - `blindMatches`: cloze pozycyjnie (z wariantem przez `answersEquivalent`), pary `["kot => cat", "dog"]` vs prawe `["cat","dog"]` → `true`, zła kolejność → `false`, grupy po etykietach, luka z wariantem, inna liczba odpowiedzi → `false`, `"There’s"` vs `"there's"` → `true`.
- [ ] **Step 2: FAIL → Step 3: implementacja → Step 4: PASS** — `pnpm exec vitest run --config vitest.unit.config.ts packages/server/src/domain/lessons/agent/solver.test.ts`.
- [ ] **Step 5: Commit** — „Lekcje: widok rozwiązującego i ślepe porównanie (#237)”.

### Task 5: Przyjmowanie paczki — kontrole deterministyczne

**Files:**
- Create: `packages/server/src/domain/lessons/agent/admission.ts`, `packages/server/src/domain/lessons/keyword-families.ts`
- Modify: `packages/server/src/modules/materials/lessons/lesson-drafts.ts` (`withoutOrphanKeywords` importowane z domeny i reeksportowane)
- Test: `.../agent/admission.test.ts`

**Interfaces:**
- Consumes: Task 2–4; `validateLessonExercise`, `validatePool`, `findExposureLeaks` (`mode: "coverage"`).
- Produces:
  - `ObjectiveAgentLimits = { targetCount: number; listenAllowance: number; maxExercises: number }`; `AgentCheckContext` (§3.2).
  - `CheckResult<T>`, `CandidateChecks`, `Rejection` (§3.3).
  - `PrecheckEntry = { pass: true; draft: LessonExerciseDraft; sanitized: readonly string[] } | { pass: false; rejection: Rejection }`.
  - `precheckBatch(state, objectiveId, drafts: readonly LessonExerciseDraft[], ctx): PrecheckEntry[]`.
  - `AdmitEntry = { accepted: string; sanitized: readonly string[]; unchecked: boolean } | { rejected: Rejection }`.
  - `admitBatch(state, objectiveId, prechecked: readonly PrecheckEntry[], checks: readonly CandidateChecks[], ctx): { state; results: AdmitEntry[] }` (w tym zadaniu kroki 1–4; `checks` ignorowane do Task 6).
  - `removeExercise(state, objectiveId, id, ctx): { state; removed: string[] }`.
  - `withoutOrphanKeywords` (przeniesiona bez zmian) w `keyword-families.ts`.
  - Kody: `limit_full`, `limit_listen`, `refine`, `rule_exercise`, `lesson_pool`, `lesson_extra`, `leak_victim`, `leak_source`, a dla bramek przedmiotu — kod z `AgentGateFinding.code`.

Algorytm (§3.3) — decyzje dla niejednoznacznych miejsc:
- kolejność w paczce: wszystkie typy oprócz `lesson_keywords` w kolejności wejścia, potem `lesson_keywords` w kolejności wejścia; wyniki w indeksach wejścia; to samo w `precheckBatch` i `admitBatch`;
- kandydat roboczy: `agentPolicy.sanitize` → `refineGeneratedPool([draft], { material })` (odrzucenie → `refine`, `kept[0]` zastępuje szkic);
- krok 3: `before = validatePool(orderedLesson(state), subject, topic, { existingExercises: [] })` i `subject.validatePoolExtra?.(orderedLesson(state), { material })`; `after` — to samo z kandydatem wstawionym na swoje miejsce w `orderedLesson`; zbiory odrzuconych **po referencji szkicu** (`validatePoolExtra` → mapowanie indeks→szkic); kandydat odpada, gdy jest odrzucony w `after` albo `after` odrzuca szkic nieodrzucony w `before`; `lesson_extra` ma pierwszeństwo nad `lesson_pool` tylko, gdy `validatePool` kandydata nie odrzuca;
- krok 4: `findExposureLeaks({ exercises: after, examples: allExamples(state), objectiveOrder, subject, mode: "coverage" })` — kandydat ujawniony → `leak_victim`; ujawniony szkic, który w `before` ujawniony nie był → `leak_source`;
- `before` liczone raz na kandydata (wynik `after` przyjętego staje się `before` następnego);
- `removeExercise`: tylko wpis z `poolOf(state, objectiveId)`; po usunięciu `withoutOrphanKeywords` na puli zagadnienia; nieznany/cudzy/`fixed` → `removed: []`.

- [ ] **Step 1: Testy** (`agentTestSubject`; reguły słuchowe — `withAgentPolicy(englishChapterSubject)` z kartami z fixture rozdziału):
  - kolejność kroków: pełna pula + duplikat → `limit_full`; reguła ćwiczenia + ujawnienie → `rule_exercise`;
  - `limit_listen` przy `listenAllowance: 0`;
  - duplikat w paczce → drugi `lesson_pool`; ponowne wysłanie przyjętego → `lesson_pool`;
  - konflikt słuchowy między zagadnieniami (`lesson_listen_choice` w A, tekstowe ćwiczenie z tym samym zdaniem w B) → `lesson_pool`;
  - wadliwe `fixed` (duplikat w `fixed`) — poprawny kandydat przyjęty;
  - słowa kluczowe bez rodziny w lekcji → `lesson_extra`; słowa kluczowe przed swoją rodziną w paczce → oba przyjęte, w `precheckBatch` i `admitBatch`;
  - kandydat samodzielny = przykład → `leak_victim`; niesamodzielny ujawniający przyjęte samodzielne → `leak_source`; ujawniający samodzielne `fixed` → `leak_source`; samodzielny z odpowiedzią przyjętego samodzielnego **wcześniejszego w lekcji** → `leak_victim`; samodzielny wstawiony **przed** przyjętym samodzielnym z tą samą odpowiedzią (zagadnienie wcześniejsze) → `leak_source`;
  - `refine`: `"REFINE-REJECT"` → `refine`; wariant `"DROP"` usunięty w szkicu z `precheckBatch`;
  - zgodność: dla trzech fixture'ów decyzje `precheckBatch` = decyzje kroków 1–4 `admitBatch` na tym samym stanie;
  - `removeExercise`: własne → `["ex1"]` z sierotami słów kluczowych (`["ex1","ex2"]`); nieznane, cudze, `fixed` → `[]`;
  - wejściowy stan bez zmian (`structuredClone` przed/po).
- [ ] **Step 2: FAIL → Step 3: implementacja → Step 4: PASS** — `pnpm exec vitest run --config vitest.unit.config.ts packages/server/src/domain/lessons/agent/admission.test.ts packages/server/src/modules/materials/lessons packages/server/src/modules/module-boundaries.architecture.test.ts`.
- [ ] **Step 5: Commit** — „Lekcje: przyjmowanie paczki agenta — kontrole deterministyczne (#237)”.

### Task 6: Przyjmowanie paczki — checker, przykłady, niezmiennik i wydajność

**Files:**
- Modify: `.../agent/admission.ts`; Test: `.../agent/admission.checks.test.ts`, `.../agent/admission.property.test.ts`

**Interfaces:**
- Produces: kroki 5–6 `admitBatch` (kody `blind_mismatch`, `variant_rejected`; `unchecked` przy `unavailable`); `submitExamples(state, objectiveId, lines: unknown, ctx): { state; accepted: number; errors: string[] }` (§3.4; `lines` nie-tablica → `errors: ["examples must be an array of strings"]`).

- [ ] **Step 1: Testy `admission.checks.test.ts`**: `solve` `na` → przyjęte, `unchecked: false`; `unavailable` → przyjęte, `unchecked: true`; `done` rozjazd → `blind_mismatch` z odpowiedzią solvera w `reasons`; `variants` `[true,false]` → `variant_rejected` z wariantem w `reasons`; `submitExamples`: 4 linie → przyjęte 3; linia ujawniająca przyjęte samodzielne → błąd, pozostałe przyjęte; zastąpienie poprzednich; żadna nie przeszła → stare zostają; `"x"` → błąd kształtu.
- [ ] **Step 2: Test własności** `admission.property.test.ts` (`{ timeout: 60_000 }`): PRNG mulberry32 w pliku testu, ziarna 1–50 (ziarno w nazwie przypadku `it.each`); stan startowy z czystym `fixed` (bez ujawnień i błędów); słownik 6 odpowiedzi i 4 zdań-przykładów (częste kolizje); 20 operacji `precheckBatch`+`admitBatch` (paczki 1–4) albo `removeExercise`; na `agentTestSubject` i `withAgentPolicy(schoolSubject)`; po każdej operacji **bezwzględnie**: `findExposureLeaks(coverage)` pusty, `validatePool(...).rejected` pusty, `validatePoolExtra` pusty; po wszystkich ziarnach każdy z kodów `lesson_pool`, `leak_victim`, `leak_source`, `limit_full` wystąpił ≥ 1 raz. Osobny przypadek: wadliwe `fixed` — po każdej operacji odrzucone są wyłącznie szkice odrzucone na starcie (porównanie po tożsamości).
- [ ] **Step 3: Test wydajności**: `withAgentPolicy(schoolSubject)`, 90 ćwiczeń w 6 zagadnieniach + materiał ok. 15 000 znaków; `performance.now()` wokół `precheckBatch`+`admitBatch` paczki 12 → `< 2000`.
- [ ] **Step 4: FAIL → Step 5: implementacja → Step 6: PASS** — `pnpm exec vitest run --config vitest.unit.config.ts packages/server/src/domain/lessons/agent/admission`.
- [ ] **Step 7: Commit** — „Lekcje: przyjmowanie paczki agenta — checker, przykłady i niezmiennik (#237)”.

### Task 7: Status, limity, kontrola końcowa i plan

**Files:**
- Create: `.../agent/status.ts`, `.../agent/plan.ts`; Test: `.../agent/status.test.ts`, `.../agent/plan.test.ts`

**Interfaces:**
- Consumes: Task 2–6; `stageDeficits`, `lessonPoolMinimums`.
- Produces:
  - `objectiveAgentLimits(counts: { targetCount: number; listenAllowance: number }, policy: Pick<SubjectAgentPolicy, "slack">): ObjectiveAgentLimits`.
  - `ObjectiveStatus = { counts: { guided; productive; independent; outsideStages; total }; missing: string[]; complete: boolean }`; `objectiveStatus(state, objectiveId, ctx)` — `stageDeficits` z `{ ...subject, poolMinimums: { ...lessonPoolMinimums(subject), independent: +independentReserve } }` na `orderedLesson` i `allExamples`. Teksty `missing` (dokładnie): `"<stage>: <actual> of <required>"`, `"exercises: <total> of <targetCount>"`, `"needs at least one <typ1> or <typ2>"`, `"card examples: <n> of 1-3"`, potem teksty `objectiveGaps`.
  - `lessonInvariantCheck(state, ctx): { objectiveId: string; id: string }[]`.
  - `validateAgentPlan(raw: unknown, subject: AgentCapableSubject, material: string): { ok: true; objectives: RawPlanObjective[] } | { ok: false; errors: string[] }`; `AGENT_PLAN_MIN_OBJECTIVES = 3`, `AGENT_PLAN_MAX_OBJECTIVES = 6`; slug: `^[a-z0-9_]{1,40}$` (ta sama reguła co `sanitizeObjectiveSlug`), unikalny.

- [ ] **Step 1: Testy `status.test.ts`**: szkoła (`withAgentPolicy(schoolSubject)`, minima 3/2/2) z pulą 3/2/2 → `missing` zawiera `"independent: 2 of 3"`; ćwiczenie ujawnione się nie liczy; dwa pytania otwarte z tą samą odpowiedzią → jedno; `total` 6 przy `targetCount` 8 → `"exercises: 6 of 8"`; `lesson_listen_choice` i `lesson_keywords` w `outsideStages`; grupa `requiredTypes` z typem spoza `objective.exerciseTypes` pominięta; brak przykładów → `"card examples: 0 of 1-3"`; `objectiveGaps` dołączone; `fixed` liczone; `objectiveAgentLimits({ targetCount: 8, listenAllowance: 2 }, { slack: 2 }).maxExercises === 12`; `lessonInvariantCheck` pusty dla stanu z `admitBatch`, a dla ręcznie zepsutego zwraca ofiarę z puli albo źródło z puli przy ofierze `fixed`.
- [ ] **Step 2: Testy `plan.test.ts`**: 3 i 6 → `ok`; 2 i 7 → błąd `"objectives: 2, allowed 3-6"`; slug `"Łóżko"` i duplikat → błędy; 1 i 5 kart → błędy; 4 przykłady → błąd; brak `kind` → błąd; `planGate` dołączony.
- [ ] **Step 3: FAIL → Step 4: implementacja → Step 5: PASS** — `pnpm exec vitest run --config vitest.unit.config.ts packages/server/src/domain/lessons/agent/status.test.ts packages/server/src/domain/lessons/agent/plan.test.ts`.
- [ ] **Step 6: Commit** — „Lekcje: status zagadnienia, limity i plan agenta (#237)”.

### Task 8: Polityka rozdziału

**Files:**
- Create: `.../subjects/english-chapter/material-lexicon.ts`, `.../subjects/english-chapter/agent-policy.ts`; Modify: `.../english-chapter/module.ts`
- Test: `.../english-chapter/material-lexicon.test.ts`, `.../english-chapter/agent-policy.test.ts`

**Interfaces:**
- Produces: `parseMaterialLexicon(material): { words: string[]; frames: string[] }`, `frameKey(frame): string`, `plainText(text): string`, `mentions(haystack, word): boolean` (reguły PoC `parseMaterial`, `frameKey`, `plainText`, `mentions`); `chapterAgentPolicy` (§4.2; kody bramek `card_word_missing`, `frame_missing`).

- [ ] **Step 1: Testy lexicon**: `"Pokój:\nbed — łóżko\nliving room — salon\nWhere is it? — Gdzie to jest?\nZwroty:\nThere's a … in the …"` → `{ words: ["bed", "living room"], frames: ["There's a … in the …"] }`; `frameKey("There's a … in the …") === "there's a"`; `mentions("I have beds", "bed") === true`, `mentions("bedroom", "bed") === false`; `parseMaterialLexicon("Tekst bez list.")` → puste.
- [ ] **Step 2: Testy polityki**: `requiredTypes` dla `words`/`frame` (§4.2); bramka słów kart: luka z „bed” przy kartach z „bed” → `[]`, z „lamp” → `card_word_missing`; para z dwoma słowami kart → `[]`, z jednym → `card_word_missing`; bramka ramy: `lesson_order` „There's a bed in the room” przy ramie zagadnienia → `[]`, przy ramie innego zagadnienia → `frame_missing`; `lesson_listen_choice` pomijane; `objectiveGaps` → `["card words not used in any exercise yet: lamp"]`; `planGate` z niepokrytym „lamp” → błąd z „lamp”; materiał bez list → `planGate` `[]`, `planCoverage` puste; `leakVictim` zawiera „change the room, object or place”; `englishChapterSubject.agentPolicy === chapterAgentPolicy`; `independentReserve === 1`, `slack === 2`.
- [ ] **Step 3: FAIL → Step 4: implementacja** (typy ślepe/wariantów: PoC `BLIND_TYPES`/`VARIANT_CHECK_TYPES` gałęzi nie-szkolnej ∩ `CHAPTER_EXERCISE_TYPES`; `checkerNeedsMaterial: false`) **→ Step 5: PASS** — `pnpm exec vitest run --config vitest.unit.config.ts packages/server/src/domain/lessons/subjects/english-chapter`.
- [ ] **Step 6: Commit** — „Lekcje: polityka agenta rozdziału (#237)”.

### Task 9: Polityki gramatyki i szkoły (bramka podpowiedzi)

**Files:**
- Create: `.../english-grammar/agent-policy.ts`, `.../school/agent-policy.ts`, `.../school/hint-gate.ts`; Modify: `.../english-grammar/module.ts`, `.../school/module.ts`
- Test: `.../english-grammar/agent-policy.test.ts`, `.../school/hint-gate.test.ts`, `.../school/agent-policy.test.ts`

**Interfaces:**
- Produces: `grammarAgentPolicy`, `schoolAgentPolicy`; `stemMatches(a: string, b: string): boolean`; `hintRevealsAnswer(hint: string, draft: LessonExerciseDraft, normalizer: AnswerNormalizer): boolean`; kod `hint_reveals_answer`, powód: `"the hint gives away the answer or a required element; hint at the reasoning, not the content"`.

- [ ] **Step 1: Testy `hint-gate.test.ts`**:

```ts
expect(stemMatches("Odra", "Odrze")).toBe(true);
expect(stemMatches("Polska", "Polski")).toBe(true);
expect(stemMatches("zmniejszony", "zmniejszenie")).toBe(true);
expect(stemMatches("mapa", "mama")).toBe(false);
expect(stemMatches("kot", "koń")).toBe(false);
const open = (answer: string, extra: Partial<LessonExerciseDraft> = {}) => ({ ...openAnswerFixture, answer, ...extra });
expect(hintRevealsAnswer("Przykładem jest Mierzeja Wiślana", open("Mierzeja Wiślana"), norm)).toBe(true);
expect(hintRevealsAnswer("Użyj słów: zmniejszony, uproszczony", open("Mapa to obraz Ziemi", { requiredElements: [{ id: "a", text: "obraz zmniejszony" }, { id: "b", text: "uproszczony" }] }), norm)).toBe(true);
expect(hintRevealsAnswer("Pomyśl o rzekach w Polsce", open("Wisła i Odra"), norm)).toBe(false);
expect(hintRevealsAnswer("Bitwa była w 1410 roku", open("w 1410"), norm)).toBe(true);        // „1410” to słowo treściowe
// fraza bez słów ≥ 4 liter: wszystkie tokeny są treściowe („ma psa i kota” → 4), próg = 2
expect(hintRevealsAnswer("Ma psa", open("ma psa i kota"), norm)).toBe(true);
expect(hintRevealsAnswer("Pomyśl o zwierzętach", open("ma psa i kota"), norm)).toBe(false);
expect(hintRevealsAnswer("Wspomnij o Krakowie", open("Warszawa", { acceptedAnswers: ["Kraków"] }), norm)).toBe(true);
// słowa treściowe „burza”, „morzem”, „bałtyckim” (3) → próg 2
expect(hintRevealsAnswer("dzieje się nad morzem", open("Burza nad morzem Bałtyckim"), norm)).toBe(false);
expect(hintRevealsAnswer("burza nad morzem", open("Burza nad morzem Bałtyckim"), norm)).toBe(true);
```
- [ ] **Step 2: Testy polityk**: szkoła — `sanitize` usuwa `hint` przy `lesson_gap`/`lesson_choice` (`removed: ["hint"]`), zostawia przy `lesson_open_answer`; `exerciseGate` → `[{ code: "hint_reveals_answer", … }]` dla ujawniającej; `blindSolveTypes` ⊇ `lesson_gap`, ∌ `lesson_open_answer`/`lesson_order`/`lesson_calculation`/`lesson_keywords`; `variantCheckTypes` = `["lesson_gap"]`; `checkerNeedsMaterial: true`; `leakVictim` szkoły ∌ „room”; `independentReserve === 1`, `slack === 2`. Gramatyka — bez `sanitize`/`exerciseGate`; typy ∌ `lesson_match`; `leakVictim` zawiera „use a different subject, verb or object”; `independentReserve === 1`, `slack === 2`.
- [ ] **Step 3: FAIL → Step 4: implementacja → Step 5: PASS** — `pnpm exec vitest run --config vitest.unit.config.ts packages/server/src/domain/lessons/subjects`.
- [ ] **Step 6: Commit** — „Lekcje: polityki agenta gramatyki i szkoły, bramka podpowiedzi (#237)”.

### Task 10: Wspólna sanityzacja świeżego ćwiczenia

**Files:**
- Modify: `packages/server/src/modules/materials/lessons/lesson-pool-acceptance.ts`; Test: `.../lesson-pool-acceptance.test.ts`

**Interfaces:**
- Produces: `sanitizeFreshLessonDraft(draft: LessonExerciseDraft, subject: SubjectModule, familyScope: string | null): { draft: LessonExerciseDraft; droppedExplanation: boolean; droppedVariants: number }` — kroki §7.2 **bez** `stripParentAddedFlags`, w kolejności `acceptFreshLessonPool` (ton → wyjaśnienie → puste tablice → dodatki słuchowe → rodziny → redundantne warianty). `acceptFreshLessonPool` używa jej; `stripParentAddedFlags` zostaje po `refineGeneratedDrafts` jak dziś. Kierownik (Task 12) woła `stripParentAddedFlags([draft])[0]` zaraz po `sanitizeFreshLessonDraft`, przed rdzeniem — odstępstwo kolejności (przed `refine`) jest świadome: flaga `parentAdded` nie wpływa na `refineGeneratedPool`.

- [ ] **Step 1: Testy**: istniejące testy pliku bez zmian + po jednym teście na krok (pusta `options: []` usunięta; dodatek słuchowy usunięty; `familyId` z sufiksem `-r<runId>`; redundantny wariant usunięty i policzony; ton usunięty dla przedmiotu bez TTS; niepoprawne wyjaśnienie → `droppedExplanation: true`).
- [ ] **Step 2: FAIL → Step 3: implementacja → Step 4: PASS** — `pnpm exec vitest run --config vitest.unit.config.ts packages/server/src/modules/materials/lessons packages/server/src/modules/module-boundaries.architecture.test.ts`.
- [ ] **Step 5: Commit** — „Lekcje: wspólna sanityzacja świeżego ćwiczenia (#237)”.

### Task 11: Porty i fake'i

**Files:**
- Modify: `packages/server/src/ports/ai.ts`; Create: `packages/server/src/providers/fake-lesson-agent.ts`; Test: `packages/server/src/providers/fake-lesson-agent.test.ts`

**Interfaces:**
- Produces:
  - W `ports/ai.ts` dokładnie typy §6.1.
  - `FakeLessonPoolAgent implements LessonPoolAgentProvider`: `constructor(options: { objectives?: Record<string, FakeAgentStep[]>; plans?: unknown[]; stepCostUsd?: number | null })` (klucz = slug, `objective.id.split(".").at(-1)`); `FakeAgentStep = { submit: { exercises: unknown; examples?: unknown } } | { remove: string } | { parallel: FakeAgentStep[] } | { throw: Error } | { hang: true }`. Każdy krok: sprawdź `shouldStop()` → „wywołanie modelu”: `cost.record(stepCostUsd ?? null)` → wykonaj narzędzia kroku (koszt odpowiedzi modelu zapisany przed narzędziami, jak `onLanguageModelCallEnd` w AI SDK — przerwanie w trakcie narzędzi nie gubi kosztu). `{ parallel }` uruchamia narzędzia kroków bez czekania. `hang` czeka na przerwanie `signal` i odrzuca `signal.reason`. Pola: `calls: { objectiveId: string; input: LessonObjectiveAgentInput; tools: LessonObjectiveAgentTools; outcomes: unknown[] }[]`, `maxConcurrent: number`.
  - `FakeExerciseChecker implements LessonExerciseCheckerProvider`: `constructor(options: { solve?: (view: string) => string[] | null; solveBatch?: (items: readonly { view: string }[]) => (string[] | null)[] | "throw" | "hang"; judge?: (variant: string) => boolean | null; judgeBatch?: (items: readonly unknown[]) => (boolean[] | null)[] | "throw" | "hang"; costUsd?: number | null; gate?: Promise<void> })` (`*Batch` ma pierwszeństwo; `gate` — wywołania czekają na obietnicę, do testów równoległości); domyślnie `solve` → `[]` (rozjazd), `judge` → `true`, `costUsd: 0`; pola `solveCalls`, `judgeCalls` (pełne wejścia), `maxConcurrent`.

- [ ] **Step 1: Testy fake'ów**: kroki do `shouldStop()`; koszt przed narzędziami (`record` wołane przed `submit`, także gdy `submit` zostanie przerwany); `parallel` — dwa `submit` startują przed zakończeniem pierwszego (narzędzie z opóźnieniem); `hang` odrzuca `signal.reason` po `abort(reason)`; `maxConcurrent`; checker: `solveBatch` zwraca krótszą listę → wynik przekazany 1:1; `"throw"` → wyjątek; `gate`.
- [ ] **Step 2: FAIL → Step 3: implementacja → Step 4: PASS** — `pnpm exec vitest run --config vitest.unit.config.ts packages/server/src/providers/fake-lesson-agent.test.ts packages/server/src/domain/lessons/architecture.test.ts`.
- [ ] **Step 5: Commit** — „Lekcje: porty agenta i checkera z fake'ami (#237)”.

### Task 12: Narzędzia podagenta

**Files:**
- Create: `packages/server/src/modules/materials/lessons/lesson-pool-agent-tools.ts`, `.../lesson-pool-agent-policy.ts`, `.../lesson-agent-timers.ts`
- Test: `.../lesson-pool-agent-tools.test.ts`

**Interfaces:**
- Consumes: Task 2–11; `isWellShapedRawExercise`, `toExerciseDraft`, `stripParentAddedFlags` (`lesson-drafts.ts`).
- Produces:
  - `LessonAgentPolicy` + `DEFAULT_LESSON_AGENT_POLICY` (wartości z Global Constraints).
  - `deadlineSignal(parent: AbortSignal, ms: number, reason: string): { signal: AbortSignal; dispose(): void }` (`setTimeout` + `AbortController`).
  - `RunCostMeter` (`record(usd|null)`, `spentUsd`, `unknownCalls`, `exhausted(): boolean`, konstruktor `(initialSpentUsd, budgetUsd, unknownEstimateUsd)`) — implementuje `RunCostSink`.
  - `Semaphore(limit)` z `run<T>(fn): Promise<T>` i `maxConcurrent`.
  - `createObjectiveTools(args: { objectiveId: string; getState(): LessonAgentState; setState(state: LessonAgentState): void; ctx: AgentCheckContext; checker: LessonExerciseCheckerProvider; checkerSemaphore: Semaphore; cost: RunCostMeter; objectiveSignal: AbortSignal; policy: LessonAgentPolicy; familyScope: string | null; examplesFromPlan: boolean; onRejection(entry: RejectionLogEntry): void }): { tools: LessonObjectiveAgentTools; close(): Promise<void> }`.
  - `RejectionLogEntry = { objectiveId: string; exerciseType: string; kind: Rejection["kind"]; code: string; detail: string }`.
  - Kody: `shape_malformed`, `shape_objective`, `refused_budget`, `refused_closed`.

Decyzje:
- mutex zagadnienia: kolejka FIFO obietnic w `createObjectiveTools`; każde wywołanie `submit`/`remove` czeka na poprzednie;
- `submit(raw)`: odmowa (`closed`/`objectiveSignal.aborted` → `refused_closed`; `cost.exhausted()` → `refused_budget`) zwraca dla każdego indeksu `errors: ["tools are closed"]` / `["budget exhausted"]`; nie-tablica `exercises` → jeden wynik `{ index: 0, errors: ["exercises must be an array"] }`;
- per rekord: `isWellShapedRawExercise` → `shape_malformed`; `objectiveId` ≠ zagadnienie → `shape_objective`; `toExerciseDraft` → `sanitizeFreshLessonDraft` → `stripParentAddedFlags`;
- `examples` przy `examplesFromPlan` → ignorowane, `examples.errors: ["examples are fixed by the plan"]`; inaczej `submitExamples`;
- checker: `solve` i `judgeVariants` równolegle, każde przez `checkerSemaphore.run`, z `deadlineSignal(objectiveSignal, checkerTimeoutMs)`; `cost.exhausted()` sprawdzane przed każdym; brak pary w odpowiedzi → `unavailable`, nadmiar ignorowany, wyjątek → wszystkie `unavailable`;
- przed `admitBatch`: ponowne sprawdzenie `closed`/`objectiveSignal.aborted` → `refused_closed`; potem `setState(admitBatch(getState(), …).state)` bez `await` pomiędzy;
- `close()`: ustawia `closed = true` natychmiast, potem czeka na kolejkę.

- [ ] **Step 1: Testy** (bez fake'a agenta — narzędzia wołane bezpośrednio; `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync` dla terminów):
  - paczka z błędem → `errors` z powodem; poprawiona → `accepted: "ex1"`;
  - `exercises: "x"` → `["exercises must be an array"]`; obce `objectiveId` → `shape_objective`; `null` w polach → `shape_malformed`; `examples: "x"` → błąd przykładów;
  - checker: wołany tylko dla `pass` i typów polityki, z oczyszczonym szkicem (szkoła: brak `hint` w widoku), jedno `solve` na `submit`; `material` tylko przy `checkerNeedsMaterial`; wejście checkera nie zawiera znaczników z polecenia rodzica, tematów zdań, kart ani przykładów;
  - `solveBatch` krótsza o 1 → ostatnie `unchecked`; dłuższa → nadmiar ignorowany; `null` na pozycji → `unchecked`; `"throw"` → wszystkie `unchecked`;
  - `{ parallel }` odpowiednik: dwa `submit` naraz z `gate` checkera → wynik = sekwencyjny w kolejności wywołań; `submit` i `remove("ex1")` naraz → `removed: ["ex1"]`, pula zgodna z sekwencją;
  - `close()` w trakcie `hang` checkera → `submit` kończy się `refused_closed`, stan bez zmian; wywołanie po `close()` → `refused_closed`;
  - budżet: `RunCostMeter(0, 0.05, 0.02)` po 3 × `record(0.02)` → `exhausted()`, `submit` → `refused_budget`, checker niewołany;
  - wynik dla modelu bez pól szkicu (`answer`, `acceptedAnswers`).
- [ ] **Step 2: FAIL → Step 3: implementacja → Step 4: PASS** — `pnpm exec vitest run --config vitest.unit.config.ts packages/server/src/modules/materials/lessons/lesson-pool-agent-tools.test.ts packages/server/src/modules/module-boundaries.architecture.test.ts`.
- [ ] **Step 5: Commit** — „Lekcje: narzędzia podagenta — mutex, checker, przyjęcie i zamknięcie (#237)”.

### Task 13: Kierownik — przebieg runu

**Files:**
- Create: `packages/server/src/modules/materials/lessons/lesson-pool-agent.ts`; Test: `.../lesson-pool-agent.test.ts`

**Interfaces:**
- Consumes: Task 12; `objectiveBatchCounts`, `listenChoiceAllowance`, `buildPoolInput`, `buildDynamicTopicData`, `withSubjectObjectiveKinds` (`lesson-drafts.ts`); `validateDynamicTopicData`; `classifyLessonGenerationFailure`; `cardExposureSources`; `avoidSentencesFor`.
- Produces:

```ts
interface LessonPoolAgentRunInput {
  readonly runId: string;
  readonly subjectId: string;
  readonly deckId: string;
  readonly objectiveSource: AgentObjectiveSource;
  readonly topicTitle: string;
  readonly material: string;
  readonly instruction?: string;
  readonly interests?: readonly string[];
  readonly poolSize: number;
  readonly graderAvailable: boolean;
  readonly fixed: readonly LessonExerciseDraft[];
  readonly draftExamples: Readonly<Record<string, readonly string[]>>;
  readonly skipObjectives: readonly string[];
  readonly familyScope: string | null;
  readonly initialSpentUsd: number;
  readonly onObjectiveSettled?: (settled: SettledObjective) => Promise<void>;
}
interface SettledObjective {
  readonly objectiveId: string;
  readonly status: "complete" | "incomplete" | "failed";
  readonly missing: readonly string[];
  readonly failure?: { readonly errorCode: string };
  readonly exercises: readonly LessonExerciseDraft[];   // kolejność lekcji
  readonly examples: readonly string[];
  readonly steps: number;
}
interface LessonPoolAgentResult {
  readonly planStatus: "accepted" | "plan_failed" | "not_needed";
  readonly planFailure?: { readonly errorCode: string };
  readonly dynamicTopic?: DynamicTopicData;
  readonly objectives: readonly SettledObjective[];      // kolejność lekcji
  readonly stats: { submitted: number; accepted: number; rejectedByKind: Record<string, number>; checkUnavailable: number; checkerCalls: number; invariantViolations: number; refused: number };
  readonly rejections: readonly RejectionLogEntry[];
  readonly spentUsd: number;
  readonly unknownCostCalls: number;
}
/** Źródło zagadnień — unia rozłączna (każdy wariant niesie swoje dane). */
type AgentObjectiveSource =
  | { readonly source: "planner" }                                      // przedmiot z planGate; temat buduje subject.buildDynamicTopic
  | { readonly source: "catalog"; readonly topic: LessonTopic }        // gramatyka
  | { readonly source: "input"; readonly dynamicTopic: DynamicTopicData }; // szkoła; temat = subject.buildDynamicTopic(dynamicTopic)
function runLessonPoolAgent(
  deps: { agent: LessonPoolAgentProvider; checker: LessonExerciseCheckerProvider; subjects: Pick<SubjectRegistry, "getSubject">; policy?: Partial<LessonAgentPolicy> },
  input: LessonPoolAgentRunInput,
  signal: AbortSignal,
): Promise<LessonPoolAgentResult>;
```

Decyzje:
- `fixedSources` = `mergeExamples(cardExposureSources(subject, topic), input.draftExamples)`; `examples` stanu startowo `{}` (plan wpisuje swoje);
- `targets` per zagadnienie: `targetCount` — `objectiveBatchCounts(poolSize, liczba zagadnień, subject)`; `listenAllowance` — `listenChoiceAllowance(subject, objective, stimuli fixed)`; etapy — `poolStageCounts`; `maxExercises` — `objectiveAgentLimits`, `requiredTypes` z polityki (po filtrze);
- `pool` = `buildPoolInput(...)` z liczbami z `targets`; `avoidSentences` = `avoidSentencesFor({ examples: allExamples(state), exercises: orderedLesson(state), subject })` w chwili startu podagenta; `cardSentences` = wszystkie teksty `allExamples(state)` lekcji;
- plan: `propose(raw)` → `validateAgentPlan` → `buildDynamicTopicData(objectives, subject.id, deckId, topicTitle, validator, ttsForPrompts)` → `withSubjectObjectiveKinds` → `validateDynamicTopicData`; przykłady z planu przypisane po **slugu z tematu** (po sanityzacji); `planMaxSteps` bez przyjęcia → `plan_failed`; wyjątek → `plan_failed` + `classifyLessonGenerationFailure`;
- start podagentów w kolejności lekcji przez `Semaphore(concurrency)`; termin zagadnienia od wejścia do `runObjective`; `onObjectiveSettled` w kolejce szeregowej w kolejności zakończenia; błąd haka → zamknięcie wszystkich narzędzi, przerwanie sygnałów zagadnień, odrzucenie runu tym błędem;
- po wszystkich: `lessonInvariantCheck` → usunięcia, `stats.invariantViolations`, log `invariant_violation`.

- [ ] **Step 1: Testy** (`FakeLessonPoolAgent`, `FakeExerciseChecker`, `agentTestSubject` i `withAgentPolicy(englishChapterSubject)` dla planu):
  - dwa zagadnienia `complete`; `objectives` w kolejności lekcji;
  - `maxSteps` przy scenariuszu bez poprawki → `incomplete` z `missing`;
  - `throw` w jednym zagadnieniu → `failed` z `classifyLessonGenerationFailure(new Error("x")).errorCode`, drugie `complete`;
  - dwa zagadnienia równolegle wysyłają ćwiczenia z tym samym ujawnieniem (checker z `gate`, oba prechecki przed pierwszym przyjęciem) → dokładnie jedno przyjęte, drugie `leak_*`; `invariantViolations === 0`;
  - plan: propozycja z niepokrytym słowem → `errors` zawiera słowo; druga przyjęta; identyfikatory `^.+\.d<deckId>\.[a-z0-9_]{1,40}$`; przykłady z planu w `objectives[i].examples`; brak planu po 8 krokach → `plan_failed`, `agent.calls` bez podagentów; `planObjectives` rzuca → `plan_failed` z kodem;
  - materiał rozdziału bez list → plan przyjęty, zagadnienia `complete` przy pełnych scenariuszach;
  - `objectiveSource: { source: "input", dynamicTopic }`: przykłady przez `submit.examples` → w wyniku; przedmiot rozwiązany przez `deps.subjects.getSubject(subjectId)` (nieznany → `AppError` `validation` bez wywołań);
  - `skipObjectives` + `fixed`: brak wywołania agenta dla pominiętego, jego `fixed` blokuje duplikat w innym;
  - zdanie karty (`withAgentPolicy(englishChapterSubject)`, karta „There is a bed in my room.”) → samodzielne tłumaczenie z tą odpowiedzią `leak_victim`;
  - `targets.targetCount` = `objectiveBatchCounts(...)` (szkoła z `withAgentPolicy(schoolSubject)` → ≥ 8);
  - `onObjectiveSettled`: wołany raz na zagadnienie, szeregowo (asercja: brak nakładania się); rzucony błąd → run odrzucony tym błędem;
  - przedmiot bez polityki → `AppError` z kodem `validation`, `agent.calls` puste.
- [ ] **Step 2: FAIL → Step 3: implementacja → Step 4: PASS** — `pnpm exec vitest run --config vitest.unit.config.ts packages/server/src/modules/materials/lessons/lesson-pool-agent.test.ts packages/server/src/modules/module-boundaries.architecture.test.ts`.
- [ ] **Step 5: Commit** — „Lekcje: kierownik agenta puli — przebieg runu (#237)”.

### Task 14: Kierownik — budżet, terminy, przerwanie i logi

**Files:**
- Modify: `.../lesson-pool-agent.ts`; Test: `.../lesson-pool-agent.limits.test.ts`

- [ ] **Step 1: Testy** (`vi.useFakeTimers()`, `vi.advanceTimersByTimeAsync`; jedno zagadnienie, `checker.costUsd: 0`, chyba że niżej inaczej):
  - `runBudgetUsd: 0.05`, `stepCostUsd: 0.02`, scenariusz 5 × `submit` → 3 wywołania modelu, `spentUsd === 0.06`, `solveCalls.length === 2` (koszt trzeciego wywołania zapisany przed narzędziami wyczerpuje budżet, więc trzeci `submit` dostaje `refused_budget`);
  - przerwanie sygnału zagadnienia po „wywołaniu modelu”, w trakcie `submit` (checker `hang`) → koszt tego wywołania jest w `spentUsd`;
  - `stepCostUsd: null` → `spentUsd === 0.06` po 3 krokach, `unknownCostCalls === 3`;
  - `initialSpentUsd: 0.99`, budżet 1,00 → 1 krok, `spentUsd === 1.01`;
  - granica przekroczenia: `concurrency: 2`, dwa zagadnienia, `stepCostUsd: 0.03`, budżet 0,05 → `spentUsd ≤ 0.05 + 2 × 0.03`;
  - `hang` agenta + `objectiveTimeoutMs: 1000`, przesunięcie 1000 ms → `incomplete`, nie `failed`;
  - termin runu (`runTimeoutMs: 2000`) przy dwóch `hang` → oba `incomplete`, wynik zwrócony;
  - przerwanie sygnału runu `controller.abort("superseded")` → `runLessonPoolAgent` odrzuca `"superseded"`;
  - `agent.maxConcurrent ≤ 4`, `checker.maxConcurrent ≤ 4` przy 6 zagadnieniach;
  - logi (`vi.spyOn(console, "log")`, `vi.spyOn(console, "error")`): żaden wpis nie zawiera unikalnych znaczników z odpowiedzi ćwiczeń, materiału, kart ani `detail`; wpis podsumowania ma format `[lesson-agent] run=<runId> obj=<slug> status=<…> steps=<n> accepted=<n> rejected=<kod:liczba,…> costUsd=<x>`.
- [ ] **Step 2: FAIL → Step 3: implementacja → Step 4: PASS** — `pnpm exec vitest run --config vitest.unit.config.ts packages/server/src/modules/materials/lessons/lesson-pool-agent`.
- [ ] **Step 5: Commit** — „Lekcje: kierownik agenta — budżet, terminy i przerwanie (#237)”.

### Task 15: Narzędzia próby, rejestr kosztów i zależności

**Files:**
- Create (z `git show origin/probe/lesson-pool-agent:<ścieżka>`, bez zmian): `tests/probes/blind/gen-blind-sheet.cjs`, `tests/probes/blind/score.cjs`, `tests/probes/blind/rubric-generation.md`, `tests/probes/blind/rubric-criteria.md`
- Create: `tests/probes/probe-costs.ts`, `tests/probes/probe-costs.test.ts` (z `git show feat/lesson-review-probe:tests/probes/probe-results.ts` / `…probe-results.test.ts` — wyłącznie eksporty z §8 i ich testy)
- Modify: `tests/probes/probe-helpers.ts` — całość zmian z `git diff main feat/lesson-review-probe -- tests/probes/probe-helpers.ts` (`runDirsOf`, `realpathOfNearest`); Create: `tests/probes/probe-helpers.test.ts` (z gałęzi + nowe testy `runDirsOf`: lista katalogów z przecinków, ścieżka w repo → błąd)
- Modify: `vitest.probe.config.ts` (całość diffu z `feat/lesson-review-probe`: `loadDotEnv`, tryby przedmiotów), `vitest.unit.config.ts` (dopisz `tests/probes/probe-costs.test.ts`, `tests/probes/probe-helpers.test.ts`)
- Modify: `package.json`, `pnpm-lock.yaml`, `packages/server/src/providers/openai/llm.ts` (eksport `lessonSystemPrompt`, `lessonUserMaterial`)

- [ ] **Step 1:** `pnpm add -D -w --save-exact ai@7.0.162 @openrouter/ai-sdk-provider@3.1.0 zod@4.6.5`; skrypt `"probe:agent": "vitest run --config vitest.probe.config.ts tests/probes/agent-generation.probe.test.ts"`.
- [ ] **Step 2:** Przenieś pliki. Higiena — tylko przenoszone pliki: `git grep -n -I -E "C:\\\\Users|/home/|[0-9a-f]{8}-[0-9a-f]{4}-" -- tests/probes/blind tests/probes/probe-costs.ts tests/probes/probe-helpers.ts vitest.probe.config.ts` → brak trafień; dodatkowo przeczytaj każdy przenoszony plik pod kątem imion i fragmentów materiałów (nie wpisuj wzorców imion do repo).
- [ ] **Step 3:** `pnpm exec vitest run --config vitest.unit.config.ts tests/probes/probe-costs.test.ts tests/probes/probe-helpers.test.ts tests/ai-sdk-scope.test.ts` — PASS; `pnpm typecheck` — PASS.
- [ ] **Step 4: Commit** — „Próby: narzędzia ślepej oceny, rejestr kosztów i zależności AI SDK (#237)”.

### Task 16: Próba agenta i punkt odniesienia

**Files:**
- Create: `tests/probes/ai-sdk-lesson-agent.ts` (tymczasowe adaptery), `tests/probes/ai-sdk-lesson-agent.test.ts` (test dymny bez sieci), `tests/probes/agent-generation.probe.test.ts`
- Modify: `tests/probes/chapter-generation.probe.test.ts`, `vitest.unit.config.ts` (dopisz test dymny)

**Interfaces:**
- Produces: `AiSdkLessonPoolAgent implements LessonPoolAgentProvider` (konstruktor `{ model: LanguageModel; effort: string }`): `ToolLoopAgent`, narzędzia `submit_exercises` (`jsonSchema` z gałęzi `exercises` i `examples` `lessonPoolJsonSchema(input.pool)`; materializacja `materializeGeneratedAssignments(materializeGeneratedKeywords(materializeGeneratedCalculations(...)))` przed `tools.submit`) i `remove_exercise`; `stopWhen: [isStepCount(maxSteps), () => tools.shouldStop()]`; `maxRetries: 0`; `providerOptions.openrouter.reasoning.effort`; koszt każdego **żądania modelu** `cost.record(providerMetadata?.openrouter?.usage?.cost ?? null)` w callbacku wywołania modelu (`onLanguageModelCallEnd`; nazwę i pola potwierdź w `node_modules/ai/dist/index.d.ts` przypiętej wersji), czyli przed wykonaniem narzędzi kroku; wyjątek wywołania modelu bez odpowiedzi → `cost.record(null)` i ponowne rzucenie. Planer analogicznie z `propose_objectives`. `AiSdkExerciseChecker implements LessonExerciseCheckerProvider` (`{ model; effort }`): `generateText` + `Output.object` (`{ answers: string[][] }` / `{ equivalent: boolean[][] }` po pozycjach), `maxRetries: 0`, koszt jak wyżej.

- [ ] **Step 1: Test dymny** `ai-sdk-lesson-agent.test.ts` (`MockLanguageModelV4` z `ai/test`, bez sieci): model zwraca wywołanie `submit_exercises` → fake narzędzi dostaje zmaterializowane rekordy; `shouldStop()` = `true` kończy pętlę po kroku; `providerMetadata.openrouter.usage.cost: 0.01` → `cost.record(0.01)` zapisane przed wykonaniem narzędzia (narzędzie z opóźnieniem przerwane sygnałem — koszt i tak zapisany); przerwanie sygnału → odrzucenie; checker mapuje `answers` po pozycjach.
- [ ] **Step 2: FAIL → Step 3: implementacja adapterów → Step 4: PASS** — `pnpm exec vitest run --config vitest.unit.config.ts tests/probes/ai-sdk-lesson-agent.test.ts`.
- [ ] **Step 5: Próba** `agent-generation.probe.test.ts` wg §8: zmienne, `describe.skipIf` bez klucza i wejść, nagłówek z opisem uruchomienia i kosztów; prompt podagenta = `lessonSystemPrompt(pool)` + dopisek przepływu narzędzi z PoC (`objectiveInstructions`) + „hint only for lesson_open_answer”; planer + „up to 6 objectives when coverage needs it”; rejestr kosztów (`assertWithinCostCap`, wpis tymczasowy i rozliczenie); na końcu asercje stanu końcowego (`lessonInvariantCheck` pusty, `findExposureLeaks` coverage bez twardych, `validatePool`/`validatePoolExtra` całej lekcji puste) i raport liczby ujawnień w trybie `generation`; zrzut `UMIEM_PROBE_AGENT_DUMP` w formacie PoC + `objectives[].status`, `rejections[].detail`.
- [ ] **Step 6: Punkt odniesienia** — `chapter-generation.probe.test.ts`: `UMIEM_PROBE_POOL_DUMP_OUT` — po `executeLessonGeneration` zrzut końcowego szkicu w formacie arkusza i zrzut zagadnień z kartami `{ title, body }[]` (wejście `UMIEM_PROBE_AGENT_OBJECTIVES_DUMP`); `UMIEM_PROBE_COSTS`, `_COSTS_INIT`, `_OUT_DIR`, `_ALLOW_HOST`, `_SUBJECT` wg `feat/lesson-review-probe`; bez importów z `lesson-review`.
- [ ] **Step 7:** `pnpm typecheck` — PASS; `pnpm exec vitest run --config vitest.probe.config.ts tests/probes/agent-generation.probe.test.ts` bez zmiennych → pominięte, exit 0.
- [ ] **Step 8: Commit** — „Próby: agent puli na kodzie domenowym i zrzut potoku (#237)”.

### Task 17: Dokumentacja, weryfikacja, przebiegi kontrolne i PR

**Files:**
- Modify: `docs/architecture.md` (nowe §19.17 „Agent generujący pulę (etap 1)”), `AGENTS.md`

- [ ] **Step 1: Dokumentacja** — §19.17 wg §10 specu (rdzeń i niezmiennik, `agentPolicy`, porty, kierownik, budżet i terminy, status „za flagą od etapu 2”, `pnpm probe:agent` z ślepą oceną krok po kroku). `AGENTS.md`, „Reguły biznesowe i adaptery”: zdanie o `SubjectModule.agentPolicy` (§19.17) i o tym, że `ai`/`@openrouter/*` są dozwolone tylko w `tests/probes` (od etapu 2 także w jednym adapterze), pilnuje `tests/ai-sdk-scope.test.ts`. Commit — „Dokumentacja: agent generujący pulę — etap 1 (#237)”.
- [ ] **Step 2:** `pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration`, `pnpm build` — PASS.
- [ ] **Step 3:** `pnpm test:e2e:shards` — PASS (raportuj liczby).
- [ ] **Step 4: Zgoda właściciela** — zapytaj w czacie o zgodę na przebiegi kontrolne (ok. 0,65 USD, §9.5) i o ścieżki materiałów (szkoła, rozdział) poza repo. Bez zgody — pomiń kroki 5–6 i zaznacz to w PR.
- [ ] **Step 5: Przebiegi kontrolne** (rejestr `UMIEM_PROBE_COSTS` poza repo, `UMIEM_PROBE_COSTS_INIT` z limitem 2,00, każdy przebieg do osobnego pliku, ścieżki z `/`): (1) `UMIEM_PROBE_SUBJECT=school UMIEM_PROBE_MATERIAL=<szkoła> UMIEM_PROBE_POOL_DUMP_OUT=<dir>/school-base pnpm probe:chapter`; (2) `UMIEM_PROBE_AGENT_SUBJECT=school UMIEM_PROBE_AGENT_OBJECTIVES_DUMP=<dir>/school-base/objectives.json UMIEM_PROBE_AGENT_BUDGET_USD=0.40 UMIEM_PROBE_AGENT_DUMP=<dir>/agent-school/dump.json pnpm probe:agent`; (3) `UMIEM_PROBE_AGENT_MATERIAL=<rozdział> UMIEM_PROBE_AGENT_BUDGET_USD=0.40 UMIEM_PROBE_AGENT_DUMP=<dir>/agent-chapter/dump.json pnpm probe:agent`. Kryteria §9.5 (asercje próby + `node tests/probes/blind/gen-blind-sheet.cjs <dir> 1` czyta zrzuty + rozliczony rejestr). Najwyżej jedno powtórzenie po porażce; niezaliczony przebieg = błąd do poprawy w kodzie, nie strojenie progów.
- [ ] **Step 6:** Trzech niezależnych krytyków na diffie gałęzi (zgodność ze specem; architektura, prywatność, koszty; testy i zakres), poprawki, ponownie Step 2.
- [ ] **Step 7:** Push gałęzi, PR do `main` (nie scalać). Opis po polsku: gdzie są reguły (domena, polityki przedmiotów), zależności (dev, root), zweryfikowane gwarancje (testy, niezmiennik, przebiegi kontrolne z kosztem albo informacja o ich pominięciu), co dokłada etap 2; wpływ API → MCP → `SKILL.md`: brak, z uzasadnieniem.
