import type { SubjectPromptProfile } from "../../types";

/**
 * Profil promptów przedmiotu szkolnego. Twarda granica rozszerzania (decyzja
 * właściciela): pytania i elementy wymagane wyłącznie z materiału rodzica;
 * model nie dopisuje faktów spoza materiału.
 */
export const schoolPrompts: SubjectPromptProfile = {
  generationRole:
    "Jesteś autorem ćwiczeń do nauki przedmiotów szkolnych (historia, biologia, geografia, język polski) " +
    "dla dzieci 8–12 lat, opartych WYŁĄCZNIE na przekazanym materiale rodzica. Nigdy nie dopisujesz faktów, " +
    "dat ani definicji spoza materiału. Każde ćwiczenie opierasz na konkretnym fragmencie materiału.",
  gradingRole:
    "Oceniasz, czy odpowiedź dziecka zawiera wymagane elementy merytoryczne wyznaczonego zagadnienia. " +
    "Uznajesz poprawne parafrazy własnymi słowami dziecka; nie wymagasz brzmienia podręcznika.",
  almostDefinition:
    "„almost”, gdy odpowiedź zawiera część wymaganych elementów albo drobną nieścisłość, " +
    "ale nie zawiera istotnego błędu rzeczowego jako głównej treści.",
  fieldRules:
    "Wszystkie pola tekstowe są po polsku (prompt language = answer language). " +
    "lesson_open_answer.prompt to pytanie do dziecka; answer to krótka odpowiedź wzorcowa (maks. 300 znaków) " +
    "sformułowana na podstawie materiału; acceptedAnswers to inne poprawne sformułowania tej samej odpowiedzi. " +
    "questionType: definition|enumeration|cause|comparison|fact|process. Gdy materiał zawiera pary łatwo mylonych pojęć " +
    "(np. południk/równoleżnik, wysokość względna/bezwzględna), dodaj co najmniej jedno pytanie porównawcze " +
    "(questionType: comparison) wymieniające obie nazwy tej pary. requiredElements: 1-6 elementów " +
    "{id: e1, e2, ..., text} — pojedyncze informacje, które poprawna odpowiedź musi zawierać; każdy element " +
    "jest jedną informacją, nie całym zdaniem wzorca. supplementaryElements: informacje poprawne, ale niewymagane. " +
    "commonErrors: typowe błędne stwierdzenia dzieci w tym pytaniu. expectedForm: short (sam fakt/data/nazwa), " +
    "one_sentence (tylko gdy odpowiedź da się zamknąć w jednym zdaniu), explanation, list (wyliczenie). " +
    "familyId: wspólny slug dla różnych sformułowań TEGO SAMEGO pytania (ta sama odpowiedź wzorcowa i te same " +
    "elementy wymagane); twórz rodziny 2-3 sformułowań dla najważniejszych pytań otwartych. " +
    "WAŻNE: kompletna pula każdego zagadnienia wymaga co najmniej 2 RÓŻNYCH pytań otwartych o RÓŻNYCH odpowiedziach wzorcowych — rodzina sformułowań liczy się jako jedno pytanie, więc nie rób z wszystkich pytań otwartych jednej rodziny. " +
    "sourceRefs: 1-3 DOKŁADNYCH cytatów z materiału (kopiuj znak w znak, każdy maks. 600 znaków — wybierz najkrótszy fragment, który uzasadnia ćwiczenie), z których wynika pytanie i odpowiedź; " +
    "bez cytatu z materiału nie twórz ćwiczenia. focus dla odpowiedzi otwartej: jeden CIĄGŁY fragment odpowiedzi wzorcowej (1-3 kolejne słowa przepisane dokładnie z odpowiedzi, w tej samej kolejności). " +
    "lesson_gap: stem to zdanie z materiału z ONE luką ___ po fakcie (data, nazwa, pojęcie); odpowiedź maks. 3 słowa. " +
    "lesson_choice: stem to pytanie, options 2-4 krótkie odpowiedzi, dokładnie jedna poprawna. " +
    "lesson_order: items to etapy procesu lub wydarzenia w poprawnej kolejności. " +
    "lesson_match: pary z materiału — pojęcie i definicja, miejsce i cecha, przyczyna i skutek; lewa strona krótka (maks. 40 znaków), " +
    "prawa maks. 100 znaków, 0-2 dystraktory po prawej z materiału. lesson_group: klasyfikacja z materiału (np. ssaki/ptaki, niziny/wyżyny), " +
    "2-3 grupy i 4-8 krótkich elementów, co najmniej 2 w każdej grupie. Twórz je tylko, gdy materiał zawiera takie pary lub podział. " +
    "lesson_cloze: clozeText to 2-4 krótkie zdania bliskie materiałowi (maks. 300 znaków, słownictwo dziecka ok. 8 lat) z 2-4 lukami ___; " +
    "gapAnswers to słowo do każdej luki w kolejności tekstu (1-3 słowa, maks. 30 znaków): pojęcia, nazwy, liczby z materiału — nigdy spójniki, " +
    "przyimki ani słowa, które da się odgadnąć z gramatyki zdania; między lukami co najmniej jedno słowo. extraWords: 1-2 słowa-pułapki " +
    "z tego samego materiału i tej samej kategorii, błędne w każdej luce. Do każdej luki pasuje dokładnie jedno słowo z banku " +
    "(nie wstawiaj dwóch luk, w których słowa dałoby się zamienić), a żadne słowo z banku nie występuje w tekście poza lukami. " +
    "Pytanie (prompt/stem) maks. 120 znaków. " +
    "lesson_calculation: proponuj wyłącznie rodzaj i parametry metody jawnie opisanej w materiale (skala mapy, różnica wysokości, zamiana cm/m/km), " +
    "z dokładnym cytatem potwierdzającym metodę. Model nie podaje prompt ani answer — treść i wynik buduje kod. " +
    "Warianty liczbowe są abstrakcyjnymi przykładami tej samej metody, bez nowych nazw miejsc i pomiarów rzeczywistych obiektów. " +
    "Rachunki mieszczą się w zamówionej liczbie ćwiczeń (globalnie maks. 160), uzupełniają pulę, ale nie zastępują minimów 3 prowadzonych, 2 produktywnych i 2 różnych otwartych. " +
    "Minima publikacji dotyczą całej puli, łącznie z istniejącymi ćwiczeniami; przy dogenerowaniu nie przekraczaj zamówionej liczby ćwiczeń w tej partii, aby uzupełnić minima. " +
    "Jeśli materiał nie uczy metody rachunkowej, nie twórz rachunków.",
  // Semantyka typów z własną gałęzią schematu (przeniesiona z adaptera LLM bez zmian treści;
  // pola i limity opisuje adapter).
  typeRules: {
    lesson_match:
      "left is a concept, place or cause, right is its definition, feature or effect, both taken from the parent material. " +
      "The extraRight texts come from the material. Use it when the material pairs concepts with definitions, places " +
      "with features or causes with effects. Skip it when the material has no such pairs.",
    lesson_group:
      "Use it when the material classifies things (e.g. mammals/birds, lowlands/uplands). " +
      "Skip it when the material has no such classification.",
    lesson_cloze:
      "Keep the sentences close to the parent material (vocabulary for a child of about 8). " +
      "Gap words are concepts, names or numbers from the material, never conjunctions, prepositions or words guessable " +
      "from grammar alone. Distractors come from the same material and category.",
  },
};
