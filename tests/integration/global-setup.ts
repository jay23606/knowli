import { createDatabase, migrateDatabase, waitUntilDatabaseReady } from "@learning/server";
import { resolveIntegrationWorkers, workerDatabaseName } from "../integration-worker-databases";
import {
  currentOwnerContext,
  listContainersByPrefix,
  removeContainer,
  selectStaleContainers,
  startPostgresContainer,
} from "../test-containers";
import { INTEGRATION_CONTAINER_PREFIX, readTestRunConfig } from "../test-run-config";

const CONTAINER_PREFIX = readTestRunConfig(process.env).integrationContainerPrefix;

function containerName(): string {
  return `${CONTAINER_PREFIX}${process.pid}`;
}

// Sprząta osierocone kontenery przerwanych przebiegów (dowolnego run ID),
// ale nigdy bazy przebiegu, którego proces wciąż żyje — równoległe
// `pnpm test:integration` z innych sesji i worktree dzielą ten demon Dockera.
async function removeStaleContainers(): Promise<void> {
  const stale = selectStaleContainers(await listContainersByPrefix(INTEGRATION_CONTAINER_PREFIX), currentOwnerContext());
  for (const container of stale) await removeContainer(container.id);
}

/**
 * Kopie zmigrowanej bazy dla workerów (`knowli_w1…N`, tests/integration-worker-databases.ts).
 * Szablon nie może mieć otwartych połączeń; pula migracji kończy się przed
 * powrotem z `migrateDatabase`, ale backend może jeszcze chwilę wisieć — stąd
 * krótkie ponawianie.
 */
async function createWorkerDatabases(templateUrl: string, workers: number): Promise<void> {
  const template = new URL(templateUrl).pathname.slice(1);
  // Połączenie z inną bazą niż szablon (u nas szablonem jest `postgres` z URL-a kontenera).
  const adminUrl = new URL(templateUrl);
  adminUrl.pathname = "/template1";
  const { pool } = createDatabase(adminUrl.toString());
  try {
    for (let poolId = 1; poolId <= workers; poolId += 1) {
      const name = workerDatabaseName(poolId);
      for (let attempt = 1; ; attempt += 1) {
        try {
          await pool.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
          break;
        } catch (error) {
          // 55006: szablon „is being accessed by other users”.
          if ((error as { code?: string }).code !== "55006" || attempt >= 50) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
  } finally {
    await pool.end();
  }
}

interface GlobalSetupContext {
  provide: (key: string, value: unknown) => void;
  /** Rozwiązany config przebiegu (także z flagami CLI, np. `--maxWorkers`). */
  globalConfig?: { maxWorkers?: number; pool?: string };
}

export default async function globalSetup({
  provide,
  globalConfig,
}: GlobalSetupContext): Promise<(() => Promise<void>) | void> {
  // Wątki dzieliłyby `process.env` i stan modułów między plikami (np. plik
  // ustawia DATABASE_URL na poziomie modułu), więc izolacja wymaga procesów.
  if (globalConfig?.pool !== undefined && globalConfig.pool !== "forks") {
    throw new Error(`Testy integracyjne wymagają pool "forks", a przebieg ma "${globalConfig.pool}" — nie podawaj --pool w CLI`);
  }
  // Tyle baz, ilu workerów faktycznie uruchomi Vitest — także po `--maxWorkers`
  // w CLI (inaczej worker spoza zakresu nie miałby bazy).
  const workers = globalConfig?.maxWorkers ?? resolveIntegrationWorkers(process.env);
  await removeStaleContainers();
  const name = containerName();
  const container = await startPostgresContainer({
    name,
    label: "testów integracyjnych",
    prepare: async (url) => {
      // pg_isready wewnątrz kontenera pyta po unix sockecie i zgłasza gotowość już
      // podczas tymczasowego serwera entrypointa (listen_addresses=''), zanim port
      // TCP hosta zacznie słuchać — wtedy migracja dostaje ECONNRESET. Czekamy na
      // realny handshake po dokładnie tym URL-u, którego używa migracja.
      await waitUntilDatabaseReady(url);
      await migrateDatabase(url, "packages/server/drizzle");
      await createWorkerDatabases(url, workers);
    },
  });
  provide("DATABASE_URL", container.url);
  provide("INTEGRATION_WORKERS", workers);
  provide("TEST_CONTAINER", name);
  return async () => {
    await removeContainer(container.id);
  };
}
