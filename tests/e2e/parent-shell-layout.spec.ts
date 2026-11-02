import { expect, test, type Page } from "@playwright/test";
import { messages } from "@learning/contracts";

/**
 * Geometria ramy panelu rodzica (plan 2026-10-29-parent-ui-mantine, faza 1):
 * dolny pasek na telefonie (< 600 px), zakładki od 600 px, cele ≥ 44 px,
 * brak przewijania w poziomie oraz zapamiętany tryb jasny/ciemny.
 * API rodzica jest zaślepione — zalogowany panel bez zestawów i dzieci.
 */

async function openSignedInPanel(page: Page, path = "/parent/decks"): Promise<void> {
  await page.route("**/api/v1/parent/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/login")) {
      return route.fulfill({ json: { authenticated: true, setupRequired: false } });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto(path);
  await expect(page.getByTestId("tab-decks")).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

const TABS = ["tab-decks", "tab-sources", "tab-children", "tab-progress", "tab-work-card"];

test("telefon: dolny pasek sekcji przy dolnej krawędzi i menu z akcjami", async ({ page }) => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 640 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport);
    await openSignedInPanel(page);
    await expectNoHorizontalOverflow(page);
    let previousRight = 0;
    for (const id of TABS) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, id).not.toBeNull();
      expect(box!.height, id).toBeGreaterThanOrEqual(44);
      expect(box!.width, id).toBeGreaterThanOrEqual(44);
      expect(box!.x, id).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, id).toBeLessThanOrEqual(viewport.width + 0.5);
      expect(box!.y + box!.height, id).toBeLessThanOrEqual(viewport.height + 0.5);
      expect(box!.y, id).toBeGreaterThan(viewport.height - 100);
      // pięć zakładek w jednym rzędzie, bez nachodzenia na siebie
      expect(box!.x, id).toBeGreaterThanOrEqual(previousRight - 0.5);
      previousRight = box!.x + box!.width;
      // etykieta mieści się w swojej zakładce (bez ucięcia i wyjścia poza pasek)
      const label = await page.getByTestId(id).evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
      expect(label.scroll, id).toBeLessThanOrEqual(label.client);
    }
    await expect(page.getByTestId("tab-sources")).toHaveText(messages.sources.tab);
    await expect(page.getByTestId("tab-sources")).toHaveAttribute("href", "/parent/sources");
    await expect(page.getByTestId("to-learning")).toHaveCount(0);

    const menu = page.getByTestId("parent-menu");
    expect((await menu.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await menu.click();
    for (const id of ["to-costs", "to-learning", "parent-logout"]) {
      await expect(page.getByTestId(id)).toBeVisible();
      expect((await page.getByTestId(id).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await page.keyboard.press("Escape");
  }
});

test("od 600 px: zakładki pod nagłówkiem, akcje w nagłówku", async ({ page }) => {
  // 600 i 640 px: najwęższe szerokości z rzędem zakładek — piąta zakładka nie może wyjść poza pasek
  for (const viewport of [{ width: 600, height: 960 }, { width: 640, height: 360 }, { width: 844, height: 390 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    await openSignedInPanel(page);
    await expectNoHorizontalOverflow(page);
    await expect(page.getByTestId("parent-menu")).toHaveCount(0);
    for (const id of [...TABS, "to-costs", "to-learning", "parent-logout", "color-scheme-menu"]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, `${id} @${viewport.width}`).not.toBeNull();
      expect(box!.height, `${id} @${viewport.width}`).toBeGreaterThanOrEqual(44);
      expect(box!.y, `${id} @${viewport.width}`).toBeLessThan(140);
      expect(box!.x + box!.width, `${id} @${viewport.width}`).toBeLessThanOrEqual(viewport.width + 0.5);
    }
    // akcje nagłówka nie nachodzą na siebie ani na markę (Koszty, Do nauki, Wygląd, Wyloguj)
    const actions = [];
    for (const id of ["to-costs", "to-learning", "color-scheme-menu", "parent-logout"]) actions.push((await page.getByTestId(id).boundingBox())!);
    actions.sort((left, right) => left.x - right.x);
    for (let index = 1; index < actions.length; index += 1) {
      expect(actions[index]!.x, `akcje nagłówka @${viewport.width}`).toBeGreaterThanOrEqual(actions[index - 1]!.x + actions[index - 1]!.width - 0.5);
    }
    const brand = (await page.locator(".pp-shell-logo").boundingBox())!;
    expect(actions[0]!.x, `marka @${viewport.width}`).toBeGreaterThanOrEqual(brand.x + brand.width - 0.5);
    // pasek zakładek mieści wszystkie zakładki: bez przewijania w poziomie (pasek przewijania
    // w pasku o stałej wysokości dawałby też przewijanie w pionie)
    const tabs = await page.locator("nav.pp-shell-tabs").evaluate((nav) => ({
      scrollWidth: nav.scrollWidth, clientWidth: nav.clientWidth, scrollHeight: nav.scrollHeight, clientHeight: nav.clientHeight,
    }));
    expect(tabs.scrollWidth, `pasek zakładek @${viewport.width}`).toBeLessThanOrEqual(tabs.clientWidth);
    expect(tabs.scrollHeight, `pasek zakładek @${viewport.width}`).toBeLessThanOrEqual(tabs.clientHeight);
  }
});

test("600 px z klasycznym paskiem przewijania: pięć zakładek nadal mieści się w pasku", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 960 });
  await openSignedInPanel(page);
  // Chromium testów ukrywa paski przewijania; klasyczny pasek (17 px) zabiera szerokość
  // przypiętemu nagłówkowi, a media query nadal widzi 600 px — symulacja: węższy nagłówek.
  await page.addStyleTag({ content: ".mantine-AppShell-header { right: 17px !important; }" });
  const tabs = await page.locator("nav.pp-shell-tabs").evaluate((nav) => ({
    scrollWidth: nav.scrollWidth, clientWidth: nav.clientWidth, scrollHeight: nav.scrollHeight, clientHeight: nav.clientHeight,
  }));
  expect(tabs.clientWidth).toBeLessThan(570);
  expect(tabs.scrollWidth).toBeLessThanOrEqual(tabs.clientWidth);
  expect(tabs.scrollHeight).toBeLessThanOrEqual(tabs.clientHeight);
  const last = (await page.getByTestId("tab-work-card").boundingBox())!;
  expect(last.x + last.width).toBeLessThanOrEqual(600 - 17 + 0.5);
});

