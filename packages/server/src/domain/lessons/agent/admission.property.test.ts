import { describe, expect, it } from "vitest";
import { findExposureLeaks } from "../exposure-leaks";
import { keywordsAnswer, validateLessonExercise, validatePool } from "../pool-validation";
import { schoolSubject } from "../subjects/school/module";
import { choice, gap, keywords, listen, open, subject as testSubject, topic as testTopic } from "../testing/agent-admission-fixtures";
import { withAgentPolicy } from "../testing/agent-test-subject";
import type { LessonExerciseDraft, LessonTopic, SubjectModule } from "../types";
import {
  admitBatch,
  precheckBatch,
  removeExercise,
  submitExamples,
  type AdmitEntry,
  type AgentCheckContext,
  type AgentHintVerdict,
  type CandidateChecks,
  type CheckResult,
  type ObjectiveAgentLimits,
  type OpenCheckOutcome,
  type OpenGraded,
} from "./admission";
import { agentObjectivesOf } from "./capable";
import { allExamples, createLessonAgentState, orderedLesson, poolOf, type LessonAgentState, type LessonAgentStateInput } from "./state";

/**
 * Test własności niezmiennika §3.3: losowe (deterministyczne, mulberry32)
 * sekwencje `precheckBatch`+`admitBatch`, `removeExercise` i `submitExamples`
 * na dwóch przedmiotach. Wyrocznia jest bezwzględna: po każdej operacji
 * świeże `findExposureLeaks` (coverage), `validatePool` i `validatePoolExtra`
 * na całej lekcji — bez porównania z wewnętrznymi migawkami przyjmowania.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
}

/** Słownik z częstymi kolizjami: 6 odpowiedzi i 4 zdania-przykłady (3 równe odpowiedziom). */
const ANSWERS = ["966", "Mieszko I", "Bolesław Chrobry", "Gniezno", "Dąbrówka", "w 966 roku"] as const;
const EXAMPLE_LINES = ["966", "Gniezno", "w 966 roku", "Chrzest Polski"] as const;
const OPEN_PROMPTS = ["Kiedy?", "Kto?", "Gdzie?", "Co się stało?"] as const;
const GAP_STEMS = ["Rok ___.", "Władca: ___.", "Miejsce: ___."] as const;
const CHOICE_STEMS = ["Wybierz: ___.", "Uzupełnij: ___."] as const;
const FAMILIES = [undefined, "f1", "f2"] as const;
const OPS_PER_SEED = 20;
const SEEDS = Array.from({ length: 50 }, (_, index) => index + 1);
/** Ziarna testu pokrycia kodów odrzuceń (podzbiór `SEEDS`). */
const COVERAGE_SEEDS = SEEDS.slice(0, 10);
const LIMITS: ObjectiveAgentLimits = { targetCount: 3, listenAllowance: 1, maxExercises: 5 };

const SCHOOL_MATERIAL =
  "Mieszko I przyjął chrzest w 966 roku. Stolicą państwa było Gniezno. Żoną Mieszka była Dąbrówka. " +
  "Następcą Mieszka był Bolesław Chrobry.";
const SCHOOL_QUOTES = ["Mieszko I przyjął chrzest w 966 roku.", "Stolicą państwa było Gniezno.", "Żoną Mieszka była Dąbrówka."] as const;

interface World {
  readonly subject: SubjectModule;
  readonly topic: LessonTopic;
  readonly material: string;
  /** Losowy szkic zagadnienia ze słownika (może łamać reguły — wtedy odpada w kroku 2). */
  draft(rng: Rng, objectiveId: string): LessonExerciseDraft;
  /** Stan startowy z czystym `fixed`: bez ujawnień i błędów walidacji. */
  start(objectiveIds: readonly [string, string]): Omit<LessonAgentStateInput, "topic" | "objectives">;
}

function choiceOf(objectiveId: string, stem: string, answer: string): LessonExerciseDraft {
  return {
    ...choice(objectiveId, 0),
    stem,
    options: [
      { id: "a", text: answer },
      { id: "b", text: "Kraków" },
    ],
    answer,
  };
}

