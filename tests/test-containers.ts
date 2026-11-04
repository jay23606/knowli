import { execFile } from "node:child_process";
import { readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { INTEGRATION_CONTAINER_PREFIX } from "./test-run-config";

const exec = promisify(execFile);

// Kontenery Postgresa testów niosą etykiety właściciela: pid procesu runnera
// (Vitest / Playwright) i host. Na jednej maszynie równolegle biegnie kilka
// przebiegów (sesje agentów, worktree) na wspólnym demonie Dockera; sprzątanie
// usuwa wyłącznie kontenery, których właściciel już nie żyje.
export const OWNER_PID_LABEL = "knowli.test-owner-pid";
export const OWNER_HOST_LABEL = "knowli.test-owner-host";
// Przestrzeń pid właściciela: WSL może mieć tę samą nazwę hosta co Windows,
// a jego pid nic nie znaczy dla `process.kill` po stronie Windows (i odwrotnie).
export const OWNER_PID_NAMESPACE_LABEL = "knowli.test-owner-pidns";

// Kontener, którego właściciela nie da się sprawdzić (inny host, brak pid),
// uznajemy za osierocony dopiero po dobie.
export const MAX_CONTAINER_AGE_MS = 24 * 60 * 60 * 1000;

const POSTGRES_IMAGE = "postgres:17-alpine";

export interface TestContainer {
  id: string;
  name: string;
  createdAt: number;
  labels: Record<string, string>;
}

export interface OwnerContext {
  host: string;
  pidNamespace: string;
  now: number;
  isProcessAlive: (pid: number) => boolean;
}

export type ContainerOwnership = "live" | "stale" | "unknown";

// Kontenery integracji sprzed etykiet: `knowli-it-[<runId>-]<pid>`.
const LEGACY_INTEGRATION_NAME = new RegExp(`^${INTEGRATION_CONTAINER_PREFIX}(?:[a-z0-9-]+-)?(\\d+)$`);

// Pid właściciela: z etykiety, a dla kontenerów sprzed etykiet — z sufiksu nazwy.
function ownerPid(container: TestContainer): number | null {
  const raw = container.labels[OWNER_PID_LABEL] ?? LEGACY_INTEGRATION_NAME.exec(container.name)?.[1];
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function classifyContainer(container: TestContainer, context: OwnerContext): ContainerOwnership {
  // Cudze kontenery (np. stos Compose `knowli-db-1` na tym samym demonie)
  // nigdy nie są „stale”, choćby działały od tygodni.
  const isTestContainer = OWNER_PID_LABEL in container.labels || LEGACY_INTEGRATION_NAME.test(container.name);
  if (!isTestContainer) return "unknown";
  const pid = ownerPid(container);
  const host = container.labels[OWNER_HOST_LABEL];
  const pidNamespace = container.labels[OWNER_PID_NAMESPACE_LABEL];
  // Pid z innego hosta albo innej przestrzeni pid (np. WSL obok Windows na
  // wspólnym Docker Desktop, także pod tą samą nazwą hosta) nic nie mówi
  // o procesach tutaj — taki kontener rozstrzyga tylko wiek.
  const sameHost = host === undefined || host === context.host;
  const samePidNamespace = pidNamespace === undefined || pidNamespace === context.pidNamespace;
  if (pid !== null && sameHost && samePidNamespace) {
    // Żywy właściciel wygrywa z wiekiem: sesja `playwright --ui` może trwać
    // dłużej niż doba. Pid ponownie przydzielony innemu procesowi zostawia
    // co najwyżej osierocony kontener do śmierci tamtego procesu.
    return context.isProcessAlive(pid) ? "live" : "stale";
  }
  return context.now - container.createdAt > MAX_CONTAINER_AGE_MS ? "stale" : "unknown";
}

/**
 * Czy kontener o wspólnej nazwie (E2E) wolno usunąć przed własnym startem.
 * Blokuje żywy przebieg tutaj i oznaczony przebieg z innego hosta (jego pid
 * jest nieweryfikowalny); kontener bez etykiet (sprzed nich) nie blokuje,
 * bo nigdy nie stałby się „stale” i setup utknąłby do ręcznego usunięcia.
 */
export function isReservedByAnotherRun(container: TestContainer, context: OwnerContext): boolean {
  const ownership = classifyContainer(container, context);
  const labelledOwner = OWNER_HOST_LABEL in container.labels || OWNER_PID_NAMESPACE_LABEL in container.labels;
  return ownership === "live" || (ownership === "unknown" && labelledOwner);
}

/** `docker run --name` trafił na istniejący kontener o tej nazwie. */
export function isNameConflictError(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  return typeof stderr === "string" && /container name .* is already in use/i.test(stderr);
}

export function selectStaleContainers(containers: readonly TestContainer[], context: OwnerContext): TestContainer[] {
  return containers.filter((container) => classifyContainer(container, context) === "stale");
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: proces istnieje, tylko nie wolno mu wysłać sygnału.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Identyfikator przestrzeni pid bieżącego procesu: na Linuksie (w tym WSL
 * i kontenery) i-węzeł `/proc/self/ns/pid`, na innych systemach platforma.
 */
export function currentPidNamespace(): string {
  if (process.platform !== "linux") return process.platform;
  try {
    return `linux:${readlinkSync("/proc/self/ns/pid")}`;
  } catch {
    return "linux";
  }
}

export function currentOwnerContext(): OwnerContext {
  return { host: hostname(), pidNamespace: currentPidNamespace(), now: Date.now(), isProcessAlive };
}

export function isOwnedByThisProcess(container: TestContainer): boolean {
  return container.labels[OWNER_PID_LABEL] === String(process.pid)
    && container.labels[OWNER_HOST_LABEL] === hostname()
    && container.labels[OWNER_PID_NAMESPACE_LABEL] === currentPidNamespace();
}

export function ownerLabelArgs(): string[] {
  return [
    "--label",
    `${OWNER_PID_LABEL}=${process.pid}`,
    "--label",
    `${OWNER_HOST_LABEL}=${hostname()}`,
    "--label",
    `${OWNER_PID_NAMESPACE_LABEL}=${currentPidNamespace()}`,
  ];
}

// Docker podaje Created z nanosekundami; Date.parse gwarantuje tylko milisekundy.
export function parseDockerTimestamp(value: string): number {
  return Date.parse(value.replace(/(\.\d{3})\d+/, "$1"));
}

/** Port hosta z wyjścia `docker port <c> 5432/tcp` ("0.0.0.0:55001", ew. "5432/tcp -> 0.0.0.0:55001"). */
export function parseHostPort(portOutput: string): string {
  const line = portOutput
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.includes("0.0.0.0:"));
  const mapped = line?.split("->").pop()?.trim();
  const port = mapped?.split(":").pop();
  if (!port || !/^\d+$/.test(port)) {
    throw new Error(`Nie udało się odczytać portu kontenera: ${portOutput}`);
  }
  return port;
}

interface DockerInspectEntry {
  Id: string;
  Name: string;
  Created: string;
  Config?: { Labels?: Record<string, string> | null };
}

export function parseInspectOutput(output: string): TestContainer[] {
  const entries = JSON.parse(output.trim() || "[]") as DockerInspectEntry[];
  return entries.map((entry) => ({
    id: entry.Id,
    name: entry.Name.replace(/^\//, ""),
    createdAt: parseDockerTimestamp(entry.Created),
    labels: entry.Config?.Labels ?? {},
  }));
}

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await exec("docker", args);
  return stdout;
}

async function inspect(ids: readonly string[]): Promise<TestContainer[]> {
  if (ids.length === 0) return [];
  try {
    // --type container: bez niego nazwa trafia też w obraz, wolumen albo sieć.
    return parseInspectOutput(await docker("inspect", "--type", "container", ...ids));
  } catch (error) {
    // Brak części kontenerów (np. --rm po teardownie innego przebiegu między
    // `ps` a `inspect`): docker kończy się błędem, ale wypisuje resztę.
    // Każdy inny błąd (demon, uprawnienia) przerywa setup jawnie.
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    if (typeof stderr === "string" && /no such (container|object)/i.test(stderr)) {
      return parseInspectOutput(stdout ?? "");
    }
    throw error;
  }
}

/** Kontenery, których nazwa zaczyna się od `prefix` (filtr Dockera dopasowuje fragment). */
export async function listContainersByPrefix(prefix: string): Promise<TestContainer[]> {
  const stdout = await docker("ps", "-aq", "--filter", `name=${prefix}`);
  const containers = await inspect(stdout.split(/\r?\n/).map((id) => id.trim()).filter(Boolean));
  return containers.filter((container) => container.name.startsWith(prefix));
}

export async function findContainer(name: string): Promise<TestContainer | null> {
  return (await inspect([name])).find((container) => container.name === name) ?? null;
}

export async function removeContainer(id: string): Promise<void> {
  // -v: obraz postgres trzyma dane w anonimowym wolumenie, a jawne `rm -f`
  // (inaczej niż samo --rm po zatrzymaniu) bez -v zostawia go na dysku VM.
  await docker("rm", "-f", "-v", id).catch(() => undefined);
}

/** Operacje Dockera potrzebne do startu bazy testów; testy podstawiają fake. */
export interface ContainerRuntime {
  /** `docker run` z podanymi argumentami; zwraca ID kontenera. */
  run(args: readonly string[]): Promise<string>;
  /** Surowe wyjście `docker port <id> 5432/tcp`. */
  port(id: string): Promise<string>;
  find(name: string): Promise<TestContainer | null>;
  remove(id: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export const dockerRuntime: ContainerRuntime = {
  run: async (args) => (await docker("run", ...args)).trim(),
  port: (id) => docker("port", id, "5432/tcp"),
  find: findContainer,
  remove: removeContainer,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Nazwę zajął kontener innego przebiegu (wyścig dwóch startów). */
export class ContainerNameTakenError extends Error {
  constructor(readonly containerName: string, readonly owner: TestContainer | null) {
    super(`Kontener ${containerName} należy do innego przebiegu`);
  }
}

export interface StartPostgresOptions {
  name: string;
  /** Opis do logu ponowień, np. "testów integracyjnych". */
  label: string;
  /** Czeka na bazę i migruje; błąd oznacza kolejną próbę na nowym kontenerze. */
  prepare: (url: string) => Promise<void>;
  runtime?: ContainerRuntime;
  attempts?: number;
  retryDelayMs?: number;
}

export interface StartedContainer {
  id: string;
  url: string;
}

function postgresRunArgs(name: string): string[] {
  return [
    "-d",
    "--rm",
    "-P",
    ...ownerLabelArgs(),
    "-e",
    "POSTGRES_USER=postgres",
    "-e",
    "POSTGRES_PASSWORD=test",
    "--name",
    name,
    POSTGRES_IMAGE,
  ];
}

/**
 * Stawia kontener Postgresa z etykietami właściciela i przygotowuje bazę.
 * Nawet po poprawnym handshake'u kontener potrafi być martwy (zedrsany stan
 * demona dockera); zamiast kończyć run startujemy kontener od nowa. Usuwamy
 * zawsze po ID kontenera tego procesu, nigdy po nazwie, którą mógł już zająć
 * równoległy przebieg. Przy błędzie po ostatniej próbie usuwa własny kontener.
 */
export async function startPostgresContainer(options: StartPostgresOptions): Promise<StartedContainer> {
  const runtime = options.runtime ?? dockerRuntime;
  const attempts = options.attempts ?? 3;
  let containerId: string | null = null;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (containerId !== null) {
      await runtime.remove(containerId);
      containerId = null;
    }
    if (attempt > 1) await runtime.sleep(options.retryDelayMs ?? 2000);
    try {
      try {
        containerId = await runtime.run(postgresRunArgs(options.name));
      } catch (error) {
        // `docker run` mógł utworzyć kontener i paść przed zwróceniem ID, a `rm`
        // poprzedniej próby mógł się nie udać: kontener tego procesu przejmujemy
        // po etykiecie i ponawiamy. Konflikt z cudzym kontenerem to wyścig o nazwę.
        const existing = await runtime.find(options.name);
        if (existing && isOwnedByThisProcess(existing)) {
          containerId = existing.id;
        } else if (isNameConflictError(error)) {
          throw new ContainerNameTakenError(options.name, existing);
        }
        throw error;
      }
      const url = `postgres://postgres:test@127.0.0.1:${parseHostPort(await runtime.port(containerId))}/postgres`;
      await options.prepare(url);
      return { id: containerId, url };
    } catch (error) {
      if (error instanceof ContainerNameTakenError) throw error;
      lastError = error;
      console.warn(`Kontener Postgres ${options.label} nie wystartował (próba ${attempt}/${attempts}): ${String(error)}`);
    }
  }
  if (containerId !== null) await runtime.remove(containerId);
  throw lastError;
}
