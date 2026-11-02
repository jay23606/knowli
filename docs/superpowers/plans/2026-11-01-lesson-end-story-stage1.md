# Historyjka lekcji — etap 1 (dane, generowanie, edycja) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ten etap obejmuje:
- historyjkę jako dane wersji lekcji gramatyki;
- generowanie w osobnym runie (automatycznie po lekcji i przyciskiem);
- walidację z barierą ekspozycji;
- edycję, usuwanie i publikację w panelu rodzica.

Dziecko jeszcze nic nie widzi.

**Architecture:** Reguły w domenie lekcji:
- `domain/lessons/story.ts`;
- flaga `SubjectModule.lessonStory` i `prompts.storyRules`.

Generowanie i zapis w `materials/lessons`:
- nowy plik `lesson-story-generation.ts` z runem `kind='lesson'`,
  `input.purpose='story'`;
- zmiany w `lesson-api.ts` i `lesson-drafts.ts`.

Kontrakty: `packages/contracts/src/lessons.ts` i `apps/web/src/parent/orpc-contract.ts`.

Panel rodzica: nowy komponent sekcji w `apps/web/src/parent/lessons/`.

**Tech Stack:** TypeScript strict, Zod, Drizzle + PostgreSQL, Vitest, oRPC, React + Mantine 9 (panel rodzica), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-01-lesson-end-story-design.md` — §4, §5, §6, §11 (bez odsłuchu), §12 (część rodzica), §14, §15, §16 etap 1.

## Global Constraints

- Kod, identyfikatory i DTO piszemy po angielsku. Teksty UI i błędy dla rodzica
  po polsku, w katalogu komunikatów `packages/contracts/src/messages.ts`.
- Silnik lekcji nie zna przedmiotów: brak literałów `english_grammar`/`school`/`english_chapter` w `domain/lessons` (poza `subjects/`), `modules/materials/lessons`, `modules/learning/lessons`, `providers/` (poza `fake.ts`) — pilnuje `domain/lessons/architecture.test.ts`.
- Domena (`src/domain`) nie importuje Drizzle, oRPC, Zod-owych schematów kontraktów, SDK ani env; czas/ID przekazywane jawnie.
- Inny obszar importuje tylko z barrela (`../materials` itd.); granic pilnuje
  `packages/server/src/modules/module-boundaries.architecture.test.ts`.
- Liczby z §4 specu:
  - zdania: 4–6, każde ≤ 160 znaków, całość ≤ 700 znaków;
  - pytania: 1–2, każde ≤ 160 znaków;
  - opcje: dokładnie 3 na pytanie, każda ≤ 80 znaków;
  - prompt: ≤ 120 rozwiązanych zdań „nie powtarzaj”.
- Do LLM nie trafiają dane dziecka (imię, wiek, identyfikatory).
- Panel rodzica używa wyłącznie Mantine i żyje w `apps/web/src/parent`.
- Istniejące kontrakty pozostają zgodne wstecz: nowe pola DTO są opcjonalne.
- Nowy plik integracyjny trafia do najlżejszego kosza `tests/integration-buckets.ts`.
  Nowy lub zmieniony spec E2E trafia do partycji w `tests/e2e/spec-projects.ts`.
- Commity kończą się linią `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

### Doprecyzowanie specu §6.2 (ustalone przy planowaniu; Task 7 wpisuje je do specu)

**Run historyjki a numer edycji:**
- Run historyjki **nie podbija** `editNumber` i nie sprawdza go przy
  finalizacji. Inaczej rodzic, który zaczął poprawiać lekcję zaraz po
  generowaniu, dostałby konflikt zapisu, gdy po ok. 20 s dojdzie historyjka.
- Finalizacja wymaga tylko trzech warunków: run nadal `running` z tą samą liczbą
  prób, wersja nieopublikowana, historyjka poprawna wobec **bieżącej** puli.
  Zapis to scalenie klucza `story` w `lesson_context` pod blokadą wersji.

**Co anuluje (`superseded`) run historyjki:**
- edycja z polem `story` w patchu (wybór rodzica wygrywa);
- publikacja (`state === published` przy finalizacji);
- nowy pełny run lekcji.

**Czego run historyjki nie blokuje i co go nie anuluje:**
- zwykła edycja ćwiczeń, tytułu i przykładów go nie anuluje;
- dogenerowanie reguły go nie anuluje, a aktywny run historyjki nie blokuje
  dogenerowania.

**Panel:**
- `LessonDeckDto.generation` nadal pokazuje tylko runy lekcji
  (`purpose !== 'story'`);
- nowe pole `LessonDeckDto.storyGeneration` niesie najnowszy run historyjki.
  Zastępuje ono pole `GenerationDto.purpose` ze specu.

**Ponowienie runu historyjki (`retryGeneration`):** ponownie kolejkuje run
z `expectedEditNumber` = bieżący numer, bez podbijania numeru i bez anulowania
innych runów.

## Review Focus

1. **Edycja w trakcie runu.** Rodzic zapisuje zmianę ćwiczenia, gdy run
   historyjki trwa. Oczekiwane: zapis bez konfliktu, a historyjka i tak
   dochodzi. Test: Task 5, `story run survives exercise edit`.
2. **Kolizja różniąca się zapisem.** Zdanie historyjki różni się od rozwiązania
   ćwiczenia tylko interpunkcją lub skrótem („She doesn't play.” wobec
   „she does not play”). Oczekiwane: odrzucone. Test: Task 1,
   `rejects sentence equal to solved sentence after normalization`.
3. **Kopia bez zmian.** Opublikowana wersja z historyjką zostaje skopiowana do
   nowego szkicu i opublikowana bez zmian. Oczekiwane: historyjka zostaje,
   publikacja przechodzi, nie ma runu historyjki. Test: Task 5,
   `copy of published version keeps story and republishes`.
