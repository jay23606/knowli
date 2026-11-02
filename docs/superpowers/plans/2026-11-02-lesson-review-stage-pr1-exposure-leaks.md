# Etap przeglądu lekcji — PR 1: kontrola ujawnień i dogenerowanie pod etap — plan wdrożenia

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wygenerowana lekcja nie zawiera ćwiczeń samodzielnych z rozwiązaniem widocznym wcześniej (karta / inne ćwiczenie), braki etapów po odrzuceniach są automatycznie dogenerowywane, a pokrycie publikacji i edytor rodzica pokazują ujawnienia — bez modelu krytyka.

**Architecture:** Czyste funkcje domenowe (`domain/lessons/exposure-leaks.ts`, `domain/lessons/lesson-coverage.ts`) liczą ujawnienia i braki; przypadki użycia obszaru `materials` (`lesson-drafts.ts`, `lesson-api.ts`) stosują je przy generowaniu, odczycie szkicu i publikacji. Blok walidacji świeżej puli zostaje wydzielony do jednej funkcji, którą wywołują: główna partia i nowa runda dogenerowania pod etap. Bez migracji.

**Tech Stack:** TypeScript strict, Vitest, PostgreSQL (testy integracyjne), Next.js + Mantine (panel rodzica), Playwright (E2E `mocked`), Zod (`packages/contracts`).

**Spec:** `docs/superpowers/specs/2026-11-02-lesson-review-stage-design.md` (§3, §5.2, §5.3, §6.1 — tylko miękki limit wywołania, §8 — ostrzeżenie ujawnienia, §10, §12 pkt 1). Krytyk (§4, §5.1, §7) to PR 2–3 — poza tym planem.

## Global Constraints

- Interfejs po polsku (`pl-PL`), teksty wyłącznie w `packages/contracts/src/messages.ts`.
- Domena (`packages/server/src/domain/`) bez I/O, zegara, losowości, Drizzle, oRPC, SDK (pilnuje `module-boundaries.architecture.test.ts`).
- Silnik lekcji bez literałów identyfikatorów przedmiotów produkcyjnych (pilnuje `domain/lessons/architecture.test.ts`); różnice przedmiotów tylko przez `SubjectModule`.
- Bez migracji bazy; nowe dane tylko w istniejących JSONB (`lesson_context`) lub liczone przy odczycie.
- Kid DTO, MCP, `SKILL.md`, `learning-overview` bez zmian.
- Ćwiczeń zapisanych przez rodzica reguła twarda nigdy nie usuwa (spec §3.4); dogenerowanie nie usuwa istniejących ćwiczeń szkicu (spec §5.2).
- Powód odrzucenia dla rodzica: dokładnie `ujawnione rozwiązanie` (klucz w `rejectedReasons`).
- Nowe pliki testów dopisane do najlżejszego kosza `INTEGRATION_BUCKETS` (`tests/integration-buckets.ts`) i do partycji `tests/e2e/spec-projects.ts` (`mocked`, gdy całe API zaślepione).
- Przed PR: `pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration`, `pnpm test:e2e:shards`.

## Review Focus

