import { describe, expect, it } from "vitest";
import {
  selectLessonTask,
  type LessonExerciseCandidate,
  type LessonScheduleInput,
  type LessonSessionTask,
  type ObjectiveProgressSnapshot,
} from "./scheduler";
import { DEFAULT_LESSON_POLICY, defaultPoolSize } from "./lesson-policy";
import type { LessonExerciseType } from "./types";
import type { ProgressStatus } from "../types";

const NOW = "2026-10-12T12:00:00.000Z";
const O1 = "subj.topic.o1";
const O2 = "subj.topic.o2";
const O3 = "subj.topic.o3";

/**
 * Fixture puli: dla każdego celu po jednym ćwiczeniu każdego etapu, ze stabilną
 * kolejnością i deterministycznym `targetKey`/`itemId`. Pozwala składać wejście
 * punktowo bez powielania pola.
 */
const STAGE_TYPE: Readonly<Record<"guided" | "productive" | "independent", LessonExerciseType>> = {
  guided: "lesson_choice",
  productive: "lesson_gap",
  independent: "lesson_open_answer",
};

function ex(
  objectiveId: string,
  stage: "guided" | "productive" | "independent",
  variant = "a",
): LessonExerciseCandidate {
  const key = `${objectiveId}:${stage}:${variant}`;
  return {
    itemId: `item:${key}`,
    itemRevisionId: `rev:${key}`,
    objectiveId,
    exerciseType: STAGE_TYPE[stage],
    targetKey: key,
  };
}

function notice(objectiveId: string): LessonExerciseCandidate {
  const key = `${objectiveId}:notice`;
  return {
    itemId: `item:${key}`,
    itemRevisionId: `rev:${key}`,
    objectiveId,
    exerciseType: "lesson_notice",
    targetKey: key,
  };
}

/** Pełna pula dla celu: guided×2, productive, independent (bez notice). */
function poolFor(objectiveId: string): LessonExerciseCandidate[] {
  return [
    ex(objectiveId, "guided", "a"),
    ex(objectiveId, "guided", "b"),
    ex(objectiveId, "productive", "a"),
    ex(objectiveId, "independent", "a"),
  ];
}

function prog(status: ProgressStatus, nextReviewAt: string | null = null): ObjectiveProgressSnapshot {
  return { status, nextReviewAt };
}

let ordinalSeq = 0;
function task(partial: Partial<LessonSessionTask> & { objectiveId: string }): LessonSessionTask {
  ordinalSeq += 1;
  return {
    ordinal: ordinalSeq,
    itemId: partial.itemId ?? null,
    objectiveId: partial.objectiveId,
    exerciseType: partial.exerciseType ?? "lesson_choice",
    kind: partial.kind ?? "exercise",
    ...(partial.outcome ? { outcome: partial.outcome } : {}),
  };
}

function input(overrides: Partial<LessonScheduleInput> = {}): LessonScheduleInput {
  return {
    exercises: overrides.exercises ?? poolFor(O1),
    objectiveOrder: overrides.objectiveOrder ?? [O1, O2, O3],
    progress: overrides.progress ?? {},
    ...(overrides.initialProgress === undefined ? {} : { initialProgress: overrides.initialProgress }),
    ...(overrides.planningMode === undefined ? {} : { planningMode: overrides.planningMode }),
    ...(overrides.reservedDueCheckObjectives === undefined ? {} : { reservedDueCheckObjectives: overrides.reservedDueCheckObjectives }),
    ...(overrides.supportObjectives === undefined ? {} : { supportObjectives: overrides.supportObjectives }),
    ...(overrides.precisionHistory === undefined ? {} : { precisionHistory: overrides.precisionHistory }),
    exposedTargetKeys: overrides.exposedTargetKeys ?? new Set<string>(),
    sessionHistory: overrides.sessionHistory ?? [],
    lastSeenAt: overrides.lastSeenAt ?? {},
    cardCountByObjective: overrides.cardCountByObjective ?? {},
    assessedRemaining: overrides.assessedRemaining ?? 10,
    testWindowOpen: overrides.testWindowOpen ?? false,
    graderAvailable: overrides.graderAvailable ?? true,
    graderCallsLeft: overrides.graderCallsLeft ?? 10,
    policy: overrides.policy ?? DEFAULT_LESSON_POLICY,
    now: overrides.now ?? NOW,
  };
}

describe("defaultPoolSize", () => {
  it("1 cel → 60 (base wygrywa z perObjective)", () => {
    expect(defaultPoolSize(1)).toBe(60);
  });
  it("7 celów → 84 (perObjective × n)", () => {
    expect(defaultPoolSize(7)).toBe(84);
  });
  it("20 celów → 120 (clamp max)", () => {
    expect(defaultPoolSize(20)).toBe(120);
  });
});

describe("selectLessonTask — zakończenie sesji", () => {
  it("assessedRemaining = 0 → null (także karty nie wychodzą)", () => {
    expect(selectLessonTask(input({ assessedRemaining: 0, cardCountByObjective: { [O1]: 2 } }))).toBeNull();
  });

  it("pusta pula → null", () => {
    expect(selectLessonTask(input({ exercises: [] }))).toBeNull();
  });
});

describe("selectLessonTask — wprowadzenie nowego celu (priorytet 5)", () => {
  it("nowy cel: najpierw karty, jedna karta = jedno zadanie card (intro)", () => {
    const plan = selectLessonTask(input({ cardCountByObjective: { [O1]: 2 } }));
    expect(plan).toEqual({ kind: "card", objectiveId: O1, cardPurpose: "intro" });
  });

  it("po wszystkich kartach: lesson_notice, jeśli jest w puli", () => {
    const sessionHistory = [
      task({ objectiveId: O1, kind: "card" }),
      task({ objectiveId: O1, kind: "card" }),
    ];
    const plan = selectLessonTask(
      input({
        exercises: [...poolFor(O1), notice(O1)],
        cardCountByObjective: { [O1]: 2 },
        sessionHistory,
      }),
    );
    expect(plan).toMatchObject({ kind: "exercise", objectiveId: O1, exerciseType: "lesson_notice", reason: "introduce" });
  });

  it("po kartach i notice: ćwiczenie etapu guided", () => {
    const sessionHistory = [
      task({ objectiveId: O1, kind: "card" }),
      task({ objectiveId: O1, kind: "card" }),
      task({ objectiveId: O1, exerciseType: "lesson_notice", outcome: "correct" }),
    ];
    const plan = selectLessonTask(
      input({ exercises: [...poolFor(O1), notice(O1)], cardCountByObjective: { [O1]: 2 }, sessionHistory }),
    );
    expect(plan).toMatchObject({ kind: "exercise", objectiveId: O1, exerciseType: "lesson_choice", reason: "introduce" });
  });

  it("cel bez kart (cardCount 0) i bez notice → od razu guided", () => {
    const plan = selectLessonTask(input({ cardCountByObjective: { [O1]: 0 } }));
    expect(plan).toMatchObject({ kind: "exercise", objectiveId: O1, exerciseType: "lesson_choice", reason: "introduce" });
  });

  it("max 2 nowe cele na sesję — trzeci nowy cel nie jest wprowadzany", () => {
    // O1 i O2 już wprowadzone w sesji (guided wydany), O3 byłby trzecim nowym.
    const sessionHistory = [
      task({ objectiveId: O1, exerciseType: "lesson_choice", outcome: "correct", itemId: "x" }),
      task({ objectiveId: O2, exerciseType: "lesson_choice", outcome: "correct", itemId: "y" }),
    ];
    const exercises = [...poolFor(O1), ...poolFor(O2), ...poolFor(O3)];
    const plan = selectLessonTask(input({ exercises, cardCountByObjective: { [O3]: 2 }, sessionHistory }));
    // Nie wolno zacząć O3; wybór pada na kontynuację O1/O2, nigdy na O3 intro.
    expect(plan?.objectiveId).not.toBe(O3);
  });
});

