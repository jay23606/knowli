import { describe, expect, it } from "vitest";
import { validateLessonExercise } from "../pool-validation";
import { englishChapterSubject } from "../subjects/english-chapter/module";
import { TRANSLATION_INSTRUCTION } from "../subjects/english-chapter/validators";
import {
  A,
  B,
  choice,
  contextFor,
  gap,
  keywords,
  listen,
  naChecks,
  open,
  stateWith,
  subject,
  topic,
} from "../testing/agent-admission-fixtures";
import { schoolSubject } from "../subjects/school/module";
import { testIssue } from "../testing/test-issue";
import { withAgentPolicy } from "../testing/agent-test-subject";
import { NA_CHECKS } from "../testing/agent-admission-fixtures";
import type { DynamicObjectiveKind, DynamicTopicData, LessonExerciseDraft } from "../types";
import { admitBatch, precheckBatch, removeExercise, type AdmitEntry, type AgentCheckContext, type PrecheckEntry } from "./admission";
import { agentObjectivesOf } from "./capable";
import { createLessonAgentState, orderedLesson, poolOf, type LessonAgentState } from "./state";

const ctx = contextFor();

/** Przyjmuje paczkę jak kierownik: precheck, potem admit na tym samym stanie (checker „na”). */
function submit(state: LessonAgentState, objectiveId: string, drafts: readonly LessonExerciseDraft[], context: AgentCheckContext = ctx) {
  const prechecked = precheckBatch(state, objectiveId, drafts, context);
  const admitted = admitBatch(state, objectiveId, prechecked, naChecks(drafts.length), context);
  return { prechecked, ...admitted };
}

function codeOf(entry: PrecheckEntry | AdmitEntry | undefined): string {
  if (entry === undefined) return "missing";
  if ("pass" in entry) return entry.pass ? "pass" : entry.rejection.code;
  return "accepted" in entry ? "accepted" : entry.rejected.code;
}

function accepted(state: LessonAgentState, objectiveId: string, drafts: readonly LessonExerciseDraft[], context: AgentCheckContext = ctx): LessonAgentState {
  const result = submit(state, objectiveId, drafts, context);
  expect(result.results.map(codeOf)).toEqual(drafts.map(() => "accepted"));
  return result.state;
}

describe("fixture'y przyjmowania", () => {
  it("szkice pomocnicze są poprawne dla przedmiotu testowego", () => {
    for (const draft of [choice(A, 1), open(A, "Kiedy?", "w 966 roku", "f1"), gap(A, "Chrzest w roku ___.", "966"), keywords(A, "f1", 1), listen(A, 1)]) {
      expect(validateLessonExercise(draft, subject, topic), draft.exerciseType).toEqual([]);
    }
  });
});

