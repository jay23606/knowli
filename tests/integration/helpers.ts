import { randomUUID } from "node:crypto";
import { inject } from "vitest";
import type { TaskDto } from "@learning/contracts";
import {
  AppError,
  completePresentation,
  createDatabase,
  createServices,
  startSession,
  submitAttempt,
  MAX_AUDIO_BYTES,
  MAX_DECK_COVER_BYTES,
  MULTIPART_OVERHEAD_BYTES,
  englishGrammarSubject,
  type Clock,
  type Services,
} from "@learning/server";
import { createOpenApiHandler } from "@/orpc/handler";
import { kidRouter } from "@/orpc/kid-router";
import { parentORpcRouter } from "@/orpc/parent-router";
import { currentPoolId, workerDatabaseUrl } from "../integration-worker-databases";

type Pool = ReturnType<typeof createDatabase>["pool"];

/**
 * Gramatyka bez nagrań zdań feedbacku (jak po wyłączeniu flagi): wybór ze słuchu
 * wymaga tych nagrań, więc przedmiot bez nich nie wymienia też typu.
 */
export const grammarWithoutSentenceAudio: typeof englishGrammarSubject = {
  ...englishGrammarSubject,
  ttsForFeedbackSentence: false,
  exerciseTypes: englishGrammarSubject.exerciseTypes.filter((type) => type !== "lesson_listen_choice"),
  topics: englishGrammarSubject.topics.map((topic) => ({
    ...topic,
    objectives: topic.objectives.map((objective) => ({
      ...objective,
      exerciseTypes: objective.exerciseTypes.filter((type) => type !== "lesson_listen_choice"),
    })),
  })),
};

// Te same limity surowego strumienia co catch-all-e produkcyjne (route.ts).
const kidApiHandler = createOpenApiHandler(kidRouter, {
  maxBodySize: MAX_AUDIO_BYTES + MULTIPART_OVERHEAD_BYTES,
});
const parentApiHandler = createOpenApiHandler(parentORpcRouter, {
  maxBodySize: MAX_DECK_COVER_BYTES + 64 * 1024,
});

/**
 * Wywołanie Kid API w testach integracyjnych po dekomisji legacy routera:
 * ta sama kompozycja co catch-all `apps/web/src/app/api/v1/kid/[...path]/route.ts`
 * (handler oRPC, prefix /api/v1/kid, brak dopasowania → `not_found`), z tą
 * różnicą, że usługi wstrzykuje wywołujący test zamiast singletonu kompozycji.
 * Dopasowanie idzie po pełnym URL żądania, więc ścieżki muszą zawierać
 * prawdziwe identyfikatory (taskId/sessionId) — segments z czasów legacy
 * przepadają.
 */
export async function handleKidApi(request: Request, services: Services): Promise<Response> {
  const { matched, response } = await kidApiHandler.handle(request, {
    prefix: "/api/v1/kid",
    context: { services, headers: request.headers, url: request.url },
  });
  if (matched) {
    return response;
  }
  throw new AppError("not_found");
}

/**
 * Wywołanie Parent API w testach integracyjnych po dekomisji fallbacku legacy
 * (zadanie 13): dokładna kompozycja catch-all
 * `apps/web/src/app/api/v1/parent/[...path]/route.ts` — router oRPC obsługuje
 * cały kontrakt (auth/login-setup-logout, children/decks/drafts/mock-tests/
 * work-card/lekcje/werdykty/lesson-drafts/generation/assignments/progress/
 * sources),
 * a brak dopasowania rzuca `not_found`. `segments` pozostają akceptowane
 * wyłącznie dla zapisu istniejących testów — dopasowanie oRPC chodzi po
 * pełnym URL żądania, więc są ignorowane.
 */
export async function handleParentApi(
  request: Request,
  services: Services,
  _segments?: string[],
): Promise<Response> {
  const { matched, response } = await parentApiHandler.handle(request, {
    prefix: "/api/v1/parent",
    context: { services, headers: request.headers, url: request.url },
  });
  if (matched) {
    return response;
  }
  throw new AppError("not_found");
}

