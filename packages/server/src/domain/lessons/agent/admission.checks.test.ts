import { describe, expect, it } from "vitest";
import { MAX_TEXT_LENGTH } from "../pool-validation";
import { schoolSubject } from "../subjects/school/module";
import { schoolAgentPolicy } from "../subjects/school/agent-policy";
import { A, B, choice, contextFor, gap, NA_CHECKS, open, stateWith, subject } from "../testing/agent-admission-fixtures";
import { withAgentPolicy } from "../testing/agent-test-subject";
import type { LessonExerciseDraft } from "../types";
import {
  admitBatch,
  precheckBatch,
  submitExamples,
  type AgentCheckContext,
  type AgentHintVerdict,
  type CandidateChecks,
  type OpenGraded,
} from "./admission";
import { agentObjectivesOf } from "./capable";
import { createLessonAgentState, poolOf, type LessonAgentState } from "./state";

const ctx = contextFor();

/** Jak kierownik: precheck, potem admit z podanymi wynikami checkera na tym samym stanie. */
function submitWith(state: LessonAgentState, objectiveId: string, drafts: readonly LessonExerciseDraft[], checks: readonly CandidateChecks[]) {
  const prechecked = precheckBatch(state, objectiveId, drafts, ctx);
  return admitBatch(state, objectiveId, prechecked, checks, ctx);
}

function acceptAll(state: LessonAgentState, objectiveId: string, drafts: readonly LessonExerciseDraft[]): LessonAgentState {
  const result = submitWith(state, objectiveId, drafts, drafts.map(() => NA_CHECKS));
  for (const entry of result.results) expect(entry).toHaveProperty("accepted");
  return result.state;
}

describe("admitBatch — ślepe rozwiązanie (krok 5)", () => {
  it("solve na → przyjęte, unchecked: false", () => {
    const result = submitWith(stateWith(), A, [choice(A, 1)], [{ solve: { kind: "na" }, variants: { kind: "na" }, hint: { kind: "na" }, open: { kind: "na" } }]);
    expect(result.results).toEqual([{ accepted: "ex1", sanitized: [], unchecked: false }]);
  });

  it("solve unavailable → przyjęte, unchecked: true", () => {
    const result = submitWith(stateWith(), A, [choice(A, 1)], [{ solve: { kind: "unavailable" }, variants: { kind: "na" }, hint: { kind: "na" }, open: { kind: "na" } }]);
    expect(result.results).toEqual([{ accepted: "ex1", sanitized: [], unchecked: true }]);
    expect(poolOf(result.state, A)).toHaveLength(1);
  });

  it("variants unavailable przy zgodnym rozwiązaniu → przyjęte, unchecked: true", () => {
    const draft = { ...open(A, "Kiedy?", "w 966 roku"), acceptedAnswers: ["966"] };
    const result = submitWith(stateWith(), A, [draft], [{ solve: { kind: "done", value: ["w 966 roku"] }, variants: { kind: "unavailable" }, hint: { kind: "na" }, open: { kind: "na" } }]);
    expect(result.results).toEqual([{ accepted: "ex1", sanitized: [], unchecked: true }]);
  });

  it("solve done zgodne (także wariant) → przyjęte, unchecked: false", () => {
    const draft = { ...open(A, "Kiedy?", "w 966 roku"), acceptedAnswers: ["966"] };
    const result = submitWith(stateWith(), A, [draft], [{ solve: { kind: "done", value: ["966"] }, variants: { kind: "done", value: [true] }, hint: { kind: "na" }, open: { kind: "na" } }]);
    expect(result.results).toEqual([{ accepted: "ex1", sanitized: [], unchecked: false }]);
  });

  it("solve done z rozjazdem → blind_mismatch z odpowiedzią solvera w reasons; pula bez zmian", () => {
    const state = stateWith();
    const result = submitWith(state, A, [choice(A, 1), choice(A, 2)], [
      { solve: { kind: "done", value: ["dystraktor 1"] }, variants: { kind: "na" }, hint: { kind: "na" }, open: { kind: "na" } },
      NA_CHECKS,
    ]);
    const [first, second] = result.results;
    expect(first).toMatchObject({ rejected: { kind: "blind", code: "blind_mismatch" } });
    expect((first as { rejected: { reasons: readonly string[] } }).rejected.reasons.join(" ")).toContain('"dystraktor 1"');
    // Odrzucony kandydat nie zużywa identyfikatora ani miejsca w puli.
    expect(second).toEqual({ accepted: "ex1", sanitized: [], unchecked: false });
    expect(poolOf(result.state, A).map((entry) => entry.draft.answer)).toEqual(["odpowiedź 2"]);
  });

  it("kroki 1–4 wygrywają z checkerem: duplikat z rozjazdem to lesson_pool", () => {
    const state = acceptAll(stateWith(), A, [choice(A, 1)]);
    const result = submitWith(state, A, [choice(A, 1)], [{ solve: { kind: "done", value: ["zła"] }, variants: { kind: "na" }, hint: { kind: "na" }, open: { kind: "na" } }]);
    expect(result.results[0]).toMatchObject({ rejected: { code: "lesson_pool" } });
  });

  it("rozjazd wygrywa z odrzuconym wariantem: blind_mismatch", () => {
    const draft = { ...open(A, "Kiedy?", "w 966 roku"), acceptedAnswers: ["966"] };
    const result = submitWith(stateWith(), A, [draft], [{ solve: { kind: "done", value: ["1000"] }, variants: { kind: "done", value: [false] }, hint: { kind: "na" }, open: { kind: "na" } }]);
    expect(result.results[0]).toMatchObject({ rejected: { code: "blind_mismatch" } });
  });

  it("liczba wyników checkera różna od liczby wpisów to błąd wołającego", () => {
    const prechecked = precheckBatch(stateWith(), A, [choice(A, 1)], ctx);
    expect(() => admitBatch(stateWith(), A, prechecked, [], ctx)).toThrow("checks");
  });
});