describe("przyjmowanie paczki — limity i kolejność kroków", () => {
  it("pełna pula wygrywa z duplikatem: limit_full", () => {
    const context = contextFor({ limits: { [A]: { targetCount: 1, listenAllowance: 0, maxExercises: 1 } } });
    const state = accepted(stateWith(), A, [choice(A, 1)], context);
    const result = submit(state, A, [choice(A, 1)], context);
    expect(result.results.map(codeOf)).toEqual(["limit_full"]);
    expect(result.prechecked[0]).toMatchObject({ pass: false, rejection: { kind: "limit", code: "limit_full" } });
  });

  it("limit_full liczy wyłącznie pulę agenta, nie ćwiczenia fixed zagadnienia", () => {
    const context = contextFor({ limits: { [A]: { targetCount: 1, listenAllowance: 0, maxExercises: 1 } } });
    const state = stateWith({ fixed: [choice(A, 7), choice(A, 8), choice(A, 9)] });
    const result = submit(state, A, [choice(A, 1), choice(A, 2)], context);
    expect(result.results.map(codeOf)).toEqual(["accepted", "limit_full"]);
  });

  it("reguła ćwiczenia wygrywa z ujawnieniem: rule_exercise", () => {
    const state = stateWith({ examples: { [A]: ["w 966 roku"] } });
    const invalid = { ...open(A, "Kiedy?", "w 966 roku"), prompt: "" };
    const result = submit(state, A, [invalid]);
    expect(result.results[0]).toMatchObject({ rejected: { kind: "rule", code: "rule_exercise" } });
  });

  it("limit_listen przy listenAllowance 0", () => {
    const context = contextFor({ limits: { [A]: { targetCount: 4, listenAllowance: 0, maxExercises: 6 } } });
    const result = submit(stateWith(), A, [listen(A, 1)], context);
    expect(result.results[0]).toMatchObject({ rejected: { kind: "limit", code: "limit_listen" } });
  });

  it("limit_listen liczy ćwiczenia słuchowe puli i fixed zagadnienia (nie innych zagadnień)", () => {
    const context = contextFor({ limits: { [A]: { targetCount: 4, listenAllowance: 2, maxExercises: 8 } } });
    // Ćwiczenie słuchowe B w `fixed` nie zajmuje limitu A.
    const state = stateWith({ fixed: [listen(A, 1), listen(B, 9)] });
    const result = submit(state, A, [listen(A, 2), listen(A, 3)], context);
    expect(result.results.map(codeOf)).toEqual(["accepted", "limit_listen"]);
  });

  it("brak limitów zagadnienia w kontekście to błąd wołającego", () => {
    expect(() => precheckBatch(stateWith(), A, [choice(A, 1)], contextFor({}, [B]))).toThrow(`no limits for objective ${A}`);
  });

  it("bramka przedmiotu zwraca swój kod i powody", () => {
    const gated = withAgentPolicy(subject, {
      exerciseGate: (draft) => (draft.answer === "odpowiedź 2" ? [{ code: "gate_code", issue: testIssue("bramka", "gate reason") }] : []),
    });
    const result = submit(stateWith(), A, [choice(A, 1), choice(A, 2)], contextFor({ subject: gated }));
    expect(result.results[0]).toMatchObject({ accepted: "ex1" });
    expect(result.results[1]).toEqual({
      rejected: {
        kind: "rule",
        code: "gate_code",
        reasons: ["[test.issue] exercise: gate reason"],
        issues: [testIssue("bramka", "gate reason")],
        ruleIds: ["test.issue"],
      },
    });
  });
});

