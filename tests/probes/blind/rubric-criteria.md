# Rubryka ślepej oceny zmian krytyka lekcji (PR 3a) — zamrożona

Zamrożona 2026-11-03, przed pierwszym płatnym uruchomieniem krytyka. Po pierwszym płatnym
uruchomieniu tego pliku nie zmieniamy (skrót SHA-256 w `README.md`); poprawka = nowa wersja
pliku z datą i uzasadnieniem w `README.md`, a oceny według starej wersji pozostają ważne.

## Co dostaje oceniający

Świeży subagent, bez udziału w przygotowaniu danych i w strojeniu, dostaje wyłącznie:

- `blind-sheet.csv` (wiersze wymieszane, bez etykiet);
- ten plik;
- z pliku zrzutu danej próby wyłącznie pola `material`, `topicTitle` i `objectives`
  (tytuł, rodzaj, karta, przykłady kart) — kontekst do oceny ujawnień i zgodności z materiałem.

Oceniający NIE dostaje: `blind-key.json`, `labels.json`, `results.json`, `costs.json`,
`defects.md`, plików `seeded/*-labels.json`, opisu mutacji, wyników poprzednich ocen ani
informacji, które wiersze są kontrolami. Nie zgaduje etykiet — ocenia treść.

## Kolumny arkusza

| Kolumna | Znaczenie |
| --- | --- |
| `rowId` | identyfikator wiersza (prefiks = arkusz) |
| `subject` | przedmiot (`english_chapter`, `english_grammar`, `school`) |
| `criticAction` | `fixed` (poprawka), `dropped` (usunięcie), `note` (uwaga bez zmiany), `none` (bez zmiany i bez uwagi) |
| `before` | ćwiczenie przed przeglądem (JSON w kształcie generatora; `objectiveId` = człon zagadnienia) |
| `after` | poprawka (JSON), `DROPPED` albo `UNCHANGED` |
| `criticCategory`, `criticReasonPl` | kategoria i powód krytyka (puste przy `none`) |

Do wypełnienia: `verdictBefore`, `verdictChange`, `verdictAfter`, `adjudicatorNote`.

## Kryteria (spec etapu przeglądu §4.4)

Wspólne:

- **K1** zadanie zamknięte ma dokładnie jedno poprawne rozwiązanie (pary, grupy, wybór,
  uzupełnianie tekstu z bankiem, układanka);
- **K2** polecenie (z polskim bodźcem, gdy przedmiot go wymaga) jednoznacznie wyznacza odpowiedź;
- **K3** odpowiedź kanoniczna poprawna; warianty obejmują równoważne formy, nigdy błędnych
  (brak wymaganego równoważnego wariantu = naruszenie K3);
- **K4** `explanationPl` prawdziwe i dotyczy reguły ćwiczenia;
- **K5** rozwiązanie nie jest widoczne wcześniej: ćwiczenie samodzielne nie ujawnia odpowiedzi
  przykładem karty ani ćwiczeniem niesamodzielnym (ustalenia `DETERMINISTIC FINDINGS`);
- **K6** język naturalny i poprawny (trudność sama w sobie NIE jest naruszeniem — tylko uwaga `too_hard`);
- **K7** ćwiczenie pasuje do etapu i zagadnienia; poprawka nie zmienia sprawdzanego zagadnienia;
- **K8** treść odpowiednia dla dziecka ok. 8–12 lat (kategoria krytyka `unsuitable_content`;
  w §4.4 brak osobnego punktu — poprawka wiersza przewidziana w Task 5 planu).

Przedmiotu:

- **R-chapter** (`english_chapter`): tylko słowa i ramy z materiału oraz słowa funkcyjne; luka
  i opcje na słowie treści; polskie zdanie-bodziec jednoznaczne; luki uzupełniania
  niezamienialne, słowo-pułapka nie pasuje do żadnej;
- **R-grammar** (`english_grammar`): ćwiczenie sprawdza regułę tematu; dystraktory łamią regułę,
  nie są innymi poprawnymi formami;
- **R-school** (`school`): odpowiedź i elementy wymagane wynikają z materiału; poprawka nie
  dodaje faktów spoza materiału; cytaty są dosłownymi fragmentami materiału.

## Jak oceniać wiersz

1. **`verdictBefore`** (każdy wiersz): `ok` albo `defect:<kryterium>` (np. `defect:K3`,
   `defect:R-chapter`; kilka — rozdzielone `|`). Naruszenie musi być **wykazywalne**: da się
   wskazać konkretną drugą poprawną odpowiedź, konkretny błąd językowy, konkretne słowo spoza
   materiału, konkretne miejsce ujawnienia. „Mogłoby być lepiej” = `ok`.
2. **`verdictChange`**:
   - `fixed` / `dropped`: `justified` tylko wtedy, gdy zmiana usuwa wykazywalne naruszenie
     kryterium z listy wyżej (czyli `verdictBefore` = `defect:…`). Preferencja stylistyczna,
     przeformułowanie poprawnego ćwiczenia, uproszczenie z powodu trudności albo zmiana
     „na wszelki wypadek” = `unjustified`. Usunięcie jest `justified` także wtedy, gdy poprawka
     nie była możliwa bez zmiany zagadnienia;
   - `note`: `justified`, gdy uwaga wskazuje rzeczywiste naruszenie albo rzeczywistą trudność
     (`too_hard`) zgodną z opisem; inaczej `unjustified`;
   - `none`: `n/a`.
3. **`verdictAfter`** (tylko `fixed`): `ok`, gdy poprawka nie narusza żadnego kryterium i
   sprawdza to samo zagadnienie; `defect:<kryterium>`, gdy pozostawiła albo wprowadziła
   naruszenie. Dla pozostałych akcji `n/a`.
4. **`adjudicatorNote`**: jedno zdanie po polsku — konkret naruszenia albo powód `unjustified`.

Zasady: oceniaj każdy wiersz niezależnie; nie porównuj wierszy między sobą; nie zakładaj, że
krytyk ma rację ani że jej nie ma; przy wątpliwości, czy naruszenie jest wykazywalne, wybierz
`ok` / `unjustified` i opisz wątpliwość w notatce. Nie poprawiaj ćwiczeń sam.

## Jak oceny wchodzą do progów

Sposób liczenia Q1–Q4 z ocen opisuje `thresholds.md` („Sposób liczenia”). Etykiety
(`labels.json`, `seeded/*-labels.json`) i oceny łączy dopiero skrypt liczący, przez `blind-key.json`,
po zakończeniu ślepej oceny całego arkusza.
