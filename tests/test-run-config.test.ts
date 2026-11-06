import { describe, expect, it } from "vitest";
import { readTestRunConfig } from "./test-run-config";

describe("readTestRunConfig", () => {
  it("isolates runner resources by run ID", () => {
    const a = readTestRunConfig({ UMIEM_TEST_RUN_ID: "run-a", UMIEM_E2E_PORT: "24510" });
    const b = readTestRunConfig({ UMIEM_TEST_RUN_ID: "run-b", UMIEM_E2E_PORT: "24511" });

    expect(a.integrationContainerPrefix).not.toBe(b.integrationContainerPrefix);
    expect(a.e2eContainer).not.toBe(b.e2eContainer);
    expect(a.worldFile).not.toBe(b.worldFile);
    expect(a.fakeHoldFile).not.toBe(b.fakeHoldFile);
    expect(a.outputDir).not.toBe(b.outputDir);
    expect(a.outputDir).toBe("test-results/run-a");
    expect(a.workerHealthPort).not.toBe(b.workerHealthPort);
    expect(a.e2ePort).toBe(24510);
    expect(b.e2ePort).toBe(24511);
    expect(a.workerHealthPort).toBe(34510);
    expect(b.workerHealthPort).toBe(34511);
  });

  it("preserves the current runner defaults", () => {
    expect(readTestRunConfig({})).toEqual({
      integrationContainerPrefix: "knowli-it-",
      e2eContainer: "knowli-e2e",
      e2ePort: 24500,
      workerHealthPort: 9301,
      worldFile: "tests/e2e/.world.json",
      fakeHoldFile: "tests/e2e/.fake-hold",
      outputDir: "test-results",
      e2eWebMode: "start",
      e2eSkipBuild: false,
      e2eWorkers: 4,
      e2eBucket: null,
      integrationBucket: null,
      integrationWorkers: null,
    });
  });

  it.each(["", "Run-A", "run_a", "../run-a", "run/a"])("rejects unsafe run ID %j", (runId) => {
    expect(() => readTestRunConfig({ UMIEM_TEST_RUN_ID: runId })).toThrow(/UMIEM_TEST_RUN_ID/);
  });

  it.each(["", "abc", "1023", "65536", "24x10"])("rejects invalid E2E port %j", (port) => {
    expect(() => readTestRunConfig({ UMIEM_E2E_PORT: port })).toThrow(/UMIEM_E2E_PORT/);
  });

  it.each(["", "abc", "1023", "65536", "24x10"])("rejects invalid worker health port %j", (port) => {
    expect(() => readTestRunConfig({ UMIEM_WORKER_HEALTH_PORT: port })).toThrow(/UMIEM_WORKER_HEALTH_PORT/);
  });

  it("defaults to production web mode and allows dev opt-in", () => {
    expect(readTestRunConfig({}).e2eWebMode).toBe("start");
    expect(readTestRunConfig({ UMIEM_E2E_WEB_MODE: "start" }).e2eWebMode).toBe("start");
    expect(readTestRunConfig({ UMIEM_E2E_WEB_MODE: "dev" }).e2eWebMode).toBe("dev");
  });

  it.each(["", "prod", "START", "1"])("rejects invalid web mode %j", (mode) => {
    expect(() => readTestRunConfig({ UMIEM_E2E_WEB_MODE: mode })).toThrow(/UMIEM_E2E_WEB_MODE/);
  });

  it("parses skip-build flag", () => {
    expect(readTestRunConfig({}).e2eSkipBuild).toBe(false);
    expect(readTestRunConfig({ UMIEM_E2E_SKIP_BUILD: "0" }).e2eSkipBuild).toBe(false);
    expect(readTestRunConfig({ UMIEM_E2E_SKIP_BUILD: "1" }).e2eSkipBuild).toBe(true);
  });

  it.each(["", "true", "2"])("rejects invalid skip-build %j", (value) => {
    expect(() => readTestRunConfig({ UMIEM_E2E_SKIP_BUILD: value })).toThrow(/UMIEM_E2E_SKIP_BUILD/);
  });

  it("parses workers with a default of 4", () => {
    expect(readTestRunConfig({}).e2eWorkers).toBe(4);
    expect(readTestRunConfig({ UMIEM_E2E_WORKERS: "1" }).e2eWorkers).toBe(1);
    expect(readTestRunConfig({ UMIEM_E2E_WORKERS: "32" }).e2eWorkers).toBe(32);
  });

  it.each(["", "0", "33", "-1", "2x", "50%"])("rejects invalid workers %j", (value) => {
    expect(() => readTestRunConfig({ UMIEM_E2E_WORKERS: value })).toThrow(/UMIEM_E2E_WORKERS/);
  });

  it("parses bucket; unset and empty mean all real specs", () => {
    expect(readTestRunConfig({}).e2eBucket).toBeNull();
    expect(readTestRunConfig({ UMIEM_E2E_BUCKET: "" }).e2eBucket).toBeNull();
    expect(readTestRunConfig({ UMIEM_E2E_BUCKET: "1" }).e2eBucket).toBe(1);
    expect(readTestRunConfig({ UMIEM_E2E_BUCKET: "9" }).e2eBucket).toBe(9);
  });

  it.each(["0", "10", "-1", "a", "1.5"])("rejects invalid bucket %j", (value) => {
    expect(() => readTestRunConfig({ UMIEM_E2E_BUCKET: value })).toThrow(/UMIEM_E2E_BUCKET/);
  });

  it("parses integration bucket; unset and empty mean all integration specs", () => {
    expect(readTestRunConfig({}).integrationBucket).toBeNull();
    expect(readTestRunConfig({ UMIEM_INTEGRATION_BUCKET: "" }).integrationBucket).toBeNull();
    expect(readTestRunConfig({ UMIEM_INTEGRATION_BUCKET: "1" }).integrationBucket).toBe(1);
    expect(readTestRunConfig({ UMIEM_INTEGRATION_BUCKET: "9" }).integrationBucket).toBe(9);
  });

  it.each(["0", "10", "-1", "a", "1.5"])("rejects invalid integration bucket %j", (value) => {
    expect(() => readTestRunConfig({ UMIEM_INTEGRATION_BUCKET: value })).toThrow(/UMIEM_INTEGRATION_BUCKET/);
  });

  it("parses integration workers; unset and empty mean the CPU-based default", () => {
    expect(readTestRunConfig({}).integrationWorkers).toBeNull();
    expect(readTestRunConfig({ UMIEM_INTEGRATION_WORKERS: "" }).integrationWorkers).toBeNull();
    expect(readTestRunConfig({ UMIEM_INTEGRATION_WORKERS: "1" }).integrationWorkers).toBe(1);
    expect(readTestRunConfig({ UMIEM_INTEGRATION_WORKERS: "16" }).integrationWorkers).toBe(16);
  });

  it.each(["0", "17", "-1", "a", "1.5"])("rejects invalid integration workers %j", (value) => {
    expect(() => readTestRunConfig({ UMIEM_INTEGRATION_WORKERS: value })).toThrow(/UMIEM_INTEGRATION_WORKERS/);
  });
});
