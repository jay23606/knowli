# Źródła i lekcja „Angielski — rozdział” — projekt

Data: 2026-10-30 (wersja 2 po przeglądzie trzech krytyków — dziennik w sekcji 12). Podstawa: zestawienie typów zadań z zeszytu ćwiczeń 2. klasy (Starter, Unit 1–2) z typami ćwiczeń Umiem! oraz decyzje właściciela podjęte w rozmowie (wariant A zadań, wariant A lektora, przedmiot jako osobny `SubjectModule`, „źródło” jako osobny byt). Status: projekt zaakceptowany przez właściciela 2026-10-30; Etapy 1–4 zaimplementowane — Etap 1 (przedmiot z wklejonym materiałem) scalony jako #192, Etap 2 (źródła) na gałęzi `claude/english-chapter-2-sources`, Etap 3 (lektor po odpowiedzi) na gałęzi `claude/english-chapter-3-readback`, Etap 4 (słówka ze źródła) na gałęzi `claude/english-chapter-4-source-vocab` (plan: `docs/superpowers/plans/2026-10-31-english-chapter-stage4-source-vocabulary.md`); stan, wynik próby i odstępstwa w sekcji 10.

## 1. Cel

Dziecko ćwiczy słownictwo i ramy zdaniowe z bieżącego rozdziału podręcznika angielskiego w zadaniach podobnych do zeszytu ćwiczeń: połącz, pogrupuj, uzupełnij tekst z bankiem słów, wybierz słowo w zdaniu, ułóż zdanie, wpisz słowo, przetłumacz krótkie zdanie. Zestawy słówek nadal ćwiczą pojedyncze słowa z powtórkami; lekcja rozdziału dokłada poziom zdania.

Rodzic wkleja tekst rozdziału raz — jako **źródło** — i tworzy z niego osobno lekcję rozdziału, zestaw słówek albo lekcję szkolną. Każde utworzenie jest dzisiejszą, niezależną operacją z własnym szkicem, przeglądem i publikacją; nie ma wspólnej transakcji ani automatycznego łańcucha.

