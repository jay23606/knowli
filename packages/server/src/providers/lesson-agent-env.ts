import {
  lessonAgentPolicyFromEnv,
  lessonAgentSettingsFromEnv,
  lessonAgentSubjectsFromEnv,
  type LessonAgentDeps,
} from "../config";
import type { SubjectRegistry } from "../domain/lessons/registry";
import type { LlmProvider } from "../ports/ai";
import type { UsageRecorder } from "../ports/usage";
import { FakeExerciseChecker, FakeLessonPoolAgent } from "./fake-lesson-agent";
import { AiSdkExerciseChecker, AiSdkLessonPoolAgent } from "./openai/lesson-pool-agent";

/**
 * Składanie agenta puli lekcji (spec etapu 2a §5) — wyłącznie w workerze, przez
 * osobny eksport pakietu `@learning/server/lesson-agent`. Ten plik jako jedyny
 * (poza testami adaptera i `tests/probes`) sięga po adapter AI SDK, a `config.ts`,
 * `generation-env.ts` i `index.ts` go nie importują, więc proces web nie ładuje SDK
 * (pilnuje `lesson-agent-imports.architecture.test.ts`).
 *
 * - `UMIEM_FAKE_PROVIDERS=1` i niepusta lista (po walidacji, bez klucza) → fake agenta
 *   „jak LLM” (`fromLlm`) i checker bez wyniku (ćwiczenia przechodzą bez kontroli); bez
 *   `usage` — fake nie woła żadnej usługi, więc tryb fake nie zapisuje kosztów;
 * - inaczej {@link lessonAgentSettingsFromEnv}: `undefined` (pusta lista albo brak klucza)
 *   → `undefined`, czyli lekcje generuje potok; ustawienia → adaptery OpenRouter.
 */
export function lessonAgentDepsFromEnv(
  env: Record<string, string | undefined>,
  subjects: Pick<SubjectRegistry, "getSubject">,
  usage?: UsageRecorder,
  llm?: LlmProvider,
): LessonAgentDeps | undefined {
  if (env.UMIEM_FAKE_PROVIDERS === "1") {
    const ids = lessonAgentSubjectsFromEnv(env, subjects);
    if (ids.size === 0) return undefined;
    return {
      subjects: ids,
      agent: new FakeLessonPoolAgent(llm ? { fromLlm: llm } : {}),
      checker: new FakeExerciseChecker({ unavailable: true }),
      policy: lessonAgentPolicyFromEnv(env),
    };
  }
  const settings = lessonAgentSettingsFromEnv(env, subjects);
  if (settings === undefined) return undefined;
  const common = { apiKey: settings.apiKey, ...(usage ? { usage } : {}) };
  return {
    subjects: settings.subjects,
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
    policy: settings.policy,
  };
}
