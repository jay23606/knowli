import type { LessonExerciseType, SubjectModule } from "../types";

/**
 * Karty typów ćwiczeń (spec katalogu reguł §2.1): opis typu jako całości dla
 * modelu agenta — do czego służy i które pola zwrócić — z jednym minimalnym,
 * poprawnym przykładem rekordu. Karta nie jest regułą (reguły typu daje
 * katalog), ale trafia do bloku typu w księdze reguł (`rule-book.ts`).
 *
 * Przykład zależy wyłącznie od cech przedmiotu (`SubjectFeatures`), nigdy od
 * jego id: silnik nie zna przedmiotów. Gdy ogólny przykład łamie reguły tematu albo celu, przedmiot
 * podaje własny (`agentPolicy.typeExamples`, wybór w `typeExample`). Przykład bez `objectiveId` (wstawia go
 * księga reguł); test przepuszcza każdy przykład przez materializację, kształt
 * rekordu i walidację ćwiczenia każdego produkcyjnego przedmiotu, który ma typ.
 * Treść neutralna: angielskie słówka i zdania albo ogólnie znane fakty o Polsce.
 * Każdy typ ma własne zdanie albo fakt (odpowiedź i bodziec): model kopiuje
 * przykłady, a wspólne zdanie kilku typów łamałoby `lesson.leak` i powtarzało
 * bodziec. Klocki `lesson_order` bez interpunkcji końcowej.
 */

/** Cechy przedmiotu, od których zależy przykład karty. */
export interface SubjectFeatures {
  /** Ćwiczenia niosą cytaty `sourceRefs` z materiału (`SubjectModule.sourceQuotes`). */
  readonly groundingRequired: boolean;
  /** Pola payloadu v3 (`SubjectModule.usesV3Payload`). */
  readonly usesV3Payload: boolean;
  /** Język odpowiedzi dziecka (`SubjectModule.answerLocale`). */
  readonly answerLocale: string;
  /** Polecenie niesie polskie zdanie-bodziec (`SubjectModule.instructionIsStimulus`). */
  readonly instructionIsStimulus: boolean;
}

export interface TypeCard {
  /** Jedno–dwa zdania po angielsku: cel typu i pola do zwrócenia (bez liczb — limity podają reguły). */
  readonly summary: string;
  /** Minimalny poprawny rekord dla przedmiotu o tych cechach; `undefined` — typ bez przykładu dla takich cech. */
  readonly example?: (features: SubjectFeatures) => Record<string, unknown> | undefined;
}

/** Cechy przedmiotu do wyboru przykładu. */
export function subjectFeatures(subject: SubjectModule): SubjectFeatures {
  return {
    groundingRequired: subject.sourceQuotes === true,
    usesV3Payload: subject.usesV3Payload === true,
    answerLocale: subject.answerLocale,
    instructionIsStimulus: subject.instructionIsStimulus === true,
  };
}

/** Język treści przykładu z języka odpowiedzi; inny język — brak przykładu. */
function languageOf(features: SubjectFeatures): "en" | "pl" | null {
  const language = features.answerLocale.toLowerCase().split("-")[0];
  return language === "en" || language === "pl" ? language : null;
}

/** Polecenie przykładu: z polskim zdaniem-bodźcem, gdy przedmiot go wymaga. */
function instruction(features: SubjectFeatures, stimulus: string, task: string): string {
  return features.instructionIsStimulus ? `${stimulus} ${task}` : task;
}

/** Cytaty źródłowe, gdy przedmiot wymaga uziemienia (pole na końcu rekordu); ćwiczenie kilku faktów cytuje każdy. */
function grounded(features: SubjectFeatures, record: Record<string, unknown>, ...quotes: readonly string[]): Record<string, unknown> {
  return features.groundingRequired ? { ...record, sourceRefs: quotes.map((quote) => ({ quote })) } : record;
}

