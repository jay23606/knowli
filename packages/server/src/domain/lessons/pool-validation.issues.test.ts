import { MAX_COMMON_ERRORS, MAX_LESSON_TEXT_LENGTH } from "@learning/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  GAP_MARKER,
  MAX_GAP_ANSWER_TOKENS,
  contractIssues,
  validateLessonExercise,
  validateLessonExerciseIssues,
  validatePool,
  validatePoolIssues,
} from "./pool-validation";
import { messagesOf, type LessonRuleIssue } from "./rules/catalog";
import { CORE_CASE_BASELINES } from "./rules/core.rule-cases";
import { LESSON_CASE_BASELINES } from "./rules/lesson.rule-cases";
import { historyLikeSubject } from "./testing/history-like-subject";
import { englishGrammarSubject } from "./subjects/english-grammar/module";
import { schoolSubject } from "./subjects/school/module";
import type { LessonExerciseDraft } from "./types";

/**
 * Zgłoszenia reguł rdzenia (spec katalogu reguł §4.2): tabela błędów kontraktu na
 * prawdziwym `safeParse` (z odstępstwem: liczności list i długość odpowiedzi z
 * własną regułą rdzenia dostają jej id), ponowna analiza po pustych napisach i
 * pominięcie `answer` typów liczonych (oba tylko na ścieżce agenta), pole
 * źródłowe zamiast `answer` i konkretne `found`. Komunikaty rodzica
 * (`validateLessonExercise`) pilnuje głównie `pool-validation.test.ts`.
 */

const englishTopic = englishGrammarSubject.topics[0]!;
const THIRD_PERSON = "english_grammar.present_simple.third_person_s";

function draft(overrides: Partial<LessonExerciseDraft>): LessonExerciseDraft {
  return {
    exerciseType: "lesson_gap",
    objectiveId: THIRD_PERSON,
    answer: "plays",
    acceptedAnswers: [],
    focus: ["plays"],
    stem: `She ${GAP_MARKER} tennis.`,
    hint: "play",
    ...overrides,
  };
}

const issuesOf = (ex: LessonExerciseDraft, options?: { readonly agent?: boolean }) =>
  validateLessonExerciseIssues(ex, englishGrammarSubject, englishTopic, options);

const rulesOf = (issues: readonly LessonRuleIssue[]) => issues.map((issue) => issue.rule as string);

const only = (issues: readonly LessonRuleIssue[], rule: string): LessonRuleIssue => {
  const matching = issues.filter((issue) => issue.rule === rule);
  expect(matching, `${rule} w ${JSON.stringify(issues)}`).toHaveLength(1);
  return matching[0]!;
};

/** Pytanie otwarte szkoły z polami v3 (kontrakt przepuszcza je dla każdego przedmiotu). */
function schoolOpen(overrides: Record<string, unknown>): LessonExerciseDraft {
  return {
    exerciseType: "lesson_open_answer",
    objectiveId: "school.x",
    prompt: "Co wytwarza roślina?",
    answer: "Cukry.",
    acceptedAnswers: [],
    focus: [],
    ...overrides,
  } as LessonExerciseDraft;
}

const schoolTopic = schoolSubject.topics[0] ?? englishTopic;
const schoolIssuesOf = (ex: LessonExerciseDraft) => validateLessonExerciseIssues(ex, schoolSubject, schoolTopic);