describe("selectLessonTask — kontynuacja celu w toku (priorytet 4)", () => {
  it("plan sesji zachowuje niewidzianą możliwość ćwiczenia na kolejną sesję", () => {
    const exercises = [ex(O1, "productive", "a"), ex(O1, "productive", "b"), ex(O1, "productive", "c")];
    const sessionHistory = [
      task({ objectiveId: O1, exerciseType: "lesson_gap", itemId: "item:one" }),
      task({ objectiveId: O1, exerciseType: "lesson_gap", itemId: "item:two" }),
    ];
    const plan = selectLessonTask(input({
      exercises,
      objectiveOrder: [O1],
      initialProgress: { [O1]: prog("learning") },
      progress: { [O1]: prog("learning") },
      planningMode: true,
      sessionHistory,
    }));
    expect(plan).toBeNull();
  });

  it("awans na productive po 2 kolejnych correct na guided", () => {
    const sessionHistory = [
      task({ objectiveId: O1, exerciseType: "lesson_choice", outcome: "correct", itemId: "g1" }),
      task({ objectiveId: O1, exerciseType: "lesson_choice", outcome: "correct", itemId: "g2" }),
    ];
    const plan = selectLessonTask(input({ cardCountByObjective: { [O1]: 0 }, sessionHistory }));
    expect(plan).toMatchObject({ kind: "exercise", objectiveId: O1, exerciseType: "lesson_gap", reason: "continue" });
  });

  it("fixed plan does not advance stages from planned slots without historical success", () => {
    const exercises = [...poolFor(O1)];
    const sessionHistory = [
      task({ objectiveId: O1, exerciseType: "lesson_choice", itemId: `item:${O1}:guided:a` }),
      task({ objectiveId: O1, exerciseType: "lesson_choice", itemId: `item:${O1}:guided:b` }),
    ];
    const plan = selectLessonTask(input({ exercises, planningMode: true, cardCountByObjective: { [O1]: 0 }, sessionHistory }));
    expect(plan).toBeNull();
  });

  it("błąd zeruje licznik etapu — 1 correct, incorrect, (wsparcie), 1 correct → wciąż guided (brak awansu)", () => {
    // 1 correct → błąd (zeruje licznik, otwiera cykl wsparcia) → pełny cykl
    // wsparcia (support_card + ćwiczenie guided nieocenione = neutralne) →
    // 1 correct. Licznik etapu po błędzie = 0, więc jedno correct nie wystarcza
    // do awansu (advanceAfterCorrect = 2): cel wciąż na guided.
    const withSupport = [
      task({ objectiveId: O1, exerciseType: "lesson_choice", outcome: "correct", itemId: "g1" }),
      task({ objectiveId: O1, exerciseType: "lesson_choice", outcome: "incorrect", itemId: "g2" }),
      task({ objectiveId: O1, kind: "support_card" }),
      task({ objectiveId: O1, exerciseType: "lesson_choice", outcome: "unevaluated", itemId: "g1" }),
      task({ objectiveId: O1, exerciseType: "lesson_choice", outcome: "correct", itemId: "g2" }),
    ];
    const plan = selectLessonTask(input({ cardCountByObjective: { [O1]: 0 }, sessionHistory: withSupport }));
    expect(plan).toMatchObject({ kind: "exercise", objectiveId: O1, exerciseType: "lesson_choice", reason: "continue" });
    expect((plan as { exerciseType: string }).exerciseType).not.toBe("lesson_gap");
  });

  it("unevaluated/skipped są neutralne dla licznika etapu", () => {
    const sessionHistory = [
      task({ objectiveId: O1, exerciseType: "lesson_choice", outcome: "correct", itemId: "g1" }),
      task({ objectiveId: O1, exerciseType: "lesson_choice", outcome: "unevaluated", itemId: "g2" }),
      task({ objectiveId: O1, exerciseType: "lesson_choice", outcome: "correct", itemId: "gx" }),
    ];
    // 2 correct (neutralny w środku) → awans na productive.
    const plan = selectLessonTask(input({ cardCountByObjective: { [O1]: 0 }, sessionHistory }));
    expect(plan).toMatchObject({ objectiveId: O1, exerciseType: "lesson_gap", reason: "continue" });
  });

  it("cel z wcześniejszej sesji (status ≠ not_assessed) startuje od productive bez kart", () => {
    const plan = selectLessonTask(
      input({
        progress: { [O1]: prog("learning") },
        cardCountByObjective: { [O1]: 2 },
      }),
    );
    expect(plan).toMatchObject({ kind: "exercise", objectiveId: O1, exerciseType: "lesson_gap", reason: "continue" });
  });
});

describe("selectLessonTask — cykl wsparcia (priorytet 1)", () => {
  it("po incorrect: karta support, potem guided (reason support), raz na cel", () => {
    const sessionHistory = [
      task({ objectiveId: O1, exerciseType: "lesson_choice", outcome: "incorrect", itemId: "g1" }),
    ];
    const first = selectLessonTask(input({ cardCountByObjective: { [O1]: 0 }, sessionHistory }));
    expect(first).toEqual({ kind: "card", objectiveId: O1, cardPurpose: "support" });

    const afterCard = [...sessionHistory, task({ objectiveId: O1, kind: "support_card" })];
    const second = selectLessonTask(input({ cardCountByObjective: { [O1]: 0 }, sessionHistory: afterCard }));
    expect(second).toMatchObject({ kind: "exercise", objectiveId: O1, exerciseType: "lesson_choice", reason: "support" });
  });

  it("dont_remember też uruchamia cykl wsparcia", () => {
    const sessionHistory = [
      task({ objectiveId: O1, exerciseType: "lesson_choice", outcome: "dont_remember", itemId: "g1" }),
    ];
    expect(selectLessonTask(input({ cardCountByObjective: { [O1]: 0 }, sessionHistory }))).toEqual({
      kind: "card",
      objectiveId: O1,
      cardPurpose: "support",
    });
  });

  it("unevaluated/skipped NIE uruchamia cyklu wsparcia", () => {
    const sessionHistory = [
      task({ objectiveId: O1, exerciseType: "lesson_choice", outcome: "unevaluated", itemId: "g1" }),
    ];
    const plan = selectLessonTask(input({ cardCountByObjective: { [O1]: 0 }, sessionHistory }));
    expect(plan).not.toEqual({ kind: "card", objectiveId: O1, cardPurpose: "support" });
  });

  it("limit cykli: po jednym pełnym cyklu wsparcia drugi błąd nie daje kolejnej karty support", () => {
    const sessionHistory = [
      task({ objectiveId: O1, exerciseType: "lesson_choice", outcome: "incorrect", itemId: "g1" }),
      task({ objectiveId: O1, kind: "support_card" }),
      task({ objectiveId: O1, exerciseType: "lesson_choice", outcome: "incorrect", itemId: "g2" }),
    ];
    const plan = selectLessonTask(input({ cardCountByObjective: { [O1]: 0 }, sessionHistory }));
    expect(plan).not.toEqual({ kind: "card", objectiveId: O1, cardPurpose: "support" });
  });
});

