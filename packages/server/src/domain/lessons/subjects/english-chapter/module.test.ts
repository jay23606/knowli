import { describe, expect, it } from "vitest";
import { validateSubject } from "../../catalog-validation";
import { lessonExerciseIdentity, lessonIdentityOptionsOf } from "../../exercise-identity";
import { poolCoverage, validatePool } from "../../pool-validation";
import { resolveLessonTopic, validateDynamicTopicData } from "../../topic-resolution";
import type { DynamicTopicData, LessonExerciseDraft, LessonExerciseType } from "../../types";
import { englishNormalizer } from "../english/normalizer";
import { createProductionSubjectRegistry, PRODUCTION_SUBJECTS } from "../index";
import { chapterExposureText, normalizeChapterExposureText } from "./exposure";
import { ruleOf, type RuleId } from "../../rules/catalog";
import { englishChapterSubject } from "./module";
import { refineChapterPool, validateChapterExercise } from "./validators";

const WEATHER = "english_chapter.ddeck.weather";
const WEARING = "english_chapter.ddeck.wearing";
const DAYS = "english_chapter.ddeck.days";

const cards = [
  { title: "Słówka", body: "raining — pada deszcz\nsunny — słonecznie" },
  { title: "Przykład", body: "It's sunny today. — Dziś jest słonecznie." },
];

const DATA: DynamicTopicData = {
  titlePl: "Unit 1",
  objectives: [
    { id: WEATHER, titlePl: "Pogoda", descriptionEn: "Weather words.", kind: "words", cards },
    { id: WEARING, titlePl: "Co mam na sobie?", descriptionEn: "Frame: I'm wearing (a) ...", kind: "frame", cards },
    { id: DAYS, titlePl: "Dni tygodnia", descriptionEn: "Days of the week.", cards },
  ],
};

const WORDS_TYPES: LessonExerciseType[] = [
  "lesson_card", "lesson_match", "lesson_group", "lesson_choice", "lesson_listen_choice", "lesson_cloze", "lesson_gap", "lesson_open_answer",
];
const FRAME_TYPES: LessonExerciseType[] = [
  "lesson_card", "lesson_match", "lesson_order", "lesson_choice", "lesson_listen_choice", "lesson_cloze", "lesson_gap", "lesson_open_answer",
];


/** Opis reguły katalogu (rdzeń, lekcja albo przedmiot) — tekst, który dostaje model w księdze reguł. */
function ruleText(id: string): string {
  const rule = ruleOf(englishChapterSubject, id as RuleId);
  if (rule === undefined) throw new Error(`brak reguły ${id}`);
  return typeof rule.description === "string" ? rule.description : rule.description({ answerMaxLength: 120, groundingRequired: false });
}

