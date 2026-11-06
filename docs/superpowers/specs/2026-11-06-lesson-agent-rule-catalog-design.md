# Agent puli lekcji — katalog reguł walidacji z opisami w prompcie (#237, PR 3)

Wersja 2, 2026-11-06, po przeglądzie trzech krytyków wersji 1 (rozstrzygnięcia
w §11). Projekt zatwierdzony przez właściciela w rozmowie („Zatwierdzam”,
2026-11-06), razem z poluzowaniami reguł w wariancie A. Gałąź
`feature/lesson-agent-rule-catalog-237` wychodzi z PR 2
(`feature/lesson-pool-agent-stage3-pr2-237`, commit `783f7220`).

## 1. Cel i decyzje właściciela

**Problem.** W płatnym przebiegu kontrolnym z 2026-11-05 szkoła odrzuciła 65
ze 133 propozycji agenta (49%), a rozdział i gramatyka po ok. 20%. Audyt kodu
pokazał dwie przyczyny:

- **Prompt nie zna części reguł,** które walidacja egzekwuje: podpowiedzi
  pytań otwartych, tolerancji rachunku, zakazu pustych napisów, wymaganych pól
  pytania otwartego, rodzin pytań i dokładności cytatów.
- **Agent dostaje ogólne odrzucenia:**
  - `shape_malformed` ma jeden stały komunikat o polu `answer`, którego część
    typów w ogóle nie wysyła;
  - komunikaty walidatorów są po polsku (pisane dla rodzica), zwykle bez złej
    wartości i bez wskazania, co zrobić;
  - bramka podpowiedzi nie mówi, które słowo uznała za zdradzające.

Prompt i walidatory to dziś dwa niezależne teksty, więc rozjeżdżają się przy
każdej nowej regule.

**Cel.** Każda deterministyczna reguła, która może odrzucić albo oczyścić
ćwiczenie agenta, ma wpis w katalogu z opisem dla modelu. Prompt agenta
składa się z opisów reguł pasujących do przedmiotu i dozwolonych typów, a
każde odrzucenie podaje id reguły, ten sam opis i konkretną wartość, która ją
złamała. Nowej kontroli nie da się dodać bez wpisu z opisem i bez przypadku
testowego (pilnują typy i testy, §2.4).

| Pytanie | Decyzja (2026-11-06) |
|---|---|
| Opis reguły w prompcie | tak: prompt składa się z opisów reguł katalogu (pomysł właściciela) |
| Podpowiedź zdradzająca odpowiedź (bramka deterministyczna) | poluzować: bez słów pomocniczych i słów z pytania; gdy dalej zdradza, usunąć podpowiedź i przyjąć ćwiczenie z notą |
| Cytaty z materiału | poluzować: porównanie bez różnic cudzysłowów, myślników, wielokropka i wielkości liter |
| Wariant odpowiedzi uznany za nierównoważny | poluzować: usunąć wariant, przyjąć ćwiczenie z notą (o ile ślepe rozwiązanie dalej pasuje, §5.3) |
| Rodziny pytań otwartych | bez zmian (identyczna odpowiedź i elementy), ale jasny komunikat |
| Ślepe rozwiązanie z inną liczbą odpowiedzi | bez zmian |
| Sędzia podpowiedzi (model) | bez zmian: dalej odrzuca jako druga kontrola |
| Podział | osobny PR 3 na gałęzi z PR 2 |
| Płatny przebieg kontrolny po zmianach | tak, za osobną zgodą przed startem (§8) |

**Poza zakresem:**
- zamiana `""` na brak pola w kodzie (zostaje reguła, komunikat i jedna
  dodatkowa analiza, §4.2);
- prompty etapu zagadnień szkoły (`generateLessonObjectives`), historyjki i
  planisty, a z nimi `planGate`, `objectiveGaps` i przykłady kart (zostają
  dzisiejszymi tekstami, test architektury je wyłącza jawnie);
- reguły edytora rodzica nieosiągalne dla agenta;
- nowe reguły jakości, których dziś nie ma (np. kropka w klocku `lesson_order`
  gramatyki — kandydat na osobne zadanie);
- automatyczne dopisywanie odpowiedzi ślepego rozwiązującego jako wariantu po
  ocenie modelu (kandydat na osobne zadanie);
- zmiany Kid UI, sesji, MCP i `learning-overview`.

**Moduł i zależności.**
- Domena lekcji (`domain/lessons`): walidacja puli, rachunki, przedmioty,
  przyjmowanie agenta, nowy katalog reguł.
- Autorstwo materiału (`modules/materials/lessons`): kształt rekordu,
  materializacja, narzędzia i wejście agenta.
- Adapter promptu i schematu narzędzia (`providers/openai/llm.ts`,
  `lesson-pool-agent.ts`, `lesson-pool-schema.ts`), materializery w
  `providers/` przenoszą się do warstwy narzędzi (§4.3).
- Kontrakty (`packages/contracts`) dostają tylko nowe eksporty stałych limitów.

Bez nowych zależności, bez migracji. Transakcje bez zmian: katalog i
komunikaty to czyste funkcje nad przekazanymi danymi.

## 2. Katalog reguł

### 2.1. Wpis reguły

Nowy katalog `domain/lessons/rules/` (czysta domena). Wpis reguły:

