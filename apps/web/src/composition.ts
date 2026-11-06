import type { Pool } from "pg";
import {
  createDatabase,
  createDrizzleUsageRecorder,
  createLocalMediaStore,
  createProductionSubjectRegistry,
  createServices,
  fakeGraderDeps,
  FakeAnswerGrader,
  fakeSessionActivityDeps,
  FakeSessionActivityReviewer,
  fakeLessonSpeechDeps,
  fakeSpeechDeps,
  generationPublicServiceFromEnv,
  graderFromEnv,
  imageProviderFromEnv,
  lessonAgentPublicFromEnv,
  lessonSpeechFromEnv,
  mediaSettingsFromEnv,
  pricesFromEnv,
  sessionActivityFromEnv,
  speechFromEnv,
  systemClock,
  type Services,
  type UsageRecorder,
  withConfigDefaults,
} from "@learning/server";

interface ServerServices {
  services: Services;
  pool: Pool;
  /** Recorder kosztów; brak w trybie fake (E2E nie zapisuje kosztów). */
  usage?: UsageRecorder;
}

let current: ServerServices | undefined;

/** Złożenie zależności serwerowych dla web; singleton na czas życia procesu. */
export function getServerServices(): Services {
  current ??= initialize();
  return current.services;
}

function initialize(): ServerServices {
  // domyślna konfiguracja z repo pod spodem, .env nadpisuje (config-defaults.ts)
  const env = withConfigDefaults(process.env);
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }
  // Tryb fake (E2E/smoke bez kluczy) ma pierwszeństwo: nagrania i odpowiedzi
  // nie wychodzą do sieci, nawet gdy w środowisku jest klucz.
  const fake = env.UMIEM_FAKE_PROVIDERS === "1";
  // Stawki przed pulą: zła wartość to błąd startu bez otwartych połączeń.
  const prices = fake ? undefined : pricesFromEnv(env);
  const { db, pool } = createDatabase(databaseUrl);
  // Jeden recorder kosztów (spec llm-cost-tracking §4.3) na tej samej puli dla
  // wszystkich płatnych adapterów web; fake'i go nie dostają.
  const usage = prices ? createDrizzleUsageRecorder({ db, clock: systemClock, prices }) : undefined;
  // odpowiedzi ustne przechodzą w trybie fake pełny cykl na deterministycznych
  // providerach zamiast kończyć się wynikiem technicznym
  const speech = fake ? fakeSpeechDeps() : speechFromEnv(env, usage);
  // dyktowanie odpowiedzi lekcji (Etap 3 szkoły): osobny STT bez oceny wymowy
  const lessonSpeech = fake ? fakeLessonSpeechDeps() : lessonSpeechFromEnv(env, usage);
  // model oceniający: z env (produkcja) albo fake (routing po słowach kluczowych
  // w odpowiedzi: „almost” → almost, „wrong” → incorrect, inaczej correct)
  const grader = fake
    ? fakeGraderDeps({ provider: new FakeAnswerGrader({ keywordRouting: true }) })
    : graderFromEnv(env, usage);
  // Ocena aktywności sesji współdzieli połączenie UMIEM_GRADER_*; w trybie fake
  // deterministiczny reviewer (heurystyka „aaa” → wykluczenie zadania).
  const sessionActivity = fake
    ? fakeSessionActivityDeps({ provider: new FakeSessionActivityReviewer() })
    : sessionActivityFromEnv(env, usage);
  // web generuje obrazem tylko propozycje okładek rodzica
  const imageProvider = imageProviderFromEnv(env, usage, "deck_cover");
  // zły adres LLM nie wywraca web (etykieta to tylko opis): wtedy bez informacji o usłudze
  const generationService = generationPublicServiceFromEnv(env);
  // opis agenta puli (etykiety usług; obecny = generowanie lekcji dostępne) wyłącznie z env: web nie importuje
  // adaptera agenta, a zły klucz agenta albo błędne limity zatrzymują worker, nie web
  const subjects = createProductionSubjectRegistry();
  const lessonAgentPublic = lessonAgentPublicFromEnv(env);
  return {
    services: createServices({
      db,
      subjects,
      clock: systemClock,
      media: mediaSettingsFromEnv(env),
      ...(imageProvider ? { imageProvider } : {}),
      // web generuje wyłącznie jawne propozycje okładek rodzica; generację mediów kart wykonuje worker
      mediaStore: createLocalMediaStore(env.MEDIA_ROOT ?? "./data/media"),
      // ścieżka mowy to krótkie żądanie web → provider, bez kolejki (arch §11)
      ...(speech ? { speech } : {}),
      ...(lessonSpeech ? { lessonSpeech } : {}),
      ...(grader ? { grader } : {}),
      ...(sessionActivity ? { sessionActivity } : {}),
      // web nie ma LLM (generuje worker): opisuje konfigurację wspólną z workerem
      ...(generationService ? { generationService } : {}),
      ...(lessonAgentPublic ? { lessonAgentPublic } : {}),
      ...(usage ? { usage } : {}),
    }),
    pool,
    ...(usage ? { usage } : {}),
  };
}

/**
 * Zamknięcie zależności: zaległe zapisy kosztów przed zamknięciem puli, przez
 * którą piszą (spec llm-cost-tracking §4.3). Nieudany flush nie blokuje puli.
 */
export async function disposeServices(deps: { usage?: UsageRecorder; pool: { end(): Promise<void> } }): Promise<void> {
  await deps.usage?.flush().catch(() => undefined);
  await deps.pool.end();
}

/** Wyłącznie na potrzeby testów i graceful shutdown. */
export async function disposeServerServices(): Promise<void> {
  if (current) {
    const disposed = current;
    current = undefined;
    await disposeServices(disposed);
  }
}
