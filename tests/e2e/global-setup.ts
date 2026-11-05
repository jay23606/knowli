import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { migrateDatabase, waitUntilDatabaseReady } from "@learning/server";
import { isPortInUse } from "../local-ports";
import {
  ContainerNameTakenError,
  currentOwnerContext,
  findContainer,
  isReservedByAnotherRun,
  OWNER_HOST_LABEL,
  OWNER_PID_LABEL,
  removeContainer,
  type StartedContainer,
  startPostgresContainer,
  type TestContainer,
} from "../test-containers";
import { readTestRunConfig } from "../test-run-config";

const exec = promisify(execFile);

// Playwright uruchamiany jest zawsze z korzenia repozytorium.
const repoRoot = process.cwd();
const TEST_RUN_CONFIG = readTestRunConfig(process.env);
const CONTAINER = TEST_RUN_CONFIG.e2eContainer;
const PORT = TEST_RUN_CONFIG.e2ePort;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const NEXT_BIN = join(repoRoot, "apps/web/node_modules/next/dist/bin/next");
const PARALLEL_RUN_HINT = "Równolegle uruchamiaj `pnpm test:e2e:shards` z własnym --base-port albo ustaw "
  + "UMIEM_TEST_RUN_ID i UMIEM_E2E_PORT.";

function killTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) {
    return Promise.resolve();
  }
  if (process.platform === "win32") {
    return exec("taskkill", ["/pid", String(child.pid), "/T", "/F"]).then(
      () => undefined,
      () => undefined,
    );
  }
  child.kill("SIGTERM");
  return Promise.resolve();
}

const BUILD_TIMEOUT_MS = 600_000;

function runInherit(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  onChild?: (child: ReturnType<typeof spawn>) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    onChild?.(child);
    const timer = setTimeout(() => {
      void killTree(child);
      reject(new Error(`Polecenie ${command} ${args.join(" ")} przekroczyło limit ${BUILD_TIMEOUT_MS / 1000} s`));
    }, BUILD_TIMEOUT_MS);
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };
    child.once("error", (error) => settle(() => reject(error)));
    child.once("exit", (code) => settle(() => {
      if (code === 0) resolve();
      else reject(new Error(`Polecenie ${command} ${args.join(" ")} zakończyło się kodem ${String(code)}`));
    }));
  });
}

/**
 * Build produkcyjny dla trybu `next start`. Build nie łączy się z bazą
 * (leniwa inicjalizacja usług), więc dostaje atrapę DATABASE_URL jak w CI
 * i może biec równolegle ze stawianiem kontenera Postgresa.
 */
async function buildWeb(onChild?: (child: ReturnType<typeof spawn>) => void): Promise<void> {
  // .next jest współdzielone między przebiegami w jednym worktree: równoległe
  // światy muszą budować raz z góry (runner shardów wymusza potem
  // UMIEM_E2E_SKIP_BUILD=1), a nie budować jednocześnie do tego samego .next.
  await runInherit(process.execPath, [NEXT_BIN, "build"], join(repoRoot, "apps/web"), {
    ...process.env,
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/knowli",
    NEXT_TELEMETRY_DISABLED: "1",
  }, onChild);
}

async function assertBuildPresent(): Promise<void> {
  try {
    await access(join(repoRoot, "apps/web/.next/BUILD_ID"));
  } catch {
    throw new Error(
      "UMIEM_E2E_SKIP_BUILD=1, ale brak buildu produkcyjnego (apps/web/.next/BUILD_ID). "
      + "Uruchom najpierw `pnpm build` albo zdejmij UMIEM_E2E_SKIP_BUILD.",
    );
  }
}

const READY_REQUEST_TIMEOUT_MS = 5_000;

