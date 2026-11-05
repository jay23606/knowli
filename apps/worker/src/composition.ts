import {
  createDatabase,
  createDrizzleUsageRecorder,
  createGenerationDepsFromEnv,
  createProductionSubjectRegistry,
  createServices,
  mediaSettingsFromEnv,
  pricesFromEnv,
  systemClock,
  type Services,
  type UsageRecorder,
  withConfigDefaults,
} from "@learning/server";
import { lessonAgentDepsFromEnv } from "@learning/server/lesson-agent";

type WorkerPool = ReturnType<typeof createDatabase>["pool"];

/**
 * Składanie zależności workera: baza + adaptery providerów wg env
 * (UMIEM_FAKE_PROVIDERS=1 dla środowisk bez kluczy) i lokalny wolumen mediów.
 * Baza powstaje przed adapterami, bo recorder kosztów (spec llm-cost-tracking
 * §4.3) pisze przez tę samą pulę, a fabryki dostają ten jeden recorder; fake'i
 * (także fake agenta puli) go nie używają, więc tryb fake nie zapisuje kosztów.
 *
 * Agent puli lekcji (#237) składa się tylko tutaj, z osobnego eksportu
 * `@learning/server/lesson-agent` — proces web nie ładuje adaptera AI SDK. Ten sam
 * rejestr przedmiotów waliduje listę agenta i trafia do usług.
 */
export function buildWorkerServices(): { services: Services; pool: WorkerPool; usage: UsageRecorder } {
  // domyślna konfiguracja z repo pod spodem, .env nadpisuje (config-defaults.ts)
  const env = withConfigDefaults(process.env);
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }
  // Stawki przed pulą: zła wartość to błąd startu bez otwartych połączeń.
  const prices = pricesFromEnv(env);
  const subjects = createProductionSubjectRegistry();
  const { db, pool } = createDatabase(databaseUrl);
  const usage = createDrizzleUsageRecorder({ db, clock: systemClock, prices });
  const base = createGenerationDepsFromEnv(env, usage);
  if (!base) {
    throw new Error("OPENAI_API_KEY is not configured (obrazy; LLM i TTS biorą OPENROUTER_API_KEY) — albo ustaw UMIEM_FAKE_PROVIDERS=1");
  }
  // Tryb fake: agent „jak LLM” bierze fake LLM potoku; bez listy przedmiotów — brak agenta (potok).
  const lessonAgent = lessonAgentDepsFromEnv(env, subjects, usage, base.llm);
  const generation = lessonAgent ? { ...base, lessonAgent } : base;
  const services = createServices({
    db,
    clock: systemClock,
    media: mediaSettingsFromEnv(env),
    generation,
    subjects,
    usage,
  });
  return { services, pool, usage };
}