describe("admitBatch — warianty (krok 6)", () => {
  it("variants [true, false] → variant_rejected z odrzuconym wariantem w reasons", () => {
    const draft = { ...open(A, "Kiedy?", "w 966 roku"), acceptedAnswers: ["966", "w X wieku"] };
    const result = submitWith(stateWith(), A, [draft], [{ solve: { kind: "na" }, variants: { kind: "done", value: [true, false] }, hint: { kind: "na" }, open: { kind: "na" } }]);
    expect(result.results[0]).toMatchObject({ rejected: { kind: "variant", code: "variant_rejected" } });
    const reasons = (result.results[0] as { rejected: { reasons: readonly string[] } }).rejected.reasons;
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('"w X wieku"');
    expect(reasons[0]).not.toContain('"966"');
    expect(poolOf(result.state, A)).toHaveLength(0);
  });

  it("sędzia ocenia warianty szkicu po refine (DROP usunięty): indeksy wyników odpowiadają wariantom oczyszczonym", () => {
    const draft = { ...open(A, "Kiedy?", "w 966 roku"), acceptedAnswers: ["DROP", "966", "w X wieku"] };
    const prechecked = precheckBatch(stateWith(), A, [draft], ctx);
    expect(prechecked[0]).toMatchObject({ pass: true, draft: { acceptedAnswers: ["966", "w X wieku"] } });
    const result = admitBatch(stateWith(), A, prechecked, [{ solve: { kind: "na" }, variants: { kind: "done", value: [false, true] }, hint: { kind: "na" }, open: { kind: "na" } }], ctx);
    expect((result.results[0] as { rejected: { reasons: readonly string[] } }).rejected.reasons[0]).toContain('"966"');
  });
});

