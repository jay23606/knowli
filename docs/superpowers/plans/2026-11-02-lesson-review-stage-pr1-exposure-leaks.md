# Etap przeglądu lekcji — PR 1: kontrola ujawnień i dogenerowanie pod etap — plan wdrożenia

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wygenerowana lekcja nie zawiera ćwiczeń samodzielnych z rozwiązaniem widocznym wcześniej (karta / inne ćwiczenie), braki etapów po odrzuceniach są automatycznie dogenerowywane, a pokrycie publikacji i edytor rodzica pokazują ujawnienia — bez modelu krytyka.

**Architecture:** Czyste funkcje domenowe (`domain/lessons/exposure-leaks.ts`, `domain/lessons/lesson-coverage.ts`) liczą ujawnienia i braki; przypadki użycia obszaru `materials` (`lesson-drafts.ts`, `lesson-api.ts`) stosują je przy generowaniu, odczycie szkicu i publikacji. Walidacja świeżej puli zostaje wydzielona do jednej funkcji, którą wywołują główna partia i runda dogenerowania pod etap (osobny zakres kontroli przebiegu). Bez migracji.

**Tech Stack:** TypeScript strict, Vitest, PostgreSQL (testy integracyjne), Next.js + Mantine (panel rodzica), Playwright (E2E), Zod (`packages/contracts`).

**Spec:** `docs/superpowers/specs/2026-11-02-lesson-review-stage-design.md` — PR 1: §3, §5.2, §5.3, §6.1 (tylko miękki limit wywołania), §8 (ostrzeżenie ujawnienia), §10, §12 pkt 1. Krytyk (§4, §5.1, §7) to PR 2–3.

Wersja po review trzech krytyków planu (zgodność z kodem; testy i regresje; wierność specyfikacji i UX) — zmiany względem pierwszej wersji w sekcji „Rozstrzygnięcia” na końcu.

## Global Constraints

- Interfejs po polsku (`pl-PL`), teksty wyłącznie w `packages/contracts/src/messages.ts`.
- Domena (`packages/server/src/domain/`) bez I/O, zegara, losowości, Drizzle, oRPC, SDK i bez importów z `modules/` (pilnuje `module-boundaries.architecture.test.ts`); silnik lekcji bez literałów identyfikatorów przedmiotów produkcyjnych (`domain/lessons/architecture.test.ts`).
- Bez migracji bazy; nowe dane tylko liczone przy odczycie albo w istniejącym JSONB `lesson_context`.
- Kid DTO, MCP, `SKILL.md`, `learning-overview` bez zmian.
- Ćwiczeń zapisanych w szkicu reguła twarda nigdy nie usuwa; dogenerowanie (ręczne i pod etap) nie usuwa istniejących ćwiczeń szkicu.
- Klucz powodu odrzucenia (widoczny dla rodzica, `rejectedReasons`): dokładnie `rozwiązanie widoczne wcześniej`.
- Komunikat 409 `errors.lesson_coverage_incomplete` bez zmian (przycisk publikacji i tak jest wyłączony przy brakach; wyjaśnienie daje edytor) — świadome odstępstwo od spec §3.4.
- Polecenia testów jednostkowych zawsze z `--config vitest.unit.config.ts`; integracyjnych z `--config vitest.integration.config.ts` i `UMIEM_TEST_RUN_ID=<unikalny>` (Bash; w PowerShell: `$env:UMIEM_TEST_RUN_ID='<id>';`).
- Nowe pliki testów: integracyjne do najlżejszego kosza `INTEGRATION_BUCKETS` (`tests/integration-buckets.ts`), E2E do partycji `tests/e2e/spec-projects.ts`.
- Przed PR: `corepack pnpm typecheck`, `corepack pnpm test:unit`, `corepack pnpm test:integration`, `corepack pnpm test:e2e:shards`; potem przegląd gałęzi trzema niezależnymi krytykami.

## Review Focus

