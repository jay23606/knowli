# Agent generujący pulę lekcji — etap 2b: kontrole modelem w szkole — design

Data: 2026-11-05. Issue: [#237](https://github.com/lookassh/knowli/issues/237).
Poprzednie etapy: [spec etapu 1](2026-11-04-lesson-pool-agent-stage1-design.md)
(rdzeń, porty, kierownik; #256) i [spec etapu 2a](2026-11-04-lesson-pool-agent-stage2a-design.md)
(adapter AI SDK, integracja z generowaniem, punkt kontrolny; #258).

Decyzje właściciela (czat 2026-11-05):

- odpowiedzi otwarte sprawdza **prawdziwy grader** (`UMIEM_GRADER_*`, prompt
  `school-grader-v3`, walidacja `validateSchoolVerdict`), składany także w
  workerze — kontrola sprawdza tę samą ścieżkę, którą potem przejdzie dziecko;
- zła podpowiedź (fakt spoza materiału, błąd polszczyzny, odpowiedź podana
  innymi słowami) → **odrzucenie z nazwaną przyczyną**; agent poprawia
  ćwiczenie w tej samej pętli;
- rozwiązujący pisze **dwie różne poprawne odpowiedzi**, a obie muszą zostać
  ocenione `knowledge = correct`; `partial` i `incorrect` odrzucają ćwiczenie;
- podejście **A**: dwie nowe metody checkera (`judgeHints`, `solveOpen`) i
  grader jako osobna zależność agenta; kontrakt metod checkera z 2a bez zmian;
- bez nowych zmiennych env.

Wersja 2 po review trzech krytyków (zgodność z kodem; architektura,
prywatność i koszty; cel, testy i zakres). Rozstrzygnięcia w §15.

## 1. Problem i zakres

W próbie z 2026-11-03 (issue, „Do rozwiązania” pkt 1) agent w szkole był
wyraźnie gorszy od dzisiejszego potoku. Stan pkt 1 issue po 2a:

| Część pkt 1 | Stan |
|---|---|
| za duża paczka, cele per przedmiot | 2a (cele i liczby z polityki przedmiotu) |
| ślepe rozwiązanie luk szkolnych, sędzia wariantów luk | etap 1/2a (`blindSolveTypes`, `variantCheckTypes`) |
| bramka deterministyczna podpowiedzi, `hint` tylko przy pytaniu otwartym | etap 1 (`hintRevealsAnswer`, `sanitize`, `promptNotes`) |
| teksty odrzuceń per przedmiot | etap 1 (`rejectionTexts`) |
| **podpowiedzi: fakty spoza materiału, polszczyzna, odpowiedź innymi słowami** | **2b (§4, §6)** |
| **odpowiedzi otwarte: `requiredElements` węższe niż polecenie** | **2b (§5, §6)** |
| błędy fleksji w samych ćwiczeniach (`prompt`, `answer`) | poza zakresem |
| słaby punkt odniesienia, nowy pomiar | etap 3 |

**W zakresie (jeden PR):**

1. Wspólne pola oceny pytania otwartego i wejście gradera dla dziecka i
   kontroli (§5.2) — pierwszy commit jako czysty refaktor.
2. Polityka przedmiotu (§3).
3. Port checkera: `judgeHints`, `solveOpen`, adapter AI SDK i fake (§4).
4. Grader w agencie: opcjonalny `RunCostSink`, etykieta kosztu, składanie w
   workerze (§5).
5. Przebieg paczki `submit_exercises`, decyzja, pamięć wyników w próbie runu (§6).
6. Limity, budżet, koszty i widoczność awarii (§7), prywatność (§8), panel
   rodzica (§9), konfiguracja i wdrożenie (§10).
7. Testy (§11) i dokumentacja (§12).

**Poza zakresem:** płatny pomiar i przełączenie domyślne (etap 3); pomiar
fałszywych odrzuceń sędziego i bramki (etap 3); lematyzator; trwały cache
werdyktów kontroli; sędzia podpowiedzi w gramatyce i rozdziale; punkty 2–7 z
„Do rozwiązania” w issue; usunięcie krytyka (etap 4); zmiany potoku;
pokazywanie rodzicowi liczby niesprawdzonych ćwiczeń (kandydat na etap 3).

**Moduł i zależności.** Obszar `materials`: kontrole w
`modules/materials/lessons/lesson-pool-agent-tools.ts`, decyzja w domenie
`domain/lessons/agent/admission.ts`, polityka w
`domain/lessons/subjects/school/agent-policy.ts`. Wspólne pola oceny i wejście
gradera trafiają do `modules/materials/lessons/lesson-grader-input.ts` i są
eksportowane przez barrel `modules/materials/index.ts`, bo używają ich agent
(`materials`) i próby dziecka (`learning`): `learning → materials` jest
dozwolonym kierunkiem, `materials` nie importuje `learning`, a domena nie może
importować `ports/ai.ts` (`GraderInput`). Bez nowych pakietów npm.

**Transakcje.** Bez zmian: wywołania modeli są poza transakcją, decyzja o
przyjęciu paczki zapada w pamięci kierownika w sekcji bez `await` między
odczytem stanu a `admitBatch`, a zapis do szkicu pozostaje jednym atomowym
zapisem na końcu runu (2a §10).

## 2. Słownik

- **Sędzia podpowiedzi** — wywołanie checkera `judgeHints`, ocenia `hint`.
- **Rozwiązujący otwarte** — wywołanie checkera `solveOpen`, pisze dwie
  odpowiedzi na pytanie otwarte bez klucza.
- **Kontrola otwarta** — `solveOpen`, dopasowanie deterministyczne i ocena
  graderem (§6.2).
- **Niesprawdzone** — kontrola była należna, ale nie dała wyniku; ćwiczenie
  jest przyjmowane z notą `unchecked` (jak w 2a).
- **Nie dotyczy** — kontrola nie jest należna (typ spoza listy, pusta
  podpowiedź, brak gradera, wyłącznik awarii §7.4); bez wywołania i bez noty.

## 3. Polityka przedmiotu

`SubjectAgentPolicy` (`domain/lessons/types.ts`) dostaje opcjonalne pola:

```ts
/** Typy, w których sędzia podpowiedzi ocenia niepusty `hint`. Brak = pusta lista. */
readonly hintJudgeTypes?: readonly LessonExerciseType[];
/** Typy sprawdzane kontrolą otwartą (rozwiązujący + grader). Brak = pusta lista. */
readonly openAnswerCheckTypes?: readonly LessonExerciseType[];
```

`rejectionTexts` dostaje opcjonalne pola `hintUnsupported`, `hintLanguage`,
`hintReveals`, `openMissing`, `openWrong` (szablony po angielsku, §6.4).

| Przedmiot | `hintJudgeTypes` | `openAnswerCheckTypes` |
|---|---|---|
| `school` | `lesson_open_answer` | `lesson_open_answer` |
| `english_grammar`, `english_chapter` | brak | brak |

Test polityk pilnuje:

- typy z list należą do typów przedmiotu;
- niepusta lista ma komplet swoich tekstów;
- niepuste `hintJudgeTypes` wymaga `checkerNeedsMaterial: true` (sędzia
  sprawdza fakty względem materiału).

W szkole `sanitize` usuwa `hint` z innych typów, więc sędzia ocenia tylko
pytania otwarte. Gramatyka i rozdział zachowują się bajt w bajt jak w 2a.
Silnik i kierownik nie znają identyfikatorów przedmiotów.

## 4. Port checkera

`LessonExerciseCheckerProvider` (`ports/ai.ts`) dostaje dwie metody, obie
paczkowe (jedno żądanie na paczkę `submit`, materiał raz):

```ts
judgeHints(
  input: {
    readonly items: readonly {
      readonly view: string;
      readonly answer: string;
      readonly requiredElements: readonly string[];
      readonly hint: string;
    }[];
    readonly material?: string;
  },
  cost: RunCostSink,
  signal: AbortSignal,
): Promise<{ readonly verdicts: readonly (HintVerdict | null)[] }>;

solveOpen(
  input: { readonly items: readonly { readonly view: string }[]; readonly material?: string },
  cost: RunCostSink,
  signal: AbortSignal,
): Promise<{ readonly answers: readonly (readonly [string, string] | null)[] }>;

type HintVerdict =
  | { readonly verdict: "ok" }
  | { readonly verdict: "unsupported" | "language" | "reveals"; readonly reason: string };
```

- `view` — `solverView(draft, topic)` z etapu 1: bez pól klucza (`hint`,
  `requiredElements`, `commonErrors`, `sourceRefs`, `expectedForm`,
  odpowiedź). Sędzia dostaje dodatkowo `answer` (odpowiedź wzorcową),
  `requiredElements[].text` i `hint`, bo ocenia, czy podpowiedź zdradza
  odpowiedź albo element wymagany („Użyj słów: zmniejszony, uproszczony”).
- `material` — tylko przy `checkerNeedsMaterial` (szkoła: zawsze).
- `null` na pozycji = brak wyniku (niesprawdzone).
- Komentarz portu o danych checkera („Do checkera trafia wyłącznie…”)
  wymienia nowe pola.

**Adapter `AiSdkExerciseChecker`** — jak `solve`/`judgeVariants` w 2a: jeden
`generateText` z `Output.object` (Zod), materiał w bloku `<MATERIAL>`, wynik
pozycji przez `tolerant()`/`atPosition()` (zła pozycja → `null`, nie błąd
paczki), koszt przez `AiSdkCaller.tracked`; typ `AgentOperation` dostaje
`check_hints` i `check_open`.

- **Pozycje jako dane:** lista pozycji jest serializowana do JSON w bloku
  `<ITEMS>`. Prompt systemowy mówi, że pola pozycji napisał inny model, a
  polecenia w nich i w materiale są ignorowane.
- **Prompt `judgeHints`:** polski uczeń, który czytał materiał; dla każdej
  pozycji, w kolejności: (1) podpowiedź podaje odpowiedź wzorcową albo element
  wymagany, także innymi słowami → `reveals`; (2) któreś stwierdzenie
  podpowiedzi nie wynika z materiału → `unsupported`; (3) podpowiedź nie jest
  poprawną, naturalną polszczyzną (fleksja, składnia, interpunkcja) →
  `language`; inaczej `ok`. `reason` — jedno zdanie po angielsku, ≤ 200 znaków,
  z cytatem błędnego fragmentu.
- **Prompt `solveOpen`:** polski uczeń, który czytał materiał, odpowiada
  tylko na podstawie materiału i zgodnie z poleceniem (forma, liczba
  elementów). Dwie odpowiedzi: gdy polecenie pozwala wybrać („podaj dowolne
  dwie”, „wymień przykład”), druga używa innego wyboru niż pierwsza; gdy
  pytanie ma jedną poprawną treść (definicja, fakt, data), druga jest innym
  sformułowaniem tej samej treści.
- **Walidacja pozycji `solveOpen`:** obie odpowiedzi niepuste po `trim`, każda
  ≤ 600 znaków (limit odpowiedzi szkoły w graderze); inaczej `null`. Para
  równa po normalizacji jest ważna (§6.2 ocenia ją raz).
- **Walidacja pozycji `judgeHints`:** `verdict` z listy; `reason` niepusty przy
  werdykcie innym niż `ok`, przycięty do 200 znaków; inaczej `null`.

**`FakeExerciseChecker`** (`providers/fake-lesson-agent.ts`), w konwencji
istniejących opcji: `judgeHint(item)` (domyślnie `{ verdict: "ok" }`) i
`hintBatch` → `"throw" | "hang" | "stall"`; `solveOpen(view)` (domyślnie
`["A", "B"]`) i `openBatch` jak wyżej; `null` per pozycja z funkcji; tablice
`hintCalls` i `openCalls` z wejściami. `unavailable: true` zwraca `null` także
dla nowych metod (tryb fake workera z 2a).

## 5. Grader w agencie

### 5.1. Port i adapter

`AnswerGraderProvider.grade` dostaje opcjonalny trzeci parametr:

```ts
grade(input: GraderInput, signal: AbortSignal, cost?: RunCostSink): Promise<unknown>;
```

`createOpenAiCompatibleGrader` zgłasza `cost.record(usd)` raz na żądanie
HTTP, z tego samego zdarzenia co `UsageRecorder` i według reguł 2a
(`architecture.md` §23): odpowiedź spoza 2xx → `0`; brak odpowiedzi albo
nieczytelne ciało 2xx → `null`; odpowiedź 2xx → `usage.cost` z treści, gdy
dostawca go podaje, inaczej `null`. Opcja adaptera `usageLabel?: { feature:
"lesson_generation"; operation: "check_grade" }` zastępuje etykietę zapisu
(`answer_grading` / `grade_school`). Bez opcji i bez `cost` zachowanie jest
dzisiejsze; web woła `grade(input, signal)` bez zmian. Komentarz pola
`GraderInput.childAnswer` mówi, że w kontroli to odpowiedź rozwiązującego.

`FakeAnswerGrader` (`providers/fake.ts`) przyjmuje `cost` i zgłasza stały
koszt z opcji (testy budżetu).

### 5.2. Wspólne pola oceny i wejście gradera

Dziś pola oceny pytania otwartego liczy materializacja
(`modules/learning/lessons/lesson-materialize.ts`), a `GraderInput` buduje
`buildGraderInput` (`modules/learning/lessons/lesson-attempts.ts`) z wiersza
zadania i klucza. Obie derywacje przenoszę do
`modules/materials/lessons/lesson-grader-input.ts` (eksport przez barrel
`materials`):

```ts
/** Pola widoczne i kryteria pytania otwartego — te same dla dziecka i kontroli. */
export function openAnswerGradingFields(
  draft: LessonExerciseDraft,
  topic: LessonTopic,
): { readonly instruction: string; readonly stimulus: string; readonly schoolCriteria: SchoolCriteria | undefined };

/** Wejście gradera z pól oceny, celu i odpowiedzi (dziecka albo rozwiązującego). */
export function lessonGraderInput(args: {
  readonly subject: SubjectModule;
  readonly topic: LessonTopic;
  readonly objective: LearningObjective;
  readonly instruction: string;
  readonly stimulus: string | null;
  readonly answer: string;
  readonly acceptedAnswers: readonly string[];
  readonly schoolCriteria: SchoolCriteria | undefined;
  readonly answerText: string;
}): GraderInput;
```

- `openAnswerGradingFields`: `instruction = instructionPl ??
  transformInstruction(topic, draft) ?? objective.titlePl ?? ""` (ten sam
  łańcuch co dziś w materializacji i `instructionOf` w `solver.ts`),
  `stimulus = prompt ?? ""`, `schoolCriteria` z `requiredElements`,
  `supplementaryElements`, `commonErrors`, `expectedForm` i
  `sourceRefs[].quote` (dziś `lesson-materialize.ts`). Materializacja woła ją
  zamiast własnej kopii.
- `lessonGraderInput`: dzisiejsza treść `buildGraderInput` — `question =
  stimulus ?? instruction`, `modelAnswer = answer`, `expectedForm` domyślnie
  `"explanation"`, `errorCategories` z etykietami (`categoryLabels`: baza ∪
  przedmiot ∪ temat, przeniesione razem), `answerText` przycięty do 600
  znaków przy szkole, 200 bez. `buildGraderInput` deleguje do niej.
- `SchoolCriteria` — nowy nazwany typ w `domain/lessons/types.ts` o
  dzisiejszym kształcie pola `schoolCriteria` klucza zadania (`commonErrors` i
  `expectedForm` opcjonalne); klucz używa tego typu.
- **Cel w kontroli:** `state.topic.objectives` — dla szkoły temat z
  `buildDynamicTopic`, ten sam, z którego materializacja bierze
  `objectiveSnapshot`.
- **Test zgodności:** `GraderInput` kontroli dla ćwiczenia równa się wejściu,
  które dostałoby dziecko po materializacji tego samego ćwiczenia (ta sama
  odpowiedź).
- Weryfikacja werdyktu: `validateSchoolVerdict(raw, { requiredElementIds,
  childAnswer: odpowiedź rozwiązującego, formOk: null })`.

### 5.3. Składanie

- `agentGraderFromEnv(env, usage?): { provider: AnswerGraderProvider;
  timeoutMs: number } | undefined` w `config.ts` — ta sama konfiguracja co
  `graderFromEnv` (`graderConnectionFromEnv`, rezerwa `OPENROUTER_API_KEY`,
  dodatki żądania, `UMIEM_GRADER_TIMEOUT_MS`, domyślnie 8000), z `usageLabel`
  §5.1. Brak konfiguracji → `undefined`; częściowa → ten sam błąd startu co
  `graderFromEnv`.
- `LessonAgentDeps` dostaje `grader?: { provider; timeoutMs }`.
  `lessonAgentDepsFromEnv` dokłada go w trybie rzeczywistym; w trybie fake
  grader nie jest składany.
- Przekazanie wewnątrz agenta: `LessonPoolAgentDeps`, wywołanie
  `runLessonPoolAgent` w `lesson-agent-generation.ts` i `ObjectiveToolsArgs`
  dostają `grader?`.
- Statystyki (`ObjectiveToolsStats`, `LessonPoolAgentStats`, `emptyStats` i
  literały w `lesson-agent-generation.ts`) dostają liczniki §7.4. `grade` nie
  wlicza się do `checkerCalls`.
- Format punktu kontrolnego bez zmian (`rejectionCodes` to otwarta mapa
  kodów); podsumowanie runu dostaje liczniki §7.4.
- Web bez zmian poza panelem (§9).

## 6. Przebieg paczki `submit_exercises`

### 6.1. Należne kontrole

Dla każdej pozycji, która przeszła `precheckBatch` (kroki 1–4 z 2a, w tym
bramka deterministyczna `hint_reveals_answer`):

- **sędzia podpowiedzi** — typ w `hintJudgeTypes` i `hint.trim() !== ""`;
- **kontrola otwarta** — typ w `openAnswerCheckTypes`, `grader` istnieje i
  wyłącznik awarii (§7.4) nie jest otwarty.

Brak gradera albo otwarty wyłącznik: kontrola otwarta nie dotyczy, `solveOpen`
nie jest wołany.

### 6.2. Kolejność

1. **Pamięć próby runu** (§6.3): pozycje z zapamiętanym wynikiem nie są wysyłane
   ponownie.
2. **Etap 1, równolegle** (`Promise.all`): `solve`, `judgeVariants` (2a),
   `judgeHints`, `solveOpen` — każde tylko przy niepustym zbiorze pozycji,
   każde przez `callChecker` bez zmian względem 2a (miejsce w semaforze
   checkera, własny termin `checkerTimeoutMs` liczony od zajęcia miejsca,
   sprawdzenie budżetu i zamknięcia). Wywołania etapu 1 zwalniają miejsca
   przed etapem 2.
3. **Etap 2** — dla każdej pozycji z parą z `solveOpen`, osobno dla każdej
   odpowiedzi:
   - **dopasowanie deterministyczne** jak u dziecka: odpowiedź równoważna
     `answer` albo któremuś z `acceptedAnswers` po normalizatorze przedmiotu
     (`answersEquivalent`) liczy się jako `correct` bez wywołania gradera;
   - druga odpowiedź równa pierwszej po normalizacji dziedziczy jej wynik
     (jedno wywołanie);
   - pozostałe → `callGrader` (§7.2). Wszystkie wywołania etapu 2 paczki
     startują równolegle w granicach semafora gradera.
4. **Decyzja:** `admitBatch` w tej samej sekcji krytycznej co dziś, po
   zakończeniu obu etapów.

### 6.3. Pamięć wyników w próbie runu

Wyniki `done` są zapamiętywane w pamięci próby runu (nie w bazie, nie w
punkcie kontrolnym; `AgentCheckRun` powstaje przy każdym wywołaniu
`runLessonPoolAgent`, więc po ponowieniu zadania pamięć startuje pusta):

- werdykt podpowiedzi — klucz: odcisk `(view, answer, requiredElements, hint)`;
- wynik kontroli otwartej — klucz: odcisk `(objectiveId, exerciseType, view,
  answer, acceptedAnswers, schoolCriteria)` (wejście gradera zależy od celu,
  §16 nota 15).

Poprawka samej podpowiedzi nie powtarza więc kontroli otwartej, a poprawka
samych kryteriów lub wariantów — werdyktu podpowiedzi. Wyniki `unavailable`
nie są zapamiętywane.

### 6.4. Wynik kontroli i decyzja

`CandidateChecks` (`domain/lessons/agent/admission.ts`) dostaje pola:

```ts
readonly hint: CheckResult<HintVerdict>;
readonly open: CheckResult<OpenCheckOutcome>;

type OpenCheckOutcome = { readonly answers: readonly [OpenGraded, OpenGraded] };
type OpenGraded = {
  readonly answer: string;
  readonly knowledge: "correct" | "partial" | "incorrect";
  /** Teksty brakujących elementów (`missingElementIds` → `requiredElements[].text`). */
  readonly missing: readonly string[];
  /** `incorrectStatements` i `confusedConcepts` (jako „said → meant”). */
  readonly wrong: readonly string[];
};
```

Kontrola otwarta jest `done` tylko wtedy, gdy obie odpowiedzi mają wynik
(dopasowanie albo ważny werdykt). Błąd, termin, `null` z `solveOpen` albo
werdykt odrzucony przez `validateSchoolVerdict` przy którejkolwiek odpowiedzi
→ `unavailable`.

`Rejection.kind` dostaje wartości `hint` i `open`. Kroki 2a (ślepe
rozwiązanie, warianty) działają jak dziś; **podpowiedź i kontrola otwarta są
oceniane razem**: gdy obie odrzucają, pozycja dostaje jedno odrzucenie z
kodem pierwszej (podpowiedź) i oba powody w `reasons`, więc agent poprawia
wszystko w jednym kroku.

| Wynik | Decyzja | Kod | Treść dla modelu |
|---|---|---|---|
| `hint: unsupported` | odrzucenie, `hint` | `hint_unsupported` | `hintUnsupported` + `reason` |
| `hint: language` | odrzucenie, `hint` | `hint_language` | `hintLanguage` + `reason` |
| `hint: reveals` | odrzucenie, `hint` | `hint_reveals_paraphrase` | `hintReveals` + `reason` |
| `open`: pierwsza nieprzyjęta odpowiedź ma niepuste `wrong` albo `knowledge = incorrect` | odrzucenie, `open` | `open_not_accepted` | `openWrong` + odpowiedź + brakujące elementy (gdy są) + błędne stwierdzenia (gdy są) |
| `open`: pierwsza nieprzyjęta odpowiedź `partial` bez `wrong` | odrzucenie, `open` | `open_not_accepted` | `openMissing` + odpowiedź + brakujące elementy |
| którakolwiek należna kontrola `unavailable`, żadna nie odrzuca | przyjęcie | — | nota `unchecked` |
| reszta | przyjęcie | — | — |

Odrzucenie ma pierwszeństwo przed notą. Kod `hint_reveals_paraphrase` jest
osobny od `hint_reveals_answer` bramki deterministycznej (rodzaj `rule`), żeby
etap 3 rozróżnił fałszywe odrzucenia sędziego i bramki.

**Teksty szkoły** (`rejectionTexts`, po angielsku):

- `hintUnsupported`: „The hint states something the material does not
  support. Rewrite the hint using only facts from the material, or set hint
  to null.”
- `hintLanguage`: „The hint is not correct Polish. Fix the wording, or set
  hint to null.”
- `hintReveals`: „The hint gives away the answer or a required element in
  other words. Hint at the reasoning, not the content, or set hint to null.”
- `openMissing`: „A correct answer that follows the question was not
  accepted: it lacks required elements the question does not actually
  demand. Make requiredElements match what the question asks (for “any two”,
  require what every valid choice satisfies and move specific examples to
  supplementaryElements), or make the question ask for exactly those
  elements. Do not drop elements the question genuinely requires; if the
  answer below is wrong according to the material, make the question more
  precise.”
- `openWrong`: „An answer based on the material was graded as containing
  errors. Check that the model answer and the criteria agree with the
  material; if the answer below is wrong according to the material, make the
  question more precise or add the mistake to commonErrors.”

Treść dla modelu łączy szablon, powód i dane w jeden wiersz `reasons` (jak w
2a). `detail` odrzucenia (odpowiedź rozwiązującego, elementy, stwierdzenia)
zostaje wyłącznie w pamięci wyniku i w zrzucie próby; nie trafia do punktu
kontrolnego ani logów (2a §8).

### 6.5. Tryby i wznowienie

- Kontrole działają w pełnej generacji i w „Dogeneruj +N” (2a §6.4).
- Ćwiczenia przyjęte przed wznowieniem z punktu kontrolnego (także
  `unchecked`) nie są sprawdzane ponownie.
- Zagadnienie, które wyczerpie kroki na odrzuceniach, kończy jak w 2a: jako
  niepełne w `generationGaps`, z alertem „Dogeneruj” dla rodzica;
  histogram odrzuceń liczy nowe kody.

## 7. Limity, budżet, koszty, awarie

### 7.1. Checker (etap 1)

Bez zmian względem 2a: `check_hints` i `check_open` zajmują miejsca wspólnego
semafora checkera (`checkerConcurrency`, domyślnie 4) i mają własny termin
`checkerTimeoutMs` (domyślnie 90 s) od zajęcia miejsca.

### 7.2. Grader (etap 2)

- **Osobny semafor gradera** całego runu, `graderConcurrency = 4` — stała w
  `LessonAgentPolicy` (bez env); grader to inna usługa i nie czeka za
  90-sekundowymi wywołaniami checkera.
- `callGrader`: po zajęciu miejsca ponownie sprawdza budżet, zamknięcie
  narzędzi i wyłącznik; sygnał `AbortSignal.any([sygnał zamknięcia narzędzi,
  AbortSignal.timeout(grader.timeoutMs)])`.
- **Limit etapu 2:** `graderStageTimeoutMs = 30_000` (stała polityki) liczony
  od startu etapu; po nim pozostałe wywołania są przerywane, a ich pozycje
  niesprawdzone. Etap 2 trwa więc zwykle najwyżej 30 s ponad etap 1 jak w
  2a; oczekiwanie na miejsce w semaforze (checkera i gradera) nie jest
  przerywalne (jak checker w 2a), więc przy dużej konkurencji krok narzędzia
  może trwać dłużej (§13).
- `callChecker` i `callGrader` dzielą logikę budżetu, zamknięcia i statystyk
  (wspólna funkcja generyczna); `callChecker` zachowuje kontrakt 2a.

### 7.3. Budżet i koszty

- Koszt wszystkich nowych wywołań trafia do `RunCostSink` runu (`runBudgetUsd`,
  domyślnie 1 USD). Wyczerpany budżet przed wywołaniem = niesprawdzone, bez
  wywołania.
- **Nieznany koszt gradera** (dostawca bez `usage.cost`): kierownik liczy
  `unknownGraderCallEstimateUsd = 0.002` (stała polityki) zamiast ogólnego
  `unknownCallEstimateUsd = 0.02`, żeby grader spoza OpenRouter nie wyczerpał
  budżetu runu i nie zatrzymał agenta.
- `UsageRecorder`: jeden wiersz na żądanie HTTP, `lesson_generation` /
  `check_hints`, `check_open` (adapter agenta, `provider: openrouter`) i
  `check_grade` (adapter gradera, dostawca z `UMIEM_GRADER_BASE_URL`).
- **Szacunek** (do sprawdzenia w etapie 3): lekcja szkolna ma ok. 4–5
  zagadnień × 2 pytania otwarte, średnio 1,5 próby na pytanie → ok. 15 kontroli
  otwartych. Grader: 15 × 2 × ~0,0005 USD ≈ 0,015 USD (mniej przy dopasowaniu
  deterministycznym i pamięci §6.3). `check_open` i `check_hints`: po jednym
  wywołaniu na paczkę z pytaniem otwartym, ok. 10–15 paczek × 2 ×
  (materiał ~4k tokenów) × cena checkera ≈ 0,02–0,05 USD. Razem ok.
  +0,03–0,07 USD do przebiegu kontrolnego 2a (0,142 USD); najgorszy przypadek
  przy wszystkich krokach na odrzuceniach ok. +0,15 USD, w granicach budżetu.

### 7.4. Widoczność awarii i wyłącznik

- **Log startu runu** `[lesson-agent]`: `hintJudge=on|off openCheck=on|off`
  (off: brak gradera albo przedmiot bez list).
- **Liczniki** w statystykach i w podsumowaniu runu (bez treści):
  `hintChecks`, `openChecks`, `graderCalls`, `hintUnavailable`,
  `openUnavailable`, `graderErrors`, `graderInvalidVerdicts`.
- **Wyłącznik:** po 3 kolejnych nieudanych wywołaniach gradera w próbie runu (błąd,
  własny termin gradera `UMIEM_GRADER_TIMEOUT_MS`, werdykt odrzucony przez
  walidację) agent przestaje wołać grader; przerwanie wywołania limitem etapu 2
  (`graderStageTimeoutMs`, §7.2) **nie jest awarią gradera** — nie zwiększa
  `graderErrors` ani licznika porażek, a pozycja jest po prostu niesprawdzona;
  kontrola otwarta nie dotyczy do końca próby runu (także pozycji paczki,
  której etap 1 trwał w chwili otwarcia wyłącznika: bez noty i bez
  `openUnavailable`), a log zapisuje raz na próbę `grader_unavailable`. Udane
  wywołanie zeruje licznik kolejnych porażek. Wyłącznik żyje w `AgentCheckRun`
  próby (§6.3): po ponowieniu zadania startuje zamknięty, więc
  `grader_unavailable` może się zalogować ponownie.

## 8. Prywatność

Bez nowych rodzajów danych w usługach zewnętrznych:

| Usługa | Dostaje | Nigdy |
|---|---|---|
| sędzia podpowiedzi (checker) | widok ćwiczenia, odpowiedź wzorcową, teksty `requiredElements`, podpowiedź, materiał | polecenia rodzica, tematów zdań, kart, danych dziecka |
| rozwiązujący otwarte (checker) | widok ćwiczenia bez klucza, materiał | jak wyżej oraz klucza (`requiredElements`, cytatów, podpowiedzi, `expectedForm`) |
| grader (kontrola) | to samo co przy dziecku (`GraderInput`: treść, kryteria, cytaty z materiału), z odpowiedzią rozwiązującego zamiast odpowiedzi dziecka | całego materiału, danych dziecka, polecenia rodzica, tematów zdań |

- Werdykty kontroli nie trafiają do `lesson_verdicts` (cache ocen dziecka).
- Zakres kosztów w workerze to run, nie dziecko (2a).
- Logi `[lesson-agent]`: liczniki i kody, bez podpowiedzi, odpowiedzi
  rozwiązującego, powodów i elementów.
- Punkt kontrolny: bez `detail` (2a §8).
- Token gradera tylko w adapterze; błędy bez treści żądania i odpowiedzi.
- Kid DTO, `learning-overview`, MCP i `SKILL.md` bez zmian: generowanie i
  katalog nie są częścią MCP, a nowe pole panelu (§9) jest tylko w DTO
  katalogu rodzica.

## 9. Panel rodzica

- `checkServiceInfoWithMaterial` (szkoła) — nowy tekst: „Podczas
  przygotowania lekcji drugi model ({service}) rozwiązuje ćwiczenia na próbę,
  sprawdza podpowiedzi i pisze próbne odpowiedzi na pytania otwarte. Dostaje
  ćwiczenia i materiał lekcji — nigdy imienia, wieku ani odpowiedzi dziecka.”
  (po przeglądzie końcowym, §16).
- Nowe opcjonalne pole katalogu przedmiotu `openCheckService?: string` i
  komunikat `openCheckServiceInfo`: „Odpowiedzi próbne do pytań otwartych
  ocenia usługa oceny ({service}). Dostaje pytanie, kryteria i cytaty z
  materiału — bez danych dziecka.”
- Pole wypełnia web dla przedmiotów agenta z niepustym
  `openAnswerCheckTypes`, gdy jego env ma pełną konfigurację gradera —
  przez wersję sprawdzenia, która nie rzuca (`lessonAgentPublicFromEnv` nie
  może rzucać); w trybie fake pole jest puste.
- Grader nie trafia do `generationServices` (to usługi, które dostają cały
  materiał).

## 10. Konfiguracja i wdrożenie

- Kontrola otwarta działa tylko wtedy, gdy **worker** ma pełną konfigurację
  `UMIEM_GRADER_*` (adres, model; klucz albo rezerwa `OPENROUTER_API_KEY`).
  Bez niej nie dotyczy (log startu §7.4), a reszta agenta działa jak w 2a.
- Grader jest domyślnie włączony, gdy jest `OPENROUTER_API_KEY`
  (`config-defaults.ts`), więc kontrola otwarta działa wtedy też domyślnie
  dla przedmiotów agenta. Osobnego wyłącznika kontroli nie ma (decyzja: bez
  nowych env, §13).
- Sędzia podpowiedzi korzysta z checkera agenta
  (`UMIEM_LESSON_AGENT_CHECKER_*`).
- Bez migracji. Agent nadal domyślnie wyłączony (`UMIEM_LESSON_AGENT_SUBJECTS`).

## 11. Testy

Każdy przypadek: wejście → oczekiwany wynik.

**Domena (`admission`, także `admission.property.test.ts` rozszerzony o nowe
pola):**

- `hint` `unsupported`/`language`/`reveals` → odrzucenie z kodami
  `hint_unsupported`/`hint_language`/`hint_reveals_paraphrase` i tekstami;
- `open` obie `correct` → przyjęcie; jedna `partial` z `missing` → `openMissing`
  z pierwszą nieprzyjętą odpowiedzią i elementami; `partial` z pustym
  `missing` i niepustym `wrong` → `openWrong`; `incorrect` → odrzucenie;
- `hint: reveals` i `open: partial` na jednej pozycji → jedno odrzucenie,
  kod `hint_reveals_paraphrase`, oba powody;
- `unavailable` jednej kontroli, druga `ok` → przyjęcie z notą; `unavailable`
  jednej i odrzucenie drugiej → odrzucenie;
- gramatyka i rozdział (puste listy) → wyniki identyczne jak w 2a (istniejące
  testy bez zmian).

**Polityki:** zgodność typów, komplet tekstów, `hintJudgeTypes` ⇒
`checkerNeedsMaterial`.

**Wejście gradera:** testy prób dziecka i materializacji bez zmian po
refaktorze; test zgodności §5.2 (z `instructionPl`, bez niego — tytuł celu,
bez `commonErrors`/`expectedForm`).

**Narzędzia modułu (`lesson-pool-agent-tools`)** — z `FakeExerciseChecker` i
`FakeAnswerGrader` zwracającym werdykt, który dzieli `requiredElementIds` na
`matched`/`missing` w całości (fixture `schoolVerdictFor(ids, missing)`):

- hint `"   "` → brak wywołania `judgeHints`;
- typ spoza listy, gramatyka lub rozdział ze skonfigurowanym graderem → 0
  wywołań `solveOpen` i `grade`;
- brak gradera → 0 wywołań `solveOpen`, log `openCheck=off`;
- odpowiedź równoważna `answer` → brak wywołania `grade`, wynik `correct`;
- para `["Wisła", "wisła."]` → jedno wywołanie `grade`, kontrola `done`;
- etap 1 poprawny, grader `hang` → po `graderStageTimeoutMs` kontrola otwarta
  `unavailable`, werdykt podpowiedzi nadal odrzuca;
- budżet wyczerpany po etapie 1 → 0 wywołań `grade`, `unavailable`;
- grader bez kosztu (`null`) → budżet liczy 0,002 USD na wywołanie;
- 3 kolejne błędy gradera → kolejne paczki bez `solveOpen` i `grade`, log
  `grader_unavailable` raz;
- `validateSchoolVerdict` odrzuca werdykt → `unavailable`,
  `graderInvalidVerdicts` + 1;
- ponowne zgłoszenie ćwiczenia ze zmienioną tylko podpowiedzią → bez
  ponownego `solveOpen`/`grade` (pamięć §6.3);
- zamknięcie narzędzi w trakcie `grade` → przerwanie, brak wiszących obietnic;
- brak `await` w sekcji krytycznej (istniejący test).

**Adapter AI SDK (`MockLanguageModel`):** prompty `judgeHints`/`solveOpen`
zawierają wyłącznie dozwolone pola (asercje braku polecenia rodzica, tematów
zdań, kart, a w `solveOpen` pól klucza); pozycje w bloku `<ITEMS>` jako JSON;
pozycja z tekstem w stylu polecenia dla sędziego nie zmienia formatu wyniku;
zła pozycja → `null`; pusta odpowiedź albo > 600 znaków → `null`; operacje
`check_hints`, `check_open`.

**Adapter gradera:** z `usageLabel` i `cost` — etykieta `check_grade`, 2xx z
kosztem → koszt, spoza 2xx → 0, sieć → `null`; bez opcji i bez `cost` —
dzisiejsze testy bez zmian (etykieta `answer_grading`).

**Konfiguracja i składanie:** `agentGraderFromEnv` (pełna → provider i
`timeoutMs`, brak → `undefined`, częściowa → błąd jak `graderFromEnv`);
`lessonAgentDepsFromEnv` dokłada grader tylko w trybie rzeczywistym.

**Architektura:** test `usage-recording.architecture.test.ts` bez zmian (nowe
metody nie dodają miejsc `fetch`); granice modułów — `learning` importuje
`lesson-grader-input` przez barrel `materials`.

**Integracja (`tests/integration/lesson-agent-generation.test.ts`, lekcja
szkolna):**

- grader fake ocenia jedną odpowiedź `partial` → ćwiczenie wraca z
  `open_not_accepted`, poprawka przechodzi i trafia do szkicu;
- powtarzane `open_not_accepted` do `maxSteps` → zagadnienie niepełne w
  `generationGaps`, histogram z `open_not_accepted`;
- grader rzuca → przyjęcie z notą, liczniki w podsumowaniu runu;
- bez gradera → zero wywołań `solveOpen` i gradera;
- sędzia `unsupported` → odrzucenie i poprawka;
- „Dogeneruj +N” w szkole → kontrole działają.

**Panel:** katalog szkoły z `openCheckService` i bez; tryb fake bez pola;
teksty komunikatów.

**Przed PR:** `pnpm typecheck`, `pnpm test:unit`,
`pnpm test:integration:shards`, `pnpm build`, `pnpm test:e2e:shards`.

**Bez płatnych wywołań.** `pnpm probe:agent` może dostać nowe kontrole, ale
uruchomienie z kluczem tylko za zgodą właściciela (etap 3).

## 12. Dokumentacja

- `docs/architecture.md` §19.17 (kontrole szkoły, kolejność, wyniki,
  wyłącznik), §23 (`check_hints`, `check_open`, `check_grade`, nieznany koszt
  gradera) i sekcja gradera (użycie w workerze do kontroli).
- `docs/superpowers/specs/2026-11-02-llm-cost-tracking-design.md` — wiersz
  `lesson_generation` z nowymi operacjami i wiersz `answer_grading` (proces
  web; w workerze ten sam adapter zapisuje `lesson_generation`/`check_grade`).
- `docs/provider-config.md` i `.env.example` — `UMIEM_GRADER_*` także w
  workerze dla kontroli otwartej.
- `docs/SPEC.md` §29a.10 — kontrole modelem w szkole.
- `AGENTS.md` — punkt agenta puli (sędzia podpowiedzi, rozwiązujący otwarte,
  grader w workerze, dane §8) i punkt modelu oceniającego (także worker, dla
  kontroli; dostaje odpowiedzi rozwiązującego, nigdy dziecka; bez zapisu do
  `lesson_verdicts`).
- Komentarze w `ports/ai.ts` (dane checkera, `GraderInput.childAnswer`).
- Opis PR: wpływ API → MCP → `SKILL.md` (bez zmian, uzasadnienie §8),
  wdrożenie (`UMIEM_GRADER_*` w workerze).

## 13. Znane ograniczenia

- **Fałszywe odrzucenia:** sędzia, rozwiązujący i grader mogą się mylić na
  poprawnym ćwiczeniu; agent poprawia je w pętli, co kosztuje kroki i może
  zostawić zagadnienie niepełne. Skalę mierzy etap 3 (próg „niepełne
  zagadnienia”).
- **Luzowanie kryteriów:** odrzucenie `open_not_accepted` może pchać agenta
  do zbyt luźnych `requiredElements`. Teksty §6.4 temu przeciwdziałają; etap 3
  porównuje liczbę elementów wymaganych z potokiem.
- **Dwie odpowiedzi** zwiększają szansę fałszywego odrzucenia (decyzja
  właściciela) w zamian za wykrywanie zbyt wąskich kryteriów.
- **Brak osobnego wyłącznika kontroli:** wyłączenie kontroli otwartej
  wymaga zdjęcia gradera z env workera (co nie wpływa na ocenę dziecka w web).
- **Panel a env workera:** web pokazuje usługę oceny według własnego env.
- **Edycja przed publikacją:** gdy rodzic zmieni treść albo kryteria
  ćwiczenia, dziecko dostanie inne wejście gradera niż kontrola.
- **Kontrola nie zastępuje oceny dziecka:** sprawdza, że istnieją poprawne
  odpowiedzi, które grader zalicza; odpowiedź dziecka może zostać oceniona
  inaczej (`formOk`, inna treść).
- **Fleksja w samych ćwiczeniach** pozostaje bez kontroli modelem.
- **Czas kroku przy konkurencji:** oczekiwanie na miejsce w semaforze
  checkera albo gradera nie jest przerywalne (jak checker w 2a); limit etapu 2
  (30 s) liczy się od startu etapu, więc przy zajętych semaforach krok
  narzędzia może przekroczyć „etap 1 + 30 s”. Zamknięcie narzędzi i tak
  kończy krok odmową po zwolnieniu miejsca.

## 14. Kolejność commitów (orientacyjnie)

1. Refaktor: `lesson-grader-input.ts`, `SchoolCriteria`, delegacja z
   materializacji i `buildGraderInput` (testy prób bez zmian).
2. Port i adapter gradera (`cost`, `usageLabel`), `agentGraderFromEnv`.
3. Polityka, domena (`CandidateChecks`, kody, teksty).
4. Checker: port, adapter AI SDK, fake.
5. Narzędzia: etapy, pamięć, semafor gradera, limity, wyłącznik, liczniki.
6. Składanie w workerze, panel rodzica.
7. Testy integracyjne i dokumentacja.

## 15. Rozstrzygnięcia po review

| Uwaga | Rozstrzygnięcie |
|---|---|
| Funkcja w domenie nie może zwracać `GraderInput` z `ports` | `modules/materials/lessons/lesson-grader-input.ts`, eksport przez barrel; `learning` importuje przez barrel |
| Mapowanie `instruction`/`stimulus` niezgodne z materializacją | Wspólne `openAnswerGradingFields` dla materializacji i kontroli; łańcuch `instructionPl ?? transformInstruction ?? titlePl ?? ""`, `stimulus = prompt ?? ""` |
| Źródło celu i etykiet kategorii | `state.topic.objectives` (temat z `buildDynamicTopic`); `categoryLabels` przeniesione razem |
| Brak typu `SchoolCriteria` | Nowy nazwany typ w domenie, klucz go używa |
| Dziecko dopasowuje deterministycznie bez gradera | To samo w kontroli; para równa po normalizacji oceniana raz |
| `partial` bez braków dostawał radę o elementach | Pole `wrong`, osobny tekst `openWrong`; teksty bronią przed luzowaniem kryteriów |
| Jedno odrzucenie na krok przy dwóch wadach | Podpowiedź i kontrola otwarta oceniane razem, oba powody w jednym wierszu |
| Powtarzanie kontroli przy poprawce | Pamięć wyników `done` w próbie runu, klucze z odcisków pól |
| Semafor i termin dwóch etapów | Etap 1 jak w 2a; osobny semafor gradera (stała 4), limit etapu 2 30 s, ponowne sprawdzenie budżetu po zajęciu miejsca |
| Nieznany koszt gradera wyczerpuje budżet | `unknownGraderCallEstimateUsd = 0.002` |
| Ciche „niesprawdzone” przy złej konfiguracji | Log startu, osobne liczniki w podsumowaniu, wyłącznik po 3 porażkach |
| Wstrzyknięcie poleceń przez pola ćwiczeń | Pozycje jako JSON w `<ITEMS>`, prompt systemowy ignoruje polecenia w danych, test adaptera; odrzucanie znaczników w prechecku — poza zakresem |
| Wspólny kod `hint_reveals_answer` | Sędzia: `hint_reveals_paraphrase` (rodzaj `hint`); bramka bez zmian |
| Sędzia nie widział elementów wymaganych | `requiredElements[].text` w wejściu sędziego |
| Grader w `generationServices` | Osobne pole `openCheckService` i komunikat; wersja nierzucająca; puste w fake |
| `agentGraderFromEnv` i częściowa konfiguracja | Zwraca `{ provider, timeoutMs }`; częściowa → błąd startu |
| Brak listy zmian wewnętrznych typów | §5.3 wymienia przekazanie i liczniki; format punktu kontrolnego bez zmian |
| Nazwy opcji fake | Konwencja `*Batch` i tablice wywołań; `FakeAnswerGrader` z kosztem |
| Testy za mało konkretne | §11 z wejściem i wynikiem dla każdego przypadku |
| Mapowanie pkt 1 issue, „+N”, wznowienie | Tabela §1, §6.5 |
| Brak osobnego wyłącznika kontroli | Świadomie (bez nowych env), §13 |
| Szacunek kosztu bez wyprowadzenia | Wzór w §7.3 |
| Braki w liście dokumentacji | §12 uzupełniona (AGENTS.md gradera, wiersz `answer_grading`, komentarze portu, MCP w PR) |

## 16. Noty z implementacji

Odstępstwa i doprecyzowania względem powyższego designu, przyjęte w trakcie
implementacji:

1. **Nazwa typu werdyktu.** W domenie (`domain/lessons/agent/admission.ts`)
   typ nazywa się `AgentHintVerdict`; port zachowuje `HintVerdict` (struktury
   są identyczne, `ports/ai.ts` nie ma importów).
2. **Limit etapu 2 to nie awaria gradera (§7.2, §7.4).** Wywołanie przerwane
   przez `graderStageTimeoutMs` (30 s) nie zwiększa `graderErrors` i nie liczy
   się do wyłącznika; pozycja jest tylko niesprawdzona (`unchecked`).
   Porażką gradera są: własny termin (`UMIEM_GRADER_TIMEOUT_MS`), rzucony błąd
   i werdykt odrzucony przez walidację. „Termin” w §7.4 oznacza więc własny
   termin gradera.
3. **Pamięć próby runu a wyłącznik.** Zapamiętane wyniki kontroli otwartej `done`
   obowiązują także po otwarciu wyłącznika (pamięć jest sprawdzana jako
   pierwsza, §6.2 pkt 1); to prawdziwe werdykty gradera.
4. **Termin pojedynczego wywołania gradera** liczy `deadlineSignal(sygnał
   etapu, timeoutMs)` z `lesson-agent-timers` zamiast `AbortSignal.timeout`
   (§7.2): to samo znaczenie, ale działa z zegarami fake w testach.
5. **Nieznany koszt gradera** trafia do budżetu runu jako szacunek 0,002 USD
   przez opakowanie odbiornika kosztów; nie zwiększa `unknownCostCalls`
   (licznik zostaje dla wywołań checkera i agenta).
6. **`OpenAnswerFields.expectedForm`** ma typ `string` (payload ćwiczenia
   typuje je jako `string`, szkic jako unię literałów).
7. **Klucz pamięci kontroli otwartej** (`openKey`) — zastąpione notą 15:
   klucz zawiera też cel i typ ćwiczenia.
8. **Liczniki kontroli** (`checkCounters`) są scalane do punktu kontrolnego po
   każdej próbie, jak `rejectionCodes` w 2a; zamknięcie workera w trakcie
   próby gubi liczniki tej próby.
9. **Panel:** komunikat `openCheckServiceInfo` pojawia się wszędzie tam, gdzie
   komunikat o checkerze: w formularzu nowej lekcji i na stronie źródła.
10. **`judgeHints`:** `reason` może być `null` w odpowiedzi modelu (pole
    `nullish`); adapter przycina go do 200 znaków.
11. **Próba ręczna:** opakowanie `meteredChecker` w
    `tests/probes/agent-generation.probe.test.ts` deleguje dwie nowe metody
    checkera (typecheck); próby nie uruchomiono (płatna).
12. **Etykiety kategorii:** kopie `categoryLabels` w `lesson-attempts.ts`,
    `lesson-supervision.ts` i `lesson-mock-tests.ts` zastąpiło wspólne
    `lessonCategoryLabels`.

Poprawki po przeglądzie końcowym gałęzi (trzech krytyków):

13. **Komunikat panelu (§9).** Tekst „sprawdza podpowiedzi i odpowiedzi na
    pytania otwarte” brzmiał jak sprawdzanie odpowiedzi dziecka i zgubił
    zapewnienie o prywatności z 2a. Nowy tekst: „… sprawdza podpowiedzi i
    pisze próbne odpowiedzi na pytania otwarte. Dostaje ćwiczenia i materiał
    lekcji — nigdy imienia, wieku ani odpowiedzi dziecka.”
14. **Wybór tekstu `open_not_accepted` (§6.4).** Braki nie mają już
    pierwszeństwa: odpowiedź z błędnymi stwierdzeniami albo `incorrect`
    dostaje `openWrong` (z listą błędów zawsze, gdy niepusta, i z listą braków,
    gdy są), a `openMissing` tylko `partial` bez błędów. Inaczej odpowiedź
    sprzeczna z materiałem skłaniałaby agenta do luzowania kryteriów (§13).
15. **Klucz kontroli otwartej (§6.3)** zawiera `objectiveId` i `exerciseType`:
    wejście gradera zależy od celu (tytuł, polecenie), więc to samo ćwiczenie w
    dwóch celach nie dzieli wyniku. Klucz werdyktu podpowiedzi zostaje bez
    zmian — wejście sędziego to dokładnie pola klucza.
16. **Rozjazd długości w adapterze checkera.** Gdy lista `verdicts`
    (`judgeHints`) albo `answers` (`solveOpen`) ma inną długość niż liczba
    pozycji, cała paczka jest niesprawdzona (`null` na każdej pozycji) —
    dopasowanie po pozycji mogłoby przypisać werdykt innemu ćwiczeniu. JSON w
    `<ITEMS>` ma „<” escapowane jako `\u003c`, więc pole z „</ITEMS>” nie
    zamyka bloku danych. `solve` i `judgeVariants` (2a) bez zmian.
17. **Zakres wyłącznika i pamięci (§6.3, §7.4)** to próba runu, nie cały run:
    `AgentCheckRun` powstaje przy każdym wywołaniu `runLessonPoolAgent`, więc
    po ponowieniu zadania wyłącznik startuje zamknięty, pamięć pusta, a
    `grader_unavailable` może się zalogować ponownie. Wyłącznik otwarty w
    trakcie etapu 1 paczki (przez inne zagadnienie) sprawia, że jej pozycje
    jeszcze bez oceny nie dotyczą (bez noty i bez `openUnavailable`), a
    paczka zakończona odmową nie zwiększa `hintUnavailable` ani
    `openUnavailable`.
