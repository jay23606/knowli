import { describe, expect, it } from "vitest";
import type { AgentObjective, LessonExerciseDraft, RawPlanObjective } from "../../types";
import { chapterAgentPolicy } from "./agent-policy";
import { englishChapterSubject } from "./module";

const MATERIAL = ["Pokój:", "bed — łóżko", "lamp — lampa", "Zwroty:", "There's a … in the …", "I'm wearing a …"].join("\n");

function objective(overrides: Partial<AgentObjective> = {}): AgentObjective {
  return {
    id: "english_chapter.dx.room",
    titlePl: "Pokój",
    descriptionEn: "Room words.",
    kind: "words",
    cards: [{ title: "Słówka", body: "bed — łóżko\nlamp — lampa" }],
    exerciseTypes: [],
    ...overrides,
  };
}

const bedCard = objective({ cards: [{ title: "Słówka", body: "bed — łóżko" }] });
const frameObjective = objective({
  kind: "frame",
  cards: [{ title: "Rama", body: "There's a … in the …\nNa przykład: There's a cat in the garden." }],
});

function draft(overrides: Partial<LessonExerciseDraft>): LessonExerciseDraft {
  return { exerciseType: "lesson_gap", objectiveId: "english_chapter.dx.room", answer: "", acceptedAnswers: [], focus: [], ...overrides };
}

const gate = (d: LessonExerciseDraft, o: AgentObjective) => chapterAgentPolicy.exerciseGate!(d, o, { material: MATERIAL });
const codes = (d: LessonExerciseDraft, o: AgentObjective) => gate(d, o).map((finding) => finding.code);

describe("chapterAgentPolicy — wartości i typy", () => {
  it("jest polityką przedmiotu rozdziału", () => {
    expect(englishChapterSubject.agentPolicy).toBe(chapterAgentPolicy);
  });

  it("ma zapas samodzielnych 1 i luz 2, bez materiału dla checkera", () => {
    expect(chapterAgentPolicy.independentReserve).toBe(1);
    expect(chapterAgentPolicy.slack).toBe(2);
    expect(chapterAgentPolicy.checkerNeedsMaterial).toBe(false);
  });

  it("nie ma sędziego podpowiedzi ani kontroli otwartej (zachowanie jak w 2a)", () => {
    expect(chapterAgentPolicy.hintJudgeTypes).toBeUndefined();
    expect(chapterAgentPolicy.openAnswerCheckTypes).toBeUndefined();
    for (const key of ["hintUnsupported", "hintLanguage", "hintReveals", "openMissing", "openWrong"] as const) {
      expect(chapterAgentPolicy.rejectionTexts[key]).toBeUndefined();
    }
  });

  it("typy ślepe i wariantów należą do przedmiotu, bez keywords i listen_choice", () => {
    const subjectTypes = new Set<string>(englishChapterSubject.exerciseTypes);
    for (const type of [...chapterAgentPolicy.blindSolveTypes, ...chapterAgentPolicy.variantCheckTypes]) {
      expect(subjectTypes.has(type)).toBe(true);
    }
    expect(chapterAgentPolicy.blindSolveTypes).not.toContain("lesson_keywords");
    expect(chapterAgentPolicy.blindSolveTypes).not.toContain("lesson_listen_choice");
    expect(chapterAgentPolicy.blindSolveTypes).toContain("lesson_cloze");
    expect(chapterAgentPolicy.variantCheckTypes).toEqual(["lesson_open_answer", "lesson_gap"]);
  });

  it("typy ślepe to dokładnie zbiór PoC (gałąź nie-szkolna) przecięty z typami rozdziału", () => {
    expect(chapterAgentPolicy.blindSolveTypes).toEqual([
      "lesson_choice",
      "lesson_gap",
      "lesson_cloze",
      "lesson_open_answer",
      "lesson_order",
      "lesson_match",
      "lesson_group",
    ]);
    expect(chapterAgentPolicy.variantCheckTypes).toEqual(["lesson_open_answer", "lesson_gap"]);
  });

  it("leakSource ma ustaloną treść", () => {
    expect(chapterAgentPolicy.rejectionTexts.leakSource).toBe("Use a different sentence.");
  });

  it("leakVictim podpowiada zmianę pokoju, przedmiotu lub miejsca", () => {
    expect(chapterAgentPolicy.rejectionTexts.leakVictim).toContain("change the room, object or place");
  });
});

describe("requiredTypes", () => {
  it("words: dopasowanie, słuchanie, luka albo grupa", () => {
    expect(chapterAgentPolicy.requiredTypes!(objective())).toEqual([["lesson_match"], ["lesson_listen_choice"], ["lesson_cloze", "lesson_group"]]);
  });

  it("frame: układanka, słuchanie, luka", () => {
    expect(chapterAgentPolicy.requiredTypes!(frameObjective)).toEqual([["lesson_order"], ["lesson_listen_choice"], ["lesson_cloze"]]);
  });

  it("zagadnienie bez rodzaju nie ma wymagań", () => {
    expect(chapterAgentPolicy.requiredTypes!(objective({ kind: undefined }))).toEqual([]);
  });
});

