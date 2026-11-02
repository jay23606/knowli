import type { LearningObjective, LessonTopic } from "../../../types";

/**
 * Temat Present Simple (design „Przedmiot i katalog”, requirements 1.4).
 * Siedem celów w kolejności nauki; identyfikatory z prefiksem przedmiotu i tematu.
 * Treść kart i podpowiedzi po polsku, poprawna językowo i dostosowana do ~8-latka
 * (krótko, bez żargonu). `descriptionEn` służy promptom generacji i oceny.
 * `{{examples}}` w karcie to miejsce na przykłady z materiału lekcji.
 *
 * Pokrycie etapów ocenianych w każdym celu: prowadzony (choice/short_answer/order),
 * produktywny (gap/error_fix/transform), samodzielny (open_answer). `lesson_notice`
 * dodajemy tam, gdzie dziecko może wskazać zmieniające się słowo.
 *
 * `lesson_listen_choice` (wybór ze słuchu, #198) mają cele, w których różnica
 * formy jest słyszalna: forma podstawowa (play/plays), -s w 3. osobie,
 * przeczenie (don't/doesn't) i pytanie (Do/Does). Nie mają go: pisownia
 * -es/-ies (różnica tylko w zapisie), krótkie odpowiedzi (cel ćwiczy odpowiedź
 * w całości) i forma podstawowa po does/doesn't (reguła zapisu: brak -s po does
 * jest słabo słyszalny w szybkiej mowie).
 */

const PREFIX = "english_grammar.present_simple";

const affirmativeBase: LearningObjective = {
  id: `${PREFIX}.affirmative_base`,
  titlePl: "Zdanie twierdzące: I, you, we, they",
  descriptionEn:
    "In the present simple, the subjects I, you, we and they use the base form of the verb with no ending (I play, they live).",
  cards: [
    {
      title: "Forma podstawowa",
      body: "Przy I, you, we, they czasownik zostaje bez zmian: I play, you work, we live.",
    },
    {
      title: "Przykłady z lekcji",
      body: "Zobacz, jak to działa na naszych słówkach: {{examples}}",
    },
  ],
  errorCategories: ["wrong_verb_form", "extra_ending", "wrong_tense"],
  hints: {
    wrong_verb_form: "Przy I, you, we, they czasownik zostaje w formie podstawowej: I play.",
    extra_ending: "Nie dodawaj -s przy I, you, we, they. Piszemy: we play, nie „we plays”.",
    wrong_tense: "To Present Simple — mówimy o tym, co dzieje się zwykle, codziennie.",
  },
  exerciseTypes: [
    "lesson_card",
    "lesson_notice",
    "lesson_choice",
    "lesson_listen_choice",
    "lesson_gap",
    "lesson_open_answer",
  ],
};

const thirdPersonS: LearningObjective = {
  id: `${PREFIX}.third_person_s`,
  titlePl: "-s w 3. osobie (he, she, it)",
  descriptionEn:
    "In the present simple, the third person singular (he, she, it) adds -s to the base verb (he plays, she works).",
  cards: [
    {
      title: "Dodaj -s",
      body: "Przy he, she, it dodajemy -s do czasownika: he plays, she works, it runs.",
    },
    {
      title: "Przykłady z lekcji",
      body: "Popatrz na przykłady z naszych słówek: {{examples}}",
    },
  ],
  errorCategories: ["missing_ending", "extra_ending", "wrong_subject_agreement"],
  hints: {
    missing_ending: "Przy he, she, it dodajemy -s: he plays.",
    extra_ending: "Przy he, she, it wystarczy jedno -s: he plays, nie „he playss”.",
    wrong_subject_agreement: "He, she, it to 3. osoba — tu zawsze dochodzi -s.",
  },
  exerciseTypes: [
    "lesson_card",
    "lesson_notice",
    "lesson_choice",
    "lesson_listen_choice",
    "lesson_gap",
    "lesson_open_answer",
  ],
};

const spellingEsIes: LearningObjective = {
  id: `${PREFIX}.spelling_es_ies`,
  titlePl: "Pisownia -es oraz -ies",
  descriptionEn:
    "Third person singular adds -es after -s, -sh, -ch, -x, -o (goes, watches), and changes consonant + y to -ies (studies).",
  cards: [
    {
      title: "Kiedy -es",
      body: "Po -s, -sh, -ch, -x, -o dodajemy -es: goes, watches, washes, fixes.",
    },
    {
      title: "Kiedy -ies",
      body: "Gdy przed -y jest spółgłoska, zmieniamy y na -ies: study → studies, fly → flies.",
    },
    {
      title: "Przykłady z lekcji",
      body: "Zobacz naszą pisownię na przykładach: {{examples}}",
    },
  ],
  errorCategories: ["ending_spelling", "missing_ending", "wrong_verb_form"],
  hints: {
    ending_spelling: "Po -s, -sh, -ch, -x, -o piszemy -es; spółgłoska + y → -ies: studies.",
    missing_ending: "Przy he, she, it dodaj końcówkę: goes, watches, studies.",
    wrong_verb_form: "Zbuduj formę od podstawowej: study → studies, go → goes.",
  },
  exerciseTypes: [
    "lesson_card",
    "lesson_choice",
    "lesson_gap",
    "lesson_error_fix",
    "lesson_open_answer",
  ],
};

