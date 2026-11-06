import { describe, expect, it } from "vitest";
import type { LessonExerciseDraft } from "../../types";
import { solverView } from "../../agent/solver";
import { validatePool } from "../../pool-validation";
import { englishGrammarSubject } from "./module";
import { ERROR_FIX_KINDS } from "./present-continuous-exercise-rules";
import { TENSE_CHOICE_OBJECTIVES } from "./present-continuous-tense-choice";
import {
  BE_GAP_OBJECTIVES,
  NEGATED_VERB_GAP_OBJECTIVES,
  PC_ALLOWED_ING_RULES,
  PC_FORM_OBJECTIVES,
  PC_POLARITY,
  stripGapVerb,
} from "./present-continuous-validation";
import { presentContinuousV1 } from "./topics/present-continuous";
import { validateEnglishGrammarExercise } from "./validators";

type Objective = "affirmative" | "now_or_usually" | "negative" | "questions" | "ing_spelling" | "now_or_usually_more";

/** Szkic luki tematu Present Continuous (jak `contextualGap` w `validators.test.ts`). */
function pcGap(objective: Objective, stem: string, answer: string, extra: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_gap",
    objectiveId: `english_grammar.present_continuous.${objective}`,
    stem,
    answer,
    acceptedAnswers: [],
    focus: answer.split(" "),
    ...extra,
  };
}

/** Id reguł zgłoszonych przez walidator przedmiotu w temacie Present Continuous (pusta lista = poprawne). */
function validate(ex: LessonExerciseDraft): string[] {
  return validateEnglishGrammarExercise(ex, presentContinuousV1).map((issue) => issue.rule);
}

function expectRule(ex: LessonExerciseDraft, rule: string): void {
  expect(validate(ex)).toContain(rule);
}

describe("stripGapVerb", () => {
  it("usuwa nawias tuż po luce i zwraca czasownik oraz „not”", () => {
    expect(stripGapVerb("He ___ (play) football now.")).toEqual({ stem: "He ___ football now.", verb: "play", negative: false });
    expect(stripGapVerb("She ___ (not watch) TV now.")).toEqual({ stem: "She ___ TV now.", verb: "watch", negative: true });
    expect(stripGapVerb("___ she reading?")).toEqual({ stem: "___ she reading?", negative: false });
    expect(stripGapVerb("He ___ football (play) now.")).toEqual({ stem: "He ___ football (play) now.", negative: false });
  });
});

describe("validatePresentContinuousExercise — luka, poprawne", () => {
  const ok: [Objective, string, string][] = [
    ["affirmative", "He ___ (play) football now.", "is playing"],
    ["affirmative", "Łucja ___ (read) now.", "is reading"],
    ["affirmative", "The children ___ (play) now.", "are playing"],
    ["affirmative", "Tom and Ola ___ (jump) now.", "are jumping"],
    ["affirmative", "James ___ (read) now.", "is reading"],
    ["negative", "She ___ (not watch) TV right now.", "isn't watching"],
    ["negative", "She ___ (not watch) TV at the moment.", "is not watching"],
    ["questions", "___ she reading a book?", "Is"],
    ["questions", "What ___ they doing?", "are"],
    ["questions", "Is she reading? Yes, she ___.", "is"],
    ["questions", "___ Ola reading a book?", "Is"],
    ["questions", "___ the dogs running?", "Are"],
    ["questions", "What ___ Ola doing?", "is"],
    ["questions", "___ Tom and Ola playing?", "Are"],
    ["questions", "___ the boy and the girl playing?", "Are"],
    ["questions", "What ___ your mum and dad doing?", "are"],
    ["questions", "___ your mum and dad cooking?", "Are"],
    ["questions", "What ___ the cat and the dog doing?", "are"],
    ["ing_spelling", "He ___ (swim) now.", "is swimming"],
    ["affirmative", "She ___ (have) lunch now.", "is having"],
    ["affirmative", "He ___ (look) at the stars now.", "is looking"],
    ["affirmative", "They ___ playing now.", "are"],
    ["negative", "Is she sleeping? No, she ___.", "isn't"],
    ["affirmative", "The cat and the dog ___ (sleep) now.", "are sleeping"],
    ["affirmative", "Tom and his sister ___ (play) now.", "are playing"],
    ["affirmative", "Look! The cat and the dog ___ (sleep).", "are sleeping"],
    ["affirmative", "Mum is cooking and Dad ___ (read) now.", "is reading"],
  ];
  it.each(ok)("%s: „%s” → „%s”", (objective, stem, answer) => {
    expect(validate(pcGap(objective, stem, answer))).toEqual([]);
  });

  it("wariant odpowiedzi sprawdzany jak odpowiedź", () => {
    expect(validate(pcGap("negative", "Look! She ___ (not watch) TV.", "isn't watching", { acceptedAnswers: ["is not watching"] }))).toEqual([]);
    expectRule(pcGap("affirmative", "He ___ (play) now.", "is playing", { acceptedAnswers: ["are playing"] }), "grammar.pc_be_form_subject");
  });
});

describe("validatePresentContinuousExercise — luka, odrzucone", () => {
  it("forma be niezgodna z podmiotem", () => {
    expectRule(pcGap("affirmative", "He ___ (play) now.", "are playing"), "grammar.pc_be_form_subject");
    expectRule(pcGap("questions", "___ Ola reading a book?", "Are"), "grammar.pc_be_form_subject");
    expectRule(pcGap("questions", "___ the dogs running?", "Is"), "grammar.pc_be_form_subject");
    expectRule(pcGap("questions", "What ___ Ola doing?", "are"), "grammar.pc_be_form_subject");
    expectRule(pcGap("questions", "___ Tom and Ola playing?", "Is"), "grammar.pc_be_form_subject");
    expectRule(pcGap("questions", "___ your mum and dad cooking?", "Is"), "grammar.pc_be_form_subject");
    expectRule(pcGap("questions", "What ___ the cat and the dog doing?", "is"), "grammar.pc_be_form_subject");
    expectRule(pcGap("affirmative", "The cat and the dog ___ (sleep) now.", "is sleeping"), "grammar.pc_be_form_subject");
    expectRule(pcGap("affirmative", "Ola and her mum ___ (cook) now.", "is cooking"), "grammar.pc_be_form_subject");
  });

  it("brak formy -ing albo zła forma", () => {
    expectRule(pcGap("affirmative", "He ___ (play) now.", "is play"), "grammar.pc_ing_wrong_form");
  });

  it("niepusty hint w luce; w innych typach bez reguły tematu", () => {
    expectRule(pcGap("affirmative", "He ___ (play) now.", "is playing", { hint: "play" }), "grammar.pc_gap_hint");
    const openAnswer: LessonExerciseDraft = {
      exerciseType: "lesson_open_answer",
      objectiveId: "english_grammar.present_continuous.affirmative",
      prompt: "Tata teraz gotuje obiad.",
      hint: "play",
      answer: "Dad is cooking dinner now.",
      acceptedAnswers: ["Dad is cooking dinner right now.", "Dad is cooking dinner at the moment."],
      focus: ["is", "cooking"],
    };
    expect(validate(openAnswer)).toEqual([]);
  });

  it("luka z czasownikiem bez nawiasu", () => {
    expectRule(pcGap("affirmative", "He ___ now.", "is playing"), "grammar.pc_gap_shape");
  });

  it("nawias dalej w zdaniu", () => {
    expectError(pcGap("affirmative", "He ___ football (play) now.", "is playing"), "grammar.pc_bracket_outside_gap", "stem: nawias jest dozwolony tylko tuż po luce");
  });

  it("nawias w bodźcu wyboru i „posłuchaj i wybierz”", () => {
    const options = [{ id: "a", text: "is playing" }, { id: "b", text: "are playing" }];
    expectRule({ ...pcGap("affirmative", "He ___ (play) now.", "is playing"), exerciseType: "lesson_choice", options, correctOption: "a" }, "grammar.pc_bracket_outside_gap");
    expectRule({
      ...pcGap("affirmative", "He ___ (play) now.", "is"),
      exerciseType: "lesson_listen_choice",
      options: [{ id: "a", text: "is" }, { id: "b", text: "are" }],
      correctOption: "a",
    }, "grammar.pc_bracket_outside_gap");
  });

  it("klasa formy -ing spoza celu", () => {
    expectRule(pcGap("affirmative", "He ___ (swim) now.", "is swimming"), "grammar.pc_ing_rule_not_allowed");
    expectRule(pcGap("ing_spelling", "He ___ (play) now.", "is playing"), "grammar.pc_ing_rule_not_allowed");
  });

  it("nawias z „not” wymagany w celu 3, zakazany w celu 1", () => {
    expectRule(pcGap("negative", "She ___ (watch) TV now.", "isn't watching"), "grammar.pc_gap_bracket_objective");
    expectRule(pcGap("affirmative", "He ___ (not play) now.", "isn't playing"), "grammar.pc_gap_bracket_objective");
  });

  it("luka na formę be w celu 5", () => {
    expectRule(pcGap("ing_spelling", "He ___ swimming now.", "is"), "grammar.pc_be_gap_objective");
  });

  it("odpowiedź zaczynająca się apostrofem", () => {
    expectRule(pcGap("affirmative", "I ___ (play) now.", "'m playing"), "grammar.pc_leading_apostrophe");
  });

  it("luka z czasownikiem obejmuje całą formę — be albo do/does przed luką w tym samym zdaniu", () => {
    expectRule(pcGap("questions", "Is she ___ (read) a book?", "is reading"), "grammar.pc_verb_gap_whole_form");
    expectRule(pcGap("affirmative", "She is ___ (play) now.", "is playing"), "grammar.pc_verb_gap_whole_form");
    expectRule(pcGap("negative", "She isn't ___ (not watch) TV now.", "isn't watching"), "grammar.pc_verb_gap_whole_form");
    expectRule(pcGap("now_or_usually_more", "She doesn't ___ (not watch) TV every morning.", "doesn't watch"), "grammar.pc_verb_gap_whole_form");
    expectRule(pcGap("affirmative", "I'm ___ (play) now.", "am playing"), "grammar.pc_verb_gap_whole_form");
    expectRule(pcGap("affirmative", "Look! Mum is cooking and Dad is ___ (read).", "is reading"), "grammar.pc_verb_gap_whole_form");
  });

  it("skrót what's / where's i pełne „is” w pytaniu przed luką z czasownikiem", () => {
    expectRule(pcGap("questions", "What's Ola ___ (do)?", "is doing"), "grammar.pc_verb_gap_whole_form");
    expectRule(pcGap("questions", "Where's Tom ___ (go)?", "is going"), "grammar.pc_verb_gap_whole_form");
    expectRule(pcGap("questions", "What is Ola ___ (do)?", "is doing"), "grammar.pc_verb_gap_whole_form");
  });

  it("forma be w poprzednim zdaniu albo zdaniu składowym nie blokuje luki z czasownikiem", () => {
    expect(validate(pcGap("affirmative", "Mum is cooking and Dad ___ (read) now.", "is reading"))).toEqual([]);
    expect(validate(pcGap("affirmative", "Look! Mum is cooking. Dad ___ (read) now.", "is reading"))).toEqual([]);
    expect(validate(pcGap("affirmative", "Mum does the cooking and Tom ___ (read) now.", "is reading"))).toEqual([]);
    expect(validate(pcGap("affirmative", "This is Ola. She ___ (read) now.", "is reading"))).toEqual([]);
    expect(validate(pcGap("affirmative", "Ola's mum ___ (read) now.", "is reading"))).toEqual([]);
    expect(validate(pcGap("now_or_usually", "Every day Ola ___ (read) a comic.", "reads"))).toEqual([]);
  });

  it("wskaźnik zakazany", () => {
    expectRule(pcGap("affirmative", "He ___ (play) tennis tomorrow.", "is playing"), "grammar.pc_forbidden_marker");
    expectRule(pcGap("affirmative", "He ___ (play) tennis now.", "is playing", { instructionPl: "Jutro mecz." }), "grammar.pc_forbidden_marker");
  });

  it("czasownik stanu w formie -ing i „being”", () => {
    expectRule(pcGap("affirmative", "She ___ (like) it now.", "is liking"), "grammar.pc_state_verb_ing");
    expectRule(pcGap("affirmative", "He ___ (be) silly now.", "is being"), "grammar.pc_being");
    expectRule(pcGap("affirmative", "She ___ (have) a cat now.", "is having"), "grammar.pc_state_verb_ing");
  });

  it("kolokacja „having” nie jest dozwolona w celu 5", () => {
    expectRule(pcGap("ing_spelling", "She ___ (have) lunch now.", "is having"), "grammar.pc_verb_outside_table");
  });

  it("czasownik spoza tabeli", () => {
    expectRule(pcGap("affirmative", "The plant ___ (photosynthesise) now.", "is photosynthesising"), "grammar.pc_verb_outside_table");
  });

  it("biegunowość celu twierdzącego i przeczącego", () => {
    expectRule(pcGap("negative", "She ___ sleeping now.", "is"), "grammar.pc_be_missing_negation");
    expectRule(pcGap("affirmative", "They ___ playing now.", "aren't"), "grammar.pc_be_gap_negative_without_no");
    expectRule(pcGap("questions", "Is she reading? No, she ___.", "is"), "grammar.pc_be_no_affirmative");
  });

  it("przeczenie w luce na formę be tylko w celu 3 albo po „No”, bez podwójnego „not”", () => {
    expectRule(pcGap("questions", "___ she reading a book?", "Isn't"), "grammar.pc_be_gap_negative_without_no");
    expectRule(pcGap("questions", "She ___ reading now.", "isn't"), "grammar.pc_be_gap_negative_without_no");
    expectRule(pcGap("negative", "She ___ not sleeping now.", "isn't"), "grammar.pc_be_gap_double_negation");
    expect(validate(pcGap("questions", "Is she reading? No, she ___.", "isn't"))).toEqual([]);
    expect(validate(pcGap("negative", "She ___ not sleeping now.", "is"))).toEqual([]);
  });
});