| Pole | Znaczenie |
|---|---|
| `id` | stały literał `obszar.nazwa`, np. `cloze.gap_count`, `school.quote_in_material`; tylko `[a-z0-9_.]`; bez id składanych dynamicznie |
| `field` | pole ćwiczenia (do komunikatu) albo `exercise` |
| `types` | typy ćwiczeń, których dotyczy (brak = wszystkie) |
| `when` | opcjonalny warunek z kontekstu promptu (`groundingRequired`, `voiceTones`, `exerciseExplanations`, przydział `lesson_listen_choice`, typy kontroli z `agentPolicy`) |
| `kind` | `reject` (odrzuca), `sanitize` (usuwa pole albo element i daje notę, np. `explanationPl`, podpowiedź, wariant) albo `internal` (nieosiągalna dla agenta: kod wylicza pole; nie trafia do promptu) |
| `description` | jedno–trzy zdania po angielsku: co musi być prawdą i jak to spełnić; liczby wyłącznie ze stałych, którymi posługuje się sprawdzenie. Napis albo funkcja kontekstu (`(ctx) => string`, ctx: limity i flagi przedmiotu, np. długość odpowiedzi 120/300) |

**Teksty przedmiotu do reguł silnika.** Silnik (przyjmowanie, rdzeń
walidacji) zgłasza reguły rdzenia i lekcji; nie zna id przedmiotów. Przedmiot
uzupełnia ich opis polem `agentPolicy.ruleNotes:
Partial<Record<LessonRuleId, string>>`: zdanie dopisywane do opisu reguły w
prompcie i w odrzuceniu (np. przy ujawnieniu w rozdziale: „change the room,
object or place”). `ruleNotes` zastępuje dzisiejsze `rejectionTexts`, więc
opis reguły (z dopiskiem przedmiotu) jest jedynym tekstem reguły dla modelu.

**Karty typów.** Opis typu jako całość (do czego służy, które pola zwrócić
w gałęzi ścisłej, przykład) nie jest regułą, ale żyje obok reguł:
`domain/lessons/rules/type-cards.ts` ma dla każdego typu ćwiczenia:
- `summary`: ręcznie pisane jedno–dwa zdania (cel typu i lista pól do
  zwrócenia);
- `example`: jeden minimalny, poprawny rekord JSON z neutralną treścią.

Przykład przechodzi test: materializacja → kształt rekordu → kontrakt →
walidacja rdzenia i przedmiotu, dla każdego przedmiotu, który ma ten typ
(przykład może mieć wariant przedmiotu, np. pytanie otwarte szkoły z
`questionType`, `requiredElements`, `expectedForm` i `sourceRefs`).

### 2.2. Gdzie żyją katalogi

| Katalog | Plik | Reguły |
|---|---|---|
| rdzeń | `domain/lessons/rules/core-rules.ts` | kontrakt (§4.2), kształt rekordu agenta (§4.3), pola wspólne i reguły typów z `pool-validation.ts`, rachunki, `explanationPl` |
| lekcja | `domain/lessons/rules/lesson-rules.ts` | reguły całej puli (`validatePool`: powtórzony bodziec, równoważne odpowiedzi), limity zagadnienia, ujawnienia odpowiedzi, kontrole modelami (ślepe rozwiązanie, warianty, sędzia podpowiedzi, ocena pytań otwartych) |
| przedmiot | `domain/lessons/subjects/<przedmiot>/rules.ts` | reguły `validateExercise`, `validatePoolExtra`, `refineGeneratedPool`, `exerciseGate` i `sanitize` przedmiotu |

`SubjectModule` dostaje wymagane pole `rules`. Rejestr (`validateSubject`)
odrzuca moduł bez `rules` i moduł, którego id reguł kolidują z rdzeniem,
lekcją albo innym przedmiotem. Moduły testowe (`testing/agent-test-subject.ts`,
`testing/history-like-subject.ts` i fikstury testów) dostają minimalny katalog.

### 2.3. Zgłoszenie złamanej reguły

```ts
type RuleId = string & { readonly __lessonRule: unique symbol };
type LessonRuleIssue = {
  readonly rule: RuleId;
  readonly field: string;   // ścieżka pola, np. "sourceRefs[1].quote"
  readonly pl: string;      // komunikat dla rodzica
  readonly found?: string;  // po angielsku: co konkretnie jest nie tak, z wartością
};
```

- Fabryka `issueFrom(catalog)` przyjmuje tylko klucze swojego katalogu i jest
  jedynym źródłem `RuleId` (typ znakowany). Wyszukanie opisu idzie przez
  `ruleOf(subject, id)` (rdzeń ∪ lekcja ∪ `subject.rules`): w testach rzuca
  przy braku, w produkcji zwraca sam id.
- **`pl`** zostaje dosłownie dzisiejszym komunikatem, gdy taki istnieje. Nowe
  zgłoszenia (kształt rekordu, rachunek, kaskada słów kluczowych) dostają
  polski tekst w stylu istniejących.
- **`found`** podaje wartość, którą wysłał model, i liczbę albo różnicę, np.
  `5 gaps`, `sourceRefs[1].quote "…" not found; matches the material up to
  "…"`, `answer "A B" differs from the family answer "A C"`. Teksty z
  ćwiczenia wycinamy do 120 znaków z wielokropkiem.

