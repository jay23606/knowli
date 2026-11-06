import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "@playwright/test";
import { readTestRunConfig } from "../../test-run-config";

/**
 * Bramka fake providerów świata E2E (`UMIEM_FAKE_HOLD_FILE`, `waitWhileFakeHeld`
 * w packages/server/src/providers/fake.ts): dopóki plik istnieje, worker świata
 * wstrzymuje fake'owe generowanie słówek (`generateDeck`), TTS i ilustracji.
 * Nie obejmuje okładek zestawu (generuje je proces web) ani puli lekcji
 * (fake-agent puli; do niej służy `FAKE_SLOW_MARKER` z `fake-lesson-pool.ts`).
 *
 * Fake'i nie mają w E2E sztucznego opóźnienia, więc spec, który sprawdza
 * przejściowy stan „generowanie”, wstrzymuje je PRZED akcją, która zleca
 * generowanie (wywołanie, które już minęło bramkę, nie zostanie zatrzymane),
 * i zwalnia po asercji. Bramka obejmuje cały świat — jest bezpieczna tylko
 * dlatego, że projekt `real` wykonuje w świecie jeden test naraz (`workers: 1`,
 * bez `fullyParallel` w playwright.config.ts); zmiana tego wymaga innej bramki.
 * W projekcie `mocked` nie działa (API jest zaślepione w przeglądarce), a przy
 * zwykłym `pnpm test:e2e` wstrzymałaby równoległe testy `real` tego świata —
 * dlatego `holdFakeGeneration` rzuca poza projektem `real`.
 *
 * Spec używający bramki rejestruje `test.afterEach(releaseFakeGeneration)`,
 * żeby porażka w środku testu nie zostawiła jej zamkniętej; plik starszy niż
 * 2 min fake'i i tak ignorują (awaria procesu testu bez afterEach).
 */
function holdFile(): string {
  return join(process.cwd(), readTestRunConfig(process.env).fakeHoldFile);
}

export async function holdFakeGeneration(): Promise<void> {
  const project = test.info().project.name;
  if (project !== "real") {
    throw new Error(`holdFakeGeneration działa tylko w projekcie "real" (jest "${project}")`);
  }
  await writeFile(holdFile(), "");
}

export async function releaseFakeGeneration(): Promise<void> {
  await rm(holdFile(), { force: true });
}
