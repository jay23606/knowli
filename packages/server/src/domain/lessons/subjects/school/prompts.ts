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
  // Wyłącznie wskazówki, których kod nie sprawdza; reguły egzekwowane (limity, cytaty, rodziny, pola
  // pytania otwartego) opisuje katalog reguł w księdze reguł promptu (spec katalogu reguł §3).
  fieldRules:
    "Wszystkie pola tekstowe są po polsku (prompt language = answer language). " +
    "lesson_open_answer.prompt to pytanie do dziecka; answer to krótka odpowiedź wzorcowa " +
    "sformułowana na podstawie materiału; acceptedAnswers to inne poprawne sformułowania tej samej odpowiedzi. " +
    "Gdy materiał zawiera pary łatwo mylonych pojęć " +
    "(np. południk/równoleżnik, wysokość względna/bezwzględna), dodaj co najmniej jedno pytanie porównawcze " +
    "(questionType: comparison) wymieniające obie nazwy tej pary. requiredElements to pojedyncze informacje, " +
    "które poprawna odpowiedź musi zawierać; każdy element " +
    "jest jedną informacją, nie całym zdaniem wzorca. supplementaryElements: informacje poprawne, ale niewymagane. " +
    "commonErrors: typowe błędne stwierdzenia dzieci w tym pytaniu. expectedForm: short (sam fakt/data/nazwa), " +
    "one_sentence (tylko gdy odpowiedź da się zamknąć w jednym zdaniu), explanation, list (wyliczenie). " +
    "familyId: wspólny slug dla różnych sformułowań TEGO SAMEGO pytania; " +
    "twórz rodziny 2-3 sformułowań dla najważniejszych pytań otwartych. " +
    "sourceRefs: wybierz najkrótszy fragment materiału, który uzasadnia ćwiczenie i z którego wynika pytanie i odpowiedź. " +
    "focus dla odpowiedzi otwartej: 1-3 kolejne słowa odpowiedzi wzorcowej. " +
    "lesson_gap: stem to zdanie z materiału z luką po fakcie (data, nazwa, pojęcie). " +
    "lesson_choice: stem to pytanie, options to krótkie odpowiedzi. " +
    "lesson_order: items to etapy procesu lub wydarzenia w poprawnej kolejności.",
  // Semantyka typów w ich blokach (pola i limity opisują karta typu i reguły w księdze reguł).
  typeRules: {
    lesson_calculation:
      "Use only a method explicitly taught in the material: sourceRefs quote the method, not a vaguely related fact; " +
      "when the material teaches no supported method, produce no calculations. Numbers may vary as abstract examples " +
      "of that method; never invent named places, measurements of real objects or new facts. Calculations never " +
      "replace the publication minima in Target. Variants of one method and units share templateFamilyId with " +
      "different parameters; never repeat existing parameters.",
    lesson_keywords:
      "An optional precision trainer outside the stage split: at most one per objective, for a lesson_open_answer " +
      "family of this objective. keyOptionIds are the concepts a precise answer to that question must use; the other " +
      "options are real concepts of the material that this answer does not need. Never put the answer sentence or a " +
      "definition into keywordOptions; skip it when the open answer has fewer than two essential concepts.",
    lesson_match:
      "left is a concept, place or cause, right is its definition, feature or effect, both taken from the parent material. " +
      "The extraRight texts come from the material. Use it when the material pairs concepts with definitions, places " +
      "with features or causes with effects. Skip it when the material has no such pairs.",
    lesson_group:
      "Use it when the material classifies things (e.g. mammals/birds, lowlands/uplands). " +
      "Skip it when the material has no such classification.",
    lesson_cloze:
      "Write 2 to 4 short sentences close to the parent material (vocabulary for a child of about 8). " +
      "Gap words are concepts, names or numbers from the material, never conjunctions, prepositions or words guessable " +
      "from grammar alone. Distractors come from the same material and category.",
  },
};
