import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { TaskDto } from "@learning/contracts";
import { clozeTask, clozeUid as uid } from "./helpers/kid-fixtures";
import { installKidUiFixture } from "./helpers/kid-ui-fixture";
import { assignmentAttempt, lessonTaskFixture, openLessonTask, recordAttemptPosts, tapPoolAndCheck } from "./helpers/lesson-assignment-task";
import { expectButtonsNotClipped, expectTargetsReachable } from "./helpers/lesson-reach";

/**
 * Geometria „Uzupełnij tekst” (`lesson_cloze`) w interfejsie dziecka (API
 * zaślepione w przeglądarce, design szkoły §13.5; UX: spec
 * 2026-11-02-lesson-cloze-match-ux §4 i §8). Na wąskim telefonie (320 px,
 * także 320×568), w portrecie, niskim landscape (<480 px), na tablecie
 * i desktopie: tekst z czterema lukami zawija się w kontenerze materiału, luki
 * w zdaniu (jedyne cele stukania), bank słów i „Sprawdź” są osiągalne
 * (w viewporcie po przewinięciu), bez poziomego przepełnienia, z celami ≥48 px
 * i główną akcją ≥54 px. Luka nie nachodzi na tekst sąsiednich wierszy. Bank
 * stoi pod tekstem, a w niskim landscape (<480 × ≥600) obok niego. Symulacja
 * nie zastępuje odbioru na fizycznym urządzeniu.
 */

const childId = "10000000-0000-4000-8000-000000000801";
const deckId = "10000000-0000-4000-8000-000000000802";
const versionId = "10000000-0000-4000-8000-000000000804";
// `clozeTask` (helpers/kid-fixtures.ts) carries session ...803 and task id ...811 of this 0008xx id range.
const { sessionId, taskId: clozeTaskId } = clozeTask;

const ids = { childId, deckId, sessionId, versionId };
const deck = { title: "Fotosynteza", subjectTitle: "Przyroda" };

