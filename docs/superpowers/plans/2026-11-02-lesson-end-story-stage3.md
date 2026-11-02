# Historyjka lekcji — etap 3 (sesja i Kid UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sesja treningowa lekcji gramatyki kończy się zatwierdzoną historyjką
z odczytem lektora, a potem 1–2 pytaniami o treść. Pytania są oceniane od razu,
ale poza budżetem, postępem reguł i cyklem wsparcia. Baner zapowiada
„Jeszcze N i historyjka!”, a historyjka wychodzi także po limicie czasu.

**Architecture:**
- Plan sesji (`createLessonTrainingSessionPlan`, `learning/lessons`) dokleja na
  końcu sloty `lesson_story` i `lesson_story_question` (`assessed: false`,
  `taskKind: "story" | "story_question"`), kotwiczone w rewizji pierwszego
  ćwiczenia pierwszego celu, jak karty. Sloty buduje czysta funkcja
  `lessonStorySlots` (nowy plik `learning/lessons/lesson-story-tasks.ts`).
- `nextTask` (`learning/sessions.ts`) zamiast `null` na końcu sesji (budżet albo
  miękki limit czasu) wydaje pierwszy niewydany slot historyjki.
- Odpowiedź na pytanie: osobna funkcja `answerStoryQuestion`
  (`learning/lessons/lesson-story-attempts.ts`) w transakcji pod blokadą sesji:
  próba, przejście zadania, `feedback_issued` bez ekspozycji; bez `assessments`.
- Jeden predykat `isNonAssessedLessonTaskType` (domena) i jego lista SQL
  zastępują literały `lesson_card` w licznikach „ocenianych”.
- Kid UI: `LessonStoryView` (na układzie `LessonCardView`) i
  `LessonStoryQuestionView` (pytanie → `AnswerGrid` → historyjka), ciche
  autoodtwarzanie raz po zamontowaniu panelu, baner z `TaskDto.closingStory`.

Granice transakcji się nie zmieniają: plan przy `startSession`, wydanie
w `nextTask`, odpowiedź w jednej transakcji próby. Zależności: `learning` czyta
`lesson_story_assets` (tabela `materials`) własnym zapytaniem, jak dziś
`lesson_card_assets` (`loadLessonCardAudio`); `reporting` używa predykatu
z domeny. Nowych zależności pakietów brak.

**Tech Stack:** TypeScript strict, Drizzle + PostgreSQL (migracja SQL pisana
ręcznie z wpisem w `_journal.json`), Zod, Vitest, React + Motion (Kid UI),
Playwright.

**Spec:** `docs/superpowers/specs/2026-11-01-lesson-end-story-design.md` —
§8, §9, §10, §12 (2.13, 5.4, wymaganie 12 pkt 10–12, AGENTS.md, SPEC,
architecture §19), §13, §14, §15 (Unit, Kid UI, Integracja „Sesja”, E2E),
§16 „Etap 3”; ustalenia etapu 1 w §6.2a.

## Global Constraints

- Kod, identyfikatory i DTO po angielsku; teksty UI po polsku
  w `packages/contracts/src/messages.ts`.
- Silnik lekcji nie zna przedmiotów: zachowanie włącza wyłącznie
  `SubjectModule.lessonStory`; żadnych literałów `english_grammar`
  w `modules/learning/lessons`, `modules/materials/lessons`, `domain/lessons`
  (pilnuje `domain/lessons/architecture.test.ts`).
- Kid DTO nie ma klucza: prompt historyjki i pytania nie niesie
  `correctOption`, id opcji z wersji ani `targetKey`. Opcje dostają nowe UUID
  przy budowie planu.
- Ekspozycje zdań historyjki są zapisane w transakcji wydania, przed odpowiedzią
  HTTP (`prompt_issued`, `revealsTargetKeys` slotu). Feedback pytania:
  `feedback_issued` z `exposures: []`.
- Pytanie historyjki nie tworzy `assessments`, nie zmienia projekcji, serii,
  cyklu wsparcia ani licznika wywołań modelu; nie ma nagrania zdania ani modelu
  oceniającego. Akceptowana jest wyłącznie modalność `choice`.
- Historyjka nie zużywa budżetu: `remainingAssessed = 0` na zadaniach historyjki,
  liczniki „ocenianych” używają predykatu.
- Brak historyjki: kartkówka, ścieżka bez planu (stare sesje), przedmiot bez
  flagi, wersja bez historyjki, plan bez ocenianego slotu. Okno wznowienia
  (30 min) i `endSession` historyjki nie wydają.
- Kid UI: wyłącznie wspólne komponenty (`ExerciseFrame`, `ActionButton`,
  `AnswerGrid`, `QuestionAudioButton`, `AnswerFeedback*`), bez surowych kontrolek,
  bez literałów koloru, rozmiaru, wagi i promienia poza blokiem tokenów; ruch
  tylko przez Motion i tylko `transform`/`opacity`.
- Inny obszar importuje tylko z barrela; po zmianach w `modules/` najpierw
  `module-boundaries.architecture.test.ts`.