describe("exerciseGate — słowa kart", () => {
  it("luka ze słowem kart przechodzi, z obcym słowem dostaje card_word_missing", () => {
    expect(gate(draft({ stem: "I sleep in a ___.", answer: "bed" }), bedCard)).toEqual([]);
    const findings = gate(draft({ stem: "I turn on the ___.", answer: "lamp" }), bedCard);
    expect(findings.map((finding) => finding.code)).toEqual(["card_word_missing"]);
    expect(findings[0]!.reason).toContain("bed");
  });

  it("para dwóch słów kart przechodzi, z jednym dostaje card_word_missing", () => {
    const two = draft({
      exerciseType: "lesson_match",
      answer: "bed",
      pairs: [
        { left: "bed", right: "łóżko" },
        { left: "lamp", right: "lampa" },
      ],
    });
    expect(codes(two, objective())).toEqual([]);
    const one = draft({
      exerciseType: "lesson_match",
      answer: "bed",
      pairs: [
        { left: "bed", right: "łóżko" },
        { left: "door", right: "drzwi" },
      ],
    });
    expect(codes(one, objective())).toEqual(["card_word_missing"]);
  });

  it("luki tekstu z lukami i elementy grup liczą się jak w PoC", () => {
    expect(codes(draft({ exerciseType: "lesson_cloze", clozeText: "A ___ and a ___.", gapAnswers: ["bed", "chair"] }), bedCard)).toEqual([]);
    expect(codes(draft({ exerciseType: "lesson_cloze", clozeText: "A ___.", gapAnswers: ["chair"] }), bedCard)).toEqual(["card_word_missing"]);
    const group = draft({
      exerciseType: "lesson_group",
      groupItems: [
        { text: "bed", groupId: "a" },
        { text: "lamp", groupId: "a" },
      ],
    });
    expect(codes(group, objective())).toEqual([]);
  });

  it("wybór sprawdza tekst poprawnej opcji", () => {
    const choice = draft({
      exerciseType: "lesson_choice",
      stem: "I sleep in a ___.",
      options: [
        { id: "a", text: "bed" },
        { id: "b", text: "door" },
      ],
      correctOption: "a",
      answer: "bed",
    });
    expect(codes(choice, bedCard)).toEqual([]);
    expect(codes({ ...choice, correctOption: "b" }, bedCard)).toEqual(["card_word_missing"]);
  });

  it("karty bez słów z materiału nie ograniczają ćwiczenia", () => {
    const none = objective({ cards: [{ title: "Słówka", body: "Coś innego" }] });
    expect(gate(draft({ answer: "chair", stem: "A ___." }), none)).toEqual([]);
  });
});

describe("exerciseGate — rama zagadnienia", () => {
  it("układanka ze stałą częścią ramy zagadnienia przechodzi", () => {
    const order = draft({
      exerciseType: "lesson_order",
      answer: "There's a bed in the room",
      items: ["There's", "a", "bed", "in", "the", "room"].map((text, index) => ({ id: String(index), text })),
    });
    expect(gate(order, frameObjective)).toEqual([]);
  });

  it("układanka z ramą innego zagadnienia dostaje frame_missing", () => {
    const order = draft({ exerciseType: "lesson_order", answer: "I'm wearing a red coat" });
    const findings = gate(order, frameObjective);
    expect(findings.map((finding) => finding.code)).toEqual(["frame_missing"]);
    expect(findings[0]!.reason).toContain("there's a");
  });

  it("luka: zdanie po wstawieniu odpowiedzi musi zawierać ramę", () => {
    expect(codes(draft({ stem: "There's a ___ in the garden.", answer: "cat" }), frameObjective)).toEqual([]);
    expect(codes(draft({ stem: "I have a ___ in the garden.", answer: "cat" }), frameObjective)).toEqual(["frame_missing"]);
    expect(
      codes(draft({ exerciseType: "lesson_cloze", clozeText: "There's a ___ in the ___.", gapAnswers: ["cat", "garden"] }), frameObjective),
    ).toEqual([]);
  });

  it("pomija listen_choice, dopasowania i grupy", () => {
    const listen = draft({
      exerciseType: "lesson_listen_choice",
      stem: "I have a ___.",
      options: [{ id: "a", text: "cat" }],
      correctOption: "a",
      answer: "cat",
    });
    expect(gate(listen, frameObjective)).toEqual([]);
    expect(gate(draft({ exerciseType: "lesson_match", pairs: [{ left: "cat", right: "kot" }] }), frameObjective)).toEqual([]);
    expect(gate(draft({ exerciseType: "lesson_group", groupItems: [{ text: "cat", groupId: "a" }] }), frameObjective)).toEqual([]);
  });

  it("zagadnienie bez ramy z materiału na swoich kartach nie dostaje bramki", () => {
    const plain = objective({ kind: "frame", cards: [{ title: "Rama", body: "Coś zupełnie innego" }] });
    expect(gate(draft({ stem: "A ___.", answer: "cat" }), plain)).toEqual([]);
  });
});

