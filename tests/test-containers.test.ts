import { hostname } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyContainer,
  currentPidNamespace,
  ContainerNameTakenError,
  type ContainerRuntime,
  isNameConflictError,
  isOwnedByThisProcess,
  isReservedByAnotherRun,
  MAX_CONTAINER_AGE_MS,
  OWNER_HOST_LABEL,
  OWNER_PID_LABEL,
  OWNER_PID_NAMESPACE_LABEL,
  type OwnerContext,
  parseDockerTimestamp,
  parseHostPort,
  parseInspectOutput,
  POSTGRES_IMAGE,
  selectStaleContainers,
  startPostgresContainer,
  type TestContainer,
} from "./test-containers";

const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const LIVE_PIDS = new Set([1111, 2222]);
const context: OwnerContext = { host: "box", pidNamespace: "win32", now: NOW, isProcessAlive: (pid) => LIVE_PIDS.has(pid) };

function container(name: string, labels: Record<string, string> = {}, ageMs = 60_000): TestContainer {
  return { id: `id-${name}`, name, createdAt: NOW - ageMs, labels };
}

function owned(name: string, pid: number, host = "box"): TestContainer {
  return container(name, { [OWNER_PID_LABEL]: String(pid), [OWNER_HOST_LABEL]: host });
}

describe("selectStaleContainers", () => {
  it("keeps containers of live runs regardless of their run ID prefix", () => {
    // Regresja: przebieg z domyślnym prefiksem `knowli-it-` usuwał bazę
    // równoległego przebiegu `knowli-it-s106-<pid>`.
    const containers = [owned("knowli-it-1111", 1111), owned("knowli-it-s106-2222", 2222)];
    expect(selectStaleContainers(containers, context)).toEqual([]);
  });

  it("removes containers whose owner process is gone", () => {
    const orphan = owned("knowli-it-s106-3333", 3333);
    expect(selectStaleContainers([owned("knowli-it-1111", 1111), orphan], context)).toEqual([orphan]);
  });

  it("falls back to the pid in the name for containers without labels", () => {
    const legacyLive = container("knowli-it-run-a-2222");
    const legacyDead = container("knowli-it-4444");
    expect(selectStaleContainers([legacyLive, legacyDead], context)).toEqual([legacyDead]);
  });

  it("leaves containers with an unknown owner alone until they are too old", () => {
    const noPid = container("knowli-e2e");
    const otherHost = owned("knowli-it-3333", 3333, "wsl");
    expect(classifyContainer(noPid, context)).toBe("unknown");
    expect(classifyContainer(otherHost, context)).toBe("unknown");
    expect(selectStaleContainers([noPid, otherHost], context)).toEqual([]);
  });

  it("keeps a container of a live owner even when it is older than the age limit", () => {
    // Np. `playwright test --ui` otwarte dłużej niż dobę.
    const longLived = container("knowli-it-1111", { [OWNER_PID_LABEL]: "1111" }, MAX_CONTAINER_AGE_MS + 1);
    expect(classifyContainer(longLived, context)).toBe("live");
    expect(selectStaleContainers([longLived], context)).toEqual([]);
  });

  it("treats unverifiable owners as stale only past the age limit", () => {
    const otherHostOld = owned("knowli-it-wsl-9", 9, "wsl");
    otherHostOld.createdAt = NOW - MAX_CONTAINER_AGE_MS - 1;
    const noPidOld = container("knowli-e2e", { [OWNER_PID_LABEL]: "abc" }, MAX_CONTAINER_AGE_MS + 1);
    expect(selectStaleContainers([otherHostOld, noPidOld], context)).toEqual([otherHostOld, noPidOld]);
  });

  it("never marks containers that are not test containers as stale", () => {
    const composeDb = container("knowli-db-1", { "com.docker.compose.service": "db" }, 30 * MAX_CONTAINER_AGE_MS);
    const plainE2e = container("knowli-e2e", {}, 2 * MAX_CONTAINER_AGE_MS);
    expect(classifyContainer(composeDb, context)).toBe("unknown");
    expect(selectStaleContainers([composeDb, plainE2e], context)).toEqual([]);
  });

  it("prefers the owner label over the name suffix", () => {
    expect(classifyContainer(container("knowli-it-3333", { [OWNER_PID_LABEL]: "1111" }), context)).toBe("live");
    expect(classifyContainer(owned("knowli-e2e", 1111), context)).toBe("live");
    expect(classifyContainer(owned("knowli-e2e", 3333), context)).toBe("stale");
  });

  it("ignores malformed owner pids", () => {
    expect(classifyContainer(container("knowli-e2e", { [OWNER_PID_LABEL]: "abc" }), context)).toBe("unknown");
    expect(classifyContainer(container("knowli-e2e", { [OWNER_PID_LABEL]: "0" }), context)).toBe("unknown");
  });
});

