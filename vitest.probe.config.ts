import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { loadDotEnv } from "./tests/probes/probe-helpers";

// Próby na prawdziwych providerach (płatne wywołania LLM): ręcznie, nigdy w CI.
// Infrastruktura jak w testach integracyjnych — PostgreSQL w kontenerze docker
// z global-setup, żeby wywołać prawdziwy `executeLessonGeneration`. Plik próby
// generowania sam się pomija bez zmiennej `UMIEM_PROBE_MATERIAL` (gramatyka: bez
// `UMIEM_PROBE_SUBJECT=grammar`, która działa też bez pliku materiału); wtedy nie
// startujemy też kontenera. Pliki `*.probe.test.ts` nie wchodzą do konfiguracji
// unit ani integration.
//
// Uruchomienie: `UMIEM_PROBE_MATERIAL=<plik> pnpm probe:chapter` albo
// `UMIEM_PROBE_SUBJECT=grammar pnpm probe:chapter`. Próba przeglądu krytyka
// (`UMIEM_PROBE_REVIEW_DUMP=<plik> pnpm probe:review`) nie używa bazy, więc jej
// zmienna nie startuje kontenera.
// Próba agenta puli lekcji (`pnpm probe:agent`, zmienne `UMIEM_PROBE_AGENT_*`, #237) też
// działa bez bazy; jej wejściem jest materiał albo zrzut zagadnień z `probe:chapter`.
//
// .env wczytany przed decyzją (bez nadpisywania środowiska) — tak samo jak w plikach prób.
loadDotEnv();
const enabled = Boolean(process.env.UMIEM_PROBE_MATERIAL?.trim()) || process.env.UMIEM_PROBE_SUBJECT?.trim() === "grammar";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/probes/**/*.probe.test.ts"],
    globalSetup: enabled ? ["./tests/integration/global-setup.ts"] : [],
    // Raport próby to stdout testu; reporter „agent” (auto w sesjach agentów)
    // ukrywa wyjście zaliczonych testów.
    reporters: ["default"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 30 * 60_000,
    hookTimeout: 180_000,
  },
});
