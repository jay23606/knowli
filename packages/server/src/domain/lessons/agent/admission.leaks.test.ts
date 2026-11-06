import { describe, expect, it } from "vitest";
import { englishNormalizer } from "../subjects/english/normalizer";
import { A, B, contextFor, gap, naChecks, open, stateWith, subject } from "../testing/agent-admission-fixtures";
import type { LessonExerciseDraft } from "../types";
import { admitBatch, precheckBatch, submitExamples, type AdmitEntry } from "./admission";
import { poolOf, type LessonAgentState } from "./state";

const ctx = contextFor();

function submit(state: LessonAgentState, objectiveId: string, drafts: readonly LessonExerciseDraft[]) {
  const prechecked = precheckBatch(state, objectiveId, drafts, ctx);
  return admitBatch(state, objectiveId, prechecked, naChecks(drafts.length), ctx);
}

function acceptAll(state: LessonAgentState, objectiveId: string, drafts: readonly LessonExerciseDraft[]): LessonAgentState {
  const result = submit(state, objectiveId, drafts);
  for (const entry of result.results) expect(entry).toHaveProperty("accepted");
  return result.state;
}

function rejectionOf(entry: AdmitEntry | undefined) {
  if (entry === undefined || !("rejected" in entry)) throw new Error(`expected rejection, got ${JSON.stringify(entry)}`);
  return entry.rejected;
}

