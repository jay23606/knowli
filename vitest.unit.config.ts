import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Testy domenowe: czysta logika z kontrolowanym zegarem, bez bazy i sieci.
// Do czasu zadania 5 nie ma jeszcze plików domenowych; passWithNoTests utrzymuje
// skrypt użyteczny od pierwszego zadania.
export default defineConfig({
  resolve: {
    alias: {
      // Codacy nie ładuje typów Node dla konfiguracji Vitest poza tsconfigiem.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      "@": resolve(process.cwd(), "apps/web/src"),
      // Mantine (panel rodzica) importuje react-dom, którego pnpm nie dowiązuje
      // w jego katalogu — testy komponentów panelu biorą kopię aplikacji web.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      "react-dom": resolve(process.cwd(), "apps/web/node_modules/react-dom"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.test.tsx", "apps/*/src/**/*.test.ts", "apps/*/src/**/*.test.tsx", "tests/test-run-config.test.ts", "tests/test-containers.test.ts", "tests/local-ports.test.ts", "tests/integration-buckets.test.ts", "tests/integration-worker-databases.test.ts", "tests/kid-tokens.test.ts", "tests/kid-no-mantine.test.ts", "tests/parent-mantine-scope.test.ts", "tests/kid-design-tokens.test.ts", "tests/e2e/spec-projects.test.ts", "tests/ai-sdk-scope.test.ts", "tests/probes/probe-costs.test.ts", "tests/probes/probe-helpers.test.ts"],
    passWithNoTests: true,
    environment: "node",
    // Wątki zamiast procesów (`forks`): ok. 1/4 krócej, głównie na imporcie modułów.
    pool: "threads",
    server: { deps: { inline: [/@mantine\//] } },
  },
  // JSX jak w Next.js (automatyczny runtime) — komponenty nie importują Reacta
  esbuild: {
    jsx: "automatic",
  },
});
