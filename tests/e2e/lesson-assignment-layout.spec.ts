import { expect, test, type Page } from "@playwright/test";
import { messages, type TaskDto } from "@learning/contracts";
import { boxes, expectRectsUnchanged, nextFrames, waitForKidScale } from "./helpers/kid-frame";
import { installKidUiFixture } from "./helpers/kid-ui-fixture";
import { assignmentAttempt, lessonTaskFixture, openLessonTask, pairAndCheck, recordAttemptPosts } from "./helpers/lesson-assignment-task";
import { expectButtonsNotClipped, expectTargetsReachable } from "./helpers/lesson-reach";

/**
 * Geometria „Połącz w pary” (`lesson_match`) i „Pogrupuj” (`lesson_group`)
 * w interfejsie dziecka (API zaślepione w przeglądarce, design szkoły §10.5;
 * pary: spec 2026-11-02-lesson-cloze-match-ux §5, §8).
 * W portrecie (także 320 px dla par), niskim landscape (<480 px), na tablecie
 * i desktopie: kafelki, grupy i „Sprawdź” są osiągalne (w viewporcie po
 * przewinięciu), bez poziomego przepełnienia, z celami ≥48 px i główną akcją
 * ≥54 px; najdłuższe teksty (100 znaków po prawej) zawijają się zamiast ucinać.
 * Pary stoją w dwóch kolumnach, a linie i kropki leżą na krawędziach kafelków
 * także pod skalą 1,6, po zmianie okna i po zmianie stylu. Symulacja nie
 * zastępuje odbioru na fizycznym urządzeniu.
 */

const childId = "10000000-0000-4000-8000-000000000701";
const deckId = "10000000-0000-4000-8000-000000000702";
const sessionId = "10000000-0000-4000-8000-000000000703";
const versionId = "10000000-0000-4000-8000-000000000704";
const matchTaskId = "10000000-0000-4000-8000-000000000711";
const groupTaskId = "10000000-0000-4000-8000-000000000712";
const uid = (n: number) => `10000000-0000-4000-8000-0000000007${String(n).padStart(2, "0")}`;

const ids = { childId, deckId, sessionId, versionId };
const deck = { title: "Siatka geograficzna", subjectTitle: "Geografia" };

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
];

const base = (taskId: string, exerciseType: TaskDto["exerciseType"]) => ({
  taskId, sessionId, ordinal: 0, exerciseType, direction: null, state: "issued" as const, remainingAssessed: 2,
});

const LONG_RIGHT = "wyobrażona linia na powierzchni Ziemi łącząca oba bieguny, wyznaczająca długość geograficzną miejsca";

const matchTask: TaskDto = {
  ...base(matchTaskId, "lesson_match"),
  prompt: {
    kind: "lesson_match",
    instructionPl: "Połącz pojęcie z jego opisem.",
    left: [
      { id: uid(20), text: "równik" },
      { id: uid(21), text: "południk zerowy" },
      { id: uid(22), text: "równoleżnik" },
      { id: uid(23), text: "biegun północny" },
      { id: uid(24), text: "zwrotnik Raka" },
    ],
    right: [
      { id: uid(30), text: LONG_RIGHT },
      { id: uid(31), text: "najdłuższy równoleżnik, dzieli Ziemię na półkulę północną i południową" },
      { id: uid(32), text: "przechodzi przez Greenwich" },
      { id: uid(33), text: "linia biegnąca równolegle do równika" },
      { id: uid(34), text: "punkt, w którym oś Ziemi przecina jej powierzchnię na północy" },
      { id: uid(35), text: "równoleżnik 23°26′ N" },
      { id: uid(36), text: "najwyższy szczyt Europy" },
    ],
  },
};

const groupTask: TaskDto = {
  ...base(groupTaskId, "lesson_group"),
  prompt: {
    kind: "lesson_group",
    instructionPl: "Pogrupuj zwierzęta.",
    groups: [{ id: uid(40), text: "ssaki" }, { id: uid(41), text: "ptaki" }, { id: uid(42), text: "gady i płazy razem" }],
    items: [
      { id: uid(50), text: "nietoperz" }, { id: uid(51), text: "wróbel" }, { id: uid(52), text: "jaszczurka zwinka" },
      { id: uid(53), text: "delfin" }, { id: uid(54), text: "sowa" }, { id: uid(55), text: "żaba" },
      { id: uid(56), text: "kret" }, { id: uid(57), text: "bocian biały" },
    ],
  },
};