/** Szkic ćwiczenia z całym zdaniem tematu Present Continuous. */
function pcSentence(
  exerciseType: LessonExerciseDraft["exerciseType"],
  objective: Objective,
  answer: string,
  extra: Partial<LessonExerciseDraft> = {},
): LessonExerciseDraft {
  return {
    exerciseType,
    objectiveId: `english_grammar.present_continuous.${objective}`,
    answer,
    acceptedAnswers: [],
    focus: [],
    ...extra,
  };
}

function pcChoice(objective: Objective, stem: string, correct: string, wrong: string): LessonExerciseDraft {
  return pcSentence("lesson_choice", objective, correct, {
    stem,
    options: [{ id: "a", text: correct }, { id: "b", text: wrong }],
    correctOption: "a",
  });
}

function pcOrder(objective: Objective, answer: string): LessonExerciseDraft {
  const words = answer.split(" ");
  return pcSentence("lesson_order", objective, answer, { items: words.map((text, index) => ({ id: `w${index}`, text })) });
}

function pcTransform(objective: Objective, transformId: string, statement: string, answer: string): LessonExerciseDraft {
  return pcSentence("lesson_transform", objective, answer, { statement, transformId });
}

const NOW_PHRASES = ["right now", "at the moment", "now"];

/** Warianty klucza z dwoma pozostałymi wskaźnikami „teraz” (`grammar.pc_translation_now_variants`); bez nich przy wykrzyknieniu. */
function nowVariants(answer: string): string[] {
  const used = answer.includes("!") ? undefined : NOW_PHRASES.find((phrase) => new RegExp(String.raw`\b${phrase}\b`).test(answer));
  return used === undefined ? [] : NOW_PHRASES.filter((phrase) => phrase !== used).map((phrase) => answer.replace(used, phrase));
}

/** Tłumaczenie; klucz z now / right now / at the moment dostaje domyślnie warianty z pozostałymi dwoma. */
function pcTranslation(objective: Objective, prompt: string, answer: string, acceptedAnswers = nowVariants(answer)): LessonExerciseDraft {
  return pcSentence("lesson_open_answer", objective, answer, { prompt, acceptedAnswers });
}

function pcShortAnswer(prompt: string, correct: string, wrong: string): LessonExerciseDraft {
  return pcSentence("lesson_short_answer", "questions", correct, {
    prompt,
    options: [{ id: "a", text: correct }, { id: "b", text: wrong }],
    correctOption: "a",
  });
}

describe("validatePresentContinuousExercise — całe zdania, poprawne", () => {
  const ok: [string, LessonExerciseDraft][] = [
    ["wybór w celu 1", pcChoice("affirmative", "Look! Mum ___ dinner.", "is cooking", "are cooking")],
    ["kolejność w celu 4 (What … doing?)", pcOrder("questions", "What is he doing?")],
    ["krótka odpowiedź w celu 4", pcShortAnswer("Is she reading?", "Yes, she is.", "Yes, she does.")],
    ["przekształcenie na przeczenie w celu 3", pcTransform("negative", "to_negative", "He is playing right now.", "He isn't playing right now.")],
    ["przekształcenie na pytanie w celu 4", pcTransform("questions", "to_question", "He is playing now.", "Is he playing now?")],
    ["tłumaczenie w celu 1", pcTranslation("affirmative", "Tata teraz gotuje obiad.", "Dad is cooking dinner now.")],
    ["pytanie z imieniem", pcOrder("questions", "Is Ola reading?")],
    ["pytanie z przeczeniem ze skrótem", pcOrder("questions", "Aren't they playing?")],
    ["pytanie z przeczeniem i imieniem", pcOrder("questions", "Isn't Ola reading?")],
    ["What + podmiot w liczbie mnogiej + doing", pcOrder("questions", "What are the children doing?")],
    ["dwa zdania z różnymi podmiotami", pcTranslation("affirmative", "Teraz mama gotuje, a tata czyta.", "Mum is cooking and Dad is reading now.")],
    ["podmiot złożony w drugim zdaniu", pcTranslation("affirmative", "Teraz mama gotuje, a Tom i Ola grają.", "Mum is cooking and Tom and Ola are playing now.")],
    ["kolokacja „having lunch”", pcTranslation("affirmative", "Ona teraz je obiad.", "She is having lunch now.")],
    ["pisownia w celu 5", pcTranslation("ing_spelling", "On teraz pływa.", "He is swimming now.")],
    ["„What … doing?” z odpowiedzią pełnym zdaniem", pcShortAnswer("What are you doing?", "I am reading a book.", "I reading a book.")],
    ["krótka odpowiedź z luką po „No”", pcShortAnswer("Is she reading? No, she ___.", "isn't", "is")],
    ["wybór formy be przy -ing z bodźca (klasa sprawdzana tylko w kluczu)", pcChoice("affirmative", "The dogs ___ running now.", "are", "is")],
    ["wybór Is/Are przy imieniu", pcChoice("questions", "___ Ola reading a book?", "Is", "Are")],
    ["podmiot złożony z określnikami", pcTranslation("affirmative", "Kot i pies teraz śpią.", "The cat and the dog are sleeping now.")],
    ["podmiot złożony z zaimkiem dzierżawczym", pcTranslation("affirmative", "Tom i jego siostra teraz grają.", "Tom and his sister are playing now.")],
    ["podmiot złożony „The boy and the girl”", pcOrder("affirmative", "The boy and the girl are playing.")],
    ["podmiot złożony „Ola and her mum”", pcOrder("affirmative", "Ola and her mum are cooking.")],
    ["podmiot złożony „She and her friend”", pcOrder("affirmative", "She and her friend are playing.")],
    ["podmiot złożony po „Look!”", pcTranslation("affirmative", "Patrz! Kot i pies śpią.", "Look! The cat and the dog are sleeping.")],
    ["wybór z podmiotem złożonym", pcChoice("affirmative", "The cat and the dog ___ now.", "are sleeping", "is sleeping")],
    ["wybór formy be bez dwuznaczności", pcSentence("lesson_choice", "questions", "Is", {
      stem: "___ she reading a book?",
      options: [{ id: "a", text: "Is" }, { id: "b", text: "Are" }, { id: "c", text: "Am" }],
      correctOption: "a",
    })],
    ["wybór po „No” z dystraktorem innej osoby", pcChoice("questions", "Is she reading? No, she ___.", "isn't", "aren't")],
    ["czasownik pogody", pcOrder("questions", "Is it raining?")],
    ["czasownik pogody w wyborze", pcChoice("questions", "___ it snowing now?", "Is", "Are")],
  ];
  it.each(ok)("%s", (_name, ex) => {
    expect(validate(ex)).toEqual([]);
  });
});

