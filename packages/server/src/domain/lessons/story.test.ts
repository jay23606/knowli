import { describe, expect, it } from "vitest";
import {
  LESSON_STORY_LIMITS,
  readStoredLessonStory,
  solvedSentencesOf,
  squashStoryText,
  storyCollisions,
  storyReadText,
  validateLessonStory,
  type LessonStory,
  type LessonStoryQuestion,
} from "./story";
import { englishNormalizer } from "./subjects/english/normalizer";
import type { LessonExerciseDraft } from "./types";

const ctx = { normalizer: englishNormalizer, solvedSentences: [] as readonly string[] };

function validStory(): { sentences: string[]; questions: LessonStoryQuestion[] } {
  return {
    sentences: ["Tom has a cat.", "The cat is small.", "Tom plays with the cat.", "They are happy."],
    questions: [
      {
        id: "q1",
        question: "Kto ma kota?",
        options: [
          { id: "a", text: "Tom" },
          { id: "b", text: "Ania" },
          { id: "c", text: "Mama" },
        ],
        correctOption: "a",
      },
    ],
  };
}

function withQuestion(patch: Partial<LessonStoryQuestion>): LessonStory {
  const story = validStory();
  return { ...story, questions: [{ ...story.questions[0]!, ...patch }] };
}

function draft(patch: Partial<LessonExerciseDraft>): LessonExerciseDraft {
  return {
    exerciseType: "lesson_gap",
    objectiveId: "o1",
    answer: "",
    acceptedAnswers: [],
    focus: [],
    ...patch,
  };
}

describe("validateLessonStory", () => {
  it("accepts a valid story", () => {
    expect(validateLessonStory(validStory(), ctx)).toEqual([]);
  });

  it("rejects 3 and 7 sentences", () => {
    const story = validStory();
    const three = { ...story, sentences: story.sentences.slice(0, 3) };
    const seven = { ...story, sentences: [...story.sentences, "A.", "B.", "C."] };
    expect(validateLessonStory(three, ctx)).toContain("Historyjka ma mieć od 4 do 6 zdań.");
    expect(validateLessonStory(seven, ctx)).toContain("Historyjka ma mieć od 4 do 6 zdań.");
  });

  it("rejects empty sentence", () => {
    const story = validStory();
    story.sentences[1] = "   ";
    expect(validateLessonStory(story, ctx)).toContain("Zdanie 2 jest puste.");
  });

  it("rejects sentence longer than 160", () => {
    const story = validStory();
    story.sentences[0] = "a".repeat(161);
    expect(validateLessonStory(story, ctx)).toContain("Zdanie 1 jest dłuższe niż 160 znaków.");
  });

  it("rejects story longer than 700", () => {
    const story = { ...validStory(), sentences: Array.from({ length: 6 }, () => "a".repeat(130)) };
    expect(validateLessonStory(story, ctx)).toContain("Historyjka jest dłuższa niż 700 znaków.");
  });

  it("rejects 0 and 3 questions", () => {
    const story = validStory();
    const q = story.questions[0]!;
    const three = { ...story, questions: [q, { ...q, id: "q2" }, { ...q, id: "q3" }] };
    expect(validateLessonStory({ ...story, questions: [] }, ctx)).toContain("Historyjka ma mieć 1 lub 2 pytania.");
    expect(validateLessonStory(three, ctx)).toContain("Historyjka ma mieć 1 lub 2 pytania.");
  });

  it("rejects duplicate question ids", () => {
    const story = validStory();
    const q = story.questions[0]!;
    expect(validateLessonStory({ ...story, questions: [q, { ...q }] }, ctx)).toContain(
      "Pytania mają powtarzające się identyfikatory.",
    );
  });

  it("rejects empty or long question", () => {
    expect(validateLessonStory(withQuestion({ question: "  " }), ctx)).toContain("Pytanie 1 jest puste.");
    expect(validateLessonStory(withQuestion({ question: "a".repeat(161) }), ctx)).toContain(
      "Pytanie 1 jest dłuższe niż 160 znaków.",
    );
  });

  it("rejects option count other than 3", () => {
    const options = [
      { id: "a", text: "Tom" },
      { id: "b", text: "Ania" },
    ];
    expect(validateLessonStory(withQuestion({ options }), ctx)).toContain("Pytanie 1 ma mieć dokładnie 3 odpowiedzi.");
  });

  it("rejects duplicate option text ignoring case", () => {
    const options = [
      { id: "a", text: "Kot" },
      { id: "b", text: "kot " },
      { id: "c", text: "Pies" },
    ];
    expect(validateLessonStory(withQuestion({ options }), ctx)).toContain(
      "Pytanie 1 ma powtarzające się odpowiedzi.",
    );
  });

  it("rejects empty or long option", () => {
    const base = [
      { id: "a", text: "Tom" },
      { id: "b", text: "Ania" },
      { id: "c", text: "Mama" },
    ];
    const empty = base.map((o) => (o.id === "b" ? { ...o, text: " " } : o));
    const long = base.map((o) => (o.id === "b" ? { ...o, text: "x".repeat(81) } : o));
    expect(validateLessonStory(withQuestion({ options: empty }), ctx)).toContain("Pytanie 1: odpowiedź 2 jest pusta.");
    expect(validateLessonStory(withQuestion({ options: long }), ctx)).toContain(
      "Pytanie 1: odpowiedź 2 jest dłuższa niż 80 znaków.",
    );
  });

  it("rejects duplicate option ids", () => {
    const options = [
      { id: "a", text: "Tom" },
      { id: "a", text: "Ania" },
      { id: "c", text: "Mama" },
    ];
    expect(validateLessonStory(withQuestion({ options }), ctx)).toContain(
      "Pytanie 1 ma powtarzające się identyfikatory odpowiedzi.",
    );
  });

  it("dedupes option text with Polish case folding", () => {
    const options = [
      { id: "a", text: "Łódź" },
      { id: "b", text: "ŁÓDŹ" },
      { id: "c", text: "Pies" },
    ];
    expect(validateLessonStory(withQuestion({ options }), ctx)).toContain(
      "Pytanie 1 ma powtarzające się odpowiedzi.",
    );
  });

  it("measures lengths after collapsing inner whitespace", () => {
    const story = validStory();
    story.sentences[0] = `${"a".repeat(75)}${" ".repeat(20)}${"b".repeat(75)}`;
    expect(validateLessonStory(story, ctx)).toEqual([]);
    const q = withQuestion({
      question: `${"a".repeat(75)}${" ".repeat(20)}${"b".repeat(75)}`,
      options: [
        { id: "a", text: `${"x".repeat(35)}${" ".repeat(20)}${"y".repeat(35)}` },
        { id: "b", text: "Ania" },
        { id: "c", text: "Mama" },
      ],
    });
    expect(validateLessonStory(q, ctx)).toEqual([]);
  });

  it("rejects unknown correctOption", () => {
    expect(validateLessonStory(withQuestion({ correctOption: "z" }), ctx)).toContain(
      "Pytanie 1 nie ma wskazanej poprawnej odpowiedzi.",
    );
  });

  it("rejects sentence equal to solved sentence after normalization", () => {
    const story = validStory();
    story.sentences[0] = "she doesn't play football";
    const errors = validateLessonStory(story, {
      normalizer: englishNormalizer,
      solvedSentences: ["She does not play football."],
    });
    expect(errors).toContain("Zdanie 1 powtarza rozwiązanie ćwiczenia.");
  });

  it("allows partial overlap", () => {
    const story = validStory();
    story.sentences[0] = "Tom plays football on Sundays.";
    expect(
      validateLessonStory(story, { normalizer: englishNormalizer, solvedSentences: ["Tom plays tennis."] }),
    ).toEqual([]);
  });

  it("validates single sentences even when the count is wrong", () => {
    const story = { ...validStory(), sentences: ["ok", " ", "fine"] };
    const errors = validateLessonStory(story, ctx);
    expect(errors).toContain("Historyjka ma mieć od 4 do 6 zdań.");
    expect(errors).toContain("Zdanie 2 jest puste.");
  });

  it("exposes the agreed limits", () => {
    expect(LESSON_STORY_LIMITS.optionCount).toBe(3);
  });
});

