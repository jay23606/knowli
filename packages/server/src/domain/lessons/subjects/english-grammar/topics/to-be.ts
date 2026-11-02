import type { LearningObjective, LessonTopic } from "../../../types";

/**
 * Temat „to be” (drugi temat katalogu `english_grammar`).
 * Pięć celów w kolejności nauki dla dziecka, które dopiero poznaje angielski:
 * najpierw rozpoznanie, która osoba łączy się z am/is/are, potem skróty,
 * przeczenia, pytania przez inwersję i krótkie odpowiedzi. Karty są krótkie,
 * dzielą formy na trzy grupy osób i podają jedną strategię („najpierw osoba,
 * potem forma”) zamiast definicji gramatycznej. `{{examples}}` w karcie to
 * miejsce na przykłady z materiału lekcji.
 *
 * Pokrycie etapów ocenianych w każdym celu: prowadzony
 * (choice/order/short_answer), produktywny (gap/error_fix/transform),
 * samodzielny (open_answer). `lesson_notice` dodajemy tam, gdzie dziecko
 * może wskazać formę czasownika w zdaniu.
 *
 * `lesson_listen_choice` (wybór ze słuchu, #198) mają cele ze słyszalną różnicą
 * formy: am/is/are (affirmative_forms), przeczenia isn't/aren't (negative_forms)
 * i Is/Are/Am otwierające pytanie (questions).
 * Is/Are na początku pytania jest wyraźnie słyszalne (np. „___ she happy?”).
 * Nie mają go: skróty (różnica 'm/'s/'re jest słabo słyszalna, opcja nie może
 * zaczynać się od apostrofu, a pełna forma i skrót są odpowiedziami
 * równoważnymi) i krótkie odpowiedzi (cel ćwiczy odpowiedź w całości).
 */

const PREFIX = "english_grammar.to_be";

const affirmativeForms: LearningObjective = {
  id: `${PREFIX}.affirmative_forms`,
  titlePl: "Zdania twierdzące: am / is / are",
  descriptionEn:
    "The present forms of the verb 'to be': I am; he, she and it is; you, we and they are. " +
    "The form depends only on the subject. Short affirmative statements about people, animals and things.",
  cards: [
    {
      title: "Trzy formy",
      body: "Czasownik „być” ma trzy formy: I am • he, she, it is • you, we, they are.",
    },
    {
      title: "Kto to jest?",
      body: "he = on (chłopiec albo mężczyzna) • she = ona (dziewczynka albo kobieta) • it = to (zwierzę albo rzecz) • they = oni, one (kilka osób albo rzeczy).",
    },
    {
      title: "Najpierw osoba, potem forma",
      body: "Zatrzymaj się przy osobie i dopiero dobierz formę: She → is, They → are, I → am.",
    },
    {
      title: "Przykłady z lekcji",
      body: "Zobacz, jak to działa: {{examples}}",
    },
  ],
  errorCategories: ["wrong_be_form", "missing_be_form", "wrong_subject_agreement"],
  hints: {
    wrong_be_form: "Dobierz formę do osoby: I am, he/she/it is, you/we/they are.",
    missing_be_form: "W zdaniu brakuje formy „być”: am, is albo are.",
    wrong_subject_agreement: "Popatrz na osobę: jedna osoba albo rzecz to is, kilka osób to are, a przy I zawsze am.",
  },
  exerciseTypes: [
    "lesson_card",
    "lesson_notice",
    "lesson_choice",
    "lesson_listen_choice",
    "lesson_order",
    "lesson_gap",
    "lesson_error_fix",
    "lesson_open_answer",
  ],
};

const contractions: LearningObjective = {
  id: `${PREFIX}.contractions`,
  titlePl: "Skróty: I'm, he's, they're",
  descriptionEn:
    "Contractions of 'to be': I'm (I am), you're (you are), he's, she's and it's (is), we're and they're (are). " +
    "The apostrophe replaces the missing letter; the contracted form must match the subject.",
  cards: [
    {
      title: "Skrót to ta sama forma",
      body: "I'm znaczy I am, he's znaczy he is, a they're znaczy they are. Znak ' pokazuje miejsce brakującej litery.",
    },
    {
      title: "Uwaga na it's",
      body: "It's (z apostrofem) znaczy it is.",
    },
    {
      title: "Przykłady z lekcji",
      body: "Zobacz skróty w zdaniach: {{examples}}",
    },
  ],
  errorCategories: ["wrong_contraction", "wrong_be_form", "wrong_subject_agreement"],
  hints: {
    wrong_contraction: "Skrót budujemy z osoby i jej formy: I am → I'm, he is → he's, they are → they're.",
    wrong_be_form: "Najpierw przypomnij sobie pełną formę: I am, she is, we are — dopiero potem ją skróć.",
    wrong_subject_agreement: "Skrót musi pasować do osoby: she → she's, they → they're, I → I'm.",
  },
  exerciseTypes: [
    "lesson_card",
    "lesson_notice",
    "lesson_choice",
    "lesson_gap",
    "lesson_error_fix",
    "lesson_open_answer",
  ],
};

