import { describe, expect, it } from "vitest";
import { messages, TaskPromptSchema } from "@learning/contracts";
import { englishGrammarSubject } from "../../../domain/lessons/subjects/english-grammar/module";
import { englishChapterSubject } from "../../../domain/lessons/subjects/english-chapter/module";
import { schoolSubject } from "../../../domain/lessons/subjects/school/module";
import { evaluateChoice, type LessonAnswerKey } from "../../../domain/lessons/evaluate";
import { lessonExerciseTargetKey, lessonTextTargetKey } from "../../../domain/lessons/exposure-key";
import { computeTargetKey } from "../../../domain/target-key";
import { materializeCard, materializeExercise, seededShuffle, shuffleUnsolved, type LoadedExercise } from "./lesson-materialize";
import { listenStimulusAssetId } from "./listen-stimulus";

/**
 * P1-1: `correctOption` kontraktu (pool-validation) niesie ID OPCJI dla
 * choice/short_answer i TEKST słowa (zrównany normalizatorem) dla notice.
 * Materializacja musi wyznaczyć `answerKey.correctOptionId` zgodnie z tym
 * kontraktem — inaczej każda odpowiedź dziecka jest oceniana jako błędna.
 * Silnik pozostaje niezależny od przedmiotu: normalizator pochodzi z `SubjectModule`.
 */

const subject = englishGrammarSubject;
const topic = subject.topics[0]!;

function loaded(payload: LoadedExercise["payload"]): LoadedExercise {
  return {
    revisionId: "rev-1",
    itemId: "item-1",
    position: 0,
    payload,
    targetKey: "tk-1",
    audioAssetId: null,
  };
}

/** Klucz odpowiedzi z materializacji zrzutowany na typ oceny. */
function answerKeyOf(task: ReturnType<typeof materializeExercise>): LessonAnswerKey {
  return task.answerKey as unknown as LessonAnswerKey;
}

describe("materializeExercise — correctOption po ID (P1-1)", () => {
  function choiceTask(seed: string, payload: Partial<LoadedExercise["payload"]>, forTopic = topic) {
    return materializeExercise(
      { independentCheck: false, reason: "practice" },
      seed,
      loaded({
        exerciseType: "lesson_choice",
        objectiveId: "english_grammar.present_simple.third_person_s",
        instructionPl: "Wybierz poprawną formę.",
        stem: "She ___ football.",
        options: [
          { id: "a", text: "plays" },
          { id: "b", text: "play" },
        ],
        correctOption: "a",
        answer: "plays",
        acceptedAnswers: [],
        focus: ["plays"],
        answerLocale: subject.answerLocale,
        promptLocale: subject.promptLocale,
        ...payload,
      }),
      forTopic,
      subject,
    );
  }

  it("lesson_choice: correctOptionId wskazuje opcję o tekście poprawnej, a wybór tej opcji jest oceniony correct", () => {
    const task = choiceTask("seed-choice", {});
    const key = answerKeyOf(task);
    const options = task.prompt.kind === "lesson_choice" ? task.prompt.options : [];
    const correctRendered = options.find((o) => o.id === key.correctOptionId);

    expect(key.correctOptionId).toBeDefined();
    expect(correctRendered?.text).toBe("plays"); // opcja o ID "a"
    expect(evaluateChoice(key.correctOptionId!, key)).toBe(true);
  });

  it("lesson_choice: visualSubject przechodzi z payloadu do promptu dziecka", () => {
    const task = choiceTask("seed-visual", {
      objectiveId: "english_grammar.to_be.affirmative_forms",
      instructionPl: "Kto to jest? Wybierz.",
      stem: "___ is happy.",
      visualSubject: "girl",
      options: [
        { id: "a", text: "She" },
        { id: "b", text: "He" },
      ],
      answer: "She",
      focus: ["She"],
    }, subject.topics.find((t) => t.id === "to_be")!);
    expect(task.prompt.kind).toBe("lesson_choice");
    expect(task.prompt.kind === "lesson_choice" ? task.prompt.visualSubject : undefined).toBe("girl");
  });

  it("grammar open answer does not send a prompt locale (language of the prompt is ambiguous)", () => {
    const objective = topic.objectives.find((o) => o.exerciseTypes.includes("lesson_open_answer"))!;
    const task = materializeExercise({ independentCheck: true, reason: "due_check" }, "grammar-open", loaded({
      exerciseType: "lesson_open_answer", objectiveId: objective.id, instructionPl: "Napisz.", prompt: "Write about your day.",
      answer: "I play football.", acceptedAnswers: [], focus: ["play"], answerLocale: "en-GB", promptLocale: "pl-PL",
    }), topic, subject);
    expect(task.prompt).not.toHaveProperty("promptLocale");
  });

  it("translation prompt is the Polish source and keeps answers private", () => {
    const task = materializeExercise(
      { independentCheck: false, reason: "practice" },
      "seed-translation",
      loaded({
        exerciseType: "lesson_open_answer",
        objectiveId: "english_grammar.present_simple.third_person_s",
        instructionPl: "Przetłumacz na angielski.",
        prompt: "Ona codziennie gra w piłkę.",
        answer: "She plays football every day.",
        acceptedAnswers: ["She plays football daily."],
        focus: ["plays"],
        answerLocale: "en-GB",
        promptLocale: "pl-PL",
      }),
      topic,
      subject,
    );
    expect(task.prompt).toMatchObject({ kind: "lesson_open_answer", prompt: "Ona codziennie gra w piłkę." });
    expect(JSON.stringify(task.prompt)).not.toContain("She plays football");
    expect(task.answerKey).toMatchObject({ answer: "She plays football every day." });
  });

  it("lesson_short_answer: correctOptionId wskazuje opcję o tekście poprawnej odpowiedzi", () => {
    const task = materializeExercise(
      { independentCheck: false, reason: "practice" },
      "seed-short",
      loaded({
        exerciseType: "lesson_short_answer",
        objectiveId: "english_grammar.present_simple.short_answers",
        prompt: "Czy ona gra?",
        options: [
          { id: "x", text: "Yes, she does" },
          { id: "y", text: "Yes, she do" },
        ],
        correctOption: "x",
        answer: "Yes, she does",
        acceptedAnswers: [],
        focus: ["does"],
        answerLocale: subject.answerLocale,
        promptLocale: subject.promptLocale,
      }),
      topic,
      subject,
    );

    const key = answerKeyOf(task);
    const options = task.prompt.kind === "lesson_short_answer" ? task.prompt.options : [];
    const correctRendered = options.find((o) => o.id === key.correctOptionId);

    expect(key.correctOptionId).toBeDefined();
    expect(correctRendered?.text).toBe("Yes, she does");
    expect(evaluateChoice(key.correctOptionId!, key)).toBe(true);
  });

  it("lesson_notice: correctOption=TEKST trafia w segment także w innym wariancie wielkości liter (normalizator przedmiotu)", () => {
    const task = materializeExercise(
      { independentCheck: false, reason: "practice" },
      "seed-notice",
      loaded({
        exerciseType: "lesson_notice",
        objectiveId: "english_grammar.present_simple.third_person_s",
        instructionPl: "Dotknij słowa z końcówką -s.",
        noticeSegments: [["She", "plays", "football."], ["They", "play", "too."]],
        correctOption: "Plays", // inna wielkość liter niż segment "plays" — zrównane normalizatorem
        answer: "plays",
        acceptedAnswers: [],
        focus: ["plays"],
        answerLocale: subject.answerLocale,
        promptLocale: subject.promptLocale,
      }),
      topic,
      subject,
    );

    const key = answerKeyOf(task);
    const segments = task.prompt.kind === "lesson_notice" ? task.prompt.segments.flat() : [];
    const correct = segments.find((s) => s.id === key.correctOptionId);

    expect(key.correctOptionId).toBeDefined();
    expect(correct?.text).toBe("plays");
  });
});

