# Agent generujący pulę lekcji — etap 1: domena, porty i kierownik — design

Data: 2026-11-04. Issue: [#237](https://github.com/lookassh/knowli/issues/237)
(cel, wyniki próby z 2026-11-03, etapy 1–4). Ten dokument obejmuje **PR
wstępny** (zdania kart w generowaniu, §5) i **etap 1**.

Decyzje właściciela (czat 2026-11-04):

- etap 1 obejmuje poprawki szkoły z issue „Do rozwiązania” pkt 1 w części
  **deterministycznej** (liczba ćwiczeń per przedmiot, bramka podpowiedzi,
  ślepe rozwiązanie i sędzia wariantów dla luk szkolnych, teksty odrzuceń per
  przedmiot); kontrole modelem w szkole (sędzia podpowiedzi, sprawdzenie
  otwartych odpowiedzi graderem) — etap 2;
- zdania angielskie wpisane w treść kart są źródłem ujawnień **wyłącznie przy
  generowaniu** (agent i dzisiejszy potok); pokrycie, publikacja, edytor i
  sesja dziecka bez zmian (issue pkt 5);
- ta zmiana potoku idzie **osobnym, małym PR przed etapem 1**;
- planer rozdziału dopuszcza **3–6** zagadnień (issue pkt 6); reguła promptu
  dzisiejszego potoku (3–5) bez zmian;
- podejście **A**: „kierownik” (równoległość, limity, budżet, później zapis) i
  wszystkie reguły żyją w naszym kodzie; AI SDK tylko prowadzi rozmowę z
  modelem; ślepe rozwiązanie i sędzia wariantów to osobny port.

Wersja 2 po review trzech krytyków (zgodność z kodem; architektura,
prywatność i koszty; cel, testy i zakres). Rozstrzygnięcia w §13.

## 1. Problem i zakres

Pulę ćwiczeń lekcji ma budować agent: model pisze ćwiczenia, kod sprawdza każde
przy zapisie i oddaje nazwany powód odrzucenia, model poprawia w tej samej
pętli. PoC (`probe/lesson-pool-agent`) pokazał przewagę w rozdziale (brak
ujawnień, pełne pokrycie materiału) i gramatyce, a w szkole wynik gorszy,
głównie przez konfigurację próby. Kod PoC żyje w jednym pliku testu próby, z
regułami ustawionymi na oko, pulą w pamięci i kilkoma rozjazdami z regułami
produkcji (walidacja tylko w obrębie zagadnienia, brak limitu słuchowego, brak
przykładów kart dla gramatyki i szkoły).

Etap 1 przenosi reguły PoC do domeny — **zgodnie z regułami potoku i
publikacji** — definiuje porty i składa kierownika, tak żeby etap 2 dodał
adapter AI SDK, zapis per zagadnienie i integrację z `executeLessonGeneration`.

**PR wstępny (§5):** hak `cardExposureTexts` i zdania kart jako stałe źródła
ujawnień w generowaniu dzisiejszego potoku.

**Etap 1 — w zakresie (jeden PR):**

1. Rdzeń domenowy `packages/server/src/domain/lessons/agent/` (§3).
2. Polityka agenta per przedmiot `SubjectModule.agentPolicy` dla
   `english_chapter`, `english_grammar` i `school` (§4).
3. Porty `LessonPoolAgentProvider` i `LessonExerciseCheckerProvider` oraz
   fake'i (§6).
4. Kierownik `runLessonPoolAgent` w `modules/materials/lessons/` — w pamięci,
   bez bazy, bez podpięcia do `executeLessonGeneration`, z hakami pod zapis per
   zagadnienie z etapu 2 (§7).
5. Wspólna sanityzacja świeżego ćwiczenia wydzielona z `acceptFreshLessonPool`
   (§7.2), bez zmiany zachowania potoku.
6. Próba `pnpm probe:agent` przepięta na rdzeń i kierownika, narzędzia ślepej
   oceny, rejestr kosztów, zrzut punktu odniesienia z potoku (§8).
7. Dokumentacja (§10).

**Poza zakresem:** produkcyjny adapter AI SDK, flaga `UMIEM_LESSON_GENERATOR`,
env agenta, `provider-config.md` i `.env.example`, integracja z
`executeLessonGeneration`, zapis per zagadnienie i wznawianie w bazie,
`UsageRecorder`/`PAID_ADAPTERS`, mapowanie statusów na `needs_review`, proces
grada dla szkoły (etap 2); pomiar odbiorczy (etap 3); usunięcie krytyka (etap
4); `sentenceCount` liczący wielokropek ramy (pkt 4) i warianty szyku (pkt 3) —
osobne zadania; zmiany w krytyku lekcji.

**Moduł i zależności.** Obszar `materials`: rdzeń w `src/domain/lessons/agent/`,
przedmioty w `src/domain/lessons/subjects/`, kierownik w
`modules/materials/lessons/`. Brak nowych zależności między obszarami. Etap 1
nie pisze do bazy; PR wstępny nie zmienia granic transakcji.

## 2. Słownik

- **Zagadnienie** — cel lekcji z kartami i przykładami kart.
- **Podagent** — pętla modelu dla jednego zagadnienia z narzędziami
  `submit_exercises` i `remove_exercise`.
- **Kierownik** — przypadek użycia: uruchamia planera i podagentów, składa ich
  narzędzia z funkcji domeny i portu checkera, pilnuje limitów i budżetu.
- **Checker** — drugi model (inna rodzina niż generator): ślepe rozwiązanie
  (rozwiązujący) i ocena wariantów odpowiedzi (sędzia).
- **Ujawnienie** — jak `findExposureLeaks`: twarde (rozwiązanie widziane
  wcześniej jako przykład karty, zdanie karty przy generowaniu albo ćwiczenie
  niesamodzielne) i miękkie (ta sama odpowiedź w innym ćwiczeniu
  samodzielnym). Twarde nie zależą od pozycji w lekcji
  (`exposure-leaks.ts:98-115`).

## 3. Rdzeń domenowy (`domain/lessons/agent/`)

Czyste funkcje nad jawnie przekazanymi danymi: bez SDK, bazy, zegara,
losowości, konfiguracji i importów z `modules/`, `providers/`, `ports/`.
Identyfikatory ćwiczeń w puli nadaje stan (`ex1`, `ex2`…), deterministycznie.
Typy współdzielone z przedmiotami (`AgentObjective`, `SubjectAgentPolicy`)
żyją w `domain/lessons/types.ts`, żeby uniknąć cyklu typów.

### 3.1. Stan

```ts
interface AgentObjective {                      // types.ts
  readonly id: string;
  readonly titlePl: string;
  readonly descriptionEn: string;
  readonly kind?: DynamicObjectiveKind;          // "words" | "frame" (rozdział)
  readonly cards: readonly { readonly title: string; readonly body: string }[];
  readonly exerciseTypes: readonly LessonExerciseType[];   // filtr requiredTypes (§3.5)
}
interface AgentPoolEntry { readonly id: string; readonly draft: LessonExerciseDraft }
interface LessonAgentState {
  readonly topic: LessonTopic;
  readonly objectives: readonly AgentObjective[];          // kolejność lekcji
  readonly pools: ReadonlyMap<string, readonly AgentPoolEntry[]>;
  /** Przykłady kart per zagadnienie (z planu albo z `submit`); trafiają do lesson_context.examples. */
  readonly examples: ReadonlyMap<string, readonly string[]>;
  /** Stałe źródła ujawnień per zagadnienie (przykłady szkicu, zdania kart); nigdy nie zapisywane. */
  readonly fixedSources: ReadonlyMap<string, readonly string[]>;
  /** Ćwiczenia szkicu i zagadnień już zapisanych: nietykalne, liczą się do walidacji, ujawnień i statusu. */
  readonly fixed: readonly LessonExerciseDraft[];
  readonly nextId: number;
}
```

`createLessonAgentState(input)` buduje stan; każda operacja zwraca nowy stan
(wejście nie jest mutowane). Kolejność lekcji (`orderedLesson(state)`):
zagadnienia w kolejności planu, w zagadnieniu ćwiczenia `fixed` i puli po
etapach (`intro`, `guided`, `productive`, `independent`, potem typy poza
ścieżką etapów) — ten sam porządek co sesja i `lessonCoverageGaps`.

### 3.2. Kontekst kontroli

```ts
type AgentCapableSubject = SubjectModule & { readonly agentPolicy: SubjectAgentPolicy };
interface AgentCheckContext {
  readonly subject: AgentCapableSubject;
  readonly material: string;
  readonly limits: ReadonlyMap<string, ObjectiveAgentLimits>;   // §3.5
}
```

`asAgentCapable(subject)` zwraca `AgentCapableSubject` albo błąd walidacji
(przedmiot bez polityki nie może być generowany agentem).

### 3.3. Przyjmowanie paczki

Wejście to szkice już po wspólnej sanityzacji kierownika (§7.2). Dla każdego
kandydata rdzeń najpierw stosuje `agentPolicy.sanitize` (np. usunięcie `hint`,
§4.4), potem `subject.refineGeneratedPool` (może odrzucić albo oczyścić, np.
usunąć warianty). Oczyszczony szkic jest tym, co widzi checker i co trafia do
puli.

**Kontrole (kroki 1–4 deterministyczne, 5–6 z checkera):**

1. **limity**: pula zagadnienia osiągnęła `maxExercises`; dla
   `lesson_listen_choice` — osiągnęła `listenAllowance` zagadnienia
   (odpowiednik `capListenChoiceOverflow`);
2. **reguły ćwiczenia**: `validateLessonExercise`, potem
   `agentPolicy.exerciseGate`;
3. **reguły lekcji**: `validatePool` na **całej lekcji**
   (`orderedLesson` z kandydatem w `exercises`, `existingExercises: []` —
   cała lekcja jest już w wejściu), potem `subject.validatePoolExtra` z
   materiałem. Kandydat odpada, gdy którakolwiek z nich odrzuca kandydata
   **albo** odrzuca ćwiczenie, którego przed wstawieniem nie odrzucała
   (porównanie zbiorów odrzuconych ćwiczeń po referencji szkicu, nie tekstów
   błędów ani liczby ważnych — wadliwe ćwiczenie `fixed` nie blokuje
   wszystkich kandydatów);
4. **ujawnienia** w trybie `coverage` (`findExposureLeaks` na
   `orderedLesson` z kandydatem; źródła: `examples` + `fixedSources`):
   kandydat odpada, gdy sam staje się ujawniony (twardo albo miękko) **albo**
   gdy ujawnia ćwiczenie dotąd nieujawnione, w tym `fixed` (jak
   `resolveGenerationLeaks`: ofiara `fixed` → odpada świeże źródło). Dzięki
   temu pule nigdy nie zawierają ćwiczeń, których pokrycie publikacji i tak
   by nie policzyło;
5. **ślepe rozwiązanie**: wynik dostępny i `blindMatches` zwraca `false`;
6. **warianty**: sędzia uznał któryś wariant `acceptedAnswers` za
   nierównoważny.

`precheckBatch(state, objectiveId, drafts, ctx)` wykonuje sanityzację i kroki
1–4, **dokładając kolejnych kandydatów do roboczego stanu** (duplikat w tej
samej paczce odpada już tutaj). Zwraca per indeks
`{ pass: true; draft: LessonExerciseDraft; sanitized: string[] }` albo
`{ pass: false; rejection }`. Kierownik woła checker wyłącznie dla `pass` i
wyłącznie z oczyszczonym szkicem.

`admitBatch(state, objectiveId, prechecked, checks, ctx)` przyjmuje kandydatów
`pass` **po kolei na bieżącym stanie**, powtarzając kroki 1–4 (między
`precheck` a `admit` inne zagadnienie mogło dodać ćwiczenie), potem 5–6.
Słowa kluczowe (`lesson_keywords`, szkoła) są w `precheckBatch` i w
`admitBatch` przetwarzane na końcu paczki (stabilnie), po pytaniach otwartych
swojej rodziny, a wyniki wracają w indeksach wejścia — wynik nie zależy od
kolejności w paczce.

```ts
type CheckResult<T> = { readonly kind: "na" } | { readonly kind: "unavailable" } | { readonly kind: "done"; readonly value: T };
interface CandidateChecks {
  readonly solve: CheckResult<readonly string[]>;
  readonly variants: CheckResult<readonly boolean[]>;
}
type Rejection = {
  readonly kind: "shape" | "rule" | "lesson" | "leak" | "blind" | "variant" | "limit";
  readonly code: string;              // stały kod reguły, bez treści (logi, trwały zapis)
  readonly reasons: readonly string[]; // tekst dla modelu (angielski), może zawierać treść
};
```

`na` — typ spoza `blindSolveTypes`/`variantCheckTypes` albo brak wariantów;
krok przechodzi. `unavailable` — błąd lub timeout checkera; krok przechodzi, a
wynik niesie `unchecked` (statystyka `checkUnavailable`). Wynik `admitBatch`:
nowy stan oraz per indeks wejścia `{ accepted: id; sanitized; unchecked }`
albo `{ rejected: Rejection }`. Teksty ujawnień z
`agentPolicy.rejectionTexts`.

`removeExercise(state, objectiveId, id)` usuwa wyłącznie ćwiczenie z puli tego
zagadnienia, a razem z nim osierocone słowa kluczowe jego rodziny
(odpowiednik `withoutOrphanKeywords`); zwraca `{ state, removed: string[] }`.

**Niezmiennik:** po każdym `admitBatch` i `removeExercise` lekcja (`fixed` +
pule) nie ma nowych ujawnień ani nowych błędów `validatePool`/
`validatePoolExtra` względem stanu wejściowego. Test własności (§9.1).

### 3.4. Przykłady kart

`submitExamples(state, objectiveId, lines, ctx)` — dla zagadnień bez
przykładów z planu (`objectiveSource !== "planner"`, §7.1): 1–3 linie,
przycięte i ograniczone jak dziś w `executeLessonGeneration`
(`MAX_TEXT_LENGTH`); identyczna linia (po przycięciu) liczy się raz i nie
zajmuje kolejnego miejsca. Linia odpada, gdy ujawnia rozwiązanie ćwiczenia lekcji
(twardo, `fixed` lub puli). Zastępuje wcześniejsze przykłady zagadnienia
(jak ostatnia partia w potoku). Przykłady wpływają na kolejne kontrole
ujawnień.

### 3.5. Status i limity zagadnienia

`objectiveAgentLimits({ targetCount, listenAllowance }, policy)` →
`{ targetCount, listenAllowance, maxExercises: targetCount + listenAllowance + policy.slack }`.
`targetCount` i `listenAllowance` liczy kierownik istniejącymi
`objectiveBatchCounts(poolSize, …)` i `listenChoiceAllowance` — **te same
liczby co partia dzisiejszego potoku**, zależne od `poolSize` rodzica. To
zastępuje stałe PoC (10–12, limit 14). Dla szkoły minima 3/2/2 dają co
najmniej 8 ćwiczeń na zagadnienie (`minimumCountPerObjective`); „ok. 5–6” z
issue jest niezgodne z minimami publikacji — agent dostaje tyle, ile partia
potoku.

`objectiveStatus(state, objectiveId, ctx)` →
`{ counts: { guided, productive, independent, outsideStages, total }, missing: string[], complete: boolean }`:

- **pokrycie**: `lessonCoverageGaps` dla tego zagadnienia na całej lekcji
  (ćwiczenia ujawnione nie liczą się; szkoła — różne pytania otwarte), z
  minimum etapu samodzielnego podniesionym o `agentPolicy.independentReserve`;
  brak różnych pytań otwartych ma osobny komunikat („distinct open answers:
  n of 2”), nie zaniżony brak etapu samodzielnego;
- **liczba**: `total` (bez `outsideStages`) ≥ `targetCount`;
- **wymagane typy**: każda grupa z `agentPolicy.requiredTypes?.(objective)`,
  po odfiltrowaniu przez rdzeń typów spoza `objective.exerciseTypes`, ma co
  najmniej jedno ćwiczenie;
- **przykłady kart**: zagadnienie ma 1–3 przykłady;
- **braki przedmiotu**: `agentPolicy.objectiveGaps?.(pool, objective, ctx)`;
- `complete` = brak braków. `fixed` zagadnienia liczą się wszędzie.

### 3.6. Kontrola końcowa

`lessonInvariantCheck(state, ctx)` — bezpiecznik po zakończeniu podagentów:
`findExposureLeaks` (coverage) i `validatePool`/`validatePoolExtra` całej
lekcji. Przy zachowanym niezmienniku (§3.3) zwraca pustą listę. Gdy nie
(błąd w kodzie), zwraca ćwiczenia puli do usunięcia (ofiary z pul, a dla
ofiar `fixed` — świeże źródła), a kierownik usuwa je bez rund naprawczych i
loguje `invariant_violation`. **Rund naprawczych nie ma** — atomowe przyjęcie
z kroku 4 je zastępuje.

### 3.7. Ślepe rozwiązanie

- `solverView(draft, topic)` — widok dziecka składany z **listy dozwolonych
  pól**: polecenie (`instructionPl`; dla `lesson_transform` instrukcja z
  `topic.transforms[transformId]`, jak `lesson-materialize.ts:138`), pytanie i
  bodziec (`prompt`, `stem`, `statement`), opis obrazka (`visualSubject`), tekst
  z lukami, opcje, bloki `lesson_order` posortowane, bank słów luk posortowany,
  lewe strony par w kolejności i prawe posortowane (z `extraRight`), grupy i
  elementy w kolejności. Test (§9.1) trzyma mapę
  `Record<keyof LessonExerciseDraft, "view" | "key" | "meta">`, więc nowe pole
  szkicu wymusza świadomą klasyfikację.
- `expectedAnswerCount(draft)` — luki w tekście: liczba luk; pary: liczba par;
  grupy: liczba elementów; inaczej 1.
- `blindMatches(draft, answers, normalizer)`:
  - luki w tekście: ta sama liczba odpowiedzi, każda równoważna
    (`answersEquivalent`) odpowiedzi luki na tej pozycji;
  - pary: i-ta odpowiedź to prawa strona dla i-tej lewej (z zapisu „lewa =>
    prawa” brana część po ostatnim „=>”), porównanie `plainKey` (małe litery,
    prosty apostrof, jedna spacja);
  - grupy: etykieta grupy i-tego elementu, jak pary;
  - pozostałe typy: pierwsza odpowiedź równoważna `answer` albo wariantowi.

### 3.8. Plan zagadnień (rozdział)

`validateAgentPlan(raw, subject, material)` → `{ objectives: RawPlanObjective[] } | { errors }`:
kształt (Zod), slugi ASCII snake_case i unikalne, **3–6** zagadnień, 2–4
karty, ≤ 3 przykłady, `kind`, potem `agentPolicy.planGate?.(plan, material)`.
Funkcja **nie składa** tematu: identyfikatory (`${subjectId}.d${deckId}.${slug}`),
przycinanie, ton i rodzaje nadaje kierownik istniejącymi
`buildDynamicTopicData`, `withSubjectObjectiveKinds` i
`validateDynamicTopicData` (§7.1) — jedna implementacja dla obu ścieżek.

## 4. Polityka agenta per przedmiot (`SubjectModule.agentPolicy`)

```ts
interface SubjectAgentPolicy {                     // types.ts
  readonly blindSolveTypes: readonly LessonExerciseType[];
  readonly variantCheckTypes: readonly LessonExerciseType[];
  /** Checker dostaje materiał lekcji (rozwiązanie wymaga materiału). */
  readonly checkerNeedsMaterial: boolean;
  readonly independentReserve: number;
  readonly slack: number;
  readonly rejectionTexts: { readonly leakVictim: string; readonly leakSource: string };
  requiredTypes?(objective: AgentObjective): readonly (readonly LessonExerciseType[])[];
  sanitize?(draft: LessonExerciseDraft): { draft: LessonExerciseDraft; removed: readonly string[] };
  /** Kod trafia do `Rejection.code` (np. `hint_reveals_answer`), powód do modelu. */
  exerciseGate?(draft: LessonExerciseDraft, objective: AgentObjective, ctx: { material: string }): readonly { readonly code: string; readonly reason: string }[];
  objectiveGaps?(pool: readonly LessonExerciseDraft[], objective: AgentObjective, ctx: { material: string }): string[];
  /** Słowa i ramy do pokrycia przez plan (lista dla modelu planera). */
  planCoverage?(material: string): { readonly words: readonly string[]; readonly frames: readonly string[] };
  planGate?(plan: readonly RawPlanObjective[], material: string): string[];
  /** Dopiski do instrukcji podagenta (po angielsku); brak = bez dopisków. */
  readonly promptNotes?: readonly string[];
}
```

Silnik i kierownik nie zawierają identyfikatorów przedmiotów ani reguł
dziedzinowych — pilnuje tego istniejący skan literałów w
`domain/lessons/architecture.test.ts:58-110` (obejmuje `domain/lessons/**`,
`modules/materials/lessons`, `providers/**` poza `fake.ts`; nowy
`providers/fake-lesson-agent.ts` też nie może ich zawierać).

### 4.1. Wartości wspólne

`independentReserve: 1`, `slack: 2` (PoC; strojenie w etapie 3).

### 4.2. `english_chapter`

- `blindSolveTypes` / `variantCheckTypes`: wartości PoC dla rozdziału
  przecięte z typami przedmiotu; `checkerNeedsMaterial: false`.
- `requiredTypes`: `words` — [`lesson_match`], [`lesson_listen_choice`],
  [`lesson_cloze`, `lesson_group`]; `frame` — [`lesson_order`],
  [`lesson_listen_choice`], [`lesson_cloze`].
- `exerciseGate`:
  - zagadnienie `words`: sprawdzana część (luki, opcja poprawna, odpowiedź,
    lewe strony par, elementy grup) zawiera słowo z kart **tego** zagadnienia;
    pary i grupy — co najmniej dwa (PoC `cardWordErrors`);
  - zagadnienie `frame` (**nowe**, issue pkt 2): rozwiązanie (odpowiedź,
    zdanie `lesson_order`, zdanie luki po wstawieniu odpowiedzi) zawiera
    stałą część (`frameKey`) jednej z ram z kart **tego** zagadnienia;
    `lesson_listen_choice`, pary i grupy wyłączone.
- `objectiveGaps`: `words` — każde słowo materiału z kart zagadnienia użyte w
  którymś ćwiczeniu.
- `planCoverage` i `planGate`: słowa z list „en — pl” i ramy z sekcji
  zwrotów/ram materiału; każde na karcie któregoś zagadnienia.
- Parser (`parseMaterialLexicon`), `frameKey`, `plainText`, `mentions` —
  `english-chapter/material-lexicon.ts` (obok `lexicon.ts`, który jest
  słownikiem dozwolonych słów).
- `rejectionTexts.leakVictim`: „… change the room, object or place.” (PoC).

### 4.3. `english_grammar`

- `blindSolveTypes` / `variantCheckTypes`: wartości PoC przecięte z typami
  przedmiotu (gramatyka nie ma `lesson_match`, `lesson_group`,
  `lesson_cloze`); `checkerNeedsMaterial: false`.
- Bez `requiredTypes`, `exerciseGate`, `objectiveGaps`, planu.
- `hint` bez zmian (forma podstawowa, np. „go” przy „goes”).
- `rejectionTexts.leakVictim`: „… use a different subject, verb or object.”

### 4.4. `school`

- `blindSolveTypes`: `lesson_choice`, `lesson_match`, `lesson_group`,
  `lesson_cloze`, **`lesson_gap`**; `variantCheckTypes`: **`lesson_gap`**;
  `checkerNeedsMaterial: true`. Nie są rozwiązywane na ślepo:
  `lesson_open_answer` (grader od etapu 2), `lesson_order`,
  `lesson_calculation`, `lesson_keywords`.
- `sanitize`: `hint` przy typie innym niż `lesson_open_answer` jest
  **usuwany**; wynik narzędzia mówi o tym modelowi. Świadome odstępstwo od
  issue („chyba że rodzic chce inaczej”): agent nie czyta polecenia rodzica w
  tej sprawie; rodzic dopisuje podpowiedź w edytorze (edycja nie przechodzi
  przez `sanitize`). Regułę „podpowiedź tylko przy otwartych odpowiedziach”
  niesie `promptNotes` polityki szkoły: kierownik przekazuje je w
  `LessonObjectiveAgentInput.promptNotes`, a adapter dokleja do dopisku
  przepływu narzędzi; inne przedmioty dopisków nie mają (gramatyka zachowuje
  `hint`, §4.3).
- `exerciseGate` — **bramka podpowiedzi** dla `hint` przy
  `lesson_open_answer`:
  - tokenizacja: tekst po `subject.normalizer`, małe litery, podział na
    ciągach znaków niebędących literą ani cyfrą; liczby są tokenami;
  - słowa treściowe frazy: tokeny ≥ 4 liter albo zawierające cyfrę; fraza bez
    takich tokenów — wszystkie jej tokeny;
  - zgodność dwóch słów: równe, albo oba ≥ 4 liter i wspólny prefiks ≥
    max(3, krótsze − 3) („Odra”/„Odrze”, „Polska”/„Polski”,
    „zmniejszony”/„zmniejszenie” — tak; „mapa”/„mama” — nie);
  - fraza jest „zawarta” w podpowiedzi, gdy zgodne słowo podpowiedzi ma co
    najmniej połowa jej słów treściowych (zaokrąglając w górę; przy 1–2
    słowach — wszystkie);
  - podpowiedź odpada, gdy zawiera odpowiedź, któryś wariant albo któryś
    element `requiredElements`.
  Brak lematyzatora: to przybliżenie. Testy (§9.1) obejmują przykłady z próby
  („Przykładem jest Mierzeja Wiślana”, „Użyj słów: zmniejszony, uproszczony”)
  i fałszywe trafienia krótkich słów; fałszywe odrzucenia mierzy etap 3
  (kod `hint_reveals_answer` w odrzuceniach).
- `rejectionTexts.leakVictim`: „… ask about a different fact of the material
  or phrase the question differently.”

## 5. PR wstępny: zdania kart w generowaniu

**Cel:** angielskie zdania wpisane w treść kart rozdziału są widoczne dla
dziecka jak przykłady, więc generowanie nie może ich używać jako rozwiązań
ćwiczeń samodzielnych. Dziś reguła bierze tylko `examples`.

- Nowy opcjonalny hak `SubjectModule.cardExposureTexts?(cards)`; implementuje
  go **tylko `english_chapter`**, regułą PoC `cardSentences` (części linii
  rozdzielone „ — ” albo „ / ”, z samych liter ASCII i `' ,.?!`, zakończone
  `.?!` albo ≥ 3 słowa, bez wielokropka; linia słówek „living room — salon”
  nie jest zdaniem). Ponieważ prawdziwa karta ramy to polskie wyjaśnienie
  z 1–3 przykładami, części dzielą się dalej po etykiecie „: ”, po „; ” i na
  granicach zdań po `.?!`, a z każdej odpada punktor lub numeracja („- ”,
  „• ”, „* ”, „1. ”, „1) ”) i cudzysłowy na obu brzegach („…”, "…", «…»)
  przed sprawdzeniem reguły. Gramatyka haka nie dostaje: reguła zdania dawałaby w jej polskich kartach
  fałszywe alarmy (np. „i kropka.”). Szkoła — materiał po polsku.
