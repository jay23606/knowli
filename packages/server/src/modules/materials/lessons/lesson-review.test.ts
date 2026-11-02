import { afterEach, describe, expect, it, vi } from "vitest";
import { createProductionSubjectRegistry } from "../../../domain/lessons/subjects";
import { exerciseSnippet } from "../../../domain/lessons/review-report";
import type { LessonExerciseDraft } from "../../../domain/lessons/types";
import type { ReviewerDeps } from "../../../config";
import { GenerationProviderError } from "../../../ports/generation-error";
import { FakeLessonReviewer, FakeLlmProvider } from "../../../providers/fake";
import { buildLessonPayload, buildPoolInput, type ObjectiveGenerationLimits } from "./lesson-drafts";
import { LessonGenerationCancelledError } from "./lesson-generation-control";
import { acceptFreshLessonPool } from "./lesson-pool-acceptance";
import { exerciseFingerprint, reviewFreshExercises } from "./lesson-review";

const registry = createProductionSubjectRegistry();
const subject = registry.getSubject("english_grammar")!;
const topic = registry.getLatestTopic("english_grammar", "present_simple")!;
const MATERIAL = "He plays football. She watches TV. They study English every day.";
const OBJECTIVES = topic.objectives.slice(0, 4).map((objective) => objective.id);
const POLICY = { timeoutMs: 60_000, concurrency: 3, maxCallsPerRun: 12, phaseBudgetMs: 240_000 };

/** Świeża pula fake'a gramatyki po walidacji (jak partia główna). */
async function freshPool(objectiveIds: readonly string[] = OBJECTIVES.slice(0, 1)): Promise<LessonExerciseDraft[]> {
  const llm = new FakeLlmProvider();
  const raw: unknown[] = [];
  const limits = new Map<string, ObjectiveGenerationLimits>();
  for (const objectiveId of objectiveIds) {
    const input = buildPoolInput(subject, topic, objectiveId, 8, MATERIAL, undefined, false, [], []);
    limits.set(objectiveId, { count: 8, listen: input.listenChoicePerObjective ?? 0 });
    raw.push(...(await llm.generateLessonPool(input)).exercises);
  }
  return acceptFreshLessonPool({
    rawExercises: raw, subject, topic, material: MATERIAL, familyScope: null, existingDrafts: [],
    existingAnswers: new Set(), existingExerciseIdentities: new Set(), objectiveLimits: limits,
  }).accepted;
}

function ready(reviewer: FakeLessonReviewer, policy: Partial<ReviewerDeps["policy"]> = {}): ReviewerDeps {
  return { state: "ready", provider: reviewer, policy: { ...POLICY, ...policy } };
}

function ctx(reviewer: ReviewerDeps | undefined, fresh: readonly LessonExerciseDraft[], overrides: Record<string, unknown> = {}) {
  return {
    reviewer,
    subject,
    topic,
    material: MATERIAL,
    fresh,
    existing: [] as LessonExerciseDraft[],
    examples: {} as Record<string, string[]>,
    objectiveOrder: OBJECTIVES,
    objectiveContext: (objectiveId: string) => ({ title: `Tytuł ${objectiveId.split(".").at(-1)}`, card: "Karta: treść" }),
    familyScope: null,
    callsLeft: { value: 12 },
    reviewDeadlineAtMs: Date.now() + 60_000,
    cancelPollMs: 1_000,
    assertCurrent: async () => true,
    runId: "run-1",
    ...overrides,
  };
}

