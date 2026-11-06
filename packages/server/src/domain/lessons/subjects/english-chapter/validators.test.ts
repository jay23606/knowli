import { describe, expect, it } from "vitest";
import { V3_EXERCISE_FIELDS, validateLessonExercise, validateLessonExerciseIssues, validatePool } from "../../pool-validation";
import { clip, messagesOf } from "../../rules/catalog";
import type { DynamicTopicData, LessonExerciseDraft } from "../../types";
import { englishChapterSubject } from "./module";
import { GENERIC_CHAPTER_INSTRUCTIONS, refineChapterPool, TRANSLATION_INSTRUCTION, UNSOLICITED_V3_FIELDS, validateChapterExercise } from "./validators";

const WEATHER = "english_chapter.ddeck.weather";
const WEARING = "english_chapter.ddeck.wearing";

const DATA: DynamicTopicData = {
  titlePl: "Unit 1",
  objectives: [
    {
      id: WEATHER,
      titlePl: "Pogoda",
      descriptionEn: "Weather words: raining, sunny, windy.",
      kind: "words",
      cards: [
        { title: "Słówka", body: "raining — pada deszcz\nsunny — słonecznie" },
        { title: "Jeszcze", body: "windy — wietrznie" },
      ],
    },
    {
      id: WEARING,
      titlePl: "Co mam na sobie?",
      descriptionEn: "Frame: I'm wearing (a) ...",
      kind: "frame",
      cards: [
        { title: "Wzór", body: "I'm wearing (a) …" },
        { title: "Przykład", body: "I'm wearing a coat. — Mam na sobie płaszcz." },
      ],
    },
  ],
};
const TOPIC = englishChapterSubject.buildDynamicTopic!(DATA);

/** Komunikaty dla rodzica z walidatora rozdziału (napisy sprzed katalogu reguł). */
const chapterMessages = (ex: LessonExerciseDraft) => messagesOf(validateChapterExercise(ex, TOPIC));

function choice(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_choice",
    objectiveId: WEATHER,
    instructionPl: "Dziś pada deszcz. Wybierz słowo.",
    stem: "It's ___ today.",
    options: [
      { id: "a", text: "raining" },
      { id: "b", text: "sunny" },
    ],
    correctOption: "a",
    answer: "raining",
    acceptedAnswers: [],
    focus: [],
    ...overrides,
  };
}

function listen(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_listen_choice",
    objectiveId: WEATHER,
    stem: "It's ___ today.",
    options: [
      { id: "a", text: "raining" },
      { id: "b", text: "sunny" },
    ],
    correctOption: "a",
    answer: "raining",
    acceptedAnswers: [],
    focus: ["raining"],
    ...overrides,
  };
}

function gap(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_gap",
    objectiveId: WEATHER,
    instructionPl: "Dziś jest słonecznie. Wpisz brakujące słowo.",
    stem: "It's ___ today.",
    answer: "sunny",
    acceptedAnswers: [],
    focus: ["sunny"],
    ...overrides,
  };
}

function order(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_order",
    objectiveId: WEARING,
    instructionPl: "Ułóż zdanie: Mam na sobie płaszcz.",
    items: [
      { id: "i1", text: "I'm" },
      { id: "i2", text: "wearing" },
      { id: "i3", text: "a" },
      { id: "i4", text: "coat" },
    ],
    answer: "I'm wearing a coat",
    acceptedAnswers: [],
    focus: [],
    ...overrides,
  };
}

function openAnswer(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_open_answer",
    objectiveId: WEARING,
    instructionPl: TRANSLATION_INSTRUCTION,
    prompt: "Mam na sobie płaszcz.",
    answer: "I'm wearing a coat.",
    acceptedAnswers: [],
    focus: ["coat"],
    ...overrides,
  };
}

function cloze(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_cloze",
    objectiveId: WEATHER,
    instructionPl: "Dziś pada deszcz. Jutro jest słonecznie. Uzupełnij tekst.",
    clozeText: "It's ___ today. Tomorrow it's ___.",
    gapAnswers: ["raining", "sunny"],
    extraWords: ["windy"],
    answer: "raining, sunny",
    acceptedAnswers: [],
    focus: [],
    ...overrides,
  };
}

