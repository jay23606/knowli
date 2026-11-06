import type { worldPool } from "./world-database";

type WorldPool = Awaited<ReturnType<typeof worldPool>>;

/** Podsumowanie runu agenta puli po zapisie do szkicu (`generation_runs.agent_checkpoint`, `kind: "summary"`). */
export interface LessonAgentRunSummary {
  readonly kind: string;
  readonly objectives: Record<string, { readonly status: string; readonly accepted: number }>;
  readonly rejectionCodes: Record<string, number>;
}

/**
 * Podsumowanie ostatniego udanego runu puli lekcji (bez runów historyjki) z bazy świata:
 * w świecie E2E pulę generuje fake-agent workera (etap 3 #237). „Bez odrzuceń” sprawdzamy
 * po `rejectionCodes` (wszystkie odrzucenia agenta w runie), nie po `rejectedCount`.
 */
export async function lessonAgentRunSummary(pool: WorldPool, deckId: string): Promise<LessonAgentRunSummary> {
  const { rows } = await pool.query<{ agent_checkpoint: LessonAgentRunSummary | null }>(
    `select r.agent_checkpoint
       from learning_app.generation_runs r
       join learning_app.deck_versions v on v.id = r.deck_version_id
      where v.deck_id = $1 and r.kind = 'lesson' and r.state = 'succeeded' and r.agent_checkpoint is not null
      order by r.created_at desc
      limit 1`,
    [deckId],
  );
  const summary = rows[0]?.agent_checkpoint;
  if (!summary) throw new Error(`Brak podsumowania runu agenta dla lekcji ${deckId}`);
  return summary;
}
