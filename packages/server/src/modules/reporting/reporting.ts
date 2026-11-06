import { and, eq, sql } from "drizzle-orm";
import {
  UuidSchema,
  type ActivityDailyStatDto,
  type ActivitySummaryDto,
  type ConfusionDto,
  type HistoryEntryDto,
  type ProgressDto,
  type PronunciationScoreDto,
  type ReportSkill,
} from "@learning/contracts";
import type { Services } from "../../config";
import {
  assignments,
  childProfiles,
} from "../../db/schema";
import { AppError } from "../../errors";
import { readDeckRevisionIds, readPublishedProgress } from "./published-progress";
import { assertVocabularyDeck, readDeckKind } from "../materials";
import { sessionTimeLimitMs } from "../../domain/session-limits";
import { localDay } from "../../domain/local-date";
import { buildReportPeriod } from "../../domain/report-period";

/**
 * Panel postępów rodzica (SPEC §25). Zwięzłe zapytania odczytują projekcję
 * child_skill_progress (cache aktualnego wyniku) oraz oceny i próby dziecka
 * w obrębie jednego zestawu. Nie przepisujemy historii: raport jest widokiem.
 */

export async function getProgress(services: Services, childId: string, deckId: string): Promise<ProgressDto> {
  const child = UuidSchema.parse(childId);
  const deck = UuidSchema.parse(deckId);
  const profile = (await services.db
    .select({ id: childProfiles.id, displayName: childProfiles.displayName })
    .from(childProfiles)
    .where(eq(childProfiles.id, child)))[0];
  if (!profile) throw new AppError("not_found");

  // Izolacja lekcji (zadanie 9): raport postępu słówek nie obejmuje lekcji.
  assertVocabularyDeck(await readDeckKind(services.db, deck));

  const published = await readPublishedProgress(services.db, child, deck);
  const assignment = (await services.db
    .select({ testDate: assignments.testDate })
    .from(assignments)
    .where(and(eq(assignments.childId, child), eq(assignments.deckId, deck), eq(assignments.active, true))))[0];
  const revisionIds = await readDeckRevisionIds(services.db, deck);
  const { confusions, pronunciationScores, history } = revisionIds.length
    ? await readChildEvidence(services, child, revisionIds)
    : { confusions: [] as ConfusionDto[], pronunciationScores: [] as PronunciationScoreDto[], history: [] as HistoryEntryDto[] };

  return {
    childId: child,
    childName: profile.displayName,
    deckId: deck,
    deckTitle: published.deckTitle,
    testDate: assignment?.testDate ?? null,
    totalItems: published.totalItems,
    skills: published.skills,
    items: published.items,
    confusions,
    pronunciation: {
      assessed: pronunciationScores.length > 0,
      latestScores: pronunciationScores,
    },
    history,
    activity: await readActivitySummary(services, child),
  };
}
/** Okno karty aktywności (SPEC §25) i bufor nad obcięciem czasu sesji. */
const ACTIVITY_WINDOW_DAYS = 7;
/** Bufor nad skalowanym limitem sesji (sessionTimeLimitMs): pokrywa
 *  zapytania zamknięcia tuż po przekroczeniu limitu międzyzadaniowego. */
const ACTIVITY_SESSION_GRACE_MS = 60_000;

/** Dni kalendarzowe aktywności liczymy w strefie czasowej rodziny. */
const ACTIVITY_TIMEZONE = "Europe/Warsaw";
// MVP: jedna polska rodzina. Docelowo strefa z family_settings.timezone
// (helper readTimezone w sessions.ts) przy pierwszej rodzinie spoza Polski.

type ActivitySessionRow = {
  deckId: string;
  deckTitle: string;
  startedAt: Date;
  lastActivity: Date;
  taskBudget: number;
};

/**
 * Karta aktywności: okno 7 dni od teraz wg zegara usług. Czas nauki sesji
 * to started_at → ostatnia aktywność (zadania, zdarzenia, próby) obcięty
 * do skalowanego limitu sesji (sessionTimeLimitMs budżetu tej sesji + bufor),
 * więc późne zamknięcie porzuconej sesji nie zawyża czasu.
 * Interakcje liczą zdarzenia serwera i obserwacje klienta; rejestr kontaktu
 * (`contact`) nie jest działaniem dziecka.
 */
