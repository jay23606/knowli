# SPEC.md — Rodzinny asystent nauki AI

Wersja: 1.1 — po przeglądzie i zaakceptowanych poprawkach  
Data: 7 października 2026 r.  
Pierwszy moduł: angielskie słownictwo dla dzieci  
Docelowa forma: prywatna, self-hostowana aplikacja webowa / PWA

## 1. Status i cel dokumentu

Dokument łączy pierwotną specyfikację z późniejszymi ustaleniami. Zastępuje jej sprzeczne fragmenty: pojedynczą liniową ścieżkę opanowania karty, odłożenie profili dzieci i pisowni poza MVP oraz utożsamianie znajomości słowa z oceną wymowy.

Wersja 1.1 doprecyzowuje wpływ niedawnych podpowiedzi, edycji materiału i kolejności wyników na postęp, obsługę „Nie pamiętam”, znaczenie odsłuchów, ocenę pisowni oraz obowiązkowy zakres ilustracji w MVP.

To specyfikacja produktu i jego wymagań. Nie jest projektem architektury, fizycznym schematem bazy danych ani planem implementacji. Fragmenty TypeScript i JSON opisują kontrakty oraz znaczenie danych; nie narzucają ich dokładnej implementacji.

Wymagania opisane jako „musi”, „w MVP” i „nie” określają zakres. Parametry oznaczone jako **domyślna reguła początkowa** są propozycją wykonawczą do późniejszej kalibracji. Nie stanowią zweryfikowanej miary skuteczności nauczania.

## 2. Wizja produktu

Rodzic dostarcza temat lub materiał, którego dziecko ma się nauczyć. AI przygotowuje materiał, rodzic zatwierdza go, a aplikacja prowadzi dziecko przez naukę i zapamiętuje konkretne trudności.

Pierwszym i najważniejszym zastosowaniem jest nauka angielskiego przez 8-letnie dziecko, które ma trudności z zapamiętywaniem szkolnego materiału. Aplikacja ma przygotowywać również do pisemnych sprawdzianów.

Przykład polecenia rodzica:

> Dni tygodnia po angielsku. Syn ma 8 lat, jest początkujący. Jutro ma sprawdzian.

Aplikacja przygotowuje słowa, tłumaczenia, proste przykłady, wymowę, odpowiednie pomoce wizualne oraz ćwiczenia. Kolejne sesje uwzględniają to, co dziecko rozpoznaje, potrafi samodzielnie przypomnieć, wymówić i zapisać.

Produkt nie ma być kolejnym Duolingo, rozbudowanym Anki ani platformą gotowych kursów. Jego wartością jest dopasowanie nauki do konkretnego szkolnego materiału i konkretnego dziecka.

## 3. Zasady produktu

1. Najpierw uczymy, potem sprawdzamy.
2. Prostota interfejsu dziecka jest ważniejsza od liczby funkcji.
3. Rodzic podaje cel i zatwierdza materiał; nie musi ręcznie projektować ćwiczeń.
4. Rozpoznawanie, przypominanie, wymowa i pisownia są odrębnymi umiejętnościami.
5. Trudności zwiększają potrzebę wsparcia, a nie karę dla dziecka.
6. Błąd techniczny lub niepewna ocena nie jest błędem ucznia.
7. AI przygotowuje treść; przewidywalny algorytm prowadzi sesję.
8. Integracje AI są wymienne i oddzielone od domeny nauki.
9. Najpierw pełny, działający przebieg MVP; później kolejne moduły.
10. Projekt pozostaje prostym modularnym monolitem, bez mikroserwisów.

## 4. Użytkownicy i profile dzieci — MVP

### Rodzic

Tworzy profile, zestawy i przypisania, zatwierdza treść oraz przegląda postępy. Panel rodzica jest chroniony PIN-em lub prostym hasłem, weryfikowanym po stronie serwera.

### Dziecko

Korzysta z prostego trybu nauki bez indywidualnego konta, adresu e-mail i hasła. Wybiera swój profil, a następnie temat.

Profil zawiera:

- trwały identyfikator;
- nazwę wyświetlaną;
- prosty awatar;
- opcjonalny wiek albo rok urodzenia — nie potrzeba pełnej daty urodzenia.

Przy jednym profilu ekran wyboru jest pomijany. Przy wielu profilach wybór musi być czytelny i umożliwiać prostą zmianę dziecka przed rozpoczęciem sesji.

Jeden zestaw może być przypisany do wielu dzieci. Treść i pliki audio mogą być współdzielone. Historia prób, pomyłki, postęp i terminy powtórek zawsze należą do konkretnego dziecka. Termin sprawdzianu należy do przypisania zestawu dziecku, ponieważ dzieci mogą uczyć się tego samego materiału na różne daty.

Wybór profilu jest wyborem ucznia, nie mechanizmem silnego uwierzytelnienia.

### Nawigacja rodzic ↔ dziecko

- Adres `/` otwiera aplikację dziecka (ekran wyboru profilu), a `/parent` panel rodzica.
- Sekcje panelu rodzica mają własne adresy: `/parent/decks`, `/parent/sources`, `/parent/children`, `/parent/progress`, `/parent/work-card` (2026-10-29; „Źródła” od Etapu 2, §37). `/parent` i nieznana sekcja prowadzą do `/parent/decks`. Otwarty zestaw ma adres `/parent/decks/{deckId}`, otwarte źródło `/parent/sources/{sourceId}`, a formularz nowej lekcji `/parent/lessons/new` (ze źródła: `/parent/lessons/new?source={sourceId}&subject={subjectId}`); nieznany zestaw pokazuje komunikat z powrotem do listy, a nieznane źródło — komunikat z powrotem do listy źródeł. Odświeżenie zachowuje widok, a „wstecz”/„dalej” przeglądarki przechodzą między widokami (np. z edytora do listy zestawów); przy niezapisanych zmianach w edytorze „wstecz” najpierw pyta o wyjście. Logowanie pokazuje się pod tym samym adresem i po zalogowaniu wraca do wskazanej sekcji.
- Na telefonie (< 600 px) sekcje są w dolnym pasku nawigacji, a „Do nauki”, wybór wyglądu (Auto/Jasny/Ciemny, zapamiętany w przeglądarce) i wylogowanie w menu ⋯; od 600 px sekcje są zakładkami pod nagłówkiem, a akcje w nagłówku. Wygaśnięcie sesji przy niezapisanych zmianach otwiera logowanie w oknie nad edytorem bez utraty formularza.
- Panel rodzica udostępnia przy każdym profilu link rozpoczynający naukę tego dziecka. Prowadzi on do `/kids/{childId}/learn`, gdzie `childId` jest trwałym identyfikatorem profilu, a nie jego zmienną nazwą wyświetlaną.
- Wejście przez `/kids/{childId}/learn` wybiera wskazany istniejący profil bez dodatkowego ekranu wyboru. Nieistniejący lub usunięty profil prowadzi do wyboru dostępnego profilu.
- Adres `/` stanowi wspólne wejście do nauki: zawsze pokazuje wybór profilu dziecka, także przy jednym profilu.
- Ekrany wyboru profilu oraz talii dziecka udostępniają link „Strefa rodzica” prowadzący do `/parent`. W trakcie trwania sesji ćwiczeń link ten jest ukryty, by nie rozpraszać dziecka. Panel rodzica udostępnia link powrotny „Do nauki” prowadzący do `/`.

## 5. Parent Mode — MVP

Rodzic może:

- utworzyć i edytować profil dziecka;
- podać temat i opis celu nauki;
- wybrać dzieci, którym zostanie przypisany zestaw;
- opcjonalnie ustawić termin sprawdzianu dla każdego przypisania;
- wygenerować zestaw za pomocą AI;
- utworzyć pusty szkic bez wywołania AI i ręcznie wprowadzić pierwsze słówka;
- przejrzeć i poprawić słowa, tłumaczenia, przykłady oraz pomoce wizualne;
- ręcznie dodać lub usunąć element zestawu;
- zapisać sam tytuł pustego szkicu; publikacja wymaga co najmniej jednego kompletnego, zapisanego elementu;
- odsłuchać wygenerowaną wymowę;
- zatwierdzić i udostępnić zestaw;
- wycofać zestaw z nauki;
- zobaczyć postępy i najczęstsze trudności wybranego dziecka.

Panel rodzica (redesign 2026-10, od 2026-10-29 na Mantine) ma wspólną ramę: pasek aplikacji z nazwą, przełącznikiem schematu kolorów (automatyczny / jasny / ciemny, zapamiętywany na urządzeniu) i wylogowaniem oraz sekcje Zestawy / Źródła / Dzieci / Postępy / Karta pracy ze stanem aktywnym — na telefonie jako dolny pasek nawigacji, na szerszym ekranie jako zakładki. Cały panel działa w obu schematach kolorów; potwierdzenia (usunięcie profilu, wyjście z niezapisanymi zmianami, usunięcie lekcji z listy, usunięcie przypisania) są oknami panelu, nie oknami przeglądarki. Edytory zestawu i lekcji mają przypięty pasek akcji („Zapisz zmiany” / „Publikuj” albo „Utwórz nową wersję”) z wierszem stanu, a błąd sekcji (okładka, karta, przypisanie dziecka) pokazuje się przy niej. Edytor lekcji dzieli opublikowaną lekcję na zakładki „Ćwiczenia” oraz „Dzieci i postęp” (przypisania i nadzór). Tworzenie materiału (generacja, pusty zestaw, nowa lekcja) żyje w oknie modalnym „Nowy materiał"; lista zestawów jest pogrupowana po stanie (Wymaga Twojej uwagi → Gotowe do nauki → Szkice → Archiwum) z meta pozycji i przypisanych dzieci. Filtry dziecka w Postępach ładują dane automatycznie; wygaśnięcie sesji wraca do logowania. Sekcja Dzieci pokazuje karty profili (na telefonie w jednej kolumnie) z edycją profilu i progami wymowy w karcie; usunięcie profilu wymaga potwierdzenia w oknie, a niezapisany formularz profilu, progów albo nowego dziecka chroni przed wyjściem z sekcji tak jak edytory.

Szkic wygenerowany przez AI nie jest automatycznie dostępny dziecku. Po edycji opublikowanej treści nowa wersja również wymaga zatwierdzenia. Historyczne odpowiedzi muszą nadal odnosić się do treści, którą dziecko faktycznie widziało.

Edytor zestawu chroni lokalne, niezapisane poprawki przy zmianie zakładki,
powrocie i wylogowaniu. Po konflikcie wersji pokazuje osobno formularz lokalny
i najnowszą wersję; nie ponawia zapisu automatycznie z nowszym numerem edycji.
Wczytanie wersji zdalnej wymaga potwierdzenia i pozostawia porównanie do
ręcznego przeniesienia wybranych zmian. Jeśli szkic został już opublikowany,
rodzic zaczyna nową wersję przed ponownym zapisem.

Po niepewnym wyniku wysłania generacji rodzic może ponowić dokładnie to samo
polecenie z tym samym kluczem idempotencji. Niepoprawne lub nieczytelne
potwierdzenie 202 nie otwiera zestawu. Poprawne identyfikatory otwierają edytor
niezależnie od odświeżenia listy; nowe świadome generowanie otrzymuje nowy klucz.

Zasady wpływu edycji na postęp:

- Zmiany kosmetyczne, np. ilustracji, formatowania lub opisu zestawu, zachowują postęp.
- Zmiana uczonego angielskiego słowa wymaga ponownego sprawdzenia związanych z nim umiejętności. Zmiana znaczenia lub tłumaczenia wymaga ponownego sprawdzenia rozpoznawania i przypominania; przy niezmienionym angielskim słowie można zachować wyniki wymowy i pisowni.
- Zmiana dopuszczalnych odpowiedzi lub reguł pisowni wymaga ponownego sprawdzenia umiejętności, których dotyczy. Nie nadpisuje automatycznie historycznych ocen.
- „Wymaga ponownego sprawdzenia” nie oznacza usunięcia historii ani założenia, że dziecko nic nie pamięta. Wcześniejsze potwierdzenie nie wystarcza jednak do oznaczenia zmienionej umiejętności jako opanowanej.

Rozpoczęta sesja korzysta do końca ze spójnej wersji treści i reguł. Nowa publikacja obowiązuje od kolejnej sesji. Wyniki starej wersji pozostają w historii, ale nie mogą potwierdzać opanowania umiejętności unieważnionych przez zmianę materiału. Usunięcie elementu wycofuje go z nowych sesji, zachowując historyczny kontekst prób.

Współdzielonego zestawu nie edytujemy osobno dla każdego dziecka w MVP. Ekran edycji powinien jasno wskazywać, że zmiana dotyczy wspólnej treści.

Okładka zestawu słownictwa jest osobnym, współdzielonym ustawieniem kosmetycznym zestawu, niezależnym od wersji treści, sesji i postępu. Rodzic może wgrać lub usunąć obraz PNG, JPEG albo WebP (do 5 MB); dziecko widzi okładkę zamiast wizualizacji pierwszego słowa, a po jej usunięciu wraca dotychczasowy fallback. Okładka nie jest wymagana do publikacji ani nauki.

Rodzic może również jawnie wygenerować propozycję okładki z nazwy zestawu i do ośmiu zapisanych par słówek. Propozycja pozostaje tymczasowym podglądem w przeglądarce; dopiero „Ustaw jako okładkę” wysyła bajty do istniejącej walidacji i prywatnego, niezmiennego magazynu. Odrzucenie i błąd nie zmieniają aktualnej okładki. Generowanie wymaga sesji rodzica, kontroli Origin/CSRF i skonfigurowanego image providera. Prompt nie zawiera profilu ani danych dziecka.

## 6. Kid Mode — MVP

Interfejs jest po polsku, z angielskim materiałem do nauki. Musi działać wygodnie na telefonie i tablecie.

Wymagania:

- duże przyciski i pola dotykowe;
- mało tekstu i jednoznaczna główna czynność;
- typowy ekran zadania na telefonie pokazuje instrukcję, materiał lub wynik oraz główną akcję bez przewijania całego dokumentu; długie treści, powiększenie, klawiatura i bardzo mała wysokość zachowują pełną treść oraz osiągalne działania przez kontrolowane przewijanie;
- przy niezmienionym widocznym viewporcie nagłówek zadania, instrukcja, obszar materiału i sloty głównej oraz pomocniczej akcji nie zmieniają położenia ani rozmiaru podczas wpisywania, przetwarzania, wyniku i ponowienia; treść może przewijać się we własnym obszarze, a zmiana geometrii po pokazaniu klawiatury lub zoomie jest dozwolona;
- zmiana dostępnego viewportu przy paskach przeglądarki, orientacji lub klawiaturze nie może zgubić wpisu ani stanu bieżącego zadania; wyjątki dostępności nie mogą blokować zwykłego powiększania i przewijania;
- responsywne testy przeglądarkowe nie zastępują odbioru na docelowym telefonie i w PWA; nie deklarujemy zgodności z konkretnym urządzeniem bez zapisu rzeczywistej próby;
- widoczny przycisk ponownego odsłuchania;
- feedback przez tekst, symbol i dźwięk tam, gdzie pomaga; kolor nie jest jedyną informacją;
- możliwość zakończenia sesji bez utraty już zapisanych prób;
- lista zestawów z sekcją „Rekomendowane” (zestawy z zaplanowaną pracą) i możliwością wyboru dowolnego przypisanego zestawu w każdym momencie;
- po wybraniu profilu u góry listy zestawów pokazujemy dzisiejszy czas aktywności sesji z tego samego raportu, którego używa panel rodzica;
- brak ustawień AI, modeli, promptów, CEFR i administracji zestawami;
- brak procentowych ocen i technicznych wyników wymowy; jedynym wyjątkiem jest wynik ukończonej próby kartkówki w jej omówieniu (§19.1, 2026-10-10).

Informacja zwrotna po ocenie wymowy może pokazać fragmenty słowa oznaczone jako „dobrze” lub „prawie”. Nie pokazuje dziecku punktów, IPA ani progów usługi.

Nagrywanie w zadaniach mowy działa w dwóch trybach (2026-10-21). Na ekranach ćwiczeń wymowy (Speech, obrazkowe mówione) nagrywanie rozpoczyna się automatycznie po wyświetleniu zadania: krótki sygnał dźwiękowy „teraz mów” (bip WebAudio) gra po uzyskaniu strumienia mikrofonu i tuż przed rozpoczęciem przechwytywania, więc nie trafia do nagrania, a po wykryciu wypowiedzi i ok. 1,2 s ciszy nagrywanie kończy się samo — bip końca gra po zatrzymaniu. Automatyczne rozpoczęcie działa wyłącznie wtedy, gdy uprawnienie mikrofonu było już wcześniej nadane albo mikrofon był już używany w tej sesji (2026-10-21): pierwsze nadanie zgody następuje świadomym naciśnięciem przycisku nagrywania, a automat nigdy sam nie wywołuje pytania o zgodę — po jej nadaniu kolejne zadanie mowy wystartuje już samo. Cisza bez wykrytej mowy nie tworzy próby: limit długości anuluje nagrywanie z komunikatem, a przycisk pozostaje do ręcznej próby i ponowień; po „Nagraj jeszcze raz” mikrofon nie startuje sam, automatyczne rozpoczęcie dotyczy wyłącznie nowo wyświetlonego zadania. W pozostałych zadaniach (samodzielne przypomnienie, pisownia) oraz po świadomym użyciu przycisku nagrywanie działa przez przytrzymanie: po uzyskaniu zgody przytrzymanie rozpoczyna nagranie, a puszczenie, anulowanie gestu, utrata fokusu albo limit kończy je i zwalnia mikrofon. Rodzic wybiera tryb nagrywania (przytrzymanie/przełącznik) w ustawieniach profilu dziecka; ustawienie działa na urządzeniach korzystających z tego profilu. Odmowa mikrofonu pozostawia pełną ścieżkę pisemną. Po analizie ekran pokazuje nie-modalną kartę wyniku przy zadaniu. „Usłyszałem: …” pojawia się tylko dla wiarygodnej transkrypcji. Fragmenty wymowy mają także opis tekstowy, więc kolor nie jest jedynym nośnikiem wyniku. Ponowienie wraca do gotowości; nagranie zaczyna się dopiero po kolejnym geście dziecka.

Podczas automatycznego nagrywania dziecko może odsłuchać wzorzec lub instrukcję albo wybrać „Pomiń” — te działania najpierw porzucają nagranie bez wysyłki. Dotknięcie mikrofonu w trybie przytrzymania kończy automatyczną próbę; jeśli nie wykryto mowy, także ręczne zakończenie nie tworzy próby. Space/Enter nie przejmuje automatycznego nagrania jako gestu przytrzymania, a Escape je anuluje. Anulowanie obejmuje również oczekujący sygnał startu. Utrata fokusu podczas ręcznego nadawania zgody nie odrzuca jej wyniku i nie uruchamia nagrywania; w ścieżce automatycznej unieważnia oczekujący start. Awaria urządzenia podczas automatycznej sondy pozostawia zadanie i możliwość ręcznego ponowienia, bez wyłączania mikrofonu całej sesji.

Przykład widoku tematu:

> Cześć, Krzysiu! 👋  
> Dni tygodnia — 7 słów  
> ★★☆☆☆☆  
> **Ucz się**

Gwiazdki na liście zestawów to symboliczny wskaźnik postępu (2026-10-11): maksymalnie 6, po jednej za każdą szóstą drogi do kompletu. Oznaczają słowa opanowane samodzielnie; nie towarzyszy im procent ani liczba ułamkowa, a umiejętność nazywa etykieta dostępności. Dla profilu czytającego (`canRead: true`) gwiazdki zliczają wyłącznie słowa z opanowanym samodzielnym Recall (`recall: "mastered"`). Dla profilu bez czytania (`canRead: false`, 2026-10-16) gwiazdki odzwierciedlają słowa opanowane w dostępnych dla dziecka umiejętnościach (`listening: "mastered"` lub `recall: "mastered"`), dzięki czemu nauka ze słuchu bez użycia mikrofonu również pozwala osiągnąć pełne opanowanie (6 gwiazdek). Nie pokazujemy ogólnego „3/7 umiem” ani rozbicia na umiejętności w interfejsie dziecka — szczegóły per umiejętność widzi rodzic w panelu postępów, a dziecko w omówieniu próbnej kartkówki przy wynikach mieszanych (§19.1).