**Sygnatury.**
- Publiczne funkcje dla rodzica i testów zostają i zwracają jak dziś napisy
  (`pl`): `validateLessonExercise`, `validatePool`, `splitByPoolExtra` i
  szczegóły `AppError("validation")` w API lekcji. Są cienkimi opakowaniami
  nowych `validateLessonExerciseIssues` i `validatePoolIssues`, których używa
  przyjmowanie agenta.
- Haki przedmiotu (`validateExercise`, `validatePoolExtra`,
  `refineGeneratedPool` z `reason`, `exerciseGate` z `AgentGateFinding`)
  zwracają zgłoszenia. Ich testy przechodzą mechanicznie na pomocnika
  `messagesOf(issues)`, który daje dzisiejsze napisy, więc oczekiwane teksty w
  asercjach się nie zmieniają.
- `computeCalculationAnswer` dalej rzuca (nauka z niego korzysta); obok
  powstaje czysta `calculationIssues(spec)`.

### 2.4. Gwarancje automatyczności

1. **Typy:** zgłoszenie wymaga `RuleId` z fabryki katalogu; powód odrzucenia
   agenta (`Rejection.reasons`) to znakowany `RuleReason`, który tworzy
   wyłącznie formatter z §4.1, a haki przedmiotu zwracają `LessonRuleIssue[]`.
2. **Test katalogu:**
   - id są unikalne we wszystkich katalogach razem;
   - każda reguła `reject`/`sanitize` ma niepusty `description`;
   - `internal` mają wyłącznie reguły z uzasadnionej listy w teście;
   - opisy różnych reguł się nie powtarzają ani nie zawierają jeden drugiego;
   - liczby w opisach pochodzą ze stałych (test porównuje opisy z wartościami
     eksportowanymi z kontraktu i walidatorów).
3. **Tabela przypadków reguł:** test iteruje po wszystkich katalogach i pada,
   gdy reguła `reject`/`sanitize` nie ma w tabeli przypadku naruszenia, przy
   którym walidator zgłasza dokładnie jej id (z `field` i `found`). Reguła z
   limitem liczbowym ma też przypadek graniczny, który przechodzi. To pilnuje,
   że opis i sprawdzenie mówią o tym samym.
4. **Test architektury (AST, `ts.createSourceFile`)** dla wymienionych
   funkcji walidatorów i przyjmowania: brak `push`, `return [...]` ani `reason:`
   ze zwykłym napisem lub szablonem poza fabryką zgłoszeń. Jawna lista wyjątków
   z uzasadnieniem: przykłady kart, odmowy narzędzi, planista, `planGate`,
   `objectiveGaps`. Test czułości: fikcyjny fragment z `push("x")`,
   ``push(`x`)`` i `push(...f())` jest wykrywany.
5. **Test promptu:** dla każdego przedmiotu i każdego jego typu opis każdej
   pasującej reguły (z dopiskiem przedmiotu) jest w złożonym prompcie, a
   reguła typu niedozwolonego w zagadnieniu w nim nie występuje. Renderer ma
   osobne testy (kolejność sekcji, determinizm, brak pustych nagłówków).
6. **Migawka promptu:** złożony prompt każdego przedmiotu na fikcyjnym
   materiale z testów jest plikiem migawki w repozytorium
   (`toMatchFileSnapshot`, świadoma nowość w repo). Każda zmiana reguły
   pokazuje się w diffie PR. Test długości pilnuje budżetu znaków per
   przedmiot ustalonego w planie po pomiarze.

## 3. Prompt agenta z katalogu

**Składanie.** Domenowa funkcja `lessonRuleBook(subject, ctx)` zwraca karty
typów i reguły pasujące do przedmiotu, dozwolonych typów zagadnienia i
warunków. Wejście agenta (`lesson-pool-agent-input.ts`) przekazuje ją w
`LessonPoolInput.ruleBook`. Adapter tylko ją renderuje:

```
RULES — the tool checks every rule below; a rejection names the broken rule in [brackets].
General: [field.empty] … [field.max_length] …
lesson_cloze — <summary> Example: {…}
  <subject typeRules for lesson_cloze>
  [cloze.gap_count] … [cloze.bank_outside_gap] …
lesson_open_answer — <summary> Example: {…}
  [school.open_required_fields] … [hint.reveals_words] …
Lesson: [lesson.duplicate_stimulus] … [lesson.leak] …
Checks by another model: [check.blind_solve] … [check.variants] … [check.hint_judge] …
```

Bloki typów idą w stałej kolejności, a w bloku najpierw reguły najczęściej
łamane w przebiegu z 2026-11-05 (podpowiedź, cytat, rodzina, kształt
rachunku).

**Co zastępuje.** Fragmenty, które opisują egzekwowane reguły, znikają z
`lessonSystemPrompt`, `objectiveInstructions`, `fieldRules`, `typeRules` i
`promptNotes`: struktura `lesson_listen_choice`, `lesson_calculation`,
`lesson_keywords`, `lesson_match`, `lesson_group`, `lesson_cloze` (przechodzi
do kart typów i reguł), wymóg `sourceRefs`, unikalność odpowiedzi i bodźców,
reguły `explanationPl`. Zostają ręczne wskazówki, których kod nie sprawdza:
rola, przedmiot, lista zagadnień i przekształceń, podział na etapy i
rezerwacja etapu samodzielnego, dostępność gradera, dobór tonu lektora, styl
i treść wyjaśnień, semantyka typów przedmiotu (`typeRules` bez reguł
egzekwowanych) i przepływ narzędzi.

