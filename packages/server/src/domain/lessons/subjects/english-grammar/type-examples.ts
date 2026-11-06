import type { TypeExamples } from "../../types";

/**
 * Przykłady typów tematu „to be” dla księgi reguł agenta (`agentPolicy.typeExamples`). Ogólne
 * przykłady kart typów ćwiczą Present Simple (drinks, plays, don't), a w tym temacie łamią reguły
 * luki (`hint` „be”, odpowiedź to forma be) i uczą do/does. Każdy cel ma własny zestaw, bo cele
 * różnią się biegunowością (przeczenia wymagają not, cele twierdzące go zabraniają) i formą
 * (skróty, pytania przez inwersję, krótkie odpowiedzi).
 *
 * Zasady jak w kartach typów: każdy typ celu ma własne zdanie (model kopiuje przykłady, a wspólne
 * zdanie łamałoby `lesson.leak`), klocki `lesson_order` bez interpunkcji końcowej, żadnego zdania z
 * kart tematu (happy, ready) i `acceptedAnswers` bez skrótu pełnej formy (to ten sam wariant po
 * normalizacji). Test przepuszcza każdy przykład przez walidację swojego celu.
 */

/** Ostatni segment id zagadnienia tematu „to be” (np. `english_grammar.to_be.questions` → `questions`). */
type ToBeObjective = "affirmative_forms" | "contractions" | "negative_forms" | "questions" | "short_answers";