Gamifikacja nie jest warunkiem MVP. Punkty, serie dni, rankingi i nagrody nie mogą zastąpić czytelnej nauki.

## 7. Zakres MVP

Pierwsza wersja obejmuje pełny przebieg:

1. Rodzic tworzy profil i podaje temat.
2. AI generuje zestaw angielskiego słownictwa.
3. Aplikacja waliduje treść i przygotowuje audio.
4. Rodzic przegląda, poprawia i zatwierdza zestaw.
5. Dziecko poznaje materiał i wykonuje krótką sesję.
6. System zapisuje historię prób i postęp osobno dla poszczególnych umiejętności.
7. Następna sesja uwzględnia trudności, mylone pary i potrzebę powtórek.
8. Rodzic widzi konkretne postępy, w tym pisownię i wymowę.

W MVP wymagane są:

- Parent Mode i Kid Mode;
- wiele profili dzieci oraz przypisywanie zestawów;
- generowanie, walidacja, edycja i zatwierdzanie zestawu;
- prezentacja słów, tłumaczeń i prostych przykładów;
- generowanie ilustracji obiektów i czynności oraz deterministyczne wizualizacje kolorów, liczb i sekwencji;
- TTS generowany raz i odtwarzany z cache;
- rozpoznawanie ze słuchu, rozpoznawanie tekstu i odwrotne rozpoznawanie;
- samodzielne przypominanie;
- nagrywanie odpowiedzi i osobna ocena wymowy;
- nauka bez mikrofonu;
- uzupełnianie liter i samodzielna pisownia;
- historia prób, adaptacyjne powtórki i śledzenie pomyłek;
- podstawowy panel postępów rodzica;
- PWA oraz uruchomienie przez Docker / Coolify.

Uzupełnienie integracyjne (2026-10-11): aplikacja może udostępniać prywatnemu agentowi rodzinnemu wyłącznie do odczytu API podsumowania Umiem!. Raport obejmuje lokalne dni, sprawdziany zapisane w Umiem!, bieżący postęp i jawnie szacowany czas nauki; nie zastępuje Parent API ani nie stwierdza braku nauki poza aplikacją. Kontrakt i prywatność opisuje `docs/integrations/hermes-learning.md`.

## 8. Zestaw i element słownictwa

Pierwszy typ zestawu to `vocabulary`. Docelowo możliwy będzie także `source_material` (nauka z dokumentów: OCR/PDF, poza MVP) — to co innego niż „Źródła” z §37 (tabela `source_materials`, zapisany tekst rozdziału rodzica, z którego powstają zwykłe lekcje).

Element słownictwa opisuje materiał, a nie postęp dziecka:

```json
{
  "source": "poniedziałek",
  "target": "Monday",
  "sourceLocale": "pl-PL",
  "targetLocale": "en-GB",
  "example": "Today is Monday.",
  "visualType": "sequence",
  "visualData": {
    "position": 1,
    "total": 7,
    "sequenceStart": "Monday"
  },
  "visualDescription": "Pierwszy dzień tygodnia w układzie od poniedziałku do niedzieli"
}
```

Każdy element ma zatwierdzoną odpowiedź kanoniczną i ewentualną listę dopuszczalnych wariantów. Warianty podlegają podglądowi rodzica tak samo jak główna odpowiedź; nie są dopisywane przez LLM podczas sesji. Reguły oceny odróżniają wariant poprawny od literówki.

Nie wymagamy, aby każdy element zawierał ilustrację. Przykłady zdań mają być krótkie, poprawne i dostosowane do wieku oraz poziomu.

Przyszłe pytania z historii nie muszą pasować do pól `source` i `target` słownictwa. Model produktu rozróżnia ogólny element nauki i jego typ; szczegółowy zapis tego rozróżnienia należy do projektu architektury.

## 9. Generowanie materiału przez AI

Rodzic podaje temat językiem naturalnym. AI zwraca ustrukturyzowany wynik, np. JSON z tytułem, językami i listą elementów.

Backend musi sprawdzić co najmniej:

- zgodność ze schematem i wymagane pola;
- niepuste słowa i tłumaczenia;
- poprawne wartości typów wizualizacji;
- duplikaty i sprzeczne elementy wymagające przeglądu;
- kompletność znanych zestawów, np. siedmiu dni tygodnia, gdy tak sformułowano temat;
- ograniczenia rozmiaru zestawu i długości pól.

Walidacja struktury nie jest gwarancją poprawności merytorycznej. Podgląd i zatwierdzenie przez rodzica pozostają obowiązkowe.

Nieudane generowanie nie publikuje częściowego zestawu. Rodzic otrzymuje zrozumiałą informację i możliwość ponowienia lub ręcznej poprawy szkicu.

AI nie zapisuje dowolnych danych bezpośrednio do bazy. Wygenerowana treść jest danymi do walidacji, a nie instrukcjami sterującymi aplikacją.

## 10. Rola AI podczas nauki

W MVP LLM służy przede wszystkim do przygotowania materiału przed publikacją.

Podczas sesji algorytm aplikacji:

- wybiera element i rodzaj zadania;
- układa warianty odpowiedzi;
- ocenia jednoznaczne odpowiedzi zamknięte;
- stosuje jawne reguły oceny krótkich odpowiedzi pisemnych;
- korzysta z usług mowy, gdy potrzebna jest analiza nagrania;
- zapisuje wynik i wyznacza kolejne ćwiczenia.

Nie wywołujemy LLM po każdym kliknięciu. W MVP nie ma swobodnego czatu dziecka z AI ani generowania nowych, niezatwierdzonych faktów w trakcie sesji.

Wyjątek dla lekcji (moduł gramatyki, 2026-10-12): w lekcjach interaktywnych odpowiedź tekstowa, której nie rozstrzyga dopasowanie deterministyczne do zatwierdzonych wariantów (po normalizacji i tolerancji drobnej literówki), może zostać oceniona przez konfigurowalny **model oceniający** zgodny z OpenAI. Wywołanie następuje tylko dla niedopasowanej odpowiedzi i tylko gdy nie ma zapisanego werdyktu dla tej pary (ćwiczenie, znormalizowana odpowiedź, wersja promptu); werdykt trafia do wspólnego cache, więc ta sama odpowiedź nie woła modelu ponownie. Brak skonfigurowanego modelu, limit wywołań sesji, timeout lub błąd dają wynik „nieocenione” bez kary. Zamknięte ćwiczenia i trafienia cache nie wołają modelu. Szczegóły: sekcja „Lekcje i przedmioty” oraz `.kiro/specs/grammar-module/`.

## 11. Umiejętności śledzone niezależnie

Dla każdej pary dziecko–element śledzimy:

| Umiejętność | Znaczenie | Przykład dowodu |
| --- | --- | --- |
| Rozumienie ze słuchu | Rozpoznanie znaczenia usłyszanego słowa | Audio „Monday” → wybór „poniedziałek” |
| Rozpoznawanie tekstu | Rozpoznanie znaczenia zapisanego słowa | „Monday” → wybór „poniedziałek” |
| Samodzielne przypominanie | Przywołanie angielskiego słowa bez gotowych odpowiedzi | „poniedziałek” → samodzielna odpowiedź „Monday” |
| Wymowa | Wypowiedzenie słowa w sposób oceniony przez usługę wymowy | Widoczne „Monday” → nagranie |
| Pisownia | Samodzielne poprawne zapisanie słowa | „poniedziałek” → wpisanie „Monday” |

Odwrotne rozpoznawanie, np. „poniedziałek” → wybór „Monday”, jest osobnym typem ćwiczenia i dowodem rozpoznawania. Nie jest dowodem samodzielnego przypomnienia.

`Exposure` oznacza prezentację materiału. Nie jest ocenianą umiejętnością. Nie stosujemy pojedynczego pola `stage`, które miałoby zastępować wszystkie wyniki.

Dziecko może dobrze rozpoznawać słowo, słabiej je przywoływać i nadal mieć trudności z pisownią. Algorytm dobiera zadania do tej konkretnej kombinacji.

## 12. Typy ćwiczeń MVP

### 12.1. Poznanie słowa — Exposure

Pokazujemy angielskie słowo, polskie znaczenie i sensowną pomoc wizualną. Odtwarzamy wzorcową wymowę. Dziecko może odsłuchać ją ponownie; nie wymagamy jeszcze odpowiedzi.

Sesja rozpoczyna się po świadomym naciśnięciu „Start”. Automatyczne odtwarzanie musi uwzględniać ograniczenia urządzenia; jeśli zostanie zablokowane, widoczny przycisk umożliwia odsłuch.

### 12.2. Rozpoznawanie ze słuchu

Dziecko słyszy „Monday” i wybiera polskie znaczenie. Angielski zapis nie jest widoczny przed odpowiedzią, aby zadanie faktycznie sprawdzało słuch.

### 12.3. Rozpoznawanie tekstu

Dziecko widzi „Monday” i wybiera „poniedziałek”. Audio może zostać odtworzone po odpowiedzi. Podpowiedź przed odpowiedzią musi być odnotowana.

### 12.4. Odwrotne rozpoznawanie

Dziecko widzi „poniedziałek” i wybiera spośród angielskich słów. Wynik nie awansuje automatycznie samodzielnego przypominania.

### 12.4a. Obrazek → angielskie słowo (2026-10-19)

Dziecko nieczytające w zestawie obrazkowym widzi zatwierdzoną wizualizację znaczenia (obraz, kolor lub liczbę) z małym polskim podpisem, np. obrazek konia z podpisem „koń”, i wybiera jedno z 2–4 angielskich słów („horse”, „house”, „mouse”). To ćwiczenie rozpoznawania tekstu: poprawna odpowiedź zalicza umiejętność `reading` z kierunkiem pojęcie→słowo i nie awansuje samodzielnego przypominania. Polski podpis nie ujawnia angielskiej odpowiedzi, więc nie zmienia kwalifikacji próby.

Prompt celowo nie zawiera nagrania angielskiego słowa — ćwiczenie pozostaje czystym rozpoznawaniem wzrokowym. Odsłuch poprawnego słowa jest częścią feedbacku: serwer ujawnia identyfikator gotowego nagrania dopiero wraz z oceną próby (z pieczęcią ekspozycji przed odpowiedzią HTTP), a kid-ui pokazuje głośniczek przy podświetlonej poprawnej opcji.

Typ dostają wyłącznie profile `canRead=false` w zestawach `picture`; czytający dzieci nie otrzymują go wcale. Klient deklaruje obsługę nową flagą zdolności przy starcie sesji; klient bez flagi nie dostaje tego typu zadań (graceful). Dystraktory pochodzą ze wspólnego mechanizmu opcji: unikalne teksty, cel zarezerwowany dla należnego sprawdzenia recall/pisowni nigdy nie jest opcją ani dystraktorem, a ekspozycje wszystkich pokazanych słów są zapisane i zamknięte przed wysłaniem treści. Brak jednoznacznego wizualu lub zbyt mała pula pomija typ — sesja trwa innymi zadaniami, bez wymuszania losowej odpowiedzi. Standardowa maszyna stanów: pomyłka daje drugą próbę, druga pomyłka prowadzi do wsparcia, „Nie pamiętam” jest trudnością.

### 12.5. Samodzielne przypominanie — Recall

Dziecko widzi polskie znaczenie, bez angielskiego wzorca i bez gotowych odpowiedzi. Może odpowiedzieć głosem lub pisemnie, zależnie od dostępnego trybu.

Treść odpowiedzi ustala się niezależnie od jakości wymowy. Odsłuchanie wzorca albo ujawnienie odpowiedzi zmienia próbę w ćwiczenie z podpowiedzią — nie jest to samodzielne przypomnienie.

Przy odpowiedzi głosowej karta wyniku rozdziela rozpoznaną treść i ocenę wymowy. Wyświetla „Usłyszałem: …” tylko po przejściu bramki pewności STT; treść inna niż oczekiwana nie jest przedstawiana jako pochwała. Wzorcowe audio jest dostępne tylko wtedy, gdy serwer autoryzował odsłuch dla bieżącej próby.

### 12.6. Ćwiczenie wymowy — Speech

Dziecko widzi angielskie słowo, może usłyszeć wzorzec, a następnie je wypowiada. Oceniamy wymowę, nie znajomość odpowiedzi.

Jedno nagranie w zadaniu Recall może dostarczać dowodu przypomnienia i wyniku wymowy, ale są to dwa osobne wyniki. Nie wnioskujemy, że dziecko zna słowo, wyłącznie na podstawie oceny wymowy dla zadanego tekstu.

Nagrywanie rozpoczyna się automatycznie po wyświetleniu zadania (2026-10-21), ale tylko przy już nadanym uprawnieniu mikrofonu (lub po wcześniejszym użyciu mikrofonu w tej sesji) — pierwsze nadanie zgody należy do świadomego naciśnięcia przycisku i automat sam nie wywołuje pytania o zgodę: bip startu gra po uzyskaniu strumienia mikrofonu i tuż przed rozpoczęciem przechwytywania (żaden sygnał dźwiękowy nie trafia do materiału wysyłanego na rozpoznanie mowy), a detekcja aktywności głosowej na poziomie mikrofonu kończy nagranie po wykryciu wypowiedzi i ok. 1,2 s ciszy — bip końca gra po zebraniu nagrania. Dziecko mówi po zakończeniu sygnału startu: sygnał w całości poprzedza rozpoczęcie przechwytywania (przycinanie echa sygnału z nagrania rozważono i świadomie odrzucono jako nieproporcjonalne), a pomiar rzeczywistego odstępu sygnał–przechwytywanie na urządzeniu docelowym pozostaje na liście kontrolnej właściciela. Cisza bez wykrytej mowy nie tworzy próby: limit długości anuluje nagrywanie z komunikatem, a przycisk pozostaje do ręcznej próby. Ręczne zakończenie nagrania po puszczeniu przycisku w domyślnym trybie przytrzymania pozostaje niezmienione; klawiatura zapewnia równoważne rozpoczęcie i zakończenie, a tryb przełączany jest dostępny jako alternatywa. Karta wyniku pokazuje wiarygodnie usłyszane słowo, osobny komunikat o wymowie oraz — tylko przy wiarygodnych danych — fragmenty wzorca opisane jako dobre, wymagające ćwiczenia lub niepewne. Przy niepewnym STT, ciszy i awarii nie wymyśla treści ani lokalizacji błędu. „Nagraj jeszcze raz” wraca do gotowości bez samoczynnego włączenia mikrofonu; zadanie terminalne oferuje „Dalej”.

### 12.7. Uzupełnianie liter

Przykład: „poniedziałek” → `M _ n d _ y`.

To ćwiczenie wspomagające pisownię. Widoczne litery są podpowiedzią, dlatego sukces nie jest równoważny samodzielnemu zapisaniu całego słowa.

Uzupełnienie 2026-10-10: ćwiczenie jest łatwiejszą poprawką po trudnościach z pisownią, w istniejącym cyklu wsparcia. Dziecko wpisuje po jednej brakującej literze bezpośrednio w luki, zamiast przepisywać całe słowo. Widoczne litery, spacje i interpunkcja pozostają stałe. Wpisanie litery przenosi fokus do następnej luki; każdą lukę można poprawić. „Sprawdź” jest dostępne po uzupełnieniu wszystkich luk. Błędna próba i ponowne podejście korzystają ze zwykłego feedbacku; „Nie pamiętam” i „Pomiń” pozostają dostępne.

### 12.8. Samodzielna pisownia

Dziecko widzi polskie znaczenie i wpisuje całe angielskie słowo. Angielski wzorzec pozostaje ukryty do odpowiedzi lub świadomego użycia podpowiedzi.

Przed oceną usuwamy przypadkowe spacje na początku i końcu odpowiedzi. Ocenę opieramy na odpowiedzi kanonicznej i zatwierdzonych wariantach; nie uznajemy dowolnego podobnego wyrazu za poprawny.

Zapisujemy oddzielnie:

- zgodność słowa lub znaczenia odpowiedzi;
- poprawność liter i ich kolejności;
- poprawność kapitalizacji.

Dla dni tygodnia wielka litera jest częścią poprawnej pisowni. Odpowiedź „monday” na „poniedziałek” potwierdza właściwe słowo i kolejność liter, ale nie zalicza pełnej poprawności pisowni. Dziecko otrzymuje komunikat „To właściwe słowo! Monday piszemy wielką literą”. Ta próba może potwierdzić przypomnienie, jeśli spełnia warunki samodzielności z sekcji 18.

Po błędnej próbie pisemnej, której zapis jest bliski zatwierdzonemu wariantowi (co najwyżej dwie operacje liter: brakująca, nadmiarowa, zamieniona lub przestawiona para; jedna dla słów do czterech znaków), karta wyniku pokazuje obok siebie zapis dziecka i właściwy zapis z wyróżnionym miejscem różnicy. Wyróżnienie ma formę obwódki, więc jest czytelne także bez rozróżniania kolorów, a wielkość liter pozostaje objęta osobnym komunikatem. Diagnoza liter jest komunikatem, nie podstawą oceny: podobieństwo tekstu nie zalicza przypomnienia ani pisowni, nie zwiększa liczby prób i nie wpływa na budżet sesji. Pokazanie właściwego zapisu pozostaje ujawnieniem zapisanym przed doręczeniem feedbacku. Pusta odpowiedź, pominięcie, „Nie pamiętam” i problemy techniczne nie otrzymują diagnozy liter.

Pełny sukces w samodzielnej pisowni wymaga poprawnego zapisu jednego z zatwierdzonych wariantów, włącznie z wymaganą kapitalizacją. Błąd szczegółowy jest zapisywany, aby można było udzielić odpowiedniego wsparcia.

W polach pisowni aplikacja wyłącza autokorektę, sprawdzanie pisowni, autouzupełnianie i automatyczną kapitalizację w zakresie dostępnym na urządzeniu. Zachowanie klawiatury trzeba sprawdzić na docelowym telefonie/tablecie. Aplikacja nie gwarantuje wykrycia wszystkich podpowiedzi zewnętrznej klawiatury ani nie traktuje tego jako problemu wymagającego mechanizmu antyoszustw.

Literówka może oznaczać błąd pisowni przy zachowanej znajomości słowa, ale podobieństwo tekstu samo w sobie nie wystarcza do zaliczenia przypomnienia. Tylko jednoznaczne dopasowanie według jawnych reguł może zostać tak zakwalifikowane. Odpowiedź niejednoznaczna nie jest automatycznie poprawna.

## 13. Stopniowanie trudności

Aplikacja zaczyna od poznania i prostego rozpoznawania, a następnie wprowadza przypominanie, wymowę i pisownię. To strategia dobierania zadań, a nie sztywna, nieodwracalna drabina.

Nie trzeba osiągnąć wysokiej oceny wymowy, żeby ćwiczyć pisownię. Brak mikrofonu nie blokuje innych umiejętności. Nie trzeba też w jednej sesji wykonać wszystkich typów ćwiczeń dla każdego słowa.

Domyślna reguła początkowa: nowe słowa wprowadzamy w małych porcjach, np. po 2–3, przeplatając prezentację z łatwym rozpoznawaniem. Nie odpytujemy od razu z całego nieznanego zestawu.

W każdym zestawie obrazkowym, niezależnie od flagi czytania, po dwóch pierwszych prezentacjach losujemy wykonalne pytanie o poznane słowo lub kolejną prezentację. Co najwyżej trzy nowe słowa czekają na pierwsze rozpoznawanie. Pula pytań obejmuje także wcześniej ćwiczone cele: najpierw ten sam priorytet opanowania, potem liczba pytań nie większa niż minimum + 1 w wykonalnej puli tego priorytetu (prezentacje nie zwiększają tej liczby). Ostatnie słowo może powrócić. Należne sprawdzenia, wsparcie, retry, powtórki i wprowadzanie etapów zachowują pierwszeństwo; rezerwacje, bezpieczne opcje oraz budżet nadal obowiązują. Losowa krótka sekwencja może się przypadkowo powtórzyć. Wydane zadanie nie jest ponownie losowane przy wznowieniu. Przypięta do sesji flaga czytania określa dostępne ćwiczenia i umiejętności: profil czytający zachowuje słuchanie, oba kierunki czytania, przypominanie i pisownię oraz wymowę przy włączonym mikrofonie. Nowe słowo zaczyna od słuchania, a dalsze utrwalanie zachowuje miks słuchu i tekstu.

Opcje odpowiedzi są jednoznaczne, bez duplikatów, a ich pozycja jest zmienna. Gdy zestaw ma za mało sensownych wariantów, stosujemy mniej opcji albo inne zadanie zamiast wymuszać przypadkowe odpowiedzi.