- Nowa funkcja domenowa `cardExposureSources(subject, topic)` →
  `cardExposureTexts` kart per zagadnienie (bez przykładów).
- `resolveGenerationLeaks` dostaje opcjonalny parametr `fixedSources`
  (zagadnienie → teksty): doklejany do źródeł **po** zastąpieniu przykładów
  nowymi (`{ ...existingExamples, ...keptNewExamples }` nadpisuje cały wpis
  zagadnienia, więc zdania kart podane w `existingExamples` zniknęłyby przy
  każdej partii z nowymi przykładami); nie wpływa na `keptNewExamples` ani
  `droppedExampleCount`.
- Używają ich **wyłącznie** wejścia reguł generowania: `fixedSources` w
  `resolveGenerationLeaks` (reguła twarda w `executeLessonGeneration` i
  `stageTopUpRound`) oraz `examples` w `avoidSentencesFor` (przykłady
  scalone ze zdaniami kart). Zapisywany `lesson_context.examples` i
  `finalExamples` dla zapisu się nie zmieniają (zdania kart nie trafiają do
  kontekstu, renderowania karty ani fingerprintów nagrań kart).
- Bez zmian: pokrycie i publikacja (`lessonCoverageGaps`, także
  `stageDeficits` rundy pod etap — dalej zgodne z publikacją), lista
  ujawnień w edytorze, raport ujawnień, sesja (`materializeCard`, ekspozycje
  tylko z `examples`), krytyk. Pokrycie nadal odwzorowuje scheduler
  (`architecture.md` §19).