describe("validatePresentContinuousExercise — całe zdania, odrzucone", () => {
  const rejected: [string, LessonExerciseDraft, string][] = [
    ["klucz z „He's”", pcTranslation("affirmative", "On teraz gra.", "He's playing now."), "grammar.pc_s_contraction"],
    ["klucz z „What's”", pcOrder("questions", "What's he doing?"), "grammar.pc_s_contraction"],
    ["pytanie z „Where”", pcOrder("questions", "Where is he going?"), "grammar.pc_wh_question"],
    ["„What” bez „doing”", pcOrder("questions", "What is he eating?"), "grammar.pc_wh_question"],
    ["pytanie z „Where” w bodźcu krótkiej odpowiedzi", pcShortAnswer("Where is he going?", "He is going to school.", "He going to school."), "grammar.pc_wh_question"],
    ["hybryda „is plays”", pcTranslation("affirmative", "Ona teraz gra.", "She is plays now."), "grammar.pc_ing_after_be"],
    ["forma bez -ing „is play”", pcOrder("affirmative", "She is play now."), "grammar.pc_ing_after_be"],
    ["czasownik drop_e w celu 1", pcTranslation("affirmative", "On teraz pisze.", "He is writing now."), "grammar.pc_ing_rule_not_allowed"],
    ["czasownik plain w celu 5", pcTranslation("ing_spelling", "On teraz gra.", "He is playing now."), "grammar.pc_ing_rule_not_allowed"],
    ["„They is”", pcTranslation("affirmative", "Oni teraz grają.", "They is playing now."), "grammar.pc_be_form_subject"],
    ["„The dogs is”", pcTranslation("affirmative", "Psy teraz biegają.", "The dogs is running now."), "grammar.pc_be_form_subject"],
    ["„Are Ola”", pcOrder("questions", "Are Ola reading?"), "grammar.pc_be_form_subject"],
    ["„Isn't they”", pcOrder("questions", "Isn't they playing?"), "grammar.pc_be_form_subject"],
    ["brak formy be", pcTranslation("affirmative", "On teraz gra.", "He playing now."), "grammar.pc_sentence_be_missing"],
    ["to_negative z odpowiedzią twierdzącą", pcTransform("negative", "to_negative", "He is playing now.", "He is playing now!"), "grammar.pc_be_missing_negation"],
    ["przeczenie w celu 1", pcOrder("affirmative", "He isn't playing now."), "grammar.pc_be_negated"],
    ["„Yes” z przeczeniem", pcShortAnswer("Is she reading?", "Yes, she isn't.", "No, she is."), "grammar.pc_be_yes_negative"],
    ["osoba krótkiej odpowiedzi niezgodna z pytaniem", pcShortAnswer("Is she reading?", "Yes, he is.", "No, she isn't."), "grammar.pc_short_answer_person"],
    ["tłumaczenie bez wskaźnika", pcTranslation("affirmative", "Tata gotuje obiad.", "Dad is cooking dinner now."), "grammar.pc_translation_now_marker"],
    ["tłumaczenie ze wskaźnikiem „zwykle”", pcTranslation("affirmative", "Tata teraz zawsze gotuje obiad.", "Dad is cooking dinner now."), "grammar.pc_translation_now_marker"],
    ["wybór z kluczem z czasownikiem stanu", pcChoice("affirmative", "___", "I am liking it now.", "I like it now."), "grammar.pc_state_verb_ing"],
    ["wybór z formą be niezgodną z podmiotem", pcChoice("affirmative", "The dogs ___ now.", "is running", "are running"), "grammar.pc_be_form_subject"],
    ["„The cat and the dog is”", pcOrder("affirmative", "The cat and the dog is sleeping now."), "grammar.pc_be_form_subject"],
    ["„Tom and his sister is”", pcTranslation("affirmative", "Tom i jego siostra teraz grają.", "Tom and his sister is playing now."), "grammar.pc_be_form_subject"],
    ["klucz z „Where's”", pcOrder("questions", "Where's he going?"), "grammar.pc_s_contraction"],
    ["klucz z „Who's”", pcOrder("questions", "Who's playing now?"), "grammar.pc_s_contraction"],
    ["wybór: klucz „Isn't” w celu 4 (twierdzenie też pasuje)", pcChoice("questions", "___ she reading a book?", "Isn't", "Is"), "grammar.pc_be_gap_negative_without_no"],
    ["wybór: dystraktor „Isn't” do klucza „Is” (dwie poprawne)", pcChoice("questions", "___ she reading a book?", "Is", "Isn't"), "grammar.pc_be_choice_polarity_distractor"],
    ["wybór: podwójne przeczenie w celu 3", pcChoice("negative", "She ___ not sleeping now.", "isn't", "is"), "grammar.pc_be_gap_double_negation"],
  ];
  it.each(rejected)("%s", (_name, ex, rule) => {
    expectRule(ex, rule);
  });

  it("wariant odpowiedzi z „there's”", () => {
    expectRule({ ...pcTranslation("affirmative", "Teraz pies biega.", "A dog is running now."), acceptedAnswers: ["There's a dog running now."] }, "grammar.pc_s_contraction");
  });

  it("czasownik stanu w kluczu wyboru daje tylko regułę czasownika stanu", () => {
    const errors = validate(pcChoice("affirmative", "___", "I am liking it now.", "I like it now."));
    expect(errors).toEqual(["grammar.pc_state_verb_ing"]);
  });
});

/** Wybór „now / usually” (§5.5): bodziec bez wskaźnika, klucz z czasu zdania. */
function pcNowUsually(stem: string, key: "now" | "usually", extra: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return pcSentence("lesson_choice", "now_or_usually", key, {
    instructionPl: "Kiedy to się dzieje?",
    stem,
    options: [{ id: "a", text: key }, { id: "b", text: key === "now" ? "usually" : "now" }],
    correctOption: "a",
    ...extra,
  });
}

function pcErrorFix(objective: Objective, statement: string, answer: string): LessonExerciseDraft {
  return pcSentence("lesson_error_fix", objective, answer, { statement });
}

describe("validatePresentContinuousExercise — cele porównania (2 i 6), poprawne", () => {
  const ok: [string, LessonExerciseDraft][] = [
    ["cel 2: luka ze wskaźnikiem „zwykle”", pcGap("now_or_usually", "Ola ___ (read) a comic every evening.", "reads")],
    ["cel 2: luka po „Look!”", pcGap("now_or_usually", "Look! Ola ___ (read) a comic.", "is reading")],
    ["cel 2: okolicznik na początku zdania", pcGap("now_or_usually", "Every day Ola ___ (read) a comic.", "reads")],
    ["cel 2: podmiot złożony w Present Simple", pcGap("now_or_usually", "Every evening Mum and Dad ___ (watch) TV.", "watch")],
    ["cel 2: podmiot „Tom and Ola”", pcGap("now_or_usually", "Tom and Ola ___ (play) football every day.", "play")],
    ["cel 2: drugie zdanie składowe po Present Simple", pcGap("now_or_usually", "Mum cooks dinner and Dad ___ (read) every evening.", "reads")],
    ["cel 2: wybór na scence z polecenia", pcSentence("lesson_choice", "now_or_usually", "is sleeping", {
      instructionPl: "Cicho! Dziadek śpi.",
      stem: "Grandpa ___ in the armchair.",
      options: [{ id: "a", text: "sleeps" }, { id: "b", text: "is sleeping" }],
      correctOption: "b",
    })],
    ["cel 2: „now / usually” do zdania w Present Continuous", pcNowUsually("Ola is reading a book.", "now")],
    ["cel 2: „now / usually” do zdania w Present Simple", pcNowUsually("Ola reads books.", "usually")],
    ["cel 2: „now / usually” z poleceniem „Teraz czy zwykle?”", pcNowUsually("Ola reads books.", "usually", { instructionPl: "Teraz czy zwykle?" })],
    ["cel 2: kolokacja „having lunch”", pcTranslation("now_or_usually", "Ona w tej chwili je obiad.", "She is having lunch at the moment.")],
    ["cel 2: tłumaczenie w Present Simple", pcTranslation("now_or_usually", "Tata codziennie gotuje obiad.", "Dad cooks dinner every day.")],
    ["cel 2: poprawianie Present Simple na Present Continuous", pcErrorFix("now_or_usually", "Look! Ola reads.", "Look! Ola is reading.")],
    ["cel 2: poprawianie Present Continuous na Present Simple", pcErrorFix("now_or_usually", "Ola is reading every day.", "Ola reads every day.")],
    ["cel 6: poprawianie przeczenia", pcErrorFix("now_or_usually_more", "She isn't watching TV every morning.", "She doesn't watch TV every morning.")],
    ["cel 6: luka z przeczeniem w Present Simple", pcGap("now_or_usually_more", "She ___ (not watch) TV every morning.", "doesn't watch")],
    ["cel 6: luka z przeczeniem w Present Continuous", pcGap("now_or_usually_more", "She ___ (not watch) TV right now.", "isn't watching")],
    ["cel 6: „am not” i klasa double", pcGap("now_or_usually_more", "Look! I ___ (not swim).", "am not swimming")],
    ["cel 6: „don't” w liczbie mnogiej", pcGap("now_or_usually_more", "They ___ (not swim) on Sundays.", "don't swim")],
    ["cel 6: wybór pytania", pcSentence("lesson_choice", "now_or_usually_more", "Do you play football on Saturdays?", {
      instructionPl: "Wybierz poprawne pytanie.",
      options: [{ id: "a", text: "Do you play football on Saturdays?" }, { id: "b", text: "Are you playing football on Saturdays?" }],
      correctOption: "a",
    })],
    ["cel 6: wybór przeczenia w luce", pcChoice("now_or_usually_more", "She ___ TV every morning.", "doesn't watch", "isn't watching")],
    ["cel 6: tłumaczenie pytania", pcTranslation("now_or_usually_more", "Czy grasz w tej chwili w piłkę?", "Are you playing football at the moment?")],
  ];
  it.each(ok)("%s", (_name, ex) => {
    expect(validate(ex)).toEqual([]);
  });
});