Ćwiczenie wyboru wymaga co najmniej dwóch różnych opcji. Nie używamy celu należnego samodzielnej próbie jako opcji ani dystraktora. Jeśli materiał jest singletonem albo chwilowo brakuje bezpiecznych dystraktorów, dziecko może zakończyć własną prezentację i otrzymać pisemne Recall; nie tworzymy fikcyjnego sukcesu z rozpoznawania.

Pomoce wizualne nie mogą nieświadomie zdradzać odpowiedzi w zadaniu, które ma potwierdzać samodzielną znajomość. Widoczna wskazówka jest częścią kontekstu próby.

### 13.1. Kontekst podpowiedzi między ćwiczeniami

Ujawnienie angielskiego słowa w prezentacji, ćwiczeniu wymowy, wyborze odpowiedzi, uzupełnianiu liter lub feedbacku wpływa również na interpretację kolejnych zadań z tego elementu. Zmiana typu ćwiczenia albo ponowne uruchomienie sesji nie usuwa tego kontekstu.

Przykład: po obejrzeniu i wypowiedzeniu „Wednesday” dziecko od razu poprawnie je wpisuje. Jest to wartościowe utrwalanie i poprawna odpowiedź, ale jeszcze nie niezależne sprawdzenie pamięci. Zapisujemy wynik wraz z niedawną ekspozycją; taka próba nie potwierdza opanowania przypominania ani pisowni.

Algorytm powinien umieszczać planowane sprawdzenie pamięci przed ponownym pokazaniem wzorca danego słowa. Dopiero po odpowiedzi udziela wsparcia. Warunki niezależnej próby określa sekcja 18.

### 13.2. Znaczenie odsłuchu zależy od zadania

| Zadanie | Znaczenie odtworzenia angielskiego słowa |
| --- | --- |
| Prezentacja lub ćwiczenie wymowy | Wzorzec jest oczekiwaną częścią nauki; nie unieważnia oceny samej wymowy. |
| Rozpoznawanie ze słuchu | Audio jest pytaniem. Pierwszy i ponowny odsłuch nie ujawniają polskiej odpowiedzi; liczba odsłuchów jest zapisana. |
| Rozpoznawanie tekstu / odwrotne rozpoznawanie | Odsłuch przed odpowiedzią jest dodatkowym wsparciem; wynik opisuje ćwiczenie wspomagane. |
| Przypominanie polski → angielski | Odtworzenie angielskiego słowa ujawnia rozwiązanie; nie ma samodzielnego przypomnienia. |
| Pisownia z polskiego znaczenia | Audio podpowiada angielskie słowo. Nie zalicza przypomnienia ani pełnego, samodzielnego zadania pisowni; można zachować wynik zapisu jako wspomagany. |

Ponowne odsłuchanie pytania w zadaniu słuchowym nie jest automatycznie błędem ani ujawnieniem odpowiedzi. To samo audio stanowi jednak niedawną ekspozycję na angielskie słowo dla późniejszego Recall.

## 14. Nauka bez mikrofonu

Dziecko może rozpocząć sesję bez nagrywania. Odmowa uprawnienia, brak mikrofonu lub jego awaria nie blokują aplikacji.

Preferencja gestu nagrywania (`hold` albo `toggle`) należy do profilu dziecka. Rodzic zmienia ją w panelu rodzica; nowy i istniejący profil po migracji używa domyślnie `hold`. Kid API przekazuje wartość razem z profilem, a ekran ćwiczenia nie udostępnia dziecku przełącznika. Ustawienie nie jest zapisywane w preferencjach urządzenia.

W tym trybie dostępne są prezentacja, odsłuch, rozpoznawanie, uzupełnianie liter i pisownia. Samodzielna odpowiedź pisemna może dostarczyć dowodu przypomnienia słowa, z zachowaniem osobnej oceny pisowni.

Nie oceniamy wymowy i nie uznajemy jej za opanowaną. Jeśli dziecko powie odpowiedź bez nagrania, aplikacja nie traktuje jej jako obiektywnie sprawdzonej. Nieobserwowana umiejętność ma status „nie sprawdzono”, a nie wynik zero.

## 15. Wyniki i problemy techniczne

Każda oceniana umiejętność otrzymuje wynik: poprawnie, niepoprawnie albo nieocenione. Osobno zapisujemy przyczynę braku oceny i użyte wsparcie.

Przykładowe przyczyny braku oceny:

- brak nagrania lub cisza;
- hałas uniemożliwiający ocenę;
- niepewne rozpoznanie;
- odmowa dostępu do mikrofonu;
- przerwane połączenie lub błąd providera;
- odpowiedź niejednoznaczna.

Brak wiarygodnej oceny nie obniża poziomu umiejętności i nie jest rejestrowany jako pomylenie dwóch słów. Dziecko otrzymuje komunikat typu „Nie udało mi się usłyszeć. Spróbuj jeszcze raz” albo możliwość kontynuowania bez mikrofonu.

Karta wyniku odróżnia rozpoznaną wypowiedź od oceny wymowy. Niepewne rozpoznanie, cisza ani błąd usługi nie pokazują tekstu jako pewnej transkrypcji. Neutralny fragment oznacza brak wiarygodnej lokalizacji i nie jest czerwonym błędem. Częściowa ocena treści i wymowy pozostaje rozdzielona w treści, kolorze oraz dostępnej legendzie.

Wynik częściowy jest dopuszczalny: jeśli wiarygodnie rozpoznano poprawne słowo, ale usługa wymowy zawiodła, zapisujemy poprawne przypomnienie i brak oceny wymowy.

Wymowa poniżej progu częściowego pozostaje nieoceniona — nie jest błędem wiedzy. Domyślne progi startowe `learning-v2` wynoszą 70/100 dla pasma „dobrze” i 50/100 dla „prawie”; są to progi konkretnej konfiguracji usługi, a nie uniwersalna miara opanowania języka. Rodzic może zmienić progi w ustawieniach profilu dziecka. Każda zmiana tworzy nową, niezmienną wersję polityki, przypinaną do nowych sesji; istniejące sesje zachowują swoją wersję. Rodzic może też przejrzeć listę ostatnich ocen wymowy dziecka z oczekiwanym słowem, wynikiem usługi i pasmem.

### 15.1. „Nie pamiętam”, pominięcie i przerwanie

W zadaniach sprawdzających wiedzę dziecko ma dostęp do przycisku **„Nie pamiętam — pokaż”**. Aplikacja ujawnia odpowiedź i proponuje wsparcie bez wymagania zgadywania lub dwóch błędnych prób.

Potwierdzenie „Rozumiem” zapisuje zadeklarowaną trudność i przechodzi do następnego zadania lub podsumowania. Nie pokazuje ponownie zakończonego formularza z zablokowanym polem i tą samą poprawną odpowiedzią.

Takie zdarzenie oznacza zadeklarowaną trudność i zwiększa potrzebę powtórki. Nie jest błędem technicznym, nie generuje fikcyjnej mylonej pary i nie jest oceną wymowy. W niezależnym sprawdzaniu przerywa serię sukcesów opisaną w sekcji 18.

„Pomiń”, przerwanie sesji i brak wiarygodnego nagrania nie dowodzą braku wiedzy. Zapisujemy je osobno, bez obniżania umiejętności. Pominięty element może wrócić w późniejszej sesji, ale nie otrzymuje dodatkowej wagi błędu ani wymuszonej natychmiastowej powtórki. Cisza w nagraniu nie jest automatycznie interpretowana jako „Nie pamiętam”.

## 16. Reakcja na trudności i feedback

Domyślna reguła początkowa po dwóch nieudanych próbach w tym samym zadaniu:

1. Pokazać poprawną odpowiedź i udostępnić wzorcowe audio.
2. Zakończyć bieżącą serię prób tego zadania.
3. Dać łatwiejsze ćwiczenie lub ponownie zaprezentować materiał.
4. Wrócić do trudnego elementu po innych zadaniach, jeśli pozwala na to długość sesji.

Problemy techniczne nie liczą się do dwóch błędnych odpowiedzi. Sukces po pokazaniu odpowiedzi nie jest samodzielnym przypomnieniem.

Nie wolno zapętlać dziecka na jednym słowie ani wydłużać sesji bez końca. Gdy nadal jest trudno, element wraca w kolejnej sesji.

Feedback ma być pozytywny i zgodny z wynikiem:

- „Świetnie!” i „Dobrze!” po poprawnej odpowiedzi;
- „Prawie! Posłuchaj jeszcze raz” przy rzeczywiście częściowo poprawnej próbie;
- „Prawie! Popraw zapis:” z zaznaczoną różnicą między wpisem dziecka a właściwym zapisem przy błędzie bliskim poprawnemu wariantowi;
- „Poprawna odpowiedź” i osobno wyróżnione „Thursday” przy niepoprawnej odpowiedzi z ujawnionym rozwiązaniem; na telefonie akcja ponowienia jest pod komunikatem, a jej wysokość rośnie wraz z tekstem;
- „Nie udało się ocenić nagrania” przy problemie technicznym.

Nie pokazujemy „ŹLE”, kar, rankingów ani technicznego „37%”. Nie chwalimy niepoprawnej odpowiedzi jako poprawnej.

Wynik mowy pokazuje w jednej karcie „Usłyszałem: {tekst}” tylko dla transkrypcji zaakceptowanej przez bramkę pewności. Ocena wymowy ma własny krótki komunikat. Fragment wzorca może być zaznaczony wyłącznie wtedy, gdy adapter dostarczył wiarygodne dopasowanie; brak takiej informacji pozostaje neutralny. Karta nie blokuje treści zadania modalem, zachowuje widoczne działania na małym ekranie i nie uruchamia mikrofonu po „Nagraj jeszcze raz”.

## 17. Sesje i adaptacyjne powtórki

Domyślna sesja zależy od budżetu zestawu: limit czasu to 45 sekund na zadanie oceniane, ale nie mniej niż 10 minut — przy domyślnych 20 zadaniach do 15 minut. Algorytm dobiera skończoną porcję zadań, uwzględniając czas i trudności. Dziecko może zakończyć wcześniej.

Zestaw można ćwiczyć w dowolnym momencie; harmonogram nie blokuje wyboru. Gdy dla danego dziecka nic nie jest w danym momencie należne (żadne sprawdzenie, powtórka ani nowy materiał), sesja wydaje lekkie utrwalanie rozpoznawania już rozpoczętych elementów. Takie dodatkowe ćwiczenie mieści się w zwykłym budżecie sesji, a próby klasyfikujemy według reguł niezależności (§18) — utrwalanie tuż po ujawnieniu wzorca nie zalicza się jako samodzielne sprawdzenie i nie zawyża postępu. Listę zestawów dziecka porządkuje sekcja „Rekomendowane”: zestawy, w których harmonogram ma teraz zaplanowaną pracę (należne sprawdzenia, powtórki albo nowy materiał).

Zamiast „37 kart do zrobienia” pokazujemy krótki, osiągalny cel. Jeśli aplikacja informuje „Jeszcze 3 i koniec”, nie dokłada potem niezapowiedzianych zadań.

Priorytet powtórek zależy od:

- wymaganej umiejętności, a nie wyłącznie słowa;
- dotychczasowych wyników i użytych podpowiedzi;
- czasu od ostatniej wiarygodnej próby;
- powtarzających się pomyłek;
- terminu sprawdzianu;
- liczby niedawnych prób tego samego elementu, aby uniknąć monotonii.

Planowane samodzielne sprawdzenia przypominania i pisowni mają pierwszeństwo przed nowym słowem i powtórką, która ujawniłaby ich cel. Po pierwszej prezentacji pierwszy sprawdzian tych umiejętności staje się należny po 24 godzinach; późniejsze terminy wynikają z historii kwalifikujących ocen. Sprawdzian jest wydawany dopiero, gdy od ostatniego ujawnienia wzorca lub fragmentu minęło 300 sekund. Jeśli nie jest jeszcze kwalifikujący, scheduler wybiera bezpieczne ćwiczenie i wraca później. Każda umiejętność rozpoznawania, Recall, wymowa i pisownia zachowuje własną historię i termin.

Wsparcie po trudnościach tworzy jeden ograniczony cykl na element i sesję: po dwóch błędnych odpowiedziach w tym samym zadaniu albo po „Nie pamiętam” dziecko dostaje prezentację/wsparcie, a potem najwyżej jedną poprawkę. Jeśli trudność dotyczy pisowni, poprawka może używać uzupełniania liter. Pominięcie, cisza, błąd providera ani niepewne rozpoznanie nie uruchamiają cyklu błędnej wiedzy. Budżet ocenianych zadań nie rośnie.

Trudne elementy pojawiają się częściej, ale nie wypierają wszystkich łatwiejszych zadań. Również dobrze znane słowa wymagają powrotu po przerwie.

Powtórkę planujemy osobno dla danej umiejętności. Aplikacja może zbiorczo wybrać słowo do sesji, lecz musi wiedzieć, czy ćwiczy jego znaczenie, wymowę czy zapis.

Podsumowanie sesji odnosi się do faktycznych wyników, np. „Dziś samodzielnie przypomniałeś 5 słów. Pisownię 2 jeszcze poćwiczymy”. Nie obiecuje trwałego opanowania na podstawie jednej sesji.

## 18. Kiedy słowo jest „opanowane”

Opanowanie jest oceniane dla konkretnej umiejętności, nie jedną liczbą dla całego słowa.

Wymagane zasady:

- pojedyncza poprawna odpowiedź nie wystarcza;
- odpowiedź po podpowiedzi nie jest równoważna samodzielnej;
- wymagane jest potwierdzenie po przerwie;
- rozpoznawanie nie zastępuje samodzielnego przypomnienia;
- wymowa i pisownia nie unieważniają poprawnej znajomości znaczenia;
- nowe błędy mogą ponownie skierować wcześniej opanowaną umiejętność do ćwiczeń.

Domyślne reguły początkowe dla przypominania i pisowni:

1. Niezależna próba to pierwsza odpowiedź w danym zadaniu, bez podpowiedzi i z upływem co najmniej 5 minut od ostatniego ujawnienia angielskiego rozwiązania lub jego fragmentu przez aplikację, także w innym typie ćwiczenia. Sam prompt po polsku nie ujawnia rozwiązania. Kolejne próby po feedbacku służą utrwalaniu.
   Pierwszy zaplanowany termin Recall i pisowni po prezentacji wypada po 24 godzinach; odstęp ten określa dobór zadania, a 5 minut pozostaje warunkiem kwalifikacji odpowiedzi.
2. Do potwierdzenia opanowania wymagane są trzy ostatnie kwalifikujące się próby danej umiejętności zakończone sukcesem. Błąd lub „Nie pamiętam” w niezależnym sprawdzaniu przerywa serię dla tej umiejętności. Nie sumujemy dowolnych trzech sukcesów z całej historii.
3. Co najmniej jeden z tych sukcesów musi nastąpić w późniejszej sesji, innego dnia oraz po co najmniej 12 godzinach od ostatniego kontaktu z tym elementem w poprzednich sesjach. Samo przekroczenie północy nie wystarcza.
4. Próby wspomagane i bez wiarygodnej oceny nie zwiększają ani nie przerywają serii kwalifikujących się prób. Powtarzające się błędy podczas ćwiczeń wspomaganych mogą zwiększać priorytet treningu, ale nie zastępują niezależnego sprawdzenia.
5. Po opanowaniu błąd albo „Nie pamiętam” w niezależnym sprawdzaniu oznacza „do ponownego potwierdzenia”. Historia pozostaje; odzyskanie statusu wymaga ponownego spełnienia powyższych warunków.

Ta sama samodzielna odpowiedź pisemna może dostarczyć po jednym wyniku dla przypominania i pisowni, ale nigdy kilku sukcesów dla jednej umiejętności. Reguły dotyczą statusu opanowania, nie pochwały po pojedynczej poprawnej odpowiedzi. Nie ograniczają możliwości częstego ćwiczenia ani nie wymagają czekania na zegar w interfejsie dziecka.

Jest to heurystyka produktu, nie gwarancja utrwalenia. Wartości 5 minut, 12 godzin i trzech sukcesów są ustawieniami startowymi do kalibracji, a nie potwierdzonymi naukowo progami pamięci. Parametry pozostają wewnętrzne; dziecko nie konfiguruje algorytmu.

Wymowa wymaga osobnych progów zależnych od wybranego providera i walidacji na reprezentatywnych nagraniach. Domyślne progi wersji `learning-v2` to 70/100 dla „dobrze” i 50/100 dla „prawie”; wynik poniżej progu „prawie” jest nieoceniony. Rodzic może ustawić progi dla konkretnego dziecka, a zapis zmienia wersję polityki wyłącznie dla nowych sesji. Nie ustalamy uniwersalnego progu dla wszystkich usług. Zmiana providera nie może bez wyjaśnienia zmienić znaczenia historycznych wyników.

Rodzic widzi osobne informacje, np. „rozpoznaje 7/7”, „przypomina samodzielnie 5/7”, „pisze samodzielnie 3/7”. Ocena wymowy jest wyraźnie opisana jako automatyczna ocena usługi.

W ustawieniach profilu rodzic może zmienić progi „dobrze” i „prawie” oraz przejrzeć ostatnie próby wymowy z wynikiem i przypisanym pasmem. Brak skonfigurowanej usługi wymowy jest pokazany wprost; nie udostępniamy wtedy edycji progów.

## 19. Termin sprawdzianu

Termin jest opcjonalny i dotyczy przypisania materiału konkretnemu dziecku. Dni i terminy interpretuje się w strefie czasowej rodziny, domyślnie Europe/Warsaw.

Od lokalnej północy dwa dni przed terminem scheduler przeznacza część zwykłego budżetu sesji na pisemne przypominanie wcześniej ujawnionych i rozpoznawanych słów, które wymagają jeszcze Recall lub pisowni. Okno otwiera się dokładnie 48 godzin przed początkiem lokalnego dnia sprawdzianu i trwa przez cały ten dzień; granice wyznacza strefa rodziny, także przy zmianie czasu. Zadanie pokazuje polskie znaczenie i pole wpisania odpowiedzi, bez gotowych odpowiedzi i bez wymogu mikrofonu. W pierwszej kolejności wracają umiejętności potrzebujące ponownego potwierdzenia, potem pisownia i Recall.

Należne samodzielne sprawdzenia, wsparcie po trudnościach i zaplanowana poprawka po wsparciu pozostają wcześniejsze od przygotowania. Po dwóch kolejnych zadaniach przygotowawczych scheduler wstawia bezpieczne, łatwe rozpoznawanie; rezerwacje nadal chronią cele przed ujawnieniem i użyciem jako dystraktorów. Pominięcie nie jest dowodem błędnej wiedzy, a „Nie pamiętam” prowadzi do wsparcia. Wydane zadanie przygotowawcze nie wraca w tej samej sesji.

Data i strefa zostają przypięte do sesji przy jej rozpoczęciu. Zmiana terminu przypisania działa od następnej nowej sesji, a wznowienie zachowuje pierwotny kontekst. Starsza sesja bez przypiętej daty nadal korzysta z dotychczasowych reguł.

Priorytet sprawdzianu nie zmienia definicji opanowania ani nie powoduje nieograniczonego wydłużania sesji.

Materiał przećwiczony dzień przed sprawdzianem może nadal mieć status „potrzebuje potwierdzenia po przerwie”. Aplikacja nie ukrywa tej różnicy. Po sprawdzianie nauka i powtórki mogą być kontynuowane.

MVP nie wymaga powiadomień, kalendarza ani automatycznego harmonogramu przypomnień dla rodzica.

### 19.1. Próbna kartkówka i raport braków (2026-10-10, #30)

Rodzic może włączyć na przypisaniu dziecko × zestaw cele: tłumaczenie na angielski (Recall), pisownia i słuchanie. Ustawia liczbę zadań od 1 do 100, domyślnie 10; termin pozostaje opcjonalny. Wartości są osobne dla każdego dziecka. Kartkówka obejmuje zatwierdzony, wcześniej poznany materiał. Jeżeli dostępnych bezpiecznych zadań jest mniej, faktyczna porcja jest mniejsza i dziecko widzi ją przed startem.