- **Skutek:** świeże ćwiczenie samodzielne rozdziału z rozwiązaniem równym
  zdaniu karty odpada przy generowaniu (powód „rozwiązanie widoczne
  wcześniej”); generator dostaje te zdania na liście do unikania. Istniejące
  szkice i publikacja bez zmian, więc pomiar blokad nie jest potrzebny.
- Testy: hak (zdania tak, słówka nie, ramy z wielokropkiem nie, na
  prawdziwych kartach rozdziału z fixture), `cardExposureSources`,
  `resolveGenerationLeaks` z `fixedSources` (zdanie karty przetrwa nowe
  przykłady zagadnienia i nie trafia do `keptNewExamples`), integracyjny
  `lesson-chapter`: ćwiczenie samodzielne ze zdaniem karty odpada, a
  zapisany `lesson_context.examples` równa się przykładom zwróconym przez
  generator. Istniejąca asercja „pierwsza partia bez `avoidSentences`”
  (`lesson-chapter.test.ts` ok. l. 490) zmienia się na zdania kart lekcji.
- Świadomy koszt reguły: polskie zdanie bez znaków diakrytycznych („To jest
  kot.”) też zostanie uznane za zdanie karty — tylko zaostrza regułę.
- Dokumentacja: `architecture.md` §19 (reguła ujawnień przy generowaniu),
  `SPEC.md` (lista zdań do unikania, ok. l. 818: „przykłady kart, zdania kart
  rozdziału i rozwiązania innych ćwiczeń”).