const VIEWPORTS = [
  { width: 320, height: 640 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
  { width: 320, height: 568 },
];

/**
 * Tekst z lukami rozdziału angielskiego: `contentLocale` „en-GB” — każdy
 * fragment tekstu stoi w osobnym `<span lang>`, a słowa banku i wypełnione
 * luki też niosą `lang`. Polecenie niesie polskie znaczenie całego tekstu
 * (jak w zeszycie ćwiczeń), więc jest dłuższe niż w szkole.
 */
const chapterDeck = { title: "Angielski — rozdział: Unit 1", subjectTitle: "Angielski — rozdział" };
const chapterClozeTask: TaskDto = {
  taskId: uid(12), sessionId, ordinal: 0, exerciseType: "lesson_cloze", direction: null, state: "issued", remainingAssessed: 2,
  prompt: {
    kind: "lesson_cloze",
    instructionPl: "W poniedziałek pada deszcz i mam na sobie kalosze. We wtorek wieje wiatr. W piątek jest słonecznie, więc mam na sobie koszulkę i szorty. Uzupełnij tekst.",
    contentLocale: "en-GB",
    segments: [
      { text: "On Monday it's " },
      { gapId: uid(40) },
      { text: " and I'm wearing my " },
      { gapId: uid(41) },
      { text: ". On Tuesday it's " },
      { gapId: uid(42) },
      { text: ". On Friday it's sunny, so I'm wearing a " },
      { gapId: uid(43) },
      { text: " and shorts." },
    ],
    words: [
      { id: uid(50), text: "wellington boots" },
      { id: uid(51), text: "raining" },
      { id: uid(52), text: "windy" },
      { id: uid(53), text: "T-shirt" },
      { id: uid(54), text: "snowing" },
      { id: uid(55), text: "scarf" },
    ],
  },
};

interface Rect { left: number; top: number; right: number; bottom: number }
interface Box { x: number; y: number; width: number; height: number }

/** Prostokąty (piksele ekranu) elementów o podanych selektorach, zmierzone w jednej chwili. */
async function boxesNow(page: Page, selectors: readonly string[]): Promise<Box[]> {
  return page.evaluate((list) => list.map((selector) => {
    const { x, y, width, height } = document.querySelector(selector)!.getBoundingClientRect();
    return { x, y, width, height };
  }), selectors);
}

/**
 * Luka powiększa swój wiersz zamiast nachodzić na sąsiednie: prostokąty tekstu
 * akapitu (z `Range`, bez luk i `.kid-visually-hidden`) nie przecinają żadnej
 * luki, a przynajmniej jedna luka ma tekst w wierszu nad i pod sobą (inaczej
 * sprawdzenie niczego by nie dowodziło).
 */
async function expectGapsClearOfText(page: Page, label: string): Promise<void> {
  const { gaps, texts } = await page.getByTestId("kid-lesson-cloze-text").evaluate((root) => {
    const rect = ({ left, top, right, bottom }: DOMRect) => ({ left, top, right, bottom });
    const range = document.createRange();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const rects: { left: number; top: number; right: number; bottom: number }[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.parentElement?.closest("[data-testid='kid-lesson-cloze-gap'], .kid-visually-hidden")) continue;
      range.selectNodeContents(node);
      for (const line of range.getClientRects()) if (line.width > 0 && line.height > 0) rects.push(rect(line));
    }
    const gapRects = [...root.querySelectorAll("[data-testid='kid-lesson-cloze-gap']")].map((gap) => rect(gap.getBoundingClientRect()));
    return { gaps: gapRects, texts: rects };
  }) as { gaps: Rect[]; texts: Rect[] };
  const details = `gaps ${JSON.stringify(gaps)}, text ${JSON.stringify(texts)} at ${label}`;
  expect(texts.length, `text rectangles: ${details}`).toBeGreaterThan(0);
  for (const gap of gaps) {
    const crossing = texts.filter((text) =>
      text.left < gap.right - 1 && text.right > gap.left + 1 && text.top < gap.bottom - 1 && text.bottom > gap.top + 1);
    expect(crossing, `text crossing the gap ${JSON.stringify(gap)}: ${details}`).toEqual([]);
  }
  const framed = gaps.some((gap) => texts.some((text) => text.bottom <= gap.top + 1) && texts.some((text) => text.top >= gap.bottom - 1));
  expect(framed, `a gap with text in the line above and below: ${details}`).toBe(true);
}

/** Prostokąt `inner` mieści się w `outer` z tolerancją 1 px. */
function expectBoxWithin(inner: Box, outer: Box, name: string): void {
  expect(inner.x, name).toBeGreaterThanOrEqual(outer.x - 1);
  expect(inner.y, name).toBeGreaterThanOrEqual(outer.y - 1);
  expect(inner.x + inner.width, name).toBeLessThanOrEqual(outer.x + outer.width + 1);
  expect(inner.y + inner.height, name).toBeLessThanOrEqual(outer.y + outer.height + 1);
}

/** Geometria tekstu z lukami na każdym ekranie (po wypełnieniu dwóch luk przez wywołującego). */
async function expectClozeGeometry(page: Page, testInfo: TestInfo, shotPrefix: string): Promise<void> {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    const label = `${viewport.width}x${viewport.height}`;
    await expectTargetsReachable(page, viewport, [
      { testId: "kid-lesson-cloze-text", tall: true },
      ...Array.from({ length: 4 }, (_, nth) => ({ testId: "kid-lesson-cloze-gap", nth, minHeight: 48 })),
      ...Array.from({ length: 4 }, (_, nth) => ({ testId: "kid-lesson-cloze-option", nth, minHeight: 48 })),
      { testId: "kid-lesson-check", minHeight: 54 },
    ]);
    await expectButtonsNotClipped(page, "kid-lesson-cloze-gap", label);
    await expectButtonsNotClipped(page, "kid-lesson-cloze-option", label);
    // Luka w tekście nie wystaje poza akapit (zawija się razem z tekstem).
    const text = (await page.getByTestId("kid-lesson-cloze-text").boundingBox())!;
    for (const gap of await page.getByTestId("kid-lesson-cloze-gap").all()) {
      const bounds = (await gap.boundingBox())!;
      expect(bounds.x, `gap inside text at ${label}`).toBeGreaterThanOrEqual(text.x - 1);
      expect(bounds.x + bounds.width, `gap inside text at ${label}`).toBeLessThanOrEqual(text.x + text.width + 1);
    }
    // Bank pod tekstem, a w niskim landscape (<480 × ≥600) obok niego (przyklejony).
    const [textNow, pool] = await boxesNow(page, ["[data-testid='kid-lesson-cloze-text']", "[data-testid='kid-lesson-cloze-pool']"]);
    const placed = `text ${JSON.stringify(textNow)}, bank ${JSON.stringify(pool)} at ${label}`;
    if (viewport.height < 480 && viewport.width >= 600) {
      expect(pool!.x, `bank beside the text: ${placed}`).toBeGreaterThanOrEqual(textNow!.x + textNow!.width - 1);
    } else {
      expect(pool!.y, `bank below the text: ${placed}`).toBeGreaterThanOrEqual(textNow!.y + textNow!.height - 1);
    }
    await expectGapsClearOfText(page, label);
    await page.screenshot({ path: testInfo.outputPath(`${shotPrefix}-${label}.png`) });
  }
}

