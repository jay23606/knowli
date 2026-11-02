import {
  createDatabase,
  createDrizzleUsageRecorder,
  createGenerationDepsFromEnv,
  createServices,
  mediaSettingsFromEnv,
  pricesFromEnv,
  systemClock,
  type Services,
  type UsageRecorder,
  withConfigDefaults,
} from "@learning/server";

type WorkerPool = ReturnType<typeof createDatabase>["pool"];

/**
 * Składanie zależności workera: baza + adaptery providerów wg env
 * (UMIEM_FAKE_PROVIDERS=1 dla środowisk bez kluczy) i lokalny wolumen mediów.
 * Baza powstaje przed adapterami, bo recorder kosztów (spec llm-cost-tracking
 * §4.3) pisze przez tę samą pulę, a fabryki dostają ten jeden recorder; fake'i
 * go nie używają, więc tryb fake nie zapisuje kosztów.
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
  const { db, pool } = createDatabase(databaseUrl);
  const usage = createDrizzleUsageRecorder({ db, clock: systemClock, prices });
  const generation = createGenerationDepsFromEnv(env, usage);
  if (!generation) {
    throw new Error("OPENAI_API_KEY is not configured (obrazy; LLM i TTS biorą OPENROUTER_API_KEY) — albo ustaw UMIEM_FAKE_PROVIDERS=1");
  }
  const services = createServices({
    db,
    clock: systemClock,
    media: mediaSettingsFromEnv(env),
    generation,
    usage,
  });
  return { services, pool, usage };
}