const testWorld: World = {
  subject: testSubject,
  topic: testTopic,
  material: "",
  draft(rng, objectiveId) {
    const roll = rng.int(100);
    if (roll < 25) return choiceOf(objectiveId, rng.pick(CHOICE_STEMS), rng.pick(ANSWERS));
    if (roll < 45) return gap(objectiveId, rng.pick(GAP_STEMS), rng.pick(ANSWERS));
    if (roll < 80) return open(objectiveId, rng.pick(OPEN_PROMPTS), rng.pick(ANSWERS), rng.pick(FAMILIES));
    if (roll < 92) return keywords(objectiveId, rng.pick(["f1", "f2"]), rng.int(3));
    return listen(objectiveId, rng.int(3));
  },
  start([first, second]) {
    return {
      fixed: [
        open(first, "Kto był pierwszym królem?", "Bolesław Chrobry", "f0"),
        keywords(first, "f0", 9),
        choiceOf(first, "Kto przyjął chrzest? ___", "Mieszko I"),
        gap(second, "Stolica: ___.", "Gniezno"),
      ],
      examples: { [first]: ["966"] },
      fixedSources: { [second]: ["Chrzest Polski"] },
    };
  },
};

function schoolRefs(rng: Rng): LessonExerciseDraft["sourceRefs"] {
  return [{ quote: rng.pick(SCHOOL_QUOTES) }];
}

function schoolOpen(objectiveId: string, prompt: string, answer: string, familyId: string | undefined, element: string, quote: string): LessonExerciseDraft {
  return {
    ...open(objectiveId, prompt, answer, familyId),
    questionType: "definition",
    requiredElements: [{ id: element, text: answer }],
    expectedForm: "explanation",
    sourceRefs: [{ quote }],
  };
}

function schoolKeywords(objectiveId: string, familyId: string, rng: Rng): LessonExerciseDraft {
  const keywordOptions = [
    { id: "k1", text: "chrzest" },
    { id: "k2", text: "Gniezno" },
    { id: "k3", text: "Kraków" },
    { id: "k4", text: "Warszawa" },
  ];
  const keyOptionIds = rng.chance(0.8) ? ["k1", "k2"] : ["k1", "k3"]; // „Kraków” nie występuje w materiale
  return {
    exerciseType: "lesson_keywords",
    objectiveId,
    prompt: "Wybierz pojęcia.",
    keywordOptions,
    keyOptionIds,
    answer: keywordsAnswer({ keywordOptions, keyOptionIds }),
    acceptedAnswers: [],
    focus: [],
    familyId,
    sourceRefs: schoolRefs(rng),
  };
}

const schoolTopic = schoolSubject.buildDynamicTopic!({
  titlePl: "Początki Polski",
  objectives: [
    {
      id: "school.ddeck.chrzest",
      titlePl: "Chrzest",
      descriptionEn: "The baptism of Poland in 966.",
      cards: [
        { title: "Chrzest", body: "Mieszko I przyjął chrzest w 966 roku." },
        { title: "Gniezno", body: "Stolicą państwa było Gniezno." },
      ],
    },
    {
      id: "school.ddeck.rod",
      titlePl: "Ród Piastów",
      descriptionEn: "Mieszko I, Dąbrówka and Bolesław Chrobry.",
      cards: [
        { title: "Dąbrówka", body: "Żoną Mieszka była Dąbrówka." },
        { title: "Następca", body: "Następcą Mieszka był Bolesław Chrobry." },
      ],
    },
  ],
});

const schoolWorld: World = {
  subject: withAgentPolicy(schoolSubject),
  topic: schoolTopic,
  material: SCHOOL_MATERIAL,
  draft(rng, objectiveId) {
    const roll = rng.int(100);
    if (roll < 25) return { ...choiceOf(objectiveId, rng.pick(CHOICE_STEMS), rng.pick(ANSWERS)), sourceRefs: schoolRefs(rng) };
    if (roll < 45) return { ...gap(objectiveId, rng.pick(GAP_STEMS), rng.pick(ANSWERS)), sourceRefs: schoolRefs(rng) };
    if (roll < 85) {
      // Rodzina musi mieć wspólną odpowiedź i elementy: losowe wartości często ją łamią (lesson_extra).
      return schoolOpen(objectiveId, rng.pick(OPEN_PROMPTS), rng.pick(ANSWERS), rng.pick(FAMILIES), rng.pick(["e1", "e2"]), rng.pick(SCHOOL_QUOTES));
    }
    return schoolKeywords(objectiveId, rng.pick(["f1", "f2"]), rng);
  },
  start([first, second]) {
    return {
      fixed: [
        schoolOpen(first, "Kto był pierwszym królem?", "Bolesław Chrobry", "f0", "e1", SCHOOL_QUOTES[0]),
        { ...choiceOf(first, "Kto przyjął chrzest? ___", "Mieszko I"), sourceRefs: [{ quote: SCHOOL_QUOTES[0] }] },
        { ...gap(second, "Stolica: ___.", "Gniezno"), sourceRefs: [{ quote: SCHOOL_QUOTES[1] }] },
      ],
      examples: { [first]: ["966"] },
      fixedSources: { [second]: ["Chrzest Polski"] },
    };
  },
};

