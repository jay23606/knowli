import { describe, expect, it } from "vitest";
import {
  SESSION_ACTIVITY_REPORT_VERSION,
  SessionActivityReportSchema,
  SessionActivityReviewVerdictSchema,
  SessionEndInputSchema,
  sessionActivityAward,
  sessionApprovedActivityMs,
  taskActiveMs,
  unionDurationMs,
} from "./reward-activity";

const TASK_A = "00000000-0000-4000-8000-000000000001";
const TASK_B = "00000000-0000-4000-8000-000000000002";
const ATTEMPT_A = "00000000-0000-4000-8000-000000000003";
const ASSET_A = "00000000-0000-4000-8000-000000000004";

function reportOf(tasks: unknown[], elapsedMs = 130_000, activeMs?: number) {
  const computed = (tasks as { activeIntervals: [number, number][]; playbacks: { fromMs: number; toMs: number }[] }[])
    .reduce((total, task) => total + taskActiveMs(task as never), 0);
  return {
    version: SESSION_ACTIVITY_REPORT_VERSION,
    elapsedMs,
    activeMs: activeMs ?? computed,
    compacted: false,
    tasks,
  };
}

describe("session activity report contract", () => {
  it("accepts the design example with pauses, edit windows and attempts", () => {
    const report = reportOf([{
      taskId: TASK_A,
      exerciseType: "recall",
      shownFromMs: 0,
      shownToMs: 90_000,
      activeIntervals: [[0, 35_000], [60_000, 90_000]],
      editCount: 8,
      editWindows: [{ atMs: 5_000, count: 5 }, { atMs: 65_000, count: 3 }],
      submittedAttempts: [ATTEMPT_A],
      playbacks: [],
      pauses: [{ kind: "background", fromMs: 35_000, toMs: 60_000 }],
    }]);
    expect(SessionActivityReportSchema.parse(report)).toBeDefined();
    expect(SessionEndInputSchema.parse({ activityReport: report })).toBeDefined();
    expect(SessionEndInputSchema.parse({})).toEqual({});
  });

  it("rejects an unknown report version (client refresh required)", () => {
    const report = reportOf([]);
    expect(SessionActivityReportSchema.safeParse({ ...report, version: 2 }).success).toBe(false);
    expect(SessionEndInputSchema.safeParse({ activityReport: { ...report, version: 2 } }).success).toBe(false);
  });

  it("requires activeMs to equal the union of task intervals and playbacks", () => {
    const tasks = [{
      taskId: TASK_A, exerciseType: "recall", shownFromMs: 0, shownToMs: 10_000,
      activeIntervals: [[0, 4_000], [3_000, 8_000]], editCount: 0, editWindows: [],
      submittedAttempts: [], playbacks: [{ assetId: ASSET_A, fromMs: 8_000, toMs: 10_000 }], pauses: [],
    }];
    // unia 0–8s plus odsłuch 8–10s = 10 000 ms; suma naiwna dałaby 11 000
    expect(SessionActivityReportSchema.parse(reportOf(tasks)).activeMs).toBe(10_000);
    expect(SessionActivityReportSchema.safeParse(reportOf(tasks, 130_000, 11_000)).success).toBe(false);
    expect(SessionActivityReportSchema.safeParse(reportOf(tasks, 130_000, 9_000)).success).toBe(false);
  });

  it("rejects overlapping active intervals of different tasks", () => {
    const a = {
      taskId: TASK_A, exerciseType: "recall", shownFromMs: 0, shownToMs: 50_000,
      activeIntervals: [[0, 50_000]], editCount: 0, editWindows: [], submittedAttempts: [], playbacks: [], pauses: [],
    };
    const b = {
      taskId: TASK_B, exerciseType: "spelling", shownFromMs: 50_000, shownToMs: 90_000,
      activeIntervals: [[40_000, 90_000]], editCount: 0, editWindows: [], submittedAttempts: [], playbacks: [], pauses: [],
    };
    expect(SessionActivityReportSchema.safeParse(reportOf([a, b])).success).toBe(false);
    // stykające się przedziały są dopuszczalne
    b.activeIntervals = [[50_000, 90_000]];
    expect(SessionActivityReportSchema.safeParse(reportOf([a, b])).success).toBe(true);
  });

  it("rejects intervals outside the report time range and negative durations", () => {
    const bad = {
      taskId: TASK_A, exerciseType: "recall", shownFromMs: 0, shownToMs: 10_000,
      activeIntervals: [[5_000, 200_000]], editCount: 0, editWindows: [], submittedAttempts: [], playbacks: [], pauses: [],
    };
    expect(SessionActivityReportSchema.safeParse(reportOf([bad])).success).toBe(false);
    const reversed = { ...bad, activeIntervals: [[8_000, 5_000]] };
    expect(SessionActivityReportSchema.safeParse(reportOf([reversed])).success).toBe(false);
  });

  it("rejects malformed pauses and duplicate task ids", () => {
    const base = {
      taskId: TASK_A, exerciseType: "recall", shownFromMs: 0, shownToMs: 20_000,
      activeIntervals: [[0, 10_000]], editCount: 0, editWindows: [], submittedAttempts: [], playbacks: [], pauses: [],
    };
    // Pauza odwrócona w czasie.
    const reversedPause = { ...base, pauses: [{ kind: "background" as const, fromMs: 15_000, toMs: 12_000 }] };
    expect(SessionActivityReportSchema.safeParse(reportOf([reversedPause], 20_000)).success).toBe(false);
    // Pauza wykraczająca poza elapsedMs.
    const outOfRange = { ...base, pauses: [{ kind: "idle" as const, fromMs: 15_000, toMs: 30_000 }] };
    expect(SessionActivityReportSchema.safeParse(reportOf([outOfRange], 20_000)).success).toBe(false);
    // Poprawna pauza w zakresie przechodzi.
    const valid = { ...base, pauses: [{ kind: "blur" as const, fromMs: 10_000, toMs: 15_000 }] };
    expect(SessionActivityReportSchema.safeParse(reportOf([valid], 20_000)).success).toBe(true);
    // Zduplikowany taskId w raporcie.
    const duplicate = reportOf([base, { ...base, activeIntervals: [[10_000, 20_000]] }], 20_000);
    expect(SessionActivityReportSchema.safeParse(duplicate).success).toBe(false);
  });

  it("caps the number of compacted entries", () => {
    const tasks = Array.from({ length: 60 }, (_, index) => ({
      taskId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      exerciseType: "recall", shownFromMs: index * 1_000, shownToMs: index * 1_000 + 500,
      activeIntervals: [[index * 1_000, index * 1_000 + 500]],
      editCount: 1, editWindows: [{ atMs: index * 1_000, count: 1 }],
      submittedAttempts: [], playbacks: [], pauses: [],
    }));
    expect(SessionActivityReportSchema.safeParse(reportOf(tasks, 500_000)).success).toBe(true);
    const tooMany = tasks.map((task, index) => ({
      ...task,
      pauses: Array.from({ length: 70 }, (_, pause) => ({ kind: "idle" as const, fromMs: index, toMs: index + 1 })),
    }));
    expect(SessionActivityReportSchema.safeParse(reportOf(tooMany, 500_000)).success).toBe(false);
  });
});

