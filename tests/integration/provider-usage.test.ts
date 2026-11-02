import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testDatabase } from "./helpers";

/**
 * Migracja 0035_provider_usage_events: tabela dziennika kosztów usług AI
 * (spec 2026-11-02-llm-cost-tracking §3.1) i kolumna generation_runs.origin_deck_id
 * (§3.2). Testy wkładają surowe wiersze, żeby sprawdzić bramki bazy niezależnie
 * od recordera.
 */

const { pool } = testDatabase();

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