**Usuwane bez odpowiednika** (pozostałości potoku sprzecznie z trybem
narzędzi): „Return strict JSON… no markdown”, „Return at most N exercises per
objective in this batch” (cele liczbowe podaje jedno miejsce: `Target` z
`objectiveInstructions`), „global 160-exercise limit”, „never exceed this
batch's requested count”, kształt `examples` w JSON (to pole narzędzia).
Minima publikacji zostają jednym zdaniem w `Target`, z tych samych stałych co
walidacja publikacji.

**Brak utraty treści.** Plan zawiera tabelę migracji: każde zdanie i każda
asercja dzisiejszych testów promptu (`llm.test.ts`, `lesson-pool-agent.test.ts`,
`*/module.test.ts`) → id reguły albo karta typu, która je przejmuje, albo
„usunięte” z powodem. Przegląd końcowy porównuje migawki przed i po, czytając
blok każdego typu jako całość.

**Nowe opisy reguł dziś nieobecnych w prompcie** (z audytu), m.in.:
- podpowiedź pytania otwartego: daj krótką wskazówkę rozumowania przy każdym
  pytaniu otwartym; nie może zawierać odpowiedzi, wariantu ani tekstu
  elementu wymaganego, ani większości ich słów treściowych w żadnej formie;
  `null` tylko wtedy, gdy wskazówka bez tych słów jest niemożliwa;
- `tolerance` rachunku: pomiń albo podaj 0 (kod liczy dokładny wynik);
  niezerowa tolerancja najwyżej 1% wyniku; `templateFamilyId` to małe litery i
  cyfry łączone `-` (np. `scale-distance-km`, choć rodzaje mają `_`);
- żadne pole nie jest pustym napisem: pole, które nie dotyczy, ma `null`;
- `lesson_open_answer` szkoły wymaga niepustych `questionType`,
  `requiredElements` i `expectedForm`; limity `supplementaryElements` i
  `commonErrors` ze stałych kontraktu;
- członkowie jednej rodziny mają znak w znak tę samą odpowiedź wzorcową i te
  same elementy wymagane (te same id i teksty); `lesson_keywords` wysyła się
  razem z jego pytaniem otwartym, bo bez przyjętego pytania odpada;
- cytat to jeden ciągły fragment materiału, bez łączenia fragmentów i bez
  znaczników list;
- odpowiedź ćwiczenia samodzielnego nie może równać się odpowiedzi ćwiczenia
  kierowanego lub produktywnego ani przykładowi z karty;
- „podaj dowolne dwa”: elementy wymagane opisują to, co spełnia każdy
  poprawny wybór, a przykłady idą do `supplementaryElements`;
- ślepe rozwiązanie: rozwiązujący widzi tylko widok dziecka (polecenie,
  bodziec, opcje, klocki, bank słów; materiał tylko w szkole), porównanie
  ignoruje wielkość liter, interpunkcję i formy skrócone; pary, grupy i luki
  porównuje się pozycja po pozycji. Rozdział i gramatyka dopisują przez
  `ruleNotes`: polskie zdanie źródłowe ma wskazywać jedno sformułowanie
  (zaimek, czas, szyk), a typowe równoważne szyki trafiają od razu do
  `acceptedAnswers`.

**Schemat narzędzia.** `lesson-pool-schema.ts` dostaje limity z tych samych
stałych: `minLength: 1` dla napisów, `maxLength`, `minItems`/`maxItems` list.
`tolerance` w gałęzi rachunku przestaje być wymagane (brak = 0). Schemat dalej
nie jest egzekwowany przez SDK; walidacja zostaje po stronie serwera.

## 4. Odrzucenia dla agenta

### 4.1. Format wyniku narzędzia

- Każdy wynik ćwiczenia powtarza `exerciseType` i pierwsze ok. 40 znaków
  bodźca (treść modelu), żeby model wiedział, którego ćwiczenia dotyczy.
- Powód to `[<rule id>] <field>: <found>` (bez `found`: `[<id>] <field>`).
  Najwyżej 6 powodów na ćwiczenie, dalej `+N more`.
- Opis każdej użytej reguły (z dopiskiem przedmiotu) trafia raz na wynik
  narzędzia, w mapie `rules: { "<id>": "<description>" }`, a nie przy każdym
  powodzie.
- Noty przy przyjętym ćwiczeniu mają tę samą postać, np.
  `[hint.reveals_words] hint removed: shares "obraca", "Ziemia" with the
  required element "ruch obrotowy Ziemi"`.
- Kod odrzucenia i histogram `rejectedReasons` zostają. Gdy wśród zgłoszeń
  jest ustalenie bramki (`card_word_missing`, `frame_missing`), kodem jest kod
  pierwszego ustalenia, w przeciwnym razie `rule_exercise`.
- Etykiety kodów `hint_reveals_answer` i `variant_rejected` zostają w
  `messages.ts` dla zapisanych szkiców.

`Rejection` dostaje `ruleIds`. Dziennik odrzuceń (`RejectionLogEntry`, w
pamięci) trzyma pełny tekst (sonda go zapisuje poza repozytorium), a logi
`[lesson-agent]` dostają tylko `code`, `ruleIds` i `exerciseType`, nigdy
`found`, `pl` ani treści. Liczniki `hintsRemoved` i `variantsRemoved` trafiają
do statystyk narzędzi i logu runu.

