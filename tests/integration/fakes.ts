import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalMediaStore,
  deterministicBytes,
  FakeImageProvider,
  FakeLlmProvider,
  FakeTtsProvider,
  fakeMediaSettings,
  type GenerationDeps,
  type MediaSettings,
  type MediaStore,
  type UsageFeature,
  type UsageRecorder,
} from "@learning/server";
import {
  FakeExerciseChecker,
  FakeLessonPoolAgent,
  type FakeLessonPoolAgentOptions,
} from "../../packages/server/src/providers/fake-lesson-agent";
import type { LessonAgentPolicy } from "../../packages/server/src/modules/materials/lessons/lesson-pool-agent-policy";

// Klasy fake'ów żyją w packages/server (współdzielone z trybem
// UMIEM_FAKE_PROVIDERS=1); testy tylko konfigurują zachowania.
export {
  deterministicBytes,
  FakeImageProvider,
  FakeLlmProvider,
  FakeTtsProvider,
  fakeMediaSettings,
  type LlmBehavior,
} from "@learning/server";

export interface FakeGeneration {
  llm: FakeLlmProvider;
  /** Agent puli lekcji składany zawsze (etap 3: jedyny generator lekcji). */
  agent: FakeLessonPoolAgent;
  tts: FakeTtsProvider;
  image: FakeImageProvider;
  store: MediaStore;
  settings: MediaSettings;
  deps: GenerationDeps;
  root: string;
  dispose: () => Promise<void>;
}

export interface FakeGenerationOptions {
  /** Opcje fake'a agenta, nadpisują domyślne `generate: {}`. */
  agent?: FakeLessonPoolAgentOptions;
  /** Checker zamiast domyślnego „niedostępnego”. */
  checker?: FakeExerciseChecker;
  policy?: Partial<LessonAgentPolicy>;
}

export async function fakeGeneration(options: FakeGenerationOptions = {}): Promise<FakeGeneration> {
  const root = await mkdtemp(join(tmpdir(), "knowli-media-"));
  const store = createLocalMediaStore(root);
  const llm = new FakeLlmProvider();
  const tts = new FakeTtsProvider();
  const image = new FakeImageProvider();
  const settings = fakeMediaSettings;
  const agent = new FakeLessonPoolAgent({ generate: {}, ...options.agent });
  return {
    llm,
    tts,
    image,
    store,
    settings,
    agent,
    deps: {
      llm,
      tts,
      image,
      mediaStore: store,
      lessonAgent: {
        agent,
        checker: options.checker ?? new FakeExerciseChecker({ unavailable: true }),
        policy: options.policy ?? {},
      },
    },
    root,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

/**
 * Fake providera, który przy każdym wywołaniu metody zwracającej obietnicę zapisuje
 * zdarzenie kosztu — jak prawdziwy adapter, ale bez HTTP. Metoda jest wołana na
 * oryginale (`Reflect.apply(fn, target, args)`): fake'i mają pola `#private`, a
 * `this` równe proxy rzuciłoby TypeError. Wartości niebędące obietnicą (nazwa,
 * wersja promptu) nie są wywołaniami płatnej usługi i niczego nie zapisują.
 */
export function recordingProvider<T extends object>(provider: T, usage: UsageRecorder, feature: UsageFeature): T {
  return new Proxy(provider, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(value, target, args);
        if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
          usage.record({ feature, provider: "fake", outcome: "ok" });
        }
        return result;
      };
    },
  });
}

/** Znacznik "obcego" właściciela lease symulowany w testach awarii workera. */
export function staleLeaseToken(): string {
  return randomUUID();
}