describe("admitBatch — sędzia podpowiedzi i kontrola otwarta (etap 2b)", () => {
  // Przedmiot testowy z tekstami odrzuceń szkoły: decyzja zależy tylko od wyników kontroli i szablonów.
  const school = withAgentPolicy(subject, { rejectionTexts: schoolAgentPolicy.rejectionTexts });
  const schoolCtx = contextFor({ subject: school });
  const texts = schoolAgentPolicy.rejectionTexts;
  const draft = open(A, "Kiedy?", "w 966 roku");

  const graded = (knowledge: OpenGraded["knowledge"], answer: string, missing: readonly string[] = [], wrong: readonly string[] = []): OpenGraded => ({
    answer,
    knowledge,
    missing,
    wrong,
  });
  const correct = (answer: string) => graded("correct", answer);
  const openDone = (first: OpenGraded, second: OpenGraded): CandidateChecks["open"] => ({ kind: "done", value: { answers: [first, second] } });
  const hintDone = (verdict: AgentHintVerdict): CandidateChecks["hint"] => ({ kind: "done", value: verdict });
  const checks = (partial: Partial<CandidateChecks>): CandidateChecks => ({ ...NA_CHECKS, ...partial });

  function admitOne(candidate: LessonExerciseDraft, partial: Partial<CandidateChecks>) {
    const prechecked = precheckBatch(stateWith(), A, [candidate], schoolCtx);
    const result = admitBatch(stateWith(), A, prechecked, [checks(partial)], schoolCtx);
    return { ...result, entry: result.results[0]! };
  }

  const rejectedOf = (entry: unknown) => (entry as { rejected: { kind: string; code: string; reasons: readonly string[] } }).rejected;

  it.each([
    ["unsupported", "hint_unsupported", texts.hintUnsupported],
    ["language", "hint_language", texts.hintLanguage],
    ["reveals", "hint_reveals_paraphrase", texts.hintReveals],
  ] as const)("hint %s → odrzucenie hint/%s: szablon i powód sędziego w jednym wierszu", (verdict, code, template) => {
    const { entry, state } = admitOne(draft, { hint: hintDone({ verdict, reason: "the hint says X" }) });
    const rejection = rejectedOf(entry);
    expect(rejection).toMatchObject({ kind: "hint", code });
    expect(rejection.reasons).toHaveLength(1);
    expect(rejection.reasons[0]!.startsWith(template!)).toBe(true);
    expect(rejection.reasons[0]).toContain("the hint says X");
    expect(poolOf(state, A)).toHaveLength(0);
  });

  it("hint ok → przyjęte bez unchecked", () => {
    expect(admitOne(draft, { hint: hintDone({ verdict: "ok" }) }).entry).toEqual({ accepted: "ex1", sanitized: [], unchecked: false });
  });

  it("open: obie odpowiedzi correct → przyjęte bez unchecked", () => {
    expect(admitOne(draft, { open: openDone(correct("a"), correct("b")) }).entry).toEqual({ accepted: "ex1", sanitized: [], unchecked: false });
  });

  it("open: druga partial z missing → open_not_accepted z openMissing, odpowiedzią drugiej i brakującym elementem", () => {
    const { entry, state } = admitOne(draft, { open: openDone(correct("Mieszko"), graded("partial", "Mieszko I przyjął chrzest.", ["Odra"])) });
    const rejection = rejectedOf(entry);
    expect(rejection).toMatchObject({ kind: "open", code: "open_not_accepted" });
    expect(rejection.reasons).toHaveLength(1);
    expect(rejection.reasons[0]!.startsWith(texts.openMissing!)).toBe(true);
    expect(rejection.reasons[0]).toContain('Answer: "Mieszko I przyjął chrzest."');
    expect(rejection.reasons[0]).toContain('Missing: "Odra"');
    expect(poolOf(state, A)).toHaveLength(0);
  });

  it("open: partial bez missing, ale z wrong → openWrong ze stwierdzeniem", () => {
    const { entry } = admitOne(draft, { open: openDone(graded("partial", "Wisła płynie do Morza Czarnego.", [], ["Wisła płynie do Morza Czarnego"]), correct("b")) });
    const rejection = rejectedOf(entry);
    expect(rejection).toMatchObject({ kind: "open", code: "open_not_accepted" });
    expect(rejection.reasons[0]!.startsWith(texts.openWrong!)).toBe(true);
    expect(rejection.reasons[0]).toContain('Answer: "Wisła płynie do Morza Czarnego."');
    expect(rejection.reasons[0]).toContain('Errors: "Wisła płynie do Morza Czarnego"');
    expect(rejection.reasons[0]).not.toContain(texts.openMissing!);
  });

  it("open: partial z missing i wrong → openWrong z obiema listami (błędy wygrywają z brakami)", () => {
    const { entry } = admitOne(draft, {
      open: openDone(graded("partial", "Mieszko I przyjął chrzest w 1000 roku.", ["Odra"], ["chrzest w 1000 roku"]), correct("b")),
    });
    const rejection = rejectedOf(entry);
    expect(rejection).toMatchObject({ kind: "open", code: "open_not_accepted" });
    expect(rejection.reasons).toHaveLength(1);
    expect(rejection.reasons[0]!.startsWith(texts.openWrong!)).toBe(true);
    expect(rejection.reasons[0]).not.toContain(texts.openMissing!);
    expect(rejection.reasons[0]).toContain('Answer: "Mieszko I przyjął chrzest w 1000 roku."');
    expect(rejection.reasons[0]).toContain('Missing: "Odra"');
    expect(rejection.reasons[0]).toContain('Errors: "chrzest w 1000 roku"');
  });

  it("open: incorrect z samym missing → openWrong z brakującym elementem, bez pustej listy błędów", () => {
    const { entry } = admitOne(draft, { open: openDone(graded("incorrect", "Bolesław Chrobry.", ["Mieszko I"]), correct("b")) });
    const rejection = rejectedOf(entry);
    expect(rejection).toMatchObject({ kind: "open", code: "open_not_accepted" });
    expect(rejection.reasons[0]!.startsWith(texts.openWrong!)).toBe(true);
    expect(rejection.reasons[0]).not.toContain(texts.openMissing!);
    expect(rejection.reasons[0]).toContain('Missing: "Mieszko I"');
    expect(rejection.reasons[0]).not.toContain("Errors:");
  });

  it("open: pierwsza incorrect → odrzucenie z pierwszą odpowiedzią (nie z drugą)", () => {
    const { entry } = admitOne(draft, { open: openDone(graded("incorrect", "pierwsza", [], ["błąd"]), graded("partial", "druga", ["Odra"])) });
    const rejection = rejectedOf(entry);
    expect(rejection.reasons).toHaveLength(1);
    expect(rejection.reasons[0]).toContain('"pierwsza"');
    expect(rejection.reasons[0]).not.toContain('"druga"');
  });

  it("hint reveals + open partial → jedno odrzucenie z kodem podpowiedzi i obydwoma powodami", () => {
    const { entry } = admitOne(draft, {
      hint: hintDone({ verdict: "reveals", reason: "paraphrase of the answer" }),
      open: openDone(correct("a"), graded("partial", "druga", ["Odra"])),
    });
    const rejection = rejectedOf(entry);
    expect(rejection).toMatchObject({ kind: "hint", code: "hint_reveals_paraphrase" });
    expect(rejection.reasons).toHaveLength(2);
    expect(rejection.reasons[0]!.startsWith(texts.hintReveals!)).toBe(true);
    expect(rejection.reasons[1]!.startsWith(texts.openMissing!)).toBe(true);
  });

  it("hint ok + open partial → open_not_accepted", () => {
    const { entry } = admitOne(draft, { hint: hintDone({ verdict: "ok" }), open: openDone(graded("partial", "a", ["Odra"]), correct("b")) });
    expect(rejectedOf(entry)).toMatchObject({ kind: "open", code: "open_not_accepted" });
  });

  it("hint unavailable + open obie correct → przyjęte z unchecked: true", () => {
    expect(admitOne(draft, { hint: { kind: "unavailable" }, open: openDone(correct("a"), correct("b")) }).entry).toEqual({
      accepted: "ex1",
      sanitized: [],
      unchecked: true,
    });
  });

  it("hint unavailable + open partial → odrzucenie (odrzucenie wygrywa z notą)", () => {
    const { entry } = admitOne(draft, { hint: { kind: "unavailable" }, open: openDone(graded("partial", "a", ["Odra"]), correct("b")) });
    expect(rejectedOf(entry)).toMatchObject({ kind: "open", code: "open_not_accepted" });
  });

  it("open unavailable → przyjęte z unchecked: true", () => {
    expect(admitOne(draft, { open: { kind: "unavailable" } }).entry).toEqual({ accepted: "ex1", sanitized: [], unchecked: true });
  });

  it("blind_mismatch z done i hint unsupported → odrzucenie blind (kroki 2a pierwsze)", () => {
    const withSolve = { ...draft, acceptedAnswers: [] };
    const { entry } = admitOne(withSolve, {
      solve: { kind: "done", value: ["1000"] },
      hint: hintDone({ verdict: "unsupported", reason: "r" }),
    });
    expect(rejectedOf(entry)).toMatchObject({ kind: "blind", code: "blind_mismatch" });
  });
});