/** Pary: obecne viewporty grup i najwęższy telefon (compact 320 px). */
const MATCH_VIEWPORTS = [...VIEWPORTS, { width: 320, height: 568 }];

const TILES = "[data-testid='kid-lesson-match-left'], [data-testid='kid-lesson-match-right']";

/**
 * Końce każdej linii i środki kropek, przeliczone z pikseli wewnętrznych SVG
 * (bez `viewBox`) na ekran: lewy prostokąt SVG + współrzędna × `currentCSSZoom`.
 * Leżą na środku krawędzi zwróconej do pasa: lewy kafelek — prawa krawędź,
 * prawy — lewa (prostokąty kafelków w pikselach ekranu, tolerancja 1,5 px × zoom).
 */
async function expectLinesOnTiles(page: Page, label: string): Promise<void> {
  await expect(async () => {
    const misses = await page.evaluate(() => {
      const svg = document.querySelector<SVGSVGElement>("[data-testid='kid-lesson-match-lines']");
      if (svg === null) return ["no svg"];
      const zoom = svg.currentCSSZoom;
      const svgRect = svg.getBoundingClientRect();
      const tolerance = 1.5 * zoom;
      const anchor = (side: string, id: string | null) => {
        const tile = document.querySelector(`[data-testid='kid-lesson-match-${side}'][data-item-id='${id}']`);
        if (tile === null) return null;
        const rect = tile.getBoundingClientRect();
        return { x: side === "left" ? rect.right : rect.left, y: rect.top + rect.height / 2 };
      };
      const misses: string[] = [];
      const check = (what: string, side: string, id: string | null, x: number, y: number) => {
        const at = anchor(side, id);
        const screen = { x: svgRect.left + x * zoom, y: svgRect.top + y * zoom };
        if (at === null) misses.push(`${what}: no ${side} tile ${id}`);
        else if (Math.abs(screen.x - at.x) > tolerance || Math.abs(screen.y - at.y) > tolerance) {
          misses.push(`${what} ${side} ${id}: ${JSON.stringify({ screen, tile: at })}`);
        }
      };
      const number = (element: Element, name: string) => Number(element.getAttribute(name));
      for (const line of svg.querySelectorAll("[data-testid='kid-lesson-match-line']")) {
        const leftId = line.getAttribute("data-left-id");
        const rightId = line.getAttribute("data-right-id");
        check("line start", "left", leftId, number(line, "x1"), number(line, "y1"));
        check("line end", "right", rightId, number(line, "x2"), number(line, "y2"));
      }
      for (const dot of svg.querySelectorAll("[data-testid='kid-lesson-match-dot']")) {
        check("dot", dot.getAttribute("data-side") ?? "", dot.getAttribute("data-item-id"), number(dot, "cx"), number(dot, "cy"));
      }
      return misses;
    });
    expect(misses, `lines and dots on the tiles at ${label}`).toEqual([]);
  }).toPass({ timeout: 5_000 });
}

/** Żadne słowo widocznego tekstu lewych kafelków nie jest rozbite na dwa wiersze (Range per słowo). */
async function splitLeftWords(page: Page): Promise<string[]> {
  return page.getByTestId("kid-lesson-match-left").evaluateAll((tiles) => {
    const split: string[] = [];
    const range = document.createRange();
    for (const tile of tiles) {
      const walker = document.createTreeWalker(tile, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (node.parentElement?.closest(".kid-visually-hidden")) continue;
        for (const word of node.textContent!.matchAll(/\S+/g)) {
          range.setStart(node, word.index);
          range.setEnd(node, word.index + word[0].length);
          if (range.getClientRects().length > 1) split.push(word[0]);
        }
      }
    }
    return split;
  });
}

