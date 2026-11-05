// Wspólny początek nazw kontenerów integracji wszystkich przebiegów (z run ID i bez).
export const INTEGRATION_CONTAINER_PREFIX = "knowli-it-";

export interface TestRunConfig {
  integrationContainerPrefix: string;
  e2eContainer: string;
  e2ePort: number;
  workerHealthPort: number;
  worldFile: string;
  /** Bramka fake providerów świata E2E (`UMIEM_FAKE_HOLD_FILE`, tests/e2e/helpers/fake-hold.ts). */
  fakeHoldFile: string;
  outputDir: string;
  e2eWebMode: "start" | "dev";
  e2eSkipBuild: boolean;
  e2eWorkers: number;
  e2eBucket: number | null;
  integrationBucket: number | null;
  /** Liczba workerów Vitesta integracji (każdy z własną bazą); null = domyślna z liczby rdzeni. */
  integrationWorkers: number | null;
}

// Kosz czasowy wybierany zmienną `<name>` (REAL_BUCKETS dla E2E,
// INTEGRATION_BUCKETS dla integracji); brak albo pusta wartość (np. pozycja
// matrixa CI bez kosza) = wszystkie pliki. Zgodność indeksu z liczbą koszy
// sprawdza config danego runnera (playwright / vitest.integration).
function parseBucket(raw: string | undefined, name: string): number | null {
  if (raw !== undefined && raw !== "" && !/^[1-9]$/.test(raw)) {
    throw new Error(`${name} must be an integer from 1 to 9`);
  }
  return raw === undefined || raw === "" ? null : Number(raw);
}

export function readTestRunConfig(env: Record<string, string | undefined>): TestRunConfig {
  const runId = env.UMIEM_TEST_RUN_ID;
  if (runId !== undefined && !/^[a-z0-9-]+$/.test(runId)) {
    throw new Error("UMIEM_TEST_RUN_ID must contain only lowercase letters, digits, and hyphens");
  }

  const rawPort = env.UMIEM_E2E_PORT;
  if (rawPort !== undefined && !/^\d+$/.test(rawPort)) {
    throw new Error("UMIEM_E2E_PORT must be an integer from 1024 to 65535");
  }
  const e2ePort = rawPort === undefined ? 24500 : Number(rawPort);
  if (!Number.isInteger(e2ePort) || e2ePort < 1024 || e2ePort > 65535) {
    throw new Error("UMIEM_E2E_PORT must be an integer from 1024 to 65535");
  }

  const rawWorkerPort = env.UMIEM_WORKER_HEALTH_PORT;
  if (rawWorkerPort !== undefined && !/^\d+$/.test(rawWorkerPort)) {
    throw new Error("UMIEM_WORKER_HEALTH_PORT must be an integer from 1024 to 65535");
  }
  const workerHealthPort = rawWorkerPort === undefined
    ? runId ? 10_000 + (e2ePort % 50_000) : 9301
    : Number(rawWorkerPort);
  if (!Number.isInteger(workerHealthPort) || workerHealthPort < 1024 || workerHealthPort > 65535) {
    throw new Error("UMIEM_WORKER_HEALTH_PORT must be an integer from 1024 to 65535");
  }

  const rawWebMode = env.UMIEM_E2E_WEB_MODE;
  if (rawWebMode !== undefined && rawWebMode !== "start" && rawWebMode !== "dev") {
    throw new Error('UMIEM_E2E_WEB_MODE must be "start" or "dev"');
  }
  const e2eWebMode = rawWebMode === "dev" ? "dev" : "start";

  const rawSkipBuild = env.UMIEM_E2E_SKIP_BUILD;
  if (rawSkipBuild !== undefined && rawSkipBuild !== "0" && rawSkipBuild !== "1") {
    throw new Error('UMIEM_E2E_SKIP_BUILD must be "0" or "1"');
  }
  const e2eSkipBuild = rawSkipBuild === "1";

  const rawWorkers = env.UMIEM_E2E_WORKERS;
  if (rawWorkers !== undefined && !/^\d+$/.test(rawWorkers)) {
    throw new Error("UMIEM_E2E_WORKERS must be an integer from 1 to 32");
  }
  const e2eWorkers = rawWorkers === undefined ? 4 : Number(rawWorkers);
  if (!Number.isInteger(e2eWorkers) || e2eWorkers < 1 || e2eWorkers > 32) {
    throw new Error("UMIEM_E2E_WORKERS must be an integer from 1 to 32");
  }

  const e2eBucket = parseBucket(env.UMIEM_E2E_BUCKET, "UMIEM_E2E_BUCKET");
  const integrationBucket = parseBucket(env.UMIEM_INTEGRATION_BUCKET, "UMIEM_INTEGRATION_BUCKET");

  const rawIntegrationWorkers = env.UMIEM_INTEGRATION_WORKERS;
  if (rawIntegrationWorkers !== undefined && rawIntegrationWorkers !== "" && !/^\d+$/.test(rawIntegrationWorkers)) {
    throw new Error("UMIEM_INTEGRATION_WORKERS must be an integer from 1 to 16");
  }
  const integrationWorkers = rawIntegrationWorkers === undefined || rawIntegrationWorkers === "" ? null : Number(rawIntegrationWorkers);
  if (integrationWorkers !== null && (integrationWorkers < 1 || integrationWorkers > 16)) {
    throw new Error("UMIEM_INTEGRATION_WORKERS must be an integer from 1 to 16");
  }

  return {
    integrationContainerPrefix: runId ? `${INTEGRATION_CONTAINER_PREFIX}${runId}-` : INTEGRATION_CONTAINER_PREFIX,
    e2eContainer: runId ? `knowli-e2e-${runId}` : "knowli-e2e",
    e2ePort,
    workerHealthPort,
    worldFile: `tests/e2e/${runId ? `.world-${runId}.json` : ".world.json"}`,
    fakeHoldFile: `tests/e2e/${runId ? `.fake-hold-${runId}` : ".fake-hold"}`,
    // Równoległe procesy Playwright czyszczą wspólny outputDir na starcie
    // i kasują sobie nawzajem artefakty; run z własnym ID ma własny katalog.
    outputDir: runId ? `test-results/${runId}` : "test-results",
    e2eWebMode,
    e2eSkipBuild,
    e2eWorkers,
    e2eBucket,
    integrationBucket,
    integrationWorkers,
  };
}