### 4.2. Kontrakt (Zod) i wszystkie błędy naraz

| Błąd Zod | Reguła | `found` |
|---|---|---|
| `too_small`, `origin: string`, minimum 1 | `field.empty` | ścieżka, „empty string” |
| `too_big`, `origin: string` | `field.max_length` | ścieżka, długość i limit |
| `too_small`/`too_big`, `origin: array` | `field.count` | ścieżka, liczność i zakres |
| inne (`invalid_type`, `invalid_value`, `unrecognized_keys`, `invalid_union`, `custom`) | `field.invalid` | ścieżka, otrzymana wartość odczytana ze szkicu pod ścieżką (wycięta) i oczekiwanie z Zod |

- Opisy reguł `field.*` wymieniają limity pól ze stałych eksportowanych z
  `packages/contracts` (nowe eksporty dla dziś literalnych 1, 3, 4, 6, 40, 64).
- Gdy kontrakt nie przechodzi, a jedynymi zgłoszeniami są `field.empty` na
  opcjonalnych polach tekstowych, pozostałe reguły liczymy raz jeszcze na
  kopii bez tych pól i zgłaszamy razem (ćwiczenie i tak jest odrzucone). Przy
  innych błędach kontraktu dalszych reguł nie sprawdzamy.
- Gdy kontrakt przechodzi, zgłoszenia rdzenia, przedmiotu i bramki zbieramy w
  jednym odrzuceniu. `refineGeneratedPool` (leksykon rozdziału) zostaje
  osobnym krokiem przed nimi, z kodem `refine`. Reguły lekcji i ujawnienia
  działają po regułach ćwiczenia, jak dziś.
- Dla typów z odpowiedzią liczoną przez kod (pary, grupy, luki z bankiem,
  słowa kluczowe, rachunek) zgłoszenie kontraktu o `answer` znika, gdy pole
  źródłowe ma własne zgłoszenie. Bez takiego zgłoszenia ścieżka `answer`
  zmienia się na pole źródłowe.

### 4.3. Kształt rekordu i materializacja

- Materializacja (rachunek, słowa kluczowe, pary, grupy, luki z bankiem)
  przenosi się z adaptera do `parseRecord` narzędzi agenta (moduł), na
  funkcjach, które zwracają `{ record } | { issues }`. Adapter przekazuje
  surowe rekordy. Materializacja jest idempotentna (rekord już
  zmaterializowany przechodzi bez zmian), więc fake agenta i test
  integracyjny, które materializują wcześniej, działają dalej (test).
- `rawExerciseShapeSchema` zwraca zgłoszenia `shape.*` z polem, oczekiwanym
  kształtem i otrzymanym typem (np. `options[0]: expected {id, text}, got a
  string`) dla każdego pola listowego, które dziś `v3FieldsOf` po cichu
  filtruje (`sourceRefs`, `requiredElements`, `supplementaryElements`,
  `commonErrors`, `keyOptionIds`, `extraRight` i pozostałe). Dotyczy tylko
  ścieżki agenta i punktu kontrolnego; `toExerciseDraft` dla API rodzica się
  nie zmienia, a `isWellShapedRawExercise` zostaje opakowaniem logicznym.
- Kod `shape_malformed` zostaje w histogramie.

### 4.4. Wymagane konkretne komunikaty (testy)

- cytat spoza materiału: indeks, tekst i najdłuższy pasujący początek;
- rodzina pytań: które pole się różni (odpowiedź albo zbiór id elementów),
  obie wartości i slug bez sufiksu runu (sufiks zdejmuje formatter w
  narzędziach przez domenowego pomocnika `familyBase(slug, scope)`; tekst `pl`
  się nie zmienia);
- słowa kluczowe bez przyjętego pytania otwartego: osobna reguła
  `school.keywords_family_rejected` („pytanie otwarte z tym `familyId` nie
  zostało przyjęte w tym wywołaniu albo nie ma `familyId`; wyślij oba razem”),
  kod `lesson_extra`;
- `focus` i `items`: tokeny odpowiedzi i złożony tekst;
- `correctOption` i `groupId` spoza listy: dozwolone id;
- rachunek: tolerancja z wynikiem i limitem, zły slug, niedozwolony klucz;
- ślepe rozwiązanie: odpowiedź rozwiązującego, klucz, różnice pozycja po
  pozycji przy parach, grupach i lukach, a przy innej liczbie odpowiedzi obie
  liczby.

## 5. Poluzowania reguł (wariant A)

### 5.1. Podpowiedź pytania otwartego (szkoła)

**Algorytm bramki** (`hint-gate.ts`, zwraca dopasowanie albo `null`): dla
każdego celu (odpowiedź, każdy wariant, tekst każdego elementu wymaganego):
1. słowa treściowe celu: tokeny normalizatora z ≥ 4 literami albo z cyfrą;
2. usuń słowa pomocnicze (dokładne dopasowanie znormalizowanego tokenu) ze
   stałej listy: `jest, są, był, była, było, były, będzie, przez, które,
   który, która, którego, której, oraz, tego, tych, tym, może, mogą, gdzie,
   kiedy, dlaczego, jaki, jaka, jakie, czyli, także, również, więc, jednak,
   bardzo, ponieważ, dlatego, między, około, nad, pod, przed, za, się`
   (pełna lista z testem w `hint-gate.ts`);
