import { describe, expect, it } from "vitest";
import {
  EXERCISE_TYPES,
  TaskPromptSchema,
  AttemptInputSchema,
  AttemptModalitySchema,
  FeedbackDtoSchema,
  KidDeckDtoSchema,
  SessionSummaryDtoSchema,
  SessionInputSchema,
  KidValidationReasonSchema,
  MAX_TEXT_ATTEMPT_LENGTH,
} from "./kid";
import { messages } from "./messages";

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";

const option = { id: UUID, text: "plays" };

describe("public calculation prompt", () => {
  const prompt = { kind: "lesson_calculation", instructionPl: "Oblicz.", prompt: "Przelicz 2 km na m." };
  it("accepts the written question and registers its exercise type", () => {
    expect(TaskPromptSchema.safeParse(prompt).success).toBe(true);
    expect(EXERCISE_TYPES as readonly string[]).toContain("lesson_calculation");
  });
  it.each([
    ["calculation", {
      kind: "unit_conversion", params: { value: 2, fromUnit: "km" }, unit: "m", templateFamilyId: "units",
    }],
    ["answer", "2000 m"], ["acceptedAnswers", []], ["focus", []],
    ["requiredElements", [{ id: "result", text: "2000 m" }]], ["audioAssetId", UUID],
  ] as const)("rejects private or unsupported field %s", (field, value) => {
    expect(TaskPromptSchema.safeParse({ ...prompt, [field]: value }).success).toBe(false);
  });
});

describe("precision trainer prompts (Etap 4)", () => {
  const options = [UUID, UUID2, "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"]
    .map((id, index) => ({ id, text: `pojęcie ${index}` }));
  const keywords = { kind: "lesson_keywords", instructionPl: "Wybierz.", prompt: "Co to jest fotosynteza?", options, minSelected: 2, maxSelected: 3 };
  const shorten = {
    kind: "lesson_shorten", instructionPl: "Skróć.", prompt: "Co to jest fotosynteza?",
    originalAnswer: "Roślina robi cukry i jest zielona.",
    answerSegments: [{ text: "Roślina robi cukry", state: "plain" }, { text: " i jest zielona.", state: "pill" }],
  };
  it("accepts both prompts and registers lesson_keywords", () => {
    expect(TaskPromptSchema.safeParse(keywords).success).toBe(true);
    expect(TaskPromptSchema.safeParse(shorten).success).toBe(true);
    expect(EXERCISE_TYPES as readonly string[]).toContain("lesson_keywords");
  });
  it.each([
    ["keyOptionIds", [UUID]], ["answer", "pojęcie 0"], ["familyId", "fam"],
  ] as const)("keywords prompt never carries the key (%s)", (field, value) => {
    expect(TaskPromptSchema.safeParse({ ...keywords, [field]: value }).success).toBe(false);
  });
  it("rejects selection bounds that do not fit the options", () => {
    expect(TaskPromptSchema.safeParse({ ...keywords, minSelected: 3, maxSelected: 2 }).success).toBe(false);
    expect(TaskPromptSchema.safeParse({ ...keywords, maxSelected: 5 }).success).toBe(false);
    expect(TaskPromptSchema.safeParse({ ...keywords, options: options.slice(0, 3) }).success).toBe(false);
  });
  it("shorten prompt carries only the child own answer, never the model answer", () => {
    expect(TaskPromptSchema.safeParse({ ...shorten, answer: "Roślina robi cukry." }).success).toBe(false);
    expect(TaskPromptSchema.safeParse({ ...shorten, requiredElements: [] }).success).toBe(false);
    expect(TaskPromptSchema.safeParse({ ...shorten, originalAnswer: "a".repeat(MAX_TEXT_ATTEMPT_LENGTH + 1) }).success).toBe(false);
  });
  it("accepts an unordered selection of unique ids", () => {
    const base = { taskId: UUID, clientAttemptId: UUID2, modality: "selection" };
    expect(AttemptInputSchema.safeParse({ ...base, itemIds: [UUID, UUID2] }).success).toBe(true);
    expect(AttemptInputSchema.safeParse({ ...base, itemIds: [UUID, UUID] }).success).toBe(false);
    expect(AttemptInputSchema.safeParse({ ...base, itemIds: [] }).success).toBe(false);
    expect(AttemptModalitySchema.safeParse("selection").success).toBe(true);
  });
  it("lesson_precision_hint requires the template text", () => {
    expect(FeedbackDtoSchema.safeParse({ kind: "lesson_precision_hint", hintPl: "Wiesz to!" }).success).toBe(true);
    expect(FeedbackDtoSchema.safeParse({ kind: "lesson_precision_hint" }).success).toBe(false);
    expect(FeedbackDtoSchema.safeParse({ kind: "great", hintPl: "Wiesz to!" }).success).toBe(false);
  });
});

