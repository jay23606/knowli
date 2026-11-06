# Present Continuous w lekcjach gramatyki — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Wersja 2 (po przeglądzie trzech krytyków i decyzji właściciela: zmiana zdania po odpowiedzi dla wszystkich przedmiotów).

**Goal:** Trzeci temat katalogu `english_grammar` — `present_continuous@1` z sześcioma celami, deterministyczną walidacją jednoznaczności czasu i promptami — plus jedna zmiana silnika dla wszystkich przedmiotów: zdanie po odpowiedzi luki bez czasownika w nawiasie.

**Architecture:** Reguły tematu żyją w przedmiocie `english_grammar` (dane katalogu, walidator, prompty) i w `subjects/english/` (tabela form -ing). Czyste funkcje bez zależności od infrastruktury; walidator przedmiotu wołany przez istniejący `validateLessonExercise` i agenta. Bez migracji, bez zmian kontraktów, Kid UI, panelu, polityki agenta, MCP i `SKILL.md`; jedyna zmiana poza przedmiotem: `feedbackSentenceText` (spec §6.7).

**Tech Stack:** TypeScript strict, Vitest (unit; integracja na Postgresie w kontenerze), sonda Vitest na OpenRouter.

**Spec:** `docs/superpowers/specs/2026-11-05-present-continuous-design.md` (wersja 3). Implementer czyta sekcję specu wskazaną w zadaniu — plan nie powtarza list ani tekstów kart.

## Global Constraints