describe("storyCollisions", () => {
  it("returns indices of colliding sentences", () => {
    expect(
      storyCollisions(
        ["Tom runs.", "She does not play football.", "x"],
        ["she doesn't play football."],
        englishNormalizer,
      ),
    ).toEqual([1]);
  });
});

describe("storyCollisions z luką z czasownikiem w nawiasie", () => {
  it("wykrywa zdanie historyjki równe rozwiązaniu luki „___ (verb)”", () => {
    const solved = solvedSentencesOf([draft({ stem: "He ___ (play) football now.", answer: "is playing" })]);
    expect(storyCollisions(["Tom runs.", "He is playing football now.", "x"], solved, englishNormalizer)).toEqual([1]);
  });
});

describe("solvedSentencesOf", () => {
  it("fills a gap with the answer", () => {
    expect(solvedSentencesOf([draft({ stem: "She ___ football.", answer: "plays" })])).toEqual(["She plays football."]);
  });

  it("keeps solved sentences longer than the readback limit", () => {
    // Odczyt TTS pomija zdania > 200 znaków, bariera ekspozycji nie może.
    const stem = `She ___ football${"!".repeat(200)}`;
    expect(solvedSentencesOf([draft({ stem, answer: "plays" })])).toEqual([`She plays football${"!".repeat(200)}`]);
  });

  it("fills a choice stem with the correct option", () => {
    const sentences = solvedSentencesOf([
      draft({
        exerciseType: "lesson_choice",
        stem: "He ___ tea.",
        options: [
          { id: "a", text: "drink" },
          { id: "b", text: "drinks" },
        ],
        correctOption: "b",
      }),
    ]);
    expect(sentences).toEqual(["He drinks tea."]);
  });

  it("fills a listening choice stem with the correct option (the sentence read aloud)", () => {
    const sentences = solvedSentencesOf([
      draft({
        exerciseType: "lesson_listen_choice",
        stem: "She ___ milk.",
        options: [
          { id: "a", text: "like" },
          { id: "b", text: "likes" },
        ],
        correctOption: "b",
      }),
    ]);
    expect(sentences).toEqual(["She likes milk."]);
  });

  it("adds accepted full-sentence variants of a listening choice, not its gap word", () => {
    const sentences = solvedSentencesOf([
      draft({
        exerciseType: "lesson_listen_choice",
        stem: "She ___ milk.",
        options: [
          { id: "a", text: "like" },
          { id: "b", text: "likes" },
        ],
        correctOption: "b",
        answer: "likes",
        acceptedAnswers: ["She really likes milk.", " "],
      }),
    ]);
    expect(sentences).toEqual(["She likes milk.", "She really likes milk."]);
  });

  it("adds the correct option of a choice whose stem has no gap", () => {
    const sentences = solvedSentencesOf([
      draft({
        exerciseType: "lesson_choice",
        stem: "Które zdanie jest poprawne?",
        options: [
          { id: "a", text: "He play football." },
          { id: "b", text: " He plays football. " },
        ],
        correctOption: "b",
      }),
    ]);
    expect(sentences).toEqual(["He plays football."]);
  });

  it("fills a gap with every accepted answer variant", () => {
    const sentences = solvedSentencesOf([
      draft({ stem: "She ___ to school.", answer: "goes", acceptedAnswers: ["walks", "  "] }),
    ]);
    expect(sentences).toEqual(["She goes to school.", "She walks to school."]);
  });

  it("adds answer and acceptedAnswers of a transform", () => {
    expect(
      solvedSentencesOf([draft({ exerciseType: "lesson_transform", answer: "She plays.", acceptedAnswers: ["x"] })]),
    ).toEqual(["She plays.", "x"]);
  });

  it("skips notice exercises", () => {
    expect(
      solvedSentencesOf([
        draft({ exerciseType: "lesson_notice", noticeSegments: [["Tom", "runs"]], correctOption: "runs" }),
      ]),
    ).toEqual([]);
  });

  it("removes duplicates and empty values keeping first-seen order", () => {
    const sentences = solvedSentencesOf([
      draft({
        exerciseType: "lesson_open_answer",
        answer: " Tom runs. ",
        acceptedAnswers: ["Tom runs.", "  ", "Tom ran."],
      }),
      draft({ exerciseType: "lesson_gap", stem: "Tom ___", answer: "runs." }),
    ]);
    expect(sentences).toEqual(["Tom runs.", "Tom ran."]);
  });
});

