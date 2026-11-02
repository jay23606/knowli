# Requirements — moduł nauki gramatyki (czasy i konstrukcje)

## Wprowadzenie

Umiem! wspiera dziś naukę pojedynczych słówek. Moduł gramatyki dodaje naukę czasów i konstrukcji gramatycznych angielskiego (pierwszy temat: Present Simple) na materiale, który dziecko aktualnie przerabia w szkole. Rodzic wybiera temat gramatyczny i wkleja słówka/zwroty z rozdziału podręcznika; system przygotowuje lekcję z wyjaśnieniem reguł i pulą ćwiczeń do zatwierdzenia. Dziecko uczy się interaktywnie: najpierw krótkie wyjaśnienie, potem ćwiczenia od rozpoznania do samodzielnego budowania zdań, z informacją zwrotną wskazującą, co było źle.

Moduł jest uniwersalny na dwóch poziomach: (1) tematy gramatyczne, reguły i kategorie błędów są danymi katalogu, więc kolejny czas nie wymaga zmian w kodzie; (2) silnik lekcji nie zakłada gramatyki ani języka angielskiego — gramatyka angielska jest pierwszym przedmiotem podłączonym przez interfejs przedmiotu, a docelowo ten sam silnik obsłuży historię, biologię czy geografię (wymaganie 11). W kodzie reguła gramatyki jest „celem nauki” (objective), a lekcja rodzajem zestawu `lesson`.

Moduł świadomie zmienia zasady SPEC §10 i A36 (brak LLM w sesji), §30 (ocena odpowiedzi otwartych poza MVP) oraz §26 (dane wysyłane do usług) — w zakresie opisanym w wymaganiu 6. Pozostałe zasady SPEC i architecture.md obowiązują bez zmian.

