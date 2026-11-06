import {
  loginParent,
  requireParent,
  SESSION_TTL_MS,
  type Services,
} from "@learning/server";
import { AppError } from "@learning/server";

/**
 * Sesja rodzica w cookie HttpOnly + kontrola Origin/CSRF przy mutacjach.
 * Surowy token pozostaje wyłącznie w cookie i odpowiedzi logowania; do bazy
 * trafia jego hash (server/modules/auth).
 */

export const SESSION_COOKIE_NAME = "parent_session";
/** Podpisany identyfikator urządzenia, na którym rodzic już się logował (osobny limit prób, #306). */
export const DEVICE_COOKIE_NAME = "parent_device";
const DEVICE_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60; // górny limit Max-Age w Chrome

export function parseCookies(request: Request): Map<string, string> {
  const header = request.headers.get("cookie");
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

export function getSessionToken(request: Request): string | undefined {
  return parseCookies(request).get(SESSION_COOKIE_NAME);
}

function isSecureRequest(request: Request): boolean {
  if (new URL(request.url).protocol === "https:") return true;
  const forwarded = request.headers.get("x-forwarded-proto");
  return forwarded?.split(",")[0]?.trim() === "https";
}

export function sessionCookie(request: Request, token: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(isSecureRequest(request) ? ["Secure"] : []),
  ].join("; ");
}

function deviceCookie(request: Request, deviceToken: string): string {
  return [
    `${DEVICE_COOKIE_NAME}=${deviceToken}`,
    "Path=/api/v1/parent/login",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${DEVICE_COOKIE_MAX_AGE_S}`,
    ...(isSecureRequest(request) ? ["Secure"] : []),
  ].join("; ");
}

export function clearingSessionCookie(request: Request): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    ...(isSecureRequest(request) ? ["Secure"] : []),
  ].join("; ");
}

/** Weryfikuje sesję rodzica; rzuca AppError("unauthorized") bez ważnego cookie. */
export async function requireParentSession(
  request: Request,
  services: Services,
): Promise<string> {
  const token = getSessionToken(request);
  if (!token) {
    throw new AppError("unauthorized");
  }
  await requireParent(services, token);
  return token;
}

/**
 * Kontrola Origin/CSRF dla mutacji. Przeglądarka wysyła Origin przy żądaniach
 * cross-site; jego brak oznacza klienta nieprzeglądarkowego. Host żądania
 * bierzemy z x-forwarded-host (proxy), potem z nagłówka Host, a dopiero na
 * końcu z request.url — nagłówek jest wiarygodniejszy niż URL przekształcany
 * przez runtime. Niedopasowany origin lub cross-site Sec-Fetch-Site → forbidden.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    const host = forwardedHost || request.headers.get("host") || new URL(request.url).host;
    if (originHost === null || originHost !== host) {
      throw new AppError("forbidden");
    }
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "same-site" && fetchSite !== "none") {
    throw new AppError("forbidden");
  }
}

/** Login trafia do auth i ustawia cookie; używane też przez route logowania. */
export async function loginAndBuildCookie(
  request: Request,
  services: Services,
  secret: string,
): Promise<{ body: { expiresAt: string }; cookies: string[] }> {
  const result = await loginParent(services, secret, parseCookies(request).get(DEVICE_COOKIE_NAME));
  return {
    body: { expiresAt: result.expiresAt },
    cookies: [sessionCookie(request, result.token), deviceCookie(request, result.deviceToken)],
  };
}