describe("EXERCISE_TYPES includes the 9 lesson types", () => {
  it("contains every lesson_* type", () => {
    for (const t of [
      "lesson_card", "lesson_notice", "lesson_choice", "lesson_order",
      "lesson_short_answer", "lesson_gap", "lesson_error_fix", "lesson_transform", "lesson_open_answer",
    ]) {
      expect(EXERCISE_TYPES as readonly string[]).toContain(t);
    }
  });
});

describe("lesson_listen_choice prompt", () => {
  const prompt = { kind: "lesson_listen_choice", stem: "He ___ football.", options: [option], contentLocale: "en-GB" };
  it("accepts stem, options and contentLocale, and registers the exercise type", () => {
    expect(TaskPromptSchema.safeParse(prompt).success).toBe(true);
    expect(TaskPromptSchema.safeParse({ kind: "lesson_listen_choice", stem: "He ___ football.", options: [option] }).success).toBe(true);
    expect(EXERCISE_TYPES as readonly string[]).toContain("lesson_listen_choice");
  });
  it.each([
    ["instructionPl", { instructionPl: "Wybierz" }],
    ["audioAssetId", { audioAssetId: UUID }],
    ["questionAudioAssetId", { questionAudioAssetId: UUID }],
    ["correctOptionId", { correctOptionId: UUID }],
  ])("rejects a prompt carrying %s", (_label, extra) => {
    expect(TaskPromptSchema.safeParse({ ...prompt, ...extra }).success).toBe(false);
  });
  it("requires at least one option", () => {
    expect(TaskPromptSchema.safeParse({ ...prompt, options: [] }).success).toBe(false);
  });
});

describe("retired daily round API", () => {
  it("rejects stale requests to start a daily round", () => {
    expect(SessionInputSchema.safeParse({
      childId: UUID, deckId: UUID2, microphoneEnabled: false, mode: "daily_round" as never, supportsPictureVocabulary: true,
    }).success).toBe(false);
  });
});

describe("TaskPrompt lesson branches parse", () => {
  it("lesson_card", () => {
    expect(TaskPromptSchema.safeParse({
      kind: "lesson_card", card: { title: "Reguła", body: "Dodaj -s", examples: ["He plays."] },
    }).success).toBe(true);
  });
  it("lesson_notice exposes segments only", () => {
    expect(TaskPromptSchema.safeParse({
      kind: "lesson_notice", instructionPl: "Dotknij słowa",
      segments: [[{ id: UUID, text: "He" }, { id: UUID2, text: "plays" }]],
    }).success).toBe(true);
  });
  it("lesson_choice", () => {
    expect(TaskPromptSchema.safeParse({
      kind: "lesson_choice", instructionPl: "Wybierz", stem: "He ___ football.", options: [option],
    }).success).toBe(true);
  });
  it("lesson_order shuffled items", () => {
    expect(TaskPromptSchema.safeParse({
      kind: "lesson_order", instructionPl: "Ułóż", items: [{ id: UUID, text: "He" }, { id: UUID2, text: "plays" }],
    }).success).toBe(true);
  });
  it("lesson_short_answer", () => {
    expect(TaskPromptSchema.safeParse({
      kind: "lesson_short_answer", question: "Does he play?", options: [option],
    }).success).toBe(true);
  });
  it("lesson_gap with stemWithGap", () => {
    expect(TaskPromptSchema.safeParse({
      kind: "lesson_gap", instructionPl: "Uzupełnij", stemWithGap: "He ___ (play).",
    }).success).toBe(true);
  });
  it("lesson_error_fix", () => {
    expect(TaskPromptSchema.safeParse({
      kind: "lesson_error_fix", instructionPl: "Popraw", statement: "He play football.",
    }).success).toBe(true);
  });
  it("lesson_transform", () => {
    expect(TaskPromptSchema.safeParse({
      kind: "lesson_transform", instructionPl: "Zamień na przeczenie", statement: "He plays.",
    }).success).toBe(true);
  });
  it("lesson_open_answer", () => {
    expect(TaskPromptSchema.safeParse({
      kind: "lesson_open_answer", instructionPl: "Odpowiedz", prompt: "Przetłumacz: On gra.",
    }).success).toBe(true);
  });
});

