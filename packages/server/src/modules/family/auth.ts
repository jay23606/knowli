import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { lt, sql } from "drizzle-orm";
import { parentCredentials, parentSessions } from "../../db/schema";
import { AppError } from "../../errors";
import type { Services } from "../../config";

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// Parametry zapisane w formacie hasha — zgodnie z architecture.md §13.
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LENGTH = 64;
const SECRET_MIN_LENGTH = 4;
const SECRET_MAX_LENGTH = 200;

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(secret, salt, KEY_LENGTH, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${key.toString("hex")}`;
}

function verifySecret(secret: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  const valid =
    parts.length === 6 &&
    parts[0] === "scrypt" &&
    parts.slice(1, 4).every((p) => /^\d+$/.test(p)) &&
    /^[0-9a-f]+$/i.test(parts[4] ?? "") &&
    /^[0-9a-f]+$/i.test(parts[5] ?? "");
  if (!valid) {
    // ta sama praca krypto również przy uszkodzonym formacie — stały czas ścieżki
    return scrypt(secret, Buffer.alloc(16), KEY_LENGTH, SCRYPT).then(() => false);
  }
  const [, n, r, p, saltHex, keyHex] = parts as [string, string, string, string, string, string];
  return scrypt(secret, Buffer.from(saltHex, "hex"), KEY_LENGTH, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  }).then((key) => {
    const expected = Buffer.from(keyHex, "hex");
    return expected.length === key.length && timingSafeEqual(expected, key);
  });
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Limiter prób logowania w pamięci procesu; MVP uruchamia jedną instancję web.
 * Kubełki: po jednym na znane urządzenie (podpisane ciastko z udanego logowania)
 * i jeden wspólny dla urządzeń bez niego — obce urządzenie nie zablokuje więc
 * rodzica na urządzeniu, na którym już się logował (#306).
 */
class LoginLimiter {
  private failures = new Map<string, number[]>();

  /**
   * Sprawdza limit i od razu liczy próbę jako porażkę, synchronicznie — żądania
   * równoległe nie przejdą razem kontroli przed zapisem porażki (#295).
   */
  reserve(key: string, clockNow: Date): void {
    const now = clockNow.getTime();
    const recent = (this.failures.get(key) ?? []).filter((t) => now - t < LOGIN_FAILURE_WINDOW_MS);
    if (recent.length >= LOGIN_MAX_FAILURES) {
      this.failures.set(key, recent);
      throw new AppError("rate_limited");
    }
    recent.push(now);
    this.failures.set(key, recent);
  }

  /** Udana próba: znane urządzenie zeruje swój kubełek, wspólny traci tylko tę rezerwację. */
  succeed(key: string, clockNow: Date): void {
    if (key) {
      this.failures.delete(key);
      return;
    }
    const recent = this.failures.get(key) ?? [];
    const index = recent.lastIndexOf(clockNow.getTime());
    if (index !== -1) recent.splice(index, 1);
  }
}

const limiters = new WeakMap<Services, LoginLimiter>();

function limiterFor(services: Services): LoginLimiter {
  let limiter = limiters.get(services);
  if (!limiter) {
    limiter = new LoginLimiter();
    limiters.set(services, limiter);
  }
  return limiter;
}

/** Klucz HMAC to zapisany hash PIN-u: sekret serwera, a zmiana PIN-u unieważnia urządzenia. */
function signDevice(deviceId: string, passwordHash: string): string {
  return createHmac("sha256", passwordHash).update(deviceId).digest("base64url");
}

/** Identyfikator znanego urządzenia albo null dla braku/podróbki ciastka. */
function knownDeviceId(deviceToken: string | undefined, passwordHash: string): string | null {
  const [deviceId, signature, ...rest] = (deviceToken ?? "").split(".");
  if (!deviceId || !signature || rest.length > 0) return null;
  const expected = Buffer.from(signDevice(deviceId, passwordHash));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? deviceId : null;
}

function assertSecretShape(secret: string): void {
  if (secret.length < SECRET_MIN_LENGTH || secret.length > SECRET_MAX_LENGTH) {
    throw new AppError("validation", {
      message: `secret length must be between ${SECRET_MIN_LENGTH} and ${SECRET_MAX_LENGTH}`,
    });
  }
}

/** Czy rodzic jeszcze nie skonfigurował PIN/hasła (ekran pierwszego uruchomienia). */
export async function isParentSetupRequired(services: Services): Promise<boolean> {
  const rows = await services.db
    .select({ id: parentCredentials.id })
    .from(parentCredentials)
    .limit(1);
  return rows.length === 0;
}

/**
 * Jednorazowy setup poświadczeń rodzica. Pojedynczy wiersz id = 1 rozstrzyga
 * próbę równoczesnej konfiguracji: wygrywa pierwsza, pozostałe dostają błąd.
 * Operacja zaufana (testy, skrypty); żądanie HTTP przechodzi przez `setupParentWithToken`.
 */
export async function setupParent(services: Services, secret: string): Promise<void> {
  assertSecretShape(secret);
  const passwordHash = await hashSecret(secret);
  const inserted = await services.db
    .insert(parentCredentials)
    .values({ id: 1, passwordHash })
    .onConflictDoNothing({ target: parentCredentials.id })
    .returning({ id: parentCredentials.id });
  if (inserted.length === 0) {
    throw new AppError("already_configured");
  }
}

/**
 * Setup z przeglądarki (POST /setup, #307): wymaga kodu konfiguracji równego
 * `UMIEM_SETUP_TOKEN` z env serwera, żeby świeżej instancji nie przejął pierwszy
 * odwiedzający. Bez skonfigurowanego kodu setup jest wyłączony. Błędny kod
 * liczy się do wspólnego limitu prób logowania (ochrona przed zgadywaniem).
 */
export async function setupParentWithToken(
  services: Services,
  secret: string,
  setupToken: string,
): Promise<void> {
  const expected = services.parentSetupToken;
  if (!expected) {
    throw new AppError("setup_disabled");
  }
  // po konfiguracji błędne kody nie mogą blokować logowania rodzica (wspólny limiter)
  if (!(await isParentSetupRequired(services))) {
    throw new AppError("already_configured");
  }
  // wspólny kubełek urządzeń bez ciastka — ten sam co przy logowaniu
  const limiter = limiterFor(services);
  const attemptAt = services.clock.now();
  limiter.reserve("", attemptAt);
  // skróty sha256 mają stałą długość, więc porównanie nie zdradza długości kodu
  if (!timingSafeEqual(Buffer.from(hashToken(setupToken.trim()), "hex"), Buffer.from(hashToken(expected), "hex"))) {
    throw new AppError("invalid_setup_token");
  }
  limiter.succeed("", attemptAt);
  await setupParent(services, secret);
}

export async function loginParent(
  services: Services,
  secret: string,
  deviceToken?: string,
): Promise<{ token: string; expiresAt: string; deviceToken: string }> {
  const now = services.clock.now();
  const credentials = await services.db.transaction(async (tx) => {
    // leniwe porządkowanie wygasłych sesji (architecture.md §13)
    await tx.delete(parentSessions).where(lt(parentSessions.expiresAt, now));
    const rows = await tx.select().from(parentCredentials).limit(1);
    return rows[0];
  });

  if (!credentials) {
    throw new AppError("setup_required");
  }
  const limiter = limiterFor(services);
  const deviceId = knownDeviceId(deviceToken, credentials.passwordHash);
  const bucket = deviceId ?? "";
  const attemptAt = services.clock.now();
  limiter.reserve(bucket, attemptAt);
  if (!(await verifySecret(secret, credentials.passwordHash))) {
    throw new AppError("invalid_credentials");
  }

  // wspólnego kubełka nie zerujemy: logowanie rodzica na nowym urządzeniu nie daje obcym nowych prób
  limiter.succeed(bucket, attemptAt);
  const device = deviceId ?? randomBytes(16).toString("base64url");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await services.db
    .insert(parentSessions)
    .values({ tokenHash: hashToken(token), createdAt: now, expiresAt });
  return {
    token,
    expiresAt: expiresAt.toISOString(),
    deviceToken: `${device}.${signDevice(device, credentials.passwordHash)}`,
  };
}

/** Weryfikuje sesję rodzica; surowy token nigdy nie trafia do bazy. */
export async function requireParent(services: Services, token: string): Promise<void> {
  if (!token) {
    throw new AppError("unauthorized");
  }
  const now = services.clock.now();
  const session = await services.db.transaction(async (tx) => {
    await tx.delete(parentSessions).where(lt(parentSessions.expiresAt, now));
    const rows = await tx
      .select({ tokenHash: parentSessions.tokenHash })
      .from(parentSessions)
      .where(sql`${parentSessions.tokenHash} = ${hashToken(token)}`)
      .limit(1);
    return rows[0];
  });
  if (!session) {
    throw new AppError("unauthorized");
  }
}

export async function logoutParent(services: Services, token: string): Promise<void> {
  await services.db
    .delete(parentSessions)
    .where(sql`${parentSessions.tokenHash} = ${hashToken(token)}`);
}
