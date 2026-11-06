# Katalog reguł walidacji lekcji z opisami w prompcie agenta — plan implementacji (#237, PR 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Wersja 2, 2026-11-06, po przeglądzie trzech krytyków wersji 1 (rozstrzygnięcia na końcu).

**Goal:** Każda deterministyczna reguła, która odrzuca albo oczyszcza ćwiczenie agenta puli, ma wpis w katalogu z opisem dla modelu. Prompt agenta składa się z tych opisów, odrzucenie podaje id reguły i konkretną wartość, a trzy poluzowania (podpowiedź, cytaty, warianty) działają zgodnie ze spec.

**Architecture:**
- **Katalogi reguł.** Czyste dane w domenie: rdzeń i lekcja w `domain/lessons/rules/`, wspólny fragment angielski w `subjects/english/rules.ts`, przedmioty w `subjects/<przedmiot>/rules.ts`. Katalog przedmiotu podpina pole `SubjectModule.rules`.
- **Kształt i materializacja.** Kształt surowego rekordu agenta i materializacja przechodzą do domeny (`domain/lessons/raw-shape.ts`, `raw-materialize.ts`). Dzięki temu wszystkie przypadki reguł i przykłady kart testuje domena.
- **Zgłoszenia.** Walidatory zgłaszają `LessonRuleIssue` przez fabrykę katalogu. Publiczne funkcje dla rodzica zostają opakowaniami z dzisiejszymi polskimi napisami (`pl`).
- **Wynik dla modelu.** Przyjmowanie agenta formatuje zgłoszenia do `RuleReason`, a narzędzia składają wynik z opisami reguł.
- **Prompt.** Domenowa `lessonRuleBook` daje karty typów i reguły, które adapter renderuje.
- **Kolejność.** Każdy commit kompiluje się i jest zielony; haki przedmiotów przechodzą przez typ przejściowy w Task 2a–2c.