describe("TaskPrompt lesson branches never leak private fields", () => {
  it.each([
    ["answer", { kind: "lesson_gap", instructionPl: "i", stemWithGap: "He ___.", answer: "plays" }],
    ["acceptedAnswers", { kind: "lesson_gap", instructionPl: "i", stemWithGap: "He ___.", acceptedAnswers: ["plays"] }],
    ["focus", { kind: "lesson_gap", instructionPl: "i", stemWithGap: "He ___.", focus: ["plays"] }],
    ["objectiveId", { kind: "lesson_choice", instructionPl: "i", stem: "s", options: [option], objectiveId: "o1" }],
    ["errorCategory", { kind: "lesson_choice", instructionPl: "i", stem: "s", options: [option], errorCategory: "missing_s" }],
    ["correctOption", { kind: "lesson_notice", instructionPl: "i", segments: [[{ id: UUID, text: "He" }]], correctOption: "He" }],
  ])("rejects a lesson prompt carrying %s", (_label, prompt) => {
    expect(TaskPromptSchema.safeParse(prompt).success).toBe(false);
  });
});

describe("AttemptInput text modality", () => {
  it("accepts a school open answer up to the 600 characters the grader reads, and rejects longer", () => {
    const attempt = (length: number) => ({ taskId: UUID, clientAttemptId: UUID2, modality: "text", text: "a".repeat(length) });
    expect(MAX_TEXT_ATTEMPT_LENGTH).toBe(600);
    expect(AttemptInputSchema.safeParse(attempt(600)).success).toBe(true);
    expect(AttemptInputSchema.safeParse(attempt(601)).success).toBe(false);
  });
});

describe("spoken answers (Etap 3)", () => {
  const open = { kind: "lesson_open_answer", instructionPl: "Odpowiedz", prompt: "Co to jest poziomica?", promptLocale: "pl-PL" };
  it("open answer and shorten prompts may offer dictation with a recording limit only", () => {
    expect(TaskPromptSchema.safeParse({ ...open, speechInput: { maxSeconds: 45 } }).success).toBe(true);
    expect(TaskPromptSchema.safeParse({
      kind: "lesson_shorten", instructionPl: "Skróć.", prompt: "Co to jest poziomica?", originalAnswer: "Linia.",
      answerSegments: [{ text: "Linia.", state: "plain" }], speechInput: { maxSeconds: 45 },
    }).success).toBe(true);
    // język nagrania wybiera serwer; prompt nie niesie locale ani innych pól
    expect(TaskPromptSchema.safeParse({ ...open, speechInput: { maxSeconds: 45, locale: "pl-PL" } }).success).toBe(false);
    expect(TaskPromptSchema.safeParse({ ...open, speechInput: { maxSeconds: 600 } }).success).toBe(false);
    expect(TaskPromptSchema.safeParse({ kind: "lesson_calculation", instructionPl: "i", prompt: "2+2", speechInput: { maxSeconds: 45 } }).success).toBe(false);
  });
  it("text attempts may declare dictation as their input method", () => {
    const base = { taskId: UUID, clientAttemptId: UUID2, modality: "text", text: "Linia na mapie." };
    expect(AttemptInputSchema.safeParse({ ...base, inputMethod: "speech" }).success).toBe(true);
    expect(AttemptInputSchema.safeParse({ ...base, inputMethod: "keyboard" }).success).toBe(true);
    expect(AttemptInputSchema.safeParse(base).success).toBe(true);
    expect(AttemptInputSchema.safeParse({ ...base, inputMethod: "handwriting" }).success).toBe(false);
  });
});