4. **Za mało zdań przy zapisie.** Rodzic zapisuje historyjkę z 3 zdaniami.
   Oczekiwane: `validation` z polskim komunikatem w `details.story`, nic się nie
   zapisuje, a sekcja pokazuje błąd. Testy: Task 5 (API) i Task 6 (sekcja).
5. **Przedmioty bez flagi i stare lekcje.** Lekcje `school` i `english_chapter`
   nie dostają runu historyjki, sekcji (`storyEnabled` fałszywe) ani nowej
   walidacji publikacji. Test: Task 4,
   `no story run for subject without lessonStory`.

---

### Task 1: Domena historyjki i flaga przedmiotu

**Files:**
- Create: `packages/server/src/domain/lessons/story.ts`
- Create: `packages/server/src/domain/lessons/story.test.ts`
- Modify: `packages/server/src/domain/lessons/types.ts`. W `SubjectModule` dochodzi
  `readonly lessonStory?: boolean;`, a w `SubjectPromptProfile` dochodzi
  `readonly storyRules?: string;`. Oba pola z komentarzem po polsku jak sąsiednie.
- Modify: `packages/server/src/domain/lessons/catalog-validation.ts` (+ test w `catalog-validation.test.ts`)
- Modify: `packages/server/src/domain/lessons/subjects/english-grammar/module.ts` (`lessonStory: true`), `.../english-grammar/prompts.ts` (`storyRules`), `.../english-grammar/module.test.ts`

**Interfaces:**
- Produces (eksport z `domain/lessons/story.ts`):
  - `interface LessonStoryOption { readonly id: string; readonly text: string }`
  - `interface LessonStoryQuestion { readonly id: string; readonly question: string; readonly options: readonly LessonStoryOption[]; readonly correctOption: string }`
  - `interface LessonStory { readonly sentences: readonly string[]; readonly questions: readonly LessonStoryQuestion[] }`
  - `const LESSON_STORY_LIMITS = { minSentences: 4, maxSentences: 6, sentenceMaxLength: 160, textMaxLength: 700, minQuestions: 1, maxQuestions: 2, questionMaxLength: 160, optionCount: 3, optionMaxLength: 80, avoidSentencesMax: 120 } as const`
  - `function solvedSentencesOf(drafts: readonly LessonExerciseDraft[]): string[]`:
    - dla każdego ćwiczenia `feedbackSentenceText(draft)` (pomija `null`);
    - dla typów `lesson_error_fix`, `lesson_transform` i `lesson_open_answer`
      dodatkowo `answer` i każdy wpis `acceptedAnswers`;
    - wynik po `trim`, bez pustych, bez duplikatów, w kolejności wystąpienia.
  - `function storyCollisions(sentences: readonly string[], solvedSentences: readonly string[], normalizer: AnswerNormalizer): number[]` — indeksy zdań kolidujących (bariera ekspozycji; używana też przy dogenerowaniu)
  - `function validateLessonStory(story: LessonStory, ctx: { normalizer: AnswerNormalizer; solvedSentences: readonly string[] }): string[]`
  - `function storyReadText(story: LessonStory): string` — zdania po `trim`
    i scaleniu białych znaków, złączone pojedynczą spacją.

- [ ] **Step 1: Napisz testy `story.test.ts`.** Pomocnik
  `validStory()` buduje 4 zdania, 1 pytanie, opcje `a/b/c` i `correctOption "a"`.
  Testy i oczekiwane wyniki:
  - `accepts a valid story` → `[]`;
  - `rejects 3 and 7 sentences` → zawiera `"Historyjka ma mieć od 4 do 6 zdań."`;
  - `rejects empty sentence` (`"   "`) → `"Zdanie 2 jest puste."`;
  - `rejects sentence longer than 160` → `"Zdanie 1 jest dłuższe niż 160 znaków."`;
  - `rejects story longer than 700` (6 zdań po 130 znaków) →
    `"Historyjka jest dłuższa niż 700 znaków."`;
  - `rejects 0 and 3 questions` → `"Historyjka ma mieć 1 lub 2 pytania."`;
  - `rejects duplicate question ids` → `"Pytania mają powtarzające się identyfikatory."`;
  - `rejects empty or long question` → `"Pytanie 1 jest puste."` /
    `"Pytanie 1 jest dłuższe niż 160 znaków."`;
  - `rejects option count other than 3` → `"Pytanie 1 ma mieć dokładnie 3 odpowiedzi."`;
  - `rejects duplicate option text ignoring case` (`"Kot"`, `"kot "`) →
    `"Pytanie 1 ma powtarzające się odpowiedzi."`;
  - `rejects empty or long option` → `"Pytanie 1: odpowiedź 2 jest pusta."` /
    `"Pytanie 1: odpowiedź 2 jest dłuższa niż 80 znaków."`;
  - `rejects unknown correctOption` → `"Pytanie 1 nie ma wskazanej poprawnej odpowiedzi."`;
  - `rejects sentence equal to solved sentence after normalization`. Używa
    `englishNormalizer` z `subjects/english/normalizer` (test może importować
    `subjects/`). `solvedSentences ["She does not play football."]`, zdanie
    `"she doesn't play football"` → `"Zdanie 1 powtarza rozwiązanie ćwiczenia."`;
  - `allows partial overlap`: zdanie `"Tom plays football on Sundays."`, solved
    `["Tom plays tennis."]` → `[]`;
  - `solvedSentencesOf`:
    - gap ze `stem "She ___ football."` i `answer "plays"` →
      `"She plays football."`;
    - choice: `stem` z luką i opcja poprawna → wypełnione zdanie;
    - transform z `answer` i `acceptedAnswers ["x"]` → oba;
    - notice → pominięte;
    - duplikaty usunięte;
  - `storyReadText` łączy zdania i scala białe znaki.

- [ ] **Step 2: Uruchom testy i potwierdź, że padają.**
  Run: `corepack pnpm vitest run packages/server/src/domain/lessons/story.test.ts --config vitest.unit.config.ts`
  Expected: FAIL (brak modułu).