describe("przyjmowanie paczki — kody i powody odrzuceń (spec katalogu reguł §4.1–4.2)", () => {
  /** Przedmiot z regułą przedmiotu (odpowiedź „odpowiedź 2”) i bramką (odpowiedzi „odpowiedź 2” i „odpowiedź 3”). */
  const ruled = withAgentPolicy(
    {
      ...subject,
      validateExercise: (ex) => (ex.answer === "odpowiedź 2" ? [testIssue("reguła", "subject rule broken")] : []),
    },
    {
      ...subject.agentPolicy,
      exerciseGate: (draft) =>
        draft.answer === "odpowiedź 2" || draft.answer === "odpowiedź 3"
          ? [{ code: "gate_first", issue: testIssue("bramka", "gate finding") }, { code: "gate_second", issue: testIssue("bramka", "second finding") }]
          : [],
    },
  );
  const ruledCtx = contextFor({ subject: ruled });
  const rejectionAt = (entry: AdmitEntry | undefined) => {
    if (entry === undefined || !("rejected" in entry)) throw new Error(`expected rejection, got ${JSON.stringify(entry)}`);
    return entry.rejected;
  };

  it("reguła i ustalenie bramki: jedno odrzucenie z powodami obu (reguły najpierw) i kodem pierwszego ustalenia", () => {
    const rejection = rejectionAt(submit(stateWith(), A, [choice(A, 2)], ruledCtx).results[0]);
    expect(rejection).toMatchObject({ kind: "rule", code: "gate_first", ruleIds: ["test.issue"] });
    expect(rejection.reasons).toEqual([
      "[test.issue] exercise: subject rule broken",
      "[test.issue] exercise: gate finding",
      "[test.issue] exercise: second finding",
    ]);
  });

  it("same ustalenia bramki: kod pierwszego; same reguły: rule_exercise", () => {
    expect(rejectionAt(submit(stateWith(), A, [choice(A, 3)], ruledCtx).results[0]).code).toBe("gate_first");
    const invalid = { ...choice(A, 1), correctOption: "z" };
    const rejection = rejectionAt(submit(stateWith(), A, [invalid], ruledCtx).results[0]);
    expect(rejection.code).toBe("rule_exercise");
    expect(rejection.reasons.every((reason) => /^\[[a-z0-9_.]+\] /u.test(reason))).toBe(true);
  });

  it("błąd kontraktu: tylko zgłoszenia kontraktu, bez bramki", () => {
    const broken = { ...choice(A, 3), options: [{ id: "a", text: "odpowiedź 3" }] };
    const rejection = rejectionAt(submit(stateWith(), A, [broken], ruledCtx).results[0]);
    expect(rejection.code).toBe("rule_exercise");
    expect(rejection.reasons.some((reason) => reason.includes("gate finding"))).toBe(false);
    expect(rejection.ruleIds).not.toContain("test.issue");
  });

  it("puste napisy w polach opcjonalnych (ścieżka agenta): field.empty razem z regułami dalszymi", () => {
    const draft = { ...choice(A, 2), instructionPl: "" };
    const rejection = rejectionAt(submit(stateWith(), A, [draft], ruledCtx).results[0]);
    // Bramka też liczy się na kopii bez pustego pola: kod pierwszego ustalenia bramki.
    expect(rejection.code).toBe("gate_first");
    expect(rejection.ruleIds).toEqual(["field.empty", "test.issue"]);
    expect(rejection.reasons[0]).toMatch(/^\[field\.empty\] instructionPl/u);
    expect(rejection.reasons.slice(1)).toEqual([
      "[test.issue] exercise: subject rule broken",
      "[test.issue] exercise: gate finding",
      "[test.issue] exercise: second finding",
    ]);
  });

  it("kolejność powodów jest stała: kontrakt, rdzeń, przedmiot, bramka; wyniki w indeksach wejścia", () => {
    const batch = [choice(A, 2), { ...choice(A, 1), correctOption: "z", instructionPl: "" }, keywords(A, "f9", 1)];
    const results = submit(stateWith(), A, batch, ruledCtx).results;
    expect(results.map(codeOf)).toEqual(["gate_first", "rule_exercise", "lesson_extra"]);
    expect(rejectionAt(results[0]).reasons).toEqual([
      "[test.issue] exercise: subject rule broken",
      "[test.issue] exercise: gate finding",
      "[test.issue] exercise: second finding",
    ]);
    expect(rejectionAt(results[1]).ruleIds).toEqual(["field.empty", "options.correct_unknown"]);
    expect(rejectionAt(results[2]).reasons).toEqual(["[test.issue] exercise"]);
  });

  it("ofiara reguł lekcji: powód z prefiksem ofiary i id reguły", () => {
    const triggering = withAgentPolicy(
      {
        ...subject,
        validatePoolExtra: (drafts) => {
          const triggered = drafts.some((draft) => draft.answer === "odpowiedź 9");
          return new Map(drafts.flatMap((draft, index) => (triggered && draft.answer === "odpowiedź 1" ? [[index, [testIssue("ofiara", "victim of trigger")]] as const] : [])));
        },
      },
      subject.agentPolicy,
    );
    const context = contextFor({ subject: triggering });
    const state = accepted(stateWith(), A, [choice(A, 1)], context);
    const rejection = rejectionAt(submit(state, A, [choice(A, 9)], context).results[0]);
    expect(rejection).toMatchObject({ kind: "lesson", code: "lesson_extra", ruleIds: ["test.issue"] });
    expect(rejection.reasons).toEqual(["adding this exercise would make the lesson reject exercise ex1: [test.issue] exercise: victim of trigger"]);
  });

  it("własne odrzucenie reguły puli: lesson_pool z id reguły, bez prefiksu ofiary", () => {
    const state = accepted(stateWith(), A, [choice(A, 1)]);
    const rejection = rejectionAt(submit(state, A, [choice(A, 1)]).results[0]);
    expect(rejection).toMatchObject({ code: "lesson_pool", ruleIds: ["lesson.duplicate_stimulus"] });
    expect(rejection.reasons[0]).toMatch(/^\[lesson\.duplicate_stimulus\] exercise: same stimulus as the earlier lesson_choice /u);
  });

  it("ofiara reguł puli: duplikat odpowiedzi ćwiczenia późniejszego zagadnienia — lesson_pool z prefiksem ofiary", () => {
    // Unikalność odpowiedzi zachowuje PIERWSZE wystąpienie: kandydat w A wyprzedza przyjęte ćwiczenie B.
    const byAnswer = contextFor({ subject: { ...subject, poolDeduplication: "answer" } });
    const state = accepted(stateWith(), B, [choice(B, 1)], byAnswer);
    const rejection = rejectionAt(submit(state, A, [gap(A, "Inne pytanie: ___.", "odpowiedź 1")], byAnswer).results[0]);
    expect(rejection).toMatchObject({ kind: "lesson", code: "lesson_pool", ruleIds: ["lesson.duplicate_answer"] });
    expect(rejection.reasons[0]).toMatch(/^adding this exercise would make the lesson reject exercise ex1: \[lesson\.duplicate_answer\] answer: /u);
  });
});

