import { createServer } from "node:http";
import { buildWorkerServices } from "./composition";
import { shutdownWorker } from "./shutdown";
import { countForeignPendingTts, prepareUiAudio, withConfigDefaults } from "@learning/server";
import { createWorkerLoop, workerLoopSettingsFromEnv } from "./loop";
import { processDueWork } from "./tasks";

const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT ?? 9301);

async function main(): Promise<void> {
  const { services, pool, usage } = buildWorkerServices();
  await prepareUiAudio(services);
  // Zadania TTS innego providera/modelu czekają bez zmiany stanu (design szkoły §11.7).
  const foreignTts = await countForeignPendingTts(services);
  if (foreignTts > 0) {
    console.warn(`[worker] ${foreignTts} oczekujących nagrań TTS zleconych przy innym providerze/modelu niż UMIEM_TTS_PROVIDER/UMIEM_TTS_MODEL tego workera — nie zostaną wykonane; sprawdź, czy web i worker mają te same ustawienia TTS`);
  }
  const env = withConfigDefaults(process.env);
  const settings = workerLoopSettingsFromEnv(env);
  const loop = createWorkerLoop({
    ...settings,
    now: Date.now,
    processPass: (signal, reportProgress) => processDueWork(services, signal, reportProgress).then(() => undefined),
    onError: (error) => console.error("[worker] przelot zakończony błędem:", error),
  });

  const health = createServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    const status = loop.health();
    response.writeHead(status.healthy ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({
      status: status.healthy ? "ok" : "stale",
      lastPassAt: status.lastPassAt === null ? null : new Date(status.lastPassAt).toISOString(),
      passStartedAt: status.passStartedAt === null ? null : new Date(status.passStartedAt).toISOString(),
    }));
  });
  health.listen(HEALTH_PORT, "127.0.0.1");
  loop.start();

  const shutdown = (signal: string) => {
    console.log(`[worker] ${signal}: abortuję bieżącą pracę i zamykam`);
    health.close();
    // Kolejność: pętla → zaległe koszty → pula (spec llm-cost-tracking §4.3).
    void shutdownWorker({ loop, usage, pool }).finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main();