const TO_BE_EXAMPLES: Readonly<Record<ToBeObjective, TypeExamples>> = {
  affirmative_forms: {
    lesson_notice: {
      exerciseType: "lesson_notice",
      instructionPl: "Wskaż formę „be” po I.",
      noticeSegments: [["I", "am", "at", "home."], ["You", "are", "at", "school."]],
      correctOption: "am",
      answer: "am",
      acceptedAnswers: [],
      focus: [],
    },
    lesson_choice: {
      exerciseType: "lesson_choice",
      instructionPl: "Wybierz poprawną formę.",
      stem: "We ___ in the park.",
      options: [{ id: "a", text: "am" }, { id: "b", text: "is" }, { id: "c", text: "are" }],
      correctOption: "c",
      answer: "are",
      acceptedAnswers: [],
      focus: [],
    },
    lesson_listen_choice: {
      exerciseType: "lesson_listen_choice",
      stem: "I ___ in the garden.",
      options: [{ id: "a", text: "am" }, { id: "b", text: "are" }],
      correctOption: "a",
      answer: "am",
      acceptedAnswers: [],
      focus: [],
    },
    lesson_order: {
      exerciseType: "lesson_order",
      instructionPl: "Ułóż zdanie.",
      items: [{ id: "a", text: "My" }, { id: "b", text: "cat" }, { id: "c", text: "is" }, { id: "d", text: "black" }],
      answer: "My cat is black",
      acceptedAnswers: [],
      focus: [],
    },
    lesson_gap: {
      exerciseType: "lesson_gap",
      instructionPl: "Uzupełnij lukę.",
      stem: "They ___ my friends.",
      hint: "be",
      answer: "are",
      acceptedAnswers: [],
      focus: ["are"],
    },
    lesson_error_fix: {
      exerciseType: "lesson_error_fix",
      instructionPl: "Popraw błąd w zdaniu.",
      statement: "She are my sister.",
      answer: "She is my sister.",
      acceptedAnswers: [],
      focus: ["is"],
    },
    lesson_open_answer: {
      exerciseType: "lesson_open_answer",
      instructionPl: "Przetłumacz na angielski.",
      prompt: "Mój tata jest wysoki.",
      answer: "My dad is tall.",
      acceptedAnswers: [],
      focus: ["is"],
    },
  },
  contractions: {
    lesson_notice: {
      exerciseType: "lesson_notice",
      instructionPl: "Wskaż skrót od he is.",
      noticeSegments: [["He's", "my", "brother."], ["We're", "at", "home."]],
      correctOption: "He's",
      answer: "He's",
      acceptedAnswers: [],
      focus: [],
    },
    lesson_choice: {
      exerciseType: "lesson_choice",
      instructionPl: "Wybierz skrót od I am.",
      stem: "___ tired.",
      options: [{ id: "a", text: "I'm" }, { id: "b", text: "You're" }, { id: "c", text: "He's" }],
      correctOption: "a",
      answer: "I'm",
      acceptedAnswers: [],
      focus: [],
    },
    lesson_gap: {
      exerciseType: "lesson_gap",
      instructionPl: "Uzupełnij lukę skrótem.",
      stem: "I have a dog. ___ very small.",
      hint: "be",
      answer: "It's",
      acceptedAnswers: [],
      focus: ["It's"],
    },
    lesson_error_fix: {
      exerciseType: "lesson_error_fix",
      instructionPl: "Popraw błąd w zdaniu.",
      statement: "They's in the park.",
      answer: "They're in the park.",
      acceptedAnswers: [],
      focus: ["They're"],
    },
    lesson_open_answer: {
      exerciseType: "lesson_open_answer",
      instructionPl: "Przetłumacz na angielski, używając skrótu.",
      prompt: "Jestem w szkole.",
      answer: "I'm at school.",
      acceptedAnswers: [],
      focus: ["I'm"],
    },
  },
  negative_forms: {
    lesson_choice: {
      exerciseType: "lesson_choice",
      instructionPl: "Wybierz poprawną formę.",
      stem: "They ___ at school today.",
      options: [{ id: "a", text: "aren't" }, { id: "b", text: "isn't" }],
      correctOption: "a",
      answer: "aren't",
      acceptedAnswers: [],
      focus: [],
    },
    lesson_listen_choice: {
      exerciseType: "lesson_listen_choice",
      stem: "He ___ at home.",
      options: [{ id: "a", text: "isn't" }, { id: "b", text: "aren't" }],
      correctOption: "a",
      answer: "isn't",
      acceptedAnswers: [],
      focus: [],
    },
    lesson_gap: {
      exerciseType: "lesson_gap",
      instructionPl: "Uzupełnij lukę przeczeniem.",
      stem: "I ___ hungry.",
      hint: "be",
      answer: "am not",
      acceptedAnswers: [],
      focus: ["am", "not"],
    },
    lesson_error_fix: {
      exerciseType: "lesson_error_fix",
      instructionPl: "Popraw błąd w zdaniu.",
      statement: "We isn't late.",
      answer: "We aren't late.",
      acceptedAnswers: [],
      focus: ["aren't"],
    },
    lesson_transform: {
      exerciseType: "lesson_transform",
      instructionPl: "Zamień na przeczenie.",
      statement: "It is cold.",
      transformId: "to_negative",
      answer: "It isn't cold.",
      acceptedAnswers: [],
      focus: ["isn't"],
    },
    lesson_open_answer: {
      exerciseType: "lesson_open_answer",
      instructionPl: "Przetłumacz na angielski.",
      prompt: "Ona nie jest zmęczona.",
      answer: "She isn't tired.",
      acceptedAnswers: [],
      focus: ["isn't"],
    },
  },
  questions: {
    lesson_notice: {
      exerciseType: "lesson_notice",
      instructionPl: "Wskaż formę „be”, która zaczyna pytanie.",
      noticeSegments: [["Am", "I", "late?"], ["You", "are", "late."]],
      correctOption: "Am",
      answer: "Am",
      acceptedAnswers: [],
      focus: [],
    },
    lesson_choice: {
      exerciseType: "lesson_choice",
      instructionPl: "Wybierz poprawną formę.",
      stem: "___ he your brother?",
      options: [{ id: "a", text: "Is" }, { id: "b", text: "Are" }],
      correctOption: "a",
      answer: "Is",
      acceptedAnswers: [],
      focus: [],
    },
    lesson_listen_choice: {
      exerciseType: "lesson_listen_choice",
      stem: "___ they your cats?",
      options: [{ id: "a", text: "Are" }, { id: "b", text: "Is" }],
      correctOption: "a",
      answer: "Are",
      acceptedAnswers: [],
      focus: [],
    },
    lesson_order: {
      exerciseType: "lesson_order",
      instructionPl: "Ułóż pytanie.",
      items: [{ id: "a", text: "Is" }, { id: "b", text: "it" }, { id: "c", text: "your" }, { id: "d", text: "bag" }],
      answer: "Is it your bag",
      acceptedAnswers: [],
      focus: [],
    },
    lesson_gap: {
      exerciseType: "lesson_gap",
      instructionPl: "Uzupełnij lukę.",
      stem: "___ you at home?",
      hint: "be",
      answer: "Are",
      acceptedAnswers: [],
      focus: ["Are"],
    },
    lesson_transform: {
      exerciseType: "lesson_transform",
      instructionPl: "Zamień na pytanie.",
      statement: "The dog is in the garden.",
      transformId: "to_question",
      answer: "Is the dog in the garden?",
      acceptedAnswers: [],
      focus: ["Is"],
    },
    lesson_open_answer: {
      exerciseType: "lesson_open_answer",
      instructionPl: "Przetłumacz na angielski.",
      prompt: "Czy jesteś głodny?",
      answer: "Are you hungry?",
      acceptedAnswers: [],
      focus: ["Are", "you"],
    },
  },
  short_answers: {
    lesson_short_answer: {
      exerciseType: "lesson_short_answer",
      instructionPl: "Wybierz krótką odpowiedź.",
      prompt: "Is she your sister?",
      options: [{ id: "a", text: "Yes, she is." }, { id: "b", text: "Yes, she does." }],
      correctOption: "a",
      answer: "Yes, she is.",
      acceptedAnswers: [],
      focus: [],
    },
    lesson_choice: {
      exerciseType: "lesson_choice",
      instructionPl: "Wybierz poprawną odpowiedź.",
      stem: "Are you at school?",
      options: [{ id: "a", text: "No, I'm not." }, { id: "b", text: "No, you aren't." }],
      correctOption: "a",
      answer: "No, I'm not.",
      acceptedAnswers: [],
      focus: [],
    },
    lesson_gap: {
      exerciseType: "lesson_gap",
      instructionPl: "Uzupełnij krótką odpowiedź.",
      stem: "Is he at home? Yes, he ___.",
      hint: "be",
      answer: "is",
      acceptedAnswers: [],
      focus: ["is"],
    },
    lesson_open_answer: {
      exerciseType: "lesson_open_answer",
      instructionPl: "Przetłumacz krótką odpowiedź na angielski.",
      prompt: "Czy oni są w parku? Nie, nie są.",
      answer: "No, they aren't.",
      acceptedAnswers: [],
      focus: ["aren't"],
    },
  },
};

/** Temat czasownika „to be” (`topics/to-be.ts`). */
const TO_BE_TOPIC = "to_be";

/** Przykłady przedmiotu dla zagadnienia; poza tematem „to be” — przykłady kart typów. */
export function grammarTypeExamples(at: { readonly topicId: string; readonly objectiveId: string }): TypeExamples | undefined {
  if (at.topicId !== TO_BE_TOPIC) return undefined;
  const objective = at.objectiveId.split(".").at(-1) ?? "";
  return Object.hasOwn(TO_BE_EXAMPLES, objective) ? TO_BE_EXAMPLES[objective as ToBeObjective] : undefined;
}