describe("exerciseGate — przypadki brzegowe", () => {
  it("zagadnienie z jednym słowem kart: para z tym słowem przechodzi, bez niego dostaje card_word_missing", () => {
    const pair = (left: string) => draft({ exerciseType: "lesson_match", pairs: [{ left, right: "x" }] });
    expect(codes(pair("bed"), bedCard)).toEqual([]);
    expect(codes(pair("door"), bedCard)).toEqual(["card_word_missing"]);
    const group = (text: string) => draft({ exerciseType: "lesson_group", groupItems: [{ text, groupId: "a" }] });
    expect(codes(group("bed"), bedCard)).toEqual([]);
    expect(codes(group("door"), bedCard)).toEqual(["card_word_missing"]);
  });

  it("lesson_card jest pomijany przez obie bramki", () => {
    const card = draft({ exerciseType: "lesson_card", answer: "" });
    expect(gate(card, bedCard)).toEqual([]);
    expect(gate(card, frameObjective)).toEqual([]);
  });

  it("zagadnienie bez rodzaju nie ma bramki", () => {
    expect(gate(draft({ stem: "A ___.", answer: "chair" }), objective({ kind: undefined }))).toEqual([]);
  });

  it("lesson_listen_choice w bramce słów sprawdza tekst poprawnej opcji", () => {
    const listen = draft({
      exerciseType: "lesson_listen_choice",
      stem: "I sleep in a ___.",
      options: [
        { id: "a", text: "bed" },
        { id: "b", text: "door" },
      ],
      correctOption: "a",
      answer: "door",
    });
    expect(codes(listen, bedCard)).toEqual([]);
    expect(codes({ ...listen, correctOption: "b", answer: "bed" }, bedCard)).toEqual(["card_word_missing"]);
  });
});

describe("objectiveGaps", () => {
  it("wskazuje słowa kart nieużyte jeszcze w żadnym ćwiczeniu", () => {
    const pool = [draft({ stem: "I sleep in a ___.", answer: "bed" })];
    expect(chapterAgentPolicy.objectiveGaps!(pool, objective(), { material: MATERIAL })).toEqual([
      "card words not used in any exercise yet: lamp",
    ]);
  });

  it("zwraca pustą listę, gdy wszystkie słowa są użyte, i dla ramy", () => {
    const pool = [draft({ stem: "I sleep in a ___.", answer: "bed" }), draft({ stem: "A ___ is on.", answer: "lamp" })];
    expect(chapterAgentPolicy.objectiveGaps!(pool, objective(), { material: MATERIAL })).toEqual([]);
    expect(chapterAgentPolicy.objectiveGaps!([], frameObjective, { material: MATERIAL })).toEqual([]);
  });
});

describe("planCoverage i planGate", () => {
  function plan(bodies: string[]): RawPlanObjective[] {
    return bodies.map((body, index) => ({
      slug: `o${index}`,
      titlePl: "T",
      descriptionEn: "D",
      kind: "words" as const,
      cards: [{ title: "K", body }],
      examples: [],
    }));
  }

  it("planCoverage podaje słowa i ramy materiału", () => {
    expect(chapterAgentPolicy.planCoverage!(MATERIAL)).toEqual({
      words: ["bed", "lamp"],
      frames: ["There's a … in the …", "I'm wearing a …"],
    });
  });

  it("planGate wskazuje niepokryte słowa i ramy", () => {
    const errors = chapterAgentPolicy.planGate!(plan(["bed — łóżko", "There's a … in the …"]), MATERIAL);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("lamp");
    expect(errors[1]).toContain("I'm wearing a …");
  });

  it("planGate pokrytego planu zwraca pustą listę", () => {
    expect(chapterAgentPolicy.planGate!(plan(["bed — łóżko\nlamp — lampa", "There's a … in the …\nI'm wearing a red coat."]), MATERIAL)).toEqual([]);
  });

  it("materiał bez list nie wymaga pokrycia", () => {
    expect(chapterAgentPolicy.planGate!(plan(["cokolwiek"]), "Tekst bez list.")).toEqual([]);
    expect(chapterAgentPolicy.planCoverage!("Tekst bez list.")).toEqual({ words: [], frames: [] });
  });
});