describe("materializeExercise — przedmiot szkolny (temat dynamiczny)", () => {
  it("dokłada migawkę celu do answer_key i nie ujawnia kryteriów v3 w prompcie dziecka", () => {
    const schoolTopic = schoolSubject.buildDynamicTopic!({
      titlePl: "Posługuję się mapą",
      objectives: [{
        id: "school.ddeck.skala",
        titlePl: "Skala mapy",
        descriptionEn: "Map scale basics.",
        cards: [{ title: "Skala", body: "Skala mówi, ile razy mapa jest pomniejszona." }, { title: "Zastosowanie", body: "Ze skali liczysz odległości w terenie." }],
      }],
    });
    const task = materializeExercise(
      { independentCheck: true, reason: "independent_check" },
      "seed-school",
      loaded({
        exerciseType: "lesson_open_answer",
        objectiveId: "school.ddeck.skala",
        instructionPl: "Odpowiedz własnymi słowami.",
        prompt: "Co to jest skala mapy?",
        answer: "Skala informuje, ile razy mapa została pomniejszona.",
        acceptedAnswers: [],
        focus: ["pomniejszona"],
        answerLocale: "pl-PL",
        promptLocale: "pl-PL",
        questionType: "definition",
        requiredElements: [{ id: "e1", text: "informuje o pomniejszeniu" }],
        commonErrors: ["Skala to wielkość mapy w centymetrach."],
        expectedForm: "one_sentence",
        sourceRefs: [{ quote: "Skala informuje, ile razy obraz został pomniejszony." }],
      }),
      schoolTopic,
      schoolSubject,
    );
    const snapshot = (task.answerKey as { objectiveSnapshot?: { objectiveTitlePl?: string; topicId?: string } }).objectiveSnapshot;
    expect(snapshot?.objectiveTitlePl).toBe("Skala mapy");
    expect(snapshot?.topicId).toBe("dynamic");
    // Typowe błędy zatwierdzone przez rodzica muszą dojść do gradera (prywatny klucz zadania).
    expect((task.answerKey as { schoolCriteria?: { commonErrors?: string[] } }).schoolCriteria?.commonErrors)
      .toEqual(["Skala to wielkość mapy w centymetrach."]);
    const promptJson = JSON.stringify(task.prompt);
    // Szkoła ma jeden język, więc pytanie dostaje jawny locale dla czytników ekranu.
    expect(task.prompt).toMatchObject({ kind: "lesson_open_answer", promptLocale: "pl-PL" });
    expect(promptJson).not.toContain("Skala to wielkość mapy");
    expect(promptJson).not.toContain("informuje o pomniejszeniu");
    expect(promptJson).not.toContain("sourceRefs");
    expect(promptJson).not.toContain("requiredElements");
  });
});

