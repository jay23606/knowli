# „Posłuchaj i wybierz” — brakująca forma ze słuchu (`lesson_listen_choice`) — design

Data: 2026-11-01. Status: zaimplementowany (wersja 3 — po dwóch rundach recenzji trzech krytyków; ustalenia z implementacji w sekcji „Ustalenia z implementacji” na końcu).
Issue: lookassh/knowli#198. Powiązane: `docs/superpowers/specs/2026-10-30-lesson-sentence-readback-design.md`
(#194, nagranie `feedback_audio`), `.kiro/specs/grammar-module/requirements.md` (wym. 2.13, 4.1, 4.3, 4.6,
5.2–5.6, 7.2–7.5), `docs/superpowers/specs/2026-10-30-english-chapter-design.md`, `docs/SPEC.md` §22.

## 1. Cel

Dziecko **słyszy** pełne zdanie po angielsku (lektor en-GB), widzi to samo zdanie z luką
i **wybiera** brakującą formę z 2–4 opcji. Ćwiczy słyszenie końcówek i skrótów
(`-s`, `doesn't`, `isn't`), czego samo czytanie nie daje.

Ustalenia z właścicielem (2026-11-01):

- odpowiedź **wyborem z opcji** (bez wpisywania) — rozróżnianie form ze słuchu bez bariery
  pisowni skrótów;
- **osobny typ ćwiczenia** `lesson_listen_choice`, generowany, walidowany i edytowany jak
  własne ćwiczenie (podejście A; odrzucone: wariant w czasie sesji z `lesson_choice`
  i flaga w payloadzie `lesson_choice`);
- przedmioty: **`english_grammar` i `english_chapter`**; przedmioty szkolne bez zmian.

## 2. Zakres

W zakresie: kontrakty, domena (walidacja, tożsamość, ekspozycja, selektor), generator
(port, prompty, fake provider), media (to samo nagranie co #194), sesja (wydanie, autoryzacja
odsłuchu, ocena, feedback), edytor rodzica (z odsłuchem i stanem nagrania ćwiczenia
słuchowego), widok Kid UI, dokumentacja.

Poza zakresem:

