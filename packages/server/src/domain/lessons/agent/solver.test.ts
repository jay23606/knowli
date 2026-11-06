import { describe, expect, it } from "vitest";
import { baseNormalizer } from "../normalize";
import type { AnswerNormalizer, LessonExerciseDraft, LessonExerciseType, LessonTopic } from "../types";
import { blindMatches, blindMismatchFound, expectedAnswerCount, SOLVER_FIELD_CLASS, solverView } from "./solver";

const topic: LessonTopic = {
  id: "solver_topic",
  version: 1,
  titlePl: "Temat",
  extraErrorCategories: [],
  transforms: [{ id: "tr-negate", instructionPl: "Zamień zdanie na przeczenie." }],
  objectives: [
    {
      id: "obj-1",
      titlePl: "Cel pierwszy",
      descriptionEn: "First objective",
      cards: [],
      errorCategories: [],
      hints: {},
      exerciseTypes: [],
    },
  ],
};

/** Normalizator z jednym wariantem: „it's” == „it is”, jak rozwinięcia skrótów przedmiotu. */
const variantNormalizer: AnswerNormalizer = {
  normalize(text) {
    const base = baseNormalizer.normalize(text)[0] ?? [];
    return base.join(" ") === "it's" ? [base, ["it", "is"]] : [base];
  },
};

function make(exerciseType: LessonExerciseType, overrides: Partial<LessonExerciseDraft>): LessonExerciseDraft {
  return { exerciseType, objectiveId: "obj-1", answer: "unused", acceptedAnswers: [], focus: [], ...overrides };
}

/** Szkic ze WSZYSTKIMI polami — źródło prawdy dla zgodności klasyfikacji z typem. */
const fullDraft: Required<LessonExerciseDraft> = {
  exerciseType: "lesson_choice",
  objectiveId: "obj-1",
  instructionPl: "i",
  stem: "s",
  statement: "t",
  prompt: "p",
  hint: "h",
  transformId: "tr-negate",
  noticeSegments: [["a"]],
  visualSubject: "boy",
  answer: "a",
  acceptedAnswers: ["a"],
  focus: ["f"],
  options: [{ id: "o", text: "t" }],
  correctOption: "o",
  items: [{ id: "i", text: "t" }],
  questionType: "fact",
  requiredElements: [{ id: "r", text: "t" }],
  supplementaryElements: ["s"],
  commonErrors: ["c"],
  expectedForm: "short",
  familyId: "fam",
  sourceRefs: [{ quote: "q" }],
  calculation: { kind: "unit_conversion", unit: "cm", templateFamilyId: "conv", params: { value: 1, fromUnit: "m" } },
  keywordOptions: [{ id: "k", text: "t" }],
  keyOptionIds: ["k"],
  pairs: [{ left: "l", right: "r" }],
  extraRight: ["e"],
  groups: [{ id: "g", label: "l" }],
  groupItems: [{ text: "t", groupId: "g" }],
  clozeText: "c",
  gapAnswers: ["g"],
  extraWords: ["e"],
  voiceTone: "cheerful",
  explanationPl: "e",
};

describe("SOLVER_FIELD_CLASS", () => {
  it("ma klasę dla każdego pola szkicu i żadnego nadmiarowego", () => {
    expect(Object.keys(SOLVER_FIELD_CLASS).sort()).toEqual(Object.keys(fullDraft).sort());
  });

  it("pola klucza i wyjaśnień nie są widokiem", () => {
    for (const field of ["answer", "acceptedAnswers", "correctOption", "keyOptionIds", "hint", "explanationPl"] as const) {
      expect(SOLVER_FIELD_CLASS[field]).toBe("key");
    }
  });
});