describe("kontrakt (Zod) → reguły", () => {
  it("pusty napis → field.empty z polem i dzisiejszym komunikatem", () => {
    const issue = only(issuesOf(draft({ hint: "" })), "field.empty");
    expect(issue).toMatchObject({ field: "hint", pl: "hint: wymagane minimum 1", found: "empty string" });
  });

  it("za długi napis → field.max_length z długością i limitem", () => {
    const issue = only(issuesOf(draft({ prompt: "p".repeat(134) })), "field.max_length");
    expect(issue.field).toBe("prompt");
    expect(issue.pl).toBe(`prompt: przekracza limit ${MAX_LESSON_TEXT_LENGTH}`);
    expect(issue.found).toContain("134");
    expect(issue.found).toContain(String(MAX_LESSON_TEXT_LENGTH));
  });

  it("za krótki napis z minimum > 1 → field.max_length, za krótka lista → field.count (według origin)", () => {
    const schema = z.object({ code: z.string().min(3), tags: z.array(z.string()).min(2) });
    const input = { code: "ab", tags: ["x"] };
    const parsed = schema.safeParse(input);
    expect(parsed.success).toBe(false);
    const issues = contractIssues(parsed.error!.issues, input);
    expect(issues.map((issue) => [issue.rule, issue.field])).toEqual([["field.max_length", "code"], ["field.count", "tags"]]);
    expect(issues[0]!.found).toBe("2 characters, minimum 3");
    expect(issues[1]!.found).toBe("1 items, at least 2");
    // Lista za krótka na prawdziwym kontrakcie ćwiczenia.
    expect(only(schoolIssuesOf(schoolOpen({ requiredElements: [] })), "field.count").field).toBe("requiredElements");
  });

  it("za długa lista → field.count z licznością i limitem", () => {
    const issue = only(
      schoolIssuesOf(schoolOpen({ commonErrors: Array.from({ length: 6 }, (_, i) => `błąd ${i}`) })),
      "field.count",
    );
    expect(issue.field).toBe("commonErrors");
    expect(issue.found).toContain("6");
    expect(issue.found).toContain(String(MAX_COMMON_ERRORS));
  });

  it("wartość spoza enum → field.invalid z otrzymaną wartością", () => {
    const issue = only(schoolIssuesOf(schoolOpen({ questionType: "explanation" })), "field.invalid");
    expect(issue.field).toBe("questionType");
    expect(issue.found).toContain('"explanation"');
    expect(issue.pl).toBe("questionType: nieprawidłowy typ lub wartość");
  });

  it.each([
    ["obcy klucz", { mood: "happy" }, "exercise", "mood"],
    ["invalid_union", { calculation: { kind: "bogus" } }, "calculation.kind", "matches none of the allowed shapes"],
    [
      "custom",
      { calculation: { kind: "scale_distance", params: { scaleDenominator: 100, mapDistanceCm: 1.0001 }, unit: "m", templateFamilyId: "map-scale" } },
      "calculation.params.mapDistanceCm",
      "fails the contract check",
    ],
  ] as const)("%s → field.invalid", (_name, overrides, field, foundPart) => {
    const issues = schoolIssuesOf(schoolOpen(overrides));
    const issue = only(issues, "field.invalid");
    expect(issue.field).toBe(field);
    expect(issue.found).toContain(foundPart);
  });

  it("liczności list z własną regułą rdzenia dostają jej id", () => {
    const tooManyVariants = issuesOf(draft({ acceptedAnswers: Array.from({ length: 41 }, (_, i) => `v${i}`) }));
    expect(rulesOf(tooManyVariants)).toEqual(["variants.count"]);
    const tooManyOptions = issuesOf(draft({
      exerciseType: "lesson_choice",
      options: Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, text: `word${i}` })),
      correctOption: "o0",
    }));
    expect(rulesOf(tooManyOptions)).toEqual(["options.count"]);
    const tooManyItems = issuesOf(draft({
      exerciseType: "lesson_order",
      items: Array.from({ length: 11 }, (_, i) => ({ id: `i${i}`, text: `w${i}` })),
    }));
    expect(rulesOf(tooManyItems)).toEqual(["order.items_count"]);
    const notice = (noticeSegments: string[][]) => issuesOf(draft({ exerciseType: "lesson_notice", noticeSegments, correctOption: "plays" }));
    expect(rulesOf(notice([["plays"], ["a"], ["b"], ["c"]]))).toEqual(["notice.sentence_count"]);
    const longSentence = notice([["plays", ...Array.from({ length: 15 }, (_, i) => `w${i}`)], ["a"]]);
    expect(rulesOf(longSentence)).toEqual(["notice.segment_count"]);
    expect(longSentence[0]!.field).toBe("noticeSegments[0]");
    const longAnswer = schoolIssuesOf(schoolOpen({ answer: "a".repeat(301) }));
    expect(rulesOf(longAnswer)).toEqual(["answer.max_length"]);
  });
});