3. usuń słowa, które pasują (wspólny początek, `stemMatches`) do tokenu pytania
   ćwiczenia (`prompt`);
4. gdy nic nie zostało, ten cel nie może zostać zdradzony (bez dzisiejszego
   powrotu do wszystkich tokenów);
5. próg jak dziś: 1–2 słowa — wszystkie, więcej — połowa w górę, liczona z
   tego, co zostało.

**Skutek.** Gdy podpowiedź zdradza, sanityzacja szkoły (`sanitize`) usuwa
podpowiedź, a ćwiczenie przechodzi dalej z notą reguły `hint.reveals_words`
(§4.1). `SanitizeResult` dostaje `notes: { rule: RuleId; text: string }[]`
obok dzisiejszego `removed` (nazwy pól). Bramka `exerciseGate` przestaje
zgłaszać `hint_reveals_answer`. Po usunięciu podpowiedzi sędzia nie jest
wołany. Edytor rodzica się nie zmienia (bramka działa tylko w przyjmowaniu).

**Sędzia podpowiedzi** (model) dalej odrzuca (`hint_reveals_paraphrase`,
`hint_unsupported`, `hint_language`) jako reguła `check.hint_judge` z własnym
opisem, odróżnionym od `hint.reveals_words` (świadoma asymetria: decyzja
właściciela, sędzia zostaje drugą kontrolą).

### 5.2. Cytaty z materiału (szkoła)

- Nowa funkcja `normalizeQuote` (osobna od porównania treści pytań rodziny,
  które się nie zmienia) dla cytatu i materiału: NFC; usunięcie znaków
  niewidocznych (U+00AD, U+200B–U+200D, U+FEFF); cudzysłowy typograficzne
  („ ” “ ” « » ‚ ‘ ’) do prostych; łączniki i myślniki (‐ ‑ ‒ – — ― −) do `-`;
  `…` do `...`; zwinięte białe znaki; `toLocaleLowerCase("pl")`; bez
  wiodącego znacznika listy w cytacie (`-`, `•`, `*`, `1.`).
- Długość minimalna liczona na cytacie po normalizacji.
- Wielokropek w środku cytatu nie łączy fragmentów: cytat z „...” przejdzie
  tylko wtedy, gdy materiał zawiera ten wielokropek.
- **Zapis cytatu z materiału:** sanityzacja przyjmowania agenta zastępuje
  `quote` dokładnym fragmentem materiału, który pasował (mapa pozycji z
  normalizacji), więc rodzic i grader widzą tekst materiału. Cytaty dopisane
  przez rodzica (`parentAdded`) bez zmian.
- Ta sama, łagodniejsza reguła obowiązuje przy edycji i publikacji.

### 5.3. Warianty odpowiedzi (wszystkie przedmioty)

Kolejność w `admitBatch` dla kandydata z wariantami odrzuconymi przez model:
1. oczyszczony szkic = szkic bez odrzuconych wariantów;
2. ślepe rozwiązanie liczone na oczyszczonym szkicu; niezgodność daje
   `blind_mismatch` z powodem, że pasował tylko usunięty wariant;
3. sędzia podpowiedzi i ocena pytań otwartych jak dziś (ich odrzucenie wygrywa;
   ocena odpowiedzi, która pasowała tylko przez usunięty wariant, staje się
   `unavailable`, czyli przyjęcie z `unchecked` — dziś żaden przedmiot nie ma
   typu w obu listach, test to pilnuje);
4. kroki deterministyczne powtórzone na oczyszczonym szkicu; odrzucenie ma
   kod tego kroku;
5. przyjęcie oczyszczonego szkicu z notą
   `[check.variants] variant "…" removed: not equivalent to the answer "…"`.

`AdmitEntry` dostaje listę usuniętych wariantów (do noty i licznika).
Kod `variant_rejected` przestaje powstawać.

## 6. Testy

- Gwarancje z §2.4, w tym tabela przypadków każdej reguły i test czułości AST.
- Złożony prompt (§3): obecność opisów, brak opisów typów niedozwolonych,
  brak usuniętych zdań potoku, migawki per przedmiot, budżet długości,
  przykłady kart typów przechodzą walidację.
- Wynik narzędzia: `exerciseType` i fragment bodźca, mapa `rules`, limit 6
  powodów, noty.
- Kontrakt: tabela błędów Zod z §4.2 na prawdziwym `safeParse`; analiza po
  zdjęciu pustych napisów; usunięcie zgłoszenia `answer` przy typach liczonych.
- Komunikaty z §4.4 jako osobne testy.
- Podpowiedź (§5.1), pozytywne i negatywne: słowo elementu spoza pytania →
  usunięta z notą, ćwiczenie przyjęte; słowo wspólne z pytaniem → zostaje;
  same słowa pomocnicze → zostaje; liczba w pytaniu i w odpowiedzi; element
  złożony wyłącznie ze słów pytania → zostaje; typ inny niż pytanie otwarte →
  dzisiejsze usunięcie; po usunięciu sędzia nie jest wołany; edytor rodzica
  przyjmuje taką podpowiedź.
- Cytaty (§5.2): wielkość liter, „ ”, –, …, znak niewidoczny, znacznik listy →
  przechodzą i zapisują tekst materiału; inne słowo, brakujące słowo, inna
  liczba, dwa zszyte fragmenty → odpadają; granica długości; edycja i
  publikacja rodzica z typograficznym cytatem (integracyjnie).