describe("pid namespaces", () => {
  // WSL i Windows na jednym Docker Desktop mogą mieć tę samą nazwę hosta.
  const wslLabels = (pid: number) => ({
    [OWNER_PID_LABEL]: String(pid),
    [OWNER_HOST_LABEL]: "box",
    [OWNER_PID_NAMESPACE_LABEL]: "linux:pid:[4026531836]",
  });

  it("does not judge a pid from another namespace under the same hostname", () => {
    const wslRun = container("knowli-e2e", wslLabels(3333));
    expect(classifyContainer(wslRun, context)).toBe("unknown");
    expect(isReservedByAnotherRun(wslRun, context)).toBe(true);
    expect(selectStaleContainers([container("knowli-it-wsl-3333", wslLabels(3333))], context)).toEqual([]);
  });

  it("frees a container from another namespace only past the age limit", () => {
    const oldWslRun = container("knowli-it-wsl-3333", wslLabels(3333), MAX_CONTAINER_AGE_MS + 1);
    expect(classifyContainer(oldWslRun, context)).toBe("stale");
    expect(isReservedByAnotherRun(oldWslRun, context)).toBe(false);
  });

  it("checks pids from the same namespace as before", () => {
    const sameNamespace = (pid: number) => container("knowli-e2e", { ...wslLabels(pid), [OWNER_PID_NAMESPACE_LABEL]: "win32" });
    expect(classifyContainer(sameNamespace(1111), context)).toBe("live");
    expect(classifyContainer(sameNamespace(3333), context)).toBe("stale");
  });

  it("identifies the current namespace by platform, and by the pid namespace inode on Linux", () => {
    const namespace = currentPidNamespace();
    if (process.platform === "linux") expect(namespace).toMatch(/^linux(:pid:\[\d+\])?$/);
    else expect(namespace).toBe(process.platform);
  });
});

describe("isReservedByAnotherRun", () => {
  it("blocks reuse of a container owned by a live run", () => {
    expect(isReservedByAnotherRun(owned("knowli-e2e", 1111), context)).toBe(true);
  });

  it("blocks reuse of a labelled container from another host whose pid cannot be checked", () => {
    // Np. WSL i Windows na jednym Docker Desktop: pid z WSL nic tu nie znaczy.
    expect(isReservedByAnotherRun(owned("knowli-e2e", 3333, "wsl"), context)).toBe(true);
  });

  it("allows removing orphans, legacy unlabelled containers and day-old foreign containers", () => {
    const oldForeign = owned("knowli-e2e", 3333, "wsl");
    oldForeign.createdAt = NOW - MAX_CONTAINER_AGE_MS - 1;
    expect(isReservedByAnotherRun(owned("knowli-e2e", 3333), context)).toBe(false);
    expect(isReservedByAnotherRun(container("knowli-e2e"), context)).toBe(false);
    expect(isReservedByAnotherRun(oldForeign, context)).toBe(false);
  });
});

describe("isNameConflictError", () => {
  it("recognises docker's name conflict only", () => {
    const conflict = Object.assign(new Error("Command failed"), {
      stderr: 'docker: Error response from daemon: Conflict. The container name "/knowli-e2e" is already in use by container "abc". You have to remove (or rename) that container to be able to reuse that name.',
    });
    expect(isNameConflictError(conflict)).toBe(true);
    expect(isNameConflictError(Object.assign(new Error("x"), { stderr: "port is already allocated" }))).toBe(false);
    expect(isNameConflictError(new Error("no stderr"))).toBe(false);
    expect(isNameConflictError(null)).toBe(false);
  });
});

