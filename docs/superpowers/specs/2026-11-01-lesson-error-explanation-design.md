# Wyjaśnienie błędu dla dziecka w lekcjach — design

Data: 2026-11-01. Status: zaakceptowany przez właściciela 2026-11-01 (po review trzech krytyków).
Issue: #196. Powiązane: `docs/superpowers/specs/2026-10-30-lesson-sentence-readback-design.md`
(odczyt zdania, #194), `docs/superpowers/specs/2026-10-30-tts-voice-style-design.md` (styl TTS),
`.kiro/specs/grammar-module/requirements.md`, `docs/architecture.md` §19, `docs/SPEC.md` §22.

## 1. Cel

Po błędnej odpowiedzi w lekcji angielskiego dziecko widzi **jedno krótkie polskie zdanie**
wyjaśniające regułę, np. „Przy he, she, it dodajemy -s: he plays.”, i może je odsłuchać.
Dziś po błędnym wyborze, złej kolejności albo „Nie pamiętam” widzi tylko „Poprawna odpowiedź: …”,
a podpowiedź kategorii błędu dostaje wyłącznie po werdykcie modelu oceniającego.

Ustalenia z właścicielem (2026-11-01):

- **jedno wyjaśnienie na ćwiczenie** (`explanationPl`), generowane razem z materiałem,
  widoczne i edytowalne przez rodzica — zatwierdzane jak reszta materiału;
- pokazywane **po błędnej odpowiedzi i po „Nie pamiętam”**; nie po „prawie”, „Pomiń”,
  nieocenionej odpowiedzi ani w kartkówce;
- przedmioty **`english_grammar` i `english_chapter`** (flaga przedmiotu); szkoła bez zmian;
- **nagranie pl-PL w tym PR**: przycisk „Posłuchaj wyjaśnienia”, odtwarzanie ręczne
  (bez autoodtwarzania), nie blokuje publikacji; rodzic może odsłuchać i nagrać ponownie;
- podejście **A′**: rodzaj feedbacku się nie zmienia — `incorrect` dostaje opcjonalne `hintPl`.

Świadome odstępstwa i doprecyzowania (wynik review, potwierdzone przez właściciela 2026-11-01):

- **„prawie” bez wyjaśnienia** — issue dopuszcza wyjaśnienie także po „prawie”; właściciel
  wybrał tylko błąd i „Nie pamiętam”. W gramatyce „prawie” oznacza poprawnie zastosowaną regułę
  z literówką poza nią, więc wyjaśnienie reguły nie pasuje. Werdykt modelu „prawie” z kategorią
  błędu celu jest już dziś zamieniany na `model_incorrect` i dostaje podpowiedź (§4.2).
- **Werdykt `model_incorrect`: najpierw szablon kategorii, potem wyjaśnienie ćwiczenia.**
  Szablon odpowiada błędowi, który model rozpoznał, a jedno wyjaśnienie ćwiczenia może opisywać
  inny błąd (AGENTS.md: feedback musi odpowiadać rzeczywistemu wynikowi). Wyjaśnienie ćwiczenia
  zastępuje szablon tylko wtedy, gdy szablonu brak (kategoria `other`, nadpisanie rodzica bez
  kategorii, brak tekstu w katalogu). To zmiana względem zaakceptowanej w rozmowie wersji
  („wyjaśnienie zastępuje szablon”).
- **Stare lekcje:** bez wstecznego generowania. Wyjaśnienie dopisuje rodzic ręcznie w nowej
  wersji lekcji. Regeneracja celu dodaje wyjaśnienia tylko nowo generowanym ćwiczeniom —
  istniejące ćwiczenia szkicu zostają bez zmian.

Wyjaśnienie wybiera **deterministyczna reguła serwera** — w sesji nie działa żaden model.

## 2. Zakres

W zakresie: pole materiału, generator, walidacja, edytor i podgląd rodzica, klucz zadania,
reguła feedbacku, kontrakt Kid DTO, nowa rola nagrania `explanation_audio`, Kid UI, testy,
dokumentacja.

Poza zakresem:

- przedmioty szkolne — `commonErrors` szkoły to prywatne kryteria oceny (lista błędnych
  twierdzeń dla modelu oceniającego), nie tekst dla dziecka; ich treści nie używamy, przejmujemy
  tylko wzorzec „treść błędu powstaje z materiałem i zatwierdza ją rodzic”;
- komentarze modelu oceniającego (`lesson_verdicts.comment`) — nadal wyłącznie dla rodzica;
- wiele wyjaśnień na ćwiczenie (per dystraktor / per kategoria błędu);
- omówienie kartkówki, autoodtwarzanie wyjaśnienia, słówka (zadania spoza lekcji);
- zmiana tonu doku po „Nie pamiętam” (dziś czerwony jak przy błędzie, gdy wynik jest pokazany).

## 3. Model danych i generowanie

### 3.1 Pole i reguły treści

- `explanationPl?: string` w `LessonExerciseInputSchema` (`packages/contracts/src/lessons.ts`),
  w drafcie domeny (`LessonExerciseDraft`), w payloadzie rewizji i DTO szkicu.
- Reguły treści (walidacja w `pool-validation.ts`, wspólna dla generatora i zapisu rodzica):
  - zwykły tekst bez znaczników: bez nowej linii, bez `*` i `_`;
  - po przycięciu niepuste, **≤ 120 znaków** (`MAX_TEXT_LENGTH`, jak `hint`);
  - **dokładnie jedno zdanie** według istniejącego `sentenceCount` (`domain/tts-style.ts`).
- Cytat odpowiedzi innego ćwiczenia **nie jest błędem walidacji** (review planu: dopasowanie
  słów polskiego tekstu do angielskich odpowiedzi daje fałszywe trafienia „do”, „a”, „to”,
  a reguła puli blokowałaby publikację przez ćwiczenie, którego rodzic nie dotykał). Zamiast
  tego ujawnienie jest zapisywane jako ekspozycja (§4.4), jak przykłady na kartach.
- Niedozwolone, gdy przedmiot ma wyłączoną flagę; `lesson_card` odrzuca je już istniejąca
  reguła pól karty.
- **Nie wpływa na tożsamość** ćwiczenia (`exercise-identity.ts`), `target_key` ani kryteria celu
  (`objectiveImpacted`, `buildObjectiveCriteria` go pomijają): edycja wyjaśnienia w szkicu
  zmienia payload rewizji szkicu, a po publikacji nie powstaje nowa wersja umiejętności.
  Nie jest polem v3.
- Pole przechodzi przez wszystkie allowlisty payloadu: `rawExerciseShapeSchema` (`nullish`),
  `toExerciseDraft` (tylko string, `null` = brak), `buildLessonPayload`, `exerciseDtoFromPayload`
  i przebudowę payloadu w nadzorze (`lesson-supervision.ts`, akceptacja wariantu).

### 3.2 Flaga przedmiotu

`SubjectModule.exerciseExplanations: boolean` — `english_grammar: true`, `english_chapter: true`,
`school: false`, testowy przedmiot w testach architektury: `false`.

### 3.3 Generator

- `LessonPoolInput.exerciseExplanations` (wzorem `voiceTones`) włącza regułę promptu i pole
  w schemacie structured output. Tryb strict: `withExplanation` dodaje pole do `required`
  z typem `["string", "null"]` (jak `withVoiceTone`), także w gałęziach dedykowanych typów.
- Reguła promptu (`llm.ts`): dla każdego ćwiczenia z odpowiedzią jedno zdanie po polsku do
  dziecka w wieku ok. 8 lat, które **wyjaśnia, dlaczego poprawna odpowiedź jest poprawna**
  (reguła), bez zakładania, jaki błąd dziecko popełniło — tak, by pasowało też po „Nie pamiętam”;
  bez pochwał i oceniania dziecka, bez imion, bez znaczników; angielskie przykłady wyłącznie
  z tego ćwiczenia (odpowiedź, zdanie, opcje); ≤ 120 znaków.
- **Wyjaśnienie z generatora niespełniające reguł treści §3.1 jest po cichu usuwane** (ćwiczenie
  zostaje), a liczba porzuconych wyjaśnień trafia do logu przebiegu jak porzucone warianty
  odpowiedzi (`rejectedReasons` liczy odrzucone ćwiczenia, więc go nie zawyżamy) — wzorem
  `withoutVoiceToneUnlessAllowed`. Brak wyjaśnienia nie odrzuca ćwiczenia ani puli.
- Fake provider generuje przewidywalne, poprawne wyjaśnienia dla testów.

### 3.4 Panel rodzica

- Pole tekstowe „Wyjaśnienie dla dziecka (po błędzie)” w karcie ćwiczenia edytora
  (`LessonExerciseCard`), poza blokiem pól v3, z licznikiem do 120 znaków. Puste lub same
  spacje = brak wyjaśnienia (`undefined`, nie pusty tekst). Zapis łamiący reguły §3.1 zwraca
  błąd walidacji przy polu (bez cichego usuwania).
- **Podgląd tylko do odczytu** (opublikowana lekcja) pokazuje wyjaśnienie i odsłuch nagrania.
- Pod polem kontrolki nagrania (§5.3) z własnym `testId` i etykietą dostępności
  („wyjaśnienia”), odrębne od nagrania pytania; `sameCardProps` porównuje także
  `explanationAudio`.
- Stan edytora (`lesson-editor-state.ts`) śledzi pole; zmiana oznacza ćwiczenie jako zmienione.

## 4. Reguła feedbacku (sesja)

Właściciel reguł: `learning/lessons` (materializacja i próby); media: `materials`.
Granica transakcji: istniejąca transakcja finalizacji próby.

### 4.1 Klucz zadania

Materializacja w **treningu** (nie kartkówka), gdy przedmiot ma flagę i payload niesie
wyjaśnienie, zapisuje w prywatnym kluczu zadania (`LessonTaskAnswerKey`):

- `explanationPl` — tekst;
- `explanationExposureKeys` — klucze ekspozycji cytowanych celów (§4.4), bez własnego;
- `explanationAudioAssetId` — gotowe nagranie o oczekiwanym fingerprincie, jeśli było gotowe
  w chwili wydania (§5.2).

Prompt zadania i Kid DTO zadania ich nie niosą. Klucz jest niezmienny: zadanie wydane przed
edycją albo przed gotowym nagraniem zostaje przy swoim stanie.

### 4.2 Kiedy feedback dostaje wyjaśnienie

Czysta funkcja `withExerciseExplanation(feedback, key, grade, taskEnds)` w `lesson-attempts.ts`
(obok `withFeedbackSentenceAudio`), wołana w obu ścieżkach finalizacji — ocena deterministyczna
i po werdykcie modelu — po wyliczeniu `taskState` i **przed** dołączeniem nagrania zdania.
Wyjaśnienie trafia do feedbacku, gdy jednocześnie:

1. feedback nie jest `null` (nie kartkówka, nie „Pomiń”);
2. ocena próby ma wynik `incorrect`;
3. rodzaj feedbacku to `incorrect` albo `lesson_hint`;
4. `revealsAnswer(feedback)` — feedback ujawnia rozwiązanie (wyklucza `not_assessed`
   i podpowiedź bez `correctText`, np. błędne obliczenie);
5. odpowiedź kończy zadanie (następny stan nie jest `issued`) — zabezpieczenie: dziś w treningu
   każde `incorrect` kończy zadanie, a `model_other` ma wynik `unevaluated` i odpada już na
   warunku 2;
6. klucz ma `explanationPl`;
7. dla `lesson_hint`: feedback **nie ma** `hintPl` z szablonu kategorii (szablon ma pierwszeństwo).

| Sytuacja | Feedback |
| --- | --- |
| błędny wybór / kolejność / zaznaczenie / przypisanie (także luki rozdziału), „Nie pamiętam” | `incorrect` + `correctText` + **`hintPl` = wyjaśnienie** |
| `model_incorrect` z szablonem kategorii (także „prawie” modelu z kategorią celu) | `lesson_hint` + szablon kategorii, jak dziś |
| `model_incorrect` bez szablonu | `lesson_hint` + **`hintPl` = wyjaśnienie** |
| `model_incorrect` bez szablonu i bez wyjaśnienia | `incorrect` + `correctText` (naprawa: dziś powstaje `lesson_hint` bez `hintPl`, który łamie kontrakt) |
| „prawie” (`minor_typo`, `model_almost`), `model_other`, `not_assessed`, „Pomiń”, trener precyzji, kartkówka | bez zmian |
| odpowiedź pisemna bez skonfigurowanego modelu oceniającego (`not_assessed`) | bez zmian — bez wyjaśnienia |
| ćwiczenie bez wyjaśnienia (stare lekcje, szkoła) | bez zmian |

`answerSegments` i `correctText` się nie zmieniają.

### 4.3 Nagranie w feedbacku

Gdy `hintPl` feedbacku pochodzi z wyjaśnienia ćwiczenia (nie z szablonu kategorii) i klucz ma
`explanationAudioAssetId`, feedback niesie `explanationAudioAssetId`.

### 4.4 Ekspozycja i samodzielność

- Wyjaśnienie jest częścią feedbacku, który już ujawnia rozwiązanie (warunek 4), więc obejmuje
  je ta sama ekspozycja `targetKey` zapisywana w `discloseLessonFeedback` przed odpowiedzią HTTP.
- **Ekspozycje cytatów:** wyjaśnienie może zacytować tekst ekspozycji innego ćwiczenia tej samej
  wersji lekcji (reguła promptu tego zabrania, ale rodzic może wpisać dowolny tekst). Przy
  wydaniu zadania serwer wylicza czystą funkcją `explanationExposureKeys` klucze `target_key`
  ćwiczeń, których tekst ekspozycji (`exposureText` przedmiotu albo odpowiedź) występuje
  w wyjaśnieniu na granicy słów, po normalizacji ekspozycji przedmiotu i po usunięciu
  z wyjaśnienia własnego tekstu ekspozycji ćwiczenia; własny klucz jest pomijany. Klucze
  trafiają do prywatnego klucza zadania (`explanationExposureKeys`), a `discloseLessonFeedback`
  zapisuje je razem z `targetKey`, gdy feedback niesie wyjaśnienie ćwiczenia (nie szablon
  kategorii — także wtedy, gdy tekst szablonu jest identyczny z wyjaśnieniem).
- **Ekspozycje cytatów są trwałe**, jak każda inna ekspozycja lekcji: nie mają okna czasowego,
  więc liczą się dla późniejszych prób tamtego celu (samodzielne sprawdzenie, selektor
  i wyczerpanie puli w nadzorze rodzica). Dlatego jednowyrazowe cele, które są też zwykłymi
  polskimi słowami (stały zbiór `a, i, o, u, w, z, do, to, on, no, na, my, we, go, ja, ze, po, od`
  po normalizacji), są pomijane — inaczej niemal każde polskie wyjaśnienie oznaczałoby
  angielskie „I”, „a”, „do”, „to”, „on”, „no” jako ujawnione na zawsze. Cele wielowyrazowe
  i pozostałe pojedyncze słowa dopasowują się jak wyżej. **Ryzyko szczątkowe:** wyjaśnienie,
  które naprawdę cytuje taki jednowyrazowy cel innego ćwiczenia („Wybierz do.”), nie zapisze
  jego ekspozycji; inne fałszywe trafienia dają tylko dodatkową trwałą ekspozycję. Nic nie jest
  blokowane.
- **Pieczęć nagrania:** `audio_issued` jest zapisywane **raz** na próbę, gdy feedback niesie
  którekolwiek nagranie po odpowiedzi (`correctAudioAssetId` albo `explanationAudioAssetId`),
  z tym samym `occurredAt = max(now, receivedAt + 1 ms)` co dziś. Zmienia się wyłącznie warunek
  w lekcyjnym `sealFeedbackSentenceAudio`; współdzielony ze słówkami `sealPostAnswerAudio`
  zostaje bez zmian. Dwa nagrania nie dają dwóch zdarzeń.
- Kwalifikacja próby się nie zmienia: zdarzenia po `receivedAt` nie liczą się do wsparcia,
  a zadanie lekcji kończy się na tej odpowiedzi.
- Feedback zapisuje się w `attempts.feedback`, więc ponowny odczyt i idempotentne powtórzenie
  próby zwracają to samo.

### 4.5 Kontrakt Kid DTO

`FeedbackDtoSchema` (`packages/contracts/src/kid.ts`):

- `hintPl` dozwolone także przy `incorrect` (opcjonalne); przy `lesson_hint`
  i `lesson_precision_hint` nadal wymagane, przy pozostałych rodzajach nadal zabronione.
  Słówka nigdy go nie ustawiają (test regresji: `incorrect` bez `hintPl` renderuje się jak dziś);
- nowe `explanationAudioAssetId?: Uuid` (jak `correctAudioAssetId`) — dozwolone tylko razem
  z `hintPl` i tylko przy `incorrect` albo `lesson_hint`; reguła „`not_assessed` nie niesie
  audio” obejmuje też to pole.

**Zgodność:** schemat jest `.strict()`, a Kid UI waliduje każdą odpowiedź próby, więc **stary
klient odrzuca nowy feedback** (`KidApiError("internal")`). Klient i serwer wdrażają się razem
(jedna aplikacja Next.js, bez service workera); karta otwarta w trakcie wdrożenia wymaga
przeładowania. To samo dotyczyło wcześniejszych rozszerzeń feedbacku lekcji. DTO nie niesie
kryteriów, kategorii błędu ani komentarza modelu.

## 5. Nagranie wyjaśnienia

### 5.1 Rola i uzgadnianie

- Nowa rola zasobu rewizji **`explanation_audio`**: migracja
  `0033_explanation_audio_role.sql` (pierwotnie `0032`; przenumerowana na `0033` przy scaleniu
  z `main`, gdzie `0032` zajęła migracja #197 `0032_child_interests`) rozszerza `revision_assets_role_allowed` (wzorem `0029`) z ręcznym wpisem w
  `drizzle/meta/_journal.json`; schemat Drizzle, typ `AssetRole` i `docs/schema.sql` (który przy
  okazji uzupełnia brakujące `prompt_audio` i `feedback_audio`).
- `LessonTtsFlags` dostaje `exerciseExplanations`; `requiredAssetsForLessonExercise` przy fladze
  i niepustym `explanationPl` dodaje `ttsAsset("explanation_audio", explanationPl, "pl-PL",
  settings, "lesson_explanation")`.
- **Nowy styl roli `lesson_explanation`** (`TtsRoleStyle`, zdanie w `STYLE_SENTENCES_PL`):
  „Wyjaśnij spokojnie i życzliwie jak cierpliwy nauczyciel; angielskie słowa wymów po angielsku.”
  Druga część jest konieczna, bo instrukcja języka pl-PL każe mówić z polską wymową, a wyjaśnienie
  cytuje angielskie formy. Ton lektora ćwiczenia (`voiceTone`) nie dotyczy wyjaśnienia.
  Zdanie stylu działa przy `UMIEM_TTS_STYLE=instructions` (domyślne w `config-defaults.ts`);
  w innych trybach nagranie dostaje samą instrukcję języka, a styl nie wchodzi do fingerprintu.
- Fingerprint obejmuje tekst (i instrukcje): edycja wyjaśnienia daje nowe nagranie, niezmienione
  zachowują swoje.
- Publikacja **nie czeka** na nagranie (jak `prompt_audio` i `feedback_audio`); nieudane
  nagranie nie jest utrzymywane przy `keepFailed`.
- Worker: `supersedeDisabledLessonTts` dostaje **jawną gałąź** `explanation_audio →
  !exerciseExplanations`. Bez niej rola wpadłaby w gałąź domyślną `!ttsForAnswers`, a oba
  przedmioty angielskie mają `ttsForAnswers = false`, więc każde nagranie byłoby zastąpione.
- Listy zasobów szkicu w DTO rodzica pomijają rolę (`lesson-api.ts` i `decks.ts`, jak
  `prompt_audio`); stan nagrania rodzic dostaje osobno (§5.3).

### 5.2 Wydanie zadania

`loadExercises` (`lesson-sessions.ts`) rozwiązuje `explanation_audio` jak `feedback_audio`:
dowolny gotowy zasób TTS o oczekiwanym fingerprincie, najnowsza generacja. Kartkówka go nie
ładuje.

### 5.3 Rodzic: odsłuch i ponowne nagranie

- DTO ćwiczenia szkicu i podglądu dostaje `explanationAudio` (ten sam kształt co `promptAudio`).
- `regenerateLessonPromptAudio` uogólnia się na rolę: nowe pole wejścia
  `role: "prompt_audio" | "explanation_audio"` z wartością domyślną `prompt_audio` (zgodność
  dotychczasowych wywołań), także w ścisłym schemacie oRPC rodzica
  (`LessonPromptAudioRegenerateInputSchema`). Kontrolki (`PromptAudioControls`) obsługują obie role.
- Ponowne nagranie tworzy nową generację tego samego fingerprintu, którą — jak dziś przy
  nagraniu pytania — wybiera każda wersja lekcji o tym samym tekście, także opublikowana.
  Nowe zadania dostają nowe nagranie; wydane zostają przy swoim.
- Odsłuch w panelu rodzica używa istniejącego endpointu mediów.

## 6. Kid UI

- **Tekst:** kolor dziedziczony z kontenera doku (kontrast jak tytuł), typografia tokenów M3,
  bez kursywy. `incorrect` bez `hintPl` (słówka, stare lekcje) renderuje się bez zmian.
- **Miejsce:** wyjaśnienie zajmuje **osobny wiersz doku na całą szerokość, między górnym
  wierszem** (odznaka, tytuł, odsłuch zdania, komunikat) **a akcjami**, wyrównany do początku.
  Wiersz jest **przypięty poza przewijaną kartą wyniku** (`.kid-feedback-pinned`): przy długim
  wyniku (pełny tekst luk) przewija się tylko karta, a wyjaśnienie i jego odsłuch są widoczne
  bez przewijania (telefony ukrywają paski przewijania, więc wiersz pod zgięciem byłby
  niewidoczny). W panelu-nakładce `ExerciseFrame` liczy wiersz jako resztę panelu przy limicie
  z wolnego miejsca i ustawia `--kid-feedback-pinned-height`, o które maleje dotychczasowy limit
  karty — panel z wyjaśnieniem nie zasłania więcej materiału niż bez niego. W górnym wierszu na
  telefonie zostaje za mało miejsca na tekst (ok. 85–115 px). Tekst wiersza jest w regionie
  `aria-live="polite"`.
  Wiersz pokazuje się dla `incorrect` z `hintPl` oraz dla każdego feedbacku z
  `explanationAudioAssetId` (wtedy `lesson_hint` nie powtarza tekstu w treści); `lesson_hint`
  bez nagrania wyjaśnienia pokazuje `hintPl` w treści jak dziś.
- **Odsłuch:** gdy feedback niesie `explanationAudioAssetId`, przycisk głośnika (`ListenButton`,
  cel ≥ 48 px, nazwa dostępności „Posłuchaj wyjaśnienia” z katalogu komunikatów) stoi **na
  początku wiersza wyjaśnienia** — położenie wiąże go z czytanym tekstem. Odtwarzanie tylko po kliknięciu: kontroler
  `playExplanationAudio()` przez `#beginPlayback` i `mediaUrl`; przerywa odczyt zdania
  i odwrotnie; „Dalej” przerywa. Przycisk zachowuje się jak „Posłuchaj zdania” (#214): pierścień
  `SoundRing` i `data-sound-active` w trakcie gry (`explanationPlaying` z tymi samymi
  strażnikami przebiegu, generacji, epoki i `attemptId`), ponowne dotknięcie zaczyna od nowa,
  blokada przy `busy`, offline i nagrywaniu, a nieudany ręczny odsłuch pokazuje ten sam
  komunikat `aria-live` (region doku z #216: w DOM za górnym wierszem, przed wierszem
  wyjaśnienia, położenie wizualne ustala CSS `order`) i porusza ikoną przycisku wyjaśnienia
  (`failKey`).
  Udany start dowolnego nagrania doku gasi nieaktualny komunikat błędu.
- **Przycisk komunikatu:** `GuidanceButton` przechodzi na obrysowany „?” (`icon="question"`),
  gdy dok pokazuje **którykolwiek** odsłuch (zdania albo wyjaśnienia), by nie stały obok siebie
  dwa jednakowe głośniki.
- **Odczyt zdania** (#194) zostaje automatyczny i gra raz także przy wyjaśnieniu.
- **„Nie pamiętam”:** gdy feedback niesie wyjaśnienie (`hintPl`), ekran zostaje na wyniku do
  „Dalej” — rozszerzenie istniejącego wyjątku dla nagrania zdania w `#showResult`.
- **Bez zmian:** rodzaj feedbacku, ton doku (`incorrect` → „incorrect”), oznaczenie opcji
  (`option-outcome.ts`), postęp sesji.
- **Responsywność:** najdłuższe wyjaśnienie (120 znaków) z tytułem, odsłuchem zdania i wyjaśnienia
  mieści się w doku w portrait (375×812), landscape telefonu (812×375), tablecie i desktopie:
  wiersz wyjaśnienia ma użyteczną szerokość tekstu (≥ 220 px w 375×812), zawija się, jest w całości
  widoczny bez przewijania, a akcje pozostają osiągalne. Najgorszy przypadek: luki rozdziału
  (`lesson_cloze`) z pełnym tekstem jako `correctText` — w 360×800 dok ma tę samą wysokość co bez
  wyjaśnienia (karta wyniku przewija się w środku), a widoczny materiał się nie zmienia.

## 7. Prywatność

Do TTS trafia wyłącznie zatwierdzony tekst materiału. Wyjaśnienie nie zależy od odpowiedzi
dziecka, nie jest generowane w sesji i nie zawiera danych dziecka. Nagranie jest wspólnym
materiałem; usunięcie profilu go nie usuwa. Komentarz modelu oceniającego pozostaje tylko
dla rodzica.

## 8. Testy

- **Domena / unit:**
  - `withExerciseExplanation` — każdy wiersz tabeli §4.2 (w tym pierwszeństwo szablonu,
    `model_incorrect` bez szablonu i bez wyjaśnienia → `incorrect`, „prawie”, `model_other`,
    `not_assessed`, trener precyzji, brak wyjaśnienia, nagranie tylko przy wyjaśnieniu ćwiczenia);
  - kontrakt: `hintPl` przy `incorrect`, odrzucenie `explanationAudioAssetId` bez `hintPl`,
    przy `not_assessed` i innych rodzajach;
  - walidacja: limit 120, nowa linia, znaczniki, więcej niż jedno zdanie, wyłączona flaga;
  - `explanationExposureKeys`: cytat innego celu, własny tekst usuwany przed dopasowaniem,
    granice słów („display” ≠ „plays”), wielkość liter, jednowyrazowy polski homograf („do”, „a”, „to”) jest pomijany, a cel wielowyrazowy i inne cytowane słowa dają ekspozycję; generator usuwa złe wyjaśnienie i zostawia ćwiczenie;
    tożsamość ćwiczenia nie zależy od wyjaśnienia;
  - schemat (required + nullable) i prompt generatora przy fladze i bez niej; fake provider;
  - uzgadnianie mediów: rola, locale, styl, fingerprint zależny od tekstu, szkoła bez nagrania,
    publikacja nie czeka; lista stylów w `tts-style-profile.test.ts`;
  - `objectiveImpacted` ignoruje wyjaśnienie; stan edytora rodzica; kontrolki nagrania;
  - Kid UI: widok `incorrect` z `hintPl` i bez (regresja słówek), odsłuch ręczny, przerywanie,
    „?” przy samym odsłuchu wyjaśnienia, „Nie pamiętam” zostaje na wyniku.
- **Integracja (PostgreSQL):**
  - wyjaśnienie i nagranie w feedbacku błędnego wyboru, „Nie pamiętam” i `model_incorrect`
    bez szablonu; szablon przy `model_incorrect` z kategorią;
  - brak dla dobrej odpowiedzi, „prawie”, `model_other`, `not_assessed`, „Pomiń”, kartkówki;
  - jedna pieczęć `audio_issued` przy dwóch nagraniach; próba samodzielna; ponowny odczyt próby;
  - wyjaśnienie cytujące odpowiedź innego ćwiczenia → ekspozycja tamtego celu zapisana razem
    z feedbackiem;
  - worker faktycznie tworzy `explanation_audio` dla `english_grammar` (nie zastępuje go);
  - publikacja → nowy szkic z opublikowanej → edycja wyjaśnienia → ta sama `skill_version`, nowe nagranie;
  - akceptacja wariantu w nadzorze zachowuje wyjaśnienie;
  - ponowne nagranie przez rodzica; migracja `0033` przyjmuje rolę; szkoła bez wyjaśnień.
- **E2E (Playwright):**
  - `mocked`, rozszerzenie `lesson-sentence-audio.spec.ts` (albo nowy spec obok): wyjaśnienie po
    błędnym wyborze i po „Nie pamiętam”; „Posłuchaj wyjaśnienia” gra tylko po kliknięciu
    i przerywa odczyt zdania, który nadal gra raz automatycznie; brak przycisku bez nagrania;
    „?” zamiast głośnika komunikatu; geometria doku z wyjaśnieniem 120 znaków w 375×812,
    812×375, tablecie i desktopie, w tym luki rozdziału; kontrast w `kid-answer-contrast.spec.ts`;
  - `mocked`, `parent-lesson-editor-layout.spec.ts`: pole, licznik, kontrolki nagrania,
    podgląd tylko do odczytu;
  - `real`: jeden przebieg generowanie (fake provider) → publikacja → sesja dziecka → błędna
    odpowiedź pokazuje wyjaśnienie, w najlżejszym koszu `REAL_BUCKETS`.
  Nowe specy trafiają do partycji w `tests/e2e/spec-projects.ts`, nowe pliki integracyjne do
  najlżejszego kosza `tests/integration-buckets.ts`.
- **Niezweryfikowane symulacją:** wymowa angielskich wtrąceń w polskim nagraniu na prawdziwym
  providerze TTS (do odsłuchu przez właściciela przed użyciem) i odbiór na fizycznym urządzeniu —
  do raportu jako brak dowodu.

## 9. Dokumentacja i integracje

- `docs/architecture.md` §19 (feedback lekcji: `hintPl` przy `incorrect`,
  `explanationAudioAssetId`, kolejność szablon → wyjaśnienie) i §22 (rola `explanation_audio`);
  `docs/SPEC.md` §22/§37 oraz nowe kryterium akceptacji i nota przy A58;
  `.kiro/specs/grammar-module/requirements.md` (nowe wymaganie o wyjaśnieniu); `docs/schema.sql`;
  nota w specu odczytu zdania (§11, punkt 5 zrealizowany) i w specu stylu TTS (nowa rola stylu).
- **API → MCP → `SKILL.md`:** brak zmian. MCP nie udostępnia feedbacku zadań dziecka ani
  materiału lekcji (`apps/web/src/integrations`, `integrations/umiem-mcp` nie używają
  `FeedbackDto`, `LessonExerciseInput` ani nagrań lekcji), a raport `learning-overview` świadomie
  nie obejmuje lekcji (`SKILL.md`). PR opisuje to uzasadnienie.