describe("selectLessonTask — należne niezależne sprawdzenie (priorytet 2)", () => {
  it("nextReviewAt <= now wybiera niewidziane ćwiczenie i independentCheck: true", () => {
    const plan = selectLessonTask(
      input({
        progress: { [O1]: prog("mastered", "2026-10-10T00:00:00.000Z") },
        cardCountByObjective: { [O1]: 0 },
      }),
    );
    expect(plan).toMatchObject({ kind: "exercise", objectiveId: O1, reason: "due_check", independentCheck: true });
    // Nie guided (guided nigdy nie jest independentCheck).
    expect((plan as { exerciseType: string }).exerciseType).not.toBe("lesson_choice");
  });

  it("sprawdzenie wyprzedza wprowadzanie nowego celu", () => {
    const plan = selectLessonTask(
      input({
        exercises: [...poolFor(O1), ...poolFor(O2)],
        progress: { [O1]: prog("mastered", "2026-10-01T00:00:00.000Z") },
        cardCountByObjective: { [O2]: 2 },
      }),
    );
    expect(plan).toMatchObject({ objectiveId: O1, reason: "due_check" });
  });

  it("fixed plan reserves due checks before support from historical difficulty", () => {
    const plan = selectLessonTask(input({
      planningMode: true,
      supportObjectives: new Set([O1]),
      progress: { [O1]: prog("mastered", "2026-10-10T00:00:00.000Z") },
      cardCountByObjective: { [O1]: 0 },
    }));
    expect(plan).toMatchObject({ kind: "exercise", objectiveId: O1, reason: "due_check", independentCheck: true });
  });

  it("fixed plan reserves at most one due check per objective and session", () => {
    const exercises = [ex(O1, "independent", "a"), ex(O1, "independent", "b"),
      ...["a", "b", "c", "d"].map((variant) => ex(O1, "productive", variant))];
    const plan = selectLessonTask(input({
      exercises,
      planningMode: true,
      reservedDueCheckObjectives: new Set([O1]),
      progress: { [O1]: prog("learning", "2026-10-10T00:00:00.000Z") },
    }));

    expect(plan).not.toMatchObject({ reason: "due_check" });
  });
});

describe("selectLessonTask — okno sprawdzianu (priorytet 3)", () => {
  it("preferuje etap samodzielny dla nieopanowanych celów", () => {
    const plan = selectLessonTask(
      input({
        testWindowOpen: true,
        progress: { [O1]: prog("learning") },
        cardCountByObjective: { [O1]: 0 },
      }),
    );
    expect(plan).toMatchObject({ kind: "exercise", objectiveId: O1, exerciseType: "lesson_open_answer", reason: "test_preparation" });
  });
});

describe("selectLessonTask — wybór ćwiczenia", () => {
  it("preferuje niewidziane przed widzianymi", () => {
    const exposed = new Set<string>([`${O1}:guided:a`]);
    // Po incorrect pełny cykl wsparcia (support_card + ćwiczenie guided
    // nieocenione) wyczerpuje wsparcie; selektor wraca do guided i wybiera
    // niewidziany `guided:b` zamiast wcześniej ujawnionego `guided:a`.
    const withSupportDone = [
      task({ objectiveId: O1, exerciseType: "lesson_choice", outcome: "incorrect", itemId: `item:${O1}:guided:a` }),
      task({ objectiveId: O1, kind: "support_card" }),
      task({ objectiveId: O1, exerciseType: "lesson_choice", outcome: "unevaluated", itemId: `item:${O1}:guided:a` }),
    ];
    const plan = selectLessonTask(
      input({ exposedTargetKeys: exposed, cardCountByObjective: { [O1]: 0 }, sessionHistory: withSupportDone }),
    );
    expect((plan as { itemId: string }).itemId).toBe(`item:${O1}:guided:b`);
  });

  it("nie powtarza ćwiczenia wydanego w sesji, gdy istnieje inne", () => {
    const sessionHistory = [
      task({ objectiveId: O1, exerciseType: "lesson_choice", outcome: "correct", itemId: `item:${O1}:guided:a` }),
    ];
    const plan = selectLessonTask(input({ cardCountByObjective: { [O1]: 0 }, sessionHistory }));
    expect((plan as { itemId: string }).itemId).not.toBe(`item:${O1}:guided:a`);
  });

  it("spośród widzianych wybiera najdawniej widziane (lastSeenAt)", () => {
    const exposed = new Set<string>([`${O1}:guided:a`, `${O1}:guided:b`]);
    const lastSeenAt = {
      [`item:${O1}:guided:a`]: "2026-10-11T00:00:00.000Z",
      [`item:${O1}:guided:b`]: "2026-10-09T00:00:00.000Z",
    };
    const plan = selectLessonTask(
      input({ exposedTargetKeys: exposed, lastSeenAt, cardCountByObjective: { [O1]: 0 } }),
    );
    expect((plan as { itemId: string }).itemId).toBe(`item:${O1}:guided:b`);
  });
});

