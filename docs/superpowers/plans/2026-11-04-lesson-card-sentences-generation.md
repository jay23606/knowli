# Zdania kart w generowaniu (PR wstępny #237) — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Angielskie zdania wpisane w treść kart rozdziału są stałym źródłem ujawnień przy generowaniu puli (reguła twarda i lista zdań do unikania), bez zapisu do `lesson_context.examples` i bez zmian w pokryciu, publikacji i sesji.

**Architecture:** Opcjonalny hak `SubjectModule.cardExposureTexts` (tylko `english_chapter`), czysta funkcja `cardExposureSources(subject, topic)` i nowy parametr `fixedSources` w `resolveGenerationLeaks` (doklejany po zastąpieniu przykładów nowymi). `executeLessonGeneration` i `stageTopUpRound` podają zdania kart wyłącznie do `fixedSources` i do `avoidSentencesFor`.

**Tech Stack:** TypeScript strict, Vitest (unit + integracja na PostgreSQL), pnpm.

**Spec:** `docs/superpowers/specs/2026-11-04-lesson-pool-agent-stage1-design.md` §5 (wersja 2 z poprawkami po review planów).

**Gałąź:** bieżąca gałąź worktree (zawiera spec i plany); PR do `main`.

## Global Constraints

- Kod i identyfikatory po angielsku; komentarze, dokumentacja i opisy PR po polsku.
- Hak implementuje **tylko** `english_chapter`; gramatyka i szkoła go nie mają.
- Zdania kart **nigdy** nie trafiają do zapisywanego `lesson_context.examples`, `keptNewExamples`, `finalExamples` dla zapisu, renderowania karty ani fingerprintów nagrań.
- Bez zmian: `lessonCoverageGaps`/`stageDeficits` (runda liczy braki na `ctx.examples`), publikacja, lista ujawnień edytora, raport ujawnień, `materializeCard`, krytyk (`lesson-review.ts`).
- Instalacja tylko `pnpm install --prefer-offline --frozen-lockfile`; ten PR nie zmienia zależności.
- Nie wypychaj do `main`, nie scalaj PR (AGENTS.md, Policy).

## Review Focus