describe("AttemptInput sequence modality", () => {
  it("accepts a sequence of unique item ids", () => {
    expect(AttemptInputSchema.safeParse({
      taskId: UUID, clientAttemptId: UUID2, modality: "sequence", itemIds: [UUID, UUID2],
    }).success).toBe(true);
  });
  it("rejects empty, duplicate, or >10 item ids", () => {
    expect(AttemptInputSchema.safeParse({ taskId: UUID, clientAttemptId: UUID2, modality: "sequence", itemIds: [] }).success).toBe(false);
    expect(AttemptInputSchema.safeParse({ taskId: UUID, clientAttemptId: UUID2, modality: "sequence", itemIds: [UUID, UUID] }).success).toBe(false);
    const eleven = Array.from({ length: 11 }, (_, i) => `${(i + 1).toString().repeat(8)}-1111-4111-8111-111111111111`.slice(0, 36));
    expect(AttemptInputSchema.safeParse({ taskId: UUID, clientAttemptId: UUID2, modality: "sequence", itemIds: eleven }).success).toBe(false);
  });
  it("AttemptModalitySchema includes sequence", () => {
    expect(AttemptModalitySchema.safeParse("sequence").success).toBe(true);
  });
});

describe("FeedbackDto lesson kinds", () => {
  const seg = [{ text: "he ", state: "plain" }, { text: "play", state: "pill" }];
  it("accepts lesson_almost with answerSegments", () => {
    expect(FeedbackDtoSchema.safeParse({
      kind: "lesson_almost", correctText: "he plays", answerSegments: seg,
    }).success).toBe(true);
  });
  it("accepts lesson_hint with hintPl", () => {
    expect(FeedbackDtoSchema.safeParse({
      kind: "lesson_hint", correctText: "he plays", hintPl: "Dodaj -s w 3. osobie.",
    }).success).toBe(true);
  });
  it("rejects lesson_hint without hintPl", () => {
    expect(FeedbackDtoSchema.safeParse({ kind: "lesson_hint", correctText: "he plays" }).success).toBe(false);
  });
  it("rejects answerSegments on a non-lesson kind", () => {
    expect(FeedbackDtoSchema.safeParse({ kind: "great", answerSegments: seg }).success).toBe(false);
  });
  it("still accepts the existing spelling_hint rule", () => {
    const diff = {
      given: [{ text: "We", state: "plain" }, { text: "nd", state: "pill" }, { text: "esday", state: "plain" }],
      expected: [{ text: "We", state: "plain" }, { text: "dn", state: "pill" }, { text: "esday", state: "plain" }],
    };
    expect(FeedbackDtoSchema.safeParse({ kind: "spelling_hint", correctText: "Wednesday", spellingDiff: diff }).success).toBe(true);
  });
});

describe("SessionSummaryDto lesson objectives variant", () => {
  const base = {
    sessionId: UUID,
    state: "completed" as const,
    tasksIssued: 5,
    assessedTasksIssued: 4,
    endedAt: "2026-10-12T18:00:00.000Z",
    independentSuccesses: { recall: 0, spelling: 0 },
    practiceItems: [],
  };
  it("accepts a vocab summary WITHOUT objectives (backward compatible)", () => {
    expect(SessionSummaryDtoSchema.safeParse(base).success).toBe(true);
    expect(SessionSummaryDtoSchema.parse(base).objectives).toBeUndefined();
  });
  it("accepts a lesson summary with objectives (no percentages, no technical status)", () => {
    const parsed = SessionSummaryDtoSchema.safeParse({
      ...base,
      objectives: [
        { objectiveId: "english_grammar.present_simple.third_person_s", titlePl: "-s w 3. osobie", practiced: 3, correct: 2 },
      ],
    });
    expect(parsed.success).toBe(true);
  });
  it("rejects an objective carrying a technical status or percentage field", () => {
    expect(SessionSummaryDtoSchema.safeParse({
      ...base,
      objectives: [{ objectiveId: "o1", titlePl: "t", practiced: 1, correct: 1, status: "mastered" }],
    }).success).toBe(false);
    expect(SessionSummaryDtoSchema.safeParse({
      ...base,
      objectives: [{ objectiveId: "o1", titlePl: "t", practiced: 1, correct: 1, percent: 100 }],
    }).success).toBe(false);
  });
});

describe("KidDeckDto kind/subjectTitle backward compat", () => {
  const base = {
    deckId: UUID, title: "Present Simple", itemCount: 10, independentlyRecalledCount: 0,
    testDate: null, recommended: false,
  };
  it("parses a legacy deck without kind/subjectTitle (optional, undefined)", () => {
    const parsed = KidDeckDtoSchema.parse(base);
    expect(parsed.kind).toBeUndefined();
    expect(parsed.subjectTitle).toBeUndefined();
  });
  it("accepts kind lesson with a subjectTitle", () => {
    expect(KidDeckDtoSchema.safeParse({ ...base, kind: "lesson", subjectTitle: "Angielski — gramatyka" }).success).toBe(true);
  });
  it("accepts kind vocabulary with null subjectTitle", () => {
    expect(KidDeckDtoSchema.safeParse({ ...base, kind: "vocabulary", subjectTitle: null }).success).toBe(true);
  });
});