- Worktree `C:\Users\looka\IdeaProjects\knowli-worktrees\present-continuous`, gałąź `feature/present-continuous` od `origin/main` 3b4c1ec0. Nie wypychać do `main`, nie scalać PR. Push i PR dopiero w Task 16.
- Nigdy `npm install`; `node_modules` już jest. Bez nowych zależności.
- Żadnych płatnych wywołań modeli poza Task 15, i tam wyłącznie po wyraźnym „tak” właściciela na konkretną wiadomość z szacunkiem kosztu; każde ponowienie wymaga nowej zgody.
- Bez zmian w plikach, które zmienia PR 2 etapu 3 (#237, `git show 84bbb0eb`), poza dokumentacją: `types.ts`, `providers/fake*.ts`, `config.ts`, kompozycje, `lesson-drafts.ts`, `lesson-api.ts`, `agent-policy.ts`, `domain/lessons/agent/*` (także ich testy), `pool-validation.ts`, `providers/openai/llm.test.ts`, `tests/probes/agent-generation.probe.test.ts`, `tests/integration/fakes.ts`.
- Kod po angielsku, komentarze i dokumentacja po polsku, gęstość komentarzy jak w otaczającym kodzie. Komunikaty walidatora PC po polsku, poprzedzone jednym z prefiksów: `pc-marker:`, `pc-ing:`, `pc-be:`, `pc-state:`, `pc-error-fix:`, `pc-notice:`, `pc-shape:` (spec §8).
- Prywatność: żadnych nowych przepływów danych do modeli; testy na fikcyjnych danych.
- Testy jednostkowe: `pnpm exec vitest run --config vitest.unit.config.ts <ścieżki>`. Po każdym zadaniu `pnpm typecheck` przechodzi. Migawki wyłącznie inline (`toMatchInlineSnapshot`).
- Integracja: `pnpm test:integration [<plik>]` (na tej gałęzi nie ma `test:integration:shards`).
- Commity po polsku, zakończone `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Ścieżki skrótowe: `G = packages/server/src/domain/lessons/subjects/english-grammar`, `E = packages/server/src/domain/lessons/subjects/english`, `L = packages/server/src/domain/lessons`.

**Zatrzymaj się i zapytaj właściciela, gdy:** reguła ze specu odrzuca przykład, który spec podaje jako poprawny (albo odwrotnie); zmiana §6.7 zmienia oczekiwania testu spoza listy w Task 9; test wymaga zmiany pliku z listy PR 2; rebase daje konflikt poza dokumentacją; sonda nie spełnia kryteriów po dozwolonym strojeniu; po sondzie potrzebna jest zmiana walidatora albo promptu.

## Review Focus

1. **Odpowiedź dziecka ze skrótem lub inną pisownią** („He's playing”, „he is playing”, „isnt watching”, „is not watching”, bez kropki, wielkie litery) przy kluczu z pełnym „is” — oczekiwane zaliczenie; samo „playing” — niezaliczone. Test w Task 7b.
2. **Zdanie po odpowiedzi i nagranie TTS luki z nawiasem**, także w istniejącej lekcji Present Simple — oczekiwane „He goes to school.” bez „(go)”, a bariera historyjki wykrywa kolizję. Test w Task 9.
3. **Istniejące tematy PS i to_be po zawężeniu promptu i wydzieleniu plików** — oczekiwane identyczne zachowanie walidatora i tylko zamierzony diff promptu. Testy w Task 3 (istniejące testy bez zmian) i Task 10 (migawka inline).
4. **Podmiot zdania inny niż zaimek tuż przed luką** („Łucja ___”, „The children ___”, „Tom and Ola ___”, „They always ___”, „Every day Ola ___”, „What ___ they doing?”) — oczekiwane poprawne `is`/`are`, bez fałszywych odrzuceń. Testy w Task 4 i Task 6.
5. **Nawias poza miejscem tuż po luce** (bodziec wyboru, „posłuchaj i wybierz”) — oczekiwane odrzucenie, bo lektor przeczytałby nawias. Test w Task 6.

---

### Task 1: Tabela form -ing i czasowniki stanu

**Files:**
- Create: `E/ing-forms.ts`, `E/ing-forms.test.ts`

**Interfaces:**
- Produces:
  - `export type IngRule = "plain" | "drop_e" | "double" | "ie_to_y" | "other";`
  - `export function ingFormOf(base: string): string | undefined`
  - `export function ingRuleOf(base: string): IngRule | undefined`
  - `export function baseOfIngForm(form: string): string | undefined`
  - `export function isIngFormInTable(token: string): boolean`
  - `export function ingVerbsByRule(rules: readonly IngRule[]): readonly string[]` (formy podstawowe w kolejności tabeli; do promptu)
  - `export const STATE_VERBS: ReadonlySet<string>` (lista specu §5.3, bez „be”)
  - `export function stateVerbIn(text: string, mode: "any_form" | "ing_form"): string | undefined` — pierwszy czasownik stanu w tekście (forma podstawowa), z wyjątkami §5.3; dodatkowo „being” → `"be"` w obu trybach; `undefined`, gdy brak.
  - `export function isCollocationIngForm(tokens: readonly string[], index: number): boolean` — `true` dla „having” + breakfast | lunch | dinner | a bath | a shower | fun | a party oraz „looking” + at | for (spec §4, wyjątek poza tabelą).

- [ ] **Step 1: Testy (czerwone)** w `ing-forms.test.ts`:
  ```ts
  it("klasy reguł pisowni", () => {
    expect([ingFormOf("play"), ingRuleOf("play")]).toEqual(["playing", "plain"]);
    expect([ingFormOf("do"), ingRuleOf("do")]).toEqual(["doing", "plain"]);
    expect([ingFormOf("write"), ingRuleOf("write")]).toEqual(["writing", "drop_e"]);
    expect([ingFormOf("swim"), ingRuleOf("swim")]).toEqual(["swimming", "double"]);
    expect([ingFormOf("lie"), ingRuleOf("lie")]).toEqual(["lying", "ie_to_y"]);
    expect([ingFormOf("travel"), ingRuleOf("travel")]).toEqual(["travelling", "other"]);
    expect([ingFormOf("fix"), ingFormOf("jump")]).toEqual(["fixing", "jumping"]);
  });
  it("czasownik spoza tabeli i czasowniki stanu → undefined", () => {
    expect(ingFormOf("photosynthesise")).toBeUndefined();
    expect(STATE_VERBS.has("be")).toBe(false);
    for (const verb of STATE_VERBS) expect(ingFormOf(verb), verb).toBeUndefined();
  });
  it("odwrotność i rozpoznanie formy -ing", () => {
    expect(baseOfIngForm("running")).toBe("run");
    expect(isIngFormInTable("swimming")).toBe(true);
    for (const word of ["morning", "sing", "thing", "evening", "having"]) expect(isIngFormInTable(word), word).toBe(false);
  });
  it("liczności: tabela ≥ 70, plain/drop_e/double ≥ 5, ie_to_y ≥ 2", () => { /* przez ingVerbsByRule */ });
  it("stateVerbIn: formy i wyjątki", () => {
    expect(stateVerbIn("She likes apples every day.", "any_form")).toBe("like");
    expect(stateVerbIn("I am liking it.", "ing_form")).toBe("like");
    expect(stateVerbIn("She is reading now.", "any_form")).toBeUndefined();
    expect(stateVerbIn("She is having lunch now.", "any_form")).toBeUndefined();
    expect(stateVerbIn("She has breakfast every day.", "any_form")).toBeUndefined();
    expect(stateVerbIn("He is looking at the stars.", "any_form")).toBeUndefined();
    expect(stateVerbIn("Look! Tom is running.", "any_form")).toBeUndefined();
    expect(stateVerbIn("She has a dog.", "any_form")).toBe("have");
    expect(stateVerbIn("I know it now.", "any_form")).toBe("know");
    expect(stateVerbIn("He is being silly.", "ing_form")).toBe("be");
  });
  it("isCollocationIngForm", () => {
    expect(isCollocationIngForm(["she", "is", "having", "lunch"], 2)).toBe(true);
    expect(isCollocationIngForm(["he", "is", "looking", "for", "it"], 2)).toBe(true);
    expect(isCollocationIngForm(["she", "is", "having", "a", "dog"], 2)).toBe(false);
  });
  ```
- [ ] **Step 2: Uruchom** `pnpm exec vitest run --config vitest.unit.config.ts packages/server/src/domain/lessons/subjects/english/ing-forms.test.ts` — FAIL (brak modułu).
- [ ] **Step 3: Zaimplementuj** `ing-forms.ts`: tabela `Record<string, { form; rule }>` ok. 80 czasowników czynności A1–A2 (pisownia brytyjska; `ie_to_y` tylko lie, tie; `other` tylko dla wyjątków typu travel, begin, visit), formy PS czasowników stanu przez `formsOf`/`stemsOf` z `E/inflection.ts` plus nieregularne (has), tokenizacja `normalizeTokens` z `L/normalize.ts`; wykrzyknienie „Look” — pierwszy token z „!” albo „,” w surowym tekście.
- [ ] **Step 4: Uruchom** testy z Step 2 — PASS; `pnpm typecheck` — PASS.
- [ ] **Step 5: Commit** „Gramatyka: tabela form -ing i czasowniki stanu dla Present Continuous”.

### Task 2: Wskaźniki czasu

**Files:**
- Create: `G/time-markers.ts`, `G/time-markers.test.ts`

**Interfaces:**
- Produces:
  - `export type MarkerGroup = "now" | "usually";`
  - `export interface MarkerScan { readonly groups: ReadonlySet<MarkerGroup>; readonly forbidden: readonly string[] }`
  - `export function scanTimeMarkers(text: string, lang: "en" | "pl"): MarkerScan`
  - `export const TIME_MARKER_LISTS: { readonly nowEn: readonly string[]; readonly usuallyEn: readonly string[]; readonly nowPl: readonly string[]; readonly usuallyPl: readonly string[]; readonly forbidden: readonly string[] }` — teksty do promptu (Task 10), te same, z których budowane są wzorce dopasowania.

- [ ] **Step 1: Testy (czerwone)** — listy ze specu §5.1; przypadki:
  ```ts
  const groups = (text: string, lang: "en" | "pl") => [...scanTimeMarkers(text, lang).groups].sort();
  it("angielskie grupy", () => {
    expect(groups("She is reading now.", "en")).toEqual(["now"]);
    expect(groups("Look! Dad is cooking.", "en")).toEqual(["now"]);
    expect(groups("Listen, the baby is crying.", "en")).toEqual(["now"]);
    expect(groups("They listen to music every day.", "en")).toEqual(["usually"]);
    expect(groups("I look at the board.", "en")).toEqual([]);
    expect(groups("We play football every summer.", "en")).toEqual(["usually"]);
    expect(groups("She swims three times a week.", "en")).toEqual(["usually"]);
    expect(groups("He plays tennis on Saturdays.", "en")).toEqual(["usually"]);
    expect(groups("Shh! Grandpa is sleeping.", "en")).toEqual(["now"]);
  });
  it("polskie scenki", () => {
    expect(groups("Cicho! Dziadek śpi.", "pl")).toEqual(["now"]);
    expect(groups("Ola cicho czyta wieczorami.", "pl")).toEqual([]);
    expect(groups("Gdzie jest tata?", "pl")).toEqual(["now"]);
    expect(groups("Ola zazwyczaj czyta po obiedzie.", "pl")).toEqual(["usually"]);
    expect(groups("Każdego dnia Tom jeździ na rowerze.", "pl")).toEqual(["usually"]);
    expect(groups("Teraz czy zwykle?", "pl")).toEqual(["now", "usually"]);
  });
  it("wskaźniki zakazane", () => {
    expect(scanTimeMarkers("I'm playing tennis tomorrow.", "en").forbidden).toEqual(["tomorrow"]);
    expect(scanTimeMarkers("He is swimming this afternoon.", "en").forbidden).toEqual(["this afternoon"]);
    expect(scanTimeMarkers("She plays on Saturday.", "en").forbidden).toEqual(["on saturday"]);
    expect(scanTimeMarkers("She plays on Saturdays.", "en").forbidden).toEqual([]);
    expect(scanTimeMarkers("Jutro gramy.", "pl").forbidden).toEqual(["jutro"]);
  });
  ```
- [ ] **Step 2: Uruchom** testy — FAIL.
- [ ] **Step 3: Zaimplementuj**: dopasowanie wielowyrazowych fraz po tokenach `normalizeTokens`; wykrzyknienia (Look!, Listen!, Shh!, Be quiet!, Cicho!, Ciii!, Patrz!, Popatrz!, Spójrz!, Zobacz!, Posłuchaj!, Słuchaj!) tylko jako początek surowego tekstu z „!” albo „,” po nich; „Gdzie jest/są” jako dwa pierwsze tokeny; „every”/„każdego”/„co” + rzeczownik czasu z zamkniętej listy; „N times a week/day” (N: once, twice, two…ten, cyfry).
- [ ] **Step 4: Uruchom** testy — PASS.
- [ ] **Step 5: Commit** „Gramatyka: wskaźniki czasu teraz/zwykle dla Present Continuous”.

### Task 3: Wydzielenie `be-agreement.ts` i `present-simple-forms.ts` (czyste przeniesienie)

**Files:**
- Create: `G/be-agreement.ts`, `G/present-simple-forms.ts`
- Modify: `G/validators.ts` (usuwa przeniesione definicje, importuje je)

**Interfaces:**
- Produces (eksporty, bez zmiany ciał):
  - `be-agreement.ts`: `BE_FORM_BY_SUBJECT`, `BE_FORMS`, `BE_CONTRACTED_TOKENS`, `BE_AFFIRMATIVE_CONTRACTIONS`, `looksPlural`, `beSubjectTokensBefore`, `type BeNearPronoun`, `beAnswerPronounAllowed`, `bePronounNearGap`, `expectedBeFormNearGap`, `beStemContext`, `parseBeGapAnswer`, `checkBePolarity` oraz stałe, od których zależą (`BE_DEMONSTRATIVE_FORM`, `BE_IRREGULAR_PLURALS`, `BE_S_ENDING_NAMES`, `BE_UNCOUNTABLE_S_NOUNS`, `BE_DETERMINERS`, `BE_WH_WORDS`, `BE_NON_SUBJECT_BEFORE`, `BE_AFTER_SKIP`, `BE_ADVERBS`, `BE_ANSWER_PERSONS`);
  - `present-simple-forms.ts`: `presentSimpleForms(infinitive: string): Set<string>`, `isAcceptablePresentSimpleAnswer(infinitive: string, answer: string): boolean` (z `IRREGULAR_THIRD_PERSON`, `VOWELS`; `validators.ts` ok. l. 19–72).

- [ ] **Step 1: Uruchom przed zmianą** `pnpm exec vitest run --config vitest.unit.config.ts packages/server/src/domain/lessons/subjects/english-grammar` — PASS; zapisz liczbę testów.
- [ ] **Step 2: Przenieś** definicje (`validators.ts` ok. l. 19–72 i ok. l. 144–357) bez zmiany treści; `validators.ts` importuje oba pliki. Żaden z nowych plików nie importuje `validators.ts`. Bez nowych testów.
- [ ] **Step 3: Uruchom** to samo polecenie — PASS, ta sama liczba testów; `pnpm typecheck` — PASS; `git diff --stat` pokazuje tylko przeniesienie (liczba usuniętych linii w `validators.ts` ≈ liczbie dodanych w nowych plikach plus importy).
- [ ] **Step 4: Commit** „Gramatyka: zgodność formy to be i formy Present Simple wydzielone z walidatora (bez zmiany zachowania)”.

### Task 4: Biegunowość z mapy celów i forma be w zdaniu

**Files:**
- Modify: `G/be-agreement.ts`, `G/validators.ts` (wywołania `checkBePolarity` w ścieżce `to_be`)
- Create: `G/be-agreement.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces:
  - `export type BePolarity = "affirmative" | "negative" | "any";`
  - `checkBePolarity(polarity: BePolarity, effectiveNegative: boolean, marker: string | undefined, field: string, errors: string[]): void` — zamiast `objective: string`; ścieżka `to_be` liczy `polarity` ze stałej `TO_BE_POLARITY = { affirmative_forms: "affirmative", contractions: "affirmative", negative_forms: "negative" }` (inne cele → `"any"`), a przekształcenia jak dziś (`to_affirmative` → affirmative, `to_negative` → negative, `to_question` → any).
  - `export function beAgreementInSentence(sentence: string): { readonly form: "am" | "is" | "are"; readonly expected: string | undefined } | undefined` — pierwsza forma be w zdaniu (po rozwinięciu `BE_CONTRACTED_TOKENS`) i forma wymagana przez podmiot: zdanie z tą formą zastąpioną przez „___” przechodzi przez `expectedBeFormNearGap`; `undefined`, gdy w zdaniu nie ma formy be.
  - `BE_IRREGULAR_PLURALS` rozszerzone o `mice` (dotyczy też `to_be`, zamierzone — spec §6.2).

- [ ] **Step 1: Testy (czerwone)** w `be-agreement.test.ts`:
  ```ts
  it("expectedBeFormNearGap dla podmiotów PC (bodziec po usunięciu nawiasu)", () => {
    expect(expectedBeFormNearGap("Łucja ___ a book now.")).toBe("is");
    expect(expectedBeFormNearGap("James ___ a book now.")).toBe("is");
    expect(expectedBeFormNearGap("The children ___ football now.")).toBe("are");
    expect(expectedBeFormNearGap("The mice ___ cheese now.")).toBe("are");
    expect(expectedBeFormNearGap("Tom and Ola ___ now.")).toBe("are");
    expect(expectedBeFormNearGap("They always ___ football now.")).toBe("are");
    expect(expectedBeFormNearGap("Every day Ola ___ a comic.")).toBe("is");
    expect(expectedBeFormNearGap("What ___ they doing?")).toBe("are");
  });
  it("beAgreementInSentence", () => {
    expect(beAgreementInSentence("They is playing now.")).toEqual({ form: "is", expected: "are" });
    expect(beAgreementInSentence("Look! The dogs are running.")).toEqual({ form: "are", expected: "are" });
    expect(beAgreementInSentence("Is she reading?")).toEqual({ form: "is", expected: "is" });
    expect(beAgreementInSentence("He's playing now.")).toEqual({ form: "is", expected: "is" });
    expect(beAgreementInSentence("Ola reads every day.")).toBeUndefined();
  });
  it("checkBePolarity: twierdzenie z przeczeniem i przeczenie bez not", () => {
    const errors: string[] = [];
    checkBePolarity("affirmative", true, undefined, "answer", errors);
    checkBePolarity("negative", false, undefined, "answer", errors);
    checkBePolarity("any", true, "yes", "answer", errors);
    expect(errors).toHaveLength(3);
  });
  ```
  Jeśli któryś przypadek `expectedBeFormNearGap` nie przechodzi na obecnej heurystyce, popraw heurystykę w `be-agreement.ts` i sprawdź, że testy `to_be` nadal przechodzą; zmianę opisz w commicie.
- [ ] **Step 2: Uruchom** — FAIL.
- [ ] **Step 3: Zaimplementuj** sygnatury z Interfaces.
- [ ] **Step 4: Uruchom** `be-agreement.test.ts` i cały katalog `english-grammar` — PASS (testy `to_be` bez zmian).
- [ ] **Step 5: Commit** „Gramatyka: biegunowość formy to be z mapy celów i zgodność formy w zdaniu”.

### Task 5: Katalog tematu i rejestracja

**Files:**
- Create: `G/topics/present-continuous.ts`
- Modify: `G/module.ts` (`topics: [presentSimpleV1, toBeV1, presentContinuousV1]`, komentarz modułu), `G/module.test.ts`

**Interfaces:**
- Produces: `export const presentContinuousV1: LessonTopic` — `id: "present_continuous"`, `version: 1`, `titlePl: "Present Continuous"`; cele w kolejności i z typami ze specu §3.1; karty ze specu §3.2 (2–4 na cel; szkic można wygładzić, zachowując kontrprzykłady pisowni, „write → writing (jedno t!)”, „tie → tying”, parę jedzie/jeździ i kartę z `{{examples}}` w każdym celu); `extraErrorCategories` i przypisanie kategorii z §3.3 z podpowiedziami; przekształcenia `to_negative`, `to_question`, `to_affirmative` z tekstami jak w PS.
- `descriptionEn` celów 2 i 6 zawiera zdania ze specu §7.3 (sprawdzany element = wybór czasu; `almost` z `errorCategory: null` dla błędu formy; `incorrect` z `continuous_for_habit`/`simple_for_now`/`be_plus_simple`) oraz stałe zdanie `STORY_MIX_SENTENCE = "The end-of-lesson story may mix present simple and present continuous."` (eksport z pliku tematu).

- [ ] **Step 1: Testy (czerwone)** w `module.test.ts`:
  - `TOPIC_CASES` dostaje wpis `present_continuous` z identyfikatorami `affirmative`, `now_or_usually`, `negative`, `questions`, `ing_spelling`, `now_or_usually_more` (prefiks `english_grammar.present_continuous.`) — pętla spójności obejmuje temat;
  - „rejestr udostępnia temat present_continuous@1” (wzorem testu `to_be@1`);
  - test „wersje tematów bez zmian” rozszerzony o `present_continuous: 1`, PS i to_be nadal 1;
  - `lesson_listen_choice` mają cele `affirmative`, `negative`, `questions`; nie mają `now_or_usually`, `ing_spelling`, `now_or_usually_more`;
  - cele 2 i 6 nie mają kategorii `missing_ending`, `wrong_auxiliary`, `extra_ending`; `descriptionEn` celów 2 i 6 zawiera `errorCategory: null`;
  - `STORY_MIX_SENTENCE` jest w `descriptionEn` dokładnie celów `now_or_usually` i `now_or_usually_more` (spec §9);
  - każdy cel ma 2–4 karty;
  - `validateSubject(englishGrammarSubject)` nadal `[]`.
- [ ] **Step 2: Uruchom** `module.test.ts` — FAIL.
- [ ] **Step 3: Zaimplementuj** katalog i rejestrację.
- [ ] **Step 4: Uruchom** cały katalog `english-grammar` i `packages/server/src/domain/lessons/catalog-validation.test.ts` — PASS.
- [ ] **Step 5: Commit** „Gramatyka: temat Present Continuous w katalogu (sześć celów)”.

### Task 6: Walidator PC — luka (cele 1, 3, 4, 5) i reguły wspólne

**Files:**
- Create: `G/present-continuous-validation.ts`, `G/present-continuous-validation.test.ts`
- Modify: `G/validators.ts` (gałąź `if (topic.id === "present_continuous") { errors.push(...validatePresentContinuousExercise(ex)); return errors; }` przed gałęziami `to_be` i ogólną luką, po `validateVisualPronoun`/`listenChoiceSibilantErrors`/regule promptu tłumaczenia)

**Interfaces:**
- Consumes: Task 1 (`ingFormOf`, `ingRuleOf`, `baseOfIngForm`, `isIngFormInTable`, `stateVerbIn`, `isCollocationIngForm`), Task 2 (`scanTimeMarkers`), Task 4 (`checkBePolarity`, `BePolarity`, `expectedBeFormNearGap`, `bePronounNearGap`).
- Produces:
  - `export function validatePresentContinuousExercise(ex: LessonExerciseDraft): string[]` (cel z ostatniego segmentu `ex.objectiveId`);
  - `export const PC_ALLOWED_ING_RULES: Readonly<Record<string, readonly IngRule[]>>` — klucz: cel; wartości ze specu §4;
  - `export const PC_POLARITY: Readonly<Record<string, BePolarity>>` — `{ affirmative: "affirmative", now_or_usually: "affirmative", negative: "negative", questions: "any", ing_spelling: "affirmative", now_or_usually_more: "any" }`; przekształcenie nadpisuje (spec §6.2);
  - `export function stripGapVerb(stem: string): { stem: string; verb?: string; negative: boolean }` — usuwa „(verb)” / „(not verb)” tuż po luce (wzorzec `/_{2,}\s*\(([^)]*)\)/`), zwraca czasownik i flagę „not”. Silnik ma własną kopię wzorca (Task 9), bo `domain/lessons` nie importuje przedmiotów; komentarz w obu miejscach odsyła do drugiego.

Zakres (spec §6.2, §5.1 zakazane, §5.3, §4): oba kształty luki; luka na formę be tylko w celach 1, 3, 4; nawias wyłącznie tuż po luce `lesson_gap`, nigdzie indziej i nigdy w bodźcu ani opcjach `lesson_choice`/`lesson_listen_choice` (`pc-shape:`); forma be wg `expectedBeFormNearGap(stripGapVerb(stem).stem)` (dla luki na be także `bePronounNearGap`); biegunowość wg `PC_POLARITY`/`transformId`; nawias z „not” wymagany w luce z czasownikiem w celu 3, zakazany w 1, 2, 4, 5; forma -ing z tabeli i klasy z `PC_ALLOWED_ING_RULES` albo kolokacja `isCollocationIngForm` (nie w celu 5); odpowiedź zaczynająca się apostrofem odrzucona; czasownik stanu w formie -ing i „being” odrzucone; wskaźniki zakazane we wszystkich skanowanych polach (§5.2) dla każdego typu; `hint` niepusty odrzucony.

- [ ] **Step 1: Testy (czerwone)** w `present-continuous-validation.test.ts` — helper `pcGap(objective, stem, answer, extra?)` jak `contextualGap` w `validators.test.ts`; testy przez `validateEnglishGrammarExercise(ex, presentContinuousV1)`:
  - poprawne: „He ___ (play) football now.” → „is playing”; „They always ___ (play) football now.” → „are playing”; „Łucja ___ (read) now.” → „is reading”; „The children ___ (play) now.” → „are playing”; „Tom and Ola ___ (jump) now.” → „are jumping”; „James ___ (read) now.” → „is reading”; „She ___ (not watch) TV now.” (cel 3) → „isn't watching”; osobne ćwiczenie z „is not watching”; „___ she reading a book?” (cel 4) → „Is”; „What ___ they doing?” (cel 4) → „are”; „Yes, she ___.” (bodziec „Is she reading? Yes, she ___.”, cel 4) → „is”; „He ___ (swim) now.” (cel 5) → „is swimming”; „She ___ (have) lunch now.” (cel 1) → „is having”;
  - odrzucone (z prefiksem): „He ___ (play) now.” → „are playing” (`pc-be:`); → „is play” (`pc-ing:`); `hint: "play"` (`pc-shape:`); „He ___ now.” → „is playing” bez nawiasu (`pc-shape:`); nawias dalej w zdaniu „He ___ football (play) now.” (`pc-shape:`); `lesson_choice` z bodźcem „He ___ (play) now.” (`pc-shape:`); `lesson_listen_choice` z bodźcem z nawiasem (`pc-shape:`); cel 1 „He ___ (swim) now.” → „is swimming” (`pc-ing:`); cel 5 „He ___ (play) now.” (`pc-ing:`); cel 3 luka z czasownikiem bez „not” (`pc-shape:`); cel 1 z „(not play)” (`pc-shape:`); luka na formę be w celu 5 (`pc-shape:`); odpowiedź „'m playing” (`pc-shape:`); „He ___ (play) tennis tomorrow.” (`pc-marker:`); „She ___ (like) it now.” → „is liking” (`pc-state:`); „He ___ (be) silly now.” → „is being” (`pc-state:`); czasownik spoza tabeli „(photosynthesise)” (`pc-ing:`).
- [ ] **Step 2: Uruchom** — FAIL.
- [ ] **Step 3: Zaimplementuj** zakres z opisu zadania.
- [ ] **Step 4: Uruchom** plik testów i cały katalog `english-grammar` — PASS.
- [ ] **Step 5: Commit** „Gramatyka: walidacja luk Present Continuous”.

### Task 7a: Walidator PC — całe zdania (cele 1, 3, 4, 5)

**Files:**
- Modify: `G/present-continuous-validation.ts`, `G/present-continuous-validation.test.ts`

**Interfaces:**
- Consumes: Task 4 (`beAgreementInSentence`), Task 6.

Zakres (spec §6.3, §5.4): dla `lesson_choice` (opcja poprawna), `lesson_order`, `lesson_short_answer`, `lesson_transform`, `lesson_open_answer` — każda forma be w `answer`/`acceptedAnswers` zgodna z podmiotem (`beAgreementInSentence`; przy odpowiedzi na bodziec z luką — `expectedBeFormNearGap` bodźca); po formie be forma -ing z tabeli i dozwolonej klasy albo kolokacja; brak am/is/are + forma bez -ing w odpowiedzi poprawnej; zakaz he's/she's/it's/what's/that's/there's/where's w kluczach; pytajnik tylko „What + be + podmiot + doing?”; biegunowość wg `PC_POLARITY` albo `transformId`; tłumaczenia celów 1, 3, 4, 5: `scanTimeMarkers(prompt, "pl").groups` to dokładnie `{now}`.

- [ ] **Step 1: Testy (czerwone)**:
  - poprawne: `lesson_choice` cel 1 „Look! Mum ___ dinner.” z opcjami „is cooking”/„are cooking”; `lesson_order` cel 4 „What is he doing?”; `lesson_short_answer` cel 4 z bodźcem „Is she reading?”, opcjami i kluczem „Yes, she is.”; `lesson_transform` cel 3 (`to_negative`) „He is playing now.” → „He isn't playing now.”; `lesson_transform` cel 4 (`to_question`) → „Is he playing now?”; `lesson_open_answer` cel 1 prompt „Tata teraz gotuje obiad.” → „Dad is cooking dinner now.”;
  - odrzucone: klucz „He's playing now.” (`pc-shape:`); klucz „What's he doing?” (`pc-shape:`); „Where is he going?” (`pc-shape:`); klucz „She is plays now.” (`pc-ing:`); klucz „They is playing now.” (`pc-be:`); „The dogs is running now.” (`pc-be:`); `to_negative` z odpowiedzią twierdzącą (`pc-be:`); tłumaczenie „Tata gotuje obiad.” bez wskaźnika (`pc-marker:`); `lesson_choice` z kluczem „I am liking it now.” (`pc-state:`).
- [ ] **Step 2: Uruchom** — FAIL.
- [ ] **Step 3: Zaimplementuj** zakres.
- [ ] **Step 4: Uruchom** plik testów i katalog `english-grammar` — PASS.
- [ ] **Step 5: Commit** „Gramatyka: walidacja całych zdań w Present Continuous”.

### Task 7b: Walidator PC — poprawianie błędu, „wskaż słowo”, słuchanie; testy przypinające

**Files:**
- Modify: `G/present-continuous-validation.ts`, `G/present-continuous-validation.test.ts`, `L/evaluate.test.ts`, `packages/server/src/modules/learning/lessons/lesson-materialize.test.ts`

**Interfaces:**
- Consumes: Task 6, Task 7a; `solverView` z `L/agent/solver.ts` (tylko import w teście), `validatePool` z `L/pool-validation.ts` (tylko import w teście).
- Produces: `export function errorFixRegion(statement: string, answer: string): { readonly wrong: readonly string[]; readonly right: readonly string[] } | null` — po normalizacji z rozwinięciem skrótów (`englishNormalizer`) obszar między wspólnym prefiksem a wspólnym sufiksem tokenów; `null`, gdy brak różnicy albo obszar ma więcej niż 3 tokeny po którejś stronie.

Zakres (spec §6.3, §6.5, §6.6): `error_fix` w celach 1, 3, 4 (obszar: brak be albo brak -ing / forma bez -ing po be) i 5 (forma błędna spoza tabeli, poprawna w tabeli); `lesson_notice` w celu 1 z dokładnie jednym tokenem `isIngFormInTable` równym `correctOption`; `lesson_listen_choice` z opcjami z par §6.6.

- [ ] **Step 1: Testy (czerwone)**:
  - poprawne: `error_fix` cel 1 „He playing football now.” → „He is playing football now.”; cel 1 „She is play now.” → „She is playing now.”; cel 5 „He is swiming now.” → „He is swimming now.”; `lesson_notice` cel 1 z segmentami `[["Tom","is","playing","now."],["Good","morning!"]]`, `correctOption: "playing"` (Review Focus — „morning”); `lesson_listen_choice` cel 3 „She ___ sleeping now.” z opcjami „isn't”/„aren't”;
  - odrzucone: `error_fix` „He is playing football now.” → „She is playing tennis now.” (`pc-error-fix:`); `error_fix` z dwoma odległymi obszarami różnicy (`pc-error-fix:`); notice z dwiema formami -ing (`pc-notice:`); listen_choice z opcjami „He's”/„He” (`pc-shape:`);
  - `solverView` luki celu 2 z `instructionPl: "Cicho! Dziadek śpi."`, stemem „Grandpa ___ (sleep) in the armchair.” i pustym `hint`: widok zawiera oba teksty;
  - `validatePool` puli z wyborem „Dad ___ dinner now.” i tłumaczeniem „Tata teraz gotuje obiad.” → „Dad is cooking dinner now.” nie odrzuca żadnego z nich (spec §6.3, świadomie);
  - `evaluate.test.ts` (Review Focus 1), przez `matchLessonAnswer` z `englishNormalizer`: klucz „He is playing now.” zalicza „He's playing now.”, „he is playing now”, „HE IS PLAYING NOW”; klucz „isn't watching” zalicza „is not watching” i „isnt watching”, nie zalicza „watching”; klucz „is playing” nie zalicza „playing”; klucz „Mum is cooking now.” nie zalicza deterministycznie „Mum's cooking now.” (komentarz: trafia do modelu oceniającego, spec §6.3);
  - `lesson-materialize.test.ts`: luka PC w trybie kartkówki — `stemWithGap` zawiera „(play)”, `hint` brak.
- [ ] **Step 2: Uruchom** — FAIL dla nowych reguł; testy `evaluate`, `solverView`, `validatePool` i materializacji mogą przejść od razu (przypinają zachowanie, bez zmian w tych plikach źródłowych).
- [ ] **Step 3: Zaimplementuj** zakres.
- [ ] **Step 4: Uruchom** pliki testów i katalog `english-grammar` — PASS.
- [ ] **Step 5: Commit** „Gramatyka: poprawianie błędu, wskazanie formy i słuchanie w Present Continuous”.

### Task 8: Walidator PC — cele porównania (2 i 6)

**Files:**
- Modify: `G/present-continuous-validation.ts`, `G/present-continuous-validation.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3 (`presentSimpleForms` z `present-simple-forms.ts`), 4, 6, 7a, 7b.
- Produces: `export function presentSimpleFormFor(base: string, thirdPersonSingular: boolean, negative: boolean): readonly string[]` — dopuszczalne formy PS (3. os. l.p. → forma z -s / „doesn't X” / „does not X”; inne → forma podstawowa / „don't X” / „do not X”). Osoba z `expectedBeFormNearGap` bodźca po `stripGapVerb` („is” → 3. os. l.p.).

Zakres (spec §5.2, §5.3, §5.5, §6.2, §6.3): skanowane i pominięte pola z §5.2; co najmniej jeden wskaźnik i jedna grupa (`scanTimeMarkers` na polach EN i PL); czas odpowiedzi zgodny z grupą (`now` → be + -ing; `usually` → `presentSimpleFormFor`); czasownik w nawiasie z klasy z `PC_ALLOWED_ING_RULES` także przy odpowiedzi PS; czasowniki stanu w dowolnej formie odrzucone (`stateVerbIn(..., "any_form")`); wyjątek §5.5 (`lesson_choice` z opcjami dokładnie „now” i „usually”); cel 2 tylko twierdzenia (pytajnik, „not”/„n't” → `pc-shape:`); cel 6: luka tylko w przeczeniach (nawias z „not”), pytania tylko w `lesson_choice` i `lesson_open_answer`; `error_fix` z obszarem zamiany PS ↔ PC (jedna strona to forma PS czasownika, druga be + jego -ing; strona poprawna zgodna z grupą).

- [ ] **Step 1: Testy (czerwone)**:
  - poprawne: cel 2 luka „Ola ___ (read) a comic every evening.” → „reads”; „Look! Ola ___ (read) a comic.” → „is reading”; „Every day Ola ___ (read) a comic.” → „reads”; `lesson_choice` z `instructionPl: "Cicho! Dziadek śpi."`, stem „Grandpa ___ in the armchair.”, opcje „sleeps”/„is sleeping” → „is sleeping”; wybór „now/usually” stem „Ola is reading a book.” → „now”, stem „Ola reads books.” → „usually”; „She is having lunch now.” w celu 2 — przyjęte; `error_fix` cel 2 „Look! Ola reads.” → „Look! Ola is reading.”; `error_fix` cel 6 „She isn't watching TV every morning.” → „She doesn't watch TV every morning.”; cel 6 „She ___ (not watch) TV every morning.” → „doesn't watch”; „She ___ (not watch) TV now.” → „isn't watching”; cel 6 `lesson_choice` z opcjami „Do you play football on Saturdays?”/„Are you playing football on Saturdays?” → pierwsza;
  - odrzucone: „Ola ___ (read) a comic.” bez wskaźnika (`pc-marker:`); „Look! Ola ___ (read) a comic every evening.” mieszane grupy (`pc-marker:`); „Look! Ola ___ (read).” → „reads” (`pc-marker:`); „He ___ (play) every day.” → „play” (`pc-be:` — niezgodność z osobą); wybór „now/usually” ze stemem „Ola is reading now.” (`pc-marker:`); klucz „usually” do stemu w PC (`pc-marker:`); „He ___ (swim) every day.” → „swims” w celu 2 (`pc-ing:` — klasa `double`, spec §4); cel 2 z „(not play)” (`pc-shape:`); luka na formę be w celu 2 „Look! Ola ___ reading.” i w celu 6 (`pc-shape:`); cel 2 `lesson_choice` z pytaniem (`pc-shape:`); cel 6 luka „___ you (play) tennis every Saturday?” (`pc-shape:`); cel 6 `lesson_order` z pytaniem (`pc-shape:`); „She likes apples every day.” w celu 2 (`pc-state:`); polecenie „Teraz czy zwykle?” (mieszane grupy, `pc-marker:`); `error_fix` cel 2 ze zmianą tylko podmiotu (`pc-error-fix:`).
- [ ] **Step 2: Uruchom** — FAIL.
- [ ] **Step 3: Zaimplementuj** zakres.
- [ ] **Step 4: Uruchom** pliki testów i katalog `english-grammar` — PASS.
- [ ] **Step 5: Commit** „Gramatyka: walidacja wyboru czasu teraz/zwykle w Present Continuous”.

### Task 9: Zdanie po odpowiedzi bez nawiasu przy luce (wszystkie przedmioty)

**Files:**
- Modify: `L/feedback-sentence-text.ts`, `L/feedback-sentence-text.test.ts`, `L/story.test.ts`
- Modify (tylko oczekiwania, jeśli zmienione zdanie je łamie): testy jednostkowe i integracyjne z lukami „___ (…)” (`git grep -ln "___ (" -- "*.test.ts" "*.test.tsx" "tests/"`)

**Interfaces:**
- Produces: w `feedback-sentence-text.ts` prywatna `withoutGapVerb(stem: string): string` (`/(_{2,})\s*\([^)]*\)/` → `$1`), wołana tylko w gałęzi `lesson_gap` przed `fillGap`.

- [ ] **Step 1: Testy (czerwone)** w `feedback-sentence-text.test.ts`:
  ```ts
  it("luka z czasownikiem w nawiasie: zdanie bez nawiasu", () => {
    expect(feedbackSentenceText({ exerciseType: "lesson_gap", stem: "He ___ (play) football now.", answer: "is playing" })).toBe("He is playing football now.");
    expect(feedbackSentenceText({ exerciseType: "lesson_gap", stem: "She ___ (not watch) TV now.", answer: "isn't watching" })).toBe("She isn't watching TV now.");
    expect(feedbackSentenceText({ exerciseType: "lesson_gap", stem: "He ___ (go) to school.", answer: "goes" })).toBe("He goes to school."); // istniejąca konwencja Present Simple
  });
  it("nawias dalej w zdaniu, luka bez nawiasu i wybór bez zmian", () => {
    expect(feedbackSentenceText({ exerciseType: "lesson_gap", stem: "Put ___ here (word).", answer: "it" })).toBe("Put it here (word).");
    expect(feedbackSentenceText({ exerciseType: "lesson_gap", stem: "She ___ happy.", answer: "is" })).toBe("She is happy.");
    expect(feedbackSentenceText({ exerciseType: "lesson_choice", stem: "Ola ___ (read).", options: [{ id: "a", text: "is reading" }], correctOption: "a" })).toBe("Ola is reading (read).");
  });
  ```
  oraz w `story.test.ts` (Review Focus 2): `storyCollisions` dla luki „He ___ (play) football now.” / „is playing” wykrywa zdanie historyjki „He is playing football now.”. Pola `FeedbackSentenceSource` uzupełnij zgodnie z typem.
- [ ] **Step 2: Uruchom** `pnpm exec vitest run --config vitest.unit.config.ts packages/server/src/domain/lessons/feedback-sentence-text.test.ts packages/server/src/domain/lessons/story.test.ts` — FAIL.
- [ ] **Step 3: Zaimplementuj** `withoutGapVerb`.
- [ ] **Step 4: Uruchom** `pnpm test:unit` — PASS. Testy, które padną przez nowe zdanie: zmień tylko oczekiwanie na zdanie bez nawiasu i wypisz je w commicie; padnięcie z innego powodu albo poza listą z `git grep` → zatrzymaj się i zapytaj.
- [ ] **Step 5: Uruchom** `pnpm test:integration tests/integration/lesson-sentence-audio.test.ts tests/integration/lesson-story.test.ts tests/integration/lesson-generation.test.ts` — PASS (z tą samą zasadą zmiany oczekiwań).
- [ ] **Step 6: Commit** „Lekcje: zdanie po odpowiedzi luki bez czasownika w nawiasie (wszystkie przedmioty)” — treść commitu wymienia skutki ze specu §6.7.

### Task 10: Prompty

**Files:**
- Modify: `G/prompts.ts`, `G/module.test.ts`

**Interfaces:**
- Consumes: `TIME_MARKER_LISTS` (Task 2), `ingVerbsByRule` (Task 1).
- Produces: `englishGrammarPrompts.fieldRules` z blokiem `.present_continuous.` (spec §7.2) i zawężonymi regułami PS (§7.1); w `prompts.ts` eksport `PRESENT_CONTINUOUS_PROMPT_EXAMPLES: readonly LessonExerciseDraft[]` (luka celu 1, wybór celu 2 ze scenką, wybór „now/usually”, luka celu 6) i funkcja `presentContinuousFieldRules(): string` składająca tekst bloku z list i tych przykładów (JSON w tekście = te same obiekty).

- [ ] **Step 1: Migawka przed zmianą.** Dodaj w `module.test.ts` `it("fieldRules — migawka", () => expect(englishGrammarPrompts.fieldRules).toMatchInlineSnapshot())`, uruchom (Vitest wpisuje obecny tekst) i zacommituj osobno „Testy: migawka reguł promptu gramatyki”. Diff migawki w commicie z Step 6 pokazuje dokładnie zmianę promptu.
- [ ] **Step 2: Testy (czerwone)** w `module.test.ts`:
  - zdania o luce PS i operatorze zaczynają się od „For objectives whose id contains '.present_simple.'” (regex na fragment „present simple form of that base verb”);
  - blok PC zawiera: „'.present_continuous.'”, „hint null”, „Look!”, „every day”, „tomorrow”, „play”, „swim”, „What + am/is/are”;
  - każdy element `PRESENT_CONTINUOUS_PROMPT_EXAMPLES` przechodzi walidator przedmiotu (`validateEnglishGrammarExercise(ex, presentContinuousV1)` → `[]`), a `presentContinuousFieldRules()` zawiera `JSON.stringify` każdego przykładu.
- [ ] **Step 3: Uruchom** — FAIL.
- [ ] **Step 4: Zaimplementuj** zmiany promptu; zaktualizuj migawkę (`-u`) i przejrzyj diff: bloki PS i `to_be` różnią się tylko zawężeniem (Review Focus 3).
- [ ] **Step 5: Uruchom** katalog `english-grammar` i `pnpm test:unit` — PASS.
- [ ] **Step 6: Commit** „Gramatyka: prompty Present Continuous i zawężenie reguł Present Simple”.

### Task 11: Dokumentacja

**Files:**
- Modify: `docs/SPEC.md` (oba miejsca z listą tematów w części o lekcjach, ok. l. 779 i 784; rekomendacja wyboru celów ze specu §3.1), `docs/folder-structure.md` (nowe pliki: `english/ing-forms.ts`, `english-grammar/time-markers.ts`, `be-agreement.ts`, `present-simple-forms.ts`, `present-continuous-validation.ts`, `topics/present-continuous.ts`), `docs/architecture.md` §19 (jedno zdanie o zdaniu po odpowiedzi luki bez nawiasu), `.kiro/specs/grammar-module/requirements.md` i `design.md` (tylko jeśli wymieniają tematy — `git grep -n -e "to be" -e "to_be" -- .kiro/specs/grammar-module`).

- [ ] **Step 1: Edytuj** dokumenty; teksty po polsku, bez obietnic v2 poza odnośnikiem do #280.
- [ ] **Step 2: Sprawdź** `git grep -n "Present Simple oraz czasownik" docs` — brak starego brzmienia listy tematów.
- [ ] **Step 3: Commit** „Dokumentacja: temat Present Continuous”.

### Task 12: Kontrola po części domenowej

- [ ] **Step 1: Uruchom** `pnpm check` — PASS (typecheck, unit, build).
- [ ] **Step 2: Uruchom** `pnpm test:integration` (pełny, ok. 7 min, w tle) — PASS.
- [ ] **Step 3: Sprawdź stan PR 2 etapu 3:** `gh pr list --state all --search "etap 3 #237 PR 2" --json number,state,title,mergedAt` (w razie wątpliwości `gh pr view <nr>`). Scalony → Task 14A; nie → Task 14B.

### Task 13: Przegląd części domenowej przez trzech krytyków (przed sondą)

- [ ] **Step 1:** Trzech niezależnych krytyków na `git diff origin/main...HEAD` (dostają diff i spec, nie wnioski implementera): (a) poprawność walidatora i zgodność ze specem, (b) dydaktyka kart, podpowiedzi i promptu, (c) regresje istniejących tematów i skutki §6.7.
- [ ] **Step 2:** Poprawki → commity; `pnpm check` — PASS. Uwagi odrzucone — z uzasadnieniem w raporcie dla właściciela.

### Task 14A: Test integracyjny na ścieżce agenta (po PR 2)

**Files:**
- Create: `tests/integration/lesson-present-continuous.test.ts`
- Modify: `tests/integration-buckets.ts` (nowy plik do najlżejszego kosza; pilnuje `integration-buckets.test.ts`)

Wzorce: helper `agentWorld` (`tests/integration/lesson-agent-generation.test.ts` ok. l. 312–345), minima z `lessonPoolMinimums` (`L/lesson-coverage.ts`), odczyt tekstu nagrania przez `metadata->>'text'` (`tests/integration/lesson-sentence-audio.test.ts`), baza przez `testDatabaseUrl()`.

- [ ] **Step 1: Rebase** `git rebase origin/main`; konflikty tylko w dokumentacji — inaczej zatrzymaj się i zapytaj; `pnpm check` — PASS.
- [ ] **Step 2: Test (czerwony):** lekcja `present_continuous` z celami `affirmative` i `now_or_usually`; fake-agent ze skryptowanymi krokami (API z `providers/fake-lesson-agent.ts` po PR 2) z ręcznie napisanymi ćwiczeniami spełniającymi `lessonPoolMinimums` obu celów i walidator PC; przebieg: generowanie → szkic (wszystkie ćwiczenia przyjęte, zero odrzuceń) → publikacja → sesja dziecka; asercje: karty celu 1 przed ćwiczeniami, ćwiczenie celu 2 wydane w sesji, tekst nagrania zdania po odpowiedzi luki to „… is playing football now.” bez „(play)”.
- [ ] **Step 3: Uruchom** `pnpm test:integration tests/integration/lesson-present-continuous.test.ts` — przy brakach w fixture'ach FAIL z komunikatem walidatora; popraw fixture'y, nie walidator, chyba że komunikat wskazuje błąd reguły (wtedy zatrzymaj się i zapytaj).
- [ ] **Step 4: Uruchom** ponownie — PASS; `pnpm exec vitest run --config vitest.unit.config.ts tests/integration-buckets.test.ts` — PASS.
- [ ] **Step 5: Commit** „Testy: lekcja Present Continuous od generowania do sesji dziecka”.

### Task 14B: Test integracyjny na obecnej ścieżce (PR 2 nie scalony)

Jak Task 14A bez Step 1, z różnicą: fake-agent ze skryptem z obecnego `fake-lesson-agent.ts`, a w teście przedmiot `english_grammar` na liście przedmiotów agenta przez `agentWorld(["english_grammar"], …)`. Po scaleniu PR 2: rebase, dostosuj test do API po PR 2, `pnpm check` i ten plik — PASS, osobny commit „Testy: lekcja Present Continuous na agencie po etapie 3”.

### Task 15: Sonda na prawdziwym modelu (bramka zgody)

**Files:**
- Create: `tests/probes/fixtures/present-continuous-objectives.json` (zrzut zagadnień w kształcie wejścia `UMIEM_PROBE_AGENT_OBJECTIVES_DUMP`: `subjectId: "english_grammar"`, `topicId: "present_continuous"`, `topicVersion: 1`, `topicTitle`, `material` — fikcyjny fragment słownictwa podręcznika A1 z czasownikami czynności, `objectives` sześciu celów z `id`, `title`, `descriptionEn`, `cards: []` — karty bierze katalog), `tests/probes/fixtures/present-simple-objectives.json` (to samo dla `present_simple`, ten sam materiał), `tests/probes/present-continuous-stats.ts`, `tests/probes/present-continuous-stats.test.ts`
- Modify: `vitest.unit.config.ts` (dopisz `tests/probes/present-continuous-stats.test.ts` do `include`)

**Interfaces:**
- Produces:
  - `export interface PcDumpRejection { readonly objectiveId: string; readonly detail: string }`
  - `export function pcPoolStats(exercises: readonly LessonExerciseDraft[], rejections: readonly PcDumpRejection[]): { readonly sceneShare: number; readonly comparisonAccepted: number; readonly comparisonRejected: number; readonly rejectionShareComparison: number; readonly messagesByPrefix: Readonly<Record<string, number>> }` — `sceneShare`: udział przyjętych ćwiczeń celów 2 i 6 (bez kart), których `instructionPl` (dla `open_answer`: `prompt`) ma grupę z `scanTimeMarkers(..., "pl")`; `rejectionShareComparison`: odrzucone / (przyjęte + odrzucone) w celach 2 i 6; `messagesByPrefix`: `detail` dzielone po „; ”, liczone po prefiksach z Global Constraints (inne → `other`). (Zastąpione w spec §16.8 / Task 17 przez `messagesByRule`, a w §16.9 / Task 19 przez `ruleIdsByKind`.)
  - W tym samym pliku testów: test kształtu obu fixture'ów (pola wymagane przez `readObjectivesDump` sondy — prywatny w pliku PR 2, więc tu tylko kontrola kształtu) i test sterowany zmienną `UMIEM_PC_STATS_DUMP` (`it.runIf`), który wczytuje zrzut sondy (`exercises`, `rejections`) i drukuje `pcPoolStats`; bez zmiennej pomijany.

- [ ] **Step 1: Test (czerwony):** pula z 2 przyjętymi ćwiczeniami celu 2 (jedno ze scenką „Cicho!…”, jedno z „every day”) i kartą, odrzucenia `[{ objectiveId: "<cel 2>", detail: "pc-marker: …; pc-ing: …" }, { objectiveId: "<cel 1>", detail: "x" }]` → `sceneShare === 0.5`, `comparisonAccepted === 2`, `comparisonRejected === 1`, `messagesByPrefix` `{ "pc-marker:": 1, "pc-ing:": 1, other: 1 }`.
- [ ] **Step 2: Uruchom** `pnpm exec vitest run --config vitest.unit.config.ts tests/probes/present-continuous-stats.test.ts` — FAIL; zaimplementuj; PASS.
- [ ] **Step 3: Commit** „Sonda: statystyki puli Present Continuous i zrzuty zagadnień”.
- [ ] **Step 4: Punkt odniesienia PS:** `git worktree add <scratchpad>/pc-baseline <commit przed Task 10>` (tylko na czas sondy; usuń po niej).
- [ ] **Step 5: Bramka zgody.** Jedna wiadomość do właściciela: trzy przebiegi (PC; PS na bazie sprzed Task 10; PS po zmianach), polecenia, model generatora i checkera, budżet runu 0,60 USD każdy (`UMIEM_PROBE_AGENT_BUDGET_USD=0.6`), limit rejestru 2 USD, kryteria ze specu §11.3, pytanie o zrzut z wcześniejszej sondy PS (jeśli istnieje, zastępuje przebieg na bazie). Czekaj na wyraźne „tak”.
- [ ] **Step 6: Przebiegi** (po zgodzie). Ścieżki poza repo: `SCRATCH` = katalog scratchpad sesji (ustaw jawnie w poleceniu). Przykład PC:
  ```bash
  SCRATCH="<scratchpad>"; cp tests/probes/fixtures/present-continuous-objectives.json "$SCRATCH/pc-objectives.json"
  UMIEM_PROBE_AGENT_SUBJECT=grammar UMIEM_PROBE_AGENT_OBJECTIVES_DUMP="$SCRATCH/pc-objectives.json" UMIEM_PROBE_AGENT_DUMP="$SCRATCH/pc-pool.json" UMIEM_PROBE_AGENT_BUDGET_USD=0.6 UMIEM_PROBE_COSTS="$SCRATCH/costs.json" UMIEM_PROBE_COSTS_INIT=1 UMIEM_PROBE_COSTS_CAP_USD=2 pnpm probe:agent
  ```
  Przebiegi PS: ten sam rejestr bez `UMIEM_PROBE_COSTS_INIT`, zrzut `present-simple-objectives.json`, bazowy uruchomiony w worktree z Step 4. Statystyki: `UMIEM_PC_STATS_DUMP="$SCRATCH/pc-pool.json" pnpm exec vitest run --config vitest.unit.config.ts tests/probes/present-continuous-stats.test.ts`.
- [ ] **Step 7: Ocena** wg specu §11.3: minima publikacji, `rejectionShareComparison` ≤ 0,4, `sceneShare` ≥ 0,3, regresja PS ≤ +10 pp. Ślepa ocena próbki (`tests/probes/blind`: `gen-blind-sheet.cjs`, `rubric-generation.md`) przez agenta innego niż implementer — zero dwuznacznych. Raport dla właściciela.
- [ ] **Step 8: Strojenie (opcjonalne, najwyżej 2 rundy):** każda to nowy rejestr z nowym limitem i nowa zgoda; zmiana tylko w `G/prompts.ts` (i migawce), testy Task 10 — PASS, commit „Gramatyka: strojenie promptu Present Continuous po sondzie”, ponowny przebieg. Zmiana walidatora po sondzie → zatrzymaj się i zapytaj.

## Po scaleniu #281 i #282 do `main` (2026-11-06, decyzja właściciela)

Sonda z 2026-11-06 (Task 15, przebiegi na kodzie sprzed #281/#282) dała: PC 16% odrzuceń, cele 2 i 6 27,8%, scenki 30,8%, wszystkie cele kompletne; PS 23,6% → 15,3%. Ślepa ocena: w PC 2 ćwiczenia dwuznaczne tego samego typu (`lesson_error_fix` „Tom doesn't watching TV now.” — „Tom doesn't watch TV now.” też jest poprawne) i 2 graniczne; w PS 25% dwuznacznych bez znacznika „zwykle” (osobno: #288). Na `main` doszły #281 (agent puli jedynym generatorem) i #282 (katalog reguł: walidatory zwracają `LessonRuleIssue` przez `issueFrom` z literałem id, `SubjectModule.rules`, przypadki reguł `*.rule-cases.ts`, prompt z księgi reguł, `agentPolicy.typeExamples`, bez `variant_rejected`). Właściciel: scalić `main`, przenieść PC do katalogu w tym PR, potem nowa sonda. Kolejność: Task 17 → 18 → 19 → Task 15 Step 9 → Task 16.

### Task 17: Scalenie `main` i walidator PC w katalogu reguł (bez zmiany zachowania)

**Files:**
- Modify: pliki z konfliktem `git merge origin/main` (`G/module.ts`, `G/module.test.ts`, `G/prompts.ts`, `G/validators.ts`, `tests/integration-buckets.ts`, `vitest.unit.config.ts`), `G/be-agreement.ts`, `G/present-continuous-validation.ts`, `G/present-continuous-exercise-rules.ts`, `G/present-continuous-tense-choice.ts`, `G/rules.ts` (albo nowy `G/present-continuous-rules.ts` scalany do `GRAMMAR_RULES`), `G/grammar.rule-cases.ts` (albo nowy `G/present-continuous.rule-cases.ts` dopisany do importów `L/rules/rule-cases.test.ts`), testy walidatora PC, `tests/integration/lesson-present-continuous.test.ts`, `tests/probes/present-continuous-stats.ts` (+ test)

**Interfaces:**
- Consumes (z `main`): `defineRules`, `issueFrom`, `clip`, `LessonRuleIssue`, `RuleBookContext` (`L/rules/catalog.ts`); `GRAMMAR_RULES`, `grammarIssue` (`G/rules.ts`); `registerRuleCases` (`L/testing/rule-cases.ts`); `SubjectModule.validateExercise(...): readonly LessonRuleIssue[]`.
- Produces: `validatePresentContinuousExercise(ex, topic): LessonRuleIssue[]`; reguły `grammar.pc_<nazwa>` z `when: (ctx) => ctx.topicId === "present_continuous"`; `pcPoolStats(...).messagesByRule` (zamiast `messagesByPrefix`) liczone po id reguły z `detail` w postaci `[id] pole: found` (inne → `other`; zastąpione w spec §16.9 / Task 19 przez `ruleIdsByKind`).

- [ ] **Step 1: Scalenie** `git merge origin/main` (merge, nie rebase — zrecenzowane SHA zostają). Rozwiązanie konfliktów: wersja `main` + ponownie nałożone zmiany gałęzi (logika „to be” w `G/be-agreement.ts` już jako zgłoszenia `grammarIssue` z id z `main`, „mice” w l.mn., gałąź `topic.id === "present_continuous"`, temat w `module.ts`, migawka `fieldRules`, kosze, `include`). Gdy commit scalenia ma się kompilować, a PC jeszcze zwraca napisy: dopuszczalna tymczasowa reguła `grammar.pc_legacy` (opakowanie napisów, z przypadkiem w rejestrze), usunięta w Step 3. `pnpm typecheck` i testy `G/`, `L/rules/` — PASS. Commit scalenia: „Scalenie main (#281, #282) z gałęzią Present Continuous”.
- [ ] **Step 2: Test (czerwony):** w testach walidatora PC asercje przechodzą z napisów z prefiksem na id reguły (`issues.map((i) => i.rule)`), z tymi samymi przypadkami przyjęcia i odrzucenia; przypadki w rejestrze dla każdej reguły `reject` PC (wołają prawdziwy `englishGrammarSubject.validateExercise`).
- [ ] **Step 3: Implementacja:** każda gałąź `errors.push` w trzech plikach PC → `grammarIssue("grammar.pc_…", { field, pl, found })`. Jedna reguła na jedno sprawdzenie (nie na wariant komunikatu); `description` po angielsku, 1–3 zdania, liczby tylko ze stałych; `pl` = dotychczasowy komunikat bez prefiksu `pc-*:` (prefiks zastępuje id reguły); `found` po angielsku z wartością przez `clip`; `field` = ścieżka pola. Wskazówek dydaktycznych jeszcze nie przenoś (Task 18). Usuń `grammar.pc_legacy`.
- [ ] **Step 4: Test 14B i sonda:** test integracyjny na API agenta po #281 (agent jedynym generatorem); `pcPoolStats` liczy po id reguły; commit „Testy: lekcja Present Continuous na agencie po etapie 3”.
- [ ] **Step 5: Uruchom** `pnpm check` — PASS (w tym `rules.architecture.test.ts`, `rule-cases.test.ts`, migawki promptu); `pnpm test:integration:shards` — PASS. Commit „Gramatyka: reguły Present Continuous w katalogu reguł”.

Zatrzymaj się i zapytaj, gdy zachowanie walidatora PC (przyjęcie/odrzucenie) musiałoby się zmienić, żeby przejść testy `main`. Jeśli przykład typu z `L/rules/type-cards.ts` łamie regułę PC, to zakres Task 18 — opisz w raporcie.

### Task 18: Prompt PC z księgi reguł, przykłady typów PC, poprawki ze ślepej oceny

**Files:**
- Modify: `G/prompts.ts` (blok PC z `fieldRules` znika), `G/rules.ts` / `G/present-continuous-rules.ts` (opisy reguł PC i wskazówki tematu jako dopisek opisu z `when` PC, jak `TO_BE_GUIDANCE`), `G/type-examples.ts` (przykłady sześciu celów PC), `G/agent-policy.ts` (jeśli wymaga tego `typeExamples`), `packages/server/src/providers/openai/lesson-pool-prompt.test.ts` + nowa migawka `__snapshots__/lesson-pool-prompt.english_grammar_present_continuous.txt` (jak `english_grammar_to_be`, bez budżetu „przed”), test zdań promptu (dawniej 53/53), pliki walidatora PC (nowa reguła), docs: spec §16, `docs/architecture.md` §19, ten plan.

- [ ] **Step 1: Test (czerwony):** (a) księga reguł zagadnienia PC zawiera opisy reguł PC i wskazówki dydaktyczne, a księgi PS i „to be” — żadnej; (b) każdy przykład typu PC przechodzi walidację swojego celu i nie powtarza zdania z kart tematu; (c) reguła `grammar.pc_error_fix_do_ing`: `lesson_error_fix` w temacie PC, którego `statement` ma do/does/don't/doesn't/do not/does not bezpośrednio przed formą -ing („Tom doesn't watching TV now.”, „Does she reading?”), jest odrzucany we wszystkich celach (dwie poprawne poprawki); „Tom isn't watching TV now.” jako odpowiedź nadal przechodzi.
- [ ] **Step 2: Implementacja:** reguły egzekwowane opisuje katalog (`when` PC); dydaktyka bez sprawdzenia (scenki, porównanie z PS, aspekt polskiego czasownika) w dopisku opisu jednej reguły PC. Do wskazówek dopisz: `explanationPl` nazywa formę czasownika, która jest w ćwiczeniu; ćwiczenie nie powtarza podmiotu, czasownika i dopełnienia przykładu karty; tłumaczenie z „teraz” ma w `acceptedAnswers` równoważne „now / right now / at the moment”, gdy zdanie na to pozwala. `typeExamples` dla celów PC (każdy typ celu ma własne zdanie, klocki `lesson_order` bez interpunkcji końcowej).
- [ ] **Step 3: Uruchom** testy `G/`, `L/rules/`, `lesson-pool-prompt.test.ts` — PASS; zgłoś długość migawki PC.
- [ ] **Step 4: Dokumentacja:** spec §16 (port do katalogu, prefiksy → id reguł, nowa reguła, #288), architecture §19 (reguły PC w katalogu gramatyki), plan.
- [ ] **Step 5: Uruchom** `pnpm check` — PASS. Commity „Gramatyka: prompt Present Continuous z księgi reguł” i „Gramatyka: Present Continuous — poprawki po ślepej ocenie sondy”.

Wynik Task 18 (2026-11-06): listy ze stałych są dopiskami reguł, które je sprawdzają, dydaktyka — dopiskiem `grammar.pc_tense_marker_missing` (`G/present-continuous-guidance.ts`, spec §16.8; zastąpione w §16.10 / Task 19). Migawka promptu PC (`affirmative`) ma 35 389 znaków (na HEAD przed zadaniem, z blokiem w `fieldRules` i ogólnymi przykładami kart: 43 717); PS 17 577 i „to be” 21 340 znaków (na `6ab44f7e` 17 504 i 21 267 — różnica to zawężenie reguł luki do `.present_simple.`). Nowa reguła zastępuje obszar `error_fix` „do/does → forma be” celów 3 i 4 (§16.3); przypadek testu „What does he doing?” → „What is he doing?” zamieniono na „What are he doing?”.

### Task 19: Trzech krytyków po przeniesieniu do katalogu

- [ ] **Step 1:** Trzech niezależnych krytyków na `git diff origin/main...HEAD`: (a) wierność przeniesienia walidatora (żadna reguła nie zgubiona ani nie poluzowana) i nowa reguła, (b) prompt z księgi reguł i przykłady typów (dydaktyka, spójność z walidatorem, PS i „to be” bez wpływu), (c) testy, rejestr przypadków, migawki, regresje PS i „to be” po scaleniu.
- [ ] **Step 2:** Poprawki → commity; `pnpm check` — PASS.

**Task 15 Step 9 (powtórzenie sondy):** bramka zgody jak Step 5; przebiegi PC na HEAD, PS na HEAD i PS bazowo na `origin/main` (worktree w scratchpadzie); nowy rejestr z limitem 1 USD, budżet runu 0,60 USD; ocena jak Step 7, z nową ślepą oceną PC.


### Task 16: Weryfikacja całości i PR

- [ ] **Step 1: Uruchom** `pnpm check` — PASS; `pnpm test:integration` — PASS; `pnpm test:e2e:shards` — PASS (liczba testów jak w ostatnim przebiegu `origin/main`; raportuj faktyczną).
- [ ] **Step 2: Przegląd trzema niezależnymi krytykami** całej gałęzi po sondzie (ten sam podział co Task 13, plus strojenie i test integracyjny). Poprawki → commity, ponowny `pnpm check`.
- [ ] **Step 3: Push** `git push -u origin feature/present-continuous`; PR po polsku z sekcjami: zmiany; reguły i ich miejsce; zmiana §6.7 i jej skutki dla istniejących szkiców (nowe nagrania, możliwy błąd historyjki przy publikacji); wynik sondy; API → MCP → skill (bez zmian — lekcje poza MCP i `learning-overview`); wdrożenia po stronie konsumentów (brak); nowe zależności (brak); wykonane sprawdzenia; co niezweryfikowane (fizyczne urządzenie, prawdziwy TTS); rekomendacja wyboru celów; #279, #280. Zakończenie: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- [ ] **Step 4:** Scalenie wyłącznie przez właściciela, po zaakceptowanej sondzie.