Sukces: dziecko ćwiczy w aplikacji te same rodzaje zadań co na sprawdzianie z rozdziału, wyłącznie na słowach z rozdziału, a rodzic widzi, które zagadnienia (np. „Pogoda”, „Rama: I'm wearing…”) sprawiają trudność.

## 2. Ograniczenia globalne

- Interfejs po polsku; polecenia zadań po polsku, treść i odpowiedzi lekcji rozdziału po angielsku (`en-GB`).
- Opublikowana treść, wydany prompt, klucz odpowiedzi i zakończona ocena pozostają niezmienne. Zestaw utworzony ze źródła przechowuje własną kopię tekstu.
- Nowy przedmiot to katalog `subjects/english-chapter/` i wpis w rejestrze. Silnik lekcji dostaje kilka **generycznych** opcji `SubjectModule` (sekcja 4.1), z których korzysta ten przedmiot; żadna gałąź silnika nie sprawdza identyfikatora przedmiotu (test architektoniczny bez zmian).
- Kid DTO bez klucza odpowiedzi; nagranie poprawnego zdania ujawniane wyłącznie w omówieniu, po zapisaniu oceny.
- Zadania zamknięte (stukane) oceniane deterministycznie, bez modelu. Wpisane odpowiedzi (luka, tłumaczenie) niedopasowane do wariantów idą do cache werdyktów i modelu oceniającego, gdy jest skonfigurowany; awaria lub brak modelu = „nieocenione” bez kary.
- Cała ścieżka działa bez mikrofonu. Nie dodajemy odpowiedzi mówionych w lekcji rozdziału.
- Bez nowych widoków ćwiczeń w Kid UI (wariant A). Bez uploadu plików i OCR — źródło to wklejony tekst.
- Źródło to treść podręcznika od rodzica, bez danych dziecka. Do modeli trafia jak dzisiejszy materiał lekcji. Materiał z prawdziwego podręcznika używany do próby (sekcja 10) nie trafia do repozytorium.

## 3. Źródła

### 3.1. Model danych

Nowa tabela `source_materials` w obszarze `materials/`:

| Kolumna | Typ | Uwagi |
|---|---|---|
| `id` | uuid PK | |
| `client_request_id` | uuid unique | idempotencja tworzenia |
| `request_hash` | text | skrót znormalizowanego tytułu i treści z pierwszego żądania |
| `title` | text | 1–120 znaków po trim |
| `body` | text | 1–16 000 znaków po trim (limit `MAX_SCHOOL_MATERIAL_LENGTH`) |
| `revision` | integer | od 1; rośnie przy każdej zmianie, także samego tytułu (kontrola współbieżności edycji) |
| `body_revision` | integer | od 1; rośnie tylko przy zmianie `body` (wersja kopiowanego tekstu; dodane w Etapie 2 po końcowym przeglądzie) |
| `created_at`, `updated_at` | timestamptz | |

Nowe kolumny w `decks`:

- `source_material_id uuid null references source_materials(id) on delete set null`,
- `source_material_revision integer null` — rewizja treści źródła (`body_revision`) skopiowana przy tworzeniu; CHECK: dodatnia i obecna przy niepustym `source_material_id` (oba warunki przepuszczają wiersz po `ON DELETE SET NULL`).

Odnośnik jest informacją o pochodzeniu; treść zestawu nigdy nie jest czytana ze źródła po utworzeniu. Migracja Drizzle z przeglądanym SQL; `docs/schema.sql` uzupełniony.

### 3.2. Operacje (rodzic, Parent Mode)

- `createSourceMaterial({ clientRequestId, title, body })` — ponowienie z tym samym `clientRequestId` i tą samą treścią zwraca istniejący rekord; z inną treścią → `conflict`. Ponowienie po usunięciu źródła tworzy je od nowa (świadomie akceptowany przypadek brzegowy; bez nagrobków).
- `updateSourceMaterial({ id, expectedRevision, title?, body? })` — rozbieżna `expectedRevision` → `conflict`; zmiana tekstu podnosi `revision` i `body_revision`, zmiana samego tytułu tylko `revision`; edycja, w której każde podane pole równa się zapisanemu (po trim), niczego nie zapisuje i nie podbija.
- `deleteSourceMaterial({ id })` — usuwa źródło; zestawy zostają, odnośnik staje się `null`.
- `listSourceMaterials()` — tytuł, daty, liczba niezarchiwizowanych zestawów z tym źródłem.
- `getSourceMaterial({ id })` — pełny tekst i lista zestawów utworzonych z tego źródła (tytuł, rodzaj, stan, czy skopiowana rewizja treści jest starsza od bieżącej `body_revision`).

Każda operacja wymaga sesji rodzica i serwerowej autoryzacji, jak operacje na zestawach. Źródła nie są widoczne w Kid API.

### 3.3. Tworzenie zestawu ze źródła

Komendy tworzenia przyjmują `sourceMaterialId` jako alternatywę dla wklejonego tekstu (dokładnie jedno z dwóch; oba albo żadne → `validation`). Komenda ze źródłem niesie też wymagane `expectedSourceRevision` — rewizję treści (`body_revision`), z której rodzic widział podgląd; gdy po blokadzie źródła bieżąca rewizja jest inna (tekst zmieniono w innym oknie), serwer kończy polecenie `conflict` (409, `details.reason = "source_changed"`) bez zapisu, a panel odświeża podgląd i rodzic tworzy lekcję ponownie (dodane po przeglądzie PR #193). Serwer w transakcji tworzenia:

1. czyta `body` i `body_revision` źródła z blokadą `FOR KEY SHARE` (równoległe usunięcie czeka; brak źródła → `not_found`, nie błąd 500 z naruszenia klucza obcego — chyba że ponowienie tego samego polecenia trafia na zestaw zatwierdzony już przez pierwsze żądanie, wtedy zwraca ten zestaw),
2. kopiuje tekst w to samo miejsce, w którym zestaw przechowuje dziś materiał,
3. zapisuje `decks.source_material_id` i `decks.source_material_revision`.

Co dzieje się z kopią później:

- **Lekcje:** kopia jest w `lesson_context.material`; dogenerowanie, regeneracja zagadnienia, edycja i nowa wersja korzystają z niej.
- **Słówka:** kopia jest tylko w zapisanym inpucie pierwszego runu generacji. Słówka nie mają dogenerowania z materiału, a nowa wersja nie generuje ponownie — odnośnik jest wyłącznie informacją o pochodzeniu.

Edycja źródła nie zmienia istniejących zestawów.

### 3.4. Panel rodzica

- Nowa zakładka **„Źródła”** (w UI słowo „materiał” oznacza już zestaw albo lekcję — stąd inna nazwa).
- Lista źródeł: tytuł, data zmiany, liczba zestawów; przycisk „Nowe źródło” (tytuł + pole tekstowe z licznikiem znaków).
- Strona źródła: podgląd i edycja tekstu, usunięcie z potwierdzeniem podającym liczbę zestawów, lista zestawów z tego źródła oraz przyciski „Utwórz lekcję rozdziału”, „Utwórz lekcję szkolną” i (po wdrożeniu sekcji 6) „Utwórz zestaw słówek”. Przycisk otwiera dzisiejszy formularz z tekstem źródła zablokowanym do podglądu.
- Edytor zestawu ze źródła pokazuje „Ze źródła: <tytuł>” z linkiem, a gdy tekst źródła zmieniono po utworzeniu zestawu (rewizja treści; sam tytuł się nie liczy) — „Źródło zmieniono od utworzenia tego zestawu”.
- Komunikaty w `messages.ts`; Mantine wyłącznie w `apps/web/src/parent`.

## 4. Przedmiot `english_chapter`

### 4.1. Moduł i nowe opcje silnika

`subjects/english-chapter/module.ts`:

| Pole | Wartość |
|---|---|
| `id` | `english_chapter` |
| `titlePl` | „Angielski — rozdział” |
| `answerLocale` / `promptLocale` | `en-GB` / `pl-PL` |
| `exerciseTypes` | `lesson_card`, `lesson_match`, `lesson_group`, `lesson_cloze`, `lesson_choice`, `lesson_order`, `lesson_gap`, `lesson_open_answer` |
| `normalizer` | normalizator angielski przeniesiony z `english-grammar/` do `subjects/english/` (bez zmiany zachowania, więc klucze cache werdyktów gramatyki zostają; każda przyszła zmiana dotknie obu przedmiotów) |
| `topics` | `[]` — temat dynamiczny z materiału (`buildDynamicTopic`) |
| `usesV3Payload` | nie ustawione (domyślnie `false`) — bez pól v3 i oceny dwuwymiarowej |
| `poolDeduplication` | `exercise` |
| `poolMinimums` | `{ guided: 3, productive: 3, independent: 2 }` |
| `ttsForAnswers` / `ttsForPrompts` | `false` / `false` |
| `ttsForFeedbackSentence` | `true` — odczyt pełnego zdania po odpowiedzi (generyczna opcja z #194, włączona w Etapie 3; sekcja 5) |
| `spokenAnswers` | brak |

Nowe, opcjonalne i generyczne opcje `SubjectModule` (domyślne wartości zachowują dzisiejsze zachowanie `school` i `english_grammar`):

| Opcja | Znaczenie | `school` | `english_chapter` |
|---|---|---|---|
| `sourceQuotes` | czy ćwiczenia wymagają cytatów `sourceRefs`; steruje `groundingRequired` w generacji i wymaganiem `sourceRefs` w gałęziach schematu match/group/cloze (dziś wymagane zawsze, a dla przedmiotu bez v3 każde takie ćwiczenie byłoby odrzucone) | `true` | `false` |
| `refineGeneratedPool(drafts, { material })` | walidacja i czyszczenie **tylko świeżo wygenerowanych** ćwiczeń (odrzuca ćwiczenie albo usuwa pojedyncze warianty lub niezamówione pola); nie działa przy edycji rodzica ani publikacji, w odróżnieniu od `validatePoolExtra` | brak | walidacja słownikowa i usuwanie niezamówionych pól v3 (4.4) |
| `materialSubjectTitle` | skąd tytuł przedmiotu zestawu z materiału: `"parent"` — nazwę podaje rodzic, `"fixed"` — stały `titlePl`; brak = przedmiot katalogowy. Wspólny predykat z katalogiem przedmiotów i poleceniami tworzenia (4.6). Opcja dodana podczas wdrożenia; `validateSubject` wymaga jej razem z `buildDynamicTopic` | `"parent"` | `"fixed"` |
| `instructionIsStimulus` | polecenie niesie bodziec znaczenia: tożsamość ćwiczeń `lesson_choice`, `lesson_gap`, `lesson_order` (`exercise-identity.ts`) uwzględnia znormalizowane `instructionPl` | `false` | `true` |
| `exposureText(draft)` | tekst, z którego liczony jest `targetKey` ćwiczenia (dziś zawsze `answer`) | brak | 4.5 |
| `normalizeExposureText(text)` | normalizacja tekstu przed `computeTargetKey` dla każdej ekspozycji lekcji przedmiotu — ćwiczeń i przykładów kart (`lessonTextTargetKey`); dodana po końcowym przeglądzie Etapu 1 | brak | 4.5 |
| `openAnswerPromptLocale` | język pytania `lesson_open_answer` wysyłany w Kid DTO | brak (reguła jak dziś) | `pl-PL` |
| `prompts.objectivesRules` | reguły etapu zagadnień (`LessonObjectivesInput` dostaje pole, adapter je dokleja) | brak | 4.2 |
| `prompts.typeRules` | opisy typów match/group/cloze dla promptu puli — przeniesione z adaptera (`llm.ts`) do profilu przedmiotu | dzisiejszy tekst z adaptera bez zmian | 4.3 |

Kategorie błędów (z polskimi szablonami podpowiedzi): przedmiotowe `wrong_word` „Pomylone słowo” i `spelling` „Pisownia” oraz bazowe `incomplete` „Niepełna odpowiedź” i `wrong_order` „Zła kolejność”, które każde zagadnienie dostaje z przedmiotem. Rozstrzygnięcie podczas wdrożenia: pierwsza wersja projektu zakładała własne `word_order` i `missing_word`, ale kategorie bazowe znaczą to samo, a zdublowane kody rozpraszałyby raport rodzica (koszt błędnej decyzji: dopisanie dwóch kodów później).

`validateExercise` przedmiotu:

- `lesson_choice` i `lesson_gap`: `stem` z dokładnie jedną luką (`/_{2,}/`);
- `lesson_choice`, `lesson_gap`, `lesson_order`, `lesson_cloze`: `instructionPl` niesie polskie zdanie-bodziec — różne od stałych poleceń typów w `messages.kid`, dłuższe niż samo polecenie i z granicą zdania, po której jest dalszy tekst (`/[.!?:]\s+\S/`, np. „Dziś pada deszcz. Wybierz słowo.”; samo „Wybierz właściwe słowo.” nie przechodzi) — uzupełnianie tekstu dołączono po końcowym przeglądzie;
- `lesson_open_answer`: niepuste `instructionPl` (stałe „Przetłumacz na angielski.”) — bez niego dziecko widziało tylko tytuł zagadnienia;
- pole `hint` niedozwolone (bodziec jest w poleceniu, bo kartkówka usuwa `hint` z luki — `lesson-materialize.ts:294`);
- `lesson_order`: żadne dwa klocki nie mają tego samego tekstu po normalizacji (ocena porównuje identyfikatory klocków, więc zamiana dwóch „a” dałaby fałszywy błąd);
- odpowiedź i warianty ≤120 znaków (limit przedmiotów bez v3).

W kodzie `validateExercise` przedmiotu obejmuje pierwsze pięć reguł; jedną lukę `lesson_gap` i limit 120 znaków egzekwuje już walidacja ogólna silnika (`pool-validation.ts`), więc przedmiot ich nie powiela (jeden komunikat dla rodzica).

### 4.2. Zagadnienia

Model dzieli materiał na **3–5** zagadnień (`objectivesRules`), żeby przy dwóch nowych zagadnieniach na sesję wszystkie pojawiły się w 2–3 sesjach. `DynamicObjectiveData` dostaje opcjonalne `kind: "words" | "frame"` (przedmiot szkolny go nie ustawia):

- **words** — grupa słów, np. „Ubrania”, „Pogoda”: 4–12 słów i zwrotów z materiału;
- **frame** — rama zdaniowa, np. „I'm wearing (a) …”, „What's the weather like? It's …”; sprawdzaną częścią jest konstrukcja, a słowa z zagadnień `words` są tylko wypełnieniem.

Każde słowo należy głównie do jednego zagadnienia. `buildDynamicTopic` przypisuje typy ćwiczeń według rodzaju:

| Rodzaj | Typy |
|---|---|
| words | card, match, group, choice, listen_choice, cloze, gap, open_answer |
| frame | card, match (pytanie ↔ odpowiedź), order, choice, listen_choice, cloze, gap, open_answer |

`listen_choice` (`lesson_listen_choice`, „Posłuchaj i wybierz”, #198) to ćwiczenie dodatkowe poza etapami, w obu rodzajach zagadnień: dziecko słyszy pełne zdanie (nagranie `feedback_audio`) i wybiera brakujące słowo lub formę z opcji; nie niesie polskiego bodźca w `instructionPl` (polecenie jest stałe), a elementem sprawdzanym jest wypełnienie luki z materiału. Projekt: `docs/superpowers/specs/2026-11-01-lesson-listen-choice-design.md`.

Karty (2–4): lista „słowo — polskie znaczenie” albo wzór ramy z 1–3 przykładami po angielsku **bez polskich tłumaczeń**; żadna karta nie niesie pary zdań polskie → angielskie (karta słów może wypisywać pojedyncze słowa z polskim znaczeniem). Treść karty nie jest ekspozycją, więc para zdań na karcie ujawniałaby rozwiązanie tłumaczenia bez zapisu (4.5). Identyfikatory zagadnień mają prefiks identyfikatora przedmiotu (`english_chapter.d<deckId>.<slug>`); dziś prefiks `school.d` jest wpisany na stałe (`lesson-drafts.ts:448`), a dla przedmiotu szkolnego pozostaje bez zmian.

### 4.3. Typy zadań i etapy

Mapowanie etapów w `STAGE_BY_TYPE` bez zmian.

| Etap | Typ | Treść | Bodziec znaczenia |
|---|---|---|---|
| guided | `lesson_match` | lewa strona po angielsku (słowo, zwrot albo pytanie z rozdziału), prawa: polskie znaczenie albo angielska odpowiedź; 3–5 par + 0–2 dystraktory | strona polska / para pytanie–odpowiedź |
| guided | `lesson_group` | tylko gdy słowa zagadnienia dzielą się naturalnie na 2–3 kategorie; polskie etykiety, 4–8 angielskich elementów | etykiety grup |
| guided | `lesson_cloze` | 2–3 krótkie zdania z ram rozdziału (całe `instructionPl` — polskie znaczenie i komenda — najwyżej 120 znaków), 2–4 luki na słowa z rozdziału, 1–2 słowa-pułapki z materiału; każda luka jednoznaczna, luki niezamienialne, pułapka nie pasuje do znaczenia żadnej luki (ocena całościowa) | polskie znaczenie całego tekstu w `instructionPl` („W poniedziałek pada deszcz. W środę wieje wiatr. Uzupełnij tekst.”) |
| guided | `lesson_choice` | angielskie zdanie z luką w `stem`, 2–3 opcje | polskie zdanie w `instructionPl` („Dziś pada śnieg. Wybierz słowo.”) |
| guided | `lesson_order` | klocki-słowa zdania z ramy; zdania bez przestawnych części (jedna poprawna kolejność) | polskie zdanie w `instructionPl` („Ułóż zdanie: Mam na sobie różowy płaszcz.”) |
| productive | `lesson_gap` | angielskie zdanie z jedną luką | polskie zdanie w `instructionPl` („Mam na sobie zielony płaszcz. Wpisz brakujące słowo.”) |
| independent | `lesson_open_answer` | tłumaczenie krótkiego zdania; `prompt` = polskie zdanie, odpowiedź ≤120 znaków; `instructionPl` zawsze „Przetłumacz na angielski.” | polskie zdanie |

`prompts.typeRules` i `fieldRules` przedmiotu opisują powyższe wprost (prawa strona par po polsku albo angielska odpowiedź, luki cloze na słowa z rozdziału, bodziec w `instructionPl`, brak `hint`). W parach dodatkowa pozycja po prawej nigdy nie jest poprawnym partnerem żadnej pozycji z lewej, a w parach pytanie ↔ odpowiedź nie jest poprawną odpowiedzią na żadne pytanie z listy (próba: „inna odpowiedź na to samo pytanie” dawała dwie poprawne odpowiedzi). Test sprawdza złożony tekst promptu dla obu przedmiotów.

### 4.4. Zgodność z materiałem (walidacja słownikowa, tylko generacja)

Działa w `refineGeneratedPool`, więc nie ogranicza rodzica: przy edycji i publikacji rodzic może dopisać słowo albo wariant spoza materiału.

**Słownik materiału.** Tokeny po normalizacji:

- NFC, małe litery, `’`→`'`;
- apostrof wewnątrz słowa zostaje (`i'm`, `it's`), reszta interpunkcji znika;
- wyraz z łącznikiem daje token całości i tokeny części (`t-shirt`, `t`, `shirt`);
- skróty rozwijane normalizatorem angielskim po obu stronach porównania;
- prosta odmiana: token pasuje, gdy po odcięciu końcówki `-s`, `-es`, `-ies`→`-y`, `-ing` lub `-ed` (z podwojoną spółgłoską) zgadza się z tokenem materiału albo odwrotnie (`boots`/`boot`, `raining`/`rain`).

`FUNCTION_WORDS` to stała, testowana lista około 60 słów funkcyjnych w module.

**Element sprawdzany** spełnia dwa warunki: każdy jego token jest w słowniku materiału albo w `FUNCTION_WORDS`, a co najmniej jeden token jest w słowniku i nie jest słowem funkcyjnym. Wiodące `a`/`an`/`the`/`to` są pomijane.

| Typ | Co jest sprawdzane | Skutek niepowodzenia |
|---|---|---|
| `lesson_match` | każde `left` | odrzucenie ćwiczenia |
| `lesson_group` | każdy element | odrzucenie ćwiczenia |
| `lesson_cloze` | każde `gapAnswers` i `extraWords` | odrzucenie ćwiczenia |
| `lesson_choice` | każda opcja | odrzucenie ćwiczenia |
| `lesson_order` | zdanie odpowiedzi | odrzucenie ćwiczenia |
| `lesson_gap`, `lesson_open_answer` | `answer` | odrzucenie ćwiczenia |
| `lesson_gap`, `lesson_open_answer` | `acceptedAnswers` spoza materiału | usunięcie samego wariantu, ćwiczenie zostaje |

**Niezamówione pola v3 (dodane podczas strojenia po próbie).** `refineGeneratedPool` usuwa ze świeżego ćwiczenia pola v3, których przedmiot nie żąda (`questionType`, `requiredElements`, `supplementaryElements`, `commonErrors`, `expectedForm`, `familyId`, `sourceRefs`), zamiast je odrzucać. Prawdziwy model potrafił wypełnić je dla całej partii mimo polecenia „null” (w próbie cytaty `sourceRefs` w jednej z czterech partii), a walidacja ogólna odrzuca takie ćwiczenie jako „pole v3 niedozwolone”, więc tracona była cała partia zagadnienia. To niepożądany dodatek modelu, nie dane rodzica; lista pól pochodzi z walidacji ogólnej (`V3_EXERCISE_FIELDS`) bez `calculation` — specyfikacja rachunku to inny typ ćwiczenia, który ma zostać odrzucony przez walidację, a nie po cichu naprawiony. Dane rodzica (edycja, publikacja) tej naprawie nie podlegają.

**Brakujące polecenie tłumaczenia (dodane po końcowym przeglądzie).** Prawdziwy model zwracał `instructionPl: null` w 20–50% tłumaczeń, a materializacja pokazywała wtedy tytuł zagadnienia zamiast polecenia. Prompt każe dawać dokładnie „Przetłumacz na angielski.”, `refineGeneratedPool` uzupełnia brakujące lub puste polecenie tłumaczenia tym tekstem (jak usuwanie niezamówionych pól: naprawa świeżego wyjścia modelu), a `validateExercise` wymaga niepustego polecenia.

**Raport dla rodzica.** Powody odrzuceń są zliczane (np. „słowo spoza materiału: raining ×3”, „tylko słowa pomocnicze: the ×1” — element złożony wyłącznie ze słów funkcyjnych) w `lesson_context.rejectedReasons` obok dzisiejszego `rejectedCount` i pokazywane w edytorze lekcji, żeby rodzic wiedział, czy dogenerować. To zliczenia bez danych dziecka. Powody dotyczą tylko sprawdzania słów z materiału, a `rejectedCount` liczy wszystkie odrzucenia generacji, więc edytor podpisuje listę „Powody odrzuceń przy sprawdzaniu słów z materiału” i dopisuje „inne powody: N”, gdy `rejectedCount` przekracza sumę wypisanych powodów.

**Znane ograniczenia:**

- słowa z poleceń podręcznika („listen”, „tick”) wklejone w materiał liczą się jako słownictwo;
- przykłady na kartach i zdania-bodźce nie są sprawdzane (tylko reguła w prompcie i przegląd rodzica);
- rozdziału, którego kluczowym materiałem są słowa funkcyjne (przyimki in/on/under, can/can't, this/these, is/are, do/does, he/she), nie da się ćwiczyć na tych słowach jako opcjach, lukach ani słowach banku: reguła słownikowa wymaga w elemencie co najmniej jednego słowa treści, więc takie ćwiczenia odpadają z powodem „tylko słowa pomocnicze”. Przed użyciem z takim rozdziałem warto wykonać próbę (`pnpm probe:chapter`) na rozdziale o przyimkach albo o can/can't.

### 4.5. Ocena, samodzielność, opanowanie, kartkówka

**Ocena:**

- Porównanie z zatwierdzonymi wariantami po normalizacji (`I'm` = `I am`).
- Wpisana odpowiedź niedopasowana do wariantów (luka i tłumaczenie) idzie do cache werdyktów, a potem do modelu oceniającego (standardowa ścieżka lekcji). Model dostaje polecenie z polskim bodźcem (`buildGraderInput` przekazuje `instructionPl`).
- `almostDefinition` zgodne z semantyką silnika (`evaluate.ts:577-600`): drobna literówka poza sprawdzanym słowem to `almost` bez kategorii (zaliczone); błąd w sprawdzanym słowie to `incorrect` z kategorią `spelling` albo `wrong_word`.
- `gradingRole`: zdanie ma oddawać znaczenie polskiego zdania; poprawny synonim spoza rozdziału jest co najwyżej `almost`, nie błędem.

**Samodzielność — decyzja dla tego przedmiotu.** Lekcja rozdziału sprawdza użycie słowa w zdaniu, więc ekspozycją jest **rozwiązane zdanie**, a nie pojedyncze słowo. `exposureText`:

| Typ | Tekst ekspozycji |
|---|---|
| `lesson_choice`, `lesson_gap` | zdanie ze wstawioną odpowiedzią |
| `lesson_cloze` | cały uzupełniony tekst |
| `lesson_order`, `lesson_open_answer` | `answer` |
| `lesson_match`, `lesson_group` | jak dziś (złączona odpowiedź) |

Tekst ekspozycji jest normalizowany przed `computeTargetKey` (`normalizeChapterExposureText`, opcja `normalizeExposureText`): typograficzne apostrofy i cudzysłowy → proste, wielokrotne spacje → jedna, bez końcowej interpunkcji `.!?…`. Dzięki temu „It's snowing.” i „It’s snowing” to ta sama ekspozycja. Ta sama normalizacja obejmuje przykłady kart (`lessonTextTargetKey` w `materializeCard`), więc przykład „I’m wearing a pink coat.” i luka rozwiązana do „I'm wearing a pink coat” mają jeden klucz (przed końcowym przeglądem klucz przykładu zachowywał kropkę i luka po karcie liczyła się jako samodzielna). `exposureText` i `normalizeExposureText` są utrwalonym kontraktem: edycja rodzica przelicza klucze rewizji, a skopiowane szkice i opublikowane wersje zachowują zapisane, więc ich zmiana wymaga decyzji o migracji lub uzupełnieniu kluczy.

Skutki tej decyzji:

- zadanie samodzielne = zdanie, którego rozwiązania dziecko jeszcze nie widziało;
- treść karty i słowo widoczne w parach, grupach lub banku słów nie są ekspozycją (jak dziś w lekcjach); ekspozycją karty są wyłącznie jej przykłady (`lesson_context.examples`), dlatego karty nie niosą par zdań polskie → angielskie (4.2);
- klucze lekcji i słówek pokrywają się dokładnie wtedy, gdy tekst po normalizacji i język są równe — dla pojedynczych słów i wielowyrazowych zwrotów (np. tłumaczenie „poniedziałek” → „Monday” i słówko „Monday” albo „Pada deszcz.” → „It's raining.” i słówko „It's raining”); ekspozycje są wspólne dla dziecka. Zwykle klucz zdania nie pokrywa się z celem słówka, więc zdania lekcji i słówka się nie blokują. Przy pokryciu blokada jest w praktyce asymetryczna: słówka liczą samodzielność w oknie 300 s od ujawnienia, lekcje — od jakiegokolwiek wcześniejszego ujawnienia, więc ekspozycja słówka trwale odbiera samodzielność tłumaczeniu rozdziału o identycznym tekście, a ekspozycja z lekcji blokuje słówko tylko na 300 s (Etap 4, słówka ze źródła, tego nie zmienił — „Stan Etapu 4”, sekcja 10);
- znane ograniczenie: słowo pokazane w lekcji tylko jako część treści karty, par, grupy, banku albo zdania nie chroni samodzielnego przypominania tego słowa w zestawie słówek;
- znane ograniczenie (ziarnistość uzupełniania tekstu): kluczem tekstu z lukami jest cały uzupełniony tekst, więc zdanie rozwiązane wewnątrz uzupełniania nie blokuje luki ani tłumaczenia tego samego zdania.

**Opanowanie:** jak dziś w lekcjach — trzy ostatnie kwalifikujące sukcesy na różnych ćwiczeniach, w tym jeden w późniejszej sesji innego dnia po ≥12 h.

- Należne sprawdzenia samodzielne wybierają najpierw tłumaczenie, a lukę na niewidzianym zdaniu dopiero jako zapas (`scheduler.ts:350-375`).
- Bez modelu tłumaczenie zalicza tylko dokładne trafienie w wariant (inaczej „nieocenione” bez kary).
- Luka na niewidzianym zdaniu działa bez modelu.

**Kartkówka:** jak w lekcjach. Bodziec zostaje, bo jest w `instructionPl`. Pary, grupy i luki z bankiem są w niej nauką wspomaganą. Raport per zagadnienie.

### 4.6. Tworzenie lekcji

- `createSchoolLesson` jest cienką komendą nad wspólnym `createMaterialLesson(services, { subjectId, subjectTitlePl?, … })` dla przedmiotów z `buildDynamicTopic` (zaimplementowane w Etapie 1).
- `SubjectCatalogDto` dostaje jawne `creation: "catalog" | "material"` oraz `subjectTitleRequired`. Formularz rodzica wybiera ścieżkę po tych polach, a nie po pustej liście tematów — dziś `isSchoolSubject` uznałby `english_chapter` za szkołę (`NewLessonForm.tsx:68-71`). Pola wyprowadza ten sam predykat co polecenia tworzenia (`domain/lessons/material-creation.ts`, opcja `materialSubjectTitle`), żeby formularz nie obiecywał ścieżki, którą serwer odrzuci.
- Nowa komenda `MaterialLessonCommand` (zamiast pierwotnie planowanej `ChapterLessonCommand`: jest ogólna dla przedmiotów o stałym tytule, nie tylko dla rozdziału) z procedurą oRPC `lessons.createFromMaterial` (POST `/lessons/material`, 202 `{ runId, deckId }`):
  - `clientRequestId`,
  - `subjectId` (przedmiot o `materialSubjectTitle: "fixed"`; przedmiot katalogowy i szkolny → `validation`),
  - `topicTitlePl` (np. „Unit 1”, 1–120),
  - `material` (1–16 000 znaków); `sourceMaterialId` jako alternatywa (3.3) dojdzie w Etapie 2,
  - opcjonalnie `instruction` (≤500), `poolSize`, `deckId`.

  Tytuł zestawu: „Angielski — rozdział: <topicTitlePl>” (tytuł przedmiotu z modułu, dwukropek, tytuł tematu; przycięty do 120 znaków), a nie pierwotne „Angielski: <topicTitlePl>”.
- Fałszywy provider dostaje gałąź `english_chapter` (bez `sourceRefs`, z polskim bodźcem w poleceniu, z `kind` zagadnień).

### 4.7. Języki w Kid DTO i panel rodzica

- Prompty `lesson_match`, `lesson_group`, `lesson_cloze`, `lesson_choice`, `lesson_order` i `lesson_gap` dostają opcjonalne `contentLocale`. Silnik ustawia je zawsze na `answerLocale` przedmiotu: dla każdego przedmiotu treść tych typów jest w języku odpowiedzi (szkoła `pl-PL`, gramatyka i rozdział `en-GB`), więc nie ma gałęzi po identyfikatorze przedmiotu.
- `lesson_open_answer` dostaje opcjonalne `answerLocale` (język pola odpowiedzi), a `promptLocale` bierze z `openAnswerPromptLocale`, gdy przedmiot je ma (inaczej reguła jak dziś). Kid UI ustawia `lang` pola odpowiedzi z `answerLocale`, a nie z `promptLocale` jak dziś (`LessonSentenceView.tsx:58-71`). Nowy klient ze starszym serwerem (bez nowych pól) działa jak dotąd; w odwrotnym kierunku obowiązuje uwaga o wdrożeniu w sekcji 7.
- Kid UI oznacza `lang` treść o pewnym języku: lewą kolumnę par, elementy grup, tekst cloze i bank słów, `stem` i opcje wyboru, klocki, zdanie z luką i samo pole luki (język odpowiedzi, jak pole tłumaczenia). Prawa kolumna par i etykiety grup nie dostają `lang` treści. Bez nowych widoków i wzorców interakcji. `lang` działa pewnie dla tekstu nieinteraktywnego; przycisk z polską etykietą `aria-label` wewnątrz elementu `lang="en-GB"` czytnik ekranu może przeczytać angielskim głosem (do poprawy w Kid UI, poza Etapem 1).
- Panel rodzica: przedmiot „Angielski — rozdział” w formularzu nowej lekcji (tytuł + materiał wklejony albo ze źródła); edytor bez nowych edytorów typów, z podsumowaniem powodów odrzuceń (4.4) i — gdy jest — rodzajem zagadnienia.

## 5. Lektor po odpowiedzi

**Uzupełnienie (Etap 3, 2026-10-31).** Wersja 2 tej sekcji zakładała własną flagę rozdziału `ttsForFeedback`, własną migrację roli `feedback_audio`, wyszukiwanie nagrania przy ocenie i głośnik bez autoodtwarzania. Zanim powstał Etap 3, właściciel scalił #194: generyczny odczyt pełnego zdania po odpowiedzi dla gramatyki (`docs/superpowers/specs/2026-10-30-lesson-sentence-readback-design.md`). Rozdział korzysta z tego mechanizmu, a Etap 3 dokłada tylko to, czego rozdział potrzebuje ponad niego (5.2); różnice względem wersji 2 zbiera 5.3.

### 5.1. Zachowanie i mechanizm (z #194)

`englishChapterSubject.ttsForFeedbackSentence = true`. Bez nowej migracji, roli zasobu i zmiany kontraktu: rola `feedback_audio` pochodzi z migracji `0029` (#194), a `FeedbackDto.correctAudioAssetId` już istnieje. Po ocenionej odpowiedzi w treningu dziecko słyszy pełne poprawne zdanie po angielsku (`en-GB`):

- nagranie powstaje przy przygotowaniu materiału z zatwierdzonego payloadu (TTS w `answerLocale`, bez stylu wypowiedzi, fingerprint z tekstu i głosu); publikacja na nie nie czeka, a nieudane wraca do kolejki przy uzgadnianiu. Opublikowana lekcja dostaje nagrania po „Utwórz nową wersję” → „Publikuj”;
- identyfikator nagrania zapisuje się przy wydaniu zadania w prywatnym kluczu zadania (`LessonTaskAnswerKey.feedbackAudioAssetId`); kartkówka go nie dostaje, a zadanie wydane przed gotowością nagrania zostaje bez odczytu;
- ujawnia go wyłącznie `FeedbackDto.correctAudioAssetId`, gdy feedback pokazuje rozwiązanie, a odpowiedź kończy zadanie. Nagrania nie ma w próbnej kartkówce, przy „Pomiń”, `not_assessed`, ofercie trenera precyzji ani gdy odpowiedź zostawia zadanie wydane (`issued`);
- w tej samej transakcji serwer pieczętuje `audio_issued` z ekspozycją `targetKey` zadania (czyli rozwiązanym zdaniem, 4.5) i `occurredAt = max(now, receivedAt + 1 ms)` (wspólny helper `sealPostAnswerAudio`), więc samodzielność próby się nie zmienia;
- Kid UI odtwarza nagranie automatycznie raz i oferuje „Posłuchaj zdania”; „Dalej” je przerywa, a „Nie pamiętam” zostaje na wyniku do „Dalej”.

### 5.2. Tekst nagrania

Czysta funkcja domenowa `feedbackSentenceText` (`domain/lessons/feedback-sentence-text.ts`, #194) buduje tekst wyłącznie z zatwierdzonego payloadu:

| Typ | Tekst nagrania |
|---|---|
| `lesson_choice` | `stem` z jedną luką zastąpioną tekstem poprawnej opcji; bez luki → brak nagrania |
| `lesson_gap` | `stem` z jedną luką zastąpioną `answer`; bez luki → brak nagrania |
| `lesson_cloze` | `fillCloze(clozeText, gapAnswers)` (`domain/lessons/cloze.ts`), gdy liczba odpowiedzi równa się liczbie luk i żadna nie jest pusta; inaczej brak nagrania (dodane w Etapie 3, generycznie) |
| `lesson_order` | teksty klocków w kolejności kanonicznej, złączone spacją, bez spacji przed `.,!?` (jak w #194; nie `answer`) |
| `lesson_open_answer` | `answer` |
| `lesson_match`, `lesson_group`, `lesson_card` | brak nagrania |

Zasady wspólne: przycięcie i scalenie białych znaków (bez spacji przed `.,!?`); tekst pusty albo dłuższy niż 200 znaków → brak nagrania. Tekst nagrania to rozwiązane zdanie, czyli to, co omówienie już pokazuje i zapisuje jako ekspozycję (4.5); w uzupełnianiu tekstu jest to ten sam uzupełniony tekst, który pokazuje omówienie (`filledText` w kluczu zadania), równy tekstowi nagrania po ujednoliceniu białych znaków — nagranie jest przycięte i ma scalone białe znaki, a klucz trzyma surowy wynik `fillCloze`.

**Bramka wariantu (generyczna, także w gramatyce).** Bramka działa tylko wtedy, gdy omówienie pokazuje `correctText`: wtedy dziecko nie słyszy innego zdania niż to, które widzi. Gdy `correctText` jest różny od kanonicznego tekstu rozwiązania zadania (`correctTextFor`) — np. „Prawie!” z najbliższym zatwierdzonym wariantem tłumaczenia — `withFeedbackSentenceAudio` nie dołącza nagrania, więc nie ma też pieczęci `audio_issued`. Odpowiedź przyjęta jako wariant bez `correctText` (`great`) dostaje nagranie zdania kanonicznego, jak w #194; ekspozycja `targetKey` jest ta sama co feedbacku.

### 5.3. Różnice względem wersji 2 projektu

| Wersja 2 (nie weszła do kodu) | Etap 3 (zaimplementowane) |
|---|---|
| własna flaga `ttsForFeedback` | flaga `ttsForFeedbackSentence` z #194 (generyczna: `english_grammar` i `english_chapter` `true`, `school` `false`) |
| własna migracja roli `feedback_audio` i typu `AssetRole` | rola z migracji `0029` (#194); rozdział bez migracji |
| nagranie wyszukiwane przy ocenie w trzech ścieżkach finalizacji | identyfikator zamrożony w prywatnym kluczu zadania przy wydaniu; dołącza go `withFeedbackSentenceAudio` |
| `audio_issued` z `clock.now()` | `occurredAt = max(now, receivedAt + 1 ms)`, wspólny helper `sealPostAnswerAudio` |
| głośnik bez autoodtwarzania | autoodtwarzanie raz + „Posłuchaj zdania”; „Dalej” przerywa (decyzja właściciela z #194 dla lekcji) |
| `feedbackReadText`; `lesson_order` czyta `answer` | `feedbackSentenceText`; `lesson_order` czyta kanoniczną kolejność klocków |
| reguła wariantu tylko dla `lesson_open_answer` (pokazany wariant równy `answer` po normalizacji) | generyczna bramka wariantu (porównanie z `correctTextFor`), obejmuje też gramatykę |

## 6. Słówka ze źródła

Stan: zaimplementowane w Etapie 4 (2026-10-31); ustalenia i odstępstwa od tej sekcji — „Ustalenia implementacji” w 6.2 i „Stan Etapu 4” w sekcji 10.

### 6.1. Dwie ścieżki

| Ścieżka | Skąd słowa | Zmiana |
|---|---|---|
| Z opisu (np. „przedmioty codziennego użytku, dni tygodnia”) | model dobiera słowa do tematu | bez zmian |
| Ze źródła | wyłącznie słowa z tekstu źródła | nowa |

### 6.2. Tryb „ze źródła”

**Kontrakt i formularz:**

- Formularz otwarty ze strony źródła: format (`standard`/`picture`), maksymalna liczba słów (≤ `MAX_DECK_ITEMS`), opcjonalne polecenie zawężające.
- `GenerationCommand` dostaje `sourceMaterialId` i `instruction` (≤500 znaków, np. „tylko pogoda”). `prompt` staje się wzajemnie wykluczający z `sourceMaterialId`, a zwykłe polecenie zostaje przy 4000 znaków.
- Domyślny tytuł zestawu to tytuł źródła, bo dziś tytuł bierze się z początku `prompt`.
- Tekst źródła trafia do zapisanego inputu generacji i do `LlmGenerateDeckInput` osobnym polem `material`.

**Prompt:** model wypisuje słowa i krótkie stałe zwroty, których uczy materiał, w formie z materiału, bez własnych dodatków. Proponuje polskie znaczenie i przykładowe zdanie. Ramy zdaniowe z lukami („I'm wearing (a) …”) nie są elementami słówek, a polecenie zawężające nie może dodać słów spoza materiału.

**Walidacja per element:** dziś walidacja zestawu działa wszystko-albo-nic (`GeneratedDeckSchema.parse`, `validateVocabularyFormatItems`). Tryb materiału waliduje elementy pojedynczo:

- element niepoprawny albo spoza materiału jest odrzucany, a reszta zostaje;
- zero poprawnych elementów = błąd generowania;
- liczba odrzuceń trafia do runu i do `GenerationDto`, bo wersja słówek nie ma `lesson_context`.

**Dopasowanie do materiału:** `target` pasuje, gdy po normalizacji występuje w materiale jako fraza na granicach słów. Normalizacja:

- małe litery, interpunkcja i apostrofy jak w 4.4;
- pominięte wiodące `a`/`an`/`the`/`to`;
- skróty z zamkniętej tabeli przez normalizator angielski (`subjects/english/contractions.ts`; skrótów spoza tabeli, np. „what's”, nie rozwija);
- prosta odmiana jak w 4.4.

**Bez zmian:** ilustracje i wizualizacje deterministyczne, TTS słów, przegląd, publikacja, scheduler, umiejętności.

**Ustalenia implementacji (Etap 4, 2026-10-31)** — rozstrzygnięcia, których ta sekcja nie określała:

- para języków stała `pl-PL` → `en-GB` (`locales` zabronione przy `sourceMaterialId`); `expectedSourceRevision` (rewizja treści podglądu) wymagane jak przy lekcji ze źródła (3.3), z tym samym 409 `source_changed`;
- formularz: „Najwięcej słówek” 1–100, domyślnie 20 (serwer bez wartości w poleceniu nadal przyjmuje 50); nazwa domyślnie tytuł źródła, a pusta albo z samych białych znaków daje tytuł źródła także po stronie serwera;
- słówko z tekstu: `target` jest frazą z tekstu (normalizacja wyżej) i nie jest ramą z luką (`…`, `...`, `__`, nawias). Słowa funkcyjne i zwroty stojące w tekście są dozwolone („today”, „yes”, „How are you?”) — w odróżnieniu od lekcji (4.4) nie jest wymagane słowo treści. Element złożony tylko z wiodącego `a`/`an`/`the`/`to` nie jest słówkiem. Sprawdzany jest wyłącznie `target`; `acceptedAnswers` i `example` nie są porównywane z tekstem;
- elementy są sprawdzane w kolejności modelu, a po przyjęciu `maxItems` sprawdzanie się kończy: dalsze elementy nie są ani przyjęte, ani liczone jako odrzucone; lista modelu dłuższa niż 3 × `MAX_DECK_ITEMS` (300) albo o złym kształcie to błąd walidacji całego runu (`validation`);
- zero przyjętych = porażka z kodem `no_source_items` (szkic bez zmian, liczba odrzuceń zapisana); w edytorze „Pominięto pozycji spoza tekstu lub niepoprawnych: {n}”, a przy porażce „Nie znaleziono w tekście źródła słówek do zestawu. Ponów generowanie albo utwórz nowy zestaw ze źródła z innym zawężeniem lub w rodzaju standardowym.” i odnośnik „Przejdź do źródła”, gdy zestaw ma źródło;
- przyjęte `target` i `acceptedAnswers` są zapisywane w ujednoliconej postaci (typograficzne apostrofy → `'`, zwinięte białe znaki, bez końcowej interpunkcji zdania `.!?…,;:`), a powtórzenie rozpoznaje też klucz dopasowania (tokeny po pominięciu wiodących `a`/`an`/`the`/`to`, bez interpunkcji) i liczy je jako odrzucone;
- liczba odrzuceń w nowej kolumnie `generation_runs.rejected_count` (migracja `0031`): input runu jest niezmiennym żądaniem, a wersja słówek nie ma `lesson_context`.

## 7. Kontrakty, API, MCP

- `packages/contracts`:
  - schematy źródeł (`SourceMaterialInput`, `SourceMaterialPatch`, `SourceMaterialDto`, `SourceMaterialSummaryDto`);
  - `MaterialLessonCommandSchema` (Etap 1; w pierwszej wersji projektu `ChapterLessonCommandSchema`, z `sourceMaterialId` dopiero w Etapie 2);
  - `sourceMaterialId` w `SchoolLessonCommandSchema` i `GenerationCommandSchema` (z regułą „dokładnie jedno źródło tekstu”) oraz `instruction` w `GenerationCommandSchema`; w Etapie 2 reguła obowiązuje w `SchoolLessonCommandSchema` i `MaterialLessonCommandSchema`, a `GenerationCommandSchema` (słówka) dostał w Etapie 4 `sourceMaterialId` z wymaganym `expectedSourceRevision` i `instruction` (≤ `MAX_GENERATION_INSTRUCTION_LENGTH` = 500), bez `locales` przy źródle; schemat nadal bez `.strict()`;
  - `rejectedCount` w `GenerationDto` (Etap 4; z kolumny `generation_runs.rejected_count`, `null` dla trybu opisu i runów bez walidacji per element);
  - `creation` i `subjectTitleRequired` w `SubjectCatalogDto`;
  - `sourceMaterialId` i `sourceMaterialRevision` w DTO zestawu dla rodzica — w Etapie 2 wyłącznie dla lekcji, jako opcjonalne `LessonDeckDto.source { id, title, copiedRevision, currentRevision }` (rewizje treści; tytuł i bieżąca rewizja treści pochodzą z żywego źródła, więc pole znika po jego usunięciu); DTO zestawu słówek dostał odnośnik w Etapie 4 (`DeckDto.source`, ten sam kształt `DeckSourceDtoSchema` w `contracts/decks.ts`, a `LessonDeckSourceDtoSchema` jest jego aliasem); `DeckSummaryDto` (lista zestawów) odnośnika nie ma — zestawy źródła wymienia strona źródła;
  - `rejectedReasons` w DTO szkicu lekcji;
  - opcjonalne `contentLocale` i `answerLocale` w promptach lekcji Kid DTO.
- Serwerowe schematy `.strict()` dostają nowe pola. Kid UI także waliduje zadania i sesje ścisłymi schematami z `@learning/contracts` (`parseWith(TaskDtoSchema/SessionDtoSchema)`, błąd daje ogólny `KidApiError("internal")`), a silnik ustawia `contentLocale` i `answerLocale` dla każdego przedmiotu lekcji. Pakiet Kid UI zbudowany przed zmianą odrzuci więc zadania lekcji typów, które niosą nowe pola — wybór, układankę, lukę, pary, grupy, uzupełnianie tekstu (`contentLocale`) i odpowiedź otwartą (`answerLocale`), także w gramatyce i szkole; karty i pozostałe typy lekcji nie są dotknięte — więc web i Kid UI/PWA wdrażamy razem, a po wdrożeniu otwartą kartę lub PWA trzeba odświeżyć — jak przy wcześniejszych dodaniach pól w ścisłych schematach (np. `promptLocale`). Nowy klient ze starszym serwerem działa, bo pola są opcjonalne.
- Porty: `LessonObjectivesInput.objectivesRules`, `LlmGenerateDeckInput.material` i `instruction` (Etap 4: unia `{ prompt }` | `{ material, instruction? }`); zmiany w adapterze OpenAI, schemacie puli (`sourceRefs` zależne od `sourceQuotes`) i fałszywym providerze.
- Procedury oRPC rodzica dla źródeł i lekcji rozdziału. Kid API bez nowych endpointów.
- MCP i `SKILL.md`: bez zmian. Raport Hermesa (`learning-overview`) filtruje do `kind='vocabulary'`, więc lekcje i źródła są poza nim. Słówka ze źródła to zwykłe zestawy słówek o niezmienionym znaczeniu danych. Uzasadnienie w opisie każdego PR.

## 8. Testy

**Jednostkowe (domena i adaptery):**

- rejestracja `english_chapter`; przedmiot testowy `history-like-subject` dalej przechodzi;
- walidacja słownikowa: element w materiale, odmiana, łącznik, skróty, słowa funkcyjne, odrzucenie słowa spoza materiału, usunięcie wariantu zamiast ćwiczenia, brak działania przy edycji rodzica;
- `validateExercise` przedmiotu: jedna luka, bodziec w poleceniu, brak `hint`, brak powtórzonych klocków, limit 120;
- tożsamość ćwiczeń z `instructionIsStimulus`: to samo zdanie z innym bodźcem to dwa ćwiczenia;
- `exposureText` z normalizacją;
- `feedbackSentenceText` (#194) dla każdego typu i dla `stem` bez luki, w tym `lesson_cloze` (pełne, niepełne i nadmiarowe odpowiedzi luk), oraz bramka wariantu w `withFeedbackSentenceAudio`;
- schemat puli bez `sourceRefs` dla `sourceQuotes: false` i z `sourceRefs` dla szkoły;
- tekst promptów zagadnień i puli dla obu przedmiotów;
- przeniesiony normalizator (dotychczasowe testy gramatyki przechodzą);
- dopasowanie `target` słówek do materiału;
- testy architektoniczne (granice obszarów, silnik nie importuje przedmiotów, brak gałęzi po identyfikatorze przedmiotu).

**Kontrakty:** schematy źródeł, wzajemne wykluczanie `material` / `sourceMaterialId` / `prompt`, limity, nowe pola opcjonalne.

**Integracyjne (PostgreSQL):**

- **Źródło:**
  - idempotentne tworzenie, konflikt przy innej treści, konflikt `revision`;
  - kopia tekstu i rewizji w zestawie;
  - edycja źródła nie zmienia zestawu;
  - usunięcie równoległe z tworzeniem daje `not_found`, a usunięcie zostawia zestaw z `null`.
- **Lekcja rozdziału** z fałszywym generatorem:
  - zagadnienia z `kind`, pula i publikacja;
  - odrzucenie zadania spoza materiału z powodem w `rejectedReasons`;
  - pełne odrzucenie i to, co widzi rodzic;
  - rodzic dopisuje wariant spoza materiału i publikuje.
- **Samodzielność:**
  - luka po wyborze w tym samym zdaniu nie jest samodzielna;
  - luka w innym zdaniu z tym samym słowem jest samodzielna;
  - ekspozycja słówka nie blokuje luki i odwrotnie.
- **Kartkówka:** luka z bodźcem w poleceniu, bez nagrania.
- **Nagranie w omówieniu** — rozdział pokrywa `tests/integration/lesson-chapter-sentence-audio.test.ts`, a mechanizm wspólny z #194 `tests/integration/lesson-sentence-audio.test.ts` (gramatyka):
  - rozdział: szkic zleca `feedback_audio` w `en-GB` bez stylu wypowiedzi dla wyboru, luki, luk z bankiem, układanki i tłumaczenia, a dla par, grup i kart nie; publikacja na nie nie czeka, a rodzic nie widzi tej roli;
  - rozdział: po publikacji i workerze ocenione odpowiedzi niosą identyfikator nagrania z jednym `audio_issued` po `receivedAt` i ekspozycją `targetKey`; dla luk z bankiem tekst nagrania jest równy `filledText` po ujednoliceniu białych znaków;
  - rozdział: tłumaczenie z odpowiedzią kanoniczną dostaje nagranie, a „Prawie!” z pokazanym innym wariantem — bez nagrania i bez pieczęci `audio_issued`;
  - generycznie (#194): ponowny odczyt i idempotentne ponowienie zwracają ten sam identyfikator bez drugiego `audio_issued`, kartkówka nie dostaje identyfikatora, zadanie wydane przed gotowością nagrania zostaje bez odczytu, „Pomiń”, `not_assessed` i `model_other` bez nagrania, samodzielność próby bez zmian;
  - bramka wariantu w gramatyce: scenariusz dodawany do `lesson-sentence-audio.test.ts` w Etapie 3 (zachowanie zmienia się także tam); „Prawie!” z wariantem kanonicznym ma nagranie w teście jednostkowym `withFeedbackSentenceAudio` (`lesson-attempts.test.ts`).
- **Media `feedback_audio` (R02/R06):**
  - nowa wersja starej lekcji nie dubluje zasobów przy niezmienionym tekście (`lesson-sentence-audio.test.ts`), a zmiana tekstu daje nowy fingerprint i zasób (`media.test.ts`);
  - spóźniony worker i nieudane nagranie: wspólny cykl życia zasobów TTS, testowany w `media.test.ts` i `publish-media-reconcile.test.ts` na nagraniach słówek, ilustracjach i `target_audio`, bez osobnego testu roli `feedback_audio`;
  - wznowienie zadania i dwa klienty: bez osobnego testu rozdziału; mechanizm sesji i kluczy zadań jest współdzielony z #194.
- **Słówka ze źródła:** odrzucenie pozycji spoza materiału przy zachowaniu reszty, `rejectedCount`.

**Kid UI:**

- test komponentu omówienia lekcji z głośnikiem;
- `lang` w parach, grupach i lukach;
- `lang` pola odpowiedzi tłumaczenia;
- specyfikacja geometrii Playwright omówienia z głośnikiem (portrait, landscape, tablet, desktop, cele ≥48 px).

**E2E:**

- rodzic: źródło → lekcja rozdziału → publikacja (`real`);
- dziecko: sesja lekcji rozdziału z odsłuchem w omówieniu (`mocked`).

Nowe pliki trafiają do `tests/e2e/spec-projects.ts` i `tests/integration-buckets.ts`.

## 9. Ryzyka i niezweryfikowane

- **Wykonalność generacji** na prawdziwym rozdziale: ile zadań odrzuca walidacja słownikowa i czy pula spełnia minima. Dlatego pierwszy etap zawiera próbę z prawdziwym modelem (sekcja 10); wynik może zmienić `FUNCTION_WORDS`, reguły odmiany albo minima.
- **Czytanie po angielsku:** bodźce są tekstowe, a dziecko dopiero zaczyna czytać po angielsku. Kryterium pilotażu: czy dziecko odczytuje słowa w parach, grupach i klockach bez pomocy. Odsłuch słów na kartach lub przed odpowiedzią to możliwe rozszerzenie po pilotażu.
- **Wymowa lektora `en-GB`** i autoodtwarzanie nagrania na fizycznym urządzeniu.
- **Pilotaż z dzieckiem.**

## 10. Etapy i PR

Każdy etap kończy się osobnym PR do scalenia przez właściciela. Kolejność zmieniona po przeglądzie i potwierdzona przez właściciela (2026-10-30). Największe ryzyko (wykonalność generacji) idzie pierwsze, a źródła są dodatkiem do działającej lekcji:

1. **Przedmiot „Angielski — rozdział”** z wklejonym materiałem (sekcja 4, bez `sourceMaterialId`) + próba z prawdziwym modelem na Unit 1–2 (wykonano na odtworzonym Unit 1). Z próby raportujemy liczbę zagadnień, odrzuceń według powodów i spełnienie minimów; materiał próby nie trafia do repozytorium. Ten PR zawiera też niniejszą specyfikację.
2. **Źródła** + lekcja rozdziału i lekcja szkolna ze źródła (sekcja 3) — zaimplementowane, stan w „Stan Etapu 2” niżej.
3. **Lektor po odpowiedzi** (sekcja 5) — zaimplementowany na mechanizmie z #194, stan w „Stan Etapu 3” niżej.
4. **Słówka ze źródła** (sekcja 6) — zaimplementowane, stan w „Stan Etapu 4” niżej.

Dokumentacja w PR etapów: nowa sekcja `docs/SPEC.md` (§37), uzupełnienie `docs/architecture.md` §19 (nowe opcje `SubjectModule`, źródła, odczyt zdania w rozdziale) i §22 (temat dynamiczny poza przedmiotem szkolnym), `docs/schema.sql`.

### Stan Etapu 1 (2026-10-30)

**Zaimplementowane** (gałąź `claude/english-chapter-1-lesson`, plan `docs/superpowers/plans/2026-10-30-english-chapter-stage1.md`): przedmiot `english_chapter` w `subjects/english-chapter/` (moduł, słownik materiału, walidatory, tekst ekspozycji, prompty); normalizator angielski w `subjects/english/`; generyczne opcje `SubjectModule` (`sourceQuotes`, `materialSubjectTitle`, `instructionIsStimulus`, `exposureText`, `normalizeExposureText`, `refineGeneratedPool`, `openAnswerPromptLocale`, `prompts.typeRules`, `prompts.objectivesRules`) i `DynamicObjectiveData.kind`; `contentLocale`/`answerLocale` w Kid DTO z atrybutami `lang` w Kid UI; `rejectedReasons` w szkicu i edytorze rodzica; `createMaterialLesson`, `createLessonFromMaterial`, `lessons.createFromMaterial` i `creation`/`subjectTitleRequired` w katalogu; fałszywy provider z gałęzią rozdziału; testy jednostkowe, integracyjne (`tests/integration/lesson-chapter.test.ts`) i narzędzie próby `pnpm probe:chapter`. Opis architektury: `docs/architecture.md` §19.9 i §22, produktu: SPEC §37. Odstępstwa od pierwszej wersji projektu: kategorie błędów (4.1), dodatkowa opcja `materialSubjectTitle`, `MaterialLessonCommand` zamiast `ChapterLessonCommand` i tytuł zestawu (4.6), usuwanie niezamówionych pól v3 (4.4). Po końcowym przeglądzie (2026-10-31): wspólna normalizacja ekspozycji ćwiczeń i przykładów kart (`normalizeExposureText`, 4.5), stałe polecenie tłumaczenia i bodziec w uzupełnianiu tekstu (4.1, 4.4), jednoznaczne luki i pary w promptach (4.3), karty ram bez tłumaczeń (4.2), uczciwy raport odrzuceń w edytorze (4.4), `lang` pola luki (4.7), spójność `buildDynamicTopic`/`materialSubjectTitle` w rejestrze oraz test architektoniczny, że silnik i adaptery nie zawierają literałów identyfikatorów przedmiotów (jedyny nazwany wyjątek: `"school"` w `createSchoolLesson`). Nie ma jeszcze: źródeł (Etap 2, stan niżej), lektora (Etap 3), słówek ze źródła ani osobnej specyfikacji E2E całego przebiegu rozdziału (Etap 2 i dalsze); formularz rodzica i edytor (rodzaje zagadnień, powody odrzuceń) pokrywają specyfikacje układu `parent-lessons-layout` i `parent-lesson-editor-layout`, a przebieg dziecka — testy integracyjne.

**Próba na prawdziwym modelu** (`google/gemini-3.8-flash`, odtworzony materiał Unit 1, pula 60; `pnpm probe:chapter` z `UMIEM_PROBE_MATERIAL` wskazującym plik poza repozytorium):

| Przebieg | Zagadnienia | Odrzucone | Publikowalny | Uwagi |
| --- | --- | --- | --- | --- |
| 1 (przed strojeniem) | 4 | 4 z 60 (6,7%) | nie | sprawdzany fragment tłumaczeń (`focus`) nie był ciągły; brak pokrycia samodzielnego w zagadnieniu-ramie |
| 2 (po poprawce `focus`) | 4 | 16 z 60 (26,7%) | nie | model wypełnił `sourceRefs` w całej partii; zagadnienie bez ćwiczeń |
| 3–4 (po strojeniu promptów i usuwaniu pól v3) | 5 | 0 | tak | 3 zagadnienia `words` i 2 `frame`; 4/6/2 ćwiczenia na zagadnienie; odpowiedzi luk w ramie powtarzały „wearing” |
| 5 (po strojeniu różnorodności luk i dystraktorów) | 4 | 2 z 60 (3,3%) | tak | odpowiedzi luk w ramie różne (najwyżej dwie takie same), klocki układanek bez interpunkcji |
| 6 (po końcowym przeglądzie, 2026-10-31) | 4 | 1 z 60 (1,7%; „tylko słowa pomocnicze”) | tak | wszystkie 12 tłumaczeń z poleceniem „Przetłumacz na angielski.” już od modelu; 4 teksty z lukami z polskim znaczeniem całego tekstu w poleceniu, każda luka jednoznaczna; karty ram z angielskimi przykładami bez tłumaczeń; 0 z 60 z niezamówionymi polami v3; 16 z 59 ćwiczeń (m.in. 7 tłumaczeń) rozwiązuje zdanie z przykładu karty |

Po końcowym przeglądzie (przebieg 6) przykład karty i ćwiczenie rozwiązujące to samo zdanie mają jeden klucz (4.5), więc te 16 ćwiczeń po pokazaniu karty nie liczy się już jako samodzielne — wcześniej żadne nie byłoby rozpoznane. Zmniejsza to pulę samodzielnych tłumaczeń; reguła promptu, by przykłady kart nie powtarzały odpowiedzi ćwiczeń, jest kandydatem na kolejne strojenie.

Strojenie obejmowało: ciągły `focus` tłumaczenia, zerowanie pól v3 w prompcie i ich usuwanie ze świeżego wyjścia, regułę banku uzupełniania (słowo banku nie występuje poza luką), różnorodność luk w ramach, dystraktory z tej samej kategorii oraz układanki bez interpunkcji końcowej. Po strojeniu trzy kolejne przebiegi (3, 4 i 5) były publikowalne, z 0%, 0% i 3,3% odrzuconych. Pierwsze dwa przebiegi pokazują, że jedno wadliwe pole w partii potrafi unieważnić całe zagadnienie, co uzasadnia czyszczenie świeżego wyjścia (4.4). Porównanie ze szkołą (po dwa przebiegi na `main` i na gałęzi, geografia): bez regresji; istniejąca, losowa usterka `questionType` na `lesson_choice` szkoły uczyniła niepublikowalnym jeden z dwóch przebiegów szkoły na `main` (próbka dwóch przebiegów, więc częstości nie szacujemy) i jest poza zakresem tego etapu.

**Niezweryfikowane:**

- pilotaż z dzieckiem (czy dziecko odczytuje angielskie słowa w parach, grupach i klockach bez pomocy);
- fizyczne urządzenie i czytniki ekranu z atrybutami `lang` (atrybuty sprawdzono tylko testami komponentów Kid UI; polskie `aria-label` przycisków wewnątrz `lang="en-GB"` mogą być czytane angielskim głosem); specyfikacja geometrii uzupełniania tekstu (`lesson-cloze-layout`) obejmuje wariant rozdziału z `contentLocale` i długim polskim poleceniem, ale pary, grupy i klocki rozdziału nie mają osobnej specyfikacji geometrii;
- prawdziwy materiał właściciela (NotebookLM): próba objęła odtworzony Unit 1, nie tekst od właściciela;
- odrzucanie słownikowe na prawdziwym modelu: ani razu nie odrzuciło ćwiczenia za słowo spoza materiału (jedyne odrzucenia słownikowe to elementy bez słowa treści: luka z samym „It's” w przebiegu 5 i element z samym „What's” w przebiegu 6), więc heurystyka odmiany i `FUNCTION_WORDS` nie były sprawdzone na żywo; rozdział oparty na słowach funkcyjnych (przyimki, can/can't) nie był próbowany (4.4, znane ograniczenia);
- jakość ćwiczeń poza próbkami: mało układanek na pulę (około 3), wybór bywa dwuopcyjny, pojedynczy dystraktor w parach bywa z innej kategorii.

### Stan Etapu 2 (2026-10-31)

**Zaimplementowane** (gałąź `claude/english-chapter-2-sources`, na bazie Etapu 1 (#192, `main`); plan `docs/superpowers/plans/2026-10-31-english-chapter-stage2-sources.md`):

- dane: tabela `source_materials` (z `revision` i `body_revision`), kolumny `decks.source_material_id` (FK `ON DELETE SET NULL`) i `decks.source_material_revision` (rewizja treści) z dwoma CHECK-ami, indeks częściowy, migracja `0030_source_materials.sql` (niewydana; przy scaleniu z `main` przenumerowana z `0029`, które zajęła rola `feedback_audio` z #194 — poprawki końcowego przeglądu weszły do niej na miejscu), `docs/schema.sql`;
- serwer (obszar `materials/`): `source-materials.ts` z `createSourceMaterial` (idempotencja po `clientRequestId` i `request_hash`), `updateSourceMaterial` (`expectedRevision`, `FOR UPDATE`, zapis bez zmian bez podbicia), `deleteSourceMaterial`, `listSourceMaterials`, `getSourceMaterial`, `lockSourceMaterialForCopy` (`FOR KEY SHARE` w transakcji tworzenia lekcji) i `readDeckSource`; ponowienie tworzenia lekcji po równoległym usunięciu źródła zwraca zestaw pierwszego żądania (`findEnqueuedRun`);
- kontrakty: `source-materials.ts` (z `bodyRevision` w `SourceMaterialDto`), `sourceMaterialId` z wymaganym `expectedSourceRevision` w `SchoolLessonCommandSchema` i `MaterialLessonCommandSchema` (dokładnie jedno z `material` / `sourceMaterialId`; konflikt nieaktualnego podglądu z `LessonSourceChangedDetailsSchema`), `LessonDeckDto.source` (`LessonDeckSourceDtoSchema`, wspólny typ serwera i panelu), `messages.sources`;
- Parent API: grupa oRPC `sources` (list, get, create 201/200, update, delete 204), sesja rodzica, kontrola Origin na mutacjach; bez Kid API i MCP;
- panel rodzica: zakładka „Źródła” (lista, nowe źródło, strona źródła z edycją, usuwaniem i listą zestawów), formularz nowej lekcji w trybie źródła (`/parent/lessons/new?source=…&subject=…`, „Wróć do źródła”, „Zmień źródło” → lista źródeł), notka „Ze źródła: …” i „Źródło zmieniono od utworzenia tego zestawu.” w edytorze lekcji; po końcowym przeglądzie: neutralne okno wyjścia i okno ponownego logowania nad oknami sekcji, odrzucanie szkicu nowego źródła z potwierdzeniem, przyciski lekcji tylko dla przedmiotów z katalogu, uwaga przy edycji źródła z zestawami i przy limicie 16 000 znaków, fokus po błędach i stały region na żywo, rząd zakładek mieszczący się od 600 px;
- prompt uzupełniania tekstu rozdziału: 2–3 krótkie zdania, całe `instructionPl` najwyżej 120 znaków (sekcja 4.3).

Opis architektury: `docs/architecture.md` §19.10 (blokady, idempotencja, wdrożenie, znane ograniczenia), produktu: SPEC §37 („Etap 2: źródła”).

**Odstępstwa od pierwszej wersji projektu:**

- DTO zestawu niesie `source { id, title, copiedRevision, currentRevision }` zamiast pól `sourceMaterialId` i `sourceMaterialRevision`, i to tylko dla lekcji (sekcja 7); odnośnik w zestawach słówek dochodzi w Etapie 4;
- dwie rewizje źródła zamiast jednej (3.1): `revision` dla kontroli współbieżności i `body_revision` dla wersji treści; `copiedRevision`, `currentRevision` i `stale` w kontraktach (nazwy bez zmian) dotyczą rewizji treści, więc zmiana samego tytułu nie daje notki „Źródło zmieniono…”; zapis bez zmian niczego nie podbija także po stronie serwera;
- formularz lekcji ze źródła pokazuje tytuł i podgląd tekstu tylko do odczytu oraz „Zmień źródło” (lista źródeł) zamiast zablokowanego pola (3.4), przycisk u góry wraca do strony źródła, a formularz oferuje wyłącznie przedmioty tworzone z materiału (`creation: "material"`); przyciski tworzenia na stronie źródła są tylko dla przedmiotów obecnych w katalogu;
- strona źródła wylicza także zestawy zarchiwizowane (stan `archived`), a liczba zestawów na liście i w nagłówku ich nie liczy; potwierdzenie usunięcia podaje liczbę wszystkich zestawów ze strony;
- przycisk „Utwórz zestaw słówek” nie istnieje (Etap 4).

**Zweryfikowane** (uruchomione podczas implementacji):

- na PostgreSQL (`tests/integration/source-materials.test.ts`, 51 testów po przeglądzie PR #193, kosz integracyjny 3): nieaktualna rewizja podglądu → `source_changed` bez zestawu (także dla tworzenia czekającego na edycję tekstu i przez Parent API), zgodna rewizja → zestaw z tą rewizją, ponowienie po edycji źródła (także w przeplocie z pierwszym żądaniem) → ten sam zestaw; idempotencja i konflikt tworzenia, równoległe tworzenie z tym samym `clientRequestId`, edycja z rewizją i dwie równoległe edycje tej samej rewizji, rewizja treści przy zmianie samego tytułu i tekstu, zapis bez zmian bez podbicia, deterministyczne ponowienie po równoległym usunięciu źródła, CHECK-i pochodzenia, usunięcie bez utraty zestawów (`source_material_id` = `NULL`, kopia tekstu zostaje, triggery `decks` nie przeszkadzają), kopia tekstu i rewizji do lekcji rozdziału i szkolnej, trzy deterministyczne przeploty usunięcie/tworzenie/edycja oraz pętla 12 wyścigów (mutacyjnie: bez `FOR KEY SHARE` cztery testy padają), pełny cykl przez handler Parent API (statusy, 401, 403 dla mutacji z obcego Origin, 400 dla złych ciał);
- jednostkowo: kontrakty, router oRPC (w tym CSRF dla trzech mutacji), trasy panelu, `sources-state`, markup listy, strony i formularza ze źródła, notka w edytorze, prompt uzupełniania tekstu;
- Playwright z zaślepionym API (`parent-sources-layout.spec.ts`): na czterech rozmiarach (320×640, 390×844, 768×1024, 1280×800) lista, nowe źródło, edycja tylko zmienionych pól z uwagą o istniejących zestawach, konflikt 409 i „Odśwież” z potwierdzeniem (fokus na „Odśwież”), region „Zapisano zmiany.”, usunięcie z liczbą zestawów, przyciski „Utwórz lekcję…”, „Wróć do źródła” / „Zmień źródło” i formularz ze źródła (żądanie z `sourceMaterialId` i `expectedSourceRevision` bez `material`), fokus po „Edytuj”, cele dotykowe ≥ 44 px bez przepełnienia poziomego; tylko na telefonie 390×844 przypadki brzegowe: ponowienie po niepewnym zapisie (ten sam `clientRequestId`, fokus na komunikacie), 404 z usuniętego źródła przy tworzeniu lekcji, zapisie i stronie z pamięci podręcznej, 409 ze źródła zmienionego po otwarciu formularza (odświeżony podgląd, komunikat, nowe polecenie z bieżącą rewizją), błąd zapisu (fokus), odrzucenie szkicu nowego źródła z potwierdzeniem, ochrona wyjścia przy edycji i szkicu (zakładka i „wstecz”), błędy wczytywania listy i strony, linki do nieistniejącego źródła, potwierdzenie usunięcia bez zestawów i limit 16 000 znaków; `parent-shell-layout.spec.ts` sprawdza pięć zakładek w dolnym pasku na 390, 360 i 320 px oraz w górnym rzędzie na 600×960, 640×360, 844×390, 768×1024 i 1280×800 (pasek bez przewijania, także z symulowanym klasycznym paskiem przewijania przy 600 px);
- Playwright na prawdziwej bazie i workerze z fałszywym LLM (`parent-sources.spec.ts`, kosz `real` 4): nowe źródło → lekcja ze źródła → notka w edytorze → publikacja lekcji (sekcja 8, dodana po końcowym przeglądzie) → edycja źródła → znacznik zmiany → usunięcie → opublikowana lekcja zostaje z pełną kopią tekstu; spec 3 razy z rzędu stabilny (także po końcowym przeglądzie, z krokiem publikacji), a pełny przebieg `pnpm test:e2e:shards` po końcowym przeglądzie (spec w koszu 4) zakończył się zielono: mocked 301, real 33/33/21/34.

**Niezweryfikowane:**

- pilotaż z rodzicem (czy zakładka „Źródła”, rozróżnienie źródło/zestaw i komunikaty o zmianie źródła są zrozumiałe);
- fizyczne urządzenia: układ sprawdzono wyłącznie w emulacji okna przeglądarki; górny rząd pięciu zakładek zmierzono przy 600, 640 i 768 px (klasyczny pasek przewijania tylko w symulacji), a przypadki brzegowe zakładki — tylko przy 390×844;
- skutek skróconego polecenia uzupełniania tekstu na prawdziwym modelu: zmieniono sam prompt (limit 120 znaków egzekwuje walidacja silnika), a próby `pnpm probe:chapter` po zmianie nie powtarzano;
- generowanie z prawdziwego modelu ze źródła jako wejścia (próba z Etapu 1 objęła tekst wklejony; ścieżka ze źródła używa tego samego generatora);
- jednoczesne wdrożenie: kolejność migracja `0030` → web i worker (oba używają wspólnego schematu; krok `migrate` w Compose ją wymusza) wynika z projektu, nie była ćwiczona na środowisku wdrożeniowym.

**Uwagi dla Etapu 4** (słówka ze źródła, sekcja 6; z końcowego przeglądu Etapu 2):

- `source-materials.ts` importuje dziś `deckStateOf` z `decks.ts`; zanim `decks.ts` (tworzenie zestawu słówek) zaimportuje kod źródeł, `deckStateOf` trzeba przenieść do osobnego pliku-liścia, żeby nie powstał cykl `decks.ts` ↔ `source-materials.ts`;
- w kontraktach `source-materials.ts` importuje `decks.ts` i `lessons.ts`; wspólny schemat odnośnika do źródła dla `GenerationCommand` i DTO zestawu słówek trzymać w niższym module (`decks.ts` albo `common.ts`), jak `LessonDeckSourceDtoSchema` w `lessons.ts`, bo import z `source-materials.ts` dałby cykl inicjalizacji stałych;
- `lockSourceMaterialForCopy` zwraca dziś `body` i `bodyRevision`; domyślny tytuł zestawu słówek z tytułu źródła (6.2) wymaga dołożenia `title` do tego samego zapytania (jedna wersja wiersza);
- `readDeckSource` robi jedno zapytanie na zestaw — przy odnośniku w DTO listy zestawów trzeba go pobrać zbiorczo dla całej listy (bez N+1).

### Stan Etapu 3 (2026-10-31)

**Zaimplementowane** (gałąź `claude/english-chapter-3-readback`, na bazie Etapu 2 po scaleniu `main` z odczytem zdania z #194; plan `docs/superpowers/plans/2026-10-31-english-chapter-stage3-readback.md`):

- przedmiot: `englishChapterSubject.ttsForFeedbackSentence = true`; mechanizm (rola `feedback_audio`, klucz zadania, `audio_issued`, Kid UI) pochodzi z #194, więc bez migracji i zmiany kontraktu (sekcja 5.1);
- domena (generycznie): `feedbackSentenceText` czyta `lesson_cloze` (`fillCloze(clozeText, gapAnswers)`, gdy liczba odpowiedzi równa się liczbie luk i żadna nie jest pusta), a źródło tekstu nagrania dostaje `clozeText` i `gapAnswers` (`feedbackSourceOf` w `media-reconciliation.ts`);
- silnik prób (generycznie): bramka wariantu w `withFeedbackSentenceAudio` — omówienie z `correctText` innym niż kanoniczny tekst rozwiązania (`correctTextFor`) nie dostaje nagrania ani pieczęci `audio_issued`; dotyczy też gramatyki (sekcja 5.2);
- Kid UI: zachowanie z #194 bez zmian; geometrię doku omówienia z „Posłuchaj zdania” przy uzupełnianiu tekstu z bankiem słów (dłuższy bodziec) mierzy mockowana specyfikacja Playwright `tests/e2e/lesson-sentence-audio.spec.ts` (360×800, 812×375, 740×420, 768×1024, 1280×800; poprawna i błędna odpowiedź; dok, materiał nad dokiem i pierwsza luka osiągalna przewinięciem materiału).

Opis architektury: `docs/architecture.md` §19.9, produktu: SPEC §37 („Etap 3: lektor po odpowiedzi”).

**Odstępstwa od projektu (wersja 2):** sekcja 5 przepisana na mechanizm z #194 (tabela w 5.3).

- własna flaga `ttsForFeedback`, własna migracja roli, wyszukiwanie nagrania przy ocenie i brak autoodtwarzania zastąpiono mechanizmem #194, scalonym przez właściciela przed Etapem 3 (flaga `ttsForFeedbackSentence`, migracja `0029`, nagranie zamrożone w kluczu zadania, autoodtwarzanie raz + „Posłuchaj zdania”);
- `lesson_order` czyta kanoniczną kolejność klocków (jak #194), a nie `answer`;
- reguła wariantu jest generyczna (bramka w `withFeedbackSentenceAudio`), a nie ograniczona do odpowiedzi otwartej — poprawia też tę samą niezgodność w gramatyce;
- `lesson_cloze` czytane generycznie: gramatyka nie ma tego typu, a szkoła ma flagę `false`, więc zmiana dotyczy dziś tylko rozdziału.

**Znane ograniczenia:**

- odpowiedź przyjęta jako wariant bez pokazanego `correctText` (`great`) dostaje nagranie zdania kanonicznego, którego dziecko mogło nie widzieć na ekranie (jak w #194; ekspozycja `targetKey` jest ta sama, więc kwalifikacja się nie zmienia). Bramka wariantu działa tylko wtedy, gdy omówienie pokazuje `correctText`;
- tekst dłuższy niż 200 znaków nie dostaje nagrania (`FEEDBACK_SENTENCE_MAX_LENGTH` w `feedback-sentence-text.ts`), a `clozeText` może mieć do 300 znaków (`MAX_CLOZE_TEXT_LENGTH` w kontraktach) — długi tekst z lukami po cichu zostaje bez odczytu;
- istniejący układ `ExerciseFrame` (sprzed Etapu 3, wspólny dla lekcji): przy wysokim materiale bank słów zostaje po błędnej odpowiedzi częściowo pod dokiem omówienia także po przewinięciu materiału do końca (360×800: ok. 43 px), a przy niskiej wysokości w poziomie nad dokiem zostaje pusty pas ukrytych akcji (materiał osiągalny przewinięciem strony). Wykryte testami geometrii Etapu 3, poprawka osobno.

**Zweryfikowane:** typecheck; testy jednostkowe 3205; integracja 65 plików / 692 testy (+2 pominięte) — w tym nowy `lesson-chapter-sentence-audio.test.ts`; E2E `test:e2e:shards`: mocked 322 + real 33/33/21/34, w tym `lesson-sentence-audio.spec.ts` z geometrią doku przy uzupełnianiu tekstu z bankiem słów (360×800, 812×375, 740×420, 768×1024, 1280×800).

**Niezweryfikowane:**

- wymowa lektora `en-GB` na fizycznym urządzeniu (głos syntetyczny; testy sprawdzają tekst nagrań i przepływ, nie brzmienie);
- autoodtwarzanie nagrania na fizycznym urządzeniu (polityka autoplay przeglądarek mobilnych; testy geometrii i przepływu to symulacja okna; przy zablokowanym autoodtwarzaniu zostaje „Posłuchaj zdania”);
- pilotaż z dzieckiem (czy odczyt zdania po odpowiedzi pomaga, a nie przeszkadza).

**Wdrożenie:** opublikowane lekcje rozdziału dostają nagrania po „Utwórz nową wersję” → „Publikuj” (jak w #194); API → MCP → skill bez zmian.

### Stan Etapu 4 (2026-10-31)

**Zaimplementowane** (gałąź `claude/english-chapter-4-source-vocab`, na bazie Etapu 3; plan `docs/superpowers/plans/2026-10-31-english-chapter-stage4-source-vocabulary.md`):

- kontrakty: `GenerationCommandSchema` z trybem źródła (`sourceMaterialId` + `expectedSourceRevision` + `instruction` ≤ 500, wzajemnie wykluczający z `prompt`, bez `locales`; `superRefine`), `DeckSourceDtoSchema` w `decks.ts` (alias `LessonDeckSourceDtoSchema`), `DeckDto.source`, `GenerationDto.rejectedCount`, `MAX_GENERATION_INSTRUCTION_LENGTH`, teksty panelu w `messages.ts`;
- domena (`subjects/english/`): `material-phrase.ts` (`materialPhraseIndex`, `phraseInMaterial`, `isSentenceFrame`, `isMaterialVocabularyTarget`), `inflection.ts` (`stemsOf` przeniesione z `english-chapter/lexicon.ts` bez zmiany zachowania; `formsOf` jest nowe — wydzielone z dotychczasowego `inLexicon`) i `function-words.ts` (`FUNCTION_WORDS`, `withoutLeading`);
- dane: kolumna `generation_runs.rejected_count` z CHECK `>= 0`, migracja `0031_generation_rejected_count.sql`, `docs/schema.sql`;
- serwer (obszar `materials/`): `enqueueDeckGeneration` w trybie źródła (kopia tekstu przez `lockSourceMaterialForCopy` — teraz z tytułem — w transakcji tworzenia, odnośnik `decks.source_material_id/revision`, input runu `mode: "material"`), wspólny `committedRetryAfterSourceChange` w `source-materials.ts` dla lekcji i słówek, `deckStateOf` w pliku-liściu `deck-state.ts`, `markRunSucceeded` i `markRunWithoutSourceItems` w `generation-runs.ts`; worker: walidacja per element (`selectMaterialItems`: schemat, ramy z lukami, fraza z tekstu przez przejście po grafie zbiorem pozycji frontowych o ograniczonym koszcie, format zestawu, duplikaty także po kluczu dopasowania), zapis przyjętych elementów w ujednoliconej postaci, `no_source_items`, `rejected_count`;
- providerzy: prompt trybu materiału w adapterze OpenAI (tekst ogrodzony jak w lekcjach, notatka rodzica poza ogrodzeniem „treat as material” i tylko zawęża; model ma pomijać końcową interpunkcję; tryb opisu bez zmian), fałszywy LLM z domyślnymi słowami z tekstu;
- panel rodzica: „Utwórz zestaw słówek” na stronie źródła, trasa `/parent/vocabulary/new?source=<uuid>`, formularz `NewVocabularyFromSource.tsx` (409 z odświeżeniem podglądu, 404, niepewny zapis z ponowieniem tym samym poleceniem), wspólne `sources/source-refresh.ts` dla formularzy lekcji i słówek, notka „Ze źródła” w edytorze zestawu słówek, liczba pominiętych pozycji i komunikat `no_source_items` z odnośnikiem „Przejdź do źródła”.

Opis architektury: `docs/architecture.md` §19.10 („Słówka ze źródła”), produktu: SPEC §37 („Etap 4: słówka ze źródła”).

**Ustalenia i odstępstwa od projektu** (sekcja 6.2, „Ustalenia implementacji”):

- stała para języków `pl-PL` → `en-GB` (projekt jej nie określał; `locales` przy źródle są błędem walidacji);
- domyślnie 20 słówek w formularzu (projekt: tylko „≤ `MAX_DECK_ITEMS`”); serwer bez `maxItems` w poleceniu nadal przyjmuje 50;
- kod porażki `no_source_items` dla zera przyjętych elementów (projekt: „błąd generowania”);
- liczba odrzuceń w nowej kolumnie `generation_runs.rejected_count` (migracja `0031`) zamiast w inpucie runu albo wersji — input to niezmienne żądanie, a wersja słówek nie ma `lesson_context`;
- `DeckSummaryDto` (lista zestawów) bez odnośnika do źródła — strona źródła wymienia swoje zestawy, więc bez zbiorczego `readDeckSource` (uwaga z końcowego przeglądu Etapu 2 przestała być potrzebna);
- reguła „słówko z tekstu” bez wymogu słowa treści: słowa funkcyjne i zwroty stojące w tekście („today”, „yes”, „How are you?”) są przyjmowane, odpada tylko element z samych wiodących `a`/`an`/`the`/`to` i rama z luką (pierwsza wersja implementacji wymagała słowa treści jak lekcja w 4.4 i odrzucała prawdziwe słówka rozdziału);
- sprawdzanie kończy się po przyjęciu `maxItems` elementów, więc elementy dalej w odpowiedzi modelu nie są liczone jako odrzucone;
- tytuł z samych białych znaków daje tytuł źródła także po stronie serwera, a zawężenie z samych białych znaków jest pomijane;
- przyjęte `target` i `acceptedAnswers` są zapisywane w ujednoliconej postaci: typograficzne apostrofy zamienione na `'`, białe znaki zwinięte, końcowa interpunkcja zdania (`.!?…,;:`) usunięta; prompt każe modelowi pomijać końcową interpunkcję (projekt zapisu nie określał; poprawka z końcowej fali Etapu 4);
- duplikat rozpoznaje także klucz dopasowania (tokeny po pominięciu wiodących `a`/`an`/`the`/`to`, bez interpunkcji): „the coat” po „coat” jest odrzucone i liczone w `rejectedCount`;
- dopasowanie frazy przechodzi graf tekstu zbiorem pozycji frontowych zamiast rekurencji po wszystkich ścieżkach, z szybkim odrzuceniem przy braku tokenu albo sąsiedniej pary form w tekście; praca rośnie z liczbą wariantów skrótów elementu (do 32), jego długością i liczbą krawędzi tekstu — bez wykładniczego wzrostu (test: 16 000 znaków „it's” i 300 złośliwych elementów w ok. 73 ms), choć celowo spreparowany tekst z wynikiem modelu może nadal zająć workerowi kilkanaście sekund;
- w trybie materiału zawężenie rodzica (PARENT NOTE) stoi poza ogrodzeniem „treat as material” — jest poleceniem rodzica, które tylko zawęża wybór, a nie materiałem;
- komunikat `no_source_items` brzmi „Nie znaleziono w tekście źródła słówek do zestawu. Ponów generowanie albo utwórz nowy zestaw ze źródła z innym zawężeniem lub w rodzaju standardowym.” i ma odnośnik „Przejdź do źródła”, gdy zestaw ma źródło — ponowienie powtarza zamrożone polecenie (to samo zawężenie i rodzaj), więc inne zawężenie wymaga nowego zestawu ze źródła (pierwsza wersja brzmiała „… Zmień zawężenie albo spróbuj ponownie.”).

**Znane ograniczenia:**

- kolizje rdzeni prostej odmiany odziedziczone po `stemsOf` (4.4): „seed” pasuje do „see”, „hated” do „hat”;
- fraza może przekraczać interpunkcję (dopasowanie po tokenach): „red apples” pasuje do „I like red. Apples are sweet.”;
- zawężenia pilnuje tylko model — serwer sprawdza obecność w tekście, nie zgodność z zawężeniem;
- `acceptedAnswers` i `example` nie są porównywane z tekstem;
- rozwijane są tylko skróty z zamkniętej tabeli `packages/server/src/domain/lessons/subjects/english/contractions.ts` (m.in. „it's”, „that's”, „I'm”, „don't”); „what's”, „there's”, „let's” w niej nie ma, więc „what” nie zostanie znalezione w „What's the weather like?” i taka pozycja zostanie odrzucona, choć słowo stoi w tekście (błąd w stronę pominięcia, nie wpuszczenia słowa spoza tekstu);
- skoro słowa funkcyjne są dozwolone, przechodzą też sztuczne kombinacje obecne w tekście, np. „in on” z „Put it in on the shelf.”;
- dziecko wpisujące typograficzny apostrof („It’s”) przy celu ze zwykłym („It's”) dostaje błąd — `normalizeTargetText` (`domain/target-key.ts`) nie ujednolica apostrofów; to wcześniejsze ograniczenie oceny słówek, nie zmiana Etapu 4. Tak samo ścisła jest końcowa interpunkcja: cel zapisany bez kropki (Etap 4 usuwa ją przy zapisie) nie przyjmie odpowiedzi „it's raining.” wpisanej z kropką — jak każde słówko bez interpunkcji w trybie z opisu.

Dla pierwszych sześciu rodzic sprawdza szkic przed publikacją, więc te przypadki widzi i może poprawić.

Bez zmian w Etapie 4 zostaje asymetria wspólnych kluczy ekspozycji lekcji i słówek (4.5): zestaw słówek i lekcja rozdziału z tego samego źródła częściej mają ten sam tekst (zwrot „It's raining” jako słówko i odpowiedź tłumaczenia), więc ekspozycja słówka może trwale odebrać samodzielność takiemu tłumaczeniu. Etap nie dodał tu osobnej reguły; skutek w nauce nie był mierzony.

**Zweryfikowane:** typecheck; testy jednostkowe 3399; integracja 66 plików / 725 testów (+2 pominięte) — w tym `source-vocabulary.test.ts` (tworzenie z kopią tekstu, 409 przy nieaktualnej wersji, ponowienia po edycji i usunięciu źródła, przeplatanie z usuwaniem, walidacja per element, `no_source_items`, `maxItems`, zapis celu bez końcowej interpunkcji, duplikaty po kluczu dopasowania); E2E `test:e2e:shards`: real 33/33/21/35 (w tym przebieg źródło → zestaw słówek → edytor w `parent-sources.spec.ts`) i mocked 337 (w tym `parent-source-vocabulary-layout.spec.ts` na 320×640, 390×844, 768×1024, 1280×800) — jeden test animacji Kid UI (`kid-motion.spec.ts`, kod poza zakresem etapu) padł pod obciążeniem równoległym, a osobno przeszedł 6/6.

**Niezweryfikowane:**

- prawdziwy model na prawdziwym rozdziale (dobór słów i zwrotów, liczba pominiętych pozycji, posłuszeństwo zawężeniu, format obrazkowy) — testy używają fałszywego LLM, który wypisuje słowa z tekstu, oraz kolejki zachowań;
- pilotaż z rodzicem i dzieckiem (czy formularz, zawężenie i liczba pominiętych pozycji są zrozumiałe);
- fizyczne urządzenia: układ formularza i edytora sprawdzono wyłącznie w emulacji okna przeglądarki;
- kolejność wdrożenia (migracja `0031` w kroku `migrate` Compose, potem web i worker) nie była ćwiczona na prawdziwym wdrożeniu, a stary worker nie rozpozna runu `mode: "material"` (architektura §14 i §19.10).

**Wdrożenie:** migracja `0031` przed nowym webem i workerem (addytywna kolumna `NULL`; stary kod działa na nowym schemacie, nowy na starym — nie); worker razem z webem albo przed nim, bo stary worker nie rozpozna runu `mode: "material"`; otwartą kartę panelu trzeba odświeżyć. API → MCP → skill bez zmian: `learning-overview` filtruje do `kind = 'vocabulary'`, więc zestaw ze źródła trafia do raportu jak każdy zestaw słówek, ze znaczeniem danych bez zmian, a raport nie używa `GenerationCommand`, `GenerationDto` ani DTO zestawu.

## 11. Poza zakresem

- Rozsypane litery i brakujący element ciągu — [lookassh/knowli#185](https://github.com/lookassh/knowli/issues/185).
- Zadania z obrazkami — [lookassh/knowli#186](https://github.com/lookassh/knowli/issues/186).
- „Posłuchaj pytania” przed odpowiedzią w lekcji rozdziału, odpowiedzi mówione, lekcja gramatyki ze źródła, wersjonowanie źródła, upload i OCR.
- Naprawione poza Etapem 3: `audio_issued` dla poprawnej opcji obrazkowej (`picture_recognition`) był pieczętowany z czasem `receivedAt` (`attempts.ts:726`) — poprawka w issue #187 / PR #189 (`occurredAt` po `receivedAt`, wspólny helper `sealPostAnswerAudio`, z którego korzysta też odczyt zdania w lekcjach).

## 12. Dziennik przeglądu (wersja 2)

Przegląd trzech niezależnych krytyków (architektura i silnik; dane, ujawnienia i media; produkt i wykonalność), z twierdzeniami potwierdzonymi w kodzie. Zmiany względem wersji 1:

- **Blokada:**
  - Walidacja słownikowa przez `validatePoolExtra` włączała wymóg cytatów `sourceRefs`, a przedmiot bez v3 je odrzuca, więc każde ćwiczenie zostałoby odrzucone. Teraz decyduje o tym jawna opcja `sourceQuotes`, a walidacja słownikowa działa w `refineGeneratedPool` (tylko generacja).
- **Bodziec znaczenia:**
  - Przeniesiony z `hint` do `instructionPl`, bo kartkówka usuwa `hint`, a deduplikacja pomijała polecenie.
  - Doszła opcja `instructionIsStimulus`.
- **Samodzielność:**
  - Jawna decyzja, że ekspozycją jest rozwiązane zdanie (`exposureText`).
  - Wersja 1 liczyła ją po słowie, co blokowało luki po każdym wyborze i po słówkach, a nagranie w omówieniu ujawniało zdanie bez ekspozycji.
- **Lektor:**
  - Wszystkie trzy ścieżki finalizacji.
  - `audio_issued` z czasem `clock.now()`.
  - `supersedeDisabledLessonTts` i ponowienia nieudanych nagrań.
  - Przypadek `stem` bez luki.
  - Zgodność nagrania tłumaczenia z pokazanym wariantem.
- **Pula:**
  - 3–5 zagadnień z rodzajem `words`/`frame` i typami według rodzaju.
  - Minima 3/3/2.
  - Powody odrzuceń widoczne dla rodzica.
  - Warianty spoza materiału usuwane zamiast odrzucania ćwiczenia.
  - Rodzic nie jest ograniczany słownikiem.
- **Prompty:** opisy typów match/group/cloze przeniesione z adaptera do profilu przedmiotu, a `objectivesRules` dochodzi do portu.
- **Formularz i identyfikatory:** jawne `creation` w katalogu przedmiotów, prefiks identyfikatora zagadnienia z identyfikatora przedmiotu.
- **Języki:** `contentLocale` ustawiane generycznie z `answerLocale`, osobny `answerLocale` pola odpowiedzi.
- **Źródła:**
  - `client_request_id` z `request_hash`;
  - `FOR KEY SHARE` przy tworzeniu;
  - rewizja źródła w zestawie;
  - jawne różnice kopii dla lekcji i słówek.
- **Słówka ze źródła:**
  - pole `instruction`, tytuł ze źródła;
  - walidacja per element zamiast wszystko-albo-nic;
  - dopasowanie z rodzajnikami, skrótami i odmianą.
- **Drobne:**
  - limit odpowiedzi 120 zamiast 200;
  - semantyka `almost`;
  - jedna poprawna kolejność klocków bez powtórzeń;
  - normalizator w `subjects/english/`;
  - odwołanie do §22 architektury.
- **Kolejność etapów:** lekcja rozdziału pierwsza (z próbą na prawdziwym modelu), źródła drugie — potwierdzone przez właściciela.

Wersja 2 zaakceptowana przez właściciela 2026-10-30.
