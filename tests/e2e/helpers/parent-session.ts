import { expect, type Page } from "@playwright/test";

/** Kod konfiguracji pierwszego PIN-u, który global setup podaje web jako `UMIEM_SETUP_TOKEN` (#307). */
export const E2E_SETUP_TOKEN = "e2e-setup-token";

/** Przygotowuje sesję bez UI, gdy uwierzytelnianie nie jest przedmiotem testu. */
export async function loginParent(page: Page, secret = "1234"): Promise<void> {
  const setup = await page.request.post("/api/v1/parent/setup", { data: { secret, setupToken: E2E_SETUP_TOKEN } });
  expect([201, 409]).toContain(setup.status());
  const login = await page.request.post("/api/v1/parent/login", { data: { secret } });
  expect(login.status()).toBe(200);
}

/**
 * Wypełnia formularz logowania albo pierwszego uruchomienia — w świecie
 * współdzielonym ten sam spec trafia na jeden z nich. Pole kodu renderuje się
 * razem z polem PIN-u, więc po wypełnieniu PIN-u jego liczba jest już ustalona.
 */
export async function fillParentAuth(page: Page, secret = "1234"): Promise<void> {
  await page.getByTestId("auth-secret").fill(secret);
  const token = page.getByTestId("auth-secret-setup-token");
  if (await token.count()) await token.fill(E2E_SETUP_TOKEN);
}