- Warianty (§5.3): stan po przyjęciu nie zawiera wariantu; część i wszystkie
  warianty usunięte; rozwiązujący odpowiedział usuniętym wariantem →
  `blind_mismatch`; odrzucenie podpowiedzi albo oceny wygrywa i stan się nie
  zmienia; usunięty wariant znosi ujawnienie, które powodował; nota w wyniku i
  brak treści w logach.
- Prywatność: logi `console.*` przy odrzuceniu z cytatem nie zawierają
  `found`, `pl` ani treści (spy); `rejectedReasons` szkicu to tylko kody.
- API rodzica: `details.exercises[].errors` z edycji i publikacji to dokładnie
  napisy `pl` (bez `[id]` i `found`), integracyjnie
  (`lesson-parent-api.test.ts`).
- Przepisywane testy (lista w planie): skan kodów w
  `lesson-agent-outcome.test.ts` (znikające `variant_rejected` i
  `hint_reveals_answer`), testy `variant_rejected` i `hint_reveals_answer` w
  testach narzędzi, przyjmowania i polityki szkoły, `hint-gate.test.ts`,
  `toEqual` na `Rejection`, asercje promptu (tabela migracji z §3), sonda
  `agent-generation.probe.test.ts` (typy).
- Pełne bramki: `pnpm check`, `pnpm test:integration` (w tym
  `lesson-generation.test.ts`, `lesson-agent-generation.test.ts`,
  `lesson-parent-api.test.ts`), `pnpm test:e2e:shards`.

## 7. Prywatność i dane

- Odrzucenia i noty cytują wyłącznie treść ćwiczenia, którą ten sam model
  właśnie wysłał, i materiał rodzica, który model już dostał. Bez danych
  dziecka.
- Logi `[lesson-agent]` dostają tylko kody, id reguł, typy ćwiczeń i liczniki.
- Bez zmian w Kid DTO, MCP, `SKILL.md` i `learning-overview`; lekcje są poza
  nimi. Komunikaty walidacji dla rodzica zostają po polsku.

## 8. Płatny przebieg kontrolny

Za osobną zgodą właściciela przed startem. Wariant podstawowy, jak
2026-11-05: rozdział, gramatyka (+6) i szkoła na tych samych materiałach, z
zapisem treści i odrzuceń (`UMIEM_PROBE_DUMP`, `UMIEM_PROBE_POOL_DUMP_OUT`,
`agentSubmissions`) poza repozytorium.

**Ograniczenia porównania.** Przebieg z 2026-11-05 ma tylko liczby per kod,
jeden przebieg na przedmiot i inne kody (dwa znikają z definicji), więc
porównanie nie przypisze efektu jednej zmianie. Przy prośbie o zgodę
zaproponuję właścicielowi opcje rozszerzenia z kosztem: świeży przebieg
odniesienia na głowie PR 2 z zapisem przyczyn (ok. 0,76 USD) i drugi przebieg
szkoły (ok. 0,5 USD).

**Miary:** odsetek odrzuceń per kod i reguła; przyjęcia z oczyszczeniem
(usunięta podpowiedź, usunięte warianty, cytat dopasowany do materiału) jako
osobna miara; odsetek przyjętych w pierwszym wywołaniu; liczba wywołań
`submit_exercises` do `complete`; odsetek pytań otwartych z podpowiedzią;
tokeny, koszt i koszt na przyjęte ćwiczenie; czas. Przegląd treści: według
stałej listy (dwuznaczność, podpowiedź zdradzająca, uziemienie w materiale,
poprawna polszczyzna) na losowych przyjętych ćwiczeniach każdego przedmiotu.

**Sygnały do zbadania przed scaleniem** (nie warunki automatyczne): koszt
albo czas wyższy o ponad 30%, więcej `blind_mismatch`, mniej niż połowa pytań
otwartych z podpowiedzią. Wynik trafia do `docs/architecture.md` §19.17 i
opisu PR.

## 9. Dokumentacja

- `docs/architecture.md` §19.17: katalog reguł, karty typów, format wyniku
  narzędzia, poluzowania.
- `AGENTS.md`: nową regułę walidacji ćwiczeń lekcji dodaje się jako wpis
  katalogu z opisem i przypadkiem testowym; prompt agenta składa się z opisów,
  a odrzucenie podaje id reguły.
- Opis PR: wpływ na API → MCP → `SKILL.md` (brak, uzasadnienie), poluzowania i
  ich skutek dla rodzica (ćwiczenie bez podpowiedzi, mniej wariantów, cytat
  zapisany tekstem materiału, łagodniejsze porównanie cytatów w edytorze).

## 10. Ryzyka

| Ryzyko | Ograniczenie |
|---|---|
| Nowy prompt pogorszy treść ćwiczeń | karty typów czytane jako całość, migawki w diffie, przegląd treści w płatnym przebiegu |
| Duża, mechaniczna zmiana | zadania per obszar, opakowania napisów dla rodzica, typy znakowane, tabela przypadków reguł |
| Dłuższy prompt i historia narzędzi | tylko reguły dozwolonych typów, opisy raz na wynik, limit powodów, budżet długości w teście |
| Podpowiedzi znikną z pytań otwartych | pozytywny opis reguły, miara odsetka pytań z podpowiedzią |
| Łagodniejsze cytaty przepuszczą zmieniony sens | normalizacja tylko znaków typograficznych i wielkości liter; zapis tekstu materiału |
| Usunięcie wariantu przepuści dwuznaczne ćwiczenie | ponowne ślepe porównanie na oczyszczonym szkicu (§5.3) |

