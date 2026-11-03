# Ślepa ocena ćwiczeń wygenerowanych (porównanie generatorów, 2026-11-03)

Każdy wiersz `sheet.csv` to jedno ćwiczenie wygenerowane dla lekcji (bez informacji, który model je napisał).
Kolumna `objective` to kontekst zagadnienia (tytuł, rodzaj, karta, przykłady kart), `exercise` to ćwiczenie (JSON w kształcie generatora).

Kryteria: dokładnie te z `rubric-criteria.md` (ten katalog), sekcja „Kryteria” (K1–K8 i reguły przedmiotu R-chapter, R-grammar, R-school).
Materiał lekcji: plik `material.txt` w katalogu oceny poza repozytorium (dla gramatyki materiałem jest tekst rodzica, a temat i karty są w kolumnie `objective`).

Wypełnij dla każdego wiersza:

- `verdict`: `ok` albo `defect`;
- `criterion`: przy `defect` naruszone kryterium (np. `K1`, `K3|K6`, `R-chapter`); przy `ok` puste;
- `adjudicatorNote`: przy `defect` jedno zdanie po polsku z konkretem (druga poprawna odpowiedź, konkretny błąd językowy, słowo spoza materiału, miejsce ujawnienia); przy `ok` puste.

Zasady: naruszenie musi być wykazywalne; „mogłoby być lepiej” = `ok`; trudność sama w sobie nie jest wadą.
Oceniaj każdy wiersz niezależnie i nie zgaduj, z którego źródła pochodzi.