1. Szkic sprzed zmiany z tłumaczeniem równym przykładowi karty — odczyt w edytorze pokazuje ostrzeżenie i brak etapu, publikacja daje 409 z dopiskiem komunikatu, ale zapis edycji rodzica przechodzi (test w Task 3 i Task 4).
2. Rodzina pytań szkolnych (kilka `lesson_open_answer` z tą samą odpowiedzią wzorcową) — nic nie jest usuwane przy generowaniu, pierwsze liczy się do pokrycia (test w Task 1 i Task 6).
3. Dogenerowanie ręczne, w którym nowe ćwiczenie prowadzone rozwiązuje zdanie istniejącego tłumaczenia — usuwane jest nowe ćwiczenie, istniejące tłumaczenie zostaje (test w Task 6).
4. Runda dogenerowania pod etap kończy się błędem lub przekroczeniem limitu jednego wywołania — przebieg kończy się `succeeded` z pulą bez dogenerowania, nie `failed` ani ponowieniem (test w Task 8).
5. Odpowiedź różniąca się tylko kropką lub skrótem („She goes to school.” vs „She goes to school”, „Where's…” vs „Where is…”) — przy generowaniu traktowana jak ujawnienie (test w Task 1).

---

### Task 1: Domena — `findExposureLeaks` i `resolveGenerationLeaks`

**Files:**
- Create: `packages/server/src/domain/lessons/exposure-leaks.ts`
- Test: `packages/server/src/domain/lessons/exposure-leaks.test.ts`

**Interfaces:**
- Consumes: `lessonExerciseTargetKey`, `lessonTextTargetKey`, `exerciseExposureText` (`domain/lessons/exposure-key.ts`); `stageOf`, `outsideStagePath` (`domain/lessons/stages.ts`); `answersEquivalent` (`domain/lessons/pool-validation.ts` — jeśli import tworzy cykl z Task 2, przenieś `answersEquivalent` do pliku-liścia `domain/lessons/answer-equivalence.ts` i reeksportuj z `pool-validation.ts`).
- Produces:
  ```ts
  export type LeakSubject = Pick<SubjectModule, "answerLocale" | "exposureText" | "normalizeExposureText" | "normalizer">;
  export type LeakSource =
    | { readonly kind: "card_example"; readonly objectiveId: string; readonly text: string }
    | { readonly kind: "exercise"; readonly index: number };
  export interface ExposureLeak { readonly index: number; readonly kind: "hard" | "soft"; readonly source: LeakSource }
  export interface ExposureLeakInput {
    readonly exercises: readonly LessonExerciseDraft[];               // kolejność = pozycja w szkicu
    readonly examples: Readonly<Record<string, readonly string[]>>;   // przykłady kart per zagadnienie
    readonly objectiveOrder: readonly string[];                       // kolejność zagadnień (lesson_context.objectiveIds)
    readonly subject: LeakSubject;
    readonly mode: "coverage" | "generation";
  }
  export function findExposureLeaks(input: ExposureLeakInput): ExposureLeak[];
  export interface GenerationLeakResolution {
    readonly keptFresh: LessonExerciseDraft[];
    readonly droppedFresh: LessonExerciseDraft[];
    readonly keptNewExamples: Record<string, string[]>;
  }
  export function resolveGenerationLeaks(input: {
    readonly existing: readonly LessonExerciseDraft[];          // ćwiczenia szkicu (nie usuwane)
    readonly fresh: readonly LessonExerciseDraft[];             // nowe z tego przebiegu
    readonly existingExamples: Readonly<Record<string, readonly string[]>>;
    readonly newExamples: Readonly<Record<string, readonly string[]>>; // zastępują przykłady swoich zagadnień
    readonly objectiveOrder: readonly string[];
    readonly subject: LeakSubject;
  }): GenerationLeakResolution;
  ```

Reguły (spec §3.1–3.2, §5.2):
- Ofiara: tylko ćwiczenie z `stageOf(type) === "independent"` i `!outsideStagePath(type)`.
- `coverage`: równość kluczy — `lessonExerciseTargetKey(ofiara)` vs `lessonTextTargetKey(przykład)` i vs `lessonExerciseTargetKey(inne ćwiczenie)`.
- `generation`: teksty ofiary `[exerciseExposureText(ofiara), ...ofiara.acceptedAnswers]`, teksty źródła `[exerciseExposureText(źródło)]` lub tekst przykładu; równoważność `answersEquivalent(subject.normalizeExposureText?.(a) ?? a, subject.normalizeExposureText?.(b) ?? b, subject.normalizer)`.
- `hard`: źródło to przykład karty (dowolnego zagadnienia) albo ćwiczenie niesamodzielne (w tym poza ścieżką etapów). `soft`: źródło to inne ćwiczenie samodzielne wcześniejsze w kolejności (`objectiveOrder`, potem indeks w `exercises`); pierwsze z grupy nie dostaje wpisu `soft`.
- Jedno ćwiczenie — najwyżej jeden wpis (pierwszy `hard`, inaczej pierwszy `soft`), deterministycznie.
- `resolveGenerationLeaks`: (1) końcowe przykłady = `existingExamples` z zagadnieniami `newExamples` zastąpionymi; (2) nowy przykład, który byłby `hard` źródłem dla ćwiczenia z `existing`, odpada (z `keptNewExamples`); (3) liczy `findExposureLeaks` w trybie `generation` na `[...existing, ...fresh]` z końcowymi przykładami; (4) `hard` z ofiarą w `fresh` → ofiara do `droppedFresh`; `hard` z ofiarą w `existing` i źródłem w `fresh` → źródło do `droppedFresh`; `hard` z ofiarą i źródłem w `existing` → nic; `soft` → nic.

- [ ] **Step 1: Write the failing tests** (fałszywe przedmioty z `domain/lessons/testing/` albo minimalne `LeakSubject` w teście; użyj prawdziwych `englishChapterSubject`, `englishGrammarSubject`, `schoolSubject` tam, gdzie test dotyczy semantyki kluczy)

```ts
describe("findExposureLeaks", () => {
  it("rozdział: luka „It's under the ___” rozwiązana do bed ujawnia tłumaczenie „It's under the bed.” (hard)", ...);
  it("rozdział: przykład karty „I'm hungry.” ujawnia tłumaczenie „I'm hungry.” (hard, source card_example)", ...);
  it("gramatyka: luka z odpowiedzią „plays” nie ujawnia tłumaczenia „He plays football.”", ...);
  it("szkoła: trzy open_answer z tą samą odpowiedzią — pierwszy bez wpisu, dwa kolejne soft", ...);
  it("„Posłuchaj i wybierz” z rozwiązanym zdaniem równym tłumaczeniu → hard", ...);
  it("generation: „She goes to school.” vs „She goes to school” → leak; coverage: brak leaku (różne klucze w gramatyce)", ...);
  it("generation: wariant acceptedAnswers „Where is the box?” vs przykład „Where's the box?” → hard", ...);
  it("kolejność soft liczona po objectiveOrder, nie po indeksie tablicy", ...);
  it("ćwiczenie niesamodzielne nigdy nie jest ofiarą", ...);
});
describe("resolveGenerationLeaks", () => {
  it("świeże tłumaczenie równe świeżej luce → tłumaczenie w droppedFresh, luka zostaje", ...);
  it("świeża luka rozwiązuje istniejące tłumaczenie → luka w droppedFresh, istniejące zostaje", ...);
  it("nowy przykład równy istniejącemu tłumaczeniu → przykład usunięty z keptNewExamples", ...);
  it("szkolna rodzina świeżych open_answer → nic nie usuwa", ...);
  it("ofiara i źródło istniejące → nic nie usuwa", ...);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `corepack pnpm vitest run packages/server/src/domain/lessons/exposure-leaks.test.ts`
Expected: FAIL (`Cannot find module './exposure-leaks'`)

- [ ] **Step 3: Implement both functions in `exposure-leaks.ts`** (reguły wyżej; brak I/O)

- [ ] **Step 4: Run tests and boundary tests**

Run: `corepack pnpm vitest run packages/server/src/domain/lessons/exposure-leaks.test.ts packages/server/src/domain/lessons/architecture.test.ts packages/server/src/modules/module-boundaries.architecture.test.ts`
Expected: PASS

- [ ] **Step 5: Commit** — `git commit -m "Lekcje: findExposureLeaks i resolveGenerationLeaks (ujawnione rozwiązania)"`

---

### Task 2: Domena — pokrycie z wykluczeniem ujawnień i braki etapów

**Files:**
- Create: `packages/server/src/domain/lessons/lesson-coverage.ts`
- Modify: `packages/server/src/modules/materials/lessons/lesson-api.ts:240-273` (usuń `distinctOpenAnswerGaps` i `mergeCoverage` — przeniesione do domeny)
- Test: `packages/server/src/domain/lessons/lesson-coverage.test.ts`

**Interfaces:**
- Consumes: `findExposureLeaks` (Task 1); `poolCoverage`, `CoverageGap`, `PoolMinimums` (`pool-validation.ts`).
- Produces:
  ```ts
  export interface LessonCoverageInput {
    readonly subject: SubjectModule;
    readonly exercises: readonly LessonExerciseDraft[];
    readonly examples: Readonly<Record<string, readonly string[]>>;
    readonly objectiveIds: readonly string[];
    readonly minimums: PoolMinimums;
  }
  /** Braki pokrycia publikacji: poolCoverage bez ujawnionych (coverage mode) ćwiczeń samodzielnych + reguła różnych odpowiedzi otwartych (subject.usesV3Payload), bez duplikatów cel+etap. */
  export function lessonCoverageGaps(input: LessonCoverageInput): CoverageGap[];
  /** Ile ćwiczeń każdego etapu brakuje zagadnieniu (0 gdy pokryte); spójne z lessonCoverageGaps. */
  export function stageDeficits(input: LessonCoverageInput, objectiveId: string): LlmLessonStageCounts;
  ```
  `LlmLessonStageCounts` z `ports/ai.ts` — jeśli import portu w domenie łamie test granic, zdefiniuj lokalny typ `{ guided: number; productive: number; independent: number }` strukturalnie zgodny.

- [ ] **Step 1: Write the failing tests**

```ts
it("tłumaczenie równe przykładowi karty nie liczy się do independent → brak etapu", ...);
it("rodzina szkolna: trzy open_answer z jedną odpowiedzią liczą się jako 1 → brak 2 różnych", ...);
it("bez ujawnień wynik równy poolCoverage + reguła szkoły (regresja wobec dawnego distinctOpenAnswerGaps)", ...);
it("stageDeficits: zagadnienie z 3/3/0 i minimami rozdziału 3/3/2 → { guided: 0, productive: 0, independent: 2 }", ...);
it("stageDeficits szkoły uwzględnia regułę różnych odpowiedzi otwartych", ...);
```

- [ ] **Step 2: Run** `corepack pnpm vitest run packages/server/src/domain/lessons/lesson-coverage.test.ts` — Expected: FAIL (brak modułu)
- [ ] **Step 3: Implement** `lessonCoverageGaps` i `stageDeficits`; w `lesson-api.ts` zastąp oba wywołania `mergeCoverage(poolCoverage(...), distinctOpenAnswerGaps(...))` (odczyt szkicu ~322, publikacja ~896) przez `lessonCoverageGaps({ subject, exercises: drafts, examples: context.examples, objectiveIds: context.objectiveIds, minimums: poolMinimumsOf(services, context.subjectId) })`.
- [ ] **Step 4: Run** `corepack pnpm vitest run packages/server/src/domain/lessons packages/server/src/modules/materials/lessons` — Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "Lekcje: pokrycie bez ujawnionych ćwiczeń samodzielnych (domena)"`

---

### Task 3: Fałszywy generator i fixture'y bez ujawnień

**Files:**
- Modify: `packages/server/src/providers/fake.ts:164-250` (`fakeChapterExercise`, `fakeChapterPool`), `:262-330` (`fakeLessonExercises`)
- Modify: `tests/fixtures/lesson-world.ts:171` (przykład karty „He plays football.”) i dodaj eksport fixture'u z ujawnieniem
- Test: `packages/server/src/providers/fake.test.ts` (utwórz, jeśli brak) 

**Interfaces:**
- Produces: `lessonWorldLeakedDraft` (fixture w `tests/fixtures/lesson-world.ts`): pula gotowa do edycji jak dotychczasowa, w której jedno `lesson_open_answer` ma odpowiedź równą przykładowi karty — do testów Task 4 i 6.

Zmiany: tłumaczenia rozdziału unikalne w obrębie przebiegu i dogenerowań (np. dwa różne słowa materiału zależne od numeru sekwencji: `We have the ${w1} and the ${w2}` — tylko słowa materiału, żeby przejść słownik rozdziału) i różne od przykładów kart (`I have the X.`) oraz od zdań luk; fałszywy generator respektuje `stageCounts` (już tak) i nowe `avoidSentences` (Task 7 — tu tylko pomija odpowiedzi równe zdaniom z `input.avoidSentences ?? []`, żeby Task 7/8 miały na czym testować).

- [ ] **Step 1: Write the failing test**

```ts
it("pula rozdziału (CHAPTER_MATERIAL, 3 zagadnienia, pula 40) nie ma ujawnień w trybie generation", () => {
  // buduje wejścia jak batchesForObjectives, sumuje partie z narastającym existingExercises,
  // findExposureLeaks(...).filter(l => l.kind === "hard") → []
});
it("fałszywy generator pomija odpowiedzi z avoidSentences", ...);
```
- [ ] **Step 2: Run** `corepack pnpm vitest run packages/server/src/providers/fake.test.ts` — Expected: FAIL (ujawnienia > 0)
- [ ] **Step 3: Implement** zmiany fake i fixture'a (przykład karty w `lesson-world.ts` na zdanie inne niż odpowiedź samodzielna).
- [ ] **Step 4: Run** testy jednostkowe fake oraz dotknięte integracyjne: `UMIEM_TEST_RUN_ID=t3 corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/lesson-chapter.test.ts tests/integration/lesson-parent-api.test.ts tests/integration/lesson-generation.test.ts` — Expected: PASS (oczekiwania `rejectedCount 0`, `coverage []`, publikacja 200 bez zmian)
- [ ] **Step 5: Commit** — `git commit -m "Testy: fałszywy generator i fixture lekcji bez ujawnionych rozwiązań"`

---

### Task 4: Ujawnienia w DTO szkicu, pokrycie przy publikacji i ostrzeżenie w edytorze

**Files:**
- Modify: `packages/contracts/src/lessons.ts:~500` (`LessonDraftDtoSchema`), `packages/contracts/src/messages.ts` (`lessons.*`)
- Modify: `packages/server/src/modules/materials/lessons/lesson-api.ts` (`readLessonDraftDto`)
- Modify: `apps/web/src/parent/lessons/LessonExerciseCard.tsx`, `apps/web/src/parent/lessons/LessonEditor.tsx:~1079` (lista braków pokrycia)
- Test: `tests/integration/lesson-parent-api.test.ts`, `apps/web/src/parent/lessons/lesson-exercise-card.test.tsx`, nowy `tests/e2e/lesson-exposure-leaks.spec.ts` (`mocked`)

**Interfaces:**
- Consumes: `findExposureLeaks` (Task 1, `mode: "coverage"`), `lessonCoverageGaps` (Task 2), `lessonWorldLeakedDraft` (Task 3).
- Produces (DTO, pole opcjonalne — brak = brak ujawnień):
  ```ts
  exposureLeaks: z.array(z.object({
    exerciseId: UuidSchema,                       // itemId ćwiczenia-ofiary
    kind: z.enum(["hard", "soft"]),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("card_example"), objectiveId: z.string() }),
      z.object({ kind: z.literal("exercise"), exerciseId: UuidSchema }),
    ]),
  }).strict()).optional(),
  ```
  (Odstępstwo od `sourceLabelPl` ze spec §8: etykietę składa UI z katalogu komunikatów — serwer nie produkuje tekstu UI.)
- Komunikaty (`messages.lessons`), dokładne teksty:
  - `exposureLeakCard: "Rozwiązanie widać wcześniej (karta zagadnienia „{objective}”) — nie liczy się jako samodzielne."`
  - `exposureLeakExercise: "Rozwiązanie widać wcześniej (ćwiczenie {n}) — nie liczy się jako samodzielne."`
  - `exposureLeakSoft: "To samo rozwiązanie ma ćwiczenie {n} — jako samodzielne liczy się tylko jedno z nich."`
  - `coverageLeakNote: "Tłumaczenia i odpowiedzi, których rozwiązanie widać wcześniej (na karcie lub w innym ćwiczeniu), nie liczą się jako samodzielne."`

- [ ] **Step 1: Write the failing tests**
  - integracja: „szkic z ujawnionym tłumaczeniem: GET lessons/:deckId zwraca exposureLeaks z source card_example i coverage z brakiem independent; publish → 409 `lesson coverage incomplete`; PATCH tego ćwiczenia ze zmienionym zdaniem → 200, potem exposureLeaks puste i publish 200” (fixture `lessonWorldLeakedDraft` wstawiony jak w istniejących testach SQL-em lub przez PATCH);
  - komponent: karta ćwiczenia z wpisem `hard`/`card_example` renderuje `exposureLeakCard` z tytułem zagadnienia; z `soft` — `exposureLeakSoft` z numerem ćwiczenia;
  - E2E `mocked` (390×844 i 1280×800): ostrzeżenie widoczne przy ćwiczeniu, `coverageLeakNote` pod listą braków, brak przepełnienia poziomego (`document.documentElement.scrollWidth <= innerWidth`).
- [ ] **Step 2: Run** testy z kroku 1 — Expected: FAIL
- [ ] **Step 3: Implement**: `readLessonDraftDto` liczy `findExposureLeaks({ exercises: drafts, examples: context.examples, objectiveOrder: context.objectiveIds, subject, mode: "coverage" })` i mapuje indeksy na `revisions[i].itemId`; karta ćwiczenia dostaje prop `exposureLeak` (wpis albo `null`) i renderuje `Alert` Mantine (kolor `yellow`, tekst dostępny dla czytnika); `LessonEditor` pokazuje `coverageLeakNote`, gdy jakikolwiek brak etapu `independent` i `exposureLeaks?.length > 0`. Dopisz E2E do `tests/e2e/spec-projects.ts` (`mocked`).
- [ ] **Step 4: Run** testy z kroku 1 + `corepack pnpm vitest run apps/web/src/parent/lessons` — Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "Panel lekcji: ostrzeżenie o ujawnionym rozwiązaniu i pokrycie przy publikacji"`

---

### Task 5: Wydzielenie walidacji świeżej puli (`acceptFreshLessonPool`) — bez zmiany zachowania

**Files:**
- Create: `packages/server/src/modules/materials/lessons/lesson-pool-acceptance.ts`
- Modify: `packages/server/src/modules/materials/lessons/lesson-drafts.ts:1546-1640` (blok od `wellShaped` do `capListenChoiceOverflow` + log `summarizeLessonPoolValidation`)
- Test: `packages/server/src/modules/materials/lessons/lesson-pool-acceptance.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface FreshPoolInput {
    readonly rawExercises: readonly unknown[];
    readonly subject: SubjectModule;
    readonly topic: LessonTopic;
    readonly material: string;
    readonly regenerate: boolean;
    readonly runId: string;
    readonly existingDrafts: readonly LessonExerciseDraft[];          // szkic (dogenerowanie) lub []
    readonly existingAnswers: ReadonlySet<string>;
    readonly existingExerciseIdentities: ReadonlySet<string>;
    readonly objectiveLimits: ReadonlyMap<string, ObjectiveGenerationLimits>;
  }
  export interface FreshPoolResult {
    readonly accepted: LessonExerciseDraft[];
    readonly rejectedCount: number;                          // shape + refine + walidacja + duplikaty + cap (bez outOfScope — liczy wywołujący)
    readonly refinedReasons: Readonly<Record<string, number>>;
    readonly droppedAcceptedVariants: number;
    readonly droppedExplanations: number;
    readonly summary: LessonPoolValidationSummaryInput;      // to, co dziś trafia do summarizeLessonPoolValidation
  }
  export function acceptFreshLessonPool(input: FreshPoolInput): FreshPoolResult;
  ```
  Kolejność kroków i ich semantyka identyczne z obecnym kodem (kształt → sanityzacje → `scopeFamiliesToRun` przy `regenerate` → `refineGeneratedDrafts` → `splitByPoolExtra` → `validatePool` z `existingExercises` → deduplikacja wobec istniejących → `capListenChoiceOverflow`).

- [ ] **Step 1: Write the failing test** — tabela przypadków porównująca wynik `acceptFreshLessonPool` z utrwalonymi oczekiwaniami (`accepted.length`, `rejectedCount`, `refinedReasons`) dla: puli rozdziału z odrzuceniem słownikowym, puli z wadliwym kształtem, puli z duplikatem wobec szkicu, puli z nadmiarem słuchowym.
- [ ] **Step 2: Run** — Expected: FAIL (brak modułu)
- [ ] **Step 3: Implement** — przenieś blok; `executeLessonGeneration` wywołuje funkcję i zachowuje dotychczasowe logi i liczniki.
- [ ] **Step 4: Run** `corepack pnpm vitest run packages/server/src/modules/materials/lessons` oraz `UMIEM_TEST_RUN_ID=t5 corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/lesson-generation.test.ts tests/integration/lesson-chapter.test.ts tests/integration/lesson-listen-choice.test.ts` — Expected: PASS bez zmian oczekiwań
- [ ] **Step 5: Commit** — `git commit -m "Lekcje: wydzielona walidacja świeżej puli (bez zmiany zachowania)"`

---

### Task 6: Reguła twarda przy generowaniu

**Files:**
- Modify: `packages/server/src/modules/materials/lessons/lesson-drafts.ts` (po `acceptFreshLessonPool`, przed transakcją zapisu; zapis `examples`)
- Test: `tests/integration/lesson-generation.test.ts` (nowe przypadki), `packages/server/src/modules/materials/lessons/lesson-drafts.test.ts`

**Interfaces:**
- Consumes: `resolveGenerationLeaks` (Task 1), `acceptFreshLessonPool` (Task 5).
- Produces: w `lesson_context` — `examples` = końcowe przykłady z `keptNewExamples`; `rejectedCount` += `droppedFresh.length`; `rejectedReasons["ujawnione rozwiązanie"]` += `droppedFresh.length` (sumowanie jak `sumRejectedReasons`). Log: `[lesson] run=<id> ujawnienia: usunięte=<n> przykłady=<m>`.

Zastosowanie: `existing` = `existingDrafts` (dogenerowanie) lub `[]`; `fresh` = `accepted`; `existingExamples` = przykłady szkicu z `lesson_context` (odczyt jak dziś przy dogenerowaniu; przy pełnej generacji `{}`); `newExamples` = przykłady z odpowiedzi generatora; `objectiveOrder` = cele przebiegu (pełna generacja) lub `lesson_context.objectiveIds` (dogenerowanie). Gdy po regule zostaje 0 ćwiczeń — ta sama ścieżka co dziś przy `uniqueValid.length === 0`.

- [ ] **Step 1: Write the failing tests** (fałszywy LLM z `queueLesson`/zachowaniem jak w istniejących testach generacji)
  - pełna generacja: pula z tłumaczeniem równym przykładowi karty → ćwiczenie nie trafia do szkicu, `rejectedReasons["ujawnione rozwiązanie"] === 1`;
  - dogenerowanie: nowa luka rozwiązująca istniejące tłumaczenie → luka nie trafia do szkicu, tłumaczenie zostaje;
  - dogenerowanie: nowy przykład karty równy istniejącemu tłumaczeniu → przykład nie trafia do `examples`, tłumaczenie zostaje;
  - szkoła: rodzina trzech `lesson_open_answer` → wszystkie w szkicu.
- [ ] **Step 2: Run** `UMIEM_TEST_RUN_ID=t6 corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/lesson-generation.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement** w `executeLessonGeneration`
- [ ] **Step 4: Run** jak w kroku 2 + `tests/integration/lesson-chapter.test.ts tests/integration/lesson-parent-api.test.ts` — Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "Generowanie lekcji: reguła twarda ujawnionych rozwiązań"`

---

### Task 7: `avoidSentences` w wejściu generatora

**Files:**
- Modify: `packages/server/src/ports/ai.ts` (`LessonPoolInput`), `packages/server/src/providers/openai/llm.ts` (~326-345, sekcja „existing”), `packages/server/src/modules/materials/lessons/lesson-drafts.ts` (`buildPoolInput` i wywołania), `packages/server/src/providers/fake.ts` (już honoruje — Task 3)
- Test: `packages/server/src/providers/openai/llm.test.ts`, `packages/server/src/modules/materials/lessons/lesson-drafts.test.ts`

**Interfaces:**
- Produces: `LessonPoolInput.avoidSentences?: readonly string[]` — rozwiązane zdania (`exerciseExposureText`) ćwiczeń wcześniejszych partii przebiegu i szkicu oraz przykłady kart szkicu i wcześniejszych partii; limit 60 pozycji (najnowsze). Adapter dopisuje do wiadomości użytkownika: `"Do not use any of these sentences as an exercise solution or card example:"` + lista `- …` (pomija sekcję, gdy pusta).

- [ ] **Step 1: Write the failing tests** — adapter: wiadomość zawiera nagłówek i zdania przy niepustym `avoidSentences`, brak sekcji przy pustym; przypadek użycia: druga partia pełnej generacji dostaje rozwiązania i przykłady pierwszej.
- [ ] **Step 2: Run** `corepack pnpm vitest run packages/server/src/providers/openai/llm.test.ts packages/server/src/modules/materials/lessons/lesson-drafts.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** jak w kroku 2 — Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "Generator lekcji: zdania do unikania (avoidSentences)"`

---

### Task 8: Dogenerowanie pod brakujący etap i miękki limit wywołania

**Files:**
- Modify: `packages/server/src/modules/materials/lessons/lesson-generation-control.ts` (nowa metoda kontroli)
- Modify: `packages/server/src/modules/materials/lessons/lesson-drafts.ts` (runda po Task 6, przed transakcją)
- Test: `packages/server/src/modules/materials/lessons/lesson-generation-control.test.ts`, `tests/integration/lesson-generation.test.ts`

**Interfaces:**
- Consumes: `stageDeficits` (Task 2), `acceptFreshLessonPool` (Task 5), `resolveGenerationLeaks` (Task 1), `avoidSentences` (Task 7).
- Produces:
  ```ts
  // LessonGenerationControl
  /** Jak call, ale przekroczenie limitu żądania przerywa tylko to żądanie (rzuca GenerationProviderError("timeout")) — nie korzeń przebiegu. Deadline przebiegu i assertCurrent działają jak w call. */
  callSoft<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T>;
  ```
  Runda: dla każdego zagadnienia przebiegu `stageDeficits(...)` na `[...existingDrafts, ...kept]` z końcowymi przykładami; gdy suma > 0 i do deadline zostało ≥ `requestTimeoutMs` + 30 s rezerwy: `buildPoolInput` z `countPerObjective` = suma braków, `stageCounts` = braki, `existingAnswers`/`existingExercises` = ćwiczenia zagadnienia, `avoidSentences` jak w Task 7, `listenChoicePerObjective` = 0; `control.callSoft(generateLessonPool)`; przykłady z odpowiedzi rundy są ignorowane; wynik przez `acceptFreshLessonPool` z własnym wpisem `objectiveLimits` `{ count: suma, listen: 0, stages: braki }` i `existingDrafts` = szkic + `kept`; potem `resolveGenerationLeaks` (existing = szkic + `kept`, fresh = nowe); dołącz `keptFresh`. Liczniki odrzuceń sumowane jak w głównej partii. Błąd/timeout/`AbortError` rundy (poza anulowaniem z `assertCurrent` i zamknięciem procesu) → log `[lesson] run=<id> dogenerowanie pod etap: błąd=<kod>` i kontynuacja bez rundy. Log sukcesu: `[lesson] run=<id> dogenerowanie pod etap: zagadnienie=<slug> guided=<n> productive=<n> independent=<n> przyjęte=<n>`.

- [ ] **Step 1: Write the failing tests**
  - kontrola: `callSoft` z żądaniem dłuższym niż limit → odrzuca `timeout`, a kolejne `call` w tym samym przebiegu działa (wstrzyknięty `now`);
  - integracja: pierwsza partia rozdziału z tłumaczeniami ujawnionymi przez przykłady (zachowanie fałszywego LLM) → reguła twarda usuwa je, runda dogenerowuje `independent` → `coverage` pusta, `generateLessonPool` wywołany 2 razy dla zagadnienia, druga partia ma `stageCounts.independent > 0` i `avoidSentences` z przykładami;
  - integracja: runda dogenerowania rzuca błąd providera → run `succeeded`, szkic zapisany, `coverage` z brakiem `independent`, brak ponowienia (`attempts` = 1);
  - integracja: zagadnienie bez braków → brak drugiego wywołania.
- [ ] **Step 2: Run** `corepack pnpm vitest run packages/server/src/modules/materials/lessons/lesson-generation-control.test.ts` i `UMIEM_TEST_RUN_ID=t8 corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/lesson-generation.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement** `callSoft` i rundę
- [ ] **Step 4: Run** jak w kroku 2 + pełne `pnpm test:unit` — Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "Generowanie lekcji: dogenerowanie pod brakujący etap"`

---

### Task 9: Dokumentacja, raport istniejących szkiców i pełna weryfikacja

**Files:**
- Create: `scripts/report-exposure-leaks.mts` (tylko odczyt; uruchamiany przez `node apps/worker/node_modules/tsx/dist/cli.mjs`, jak `eval:*`)
- Modify: `package.json` (`"report:exposure-leaks"`), `docs/architecture.md` §19 (nowy podrozdział „Ujawnione rozwiązania i dogenerowanie pod etap (2026-11-02)”), `docs/SPEC.md` §29a (pokrycie: ujawnione samodzielne nie liczą się; dogenerowanie pod etap) i §37 (rozdział), `tests/integration-buckets.ts`, `tests/e2e/spec-projects.ts`

**Interfaces:**
- Consumes: `findExposureLeaks`, `lessonCoverageGaps` (eksport przez `@learning/server` — dopisz do barrela `materials`/root, jeśli skrypt ich potrzebuje; preferuj jeden eksport `reportLessonExposureLeaks(db, services)` z obszaru `materials`).
- Produces: wydruk `wersja | zestaw | stan | ujawnione (hard/soft) | brak pokrycia po zmianie (tak/nie)` dla wersji w stanie `draft`/`review`; bez treści ćwiczeń i bez danych dziecka.

- [ ] **Step 1: Write the failing test** — integracja: `reportLessonExposureLeaks` na bazie z jednym szkicem z ujawnieniem i jednym czystym zwraca 1 wiersz z `blocksPublish: true`.
- [ ] **Step 2: Run** — Expected: FAIL
- [ ] **Step 3: Implement** raport, skrypt, dokumentację (architektura: reguła, dwie relacje, gdzie działa, dogenerowanie pod etap, `callSoft`, wpływ na istniejące szkice; API → MCP → skill bez zmian)
- [ ] **Step 4: Run pełną weryfikację**
  - `corepack pnpm typecheck` — Expected: brak błędów
  - `corepack pnpm test:unit` — Expected: PASS
  - `corepack pnpm test:integration` — Expected: PASS
  - `corepack pnpm test:e2e:shards` — Expected: PASS (mocked + real)
- [ ] **Step 5: Commit** — `git commit -m "Docs i raport: ujawnione rozwiązania i dogenerowanie pod etap"`

Przed otwarciem PR: przegląd całej gałęzi trzema niezależnymi krytykami (zasada właściciela); w opisie PR — wynik `report:exposure-leaks` uruchomionego przez właściciela na produkcji (lub prośba o uruchomienie), wpływ API → MCP → skill (bez zmian), wykonane sprawdzenia.