describe("selectLessonTask — brak modelu / zerowy limit (req 6.8)", () => {
  it("preferuje typ nieoceniany modelowo, gdy na tym etapie jest alternatywa (gap vs error_fix)", () => {
    // Cel kontynuowany na etapie productive. Pula productive ma zarówno
    // lesson_gap (nieoceniany modelowo) jak i lesson_error_fix (zależny od
    // modelu). Bez gradera selektor PREFERUJE gap, nie wydaje error_fix.
    const gap: LessonExerciseCandidate = {
      itemId: "pg", itemRevisionId: "rpg", objectiveId: O1,
      exerciseType: "lesson_gap", targetKey: "pg",
    };
    const errorFix: LessonExerciseCandidate = {
      itemId: "pe", itemRevisionId: "rpe", objectiveId: O1,
      exerciseType: "lesson_error_fix", targetKey: "pe",
    };
    const plan = selectLessonTask(
      input({
        graderAvailable: false,
        graderCallsLeft: 0,
        progress: { [O1]: prog("learning") }, // start productive, bez awansu
        cardCountByObjective: { [O1]: 0 },
        exercises: [errorFix, gap], // error_fix pierwszy w kolejności puli
      }),
    );
    expect(plan).toMatchObject({ kind: "exercise", objectiveId: O1, exerciseType: "lesson_gap" });
  });

  it("grader niedostępny, w puli dla celu/etapu tylko open-answer → open-answer MIMO to (req 6.8)", () => {
    // Cel kontynuowany (start productive); 2 correct na productive → awans na
    // independent. Pula dla O1 ma tylko open-answer (independent). „prefer
    // closed” to preferencja, nie wykluczenie: brak alternatywy → selektor i
    // tak wydaje open-answer zamiast kończyć sesję.
    const sessionHistory = [
      task({ objectiveId: O1, exerciseType: "lesson_gap", outcome: "correct", itemId: "p1" }),
      task({ objectiveId: O1, exerciseType: "lesson_gap", outcome: "correct", itemId: "p2" }),
    ];
    const plan = selectLessonTask(
      input({
        graderAvailable: false,
        progress: { [O1]: prog("learning") },
        cardCountByObjective: { [O1]: 0 },
        sessionHistory,
        exercises: [ex(O1, "independent", "a"), ex(O1, "independent", "b")],
      }),
    );
    expect(plan).toMatchObject({ kind: "exercise", objectiveId: O1, exerciseType: "lesson_open_answer" });
  });

  it("graderCallsLeft = 0, tylko open-answer → open-answer MIMO to, nie null", () => {
    const sessionHistory = [
      task({ objectiveId: O1, exerciseType: "lesson_gap", outcome: "correct", itemId: "p1" }),
      task({ objectiveId: O1, exerciseType: "lesson_gap", outcome: "correct", itemId: "p2" }),
    ];
    const plan = selectLessonTask(
      input({
        graderAvailable: true,
        graderCallsLeft: 0,
        progress: { [O1]: prog("learning") },
        cardCountByObjective: { [O1]: 0 },
        sessionHistory,
        exercises: [ex(O1, "independent", "a")],
      }),
    );
    expect(plan).not.toBeNull();
    expect(plan).toMatchObject({ kind: "exercise", objectiveId: O1, exerciseType: "lesson_open_answer" });
  });
});

describe("selectLessonTask — kontrakt budżetu ocenianego", () => {
  it("assessedRemaining = 1, następny krok to karta intro → karta (karta nie liczy się do budżetu)", () => {
    const plan = selectLessonTask(input({ assessedRemaining: 1, cardCountByObjective: { [O1]: 2 } }));
    expect(plan).toEqual({ kind: "card", objectiveId: O1, cardPurpose: "intro" });
  });

  it("assessedRemaining = 1, następny krok to notice → notice (oceniany, mieści się w budżecie 1)", () => {
    const sessionHistory = [
      task({ objectiveId: O1, kind: "card" }),
      task({ objectiveId: O1, kind: "card" }),
    ];
    const plan = selectLessonTask(
      input({
        assessedRemaining: 1,
        exercises: [...poolFor(O1), notice(O1)],
        cardCountByObjective: { [O1]: 2 },
        sessionHistory,
      }),
    );
    expect(plan).toMatchObject({ kind: "exercise", exerciseType: "lesson_notice" });
  });

  it("assessedRemaining = 0 → null, nawet gdy następnym krokiem byłaby karta", () => {
    expect(selectLessonTask(input({ assessedRemaining: 0, cardCountByObjective: { [O1]: 2 } }))).toBeNull();
  });
});

describe("selectLessonTask — ekspozycja vs wydanie w sesji (collision targetKey)", () => {
  it("sprawdzenie nie wybiera ćwiczenia współdzielącego targetKey z wydanym w sesji", () => {
    // Dwa ćwiczenia independent dzielą ten sam targetKey; jedno wydano w sesji.
    const shared = "shared-key";
    const a: LessonExerciseCandidate = {
      itemId: "ind-a", itemRevisionId: "rev-a", objectiveId: O1,
      exerciseType: "lesson_open_answer", targetKey: shared,
    };
    const b: LessonExerciseCandidate = {
      itemId: "ind-b", itemRevisionId: "rev-b", objectiveId: O1,
      exerciseType: "lesson_open_answer", targetKey: shared,
    };
    const sessionHistory = [
      task({ objectiveId: O1, exerciseType: "lesson_open_answer", outcome: "correct", itemId: "ind-a" }),
    ];
    const plan = selectLessonTask(
      input({
        progress: { [O1]: prog("mastered", "2026-10-01T00:00:00.000Z") },
        cardCountByObjective: { [O1]: 0 },
        exercises: [a, b],
        sessionHistory,
      }),
    );
    // targetKey `shared` został ujawniony (ind-a wydane w sesji), więc ind-b
    // NIE jest „niewidziane” — niezależne sprawdzenie (due_check,
    // independentCheck) nie może na nie trafić, bo wzorzec już ujawniony.
    const isIndependentCheckOnB =
      plan !== null &&
      plan.kind === "exercise" &&
      plan.reason === "due_check" &&
      plan.itemId === "ind-b";
    expect(isIndependentCheckOnB).toBe(false);
    // I szerzej: żadne due_check nie powinno wyjść, skoro brak niewidzianego
    // ćwiczenia dla tego celu.
    if (plan && plan.kind === "exercise" && plan.reason === "due_check") {
      throw new Error("due_check nie powinno wybrać ćwiczenia o ujawnionym targetKey");
    }
  });

  it("sameDoesExposureIsStillAssistedInAnotherObjective", () => {
    const shared = "answer:does";
    const prior: LessonExerciseCandidate = {
      itemId: "question-does", itemRevisionId: "rev-question-does", objectiveId: O1,
      exerciseType: "lesson_gap", targetKey: shared,
    };
    const nextObjective: LessonExerciseCandidate = {
      itemId: "short-answer-does", itemRevisionId: "rev-short-answer-does", objectiveId: O2,
      exerciseType: "lesson_gap", targetKey: shared,
    };
    const sessionHistory = [
      task({ objectiveId: O1, exerciseType: "lesson_gap", outcome: "correct", itemId: prior.itemId }),
    ];
    const plan = selectLessonTask(input({
      objectiveOrder: [O2],
      progress: { [O1]: prog("mastered"), [O2]: prog("mastered", "2026-10-12T11:00:00.000Z") },
      exercises: [prior, nextObjective],
      sessionHistory,
    }));
    expect(plan?.kind === "exercise" && plan.reason === "due_check" && plan.itemId === nextObjective.itemId).toBe(false);
  });
});

describe("selectLessonTask — okno sprawdzianu: cel wprowadzony w tej sesji i nieopanowany", () => {
  it("nowy cel wprowadzony w sesji (not_assessed), nieopanowany → etap samodzielny", () => {
    const sessionHistory = [
      task({ objectiveId: O1, exerciseType: "lesson_choice", outcome: "correct", itemId: "g1" }),
    ];
    const plan = selectLessonTask(
      input({
        testWindowOpen: true,
        cardCountByObjective: { [O1]: 0 },
        sessionHistory,
      }),
    );
    expect(plan).toMatchObject({ kind: "exercise", objectiveId: O1, reason: "test_preparation" });
  });
});

