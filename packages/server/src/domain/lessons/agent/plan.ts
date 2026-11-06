import { z } from "zod";
import type { RawPlanObjective, SubjectModule } from "../types";

/**
 * Walidacja planu zagadnień od agenta-planisty (spec §3.8): kształt, slugi,
 * liczba zagadnień, karty i przykłady, potem `planGate` przedmiotu. Funkcja
 * NIE składa tematu — identyfikatory i przycinanie nadaje kierownik.
 */

export const AGENT_PLAN_MIN_OBJECTIVES = 3;
export const AGENT_PLAN_MAX_OBJECTIVES = 6;

const MIN_CARDS = 2;
const MAX_CARDS = 4;
const MAX_EXAMPLES = 3;

/** Ta sama reguła co `sanitizeObjectiveSlug` (ASCII, małe litery, cyfry, `_`, do 40 znaków). */
const SLUG_PATTERN = /^[a-z0-9_]{1,40}$/;

const text = z.string().trim().min(1, "must not be empty");

const objectiveSchema = z.object({
  slug: z.string(),
  titlePl: text,
  descriptionEn: text,
  kind: z.enum(["words", "frame"]),
  cards: z.array(z.object({ title: text, body: text })),
  examples: z.array(z.string()),
});

const planShape = z.object({ objectives: z.array(z.unknown()) });

function issuePath(path: readonly PropertyKey[]): string {
  return path.map(String).join(".");
}

function objectiveErrors(raw: unknown, number: number): string[] {
  const label = `objective ${number}`;
  const parsed = objectiveSchema.safeParse(raw);
  const errors = parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${label}: ${issuePath(issue.path)}: ${issue.message}`);
  const candidate = (typeof raw === "object" && raw !== null ? raw : {}) as { cards?: unknown; examples?: unknown };
  if (Array.isArray(candidate.cards) && (candidate.cards.length < MIN_CARDS || candidate.cards.length > MAX_CARDS)) {
    errors.push(`${label}: cards: ${candidate.cards.length}, allowed ${MIN_CARDS}-${MAX_CARDS}`);
  }
  if (Array.isArray(candidate.examples) && candidate.examples.length > MAX_EXAMPLES) {
    errors.push(`${label}: examples: ${candidate.examples.length}, allowed at most ${MAX_EXAMPLES}`);
  }
  return errors;
}

export function validateAgentPlan(
  raw: unknown,
  subject: SubjectModule,
  material: string,
): { ok: true; objectives: RawPlanObjective[] } | { ok: false; errors: string[] } {
  const shape = planShape.safeParse(raw);
  if (!shape.success) return { ok: false, errors: ["plan must be an object with an objectives array"] };
  const items = shape.data.objectives;
  const errors: string[] = [];
  if (items.length < AGENT_PLAN_MIN_OBJECTIVES || items.length > AGENT_PLAN_MAX_OBJECTIVES) {
    errors.push(`objectives: ${items.length}, allowed ${AGENT_PLAN_MIN_OBJECTIVES}-${AGENT_PLAN_MAX_OBJECTIVES}`);
  }
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const number = index + 1;
    errors.push(...objectiveErrors(item, number));
    const slug = (item as { slug?: unknown } | null)?.slug;
    if (typeof slug !== "string") return;
    if (!SLUG_PATTERN.test(slug)) {
      errors.push(`objective ${number}: slug: "${slug}" must match [a-z0-9_] and be 1-40 characters`);
    } else if (seen.has(slug)) {
      errors.push(`objective ${number}: duplicate slug "${slug}"`);
    }
    seen.add(slug);
  });
  if (errors.length > 0) return { ok: false, errors };
  const objectives = items as RawPlanObjective[];
  const gateErrors = subject.agentPolicy.planGate?.(objectives, material) ?? [];
  if (gateErrors.length > 0) return { ok: false, errors: gateErrors };
  return { ok: true, objectives };
}