describe("validateChapterExercise", () => {
  it("przepuszcza poprawny wybór, lukę, układankę, tekst z lukami i tłumaczenie — także w pełnej walidacji ćwiczenia", () => {
    for (const ex of [choice(), gap(), order(), cloze(), openAnswer()]) {
      expect(chapterMessages(ex), ex.exerciseType).toEqual([]);
      expect(validateLessonExercise(ex, englishChapterSubject, TOPIC), ex.exerciseType).toEqual([]);
    }
  });

  it("bank słów cloze bez dystraktora równoważnego odpowiedzi luki po rozwinięciu skrótu (#316)", () => {
    const ruleIds = (ex: LessonExerciseDraft) => validateLessonExerciseIssues(ex, englishChapterSubject, TOPIC).map((issue) => issue.rule);
    const contracted = cloze({ instructionPl: "Uzupełnij tekst.", clozeText: "It ___ windy. It's ___ today.", gapAnswers: ["isn't", "sunny"], extraWords: ["is not"] });
    expect(ruleIds(contracted)).toContain("cloze.bank_confusable");
    expect(ruleIds({ ...contracted, extraWords: ["raining"] })).not.toContain("cloze.bank_confusable");
  });

  it("wybór: answer to tekst poprawnej opcji, skrót równoważny przechodzi (#315)", () => {
    const ruleIds = (ex: LessonExerciseDraft) => validateLessonExerciseIssues(ex, englishChapterSubject, TOPIC).map((issue) => issue.rule);
    expect(ruleIds(choice({ correctOption: "b" }))).toContain("answer.correct_option_text");
    expect(ruleIds(choice({ options: [{ id: "a", text: "isn't" }, { id: "b", text: "is" }], stem: "It ___ raining.", answer: "is not" }))).not.toContain("answer.correct_option_text");
  });

  it("wymaga dokładnie jednej luki w zdaniu wyboru", () => {
    const stemErrors = (ex: LessonExerciseDraft) => chapterMessages(ex).filter((e) => e.startsWith("stem:"));
    expect(stemErrors(choice({ stem: "It's ____ and __ today." }))).toHaveLength(1);
    expect(stemErrors(choice({ stem: "It's sunny today." }))).toHaveLength(1);
    expect(stemErrors(choice({ stem: undefined }))).toHaveLength(1);
  });

  it("luka bez znacznika albo z dwoma odpada w walidacji ogólnej — jednym komunikatem", () => {
    const stemErrors = (ex: LessonExerciseDraft) => validateLessonExercise(ex, englishChapterSubject, TOPIC).filter((e) => e.startsWith("stem:"));
    expect(stemErrors(gap({ stem: "It's sunny today." }))).toHaveLength(1);
    expect(stemErrors(gap({ stem: "It's ___ and ___ today." }))).toHaveLength(1);
    // Przedmiot nie powiela reguły silnika dla luki.
    expect(validateChapterExercise(gap({ stem: "It's sunny today." }), TOPIC)).toEqual([]);
  });

  it("eksportuje stałe polecenia typów bez polskiego zdania-bodźca", () => {
    expect(GENERIC_CHAPTER_INSTRUCTIONS).toEqual([
      "Wybierz słowo",
      "Wybierz",
      "Wpisz brakujące słowo",
      "Wpisz słowo",
      "Ułóż zdanie",
      "Uzupełnij",
      "Uzupełnij zdanie",
      "Uzupełnij tekst",
    ]);
  });

  it.each([
    ["choice", choice],
    ["gap", gap],
    ["order", order],
    ["cloze", cloze],
  ] as const)("%s: polecenie musi nieść polskie zdanie-bodziec", (_name, make) => {
    const instructionErrors = (instructionPl: string | undefined) =>
      chapterMessages(make({ instructionPl })).filter((e) => e.startsWith("instructionPl:"));
    expect(instructionErrors(undefined)).toHaveLength(1);
    expect(instructionErrors("  Wybierz.  ")).toHaveLength(1); // krótsze niż 12 znaków po trim
    for (const generic of GENERIC_CHAPTER_INSTRUCTIONS) {
      expect(instructionErrors(generic), generic).toHaveLength(1);
      expect(instructionErrors(`  ${generic.toUpperCase()}. `), generic).toHaveLength(1);
    }
    expect(instructionErrors("Pada deszcz. Wybierz słowo.")).toEqual([]);
  });

  it.each([
    ["choice", choice],
    ["gap", gap],
    ["order", order],
    ["cloze", cloze],
  ] as const)("%s: bodziec to zdanie, po którym jest dalszy tekst (granica zdania)", (_name, make) => {
    const instructionErrors = (instructionPl: string) =>
      chapterMessages(make({ instructionPl })).filter((e) => e.startsWith("instructionPl:"));
    for (const good of ["Mam na sobie zielony kapelusz. Wybierz słowo.", "Ułóż zdanie: Mam na sobie różowy płaszcz.", "Czy pada deszcz? Wpisz brakujące słowo."]) {
      expect(instructionErrors(good), good).toEqual([]);
    }
    // Długie i spoza listy stałych poleceń, ale bez polskiego zdania-bodźca.
    for (const bad of ["Wybierz właściwe słowo.", "Ułóż zdanie z klocków.", "Wpisz brakujące słowo w zdaniu.", "Uzupełnij tekst. ", "Dziś pada deszcz."]) {
      expect(instructionErrors(bad), bad).toHaveLength(1);
    }
  });

  it("nie sprawdza bodźca w typach bez bodźca w poleceniu", () => {
    expect(validateChapterExercise(openAnswer({ instructionPl: "Wpisz" }), TOPIC)).toEqual([]);
  });

  it("tłumaczenie wymaga niepustego polecenia (inaczej dziecko widzi tylko tytuł zagadnienia)", () => {
    const instructionErrors = (instructionPl: string | undefined) =>
      chapterMessages(openAnswer({ instructionPl })).filter((e) => e.startsWith("instructionPl:"));
    expect(instructionErrors(undefined)).toHaveLength(1);
    expect(instructionErrors("   ")).toHaveLength(1);
    expect(instructionErrors(TRANSLATION_INSTRUCTION)).toEqual([]);
  });

  it("odrzuca pole hint (bodziec jest w poleceniu, kartkówka usuwa hint)", () => {
    expect(chapterMessages(gap({ hint: "sun" })).some((e) => e.startsWith("hint:"))).toBe(true);
    expect(chapterMessages(choice({ hint: "pogoda" })).some((e) => e.startsWith("hint:"))).toBe(true);
  });

  it("odrzuca dwa klocki o tym samym tekście po normalizacji", () => {
    const twoA = order({
      instructionPl: "Ułóż zdanie: Mam na sobie czapkę i płaszcz.",
      items: [
        { id: "i1", text: "I'm" },
        { id: "i2", text: "wearing" },
        { id: "i3", text: "a" },
        { id: "i4", text: "hat" },
        { id: "i5", text: "and" },
        { id: "i6", text: "A" },
        { id: "i7", text: "coat" },
      ],
      answer: "I'm wearing a hat and a coat",
    });
    expect(chapterMessages(twoA).some((e) => e.startsWith("items:"))).toBe(true);
  });

  it("odpowiedź i wariant dłuższe niż 120 znaków odpadają w pełnej walidacji — jednym komunikatem", () => {
    const long = `I'm wearing a coat ${"a".repeat(121 - "I'm wearing a coat ".length)}`;
    expect([...long]).toHaveLength(121);
    const fieldErrors = (ex: LessonExerciseDraft, field: string) =>
      validateLessonExercise(ex, englishChapterSubject, TOPIC).filter((e) => e.startsWith(`${field}:`) && e.includes("120"));
    expect(fieldErrors(openAnswer({ answer: long }), "answer")).toHaveLength(1);
    expect(fieldErrors(openAnswer({ acceptedAnswers: [long] }), "acceptedAnswers")).toHaveLength(1);
    expect(validatePool([openAnswer({ answer: long })], englishChapterSubject, TOPIC).valid).toEqual([]);
    expect(validateLessonExercise(openAnswer({ answer: long.slice(0, 120) }), englishChapterSubject, TOPIC)).toEqual([]);
  });
});