describe("solverView", () => {
  const drafts: readonly LessonExerciseDraft[] = [
    make("lesson_notice", {
      instructionPl: "Wskaż czasownik.",
      noticeSegments: [["The", "boy", "plays"], ["Mara", "reads"]],
      answer: "plays",
      correctOption: "plays",
    }),
    make("lesson_choice", {
      instructionPl: "Wybierz słowo.",
      stem: "He ___ football.",
      options: [
        { id: "opt-b2", text: "play" },
        { id: "opt-a1", text: "plays" },
      ],
      correctOption: "opt-a1",
      answer: "plays",
      hint: "czasownik w trzeciej osobie",
      focus: ["third-person marker"],
      explanationPl: "Po he dodajemy końcówkę.",
    }),
    make("lesson_listen_choice", {
      stem: "She ___ tea.",
      options: [
        { id: "opt-x1", text: "drink" },
        { id: "opt-y2", text: "drinks" },
      ],
      correctOption: "opt-y2",
      answer: "drinks",
    }),
    make("lesson_short_answer", {
      prompt: "Kto był pierwszym władcą?",
      options: [
        { id: "opt-m", text: "Mieszko" },
        { id: "opt-b", text: "Bolesław" },
      ],
      correctOption: "opt-m",
      answer: "Mieszko",
      acceptedAnswers: ["Mieszko I"],
      requiredElements: [{ id: "req-1", text: "pierwszy historyczny władca" }],
      supplementaryElements: ["dynastia Piastów"],
      commonErrors: ["pomylenie z Chrobrym"],
      sourceRefs: [{ quote: "Mieszko I był pierwszym historycznym władcą." }],
      explanationPl: "Pierwszym władcą był Mieszko.",
    }),
    make("lesson_order", {
      instructionPl: "Ułóż zdanie.",
      items: [
        { id: "it-1", text: "dogs" },
        { id: "it-2", text: "like" },
        { id: "it-3", text: "bones" },
      ],
      answer: "dogs like bones",
    }),
    make("lesson_gap", {
      instructionPl: "Uzupełnij.",
      stem: "She ___ to school every day.",
      answer: "goes",
      hint: "bezokolicznik go",
      focus: ["third person ending"],
      explanationPl: "Po she dodajemy końcówkę -es.",
    }),
    make("lesson_error_fix", {
      instructionPl: "Popraw błąd.",
      statement: "She go to school.",
      answer: "She goes to school.",
    }),
    make("lesson_transform", {
      transformId: "tr-negate",
      statement: "He likes milk.",
      answer: "He does not like milk.",
    }),
    make("lesson_open_answer", {
      instructionPl: "Odpowiedz.",
      prompt: "Dlaczego jest zima?",
      stem: "Ukryty bodziec nieobecny w widoku dziecka",
      statement: "Ukryte zdanie nieobecne w widoku dziecka",
      answer: "Oś Ziemi jest nachylona.",
      acceptedAnswers: ["Ziemia jest nachylona"],
      requiredElements: [{ id: "req-2", text: "nachylenie osi Ziemi" }],
      supplementaryElements: ["pory roku"],
      commonErrors: ["odległość od Słońca"],
      sourceRefs: [{ quote: "Oś Ziemi jest nachylona względem orbity." }],
      explanationPl: "Zima wynika z nachylenia osi.",
    }),
    make("lesson_keywords", {
      keywordOptions: [
        { id: "kw-b", text: "chlorofil" },
        { id: "kw-a", text: "światło" },
        { id: "kw-c", text: "kamień" },
      ],
      keyOptionIds: ["kw-a", "kw-b"],
      answer: "unused-answer",
    }),
    make("lesson_match", {
      pairs: [
        { left: "kot", right: "cat" },
        { left: "pies", right: "dog" },
        { left: "ryba", right: "fish" },
      ],
      extraRight: ["bird"],
      answer: "kot cat",
    }),
    make("lesson_group", {
      groups: [
        { id: "grp-m", label: "Ssaki" },
        { id: "grp-b", label: "Ptaki" },
      ],
      groupItems: [
        { text: "wróbel", groupId: "grp-b" },
        { text: "słoń", groupId: "grp-m" },
      ],
      answer: "wróbel Ptaki",
    }),
    make("lesson_cloze", {
      clozeText: "Roślina pobiera ___ z powietrza i ___ z gleby.",
      gapAnswers: ["dwutlenek", "wodę"],
      extraWords: ["tlen"],
      answer: "dwutlenek, wodę",
    }),
  ];

  /** Wszystkie teksty (także zagnieżdżone: `.text`, `.quote`, identyfikatory) z wartości pola. */
  const flatten = (value: unknown): string[] => {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(flatten);
    if (value && typeof value === "object") return Object.values(value).flatMap(flatten);
    return [];
  };

  /** Teksty widoczne dziecku jako opcje wyboru lub słowa zdania — tylko je klucz może legalnie powtarzać. */
  const visibleOptionTexts = (draft: LessonExerciseDraft): Set<string> =>
    new Set([
      ...(draft.options ?? []).map((option) => option.text),
      ...(draft.noticeSegments ?? []).flat(),
      ...(draft.keywordOptions ?? []).map((option) => option.text),
    ]);

  /** Teksty ≥ 3 znaków ze WSZYSTKICH pól klasy `key` szkicu, poza dokładnie powtórzonymi widocznymi opcjami. */
  const keyTexts = (draft: LessonExerciseDraft): string[] => {
    const visible = visibleOptionTexts(draft);
    return keyFields.flatMap((field) => flatten(draft[field])).filter((text) => text.length >= 3 && !visible.has(text));
  };

  const keyFields = (Object.keys(SOLVER_FIELD_CLASS) as (keyof LessonExerciseDraft)[]).filter(
    (field) => SOLVER_FIELD_CLASS[field] === "key",
  );

  it("fixture wypełniają każde pole klasy key przynajmniej raz", () => {
    const unused = keyFields.filter((field) => !drafts.some((draft) => flatten(draft[field]).length > 0));
    expect(unused).toEqual([]);
  });

  it("pokrywa wszystkie typy ćwiczeń z fixture", () => {
    expect(new Set(drafts.map((draft) => draft.exerciseType)).size).toBe(drafts.length);
  });

  it.each(drafts.map((draft) => [draft.exerciseType, draft] as const))("%s: widok nie zawiera klucza", (_type, draft) => {
    const view = solverView(draft, topic);
    expect(view.length).toBeGreaterThan(0);
    for (const text of keyTexts(draft)) expect(view).not.toContain(text);
  });

  it("widok nie zawiera identyfikatorów opcji, bloków i grup", () => {
    for (const draft of drafts) {
      const view = solverView(draft, topic);
      for (const id of ["opt-", "it-1", "kw-", "grp-"]) expect(view).not.toContain(id);
    }
  });

  it("lesson_choice: opcje posortowane, polecenie i bodziec widoczne", () => {
    const view = solverView(drafts[1]!, topic);
    expect(view.split("\n")).toEqual(["Wybierz słowo.", "He ___ football.", "Options: play | plays"]);
  });

  it("lesson_cloze: tekst bez wstawionych odpowiedzi, bank = luki i dystraktory posortowane", () => {
    const draft = drafts.find((candidate) => candidate.exerciseType === "lesson_cloze")!;
    const lines = solverView(draft, topic).split("\n");
    expect(lines).toContain("Roślina pobiera ___ z powietrza i ___ z gleby.");
    expect(lines).toContain(`Word bank: ${[...draft.gapAnswers!, ...draft.extraWords!].sort((a, b) => a.localeCompare(b, "en")).join(" | ")}`);
    expect(lines.filter((line) => line.includes("dwutlenek") || line.includes("wodę"))).toEqual([lines.at(-1)]);
  });

  it("lesson_match: prawe posortowane z dystraktorami, żaden wiersz nie łączy lewej z jej prawą", () => {
    const draft = drafts.find((candidate) => candidate.exerciseType === "lesson_match")!;
    const lines = solverView(draft, topic).split("\n");
    expect(lines).toContain("Left (in this order): kot | pies | ryba");
    expect(lines).toContain("Right (shuffled): bird | cat | dog | fish");
    for (const pair of draft.pairs!) {
      expect(lines.filter((line) => line.includes(pair.left) && line.includes(pair.right))).toEqual([]);
    }
  });

  it("lesson_group: etykiety grup i elementy alfabetycznie (nie w kolejności szkicu), bez groupId", () => {
    const draft = drafts.find((candidate) => candidate.exerciseType === "lesson_group")!;
    const view = solverView(draft, topic);
    expect(view).toContain("Groups: Ssaki | Ptaki");
    expect(view).toContain("Items (in this order): słoń | wróbel");
    expect(view).not.toContain("grp-");
  });

  it("lesson_order: bloki posortowane", () => {
    const draft = drafts.find((candidate) => candidate.exerciseType === "lesson_order")!;
    expect(solverView(draft, topic)).toContain("Word blocks (shuffled): bones | dogs | like");
  });

  it("lesson_open_answer: tylko polecenie i pytanie, bez stem i statement", () => {
    const draft = drafts.find((candidate) => candidate.exerciseType === "lesson_open_answer")!;
    expect(solverView(draft, topic)).toBe("Odpowiedz.\nDlaczego jest zima?");
  });

  it("lesson_keywords: pytanie to tytuł celu, nie pole prompt szkicu", () => {
    const draft = make("lesson_keywords", {
      prompt: "Pole szkicu niewidoczne dla dziecka",
      keywordOptions: [{ id: "k1", text: "alfa" }, { id: "k2", text: "beta" }],
    });
    const lines = solverView(draft, topic).split("\n");
    expect(lines).toEqual(["Wybierz 2–3 najważniejsze pojęcia do tej odpowiedzi.", "Cel pierwszy", "Concepts: alfa | beta"]);
  });

  it("lesson_transform: polecenie z tematu, gdy szkic go nie niesie", () => {
    const draft = drafts.find((candidate) => candidate.exerciseType === "lesson_transform")!;
    const lines = solverView(draft, topic).split("\n");
    expect(lines).toEqual(["Zamień zdanie na przeczenie.", "He likes milk."]);
  });

  it("lesson_transform: polecenie ze szkicu ma pierwszeństwo przed tematem", () => {
    const draft = make("lesson_transform", { transformId: "tr-negate", instructionPl: "Własne.", statement: "He runs." });
    expect(solverView(draft, topic)).toBe("Własne.\nHe runs.");
  });

  it("lesson_choice: piktogram bodźca jest w widoku", () => {
    const draft = make("lesson_choice", {
      visualSubject: "girl",
      instructionPl: "Kto to?",
      stem: "___ is happy.",
      options: [{ id: "o1", text: "She" }, { id: "o2", text: "He" }],
      correctOption: "o1",
    });
    expect(solverView(draft, topic)).toContain("Picture shows: girl");
  });

  it("bez polecenia w szkicu widok bierze tytuł celu, jak materializacja", () => {
    expect(solverView(make("lesson_gap", { stem: "She ___ home." }), topic)).toBe("Cel pierwszy\nShe ___ home.");
  });

  it("lesson_match bez polecenia: stałe polecenie typu z katalogu komunikatów", () => {
    const draft = make("lesson_match", { pairs: [{ left: "a", right: "b" }] });
    expect(solverView(draft, topic).split("\n")[0]).toBe("Połącz w pary.");
  });

  it("lesson_calculation: widoczna treść zadania bez wyniku", () => {
    const draft = make("lesson_calculation", {
      calculation: { kind: "unit_conversion", unit: "km", templateFamilyId: "conv", params: { value: 2000, fromUnit: "m" } },
    });
    const view = solverView(draft, topic);
    expect(view).toContain("Przelicz 2000 m na km.");
    expect(view.split("\n")).toHaveLength(2); // polecenie i treść, bez wyniku
  });
});