it("materializes calculation from the closed template and keeps grading data private", () => {
  const calculation = { kind: "scale_distance", params: { scaleDenominator: 25000, mapDistanceCm: 3 }, unit: "m", tolerance: 1, templateFamilyId: "scale" };
  const payload = { exerciseType: "lesson_calculation", objectiveId: "school.scale", instructionPl: "Oblicz.", prompt: "unsafe free text", answer: "750 m", acceptedAnswers: [], focus: [], calculation,
    requiredElements: [{ id: "e1", text: "private element" }], sourceRefs: [{ quote: "private quote" }], answerLocale: "pl-PL", promptLocale: "pl-PL" } as unknown as LoadedExercise["payload"];
  const result = materializeExercise({ independentCheck: true, reason: "due_check" }, "calculation", loaded(payload), topic, schoolSubject);
  expect(result.prompt).toEqual({ kind: "lesson_calculation", instructionPl: "Oblicz.", prompt: "Na mapie w skali 1:25 000 odcinek ma 3 cm. Oblicz odległość w terenie w m." });
  expect(result.answerKey.calculation).toEqual(calculation);
  expect(result.exposures).toEqual([]);
  for (const forbidden of ['"answer"', '"calculation"', '"tolerance"', "sourceRefs", "requiredElements", "comment", "private", "750 m"]) expect(JSON.stringify(result.prompt)).not.toContain(forbidden);
});

it("gives a calculation without its own instruction the shared calculation instruction, not the objective title", () => {
  const calculation = { kind: "unit_conversion", params: { value: 0.75, fromUnit: "km" }, unit: "m", templateFamilyId: "units" };
  const payload = { exerciseType: "lesson_calculation", objectiveId: "school.scale", answer: "750 m", acceptedAnswers: [], focus: [], calculation,
    sourceRefs: [{ quote: "private quote" }], answerLocale: "pl-PL", promptLocale: "pl-PL" } as unknown as LoadedExercise["payload"];
  const result = materializeExercise({ independentCheck: true, reason: "due_check" }, "calculation-default", loaded(payload), topic, schoolSubject);
  expect(result.prompt).toEqual({ kind: "lesson_calculation", instructionPl: messages.kid.lessonCalculationInstruction, prompt: "Przelicz 0,75 km na m." });
});

it("rejects an invalid private calculation before issuing any public prompt", () => {
  const exercise = loaded({ exerciseType: "lesson_calculation", objectiveId: "school.scale", instructionPl: "Oblicz.", answer: "750 m", acceptedAnswers: [], focus: [], calculation: { kind: "unknown" }, answerLocale: "pl-PL", promptLocale: "pl-PL" } as unknown as LoadedExercise["payload"]);
  expect(() => materializeExercise({ independentCheck: true, reason: "due_check" }, "invalid", exercise, topic, schoolSubject)).toThrow();
});

describe("tasowanie bez rozwiązanego układu (design szkoły §10.4)", () => {
  const canonical = ["a", "b", "c"];
  const inOrder = (arranged: readonly string[]) => arranged.every((value, i) => value === canonical[i]);

  it("ziarno, przy którym zwykłe tasowanie zwraca układ kanoniczny, daje przesunięty układ", () => {
    const seed = Array.from({ length: 200 }, (_, i) => `task-${i}`).find((candidate) => inOrder(seededShuffle(canonical, candidate)));
    expect(seed).toBeDefined();
    const arranged = shuffleUnsolved(canonical, seed!, inOrder);
    expect(arranged).toEqual(["b", "c", "a"]);
  });

  it("nigdy nie zwraca układu rozwiązanego i zachowuje elementy", () => {
    for (let i = 0; i < 200; i++) {
      const arranged = shuffleUnsolved(canonical, `seed-${i}`, inOrder);
      expect(inOrder(arranged)).toBe(false);
      expect([...arranged].sort()).toEqual(canonical);
    }
  });

  it("lesson_order: bloki zadania nie stoją w kolejności odpowiedzi", () => {
    for (let i = 0; i < 60; i++) {
      const task = materializeExercise(
        { independentCheck: false, reason: "practice" },
        `order-${i}`,
        loaded({
          exerciseType: "lesson_order",
          objectiveId: "english_grammar.present_simple.third_person_s",
          instructionPl: "Ułóż zdanie.",
          items: [{ id: "1", text: "She" }, { id: "2", text: "plays" }, { id: "3", text: "football" }],
          focus: [],
          answer: "She plays football",
          acceptedAnswers: [],
          answerLocale: subject.answerLocale,
          promptLocale: subject.promptLocale,
        }),
        topic,
        subject,
      );
      const prompt = task.prompt as { items: { id: string }[] };
      expect(prompt.items.map((item) => item.id)).not.toEqual(answerKeyOf(task).itemIds);
    }
  });
});