- [ ] **Step 3: Zaimplementuj `story.ts` z interfejsami i komunikatami jak w testach.**
  - Numeracja zdań, pytań i opcji jest od 1.
  - Kolejność błędów: zdania, potem pytania.
  - Bariera:
    - zbiór `normalizer.normalize(s).map(t => t.join(" "))` dla wszystkich
      `solvedSentences`;
    - zdanie koliduje, gdy którykolwiek jego wariant jest w zbiorze.
  - Dla historyjki o złej liczbie zdań nadal walidujemy pojedyncze zdania
    (rodzic widzi wszystkie błędy).

- [ ] **Step 4: Flaga i walidacja katalogu.** Dopisz test w `catalog-validation.test.ts`:
  `subject with lessonStory requires non-empty prompts.storyRules`. Oczekiwany
  błąd zawiera `storyRules`. Następnie dodaj regułę w `validateSubject`.

- [ ] **Step 5: Gramatyka.**
  - `module.ts`: `lessonStory: true`.
  - `prompts.ts`: `storyRules` po angielsku. Treść:
    - ćwiczony czas tematu;
    - prosty język dla początkującego ~8-latka;
    - słownictwo z materiału rodzica tam, gdzie się da;
    - 4–6 krótkich zdań o jednej postaci lub sytuacji;
    - formy kilku reguł tematu: twierdzenie, przeczenie, pytanie;
    - pytania po polsku o treść (kto, co, kiedy), nie o gramatykę;
    - 3 krótkie odpowiedzi po polsku, w tym dokładnie jedna poprawna, a błędne
      wiarygodne, ale jednoznacznie sprzeczne z tekstem;
    - nigdy nie powtarzać zdań z listy „do not repeat”.
  - Test w `module.test.ts`: `english grammar enables end-of-session story with
    rules`. Asercje: `lessonStory === true`, `storyRules` niepuste.

- [ ] **Step 6: Uruchom testy domeny i architektury.**
  Run: `corepack pnpm vitest run packages/server/src/domain/lessons --config vitest.unit.config.ts`
  Expected: PASS, w tym `architecture.test.ts` i `registry.test.ts`.

- [ ] **Step 7: Commit** — `Historyjka lekcji: model domeny, walidacja z barierą ekspozycji, flaga przedmiotu`.

---

### Task 2: Kontrakty historyjki (DTO, patch, procedura, komunikaty)

**Files:**
- Modify: `packages/contracts/src/lessons.ts` (+ `lessons.test.ts`)
- Modify: `apps/web/src/parent/orpc-contract.ts`
- Modify: `packages/contracts/src/messages.ts` (sekcja `lessons` panelu rodzica)

**Interfaces:**
- Produces (`@learning/contracts`):
  - `LessonStoryOptionSchema = z.object({ id: z.string().min(1).max(16), text: z.string().max(1000) }).strict()`
  - `LessonStoryQuestionSchema = z.object({ id: z.string().min(1).max(16), question: z.string().max(1000), options: z.array(LessonStoryOptionSchema).max(10), correctOption: z.string().max(16) }).strict()`
  - `LessonStorySchema = z.object({ sentences: z.array(z.string().max(1000)).max(20), questions: z.array(LessonStoryQuestionSchema).max(10) }).strict()`
    i `type LessonStoryDto`. Schemat celowo luźny, a reguły i komunikaty daje
    domena.
  - `LessonDraftDtoSchema` dostaje `story: LessonStorySchema.optional()`
    i `storyEnabled: z.boolean().optional()`.
  - `LessonDeckDtoSchema` dostaje `storyGeneration: GenerationDtoSchema.nullable().optional()`.
  - `orpc-contract.ts`:
    - `LessonDraftPatchContractSchema` dostaje `story: LessonStorySchema.nullable().optional()`;
    - nowa procedura `lessonDrafts.regenerateStory`, input
      `{ lessonDraftId: Uuid, expectedEditNumber: int>0, clientRequestId: Uuid }`
      (`.strict()`), output `{ runId: Uuid, deckId: Uuid }`;
    - ścieżka jak sąsiednie, np. `POST /lesson-drafts/{lessonDraftId}/story/regenerate`.
  - `messages.lessons.story` dla rodzica:
    - `title: "Historyjka na koniec sesji"`;
    - `info: "Dziecko przeczyta i posłucha historyjki na koniec każdej sesji, a potem odpowie na pytania. Pytania nie liczą się do postępu."`;
    - `sentenceLabel: (n) => \`Zdanie ${n}\``;
    - `addSentence: "Dodaj zdanie"`, `removeSentence: "Usuń zdanie"`;
    - `questionLabel: (n) => \`Pytanie ${n}\``;
    - `optionLabel: (n) => \`Odpowiedź ${n}\``, `correctOption: "Poprawna"`;
    - `addQuestion: "Dodaj pytanie"`, `removeQuestion: "Usuń pytanie"`;
    - `generate: "Wygeneruj historyjkę"`, `regenerate: "Wygeneruj od nowa"`;
    - `regenerateConfirm: "Nowa historyjka zastąpi obecną. Kontynuować?"`;
    - `generating: "Przygotowuję historyjkę…"`;
    - `failed: "Historyjka nie powstała."`, `retry: "Spróbuj ponownie"`;
    - `remove: "Usuń historyjkę"`;
    - `empty: "Ta lekcja nie ma jeszcze historyjki."`;
    - `publishedHint: "Utwórz nową wersję, aby dodać lub zmienić historyjkę."`.

  Jeśli katalog komunikatów ma funkcje w innym stylu (np. szablony
  `{n}`), zastosuj styl katalogu.

- [ ] **Step 1: Testy w `lessons.test.ts`:**
  - `LessonStorySchema accepts story and rejects extra fields`: dodatkowe
    `correctText` w pytaniu daje błąd;
  - `LessonDraftDto parses without story fields` (zgodność wstecz);
  - `LessonDraftDto parses with story and storyEnabled`;
  - `LessonDeckDto accepts storyGeneration null and run`.

