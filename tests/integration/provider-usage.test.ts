import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { ParentCostsDtoSchema, type ParentCostsDto } from "@learning/contracts";
import { createDrizzleUsageRecorder, createServices, deleteChild, loginParent, readParentCosts, setupParent, withUsageScope, type UsageEvent, type UsagePrices } from "@learning/server";
import { ManualClock, buildTestServices, handleParentApi, testDatabase, truncateCoreTables } from "./helpers";

/**
 * Migracja 0035_provider_usage_events: tabela dziennika kosztów usług AI
 * (spec 2026-11-02-llm-cost-tracking §3.1) i kolumna generation_runs.origin_deck_id
 * (§3.2). Testy wkładają surowe wiersze, żeby sprawdzić bramki bazy niezależnie
 * od recordera.
 */

const { db, pool } = testDatabase();

afterAll(async () => {
  await pool.end();
});

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

type UsageRow = Record<string, unknown>;

/** Poprawny wiersz bazowy: koszt podany przez dostawcę. */
function validRow(overrides: UsageRow = {}): UsageRow {
  return {
    id: randomUUID(),
    occurred_at: new Date("2026-11-02T10:00:00.000Z"),
    feature: "deck_generation",
    operation: null,
    provider: "openrouter",
    model: "google/gemini-3.8-flash",
    outcome: "ok",
    http_status: 200,
    input_tokens: 120,
    output_tokens: 80,
    characters: null,
    audio_ms: null,
    images: null,
    cost_usd: "0.001234",
    cost_source: "provider",
    price_ref: null,
    scope_kind: "none",
    generation_run_id: null,
    deck_id: null,
    session_id: null,
    child_id: null,
    ...overrides,
  };
}

async function insertUsage(row: UsageRow): Promise<void> {
  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
  await pool.query(
    `insert into learning_app.provider_usage_events (${columns.join(", ")}) values (${placeholders})`,
    columns.map((column) => row[column]),
  );
}

async function expectRejected(overrides: UsageRow, constraint: string): Promise<void> {
  await expect(insertUsage(validRow(overrides))).rejects.toThrow(constraint);
}

