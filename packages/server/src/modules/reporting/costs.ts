import { sql } from "drizzle-orm";
import { ParentCostsDtoSchema, ParentCostsQuerySchema, USAGE_FEATURES, type ParentCostsDto, type UsageFeature } from "@learning/contracts";
import type { Services } from "../../config";
import { monthBounds, currentMonth } from "../../domain/report-month";
import { validRewardTimezone } from "../../domain/reward-activity";
import { familySettings } from "../../db/schema";
import { AppError } from "../../errors";

/**
 * Model odczytu kosztów usług AI (spec `2026-11-02-llm-cost-tracking-design.md`
 * §5–§6): sumuje dziennik `provider_usage_events` dla panelu rodzica. Tylko
 * czyta — nie zmienia wierszy dziennika ani danych innych obszarów.
 */

const MAX_STATEMENT_MS = 10_000;
const MICRO = 1_000_000n;

/** Funkcje materiałowe (przygotowanie zestawów); reszta to funkcje nauki dziecka. */
const MATERIAL_FEATURES = ["deck_generation", "lesson_generation", "tts", "illustration", "deck_cover"] as const;
const LEARNING_FEATURES = USAGE_FEATURES.filter((feature) => !(MATERIAL_FEATURES as readonly string[]).includes(feature));

function sqlList(values: readonly string[]) {
  return sql.join(values.map((value) => sql`${value}`), sql`, `);
}

const MATERIAL_LIST = sqlList(MATERIAL_FEATURES);
const LEARNING_LIST = sqlList(LEARNING_FEATURES);

/** Kwota PG (`numeric(18,6)::text`, np. `"1.234500"`) → mikrodolary. */
function toMicro(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * MICRO + BigInt(fraction.padEnd(6, "0").slice(0, 6));
}

function formatMicro(micro: bigint): string {
  return `${micro / MICRO}.${String(micro % MICRO).padStart(6, "0")}`;
}

/** Iloraz bigint zaokrąglony połowami w górę (liczby nieujemne). */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** Suma `cost_usd` jako tekst z dokładnością do mikrodolara; pusta suma to `0.000000`. */
function moneySum(filter?: ReturnType<typeof sql>) {
  const column = filter ? sql`sum(cost_usd) filter (where ${filter})` : sql`sum(cost_usd)`;
  return sql`coalesce(${column}, 0)::numeric(18,6)::text`;
}

interface FeatureRow extends Record<string, unknown> {
  feature: UsageFeature;
  calls: string;
  input_tokens: string;
  output_tokens: string;
  characters: string;
  audio_ms: string;
  images: string;
  cost: string;
  estimated_cost: string;
  estimated: boolean;
  unknown_calls: string;
  failed_calls: string;
  unscoped_calls: string;
}

interface DeckRow extends Record<string, unknown> {
  bucket: "deck" | "shared_ui" | "other";
  deck_id: string | null;
  title: string | null;
  kind: "vocabulary" | "lesson" | null;
  generation: string;
  tts: string;
  images: string;
  total: string;
  month: string;
  estimated: boolean;
  unknown_calls: string;
}

interface ChildCostRow extends Record<string, unknown> {
  child_id: string | null;
  grading: string;
  speech: string;
  activity: string;
  total: string;
  estimated: boolean;
  unknown_calls: string;
}

/**
 * Raport kosztów wybranego miesiąca: nagłówek i funkcje oraz dzieci dla miesiąca,
 * materiały z kwotami od początku (`totalUsd`, rozbicie) i z miesiąca (`monthUsd`).
 * Miesiąc liczony w strefie rodziny (bez `month` — bieżący wg zegara serwera);
 * przyszły miesiąc to błąd `validation`.
 */
