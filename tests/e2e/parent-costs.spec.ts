import { expect, test, type Page } from "@playwright/test";
import { messages } from "@learning/contracts";

/**
 * Sekcja Koszty panelu rodzica (spec 2026-11-02-llm-cost-tracking §6): nagłówek
 * z sumą, trzy zakładki, przełącznik miesiąca, wejście z menu i geometria na
 * telefonie. API rodzica zaślepione w przeglądarce, zegar przeglądarki stały.
 */

const DECK_A = "3f2c1a9e-5b7d-4c8e-9a1b-2c3d4e5f6a7b";
const DECK_B = "8a9b0c1d-2e3f-4a5b-8c7d-9e0f1a2b3c4d";
const CHILD = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

const FIXTURE = {
  month: "2026-11",
  timezone: "Europe/Warsaw",
  totals: { costUsd: "4.123456", estimatedUsd: "0.850000", calls: 40, unknownCalls: 2, failedCalls: 3, unscopedCalls: 1 },
  features: [
    { feature: "deck_generation", calls: 12, inputTokens: 900000, outputTokens: 300000, characters: 0, audioMs: 0, images: 0, costUsd: "2.500000", estimated: false, unknownCalls: 0, sharePercent: 61 },
    { feature: "tts", calls: 20, inputTokens: 0, outputTokens: 0, characters: 0, audioMs: 38 * 60000, images: 0, costUsd: "1.000000", estimated: true, unknownCalls: 2, sharePercent: 24 },
    { feature: "illustration", calls: 8, inputTokens: 0, outputTokens: 0, characters: 0, audioMs: 0, images: 12, costUsd: "0.623456", estimated: false, unknownCalls: 0, sharePercent: 15 },
  ],
  decks: [
    { bucket: "deck", deckId: DECK_B, title: "Past Simple", kind: "lesson", generationUsd: "0.100000", ttsUsd: "0.050000", imagesUsd: "0.000000", totalUsd: "0.150000", monthUsd: "0.020000", estimated: false, unknownCalls: 0 },
    { bucket: "deck", deckId: DECK_A, title: "Dni tygodnia", kind: "vocabulary", generationUsd: "1.200000", ttsUsd: "0.800000", imagesUsd: "0.500000", totalUsd: "2.500000", monthUsd: "1.234567", estimated: true, unknownCalls: 2 },
    { bucket: "shared_ui", deckId: null, title: null, kind: null, generationUsd: "0.000000", ttsUsd: "0.300000", imagesUsd: "0.000000", totalUsd: "0.300000", monthUsd: "0.300000", estimated: false, unknownCalls: 0 },
  ],
  children: [
    { childId: CHILD, name: "Ala", deleted: false, sessions: 4, costUsd: "0.400000", gradingUsd: "0.250000", speechUsd: "0.100000", activityUsd: "0.050000", perSessionUsd: "0.100000", estimated: false, unknownCalls: 0 },
    { childId: null, name: null, deleted: true, sessions: 2, costUsd: "0.200000", gradingUsd: "0.200000", speechUsd: "0.000000", activityUsd: "0.000000", perSessionUsd: "0.100000", estimated: false, unknownCalls: 0 },
  ],
};

const EMPTY = {
  month: "2026-11",
  timezone: "Europe/Warsaw",
  totals: { costUsd: "0.000000", estimatedUsd: "0.000000", calls: 0, unknownCalls: 0, failedCalls: 0, unscopedCalls: 0 },
  features: [],
  decks: [],
  children: [],
};

interface Mock { months: string[] }