async function waitForHttp(
  url: string,
  timeoutMs: number,
  server: ReturnType<typeof spawn>,
  isReady: (response: Response) => boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Martwy serwer (np. EADDRINUSE) nie może „wstać” odpowiedzią cudzego procesu.
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`Serwer web zakończył się przed gotowością (kod ${String(server.exitCode ?? server.signalCode)}). ${PARALLEL_RUN_HINT}`);
    }
    try {
      // Limit pojedynczego żądania: serwer, który przyjmie połączenie i nie
      // odpowie, nie może zawiesić pętli ponad deadline ani przesłonić
      // zakończenia procesu web.
      const requestTimeoutMs = Math.max(1, Math.min(READY_REQUEST_TIMEOUT_MS, deadline - Date.now()));
      const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
      if (isReady(response)) return;
    } catch {
      // serwer jeszcze się podnosi
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Serwer ${url} nie odpowiedział w ${Math.round(timeoutMs / 1000)} s`);
}

function containerInUseError(owner: TestContainer | null): Error {
  const who = owner
    ? `pid ${owner.labels[OWNER_PID_LABEL] ?? "?"}, host ${owner.labels[OWNER_HOST_LABEL] ?? "?"}`
    : "start równoległy";
  return new Error(`Kontener ${CONTAINER} należy do trwającego przebiegu E2E (${who}). ${PARALLEL_RUN_HINT}`);
}

// Zajęty port web albo health workera to niemal zawsze równoległy przebieg
// z tymi samymi portami; sprawdzamy przed buildem i bazą.
async function assertPortsFree(): Promise<void> {
  for (const port of [PORT, TEST_RUN_CONFIG.workerHealthPort]) {
    if (await isPortInUse(port)) {
      throw new Error(`Port ${port} jest zajęty, prawdopodobnie przez równoległy przebieg E2E. ${PARALLEL_RUN_HINT}`);
    }
  }
}

/**
 * Kontener o tej samej nazwie może należeć do równoległego przebiegu z innej
 * sesji, worktree lub hosta (bez UMIEM_TEST_RUN_ID nazwa jest wspólna). Jego
 * usunięcie wywróciłoby tamten przebieg, więc kończymy się jawnym błędem.
 * Osierocony kontener usuwamy po sprawdzonym ID, nie po nazwie: nazwa mogła
 * już przejść do kontenera, który właśnie postawił równoległy przebieg.
 */
async function removeOrphanedContainer(): Promise<void> {
  const existing = await findContainer(CONTAINER);
  if (!existing) return;
  if (isReservedByAnotherRun(existing, currentOwnerContext())) throw containerInUseError(existing);
  await removeContainer(existing.id);
}

/**
 * Jeden odizolowany świat na przebieg E2E: czysta baza, serwer web i worker
 * z fake providerami i regulowanym opóźnieniem generacji. Domyślnie web to
 * build produkcyjny pod `next start` (szybszy od `next dev`, bez kompilacji
 * tras na żądanie); `UMIEM_E2E_WEB_MODE=dev` wraca do serwera deweloperskiego
 * przy szybkiej iteracji na pojedynczym specu.
 */
export default async function globalSetup(): Promise<(() => Promise<void>) | void> {
  await assertPortsFree();
  await removeOrphanedContainer();
  // Wszystkie dalsze `rm` dotyczą wyłącznie kontenera postawionego przez ten
  // przebieg (ID z `docker run`), także przy błędzie i w teardownie.
  let database: StartedContainer | null = null;
  const cleanup: Array<() => Promise<void>> = [
    () => (database ? removeContainer(database.id) : Promise.resolve()),
  ];
  const fail = async (error: unknown): Promise<never> => {
    for (const fn of cleanup.reverse()) await fn();
    throw error;
  };

  // Build startuje od razu i biegnie równolegle ze stawianiem bazy; wynik
  // odbieramy dopiero przed spawnem serwera web.
  // Brak buildu przy SKIP_BUILD zgłaszamy od razu, zanim postawimy bazę.
  if (TEST_RUN_CONFIG.e2eWebMode === "start" && TEST_RUN_CONFIG.e2eSkipBuild) {
    await assertBuildPresent().catch(fail);
  }
  let buildChild: ReturnType<typeof spawn> | undefined;
  const buildPromise: Promise<void> = TEST_RUN_CONFIG.e2eWebMode === "start" && !TEST_RUN_CONFIG.e2eSkipBuild
    ? buildWeb((child) => { buildChild = child; })
    : Promise.resolve();
  void buildPromise.catch(() => undefined);
  // Gdy baza nie wstanie, fail() ubija także wciąż biegnący build.
  cleanup.push(() => (buildChild ? killTree(buildChild) : Promise.resolve()));

  try {
    database = await startPostgresContainer({
      name: CONTAINER,
      label: "e2e",
      prepare: async (url) => {
        // pg_isready wewnątrz kontenera pyta po unix sockecie i zgłasza gotowość już
        // podczas tymczasowego serwera entrypointa (listen_addresses=''), zanim port
        // TCP hosta zacznie słuchać — wtedy migracja dostaje ECONNRESET. Czekamy na
        // realny handshake po dokładnie tym URL-u, którego używa migracja.
        await waitUntilDatabaseReady(url);
        await migrateDatabase(url, join(repoRoot, "packages/server/drizzle"));
      },
    });
  } catch (error) {
    // Równoległy przebieg zajął nazwę po naszej kontroli: jego kontenera nie ruszamy.
    return fail(error instanceof ContainerNameTakenError ? containerInUseError(error.owner) : error);
  }
  const databaseUrl = database.url;
  const readyToken = randomUUID();

  try {
    await buildPromise;

    // świat przekazuje połączenie do bazowym testom (seedowanie należnych
    // sprawdzeń bez czekania na realny upływ dni)
    const worldFile = join(repoRoot, TEST_RUN_CONFIG.worldFile);
    await writeFile(worldFile, JSON.stringify({ databaseUrl }, null, 2));
    cleanup.push(() => rm(worldFile, { force: true }));

    // Bramka fake providerów (tests/e2e/helpers/fake-hold.ts): plik po przerwanym
    // przebiegu nie może wstrzymać generowania w nowym świecie.
    const fakeHoldFile = join(repoRoot, TEST_RUN_CONFIG.fakeHoldFile);
    await rm(fakeHoldFile, { force: true });
    cleanup.push(() => rm(fakeHoldFile, { force: true }));

    const mediaRoot = await mkdtemp(join(tmpdir(), "knowli-e2e-media-"));
    cleanup.push(() => rm(mediaRoot, { recursive: true, force: true }));

    // fake providerzy muszą zgadzać się z ustawieniami medialnymi (fingerprinty)
    const sharedEnv = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      MEDIA_ROOT: mediaRoot,
      // next.config.ts: przy `next dev` bez wskaźnika deweloperskiego i trwałej pamięci podręcznej Turbopacka
      UMIEM_E2E: "1",
      UMIEM_E2E_READY_TOKEN: readyToken,
      UMIEM_FAKE_PROVIDERS: "1",
      // Fake'i bez sztucznego opóźnienia. Specy, które sprawdzają przejściowy
      // stan „generowanie” (zestaw, TTS, obrazy), wstrzymują fake'i bramką
      // UMIEM_FAKE_HOLD_FILE (holdFakeGeneration) zamiast ścigać się z zegarem;
      // test restartu trwającej generacji lekcji oznacza materiał
      // FAKE_SLOW_MARKER (fake.ts).
      UMIEM_FAKE_DELAY_MS: process.env.UMIEM_E2E_FAKE_DELAY_MS ?? "0",
      UMIEM_FAKE_HOLD_FILE: fakeHoldFile,
      UMIEM_FAKE_LESSON_DELAY_MS: process.env.UMIEM_E2E_FAKE_LESSON_DELAY_MS ?? "0",
      UMIEM_TTS_PROVIDER: "fake-tts",
      UMIEM_TTS_MODEL: "fake-tts-1",
      UMIEM_TTS_VOICE: "fake-voice",
      // Nadpisują domyślną konfigurację (config-defaults.ts): przebieg jak przed
      // nią — mp3 bez stylu. Grader jest fake'iem (UMIEM_FAKE_PROVIDERS=1 ma
      // pierwszeństwo w web), nawet z kluczem w powłoce.
      UMIEM_TTS_FORMAT: "mp3",
      UMIEM_TTS_STYLE: "none",
      UMIEM_IMAGE_PROVIDER: "fake-image",
      UMIEM_IMAGE_MODEL: "fake-image-1",
      UMIEM_IMAGE_SIZE: "512x512",
      WORKER_HEALTH_PORT: String(TEST_RUN_CONFIG.workerHealthPort),
    };

    const nextArgs = TEST_RUN_CONFIG.e2eWebMode === "start"
      ? ["start", "--port", String(PORT)]
      : ["dev", "--port", String(PORT)];
    if (TEST_RUN_CONFIG.e2eWebMode === "dev" && process.env.UMIEM_E2E_TURBOPACK === "1") nextArgs.push("--turbopack");
    const web = spawn(
      process.execPath,
      [NEXT_BIN, ...nextArgs],
      { cwd: join(repoRoot, "apps/web"), env: sharedEnv, stdio: "inherit" },
    );
    cleanup.push(() => killTree(web));

    const worker = spawn(
      process.execPath,
      [join(repoRoot, "apps/worker/node_modules/tsx/dist/cli.mjs"), "src/main.ts"],
      { cwd: join(repoRoot, "apps/worker"), env: { ...sharedEnv, WORKER_POLL_MS: "100" }, stdio: "inherit" },
    );
    cleanup.push(() => killTree(worker));

    // Gotowość tylko z tokenem tego przebiegu: port mógł zająć serwer
    // równoległego przebiegu między kontrolą portów a startem `next`.
    await waitForHttp(`${BASE_URL}/api/v1/health`, 120_000, web, (response) =>
      response.status === 200 && response.headers.get("x-umiem-e2e-ready") === readyToken);
    // Rozgrzewa trasę logowania (w trybie dev kompilowaną na żądanie).
    await waitForHttp(`${BASE_URL}/api/v1/parent/login`, 120_000, web, (response) => response.status < 500);
    return async () => {
      for (const fn of cleanup.reverse()) await fn();
    };
  } catch (error) {
    return fail(error);
  }
}