Tryb kartkówki jest odrębny od treningu przed terminem. Przy starcie serwer zamraża wersję materiału, politykę, cele, termin, ustawioną liczbę i całą kolejność zadań. Błąd, retry, wznowienie ani późniejsza edycja ustawień nie zmieniają tej porcji. Jedno zadanie pisemne może dać osobne oceny Recall i pisowni; zajmuje jedno miejsce. Przy obu rodzajach zadań początkowo połowa porcji przypada na pisemne (przy nieparzystej liczbie o jedno więcej), reszta na słuchanie; wolne miejsca uzupełnia dostępny rodzaj. Wszystkie pisemne zadania poprzedzają słuchowe.

Każde zadanie przyjmuje jedną odpowiedź, „Nie pamiętam” albo „Pomiń”. Dziecko może poprawiać tekst przed zapisem. Po odpowiedzi widzi neutralne potwierdzenie, bez informacji o poprawności i rozwiązania. Nie ma podpowiedzi, dodatkowych prób merytorycznych, wsparcia ani rozszerzania porcji. W tym trybie „Nie pamiętam” zapisuje trudność i nie ujawnia wzorca. Pisemna kartkówka nie wymaga mikrofonu. Odtworzenie promptu słuchowego jest dozwolone i pozostawia ekspozycję, również z cache.

Kartkówka ma limit czasu skalowany z liczbą zadań porcji — 45 sekund na zadanie, ale nie mniej niż 10 minut — i okno wznowienia 30 minut. Przerwanie lub timeout zachowują otrzymane odpowiedzi, a resztę oznaczają jako niesprawdzoną. Rozwiązania są dostępne dopiero po zamknięciu, w osobnym omówieniu. Każdy odczyt omówienia i replay jego audio zapisuje ujawnienia przed odpowiedzią HTTP; następny trening je uwzględnia. Raport rodzica nie jest ujawnieniem dziecku.

Omówienie dla dziecka (2026-10-10) pokazuje na górze wynik próby: liczbę zaliczonych słów w formacie X/Y, procent oraz gwiazdki — maksymalnie 6, po jednej za każdą szóstą drogi do kompletu. Słowo zalicza się, gdy wszystkie sprawdzone umiejętności tej porcji są poprawne; pominięte i niesprawdzone nie zwiększają licznika, tylko obniżają wynik. Poniżej lista słów jako kompaktowe wiersze: całość poprawna w zieleni, jakakolwiek pomyłka w czerwieni, słowo niesprawdzone neutralnie; symbol ✓/✗/– powtarza informację koloru, a przy wynikach mieszanych wiersz wskazuje poszczególne umiejętności. Jest to podsumowanie ukończonej próby, a nie procentowa ocena postępu umiejętności — stanowi jedyny wyjątek od reguły §6 o braku procentowych ocen w interfejsie dziecka.

Raport (2026-10-10, kompaktowy widok) dotyczy konkretnej próby i jej wersji materiału. Na górze pokazuje wynik słów w formacie jak omówienie dziecka — X/Y, procent, gwiazdki — gdzie Y to zaplanowana porcja próby; po przerwaniu może ona obejmować słowa, których omówienie dziecka nie wyświetliło (zadania nie zostały wydane), i wtedy raport pokazuje je jako niesprawdzone. Poniżej lista słów jako kompaktowe wiersze w tej samej konwencji co omówienie dziecka: całość poprawna w zieleni, jakakolwiek pomyłka w czerwieni, słowo niesprawdzone neutralnie, symbol ✓/✗/– oraz pastylki umiejętności przy wynikach mieszanych. Pod słowem szara linia informacji rodzica: status opanowania na zakończenie próby, samodzielność i jej przyczyna przy ocenach poprawnych i błędnych — oddzielnie od poprawności/kapitalizacji — oraz powód wyniku (np. „Nie pamiętam", „Wielka litera"). Pełny mianownik liczników per umiejętność to wszystkie elementy tej wersji × wybrane umiejętności, także słowa poza krótką porcją lub jeszcze niepoznane. Osobno wskazuje poprawne samodzielne, błędne, poprawne niekwalifikujące, pominięte, nieocenione i niewykonane odpowiedzi, a przyczyny braków słów poza porcją podsumowuje jedną zagregowaną linią. Pominięte oraz nieocenione są częścią braków pokrycia, a nie dowodem błędnej wiedzy. Pełny status opanowania całej talii rodzic widzi w sekcji postępu słów tego samego widoku postępów. Zachowuje reguły §18, również po ujawnieniu zatwierdzonego wariantu w innym zestawie: pojedynczy wynik nie zastępuje potwierdzenia po przerwie. Nie obiecuje oceny szkolnej. Rodzic może przeglądać 20 ostatnich prób w panelu postępów; wygasła częściowa próba pojawia się także po samym zamknięciu karty dziecka. Brak dostępnych zadań ma czytelny komunikat i pozwala wrócić do zwykłej nauki. Słuchanie nie oferuje alternatywy, która jest również zatwierdzonym znaczeniem odtwarzanego słowa.

## 20. Historia prób — MVP

Każde podejście do odpowiedzi jest zapisywane oddzielnie. Historia jest podstawowym zapisem przebiegu nauki; bieżące liczniki i podsumowania można z niej wyliczać lub aktualizować.

Próba powinna pozwalać ustalić:

- kto odpowiadał: profil dziecka;
- w której sesji i na jaki element;
- jaką wersję treści i jakie zadanie pokazano;
- typ ćwiczenia oraz oceniane umiejętności;
- dostępne opcje i wybraną odpowiedź, jeśli dotyczy;
- odpowiedź pisaną lub rozpoznany tekst nagrania, jeśli potrzebne do analizy;
- użyte podpowiedzi, ujawnienie wzorca i ponowne odsłuchy wraz z ich rolą w zadaniu;
- czas oraz rodzaj ostatniego ujawnienia rozwiązania, również w innym ćwiczeniu;
- kwalifikację próby jako niezależnego sprawdzenia albo utrwalania i przyczynę tej kwalifikacji;
- deklarację „Nie pamiętam”, pominięcie lub przerwanie, jeśli wystąpiły;
- szczegóły pisowni: zgodność słowa, zapis liter i kapitalizację;
- wynik każdej ocenianej umiejętności;
- przyczynę braku oceny;
- dostępną ocenę wymowy i identyfikację providera;
- czas zdarzenia i opcjonalnie czas odpowiedzi;
- wersję reguł oceny, potrzebną do interpretacji wyniku.

Prezentację słowa i ujawnienie rozwiązania, także w opcjach, fragmencie słowa, audio lub feedbacku, zapisujemy jako zdarzenia nauki potrzebne do oceny niedawnej ekspozycji. Nie są poprawną odpowiedzią dziecka. Rejestrujemy również pierwszy i kolejne odsłuchy pytania ze słuchu, bez utożsamiania ich z pokazaniem polskiej odpowiedzi.

Ponowienie wysyłki tego samego wyniku po problemie sieciowym nie może tworzyć podwójnej próby. Zamknięcie aplikacji nie usuwa już zapisanej historii.

Nie trzeba budować pełnego systemu event sourcing. Wymagany jest prosty, wiarygodny zapis prób i oddzielne podsumowanie postępu. Nie zapisujemy surowego nagrania jako części historii.

## 21. Śledzenie mylonych elementów

System zapisuje konkretną pomyłkę, np. oczekiwano „Thursday”, wybrano „Tuesday”. Zachowuje kierunek pomyłki, typ zadania i profil dziecka.

Przykład znaczenia danych:

```json
{
  "expected": "Thursday",
  "answered": "Tuesday",
  "exerciseType": "reverse_recognition",
  "result": "incorrect"
}
```

Po powtarzającej się pomyłce algorytm częściej dobiera ćwiczenia porównujące tę parę. Panel może pokazać ją jako „Thursday ↔ Tuesday”, ale nie wolno zakładać, że pomyłki rzeczywiście występują w obu kierunkach.

Nie zapisujemy mylonej pary na podstawie niewiarygodnego rozpoznania mowy. Błędy pisowni, trudności wymowy i pomylenie znaczeń są różnymi rodzajami trudności.

## 22. TTS i pliki audio