Etap 1 korzysta z tej samej funkcji: `fixedSources` stanu agenta =
`cardExposureSources(subject, topic)` scalone z przykładami szkicu
(przykłady zagadnień przebiegu żyją w `state.examples`).

## 6. Porty i fake'i

### 6.1. `ports/ai.ts`

```ts
/** Licznik kosztu runu: adapter zgłasza KAŻDE żądanie HTTP (także nieudane) — usd albo null (nieznany). */
interface RunCostSink { record(usd: number | null): void }

interface LessonObjectiveAgentInput {
  /** Pola promptu produkcyjnego (rola, reguły, typy, materiał, polecenie, tematy zdań, avoidSentences).
   *  Liczby partii (`countPerObjective`, `stageCounts`, `listenChoicePerObjective`) wypełnia kierownik
   *  z `targets`; `targets` jest jedynym źródłem liczb. `targets.independent` ≥ minimum samodzielnych
   *  + `independentReserve` (próg `objectiveStatus`); `countPerObjective` = suma etapów. */
  readonly pool: LessonPoolInput;
  readonly objective: {
    readonly id: string; readonly title: string; readonly kind?: "words" | "frame";
    readonly cards: readonly { readonly title: string; readonly body: string }[];
    readonly examplesFromPlan: boolean;           // false = model dostarcza przykłady przez submit
  };
  readonly otherObjectives: readonly { readonly title: string; readonly kind?: "words" | "frame"; readonly cards: string }[];
  /** Przykłady i zdania kart lekcji, których nie wolno użyć jako odpowiedzi samodzielnych. */
  readonly cardSentences: readonly string[];
  readonly targets: {
    readonly guided: number; readonly productive: number; readonly independent: number;
    readonly requiredTypes: readonly (readonly LessonExerciseType[])[];
    readonly targetCount: number; readonly listenAllowance: number; readonly maxExercises: number;
  };
  readonly maxSteps: number;
  readonly promptNotes?: readonly string[];       // z SubjectAgentPolicy.promptNotes (§4.4)
}

interface LessonAgentToolOutcome {               // skrót dla modelu
  readonly results: readonly (
    | { readonly index: number; readonly accepted: string; readonly note?: string }
    | { readonly index: number; readonly errors: readonly string[] })[];
  readonly examples?: { readonly accepted: number; readonly errors: readonly string[] };
  readonly counts: { readonly guided: number; readonly productive: number; readonly independent: number; readonly outsideStages: number; readonly total: number };
  readonly missing: readonly string[];
  readonly complete: boolean;
}

interface LessonObjectiveAgentTools {
  /** Wejście = gałąź `exercises` (+ opcjonalnie `examples` zagadnienia) schematu puli. */
  submit(raw: { readonly exercises: readonly unknown[]; readonly examples?: readonly unknown[] }): Promise<LessonAgentToolOutcome>;
  remove(id: string): Promise<LessonAgentToolOutcome & { readonly removed: readonly string[] }>;
  /** complete, budżet, termin albo anulowanie. */
  shouldStop(): boolean;
}

interface LessonAgentPlanInput {
  readonly subjectTitle: string;
  readonly topicTitle: string;
  readonly material: string;
  readonly instruction?: string;
  readonly generationRole: string;
  readonly objectivesRules?: string;
  readonly objectiveCount: { readonly min: number; readonly max: number };   // 3–6
  readonly coverage?: { readonly words: readonly string[]; readonly frames: readonly string[] };
  readonly maxSteps: number;
}

interface LessonPoolAgentProvider {
  readonly name: string;
  readonly model: string;
  runObjective(input: LessonObjectiveAgentInput, tools: LessonObjectiveAgentTools, cost: RunCostSink, signal: AbortSignal):
    Promise<{ readonly steps: number; readonly stopReason: "stopped" | "max_steps" | "model_finished" }>;
  planObjectives(
    input: LessonAgentPlanInput,
    tools: { propose(raw: unknown): Promise<{ readonly ok: boolean; readonly errors: readonly string[] }>; shouldStop(): boolean },
    cost: RunCostSink,
    signal: AbortSignal,
  ): Promise<{ readonly steps: number }>;
}

/** Wywołania paczkowe: jedno żądanie na paczkę `submit`, materiał raz (koszt szkoły, issue pkt 7). */
interface LessonExerciseCheckerProvider {
  readonly name: string;
  readonly model: string;
  solve(input: { readonly items: readonly { readonly view: string; readonly expectedAnswers: number }[]; readonly material?: string },
    cost: RunCostSink, signal: AbortSignal): Promise<{ readonly answers: readonly (readonly string[] | null)[] }>;
  judgeVariants(input: { readonly items: readonly { readonly view: string; readonly answer: string; readonly variants: readonly string[] }[]; readonly material?: string },
    cost: RunCostSink, signal: AbortSignal): Promise<{ readonly equivalent: readonly (readonly boolean[] | null)[] }>;
}
```