describe("validatePresentContinuousExercise — cele porównania (2 i 6), odrzucone", () => {
  const rejected: [string, LessonExerciseDraft, string][] = [
    ["luka bez wskaźnika", pcGap("now_or_usually", "Ola ___ (read) a comic.", "reads"), "grammar.pc_tense_marker_missing"],
    ["mieszane grupy wskaźników", pcGap("now_or_usually", "Look! Ola ___ (read) a comic every evening.", "is reading"), "grammar.pc_tense_markers_mixed"],
    ["Present Simple po „Look!”", pcGap("now_or_usually", "Look! Ola ___ (read).", "reads"), "grammar.pc_tense_marker_mismatch"],
    ["Present Continuous przy „every evening”", pcGap("now_or_usually", "Ola ___ (read) a comic every evening.", "is reading"), "grammar.pc_tense_marker_mismatch"],
    ["forma Present Simple niezgodna z osobą", pcGap("now_or_usually", "He ___ (play) every day.", "play"), "grammar.pc_simple_form_subject"],
    ["forma Present Simple w liczbie mnogiej niezgodna z osobą", pcGap("now_or_usually", "Tom and Ola ___ (play) football every day.", "plays"), "grammar.pc_simple_form_subject"],
    ["„now / usually” ze wskaźnikiem w bodźcu", pcNowUsually("Ola is reading now.", "now"), "grammar.pc_now_usually_stem_marker"],
    ["„now / usually” z kluczem „usually” do zdania w Present Continuous", pcNowUsually("Ola is reading a book.", "usually"), "grammar.pc_now_usually_key"],
    ["„now / usually” ze scenką w poleceniu", pcNowUsually("Ola is reading a book.", "now", { instructionPl: "Cicho! Ola czyta." }), "grammar.pc_now_usually_instruction"],
    ["„now / usually” z pytaniem", pcNowUsually("Is Ola reading a book?", "now"), "grammar.pc_now_usually_stem_shape"],
    ["klasa double w celu 2 (także przy Present Simple)", pcGap("now_or_usually", "He ___ (swim) every day.", "swims"), "grammar.pc_ing_rule_not_allowed"],
    ["cel 2: luka na formę be", pcGap("now_or_usually", "Look! Ola ___ reading.", "is"), "grammar.pc_be_gap_objective"],
    ["cel 6: luka na formę be", pcGap("now_or_usually_more", "Look! Ola ___ not reading.", "is"), "grammar.pc_be_gap_objective"],
    ["cel 2: wybór z pytaniem", pcChoice("now_or_usually", "___ Ola reading a comic now?", "Is", "Does"), "grammar.pc_tense_choice_gap_question"],
    ["cel 6: pytanie w „Ułóż zdanie”", pcOrder("now_or_usually_more", "Do you play football on Saturdays?"), "grammar.pc_tense_choice_question_type"],
    ["cel 2: czasownik stanu w dowolnej formie", pcTranslation("now_or_usually", "Ona codziennie lubi jabłka.", "She likes apples every day."), "grammar.pc_state_verb_tense_choice"],
    ["polecenie „Teraz czy zwykle?” (mieszane grupy)", pcGap("now_or_usually", "Ola ___ (read) a comic every evening.", "reads", { instructionPl: "Teraz czy zwykle?" }), "grammar.pc_tense_markers_mixed"],
    ["cel 2: poprawianie zmienia tylko podmiot", pcErrorFix("now_or_usually", "Look! Tom is reading.", "Look! Ola is reading."), "grammar.pc_error_fix_kind"],
    ["cel 2: poprawianie z kluczem w złym czasie", pcErrorFix("now_or_usually", "Look! Ola is reading.", "Look! Ola reads."), "grammar.pc_tense_marker_mismatch"],
    ["cel 2: tłumaczenie w Present Continuous przy „codziennie”", pcTranslation("now_or_usually", "Ola czyta codziennie.", "Ola is reading every day."), "grammar.pc_tense_marker_mismatch"],
    ["cel 6: przeczenie w Present Continuous przy „every morning”", pcGap("now_or_usually_more", "She ___ (not watch) TV every morning.", "isn't watching"), "grammar.pc_tense_marker_mismatch"],
    ["cel 6: wybór pytania z operatorem niezgodnym z osobą", pcSentence("lesson_choice", "now_or_usually_more", "Does you play football on Saturdays?", {
      options: [{ id: "a", text: "Does you play football on Saturdays?" }, { id: "b", text: "Are you playing football on Saturdays?" }],
      correctOption: "a",
    }), "grammar.pc_simple_form_subject"],
    ["wybór z dwoma poprawnymi opcjami", pcChoice("now_or_usually", "Look! Ola ___ a comic.", "is reading", "is drawing"), "grammar.pc_tense_choice_distractor"],
    ["dwa zdania składowe w różnych czasach", pcGap("now_or_usually", "Mum cooks dinner and Dad ___ (read) right now.", "is reading"), "grammar.pc_tense_marker_mismatch"],
  ];
  it.each(rejected)("%s", (_name, ex, rule) => {
    expectRule(ex, rule);
  });

  it("cel 2: nawias z „not”", () => {
    expectError(pcGap("now_or_usually", "He ___ (not play) football every day.", "doesn't play"), "grammar.pc_gap_bracket_objective", "stem: nawias z „not” jest dozwolony tylko w celach przeczeń");
  });

  it("cel 6: luka z pytaniem przy poprawnym kształcie luki — tylko reguła pytań", () => {
    expect(validate(pcGap("now_or_usually_more", "You ___ (not play) tennis every Saturday?", "don't play")))
      .toEqual(["grammar.pc_tense_choice_question_type"]);
  });

  it("pytanie z luką w wyborze — tylko jedna reguła (pytania wyłącznie całymi zdaniami)", () => {
    const questions: LessonExerciseDraft[] = [
      pcChoice("now_or_usually_more", "___ you play football on Saturdays?", "Do", "Are"),
      pcChoice("now_or_usually_more", "___ she play football on Saturdays?", "Does", "Is"),
      pcChoice("now_or_usually_more", "___ you playing football now?", "Are", "Do"),
      pcChoice("now_or_usually_more", "What ___ you doing now?", "are", "do"),
      pcChoice("now_or_usually", "___ Ola read comics every evening", "Does", "Is"),
    ];
    for (const ex of questions) {
      const errors = validate(ex);
      expect(errors, ex.stem).toEqual(["grammar.pc_tense_choice_gap_question"]);
    }
  });

  it("drugie zdanie składowe po Present Simple: podmiot to tylko „Dad” (bez niezgodności formy be)", () => {
    const errors = validate(pcGap("now_or_usually", "Mum cooks dinner and Dad ___ (read) right now.", "is reading"));
    expect(errors).not.toContain("grammar.pc_be_form_subject");
  });
});

describe("przypięte zachowanie poza walidatorem tematu", () => {
  it("widok checkera luki celu 2: scenka z polecenia i czasownik w nawiasie, bez podpowiedzi", () => {
    const gap = pcGap("now_or_usually", "Grandpa ___ (sleep) in the armchair.", "is sleeping", {
      instructionPl: "Cicho! Dziadek śpi.",
      hint: "play",
    });
    const view = solverView(gap, presentContinuousV1);
    expect(view).toContain("Cicho! Dziadek śpi.");
    expect(view).toContain("Grandpa ___ (sleep) in the armchair.");
    expect(view).not.toContain("play");
  });

  it("pula z wyborem i tłumaczeniem tego samego zdania przechodzi walidację (spec §6.3, świadomie)", () => {
    const choice: LessonExerciseDraft = {
      ...pcChoice("affirmative", "Dad ___ dinner now.", "is cooking", "are cooking"),
      focus: ["is", "cooking"],
    };
    const translation: LessonExerciseDraft = {
      ...pcTranslation("affirmative", "Tata teraz gotuje obiad.", "Dad is cooking dinner now."),
      focus: ["is", "cooking"],
    };
    const result = validatePool([choice, translation], englishGrammarSubject, presentContinuousV1);
    expect(result.rejected).toEqual([]);
    expect(result.valid).toEqual([choice, translation]);
  });
});

/** Czy walidator zgłasza regułę `rule` z komunikatem dla rodzica zawierającym `fragment`. */
function expectError(ex: LessonExerciseDraft, rule: string, fragment: string): void {
  const issues = validateEnglishGrammarExercise(ex, presentContinuousV1);
  expect(issues.some((issue) => issue.rule === rule && issue.pl.includes(fragment)), `${rule}: ${fragment} w ${JSON.stringify(issues)}`).toBe(true);
}

const USUALLY = (field: string) => `${field}: wskaźnik „zwykle” (every day, always, codziennie…) nie pasuje do Present Continuous`;
const NEEDS_NOW = "grammar.pc_now_marker_missing";
const GOING_TO = (field: string) => `${field}: „going to” + czasownik to przyszłość (be going to)`;

describe("cele 1, 3, 4, 5 — wskaźnik „zwykle” odrzuca ćwiczenie", () => {
  const rejected: [string, LessonExerciseDraft, string][] = [
    ["cel 1: luka z „every day”", pcGap("affirmative", "Tom ___ (play) football every day.", "is playing"), "stem"],
    ["cel 1: luka z „on Saturdays”", pcGap("affirmative", "We ___ (play) tennis on Saturdays.", "are playing"), "stem"],
    ["cel 1: luka z „always” i „now”", pcGap("affirmative", "They always ___ (play) football now.", "are playing"), "stem"],
    ["cel 1: wybór z „always” w kluczu", pcChoice("affirmative", "She ___ her mum now.", "is always helping", "always helps"), "answer"],
    ["cel 1: kolejność z „every day”", pcOrder("affirmative", "Tom is playing football every day."), "answer"],
    ["cel 1: tłumaczenie z „every day” w kluczu", pcTranslation("affirmative", "Mama teraz gotuje obiad.", "Mum is cooking dinner every day."), "answer"],
    ["cel 1: scenka „zwykle” w poleceniu", pcGap("affirmative", "Tom ___ (play) football now.", "is playing", { instructionPl: "Tom zawsze gra w piłkę po szkole." }), "instructionPl"],
    ["cel 1: poprawianie z „on Mondays”", pcErrorFix("affirmative", "Ola reading comics on Mondays.", "Ola is reading comics on Mondays."), "statement"],
    ["cel 1: „Posłuchaj i wybierz” z „every morning”", pcSentence("lesson_listen_choice", "affirmative", "are", {
      stem: "The dogs ___ playing in the park every morning.",
      options: [{ id: "a", text: "are" }, { id: "b", text: "is" }],
      correctOption: "a",
    }), "stem"],
    ["cel 3: luka z „every day”", pcGap("negative", "She ___ (not watch) TV every day.", "isn't watching"), "stem"],
    ["cel 3: przekształcenie z „every day”", pcTransform("negative", "to_negative", "She is watching TV every day.", "She isn't watching TV every day."), "statement"],
    ["cel 4: kolejność z „every day”", pcOrder("questions", "Is Tom playing football every day?"), "answer"],
    ["cel 4: krótka odpowiedź z „every day”", pcShortAnswer("Is Ola reading every day?", "Yes, she is.", "No, she isn't."), "prompt"],
    ["cel 5: luka z „every day”", pcGap("ing_spelling", "He ___ (swim) every day.", "is swimming"), "stem"],
    ["cel 5: luka z „always”", pcGap("ing_spelling", "Tom ___ (swim) always.", "is swimming"), "stem"],
  ];
  it.each(rejected)("%s", (_name, ex, field) => {
    expectError(ex, "grammar.pc_usually_marker", USUALLY(field));
  });

  it("słowo czasu w poleceniu zadania nie jest wskaźnikiem („Zawsze czytaj…”, „Teraz uzupełnij…”)", () => {
    expect(validate(pcGap("affirmative", "He ___ (play) football now.", "is playing", { instructionPl: "Zawsze czytaj całe zdanie." }))).toEqual([]);
    expect(validate(pcGap("affirmative", "Ola ___ (read) a comic.", "is reading", { instructionPl: "Teraz uzupełnij zdanie." }))).toEqual([NEEDS_NOW]);
  });
});

