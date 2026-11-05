import { describe, expect, it } from "vitest";
import { A, B, contextFor, gap, naChecks, open, stateWith } from "../testing/agent-admission-fixtures";
import type { LessonExerciseDraft } from "../types";
import { admitBatch, precheckBatch, type AdmitEntry } from "./admission";
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

describe("przyjmowanie paczki — ujawnienia (tryb coverage)", () => {
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
});