1. Szkic sprzed zmiany z tłumaczeniem równym przykładowi karty: zapis edycji innego pola przechodzi (ujawnienie zostaje), publikacja daje 409, edytor pokazuje ostrzeżenie i liczbę wykluczonych przy braku etapu (Task 4).
2. Rodzina pytań szkolnych (kilka `lesson_open_answer` z jedną odpowiedzią wzorcową): przy generowaniu nic nie jest usuwane, do pokrycia liczy się jedno (Task 1, Task 6).
3. Dogenerowanie ręczne, w którym nowe ćwiczenie (luka — etap produktywny) rozwiązuje zdanie istniejącego tłumaczenia: usuwane jest nowe ćwiczenie, tłumaczenie zostaje (Task 6).
4. Runda dogenerowania pod etap: błąd providera, przekroczony limit jednego wywołania, za mało czasu do deadline'u albo edycja rodzica w trakcie — przebieg kończy się `succeeded` z pulą bez rundy (pierwsze trzy) albo `superseded` bez zapisu (ostatni), nigdy `failed` ani ponowieniem (Task 8).
5. Odpowiedź różniąca się tylko kropką lub skrótem („She goes to school.” / „She goes to school”, „Where's…” / „Where is…”): przy generowaniu traktowana jak ujawnienie (Task 1 jednostkowo, Task 6 integracyjnie na rozdziale).

---

### Task 1: Domena — `findExposureLeaks` i `resolveGenerationLeaks`

**Files:**
- Create: `packages/server/src/domain/lessons/exposure-leaks.ts`
- Test: `packages/server/src/domain/lessons/exposure-leaks.test.ts`

**Interfaces:**
- Consumes: `lessonExerciseTargetKey`, `lessonTextTargetKey`, `exerciseExposureText` (`exposure-key.ts`); `stageOf`, `outsideStagePath` (`stages.ts`); `answersEquivalent` (`pool-validation.ts` — bez cyklu, import bezpośredni).
- Produces:
  ```ts
  export type LeakSubject = Pick<SubjectModule, "answerLocale" | "exposureText" | "normalizeExposureText" | "normalizer">;
  export type LeakSource =
    | { readonly kind: "card_example"; readonly objectiveId: string; readonly text: string }
    | { readonly kind: "exercise"; readonly index: number };
  export interface ExposureLeak { readonly index: number; readonly kind: "hard" | "soft"; readonly source: LeakSource }
  export interface ExposureLeakInput {
    readonly exercises: readonly LessonExerciseDraft[];               // kolejność = pozycja
    readonly examples: Readonly<Record<string, readonly string[]>>;
    readonly objectiveOrder: readonly string[];
    readonly subject: LeakSubject;
    readonly mode: "coverage" | "generation";
  }
  /** Jeden wpis na ofiarę (pierwsze źródło twarde, inaczej miękkie) — do DTO i pokrycia. */
  export function findExposureLeaks(input: ExposureLeakInput): ExposureLeak[];
  export interface GenerationLeakResolution {
    readonly keptFresh: LessonExerciseDraft[];
    readonly droppedFresh: LessonExerciseDraft[];
    /** Nowe przykłady po odrzuceniu ujawniających; zagadnienie bez żadnego pozostałego przykładu jest POMINIĘTE (zostają stare przykłady szkicu). */
    readonly keptNewExamples: Record<string, string[]>;
    readonly droppedExampleCount: number;
  }
  export function resolveGenerationLeaks(input: {
    readonly existing: readonly LessonExerciseDraft[];
    readonly fresh: readonly LessonExerciseDraft[];
    readonly existingExamples: Readonly<Record<string, readonly string[]>>;
    readonly newExamples: Readonly<Record<string, readonly string[]>>;
    readonly objectiveOrder: readonly string[];
    readonly subject: LeakSubject;
  }): GenerationLeakResolution;
  ```

Reguły (spec §3.1–3.2, §5.2):
- Ofiara: `stageOf(type) === "independent"` i `!outsideStagePath(type)`.
- `coverage`: równość kluczy (`lessonExerciseTargetKey` ofiary vs `lessonTextTargetKey(przykład)` / `lessonExerciseTargetKey(inne)`).
- `generation`: teksty ofiary `[exerciseExposureText(ofiara), ...ofiara.acceptedAnswers]`, teksty źródła `[exerciseExposureText(źródło)]` albo tekst przykładu; równoważność `answersEquivalent(norm(a), norm(b), subject.normalizer)`, gdzie `norm = subject.normalizeExposureText ?? identity`.
- `hard`: źródło to przykład dowolnej karty albo ćwiczenie niesamodzielne (także poza ścieżką etapów). `soft`: inne ćwiczenie samodzielne wcześniejsze w porządku (`objectiveOrder`, potem indeks); pierwsze w grupie bez wpisu.
- Prywatna `hardSourcesOf(victimIndex, ...)` zwraca **wszystkie** źródła twarde ofiary; `resolveGenerationLeaks` jej używa: (1) końcowe przykłady = `existingExamples` z zagadnieniami z `newExamples` zastąpionymi; (2) nowy przykład będący źródłem twardym dla ćwiczenia z `existing` odpada; zagadnienie, któremu nie został żaden nowy przykład, nie trafia do `keptNewExamples`; (3) dla każdej ofiary z twardymi źródłami: ofiara w `fresh` → do `droppedFresh`; ofiara w `existing` → wszystkie źródła z `fresh` do `droppedFresh`; ofiara i źródła w `existing` → nic; (4) `soft` → nic.

- [ ] **Step 1: Write the failing tests** (prawdziwe `englishChapterSubject`, `englishGrammarSubject`, `schoolSubject` tam, gdzie liczy się semantyka kluczy)

```ts
describe("findExposureLeaks", () => {
  it("rozdział (coverage i generation): luka „It's under the ___” → bed ujawnia tłumaczenie „It's under the bed.” — hard, source exercise", ...);
  it("rozdział: przykład karty zagadnienia A „I'm hungry.” ujawnia tłumaczenie w zagadnieniu B — hard, source card_example z objectiveId A", ...);
  it("gramatyka (coverage i generation): luka z odpowiedzią „plays” nie ujawnia tłumaczenia „He plays football.” — []", ...);
  it("szkoła: trzy open_answer z jedną odpowiedzią — pierwszy bez wpisu, dwa kolejne soft", ...);
  it("„Posłuchaj i wybierz” z rozwiązanym zdaniem równym tłumaczeniu → hard", ...);
  it("gramatyka: „She goes to school.” vs „She goes to school” — generation: hard; coverage: []", ...);
  it("rozdział generation: wariant „Where is the box?” vs przykład karty „Where's the box?” → hard", ...);
  it("soft po objectiveOrder: grupa w zagadnieniach B (indeks 0) i A (indeks 5), order [A,B] → soft dostaje ćwiczenie z B", ...);
  it("ćwiczenie niesamodzielne nigdy nie jest ofiarą", ...);
});
describe("resolveGenerationLeaks", () => {
  it("świeże tłumaczenie = świeża luka → tłumaczenie w droppedFresh, luka zostaje", ...);
  it("świeża luka i świeży wybór rozwiązują istniejące tłumaczenie → oba świeże w droppedFresh, istniejące zostaje", ...);
  it("nowy przykład równy istniejącemu tłumaczeniu → przykład odpada, droppedExampleCount 1; gdy to jedyny nowy przykład zagadnienia — klucza brak w keptNewExamples", ...);
  it("szkolna rodzina świeżych open_answer → nic nie usuwa", ...);
  it("ofiara i źródło istniejące → nic nie usuwa", ...);
});
```

- [ ] **Step 2: Run** `corepack pnpm vitest run --config vitest.unit.config.ts packages/server/src/domain/lessons/exposure-leaks.test.ts` — Expected: FAIL (brak modułu)
- [ ] **Step 3: Implement** w `exposure-leaks.ts`
- [ ] **Step 4: Run** testy z kroku 2 oraz `packages/server/src/domain/lessons/architecture.test.ts packages/server/src/modules/module-boundaries.architecture.test.ts` — Expected: PASS
- [ ] **Step 5: Commit** — `Lekcje: findExposureLeaks i resolveGenerationLeaks (ujawnione rozwiązania)`

---

### Task 2: Fałszywy generator i fixture'y bez ujawnień (+ pole `avoidSentences` w porcie)

**Files:**
- Modify: `packages/server/src/ports/ai.ts` (`LessonPoolInput`: `avoidSentences?: readonly string[]`, `purpose?: "pool" | "stage_top_up"` — samo pole; użycie w Task 7–8)
- Modify: `packages/server/src/providers/fake.ts:164-250` (`fakeChapterExercise`, `fakeChapterPool`), `:262-330` (`fakeLessonExercises`), `:538-615` (`queueLesson`, `generateLessonPool`)
- Modify: `tests/fixtures/lesson-world.ts:171` (przykład „He plays football.” → zdanie inne niż odpowiedzi samodzielne puli `seedEditorPool` ~603); dodaj eksport `seedEditorPoolWithLeak`
- Test: `packages/server/src/providers/fake.test.ts` (utwórz, jeśli brak)

**Interfaces:**
- Consumes: `findExposureLeaks` (Task 1), `objectiveBatchCounts` (`lesson-drafts.ts`, eksportowana).
- Produces:
  - fake: tłumaczenia rozdziału unikalne w obrębie szkicu (numeracja od `existingExercises.length` obejmującego cały szkic i przebieg — Task 7/8 to zapewnią; zdanie z dwóch słów materiału zależnych od numeru, np. `We have the ${w1} and the ${w2}`, tylko słowa materiału) i różne od przykładów kart (`I have the X.`) i zdań luk; zdanie z `input.avoidSentences` (porównanie po `toLowerCase().trim()` bez końcowej kropki) jest **zastępowane** kolejnym kandydatem, nie pomijane;
  - fake: `queueLesson` dotyczy tylko wywołań z `purpose !== "stage_top_up"`; nowe `queueLessonTopUp(...behaviors)` dla rundy; bez kolejki rundy — domyślna deterministyczna pula;
  - `seedEditorPoolWithLeak(...)`: jak `seedEditorPool`, ale jedno `lesson_open_answer` ma odpowiedź równą przykładowi karty jego zagadnienia.

- [ ] **Step 1: Write the failing tests**

```ts
it("rozdział (CHAPTER_MATERIAL, 3 zagadnienia, pula 40): suma partii z narastającym existingExercises nie ma ujawnień (coverage: hard i soft) — findExposureLeaks(...) toEqual []", ...);
it("gramatyka i szkoła: domyślna pula nie ma ujawnień twardych z przykładami kart", ...);
it("avoidSentences: zdanie z listy zastąpione innym, liczba ćwiczeń bez zmian", ...);
it("queueLesson nie dotyczy purpose=stage_top_up; queueLessonTopUp dotyczy tylko rundy", ...);
```
- [ ] **Step 2: Run** `corepack pnpm vitest run --config vitest.unit.config.ts packages/server/src/providers/fake.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement** zmiany fake'a, portu i fixture'a
- [ ] **Step 4: Run** `corepack pnpm typecheck` oraz `UMIEM_TEST_RUN_ID=t2 corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/lesson-chapter.test.ts tests/integration/lesson-parent-api.test.ts tests/integration/lesson-generation.test.ts tests/integration/lesson-shape.test.ts` — Expected: PASS bez zmian oczekiwań
- [ ] **Step 5: Commit** — `Testy: fałszywy generator i fixture lekcji bez ujawnionych rozwiązań`

---

### Task 3: Domena — pokrycie z wykluczeniem ujawnień i braki etapów

**Files:**
- Create: `packages/server/src/domain/lessons/lesson-coverage.ts`
- Modify: `packages/server/src/modules/materials/lessons/lesson-api.ts:240-273, ~322, ~896` (usuń `poolMinimumsOf`, `distinctOpenAnswerGaps`, `mergeCoverage`)
- Modify: `packages/server/src/modules/materials/lessons/lesson-drafts.ts:435` (stała `DISTINCT_OPEN_ANSWERS_PER_OBJECTIVE` → import z domeny)
- Modify: `packages/contracts/src/lessons.ts:450` (`CoverageGapDtoSchema`: `excluded: z.number().int().positive().optional()`)
- Test: `packages/server/src/domain/lessons/lesson-coverage.test.ts`

**Interfaces:**
- Consumes: `findExposureLeaks` (Task 1), `poolCoverage`, `CoverageGap` (`pool-validation.ts`), `DEFAULT_LESSON_POLICY` (`lesson-policy.ts`).
- Produces:
  ```ts
  export const DISTINCT_OPEN_ANSWERS_PER_OBJECTIVE = 2;
  export function lessonPoolMinimums(subject: Pick<SubjectModule, "poolMinimums">): PoolMinimums;
  export interface LessonCoverageInput {
    readonly subject: SubjectModule;
    readonly exercises: readonly LessonExerciseDraft[];
    readonly examples: Readonly<Record<string, readonly string[]>>;
    readonly objectiveIds: readonly string[];
  }
  /** Braki: poolCoverage bez ujawnionych (coverage) samodzielnych + reguła różnych odpowiedzi otwartych (usesV3Payload), jeden wpis na cel+etap z większym brakiem; `excluded` = liczba wykluczonych ujawnionych ćwiczeń etapu (tylko gdy > 0). */
  export function lessonCoverageGaps(input: LessonCoverageInput): (CoverageGap & { readonly excluded?: number })[];
  /** Brak per etap zagadnienia = max(required − actual) po obu źródłach braków; 0 gdy pokryte. */
  export function stageDeficits(input: LessonCoverageInput, objectiveId: string): { guided: number; productive: number; independent: number };
  ```
  `readLessonDraftDto`: przy nieznanym przedmiocie (`getSubject` zwraca `undefined`) — dotychczasowe `poolCoverage` z minimami domyślnymi, bez ujawnień.

- [ ] **Step 1: Write the failing tests**

```ts
it("tłumaczenie = przykład karty nie liczy się do independent → { stage: 'independent', actual: 1, required: 2, excluded: 1 }", ...);
it("rodzina szkolna: trzy open_answer z jedną odpowiedzią → brak independent (2 różne wymagane), excluded 2", ...);
it("bez ujawnień wynik równy dawnemu mergeCoverage(poolCoverage, distinctOpenAnswerGaps) — tabela 3 przedmiotów", ...);
it("większy brak wygrywa: poolCoverage brak 0, reguła różnych odpowiedzi brak 1 → jeden wpis z brakiem 1", ...);
it("stageDeficits: rozdział 3/3/0 przy minimach 3/3/2 → { guided: 0, productive: 0, independent: 2 }", ...);
it("lessonPoolMinimums: przedmiot bez poolMinimums → DEFAULT_LESSON_POLICY.poolMinimums", ...);
```
- [ ] **Step 2: Run** `corepack pnpm vitest run --config vitest.unit.config.ts packages/server/src/domain/lessons/lesson-coverage.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement**; w `lesson-api.ts` odczyt szkicu i publikacja wołają `lessonCoverageGaps({ subject, exercises: drafts, examples: context.examples, objectiveIds: context.objectiveIds })`.
- [ ] **Step 4: Run** `corepack pnpm vitest run --config vitest.unit.config.ts packages/server/src/domain/lessons packages/server/src/modules/materials/lessons packages/contracts` oraz `UMIEM_TEST_RUN_ID=t3 corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/lesson-parent-api.test.ts tests/integration/lesson-chapter.test.ts tests/integration/lesson-shape.test.ts tests/integration/lesson-parent-supervision.test.ts` — Expected: PASS
- [ ] **Step 5: Commit** — `Lekcje: pokrycie bez ujawnionych ćwiczeń samodzielnych`

---

### Task 4: Ujawnienia w DTO szkicu i w edytorze rodzica

**Files:**
- Modify: `packages/contracts/src/lessons.ts` (`LessonDraftDtoSchema`), `packages/contracts/src/lessons.test.ts`, `packages/contracts/src/messages.ts`
- Modify: `packages/server/src/modules/materials/lessons/lesson-api.ts` (`readLessonDraftDto`)
- Modify: `apps/web/src/parent/lessons/LessonExerciseCard.tsx`, `apps/web/src/parent/lessons/LessonEditor.tsx` (~784 `forcedObjectives`/`forcedStages`, ~1079 lista braków), `apps/web/src/parent/lessons/lesson-editor-state.ts` (jeśli tam żyje formatowanie braków)
- Test: `tests/integration/lesson-parent-api.test.ts`, `apps/web/src/parent/lessons/lesson-exercise-card.test.tsx`, `tests/e2e/parent-lesson-editor-layout.spec.ts` (rozszerzenie istniejącego speca `mocked` z fixture'em o UUID)

**Interfaces:**
- Consumes: `findExposureLeaks` (Task 1, `mode: "coverage"`), `lessonCoverageGaps` (Task 3), `seedEditorPoolWithLeak` (Task 2).
- Produces (DTO; pole pomijane, gdy lista pusta albo wersja nieedytowalna — `published`):
  ```ts
  exposureLeaks: z.array(z.object({
    exerciseId: UuidSchema,
    kind: z.enum(["hard", "soft"]),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("card_example"), objectiveId: z.string().min(1) }).strict(),
      z.object({ kind: z.literal("exercise"), exerciseId: UuidSchema }).strict(),
    ]),
  }).strict()).optional(),
  ```
  (Odstępstwo od `sourceLabelPl` ze spec §8: etykietę składa UI z katalogu — Task 9 poprawia spec.)
- Komunikaty (`messages.lessons`), dokładne teksty:
  - `exposureLeakCard: "Rozwiązanie widać wcześniej na karcie zagadnienia „{objective}”, więc to ćwiczenie nie sprawdza samodzielnej odpowiedzi. Zmień zdanie albo usuń ćwiczenie; brakujące ćwiczenia możesz dogenerować."`
  - `exposureLeakExercise: "Rozwiązanie widać wcześniej w ćwiczeniu {n}, więc to ćwiczenie nie sprawdza samodzielnej odpowiedzi. Zmień zdanie albo usuń jedno z ćwiczeń; brakujące ćwiczenia możesz dogenerować."`
  - `exposureLeakSoft: "Tę samą odpowiedź ma ćwiczenie {n} — jako sprawdzenie samodzielne liczy się tylko jedno z nich."`
  - `exposureLeakShow: "Pokaż ćwiczenie {n}"`
  - `exposureLeakStale: "Zapisz zmiany, aby sprawdzić to ponownie."`
  - `coverageGapExcluded: "{objective} · {stage}: jest {actual} ({excluded} z rozwiązaniem widocznym wcześniej), trzeba {required}"`
  - `rejectedReasonsLabel` (zmiana): `"Powody odrzuceń przy generowaniu"` (+ komentarz: źródła — słownik rozdziału i ujawnione rozwiązania)

UI: ostrzeżenie poza zwiniętym ciałem karty (nagłówek karty), `Alert` Mantine — `hard` kolor `yellow`, `soft` kolor `gray`; bez `role="alert"`, powiązane z `<article>` przez `aria-describedby`; „Pokaż ćwiczenie {n}” rozwija zagadnienie i etap źródła (rozszerzenie mechanizmu `forcedObjectives`/`forcedStages` o stan „pokaż źródło”) i przewija do niego; przy `changed` zamiast treści ostrzeżenia `exposureLeakStale`; ostrzeżeń brak przy wersji tylko do odczytu; brak etapu z `excluded` renderowany `coverageGapExcluded`.

- [ ] **Step 1: Write the failing tests**
  - kontrakt: schemat przyjmuje oba warianty `source`, odrzuca nieznane pole;
  - integracja: `seedEditorPoolWithLeak` → GET `lessons/:deckId`: `exposureLeaks` z `card_example`, `coverage` z `{ stage: "independent", excluded: 1 }`; PATCH samego tytułu → 200 i `exposureLeaks` nadal obecne; publish → 409 `lesson coverage incomplete`; PATCH zdania ćwiczenia → 200, `exposureLeaks` nieobecne, publish → 200; wersja opublikowana — brak `exposureLeaks`; świeżo wygenerowany szkic rozdziału/gramatyki/szkoły z fake'a — brak `exposureLeaks`;
  - komponent: `hard`/`card_example` → `exposureLeakCard` z tytułem zagadnienia i przyciskiem `exposureLeakShow`; `soft` → `exposureLeakSoft`, kolor szary; `changed` → `exposureLeakStale`; brak `role="alert"`;
  - E2E (`parent-lesson-editor-layout.spec.ts`, 390×844 i 1280×800): fixture z brakiem `independent` i wpisem `exposureLeaks`; ostrzeżenie widoczne w nagłówku karty, `coverageGapExcluded` w liście braków, „Pokaż ćwiczenie” otwiera źródło, brak przepełnienia poziomego, cel przycisku ≥ 48 px.
- [ ] **Step 2: Run** testy z kroku 1 (unit z `--config vitest.unit.config.ts`; E2E: `UMIEM_E2E_WEB_MODE=dev corepack pnpm exec playwright test tests/e2e/parent-lesson-editor-layout.spec.ts --project=mocked`) — Expected: FAIL
- [ ] **Step 3: Implement**; `readLessonDraftDto` mapuje indeksy na `revisions[i].itemId`.
- [ ] **Step 4: Run** testy z kroku 1 + `corepack pnpm vitest run --config vitest.unit.config.ts apps/web/src/parent/lessons` + `tests/e2e/lesson-parent.spec.ts --project=real` (z `UMIEM_E2E_WEB_MODE=dev`) — Expected: PASS
- [ ] **Step 5: Commit** — `Panel lekcji: ostrzeżenie o rozwiązaniu widocznym wcześniej i pokrycie z wykluczeniami`

---

### Task 5: Wydzielenie walidacji świeżej puli (`acceptFreshLessonPool`) — bez zmiany zachowania

**Files:**
- Create: `packages/server/src/modules/materials/lessons/lesson-pool-acceptance.ts`
- Modify: `packages/server/src/modules/materials/lessons/lesson-drafts.ts:1553-1640`
- Test: `packages/server/src/modules/materials/lessons/lesson-pool-acceptance.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface FreshPoolInput {
    readonly rawExercises: readonly unknown[];
    readonly subject: SubjectModule;
    readonly topic: LessonTopic;
    readonly material: string;
    readonly familyScope: string | null;                     // runId przy dogenerowaniu ręcznym, `${runId}-t` w rundzie pod etap, null w pełnej generacji
    readonly existingDrafts: readonly LessonExerciseDraft[];
    readonly existingAnswers: ReadonlySet<string>;
    readonly existingExerciseIdentities: ReadonlySet<string>;
    readonly objectiveLimits: ReadonlyMap<string, ObjectiveGenerationLimits>;
  }
  export interface FreshPoolResult {
    readonly accepted: LessonExerciseDraft[];
    readonly shapeRejected: number;
    readonly refineRejected: number;
    readonly refinedReasons: Readonly<Record<string, number>>;
    readonly rejected: readonly { exercise: LessonExerciseDraft; errors: string[] }[];   // validatePool + pool extra + cap
    readonly duplicateCount: number;
    readonly droppedAcceptedVariants: number;
    readonly droppedExplanations: number;
  }
  export function acceptFreshLessonPool(input: FreshPoolInput): FreshPoolResult;
  ```
  Kroki i semantyka identyczne z obecnym kodem; `rejectedCount`, `summarizeLessonPoolValidation` i logi składa wywołujący (z `rawExerciseCount`, `outOfScopeCount`).

- [ ] **Step 1: Baseline** — uruchom bez zmian `UMIEM_TEST_RUN_ID=t5a corepack pnpm test:integration` i zapisz (w opisie commita) wynik; to jest wzorzec regresji.
- [ ] **Step 2: Write the failing test** — jednostkowo: pula rozdziału z odrzuceniem słownikowym, wadliwy kształt, duplikat wobec szkicu, nadmiar słuchowy → oczekiwane `accepted.length`, `refinedReasons`, liczniki (wartości z bieżącego kodu, odczytane przez wywołanie starej ścieżki w teście lub z logów kroku 1).
- [ ] **Step 3: Run** — Expected: FAIL (brak modułu)
- [ ] **Step 4: Implement** — przenieś blok; `executeLessonGeneration` zachowuje logi i liczniki.
- [ ] **Step 5: Run** `corepack pnpm test:unit` i `UMIEM_TEST_RUN_ID=t5b corepack pnpm test:integration` — Expected: PASS, wynik identyczny z krokiem 1
- [ ] **Step 6: Commit** — `Lekcje: wydzielona walidacja świeżej puli (bez zmiany zachowania)`

---

### Task 6: Reguła twarda przy generowaniu

**Files:**
- Modify: `packages/server/src/modules/materials/lessons/lesson-drafts.ts` (odczyt szkicu przed pętlą partii; reguła po `acceptFreshLessonPool`; zapis `examples` i liczników)
- Test: `tests/integration/lesson-generation.test.ts`, `tests/integration/lesson-chapter.test.ts`

**Interfaces:**
- Consumes: `resolveGenerationLeaks` (Task 1), `acceptFreshLessonPool` (Task 5).
- Produces:
  - przed pętlą partii (poza transakcją; straż `editNumber` w transakcji bez zmian): `draftExamples = lesson_context.examples ?? {}` i `existingDrafts` (dziś czytane po pętli — przenieść) — używane też przez Task 7;
  - `resolveGenerationLeaks({ existing: existingDrafts, fresh: accepted, existingExamples: draftExamples, newExamples: examples, objectiveOrder, subject })`, `objectiveOrder` = cele przebiegu (pełna) albo `lesson_context.objectiveIds` (dogenerowanie);
  - zapis: `examples: { ...prevContext.examples, ...keptNewExamples }`; `rejectedCount += droppedFresh.length`; `rejectedReasons["rozwiązanie widoczne wcześniej"] += droppedFresh.length`; log `[lesson] run=<id> ujawnienia: usunięte=<n> przykłady=<droppedExampleCount>`;
  - 0 ćwiczeń po regule → dotychczasowa ścieżka `failed/validation` z licznikami.

- [ ] **Step 1: Write the failing tests** (`queueLesson` z jawną pulą)
  - pełna generacja gramatyki: tłumaczenie równe przykładowi karty → poza szkicem, `rejectedReasons["rozwiązanie widoczne wcześniej"] === 1`;
  - pełna generacja rozdziału: przykład karty A ujawnia tłumaczenie w B → tłumaczenie B poza szkicem;
  - rozdział: wariant „Where is the box?” tłumaczenia vs przykład „Where's the box?” → poza szkicem;
  - dogenerowanie: nowa luka rozwiązująca istniejące tłumaczenie → luka poza szkicem, tłumaczenie zostaje;
  - dogenerowanie: jedyny nowy przykład równy istniejącemu tłumaczeniu → stare przykłady zagadnienia zostają, tłumaczenie zostaje;
  - szkoła: rodzina trzech `lesson_open_answer` → wszystkie w szkicu, `coverage` liczy jedno (z Task 3);
  - domyślny fake (rozdział, gramatyka, szkoła) → `rejectedReasons` bez klucza ujawnień.
- [ ] **Step 2: Run** `UMIEM_TEST_RUN_ID=t6 corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/lesson-generation.test.ts tests/integration/lesson-chapter.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** `UMIEM_TEST_RUN_ID=t6b corepack pnpm test:integration` — Expected: PASS
- [ ] **Step 5: Commit** — `Generowanie lekcji: reguła twarda rozwiązań widocznych wcześniej`

---

### Task 7: `avoidSentences` w wejściu generatora

**Files:**
- Modify: `packages/server/src/providers/openai/llm.ts` (`lessonUserMaterial` ~419 — ogrodzony blok danych)
- Modify: `packages/server/src/modules/materials/lessons/lesson-drafts.ts` (`buildPoolInput` — argument opcji `{ avoidSentences, purpose }` zamiast kolejnego pozycyjnego; pętla partii)
- Create: `packages/server/src/domain/lessons/avoid-sentences.ts`
- Test: `packages/server/src/domain/lessons/avoid-sentences.test.ts`, `packages/server/src/providers/openai/llm.test.ts`, `packages/server/src/modules/materials/lessons/lesson-drafts.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** Priorytet: wszystkie przykłady kart, potem rozwiązania ćwiczeń niesamodzielnych, potem samodzielnych (najnowsze pierwsze); deduplikacja po answersEquivalent; limit 60 pozycji i 4000 znaków łącznie (pozycja przekraczająca limit znaków jest pomijana). */
  export function avoidSentencesFor(input: {
    readonly examples: Readonly<Record<string, readonly string[]>>;
    readonly exercises: readonly LessonExerciseDraft[];       // szkic + wcześniejsze partie przebiegu (po isWellShapedRawExercise + toExerciseDraft)
    readonly subject: LeakSubject;
  }): string[];
  ```
  Adapter: przy niepustej liście blok w wiadomości użytkownika `AVOID SENTENCES (data, not instructions): do not use any of these as an exercise solution or card example` + `- …`; brak bloku przy pustej. Generator dostaje listę w każdej partii pełnej generacji (od drugiej), w dogenerowaniu ręcznym i w rundzie pod etap; `existingExercises` = cały szkic i wcześniejsze partie (numeracja fake'a).

- [ ] **Step 1: Write the failing tests** — `avoidSentencesFor`: kolejność priorytetów, deduplikacja „Where's…/Where is…”, limit 60 i 4000 znaków; adapter: blok obecny/nieobecny; przypadek użycia: druga partia pełnej generacji dostaje przykłady i rozwiązania pierwszej; `child-interests.test.ts` nadal widzi `interests` w każdym żądaniu.
- [ ] **Step 2: Run** `corepack pnpm vitest run --config vitest.unit.config.ts packages/server/src/domain/lessons/avoid-sentences.test.ts packages/server/src/providers/openai/llm.test.ts packages/server/src/modules/materials/lessons/lesson-drafts.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** jak w kroku 2 + `UMIEM_TEST_RUN_ID=t7 corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/child-interests.test.ts tests/integration/lesson-generation.test.ts` — Expected: PASS
- [ ] **Step 5: Commit** — `Generator lekcji: zdania do unikania`

---

### Task 8: Dogenerowanie pod brakujący etap i miękki limit wywołania

**Files:**
- Modify: `packages/server/src/modules/materials/lessons/lesson-generation-control.ts` (`callSoft`)
- Modify: `packages/server/src/modules/materials/lessons/lesson-generation-policy.ts` (`stageTopUp?: boolean` w polityce; brak = `true`; nie z env — tylko wstrzykiwane w testach przez `deps.lessonExecution`)
- Modify: `packages/server/src/modules/materials/lessons/lesson-drafts.ts` (runda po Task 6, przed transakcją)
- Test: `packages/server/src/modules/materials/lessons/lesson-generation-control.test.ts`, `tests/integration/lesson-generation.test.ts`, `tests/integration/lesson-chapter.test.ts`, `tests/integration/lesson-chapter-sentence-audio.test.ts`

**Interfaces:**
- Consumes: `stageDeficits` (Task 3), `acceptFreshLessonPool` (Task 5), `resolveGenerationLeaks` (Task 1), `avoidSentencesFor` (Task 7), `queueLessonTopUp` (Task 2).
- Produces:
  ```ts
  // LessonGenerationControl
  /** Jak call, ale przekroczenie requestTimeoutMs przerywa tylko to żądanie (abort własnego kontrolera, bez abort korzenia) i rzuca GenerationProviderError("timeout"); deadline przebiegu, assertCurrent i zamknięcie procesu jak w call. */
  callSoft<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T>;
  ```
  Runda (tylko gdy po Task 6 jest ≥ 1 ćwiczenie i `policy.stageTopUp !== false`):
  - zakres: drugi `withLessonGenerationControl({ ...executionPolicy, runTimeoutMs: runDeadlineAtMs - now, signal: options.signal, assertCurrent })`; `LessonGenerationCancelledError` przechodzi do zewnętrznej obsługi (shutdown → `queued`, edycja → `superseded`), każdy inny błąd łapany lokalnie: log `[lesson] run=<id> dogenerowanie pod etap: błąd=<kod>` i koniec rundy;
  - dla każdego zagadnienia przebiegu w kolejności: `stageDeficits` na `[...existingDrafts, ...kept]` z końcowymi przykładami; suma 0 → pomiń; przed każdym wywołaniem: `runDeadlineAtMs - now ≥ requestTimeoutMs + 30 000`, inaczej log `… pominięte: brak czasu` i koniec rundy;
  - wejście: `buildPoolInput(...)` z nadpisaniem `countPerObjective` = suma braków, `stageCounts` = braki, bez `listenChoicePerObjective`, `existingAnswers`/`existingExercises` = cały szkic + `kept`, opcje `{ avoidSentences: avoidSentencesFor(...), purpose: "stage_top_up" }`; `control.callSoft(generateLessonPool)`; przykłady z odpowiedzi ignorowane;
  - wynik: `acceptFreshLessonPool` z `familyScope: \`${runId}-t\``, `existingDrafts` = szkic + `kept`, `existingExerciseIdentities` = tożsamości szkicu i `kept`, `objectiveLimits` z wpisem `{ count: suma, listen: 0, stages: braki }`; potem jawne przycięcie przyjętych do braków per etap (nadwyżka → odrzucenie z powodem `exerciseType: ponad brak etapu`); potem `resolveGenerationLeaks` (existing = szkic + `kept`, fresh = nowe); `keptFresh` dołączane; liczniki odrzuceń rundy dodawane do `rejectedCount` i `rejectedReasons` jak w partii głównej;
  - log sukcesu: `[lesson] run=<id> dogenerowanie pod etap: zagadnienie=<slug> guided=<n> productive=<n> independent=<n> przyjęte=<n>`.

Istniejące testy z pulami zbyt małymi do pokrycia, które sprawdzają liczniki, wywołania lub `failed` (`lesson-generation.test.ts` ~411-475, ~551-581, ~680-736; `lesson-chapter.test.ts` ~200, ~225-283; `lesson-chapter-sentence-audio.test.ts` ~153): wstrzyknąć `lessonExecution: { ...policy, stageTopUp: false }` — ich intencja dotyczy partii głównej. Nie zmieniać ich oczekiwań.

- [ ] **Step 1: Write the failing tests**
  - kontrola (`vi.useFakeTimers()`): `callSoft` z żądaniem dłuższym niż `requestTimeoutMs` → `timeout`, a następne `call` w tym samym zakresie działa;
  - integracja: rozdział, `queueLesson` z pulą, w której jedno z dwóch tłumaczeń zagadnienia jest ujawnione → reguła twarda je usuwa, runda: `generateLessonPool` z `purpose: "stage_top_up"`, `stageCounts` `toEqual({ guided: 0, productive: 0, independent: 1 })`, `countPerObjective === 1`, `avoidSentences` zawiera przykłady kart → `coverage` pusta, przykłady z odpowiedzi rundy nie trafiają do `examples`;
  - integracja: dwa zagadnienia z brakiem → dwa wywołania rundy, numeracja fake'a bez kolizji (brak ujawnień w wyniku);
  - integracja: `queueLessonTopUp({ throws: retryable provider error })` → run `succeeded`, `attempts === 1`, szkic zapisany, `coverage` z brakiem;
  - integracja: runda z `lessonDelayMs` > `requestTimeoutMs` (mały `requestTimeoutMs`) → `succeeded`, bez rundy;
  - integracja: deadline bliski (`runTimeoutMs` mały, główna partia z opóźnieniem) → log „brak czasu”, `succeeded`;
  - integracja: edycja rodzica w trakcie rundy (`lessonDelayMs` + PATCH) → `superseded`, brak zapisu;
  - integracja: zagadnienie bez braków → brak wywołania rundy;
  - integracja: główna partia z 0 przyjętych → `failed/validation` jak dziś, bez rundy.
- [ ] **Step 2: Run** `corepack pnpm vitest run --config vitest.unit.config.ts packages/server/src/modules/materials/lessons/lesson-generation-control.test.ts` i `UMIEM_TEST_RUN_ID=t8 corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/lesson-generation.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement** `callSoft`, `stageTopUp`, rundę; wstrzyknij `stageTopUp: false` w wymienionych testach
- [ ] **Step 4: Run** `corepack pnpm test:unit` i `UMIEM_TEST_RUN_ID=t8b corepack pnpm test:integration`; sprawdź czas kosza z `lesson-generation.test.ts` (log Vitest) wobec `INTEGRATION_BUCKETS` — Expected: PASS
- [ ] **Step 5: Commit** — `Generowanie lekcji: dogenerowanie pod brakujący etap`

---

### Task 9: Raport istniejących szkiców, dokumentacja i pełna weryfikacja

**Files:**
- Create: `packages/server/src/modules/materials/lessons/lesson-exposure-report.ts` (tylko odczyt), `scripts/report-exposure-leaks.mts` (import bezpośredni z `packages/server/src/...`, jak `scripts/evaluate-school-grader.mts`)
- Create: `tests/integration/lesson-exposure-report.test.ts` (do najlżejszego kosza `INTEGRATION_BUCKETS`)
- Modify: `package.json` (`"report:exposure-leaks": "node apps/worker/node_modules/tsx/dist/cli.mjs scripts/report-exposure-leaks.mts"`)
- Modify: `docs/architecture.md` §19 (nowy podrozdział „Rozwiązania widoczne wcześniej i dogenerowanie pod etap (2026-11-02)”: dwie relacje, reguła, gdzie działa, `avoidSentences`, runda i `callSoft`, budżet czasu PR 1 — runda w limicie 600 s, pominięcie logowane „brak czasu”, wpływ na istniejące szkice, API → MCP → skill bez zmian), `docs/SPEC.md` §29a i §37, spec `2026-11-02-lesson-review-stage-design.md` §5.2 (klucz powodu „rozwiązanie widoczne wcześniej”) i §8 (`exposureLeaks` ze strukturalnym `source` zamiast `sourceLabelPl`; komunikat 409 bez zmian)

**Interfaces:**
- Produces:
  ```ts
  export interface ExposureReportRow {
    readonly deckVersionId: string; readonly deckId: string; readonly state: "draft" | "review";
    readonly hardLeaks: number; readonly softLeaks: number;
    readonly blockedBefore: boolean;   // braki pokrycia po staremu (poolCoverage + reguła szkoły, bez wykluczeń)
    readonly blockedAfter: boolean;    // lessonCoverageGaps
  }
  export async function reportLessonExposureLeaks(db: Executor, services: Services): Promise<ExposureReportRow[]>;
  ```
  Skrypt drukuje wiersze z `hardLeaks + softLeaks > 0` i podsumowanie `nowo zablokowane = blockedAfter && !blockedBefore`; bez treści ćwiczeń i danych dziecka. Procedura (do opisu PR): właściciel uruchamia lokalnie na gałęzi z `DATABASE_URL` wskazującym bazę odtworzoną z kopii (`deploy/restore.sh`) albo tunel tylko do odczytu.

- [ ] **Step 1: Write the failing test** — baza z trzema szkicami: czysty, z ujawnieniem przy wystarczającym pokryciu, z ujawnieniem powodującym brak → `blockedAfter && !blockedBefore` tylko dla trzeciego.
- [ ] **Step 2: Run** `UMIEM_TEST_RUN_ID=t9 corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/lesson-exposure-report.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement** raport, skrypt, dokumentację
- [ ] **Step 4: Run pełną weryfikację**
  - `corepack pnpm typecheck` — Expected: brak błędów
  - `corepack pnpm test:unit` — Expected: PASS
  - `UMIEM_TEST_RUN_ID=t9b corepack pnpm test:integration` — Expected: PASS
  - `corepack pnpm test:e2e:shards` — Expected: PASS (mocked + real)
- [ ] **Step 5: Commit** — `Docs i raport: rozwiązania widoczne wcześniej i dogenerowanie pod etap`

Przed otwarciem PR: przegląd całej gałęzi trzema niezależnymi krytykami; opis PR — procedura i wynik `report:exposure-leaks` (albo prośba do właściciela o uruchomienie), API → MCP → skill bez zmian, wykonane sprawdzenia, niezweryfikowane (prawdziwy model — `avoidSentences` i runda pod etap bez próby płatnej).

---

## Rozstrzygnięcia po review trzech krytyków planu (2026-11-02)

- **Kolejność**: fake i fixture'y (Task 2) przed pokryciem (Task 3) — inaczej Task 3 zostawiał czerwone testy; pole `avoidSentences`/`purpose` w porcie już w Task 2 (typecheck).
- **Runda pod etap**: osobny zakres `withLessonGenerationControl` (dawna wersja wołała `control` poza zakresem), sprawdzenie czasu przed każdym wywołaniem, `failed` przy pustej partii głównej bez rundy, deduplikacja i zakres rodzin rundy, numeracja po całym szkicu, jawne przycięcie do braków, marker `purpose: "stage_top_up"` + `queueLessonTopUp` + `stageTopUp: false` dla testów partii głównej.
- **Reguła przy generowaniu**: wszystkie źródła twarde ofiary (nie tylko pierwsze); przykłady szkicu czytane przed pętlą; brak pustej karty po odrzuceniu przykładów.
- **Domena**: `DISTINCT_OPEN_ANSWERS_PER_OBJECTIVE` i minima przedmiotu w domenie; większy brak z dwóch źródeł; nieznany przedmiot obsłużony w odczycie.
- **UX**: komunikaty z działaniem, „Pokaż ćwiczenie”, miękkie szare, nieaktualne przy niezapisanej zmianie, brak na wersji opublikowanej, `excluded` w braku etapu, nowa etykieta powodów odrzuceń, bez `role="alert"`.
- **Testy**: konkretne przypadki Review Focus 1 i 4, timeout i deadline, superseded w rundzie, dokładne `stageCounts`, kontrakt DTO, E2E w istniejącym specu `mocked`, baseline przed refaktorem, `--config vitest.unit.config.ts`.
- **Raport**: przed/po i „nowo zablokowane”, procedura uruchomienia, import bezpośredni w skrypcie.