describe("cele 1, 3, 4, 5 — wskaźnik „teraz” wymagany tam, gdzie Present Simple też by pasował", () => {
  const rejected: [string, LessonExerciseDraft][] = [
    ["cel 1: wybór is reading / reads", pcChoice("affirmative", "Ola ___ a book.", "is reading", "reads")],
    ["cel 1: wybór is playing / plays", pcChoice("affirmative", "Tom ___ football in the garden.", "is playing", "plays")],
    ["cel 3: wybór isn't playing / doesn't play", pcChoice("negative", "Tom ___ football.", "isn't playing", "doesn't play")],
    ["cel 4: wybór pytania Is she reading? / Does she read?", pcSentence("lesson_choice", "questions", "Is she reading?", {
      options: [{ id: "a", text: "Is she reading?" }, { id: "b", text: "Does she read?" }],
      correctOption: "a",
    })],
    ["cel 1: luka z czasownikiem", pcGap("affirmative", "Ola ___ (read) a comic.", "is reading")],
    ["cel 5: luka z czasownikiem", pcGap("ing_spelling", "Tom ___ (swim) in the lake.", "is swimming")],
    ["cel 1: poprawianie błędu", pcErrorFix("affirmative", "She is play tennis.", "She is playing tennis.")],
    ["cel 4: poprawianie błędu", pcErrorFix("questions", "Is she read?", "Is she reading?")],
    ["cel 3: przekształcenie", pcTransform("negative", "to_negative", "He is playing.", "He isn't playing.")],
    ["cel 4: przekształcenie na pytanie", pcTransform("questions", "to_question", "He is playing.", "Is he playing?")],
    // Fala 1 Task 19: opcje inne niż sama forma be dopuszczają inny czas (read, are reading → literówka zamiast czasu).
    ["wybór bez formy Present Simple w opcjach", pcChoice("affirmative", "Ola ___ a book.", "is reading", "are reading")],
    ["wybór z formą PS niezgodną z osobą", pcChoice("affirmative", "Tom ___ football.", "is playing", "play")],
  ];
  it.each(rejected)("%s", (_name, ex) => {
    expect(validate(ex)).toEqual([NEEDS_NOW]);
  });

  const ok: [string, LessonExerciseDraft][] = [
    ["wybór z formą be po luce", pcChoice("affirmative", "Ola ___ reading a book.", "is", "are")],
    ["luka na formę be", pcGap("affirmative", "They ___ playing.", "are")],
    ["„Posłuchaj i wybierz”", pcSentence("lesson_listen_choice", "affirmative", "is", {
      stem: "Tom ___ playing football.",
      options: [{ id: "a", text: "is" }, { id: "b", text: "are" }],
      correctOption: "a",
    })],
    ["kolejność", pcOrder("affirmative", "Tom is playing football.")],
    ["krótka odpowiedź", pcShortAnswer("Is she reading?", "Yes, she is.", "Yes, she does.")],
    ["scenka w poleceniu", pcGap("affirmative", "Grandpa ___ (sleep) on the sofa.", "is sleeping", { instructionPl: "Cicho! Dziadek śpi." })],
    ["„Look at …!” na początku", pcChoice("affirmative", "Look at Tom! He ___ .", "is jumping", "jumps")],
    ["cel 4: „What … doing?” jako kontekst", pcGap("questions", "What are you doing? I ___ (read) a book.", "am reading")],
    // „What does he doing?” ma dwie poprawki (is he doing / does he do), więc odrzuca je `grammar.pc_error_fix_do_ing`.
    ["cel 4: poprawianie „What are he doing?”", pcErrorFix("questions", "What are he doing?", "What is he doing?")],
    ["cel 1: wskaźnik w kluczu poprawiania", pcErrorFix("affirmative", "She is play tennis now.", "She is playing tennis now.")],
  ];
  it.each(ok)("%s", (_name, ex) => {
    expect(validate(ex)).toEqual([]);
  });
});

describe("„going to” + czasownik (przyszłość) odrzuca ćwiczenie w każdym celu", () => {
  it("wybór „now / usually”, kolejność, przekształcenie i luka", () => {
    expectError(pcNowUsually("Ola is going to read a comic.", "now"), "grammar.pc_going_to_future", GOING_TO("stem"));
    expectError(pcOrder("affirmative", "Tom is going to play football now."), "grammar.pc_going_to_future", GOING_TO("answer"));
    expectError(pcTransform("questions", "to_question", "Tom is going to play now.", "Is Tom going to play now?"), "grammar.pc_going_to_future", GOING_TO("statement"));
    expectError(pcGap("affirmative", "Tom ___ (go) to play football now.", "is going"), "grammar.pc_going_to_future", GOING_TO("answer"));
  });

  it("„going to” + miejsce zostaje Present Continuous", () => {
    expect(validate(pcOrder("affirmative", "Tom is going to school."))).toEqual([]);
    expect(validate(pcOrder("affirmative", "Dad is going to work."))).toEqual([]);
  });
});

describe("„be” jako łącznik w zdaniu z kluczem (bez reguły -ing po nim)", () => {
  const ok: [string, LessonExerciseDraft][] = [
    ["wybór po zdaniu „This is Ola.”", pcChoice("affirmative", "This is Ola. She ___ a book now.", "is reading", "are reading")],
    ["wybór po zdaniu „It is sunny.”", pcChoice("affirmative", "It is sunny. The children ___ football now.", "are playing", "is playing")],
    ["wybór po zdaniu „Dad is tired.”", pcChoice("affirmative", "Dad is tired. He ___ now.", "is sleeping", "are sleeping")],
    ["kolejność z łącznikiem i Present Continuous", pcOrder("affirmative", "It is sunny and we are playing.")],
    ["tłumaczenie z łącznikiem", pcTranslation("affirmative", "Patrz! Mama jest w kuchni i gotuje obiad.", "Look! Mum is in the kitchen and she is cooking dinner.")],
    ["cel 3: tłumaczenie z łącznikiem", pcTranslation("negative", "Tata jest w ogrodzie i w tej chwili nie gotuje.", "Dad is in the garden and he isn't cooking at the moment.")],
  ];
  it.each(ok)("%s", (_name, ex) => {
    expect(validate(ex)).toEqual([]);
  });

  it("zdanie z samym łącznikiem nie jest Present Continuous; forma bez -ing nadal odrzucona", () => {
    expectError(pcOrder("affirmative", "Mum is in the kitchen now."), "grammar.pc_sentence_not_continuous", "answer: zdanie w Present Continuous potrzebuje am/is/are + formy -ing");
    expectError(pcTranslation("affirmative", "Ona teraz gra.", "She is plays now."), "grammar.pc_ing_after_be", "answer: po am/is/are potrzebna jest forma -ing, a stoi „plays”");
  });
});

describe("cel 3: luka na formę be z przeczeniem tylko po „No”", () => {
  it("„She ___ sleeping now.” → „isn't” (twierdzenie też pasuje) odrzucone", () => {
    expectError(pcGap("negative", "She ___ sleeping now.", "isn't"), "grammar.pc_be_gap_negative_without_no", "answer: przeczenie w luce na formę be tylko po „No”");
    expectError(pcGap("negative", "We ___ playing now.", "aren't"), "grammar.pc_be_gap_negative_without_no", "answer: przeczenie w luce na formę be tylko po „No”");
  });

  it("po „No” i z „not” po luce — poprawne", () => {
    expect(validate(pcGap("negative", "Is she sleeping? No, she ___.", "isn't"))).toEqual([]);
    expect(validate(pcGap("negative", "She ___ not sleeping now.", "is"))).toEqual([]);
  });
});

describe("krótka odpowiedź: osoba zgodna z liczbą podmiotu pytania (imię, rzeczownik)", () => {
  it.each([
    ["Are the boys running now?", "Yes, he is.", "No, they aren't.", "osoba „he”"],
    ["Is Tom reading now?", "Yes, they are.", "No, he isn't.", "osoba „they”"],
    ["Are Tom and Ola playing now?", "Yes, she is.", "No, they aren't.", "osoba „she”"],
  ])("%s → %s", (prompt, correct, wrong, fragment) => {
    expectError(pcShortAnswer(prompt, correct, wrong), "grammar.pc_short_answer_person", `answer: ${fragment} w odpowiedzi nie pasuje do podmiotu pytania`);
  });

  it.each([
    ["Are the boys running now?", "Yes, they are.", "Yes, he is."],
    ["Is Tom reading now?", "Yes, he is.", "Yes, they are."],
    ["Is the cat sleeping now?", "No, it isn't.", "No, they aren't."],
    ["Look at Ola! Is she reading?", "Yes, she is.", "Yes, he is."],
  ])("%s → %s", (prompt, correct, wrong) => {
    expect(validate(pcShortAnswer(prompt, correct, wrong))).toEqual([]);
  });
});

describe("przekształcenia: kształt pytania i biegunowość zdania wyjściowego", () => {
  const TO_QUESTION = "answer: pytanie zaczyna się od am/is/are i kończy znakiem „?”";
  it("to_question: odpowiedź-twierdzenie albo bez „?” odrzucona", () => {
    expectError(pcTransform("questions", "to_question", "He is playing now.", "He is playing now."), "grammar.pc_transform_question_shape", TO_QUESTION);
    expectError(pcTransform("questions", "to_question", "He is playing now.", "Is he playing now"), "grammar.pc_transform_question_shape", TO_QUESTION);
    expectError(pcTransform("questions", "to_question", "He is playing now.", "He is playing now?"), "grammar.pc_transform_question_shape", TO_QUESTION);
  });

  it("to_question: zdanie wyjściowe nie jest pytaniem", () => {
    expectError(pcTransform("questions", "to_question", "Is he playing now?", "Is he playing now?"), "grammar.pc_transform_statement_question", "statement: zdanie do zamiany na pytanie nie może być pytaniem");
  });

  it("to_question: poprawne kształty", () => {
    expect(validate(pcTransform("questions", "to_question", "They are playing now.", "Are they playing now?"))).toEqual([]);
    expect(validate(pcTransform("questions", "to_question", "Look! Tom is playing.", "Look! Is Tom playing?"))).toEqual([]);
  });

  it("to_negative i to_affirmative: zdanie wyjściowe ma przeciwną biegunowość", () => {
    expectError(pcTransform("negative", "to_negative", "He isn't playing now.", "He is not playing now."),
      "grammar.pc_transform_polarity", "statement: zdanie do przekształcenia ma przeciwną biegunowość niż odpowiedź (to_negative: twierdzenie → przeczenie)");
    expectError(pcTransform("negative", "to_affirmative", "She is playing now.", "He is playing now."),
      "grammar.pc_transform_polarity", "statement: zdanie do przekształcenia ma przeciwną biegunowość niż odpowiedź (to_affirmative: przeczenie → twierdzenie)");
    expect(validate(pcTransform("negative", "to_affirmative", "He isn't playing right now.", "He is playing right now."))).toEqual([]);
  });

  it("to_affirmative: odpowiedź z przeczeniem", () => {
    expectError(pcTransform("negative", "to_affirmative", "He is playing now.", "He isn't playing now."), "grammar.pc_be_negated", "answer: forma przecząca nie pasuje do celu twierdzącego");
  });
});

describe("wybór: opcja z apostrofem na początku", () => {
  it("„'re playing” obok „are playing”", () => {
    expectError(pcChoice("affirmative", "They ___ football now.", "are playing", "'re playing"),
      "grammar.pc_leading_apostrophe", "options: opcja nie może zaczynać się apostrofem („'re playing”) — zapisz pełną formę am/is/are");
  });
});

describe("luka z dwoma albo więcej podkreśleniami", () => {
  it("„__” i „____” działają jak „___”", () => {
    expect(validate(pcGap("affirmative", "Look! Mum __ (cook) dinner.", "is cooking"))).toEqual([]);
    expect(validate(pcChoice("affirmative", "Mum __ dinner now.", "is cooking", "are cooking"))).toEqual([]);
    expect(validate(pcGap("questions", "__ she reading a book?", "Is"))).toEqual([]);
  });
});