describe("provider_usage_events schema", () => {
  beforeEach(async () => {
    await pool.query(
      `truncate learning_app.provider_usage_events, learning_app.generation_runs, learning_app.media_assets,
                learning_app.learning_sessions, learning_app.assignments,
                learning_app.deck_versions, learning_app.decks,
                learning_app.child_profiles cascade`,
    );
  });

  it("accepts a valid row", async () => {
    await insertUsage(validRow());
    await insertUsage(
      validRow({
        feature: "illustration",
        images: 1,
        input_tokens: null,
        output_tokens: null,
        cost_usd: "0.04",
        cost_source: "price_table",
        price_ref: "UMIEM_PRICE_IMAGE_USD=0.04",
      }),
    );
    await insertUsage(validRow({ feature: "tts", cost_usd: "0", cost_source: "not_billed" }));
    await insertUsage(validRow({ feature: "pronunciation", cost_usd: null, cost_source: "unknown", outcome: "failed", http_status: null }));
    const rows = await query<{ count: string }>("select count(*)::text as count from learning_app.provider_usage_events");
    expect(rows).toEqual([{ count: "4" }]);
  });

  it("accepts every feature from the allowed list", async () => {
    const features = [
      "deck_generation",
      "lesson_generation",
      "tts",
      "illustration",
      "deck_cover",
      "answer_grading",
      "session_activity_review",
      "lesson_stt",
      "speech_stt",
      "pronunciation",
    ];
    for (const feature of features) await insertUsage(validRow({ feature }));
  });

  it("rejects an unknown cost with an amount", async () => {
    await expectRejected({ cost_source: "unknown", cost_usd: "0.1" }, "provider_usage_events_cost_unknown_null");
  });

  it("rejects a provider cost without an amount", async () => {
    await expectRejected({ cost_source: "provider", cost_usd: null }, "provider_usage_events_cost_unknown_null");
  });

  it("rejects a non-zero amount for a not billed call", async () => {
    await expectRejected({ cost_source: "not_billed", cost_usd: "0.2" }, "provider_usage_events_not_billed_zero");
  });

  it("rejects a price reference for a provider cost", async () => {
    await expectRejected({ cost_source: "provider", price_ref: "UMIEM_PRICE_IMAGE_USD=0.04" }, "provider_usage_events_price_ref_shape");
  });

  it("rejects a price table cost without a price reference", async () => {
    await expectRejected({ cost_source: "price_table", price_ref: null }, "provider_usage_events_price_ref_shape");
  });

  it("rejects a feature outside the list", async () => {
    await expectRejected({ feature: "other" }, "provider_usage_events_feature_allowed");
  });

  it("rejects an outcome outside the list", async () => {
    await expectRejected({ outcome: "timeout" }, "provider_usage_events_outcome_allowed");
  });

  it("rejects a cost source outside the list", async () => {
    await expectRejected({ cost_source: "guess" }, "provider_usage_events_cost_source_allowed");
  });

  it("rejects negative units and costs", async () => {
    await expectRejected({ input_tokens: -1 }, "provider_usage_events_units_nonnegative");
    await expectRejected({ output_tokens: -1 }, "provider_usage_events_units_nonnegative");
    await expectRejected({ characters: -1 }, "provider_usage_events_units_nonnegative");
    await expectRejected({ audio_ms: -1 }, "provider_usage_events_units_nonnegative");
    await expectRejected({ images: -1 }, "provider_usage_events_units_nonnegative");
    await expectRejected({ cost_usd: "-0.01" }, "provider_usage_events_cost_nonnegative");
  });

  it("rejects a scope kind outside the list", async () => {
    await expectRejected({ scope_kind: "x" }, "provider_usage_events_scope_kind_allowed");
  });

  it("sets deck_id and generation_run_id to NULL when their targets disappear", async () => {
    const { deckId, versionId } = await insertDeck();
    const runId = randomUUID();
    await pool.query(
      `insert into learning_app.generation_runs (id, deck_version_id, expected_edit_number, kind, dedupe_key, state, input, origin_deck_id)
       values ($1, $2, 1, 'deck', $3, 'queued', '{}'::jsonb, null)`,
      [runId, versionId, `dk-${runId}`],
    );
    const usageId = randomUUID();
    await insertUsage(validRow({ id: usageId, scope_kind: "run", generation_run_id: runId, deck_id: deckId }));

    await pool.query("delete from learning_app.generation_runs where id = $1", [runId]);
    expect(await query("select generation_run_id, deck_id from learning_app.provider_usage_events where id = $1", [usageId])).toEqual([
      { generation_run_id: null, deck_id: deckId },
    ]);

    await pool.query("delete from learning_app.deck_versions where deck_id = $1", [deckId]);
    await pool.query("delete from learning_app.decks where id = $1", [deckId]);
    expect(await query("select deck_id from learning_app.provider_usage_events where id = $1", [usageId])).toEqual([{ deck_id: null }]);
  });

  it("stores the origin deck of a media run and clears it when the deck disappears", async () => {
    const { deckId } = await insertDeck();
    const assetId = randomUUID();
    await pool.query(
      `insert into learning_app.media_assets (id, kind, fingerprint, state, provider, model)
       values ($1, 'tts', $2, 'pending', 'fake', 'fake')`,
      [assetId, `fp-${assetId}`],
    );
    const runId = randomUUID();
    await pool.query(
      `insert into learning_app.generation_runs (id, asset_id, kind, dedupe_key, state, input, origin_deck_id)
       values ($1, $2, 'tts', $3, 'queued', '{}'::jsonb, $4)`,
      [runId, assetId, `mk-${runId}`, deckId],
    );
    expect(await query("select origin_deck_id from learning_app.generation_runs where id = $1", [runId])).toEqual([{ origin_deck_id: deckId }]);

    await pool.query("delete from learning_app.deck_versions where deck_id = $1", [deckId]);
    await pool.query("delete from learning_app.decks where id = $1", [deckId]);
    expect(await query("select origin_deck_id from learning_app.generation_runs where id = $1", [runId])).toEqual([{ origin_deck_id: null }]);
  });

  it("sets child_id and session_id to NULL when the child profile is deleted", async () => {
    const { deckId, versionId } = await insertDeck();
    const childId = randomUUID();
    await pool.query("insert into learning_app.child_profiles (id, display_name, avatar_key) values ($1, 'Ola', 'fox')", [childId]);
    const assignmentId = randomUUID();
    await pool.query("insert into learning_app.assignments (id, child_id, deck_id) values ($1, $2, $3)", [assignmentId, childId, deckId]);
    await pool.query("insert into learning_app.learning_policies (id, config) values ('default', '{}') on conflict do nothing");
    const sessionId = randomUUID();
    await pool.query(
      `insert into learning_app.learning_sessions
         (id, child_id, assignment_id, deck_id, deck_version_id, policy_id, microphone_enabled, state, ended_at, task_budget)
       values ($1, $2, $3, $4, $5, 'default', false, 'ended', now(), 10)`,
      [sessionId, childId, assignmentId, deckId, versionId],
    );
    const usageId = randomUUID();
    await insertUsage(validRow({ id: usageId, feature: "answer_grading", scope_kind: "session", session_id: sessionId, child_id: childId, deck_id: deckId }));

    await pool.query("delete from learning_app.child_profiles where id = $1", [childId]);

    expect(await query("select child_id, session_id, deck_id from learning_app.provider_usage_events where id = $1", [usageId])).toEqual([
      { child_id: null, session_id: null, deck_id: deckId },
    ]);
  });
});