- [ ] **Step 2: Uruchom i potwierdź porażkę.**
  `corepack pnpm vitest run packages/contracts/src/lessons.test.ts --config vitest.unit.config.ts` → FAIL.

- [ ] **Step 3: Zaimplementuj schematy, kontrakt oRPC i komunikaty.**

- [ ] **Step 4: Sprawdź testy i typy.**
  - `corepack pnpm vitest run packages/contracts --config vitest.unit.config.ts` → PASS.
  - `corepack pnpm typecheck` → ewentualne błędy tylko w miejscach, które
    implementuje `parent-router` (Task 5). Jeśli typecheck wymaga handlera
    procedury, dodaj tymczasowo handler rzucający
    `AppError("internal", { message: "not implemented" })` i usuń go w Task 5.

- [ ] **Step 5: Commit** — `Historyjka lekcji: kontrakty DTO, patch, procedura i komunikaty`.

---

### Task 3: Port LLM `generateLessonStory` (OpenAI + fake)

**Files:**
- Modify: `packages/server/src/ports/ai.ts`
- Modify: `packages/server/src/providers/openai/llm.ts` (+ `llm.test.ts`)
- Modify: `packages/server/src/providers/fake.ts` (+ `fake.test.ts`)
- Modify: `tests/probes/chapter-generation.probe.test.ts` tylko wtedy, gdy
  implementuje `LlmProvider` i typecheck tego wymaga (dodaj tam metodę rzucającą).

**Interfaces:**
- Produces (`ports/ai.ts`):
  ```ts
  export interface LessonStoryInput {
    readonly subjectTitle: string;
    readonly topicTitle: string;
    readonly answerLocale: string;
    readonly promptLocale: string;
    readonly objectives: readonly { readonly id: string; readonly descriptionEn: string }[];
    readonly material: string;
    readonly instruction?: string;
    readonly generationRole: string;
    readonly storyRules: string;
    readonly avoidSentences: readonly string[];
  }
  // w LlmProvider:
  generateLessonStory(input: LessonStoryInput, signal?: AbortSignal): Promise<{ story: unknown }>;
  ```
- Surowy kształt odpowiedzi modelu: `{ sentences: string[], questions: { question: string, options: string[], correctOptionIndex: integer }[] }`. Mapowanie na `LessonStory` robi Task 4.

- [ ] **Step 1: Testy w `llm.test.ts`** (wzorem testów `generateLessonObjectives`):
  - `generateLessonStory sends strict json_schema lesson_story`;
    - `response_format.json_schema.name === "lesson_story"`;
    - `strict === true`;
    - schemat wymaga `sentences` i `questions`;
    - pytanie wymaga `question`, `options`, `correctOptionIndex`;
  - `generateLessonStory system prompt contains storyRules, topic, objectives and avoid list`;
  - `generateLessonStory user message is the parent material block`
    (`lessonUserMaterial`);
  - `generateLessonStory returns parsed object as story`;
  - `generateLessonStory maps refusal and length to GenerationProviderError`
    (`refusal`, `incomplete`), tak jak obiektywy.

  Test w `fake.test.ts`: `fake generateLessonStory returns 4 sentences and 1 question with index in range`.

- [ ] **Step 2: Uruchom i potwierdź porażkę.**
  `corepack pnpm vitest run packages/server/src/providers --config vitest.unit.config.ts` → FAIL.

- [ ] **Step 3: Zaimplementuj.**
  - **OpenAI:**
    - `lessonStoryJsonSchema()` i `lessonStorySystemPrompt(input)`;
    - zapytanie identyczne z `generateLessonObjectives`: timeout
      `lessonRequestTimeoutMs`, `withChatRequestExtras`, `lessonHttpError`,
      `asLessonTransportError`;
    - prompt po angielsku, z rolą (`generationRole`), tematem, celami,
      `storyRules`, językami (zdania w `answerLocale`, pytania i odpowiedzi
      w `promptLocale`) i limitami z `LESSON_STORY_LIMITS`, a na końcu lista
      „Do not repeat any of these sentences:” (≤ 120 pozycji);
    - wynik: `{ story: parsed }`, gdy `parsed` jest obiektem; inaczej
      `GenerationProviderError("output")`.
  - **Fake:** stała historyjka. Zdania nie mogą kolidować z pulą fake'a
    („Sam has a red bike.” …). Jedno pytanie
    `"Jaki rower ma Sam?"`, opcje `["czerwony", "niebieski", "zielony"]`,
    `correctOptionIndex: 0`.

- [ ] **Step 4: Uruchom testy providerów i typecheck.**
  `corepack pnpm vitest run packages/server/src/providers --config vitest.unit.config.ts` → PASS.
  `corepack pnpm typecheck` → PASS.

- [ ] **Step 5: Commit** — `Historyjka lekcji: port LLM generateLessonStory (OpenAI strict schema, fake)`.

---

### Task 4: Run historyjki (kolejkowanie, wykonanie, przycisk, ponowienie)

**Files:**
- Create: `packages/server/src/modules/materials/lessons/lesson-story-generation.ts`
- Modify: `packages/server/src/modules/materials/lessons/lesson-drafts.ts`
- Modify: `packages/server/src/modules/materials/generation-runs.ts` (`supersedeLessonRuns`)
- Modify: `packages/server/src/modules/materials/generation.ts` (`retryGeneration`)
- Modify: `packages/server/src/modules/materials/index.ts` i `packages/server/src/index.ts` (eksport `regenerateLessonStory`)
- Create: `tests/integration/lesson-story.test.ts`
- Modify: `tests/integration-buckets.ts` (dopisz plik do najlżejszego kosza)

**Interfaces:**
- Consumes:
  - Task 1: `LessonStory`, `validateLessonStory`, `solvedSentencesOf`,
    `LESSON_STORY_LIMITS`;
  - Task 3: `LessonStoryInput`, `generateLessonStory`.
