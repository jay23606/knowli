import type { UsageRecorder } from "@learning/server";

/**
 * Zamknięcie workera (spec llm-cost-tracking §4.3): najpierw pętla kończy
 * bieżącą pracę, potem recorder dopisuje zaległe koszty, a dopiero na końcu
 * zamyka się pula, przez którą te koszty piszą. Nieudany flush nie blokuje
 * zamknięcia puli — recorder i tak nie rzuca, to tylko zabezpieczenie.
 */
export async function shutdownWorker(deps: {
  loop: { stop(): Promise<void> };
  usage: UsageRecorder;
  pool: { end(): Promise<void> };
}): Promise<void> {
  // Błąd jednego kroku nie może pominąć kolejnych: pula i tak musi się zamknąć.
  await deps.loop.stop().catch(() => undefined);
  await deps.usage.flush().catch(() => undefined);
  await deps.pool.end();
}