describe("przedmiot english_chapter", () => {
  it("jest w rejestrze produkcyjnym, który się buduje", () => {
    expect(PRODUCTION_SUBJECTS).toContain(englishChapterSubject);
    const registry = createProductionSubjectRegistry();
    expect(registry.getSubject("english_chapter")).toBe(englishChapterSubject);
    expect(validateSubject(englishChapterSubject)).toEqual([]);
  });

  it("ma ustalone pola modułu", () => {
    expect(englishChapterSubject).toMatchObject({
      id: "english_chapter",
      titlePl: "Angielski — rozdział",
      answerLocale: "en-GB",
      promptLocale: "pl-PL",
      topics: [],
      poolDeduplication: "exercise",
      poolMinimums: { guided: 3, productive: 3, independent: 2 },
      sourceQuotes: false,
      instructionIsStimulus: true,
      openAnswerPromptLocale: "pl-PL",
      materialSubjectTitle: "fixed",
      ttsForAnswers: false,
      ttsForPrompts: false,
      // Pełne angielskie zdanie po odpowiedzi (Etap 3, mechanizm #194).
      ttsForFeedbackSentence: true,
      exerciseExplanations: true,
    });
    expect(englishChapterSubject.usesV3Payload).toBeUndefined();
    expect(englishChapterSubject.spokenAnswers).toBeUndefined();
    expect(englishChapterSubject.normalizer).toBe(englishNormalizer);
    expect([...englishChapterSubject.exerciseTypes].sort()).toEqual([
      "lesson_card", "lesson_choice", "lesson_cloze", "lesson_gap", "lesson_group", "lesson_listen_choice", "lesson_match", "lesson_open_answer", "lesson_order",
    ]);
    expect(englishChapterSubject.errorCategories).toEqual([
      { code: "wrong_word", labelPl: "Pomylone słowo" },
      { code: "spelling", labelPl: "Pisownia" },
    ]);
    expect(englishChapterSubject.validateExercise).toBe(validateChapterExercise);
    expect(englishChapterSubject.refineGeneratedPool).toBe(refineChapterPool);
    expect(englishChapterSubject.exposureText).toBe(chapterExposureText);
    expect(englishChapterSubject.normalizeExposureText).toBe(normalizeChapterExposureText);
  });

  it("profil promptów opisuje bodziec w poleceniu, typy z gałęzią schematu i rodzaje zagadnień", () => {
    const prompts = englishChapterSubject.prompts;
    expect(Object.keys(prompts.typeRules ?? {}).sort()).toEqual(["lesson_cloze", "lesson_group", "lesson_match"]);
    expect(prompts.typeRules?.lesson_match).toContain("Polish meaning");
    expect(prompts.typeRules?.lesson_group).toContain("labels are in Polish");
    // Reguły egzekwowane opisuje katalog reguł (księga reguł promptu), nie profil promptów (spec katalogu reguł §3).
    expect(ruleText("chapter.hint_not_allowed")).toContain("Leave hint out");
    expect(ruleText("chapter.stem_single_gap")).toContain("exactly one gap");
    expect(prompts.fieldRules).not.toContain("hint is always null");
    expect(prompts.fieldRules).toContain("Wpisz brakujące słowo.");
    expect(prompts.objectivesRules).toContain("3 to 6 objectives");
    expect(prompts.objectivesRules).toContain("'words'");
    expect(prompts.objectivesRules).toContain("'frame'");
    // Prompt mówi, co odrzuca walidacja słownikowa (review Task 5).
    expect(prompts.generationRole).toContain("Never use people's names, or numbers and other words that are not in the material");
    expect(prompts.generationRole).toContain("closed types have exactly one correct option");
    // focus tłumaczenia: ciągłość sprawdza reguła rdzenia, profil mówi, który fragment wybrać.
    expect(prompts.fieldRules).toContain("focus is the run of the answer's words that holds the checked word or the frame part");
    // Różnorodność luk i wiarygodne dystraktory (próba na prawdziwym modelu: 6 luk „wearing”, dystraktory z innej klasy).
    expect(prompts.fieldRules).toContain("no more than 2 lesson_gap exercises of one objective may have the same answer");
    expect(prompts.fieldRules).toContain("which part of the frame the gap checks");
    expect(prompts.fieldRules).toContain("never a function word alone");
    expect(prompts.fieldRules).toContain("Distractors must be plausible: the same category as the correct option");
    expect(prompts.typeRules?.lesson_match).toContain("extraRight distractors are plausible");
    expect(prompts.typeRules?.lesson_cloze).toContain("same category as the gap words");
    // Układanka: 4–7 klocków, bez końcowej kropki/pytajnika sklejonego z ostatnim klockiem; powtórzony klocek odrzuca reguła.
    expect(prompts.fieldRules).toContain("(4 to 7 items)");
    expect(ruleText("chapter.order_items_distinct")).toContain("different text");
    expect(prompts.fieldRules).not.toContain("sentence-final punctuation");
    expect(ruleText("order.tile_no_final_punctuation")).toContain("never 'coat.' or 'like?'");
    // Pola v3, słowa funkcyjne i powtórzone słowo banku sprawdzają reguły z katalogu.
    expect(prompts.fieldRules).not.toContain("sourceRefs are ALWAYS null");
    expect(prompts.typeRules?.lesson_cloze).not.toContain("appears nowhere else in the text");
    expect(ruleText("chapter.function_words_only")).toContain("not only function words");
    // Tłumaczenie zawsze ma stałe polecenie (próba: model zwracał null, dziecko widziało tylko tytuł zagadnienia).
    expect(prompts.fieldRules).toContain("lesson_open_answer: instructionPl is exactly 'Przetłumacz na angielski.'");
    expect(ruleText("chapter.translation_instruction_required")).toContain("instructionPl");
    // Polskie zdanie-bodziec w poleceniu: regułę opisuje katalog, profil daje przykłady naturalnych zdań.
    expect(ruleText("chapter.instruction_stimulus")).toContain("instructionPl carries the Polish stimulus sentence");
    expect(prompts.typeRules?.lesson_cloze).toContain("instructionPl gives the Polish meaning of the whole text, then a short command");
    expect(prompts.typeRules?.lesson_cloze).toContain("W poniedziałek pada deszcz. W środę wieje wiatr. Uzupełnij tekst.");
    // Tekst z lukami: 2–3 krótkie zdania mieszczące się w limicie polecenia (liczbę podaje reguła field.max_length).
    expect(prompts.typeRules?.lesson_cloze).toContain("Use 2 or 3 short sentences built on the chapter's frames");
    expect(prompts.typeRules?.lesson_cloze).toContain("fits its length limit");
    expect(prompts.typeRules?.lesson_cloze).toContain("Every gap is fixed by that Polish meaning");
    expect(prompts.typeRules?.lesson_cloze).toContain("no extra word may match the Polish meaning of any gap");
    // Pary pytanie ↔ odpowiedź: dodatkowa odpowiedź nie pasuje do żadnego pytania.
    expect(prompts.typeRules?.lesson_match).toContain("An extraRight item is never a correct partner of any left item");
    expect(prompts.typeRules?.lesson_match).toContain("never a valid answer to any listed question");
    expect(prompts.typeRules?.lesson_match).not.toContain("another answer to the same kind of question");
    // Karty: wzór ramy z angielskimi przykładami bez tłumaczeń; żadna karta nie niesie pary zdań polskie → angielskie.
    expect(prompts.objectivesRules).toContain("for 'frame' the pattern with 1 to 3 English examples from the material WITHOUT their Polish translations");
    expect(prompts.objectivesRules).toContain("No card contains a Polish sentence together with its English translation");
    expect(prompts.objectivesRules).not.toContain("and their Polish meaning");
    expect(prompts.gradingRole).toContain("at most 'almost'");
    expect(prompts.almostDefinition).toContain("errorCategory null");
  });

  it("profil promptów opisuje regułę wyboru ze słuchu, a ograniczenia typu niesie katalog reguł", () => {
    const rules = englishChapterSubject.prompts.fieldRules ?? "";
    expect(rules).toContain("lesson_listen_choice");
    expect(rules).toMatch(/at most 12 words/);
    expect(rules).toContain("each a word or phrase from the chapter material, as in lesson_choice");
    expect(rules).not.toContain("checkedElements");
    expect(ruleText("listen.gap_count")).toContain("exactly one gap");
    expect(ruleText("listen.option_apostrophe")).toContain("apostrophe");
    expect(ruleText("listen.instruction_not_allowed")).toContain("instructionPl");
    expect(ruleText("listen.hint_not_allowed")).toContain("hears the sentence");
    expect(ruleText("visual.choice_only")).toContain("only with lesson_choice");
  });

  it("buildDynamicTopic przypisuje typy według rodzaju zagadnienia (brak rodzaju = słowa)", () => {
    const topic = englishChapterSubject.buildDynamicTopic!(DATA);
    expect(topic.id).toBe("dynamic");
    expect(topic.titlePl).toBe("Unit 1");
    const byId = new Map(topic.objectives.map((objective) => [objective.id, objective]));
    expect(byId.get(WEATHER)?.exerciseTypes).toEqual(WORDS_TYPES);
    expect(byId.get(WEARING)?.exerciseTypes).toEqual(FRAME_TYPES);
    expect(byId.get(DAYS)?.exerciseTypes).toEqual(WORDS_TYPES);
    expect(byId.get(WEARING)?.cards).toEqual(cards);
  });

  it("każde zagadnienie przechodzi walidację katalogu i ma podpowiedź dla każdej kategorii", () => {
    const topic = englishChapterSubject.buildDynamicTopic!(DATA);
    expect(validateSubject({ ...englishChapterSubject, topics: [topic] })).toEqual([]);
    expect(validateDynamicTopicData(englishChapterSubject, DATA)).toEqual([]);
    for (const objective of topic.objectives) {
      expect(objective.errorCategories).toEqual(["wrong_word", "spelling", "incomplete", "wrong_order"]);
      for (const category of [...objective.errorCategories, "other"]) {
        expect(objective.hints[category], category).toMatch(/\S/);
      }
    }
    expect(topic.objectives[0]!.hints).toMatchObject({
      // Dziecko nie otworzy karty w trakcie sesji, więc podpowiedź odsyła do pamięci.
      wrong_word: "To inne słowo. Przypomnij sobie słowa z karty.",
      spelling: "Sprawdź litery w tym słowie.",
      incomplete: "Brakuje słowa. Dopisz je.",
      wrong_order: "Słowa są w złej kolejności.",
      other: "Spróbuj jeszcze raz.",
    });
  });

  it("temat rozwiązuje się przez rejestr z zapisanego kontekstu", () => {
    const resolved = resolveLessonTopic(createProductionSubjectRegistry(), {
      subjectId: "english_chapter",
      topicId: "dynamic",
      topicVersion: 1,
      dynamicTopic: DATA,
    });
    expect(resolved?.subject).toBe(englishChapterSubject);
    expect(resolved?.topic.objectives.map((objective) => objective.id)).toEqual([WEATHER, WEARING, DAYS]);
  });

  it("to samo zdanie z innym polskim bodźcem to dwa różne ćwiczenia", () => {
    const options = lessonIdentityOptionsOf(englishChapterSubject);
    const base: LessonExerciseDraft = {
      exerciseType: "lesson_gap", objectiveId: WEARING, instructionPl: "Mam na sobie płaszcz. Wpisz brakujące słowo.",
      stem: "I'm wearing a ___.", answer: "coat", acceptedAnswers: [], focus: ["coat"],
    };
    const other = { ...base, instructionPl: "Mam na sobie czapkę. Wpisz brakujące słowo.", answer: "hat", focus: ["hat"] };
    expect(lessonExerciseIdentity(base, options)).not.toBe(lessonExerciseIdentity(other, options));
  });
});