describe("materializeExercise — pary i grupy (design szkoły §10)", () => {
  const schoolTopic = schoolSubject.buildDynamicTopic!({
    titlePl: "Fotosynteza",
    objectives: [{
      id: "school.ddeck.fotosynteza",
      titlePl: "Fotosynteza",
      descriptionEn: "Photosynthesis.",
      cards: [{ title: "Fotosynteza", body: "Roślina wytwarza cukry." }, { title: "Produkty", body: "Powstaje tlen." }],
    }],
  });
  const base = {
    objectiveId: "school.ddeck.fotosynteza",
    instructionPl: "Ćwiczenie.",
    acceptedAnswers: [],
    focus: [],
    answerLocale: "pl-PL",
    promptLocale: "pl-PL",
  };
  const match = (seed: string) => materializeExercise(
    { independentCheck: false, reason: "practice" },
    seed,
    loaded({
      ...base,
      exerciseType: "lesson_match",
      pairs: [{ left: "światło", right: "energia" }, { left: "woda", right: "korzenie" }, { left: "cukry", right: "liście" }],
      extraRight: ["skrzela"],
      answer: "światło, woda, cukry",
    }),
    schoolTopic,
    schoolSubject,
  );
  const group = (seed: string) => materializeExercise(
    { independentCheck: false, reason: "practice" },
    seed,
    loaded({
      ...base,
      exerciseType: "lesson_group",
      groups: [{ id: "in", label: "substraty" }, { id: "out", label: "produkty" }],
      groupItems: [{ text: "woda", groupId: "in" }, { text: "CO2", groupId: "in" }, { text: "cukry", groupId: "out" }, { text: "tlen", groupId: "out" }],
      answer: "substraty / produkty",
    }),
    schoolTopic,
    schoolSubject,
  );

  it("lesson_match: prompt bez klucza, prawa kolumna z dystraktorem i nigdy w całości naprzeciw par", () => {
    for (let i = 0; i < 60; i++) {
      const task = match(`match-${i}`);
      const prompt = task.prompt as { kind: string; left: { id: string; text: string }[]; right: { id: string; text: string }[] };
      expect(prompt.kind).toBe("lesson_match");
      expect(Object.keys(prompt).sort()).toEqual(["contentLocale", "instructionPl", "kind", "left", "right"]);
      expect(prompt.right.map((item) => item.text).sort()).toEqual(["energia", "korzenie", "liście", "skrzela"]);
      const key = answerKeyOf(task);
      const partner = new Map(key.assignments!.map((entry) => [entry.itemId, entry.targetId]));
      expect(prompt.left.every((item, index) => prompt.right[index]?.id === partner.get(item.id))).toBe(false);
      expect(key.targetOnce).toBe(true);
      expect(key.targetIds).toHaveLength(4);
      expect(task.exposures).toEqual(["tk-1"]);
    }
  });

  it("kolejności nie da się wyliczyć z publicznego taskId: domyślnie ziarno ma losowy składnik", () => {
    const orders = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const prompt = match("ten-sam-task").prompt as { left: { text: string }[]; right: { text: string }[] };
      orders.add(JSON.stringify([prompt.left.map((item) => item.text), prompt.right.map((item) => item.text)]));
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it("lesson_group: elementy nie startują ułożone grupami, a klucz przypisuje je do UUID grup", () => {
    for (let i = 0; i < 60; i++) {
      const task = group(`group-${i}`);
      const prompt = task.prompt as { groups: { id: string; text: string }[]; items: { id: string; text: string }[] };
      expect(prompt.groups.map((g) => g.text)).toEqual(["substraty", "produkty"]);
      const key = answerKeyOf(task);
      const groupOf = new Map(key.assignments!.map((entry) => [entry.itemId, entry.targetId]));
      const ranks = prompt.items.map((item) => prompt.groups.findIndex((g) => g.id === groupOf.get(item.id)));
      expect(ranks.every((rank, index) => index === 0 || ranks[index - 1]! <= rank)).toBe(false);
      expect(JSON.stringify(task.prompt)).not.toContain("groupId");
    }
  });
});

describe("materializeExercise — luki z bankiem (design szkoły §13)", () => {
  const schoolTopic = schoolSubject.buildDynamicTopic!({
    titlePl: "Fotosynteza",
    objectives: [{
      id: "school.ddeck.fotosynteza",
      titlePl: "Fotosynteza",
      descriptionEn: "Photosynthesis.",
      cards: [{ title: "Fotosynteza", body: "Roślina wytwarza cukry." }, { title: "Produkty", body: "Powstaje tlen." }],
    }],
  });
  const cloze = (seed: string, overrides: Record<string, unknown> = {}) => materializeExercise(
    { independentCheck: false, reason: "practice" },
    seed,
    loaded({
      objectiveId: "school.ddeck.fotosynteza",
      acceptedAnswers: [],
      focus: [],
      answerLocale: "pl-PL",
      promptLocale: "pl-PL",
      exerciseType: "lesson_cloze",
      clozeText: "___ pobiera z powietrza roślina, a korzeniami ___ i sole.",
      gapAnswers: ["dwutlenek węgla", "wodę"],
      extraWords: ["tlen", "cukry"],
      answer: "dwutlenek węgla, wodę",
      ...overrides,
    }),
    schoolTopic,
    schoolSubject,
  );

  it("prompt bez klucza: tekst pocięty na luki z UUID, bank z dystraktorami", () => {
    const task = cloze("cloze-1");
    const prompt = task.prompt as { kind: string; instructionPl: string; segments: ({ text: string } | { gapId: string })[]; words: { id: string; text: string }[] };
    expect(prompt.kind).toBe("lesson_cloze");
    expect(Object.keys(prompt).sort()).toEqual(["contentLocale", "instructionPl", "kind", "segments", "words"]);
    expect(prompt.instructionPl).toBe(messages.kid.lessonClozeInstruction);
    const gapIds = prompt.segments.flatMap((segment) => ("gapId" in segment ? [segment.gapId] : []));
    expect(gapIds).toHaveLength(2);
    expect(prompt.segments[0]).toEqual({ gapId: gapIds[0] });
    expect(prompt.segments.flatMap((segment) => ("text" in segment ? [segment.text] : []))).toEqual([" pobiera z powietrza roślina, a korzeniami ", " i sole."]);
    expect(prompt.words.map((word) => word.text).sort()).toEqual(["cukry", "dwutlenek węgla", "tlen", "wodę"]);
    expect(TaskPromptSchema.safeParse(task.prompt).success).toBe(true);
    const key = answerKeyOf(task) as ReturnType<typeof answerKeyOf> & { filledText?: string };
    expect(key.assignments!.map((entry) => entry.itemId)).toEqual(gapIds);
    expect(key.targetOnce).toBe(true);
    expect(key.filledText).toBe("dwutlenek węgla pobiera z powietrza roślina, a korzeniami wodę i sole.");
    expect(JSON.stringify(task.prompt)).not.toContain("filledText");
    expect(task.exposures).toEqual(["tk-1"]);
  });

  it("bank nie zaczyna się słowami luk w kolejności luk, ale kolejność banku nie zdradza przypisania", () => {
    let inGapOrder = 0;
    for (let i = 0; i < 200; i++) {
      const task = cloze(`cloze-order-${i}`);
      const prompt = task.prompt as { words: { id: string }[] };
      const key = answerKeyOf(task);
      const answerIds = key.assignments!.map((entry) => entry.targetId);
      expect(prompt.words.slice(0, 2).map((word) => word.id)).not.toEqual(answerIds);
      const positions = prompt.words.map((word) => answerIds.indexOf(word.id)).filter((position) => position >= 0);
      if (positions[0] === 0) inGapOrder += 1;
    }
    // Przy 2 lukach słowo luki 1 stoi w banku przed słowem luki 2 mniej więcej co drugi raz, nie nigdy.
    expect(inGapOrder).toBeGreaterThan(40);
    expect(inGapOrder).toBeLessThan(160);
  });

  it("niespójny payload (liczba luk ≠ liczba słów) to błąd serwera, nie zadanie bez klucza", () => {
    expect(() => cloze("cloze-broken", { gapAnswers: ["dwutlenek węgla"] })).toThrow(/invalid private cloze payload/);
  });
});

describe("materializeExercise — nagranie „Posłuchaj pytania” (design szkoły §11.3)", () => {
  const schoolTopic = schoolSubject.buildDynamicTopic!({
    titlePl: "Pająki",
    objectives: [{
      id: "school.ddeck.pajaki",
      titlePl: "Pająki",
      descriptionEn: "Spiders.",
      cards: [{ title: "Pająki", body: "Pająk ma osiem nóg." }, { title: "Owady", body: "Owad ma sześć nóg." }],
    }],
  });
  const choicePayload = {
    exerciseType: "lesson_choice",
    objectiveId: "school.ddeck.pajaki",
    instructionPl: "Wybierz odpowiedź.",
    stem: "Ile nóg ma pająk?",
    options: [{ id: "a", text: "osiem" }, { id: "b", text: "sześć" }],
    correctOption: "a",
    answer: "osiem",
    acceptedAnswers: [],
    focus: [],
    answerLocale: "pl-PL",
    promptLocale: "pl-PL",
  } as LoadedExercise["payload"];
  const audioId = "11111111-1111-4111-8111-111111111111";
  const withAudio = (payload: LoadedExercise["payload"]): LoadedExercise => ({ ...loaded(payload), questionAudioAssetId: audioId });

  it("dołącza gotowe nagranie w treningu i w kartkówce", () => {
    const training = materializeExercise({ independentCheck: false, reason: "practice" }, "q1", withAudio(choicePayload), schoolTopic, schoolSubject);
    const mock = materializeExercise({ independentCheck: true, reason: "due_check" }, "q2", withAudio(choicePayload), schoolTopic, schoolSubject, { mockTest: true });
    expect(training.prompt).toMatchObject({ kind: "lesson_choice", questionAudioAssetId: audioId });
    expect(mock.prompt).toMatchObject({ kind: "lesson_choice", questionAudioAssetId: audioId });
  });

  it("bez gotowego nagrania pole nie istnieje", () => {
    const task = materializeExercise({ independentCheck: false, reason: "practice" }, "q3", loaded(choicePayload), schoolTopic, schoolSubject);
    expect(task.prompt).not.toHaveProperty("questionAudioAssetId");
  });

  it("przedmiot bez `ttsForPrompts` nie dołącza nagrania", () => {
    const task = materializeExercise({ independentCheck: false, reason: "practice" }, "q4", withAudio(choicePayload), schoolTopic, { ...schoolSubject, ttsForPrompts: false });
    expect(task.prompt).not.toHaveProperty("questionAudioAssetId");
  });
});

describe("materializeExercise — nagranie zdania feedbacku w prywatnym kluczu", () => {
  const feedbackId = "22222222-2222-4222-8222-222222222222";
  const payload = {
    exerciseType: "lesson_choice",
    objectiveId: "english_grammar.present_simple.third_person_s",
    instructionPl: "Wybierz poprawną formę.",
    stem: "She ___ football.",
    options: [{ id: "a", text: "plays" }, { id: "b", text: "play" }],
    correctOption: "a",
    answer: "plays",
    acceptedAnswers: [],
    focus: ["plays"],
    answerLocale: subject.answerLocale,
    promptLocale: subject.promptLocale,
  } as LoadedExercise["payload"];
  const exercise: LoadedExercise = { ...loaded(payload), feedbackAudioAssetId: feedbackId };

  it("trening z flagą przedmiotu niesie id w kluczu, ale nie w promptcie dziecka", () => {
    const task = materializeExercise({ independentCheck: false, reason: "practice" }, "f1", exercise, topic, subject);
    expect(task.answerKey.feedbackAudioAssetId).toBe(feedbackId);
    expect(JSON.stringify(task.prompt)).not.toContain(feedbackId);
  });

  it("kartkówka nie niesie id w kluczu", () => {
    const task = materializeExercise({ independentCheck: true, reason: "due_check" }, "f2", exercise, topic, subject, { mockTest: true });
    expect(task.answerKey).not.toHaveProperty("feedbackAudioAssetId");
  });

  it("przedmiot bez flagi nie niesie id w kluczu", () => {
    const task = materializeExercise({ independentCheck: false, reason: "practice" }, "f3", exercise, topic, { ...subject, ttsForFeedbackSentence: false });
    expect(task.answerKey).not.toHaveProperty("feedbackAudioAssetId");
  });
});

describe("„Posłuchaj i wybierz” (lesson_listen_choice) — bodziec i materializacja", () => {
  const sentenceId = "33333333-3333-4333-8333-333333333333";
  const payload = {
    exerciseType: "lesson_listen_choice",
    objectiveId: "english_grammar.present_simple.third_person_s",
    stem: "She ___ football.",
    options: [{ id: "a", text: "plays" }, { id: "b", text: "play" }],
    correctOption: "a",
    answer: "plays",
    acceptedAnswers: [],
    focus: ["plays"],
    answerLocale: subject.answerLocale,
    promptLocale: subject.promptLocale,
  } as LoadedExercise["payload"];
  const exercise: LoadedExercise = { ...loaded(payload), feedbackAudioAssetId: sentenceId };
  const listenTask = (input: LoadedExercise = exercise, moduleOfSubject = subject, options: { mockTest?: boolean } = {}) =>
    materializeExercise({ independentCheck: false, reason: "listen_practice" }, "listen-1", input, topic, moduleOfSubject, options);

  it("listenStimulusAssetId: gotowe nagranie tylko w treningu przedmiotu z nagraniem zdań", () => {
    expect(listenStimulusAssetId(exercise, subject, "training")).toBe(sentenceId);
    expect(listenStimulusAssetId(exercise, subject, "mock_test")).toBeNull();
    expect(listenStimulusAssetId(exercise, { ...subject, ttsForFeedbackSentence: false }, "training")).toBeNull();
    expect(listenStimulusAssetId({ ...exercise, feedbackAudioAssetId: null }, subject, "training")).toBeNull();
    expect(listenStimulusAssetId(loaded(payload), subject, "training")).toBeNull();
  });

  it("prompt ze zdaniem i tasowanymi opcjami, bez polecenia, podpowiedzi i id nagrania", () => {
    const task = listenTask({ ...exercise, payload: { ...payload, instructionPl: "Nie pokazuj.", hint: "Nie pokazuj." } });
    expect(TaskPromptSchema.safeParse(task.prompt).success).toBe(true);
    expect(task.prompt).toEqual({ kind: "lesson_listen_choice", stem: "She ___ football.", options: expect.any(Array), contentLocale: "en-GB" });
    const options = task.prompt.kind === "lesson_listen_choice" ? task.prompt.options : [];
    expect(options.map((o) => o.text).sort()).toEqual(["play", "plays"]);
    expect(options.some((o) => o.id === "a" || o.id === "b")).toBe(false);
    expect(JSON.stringify(task.prompt)).not.toContain(sentenceId);
  });

  it("klucz jak wybór + id nagrania i klucz zdania; ekspozycje celu i zdania", () => {
    const task = listenTask();
    const key = answerKeyOf(task);
    expect(evaluateChoice(key.correctOptionId!, key)).toBe(true);
    const sentenceTargetKey = lessonTextTargetKey(subject, "She plays football.");
    expect(task.answerKey).toMatchObject({ feedbackAudioAssetId: sentenceId, sentenceTargetKey, targetKey: "tk-1", reason: "listen_practice" });
    expect(task.exposures).toEqual(["tk-1", sentenceTargetKey]);
    expect(task.context).toMatchObject({ reason: "listen_practice", independentCheck: false });
  });

  it("klucz zdania równy target_key (rozdział) nie dubluje ekspozycji", () => {
    const chapterPayload = { ...payload, objectiveId: "chapter.words" } as LoadedExercise["payload"];
    const targetKey = lessonExerciseTargetKey(englishChapterSubject, chapterPayload as never);
    const task = listenTask({ ...exercise, payload: chapterPayload, targetKey }, englishChapterSubject);
    expect(task.answerKey.sentenceTargetKey).toBe(targetKey);
    expect(task.exposures).toEqual([targetKey]);
  });

  it("brak gotowego nagrania albo kartkówka to naruszenie niezmiennika (AppError internal)", () => {
    const codeOf = (run: () => unknown): unknown => {
      try { run(); } catch (error) { return (error as { code?: unknown }).code; }
      return "no error";
    };
    expect(codeOf(() => listenTask({ ...exercise, feedbackAudioAssetId: null }))).toBe("internal");
    expect(codeOf(() => listenTask(exercise, subject, { mockTest: true }))).toBe("internal");
    expect(codeOf(() => listenTask(exercise, { ...subject, ttsForFeedbackSentence: false }))).toBe("internal");
  });
});

describe("materializeExercise — język treści i odpowiedzi (angielski — rozdział)", () => {
  const base = { objectiveId: "english_grammar.present_simple.third_person_s", instructionPl: "Ćwiczenie.", answer: "x", acceptedAnswers: [], focus: [] as string[] };
  const payloads: Record<string, LoadedExercise["payload"]> = {
    lesson_choice: { ...base, exerciseType: "lesson_choice", stem: "She ___ football.", options: [{ id: "a", text: "plays" }, { id: "b", text: "play" }], correctOption: "a", answerLocale: "en-GB", promptLocale: "pl-PL" },
    lesson_order: { ...base, exerciseType: "lesson_order", items: [{ id: "1", text: "She" }, { id: "2", text: "plays" }, { id: "3", text: "football" }], answerLocale: "en-GB", promptLocale: "pl-PL" },
    lesson_gap: { ...base, exerciseType: "lesson_gap", stem: "She ___ football.", answerLocale: "en-GB", promptLocale: "pl-PL" },
    lesson_match: { ...base, exerciseType: "lesson_match", pairs: [{ left: "dog", right: "pies" }, { left: "cat", right: "kot" }, { left: "fish", right: "ryba" }], extraRight: ["ptak"], answerLocale: "en-GB", promptLocale: "pl-PL" },
    lesson_group: { ...base, exerciseType: "lesson_group", groups: [{ id: "g1", label: "animals" }, { id: "g2", label: "food" }], groupItems: [{ text: "dog", groupId: "g1" }, { text: "cat", groupId: "g1" }, { text: "bread", groupId: "g2" }, { text: "milk", groupId: "g2" }], answerLocale: "en-GB", promptLocale: "pl-PL" },
    lesson_cloze: { ...base, exerciseType: "lesson_cloze", clozeText: "I ___ a dog and ___ a cat.", gapAnswers: ["have", "like"], extraWords: ["has"], answerLocale: "en-GB", promptLocale: "pl-PL" },
  };
  const materialize = (type: string, moduleOfSubject: typeof subject) =>
    materializeExercise({ independentCheck: false, reason: "practice" }, `locale-${type}`, loaded(payloads[type]!), topic, moduleOfSubject);

  it.each(Object.keys(payloads))("%s: contentLocale z answerLocale przedmiotu (gramatyka en-GB, szkoła pl-PL)", (type) => {
    const grammar = materialize(type, englishGrammarSubject);
    const school = materialize(type, schoolSubject);
    expect(grammar.prompt).toMatchObject({ kind: type, contentLocale: "en-GB" });
    expect(school.prompt).toMatchObject({ kind: type, contentLocale: "pl-PL" });
    expect(TaskPromptSchema.safeParse(grammar.prompt).success).toBe(true);
    expect(TaskPromptSchema.safeParse(school.prompt).success).toBe(true);
  });

  it.each(Object.keys(payloads))("%s: język spoza pl-PL/en-GB nie daje contentLocale", (type) => {
    expect(materialize(type, { ...subject, answerLocale: "de-DE" }).prompt).not.toHaveProperty("contentLocale");
  });

  it("lesson_short_answer nie dostaje contentLocale (poza zakresem sześciu typów)", () => {
    const short = materializeExercise({ independentCheck: false, reason: "practice" }, "locale-short", loaded({ ...base, exerciseType: "lesson_short_answer", prompt: "Does she play?", options: [{ id: "a", text: "Yes" }], correctOption: "a", answerLocale: "en-GB", promptLocale: "pl-PL" }), topic, subject);
    expect(short.prompt).not.toHaveProperty("contentLocale");
  });

  const openAnswer = (moduleOfSubject: typeof subject) => materializeExercise(
    { independentCheck: false, reason: "practice" },
    "locale-open",
    loaded({ ...base, exerciseType: "lesson_open_answer", prompt: "Ona gra w piłkę.", answerLocale: "en-GB", promptLocale: "pl-PL" }),
    topic,
    moduleOfSubject,
  );

  it("lesson_open_answer: answerLocale z przedmiotu, promptLocale z openAnswerPromptLocale", () => {
    const task = openAnswer({ ...englishGrammarSubject, openAnswerPromptLocale: "pl-PL" });
    expect(task.prompt).toMatchObject({ kind: "lesson_open_answer", answerLocale: "en-GB", promptLocale: "pl-PL" });
    expect(TaskPromptSchema.safeParse(task.prompt).success).toBe(true);
  });

  it("lesson_open_answer: gramatyka bez openAnswerPromptLocale nadal nie wysyła promptLocale, ale ma answerLocale", () => {
    const task = openAnswer(englishGrammarSubject);
    expect(task.prompt).not.toHaveProperty("promptLocale");
    expect(task.prompt).toMatchObject({ answerLocale: "en-GB" });
  });

  it("lesson_open_answer: szkoła (jeden język) zachowuje promptLocale i dostaje answerLocale pl-PL", () => {
    expect(openAnswer(schoolSubject).prompt).toMatchObject({ promptLocale: "pl-PL", answerLocale: "pl-PL" });
  });

  it("lesson_open_answer: język odpowiedzi spoza pl-PL/en-GB nie daje answerLocale", () => {
    expect(openAnswer({ ...subject, answerLocale: "de-DE" }).prompt).not.toHaveProperty("answerLocale");
  });
});

describe("materializeCard — ekspozycje przykładów w normalizacji przedmiotu", () => {
  const plan = { kind: "card", objectiveId: "o1", cardPurpose: "intro" } as const;
  const objective = topic.objectives[0]!;
  const examples = ["I’m wearing a pink coat.", "It's sunny today."];

  it("rozdział: przykład karty ma klucz rozwiązanego zdania luki (bez końcowej kropki, prosty apostrof)", () => {
    const card = materializeCard(plan, 0, objective, englishChapterSubject, examples, "rev-1");
    const gap = { exerciseType: "lesson_gap" as const, objectiveId: "o1", stem: "I'm wearing a pink ___.", answer: "coat", acceptedAnswers: [], focus: ["coat"] };
    expect(card.exposures[0]).toBe(lessonExerciseTargetKey(englishChapterSubject, gap));
    expect(card.exposures[1]).toBe(computeTargetKey("It's sunny today", "en-GB"));
  });

  it("przedmiot bez normalizeExposureText zachowuje dotychczasowe klucze przykładów", () => {
    const card = materializeCard(plan, 0, objective, englishGrammarSubject, examples, "rev-1");
    expect(card.exposures).toEqual(examples.map((example) => computeTargetKey(example, "en-GB")));
  });
});

describe("materializeCard — nagranie „Posłuchaj karty” (design szkoły §12.3)", () => {
  const topic = schoolSubject.buildDynamicTopic!({
    titlePl: "Pająki",
    objectives: [{
      id: "school.ddeck.pajaki",
      titlePl: "Pająki",
      descriptionEn: "Spiders.",
      cards: [{ title: "Pająki", body: "Pająk ma osiem nóg." }, { title: "Owady", body: "Owad ma sześć nóg." }],
    }],
  });
  const objective = topic.objectives[0]!;
  const plan = { kind: "card", objectiveId: objective.id, cardPurpose: "intro" } as Parameters<typeof materializeCard>[0];
  const audioId = "22222222-2222-4222-8222-222222222222";

  it("dołącza gotowe nagranie karty; nie zmienia ekspozycji karty", () => {
    const withAudio = materializeCard(plan, 1, objective, schoolSubject, ["Mucha ma sześć nóg."], "rev-1", audioId);
    const without = materializeCard(plan, 1, objective, schoolSubject, ["Mucha ma sześć nóg."], "rev-1");
    expect(withAudio.prompt).toMatchObject({ kind: "lesson_card", card: { title: "Owady" }, questionAudioAssetId: audioId });
    expect(without.prompt).not.toHaveProperty("questionAudioAssetId");
    expect(withAudio.exposures).toEqual(without.exposures);
  });

  it("przedmiot bez `ttsForPrompts` nie dołącza nagrania", () => {
    const task = materializeCard(plan, 0, objective, { ...schoolSubject, ttsForPrompts: false }, [], "rev-1", audioId);
    expect(task.prompt).not.toHaveProperty("questionAudioAssetId");
  });
});