describe("isOwnedByThisProcess", () => {
  it("matches only this process's pid and host labels", () => {
    const host = hostname();
    const own = { [OWNER_PID_LABEL]: String(process.pid), [OWNER_HOST_LABEL]: host, [OWNER_PID_NAMESPACE_LABEL]: currentPidNamespace() };
    expect(isOwnedByThisProcess(container("knowli-e2e", own))).toBe(true);
    expect(isOwnedByThisProcess(container("knowli-e2e", { ...own, [OWNER_HOST_LABEL]: `${host}-x` }))).toBe(false);
    expect(isOwnedByThisProcess(container("knowli-e2e", { ...own, [OWNER_PID_LABEL]: String(process.pid + 1) }))).toBe(false);
    expect(isOwnedByThisProcess(container("knowli-e2e", { ...own, [OWNER_PID_NAMESPACE_LABEL]: "linux:pid:[1]" }))).toBe(false);
    expect(isOwnedByThisProcess(container("knowli-e2e"))).toBe(false);
  });
});

describe("docker inspect parsing", () => {
  it("parses nanosecond timestamps", () => {
    expect(parseDockerTimestamp("2026-10-30T11:59:00.123456789Z")).toBe(Date.parse("2026-10-30T11:59:00.123Z"));
    expect(parseDockerTimestamp("2026-10-30T11:59:00Z")).toBe(Date.parse("2026-10-30T11:59:00Z"));
  });

  it("maps inspect entries and tolerates missing labels", () => {
    const output = JSON.stringify([
      { Id: "abc", Name: "/knowli-it-1111", Created: "2026-10-30T11:59:00.5Z", Config: { Labels: { [OWNER_PID_LABEL]: "1111" } } },
      { Id: "def", Name: "/knowli-e2e", Created: "2026-10-30T11:59:00Z", Config: { Labels: null } },
    ]);
    expect(parseInspectOutput(output)).toEqual([
      { id: "abc", name: "knowli-it-1111", createdAt: Date.parse("2026-10-30T11:59:00.5Z"), labels: { [OWNER_PID_LABEL]: "1111" } },
      { id: "def", name: "knowli-e2e", createdAt: Date.parse("2026-10-30T11:59:00Z"), labels: {} },
    ]);
    expect(parseInspectOutput("")).toEqual([]);
  });
});

describe("parseHostPort", () => {
  it("reads the IPv4 host port from both docker output forms", () => {
    expect(parseHostPort("0.0.0.0:55001\n[::]:55001\n")).toBe("55001");
    expect(parseHostPort("5432/tcp -> 0.0.0.0:55002")).toBe("55002");
    expect(() => parseHostPort("[::]:55001")).toThrow(/portu kontenera/);
  });
});

// Fake demona: kontenery po ID, konflikt nazwy jak w Dockerze, scenariusz
// kolejnych `run` i liczba „cichych” niepowodzeń `rm -f`.
class FakeRuntime implements ContainerRuntime {
  readonly containers = new Map<string, TestContainer>();
  runScript: Array<"ok" | "error" | "created-then-error"> = [];
  removeFailures = 0;
  lastRunArgs: readonly string[] = [];
  private nextId = 1;

  run(args: readonly string[]): Promise<string> {
    this.lastRunArgs = args;
    const name = args[args.indexOf("--name") + 1]!;
    const labels: Record<string, string> = {};
    args.forEach((arg, index) => {
      if (arg === "--label") {
        const [key, ...value] = args[index + 1]!.split("=");
        labels[key!] = value.join("=");
      }
    });
    if ([...this.containers.values()].some((c) => c.name === name)) {
      return Promise.reject(Object.assign(new Error("Command failed"), {
        stderr: `Conflict. The container name "/${name}" is already in use by container "x".`,
      }));
    }
    const step = this.runScript.shift() ?? "ok";
    if (step === "error") return Promise.reject(new Error("daemon hiccup"));
    const id = `c${this.nextId++}`;
    this.containers.set(id, { id, name, createdAt: NOW, labels });
    return step === "created-then-error" ? Promise.reject(new Error("start failed")) : Promise.resolve(id);
  }

  port(): Promise<string> {
    return Promise.resolve("0.0.0.0:55001\n[::]:55001\n");
  }

  find(name: string): Promise<TestContainer | null> {
    return Promise.resolve([...this.containers.values()].find((c) => c.name === name) ?? null);
  }