describe("submitExamples", () => {
  it("4 linie → przyjęte 3 (przycięte), czwarta zgłoszona", () => {
    const result = submitExamples(stateWith(), A, ["  Mieszko I przyjął chrzest.  ", "Zdanie drugie.", "Zdanie trzecie.", "Zdanie czwarte."], ctx);
    expect(result.accepted).toBe(3);
    expect(result.state.examples.get(A)).toEqual(["Mieszko I przyjął chrzest.", "Zdanie drugie.", "Zdanie trzecie."]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("example 4");
  });

  it("identyczne linie (po przycięciu) liczą się raz i nie zajmują miejsc kolejnych przykładów", () => {
    const result = submitExamples(stateWith(), A, ["Zdanie pierwsze.", "Zdanie pierwsze.", "  Zdanie pierwsze. ", "Zdanie drugie.", "Zdanie trzecie."], ctx);
    expect(result.accepted).toBe(3);
    expect(result.state.examples.get(A)).toEqual(["Zdanie pierwsze.", "Zdanie drugie.", "Zdanie trzecie."]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toMatch(/^example 2: .*duplicate/u);
    expect(result.errors[1]).toMatch(/^example 3: .*duplicate/u);
  });

  it("linia ujawniająca przyjęte samodzielne ćwiczenie → błąd, pozostałe przyjęte", () => {
    const state = acceptAll(stateWith(), A, [open(A, "Rok chrztu?", "966")]);
    const result = submitExamples(state, A, ["Chrzest Polski.", "966"], ctx);
    expect(result.accepted).toBe(1);
    expect(result.state.examples.get(A)).toEqual(["Chrzest Polski."]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("example 2");
    expect(result.errors[0]).toContain('exercise ex1 "966"');
  });

  it("linia ujawniająca samodzielne fixed innego zagadnienia też odpada", () => {
    const state = stateWith({ fixed: [open(B, "Rok chrztu?", "966")] });
    const result = submitExamples(state, A, ["966"], ctx);
    expect(result.accepted).toBe(0);
    expect(result.errors[0]).toContain('an existing exercise "966"');
  });

  it("linia równa odpowiedzi ćwiczenia niesamodzielnego nie jest ujawnieniem", () => {
    const state = acceptAll(stateWith(), A, [gap(A, "Rok ___.", "966")]);
    expect(submitExamples(state, A, ["966"], ctx)).toMatchObject({ accepted: 1, errors: [] });
  });

  it("zastępuje poprzednie przykłady zagadnienia, inne zagadnienia bez zmian", () => {
    const state = stateWith({ examples: { [A]: ["Stare A."], [B]: ["Stare B."] } });
    const result = submitExamples(state, A, ["Nowe A."], ctx);
    expect(result).toMatchObject({ accepted: 1, errors: [] });
    expect(result.state.examples.get(A)).toEqual(["Nowe A."]);
    expect(result.state.examples.get(B)).toEqual(["Stare B."]);
    expect(state.examples.get(A)).toEqual(["Stare A."]);
  });

  it("żadna linia nie przeszła → stare przykłady zostają (ten sam stan)", () => {
    const state = acceptAll(stateWith({ examples: { [A]: ["Stare A."] } }), A, [open(A, "Rok chrztu?", "966")]);
    const result = submitExamples(state, A, ["966", "   ", 7, "x".repeat(MAX_TEXT_LENGTH + 1)], ctx);
    expect(result.accepted).toBe(0);
    expect(result.state).toBe(state);
    expect(result.state.examples.get(A)).toEqual(["Stare A."]);
    expect(result.errors).toHaveLength(4);
  });

  it("pusta tablica → nic nie przyjęte, stan bez zmian", () => {
    const state = stateWith({ examples: { [A]: ["Stare A."] } });
    expect(submitExamples(state, A, [], ctx)).toEqual({ state, accepted: 0, errors: [] });
  });

  it('"x" → błąd kształtu', () => {
    const state = stateWith();
    expect(submitExamples(state, A, "x", ctx)).toEqual({ state, accepted: 0, errors: ["examples must be an array of strings"] });
  });

  it("przyjęte przykłady wpływają na kolejne kontrole ujawnień", () => {
    const state = submitExamples(stateWith(), A, ["w 966 roku"], ctx).state;
    const result = submitWith(state, A, [open(A, "Kiedy?", "w 966 roku")], [NA_CHECKS]);
    expect(result.results[0]).toMatchObject({ rejected: { code: "leak_victim" } });
  });
});

describe("wydajność przyjmowania", () => {
  // Lekcja szkoły: 6 zagadnień po 15 ćwiczeń (90) i materiał ok. 15 000 znaków; paczka 12.
  const OBJECTIVES = 6;
  const sentence = (o: number, k: number) => `Fakt ${o}-${k}: w zagadnieniu numer ${o} zdarzenie ${k} opisuje materiał rodzica.`;
  const material = Array.from({ length: OBJECTIVES }, (_, o) => Array.from({ length: 35 }, (_, k) => sentence(o, k)).join(" ")).join(" ");
  const schoolTopic = schoolSubject.buildDynamicTopic!({
    titlePl: "Duża lekcja",
    objectives: Array.from({ length: OBJECTIVES }, (_, o) => ({
      id: `school.ddeck.o${o}`,
      titlePl: `Zagadnienie ${o}`,
      descriptionEn: `Objective ${o}.`,
      cards: [
        { title: "Karta 1", body: sentence(o, 0) },
        { title: "Karta 2", body: sentence(o, 1) },
      ],
    })),
  });
  const ids = schoolTopic.objectives.map((objective) => objective.id);

  function schoolDraft(o: number, k: number): LessonExerciseDraft {
    const objectiveId = ids[o]!;
    const answer = `odpowiedź ${o}-${k}`;
    const sourceRefs = [{ quote: sentence(o, k % 30) }];
    if (k % 3 === 0) return { ...choice(objectiveId, 0), stem: `Pytanie ${o}-${k}: ___`, options: [{ id: "a", text: answer }, { id: "b", text: `inna ${o}-${k}` }], answer, sourceRefs };
    if (k % 3 === 1) return { ...gap(objectiveId, `Luka ${o}-${k}: ___.`, answer), sourceRefs };
    return {
      ...open(objectiveId, `Pytanie otwarte ${o}-${k}?`, answer),
      questionType: "definition",
      requiredElements: [{ id: "e1", text: answer }],
      expectedForm: "explanation",
      sourceRefs,
    };
  }

  it("90 ćwiczeń, 6 zagadnień, materiał ok. 15 000 znaków: precheckBatch + admitBatch paczki 12 < 2000 ms (w CI < 10 000 ms)", () => {
    expect(material.length).toBeGreaterThan(14_000);
    expect(material.length).toBeLessThan(16_000);
    const school = withAgentPolicy(schoolSubject);
    const fixed = Array.from({ length: OBJECTIVES }, (_, o) => Array.from({ length: 15 }, (_, k) => schoolDraft(o, k))).flat();
    const state = createLessonAgentState({ topic: schoolTopic, objectives: agentObjectivesOf(schoolTopic), fixed, examples: {}, fixedSources: {} });
    const context: AgentCheckContext = {
      subject: school,
      material,
      limits: new Map(ids.map((id) => [id, { targetCount: 8, listenAllowance: 0, maxExercises: 20 }])),
    };
    const batch = Array.from({ length: 12 }, (_, k) => schoolDraft(0, 15 + k));
    const startedAt = performance.now();
    const prechecked = precheckBatch(state, ids[0]!, batch, context);
    const admitted = admitBatch(state, ids[0]!, prechecked, batch.map(() => NA_CHECKS), context);
    const elapsed = performance.now() - startedAt;
    expect(admitted.results.filter((entry) => "accepted" in entry)).toHaveLength(12);
    // Strażnik złożoności (np. kwadratowej), nie benchmark: współdzielony runner CI dostaje zapas.
    expect(elapsed).toBeLessThan(process.env.CI ? 10_000 : 2000);
  });
});
