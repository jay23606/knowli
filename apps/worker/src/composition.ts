import {
  createDatabase,
  createDrizzleUsageRecorder,
  createGenerationDepsFromEnv,
  createProductionSubjectRegistry,
  createServices,
  isLessonAgentAvailable,
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
 * `@learning/server/lesson-agent` — proces web nie ładuje adaptera AI SDK. Pole
 * `generation.lessonAgent` jest zawsze ustawione: bez klucza OpenRouter worker
 * startuje z agentem niedostępnym i jedną linią logu (bez innych zależności od
 * OpenRouter, np. LLM i TTS na OpenAI, start się udaje).
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
  try {
    const usage = createDrizzleUsageRecorder({ db, clock: systemClock, prices });
    const base = createGenerationDepsFromEnv(env, usage);
    if (!base) {
      throw new Error("OPENAI_API_KEY is not configured (obrazy; LLM i TTS biorą OPENROUTER_API_KEY) — albo ustaw UMIEM_FAKE_PROVIDERS=1");
    }
    const lessonAgent = lessonAgentDepsFromEnv(env, usage);
    if (!isLessonAgentAvailable(lessonAgent)) console.log("[config] lesson-agent=unavailable reason=no_openrouter_key");
    const generation = { ...base, lessonAgent };
    const services = createServices({
      db,
      clock: systemClock,
      media: mediaSettingsFromEnv(env),
      generation,
      subjects,
      usage,
    });
    return { services, pool, usage };
  } catch (error) {
    // Błąd konfiguracji po utworzeniu puli (adaptery, agent): pula zamknięta, zanim błąd zatrzyma start.
    void pool.end().catch(() => undefined);
    throw error;
  }
}