test("cloze: text with four gaps, word bank and check fit every form factor", async ({ page }, testInfo) => {
  await installKidUiFixture(page, lessonTaskFixture(ids, deck, [clozeTask]));
  await openLessonTask(page, VIEWPORTS[1]!, "kid-lesson-cloze");
  await expect(page.getByTestId("kid-instruction")).toContainText("Uzupełnij tekst.");
  await expect(page.getByTestId("kid-lesson-cloze-gap")).toHaveCount(4);
  // Luki są przyciskami w zdaniu — jedynymi celami stukania w tekście.
  await expect(page.getByTestId("kid-lesson-cloze-text").locator("button")).toHaveCount(4);
  // Bez contentLocale tekst nie jest dzielony na fragmenty z `lang`.
  await expect(page.getByTestId("kid-lesson-cloze-segment")).toHaveCount(0);
  // Dwie luki wypełnione przed pomiarem: najdłuższe słowo banku w pierwszej luce, reszta w banku.
  await page.getByTestId("kid-lesson-cloze-option").filter({ hasText: "światła słonecznego" }).click();
  // Nazwa dostępna luki: ukryty polski przedrostek i słowo (albo „pusta”), bez dodatkowych spacji.
  await expect(page.getByRole("button", { name: "Luka 1: światła słonecznego", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Luka 2: pusta, wybierz słowo", exact: true })).toHaveCount(1);
  await page.getByTestId("kid-lesson-cloze-option").filter({ hasText: "dwutlenek węgla" }).click();
  await expect(page.getByTestId("kid-lesson-cloze-option")).toHaveCount(4);
  await expect(page.getByTestId("kid-lesson-cloze-text")).toContainText("światła słonecznego");
  // Luka z najdłuższym słowem zawija się w akapicie także na najmniejszym telefonie.
  await page.setViewportSize({ width: 320, height: 568 });
  const longGap = page.getByTestId("kid-lesson-cloze-gap").first();
  await expect(longGap).toContainText("światła słonecznego");
  await longGap.scrollIntoViewIfNeeded();
  const [gapBox, textBox] = await boxesNow(page, ["[data-testid='kid-lesson-cloze-gap']", "[data-testid='kid-lesson-cloze-text']"]);
  expectBoxWithin(gapBox!, textBox!, `long gap inside the text at 320x568: gap ${JSON.stringify(gapBox)}, text ${JSON.stringify(textBox)}`);
  await expectClozeGeometry(page, testInfo, "cloze");
});

test("cloze in low landscape: the active gap and the word bank are on screen together", async ({ page }) => {
  const viewport = { width: 844, height: 390 };
  await installKidUiFixture(page, lessonTaskFixture(ids, deck, [clozeTask]));
  await openLessonTask(page, viewport, "kid-lesson-cloze");
  for (let gap = 0; gap < 3; gap += 1) await page.getByTestId("kid-lesson-cloze-option").first().click();
  const active = page.getByTestId("kid-lesson-cloze-gap").nth(3);
  await expect(active).toHaveAttribute("aria-pressed", "true");
  await active.scrollIntoViewIfNeeded();
  // Oba prostokąty w jednej chwili: przyklejony bank stoi obok tekstu, gdziekolwiek jest aktywna luka.
  const [gapBox, poolBox] = await boxesNow(page, [
    "[data-testid='kid-lesson-cloze-gap'][aria-pressed='true']", "[data-testid='kid-lesson-cloze-pool']",
  ]);
  const screen = { x: 0, y: 0, ...viewport };
  const details = `gap ${JSON.stringify(gapBox)}, bank ${JSON.stringify(poolBox)} at 844x390`;
  expectBoxWithin(gapBox!, screen, `active gap in the viewport: ${details}`);
  expectBoxWithin(poolBox!, screen, `bank in the viewport: ${details}`);
});

test("cloze (English chapter, contentLocale en-GB): lang-wrapped text, gaps and bank fit every form factor", async ({ page }, testInfo) => {
  await installKidUiFixture(page, lessonTaskFixture(ids, chapterDeck, [chapterClozeTask]));
  await openLessonTask(page, VIEWPORTS[1]!, "kid-lesson-cloze");
  await expect(page.getByTestId("kid-instruction")).toContainText("Uzupełnij tekst.");
  await expect(page.getByTestId("kid-lesson-cloze-gap")).toHaveCount(4);
  // Ścieżka z językiem treści: każdy fragment tekstu w osobnym `<span lang="en-GB">`, bank też z `lang`.
  const segments = page.getByTestId("kid-lesson-cloze-segment");
  await expect(segments).toHaveCount(5);
  for (const segment of await segments.all()) await expect(segment).toHaveAttribute("lang", "en-GB");
  for (const option of await page.getByTestId("kid-lesson-cloze-option").all()) await expect(option).toHaveAttribute("lang", "en-GB");
  // Dwie luki wypełnione przed pomiarem (najdłuższe słowo banku w drugiej luce).
  await page.getByTestId("kid-lesson-cloze-option").filter({ hasText: "raining" }).click();
  await page.getByTestId("kid-lesson-cloze-option").filter({ hasText: "wellington boots" }).click();
  await expect(page.getByTestId("kid-lesson-cloze-option")).toHaveCount(4);
  await expect(page.getByTestId("kid-lesson-cloze-text")).toContainText("wellington boots");
  // Słowo w luce niesie `lang` materiału, a przycisk luki (z ukrytym polskim przedrostkiem) — nie.
  const firstGap = page.getByTestId("kid-lesson-cloze-gap").first();
  await expect(firstGap.locator("span[lang]")).toHaveAttribute("lang", "en-GB");
  await expect(firstGap).not.toHaveAttribute("lang");
  await expectClozeGeometry(page, testInfo, "chapter-cloze");
});

test("cloze: check sends gap → word assignments and shows the completed text after a mistake", async ({ page }) => {
  const posted = recordAttemptPosts(page);
  // Pełny tekst zadania z poprawnymi słowami we wszystkich czterech lukach (jak `filledText` serwera).
  const solution = ["dwutlenek węgla", "światła słonecznego", "cukry", "tlen"];
  if (clozeTask.prompt.kind !== "lesson_cloze") throw new Error("cloze fixture expected");
  let gap = 0;
  const correctText = clozeTask.prompt.segments.map((segment) => ("gapId" in segment ? solution[gap++] : segment.text)).join("");
  expect(gap).toBe(4);
  const kidFixture = lessonTaskFixture(ids, deck, [clozeTask], [assignmentAttempt(uid(90), clozeTaskId, { kind: "incorrect", correctText })]);
  await installKidUiFixture(page, kidFixture);
  await openLessonTask(page, VIEWPORTS[1]!, "kid-lesson-cloze");
  const assignments = await tapPoolAndCheck(page, "kid-lesson-cloze-option", 4, posted);
  expect(assignments.map((entry) => entry.itemId)).toEqual([uid(20), uid(21), uid(22), uid(23)]);
  await expect(page.getByText(correctText)).toBeVisible();
  await expect(page.getByTestId("kid-lesson-cloze-option").first()).toBeDisabled();
});