/** Przechwytuje SQL także z klienta transakcyjnego oraz klientów już wcześniej połączonych z pulą. */
export async function capturePoolQueries<T>(
  pool: Pool,
  operation: () => Promise<T>,
  include: (sql: string) => boolean = () => true,
): Promise<{ value: T; queries: string[] }> {
  const rawPool = pool as unknown as { connect: (...args: any[]) => any };
  const originalConnect = rawPool.connect;
  const clientOriginals = new Map<any, (...args: any[]) => any>();
  const queries: string[] = [];
  const instrument = (client: any) => {
    if (!client || clientOriginals.has(client)) return client;
    const originalQuery = client.query;
    clientOriginals.set(client, originalQuery);
    client.query = function (...args: any[]) {
      const input = args[0];
      const sql = typeof input === "string" ? input : input?.text ?? "";
      if (include(sql)) queries.push(sql);
      return originalQuery.apply(this, args);
    };
    return client;
  };
  rawPool.connect = function (...args: any[]) {
    const callback = args.find((arg) => typeof arg === "function");
    if (callback) {
      const index = args.indexOf(callback);
      const wrapped = (...callbackArgs: any[]) => {
        if (callbackArgs[1]) callbackArgs[1] = instrument(callbackArgs[1]);
        return callback(...callbackArgs);
      };
      const nextArgs = [...args];
      nextArgs[index] = wrapped;
      return originalConnect.apply(this, nextArgs);
    }
    return Promise.resolve(originalConnect.apply(this, args)).then(instrument);
  };
  try {
    return { value: await operation(), queries };
  } finally {
    rawPool.connect = originalConnect;
    for (const [client, originalQuery] of clientOriginals) client.query = originalQuery;
  }
}

/**
 * URL bazy bieżącego workera Vitesta (`knowli_w<VITEST_POOL_ID>`): pliki biegną
 * równolegle, każdy worker na własnej kopii zmigrowanej bazy z global-setup.
 */
export function testDatabaseUrl(): string {
  // klucze provide() z global-setup nie są statycznie typowane w Vitest 3
  const url = (inject as (key: string) => unknown)("DATABASE_URL");
  const workers = (inject as (key: string) => unknown)("INTEGRATION_WORKERS");
  if (typeof url !== "string" || !url || typeof workers !== "number") {
    throw new Error("Brak DATABASE_URL albo INTEGRATION_WORKERS z global-setup");
  }
  return workerDatabaseUrl(url, currentPoolId(process.env, workers));
}

/**
 * Pool.end() w pg rozwiązuje się, zanim sockety klientów realnie się zamkną.
 * Serwerowe ubicie półotwartego backendu (DROP DATABASE ... WITH (FORCE),
 * restart Postgresa) wraca wtedy jako asynchroniczny event 'error' puli — bez
 * listenera robi się z niego nieobsłużony wyjątek, który wywala cały run mimo
 * zielonych testów. Pule testowe mają ten szum zamieniać w ostrzeżenie.
 */
function tolerateLatePoolErrors(pool: Pool): Pool {
  pool.on("error", (error) => {
    console.warn(`[test] późny błąd połączenia puli (oczekiwany przy teardownie): ${String((error as Error).message ?? error)}`);
  });
  return pool;
}

/** Pula testowa odporna na późne, serwerowe przerwania połączeń. */
export function openQuietDatabase(connectionString: string): ReturnType<typeof createDatabase> {
  const database = createDatabase(connectionString);
  return { db: database.db, pool: tolerateLatePoolErrors(database.pool) };
}

/**
 * Czeka, aż baza per-testowa nie ma już żadnych backendów — dopiero wtedy DROP
 * ... WITH (FORCE) nie ściga się z zamykającymi się socketami klientów puli.
 */