/** Wspólny „materiał” polskich przykładów (zdania cytowane w `sourceRefs`). */
const PL_RIVER = "Wisła jest najdłuższą rzeką w Polsce.";
const PL_SEA = "Wisła uchodzi do Morza Bałtyckiego.";
const PL_MOUNTAINS = "Najwyższe góry Polski to Tatry.";
const PL_CAPITAL = "Stolicą Polski jest Warszawa.";
const PL_CAPITAL_RIVER = "Przez Warszawę płynie Wisła.";
const PL_WATER_CYCLE = "Woda paruje, skrapla się w chmurach i spada jako deszcz.";
const PL_SCALE = "Odległość w terenie to odległość na mapie pomnożona przez mianownik skali.";
/** Rodzina pytania otwartego i jego słów kluczowych w przykładach. */
const PL_FAMILY = "wisla-morze";

export const TYPE_CARDS: Readonly<Record<LessonExerciseType, TypeCard>> = {
  lesson_card: {
    summary: "Cards come from the objective's cards of the topic; never submit lesson_card as an exercise.",
  },
  lesson_notice: {
    summary:
      "The child reads short sentences and points at one word. Return instructionPl, noticeSegments (each sentence " +
      "split into word segments), correctOption (the word pointed at, copied from the segments) and answer (that word).",
    example: (features) =>
      languageOf(features) === "en"
        ? grounded(features, {
            exerciseType: "lesson_notice",
            instructionPl: "Wskaż czasownik z końcówką -s.",
            noticeSegments: [["She", "walks", "to", "school."], ["They", "walk", "home."]],
            correctOption: "walks",
            answer: "walks",
            acceptedAnswers: [],
            focus: [],
          }, "She walks to school.")
        : undefined,
  },
  lesson_choice: {
    summary:
      "The child picks the correct option for a sentence or question. Return instructionPl, stem (the sentence with a " +
      "gap ___ or the question), options {id, text}, correctOption (the id of the correct option) and answer (its text).",
    example: (features) => {
      const language = languageOf(features);
      // Jedno rozwiązanie bez klucza (ślepe rozwiązanie): przy poleceniu-bodźcu wybór wskazuje polskie zdanie,
      // bez bodźca opcje to formy jednego czasownika, z których do zdania pasuje gramatycznie tylko jedna.
      if (language === "en" && features.instructionIsStimulus) {
        return grounded(features, {
          exerciseType: "lesson_choice",
          instructionPl: instruction(features, "Dziś pada deszcz.", "Wybierz słowo."),
          stem: "It's ___ today.",
          options: [{ id: "a", text: "raining" }, { id: "b", text: "sunny" }],
          correctOption: "a",
          answer: "raining",
          acceptedAnswers: [],
          focus: [],
        }, "raining — pada deszcz");
      }
      if (language === "en") {
        return grounded(features, {
          exerciseType: "lesson_choice",
          instructionPl: "Wybierz poprawną formę.",
          stem: "He ___ football every day.",
          options: [{ id: "a", text: "plays" }, { id: "b", text: "play" }],
          correctOption: "a",
          answer: "plays",
          acceptedAnswers: [],
          focus: [],
        }, "He plays football every day.");
      }
      if (language === "pl") {
        return grounded(features, {
          exerciseType: "lesson_choice",
          instructionPl: "Wybierz poprawną odpowiedź.",
          stem: "Która rzeka jest najdłuższa w Polsce?",
          options: [{ id: "a", text: "Wisła" }, { id: "b", text: "Odra" }, { id: "c", text: "Warta" }],
          correctOption: "a",
          answer: "Wisła",
          acceptedAnswers: [],
          focus: [],
        }, PL_RIVER);
      }
      return undefined;
    },
  },
  lesson_order: {
    summary:
      "The child puts word blocks in order. Return instructionPl, items {id, text} in the correct order (the app " +
      "shuffles them) and answer (the items joined with spaces).",
    example: (features) => {
      const language = languageOf(features);
      if (language === "en") {
        return grounded(features, {
          exerciseType: "lesson_order",
          instructionPl: instruction(features, "My gramy w piłkę.", "Ułóż zdanie."),
          items: [{ id: "a", text: "We" }, { id: "b", text: "play" }, { id: "c", text: "football" }],
          answer: "We play football",
          acceptedAnswers: [],
          focus: [],
        }, "We play football");
      }
      if (language === "pl") {
        return grounded(features, {
          exerciseType: "lesson_order",
          instructionPl: "Ułóż etapy krążenia wody w kolejności.",
          items: [{ id: "a", text: "woda paruje" }, { id: "b", text: "skrapla się w chmurach" }, { id: "c", text: "spada jako deszcz" }],
          answer: "woda paruje skrapla się w chmurach spada jako deszcz",
          acceptedAnswers: [],
          focus: [],
        }, PL_WATER_CYCLE);
      }
      return undefined;
    },
  },
  lesson_short_answer: {
    summary:
      "The child picks the short answer to a question. Return instructionPl, prompt (the question), options {id, text}, " +
      "correctOption (the id of the correct option) and answer (its text).",
    example: (features) =>
      languageOf(features) === "en"
        ? grounded(features, {
            exerciseType: "lesson_short_answer",
            instructionPl: "Wybierz krótką odpowiedź.",
            prompt: "Does she like cats?",
            options: [{ id: "a", text: "Yes, she does." }, { id: "b", text: "Yes, she is." }],
            correctOption: "a",
            answer: "Yes, she does.",
            acceptedAnswers: [],
            focus: [],
          }, "Yes, she does.")
        : undefined,
  },
  lesson_gap: {
    summary:
      "The child types the missing word or words of a sentence. Return instructionPl, stem (the sentence with one gap ___), " +
      "answer (the gap text), acceptedAnswers (other correct gap texts) and focus (the checked words of the answer).",
    example: (features) => {
      const language = languageOf(features);
      if (language === "en") {
        return grounded(features, {
          exerciseType: "lesson_gap",
          instructionPl: instruction(features, "On pije mleko.", "Uzupełnij lukę."),
          stem: "He ___ milk.",
          // Bez polecenia-bodźca jedno rozwiązanie wskazuje forma podstawowa czasownika w podpowiedzi.
          ...(features.instructionIsStimulus ? {} : { hint: "drink" }),
          answer: "drinks",
          acceptedAnswers: [],
          focus: ["drinks"],
        }, "He drinks milk.");
      }
      if (language === "pl") {
        return grounded(features, {
          exerciseType: "lesson_gap",
          instructionPl: "Uzupełnij zdanie.",
          stem: "Najwyższe góry Polski to ___.",
          answer: "Tatry",
          acceptedAnswers: [],
          focus: ["Tatry"],
        }, PL_MOUNTAINS);
      }
      return undefined;
    },
  },
  lesson_error_fix: {
    summary:
      "The child corrects a sentence with one mistake. Return instructionPl, statement (the sentence with the mistake), " +
      "answer (the corrected sentence), acceptedAnswers and focus (the corrected words).",
    example: (features) =>
      languageOf(features) === "en"
        ? grounded(features, {
            exerciseType: "lesson_error_fix",
            instructionPl: "Popraw błąd w zdaniu.",
            statement: "They eats apples.",
            answer: "They eat apples.",
            acceptedAnswers: [],
            focus: ["eat"],
          }, "They eat apples.")
        : undefined,
  },
  lesson_transform: {
    summary:
      "The child rewrites a sentence by one of the topic's transforms. Return instructionPl, statement (the sentence to " +
      "transform), transformId (a transform of the topic), answer (the rewritten sentence), acceptedAnswers and focus.",
    example: (features) =>
      languageOf(features) === "en"
        ? grounded(features, {
            exerciseType: "lesson_transform",
            instructionPl: "Zamień na przeczenie.",
            statement: "I read books.",
            transformId: "to_negative",
            answer: "I don't read books.",
            acceptedAnswers: [],
            focus: ["don't", "read"],
          }, "I don't read books.")
        : undefined,
  },
  lesson_open_answer: {
    summary:
      "The child writes the answer in their own words. Return instructionPl, prompt (the question or the sentence to " +
      "translate), answer (the model answer), acceptedAnswers and focus (the checked words of the answer).",
    example: (features) => {
      const language = languageOf(features);
      if (language === "en") {
        return grounded(features, {
          exerciseType: "lesson_open_answer",
          instructionPl: "Przetłumacz na angielski.",
          prompt: "Ona pływa w morzu.",
          answer: "She swims in the sea.",
          acceptedAnswers: [],
          focus: ["swims"],
        }, "She swims in the sea.");
      }
      if (language === "pl") {
        const record: Record<string, unknown> = {
          exerciseType: "lesson_open_answer",
          prompt: "Do jakiego morza uchodzi Wisła?",
          // Podpowiedź wskazuje miejsce w materiale, nie treść odpowiedzi (sędzia podpowiedzi).
          hint: "Poszukaj w materiale zdania o tym, dokąd płynie Wisła.",
          answer: "Wisła uchodzi do Morza Bałtyckiego.",
          acceptedAnswers: [],
          focus: ["Morza", "Bałtyckiego"],
          ...(features.usesV3Payload
            ? {
                questionType: "fact",
                requiredElements: [{ id: "e1", text: "Morze Bałtyckie" }],
                expectedForm: "one_sentence",
                familyId: PL_FAMILY,
              }
            : {}),
        };
        return grounded(features, record, PL_SEA);
      }
      return undefined;
    },
  },
  lesson_calculation: {
    summary:
      "A calculation by a method taught in the material. Return only exerciseType, objectiveId, calculation {kind, unit, " +
      "params, templateFamilyId} and the fields the subject requires; the code renders the prompt and computes the " +
      "answer, so never send answer, prompt, focus or acceptedAnswers.",
    example: (features) =>
      features.usesV3Payload && languageOf(features) === "pl"
        ? grounded(features, {
            exerciseType: "lesson_calculation",
            calculation: {
            kind: "scale_distance",
            unit: "km",
            params: { scaleDenominator: 50000, mapDistanceCm: 4 },
            templateFamilyId: "scale-distance-km",
            },
          }, PL_SCALE)
        : undefined,
  },
  lesson_keywords: {
    summary:
      "The child picks the key terms a precise answer to an open question uses. Return only exerciseType, objectiveId, " +
      "familyId (that of its lesson_open_answer), keywordOptions {id, text} (key terms and distractors from the material), " +
      "keyOptionIds (the key terms) and the fields the subject requires; the code computes the answer.",
    example: (features) =>
      features.usesV3Payload && languageOf(features) === "pl"
        ? grounded(features, {
            exerciseType: "lesson_keywords",
            familyId: PL_FAMILY,
            keywordOptions: [
            { id: "k1", text: "Wisła" },
            { id: "k2", text: "Morze Bałtyckie" },
            { id: "k3", text: "Tatry" },
            { id: "k4", text: "Odra" },
            ],
            keyOptionIds: ["k1", "k2"],
          }, PL_SEA)
        : undefined,
  },
  lesson_match: {
    summary:
      "The child connects left texts with right texts. Return only exerciseType, objectiveId, instructionPl, pairs " +
      "{left, right} and extraRight (right-side distractors), plus the fields the subject requires; the code computes the answer.",
    example: (features) => {
      const language = languageOf(features);
      if (language === "en") {
        return grounded(features, {
          exerciseType: "lesson_match",
          instructionPl: "Połącz słowa z ich znaczeniem.",
          pairs: [{ left: "bed", right: "łóżko" }, { left: "lamp", right: "lampa" }, { left: "chair", right: "krzesło" }],
          extraRight: ["stół"],
        }, "bed — łóżko");
      }
      if (language === "pl") {
        return grounded(features, {
          exerciseType: "lesson_match",
          instructionPl: "Połącz nazwy z tym, czym są.",
          pairs: [{ left: "Wisła", right: "rzeka" }, { left: "Tatry", right: "góry" }, { left: "Bałtyk", right: "morze" }],
          extraRight: ["pustynia"],
        }, PL_RIVER, PL_MOUNTAINS);
      }
      return undefined;
    },
  },
  lesson_group: {
    summary:
      "The child sorts items into groups. Return only exerciseType, objectiveId, instructionPl, groups {id, label} and " +
      "groupItems {text, groupId}, plus the fields the subject requires; the code computes the answer.",
    example: (features) => {
      const language = languageOf(features);
      if (language === "en") {
        return grounded(features, {
          exerciseType: "lesson_group",
          instructionPl: "Posortuj słowa.",
          groups: [{ id: "g1", label: "Pogoda" }, { id: "g2", label: "Pokój" }],
          groupItems: [
            { text: "sunny", groupId: "g1" },
            { text: "raining", groupId: "g1" },
            { text: "bed", groupId: "g2" },
            { text: "lamp", groupId: "g2" },
          ],
        }, "sunny — słonecznie");
      }
      if (language === "pl") {
        return grounded(features, {
          exerciseType: "lesson_group",
          instructionPl: "Posortuj nazwy.",
          groups: [{ id: "g1", label: "Rzeki" }, { id: "g2", label: "Góry" }],
          groupItems: [
            { text: "Wisła", groupId: "g1" },
            { text: "Odra", groupId: "g1" },
            { text: "Tatry", groupId: "g2" },
            { text: "Sudety", groupId: "g2" },
          ],
        }, PL_MOUNTAINS);
      }
      return undefined;
    },
  },
  lesson_cloze: {
    summary:
      "The child fills the gaps of a short text from a word bank. Return only exerciseType, objectiveId, instructionPl, " +
      "clozeText (gaps written as ___), gapAnswers (the word of each gap in text order) and extraWords (bank distractors), " +
      "plus the fields the subject requires; the code computes the answer.",
    example: (features) => {
      const language = languageOf(features);
      if (language === "en") {
        return grounded(features, {
          exerciseType: "lesson_cloze",
          instructionPl: instruction(features, "Pada deszcz, więc biorę parasol.", "Uzupełnij tekst."),
          clozeText: "It's ___ today. I take my ___.",
          gapAnswers: ["raining", "umbrella"],
          extraWords: ["sunny"],
        }, "raining — pada deszcz");
      }
      if (language === "pl") {
        return grounded(features, {
          exerciseType: "lesson_cloze",
          instructionPl: "Uzupełnij tekst.",
          clozeText: "Stolicą Polski jest ___. Przez stolicę płynie rzeka ___.",
          gapAnswers: ["Warszawa", "Wisła"],
          extraWords: ["Kraków"],
        }, PL_CAPITAL, PL_CAPITAL_RIVER);
      }
      return undefined;
    },
  },
  lesson_listen_choice: {
    summary:
      "The child hears the full sentence and picks the word for its gap. Return stem (the sentence with one gap ___), " +
      "options {id, text}, correctOption (the id of the correct option) and answer (its text); no instructionPl and no hint.",
    example: (features) =>
      languageOf(features) === "en"
        ? grounded(features, {
            exerciseType: "lesson_listen_choice",
            stem: "She ___ to school every day.",
            options: [{ id: "a", text: "goes" }, { id: "b", text: "go" }],
            correctOption: "a",
            answer: "goes",
            acceptedAnswers: [],
            focus: [],
          }, "She goes to school every day.")
        : undefined,
  },
};
