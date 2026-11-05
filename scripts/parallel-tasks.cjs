/**
 * Równoległe uruchamianie kilku poleceń Node z prefiksem wyjścia i krótkim
 * podsumowaniem — wspólny rdzeń `pnpm typecheck` i `pnpm check`.
 * Kod wyjścia: 1, gdy którekolwiek polecenie padło (130 po przerwaniu).
 */
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const { DETACHED, killTree, prefixStream } = require("./child-process-tree.cjs");

const repoRoot = path.resolve(__dirname, "..");

/**
 * @param {string} name nazwa przebiegu w podsumowaniu, np. `typecheck`
 * @param {{ label: string, args: string[], env?: Record<string, string> }[]} tasks
 *   argumenty dla `node` (ścieżka skryptu i jego argumenty), cwd = katalog repozytorium
 */
function runParallel(name, tasks) {
  const children = new Set();
  const startedAt = Date.now();

  const runTask = (task) => new Promise((resolve) => {
    const taskStartedAt = Date.now();
    const child = spawn(process.execPath, task.args, {
      cwd: repoRoot,
      env: { ...process.env, ...task.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: DETACHED,
    });
    children.add(child);
    prefixStream(child.stdout, `[${task.label}]`, process.stdout);
    prefixStream(child.stderr, `[${task.label}]`, process.stderr);
    const finish = (code, error) => {
      children.delete(child);
      resolve({ label: task.label, code, seconds: (Date.now() - taskStartedAt) / 1000, error });
    };
    child.once("error", (error) => finish(1, String(error)));
    // `close`, nie `exit`: podsumowanie dopiero po spłukaniu wyjścia dziecka.
    child.once("close", (code) => finish(code ?? 1));
  });

  let interrupted = false;
  const interrupt = (signal) => {
    if (interrupted) {
      for (const child of children) killTree(child, "SIGKILL");
      process.exit(130);
    }
    interrupted = true;
    process.exitCode = 130;
    for (const child of children) {
      killTree(child, signal);
      setTimeout(() => killTree(child, "SIGKILL"), 15_000).unref();
    }
  };
  // SIGTERM/SIGHUP też: dzieci startują w osobnej grupie procesów (POSIX)
  // i bez tego przeżyłyby runner.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => interrupt(signal));

  return Promise.all(tasks.map(runTask)).then((results) => {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`\n[${name}] Podsumowanie (${elapsed} s):`);
    for (const result of results) {
      const status = result.code === 0 ? "PASS" : `FAIL (kod ${result.code})`;
      console.log(`[${name}]   ${result.label}: ${status}, ${result.seconds.toFixed(1)} s${result.error ? ` — ${result.error}` : ""}`);
    }
    if (results.some((result) => result.code !== 0) && !process.exitCode) process.exitCode = 1;
  });
}

module.exports = { repoRoot, runParallel };