describe("przyjmowanie paczki — kaskada słów kluczowych szkoły (spec katalogu reguł §4.4)", () => {
  const OBJECTIVE = "school.ddeck.fotosynteza";
  const QUOTE = "wytwarza cukry";
  const material = `Fotosynteza to proces, w którym roślina z wody i dwutlenku węgla, przy udziale światła, ${QUOTE}.`;
  const schoolTopic = schoolSubject.buildDynamicTopic!({
    titlePl: "Przyroda",
    objectives: [{
      id: OBJECTIVE,
      titlePl: "Fotosynteza",
      descriptionEn: "Photosynthesis.",
      cards: [{ title: "Co to jest?", body: "Roślina wytwarza cukry." }, { title: "Po co?", body: "Cukry są pokarmem rośliny." }],
    }],
  });
  const context: AgentCheckContext = {
    subject: schoolSubject,
    material,
    limits: new Map([[OBJECTIVE, { targetCount: 8, listenAllowance: 0, maxExercises: 10 }]]),
  };
  const state = () => createLessonAgentState({ topic: schoolTopic, objectives: agentObjectivesOf(schoolTopic), fixed: [], examples: {}, fixedSources: {} });
  const openDraft = (overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft => ({
    exerciseType: "lesson_open_answer",
    objectiveId: OBJECTIVE,
    prompt: "Co to jest fotosynteza?",
    answer: "Roślina z wody i dwutlenku węgla, przy udziale światła, wytwarza cukry.",
    acceptedAnswers: [],
    focus: ["wytwarza cukry"],
    questionType: "definition",
    requiredElements: [{ id: "e1", text: "Roślina wytwarza cukry." }],
    expectedForm: "explanation",
    sourceRefs: [{ quote: QUOTE }],
    familyId: "def",
    ...overrides,
  });
  const keywordsDraft: LessonExerciseDraft = {
    exerciseType: "lesson_keywords",
    objectiveId: OBJECTIVE,
    familyId: "def",
    keywordOptions: [{ id: "k1", text: "światło" }, { id: "k2", text: "cukry" }, { id: "k3", text: "tlen" }, { id: "k4", text: "korzenie" }],
    keyOptionIds: ["k1", "k2"],
    answer: "światło, cukry",
    acceptedAnswers: [],
    focus: [],
    sourceRefs: [{ quote: QUOTE }],
  };
  const ruleIdsOf = (entry: PrecheckEntry | AdmitEntry | undefined) => {
    if (entry === undefined) return [];
    if ("pass" in entry) return entry.pass ? [] : entry.rejection.ruleIds;
    return "rejected" in entry ? entry.rejected.ruleIds : [];
  };

  it("szkice kaskady są poprawne razem (bez odrzucenia rodziny)", () => {
    const prechecked = precheckBatch(state(), OBJECTIVE, [keywordsDraft, openDraft()], context);
    expect(prechecked.map(codeOf)).toEqual(["pass", "pass"]);
  });

  it("pytanie otwarte odrzucone w precheck: słowa kluczowe z tej paczki dostają school.keywords_family_rejected", () => {
    const prechecked = precheckBatch(state(), OBJECTIVE, [keywordsDraft, openDraft({ questionType: undefined })], context);
    expect(prechecked.map(codeOf)).toEqual(["lesson_extra", "rule_exercise"]);
    expect(ruleIdsOf(prechecked[0])).toEqual(["school.keywords_family_rejected"]);
  });

  it("pytanie otwarte odrzucone przez kontrolę otwartą w admit: słowa kluczowe też dostają regułę kaskady", () => {
    const prechecked = precheckBatch(state(), OBJECTIVE, [keywordsDraft, openDraft()], context);
    const failed = { answer: "zła", knowledge: "incorrect", missing: [], wrong: ["zła"] } as const;
    const checks = [NA_CHECKS, { ...NA_CHECKS, open: { kind: "done", value: { answers: [failed, failed] } } } as const];
    const admitted = admitBatch(state(), OBJECTIVE, prechecked, checks, context);
    expect(admitted.results.map(codeOf)).toEqual(["lesson_extra", "open_not_accepted"]);
    expect(ruleIdsOf(admitted.results[0])).toEqual(["school.keywords_family_rejected"]);
  });

  it("bez rodziny w lekcji i bez jej odrzucenia: zwykłe school.keywords_family_missing", () => {
    const prechecked = precheckBatch(state(), OBJECTIVE, [keywordsDraft], context);
    expect(ruleIdsOf(prechecked[0])).toEqual(["school.keywords_family_missing"]);
  });
});

describe("przyjmowanie paczki — reguły lekcji", () => {
  it("duplikat w paczce: drugi lesson_pool już w precheckBatch", () => {
    const result = submit(stateWith(), A, [choice(A, 1), choice(A, 1)]);
    expect(result.prechecked.map(codeOf)).toEqual(["pass", "lesson_pool"]);
    expect(result.results.map(codeOf)).toEqual(["accepted", "lesson_pool"]);
    expect(poolOf(result.state, A).map((entry) => entry.id)).toEqual(["ex1"]);
  });

  it("ponowne wysłanie przyjętego ćwiczenia: lesson_pool", () => {
    const state = accepted(stateWith(), A, [choice(A, 1)]);
    expect(submit(state, A, [choice(A, 1)]).results[0]).toMatchObject({ rejected: { kind: "lesson", code: "lesson_pool" } });
  });

  it("wadliwe fixed (duplikat w fixed) nie blokuje poprawnego kandydata", () => {
    const state = stateWith({ fixed: [choice(A, 1), choice(A, 1)] });
    const result = submit(state, A, [choice(A, 2)]);
    expect(result.results).toEqual([{ accepted: "ex1", sanitized: [], unchecked: false, notes: [], removedVariants: [], quotesSnapped: 0 }]);
  });

  it("fixed odrzucone przez validatePoolExtra (sierota słów kluczowych) nie blokuje poprawnego kandydata", () => {
    const state = stateWith({ fixed: [keywords(A, "f9", 9)] });
    const result = submit(state, A, [choice(A, 1)]);
    expect(result.results).toEqual([{ accepted: "ex1", sanitized: [], unchecked: false, notes: [], removedVariants: [], quotesSnapped: 0 }]);
  });

  it("słowa kluczowe bez rodziny w lekcji: lesson_extra", () => {
    const result = submit(stateWith(), A, [keywords(A, "f1", 1)]);
    expect(result.results[0]).toEqual({
      rejected: {
        kind: "lesson",
        code: "lesson_extra",
        reasons: ["[test.issue] exercise"],
        issues: [testIssue("keywords without open-answer family")],
        ruleIds: ["test.issue"],
      },
    });
  });

  it("słowa kluczowe przed swoją rodziną w paczce: oba przyjęte w precheckBatch i admitBatch, wyniki w indeksach wejścia", () => {
    const result = submit(stateWith(), A, [keywords(A, "f1", 1), open(A, "Kiedy?", "w 966 roku", "f1")]);
    expect(result.prechecked.map(codeOf)).toEqual(["pass", "pass"]);
    expect(result.results).toEqual([
      { accepted: "ex2", sanitized: [], unchecked: false, notes: [], removedVariants: [], quotesSnapped: 0 },
      { accepted: "ex1", sanitized: [], unchecked: false, notes: [], removedVariants: [], quotesSnapped: 0 },
    ]);
  });

  it("błąd validatePoolExtra na innym ćwiczeniu odrzuca kandydata: lesson_extra", () => {
    const triggering = withAgentPolicy(
      {
        ...subject,
        validatePoolExtra: (drafts) => {
          const triggered = drafts.some((draft) => draft.answer === "odpowiedź 9");
          return new Map(drafts.flatMap((draft, index) => (triggered && draft.answer === "odpowiedź 1" ? [[index, [testIssue("victim of trigger")]] as const] : [])));
        },
      },
      subject.agentPolicy,
    );
    const context = contextFor({ subject: triggering });
    const state = accepted(stateWith(), A, [choice(A, 1)], context);
    const result = submit(state, A, [choice(A, 9)], context);
    expect(result.results[0]).toMatchObject({ rejected: { kind: "lesson", code: "lesson_extra" } });
    expect((result.results[0] as { rejected: { reasons: readonly string[] } }).rejected.reasons[0]).toContain("reject exercise ex1: [test.issue]");
  });
});

describe("przyjmowanie paczki — konflikt słuchowy między zagadnieniami (rozdział)", () => {
  const WEATHER = "english_chapter.ddeck.weather";
  const WEARING = "english_chapter.ddeck.wearing";
  const data: DynamicTopicData = {
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
  const chapterTopic = englishChapterSubject.buildDynamicTopic!(data);
  const chapter = withAgentPolicy(englishChapterSubject);
  const material = "It's raining today. It's sunny today. It's windy. I'm wearing a coat.";
  const chapterCtx: AgentCheckContext = {
    subject: chapter,
    material,
    limits: new Map([WEATHER, WEARING].map((id) => [id, { targetCount: 8, listenAllowance: 2, maxExercises: 12 }])),
  };
  const chapterState = () =>
    createLessonAgentState({ topic: chapterTopic, objectives: agentObjectivesOf(chapterTopic), fixed: [], examples: {}, fixedSources: {} });

  const listenWeather: LessonExerciseDraft = {
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
  };
  const translationWearing: LessonExerciseDraft = {
    exerciseType: "lesson_open_answer",
    objectiveId: WEARING,
    instructionPl: TRANSLATION_INSTRUCTION,
    prompt: "Dziś pada deszcz.",
    answer: "It's raining today.",
    acceptedAnswers: [],
    focus: ["raining"],
  };

  it("szkice rozdziału są poprawne osobno", () => {
    expect(validateLessonExercise(listenWeather, chapter, chapterTopic)).toEqual([]);
    expect(validateLessonExercise(translationWearing, chapter, chapterTopic)).toEqual([]);
  });

  it("tekstowe ćwiczenie w B z odpowiedzią równą zdaniu słuchowemu przyjętemu w A: lesson_pool", () => {
    const withListen = submit(chapterState(), WEATHER, [listenWeather], chapterCtx);
    expect(withListen.results.map(codeOf)).toEqual(["accepted"]);
    const result = submit(withListen.state, WEARING, [translationWearing], chapterCtx);
    expect(result.results[0]).toMatchObject({ rejected: { kind: "lesson", code: "lesson_pool" } });
  });

  it("ćwiczenie słuchowe w A ze zdaniem równym odpowiedzi tekstowej przyjętej w B: lesson_pool", () => {
    const withText = submit(chapterState(), WEARING, [translationWearing], chapterCtx);
    expect(withText.results.map(codeOf)).toEqual(["accepted"]);
    const result = submit(withText.state, WEATHER, [listenWeather], chapterCtx);
    expect(result.results[0]).toMatchObject({ rejected: { kind: "lesson", code: "lesson_pool" } });
  });

  it("pusty napis w polu opcjonalnym i naruszenie bramki rozdziału: jedno odrzucenie z field.empty i ustaleniem bramki (kod bramki)", () => {
    // Prawdziwa polityka rozdziału: luka zagadnienia „words” sprawdza słowo spoza kart tego zagadnienia.
    const lexicon = ["Pogoda:", "raining — pada deszcz", "sunny — słonecznie", "windy — wietrznie", "Ubrania:", "coat — płaszcz", "Zwroty:", "I'm wearing (a) …"].join("\n");
    const gatedCtx: AgentCheckContext = { ...chapterCtx, subject: englishChapterSubject, material: lexicon };
    const offCard: LessonExerciseDraft = {
      exerciseType: "lesson_gap",
      objectiveId: WEATHER,
      instructionPl: "Mam na sobie płaszcz. Uzupełnij zdanie.",
      stem: "I'm wearing a ___.",
      answer: "coat",
      acceptedAnswers: [],
      focus: ["coat"],
    };
    // Rodzaj zagadnienia z planu: bramka słów kart działa tylko dla „words”.
    const kinds = new Map<string, DynamicObjectiveKind>([[WEATHER, "words"], [WEARING, "frame"]]);
    const kindState = () =>
      createLessonAgentState({ topic: chapterTopic, objectives: agentObjectivesOf(chapterTopic, kinds), fixed: [], examples: {}, fixedSources: {} });
    expect(codeOf(submit(kindState(), WEATHER, [offCard], gatedCtx).results[0])).toBe("card_word_missing");
    const result = submit(kindState(), WEATHER, [{ ...offCard, hint: "" }], gatedCtx);
    const entry = result.results[0]!;
    if (!("rejected" in entry)) throw new Error("expected rejection");
    expect(entry.rejected).toMatchObject({ kind: "rule", code: "card_word_missing", ruleIds: ["field.empty", "chapter.card_word_missing"] });
    expect(entry.rejected.reasons[0]).toMatch(/^\[field\.empty\] hint/u);
    expect(entry.rejected.reasons[1]).toMatch(/^\[chapter\.card_word_missing\] answer: the checked answer must contain a word of THIS objective's cards/u);
  });
});

describe("przyjmowanie paczki — sanityzacja i refine", () => {
  it("odpowiedź REFINE-REJECT: refine z powodem przedmiotu", () => {
    const result = submit(stateWith(), A, [{ ...choice(A, 1), answer: "REFINE-REJECT" }]);
    const rejection = { kind: "rule", code: "refine", reasons: ["[test.issue] exercise"], issues: [testIssue("refine reject")], ruleIds: ["test.issue"] };
    expect(result.prechecked[0]).toEqual({ pass: false, rejection });
    expect(result.results[0]).toEqual({ rejected: rejection });
  });

  it("refine odrzucający bez zgłoszeń (błąd kontraktu haka): odrzucenie z regułą bezpiecznika, bez wyjątku", () => {
    const silent = withAgentPolicy({ ...subject, refineGeneratedPool: () => ({ kept: [], rejected: [] }) }, subject.agentPolicy);
    const [entry] = precheckBatch(stateWith(), A, [choice(A, 1)], contextFor({ subject: silent }));
    expect(entry).toMatchObject({
      pass: false,
      rejection: {
        kind: "rule",
        code: "refine",
        ruleIds: ["lesson.refine_unnamed"],
        reasons: ["[lesson.refine_unnamed] exercise: the subject rejected this exercise without naming a rule"],
      },
    });
  });

  it("wariant DROP usunięty w szkicu z precheckBatch; do puli trafia oczyszczony szkic", () => {
    const draft = { ...open(A, "Kiedy?", "w 966 roku"), acceptedAnswers: ["966", "DROP"] };
    const result = submit(stateWith(), A, [draft]);
    expect(result.prechecked[0]).toMatchObject({ pass: true, draft: { acceptedAnswers: ["966"] } });
    expect(poolOf(result.state, A)[0]!.draft.acceptedAnswers).toEqual(["966"]);
  });

  it("agentPolicy.sanitize działa przed refine, a usunięte pola wracają w sanitized", () => {
    const sanitizing = withAgentPolicy(subject, {
      sanitize: (draft) => {
        const { hint, ...rest } = draft;
        return { draft: rest, removed: hint === undefined ? [] : ["hint"] };
      },
    });
    const result = submit(stateWith(), A, [{ ...choice(A, 1), hint: "podpowiedź" }], contextFor({ subject: sanitizing }));
    expect(result.prechecked[0]).toMatchObject({ pass: true, sanitized: ["hint"] });
    expect((result.prechecked[0] as { draft: LessonExerciseDraft }).draft.hint).toBeUndefined();
    expect(result.results[0]).toEqual({ accepted: "ex1", sanitized: ["hint"], unchecked: false, notes: [], removedVariants: [], quotesSnapped: 0 });
  });
});

describe("zgodność precheckBatch i admitBatch na tym samym stanie", () => {
  const fixtures: [string, () => LessonAgentState, readonly LessonExerciseDraft[]][] = [
    ["mieszana paczka z duplikatem", () => stateWith(), [choice(A, 1), gap(A, "Chrzest w roku ___.", "966"), choice(A, 1), open(A, "Kiedy?", "w 966 roku")]],
    [
      "słowa kluczowe, sierota i refine",
      () => stateWith({ fixed: [open(A, "Kto?", "Mieszko I", "f0")] }),
      [keywords(A, "f2", 1), keywords(A, "f0", 2), open(A, "Kiedy?", "w 966 roku", "f2"), keywords(A, "f9", 3), { ...choice(A, 5), answer: "REFINE-REJECT" }],
    ],
    [
      "ujawnienia i limit słuchowy",
      () => stateWith({ examples: { [A]: ["Bolesław Chrobry"] }, fixed: [listen(A, 1), listen(A, 2)] }),
      [open(A, "Syn Mieszka?", "Bolesław Chrobry"), listen(A, 3), gap(A, "Rok ___.", "966"), open(A, "Rok chrztu?", "966")],
    ],
  ];

  it.each(fixtures)("%s", (_name, makeState, drafts) => {
    const state = makeState();
    const prechecked = precheckBatch(state, A, drafts, ctx);
    const admitted = admitBatch(state, A, prechecked, naChecks(drafts.length), ctx);
    const precheckCodes = prechecked.map((entry) => (entry.pass ? "accepted" : entry.rejection.code));
    expect(admitted.results.map(codeOf)).toEqual(precheckCodes);
    expect(new Set(precheckCodes).size).toBeGreaterThan(1);
  });
});

describe("removeExercise", () => {
  it("usuwa własne ćwiczenie razem z osieroconymi słowami kluczowymi rodziny", () => {
    const withFamily = accepted(stateWith(), A, [open(A, "Kiedy?", "w 966 roku", "f1"), keywords(A, "f1", 1)]);
    const state = accepted(withFamily, A, [choice(A, 1)]);
    const result = removeExercise(state, A, "ex1", ctx);
    expect(result.removed).toEqual(["ex1", "ex2"]);
    expect(poolOf(result.state, A).map((entry) => entry.id)).toEqual(["ex3"]);
  });

  it("usuwa tylko wskazane ćwiczenie, gdy rodzina ma jeszcze pytanie otwarte (także fixed)", () => {
    const state = accepted(stateWith({ fixed: [open(A, "Kto?", "Mieszko I", "f1")] }), A, [open(A, "Kiedy?", "w 966 roku", "f1"), keywords(A, "f1", 1)]);
    expect(removeExercise(state, A, "ex1", ctx).removed).toEqual(["ex1"]);
  });

  it("nieznane, cudze i fixed → [] i ten sam stan", () => {
    let state = stateWith({ fixed: [choice(A, 7)] });
    state = accepted(state, A, [choice(A, 1)]);
    state = accepted(state, B, [choice(B, 2)]);
    for (const [objectiveId, id] of [[A, "ex99"], [A, "ex2"], [B, "ex1"]] as const) {
      const result = removeExercise(state, objectiveId, id, ctx);
      expect(result.removed).toEqual([]);
      expect(result.state).toBe(state);
    }
    expect(orderedLesson(state)).toHaveLength(3);
  });
});

describe("niezmienność wejścia", () => {
  it("precheckBatch, admitBatch i removeExercise nie zmieniają stanu wejściowego", () => {
    const state = accepted(stateWith({ examples: { [A]: ["x"] }, fixed: [choice(B, 3)] }), A, [open(A, "Kiedy?", "w 966 roku", "f1"), keywords(A, "f1", 1)]);
    const snapshot = structuredClone(state);
    const drafts = [choice(A, 1), keywords(A, "f1", 2), choice(A, 1)];
    const draftsSnapshot = structuredClone(drafts);
    const prechecked = precheckBatch(state, A, drafts, ctx);
    admitBatch(state, A, prechecked, naChecks(drafts.length), ctx);
    removeExercise(state, A, "ex1", ctx);
    expect(state).toEqual(snapshot);
    expect(drafts).toEqual(draftsSnapshot);
  });
});
