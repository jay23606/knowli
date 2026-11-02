import { describe, expect, it } from "vitest";
import {
  GAP_MARKER,
  MAX_ACCEPTED_ANSWERS,
  MAX_NOTICE_SEGMENTS,
  MAX_NOTICE_SENTENCES,
  MAX_OPTIONS,
  MAX_ORDER_ITEMS,
  MAX_TEXT_LENGTH,
  MIN_NOTICE_SENTENCES,
  MIN_OPTIONS,
  MIN_ORDER_ITEMS,
  findDuplicateAnswers,
  poolCoverage,
  validateLessonExercise,
  validatePool,
  withoutRedundantAcceptedVariants,
} from "./pool-validation";
import { englishGrammarSubject } from "./subjects/english-grammar/module";
import { schoolSubject } from "./subjects/school/module";
import { historyLikeSubject } from "./testing/history-like-subject";
import type { LessonExerciseDraft, LessonTopic, SubjectModule } from "./types";
import { stageOf } from "./stages";

const englishTopic = englishGrammarSubject.topics[0]!;
const historyTopic = historyLikeSubject.topics[0]!;

const OBJ = {
  affirmative: "english_grammar.present_simple.affirmative_base",
  thirdPerson: "english_grammar.present_simple.third_person_s",
  negative: "english_grammar.present_simple.negative",
  spelling: "english_grammar.present_simple.spelling_es_ies",
} as const;

/** Bazowy poprawny szkic danego typu dla celu angielskiego (nadpisywany w testach). */
function draft(overrides: Partial<LessonExerciseDraft>): LessonExerciseDraft {
  return {
    exerciseType: "lesson_gap",
    objectiveId: OBJ.thirdPerson,
    answer: "plays",
    acceptedAnswers: [],
    focus: ["plays"],
    stem: `She ${GAP_MARKER} tennis.`,
    hint: "play",
    ...overrides,
  };
}

describe("validateLessonExercise — cel i typ", () => {
  it("rejects calculation payload in grammar, including on an existing grammar type", () => {
    const calculation = { kind: "unit_conversion", params: { value: 2, fromUnit: "km" }, unit: "m", templateFamilyId: "units" } as const;
    for (const exerciseType of ["lesson_gap", "lesson_calculation"] as const) {
      const errors = validateLessonExercise(draft({ exerciseType, calculation }), englishGrammarSubject, englishTopic);
      expect(errors.some((error) => error.includes("calculation") && error.includes("v3"))).toBe(true);
    }
  });
  it.each(["lesson_choice", "lesson_open_answer", "lesson_error_fix"] as const)("odrzuca %s bez treści bodźca", (exerciseType) => {
    const errors = validateLessonExercise(draft({ exerciseType, stem: undefined, prompt: undefined, statement: "",
      options: [{ id: "a", text: "plays" }, { id: "b", text: "play" }], correctOption: "a" }), englishGrammarSubject, englishTopic);
    expect(errors.some((error) => /stem|prompt|statement/.test(error))).toBe(true);
  });
  it.each(["answer", "acceptedAnswers", "options"])("odrzuca przekroczenie limitu tekstu w %s", (field) => {
    const long = "x".repeat(121); // gramatyka: wszystkie pola ≤ 120 (limit 300 dotyczy tylko przedmiotów v3)
    const overrides = field === "answer" ? { answer: long, focus: [long] }
      : field === "acceptedAnswers" ? { acceptedAnswers: [long] }
      : { options: [{ id: "a", text: "plays" }, { id: "b", text: long }] };
    const errors = validateLessonExercise(draft({ exerciseType: "lesson_choice", correctOption: "a",
      options: [{ id: "a", text: "plays" }, { id: "b", text: "play" }], ...overrides }), englishGrammarSubject, englishTopic);
    expect(errors.some((error) => error.includes("120"))).toBe(true);
  });
  it("visualSubject jest dozwolony tylko dla lesson_choice", () => {
    const gapErrors = validateLessonExercise(draft({ visualSubject: "girl" }), englishGrammarSubject, englishTopic);
    expect(gapErrors.some((e) => e.includes("visualSubject"))).toBe(true);
    const choiceErrors = validateLessonExercise(draft({
      exerciseType: "lesson_choice",
      stem: "___ is happy.",
      visualSubject: "girl",
      answer: "is",
      focus: ["is"],
      hint: undefined,
      options: [{ id: "a", text: "is" }, { id: "b", text: "are" }],
      correctOption: "a",
    }), englishGrammarSubject, englishTopic);
    expect(choiceErrors.some((e) => e.includes("visualSubject"))).toBe(false);
  });

  it("odrzuca cel spoza tematu", () => {
    const errors = validateLessonExercise(
      draft({ objectiveId: "english_grammar.present_simple.nieistniejacy" }),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.includes("cel"))).toBe(true);
  });

  it("przyjmuje istniejący cel i dozwolony typ", () => {
    expect(validateLessonExercise(draft({}), englishGrammarSubject, englishTopic)).toEqual([]);
  });

  it("odrzuca typ niedozwolony dla celu", () => {
    // affirmative_base nie wspiera lesson_error_fix
    const errors = validateLessonExercise(
      draft({
        objectiveId: OBJ.affirmative,
        exerciseType: "lesson_error_fix",
        statement: "I plays football.",
        answer: "I play football",
        focus: ["play"],
        stem: undefined,
        hint: undefined,
      }),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.includes("typ"))).toBe(true);
  });

  it("odrzuca lesson_card jako ćwiczenie puli", () => {
    const errors = validateLessonExercise(
      draft({ exerciseType: "lesson_card", stem: undefined, hint: undefined, focus: [] }),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.includes("lesson_card"))).toBe(true);
  });
});