describe("przyjmowanie paczki — ujawnienia (tryb generation)", () => {
  it("kandydat samodzielny równy przykładowi karty: leak_victim z tekstem polityki i przykładem", () => {
    const state = stateWith({ examples: { [A]: ["w 966 roku"] } });
    const rejection = rejectionOf(submit(state, A, [open(A, "Kiedy?", "w 966 roku")]).results[0]);
    expect(rejection.kind).toBe("leak");
    expect(rejection.code).toBe("leak_victim");
    expect(rejection.reasons[0]).toMatch(/^leak victim /);
    expect(rejection.reasons[0]).toContain('the card example "w 966 roku"');
  });

  it("stałe źródło (fixedSources) innego zagadnienia też ujawnia: leak_victim", () => {
    const state = stateWith({ fixedSources: { [B]: ["w 966 roku"] } });
    expect(rejectionOf(submit(state, A, [open(A, "Kiedy?", "w 966 roku")]).results[0]).code).toBe("leak_victim");
  });

  it("niesamodzielny kandydat ujawniający przyjęte samodzielne: leak_source z identyfikatorem ofiary", () => {
    const state = acceptAll(stateWith(), A, [open(A, "Rok chrztu?", "966")]);
    const rejection = rejectionOf(submit(state, A, [gap(A, "Chrzest Polski w roku ___.", "966")]).results[0]);
    expect(rejection).toMatchObject({ kind: "leak", code: "leak_source" });
    expect(rejection.reasons[0]).toMatch(/^leak source /);
    expect(rejection.reasons[0]).toContain('exercise ex1 "966"');
  });

  it("niesamodzielny kandydat ujawniający samodzielne fixed: leak_source", () => {
    const state = stateWith({ fixed: [open(A, "Rok chrztu?", "966")] });
    const rejection = rejectionOf(submit(state, A, [gap(A, "Chrzest Polski w roku ___.", "966")]).results[0]);
    expect(rejection.code).toBe("leak_source");
    expect(rejection.reasons[0]).toContain('an existing exercise "966"');
  });

  it("samodzielny z odpowiedzią przyjętego samodzielnego wcześniejszego w lekcji: leak_victim (miękkie)", () => {
    const state = acceptAll(stateWith(), A, [open(A, "Rok chrztu?", "966")]);
    const rejection = rejectionOf(submit(state, B, [open(B, "Rok, w którym rządził Mieszko?", "966")]).results[0]);
    expect(rejection.code).toBe("leak_victim");
    expect(rejection.reasons[0]).toContain('an earlier independent exercise "966"');
  });

  it("samodzielny wstawiony przed przyjętym samodzielnym z tą samą odpowiedzią (wcześniejsze zagadnienie): leak_source", () => {
    const state = acceptAll(stateWith(), B, [open(B, "Rok, w którym rządził Mieszko?", "966")]);
    const rejection = rejectionOf(submit(state, A, [open(A, "Rok chrztu?", "966")]).results[0]);
    expect(rejection.code).toBe("leak_source");
    expect(rejection.reasons[0]).toContain('exercise ex1 "966"');
  });

  it("ofiara ujawniona już przed kandydatem nie odrzuca kandydata", () => {
    const state = stateWith({ examples: { [A]: ["966"] }, fixed: [open(A, "Rok chrztu?", "966")] });
    const result = submit(state, A, [gap(A, "Chrzest Polski w roku ___.", "966")]);
    expect(result.results[0]).toEqual({ accepted: "ex1", sanitized: [], unchecked: false });
    expect(poolOf(result.state, A)).toHaveLength(1);
  });

  it("drugi kandydat paczki widzi pierwszego: ujawnienie wewnątrz paczki odpada już w precheckBatch", () => {
    const prechecked = precheckBatch(stateWith(), A, [open(A, "Rok chrztu?", "966"), gap(A, "Chrzest Polski w roku ___.", "966")], ctx);
    expect(prechecked.map((entry) => (entry.pass ? "pass" : entry.rejection.code))).toEqual(["pass", "leak_source"]);
  });

  describe("rodzina pytań otwartych (ta sama odpowiedź wzorcowa)", () => {
    const ANSWER = "w 966 roku";
    const member = (objectiveId: string, n: number, familyId?: string) => open(objectiveId, `Pytanie rodziny numer ${n}: kiedy był chrzest?`, ANSWER, familyId);

    it("ofiara: kolejne pytania tej samej rodziny przyjęte (w osobnych wywołaniach i w jednej paczce)", () => {
      const state = acceptAll(stateWith(), A, [member(A, 1, "f1")]);
      const next = acceptAll(state, A, [member(A, 2, "f1"), member(A, 3, "f1")]);
      expect(poolOf(next, A).map((entry) => entry.draft.prompt)).toHaveLength(3);
    });

    it("źródło: pytanie rodziny przed istniejącym pytaniem z tą samą nazwą rodziny w innym zagadnieniu — nadal leak_source", () => {
      // Ta sama nazwa rodziny w innym zagadnieniu to inna rodzina: wyjątek nie obejmuje kierunku źródła między zagadnieniami.
      const state = acceptAll(stateWith(), B, [member(B, 1, "f1")]);
      const rejection = rejectionOf(submit(state, A, [member(A, 2, "f1")]).results[0]);
      expect(rejection.code).toBe("leak_source");
    });

    it("źródło: pytanie rodziny przyjęte nie staje się nową ofiarą — późniejsze źródło niesamodzielne nadal leak_source", () => {
      const state = acceptAll(stateWith(), A, [member(A, 1, "f1"), member(A, 2, "f1")]);
      const rejection = rejectionOf(submit(state, A, [gap(A, "Chrzest Polski odbył się ___.", ANSWER)]).results[0]);
      expect(rejection.code).toBe("leak_source");
      // Obie ofiary (całą rodzinę) model dostaje w powodach.
      expect(rejection.reasons).toHaveLength(2);
    });

    it("inna rodzina albo brak rodziny w tym samym zagadnieniu: leak_victim (miękkie)", () => {
      const withFamily = acceptAll(stateWith(), A, [member(A, 1, "f1")]);
      expect(rejectionOf(submit(withFamily, A, [member(A, 2, "f2")]).results[0]).code).toBe("leak_victim");
      expect(rejectionOf(submit(withFamily, A, [member(A, 2)]).results[0]).code).toBe("leak_victim");
      const withoutFamily = acceptAll(stateWith(), A, [member(A, 1)]);
      expect(rejectionOf(submit(withoutFamily, A, [member(A, 2, "f1")]).results[0]).code).toBe("leak_victim");
    });

    it("źródło twarde: przykład karty równy odpowiedzi rodziny odrzuca każde pytanie rodziny (leak_victim)", () => {
      const state = stateWith({ examples: { [A]: [ANSWER] } });
      const result = submit(state, A, [member(A, 1, "f1"), member(A, 2, "f1")]);
      expect(result.results.map((entry) => rejectionOf(entry).code)).toEqual(["leak_victim", "leak_victim"]);
    });

    it("przykład karty zgłoszony po przyjęciu rodziny: odrzucony z oboma pytaniami rodziny jako ofiarami", () => {
      const state = acceptAll(stateWith(), A, [member(A, 1, "f1"), member(A, 2, "f1")]);
      const outcome = submitExamples(state, A, [ANSWER], ctx);
      expect(outcome.accepted).toBe(0);
      expect(outcome.errors).toHaveLength(2);
    });
  });

  describe("równoważność odpowiedzi (normalizator przedmiotu i warianty ofiary)", () => {
    // Przedmiot testowy z normalizatorem angielskim: skróty („where's”, „it's”) mają rozwinięcia.
    const englishCtx = contextFor({ subject: { ...subject, normalizer: englishNormalizer } });
    const submitEn = (state: LessonAgentState, objectiveId: string, drafts: readonly LessonExerciseDraft[]) =>
      admitBatch(state, objectiveId, precheckBatch(state, objectiveId, drafts, englishCtx), naChecks(drafts.length), englishCtx);
    const withVariants = (draft: LessonExerciseDraft, acceptedAnswers: string[]): LessonExerciseDraft => ({ ...draft, acceptedAnswers });

    it("forma skrócona przykładu karty wobec pełnej formy świeżego tłumaczenia (i odwrotnie): leak_victim", () => {
      const short = stateWith({ examples: { [A]: ["Where's the box?"] } });
      expect(rejectionOf(submitEn(short, A, [open(A, "Gdzie jest pudełko?", "Where is the box?")]).results[0]).code).toBe("leak_victim");
      const full = stateWith({ fixedSources: { [B]: ["Where is the box?"] } });
      expect(rejectionOf(submitEn(full, A, [open(A, "Gdzie jest pudełko?", "Where's the box?")]).results[0]).code).toBe("leak_victim");
    });

    it("wariant odpowiedzi świeżego kandydata równy zdaniu wcześniejszego ćwiczenia: odrzucony (leak_victim)", () => {
      const state = acceptAll(stateWith(), A, [gap(A, "Mieszko przyjął chrzest ___.", "w 966 roku")]);
      const rejection = rejectionOf(submit(state, A, [withVariants(open(A, "Kiedy był chrzest?", "Chrzest był w 966"), ["w 966 roku"])]).results[0]);
      expect(rejection.code).toBe("leak_victim");
      // Wariant równy przykładowi karty — też (źródło twarde).
      const example = stateWith({ examples: { [B]: ["It is a spider."] } });
      expect(rejectionOf(submitEn(example, A, [withVariants(open(A, "Co to jest?", "This is a spider"), ["It's a spider"])]).results[0]).code).toBe("leak_victim");
    });

    it("niesamodzielny kandydat, którego zdanie równa się wariantowi przyjętego tłumaczenia: leak_source", () => {
      const state = acceptAll(stateWith(), A, [withVariants(open(A, "Kiedy był chrzest?", "Chrzest był w 966"), ["w 966 roku"])]);
      expect(rejectionOf(submit(state, A, [gap(A, "Mieszko przyjął chrzest ___.", "w 966 roku")]).results[0]).code).toBe("leak_source");
    });

    it("zdania niezwiązane (inne słowa, inne warianty) nadal przyjęte", () => {
      const state = stateWith({ examples: { [A]: ["Where's the box?"] } });
      const next = submitEn(state, A, [
        gap(A, "The ___ is on the bed.", "box"),
        withVariants(open(A, "Gdzie jest łóżko?", "Where is the bed?"), ["The bed is where?"]),
      ]);
      expect(next.results.map((entry) => ("accepted" in entry ? "accepted" : rejectionOf(entry).code))).toEqual(["accepted", "accepted"]);
      const other = submitEn(next.state, B, [open(B, "Co jest na łóżku?", "The box is on the bed")]);
      expect(other.results[0]).toHaveProperty("accepted");
    });

    it("rodzina pytań otwartych: rodzeństwo z odpowiedzią w formie skróconej przyjęte, pytanie spoza rodziny — leak_victim", () => {
      const member = (n: number, familyId?: string, answer = "It is a spider") => open(A, `Pytanie rodziny numer ${n}: co to jest?`, answer, familyId);
      const state = submitEn(stateWith(), A, [member(1, "f1")]).state;
      const siblings = submitEn(state, A, [member(2, "f1", "It's a spider"), member(3, "f1")]);
      expect(siblings.results.map((entry) => ("accepted" in entry ? "accepted" : rejectionOf(entry).code))).toEqual(["accepted", "accepted"]);
      expect(poolOf(siblings.state, A)).toHaveLength(3);
      const outsider = { ...member(4), prompt: "Pytanie spoza rodziny: co to jest?", answer: "It's a spider" };
      expect(rejectionOf(submitEn(siblings.state, A, [outsider]).results[0]).code).toBe("leak_victim");
    });

    it("przykład karty w formie skróconej zgłoszony po przyjęciu tłumaczenia w pełnej formie: odrzucony", () => {
      const state = submitEn(stateWith(), A, [open(A, "Gdzie jest pudełko?", "Where is the box?")]).state;
      expect(poolOf(state, A)).toHaveLength(1);
      const outcome = submitExamples(state, A, ["Where's the box?", "The box is on the bed."], englishCtx);
      expect(outcome.accepted).toBe(1);
      expect(outcome.errors).toHaveLength(1);
      expect(outcome.errors[0]).toContain(`"Where's the box?"`);
    });
  });
});
