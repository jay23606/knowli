import { describe, expect, it, vi } from "vitest";
import type { Database } from "../../db/client";
import { withUsageScope, type UsageEvent } from "../../ports/usage";
import { createDrizzleUsageRecorder } from "./drizzle-recorder";

const event: UsageEvent = { feature: "answer_grading", provider: "openrouter", outcome: "ok", providerCostUsd: 0.001 };
const clock = { now: () => new Date("2026-11-02T10:00:00.000Z") };

/** Atrapa bazy: kolejne wywołania `insert().values()` kończą się podanymi wynikami. */
function fakeDb(outcomes: Array<Error | undefined>): { db: Database; rows: Array<Record<string, unknown>> } {
  const rows: Array<Record<string, unknown>> = [];
  const db = {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        rows.push(row);
        const outcome = outcomes[rows.length - 1];
        return outcome ? Promise.reject(outcome) : Promise.resolve();
      },
    }),
  } as unknown as Database;
  return { db, rows };
}

function sqlError(code: string, nested: boolean): Error {
  const driver = Object.assign(new Error("driver"), { code });
  return nested ? Object.assign(new Error("Failed query"), { cause: driver }) : driver;
}

describe("drizzle usage recorder retry", () => {
  it.each([
    ["23503", false],
    ["23503", true],
    ["40P01", false],
    ["40P01", true],
  ])("retries SQLSTATE %s (nested under cause: %s) without scope ids", async (code, nested) => {
    const { db, rows } = fakeDb([sqlError(code, nested), undefined]);
    const log = vi.fn();
    const recorder = createDrizzleUsageRecorder({ db, clock, prices: {}, log });
    const scope = { sessionId: "s1", childId: "c1", deckId: "d1", generationRunId: "r1" };

    withUsageScope(scope, () => recorder.record(event));
    await recorder.flush();

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ sessionId: "s1", childId: "c1", deckId: "d1", generationRunId: "r1", scopeKind: "run" });
    expect(rows[1]).toMatchObject({ sessionId: null, childId: null, deckId: null, generationRunId: null, scopeKind: "run" });
    expect(rows[1]!.id).toBe(rows[0]!.id);
    expect(log).not.toHaveBeenCalled();
  });

  it("logs and does not retry other errors", async () => {
    const { db, rows } = fakeDb([sqlError("23514", true)]);
    const log = vi.fn();
    const recorder = createDrizzleUsageRecorder({ db, clock, prices: {}, log });

    recorder.record(event);
    await recorder.flush();

    expect(rows).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("usage_record_failed");
  });

  it("logs when the retry fails too", async () => {
    const { db, rows } = fakeDb([sqlError("40P01", false), sqlError("40P01", false)]);
    const log = vi.fn();
    const recorder = createDrizzleUsageRecorder({ db, clock, prices: {}, log });

    recorder.record(event);
    await recorder.flush();

    expect(rows).toHaveLength(2);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("flush waits for records added while it is waiting", async () => {
    let completed = 0;
    let calls = 0;
    const db = {
      insert: () => ({
        values: () => {
          calls += 1;
          // Drugi zapis kończy się później niż pierwszy.
          const delay = calls === 1 ? 0 : 10;
          return new Promise<void>((resolve) => setTimeout(() => { completed += 1; resolve(); }, delay));
        },
      }),
    } as unknown as Database;
    const recorder = createDrizzleUsageRecorder({ db, clock, prices: {} });

    recorder.record(event);
    const flushed = recorder.flush();
    recorder.record(event);
    await flushed;

    expect(completed).toBe(2);
  });
});