const negative: LearningObjective = {
  id: `${PREFIX}.negative`,
  titlePl: "Przeczenie: don't / doesn't",
  descriptionEn:
    "The present simple negative uses don't for I/you/we/they and doesn't for he/she/it, followed by the base verb (she doesn't play).",
  cards: [
    {
      title: "don't i doesn't",
      body: "Przeczenie tworzymy z don't (I, you, we, they) lub doesn't (he, she, it): I don't play, he doesn't play.",
    },
    {
      title: "Po przeczeniu forma podstawowa",
      body: "Po don't i doesn't czasownik jest bez -s: she doesn't play, nie „doesn't plays”.",
    },
    {
      title: "Przykłady z lekcji",
      body: "Popatrz na przeczenia z naszych słówek: {{examples}}",
    },
  ],
  errorCategories: ["wrong_negation", "wrong_auxiliary", "extra_ending", "missing_auxiliary"],
  hints: {
    wrong_negation: "Przeczenie to don't / doesn't + czasownik: he doesn't play.",
    wrong_auxiliary: "He, she, it → doesn't; I, you, we, they → don't.",
    extra_ending: "Po don't / doesn't czasownik jest bez -s: she doesn't play.",
    missing_auxiliary: "Potrzebny jest operator: dodaj don't lub doesn't.",
  },
  exerciseTypes: [
    "lesson_card",
    "lesson_choice",
    "lesson_listen_choice",
    "lesson_gap",
    "lesson_transform",
    "lesson_open_answer",
  ],
};

const question: LearningObjective = {
  id: `${PREFIX}.question`,
  titlePl: "Pytanie: Do / Does",
  descriptionEn:
    "Present simple questions start with Do (I/you/we/they) or Does (he/she/it) + subject + base verb (Does she play?).",
  cards: [
    {
      title: "Do i Does na początku",
      body: "Pytanie zaczynamy od Do lub Does: Do you play? Does she play?",
    },
    {
      title: "Po Does forma podstawowa",
      body: "Po Does czasownik jest bez -s: Does he play? — nie „Does he plays?”.",
    },
    {
      title: "Przykłady z lekcji",
      body: "Zobacz pytania z naszych słówek: {{examples}}",
    },
  ],
  errorCategories: ["wrong_auxiliary", "missing_auxiliary", "word_order", "extra_ending"],
  hints: {
    wrong_auxiliary: "He, she, it → Does; I, you, we, they → Do.",
    missing_auxiliary: "Pytanie zaczynamy od Do lub Does.",
    word_order: "Kolejność: Do/Does + osoba + czasownik: Does she play?",
    extra_ending: "Po Does czasownik jest bez -s: Does he play?",
  },
  exerciseTypes: [
    "lesson_card",
    "lesson_choice",
    "lesson_listen_choice",
    "lesson_order",
    "lesson_gap",
    "lesson_transform",
    "lesson_open_answer",
  ],
};

const shortAnswers: LearningObjective = {
  id: `${PREFIX}.short_answers`,
  titlePl: "Krótkie odpowiedzi",
  descriptionEn:
    "Short answers repeat the auxiliary: Yes, I do / No, I don't; Yes, he does / No, he doesn't.",
  cards: [
    {
      title: "Yes, I do / No, I don't",
      body: "W krótkiej odpowiedzi powtarzamy operator: Yes, I do. No, I don't.",
    },
    {
      title: "Yes, he does / No, he doesn't",
      body: "Przy he, she, it używamy does: Yes, he does. No, she doesn't.",
    },
    {
      title: "Przykłady z lekcji",
      body: "Popatrz na krótkie odpowiedzi: {{examples}}",
    },
  ],
  errorCategories: ["short_answer_form", "wrong_auxiliary", "wrong_subject_agreement"],
  hints: {
    short_answer_form: "Krótka odpowiedź to: Yes, I do / No, he doesn't — bez czasownika głównego.",
    wrong_auxiliary: "Powtórz właściwy operator: do dla I/you/we/they, does dla he/she/it.",
    wrong_subject_agreement: "Dobierz operator do osoby: he → does, I → do.",
  },
  exerciseTypes: [
    "lesson_card",
    "lesson_short_answer",
    "lesson_choice",
    "lesson_gap",
    "lesson_open_answer",
  ],
};

const baseFormAfterDoes: LearningObjective = {
  id: `${PREFIX}.base_form_after_does`,
  titlePl: "Forma podstawowa po does / doesn't",
  descriptionEn:
    "After does and doesn't the main verb stays in the base form with no -s (she doesn't play, does he play?).",
  cards: [
    {
      title: "Bez -s po does",
      body: "Po does i doesn't czasownik nie ma -s: she doesn't play, does he play?",
    },
    {
      title: "Jedno -s wystarczy",
      body: "Końcówka -s jest już w does, więc czasownik zostaje podstawowy: Does she go? nie „Does she goes?”.",
    },
    {
      title: "Przykłady z lekcji",
      body: "Zobacz na przykładach z lekcji: {{examples}}",
    },
  ],
  errorCategories: ["extra_ending", "wrong_verb_form", "wrong_subject_agreement"],
  hints: {
    extra_ending: "Po does / doesn't czasownik jest bez -s: she doesn't play.",
    wrong_verb_form: "Użyj formy podstawowej po does: does he play?",
    wrong_subject_agreement: "To does już niesie 3. osobę — czasownik zostaje podstawowy.",
  },
  exerciseTypes: [
    "lesson_card",
    "lesson_choice",
    "lesson_gap",
    "lesson_error_fix",
    "lesson_transform",
    "lesson_open_answer",
  ],
};

export const presentSimpleV1: LessonTopic = {
  id: "present_simple",
  version: 1,
  titlePl: "Present Simple",
  extraErrorCategories: [],
  transforms: [
    { id: "to_negative", instructionPl: "Zamień na przeczenie" },
    { id: "to_question", instructionPl: "Zamień na pytanie" },
    { id: "to_affirmative", instructionPl: "Zamień na zdanie twierdzące" },
  ],
  objectives: [
    affirmativeBase,
    thirdPersonS,
    spellingEsIes,
    negative,
    question,
    shortAnswers,
    baseFormAfterDoes,
  ],
};