function contextOf(world: World): AgentCheckContext {
  return {
    subject: world.subject,
    material: world.material,
    limits: new Map(world.topic.objectives.map((objective) => [objective.id, LIMITS])),
  };
}

function initialState(world: World, input: Omit<LessonAgentStateInput, "topic" | "objectives">): LessonAgentState {
  return createLessonAgentState({ topic: world.topic, objectives: agentObjectivesOf(world.topic), ...input });
}

function objectiveIdsOf(world: World): readonly [string, string] {
  return world.topic.objectives.map((objective) => objective.id) as unknown as readonly [string, string];
}

/** Wyrocznia: odrzucenia całej lekcji świeżymi wywołaniami walidatorów (po tożsamości szkicu). */
function lessonFindings(state: LessonAgentState, ctx: AgentCheckContext) {
  const lesson = orderedLesson(state);
  const leaks = findExposureLeaks({
    exercises: lesson,
    examples: allExamples(state),
    objectiveOrder: state.objectives.map((objective) => objective.id),
    subject: ctx.subject,
    mode: "coverage",
    // Powtórzenie w rodzinie pytań nie jest ujawnieniem (ta sama reguła co ostrzeżenia szkicu dla rodzica).
    familyRepeatsAllowed: true,
  }).map((leak) => lesson[leak.index]!);
  const pool = validatePool(lesson, ctx.subject, state.topic, { existingExercises: [] }).rejected.map((item) => item.exercise);
  const extra = [...(ctx.subject.validatePoolExtra?.(lesson, { material: ctx.material }) ?? [])]
    .filter(([, errors]) => errors.length > 0)
    .map(([index]) => lesson[index]!);
  return { leaks, pool, extra };
}

const label = (draft: LessonExerciseDraft) => `${draft.objectiveId.split(".").at(-1)}/${draft.exerciseType}:${draft.answer}`;

function randomChecks(rng: Rng, draft: LessonExerciseDraft): CandidateChecks {
  const roll = rng.int(100);
  const solve: CheckResult<readonly string[]> =
    roll < 70 ? { kind: "na" } : roll < 85 ? { kind: "unavailable" } : { kind: "done", value: [rng.chance(0.5) ? draft.answer : rng.pick(ANSWERS)] };
  const variants: CheckResult<readonly boolean[]> = rng.chance(0.85) ? { kind: "na" } : { kind: "unavailable" };
  const hint = randomHint(rng);
  const open = randomOpen(rng, draft);
  return { solve, variants, hint, open };
}

function randomHint(rng: Rng): CheckResult<AgentHintVerdict> {
  const roll = rng.int(100);
  if (roll < 60) return { kind: "na" };
  if (roll < 70) return { kind: "unavailable" };
  if (roll < 85) return { kind: "done", value: { verdict: "ok" } };
  return { kind: "done", value: { verdict: rng.pick(["unsupported", "language", "reveals"] as const), reason: "losowy powód" } };
}

function randomOpen(rng: Rng, draft: LessonExerciseDraft): CheckResult<OpenCheckOutcome> {
  const roll = rng.int(100);
  if (roll < 60) return { kind: "na" };
  if (roll < 70) return { kind: "unavailable" };
  const graded = (knowledge: OpenGraded["knowledge"]): OpenGraded => ({
    answer: draft.answer,
    knowledge,
    missing: knowledge === "partial" ? ["brakujący element"] : [],
    wrong: knowledge === "incorrect" ? ["błędne stwierdzenie"] : [],
  });
  const knowledge = rng.pick(["correct", "correct", "partial", "incorrect"] as const);
  return { kind: "done", value: { answers: [graded("correct"), graded(knowledge)] } };
}

/** Wynik kontroli, który musi odrzucić kandydata (podpowiedź albo otwarta nieprzyjęta). */
function rejectsCandidate(checks: CandidateChecks): boolean {
  if (checks.hint.kind === "done" && checks.hint.value.verdict !== "ok") return true;
  return checks.open.kind === "done" && checks.open.value.answers.some((answer) => answer.knowledge !== "correct");
}