test("match: two columns, long descriptions and lines fit every form factor", async ({ page }, testInfo) => {
  await installKidUiFixture(page, lessonTaskFixture(ids, deck, [matchTask]));
  await openLessonTask(page, MATCH_VIEWPORTS[0]!, "kid-lesson-match");
  await expect(page.getByTestId("kid-instruction")).toContainText("Połącz pojęcie z jego opisem.");
  await expect(page.getByTestId("kid-lesson-match-left")).toHaveCount(5);
  await expect(page.getByTestId("kid-lesson-match-right")).toHaveCount(7);
  // Dwie pary przed pomiarem, w tym najdłuższy opis: „równik” → LONG_RIGHT, „południk zerowy” → Greenwich.
  await page.getByTestId("kid-lesson-match-left").nth(0).click();
  await page.locator(`[data-testid='kid-lesson-match-right'][data-item-id='${uid(30)}']`).click();
  await page.getByTestId("kid-lesson-match-left").nth(1).click();
  await page.locator(`[data-testid='kid-lesson-match-right'][data-item-id='${uid(32)}']`).click();
  await expect(page.getByTestId("kid-lesson-match-line")).toHaveCount(2);
  await expect(page.getByTestId("kid-lesson-match-dot")).toHaveCount(12);
  // Nazwa dostępna z ukrytym dopowiedzeniem: kafelek w parze.
  await expect(page.getByRole("button", { name: `równik, połączone z: ${LONG_RIGHT}`, exact: true })).toHaveCount(1);

  for (const viewport of MATCH_VIEWPORTS) {
    await page.setViewportSize(viewport);
    const label = `${viewport.width}x${viewport.height}`;
    await expectTargetsReachable(page, viewport, [
      ...Array.from({ length: 5 }, (_, nth) => ({ testId: "kid-lesson-match-left", nth, minHeight: 48 })),
      ...Array.from({ length: 7 }, (_, nth) => ({ testId: "kid-lesson-match-right", nth, minHeight: 48 })),
      { testId: "kid-lesson-check", minHeight: 54 },
    ]);
    await expectButtonsNotClipped(page, "kid-lesson-match-left", label);
    await expectButtonsNotClipped(page, "kid-lesson-match-right", label);
    // Dwie kolumny obok siebie w każdym rozmiarze, z pasem na linie między nimi.
    const left = (await page.getByTestId("kid-lesson-match-left").first().boundingBox())!;
    const right = (await page.getByTestId("kid-lesson-match-right").first().boundingBox())!;
    expect(right.x, `right column beside the left one at ${label}`).toBeGreaterThan(left.x + left.width);
    expect(await splitLeftWords(page), `left words split across lines at ${label}`).toEqual([]);
    await expectLinesOnTiles(page, label);

    // Zaznaczenie wolnego kafelka i jego zdjęcie nie przesuwa kafelków; podpowiedź stoi w zarezerwowanym wierszu.
    const free = page.getByTestId("kid-lesson-match-left").nth(2);
    await free.scrollIntoViewIfNeeded();
    const before = await boxes(page, TILES);
    await free.click();
    await expect(free).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("kid-lesson-match-hint")).toHaveText(messages.kid.lessonMatchPickOther);
    await expect(page.getByTestId("kid-lesson-match-hint")).toBeVisible();
    // Wolny kafelek drugiej kolumny podpowiada, z czym się połączy.
    await expect(page.getByRole("button", { name: "linia biegnąca równolegle do równika, połącz z: równoleżnik", exact: true })).toHaveCount(1);
    await nextFrames(page);
    expectRectsUnchanged(before, await boxes(page, TILES), `select at ${label}`);
    await page.screenshot({ path: testInfo.outputPath(`match-${label}.png`) });
    await free.click();
    await expect(free).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("kid-lesson-match-hint")).toHaveText("");
    await nextFrames(page);
    expectRectsUnchanged(before, await boxes(page, TILES), `deselect at ${label}`);
  }
});