describe("ponowna analiza po pustych napisach (ścieżka agenta)", () => {
  const emptyHintBadFocus = draft({ hint: "", focus: ["tennis"] });

  it("pusty napis w polu opcjonalnym i błędny focus → oba zgłoszenia", () => {
    const rules = rulesOf(issuesOf(emptyHintBadFocus, { agent: true }));
    expect(rules[0]).toBe("field.empty");
    expect(rules).toContain("focus.not_contiguous");
  });

  it("dalsze zgłoszenia o zdjętym polu są pomijane (pole ma już field.empty)", () => {
    const issues = issuesOf(draft({
      exerciseType: "lesson_choice",
      stem: "",
      hint: undefined,
      focus: [],
      options: [{ id: "a", text: "plays" }, { id: "b", text: "Plays" }],
      correctOption: "a",
    }), { agent: true });
    expect(rulesOf(issues)).toContain("options.duplicate");
    expect(issues.filter((issue) => issue.field === "stem").map((issue) => issue.rule)).toEqual(["field.empty"]);
  });

  it("field.empty i inny błąd kontraktu → tylko kontrakt", () => {
    const rules = rulesOf(issuesOf(draft({ hint: "", prompt: "p".repeat(134), focus: ["tennis"] }), { agent: true }));
    expect(rules.sort()).toEqual(["field.empty", "field.max_length"]);
  });

  it("bez opcji → tylko kontrakt (także w komunikatach rodzica)", () => {
    expect(rulesOf(issuesOf(emptyHintBadFocus))).toEqual(["field.empty"]);
    expect(validateLessonExercise(emptyHintBadFocus, englishGrammarSubject, englishTopic)).toEqual(["hint: wymagane minimum 1"]);
  });
});

describe("pole źródłowe zamiast answer w typach liczonych", () => {
  const base = (exerciseType: LessonExerciseDraft["exerciseType"], fields: Record<string, unknown>) =>
    ({ exerciseType, objectiveId: THIRD_PERSON, answer: "", acceptedAnswers: [], focus: [], ...fields }) as LessonExerciseDraft;

  it.each([
    ["lesson_match", "pairs", { pairs: [] }],
    ["lesson_group", "groups", { groups: [] }],
    ["lesson_cloze", "gapAnswers", { clozeText: "a ___ b ___ c", gapAnswers: [] }],
    ["lesson_keywords", "keyOptionIds", { keyOptionIds: [] }],
    ["lesson_calculation", "calculation", { calculation: { kind: "bogus" } }],
  ] as const)("%s: własne zgłoszenie pola %s → agent bez zgłoszenia answer, rodzic z nim", (type, source, fields) => {
    const draftOf = base(type, fields);
    const agent = issuesOf(draftOf, { agent: true });
    expect(agent.some((issue) => issue.field === source || issue.field.startsWith(`${source}.`))).toBe(true);
    expect(agent.some((issue) => issue.pl.startsWith("answer:"))).toBe(false);
    // Rodzic: dzisiejszy zbiór komunikatów, łącznie z komunikatem o answer.
    const parent = validateLessonExercise(draftOf, englishGrammarSubject, englishTopic);
    expect(parent).toContain("answer: wymagane minimum 1");
    expect(parent.length).toBe(agent.length + 1);
  });

  it("rodzic dla lesson_match z pairs: [] i answer: \"\" dostaje dokładnie dzisiejsze komunikaty", () => {
    const ex = base("lesson_match", { pairs: [] });
    expect(validateLessonExercise(ex, englishGrammarSubject, englishTopic)).toEqual([
      "answer: wymagane minimum 1",
      "pairs: wymagane minimum 3",
    ]);
    expect(messagesOf(issuesOf(ex, { agent: true }))).toEqual(["pairs: wymagane minimum 3"]);
  });

  it.each([
    ["lesson_match", "pairs"],
    ["lesson_group", "groups"],
    ["lesson_cloze", "gapAnswers"],
    ["lesson_keywords", "keyOptionIds"],
    ["lesson_calculation", "calculation"],
  ] as const)("%s bez pola źródłowego → zgłoszenie answer ma ścieżkę %s", (type, source) => {
    expect(issuesOf(base(type, {}), { agent: true })).toEqual(issuesOf(base(type, {})));
    const issue = only(issuesOf(base(type, {})), "field.empty");
    expect(issue.field).toBe(source);
    expect(issue.found).toContain(`answer computed from ${source}`);
    expect(issue.pl).toBe("answer: wymagane minimum 1");
  });
});