describe("luki do uzupełnienia w testach (przegląd Task 13, C-M5)", () => {
  it("cel 3: „aren't …ing” i „am not …ing”", () => {
    expect(validate(pcGap("negative", "They ___ (not play) football right now.", "aren't playing"))).toEqual([]);
    expect(validate(pcGap("negative", "I ___ (not play) at the moment.", "am not playing"))).toEqual([]);
    expect(validate(pcTranslation("negative", "Oni w tej chwili nie grają.", "They aren't playing at the moment."))).toEqual([]);
    expect(validate(pcTranslation("negative", "Patrz! Nie gram.", "Look! I am not playing."))).toEqual([]);
  });

  it.each([
    ["now_or_usually", pcGap("now_or_usually", "Ola ___ (read) a comic tomorrow.", "is reading")],
    ["negative", pcGap("negative", "She ___ (not watch) TV tomorrow.", "isn't watching")],
    ["questions", pcGap("questions", "___ she reading tomorrow?", "Is")],
    ["ing_spelling", pcGap("ing_spelling", "He ___ (swim) tomorrow.", "is swimming")],
    ["now_or_usually_more", pcGap("now_or_usually_more", "She ___ (not watch) TV tomorrow.", "isn't watching")],
  ])("wskaźnik zakazany w celu %s", (_objective, ex) => {
    expectError(ex, "grammar.pc_forbidden_marker", "stem: wskaźnik czasu „tomorrow” jest zakazany w temacie");
  });

  it("cel 2: „looking at” (kolokacja) w obu czasach", () => {
    expect(validate(pcGap("now_or_usually", "Look! Ola ___ (look) at the stars.", "is looking"))).toEqual([]);
    expect(validate(pcGap("now_or_usually", "Ola ___ (look) at the stars every evening.", "looks"))).toEqual([]);
  });
});

describe("tabele reguł tematu zgodne z celami katalogu", () => {
  it("klucze map i zbiory celów odpowiadają celom `presentContinuousV1`", () => {
    const objectives = presentContinuousV1.objectives.map((objective) => objective.id.split(".").at(-1)!).sort();
    expect(Object.keys(PC_POLARITY).sort()).toEqual(objectives);
    expect(Object.keys(PC_ALLOWED_ING_RULES).sort()).toEqual(objectives);
    expect(Object.keys(ERROR_FIX_KINDS).sort()).toEqual(objectives);
    expect([...PC_FORM_OBJECTIVES, ...TENSE_CHOICE_OBJECTIVES].sort()).toEqual(objectives);
    for (const set of [BE_GAP_OBJECTIVES, NEGATED_VERB_GAP_OBJECTIVES]) {
      for (const objective of set) expect(objectives, objective).toContain(objective);
    }
  });
});

/** Wybór całych zdań (bodziec bez luki) z kluczem w pierwszej opcji. */
function pcSentenceChoice(objective: Objective, stem: string | undefined, correct: string, ...wrong: string[]): LessonExerciseDraft {
  return pcSentence("lesson_choice", objective, correct, {
    ...(stem === undefined ? {} : { stem }),
    options: [correct, ...wrong].map((text, index) => ({ id: String.fromCharCode(97 + index), text })),
    correctOption: "a",
  });
}

/** Przypadki krytyka A (Task 19), które przechodziły walidację: każdy ma teraz dokładnie wskazaną regułę. */
describe("fala 1 Task 19 — C1: goły „now” w przeczeniach i celach porównania (standard „Środek”)", () => {
  const BARE = "grammar.pc_now_marker_bare";
  const rejected: [string, LessonExerciseDraft][] = [
    ["cel 3: poprawianie „Tom isn't watch TV now.”", pcErrorFix("negative", "Tom isn't watch TV now.", "Tom isn't watching TV now.")],
    ["cel 6: wybór isn't watching / doesn't watch przy „now”", pcChoice("now_or_usually_more", "Tom ___ TV now.", "isn't watching", "doesn't watch")],
    ["cel 6: wybór całych pytań z „now”", pcSentenceChoice("now_or_usually_more", "Choose.", "Are you watching TV now?", "Do you watch TV now?")],
    ["cel 3: luka (not watch) z „now”", pcGap("negative", "She ___ (not watch) TV now.", "isn't watching")],
    ["cel 6: luka (not watch) z „now”", pcGap("now_or_usually_more", "She ___ (not watch) TV now.", "isn't watching")],
    ["cel 3: wybór isn't reading / doesn't read", pcChoice("negative", "Ola ___ a book now.", "isn't reading", "doesn't read")],
    ["cel 2: luka „Tom ___ (walk) to school now.”", pcGap("now_or_usually", "Tom ___ (walk) to school now.", "is walking")],
    ["cel 2: tłumaczenie z „teraz”", pcTranslation("now_or_usually", "Ola teraz czyta książkę.", "Ola is reading a book now.")],
    ["cel 3: tłumaczenie „Mój brat teraz nie pracuje.”", pcTranslation("negative", "Mój brat teraz nie pracuje.", "My brother isn't working now.")],
    ["cel 1: przekształcenie to_affirmative z przeczenia z „now”", pcTransform("affirmative", "to_affirmative", "Tom isn't playing now.", "Tom is playing now.")],
  ];
  it.each(rejected)("%s", (_name, ex) => {
    expect(validate(ex)).toEqual([BARE]);
  });

  const ok: [string, LessonExerciseDraft][] = [
    ["cel 3: „Look! Tom isn't watching TV.” (poprawianie)", pcErrorFix("negative", "Look! Tom isn't watch TV.", "Look! Tom isn't watching TV.")],
    ["cel 3: „Tom isn't watching TV right now.” (poprawianie)", pcErrorFix("negative", "Tom isn't watch TV right now.", "Tom isn't watching TV right now.")],
    ["cel 3: luka po „Look!”", pcGap("negative", "Look! Tom ___ (not watch) TV.", "isn't watching")],
    ["cel 3: luka z „at the moment”", pcGap("negative", "Tom ___ (not watch) TV at the moment.", "isn't watching")],
    ["cel 3: scenka w poleceniu", pcGap("negative", "Tom ___ (not watch) TV.", "isn't watching", { instructionPl: "Cicho! Tom śpi." })],
    ["cel 1: twierdzenie z gołym „now” nadal wystarcza", pcErrorFix("affirmative", "Ola is read a book now.", "Ola is reading a book now.")],
    ["cel 1: tłumaczenie z „teraz”", pcTranslation("affirmative", "Ola teraz czyta książkę.", "Ola is reading a book now.")],
    ["cel 4: pytanie z gołym „now”", pcErrorFix("questions", "Is Ola read a book now?", "Is Ola reading a book now?")],
    ["cel 6: tłumaczenie z „w tej chwili”", pcTranslation("now_or_usually_more", "Tom w tej chwili nie ogląda telewizji.", "Tom isn't watching TV at the moment.")],
    ["cel 6: przeczenie Present Simple — „now” nie dotyczy grupy „zwykle”", pcGap("now_or_usually_more", "Tom ___ (not watch) TV every evening.", "doesn't watch")],
  ];
  it.each(ok)("%s", (_name, ex) => {
    expect(validate(ex)).toEqual([]);
  });
});

describe("fala 1 Task 19 — I1: wskaźnik tylko w tym, co dziecko widzi przed odpowiedzią", () => {
  it.each([
    ["cel 6: wskaźnik tylko w kluczu wyboru całych pytań", pcSentenceChoice("now_or_usually_more", "Choose.", "Are you watching TV right now?", "Do you watch TV?"), "grammar.pc_tense_marker_missing"],
    ["cel 1: wskaźnik tylko w opcji", pcChoice("affirmative", "Ola ___.", "is reading now", "reads"), "grammar.pc_now_marker_missing"],
    ["cel 2: tłumaczenie bez wskaźnika w polskim zdaniu", pcTranslation("now_or_usually", "Mama gotuje obiad.", "Mum cooks dinner every day."), "grammar.pc_tense_marker_missing"],
    ["cel 6: tłumaczenie bez wskaźnika w polskim zdaniu", pcTranslation("now_or_usually_more", "Mama gotuje obiad.", "Mum cooks dinner every day."), "grammar.pc_tense_marker_missing"],
  ] as const)("%s", (_name, ex, rule) => {
    expect(validate(ex)).toContain(rule);
  });

  it("wskaźnik w każdej opcji tej samej grupy liczy się jak wspólny", () => {
    expect(validate(pcSentenceChoice("now_or_usually_more", "Choose.", "Are you watching TV right now?", "Do you watch TV right now?"))).toEqual([]);
    expect(validate(pcSentenceChoice("affirmative", "Which is correct?", "Ola is reading now.", "Ola reads now."))).toEqual([]);
  });
});

describe("fala 1 Task 19 — I2: w celach 2 i 6 liczy się wskaźnik zdania składowego luki", () => {
  it.each([
    ["wskaźnik w innym zdaniu z orzeczeniem", pcGap("now_or_usually", "Tom plays football every day. Ola ___ (read) a book.", "is reading")],
    ["wskaźnik w innym zdaniu składowym z orzeczeniem", pcChoice("now_or_usually", "Mum is cooking right now and Dad ___ the newspaper.", "is reading", "reads")],
    ["wskaźnik w zdaniu po luce", pcGap("now_or_usually", "Ola ___ (read) a book. Tom is playing right now.", "is reading")],
  ])("%s", (_name, ex) => {
    expect(validate(ex)).toContain("grammar.pc_tense_marker_missing");
  });

  it("wykrzyknienie bez orzeczenia przed luką i część zdania bez orzeczenia liczą się", () => {
    expect(validate(pcGap("now_or_usually", "Look! Tom is running. Ola ___ (read) a book.", "is reading"))).toEqual([]);
    expect(validate(pcGap("now_or_usually", "Every evening Mum and Dad ___ (watch) TV.", "watch"))).toEqual([]);
    expect(validate(pcGap("now_or_usually", "Mum cooks dinner and Dad ___ (read) every evening.", "reads"))).toEqual([]);
  });
});