describe("validateLessonExercise — focus", () => {
  it("odrzuca pusty focus dla typu tekstowego", () => {
    const errors = validateLessonExercise(draft({ focus: [] }), englishGrammarSubject, englishTopic);
    expect(errors.some((e) => e.toLowerCase().includes("focus"))).toBe(true);
  });

  it("odrzuca focus niebędący podsekwencją tokenów odpowiedzi", () => {
    const errors = validateLessonExercise(
      draft({ focus: ["runs"] }),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.toLowerCase().includes("focus"))).toBe(true);
  });

  it("przyjmuje focus dopasowany przez wariant normalizacji (skrót rozwinięty)", () => {
    // doesn't ≡ does not — focus „does not” jest podsekwencją rozwiniętego wariantu
    const ex = draft({
      objectiveId: OBJ.negative,
      exerciseType: "lesson_open_answer",
      prompt: "Napisz przeczenie.",
      answer: "she doesn't like tea",
      focus: ["does", "not"],
      stem: undefined,
      hint: undefined,
    });
    expect(validateLessonExercise(ex, englishGrammarSubject, englishTopic)).toEqual([]);
  });

  it("działa z fixture bez skrótów (focus podsekwencją)", () => {
    const ex = draft({
      objectiveId: historyTopic.objectives[0]!.id,
      exerciseType: "lesson_open_answer",
      prompt: "Kiedy był chrzest Polski?",
      answer: "w 966 roku",
      focus: ["966"],
      stem: undefined,
      hint: undefined,
    });
    expect(validateLessonExercise(ex, historyLikeSubject, historyTopic)).toEqual([]);
  });
});

describe("validateLessonExercise — lesson_order", () => {
  function orderDraft(items: readonly string[], answer: string): LessonExerciseDraft {
    return {
      exerciseType: "lesson_order",
      objectiveId: "english_grammar.present_simple.question",
      answer,
      acceptedAnswers: [],
      focus: ["does"],
      items: items.map((text, i) => ({ id: `i${i}`, text })),
    };
  }

  it("przyjmuje 3–10 elementów złączonych w odpowiedź", () => {
    expect(
      validateLessonExercise(
        orderDraft(["Does", "she", "play"], "Does she play"),
        englishGrammarSubject,
        englishTopic,
      ),
    ).toEqual([]);
  });

  it("odrzuca mniej niż 3 elementy", () => {
    const errors = validateLessonExercise(
      orderDraft(["Does", "she"], "Does she"),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.includes(String(MIN_ORDER_ITEMS)))).toBe(true);
  });

  it("odrzuca więcej niż 10 elementów", () => {
    const many = Array.from({ length: MAX_ORDER_ITEMS + 1 }, (_, i) => `w${i}`);
    const errors = validateLessonExercise(
      orderDraft(many, many.join(" ")),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.includes(String(MAX_ORDER_ITEMS)))).toBe(true);
  });

  it("odrzuca gdy złączone elementy nie dają odpowiedzi", () => {
    const errors = validateLessonExercise(
      orderDraft(["Does", "she", "play"], "Does he play"),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("validateLessonExercise — opcje (choice/short_answer)", () => {
  function choiceDraft(opts: readonly string[], correct: string): LessonExerciseDraft {
    return {
      exerciseType: "lesson_choice",
      objectiveId: OBJ.thirdPerson,
      answer: "plays",
      acceptedAnswers: [],
      focus: ["plays"],
      stem: "Wybierz formę.",
      options: opts.map((text, i) => ({ id: `o${i}`, text })),
      correctOption: correct,
    };
  }

  it("przyjmuje 2–4 unikalne opcje z poprawną wśród nich", () => {
    expect(
      validateLessonExercise(choiceDraft(["plays", "play"], "o0"), englishGrammarSubject, englishTopic),
    ).toEqual([]);
  });

  it("odrzuca mniej niż 2 opcje", () => {
    const errors = validateLessonExercise(
      choiceDraft(["plays"], "o0"),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.includes(String(MIN_OPTIONS)))).toBe(true);
  });

  it("odrzuca więcej niż 4 opcje", () => {
    const errors = validateLessonExercise(
      choiceDraft(["a", "b", "c", "d", "e"], "o0"),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.includes(String(MAX_OPTIONS)))).toBe(true);
  });

  it("odrzuca opcje nieunikalne po normalizacji", () => {
    const errors = validateLessonExercise(
      choiceDraft(["plays", "Plays"], "o0"),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it("odrzuca correctOption spoza opcji", () => {
    const errors = validateLessonExercise(
      choiceDraft(["plays", "play"], "oX"),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.toLowerCase().includes("correctoption") || e.includes("poprawn"))).toBe(
      true,
    );
  });
});

describe("validateLessonExercise — lesson_notice (segmenty)", () => {
  function noticeDraft(
    noticeSegments: readonly (readonly string[])[],
    correctOption: string | undefined,
    extra: Partial<LessonExerciseDraft> = {},
  ): LessonExerciseDraft {
    return {
      exerciseType: "lesson_notice",
      objectiveId: OBJ.thirdPerson,
      answer: "plays",
      acceptedAnswers: [],
      focus: [],
      noticeSegments,
      correctOption,
      ...extra,
    };
  }

  const twoSentences: readonly (readonly string[])[] = [
    ["She", "plays", "tennis"],
    ["He", "runs", "fast"],
  ];

  it("przyjmuje 2–3 zdania z poprawnym correctOption będącym segmentem", () => {
    expect(
      validateLessonExercise(noticeDraft(twoSentences, "plays"), englishGrammarSubject, englishTopic),
    ).toEqual([]);
  });

  it("odrzuca brak noticeSegments", () => {
    const errors = validateLessonExercise(
      noticeDraft(undefined as unknown as readonly (readonly string[])[], "plays"),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.includes("noticeSegments"))).toBe(true);
  });

  it("odrzuca mniej niż 2 zdania", () => {
    const errors = validateLessonExercise(
      noticeDraft([["She", "plays"]], "plays"),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.includes(String(MIN_NOTICE_SENTENCES)))).toBe(true);
  });

  it("odrzuca więcej niż 3 zdania", () => {
    const four: readonly (readonly string[])[] = [
      ["a", "plays"],
      ["b", "c"],
      ["d", "e"],
      ["f", "g"],
    ];
    const errors = validateLessonExercise(noticeDraft(four, "plays"), englishGrammarSubject, englishTopic);
    expect(errors.some((e) => e.includes(String(MAX_NOTICE_SENTENCES)))).toBe(true);
  });

  it("odrzuca zdanie z pustym segmentem", () => {
    const errors = validateLessonExercise(
      noticeDraft([["She", "", "plays"], ["He", "runs"]], "plays"),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.toLowerCase().includes("segment"))).toBe(true);
  });

  it("odrzuca zdanie z liczbą segmentów poza 1–15", () => {
    const tooMany = Array.from({ length: MAX_NOTICE_SEGMENTS + 1 }, (_, i) => `w${i}`);
    const errors = validateLessonExercise(
      noticeDraft([tooMany, ["plays", "here"]], "plays"),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.includes(String(MAX_NOTICE_SEGMENTS)))).toBe(true);
  });

  it("odrzuca segment dłuższy niż limit długości tekstu", () => {
    const long = "a".repeat(MAX_TEXT_LENGTH + 1);
    const errors = validateLessonExercise(
      noticeDraft([["She", long], ["He", "runs"]], "plays"),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.includes(String(MAX_TEXT_LENGTH)))).toBe(true);
  });

  it("odrzuca brak correctOption", () => {
    const errors = validateLessonExercise(
      noticeDraft(twoSentences, undefined),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.toLowerCase().includes("correctoption"))).toBe(true);
  });

  it("odrzuca correctOption niebędący żadnym segmentem", () => {
    const errors = validateLessonExercise(
      noticeDraft(twoSentences, "swims"),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.toLowerCase().includes("correctoption"))).toBe(true);
  });

  it("dopuszcza correctOption równy segmentowi po wariancie normalizacji", () => {
    // „Plays” ≡ „plays” po normalizacji
    expect(
      validateLessonExercise(noticeDraft(twoSentences, "Plays"), englishGrammarSubject, englishTopic),
    ).toEqual([]);
  });

  it("odrzuca obecność options dla notice", () => {
    const errors = validateLessonExercise(
      noticeDraft(twoSentences, "plays", { options: [{ id: "o0", text: "plays" }] }),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.includes("options"))).toBe(true);
  });
});

