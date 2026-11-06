import type { LessonExerciseType, TypeExamples } from "../../types";

/**
 * Przykłady typów tematów „to be” i Present Continuous dla księgi reguł agenta (`agentPolicy.typeExamples`).
 * Ogólne przykłady kart typów ćwiczą Present Simple (drinks, plays, don't), a w temacie „to be” łamią reguły
 * luki (`hint` „be”, odpowiedź to forma be) i uczą do/does. Każdy cel ma własny zestaw, bo cele
 * różnią się biegunowością (przeczenia wymagają not, cele twierdzące go zabraniają) i formą
 * (skróty, pytania przez inwersję, krótkie odpowiedzi).
 *
 * Zasady jak w kartach typów: każdy typ celu ma własne zdanie (model kopiuje przykłady, a wspólne
 * zdanie łamałoby `lesson.leak`), klocki `lesson_order` bez interpunkcji końcowej, żadnego zdania z
 * kart tematu (happy, ready) i `acceptedAnswers` bez skrótu pełnej formy (to ten sam wariant po
 * normalizacji). Test przepuszcza każdy przykład przez walidację swojego celu.
 */

/** Pola przykładu bez `exerciseType` (bierze go z klucza typu); puste `acceptedAnswers` i `focus` można pominąć. */
type ExampleFields = Readonly<Record<string, unknown>> & { readonly acceptedAnswers?: readonly string[]; readonly focus?: readonly string[] };

/** Przykłady celów z `exerciseType` z klucza i `acceptedAnswers`, `focus` na końcu (domyślnie puste), jak w kartach typów. */
function withTypes<K extends string>(byObjective: Readonly<Record<K, Partial<Record<LessonExerciseType, ExampleFields>>>>): Readonly<Record<K, TypeExamples>> {
  const result: Partial<Record<K, TypeExamples>> = {};
  for (const objective of Object.keys(byObjective) as K[]) {
    const examples: Record<string, Readonly<Record<string, unknown>>> = {};
    for (const [exerciseType, example] of Object.entries(byObjective[objective])) {
      if (example === undefined) continue;
      const { acceptedAnswers = [], focus = [], ...fields } = example;
      examples[exerciseType] = { exerciseType, ...fields, acceptedAnswers, focus };
    }
    result[objective] = examples;
  }
  return result as Record<K, TypeExamples>;
}

/** Ostatni segment id zagadnienia tematu „to be” (np. `english_grammar.to_be.questions` → `questions`). */
type ToBeObjective = "affirmative_forms" | "contractions" | "negative_forms" | "questions" | "short_answers";