describe("fala 1 Task 19 — I3: dystraktory wyboru", () => {
  it("(a) cele 1, 3, 4: wybór z czasownikiem w opcjach potrzebuje wskaźnika", () => {
    expect(validate(pcChoice("affirmative", "Ola ___ a book.", "is reading", "reads"))).toEqual(["grammar.pc_now_marker_missing"]);
    expect(validate(pcChoice("negative", "Ola ___ a book.", "isn't reading", "aren't reading"))).toEqual(["grammar.pc_now_marker_missing"]);
    expect(validate(pcChoice("affirmative", "Ola ___ reading a book.", "is", "are"))).toEqual([]);
  });

  it("(b) cel 5: dystraktor to klucz z błędną pisownią -ing", () => {
    expect(validate(pcChoice("ing_spelling", "Look! Tom ___ in the lake.", "is swimming", "is running"))).toEqual(["grammar.pc_ing_spelling_distractor"]);
    expect(validate(pcSentence("lesson_choice", "ing_spelling", "is sitting", {
      stem: "Look! Tom ___ on the wall.",
      options: [{ id: "a", text: "is sitting" }, { id: "b", text: "is swimming" }, { id: "c", text: "is siting" }],
      correctOption: "a",
    }))).toEqual(["grammar.pc_ing_spelling_distractor"]);
    expect(validate(pcChoice("ing_spelling", "Look! Tom ___ in the lake.", "is swimming", "is swiming"))).toEqual([]);
  });

  it("(c) cele 1, 3, 4: dystraktor wstawiony w lukę łamie regułę klucza", () => {
    expect(validate(pcChoice("affirmative", "Ola ___ now.", "is reading", "is drawing"))).toEqual(["grammar.pc_choice_distractor_correct"]);
    expect(validate(pcChoice("affirmative", "Look! ___ reading a book.", "Ola is", "Tom is"))).toEqual(["grammar.pc_choice_distractor_correct"]);
    expect(validate(pcChoice("affirmative", "Ola ___ now.", "is reading", "reading"))).toEqual([]);
  });

  it("ponowny przegląd: zły szyk dystraktora to błąd, nie druga poprawna odpowiedź", () => {
    const ok: LessonExerciseDraft[] = [
      pcSentenceChoice("questions", "Wybierz pytanie.", "Is Tom playing football now?", "Tom is playing football now?"),
      pcSentenceChoice("questions", "Wybierz pytanie.", "Are you reading now?", "You are reading now?"),
      pcChoice("questions", "___ playing football now?", "Is Tom", "Tom is"),
      pcSentenceChoice("questions", "Wybierz pytanie.", "Is Tom playing football now?", "Tom is playing football now."),
      pcSentenceChoice("negative", "Wybierz zdanie.", "Tom isn't watching TV right now.", "Tom not is watching TV right now."),
      pcSentenceChoice("affirmative", "Wybierz zdanie.", "Look! Ola is reading.", "Look! Ola reading is."),
    ];
    for (const ex of ok) expect(validate(ex), ex.options!.map((option) => option.text).join(" / ")).toEqual([]);
  });

  it("ponowny przegląd: dystraktor różny od klucza tylko przeczeniem, gdy bodziec nie ustala biegunowości", () => {
    expect(validate(pcChoice("affirmative", "Look! Ola ___ a book.", "is reading", "isn't reading"))).toEqual(["grammar.pc_choice_distractor_correct"]);
    expect(validate(pcSentenceChoice("negative", "Wybierz zdanie.", "Look! Tom isn't playing.", "Look! Tom is playing."))).toEqual(["grammar.pc_choice_distractor_correct"]);
    expect(validate(pcChoice("questions", "Is Ola reading right now? No, she ___.", "isn't reading", "is reading"))).toEqual([]);
  });

  it.each([
    ["can read"], ["will read"], ["didn't read"], ["was reading"], ["has read"], ["read"],
  ])("ponowny przegląd: dystraktor w innym poprawnym czasie „%s” to druga poprawna odpowiedź", (distractor) => {
    expect(validate(pcChoice("affirmative", "Ola ___ a book right now.", "is reading", distractor))).toEqual(["grammar.pc_choice_distractor_correct"]);
  });

  it("ponowny przegląd: inny czas niezgodny z podmiotem i Present Simple zostają błędnymi dystraktorami", () => {
    expect(validate(pcChoice("affirmative", "Look! The boys ___ football.", "are playing", "was playing"))).toEqual([]);
    expect(validate(pcChoice("affirmative", "Look! Tom ___ football.", "is playing", "have played"))).toEqual([]);
    expect(validate(pcChoice("affirmative", "Look! Tom ___ football.", "is playing", "plays"))).toEqual([]);
    expect(validate(pcSentenceChoice("negative", "Wybierz zdanie.", "Ola isn't reading right now.", "Ola doesn't read right now."))).toEqual([]);
    expect(validate(pcChoice("affirmative", "Tom ___ football now.", "is playing", "played"))).toEqual(["grammar.pc_choice_distractor_correct"]);
  });

  it("(c) cele 1, 3, 4: dystraktor całego zdania łamie regułę klucza", () => {
    expect(validate(pcSentenceChoice("affirmative", "Which is correct?", "Look! Ola is reading.", "Look! Tom is reading."))).toEqual(["grammar.pc_choice_distractor_correct"]);
    expect(validate(pcSentenceChoice("affirmative", "Which is correct?", "Look! Ola is reading.", "Look! Ola are reading."))).toEqual([]);
    expect(validate(pcSentenceChoice("negative", undefined, "Look! Tom isn't sleeping.", "Look! Tom doesn't sleep."))).toEqual([]);
  });
});

describe("fala 1 Task 19 — I4: klucz przekształcenia powstaje ze zdania wyjściowego", () => {
  const KEY = "grammar.pc_transform_key_statement";
  it.each([
    ["to_negative z innym podmiotem", pcTransform("negative", "to_negative", "Tom is playing football right now.", "Ola isn't playing football right now."), KEY],
    ["to_negative bez wskaźnika", pcTransform("negative", "to_negative", "Tom is playing football right now.", "Tom isn't playing football."), KEY],
    ["to_affirmative z innym czasownikiem", pcTransform("negative", "to_affirmative", "Look! Tom isn't running.", "Look! Tom is jumping."), KEY],
    ["to_question z pytaniem „What”", pcTransform("questions", "to_question", "Tom is playing football now.", "What is Tom doing now?"), "grammar.pc_transform_question_shape"],
    ["to_question bez „Look!”", pcTransform("questions", "to_question", "Look! Tom is playing.", "Is Tom playing?"), KEY],
    ["to_question z przeczenia", pcTransform("questions", "to_question", "She isn't sleeping right now.", "Isn't she sleeping right now?"), "grammar.pc_transform_question_negative"],
  ] as const)("%s", (_name, ex, rule) => {
    expect(validate(ex)).toEqual([rule]);
  });

  it("ponowny przegląd: „Tom's playing” to „Tom is playing” w zdaniu wyjściowym", () => {
    expect(validate(pcTransform("negative", "to_negative", "Tom's playing right now.", "Tom isn't playing right now."))).toEqual([]);
    expect(validate(pcTransform("negative", "to_negative", "Tom's playing right now.", "Ola isn't playing right now."))).toEqual(["grammar.pc_transform_key_statement"]);
  });

  it("poprawne przekształcenia, także z wariantem bez skrótu i w celu 6 z do/does", () => {
    expect(validate({ ...pcTransform("negative", "to_negative", "Tom is playing right now.", "Tom isn't playing right now."), acceptedAnswers: ["Tom is not playing right now."] })).toEqual([]);
    expect(validate(pcTransform("questions", "to_question", "Look! Tom is playing.", "Look! Is Tom playing?"))).toEqual([]);
    expect(validate(pcTransform("now_or_usually_more", "to_negative", "Tom plays football every day.", "Tom doesn't play football every day."))).toEqual([]);
  });
});

describe("fala 1 Task 19 — I5: klucze tłumaczeń", () => {
  it("wskaźnik polskiego zdania przechodzi do każdego klucza", () => {
    expect(validate(pcTranslation("affirmative", "Ola teraz czyta.", "Ola is reading."))).toEqual(["grammar.pc_translation_key_marker"]);
    expect(validate(pcTranslation("now_or_usually", "Ola codziennie czyta.", "Ola reads."))).toEqual(["grammar.pc_translation_key_marker"]);
    expect(validate(pcTranslation("affirmative", "Ola teraz czyta.", "Ola is reading now.", ["Ola is reading right now.", "Ola is reading at the moment.", "Ola is reading."])))
      .toEqual(["grammar.pc_translation_key_marker"]);
    // „Właśnie” nie ma dosłownego odpowiednika.
    expect(validate(pcTranslation("affirmative", "Ola właśnie czyta.", "Ola is reading."))).toEqual([]);
  });

  it("klucz z now / right now / at the moment ma warianty z dwoma pozostałymi (wskaźnik w dowolnym miejscu)", () => {
    expect(validate(pcTranslation("affirmative", "Ola teraz czyta książkę.", "Ola is reading a book now.", []))).toEqual(["grammar.pc_translation_now_variants"]);
    expect(validate(pcTranslation("affirmative", "Ola teraz czyta książkę.", "Ola is reading a book now.", ["Ola is reading a book right now."])))
      .toEqual(["grammar.pc_translation_now_variants"]);
    expect(validate(pcTranslation("affirmative", "Ola teraz czyta książkę.", "Ola is reading a book now.", ["Ola is reading a book right now.", "At the moment Ola is reading a book."])))
      .toEqual([]);
    expect(validate(pcTranslation("affirmative", "Patrz! Ola czyta książkę.", "Look! Ola is reading a book."))).toEqual([]);
  });
});

