import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createChild,
  updateChild,
  deleteChild,
  isParentSetupRequired,
  listChildren,
  loginParent,
  logoutParent,
  listKidProfiles,
  requireParent,
  setupParent,
  type AppError,
} from "@learning/server";
import {
  buildTestServices,
  countRows,
  handleParentApi,
  openRestartedServices,
  testDatabase,
  truncateCoreTables,
  UUID_PATTERN,
} from "./helpers";

const BASE = "http://localhost:3000";
const SESSION_COOKIE = "parent_session";

function jsonRequest(path: string, method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      // jawny Host jak w żądaniu przyjmowanym przez serwer — kontrola Origin
      // porównuje go z nagłówkiem Origin (undici nie wystawia Host z URL)
      host: "localhost:3000",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function readBody(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

function sessionCookieFrom(response: Response): string {
  const cookies = response.headers.getSetCookie();
  const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!session) throw new Error(`Brak cookie ${SESSION_COOKIE} w odpowiedzi: ${cookies.join(" | ")}`);
  return session.split(";")[0]!;
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  const error = await promise.then(
    () => {
      throw new Error(`Oczekiwano błędu ${code}, otrzymano sukces`);
    },
    (e: unknown) => e,
  );
  expect(error).toMatchObject({ code });
  return error as AppError;
}

describe("auth i profile dzieci (integracja)", () => {
  beforeEach(async () => {
    await truncateCoreTables();
  });

  afterAll(async () => {
    const { pool } = testDatabase();
    await pool.end();
  });

  it("domyślnie tworzy profil czytający i zapisuje zmianę canRead bez utraty przy pominiętym PATCH", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "Ala", avatarKey: "fox" });
    expect(child).toMatchObject({ canRead: true });

    const nonReader = await updateChild(services, child.id, { canRead: false });
    expect(nonReader).toMatchObject({ canRead: false });
    await updateChild(services, child.id, { avatarKey: "owl" });
    await expect(listChildren(services)).resolves.toContainEqual(expect.objectContaining({ id: child.id, canRead: false }));
  });

  it("poprawny login działa, błędny nie tworzy sesji", async () => {
    const { services, clock } = buildTestServices();
    await setupParent(services, "rodzinny-pin-1");

    const bad = await expectAppError(loginParent(services, "zly-pin"), "invalid_credentials");
    expect(bad.status).toBe(401);
    expect(await countRows("parent_sessions")).toBe(0);

    const good = await loginParent(services, "rodzinny-pin-1");
    expect(good.token.length).toBeGreaterThan(20);
    // wygaśnięcie liczone względem zegara usług, nie rzeczywistego — test
    // nie może starzeć się wraz z kalendarzem
    expect(new Date(good.expiresAt).getTime()).toBeGreaterThan(clock.now().getTime());
    expect(await countRows("parent_sessions")).toBe(1);

    await expect(requireParent(services, good.token)).resolves.toBeUndefined();
  });

  it("endpoint rodzica bez cookie zwraca 401 w formacie błędu API", async () => {
    const { services } = buildTestServices();
    await setupParent(services, "rodzinny-pin-1");
    await loginParent(services, "rodzinny-pin-1");

    const response = await handleParentApi(jsonRequest("/api/v1/parent/children", "GET"), services);
    expect(response.status).toBe(401);
    const body = await readBody(response);
    expect(body).toMatchObject({ code: "unauthorized", retryable: false });
    expect(typeof body.message).toBe("string");
    expect(typeof body.requestId).toBe("string");
    expect(body.message).not.toMatch(/select|postgres|error:/i);
  });

  it("dwa profile mają różne ID i wracają na liście", async () => {
    const { services } = buildTestServices();
    const ala = await createChild(services, { displayName: "Ala", avatarKey: "fox" });
    const ola = await createChild(services, {
      displayName: "Ola",
      avatarKey: "cat",
      birthYear: 2017,
    });

    expect(ala.id).toMatch(UUID_PATTERN);
    expect(ola.id).toMatch(UUID_PATTERN);
    expect(ala.id).not.toBe(ola.id);

    const list = await listChildren(services);
    expect(list.map((c) => c.displayName).sort()).toEqual(["Ala", "Ola"]);
    expect(list.find((c) => c.id === ola.id)?.birthYear).toBe(2017);
  });

  it("pierwsze uruchomienie: jednorazowy setup, równoległa konfiguracja nie tworzy drugiego wiersza", async () => {
    const { services } = buildTestServices();
    expect(await isParentSetupRequired(services)).toBe(true);

    await setupParent(services, "pierwsze-haslo");
    expect(await isParentSetupRequired(services)).toBe(false);
    await expectAppError(setupParent(services, "drugie-haslo"), "already_configured");

    // równoległa próba na świeżej bazie
    await truncateCoreTables();
    const results = await Promise.allSettled([
      setupParent(services, "wariant-a"),
      setupParent(services, "wariant-b"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await countRows("parent_credentials")).toBe(1);
  });

  it("wygasła sesja jest odrzucana i leniwie usuwana", async () => {
    const { services, clock } = buildTestServices();
    await setupParent(services, "pin1");
    const { token } = await loginParent(services, "pin1");

    clock.advanceHours(13); // sesja ważna 12 h
    await expectAppError(requireParent(services, token), "unauthorized");
    expect(await countRows("parent_sessions")).toBe(0);
  });

  it("limit logowania blokuje po serii błędów i odtyka po oknie", async () => {
    const { services, clock } = buildTestServices();
    await setupParent(services, "pin1");

    for (let i = 0; i < 5; i++) {
      await expectAppError(loginParent(services, "zle"), "invalid_credentials");
    }
    const locked = await expectAppError(loginParent(services, "pin1"), "rate_limited");
    expect(locked.status).toBe(429);

    clock.advanceMs(16 * 60_000);
    const fresh = await loginParent(services, "pin1");
    await expect(requireParent(services, fresh.token)).resolves.toBeUndefined();
  });

  it("równoległe błędne logowania nie omijają limitu (#295)", async () => {
    const { services } = buildTestServices();
    await setupParent(services, "pin1");

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => loginParent(services, "zle")),
    );
    const codes = results.map((r) => (r.status === "rejected" ? (r.reason as AppError).code : "ok"));
    expect(codes.filter((c) => c === "invalid_credentials")).toHaveLength(5);
    expect(codes.filter((c) => c === "rate_limited")).toHaveLength(15);
  });

  it("obce urządzenie nie blokuje logowania na znanym urządzeniu (#306)", async () => {
    const { services } = buildTestServices();
    await setupParent(services, "pin1");
    const { deviceToken } = await loginParent(services, "pin1");

    for (let i = 0; i < 5; i++) {
      await expectAppError(loginParent(services, "zle"), "invalid_credentials");
    }
    await expectAppError(loginParent(services, "pin1"), "rate_limited");
    // podrobiony identyfikator urządzenia trafia do wspólnego limitu obcych urządzeń
    const [deviceId] = deviceToken.split(".");
    await expectAppError(loginParent(services, "pin1", `${deviceId}.podrobiony`), "rate_limited");

    const known = await loginParent(services, "pin1", deviceToken);
    await expect(requireParent(services, known.token)).resolves.toBeUndefined();
    expect(known.deviceToken).toBe(deviceToken);

    // znane urządzenie ma własny, równie ścisły limit
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () => loginParent(services, "zle", deviceToken)),
    );
    const codes = attempts.map((r) => (r.status === "rejected" ? (r.reason as AppError).code : "ok"));
    expect(codes.filter((c) => c === "invalid_credentials")).toHaveLength(5);
    await expectAppError(loginParent(services, "pin1", deviceToken), "rate_limited");
  });

  it("logout unieważnia sesję", async () => {
    const { services } = buildTestServices();
    await setupParent(services, "pin1");
    const { token } = await loginParent(services, "pin1");
    await logoutParent(services, token);
    await expectAppError(requireParent(services, token), "unauthorized");
  });

  it("usuwanie profilu działa jednokrotnie, powtórzone zwraca not_found", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "Ala", avatarKey: "fox" });

    await deleteChild(services, child.id);
    expect(await listChildren(services)).toEqual([]);
    await expectAppError(deleteChild(services, child.id), "not_found");
  });

  it("edycja profilu aktualizuje tylko dostarczone pola", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "Ola", avatarKey: "fox", birthYear: 2018 });
    expect(child.recordingMode).toBe("hold");
    expect(await updateChild(services, child.id, { displayName: "  Ala  " })).toEqual({ ...child, displayName: "Ala" });
    expect(await updateChild(services, child.id, { avatarKey: "cat" })).toEqual({ ...child, displayName: "Ala", avatarKey: "cat" });
    expect(await updateChild(services, child.id, { displayName: "Ewa", avatarKey: "owl" }))
      .toEqual({ ...child, displayName: "Ewa", avatarKey: "owl" });
    expect(await updateChild(services, child.id, { recordingMode: "toggle" }))
      .toEqual({ ...child, displayName: "Ewa", avatarKey: "owl", recordingMode: "toggle" });
    expect(await listKidProfiles(services)).toEqual([{
      childId: child.id,
      displayName: "Ewa",
      avatarKey: "owl",
      recordingMode: "toggle",
      canRead: true,
      rewardPoints: 0,
      todayActivitySeconds: 0,
      todayActivityUnavailable: false,
    }]);
  });

  it("profil odrzuca nieobsługiwany tryb i NULL bez zmiany ustawienia", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "Ola", avatarKey: "fox" });
    const { pool } = testDatabase();
    await expect(pool.query("update learning_app.child_profiles set recording_mode = 'tap' where id = $1", [child.id]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("update learning_app.child_profiles set recording_mode = null where id = $1", [child.id]))
      .rejects.toMatchObject({ code: "23502" });
    expect((await listChildren(services))[0]).toEqual(child);
  });

  it("dwaj klienci edytują różne pola, a edycja po usunięciu nie odtwarza profilu", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "Ola", avatarKey: "fox" });
    const other = openRestartedServices();
    try {
      await Promise.all([
        updateChild(services, child.id, { displayName: "Ala" }),
        updateChild(other.services, child.id, { avatarKey: "panda" }),
      ]);
      expect(await listChildren(services)).toEqual([{ ...child, displayName: "Ala", avatarKey: "panda" }]);
      await deleteChild(other.services, child.id);
      await expectAppError(updateChild(services, child.id, { displayName: "Ewa" }), "not_found");
      expect(await listChildren(services)).toEqual([]);
    } finally {
      await other.dispose();
    }
  });

  it("PATCH profilu chroni sesję, Origin, walidację i pola prywatne", async () => {
    const { services } = buildTestServices();
    await setupParent(services, "pin-edit");
    const child = await createChild(services, { displayName: "Ala", avatarKey: "fox", birthYear: 2018 });
    const cookie = sessionCookieFrom(await handleParentApi(
      jsonRequest("/api/v1/parent/login", "POST", { secret: "pin-edit" }, { origin: BASE }),
      services,
    ));
    const patchChild = (body: unknown, headers: Record<string, string>, childId = child.id) =>
      handleParentApi(jsonRequest(`/api/v1/parent/children/${childId}`, "PATCH", body, headers), services);
    const authHeaders = { cookie, origin: BASE };
    for (const [headers, status] of [
      [{ origin: BASE }, 401],
      [{ cookie, origin: "https://evil.example" }, 403],
      [{ ...authHeaders, "sec-fetch-site": "cross-site" }, 403],
    ] as const) {
      const response = await patchChild({ displayName: "Ewa" }, headers);
      expect(response.status).toBe(status);
      expect(await listChildren(services)).toEqual([child]);
    }
    for (const body of [{}, null, { displayName: " " }, { avatarKey: "" }, { displayName: 1 },
      { displayName: "a".repeat(81) }, { avatarKey: "a".repeat(41) },
      { displayName: "Ewa", id: randomUUID() }, { displayName: "Ewa", birthYear: 2019 },
      { displayName: "Ewa", policyId: "learning-v2" }]) {
      const response = await patchChild(body, authHeaders);
      expect(response.status).toBe(400);
      expect(await listChildren(services)).toEqual([child]);
    }
    const brokenJson = new Request(`${BASE}/api/v1/parent/children/${child.id}`, { method: "PATCH", headers: { ...authHeaders, "content-type": "application/json" }, body: "{" });
    expect((await handleParentApi(brokenJson, services)).status).toBe(400);
    expect((await patchChild({ avatarKey: "cat" }, authHeaders, "invalid")).status).toBe(400);
    expect((await patchChild({ avatarKey: "cat" }, authHeaders, randomUUID())).status).toBe(404);
    expect(await listChildren(services)).toEqual([child]);
    const ok = await patchChild({ displayName: "  Ewa  ", avatarKey: "owl" }, authHeaders);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ...child, displayName: "Ewa", avatarKey: "owl" });
    const modeOnly = await patchChild({ recordingMode: "toggle" }, authHeaders);
    expect(modeOnly.status).toBe(200);
    expect(await modeOnly.json()).toEqual({ ...child, displayName: "Ewa", avatarKey: "owl", recordingMode: "toggle" });
    const invalidMode = await patchChild({ recordingMode: "tap" }, authHeaders);
    expect(invalidMode.status).toBe(400);
  });

  it("DELETE profilu przez API wymaga sesji i tego samego Origin; nieznany profil daje 404", async () => {
    const { services } = buildTestServices();
    await setupParent(services, "pin-usun");
    const child = await createChild(services, { displayName: "Ala", avatarKey: "fox" });
    const origin = { origin: BASE };

    // sesja przez router oRPC (kompozycja catch-all) — Services testu
    const loginResponse = await handleParentApi(
      jsonRequest("/api/v1/parent/login", "POST", { secret: "pin-usun" }, origin),
      services,
    );
    expect(loginResponse.status).toBe(200);
    const cookie = sessionCookieFrom(loginResponse);
    const deleteChildApi = (childId: string, headers: Record<string, string>) =>
      handleParentApi(jsonRequest(`/api/v1/parent/children/${childId}`, "DELETE", undefined, headers), services);

    // bez sesji — 401; z sesją, ale z obcym Origin — 403 (mutacja)
    const anonymous = await deleteChildApi(child.id, origin);
    expect(anonymous.status).toBe(401);
    const crossOrigin = await deleteChildApi(child.id, {
      cookie,
      origin: "https://evil.example",
    });
    expect(crossOrigin.status).toBe(403);
    expect(await listChildren(services)).toHaveLength(1);

    // właściwe żądanie usuwa profil; powtórzone zwraca 404
    const ok = await deleteChildApi(child.id, { cookie, ...origin });
    expect(ok.status).toBe(204);
    const unknown = await deleteChildApi(randomUUID(), { cookie, ...origin });
    expect(unknown.status).toBe(404);
    expect(await listChildren(services)).toEqual([]);
  });

  it("baza po ponownym otwarciu połączenia zachowuje profile", async () => {
    const { services } = buildTestServices();
    await createChild(services, { displayName: "Ala", avatarKey: "fox" });
    await createChild(services, { displayName: "Ola", avatarKey: "cat" });

    const restarted = openRestartedServices();
    try {
      const list = await listChildren(restarted.services);
      expect(list).toHaveLength(2);
    } finally {
      await restarted.dispose();
    }
  });

  describe("przepływ HTTP przez router oRPC (kompozycja catch-all)", () => {
    it("setup → login → children → create → delete → logout", async () => {
      // cały przepływ idzie przez handleParentApi (router oRPC, bez
      // fallbacku) — dokładna kompozycja catch-all /api/v1/parent/[...path]
      const { services } = buildTestServices();
      const origin = { origin: BASE };

      const status0 = await handleParentApi(jsonRequest("/api/v1/parent/login", "GET"), services);
      expect(status0.status).toBe(200);
      expect(await readBody(status0)).toEqual({ authenticated: false, setupRequired: true });

      const setupResponse = await handleParentApi(
        jsonRequest("/api/v1/parent/setup", "POST", { secret: "http-pin" }, origin),
        services,
      );
      expect(setupResponse.status).toBe(201);
      const setupAgain = await handleParentApi(
        jsonRequest("/api/v1/parent/setup", "POST", { secret: "inny" }, origin),
        services,
      );
      expect(setupAgain.status).toBe(409);

      const wrongLogin = await handleParentApi(
        jsonRequest("/api/v1/parent/login", "POST", { secret: "zle" }, origin),
        services,
      );
      expect(wrongLogin.status).toBe(401);
      expect(wrongLogin.headers.getSetCookie()).toEqual([]);

      const loginResponse = await handleParentApi(
        jsonRequest("/api/v1/parent/login", "POST", { secret: "http-pin" }, origin),
        services,
      );
      expect(loginResponse.status).toBe(200);
      const cookie = sessionCookieFrom(loginResponse);
      expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
      const setCookie = loginResponse.headers.getSetCookie().join("\n");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      expect(setCookie).toMatch(/^parent_device=[\w-]+\.[\w-]+; Path=\/api\/v1\/parent\/login;/m);

      const authHeaders = { cookie, ...origin };

      const emptyList = await handleParentApi(
        jsonRequest("/api/v1/parent/children", "GET", undefined, { cookie }),
        services,
      );
      expect(emptyList.status).toBe(200);
      expect(await emptyList.json()).toEqual([]);

      const created = await handleParentApi(
        jsonRequest("/api/v1/parent/children", "POST", { displayName: "Ala", avatarKey: "fox" }, authHeaders),
        services,
      );
      expect(created.status).toBe(201);
      const child = (await readBody(created)) as { id: string; displayName: string };

      const invalid = await handleParentApi(
        jsonRequest(
          "/api/v1/parent/children",
          "POST",
          { displayName: "", avatarKey: "fox" },
          authHeaders,
        ),
        services,
      );
      expect(invalid.status).toBe(400);
      expect(await readBody(invalid)).toMatchObject({ code: "validation", retryable: false });

      const crossOrigin = await handleParentApi(
        jsonRequest(
          "/api/v1/parent/children",
          "POST",
          { displayName: "Nowe", avatarKey: "cat" },
          { cookie, origin: "https://evil.example" },
        ),
        services,
      );
      expect(crossOrigin.status).toBe(403);

      const deleted = await handleParentApi(
        jsonRequest(`/api/v1/parent/children/${child.id}`, "DELETE", undefined, authHeaders),
        services,
      );
      expect(deleted.status).toBe(204);

      const logoutResponse = await handleParentApi(
        jsonRequest("/api/v1/parent/logout", "POST", undefined, authHeaders),
        services,
      );
      expect(logoutResponse.status).toBe(204);
      expect(logoutResponse.headers.getSetCookie().join("\n")).toContain("Max-Age=0");

      const afterLogout = await handleParentApi(
        jsonRequest("/api/v1/parent/children", "GET", undefined, { cookie }),
        services,
      );
      expect(afterLogout.status).toBe(401);
    });
  });
});
