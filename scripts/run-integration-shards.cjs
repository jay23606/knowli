#!/usr/bin/env node
/**
 * Lokalny równoległy przebieg testów integracyjnych: te same kosze czasowe
 * INTEGRATION_BUCKETS co joby `integration (N)` w CI, każdy jako osobny proces
 * Vitesta z własnym kontenerem Postgresa (global-setup per proces, odrębny
 * UMIEM_TEST_RUN_ID). Pliki w koszu nadal biegną sekwencyjnie na wspólnej bazie
 * kosza, więc gwarancje `fileParallelism: false` zostają bez zmian.
 *
 * Użycie: pnpm test:integration:shards [-- <argumenty Vitesta, np. -t wzorzec>]
 */
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const { DETACHED, exec, killTree, prefixStream } = require("./child-process-tree.cjs");

const repoRoot = path.resolve(__dirname, "..");
const VITEST_CLI = path.join(repoRoot, "node_modules/vitest/vitest.mjs");
// Liczba koszy INTEGRATION_BUCKETS (tests/integration-buckets.ts);
// zgodności pilnuje test jednostkowy integration-buckets.test.ts.
const INTEGRATION_BUCKETS = 3;

const children = new Set();

async function cleanupContainers(runIds) {
  // Sieć bezpieczeństwa: Vitest po SIGINT kończy proces bez teardownu
  // global-setup, więc kontenery koszy zostałyby do sprzątania przez kolejny
  // przebieg. Nazwa: `knowli-it-<runId>-<pid Vitesta>`, runId zawiera pid runnera.
  for (const runId of runIds) {
    const { stdout } = await exec("docker", ["ps", "-aq", "--filter", `name=knowli-it-${runId}-`]).catch(() => ({ stdout: "" }));
    const ids = stdout.split(/\r?\n/).map((id) => id.trim()).filter(Boolean);
    // -v: kontener sprzed tmpfs miałby anonimowy wolumen danych.
    if (ids.length > 0) await exec("docker", ["rm", "-f", "-v", ...ids]).catch(() => undefined);
  }
}

function runBucket(bucket, runId, vitestArgs) {
  const label = `integration-${bucket}/${INTEGRATION_BUCKETS}`;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [VITEST_CLI, "run", "--config", "vitest.integration.config.ts", ...vitestArgs],
      {
        cwd: repoRoot,
        env: { ...process.env, UMIEM_INTEGRATION_BUCKET: String(bucket), UMIEM_TEST_RUN_ID: runId },
        stdio: ["ignore", "pipe", "pipe"],
        detached: DETACHED,
      },
    );
    children.add(child);
    prefixStream(child.stdout, `[${label}]`, process.stdout);
    prefixStream(child.stderr, `[${label}]`, process.stderr);
    const finish = (code, error) => {
      children.delete(child);
      resolve({ label, code, seconds: Math.round((Date.now() - startedAt) / 1000), error });
    };
    child.once("error", (error) => finish(1, String(error)));
    // `close`, nie `exit`: podsumowanie dopiero po spłukaniu wyjścia dziecka.
    child.once("close", (code) => finish(code ?? 1));
  });
}

async function main() {
  // Wiodące `--` (pnpm test:integration:shards -- -t wzorzec) nie jest argumentem Vitesta.
  const vitestArgs = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--"));
  if (vitestArgs.includes("--help")) {
    console.log("pnpm test:integration:shards [-- <argumenty Vitesta, np. -t wzorzec>]");
    return;
  }
  const startedAt = Date.now();
  // Każdy kosz ma stałą listę plików, więc filtr (np. nazwa pliku) nie trafi
  // w pozostałe kosze — bez tej flagi kończyłyby się porażką „No test files found”.
  const bucketArgs = vitestArgs.length > 0 ? ["--passWithNoTests", ...vitestArgs] : vitestArgs;
  // Sufiks pid: dwa równoległe wywołania runnera nie dzielą nazw kontenerów.
  const runIds = [];
  const runs = [];
  for (let bucket = 1; bucket <= INTEGRATION_BUCKETS; bucket += 1) {
    const runId = `shards-it-${bucket}-${process.pid}`;
    runIds.push(runId);
    runs.push(runBucket(bucket, runId, bucketArgs));
  }
  let results;
  try {
    results = await Promise.all(runs);
  } finally {
    await cleanupContainers(runIds);
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\n[integration-shards] Podsumowanie (${elapsed} s):`);
  let failed = false;
  for (const result of results) {
    const status = result.code === 0 ? "PASS" : `FAIL (kod ${result.code})`;
    console.log(`[integration-shards]   ${result.label}: ${status}, ${result.seconds} s${result.error ? ` — ${result.error}` : ""}`);
    if (result.code !== 0) failed = true;
  }
  if (failed && !process.exitCode) process.exitCode = 1;
}

let interrupted = false;
function interrupt(signal) {
  if (interrupted) {
    for (const child of children) killTree(child, "SIGKILL");
    process.exit(130);
  }
  interrupted = true;
  process.exitCode = 130;
  // Pierwsze przerwanie: sygnał do dzieci (na Windows od razu taskkill /F),
  // SIGKILL po limicie. Kontenery koszy usuwa cleanupContainers w main(),
  // gdy dzieci się zamkną; po twardym wyjściu sprząta je global-setup
  // kolejnego przebiegu, bo ich właściciel już nie żyje.
  for (const child of children) {
    killTree(child, signal);
    setTimeout(() => killTree(child, "SIGKILL"), 15_000).unref();
  }
}
// SIGTERM/SIGHUP też: dzieci startują w osobnej grupie procesów (POSIX)
// i bez tego przeżyłyby runner.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => interrupt(signal));

main().catch((error) => {
  if (interrupted) return;
  console.error(`[integration-shards] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
