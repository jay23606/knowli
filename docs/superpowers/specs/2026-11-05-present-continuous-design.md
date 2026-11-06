# Temat Present Continuous w lekcjach gramatyki — projekt

Wersja 5 (po przeglądzie implementacji przez trzech krytyków; reguły celów 1, 3, 4, 5 i skutki §6.7 w §16), 2026-11-05. Wersja 4: zgodna z implementacją, decyzje z realizacji w §16. Wersja 3: po przeglądzie planu przez trzech krytyków; decyzja właściciela z 2026-11-05: zmiana §6.7 dla wszystkich przedmiotów. Wersja 2: po przeglądzie projektu przez trzech krytyków (dydaktyka i język, kod, zakres i ryzyko). Gałąź `feature/present-continuous` od `origin/main` 3b4c1ec0.
Powiązane: #279 (poziom materiału, osobno), #280 (Present Continuous v2), #237 (agent puli — etap 3 w toku).

## 1. Cel i kontekst

Trzeci temat katalogu przedmiotu `english_grammar`: `present_continuous@1`. Główny odbiorca to 11-latek po tematach „to be” i Present Simple, który zna Present Simple niepewnie; młodsze dzieci (7–8 lat) dostają podzbiór celów wybrany przez rodzica.

Cel właściciela: dziecko ma **zrozumieć, kiedy użyć czasu**, a nie wkuć formę. Trudność polskiego ucznia leży w wyborze czasu, nie w budowie formy: polskie „Ola czyta” odpowiada i „Ola reads”, i „Ola is reading”. Dlatego porównanie z Present Simple jest częścią tematu od pierwszej sesji.

Temat to dane katalogu plus reguły przedmiotu `english_grammar` (walidator, prompty). Jedna mała zmiana silnika, dla wszystkich przedmiotów: zdanie czytane po odpowiedzi pomija czasownik w nawiasie przy luce i w zwykłym wyborze (§6.7). Bez zmian w kontraktach, bazie, Kid UI, panelu rodzica, polityce agenta, MCP i `SKILL.md`.

## 2. Zasady dydaktyczne

Źródła: TeachingEnglish (British Council) — pytania sprawdzające znaczenie zamiast formy; metaanalizy nauczania gramatyki — jawne wyjaśnienie skuteczniejsze od samej ekspozycji, obiecujące podejście „przykłady, potem reguła”; hipoteza aspektu (Andersen, Shirai) — uczniowie rzadko dodają -ing do czasowników stanu, więc reguła o nich nie jest pilna; Swan i Smith, „Learner English” — typowe błędy polskich uczniów. Badań dla dzieci 7–11 lat jest mało; zasady to synteza praktyki, nie wynik badań na tej grupie.