/** Zbiera kody odrzuceń do zbioru wołającego (bez stanu modułu: wynik nie zależy od kolejności testów). */
function record(codes: Set<string> | undefined, results: readonly AdmitEntry[]): void {
  if (codes === undefined) return;
  for (const entry of results) if ("rejected" in entry) codes.add(entry.rejected.code);
}

/** Jedna operacja na stanie; `onStep` dostaje każdy stan pośredni (wyrocznia po każdej operacji). */
function randomOperation(
  rng: Rng,
  world: World,
  state: LessonAgentState,
  ctx: AgentCheckContext,
  onStep: (state: LessonAgentState, description: string) => void,
  codes?: Set<string>,
): LessonAgentState {
  const [first, second] = objectiveIdsOf(world);
  const objectiveId = rng.chance(0.5) ? first : second;
  const roll = rng.int(100);
  if (roll < 60) {
    const drafts = Array.from({ length: 1 + rng.int(4) }, () => world.draft(rng, objectiveId));
    const prechecked = precheckBatch(state, objectiveId, drafts, ctx);
    let current = state;
    // Co trzecia paczka: między precheck a admit inne zagadnienie przyjmuje własną paczkę.
    if (rng.chance(0.3)) {
      const other = objectiveId === first ? second : first;
      const otherDrafts = Array.from({ length: 1 + rng.int(2) }, () => world.draft(rng, other));
      const otherPrechecked = precheckBatch(current, other, otherDrafts, ctx);
      const interleaved = admitBatch(current, other, otherPrechecked, otherPrechecked.map(() => ({ solve: { kind: "na" }, variants: { kind: "na" }, hint: { kind: "na" }, open: { kind: "na" } }) as const), ctx);
      record(codes, interleaved.results);
      current = interleaved.state;
      onStep(current, `admit ${other} [${otherDrafts.map(label).join(", ")}] (między precheck a admit)`);
    }
    const checks = prechecked.map((entry, index) => randomChecks(rng, entry.pass ? entry.draft : drafts[index]!));
    const admitted = admitBatch(current, objectiveId, prechecked, checks, ctx);
    record(codes, admitted.results);
    // Odrzucenie przez sędziego podpowiedzi albo kontrolę otwartą nigdy nie dodaje ćwiczenia do stanu.
    admitted.results.forEach((entry, index) => {
      if (!rejectsCandidate(checks[index]!)) return;
      if ("accepted" in entry) {
        expect.fail(`kandydat ${index} przyjęty mimo odrzucenia przez hint/open (${label(drafts[index]!)})`);
      }
    });
    // Pula rośnie dokładnie o liczbę przyjętych: odrzucony (także przez hint/open) nic nie dokłada.
    const acceptedCount = admitted.results.filter((entry) => "accepted" in entry).length;
    expect(poolOf(admitted.state, objectiveId).length - poolOf(current, objectiveId).length).toBe(acceptedCount);
    onStep(admitted.state, `admit ${objectiveId} [${drafts.map(label).join(", ")}]`);
    return admitted.state;
  }
  if (roll < 85) {
    const ids = poolOf(state, objectiveId).map((entry) => entry.id);
    const id = ids.length === 0 || rng.chance(0.1) ? "ex999" : rng.pick(ids);
    const removed = removeExercise(state, objectiveId, id, ctx);
    onStep(removed.state, `remove ${objectiveId} ${id} → [${removed.removed.join(", ")}]`);
    return removed.state;
  }
  const lines = Array.from({ length: 1 + rng.int(3) }, () => rng.pick(EXAMPLE_LINES));
  const examples = submitExamples(state, objectiveId, lines, ctx);
  onStep(examples.state, `examples ${objectiveId} [${lines.join(", ")}] → ${examples.accepted}`);
  return examples.state;
}

function runSeed(
  world: World,
  seed: number,
  input: Omit<LessonAgentStateInput, "topic" | "objectives">,
  check: (state: LessonAgentState, where: string) => void,
  codes?: Set<string>,
): void {
  const rng = new Rng(seed);
  const ctx = contextOf(world);
  let state = initialState(world, input);
  const log: string[] = [];
  for (let op = 0; op < OPS_PER_SEED; op += 1) {
    state = randomOperation(
      rng,
      world,
      state,
      ctx,
      (next, description) => {
        log.push(description);
        check(next, `seed ${seed}, op ${op}: ${log.join(" | ")}`);
      },
      codes,
    );
  }
}