describe("Task 16 — dwie poprawne odpowiedzi po krytykach końcowych", () => {
  it("A-I1: krótka odpowiedź z opcjami Yes i No — obie mogą być poprawne", () => {
    const yesNo = pcShortAnswer("Is Tom playing football now?", "Yes, he is.", "No, he isn't.");
    expect(validate(yesNo)).toEqual(["grammar.pc_be_choice_polarity_distractor"]);
    expect(validate({ ...yesNo, instructionPl: "Patrz! Tom gra w piłkę. Wybierz krótką odpowiedź." })).toEqual(["grammar.pc_be_choice_polarity_distractor"]);
    expect(validate({ ...pcShortAnswer("Is Tom sleeping right now?", "No, he isn't.", "Yes, he is."), objectiveId: "english_grammar.present_continuous.negative" }))
      .toEqual(["grammar.pc_be_choice_polarity_distractor"]);
    expect(validate(pcShortAnswer("Is she reading now?", "Yes, she is.", "Yes, she does."))).toEqual([]);
    expect(validate({ ...pcShortAnswer("Is she reading now?", "No, she isn't.", "No, she doesn't."), instructionPl: "Patrz! Ona śpi. Wybierz krótką odpowiedź." }))
      .toEqual([]);
  });

  it("A-I2: cele 2 i 6 — dystraktor w innym poprawnym czasie to druga poprawna odpowiedź", () => {
    const RULE = "grammar.pc_tense_choice_distractor";
    expect(validate(pcSentenceChoice("now_or_usually", "Look! Ola ___ a comic.", "is reading", "reads", "can read"))).toEqual([RULE]);
    expect(validate(pcSentenceChoice("now_or_usually", "Ola ___ football every day.", "plays", "is playing", "played"))).toEqual([RULE]);
    expect(validate(pcChoice("now_or_usually", "Ola ___ football every day.", "plays", "played"))).toEqual([RULE]);
    expect(validate(pcSentenceChoice("now_or_usually_more", "Ola ___ TV on Mondays.", "doesn't watch", "isn't watching", "didn't watch"))).toEqual([RULE]);
    expect(validate(pcSentenceChoice("now_or_usually", "Look! Ola ___ a comic.", "is reading", "reads"))).toEqual([]);
    expect(validate(pcSentenceChoice("now_or_usually_more", "Ola ___ TV on Mondays.", "doesn't watch", "isn't watching"))).toEqual([]);
    expect(validate(pcSentenceChoice("now_or_usually_more", "Wybierz poprawne pytanie.", "Do you play football on Saturdays?", "Are you playing football on Saturdays?")))
      .toEqual([]);
  });

  it("A-I3: fish, sheep, deer bez słowa ustalającego liczbę — is i are są poprawne", () => {
    const RULE = "grammar.pc_numberless_subject";
    expect(validate(pcGap("affirmative", "Look! The fish ___ (eat).", "is eating"))).toEqual([RULE]);
    expect(validate(pcGap("affirmative", "Look! The fish ___ (eat).", "are eating"))).toEqual([RULE]);
    expect(validate({ ...pcChoice("affirmative", "The sheep ___ eating grass now.", "is", "are"), exerciseType: "lesson_listen_choice" })).toEqual([RULE]);
    expect(validate(pcChoice("questions", "___ the sheep eating now?", "Is", "Are"))).toEqual([RULE]);
    expect(validate(pcGap("now_or_usually", "The deer ___ (eat) grass every day.", "eats"))).toEqual([RULE]);
    expect(validate(pcTranslation("affirmative", "Patrz! Ryby jedzą.", "Look! The fish are eating."))).toEqual([RULE]);
  });

  it("A-I3: liczbę ustala określnik albo zaimek — bez nowej reguły", () => {
    expect(validate(pcGap("affirmative", "Look! One fish ___ (eat).", "is eating"))).toEqual([]);
    expect(validate(pcGap("affirmative", "Look! Two fish ___ (eat).", "are eating"))).toEqual([]);
    expect(validate(pcGap("affirmative", "Look! These sheep ___ (eat) grass.", "are eating"))).toEqual([]);
    expect(validate(pcGap("affirmative", "Look! This sheep ___ (eat) grass.", "is eating"))).toEqual([]);
    expect(validate(pcGap("affirmative", "Tom ___ (watch) the fish now.", "is watching"))).toEqual([]);
    expect(validate(pcGap("affirmative", "Look at the fish! It ___ (eat).", "is eating"))).toEqual([]);
    expect(validate(pcGap("affirmative", "Look! Two fish ___ (eat).", "is eating"))).toEqual(["grammar.pc_be_form_subject"]);
  });
});

describe("Task 16 — zakres reguły rzeczowników bez liczby (fish, sheep, deer)", () => {
  const RULE = "grammar.pc_numberless_subject";

  it("nie zgłasza się, gdy liczbę ustala już ćwiczenie: klocki, przekształcenie, podmiot złożony", () => {
    expect(validate({ ...pcOrder("affirmative", "The sheep are eating grass"), instructionPl: "Patrz! Owce jedzą. Ułóż zdanie." })).not.toContain(RULE);
    expect(validate(pcTransform("negative", "to_negative", "The sheep are eating grass right now.", "The sheep aren't eating grass right now."))).not.toContain(RULE);
    expect(validate(pcTransform("questions", "to_question", "The fish are eating now.", "Are the fish eating now?"))).not.toContain(RULE);
    expect(validate(pcGap("affirmative", "Look! The cat and the fish ___ (eat).", "are eating"))).toEqual([]);
    expect(validate(pcGap("affirmative", "Look! The fish and the cat ___ (eat).", "are eating"))).toEqual([]);
    expect(validate(pcChoice("questions", "___ the cat and the fish eating now?", "Are", "Is"))).toEqual([]);
  });

  it("zgłasza się w luce, wyborze, wyborze ze słuchu, poprawianiu błędu i tłumaczeniu", () => {
    expect(validate(pcGap("affirmative", "Look! The fish ___ (eat).", "are eating"))).toEqual([RULE]);
    expect(validate(pcChoice("affirmative", "Look! The sheep ___ grass.", "are eating", "eat"))).toContain(RULE);
    expect(validate({ ...pcChoice("affirmative", "The sheep ___ eating grass now.", "are", "is"), exerciseType: "lesson_listen_choice" })).toEqual([RULE]);
    expect(validate(pcErrorFix("affirmative", "Look! The sheep is eat grass.", "Look! The sheep is eating grass."))).toContain(RULE);
    expect(validate(pcTranslation("affirmative", "Patrz! Owce jedzą trawę.", "Look! The sheep are eating grass."))).toEqual([RULE]);
    // Zdanie z „and” między zdaniami składowymi to nie podmiot złożony.
    expect(validate(pcGap("affirmative", "Look! Tom is reading and the fish ___ (eat).", "are eating"))).toContain(RULE);
  });
});

describe("Task 16 — porządki przed sondą", () => {
  it("„a lot of” i „lots of” przed fish / sheep / deer to liczba mnoga", () => {
    expect(validate(pcGap("affirmative", "Look! A lot of fish ___ (eat).", "are eating"))).toEqual([]);
    expect(validate(pcGap("affirmative", "Look! Lots of sheep ___ (eat) grass.", "are eating"))).toEqual([]);
    expect(validate(pcGap("affirmative", "Look! A lot of fish ___ (eat).", "is eating"))).toEqual(["grammar.pc_be_form_subject"]);
    // Najbliższy określnik przed rzeczownikiem to „the”: liczby nic nie ustala.
    expect(validate(pcGap("affirmative", "Look! One of the fish ___ (eat).", "is eating"))).toContain("grammar.pc_numberless_subject");
  });

  it("cele 2 i 6: pytanie z operatorem innego czasu na początku (Did Tom swim…?) to druga poprawna odpowiedź", () => {
    const RULE = "grammar.pc_tense_choice_distractor";
    expect(validate(pcSentenceChoice("now_or_usually_more", "Wybierz poprawne pytanie.", "Does Tom swim on Fridays?", "Is Tom swimming on Fridays?", "Did Tom swim on Fridays?")))
      .toEqual([RULE]);
    expect(validate(pcSentenceChoice("now_or_usually_more", "Wybierz poprawne pytanie.", "Does Tom swim on Fridays?", "Is Tom swimming on Fridays?", "Can Tom swim on Fridays?")))
      .toEqual([RULE]);
    expect(validate(pcSentenceChoice("now_or_usually_more", "Wybierz poprawne pytanie.", "Does Tom swim on Fridays?", "Is Tom swimming on Fridays?"))).toEqual([]);
  });
});

describe("przegląd PR #329 — dystraktory spoza tabeli i fałszywe odrzucenia", () => {
  it("cele 1, 3, 4: dystraktor z poprawną formą -ing spoza tabeli może być drugą poprawną odpowiedzią", () => {
    const RULE = "grammar.pc_distractor_outside_table";
    expect(validate(pcChoice("affirmative", "Look! Ola ___ the dog.", "is walking", "is feeding"))).toEqual([RULE]);
    expect(validate(pcChoice("negative", "Ola ___ the dog right now.", "isn't walking", "isn't feeding"))).toEqual([RULE]);
    expect(validate(pcSentenceChoice("affirmative", undefined, "Look! Ola is walking the dog.", "Look! Ola is feeding the dog."))).toEqual([RULE]);
    // Literówka formy -ing klucza i zła forma be to błędy dystraktora — bez zgłoszenia.
    expect(validate(pcChoice("affirmative", "Look! Ola ___ the dog.", "is walking", "is walkking"))).toEqual([]);
    expect(validate(pcChoice("affirmative", "Look! Ola ___ the dog.", "is walking", "are feeding"))).toEqual([]);
  });

  it("cele 1, 3, 4: forma z tabeli spoza klasy pisowni celu jest poprawną angielszczyzną (druga poprawna odpowiedź)", () => {
    expect(validate(pcChoice("affirmative", "Look! Ola ___ a letter.", "is reading", "is writing"))).toEqual(["grammar.pc_choice_distractor_correct"]);
  });

  it("cele 2 i 6: dystraktor spoza tabeli albo spoza klasy pisowni celu nie jest błędem", () => {
    expect(validate(pcChoice("now_or_usually", "Look! Ola ___ a letter.", "is reading", "is writing"))).toEqual(["grammar.pc_tense_choice_distractor"]);
    expect(validate(pcChoice("now_or_usually", "Ola ___ the dog every day.", "walks", "feeds"))).toEqual(["grammar.pc_distractor_outside_table"]);
    expect(validate(pcChoice("now_or_usually_more", "Look! Ola ___ the dog.", "is walking", "is feeding"))).toEqual(["grammar.pc_distractor_outside_table"]);
    expect(validate(pcChoice("now_or_usually", "Ola ___ the dog every day.", "walks", "is walking"))).toEqual([]);
    expect(validate(pcChoice("now_or_usually_more", "Ola ___ the dog on Mondays.", "doesn't walk", "doesn't feed"))).toEqual(["grammar.pc_distractor_outside_table"]);
  });

  it("drugi czasownik po „and” bez podmiotu należy do zdania i ma czas zgodny ze wskaźnikiem", () => {
    expect(validate(pcGap("now_or_usually", "Look! Tom ___ (eat) bread and drinks milk.", "is eating"))).toContain("grammar.pc_tense_marker_mismatch");
    expect(validate(pcGap("now_or_usually", "Look! Tom ___ (eat) bread and milk.", "is eating"))).toEqual([]);
  });

  it("„police” to liczba mnoga", () => {
    expect(validate(pcGap("affirmative", "Look! The police ___ (help) the boy.", "are helping"))).toEqual([]);
    expect(validate(pcGap("affirmative", "Look! The police ___ (help) the boy.", "is helping"))).toEqual(["grammar.pc_be_form_subject"]);
  });

  it("fałszywe odrzucenia: cytowane „Look!”, rzeczownik na -s, like / own, przysłówek po be, wykrzyknienie „What a…!”", () => {
    expect(validate(pcGap("now_or_usually", "\"Look!\" Ola ___ (read) a comic.", "is reading"))).toEqual([]);
    expect(validate(pcGap("now_or_usually", "Ola ___ (walk) like a duck every day.", "walks"))).toEqual([]);
    expect(validate(pcGap("now_or_usually", "Tom ___ (clean) his own room every day.", "cleans"))).toEqual([]);
    expect(validate(pcTranslation("affirmative", "Patrz! Wszystkie dzieci się bawią.", "Look! The children are all playing."))).toEqual([]);
    expect(validate(pcTranslation("affirmative", "Mama teraz czyta.", "Mum is now reading.", ["Mum is reading now.", "Mum is reading right now.", "Mum is reading at the moment."]))).toEqual([]);
    expect(validate(pcTranslation("affirmative", "Ale bałagan! Tom teraz maluje.", "What a mess! Tom is painting now.", [
      "What a mess! Tom is painting right now.",
      "What a mess! Tom is painting at the moment.",
    ]))).toEqual([]);
  });
});