  remove(id: string): Promise<void> {
    if (this.removeFailures > 0) this.removeFailures -= 1;
    else this.containers.delete(id);
    return Promise.resolve();
  }

  sleep(): Promise<void> {
    return Promise.resolve();
  }
}

describe("startPostgresContainer", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function failingPrepare(failures: number): (url: string) => Promise<void> {
    let left = failures;
    return () => (left-- > 0 ? Promise.reject(new Error("db not ready")) : Promise.resolve());
  }

  it("starts a labelled container and returns its URL", async () => {
    const runtime = new FakeRuntime();
    const started = await startPostgresContainer({ name: "knowli-e2e", label: "e2e", runtime, prepare: failingPrepare(0) });
    expect(started.url).toBe("postgres://postgres:test@127.0.0.1:55001/postgres");
    expect([...runtime.containers.keys()]).toEqual([started.id]);
    expect(isOwnedByThisProcess(runtime.containers.get(started.id)!)).toBe(true);
  });

  it("keeps the disposable database in tmpfs without durable writes", async () => {
    const runtime = new FakeRuntime();
    await startPostgresContainer({ name: "knowli-it-1", label: "it", runtime, prepare: failingPrepare(0) });
    const args = runtime.lastRunArgs;
    expect(args[args.indexOf("--tmpfs") + 1]).toBe("/var/lib/postgresql/data");
    // Opcje serwera po nazwie obrazu, nie opcje `docker run`.
    const imageIndex = args.indexOf(POSTGRES_IMAGE);
    expect(imageIndex).toBeGreaterThan(args.indexOf("--tmpfs"));
    expect(args.slice(imageIndex + 1)).toEqual([
      "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off", "-c", "max_wal_size=256MB",
    ]);
  });

  it("removes its failed container by ID before retrying", async () => {
    const runtime = new FakeRuntime();
    const started = await startPostgresContainer({ name: "knowli-e2e", label: "e2e", runtime, prepare: failingPrepare(1) });
    expect(started.id).toBe("c2");
    expect([...runtime.containers.keys()]).toEqual(["c2"]);
  });

  it("adopts its own leftover after a silent rm failure instead of reporting a parallel run", async () => {
    // Regresja z review: konflikt z własnym kontenerem kończył przebieg
    // błędem „należy do trwającego przebiegu” zamiast ponowić start.
    const runtime = new FakeRuntime();
    runtime.removeFailures = 1;
    const started = await startPostgresContainer({ name: "knowli-e2e", label: "e2e", runtime, prepare: failingPrepare(1) });
    expect(started.id).toBe("c2");
    expect([...runtime.containers.keys()]).toEqual(["c2"]);
  });

  it("cleans up a container that docker run created before failing", async () => {
    const runtime = new FakeRuntime();
    runtime.runScript = ["created-then-error"];
    const started = await startPostgresContainer({ name: "knowli-e2e", label: "e2e", runtime, prepare: failingPrepare(0) });
    expect(started.id).toBe("c2");
    expect([...runtime.containers.keys()]).toEqual(["c2"]);
  });

  it("stops without touching a container another run started under the same name", async () => {
    const runtime = new FakeRuntime();
    const foreign = owned("knowli-e2e", 4242);
    runtime.containers.set(foreign.id, foreign);
    const start = startPostgresContainer({ name: "knowli-e2e", label: "e2e", runtime, prepare: failingPrepare(0) });
    await expect(start).rejects.toBeInstanceOf(ContainerNameTakenError);
    await expect(start).rejects.toMatchObject({ owner: foreign });
    expect([...runtime.containers.values()]).toEqual([foreign]);
  });

  it("removes its own container and rethrows after the last failed attempt", async () => {
    const runtime = new FakeRuntime();
    const start = startPostgresContainer({ name: "knowli-it-1", label: "it", runtime, prepare: failingPrepare(3) });
    await expect(start).rejects.toThrow("db not ready");
    expect(runtime.containers.size).toBe(0);
  });

  it("retries when docker run fails without creating a container", async () => {
    const runtime = new FakeRuntime();
    runtime.runScript = ["error"];
    const started = await startPostgresContainer({ name: "knowli-it-1", label: "it", runtime, prepare: failingPrepare(0) });
    expect([...runtime.containers.keys()]).toEqual([started.id]);
  });
});
