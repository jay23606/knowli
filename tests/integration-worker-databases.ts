import { availableParallelism } from "node:os";
import { readTestRunConfig } from "./test-run-config";

/**
 * Osobna baza dla każdego workera Vitesta integracji.
 *
 * Global setup migruje bazę z URL-a kontenera i robi z niej kopie
 * `knowli_w1…knowli_wN` (`CREATE DATABASE … TEMPLATE`); worker o
 * `VITEST_POOL_ID = n` łączy się wyłącznie z `knowli_wn`. Pliki biegną więc
 * równolegle, a czyszczenie tabel w `beforeEach` dotyczy tylko bazy własnego
 * workera — jak dotąd przy przebiegu sekwencyjnym na jednej bazie.
 * Kontener należy do jednego przebiegu (nazwa z pid), więc równoległe
 * przebiegi z innych sesji nie dzielą ani kontenera, ani baz.
 */
const WORKER_DATABASE_PREFIX = "knowli_w";

/**
 * Połowa wątków procesora, od 2 do 6: reszta zostaje dla Postgresa i przebiegów
 * z innych sesji. Pomiar 2026-11-05 (16 wątków): 5 workerów 101 s, 6 — 89 s,
 * 8 — 74 s; powyżej 6 przebieg solo zyskuje niewiele, a kilka przebiegów naraz
 * coraz mocniej przeciąża procesor.
 */
export function defaultIntegrationWorkers(cpus: number = availableParallelism()): number {
  return Math.min(6, Math.max(2, Math.floor(cpus / 2)));
}

/**
 * Liczba workerów przebiegu: `UMIEM_INTEGRATION_WORKERS` albo domyślna. Liczą
 * ją niezależnie config Vitesta (`maxWorkers`) i global setup (ile baz założyć)
 * — ta sama funkcja z tym samym środowiskiem daje ten sam wynik.
 */
export function resolveIntegrationWorkers(env: Record<string, string | undefined>): number {
  return readTestRunConfig(env).integrationWorkers ?? defaultIntegrationWorkers();
}

export function workerDatabaseName(poolId: number): string {
  if (!Number.isInteger(poolId) || poolId < 1) throw new Error(`Nieprawidłowy numer workera: ${poolId}`);
  return `${WORKER_DATABASE_PREFIX}${poolId}`;
}

export function workerDatabaseUrl(baseUrl: string, poolId: number): string {
  const url = new URL(baseUrl);
  url.pathname = `/${workerDatabaseName(poolId)}`;
  return url.toString();
}

/** Numer workera Vitesta (1…maxWorkers) z `VITEST_POOL_ID`. */
export function currentPoolId(env: Record<string, string | undefined>, workers: number): number {
  const raw = env.VITEST_POOL_ID;
  const poolId = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(poolId) || poolId < 1 || poolId > workers) {
    throw new Error(`VITEST_POOL_ID=${raw ?? "(brak)"} poza zakresem 1…${workers}: global setup założył bazy tylko dla ${workers} workerów`);
  }
  return poolId;
}