/** Ćwiczenie w kształcie krytyka (wejście `exercises[n-1].exercise`). */
function shownExercise(reviewer: FakeLessonReviewer, call: number, n: number): Record<string, unknown> {
  return { ...reviewer.inputs[call]!.exercises[n - 1]!.exercise };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("exerciseFingerprint", () => {
  it("nie zależy od kolejności kluczy (także zagnieżdżonych) ani od pól undefined; przetrwa JSON jak jsonb", () => {
    const a = { b: 1, a: { y: [1, { q: 2, p: 1 }], x: "t" }, c: undefined };
    const b = { a: { x: "t", y: [1, { p: 1, q: 2 }] }, b: 1 };
    expect(exerciseFingerprint(a)).toBe(exerciseFingerprint(b));
    expect(exerciseFingerprint(JSON.parse(JSON.stringify(a)) as Record<string, unknown>)).toBe(exerciseFingerprint(a));
    expect(exerciseFingerprint({ ...b, b: 2 })).not.toBe(exerciseFingerprint(b));
    expect(exerciseFingerprint(a)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("kolejność elementów tablic ma znaczenie", () => {
    expect(exerciseFingerprint({ list: [1, 2] })).not.toBe(exerciseFingerprint({ list: [2, 1] }));
  });
});

describe("reviewFreshExercises", () => {
  it("krytyk niegotowy: świeże bez zmian, zagadnienia unreviewed z powodem, bez wywołań", async () => {
    const fresh = await freshPool(OBJECTIVES.slice(0, 2));
    const reviewer = new FakeLessonReviewer();
    for (const [deps, reason] of [
      [undefined, "disabled"],
      [{ state: "disabled", provider: reviewer, policy: POLICY }, "disabled"],
      [{ state: "not_configured", policy: POLICY }, "not_configured"],
    ] as const) {
      const result = await reviewFreshExercises(ctx(deps, fresh));
      expect(result.exercises).toEqual(fresh);
      result.exercises.forEach((exercise, index) => expect(exercise).toBe(fresh[index]));
      expect(result.objectives).toEqual(OBJECTIVES.slice(0, 2).map((objectiveId) => ({ objectiveId, status: "unreviewed", reason })));
      expect(result.meta.size).toBe(0);
      expect(result.droppedCount).toBe(0);
    }
    expect(reviewer.inputs).toHaveLength(0);
  });

  it("wszystko ok: te same obiekty, zagadnienia reviewed, wspólny blok przykładów kart dla wszystkich wywołań", async () => {
    const fresh = await freshPool(OBJECTIVES.slice(0, 3));
    const reviewer = new FakeLessonReviewer();
    const examples = { [OBJECTIVES[1]!]: ["She plays."], [OBJECTIVES[0]!]: ["He plays."] };
    const result = await reviewFreshExercises(ctx(ready(reviewer), fresh, { examples }));
    result.exercises.forEach((exercise, index) => expect(exercise).toBe(fresh[index]));
    expect(result.objectives.map((objective) => objective.status)).toEqual(["reviewed", "reviewed", "reviewed"]);
    expect(reviewer.inputs).toHaveLength(3);
    const blocks = reviewer.inputs.map((input) => JSON.stringify(input.cardExamples));
    expect(new Set(blocks).size).toBe(1);
    // Kolejność kluczy = kolejność zagadnień lekcji, nie kolejność wstawienia.
    // Krytyk widzi aliasy zagadnień (ostatni człon identyfikatora).
    expect(Object.keys(reviewer.inputs[0]!.cardExamples).slice(0, 2)).toEqual(["affirmative_base", "third_person_s"]);
    expect(reviewer.inputs[0]!.objective.id).toBe("affirmative_base");
    expect(JSON.stringify(reviewer.inputs)).not.toContain("english_grammar.present_simple.");
    // Bez identyfikatorów bazy i locale w kształcie ćwiczenia; numeracja 1…N.
    const input = reviewer.inputs[0]!;
    expect(input.exercises.map((exercise) => exercise.n)).toEqual(input.exercises.map((_exercise, index) => index + 1));
    expect(input.exercises[0]!.exercise).not.toHaveProperty("answerLocale");
    // Gramatyka z katalogu: MATERIAL to opis tematu, nie materiał przebiegu.
    expect(input.material).toContain(topic.titlePl);
    expect(input.material).not.toContain("He plays football.");
  });

  it("pierwsze wywołanie samo, kolejne równolegle najwyżej do concurrency", async () => {
    const fresh = await freshPool(OBJECTIVES);
    const reviewer = new FakeLessonReviewer();
    reviewer.delayMs = 20;
    const inFlightAtStart: number[] = [];
    reviewer.behavior = (input) => {
      inFlightAtStart.push(reviewer.maxInFlight);
      return input.exercises.map((exercise) => ({ n: exercise.n, verdict: "ok" }));
    };
    await reviewFreshExercises(ctx(ready(reviewer, { concurrency: 2 }), fresh));
    expect(reviewer.inputs.map((input) => input.objective.id)[0]).toBe("affirmative_base");
    expect(inFlightAtStart[0]).toBe(1);
    expect(reviewer.maxInFlight).toBe(2);
  });

  it("nieczytelne werdykty są pomijane (ćwiczenie zostaje), a log zlicza je bez treści", async () => {
    const fresh = await freshPool();
    const reviewer = new FakeLessonReviewer();
    reviewer.behavior = () => [
      { n: 1, verdict: "drop", category: "wrong_answer", reasonPl: "x".repeat(121) },
      { n: 2, verdict: "drop", category: "wrong_answer", reasonPl: "Dwie\nlinie" },
      { n: 3, verdict: "drop", reasonPl: "Brak kategorii" },
      { n: 4, verdict: "drop", category: "nonsense", reasonPl: "Zła kategoria" },
      { n: 99, verdict: "drop", category: "wrong_answer", reasonPl: "Poza zakresem" },
      "śmieć",
    ];
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
    const result = await reviewFreshExercises(ctx(ready(reviewer), fresh));
    expect(result.exercises).toEqual(fresh);
    expect(result.droppedCount).toBe(0);
    const line = logs.find((entry) => entry.startsWith("[lesson-review]"))!;
    expect(line).toMatch(/^\[lesson-review\] run=run-1 zagadnienie=affirmative_base ok=\d+ note=0 fix=0 drop=0 invalid=6 leaks=0 status=reviewed durationMs=\d+$/u);
  });

  it("fix bez ćwiczenia: twarda kategoria usuwa oryginał, miękka zostawia z uwagą „poprawka odrzucona”", async () => {
    const fresh = await freshPool();
    const reviewer = new FakeLessonReviewer();
    reviewer.behavior = () => [
      { n: 1, verdict: "fix", category: "ambiguous", reasonPl: "Dwie odpowiedzi pasują.", exercise: null, exerciseJsonInvalid: true },
      { n: 2, verdict: "fix", category: "unnatural_language", reasonPl: "Nienaturalne zdanie.", exercise: null },
    ];
    const result = await reviewFreshExercises(ctx(ready(reviewer), fresh));
    expect(result.exercises).toEqual(fresh.slice(1));
    expect(result.droppedCount).toBe(1);
    expect(result.dropped).toEqual([
      { objectiveId: OBJECTIVES[0], category: "ambiguous", reasonPl: "Dwie odpowiedzi pasują.", snippet: exerciseSnippet(fresh[0]!) },
    ]);
    expect(result.meta.get(fresh[1]!)).toEqual({ note: { category: "unnatural_language", reasonPl: "Nienaturalne zdanie.", fixRejected: true } });
  });

  it("fix zmieniający typ ćwiczenia jest odrzucony (twarda kategoria → oryginał odpada)", async () => {
    const fresh = await freshPool();
    const reviewer = new FakeLessonReviewer();
    reviewer.behavior = () => {
      const exercise = shownExercise(reviewer, 0, 1);
      return [{ n: 1, verdict: "fix", category: "wrong_answer", reasonPl: "Zła odpowiedź.", exercise: { ...exercise, exerciseType: "lesson_open_answer" } }];
    };
    const result = await reviewFreshExercises(ctx(ready(reviewer), fresh));
    expect(result.exercises).toEqual(fresh.slice(1));
    expect(result.droppedCount).toBe(1);
  });

  it("poprawna poprawka zastępuje oryginał; meta.changed z „było” i dodanymi wariantami", async () => {
    const fresh = await freshPool();
    const reviewer = new FakeLessonReviewer();
    const target = fresh.findIndex((exercise) => exercise.exerciseType === "lesson_choice");
    expect(target).toBeGreaterThanOrEqual(0);
    reviewer.behavior = () => {
      const exercise = shownExercise(reviewer, 0, target + 1);
      return [{ n: target + 1, verdict: "fix", category: "ambiguous", reasonPl: "Doprecyzowano polecenie.", exercise: { ...exercise, stem: `${String(exercise.stem)} Now.` } }];
    };
    const result = await reviewFreshExercises(ctx(ready(reviewer), fresh));
    expect(result.exercises).toHaveLength(fresh.length);
    const replaced = result.exercises[target]!;
    expect(replaced).not.toBe(fresh[target]);
    expect(replaced.stem).toBe(`${fresh[target]!.stem} Now.`);
    expect(result.meta.get(replaced)).toEqual({
      changed: { category: "ambiguous", reasonPl: "Doprecyzowano polecenie.", beforePl: exerciseSnippet(fresh[target]!), addedVariants: [] },
    });
    expect(result.objectives).toEqual([{ objectiveId: OBJECTIVES[0], status: "reviewed" }]);
  });

  it("limit wywołań: drugie zagadnienie unreviewed/limit, licznik wspólny", async () => {
    const fresh = await freshPool(OBJECTIVES.slice(0, 2));
    const reviewer = new FakeLessonReviewer();
    const callsLeft = { value: 1 };
    const result = await reviewFreshExercises(ctx(ready(reviewer), fresh, { callsLeft }));
    expect(result.objectives).toEqual([
      { objectiveId: OBJECTIVES[0], status: "reviewed" },
      { objectiveId: OBJECTIVES[1], status: "unreviewed", reason: "limit" },
    ]);
    expect(callsLeft.value).toBe(0);
    expect(reviewer.inputs).toHaveLength(1);
  });

  it("awaria: timeout → unreviewed/timeout, inny błąd → failed; reszta przejrzana", async () => {
    const fresh = await freshPool(OBJECTIVES.slice(0, 3));
    const reviewer = new FakeLessonReviewer();
    reviewer.behavior = (input) => {
      if (input.objective.id === OBJECTIVES[1]!.split(".").at(-1)) throw new GenerationProviderError("timeout");
      if (input.objective.id === OBJECTIVES[2]!.split(".").at(-1)) throw new Error("boom");
      return [];
    };
    const result = await reviewFreshExercises(ctx(ready(reviewer), fresh));
    expect(result.exercises).toEqual(fresh);
    expect(result.objectives).toEqual([
      { objectiveId: OBJECTIVES[0], status: "reviewed" },
      { objectiveId: OBJECTIVES[1], status: "unreviewed", reason: "timeout" },
      { objectiveId: OBJECTIVES[2], status: "unreviewed", reason: "failed" },
    ]);
  });

  it("limit czasu wywołania przerywa tylko wywołanie (miękko), po terminie fazy bez wywołań", async () => {
    const fresh = await freshPool(OBJECTIVES.slice(0, 2));
    const reviewer = new FakeLessonReviewer();
    reviewer.delayMs = 2_000;
    const slow = await reviewFreshExercises(ctx(ready(reviewer, { timeoutMs: 50 }), fresh.filter((exercise) => exercise.objectiveId === OBJECTIVES[0])));
    expect(slow.objectives).toEqual([{ objectiveId: OBJECTIVES[0], status: "unreviewed", reason: "timeout" }]);

    const late = new FakeLessonReviewer();
    const result = await reviewFreshExercises(ctx(ready(late), fresh, { reviewDeadlineAtMs: Date.now() - 1 }));
    expect(result.objectives.map((objective) => objective.reason)).toEqual(["timeout", "timeout"]);
    expect(late.inputs).toHaveLength(0);
  });

  it("edycja rodzica w trakcie (assertCurrent=false po wywołaniu) przerywa fazę błędem anulowania", async () => {
    const fresh = await freshPool();
    const reviewer = new FakeLessonReviewer();
    let current = true;
    reviewer.behavior = (input) => {
      current = false;
      return input.exercises.map((exercise) => ({ n: exercise.n, verdict: "ok" }));
    };
    await expect(reviewFreshExercises(ctx(ready(reviewer), fresh, { assertCurrent: async () => current }))).rejects.toBeInstanceOf(LessonGenerationCancelledError);
  });

  it("ustalenia deterministyczne: świeże tłumaczenie równe przykładowi karty dostaje findingText", async () => {
    const fresh = await freshPool();
    const independent = fresh.findIndex((exercise) => exercise.exerciseType === "lesson_open_answer");
    expect(independent).toBeGreaterThanOrEqual(0);
    const reviewer = new FakeLessonReviewer();
    const examples = { [OBJECTIVES[0]!]: [fresh[independent]!.answer] };
    await reviewFreshExercises(ctx(ready(reviewer), fresh, { examples }));
    expect(reviewer.inputs[0]!.findings).toEqual([
      `exercise ${independent + 1}: its solution equals card example "${fresh[independent]!.answer}"`,
    ]);
    // Kształt ćwiczenia jak payload (bez locale).
    const { answerLocale: _a, promptLocale: _p, ...shape } = buildLessonPayload(fresh[independent]!, subject);
    expect(reviewer.inputs[0]!.exercises[independent]!.exercise).toEqual({ ...shape, objectiveId: "affirmative_base" });
  });
});