describe("expectedAnswerCount", () => {
  it("cloze liczy luki, pary lewe strony, grupy elementy, reszta jedną odpowiedź", () => {
    expect(expectedAnswerCount(make("lesson_cloze", { gapAnswers: ["a", "b", "c"] }))).toBe(3);
    expect(
      expectedAnswerCount(
        make("lesson_match", {
          pairs: [
            { left: "1", right: "a" },
            { left: "2", right: "b" },
            { left: "3", right: "c" },
            { left: "4", right: "d" },
          ],
        }),
      ),
    ).toBe(4);
    expect(
      expectedAnswerCount(
        make("lesson_group", { groupItems: ["a", "b", "c", "d", "e"].map((text) => ({ text, groupId: "g" })) }),
      ),
    ).toBe(5);
    expect(expectedAnswerCount(make("lesson_choice", {}))).toBe(1);
  });
});

describe("blindMatches", () => {
  const cloze = make("lesson_cloze", { clozeText: "x ___ y ___ z", gapAnswers: ["it's", "dogs"] });
  const match = make("lesson_match", {
    pairs: [
      { left: "kot", right: "cat" },
      { left: "pies", right: "dog" },
    ],
  });
  const group = make("lesson_group", {
    groups: [
      { id: "g-m", label: "Ssaki" },
      { id: "g-b", label: "Ptaki" },
    ],
    groupItems: [
      { text: "słoń", groupId: "g-m" },
      { text: "wróbel", groupId: "g-b" },
      { text: "lew", groupId: "g-m" },
    ],
  });

  it("cloze: pozycyjnie, z wariantem przez normalizator przedmiotu", () => {
    expect(blindMatches(cloze, ["it's", "dogs"], variantNormalizer)).toBe(true);
    expect(blindMatches(cloze, ["it is", "dogs"], variantNormalizer)).toBe(true);
    expect(blindMatches(cloze, ["dogs", "it's"], variantNormalizer)).toBe(false);
  });

  it("pary: odpowiedzi „lewa => prawa” albo samo prawe, w kolejności lewych", () => {
    expect(blindMatches(match, ["kot => cat", "dog"], baseNormalizer)).toBe(true);
    expect(blindMatches(match, ["dog", "cat"], baseNormalizer)).toBe(false);
    expect(blindMatches(match, ["kot => dog", "pies => cat"], baseNormalizer)).toBe(false);
  });

  it("grupy: po etykietach grup w kolejności elementów z widoku (alfabetycznej)", () => {
    expect(solverView(group, topic)).toContain("Items (in this order): lew | słoń | wróbel");
    expect(blindMatches(group, ["lew => Ssaki", "słoń => Ssaki", "wróbel => ptaki"], baseNormalizer)).toBe(true);
    // Kolejność szkicu nie jest kluczem: odpowiedzi ułożone po niej to rozjazd.
    expect(blindMatches(group, ["słoń => Ssaki", "wróbel => Ptaki", "lew => Ssaki"], baseNormalizer)).toBe(false);
    expect(blindMatches(group, ["Ssaki", "Ptaki", "Ptaki"], baseNormalizer)).toBe(false);
  });

  it("inna liczba odpowiedzi niż oczekiwana to rozjazd", () => {
    expect(blindMatches(cloze, ["it's"], variantNormalizer)).toBe(false);
    expect(blindMatches(cloze, ["it's", "dogs", "extra"], variantNormalizer)).toBe(false);
    expect(blindMatches(match, ["cat"], baseNormalizer)).toBe(false);
    expect(blindMatches(group, [], baseNormalizer)).toBe(false);
    expect(blindMatches(make("lesson_gap", { answer: "goes" }), ["goes", "goes"], baseNormalizer)).toBe(false);
  });

  it("pozostałe typy: answer i acceptedAnswers, apostrof typograficzny bez znaczenia", () => {
    const gap = make("lesson_gap", { answer: "there's", acceptedAnswers: ["there is"] });
    expect(blindMatches(gap, ["There’s"], baseNormalizer)).toBe(true);
    expect(blindMatches(gap, ["there is"], baseNormalizer)).toBe(true);
    expect(blindMatches(gap, ["they are"], baseNormalizer)).toBe(false);
  });

  it("wariant przedmiotu uznaje odpowiedź jedynej luki", () => {
    const gap = make("lesson_gap", { answer: "it is", acceptedAnswers: [] });
    expect(blindMatches(gap, ["it's"], variantNormalizer)).toBe(true);
  });
});