## 11. Rozstrzygnięcia przeglądu wersji 1

Trzej krytycy (zgodność z kodem, skutek dla agenta, testy i regresje).
Przyjęte:
- **Bloker (dwóch krytyków):** usunięcie wariantu omijało ślepe rozwiązanie →
  ponowne porównanie na oczyszczonym szkicu i kolejność kroków (§5.3).
- Opakowania napisów zamiast zmiany publicznych typów (§2.3); haki przedmiotu
  zwracają zgłoszenia, testy przez `messagesOf`.
- Materializacja w narzędziach, idempotentna; `calculationIssues` obok
  rzucającej funkcji (§4.3, §2.3).
- Teksty przedmiotu do reguł silnika przez `ruleNotes` zamiast
  `rejectionTexts`; opis jako funkcja kontekstu (§2.1).
- Typ znakowany, `ruleOf`, rejestr sprawdza `rules` i kolizje id, tabela
  przypadków reguł, test AST z wyjątkami i testem czułości (§2.4).
- Dokładny algorytm bramki podpowiedzi bez powrotu do wszystkich tokenów;
  `notes` w sanityzacji; liczniki usunięć (§5.1, §4.1).
- Karty typów z przykładami sprawdzanymi testem; usunięcie zdań potoku;
  limity w schemacie narzędzia; `tolerance` niewymagana (§2.1, §3).
- Pozytywny opis podpowiedzi i miara odsetka pytań z podpowiedzią (§3, §8).
- Zapis cytatu tekstem materiału, osobne `normalizeQuote`, znaki
  niewidoczne, znacznik listy, najdłuższy pasujący początek (§5.2, §4.4).
- Opisy reguł raz na wynik narzędzia, limit powodów, echo typu i bodźca,
  `exerciseType` w logach (§4.1).
- Tabela Zod → reguła, odczyt wartości ze szkicu, analiza po zdjęciu pustych
  napisów, `answer` typów liczonych (§4.2).
- Kod bramki wygrywa w histogramie; etykiety znikających kodów zostają (§4.1).
- Osobna reguła kaskady słów kluczowych; `familyBase` w domenie (§4.4).
- Ostrzejszy kształt rekordu tylko na ścieżce agenta (§4.3).
- `explanationPl` jako reguła `sanitize` (§2.1).
- Opis ślepego rozwiązania i dopiski przedmiotów (§3); miary i ograniczenia
  porównania w przebiegu, opcje rozszerzenia do decyzji właściciela (§8).
- Tabela migracji asercji promptu i lista przepisywanych testów (§3, §6).

Odrzucone albo odłożone:
- Kontrola cytatów na poziomie pojedynczego ćwiczenia przed regułami lekcji:
  wymagałaby materiału w walidacji ćwiczenia; zostaje na poziomie puli.
- Ścisła gałąź schematu dla pytania otwartego szkoły i opisy właściwości w
  schemacie narzędzia: wystarczą limity i karty typów; schemat nie jest
  egzekwowany.
- Reguła kropki w klockach `lesson_order` i automatyczne warianty z odpowiedzi
  rozwiązującego: nowe zachowanie poza zakresem (§1).
- Odtworzenie zapisanych zgłoszeń przez stare przyjmowanie bez modeli: nie
  mamy zapisanych werdyktów kontroli modelami; zamiast tego opcje
  rozszerzenia przebiegu (§8).

### Decyzje z przeglądu planu (2026-11-06)

Plan wersja 2 (`docs/superpowers/plans/2026-11-06-lesson-agent-rule-catalog.md`) doprecyzowuje spec. Przy sprzeczności obowiązuje plan:
- **Kształt rekordu i materializacja** żyją w domenie (`raw-shape.ts`, `raw-materialize.ts`), a reguły `shape.*` w katalogu rdzenia. Punkt kontrolny zachowuje dzisiejszy, łagodny strażnik kształtu.
- **Bramka podpowiedzi** usuwa podpowiedź tylko wtedy, gdy zdradę zgłasza i dzisiejszy, i nowy algorytm. Zmiana jest wyłącznie poluzowaniem.
- **`pl` reguł dostępnych tylko agentowi** to krótki polski opis reguły; dzisiejszy angielski tekst dla modelu przechodzi do `found`.
- **Ponowna analiza po pustych napisach** działa tylko na ścieżce agenta, więc zbiór komunikatów rodzica się nie zmienia.
- **Rachunek:** `tolerance: null` materializacja traktuje jak brak pola. Reguła `field.empty` dotyczy napisów.
- **Opisy reguł w wyniku narzędzia** są wysyłane raz na id w zagadnieniu, nie w każdym wyniku.
- **Wyrównany cytat** zostaje zapisany tylko wtedy, gdy sam przechodzi walidację i limit długości.
- **Materializacja** pomija pola tak jak dziś (np. `explanationPl` przy parach, grupach i lukach z bankiem). Zmiana treści dla dziecka wymaga osobnej decyzji właściciela.