describe("validateLessonExercise — lesson_gap", () => {
  it("odrzuca brak znacznika luki w stem", () => {
    const errors = validateLessonExercise(
      draft({ stem: "She plays tennis." }),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.includes("luk"))).toBe(true);
  });

  it("odrzuca więcej niż jeden znacznik luki", () => {
    const errors = validateLessonExercise(
      draft({ stem: `${GAP_MARKER} ${GAP_MARKER}` }),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.includes("luk"))).toBe(true);
  });

  it("odrzuca odpowiedź luki dłuższą niż 3 tokeny", () => {
    const errors = validateLessonExercise(
      draft({
        objectiveId: OBJ.negative,
        answer: "she does not play",
        focus: ["does", "not", "play"],
      }),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.includes("3"))).toBe(true);
  });

  it("odrzuca gdy odpowiedź luki nie pokrywa się z focus", () => {
    const errors = validateLessonExercise(
      draft({ answer: "plays", focus: ["she"], stem: `She ${GAP_MARKER}.` }),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("validateLessonExercise — error_fix i transform", () => {
  it.each([undefined, "", "   "])("odrzuca transform bez zdania (%s)", (statement) => {
    const errors = validateLessonExercise(draft({ exerciseType: "lesson_transform", objectiveId: OBJ.negative,
      answer: "she doesn't play", focus: ["does", "not"], transformId: "to_negative", statement,
      stem: undefined, hint: undefined }), englishGrammarSubject, englishTopic);
    expect(errors.some((e) => e.includes("statement"))).toBe(true);
  });
  it("odrzuca lesson_error_fix gdy statement == odpowiedź po normalizacji", () => {
    const errors = validateLessonExercise(
      {
        exerciseType: "lesson_error_fix",
        objectiveId: OBJ.spelling,
        answer: "she goes",
        acceptedAnswers: [],
        focus: ["goes"],
        statement: "She goes.",
      },
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.includes("statement"))).toBe(true);
  });

  it("przyjmuje lesson_error_fix gdy statement różny od odpowiedzi", () => {
    expect(
      validateLessonExercise(
        {
          exerciseType: "lesson_error_fix",
          objectiveId: OBJ.spelling,
          answer: "she goes",
          acceptedAnswers: [],
          focus: ["goes"],
          statement: "She go.",
        },
        englishGrammarSubject,
        englishTopic,
      ),
    ).toEqual([]);
  });

  it("odrzuca lesson_transform z nieistniejącym transformId", () => {
    const errors = validateLessonExercise(
      {
        exerciseType: "lesson_transform",
        objectiveId: OBJ.negative,
        answer: "she doesn't play",
        acceptedAnswers: [],
        focus: ["does", "not"],
        statement: "She plays.",
        transformId: "nieistnieje",
      },
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.includes("transformId"))).toBe(true);
  });

  it("przyjmuje lesson_transform z istniejącym transformId", () => {
    expect(
      validateLessonExercise(
        {
          exerciseType: "lesson_transform",
          objectiveId: OBJ.negative,
          answer: "she doesn't play",
          acceptedAnswers: [],
          focus: ["does", "not"],
          statement: "She plays.",
          transformId: "to_negative",
        },
        englishGrammarSubject,
        englishTopic,
      ),
    ).toEqual([]);
  });
});

describe("validateLessonExercise — długości i acceptedAnswers", () => {
  it("odrzuca pole tekstowe dłuższe niż limit", () => {
    const errors = validateLessonExercise(
      draft({ prompt: "a".repeat(MAX_TEXT_LENGTH + 1) }),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.includes(String(MAX_TEXT_LENGTH)))).toBe(true);
  });

  it("odrzuca więcej niż limit acceptedAnswers", () => {
    const errors = validateLessonExercise(
      draft({ acceptedAnswers: Array.from({ length: MAX_ACCEPTED_ANSWERS + 1 }, (_, i) => `v${i}`) }),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.includes(String(MAX_ACCEPTED_ANSWERS)))).toBe(true);
  });

  it("odrzuca pusty wariant w acceptedAnswers", () => {
    const errors = validateLessonExercise(
      draft({ acceptedAnswers: ["  "] }),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it("odrzuca wariant duplikujący odpowiedź kanoniczną po normalizacji", () => {
    const errors = validateLessonExercise(
      draft({ acceptedAnswers: ["Plays"] }),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("withoutRedundantAcceptedVariants", () => {
  /** Ćwiczenie samodzielne celu przeczeń „to be” z nadpisywaną odpowiedzią i wariantami. */
  function openAnswer(overrides: Partial<LessonExerciseDraft>): LessonExerciseDraft {
    return draft({
      exerciseType: "lesson_open_answer",
      objectiveId: "english_grammar.to_be.negative_forms",
      stem: undefined,
      hint: undefined,
      prompt: "Oni nie są w mojej klasie.",
      answer: "They aren't in my class.",
      acceptedAnswers: [],
      focus: ["aren't"],
      ...overrides,
    });
  }

  it("porzuca wariant skrótowy równoważny odpowiedzi kanonicznej (przeczenia „to be”)", () => {
    const sanitized = withoutRedundantAcceptedVariants(
      openAnswer({ acceptedAnswers: ["They're not in my class."] }),
      englishGrammarSubject.normalizer,
    );
    expect(sanitized.acceptedAnswers).toEqual([]);
    expect(sanitized.answer).toBe("They aren't in my class.");
  });

  it("porzuca tylko redundantne warianty, różne zachowuje", () => {
    const sanitized = withoutRedundantAcceptedVariants(
      draft({ acceptedAnswers: ["Plays", "does play on Mondays"] }),
      englishGrammarSubject.normalizer,
    );
    expect(sanitized.acceptedAnswers).toEqual(["does play on Mondays"]);
  });

  it("zwraca tę samą instancję, gdy nie ma wariantów redundantnych", () => {
    const ex = draft({ acceptedAnswers: ["does play on Mondays"] });
    expect(withoutRedundantAcceptedVariants(ex, englishGrammarSubject.normalizer)).toBe(ex);
  });

  it("zwraca tę samą instancję dla pustych acceptedAnswers", () => {
    const ex = draft({ acceptedAnswers: [] });
    expect(withoutRedundantAcceptedVariants(ex, englishGrammarSubject.normalizer)).toBe(ex);
  });

  it("porzuca wariant dzielący jedną sekwencję z odpowiedzią przez skrót dwuznaczny ('s → is|has)", () => {
    // „She's late.” rozwija się do [she is late, she has late] — wspólne
    // „she is late” z odpowiedzią kanoniczną czyni wariant redundantnym.
    const sanitized = withoutRedundantAcceptedVariants(
      openAnswer({
        objectiveId: "english_grammar.to_be.affirmative_forms",
        prompt: "Czy ona jest spóźniona?",
        answer: "She is late.",
        acceptedAnswers: ["She's late."],
        focus: ["late"],
      }),
      englishGrammarSubject.normalizer,
    );
    expect(sanitized.acceptedAnswers).toEqual([]);
  });

  it("porzuca wariant dzielący NIE-pierwszą sekwencję odpowiedzi (regresja „tylko pierwsza sekwencja”)", () => {
    // Odpowiedź rozwija się do [she is late, she has late]; wariant dzieli DRUGĄ
    // sekwencję — porównanie samych pierwszych sekwencji (klasa błędu
    // acceptVerdictAsVariant z WR-01) zostawiłoby ten redundantny wariant.
    const sanitized = withoutRedundantAcceptedVariants(
      openAnswer({
        objectiveId: "english_grammar.to_be.affirmative_forms",
        prompt: "Ona jest spóźniona.",
        answer: "She's late.",
        acceptedAnswers: ["she has late"],
        focus: ["late"],
      }),
      englishGrammarSubject.normalizer,
    );
    expect(sanitized.acceptedAnswers).toEqual([]);
  });

  it("porzuca wariant różniący się tylko wielkością liter i interpunkcją", () => {
    const sanitized = withoutRedundantAcceptedVariants(
      openAnswer({ acceptedAnswers: ["they aren't in my class"] }),
      englishGrammarSubject.normalizer,
    );
    expect(sanitized.acceptedAnswers).toEqual([]);
  });

  it("zachowuje wariant skrótowy, gdy nie dzieli żadnej sekwencji z odpowiedzią", () => {
    // „He isn't late.” → [he is not late] — brak wspólnej sekwencji z [he is late].
    const sanitized = withoutRedundantAcceptedVariants(
      openAnswer({
        prompt: "Czy on jest spóźniony?",
        answer: "He is late.",
        acceptedAnswers: ["He isn't late."],
        focus: ["late"],
      }),
      englishGrammarSubject.normalizer,
    );
    expect(sanitized.acceptedAnswers).toEqual(["He isn't late."]);
  });
});

describe("validateLessonExercise — voiceTone", () => {
  it("odrzuca ton lektora w przedmiocie bez nagrań pytań (gramatyka)", () => {
    const errors = validateLessonExercise(draft({ voiceTone: "gentle" }), englishGrammarSubject, englishTopic);
    expect(errors.some((error) => error.startsWith("voiceTone:"))).toBe(true);
    expect(validateLessonExercise(draft({}), englishGrammarSubject, englishTopic).some((error) => error.startsWith("voiceTone:"))).toBe(false);
  });

  it("akceptuje ton w przedmiocie z nagraniami pytań (szkoła)", () => {
    const topic = schoolSubject.buildDynamicTopic!({
      titlePl: "Przyroda",
      objectives: [{
        id: "school.ddeck.foto", titlePl: "Fotosynteza", descriptionEn: "Photosynthesis.",
        cards: [{ title: "Co to?", body: "Roślina wytwarza cukry." }, { title: "Po co?", body: "Cukry to pokarm." }],
      }],
    });
    const ex: LessonExerciseDraft = {
      exerciseType: "lesson_open_answer", objectiveId: "school.ddeck.foto", prompt: "Co wytwarza roślina?",
      answer: "Cukry.", acceptedAnswers: [], focus: [], voiceTone: "curious",
    };
    const errors = validateLessonExercise(ex, schoolSubject, topic);
    expect(errors.some((error) => error.startsWith("voiceTone:"))).toBe(false);
    // Rachunek nie ma tonu nawet w przedmiocie z nagraniami (edytor go nie pokazuje).
    const calculation = validateLessonExercise({ ...ex, exerciseType: "lesson_calculation" }, schoolSubject, topic);
    expect(calculation).toContain("voiceTone: ton lektora niedozwolony dla lesson_calculation");
  });
});

describe("validateLessonExercise — delegacja do subject.validateExercise", () => {
  it("dokłada błędy zwrócone przez przedmiot", () => {
    const fakeSubject: SubjectModule = {
      ...historyLikeSubject,
      validateExercise: () => ["Błąd przedmiotu: X"],
    };
    const ex = draft({
      objectiveId: historyTopic.objectives[0]!.id,
      exerciseType: "lesson_gap",
      answer: "966",
      focus: ["966"],
      stem: `Chrzest w ${GAP_MARKER} roku.`,
      hint: undefined,
    });
    const errors = validateLessonExercise(ex, fakeSubject, historyTopic);
    expect(errors).toContain("Błąd przedmiotu: X");
  });

  it("prawdziwy walidator angielskiego odrzuca złą formę luki", () => {
    const errors = validateLessonExercise(
      draft({ answer: "played", focus: ["played"], hint: "play", stem: `She ${GAP_MARKER}.` }),
      englishGrammarSubject,
      englishTopic,
    );
    expect(errors.some((e) => e.includes("Present Simple"))).toBe(true);
  });
});

describe("findDuplicateAnswers", () => {
  it("grupuje odpowiedzi o wspólnym wariancie normalizacji", () => {
    const exercises: LessonExerciseDraft[] = [
      draft({ answer: "she plays" }),
      draft({ answer: "She  Plays" }),
      draft({ answer: "he runs" }),
    ];
    const groups = findDuplicateAnswers(exercises, englishGrammarSubject);
    expect(groups.length).toBe(1);
    expect(groups[0]!.length).toBe(2);
  });

  it("wykrywa duplikat przez skrót (doesn't ≡ does not)", () => {
    const exercises: LessonExerciseDraft[] = [
      draft({ objectiveId: OBJ.negative, answer: "she doesn't play", focus: ["does", "not"] }),
      draft({ objectiveId: OBJ.negative, answer: "she does not play", focus: ["does", "not"] }),
    ];
    const groups = findDuplicateAnswers(exercises, englishGrammarSubject);
    expect(groups.length).toBe(1);
  });

  it("zwraca pustą tablicę bez duplikatów", () => {
    const exercises: LessonExerciseDraft[] = [draft({ answer: "she plays" }), draft({ answer: "he runs" })];
    expect(findDuplicateAnswers(exercises, englishGrammarSubject)).toEqual([]);
  });
});

describe("validatePool", () => {
  it("odrzuca pojedyncze niepoprawne, zachowuje poprawne", () => {
    const good = draft({ answer: "plays", focus: ["plays"] });
    const bad = draft({ answer: "plays", focus: ["runs"] }); // focus nie w odpowiedzi
    const result = validatePool([good, bad], englishGrammarSubject, englishTopic);
    expect(result.valid).toContain(good);
    expect(result.rejected.some((r) => r.exercise === bad)).toBe(true);
  });

  it("przy duplikacie zachowuje pierwszy, odrzuca kolejne", () => {
    const first = draft({ answer: "plays" });
    const dup = draft({ answer: "Plays" });
    const result = validatePool([first, dup], englishGrammarSubject, englishTopic);
    expect(result.valid).toContain(first);
    expect(result.valid).not.toContain(dup);
    expect(result.rejected.some((r) => r.exercise === dup)).toBe(true);
  });

  it("keepsEightDifferentAuxiliaryGaps", () => {
    const cases: Array<{ objectiveId: string; answer: string; stem: string }> = [
      { objectiveId: OBJ.negative, answer: "don't", stem: "I ___ play tennis." },
      { objectiveId: OBJ.negative, answer: "doesn't", stem: "She ___ play tennis." },
      { objectiveId: "english_grammar.present_simple.question", answer: "do", stem: "___ you play tennis?" },
      { objectiveId: "english_grammar.present_simple.question", answer: "does", stem: "___ she play tennis?" },
      { objectiveId: "english_grammar.present_simple.short_answers", answer: "do", stem: "Yes, I ___." },
      { objectiveId: "english_grammar.present_simple.short_answers", answer: "doesn't", stem: "No, she ___." },
      { objectiveId: "english_grammar.present_simple.short_answers", answer: "do", stem: "Yes, they ___." },
      { objectiveId: "english_grammar.present_simple.short_answers", answer: "does", stem: "Yes, he ___." },
    ];
    const exercises = cases.map(({ objectiveId, answer, stem }) => draft({
      objectiveId,
      answer,
      focus: [answer],
      stem,
      hint: undefined,
    }));
    const result = validatePool(exercises, englishGrammarSubject, englishTopic);
    expect(result.valid).toHaveLength(8);
    expect(result.valid.filter((exercise) => exercise.objectiveId === "english_grammar.present_simple.short_answers")).toHaveLength(4);
  });

  it("keepsTheSameCorrectAuxiliaryForDifferentGrammarObjectives", () => {
    const question = draft({
      objectiveId: "english_grammar.present_simple.question",
      answer: "does",
      focus: ["does"],
      stem: "___ she play tennis?",
      hint: undefined,
    });
    const shortAnswer = draft({
      objectiveId: "english_grammar.present_simple.short_answers",
      answer: "does",
      focus: ["does"],
      stem: "Yes, he ___.",
      hint: undefined,
    });
    const result = validatePool([question, shortAnswer], englishGrammarSubject, englishTopic);
    expect(result.valid).toEqual([question, shortAnswer]);
    expect(result.rejected).toEqual([]);
  });

  it("rejectsRepeatedStimulusDespiteOptionIdsOrChangedAnswer", () => {
    const first = draft({ stem: "___ she play tennis?", answer: "does", focus: ["does"], hint: undefined,
      objectiveId: "english_grammar.present_simple.question" });
    const duplicate = draft({ stem: " ___ SHE   play tennis? ", answer: "do", focus: ["do"], hint: undefined,
      objectiveId: "english_grammar.present_simple.question" });
    const result = validatePool([first, duplicate], englishGrammarSubject, englishTopic);
    expect(result.valid).toEqual([first]);
    expect(result.rejected.some(({ exercise }) => exercise === duplicate)).toBe(true);
  });

  it("keepsAnswerPolicyForHistorySubject", () => {
    const first = draft({ objectiveId: historyTopic.objectives[0]!.id, exerciseType: "lesson_open_answer",
      prompt: "Kiedy był chrzest Polski?", answer: "966", focus: ["966"], stem: undefined, hint: undefined });
    const duplicate = { ...first, prompt: "Podaj rok chrztu Polski." };
    const historyWithAnswerDedup = { ...historyLikeSubject, poolDeduplication: "answer" as const };
    const result = validatePool([first, duplicate], historyWithAnswerDedup, historyTopic);
    expect(result.valid).toEqual([first]);
    expect(result.rejected.some(({ exercise }) => exercise === duplicate)).toBe(true);
  });

  it("instructionIsStimulus: to samo zdanie z innym poleceniem nie jest duplikatem", () => {
    const first = draft({ stem: "It's ___ today.", answer: "snowing", focus: ["snowing"], hint: undefined,
      instructionPl: "Dziś pada śnieg. Wpisz brakujące słowo.", objectiveId: "english_grammar.present_simple.question" });
    const second = draft({ stem: "It's ___ today.", answer: "snowing", focus: ["snowing"], hint: undefined,
      instructionPl: "Dziś sypie śnieg. Wpisz brakujące słowo.", objectiveId: "english_grammar.present_simple.question" });
    // Bez opcji (dzisiejsze zachowanie): polecenie jest kosmetyczne, drugie ćwiczenie to duplikat.
    const without = validatePool([first, second], englishGrammarSubject, englishTopic);
    expect(without.valid).toEqual([first]);
    expect(without.rejected.some(({ exercise }) => exercise === second)).toBe(true);
    const withOption = validatePool([first, second], { ...englishGrammarSubject, instructionIsStimulus: true }, englishTopic);
    expect(withOption.rejected.filter(({ errors }) => errors.some((error) => error.startsWith("stimulus:")))).toEqual([]);
    expect(withOption.valid).toEqual([first, second]);
  });

  it("instructionIsStimulus: to samo polecenie i zdanie nadal jest duplikatem", () => {
    const first = draft({ stem: "It's ___ today.", answer: "snowing", focus: ["snowing"], hint: undefined,
      instructionPl: "Dziś pada śnieg.", objectiveId: "english_grammar.present_simple.question" });
    const second = { ...first, instructionPl: "  DZIŚ pada   śnieg. " };
    const result = validatePool([first, second], { ...englishGrammarSubject, instructionIsStimulus: true }, englishTopic);
    expect(result.valid).toEqual([first]);
    expect(result.rejected.some(({ exercise }) => exercise === second)).toBe(true);
  });
});

describe("poolCoverage", () => {
  const minimums = { guided: 1, productive: 1, independent: 1 };

  function typed(type: LessonExerciseDraft["exerciseType"], objectiveId: string): LessonExerciseDraft {
    return draft({
      exerciseType: type,
      objectiveId,
      stem: type === "lesson_gap" ? `x ${GAP_MARKER}` : undefined,
      hint: undefined,
    });
  }

  it("pusta tablica gdy pokrycie spełnione", () => {
    const exercises = [
      typed("lesson_choice", OBJ.thirdPerson),
      typed("lesson_gap", OBJ.thirdPerson),
      typed("lesson_open_answer", OBJ.thirdPerson),
    ];
    expect(poolCoverage(exercises, [OBJ.thirdPerson], minimums)).toEqual([]);
  });

  it("raportuje braki per etap", () => {
    const exercises = [typed("lesson_choice", OBJ.thirdPerson)]; // brak productive, independent
    const gaps = poolCoverage(exercises, [OBJ.thirdPerson], minimums);
    const stages = gaps.map((g) => g.stage);
    expect(stages).toContain("productive");
    expect(stages).toContain("independent");
    expect(stages).not.toContain("guided");
  });

  it("lesson_notice (intro) nie liczy się do pokrycia", () => {
    const exercises = [
      typed("lesson_notice", OBJ.thirdPerson),
      typed("lesson_gap", OBJ.thirdPerson),
      typed("lesson_open_answer", OBJ.thirdPerson),
    ];
    const gaps = poolCoverage(exercises, [OBJ.thirdPerson], minimums);
    // notice nie pokrywa guided → guided wciąż brakuje
    expect(gaps.some((g) => g.stage === "guided")).toBe(true);
    expect(stageOf("lesson_notice")).toBe("intro");
  });

  it("raportuje braki osobno dla każdego celu", () => {
    const exercises = [typed("lesson_choice", OBJ.thirdPerson)];
    const gaps = poolCoverage(exercises, [OBJ.thirdPerson, OBJ.negative], minimums);
    expect(gaps.some((g) => g.objectiveId === OBJ.negative)).toBe(true);
    expect(gaps.filter((g) => g.objectiveId === OBJ.negative).length).toBe(3);
  });
});

describe("lesson_listen_choice — walidacja", () => {
  // Gramatyka ma typ w celu third_person_s (Task 4); fixture bez niego sprawdza odrzucenie.
  const listenSubject: SubjectModule = englishGrammarSubject;
  const listenTopic: LessonTopic = englishTopic;
  const subjectWithoutListen: SubjectModule = {
    ...englishGrammarSubject,
    exerciseTypes: englishGrammarSubject.exerciseTypes.filter((type) => type !== "lesson_listen_choice"),
  };

  function listen(overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
    return {
      exerciseType: "lesson_listen_choice",
      objectiveId: OBJ.thirdPerson,
      stem: `He ${GAP_MARKER} football.`,
      options: [{ id: "a", text: "play" }, { id: "b", text: "plays" }],
      correctOption: "b",
      answer: "plays",
      acceptedAnswers: [],
      focus: ["plays"],
      ...overrides,
    };
  }
  const errorsOf = (ex: LessonExerciseDraft) => validateLessonExercise(ex, listenSubject, listenTopic);

  it("przyjmuje poprawne ćwiczenie", () => {
    expect(errorsOf(listen())).toEqual([]);
  });

  it("odrzuca typ, gdy przedmiot go nie wspiera", () => {
    const errors = validateLessonExercise(listen(), subjectWithoutListen, listenTopic);
    expect(errors.some((e) => e.includes("exerciseType"))).toBe(true);
  });

  it.each([
    ["instructionPl", { instructionPl: "Wybierz formę." }],
    ["hint", { hint: "play" }],
    ["visualSubject", { visualSubject: "boy" }],
  ] as const)("odrzuca pole %s", (field, overrides) => {
    expect(errorsOf(listen(overrides)).some((e) => e.includes(field))).toBe(true);
  });

  it("odrzuca opcję zaczynającą się od apostrofu", () => {
    for (const apostrophe of ["'", "’"]) {
      const text = `${apostrophe}re`;
      const errors = errorsOf(listen({
        stem: `They ${GAP_MARKER} happy.`,
        options: [{ id: "a", text }, { id: "b", text: "is" }],
        correctOption: "a",
        answer: text,
        focus: [text],
      }));
      expect(errors.some((e) => e.includes("apostrof"))).toBe(true);
    }
  });

  it("odrzuca opcje równoważne na poziomie zdania, dopuszcza różne", () => {
    const equivalent = errorsOf(listen({
      stem: `She ${GAP_MARKER} like milk.`,
      options: [{ id: "a", text: "doesn't" }, { id: "b", text: "does not" }],
      correctOption: "a",
      answer: "doesn't",
      focus: ["doesn't"],
    }));
    expect(equivalent.some((e) => e.includes("zdania z opcjami"))).toBe(true);
    const distinct = errorsOf(listen({
      stem: `She ${GAP_MARKER} happy.`,
      options: [{ id: "a", text: "is" }, { id: "b", text: "are" }],
      correctOption: "a",
      answer: "is",
      focus: ["is"],
    }));
    expect(distinct).toEqual([]);
  });

  it("odrzuca opcje, których zdania są równoważne mimo różnego tekstu opcji", () => {
    const errors = errorsOf(listen({
      stem: `They ${GAP_MARKER} happy.`,
      options: [{ id: "a", text: "are" }, { id: "b", text: "are." }],
      correctOption: "a",
      answer: "are",
      focus: ["are"],
    }));
    expect(errors.some((e) => e.includes("zdania z opcjami"))).toBe(true);
  });

  it("wymaga dokładnie jednej luki", () => {
    expect(errorsOf(listen({ stem: `He ${GAP_MARKER} football ${GAP_MARKER}.` })).some((e) => e.includes("luk"))).toBe(true);
    expect(errorsOf(listen({ stem: "He plays football." })).some((e) => e.includes("luk"))).toBe(true);
  });

  it("akceptuje lukę z dwóch podkreśleń, a ciąg 2+ liczy jako jedną lukę", () => {
    expect(errorsOf(listen({ stem: "He __ football." }))).toEqual([]);
    expect(errorsOf(listen({ stem: "He _____ football." }))).toEqual([]);
  });

  it("odrzuca zdanie dłuższe niż 200 znaków", () => {
    const long = "b".repeat(110);
    const errors = errorsOf(listen({
      stem: `${"a".repeat(100)} ${GAP_MARKER}.`,
      options: [{ id: "a", text: "play" }, { id: "b", text: long }],
      answer: long,
      focus: [long],
    }));
    expect(errors.some((e) => e.includes("200"))).toBe(true);
  });

  it("pula: zdanie równoważne odpowiedzi ćwiczenia tekstowego odrzuca ćwiczenie słuchowe", () => {
    const listenEx = listen({
      objectiveId: OBJ.negative,
      stem: `She ${GAP_MARKER} like milk.`,
      options: [{ id: "a", text: "doesn't" }, { id: "b", text: "isn't" }],
      correctOption: "a",
      answer: "doesn't",
      focus: ["doesn't"],
    });
    expect(errorsOf(listenEx)).toEqual([]);
    const open = draft({
      objectiveId: OBJ.negative,
      exerciseType: "lesson_open_answer",
      prompt: "Napisz przeczenie.",
      answer: "She does not like milk",
      focus: ["does", "not"],
      stem: undefined,
      hint: undefined,
    });
    const result = validatePool([open, listenEx], listenSubject, listenTopic);
    expect(result.valid).toEqual([open]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.exercise).toBe(listenEx);
    expect(result.rejected[0]!.errors.some((e) => e.includes("słuchow"))).toBe(true);
  });

  it("pula: wariant odpowiedzi też blokuje, a niepowiązane zdanie nie", () => {
    const listenEx = listen({
      objectiveId: OBJ.negative,
      stem: `She ${GAP_MARKER} like milk.`,
      options: [{ id: "a", text: "doesn't" }, { id: "b", text: "isn't" }],
      correctOption: "a",
      answer: "doesn't",
      focus: ["doesn't"],
    });
    const fix = draft({
      objectiveId: OBJ.negative,
      exerciseType: "lesson_open_answer",
      prompt: "Napisz przeczenie.",
      answer: "She doesn't enjoy milk",
      acceptedAnswers: ["She doesn't like milk."],
      focus: ["doesn't"],
      stem: undefined,
      hint: undefined,
    });
    const blocked = validatePool([fix, listenEx], listenSubject, listenTopic);
    expect(blocked.rejected.some((entry) => entry.exercise === listenEx)).toBe(true);
    const unrelated = draft({
      objectiveId: OBJ.negative,
      exerciseType: "lesson_open_answer",
      prompt: "Napisz zdanie.",
      answer: "He likes tea",
      focus: ["likes"],
      stem: undefined,
      hint: undefined,
    });
    const ok = validatePool([unrelated, listenEx], listenSubject, listenTopic);
    expect(ok.valid).toContain(listenEx);
  });

  it("dogenerowanie: nowe ćwiczenie słuchowe zderza się z odpowiedzią tekstową już w szkicu", () => {
    const listenEx = listen({
      objectiveId: OBJ.negative,
      stem: `She ${GAP_MARKER} like milk.`,
      options: [{ id: "a", text: "doesn't" }, { id: "b", text: "isn't" }],
      correctOption: "a",
      answer: "doesn't",
      focus: ["doesn't"],
    });
    const existingOpen = draft({
      objectiveId: OBJ.negative,
      exerciseType: "lesson_open_answer",
      prompt: "Napisz przeczenie.",
      answer: "She does not like milk",
      focus: ["does", "not"],
      stem: undefined,
      hint: undefined,
    });
    const result = validatePool([listenEx], listenSubject, listenTopic, { existingExercises: [existingOpen] });
    expect(result.valid).toEqual([]);
    expect(result.rejected[0]!.exercise).toBe(listenEx);
    expect(result.rejected[0]!.errors.some((e) => e.includes("słuchow"))).toBe(true);
    // Bez kontekstu szkicu to samo ćwiczenie przechodzi.
    expect(validatePool([listenEx], listenSubject, listenTopic).valid).toEqual([listenEx]);
  });

  it("dogenerowanie: nowe ćwiczenie tekstowe z odpowiedzią równą zdaniu słuchowemu szkicu jest odrzucane", () => {
    const existingListen = listen({
      objectiveId: OBJ.negative,
      stem: `She ${GAP_MARKER} like milk.`,
      options: [{ id: "a", text: "doesn't" }, { id: "b", text: "isn't" }],
      correctOption: "a",
      answer: "doesn't",
      focus: ["doesn't"],
    });
    const open = draft({
      objectiveId: OBJ.negative,
      exerciseType: "lesson_open_answer",
      prompt: "Napisz przeczenie.",
      answer: "She does not like milk",
      focus: ["does", "not"],
      stem: undefined,
      hint: undefined,
    });
    const result = validatePool([open], listenSubject, listenTopic, { existingExercises: [existingListen] });
    expect(result.valid).toEqual([]);
    expect(result.rejected[0]!.exercise).toBe(open);
    expect(result.rejected[0]!.errors.some((e) => e.includes("słuchow"))).toBe(true);
  });

  it("poolCoverage: ćwiczenia słuchowe nie pokrywają etapu guided", () => {
    const minimums = { guided: 1, productive: 0, independent: 0 };
    const exercises = [listen(), listen({ stem: `He ${GAP_MARKER} tennis.` }), listen({ stem: `He ${GAP_MARKER} golf.` })];
    const gaps = poolCoverage(exercises, [OBJ.thirdPerson], minimums);
    expect(gaps).toEqual([{ objectiveId: OBJ.thirdPerson, stage: "guided", required: 1, actual: 0 }]);
  });
});
