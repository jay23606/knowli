import { describe, expect, it } from "vitest";
import { MAX_TEXT_LENGTH } from "../pool-validation";
import { schoolSubject } from "../subjects/school/module";
import { schoolAgentPolicy } from "../subjects/school/agent-policy";
import { A, B, choice, contextFor, gap, NA_CHECKS, open, stateWith, subject } from "../testing/agent-admission-fixtures";
import { withAgentPolicy } from "../testing/agent-test-subject";
import type { LessonExerciseDraft } from "../types";
import type { LessonRuleIssue } from "../rules/catalog";
import { formatRuleReason } from "../rules/rule-reason";
import { testIssue } from "../testing/test-issue";
import {
  admitBatch,
  precheckBatch,
  submitExamples,
  type AdmitEntry,
  type AgentCheckContext,
  type AgentHintVerdict,
  type CandidateChecks,
  type OpenGraded,
  type Rejection,
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
    expect(result.results).toEqual([{ accepted: "ex1", sanitized: [], unchecked: false, notes: [], removedVariants: [], quotesSnapped: 0 }]);
  });

  it("solve unavailable → przyjęte, unchecked: true", () => {
    const result = submitWith(stateWith(), A, [choice(A, 1)], [{ solve: { kind: "unavailable" }, variants: { kind: "na" }, hint: { kind: "na" }, open: { kind: "na" } }]);
    expect(result.results).toEqual([{ accepted: "ex1", sanitized: [], unchecked: true, notes: [], removedVariants: [], quotesSnapped: 0 }]);
    expect(poolOf(result.state, A)).toHaveLength(1);
  });

  it("variants unavailable przy zgodnym rozwiązaniu → przyjęte, unchecked: true", () => {
    const draft = { ...open(A, "Kiedy?", "w 966 roku"), acceptedAnswers: ["966"] };
    const result = submitWith(stateWith(), A, [draft], [{ solve: { kind: "done", value: ["w 966 roku"] }, variants: { kind: "unavailable" }, hint: { kind: "na" }, open: { kind: "na" } }]);
    expect(result.results).toEqual([{ accepted: "ex1", sanitized: [], unchecked: true, notes: [], removedVariants: [], quotesSnapped: 0 }]);
  });

  it("solve done zgodne (także wariant) → przyjęte, unchecked: false", () => {
    const draft = { ...open(A, "Kiedy?", "w 966 roku"), acceptedAnswers: ["966"] };
    const result = submitWith(stateWith(), A, [draft], [{ solve: { kind: "done", value: ["966"] }, variants: { kind: "done", value: [true] }, hint: { kind: "na" }, open: { kind: "na" } }]);
    expect(result.results).toEqual([{ accepted: "ex1", sanitized: [], unchecked: false, notes: [], removedVariants: [], quotesSnapped: 0 }]);
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
    expect(second).toEqual({ accepted: "ex1", sanitized: [], unchecked: false, notes: [], removedVariants: [], quotesSnapped: 0 });
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

describe("admitBatch — warianty odrzucone przez checker (spec katalogu reguł §5.3)", () => {
  const variantsDone = (value: readonly boolean[], partial: Partial<CandidateChecks> = {}): CandidateChecks => ({
    ...NA_CHECKS,
    variants: { kind: "done", value },
    ...partial,
  });
  const acceptedOf = (entry: AdmitEntry | undefined) => {
    if (entry === undefined || !("accepted" in entry)) throw new Error(`expected acceptance, got ${JSON.stringify(entry)}`);
    return entry;
  };
  const rejectedOf = (entry: AdmitEntry | undefined) => {
    if (entry === undefined || !("rejected" in entry)) throw new Error(`expected rejection, got ${JSON.stringify(entry)}`);
    return entry.rejected;
  };

  it("część wariantów usunięta: przyjęte bez nich, z notą check.variants i listą usuniętych", () => {
    const draft = { ...open(A, "Kiedy?", "w 966 roku"), acceptedAnswers: ["966", "w X wieku"] };
    const result = submitWith(stateWith(), A, [draft], [variantsDone([true, false])]);
    const entry = acceptedOf(result.results[0]);
    expect(entry).toMatchObject({ accepted: "ex1", unchecked: false, removedVariants: ["w X wieku"] });
    expect(entry.notes.map((note) => [note.rule, note.field])).toEqual([["check.variants", "acceptedAnswers[1]"]]);
    expect(entry.notes.map(formatRuleReason)).toEqual([
      '[check.variants] acceptedAnswers[1]: variant "w X wieku" removed: not equivalent to the answer "w 966 roku"; do not add it again',
    ]);
    expect(poolOf(result.state, A)[0]!.draft.acceptedAnswers).toEqual(["966"]);
  });

  it("wszystkie warianty usunięte: przyjęte z pustą listą wariantów i notą na każdy", () => {
    const draft = { ...open(A, "Kiedy?", "w 966 roku"), acceptedAnswers: ["w X wieku", "w XI wieku"] };
    const result = submitWith(stateWith(), A, [draft], [variantsDone([false, false])]);
    const entry = acceptedOf(result.results[0]);
    expect(entry.removedVariants).toEqual(["w X wieku", "w XI wieku"]);
    expect(entry.notes.map((note) => note.field)).toEqual(["acceptedAnswers[0]", "acceptedAnswers[1]"]);
    expect(poolOf(result.state, A)[0]!.draft.acceptedAnswers).toEqual([]);
  });

  it("indeksy wyników odpowiadają wariantom szkicu po refine (DROP usunięty w precheck)", () => {
    const draft = { ...open(A, "Kiedy?", "w 966 roku"), acceptedAnswers: ["DROP", "966", "w X wieku"] };
    const prechecked = precheckBatch(stateWith(), A, [draft], ctx);
    expect(prechecked[0]).toMatchObject({ pass: true, draft: { acceptedAnswers: ["966", "w X wieku"] } });
    const result = admitBatch(stateWith(), A, prechecked, [variantsDone([false, true])], ctx);
    expect(acceptedOf(result.results[0]).removedVariants).toEqual(["966"]);
    expect(poolOf(result.state, A)[0]!.draft.acceptedAnswers).toEqual(["w X wieku"]);
  });

  it("rozwiązujący odpowiedział usuniętym wariantem: blind_mismatch z powodem o usuniętym wariancie", () => {
    const draft = { ...open(A, "Kiedy?", "w 966 roku"), acceptedAnswers: ["966"] };
    const result = submitWith(stateWith(), A, [draft], [variantsDone([false], { solve: { kind: "done", value: ["966"] } })]);
    const rejection = rejectedOf(result.results[0]);
    expect(rejection).toMatchObject({ kind: "blind", code: "blind_mismatch", ruleIds: ["check.blind_solve"] });
    expect(rejection.reasons[0]).toContain(
      'it matched only the removed variant "966", which the variant check judged not equivalent: do not add it again; ' +
        "make the stimulus point to the key only",
    );
    expect(rejection.reasons[0]).toContain('the key is "w 966 roku"');
    expect(poolOf(result.state, A)).toHaveLength(0);
  });

  it("odrzucenie podpowiedzi albo oceny wygrywa z usunięciem wariantu; stan bez zmian", () => {
    const draft = { ...open(A, "Kiedy?", "w 966 roku"), acceptedAnswers: ["w X wieku"] };
    const state = stateWith();
    const hint = submitWith(state, A, [draft], [variantsDone([false], { hint: { kind: "done", value: { verdict: "reveals", reason: "r" } } })]);
    expect(rejectedOf(hint.results[0])).toMatchObject({ kind: "hint", code: "hint_reveals_paraphrase" });
    expect(hint.state).toBe(state);
    const graded: OpenGraded = { answer: "druga", knowledge: "partial", missing: ["Odra"], wrong: [] };
    const openCheck = submitWith(state, A, [draft], [
      variantsDone([false], { open: { kind: "done", value: { answers: [{ ...graded, knowledge: "correct", missing: [] }, graded] } } }),
    ]);
    expect(rejectedOf(openCheck.results[0])).toMatchObject({ kind: "open", code: "open_not_accepted" });
    expect(openCheck.state).toBe(state);
  });

  it("typ w obu listach (przedmiot testowy): ocena przyjęta tylko dzięki usuniętemu wariantowi → unchecked", () => {
    // Przedmiot testowy sprawdza warianty wszystkich typów; tu także kontrolę otwartą pytania otwartego.
    const both = contextFor({ subject: withAgentPolicy(subject, { openAnswerCheckTypes: ["lesson_open_answer"] }) });
    const draft = { ...open(A, "Kiedy?", "w 966 roku"), acceptedAnswers: ["w X wieku"] };
    const correct = (answer: string): OpenGraded => ({ answer, knowledge: "correct", missing: [], wrong: [] });
    const viaRemoved = variantsDone([false], { open: { kind: "done", value: { answers: [correct("w 966 roku"), correct("w X wieku")] } } });
    const prechecked = precheckBatch(stateWith(), A, [draft], both);
    expect(acceptedOf(admitBatch(stateWith(), A, prechecked, [viaRemoved], both).results[0])).toMatchObject({
      unchecked: true,
      removedVariants: ["w X wieku"],
    });
    const viaKey = variantsDone([false], { open: { kind: "done", value: { answers: [correct("w 966 roku"), correct("966 rok")] } } });
    expect(acceptedOf(admitBatch(stateWith(), A, prechecked, [viaKey], both).results[0]).unchecked).toBe(false);
  });

  it("kroki deterministyczne powtórzone na oczyszczonym szkicu: reguła przedmiotu wymagająca wariantu daje rule_exercise", () => {
    const needsVariant = contextFor({
      subject: withAgentPolicy(
        { ...subject, validateExercise: (ex) => (ex.acceptedAnswers.length === 0 ? [testIssue("at least one variant", "acceptedAnswers is empty")] : []) },
        subject.agentPolicy,
      ),
    });
    const draft = { ...open(A, "Kiedy?", "w 966 roku"), acceptedAnswers: ["w X wieku"] };
    const prechecked = precheckBatch(stateWith(), A, [draft], needsVariant);
    expect(prechecked[0]).toMatchObject({ pass: true });
    const result = admitBatch(stateWith(), A, prechecked, [variantsDone([false])], needsVariant);
    expect(rejectedOf(result.results[0])).toMatchObject({
      kind: "rule",
      code: "rule_exercise",
      reasons: ["[test.issue] exercise: acceptedAnswers is empty"],
    });
  });

  it("usunięty wariant znosi ujawnienie: kandydat ofiarą przez wariant przyjęty po jego usunięciu", () => {
    const candidate = { ...open(A, "Kiedy był chrzest?", "Chrzest był w 966"), acceptedAnswers: ["w 966 roku"] };
    const empty = stateWith();
    const prechecked = precheckBatch(empty, A, [candidate], ctx);
    expect(prechecked[0]).toMatchObject({ pass: true });
    // Między precheck a admit inne wywołanie dodało zdanie równe wariantowi kandydata.
    const exposed = acceptAll(empty, A, [gap(A, "Mieszko przyjął chrzest ___.", "w 966 roku")]);
    expect(rejectedOf(admitBatch(exposed, A, prechecked, [variantsDone([true])], ctx).results[0])).toMatchObject({ code: "leak_victim" });
    const result = admitBatch(exposed, A, prechecked, [variantsDone([false])], ctx);
    expect(acceptedOf(result.results[0])).toMatchObject({ accepted: "ex2", removedVariants: ["w 966 roku"] });
    expect(poolOf(result.state, A).map((entry) => entry.draft.acceptedAnswers)).toEqual([[], []]);
  });
});

describe("admitBatch — sędzia podpowiedzi i kontrola otwarta (etap 2b)", () => {
  // Przedmiot testowy z dopiskami szkoły: decyzja zależy tylko od wyników kontroli.
  const school = withAgentPolicy(subject, { ruleNotes: schoolAgentPolicy.ruleNotes! });
  const schoolCtx = contextFor({ subject: school });
  const draft = open(A, "Kiedy?", "w 966 roku");
  const MISSING = "[check.open_answer] requiredElements: a correct answer that follows the question was not accepted";
  const WRONG = "[check.open_answer] requiredElements: an answer based on the material was graded as containing errors";

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

  const rejectedOf = (entry: unknown) => (entry as { rejected: Rejection }).rejected;

  it.each([
    ["unsupported", "hint_unsupported", "not supported by the material"],
    ["language", "hint_language", "not correct in the language of the instructions"],
    ["reveals", "hint_reveals_paraphrase", "giving away the answer or a required element in other words"],
  ] as const)("hint %s → odrzucenie hint/%s: reguła check.hint_judge i powód sędziego w jednym wierszu", (verdict, code, label) => {
    const { entry, state } = admitOne(draft, { hint: hintDone({ verdict, reason: "the hint says X" }) });
    const rejection = rejectedOf(entry);
    expect(rejection).toMatchObject({ kind: "hint", code, ruleIds: ["check.hint_judge"] });
    expect(rejection.reasons).toEqual([`[check.hint_judge] hint: the hint judge found the hint ${label}: the hint says X`]);
    expect(poolOf(state, A)).toHaveLength(0);
  });

  it("hint ok → przyjęte bez unchecked", () => {
    expect(admitOne(draft, { hint: hintDone({ verdict: "ok" }) }).entry).toEqual({ accepted: "ex1", sanitized: [], unchecked: false, notes: [], removedVariants: [], quotesSnapped: 0 });
  });

  it("open: obie odpowiedzi correct → przyjęte bez unchecked", () => {
    expect(admitOne(draft, { open: openDone(correct("a"), correct("b")) }).entry).toEqual({ accepted: "ex1", sanitized: [], unchecked: false, notes: [], removedVariants: [], quotesSnapped: 0 });
  });

  it("open: druga partial z missing → open_not_accepted (braki) z odpowiedzią drugiej i brakującym elementem", () => {
    const { entry, state } = admitOne(draft, { open: openDone(correct("Mieszko"), graded("partial", "Mieszko I przyjął chrzest.", ["Odra"])) });
    const rejection = rejectedOf(entry);
    expect(rejection).toMatchObject({ kind: "open", code: "open_not_accepted", ruleIds: ["check.open_answer"] });
    expect(rejection.reasons).toHaveLength(1);
    expect(rejection.reasons[0]!.startsWith(MISSING)).toBe(true);
    expect(rejection.reasons[0]).toContain('Answer: "Mieszko I przyjął chrzest."');
    expect(rejection.reasons[0]).toContain('Missing: "Odra"');
    expect(poolOf(state, A)).toHaveLength(0);
  });

  it("open: partial bez missing, ale z wrong → błędy ze stwierdzeniem", () => {
    const { entry } = admitOne(draft, { open: openDone(graded("partial", "Wisła płynie do Morza Czarnego.", [], ["Wisła płynie do Morza Czarnego"]), correct("b")) });
    const rejection = rejectedOf(entry);
    expect(rejection).toMatchObject({ kind: "open", code: "open_not_accepted" });
    expect(rejection.reasons[0]!.startsWith(WRONG)).toBe(true);
    expect(rejection.reasons[0]).toContain('Answer: "Wisła płynie do Morza Czarnego."');
    expect(rejection.reasons[0]).toContain('Errors: "Wisła płynie do Morza Czarnego"');
    expect(rejection.reasons[0]).not.toContain("Missing:");
  });

  it("open: partial z missing i wrong → błędy z obiema listami (błędy wygrywają z brakami)", () => {
    const { entry } = admitOne(draft, {
      open: openDone(graded("partial", "Mieszko I przyjął chrzest w 1000 roku.", ["Odra"], ["chrzest w 1000 roku"]), correct("b")),
    });
    const rejection = rejectedOf(entry);
    expect(rejection).toMatchObject({ kind: "open", code: "open_not_accepted" });
    expect(rejection.reasons).toHaveLength(1);
    expect(rejection.reasons[0]!.startsWith(WRONG)).toBe(true);
    expect(rejection.reasons[0]).toContain('Answer: "Mieszko I przyjął chrzest w 1000 roku."');
    expect(rejection.reasons[0]).toContain('Missing: "Odra"');
    expect(rejection.reasons[0]).toContain('Errors: "chrzest w 1000 roku"');
  });

  it("open: incorrect z samym missing → błędy z brakującym elementem, bez pustej listy błędów", () => {
    const { entry } = admitOne(draft, { open: openDone(graded("incorrect", "Bolesław Chrobry.", ["Mieszko I"]), correct("b")) });
    const rejection = rejectedOf(entry);
    expect(rejection).toMatchObject({ kind: "open", code: "open_not_accepted" });
    expect(rejection.reasons[0]!.startsWith(WRONG)).toBe(true);
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
    expect(rejection).toMatchObject({ kind: "hint", code: "hint_reveals_paraphrase", ruleIds: ["check.hint_judge", "check.open_answer"] });
    expect(rejection.reasons).toHaveLength(2);
    expect(rejection.reasons[0]!.startsWith("[check.hint_judge] hint:")).toBe(true);
    expect(rejection.reasons[1]!.startsWith(MISSING)).toBe(true);
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
      notes: [],
      removedVariants: [],
      quotesSnapped: 0,
    });
  });

  it("hint unavailable + open partial → odrzucenie (odrzucenie wygrywa z notą)", () => {
    const { entry } = admitOne(draft, { hint: { kind: "unavailable" }, open: openDone(graded("partial", "a", ["Odra"]), correct("b")) });
    expect(rejectedOf(entry)).toMatchObject({ kind: "open", code: "open_not_accepted" });
  });

  it("open unavailable → przyjęte z unchecked: true", () => {
    expect(admitOne(draft, { open: { kind: "unavailable" } }).entry).toEqual({ accepted: "ex1", sanitized: [], unchecked: true, notes: [], removedVariants: [], quotesSnapped: 0 });
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

describe("admitBatch — komunikat ślepego rozwiązania (spec katalogu reguł §4.4)", () => {
  const solveDone = (value: readonly string[]): CandidateChecks => ({ ...NA_CHECKS, solve: { kind: "done", value } });
  const blindReason = (draft: LessonExerciseDraft, answers: readonly string[], context = ctx) => {
    const prechecked = precheckBatch(stateWith(), A, [draft], context);
    expect(prechecked[0]).toMatchObject({ pass: true });
    const entry = admitBatch(stateWith(), A, prechecked, [solveDone(answers)], context).results[0]!;
    if (!("rejected" in entry)) throw new Error("expected blind_mismatch");
    expect(entry.rejected.code).toBe("blind_mismatch");
    return entry.rejected.reasons[0]!;
  };

  it("jedna odpowiedź: odpowiedź rozwiązującego, klucz i warianty", () => {
    const draft = { ...open(A, "Kiedy?", "w 966 roku"), acceptedAnswers: ["966"] };
    expect(blindReason(draft, ["w 1000 roku"])).toBe(
      '[check.blind_solve] answer: the solver answered "w 1000 roku"; the key is "w 966 roku", accepted variants "966"',
    );
  });

  it("inna liczba odpowiedzi: obie liczby i klucz", () => {
    expect(blindReason(choice(A, 1), ["odpowiedź 1", "dystraktor 1"])).toBe(
      '[check.blind_solve] answer: the solver gave 2 answers ("odpowiedź 1", "dystraktor 1") where the key has 1 ("odpowiedź 1")',
    );
  });
  // Pary, grupy i luki z bankiem (pozycja po pozycji): `solver.test.ts`, `blindMismatchFound`.
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

describe("precheckBatch i admitBatch — sanityzacja szkoły (spec katalogu reguł §5.1–5.2)", () => {
  const OBJECTIVE = "school.ddeck.mierzeje";
  const material = "Mierzeja Wiślana to „piaszczysty” pas lądu – między Zatoką Gdańską a Zalewem Wiślanym.";
  const topic = schoolSubject.buildDynamicTopic!({
    titlePl: "Geografia",
    objectives: [{
      id: OBJECTIVE,
      titlePl: "Mierzeje",
      descriptionEn: "Spits.",
      cards: [{ title: "Mierzeja", body: "Pas lądu oddziela zalew od morza." }, { title: "Gdzie?", body: "Nad Bałtykiem." }],
    }],
  });
  const state = () => createLessonAgentState({ topic, objectives: agentObjectivesOf(topic), fixed: [], examples: {}, fixedSources: {} });
  const context: AgentCheckContext = {
    subject: schoolSubject,
    material,
    limits: new Map([[OBJECTIVE, { targetCount: 8, listenAllowance: 0, maxExercises: 10 }]]),
  };
  const openAnswer = (overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft => ({
    exerciseType: "lesson_open_answer",
    objectiveId: OBJECTIVE,
    prompt: "Podaj przykład mierzei.",
    answer: "Mierzeja Wiślana",
    acceptedAnswers: [],
    focus: ["Mierzeja"],
    questionType: "fact",
    requiredElements: [{ id: "e1", text: "Mierzeja Wiślana" }],
    expectedForm: "short",
    sourceRefs: [{ quote: "Mierzeja Wiślana to \"piaszczysty\" pas lądu - między" }],
    ...overrides,
  });

  it("podpowiedź zdradzająca odpowiedź: ćwiczenie przechodzi bez podpowiedzi, z notą reguły", () => {
    const prechecked = precheckBatch(state(), OBJECTIVE, [openAnswer({ hint: "Przykładem jest Mierzeja Wiślana" })], context);
    expect(prechecked[0]).toMatchObject({ pass: true, sanitized: ["hint"], quotesSnapped: 1 });
    const notes = (prechecked[0] as { notes: readonly LessonRuleIssue[] }).notes;
    expect(notes.map(formatRuleReason)).toEqual([
      '[hint.reveals_words] hint: removed: shares "wiślana" with the answer "Mierzeja Wiślana"; the exercise is in the pool ' +
        "without a hint (to give it a safe hint, remove_exercise it and submit it again)",
    ]);
    const admitted = admitBatch(state(), OBJECTIVE, prechecked, [NA_CHECKS], context);
    expect(admitted.results[0]).toEqual({ accepted: "ex1", sanitized: ["hint"], unchecked: false, notes, removedVariants: [], quotesSnapped: 1 });
    expect(poolOf(admitted.state, OBJECTIVE)[0]!.draft).not.toHaveProperty("hint");
  });

  it("podpowiedź kierująca rozumowaniem zostaje, a ćwiczenie bez not", () => {
    const prechecked = precheckBatch(state(), OBJECTIVE, [openAnswer({ hint: "Pomyśl o pasie lądu nad Bałtykiem." })], context);
    expect(prechecked[0]).toMatchObject({ pass: true, sanitized: [], notes: [], draft: { hint: "Pomyśl o pasie lądu nad Bałtykiem." } });
  });

  it("cytat różniący się cudzysłowem i myślnikiem przechodzi i trafia do puli jako tekst materiału", () => {
    const prechecked = precheckBatch(state(), OBJECTIVE, [openAnswer()], context);
    const admitted = admitBatch(state(), OBJECTIVE, prechecked, [NA_CHECKS], context);
    expect(admitted.results[0]).toMatchObject({ accepted: "ex1", quotesSnapped: 1 });
    expect(poolOf(admitted.state, OBJECTIVE)[0]!.draft.sourceRefs).toEqual([{ quote: "Mierzeja Wiślana to „piaszczysty” pas lądu – między" }]);
  });
});