`null` w odpowiedzi checkera = brak wyniku dla tej pozycji (`unavailable`).

**Kontrakt adapterów (etap 2, zapisany teraz):**

- materializuje surowe rekordy jak `generateLessonPool`
  (`materializeGeneratedCalculations`, `…Keywords`, `…Assignments`) przed
  `submit`; nie waliduje treści;
- kończy pętlę, gdy `shouldStop()` zwraca `true` (sprawdzane przed każdym
  krokiem), po `maxSteps` albo gdy model kończy;
- zgłasza koszt **każdego** żądania HTTP przez `RunCostSink`, także
  nieudanego i ponowionego (decyzja w etapie 2: `maxRetries: 0` z ponowieniem
  w kierowniku albo zapis w `onLanguageModelCallEnd`); obok, z tego samego
  zdarzenia, `UsageRecorder.record` — kierownik nigdy nie woła
  `UsageRecorder`; test inwentarza `PAID_ADAPTERS` rozszerzony w etapie 2 o
  importy `ai`/`@openrouter` (dziś wykrywa `fetch(`);
- przerwanie `signal` kończy wywołanie wyjątkiem przerwania;
- do checkera trafia wyłącznie to, co jest w jego wejściu (§11).

Miejsce na kontrole modelem w szkole: etap 2 dodaje metody checkera albo
użycie `AnswerGraderProvider` (dziś proces web — decyzja o procesie worker w
etapie 2) i nowy rodzaj w `CandidateChecks`; etap 1 nie definiuje sygnatur.

### 6.2. Fake'i (`providers/fake-lesson-agent.ts`)

- `FakeLessonPoolAgent`: scenariusz per zagadnienie (klucz: indeks zagadnienia
  albo slug, bez identyfikatorów przedmiotów) — lista kroków
  `{ submit } | { remove } | { parallel: Step[] } | { throw } | { hang: true }`
  i koszt kroku; wykonuje kroki, dopóki `shouldStop()` nie zwróci `true`, nie
  skończy się scenariusz lub `maxSteps`; `{ parallel }` wywołuje narzędzia
  równolegle (jak AI SDK dla kilku wywołań w jednym kroku); zapamiętuje
  wejścia i wyniki narzędzi. Plan: lista propozycji.
- `FakeExerciseChecker`: funkcja `view → answers` (domyślnie pusta lista =
  rozjazd), funkcja werdyktów (domyślnie `true`), tryby `throw`/`hang`/`null`
  per pozycja, koszt, licznik wywołań, zapis wejść, maksymalna
  zaobserwowana równoległość.

## 7. Kierownik (`modules/materials/lessons/lesson-pool-agent.ts`)

```ts
runLessonPoolAgent(
  deps: { agent: LessonPoolAgentProvider; checker: LessonExerciseCheckerProvider; subjects: Pick<SubjectRegistry, "getSubject">; policy?: Partial<LessonAgentPolicy> },   // brak pól = DEFAULT_LESSON_AGENT_POLICY
  input: LessonPoolAgentRunInput,
  signal: AbortSignal,
): Promise<LessonPoolAgentResult>
```

`deps` zawiera też `subjects: Pick<SubjectRegistry, "getSubject">` — jawne
źródło `SubjectModule` (nieznany przedmiot → błąd walidacji bez wywołań).
`LessonPoolAgentRunInput`: `runId` (logi), `subjectId`, `deckId`, źródło
zagadnień jako unia rozłączna (`objectiveSource`): `{ source: "planner" }`,
`{ source: "catalog"; topic }` albo `{ source: "input"; dynamicTopic }`
(temat z `subject.buildDynamicTopic`), materiał, polecenie, tematy zdań,
`poolSize`, `graderAvailable`, `fixed` (szkic) i przykłady szkicu,
`skipObjectives` (zagadnienia już zapisane — pomijane, ich ćwiczenia w
`fixed`), `initialSpentUsd`, opcjonalny hak `onObjectiveSettled`.

`LessonAgentPolicy` (wartości domyślne w kodzie, env od etapu 2):
`maxStepsPerObjective` 8, `planMaxSteps` 8, `concurrency` 4,
`checkerConcurrency` 4 (paczki), `checkerTimeoutMs` 90 000,
`objectiveTimeoutMs` 300 000 (od faktycznego startu podagenta),
`runTimeoutMs` = `DEFAULT_LESSON_GENERATION_POLICY.runTimeoutMs` (agent nie
dłużej niż kontroler runu potoku), `runBudgetUsd` 1,00,
`unknownCallEstimateUsd` 0,02 (koszt `null` liczony szacunkiem). Terminy
kierownik tworzy na `setTimeout` + `AbortController` (jak
`lesson-generation-control.ts`), nie `AbortSignal.timeout`, żeby testy
mogły sterować czasem. Budżet jest wyczerpany, gdy wydatek ≥ `runBudgetUsd`.
`cardSentences` podagenta to wszystkie przykłady i zdania kart **lekcji**
(ujawnienia twarde działają między zagadnieniami). Przykłady w `submit` przy
`examplesFromPlan === true` są ignorowane z notą „examples are fixed by the
plan”.

### 7.1. Przebieg

1. **Walidacja**: `asAgentCapable(subject)`; inaczej `AppError("validation")`
   bez wywołań modelu.
2. **Plan** (`objectiveSource: "planner"`): `planObjectives` z
   `objectiveCount` 3–6, `coverage` z `planCoverage`, regułami przedmiotu i
   dopiskiem nadrzędnym „up to 6 objectives when coverage needs it” (prompt
   przedmiotu mówi 3–5). `propose` woła `validateAgentPlan`, potem
   `buildDynamicTopicData(deckId)`, `withSubjectObjectiveKinds`,
   `validateDynamicTopicData`; błędy wracają do modelu. Przykłady z planu
   trafiają do `state.examples`. Brak planu po `planMaxSteps` → wynik
   `plan_failed`. `catalog`: temat z katalogu (gramatyka); `input`: dane
   zagadnień z wejścia (szkoła — `generateLessonObjectives` woła wołający).
3. **Podagenci**: zagadnienia spoza `skipObjectives`, w kolejności lekcji,
   najwyżej `concurrency` naraz. Sygnał podagenta łączy sygnał runu, termin
   zagadnienia i termin runu (`AbortSignal.any`); kierownik pamięta, który
   z nich przerwał.
4. **Narzędzia podagenta** — wszystkie wywołania narzędzi jednego zagadnienia
   przechodzą przez **mutex zagadnienia** (AI SDK wykonuje równoległe
   wywołania z jednego kroku przez `Promise.all`). `submit`:
   1. odmowa (bez przyjęcia) po przekroczeniu budżetu, terminu albo po
      zamknięciu narzędzi;
   2. parsowanie każdego rekordu: `isWellShapedRawExercise`, `objectiveId`
      równe zagadnieniu, `toExerciseDraft`, **wspólna sanityzacja** (§7.2);
      błąd = `rejected: shape`;
   3. przykłady (gdy `examplesFromPlan === false` i są w wejściu):
      `submitExamples`;
   4. `precheckBatch` na bieżącym stanie;
   5. checker dla `pass` z typem z polityki: jedno `solve` (paczka widoków) i
      jedno `judgeVariants` na wywołanie `submit`, równolegle; każde zajmuje
      jedno miejsce semafora `checkerConcurrency`; sygnał = sygnał
      zagadnienia (obejmuje run i termin zagadnienia) + `checkerTimeoutMs`;
      budżet sprawdzany przed każdym wywołaniem (po przekroczeniu —
      `unavailable`); błąd = `unavailable` dla całej paczki;
   6. jeśli narzędzia są już zamknięte albo sygnał zagadnienia przerwany —
      odmowa bez przyjęcia; inaczej `admitBatch` na **bieżącym** stanie i
      podmiana stanu — **synchronicznie, bez `await` między odczytem stanu a
      podmianą** (niezmiennik w kodzie i teście);
   7. zwrot `LessonAgentToolOutcome`.

   `remove` — `removeExercise` pod tym samym mutexem.