describe("found reguł typów", () => {
  it("focus.not_contiguous podaje tokeny odpowiedzi", () => {
    const issues = issuesOf(draft({
      exerciseType: "lesson_open_answer",
      prompt: "Co ona robi?",
      stem: undefined,
      hint: undefined,
      answer: "She plays tennis.",
      focus: ["tennis", "plays"],
    }));
    expect(only(issues, "focus.not_contiguous").found).toContain("she plays tennis");
  });

  it("order.items_join podaje złożony tekst i odpowiedź", () => {
    const issues = issuesOf(draft({
      exerciseType: "lesson_order",
      stem: undefined,
      hint: undefined,
      focus: [],
      items: [{ id: "1", text: "She" }, { id: "2", text: "plays" }, { id: "3", text: "tennis" }],
      answer: "She plays football",
    }));
    const found = only(issues, "order.items_join").found!;
    expect(found).toContain('"She plays tennis"');
    expect(found).toContain('"She plays football"');
  });

  it("options.correct_unknown podaje dozwolone id", () => {
    const issues = issuesOf(draft({
      exerciseType: "lesson_choice",
      hint: undefined,
      focus: [],
      options: [{ id: "a", text: "plays" }, { id: "b", text: "play" }],
      correctOption: "z",
    }));
    const issue = only(issues, "options.correct_unknown");
    expect(issue.field).toBe("correctOption");
    expect(issue.found).toContain('"z"');
    expect(issue.found).toContain("a, b");
  });

  it("gap.answer_tokens podaje liczbę słów i limit", () => {
    const issues = issuesOf(draft({ answer: "does not play now", focus: ["does not play now"], hint: undefined }));
    const found = only(issues, "gap.answer_tokens").found!;
    expect(found).toContain(`${MAX_GAP_ANSWER_TOKENS + 1} words`);
    expect(found).toContain(`limit ${MAX_GAP_ANSWER_TOKENS}`);
  });
});

describe("opakowanie dla rodzica", () => {
  it("validateLessonExercise to dokładnie komunikaty pl zgłoszeń", () => {
    const ex = draft({ focus: ["tennis"], acceptedAnswers: ["Plays"], visualSubject: "girl" });
    const issues = issuesOf(ex);
    expect(issues.length).toBeGreaterThan(1);
    expect(validateLessonExercise(ex, englishGrammarSubject, englishTopic)).toEqual(messagesOf(issues));
  });

  it("poprawne szkice przypadków reguł rdzenia i lekcji nie mają zgłoszeń", () => {
    for (const baseline of [...CORE_CASE_BASELINES, ...LESSON_CASE_BASELINES]) {
      expect(baseline.issues(), baseline.name).toEqual([]);
    }
  });
});