export async function waitForDatabaseIdle(pool: Pool, databaseName: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query(
      "select count(*)::int as count from pg_stat_activity where datname = $1 and backend_type = 'client backend' and pid <> pg_backend_pid()",
      [databaseName],
    );
    if ((rows[0]?.count ?? 0) === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(`Baza ${databaseName} ma wciąż aktywne backendy po ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Zegar sterowany ręcznie — testy domeny i limity czasu nie śpią. */
export class ManualClock implements Clock {
  #now: Date;

  constructor(startIso = "2026-10-07T16:00:00.000Z") {
    this.#now = new Date(startIso);
  }

  now(): Date {
    return this.#now;
  }

  advanceMs(ms: number): void {
    this.#now = new Date(this.#now.getTime() + ms);
  }

  advanceHours(hours: number): void {
    this.advanceMs(hours * 3_600_000);
  }
}

let shared: ReturnType<typeof createDatabase> | undefined;

/** Jedna współdzielona pula dla pliku testowego (z tolerancją późnych błędów). */
export function testDatabase(): ReturnType<typeof createDatabase> {
  shared ??= openQuietDatabase(testDatabaseUrl());
  return shared;
}

/** Świeży Services (osobny limiter logowania) na współdzielonym połączeniu. */
export function buildTestServices(startIso?: string): { services: Services; clock: ManualClock } {
  const { db } = testDatabase();
  const clock = new ManualClock(startIso);
  return { services: createServices({ db, clock }), clock };
}

/** Tworzy fixture aktywnej sesji w kształcie sprzed migracji 0017. */
export async function startLegacyTrainingSession(
  services: Services,
  input: Parameters<typeof startSession>[1],
  legacyTaskBudget?: number,
): Promise<Awaited<ReturnType<typeof startSession>>> {
  const session = await startSession(services, input);
  const { pool } = testDatabase();
  await pool.query("ALTER TABLE learning_app.learning_sessions DISABLE TRIGGER learning_sessions_training_plan_immutable");
  try {
    await pool.query("UPDATE learning_app.learning_sessions SET training_plan=NULL, task_budget=coalesce($2, task_budget) WHERE id=$1", [session.sessionId, legacyTaskBudget ?? null]);
  } finally {
    await pool.query("ALTER TABLE learning_app.learning_sessions ENABLE TRIGGER learning_sessions_training_plan_immutable");
  }
  return session;
}

/** Osobna pula symuluje restart procesu przy tym samym DATABASE_URL. */
export function openRestartedServices(): { services: Services; dispose: () => Promise<void> } {
  const { db, pool } = createDatabase(testDatabaseUrl());
  const services = createServices({ db, clock: new ManualClock() });
  return { services, dispose: () => pool.end() };
}

export async function truncateCoreTables(): Promise<void> {
  const { pool } = testDatabase();
  // CASCADE czyści również tabele historyczne referencjonujące profile; TRUNCATE nie
  // uruchamia triggerów BEFORE DELETE, więc omija guards (właściwe w teardown).
  await pool.query(
    "TRUNCATE learning_app.child_profiles, learning_app.parent_sessions, learning_app.parent_credentials, learning_app.integration_tokens CASCADE",
  );
}

export async function countRows(table: string): Promise<number> {
  const { pool } = testDatabase();
  const result = await pool.query(`SELECT count(*)::int AS count FROM learning_app.${table}`);
  return result.rows[0]?.count as number;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Kończy wydane zadanie sesji lekcji (wspólne dla testów historyjki): karta
 * i historyjka — `completePresentation`; pytanie historyjki — wybór poprawnej
 * opcji z klucza (albo innej przy `correct: false`); pozostałe typy — odpowiedź
 * z prywatnego klucza zadania (zamknięte: poprawne opcje/kolejność/przypisania,
 * tekstowe: odpowiedź kanoniczna; przy `correct: false` odpowiedź błędna —
 * prawdziwa błędna opcja albo dystraktor; gdy jej brak, helper rzuca zamiast
 * po cichu odpowiedzieć poprawnie).
 */
export async function finishLessonTask(services: Services, task: TaskDto, options: { correct?: boolean } = {}): Promise<void> {
  const correct = options.correct ?? true;
  if (task.exerciseType === "lesson_card" || task.exerciseType === "lesson_story") {
    await completePresentation(services, { taskId: task.taskId });
    return;
  }
  const { pool } = testDatabase();
  const key = (await pool.query<{ answerKey: Record<string, unknown> }>(
    `select answer_key as "answerKey" from learning_app.session_tasks where id = $1`, [task.taskId],
  )).rows[0]!.answerKey;
  const base = { taskId: task.taskId, clientAttemptId: randomUUID() };
  const correctOptionId = key.correctOptionId as string | undefined;
  if (correctOptionId !== undefined) {
    // Wybór i pytanie historyjki mają `optionValues`, „Zauważ” — `segmentValues`.
    const values = (key.optionValues ?? key.segmentValues) as Record<string, string> | undefined;
    const wrong = Object.keys(values ?? {}).find((id) => id !== correctOptionId);
    if (!correct && wrong === undefined) throw new Error(`finishLessonTask: brak błędnej opcji w zadaniu ${task.exerciseType}`);
    await submitAttempt(services, { ...base, modality: "choice", optionId: correct ? correctOptionId : wrong! });
    return;
  }
  if (Array.isArray(key.correctOptionIds)) {
    // Wybór wielokrotny: przy błędnej odpowiedzi ta sama liczba zaznaczeń, ale jedno
    // zaznaczenie to dystraktor (za mało zaznaczeń odrzuciłaby walidacja, nie ocena).
    const ids = key.correctOptionIds as string[];
    const distractor = Object.keys((key.optionValues as Record<string, string> | undefined) ?? {}).find((id) => !ids.includes(id));
    if (!correct && distractor === undefined) throw new Error(`finishLessonTask: brak dystraktora w zadaniu ${task.exerciseType}`);
    await submitAttempt(services, { ...base, modality: "selection", itemIds: correct ? ids : [...ids.slice(0, -1), distractor!] });
    return;
  }
  if (Array.isArray(key.assignments)) {
    const assignments = key.assignments as { itemId: string; targetId: string }[];
    const rotated = assignments.map((entry, index) => ({ itemId: entry.itemId, targetId: assignments[(index + 1) % assignments.length]!.targetId }));
    await submitAttempt(services, { ...base, modality: "assignment", assignments: correct ? assignments : rotated });
    return;
  }
  if (Array.isArray(key.itemIds)) {
    const itemIds = key.itemIds as string[];
    await submitAttempt(services, { ...base, modality: "sequence", itemIds: correct ? itemIds : [...itemIds].reverse() });
    return;
  }
  await submitAttempt(services, { ...base, modality: "text", text: correct ? key.answer as string : "zzz qqq" });
}