const TO_BE_EXAMPLES = withTypes<ToBeObjective>({
  affirmative_forms: {
    lesson_notice: { instructionPl: "Wskaż formę „be” po I.", noticeSegments: [["I", "am", "at", "home."], ["You", "are", "at", "school."]], correctOption: "am", answer: "am" },
    lesson_choice: { instructionPl: "Wybierz poprawną formę.", stem: "We ___ in the park.", options: [{ id: "a", text: "am" }, { id: "b", text: "is" }, { id: "c", text: "are" }], correctOption: "c", answer: "are" },
    lesson_listen_choice: { stem: "I ___ in the garden.", options: [{ id: "a", text: "am" }, { id: "b", text: "are" }], correctOption: "a", answer: "am" },
    lesson_order: { instructionPl: "Ułóż zdanie.", items: [{ id: "a", text: "My" }, { id: "b", text: "cat" }, { id: "c", text: "is" }, { id: "d", text: "black" }], answer: "My cat is black" },
    lesson_gap: { instructionPl: "Uzupełnij lukę.", stem: "They ___ my friends.", hint: "be", answer: "are", focus: ["are"] },
    lesson_error_fix: { instructionPl: "Popraw błąd w zdaniu.", statement: "She are my sister.", answer: "She is my sister.", focus: ["is"] },
    lesson_open_answer: { instructionPl: "Przetłumacz na angielski.", prompt: "Mój tata jest wysoki.", answer: "My dad is tall.", focus: ["is"] },
  },
  contractions: {
    lesson_notice: { instructionPl: "Wskaż skrót od he is.", noticeSegments: [["He's", "my", "brother."], ["We're", "at", "home."]], correctOption: "He's", answer: "He's" },
    lesson_choice: { instructionPl: "Wybierz skrót od I am.", stem: "___ tired.", options: [{ id: "a", text: "I'm" }, { id: "b", text: "You're" }, { id: "c", text: "He's" }], correctOption: "a", answer: "I'm" },
    lesson_gap: { instructionPl: "Uzupełnij lukę skrótem.", stem: "I have a dog. ___ very small.", hint: "be", answer: "It's", focus: ["It's"] },
    lesson_error_fix: { instructionPl: "Popraw błąd w zdaniu.", statement: "They's in the park.", answer: "They're in the park.", focus: ["They're"] },
    lesson_open_answer: { instructionPl: "Przetłumacz na angielski, używając skrótu.", prompt: "Jestem w szkole.", answer: "I'm at school.", focus: ["I'm"] },
  },
  negative_forms: {
    lesson_choice: { instructionPl: "Wybierz poprawną formę.", stem: "They ___ at school today.", options: [{ id: "a", text: "aren't" }, { id: "b", text: "isn't" }], correctOption: "a", answer: "aren't" },
    lesson_listen_choice: { stem: "He ___ at home.", options: [{ id: "a", text: "isn't" }, { id: "b", text: "aren't" }], correctOption: "a", answer: "isn't" },
    lesson_gap: { instructionPl: "Uzupełnij lukę przeczeniem.", stem: "I ___ hungry.", hint: "be", answer: "am not", focus: ["am", "not"] },
    lesson_error_fix: { instructionPl: "Popraw błąd w zdaniu.", statement: "We isn't late.", answer: "We aren't late.", focus: ["aren't"] },
    lesson_transform: { instructionPl: "Zamień na przeczenie.", statement: "It is cold.", transformId: "to_negative", answer: "It isn't cold.", focus: ["isn't"] },
    lesson_open_answer: { instructionPl: "Przetłumacz na angielski.", prompt: "Ona nie jest zmęczona.", answer: "She isn't tired.", focus: ["isn't"] },
  },
  questions: {
    lesson_notice: { instructionPl: "Wskaż formę „be”, która zaczyna pytanie.", noticeSegments: [["Am", "I", "late?"], ["You", "are", "late."]], correctOption: "Am", answer: "Am" },
    lesson_choice: { instructionPl: "Wybierz poprawną formę.", stem: "___ he your brother?", options: [{ id: "a", text: "Is" }, { id: "b", text: "Are" }], correctOption: "a", answer: "Is" },
    lesson_listen_choice: { stem: "___ they your cats?", options: [{ id: "a", text: "Are" }, { id: "b", text: "Is" }], correctOption: "a", answer: "Are" },
    lesson_order: { instructionPl: "Ułóż pytanie.", items: [{ id: "a", text: "Is" }, { id: "b", text: "it" }, { id: "c", text: "your" }, { id: "d", text: "bag" }], answer: "Is it your bag" },
    lesson_gap: { instructionPl: "Uzupełnij lukę.", stem: "___ you at home?", hint: "be", answer: "Are", focus: ["Are"] },
    lesson_transform: { instructionPl: "Zamień na pytanie.", statement: "The dog is in the garden.", transformId: "to_question", answer: "Is the dog in the garden?", focus: ["Is"] },
    lesson_open_answer: { instructionPl: "Przetłumacz na angielski.", prompt: "Czy jesteś głodny?", answer: "Are you hungry?", focus: ["Are", "you"] },
  },
  short_answers: {
    lesson_short_answer: { instructionPl: "Wybierz krótką odpowiedź.", prompt: "Is she your sister?", options: [{ id: "a", text: "Yes, she is." }, { id: "b", text: "Yes, she does." }], correctOption: "a", answer: "Yes, she is." },
    lesson_choice: { instructionPl: "Wybierz poprawną odpowiedź.", stem: "Are you at school?", options: [{ id: "a", text: "No, I'm not." }, { id: "b", text: "No, you aren't." }], correctOption: "a", answer: "No, I'm not." },
    lesson_gap: { instructionPl: "Uzupełnij krótką odpowiedź.", stem: "Is he at home? Yes, he ___.", hint: "be", answer: "is", focus: ["is"] },
    lesson_open_answer: { instructionPl: "Przetłumacz krótką odpowiedź na angielski.", prompt: "Czy oni są w parku? Nie, nie są.", answer: "No, they aren't.", focus: ["aren't"] },
  },
});

/** Ostatni segment id zagadnienia tematu Present Continuous. */
type PresentContinuousObjective = "affirmative" | "now_or_usually" | "negative" | "questions" | "ing_spelling" | "now_or_usually_more";

/**
 * Przykłady typów tematu Present Continuous: ogólne przykłady kart (Present Simple, `hint`) łamią
 * reguły tematu (luka bez `hint` z czasownikiem w nawiasie, wskaźnik „teraz”, tabela -ing). Zasady
 * jak w przykładach „to be”; dodatkowo żaden przykład nie powtarza zdania z kart tematu (test
 * `type-examples.test.ts`), a każdy cel ma własne czasowniki i podmioty.
 */