/**
 * Fonty CI (Linux) są szersze niż lokalne (Windows). Szerszy zamiennik plus rozstrzelenie liter
 * symuluje te metryki lokalnie i niezależnie od zainstalowanych fontów (samo rozstrzelenie
 * gwarantuje, że tekst jest szerszy także tam, gdzie „DejaVu Sans” i „Verdana” nie istnieją).
 * Zwraca stosunek naturalnej szerokości tekstu etykiety „Karta pracy” po symulacji do szerokości przed nią.
 */
async function simulateWideFonts(page: Page): Promise<number> {
  // Naturalna szerokość tekstu (zakres obejmujący zawartość), a nie pudełka etykiety: etykieta ma
  // `overflow: hidden` i `text-overflow: ellipsis` w elemencie o stałej szerokości, więc jej pudełko
  // jest przycięte i na CI (gdzie „DejaVu Sans” już jest aktywny) stosunek wynosiłby dokładnie 1.
  const width = () => page.getByTestId("tab-work-card").locator(".pp-shell-label").evaluate((label) => {
    const range = document.createRange();
    range.selectNodeContents(label);
    return range.getBoundingClientRect().width;
  });
  const before = await width();
  await page.addStyleTag({
    content: 'html, body, body * { font-family: "DejaVu Sans", Verdana, sans-serif !important; letter-spacing: 0.03em !important; }',
  });
  return (await width()) / before;
}

/** Zapas szerokości paska zakładek: szerokość paska minus naturalna szerokość etykiet, odstępów i dopełnień. */
async function topRowSpareWidth(page: Page): Promise<number> {
  return page.locator("nav.pp-shell-tabs").evaluate((nav) => {
    let natural = 0;
    for (const tab of Array.from(nav.children)) {
      const style = getComputedStyle(tab);
      const label = tab.querySelector(".pp-shell-label")!.getBoundingClientRect().width;
      natural += label + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    }
    natural += (nav.children.length - 1) * parseFloat(getComputedStyle(nav).columnGap || "0");
    return nav.clientWidth - natural;
  });
}