describe("zgłoszenia reguł katalogu rozdziału", () => {
  const issuesOf = (ex: LessonExerciseDraft) => validateChapterExercise(ex, TOPIC);

  it("luka w zdaniu wyboru: reguła, pole i found z liczbą luk", () => {
    expect(issuesOf(choice({ stem: "It's ____ and __ today." }))).toEqual([
      expect.objectContaining({
        rule: "chapter.stem_single_gap",
        field: "stem",
        found: `stem ${clip("It's ____ and __ today.")} has 2 gaps, expected exactly one`,
      }),
    ]);
  });

  it("bodziec w poleceniu: found z poleceniem albo informacją o jego braku", () => {
    expect(issuesOf(gap({ instructionPl: "Wybierz słowo" }))[0]).toMatchObject({
      rule: "chapter.instruction_stimulus",
      field: "instructionPl",
      found: `instructionPl ${clip("Wybierz słowo")} carries no Polish stimulus sentence`,
    });
    expect(issuesOf(gap({ instructionPl: undefined }))[0]?.found).toBe("instructionPl is missing");
  });

  it("tłumaczenie bez polecenia, podpowiedź i powtórzony klocek mają własne reguły", () => {
    expect(issuesOf(openAnswer({ instructionPl: undefined }))).toEqual([
      expect.objectContaining({ rule: "chapter.translation_instruction_required", field: "instructionPl" }),
    ]);
    expect(issuesOf(gap({ hint: "sun" }))).toEqual([
      expect.objectContaining({ rule: "chapter.hint_not_allowed", field: "hint", found: `hint ${clip("sun")} is set, but this subject has no hints` }),
    ]);
    const twoA = order({
      instructionPl: "Ułóż zdanie: Mam na sobie kapelusz.",
      items: [{ id: "i1", text: "a" }, { id: "i2", text: "A" }, { id: "i3", text: "hat" }],
    });
    expect(issuesOf(twoA)).toEqual([
      expect.objectContaining({
        rule: "chapter.order_items_distinct",
        field: "items[1].text",
        found: `items[1] ${clip("A")} repeats items[0] ${clip("a")}`,
      }),
    ]);
  });

  it("odrzucenie słownikowe: reguła, ścieżka pola i found z elementem oraz słowem", () => {
    const material = "Weather: It's raining. It's sunny.";
    const outside = refineChapterPool([choice({ options: [{ id: "a", text: "raining" }, { id: "b", text: "snowing" }] })], { material });
    expect(outside.rejected[0]!.issues).toEqual([
      expect.objectContaining({
        rule: "chapter.word_outside_material",
        field: "options[1].text",
        pl: "słowo spoza materiału: snowing",
        found: `options[1].text ${clip("snowing")} contains the word ${clip("snowing")}, which is not in the material`,
      }),
    ]);
    const functionOnly = refineChapterPool([gap({ answer: "the", focus: ["the"] })], { material });
    expect(functionOnly.rejected[0]!.issues).toEqual([
      expect.objectContaining({
        rule: "chapter.function_words_only",
        field: "answer",
        pl: "tylko słowa pomocnicze: the",
        found: `answer ${clip("the")} consists only of function words`,
      }),
    ]);
  });
});