describe("blindMismatchFound (spec katalogu reguł §4.4)", () => {
  const cloze = make("lesson_cloze", { clozeText: "x ___ y ___ z", gapAnswers: ["it's", "dogs"] });
  const match = make("lesson_match", {
    pairs: [
      { left: "kot", right: "cat" },
      { left: "pies", right: "dog" },
      { left: "koń", right: "horse" },
    ],
  });
  const group = make("lesson_group", {
    groups: [
      { id: "g-m", label: "Ssaki" },
      { id: "g-b", label: "Ptaki" },
    ],
    groupItems: [
      { text: "słoń", groupId: "g-m" },
      { text: "wróbel", groupId: "g-b" },
      { text: "lew", groupId: "g-m" },
    ],
  });

  it("jedna odpowiedź: odpowiedź rozwiązującego, klucz i warianty", () => {
    const gap = make("lesson_gap", { answer: "there's", acceptedAnswers: ["there is"] });
    expect(blindMismatchFound(gap, ["they are"], baseNormalizer)).toBe('the solver answered "they are"; the key is "there\'s", accepted variants "there is"');
    expect(blindMismatchFound(make("lesson_gap", { answer: "goes" }), ["go"], baseNormalizer)).toBe('the solver answered "go"; the key is "goes"');
  });

  it("inna liczba odpowiedzi: obie liczby, odpowiedzi i klucz", () => {
    expect(blindMismatchFound(cloze, ["it's"], variantNormalizer)).toBe('the solver gave 1 answers ("it\'s") where the key has 2 ("it\'s", "dogs")');
    expect(blindMismatchFound(group, [], baseNormalizer)).toBe('the solver gave 0 answers (nothing) where the key has 3 ("Ssaki", "Ssaki", "Ptaki")');
  });

  it("luki z bankiem: tylko różniące się luki, z wariantem przez normalizator", () => {
    expect(blindMismatchFound(cloze, ["it is", "cats"], variantNormalizer)).toBe(
      'the solver\'s answers differ from the key at gap 2: solver "cats", key "dogs"',
    );
  });

  it("pary: numer i lewa strona różniących się par", () => {
    expect(blindMismatchFound(match, ["kot => cat", "pies => horse", "koń => dog"], baseNormalizer)).toBe(
      'the solver\'s answers differ from the key at pair 2 "pies": solver "pies => horse", key "dog"; ' +
        'pair 3 "koń": solver "koń => dog", key "horse"',
    );
  });

  it("grupy: element w kolejności widoku i etykieta grupy", () => {
    // Kolejność widoku: lew, słoń, wróbel.
    expect(blindMismatchFound(group, ["lew => Ssaki", "słoń => Ptaki", "wróbel => Ptaki"], baseNormalizer)).toBe(
      'the solver\'s answers differ from the key at item 2 "słoń": solver "słoń => Ptaki", key "Ssaki"',
    );
  });

  it("długa odpowiedź i nowa linia: wycinek w jednym wierszu", () => {
    const found = blindMismatchFound(make("lesson_gap", { answer: "goes" }), [`${"a".repeat(200)}\nb`], baseNormalizer);
    expect(found).not.toContain("\n");
    expect(found).toContain("…");
  });
});