test("szerokie fonty CI: dolny pasek na telefonie ma stałą wysokość, etykiety w jednej linii i pełne nazwy linków", async ({ page }) => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 640 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport);
    await openSignedInPanel(page);
    expect(await simulateWideFonts(page), `szerokość etykiety @${viewport.width}`).toBeGreaterThan(1.02);
    await expectNoHorizontalOverflow(page);
    for (const id of TABS) {
      const tab = page.getByTestId(id);
      const box = (await tab.boundingBox())!;
      expect(box.height, `${id} @${viewport.width}`).toBeGreaterThanOrEqual(44);
      expect(box.height, `stała wysokość ${id} @${viewport.width}`).toBeLessThanOrEqual(56.5);
      expect(box.y + box.height, `${id} @${viewport.width}`).toBeLessThanOrEqual(viewport.height + 0.5);
      expect(box.x + box.width, id).toBeLessThanOrEqual(viewport.width + 0.5);
      expect(await tab.evaluate((element) => element.scrollWidth - element.clientWidth), id).toBeLessThanOrEqual(0);
      // etykieta to jedna linia (wysokość linii 11 px × 1,25), nawet gdy kończy się wielokropkiem
      const label = await tab.locator(".pp-shell-label").evaluate((element) => element.getBoundingClientRect().height);
      expect(label, `etykieta ${id} @${viewport.width}`).toBeLessThan(18);
    }
    // wielokropek jest tylko wizualny: nazwa dostępna to pełna etykieta
    await expect(page.getByRole("link", { name: messages.workCard.title, exact: true })).toHaveAttribute("href", "/parent/work-card");
    await expect(page.getByTestId("tab-work-card")).toHaveText(messages.workCard.title);
  }
});

test("szerokie fonty CI: pięć zakładek pod nagłówkiem z zapasem ≥ 80 px, także z klasycznym paskiem przewijania", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 960 });
  await openSignedInPanel(page);
  expect(await simulateWideFonts(page)).toBeGreaterThan(1.02);
  for (const scrollbar of [0, 17]) {
    await page.addStyleTag({ content: `.mantine-AppShell-header { right: ${scrollbar}px !important; }` });
    const tabs = await page.locator("nav.pp-shell-tabs").evaluate((nav) => ({
      scrollWidth: nav.scrollWidth, clientWidth: nav.clientWidth, scrollHeight: nav.scrollHeight, clientHeight: nav.clientHeight,
    }));
    expect(tabs.scrollWidth, `pasek ${scrollbar} px`).toBeLessThanOrEqual(tabs.clientWidth);
    expect(tabs.scrollHeight, `pasek ${scrollbar} px`).toBeLessThanOrEqual(tabs.clientHeight);
    expect(await topRowSpareWidth(page), `zapas ${scrollbar} px`).toBeGreaterThanOrEqual(80);
    for (const id of ["to-costs", "parent-logout"]) {
      const action = (await page.getByTestId(id).boundingBox())!;
      expect(action.x + action.width, `${id} ${scrollbar} px`).toBeLessThanOrEqual(600 - scrollbar + 0.5);
    }
    const last = (await page.getByTestId("tab-work-card").boundingBox())!;
    expect(last.x + last.width, `ostatnia zakładka ${scrollbar} px`).toBeLessThanOrEqual(600 - scrollbar + 0.5);
    // ikony znikają z zakładek, ale nazwa sekcji pozostaje widocznym tekstem linku
    await expect(page.getByTestId("tab-work-card").locator(".pp-icon")).toBeHidden();
    await expect(page.getByRole("link", { name: messages.workCard.title, exact: true })).toBeVisible();
  }
});

test("wybrany tryb ciemny przeżywa odświeżenie strony", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSignedInPanel(page);
  await page.getByTestId("color-scheme-menu").click();
  await page.getByTestId("color-scheme-control").getByText("Ciemny").click();
  await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "dark");

  await page.reload();
  await expect(page.getByTestId("tab-decks")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "dark");

  await page.getByTestId("color-scheme-menu").click();
  await page.getByTestId("color-scheme-control").getByText("Jasny").click();
  await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "light");
});

test("nieudane pierwsze wczytanie list pokazuje błąd z ponowieniem, nie pusty stan", async ({ page }) => {
  let failLists = true;
  await page.route("**/api/v1/parent/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/login")) {
      return route.fulfill({ json: { authenticated: true, setupRequired: false } });
    }
    if (failLists) {
      return route.fulfill({ status: 503, json: { code: "internal", message: "x", retryable: true, requestId: "r" } });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto("/parent/children");
  await expect(page.getByTestId("panel-load-error")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(messages.children.empty)).toHaveCount(0);

  failLists = false;
  await page.getByTestId("panel-load-retry").click();
  await expect(page.getByTestId("panel-load-error")).toHaveCount(0);
  await expect(page.getByText(messages.children.empty)).toBeVisible();
});