describe("selectLessonTask — etap zamrożony przy starcie sesji (P2-6)", () => {
  it("nowy cel w sesji NIE przeskakuje do productive, gdy bieżąca projekcja (odczytana po ocenie) ma już status learning", () => {
    // Scenariusz luki: cel wprowadzony w TEJ sesji; po poprawnym lesson_notice
    // projekcja postępu jest aktualizowana (status learning) i ponownie
    // odczytana przy nextTask. Etap musi wynikać z HISTORII sesji (start
    // guided), nie z re-odczytu bieżącej projekcji — inaczej guided jest
    // pomijany mimo wymaganych dwóch sukcesów.
    const sessionHistory = [
      task({ objectiveId: O1, exerciseType: "lesson_notice", outcome: "correct" }),
    ];
    const plan = selectLessonTask(
      input({
        exercises: [...poolFor(O1), notice(O1)],
        progress: { [O1]: prog("learning") }, // projekcja po ocenie notice
        cardCountByObjective: { [O1]: 0 },
        sessionHistory,
      }),
    );
    // Kolejne zadanie to guided (lesson_choice), NIE productive (lesson_gap).
    expect(plan).toMatchObject({ kind: "exercise", objectiveId: O1, exerciseType: "lesson_choice" });
    expect((plan as { exerciseType: string }).exerciseType).not.toBe("lesson_gap");
  });

  it("wymagane dwa sukcesy guided są egzekwowane dla celu wprowadzonego w sesji mimo statusu learning", () => {
    // Po jednym poprawnym guided (i statusie learning z projekcji) wciąż
    // guided — jeden sukces nie wystarcza (advanceAfterCorrect = 2).
    const sessionHistory = [
      task({ objectiveId: O1, exerciseType: "lesson_notice", outcome: "correct" }),
      task({ objectiveId: O1, exerciseType: "lesson_choice", outcome: "correct", itemId: `item:${O1}:guided:a` }),
    ];
    const plan = selectLessonTask(
      input({
        exercises: [...poolFor(O1), notice(O1)],
        progress: { [O1]: prog("learning") },
        cardCountByObjective: { [O1]: 0 },
        sessionHistory,
      }),
    );
    expect(plan).toMatchObject({ kind: "exercise", objectiveId: O1, exerciseType: "lesson_choice" });
    expect((plan as { exerciseType: string }).exerciseType).not.toBe("lesson_gap");
  });

  it("po DWÓCH sukcesach guided cel wprowadzony w sesji awansuje na productive", () => {
    const sessionHistory = [
      task({ objectiveId: O1, exerciseType: "lesson_notice", outcome: "correct" }),
      task({ objectiveId: O1, exerciseType: "lesson_choice", outcome: "correct", itemId: `item:${O1}:guided:a` }),
      task({ objectiveId: O1, exerciseType: "lesson_choice", outcome: "correct", itemId: `item:${O1}:guided:b` }),
    ];
    const plan = selectLessonTask(
      input({
        exercises: [...poolFor(O1), notice(O1)],
        progress: { [O1]: prog("learning") },
        cardCountByObjective: { [O1]: 0 },
        sessionHistory,
      }),
    );
    expect(plan).toMatchObject({ kind: "exercise", objectiveId: O1, exerciseType: "lesson_gap", reason: "continue" });
  });
});

describe("snapshot początkowy celu", () => {
  it("znany cel pozostaje productive po jednym sukcesie, mimo historii sesji", () => {
    const plan = selectLessonTask({ ...input({ progress: { [O1]: prog("learning") },
      sessionHistory: [task({ objectiveId: O1, exerciseType: "lesson_gap", outcome: "correct", itemId: "previous-gap" })],
    }), initialProgress: { [O1]: prog("learning") } });
    expect(plan).toMatchObject({ exerciseType: "lesson_gap" });
  });

  it("dwa nowe cele nadal zużywają limit, gdy bieżąca projekcja już ma learning", () => {
    const plan = selectLessonTask({ ...input({
      exercises: poolFor(O3),
      progress: { [O1]: prog("learning"), [O2]: prog("learning") },
      sessionHistory: [O1, O2].map((objectiveId) => task({ objectiveId, exerciseType: "lesson_notice", outcome: "correct" })),
    }), initialProgress: {} });
    expect(plan).toBeNull();
  });
});

describe("selectLessonTask — determinizm", () => {
  it("to samo wejście → ten sam wynik", () => {
    const build = () =>
      input({
        exercises: [...poolFor(O1), ...poolFor(O2)],
        cardCountByObjective: { [O1]: 2, [O2]: 2 },
      });
    expect(selectLessonTask(build())).toEqual(selectLessonTask(build()));
  });
});


describe("calculation due checks", () => {
  it("issues a calculation without a grader and protects previously exposed targets", () => {
    const calculation = { ...ex(O1, "independent"), exerciseType: "lesson_calculation" as const };
    const options = input({ exercises: [calculation], progress: { [O1]: prog("needs_confirmation", "2000-01-01T00:00:00Z") }, graderAvailable: false, graderCallsLeft: 0 });
    expect(selectLessonTask(options)).toMatchObject({ kind: "exercise", exerciseType: "lesson_calculation", independentCheck: true, reason: "due_check" });
    const exposed = selectLessonTask({ ...options, exposedTargetKeys: new Set([calculation.targetKey]) });
    expect(exposed?.kind === "exercise" && exposed.independentCheck).not.toBe(true);
  });
});