async function openCosts(page: Page, body: unknown = FIXTURE, path = "/parent/costs"): Promise<Mock> {
  const mock: Mock = { months: [] };
  await page.clock.setFixedTime(new Date("2026-11-15T12:00:00Z"));
  await page.route("**/api/v1/parent/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/login")) return route.fulfill({ json: { authenticated: true, setupRequired: false } });
    if (url.pathname.endsWith("/costs")) {
      const month = url.searchParams.get("month") ?? "";
      mock.months.push(month);
      return route.fulfill({ json: { ...(body as object), month } });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto(path);
  return mock;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test("nagłówek z sumą, szacunkiem i ostrzeżeniami oraz zakładka Funkcje", async ({ page }) => {
  await openCosts(page);
  await expect(page.getByRole("heading", { level: 1, name: messages.costs.title })).toBeVisible();
  await expect(page.getByTestId("costs-total")).toHaveText("Listopad 2026: 4,12 USD");
  await expect(page.getByTestId("costs-note-estimated")).toHaveText("w tym ≈ 0,85 USD szacunkowo");
  await expect(page.getByTestId("costs-note-unknown")).toHaveText("2 wywołań bez znanej ceny");
  await expect(page.getByTestId("costs-note-failed")).toHaveText("3 nieudanych wywołań");
  await expect(page.getByTestId("costs-note-unscoped")).toHaveText("1 wywołań bez przypisania");
  await expect(page.getByTestId("costs-net-note")).toHaveText(messages.costs.netNote);
  // żadna zakładka paska nie jest aktywna
  for (const id of ["tab-decks", "tab-sources", "tab-children", "tab-progress", "tab-work-card"]) {
    await expect(page.getByTestId(id)).toHaveAttribute("aria-current", "false");
  }

  const generation = page.getByTestId("costs-feature-deck_generation");
  await expect(generation).toContainText("Generowanie zestawów");
  await expect(generation).toContainText("1,2 mln tokenów");
  await expect(generation).toContainText("2,50 USD");
  await expect(generation).toContainText("61%");
  const tts = page.getByTestId("costs-feature-tts");
  await expect(tts).toContainText("Lektor (TTS)");
  await expect(tts).toContainText("38 min audio");
  await expect(tts).toContainText("≈ 1,00 USD");
  await expect(tts).toContainText("+2 bez ceny");
  await expect(page.getByTestId("costs-feature-illustration")).toContainText("12 obrazów");
});

test("zakładki Materiały i Dzieci: wiersze, znaczniki szacunku i „+N bez ceny” przy kwocie od początku", async ({ page }) => {
  await openCosts(page);
  await page.getByTestId("costs-tab-decks").click();
  // malejąco po kwocie „razem”: Dni tygodnia (2,50) przed Past Simple (0,15), na końcu wiersz wspólny
  const first = page.getByTestId("costs-deck-row-0");
  await expect(first).toContainText("Dni tygodnia");
  await expect(first).toContainText(messages.costs.kindVocabulary);
  await expect(first).toContainText("≈ 2,50 USD");
  await expect(first.getByTestId("costs-unknown")).toHaveText("+2 bez ceny");
  // kolumna miesiąca pokazuje zwykłą kwotę, bez znaczników
  const cells = first.locator("td");
  await expect(cells.last()).toHaveText("1,23 USD");
  await expect(page.getByTestId("costs-deck-row-1")).toContainText("Past Simple");
  await expect(page.getByTestId("costs-deck-row-1")).toContainText(messages.costs.kindLesson);
  await expect(page.getByTestId("costs-deck-row-2")).toContainText(messages.costs.sharedUi);
  await expect(page.getByText(messages.costs.sharedAssetNote)).toBeVisible();

  await page.getByTestId("costs-tab-children").click();
  await expect(page.getByTestId("costs-child-row-0")).toContainText("Ala");
  await expect(page.getByTestId("costs-child-row-0")).toContainText("0,10 USD");
  await expect(page.getByTestId("costs-child-row-1")).toContainText(messages.costs.deletedProfiles);
  await expect(page.getByText(messages.costs.childrenNote)).toBeVisible();
});

test("strzałki miesiąca: wstecz pyta o poprzedni miesiąc, w bieżącym „dalej” jest wyłączone", async ({ page }) => {
  const mock = await openCosts(page);
  await expect(page.getByTestId("costs-total")).toBeVisible();
  expect(mock.months).toEqual(["2026-11"]);
  await expect(page.getByTestId("costs-next")).toBeDisabled();

  await page.getByTestId("costs-prev").click();
  await expect(page.getByTestId("costs-month")).toHaveText("Październik 2026");
  await expect.poll(() => mock.months).toContain("2026-10");
  await expect(page.getByTestId("costs-total")).toContainText("Październik 2026");
  await expect(page.getByTestId("costs-next")).toBeEnabled();

  await page.getByTestId("costs-next").click();
  await expect(page.getByTestId("costs-month")).toHaveText("Listopad 2026");
  await expect(page.getByTestId("costs-next")).toBeDisabled();
});

test("pusty miesiąc pokazuje komunikat zamiast tabel", async ({ page }) => {
  await openCosts(page, EMPTY);
  await expect(page.getByTestId("costs-total")).toHaveText("Listopad 2026: 0,00 USD");
  await expect(page.getByTestId("costs-empty")).toHaveText(messages.costs.empty);
  await expect(page.getByTestId("costs-tab-features")).toHaveCount(0);
});

test("klik w materiał otwiera go w edytorze", async ({ page }) => {
  await openCosts(page);
  await page.getByTestId("costs-tab-decks").click();
  await page.getByTestId("costs-deck-row-0").getByTestId("costs-deck-link").click();
  await expect(page).toHaveURL(new RegExp(`/parent/decks/${DECK_A}$`));
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) {
  test(`wejście z menu panelu (${viewport.width} px): „Koszty” prowadzą do /parent/costs`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openCosts(page, FIXTURE, "/parent/decks");
    await expect(page.getByTestId("tab-decks")).toBeVisible();
    await page.getByTestId("parent-menu").click();
    const item = page.getByTestId("to-costs");
    await expect(item).toHaveText(messages.costs.menuItem);
    expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await item.click();
    await expect(page).toHaveURL(/\/parent\/costs$/);
    await expect(page.getByTestId("costs-total")).toBeVisible();
  });
}

for (const viewport of [{ width: 375, height: 812 }, { width: 320, height: 640 }]) {
  test(`telefon ${viewport.width} px: bez poziomego przepełnienia strony, strzałki miesiąca ≥ 44 px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openCosts(page);
    await expect(page.getByTestId("costs-total")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    for (const id of ["costs-prev", "costs-next"]) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.width, id).toBeGreaterThanOrEqual(44);
      expect(box.height, id).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width, id).toBeLessThanOrEqual(viewport.width + 0.5);
    }
    for (const tab of ["costs-tab-decks", "costs-tab-children", "costs-tab-features"]) {
      await page.getByTestId(tab).click();
      expect((await page.getByTestId(tab).boundingBox())!.height, tab).toBeGreaterThanOrEqual(44);
      await expectNoHorizontalOverflow(page);
    }
    // tabela przewija się we własnym kontenerze
    await page.getByTestId("costs-tab-decks").click();
    const scroll = await page.locator(".pp-costs-table:visible").evaluate((table) => {
      let container = table.parentElement!;
      while (!["auto", "scroll"].includes(getComputedStyle(container).overflowX) && container.parentElement) container = container.parentElement;
      return { overflowX: getComputedStyle(container).overflowX, scrollWidth: container.scrollWidth, clientWidth: container.clientWidth };
    });
    expect(["auto", "scroll"]).toContain(scroll.overflowX);
    expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth);
  });
}