5. **Zamknięcie zagadnienia**: po powrocie lub wyjątku `runObjective`
   kierownik **od razu** zamyka narzędzia (kolejne wywołania i trwające przed
   krokiem 4.6 kończą się odmową bez przyjęcia), czeka na trwające wywołania,
   liczy `objectiveStatus` i woła `onObjectiveSettled` — w kolejności
   zakończenia zagadnień, szeregowo (kolejka; nie wstrzymuje startu
   kolejnych podagentów). Błąd haka zamyka wszystkie narzędzia, przerywa
   pozostałe zagadnienia i kończy run odrzuceniem tym błędem (w etapie 2
   utrata `assertCurrent`).
6. **Kontrola końcowa**: `lessonInvariantCheck`; ewentualne usunięcia bez
   naprawy, log `invariant_violation`.
7. **Wynik** `LessonPoolAgentResult`:
   - `objectives`: per zagadnienie `status` — `complete` | `incomplete`
     (`missing`; także po terminie zagadnienia) | `failed` (kod z
     `classifyLessonGenerationFailure` dla wyjątku dostawcy); przyjęte szkice
     w kolejności lekcji; przykłady; kroki;
   - `dynamicTopic` (gdy był plan);
   - `stats`: zgłoszone, przyjęte, odrzucone per rodzaj, `checkUnavailable`,
     wywołania checkera, `invariantViolations`;
   - `rejections`: `{ objectiveId, exerciseType, kind, code, detail }[]` —
     `code` bez treści (logi, w etapie 2 trwały zapis), `detail` z treścią
     wyłącznie w pamięci wyniku i w zrzucie próby;
   - `spentUsd` (z `initialSpentUsd`), `unknownCostCalls`.

Mapowanie statusów na stan runu i `needs_review` — etap 2 (tabela decyzji w
specu etapu 2).

### 7.2. Wspólna sanityzacja świeżego ćwiczenia

Z `acceptFreshLessonPool` (`lesson-pool-acceptance.ts`) wydzielam czystą
funkcję `sanitizeFreshLessonDraft(draft, subject, familyScope)` ze wszystkimi
krokami per ćwiczenie, które dziś tam są: `withoutEmptyOptionalArrays`,
`stripListenChoiceExtras`, `withoutRedundantAcceptedVariants`,
`withoutVoiceToneUnlessAllowed`, `withoutInvalidExplanation`,
`scopeFamiliesToRun`. `acceptFreshLessonPool` woła ją bez zmiany zachowania
(istniejące testy potoku przechodzą bez zmian) i nadal wywołuje
`stripParentAddedFlags` (model nie oznaczy cytatu jako dodanego przez
rodzica) po `refineGeneratedDrafts`; kierownik wywołuje `stripParentAddedFlags`
osobno, zaraz po `sanitizeFreshLessonDraft`, przed rdzeniem agenta (krok
4.2). Dzisiejsze haki `refineGeneratedPool` nie czytają flagi `parentAdded`,
więc różna kolejność nie zmienia decyzji; nowy hak nie może od niej zależeć.
Kroki na całej puli (`refineGeneratedPool`, `validatePool`, deduplikacja,
`capListenChoiceOverflow`) odpowiadają krokom 1–3 z §3.3.

### 7.3. Błędy i przerwanie

- Wyjątek dostawcy w `runObjective` (sygnał zagadnienia nieprzerwany) →
  `failed`; przerwanie terminem zagadnienia → `incomplete`. Klasyfikacja po
  tym, który sygnał przerwał, nie po typie wyjątku.
- Wyjątek w `planObjectives` → `plan_failed` z kodem błędu.
- Błąd checkera → `unavailable`, bez porażki.
- Termin runu → trwające zagadnienia `incomplete`, kontrola końcowa działa.
- Przerwanie sygnału runu (anulowanie, `superseded`, `shutdown`) → kierownik
  czeka na zamknięcie narzędzi i rzuca `signal.reason`, żeby etap 2 zachował
  semantykę `withLessonGenerationControl`; nie zwraca wyniku częściowego.
- **Budżet**: wydatek = `initialSpentUsd` + zgłoszenia `RunCostSink`
  (`null` → `unknownCallEstimateUsd`). Sprawdzany przed każdym krokiem agenta
  (`shouldStop`) i przed każdym wywołaniem checkera. Przekroczenie jest
  ograniczone kosztem żądań już w locie: najwyżej `concurrency` kroków agenta
  i `checkerConcurrency` paczek checkera.

### 7.4. Logi

`[lesson-agent] run=… obj=<slug>`: liczniki, kody odrzuceń, status, kroki,
koszt; bez treści ćwiczeń, materiału, kart, tematów zdań i `detail`. Test
(§9.2) sprawdza, że log nie zawiera treści `detail` z fixture.

## 8. Próba i narzędzia oceny (`tests/probes/`)

- **`agent-generation.probe.test.ts`** (`pnpm probe:agent`) zastępuje
  `agent-generation-v2` PoC i **nie ma własnych reguł**: woła
  `runLessonPoolAgent`. W pliku próby zostaje tymczasowa implementacja obu
  portów na AI SDK (`ToolLoopAgent`, `generateText`, OpenRouter, koszt z
  `providerMetadata.openrouter.usage.cost`), przeniesiona do adaptera w etapie
  2. Prompt podagenta: `lessonSystemPrompt` + `lessonUserMaterial` + dopisek
  przepływu narzędzi z PoC i dopiski przedmiotu z `input.promptNotes` (szkoła:
  „hint only for lesson_open_answer”; inne przedmioty tej reguły nie dostają).
  Tryb `probe` (uproszczony schemat) usunięty.
- Zmienne: `UMIEM_PROBE_AGENT_SUBJECT` (`chapter` | `grammar` | `school`),
  `_MATERIAL`, `_OBJECTIVES_DUMP`, `_MODEL`, `_REASONING`, `_SOLVER_MODEL`,
  `_DUMP`, `_TIMEOUT_MS`, `_BUDGET_USD`, `_POOL_SIZE` (domyślnie
  `defaultPoolSize` liczby zagadnień, jak potok), `UMIEM_PROBE_COSTS`
  (`UMIEM_PROBE_COSTS_CAP_USD` — limit nowego rejestru, domyślnie 10 USD).
  Ścieżki wyłącznie poza repozytorium (`resolveOutsideRepoPath`).
- Zrzut `dump.json` (źródło `agent`) w formacie `blind/gen-blind-sheet.cjs`, z
  `rejections` (z `detail`), statystykami, krokami, kosztem i statusami.
- **Punkt odniesienia** — rozszerzenia `chapter-generation.probe.test.ts`
  (z `feat/lesson-review-probe`, przepisane): zrzut **końcowego szkicu** po
  `executeLessonGeneration` (po regule twardej i dogenerowaniu, nie stan
  sprzed krytyka), w tym samym formacie arkusza, oraz zrzut zagadnień z
  **kartami jako tablicą** (`{ title, body }[]`) — wejście
  `UMIEM_PROBE_AGENT_OBJECTIVES_DUMP`. Zmienne: `UMIEM_PROBE_REVIEW_DUMP_OUT`
  → zmiana nazwy na `UMIEM_PROBE_POOL_DUMP_OUT`, `_COSTS`, `_COSTS_INIT`,
  `_OUT_DIR`, `_ALLOW_HOST`, `_SUBJECT`. Bez zależności od `lesson-review` i
  bez strojenia krytyka. `_POOL_SIZE` już jest na `main`.
- Z `probe/lesson-pool-agent`: `blind/gen-blind-sheet.cjs`, `blind/score.cjs`,
  `blind/rubric-generation.md`, `blind/rubric-criteria.md` bez zmian.
- Z `feat/lesson-review-probe` — **same pliki**, bez historii i bez wypychania:
  - `probe-helpers.ts` — rozszerzenie wersji z `main` o `runDirsOf`, z testem;
  - nowy `probe-costs.ts` z `probe-results.ts`: `CostEntry`, `CostLedger`,
    `readCostLedger`, `initCostLedger`, `appendCostEntry`,
    `appendProvisionalCostEntry`, `settleCostEntry`, `assertWithinCostCap`,
    `ledgerCost`, `estimateProbeCostUsd` (generowanie), `probeEndpointHost`,
    `errorClassOf`, `sha256File`, z testami; bez etykiet, arkuszy i punktacji
    krytyka;
  - `vitest.probe.config.ts` (`loadDotEnv`, tryby przedmiotów).