const negativeForms: LearningObjective = {
  id: `${PREFIX}.negative_forms`,
  titlePl: "Przeczenia: isn't / aren't / I'm not",
  descriptionEn:
    "Negatives of 'to be': add not after am, is or are (I am not, she is not, they are not). " +
    "is not contracts to isn't and are not to aren't; am not has no contraction (I'm not).",
  cards: [
    {
      title: "Dodaj not",
      body: "Przeczenie tworzymy, dodając not po formie „być”: I am not, she is not, they are not.",
    },
    {
      title: "Skróty przeczeń",
      body: "is not → isn't, are not → aren't. Przy I skrótu przeczenia nie ma: am not, czyli I'm not.",
    },
    {
      title: "Przykłady z lekcji",
      body: "Popatrz na przeczenia: {{examples}}",
    },
  ],
  errorCategories: ["wrong_negation", "wrong_be_form", "missing_be_form", "wrong_subject_agreement"],
  hints: {
    wrong_negation: "Przeczenie to forma „być” + not: she is not albo she isn't. Przy I piszemy: I am not / I'm not.",
    wrong_be_form: "Forma musi pasować do osoby także w przeczeniu: they aren't, she isn't, I am not.",
    missing_be_form: "W przeczeniu też potrzebna jest forma „być”: he is not, nie samo „he not”.",
    wrong_subject_agreement: "Sprawdź osobę: he/she/it → isn't, you/we/they → aren't, I → am not.",
  },
  exerciseTypes: [
    "lesson_card",
    "lesson_choice",
    "lesson_listen_choice",
    "lesson_gap",
    "lesson_error_fix",
    "lesson_transform",
    "lesson_open_answer",
  ],
};

const questions: LearningObjective = {
  id: `${PREFIX}.questions`,
  titlePl: "Pytania: Is she…? Are they…?",
  descriptionEn:
    "Questions with 'to be' swap the subject and the verb form: She is happy. becomes Is she happy? " +
    "Am, is and are move before the subject; questions with 'to be' never use do or does.",
  cards: [
    {
      title: "Zamień kolejność",
      body: "W pytaniu forma „być” idzie przed osobę: She is happy. → Is she happy? They are ready. → Are they ready?",
    },
    {
      title: "Bez do i does",
      body: "Przy „to be” nie dodajemy do ani does: Is he…?, nie „Does he is…?”.",
    },
    {
      title: "Przykłady z lekcji",
      body: "Zobacz pytania: {{examples}}",
    },
  ],
  errorCategories: ["word_order", "wrong_be_form", "extra_auxiliary", "wrong_subject_agreement"],
  hints: {
    word_order: "Kolejność w pytaniu: forma „być” + osoba: Is she…?, Are they…?",
    wrong_be_form: "Forma w pytaniu też zależy od osoby: Is she…?, Are we…?, Am I…?",
    extra_auxiliary: "Przy „to be” nie używamy do ani does — pytanie zaczyna sama forma: Is he…?",
    wrong_subject_agreement: "Dobierz formę do osoby po niej: Is it…?, Are you…?, Am I…?",
  },
  exerciseTypes: [
    "lesson_card",
    "lesson_notice",
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
  titlePl: "Krótkie odpowiedzi: Yes, I am / No, he isn't",
  descriptionEn:
    "Short answers to 'to be' questions repeat the same form of the verb: Is she ready? Yes, she is. " +
    "Are they ready? No, they aren't. The short answer does not repeat the rest of the question. " +
    "When the question asks about 'you', the answer speaks about 'I': Are you ready? Yes, I am.",
  cards: [
    {
      title: "Odpowiedz tą samą formą",
      body: "Na pytanie z „to be” odpowiadamy tą samą formą: Is she ready? → Yes, she is. Are they ready? → No, they aren't.",
    },
    {
      title: "Krótko znaczy bez reszty zdania",
      body: "W krótkiej odpowiedzi nie powtarzamy końca pytania: Yes, she is — i kropka.",
    },
    {
      title: "Pytanie o ciebie — odpowiedź o sobie",
      body: "Gdy pytanie jest o ciebie (you), odpowiadasz o sobie (I): Are you ready? → Yes, I am. No, I'm not.",
    },
    {
      title: "Przykłady z lekcji",
      body: "Popatrz na krótkie odpowiedzi: {{examples}}",
    },
  ],
  errorCategories: ["short_answer_form", "wrong_be_form", "wrong_subject_agreement", "wrong_negation"],
  hints: {
    short_answer_form: "Krótka odpowiedź to: Yes, I am / No, he isn't — osoba i forma „być”, bez reszty zdania.",
    wrong_be_form: "Powtórz formę z pytania: Is she…? → Yes, she is. Are they…? → No, they aren't.",
    wrong_subject_agreement: "Forma musi zgadzać się z osobą w odpowiedzi: I → am, she → is, they → are. Na pytanie Are you…? odpowiadasz o sobie: Yes, I am.",
    wrong_negation: "Po No dodajemy przeczenie: No, she isn't. No, I am not (I'm not).",
  },
  exerciseTypes: [
    "lesson_card",
    "lesson_short_answer",
    "lesson_choice",
    "lesson_gap",
    "lesson_open_answer",
  ],
};

export const toBeV1: LessonTopic = {
  id: "to_be",
  version: 1,
  titlePl: "Czasownik „to be”",
  extraErrorCategories: [
    { code: "wrong_be_form", labelPl: "Zła forma czasownika „to be” (am/is/are)" },
    { code: "missing_be_form", labelPl: "Brak formy czasownika „to be”" },
    { code: "wrong_contraction", labelPl: "Zły skrót (I'm, he's, they're)" },
  ],
  transforms: [
    { id: "to_negative", instructionPl: "Zamień na przeczenie" },
    { id: "to_question", instructionPl: "Zamień na pytanie" },
    { id: "to_affirmative", instructionPl: "Zamień na zdanie twierdzące" },
  ],
  objectives: [
    affirmativeForms,
    contractions,
    negativeForms,
    questions,
    shortAnswers,
  ],
};
