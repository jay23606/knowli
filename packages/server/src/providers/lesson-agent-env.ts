import {
  agentGraderFromEnv,
  lessonAgentPolicyFromEnv,
  lessonAgentSettingsFromEnv,
  type LessonAgentDeps,
  type LessonAgentUnavailable,
} from "../config";
import type { UsageRecorder } from "../ports/usage";
import { FakeExerciseChecker, FakeLessonPoolAgent } from "./fake-lesson-agent";
import { fakeLessonDelayMsFromEnv } from "./generation-env";
import { AiSdkExerciseChecker, AiSdkLessonPoolAgent } from "./openai/lesson-pool-agent";

/**
 * Składanie agenta puli lekcji (spec etapu 2a §5, etapu 3 §5) — wyłącznie w workerze, przez
 * osobny eksport pakietu `@learning/server/lesson-agent`. Ten plik jako jedyny
 * (poza testami adaptera i `tests/probes`) sięga po adapter AI SDK, a `config.ts`,
 * `generation-env.ts` i `index.ts` go nie importują, więc proces web nie ładuje SDK
 * (pilnuje `lesson-agent-imports.architecture.test.ts`). Agent obsługuje każdy przedmiot.
 *
 * - `UMIEM_FAKE_PROVIDERS=1` (bez klucza) → fake agenta z deterministycznym generatorem
 *   (opóźnienie z `UMIEM_FAKE_LESSON_DELAY_MS`/`UMIEM_FAKE_DELAY_MS`), bez historii wywołań
 *   (proces workera żyje długo) i z zerowym kosztem kroku (szacunek zużywałby budżet runu),
 *   oraz checker bez wyniku (ćwiczenia przechodzą bez kontroli); bez `usage` — fake nie woła
 *   żadnej usługi, więc tryb fake nie zapisuje kosztów;
 * - inaczej {@link lessonAgentSettingsFromEnv}: brak klucza OpenRouter → {@link LessonAgentUnavailable}
 *   (bez logu — linię startu pisze worker); ustawienia → adaptery OpenRouter oraz, przy pełnej
 *   konfiguracji `UMIEM_GRADER_*`, grader kontroli otwartej (etap 2b; tryb fake go nie składa).
 *   Błędna konfiguracja (także klucz w kształcie OpenAI) to błąd startu z nazwą zmiennej.
 */
export function lessonAgentDepsFromEnv(
  env: Record<string, string | undefined>,
  usage?: UsageRecorder,
): LessonAgentDeps | LessonAgentUnavailable {
  if (env.UMIEM_FAKE_PROVIDERS === "1") {
    return {
      agent: new FakeLessonPoolAgent({ generate: { delayMs: fakeLessonDelayMsFromEnv(env) }, record: false, stepCostUsd: 0 }),
      checker: new FakeExerciseChecker({ unavailable: true }),
      policy: lessonAgentPolicyFromEnv(env),
    };
  }
  const settings = lessonAgentSettingsFromEnv(env);
  if (settings === undefined) return { unavailable: "no_openrouter_key" };
  const common = { apiKey: settings.apiKey, ...(usage ? { usage } : {}) };
  // Grader kontroli otwartej (etap 2b): ta sama konfiguracja `UMIEM_GRADER_*` co w web; brak = bez kontroli.
  const grader = agentGraderFromEnv(env, usage);
  return {
    agent: new AiSdkLessonPoolAgent({
      ...common,
      model: settings.model,
      effort: settings.effort,
      ...(settings.provider ? { provider: settings.provider } : {}),
    }),
    checker: new AiSdkExerciseChecker({
      ...common,
      model: settings.checkerModel,
      effort: settings.checkerEffort,
      ...(settings.checkerProvider ? { provider: settings.checkerProvider } : {}),
    }),
    ...(grader === undefined ? {} : { grader }),
    policy: settings.policy,
  };
}