- `vitest.unit.config.ts`: dopisać `tests/probes/probe-costs.test.ts` i
  `tests/probes/probe-helpers.test.ts` (jawna lista plików z `tests/`).
- `providers/openai/llm.ts`: eksport `lessonSystemPrompt` i
  `lessonUserMaterial` (jak w PoC).
- **Higiena**: przed commitem przegląd przenoszonych plików pod kątem imion,
  identyfikatorów, ścieżek lokalnych i fragmentów materiałów.
- Zależności: `ai@7.0.162`, `@openrouter/ai-sdk-provider@3.1.0` (i `zod`, jeśli
  root go nie ma) jako **devDependencies roota**, przypięte dokładnie, z
  `pnpm-lock.yaml`; nie trafiają do `packages/*` ani `apps/*` (§9.4).

## 9. Testy i weryfikacja

### 9.1. Domena (jednostkowe, fikcyjne dane)

- `precheckBatch`/`admitBatch`: kolejność kroków (który powód wygrywa);
  duplikat w paczce; duplikat i konflikt słuchowy **między zagadnieniami**;
  limit `listenAllowance`; ujawnienie twarde i miękkie — kandydat ofiarą,
  kandydat źródłem dla przyjętego, kandydat źródłem dla `fixed`; wadliwe
  ćwiczenie `fixed` nie blokuje kandydatów; błąd `validatePoolExtra` na innym
  indeksie odrzuca kandydata; słowa kluczowe przed swoją rodziną w paczce
  przechodzą; `sanitize` i `refineGeneratedPool` — checker dostaje szkic po
  nich; `CheckResult` `na`/`unavailable`/`done`; stan wejściowy niezmieniony;
  `precheck` i `admit` zgodne na tym samym stanie.
- **Niezmiennik (test własności):** losowe sekwencje `admitBatch` i
  `removeExercise` na kilku przedmiotach z fixture — po każdej operacji brak
  nowych ujawnień i nowych błędów walidacji całej lekcji.
- `removeExercise`: tylko własna pula; sieroty słów kluczowych.
- `submitExamples`: limity, ujawniająca linia odpada, zastąpienie.
- `objectiveStatus`: pokrycie przez `lessonCoverageGaps` (ujawnione się nie
  liczą; szkoła — różne pytania otwarte), rezerwa, `targetCount`,
  `outsideStages`, wymagane typy z filtrem, przykłady, `objectiveGaps`,
  `fixed`.
- `objectiveAgentLimits`; dla szkoły liczby zgodne z `objectiveBatchCounts`.
- `blindMatches` dla każdego typu (pary, grupy, luki w tekście), warianty,
  normalizator, inna liczba odpowiedzi, „=>”, wielkość liter, apostrofy.
- `solverView`: mapa pól (view/key/meta) dla każdego pola
  `LessonExerciseDraft`; żadne pole `key` w widoku; instrukcja
  `lesson_transform` z tematu; `visualSubject`; sortowanie.
- `lessonInvariantCheck`: zwraca usunięcia dla sztucznie zepsutego stanu.
- `validateAgentPlan`: 3 i 6 przechodzą, 2 i 7 nie; slugi; karty;
  `planGate`.
- Rozdział: parser słów i ram; `planCoverage`/`planGate`; bramka słów kart;
  bramka ramy; `objectiveGaps`; `requiredTypes`.
- Szkoła: bramka podpowiedzi (odpowiedź, wariant, element wymagany, forma
  odmieniona, liczby, fraza bez słów ≥ 4 liter, przykłady z próby, fałszywe
  trafienia krótkich słów); `sanitize` usuwa `hint` poza otwartą odpowiedzią.
- Gramatyka: `hint` nietknięty.
- `sanitizeFreshLessonDraft`: istniejące testy `acceptFreshLessonPool`
  przechodzą bez zmian + test każdego kroku.

### 9.2. Kierownik (fake'i, bez bazy)

- przebieg do `complete` (odrzucenie → poprawka → przyjęcie);
- `maxSteps` → `incomplete` z brakami; termin zagadnienia → `incomplete`;
  wyjątek dostawcy → `failed`, pozostałe `complete`;
- budżet: `shouldStop`, odmowa `submit`, checker `unavailable`,
  `initialSpentUsd`, koszt `null` jako szacunek, przekroczenie ≤ koszt żądań
  w locie;
- checker: wołany tylko dla `pass` i typów z polityki, z oczyszczonym
  szkicem, jedna paczka na `submit`; materiał tylko przy
  `checkerNeedsMaterial`; wejście bez innych pól (§11); błąd i `null` →
  `unavailable`;
- równoległość: nigdy ponad `concurrency` podagentów i `checkerConcurrency`
  paczek; `{ parallel: [submit, submit] }` i `{ parallel: [submit, remove] }`
  w jednym zagadnieniu — wynik jak sekwencyjny;
- spóźnione narzędzie po zakończeniu `runObjective` (`hang` checkera, potem
  termin) — odmowa, stan bez zmian;
- ujawnienie między zagadnieniami równoległymi — drugi kandydat odpada przy
  przyjęciu, kontrola końcowa pusta;
- plan: odrzucony → poprawiony → przyjęty (identyfikatory jak
  `buildDynamicTopicData`); brak planu → `plan_failed`;
- przykłady przez `submit` dla gramatyki i szkoły; z planu dla rozdziału;
- `skipObjectives` + `fixed`: zagadnienie pominięte, liczy się do ujawnień;
- `onObjectiveSettled`: kolejność, błąd przerywa run;
- przedmiot bez `agentPolicy` → błąd walidacji bez wywołań;
- przerwanie sygnału runu → rzucone `signal.reason`;
- model dostaje skrót (`LessonAgentToolOutcome`), nie szkice;
- logi bez treści `detail`.

### 9.3. PR wstępny

§5: jednostkowe haka, `cardExposureSources` i `fixedSources`; integracyjny
`lesson-chapter` (odrzucenie, niezmieniony `lesson_context.examples`);
istniejące testy pokrycia, publikacji i sesji bez zmian.

### 9.4. Architektura

- `domain/lessons/agent/` nie importuje `ai`, `@openrouter/*`, Drizzle,
  `modules/`, `providers/`, `ports/`, modułów `node:` ani konfiguracji i nie
  używa `Date.now`, `new Date(`, `Math.random`, `crypto.randomUUID`,
  `performance.now`, `process.env` (rozszerzenie
  `domain/lessons/architecture.test.ts`);
- nowy test: `ai` i `@openrouter/*` nie występują w żadnym pliku źródłowym
  repozytorium poza `tests/probes/**` (pomijane zależności i artefakty
  buildów); manifesty `packages/*` i `apps/*` ich nie deklarują (etap 2
  dopuści jeden plik adaptera);
- istniejący skan identyfikatorów przedmiotów obejmuje nowe pliki;
  `module-boundaries.architecture.test.ts` przechodzi.

### 9.5. Próba — przebiegi kontrolne

Przed każdym płatnym przebiegiem — wyraźna zgoda właściciela w czacie.
Trzy płatne przebiegi z rejestrem kosztów (limit rejestru 2,00 USD,
`_BUDGET_USD` 0,40 na przebieg agenta; szacunek łącznie ok. 0,65 USD):
`probe:chapter` na materiale szkoły (zrzut zagadnień dla agenta), agent
**szkoła** (materiał w checkerze, `sanitize`, bramka podpowiedzi, luki na
ślepo, paczki checkera) i agent **rozdział** (planer, bramki rozdziału).
Materiały — pliki właściciela poza repozytorium. Najwyżej jedno powtórzenie
po porażce. Próba sama sprawdza stan końcowy (`lessonInvariantCheck`,
`findExposureLeaks` w trybach `coverage` i `generation`, `validatePool`,
`validatePoolExtra`) i raportuje różnicę trybów. Kryteria ustalone z góry:
przebieg kończy się bez wyjątku; 0 twardych ujawnień (coverage) i 0 błędów
walidacji całej lekcji; każde zagadnienie ma status; zrzut czyta
`gen-blind-sheet.cjs`; wpis w rejestrze rozliczony. Wynik nie jest
porównaniem z próbą z 2026-11-03 (inne limity i liczby) — porównanie to
etap 3.

### 9.6. Przed PR

`pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration`, `pnpm build`,
pełny `pnpm test:e2e:shards` na buildzie produkcyjnym (AGENTS.md).

## 10. Dokumentacja