describe("pula rozdziału przechodzi walidację silnika", () => {
  const topic = englishChapterSubject.buildDynamicTopic!(DATA);
  const common = { acceptedAnswers: [] as string[], focus: [] as string[] };

  const weatherPool: LessonExerciseDraft[] = [
    {
      ...common, exerciseType: "lesson_match", objectiveId: WEATHER, instructionPl: "Połącz słowa w pary.",
      pairs: [
        { left: "raining", right: "pada deszcz" },
        { left: "sunny", right: "słonecznie" },
        { left: "windy", right: "wietrznie" },
      ],
      extraRight: ["śnieżnie"],
      answer: "raining, sunny, windy",
    },
    {
      ...common, exerciseType: "lesson_group", objectiveId: WEATHER, instructionPl: "Co założysz? Pogrupuj.",
      groups: [{ id: "g1", label: "Na słońce" }, { id: "g2", label: "Na deszcz" }],
      groupItems: [
        { text: "T-shirt", groupId: "g1" }, { text: "shorts", groupId: "g1" },
        { text: "boots", groupId: "g2" }, { text: "coat", groupId: "g2" },
      ],
      answer: "Na słońce / Na deszcz",
    },
    {
      ...common, exerciseType: "lesson_cloze", objectiveId: WEATHER, instructionPl: "Dziś jest słonecznie. Mam na sobie koszulkę. Uzupełnij tekst.",
      clozeText: "It's ___ today. I'm wearing my ___.", gapAnswers: ["sunny", "T-shirt"], extraWords: ["boots"],
      answer: "sunny, T-shirt",
    },
    {
      ...common, exerciseType: "lesson_choice", objectiveId: WEATHER, instructionPl: "Dziś pada deszcz. Wybierz słowo.",
      stem: "It's ___ today.", options: [{ id: "a", text: "raining" }, { id: "b", text: "sunny" }, { id: "c", text: "windy" }],
      correctOption: "a", answer: "raining",
    },
    {
      exerciseType: "lesson_gap", objectiveId: WEATHER, instructionPl: "Dziś jest wietrznie. Wpisz brakujące słowo.",
      stem: "It's ___ today.", answer: "windy", acceptedAnswers: [], focus: ["windy"],
    },
    {
      exerciseType: "lesson_gap", objectiveId: WEATHER, instructionPl: "Dziś jest słonecznie. Wpisz brakujące słowo.",
      stem: "It's ___ today.", answer: "sunny", acceptedAnswers: [], focus: ["sunny"],
    },
    {
      exerciseType: "lesson_gap", objectiveId: WEATHER, instructionPl: "Pada deszcz. Wpisz brakujące słowo.",
      stem: "It's ___.", answer: "raining", acceptedAnswers: [], focus: ["raining"],
    },
    {
      exerciseType: "lesson_open_answer", objectiveId: WEATHER, instructionPl: "Przetłumacz na angielski.", prompt: "Dziś jest słonecznie.",
      answer: "It's sunny today.", acceptedAnswers: ["Today it's sunny."], focus: ["sunny"],
    },
    {
      exerciseType: "lesson_open_answer", objectiveId: WEATHER, instructionPl: "Przetłumacz na angielski.", prompt: "Jest wietrznie.",
      answer: "It's windy.", acceptedAnswers: [], focus: ["windy"],
    },
  ];

  it("ćwiczenia wszystkich typów są poprawne i pokrywają minima 3/3/2", () => {
    const { valid, rejected } = validatePool(weatherPool, englishChapterSubject, topic);
    expect(rejected).toEqual([]);
    expect(valid).toHaveLength(weatherPool.length);
    const material = "It's raining. It's sunny. It's windy. Today. T-shirt, shorts, boots, coat, my";
    expect(refineChapterPool(weatherPool, { material }).rejected).toEqual([]);
    expect(poolCoverage(valid, [WEATHER], englishChapterSubject.poolMinimums!)).toEqual([]);
  });
});