Słowniczek:
- **Temat** — czas lub konstrukcja gramatyczna (np. Present Simple, Past Simple, *there is/are*).
- **Reguła** — najmniejsza sprawdzana jednostka wiedzy w temacie (np. „-s w 3. osobie l.p.”).
- **Katalog** — wersjonowany zbiór tematów, reguł, kart wyjaśnienia i kategorii błędów.
- **Lekcja** — zestaw dla jednego tematu z pulą ćwiczeń zatwierdzoną przez rodzica.
- **Element sprawdzany** — fragment odpowiedzi, w którym stosuje się reguła ćwiczenia (np. *plays*, *doesn't play*).
- **Ćwiczenie niewidziane** — ćwiczenie, którego odpowiedź (klucz `target_key`) nie była dotąd ujawniona dziecku w żadnym kontekście.
- **Model oceniający** — konfigurowalny model LLM oceniający odpowiedzi niedopasowane do zatwierdzonych wariantów.

## Wymagania

### Wymaganie 1 — Uniwersalny katalog tematów

**User story:** Jako rodzic chcę wybierać różne czasy i konstrukcje, z których dziecko ma sprawdzian, aby moduł pomagał przez cały rok szkolny, a nie tylko przy jednym temacie.

#### Kryteria akceptacji

1. THE system SHALL przechowywać tematy gramatyczne jako wersjonowane dane katalogu, w których każdy temat definiuje reguły, karty wyjaśnienia, dozwolone typy ćwiczeń, polecenia przekształceń oraz kategorie błędów z szablonami podpowiedzi.
2. WHEN do katalogu zostanie dodany nowy temat, THE system SHALL umożliwić tworzenie lekcji z tego tematu bez zmian w silniku oceny, selektorze zadań, kontraktach Kid API i widokach dziecka.
3. THE kategorie błędów SHALL być danymi katalogu (kody tekstowe walidowane rejestrem): katalog zawiera wspólny zbiór bazowy, a temat może dodać własne kategorie; każda reguła wskazuje, które kategorie jej dotyczą.
4. THE katalog startowy SHALL zawierać temat Present Simple z regułami: forma podstawowa (I/you/we/they), -s w 3. osobie l.p., pisownia -es/-ies, przeczenie don't/doesn't, pytanie Do/Does, krótkie odpowiedzi, forma podstawowa po does/doesn't.
5. THE system SHALL walidować katalog automatycznym testem (unikalne identyfikatory, istniejące kategorie, kompletne karty i szablony podpowiedzi dla każdej kategorii każdej reguły).
6. WHEN treść karty wyjaśnienia lub szablonu podpowiedzi zostanie zmieniona, THE system SHALL zachować postęp dziecka w regule; WHEN zmieni się znaczenie reguły, THE katalog SHALL nadać jej nowy identyfikator; THE katalog SHALL zachowywać poprzednie wersje tematów używane przez opublikowane lekcje.

### Wymaganie 2 — Tworzenie lekcji z materiału podręcznika

**User story:** Jako rodzic chcę wkleić słówka i zwroty z rozdziału podręcznika i wybrać temat gramatyczny, aby dziecko ćwiczyło gramatykę na dokładnie tym materiale, który przerabia w szkole.

#### Kryteria akceptacji

1. WHEN rodzic tworzy lekcję, THE panel rodzica SHALL pozwolić wybrać temat z katalogu, wkleić materiał tekstowy (do 8000 znaków), dodać opcjonalną instrukcję, wybrać reguły (domyślnie wszystkie) i wielkość puli (domyślnie większa z liczb 60 i 12 × liczba wybranych reguł, zakres 20–120). Wielkość puli dotyczy ćwiczeń etapów; generowanie dodaje do 2 ćwiczeń wyboru ze słuchu (`lesson_listen_choice`) na regułę ponad nią.
2. WHEN rodzic zleci generowanie, THE system SHALL utworzyć szkic lekcji i trwałe zadanie generowania w jednej transakcji, z kluczem idempotencji jak przy generowaniu zestawów słówek.
3. THE generowanie SHALL tworzyć ćwiczenia jednoregułowe wyłącznie dla wybranych reguł i typów dozwolonych w katalogu, używając słownictwa z materiału rodzica tam, gdzie to możliwe.
4. THE generowanie SHALL tworzyć 2–3 przykłady zdań na regułę do kart wyjaśnienia; teksty reguł pochodzą z katalogu, nie z modelu.
5. WHEN wygenerowane ćwiczenie nie przejdzie walidacji, THE system SHALL odrzucić tylko to ćwiczenie, zapisać pozostałe i pokazać rodzicowi liczbę odrzuconych.
6. IF generowanie zakończy się błędem, THEN THE system SHALL nie publikować częściowej lekcji i pozwolić rodzicowi ponowić generowanie lub dogenerować brakujące ćwiczenia.
7. THE moduł SHALL NOT tworzyć zestawu słówek z materiału lekcji; słówka pozostają osobnym zestawem tworzonym przez rodzica.
8. THE prompt `lesson_open_answer` SHALL zawierać polski tekst źródłowy do przetłumaczenia, a odpowiedź i warianty SHALL być po angielsku; walidator SHALL odrzucić prompt równy odpowiedzi lub jej wariantowi po normalizacji.
9. WHEN luka uzupełnia operator, THE walidator SHALL sprawdzić operator, podmiot i czasownik w ukończonym zdaniu, dopuszczając krótkie odpowiedzi bez wymaganego czasownika głównego.
10. WHEN provider odrzuci żądanie przez błąd konfiguracji, wyczerpany limit, odmowę lub błędny format, THE system SHALL zakończyć run bez automatycznego ponawiania i bez zapisywania częściowej treści.
11. WHEN provider zgłosi przejściowy błąd lub limit szybkości, THE system SHALL zaplanować ograniczone retry z wykładniczym opóźnieniem i jitterem; poprawne `Retry-After` nie może zostać skrócone, a restart workera zachowuje termin ponowienia.
12. WHEN rodzic ręcznie ponowi oczekujący run, THE system SHALL wyczyścić termin odroczenia i pozwolić na natychmiastowy claim.
13. THE lesson-generation flow SHALL NOT generate or require answer-audio (`target_audio`) for grammar exercises. THE flow SHALL prepare a feedback-sentence recording (`feedback_audio`) for exercise types with a full sentence; it never blocks publication. Child lesson tasks SHALL NOT expose a sentence recording before the answer, except in the listen-and-choose type (`lesson_listen_choice`), where the recording is the stimulus: it is disclosed only through the server's disclosure authorization (requirement 4.6 — sealed exposure, assisted attempt), and the type is never issued without a ready recording.

### Wymaganie 3 — Przegląd i publikacja lekcji

**User story:** Jako rodzic chcę przejrzeć i poprawić ćwiczenia przed udostępnieniem dziecku, aby dziecko nie uczyło się z błędnego materiału.

#### Kryteria akceptacji

1. THE panel rodzica SHALL pokazywać ćwiczenia pogrupowane według reguł, z zaznaczonym elementem sprawdzanym, z możliwością edycji odpowiedzi, wariantów akceptowanych, opcji, klocków i elementu sprawdzanego oraz usuwania ćwiczeń.
2. THE panel rodzica SHALL pozwolić dogenerować ćwiczenia dla wybranej reguły i zatwierdzić wszystkie ćwiczenia reguły jednym działaniem.
3. THE panel rodzica SHALL pokazywać karty wyjaśnienia (tekst z katalogu) z przykładami z lekcji do akceptacji lub edycji.
4. WHEN rodzic publikuje lekcję, THE system SHALL wymagać dla każdej wybranej reguły co najmniej 3 ćwiczeń prowadzonych, 4 produktywnych i 2 tłumaczeń; w przeciwnym razie publikacja jest odrzucana z listą reguł i brakujących etapów.
5. THE lekcja SHALL przechodzić cykl szkicu identyczny jak zestaw słówek: draft → review (po udanym generowaniu) → published; niezatwierdzony szkic jest niewidoczny dla dziecka, opublikowana treść i kontekst lekcji są niezmienne, edycja tworzy nowy szkic, a aktywna sesja zachowuje swoją wersję.
6. THE lekcja SHALL być przypisywana dzieciom z opcjonalnym terminem sprawdzianu tak jak zestaw słówek.

### Wymaganie 4 — Typy ćwiczeń

**User story:** Jako dziecko chcę różnych ćwiczeń, od łatwych do trudnych, aby naprawdę zrozumieć regułę, a nie zapamiętać odpowiedzi.

#### Kryteria akceptacji

1. THE system SHALL obsługiwać typy: karta wyjaśnienia, wskazanie zmieniającego się słowa, wybór formy, układanie zdania z klocków, krótka odpowiedź, uzupełnienie luki, poprawienie błędu, przekształcenie zdania (polecenie z katalogu tematu), tłumaczenie zdania z polskiego i wybór formy ze słuchu (`lesson_listen_choice`: dziecko słyszy pełne zdanie, widzi je z luką i wybiera brakującą formę).
2. THE karta wyjaśnienia SHALL kończyć się działaniem „Dalej”, bez próby, oceny i zużycia budżetu ocenianych zadań.
3. THE typy zamknięte (wskazanie, wybór, wybór formy ze słuchu, klocki, krótka odpowiedź z opcjami) SHALL być oceniane deterministycznie po identyfikatorach odpowiedzi; układanie z klocków ma jeden kanoniczny porządek.
4. THE cała ścieżka lekcji SHALL działać bez mikrofonu.
5. THE pola tekstowe SHALL mieć wyłączoną autokorektę, sprawdzanie pisowni, autouzupełnianie i automatyczną kapitalizację w zakresie dostępnym na urządzeniu.
6. WHEN dziecko odtworzy audio zdania przed odpowiedzią — w ćwiczeniu tekstowym albo w wyborze formy ze słuchu — THE system SHALL zapisać ekspozycję przed wydaniem audio i zakwalifikować próbę jako wspomaganą; odpowiedź w wyborze ze słuchu bez wcześniejszego odsłuchu SHALL być nieoceniona.

### Wymaganie 5 — Interaktywny przebieg nauki

**User story:** Jako rodzic chcę, aby dziecko najpierw dostało wyjaśnienie, a potem ćwiczyło stopniowo i wracało do reguły po błędzie, aby nauka była interaktywna, a nie przeklikiwaniem.

#### Kryteria akceptacji

1. WHEN dziecko zaczyna regułę, THE system SHALL pokazać jej karty wyjaśnienia, a następnie ćwiczenie wskazania.
2. THE system SHALL prowadzić regułę przez etapy: prowadzony (wybór, klocki, krótka odpowiedź), produktywny (luka, poprawienie błędu, przekształcenie) i samodzielny (tłumaczenie oraz typy produktywne na ćwiczeniach niewidzianych). Wybór formy ze słuchu jest dodatkowym ćwiczeniem poza etapami: nie wprowadza reguły, jest zawsze wspomagany, jego wynik jest neutralny dla etapu i nie otwiera cyklu wsparcia (najwyżej jedno na regułę i dwa na sesję, tylko z gotowym nagraniem).
3. WHEN dziecko odpowie poprawnie na dwa kolejne ćwiczenia etapu, THE system SHALL przejść do następnego etapu tej reguły.
4. THE sesja SHALL wprowadzać najwyżej dwie nowe reguły i zachować istniejący budżet sesji (12 ocenianych zadań, 10 minut, bez dokładania zadań po zapowiedzi „Jeszcze 3”); opanowanie całego tematu jest rozłożone na wiele sesji, a okno sprawdzianu nie zwiększa budżetu.
5. WHEN odpowiedź jest błędna w zakresie reguły, THE system SHALL pokazać zaznaczony błędny fragment, podpowiedź z szablonu kategorii błędu i poprawną odpowiedź, a następnie krótką kartę przypomnienia reguły i jedno łatwiejsze ćwiczenie tej reguły — najwyżej jeden taki cykl na regułę i sesję.
6. WHEN dziecko wybierze „Nie pamiętam”, THE system SHALL pokazać poprawną odpowiedź i uruchomić ten sam cykl wsparcia, zapisując trudność bez kategorii błędu.
7. THE system SHALL wybierać ćwiczenia niewidziane przez dziecko albo widziane najdawniej.
8. WHILE trwa okno przygotowania do sprawdzianu (48 h przed terminem), THE system SHALL preferować etap samodzielny dla nieopanowanych reguł.

### Wymaganie 6 — Ocena odpowiedzi tekstowych

**User story:** Jako rodzic chcę, aby system ocenił też poprawną odpowiedź sformułowaną inaczej niż w kluczu i wyjaśnił dziecku, co było źle, aby dziecko nie było karane za poprawne zdanie i wiedziało, co poprawić.

#### Kryteria akceptacji

1. THE system SHALL najpierw porównać odpowiedź tekstową z zatwierdzonymi wariantami po normalizacji: NFC, przycięcie, ujednolicenie apostrofów, pominięcie wielkości liter i interpunkcji, zwinięcie spacji oraz rozwinięcie skrótów angielskich (np. *doesn't* = *does not*; skrót wieloznaczny pasuje do każdego rozwinięcia); rozwinięcie następuje przed podziałem na słowa.
2. WHEN odpowiedź jest zgodna z zatwierdzonym wariantem, THE system SHALL ocenić ją jako poprawną bez wywołania modelu oceniającego.
3. WHEN odpowiedź różni się od zatwierdzonego wariantu wyłącznie drobną literówką w jednym słowie spoza elementu sprawdzanego (najwyżej jedna operacja liter, dwie dla słów dłuższych niż 6 znaków), THE system SHALL bez wywołania modelu zaliczyć regułę z informacją „Prawie!” i zaznaczyć literówkę.
4. WHEN błąd dotyczy elementu sprawdzanego, THE system SHALL nie zaliczyć reguły, nawet jeśli błąd jest jedną literą.
5. WHEN odpowiedź nie jest dopasowana, a dla tego ćwiczenia i tej znormalizowanej odpowiedzi istnieje zapisany werdykt, THE system SHALL użyć zapisanego werdyktu.
6. WHEN odpowiedź nie jest dopasowana, brak zapisanego werdyktu, model oceniający jest skonfigurowany i limit wywołań sesji (domyślnie 20) nie jest wyczerpany, THE system SHALL poprosić model oceniający o werdykt `correct | almost | incorrect`, kategorię błędu z listy reguły ćwiczenia, błędne fragmenty jako dokładne podciągi odpowiedzi dziecka i krótki komentarz dla rodzica.
7. THE system SHALL odrzucić wynik modelu, który nie pasuje do schematu, wskazuje kategorię spoza reguły ćwiczenia, zawiera fragment niewystępujący w odpowiedzi dziecka albo przypisuje kategorię błędu werdyktowi `correct`.
8. IF model oceniający nie jest skonfigurowany, przekroczy limit czasu (domyślnie 8 s), zwróci błąd lub odrzucony wynik albo limit wywołań jest wyczerpany, THEN THE system SHALL ocenić odpowiedź jako nieocenioną, bez kary i bez przerwania serii sukcesów, z możliwością ponowienia lub przejścia dalej.
9. THE werdykt `almost` SHALL zaliczać regułę, gdy błąd jest drobny i nie dotyczy elementu sprawdzanego; feedback pokazuje zaznaczony fragment i poprawną odpowiedź.
10. THE system SHALL zapisać zwalidowany werdykt modelu dla pary (ćwiczenie, znormalizowana odpowiedź, wersja promptu), aby ta sama odpowiedź zawsze dostawała ten sam werdykt.
11. THE system SHALL pokazywać dziecku wyłącznie zatwierdzoną poprawną odpowiedź i podpowiedź z szablonu katalogu; komentarz modelu widzi tylko rodzic.
12. THE system SHALL wysyłać do modelu oceniającego tylko treść ćwiczenia, regułę i odpowiedź dziecka (do 200 znaków), bez imienia, wieku ani identyfikatorów dziecka.
13. THE kontekst kwalifikacji próby SHALL być zamrożony przy przyjęciu odpowiedzi, przed wywołaniem modelu; ponowienie wysyłki tej samej odpowiedzi nie może wywołać modelu drugi raz, utworzyć drugiej próby ani zużyć limitu wywołań.
14. THE wywołanie modelu SHALL zużywać limit sesji w chwili rozpoczęcia wywołania, także gdy zakończy się błędem lub odrzuconym wynikiem.
15. THE model oceniający SHALL być konfigurowany w procesie serwera przez adres endpointu zgodnego z OpenAI, token i nazwę modelu; token SHALL NOT trafiać do przeglądarki, logów ani DTO.

### Wymaganie 7 — Postęp per reguła i opanowanie

**User story:** Jako rodzic chcę widzieć, które reguły dziecko stosuje samodzielnie, aby wiedzieć, co powtórzyć przed sprawdzianem.

#### Kryteria akceptacji

1. THE system SHALL śledzić postęp osobno dla każdego dziecka i reguły, jako projekcję odtwarzalną z historii ocen.
2. THE próba SHALL być niezależna dla reguły tylko wtedy, gdy jest pierwszą odpowiedzią w zadaniu, bez wsparcia, a odpowiedź ćwiczenia (jej `target_key`) nie była wcześniej ujawniona temu dziecku w żadnym zadaniu, lekcji ani kartkówce.
3. THE reguła SHALL być opanowana po trzech ostatnich kwalifikujących sukcesach na różnych ćwiczeniach, z których co najmniej jeden nastąpił w późniejszej sesji, innego dnia i po co najmniej 12 godzinach.
4. WHEN dziecko popełni błąd w zakresie reguły lub wybierze „Nie pamiętam” w niezależnym zastosowaniu, THE system SHALL przerwać serię sukcesów tej reguły; opanowana reguła przechodzi do „do ponownego potwierdzenia”.
5. THE odpowiedź nieoceniona i pominięcie SHALL NOT zwiększać ani przerywać serii sukcesów.
6. THE panel postępu lekcji SHALL pokazywać dla każdej reguły status (nie sprawdzono, ćwiczy, do potwierdzenia, opanowana) oraz najczęstsze kategorie błędów z przykładami odpowiedzi dziecka.
7. THE interfejs dziecka SHALL NOT pokazywać procentów, statusów technicznych ani informacji o tym, czy ocenę wykonał model.
8. THE istniejące widoki i projekcje postępu słówek SHALL NOT obejmować lekcji gramatyki i ich zachowanie dla zestawów słówek pozostaje bez zmian.

### Wymaganie 8 — Nadzór rodzica nad werdyktami modelu

**User story:** Jako rodzic chcę widzieć i poprawiać oceny wykonane przez model, aby błędna ocena nie utrwaliła się.

#### Kryteria akceptacji

1. THE panel rodzica SHALL pokazywać listę odpowiedzi ocenionych przez model w lekcji: odpowiedź, werdykt, kategorię i komentarz.
2. WHEN rodzic zmieni werdykt, THE system SHALL stosować nowy werdykt dla przyszłych identycznych odpowiedzi i SHALL NOT zmieniać zakończonych ocen ani wstecznie przeliczać postępu; panel oznacza oceny, których werdykt zmieniono później.
3. WHEN rodzic zaakceptuje odpowiedź jako poprawną, THE system SHALL pozwolić dodać ją jako zatwierdzony wariant w następnym szkicu lekcji.

### Wymaganie 9 — Próbna kartkówka z gramatyki

**User story:** Jako rodzic chcę zrobić dziecku próbną kartkówkę z tematu, aby sprawdzić gotowość do sprawdzianu.

#### Kryteria akceptacji

1. THE tryb próbnej kartkówki SHALL działać dla lekcji gramatyki na istniejących zasadach: zamrożona porcja, jedna odpowiedź na zadanie, brak feedbacku w trakcie, limit czasu i omówienie po zamknięciu.
2. WHEN rodzic włącza kartkówkę dla przypisania lekcji gramatyki, THE system SHALL używać celu „gramatyka” niedostępnego dla zestawów słówek; cele słówek są niedostępne dla lekcji gramatyki.
3. THE plan kartkówki SHALL obejmować wszystkie reguły lekcji proporcjonalnie, preferując ćwiczenia niewidziane i typy produktywne; ćwiczenia wydane w kartkówce stają się widziane także dla nauki.
4. THE raport kartkówki SHALL pokazywać wynik per reguła, kategorie błędów i oznaczenie ocen wykonanych przez model.

### Wymaganie 10 — Prywatność, raport Hermesa i dokumentacja

**User story:** Jako właściciel chcę, aby nowy moduł nie łamał prywatności ani istniejących integracji.

#### Kryteria akceptacji

1. THE panel rodzica SHALL informować, do której usługi trafiają odpowiedzi tekstowe dziecka, gdy model oceniający jest skonfigurowany.
2. WHEN profil dziecka zostanie usunięty, THE system SHALL usunąć jego próby, oceny i postęp reguł; zapisane werdykty celowo pozostają jako część wspólnego materiału ćwiczenia i nie zawierają identyfikatora dziecka ani danych profilu.
3. THE kontrakt `learning-overview` w wersji 1 i jego JSON Schema SHALL pozostać bez zmian: odczyt raportu pomija lekcje gramatyki (postęp, kartkówki, planowane sprawdziany), a `SKILL.md` informuje, że raport nie obejmuje jeszcze gramatyki.
4. THE dokumentacja (SPEC, architecture.md, AGENTS.md) SHALL zostać zaktualizowana o zmienione zasady dotyczące oceny modelem i danych wysyłanych do usług.


### Wymaganie 11 — Rozszerzalność na inne przedmioty

**User story:** Jako właściciel chcę, aby silnik lekcji dało się użyć dla historii, biologii czy geografii bez przepisywania nauki, oceny i postępu, aby kolejne przedmioty były dodawane jako moduły.

#### Kryteria akceptacji

1. THE silnik lekcji (typy ćwiczeń, ocena, postęp per cel, selektor, pula, kartkówka, kontrakty Kid API, widoki dziecka) SHALL NOT zawierać logiki specyficznej dla języka angielskiego ani gramatyki.
2. THE przedmiot SHALL być podłączany przez jeden interfejs dostarczający: katalog tematów i celów, dozwolone typy ćwiczeń, normalizator odpowiedzi, kategorie błędów, profil promptów generacji i oceny, walidator ćwiczeń oraz język odpowiedzi i poleceń.
3. THE gramatyka angielska SHALL być zaimplementowana wyłącznie jako taki moduł przedmiotu; reguły specyficzne dla angielskiego (np. rozwijanie skrótów) należą do modułu, nie do silnika.
4. THE system SHALL mieć test, w którym przykładowy przedmiot nie-językowy (fixture testowy) przechodzi walidację, generowanie (fake provider) i ocenę bez zmian w silniku.
5. THE silnik SHALL NOT importować modułów przedmiotów inaczej niż przez rejestr; zależność sprawdza test architektoniczny.