test("match: lines stay on the tiles at scale 1.6, after a resize and after a style change", async ({ page }) => {
  await installKidUiFixture(page, lessonTaskFixture(ids, deck, [matchTask]));
  await openLessonTask(page, { width: 2560, height: 1440 }, "kid-lesson-match");
  await waitForKidScale(page, 1.6);
  for (let index = 0; index < 3; index += 1) {
    await page.getByTestId("kid-lesson-match-left").nth(index).click();
    await page.getByTestId("kid-lesson-match-right").nth(index).click();
  }
  await expect(page.getByTestId("kid-lesson-match-line")).toHaveCount(3);
  await expectLinesOnTiles(page, "2560x1440 at scale 1.6");

  await page.setViewportSize({ width: 390, height: 844 });
  await waitForKidScale(page, 1);
  await nextFrames(page);
  await expectLinesOnTiles(page, "390x844 after the resize");

  // Zmiana wysokości kafelków bez renderu Reacta: współrzędne przelicza tylko ResizeObserver.
  // Selektor o specyficzności reguły compact (`.kid-ui .kid-lesson-block.kid-lesson-pair__item`),
  // inaczej padding 8 px z tej reguły wygrywa i styl nic nie zmienia.
  const heightsBefore = (await boxes(page, TILES)).map((box) => box.height);
  await page.addStyleTag({ content: ".kid-ui .kid-lesson-block.kid-lesson-pair__item { padding-block: 20px; }" });
  await nextFrames(page);
  const heightsAfter = (await boxes(page, TILES)).map((box) => box.height);
  for (const [index, height] of heightsAfter.entries()) {
    expect(height, `tile ${index} grew with the style change`).toBeGreaterThan(heightsBefore[index]! + 10);
  }
  await expectLinesOnTiles(page, "390x844 after the style change");
});

test("group: three bins, eight items and check fit every form factor", async ({ page }, testInfo) => {
  await installKidUiFixture(page, lessonTaskFixture(ids, deck, [groupTask]));
  await openLessonTask(page, VIEWPORTS[0]!, "kid-lesson-group");
  await expect(page.getByTestId("kid-lesson-group-target")).toHaveCount(3);
  await page.getByTestId("kid-lesson-group-item").filter({ hasText: "nietoperz" }).click();
  await page.getByTestId("kid-lesson-group-target").nth(2).click();
  await page.getByTestId("kid-lesson-group-item").filter({ hasText: "jaszczurka zwinka" }).click();
  await expect(page.getByTestId("kid-lesson-group-member")).toHaveCount(2);

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    const label = `${viewport.width}x${viewport.height}`;
    await expectTargetsReachable(page, viewport, [
      ...Array.from({ length: 3 }, (_, nth) => ({ testId: "kid-lesson-group-target", nth, minHeight: 48 })),
      ...Array.from({ length: 2 }, (_, nth) => ({ testId: "kid-lesson-group-member", nth, minHeight: 48 })),
      ...Array.from({ length: 6 }, (_, nth) => ({ testId: "kid-lesson-group-item", nth, minHeight: 48 })),
      { testId: "kid-lesson-check", minHeight: 54 },
    ]);
    await expectButtonsNotClipped(page, "kid-lesson-group-item", label);
    await expectButtonsNotClipped(page, "kid-lesson-group-target", label);
    await page.screenshot({ path: testInfo.outputPath(`group-${label}.png`) });
  }
});

test("match: check sends complete left → right assignments and shows the correct pairs after a mistake", async ({ page }) => {
  const posted = recordAttemptPosts(page);
  const correctText = "równik → najdłuższy równoleżnik; południk zerowy → przechodzi przez Greenwich";
  const kidFixture = lessonTaskFixture(ids, deck, [matchTask], [assignmentAttempt(uid(90), matchTaskId, { kind: "incorrect", correctText })]);
  await installKidUiFixture(page, kidFixture);
  await openLessonTask(page, VIEWPORTS[0]!, "kid-lesson-match");
  const assignments = await pairAndCheck(page, 5, posted);
  expect(assignments.map((entry) => entry.itemId)).toEqual([uid(20), uid(21), uid(22), uid(23), uid(24)]);
  await expect(page.getByText(correctText)).toBeVisible();
  for (const testId of ["kid-lesson-match-left", "kid-lesson-match-right"]) {
    for (const tile of await page.getByTestId(testId).all()) await expect(tile).toBeDisabled();
  }
  // Linie zostają po „Sprawdź”.
  await expect(page.getByTestId("kid-lesson-match-line")).toHaveCount(5);
});