describe("reguły par, grup, luk z bankiem i słów kluczowych", () => {
  const computed = (exerciseType: LessonExerciseDraft["exerciseType"], fields: Record<string, unknown>) =>
    ({ exerciseType, objectiveId: THIRD_PERSON, answer: "x", acceptedAnswers: [], focus: [], ...fields }) as LessonExerciseDraft;

  it("groupId spoza grup → group.item_unknown_group z polem elementu i dozwolonymi id", () => {
    const issues = issuesOf(computed("lesson_group", {
      groups: [{ id: "g1", label: "Ssaki" }, { id: "g2", label: "Ptaki" }],
      groupItems: [
        { text: "Pies", groupId: "g1" },
        { text: "Kot", groupId: "g1" },
        { text: "Wróbel", groupId: "g2" },
        { text: "Sowa", groupId: "g4" },
      ],
    }));
    const issue = only(issues, "group.item_unknown_group");
    expect(issue.field).toBe("groupItems[3].groupId");
    expect(issue.found).toContain('"g4"');
    expect(issue.found).toContain("g1, g2");
    expect(issue.pl).toBe("groupItems: każdy element musi należeć do jednej z grup");
  });

  it("pojedyncze podkreślenie poza luką → cloze.underscore_outside_gap", () => {
    const issues = issuesOf(computed("lesson_cloze", {
      clozeText: "Roślina pobiera ___ z gleby_ i ___ z powietrza.",
      gapAnswers: ["wodę", "dwutlenek węgla"],
      extraWords: ["tlen"],
    }));
    const issue = only(issues, "cloze.underscore_outside_gap");
    expect(issue.field).toBe("clozeText");
    expect(issue.found).toContain("gleby_");
    expect(issue.pl).toBe("clozeText: podkreślenie poza znacznikiem luki");
  });

  it("dystraktor po prawej powtarzający tekst pary → match.confusable z polem dystraktora", () => {
    const issues = issuesOf(computed("lesson_match", {
      pairs: [{ left: "Wisła", right: "rzeka" }, { left: "Rysy", right: "szczyt" }, { left: "Kraków", right: "miasto" }],
      extraRight: ["długa rzeka"],
    }));
    const issue = only(issues, "match.confusable");
    expect(issue.field).toBe("extraRight[0]");
    expect(issue.found).toContain('"długa rzeka" and "rzeka"');
    expect(issue.pl).toBe("pairs: „długa rzeka” powiela „rzeka” albo się w nim zawiera");
  });

  it("odpowiedź różna od liczonej → reguła internal z obiema wartościami", () => {
    const issues = issuesOf(computed("lesson_keywords", {
      keywordOptions: [
        { id: "k1", text: "fotosynteza" },
        { id: "k2", text: "chlorofil" },
        { id: "k3", text: "korzeń" },
        { id: "k4", text: "kwiat" },
      ],
      keyOptionIds: ["k1", "k2"],
      answer: "chlorofil, fotosynteza",
    }));
    expect(only(issues, "keywords.answer_computed").found).toBe('answer "chlorofil, fotosynteza", computed "fotosynteza, chlorofil"');
  });

  it.each([
    ["lesson_match", { pairs: Array.from({ length: 6 }, (_, i) => ({ left: `l${i}`, right: `r${i}` })) }, "match.pairs_count", "pairs"],
    ["lesson_match", { extraRight: ["a", "b", "c"] }, "match.extra_count", "extraRight"],
    ["lesson_group", { groups: Array.from({ length: 4 }, (_, i) => ({ id: `g${i}`, label: `l${i}` })) }, "group.groups_count", "groups"],
    ["lesson_group", { groupItems: Array.from({ length: 9 }, (_, i) => ({ text: `t${i}`, groupId: "g" })) }, "group.items_count", "groupItems"],
    ["lesson_cloze", { gapAnswers: ["a", "b", "c", "d", "e"] }, "cloze.gap_count", "gapAnswers"],
    ["lesson_cloze", { extraWords: ["a", "b", "c"] }, "cloze.extra_count", "extraWords"],
    ["lesson_keywords", { keywordOptions: Array.from({ length: 7 }, (_, i) => ({ id: `k${i}`, text: `t${i}` })) }, "keywords.options_count", "keywordOptions"],
    ["lesson_keywords", { keyOptionIds: ["a", "b", "c", "d"] }, "keywords.key_count", "keyOptionIds"],
  ] as const)("%s: liczność ponad kontrakt → %s (pole %s)", (type, fields, rule, field) => {
    const issue = only(issuesOf(computed(type, fields)), rule);
    expect(issue.field).toBe(field);
  });
});

