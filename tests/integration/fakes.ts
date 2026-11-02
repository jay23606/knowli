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
  tts: FakeTtsProvider;
  image: FakeImageProvider;
  store: MediaStore;
  settings: MediaSettings;
  deps: GenerationDeps;
  root: string;
  dispose: () => Promise<void>;
}

export async function fakeGeneration(): Promise<FakeGeneration> {
  const root = await mkdtemp(join(tmpdir(), "knowli-media-"));
  const store = createLocalMediaStore(root);
  const llm = new FakeLlmProvider();
  const tts = new FakeTtsProvider();
  const image = new FakeImageProvider();
  const settings = fakeMediaSettings;
  return {
    llm,
    tts,
    image,
    store,
    settings,
    deps: { llm, tts, image, mediaStore: store },
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