/** Zestaw z jedną wersją robocza — cel kluczy obcych dziennika. */
async function insertDeck(): Promise<{ deckId: string; versionId: string }> {
  const deckId = randomUUID();
  const versionId = randomUUID();
  await pool.query("insert into learning_app.decks (id, title, kind) values ($1, 'Zestaw', 'vocabulary')", [deckId]);
  await pool.query(
    `insert into learning_app.deck_versions (id, deck_id, version_number, edit_number, state, title)
     values ($1, $2, 1, 1, 'draft', 'Zestaw')`,
    [versionId, deckId],
  );
  return { deckId, versionId };
}

describe("usage recorder", () => {
  const clock = new ManualClock("2026-11-02T10:00:00.000Z");
  const logged: string[] = [];
  const prices = { imageUsd: "0.04" };
  const recorder = createDrizzleUsageRecorder({ db, clock, prices, log: (code) => logged.push(code) });
  const services = createServices({ db, clock, usage: recorder });

  beforeEach(async () => {
    logged.length = 0;
    await pool.query(
      `truncate learning_app.provider_usage_events, learning_app.generation_runs, learning_app.media_assets,
                learning_app.learning_sessions, learning_app.assignments,
                learning_app.deck_versions, learning_app.decks,
                learning_app.child_profiles cascade`,
    );
  });

  // Zaległy insert nie może wpaść do następnego testu (truncate w beforeEach).
  afterEach(() => recorder.flush());

  const imageEvent: UsageEvent = { feature: "illustration", provider: "openrouter", outcome: "ok", images: 1 };

  async function usageRows(): Promise<UsageRow[]> {
    return query("select * from learning_app.provider_usage_events order by occurred_at, id");
  }

  async function insertChild(): Promise<string> {
    const childId = randomUUID();
    await pool.query("insert into learning_app.child_profiles (id, display_name, avatar_key) values ($1, 'Ola', 'fox')", [childId]);
    return childId;
  }

  it("record never throws", async () => {
    const throwingPrices = {
      get imageUsd(): string {
        throw new Error("boom");
      },
    } as unknown as UsagePrices;
    const broken = createDrizzleUsageRecorder({ db, clock, prices: throwingPrices, log: (code) => logged.push(code) });

    expect(() => broken.record(imageEvent)).not.toThrow();
    await broken.flush();

    expect(logged).toEqual(["usage_record_failed"]);
    expect(await usageRows()).toEqual([]);
  });

  /** Zakończona sesja dziecka na świeżym zestawie. */
  async function insertSession(childId: string): Promise<string> {
    const { deckId, versionId } = await insertDeck();
    const assignmentId = randomUUID();
    await pool.query("insert into learning_app.assignments (id, child_id, deck_id) values ($1, $2, $3)", [assignmentId, childId, deckId]);
    await pool.query("insert into learning_app.learning_policies (id, config) values ('default', '{}') on conflict do nothing");
    const sessionId = randomUUID();
    await pool.query(
      `insert into learning_app.learning_sessions
         (id, child_id, assignment_id, deck_id, deck_version_id, policy_id, microphone_enabled, state, ended_at, task_budget)
       values ($1, $2, $3, $4, $5, 'default', false, 'ended', now(), 10)`,
      [sessionId, childId, assignmentId, deckId, versionId],
    );
    return sessionId;
  }

  it("writes a session row with the clock time and the priced cost", async () => {
    const childId = await insertChild();
    const sessionId = await insertSession(childId);

    withUsageScope({ sessionId, childId }, () => recorder.record(imageEvent));
    await recorder.flush();

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope_kind: "session",
      session_id: sessionId,
      child_id: childId,
      feature: "illustration",
      cost_usd: "0.040000",
      cost_source: "price_table",
      price_ref: "UMIEM_PRICE_IMAGE_USD=0.04",
    });
    expect((rows[0]!.occurred_at as Date).toISOString()).toBe("2026-11-02T10:00:00.000Z");
    expect(logged).toEqual([]);
  });

  it("cost row survives business rollback", async () => {
    await expect(
      services.db.transaction(async () => {
        recorder.record(imageEvent);
        throw new Error("business failure");
      }),
    ).rejects.toThrow("business failure");
    await recorder.flush();

    expect(await usageRows()).toHaveLength(1);
  });

  it("retries insert without scope ids on foreign key violation", async () => {
    withUsageScope({ sessionId: randomUUID(), childId: randomUUID() }, () => recorder.record(imageEvent));
    await recorder.flush();

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope_kind: "session",
      session_id: null,
      child_id: null,
      deck_id: null,
      generation_run_id: null,
    });
    expect(logged).toEqual([]);
  });

  it("logs a failure of another kind and keeps flush quiet", async () => {
    recorder.record({ ...imageEvent, feature: "unknown_feature" as unknown as UsageEvent["feature"] });
    await expect(recorder.flush()).resolves.toBeUndefined();

    expect(logged).toEqual(["usage_record_failed"]);
    expect(await usageRows()).toEqual([]);
  });

  it("deleteChild anonymizes usage rows", async () => {
    const childId = await insertChild();
    const otherChildId = await insertChild();
    const at = new Date("2026-10-15T12:34:00.000Z");
    const detailed = {
      operation: "grade",
      model: "google/gemini-3.8-flash",
      http_status: 200,
      input_tokens: 10,
      output_tokens: 5,
      characters: 3,
      audio_ms: 1000,
      images: 1,
    };
    await insertUsage(validRow({ ...detailed, occurred_at: at, scope_kind: "session", child_id: childId, cost_usd: "0.001000" }));
    await insertUsage(validRow({ ...detailed, occurred_at: at, scope_kind: "session", child_id: childId, cost_usd: "0.002000" }));
    await insertUsage(validRow({ ...detailed, occurred_at: at, scope_kind: "session", child_id: otherChildId, cost_usd: "0.003000" }));
    // Wiersz przypisany tylko przez sesję dziecka (child_id puste) też podlega zgrubieniu.
    const sessionId = await insertSession(childId);
    await insertUsage(validRow({ ...detailed, occurred_at: at, scope_kind: "session", session_id: sessionId, cost_usd: "0.004000" }));

    await deleteChild(services, childId);

    const anonymized = await query("select * from learning_app.provider_usage_events where cost_usd in (0.001, 0.002, 0.004) order by cost_usd");
    expect(anonymized).toHaveLength(3);
    for (const row of anonymized) {
      expect((row.occurred_at as Date).toISOString()).toBe("2026-09-30T22:00:00.000Z");
      expect(row).toMatchObject({
        operation: null,
        model: null,
        http_status: null,
        input_tokens: null,
        output_tokens: null,
        characters: null,
        audio_ms: null,
        images: null,
        session_id: null,
        child_id: null,
        scope_kind: "session",
      });
    }
    expect(anonymized.map((row) => row.cost_usd)).toEqual(["0.001000", "0.002000", "0.004000"]);

    const untouched = await query("select * from learning_app.provider_usage_events where cost_usd = 0.003");
    expect(untouched[0]).toMatchObject({ child_id: otherChildId, operation: "grade", model: "google/gemini-3.8-flash", images: 1 });
    expect((untouched[0]!.occurred_at as Date).toISOString()).toBe(at.toISOString());
  });

  it("deleteChild of a missing profile is not found", async () => {
    await expect(deleteChild(services, randomUUID())).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("cost report", () => {
  const NOW = "2026-11-15T12:00:00.000Z";
  const clock = new ManualClock(NOW);
  const services = createServices({ db, clock });

  beforeEach(async () => {
    await pool.query(
      `truncate learning_app.provider_usage_events, learning_app.generation_runs, learning_app.media_assets,
                learning_app.learning_sessions, learning_app.assignments,
                learning_app.deck_versions, learning_app.decks,
                learning_app.child_profiles, learning_app.family_settings cascade`,
    );
  });

  async function insertTitledDeck(title: string, kind: "vocabulary" | "lesson"): Promise<string> {
    const deckId = randomUUID();
    await pool.query("insert into learning_app.decks (id, title, kind) values ($1, $2, $3)", [deckId, title, kind]);
    return deckId;
  }

  /** Run mediów bez `origin_deck_id`: głos interfejsu albo run zlecony przed migracją. */
  async function insertMediaRun(): Promise<string> {
    const assetId = randomUUID();
    await pool.query(
      `insert into learning_app.media_assets (id, kind, fingerprint, state, provider, model)
       values ($1, 'tts', $2, 'pending', 'fake', 'fake')`,
      [assetId, `fp-${assetId}`],
    );
    const runId = randomUUID();
    await pool.query(
      `insert into learning_app.generation_runs (id, asset_id, kind, dedupe_key, state, input)
       values ($1, $2, 'tts', $3, 'queued', '{}'::jsonb)`,
      [runId, assetId, `mk-${runId}`],
    );
    return runId;
  }

  async function insertChild(name: string): Promise<string> {
    const childId = randomUUID();
    await pool.query("insert into learning_app.child_profiles (id, display_name, avatar_key) values ($1, $2, 'fox')", [childId, name]);
    return childId;
  }

  async function insertSessionAt(childId: string, startedAt: string): Promise<string> {
    const deckId = randomUUID();
    const versionId = randomUUID();
    await pool.query("insert into learning_app.decks (id, title, kind) values ($1, 'Sesja', 'vocabulary')", [deckId]);
    await pool.query(
      `insert into learning_app.deck_versions (id, deck_id, version_number, edit_number, state, title)
       values ($1, $2, 1, 1, 'draft', 'Sesja')`,
      [versionId, deckId],
    );
    const assignmentId = randomUUID();
    await pool.query("insert into learning_app.assignments (id, child_id, deck_id) values ($1, $2, $3)", [assignmentId, childId, deckId]);
    await pool.query("insert into learning_app.learning_policies (id, config) values ('default', '{}') on conflict do nothing");
    const sessionId = randomUUID();
    await pool.query(
      `insert into learning_app.learning_sessions
         (id, child_id, assignment_id, deck_id, deck_version_id, policy_id, microphone_enabled, state, started_at, ended_at, task_budget)
       values ($1, $2, $3, $4, $5, 'default', false, 'ended', $6, $6, 10)`,
      [sessionId, childId, assignmentId, deckId, versionId, startedAt],
    );
    return sessionId;
  }

  /** Wiersz o nieznanej cenie: `unknown` wymaga kwoty NULL. */
  function unknownRow(overrides: UsageRow): UsageRow {
    return validRow({ cost_usd: null, cost_source: "unknown", ...overrides });
  }

  it("returns zeros and empty lists for an empty month", async () => {
    const report = await readParentCosts(services, { month: "2026-08" });

    expect(ParentCostsDtoSchema.safeParse(report).success).toBe(true);
    expect(report).toEqual({
      month: "2026-08",
      timezone: "Europe/Warsaw",
      totals: { costUsd: "0.000000", estimatedUsd: "0.000000", calls: 0, unknownCalls: 0, failedCalls: 0, unscopedCalls: 0 },
      features: [],
      decks: [],
      children: [],
    });
  });

  it("rejects a future month, a malformed one and extra keys", async () => {
    await expect(readParentCosts(services, { month: "2026-12" })).rejects.toMatchObject({ code: "validation" });
    await expect(readParentCosts(services, { month: "2026-13" })).rejects.toThrow();
    await expect(readParentCosts(services, { month: "2026-11", token: "x" })).rejects.toThrow();
    await expect(readParentCosts(services, { month: "2026-11" })).resolves.toBeDefined();
  });

  it("divides the month cost per session with half-up rounding and null at zero sessions", async () => {
    const ola = await insertChild("Ola");
    const zed = await insertChild("Zed");
    const sessions = [
      await insertSessionAt(ola, "2026-11-02T09:00:00.000Z"),
      await insertSessionAt(ola, "2026-11-03T09:00:00.000Z"),
      await insertSessionAt(ola, "2026-11-04T09:00:00.000Z"),
    ];
    await insertUsage(validRow({
      feature: "answer_grading", scope_kind: "session", session_id: sessions[0], child_id: ola,
      cost_usd: "0.010000", occurred_at: new Date("2026-11-02T09:05:00.000Z"),
    }));

    const report = await readParentCosts(services, { month: "2026-11" });

    expect(report.children).toMatchObject([
      { childId: ola, name: "Ola", sessions: 3, costUsd: "0.010000", perSessionUsd: "0.003333" },
      { childId: zed, name: "Zed", sessions: 0, costUsd: "0.000000", perSessionUsd: null },
    ]);
  });

  it("aggregates features, decks and children by month in the family timezone", async () => {
    const deckA = await insertTitledDeck("Kolory", "lesson");
    const deckB = await insertTitledDeck("Zwierzęta", "vocabulary");
    const sharedRun = await insertMediaRun();
    const x = await insertChild("Ola");
    const y = await insertChild("Ala");
    const z = await insertChild("Zed");
    await insertSessionAt(x, "2026-10-20T09:00:00.000Z");
    const xSessions = [
      await insertSessionAt(x, "2026-11-02T09:00:00.000Z"),
      await insertSessionAt(x, "2026-11-03T09:00:00.000Z"),
      await insertSessionAt(x, "2026-11-04T09:00:00.000Z"),
    ];
    await insertSessionAt(y, "2026-11-05T09:00:00.000Z");
    const at = (iso: string) => ({ occurred_at: new Date(iso) });

    // Październik: poza wybranym miesiącem, ale w sumach talii od początku.
    await insertUsage(validRow({ ...at("2026-10-15T10:00:00.000Z"), feature: "deck_generation", scope_kind: "run", deck_id: deckA, cost_usd: "1.000000" }));
    await insertUsage(validRow({ ...at("2026-10-31T22:30:00.000Z"), feature: "tts", scope_kind: "run", deck_id: deckA, cost_usd: "0.500000" }));
    // 2026-10-31T23:30Z to już 1 listopada 00:30 w Warszawie.
    await insertUsage(validRow({
      ...at("2026-10-31T23:30:00.000Z"), feature: "illustration", scope_kind: "run", deck_id: deckA,
      cost_usd: "0.250000", cost_source: "price_table", price_ref: "UMIEM_PRICE_IMAGE_USD=0.25", images: 1, input_tokens: null, output_tokens: null,
    }));
    // Listopad: materiały.
    await insertUsage(validRow({ ...at("2026-11-05T10:00:00.000Z"), feature: "deck_cover", scope_kind: "deck", deck_id: deckA, cost_usd: "0.100000", images: 1 }));
    await insertUsage(validRow({
      ...at("2026-11-06T10:00:00.000Z"), feature: "lesson_generation", scope_kind: "run", deck_id: deckB, cost_usd: "2.000000",
      input_tokens: 1000, output_tokens: 500,
    }));
    await insertUsage(unknownRow({ ...at("2026-11-07T10:00:00.000Z"), feature: "deck_generation", scope_kind: "run", deck_id: deckB, outcome: "failed", http_status: 500 }));
    await insertUsage(validRow({ ...at("2026-11-08T10:00:00.000Z"), feature: "tts", scope_kind: "run", generation_run_id: sharedRun, cost_usd: "0.300000", characters: 100 }));
    await insertUsage(validRow({ ...at("2026-11-09T10:00:00.000Z"), feature: "deck_generation", scope_kind: "none", cost_usd: "0.050000" }));
    // Listopad: nauka. Wiersz z deck_id nie trafia do talii (funkcje nauki nie są materiałem).
    await insertUsage(validRow({
      ...at("2026-11-02T09:05:00.000Z"), feature: "answer_grading", scope_kind: "session", session_id: xSessions[0], child_id: x, deck_id: deckA,
      cost_usd: "0.010000",
    }));
    await insertUsage(unknownRow({ ...at("2026-11-03T09:05:00.000Z"), feature: "speech_stt", scope_kind: "session", session_id: xSessions[1], child_id: x, audio_ms: 4000 }));
    await insertUsage(validRow({ ...at("2026-11-10T10:00:00.000Z"), feature: "answer_grading", scope_kind: "none", cost_usd: "0.002000" }));
    // Zgrubiony wiersz usuniętego profilu: sesja bez session_id i child_id.
    await insertUsage(validRow({
      ...at("2026-11-01T00:00:00.000Z"), feature: "session_activity_review", scope_kind: "session", cost_usd: "0.020000",
      input_tokens: null, output_tokens: null,
    }));

    const nov = await readParentCosts(services, { month: "2026-11" });

    expect(ParentCostsDtoSchema.safeParse(nov).success).toBe(true);
    expect(nov.totals).toEqual({
      costUsd: "2.732000", estimatedUsd: "0.250000", calls: 10, unknownCalls: 2, failedCalls: 1, unscopedCalls: 1,
    });

    const features = new Map(nov.features.map((row) => [row.feature, row]));
    expect(features.get("lesson_generation")).toMatchObject({
      calls: 1, inputTokens: 1000, outputTokens: 500, costUsd: "2.000000", estimated: false, unknownCalls: 0, sharePercent: 73,
    });
    expect(features.get("illustration")).toMatchObject({ calls: 1, images: 1, costUsd: "0.250000", estimated: true });
    expect(features.get("deck_generation")).toMatchObject({ calls: 2, costUsd: "0.050000", unknownCalls: 1 });
    expect(features.get("tts")).toMatchObject({ calls: 1, characters: 100, costUsd: "0.300000" });
    expect(features.get("speech_stt")).toMatchObject({ calls: 1, audioMs: 4000, costUsd: "0.000000", unknownCalls: 1, sharePercent: 0 });
    expect(features.get("answer_grading")).toMatchObject({ calls: 2, costUsd: "0.012000" });
    expect(features.has("pronunciation")).toBe(false);
    const shareSum = nov.features.reduce((sum, row) => sum + row.sharePercent, 0);
    expect(shareSum).toBeGreaterThanOrEqual(99);
    expect(shareSum).toBeLessThanOrEqual(101);
    expect(nov.features[0]!.feature).toBe("lesson_generation");

    expect(nov.decks).toEqual([
      {
        bucket: "deck", deckId: deckB, title: "Zwierzęta", kind: "vocabulary",
        generationUsd: "2.000000", ttsUsd: "0.000000", imagesUsd: "0.000000", totalUsd: "2.000000", monthUsd: "2.000000",
        estimated: false, unknownCalls: 1,
      },
      {
        bucket: "deck", deckId: deckA, title: "Kolory", kind: "lesson",
        generationUsd: "1.000000", ttsUsd: "0.500000", imagesUsd: "0.350000", totalUsd: "1.850000", monthUsd: "0.350000",
        estimated: true, unknownCalls: 0,
      },
      {
        bucket: "shared_ui", deckId: null, title: null, kind: null,
        generationUsd: "0.000000", ttsUsd: "0.300000", imagesUsd: "0.000000", totalUsd: "0.300000", monthUsd: "0.300000",
        estimated: false, unknownCalls: 0,
      },
      {
        bucket: "other", deckId: null, title: null, kind: null,
        generationUsd: "0.050000", ttsUsd: "0.000000", imagesUsd: "0.000000", totalUsd: "0.050000", monthUsd: "0.050000",
        estimated: false, unknownCalls: 0,
      },
    ]);

    expect(nov.children).toEqual([
      {
        childId: y, name: "Ala", deleted: false, sessions: 1, costUsd: "0.000000", gradingUsd: "0.000000", speechUsd: "0.000000",
        activityUsd: "0.000000", perSessionUsd: "0.000000", estimated: false, unknownCalls: 0,
      },
      {
        childId: x, name: "Ola", deleted: false, sessions: 3, costUsd: "0.010000", gradingUsd: "0.010000", speechUsd: "0.000000",
        activityUsd: "0.000000", perSessionUsd: "0.003333", estimated: false, unknownCalls: 1,
      },
      {
        childId: z, name: "Zed", deleted: false, sessions: 0, costUsd: "0.000000", gradingUsd: "0.000000", speechUsd: "0.000000",
        activityUsd: "0.000000", perSessionUsd: null, estimated: false, unknownCalls: 0,
      },
      {
        childId: null, name: null, deleted: true, sessions: 0, costUsd: "0.020000", gradingUsd: "0.000000", speechUsd: "0.000000",
        activityUsd: "0.020000", perSessionUsd: null, estimated: false, unknownCalls: 0,
      },
    ]);

    const oct = await readParentCosts(services, { month: "2026-10" });
    expect(oct.totals).toMatchObject({ costUsd: "1.500000", estimatedUsd: "0.000000", calls: 2 });
    expect(oct.decks.map((row) => [row.deckId, row.totalUsd, row.monthUsd])).toEqual([
      [deckB, "2.000000", "0.000000"],
      [deckA, "1.850000", "1.500000"],
      [null, "0.300000", "0.000000"],
      [null, "0.050000", "0.000000"],
    ]);
    expect(oct.children.map((row) => [row.name, row.sessions])).toEqual([["Ala", 0], ["Ola", 1], ["Zed", 0]]);
  });
});

describe("parent costs API", () => {
  beforeEach(async () => {
    await truncateCoreTables();
  });

  function costsRequest(cookie?: string, month = "2026-10"): Request {
    return new Request(`http://localhost:3000/api/v1/parent/costs?month=${month}`, {
      method: "GET",
      headers: { host: "localhost:3000", ...(cookie ? { cookie: `parent_session=${cookie}` } : {}) },
    });
  }

  it("requires a parent session", async () => {
    const { services } = buildTestServices();
    const response = await handleParentApi(costsRequest(), services);
    expect(response.status).toBe(401);
  });

  it("returns the report with no-store for a parent session", async () => {
    const { services } = buildTestServices();
    await setupParent(services, "koszty-pin-1");
    const { token } = await loginParent(services, "koszty-pin-1");

    const response = await handleParentApi(costsRequest(token), services);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as ParentCostsDto;
    expect(ParentCostsDtoSchema.safeParse(body).success).toBe(true);
    expect(body.month).toBe("2026-10");
  });
});