- Produces (`lesson-story-generation.ts`):
  - `const LESSON_STORY_PURPOSE = "story"` — wartość `generation_runs.input.purpose`;
  - `function isStoryRunInput(input: unknown): boolean`;
  - `function storyFromGenerated(raw: unknown): LessonStory | null`:
    - parsowanie Zod surowego kształtu z Task 3;
    - mapowanie: pytania na `q1`, `q2`; opcje na `a`, `b`, `c` w kolejności;
      `correctOption` = id opcji z indeksu;
    - `null` przy złym kształcie lub indeksie poza zakresem;
  - `async function queueLessonStoryRunTx(tx: Tx, services: Services, version: { id: string; deckId: string; editNumber: number; lessonContext: Record<string, unknown> | null }, dedupeKey: string): Promise<string | null>`:
    - zwraca `runId` albo `null`;
    - `null`, gdy przedmiot kontekstu nie ma `lessonStory`;
    - nie kolejkuje, gdy aktywny run historyjki już istnieje (zwraca jego id);
  - `async function executeLessonStoryGeneration(services: Services, runId: string, options?: { signal?: AbortSignal }): Promise<void>`;
  - `async function regenerateLessonStory(services: Services, args: { deckVersionId: string; expectedEditNumber: number; clientRequestId: string }): Promise<{ runId: string; deckId: string }>`;
  - `async function latestLessonStoryRun(db: Executor, deckVersionId: string): Promise<GenerationDto | null>`.
- Zmienia sygnaturę `supersedeLessonRuns(db, deckVersionId, finishedAt, exceptRunId?, options?: { includeStoryRuns?: boolean })`:
  - domyślnie `includeStoryRuns: false`, czyli anuluje tylko runy lekcji
    (`coalesce(input->>'purpose','lesson') <> 'story'`);
  - `true` anuluje wszystkie.
- `LessonRunInput` (lesson-drafts) dostaje `purpose?: "story"`.

- [ ] **Step 1: Testy integracyjne `tests/integration/lesson-story.test.ts`.**
  Wzoruj się na `lesson-generation.test.ts`: fake provider, `createLesson`,
  `executeLessonGeneration` wołane wprost. Testy:
  - `full lesson run queues a story run for grammar`. Po finalizacji runu lekcji
    istnieje jeden run `kind='lesson'` z `input.purpose='story'`, stan `queued`,
    dedupe `lesson-story:<runId lekcji>`.
  - `no story run for subject without lessonStory`. Lekcja przedmiotu szkolnego
    (`createSchoolLesson`/`createMaterialLesson` jak w istniejących testach) nie
    ma runu historyjki.
  - `regenerate objective run does not queue a story run`.
  - `story run writes story without bumping editNumber`. `executeLessonGeneration(storyRunId)`:
    - `lesson_context.story` ma 4 zdania, pytanie `q1` i opcje `a/b/c`;
    - `editNumber` bez zmian;
    - stan wersji `review`;
    - run `succeeded`.
  - `story run survives exercise edit`. Kolejność: run lekcji, potem
    `editLessonDraft` ze zmienionym tytułem (bez `story`), potem wykonanie runu
    historyjki. Wynik: historyjka zapisana, run `succeeded`.
  - `story patch supersedes active story run` (wymaga Task 5; wpisz test tutaj
    jako `it.todo` i zamień na test w Task 5).
  - `story run becomes superseded when version is published`.
  - `invalid generated story fails with story_invalid and keeps previous story`.
    Fake zwraca zdanie równe rozwiązaniu ćwiczenia puli, przez wstrzyknięty
    fake LLM z nadpisanym `generateLessonStory`, tak jak istniejące testy
    nadpisują metody providera.
  - `provider refusal fails story run without retry`. Transient → `queued`
    z `nextAttemptAt`, jak w runach lekcji.
  - Przycisk `regenerateLessonStory`:
    - published → `immutable`;
    - zły `expectedEditNumber` → `conflict`;
    - aktywny run lekcji (nie historyjki) → `conflict`;
    - aktywny run historyjki → `conflict`;
    - przedmiot bez flagi → `validation`;
    - ten sam `clientRequestId` dwukrotnie → ten sam `runId`.
  - `retryGeneration of failed story run requeues without bumping editNumber`.
  - `regenerateObjective is not blocked by a queued story run`.

- [ ] **Step 2: Uruchom test i potwierdź porażkę.**
  `UMIEM_TEST_RUN_ID=story corepack pnpm exec vitest run tests/integration/lesson-story.test.ts --config vitest.integration.config.ts` → FAIL.

- [ ] **Step 3: Zaimplementuj `lesson-story-generation.ts`.**
  - **Wykonanie:**
    - `claimQueuedRun`, potem `withLessonGenerationControl`;
    - `assertCurrent` sprawdza tylko: run `running` z tą samą liczbą prób
      i wersja nieopublikowana;
    - termin `executionPolicy.runTimeoutMs`;
    - klasyfikacja błędów, retry i opóźnienia przez `classifyLessonGenerationFailure`
      i `lessonRetryDelayMs`, z tymi samymi `MAX_AUTOMATIC_ATTEMPTS` co
      `executeLessonGeneration`. Brakujące helpery wyeksportuj z
      `lesson-drafts.ts`, nie kopiuj ich.
  - **Wejście LLM:**
    - temat z `resolveLessonTopic`;
    - cele z `objectiveIds`;
    - `avoidSentences` = `solvedSentencesOf` bieżących rewizji wersji
      (≤ `avoidSentencesMax`);
    - `material` i `instruction` z kontekstu.
  - **Finalizacja w transakcji:**
    1. blokada wersji (`for update`), potem runu;
    2. run nie jest `running` albo zmieniła się liczba prób → wyjście;
    3. wersja `published` → `superseded`;
    4. `storyFromGenerated` → `null` daje `failed`/`story_invalid`;
    5. `validateLessonStory` z `solvedSentencesOf` puli przeczytanej **w tej
       transakcji** → błędy dają `failed`/`story_invalid`;
    6. zapis `lessonContext: { ...prev, story }`, bez zmiany `editNumber`
       i stanu → `succeeded`.
  - **Przycisk** `regenerateLessonStory` — kopia struktury `regenerateObjective`:
    - dedupe `lesson-story:<clientRequestId>`;
    - `input` = `LessonRunInput` z kontekstu + `purpose: "story"`;
    - `expectedEditNumber` = bieżący.
  - **Ponowienie** w `retryGeneration` (gałąź `run.kind === "lesson"`): gdy
    `isStoryRunInput(run.input)`:
    - pod blokadą wersji i runu: wersja nieopublikowana, stan `failed` albo
      odroczony `queued`;
    - ustaw `state: "queued", attempts: 0, errorCode: null, finishedAt: null,
      nextAttemptAt: null, expectedEditNumber: version.editNumber`;
    - bez podbijania numeru edycji i bez anulowania innych runów.