**Tech Stack:** TypeScript strict, Zod 4, Vitest (unit; integracja na Postgresie w kontenerze), fast-check, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-06-lesson-agent-rule-catalog-design.md` (wersja 2). Tło i raporty krytyków (stan `783f7220`/`d833e161`, numery linii przybliżone) w `C:\Users\looka\AppData\Local\Temp\claude\C--Users-looka-IdeaProjects-knowli--claude-worktrees-lesson-new-exercise-type-4e7d8f\072948fd-dbf4-49ca-8897-ff5ee18c371d\scratchpad\`: `agent-rules-audit.md`, `plan-critic-order.md`, `plan-critic-coverage.md`, `plan-critic-risk.md`.

## Global Constraints

- Gałąź `feature/lesson-agent-rule-catalog-237` (od `783f7220`, gałęzi PR 2). Nie wypychać, nie scalać, nie otwierać PR bez polecenia właściciela.
- Nigdy `npm install`; `node_modules` już jest. Bez nowych zależności (fast-check już jest), bez migracji bazy.
- Żadnych płatnych wywołań modeli: nie uruchamiać `pnpm probe:*` (sondy wczytują `.env` z kluczem).
- Kod, identyfikatory, id reguł, opisy reguł i `found`: po angielsku. Komentarze w kodzie, `pl` i dokumentacja: po polsku, w stylu otoczenia.
- Komunikaty `pl` istniejących sprawdzeń zostają znak w znak. Zbiór komunikatów, który dostaje rodzic (API edycji i publikacji), się nie zmienia, poza łagodniejszymi cytatami (spec §5.2).
- `pl` reguł dostępnych tylko agentowi (bramki, limity, ujawnienia, kontrole modelami, kształt rekordu): krótki polski opis reguły. Dzisiejszy angielski tekst dla modelu przechodzi do `found`.
- Id reguły: literał `obszar.nazwa`, tylko `[a-z0-9_.]`; argument fabryki zgłoszeń zawsze literałem napisu.
- Opisy reguł nie zawierają cyfr w literałach: liczby wyłącznie przez szablon `${STAŁA}` ze stałych sprawdzenia (kontrakt albo `domain/lessons/rules/limits.ts`). Wyjątki tylko z listy w teście z Task 10.
- Limity walidatorów potrzebne opisom żyją w liściu `domain/lessons/rules/limits.ts` (bez importów z `pool-validation.ts`); `pool-validation.ts` i katalogi importują je stamtąd. Między `types.ts` a `rules/catalog.ts` wyłącznie `import type`.
- `found` przez `clip`: nowe linie i tabulatory na spację, ≤ 120 znaków treści z `…`.
- Prywatność: logi `console.*`, dziennik `[lesson-agent]`, `rejectedReasons` i punkt kontrolny dostają tylko kody, id reguł, typy ćwiczeń i liczniki. Nigdy `found`, `pl`, treści ćwiczeń ani materiału. Bez danych dziecka gdziekolwiek.
- Granice:
  - `domain/` bez importów `modules/`, `providers/`, Drizzle i env;
  - silnik (`domain/lessons/**` poza `subjects/` i `testing/`) nie importuje `subjects/` ani nie zna id przedmiotów (`domain/lessons/architecture.test.ts`);
  - providers nie importują `modules/` (nowych importów nie dodajemy).
- Weryfikacja zadania: `pnpm typecheck` (obejmuje `tests/**`) i testy jednostkowe katalogów z listy zadania, np. `pnpm exec vitest run --config vitest.unit.config.ts packages/server/src/domain/lessons packages/server/src/modules/materials`, plus testy integracyjne wskazane w zadaniu. Po zmianie w `modules/` także `module-boundaries.architecture.test.ts`.
- Commity po polsku, z `(#237)` w tytule i stopką `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nigdy gołe `git stash`.

## Review Focus

1. Rekord agenta z `null` albo obcym typem w zagnieżdżonych polach (`requiredElements: null`, `sourceRefs: [null]`, `pairs: [["a","b"]]`, `calculation: "x"`) → zgłoszenie `shape.*` z polem, bez wyjątku. Losowy JSON w `submit` nigdy nie rzuca (Task 5, Task 7).
2. Materiał w NFD, z `\r\n`, twardymi spacjami, `…` i cytatem przez koniec wiersza → dopasowanie po normalizacji i zapisany fragment materiału, który sam przechodzi walidację i limit długości; inaczej zostaje cytat modelu (Task 6).
3. Paczka, w której pytanie otwarte odpada, a jego słowa kluczowe idą w tym samym wywołaniu → reguła `school.keywords_family_rejected` (Task 6, Task 7).
4. `found` z długim tekstem, nową linią albo cudzysłowem w środku → jedna linia, ≤ 120 znaków treści, bez rozbicia formatu powodu (Task 1, Task 7).
5. Szkic zapisany przed zmianą z kodami `hint_reveals_answer` i `variant_rejected` w `rejectedReasons` → panel dalej pokazuje ich polskie etykiety (Task 6 i Task 7 aktualizują skan kodów; test etykiet w Task 7).
6. Punkt kontrolny zapisany przed zmianą → dalej się wczytuje (Task 5).

---

### Task 1: Fundament katalogu reguł

**Files:**
- Create:
  - `packages/server/src/domain/lessons/rules/{catalog.ts,catalog.test.ts,limits.ts,core-rules.ts,lesson-rules.ts}` (katalogi rdzenia i lekcji puste);
  - `packages/server/src/domain/lessons/testing/rule-cases.ts` (rejestr przypadków; katalog `testing/` jest zwolniony z testu silnika);
  - `packages/server/src/domain/lessons/rules/rule-cases.test.ts`;
  - `packages/server/src/domain/lessons/subjects/{english,school,english-grammar,english-chapter}/rules.ts` (puste).
- Modify:
  - `domain/lessons/types.ts` (`SubjectModule.rules`);
  - `domain/lessons/catalog-validation.ts` (`validateSubject`: obecność `rules`, kolizje z rdzeniem i lekcją);
  - `domain/lessons/registry.ts` (`createSubjectRegistry`: kolizje między przedmiotami);
  - `subjects/*/module.ts`;
  - fikstury z ręcznie budowanym `SubjectModule` (`git grep -nE "agentPolicy:" -- packages/server/src tests`, m.in. `testing/agent-test-subject.ts`, `testing/history-like-subject.ts`, `testing/test-agent-policy.ts`).
- Modify: `packages/contracts/src/lessons.ts` — eksport stałych zamiast literałów schematu, bez zmiany zachowania:
  - `MIN_REQUIRED_ELEMENTS = 1`, `MAX_REQUIRED_ELEMENTS = 6`;
  - `MAX_SUPPLEMENTARY_ELEMENTS = 4`, `MAX_COMMON_ERRORS = 4`;
  - `MAX_FAMILY_ID_LENGTH = 64`;
  - `MIN_SOURCE_REFS = 1`, `MAX_SOURCE_REFS = 3`;
  - `MAX_ELEMENT_ID_LENGTH = 40`, `MAX_GROUP_ID_LENGTH = 40`;
  - `MIN_SOURCE_QUOTE_LENGTH = 10` (dziś literał w `school/validators.ts` i `minLength: 10` w `providers/openai/lesson-pool-schema.ts`; użyj stałej w obu miejscach).

  Lokalne `MAX_OPTIONS`/`MIN_ORDER_ITEMS` kontraktu: wyeksportuj, a duplikaty w `pool-validation.ts` zastąp importem.

**Interfaces:**
- Produces (`rules/catalog.ts`):
  - `type RuleKind = "reject" | "sanitize" | "internal"`
  - `interface RuleTextContext { readonly answerMaxLength: number; readonly groundingRequired: boolean }`
  - `interface LessonRule { readonly field: string; readonly kind: RuleKind; readonly types?: readonly LessonExerciseType[]; readonly when?: (ctx: RuleBookContext) => boolean; readonly description: string | ((ctx: RuleTextContext) => string); readonly limit?: string; readonly fixedMessage?: true; readonly internalReason?: string }`
    - `limit` to nazwa stałej limitu (wymusza przypadek graniczny);
    - `fixedMessage` oznacza regułę bez `found` (np. „lesson_card is not a pool exercise”).
  - `type RuleCatalog = Readonly<Record<string, LessonRule>>`
  - `type RuleId = string & { readonly __lessonRule: unique symbol }`
  - `interface LessonRuleIssue { readonly rule: RuleId; readonly field: string; readonly pl: string; readonly found?: string }`
  - `function defineRules<const C extends RuleCatalog>(catalog: C): C` — rzuca przy id spoza `^[a-z0-9_]+(\.[a-z0-9_]+)+$`.
  - `function issueFrom<C extends RuleCatalog>(catalog: C): (id: keyof C & string, details: { readonly field?: string; readonly pl: string; readonly found?: string }) => LessonRuleIssue`
  - `function clip(text: string, max?: number, options?: { readonly quote?: boolean }): string` — domyślnie `max = 120`, `quote = true`.
    - nowe linie i tabulatory na spację, zwinięte spacje;
    - przycięcie do `max` znaków treści z `…`;
    - przy `quote` w `"…"`.
  - `function messagesOf(issues: readonly LessonRuleIssue[]): string[]` (zwraca `pl`)
  - `function ruleOf(subject: Pick<SubjectModule, "rules">, id: RuleId): (LessonRule & { readonly id: RuleId }) | undefined` (rdzeń ∪ lekcja ∪ przedmiot). Wołający, który nie znajdzie opisu, pomija go; test kompletności gwarantuje, że to się nie zdarza.
  - `function describeRule(rule: LessonRule, ctx: RuleTextContext, note?: string): string`
  - `const ENGINE_CATALOGS: readonly RuleCatalog[]` (rdzeń, lekcja)
  - `interface RuleBookContext { readonly exerciseTypes: readonly LessonExerciseType[]; readonly text: RuleTextContext; readonly policy: SubjectAgentPolicy; readonly listenChoice: boolean; readonly voiceTones: boolean; readonly exerciseExplanations: boolean }` (wypełniany w Task 8a)
- Produces (`testing/rule-cases.ts`):
  - `interface RuleCase { readonly rule: string; readonly violation: () => readonly LessonRuleIssue[]; readonly boundary?: () => readonly LessonRuleIssue[] }`
  - `function registerRuleCases(cases: readonly RuleCase[]): void`
  - `function allRuleCases(): readonly RuleCase[]`

  Pliki `*.rule-cases.ts` w obszarach rejestrują przypadki; `rule-cases.test.ts` importuje je wszystkie. `violation` musi wywoływać prawdziwy walidator, nigdy fabrykę zgłoszeń wprost.
- Produces: `SubjectModule.rules: RuleCatalog` (wymagane). Przedmioty mogą współdzielić fragment katalogu (`subjects/english/rules.ts`): kolizja to ten sam id z innym obiektem wpisu.

- [ ] **Step 1: Testy fundamentu (`catalog.test.ts`).**
  - `defineRules` rzuca dla `"Bad-Id"`, `"single"` i `"a..b"`.
  - `issueFrom(cat)("x.y", { pl: "p" })` daje `field` z wpisu.
  - `clip`:
    - `clip("a\nb") === '"a b"'`;
    - `clip("x".repeat(200)).length === 123`;
    - `clip("x".repeat(60), 40, { quote: false }).length === 41`.
  - `messagesOf` zwraca `pl`; `ruleOf` znajduje id przedmiotu i zwraca `undefined` dla nieznanego.
  - `describeRule`: z funkcją opisu używa `ctx.answerMaxLength` (dwa konteksty: 120 i 300); z `note` dokleja ją po spacji.
  - Typy (`@ts-expect-error`): nieistniejący klucz w fabryce, ręczne przypisanie `string` do `RuleId`.
- [ ] **Step 2: Testy rejestru (`catalog-validation.test.ts`, `registry.test.ts`).** Odrzucony jest:
  - moduł bez `rules`;
  - przedmiot z id kolidującym z rdzeniem albo z lekcją (w `validateSubject`);
  - dwa przedmioty z tym samym id i różnymi obiektami wpisu (w `createSubjectRegistry`).

  Wspólny obiekt wpisu w dwóch przedmiotach jest dozwolony.
- [ ] **Step 3: Test kompletności (`rule-cases.test.ts`).** Iteruje po `ENGINE_CATALOGS` i `rules` przedmiotów z produkcyjnego rejestru i pada, gdy:
  - reguła `reject`/`sanitize` nie ma przypadku;
  - `violation()` nie zawiera zgłoszenia z `rule === id`, niepustym `field` i (bez `fixedMessage`) niepustym `found`;
  - reguła z `limit` nie ma `boundary`, albo `boundary()` zawiera zgłoszenie tej reguły;
  - reguła `internal` nie ma `internalReason`;
  - reguła `reject`/`sanitize` ma pusty `description`.

  Test unikalności id: wszystkie katalogi razem, ten sam obiekt dozwolony.
- [ ] **Step 4: FAIL → implementacja → PASS.** Komendy: `pnpm typecheck` oraz testy `packages/server/src/domain/lessons` i `packages/contracts`.
- [ ] **Step 5: Commit** „Katalog reguł lekcji: typy, fabryka zgłoszeń, rejestr przypadków i pole rules przedmiotu (#237)”.

### Task 2a: Haki przedmiotów — typ przejściowy i szkoła

**Files:**
- Modify:
  - `domain/lessons/types.ts`: typ przejściowy `type LegacyIssue = string | LessonRuleIssue`;
  - haki: `validateExercise → readonly LegacyIssue[]`, `validatePoolExtra → ReadonlyMap<number, readonly LegacyIssue[]>`, `refineGeneratedPool.rejected[]: { exercise; issues: readonly LegacyIssue[] }`;
  - `AgentGateFinding = { readonly code: string; readonly issue: LegacyIssue }`.
- Modify: pomocnik `legacyMessages(items: readonly LegacyIssue[]): string[]` (napis albo `pl`) u wszystkich wołających:
  - `pool-validation.ts`;
  - `modules/materials/lessons/lesson-drafts.ts` (`splitByPoolExtra`);
  - `lesson-api.ts`;
  - `domain/lessons/agent/{admission.ts,status.ts,capable.ts}`.

  Ustalenia bramki dla modelu: `found ?? pl` (dziś angielski tekst bramki przechodzi do `found`).
- Modify: szkoła — `subjects/school/{validators.ts,agent-policy.ts,rules.ts}`.
- Modify (testy): `subjects/school/module.test.ts` i `agent-policy.test.ts` (przez `legacyMessages`/`messagesOf`, oczekiwane teksty bez zmian), oraz `admission.test.ts`, `capable.test.ts`, `admission.property.test.ts`, `pool-validation.test.ts`, gdzie budują haki.
- Create: `subjects/school/school.rule-cases.ts`.

**Interfaces:**
- Consumes: Task 1.
- Produces: katalog szkoły z regułami dzisiejszych sprawdzeń, m.in.:
  - `school.quote_required`, `school.quote_too_short` (`limit: "MIN_SOURCE_QUOTE_LENGTH"`), `school.quote_in_material`;
  - `school.open_required_fields`;
  - `school.family_prompt_repeated`, `school.family_answer_differs`, `school.family_elements_differ` (osobne reguły: dzisiejsze „lub” się rozdziela; `pl` każdej to dzisiejszy tekst);
  - `school.keywords_family_missing`, `school.keyword_not_in_answer`;
  - `school.calculation_family_mismatch`, `school.v3_field_type`;
  - `hint.reveals_words` (katalog szkoły, `kind: "reject"` do Task 6, który zmienia go na `sanitize`).

  Zachowanie bez zmian.
- [ ] **Step 1: Testy.** Testy szkoły przechodzą z niezmienionymi napisami. Nowe testy `found`:
  - rodzina: odpowiedź i elementy rozdzielone, obie wartości;
  - cytat spoza materiału: indeks i tekst.
- [ ] **Step 2: Przypadki reguł szkoły.**
- [ ] **Step 3: FAIL → implementacja → PASS.** Komendy: `pnpm typecheck`, testy `domain/lessons` i `modules/materials`.
- [ ] **Step 4: Commit** „Haki przedmiotów: typ przejściowy i zgłoszenia reguł szkoły (#237)”.

### Task 2b: Gramatyka i wspólny fragment angielski

**Files:**
- Modify: `subjects/english-grammar/{validators.ts,module.ts,rules.ts,agent-policy.ts}`, `subjects/english/{listen-audibility.ts,rules.ts}`.
- Modify (testy): `english-grammar/validators.test.ts`, `module.test.ts`.
- Create: `subjects/english-grammar/grammar.rule-cases.ts`, `subjects/english/english.rule-cases.ts`.

**Interfaces:**
- Consumes: Task 2a.
- Produces:
  - `english.listen_sibilant_merge` w `subjects/english/rules.ts`, współdzielony obiekt w katalogach gramatyki i rozdziału;
  - `listenChoiceSibilantErrors` zwraca `LessonRuleIssue[]`;
  - reguły `grammar.*` dzisiejszych sprawdzeń.

- [ ] **Step 1–3:** jak Task 2a dla gramatyki: testy bez zmiany napisów, przypadki reguł, FAIL → PASS.
- [ ] **Step 4: Commit** „Gramatyka: zgłoszenia reguł i wspólny fragment angielski (#237)”.

### Task 2c: Rozdział i usunięcie typu przejściowego

**Files:**
- Modify: `subjects/english-chapter/{validators.ts,agent-policy.ts,module.ts,rules.ts}` (bramki `card_word_missing`/`frame_missing`, `refineChapterPool`), `domain/lessons/types.ts` (haki: `LessonRuleIssue` zamiast `LegacyIssue`; usuń `LegacyIssue` i `legacyMessages` na rzecz `messagesOf`), wołający z Task 2a.
- Modify (testy):
  - `english-chapter/validators.test.ts` i `agent-policy.test.ts`;
  - `tests/integration/lesson-generation.test.ts` (fikstura `refineGeneratedPool` z `reason`, ok. l. 402–410);
  - `tests/integration/lesson-shape.test.ts`;
  - `tests/probes/agent-generation.probe.test.ts` (typy).
- Create: `subjects/english-chapter/chapter.rule-cases.ts`.

**Interfaces:**
- Consumes: Task 2a–2b.
- Produces:
  - reguły `chapter.card_word_missing`, `chapter.frame_missing` (kody bramki bez zmian), `chapter.word_outside_material`, `chapter.function_words_only` i pozostałe dzisiejsze;
  - haki przedmiotów zwracają wyłącznie `LessonRuleIssue`.

- [ ] **Step 1–3:** testy bez zmiany napisów, przypadki reguł. Komendy: FAIL → PASS z `pnpm typecheck`, testami `domain/lessons` i `modules/materials` oraz `pnpm test:integration tests/integration/lesson-generation.test.ts tests/integration/lesson-shape.test.ts tests/integration/lesson-chapter.test.ts`.
- [ ] **Step 4: Commit** „Rozdział: zgłoszenia reguł; haki przedmiotów bez typu przejściowego (#237)”.

### Task 3: Rdzeń — kontrakt, pola wspólne i typy tekstowe

**Files:**
- Modify:
  - `domain/lessons/rules/{core-rules.ts,limits.ts}`;
  - `domain/lessons/pool-validation.ts` (`validateLessonExercise` i pomocnicze: `validateGap`, `validateErrorFix`, `validateTransform`, `validateAcceptedAnswers`, `validateOptions`, `validateOrder`, `validateFocus`, `validateVisualSubject`, `validateTextFieldLengths`, `validateNoTextAnswers`, `validateNotice`, `validateListenChoice`);
  - `domain/lessons/exercise-explanation.ts`.
- Create: `domain/lessons/rules/core.rule-cases.ts`, `domain/lessons/pool-validation.issues.test.ts`.

**Interfaces:**
- Consumes: Task 1–2c.
- Produces:
  - `validateLessonExerciseIssues(ex, subject, topic, options?: { readonly reanalyzeEmpty?: boolean }): LessonRuleIssue[]` — `reanalyzeEmpty` używa tylko agent (Task 7);
  - `validateLessonExercise` = `messagesOf(validateLessonExerciseIssues(ex, subject, topic))`, bez ponownej analizy, z napisami jak dziś;
  - reguły (prefiksy obowiązkowe, dalszy podział dozwolony):
    - `field.empty`, `field.max_length`, `field.count`, `field.invalid`;
    - `exercise.card_not_allowed`, `exercise.unknown_objective`, `exercise.type_unsupported`, `exercise.type_not_allowed`, `exercise.v3_field_not_allowed`;
    - `answer.max_length` (opis-funkcja `answerMaxLength`), `voice_tone.not_allowed`;
    - `explanation.*` (`sanitize`);
    - `fields.type_specific`;
    - `listen.*`, `focus.empty`, `focus.not_contiguous`;
    - `choice.stem_required`, `short_answer.prompt_required`, `open.prompt_required`;
    - `options.count`, `options.duplicate`, `options.correct_unknown`;
    - `order.items_count`, `order.items_join`;
    - `gap.marker_count`, `gap.answer_tokens`, `gap.focus`;
    - `error_fix.statement_required`, `error_fix.same_as_answer`;
    - `transform.statement_required`, `transform.unknown`;
    - `variants.count`, `variants.empty`, `variants.duplicate`;
    - `notice.*`, `visual.*`;
    - `computed.no_variants` (`internal`).

- [ ] **Step 1: Testy (`pool-validation.issues.test.ts`).**
  - **Tabela Zod** (spec §4.2) na prawdziwym `safeParse`:
    - `hint: ""` → `field.empty`, `field: "hint"`;
    - `prompt` 134 znaków → `field.max_length`, `found` zawiera `134` i `120`;
    - napis za krótki z minimum > 1 i tablica za krótka → `field.count`/`field.max_length` według `origin`;
    - `commonErrors` z 6 elementami → `field.count` z `6` i `4`;
    - `questionType: "explanation"` → `field.invalid` z `"explanation"`;
    - obcy klucz, `invalid_union`, `custom` → `field.invalid`.
  - **Ponowna analiza (`reanalyzeEmpty: true`):**
    - `hint: ""` i błędny `focus` → oba zgłoszenia;
    - `field.empty` i inny błąd kontraktu → tylko kontrakt;
    - bez opcji → tylko kontrakt.
  - **Pole źródłowe zamiast `answer`:** tabela pięciu typów liczonych (pary, grupy, luki z bankiem, słowa kluczowe, rachunek), z własnym zgłoszeniem pola źródłowego i bez niego.
  - **`found`:**
    - `focus.not_contiguous`: tokeny odpowiedzi;
    - `order.items_join`: złożony tekst i odpowiedź;
    - `options.correct_unknown`: dozwolone id;
    - `gap.answer_tokens`: liczba słów i limit.
  - **Bez zmian:** `pool-validation.test.ts` przechodzi bez edycji.
- [ ] **Step 2: Przypadki reguł** z `boundary` dla reguł z `limit`.
- [ ] **Step 3: FAIL → implementacja → PASS.** Komendy: `pnpm typecheck`, testy `domain/lessons` i `modules/materials`.
- [ ] **Step 4: Commit** „Reguły rdzenia lekcji: kontrakt, pola wspólne i typy tekstowe (#237)”.

### Task 4: Rdzeń — pary, grupy, luki, słowa kluczowe, rachunki i reguły puli

**Files:**
- Modify: `pool-validation.ts` (`validateMatch`, `validateGroup`, `validateCloze`, `validateKeywords`, `validatePool`, `findDuplicateAnswers`), `domain/lessons/calculation.ts` (stała `MAX_TOLERANCE_SHARE` zamiast literału `100n`), `rules/{core-rules.ts,lesson-rules.ts,limits.ts}`.
- Create: `rules/lesson.rule-cases.ts`, dopisy do `core.rule-cases.ts` i testów.

**Interfaces:**
- Consumes: Task 1–3.
- Produces:
  - `validatePoolIssues(drafts, subject, topic, opts): { valid: …; rejected: { exercise: LessonExerciseDraft; issues: LessonRuleIssue[] }[] }`, a `validatePool` jako opakowanie (`errors = messagesOf(issues)`);
  - `calculationIssues(spec: unknown): LessonRuleIssue[]` (czysta; `computeCalculationAnswer` dalej rzuca);
  - reguły: `match.*`, `group.*`, `cloze.*`, `keywords.*`, `calculation.tolerance`, `calculation.family_slug`, `calculation.params`, `calculation.unknown_key`, `lesson.duplicate_stimulus`, `lesson.duplicate_answer`.

- [ ] **Step 1: Testy.**
  - `groupItems[3].groupId "g4"` → `found` zawiera `g1, g2`.
  - Pojedyncze `_` poza luką → `cloze.underscore_outside_gap`.
  - `calculationIssues`:
    - tolerancja dokładnie na granicy przechodzi, a ponad nią daje `calculation.tolerance` z wynikiem i limitem;
    - `templateFamilyId: "scale_distance-1"` → `calculation.family_slug`;
    - obcy klucz w `params` → `calculation.unknown_key`;
    - `tolerance: null` → `calculation.tolerance` z „null” (zamianę `null` na 0 robi materializacja w Task 5, nie walidacja).
  - Powtórzony bodziec → `lesson.duplicate_stimulus` z id lub fragmentem drugiego ćwiczenia.
  - Istniejące testy `validatePool` i `calculation.test.ts` bez zmian.
- [ ] **Step 2: Przypadki reguł.**
- [ ] **Step 3: FAIL → implementacja → PASS.** Komendy: `pnpm typecheck`, testy `domain/lessons` i `modules/materials`, `pnpm test:integration tests/integration/lesson-shape.test.ts`.
- [ ] **Step 4: Commit** „Reguły rdzenia: pary, grupy, luki, słowa kluczowe, rachunki i reguły puli (#237)”.

### Task 5: Kształt surowego rekordu i materializacja w domenie

**Files:**
- Create: `domain/lessons/raw-shape.ts` (+ test), `domain/lessons/raw-materialize.ts` (+ test), `rules/shape.rule-cases.ts`.
- Modify:
  - `rules/core-rules.ts` (reguły `shape.*`);
  - `modules/materials/lessons/lesson-drafts.ts`: `rawExerciseShapeSchema` przechodzi do `raw-shape.ts`; `isWellShapedRawExercise` zostaje łagodnym strażnikiem punktu kontrolnego, z dzisiejszą semantyką;
  - `providers/lesson-calculations.ts`, `lesson-keywords.ts`, `lesson-assignments.ts`: logika do `raw-materialize.ts`, pliki zostają opakowaniami z dzisiejszym zachowaniem (`answer: undefined`) dla `fake-lesson-pool.ts` i testu integracyjnego;
  - `modules/materials/lessons/lesson-pool-agent-tools.ts` (`parseRecord`: materializacja + kształt);
  - `providers/openai/lesson-pool-agent.ts` (adapter przestaje materializować; `materializeRawExercises` usunięte, testy przeniesione).

**Interfaces:**
- Consumes: Task 1–4.
- Produces:
  - `rawShapeIssues(raw: unknown): LessonRuleIssue[]` — zgłoszenia `shape.record` (rekord nie jest obiektem albo `exerciseType`/`objectiveId` nie są napisami) i `shape.<pole>` dla każdego pola listowego, które dziś filtruje `v3FieldsOf` albo sprawdza dzisiejszy schemat kształtu. Lista pól pochodzi z jednej stałej `RAW_LIST_FIELDS`, z której korzysta test. Przykładowe `found`: `options[0]: expected {id, text}, got a string`.
  - `materializeRawExercise(raw: unknown): { ok: true; record: Record<string, unknown> } | { ok: false; exerciseType: string; issues: LessonRuleIssue[] }`. Zasady:
    - rachunek, słowa kluczowe, pary, grupy i luki z bankiem bez napisu `answer` są materializowane;
    - rekord z napisem `answer` przechodzi bez zmian (idempotencja: model w tych gałęziach nie wysyła `answer`, fake i testy wysyłają rekordy gotowe);
    - `tolerance: null` = brak pola (0);
    - pola, które dziś materializacja pomija, pomija dalej — jawny wyjątek z testem (zmiana treści dla dziecka wymagałaby decyzji właściciela).
  - `parseRecord`:
    - `shape.record`/`shape.*` z kodem `shape_malformed`;
    - `shape.objective_id` z kodem `shape_objective`;
    - zgłoszenia materializacji z kodem `shape_malformed`.

  Do Task 7 `parseRecord` wkłada do `Rejection.reasons` `found ?? pl` (dzisiejszy kształt `Rejection`).

- [ ] **Step 1: Testy.**
  - **Kształt rekordu** — test tabelaryczny po `RAW_LIST_FIELDS`, każdy przypadek z konkretnym `rule` i `field`:
    - `requiredElements: null`, `sourceRefs: [null]`, `sourceRefs: ["quote"]`;
    - `pairs: [["a","b"]]`, `calculation: "x"`;
    - `options: ["Warszawa"]`.
  - **Materializacja:**
    - tolerancja ponad limit → `calculation.tolerance` z liczbami;
    - `tolerance: null` → przyjęte z 0;
    - idempotencja: głębokie porównanie dla rekordów fake'a wszystkich typów puli (`fake-lesson-pool.ts`) i rekordów `lesson-generation.test.ts` po dwóch przebiegach.
  - **Zgodność punktu kontrolnego:** zapisany w dzisiejszym formacie (fikstura `lesson-agent-checkpoint.test.ts` plus ćwiczenia wszystkich typów po `toExerciseDraft`) wczytuje się bez zmian.
  - **Własność** (fast-check): `rawShapeIssues` i `materializeRawExercise` na dowolnym JSON nigdy nie rzucają.
- [ ] **Step 2: Przypadki reguł `shape.*`.**
- [ ] **Step 3: FAIL → implementacja → PASS.** Komendy: `pnpm typecheck`, testy `domain/lessons`, `modules/materials` i `providers`, `module-boundaries.architecture.test.ts`, `pnpm test:integration tests/integration/lesson-agent-generation.test.ts tests/integration/lesson-generation.test.ts`.
- [ ] **Step 4: Commit** „Kształt rekordu agenta i materializacja w domenie ze zgłoszeniami reguł (#237)”.

### Task 6: Szkoła — poluzowania podpowiedzi i cytatów, rodziny, kaskada słów kluczowych

**Files:**
- Modify:
  - `subjects/school/{hint-gate.ts,hint-gate.test.ts,agent-policy.ts,agent-policy.test.ts,rules.ts,validators.ts,module.test.ts}`;
  - `domain/lessons/types.ts`: `sanitize(draft, ctx: { readonly material: string }) → { draft; removed: readonly string[]; notes?: readonly LessonRuleIssue[]; quotesSnapped?: number }`; ctx `validatePoolExtra` = `{ material: string; rejectedFamilies?: ReadonlySet<string> }`;
  - `domain/lessons/agent/admission.ts` (`sanitizeCandidate` przekazuje materiał i przenosi `notes` do `PrecheckEntry` jako `notes: readonly string[]` w formacie `found ?? pl` — pełny format w Task 7);
  - `modules/materials/lessons/lesson-agent-outcome.test.ts` (skan kodów: `hint_reveals_answer` z `known` usunięty, etykieta zostaje);
  - testy przyjmowania szkoły.
- Create:
  - `subjects/school/quote-normalize.ts` (+ test);
  - `familyBase` w `domain/lessons/keyword-families.ts` (+ `keyword-families.test.ts`; `lesson-drafts.ts` używa wspólnego formatu sufiksu).
- Test integracyjny: `tests/integration/lesson-parent-api.test.ts`.

**Interfaces:**
- Consumes: Task 1–5.
- Produces:
  - `hintRevealing(hint, draft, normalizer): { target: "answer" | "acceptedAnswer" | "requiredElement"; text: string; words: string[] } | null`. Algorytm ze spec §5.1 z `HINT_STOP_WORDS` (lista ze spec, normalizowana tym samym normalizatorem co tokeny). Zwraca dopasowanie **tylko wtedy, gdy zdradę zgłasza i dzisiejszy, i nowy algorytm** (zmiana jest wyłącznie poluzowaniem; dzisiejszy algorytm zostaje jako funkcja wewnętrzna).
  - `normalizeQuote(text: string): { text: string; map: number[] }` (`map[i]` = indeks w oryginale początku znaku znormalizowanego `i`; NFC liczone na całym tekście przed mapowaniem, granice wycinka wyrównane do pełnych grafemów, bez ucinania znaków łączących).
  - `snapQuote(quote: string, material: string): string | null`. Wycinek materiału:
    - zwinięte białe znaki, bez znaków niewidocznych;
    - `null`, gdy wycinek nie przechodzi `validateSchoolPool` jako cytat albo przekracza `MAX_SOURCE_QUOTE_LENGTH`.

    Wynik `normalizeQuote(material)` zapamiętany dla ostatniego materiału (jeden wpis).
  - `familyBase(slug, scope): string` — zdejmuje `-r<6 hex>` tylko przy znanym `scope`. Baza może być przycięta przez `scopeFamiliesToRun`; tak zostaje.
  - Reguły:
    - `hint.reveals_words` (`sanitize`; nota z celem i słowami);
    - `school.keywords_family_rejected` (`reject`, kod `lesson_extra`; pole `familyId`; wymaga `rejectedFamilies`).

    Długość minimalna cytatu liczona jak dziś (po zwinięciu białych znaków), normalizacja tylko do dopasowania.

- [ ] **Step 1: Testy bramki.**
  - Słowo elementu spoza pytania → dopasowanie z `words`.
  - Bez dopasowania:
    - słowo wspólne z pytaniem;
    - same słowa pomocnicze;
    - element złożony wyłącznie ze słów pytania.
  - „1410”: w pytaniu i odpowiedzi → bez zdrady; tylko w odpowiedzi i w podpowiedzi → zdrada.
  - Próg: 1–2 słowa → wszystkie, więcej → połowa w górę z tego, co zostało.
  - Monotoniczność: przykład z 5 słowami treściowymi, z których 3 są w pytaniu, a podpowiedź ma 2 pozostałe → bez usunięcia (dzisiejszy algorytm nie zgłasza).
  - Trzy przykłady z audytu (`agent-rules-audit.md` §2.1) z oczekiwanym wynikiem.
  - `HINT_STOP_WORDS` znormalizowane i bez duplikatów.
  - Własność: `hintRevealing` zgłasza tylko wtedy, gdy dzisiejszy algorytm zgłasza.
- [ ] **Step 2: Testy sanityzacji.**
  - Pytanie otwarte z podpowiedzią zdradzającą → brak `hint`, `removed` zawiera `hint`, `notes` z `hint.reveals_words`.
  - Typ inny niż pytanie otwarte → dzisiejsze usunięcie bez noty.
  - `exerciseGate` szkoły nie zwraca ustaleń.
  - `validateLessonExercise` (edytor rodzica) przyjmuje taką podpowiedź.
  - Sanityzacja na szkicu z błędem kontraktu nie rzuca.
- [ ] **Step 3: Testy cytatów (tabela).** Przechodzą, a `snapQuote` zwraca tekst materiału, który przechodzi walidację:
  - wielkość liter;
  - każdy znak z list cudzysłowów i myślników ze spec §5.2;
  - `…` w materiale, `...` w cytacie i odwrotnie;
  - U+00AD, U+200B–U+200D, U+FEFF, twarda spacja;
  - wiodący znacznik listy;
  - `\r\n` i podwójna spacja w materiale;
  - materiał w NFD;
  - `İ`;
  - `…` na granicy wycinka.

  Odpadają: inne słowo, brakujące słowo, inna liczba, dwa fragmenty zszyte `...`. Dalej:
  - wycinek ponad `MAX_SOURCE_QUOTE_LENGTH` → zostaje cytat modelu;
  - granica długości minimalnej jak dziś;
  - `parentAdded` bez zmian;
  - `found` reguły `school.quote_in_material` zawiera najdłuższy pasujący początek (wyszukiwanie binarne po długości);
  - porównanie treści pytań rodziny bez zmian.

  Własność (fast-check): dla fragmentu losowego materiału z losowymi zmianami typograficznymi `snapQuote` zwraca tekst, który przechodzi `validateSchoolPool` i kontrakt.
- [ ] **Step 4: Testy kaskady.** `validatePoolExtra` z `rejectedFamilies = {f}` → słowa kluczowe rodziny `f` dostają `school.keywords_family_rejected`, a słowa kluczowe bez żadnego pytania z `familyId` dostają `school.keywords_family_missing`. Testy `familyBase`: sufiks zdjęty, `scope === null` bez zmian, slug bez sufiksu bez zmian.
- [ ] **Step 5: Zapis cytatu.** `sanitize` szkoły zastępuje `quote` cytatów bez `parentAdded` wynikiem `snapQuote` (gdy różny i nie `null`) i zwraca `quotesSnapped`.
- [ ] **Step 6: Test integracyjny (`lesson-parent-api.test.ts`).**
  - Edycja i publikacja szkicu szkoły z cytatem różniącym się cudzysłowem i myślnikiem przechodzą.
  - Przy błędnym szkicu `details.exercises[].errors` to dokładnie napisy `pl` (bez `[` i bez angielskiego `found`).
  - Szkic z pustym `hint` i błędnym `focus` zwraca te same napisy co przed zmianą.
- [ ] **Step 7: Przypadki reguł.**
- [ ] **Step 8: FAIL → implementacja → PASS.** Komendy: `pnpm typecheck`, testy `domain/lessons` i `modules/materials`, `pnpm test:integration tests/integration/lesson-parent-api.test.ts tests/integration/lesson-agent-generation.test.ts`.
- [ ] **Step 9: Commit** „Szkoła: podpowiedź usuwana z notą, cytaty po normalizacji, rodziny i kaskada słów kluczowych (#237)”.

### Task 7: Przyjmowanie agenta — reguły silnika, format powodów, warianty

**Files:**
- Modify:
  - `domain/lessons/types.ts`: `SubjectAgentPolicy.ruleNotes?: Partial<Record<string, string>>`; usuń `rejectionTexts`; `promptNotes` zostaje do Task 8b.
  - Trzy `agent-policy.ts` (dzisiejsze teksty jako `ruleNotes`).
  - `rules/lesson-rules.ts`.
  - `domain/lessons/agent/{admission.ts,solver.ts,status.ts}` (eksport `checkerSteps` niepotrzebny: przypadki przez `precheckBatch`/`admitBatch`).
  - `modules/materials/lessons/lesson-pool-agent-tools.ts` (`parseRecord` i wynik — tylko dostosowanie do nowego `Rejection`; format wyniku w Task 8b).
  - Fikstury `testing/{agent-test-subject.ts,test-agent-policy.ts}`.
  - Testy:
    - `admission*.test.ts`, `capable.test.ts`;
    - `modules/materials/lessons/{lesson-pool-agent-tools.test.ts,lesson-pool-agent.test.ts,lesson-agent-outcome.test.ts}` (`variant_rejected` w skanie i w teście narzędzi);
    - `packages/contracts/src/messages.ts` (etykiety zostają).
- Create: `domain/lessons/rules/rule-reason.ts` (+ test), `rules/lesson.rule-cases.ts` (dopisy).

**Interfaces:**
- Consumes: Task 1–6.
- Produces:
  - `type RuleReason = string & { readonly __ruleReason: unique symbol }`
  - `formatRuleReason(issue: LessonRuleIssue): RuleReason` → `[<rule>] <field>: <found>` albo `[<rule>] <field>`
  - `formatVictimReason(victimLabel: string, issue: LessonRuleIssue): RuleReason` → `adding this exercise would make the lesson reject <victimLabel>: [<rule>] <field>: <found>`
  - `Rejection = { kind; code; reasons: readonly RuleReason[]; issues: readonly LessonRuleIssue[]; ruleIds: readonly RuleId[] }`
  - `PrecheckEntry` (`pass`): `notes: readonly LessonRuleIssue[]`
  - `AdmitEntry` (przyjęte): `{ accepted; sanitized; unchecked; notes: readonly LessonRuleIssue[]; removedVariants: readonly string[]; quotesSnapped: number }`
  - Reguły lekcji:
    - `lesson.leak`, `lesson.leak_source`, `lesson.limit_full`, `lesson.limit_listen`;
    - `check.blind_solve` (opis ze spec §3);
    - `check.variants` (`sanitize`);
    - `check.hint_judge` (opis odróżniony od `hint.reveals_words`);
    - `check.open_answer` (z treścią dzisiejszych `openMissing`/`openWrong`, w tym „any two”).

    Dopiski w `ruleNotes`:
    - rozdział i gramatyka: dzisiejsze `leakVictim`/`leakSource` oraz `check.blind_solve` o polskim zdaniu źródłowym i szykach;
    - szkoła: teksty sędziego i oceny.

    `ruleNotes` z kluczem spoza rdzenia i lekcji odrzuca `validateSubject`.

- [ ] **Step 1: Testy.**
  - **Format powodów:**
    - `formatRuleReason` z `found` zawierającym nową linię daje jedną linię;
    - `formatVictimReason` daje prefiks ofiary.
  - **Kody odrzucenia:**
    - reguła i ustalenie bramki → jedno odrzucenie, powody obu, kod bramki;
    - tylko reguły → `rule_exercise`;
    - błąd kontraktu → tylko kontrakt;
    - `field.empty` z `reanalyzeEmpty` → także reguły dalsze;
    - `refineGeneratedPool` odrzuca → kod `refine`;
    - kolejność powodów deterministyczna;
    - powody ofiar `lesson_pool`/`lesson_extra` w formacie `[id]`.
  - **Kaskada:** paczka z odrzuconym pytaniem otwartym rodziny `f` i jego słowami kluczowymi → `school.keywords_family_rejected` (admission buduje `rejectedFamilies` z odrzuceń bieżącej paczki).
  - **Warianty** (spec §5.3):
    - stan po przyjęciu bez wariantu;
    - część wariantów i wszystkie warianty usunięte;
    - rozwiązujący odpowiedział usuniętym wariantem → `blind_mismatch` z powodem o usuniętym wariancie (bez ponownego wywołania checkera);
    - odrzucenie podpowiedzi albo oceny wygrywa, stan bez zmian;
    - przedmiot testowy z typem w obu listach: ocena pasująca tylko przez usunięty wariant → `unchecked`;
    - powtórzone kroki deterministyczne na oczyszczonym szkicu, które odpadają → kod tego kroku (fikstura: reguła przedmiotu testowego wymagająca co najmniej jednego wariantu);
    - usunięty wariant znosi ujawnienie;
    - nota `check.variants`.
  - **Sędzia podpowiedzi:** po usunięciu podpowiedzi przez sanityzację sędzia nie jest wołany (licznik wywołań fake'a = 0).
  - **Produkcyjne przedmioty:** żaden nie ma typu jednocześnie w `variantCheckTypes` i `openAnswerCheckTypes`.
  - **Ślepe rozwiązanie:** komunikat zawiera klucz; przy parach, grupach i lukach z bankiem różnice pozycji; przy innej liczbie odpowiedzi obie liczby.
  - **Etykiety** (Review Focus 5): `messages.ts` ma etykiety `hint_reveals_answer` i `variant_rejected`, a `rejectedReasons` z tymi kodami renderuje etykiety, nie „inne powody”.
  - **`ruleNotes`:**
    - opis `lesson.leak` z dopiskiem szkoły zawiera dzisiejszy tekst `leakVictim`;
    - dopiski `check.blind_solve` są w rozdziale i gramatyce, a w szkole ich nie ma.
- [ ] **Step 2: Przypadki reguł lekcji i kontroli** (przez `precheckBatch`/`admitBatch` z fikcyjnymi `CandidateChecks`).
- [ ] **Step 3: FAIL → implementacja → PASS.** Komendy: `pnpm typecheck`, testy `domain/lessons` i `modules/materials`, `pnpm test:integration tests/integration/lesson-agent-generation.test.ts tests/integration/lesson-chapter.test.ts tests/integration/lesson-generation.test.ts`.
- [ ] **Step 4: Commit** „Przyjmowanie agenta: reguły silnika z dopiskami przedmiotów, powody z id reguł, usuwanie wariantów (#237)”.

### Task 8a: Karty typów i księga reguł (domena)

**Files:**
- Create: `domain/lessons/rules/{type-cards.ts,type-cards.test.ts,rule-book.ts,rule-book.test.ts}`.

**Interfaces:**
- Consumes: Task 1–7.
- Produces:
  - `TYPE_CARDS: Readonly<Record<LessonExerciseType, { readonly summary: string; readonly example?: (features: SubjectFeatures) => Record<string, unknown> | undefined }>>`, gdzie `SubjectFeatures = { readonly groundingRequired: boolean; readonly usesV3Payload: boolean; readonly answerLocale: string }` (wybór po cechach, nigdy po id przedmiotu).
  - `lessonRuleBook(subject: SubjectModule, ctx: RuleBookContext): RuleBook`, gdzie:
    - `RuleBook = { general: RuleLine[]; types: TypeBlock[]; lesson: RuleLine[]; checks: RuleLine[] }`;
    - `TypeBlock = { type: LessonExerciseType; summary: string; example?: string; subjectRule?: string; rules: RuleLine[] }`;
    - `RuleLine = { id: string; text: string }`.

    W bloku typu najpierw reguły z listy priorytetu `RULE_PRIORITY` (podpowiedź, cytat, rodzina, kształt rachunku), potem reszta po id. Opisy z dopiskami `ruleNotes`.
  - Reguły `when`: `groundingRequired`, `voiceTones`, `exerciseExplanations`, `listenChoice`, typy kontroli z `ctx.policy`.

- [ ] **Step 1: Testy.**
  - **Przykłady:** każdy przykład karty przechodzi `materializeRawExercise` → `rawShapeIssues` → `validateLessonExerciseIssues` dla każdego produkcyjnego przedmiotu, który ma typ. Test pada, gdy przedmiot ma typ, a karta nie dała przykładu (wyjątek tylko `lesson_card`).
  - **Księga reguł** (macierz: trzy przedmioty × każdy typ, z przydziałem `lesson_listen_choice` i bez, z tonem i bez):
    - każda pasująca reguła `reject`/`sanitize` jest w księdze;
    - reguła typu niedozwolonego nie jest;
    - reguły `internal` nie ma nigdzie;
    - kolejność według `RULE_PRIORITY`;
    - determinizm.
  - **Frazy kluczowe** dla dziesięciu punktów spec §3 „Nowe opisy”. Tabela `punkt → id reguły → fraza` w teście, np.:
    - `hint.reveals_words` zawiera „null only when”;
    - `calculation.family_slug` zawiera „scale-distance-km”.
- [ ] **Step 2: FAIL → implementacja → PASS.** Komendy: `pnpm typecheck`, testy `domain/lessons`.
- [ ] **Step 3: Commit** „Karty typów ćwiczeń i księga reguł agenta (#237)”.

### Task 8b: Prompt i wynik narzędzia z katalogu

**Files:**
- Create:
  - `providers/openai/__snapshots__/` (migawki promptu);
  - `docs/superpowers/plans/2026-11-06-lesson-agent-rule-catalog-prompt-map.md` (tabela migracji).
- Modify:
  - `.gitattributes` (`**/__snapshots__/** text eol=lf`);
  - `modules/materials/lessons/lesson-drafts.ts` (`buildPoolInput` składa wymagane `LessonPoolInput.ruleBook`);
  - `ports/ai.ts` (`LessonPoolInput.ruleBook`, `LessonAgentToolOutcome`, usunięcie `promptNotes`);
  - `modules/materials/lessons/lesson-pool-agent-input.ts`;
  - `providers/openai/llm.ts` (`renderRuleBook`, `lessonSystemPrompt`);
  - `providers/openai/lesson-pool-agent.ts` (`objectiveInstructions`);
  - `providers/openai/lesson-pool-schema.ts` (limity ze stałych, `tolerance` niewymagana);
  - `subjects/*/prompts.ts` (`fieldRules`/`typeRules` bez reguł egzekwowanych);
  - `domain/lessons/types.ts` (usuń `promptNotes`);
  - `providers/fake-lesson-pool.ts`;
  - `modules/materials/lessons/lesson-pool-agent-tools.ts` (`admittedResult`, `logRejection`, `ObjectiveToolsStats`, `submit`).
- Modify (testy):
  - `providers/openai/{llm.test.ts,lesson-pool-agent.test.ts}`;
  - `modules/materials/lessons/{lesson-pool-agent.test.ts,lesson-pool-agent-tools.test.ts}`;
  - `subjects/*/module.test.ts`;
  - `providers/{fake-lesson-agent.test.ts,lesson-agent-env.test.ts}`;
  - `tests/probes/{probe-submissions.ts,probe-submissions.test.ts}` (dostosowanie typów, bez miar).

**Interfaces:**
- Consumes: Task 1–8a.
- Produces:
  - `renderRuleBook(book: RuleBook): string` (format spec §3);
  - `LessonAgentToolOutcome`:
    - `results[]` dostaje `exerciseType: string | null` i `stimulus: string` (`clip(…, 40, { quote: false })`);
    - odrzucenie `errors: string[]` (najwyżej 6 powodów, dalej `+N more`);
    - przyjęcie `notes?: string[]` w miejsce `note`;
    - nowe pole `rules?: Readonly<Record<string, string>>` — opisy reguł użytych w wyniku, każdy id najwyżej raz na zagadnienie (pamięć w `createObjectiveTools`).
  - `ObjectiveToolsStats`: `hintsRemoved`, `variantsRemoved`, `quotesSnapped`.
  - `RejectionLogEntry`: `ruleIds`.
  - W `submit` wyniki dla modelu składane przed `args.setState`, w tej samej sekcji bez `await`.

- [ ] **Step 1: Zrzut promptu przed zmianą.** Pomocniczy, niecommitowany skrypt testowy zapisuje `objectiveInstructions` trzech przedmiotów na fiksturach testów do scratchpada sesji. Ścieżkę podaje kontroler.
- [ ] **Step 2: Tabela migracji (`…-prompt-map.md`).**
  - Każde zdanie fragmentów ze spec §3 („Co zastępuje”, „Usuwane bez odpowiednika”) → id reguły, karta typu, wskazówka zostająca albo „usunięte: <powód>”.
  - Każda asercja treści promptu w testach z listy plików → nowa asercja albo „usunięte: <powód>”.
  - W tabeli liczba asercji przed i po (grep `toContain|toMatch`).
- [ ] **Step 3: Testy.**
  - **Prompt** (spec §2.4 pkt 5): obecność księgi reguł w złożonym prompcie.
  - **Usunięte frazy potoku:** lista: „Return strict JSON”, „no markdown”, „exercises per objective in this batch”, „160-exercise”, „never exceed this batch”.
  - **`Target`** zawiera minima publikacji ze stałych.
  - **Migawki** `toMatchFileSnapshot` per przedmiot, w LF.
  - **Budżet:**
    - prompt per przedmiot ≤ długość ze Step 1 × 1,3 (liczby wpisane na sztywno, z komentarzem);
    - najgorszy wynik `submit` (10 odrzuconych ćwiczeń po 6 powodów i mapa `rules`) ≤ 12 000 znaków.
  - **Schemat narzędzia:** `minLength: 1` i `maxLength` napisów, limity list równe stałym, `tolerance` poza `required`.
  - **Wynik narzędzia:**
    - `exerciseType` i `stimulus`;
    - mapa `rules` raz na id w zagadnieniu;
    - siódmy powód jako `+N more`;
    - noty;
    - `found` rodziny bez sufiksu runu (`familyBase` w formatterze narzędzi).
  - **Liczniki:** `hintsRemoved`, `variantsRemoved`, `quotesSnapped`.
  - **Prywatność:**
    - spy `console.*`: odrzucenie z cytatem bez `found`, `pl` i treści, tylko `code`, `ruleIds`, `exerciseType`;
    - integracyjnie w `lesson-agent-generation.test.ts`: `rejectedReasons` ma tylko klucze kodów, a kolumna `agent_checkpoint` nie zawiera tekstu `found`.
  - **Własność** (fast-check): `submit` z losowym JSON nigdy nie rzuca, każde ćwiczenie ma wynik, a stan po wyjątku formatowania się nie zmienia.
- [ ] **Step 4: Przepisz asercje** według tabeli migracji.
- [ ] **Step 5: FAIL → implementacja → PASS.** Komendy: `pnpm typecheck`, testy `providers`, `domain/lessons`, `modules/materials` i `tests/probes`, `pnpm test:integration tests/integration/lesson-agent-generation.test.ts tests/integration/lesson-chapter.test.ts`.
- [ ] **Step 6: Zrzut po zmianie** do scratchpada (kontroler porównuje bloki typów jako całość).
- [ ] **Step 7: Commit** „Prompt agenta i wynik narzędzia z katalogu reguł (#237)”.

### Task 9: Gwarancje — test AST i opisy bez literałów liczb

**Files:**
- Create: `packages/server/src/domain/lessons/rules/rules.architecture.test.ts`.
- Modify: `rules/catalog.test.ts`.

**Interfaces:** Consumes Task 1–8b.

- [ ] **Step 1: Test AST** (`ts.createSourceFile`, `typescript` 5.9).
  - **Zakres:** pliki walidatorów i przyjmowania:
    - `pool-validation.ts`, `calculation.ts`, `raw-shape.ts`, `raw-materialize.ts`;
    - `subjects/**/{validators,agent-policy,hint-gate,quote-normalize,listen-audibility}.ts`;
    - `agent/{admission,solver,status}.ts`;
    - `lesson-pool-agent-tools.ts`.
  - **Zakaz:** w tablicach nazwanych `errors|issues|reasons|findings` i we właściwości `reason:` nie wolno używać literału napisu, szablonu ani spreadu wywołania spoza fabryki zgłoszeń. Wywołanie fabryki zgłoszeń musi mieć pierwszy argument będący literałem napisu.
  - **Wyjątki z uzasadnieniem w teście:**
    - `submitExamples`;
    - odmowy narzędzi (`REFUSAL_TEXT`, „exercises must be an array”, „there is no exercise”);
    - `planGate`, `objectiveGaps`;
    - `throw` w `computeCalculationAnswer`.
  - **Test czułości:** fikcyjne źródło z `errors.push("x")`, ``errors.push(`x`)``, `errors.push(...f())` i `issue(idVar, …)` jest wykrywane.
- [ ] **Step 2: Testy katalogu.**
  - Literały `description` (także w funkcjach opisu) w `rules/*.ts` i `subjects/*/rules.ts` nie zawierają cyfr; jawna lista wyjątków, np. `en-GB`, `scale-distance-km`.
  - Opisy różnych reguł nie są równe ani nie zawierają jeden drugiego.
  - `internal` tylko z listy.
  - Każdy katalog (rdzeń, lekcja, każdy przedmiot) ma ≥ 1 regułę.
- [ ] **Step 3: Uruchom.** Komendy: `pnpm typecheck`, testy `domain/lessons`. Czułość potwierdzona tymczasowym `errors.push("x")` w `pool-validation.ts`: test pada. Wstawka nie trafia do commitu.
- [ ] **Step 4: Commit** „Testy gwarancji katalogu reguł (#237)”.

### Task 10: Sonda — miary przebiegu kontrolnego

**Files:** Modify `tests/probes/{chapter-generation.probe.test.ts,probe-submissions.ts,probe-submissions.test.ts}`.

**Interfaces:** Consumes Task 8b (`notes`, `rules`, `exerciseType`, liczniki).

- [ ] **Step 1: Testy `submissionMetrics(log)`.** Zwraca:

  ```
  {
    submitted, accepted, acceptedFirstCall,
    rejectedByCode: Record<string, number>,
    rejectedByRule: Record<string, number>,
    acceptedWithNotes: Record<string, number>,
    submitCalls,
    openAnswers, openAnswersWithHint
  }
  ```

  - `acceptedFirstCall`: przyjęte w `call === 1`.
  - `openAnswersWithHint`: przyjęte `lesson_open_answer`, których wysłana wersja miała niepusty `hint`, a nota nie zawiera `[hint.reveals_words]`. Jedynym miejscem usuwania podpowiedzi pytania otwartego jest ta reguła, więc to wartość dokładna.
  - `acceptedWithNotes`: per id reguły z not.

  Koszt, tokeny i czas sonda już zapisuje; koszt na przyjęte ćwiczenie = koszt runu / `accepted`.
- [ ] **Step 2: Implementacja.**
  - Plik wyników dostaje `submissionMetrics` i liczniki `hintsRemoved`, `variantsRemoved`, `quotesSnapped`.
  - Konsola: jedna linia wyłącznie z liczbami.
- [ ] **Step 3: Uruchom** testy jednostkowe `tests/probes` (bez `pnpm probe:*`). Oczekiwany wynik: PASS.
- [ ] **Step 4: Commit** „Sonda: miary odrzuceń per kod i regułę, przyjęć z notami i podpowiedzi (#237)”.

### Task 11: Dokumentacja, pełne bramki i opis PR

**Files:** Modify `docs/architecture.md` §19.17 i `AGENTS.md`. Create (poza repo) szkic opisu PR w scratchpadzie.

- [ ] **Step 1: Dokumentacja** według spec §9. Zawiera:
  - katalog reguł, karty typów, format wyniku narzędzia i poluzowania;
  - przebieg kontrolny jako „do wykonania”;
  - świadome ograniczenia: materializacja pomija pola jak dziś; usunięty wariant nie jest pokazywany rodzicowi poza licznikami runu.
- [ ] **Step 2: Pełne bramki.**
  - `pnpm check`;
  - `pnpm test:integration`;
  - `pnpm test:e2e:shards`.

  Oczekiwany wynik: zielone. Zaktualizuj liczby testów w `AGENTS.md` tam, gdzie je podaje. `net::ERR_NO_BUFFER_SPACE` → powtórz spec osobno i odnotuj.
- [ ] **Step 3: Szkic opisu PR.** Zawiera:
  - zakres;
  - wpływ API → MCP → `SKILL.md` (brak, z uzasadnieniem);
  - poluzowania i skutek dla rodzica;
  - sprawdzenia;
  - stopkę `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

  Bez otwierania PR.
- [ ] **Step 4: Commit** „Dokumentacja katalogu reguł agenta lekcji (#237)”.

---

## Rozstrzygnięcia przeglądu wersji 1

**Przyjęte (krytycy: kolejność, pokrycie, ryzyko):**
- **Rejestr przypadków** w `domain/lessons/testing/`.
- **Kształt i materializacja w domenie:** wszystkie przypadki i przykłady testuje domena; providers bez importu `modules/`.
- **Kolejność:** haki przedmiotów zaraz po fundamencie, z typem przejściowym i podziałem 2a–2c. Dawne Task 6 i 7 scalone. `parseRecord` dostosowany w Task 5 i 7. Skan kodów i test narzędzi aktualizowane w zadaniach, które usuwają kody. Brakujący wołający i testy dopisani do zadań.
- **`pl` reguł dostępnych tylko agentowi:** krótki polski opis, a angielski tekst w `found`.
- **Wspólny fragment angielski** z dozwolonym współdzieleniem obiektu; kolizje między przedmiotami w `createSubjectRegistry`.
- **Limity w liściu `limits.ts`** (bez cyklu i strefy martwej), `import type` między typami a katalogiem; nowe stałe: długość cytatu i próg tolerancji.
- **Przykłady kart** wybierane po cechach przedmiotu.
- **`familyBase`:** użycie w formatterze narzędzi i testy.
- **Podział dawnych Task 8 i 9** na 8a i 8b (shape przeszedł do Task 5).
- **Test kompletności** z `field`, `found`, `limit` → `boundary`, opisami i unikalnością; `violation` przez prawdziwy walidator.
- **Typy znakowane** z `@ts-expect-error`; AST zabrania dynamicznych id; opisy bez cyfr w literałach.
- **Testy integracyjne API rodzica** (cytaty i dokładne `pl`); ponowna analiza po pustych napisach tylko dla agenta, więc zbiór komunikatów rodzica się nie zmienia.
- **Monotoniczna bramka podpowiedzi:** usunięcie tylko, gdy zgłaszają oba algorytmy.
- **Bezpieczne wyrównanie cytatu:** NFC, grafemy, limit długości, walidacja wyniku, test własności, pamięć normalizacji materiału.
- **`tolerance: null`** = brak pola w materializacji; `field.empty` dotyczy napisów.
- **Wynik narzędzia** składany przed `setState`; test własności `submit`.
- **Budżet** względem stanu sprzed zmiany i rozmiar najgorszego wyniku narzędzia; opisy reguł raz na zagadnienie.
- **Idempotencja materializacji** po obecności `answer`, test głęboki; zgodność starego punktu kontrolnego (łagodny strażnik zostaje).
- **Miary sondy:** dokładne `openAnswersWithHint`, `quotesSnapped`, odrzucenia per kod.
- **`lesson-chapter.test.ts`** w weryfikacji zadań 2c, 7 i 8b.
- **Migawki w LF** (`.gitattributes`); krok opisu PR.

**Odłożone / świadome:**
- **Zachowanie `explanationPl`, `hint` i `voiceTone` w materializacji par, grup i luk:** zmienia treść dla dziecka, więc wymaga decyzji właściciela. Zostaje jak dziś, z testem i notą w dokumentacji.
- **Licznik usuniętych wariantów i podpowiedzi w szkicu dla rodzica:** nowe pole produktu. Zostaje w logach runu i sondzie, w opisie PR jako propozycja.
- **Test wydajności sekcji krytycznej:** zastąpiony pamięcią normalizacji i wyszukiwaniem binarnym; czas mierzy przebieg kontrolny.