describe("session activity review verdict contract", () => {
  it("accepts a strict reason/excludedTasks object", () => {
    expect(SessionActivityReviewVerdictSchema.parse({
      reason: "Większość zadań zawierała rzeczywiste próby.",
      excludedTasks: [{ taskOrdinal: 4, reason: "Wysłano wyłącznie aaa." }],
    })).toBeDefined();
  });

  it("rejects seconds, points and other extra fields", () => {
    expect(SessionActivityReviewVerdictSchema.safeParse({
      reason: "ok", excludedTasks: [], approvedSeconds: 120,
    }).success).toBe(false);
    expect(SessionActivityReviewVerdictSchema.safeParse({
      reason: "ok", excludedTasks: [{ taskOrdinal: 0, reason: "x", points: 5 }],
    }).success).toBe(false);
    expect(SessionActivityReviewVerdictSchema.safeParse({ reason: "", excludedTasks: [] }).success).toBe(false);
    expect(SessionActivityReviewVerdictSchema.safeParse({
      reason: "x".repeat(501), excludedTasks: [],
    }).success).toBe(false);
    expect(SessionActivityReviewVerdictSchema.safeParse({
      reason: "ok", excludedTasks: [{ taskOrdinal: -1, reason: "x" }],
    }).success).toBe(false);
  });
});

describe("session activity award arithmetic", () => {
  it("awards 1 point per full approved minute and carries the remainder", () => {
    expect(sessionActivityAward(130_000, 0)).toEqual({ pointsAwarded: 2, remainderMs: 10_000 });
    expect(sessionActivityAward(90_000, 40_000)).toEqual({ pointsAwarded: 2, remainderMs: 10_000 });
    expect(sessionActivityAward(0, 59_999)).toEqual({ pointsAwarded: 0, remainderMs: 59_999 });
    expect(() => sessionActivityAward(-1, 0)).toThrow();
    expect(() => sessionActivityAward(1_000, 60_000)).toThrow();
  });

  it("caps the approved client time at the server-measured session duration", () => {
    const task = (activeIntervals: [number, number][]) => ({ activeIntervals, playbacks: [] });
    expect(sessionApprovedActivityMs([task([[0, 3_600_000]])], 90_000)).toBe(90_000);
    expect(sessionApprovedActivityMs([task([[0, 50_000]]), task([[50_000, 100_000]])], 90_000)).toBe(90_000);
    expect(sessionApprovedActivityMs([task([[0, 40_000]]), task([[40_000, 70_000]])], 90_000)).toBe(70_000);
    expect(sessionApprovedActivityMs([], 90_000)).toBe(0);
  });

  it("computes the union duration without double counting overlaps", () => {
    expect(unionDurationMs([[0, 10], [5, 20], [30, 40]])).toBe(30);
    expect(taskActiveMs({
      activeIntervals: [[0, 10]],
      playbacks: [{ assetId: ASSET_A, fromMs: 5, toMs: 15 }],
    })).toBe(15);
  });
});