export async function readParentCosts(services: Services, input: unknown): Promise<ParentCostsDto> {
  const query = ParentCostsQuerySchema.parse(input);
  const [family] = await services.db.select({ timezone: familySettings.timezone }).from(familySettings).limit(1);
  const timezone = validRewardTimezone(family?.timezone);
  const nowMonth = currentMonth(services.clock.now(), timezone);
  const month = query.month ?? nowMonth;
  if (month > nowMonth) throw new AppError("validation");
  const { startUtc, endExclusiveUtc } = monthBounds(month, timezone);
  const inMonth = sql`occurred_at >= ${startUtc}::timestamptz and occurred_at < ${endExclusiveUtc}::timestamptz`;

  return services.db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    await tx.execute(sql`select set_config('statement_timeout', ${`${MAX_STATEMENT_MS}ms`}, true)`);

    const featureRows = (await tx.execute<FeatureRow>(sql`
      select feature,
        count(*)::text as calls,
        coalesce(sum(input_tokens), 0)::text as input_tokens,
        coalesce(sum(output_tokens), 0)::text as output_tokens,
        coalesce(sum(characters), 0)::text as characters,
        coalesce(sum(audio_ms), 0)::text as audio_ms,
        coalesce(sum(images), 0)::text as images,
        ${moneySum()} as cost,
        ${moneySum(sql`cost_source = 'price_table'`)} as estimated_cost,
        coalesce(bool_or(cost_source = 'price_table'), false) as estimated,
        (count(*) filter (where cost_source = 'unknown'))::text as unknown_calls,
        (count(*) filter (where outcome = 'failed'))::text as failed_calls,
        (count(*) filter (where scope_kind = 'none' and feature in (${LEARNING_LIST})))::text as unscoped_calls
      from learning_app.provider_usage_events
      where ${inMonth}
      group by feature`)).rows;

    // Talie: od początku (bez filtra miesiąca) z kolumną miesiąca. Funkcje nauki
    // nigdy nie trafiają do talii, nawet z ustawionym deck_id.
    const deckRows = (await tx.execute<DeckRow>(sql`
      with material as (
        select e.*,
          case
            when e.deck_id is not null then 'deck'
            when e.feature in ('tts', 'illustration') and e.generation_run_id is not null then 'shared_ui'
            else 'other'
          end as bucket
        from learning_app.provider_usage_events e
        where e.feature in (${MATERIAL_LIST})
      )
      select m.bucket, m.deck_id, d.title, d.kind,
        ${moneySum(sql`m.feature in ('deck_generation', 'lesson_generation')`)} as generation,
        ${moneySum(sql`m.feature = 'tts'`)} as tts,
        ${moneySum(sql`m.feature in ('illustration', 'deck_cover')`)} as images,
        ${moneySum()} as total,
        ${moneySum(inMonth)} as month,
        coalesce(bool_or(m.cost_source = 'price_table'), false) as estimated,
        (count(*) filter (where m.cost_source = 'unknown'))::text as unknown_calls
      from material m left join learning_app.decks d on d.id = m.deck_id
      group by m.bucket, m.deck_id, d.title, d.kind`)).rows;

    // Dzieci: wiersze funkcji nauki z child_id albo zgrubione (scope session bez dziecka).
    const childCostRows = (await tx.execute<ChildCostRow>(sql`
      select child_id,
        ${moneySum(sql`feature = 'answer_grading'`)} as grading,
        ${moneySum(sql`feature in ('lesson_stt', 'speech_stt', 'pronunciation')`)} as speech,
        ${moneySum(sql`feature = 'session_activity_review'`)} as activity,
        ${moneySum()} as total,
        coalesce(bool_or(cost_source = 'price_table'), false) as estimated,
        (count(*) filter (where cost_source = 'unknown'))::text as unknown_calls
      from learning_app.provider_usage_events
      where ${inMonth} and feature in (${LEARNING_LIST})
        and (child_id is not null or scope_kind = 'session')
      group by child_id`)).rows;

    const profileRows = (await tx.execute<{ id: string; name: string; sessions: string }>(sql`
      select c.id, c.display_name as name,
        (select count(*) from learning_app.learning_sessions s
          where s.child_id = c.id and s.started_at >= ${startUtc}::timestamptz and s.started_at < ${endExclusiveUtc}::timestamptz)::text as sessions
      from learning_app.child_profiles c`)).rows;

    // --- Funkcje i nagłówek ---
    const featureMicro = featureRows.map((row) => ({ row, micro: toMicro(row.cost) }));
    const totalMicro = featureMicro.reduce((sum, { micro }) => sum + micro, 0n);
    const sum = (read: (row: FeatureRow) => string) => featureRows.reduce((acc, row) => acc + Number(read(row)), 0);
    const estimatedMicro = featureRows.reduce((acc, row) => acc + toMicro(row.estimated_cost), 0n);

    const features = featureMicro
      .map(({ row, micro }) => ({
        feature: row.feature,
        calls: Number(row.calls),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        characters: Number(row.characters),
        audioMs: Number(row.audio_ms),
        images: Number(row.images),
        costUsd: formatMicro(micro),
        estimated: row.estimated,
        unknownCalls: Number(row.unknown_calls),
        sharePercent: totalMicro === 0n ? 0 : Number(divideHalfUp(micro * 100n, totalMicro)),
        micro,
      }))
      .sort((a, b) => (a.micro === b.micro ? b.calls - a.calls || a.feature.localeCompare(b.feature) : a.micro > b.micro ? -1 : 1))
      .map(({ micro: _micro, ...rest }) => rest);

    // --- Materiały ---
    const bucketOrder = { deck: 0, shared_ui: 1, other: 2 } as const;
    const decks = deckRows
      .map((row) => ({
        bucket: row.bucket,
        deckId: row.deck_id,
        title: row.title,
        kind: row.kind,
        generationUsd: formatMicro(toMicro(row.generation)),
        ttsUsd: formatMicro(toMicro(row.tts)),
        imagesUsd: formatMicro(toMicro(row.images)),
        totalUsd: formatMicro(toMicro(row.total)),
        monthUsd: formatMicro(toMicro(row.month)),
        estimated: row.estimated,
        unknownCalls: Number(row.unknown_calls),
        micro: toMicro(row.total),
      }))
      .sort((a, b) => {
        if (a.bucket !== b.bucket) return bucketOrder[a.bucket] - bucketOrder[b.bucket];
        if (a.micro !== b.micro) return a.micro > b.micro ? -1 : 1;
        return (a.title ?? "").localeCompare(b.title ?? "", "pl") || (a.deckId ?? "").localeCompare(b.deckId ?? "");
      })
      .map(({ micro: _micro, ...rest }) => rest);

    // --- Dzieci ---
    const costByChild = new Map(childCostRows.map((row) => [row.child_id, row]));
    const buildChild = (childId: string | null, name: string | null, sessions: number) => {
      const row = costByChild.get(childId);
      const micro = row ? toMicro(row.total) : 0n;
      return {
        childId,
        name,
        deleted: childId === null,
        sessions,
        costUsd: formatMicro(micro),
        gradingUsd: formatMicro(row ? toMicro(row.grading) : 0n),
        speechUsd: formatMicro(row ? toMicro(row.speech) : 0n),
        activityUsd: formatMicro(row ? toMicro(row.activity) : 0n),
        perSessionUsd: sessions === 0 ? null : formatMicro(divideHalfUp(micro, BigInt(sessions))),
        estimated: row?.estimated ?? false,
        unknownCalls: row ? Number(row.unknown_calls) : 0,
      };
    };
    const children = profileRows
      .map((profile) => buildChild(profile.id, profile.name, Number(profile.sessions)))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "pl") || (a.childId ?? "").localeCompare(b.childId ?? ""));
    const deleted = buildChild(null, null, 0);
    if (costByChild.has(null) && (toMicro(deleted.costUsd) > 0n || deleted.unknownCalls > 0)) children.push(deleted);

    return ParentCostsDtoSchema.parse({
      month,
      currentMonth: nowMonth,
      timezone,
      totals: {
        costUsd: formatMicro(totalMicro),
        estimatedUsd: formatMicro(estimatedMicro),
        calls: sum((row) => row.calls),
        unknownCalls: sum((row) => row.unknown_calls),
        failedCalls: sum((row) => row.failed_calls),
        unscopedCalls: sum((row) => row.unscoped_calls),
      },
      features,
      decks,
      children,
    });
  });
}