describe("refineChapterPool (walidacja słownikowa świeżej puli)", () => {
  const MATERIAL = "Weather: It's raining. It's sunny. It's windy. Clothes: boots, coat, hat, T-shirt. I'm wearing a coat.";

  it("odrzuca wybór z opcją spoza materiału z powodem dla rodzica", () => {
    const bad = choice({ options: [{ id: "a", text: "raining" }, { id: "b", text: "snowing" }] });
    const result = refineChapterPool([bad], { material: MATERIAL });
    expect(result.kept).toEqual([]);
    expect(result.rejected.map((r) => ({ exercise: r.exercise, issues: messagesOf(r.issues) }))).toEqual([{ exercise: bad, issues: ["słowo spoza materiału: snowing"] }]);
  });

  it("usuwa wariant tłumaczenia spoza materiału i zostawia ćwiczenie", () => {
    const ex = openAnswer({ acceptedAnswers: ["I'm wearing my coat.", "I'm wearing a jacket."] });
    const result = refineChapterPool([ex], { material: MATERIAL });
    expect(result.rejected).toEqual([]);
    expect(result.kept).toEqual([{ ...ex, acceptedAnswers: ["I'm wearing my coat."] }]);
  });

  it("usuwa wariant luki spoza materiału, a odpowiedź spoza materiału odrzuca ćwiczenie", () => {
    const kept = refineChapterPool([gap({ acceptedAnswers: ["sunny", "bright"] })], { material: MATERIAL });
    expect(kept.kept.map((ex) => ex.acceptedAnswers)).toEqual([["sunny"]]);
    const rejected = refineChapterPool([gap({ answer: "foggy", focus: ["foggy"] })], { material: MATERIAL });
    expect(rejected.rejected.map((r) => r.issues[0]?.pl)).toEqual(["słowo spoza materiału: foggy"]);
  });

  it("usuwa WSZYSTKIE niezamówione pola v3 z modelu i zostawia ćwiczenie, także z wariantami", () => {
    // Każde pole z listy czyszczenia jest ustawione, więc test nie przechodzi „na pusto”.
    const unsolicited: Partial<LessonExerciseDraft> = {
      questionType: "fact",
      requiredElements: [{ id: "e1", text: "raining" }],
      supplementaryElements: ["sunny"],
      commonErrors: ["x"],
      expectedForm: "short",
      familyId: "weather",
      sourceRefs: [{ quote: "It's raining." }],
    };
    expect(Object.keys(unsolicited).sort()).toEqual([...UNSOLICITED_V3_FIELDS].sort());
    const withV3 = (ex: LessonExerciseDraft): LessonExerciseDraft => ({ ...ex, ...unsolicited });
    const pool = [withV3(choice()), withV3(openAnswer({ acceptedAnswers: ["I'm wearing my coat.", "I'm wearing a jacket."] }))];
    const result = refineChapterPool(pool, { material: MATERIAL });
    expect(result.rejected).toEqual([]);
    expect(result.kept).toEqual([choice(), openAnswer({ acceptedAnswers: ["I'm wearing my coat."] })]);
    for (const ex of result.kept) {
      for (const field of UNSOLICITED_V3_FIELDS) expect(ex, field).not.toHaveProperty(field);
    }
    // Wyczyszczone ćwiczenie przechodzi walidację ogólną (bez „pole v3 niedozwolone”).
    expect(validateLessonExercise(result.kept[0]!, englishChapterSubject, TOPIC)).toEqual([]);
    // Z polami v3 przed czyszczeniem walidacja ogólna odrzuciłaby całość — każde pole z osobna.
    const before = validateLessonExercise(pool[0]!, englishChapterSubject, TOPIC);
    for (const field of UNSOLICITED_V3_FIELDS) {
      expect(before.some((error) => error.startsWith(`${field}:`)), field).toBe(true);
    }
  });

  it("lista czyszczenia pól v3 to lista walidacji ogólnej bez calculation, a calculation zostaje do odrzucenia", () => {
    expect([...UNSOLICITED_V3_FIELDS]).toEqual(V3_EXERCISE_FIELDS.filter((field) => field !== "calculation"));
    const withCalculation = choice({ calculation: { kind: "scale_to_distance" } as unknown as LessonExerciseDraft["calculation"] });
    const result = refineChapterPool([withCalculation], { material: MATERIAL });
    expect(result.kept).toEqual([withCalculation]);
    expect(validateLessonExercise(result.kept[0]!, englishChapterSubject, TOPIC).some((error) => error.startsWith("calculation"))).toBe(true);
  });

  it("tłumaczenie bez polecenia dostaje stałe „Przetłumacz na angielski.”, inne typy nie", () => {
    expect(TRANSLATION_INSTRUCTION).toBe("Przetłumacz na angielski.");
    const missing = openAnswer({ instructionPl: undefined });
    const blank = openAnswer({ instructionPl: "  " });
    const own = openAnswer({ instructionPl: "Napisz po angielsku." });
    const result = refineChapterPool([missing, blank, own, gap({ instructionPl: undefined })], { material: MATERIAL });
    expect(result.rejected).toEqual([]);
    expect(result.kept.map((ex) => ex.instructionPl)).toEqual([TRANSLATION_INSTRUCTION, TRANSLATION_INSTRUCTION, "Napisz po angielsku.", undefined]);
    // Uzupełnione tłumaczenie przechodzi walidację przedmiotu.
    expect(validateChapterExercise(result.kept[0]!, TOPIC)).toEqual([]);
    // Wejście nie jest modyfikowane, a ćwiczenie z poleceniem wraca bez kopii.
    expect(missing.instructionPl).toBeUndefined();
    expect(result.kept[2]).toBe(own);
  });

  it("zostawia ćwiczenia zgodne z materiałem bez zmian", () => {
    const pool = [choice(), gap(), order(), openAnswer()];
    const result = refineChapterPool(pool, { material: MATERIAL });
    expect(result.rejected).toEqual([]);
    expect(result.kept).toEqual(pool);
  });

  it("sprawdza lewe strony par, elementy grup, słowa luk i pułapki oraz zdanie układanki", () => {
    const match: LessonExerciseDraft = {
      exerciseType: "lesson_match", objectiveId: WEATHER, instructionPl: "Połącz w pary.",
      pairs: [
        { left: "raining", right: "pada deszcz" },
        { left: "sunny", right: "słonecznie" },
        { left: "cloudy", right: "pochmurno" },
      ],
      answer: "raining, sunny, cloudy", acceptedAnswers: [], focus: [],
    };
    const group: LessonExerciseDraft = {
      exerciseType: "lesson_group", objectiveId: WEATHER, instructionPl: "Pogrupuj.",
      groups: [{ id: "g1", label: "Ciepło" }, { id: "g2", label: "Zimno" }],
      groupItems: [
        { text: "T-shirt", groupId: "g1" }, { text: "hat", groupId: "g1" },
        { text: "boots", groupId: "g2" }, { text: "scarf", groupId: "g2" },
      ],
      answer: "Ciepło / Zimno", acceptedAnswers: [], focus: [],
    };
    const cloze: LessonExerciseDraft = {
      exerciseType: "lesson_cloze", objectiveId: WEATHER, instructionPl: "Uzupełnij tekst.",
      clozeText: "It's ___ today. I'm wearing ___.", gapAnswers: ["sunny", "a T-shirt"], extraWords: ["gloves"],
      answer: "sunny, a T-shirt", acceptedAnswers: [], focus: [],
    };
    const badOrder = order({
      items: [{ id: "i1", text: "I'm" }, { id: "i2", text: "wearing" }, { id: "i3", text: "a" }, { id: "i4", text: "jacket" }],
      answer: "I'm wearing a jacket",
    });
    const result = refineChapterPool([match, group, cloze, badOrder], { material: MATERIAL });
    expect(result.kept).toEqual([]);
    expect(result.rejected.map((r) => r.issues[0]?.pl)).toEqual([
      "słowo spoza materiału: cloudy",
      "słowo spoza materiału: scarf",
      "słowo spoza materiału: gloves",
      "słowo spoza materiału: jacket",
    ]);
    // Prawa strona par i etykiety grup są po polsku — nie podlegają słownikowi.
    const okMatch = { ...match, pairs: match.pairs!.slice(0, 2).concat({ left: "windy", right: "wietrznie" }) };
    expect(refineChapterPool([okMatch], { material: MATERIAL }).kept).toEqual([okMatch]);
  });

  it("element bez słowa treści ma osobny powód „tylko słowa pomocnicze”", () => {
    const articles = choice({ stem: "I'm wearing ___ coat.", options: [{ id: "a", text: "a" }, { id: "b", text: "the" }] });
    expect(refineChapterPool([articles], { material: MATERIAL }).rejected.map((r) => r.issues[0]?.pl)).toEqual([
      "tylko słowa pomocnicze: a",
    ]);
    // Także przyimki, operatory i zaimki wskazujące (review Task 5).
    for (const texts of [["in", "on", "at"], ["do", "does"], ["this", "that"], ["It's", "He's"]]) {
      const ex = choice({ stem: "___ coat.", options: texts.map((text, index) => ({ id: `o${index}`, text })) });
      expect(refineChapterPool([ex], { material: MATERIAL }).rejected[0]?.issues[0]?.pl, texts.join("/")).toBe(`tylko słowa pomocnicze: ${texts[0]!.toLowerCase()}`);
    }
  });

  it("ogranicza długość powodu do 80 znaków (słowo modelu nie tworzy dowolnie długich kluczy)", () => {
    const word = "x".repeat(200);
    const result = refineChapterPool([choice({ options: [{ id: "a", text: "raining" }, { id: "b", text: word }] })], { material: MATERIAL });
    const reason = result.rejected[0]!.issues[0]!.pl;
    expect([...reason].length).toBeLessThanOrEqual(80);
    expect(reason.startsWith("słowo spoza materiału: xxx")).toBe(true);
    expect(reason.endsWith("…")).toBe(true);
  });

  it("nie wywraca się na szkicu bez pól typu (kształt sprawdza walidacja puli)", () => {
    const bare = choice({ options: undefined });
    expect(refineChapterPool([bare], { material: MATERIAL }).kept).toEqual([bare]);
  });

  it("wybór ze słuchu: słowo spoza materiału w opcji odrzuca ćwiczenie, zgodne wraca bez kopii", () => {
    const ok = listen();
    expect(refineChapterPool([ok], { material: MATERIAL })).toEqual({ kept: [ok], rejected: [] });
    const bad = listen({ options: [{ id: "a", text: "raining" }, { id: "b", text: "snowing" }] });
    const result = refineChapterPool([bad], { material: MATERIAL });
    expect(result.kept).toEqual([]);
    expect(result.rejected.map((r) => ({ exercise: r.exercise, issues: messagesOf(r.issues) }))).toEqual([{ exercise: bad, issues: ["słowo spoza materiału: snowing"] }]);
  });

  it("wybór ze słuchu nie zawęża wariantów odpowiedzi (nie jest typem wariantowym)", () => {
    const ex = listen({ acceptedAnswers: ["bright"] });
    expect(refineChapterPool([ex], { material: MATERIAL }).kept).toEqual([ex]);
  });
});

describe("wybór ze słuchu w przedmiocie rozdziału", () => {
  it("nie wymaga polskiego bodźca w poleceniu — bodźcem jest nagranie", () => {
    expect(validateChapterExercise(listen(), TOPIC)).toEqual([]);
    expect(validateLessonExercise(listen(), englishChapterSubject, TOPIC)).toEqual([]);
  });

  it("polecenie, podpowiedź i pole obrazka są niedozwolone", () => {
    expect(validateLessonExercise(listen({ instructionPl: "Dziś pada deszcz. Wybierz słowo." }), englishChapterSubject, TOPIC)).not.toEqual([]);
    expect(validateChapterExercise(listen({ hint: "rain" }), TOPIC)).not.toEqual([]);
  });

  it("odrzuca końcówkę -s przed sybilantem za luką (reguła wymowy wspólna z gramatyką)", () => {
    const merging = listen({
      stem: "My ___ sleep a lot.",
      options: [{ id: "a", text: "cats" }, { id: "b", text: "cat" }],
      answer: "cats",
      focus: ["cats"],
    });
    expect(chapterMessages(merging).some((e) => e.includes("różnica niesłyszalna"))).toBe(true);
  });
});