Naturalna wzorcowa wymowa jest obowiązkową częścią modułu słownictwa angielskiego. Początkowa preferencja to TTS OpenAI; konkretny model i głos zostaną dobrane podczas projektowania integracji. Lekcje gramatyki (np. Present Simple) nie generują audio odpowiedzi ani nie pokazują głośnika przed odpowiedzią; po ocenionej odpowiedzi czytają pełne poprawne zdanie (nagranie przygotowane przy publikacji; od Etapu 3 rozdziału to samo robi lekcja „Angielski — rozdział”, §37). Jedyny wyjątek to ćwiczenie „Posłuchaj i wybierz” (`lesson_listen_choice`, 2026-11-01, #198): to samo nagranie zdania jest tam bodźcem przed odpowiedzią. Serwer zapisuje ekspozycję przed wydaniem nagrania, próba jest zawsze wspomagana (nie liczy się do opanowania), a ćwiczenia nie wydaje się bez gotowego nagrania; publikacja na nagranie nie czeka.

TTS musi być oddzielony interfejsem od domeny:

```ts
interface TtsProvider {
  synthesize(text: string, locale: string): Promise<AudioAsset>;
}
```

Audio słów i używanych przykładów powstaje podczas przygotowania zestawu i jest przechowywane jako plik. Naciśnięcie głośnika odtwarza istniejący plik, bez nowego wywołania TTS.

Identyfikacja zasobu uwzględnia tekst, język/wariant, głos oraz istotne ustawienia syntezy. Zmiana tekstu lub głosu nie może odtwarzać starego, niedopasowanego nagrania.

Rodzic widzi stan przygotowania audio. Zestaw nie jest przedstawiany jako gotowy do pełnej nauki ze słuchu, jeśli obowiązkowe pliki nie powstały. Błąd przygotowania zasobu można ponowić bez ponownego generowania całego zestawu.

Domyślny wariant angielskiego: en-GB. Wzorce i ocena wymowy muszą używać zgodnego wariantu. Cache TTS i pliki ilustracji nie zawierają nagrań głosu dziecka.

## 23. STT i ocena wymowy

STT rozpoznaje treść, a Pronunciation Assessment ocenia wymowę. Nie utożsamiamy tych funkcji.

Konceptualne interfejsy:

```ts
interface SttProvider {
  transcribe(audio: Blob, locale?: string): Promise<TranscriptionResult>;
}

interface PronunciationProvider {
  assess(
    audio: Blob,
    expectedText: string,
    locale: string
  ): Promise<PronunciationResult>;
}
```

Wyniki muszą umieć reprezentować brak wiarygodnej oceny. `overallScore` nie może być obowiązkową liczbą dla ciszy, awarii i niepewnego wyniku; zero nie zastępuje informacji o błędzie.

Wynik STT może zawierać rozpoznany tekst, status i miarę pewności, jeżeli provider ją udostępnia. Nie wymyślamy pewności, której usługa nie zwraca.

Wynik oceny wymowy może zawierać status, wynik ogólny, wynik słowa, opcjonalne fonemy i ich wyniki oraz tekst rozpoznany przez usługę. Szczegóły fonemów nie są wymaganym elementem interfejsu dziecka.

Pierwszą planowaną implementacją oceny wymowy jest Azure Speech Pronunciation Assessment. To preferencja implementacyjna, a nie zależność domeny od Azure. ELSA, SoapBox i SpeechSuper są przykładami potencjalnych przyszłych adapterów; ich dostępność, warunki i przydatność trzeba sprawdzić przed integracją. MVP nie wymaga ich implementacji.

Adapter musi określić, czy uzyskany tekst rzeczywiście nadaje się do niezależnej oceny treści odpowiedzi. Ocena nagrania względem zadanego `expectedText` nie jest sama w sobie dowodem, że dziecko powiedziało właściwe słowo. W razie potrzeby stosujemy osobną transkrypcję.

Przed uznaniem integracji za gotową należy sprawdzić jej zachowanie na dziecięcej mowie, błędnym słowie, ciszy i zakłóceniach. Wynik usługi służy nauce, a nie diagnozie logopedycznej.

Publiczny feedback mowy może zawierać ograniczony, wiarygodnie rozpoznany tekst i maksymalnie sześć fragmentów `good | almost | unknown`; nie zawiera score'ów, confidence ani IPA. Audio dziecka jest krótkotrwale przetwarzane w pamięci i nie trafia do plików, kolejki, logów ani trace. Wzorzec z karty wyniku wymaga osobnej autoryzacji aktualnej próby i zapisu ekspozycji przed wydaniem zasobu.

## 24. Pomoce wizualne

Obraz ma wspierać znaczenie, a nie być przypadkową dekoracją zapamiętywaną zamiast słowa.

```ts
type VisualType =
  | "object"
  | "action"
  | "color"
  | "number"
  | "sequence"
  | "person"
  | "place"
  | "concept"
  | "none";
```

Przykłady:

| Materiał | Wizualizacja |
| --- | --- |
| Apple | Jabłko |
| Dog | Pies |
| Red | Czerwone pole |
| Eleven | Jedenaście wyraźnie policzalnych obiektów |
| Monday | Pierwsza pozycja tygodnia rozpoczynającego się w poniedziałek |
| Thursday | Czwarta pozycja tego samego tygodnia |
| Pojęcie bez jednoznacznego obrazu | Brak ilustracji lub prosta, zatwierdzona pomoc |

Kolory, liczby i sekwencje należy przedstawiać deterministycznie, tak aby liczba elementów i pozycje były poprawne. Nie potrzebują generowania bitmap przez AI.

Generowanie ilustracji obiektów i czynności jest częścią MVP: co najmniej jedna implementacja `ImageProvider` musi przygotowywać obrazy do ponownego użycia. Dla kart typu `object` i `action` z sensowną, zatwierdzalną wizualizacją aplikacja podejmuje próbę wygenerowania ilustracji podczas przygotowania zestawu. Nie może pomijać całej tej funkcji przez domyślne ustawianie `none` dla wszystkich kart.

Rodzic widzi ilustrację przed publikacją i może ją zaakceptować albo usunąć. Błędny lub niedostępny obraz nie blokuje nauki: rodzic może ponowić generowanie albo świadomie udostępnić kartę bez ilustracji. Typ `none` jest poprawny również wtedy, gdy obraz nie pomaga w wyjaśnieniu danego pojęcia.

Generowanie ilustracji nie odbywa się podczas sesji ani przy każdym otwarciu karty. Ilustracje są pomocami dydaktycznymi; ich brak nie może uniemożliwiać zadań, które opierają się na tekście lub audio.

Nie wolno przypisywać przypadkowo „Monday → słońce”, „Tuesday → książka” jako rzekomej wizualizacji znaczenia.

## 25. Panel postępów rodzica

Uzupełnienie review lekcji (2026-10-13, wymaganie 3.3): przed publikacją rodzic widzi rzeczywiste karty wyjaśnienia z katalogu oraz edytuje przykłady lekcji. Podgląd odzwierciedla niezapisane przykłady, a zapis i ponowne otwarcie zachowują poprawioną treść. Reguły katalogu pozostają tylko do odczytu.

Panel jest prosty, filtrowany według dziecka i zestawu. Pokazuje:

- pełną listę słów bieżącej opublikowanej wersji zestawu, z polskim znaczeniem i osobnym statusem każdej z pięciu umiejętności (tabela na desktopie, karty na telefonie); statusy prezentowane jako kolorowe kropki ze wspólną legendą i tekstem dla czytników ekranu; zmiana materiału wymagająca ponownego sprawdzenia jest oznaczona przy słowie;
- rozpoznawanie ze słuchu i tekstu;
- samodzielne przypominanie;
- samodzielną pisownię;
- automatyczne wyniki wymowy wraz z informacją „nie sprawdzono”, gdy brak danych;
- słowa i umiejętności wymagające powtórki;
- najczęściej mylone elementy;
- informację, czy wynik został potwierdzony po przerwie;
- termin sprawdzianu, jeśli go ustawiono;
- zbiorczą aktywność dziecka z ostatnich 7 dni, niezależnie od wybranego zestawu: kafelki dobowe i cztery liczby kluczowe — przybliżony czas nauki (liczony do ostatniej aktywności sesji, z obcięciem do limitu sesji), liczba dni z nauką, liczba podejść (sesji) i liczba odpowiedzi; rozkład podejść per zestaw pozostaje w drobnym wierszu, liczba interakcji (kliknięć) pozostaje w danych, ale poza widokiem; wznowienie sesji w oknie wznowienia to jedno podejście;

Przykład:

> Dni tygodnia — Krzysztof  
> Opanowanie: paski per umiejętność — Rozpoznaje ze słuchu 6/7, Przypomina samodzielnie 5/7, Pisze samodzielnie 3/7
> Do ćwiczeń: chipy — Wednesday (pisownia), Thursday (przypominanie)
> Najczęstsza pomyłka: Thursday → Tuesday (3×)

Nie wymagamy dużego dashboardu analitycznego ani wykresów. Dane liczbowe wymowy są dostępne rodzicowi, ale bez sugerowania, że wynik usługi jest precyzyjną miarą całej znajomości słowa.

## 26. Prywatność i dostęp

Aplikacja jest prywatna i rodzinna. Zbieramy tylko informacje potrzebne do prowadzenia nauki.

Nagranie dziecka:

1. Jest rejestrowane po świadomym uruchomieniu mikrofonu.
2. Trafia do skonfigurowanej usługi rozpoznawania lub oceny wymowy.
3. Po zakończeniu analizy jest usuwane z tymczasowych zasobów aplikacji, także przy błędzie.
4. Nie trafia domyślnie do trwałego storage, cache, logów ani historii prób.

Przechowujemy potrzebny wynik, np. transkrypcję, status i ocenę. Nie zapisujemy pełnych odpowiedzi dostawcy bez potrzeby. Klucze usług pozostają po stronie serwera.

Model oceniający lekcji (2026-10-12): gdy jest skonfigurowany, serwer wysyła do zgodnej z OpenAI usługi oceny wyłącznie treść ćwiczenia, regułę i odpowiedź tekstową dziecka (do 200 znaków), jako dane, nie polecenia. Nie wysyła imienia, wieku ani identyfikatorów dziecka. Token usługi nie trafia do przeglądarki, logów ani DTO; komentarz modelu widzi tylko rodzic. Panel rodzica informuje, do której usługi trafiają odpowiedzi dziecka, gdy model jest włączony. Zapisany werdykt (bez danych dziecka) jest wspólnym materiałem ćwiczenia i przeżywa usunięcie profilu.

Usunięcie nagrania przez aplikację nie oznacza automatycznie braku retencji po stronie zewnętrznego dostawcy. Wybór i konfiguracja usługi muszą uwzględnić jej zasady przetwarzania głosu dziecka; rodzic powinien wiedzieć, do jakiej usługi trafia audio.

Opcjonalna trwała archiwizacja nagrań jest poza MVP i wymagałaby osobnego ustawienia rodzica. Usunięcie profilu powinno umożliwiać usunięcie powiązanych z nim wyników i historii, bez kasowania wspólnych zestawów innych dzieci.

Aplikacja ma być dostępna również poza domem. Szczegółowy sposób dostępu jest odłożony do etapu wdrożenia. Brak osobnego logowania dziecka nie oznacza publicznego dostępu do danych rodziny. Zabezpieczenie wejścia z internetu i PIN panelu rodzica to odrębne zagadnienia; przed publikacją należy ustalić pierwsze z nich. Mikrofon i połączenia zdalne wymagają odpowiednio skonfigurowanego HTTPS.

## 27. Wymagania techniczne i granice architektury

Preferencje odziedziczone z pierwotnej specyfikacji:

- frontend i backend: Next.js oraz TypeScript;
- baza danych: PostgreSQL;
- ORM: Prisma albo Drizzle — wybór w projekcie architektury;
- UI: Tailwind CSS;
- aplikacja: PWA;
- wdrożenie: Docker / Coolify;
- organizacja: modularny monolit;
- jeden deploy aplikacji plus PostgreSQL, bez mikroserwisów;
- trwałe przechowywanie wygenerowanych zasobów, niezależne od odtworzenia kontenera.

Wszystkie integracje AI są oddzielone od domeny przez interfejsy. Przewidywane granice to `LLMProvider`, `TtsProvider`, `SttProvider`, `PronunciationProvider`, `ImageProvider` oraz w przyszłości `DocumentAnalysisProvider`.

Bezpośrednie wywołania dostawców nie mogą być rozproszone po komponentach interfejsu. Zmiana dostawcy ma wymagać wymiany adaptera i konfiguracji, bez przepisywania logiki nauki. Nie oznacza to, że wszyscy dostawcy mają identyczne możliwości albo porównywalne skale ocen.

PWA musi umożliwiać dodanie aplikacji do ekranu głównego. Pełna praca offline nie jest wymaganiem MVP. Błąd sieci nie może udawać zapisania postępu ani zmieniać poprawnej odpowiedzi w błędną.

W projekcie architektury trzeba opisać trwałość danych i zasobów, ich kopie zapasowe oraz odtworzenie po aktualizacji. Nie wymaga to rozbudowanego panelu administracyjnego.

## 28. Przedmioty szkolne z materiału rodzica (2026-10-28, stan kodu 2026-10-29)

Moduł rozszerza silnik lekcji (§29a) o przedmioty szkolne — historię, biologię, język polski i inne — jako generyczny przedmiot `school`, którego zagadnienia powstają z materiału dostarczonego przez rodzica, a nie z katalogu w kodzie. Status: wymagania i projekt w `.kiro/specs/school-subjects/{requirements,design,tasks}.md`. W kodzie: Etapy 1–2 (przedmiot z tekstu wklejonego, typy zamknięte i odpowiedź otwarta z oceną dwuwymiarową), Etap 2b (zadania rachunkowe liczone przez kod), Etap 3 (odpowiedź mówiona przez dyktowanie do pola), Etap 4 (trener precyzji), Etap 5 (raport kartkówki z wymiarem precyzji), Etap 6 (kategorie fragmentów i pomylone pojęcia), Etap 7 („Połącz w pary” i „Pogrupuj”), Etap 8 („Posłuchaj pytania”, a jako jego kontynuacja „Posłuchaj karty”) i Etap 10 („Uzupełnij tekst”). Całość jest niezweryfikowana pilotażem z dzieckiem ani na fizycznym urządzeniu; dyktowanie sprawdzono tylko na syntetycznym polskim głosie. Zestaw szkolny jest lekcją; słówka i gramatyka pozostają bez zmian, a raport Hermesa nadal wyklucza lekcje.

Wejściem jest wyłącznie tekst wklejony przez rodzica (jeden zestaw = jeden podrozdział; limit materiału dla przedmiotu szkolnego: 16 000 znaków; od Etapu 2 rozdziału angielskiego ten sam tekst można zapisać jako źródło i utworzyć z niego zestaw szkolny bez ponownego wklejania — §37), np. wierne opracowanie przygotowane w narzędziu zewnętrznym (NotebookLM) ze zdjęć podręcznika. Upload plików, OCR, analiza dokumentów i wyświetlanie obrazów z podręcznika są poza zakresem (decyzja właściciela); kształt powiązań ze źródłem ma pozwolić dopiąć je później bez zmiany znaczenia zapisanych prób.

Przebieg: rodzic podaje przedmiot, temat i materiał → system wyprowadza zagadnienia z kartami nauki oraz pulę ćwiczeń (w tym rodziny pytań: kilka sformułowań tego samego pytania o wspólnych wymaganych elementach odpowiedzi, bez generowania pytań w trakcie sesji) → rodzic edytuje i zatwierdza → dziecko ćwiczy typami: karta nauki, wybór (też prawda/fałsz), luka, porządkowanie, odpowiedź otwarta (pisemna), zadanie rachunkowe (Etap 2b) oraz od Etapu 7 „Połącz w pary” (3–5 par z materiału, np. pojęcie i opis, plus do 2 odpowiedzi bez pary) i „Pogrupuj” (2–3 grupy, 4–8 elementów). W obu dziecko tylko stuka: wybiera miejsce przy pojęciu albo grupę i dotyka pasującego elementu; „Sprawdź” wysyła komplet, a ocena jest deterministyczna (dobrze/źle, przy błędzie dziecko widzi poprawne pary lub grupy). To nauka wspomagana, dostępna też w kartkówce. Od Etapu 10 (2026-10-30) „Uzupełnij tekst”: krótki tekst z materiału (2–4 zdania) z 2–4 ponumerowanymi lukami i bankiem słów z 1–2 słowami-pułapkami; dziecko stuka miejsce luki pod tekstem i słowo z banku, wstawione słowa widzi w tekście, a przy błędzie dostaje cały poprawnie uzupełniony tekst. Ocena jest deterministyczna i wspomagana (bank widoczny), także w kartkówce; „Posłuchaj pytania” czyta tekst z „luka” w miejscu luk, bez banku. „Posłuchaj pytania” (Etap 8, 2026-10-30): przy poleceniu ćwiczenia jest głośnik, który na żądanie odtwarza nagranie lektora z polecenia i pytania (bez opcji odpowiedzi, klocków i par, bo ich kolejność losuje się przy każdym zadaniu; bez zadań rachunkowych). Nagranie powstaje przy przygotowaniu materiału z zatwierdzonego tekstu rodzica (bez danych dziecka), publikacja na nie nie czeka — bez gotowego nagrania przycisku nie ma. Odsłuch działa też w kartkówce, nie odtwarza się sam, nie jest ujawnieniem i nie zmienia samodzielności; nagrywanie odpowiedzi go zatrzymuje. „Posłuchaj karty” (2026-10-30, design §12): karta nauki ma w nagłówku obok tytułu głośnik, który na żądanie czyta tytuł, treść i przykłady karty dokładnie tak, jak widać je na ekranie (wypunktowanie jako pauza). Karta z zapisem matematycznym (ułamki, potęgi, indeksy, symbole działań, znak „=” między wartościami) nie ma nagrania, bo lektor bywa czyta go błędnie. Nagranie powstaje przy edycji materiału, publikacja na nie nie czeka, a „Dalej” je zatrzymuje; koszt to ok. 0,09 USD za typową lekcję. Zadanie rachunkowe ma zamknięty rodzaj obliczenia (odległość ze skali mapy, różnica wysokości, przeliczanie cm/m/km) i parametry: model proponuje wyłącznie rodzaj i parametry, a treść pytania, poprawny wynik i ocenę liczy kod. Rodzic widzi warianty pogrupowane w rodziny z policzonymi odpowiedziami i zatwierdza je przed publikacją. Dziecko wpisuje wynik w polskim zapisie (przecinek dziesiętny, spacje tysięcy, opcjonalna jednostka przeliczana na jednostkę polecenia); błędna liczba to błąd, a zapis nieczytelny to „nieocenione” bez kary. Model oceniający nie bierze w tym udziału. Trener precyzji (Etap 4): po odpowiedzi niepełnej lub nie na temat kolejna sesja może dołożyć „najpierw słowa kluczowe” — dziecko wybiera 2–3 najważniejsze pojęcia i zaraz potem odpowiada na pytanie, co jest nauką wspomaganą, nie samodzielnym sprawdzeniem; „odpowiedz w jednym zdaniu” to pytanie o formie zadanej przez materiał, preferowane po rozwlekłych odpowiedziach; po poprawnej, lecz rozwlekłej odpowiedzi dziecko dostaje „Skróć swoją odpowiedź”: widzi swój tekst z zaznaczonymi fragmentami do usunięcia i pisze krótszą wersję, poza budżetem sesji i nie po obietnicy „Jeszcze 3 i koniec!”. Poprawka jest osobną, powiązaną próbą, nigdy samodzielnym sukcesem; utrata wymaganego elementu jest wykrywana i widoczna dla rodzica. Od Etapu 6 (2026-10-29) zaznaczenia w „Skróć swoją odpowiedź” rozróżniają informacje poprawne, ale zbędne, od niezwiązanych z pytaniem (osobny styl i legenda, inna podpowiedź), a ocena wykrywa pomylone pojęcia (np. „równoleżnik” zamiast „południk”): taka odpowiedź nigdy nie jest zaliczona, rodzic widzi „Myli pojęcia” przy zagadnieniu i w raporcie kartkówki, a następna sesja wybiera przy tym zagadnieniu pytanie porównawcze, jeśli pula je ma (generator dokłada takie pytania dla par łatwo mylonych pojęć). Odpowiedź mówiona (Etap 3, 2026-10-29): w treningu z włączonym mikrofonem dziecko może podyktować odpowiedź otwartą (także „Skróć swoją odpowiedź”) — dotyka mikrofonu, mówi do 45 s, dotyka ponownie. Rozpoznany po polsku tekst trafia do pola odpowiedzi („Sprawdź, czy dobrze cię usłyszałem”); dziecko może go poprawić, nagrać ponownie albo od razu wysłać „Sprawdź”, a ocena jest ta sama co odpowiedzi pisanej. Cisza, niepewne lub nieudane rozpoznanie nie dają tekstu ani próby — nigdy błędu wiedzy; zadanie czeka, a pisanie zostaje dostępne obok. Bez oceny wymowy. Kartkówka pozostaje pisemna. Rodzic widzi wiedzę osobno dla odpowiedzi pisanych i dyktowanych (z liczbą dyktowań poprawionych przed wysłaniem) oraz nazwę usługi rozpoznawania mowy; nagranie nie jest nigdzie zapisywane.

Odpowiedź otwarta ma odpowiedź wzorcową i listę wymaganych elementów. Ocena jest hybrydowa jak w lekcjach (warianty → cache werdyktów → model) i **dwuwymiarowa**: wiedza (`correct|partial|incorrect`) steruje postępem zagadnienia, a precyzja (`concise|verbose|unfocused` — na temat, uporządkowana, bez dygresji) jest tylko raportowana i dobiera ćwiczenia trenera. Rozwlekła, lecz poprawna odpowiedź zalicza wiedzę; odpowiedź z istotnym błędem rzeczowym nie jest zaliczana mimo właściwych słów kluczowych; poprawne parafrazy są uznawane. Awaria lub brak modelu to „nieocenione” bez kary. Panel rodzica pokazuje wiedzę i precyzję osobno. Ocena dwuwymiarowa działa od Etapu 2 na gałęzi modułu (limit odpowiedzi szkolnej do modelu: 600 znaków; lekcje gramatyki bez zmian — 200).

Próbna kartkówka zestawu szkolnego (Etap 5) przebiega jak kartkówka lekcji: bez podpowiedzi, wzorców i skracania w trakcie. Po zakończeniu rodzic widzi per zagadnienie wiedzę i precyzję odpowiedzi otwartych oraz najczęściej brakujące informacje. Dziecko w omówieniu widzi przy odpowiedzi otwartej jedno gotowe zdanie-wskazówkę („Dobrze! Następnym razem spróbuj krócej.”, „Dobrze! Trzymaj się samego pytania.”, „Zabrakło ważnej informacji. Porównaj z poprawną odpowiedzią.”) oraz listę „Warto powtórzyć” z zagadnieniami, w których odpowiedź była błędna, niepełna albo pominięta. Lista jest informacją, harmonogram powtórek nadal wynika z historii ocen.

Przykład: wklejone opracowanie rozdziału o chrzcie Polski → zagadnienia o dacie, przyczynach i znaczeniu chrztu, pytania z wymaganymi elementami, próbny sprawdzian bez podpowiedzi.

## 29. Source grounding — wymaganie modułu przedmiotów szkolnych

Pytania i odpowiedzi wzorcowe zestawu szkolnego powstają wyłącznie na podstawie materiału rodzica. Karty nauki mogą upraszczać wyjaśnienia własnymi słowami i dokładać przykłady pomocnicze, ale system nie dopisuje nowych faktów do treści sprawdzanej ćwiczeniami. Każde ćwiczenie nosi co najmniej jeden cytat źródłowy będący dokładnym fragmentem tego materiału (albo tekstu dopisanego i oznaczonego przez rodzica); walidacja puli odrzuca ćwiczenie bez pokrycia zamiast dopisywać fakt z wiedzy modelu. Rodzic może wybrać „Skąd to pytanie?” i zobaczyć cytat.

W odpowiedzi ustnej STT ustala tekst, dziecko widzi go przed wysłaniem, a ocena merytoryczna odnosi zatwierdzony tekst do wymaganych elementów i materiału. Ocena wymowy nie jest potrzebna do zaliczenia odpowiedzi historycznej, a niepewna transkrypcja nie daje tekstu ani oceny (zadanie czeka na ponowienie albo pisanie).

Aplikacja nadal nie zawiera uploadu dokumentów ani OCR; czytelność zdjęć i wierność opracowania weryfikuje rodzic przy przygotowaniu tekstu w narzędziu zewnętrznym.
## 29a. Lekcje i przedmioty (2026-10-12)

Uzupełnienie wprowadza drugi rodzaj materiału obok zestawu słówek: **lekcję**. Lekcja uczy czasu/konstrukcji gramatycznej (tematy katalogu: Present Simple oraz czasownik „to be”, dodany 2026-10-26) na materiale, który dziecko przerabia w szkole. Szczegółowe wymagania i kryteria: `.kiro/specs/grammar-module/{requirements,design}.md`; poniżej opis produktu.

### 29a.1. Pojęcia

- **Przedmiot** — dziedzina nauki (pierwszy: angielska gramatyka). Silnik lekcji jest niezależny od przedmiotu; przedmiot jest wtyczką dostarczającą katalog, typy ćwiczeń, normalizator odpowiedzi, kategorie błędów, profil promptów i walidatory. Docelowo ten sam silnik obsłuży historię, biologię czy geografię.
- **Temat** — czas lub konstrukcja (Present Simple; czasownik „to be” z regułami: formy twierdzące am/is/are, skróty, przeczenia, pytania przez inwersję, krótkie odpowiedzi). **Reguła** (w kodzie: cel nauki) — najmniejsza sprawdzana jednostka („-s w 3. osobie l.p."). Tematy, reguły, karty wyjaśnienia i kategorie błędów są wersjonowanymi danymi katalogu, więc kolejny temat nie wymaga zmian w kodzie.
- **Lekcja** — zestaw dla jednego tematu z pulą ćwiczeń zatwierdzoną przez rodzica.

### 29a.2. Tworzenie i publikacja

Rodzic wybiera temat z katalogu, wkleja materiał z rozdziału (do 8000 znaków), wybiera reguły (domyślnie wszystkie) i wielkość puli. System generuje szkic lekcji i trwałe zadanie generowania w jednej transakcji (klucz idempotencji jak przy słówkach). Generowanie tworzy ćwiczenia jednoregułowe tylko dla wybranych reguł i typów katalogu oraz przykłady zdań do kart wyjaśnienia (teksty reguł pochodzą z katalogu, nie z modelu). Niepoprawne ćwiczenie jest odrzucane pojedynczo; całkowity błąd nie publikuje częściowej lekcji. Rodzic przegląda ćwiczenia pogrupowane po regułach, edytuje odpowiedzi/warianty/opcje/klocki/element sprawdzany, dogenerowuje i publikuje. Publikacja wymaga pokrycia etapów każdej reguły (≥3 prowadzone, 4 produktywne, 2 tłumaczenia). Cykl szkicu i niezmienność jak przy słówkach; lekcja z materiału nie tworzy zestawu słówek.

### 29a.3. Interaktywny przebieg

Dziecko dostaje najpierw karty wyjaśnienia reguły, potem ćwiczenie wskazania zmieniającego się słowa, a następnie ćwiczenia w etapach: prowadzony (wybór formy, układanie z klocków, krótka odpowiedź), produktywny (uzupełnienie luki, poprawienie błędu, przekształcenie zdania) i samodzielny (tłumaczenie z polskiego oraz typy produktywne na ćwiczeniach niewidzianych). Poza etapami sesja może dołożyć „Posłuchaj i wybierz” (`lesson_listen_choice`, #198): dziecko słyszy pełne zdanie po angielsku, widzi je z luką i wybiera brakującą formę z 2–4 opcji (ćwiczy słyszenie końcówek i skrótów, np. `-s`, `doesn't`). Odtwarza się samo raz po wyświetleniu, opcje są nieaktywne do końca pierwszego odsłuchu, a odpowiedź bez odsłuchu jest nieoceniona. To ćwiczenie dodatkowe (najwyżej 2 na regułę w lekcji, także po dogenerowaniu, ponad wielkość puli; najwyżej 1 na regułę i 2 na sesję), wspomagane, neutralne dla etapów i nieotwierające cyklu wsparcia; nie występuje w kartkówce. Ćwiczenie wyboru może mieć bodziec obrazkowy (`visualSubject`: piktogram chłopca, dziewczynki, mężczyzny, kobiety, grupy albo psa) — wtedy dziecko dopasowuje zaimek do osoby z obrazka, a walidacja puli wymaga zgodności zaimka odpowiedzi i formy „to be” w zdaniu z piktogramem. Dwie kolejne poprawne odpowiedzi awansują etap. Po błędzie lub „Nie pamiętam" dziecko widzi zaznaczony błędny fragment, podpowiedź z szablonu kategorii i poprawną odpowiedź, a potem jeden cykl wsparcia (karta przypomnienia + łatwiejsze ćwiczenie) — najwyżej raz na regułę i sesję. Sesja wprowadza najwyżej dwie nowe reguły i zachowuje budżet sesii zestawu (domyślnie 20 ocenianych; limit czasu min. 10 minut, 45 s na zadanie); cała ścieżka działa bez mikrofonu. W oknie przygotowania do sprawdzianu (48 h) selektor preferuje etap samodzielny nieopanowanych reguł.

### 29a.4. Ocena odpowiedzi tekstowych

Odpowiedź jest najpierw porównywana z zatwierdzonymi wariantami po normalizacji (NFC, apostrofy, wielkość liter, interpunkcja, spacje, rozwinięcie angielskich skrótów). Zgodność → poprawna bez modelu. Drobna literówka poza elementem sprawdzanym → „Prawie!" bez modelu; błąd w elemencie sprawdzanym nie zalicza reguły. Odpowiedź niedopasowana używa zapisanego werdyktu, a przy jego braku — modelu oceniającego (gdy skonfigurowany i limit sesji niewyczerpany). Model zwraca werdykt `correct | almost | incorrect`, kategorię błędu z listy reguły i fragmenty jako dokładne podciągi odpowiedzi; wynik niezgodny ze schematem lub regułą jest odrzucany. Werdykt jest zapisywany dla pary (ćwiczenie, znormalizowana odpowiedź, wersja promptu) i współdzielony między dziećmi. Dziecko widzi tylko zatwierdzoną poprawną odpowiedź i podpowiedź z katalogu; komentarz modelu widzi tylko rodzic, który może poprawić werdykt na przyszłość bez wstecznego przeliczania.

### 29a.5. Postęp per reguła i kartkówka

Postęp jest śledzony osobno dla dziecka i reguły, jako projekcja z historii ocen. Opanowanie reguły wymaga trzech ostatnich kwalifikujących sukcesów na różnych ćwiczeniach, z co najmniej jednym w późniejszej sesji innego dnia po ≥12 h. Nieocenione i pominięcia są neutralne; błąd lub „Nie pamiętam" w niezależnym zastosowaniu przerywa serię. Panel rodzica pokazuje status reguły i najczęstsze kategorie błędów; interfejs dziecka nie pokazuje procentów ani tego, czy ocenił model. Istniejące widoki postępu słówek nie obejmują lekcji. Próbna kartkówka działa dla lekcji na dotychczasowych zasadach, z celem „gramatyka" i raportem per reguła.

### 29a.6. Rozszerzalność

Dodanie przedmiotu to nowy katalog modułu i jeden wpis w rejestrze; silnik (typy ćwiczeń, ocena, postęp, selektor, pula, kartkówka, kontrakty Kid API, widoki) nie zawiera logiki specyficznej dla angielskiego ani gramatyki. Reguły specyficzne (np. rozwijanie skrótów) należą do modułu. Test architektoniczny pilnuje, że silnik nie importuje modułów przedmiotów inaczej niż przez rejestr, a przykładowy przedmiot nie-językowy (fixture) przechodzi walidację, generowanie i ocenę bez zmian w silniku.

### 29a.7. Ograniczenia i pozycje odłożone

- **Audio odpowiedzi kanonicznej w gramatyce (A58) — wyłączone 2026-10-14.** Lekcja Present Simple nie generuje ani nie wymaga `target_audio`; dziecko nie widzi głośnika. Serwer ukrywa audio ze starych snapshotów zadań i odrzuca próbę odsłuchu. Inne przedmioty mogą włączyć audio odpowiedzi przez `ttsForAnswers`.
- **Opanowanie bez skonfigurowanego modelu.** Niezależne sprawdzenie reguły może używać produktywnych typów deterministycznych (zwłaszcza `lesson_gap`) na ćwiczeniach niewidzianych — oceniane bez modelu. Dlatego opanowanie reguły jest osiągalne również bez modelu oceniającego, o ile pula zawiera wystarczająco dużo różnych takich ćwiczeń. Model jest wymagany tylko dla odpowiedzi niedopasowanych do wariantów (głównie tłumaczenie zdania i korekty produktywne z nietrafionym wariantem); bez modelu taka odpowiedź jest „nieocenione" bez kary i bez przerwania serii. Hybrydowa ocena jest zatem opcjonalna, zgodnie z projektem.

## 30. Poza zakresem MVP

Nie implementujemy:

- OAuth, kont społecznościowych i rozbudowanej administracji użytkownikami;
- platformy wielorodzinnej i publicznego udostępniania zestawów;
- rankingów, społeczności, marketplace i płatności;
- gotowych kursów językowych i planów CEFR;
- swobodnego czatu AI z dzieckiem, awatarów AI i rozmów realtime;
- natywnych aplikacji Android/iOS;
- rozbudowanej gamifikacji;
- konfigurowalnego przez dziecko Anki/FSRS z dziesiątkami parametrów;
- OCR, PDF i uploadu dokumentów (moduł przedmiotów szkolnych z §28 pracuje na tekście wklejonym przez rodzica);
- pełnej pracy offline;
- trwałego przechowywania nagrań dziecka;
- wszystkich potencjalnych providerów jednocześnie;
- automatycznej oceny długich odpowiedzi otwartych.

Zakres oceny modelem (2026-10-12, uzupełniono 2026-10-28): poza zakresem pozostaje automatyczna ocena DŁUGICH, swobodnych wypowiedzi (esejów, wieloaspektowych odpowiedzi). Ocena KRÓTKICH odpowiedzi w lekcjach (jedno zdanie w zakresie jednej reguły, np. tłumaczenie zdania, poprawienie błędu, przekształcenie) przez model oceniający jest w zakresie modułu lekcji — opisuje ją sekcja „Lekcje i przedmioty" i wyjątek §10. Zaprojektowany moduł przedmiotów szkolnych (§28) dokłada ocenę krótkich i średnich odpowiedzi otwartych względem zatwierdzonej listy wymaganych elementów, z osobnym wymiarem precyzji.

Profile dzieci, historia prób, pisownia i działanie bez mikrofonu są częścią MVP i nie mogą zostać odłożone na podstawie poprzedniej wersji specyfikacji.

## 31. Przykładowy pełny przebieg

### Przygotowanie

Rodzic tworzy profil Krzysztofa, wpisuje „Dni tygodnia po angielsku, 8 lat, początkujący” i ustawia datę sprawdzianu. AI przygotowuje siedem słów, tłumaczenia, przykłady i dane do wizualizacji tygodnia. Aplikacja generuje audio. Rodzic poprawia ewentualne błędy i zatwierdza zestaw.

### Pierwsza sesja

Krzysztof rozpoczyna naukę. Aplikacja przedstawia małą porcję słów, odtwarza wzorce i proponuje proste rozpoznawanie. Stopniowo wprowadza samodzielne odpowiedzi oraz pisownię.

Gdy na „czwartek” odpowie „Tuesday”, zapisuje się konkretna pomyłka. Gdy powie właściwe „Thursday”, ale z trudnością wymowy, przypomnienie i wymowa otrzymują osobne wyniki.

Po dwóch błędnych odpowiedziach aplikacja pokazuje wzorzec i daje łatwiejsze zadanie. Wraca do trudności po innych ćwiczeniach, bez wydłużania sesji ponad zapowiedziany koniec.

### Kolejna sesja

System wykorzystuje historię: częściej ćwiczy mylone słowa i trudną pisownię, a także potwierdza po przerwie wcześniej poprawne odpowiedzi. Bez mikrofonu sesja nadal działa; wymowa pozostaje nieoceniona.

### Podgląd rodzica

Rodzic widzi, że dziecko rozpoznaje większość słów, samodzielnie przypomina pięć, a poprawnie zapisuje trzy. Może sprawdzić, że Thursday jest mylone z Tuesday, podczas gdy problem z Wednesday dotyczy głównie pisowni.

## 32. Kryteria akceptacji MVP

| ID | Scenariusz | Oczekiwany rezultat |
| --- | --- | --- |
| A01 | Rodzic generuje dni tygodnia | Powstaje poprawny strukturalnie szkic siedmiu elementów do przeglądu. |
| A02 | Szkic nie został zatwierdzony | Dziecko go nie widzi. |
| A03 | Rodzic poprawia słowo | Powiązane audio jest zgodne z nową treścią; stare próby zachowują poprzedni kontekst. |
| A04 | Dwoje dzieci korzysta z jednego zestawu | Materiały są współdzielone, a wyniki i powtórki rozdzielone. |
| A05 | Dostępny jest tylko jeden profil | Nie ma zbędnego ekranu wyboru dziecka. |
| A06 | Dziecko poznaje nowe słowo | Widzi znaczenie i ma dostęp do wzorca przed pierwszym samodzielnym sprawdzaniem. |
| A07 | Zadanie sprawdza słuch | Pisownia angielskiej odpowiedzi nie zdradza rozwiązania przed odpowiedzią. |
| A08 | Dziecko wybiera słowo z listy | Wynik nie jest zaliczony jako samodzielne przypomnienie. |
| A09 | Poprawne słowo, słabsza wymowa | Wyniki treści i wymowy są rozdzielone. |
| A10 | Dziecko korzysta z podpowiedzi | Próba jest zapisana jako wspomagana. |
| A11 | Nagranie jest nieocenialne | Nie obniża postępu i nie tworzy fałszywej pary pomyłek. |
| A12 | Brak uprawnienia do mikrofonu | Można kontynuować sesję bez wymowy. |
| A13 | Dwie nieudane próby | Pojawia się wzorzec i łatwiejsze zadanie; nie ma nieskończonej pętli. |
| A14 | Powtarza się Thursday → Tuesday | Historia zachowuje kierunek, a kolejne ćwiczenia uwzględniają tę parę. |
| A15 | Dziecko ćwiczy pisownię | Dostępne są brakujące litery i niezależne wpisanie całego słowa. |
| A16 | Odpowiedź zawiera literówkę | Pisownia jest oceniona osobno; niejednoznaczna treść nie jest automatycznie zaliczona. |
| A17 | Kilka sukcesów w jednej sesji | Nie zastępują potwierdzenia opanowania po przerwie. |
| A18 | Zbliża się sprawdzian | Materiał otrzymuje priorytet, bez rozluźniania kryteriów opanowania. |
| A19 | Dziecko ponownie naciska głośnik | Odtwarzany jest zapisany plik, bez kolejnego wywołania TTS. |
| A20 | Odpowiedź jest wysłana ponownie przez problem sieci | Historia nie zawiera duplikatu tej samej próby. |
| A21 | Analiza nagrania kończy się sukcesem lub błędem | Aplikacja nie zachowuje surowego audio. |
| A22 | Rodzic przegląda postęp | Widzi osobno rozpoznawanie, przypominanie, pisownię i wymowę albo brak jej oceny. |
| A23 | Dziecko kończy sesję wcześniej | Już zapisane próby pozostają dostępne. |
| A24 | Kontener jest odtworzony | Trwałe dane i wygenerowane zasoby nie znikają. |
| A25 | Aplikacja działa na telefonie/tablecie | Główne zadania, odsłuch, nagrywanie i wpisywanie są wygodne w obsłudze dotykowej. |
| A26 | Zaraz po prezentacji lub ćwiczeniu wymowy dziecko poprawnie wpisuje słowo | Zapisujemy poprawne utrwalanie, bez zaliczenia niezależnego sprawdzenia pamięci. |
| A27 | Rodzic zmienia ilustrację, a następnie znaczenie słowa | Ilustracja zachowuje postęp; zmiana znaczenia wymaga ponownego sprawdzenia odpowiednich umiejętności, bez usunięcia historii. |
| A28 | Nowa wersja zestawu zostaje opublikowana w trakcie sesji | Sesja pozostaje przy swojej wersji; jej wynik nie potwierdza umiejętności unieważnionej przez zmianę. |
| A29 | Trzy sukcesy są przeplatane błędami w niezależnym sprawdzaniu | Dowolne trzy historyczne sukcesy nie wystarczają do opanowania. |
| A30 | Sesje odbywają się tuż przed i po północy | Zmiana daty bez wymaganej przerwy nie zalicza potwierdzenia po czasie. |
| A31 | Dziecko wybiera „Nie pamiętam — pokaż” | Dostaje wzorzec i wsparcie; zapisujemy trudność, bez fikcyjnej mylonej pary. |
| A32 | Dziecko pomija zadanie albo nagranie jest nieocenialne | Nie traktujemy zdarzenia jako deklaracji braku wiedzy. |
| A33 | Dziecko ponownie odtwarza pytanie ze słuchu | Odsłuch jest zapisany, lecz nie unieważnia odpowiedzi jako ujawnienie polskiego rozwiązania. |
| A34 | Dziecko odsłuchuje angielskie słowo przed Recall | Wynik jest wspomagany i nie potwierdza samodzielnego przypomnienia. |
| A35 | Dziecko wpisuje „monday” | Znajomość słowa i litery mogą być poprawne; kapitalizacja i pełna pisownia wymagają poprawy. |
| A36 | Dziecko wpisuje zatwierdzony wariant odpowiedzi | Jest oceniany zgodnie z zapisanym kontraktem, bez wywołania LLM. W lekcjach odpowiedź niedopasowaną do wariantów ocenia model oceniający dopiero po deterministycznym dopasowaniu i po sprawdzeniu cache werdyktów (wyjątek §10); zatwierdzony wariant nadal nie woła modelu. |
| A37 | Dziecko ćwiczy pisownię na docelowym telefonie/tablecie | Ustawienia pola ograniczają podpowiedzi klawiatury; pozostałe ograniczenia platformy są znane. |
| A38 | Powstaje zestaw obiektów i czynności | Aplikacja generuje ilustracje przez skonfigurowany provider, a rodzic je przegląda. |
| A39 | Generowanie ilustracji zawodzi | Rodzic może ponowić próbę lub zatwierdzić kartę bez obrazu; nauka pozostaje dostępna. |
| A40 | Rodzic rozpoczyna naukę z profilu dziecka | Link przy profilu otwiera `/kids/{childId}/learn` i wybiera to dziecko; `/` umożliwia wybór profilu z linkiem do panelu rodzica `/parent`, ukrytym podczas ćwiczeń. |

### 32.1. Kryteria akceptacji lekcji i przedmiotów (A41+, 2026-10-12)

Mapują wymagania 1–11 z `.kiro/specs/grammar-module/requirements.md`.

| ID | Scenariusz | Oczekiwany rezultat | Wym. |
| --- | --- | --- | --- |
| A41 | Do katalogu dodano nowy temat gramatyczny | Lekcja z tego tematu powstaje bez zmian w silniku oceny, selektorze, kontraktach Kid API i widokach dziecka. | 1 |
| A42 | Zmiana treści karty wyjaśnienia / szablonu podpowiedzi; zmiana znaczenia reguły | Postęp zachowany przy zmianie treści; zmiana znaczenia reguły nadaje nowy identyfikator; stare wersje tematu zostają dla opublikowanych lekcji. | 1 |
| A43 | Rodzic wkleja materiał podręcznika i wybiera temat + reguły | Powstaje szkic lekcji i trwałe zadanie generowania (jedna transakcja, klucz idempotencji); pula tylko dla wybranych reguł i typów katalogu. | 2 |
| A44 | Część wygenerowanych ćwiczeń nie przechodzi walidacji | Odrzucone pojedynczo, reszta zapisana, rodzic widzi liczbę odrzuconych; błąd całości nie publikuje częściowej lekcji. | 2 |
| A45 | Rodzic publikuje lekcję bez wymaganego pokrycia etapów reguły | Publikacja odrzucona z listą reguł i brakujących etapów (≥3 prowadzone, 4 produktywne, 2 tłumaczenia na regułę). | 3 |
| A46 | Lekcja przechodzi cykl szkicu | draft → review (po generacji) → published; niezatwierdzony szkic niewidoczny dziecku; opublikowana treść niezmienna; edycja tworzy nowy szkic; aktywna sesja zachowuje swoją wersję. | 3 |
| A47 | Dziecko rozpoczyna regułę | Najpierw karty wyjaśnienia, potem wskazanie zmieniającego się słowa; przejście przez etapy prowadzony → produktywny → samodzielny po dwóch kolejnych poprawnych. | 4, 5 |
| A48 | Dziecko popełnia błąd w zakresie reguły albo wybiera „Nie pamiętam" | Zaznaczony błędny fragment, podpowiedź z szablonu kategorii i poprawna odpowiedź, karta przypomnienia i jedno łatwiejsze ćwiczenie — najwyżej jeden cykl na regułę i sesję; „Nie pamiętam" bez kategorii błędu. | 5 |
| A49 | Cała ścieżka lekcji bez mikrofonu; budżet sesji | Lekcja działa bez mikrofonu; najwyżej dwie nowe reguły na sesję; budżet sesii zestawu (domyślnie 20 ocenianych, limit czasu min. 10 minut/45 s na zadanie) bez dokładania po „Jeszcze 3". | 4, 5 |
| A50 | Odpowiedź tekstowa zgodna z zatwierdzonym wariantem po normalizacji | Oceniona jako poprawna bez wywołania modelu; drobna literówka poza elementem sprawdzanym → „Prawie!" bez modelu; błąd w elemencie sprawdzanym nie zalicza reguły. | 6 |
| A51 | Odpowiedź niedopasowana, model skonfigurowany i limit niewyczerpany | Model zwraca werdykt + kategorię z listy reguły + fragmenty (dokładne podciągi); wynik niezgodny ze schematem/regułą jest odrzucony; werdykt zapisany dla pary (ćwiczenie, znormalizowana odpowiedź, wersja promptu). | 6 |
| A52 | Model niedostępny / timeout / limit / wynik odrzucony | Odpowiedź „nieocenione" bez kary i bez przerwania serii; ponowienie tej samej odpowiedzi nie woła modelu drugi raz, nie tworzy drugiej próby i nie zużywa limitu. | 6 |
| A53 | Postęp per reguła | Niezależna próba tylko gdy pierwsza, bez wsparcia, `target_key` nieujawniony; opanowanie po trzech ostatnich kwalifikujących sukcesach na różnych ćwiczeniach z co najmniej jednym po przerwie; błąd/„Nie pamiętam" przerywa serię; projekcje słówek bez zmian. | 7 |
| A54 | Rodzic przegląda i poprawia werdykty modelu | Lista ocen modelu (odpowiedź, werdykt, kategoria, komentarz); zmiana werdyktu obowiązuje przyszłe identyczne odpowiedzi, nie przelicza wstecznie; akceptację można dodać jako wariant w następnym szkicu. | 8 |
| A55 | Próbna kartkówka z lekcji gramatyki | Działa na istniejących zasadach z celem „gramatyka" (niedostępnym dla słówek); plan obejmuje reguły proporcjonalnie, preferuje niewidziane i produktywne; raport per reguła z kategoriami i oznaczeniem ocen modelu. | 9 |
| A56 | Odczyt raportu Hermesa (learning-overview) | Pomija lekcje gramatyki (postęp, kartkówki, planowane sprawdziany); kontrakt v1 i JSON Schema bez zmian; `SKILL.md` informuje, że raport nie obejmuje jeszcze lekcji. | 10 |
| A57 | Przykładowy przedmiot nie-językowy (fixture) | Przechodzi walidację, generowanie (fake provider) i ocenę bez zmian w silniku; test architektoniczny potwierdza, że silnik nie importuje modułów przedmiotów inaczej niż przez rejestr. | 11 |
| A58 | Audio odpowiedzi kanonicznej w lekcji gramatyki (TTS) | WYŁĄCZONE 2026-10-14: brak generowania/obowiązku `target_audio`, brak głośnika w zadaniu; stare audio jest ukrywane i nie można go odsłuchać. Od 2026-10-31 po ocenionej odpowiedzi czytane jest pełne poprawne zdanie (`feedback_audio`). TTS innych przedmiotów pozostaje konfigurowalne. | 4 |
| A59 | Opanowanie z modelem i bez modelu | Opanowanie jest osiągalne bez modelu przez produktywne typy deterministyczne (zwł. `lesson_gap`) na ćwiczeniach niewidzianych, jeśli pula je zawiera; model jest wymagany tylko dla odpowiedzi niedopasowanych (głównie tłumaczenie), gdzie bez modelu wynik to „nieocenione" bez kary. Patrz sekcja „Lekcje i przedmioty — ograniczenia". | 6, 7 |

## 33. Następny krok po zatwierdzeniu specyfikacji

Dopiero po przeglądzie tego dokumentu należy przygotować:

- propozycję najprostszej architektury spełniającej wymagania;
- początkowy schemat bazy danych;
- strukturę katalogów i granice modułów;
- listę decyzji kosztownych do zmiany;
- plan MVP podzielony na małe, weryfikowalne etapy.

Wówczas należy wybrać ORM, sposób przechowywania zasobów, konkretne usługi i modele, obsługę dłuższych zadań generowania oraz reguły interpretacji wyników mowy. Przed udostępnieniem poza domem należy ustalić zabezpieczenie dostępu.

Te wybory nie blokują przeglądu wymagań produktu. Zatwierdzenie specyfikacji nie oznacza zgody na automatyczne rozpoczęcie implementacji całej aplikacji.

## 34. Obrazkowe zestawy słownictwa dla dzieci nieczytających (2026-10-14)

Profil dziecka ma rodzicielską flagę „Dziecko jeszcze nie czyta” (`canRead`, domyślnie `true`), a generowanie słówek oferuje wariant `picture`. W tym wariancie generator pomija pojęcia trudne do jednoznacznego przedstawienia, a rodzic zatwierdza cały materiał przed publikacją. To nadal zestaw słownictwa i używa tego samego przypisania, historii oraz pięciu umiejętności.

Kid UI pokazuje reprezentacje obrazu, koloru lub liczby. Ćwiczenia to prezentacja i słuchanie z wyborem wizualnym, odpowiedź ustna do obrazka oraz przypominanie do obrazka bez pola tekstowego. Stałe instrukcje mają gotowe nagrania przygotowane przez serwer; audio wzorca słowa i ujawnienie są wydawane dopiero po autoryzacji ekspozycji. Dziecko może pominąć zadanie, a odmowa mikrofonu nie resetuje sesji.

Zmiana `canRead` nie usuwa ani nie przepisuje wcześniejszych prób, ocen lub wyników reading/spelling. Raport rodzica zachowuje pełną liczbę słów i wszystkie pięć umiejętności; informuje, że część ćwiczeń mogła nie wystąpić. `learning-overview` v1 i jego JSON Schema pozostają bez zmian, nie zawierają flagi `canRead`, nadal filtrują lekcje, a skill Hermesa wyjaśnia ograniczenie interpretacji. Zmiana danych profilu obowiązuje nowe sesje; aktywna sesja używa zamrożonego ustawienia.

Rozszerzenie (2026-10-19): w zestawach obrazkowych dziecko nieczytające dostaje dodatkowo ćwiczenie §12.4a — obrazek z polskim podpisem i wybór pasującego angielskiego słowa. Ćwiczenie uczy skojarzenia obrazka z pisanym wyrazem i zalicza rozpoznawanie tekstu (`reading`), ale gwiazdki i kryteria §18 dla nieczytających nadal liczą listening/recall. Nowy typ `picture_recognition` wydaje wyłącznie klientowi, który zadeklarował odpowiednią flagę zdolności przy starcie sesji; starsi klienci nie otrzymują go wcale (graceful, wzorzec §35). Odsłuch poprawnego słowa odbywa się tylko w feedbackzie. `learning-overview` v1, MCP i skill Hermesa pozostają bez zmian.

## 35. Wizualne słuchanie w zwykłych zestawach (2026-10-17)

W zwykłym zestawie profil czytający może otrzymać wybór zatwierdzonych ilustracji po usłyszeniu słowa. Dla każdego słowa warianty listening naprzemiennie używają `picture_listening` i dotychczasowego tekstowego `listening`, zaczynając od wizualnego, jeśli istnieją co najmniej dwie bezpieczne, jednoznaczne opcje. Gdy ilustracji brakuje, są niejednoznaczne albo dystraktory są zarezerwowane, scheduler używa zwykłego tekstowego listening. Wspierany klient deklaruje istniejącą flagę `supportsPictureVocabulary`; klient jej nieobsługujący dostaje prompt tekstowy.

Wizualny wybór ocenia wyłącznie rozumienie ze słuchu. Nie zastępuje samodzielnego Recall ani spelling. Działa na istniejących zatwierdzonych wizualizacjach i nie zmienia pozostałych ćwiczeń, budżetu ani treści wydanego zadania. `learning-overview` v1, API, MCP i skill pozostają bez zmian; znaczenie wyniku pozostaje zwykłym listening.

## 36. Raport aktywności sesji i proste punkty (2026-10-20)

Zastępuje plan rozliczania serwerowego nagród (Xbox, dzienne pakiety, saldo do wydania, punkty per zestaw zostały usunięte). Interfejs dziecka zbiera aktywność sesji lokalnie — kolejność zadań, edycje pogrupowane w 5-sekundowe okna (bez treści wpisów), rzeczywiste odsłuchy, pauzy (tło, blur, offline, oczekiwanie techniczne, bezczynność powyżej 60 s) — i wysyła jeden raport przy końcu sesji. Robocza kopia raportu przeżywa odświeżenie karty (7 dni, osobny magazyn); przerwa bez obserwacji nie jest zaliczana jako praca.

Serwer zapisuje raport razem z własnymi zadaniami i odpowiedziami z bazy, po czym dokładnie raz prosi model (osobny port i prompt, wspólna konfiguracja `UMIEM_GRADER_*`, limit 60 s) o wskazanie zadań bez podstaw do zaliczenia pracy wraz z uzasadnieniami. Model nie zwraca sekund ani punktów. Kod oblicza sumę unii aktywnych przedziałów pozostałych zadań i nalicza 1 punkt za każdą pełną minutę; reszta subminuty przechodzi między sesjami. Dorobek dziecka (`reward_points`) jest ogólnym licznikiem, nie saldem do wydania. Trwałe ogólne `activity_review.reason` generuje deterministycznie kod; konkretne uzasadnienia modelu są dostępne wyłącznie w raporcie z 7-dniowym TTL.

Awaria lub niepoprawny wynik modelu: raport i kod błędu zostają zapisane, punktów brak, komunikat dla dziecka brzmi „Nauka zapisana. Nie udało się naliczyć punktów.” Powtórzenie żądania zwraca zapisany wynik bez ponownej oceny i bez drugiego naliczenia; inny raport tej samej sesji dostaje konflikt. Szczegółowy raport (aktywność, pytania, odpowiedzi, wykluczenia) znika po 7 dniach; punkty, krótki wynik i uzasadnienie pozostają. Sesje sprzed wdrożenia nie są rozliczane nowym mechanizmem.

Dziecko widzi jeden licznik punktów na profilu i „Zdobyto N pkt” po treningu i obu kartkówkach; bez procentów uczciwości i oskarżeń. Rodzic widzi w Karcie pracy czas całkowity, aktywny i zatwierdzony, punkty oraz deterministyczne ogólne uzasadnienie; przez 7 dni może rozwinąć szczegóły zadań i uzasadnienia modelu oraz sprawdzić bezpieczną nazwę usługi oceniającej. Po TTL szczegóły nie są odtwarzane z historii prób. To rozszerzenie jest parent-only; raport `learning-overview` i skill Hermesa pozostają przy osobnym szacunku czasu (estimated, vocabulary-only) — nowa ocena go nie zastępuje. Model nie otrzymuje imion, identyfikatorów, kluczy ani nagrań; odpowiedzi dziecka są danymi, nigdy poleceniami.


### Uzupełnienie 2026-10-28 — akcje dziecka

Ekrany dziecka nie oferują zwykłego przycisku „Pomiń”. W formularzach przycisk „Nie pamiętam” znajduje się obok „Sprawdź”; jego znaczenie i zasady ujawniania pozostają takie same. W razie przeszkody technicznej dziecko może ponowić próbę lub wybrać neutralne „Dalej”, które nie oznacza błędnej wiedzy. Wynik `skip` pozostaje w kontrakcie i historii. Usunięto wyłącznie komunikat przejścia, zachowując blokadę wielokrotnej odpowiedzi. API, MCP oraz skill Hermesa nie wymagają zmian.

## 37. Lekcja „Angielski — rozdział” (2026-10-30)

Lekcja (§29a) dla bieżącego rozdziału podręcznika angielskiego: dziecko ćwiczy słowa i ramy zdaniowe z rozdziału zadaniami podobnymi do zeszytu ćwiczeń, a rodzic widzi, które zagadnienia (np. „Pogoda”, „Rama: I'm wearing …”) sprawiają trudność. To osobny przedmiot `english_chapter` obok gramatyki i przedmiotów szkolnych; zestawy słówek ćwiczą pojedyncze słowa z powtórkami, a lekcja rozdziału dokłada poziom zdania. Status: Etap 1 w kodzie (przedmiot z tekstu wklejonego przez rodzica), Etap 2 w kodzie (źródła materiału wielokrotnego użytku, część „Etap 2: źródła” niżej), Etap 3 w kodzie (lektor czytający zdanie po odpowiedzi, część „Etap 3: lektor po odpowiedzi” niżej) i Etap 4 w kodzie (zestaw słówek wyłącznie ze słów źródła, część „Etap 4: słówka ze źródła” niżej); projekt i etapy: `docs/superpowers/specs/2026-10-30-english-chapter-design.md`, plany: `docs/superpowers/plans/2026-10-30-english-chapter-stage1.md`, `docs/superpowers/plans/2026-10-31-english-chapter-stage2-sources.md`, `docs/superpowers/plans/2026-10-31-english-chapter-stage3-readback.md` i `docs/superpowers/plans/2026-10-31-english-chapter-stage4-source-vocabulary.md`. Stan niezweryfikowany pilotażem z dzieckiem ani na fizycznym urządzeniu (poniżej).

**Rodzic.** W formularzu nowej lekcji wybiera „Angielski — rozdział”, podaje tytuł rozdziału (np. „Unit 1”; zestaw nazywa się „Angielski — rozdział: Unit 1”, bez nazwy przedmiotu od rodzica) i wkleja tekst rozdziału — listy słów, zwroty, ramy zdaniowe (do 16 000 znaków), opcjonalnie z poleceniem i wielkością puli. Aplikacja dzieli materiał na 3–5 zagadnień dwóch rodzajów: grupa słów („Ubrania”, „Pogoda”, 4–12 słów) albo rama zdaniowa („I'm wearing (a) …”, „What's the weather like? It's …”), gdzie sprawdzaną częścią jest konstrukcja, a słowa z grup tylko ją wypełniają; do tego przygotowuje pulę ćwiczeń. Rodzic w edytorze (bez nowych edytorów typów) przegląda zagadnienia z rodzajem i ćwiczenia, edytuje, dogenerowuje i publikuje; widzi też liczbę odrzuconych ćwiczeń, pod nią pięć najczęstszych powodów odrzuceń przy sprawdzaniu słów z materiału („słowo spoza materiału: raining ×3”, „tylko słowa pomocnicze: the ×1”) i „inne powody: N” dla odrzuceń z innych reguł, żeby ocenić, czy dogenerować. Podpowiedź wielkości puli na tej ścieżce: „Od 20 do 160 ćwiczeń. Domyślnie 60.” Publikacja wymaga pokrycia etapów każdego zagadnienia: co najmniej 3 zadania prowadzone, 3 produktywne i 2 samodzielne. Edycja rodzica nie jest ograniczona słownikiem rozdziału: może dopisać słowo albo wariant odpowiedzi spoza materiału i opublikować.

**Dziecko.** Najpierw 2–4 karty zagadnienia (lista „słowo — polskie znaczenie” albo wzór ramy z angielskimi przykładami bez tłumaczeń — karta nigdy nie pokazuje polskiego zdania razem z jego angielskim tłumaczeniem), potem zadania w etapach. Prowadzone: „Połącz w pary” (angielskie słowo, zwrot lub pytanie ↔ polskie znaczenie albo angielska odpowiedź), „Pogrupuj” (tylko gdy słowa dzielą się naturalnie na 2–3 kategorie), „Uzupełnij tekst” z bankiem słów i słowami-pułapkami z rozdziału, wybór słowa w angielskim zdaniu z luką i ułożenie zdania z klocków (tylko ramy zdaniowe; jedna poprawna kolejność). Produktywne: wpisanie brakującego słowa w zdaniu. Samodzielne: przetłumaczenie krótkiego polskiego zdania. W zadaniach wyboru, luki i układanki znaczenie niesie polskie zdanie w poleceniu („Dziś pada śnieg. Wybierz słowo.”, „Ułóż zdanie: Mam na sobie różowy płaszcz.”), bo samo angielskie zdanie z luką nie mówi dziecku, co ma wstawić; w „Uzupełnij tekst” polecenie niesie polskie znaczenie całego tekstu („W poniedziałek pada deszcz. W środę wieje wiatr. Uzupełnij tekst.”), więc każda luka jest jednoznaczna, a słowo-pułapka nie pasuje do żadnej. Tłumaczenie ma zawsze polecenie „Przetłumacz na angielski.”. Podpowiedź po pomylonym słowie odsyła do pamięci („Przypomnij sobie słowa z karty.”), bo karty nie da się otworzyć w trakcie sesji. Treść i odpowiedzi są po angielsku (`en-GB`), polecenia i interfejs po polsku; Kid UI oznacza język treści atrybutem `lang` (teksty zadań, pole luki i pole tłumaczenia), żeby czytniki ekranu mogły czytać angielskie słowa po angielsku. Dotyczy to pewnie tylko tekstu nieinteraktywnego: przycisk z polską etykietą `aria-label` wewnątrz elementu `lang="en-GB"` może zostać przeczytany angielskim głosem (do poprawy w Kid UI). Cała ścieżka działa bez mikrofonu i bez nagrań; w Etapie 1 lekcja rozdziału nie czyta zdań na głos.

**Tylko słowa rozdziału.** Prompt generatora każe budować ćwiczenia wyłącznie ze słów i ram z materiału oraz podstawowych słów funkcyjnych (zaimki, rodzajniki, „be”, „do”, „can”, spójniki, przyimki). Serwer sprawdza dodatkowo świeżo wygenerowane ćwiczenia słownikiem materiału (małe litery, apostrofy, skróty, łączniki, prosta odmiana `-s/-es/-ies/-ing/-ed`): ćwiczenie ze sprawdzanym słowem spoza materiału („słowo spoza materiału: …”) albo bez słowa treści (np. luka z samym „It's” — „tylko słowa pomocnicze: …”) jest odrzucane z powodem widocznym dla rodzica, a w luce i tłumaczeniu pojedynczy wariant odpowiedzi spoza materiału jest usuwany bez utraty ćwiczenia. Heurystyka jest przybliżona: słowa z poleceń podręcznika wklejone w materiał liczą się jako słownictwo, a przykłady na kartach i polskie zdania-bodźce nie są sprawdzane (pilnuje ich prompt i przegląd rodzica).

**Znane ograniczenia.** (1) Rozdziału, którego kluczowym materiałem są słowa funkcyjne (przyimki in/on/under, can/can't, this/these, is/are, do/does, he/she), nie da się ćwiczyć na tych słowach jako opcjach, lukach ani słowach banku: reguła słownikowa wymaga słowa treści, więc takie ćwiczenia odpadają jako „tylko słowa pomocnicze”. Przed użyciem z takim rozdziałem trzeba wykonać próbę (`pnpm probe:chapter`) na rozdziale o przyimkach albo o can/can't. (2) Uzupełnianie tekstu ma jeden klucz ekspozycji dla całego tekstu, więc zdanie rozwiązane wewnątrz niego nie blokuje luki ani tłumaczenia tego samego zdania. (3) Słowo pokazane w lekcji tylko jako część treści karty, par, grupy, banku albo zdania nie chroni samodzielnego przypominania tego słowa w zestawie słówek.

**Ocena.** Zadania zamknięte (pary, grupy, uzupełnianie tekstu, wybór, układanka) są oceniane deterministycznie. Wpisana odpowiedź jest porównywana z zatwierdzonymi wariantami po normalizacji (wielkość liter i interpunkcja bez znaczenia, „I'm” = „I am”). Drobna literówka poza sprawdzanym słowem daje „Prawie!”; błąd w sprawdzanym słowie nie zalicza zagadnienia i ma kategorię „Pomylone słowo” albo „Pisownia” (dla układanek i brakujących słów kategorie bazowe „Zła kolejność” i „Niepełna odpowiedź”). Odpowiedź niedopasowana do wariantów (luka, tłumaczenie) trafia do cache werdyktów, a potem do modelu oceniającego, jeśli jest skonfigurowany; model dostaje polecenie z polskim zdaniem, a poprawny synonim spoza rozdziału jest co najwyżej „prawie”. Awaria lub brak modelu to „nieocenione” bez kary i bez przerwania serii.

**Samodzielność.** Ta lekcja sprawdza użycie słowa w zdaniu, więc ekspozycją jest rozwiązane zdanie, a nie pojedyncze słowo: dla wyboru i luki zdanie ze wstawioną odpowiedzią, dla uzupełniania tekstu cały uzupełniony tekst, dla układanki i tłumaczenia odpowiedź (po normalizacji spacji, apostrofów i cudzysłowów oraz końcowej interpunkcji, więc „It's snowing.” i „It’s snowing” to to samo); pary i grupy jak w innych lekcjach. Zadanie samodzielne to zdanie, którego rozwiązania dziecko jeszcze nie widziało. Treść karty i słowo widoczne w parach, grupach lub banku słów nie są ekspozycją; ekspozycją karty są tylko jej przykłady (zdania), liczone tą samą normalizacją co rozwiązane zdania — luka lub tłumaczenie zdania pokazanego jako przykład na karcie nie jest już samodzielne. Klucze lekcji i zestawów słówek pokrywają się dokładnie wtedy, gdy tekst po normalizacji i język są równe — dla pojedynczych słów i wielowyrazowych zwrotów (np. tłumaczenie „poniedziałek” → „Monday” i słówko „Monday” albo „Pada deszcz.” → „It's raining.” i słówko „It's raining”; ekspozycje są wspólne dla dziecka). Zwykle klucz zdania nie pokrywa się z celem słówka, więc zdania lekcji i słówka się nie blokują. Przy pokryciu blokada jest w praktyce asymetryczna: słówka liczą samodzielność w oknie 300 s od ujawnienia, a lekcje od jakiegokolwiek wcześniejszego ujawnienia, więc ekspozycja słówka trwale odbiera samodzielność tłumaczeniu rozdziału o identycznym tekście, a ekspozycja z lekcji blokuje słówko tylko na 300 s (Etap 4, słówka ze źródła, jej nie zmienia — „Znane ograniczenia (Etap 4)” niżej). Opanowanie zagadnienia i reguły powtórek jak w lekcjach (§29a.5): trzy ostatnie kwalifikujące sukcesy na różnych ćwiczeniach, w tym jeden w późniejszej sesji innego dnia po ≥12 h. Należne sprawdzenia samodzielne wybierają najpierw tłumaczenie, a lukę na niewidzianym zdaniu dopiero jako zapas; bez modelu tłumaczenie zalicza tylko dokładne trafienie w wariant (inaczej „nieocenione”), a luka na niewidzianym zdaniu działa bez modelu.

**Próbna kartkówka** jak w lekcjach: bez podpowiedzi, raport per zagadnienie, a pary, grupy i luki z bankiem słów są nauką wspomaganą. Polskie zdanie-bodziec zostaje w poleceniu, więc zadanie jest zrozumiałe bez podpowiedzi.

**Próba na prawdziwym modelu.** Generowanie sprawdzono na odtworzonym materiale Unit 1 (nie na tekście od właściciela) z modelem `google/gemini-3.8-flash`, pula 60, narzędziem `pnpm probe:chapter` (ręczne, płatne, poza CI). Dwa pierwsze przebiegi nie były publikowalne (sprawdzany fragment tłumaczeń nie był ciągły; potem model wypełnił niezamówione cytaty w całej partii), a po strojeniu promptów i czyszczeniu niezamówionych pól trzy kolejne były publikowalne (0%, 0% i 3,3% odrzuconych ćwiczeń, 4–5 zagadnień z rodzajami `words` i `frame`, pokrycie minimów 3/3/2). Przebieg po końcowym przeglądzie (2026-10-31) był publikowalny z 1,7% odrzuconych: wszystkie tłumaczenia miały polecenie, teksty z lukami — polskie znaczenie całego tekstu i jednoznaczne luki, karty ram — przykłady bez tłumaczeń; 16 z 59 ćwiczeń rozwiązywało zdanie z przykładu karty i po jej pokazaniu nie liczy się jako samodzielne. Szczegóły: projekt, sekcja 10.

**Zakres Etapu 1 i dalsze etapy.** Materiałem jest wyłącznie tekst wklejony w formularzu (bez uploadu i OCR). Później, jako osobne PR-y: źródła materiału wielokrotnego użytku dodał Etap 2, lektora czytającego poprawne zdanie w omówieniu zadania Etap 3, a zestaw słówek wyłącznie ze słów źródła Etap 4 (niżej). Poza zakresem: rozsypane litery, zadania z obrazkami, „Posłuchaj pytania” przed odpowiedzią i odpowiedzi mówione w lekcji rozdziału.

**Niezweryfikowane.** (1) Pilotaż z dzieckiem: czy dziecko odczytuje angielskie słowa w parach, grupach i klockach bez pomocy (bodźce są tekstowe). (2) Fizyczne urządzenie: atrybuty `lang` sprawdzono wyłącznie testami komponentów Kid UI, bez czytnika ekranu; specyfikacja geometrii uzupełniania tekstu obejmuje wariant rozdziału (`contentLocale`, długie polskie polecenie), ale par, grup i klocków rozdziału nie mierzono na urządzeniu ani w osobnej specyfikacji geometrii. (3) Prawdziwy materiał właściciela (np. z NotebookLM): próba objęła tylko Unit 1 w odtworzonej wersji. (4) Odrzucanie słownikowe na prawdziwym modelu: ani razu nie odrzuciło ćwiczenia za słowo spoza materiału (odrzucało tylko elementy bez słowa treści, np. lukę z samym „It's”), więc heurystyka odmiany i lista słów funkcyjnych nie były sprawdzone na żywo; na uboższym rozdziale model może częściej wychodzić poza słownik, a rozdziału opartego na słowach funkcyjnych nie próbowano. (5) Jakość ćwiczeń oceniano ręcznie na próbkach: na pulę 60 przypada kilka układanek, wybór bywa dwuopcyjny, a pojedynczy dystraktor w parach bywa z innej kategorii.

`learning-overview` v1, MCP i skill Hermesa pozostają bez zmian: raport nadal obejmuje tylko zestawy słówek, a lekcja rozdziału (jak gramatyka i przedmioty szkolne) jest poza nim. Wdrożenie: serwer dołącza nowe pola Kid DTO (`contentLocale`, `answerLocale`) do zadań lekcji wszystkich przedmiotów (gramatyki, szkolnych i rozdziału), a Kid UI waliduje zadania i sesje ścisłymi schematami, więc web i Kid UI/PWA wdrażamy razem. Po wdrożeniu otwartą kartę lub zainstalowaną PWA trzeba odświeżyć — do tego czasu stary pakiet kończy ogólnym błędem zadania lekcji typów z nowymi polami: wybór, układankę, lukę, pary, grupy, uzupełnianie tekstu i odpowiedź otwartą (tak jak przy wcześniejszych polach w ścisłych schematach, np. `promptLocale`); karty, pozostałe typy lekcji i zestawy słówek nie są dotknięte.

**Etap 2: źródła (2026-10-31).** Rodzic zapisuje tekst rozdziału raz jako źródło i tworzy z niego lekcje bez ponownego wklejania. Zakładka „Źródła” jest drugą z pięciu zakładek panelu rodzica, po „Zestawach”; w interfejsie słowo „materiał” oznacza już zestaw albo lekcję, stąd inna nazwa. Źródło ma tytuł (1–120 znaków) i tekst (1–16 000 znaków, licznik znaków w formularzu).

**Co rodzic może ze źródłem.** (1) „Nowe źródło”: zapis jest bezpieczny przy ponowieniu — gdy wynik jest niepewny (błąd sieci lub serwera), pola zostają zablokowane, a „Ponów zapisywanie” wysyła to samo żądanie, więc nie powstaje duplikat. (2) Lista: tytuł, data zmiany i liczba zestawów (bez zarchiwizowanych). (3) Strona źródła: podgląd tekstu, edycja tytułu i tekstu, usunięcie, lista zestawów utworzonych ze źródła (także zarchiwizowanych, ze stanem) oraz „Utwórz lekcję rozdziału” i „Utwórz lekcję szkolną” (przycisk jest tylko wtedy, gdy przedmiot jest w katalogu lekcji). Przy edycji źródła, z którego powstały zestawy, formularz przypomina: „Zmiana nie zmieni istniejących zestawów. Aby jej użyć, utwórz nową lekcję.”; tekst na limicie 16 000 znaków (np. ucięty przy wklejaniu) dostaje widoczną uwagę. Zamknięcie okna „Nowe źródło” z wpisanym tekstem pyta o jego odrzucenie. (4) Formularz nowej lekcji otwarty ze źródła pokazuje „Ze źródła: <tytuł>”, podgląd tekstu tylko do odczytu i „Zmień źródło” (lista źródeł) zamiast pola materiału, a przycisk u góry „Wróć do źródła”; tytuł źródła podpowiada tytuł rozdziału lub tematu. Ze źródła powstają tylko lekcje przedmiotów tworzonych z materiału (rozdział angielskiego i przedmioty szkolne), nie lekcje gramatyki z katalogu tematów. Źródło usunięte w innym oknie przed utworzeniem lekcji kończy się komunikatem „Nie ma takiego źródła…” i nie jest ponawiane. Gdy tekst źródła zmieniono w innym oknie po otwarciu formularza, lekcja nie powstaje z tekstu, którego rodzic nie widział: formularz pokazuje aktualny tekst i „Źródło zmieniono w innym oknie. Sprawdź tekst i utwórz lekcję ponownie.”, a lekcja powstaje po ponownym „Utwórz lekcję” (zmiana samego tytułu źródła tego nie wywołuje); ponowienie polecenia, które w międzyczasie zdążyło utworzyć lekcję, zwraca tę lekcję. Link do nieistniejącego źródła (także strona otwarta z pamięci po usunięciu źródła w innym oknie) pokazuje „Nie ma takiego źródła. Mogło zostać usunięte.” z powrotem do listy źródeł.

**Kopia, nie odsyłacz.** Zestaw kopiuje tekst źródła w chwili tworzenia i zapisuje odnośnik oraz numer rewizji, którą skopiował; potem generowanie, dogenerowanie, regeneracja zagadnienia, edycja i nowe wersje korzystają wyłącznie z kopii. Edycja źródła nie zmienia istniejących zestawów. Źródło ma dwie rewizje: rewizję edycji (rośnie przy każdej zmianie, także samego tytułu; służy kontroli dwóch przeglądarek) i rewizję treści (rośnie tylko przy zmianie tekstu). Zestaw zapamiętuje skopiowaną rewizję treści, więc notkę „Źródło zmieniono od utworzenia tego zestawu.” (w edytorze i na liście zestawów na stronie źródła) dostają tylko zestawy, których tekst źródła zmienił się po skopiowaniu — zmiana samego tytułu jej nie daje. To wskazówka, że można utworzyć nową lekcję, a nie sygnał zmiany treści zestawu. Zapis bez zmian (także od innego klienta niż panel) niczego nie podbija; panel dodatkowo wysyła tylko zmienione pola i wyłącza „Zapisz” bez zmian. Edytor zestawu ze źródła pokazuje „Ze źródła: <tytuł>” z odnośnikiem do strony źródła.

**Usuwanie.** Potwierdzenie podaje liczbę zestawów (wszystkich ze strony źródła, także zarchiwizowanych). Zestawy zostają razem ze swoją kopią tekstu i tracą tylko odnośnik — edytor nie pokazuje już „Ze źródła”, a generowanie, dogenerowanie i regeneracja dalej działają na kopii. Historia i postęp dziecka nie są dotknięte. Usunięcie źródła równolegle z tworzeniem z niego lekcji kończy się albo zestawem z kopią (usunięcie poczekało), albo komunikatem „Nie ma takiego źródła…” (tworzenie przegrało), nigdy błędem serwera.

**Dwie przeglądarki.** Edycja ma kontrolę rewizji: gdy źródło zmieniono w innym oknie, zapis kończy się komunikatem o konflikcie i nie nadpisuje cudzej zmiany; „Odśwież” (po potwierdzeniu, że wpisane zmiany przepadną) pobiera aktualną wersję. Rewizja wysyłana przy zapisie pochodzi z chwili wejścia w edycję, a nie z odświeżenia w tle.

**Granice.** Źródła istnieją tylko w panelu rodzica: Kid API, MCP, skill Hermesa i raport `learning-overview` bez zmian, a dziecko ich nie widzi. Tekst źródła jest materiałem rodzica i trafia do generatora (a w ścieżce szkolnej jego cytaty także do modelu oceniającego) tak samo jak tekst wklejony w formularzu. Brak wersji historycznych źródła (są tylko numery rewizji), uploadu i OCR. Słówka ze źródła (przycisk „Utwórz zestaw słówek” i odnośnik ze źródła w zestawie słówek) dodał Etap 4 (niżej); w Etapie 2 odnośnik do źródła nosiły tylko lekcje.

**Polecenie uzupełniania tekstu.** Prompt generatora każe w uzupełnianiu tekstu rozdziału użyć 2–3 krótkich zdań, a całe polecenie (polskie znaczenie tekstu i komenda) musi mieć najwyżej 120 znaków — limit pola `instructionPl` egzekwuje ogólna walidacja silnika. Wcześniej prompt dopuszczał 2–4 zdania, co przy długim tekście kończyło się obciętym znaczeniem albo odrzuconym ćwiczeniem. Zmieniono sam prompt; po zmianie nie powtarzano próby na prawdziwym modelu (`pnpm probe:chapter`), więc skutek na żywo jest niesprawdzony.

**Zweryfikowane i niezweryfikowane (Etap 2).** Sprawdzone testami: reguły źródeł i współbieżność (równoległe tworzenie z tym samym `clientRequestId`, dwie edycje tej samej rewizji, usunięcie równolegle z tworzeniem lekcji, ponowienie po równoległym usunięciu źródła, rewizja treści przy zmianie samego tytułu, zapis bez zmian) na PostgreSQL; API rodzica (statusy, 401 bez sesji, 403 dla mutacji z obcego Origin); układ zakładki, strony źródła i formularza na czterech rozmiarach okna (Playwright, API zaślepione) — przypadki brzegowe (niepewny zapis i jego ponowienie, 404 źródła usuniętego w innym oknie, fokus po błędach, ochrona wyjścia, błędy wczytywania, linki do nieistniejącego źródła) tylko na telefonie 390×844; rząd zakładek od 600 px (także 600×960 i 640×360); przebieg źródło → lekcja rozdziału → publikacja → edycja źródła → usunięcie na prawdziwej bazie i workerze z fałszywym LLM. Niezweryfikowane: pilotaż z rodzicem (czy sama zakładka jest zrozumiała), fizyczne urządzenia (tylko emulacja okna przeglądarki), prawdziwy model dla wydłużonego polecenia luk oraz generowanie ze źródła na prawdziwym modelu (próba z Etapu 1 objęła tekst wklejony; ścieżka ze źródła używa tego samego generatora, ale nie była próbowana osobno).

**Znane ograniczenia (Etap 2).** (1) Po usunięciu źródła zestaw zachowuje numer skopiowanej rewizji, ale bez odnośnika nie jest on nigdzie pokazywany. (2) Ponowienie tworzenia źródła z tym samym `clientRequestId` po jego usunięciu tworzy je od nowa. (3) Notka „Źródło zmieniono…” nie odróżnia istotnej zmiany od poprawki literówki.

**Etap 3: lektor po odpowiedzi (2026-10-31).** Po ocenionej odpowiedzi w treningu lekcji rozdziału dziecko słyszy pełne poprawne zdanie po angielsku (`en-GB`): nagranie odtwarza się samo raz, „Posłuchaj zdania” je powtarza, przycisk „Posłuchaj wolniej” (żółw; #199) odtwarza to samo nagranie wolniej, „Dalej” je przerywa, a „Nie pamiętam” zostaje na wyniku do „Dalej”. To ten sam mechanizm, który dla gramatyki wprowadził odczyt zdania (#194, §22); rozdział włącza go flagą przedmiotu `ttsForFeedbackSentence`, bez nowej migracji i zmiany kontraktu. Czytane są: wybór i luka (zdanie ze wstawioną odpowiedzią), uzupełnianie tekstu (cały uzupełniony tekst, tylko gdy liczba odpowiedzi jest równa liczbie luk i żadna nie jest pusta), układanka (klocki w kolejności poprawnej) i tłumaczenie; pary, grupy i karty nie mają nagrania. Nagranie to rozwiązane zdanie, czyli to, co omówienie już pokazuje (ekspozycja z akapitu „Samodzielność”); serwer pieczętuje je jako odsłuch po odpowiedzi, więc nie zmienia samodzielności próby. Nagrania nie ma w próbnej kartkówce, przy „Pomiń” ani nieocenionej odpowiedzi, a także gdy omówienie pokazuje inny wariant niż zdanie kanoniczne (np. „Prawie!” z najbliższym zatwierdzonym wariantem tłumaczenia) — bramka sprawdza `correctText`, więc gdy omówienie go pokazuje, dziecko nie słyszy innego zdania niż to, które widzi (bramka działa też w gramatyce). Prywatność: do TTS trafiają wyłącznie zdania z zatwierdzonego materiału lekcji (materiał rodzica), bez danych dziecka; nagrania są wspólnym materiałem rewizji. Opublikowane lekcje rozdziału dostają nagrania po „Utwórz nową wersję” → „Publikuj”. API → MCP → skill bez zmian: feedback dziecka nie jest częścią MCP, a raport Hermesa nie obejmuje lekcji. Znane ograniczenia: tekst dłuższy niż 200 znaków nie dostaje nagrania (`FEEDBACK_SENTENCE_MAX_LENGTH`), a `clozeText` może mieć do 300 znaków (`MAX_CLOZE_TEXT_LENGTH`), więc długi tekst z lukami po cichu zostaje bez odczytu; odpowiedź przyjęta jako wariant bez pokazanego `correctText` („Świetnie!”) dostaje nagranie zdania kanonicznego. Zweryfikowane: typecheck; testy jednostkowe 3205; integracja 65 plików / 692 testy (+2 pominięte), w tym nowy `lesson-chapter-sentence-audio.test.ts`; E2E `test:e2e:shards`: mocked 322 + real 33/33/21/34, w tym `lesson-sentence-audio.spec.ts` z geometrią doku przy uzupełnianiu tekstu z bankiem słów (360×800, 812×375, 740×420, 768×1024, 1280×800). Niezweryfikowane: wymowa `en-GB` i autoodtwarzanie na fizycznym urządzeniu (testy sprawdzają tekst nagrań i przepływ, nie brzmienie) oraz pilotaż z dzieckiem.

**Etap 4: słówka ze źródła (2026-10-31).** Ze źródła powstaje także zwykły zestaw słówek ze słowami wyłącznie z tekstu rozdziału. Strona źródła ma obok przycisków lekcji „Utwórz zestaw słówek” (zawsze dostępny, niezależnie od katalogu lekcji). Formularz „Nowy zestaw słówek ze źródła” pokazuje „Ze źródła: <tytuł>”, podgląd tekstu tylko do odczytu, „Zmień źródło” (lista źródeł) i „Wróć do źródła”, a jego pola to: „Nazwa zestawu” (domyślnie tytuł źródła; pusta albo z samych spacji — serwer nadaje tytuł źródła), rodzaj zestawu (zwykły albo obrazkowy), „Najwięcej słówek” (1–100, domyślnie 20) i „Zawężenie (opcjonalnie)” (do 500 znaków, np. „tylko pogoda”; opis „Słowa wybieramy wyłącznie z tekstu źródła.”). Para języków jest stała: polski → angielski. Tryb „z opisu” (np. „przedmioty codziennego użytku, dni tygodnia”) działa bez zmian: model dobiera słowa do tematu, a zestaw jest odrzucany w całości, gdy choć jedna pozycja jest niepoprawna.

**Tylko słowa z tekstu.** Model dostaje kopię tekstu źródła (ogrodzoną jako materiał, nigdy jako polecenia) i, poza tym ogrodzeniem, zawężenie rodzica jako notatkę, która może tylko zawęzić wybór. Ma wypisać słowa i krótkie stałe zwroty w formie z tekstu i bez końcowej interpunkcji, z polskim znaczeniem i przykładowym zdaniem. Gwarancją nie jest prompt, tylko serwer: każdą pozycję sprawdza osobno (kształt, reguły rodzaju zestawu, np. obrazek w zestawie obrazkowym, i duplikaty — zostaje pierwsza; duplikatem jest też pozycja o tym samym kluczu dopasowania, czyli z tymi samymi słowami po pominięciu wiodących „a”/„an”/„the”/„to” i bez interpunkcji, np. „the coat” po „coat”, a taka pozycja jest liczona jako pominięta) i przyjmuje ją tylko wtedy, gdy jej angielskie słowo występuje w tekście jako fraza na granicach słów po normalizacji: małe litery, interpunkcja i apostrofy jak w lekcji rozdziału, skróty z zamkniętej tabeli angielskich skrótów („it's” = „it is”; nie każdy skrót w niej jest — „Znane ograniczenia (Etap 4)” niżej), prosta odmiana („coats” ↔ „coat”, „wearing” ↔ „wear”) i pominięte wiodące „a”/„an”/„the”/„to” („the coats” pasuje do „a coat”). Słowa funkcyjne i zwroty stojące w tekście są dozwolone („today”, „yes”, „How are you?”); pozycja złożona wyłącznie z wiodącego „a”/„an”/„the”/„to” nie jest słówkiem, a ramy zdaniowe z lukami („I'm wearing (a) …”, „___”) nie są pozycjami zestawu. Sprawdzane jest tylko angielskie słowo — warianty odpowiedzi i przykładowe zdanie nie są porównywane z tekstem. Przyjęte słowo i jego warianty odpowiedzi zapisują się w ujednoliconej postaci: typograficzny apostrof zamieniony na zwykły („'”), białe znaki zwinięte do jednej spacji, a końcowa interpunkcja zdania (. ! ? … , ; :) usunięta („It’s sunny.” zapisuje się jako „It's sunny”). Pozycje spoza tekstu, niepoprawne lub powtórzone są pomijane, reszta zostaje. Serwer kończy sprawdzanie po przyjęciu tylu pozycji, ile wynosi „Najwięcej słówek”, więc dalsze ani nie trafiają do zestawu, ani nie są liczone jako pominięte. Edytor zestawu pokazuje „Pominięto pozycji spoza tekstu lub niepoprawnych: {n}”, gdy coś pominięto. Gdy nie przeszła żadna pozycja, generowanie kończy się komunikatem „Nie znaleziono w tekście źródła słówek do zestawu. Ponów generowanie albo utwórz nowy zestaw ze źródła z innym zawężeniem lub w rodzaju standardowym.”: szkic zostaje bez zmian, „Ponów generowanie” jest dostępne, a gdy zestaw ma źródło, obok jest odnośnik „Przejdź do źródła”. Zawężenie, które prosi o słowa spoza tekstu („dodaj kolory”), ich nie dodaje, bo takie pozycje odpadają.

**Kopia i odnośnik (Etap 4).** Jak przy lekcji ze źródła: zestaw kopiuje tekst źródła w chwili tworzenia i zapamiętuje odnośnik z rewizją treści. Edytor zestawu słówek pokazuje „Ze źródła: <tytuł>” z odnośnikiem do strony źródła i po zmianie tekstu źródła „Źródło zmieniono od utworzenia tego zestawu.”, a strona źródła wymienia zestaw słówek obok lekcji. Edycja ani usunięcie źródła nie zmieniają słówek zestawu; po usunięciu znika tylko odnośnik. Gdy tekst źródła zmieniono w innym oknie po otwarciu formularza, zestaw nie powstaje: formularz pokazuje aktualny tekst i „Źródło zmieniono w innym oknie. Sprawdź tekst i utwórz zestaw ponownie.”, a tworzenie czeka na udane odświeżenie podglądu. Przy niepewnym wyniku zapisu pola zostają zablokowane, a „Ponów tworzenie” wysyła to samo polecenie i zwraca utworzony zestaw, także gdy źródło w międzyczasie zmieniono lub usunięto. Źródło usunięte przed utworzeniem zestawu daje „Nie ma takiego źródła…”. Lista w zakładce „Zestawy” nie pokazuje pochodzenia (wymienia je strona źródła). Po utworzeniu przegląd, edycja, nagrania, ilustracje, publikacja, przypisania i nauka dziecka działają jak w każdym zestawie słówek.

**Granice i wdrożenie (Etap 4).** Do modelu trafia wyłącznie kopia tekstu źródła i zawężenie (materiał rodzica), bez danych dziecka. API → MCP → skill bez zmian: raport `learning-overview` obejmuje zestawy słówek (`kind = 'vocabulary'`), więc zestaw ze źródła trafia do raportu Hermesa jak każdy zestaw słówek, a znaczenie jego danych się nie zmienia; raport nie korzysta z polecenia generowania, `GenerationDto` ani DTO zestawu rodzica, a odnośnik do źródła nie jest jego częścią. Kid UI bez zmian. Migracja `0031` (liczba pominiętych pozycji w runie generowania) idzie przed nowym webem i workerem.

**Znane ograniczenia (Etap 4).** (1) Prosta odmiana porównuje rdzenie, więc rzadko przepuszcza słowo spoza tekstu o wspólnym rdzeniu („seed” przy „see”, „hated” przy „hat”). (2) Fraza może przekraczać interpunkcję: „red apples” pasuje do „I like red. Apples are sweet.”. (3) Zawężenia pilnuje tylko model — serwer sprawdza, czy pozycja jest w tekście, a nie czy pasuje do zawężenia. (4) Warianty odpowiedzi i przykładowe zdanie mogą zawierać słowa spoza tekstu. (5) Rozwijane są tylko skróty z zamkniętej tabeli (`packages/server/src/domain/lessons/subjects/english/contractions.ts`: m.in. „it's”, „that's”, „I'm”, „don't”); „what's”, „there's” i „let's” w niej nie ma, więc „what” nie zostanie znalezione w „What's the weather like?” i taka pozycja zostanie pominięta, choć słowo stoi w tekście — rodzic dopisuje ją ręcznie. (6) Skoro słowa funkcyjne są dozwolone, przejdą też sztuczne kombinacje obecne w tekście, np. „in on” z „Put it in on the shelf.”. W przypadkach (1)–(6) rodzic sprawdza szkic przed publikacją. (7) Dziecko, które wpisze typograficzny apostrof („It’s”), gdy zapisany cel ma zwykły („It's”), dostanie błąd: ocena słówek nie ujednolica apostrofów (`normalizeTargetText`). Tak samo ścisła jest końcowa interpunkcja: cel zapisany bez kropki nie przyjmie odpowiedzi wpisanej z kropką. To wcześniejsze ograniczenie oceny słówek, nie zmiana Etapu 4. (8) Zestaw słówek i lekcja rozdziału z tego samego źródła częściej mają ten sam tekst (zwrot „It's raining” jako słówko i odpowiedź tłumaczenia); wspólna ekspozycja może wtedy trwale odebrać samodzielność takiemu tłumaczeniu (asymetria z akapitu „Samodzielność”). Etap 4 tego nie zmienia, a skutek w nauce nie był mierzony.

**Zweryfikowane i niezweryfikowane (Etap 4).** Zweryfikowane: typecheck, testy jednostkowe (3399), integracja na PostgreSQL (725, w tym `source-vocabulary.test.ts`), E2E — przebieg źródło → zestaw słówek → edytor na prawdziwej bazie i workerze z fałszywym LLM oraz układ formularza na czterech rozmiarach okna (API zaślepione). Niezweryfikowane: prawdziwy model na prawdziwym rozdziale (dobór słów, liczba pominiętych pozycji, posłuszeństwo zawężeniu) — testy używają fałszywego modelu, który wypisuje słowa z tekstu; pilotaż z rodzicem i dzieckiem; fizyczne urządzenia (układ formularza sprawdzono w emulacji okna przeglądarki); kolejność wdrożenia (migracja `0031` w kroku `migrate` Compose, potem web i worker — architektura §14 i §19.10) nie była ćwiczona na wdrożeniu, a stary worker nie rozpozna runu ze źródła.
