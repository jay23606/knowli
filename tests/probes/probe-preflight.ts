import { lessonAgentPolicyFromEnv } from "@learning/server";
import { lessonAgentDepsFromEnv } from "@learning/server/lesson-agent";
import { OPENROUTER_BASE_URL } from "../../packages/server/src/providers/openai/lesson-pool-agent";
import { DEFAULT_BASE_URL as LLM_DEFAULT_BASE_URL } from "../../packages/server/src/providers/openai/llm";
import { endpointKeyFromEnv } from "../../packages/server/src/providers/openrouter-key";
import { probeEndpointHost } from "./probe-costs";

/**
 * Kontrola przed płatną próbą generowania lekcji agentem puli (`chapter-generation.probe.test.ts`,
 * spec etapu 3 §6.3). Czysta: bez sieci, bez `.env` i bez konsoli — dostaje gotowe `env`
 * (próba podaje je po `withConfigDefaults`) i tylko składa adaptery, nie wywołując ich. Próba
 * woła ją przed rejestrem kosztów i przed wpisem tymczasowym, więc każdy błąd tutaj kończy próbę
 * bez kosztu. Testy: `probe-preflight.test.ts` (konfiguracja unit).
 *
 * - tryb fake (`UMIEM_FAKE_PROVIDERS=1`) → błąd (próba ma mierzyć prawdziwe modele);
 * - szkoła bez pełnego `UMIEM_GRADER_*` (kontrola otwarta `openCheck=on`) → błąd z nazwami
 *   brakujących zmiennych;
 * - `lessonAgentDepsFromEnv` → `LessonAgentUnavailable` → błąd „brak klucza OpenRouter”; błędna
 *   konfiguracja agenta rzuca tak jak przy starcie workera (z nazwą zmiennej);
 * - strażnik hostów ({@link probeEndpointHost}: tylko https, OpenRouter albo jawne
 *   `allowHost`): agent i checker na stałym adresie OpenRouter, `UMIEM_LLM_BASE_URL` w szkole
 *   (etap zagadnień `generateLessonObjectives`), `UMIEM_GRADER_BASE_URL`, gdy grader agenta jest
 *   złożony (szkoła zawsze);
 * - szacunek = budżet runu agenta (`UMIEM_LESSON_AGENT_RUN_BUDGET_USD`), ×2 z „+N”
 *   (`addCount`: drugi run tej samej lekcji z własnym budżetem).
 */

export type ProbeSubjectKind = "chapter" | "school" | "grammar";

export interface ProbePreflight {
  /** Górny koszt próby (budżet runu, ×2 z „+N”) — wpis tymczasowy i kontrola limitu rejestru. */
  readonly estimateUsd: number;
  /** Hosty usług, do których próba wyśle dane (bez ścieżek i kluczy), bez powtórzeń. */
  readonly hosts: string[];
}

export function probePreflight(
  env: Record<string, string | undefined>,
  options: { subject: ProbeSubjectKind; addCount?: number; allowHost?: string },
): ProbePreflight {
  if (env.UMIEM_FAKE_PROVIDERS === "1") {
    throw new Error("UMIEM_FAKE_PROVIDERS=1 — próba mierzy prawdziwe modele; usuń tryb fake ze środowiska próby.");
  }
  if (options.addCount !== undefined && !(Number.isInteger(options.addCount) && options.addCount > 0)) {
    throw new Error(`UMIEM_PROBE_ADD_COUNT musi być dodatnią liczbą całkowitą, jest: ${String(options.addCount)}.`);
  }
  const school = options.subject === "school";
  if (school) {
    // Kontrola otwarta szkoły (openCheck=on) wymaga pełnego gradera; bez niego próba nie zmierzy etapu 2b.
    const baseUrl = env.UMIEM_GRADER_BASE_URL?.trim() || undefined;
    const missing = [
      ...(baseUrl === undefined ? ["UMIEM_GRADER_BASE_URL"] : []),
      ...(env.UMIEM_GRADER_MODEL?.trim() ? [] : ["UMIEM_GRADER_MODEL"]),
      ...(endpointKeyFromEnv(env, "UMIEM_GRADER", baseUrl) === undefined ? ["UMIEM_GRADER_API_KEY (albo OPENROUTER_API_KEY przy https OpenRouter)"] : []),
    ];
    if (missing.length > 0) {
      throw new Error(`Próba szkoły wymaga pełnego UMIEM_GRADER_* (kontrola otwarta openCheck=on); brak: ${missing.join(", ")}.`);
    }
  }

  const deps = lessonAgentDepsFromEnv(env);
  if ("unavailable" in deps) {
    throw new Error("Brak klucza OpenRouter dla agenta puli (UMIEM_LESSON_AGENT_API_KEY / OPENROUTER_API_KEY) — próba nie ma czego wywołać.");
  }
  if (school && deps.grader === undefined) {
    throw new Error("Próba szkoły: grader agenta nie został złożony mimo UMIEM_GRADER_* — sprawdź konfigurację.");
  }

  const allowHost = options.allowHost;
  const hosts = [
    probeEndpointHost(OPENROUTER_BASE_URL, "UMIEM_LESSON_AGENT (agent i checker)", allowHost),
    ...(school ? [probeEndpointHost(env.UMIEM_LLM_BASE_URL?.trim() || LLM_DEFAULT_BASE_URL, "UMIEM_LLM_BASE_URL", allowHost)] : []),
    ...(deps.grader !== undefined ? [probeEndpointHost(env.UMIEM_GRADER_BASE_URL, "UMIEM_GRADER_BASE_URL", allowHost)] : []),
  ];

  const runBudgetUsd = lessonAgentPolicyFromEnv(env).runBudgetUsd;
  if (runBudgetUsd === undefined) throw new Error("Brak budżetu runu agenta (UMIEM_LESSON_AGENT_RUN_BUDGET_USD).");
  return { estimateUsd: runBudgetUsd * (options.addCount === undefined ? 1 : 2), hosts: [...new Set(hosts)] };
}