const PRESENT_CONTINUOUS_EXAMPLES = withTypes<PresentContinuousObjective>({
  affirmative: {
    lesson_notice: { instructionPl: "Wskaż czasownik z -ing.", noticeSegments: [["Grandpa", "is", "painting", "now."], ["His", "picture", "is", "big."]], correctOption: "painting", answer: "painting" },
    lesson_choice: { instructionPl: "Wybierz poprawną formę.", stem: "The birds ___ in the tree now.", options: [{ id: "a", text: "are singing" }, { id: "b", text: "is singing" }], correctOption: "a", answer: "are singing" },
    lesson_listen_choice: { stem: "My sister ___ walking the dog now.", options: [{ id: "a", text: "is" }, { id: "b", text: "are" }], correctOption: "a", answer: "is" },
    // Scenka w poleceniu zamiast klocka „now”: klocek dałby kilka poprawnych szyków („We are now drinking milk”).
    lesson_order: { instructionPl: "Cicho! Jemy śniadanie. Ułóż zdanie.", items: [{ id: "a", text: "We" }, { id: "b", text: "are" }, { id: "c", text: "drinking" }, { id: "d", text: "milk" }], answer: "We are drinking milk" },
    lesson_gap: { instructionPl: "Uzupełnij zdanie.", stem: "Look! Tom ___ (climb) a tree.", answer: "is climbing", focus: ["is", "climbing"] },
    lesson_error_fix: { instructionPl: "Popraw błąd w zdaniu.", statement: "The boys is kicking a ball now.", answer: "The boys are kicking a ball now.", focus: ["are"] },
    // Inne wskaźniki „teraz” jako warianty (ślepa ocena sondy: tłumaczenie bez „at the moment”).
    lesson_open_answer: { instructionPl: "Przetłumacz na angielski.", prompt: "Kot teraz śpi na kanapie.", answer: "The cat is sleeping on the sofa now.", acceptedAnswers: ["The cat is sleeping on the sofa right now.", "The cat is sleeping on the sofa at the moment."], focus: ["is", "sleeping"] },
  },
  now_or_usually: {
    lesson_choice: { instructionPl: "Cicho! Mama pracuje. Wybierz dobrą formę.", stem: "Mum ___ at her desk.", options: [{ id: "a", text: "is working" }, { id: "b", text: "works" }], correctOption: "a", answer: "is working" },
    // Luka i poprawianie: czas tylko w polskiej scence polecenia, bez angielskiego wskaźnika w zdaniu (Task 16).
    lesson_gap: { instructionPl: "Cicho! Dziadek śpi. Uzupełnij zdanie.", stem: "Grandpa ___ (sleep) on the sofa.", answer: "is sleeping", focus: ["is", "sleeping"] },
    lesson_error_fix: { instructionPl: "Mój brat co rano chodzi pieszo do szkoły. Popraw błąd w zdaniu.", statement: "My brother is walking to school.", answer: "My brother walks to school.", focus: ["walks"] },
    lesson_open_answer: { instructionPl: "Przetłumacz na angielski.", prompt: "Ola codziennie pije sok.", answer: "Ola drinks juice every day.", focus: ["drinks"] },
  },
  negative: {
    lesson_choice: { instructionPl: "Wybierz poprawną formę.", stem: "The children ___ sleeping right now.", options: [{ id: "a", text: "aren't" }, { id: "b", text: "isn't" }, { id: "c", text: "don't" }], correctOption: "a", answer: "aren't" },
    lesson_listen_choice: { stem: "The baby ___ crying right now.", options: [{ id: "a", text: "isn't" }, { id: "b", text: "aren't" }], correctOption: "a", answer: "isn't" },
    lesson_gap: { instructionPl: "Uzupełnij zdanie.", stem: "Ola ___ (not draw) right now.", answer: "isn't drawing", focus: ["isn't", "drawing"] },
    lesson_error_fix: { instructionPl: "Popraw błąd w zdaniu.", statement: "Dad not washing the car right now.", answer: "Dad isn't washing the car right now.", focus: ["isn't"] },
    lesson_transform: { instructionPl: "Zamień na przeczenie.", statement: "The girls are talking right now.", transformId: "to_negative", answer: "The girls aren't talking right now.", focus: ["aren't"] },
    lesson_open_answer: { instructionPl: "Przetłumacz na angielski.", prompt: "Mój brat w tym momencie nie pracuje.", answer: "My brother isn't working at the moment.", acceptedAnswers: ["My brother isn't working now.", "My brother isn't working right now.", "At the moment my brother isn't working."], focus: ["isn't", "working"] },
  },
  questions: {
    lesson_choice: { instructionPl: "Wybierz poprawną formę.", stem: "___ your friends waiting for the bus now?", options: [{ id: "a", text: "Are" }, { id: "b", text: "Is" }, { id: "c", text: "Do" }], correctOption: "a", answer: "Are" },
    lesson_listen_choice: { stem: "___ Grandma drinking tea?", options: [{ id: "a", text: "Is" }, { id: "b", text: "Are" }], correctOption: "a", answer: "Is" },
    lesson_order: { instructionPl: "Ułóż pytanie.", items: [{ id: "a", text: "Are" }, { id: "b", text: "they" }, { id: "c", text: "eating" }, { id: "d", text: "lunch" }], answer: "Are they eating lunch" },
    lesson_short_answer: { instructionPl: "Wybierz krótką odpowiedź.", prompt: "Is Tom helping his mum?", options: [{ id: "a", text: "Yes, he is." }, { id: "b", text: "Yes, he does." }], correctOption: "a", answer: "Yes, he is." },
    lesson_gap: { instructionPl: "Uzupełnij pytanie.", stem: "___ you listening to music?", answer: "Are", focus: ["Are"] },
    lesson_transform: { instructionPl: "Zamień na pytanie.", statement: "Ola is cleaning her room now.", transformId: "to_question", answer: "Is Ola cleaning her room now?", focus: ["Is"] },
    lesson_open_answer: { instructionPl: "Przetłumacz na angielski.", prompt: "Czy Ola teraz gra na gitarze?", answer: "Is Ola playing the guitar now?", acceptedAnswers: ["Is Ola playing the guitar right now?", "Is Ola playing the guitar at the moment?"], focus: ["Is"] },
  },
  ing_spelling: {
    lesson_choice: { instructionPl: "Wybierz poprawną pisownię.", stem: "Tom is ___ a letter now.", options: [{ id: "a", text: "writing" }, { id: "b", text: "writeing" }], correctOption: "a", answer: "writing" },
    lesson_gap: { instructionPl: "Uzupełnij zdanie.", stem: "The cat ___ (sit) on the wall now.", answer: "is sitting", focus: ["is", "sitting"] },
    lesson_error_fix: { instructionPl: "Popraw błąd w zdaniu.", statement: "The children are danceing now.", answer: "The children are dancing now.", focus: ["dancing"] },
    lesson_open_answer: { instructionPl: "Przetłumacz na angielski.", prompt: "Mama teraz biegnie do sklepu.", answer: "Mum is running to the shop now.", acceptedAnswers: ["Mum is running to the shop right now.", "Mum is running to the shop at the moment."], focus: ["is", "running"] },
  },
  now_or_usually_more: {
    lesson_choice: { instructionPl: "Wybierz poprawne pytanie.", stem: "Tom is in a swimming club.", options: [{ id: "a", text: "Does Tom swim on Fridays?" }, { id: "b", text: "Is Tom swimming on Fridays?" }], correctOption: "a", answer: "Does Tom swim on Fridays?" },
    // Luka i poprawianie: czas tylko w polskiej scence polecenia, bez angielskiego wskaźnika w zdaniu (Task 16).
    lesson_gap: { instructionPl: "Cicho! Tata śpi. Uzupełnij zdanie.", stem: "Dad ___ (not watch) TV.", answer: "isn't watching", focus: ["isn't", "watching"] },
    lesson_error_fix: { instructionPl: "Tom nigdy nie je mięsa. Popraw błąd w zdaniu.", statement: "Tom isn't eating meat.", answer: "Tom doesn't eat meat.", focus: ["doesn't", "eat"] },
    lesson_open_answer: { instructionPl: "Przetłumacz na angielski.", prompt: "Czy Ola tańczy w soboty?", answer: "Does Ola dance on Saturdays?", focus: ["Does"] },
  },
});

/** Temat czasownika „to be” (`topics/to-be.ts`). */
const TO_BE_TOPIC = "to_be";

/** Temat Present Continuous (`topics/present-continuous.ts`). */
const PRESENT_CONTINUOUS_TOPIC = "present_continuous";

/** Przykłady tematów według ostatniego segmentu id zagadnienia. */
const EXAMPLES_BY_TOPIC: Readonly<Record<string, Readonly<Record<string, TypeExamples>>>> = {
  [TO_BE_TOPIC]: TO_BE_EXAMPLES,
  [PRESENT_CONTINUOUS_TOPIC]: PRESENT_CONTINUOUS_EXAMPLES,
};

/** Przykłady przedmiotu dla zagadnienia; poza tematami „to be” i Present Continuous — przykłady kart typów. */
export function grammarTypeExamples(at: { readonly topicId: string; readonly objectiveId: string }): TypeExamples | undefined {
  const examples = Object.hasOwn(EXAMPLES_BY_TOPIC, at.topicId) ? EXAMPLES_BY_TOPIC[at.topicId] : undefined;
  const objective = at.objectiveId.split(".").at(-1) ?? "";
  return examples !== undefined && Object.hasOwn(examples, objective) ? examples[objective] : undefined;
}
