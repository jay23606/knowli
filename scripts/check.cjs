#!/usr/bin/env node
/**
 * `pnpm check`: lokalny odpowiednik joba CI `check` — typecheck, testy
 * jednostkowe i build naraz zamiast po kolei (kroki są od siebie niezależne).
 * Wyjście ma prefiksy kroków, a na końcu jest podsumowanie z czasami.
 */
"use strict";

const { runParallel } = require("./parallel-tasks.cjs");

runParallel("check", [
  { label: "typecheck", args: ["scripts/typecheck.cjs"] },
  { label: "unit", args: ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.unit.config.ts"] },
  { label: "build", args: ["apps/web/node_modules/next/dist/bin/next", "build", "apps/web"] },
]).catch((error) => {
  console.error(`[check] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