1. **Znaczenie od pierwszej sesji.** Cel porównania (`now_or_usually`) stoi na drugim miejscu katalogu; scheduler wprowadza dwa nowe cele na sesję w kolejności katalogu, więc pierwsza sesja to forma i wybór czasu.
2. **Przykłady przed regułą.** Pierwsza karta celu 1 to scenka bez definicji; reguła na drugiej karcie.
3. **Budowa z części, które dziecko zna:** am/is/are z „to be” + -ing.
4. **Polski jako kotwica znaczenia.** Przykład dwuznaczności to czasownik bez polskiej pary aspektowej („Ola czyta”, „Tata gotuje”). Most: „Tom jedzie na rowerze (teraz) — Tom jeździ na rowerze codziennie (zwykle)”; po polsku słychać to tylko czasem, więc zwykle trzeba zapytać siebie: teraz czy zwykle?
5. **Pytanie o znaczenie jako ćwiczenie.** W celu 2 wybór „now / usually” do zdania bez wskaźnika: dziecko czyta formę i mówi, co znaczy (§3.1, §5.5).
6. **Jednoznaczny kontekst w każdym ćwiczeniu z wyborem czasu** (§5). Wskaźnikami są też polskie scenki w poleceniu („Cicho! Dziadek śpi.”, „Gdzie jest tata?”). To nadal są słowa-klucze, tylko w scenie zamiast w angielskim zdaniu — świadomy kompromis: deterministyczna lista jest jedyną gwarancją jednoznaczności, bo agent i checker mogą być wyłączone albo się mylić.
7. **Kontrastowe pary z tym samym czasownikiem** na kartach porównania.
8. **Feedback wskazuje przyczynę:** wyjaśnienie błędu (`explanationPl`) w celach porównania nazywa wskaźnik lub scenkę („Widzisz every day? To zwykle, więc Ola reads.”).
9. **Dobry czas ze złą formą to „prawie”** w celach porównania (§7.3).
10. **Pisownia nie blokuje znaczenia.** Cele 1–4 w odpowiedziach produktywnych używają tylko czasowników, które dostają -ing bez zmian; trudną pisownię uczy cel 5, a cel 6 (po nim) używa już wszystkich (§4).
11. **Definicja dla dzieci: „teraz, w tej chwili”.** Sytuacje „w tych dniach”, tymczasowe i przyszłe są poprawną angielszczyzną, ale w v1 generator ich unika, a walidator odrzuca wskaźniki przyszłości (§5.1, #280).

## 3. Katalog `present_continuous@1`

Plik `packages/server/src/domain/lessons/subjects/english-grammar/topics/present-continuous.ts`, prefiks celów `english_grammar.present_continuous`. Rejestracja: `topics: [presentSimpleV1, toBeV1, presentContinuousV1]` w `module.ts`.

### 3.1 Cele

| # | id | `titlePl` (widzi rodzic) | Typy ćwiczeń |
|---|---|---|---|
| 1 | `affirmative` | „Teraz: am/is/are + -ing” | card, notice, choice, listen_choice, order, gap, error_fix, open_answer |
| 2 | `now_or_usually` | „Teraz czy zwykle? (po Present Simple)” | card, choice, gap, error_fix, open_answer |
| 3 | `negative` | „Przeczenie: isn't / aren't + -ing” | card, choice, listen_choice, gap, error_fix, transform, open_answer |
| 4 | `questions` | „Pytania i krótkie odpowiedzi” | card, choice, listen_choice, order, short_answer, gap, transform, open_answer |
| 5 | `ing_spelling` | „Pisownia -ing” | card, choice, gap, error_fix, open_answer |
| 6 | `now_or_usually_more` | „Teraz czy zwykle? Przeczenia i pytania” | card, choice, gap, error_fix, open_answer |

Typy oznaczają `lesson_*`. Każdy cel ma typ etapu prowadzonego, produktywnego i samodzielnego (`catalog-validation.ts`). `listen_choice` tylko tam, gdzie różnica jest słyszalna i należy do sprawdzanego elementu: w celach porównania lektor czytałby zdanie ze wskaźnikiem, więc słuchanie nie sprawdzałoby wyboru czasu — pominięte.

Zakres celów:
- **1 `affirmative`:** twierdzenia z czasownikami czynności; podmiot zaimek, imię albo rzeczownik z materiału (także liczba mnoga: „The dogs are running.”). `listen_choice`: is / are.
- **2 `now_or_usually`:** wybór Present Simple albo Present Continuous wyłącznie w zdaniach twierdzących (przeczenia i pytania należą do celu 6), ze wskaźnika albo scenki (§5.2); plus `lesson_choice` „now / usually” (§5.5).
- **3 `negative`:** am not / isn't / aren't + -ing. `listen_choice`: isn't / aren't. `transform`: `to_negative`.
- **4 `questions`:** pytania ogólne (Is she reading?), krótkie odpowiedzi (Yes, she is. / No, they aren't.) i stały zwrot „What + am/is/are + podmiot + doing?” z odpowiedzią pełnym zdaniem. `listen_choice`: Is / Are na początku pytania. `transform`: `to_question`.
- **5 `ing_spelling`:** pisownia formy -ing; tylko czasowniki z reguł na kartach (§4).
- **6 `now_or_usually_more`:** wybór czasu w przeczeniach i pytaniach (doesn't vs isn't, Do you…? vs Are you…?). Luka tylko w przeczeniach; pytania wyłącznie w `choice` (całe zdania) i `open_answer` — w luce pytania forma po podmiocie zdradza odpowiedź.

Przekształcenia tematu: `to_negative` „Zamień na przeczenie”, `to_question` „Zamień na pytanie”, `to_affirmative` „Zamień na zdanie twierdzące”.

Rekomendacja wyboru celów (w SPEC i opisie PR; formularz rodzica bez zmian, domyślnie zaznacza wszystkie):
- dziecko po temacie Present Simple: cele 1, 2, 4 (młodsze), wszystkie (11-latek);
- dziecko bez Present Simple: cele 1, 3, 4; cel 2 i 6 dopiero po temacie Present Simple.

### 3.2 Karty (szkic treści; jedno–dwa krótkie zdania na kartę, 2–4 karty na cel — `catalog-validation.ts`)

Cel 1 `affirmative`:
- „Co się dzieje?”: „Popatrz! Tom is jumping. Mum is cooking. To dzieje się teraz, w tej chwili.”
- „Dwie części”: „am, is, are już znasz. Dokładasz czasownik z -ing: she is reading, they are playing.”
- „Przykłady z lekcji”: „Zobacz, co dzieje się teraz: {{examples}}”

Cel 2 `now_or_usually`:
- „Teraz czy zwykle?”: „Po polsku „Ola czyta” to i teraz, i zwykle. Po angielsku wybierasz: teraz — Ola is reading, zwykle — Ola reads. Zapytaj siebie: teraz czy zwykle?”
- „Dwa zdania”: „Dad cooks dinner every day. — to zwykle. Look! Dad is cooking now. — to teraz.”
- „Po polsku czasem słychać”: „Tom jedzie na rowerze — teraz: Tom is riding his bike now. Tom jeździ na rowerze codziennie — zwykle: Tom rides his bike every day.”
- „Przykłady z lekcji”: „Teraz czy zwykle? Sprawdź na przykładach: {{examples}}”

Cel 3 `negative`:
- „Dodaj not”: „Przeczenie to am not, isn't albo aren't + czasownik z -ing: he isn't sleeping, we aren't playing.”
- „Bez don't”: „Tu nie ma don't ani doesn't: she isn't reading, a nie „she doesn't reading”.”
- „Przykłady z lekcji”: „Popatrz na przeczenia z lekcji: {{examples}}”

Cel 4 `questions`:
- „Zamień kolejność”: „W pytaniu am, is, are stoi na początku, przed osobą: Is she reading? Are they playing?”
- „Krótka odpowiedź”: „Odpowiadasz tą samą formą: Yes, she is. No, they aren't.”
- „Co teraz robisz?”: „What are you doing? — Co teraz robisz? What is he doing? — Co on teraz robi?”
- „Przykłady z lekcji”: „Zobacz pytania z lekcji: {{examples}}”

Cel 5 `ing_spelling`:
- „Zwykle tylko -ing”: „Najczęściej dokładasz samo -ing: play → playing, read → reading, jump → jumping.”
- „Znika e, ie → y”: „Końcowe e znika: make → making, write → writing (jedno t!). Końcówka ie zmienia się w y: lie → lying, tie → tying.”
- „Podwójna litera”: „Gdy słowo ma jedną sylabę i kończy się jedną samogłoską i jedną spółgłoską, podwajasz ostatnią literę: run → running, swim → swimming, sit → sitting. Nie podwajasz w, x, y: play → playing, fix → fixing, snow → snowing. Ale: jump → jumping (dwie spółgłoski).”
- „Przykłady z lekcji”: „Sprawdź pisownię na przykładach: {{examples}}”

Cel 6 `now_or_usually_more`:
- „Jak pytasz?”: „Pytasz o to, co dzieje się zwykle → Do / Does. Pytasz o to, co dzieje się teraz → Am / Is / Are.”
- „Pytania”: „Do you play football on Saturdays? — zwykle. Are you playing football right now? — teraz.”
- „Przeczenia”: „She doesn't watch TV on Mondays. — zwykle. She isn't watching TV right now. — teraz.”
- „Przykłady z lekcji”: „Przy każdym przykładzie zapytaj siebie: teraz czy zwykle? {{examples}}”

Szkic jest wyrównany z katalogiem `present-continuous.ts` (Task 13c); ostateczne brzmienie ustala implementacja, a kontrolą jest test spójności katalogu i przegląd w PR. Zdania kart **nie** trafiają do listy „zdań do unikania” (poprawka po krytyku końcowym B, Task 16): przedmiot `english_grammar` nie ma `cardExposureTexts`, więc `cardExposureSources` daje dla jego tematów pusty zbiór, a ćwiczenie równe zdaniu karty przechodzi (tłumaczenie „Tata codziennie gotuje obiad.” → „Dad cooks dinner every day.”, zdanie karty celu 2). Przed kopiowaniem chroni tylko wskazówka „Never copy an example from the objective's cards…” (`PC_GUIDANCE`) i test przykładów typów. `cardExposureTexts` dla gramatyki dotyka też Present Simple i „to be” — osobne zgłoszenie (follow-up po tym PR).

### 3.3 Kategorie błędów

Nowe w `extraErrorCategories` tematu (walidacja katalogu sprawdza unikalność w obrębie tematu i względem kategorii bazowych i przedmiotu, nie między tematami — `catalog-validation.ts`; `wrong_be_form` i `missing_be_form` istnieją też w temacie `to_be`):

| code | `labelPl` |
|---|---|
| `wrong_be_form` | Zła forma czasownika „to be” (am/is/are) |
| `missing_be_form` | Brak formy czasownika „to be” (np. „he playing”, „he not playing”) |
| `missing_ing` | am/is/are bez -ing (np. „she is play”, „she is plays”) |
| `ing_spelling` | Błąd w pisowni -ing |
| `be_plus_simple` | Mieszanie czasów: am/is/are przy czynności codziennej (np. „I'm go to school every day”) |
| `continuous_for_habit` | -ing zamiast zwykłego czasu (czynność codzienna) |
| `simple_for_now` | Zwykły czas zamiast -ing (czynność teraz) |

Przypisanie do celów (każda kategoria celu ma szablon podpowiedzi):
- 1: `missing_be_form`, `wrong_be_form`, `missing_ing`
- 2: `continuous_for_habit`, `simple_for_now`, `be_plus_simple`
- 3: `wrong_negation`, `missing_be_form`, `wrong_be_form`, `missing_ing`, `extra_auxiliary`
- 4: `word_order`, `missing_be_form`, `wrong_be_form`, `extra_auxiliary`, `short_answer_form`, `missing_ing`
- 5: `ing_spelling`, `missing_ing`
- 6: `continuous_for_habit`, `simple_for_now`, `be_plus_simple`

Cele 2 i 6 celowo nie mają kategorii formy (`missing_ending`, `wrong_auxiliary`, `extra_ending`): błąd formy przy dobrze wybranym czasie to werdykt „prawie” bez kategorii (§7.3). Podpowiedzi celów 2 i 6 powtarzają refren „Zapytaj siebie: teraz czy zwykle?”. `missing_ing`: „Gdy jest am/is/are, czasownik ma -ing: she is playing.” `be_plus_simple`: „Gdy coś dzieje się zwykle, nie ma am/is/are: I go to school every day.”

## 4. Forma -ing

Nowy plik `packages/server/src/domain/lessons/subjects/english/ing-forms.ts` (+ test): zamknięta tabela ok. 80 czasowników czynności poziomu A1–A2 → forma -ing w pisowni brytyjskiej (`answerLocale: en-GB`), z klasą reguły pisowni:

- `plain` (play → playing, read → reading, jump → jumping, fix → fixing, do → doing — potrzebne do „What … doing?”),
- `drop_e` (make → making, write → writing, ride → riding),
- `double` (run → running, swim → swimming, sit → sitting, get → getting),
- `ie_to_y` (lie → lying, tie → tying; tylko te dwa — „die” pomijamy w materiale dla dzieci),
- `other` (travel → travelling i podobne; poza celem 5).

API (czyste funkcje):
- `ingFormOf(base: string): string | undefined` — `undefined` dla czasownika spoza tabeli;
- `ingRuleOf(base: string): "plain" | "drop_e" | "double" | "ie_to_y" | "other" | undefined`;
- `baseOfIngForm(form: string): string | undefined` — odwrotność po tabeli;
- `isIngFormInTable(token: string): boolean` — odróżnia formę -ing od „morning”, „sing”, „thing”.

Tabela zamiast reguł: podwojenie zależy od akcentu (visit → visiting, begin → beginning), a brytyjskie „-ll” od konwencji. Tabela nie zawiera czasowników stanu (§5.3).

Użycie według celu (odpowiedź kanoniczna, warianty i czasownik w nawiasie luki — także gdy odpowiedzią jest forma Present Simple, np. „He ___ (swim) every day.” w celu 2 jest odrzucane):
- cele 1, 2, 3, 4: tylko klasa `plain`;
- cel 5: klasy `drop_e`, `double`, `ie_to_y` (każde ćwiczenie ćwiczy jedną z reguł z kart); `plain` dopuszczone w ćwiczeniach prowadzonych (`choice`) jako kontrast;
- cel 6: klasy `plain`, `drop_e`, `double`, `ie_to_y`.

Czasownik spoza tabeli albo spoza dozwolonych klas w sprawdzanym miejscu odrzuca ćwiczenie. Wyjątek: formy -ing z kolokacji dozwolonych w §5.3 („having” + posiłek/kąpiel/zabawa, „looking” + at/for) są przyjmowane poza tabelą w każdym celu poza 5 (cel 5 ćwiczy pisownię z tabeli).

## 5. Reguły jednoznaczności

### 5.1 Wskaźniki czasu (zamknięte listy; jeden moduł stałych)

Nowy plik `english-grammar/time-markers.ts` z listami i funkcją klasyfikacji tekstu. Dopasowanie po tokenach z normalizacji przedmiotu; wykrzyknienia sprawdzane na surowym tekście (normalizacja usuwa „!”).

- **Teraz (EN):** now, right now, at the moment; na początku zdania jako wykrzyknienie albo z przecinkiem: Look!, Listen!, Shh!, Be quiet!. Słowa look / listen poza tą pozycją nie są wskaźnikiem („They listen to music every day”).
- **Zwykle (EN):** every + rzeczownik czasu (day, week, morning, evening, night, weekend, summer, Monday…Sunday), usually, always, often, sometimes, never, on Mondays…on Sundays (liczba mnoga), at weekends, once a week, twice a week, N times a week/day.
- **Teraz (PL):** teraz, właśnie, w tej chwili, w tym momencie, akurat; na początku zdania jako wykrzyknienie: Cicho!, Ciii!, Patrz!, Popatrz!, Spójrz!, Zobacz!, Posłuchaj!, Słuchaj!; pytanie „Gdzie jest …?” / „Gdzie są …?” na początku polecenia.
- **Zwykle (PL):** codziennie, każdego dnia/ranka/wieczoru, co rano, co wieczór, co tydzień, co sobotę, w każdy, w każdą, w każde, w poniedziałki…niedziele, w weekendy, zwykle, zazwyczaj, zawsze, często, czasem, czasami, rzadko, nigdy.
- **Zakazane we wszystkich celach tematu** (przyszłość i dwuznaczność): tomorrow, tonight, next + rzeczownik, this evening, this morning, this afternoon, today, on + dzień tygodnia w liczbie pojedynczej („on Saturday”), at the weekend, jutro, wieczorem (bez „co”), dzisiaj. Ćwiczenie z którymkolwiek z nich jest odrzucane.

### 5.2 Wymóg w celach 2 i 6

Skanowane pola: `stem`, `statement`, `answer`, `acceptedAnswers`, opcje, `instructionPl`, `prompt`. Pomijane: `explanationPl`, `hint`, karty.

Każde ćwiczenie (poza kartą i wyborem „now / usually”, §5.5) ma co najmniej jeden wskaźnik z §5.1, a wszystkie wskaźniki ćwiczenia należą do jednej grupy (teraz albo zwykle). Czas odpowiedzi kanonicznej i wariantów zgadza się z grupą: „teraz” → Present Continuous, „zwykle” → Present Simple. Formy Present Simple zgadzają się z osobą (3. osoba liczby pojedynczej → forma z -s, `does`/`doesn't`; pozostałe → forma podstawowa, `do`/`don't`). Ćwiczenie bez wskaźnika, z mieszanymi grupami albo z formą niezgodną z grupą lub osobą jest odrzucane.

„Scenka” to wskaźnik PL w `instructionPl` (dla `open_answer`: w `prompt`). Prompt prosi, by mniej więcej połowa ćwiczeń celów 2 i 6 opierała się na scence; walidator tego nie egzekwuje (model nie trzyma proporcji w puli). Proporcję mierzy sonda (§11.3).

### 5.3 Czasowniki stanu

Zamknięta lista: like, love, hate, prefer, want, need, wish, know, understand, believe, remember, forget, recognise, mean, seem, sound, cost, own, belong, think, see, hear, feel, taste, smell, have, look (poza wyjątkami). Czasownik „be” nie jest na liście (am/is/are budują sam czas); rozpoznawana jest tylko forma „being” („He is being silly” — odrzucane we wszystkich celach).

- Cele 2 i 6: żadne skanowane pole nie zawiera czasowników z listy w dowolnej formie, z wyjątkami: „have” w kolokacjach breakfast / lunch / dinner / a bath / a shower / fun / a party; „look at”, „look for”; wykrzyknienie „Look!”.
- Wszystkie cele: czasownik z listy nie występuje w formie -ing w odpowiedziach i wariantach, z tymi samymi wyjątkami („She is having lunch”, „He is looking at the stars” są dozwolone).

### 5.4 Tłumaczenia w celach 1, 3, 4, 5

`prompt` (polskie zdanie do przetłumaczenia) zawiera wskaźnik „teraz” z §5.1 (PL), bo „Mama gotuje” bez kontekstu ma dwa poprawne tłumaczenia. Odpowiedź kanoniczna zawiera odpowiednik wskaźnika, gdy jest dosłowny (teraz → now, w tej chwili → at the moment, Patrz! → Look!); prompt nie każe generować wariantów bez niego (sędzia wariantów agenta odrzuca warianty z usuniętą treścią). Odpowiedź dziecka bez „now” nie dopasuje się deterministycznie i trafi do modelu oceniającego (gdy skonfigurowany).

### 5.5 Wybór „now / usually” (cel 2)

Wyjątek od §5.2: `lesson_choice` z opcjami dokładnie „now” i „usually”, bodziec to zdanie twierdzące w Present Simple albo Present Continuous **bez** wskaźnika („Ola is reading a book.”), polecenie „Kiedy to się dzieje?”. Klucz wynika z czasu zdania (PC → now, PS → usually). Walidator sprawdza: brak wskaźników w bodźcu, forma zdania jednoznacznie PS albo PC, klucz zgodny z czasem. Tożsamość ćwiczenia wyboru to sam bodziec (`exercise-identity.ts`), więc bodźce muszą się różnić — jak w każdym wyborze.

### 5.6 Różne bodźce wyborów na scenkach

Tożsamość `lesson_choice` to znormalizowany `stem` bez `instructionPl`, a przedmiot deduplikuje ćwiczenia (`poolDeduplication: "exercise"`). Dwa wybory z gołą ramą „Ola ___ .” i różnymi scenkami to duplikat. Prompt wymaga ramy z dopełnieniem albo okolicznikiem różnym w każdym ćwiczeniu („Ola ___ a comic.”); deduplikacja silnika zostaje bez zmian i odrzuca powtórzenia.

## 6. Walidator przedmiotu

Plik `english-grammar/validators.ts`: nowa gałąź `topic.id === "present_continuous"` w `validateEnglishGrammarExercise`, umieszczona przed ogólną gałęzią `lesson_gap` (dziś ok. l. 572). Kod tematu w nowym pliku `english-grammar/present-continuous-validation.ts` (walidator ma już ok. 600 linii); reguły `error_fix`, `notice` i `listen_choice` w siostrzanym `present-continuous-exercise-rules.ts`, a wybór czasu celów 2 i 6 w `present-continuous-tense-choice.ts` (§16.6). Ogólna gałąź luki Present Simple nie jest dla tematu PC osiągana (m.in. `objectiveAllowsOperator` patrzy na ostatni segment id, wspólny dla `negative` w PS i PC).

### 6.1 Wydzielenie wspólnych funkcji „to be”

Funkcje `bePronounNearGap`, `expectedBeFormNearGap`, `parseBeGapAnswer`, `checkBePolarity` i część `validateBeAnswerText` (zgodność osoby z formą be, reguła „Yes, I'm.”) przenosimy do `english-grammar/be-agreement.ts` jako czyste funkcje. Tak samo `presentSimpleForms`, `isAcceptablePresentSimpleAnswer` i ich stałe (`IRREGULAR_THIRD_PERSON`, `VOWELS`) przenosimy do `english-grammar/present-simple-forms.ts` — inaczej plik PC importowałby `validators.ts`, a `validators.ts` plik PC (cykl). Osobny commit: czyste przeniesienie bez zmiany zachowania, testy `to_be` i Present Simple zielone przed i po. Dopiero następny commit: `checkBePolarity` dostaje mapę cel → biegunowość zamiast stałych identyfikatorów celów `to_be`. Temat PC nie używa `validateBeAnswerText` w całości (odrzuca do/does, potrzebne w celu 6) ani `parseBeGapAnswer` (zwraca `null` dla „is swimming”) — ma własny parser odpowiedzi luki.

### 6.2 Luka (`lesson_gap`)

Dwa kształty, rozpoznawane po treści luki:

- **Luka z czasownikiem:** luka obejmuje całą formę czasownika, a forma podstawowa stoi w nawiasie tuż za luką: „He ___ (play) football now.” (cel 1), „He ___ (swim) now.” (cel 5), „Ola ___ (read) a comic every evening.” (cel 2). W przeczeniu nawias zawiera „not” + formę podstawową, bo bez niego twierdzenie też byłoby poprawne: „She ___ (not watch) TV now.” → „isn't watching”, „She ___ (not watch) TV every morning.” → „doesn't watch”. Nawias z „not” jest wymagany w luce z czasownikiem w celu 3 i w lukach celu 6, a zakazany w celach 1, 2, 4 i 5. Odpowiedź:
  - cele 1, 3, 5: am / is / are [not] + forma -ing (skróty isn't / aren't dozwolone; bez samego „'m” — normalizacja zdejmuje apostrof z brzegu tokenu);
  - cele 2 i 6: forma Present Simple albo Present Continuous zgodna z grupą wskaźnika i osobą (§5.2); w celu 6 tylko przeczenia (doesn't / don't + forma podstawowa albo isn't / aren't / am not + -ing).
- **Luka na formę be:** luka obejmuje tylko formę be, a forma -ing stoi w zdaniu; bez nawiasu: „___ she reading a book?” → „Is”, „Yes, she ___.” → „is”, „They ___ playing now.” → „are”. Tylko cele 1, 3, 4.

W `lesson_gap` `hint` jest zawsze pusty (reguła nie dotyczy pozostałych typów, §16.2): checker agenta i kartkówka go nie widzą (`agent/solver.ts`, `lesson-materialize.ts`), więc czasownik musi być w zdaniu. Nawias w bodźcu dopuszczalny jest wyłącznie tuż po luce `lesson_gap`; nawias w innym miejscu luki oraz w bodźcu i opcjach `lesson_choice` / `lesson_listen_choice` odrzuca ćwiczenie (`pc-shape:`) — tam nawias nie jest usuwany ze zdania czytanego przez lektora.

Forma be zgodna z podmiotem. Podmiot ustala ta sama logika co w temacie `to_be` (`expectedBeFormNearGap` na bodźcu po usunięciu nawiasu): pomija przysłówki przed luką („They always ___”), okolicznik na początku zdania („Every day Ola ___”, „On Saturdays they ___”) i obsługuje pytania („What ___ they doing?”, „___ she reading?”). Podmioty: zaimki, imiona, rzeczowniki w liczbie mnogiej regularnej i nieregularnej z tabeli — children, people, men, women, mice, feet, teeth — oraz podmiot złożony „X and Y” → are; imiona zakończone na -s, np. „James”, traktowane jako liczba pojedyncza; dodanie „mice” do tabeli liczby mnogiej dotyczy też tematu `to_be` i jest zamierzone). Biegunowość zgodna z celem (1, 2, 5 — twierdzenie; 3 — przeczenie; 4 i 6 — dowolna) albo z przekształceniem (`to_negative` → przeczenie, `to_affirmative` → twierdzenie, `to_question` → dowolna). Odpowiedź luki ma najwyżej 3 słowa po rozwinięciu skrótów (istniejące `MAX_GAP_ANSWER_TOKENS`). Forma -ing z tabeli i z dozwolonej klasy (§4). Doprecyzowania reguł luki (pytania, nawias po formie be, biegunowość luki na formę be): §16.2.

### 6.3 Całe zdania (choice, error_fix, transform, short_answer, open_answer, order)

- Każda forma be w odpowiedzi i wariantach zgadza się z podmiotem; po formie be w zdaniu PC stoi forma -ing z tabeli i dozwolonej klasy.
- Odpowiedź poprawna nie zawiera am / is / are + forma bez -ing („She is plays”, „She is play”).
- **Skróty z „'s”:** `answer` i `acceptedAnswers` nie zawierają he's / she's / it's / what's / that's / there's / where's — `contractions.ts` rozwija je do „is” albo „has”, a dopasowanie przyjmuje dowolny wspólny wariant, więc klucz „He's running.” zaliczyłby „He has running.”. Dziecko może wpisać „He's running” — dopasuje się do klucza „He is running” (`evaluate.ts`). Skrót po rzeczowniku („Mum's cooking”) nie jest rozwijany, nie dopasuje się deterministycznie i trafi do modelu oceniającego (gdy skonfigurowany); klucz używa wtedy pełnego „is”.
- Pytanie szczegółowe tylko we wzorcu „What + am/is/are + podmiot + doing?”; inne pytajniki odrzucają ćwiczenie.
- **`error_fix`:** błędne zdanie (`statement`) i odpowiedź po normalizacji (z rozwinięciem skrótów) różnią się jednym spójnym obszarem tokenów (diff tokenów: wspólny prefiks i sufiks, reszta to obszar; najwyżej 3 tokeny po każdej stronie). Obszar zawiera sprawdzany element celu, klasyfikowany deterministycznie: brak formy be (cele 1, 3, 4), brak -ing albo forma bez -ing po be (1, 3, 4), zła pisownia -ing — forma błędna nie jest w tabeli, a poprawna jest (5), zamiana PS ↔ PC (2, 6: jedna strona to forma Present Simple czasownika, druga to be + jego forma -ing, np. „Look! Ola reads.” → „Look! Ola is reading.”, „Ola is reading every day.” → „Ola reads every day.”; strona poprawna zgodna z grupą wskaźnika). Inny obszar różnicy odrzuca ćwiczenie. Zakres dozwolonych obszarów w celach 1, 3, 4 jest szerszy niż wyżej: §16.3.
- **Warianty równoważne:** `acceptedAnswers` równoważne kluczowi po normalizacji („is not watching” przy „isn't watching”) silnik usuwa przy zapisie (`withoutRedundantAcceptedVariants`), więc obie formy przeczenia dziecka dopasowuje normalizator, nie lista wariantów.
- **Wyciek między ćwiczeniami** (wybór „Dad ___ dinner now.” obok tłumaczenia „Tata teraz gotuje obiad.”): świadomie bez nowej reguły — ten sam stan jest dziś w temacie Present Simple, a sesja ma 5–10 minut; test przypina, że pula z taką parą przechodzi walidację.
- Cele 2 i 6: reguły §5.2 i §5.3; w celu 2 tylko zdania twierdzące (pytajnik albo not / n't w odpowiedzi odrzuca ćwiczenie), w celu 6 pytania tylko w `lesson_choice` i `lesson_open_answer`. Cele 1, 3, 4, 5: §5.3 (bez -ing przy czasownikach stanu) i §5.4 dla `open_answer`.
- Wszystkie cele: wskaźniki zakazane z §5.1.

### 6.4 Wybór (`lesson_choice`) i polski kontekst

Polski kontekst (scenka) tylko w `instructionPl` — Kid UI renderuje bodziec z `lang` en-GB, a nagranie zdania po odpowiedzi czyta bodziec angielskim lektorem. Bodziec to angielskie zdanie z luką, opcje to formy („reads” / „is reading”) albo całe zdania (cel 6, pytania). Reguła w prompcie; walidator jej nie egzekwuje (filtr diakrytyków przepuściłby „Ola czyta” i odrzucił polskie imiona z materiału).

### 6.5 „Wskaż słowo” (`lesson_notice`)

Tylko cel 1: dziecko wskazuje formę -ing; segmentacja na pojedyncze słowa. Reguła tematu (w walidatorze PC, nie ogólna): we wszystkich zdaniach ćwiczenia jest dokładnie jeden token, dla którego `isIngFormInTable` zwraca `true`, i jest nim `correctOption`. Inaczej dziecko wskazałoby inną poprawną formę -ing i dostało błąd (materializacja bierze pierwszy pasujący segment, ocena porównuje identyfikator). Bez zmian w `pool-validation.ts` — ogólna reguła zablokowałaby publikację istniejących szkiców (`validatePool` działa przy edycji i publikacji).

### 6.6 Posłuchaj i wybierz (`lesson_listen_choice`)

Cele 1, 3, 4. Istniejące reguły (`listenChoiceSibilantErrors`, brak `instructionPl`) obowiązują. Opcje z is / are, isn't / aren't, Is / Are; nie „He's” / „He”.

### 6.7 Zdanie po odpowiedzi bez nawiasu (zmiana silnika, wszystkie przedmioty)

`feedbackSentenceText` (`domain/lessons/feedback-sentence-text.ts`) dla `lesson_gap` i zwykłego `lesson_choice` usuwa nawias stojący bezpośrednio po luce (stała `GAP_VERB_BRACKET`, `/(_{2,})\s*\(([^)]*)\)/` → luka) przed wstawieniem odpowiedzi. Bez tego zdanie czytane dziecku po odpowiedzi brzmi „He is swimming (swim) now.”: lektor TTS nagrywa „(swim)” (`ttsForFeedbackSentence: true`, `media-reconciliation.ts`), a bariera ekspozycji historyjki (`solvedSentencesOf`, `story.ts`) nie rozpoznaje zdania „He is swimming now.”. Walidator Present Continuous (`stripGapVerb`) używa tej samej stałej.

Konwencja „___ (czasownik)” **już istnieje** w Present Simple: używają jej fixture'y i testy (`tests/fixtures/lesson-world.ts`, także zwykły wybór, `fake.test.ts`, `grader.test.ts`, spec E2E edytora) i może ją pisać generator mimo reguły o `hint`, więc ten sam błąd dotyczy dziś istniejących lekcji. Decyzja właściciela (2026-11-05): zmiana dla wszystkich przedmiotów, bez flagi tematu.

Zakres: tylko nawias tuż po luce; `lesson_gap` i `lesson_choice` (rozstrzygnięcie po przeglądzie: w zwykłym wyborze błąd jest ten sam — lektor czytał „He plays (play) football.”; tożsamość wyboru to bodziec, więc się nie zmienia). `lesson_listen_choice` bez zmian: to samo nagranie jest tam bodźcem ćwiczenia (§19.12 architektury), a walidator PC i tak nie dopuszcza w nim nawiasu. Nawias dalej w zdaniu zostaje. Skutki dla istniejących danych:
- **Opublikowane wersje bez zmian:** sesja bierze nagranie zdania przypięte do rewizji (`revision_assets`, rola `feedback_audio`), nie liczy tekstu od nowa.
- **Szkice:** każde uzgodnienie mediów liczy tekst od nowa, więc luka albo wybór z nawiasem dostaje nowe nagranie zdania bez nawiasu — jedno płatne nagranie TTS na takie ćwiczenie. Uzgodnienie robi nie tylko edycja: także publikacja szkicu bez żadnej edycji (`reconcileBeforePublish` przed transakcją publikacji, `lesson-api.ts`), zapis generowania, nadzoru i odświeżenie nagrań polecenia. Publikacja na `feedback_audio` nie czeka (bramką jest tylko `target_audio`, a przedmioty lekcji mają `ttsForAnswers: false`), więc pierwsza publikacja takiego szkicu nie kończy się błędem „media w toku”; zadanie wydane przed gotowością nowego nagrania zostaje bez odczytu zdania.
- **Historyjka:** bariera ekspozycji zaczyna wykrywać zdania historyjki równe rozwiązaniu takiej luki albo wyboru. Nowe ćwiczenia z kolizją odpadają przy zapisie puli (`lesson-drafts.ts`), a zapis historyjki i publikacja szkicu z kolizją kończą się błędem walidacji historyjki (`lesson-api.ts`, `assertStoryValid`) — rodzic zmienia albo generuje historyjkę od nowa. **Każda** edycja ćwiczeń szkicu (`patch.exercises`) sprawdza barierę na całej puli, więc niezwiązana poprawka innego ćwiczenia też może skończyć się tym błędem, jeśli w szkicu jest stara luka z nawiasem kolidująca z historyjką. To poprawne zachowanie (wcześniej odpowiedź wyciekała), ale może zatrzymać zapis albo publikację szkicu, który dziś przechodzi; opis PR to mówi.
- **Generator historyjki:** dostaje rozwiązane zdania bez nawiasu (lista zdań do niepowtarzania) — zmiana bez skutków ubocznych.
- **Klucz ekspozycji rozdziału angielskiego bez zmian:** `chapterExposureText` (`english-chapter/exposure.ts`) wypełnia lukę bez usuwania nawiasu, bo jego wynik jest utrwalony w `target_key` (zmiana wymagałaby migracji kluczy). W `english_chapter` luka z nawiasem ma więc klucz ekspozycji z nawiasem, a nagranie zdania po odpowiedzi — zdanie bez nawiasu; to zamierzone (Task 16, krytyk C).
- **Nawias, który nie jest czasownikiem:** wzorzec usuwa każdy nawias tuż po luce, bez względu na treść. W rozdziale angielskim (`english_chapter`, `ttsForFeedbackSentence: true`) wskazówka w nawiasie po luce nie trafi do nagrania zdania; w innych przedmiotach (np. jednostka „Woda wrze w ___ (°C).”) znika z tekstu zdania i bariery historyjki. Opis PR to wymienia.

Testy: `feedback-sentence-text.test.ts` (luka z nawiasem, z „(not …)”, luka bez nawiasu, nawias dalej w zdaniu, zwykły wybór bez nawiasu, „posłuchaj i wybierz” bez zmian), `media-reconciliation.test.ts` (tekst `feedback_audio` luki i wyboru bez nawiasu, „posłuchaj i wybierz” bez zmian), `story.test.ts` (kolizja wykryta) oraz przegląd istniejących testów i fixture'ów z „___ (…)”, których oczekiwane zdanie się zmienia.

## 7. Prompty

Plik `english-grammar/prompts.ts`. Prompt agenta puli składa się z `lessonSystemPrompt` (`fieldRules` przedmiotu i opisy celów — `llm.ts`, `lesson-pool-agent.ts`), więc zmiany obejmują agenta bez zmian w jego kodzie. Checker nie dostaje `fieldRules` — widzi widok ćwiczenia (`solverView`), w tym `stem` z nawiasem i `instructionPl` ze scenką.

### 7.1 Zawężenie reguł Present Simple

Zdania `fieldRules` o luce w Present Simple, `hint` jako bezokoliczniku i operatorze do/does dotyczą dziś całego przedmiotu. Zawężamy je do „objectives whose id contains '.present_simple.'” (wzorem bloku `.to_be.`). Nowy blok zaczyna się od „For objectives whose id contains '.present_continuous.'”.

### 7.2 Blok `.present_continuous.`

Treść (po angielsku, dla modelu):
- luka: dwa kształty z §6.2 (czasownik w nawiasie tuż za luką albo luka na formę be bez nawiasu), `hint` null, odpowiedź do 3 słów; nawias nigdzie poza tym miejscem, w szczególności nie w wyborze i „posłuchaj i wybierz”;
- tylko sytuacje „right now”, czasowniki czynności; zakazane wskaźniki przyszłości z §5.1; nigdy czasowniki stanu z §5.3 w formie -ing (z wyjątkami);
- w celach 1–4 tylko czasowniki dostające -ing bez zmian (play, read, jump…); w celu 5 czasowniki z reguł kart; listy czasowników do wyboru generowane z tabeli §4;
- tłumaczenia celów 1, 3, 4, 5: polskie zdanie ze wskaźnikiem „teraz”; odpowiedź z odpowiednikiem wskaźnika; bez wariantów z usuniętym wskaźnikiem;
- klucze bez skrótów z „'s” (§6.3);
- „What + am/is/are + subject + doing?” jako jedyne pytanie szczegółowe;
- cele 2 i 6: każde ćwiczenie z jednoznacznym kontekstem (wskaźniki jednej grupy albo polska scenka w `instructionPl`); mniej więcej połowa na scence bez angielskiego wskaźnika; nigdy czasowniki stanu; polecenie nie zawiera refrenu „teraz czy zwykle” (zawiera wskaźniki obu grup — ćwiczenie zostałoby odrzucone); `explanationPl` nazywa wskaźnik lub scenkę; ramy wyboru różnią się dopełnieniem (§5.6); w celu 6 luka tylko w przeczeniach;
- cel 2: wybór „now / usually” (§5.5);
- polski tekst tylko w `instructionPl` / `prompt`, bodziec i opcje po angielsku;
- „always” + PC (narzekanie) nie jest uczone.

Listy wskaźników i czasowników w tekście promptu składa szablon w `prompts.ts` ze stałych `time-markers.ts` i `ing-forms.ts` (bez cyklu z walidatorem: stałe nie importują walidatora ani promptów).

### 7.3 Opisy celów (`descriptionEn`) i werdykt „prawie”

Model oceniający działa tylko dla odpowiedzi tekstowych niedopasowanych deterministycznie i tylko gdy jest skonfigurowany (`UMIEM_GRADER_*`); bez niego taka odpowiedź jest „nieoceniona”. `gradeFromVerdict` (`evaluate.ts`) zamienia `almost` z kategorią inną niż `null`/`other` na `incorrect`, a `almost` bez kategorii liczy się jak sukces celu (seria awansu etapu nie jest przerywana).

`descriptionEn` celów 2 i 6 definiuje sprawdzany element jako **wybór czasu** (nie formę czasownika) i mówi wprost: dobrze wybrany czas z błędem formy (brak -s, „doesn't eats”, brak operatora w pytaniu, błąd pisowni -ing) → `almost` z `errorCategory: null`; zły czas → `incorrect` z `continuous_for_habit` / `simple_for_now`; hybryda („I'm go every day”) → `incorrect` z `be_plus_simple`. To nie przeczy ogólnej `almostDefinition` przedmiotu („błąd w sprawdzanym elemencie nigdy nie jest almost”), bo sprawdzanym elementem jest tu wybór czasu. Konsekwencja świadoma: w celach porównania błąd formy Present Simple nie obniża postępu; formę Present Simple ćwiczy jego własny temat.

Opisy celów 2 i 6 mówią też, że historyjka może mieszać Present Simple i Present Continuous (§9); opisy celów 1, 3, 4, 5 tego nie mówią.

## 8. Agent puli (#237)

Bez zmian w `agent-policy.ts` gramatyki. Czasownik w nawiasie (§6.2) daje checkerowi wszystko do rozwiązania luki na ślepo; dwuznaczność zamyka deterministycznie walidator (§5), checker jest niezależną drugą kontrolą. Odrzucenia agenta mają kod bez treści i `detail` z komunikatami walidatora (`RejectionLogEntry`, `lesson-pool-agent-tools.ts`); błędy walidatora przedmiotu trafiają pod jeden kod, więc sonda (§11.3) dzieli `detail` po „; ” i liczy komunikaty PC po stałych prefiksach: `pc-marker:`, `pc-ing:`, `pc-be:`, `pc-state:`, `pc-error-fix:`, `pc-notice:`, `pc-shape:` (pozostałe reguły kształtu: nawias, `hint`, skróty z 's, pytajniki, typ zdania). Prefiksy widzi też rodzic w błędach walidacji przy ręcznej edycji szkicu (`lesson-api.ts`) — tak jak dziś widzi techniczne komunikaty walidatora; świadomie bez osobnych tekstów dla rodzica.

## 9. Historyjka

Do promptu historyjki trafiają opisy wybranych celów (`lesson-story-generation.ts`). Wspólnych `storyRules` nie zmieniamy. Mieszanie czasów („Every day Tom walks to school. Right now he is riding his bike.”) wynika z opisów celów 2 i 6 i pojawia się tylko wtedy, gdy rodzic wybrał któryś z nich. Pytania historyjki dotyczą treści. Test (w `module.test.ts`, bo budowa promptu historyjki jest prywatna w adapterze): zdanie o mieszaniu czasów jest w `descriptionEn` dokładnie celów 2 i 6.

## 10. Dane, prywatność, kontrakty

Bez nowych przepływów danych: do modeli trafia to samo co dla innych tematów gramatyki. Bez migracji, bez zmian DTO (`topicId` to string), bez zmian Kid UI i panelu. MCP i `SKILL.md` bez zmian — lekcje nie są w MCP ani `learning-overview`; uzasadnienie w opisie PR.

## 11. Testy

### 11.1 Jednostkowe (bez bazy)

- `ing-forms.test.ts`: każda klasa reguły, pisownia brytyjska, czasownik spoza tabeli → `undefined`, brak czasowników stanu w tabeli, odwrotność, `isIngFormInTable("morning") === false`.
- `time-markers.test.ts`: każda grupa; Look!/Listen! tylko na początku z „!” lub „,”; „They listen to music every day” → tylko „zwykle”; „Cicho!” na początku → teraz, „cicho czyta” → brak; „Gdzie jest tata?” → teraz; zakazane wskaźniki; „on Saturdays” vs „on Saturday”.
- `be-agreement.test.ts` + istniejące `validators.test.ts`: zachowanie `to_be` bez zmian po wydzieleniu.
- `present-continuous-validation.test.ts`, dla każdego celu poprawne i odrzucane:
  - luka z nawiasem i bez; luka na formę be; `hint` niepusty; luka bez nawiasu z czasownikiem w luce;
  - podmioty: zaimki, imię, „James”, „The dogs”, „The children”, „Tom and Ola”;
  - isn't / aren't / is not / am not w luce celu 3; „'m” jako cała odpowiedź → odrzucone;
  - cele 2 i 6: brak wskaźnika, wskaźnik niezgodny z czasem, mieszane grupy, scenka PL w `instructionPl`, „He ___ (play) every day.” → „play” odrzucone (osoba), luka pytania w celu 6 → odrzucona;
  - wybór „now / usually”: zdanie ze wskaźnikiem → odrzucone, klucz niezgodny z czasem → odrzucone;
  - wskaźniki zakazane (tomorrow, this afternoon, on Saturday) we wszystkich celach;
  - czasownik stanu w celu 2, „having lunch” i „looking at” dozwolone, „liking” odrzucone;
  - hybryda „She is plays” w kluczu; he's / what's w kluczu; „What is he doing?” poprawne, „Where is he going?” odrzucone;
  - `error_fix`: jeden obszar różnicy, dwa obszary → odrzucone, obszar poza elementem celu → odrzucone;
  - czasownik spoza tabeli; czasownik `drop_e` w celu 1 → odrzucony; czasownik `plain` w ćwiczeniu produktywnym celu 5 → odrzucony;
  - `lesson_notice` z dwiema formami -ing → odrzucone; „morning” obok jednej formy -ing → poprawne;
  - tłumaczenie bez „teraz” w celu 1 → odrzucone;
  - podmiot: „They always ___ (play) now.”, „Every day Ola ___ (read) a comic.” (cel 2), „What ___ they doing?”;
  - nawias w bodźcu wyboru i „posłuchaj i wybierz” → odrzucone; nawias z „not” w celu 2 → odrzucone; cel 2 z pytaniem → odrzucone; luka na formę be w celu 2, 5, 6 → odrzucona;
  - `error_fix` celów 2 i 6 (zamiana PS ↔ PC) poprawny i odrzucony;
  - przekształcenia: biegunowość odpowiedzi zgodna z `transformId`;
  - pula z wyborem i tłumaczeniem tego samego zdania przechodzi `validatePool` (§6.3, świadomie).
- `evaluate`/normalizator (jednostkowo, `matchLessonAnswer`): odpowiedź dziecka „He's playing.”, „he is playing”, „He is playing” z wielkimi literami i bez kropki pasują do klucza „He is playing.”; „isnt watching” i „is not watching” pasują do „isn't watching”; samo „playing” nie pasuje do „is playing”; „Mum's cooking.” nie pasuje deterministycznie do „Mum is cooking.” (udokumentowane zachowanie).
- `feedback-sentence-text.test.ts` i `story.test.ts`: §6.7.
- `solverView` (w testach PC, bez zmian w `agent/`): luka celu 2 ze scenką w `instructionPl` — widok zawiera scenkę i `stem` z nawiasem, a nie zawiera `hint`.
- Kartkówka (`lesson-materialize.test.ts`): zadanie luki PC w trybie kartkówki ma `stemWithGap` z nawiasem i bez `hint` — czasownik zostaje widoczny.
- `module.test.ts`: rejestr udostępnia `present_continuous@1`; pętla spójności tematów obejmuje nowy temat; wersje `present_simple@1` i `to_be@1` bez zmian; cele 1, 3, 4 mają `lesson_listen_choice`, cele 2, 5, 6 nie; przykłady z bloku `.present_continuous.` (wyeksportowane stałe, z których składany jest tekst promptu) przechodzą walidator; prompt zawiera kilka konkretnych wskaźników i czasowników z tabel (nie porównanie całej listy — byłaby to tautologia).
- **Migawka `fieldRules`:** test porównuje `fieldRules` z migawką inline (`toMatchInlineSnapshot`, konwencja repo); migawkę obecnego tekstu commitujemy przed zmianą promptu, więc diff PR pokazuje, że bloki PS i `to_be` różnią się tylko zamierzonym zawężeniem. Zrzutów pul z wcześniejszych sond PS i `to_be` nie ma w repo — regresję PS mierzy sonda (§11.3).

### 11.2 Integracyjne

Po scaleniu PR 2 etapu 3: test na ścieżce agenta ze skryptowanymi krokami fake-agenta i ręcznie napisanymi poprawnymi ćwiczeniami PC dla celów 1 i 2 (pokrycie etapów sześciu celów to zbyt duży fixture; uniwersalny generator fake tworzy ćwiczenia, które walidator PC odrzuci). Przebieg: generowanie → szkic → publikacja → sesja dziecka: karty, ćwiczenie celu 2, zdanie po odpowiedzi luki bez nawiasu.

Jeśli PR 2 nie zostanie scalony do czasu ukończenia części domenowej i sondy, ten sam test powstaje na obecnej ścieżce agenta (przedmiot `english_grammar` na liście `UMIEM_LESSON_AGENT_SUBJECTS` w teście) i jest przenoszony przy rebase.

### 11.3 Sonda (płatna, `tests/probes`)

Pula dla celów 1–6 na przykładowym materiale z podręcznika (fikcyjny, w repo) + przebieg regresyjny Present Simple. Wcześniejszych zrzutów PS nie ma w repo, więc punkt odniesienia to przebieg PS na tym samym materiale z kodu sprzed zmiany promptu (commit przed zadaniem promptów; osobny worktree) — chyba że właściciel wskaże zrzut z wcześniejszej sondy.

- Uruchomienie wyłącznie po wyraźnej zgodzie właściciela na konkretną wiadomość z szacunkiem kosztu; każde ponowienie wymaga nowej zgody.
- Budżet runu agenta ustawiony jawnie (`UMIEM_PROBE_AGENT_BUDGET_USD`, 0,60 USD na przebieg; domyślny 1 USD nie zostawiłby zapasu w limicie). Limit rejestru kosztów sondy: 2 USD łącznie na trzy przebiegi (PC, PS przed zmianą, PS po zmianie). Strojenie promptu (najwyżej 2 rundy) to nowy rejestr z nowym limitem i za osobną zgodą.
- Przegląd części domenowej przez trzech krytyków odbywa się przed sondą; zmiana walidatora lub promptu po sondzie (poza strojeniem z §11.3) wymaga decyzji właściciela, czy powtórzyć sondę.
- Ślepą ocenę próbki wykonuje osoba albo agent inny niż implementer.
- **Kryteria akceptacji PC:** przebieg kończy się w budżecie runu; każdy cel spełnia minima publikacji bez ręcznych poprawek; odrzucenia w celach 2 i 6 ≤ 40% wygenerowanych ćwiczeń; ćwiczenia na scenkach ≥ 30% (ścisła miara `sceneShare` z `tests/probes/present-continuous-stats.ts`, decyzja właściciela z 2026-11-06, §16.12: przyjęte ćwiczenia celów 2 i 6 bez tłumaczeń `lesson_open_answer` i bez sprawdzenia znaczenia „now / usually”, których polecenie ma polską scenkę albo polski wskaźnik, a bodziec, zdanie z błędem i angielski prompt nie mają żadnego angielskiego wskaźnika czasu; obok raportowane `sceneShareBroad` — szeroka miara z §16.11 — i `sceneSharePolish`); ślepa ocena próbki (rubryka z `tests/probes/blind`) — zero ćwiczeń dwuznacznych.
- **Kryterium regresji PS:** odsetek odrzuceń nie wyższy o więcej niż 10 punktów procentowych od wcześniejszej sondy PS na tym samym materiale.
- Raport: odrzucenia z powodami (prefiksy §8), proporcja scenek, wynik checkera.

### 11.4 Kontrola końcowa

`pnpm check`; `pnpm test:integration` (pełny, sekwencyjny; od scalenia `main` w Task 17 gałąź ma też `pnpm test:integration:shards`); `pnpm test:e2e:shards` przed PR. Bez nowych speców E2E — brak zmian UI (zmiana §6.7 dotyczy tekstu zdania, pokrytego testem jednostkowym i integracyjnym).

## 12. Kolejność prac i koordynacja z #237

1. Część domenowa od razu na `feature/present-continuous`: `ing-forms.ts`, `time-markers.ts`, wydzielenie `be-agreement.ts` i `present-simple-forms.ts` (czyste przeniesienie, osobny commit), walidator PC, `feedbackSentenceText`, prompty, katalog, testy jednostkowe, przegląd trzech krytyków. PR 2 etapu 3 nie dotyka `english-grammar/`, `english/` ani `feedback-sentence-text.ts`; wspólne pliki to dokumentacja (§13) i pliki testów, których ta gałąź nie zmienia (`llm.test.ts`, `agent-generation.probe.test.ts`, `tests/integration/fakes.ts`, `agent/*`).
2. Po scaleniu PR 2: rebase na `origin/main`, test integracyjny (§11.2), sonda (§11.3), strojenie.
3. Jeśli PR 2 się opóźnia: test integracyjny na obecnej ścieżce (§11.2), sonda na obecnym agencie; rebase po scaleniu PR 2 z ponownym `pnpm check`.
4. Jeden PR. Scalenie przez właściciela dopiero po zaakceptowanej sondzie — do tego czasu temat nie jest widoczny w produkcji.

## 13. Dokumentacja

- `docs/SPEC.md`: oba miejsca z listą tematów w części o lekcjach (ok. l. 779 i 784) + rekomendacja wyboru celów (§3.1).
- `docs/folder-structure.md`: nowe pliki tematu, `english/ing-forms.ts`, `english-grammar/time-markers.ts`, `be-agreement.ts`, `present-simple-forms.ts`, `present-continuous-validation.ts` oraz (z realizacji, §16.6) `present-continuous-exercise-rules.ts` i `present-continuous-tense-choice.ts`.
- `docs/architecture.md` §19: jedno zdanie o §6.7 (zdanie po odpowiedzi luki i zwykłego wyboru bez czasownika w nawiasie, wszystkie przedmioty).
- `.kiro/specs/grammar-module/`: wzmianka o trzecim temacie, jeśli dokument wymienia tematy.
- Przy konflikcie z dokumentacją PR 2 rozwiązujemy przy rebase (zmiany rozłączne treściowo).

## 14. Poza zakresem

v2 (#280): czasowniki stanu jako cel, pytania where/why/who, Present Continuous jako przyszłość, sytuacje „w tych dniach”, piktogramy czynności. Osobno: poziom materiału (#279), zmiany formularza rodzica (opisy celów, domyślne odznaczenie).

## 15. Ryzyka

- **Odsetek odrzuceń w celach 2 i 6** przez twarde reguły (wskaźniki, osoba, czasowniki stanu, tabela -ing) może wymagać kilku rund dogenerowania i przekroczyć budżet runu przy sześciu celach. Mitigacja: listy w prompcie z tych samych stałych, kryteria sondy.
- **Limit wywołań modelu oceniającego na sesję:** tłumaczenia celów porównania często nie dopasują się deterministycznie (wskaźnik, skrót po rzeczowniku); po wyczerpaniu limitu są „nieocenione”, a bez skonfigurowanego gradera „prawie” z §7.3 nie działa.
- **Rozjazd wieku:** prompty mówią „~8 lat”, karty pisane dla 9–11 (do #279).
- **Słaby Present Simple:** w celach porównania błąd formy PS jest „prawie” i nie obniża postępu — świadomie; formę ćwiczy temat Present Simple.
- **„Yes, she's.”** jest dziś zaliczane jako „Yes, she is.” przez rozwinięcie skrótów (problem istniejący w `to_be`, dotyczy też celu 4). Poza zakresem; osobny issue przy PR, jeśli test go potwierdzi.
- **Wskaźniki jako słowa-klucze:** dziecko może nauczyć się reagować na „Cicho!” tak jak na „now”. Mitigacja: wybór „now / usually” na zdaniach bez wskaźnika (§5.5) i tłumaczenia w etapie samodzielnym.

## 16. Decyzje z realizacji

Rozstrzygnięcia podjęte podczas implementacji, które zmieniają albo doprecyzowują reguły z wcześniejszych sekcji. Przy rozbieżności obowiązuje ta sekcja.

### 16.1 Wskaźniki czasu (§5.1)

- Wykrzyknienia „teraz” (Look!, Cicho!, Patrz!…) liczą się na początku tekstu albo na początku zdania (po `.`, `!`, `?`), nie po dwukropku.
- „dziś” jest zakazane tak jak „dzisiaj” (synonim, ta sama dwuznaczność).

### 16.2 Luka i wybór (§6.2, §6.3, §6.4)

- Reguła o pustym `hint` (§6.2) dotyczy wyłącznie `lesson_gap`; generyczny prompt przedmiotu dopuszcza podpowiedź w innych typach, a walidator PC jej tam nie egzekwuje.
- Luka tylko na formę be (bez nawiasu): odpowiedź przecząca jest dopuszczona wyłącznie wtedy, gdy w bodźcu nie ma „not” po luce i (cel 3 albo w bodźcu stoi marker „No”). Zamyka to dwuznaczne klucze i podwójne przeczenia.
- Ta sama reguła biegunowości działa dla `lesson_choice` z luką na formę be. Dodatkowo dystraktor równy kluczowi z dodanym lub usuniętym „not” / „n't” jest odrzucany, jeśli w bodźcu nie ma markera Yes/No — inaczej poprawne byłyby dwie opcje. Kontrola ± not jest pomijana, gdy „not” stoi już za luką.
- Cel 6: pytania tylko w `lesson_choice` (całe zdania w opcjach) i `lesson_open_answer`; w celu 2 pytań nie ma (§6.3). W `lesson_choice` i `lesson_listen_choice` celów 2 i 6 pytanie z luką jest odrzucane osobnym komunikatem `pc-shape:` (forma po podmiocie zdradza czas).
- Luka z czasownikiem nie może stać po formie be ani po do/does w tej samej klauzuli.
- Pytanie z inwersją i luką na formę be, w którym podmiotem jest imię albo rzeczownik („___ Ola reading?”): gdy pomocniki zgodności be nie zwracają formy, walidator wyprowadza ją z tokenów po luce.

### 16.3 `error_fix` (§6.3)

- Cele 1, 3, 4 przyjmują też obszar „zła forma be”: jeden token po każdej stronie, oba należą do {am, is, are} (kategoria `wrong_be_form`).
- Cele 3 i 4 przyjmują też obszar „do/does → forma be” („He doesn't playing.” → „He isn't playing.”, kategoria `extra_auxiliary`).
- Cel 5 zostaje przy samej pisowni -ing; brak -ing jest tam odrzucany (litera §6.3, fokus kart).

### 16.4 Czasowniki, tabela -ing i werdykty (§3.3, §4, §5.3, §7.3)

- Do tabeli -ing doszły czasowniki pogodowe: rain, snow (`plain`) i shine (`drop_e`) — częste zdania A1 („Is it raining now?”).
- Kontrola czasowników stanu działa przed kontrolą tabeli -ing; komunikat o stanie (`pc-state:`) pojawia się więc nawet wtedy, gdy czasownika nie ma też w tabeli; w liście błędów mogą współwystępować różne prefiksy, a testy sprawdzają obecność oczekiwanego prefiksu, nie całą listę.
- „have” i „look” jako forma -ing są przyjmowane, gdy to kolokacja według `isCollocationIngForm` (poza celem 5), zgodnie z wyjątkiem z §5.3.
- `be_plus_simple` dotyczy tylko am/is/are + forma podstawowa w kontekście „zwykle” („I'm go to school every day.”). Zdanie z dobrym czasem i brakiem -ing („She isn't watch TV now.”) w celach 2 i 6 to `almost` bez kategorii (§7.3); brak -ing uczą cele 1 i 3.

### 16.5 Wybór „now / usually” (§5.5)

Polecenie wyboru „now / usually” może mieć postać „Teraz czy zwykle?” (ograniczenie dotyczy tylko bodźca; polecenie ze wskaźnikiem jednej grupy jest odrzucane, także „Wybierz: teraz czy zwykle?”, bo „teraz” przy poleceniu zadania nie jest wskaźnikiem — §16.7). Prompt prosi tu dokładnie o „Kiedy to się dzieje?”, a zakaz refrenu „teraz czy zwykle” (§7.2) obowiązuje w pozostałych ćwiczeniach celów 2 i 6.

### 16.6 Pliki i prompty (§6, §7, §13)

- Reguły `error_fix`, `notice` i `listen_choice` są w `english-grammar/present-continuous-exercise-rules.ts`, a wybór czasu celów 2 i 6 w `english-grammar/present-continuous-tense-choice.ts`; powód: `present-continuous-validation.ts` ma już ponad 700 linii.
- Blok `.present_continuous.` (ok. 3,8 tys. tokenów po przeglądzie, §16.7) zostaje we wspólnych `fieldRules` przedmiotu (§7). Wpływ na generowanie Present Simple i „to be” mierzy sonda (§11.3); alternatywa (hak promptu per temat w `types.ts`) jest poza tym PR.
- Dopracowanie promptu po przeglądzie: wskazówki dla luki z czasownikiem w celu 4, przykład `error_fix` z przeczeniem, `explanationPl` po polsku i doprecyzowanie sformułowania o słowie pytającym.

### 16.7 Po przeglądzie implementacji (trzech krytyków, Task 13)

Zasada §2.6 (jeden poprawny czas) obowiązuje we wszystkich celach, nie tylko w celach porównania. Walidator:
- **Cele 1, 3, 4, 5 bez „zwykle”:** wskaźnik „zwykle” w którymkolwiek skanowanym polu (także w błędnym zdaniu `error_fix`, `instructionPl`, `prompt`) odrzuca ćwiczenie każdego typu (`pc-marker:`). „always” nie jest już przysłówkiem między be a -ing.
- **Cele 1, 3, 4, 5 z „teraz”:** luka z czasownikiem, każdy `error_fix`, każdy `transform` i wybór, którego opcja daje poprawną formę Present Simple („reads”, „doesn't play”, „Does she read?”), potrzebują wskaźnika „teraz” w dowolnym skanowanym polu (angielski wskaźnik albo polska scenka); w celu 4 wystarcza też „What + am/is/are + podmiot + doing?”. Luka na be, `notice`, `listen_choice`, `order` i `short_answer` go nie potrzebują. Zdanie kontrastu w Present Continuous nie jest wskaźnikiem.
- **Be jako łącznik:** po am/is/are słowo, które nie jest formą czasownika, to orzecznik („This is Ola.”, „It is sunny.”) i nie jest sprawdzane pod kątem -ing; każdy klucz nadal potrzebuje be + formy -ing. Czasownik z tabeli użyty jak przymiotnik („The door is open.”) jest odrzucany.
- **Polskie wykrzyknienia tylko z „!”** („Cicho! Dziadek śpi.”; przecinek liczy się tylko w angielskim „Listen, …”). Nowe wykrzyknienia „teraz”: „Shhh!”, „Look at …!”, „Spójrz na …!”, „Popatrz na …!” (słowa na początku zdania, dalej dowolne słowa do „!”).
- **Słowa polecenia:** w `instructionPl` teraz / właśnie / zawsze / zwykle / zazwyczaj nie są wskaźnikiem tuż przy poleceniu zadania (uzupełnij, wybierz, napisz, popraw, przetłumacz, ułóż, zaznacz, wskaż, przeczytaj, czytaj, posłuchaj, pamiętaj) ani między która / który / które a pasuje / brzmi / jest dobra („Wybierz formę, która właśnie pasuje.”). „Zobacz, jak teraz czyta Ola.” i „Dzieci, które teraz są w parku…” to scenki „teraz”.
- **Cel 3, luka na be:** przeczenie tylko po „No” („Is she sleeping? No, she ___.” → isn't), jak w celu 4; „She ___ sleeping now.” → isn't jest odrzucane (pasowałoby też „is”). W wyborze celu 3 biegunowość ustalają opcje (isn't / aren't bez „No”; para is / isn't nadal odrzucona).
- **„going to” + czasownik** (przyszłość) jest odrzucane w każdym celu i polu, także po wstawieniu odpowiedzi w lukę; „going to” + miejsce („going to school”, „going to work”) jest dozwolone.
- **Krótka odpowiedź:** przy imieniu albo rzeczowniku w pytaniu liczba podmiotu wyznacza zaimek („Are the boys playing?” → „Yes, they are.”, nie „Yes, he is.”); rodzaj nie jest sprawdzany.
- **Przekształcenia:** `to_question` — zdanie wyjściowe nie jest pytaniem, a klucz i warianty kończą się „?” i ostatnie zdanie zaczyna się od am/is/are (także isn't/aren't) albo od What + am/is/are; `to_negative` / `to_affirmative` — zdanie wyjściowe ma przeciwną biegunowość niż odpowiedź (`pc-shape:`).
- **Opcja wyboru zaczynająca się apostrofem** („'re playing”) jest odrzucana w każdym celu; luka z dwóch i więcej podkreślników jest traktowana jak „___”.
- **Tabela -ing bez „live” i „leave”** (w formie ciągłej znaczą zwykle tymczasowość albo przyszłość). Listy „zwykle”: every afternoon / month / year / winter / spring / autumn, once / twice a day, co + każdy dzień tygodnia.

Katalog: przykłady celów 1–4 tylko z czasownikami bez zmian pisowni; karta podwajania z regułą jednej sylaby i bez podwajania po w, x, y; pierwsza karta celu 2 mówi, że „Ola czyta” to i teraz, i zwykle; werdykt celów 2 i 6 nazywa „prawie” także dobry czas z brakiem -ing albo brakiem am/is/are przy „teraz”; podpowiedzi celów 2 i 6 wymieniają polskie scenki obok angielskich wskaźników.

Prompt: blok `.present_continuous.` kończy zdanie „End of present continuous rules.”; mówi wprost o regułach powyżej (wskaźnik „teraz” w celach 1, 3, 4, 5, bez „zwykle”, bez be going to, słowa polecenia, krótkie odpowiedzi, łącznik, przekształcenia); zdanie o „usually” dotyczy tylko zdań poprawnych; `error_fix` celów porównania w obie strony; wybór celu 6 między całymi pytaniami ma bodziec-zdanie kontekstu (przykład w `PRESENT_CONTINUOUS_PROMPT_EXAMPLES` przechodzi walidator); przykłady kart podlegają regułom celu. Blok urósł z ok. 2,8 do ok. 3,8 tys. tokenów.

### 16.8 Po scaleniu #281 i #282: katalog reguł i poprawki po ślepej ocenie sondy (Task 17–18)

Zastępuje §7.2, §8 (prefiksy komunikatów) i drugi punkt §16.6.

- **Walidator w katalogu reguł.** Każde sprawdzenie walidatora tematu to reguła `grammar.pc_<nazwa>` katalogu gramatyki (`english-grammar/rules.ts`, `when` na `topicId === "present_continuous"`), zgłaszana przez `grammarIssue` z polem, polskim komunikatem `pl` bez prefiksu i angielskim `found`. Prefiksy `pc-marker:`, `pc-ing:` itd. zniknęły: rodzic widzi sam komunikat, a sonda liczy odrzucenia po id reguły (`pcPoolStats(...).messagesByRule`; zastąpione w §16.9 / Task 19 przez `ruleIdsByKind`). Zachowanie walidatora (przyjęcie i odrzucenie) przeniesiono bez zmian; każda reguła ma przypadek w `present-continuous.rule-cases.ts`.
- **Prompt z księgi reguł.** Bloku `.present_continuous.` nie ma już we wspólnych `fieldRules`, więc nie trafia do promptów Present Simple i „to be” (migawki tych tematów różnią się od `main` tylko zawężeniem reguł luki do `.present_simple.`, §7.1). Agent puli dostaje opisy reguł PC z księgi reguł tylko w tym temacie; listy ze stałych (tabela -ing według reguł pisowni, czasowniki stanu i kolokacje, wskaźniki „teraz”, „zwykle” i zakazane) są dopiskami opisów reguł, które je sprawdzają, a dydaktyka bez sprawdzenia w kodzie (scenki, porównanie z Present Simple, aspekt polskiego czasownika, wybór „now / usually”, zdania kontekstu, przykłady kart) — dopiskiem opisu `grammar.pc_tense_marker_missing` (`english-grammar/present-continuous-guidance.ts`; zastąpione w §16.10 / Task 19: dydaktyka tematu przy `grammar.pc_forbidden_marker`, celów porównania przy `pc_tense_marker_missing`, celów 2 i 6 osobno). Zdania egzekwowane przez reguły (kształty luki, biegunowość be, krótkie odpowiedzi, `error_fix`, przekształcenia, „Wskaż słowo”, wybór ze słuchu, skróty z 's, pytania z „What”) opisują wyłącznie opisy reguł. Test modułu przepuszcza każde angielskie zdanie cytowane we wskazówkach przez walidator (przechodzi albo oblewa je wskazaną regułą).
- **Przykłady typów.** Gramatyka podaje przykład każdego typu każdego celu PC (`english-grammar/type-examples.ts`, `agentPolicy.typeExamples`) w miejsce ogólnych przykładów kart (Present Simple z `hint`). Każdy przechodzi walidację swojego celu, cel ma własne zdania, klocki `lesson_order` są bez interpunkcji końcowej, a żaden przykład nie zawiera zdania z kart tematu ani nie jest jego częścią. Uzupełnia §8 („bez zmian w `agent-policy.ts`” nie dotyczy przykładów typów).
- **Nowa reguła `grammar.pc_error_fix_do_ing` (ślepa ocena sondy z 2026-11-06).** Zdanie z błędem `lesson_error_fix` z do/does (także don't, doesn't, do not, does not) przed formą -ing — bezpośrednio albo po podmiocie pytania, bez formy be ani innego czasownika pomiędzy — jest odrzucane w każdym celu, bo ma dwie poprawne poprawki („Tom doesn't watching TV now.” → „Tom isn't watching TV now.” albo „Tom doesn't watch TV now.”; „Does she reading?”, „What does he doing?”). Zastępuje obszar „do/does → forma be” celów 3 i 4 z §16.3 (usunięty z rodzajów błędu `error_fix`); kategoria `extra_auxiliary` zostaje dla odpowiedzi dziecka. „Does she go swimming?” nie podlega regule (czasownik przed formą -ing).
- **Wskazówki po ślepej ocenie.** `explanationPl` nazywa tylko formy czasownika z tego ćwiczenia (ocena znalazła „is reading” w wyjaśnieniu do „Mum is cooking dinner.”); ćwiczenie nie kopiuje przykładu z kart celu (zmienia co najmniej podmiot, czasownik albo dopełnienie); tłumaczenie z „teraz” wymienia w `acceptedAnswers` inne wskaźniki „teraz”, na które zdanie pozwala („right now”, „at the moment”). Przykłady typów tłumaczeń celów 1, 3, 4, 5 mają te warianty.
- **Poza zakresem:** dwuznaczne ćwiczenia Present Simple bez wskaźnika „zwykle” ze ślepej oceny (25% w PS) — osobno w #288.

### 16.9 Fala 1 poprawek po krytykach (Task 19): jeden poprawny czas także w przeczeniach, dystraktorach i przekształceniach

Zasada §2.6 (jedno ćwiczenie = jeden poprawny czas) przed drugą płatną sondą. Uzupełnia §5.2, §5.4, §6.3 i §16.8.

- **Standard „Środek” (decyzja właściciela z 2026-11-06).** W przeczeniach celów 1, 3, 4, 5 i w każdym ćwiczeniu celów porównania (2, 6) z grupą „teraz” goły „now” — i polskie „teraz”, „właśnie”, „akurat” — nie wystarcza, bo bywa „obecnie” („Tom doesn't watch TV now.”, „Mój brat teraz nie pracuje.”). Kontekst „teraz” daje wtedy „right now”, „at the moment”, wykrzyknienie (Look!, Listen!, Shh!, Be quiet!, Look at …!) albo polska scenka (Cicho!, Patrz!, Posłuchaj!, w tej chwili, w tym momencie, Gdzie jest …?). Przeczenie to nawias (not verb), zanegowany klucz, wariant albo opcja, zanegowane zdanie z błędem albo zdanie wyjściowe przekształcenia, a w tłumaczeniu — zanegowany klucz (ocenia się polski prompt). W twierdzeniach i pytaniach celów 1, 4, 5 goły „now” nadal wystarcza. Reguła `grammar.pc_now_marker_bare`; skaner zwraca dopasowane wpisy listy (`nowMarkers`) i `strongNow` (wpis spoza `BARE_NOW_MARKERS`).
- **Wskaźnik w tym, co dziecko widzi przed odpowiedzią.** Grupę wskaźników (cele 2, 6) i wymagany wskaźnik „teraz” (cele 1, 3, 4, 5) ustalają bodziec, zdanie z błędem lub wyjściowe, prompt, polecenie i zdania „Wskaż słowo”; klucz, warianty i pojedyncza opcja się nie liczą (wcześniej wskaźnik tylko w kluczu albo opcji wystarczał). Opcje liczą się razem, gdy każda ma wskaźnik tej samej grupy. Tłumaczenie celu porównania bez wskaźnika w polskim zdaniu (i bez scenki w poleceniu) jest odrzucane, nawet gdy klucz ma „every day”. Grupy mieszane liczy się nadal we wszystkich polach (także kluczach i opcjach).
- **Zdanie składowe luki (cele 2, 6).** W bodźcu z luką liczy się zdanie składowe luki, części jej zdania bez własnego orzeczenia i wcześniejsze wykrzyknienia bez orzeczenia (Look!, Shh!); zdanie albo zdanie składowe z własnym orzeczeniem („Tom plays football every day. Ola ___ (read) a book.”, „Mum is cooking now and Dad ___ …”) mówi o innej czynności i jego wskaźnik się nie liczy (`gapContextTexts`).
- **Dystraktory.** W celach 1, 3, 4 wybór z opcjami innymi niż sama forma am/is/are potrzebuje wskaźnika „teraz” (także „is reading / read”), a każdy dystraktor (wstawiony w lukę albo całe zdanie) musi łamać regułę klucza, mieć wskaźnik „zwykle” albo zakazany, „going to” + czasownik albo czasownik stanu z -ing — inaczej to druga poprawna odpowiedź (`grammar.pc_choice_distractor_correct`: „is drawing” obok „is reading”, „Look! Tom is reading.” obok „Look! Ola is reading.”). Klasa pisowni -ing spoza celu nie czyni zdania błędnym. Po ponownym przeglądzie: zły szyk dystraktora („Tom not is watching”, „Ola reading is”, „Tom is playing now?”, zdanie oznajmujące obok klucza-pytania) jest błędem, a drugą poprawną odpowiedzią jest też dystraktor różny od klucza tylko „not”, gdy bodziec nie ustala biegunowości (Yes/No przed luką, „not” po niej), oraz inny czas zgodny z podmiotem (can/will/did + forma podstawowa, was/were + -ing, has/have + imiesłów, regularna forma przeszła, „read”; nieregularnych form przeszłych walidator nie zna). W przekształceniach „Tom's playing” liczy się jak „Tom is playing”. W celu 5 każdy dystraktor to klucz z błędną pisownią formy -ing (najwyżej dwie litery, jak w `error_fix`; `grammar.pc_ing_spelling_distractor`), więc „is running” obok „is swimming” jest odrzucane.
- **Przekształcenia związane ze zdaniem wyjściowym.** `to_negative` / `to_affirmative`: każdy klucz to zdanie wyjściowe z „not” dodanym albo usuniętym tuż po am/is/are (w celu 6 także forma Present Simple ↔ do/does + not + forma podstawowa); inny podmiot, czasownik albo brak wskaźnika są odrzucane. `to_question`: zdanie wyjściowe jest twierdzeniem (`grammar.pc_transform_question_negative` — z przeczenia są dwa pytania), a klucz to ono z am/is/are przeniesionym na początek ostatniego zdania („Look! Tom is playing.” → „Look! Is Tom playing?”); pytania z „What” i klucze bez wcześniejszego zdania są odrzucane. Reguła `grammar.pc_transform_key_statement`; `grammar.pc_transform_question_shape` nie dopuszcza już „What + am/is/are”.
- **Klucze tłumaczeń (każdy cel).** Każdy klucz zachowuje wskaźnik polskiego zdania: teraz, w tej chwili, w tym momencie i polskie wykrzyknienia → angielski wskaźnik „teraz”; wskaźnik „zwykle” (codziennie, zawsze, w poniedziałki…) → angielski wskaźnik „zwykle”; „właśnie”, „akurat” i „Gdzie jest …?” nie mają dosłownego odpowiednika (`grammar.pc_translation_key_marker`). Klucz z now, right now albo at the moment bez wykrzyknienia ma w `acceptedAnswers` ten sam klucz z każdym z dwóch pozostałych w dowolnym miejscu zdania (`grammar.pc_translation_now_variants`). Zastępuje zdanie §5.4 o odpowiedzi bez „now” trafiającej do modelu oceniającego tylko w części: warianty bez wskaźnika nadal nie wchodzą do `acceptedAnswers`.
- **Sonda i testy (krytyk C).** `pcPoolStats` liczy `ruleIds` wpisów odrzuceń według rodzaju (`ruleIdsByKind`, zamiast `messagesByRule` z §16.8), bo powód ofiary ujawnienia nie zaczyna się od id reguły. Test przykładów typów porównuje z kartami zdanie z luką bez nawiasu z czasownikiem, wypełnione kluczem i każdym wariantem. Zmienione `found` reguł biegunowości „to be” przy przekształceniu (nazywa przekształcenie, nie cel) przypina test.
- **Przykłady typów.** Pięć przykładów stało się niepoprawnych przez standard „Środek” (przeczenia celu 3: luka, poprawianie, przekształcenie, tłumaczenie; poprawianie celu 6); fala 1 zmieniła w nich tylko wskaźnik (now → right now, teraz → w tym momencie), żeby test kart typów przechodził. Wskazówki (`PC_GUIDANCE`) z przykładem „Ola is reading now.” dla celów porównania poprawia fala 2. Karty celów porównania z gołym „now” („Tom is riding his bike now.”, „Are you playing football now?”, „She isn't watching TV now.”; §3.2) walidator nie sprawdza, ale jako ćwiczenia swoich celów byłyby teraz odrzucone — ich zmiana czeka na decyzję właściciela (decyzja w §16.12: karty celu 6 z „right now”, karta celu 2 bez zmian).
- **Poza zakresem fali 1:** rzeczowniki o niejasnej liczbie (fish, sheep, family, team, police) jako podmiot, drobne uwagi krytyka A, „Tom does the cooking now.” (C-M5) i długość promptu PC (C-M6, ok. 39,6 tys. znaków).

### 16.10 Fala 2 poprawek po krytykach (Task 19): prompt i przykłady uczą tego, co przyjmuje walidator

Walidator się nie zmienia (fala 1, §16.9); zmieniają się wskazówki, przykłady typów, zakres reguł w księdze i opisy celów. Uzupełnia §7.2 i §16.8.

- **Reguły w księdze tylko w swoich celach.** Reguły, które walidator zgłasza tylko w części celów, mają `when` także na ostatnim segmencie `objectiveId` (`inPcObjectives` w `rules.ts`; zbiory celów jak w walidatorze — `PC_FORM_OBJECTIVES`, `TENSE_CHOICE_OBJECTIVES` — pilnuje test modułu): cele form 1, 3, 4, 5 — `pc_now_marker_missing`, `pc_usually_marker`, `pc_state_verb_ing`, `pc_translation_now_marker`; cele 1, 3, 4 — `pc_choice_distractor_correct`; cel 5 — `pc_ing_spelling_distractor`, `pc_collocation_in_ing_spelling`; cele porównania 2 i 6 — `pc_tense_marker_missing`, `pc_tense_markers_mixed`, `pc_tense_marker_mismatch`, `pc_tense_choice_distractor`, `pc_tense_choice_gap_question`, `pc_state_verb_tense_choice`, `pc_ing_without_be`, `pc_tense_form_missing`; cel 2 — cztery reguły `pc_now_usually_*`, `pc_now_or_usually_question`, `pc_now_or_usually_negative`; cel 6 — `pc_tense_choice_question_type`. Pozostałe reguły tematu (m.in. `pc_now_marker_bare`, biegunowość be, `error_fix`, przekształcenia, tłumaczenia) zostają w całym temacie, bo mogą się zgłosić w każdym celu. Reguła złamana poza swoją księgą nadal odrzuca ćwiczenie, a opis dostaje model w wyniku narzędzia.
- **Wskazówki podzielone według celów.** Dydaktyka całego tematu (`PC_GUIDANCE`: scenka w poleceniu, zdanie kontekstu, `explanationPl`, tłumaczenia, przykłady kart, języki pól) jest dopiskiem `grammar.pc_forbidden_marker`; dydaktyka celów porównania (`PC_TENSE_CHOICE_GUIDANCE`; definiuje „tense-choice objectives (now_or_usually and now_or_usually_more)” — ta sama definicja stoi przy każdym użyciu w opisach reguł) — dopiskiem `pc_tense_marker_missing`, razem z listami wskaźników „teraz” i „zwykle”; sprawdzenie znaczenia „now / usually” — dopiskiem `pc_now_or_usually_question` (cel 2); kontekst pytań i `error_fix` celu 6 — dopiskiem `pc_tense_choice_question_type`. Listy czasowników stanu stoją przy `pc_state_verb_ing` (cele form) i `pc_state_verb_tense_choice` (cele porównania), więc w każdej księdze każda lista jest raz. Długość promptu agenta (znaki, fikstura testu migawki): affirmative 39 736 → 34 951, now_or_usually 36 096 → 33 360, negative 39 615 → 34 890, questions 39 842 → 35 023, ing_spelling 35 141 → 29 917, now_or_usually_more 35 964 → 32 694.
- **Tłumaczenia i przykłady w każdej księdze zgodne ze standardem „Środek” (po ponownym przeglądzie).** Wskazówka tłumaczenia z gołym „teraz → now” jest dopiskiem `grammar.pc_translation_now_marker` (tylko cele form, `PC_FORMS_TRANSLATION_GUIDANCE`, w przeczeniu bez gołego „teraz”), a celom porównania wskazówka tłumaczenia każe przenosić scenkę albo mocny wskaźnik (Patrz! → Look!, w tej chwili → at the moment) albo wskaźnik „zwykle”. Wskazówki tematu nie mają już pełnych zdań angielskich zależnych od celu (scenka bez luki, wyjaśnienie bez zdania), a przykłady w opisach reguł całego tematu mają mocny wskaźnik (He ___ (play) right now., Tom is playing right now. ↔ Tom isn't playing right now., klucz tłumaczenia z „at the moment”). `descriptionEn` celów porównania wymienia wśród wskaźników kontekstu right now, at the moment i Look! zamiast gołego now. Test modułu sprawdza każdy cytowany fragment w każdym celu, którego księga go pokazuje (test pokrycia).
- **Wyjaśnienie jednym zdaniem.** `explanationPl` to dokładnie jedno zdanie, a wykrzyknienie albo pytanie scenki stoi w cudzysłowie („Look!”, „Cicho!”, „Gdzie jest tata?”): „!” lub „?” przed cudzysłowem nie kończy zdania, a bez cudzysłowu `explanation.one_sentence` usuwa wyjaśnienie. Drugi wzór dla celów porównania: „„Cicho!” mówi, że dziadek śpi w tej chwili, więc Grandpa is sleeping.”.
- **Cel 6.** Pytanie wybierane z dwóch całych pytań ma kontekst zgodny z czasem klucza, który nie sugeruje drugiego („Ola is in a tennis club. → Does Ola play tennis on Mondays?”, przykład typu „Tom is in a swimming club.” zamiast „Tom is at the swimming pool.”, które sugeruje „teraz”). `lesson_error_fix` celu 6 ma w zdaniu z błędem Present Continuous ze wskaźnikiem „zwykle”, a w kluczu Present Simple („Tom isn't playing tennis on Mondays.” → „Tom doesn't play tennis on Mondays.”), bo Present Simple z „now” bywa poprawny („obecnie”; dawny przykład „We don't eat ice cream now.”). Wskazówka mówi to wprost; walidator tego nie wymusza (`error_fix` z twierdzeniem Present Simple → Present Continuous ze scenką nadal przechodzi).
- **Przykłady typów zgodne ze standardem „Środek”.** Przeczenia celu 3 i porównania mają mocny kontekst „teraz” (right now, at the moment), wybór celu 3 i 4 ma dystraktor z do/does (aren't / isn't / don't; Are / Is / Do), a wybór z opcją inną niż forma be — wskaźnik „teraz” („___ your friends waiting for the bus now?”). Klocki celu 1 dostały scenkę w poleceniu („Cicho! Jemy śniadanie. Ułóż zdanie.”) zamiast klocka „now”, który dałby kilka poprawnych szyków („We are now drinking milk” odrzuca reguła zdania). Wskazówki i `descriptionEn` celów 2 i 6 pokazują mocny wskaźnik („Look! Ola is reading.”, „She isn't watching TV right now.”, „Are you playing football right now?”). Karty i podpowiedzi dla dziecka bez zmian (decyzja kontrolera).
- **Przykład tłumaczenia Present Simple** we wspólnych `fieldRules` („Ona codziennie gra w piłkę.” → „She plays football every day.”) stoi w bloku celów `.present_simple.`, bo w temacie Present Continuous to zdanie byłoby odrzucone; migawki Present Simple i „to be” różnią się tylko miejscem tego zdania.
- **Poza zakresem fali 2:** twierdzenie Present Simple jako `error_fix` celu 6 (B-M5), wiek odbiorcy w roli autora (B-M6), drobne uwagi krytyków A i C, nieregularne formy przeszłe w dystraktorach. `english.listen_sibilant_merge` zostaje w księdze tematu: poprawne opcje słuchu PC (is / are, isn't / aren't, Is / Are) nie różnią się końcówką -s, ale reguła zgłasza się dla każdych opcji przed walidatorem tematu, więc może trafić także w PC.

### 16.11 Po drugiej sondzie (Task 15, krok 10; decyzje właściciela z 2026-11-06)

- **Rozsypanka bez przestawialnego wskaźnika czasu** („Reguła bez nowej sondy”). Ślepa ocena drugiej sondy znalazła jedno dwuznaczne ćwiczenie: klocki Tom / is / reading / a / book / now z kluczem „Tom is reading a book now” — „Now Tom is reading a book” też jest poprawne, a `acceptedAnswers` było puste. Nowa reguła `grammar.pc_order_movable_marker` (cały temat, typ `lesson_order`; `validateOrderMarkers` w `present-continuous-exercise-rules.ts`) odrzuca rozsypankę, której klocki — także po rozbiciu wskaźnika na kilka klocków („at” / „the” / „moment”) — zawierają wskaźnik czasu, który może stać na początku albo na końcu zdania (`movableTimeMarkers` w `time-markers.ts`): każdą frazę list „teraz” i „zwykle” poza wykrzyknieniami (Look!, Shh! — stoją tylko na początku) oraz poza always i never (`FIXED_POSITION_ADVERBS`), które stoją tylko między podmiotem a czasownikiem („Ola always reads”, nie „Always Ola reads”; „never” na początku wymaga inwersji). usually, often i sometimes są przestawialne („Sometimes Ola reads.”, „Ola reads comics often.”), więc odrzucają rozsypankę. Czas pokazuje scenka w poleceniu („Cicho! Dziadek śpi. Ułóż zdanie.”), jak w przykładzie typu celu 1. Rozsypanka jest tylko w celach 1 i 4, gdzie `needsNowMarker` jej nie dotyczy, więc reguła nie zderza się z wymogiem wskaźnika. Dawne przypadki testów zdań z klockiem „now” straciły ten klocek (sprawdzają zgodność podmiotu, nie wskaźnik).
- **Szersza miara scenek w statystykach sondy** („Szersza miara”). Dawne `sceneShare` liczyło tylko przyjęte ćwiczenia celów 2 i 6 z polskim wskaźnikiem w poleceniu (w tłumaczeniu: w prompcie); właściciel przyjął szerszą miarę dydaktyczną: scenka to ćwiczenie, w którym dziecko wnioskuje czas z sytuacji — (a) polska scenka jak dotąd, (b) angielskie wykrzyknienie z listy „teraz” (Look!, Look at …!, Listen!, Shh!, Be quiet!) w tym, co dziecko widzi: bodziec, zdanie z błędem albo angielski prompt (klucz i opcje się nie liczą), (c) `lesson_choice` z całymi zdaniami w opcjach, którego bodziec to zdanie kontekstu bez luki („Ola is in a tennis club.”), poza sprawdzeniem znaczenia „now / usually” (tam czas ustala forma czasownika). Kryterium §11.3 (≥ 30%) liczy się na `sceneShare` (szeroka miara; zastąpione w §16.12: `sceneShare` to miara ścisła, szeroka to `sceneShareBroad`); dawna liczba zostaje jako `sceneSharePolish`. Walidator i prompt bez zmian.

### 16.12 Po krytykach końcowych (Task 16; decyzje właściciela z 2026-11-06)

- **Dwie poprawne odpowiedzi.** Krótka odpowiedź (`lesson_short_answer`) w temacie nie ma opcji zaczynających się od Yes i od No — obie mogą być poprawne, także ze scenką w poleceniu; wszystkie opcje zaczynają się tym samym Yes albo No (Yes, she is. / Yes, she does.; opis `grammar.pc_be_choice_polarity_distractor`). W celach 2 i 6 dystraktor w innym poprawnym czasie (can read, played, didn't watch, was watching, także pytanie z operatorem na początku: „Did Tom swim on Fridays?” — `otherTenseForm`, jak w celach 1, 3, 4) to druga poprawna odpowiedź (`grammar.pc_tense_choice_distractor`). Nowa reguła `grammar.pc_numberless_subject` (tylko temat PC; wspólna heurystyka „to be” bez zmian): fish, sheep, deer mają tę samą formę w obu liczbach, więc w kluczu (z bodźcem wokół luki) taki rzeczownik nie stoi tuż przed am/is/are, do/does albo formą Present Simple ani po am/is/are, do/does otwierających pytanie, chyba że wśród trzech słów przed nim stoi „a lot of” / „lots of” (liczba mnoga) albo najbliższy określnik lub liczebnik wśród nich ustala liczbę (a, an, one, this, that, each, every, these, those, many, two–ten; „One of the fish” — najbliższe jest „the”, więc odrzucone), albo rzeczownik jest częścią podmiotu złożonego z „and” („the cat and the fish are”). Reguła działa tylko w typach, w których dziecko samo wybiera albo pisze formę (luka, wybór, wybór ze słuchu, krótka odpowiedź, poprawianie błędu, tłumaczenie); w rozsypance formę daje klocek, a w przekształceniu zdanie wyjściowe. „Look! The fish ___ (eat).” jest odrzucane z każdym kluczem; z takim słowem forma be wynika z niego („Two fish are eating.” — wcześniej heurystyka tematu żądała „is”). „swine” i „aircraft” pominięto (słownictwo spoza wieku 7–11). Opisy `pc_tense_markers_mixed` i `pc_now_marker_bare` mówią wprost, że sprawdzenie znaczenia „now / usually” jest wyjątkiem (kod pomijał je już wcześniej).
- **Scenki w celach 2 i 6 („Popraw teraz”).** Druga sonda miała 0 z 26 polskich scenek w poleceniach celów 2 i 6 (szeroka miara 0,538 liczyła wykrzyknienia i zdania kontekstu, w których czas ustala wskaźnik opcji): dziecko wypatrywało słowa zamiast wnioskować czas z sytuacji. Przykłady typów luki i poprawiania błędu obu celów mają czas tylko w polskiej scence polecenia, bez angielskiego wskaźnika w zdaniu (po jednej scence „teraz” i „zwykle” na cel: „Cicho! Dziadek śpi.” + „Grandpa ___ (sleep) on the sofa.”, „Mój brat co rano chodzi pieszo do szkoły.” + „My brother is walking to school.” → „My brother walks to school.”, „Cicho! Tata śpi.” + „Dad ___ (not watch) TV.”, „Tom nigdy nie je mięsa.” + „Tom isn't eating meat.” → „Tom doesn't eat meat.”). Wskazówka celów porównania każe tak budować co najmniej połowę luk, poprawek i wyborów z luką (zamiast „about half … use a scene”). Wybór całych pytań celu 6 ma polecenie dokładnie „Wybierz poprawne pytanie.” (bez czasu i scenki) i zdanie kontekstu o podmiocie pytania — wskazówka i przykład; walidator tego nie wymusza. Kryterium §11.3 liczy się na ścisłej mierze `sceneShare`; szeroka z §16.11 zostaje jako `sceneShareBroad`, polska jako `sceneSharePolish`. Wymuszonego minimum scenek w walidatorze puli nie ma (follow-up #280 razem z ponowną sondą).
- **Karty celu 6** mają „right now” zamiast gołego „now” („Are you playing football right now?”, „She isn't watching TV right now.”); karta celu 2 („Tom is riding his bike now.”) bez zmian (decyzja właściciela). Podpowiedź kategorii błędu `simple_for_now` celu 6 ma ten sam przykład („…: Are you playing football right now?”).
- **„To be” względem `main`.** Zachowanie walidatora „to be” różni się od `main` tylko „mice” w liczbie mnogiej (§6.2) i brzmieniem `found` reguł biegunowości przy przekształceniu (nazywa przekształcenie, nie cel: `the transform "to_negative" requires "not"`; §16.9) — przegląd krytyka C na ponad 100 tys. przypadków.
- **Migawka promptu** celu `now_or_usually_more` obok `affirmative` (`lesson-pool-prompt.english_grammar_present_continuous_more.txt`).

### 16.13 Po przeglądzie całego PR #329 (2026-11-06, „popraw wszystko”)

- **Dystraktor spoza tabeli** (`grammar.pc_distractor_outside_table`, wybór w celach 1–4 i 6). Dawniej błąd „czasownik spoza tabeli” w dystraktorze liczył się jako błąd angielszczyzny, więc przechodziły dwie poprawne opcje („is walking” / „is feeding”, „walks” / „feeds”). Teraz taki dystraktor odrzuca ćwiczenie, chyba że to literówka formy -ing klucza („is walkking”). W celach 2 i 6 forma z tabeli spoza klasy pisowni celu („is writing” przy „is reading”) to druga poprawna odpowiedź (`grammar.pc_tense_choice_distractor`), jak już w celach 1, 3, 4.
- **Wspólny podmiot po spójniku.** Forma Present Simple tuż po „and” / „but”… za orzeczeniem to drugi czasownik tego samego podmiotu („Look! Tom is eating bread and drinks milk.” odpada w celach 2 i 6). Rzeczownik na -s w tym miejscu („bread and drinks”) też się liczy — świadomie: ćwiczenie odpada zamiast przepuścić dwa czasy.
- **„police”** liczy się jako liczba mnoga.
- **Mniej fałszywych odrzuceń:** „Look!” w cudzysłowie i po przecinku albo dwukropku (wskaźnik i czasownik stanu), „own” po zaimku dzierżawczym i „like a…” w porównaniu (nie czasowniki stanu), „now” / „all” / „both” między be a -ing („Mum is now reading.”), „What a…!” to wykrzyknienie, nie pytanie.
- **Karta „Podwójna litera”** dopowiada, że po dwóch samogłoskach się nie podwaja (read → reading, cook → cooking).
- **Bez zmian (świadomie):** rzeczownik na -s po przymiotniku w drugiej części zdania („bread and hot drinks”) dalej bywa brany za czasownik — bez części mowy nie da się go odróżnić od podmiotu („and Dad reads”); kosztuje tylko ponowne wygenerowanie (#280).
