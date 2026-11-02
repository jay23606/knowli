# „Posłuchaj i wybierz” (`lesson_listen_choice`) — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nowy typ ćwiczenia lekcji: dziecko słyszy pełne zdanie en-GB i wybiera brakującą formę z opcji (issue #198).

**Architecture:** Typ zamknięty, zawsze wspomagany, poza ścieżką etapów (własny slot selektora `listenPracticePlan`). Bodźcem jest istniejące nagranie `feedback_audio` (#194), wydawane wyłącznie przez autoryzację odsłuchu (`authorizeDisclosure`, ekspozycja przed dźwiękiem). Bez gotowego nagrania typ nie jest wydawany; bez odsłuchu odpowiedź jest nieoceniona.

**Tech Stack:** TypeScript strict, Zod, Drizzle/PostgreSQL, Vitest, React (Kid UI bez Mantine), Mantine 9 (panel rodzica), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-01-lesson-listen-choice-design.md` (wersja 3). Czytaj go razem z planem — plan nie powtarza uzasadnień.

## Global Constraints

- Nazwa typu: `lesson_listen_choice`; powód zadania: `listen_practice`; werdykt wewnętrzny: `no_stimulus`.
- Przedmioty: `english_grammar` i `english_chapter`; `school` i `history-like-subject` bez typu.
- Bez nowej roli zasobu i bez migracji; bodziec = nagranie `feedback_audio` (`feedbackSentenceText`).
- Limity: opcje 2–4 (`MIN_OPTIONS`/`MAX_OPTIONS`), zdanie ≤ 200 znaków (`FEEDBACK_SENTENCE_MAX_LENGTH`), luka = ciąg 2+ podkreśleń, generator ≤ 2 ćwiczeń słuchowych na cel, slot ≤ 1 na cel i ≤ 2 na sesję.
- Kid UI: polecenie „Posłuchaj i wybierz, czego brakuje.”, przycisk `messages.kid.listenExample` („Posłuchaj zdania”), status blokady „Dotknij głośnika, aby posłuchać.”, zapas odblokowania `durationMs + 1000` ms (8000 ms bez długości), „Pomiń” po 6000 ms bez startu odtwarzania.
- Panel rodzica: odznaka typu „Posłuchaj i wybierz”; informacja „Lektor przeczyta zdanie. Dziecko dostanie to zadanie, gdy nagranie będzie gotowe.”; przy błędzie „Nagranie się nie udało. Utwórz nową wersję lekcji, aby spróbować ponownie.”
- Teksty UI wyłącznie w `packages/contracts/src/messages.ts`; kod i identyfikatory po angielsku, komentarze i dokumentacja po polsku.
- Kid UI: tylko wspólne komponenty (`ExerciseFrame`, `ListenButton`, `AnswerGrid`, `ActionButton`), bez surowych `<button>`, bez literałów koloru/rozmiaru poza blokiem tokenów, `calc(N * var(--kid-vh))` zamiast `vh`.
- Granice modułów (`module-boundaries.architecture.test.ts`): domena bez Drizzle/oRPC/SDK; import między obszarami tylko przez barrel.
- Kid DTO nie zawiera klucza, opcji poprawnej ani id nagrania przed autoryzacją.

## Review Focus

1. Dziecko odpowiada w chwili, gdy autoryzacja jeszcze trwa (szybkie kliknięcie) — opcje muszą być zablokowane, a spóźniona autoryzacja zignorowana (Task 12).
2. Nagranie istnieje dla opublikowanej rewizji tylko jako zasób innego szkicu o tym samym fingerprincie — selektor i materializacja muszą zgodnie uznać je za gotowe (Task 8, test „revived”).
3. Sesja zaplanowana z celami kontynuowanymi — nie może zaczynać się serią zadań słuchowych (Task 7, test planu).
4. Rodzic zmienia typ ćwiczenia na słuchowy w edytorze, a ćwiczenie ma `instructionPl`/`hint` — pola znikają, zapis przechodzi (Task 10).
5. Wycofane/stare opcje z apostrofem lub równoważne skróty z generacji — ćwiczenie odrzucone z czytelnym powodem, nie cała partia (Task 3, Task 5).

---

### Task 1: Fundament typu (kontrakty, unia, etap, predykat, komunikaty)

**Files:**
- Modify: `packages/contracts/src/lessons.ts` (`LESSON_EXERCISE_TYPES`, `LessonExerciseDraftDtoSchema` + `sentenceAudio`)
- Modify: `packages/contracts/src/kid.ts` (`EXERCISE_TYPES`, gałąź `TaskPromptSchema`)
- Modify: `packages/contracts/src/messages.ts`
- Modify: `packages/server/src/domain/lessons/types.ts`, `packages/server/src/domain/lessons/stages.ts`
- Modify: `apps/web/src/parent/lessons/lesson-editor-state.ts:26-41` (`STAGE_BY_TYPE`)
- Modify (tylko kompilacja wyczerpujących `switch`): `packages/kid-ui/src/exercises/ExerciseView.tsx`, `packages/kid-ui/src/exercises/exercise-presentation.ts`, `packages/server/src/modules/learning/session-activity.ts`, `packages/server/src/modules/learning/lessons/lesson-mock-tests.ts` (`promptText`)
- Test: `packages/contracts/src/lessons.test.ts`, `packages/contracts/src/kid-lesson.test.ts`, `packages/server/src/domain/lessons/stages.test.ts`

**Interfaces:**
- Produces:
  - `LessonExerciseType` / `LessonExerciseTypeDto` zawierają `"lesson_listen_choice"`.
  - Prompt dziecka: `{ kind: "lesson_listen_choice"; stem: string; options: ChoiceOption[]; contentLocale?: LessonContentLocale }` (`.strict()`, bez `instructionPl`, `audioAssetId`, `questionAudioAssetId`).
  - `LessonExerciseDraftDto.sentenceAudio?: LessonPromptAudioDto` (tylko do odczytu).
  - `stages.ts`: `STAGE_BY_TYPE.lesson_listen_choice = "guided"`; `export function outsideStagePath(type: LessonExerciseType): boolean` — `true` dla `lesson_listen_choice` i `lesson_keywords`.
  - `messages.kid.lessonListenChoiceInstruction = "Posłuchaj i wybierz, czego brakuje."`, `messages.kid.listenStimulusBlocked = "Dotknij głośnika, aby posłuchać."`, `messages.kid.listenStimulusFailed` (ręczny odsłuch nieudany, np. „Nie udało się odtworzyć nagrania.”), `stepType.lesson_listen_choice` i `lessons.exerciseTypes.lesson_listen_choice = "Posłuchaj i wybierz"`, `messages.parent…` dla trzech tekstów rodzica z Global Constraints (klucze obok istniejących tekstów edytora lekcji).

- [ ] **Step 1: Write failing tests** — w `lessons.test.ts` posortowana lista typów zawiera `lesson_listen_choice`; w `kid-lesson.test.ts`: prompt `lesson_listen_choice` z `stem`/`options`/`contentLocale` przechodzi, a z `instructionPl`, `audioAssetId` albo `correctOptionId` jest odrzucany (`.strict()`); w `stages.test.ts`: `stageOf("lesson_listen_choice") === "guided"`, `outsideStagePath` true dla listen i keywords, false dla wszystkich pozostałych typów.
- [ ] **Step 2: Run** `pnpm vitest run packages/contracts/src/lessons.test.ts packages/contracts/src/kid-lesson.test.ts packages/server/src/domain/lessons/stages.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** kontrakty, unię, etap, predykat i komunikaty. Wyczerpujące `switch`e: `ExerciseView` → `return null` (widok w Task 11), `exercise-presentation` → `{ instruction: messages.kid.lessonListenChoiceInstruction, icon: "ear" }`, `session-activity` → jak `lesson_choice` z poleceniem z katalogu, `lesson-mock-tests.promptText` → `stem`.
- [ ] **Step 4: Run** testy z kroku 2 i `pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(lessons): typ lesson_listen_choice w kontraktach i domenie (#198)`.

### Task 2: Zdanie, tożsamość i ekspozycja typu

**Files:**
- Modify: `packages/server/src/domain/lessons/feedback-sentence-text.ts`, `exercise-identity.ts`, `subjects/english-chapter/exposure.ts`
- Test: `feedback-sentence-text.test.ts`, `exercise-identity.test.ts`, `subjects/english-chapter/exposure.test.ts`, `packages/server/src/modules/materials/media-reconciliation.test.ts`

**Interfaces:**
- Produces: `feedbackSentenceText({ exerciseType: "lesson_listen_choice", stem, options, correctOption })` = stem z luką zastąpioną tekstem poprawnej opcji (jak `lesson_choice`). `requiredAssetsForLessonExercise` planuje więc `feedback_audio` bez zmian w media-reconciliation.

- [ ] **Step 1: Write failing tests**
  - `feedbackSentenceText` listen: `"She ___ milk."` + poprawna `doesn't like` → `"She doesn't like milk."`; dwie luki → `null`; > 200 znaków → `null`.
  - Tożsamość: `lessonExerciseIdentity` dla listen = `[objectiveId, "lesson_listen_choice", [normStem, normSentence]]`; „I can see a ___.” z `cat` i z `dog` → różne tożsamości; ten sam stem jako `lesson_choice` → inna tożsamość; `instructionIsStimulus: true` nie zmienia tożsamości listen.
  - `chapterExposureText` listen = jak `lesson_choice` (stem wypełniony poprawną opcją).
  - `requiredAssetsForLessonExercise` (gramatyka, flaga `ttsForFeedbackSentence`) dla listen zwraca `feedback_audio` z pełnym zdaniem; zmiana `correctOption` zmienia fingerprint.
- [ ] **Step 2: Run** `pnpm vitest run packages/server/src/domain/lessons packages/server/src/modules/materials/media-reconciliation.test.ts` — Expected: FAIL w nowych testach.
- [ ] **Step 3: Implement** `case "lesson_listen_choice"` w trzech switchach (w `baseStimulus`: `JSON.stringify([normalizeStimulus(stem), normalizeStimulus(feedbackSentenceText(...) ?? "")])`).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(lessons): zdanie, tożsamość i ekspozycja wyboru ze słuchu`.

### Task 3: Walidacja puli i katalogu

**Files:**
- Modify: `packages/server/src/domain/lessons/pool-validation.ts` (`validateLessonExercise`, `validateByType`, `validatePool`, `poolCoverage`), `catalog-validation.ts` (`validateSubject`, `validateObjective`)
- Test: `pool-validation.test.ts`, `catalog-validation.test.ts`

**Interfaces:**
- Consumes: `outsideStagePath` (Task 1), `feedbackSentenceText` (Task 2), `answersEquivalent` (istniejące).
- Produces: komunikaty błędów (polskie, jak sąsiednie) dla: zakazanych pól, opcji z apostrofem, opcji równoważnych na poziomie zdania, braku/za długiego zdania, zdania równoważnego odpowiedzi ćwiczenia tekstowego.

- [ ] **Step 1: Write failing tests** (`validateLessonExercise`/`validatePool` z `englishGrammarSubject` i tematem Present Simple):
  - poprawne listen (stem `"He ___ football."`, opcje `play`/`plays`) → brak błędów;
  - `instructionPl`, `hint` albo `visualSubject` → błąd;
  - opcja `"'re"` → błąd; opcje `doesn't`/`does not` (zdania równoważne) → błąd; `is`/`are` → OK;
  - dwie luki albo brak luki → błąd; zdanie > 200 znaków → błąd; luka `"__"` (2 podkreślenia) akceptowana;
  - pula z listen o zdaniu `"She doesn't like milk."` i `lesson_open_answer` z odpowiedzią `"She does not like milk"` → błąd na indeksie listen;
  - `poolCoverage`: cel z 3 listen i 0 innych guided → luka pokrycia guided;
  - `validateSubject`: moduł z typem bez `ttsForFeedbackSentence` → błąd; cel, którego jedynym typem guided jest listen → błąd pokrycia.
- [ ] **Step 2: Run** `pnpm vitest run packages/server/src/domain/lessons/pool-validation.test.ts packages/server/src/domain/lessons/catalog-validation.test.ts` — FAIL.
- [ ] **Step 3: Implement** `validateListenChoice(ex, normalizer, errors)` w `validateByType` (opcje przez istniejące `validateOptions`, luka przez `countGapMarkers` z regułą 2+ podkreśleń dla tego typu), sprawdzenie krzyżowe w `validatePool`, wykluczenie w `poolCoverage` przez `outsideStagePath` (zastępując lokalny warunek `lesson_keywords`), kontrole katalogu.
- [ ] **Step 4: Run** testy + `pnpm vitest run packages/server/src/domain/lessons` — PASS.
- [ ] **Step 5: Commit** `feat(lessons): walidacja wyboru ze słuchu w puli i katalogu`.

### Task 4: Przedmioty, katalog gramatyki i rozdział

**Files:**
- Modify: `packages/server/src/domain/lessons/subjects/english-grammar/module.ts`, `topics/present-simple.ts`, `topics/to-be.ts`, `prompts.ts`
- Modify: `subjects/english-chapter/module.ts` (`CHAPTER_EXERCISE_TYPES`, `TYPES_BY_KIND`), `validators.ts` (`checkedElements`, `refineChapterPool`), `prompts.ts`
- Test: `subjects/english-grammar/module.test.ts`, `subjects/english-chapter/module.test.ts`, `subjects/english-chapter/validators.test.ts`, `registry.test.ts`

**Interfaces:**
- Produces: grammar `ALL_EXERCISE_TYPES` + listen; listen w `exerciseTypes` celów: Present Simple — forma podstawowa, `third_person_s`, przeczenie `don't/doesn't`, pytanie `Do/Does`; „to be” — formy `am/is/are` i przeczenie (identyfikatory odczytaj z plików tematów; cele pisowni `-es/-ies` i krótkich odpowiedzi bez typu). Wersje tematów bez zmian. Chapter: typ w obu rodzajach; `checkedElements` jak `lesson_choice`; typ poza `STIMULUS_IN_INSTRUCTION` i `VARIANT_TYPES`.
- `prompts.ts` obu przedmiotów: `typeRules`/`fieldRules` z regułą typu ze specu §5 (≤ 12 słów, jedna luka na elemencie sprawdzanym, 2–3 słyszalnie różne opcje, bez równoważnych, bez apostrofu na początku, bez `instructionPl`).

- [ ] **Step 1: Write failing tests** — `validateSubject(englishGrammarSubject)` i `validateSubject(englishChapterSubject)` puste; lista typów celu `third_person_s` zawiera listen, cel pisowni `-es/-ies` nie; `buildDynamicTopic` rozdziału daje listen w `words` i `frame`; walidator rozdziału dla listen sprawdza słowo z materiału (`checkedElements`) i nie wymaga bodźca w poleceniu; wersje tematów niezmienione (`presentSimpleV1.version`, `toBeV1.version` jak przed zmianą).
- [ ] **Step 2: Run** `pnpm vitest run packages/server/src/domain/lessons/subjects packages/server/src/domain/lessons/registry.test.ts` — FAIL.
- [ ] **Step 3: Implement** listy typów, walidatory i reguły promptów.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(lessons): wybór ze słuchu w gramatyce i rozdziale`.

### Task 5: Generacja (port, prompt, schemat, czyszczenie, fake)

**Files:**
- Modify: `packages/server/src/ports/ai.ts` (`LessonPoolInput`), `packages/server/src/modules/materials/lessons/lesson-drafts.ts` (`buildPoolInput`, przetwarzanie świeżego wyjścia przed walidacją), `packages/server/src/providers/openai/llm.ts`, `packages/server/src/providers/openai/lesson-pool-schema.ts`, `packages/server/src/providers/fake.ts`
- Modify: `apps/web/src/parent/lessons/*` — dopisek w formularzu tworzenia lekcji (tekst z `messages`)
- Test: `llm.test.ts`, `lesson-pool-schema.test.ts`, `providers/fake` testy, `lesson-drafts` unit test (jeśli istnieje) albo `tests/integration/lesson-generation.test.ts`

**Interfaces:**
- Produces: `LessonPoolInput.listenChoicePerObjective?: number` (0–2). `buildPoolInput` ustawia `2`, gdy przedmiot ma `ttsForFeedbackSentence`, a typ jest na liście celu partii; inaczej pole pominięte.
- `export function stripListenChoiceExtras(draft: LessonExerciseDraft): LessonExerciseDraft` w `packages/server/src/domain/lessons/material-creation.ts` — usuwa `instructionPl`, `hint`, `visualSubject` z ćwiczeń listen; wołane wyłącznie na świeżym wyjściu modelu (generacja i dogenerowanie), nie w edycji/publikacji.

- [ ] **Step 1: Write failing tests**
  - prompt `llm.ts` przy `listenChoicePerObjective: 2` zawiera `at most ${count + 2}` i zdanie o dodatkowych `lesson_listen_choice` poza podziałem; menu etapów nie zawiera typu; opis pól zawiera regułę typu; przy braku pola prompt bez zmian (snapshot/asercja istniejącego tekstu);
  - schemat puli dopuszcza `exerciseType: "lesson_listen_choice"` w zwykłej gałęzi;
  - `stripListenChoiceExtras` usuwa trzy pola tylko z listen;
  - fake provider z `listenChoicePerObjective: 2` zwraca 2 poprawne ćwiczenia listen na cel, które przechodzą `validatePool`;
  - integracja generacji (fake): szkic gramatyki zawiera ćwiczenia listen, liczba odrzuconych = 0.
- [ ] **Step 2: Run** `pnpm vitest run packages/server/src/providers packages/server/src/domain/lessons/material-creation.test.ts` — FAIL.
- [ ] **Step 3: Implement** pole portu, prompt, schemat, czyszczenie, fake, dopisek panelu.
- [ ] **Step 4: Run** testy + `UMIEM_INTEGRATION_BUCKET=<kosz z lesson-generation> pnpm test:integration` (albo pojedynczy plik przez `vitest.integration.config.ts`) — PASS.
- [ ] **Step 5: Commit** `feat(lessons): generacja ćwiczeń wyboru ze słuchu`.

### Task 6: Stan nagrania zdania w DTO rodzica

**Files:**
- Modify: `packages/server/src/modules/materials/lessons/lesson-prompt-audio.ts` (`readLessonAudioStates`), `lesson-api.ts` (`readLessonDraftDto`)
- Test: `tests/integration/lesson-sentence-audio.test.ts` (albo nowy `tests/integration/lesson-listen-choice.test.ts` — dopisz do najlżejszego kosza w `tests/integration-buckets.ts`)

**Interfaces:**
- Produces: `readLessonAudioStates(...)` zwraca dodatkowo `sentences: Map<itemRevisionId, LessonPromptAudioDto>` (rola `feedback_audio`, ten sam `audioDto` i filtr `notCancelled`); `readLessonDraftDto` dołącza `sentenceAudio` wyłącznie do ćwiczeń `lesson_listen_choice`. `assets` nadal pomija `feedback_audio`.

- [ ] **Step 1: Write failing integration tests** — szkic z listen i z `lesson_choice`: listen ma `sentenceAudio.state === "pending"`, po oznaczeniu zasobu `ready` → `ready` z `assetId`, po `failed` → `failed`; `lesson_choice` nie ma pola; `assets` nie zawiera `feedback_audio`.
- [ ] **Step 2: Run** plik integracyjny — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(lessons): stan nagrania zdania ćwiczenia słuchowego dla rodzica`.

### Task 7: Selektor — slot ćwiczenia słuchowego (rdzeń funkcyjny)

**Files:**
- Modify: `packages/server/src/domain/lessons/scheduler.ts`, `mock-test-plan.ts`
- Test: `scheduler.test.ts`, `mock-test-plan.test.ts`

**Interfaces:**
- Consumes: `outsideStagePath` (Task 1).
- Produces:
  - `LessonExerciseCandidate.stimulusAudioReady?: boolean` (brak = niegotowe).
  - `LessonTaskReason` + `"listen_practice"`.
  - `function listenPracticePlan(input: LessonScheduleInput): LessonTaskPlan | null` wołana w `selectLessonTask` po `precisionPracticePlan`, przed priorytetem 4 (kontynuacja). Warunki: §3.2 specu (zwykłe ocenione zadanie celu w sesji — wydane lub zaplanowane, bez typów `outsideStagePath`; brak listen celu w sesji; < 2 listen w sesji; brak oczekującego wsparcia celu; kandydat listen celu z `stimulusAudioReady === true`, `orderBySeen`; `assessedRemaining > 0`). Plan: `exercisePlan(candidate, "listen_practice", false)`.
  - `pickExercise` wyklucza `outsideStagePath` (zamiast warunku na `lesson_keywords`); limit `plannedAtStage` i `buildSessionState` pomijają typy `outsideStagePath` (brak zmiany `stageStreak`, brak `supportPending`); `initialStatus` (gałąź bez snapshotu) pomija je przy wyborze pierwszego zadania.
  - `planLessonMockTest` nie wybiera listen.

- [ ] **Step 1: Write failing tests**
  - slot po pierwszym zwykłym zadaniu celu (dynamicznie i w `planningMode`); nie przed nim, także dla celu kontynuowanego/`mastered`;
  - ≤ 1 na cel, ≤ 2 na sesję (3 cele → 2 sloty);
  - kandydat bez `stimulusAudioReady` albo z `false` → brak slotu, sesja idzie dalej zwykłym zadaniem;
  - nigdy `introduce` ani ćwiczenie cyklu wsparcia (`pendingSupportExercise` bierze zwykłe guided, nawet gdy listen jest niewidziane);
  - `incorrect` na listen nie otwiera wsparcia; dwa `correct` na listen nie awansują etapu;
  - `assessedRemaining === 0` → brak slotu;
  - sesja bez `initialProgress`, której pierwszym zadaniem celu był listen → cel nie jest traktowany jako nowy;
  - `planLessonMockTest` z pulą zawierającą listen nie zwraca listen.
- [ ] **Step 2: Run** `pnpm vitest run packages/server/src/domain/lessons/scheduler.test.ts packages/server/src/domain/lessons/mock-test-plan.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** + `pnpm vitest run packages/server/src/domain` — PASS.
- [ ] **Step 5: Commit** `feat(lessons): slot ćwiczenia słuchowego w selektorze`.

### Task 8: Sesja — gotowość, materializacja, próba (powłoka)

**Files:**
- Create: `packages/server/src/modules/learning/lessons/listen-stimulus.ts`
- Modify: `lesson-sessions.ts` (kandydaci, `historicalSupportObjectives`), `lesson-materialize.ts`, `lesson-attempts.ts` (`assertModalityMatchesExercise`, `assistanceFor`, ocena), `lesson-mock-tests.ts:220` (lista guided), `session-activity.ts` (`lessonAnswerValues`)
- Test: `tests/integration/lesson-listen-choice.test.ts` (Task 6), `lesson-materialize.test.ts`

**Interfaces:**
- Produces:
  - `export function listenStimulusAssetId(exercise: LoadedExercise, subject: SubjectModule, mode: "training" | "mock_test"): string | null` — `subject.ttsForFeedbackSentence && mode === "training" ? exercise.feedbackAudioAssetId ?? null : null`.
  - Kandydaci w `lesson-sessions.ts`: `stimulusAudioReady: listenStimulusAssetId(e, subject, "training") !== null` tylko dla listen.
  - Materializacja `case "lesson_listen_choice"`: prompt z Task 1, opcje jak `lesson_choice` (UUID + `seededShuffle`), klucz jak `lesson_choice` + `feedbackAudioAssetId` (z helpera; `null` → `AppError("internal")`) + `sentenceTargetKey: lessonTextTargetKey(subject, sentence)`; `exposures: [targetKey, sentenceTargetKey]` bez duplikatu.
  - `LessonTaskAnswerKey.sentenceTargetKey?: string`.
  - Ocena: `modality: "choice"` dozwolona; `assistanceFor` dodaje `options` dla listen; `function noStimulusGrade(key: LessonTaskAnswerKey, assistance: readonly AssistanceKind[]): LessonGradeResult | null` — dla listen bez `model_audio` i modalności ≠ `skip`: `{ grade: { outcome: "unevaluated", verdict: "unavailable" }, feedback: { kind: "not_assessed" }, exposures: [], details: { objectiveId, verdict: "no_stimulus" } }`; wołana przed `gradeLessonAnswer` w obu ścieżkach (`lesson-attempts.ts:1046`, `:1282`).
  - `historicalSupportObjectives` pomija wiersze z `payload.exerciseType === "lesson_listen_choice"`.

- [ ] **Step 1: Write failing tests**
  - integracja: plan sesji (`createLessonTrainingSessionPlan`) z gotowym nagraniem zawiera listen z `reason: "listen_practice"`; bez gotowego — nie zawiera i sesja startuje;
  - zasób gotowy tylko jako generacja z innego szkicu (ten sam fingerprint) → slot jest planowany („revived”);
  - wydane zadanie: Kid DTO bez id nagrania i klucza; ekspozycje przy wydaniu = `[targetKey, sentenceTargetKey]`;
  - odpowiedź bez autoryzacji odsłuchu → `not_assessed`, zadanie `issued`, brak oceny celu;
  - poprawna odpowiedź po `audio_issued` → `assistance` zawiera `options` i `model_audio`, próba niesamodzielna, feedback `great` z `correctAudioAssetId`;
  - błędna odpowiedź → brak karty wsparcia w tej sesji; w następnej sesji `historicalSupportObjectives` nie zawiera celu; poprawna listen po prawdziwym błędzie `lesson_gap` nie kasuje wsparcia;
  - kartkówka nie wydaje listen;
  - ćwiczenie samodzielne z odpowiedzią równą zdaniu listen → po zadaniu listen `answerPreviouslyExposed === true`.
- [ ] **Step 2: Run** plik integracyjny i `lesson-materialize.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** + `pnpm vitest run packages/server/src/modules/module-boundaries.architecture.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(lessons): wydanie i ocena zadań wyboru ze słuchu`.

### Task 9: Autoryzacja odsłuchu bodźca

**Files:**
- Modify: `packages/server/src/modules/learning/events.ts` (`authorizeDisclosure`)
- Test: `tests/integration/lesson-listen-choice.test.ts`

**Interfaces:**
- Consumes: klucz zadania z Task 8 (`feedbackAudioAssetId`, `sentenceTargetKey`).
- Produces: gałąź przed `LESSON_AUDIO_TEXT_TYPES`: dla `lesson_listen_choice` i `kind: "audio"` — 409 przy `mock_test`, braku flagi przedmiotu albo `feedbackAudioAssetId`; zapis `audio_issued` z `exposures: [targetKey, sentenceTargetKey]` (bez duplikatu); odpowiedź `{ ..., audioAssetId: feedbackAudioAssetId }`. Bez rezerwacji/`spoilsCheck`.

- [ ] **Step 1: Write failing tests** — autoryzacja zwraca `audioAssetId`, zapisuje zapieczętowane `audio_issued` z dwoma kluczami i `occurredAt` przed późniejszą odpowiedzią; druga autoryzacja → nowe zdarzenie (`stepId` `:d2`); po odpowiedzi (zadanie nie `issued`) → 409; zadanie `lesson_choice` nadal odrzucane jak dziś.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(lessons): autoryzacja odsłuchu zdania w wyborze ze słuchu`.

### Task 10: Edytor rodzica

**Files:**
- Modify: `apps/web/src/parent/lessons/lesson-editor-state.ts` (`STEM_TYPES`, `OPTION_TYPES`, czyszczenie pól przy zmianie typu), `LessonExerciseCard.tsx` (`STEM_LABEL_TYPES`, odznaka, odznaka audio + „Posłuchaj” dla `sentenceAudio`, informacja, tekst błędu), `LessonEditor.tsx` (licznik ćwiczeń słuchowych bez gotowego nagrania)
- Test: `apps/web/src/parent/lessons/lesson-editor-state.test.ts`, test komponentu karty (jeśli istnieje wzorzec), `tests/e2e/parent-lesson-editor-layout.spec.ts`

**Interfaces:**
- Consumes: `sentenceAudio` (Task 6), teksty z Task 1.
- Produces: brak `PromptAudioControls` i regeneracji dla listen; `canRegenerate` nie dotyczy.

- [ ] **Step 1: Write failing tests** — stan edytora: zmiana typu na listen usuwa `instructionPl`/`hint`/`visualSubject`, zachowuje `stem`/`options`/`correctOption`; serializacja listen do `LessonExerciseInput` przechodzi schemat; E2E layout: karta listen z odznaką i informacją mieści się bez przepełnienia (wzorzec istniejących asercji pliku), odznaka `failed` pokazuje tekst naprawy.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/parent/lessons` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** unit + `UMIEM_E2E_WEB_MODE=dev pnpm exec playwright test tests/e2e/parent-lesson-editor-layout.spec.ts` — PASS.
- [ ] **Step 5: Commit** `feat(parent): edycja ćwiczeń wyboru ze słuchu i stan nagrania`.

### Task 11: Widok Kid UI

**Files:**
- Create: `packages/kid-ui/src/exercises/lesson/LessonListenChoiceView.tsx`
- Modify: `ExerciseView.tsx`, `exercises/types.ts` (`ExerciseProps.listenStimulus`), `screens/LearnScreen.tsx` (przekazanie stanu, `feedbackAudio` i ikona „?”), `styles.css` (luka i status — tylko tokeny)
- Test: `packages/kid-ui/src/exercises/lesson/lesson-views.test.tsx`, `tests/kid-design-tokens.test.ts` (bez zmian w regułach), test kompletności prezentacji

**Interfaces:**
- Produces: `ExerciseProps.listenStimulus?: { state: "pending" | "blocked" | "unavailable" | "open"; playing: boolean } | null` (z kontrolera, Task 12).
- Widok: `ExerciseFrame` z `instructionAudio={{ ref, disabled, onPlay }}` (fokus po wyświetleniu, `useChoiceKeyboard({ onPlay })`), zdanie przez `splitGap` z luką o dostępnej nazwie, `AnswerGrid` z `optionLang`, `disabled = busy || state !== "open"`; status `role="status"` z `messages.kid.listenStimulusBlocked` przy `blocked`; „Pomiń” (`ActionButton` → `handlers.onSkip`) przy `unavailable`; po odpowiedzi `onPlay = feedbackAudio?.onPlay ?? handlers.onPlay`, aktywny tylko z `feedbackAudio`.
- `LearnScreen`: dla listen `sentenceAudio = null` (dok bez własnego przycisku), `GuidanceButton icon="question"`, gdy `feedbackAudio` jest dostępne; `feedbackAudio` dla listen używa `controller.playSentenceAudio()`.

- [ ] **Step 1: Write failing tests** (`lesson-views.test.tsx`): render z `state: "pending"` → opcje `disabled`, przycisk aktywny i sfokusowany; `open` → opcje aktywne, klik wysyła `onAnswerChoice`; `blocked` → status z tekstem; `unavailable` → „Pomiń” wywołuje `onSkip`; luka nie renderuje `___`; `lang` na zdaniu i opcjach; po feedbacku z `feedbackAudio` przycisk aktywny i woła jego `onPlay`, bez — nieaktywny; Spacja woła `onPlay`.
- [ ] **Step 2: Run** `pnpm vitest run packages/kid-ui/src/exercises` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** + `pnpm vitest run tests/kid-design-tokens.test.ts tests/kid-no-mantine.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(kid-ui): widok Posłuchaj i wybierz`.

### Task 12: Kontroler sesji — autoodtwarzanie i blokada opcji

**Files:**
- Modify: `packages/kid-ui/src/session/session-controller.ts`
- Test: `packages/kid-ui/src/session/session-controller.test.ts`

**Interfaces:**
- Produces:
  - Stan ekranu nauki: `listenStimulus?: { taskId: string; state: "pending" | "blocked" | "unavailable" | "open"; playing: boolean } | null`.
  - `async playListenStimulus(): Promise<void>` — autoryzacja (`authorizeDisclosure(taskId, "audio")`) → `#playCountedAudio(mediaUrl(audioAssetId))` z kontrolą `#playbackGeneration`, epoki i `taskId`; `playTaskAudio()` deleguje do niej dla `lesson_listen_choice`.
  - Odblokowanie (`state: "open"`) po rozstrzygnięciu `play()` przy niezmienionej generacji albo po `durationMs + 1000` ms od `onStarted` (8000 ms bez długości); stoper 6000 ms od żądania autoryzacji bez startu → `unavailable` (opcje nadal zablokowane, przycisk działa); `NotAllowedError` → `blocked`; 4xx/błąd pliku przy autoodtwarzaniu → `unavailable` bez komunikatu; błąd ręcznego odsłuchu → `listenStimulusFailed` w statusie; błąd sieci → istniejąca ścieżka offline; po powrocie z offline bez autoodtwarzania.
  - Autoodtwarzanie w `#loadNext` (także zadanie z prefetchu) tylko dla listen, nie w `mock_test`, nie przy `pendingAttemptId`. Stan `open` raz osiągnięty zostaje do końca zadania (także przy ponowieniu po `not_assessed`).

- [ ] **Step 1: Write failing tests** (fake API i fake player jak w istniejących testach kontrolera):
  - wyświetlenie listen → 1 autoryzacja, potem odtworzenie; stan `pending` → `open` po końcu;
  - powtórka w połowie (nowe `playListenStimulus` zanim pierwsze się skończy) → stan nadal `pending` do końca drugiego;
  - `onStarted(3000)` i brak końca → `open` po 4000 ms (fake timers); bez długości → po 8000 ms;
  - autoryzacja wisi 6000 ms → `unavailable`;
  - `NotAllowedError` → `blocked`; 409 → `unavailable`, brak ekranu błędu; błąd sieci → `offline`;
  - odpowiedź w trakcie autoryzacji jest niemożliwa (stan `pending`), a spóźniona autoryzacja po zmianie zadania nic nie odtwarza;
  - brak autoodtwarzania w `mock_test` i przy `pendingAttemptId`; `lesson_choice` bez autoodtwarzania.
- [ ] **Step 2: Run** `pnpm vitest run packages/kid-ui/src/session/session-controller.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** + `pnpm vitest run packages/kid-ui` — PASS.
- [ ] **Step 5: Commit** `feat(kid-ui): autoodtwarzanie zdania i blokada opcji do odsłuchu`.

### Task 13: E2E `mocked` — zachowanie i geometria

**Files:**
- Create: `tests/e2e/lesson-listen-choice.spec.ts`
- Modify: `tests/e2e/spec-projects.ts` (`MOCKED_SPECS`), `tests/e2e/helpers/lesson-audio.ts` (builder zadania listen), `tests/e2e/kid-layout-stability.spec.ts`
- Test: same specs + `tests/e2e/spec-projects.test.ts`

**Interfaces:**
- Consumes: `installKidUiFixture`, `waitForKidScale`, `expectFrameFillsViewport` (`tests/e2e/helpers/kid-frame.ts`).

- [ ] **Step 1: Write specs**
  - zachowanie: liczba POST autoryzacji (autoodtwarzanie 1, powtórka 2, powtórka po odpowiedzi 0 nowych); brak GET nagrania przed autoryzacją; opcje `disabled` do końca odsłuchu; zablokowane autoodtwarzanie → status i przycisk; 409 → „Pomiń”; opóźnione nagranie (route z opóźnieniem > 6 s) → „Pomiń”; offline → ekran offline; Spacja powtarza; fokus na przycisku; po odpowiedzi odczyt zdania, przycisk w poleceniu odtwarza nagranie feedbacku, ikona „?” w doku;
  - geometria (zdanie 200 znaków, 4 opcje): prostokąty przycisku, zdania i opcji w oknie i kontenerze materiału, brak przepełnienia poziomego, cele ≥ 48 px — 390×844, 812×375, 1024×768 i 1280×800 z `pointer: coarse` (≥ 960×480), 1440×900, skala > 1 (`waitForKidScale`), także w stanach `blocked` i „Pomiń”;
  - stabilność: prostokąty przycisku, zdania i opcji nie przesuwają się między zadaniem a dokiem.
- [ ] **Step 2: Run** `UMIEM_E2E_WEB_MODE=dev pnpm exec playwright test tests/e2e/lesson-listen-choice.spec.ts tests/e2e/kid-layout-stability.spec.ts --project=mocked` i `pnpm vitest run tests/e2e/spec-projects.test.ts` — PASS (popraw implementację Task 11–12, jeśli spec wykazuje błąd).
- [ ] **Step 3: Commit** `test(e2e): wybór ze słuchu — zachowanie i geometria`.

### Task 14: E2E `real` — przepływ lekcji

**Files:**
- Modify: `tests/e2e/lesson-real-flow.spec.ts`

- [ ] **Step 1: Write test** — lekcja gramatyki z fake providera (z ćwiczeniami listen) opublikowana; test czeka, aż `feedback_audio` ćwiczeń listen jest `ready` (przez API rodzica `sentenceAudio`), startuje sesję i prowadzi ją do slotu `listen_practice` (po pierwszym zwykłym zadaniu celu); sprawdza autoodtwarzanie (autoryzacja w sieci), odpowiedź i odczyt zdania; wynik w nadzorze rodzica.
- [ ] **Step 2: Run** `pnpm exec playwright test tests/e2e/lesson-real-flow.spec.ts --project=real` — PASS.
- [ ] **Step 3: Commit** `test(e2e): przepływ lekcji z wyborem ze słuchu (real)`.

### Task 15: Dokumentacja

**Files:**
- Modify: `.kiro/specs/grammar-module/requirements.md` (2.1, 2.13, 4.1, 4.3, 4.6, 5.2 — brzmienia ze specu §10), `docs/SPEC.md` §22 i lista typów lekcji, `docs/architecture.md` sekcja 19, `docs/superpowers/specs/2026-10-30-english-chapter-design.md` (typ w rodzajach zagadnień), `docs/superpowers/specs/2026-10-30-lesson-sentence-readback-design.md` §11 (punkt 2 zrealizowany), `AGENTS.md` (pomiar E2E, jeśli zmieni się liczba testów — tylko gdy uruchomiony pełny przebieg)
- Test: wyszukanie użyć MCP: `grep -rn "exerciseType\|lesson_" integrations/umiem-mcp apps/web/src/integrations` — brak wpływu; zapis wyniku do opisu PR.

- [ ] **Step 1: Update documents.**
- [ ] **Step 2: Verify** brak wpływu na MCP (wyszukanie) i spójność nazw z kodem.
- [ ] **Step 3: Commit** `docs: wybór ze słuchu w wymaganiach, SPEC i architekturze (#198)`.

---

## Weryfikacja końcowa (przed review końcowym)

- `pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration`, `pnpm build`, `pnpm test:e2e:shards` — wszystkie zielone; wyniki w raporcie.
- Raport: reguły w `domain/lessons` (walidacja, selektor), `learning/lessons` (gotowość, materializacja, ocena), `learning/events.ts` (autoryzacja); bez nowych zależności; niezweryfikowane: autoodtwarzanie na fizycznym iPhonie/iPadzie i słyszalność różnic form w głosie lektora.
