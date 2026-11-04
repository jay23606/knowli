import { describe, expect, it } from "vitest";
import { agentTestSubject, withAgentPolicy } from "../testing/agent-test-subject";
import type { RawPlanObjective } from "../types";
import { AGENT_PLAN_MAX_OBJECTIVES, AGENT_PLAN_MIN_OBJECTIVES, validateAgentPlan } from "./plan";

function objective(n: number, overrides: Partial<RawPlanObjective> = {}): RawPlanObjective {
  return {
    slug: `zagadnienie_${n}`,
    titlePl: `Zagadnienie ${n}`,
    descriptionEn: `Objective ${n}.`,
    kind: "words",
    cards: [
      { title: "Karta 1", body: "Treść pierwszej karty." },
      { title: "Karta 2", body: "Treść drugiej karty." },
    ],
    examples: ["Przykład."],
    ...overrides,
  };
}

function plan(count: number): { objectives: RawPlanObjective[] } {
  return { objectives: Array.from({ length: count }, (_unused, index) => objective(index + 1)) };
}

function errorsOf(result: ReturnType<typeof validateAgentPlan>): string[] {
  if (result.ok) throw new Error("expected errors");
  return result.errors;
}

describe("validateAgentPlan", () => {
  it("stałe: 3–6 zagadnień", () => {
    expect([AGENT_PLAN_MIN_OBJECTIVES, AGENT_PLAN_MAX_OBJECTIVES]).toEqual([3, 6]);
  });

  it.each([3, 6])("%i zagadnień przechodzi", (count) => {
    expect(validateAgentPlan(plan(count), agentTestSubject, "materiał")).toEqual({ ok: true, objectives: plan(count).objectives });
  });

  it.each([2, 7])("%i zagadnień → `objectives: N, allowed 3-6`", (count) => {
    expect(errorsOf(validateAgentPlan(plan(count), agentTestSubject, ""))).toContain(`objectives: ${count}, allowed 3-6`);
  });

  it("zły kształt całości", () => {
    expect(errorsOf(validateAgentPlan(null, agentTestSubject, ""))).toHaveLength(1);
    expect(errorsOf(validateAgentPlan({ objectives: "x" }, agentTestSubject, ""))).toHaveLength(1);
  });

  it("slug niezgodny z regułą (znaki spoza a-z0-9_, pusty, za długi) → błąd z numerem zagadnienia", () => {
    for (const slug of ["Łóżko", "", "a".repeat(41), "z spacją"]) {
      const raw = plan(3);
      raw.objectives[1] = objective(2, { slug });
      const errors = errorsOf(validateAgentPlan(raw, agentTestSubject, ""));
      expect(errors.some((error) => error.startsWith("objective 2") && error.includes("slug"))).toBe(true);
    }
  });

  it("duplikat sluga → błąd wskazujący zagadnienie", () => {
    const raw = plan(3);
    raw.objectives[2] = objective(3, { slug: raw.objectives[0]!.slug });
    const errors = errorsOf(validateAgentPlan(raw, agentTestSubject, ""));
    expect(errors.some((error) => error.startsWith("objective 3") && error.includes("duplicate slug"))).toBe(true);
  });

  it.each([1, 5])("%i kart → błąd", (count) => {
    const raw = plan(3);
    raw.objectives[0] = objective(1, { cards: Array.from({ length: count }, (_unused, index) => ({ title: `T${index}`, body: `B${index}` })) });
    const errors = errorsOf(validateAgentPlan(raw, agentTestSubject, ""));
    expect(errors.some((error) => error.startsWith("objective 1") && error.includes("cards") && error.includes("2-4"))).toBe(true);
  });

  it("4 przykłady → błąd, 3 przechodzą", () => {
    const raw = plan(3);
    raw.objectives[0] = objective(1, { examples: ["a", "b", "c", "d"] });
    const errors = errorsOf(validateAgentPlan(raw, agentTestSubject, ""));
    expect(errors.some((error) => error.startsWith("objective 1") && error.includes("examples"))).toBe(true);
    raw.objectives[0] = objective(1, { examples: ["a", "b", "c"] });
    expect(validateAgentPlan(raw, agentTestSubject, "").ok).toBe(true);
  });

  it("brak `kind` albo nieznany → błąd", () => {
    for (const kind of [undefined, "other"]) {
      const raw = { objectives: plan(3).objectives.map((item, index) => (index === 1 ? { ...item, kind } : item)) };
      const errors = errorsOf(validateAgentPlan(raw, agentTestSubject, ""));
      expect(errors.some((error) => error.startsWith("objective 2") && error.includes("kind"))).toBe(true);
    }
  });

  it("puste teksty tytułu i karty → błędy", () => {
    const raw = plan(3);
    raw.objectives[0] = objective(1, { titlePl: "  ", cards: [{ title: "T", body: "" }, { title: "T2", body: "B2" }] });
    const errors = errorsOf(validateAgentPlan(raw, agentTestSubject, ""));
    expect(errors.filter((error) => error.startsWith("objective 1")).length).toBeGreaterThanOrEqual(2);
  });

  it("planGate przedmiotu dostaje poprawny plan i materiał; jego błędy są zwracane", () => {
    const seen: { slugs: string[]; material: string }[] = [];
    const subject = withAgentPolicy(agentTestSubject, {
      planGate: (items, material) => {
        seen.push({ slugs: items.map((item) => item.slug), material });
        return ["plan misses the word cat"];
      },
    });
    expect(errorsOf(validateAgentPlan(plan(3), subject, "MATERIAL"))).toEqual(["plan misses the word cat"]);
    expect(seen).toEqual([{ slugs: ["zagadnienie_1", "zagadnienie_2", "zagadnienie_3"], material: "MATERIAL" }]);
  });

  it("planGate nie jest wołany, gdy plan ma błędy kształtu", () => {
    let called = false;
    const subject = withAgentPolicy(agentTestSubject, {
      planGate: () => {
        called = true;
        return [];
      },
    });
    validateAgentPlan(plan(2), subject, "");
    expect(called).toBe(false);
  });
});