describe("pary i grupy (design szkoły §10)", () => {
  const ids = Array.from({ length: 8 }, (_, i) => `${String(i + 1).repeat(8)}-1111-4111-8111-111111111111`);
  const item = (i: number, text: string) => ({ id: ids[i]!, text });
  const match = { kind: "lesson_match", instructionPl: "Połącz w pary.", left: [item(0, "a"), item(1, "b"), item(2, "c")], right: [item(3, "x"), item(4, "y"), item(5, "z"), item(6, "w")] };
  const group = { kind: "lesson_group", instructionPl: "Pogrupuj.", groups: [item(0, "g1"), item(1, "g2")], items: [item(2, "a"), item(3, "b"), item(4, "c"), item(5, "d")] };

  it("przyjmuje prompty bez klucza i rejestruje typy", () => {
    expect(TaskPromptSchema.safeParse(match).success).toBe(true);
    expect(TaskPromptSchema.safeParse(group).success).toBe(true);
    expect(EXERCISE_TYPES as readonly string[]).toEqual(expect.arrayContaining(["lesson_match", "lesson_group"]));
  });

  it.each([
    ["pairs", [{ left: "a", right: "x" }]], ["assignments", []], ["answer", "a"],
  ] as const)("odrzuca prywatne pole %s", (field, value) => {
    expect(TaskPromptSchema.safeParse({ ...match, [field]: value }).success).toBe(false);
    expect(TaskPromptSchema.safeParse({ ...group, [field]: value }).success).toBe(false);
  });

  it("odrzuca prawą kolumnę krótszą od lewej i elementy z grupą", () => {
    expect(TaskPromptSchema.safeParse({ ...match, right: match.right.slice(0, 2) }).success).toBe(false);
    expect(TaskPromptSchema.safeParse({ ...group, items: group.items.map((entry) => ({ ...entry, groupId: "g1" })) }).success).toBe(false);
  });

  it("odpowiedź `assignment`: 2–8 przypisań (luki od 2), każdy element raz", () => {
    const base = { taskId: UUID, clientAttemptId: UUID2, modality: "assignment" };
    const assignments = [0, 1, 2].map((i) => ({ itemId: ids[i]!, targetId: ids[i + 3]! }));
    expect(AttemptModalitySchema.safeParse("assignment").success).toBe(true);
    expect(AttemptInputSchema.safeParse({ ...base, assignments }).success).toBe(true);
    expect(AttemptInputSchema.safeParse({ ...base, assignments: assignments.slice(0, 2) }).success).toBe(true);
    expect(AttemptInputSchema.safeParse({ ...base, assignments: assignments.slice(0, 1) }).success).toBe(false);
    expect(AttemptInputSchema.safeParse({ ...base, assignments: [...assignments, { itemId: ids[0]!, targetId: ids[6]! }] }).success).toBe(false);
  });
});

