import { sql } from "drizzle-orm";
import type { Executor } from "../../db/client";

/**
 * Zgrubienie kosztów usuwanego profilu (spec §5.3; wiersze przypisane do dziecka
 * wprost albo przez jego sesje): czas zdarzenia schodzi do
 * początku miesiąca lokalnego, a pola szczegółowe i identyfikatory dziecka
 * znikają; kwoty i `scope_kind` zostają, więc sumy miesięczne się zgadzają.
 * Wywołuj w transakcji usunięcia profilu, przed `DELETE` (potem `ON DELETE SET NULL`
 * zdążyłoby już odpiąć wiersze od `child_id`).
 */
export async function anonymizeChildUsage(tx: Executor, childId: string, timezone: string): Promise<void> {
  await tx.execute(sql`
    update learning_app.provider_usage_events
       set occurred_at = (date_trunc('month', occurred_at at time zone ${timezone}) at time zone ${timezone}),
           operation = null,
           model = null,
           http_status = null,
           input_tokens = null,
           output_tokens = null,
           characters = null,
           audio_ms = null,
           images = null,
           session_id = null,
           child_id = null
     where child_id = ${childId}
        or session_id in (select id from learning_app.learning_sessions where child_id = ${childId})
  `);
}