- Linia mieszana polsko-angielska „Pokój — my room is big.” — angielska część jest zdaniem, polska „Pokój” nie (test w Task 1).
- Apostrof typograficzny („There’s a bed.”) — normalizowany do `'`; zdanie w cudzysłowie typograficznym („„There is a bed.”") odpada w całości (test w Task 1, zachowanie świadome).
- Dogenerowanie — nowa partia z nowymi przykładami zagadnienia nadal widzi zdania kart (test w Task 3).
- Runda pod etap — zdanie karty odrzuca ćwiczenie rundy, a braki etapów liczone bez zdań kart (test w Task 3).
- Zagadnienie bez zdań na kartach — `cardExposureSources` nie zawiera klucza; `fixedSources` pusty nie zmienia wyniku `resolveGenerationLeaks` (testy w Task 1–2).

---

### Task 1: Hak `cardExposureTexts` i `cardExposureSources`

**Files:**
- Modify: `packages/server/src/domain/lessons/types.ts` (pole w `SubjectModule`, obok `normalizeExposureText`)
- Modify: `packages/server/src/domain/lessons/subjects/english-chapter/exposure.ts`, `.../english-chapter/module.ts`
- Create: `packages/server/src/domain/lessons/card-exposure-sources.ts`
- Test: `.../english-chapter/exposure.test.ts`, `packages/server/src/domain/lessons/card-exposure-sources.test.ts`

**Interfaces:**
- Produces:
  - `SubjectModule.cardExposureTexts?(cards: readonly { readonly body: string }[]): string[]` — JSDoc po polsku: teksty z treści kart, które dziecko widzi jako gotowe rozwiązania; tylko generowanie.
  - `chapterCardExposureTexts(cards: readonly { readonly body: string }[]): string[]` w `english-chapter/exposure.ts`.
  - `cardExposureSources(subject: Pick<SubjectModule, "cardExposureTexts">, topic: Pick<LessonTopic, "objectives">): Record<string, string[]>` — tylko zagadnienia z niepustą listą.

- [ ] **Step 1: Testy `chapterCardExposureTexts`** (`exposure.test.ts`):

```ts
it("zdania z kropką/pytajnikiem albo ≥ 3 słowa", () => {
  expect(chapterCardExposureTexts([{ body: "There is a bed in my room.\nWhere is the lamp?" }]))
    .toEqual(["There is a bed in my room.", "Where is the lamp?"]);
});
it("słówka nie; części po „ — ” i „ / ” osobno; polska część odpada", () => {
  expect(chapterCardExposureTexts([{ body: "living room — salon\nbed — łóżko / I have a big bed.\nPokój — my room is big." }]))
    .toEqual(["I have a big bed.", "my room is big."]);
});
it("rama z wielokropkiem i zdanie z polskimi znakami odpadają; cudzysłów typograficzny odpada", () => {
  expect(chapterCardExposureTexts([{ body: "There's a … in the …\nTo jest mój pokój.\n„There is a bed.”" }])).toEqual([]);
});
it("apostrof typograficzny → ', duplikaty usunięte", () => {
  expect(chapterCardExposureTexts([{ body: "There’s a bed." }, { body: "There's a bed." }])).toEqual(["There's a bed."]);
});
it("świadomy koszt: polskie zdanie bez znaków diakrytycznych jest uznane za zdanie", () => {
  expect(chapterCardExposureTexts([{ body: "To jest kot." }])).toEqual(["To jest kot."]);
});
it("prawdziwe karty rozdziału: fixture z fake'a zagadnień", () => {
  // karty z `fakeLessonObjectives` (providers/fake.ts) dla CHAPTER_MATERIAL z tests/integration/lesson-chapter.test.ts:
  // zagadnienie 2 ma karty „It's raining.” i „It's snowing.”
  expect(chapterCardExposureTexts([{ body: "It's raining." }, { body: "It's snowing." }])).toEqual(["It's raining.", "It's snowing."]);
});
```

- [ ] **Step 2: FAIL** — `pnpm exec vitest run --config vitest.unit.config.ts packages/server/src/domain/lessons/subjects/english-chapter/exposure.test.ts`
- [ ] **Step 3: Zaimplementuj** — reguła `cardSentences` z PoC (`git show origin/probe/lesson-pool-agent:tests/probes/agent-generation-v2.probe.test.ts`, funkcja `cardSentences`): linie → części po `/\s+[—/]\s+/u` → `’‘` na `'` → pomiń puste, z `…`/`...` i niepasujące do `/^[A-Za-z][A-Za-z' ,.?!]*$/u` → zachowaj zakończone `[.?!]` albo z ≥ 3 słowami → deduplikacja. Podłącz `cardExposureTexts: chapterCardExposureTexts` w `englishChapterSubject`.
- [ ] **Step 4: PASS** (komenda ze Step 2).
- [ ] **Step 5: Testy `cardExposureSources`** (temat-fixture: `o1` z kartą „Card one.”, `o2` z kartą „Card two.”, `o3` z kartą „x”; przedmiot `{ cardExposureTexts: (cards) => cards.map((c) => c.body).filter((b) => b.endsWith(".")) }`):

```ts
expect(cardExposureSources(subject, topic)).toEqual({ o1: ["Card one."], o2: ["Card two."] });
expect(cardExposureSources({}, topic)).toEqual({});
expect(englishGrammarSubject.cardExposureTexts).toBeUndefined();
expect(schoolSubject.cardExposureTexts).toBeUndefined();
```

- [ ] **Step 6: FAIL → implementacja → PASS** — `pnpm exec vitest run --config vitest.unit.config.ts packages/server/src/domain/lessons/card-exposure-sources.test.ts`
- [ ] **Step 7:** `pnpm exec vitest run --config vitest.unit.config.ts packages/server/src/domain/lessons/architecture.test.ts packages/server/src/modules/module-boundaries.architecture.test.ts` — PASS.
- [ ] **Step 8: Commit** — „Lekcje: zdania kart rozdziału jako źródło ujawnień — hak przedmiotu (#237)”.

### Task 2: `fixedSources` w `resolveGenerationLeaks`

**Files:**
- Modify: `packages/server/src/domain/lessons/exposure-leaks.ts:181-234`
- Test: `packages/server/src/domain/lessons/exposure-leaks.test.ts`

**Interfaces:**
- Produces: `resolveGenerationLeaks(input & { readonly fixedSources?: Readonly<Record<string, readonly string[]>> })` — źródła reguły twardej: `{ ...existingExamples, ...keptNewExamples }` z doklejonymi per zagadnienie (konkatenacja) `fixedSources`; filtr nowych przykładów i `keptNewExamples`/`droppedExampleCount` bez zmian.

- [ ] **Step 1: Testy** (wzór istniejących testów `resolveGenerationLeaks` w pliku):
  - zagadnienie `o1` z `existingExamples: { o1: ["Old."] }`, `newExamples: { o1: ["New one."] }`, `fixedSources: { o1: ["We have a cat."] }`, świeże samodzielne tłumaczenie z odpowiedzią „We have a cat” → `droppedFresh` zawiera je, `keptNewExamples` = `{ o1: ["New one."] }`, `droppedExampleCount` = 0;
  - to samo bez `fixedSources` → tłumaczenie w `keptFresh` (dotychczasowe zachowanie);
  - `fixedSources: {}` → wynik identyczny jak bez parametru.
- [ ] **Step 2: FAIL → Step 3: implementacja → Step 4: PASS** — `pnpm exec vitest run --config vitest.unit.config.ts packages/server/src/domain/lessons/exposure-leaks.test.ts`
- [ ] **Step 5: Commit** — „Lekcje: stałe źródła ujawnień w regule twardej generowania (#237)”.

### Task 3: Podpięcie w generowaniu i dokumentacja

**Files:**
- Modify: `packages/server/src/modules/materials/lessons/lesson-drafts.ts` — `executeLessonGeneration` (`avoidSentencesFor` ok. l. 1732; reguła twarda `resolveGenerationLeaks` ok. l. 1862–1869); `StageTopUpContext` (od l. 1370); `stageTopUpRound` (`avoidSentencesFor` l. 1470, `resolveGenerationLeaks` l. 1495–1502); wywołanie `stageTopUpRound` (ok. l. 1968)
- Test: `tests/integration/lesson-chapter.test.ts`
- Modify: `docs/architecture.md` §19.15, `docs/SPEC.md` (l. 818)

**Interfaces:**
- Consumes: `cardExposureSources` (Task 1), `resolveGenerationLeaks.fixedSources` (Task 2).
- Produces: `StageTopUpContext.cardSources: Readonly<Record<string, readonly string[]>>`.

- [ ] **Step 1: Zmień istniejącą asercję** w teście „generator dostaje zdania do unikania…” (`lesson-chapter.test.ts` ok. l. 490): zamiast `expect(requests[0]).not.toHaveProperty("avoidSentences")` — `expect(requests[0]!.avoidSentences).toEqual(expect.arrayContaining(["It's raining.", "It's snowing."]))` (karty zagadnienia 2 `CHAPTER_MATERIAL` z fake'a). Dopasuj dokładne zdania do faktycznych kart fixture, odczytując je z `fakeLessonObjectives` dla tego materiału.
- [ ] **Step 2: Nowe testy** w describe „reguła twarda…” (`CARD = "There is a bed in my room."`, materiał `` `${CARD} I like my bed.` ``, tytuł „Pokój”; fake bierze karty z pierwszych dwóch zdań sekcji):

```ts
it("pełna generacja: tłumaczenie równe zdaniu karty → poza szkicem; przykłady = zwrócone przez generator", async () => {
  const { fakes, services } = await chapterWorld();
  const returned: Record<string, string[]> = {};
  routeLessonRound(fakes, async (input) => {
    const regular = await new FakeLlmProvider().generateLessonPool(input);
    Object.assign(returned, regular.examples);
    return { ...regular, exercises: withTranslation(regular.exercises, { prompt: "W moim pokoju jest łóżko.", answer: "There is a bed in my room", focus: ["bed"] }) };
  });
  const { draft } = await generateChapter(services, `${CARD} I like my bed.`, "Pokój");
  expect(draft.exercises.some((exercise) => exercise.answer === "There is a bed in my room")).toBe(false);
  expect(draft.rejectedReasons).toEqual({ [EXPOSURE_REASON]: 1 });
  expect(draft.examples).toEqual(returned);
});
it("generator dostaje zdanie karty w avoidSentences pierwszej partii", async () => {
  const { fakes, services } = await chapterWorld();
  await generateChapter(services, `${CARD} I like my bed.`, "Pokój");
  expect(fakes.llm.lessonRequests[0]!.avoidSentences).toContain(CARD);
});
it("dogenerowanie: nowa partia z nowymi przykładami nadal odrzuca tłumaczenie równe zdaniu karty", async () => {
  // szkic z generateChapter jak wyżej (bez podmiany), potem regenerateObjective dla jedynego zagadnienia;
  // routeLessonRound zwraca nowe przykłady { [id]: ["I like my lamp."] } i tłumaczenie z odpowiedzią "There is a bed in my room"
  // asercje: brak tej odpowiedzi w szkicu; rejectedReasons[EXPOSURE_REASON] === 1; draft.examples[id] === ["I like my lamp."]
});
it("runda pod etap: ćwiczenie rundy równe zdaniu karty odpada; liczba rund bez zmian", async () => {
  // wzór: test „dogenerowanie z rundą pod etap…” (lessonExecution = DEFAULT_LESSON_GENERATION_POLICY);
  // runda zwraca lukę samodzielną z odpowiedzią "There is a bed in my room";
  // asercje: brak tej odpowiedzi w szkicu; rounds (purpose === "stage_top_up") ma tę samą długość co w teście-wzorze (1)
});
```

- [ ] **Step 3: FAIL** — `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/lesson-chapter.test.ts` (nowe i zmieniony test FAIL, reszta PASS).
- [ ] **Step 4: Podepnij** w `lesson-drafts.ts`:
  - `executeLessonGeneration`: `const cardSources = cardExposureSources(subject, activeTopic)` po rozwiązaniu tematu; `avoidSentencesFor({ examples: mergeExamples(mergeExamples(draftExamples, examples), cardSources), … })`; reguła twarda (`resolveGenerationLeaks` z `fresh: mainReview.exercises`) dostaje `fixedSources: cardSources`; wywołanie z `fresh: []` (finalExamples) bez zmian.
  - `StageTopUpContext.cardSources` (przekazywane z `executeLessonGeneration`); w `stageTopUpRound` `avoidSentencesFor({ examples: mergeExamples(ctx.examples, ctx.cardSources), … })` i `resolveGenerationLeaks({ …, fixedSources: ctx.cardSources })`; `deficitsOf` bez zmian.
  - Krytyk (`reviewPhase`) bez zmian.
- [ ] **Step 5: PASS** (komenda ze Step 3), potem: `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/lesson-generation.test.ts tests/integration/lesson-review.test.ts tests/integration/lesson-exposure-report.test.ts` — PASS; jeśli test z materiałem zawierającym zdania kart zmieni wynik, zaktualizuj asercję tylko wtedy, gdy nowa wartość wynika z reguły (opisz w commicie).
- [ ] **Step 6: Dokumentacja** — `architecture.md` §19.15: akapit o zdaniach kart przy generowaniu (hak `cardExposureTexts`, `fixedSources`, niezapisywane; pokrycie, publikacja, edytor, raport i sesja liczą tylko przykłady). `SPEC.md` l. 818: „przykłady kart, zdania z treści kart rozdziału i rozwiązania innych ćwiczeń”.
- [ ] **Step 7: Commit** — „Lekcje: zdania kart w regule ujawnień i zdaniach do unikania przy generowaniu (#237)”.

### Task 4: Weryfikacja i PR

- [ ] **Step 1:** `pnpm typecheck` — PASS.
- [ ] **Step 2:** `pnpm test:unit` — PASS.
- [ ] **Step 3:** `pnpm test:integration` — PASS.
- [ ] **Step 4:** `pnpm build` — PASS.
- [ ] **Step 5:** `pnpm test:e2e:shards` — PASS (raportuj faktyczne liczby).
- [ ] **Step 6:** Trzech niezależnych krytyków na diffie gałęzi, poprawki.
- [ ] **Step 7:** Push gałęzi i PR do `main` (nie scalać). Opis po polsku: co zmieniono, czego świadomie nie zmieniono (§5), sprawdzenia z liczbami, wpływ API → MCP → `SKILL.md`: brak (generowanie nie jest wystawione; `learning-overview` nie obejmuje lekcji). W PR także spec i oba plany.
