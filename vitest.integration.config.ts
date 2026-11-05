import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { INTEGRATION_BUCKETS } from "./tests/integration-buckets";
import { resolveIntegrationWorkers } from "./tests/integration-worker-databases";
import { readTestRunConfig } from "./tests/test-run-config";

// Testy integracyjne: prawdziwy PostgreSQL w kontenerze docker (global-setup),
// po jednym kontenerze na przebieg. Pliki biegną równolegle w `workers`
// procesach, a każdy worker ma własną kopię zmigrowanej bazy
// (tests/integration-worker-databases.ts) — czyszczenie tabel w beforeEach
// dotyczy tylko bazy tego workera. Procesy (`forks`), nie wątki: pliki
// ustawiają `process.env` i stan modułów na poziomie pliku.
// UMIEM_INTEGRATION_WORKERS zmienia liczbę workerów (1 = przebieg sekwencyjny).
const workers = resolveIntegrationWorkers(process.env);
//
// UMIEM_INTEGRATION_BUCKET wybiera jeden kosz czasowy (równoległe joby CI,
// każdy z własnym kontenerem); bez niego config obejmuje wszystkie pliki.
const bucket = readTestRunConfig(process.env).integrationBucket;
if (bucket !== null && (bucket < 1 || bucket > INTEGRATION_BUCKETS.length)) {
  throw new Error(
    `UMIEM_INTEGRATION_BUCKET=${bucket} poza zakresem: zdefiniowano ${INTEGRATION_BUCKETS.length} kosze (tests/integration-buckets.ts)`,
  );
}
const include = bucket === null
  ? ["tests/integration/**/*.test.ts"]
  : [...INTEGRATION_BUCKETS[bucket - 1]!];

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    include,
    globalSetup: "./tests/integration/global-setup.ts",
    environment: "node",
    pool: "forks",
    maxWorkers: workers,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
