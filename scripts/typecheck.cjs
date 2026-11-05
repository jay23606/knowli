#!/usr/bin/env node
/**
 * `pnpm typecheck`: sześć projektów TypeScriptu naraz natywnym kompilatorem
 * TypeScript 7 (pakiet `typescript-native` = `npm:typescript@7.0.2`).
 *
 * Pakiet `typescript` (5.9) zostaje dla narzędzi, które wołają API kompilatora
 * (`next build` sprawdza typy przez `ts.createProgram`, testy
 * `*.architecture.test.ts` parsują kod przez `ts.createSourceFile`) — TS 7.0
 * nie ma tego API. Pełna migracja na TS 7.1: AGENTS.md, „Running and verifying”.
 */
"use strict";

const path = require("node:path");
const { repoRoot, runParallel } = require("./parallel-tasks.cjs");

// Ścieżka wprost, nie `tsc` z node_modules/.bin: obie wersje rejestrują ten
// sam bin i pnpm nie gwarantuje, która z nich go dostanie.
const TSC = path.join(repoRoot, "node_modules/typescript-native/bin/tsc");

const PROJECTS = [
  "tsconfig.json",
  "packages/contracts/tsconfig.json",
  "packages/server/tsconfig.json",
  "apps/web/tsconfig.json",
  "apps/worker/tsconfig.json",
  "packages/kid-ui/tsconfig.json",
];

runParallel(
  "typecheck",
  PROJECTS.map((project) => ({
    label: `tsc ${path.dirname(project) === "." ? "root" : path.dirname(project)}`,
    args: [TSC, "--noEmit", "--pretty", "false", "-p", project],
  })),
).catch((error) => {
  console.error(`[typecheck] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