describe("storyReadText", () => {
  it("joins sentences with single spaces and collapses whitespace", () => {
    expect(storyReadText({ sentences: [" Tom  has\na cat. ", "It   is small."], questions: [] })).toBe(
      "Tom has a cat. It is small.",
    );
  });
});

describe("readStoredLessonStory", () => {
  it("returns a valid story unchanged", () => {
    const story = validStory();
    expect(readStoredLessonStory(story)).toEqual(story);
  });

  it("squashStoryText trims and merges whitespace", () => {
    expect(squashStoryText("  Tom \n has   a cat. ")).toBe("Tom has a cat.");
  });

  it.each<[string, (story: ReturnType<typeof validStory>) => unknown]>([
    ["null", () => null],
    ["non-object", () => "story"],
    ["sentences not strings", (s) => ({ ...s, sentences: [1, 2] })],
    ["a sentence empty after squash", (s) => ({ ...s, sentences: ["Tom has a cat.", " \n\t "] })],
    ["no sentences", (s) => ({ ...s, sentences: [] })],
    ["7 sentences", (s) => ({ ...s, sentences: Array(7).fill("Tom has a cat.") })],
    ["0 questions", (s) => ({ ...s, questions: [] })],
    ["3 questions", (s) => ({ ...s, questions: [s.questions[0], s.questions[0], s.questions[0]] })],
    ["duplicate question ids", (s) => ({ ...s, questions: [s.questions[0], { ...s.questions[0], question: "Kto jest mały?" }] })],
    ["question with 2 options", (s) => ({ ...s, questions: [{ ...s.questions[0], options: s.questions[0].options.slice(0, 2) }] })],
    ["duplicate option id", (s) => ({
      ...s,
      questions: [{ ...s.questions[0], options: s.questions[0].options.map((o) => ({ ...o, id: "a" })) }],
    })],
    ["correctOption outside the options", (s) => ({ ...s, questions: [{ ...s.questions[0], correctOption: "zzz" }] })],
    ["empty question text", (s) => ({ ...s, questions: [{ ...s.questions[0], question: "  " }] })],
    ["empty question id", (s) => ({ ...s, questions: [{ ...s.questions[0], id: "" }] })],
    ["empty option text", (s) => ({
      ...s,
      questions: [{ ...s.questions[0], options: s.questions[0].options.map((o, i) => (i === 0 ? { ...o, text: "" } : o)) }],
    })],
  ])("returns undefined for %s", (_name, mutate) => {
    expect(readStoredLessonStory(mutate(validStory()))).toBeUndefined();
  });
});