export async function readActivitySummary(services: Services, childId: string): Promise<ActivitySummaryDto> {
  const now = services.clock.now();
  const period = buildReportPeriod(now.toISOString(), "Europe/Warsaw", ACTIVITY_WINDOW_DAYS);
  const since = new Date(period.startUtc);

  const sessions = (
    await services.db.execute<ActivitySessionRow>(sql`
      with window_sessions as (
        select s.id, s.deck_id, coalesce(v.title, d.title) as title, s.started_at, s.task_budget
          from learning_app.learning_sessions s
          join learning_app.decks d on d.id = s.deck_id
          left join learning_app.deck_versions v on v.id = d.published_version_id
         where s.child_id = ${childId}
           and s.started_at >= ${since}
      ), last_touch as (
        select session_id, max(at) as last_at from (
          select t.session_id, t.issued_at as at
            from learning_app.session_tasks t
           where t.session_id in (select id from window_sessions)
          union all
          select st.session_id, e.occurred_at as at
            from learning_app.learning_events e
            join learning_app.session_tasks st on st.id = e.task_id
           where st.session_id in (select id from window_sessions)
          union all
          select st.session_id, a.received_at as at
            from learning_app.attempts a
            join learning_app.session_tasks st on st.id = a.task_id
           where st.session_id in (select id from window_sessions)
        ) marks
        group by session_id
      )
      select ws.deck_id as "deckId",
             ws.title as "deckTitle",
             ws.started_at as "startedAt",
             ws.task_budget as "taskBudget",
             coalesce(lt.last_at, ws.started_at) as "lastActivity"
        from window_sessions ws
        left join last_touch lt on lt.session_id = ws.id
    `)
  ).rows;

  const dailyMap = new Map<string, { activeMs: number; sessions: number }>();
  for (const date of period.dates) {
    dailyMap.set(date, { activeMs: 0, sessions: 0 });
  }

  const deckTotals = new Map<string, { deckTitle: string; sessions: number }>();
  for (const row of sessions) {
    const sessionDay = localDay(row.startedAt, ACTIVITY_TIMEZONE);
    const duration = Math.min(
      new Date(row.lastActivity).getTime() - new Date(row.startedAt).getTime(),
      sessionTimeLimitMs(row.taskBudget) + ACTIVITY_SESSION_GRACE_MS,
    );
    const dayStat = dailyMap.get(sessionDay);
    if (dayStat) {
      dayStat.activeMs += Math.max(0, duration);
      dayStat.sessions += 1;
    }

    const current = deckTotals.get(row.deckId) ?? { deckTitle: row.deckTitle, sessions: 0 };
    current.sessions += 1;
    deckTotals.set(row.deckId, current);
  }

  const daily: ActivityDailyStatDto[] = period.dates.map((date) => {
    const stat = dailyMap.get(date)!;
    return {
      date,
      activeSeconds: Math.round(stat.activeMs / 1000),
      sessions: stat.sessions,
    };
  });

  const answers = (
    await services.db.execute<{ count: number }>(sql`
      select count(*)::int as count
        from learning_app.attempts
       where child_id = ${childId} and received_at >= ${since}
    `)
  ).rows[0]!.count;

  const interactions = (
    await services.db.execute<{ count: number }>(sql`
      select count(*)::int as count
        from learning_app.learning_events
       where child_id = ${childId} and occurred_at >= ${since} and kind <> 'contact'
    `)
  ).rows[0]!.count;

  return {
    days: ACTIVITY_WINDOW_DAYS,
    activeSeconds: daily.reduce((sum, d) => sum + d.activeSeconds, 0),
    activeDays: daily.filter((d) => d.sessions > 0).length,
    sessions: sessions.length,
    answers,
    interactions,
    decks: [...deckTotals.entries()]
      .map(([deckId, stat]) => ({ deckId, deckTitle: stat.deckTitle, sessions: stat.sessions }))
      .sort((a, b) => b.sessions - a.sessions || a.deckTitle.localeCompare(b.deckTitle, "pl")),
    daily,
  };
}

/** Pomyłki, wyniki wymowy i historia prób dziecka w obrębie rewizji zestawu. */
async function readChildEvidence(
  services: Services,
  childId: string,
  revisionIds: string[],
): Promise<{ confusions: ConfusionDto[]; pronunciationScores: PronunciationScoreDto[]; history: HistoryEntryDto[] }> {
  const confusions = (await services.db.execute<ConfusionDto>(sql`
    select n.details->'confusion'->>'expected' as expected,
           n.details->'confusion'->>'answered' as answered,
           count(distinct n.attempt_id)::int as count
      from learning_app.assessments n
      join learning_app.attempts a on a.id = n.attempt_id
     where n.child_id = ${childId}
       and a.item_revision_id = any(${sql.param(revisionIds)}::uuid[])
       and n.details ? 'confusion'
     group by 1, 2
     order by count desc, expected asc, answered asc
     limit 5
  `)).rows;

  const pronunciationScores = (await services.db.execute<{
    target: string;
    provider: string;
    score: string | number;
    band: string | null;
    assessedAt: Date;
  }>(sql`
    select distinct on (ir.item_id)
           ir.payload->>'target' as target,
           n.details->'pronunciation'->>'provider' as provider,
           (n.details->'pronunciation'->>'score')::numeric as score,
           n.details->'pronunciation'->>'band' as band,
           a.received_at as "assessedAt"
      from learning_app.assessments n
      join learning_app.attempts a on a.id = n.attempt_id
      join learning_app.item_revisions ir on ir.id = a.item_revision_id
     where n.child_id = ${childId}
       and a.item_revision_id = any(${sql.param(revisionIds)}::uuid[])
       and n.skill = 'pronunciation'
       and n.details ? 'pronunciation'
     order by ir.item_id, a.received_at desc
  `)).rows.map((row) => ({
    target: row.target,
    provider: row.provider,
    score: Number(row.score),
    ...(row.band === null ? {} : { band: row.band as PronunciationScoreDto["band"] }),
    assessedAt: new Date(row.assessedAt).toISOString(),
  }));

  const history = (await services.db.execute<{
    receivedAt: Date;
    source: string;
    target: string;
    skill: ReportSkill;
    outcome: "correct" | "incorrect" | "unassessed";
    independent: boolean;
    modality: HistoryEntryDto["modality"];
  }>(sql`
    select a.received_at as "receivedAt",
           ir.payload->>'source' as source,
           ir.payload->>'target' as target,
           n.skill as skill,
           n.outcome as outcome,
           n.independent as independent,
           a.modality as modality
      from learning_app.assessments n
      join learning_app.attempts a on a.id = n.attempt_id
      join learning_app.item_revisions ir on ir.id = a.item_revision_id
     where n.child_id = ${childId}
       and a.item_revision_id = any(${sql.param(revisionIds)}::uuid[])
     order by a.received_at desc, a.id desc, n.skill asc
     limit 30
  `)).rows.map((row) => ({
    receivedAt: new Date(row.receivedAt).toISOString(),
    source: row.source,
    target: row.target,
    skill: row.skill,
    outcome: row.outcome,
    independent: row.independent,
    modality: row.modality,
  }));

  return { confusions, pronunciationScores, history };
}