- [ ] **Step 4: Wpięcie w `lesson-drafts.ts`.**
  - `executeLessonGeneration`: zaraz po sprawdzeniu `run.kind`, gdy
    `isStoryRunInput(run.input)` → `return executeLessonStoryGeneration(services,
    runId, options)`.
  - Finalizacja pełnego runu (`!input.regenerate`), po
    `supersedeLessonRuns(tx, version.id, now, runId, { includeStoryRuns: true })`:
    `queueLessonStoryRunTx(tx, services, { ...version, editNumber: nextEditNumber,
    lessonContext: nextContext }, \`lesson-story:${runId}\`)`, ale tylko gdy
    `nextContext.story === undefined`.
  - Dogenerowanie (`input.regenerate`): `supersedeLessonRuns` bez `includeStoryRuns`.
  - `regenerateObjective`: zapytanie o aktywny run lekcji pomija runy historyjki.
  - `latestLessonRun` w `lesson-api.ts` pomija runy historyjki
    (`coalesce(input->>'purpose','lesson') <> 'story'`).

- [ ] **Step 5: Uruchom test integracyjny i testy jednostkowe modułu.**
  `UMIEM_TEST_RUN_ID=story corepack pnpm exec vitest run tests/integration/lesson-story.test.ts tests/integration/lesson-generation.test.ts --config vitest.integration.config.ts` → PASS.
  Potem `corepack pnpm vitest run packages/server/src/modules --config vitest.unit.config.ts` → PASS.

- [ ] **Step 6: Commit** — `Historyjka lekcji: osobny run generowania, przycisk i ponowienie`.

---

### Task 5: Edycja, publikacja, DTO, dogenerowanie i procedury rodzica

