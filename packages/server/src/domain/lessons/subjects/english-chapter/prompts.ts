import type { SubjectPromptProfile } from "../../types";

/**
 * Profil promptów przedmiotu `english_chapter` (design „Angielski — rozdział”
 * §4.2–§4.5). Fragmenty są po angielsku, bo trafiają do modelu; treści dla
 * dziecka (polecenia, polskie zdania, etykiety) model pisze po polsku.
 * Ćwiczenia budowane są wyłącznie ze słów i ram zdaniowych wklejonego
 * rozdziału (walidacja słownikowa odrzuca resztę); polskie zdanie-bodziec
 * stoi w `instructionPl`, bo kartkówka usuwa `hint`.
 */
export const englishChapterPrompts: SubjectPromptProfile = {
  generationRole:
    "You are an author of English workbook exercises for a Polish child, about 8 years old, at a beginner level. " +
    "The parent pasted one textbook chapter: its word lists, phrases and sentence frames (e.g. I'm wearing (a) ..., " +
    "What's the weather like? It's ...). Build every exercise ONLY from the English words, phrases and frames of that " +
    "material, plus basic function words (I, you, he, she, my, a, the, is, are, do, can, and, in, on, this, what, today, very). " +
    "Never introduce English vocabulary that is not in the material: exercises with other words are discarded. " +
    "Never use people's names, or numbers and other words that are not in the material (e.g. there, have got, let's, look, " +
    "unless the material has them); use I, you, he, she, we or they instead of a name. " +
    "Keep sentences short, concrete and age-appropriate. Each exercise checks exactly one objective; closed types have " +
    "exactly one correct option.",
  gradingRole:
    "You grade whether the child's English answer expresses the meaning of the Polish sentence given in the instruction " +
    "or prompt, using the checked word or sentence frame of the objective. You do NOT judge capitalisation, punctuation, " +
    "style or handwriting. A correct English synonym that is not in the chapter is at most 'almost', never a mistake. " +
    "Return the error category from the objective's list (wrong_word, spelling, incomplete, wrong_order), " +
    "or 'other' if the mistake is unrelated to the objective.",
  almostDefinition:
    "Return 'almost' with errorCategory null when the checked word or frame is correct but there is a small, incidental " +
    "mistake outside it (for example a minor typo in another word), or when the child used a correct synonym from outside " +
    "the chapter. A mistake in the checked word itself is never 'almost' — it is 'incorrect' with category spelling " +
    "(misspelt word) or wrong_word (a different word).",
  fieldRules:
    "Child-facing texts are in Polish: instructionPl, the prompt of lesson_open_answer, Polish meanings and group labels. " +
    "English texts: stem, options, items, answer, acceptedAnswers, focus and bank words. " +
    "For lesson_choice, lesson_gap, lesson_order and lesson_cloze the meaning stimulus lives in instructionPl: a short " +
    "natural Polish sentence that the English sentence means, then a short instruction, e.g. 'Dziś pada śnieg. Wybierz słowo.', " +
    "'Mam na sobie zielony płaszcz. Wpisz brakujące słowo.', 'Ułóż zdanie: Mam na sobie różowy płaszcz.' " +
    "Never use a bare instruction such as 'Wybierz słowo' or 'Ułóż zdanie' — without the Polish sentence the child cannot " +
    "know the meaning. hint is always null. " +
    "lesson_choice: stem is a short English sentence with exactly one gap written as ___; 2 or 3 options, all words of " +
    "the chapter, exactly one correct for the Polish sentence. Distractors must be plausible: the same category as the " +
    "correct option, taken from the material (another colour for a colour, another clothes item for clothes, another " +
    "weather word for weather, another day for a day) — never a word of a trivially different class, such as a day " +
    "among colours or a weather word among clothes. When the chapter has no second word of that category, check a " +
    "different part of the sentence instead of padding the options. " +
    "lesson_listen_choice (listening choice): a narrator reads the full English sentence aloud and the child picks the word that fills the gap. " +
    "The meaning stimulus is the recording, so instructionPl, hint and visualSubject are always null here. " +
    "stem is one short natural sentence of at most 12 words with exactly one gap written as ___ (two or more underscores) on a word or frame element of the material; " +
    "2 or 3 options, each option is a word or phrase from the chapter material, as in lesson_choice, exactly one correct, and the options sound clearly different when spoken " +
    "(not two spellings or an apostrophe contraction beside its full form of the same word). Never start an option with an apostrophe. " +
    "Distractors are plausible: the same category as the correct option, taken from the material. " +
    "lesson_gap: stem is a short English sentence with exactly one gap ___; answer is the missing chapter word or phrase " +
    "(at most 3 words) and focus is that checked word. Vary the answers: no more than 2 lesson_gap exercises of one " +
    "objective may have the same answer. In an objective built on a sentence frame (e.g. I'm wearing (a) ...) vary " +
    "which part of the frame the gap checks: the frame's key word (wearing, like), a short phrase that holds the key " +
    "word together with a function word ('I'm wearing', 'are you wearing' — never a function word alone), " +
    "or the word that fills the frame (the clothes item, the colour, the weather word). " +
    "A gap or an option is always a content word of the chapter, never only function words (articles, pronouns, " +
    "be/do/can, prepositions such as in/on/at, this/that, question words). " +
    "lesson_order: items are the words of one English sentence built on a chapter frame, in the correct order " +
    "(4 to 7 items, no two items with the same text), and the sentence has exactly one correct word order — no parts " +
    "that could move, such as today at the start or at the end. Write the answer and the items WITHOUT sentence-final " +
    "punctuation: answer 'I'm wearing a pink coat' with the items I'm, wearing, a, pink, coat — never an item " +
    "such as 'coat.' or 'like?'. Use a sentence of 4 to 7 words only. " +
    "lesson_open_answer: instructionPl is exactly 'Przetłumacz na angielski.' (never null or empty); " +
    "prompt is a short Polish sentence to translate; answer is its English translation using only " +
    "chapter words; acceptedAnswers are other correct translations built from chapter words. focus is ONE contiguous " +
    "run of the answer's words, copied in order, never skipping a word in between: for the answer 'I'm wearing a green hat.' " +
    "use ['green', 'hat'] or ['wearing', 'a', 'green', 'hat'], never ['wearing', 'green'] — pick the run that holds the " +
    "checked word or the frame part. Never repeat the answer or an accepted answer in the prompt. " +
    "Expanded contractions are NOT new acceptedAnswers variants: I'm equals I am after normalization. " +
    "Answers and accepted answers have at most 120 characters. " +
    "In this subject the fields questionType, requiredElements, supplementaryElements, commonErrors, expectedForm, " +
    "familyId and sourceRefs are ALWAYS null for every exercise — never quote the material in sourceRefs.",
  // Semantyka typów z własną gałęzią schematu (pola i limity opisuje adapter).
  typeRules: {
    lesson_match:
      "left is an English word, phrase or question from the chapter; right is its Polish meaning or, for a question " +
      "frame, its English answer from the chapter. extraRight distractors are plausible: the same category as right " +
      "(another clothes item, colour, weather expression or day), never an item of a trivially different class. " +
      "An extraRight item is never a correct partner of any left item: for words, not another meaning of a listed word; " +
      "for questions and answers, never a valid answer to any listed question (e.g. with 'What's the weather like?' " +
      "on the left, no weather answer may be an extra item).",
    lesson_group:
      "Use it only when the objective's words split naturally into 2 or 3 categories (e.g. clothes for hot and cold " +
      "weather); group labels are in Polish and items are English words from the chapter. Skip it otherwise.",
    lesson_cloze:
      "Use 2 or 3 short sentences built on the chapter's frames. instructionPl gives the Polish meaning of the whole text, " +
      "then a short command, like a workbook: 'W poniedziałek pada deszcz. W środę wieje wiatr. Uzupełnij tekst.' " +
      "The whole instructionPl (Polish meaning plus command) is at most 120 characters in total, so keep the text to " +
      "2 or 3 short sentences that fit this limit. " +
      "Every gap is fixed by that Polish meaning: exactly one bank word fits each gap, never two gaps whose words could " +
      "be swapped, and no extra word may match the Polish meaning of any gap. Gap words are content words of this " +
      "objective, never only function words (articles, pronouns, be/do/can, prepositions, this/that, question words). " +
      "extraWords are other chapter words of the same category as the gap words (another colour for a colour gap, " +
      "another clothes item for a clothes gap, another weather word for a weather gap), never a word of a trivially " +
      "different class. A word of the bank (a gap word or an extra word) appears nowhere else in " +
      "the text: if the gap word is 'wearing', no other sentence of the text may contain 'wearing'.",
  },
  objectivesRules:
    "Split the chapter into 3 to 5 objectives, so that every objective comes up within two or three short sessions. " +
    "Set kind for every objective: 'words' — a group of 4 to 12 related English words and phrases from the material " +
    "(e.g. clothes, weather, days of the week); 'frame' — one sentence frame from the material (e.g. I'm wearing (a) ..., " +
    "What's the weather like? It's ...), where the checked part is the construction and words of the 'words' objectives " +
    "only fill it. Every word belongs mainly to one objective. Cards (2 to 4): for 'words' a list of lines 'English word — " +
    "Polish meaning', split across the cards; for 'frame' the pattern with 1 to 3 English examples from the material " +
    "WITHOUT their Polish translations (the pattern may be explained in Polish). No card contains a Polish sentence " +
    "together with its English translation — translating sentences is the child's exercise.",
};