describe.each([
  ["przedmiot testowy agenta", testWorld],
  ["school", schoolWorld],
] as const)("niezmiennik przyjmowania — %s", (_name, world) => {
  const ctx = contextOf(world);
  const start = world.start(objectiveIdsOf(world));

  it("generator i stan startowy: szkice słownika bywają poprawne, a fixed jest czyste", () => {
    const rng = new Rng(7);
    const drafts = Array.from({ length: 40 }, () => world.draft(rng, objectiveIdsOf(world)[0]));
    const valid = drafts.filter((draft) => validateLessonExercise(draft, world.subject, world.topic).length === 0);
    expect(valid.length).toBeGreaterThan(30);
    const findings = lessonFindings(initialState(world, start), ctx);
    expect({ leaks: findings.leaks.map(label), pool: findings.pool.map(label), extra: findings.extra.map(label) }).toEqual({ leaks: [], pool: [], extra: [] });
  });

  it.each(SEEDS)("ziarno %i: po każdej operacji brak ujawnień i błędów walidacji całej lekcji", { timeout: 60_000 }, (seed) => {
    runSeed(world, seed, start, (state, where) => {
      const findings = lessonFindings(state, ctx);
      expect(findings.leaks.map(label), `findExposureLeaks — ${where}`).toEqual([]);
      expect(findings.pool.map(label), `validatePool — ${where}`).toEqual([]);
      expect(findings.extra.map(label), `validatePoolExtra — ${where}`).toEqual([]);
    });
  });
});

describe("niezmiennik przyjmowania — wadliwe fixed", () => {
  const world = testWorld;
  const ctx = contextOf(world);
  const [first, second] = objectiveIdsOf(world);
  const duplicate = open(first, "Kiedy?", "w 966 roku");
  const start: Omit<LessonAgentStateInput, "topic" | "objectives"> = {
    fixed: [
      duplicate,
      { ...duplicate }, // duplikat bodźca (validatePool)
      open(first, "Rok chrztu?", "966"), // ujawnione przez przykład karty
      keywords(first, "f9", 9), // sierota (validatePoolExtra)
      // Sierota rodziny „f1”: pytanie otwarte f1 z puli ją naprawia, a usunięcie go
      // przez removeExercise psuje ją z powrotem — dozwolone, bo była odrzucona na starcie.
      keywords(first, "f1", 8),
      gap(second, "Stolica: ___.", "Gniezno"),
    ],
    examples: { [first]: ["966"] },
    fixedSources: {},
  };
  const startFindings = lessonFindings(initialState(world, start), ctx);
  const rejectedAtStart = new Set([...startFindings.leaks, ...startFindings.pool, ...startFindings.extra]);

  it("stan startowy ma odrzucenia każdego rodzaju", () => {
    // Ujawnienia: „966” przez przykład karty i drugi duplikat (miękko, przez pierwszy).
    expect(startFindings.leaks).toHaveLength(2);
    expect(startFindings.pool).toHaveLength(1);
    expect(startFindings.extra).toHaveLength(2);
  });

  it.each(SEEDS)("ziarno %i: odrzucone są wyłącznie szkice odrzucone na starcie (po tożsamości)", { timeout: 60_000 }, (seed) => {
    runSeed(world, seed, start, (state, where) => {
      const findings = lessonFindings(state, ctx);
      const fresh = [...findings.leaks, ...findings.pool, ...findings.extra].filter((draft) => !rejectedAtStart.has(draft));
      expect(fresh.map(label), where).toEqual([]);
    });
  });
});

describe("niezmiennik przyjmowania — pokrycie kodów", () => {
  // Własny przebieg ziaren (bez wyroczni): wynik nie zależy od kolejności ani filtrowania testów pliku.
  it("każdy z kodów lesson_pool, leak_victim, leak_source, limit_full wystąpił", { timeout: 60_000 }, () => {
    const codes = new Set<string>();
    for (const world of [testWorld, schoolWorld]) {
      const start = world.start(objectiveIdsOf(world));
      for (const seed of COVERAGE_SEEDS) runSeed(world, seed, start, () => undefined, codes);
    }
    for (const code of ["lesson_pool", "leak_victim", "leak_source", "limit_full"]) expect(codes, code).toContain(code);
  });
});