- Nowe pola DTO są opcjonalne albo poszerzają zakres (`remainingAssessed ≥ 0`).
- Commity kończą się linią `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

### Ustalenia planowania (rulings)

Rozbieżności między specem a kodem; obowiązują w tym etapie, a Task 8 wpisuje je
do specu jako uzupełnienie §8 („Uzupełnienie z planowania etapu 3”).

1. **Wybór slotu bez dodatkowego zapytania.** Spec §8.2 każe szukać pierwszego
   slotu, którego `taskId` nie ma w `session_tasks`. Gorąca ścieżka `nextTask`
   ma budżet zapytań (`tests/integration/task-transition-queries.test.ts`:
   `nextTask (lekcja, plan)` ≤ 12), więc zbiór wydanych id zastępują liczniki
   prefiksów z tego samego zapytania (`sessionActivityAndCounts` dostaje
   licznik `story`). Inwariant (testowany): sloty spoza historyjki wychodzą
   wyłącznie po kolei, a sloty historyjki — wyłącznie po kolei i jako sufiks.
   Wydane sloty spoza historyjki = `planned − story`; wydane sloty historyjki =
   `story`. Gdy historyjka już ruszyła, wychodzą tylko jej sloty (pominięte
   oceniane nigdy już nie wychodzą).
2. **„Skróć” to trener precyzji, nie skracanie sesji.** `lesson-shorten.ts`
   tworzy zadanie następcze „Skróć odpowiedź” i nie usuwa slotów; funkcji
   skracania sesji w kodzie nie ma. Jedyne założenie indeksu to rezerwacja
   wywołań gradera `plan.slots.slice(counts.planned)` — poprawiamy ją na
   niewydane sloty spoza historyjki (wspólny helper z punktu 1). Test specu
   „Skróć zachowuje historyjkę” zastępuje test jednostkowy helpera.
3. **Kolejność opcji pytania:** nie `seededShuffle(taskId)`. Ziarno wyliczalne
   z publicznego `taskId` pozwala klientowi odtworzyć pozycję poprawnej opcji
   (komentarz `materializeExercise`). Używamy domyślnego ziarna `lesson_choice`:
   `${taskId}:${randomUUID()}`; kolejność zamraża plan przy starcie, więc ponowny
   odczyt jest stabilny.
4. **Ujawnienia (§8.4).** Kontrakt ma tylko `audio | hint` (bez `distractors`),
   a kod już dziś odrzuca oba dla `lesson_card` (allowlisty
   `LESSON_AUDIO_TEXT_TYPES` i `LESSON_HINT_TYPES` w `events.ts`) — luki
   opisanej w specu nie ma. Dodajemy jawny strażnik predykatem na początku
   `authorizeDisclosure` (409 `conflict`, jak istniejące odmowy) i testy dla
   trzech typów. Realna luka tej samej kotwicy jest gdzie indziej: POST próby
   `skip`/`dont_remember` na `lesson_card` przechodzi
   `assertModalityMatchesExercise` i zapisałby ocenę celu kotwicy. Routing
   `submitAttempt` odrzuca każdą próbę na `lesson_card` i `lesson_story`
   (400 `validation`).
5. **`contentLocale` w nowych gałęziach promptu jest opcjonalne**
   (`LessonContentLocaleSchema.optional()`), jak w pozostałych gałęziach lekcji;
   nieznany język przedmiotu daje brak pola zamiast błędu parsowania planu.
6. **`closingStory: true` dostają wszystkie zadania spoza historyjki** w sesji
   z historyjką (także karty i zadania następcze), nie tylko oceniane: baner
   liczy się z `remainingAssessed` każdego zadania, więc karta przed ostatnim
   zadaniem pokazałaby inaczej „Jeszcze 1 i koniec!”.
7. **Kontrakty nie mają `switch` w `messages.ts`.** Dopisujemy etykiety typu
   kroku karty pracy (`stepType`) i komunikaty Kid.
8. **SPEC §22 to „TTS i pliki audio”.** Zdanie o nagraniu historyjki trafia
   do §22, a zachowanie dziecka i wyjątek od budżetu do §29a.3 („Interaktywny
   przebieg”).
9. **Zakres filtrów czytelników.** `previousObjectiveContactSnapshot`,
   `historicalSupportObjectives`, `lastSeenAt` i historia sesji planowania
   wykluczają **tylko typy historyjki** — zachowanie kart się nie zmienia.
   Liczniki „ocenianych” używają pełnego predykatu (karty jak dotąd
   + historyjka). `taskCounts` w `sessions.ts` (`SessionDto.assessedTasksIssued`
   i podsumowanie) także dostaje pełny predykat: karty lekcji przestają tam
   zawyżać licznik (dziś liczone jak oceniane). Istniejące asercje, które na tym
   polegały, poprawiamy.
10. **Stan pytania po odpowiedzi: `answered`**, jak zamknięte zadania lekcji;
    migracja `0035` poszerza `session_tasks_completed_only_exposure` tylko
    o `lesson_story`.
11. **Kosze testów.** Nowy plik integracyjny trafia do kosza 3
    `tests/integration-buckets.ts`, bo kosz 2 dostał dwa pliki w etapach 1–2
    (świeżego pomiaru brak). Przebieg `real` E2E dopisujemy do istniejącego
    `tests/e2e/lesson-real-flow.spec.ts` (kosz 4, ok. 122 s, ex aequo
    najlżejszy; ma helpery rodzica i dziecka) zamiast nowego pliku. Nowy spec
    `mocked`: `tests/e2e/lesson-story.spec.ts`.
12. **Świętowanie.** Kafelek `AnswerGrid` zachowuje podświetlenie i podskok
    poprawnej opcji — to wynik, a stany opcji należą wyłącznie do `AnswerGrid`.
    Pytania historyjki nie zmieniają serii ani gwiazdki kamienia milowego
    (`session-progress-state`). Dok przy wyborze i tak nie świętuje
    (`celebrateInDock` jest fałszywe dla wyboru).
13. **Autoodtwarzanie:** nowa metoda kontrolera `autoPlayStoryAudio(taskId)`,
    wołana z `handlePaneMount` (`TaskTransition`, `AnimatePresence mode="wait"`).
    `playSentenceAudio` (#194) dotyczy feedbacku; przejmujemy z niego tylko
    zasadę ciszy: zablokowany autoplay i błąd pliku nie ustawiają
    `questionAudioError`.

### Dane testowe (wspólne dla Task 2–4)

- `tests/fixtures/lesson-world.ts` dostaje opcję
  `story?: { value: LessonStoryFixture; audio?: "ready" | "pending" }`:
  - historyjka trafia do `lesson_context` przed publikacją (kontekst
    opublikowanej wersji jest niezmienny);
  - wiersz `lesson_story_assets` i zasób `media_assets` (`kind = 'tts'`,
    `fingerprint = expected_fingerprint`) wstawiamy przed publikacją, bo trigger
    `lesson_story_assets_immutable` odrzuca INSERT dla wersji opublikowanej;
  - eksport `STORY_FIXTURE`: 4 zdania bez kolizji z pulą `richPool`
    (np. „Sam has a red bike.”, „He rides it to school.”, „His sister walks.”,
    „They meet at the park.”) i 2 pytania po 3 opcje (`q1` poprawna `b`,
    `q2` poprawna `a`).
- Usługi: `buildTestServices` (`ManualClock`); budżet sesji ustawia
  `update learning_app.decks set session_task_budget = $2 where id = $1` przed
  `startSession`.
- Przedmiot bez flagi: rejestr z kopią gramatyki `lessonStory: false`
  (`createServices({ db, clock, subjects })`, wzorem
  `tests/integration/lesson-story-audio.test.ts`).
- Pomocnik w pliku testu `drainToStory(services, sessionId)`: odpowiada na
  zadania oceniane poprawnie (klucz z `session_tasks.answer_key`), karty kończy
  `completePresentation`, i zwraca pierwsze zadanie `lesson_story`.

## Review Focus

1. **Zamknięcie sesji wydaje złe zadanie.** Po limicie czasu przy
   `remaining > 3` musi wyjść historyjka, a nie pominięty slot oceniany; po
   historyjce żaden oceniany slot już nie wychodzi; ponowny `nextTask` na
   wydanej historyjce zwraca to samo zadanie z `remainingAssessed = 0`.
   Test: Task 3 (`time limit with more than three left issues the story, never
   the skipped exercise`, `issued story is re-read with the same counters`).
2. **Liczniki i baner.** Zadania historyjki mają `remainingAssessed = 0`,
   pozostałe w sesji z historyjką `closingStory: true`; budżet planu
   (`taskBudget`) bez zmian; Kid UI przy `0` nie pokazuje „Jeszcze 0”.
   Test: Task 2 (`plan ends with story slots without changing the budget`),
   Task 3 (`closing story flag on every non-story task`), Task 5
   (`remainingFor hides the banner at zero`).
3. **Pytanie zmienia postęp albo przyjmuje złą modalność.** Brak `assessments`,
   projekcja `child_objective_progress` bez zmian, `dont_remember`/`skip`/`text`
   → 400 bez próby, a próba `skip` na karcie i historyjce → 400.
   Test: Task 4 (`story question answer creates an attempt without assessment
   or progress change`, `story question rejects non-choice modalities`,
   `attempts on lesson_card and lesson_story are rejected`).
4. **Ekspozycje.** Wydanie historyjki i każdego pytania pieczętuje klucze zdań
   przed odpowiedzią; klucze ćwiczeń pozostają nieujawnione; kontakt z celem
   kotwicy i `lastSeenAt` się nie zmieniają.
   Test: Task 2 (`story and question slots reveal sentence keys only`), Task 3
   (`story tasks do not count as contact with the anchor objective`).
5. **Odtwarzanie w Kid UI.** Autoodtwarzanie raz po zamontowaniu panelu, ciche
   przy błędzie, przerwane przez „Dalej”; przy wyniku pytania nie ma dwóch
   głośników. Test: Task 5 (`autoplays the story once after the pane mounts and
   stays silent on failure`, `next stops story playback`), Task 6
   (`feedback hides the story listen button`).

---

### Task 1: Kontrakty, predykat typów nieocenianych, odczyt historyjki, plan i migracja 0035

**Files:**
- Modify: `packages/contracts/src/kid.ts`
- Test: `packages/contracts/src/kid-lesson.test.ts`
- Create: `packages/server/src/domain/lessons/session-task-types.ts`
- Create test: `packages/server/src/domain/lessons/session-task-types.test.ts`
- Modify: `packages/server/src/domain/lessons/story.ts`, test `story.test.ts`
- Modify: `packages/server/src/domain/training-session-plan.ts`, test `training-session-plan.test.ts`
- Create: `packages/server/drizzle/0035_lesson_story_tasks.sql`
- Modify: `packages/server/drizzle/meta/_journal.json` (wpis `idx: 35`, `tag: "0035_lesson_story_tasks"`, `when` większe od wpisu 34, `breakpoints: true`)
- Modify: `packages/server/src/db/schema.ts` (`session_tasks_completed_only_exposure`)
- Test: `tests/integration/lesson-schema.test.ts`
- Modify (wyczerpujące `switch`, żeby `typecheck` przeszedł):
  - `packages/server/src/modules/learning/session-activity.ts` (`describeTaskPrompt`, `lessonAnswerValues`);
  - `packages/server/src/modules/learning/lessons/lesson-mock-tests.ts` (`promptText`: oba typy w grupie `""`);
  - `packages/kid-ui/src/exercises/exercise-presentation.ts`;
  - `packages/kid-ui/src/exercises/ExerciseView.tsx` (tymczasowo `return null` — zastępują Task 5 i 6).
- Test: `packages/server/src/modules/learning/session-activity.test.ts`

**Interfaces:**
- Produces (contracts, `kid.ts`):
  - `EXERCISE_TYPES` += `"lesson_story"`, `"lesson_story_question"`;
  - `export const LESSON_STORY_TASK_TYPES = ["lesson_story", "lesson_story_question"] as const;`
  - `export type LessonStoryTaskTypeDto = (typeof LESSON_STORY_TASK_TYPES)[number];`
  - `export function isLessonStoryTaskType(type: string): type is LessonStoryTaskTypeDto`;
  - gałęzie `TaskPromptSchema` (obie `.strict()`):
    ```ts
    const StoryTextSchema = z.object({ sentences: z.array(z.string().min(1)).min(1).max(6) }).strict();
    { kind: z.literal("lesson_story"), story: StoryTextSchema,
      contentLocale: LessonContentLocaleSchema.optional(), questionAudioAssetId: QuestionAudioSchema }
    { kind: z.literal("lesson_story_question"), question: z.string().min(1),
      options: z.array(ChoiceOptionSchema).length(3), story: StoryTextSchema,
      contentLocale: LessonContentLocaleSchema.optional(), questionAudioAssetId: QuestionAudioSchema }
    ```
  - `TaskDtoSchema.remainingAssessed: z.number().int().nonnegative()`
    (komentarz: „0 = zadanie poza budżetem, np. historyjka”);
  - `TaskDtoSchema.closingStory: z.literal(true).optional()` (komentarz: „sesja
    kończy się historyjką — baner «Jeszcze N i historyjka!»”).
- Produces (domena, `session-task-types.ts`):
  - `export type LessonStoryTaskType = LessonStoryTaskTypeDto;`
  - `export type LessonSessionTaskType = LessonExerciseType | LessonStoryTaskType;`
  - `export const NON_ASSESSED_LESSON_TASK_TYPES: readonly string[] = ["lesson_card", ...LESSON_STORY_TASK_TYPES];`
  - `export function isNonAssessedLessonTaskType(type: string): boolean`.
- Produces (`story.ts`):
  - `export function squashStoryText(text: string): string` (dotychczasowy
    prywatny `squash`, ta sama normalizacja co `storyReadText`);
  - `export function readStoredLessonStory(value: unknown): LessonStory | undefined`
    — strukturalny odczyt `lesson_context.story` dla sesji; `undefined`, gdy:
    - `sentences` nie jest tablicą napisów, ma 0 albo więcej niż
      `LESSON_STORY_LIMITS.maxSentences` elementów, albo któreś zdanie po
      `squashStoryText` jest puste;
    - `questions` nie jest tablicą 1…`maxQuestions` pytań;
    - pytanie nie ma niepustego `id` i `question`, nie ma dokładnie 3 opcji
      o unikalnych, niepustych `id` i niepustym `text`, albo `correctOption`
      nie wskazuje opcji.
- Produces (`training-session-plan.ts`):
  `LessonTrainingSessionSlot.taskKind: "card" | "support_card" | "exercise" | "story" | "story_question"`
  i ten sam enum w Zod; `version` zostaje `1`.

- [ ] **Step 1: Testy jednostkowe (failing).**
  - `kid-lesson.test.ts`:
    - `lesson_story prompt accepts sentences, locale and story audio`;
    - `lesson_story and lesson_story_question reject extra fields (correctOption, targetKey)`;
    - `lesson_story_question requires exactly three options`;
    - `story text rejects an empty sentence list and more than six sentences`;
    - `TaskDto accepts remainingAssessed 0 and closingStory true, rejects closingStory false`;
    - `EXERCISE_TYPES contains both story task types` oraz
      `isLessonStoryTaskType` (prawda dla obu, fałsz dla `lesson_card`).
  - `session-task-types.test.ts`: predykat prawdziwy dla `lesson_card`,
    `lesson_story`, `lesson_story_question`, fałszywy dla `lesson_choice`
    i `exposure`; `NON_ASSESSED_LESSON_TASK_TYPES` ma dokładnie te trzy wartości.
  - `story.test.ts` (`readStoredLessonStory`): poprawna historyjka wraca bez
    zmian; `undefined` dla `null`, zdania pustego po scaleniu białych znaków,
    7 zdań, 0 pytań, pytania z 2 opcjami, zdublowanego id opcji,
    `correctOption` spoza opcji.
  - `training-session-plan.test.ts`: plan lekcji ze slotami `taskKind: "story"`
    i `"story_question"` (`assessed: false`, prompt z nowych gałęzi) jest
    czytany; sloty historyjki nie wliczają się do limitu `assessed ≤ taskBudget`.
  - `session-activity.test.ts` (`describeTaskPrompt`, `lessonAnswerValues`):
    - historyjka daje bodziec ze zdań, bez opcji;
    - pytanie daje bodziec `pytanie | zdania` i trzy opcje;
    - `lessonAnswerValues` dla pytania zwraca tekst poprawnej opcji z
      `correctOptionId` + `optionValues`.
- [ ] **Step 2:** Uruchom
  `pnpm vitest run packages/contracts/src/kid-lesson.test.ts packages/server/src/domain/lessons/session-task-types.test.ts packages/server/src/domain/lessons/story.test.ts packages/server/src/domain/training-session-plan.test.ts packages/server/src/modules/learning/session-activity.test.ts`.
  Oczekiwane: FAIL.
- [ ] **Step 3: Implementacja kontraktów i domeny** zgodnie z „Interfaces”.
  - `describeTaskPrompt`:
    - `lesson_story` → `{ instruction: "Historyjka (przeczytanie i odsłuch)", stimulus: sentences.join(" "), options: [] }`;
    - `lesson_story_question` → `{ instruction: "Pytanie do historyjki", stimulus: \`${question} | ${sentences.join(" ")}\`, options: teksty opcji }`.
  - `lessonAnswerValues`: `lesson_story_question` dołącza do listy rodzajów
    z opcjami.
  - `exercise-presentation.ts`:
    - `lesson_story` → `{ instruction: messages.kid.lessonStoryInstruction, icon: "book" }`;
    - `lesson_story_question` → `{ instruction: task.prompt.question, icon: "book" }`.
  - Komunikat `messages.kid.lessonStoryInstruction: "Przeczytaj i posłuchaj historyjki"`
    dopisz już tutaj.
- [ ] **Step 4: Migracja i schemat.** `0035_lesson_story_tasks.sql`:
  - nagłówek po polsku: historyjka jest prezentacją kończoną
    `complete-presentation` jak karta; pytanie kończy się stanem `answered`;
  - `ALTER TABLE ... DROP CONSTRAINT "session_tasks_completed_only_exposure";--> statement-breakpoint`
    i `ADD CONSTRAINT ... CHECK (state <> 'completed' or exercise_type in ('exposure', 'lesson_card', 'lesson_story'))`
    (pełne nazwy kolumn jak w `0007_lessons.sql`).

  `schema.ts`: ten sam CHECK.
- [ ] **Step 5: Test migracji** w `lesson-schema.test.ts`, zmiana istniejącego
  przypadku na `session_tasks.completed dozwolone dla lesson_card i lesson_story, nie dla innych typów lekcji`:
  - definicja zawiera `lesson_story`;
  - nie zawiera `lesson_story_question` (sprawdź przez `not.toMatch(/lesson_story_question/)`).
- [ ] **Step 6:** Uruchom:
  - testy jednostkowe z kroku 2;
  - `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/lesson-schema.test.ts`;
  - `pnpm typecheck`.

  Oczekiwane: PASS.
- [ ] **Step 7: Commit** `Historyjka: kontrakty zadań sesji, predykat i migracja 0035`.

---

### Task 2: Sloty historyjki w planie sesji i ich materializacja

**Files:**
- Create: `packages/server/src/modules/learning/lessons/lesson-story-tasks.ts`
- Create test: `packages/server/src/modules/learning/lessons/lesson-story-tasks.test.ts`
- Modify: `packages/server/src/modules/learning/lessons/lesson-sessions.ts`
  (`LessonContextShape.story`, `lessonContextOf`, `createLessonTrainingSessionPlan`,
  zawężenie `plannedPrefix` w `planLessonTaskFromSnapshot`)
- Modify: `packages/server/src/modules/learning/lessons/lesson-materialize.ts` (eksport `lessonLocale`)
- Modify: `tests/fixtures/lesson-world.ts` (opcja `story`, `STORY_FIXTURE`)
- Create test: `tests/integration/lesson-story-session.test.ts` (+ wpis w koszu 3 `tests/integration-buckets.ts`)

**Interfaces:**
- Consumes: `readStoredLessonStory`, `squashStoryText` (Task 1),
  `lessonTextTargetKey` (`domain/lessons/exposure-key.ts`), `seededShuffle`.
- Produces (`lesson-story-tasks.ts`):
  ```ts
  export async function loadLessonStoryAudio(tx: Executor, deckVersionId: string): Promise<string | null>
  export function lessonStorySlots(args: {
    story: LessonStory;
    subject: Pick<SubjectModule, "id" | "answerLocale" | "normalizeExposureText">;
    anchor: { itemId: string; revisionId: string };
    audioAssetId: string | null;
    firstOrdinal: number;
    newTaskId?: () => string;                    // domyślnie randomUUID
    shuffleSeed?: (taskId: string) => string;    // domyślnie `${taskId}:${randomUUID()}`
  }): LessonTrainingSessionSlot[]
  export function planHasClosingStory(plan: LessonTrainingSessionPlanSnapshot | null): boolean
  ```
  - `loadLessonStoryAudio`: jak `loadLessonCardAudio` — `lesson_story_assets`
    join `media_assets` po `expected_fingerprint`, `kind = 'tts'`,
    `state = 'ready'`, najnowsza generacja; `null`, gdy brak.
  - Slot historyjki:
    - `exerciseType: "lesson_story"`, `taskKind: "story"`,
      `reason: "closing_story"`, `assessed: false`, `direction: null`;
    - `itemId`, `itemRevisionId` z kotwicy;
    - prompt `{ kind: "lesson_story", story: { sentences: squashed }, ...contentLocale, ...questionAudioAssetId }`;
    - `answerKey: { exerciseType: "lesson_story", subjectId }`;
    - `context: { reason: "closing_story" }`;
    - `revealsTargetKeys`: unikalne `lessonTextTargetKey(subject, sentence)` zdań.
  - Slot pytania (po jednym na pytanie, w kolejności historyjki):
    - `exerciseType: "lesson_story_question"`, `taskKind: "story_question"`;
    - opcje z nowym UUID, kolejność `seededShuffle(options, shuffleSeed(taskId))`;
    - prompt `{ kind: "lesson_story_question", question, options: [{ id, text }], story, ...contentLocale, ...questionAudioAssetId }`;
    - `answerKey: { exerciseType: "lesson_story_question", subjectId, storyQuestionId, correctOptionId, optionValues }`;
    - `context: { reason: "closing_story", storyQuestionId }`;
    - `revealsTargetKeys`: te same klucze zdań (prompt znowu pokazuje tekst).
  - `ordinal` kolejnych slotów od `firstOrdinal`.
  - `planHasClosingStory`: czy plan ma slot `taskKind === "story"`.
- Produces (`lesson-sessions.ts`): `LessonContextShape.story?: LessonStory`
  (z `readStoredLessonStory(raw.story)`).

- [ ] **Step 1: Testy jednostkowe (failing)** w `lesson-story-tasks.test.ts`
  (deterministyczne `newTaskId` i `shuffleSeed`):
  - `story slot shows squashed sentences, story audio and the answer locale`;
  - `story without audio has no questionAudioAssetId`;
  - `question slots follow the story in story order with three fresh option ids`
    — id opcji różne od `a/b/c` z wersji, `correctOptionId` wskazuje opcję
    o tekście poprawnej odpowiedzi;
  - `public prompts carry no answer key` — `JSON.stringify(prompt)` nie zawiera
    `correctOption`, `storyQuestionId` ani id opcji z wersji;
  - `story and question slots reveal sentence keys only` — `revealsTargetKeys`
    = klucze zdań, bez kluczy ćwiczeń;
  - `slots are non-assessed and do not change ordinals of previous slots`;
  - `each slot parses with readLessonTrainingSessionPlan`.
- [ ] **Step 2:** `pnpm vitest run packages/server/src/modules/learning/lessons/lesson-story-tasks.test.ts` — FAIL.
- [ ] **Step 3: Implementacja `lesson-story-tasks.ts`** wg „Interfaces”.
- [ ] **Step 4: Plan sesji.** W `createLessonTrainingSessionPlan`, po pętli
  ocenianych slotów, doklej `lessonStorySlots(...)`, gdy jednocześnie:
  - `planningSnapshot` istnieje i `planningSnapshot.subject.lessonStory === true`;
  - `planningSnapshot.context.story` jest zdefiniowana;
  - `assessed > 0`.

  Kotwica: `exercises.find((e) => e.payload.objectiveId === objectiveOrder[0]) ?? exercises[0]`.
  Nagranie: `loadLessonStoryAudio(tx, session.deckVersionId)`. `taskBudget`
  liczony jak dotąd (`Math.max(1, assessed)`).
  `planLessonTaskFromSnapshot` pomija sloty historyjki w `plannedPrefix`
  (zawężenie typu `kind`); w praktyce ich tam nie ma, bo sloty powstają po pętli.
- [ ] **Step 5: Fixture.** Opcja `story` w `lessonWorld` i `STORY_FIXTURE`
  (sekcja „Dane testowe”).
- [ ] **Step 6: Testy integracyjne (failing przed krokiem 4)**
  w `tests/integration/lesson-story-session.test.ts`:
  - `plan ends with story slots without changing the budget` — ostatnie sloty
    `training_plan` to `story`, `story_question` × 2; `taskBudget` i liczba
    slotów `assessed` jak w tej samej wersji bez historyjki;
  - `plan uses the ready story recording and omits a pending one`
    (`audio: "ready"` → `questionAudioAssetId`; `audio: "pending"` → brak pola);
  - `no story slots without lessonStory flag, without a story or in a mock test`
    (trzy warianty: rejestr z `lessonStory: false`, `lessonWorld` bez
    `story`, `mode: "mock_test"`).
- [ ] **Step 7:** Uruchom:
  - `pnpm vitest run packages/server/src/modules/learning/lessons packages/server/src/domain/lessons/architecture.test.ts packages/server/src/modules/module-boundaries.architecture.test.ts`;
  - `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/lesson-story-session.test.ts tests/integration/lesson-sessions.test.ts tests/integration/training-session-plan.test.ts tests/integration/lesson-mock-tests.test.ts`;
  - `pnpm vitest run tests/integration-buckets.test.ts`.

  Oczekiwane: PASS. Na tym etapie `nextTask` jeszcze nie wydaje historyjki
  (`remaining <= 0` zwraca `null`).
- [ ] **Step 8: Commit** `Historyjka: sloty historyjki i pytań w planie sesji`.

---

### Task 3: Wydanie historyjki, liczniki, limit czasu i czytelnicy zadań

**Files:**
- Modify: `packages/server/src/modules/learning/sessions.ts`
  (`taskCounts`, `sessionActivityAndCounts`, `nextTask`, `completePresentation`)
- Modify: `packages/server/src/modules/learning/lessons/lesson-sessions.ts`
  (`lessonTaskCounts`, `issueNextLessonPlanTask`, `lessonTaskDto`,
  `previousObjectiveContactSnapshot`, `historicalSupportObjectives`,
  `lastSeenAt` w `loadLessonPlanningSnapshot`, historia sesji planowania)
- Modify: `packages/server/src/modules/learning/lessons/lesson-story-tasks.ts`
  (`unissuedPlanSlots`, `withStoryCounters`)
- Modify: `packages/server/src/modules/learning/lessons/lesson-shorten.ts`
- Modify: `packages/server/src/modules/reporting/parent-work-card.ts` (`remainingSteps`)
- Modify: `packages/contracts/src/messages.ts` (`stepType.lesson_story: "Historyjka"`, `stepType.lesson_story_question: "Pytanie do historyjki"`)
- Test: `lesson-story-tasks.test.ts`, `tests/integration/lesson-story-session.test.ts`,
  `tests/integration/parent-work-card.test.ts`, `tests/integration/task-transition-queries.test.ts` (bez zmian, musi przejść)

**Interfaces:**
- Consumes: `NON_ASSESSED_LESSON_TASK_TYPES`, `isLessonStoryTaskType` (Task 1),
  `planHasClosingStory` (Task 2).
- Produces:
  - `lessonTaskCounts(tx, sessionId): Promise<{ total; assessed; planned; story: number }>`;
    `assessed` = `exercise_type not in (NON_ASSESSED_LESSON_TASK_TYPES)` i bez
    `followUpOf`; `story` = liczba zadań typów historyjki.
  - `sessionActivityAndCounts(tx, sessionId, startedAt, nonAssessedTypes: readonly string[] = ["exposure"])`
    zwraca dodatkowo `story`; lista przez `sql.join(types.map((t) => sql\`${t}\`), sql\`, \`)`.
  - `taskCounts`: `assessed` = `exercise_type not in ('exposure', ...NON_ASSESSED_LESSON_TASK_TYPES)`.
  - `export function unissuedPlanSlots(plan: LessonTrainingSessionPlanSnapshot, counts: { planned: number; story: number }): { regular: readonly LessonTrainingSessionSlot[]; story: readonly LessonTrainingSessionSlot[] }`
    — niewydane sloty spoza historyjki (`slice(planned − story)`) i niewydane
    sloty historyjki (`slice(story)`).
  - `issueNextLessonPlanTask(tx, session, now, counts: { total: number; planned: number; assessed: number; story: number }, options: { closing: boolean }): Promise<TaskDto | null>`:
    - `closing || counts.story > 0` → pierwszy z `unissued.story` albo `null`;
    - inaczej pierwszy z `unissued.regular`; oceniany przy
      `assessed >= plan.taskBudget` → `null` (jak dotąd).
  - `export function withStoryCounters(dto: TaskDto, plan: LessonTrainingSessionPlanSnapshot | null): TaskDto`
    — dla typów historyjki `remainingAssessed: 0`; dla pozostałych przy
    `planHasClosingStory(plan)` dodaje `closingStory: true`.

- [ ] **Step 1: Test jednostkowy (failing)** w `lesson-story-tasks.test.ts`:
  - `unissuedPlanSlots splits regular and story suffixes` — plan 5 slotów
    + 3 historyjki: `{ planned: 2, story: 0 }` → 3 regularne i 3 historyjki;
    `{ planned: 4, story: 1 }` (limit czasu po 3 zadaniach) → 2 regularne,
    2 historyjki;
  - `withStoryCounters sets zero for story tasks and closingStory elsewhere`;
  - `withStoryCounters leaves a session without story slots unchanged`.
- [ ] **Step 2: Testy integracyjne (failing)** w `lesson-story-session.test.ts`:
  - `story follows the last assessed task and questions follow the story` —
    budżet 2: po `drainToStory` kolejno `lesson_story`, po
    `completePresentation` `lesson_story_question` (q1), po odpowiedzi (Task 4;
    do tego czasu zamknij zadanie SQL-em `state = 'answered'`) q2, potem `null`;
  - `closing story flag on every non-story task` — każde zadanie spoza
    historyjki ma `closingStory: true`; sesja bez historyjki nie ma pola;
  - `story tasks report remainingAssessed 0`;
  - `issued story is re-read with the same counters` — drugi `nextTask` przed
    `completePresentation` zwraca to samo `taskId`, `remainingAssessed: 0`;
  - `time limit with more than three left issues the story, never the skipped exercise`
    — budżet ≥ 6, jedno zadanie oceniane, zegar +11 min: wychodzi historyjka,
    potem pytania, potem `null`; liczba ocenianych zadań w `session_tasks`
    pozostaje 1;
  - `time limit inside the promise keeps the promised tasks before the story`
    — przy `remaining ≤ 3` wychodzą obiecane zadania, potem historyjka;
  - `complete-presentation finishes the story without an attempt` — stan
    `completed`, zdarzenie `presentation_completed`, zero prób;
  - `stale session ends without the story` — zegar +31 min: `null`, sesja
    `ended`, żadnego zadania historyjki;
  - `legacy session without a plan never issues the story` — `training_plan`
    wyzerowany SQL-em przed pierwszym `nextTask`;
  - `story tasks do not count as contact with the anchor objective` — sesja 1:
    zadania oceniane w T0, historyjka i pytania w T0+1 h; sesja 2 w T0+13 h:
    `context.previousObjectiveContact[objectiveId]` ≤ T0 + 1 min;
  - `session summary and session dto count only assessed tasks` —
    `assessedTasksIssued` bez kart i historyjki.
- [ ] **Step 3: Test karty pracy** w `tests/integration/parent-work-card.test.ts`:
  `story tasks appear as steps and do not reduce remaining steps`.
- [ ] **Step 4:** Uruchom pliki z kroków 1–3 — FAIL.
- [ ] **Step 5: Implementacja.**
  - `nextTask` (gałąź lekcji, bez wydanego zadania):
    ```ts
    const lessonPlan = session.trainingPlan && "kind" in session.trainingPlan && session.trainingPlan.kind === "lesson";
    const timeUp = now - startedAt > sessionTimeLimitMs(taskBudget) && remaining > PROMISE_REMAINING;
    const closing = remaining <= 0 || timeUp;
    if (lessonPlan) return issueNextLessonPlanTask(tx, session, now, counts, { closing });
    if (closing) return null;
    return issueNextLessonTask(...);
    ```
    (okno wznowienia sprawdzane przed tym, bez zmian).
  - Gałąź wydanego zadania lekcji: `assessedBefore` z predykatem zamiast
    literału `lesson_card`; wynik `withStoryCounters(issuedTaskDto(...), plan)`.
    Odczyt planu jak w `issueNextLessonPlanTask` (`readLessonTrainingSessionPlan`
    w `try`; błąd → plan `null`, bez rzucania na ścieżce odczytu).
  - `issueNextLessonPlanTask` i `lessonTaskDto`: `exerciseType` jako
    `LessonSessionTaskType`; wynik przez `withStoryCounters`.
  - `completePresentation`: dopuszcza `exposure`, `lesson_card` i `lesson_story`.
  - Czytelnicy (tylko typy historyjki, ruling 9):
    - `previousObjectiveContactSnapshot`: `exercise_type not in (LESSON_STORY_TASK_TYPES)`;
    - `historicalSupportObjectives`: pomija wiersze typów historyjki;
    - `lastSeenAt`: filtr typu w zapytaniu `issuedRows`;
    - historia sesji w `loadLessonPlanningSnapshot`: pomija typy historyjki.
  - `lesson-shorten.ts`: `reservedForPlan` z `unissuedPlanSlots(plan, counts).regular`.
  - `parent-work-card.ts`: `remainingSteps` liczy zadania spełniające
    `task.exerciseType !== "exposure" && !isNonAssessedLessonTaskType(task.exerciseType)`
    (lub `daily_round` jak dotąd).
- [ ] **Step 6:** Uruchom:
  - `pnpm vitest run packages/server/src/modules/learning packages/server/src/modules/module-boundaries.architecture.test.ts`;
  - integrację:
    ```bash
    pnpm exec vitest run --config vitest.integration.config.ts tests/integration/lesson-story-session.test.ts tests/integration/lesson-sessions.test.ts tests/integration/sessions.test.ts tests/integration/parent-work-card.test.ts tests/integration/parent-work-card-regressions.test.ts tests/integration/task-transition-queries.test.ts tests/integration/lesson-grader-school.test.ts tests/integration/lesson-mock-tests.test.ts
    ```
  - przegląd skutków ubocznych (§15 „Przegląd skutków ubocznych”): pliki
    z generowaniem gramatyki przez workera, w których fake dokłada historyjkę,
    a sesja biegnie do `null`:
    ```bash
    pnpm exec vitest run --config vitest.integration.config.ts tests/integration/lesson-generation.test.ts tests/integration/lesson-parent-api.test.ts tests/integration/lesson-error-explanation.test.ts tests/integration/lesson-sentence-audio.test.ts tests/integration/lesson-listen-choice.test.ts tests/integration/grammar-without-tts.test.ts
    ```
    Pętle „do `null`” obsługują `lesson_story` (`completePresentation`)
    i `lesson_story_question` (odpowiedź `choice`). Odpowiedź działa dopiero po
    Task 4, więc pętlę, która dochodzi do pytania, poprawiamy w Task 4 (krok 4)
    i zapisujemy to w raporcie zadania; obejścia SQL-em w tych plikach nie
    stosujemy. Asercje `assessedTasksIssued` z kartami poprawiamy (ruling 9).

  Oczekiwane: PASS.
- [ ] **Step 7: Commit** `Historyjka: wydanie na koniec sesji i liczniki poza budżetem`.

---

### Task 4: Odpowiedź na pytanie, ujawnienia i usunięcie profilu

**Files:**
- Create: `packages/server/src/modules/learning/lessons/lesson-story-attempts.ts`
- Modify: `packages/server/src/modules/learning/attempts.ts` (routing `submitAttempt` i `readAttempt`)
- Modify: `packages/server/src/modules/learning/events.ts` (`authorizeDisclosure`)
- Test: `tests/integration/lesson-story-session.test.ts`

**Interfaces:**
- Consumes: `lockTaskWithSession` (`events.ts`), `discloseFeedbackEvent`,
  `requestHashOf` (`attempt-shared.ts`), `isNonAssessedLessonTaskType`.
- Produces:
  ```ts
  export async function answerStoryQuestion(services: Services, input: AttemptInput): Promise<AttemptDto>
  export async function readStoryQuestionAttempt(services: Services, attempt: AttemptRow): Promise<AttemptDto>
  ```
  - Modalność inna niż `choice` → `AppError("validation")` przed transakcją,
    bez próby.
  - W transakcji (`lockTaskWithSession`):
    1. zadanie nie jest `lesson_story_question` → `validation`;
    2. próba o tym samym `clientAttemptId`: inny `requestHash` → `conflict`;
       ten sam → ponowny `discloseFeedbackEvent` z `exposures: []` i ten sam DTO;
    3. sesja nieaktywna albo zadanie nie `issued` → `conflict`;
    4. `optionId` spoza `answerKey.optionValues` → `validation` bez próby;
    5. wynik: `optionId === correctOptionId` → `{ kind: "great" }`, inaczej
       `{ kind: "incorrect", correctText: optionValues[correctOptionId] }`;
    6. INSERT `attempts`:
       - `state: "completed"`, `completedAt = receivedAt = now`;
       - `answer: { optionId, optionText }`;
       - `context: { receivedAt, storyQuestion: true }`;
       - `attemptNumber` = liczba prób zadania + 1, `policyId` sesji, `feedback`;
    7. UPDATE zadania na `answered`;
    8. `discloseFeedbackEvent(tx, { task, childId, itemId, exposures: [], now })`;
       `stepId` w DTO.
  - Brak `assessments`, projekcji, `offerShortenFollowUp`, `graderCalls`
    i `feedback_audio`.
  - `readStoryQuestionAttempt`: blokada, ponowne ujawnienie jak w kroku 2,
    DTO z bieżącym stanem zadania.
  - Routing w `attempts.ts`:
    - `submitAttempt`: `lesson_story_question` → `answerStoryQuestion`;
      `lesson_card` i `lesson_story` → `AppError("validation", { message: "presentation tasks take no attempts" })`;
    - `readAttempt`: `lesson_story_question` → `readStoryQuestionAttempt`.
  - `authorizeDisclosure`: zaraz po kontroli stanu zadania
    `if (isNonAssessedLessonTaskType(task.exerciseType)) throw new AppError("conflict", { message: "to zadanie lekcji nie oferuje odsłuchu ani podpowiedzi" })`.

- [ ] **Step 1: Testy integracyjne (failing)** w `lesson-story-session.test.ts`:
  - `story question answer creates an attempt without assessment or progress change`
    — poprawna odpowiedź:
    - DTO `feedback: { kind: "great" }`, `taskState: "answered"`;
    - wiersz `attempts` z `context.storyQuestion = true`;
    - zero wierszy `assessments` dla próby;
    - `child_objective_progress` identyczne przed i po;
    - `learning_sessions.context.graderCalls` bez zmian;
  - `wrong story answer shows the correct option text` (`incorrect`,
    `correctText` = tekst poprawnej opcji w języku polskim);
  - `story question feedback is sealed without exercise exposures`
    (`feedback_issued`, brak wierszy `event_exposures` zdarzenia);
  - `resending the same story answer is idempotent, a different answer with the same key conflicts`;
  - `story question rejects non-choice modalities` — `dont_remember`, `skip`
    i `text` dają `validation`, a liczba prób zadania jest 0;
  - `story question rejects an unknown option id`;
  - `attempts on lesson_card and lesson_story are rejected` — `skip`
    i `dont_remember` → `validation`, zero prób i ocen;
  - `disclosures are rejected for story, story question and card` — `hint`
    i `audio` → `conflict`, żadnego zdarzenia `hint_issued`/`audio_issued`;
  - `story exposures do not mark exercises as seen` — po historyjce
    `event_exposures` dziecka zawiera klucze zdań i nie zawiera `target_key`
    ćwiczeń, których dziecko nie widziało;
  - `parent supervision and progress rebuild ignore story attempts` — po
    pytaniu historyjki `rebuildProgress` (`learning/progress-rebuild.ts`) daje
    te same wiersze postępu;
  - `deleting the profile removes story tasks, attempts and events but keeps the recording`
    (`deleteChild`, `family/profiles.ts`): zero `session_tasks`/`attempts`/
    `learning_events` dziecka; wiersz `lesson_story_assets` i zasób zostają.
  - Zastąp zamknięcie SQL-em z Task 3 prawdziwą odpowiedzią w teście
    `story follows the last assessed task and questions follow the story`.
- [ ] **Step 2:** Uruchom plik — FAIL.
- [ ] **Step 3: Implementacja** wg „Interfaces”.
- [ ] **Step 4:** Uruchom:
  - `pnpm vitest run packages/server/src/modules/learning packages/server/src/modules/module-boundaries.architecture.test.ts`;
  - integrację:
    ```bash
    pnpm exec vitest run --config vitest.integration.config.ts tests/integration/lesson-story-session.test.ts tests/integration/lesson-attempts.test.ts tests/integration/attempts.test.ts tests/integration/lesson-parent-supervision.test.ts tests/integration/progress-rebuild.test.ts tests/integration/session-activity.test.ts tests/integration/auth-profiles.test.ts
    ```
  - pliki skutków ubocznych z Task 3, jeśli tam odłożono poprawki pętli.

  Oczekiwane: PASS.
- [ ] **Step 5: Commit** `Historyjka: odpowiedź na pytanie poza postępem i blokada ujawnień`.

---

### Task 5: Kid UI — `LessonStoryView`, autoodtwarzanie i baner

**Files:**
- Create: `packages/kid-ui/src/exercises/lesson/LessonStoryView.tsx`
- Modify: `packages/kid-ui/src/exercises/ExerciseView.tsx` (gałąź `lesson_story`)
- Modify: `packages/kid-ui/src/session/session-controller.ts`
  (`completePresentation`, `autoPlayStoryAudio`, `remainingFor`)
- Modify: `packages/kid-ui/src/screens/LearnScreen.tsx`
  (`handlePaneMount`, etykieta i komunikaty odsłuchu, `closingStory` dla `SessionProgress`)
- Modify: `packages/kid-ui/src/components/SessionProgress.tsx` (prop `closingStory`)
- Modify: `packages/kid-ui/src/styles.css` (klasy `kid-lesson-story*` w zakresie `.kid-ui`)
- Modify: `packages/kid-ui/src/exercises/ExerciseFrame.module.css` (`lesson_story`, `lesson_story_question` poza odstępem `--kid-compact-frame-offset`, jak `lesson_card`)
- Modify: `packages/contracts/src/messages.ts` (`messages.kid`)
- Test: `packages/kid-ui/src/exercises/lesson/lesson-views.test.tsx`,
  `packages/kid-ui/src/session/session-controller.test.ts`,
  `packages/kid-ui/src/components/SessionProgress.test.tsx`

**Interfaces:**
- Consumes: `TaskDto.closingStory`, prompt `lesson_story` (Task 1),
  `useExerciseGuidance` / `ExerciseGuidanceProvider`, `questionAudioOf`.
- Produces:
  - `LessonStoryView(props: ExerciseProps)`:
    - `ExerciseFrame` z `content` = `<article className="kid-lesson-story" data-testid="kid-lesson-story">`;
    - nagłówek: `<h2 className="kid-lesson-story__title">{messages.kid.lessonStoryTitle}</h2>`
      i — gdy jest — odsłuch z `useExerciseGuidance()` obok tytułu (wzorzec
      `kid-lesson-card__header`); frame dostaje `ExerciseGuidanceProvider value={null}`;
    - tekst: `<p className="kid-lesson-story__text" data-testid="kid-lesson-story-text" lang={contentLocale}>`
      ze zdaniami złączonymi spacją;
    - akcja: `ActionButton` `data-testid="kid-lesson-next"` → `handlers.onComplete`,
      fokus przy zmianie `taskId` jak w karcie.
  - `controller.autoPlayStoryAudio(taskId: string): Promise<void>`:
    - działa tylko dla bieżącego zadania `lesson_story` z nagraniem, raz na
      `taskId` (zatrzask), poza `offline`/`busy`/nagrywaniem;
    - `#beginPlayback()` i `#playCountedAudio`;
    - każdy błąd (blokada autoplay, plik, sieć) jest cichy: bez
      `questionAudioError` i bez `#handleFailure`.
  - `completePresentation`: dopuszcza `lesson_story` (już zatrzymuje odtwarzanie).
  - `remainingFor(task)`: poza kartkówką zwraca liczbę tylko dla
    `1 ≤ remainingAssessed ≤ 3`.
  - `SessionProgress` prop `closingStory?: boolean` → tekst
    `messages.kid.remainingStory` zamiast `messages.kid.remaining`.
  - `LearnScreen`:
    - `handlePaneMount` woła `controller.autoPlayStoryAudio(mountedTaskId)`,
      gdy zamontowany jest bieżący `lesson_story`;
    - etykieta `QuestionAudioButton` dla obu typów historyjki to
      `messages.kid.listenLessonStory`;
    - komunikaty błędu ręcznego odsłuchu: `storyAudioUnavailable`
      i `storyAudioRetry` dla obu typów historyjki (obok wariantu karty);
    - `SessionProgress closingStory={task?.closingStory === true}`.
  - Komunikaty `messages.kid`:
    - `remainingStory: "Jeszcze {n} i historyjka!"`;
    - `lessonStoryTitle: "Historyjka"`;
    - `listenLessonStory: "Posłuchaj historyjki"`;
    - `storyAudioUnavailable: "Nie udało się odtworzyć historyjki. Przeczytaj ją albo spróbuj jeszcze raz."`;
    - `storyAudioRetry: "Odtwórz historyjkę"`.
  - CSS (`styles.css`, tylko tokeny):
    - `.kid-ui .kid-lesson-story__text` z `max-inline-size: var(--kid-reading-measure)`
      i `margin-inline: auto`;
    - nagłówek jak `kid-lesson-card__header`.

- [ ] **Step 1: Testy (failing).**
  - `lesson-views.test.tsx`:
    - `story view renders the title, sentences with lang and next`;
    - `story view shows the listen button beside the title only with a recording`;
    - `story view next completes the presentation`.
  - `session-controller.test.ts`:
    - `autoplays the story once after the pane mounts and stays silent on failure`
      — dwa wywołania dla tego samego `taskId` dają jedno odtworzenie; odrzucone
      odtwarzanie nie ustawia `questionAudioError` ani błędu ekranu;
    - `next stops story playback` (`completePresentation` przerywa odtwarzanie
      i woła `api.completePresentation`);
    - `completePresentation accepts lesson_story`;
    - `remainingFor hides the banner at zero and shows 1–3`.
  - `SessionProgress.test.tsx`:
    - `closing story label says Jeszcze N i historyjka!`;
    - `default label stays Jeszcze N i koniec!`.
- [ ] **Step 2:** `pnpm vitest run packages/kid-ui` — FAIL.
- [ ] **Step 3: Implementacja** wg „Interfaces”.
- [ ] **Step 4:** Uruchom:
  - `pnpm vitest run packages/kid-ui tests/kid-design-tokens.test.ts tests/kid-no-mantine.test.ts tests/kid-tokens.test.ts`;
  - `pnpm typecheck`.

  Oczekiwane: PASS.
- [ ] **Step 5: Commit** `Historyjka: widok historyjki, autoodtwarzanie i baner w Kid UI`.

---

### Task 6: Kid UI — `LessonStoryQuestionView`, wynik i seria

**Files:**
- Create: `packages/kid-ui/src/exercises/lesson/LessonStoryQuestionView.tsx`
- Modify: `packages/kid-ui/src/exercises/ExerciseView.tsx` (gałąź `lesson_story_question`)
- Modify: `packages/kid-ui/src/components/session-progress-state.ts` (`countsTowardStreak`)
- Modify: `packages/kid-ui/src/screens/LearnScreen.tsx` (seria)
- Modify: `packages/kid-ui/src/styles.css` (wariant bloku ponownego czytania)
- Test: `lesson-views.test.tsx`, `session-progress-state.test.ts`,
  `packages/kid-ui/src/screens/keyboard-navigation.test.tsx` (wybór klawiaturą,
  jeśli plik ma przypadki widoków wyboru)

**Interfaces:**
- Consumes: prompt `lesson_story_question`, `AnswerGrid`, `useChoiceKeyboard`,
  `useExerciseGuidance`.
- Produces:
  - `LessonStoryQuestionView(props: ExerciseProps)`:
    - `ExerciseFrame feedbackLayout="flow"`; instrukcja = pytanie
      (`getExercisePresentation`, Task 1);
    - `content`:
      1. `AnswerGrid` (`className="kid-options"`, `outcomes={optionOutcomes}`,
         `onChoose={handlers.onAnswerChoice}`, bez `optionLang`);
      2. `<section className="kid-lesson-story kid-lesson-story--reread" data-testid="kid-lesson-story-reread">`
         z tytułem, odsłuchem z `useExerciseGuidance()` (bez
         autoodtwarzania) i tekstem `kid-lesson-story-text` z `lang`;
    - frame w `ExerciseGuidanceProvider value={null}`;
    - brak „Nie pamiętam”, „Pomiń” i „Sprawdź”.
  - `export function countsTowardStreak(task: Pick<TaskDto, "exerciseType"> | null): boolean`
    — fałsz dla typów historyjki.
  - `LearnScreen`: `attempt: countsTowardStreak(task) ? progressAttempt(...) : null`
    w `advanceSessionProgress`.

- [ ] **Step 1: Testy (failing).**
  - `lesson-views.test.tsx`:
    - `story question renders question, then options, then the story in DOM order`
      (`compareDocumentPosition`);
    - `story question text and options have no English lang; story text has lang`;
    - `choosing an option answers immediately`;
    - `story question has no dont-remember, skip or check action`;
    - `feedback hides the story listen button` — przy dostarczonym `dock`
      i `ExerciseGuidanceProvider value={null}` liczba `kid-question-audio` = 0.
  - `session-progress-state.test.ts`:
    - `story question attempts do not change the streak or milestone`;
    - `countsTowardStreak` dla `lesson_choice` → prawda, dla obu typów
      historyjki → fałsz.
- [ ] **Step 2:** `pnpm vitest run packages/kid-ui` — FAIL.
- [ ] **Step 3: Implementacja** wg „Interfaces”. Wynik pokazuje istniejący dok
  (`AnswerFeedbackContent`: „Świetnie!” albo „Poprawna odpowiedź” + tekst opcji;
  `AnswerFeedbackActions` z „Dalej”).
- [ ] **Step 4:** Uruchom:
  - `pnpm vitest run packages/kid-ui tests/kid-design-tokens.test.ts`;
  - `pnpm typecheck`.

  Oczekiwane: PASS.
- [ ] **Step 5: Commit** `Historyjka: pytania o treść w Kid UI`.

---

### Task 7: E2E — geometria i przebieg `mocked`, przebieg `real`

**Files:**
- Create: `tests/e2e/lesson-story.spec.ts` (+ wpis w `MOCKED_SPECS`, `tests/e2e/spec-projects.ts`)
- Modify: `tests/e2e/helpers/lesson-audio.ts` (fabryki zadań historyjki, najgorszy przypadek)
- Modify: `tests/e2e/lesson-real-flow.spec.ts` (nowy test, opcja `createAssignedLesson`)

**Interfaces:**
- Produces (`lesson-audio.ts`):
  - `export const STORY_WORST_CASE` — 5 zdań, łącznie 700 znaków (każde ≤ 160),
    pytanie 160 znaków, trzy opcje po 80 znaków; treść zmyślona;
  - `export function storyTask(sessionId: string, taskId: string, options?: { audioAssetId?: string; sentences?: readonly string[] }): TaskDto`
    (`remainingAssessed: 0`);
  - `export function storyQuestionTask(sessionId: string, taskId: string, optionIds: readonly string[], content?: { question: string; options: readonly string[]; sentences: readonly string[] }, audioAssetId?: string): TaskDto`.
- `createAssignedLesson(page, { ..., beforePublish?: (page: Page, deckId: string) => Promise<void> })`
  w `lesson-real-flow.spec.ts`.

- [ ] **Step 1: Spec `mocked`** `lesson-story.spec.ts`. Fixture wzorem
  `lessonAudioFixture` / `lessonTaskFixture`: ostatnie zadanie oceniane
  (`lesson_choice`, `remainingAssessed: 1`, `closingStory: true`), historyjka,
  pytanie 1, pytanie 2, `null`. Odtwarzanie przez `stubListenAudio`
  / `listenAudioPlays`. Testy:
  - `last assessed task announces the story` — `kid-remaining` ma tekst
    „Jeszcze 1 i historyjka!”;
  - `story autoplays once after the last task and replays on demand` —
    `listenAudioPlays` = 1 po pokazaniu historyjki, 2 po kliknięciu
    `kid-question-audio`; „Dalej” przerywa odtwarzanie (`stubListenAudio(page, "hold")`
    i `listenAudioPausedCurrent` po kliknięciu `kid-lesson-next`);
  - `story without a recording has no listen button and plays nothing`;
  - `story questions show the result and the correct answer` — dobra odpowiedź:
    „Świetnie!”; zła: `kid-feedback-correct-answer` z tekstem poprawnej opcji;
    po ostatnim „Dalej” podsumowanie `kid-summary`;
  - `story playback error shows the story message and keeps next reachable`
    (`audioReady: false` przy ręcznym odsłuchu → `kid-question-audio-error`
    z tekstem `storyAudioUnavailable`; autoodtwarzanie bez komunikatu);
  - geometria (najgorszy przypadek, widoki: 390×844, 844×390, 768×1024,
    1280×800 oraz 1920×1080 z `waitForKidScale(page, 1.2)`):
    - `story view fits every form factor`:
      - `scrollWidth ≤ innerWidth`;
      - `expectFrameFillsViewport`;
      - `expectInteractiveTargets` (`kid-lesson-next`, `kid-question-audio`) ≥ 48 px;
      - `kid-lesson-next` w viewporcie bez przewijania strony;
      - `lineLengths(page, '[data-testid="kid-lesson-story-text"]')` ≤ 70 znaków;
    - `story question keeps the first option visible without scrolling`:
      - dolna krawędź pierwszego `kid-option` ≤ wysokość okna przed
        jakimkolwiek przewinięciem, także w 844×390;
      - brak przepełnienia poziomego;
      - opcje ≥ 48 px;
      - po odpowiedzi `kid-next` osiągalny (`scrollIntoViewIfNeeded`, potem
        prostokąt w viewporcie).
- [ ] **Step 2:** Uruchom
  `UMIEM_E2E_WEB_MODE=dev pnpm exec playwright test tests/e2e/lesson-story.spec.ts --project=mocked`
  oraz `pnpm vitest run tests/e2e/spec-projects.test.ts`. Oczekiwane: PASS
  (spec powstaje po Task 5–6; czerwony przebieg sprawdź, usuwając na chwilę
  wpis gałęzi `lesson_story` z `ExerciseView`).
- [ ] **Step 3: Przebieg `real`** w `lesson-real-flow.spec.ts`, test
  `lesson session closes with the story and its questions without changing progress`:
  - `createAssignedLesson` z `beforePublish`:
    - czeka na wygenerowaną historyjkę (`lesson-story-sentence-0` niepuste,
      `timeout: 120_000`);
    - zmienia zdanie 0 na unikalne (`Sam has a red bike ${suffix}.`
      → zapis, PATCH ze `story`);
  - po publikacji czeka na `published.storyAudio.state === "ready"`
    (`expect.poll` po `GET /api/v1/parent/lessons/{deckId}`);
  - SQL: `session_task_budget = 2`;
  - dziecko (`prepareKidAudio`):
    - karty `advanceLessonCard`, zadania `answerGuided` aż do `lesson_story`;
    - na ostatnim zadaniu ocenianym `kid-remaining` ma tekst
      „Jeszcze 1 i historyjka!”;
    - historyjka: `kid-lesson-story-text` zawiera zmienione zdanie
      i ma `lang="en-GB"`; autoodtwarzanie pobiera nagranie historyjki
      (`media:<storyAssetId>:200` w logu);
  - pytania: pierwsze poprawnie (`answer_key.correctOptionId`) → „Świetnie!”,
    kolejne błędnie → `kid-feedback-correct-answer`; po ostatnim „Dalej”
    `kid-summary`;
  - SQL po sesji:
    - próby pytań bez `assessments`;
    - `child_objective_progress` taki jak po samych zadaniach ocenianych
      (odczyt przed historyjką i po niej).
- [ ] **Step 4: Przegląd skutków ubocznych `real`.** `lesson-real-flow.spec.ts`
  (pozostałe testy kończą sesję przyciskiem „Koniec”, ale `currentTask` i pętle
  kroków nie mogą trafić na typ historyjki jako „nieobsługiwane ćwiczenie”).
  Uruchom:
  ```bash
  UMIEM_E2E_WEB_MODE=dev pnpm exec playwright test tests/e2e/lesson-real-flow.spec.ts tests/e2e/lesson-parent.spec.ts tests/e2e/lesson-kid.spec.ts tests/e2e/lesson-card-audio-layout.spec.ts tests/e2e/lesson-question-audio-layout.spec.ts
  ```
  Oczekiwane: PASS.
- [ ] **Step 5: Commit** `Historyjka: E2E sesji z historyjką i geometria widoków`.

---

### Task 8: Tekst dla rodzica, wymagania, dokumentacja i pełna weryfikacja

**Files:**
- Modify: `packages/contracts/src/messages.ts` (`lessons.story.info` = tekst §11:
  „Dziecko przeczyta i posłucha historyjki na koniec każdej sesji, a potem odpowie na pytania. Pytania nie liczą się do postępu.”;
  usuń komentarz etapu 1)
- Test: `apps/web/src/parent/lessons/lesson-story-section.test.tsx` (asercja `info` bez zmian w kodzie testu — sprawdź, że przechodzi)
- Modify: `.kiro/specs/grammar-module/requirements.md`:
  - 2.13: dopisane zdanie z §12 specu;
  - 5.4: dopowiedzenie o historyjce poza budżetem i limitem czasu;
  - wymaganie 12: zdejmij oznaczenia „(etap 3)” z pkt 10–12 i zaktualizuj
    akapit wstępu (wszystkie etapy w kodzie).
- Modify: `AGENTS.md` (UX): „Po «Jeszcze 3 i koniec!» nie dokładaj zadań ponad
  obiecany budżet; wyjątek: zapowiedziana banerem «Jeszcze N i historyjka!»
  historyjka lekcji jest zamknięciem sesji, nie zadaniem budżetu.”
- Modify: `docs/SPEC.md`: §22 (nagranie historyjki czytane dziecku na koniec
  sesji, bez stylu, publikacja nie czeka) i §29a.3 (historyjka i pytania po
  zadaniach sesji, także po limicie czasu; poza budżetem i postępem; nie
  w kartkówce; baner) — ruling 8.
- Modify: `docs/architecture.md` §19.13: akapit „Sesja i Kid UI (etap 3)”:
  - typy zadań i predykat;
  - sloty planu, wybór na końcu sesji (ruling 1), `remainingAssessed = 0`
    i `closingStory`;
  - `answerStoryQuestion` bez ocen;
  - ujawnienia i routing prób;
  - migracja `0035`;
  - Kid UI (widoki, ciche autoodtwarzanie);
  - wdrożenie: web i worker razem; otwarta karta starej PWA nie zna nowych
    gałęzi promptu (błąd parsowania do odświeżenia); stary serwer czyta nowy
    plan jako nieznany → `conflict` „Ta sesja wymaga nowszej wersji aplikacji”.

  Usuń zdanie „Dziecko nagrania jeszcze nie słyszy…” z akapitu „Panel (etap 2)”.
- Modify: `docs/superpowers/specs/2026-11-01-lesson-end-story-design.md`:
  - status „etapy 1–3 zaimplementowane”;
  - nowy podrozdział „§8.7 Uzupełnienie z planowania etapu 3” z rulingami 1–13
    tego planu (krótko).

- [ ] **Step 1: Tekst i dokumentacja** wg listy plików.
- [ ] **Step 2: MCP i skill.** Uruchom:
  ```bash
  grep -rn "remainingAssessed\|TaskDto\|TaskPromptSchema\|lesson_story\|closingStory\|EXERCISE_TYPES\|exerciseType" apps/web/src/integrations integrations/umiem-mcp
  ```
  Oczekiwane: brak trafień. Do opisu PR: zmiana Kid API (gałęzie promptu,
  `remainingAssessed ≥ 0`, `closingStory`) nie dotyczy MCP —
  `learning-overview` świadomie nie obejmuje lekcji; adapter, schemat
  i `SKILL.md` bez zmian.
- [ ] **Step 3: Pełna weryfikacja.** Uruchom:
  - `pnpm typecheck`;
  - `pnpm test:unit`;
  - `pnpm test:integration`;
  - `pnpm build`;
  - `pnpm test:e2e:shards`.

  Oczekiwane: wszystko PASS (poza znanymi pominięciami zrzutów
  `kid-large-screen.spec.ts`). Do raportu: autoodtwarzanie na fizycznym
  iPhonie/iPadzie (polityka autoplay Safari) niezweryfikowane — symulacja nie
  jest odbiorem urządzenia.
- [ ] **Step 4: Commit** `Historyjka etap 3: tekst dla rodzica, wymagania i dokumentacja`.