test("powrót sieci nie przełącza panelu na logowanie (sesję sprawdzają tylko odpowiedzi 401)", async ({ page, context }) => {
  let authStateCalls = 0;
  await page.route("**/api/v1/parent/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/login")) {
      authStateCalls += 1;
      return route.fulfill({ json: { authenticated: authStateCalls === 1, setupRequired: false } });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto("/parent/decks");
  await expect(page.getByTestId("tab-decks")).toBeVisible();

  await context.setOffline(true);
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(500);
  await expect(page.getByTestId("tab-decks")).toBeVisible();
  await expect(page.getByTestId("auth-secret")).toHaveCount(0);
  expect(authStateCalls).toBe(1);
});

const SAMPLE_DECKS = [
  { deckId: "10000000-0000-4000-8000-000000000001", title: "Dni tygodnia", state: "review", kind: "vocabulary", editableVersionId: null, publishedVersionId: null, itemCount: 7,
    assignedChildren: [{ childId: "20000000-0000-4000-8000-000000000001", displayName: "Ola", testDate: "2026-11-05" }] },
  { deckId: "10000000-0000-4000-8000-000000000002", title: `Bardzo długi tytuł zestawu ${"bezspacji".repeat(8)}`, state: "published", kind: "vocabulary", editableVersionId: null, publishedVersionId: null, itemCount: 10 },
  { deckId: "10000000-0000-4000-8000-000000000003", title: "Past Simple", state: "published", kind: "lesson", editableVersionId: null, publishedVersionId: null, itemCount: 24 },
  { deckId: "10000000-0000-4000-8000-000000000004", title: "Zwierzęta na farmie", state: "draft", kind: "vocabulary", editableVersionId: null, publishedVersionId: null, itemCount: 0 },
];

async function openDeckList(page: Page): Promise<void> {
  await page.route("**/api/v1/parent/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/login")) return route.fulfill({ json: { authenticated: true, setupRequired: false } });
    if (url.pathname.endsWith("/decks")) return route.fulfill({ json: SAMPLE_DECKS });
    return route.fulfill({ json: [] });
  });
  await page.goto("/parent/decks");
  await expect(page.getByTestId("deck-row-0")).toBeVisible();
}

test("lista zestawów: na telefonie przycisk „Nowy materiał” nad dolnym paskiem, bez przewijania w poziomie", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDeckList(page);
  await expectNoHorizontalOverflow(page);
  const fab = await page.getByTestId("new-material-open").boundingBox();
  const nav = await page.getByTestId("tab-decks").boundingBox();
  expect(fab!.height).toBeGreaterThanOrEqual(44);
  expect(fab!.y + fab!.height).toBeLessThanOrEqual(nav!.y);
  expect(fab!.x + fab!.width).toBeLessThanOrEqual(390);
  for (let index = 0; index < SAMPLE_DECKS.length; index += 1) {
    const row = await page.getByTestId(`deck-row-${index}`).boundingBox();
    expect(row!.height).toBeGreaterThanOrEqual(44);
    expect(row!.x + row!.width).toBeLessThanOrEqual(390);
  }
  await page.getByTestId("new-material-open").click();
  const dialog = await page.getByTestId("new-material-dialog").boundingBox();
  expect(dialog!.width).toBeGreaterThanOrEqual(389);
  await expect(page.getByTestId("new-material-generate")).toBeVisible();
});

test("lista zestawów: na desktopie przycisk w nagłówku sekcji, tryb ciemny obejmuje listę", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "dark" });
  await openDeckList(page);
  await expectNoHorizontalOverflow(page);
  const button = await page.getByTestId("new-material-open").boundingBox();
  expect(button!.y).toBeLessThan(250);
  const card = page.getByTestId("deck-row-0");
  const background = await card.evaluate((element) => getComputedStyle(element.closest("li")!).backgroundColor);
  const [r, g, b] = background.match(/\d+/g)!.map(Number);
  expect(r! + g! + b!).toBeLessThan(3 * 80);
});

test("nowy materiał: przejście do pustego formularza generowania przenosi fokus do pola w oknie", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openDeckList(page);
  await page.getByTestId("new-material-open").click();
  await page.getByTestId("new-material-generate").click();
  await expect(page.getByTestId("generate-submit")).toBeDisabled();
  await expect(page.getByTestId("deck-title")).toBeFocused();
  for (let step = 0; step < 6; step += 1) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="new-material-dialog"]') !== null)).toBe(true);
  }
});
