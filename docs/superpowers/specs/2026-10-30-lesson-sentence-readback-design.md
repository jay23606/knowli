# Odczyt pełnego zdania po odpowiedzi w lekcjach gramatyki — design

Data: 2026-10-30. Status: do recenzji właściciela.
Powiązane: `.kiro/specs/grammar-module/requirements.md` (wymaganie 2.13, 4.6),
`docs/SPEC.md` §22, `docs/superpowers/specs/2026-10-30-tts-voice-style-design.md`,
issue #187 (odsłuch z feedbacku `picture_recognition`), #174 („Posłuchaj pytania”).

## 1. Cel

Po każdej ocenionej odpowiedzi w ćwiczeniu gramatyki dziecko słyszy **pełne
poprawne zdanie** po angielsku. Po dobrej odpowiedzi to potwierdzenie, po błędnej
— poprawny wzorzec. Celem jest osłuchanie się z formami w kontekście (końcówki
`-s`, skróty `doesn't`, `'re`), których samo czytanie nie utrwala.

Ustalenia z właścicielem (2026-10-30):

- odczyt **po każdej ocenionej odpowiedzi** (dobra, błędna, „prawie”, „Nie pamiętam”);
- ekran feedbacku zostaje jak dziś — dochodzi wyłącznie dźwięk i przycisk powtórki;
- już opublikowane lekcje dostają odczyt po **edycji i publikacji nowej wersji**
  (jak przy #174), bez wstecznego generowania.

## 2. Zakres

W zakresie: przedmiot `english_grammar`, typy ćwiczeń z pełnym zdaniem (§4),
trening (nie kartkówka), nagrania przygotowywane w workerze, automatyczny odczyt
i przycisk powtórki w Kid UI.

Poza zakresem tego etapu:

- odczyt w omówieniu kartkówki;
- odsłuch nagrania w podglądzie lekcji rodzica;
- nagrania wszystkich zatwierdzonych wariantów odpowiedzi (czytamy wersję kanoniczną);
- przedmioty szkolne (flaga przedmiotu pozostaje `false`);
- pomysły z kolejnych etapów: „Powtórz za lektorem”, „Posłuchaj i uzupełnij”,
  wolniejsze odtwarzanie — budują na nagraniu z tego etapu.

**Uzupełnienie (Etap 3 rozdziału, 2026-10-31).** Mechanizm jest generyczny: od Etapu 3
„Angielski — rozdział” (`english_chapter`) też ma flagę `ttsForFeedbackSentence = true`
(projekt: `docs/superpowers/specs/2026-10-30-english-chapter-design.md` §5). Rozdział
używa tego samego nagrania, klucza zadania, pieczęci i Kid UI; dochodzą dwa dodatki
generyczne: `lesson_cloze` w §4 i bramka wariantu w §6. Zapis „tylko `english_grammar`”
powyżej opisuje zakres #194.

**Uzupełnienie (#199, 2026-11-01).** Wskaźnik odtwarzania na „Posłuchaj zdania” i wolniejsze
odtwarzanie (przycisk „Posłuchaj wolniej”) zrobiono w kolejnym etapie, razem z sygnałem nieudanego
ręcznego odsłuchu; projekt: `docs/superpowers/specs/2026-11-01-sentence-readback-followups-design.md`.
„Powtórz za lektorem” zostaje poza zakresem.

## 3. Zmiana uzgodnionych wymagań

Wymaganie 2.13 specyfikacji gramatyki zakazywało nagrań w gramatyce, bo głośnik
**przed** odpowiedzią podpowiada (wymaganie 4.6: próba ze wsparciem). Odczyt
**po** ocenie niczego nie podpowiada. Nowe brzmienie 2.13:

> THE lesson-generation flow SHALL NOT generate or require answer-audio
> (`target_audio`) for grammar exercises, and child lesson tasks SHALL NOT expose
> an answer-audio speaker before the answer. THE flow SHALL prepare a
> feedback-sentence recording (`feedback_audio`) for exercise types with a full
> sentence; it is disclosed only together with a graded answer's feedback and
> never blocks publication.

`docs/SPEC.md` §22: zdanie o gramatyce dostaje dopowiedzenie „…ani nie pokazują
głośnika przed odpowiedzią; po ocenionej odpowiedzi czytają pełne poprawne zdanie
(nagranie przygotowane przy publikacji)”. Wymaganie 4.6 bez zmian.

## 4. Pełne zdanie ćwiczenia (domena)

Nowa czysta funkcja `feedbackSentenceText(source)` w
`packages/server/src/domain/lessons/feedback-sentence-text.ts` (wzorem
`question-read-text.ts`). Wejście: pola zatwierdzonego payloadu. Wynik: tekst albo
`null`.

| Typ | Zdanie |
| --- | --- |
| `lesson_gap` | `stem` z luką (ciąg 2+ podkreśleń, jak `splitGap` w Kid UI) zastąpioną przez `answer`; tylko przy dokładnie jednej luce |
| `lesson_choice` | `stem` z jedną luką zastąpioną tekstem opcji wskazanej przez `correctOption`; bez luki → `null` |
| `lesson_order` | teksty `items` w kolejności kanonicznej, złączone spacją, bez spacji przed `.,!?` |
| `lesson_error_fix`, `lesson_transform`, `lesson_open_answer` | `answer` (pełne zdanie) |
| `lesson_cloze` (Uzupełnienie Etapu 3 rozdziału, 2026-10-31) | `fillCloze(clozeText, gapAnswers)` (`domain/lessons/cloze.ts`), gdy liczba odpowiedzi równa się liczbie luk i żadna nie jest pusta; inaczej `null` |
| pozostałe (`lesson_card`, `lesson_notice`, `lesson_short_answer`, `lesson_match`, `lesson_group`, `lesson_calculation`, `lesson_keywords`) | `null` |

Zasady wspólne: przycięcie i scalenie białych znaków, wynik pusty albo dłuższy niż
200 znaków → `null` (bez nagrania). Funkcja nie dokleja polskich poleceń ani
podpowiedzi (`hint`).

Uzupełnienie Etapu 3 rozdziału: `FeedbackSentenceSource` dostaje `clozeText` i
`gapAnswers`. Gramatyka nie ma `lesson_cloze`, a szkoła ma flagę `false`, więc ten
wiersz działa dziś tylko w rozdziale.

## 5. Przedmiot i media

- **Flaga przedmiotu:** `SubjectModule.ttsForFeedbackSentence: boolean` —
  `english_grammar: true`, `english_chapter: true` (od Etapu 3 rozdziału),
  `school: false`, testowy `history-like-subject: false`.
  Znaczenie `ttsForAnswers` (audio przed odpowiedzią) się nie zmienia i dla
  gramatyki pozostaje `false`.
- **Nowa rola zasobu rewizji `feedback_audio`:** migracja `0029` rozszerza
  `revision_assets_role_allowed`, schemat Drizzle i typ `AssetRole` w tym samym PR.
- **Uzgadnianie:** `requiredAssetsForLessonExercise` przy fladze i niepustym
  `feedbackSentenceText` dodaje `ttsAsset("feedback_audio", text, answerLocale,
  settings)` — bez stylu wypowiedzi (style działają dla `pl-PL`; en-GB dostaje
  instrukcję wymowy języka z #188, jak słówka). Fingerprint obejmuje tekst, więc
  zmiana zdania w edycji daje nowe nagranie, a niezmienione zdania zachowują swoje.
- **Publikacja nie czeka** na `feedback_audio` (jak `prompt_audio`): brak gotowego
  nagrania = brak odczytu. Nieudane nagranie nie jest utrzymywane przy
  `keepFailed` i nie blokuje walidacji publikacji.
- **Rodzic:** rola `feedback_audio` jest pomijana w DTO zasobów szkicu (jak
  `prompt_audio` w `lesson-api.ts`) — nie jest decyzją rodzica ani warunkiem
  publikacji. Tekst nagrania wynika wyłącznie z zatwierdzonej treści.
- **Worker:** oczekujące `feedback_audio` przedmiotu z wyłączoną flagą kończy się
  jako zastąpione (rozszerzenie reguły w `media-generation.ts`).
- **Stare lekcje:** „nowa wersja” (`createLessonDraftFromPublished`) kopiuje
  zasoby, a publikacja uzgadnia media i zleca brakujące `feedback_audio`.
  Weryfikacja w implementacji: publikacja kopii bez zmian treści działa w API
  i w `LessonEditor`; jeśli panel ją blokuje, minimalna poprawka w tym etapie.

## 6. Sesja (serwer)

Właściciel reguł: `learning/lessons` (materializacja i próby), media:
`materials`. Granica transakcji: istniejąca transakcja finalizacji próby.

- **Wydanie zadania:** ładowanie ćwiczeń (`lesson-sessions.ts`) rozwiązuje
  `feedback_audio` jak `prompt_audio` — dowolny gotowy zasób TTS o oczekiwanym
  fingerprincie (najnowsza generacja). Materializacja w treningu, przy fladze
  przedmiotu, zapisuje identyfikator w **prywatnym kluczu zadania**
  (`LessonTaskAnswerKey.feedbackAudioAssetId`). Prompt i Kid DTO zadania go nie
  niosą. Kartkówka go nie dostaje. Zadanie wydane, zanim nagranie było gotowe,
  zostaje bez odczytu (klucz jest niezmienny).
- **Odpowiedź:** w obu ścieżkach finalizacji (ocena deterministyczna i po
  werdykcie modelu oceniającego) feedback dostaje `correctAudioAssetId`, gdy
  jednocześnie:
  - feedback nie jest `null` (nie kartkówka, nie „Pomiń”);
  - `revealsAnswer(feedback)` — feedback ujawnia rozwiązanie własnego zadania
    (wyklucza `not_assessed` i podpowiedzi bez `correctText`);
  - feedback nie jest ofertą trenera precyzji (`lesson_precision_hint`);
  - klucz zadania ma `feedbackAudioAssetId`;
  - odpowiedź kończy zadanie (następny stan zadania nie jest `issued`) — np. `model_other`
    niepoprawne, które zostawia zadanie otwarte do ponowienia, nie dostaje nagrania,
    aby ponowienie nie było oznaczone jako wsparte `model_audio` (ustalenie z implementacji);
  - (Uzupełnienie Etapu 3 rozdziału, 2026-10-31 — bramka wariantu) feedback nie pokazuje
    `correctText` różnego od kanonicznego tekstu rozwiązania zadania (`correctTextFor`),
    np. „Prawie!” z najbliższym zatwierdzonym wariantem: dziecko nie ma usłyszeć innego
    zdania niż widzi. Bramka jest generyczna (`withFeedbackSentenceAudio`), więc obejmuje
    też gramatykę; bez nagrania nie ma też pieczęci `audio_issued`.
  Feedback z identyfikatorem zapisuje się w `attempts.feedback`, więc ponowny
  odczyt próby zwraca to samo.
- **Ekspozycja:** w tej samej transakcji, po `discloseLessonFeedback`, serwer
  pieczętuje zdarzenie `audio_issued` z ekspozycją `targetKey` i
  `occurredAt = max(now, receivedAt + 1 ms)` (wzorzec #187). Wspólny helper w
  `learning` zastępuje kopię kodu z `attempts.ts` słówek.
- **Samodzielność:** odczyt nie zmienia kwalifikacji. `assistanceFor` liczy tylko
  zdarzenia z `occurredAt <= receivedAt`, zadanie lekcji kończy jedna oceniona
  odpowiedź (bez retry po ocenie), a ekspozycja `targetKey` jest ta sama co
  feedbacku tekstowego. Zdanie ujawnia wyłącznie to, co już widać: bodziec
  i rozwiązanie z feedbacku. Zastrzeżenie: dla `lesson_open_answer`,
  `lesson_transform` i `lesson_error_fix` zaakceptowanych jako wariant (`great`,
  bez `correctText`) odczyt to zdanie kanoniczne, którego dziecko nie widziało
  na ekranie; ekspozycja (`targetKey`) jest jednak ta sama co feedbacku, więc
  kwalifikacja się nie zmienia. Bramka wariantu (wyżej) dotyczy tylko feedbacku z
  `correctText`; `great` bez niego nadal dostaje zdanie kanoniczne.
- **Kontrakt:** `FeedbackDto.correctAudioAssetId` bez zmiany schematu; komentarz
  uogólniony na „nagranie rozwiązania ujawniane wyłącznie w feedbacku”. Istniejąca
  reguła „`not_assessed` nie niesie audio” obowiązuje.

## 7. Kid UI

- **Automatyczny odczyt:** gdy feedback lekcji niesie `correctAudioAssetId`,
  kontroler sesji odtwarza nagranie raz, przez istniejący kanał odtwarzania
  (`#beginPlayback`, `mediaUrl`). Zablokowane autoodtwarzanie i błąd pliku nie
  pokazują komunikatu — zostaje przycisk.
- **Powtórka:** przycisk „Posłuchaj zdania” (`ListenButton`/`IconActionButton`,
  cel ≥ 48 px, tekst w katalogu komunikatów) w doku feedbacku lekcji; bez surowych
  `<button>`.
- **Tempo lekcji:** „Dalej” działa od razu i przerywa odczyt; nowe zadanie albo
  inne odtwarzanie (np. komunikat) przerywa poprzednie.
  Pobieranie następnego zadania w tle działa jak dziś.
- **Komunikat głosowy feedbacku** pozostaje ręczny — nie nakłada się na odczyt.
- **„Nie pamiętam” (ustalenie z implementacji):** w lekcjach, gdy wynik niesie
  nagranie, ekran zostaje na wyniku (dok + autoodtwarzanie + „Posłuchaj zdania”) aż
  do „Dalej”, zamiast przeskakiwać do następnego zadania; bez nagrania zostaje
  dotychczasowy przepływ.
- **Ikona komunikatu (ustalenie z implementacji):** gdy dok pokazuje „Posłuchaj
  zdania”, przycisk komunikatu głosowego używa obrysowanej ikony „?”
  (`GuidanceButton icon="question"`), by dziecko nie widziało dwóch identycznych
  głośników.
- **Responsywność:** przycisk mieści się w doku feedbacku w portrait, landscape
  telefonu, tablecie i desktopie (testy geometrii).

## 8. Prywatność

Do TTS trafia wyłącznie zdanie z zatwierdzonego materiału — bez danych dziecka.
Nagranie lektora jest wspólnym materiałem; usunięcie profilu usuwa zdarzenia
dziecka, nie nagrania.

## 9. Testy

- Domena: `feedbackSentenceText` — każdy typ z tabeli §4, wiele luk, brak luki,
  interpunkcja klocków, limit długości, białe znaki.
- Media (unit): gramatyka planuje `feedback_audio` dla typów ze zdaniem, szkoła
  nie; zmiana zdania zmienia fingerprint; `feedback_audio` nie blokuje publikacji
  i nie trafia do DTO rodzica.
- Integracja (PostgreSQL):
  - feedback niesie `correctAudioAssetId` dla dobrej, błędnej, „prawie”,
    „Nie pamiętam” i werdyktu modelu;
  - brak dla „Pomiń”, nieocenionej odpowiedzi, kartkówki, trenera precyzji
    i braku gotowego nagrania;
  - zapieczętowane `audio_issued` z `occurredAt > receivedAt`, próba pozostaje
    samodzielna;
  - ponowny odczyt próby zwraca to samo;
  - nowa wersja bez zmian treści zleca `feedback_audio`;
  - migracja `0029` przyjmuje rolę.
- E2E (Playwright, `mocked`): automatyczny odczyt po odpowiedzi, przycisk
  powtórki, „Dalej” przerywa odczyt, zablokowane autoodtwarzanie zostawia
  przycisk, brak przycisku bez nagrania; geometria przycisku w
  `kid-responsive`/specyfikacjach layoutu.
- Niezweryfikowane symulacją: autoodtwarzanie na fizycznym iPhonie/iPadzie
  (polityka autoplay Safari) — do raportu jako brak dowodu.

## 10. Dokumentacja i integracje

- Aktualizacja: `.kiro/specs/grammar-module/requirements.md` (2.13),
  `docs/SPEC.md` §22, `docs/architecture.md` (media lekcji, rola
  `feedback_audio`), krótka nota w specu stylu TTS (nagranie zdania bez stylu).
- API → MCP → `SKILL.md`: brak zmian. Feedback dziecka nie jest częścią MCP ani
  raportu Hermesa, a raport `learning-overview` świadomie nie obejmuje lekcji.
  Implementacja potwierdza to wyszukaniem użyć i opisuje w PR.

## 11. Kolejne etapy

Na tym nagraniu budują: (1) „Powtórz za lektorem”, (2) „Posłuchaj i uzupełnij”,
(3) wolniejsze odtwarzanie (zrobione w #199, 2026-11-01:
`docs/superpowers/specs/2026-11-01-sentence-readback-followups-design.md`). Niezależne od niego:
(4) historyjka na koniec lekcji, (5) wyjaśnienie błędu dla dziecka, (6) zdania o zainteresowaniach
dziecka.

**Stan (2026-11-01):** punkt 2 („Posłuchaj i uzupełnij”) zrealizowano jako ćwiczenie wyboru ze słuchu `lesson_listen_choice` („Posłuchaj i wybierz”, #198): to samo nagranie `feedback_audio` jest bodźcem przed odpowiedzią, a dziecko wybiera brakującą formę z opcji zamiast ją wpisywać (wariant z wpisywaniem pozostaje poza zakresem). Projekt: `docs/superpowers/specs/2026-11-01-lesson-listen-choice-design.md`.