describe("selectLessonTask — trener precyzji (Etap 4)", () => {
  function open(variant: string, familyId: string, expectedForm = "explanation"): LessonExerciseCandidate {
    return { ...ex(O1, "independent", variant), familyId, expectedForm };
  }
  function keywords(familyId: string, variant = "kw"): LessonExerciseCandidate {
    const key = `${O1}:keywords:${variant}`;
    return { itemId: `item:${key}`, itemRevisionId: `rev:${key}`, objectiveId: O1, exerciseType: "lesson_keywords", targetKey: key, familyId };
  }
  // Cel opanowany bez należnej powtórki: utrwalanie wybiera odpowiedź otwartą bez samodzielnego sprawdzenia.
  const mastered = { [O1]: prog("mastered") };
  const base = { objectiveOrder: [O1], progress: mastered, initialProgress: mastered, planningMode: true };

  it("po odpowiedzi nie na temat poprzedza odpowiedź otwartą słowami kluczowymi tej samej rodziny", () => {
    const plan = selectLessonTask(input({
      ...base, exercises: [open("a", "def"), keywords("inna", "x"), keywords("def")],
      precisionHistory: { [O1]: { knowledge: "correct", precision: "unfocused" } },
    }));
    expect(plan).toEqual({
      kind: "exercise", itemId: "item:subj.topic.o1:keywords:kw", itemRevisionId: "rev:subj.topic.o1:keywords:kw",
      objectiveId: O1, exerciseType: "lesson_keywords", reason: "precision_practice", independentCheck: false,
      pairedWith: { itemId: "item:subj.topic.o1:independent:a", itemRevisionId: "rev:subj.topic.o1:independent:a" },
    });
  });

  it("para także po odpowiedzi niepełnej", () => {
    const plan = selectLessonTask(input({ ...base, exercises: [open("a", "def"), keywords("def")], precisionHistory: { [O1]: { knowledge: "partial", precision: "concise" } } }));
    expect(plan).toMatchObject({ exerciseType: "lesson_keywords", pairedWith: { itemRevisionId: "rev:subj.topic.o1:independent:a" } });
  });

  it.each([
    ["zwięzła poprawna odpowiedź", { precisionHistory: { [O1]: { knowledge: "correct", precision: "concise" } } }],
    ["brak historii precyzji", {}],
    ["sesja bez planu (legacy)", { planningMode: false, precisionHistory: { [O1]: { knowledge: "correct", precision: "unfocused" } } }],
    ["budżet tylko na jedno zadanie", { assessedRemaining: 1, precisionHistory: { [O1]: { knowledge: "correct", precision: "unfocused" } } }],
    ["brak gradera", { graderAvailable: false, precisionHistory: { [O1]: { knowledge: "correct", precision: "unfocused" } } }],
  ] as const)("bez pary: %s", (_label, overrides) => {
    const plan = selectLessonTask(input({ ...base, exercises: [open("a", "def"), keywords("def")], ...overrides } as Partial<LessonScheduleInput>));
    expect(plan).toMatchObject({ exerciseType: "lesson_open_answer", itemId: "item:subj.topic.o1:independent:a" });
  });

  it("nie paruje samodzielnego sprawdzenia należnego celu", () => {
    const due = { [O1]: prog("learning", "2026-10-11T00:00:00.000Z") };
    const plan = selectLessonTask(input({
      objectiveOrder: [O1], progress: due, initialProgress: due, planningMode: true,
      exercises: [open("a", "def"), keywords("def")], precisionHistory: { [O1]: { knowledge: "correct", precision: "unfocused" } },
    }));
    expect(plan).toMatchObject({ exerciseType: "lesson_open_answer", reason: "due_check", independentCheck: true });
  });

  it("po należnym sprawdzeniu dokłada parę z innej rodziny tego samego celu, raz na sesję", () => {
    const due = { [O1]: prog("learning", "2026-10-11T00:00:00.000Z") };
    const exercises = [open("a", "def"), open("b", "inna"), keywords("inna")];
    const history = { [O1]: { knowledge: "partial", precision: "concise" } } as const;
    const first = selectLessonTask(input({ objectiveOrder: [O1], progress: due, initialProgress: due, planningMode: true, exercises, precisionHistory: history }));
    expect(first).toMatchObject({ itemId: "item:subj.topic.o1:independent:a", reason: "due_check" });
    const afterCheck = [task({ objectiveId: O1, itemId: "item:subj.topic.o1:independent:a", exerciseType: "lesson_open_answer" })];
    const second = selectLessonTask(input({
      objectiveOrder: [O1], progress: due, initialProgress: due, planningMode: true, exercises, precisionHistory: history,
      sessionHistory: afterCheck, reservedDueCheckObjectives: new Set([O1]),
    }));
    expect(second).toMatchObject({ exerciseType: "lesson_keywords", reason: "precision_practice", pairedWith: { itemId: "item:subj.topic.o1:independent:b" } });
    const afterPair = [...afterCheck,
      task({ objectiveId: O1, itemId: "item:subj.topic.o1:keywords:kw", exerciseType: "lesson_keywords" }),
      task({ objectiveId: O1, itemId: "item:subj.topic.o1:independent:b", exerciseType: "lesson_open_answer" })];
    const third = selectLessonTask(input({
      objectiveOrder: [O1], progress: due, initialProgress: due, planningMode: true, exercises: [...exercises, keywords("def", "kw2")], precisionHistory: history,
      sessionHistory: afterPair, reservedDueCheckObjectives: new Set([O1]),
    }));
    expect(third?.kind === "exercise" ? third.exerciseType : null).not.toBe("lesson_keywords");
  });

  it("nigdy nie wydaje słów kluczowych jako zwykłego ćwiczenia prowadzonego", () => {
    const plan = selectLessonTask(input({ objectiveOrder: [O1], exercises: [keywords("def"), ex(O1, "guided", "a")] }));
    expect(plan).toMatchObject({ exerciseType: "lesson_choice", reason: "introduce" });
    expect(selectLessonTask(input({ objectiveOrder: [O1], exercises: [keywords("def")] }))).toBeNull();
  });

  it("po poprawnej, rozwlekłej odpowiedzi preferuje pytanie o formie zwięzłej", () => {
    const exercises = [open("a", "def"), open("b", "zwiezle", "one_sentence")];
    const verbose = selectLessonTask(input({ ...base, exercises, precisionHistory: { [O1]: { knowledge: "correct", precision: "verbose" } } }));
    expect(verbose).toMatchObject({ itemId: "item:subj.topic.o1:independent:b" });
    const concise = selectLessonTask(input({ ...base, exercises, precisionHistory: { [O1]: { knowledge: "correct", precision: "concise" } } }));
    expect(concise).toMatchObject({ itemId: "item:subj.topic.o1:independent:a" });
  });

  describe("pomylone pojęcia → pytanie porównawcze (Etap 6, design §9.3)", () => {
    const comparison = (variant: string, searchText: string, expectedForm = "explanation"): LessonExerciseCandidate =>
      ({ ...open(variant, `cmp-${variant}`, expectedForm), questionType: "comparison", searchText });
    const confused = { knowledge: "incorrect", precision: "concise", confusedConcepts: [{ said: "Równoleżnik", meant: "południk" }] } as const;

    it("po pomyleniu preferuje pytanie porównawcze wymieniające tę parę", () => {
      const exercises = [open("a", "def"), comparison("b", "Czym różni się zwrotnik od koła podbiegunowego?"), comparison("c", "Czym różni się południk od równoleżnika?")];
      const plan = selectLessonTask(input({ ...base, exercises, precisionHistory: { [O1]: confused } }));
      expect(plan).toMatchObject({ itemId: "item:subj.topic.o1:independent:c" });
    });

    it("bez pasującej pary bierze dowolne pytanie porównawcze celu, bez pytań porównawczych — bez zmian", () => {
      const other = selectLessonTask(input({ ...base, exercises: [open("a", "def"), comparison("b", "Czym różni się nizina od wyżyny?")], precisionHistory: { [O1]: confused } }));
      expect(other).toMatchObject({ itemId: "item:subj.topic.o1:independent:b" });
      const none = selectLessonTask(input({ ...base, exercises: [open("a", "def"), open("b", "inna")], precisionHistory: { [O1]: confused } }));
      expect(none).toMatchObject({ itemId: "item:subj.topic.o1:independent:a" });
    });

    it("należne samodzielne sprawdzenie celu też wybiera pytanie porównawcze", () => {
      const due = { [O1]: prog("needs_confirmation", "2000-01-01T00:00:00Z") };
      const exercises = [open("a", "inna"), comparison("b", "Czym różni się południk od równoleżnika?")];
      const plan = selectLessonTask(input({ objectiveOrder: [O1], progress: due, initialProgress: due, planningMode: true, exercises, precisionHistory: { [O1]: confused } }));
      expect(plan).toMatchObject({ itemId: "item:subj.topic.o1:independent:b", independentCheck: true });
    });

    it("pomylenie ma pierwszeństwo przed formą zwięzłą, a bez pomylenia porównanie nie jest preferowane", () => {
      const exercises = [open("a", "zwiezle", "one_sentence"), comparison("b", "Czym różni się południk od równoleżnika?")];
      // wiedza „correct” + rozwlekłość włącza preferencję formy zwięzłej — pomylenie i tak wygrywa
      const withConfusion = selectLessonTask(input({ ...base, exercises, precisionHistory: { [O1]: { ...confused, knowledge: "correct", precision: "verbose" } } }));
      expect(withConfusion).toMatchObject({ itemId: "item:subj.topic.o1:independent:b" });
      const plain = selectLessonTask(input({ ...base, exercises: [open("a", "def"), comparison("b", "Czym różni się południk od równoleżnika?")], precisionHistory: { [O1]: { knowledge: "incorrect", precision: "concise" } } }));
      expect(plain).toMatchObject({ itemId: "item:subj.topic.o1:independent:a" });
    });
  });
});