describe("uzupełnij tekst (design szkoły §13.2)", () => {
  const ids = Array.from({ length: 8 }, (_, i) => `${String(i + 1).repeat(8)}-2222-4222-8222-222222222222`);
  const word = (i: number, text: string) => ({ id: ids[i]!, text });
  const cloze = {
    kind: "lesson_cloze",
    instructionPl: "Uzupełnij tekst.",
    segments: [{ text: "Rośliny pobierają " }, { gapId: ids[0]! }, { text: " z powietrza i " }, { gapId: ids[1]! }, { text: " z gleby." }],
    words: [word(2, "wodę"), word(3, "dwutlenek węgla"), word(4, "tlen")],
  };

  it("przyjmuje tekst z lukami i bank bez klucza", () => {
    expect(TaskPromptSchema.safeParse(cloze).success).toBe(true);
    expect(EXERCISE_TYPES as readonly string[]).toContain("lesson_cloze");
  });

  it.each([
    ["gapAnswers", ["wodę"]], ["assignments", []], ["answer", "wodę"], ["filledText", "Rośliny…"],
  ] as const)("odrzuca prywatne pole %s", (field, value) => {
    expect(TaskPromptSchema.safeParse({ ...cloze, [field]: value }).success).toBe(false);
  });

  it("odrzuca segment z kluczem, powtórzoną lukę i bank bez dystraktora", () => {
    expect(TaskPromptSchema.safeParse({ ...cloze, segments: [...cloze.segments.slice(0, 4), { gapId: ids[1]!, word: "wodę" }] }).success).toBe(false);
    expect(TaskPromptSchema.safeParse({ ...cloze, segments: [{ gapId: ids[0]! }, { text: " i " }, { gapId: ids[0]! }] }).success).toBe(false);
    expect(TaskPromptSchema.safeParse({ ...cloze, segments: [{ gapId: ids[0]! }, { text: " i " }] }).success).toBe(false);
    // Trzy luki i trzy słowa: kształt przechodzi `min(3)`, odpada dopiero na braku dystraktora.
    const threeGaps = [{ text: "A " }, { gapId: ids[0]! }, { text: " b " }, { gapId: ids[1]! }, { text: " c " }, { gapId: ids[5]! }];
    expect(TaskPromptSchema.safeParse({ ...cloze, segments: threeGaps, words: cloze.words }).success).toBe(false);
    expect(TaskPromptSchema.safeParse({ ...cloze, segments: threeGaps, words: [...cloze.words, word(6, "azot")] }).success).toBe(true);
  });
});

describe("język treści zadań lekcji (angielski — rozdział)", () => {
  const ids = Array.from({ length: 8 }, (_, i) => `${String(i + 1).repeat(8)}-3333-4333-8333-333333333333`);
  const item = (i: number, text: string) => ({ id: ids[i]!, text });
  const prompts = {
    lesson_choice: { kind: "lesson_choice", instructionPl: "Wybierz", stem: "He ___ football.", options: [option] },
    lesson_order: { kind: "lesson_order", instructionPl: "Ułóż", items: [item(0, "He"), item(1, "plays")] },
    lesson_gap: { kind: "lesson_gap", instructionPl: "Uzupełnij", stemWithGap: "He ___ (play)." },
    lesson_match: { kind: "lesson_match", instructionPl: "Połącz", left: [item(0, "a"), item(1, "b"), item(2, "c")], right: [item(3, "x"), item(4, "y"), item(5, "z")] },
    lesson_group: { kind: "lesson_group", instructionPl: "Pogrupuj", groups: [item(0, "g1"), item(1, "g2")], items: [item(2, "a"), item(3, "b"), item(4, "c"), item(5, "d")] },
    lesson_cloze: {
      kind: "lesson_cloze", instructionPl: "Uzupełnij tekst",
      segments: [{ text: "A " }, { gapId: ids[0]! }, { text: " b " }, { gapId: ids[1]! }],
      words: [item(2, "x"), item(3, "y"), item(4, "z")],
    },
  } as const;

  it.each(Object.entries(prompts))("%s przyjmuje contentLocale pl-PL i en-GB, a bez niego nadal się parsuje", (_kind, prompt) => {
    expect(TaskPromptSchema.safeParse(prompt).success).toBe(true);
    expect(TaskPromptSchema.safeParse({ ...prompt, contentLocale: "en-GB" }).success).toBe(true);
    expect(TaskPromptSchema.safeParse({ ...prompt, contentLocale: "pl-PL" }).success).toBe(true);
  });

  it.each(Object.entries(prompts))("%s odrzuca nieznany język treści", (_kind, prompt) => {
    expect(TaskPromptSchema.safeParse({ ...prompt, contentLocale: "de-DE" }).success).toBe(false);
  });

  it("odpowiedź otwarta przyjmuje answerLocale obok promptLocale, a nieznany język odrzuca", () => {
    const open = { kind: "lesson_open_answer", instructionPl: "Przetłumacz.", prompt: "Ona gra w piłkę." };
    expect(TaskPromptSchema.safeParse({ ...open, promptLocale: "pl-PL", answerLocale: "en-GB" }).success).toBe(true);
    expect(TaskPromptSchema.safeParse({ ...open, answerLocale: "pl-PL" }).success).toBe(true);
    expect(TaskPromptSchema.safeParse({ ...open, answerLocale: "de-DE" }).success).toBe(false);
  });
});
