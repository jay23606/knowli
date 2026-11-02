import type { UsageEvent, UsageRecorder } from "../../ports/usage";

/** Rekorder do testów adapterów: zbiera zdarzenia w pamięci. */
export interface TestUsageRecorder extends UsageRecorder {
  events: UsageEvent[];
}

export function createTestRecorder(): TestUsageRecorder {
  const events: UsageEvent[] = [];
  return {
    events,
    record(event) {
      events.push(event);
    },
    flush: async () => {},
  };
}

/** Rekorder, którego `record` rzuca — dowód, że adapter jest odporny niezależnie od recordera. */
export function createThrowingRecorder(): UsageRecorder {
  return {
    record() {
      throw new Error("recorder exploded");
    },
    flush: async () => {},
  };
}
