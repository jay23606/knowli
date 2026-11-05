import { describe, expect, it } from "vitest";
import {
  currentPoolId,
  defaultIntegrationWorkers,
  workerDatabaseName,
  workerDatabaseUrl,
} from "./integration-worker-databases";

describe("bazy workerów integracji (integration-worker-databases)", () => {
  it("domyślna liczba workerów to połowa wątków w zakresie 2–6", () => {
    expect(defaultIntegrationWorkers(1)).toBe(2);
    expect(defaultIntegrationWorkers(4)).toBe(2);
    expect(defaultIntegrationWorkers(8)).toBe(4);
    expect(defaultIntegrationWorkers(12)).toBe(6);
    expect(defaultIntegrationWorkers(16)).toBe(6);
  });

  it("URL workera podmienia tylko nazwę bazy", () => {
    expect(workerDatabaseName(3)).toBe("knowli_w3");
    expect(workerDatabaseUrl("postgres://postgres:secret@127.0.0.1:54321/knowli?sslmode=disable", 3))
      .toBe("postgres://postgres:secret@127.0.0.1:54321/knowli_w3?sslmode=disable");
    expect(() => workerDatabaseName(0)).toThrow(/workera/);
  });

  it("numer workera pochodzi z VITEST_POOL_ID i mieści się w liczbie baz", () => {
    expect(currentPoolId({ VITEST_POOL_ID: "1" }, 4)).toBe(1);
    expect(currentPoolId({ VITEST_POOL_ID: "4" }, 4)).toBe(4);
    for (const raw of [undefined, "", "0", "5", "a", "1.5"]) {
      expect(() => currentPoolId({ VITEST_POOL_ID: raw }, 4)).toThrow(/VITEST_POOL_ID/);
    }
  });
});