- PR wstępny: `architecture.md` §19 i `SPEC.md` (§5).
- Etap 1:
  - `docs/architecture.md` §19: podrozdział „Agent generujący pulę” (rdzeń,
    niezmiennik przyjęcia, `agentPolicy`, porty, kierownik, budżet, status: za
    flagą od etapu 2) i opis `pnpm probe:agent` (zmienne, format zrzutu,
    ślepa ocena) obok `probe:review`;
  - `AGENTS.md`: zdanie o `agentPolicy` w `SubjectModule` i o tym, że `ai` i
    `@openrouter/*` są dozwolone wyłącznie w adapterze (od etapu 2) i w
    `tests/probes`;
  - `provider-config.md` i `.env.example` — etap 2 (brak env w etapie 1);
  - API → MCP → `SKILL.md`: bez wpływu (generowanie nie jest wystawione);
    uzasadnienie w opisie PR.

## 11. Prywatność

- **Generator** (podagent, planer): materiał rodzica, polecenie rodzica,
  tematy zdań (gramatyka, ogrodzony blok danych jak w `lessonUserMaterial`),
  karty, przykłady i zdania do unikania — jak dzisiejszy generator.
- **Checker**: wyłącznie widoki ćwiczeń (§3.7), liczby odpowiedzi, odpowiedź
  i warianty (sędzia) oraz — tylko przy `checkerNeedsMaterial` — materiał.
  **Nie dostaje** polecenia rodzica, tematów zdań, kart, przykładów ani
  zdań do unikania. Test w §9.2.
- Nigdy imię, rok urodzenia, identyfikatory ani odpowiedzi dziecka.
- Logi bez treści (§7.4); `detail` tylko w pamięci i zrzucie próby poza
  repozytorium.
- Informacja dla rodzica o usłudze checkera — etap 2.

## 12. Ryzyka

- **Bramka podpowiedzi bez lematyzatora** — fałszywe odrzucenia mierzone w
  etapie 3 (kod `hint_reveals_answer`).
- **Pominięta kontrola przy awarii checkera** — licznik `checkUnavailable`;
  próg w etapie 3.
- **Paczkowy checker** może gorzej rozwiązywać długie paczki niż pojedyncze
  wywołania — przebieg kontrolny szkoły i etap 3 sprawdzają rozjazdy; w razie
  potrzeby limit pozycji w paczce.
- **Odrzucanie ujawnień miękkich** (krok 4) jest ostrzejsze niż dzisiejsza
  reguła generowania (tylko twarde) — zgodne z pokryciem publikacji, ale może
  wydłużyć pętlę; mierzone w etapie 3.
- **`ai@7.0.162`** — przypięte dokładnie; aktualizacja świadomie.

## 13. Rozstrzygnięcia review (wersja 2)

Krytycy: K1 — zgodność z kodem; K2 — architektura, prywatność, koszty; K3 —
cel, testy, zakres.

| Uwaga | Rozstrzygnięcie |
|---|---|
| Zdania kart rozjadą publikację z sesją (K2, K3); zapis do `lesson_context.examples` (K1, K3); gramatyka bez efektu (K1); pomiar raportem błędny (K1, K3) | Decyzja właściciela: tylko generowanie, osobny PR wstępny, tylko rozdział, źródła niezapisywane (§5) |
| Identyfikatory planu `d<deckId>` i składanie tematu (K1, K3) | `validateAgentPlan` bez składania; kierownik przez `buildDynamicTopicData` (§3.8, §7.1) |
| Walidacja tylko w zagadnieniu, limit słuchowy, słowa kluczowe, sieroty, wadliwe `fixed` (K1, K2, K3) | Walidacja całej lekcji, porównanie zbiorów błędów, `listenAllowance`, słowa kluczowe na końcu paczki, sieroty przy `remove` (§3.3) |
| Niepełna sanityzacja vs `acceptFreshLessonPool` (K1, K2) | Wspólna `sanitizeFreshLessonDraft` (§7.2) |
| Rundy naprawcze martwe; ofiary `fixed`; miejsce wstawienia (K2, K3) | Atomowe przyjęcie z ujawnieniami w obie strony i `fixed`; kontrola końcowa jako bezpiecznik; bez rund (§3.3, §3.6) |
| `complete` ≠ pokrycie publikacji i ignoruje `targetCount` (K1, K3) | `lessonCoverageGaps` + rezerwa + `targetCount`; liczby szkoły wyjaśnione (§3.5) |
| Brak kart własnego zagadnienia i przykładów kart (K1, K3) | `objective.cards`, `submit.examples`, `submitExamples` (§3.4, §6.1) |
| Równoległe narzędzia, spóźnione `submit` (K1, K2, K3) | Mutex zagadnienia, synchroniczna podmiana stanu, zamykanie narzędzi (§7.1) |
| Koszty dwoma kanałami, `null`, błędy, przekroczenie (K2, K3) | `RunCostSink` dla każdego żądania, szacunek `null`, budżet przed krokiem i checkerem, granica przekroczenia; `UsageRecorder` tylko w adapterze (§6.1, §7.3) |
| Koszt checkera w szkole (issue pkt 7) (K3) | Checker paczkowy, materiał raz na paczkę (§6.1) |
| Treść w `rejections` vs logi (K2) | `code` vs `detail` (§7.1, §7.4) |
| Terminy i przerwanie vs `withLessonGenerationControl` (K2) | Klasyfikacja po sygnale, `signal.reason`, `checkerTimeoutMs`, `runTimeoutMs` z polityki potoku (§7, §7.3) |
| Haki pod etap 2 (K2) vs nadmiar kierownika (K3) | Tylko `onObjectiveSettled`, `skipObjectives`, `initialSpentUsd`; bez rund naprawczych; `needs_review` w etapie 2 |
| `solverView` bez tematu; lista wykluczeń (K1, K3) | `solverView(draft, topic)` z listy dozwolonych pól + mapa pól w teście (§3.7) |
| Typ `checks`, `unchecked` (K3) | `CheckResult` `na`/`unavailable`/`done` (§3.3) |
| Bramka podpowiedzi niedookreślona; martwa część dla opcji i banku; prompt; „chyba że rodzic” (K1, K3) | Reguły tokenizacji i zgodności; usunięta martwa część; dopisek promptu; świadome odstępstwo (§4.4) |
| Planer: 3–5 w prompcie, `coverage` bez źródła, ukryty warunek (K3) | Dopisek nadrzędny, `planCoverage`, `objectiveSource` (§4, §7.1) |
| Cykl typów, `AgentCapableSubject`, filtr typów (K2) | Typy w `types.ts`, `asAgentCapable`, filtr w rdzeniu (§3, §3.5) |
| `pool` vs `targets`, `requiredTypes` jako proza, OpenRouter w porcie (K2) | `targets` jedynym źródłem; tablice typów; OpenRouter tylko w kontrakcie adaptera (§6.1) |
| Prywatność checkera opisana negatywnie (K2) | Pełna lista pozytywna i negatywna + test (§11) |
| Pliki próby: brakujące eksporty, `vitest.probe.config.ts`, `probe-helpers` na `main`, testy poza `test:unit`, słaby punkt odniesienia, karty w zrzucie (K1, K3) | Lista plików i eksportów, konfiguracje, zrzut końcowego szkicu, karty jako tablica (§8) |
| Eksport z `llm.ts`, `zod` (K1) | Dopisane (§8) |
| Skan identyfikatorów już istnieje (K1) | Opisany jako istniejący (§4, §9.4) |
| E2E niezgodne z AGENTS.md (K3) | Pełny `test:e2e:shards` (§9.6) |
| Przebieg kontrolny tylko na rozdziale (K3) | Szkoła + rozdział z kryteriami z góry (§9.5) |
| `precheck` może odsiać ujawnienia przed checkerem (K2) | Kroki 1–4 w `precheck`, sekwencyjnie (§3.3) |
| Dokumentacja (K3) | `architecture.md` z opisem próby; env w etapie 2 (§10) |

Poprawki po review planów (2026-11-04): `fixedSources` w
`resolveGenerationLeaks` i `cardExposureSources` zamiast doklejania zdań kart
do `existingExamples` (nowe przykłady zagadnienia nadpisywały wpis; §5);
`AgentObjective.exerciseTypes`; kody bramek przedmiotu (`exerciseGate` →
`{ code, reason }`); słowa kluczowe na końcu paczki także w `precheckBatch`;
porównanie odrzuceń po referencji z `existingExercises: []`; natychmiastowe
zamknięcie narzędzi, sygnał zagadnienia w checkerze i ponowne sprawdzenie
przed przyjęciem; terminy na `setTimeout`; kolejność `onObjectiveSettled`;
`cardSentences` z całej lekcji; przebiegi kontrolne z zgodą właściciela,
trzema przebiegami i limitami (§9.5).