**Files:**
- Modify: `packages/server/src/modules/materials/lessons/lesson-api.ts`
- Modify: `packages/server/src/modules/materials/lessons/lesson-drafts.ts` (filtr kolizji przy dogenerowaniu)
- Modify: `apps/web/src/orpc/parent-router.ts` (+ `parent-router.test.ts`)
- Modify: `tests/integration/lesson-story.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: domena;
  - Task 2: kontrakty, w tym `LessonDraftPatchContractSchema.story`;
  - Task 4: `regenerateLessonStory`, `latestLessonStoryRun`, `supersedeLessonRuns(..., { includeStoryRuns })`.
- Produces:
  - `LessonDraftDto.story` i `storyEnabled` wypełnione przez `readLessonDraftDto`;
  - `LessonDeckDto.storyGeneration` wypełnione przez `readLessonDeck`
    z `latestLessonStoryRun(db, editable.id)`, gdy jest szkic; inaczej `null`.

- [ ] **Step 1: Testy integracyjne (dopisz do `lesson-story.test.ts`).**
  - **Edycja (`editLessonDraft`):**
    - `edit saves valid story and bumps editNumber`;
    - `edit with story null removes story`;
    - `edit with 3 sentences fails validation with details.story`.
      `AppError("validation")`, a `details.story` zawiera
      `"Historyjka ma mieć od 4 do 6 zdań."`;
    - `edit rejects story sentence equal to an exercise solved in the same patch`.
      Patch ma `exercises` (gap „She ___ football.”/„plays”) i `story` ze zdaniem
      „She plays football.” → `details.story` zawiera
      `"Zdanie 1 powtarza rozwiązanie ćwiczenia."`;
    - `story patch supersedes active story run` (zamiast `it.todo` z Task 4);
    - `edit without story field keeps story and does not supersede story run`;
    - `edit with story on subject without lessonStory fails validation`.
  - **Publikacja (`publishLessonDraft`):**
    - `publish rejects story colliding with exercise`. Zapis kolizji bezpośrednio
      w `lesson_context` (symulacja starych danych) → `validation`
      z `details.story`;
    - `publish without story succeeds`;
    - `publish with story does not wait for audio` (etap 1: brak audio).
  - **Kopia (`createLessonDraftFromPublished`):**
    `copy of published version keeps story and republishes`.
  - **DTO:**
    - `draft dto exposes story and storyEnabled`: `storyEnabled` true dla
      gramatyki, false dla szkoły;
    - `deck dto exposes storyGeneration separately from generation`. Po runie
      lekcji `generation` to run lekcji (`succeeded`), a `storyGeneration`
      to run historyjki (`queued`).
  - **Dogenerowanie:** `regenerated exercise colliding with story is rejected
    and counted`. Fake puli zwraca ćwiczenie o rozwiązaniu równym zdaniu
    historyjki. Ćwiczenie nie trafia do szkicu, a `rejectedCount` rośnie.

- [ ] **Step 2: Uruchom i potwierdź porażki.**
  `UMIEM_TEST_RUN_ID=story corepack pnpm exec vitest run tests/integration/lesson-story.test.ts --config vitest.integration.config.ts` → FAIL na nowych testach.

- [ ] **Step 3: Zaimplementuj w `lesson-api.ts`.**
  - `LessonContextView.story?: LessonStory`; `readLessonContext` przenosi pole.
  - `LessonDraftPatchSchema`: `story: LessonStorySchema.nullable().optional()`.
    Warunek `refine` uwzględnia `story`, a komunikat `refine` dopisuje `story`.
  - `editLessonDraft`:
    - gdy `patch.story !== undefined` i przedmiot nie ma `lessonStory` →
      `validation`;
    - gdy `patch.story` jest obiektem: `validateLessonStory` z
      `solvedSentencesOf` puli **po** zmianach (gdy patch ma `exercises`, z ich
      draftów, inaczej z bieżących rewizji). Błędy dają
      `AppError("validation", { details: { story: errors } })`;
    - walidacja historyjki odbywa się przed zapisem ćwiczeń;
    - zapis do kontekstu: `null` usuwa klucz, obiekt zastępuje;
    - gdy patch ma `story` (także `null`): `supersedeLessonRuns(..., { includeStoryRuns: true })`;
      w przeciwnym razie wywołanie jak dziś.
  - `publishLessonDraft`: gdy `context.story` istnieje → `validateLessonStory`
    z `solvedSentencesOf(drafts)`. Błędy dają
    `validation` z `details: { story }`, sprawdzane po walidacji ćwiczeń.
  - `readLessonDraftDto`:
    - `...(context.story ? { story: context.story } : {})`;
    - `storyEnabled: draftSubject?.lessonStory === true`.
  - `readLessonDeck`: `storyGeneration`.

- [ ] **Step 4: Filtr kolizji przy dogenerowaniu (`lesson-drafts.ts`).**
  - Dotyczy runu z `input.regenerate`, gdy wersja ma `lesson_context.story`.
  - Historyjkę czytaj z wersji w transakcji finalizacji.
  - Po wyznaczeniu `uniqueValid` odrzuć ćwiczenia, dla których
    `storyCollisions(story.sentences, solvedSentencesOf([ex]), subject.normalizer)`
    jest niepuste.
  - Liczba odrzuconych dolicza się do `rejectedCount`.

- [ ] **Step 5: Procedura w `parent-router.ts`.**
  - `lessonDrafts.regenerateStory`: handler woła
    `regenerateLessonStory(services, { deckVersionId: input.lessonDraftId,
    expectedEditNumber, clientRequestId })`.
  - Usuń ewentualny handler tymczasowy z Task 2.
  - Test w `parent-router.test.ts` wzorem `regenerateCardAudio`: procedura woła
    funkcję serwera z przemapowanym `deckVersionId`.

- [ ] **Step 6: Uruchom testy.**
  - Integracja `lesson-story.test.ts`, `lesson-parent-api.test.ts`
    i `lesson-generation.test.ts` → PASS.
  - `corepack pnpm vitest run apps/web/src/orpc --config vitest.unit.config.ts` → PASS.
  - `corepack pnpm typecheck` → PASS.

- [ ] **Step 7: Commit** — `Historyjka lekcji: edycja, publikacja, DTO, kolizje przy dogenerowaniu, procedura rodzica`.

---

### Task 6: Sekcja historyjki w edytorze rodzica

**Files:**
- Create: `apps/web/src/parent/lessons/lesson-story-form.ts` (+ `lesson-story-form.test.ts`)
- Create: `apps/web/src/parent/lessons/LessonStorySection.tsx` (+ `lesson-story-section.test.tsx`, wzorem `prompt-audio-controls.test.tsx`)
- Modify: `apps/web/src/parent/lessons/LessonEditor.tsx`
- Modify: `apps/web/src/parent/lessons/lesson-editor-state.ts` (typ patcha: `story?: LessonStoryDto | null`)
- Modify: `tests/e2e/lesson-parent.spec.ts` (projekt `real`; dopisz przypadek) — jeśli plik nie istnieje w tej postaci, użyj speca edytora rodzica z partycji `real`, który tworzy lekcję gramatyki z fake providerem

**Interfaces:**
- Consumes: Task 2 (`LessonStoryDto`, komunikaty, procedura
  `regenerateStory`, `storyGeneration`), Task 5 (DTO).
- Produces (`lesson-story-form.ts`, czyste funkcje):
  - `emptyStory(): LessonStoryDto`: 4 puste zdania i 1 pytanie `q1` z opcjami
    `a/b/c` (puste), `correctOption: "a"`;
  - `addSentence(s)` i `removeSentence(s, i)`: limit 6 i minimum 1 w formularzu
    (walidację 4–6 robi serwer);
  - `addQuestion(s)`: kolejne `q2`, limit 2; `removeQuestion(s, id)`;
  - `setSentence`, `setQuestionText`, `setOptionText`, `setCorrectOption`;
  - `storyEquals(a?: LessonStoryDto | null, b?: LessonStoryDto | null): boolean`.
- Komponent `LessonStorySection` — props:
  ```ts
  {
    story: LessonStoryDto | null;
    editable: boolean;
    errors: readonly string[];
    generation: GenerationDto | null;
    busy: boolean;
    locked: boolean;
    onChange(story: LessonStoryDto | null): void;
    onGenerate(): void;
    onRetry(): void;
  }
  ```
  `locked` oznacza zmiany niezapisane albo konflikt.

- [ ] **Step 1: Testy `lesson-story-form.test.ts`.**
  - `addSentence stops at 6`;
  - `addQuestion creates q2 and stops at 2`;
  - `setCorrectOption sets id`;
  - `storyEquals compares deeply and treats null/undefined equal`.

- [ ] **Step 2: Testy `lesson-story-section.test.tsx`.** Render w `MantineProvider`.
  - `shows empty state and generate button when no story`;
  - `generate button disabled when locked or generation running`;
  - `regenerate asks for confirmation when story exists` (mock `window.confirm`
    albo modal Mantine, zgodnie z tym, jak robi to edytor);
  - `editing sentence calls onChange with updated story`;
  - `remove story calls onChange(null)`;
  - `shows server errors list`;
  - `shows generating and failed states with retry`;
  - `read-only with publishedHint when not editable`.

- [ ] **Step 3: Uruchom i potwierdź porażki.**
  `corepack pnpm vitest run apps/web/src/parent/lessons --config vitest.unit.config.ts` → FAIL.

- [ ] **Step 4: Zaimplementuj formularz i sekcję.**
  - Komponenty Mantine: `TextInput`, `Radio.Group`, `Button`, `Alert`.
  - `data-testid`: `lesson-story-section`, `lesson-story-sentence-{i}`,
    `lesson-story-question-{id}`, `lesson-story-option-{qid}-{oid}`,
    `lesson-story-generate`, `lesson-story-remove`, `lesson-story-errors`.

- [ ] **Step 5: Wpięcie w `LessonEditor.tsx`.**
  - Stan i dirty:
    - `storyForm: LessonStoryDto | null | undefined`; `undefined` = brak zmian;
    - zmiana oznacza dirty tak, jak `examplesForm`;
    - zapis: `if (storyForm !== undefined) patch.story = storyForm`;
    - po zapisie i odświeżeniu: `storyForm = undefined`.
  - Błędy: `details.story` z błędu edycji i publikacji trafia do stanu
    `storyErrors` i do sekcji (wzorem mapowania `details.exercises`).
  - Widoczność: sekcja tylko przy `draft?.storyEnabled`. Dla wersji
    opublikowanej przy `published.storyEnabled`, w trybie odczytu.
  - Generowanie: `onGenerate` woła `parentClient.lessonDrafts.regenerateStory`
    z `expectedEditNumber` szkicu i nowym `crypto.randomUUID()`, potem odświeża
    talię.
  - Ponowienie: `onRetry` woła `parentClient.generation.retry({ runId: deck.storyGeneration.id })`.
  - Odpytywanie: pętla odświeżania (logika `lesson-poll-interval`) działa także
    wtedy, gdy `storyGeneration` jest `queued` albo `running`.
  - Run historyjki nie ustawia `generating` całego edytora.

- [ ] **Step 6: E2E (`real`).** Dopisz do speca edytora lekcji test `parent edits
  generated story and publishes`:
  - rodzic tworzy lekcję gramatyki (fake), czeka na sekcję
    `lesson-story-section` ze zdaniem fake'a „Sam has a red bike.”
    (worker przetwarza run historyjki);
  - zmienia zdanie 1, zapisuje, publikuje;
  - API szkicu zwraca zmienione zdanie.

  Drugi test: `story validation error is shown` — usunięcie zdań do 3
  i zapis → widoczny `lesson-story-errors` z „Historyjka ma mieć od 4 do 6
  zdań.”

  Spec pozostaje w swoim koszu `REAL_BUCKETS`. Gdy powstaje nowy plik, dodaj go
  do najlżejszego kosza.

- [ ] **Step 7: Uruchom testy.**
  - `corepack pnpm vitest run apps/web/src/parent --config vitest.unit.config.ts` → PASS.
  - `corepack pnpm typecheck` → PASS.
  - `corepack pnpm exec playwright test <spec> --project=real` → PASS. Najpierw
    `pnpm build`, potem `UMIEM_E2E_SKIP_BUILD=1`.

- [ ] **Step 8: Commit** — `Historyjka lekcji: sekcja w edytorze rodzica (edycja, generowanie, usuwanie)`.

---

### Task 7: Skutki uboczne, dokumentacja i pełna weryfikacja etapu

**Files:**
- Modify (wg wyników): testy integracyjne lub E2E, które zakładają brak
  dodatkowych runów po generowaniu lekcji gramatyki (np. liczenie runów,
  „ostatni run”, opróżnianie kolejki).
- Modify: `.kiro/specs/grammar-module/requirements.md`. Nowe **Wymaganie 12 —
  Historyjka na koniec sesji**, kryteria części rodzica:
  - generowanie osobnym runem;
  - przycisk „Wygeneruj historyjkę”;
  - walidacja z barierą;
  - edycja i usuwanie;
  - publikacja nie wymaga historyjki ani nagrania;
  - brak danych dziecka w promptach.

  Kryteria sesji dziecka zostają oznaczone „etap 3”.
- Modify: `docs/architecture.md` §19:
  - `SubjectModule.lessonStory` i `storyRules`;
  - run historyjki (`input.purpose='story'`), bez podbijania numeru edycji;
  - `LessonDeckDto.storyGeneration`.
- Modify: `docs/superpowers/specs/2026-11-01-lesson-end-story-design.md`.
  Wpisz doprecyzowanie §6.2 z sekcji Global Constraints tego planu, jako
  „Uzupełnienie z planowania 2026-11-01”, oraz zamianę
  `GenerationDto.purpose` na `storyGeneration`.

- [ ] **Step 1: Pełne testy jednostkowe i typecheck.**
  `corepack pnpm typecheck` i `corepack pnpm test:unit` → PASS.
- [ ] **Step 2: Pełna integracja.**
  `corepack pnpm test:integration` (ok. 5 min) → PASS. Porażki wynikające
  z dodatkowego runu historyjki popraw w teście, a nie przez wyłączenie flagi.
  Każdą zmianę asercji uzasadnij w komunikacie commita.
- [ ] **Step 3: MCP i skill.** Uruchom
  `rg -n "story|LessonDraftDto|LessonDeckDto" apps/web/src/integrations integrations/umiem-mcp`.
  Oczekiwany brak użyć nowych pól; wynik trafia do opisu PR.
- [ ] **Step 4: Dokumentacja** — zmiany z listy Files.
- [ ] **Step 5: Pełne E2E** — `corepack pnpm test:e2e:shards` → wszystkie testy
  przechodzą. Liczby testów porównaj z AGENTS.md (zmiana o nowe testy).
- [ ] **Step 6: Commit** — `Historyjka lekcji etap 1: dokumentacja i dopasowanie testów`.