- wariant z wpisywaniem formy (możliwy później jako osobny typ);
- ukrywanie tekstu zdania (czyste dyktando);
- wolniejsze odtwarzanie;
- automatyczne dogenerowanie ćwiczeń słuchowych do już opublikowanych lekcji (rodzic
  dogenerowuje regułę i publikuje nową wersję, jak przy #174/#194);
- nagranie przy odpowiedzi rodzica w kartkówce (typ nie występuje w kartkówce).

## 3. Model zadania (decyzje wobec wym. 4.6, 5.x i 7.x)

### 3.1 Nagranie jako bodziec

- Nagranie jest bodźcem, ale zawiera rozwiązanie, więc obowiązuje zasada wym. 4.6 (zmienionej
  w §10, by objęła ten typ zamknięty): serwer zapisuje i pieczętuje ekspozycję (`audio_issued`)
  **przed** wydaniem nagrania, a próba jest wspomagana (`model_audio`).
- Typ jest **zawsze wspomagany** także bez odsłuchu (opcje → `assistance: options`, jak
  `lesson_choice`), **nigdy** nie jest samodzielnym sprawdzeniem (`independentCheck = false`)
  i nie liczy się do opanowania reguły (wym. 7.2–7.3; projekcja pomija próby wspomagane).
- **Bez odsłuchu nie ma oceny.** Odpowiedź, przed której `receivedAt` nie ma zapieczętowanego
  `audio_issued` w tym zadaniu, serwer zapisuje jako nieocenioną (`unevaluated`, werdykt
  `no_stimulus`, feedback `not_assessed`) — bez kary, bez wsparcia i bez historii trudności.
  Jak każda nieoceniona odpowiedź zostawia zadanie `issued` (można ponowić); Kid UI przy
  ponowieniu nadal trzyma opcje zablokowane do odsłuchu. Kid UI i tak nie pozwala odpowiedzieć
  przed odsłuchem (§8); reguła serwera jest zabezpieczeniem. Werdykt `no_stimulus` jest
  wewnętrzny (szczegóły próby), nie trafia do kontraktów.

### 3.2 Miejsce w sesji: dodatkowy slot ćwiczenia słuchowego, poza ścieżką etapów

Typ **nie** należy do pul etapów selektora (jak `lesson_keywords`): `pickExercise` go nie wybiera,
więc nie zajmuje rzadkich slotów guided, nie wprowadza reguły (priorytet 5, `introduce`) i nie
jest ćwiczeniem cyklu wsparcia (wym. 5.5 — „łatwiejsze ćwiczenie reguły” pozostaje zwykłym guided).
`STAGE_BY_TYPE` mapuje go na `guided` wyłącznie dla kompletności mapy i etykiet. Każde miejsce,
które rozgałęzia się po `stageOf()` (pule `pickExercise`, limit planowanych zadań etapu,
`hasAssessedThisSession`, `buildSessionState`, `initialStatus` z pierwszego zadania, plan
kartkówki, `poolCoverage`, pokrycie katalogu, grupowanie w edytorze), korzysta z **jednego
wspólnego predykatu** `outsideStagePath(type)` (`lesson_listen_choice` i `lesson_keywords`),
zamiast powielać listy typów; predykat ma własny test.

Nowy priorytet selektora `listenPracticePlan` (wzorem `precisionPracticePlan`), przed
„kontynuacją celu” (priorytet 4):

- cel ma w tej sesji co najmniej jedno **zwykłe** (nie słuchowe) ocenione zadanie wydane lub
  zaplanowane (`hasAssessedThisSession` bez typów spoza ścieżki etapów) — dotyczy też celów
  kontynuowanych i opanowanych: same z siebie nie dostają slotu na początku sesji, więc sesja
  nie zaczyna się serią zadań słuchowych;
- w tej sesji cel nie miał jeszcze zadania słuchowego (**najwyżej 1 na cel na sesję**) i sesja
  ma ich mniej niż **2** (limit sesji — zadania słuchowe nie wypierają ćwiczeń produktywnych);
- cel nie czeka na ćwiczenie cyklu wsparcia (`pendingSupportExercise` ma pierwszeństwo);
- jest kandydat `lesson_listen_choice` tego celu z **gotowym nagraniem** (§7.1), wybierany jak
  inne: niewidziany albo widziany najdawniej;
- zostaje budżet ocenianych zadań (zadanie słuchowe jest oceniane i liczy się do budżetu 12;
  zasada „Jeszcze 3” bez zmian — nie dokładamy ponad obiecany budżet);
- powód zadania: nowy `LessonTaskReason` `listen_practice`.

Okno sprawdzianu i należne sprawdzenia mają pierwszeństwo przed slotem słuchowym (priorytety
1–3 bez zmian).

### 3.3 Skutki odpowiedzi

- **Ścieżka etapów:** wynik zadania słuchowego jest **neutralny** dla `stage`/`stageStreak`
  (`buildSessionState` pomija typ jak `lesson_notice`); limit planowanych zadań etapu go nie liczy.
- **Wsparcie:** błędna odpowiedź **nie** otwiera cyklu wsparcia (pomyłka słuchu nie jest
  trudnością reguły w sensie wym. 5.5). Zapytanie `historicalSupportObjectives` (ostatnia
  zakończona próba celu) **pomija zadania słuchowe całkowicie**, niezależnie od wyniku — także
  poprawna odpowiedź słuchowa nie „przykrywa” wcześniejszego prawdziwego błędu reguły.
- **Stare sesje dynamiczne** (bez `initialObjectiveProgress`): `initialStatus` z pierwszego zadania
  celu pomija typy spoza ścieżki etapów, więc zadanie słuchowe nie oznacza celu jako nowego.
- **Historia i rodzic:** próba zostaje w historii z rzeczywistym wynikiem (`correct`/`incorrect`),
  widoczna w nadzorze rodzica; projekcja opanowania jej nie liczy (wspomagana).
- **Feedback dziecka:** jak dla wyboru — „Świetnie!” albo poprawna odpowiedź; po odpowiedzi
  odczyt zdania (#194).

### 3.4 Ekspozycja

- Przy wydaniu zadania (jak `lesson_choice`) i przy każdej autoryzacji odsłuchu zadanie
  ujawnia **dwa klucze**: `target_key` ćwiczenia oraz klucz pełnego zdania
  `lessonTextTargetKey(subject, feedbackSentenceText(...))` (bez duplikatu, gdy są równe — np.
  w rozdziale). Dzięki temu ćwiczenie samodzielne, którego odpowiedzią jest to samo zdanie
  (np. tłumaczenie w gramatyce), nie zakwalifikuje się już jako „niewidziane”. Klucz liczy
  `computeTargetKey` (NFC, przycięcie, małe litery), więc nie łapie wariantów różniących się
  interpunkcją albo rozwinięciem skrótu — dlatego dodatkowo **walidacja puli** odrzuca ćwiczenie
  słuchowe, którego zdanie jest równoważne (`answersEquivalent` po normalizatorze przedmiotu)
  odpowiedzi któregokolwiek `lesson_open_answer`, `lesson_transform` albo `lesson_error_fix`
  tej samej lekcji.
- Ochrona należnych samodzielnych sprawdzeń działa jak dla wyboru: `targetKey` zadania wchodzi
  do zbioru celów wydanych w sesji.
- **Kartkówka:** typ jest wykluczony z planu kartkówki wyłącznie w `domain/lessons/mock-test-plan.ts`
  (`outsideStagePath`); `lesson-mock-tests.ts` obsługuje typ tylko w `promptText` omówienia.
  Autoryzacja odsłuchu tego typu w `mock_test` jest odrzucana.

## 4. Payload i walidacja

Payload rewizji (`LessonExerciseInputSchema`) jak `lesson_choice` bez piktogramu:

| Pole | Reguła |
| --- | --- |
| `stem` | zdanie w języku odpowiedzi z dokładnie jedną luką — ciągiem **2+ podkreśleń** (ta sama definicja co `feedbackSentenceText` i Kid UI `splitGap`) |
| `options` | 2–4 opcje `{id, text}`, niepuste, **żadna nie zaczyna się od apostrofu** (skróty tylko jako całe tokeny, np. `isn't`, `doesn't`, `she's` z podmiotem w luce) |
| `correctOption` | id jednej z opcji |
| `answer` | tekst poprawnej opcji (jak `lesson_choice`) |
| `acceptedAnswers`, `focus` | jak `lesson_choice` |
| `instructionPl`, `visualSubject`, `hint` | **niedozwolone** w edycji rodzica i publikacji; polecenie dla dziecka jest stałe z katalogu komunikatów |

Walidacja puli (`pool-validation.ts`, obowiązuje przy generacji, edycji i publikacji):

- dokładnie jedna luka; zdanie z wstawioną poprawną opcją (`feedbackSentenceText`) istnieje
  i ma ≤ 200 znaków — inaczej nagranie nigdy nie powstanie;
- **opcje nierównoważne na poziomie zdania**: dla każdej pary opcji zdania z wstawionymi
  opcjami nie mogą być równoważne po normalizatorze przedmiotu (`answersEquivalent`) — np.
  `doesn't`/`does not`, `they're`/`they are` to ta sama odpowiedź, więc zadanie byłoby dwuznaczne;
- typ musi być na liście przedmiotu i celu.

Walidacja katalogu i przedmiotu (`catalog-validation.ts`):

- przedmiot, którego `exerciseTypes` zawiera typ, musi mieć `ttsForFeedbackSentence = true`
  (sprawdzane w `validateSubject` na liście przedmiotu — działa też dla tematów dynamicznych
  rozdziału);
- pokrycie etapu guided celu wymaga typu guided **innego** niż `lesson_listen_choice`
  (analogicznie do wykluczenia `lesson_keywords` w `poolCoverage`).

Walidatory przedmiotów (zakres faktyczny):

- gramatyka: istniejące kontrole odpowiedzi wyboru (dziś: forma odpowiedzi dla „to be”) obejmują
  też ten typ; brak nowej kontroli dystraktorów — błędne przy czytaniu nie muszą być, bo dziecko
  odpowiada po odsłuchu;
- rozdział: kontrola jednej luki i elementów sprawdzanych z materiału (`checkedElements`) jak dla
  `lesson_choice`; typ **nie** należy do `STIMULUS_IN_INSTRUCTION` ani `VARIANT_TYPES`;
  `refineChapterPool` obejmuje typ.

**Tożsamość** (`exercise-identity.ts`): `[objectiveId, "lesson_listen_choice", [znormalizowany stem,
znormalizowane pełne zdanie]]` (to, co dziecko widzi i słyszy). Typ nie należy do
`INSTRUCTION_STIMULUS_TYPES`. Ta sama rama z różnymi słowami („I can see a cat/dog.”) to dwa
ćwiczenia; to samo zdanie z luką w innym miejscu też; ten sam stem jako `lesson_choice` i jako
`lesson_listen_choice` też.

**`target_key`:** gramatyka — `answer` (jak wybór); rozdział — `chapterExposureText` wypełnia
stem poprawną opcją (jak wybór). Dodatkowy klucz zdania — §3.4.

**Minima publikacji** (`poolCoverage`): typ się **nie liczy** (jak `lesson_keywords`) — ćwiczenia
słuchowe mogą być niewydawalne bez nagrania i nie zastępują zwykłych ćwiczeń. Lekcja bez nich
publikuje się jak dziś.

## 5. Generacja

- **Port** (`LessonPoolInput`, `ports/ai.ts`): nowe pole `listenChoicePerObjective` (0–2). Serwer
  ustawia 2 dla celów, którym typ jest dozwolony i gdy przedmiot ma `ttsForFeedbackSentence`,
  inaczej 0. Limit w prompcie: „at most `countPerObjective + listenChoicePerObjective`
  exercises per objective”; zdanie promptu wyjaśnia, że ćwiczenia słuchowe są **dodatkiem** poza
  podziałem etapów. **Wielkość puli wybrana przez rodzica (wym. 2.1) dotyczy ćwiczeń etapów;
  ćwiczenia słuchowe są dodatkiem ≤ 2 na cel** — opis w panelu tworzenia lekcji.
- Typ **nie** wchodzi do menu etapów (`guided/productive/independent`). Opis pól typu w
  `llm.ts` (lista reguł pól per typ): `stem` z jedną luką `___`, `options` 2–3, `correctOption`,
  `answer`, `focus`; bez `instructionPl`, `hint`, `visualSubject`. Schemat puli
  (`lesson-pool-schema.ts`) dostaje typ w zwykłej gałęzi.
- **Czyszczenie świeżego wyjścia modelu** (generyczne dla typu, przed walidacją): z ćwiczenia
  `lesson_listen_choice` usuwamy `instructionPl`, `hint` i `visualSubject` zamiast odrzucać
  całe ćwiczenie. Edycja rodzica i publikacja nadal odrzucają te pola.
- Reguły typu w profilach promptów (`english-grammar/prompts.ts`, `english-chapter/prompts.ts`):
  krótkie naturalne zdanie (≤ 12 słów), jedna luka na elemencie sprawdzanym reguły, 2–3 opcje
  różniące się **słyszalnie** w elemencie sprawdzanym (np. `play`/`plays`, `don't`/`doesn't`,
  `is`/`are`, `isn't`/`aren't`), bez opcji równoważnych (pełna forma i skrót tej samej formy),
  bez opcji zaczynających się od apostrofu.
- **Katalog gramatyki:** typ dochodzi do `ALL_EXERCISE_TYPES` i do `exerciseTypes` celów
  z formą słyszalną: Present Simple — forma podstawowa, `-s` w 3. os., przeczenie
  `don't/doesn't`, pytanie `Do/Does`; „to be” — formy `am/is/are`, przeczenie. Cele pisowni
  (`-es/-ies`) i krótkich odpowiedzi — bez typu (dokładna lista w planie, opisana w katalogu).
  Wersja tematów **nie** rośnie: lista typów nie zmienia znaczenia reguł (wym. 1.6), a
  `topicVersion` wchodzi do skrótu kryteriów oceny, więc podbicie podzieliłoby wersje umiejętności.
- **Rozdział:** typ w `CHAPTER_EXERCISE_TYPES` i w obu rodzajach zagadnień (`words`, `frame`).
- **Fake provider** (`providers/fake.ts`) honoruje `listenChoicePerObjective` i generuje ćwiczenie
  słuchowe dla testów i trybu dev.

## 6. Media

- **Bez nowej roli i migracji.** `feedbackSentenceText` dostaje `case "lesson_listen_choice"`
  jak `lesson_choice` (stem z wstawioną poprawną opcją). Uzgadnianie mediów planuje więc to samo
  nagranie `feedback_audio` (en-GB, bez stylu). Jedno nagranie jest bodźcem przed odpowiedzią
  i odczytem po niej. Zasoby są współdzielone po fingerprincie i niezmienne po `ready`.
- Publikacja **nie czeka** na nagranie (jak #194). Brak gotowego nagrania = zadanie słuchowe nie
  jest wydawane (§7.1).
- **Trwała awaria po publikacji:** opublikowana wersja nie jest uzgadniana ponownie, a zasób po
  wyczerpaniu automatycznych prób zostaje `failed`. Naprawa: rodzic tworzy nową wersję
  (szkic uzgadnia media i ponawia nieudane `feedback_audio`, jak w #194) i ją publikuje.
  Gotowe nagranie o tym samym fingerprincie (np. z innego szkicu) „ożywia” też opublikowane
  ćwiczenie — `loadExercises` bierze najnowszy gotowy zasób o oczekiwanym fingerprincie.
- **Widoczność dla rodzica:** dla ćwiczeń `lesson_listen_choice` (i tylko dla nich) DTO ćwiczenia
  szkicu i wersji dostaje **nowe pole** `sentenceAudio` (`{ state: pending | ready | failed,
  assetId?, previousAssetId? }` jak nagranie pytania: `assetId` przy `ready`, `previousAssetId` —
  najnowsze gotowe ujęcie — przy `pending` i `failed`) — nie przeciążamy `promptAudio` („Nagranie pytania”). Edytor pokazuje je
  w istniejącej odznace audio karty ćwiczenia (`LessonExerciseCard`) i pozycji „Posłuchaj”
  w menu ćwiczenia; **bez** `PromptAudioControls` (jego regeneracja i ton dotyczą `prompt_audio`)
  i bez przycisku regeneracji. Przy stanie `failed` obok odznaki dalszy krok: „Nagranie się
  nie udało. Utwórz nową wersję lekcji, aby spróbować ponownie.” (w szkicu edycja ćwiczenia
  ponawia nagranie). Na karcie lekcji: liczba ćwiczeń słuchowych bez gotowego nagrania. Dla
  pozostałych typów `feedback_audio` pozostaje ukryte (bez zmian). Pole i licznik to zmiana
  kontraktu panelu rodzica (bez wpływu na MCP) — opis w PR.

## 7. Sesja (serwer)

Właściciel reguł: `learning/lessons` (selektor, materializacja, próby), `learning/events.ts`
(autoryzacja odsłuchu); media: `materials`. Granice transakcji bez zmian — wydanie zadania,
autoryzacja odsłuchu i finalizacja próby mają własne istniejące transakcje.

### 7.1 Gotowość nagrania — jedna reguła, domyślnie „niegotowe”

- Jeden helper `listenStimulusAssetId(exercise, subject, mode)` (moduł `learning/lessons`) zwraca
  id gotowego nagrania bodźca albo `null`: wymaga `subject.ttsForFeedbackSentence`, trybu treningu
  (nie kartkówki) i rozwiązanego `feedbackAudioAssetId`. Używają go **i** powłoka selektora,
  **i** materializacja.
- Kandydat selektora: `stimulusAudioReady?: boolean`; **brak wartości = niegotowe** (fail closed).
  Reguła w czystym `scheduler.ts`: `listenPracticePlan` bierze wyłącznie kandydatów z
  `stimulusAudioReady === true`.
- Gotowość jest oceniana przy budowie planu sesji treningowej (`createLessonTrainingSessionPlan`)
  i przy wydawaniu kolejnych zadań. Gotowy zasób nie przestaje być gotowy (niezmienność), więc
  zaplanowany slot pozostaje ważny. Materializacja bez nagrania to naruszenie niezmiennika:
  `AppError("internal")` jako asercja (nie zwykła ścieżka).

### 7.2 Materializacja

Prompt dziecka (`TaskPromptSchema`, gałąź `.strict()`):
`{ kind: "lesson_listen_choice", stem, options, contentLocale }` — nazwy pól jak `lesson_choice`;
**bez** `instructionPl` (polecenie z katalogu komunikatów w Kid UI) i **bez** identyfikatora
nagrania. Opcje tasowane jak w wyborze. Klucz prywatny: jak `lesson_choice` plus
`feedbackAudioAssetId` (wymagany) i `sentenceTargetKey` (§3.4).

### 7.3 Autoryzacja odsłuchu

`authorizeDisclosure` (`kind: "audio"`) dostaje gałąź dla `lesson_listen_choice`, umieszczoną
**przed** obecną odmową dla typów nietekstowych i bramką `ttsForAnswers`:

- odmowa (409), gdy sesja nie jest aktywna, zadanie nie jest `issued`, tryb to `mock_test`,
  przedmiot nie ma `ttsForFeedbackSentence` albo klucz nie ma `feedbackAudioAssetId`;
- zapis zapieczętowanego `audio_issued` z ekspozycjami `[targetKey, sentenceTargetKey]` przed
  odpowiedzią (istniejący `writeSealedEvent`), odpowiedź z `audioAssetId` (pole `DisclosureDto`
  istnieje — `picture_recall`). Ten typ nie wymaga `ttsForAnswers`.
- Każde odtworzenie (powtórka, przeładowanie strony) to nowa autoryzacja i nowe zdarzenie, jak
  dziś. Przeładowanie bez gestu może zapisać zdarzenie bez usłyszanego dźwięku — nieszkodliwe:
  próba i tak jest wspomagana, a ekspozycja zapisana już przy wydaniu.

### 7.4 Próba i feedback

- Modalność `choice` (dopisanie typu do `assertModalityMatchesExercise`), ocena po id opcji.
  `assistanceFor` dodaje `options` i `model_audio`; brak `audio_issued` przed `receivedAt` →
  §3.1 (nieocenione). „Pomiń” (`skip`) jak dziś: nieocenione, bez kary.
- `correctTextFor` jak dla wyboru. Feedback po odpowiedzi czyta to samo zdanie (#194:
  `withFeedbackSentenceAudio` + `sealPostAnswerAudio`, reguły bez zmian).
- Skutki dla etapów i wsparcia — §3.3 (reguły w `scheduler.ts` i `lesson-sessions.ts`).
- **Ocena aktywności sesji** (`session-activity.ts`, w tym `lessonAnswerValues`): typ jak wybór
  (polecenie z katalogu, zdanie z luką, opcje, wybrana opcja). Do modelu nie trafia nagranie.

### 7.5 Wdrożenie

Web, worker i Kid UI wdrażają się razem; worker nigdy nie wyprzedza webu (to on generuje nowy
typ). Otwarte karty i zainstalowana PWA muszą się odświeżyć — stary klient nie zna nowego promptu
w ścisłej unii. Wycofanie jest praktycznie jednokierunkowe, gdy sesja zaplanowała slot słuchowy
(stary kod rzuca `invalid_training_session_plan` dla zapisanego planu z nowym `kind`) albo
powstało ćwiczenie słuchowe (stary kod nie obsłuży takiej rewizji). Preferujemy poprawkę
w przód; wycofanie wymaga zamknięcia aktywnych sesji lekcji oraz edycji lub ponownego
wygenerowania lekcji z ćwiczeniami słuchowymi — opis w PR.

## 8. Kid UI

Wzorzec: słuchanie słówek (`ListeningView`/`PictureListeningView`).

- **Widok** `LessonListenChoiceView` (dispatcher `ExerciseView`, `exercise-presentation.ts` —
  ikona polecenia `ear`, polecenie z katalogu: „Posłuchaj i wybierz, czego brakuje.”),
  wyłącznie ze wspólnych komponentów:
  - przycisk odsłuchu w slocie `instructionAudio` `ExerciseFrame` (`ListenButton` `md`, 48 px,
    etykieta istniejąca `messages.kid.listenExample` „Posłuchaj zdania”), fokus na przycisku
    po wyświetleniu zadania, Spacja powtarza (`useChoiceKeyboard({ onPlay })`);
  - zdanie z luką przez `splitGap` (luka jako wizualny odstęp z dostępną nazwą, nie surowe `___`),
    `lang = contentLocale`;
  - opcje w `AnswerGrid` z `optionLang = contentLocale`; wybór wysyła odpowiedź natychmiast;
  - stan odtwarzania na przycisku (`data-sound-active`, pierścień dźwięku z poszanowaniem
    reduced-motion), jak `GuidanceButton`.
- **Kontroler sesji** — dedykowana metoda (nie `playTaskAudio`), z kontrolą generacji zadania:
  - po wyświetleniu zadania (także zadania pobranego z wyprzedzeniem) automatycznie autoryzuje
    i odtwarza nagranie raz; bez autoodtwarzania, gdy zadanie wraca z `pendingAttemptId`;
  - opcje są **nieaktywne do końca pierwszego odsłuchu**. „Koniec” = obietnica `play()`
    rozstrzygnięta przy **niezmienionej** generacji odtwarzania kontrolera (`#playbackGeneration`)
    — `BrowserAudioPlayer.play()` rozstrzyga się tak samo przy `ended`, `stop()` i wyparciu, więc
    przerwanie (np. powtórka w połowie zdania) nie odblokowuje; odblokowuje dopiero koniec
    odtwarzania, które nie zostało przerwane. Zapas, gdyby `ended` nie nadeszło: od startu
    odtwarzania `durationMs` z `onStarted` + 1 s (8 s, gdy długość nieznana);
  - **utknięcie bez startu:** licznik startuje przy żądaniu autoryzacji; gdy po 6 s odtwarzanie
    nadal się nie zaczęło (wiszące żądanie autoryzacji albo pobierania pliku), pojawia się
    „Pomiń”, a przycisk odsłuchu pozostaje do ponowienia;
  - **autoodtwarzanie zablokowane:** nowy krótki komunikat z katalogu „Dotknij głośnika, aby
    posłuchać.” jako uprzejmy status (`role="status"`) pod poleceniem — bez alertu i bez
    „Zakończ” (to nie jest istniejący komunikat blokady obrazka); przycisk wyróżniony; opcje
    czekają na odsłuch;
  - **odmowa autoryzacji (4xx) albo błąd pliku/dekodowania:** cicho w autoodtwarzaniu; opcje
    **pozostają nieaktywne** (bez `audio_issued` odpowiedź byłaby nieoceniona), pojawia się
    „Pomiń” (odpowiedź `skip` → nieocenione, bez kary — awaria techniczna nie jest błędem
    dziecka), a udana ręczna powtórka odblokowuje opcje po odsłuchu; ręczne naciśnięcie, które
    się nie powiedzie, daje widoczny komunikat, nigdy „nic się nie dzieje”;
  - **błąd sieci:** istniejąca ścieżka offline (bez lokalnego sukcesu); po powrocie z offline
    autoodtwarzanie nie jest ponawiane, zostaje przycisk;
  - nieaktualna autoryzacja (po odpowiedzi lub zmianie zadania) jest ignorowana; nowe zadanie,
    odpowiedź i inne odtwarzanie przerywają nagranie.
- **Po odpowiedzi:** dok feedbacku jak dla wyboru, automatyczny odczyt zdania (#194). Dok **nie**
  dodaje własnego „Posłuchaj zdania” dla tego typu; przycisk w poleceniu zostaje na miejscu
  (bez skoku układu) i odtwarza nagranie z feedbacku przez istniejący prop `feedbackAudio`
  (wzorzec `PictureRecognitionView`): `onPlay = feedbackAudio?.onPlay ?? handlers.onPlay`,
  aktywny po odpowiedzi tylko z nagraniem w feedbacku. Przycisk komunikatu głosowego w doku
  używa ikony „?” (`GuidanceButton icon="question"`), gdy przycisk w poleceniu może odtworzyć
  odczyt — warunek w `LearnScreen` rozszerzony o ten typ, by nie było dwóch głośników.
- **Responsywność:** compact/medium/expanded, niska wysokość (landscape telefonu, tryb przewijanej
  strony), tablet dotykowy (zwarta rama), desktop ze skalą; cele ≥ 48 px; najgorszy przypadek —
  zdanie 200 znaków i 4 opcje.

## 9. Panel rodzica

- Edytor: typ w `STAGE_BY_TYPE` (web), `STEM_TYPES`, `OPTION_TYPES`, `STEM_LABEL_TYPES`, odznaka
  typu („Posłuchaj i wybierz”), pola jak `lesson_choice` bez piktogramu, polecenia i podpowiedzi;
  zmiana typu ćwiczenia na słuchowe czyści te pola. Podgląd karty ćwiczenia jak wybór.
- Stan i odsłuch nagrania ćwiczenia słuchowego oraz licznik w edytorze lekcji — §6. Krótka
  informacja pod ćwiczeniem: „Lektor przeczyta zdanie. Dziecko dostanie to zadanie, gdy nagranie
  będzie gotowe.”
- Tworzenie lekcji: dopisek „Do puli dodamy najwyżej 2 ćwiczenia „Posłuchaj i wybierz” na regułę.” (§5).
- Nadzór i postęp: typ jak inne kroki (`stepType`).

## 10. Dokumentacja i integracje

- `.kiro/specs/grammar-module/requirements.md`:
  - 4.1 i 4.3 — typ „wybór formy ze słuchu” na liście typów i typów zamkniętych;
  - 4.6 — nowe brzmienie: „WHEN dziecko odtworzy audio zdania przed odpowiedzią — w ćwiczeniu
    tekstowym albo w wyborze formy ze słuchu — THE system SHALL zapisać ekspozycję przed
    wydaniem audio i zakwalifikować próbę jako wspomaganą; odpowiedź w wyborze ze słuchu bez
    wcześniejszego odsłuchu SHALL być nieoceniona.”;
  - 5.2 — dopisek: wybór ze słuchu to dodatkowe ćwiczenie poza etapami (§3.2–3.3);
  - 2.1 — dopisek: wielkość puli dotyczy ćwiczeń etapów; generowanie dodaje do 2 ćwiczeń wyboru
    ze słuchu na regułę ponad nią;
  - 2.13 — nowe brzmienie:

    > THE lesson-generation flow SHALL NOT generate or require answer-audio (`target_audio`) for
    > grammar exercises. THE flow SHALL prepare a feedback-sentence recording (`feedback_audio`)
    > for exercise types with a full sentence; it never blocks publication. Child lesson tasks
    > SHALL NOT expose a sentence recording before the answer, except in the listen-and-choose
    > type (`lesson_listen_choice`), where the recording is the stimulus: it is disclosed only
    > through the server's disclosure authorization (requirement 4.6 — sealed exposure, assisted
    > attempt), and the type is never issued without a ready recording.
- `docs/SPEC.md` §22 (dopowiedzenie o wyborze ze słuchu) i lista typów lekcji;
  `docs/architecture.md` sekcja 19 (typ, slot ćwiczenia słuchowego, nagranie jako bodziec,
  gotowość fail-closed); spec rozdziału (typ w rodzajach zagadnień); spec #194 §11 (punkt 2
  zrealizowany tym projektem).
- **API → MCP → `SKILL.md`: brak zmian.** Nowa wartość `exerciseType`, nowy prompt zadania
  i nowy powód `listen_practice` są w Kid API; autoryzacja odsłuchu rozszerza istniejący
  endpoint bez zmiany schematu (`DisclosureDto.audioAssetId` istnieje). MCP obejmuje wyłącznie
  `learning-overview`, a `SKILL.md` jawnie wyklucza lekcje; implementacja potwierdza to
  wyszukaniem użyć i opisuje w PR. DTO rodzica (stan nagrania ćwiczenia słuchowego) nie jest
  częścią MCP.

## 11. Prywatność

Do TTS trafia wyłącznie zdanie z zatwierdzonego materiału. Nagranie jest wspólnym materiałem;
usunięcie profilu usuwa zdarzenia dziecka, nie nagrania. Kid DTO nie zawiera klucza ani
identyfikatora nagrania przed autoryzacją.

## 12. Testy

- **Domena (unit):**
  - walidacja puli: luka 2+ podkreśleń, opcje równoważne na poziomie zdania (w tym skróty),
    opcja z apostrofem na początku, limit zdania, zakazane pola, typ przedmiotu/celu;
  - katalog: wymóg `ttsForFeedbackSentence`, pokrycie guided innym typem;
  - tożsamość z pełnego zdania; `feedbackSentenceText`; ekspozycja rozdziału;
  - selektor: `listenPracticePlan` (po pierwszym zwykłym ocenionym zadaniu celu w sesji, także
    dla celów kontynuowanych — sesja nie zaczyna się od zadań słuchowych; ≤ 1 na cel i ≤ 2 na
    sesję; nie w `introduce`, nie jako ćwiczenie wsparcia, nie ponad budżet; kandydat bez
    `stimulusAudioReady` pomijany, brak wartości = niegotowe), neutralność dla `stageStreak`,
    brak cyklu wsparcia po błędzie, `initialStatus` pomija typ; plan sesji treningowej
    (`planningMode`) zawiera slot; predykat `outsideStagePath`;
  - walidacja puli: zdanie słuchowe równoważne odpowiedzi ćwiczenia tekstowego lekcji odrzucone;
  - `poolCoverage` nie liczy typu; plan kartkówki go wyklucza.
- **Generator (unit):** prompt (limit `count + extra`, reguły pól typu, typ poza menu etapów),
  schemat puli, czyszczenie świeżego wyjścia, fake provider.
- **Media (unit):** typ planuje `feedback_audio` z pełnym zdaniem; zmiana poprawnej opcji zmienia
  fingerprint; DTO rodzica pokazuje stan nagrania tylko dla typu słuchowego.
- **Integracja (PostgreSQL):**
  - plan sesji przez `createLessonTrainingSessionPlan` i wydawanie zadań: slot tylko z gotowym
    nagraniem, bez nagrania selektor go pomija;
  - autoryzacja odsłuchu: zapieczętowane `audio_issued` z dwoma kluczami ekspozycji przed
    odpowiedzią, `audioAssetId` w odpowiedzi; odmowy (nie-`issued`, kartkówka, brak nagrania);
  - próba po odsłuchu: wspomagana (`options`, `model_audio`), feedback z `correctAudioAssetId`;
    próba bez odsłuchu: nieoceniona (`no_stimulus`), zadanie zostaje `issued`; błąd nie otwiera
    wsparcia; `historicalSupportObjectives` pomija zadania słuchowe (poprawna odpowiedź słuchowa
    po prawdziwym błędzie reguły nie kasuje karty wsparcia w następnej sesji);
  - DTO rodzica: `sentenceAudio` tylko dla typu słuchowego, licznik w edytorze lekcji;
  - klucz zdania blokuje „niewidziane” dla ćwiczenia z tym samym zdaniem;
  - kartkówka nie wydaje typu; publikacja nie czeka na nagranie;
  - edycja rodzica (odrzucenie zakazanych pól), nowa wersja, generacja z fake providerem;
  - gotowe nagranie z innego szkicu ożywia opublikowane ćwiczenie.
- **Kid UI (unit):** widok, `exercise-presentation` (kompletność), tokeny (`kid-design-tokens`);
  kontroler — autoodtwarzanie tylko dla typu i nie w kartkówce; blokada opcji do końca
  nieprzerwanego odsłuchu (powtórka w połowie zdania utrzymuje blokadę; zapas `durationMs` + 1 s);
  wiszące żądanie autoryzacji/pliku → „Pomiń” po 6 s; blokada autoodtwarzania → status; odmowa
  → „Pomiń” przy zablokowanych opcjach; nieaktualna autoryzacja ignorowana; brak
  autoodtwarzania przy `pendingAttemptId`.
- **E2E `mocked`** — nowy spec `tests/e2e/lesson-listen-choice.spec.ts` dopisany do `MOCKED_SPECS`
  w `tests/e2e/spec-projects.ts`:
  - liczba żądań autoryzacji (autoodtwarzanie = 1, powtórka = 2, powtórka po odpowiedzi = 0
    nowych) i brak pobrania nagrania przed autoryzacją;
  - opcje nieaktywne do końca odsłuchu; zablokowane autoodtwarzanie → status i przycisk;
    odmowa → „Pomiń”; opóźnione nagranie (wiszące pobranie) → „Pomiń” po 6 s; offline → ekran
    offline; Spacja powtarza; fokus na przycisku; geometria i stabilność także w stanach
    „status blokady” i „Pomiń”;
  - po odpowiedzi: odczyt zdania, przycisk w poleceniu odtwarza nagranie feedbacku, ikona „?”
    w doku;
  - geometria: prostokąty przycisku, zdania i opcji względem okna i kontenera materiału, brak
    przepełnienia poziomego, cele ≥ 48 px — portrait, landscape < 480 px (812×375), tablet
    dotykowy ≥ 960×480, desktop i skala > 1 (`waitForKidScale`, `expectFrameFillsViewport`);
    najgorszy przypadek 200 znaków + 4 opcje;
  - stabilność układu (`kid-layout-stability.spec.ts`): prostokąty przycisku, zdania i opcji nie
    przesuwają się między zadaniem a dokiem.
  - Edytor rodzica: `parent-lesson-editor-layout.spec.ts` z ćwiczeniem słuchowym.
- **E2E `real`** — rozszerzenie `lesson-real-flow.spec.ts` (jego kosz w `REAL_BUCKETS`):
  lekcja z ćwiczeniem słuchowym z fake providera; test czeka, aż `feedback_audio` jest gotowe,
  zanim rozpocznie sesję, a przebieg prowadzi do slotu słuchowego deterministycznie (po pierwszym
  ocenionym zadaniu celu).
- **Niezweryfikowane symulacją:** autoodtwarzanie na fizycznym iPhonie/iPadzie (Safari) i
  słyszalność różnic form w głosie lektora — raport jako brak dowodu (rodzic może odsłuchać
  nagranie w edytorze).

## Ustalenia z implementacji

Decyzje podjęte podczas implementacji (2026-11-01); tam, gdzie różnią się od sekcji powyżej, obowiązuje ten dodatek.

- **Cele gramatyki z typem (§5).** Present Simple: `affirmative_base`, `third_person_s`, `negative`, `question`; „to be”: `affirmative_forms`, `negative_forms`, `questions`. Bez typu: `spelling_es_ies`, `short_answers` (oba tematy), `base_form_after_does` oraz `to_be.contractions` — sprawdzanym elementem jest skrót, a pełna forma i skrót są odpowiedziami równoważnymi, więc zadanie słuchowe nie miałoby jednej słyszalnej poprawnej formy. Wersje tematów bez zmian.
- **Selektor (§3.2).** Slot `listenPracticePlan` (powód `listen_practice`) następuje po pierwszym zwykłym ocenianym zadaniu celu w sesji (wydanym lub zaplanowanym), najwyżej 1 na cel i 2 na sesję, nigdy dwa zadania słuchowe z rzędu i tylko z gotowym nagraniem. Wspólny predykat `outsideStagePath` (słuchowe i słowa kluczowe) steruje logiką etapów; wyniki słuchowe są neutralne dla etapów i wsparcia, a `historicalSupportObjectives` pomija zadania słuchowe.
- **Nagranie bodźca (§6, §7.3).** Bodźcem jest istniejące nagranie `feedback_audio` (bez nowej roli i migracji). Gałąź `authorizeDisclosure` pieczętuje `audio_issued` z ekspozycjami `[targetKey, klucz zdania]`; odpowiedź bez wcześniejszej autoryzacji jest nieoceniona (`no_stimulus`), a zadanie zostaje `issued`.
- **Generowanie (§5).** Do 2 ćwiczeń słuchowych na cel dochodzi ponad wielkość puli rodzica (pole portu `listenChoicePerObjective`); świeże wyjście modelu jest czyszczone z `instructionPl`, `hint` i `visualSubject`.
- **Panel rodzica (§6, §9).** Pole `sentenceAudio` tylko dla ćwiczeń słuchowych: odznaka i pozycja „Posłuchaj” w menu, tekst naprawy przy nieudanym nagraniu oraz licznik ćwiczeń bez gotowego nagrania w edytorze.
- **Kid UI (§8).** Autoodtwarzanie raz po wyświetleniu; opcje zablokowane do końca pierwszego nieprzerwanego odsłuchu (zapas `durationMs` + 1 s, 8 s przy nieznanej długości); „Pomiń” po 6 s bez startu odtwarzania albo po odmowie lub błędzie pliku; zablokowane autoodtwarzanie daje status „Dotknij głośnika, aby posłuchać.”; brak ponownego autoodtwarzania po powrocie z offline. Dok feedbacku bez własnego „Posłuchaj zdania”, a przycisk komunikatu głosowego ma ikonę „?”.
- **Poprawki po przeglądzie całej gałęzi (2026-11-01).**
  - *Limit generowania (§5).* Najwyżej 2 ćwiczenia słuchowe na regułę **łącznie w szkicu**: `listenChoicePerObjective = 2 − ćwiczenia słuchowe celu już w szkicu i we wcześniejszych partiach runu` (0 → pole pominięte, prompt nie wymienia typu ani jego pól; adapter przycina do 0–2). Po walidacji run zachowuje najwyżej przyznaną liczbę ćwiczeń słuchowych na cel, a gdy dodatek przyznano — najwyżej `countPerObjective` pozostałych; nadmiar jest odrzucany i liczony w `rejectedCount` (reguła `exerciseType` w logu). Dogenerowanie reguły z kompletem 2 ćwiczeń słuchowych nie dodaje kolejnych.
  - *Reguła krzyżowa przy dogenerowaniu (§3.4).* Walidacja dopisywanej puli uwzględnia ćwiczenia szkicu w obie strony (nowe słuchowe vs odpowiedzi tekstowe szkicu, nowe tekstowe vs zdania słuchowe szkicu), więc konflikt nie wychodzi dopiero przy publikacji.
  - *Podpowiedź (§7.3).* `authorizeDisclosure` z `kind: "hint"` dla zadania słuchowego → 409 bez zdarzenia (podpowiedź ujawniłaby brakujące słowo).
  - *Kid UI (§8).* Zablokowane autoodtwarzanie zachowuje licznik 6 s, więc bez naciśnięcia pojawia się „Pomiń”; ręczne naciśnięcie zablokowane przez przeglądarkę daje od razu „Pomiń” i komunikat (bez pętli w stanie blokady); po powrocie z offline nieotwarty bodziec przechodzi w stan blokady (status + wyróżniony głośnik, potem licznik 6 s), bez autoodtwarzania. Linia statusu (`role="status"`) jest zawsze zamontowana, ale stoi pod opcjami (nie „pod poleceniem” jak w §8) i pusta nie zabiera wysokości: tekst blokady nie przesuwa zdania ani opcji, a zarezerwowana linia nad zdaniem odbierała ramie odstęp od góry przy doku wyniku (przesunięcie 13 px przy 1280×800). Komunikat błędu ręcznego odsłuchu jest samym tekstem, bez „Odtwórz ponownie” i „Koniec”, a wysłanie odpowiedzi go gasi. Wyróżnienie głośnika to wypełnienie (nie obrys fokusu); Spacja na „Pomiń”/„Dalej” nie odtwarza zdania; ikona „?” w doku zawsze przy tym typie.
  - *Teksty (rozstrzygnięcie właściciela, zastępuje Global Constraints).* Polecenie „Posłuchaj i wybierz, czego brakuje.”, dostępna nazwa luki „luka” (`lang="pl-PL"`), status blokady „Dotknij głośnika, aby posłuchać.”, dopisek tworzenia lekcji „Do puli dodamy najwyżej 2 ćwiczenia „Posłuchaj i wybierz” na regułę.”.
- **Niezweryfikowane (§12):** autoodtwarzanie na fizycznym iPhonie/iPadzie (Safari) i słyszalność różnic form w głosie lektora.
