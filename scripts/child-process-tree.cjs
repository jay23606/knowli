"use strict";
/**
 * Wspólne operacje na procesach potomnych runnerów równoległych przebiegów
 * (run-e2e-shards.cjs, parallel-tasks.cjs).
 */

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const exec = promisify(execFile);

// POSIX: dzieci startują w osobnej grupie procesów, żeby sygnał objął całe
// drzewo (Playwright/Vitest, `next start`, worker); Windows zabija drzewo taskkill.
const DETACHED = process.platform !== "win32";

function killTree(child, signal = "SIGTERM") {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    exec("taskkill", ["/pid", String(child.pid), "/T", "/F"]).catch(() => undefined);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function prefixStream(stream, prefix, target) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) target.write(`${prefix} ${line}\n`);
  });
  stream.on("end", () => {
    if (buffer) target.write(`${prefix} ${buffer}\n`);
  });
}

module.exports = { DETACHED, exec, killTree, prefixStream };