describe("reguły całej puli (validatePoolIssues)", () => {
  const objectiveId = historyLikeSubject.topics[0]!.objectives[0]!.id;
  const historyTopic = historyLikeSubject.topics[0]!;
  const gapOf = (stem: string, answer: string): LessonExerciseDraft =>
    ({ exerciseType: "lesson_gap", objectiveId, stem, answer, acceptedAnswers: [], focus: [answer] });

  it("powtórzony bodziec → lesson.duplicate_stimulus z typem i fragmentem pierwszego ćwiczenia", () => {
    const subject = { ...historyLikeSubject, poolDeduplication: "exercise" as const };
    const first = gapOf("Chrzest Polski odbył się w ___ roku.", "966");
    const second = gapOf("Chrzest Polski odbył się w ___ roku.", "967");
    const result = validatePoolIssues([first, second], subject, historyTopic);
    expect(result.valid).toEqual([first]);
    expect(result.rejected).toHaveLength(1);
    const [issue] = result.rejected[0]!.issues;
    expect(issue).toMatchObject({
      rule: "lesson.duplicate_stimulus",
      field: "exercise",
      pl: "stimulus: zduplikowany bodziec ćwiczenia w tej samej regule",
    });
    expect(issue!.found).toContain("lesson_gap");
    expect(issue!.found).toContain("chrzest polski odbył się");
  });

  it("równoważna odpowiedź → lesson.duplicate_answer z obiema odpowiedziami", () => {
    const result = validatePoolIssues(
      [gapOf("Chrzest Polski odbył się w ___ roku.", "966"), gapOf("Mieszko przyjął chrzest w ___ roku.", "966")],
      historyLikeSubject,
      historyTopic,
    );
    const [issue] = result.rejected[0]!.issues;
    expect(issue).toMatchObject({ rule: "lesson.duplicate_answer", field: "answer", pl: "answer: duplikat odpowiedzi „966” już obecnej w puli" });
    expect(issue!.found).toBe('answer "966" is equivalent to the answer "966" of an earlier exercise');
  });

  it("validatePool to te same ćwiczenia z komunikatami pl zgłoszeń (także odrzucenia pojedynczego ćwiczenia)", () => {
    const pool = [
      gapOf("Chrzest Polski odbył się w ___ roku.", "966"),
      gapOf("Mieszko przyjął chrzest w ___ roku.", "966"),
      gapOf("Bez luki.", "966"),
    ];
    const issues = validatePoolIssues(pool, historyLikeSubject, historyTopic);
    const parent = validatePool(pool, historyLikeSubject, historyTopic);
    expect(parent.valid).toEqual(issues.valid);
    expect(parent.rejected).toEqual(issues.rejected.map(({ exercise, issues: list }) => ({ exercise, errors: messagesOf(list) })));
    expect(parent.rejected.map((entry) => entry.errors[0])).toEqual([
      "stem: „lesson_gap” wymaga dokładnie jednego znacznika luki „___” (znaleziono 0)",
      "answer: duplikat odpowiedzi „966” już obecnej w puli",
    ]);
  });

  it("opcja agent przechodzi do walidacji ćwiczenia (bez zgłoszenia answer typu liczonego)", () => {
    const match = { exerciseType: "lesson_match", objectiveId: THIRD_PERSON, pairs: [], answer: "", acceptedAnswers: [], focus: [] } as unknown as LessonExerciseDraft;
    const agent = validatePoolIssues([match], englishGrammarSubject, englishTopic, { agent: true });
    expect(messagesOf(agent.rejected[0]!.issues)).toEqual(["pairs: wymagane minimum 3"]);
    expect(validatePool([match], englishGrammarSubject, englishTopic).rejected[0]!.errors).toEqual([
      "answer: wymagane minimum 1",
      "pairs: wymagane minimum 3",
    ]);
  });
});