describe("selectLessonTask — slot ćwiczenia słuchowego (#198, spec §3.2–3.3)", () => {
  function listen(objectiveId: string, variant = "a", stimulusAudioReady: boolean | "missing" = true): LessonExerciseCandidate {
    const key = `${objectiveId}:listen:${variant}`;
    return {
      itemId: `item:${key}`,
      itemRevisionId: `rev:${key}`,
      objectiveId,
      exerciseType: "lesson_listen_choice",
      targetKey: key,
      ...(stimulusAudioReady === "missing" ? {} : { stimulusAudioReady }),
    };
  }
  const guidedA = `item:${O1}:guided:a`;
  const learning = (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id, prog("learning")]));

  it("nowy cel: najpierw zwykłe wprowadzenie, slot słuchowy dopiero po pierwszym zwykłym zadaniu (dynamicznie)", () => {
    const exercises = [listen(O1), ...poolFor(O1)];
    const first = selectLessonTask(input({ exercises, objectiveOrder: [O1] }));
    expect(first).toMatchObject({ kind: "exercise", exerciseType: "lesson_choice", reason: "introduce" });

    const sessionHistory = [task({ objectiveId: O1, itemId: guidedA, exerciseType: "lesson_choice", outcome: "correct" })];
    expect(selectLessonTask(input({ exercises, objectiveOrder: [O1], sessionHistory }))).toEqual({
      kind: "exercise", itemId: `item:${O1}:listen:a`, itemRevisionId: `rev:${O1}:listen:a`, objectiveId: O1,
      exerciseType: "lesson_listen_choice", reason: "listen_practice", independentCheck: false,
    });
  });

  it("plan sesji (planningMode) też zawiera slot po pierwszym zwykłym zadaniu celu", () => {
    const exercises = [listen(O1), ...poolFor(O1)];
    const base = { exercises, objectiveOrder: [O1], planningMode: true, initialProgress: {} };
    expect(selectLessonTask(input(base))).toMatchObject({ exerciseType: "lesson_choice", reason: "introduce" });
    const sessionHistory = [task({ objectiveId: O1, itemId: guidedA, exerciseType: "lesson_choice" })];
    expect(selectLessonTask(input({ ...base, sessionHistory }))).toMatchObject({
      exerciseType: "lesson_listen_choice", reason: "listen_practice", independentCheck: false,
    });
  });

  it("cel kontynuowany i opanowany nie dostaje slotu na początku sesji, dopiero po zwykłym zadaniu", () => {
    for (const status of ["learning", "mastered"] as const) {
      const snapshot = { [O1]: prog(status) };
      const base = { exercises: [listen(O1), ...poolFor(O1)], objectiveOrder: [O1], progress: snapshot, initialProgress: snapshot };
      const first = selectLessonTask(input(base));
      expect(first?.kind === "exercise" ? first.exerciseType : null).toBe("lesson_gap");
      const sessionHistory = [task({ objectiveId: O1, itemId: `item:${O1}:productive:a`, exerciseType: "lesson_gap", outcome: "correct" })];
      expect(selectLessonTask(input({ ...base, sessionHistory }))).toMatchObject({ exerciseType: "lesson_listen_choice", reason: "listen_practice" });
    }
  });

  it("najwyżej jedno zadanie słuchowe na cel w sesji", () => {
    const exercises = [listen(O1, "a"), listen(O1, "b"), ...poolFor(O1)];
    const sessionHistory = [
      task({ objectiveId: O1, itemId: guidedA, exerciseType: "lesson_choice", outcome: "correct" }),
      task({ objectiveId: O1, itemId: `item:${O1}:listen:a`, exerciseType: "lesson_listen_choice", outcome: "correct" }),
    ];
    const plan = selectLessonTask(input({ exercises, objectiveOrder: [O1], sessionHistory }));
    expect(plan).toMatchObject({ exerciseType: "lesson_choice", reason: "continue" });
  });

  it("plan sesji z trzema celami ma najwyżej dwa sloty słuchowe, każdy po zwykłym zadaniu celu", () => {
    const ids = [O1, O2, O3];
    const exercises = ids.flatMap((id) => [
      listen(id), ex(id, "productive", "a"), ex(id, "productive", "b"), ex(id, "productive", "c"),
    ]);
    const history: LessonSessionTask[] = [];
    for (let remaining = 12; remaining > 0; remaining -= 1) {
      const plan = selectLessonTask(input({
        exercises, objectiveOrder: ids, progress: learning(ids), initialProgress: learning(ids),
        planningMode: true, sessionHistory: history, assessedRemaining: remaining,
      }));
      if (plan === null) break;
      expect(plan.kind).toBe("exercise");
      if (plan.kind !== "exercise") break;
      if (plan.exerciseType === "lesson_listen_choice") {
        expect(plan.reason).toBe("listen_practice");
        expect(history.some((t) => t.objectiveId === plan.objectiveId && t.exerciseType !== "lesson_listen_choice")).toBe(true);
      }
      history.push(task({ objectiveId: plan.objectiveId, itemId: plan.itemId, exerciseType: plan.exerciseType }));
    }
    const listens = history.filter((t) => t.exerciseType === "lesson_listen_choice").map((t) => t.objectiveId);
    expect(listens).toEqual([O1, O2]);
  });

  it.each([
    ["bez stimulusAudioReady (brak = niegotowe)", "missing"],
    ["stimulusAudioReady: false", false],
  ] as const)("kandydat %s → brak slotu, sesja idzie dalej zwykłym zadaniem", (_label, ready) => {
    const sessionHistory = [task({ objectiveId: O1, itemId: guidedA, exerciseType: "lesson_choice", outcome: "correct" })];
    const plan = selectLessonTask(input({ exercises: [listen(O1, "a", ready), ...poolFor(O1)], objectiveOrder: [O1], sessionHistory }));
    expect(plan).toMatchObject({ exerciseType: "lesson_choice", reason: "continue" });
  });

  it("wybiera niewidziane zadanie słuchowe przed widzianym", () => {
    const sessionHistory = [task({ objectiveId: O1, itemId: guidedA, exerciseType: "lesson_choice", outcome: "correct" })];
    const plan = selectLessonTask(input({
      exercises: [listen(O1, "a"), listen(O1, "b"), ...poolFor(O1)], objectiveOrder: [O1], sessionHistory,
      lastSeenAt: { [`item:${O1}:listen:a`]: "2026-10-01T00:00:00.000Z" },
    }));
    expect(plan).toMatchObject({ itemId: `item:${O1}:listen:b`, reason: "listen_practice" });
  });

  it("nigdy nie wprowadza celu zadaniem słuchowym ani nie wydaje go zwykłym wyborem", () => {
    expect(selectLessonTask(input({ exercises: [listen(O1)], objectiveOrder: [O1] }))).toBeNull();
    const continued = selectLessonTask(input({
      exercises: [listen(O1)], objectiveOrder: [O1], progress: learning([O1]), initialProgress: learning([O1]),
    }));
    expect(continued).toBeNull();
  });

  it("ćwiczenie cyklu wsparcia jest zwykłym guided, nawet gdy zadanie słuchowe jest niewidziane", () => {
    const sessionHistory = [
      task({ objectiveId: O1, itemId: guidedA, exerciseType: "lesson_choice", outcome: "incorrect" }),
      task({ objectiveId: O1, kind: "support_card" }),
    ];
    const plan = selectLessonTask(input({
      exercises: [listen(O1), ...poolFor(O1)], objectiveOrder: [O1], sessionHistory,
      lastSeenAt: { [guidedA]: "2026-10-12T11:59:00.000Z", [`item:${O1}:guided:b`]: "2026-10-12T11:58:00.000Z" },
    }));
    expect(plan).toMatchObject({ exerciseType: "lesson_choice", reason: "support" });
  });

  it("błędna odpowiedź słuchowa nie otwiera wsparcia, a dwa sukcesy słuchowe nie awansują etapu", () => {
    const exercises = [listen(O1, "a"), listen(O1, "b"), ...poolFor(O1)];
    const wrong = [
      task({ objectiveId: O1, itemId: guidedA, exerciseType: "lesson_choice", outcome: "correct" }),
      task({ objectiveId: O1, itemId: `item:${O1}:listen:a`, exerciseType: "lesson_listen_choice", outcome: "incorrect" }),
    ];
    const afterWrong = selectLessonTask(input({ exercises, objectiveOrder: [O1], sessionHistory: wrong }));
    expect(afterWrong).toMatchObject({ kind: "exercise", exerciseType: "lesson_choice", reason: "continue" });

    const twoCorrect = [
      task({ objectiveId: O1, itemId: guidedA, exerciseType: "lesson_choice", outcome: "correct" }),
      task({ objectiveId: O1, itemId: `item:${O1}:listen:a`, exerciseType: "lesson_listen_choice", outcome: "correct" }),
      task({ objectiveId: O1, itemId: `item:${O1}:listen:b`, exerciseType: "lesson_listen_choice", outcome: "correct" }),
    ];
    // Bez neutralności już choice + pierwszy sukces słuchowy (2 kolejne sukcesy guided,
    // advanceAfterCorrect = 2) dałyby awans na productive (lesson_gap); żaden z nich go nie daje.
    const afterCorrect = selectLessonTask(input({ exercises, objectiveOrder: [O1], sessionHistory: twoCorrect }));
    expect(afterCorrect).toMatchObject({ exerciseType: "lesson_choice", reason: "continue" });
  });

  it("limit planowanych zadań etapu nie liczy zadania słuchowego", () => {
    const sessionHistory = [
      task({ objectiveId: O1, itemId: guidedA, exerciseType: "lesson_choice" }),
      task({ objectiveId: O1, itemId: `item:${O1}:listen:a`, exerciseType: "lesson_listen_choice" }),
    ];
    const plan = selectLessonTask(input({
      exercises: [listen(O1), ...poolFor(O1)], objectiveOrder: [O1], planningMode: true, initialProgress: {}, sessionHistory,
    }));
    expect(plan).toMatchObject({ itemId: `item:${O1}:guided:b`, reason: "continue" });
  });

  it("plan z należnymi sprawdzeniami dwóch celów nie ma dwóch zadań słuchowych z rzędu", () => {
    const ids = [O1, O2];
    const due = Object.fromEntries(ids.map((id) => [id, prog("learning", "2026-10-11T00:00:00.000Z")]));
    const exercises = ids.flatMap((id) => [
      listen(id), ex(id, "independent", "a"), ex(id, "productive", "a"), ex(id, "productive", "b"),
    ]);
    const history: LessonSessionTask[] = [];
    const reasons: string[] = [];
    for (let remaining = 12; remaining > 0; remaining -= 1) {
      const plan = selectLessonTask(input({
        exercises, objectiveOrder: ids, progress: due, initialProgress: due, planningMode: true,
        sessionHistory: history, assessedRemaining: remaining,
        reservedDueCheckObjectives: new Set(history.filter((_, i) => reasons[i] === "due_check").map((t) => t.objectiveId)),
      }));
      if (plan === null || plan.kind !== "exercise") break;
      reasons.push(plan.reason);
      history.push(task({ objectiveId: plan.objectiveId, itemId: plan.itemId, exerciseType: plan.exerciseType }));
    }
    expect(reasons.slice(0, 2)).toEqual(["due_check", "due_check"]);
    const types = history.map((t) => t.exerciseType);
    for (let i = 1; i < types.length; i += 1) {
      expect(types[i - 1] === "lesson_listen_choice" && types[i] === "lesson_listen_choice").toBe(false);
    }
    expect(history.filter((t) => t.exerciseType === "lesson_listen_choice").map((t) => t.objectiveId)).toEqual([O1, O2]);
  });

  it("bez budżetu ocenianych (assessedRemaining = 0) brak slotu", () => {
    const sessionHistory = [task({ objectiveId: O1, itemId: guidedA, exerciseType: "lesson_choice", outcome: "correct" })];
    expect(selectLessonTask(input({ exercises: [listen(O1), ...poolFor(O1)], objectiveOrder: [O1], sessionHistory, assessedRemaining: 0 }))).toBeNull();
  });

  it("stara sesja bez initialProgress: zadanie słuchowe jako pierwsze zadanie celu nie czyni celu nowym", () => {
    const sessionHistory = [
      task({ objectiveId: O1, itemId: `item:${O1}:listen:a`, exerciseType: "lesson_listen_choice", outcome: "correct" }),
      task({ objectiveId: O1, itemId: `item:${O1}:productive:a`, exerciseType: "lesson_gap", outcome: "correct" }),
    ];
    const plan = selectLessonTask(input({
      exercises: [listen(O1), ...poolFor(O1), ex(O1, "productive", "b")], objectiveOrder: [O1],
      progress: learning([O1]), sessionHistory,
    }));
    expect(plan).toMatchObject({ exerciseType: "lesson_gap", reason: "continue" });
  });
});
