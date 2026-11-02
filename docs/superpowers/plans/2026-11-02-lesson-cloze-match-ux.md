# „Uzupełnij tekst” i „Połącz w pary” — naturalne stukanie — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Luka w zdaniu staje się jedynym celem stukania w `lesson_cloze`, a `lesson_match` zamienia się w dwie kolumny kafelków łączonych linią — bez zmian kontraktu, serwera i MCP.

**Architecture:** Wszystko w `packages/kid-ui`: nowy czysty stan `PairState` w `assignment-state.ts` (luki zostają na `MatchState`), widoki `LessonClozeView`/`LessonMatchView` przebudowane na `LessonBlockButton`, nowy dekoracyjny `PairLines.tsx` (SVG, geometria z `offset*` w pikselach wewnętrznych). Teksty w `messages.kid`, style w `styles.css`, testy Vitest i Playwright (`mocked`).

**Tech Stack:** React 19, TypeScript strict, Motion (`motion/react`), CSS (tokeny M3 w `.kid-theme, .kid-ui`), Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-02-lesson-cloze-match-ux-design.md` (wersja 2). Numery § w planie odnoszą się do specu.

## Global Constraints

- Bez zmian w `packages/contracts/src/kid.ts`, serwerze, migracjach, `integrations/`, `SKILL.md`; nie zmieniamy `lessonMatchInstruction` ani `lessonClozeInstruction`.
- Przypisania wysyłane jak dziś: pary — lewy → prawy w kolejności lewej kolumny; luki — luka → słowo w kolejności luk.
- Kid UI: bez Mantine, bez surowych `<button>/<input>` (kafelki i luki to `LessonBlockButton`), bez literałów koloru, rozmiaru i wagi fontu ani promienia poza blokiem tokenów; bez surowych `vh/dvh/svh/vw`; bez kursywy (`tests/kid-design-tokens.test.ts`).
- Ruch tylko `transform`/`opacity` przez `m.*`; bez propsa `layout`, bez `pathLength`.
- Cele dotykowe ≥ 48 px; brak poziomego przepełnienia od 320 px.
- Teksty UI po polsku, dokładnie jak w specu (§4.1, §5.2, §6).
- Nazwy dostępne z treści, bez `aria-label` na kafelkach i lukach; `lang={contentLocale}` tylko na spanie z tekstem materiału.
- Język stanów (§3): aktywny = `primary`/`on-primary`; gotowy = `kid-lesson-block--placed`.

## Review Focus

1. Stuknięcie w drugiej kolumnie kafelka, który już ma parę, gdy inny jest zaznaczony — oczekiwane: stara para znika, nowa powstaje, zwolniony kafelek jest wolny (Task 1, test „replaces pairs of both tiles”; Task 4, test widoku).
2. Linie po zmianie rozmiaru okna lub skali `zoom` (np. 1,6) — oczekiwane: końce linii na kropkach przy kafelkach (Task 6, pomiar końców przy 2560×1440 i po `setViewportSize`).
3. Długie wyrażenie z banku w luce na 320 px — oczekiwane: zawija się w przycisku, nic nie wychodzi poza kolumnę (Task 5, wariant 320×568 z „światła słonecznego”).
4. Ponowna próba po błędzie — oczekiwane: pary/luki i zaznaczenie wyczyszczone, fokus na pierwszym kafelku/luce, linie zniknęły (Task 2 i Task 4, testy retry).
5. Wysłanie próby z zaznaczonym dystraktorem — oczekiwane: zaznaczenie znika, podpowiedź znika, kafelki wyłączone (Task 4, test „check clears selection”).

---

## File Structure

| Plik | Odpowiedzialność |
| --- | --- |
| `packages/kid-ui/src/exercises/lesson/assignment-state.ts` | + `PairState` i funkcje par (czyste) |
| `packages/kid-ui/src/exercises/lesson/PairLines.tsx` (nowy) | SVG z kropkami i liniami, pomiar `offset*`, `ResizeObserver` |
| `packages/kid-ui/src/exercises/lesson/LessonClozeView.tsx` | luki jako przyciski w tekście, bank, podpowiedź zmiany |
| `packages/kid-ui/src/exercises/lesson/LessonMatchView.tsx` | dwie kolumny, `PairLines`, podpowiedź |
| `packages/kid-ui/src/exercises/lesson/AssignmentPool.tsx` | − `AssignmentSlot` |
| `packages/kid-ui/src/exercises/lesson/LessonGroupView.tsx` | tylko nowa klasa puli |
| `packages/kid-ui/src/motion/kid-motion.ts` | + `kidFadeTransition` |
| `packages/kid-ui/src/styles.css` | style luk, par, puli; token `--kid-pair-gutter` |
| `packages/contracts/src/messages.ts` | komunikaty §6 |
| `docs/architecture.md` | §19, dwa punkty |
| testy | `assignment-state.test.ts`, `lesson-views.test.tsx`, `PairLines.test.tsx` (nowy), E2E w `tests/e2e/` |

---

### Task 1: Czysty stan par (`PairState`)

**Files:**
- Modify: `packages/kid-ui/src/exercises/lesson/assignment-state.ts`
- Test: `packages/kid-ui/src/exercises/lesson/assignment-state.test.ts`

**Interfaces:**
- Produces (eksportowane z `assignment-state.ts`):
  ```ts
  export type PairSide = "left" | "right";
  export interface PairState {
    readonly left: readonly LessonItem[];
    readonly right: readonly LessonItem[];
    readonly pairs: ReadonlyMap<string, string>; // id lewego → id prawego
    readonly selected: { readonly side: PairSide; readonly id: string } | null;
  }
  export function pairState(left: readonly LessonItem[], right: readonly LessonItem[]): PairState;
  export function tapPairItem(state: PairState, side: PairSide, id: string): PairState;
  export function clearPairSelection(state: PairState): PairState;
  export function pairOf(state: PairState, side: PairSide, id: string): LessonItem | null;
  export function pairComplete(state: PairState): boolean;
  export function pairAssignments(state: PairState): Assignment[];
  ```

- [ ] **Step 1: Napisz testy** w nowym `describe("stan „Połącz linią”")`, z `start = pairState([l1,l2,l3], [r1,r2,r3,rx])`:
  - `"zaznacza dowolny kafelek bez zmiany par"`: `tapPairItem(start,"right","r2").selected` = `{side:"right",id:"r2"}`, `pairs.size` = 0;
  - `"ponowne stuknięcie zaznaczonego zdejmuje zaznaczenie"`: zaznacz l1, stuknij l1 → `selected` = `null`;
  - `"stuknięcie w tej samej kolumnie przenosi zaznaczenie, pary bez zmian"`: para l1–r1, zaznacz l2, stuknij l1 → `selected` = l1, `pairOf(s,"left","l1")?.id` = `"r1"`;
  - `"stuknięcie w drugiej kolumnie łączy w obu kierunkach"`: (l1 → r2) i (r3 → l2) → `pairs` = `{l1:r2, l2:r3}`, `selected` = `null`;
  - `"replaces pairs of both tiles"`: pary l1–r1 i l2–r2; zaznacz l1, stuknij r2 → `pairs` = `{l1:r2}`; `pairOf(s,"right","r1")` = `null`; `pairOf(s,"left","l2")` = `null`;
  - `"nieznane id i strona bez elementu nie zmieniają stanu"`: `tapPairItem(start,"left","r1")` `toBe(start)`; `tapPairItem(start,"right","nope")` `toBe(start)`;
  - `"clearPairSelection zdejmuje tylko zaznaczenie"`;
  - `"komplet przy wolnym dystraktorze; przypisania w kolejności lewej kolumny"`: połącz l3–r3, l1–r1, l2–rx → `pairComplete` = `true`, `pairAssignments` = `[{itemId:"l1",targetId:"r1"},{itemId:"l2",targetId:"rx"},{itemId:"l3",targetId:"r3"}]`; przy dwóch parach `pairComplete` = `false`.

- [ ] **Step 2: Uruchom — FAIL** (brak eksportów)
  Run: `corepack pnpm vitest run packages/kid-ui/src/exercises/lesson/assignment-state.test.ts`

- [ ] **Step 3: Zaimplementuj funkcje** w `assignment-state.ts` według tabeli §5.1 specu; `pairs` jako nowy `Map` przy każdej zmianie. Komentarz JSDoc w stylu pliku (po polsku, z odesłaniem do specu).

- [ ] **Step 4: Uruchom — PASS** (to samo polecenie; stare testy `MatchState`/`GroupState` też przechodzą)

- [ ] **Step 5: Commit** `feat(kid-ui): czysty stan łączenia w pary linią`

---

### Task 2: „Uzupełnij tekst” — luka w zdaniu jako przycisk

**Files:**
- Modify: `packages/kid-ui/src/exercises/lesson/LessonClozeView.tsx`, `LessonGroupView.tsx` (klasa puli), `packages/kid-ui/src/styles.css` (sekcje „Uzupełnij tekst”, „Połącz w pary”/pule), `packages/contracts/src/messages.ts`
- Test: `packages/kid-ui/src/exercises/lesson/lesson-views.test.tsx`

**Interfaces:**
- Consumes: istniejące `matchState`, `selectSlot`, `placeRight`, `matchPool`, `rightOf`, `matchComplete`, `matchAssignments`; `AssignmentPool`, `AssignmentCheckButton`, `LessonBlockButton`.
- Produces: klasa puli `kid-lesson-assign__pool` (luki i grupy; Task 4 jej nie używa), klasy `kid-lesson-cloze__gap`, `--active`, `--filled`, `kid-lesson-cloze__gap-mark`, `kid-lesson-cloze__pool`; komunikaty:
  - `lessonClozeGapPrefix: "Luka {n}:"`
  - `lessonClozeGapEmptyLabel: "Luka {n}: pusta, wybierz słowo"`
  - `lessonClozeChangeHint: "Dotknij luki, żeby zmienić słowo."`

- [ ] **Step 1: Przepisz testy cloze** w `lesson-views.test.tsx` (zastępują trzy dzisiejsze przypadki cloze; `clozeTask()` bez zmian):
  - `"cloze: luki są przyciskami w tekście; słowo trafia do aktywnej luki, a aktywna przechodzi dalej"`: `text.querySelectorAll("button")` ma 2; brak `kid-lesson-cloze-slot`; pierwsza `kid-lesson-cloze-gap` ma `aria-pressed="true"` i zawiera `.kid-lesson-cloze__gap-mark` z „?”; po kliknięciu „dwutlenek węgla” pierwsza luka ma klasę `kid-lesson-cloze__gap--filled` i tekst „dwutlenek węgla”, druga `aria-pressed="true"`; nazwa dostępna pustej luki (`textContent` ukrytego spanu) = „Luka 2: pusta, wybierz słowo”; po „wodę” „Sprawdź” aktywne i wysyła `[{itemId:id(3),targetId:id(7)},{itemId:id(4),targetId:id(5)}]`;
  - `"cloze: podpowiedź zmiany tylko przy komplecie z wolnymi słowami; bank wtedy wyłączony"`: przed kompletem brak `kid-lesson-cloze-hint`; po dwóch słowach hint = „Dotknij luki, żeby zmienić słowo.”, opcja „tlen” `disabled`;
  - `"cloze: stuknięcie wypełnionej luki oddaje słowo; dok i busy wyłączają luki i bank"`: po „tlen” i kliknięciu pierwszej luki bank ma 3 opcje; `rerender` z `dock` → wszystkie `kid-lesson-cloze-gap` i opcje `disabled`; osobno `busy: true` → to samo;
  - `"cloze: po retry luki są puste, a fokus stoi na pierwszej luce"` — wzorem istniejących testów retry w pliku (zmiana `dock` → `undefined`): `document.activeElement` = pierwsza `kid-lesson-cloze-gap`;
  - zamień `"cloze marks text segments, filled gaps, filled slots and the word bank"` na `"cloze marks text segments, the word inside a filled gap and the word bank; gap buttons stay unmarked"`: segmenty i opcje `lang=en`; po „have” span ze słowem w pierwszej luce ma `lang=en`, a sam przycisk luki nie ma atrybutu `lang`.

- [ ] **Step 2: Uruchom — FAIL**
  Run: `corepack pnpm vitest run packages/kid-ui/src/exercises/lesson/lesson-views.test.tsx -t cloze`

- [ ] **Step 3: Przebuduj `LessonClozeView`**: w tekście dla każdej luki `LessonBlockButton` (`className` `kid-lesson-block kid-lesson-cloze__gap` + modyfikator, `data-testid="kid-lesson-cloze-gap"`, `aria-pressed={active}`, `disabled`, `onClick` = `selectSlot` + `handlers.onEdit()`). Treść: wypełniona — `<span className="kid-visually-hidden">{format(lessonClozeGapPrefix,{n})} </span><span lang={contentLocale}>{word}</span>`; pusta — `<span className="kid-visually-hidden">{format(lessonClozeGapEmptyLabel,{n})}</span>` plus przy aktywnej `<span className="kid-lesson-cloze__gap-mark" aria-hidden="true">?</span>`. Usuń listę miejsc, numery, `kid-lesson-cloze-hint` z „Które słowo…”; dodaj pod bankiem `kid-hint` `kid-lesson-cloze-hint` (`aria-live="polite"`) z `lessonClozeChangeHint`, gdy `complete && pool.length > 0 && !disabled`. Pula: `className="kid-lesson-assign__pool kid-lesson-cloze__pool"`. Popraw komentarz nagłówkowy widoku.

- [ ] **Step 4: Style** w `styles.css`:
  - `.kid-lesson-match__pool, .kid-lesson-group__pool` → `.kid-lesson-assign__pool` (zmień klasę także w `LessonGroupView.tsx`);
  - `.kid-ui .kid-lesson-cloze__gap`: `display: inline-flex; vertical-align: middle; align-items: center; justify-content: center; min-height: 48px; min-inline-size: 4.5em; max-inline-size: 100%; margin-inline: 2px; padding: 4px 12px; line-height: 1.2; overflow-wrap: break-word; text-align: center` + pusta: `border-style: dashed` na dole wg §4.2 (stan wolny z §3);
  - stan aktywny (`.kid-ui .kid-lesson-cloze__gap--active`, także `:active`) i wypełniony (`--filled` = wygląd `kid-lesson-block--placed`) wg tabeli §3;
  - `.kid-ui .kid-lesson-cloze__text`: `line-height` 2 (wstępnie; Task 5 może obniżyć po pomiarze, nie wyżej niż 2);
  - usuń reguły `__gap-number`, `__slots`, `__slot-row`;
  - `@media (max-height: 479px) and (min-width: 600px)`: `.kid-lesson-cloze { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); align-items: start; }`.

- [ ] **Step 5: Komunikaty**: dodaj trzy z Interfaces; usuń `lessonClozeEmptySlot`, `lessonClozeGapEmpty`, `lessonClozeGapFilled`, `lessonClozeChooseSlot`, `lessonClozeRemove`, `lessonClozeActiveHint`, `lessonClozeGaps`, `lessonClozeText`. Sprawdź: `git grep -n "lessonClozeEmptySlot\|lessonClozeGapEmpty\b\|lessonClozeGapFilled\|lessonClozeChooseSlot\|lessonClozeRemove\|lessonClozeActiveHint\|lessonClozeGaps\|lessonClozeText"` → brak trafień.

- [ ] **Step 6: Uruchom — PASS**
  Run: `corepack pnpm vitest run packages/kid-ui tests/kid-design-tokens.test.ts tests/kid-no-mantine.test.ts`
  Expected: wszystko PASS (grupy bez zmian zachowania).

- [ ] **Step 7: Commit** `feat(kid-ui): luka w zdaniu jako cel stukania w „Uzupełnij tekst”`

---

### Task 3: `PairLines` — kropki i linie

**Files:**
- Create: `packages/kid-ui/src/exercises/lesson/PairLines.tsx`, `packages/kid-ui/src/exercises/lesson/PairLines.test.tsx`
- Modify: `packages/kid-ui/src/motion/kid-motion.ts`, `packages/kid-ui/src/styles.css`

**Interfaces:**
- Consumes: `PairState`, `PairSide` (Task 1).
- Produces:
  ```ts
  export function PairLines(props: {
    state: PairState;
    /** Kontener `kid-lesson-pair` (position: relative) — od niego liczone są pozycje. */
    containerRef: RefObject<HTMLElement | null>;
    /** Kafelek o danym id i stronie, rejestrowany przez widok (ref callback). */
    tileOf: (side: PairSide, id: string) => HTMLElement | null;
  }): ReactElement;
  export const kidFadeTransition: Transition; // w kid-motion.ts: { duration: 0.18, ease: "easeOut" }
  ```
  SVG: `data-testid="kid-lesson-match-lines"`, `aria-hidden="true"`, klasa `kid-lesson-pair__lines`. Kropka: `<circle data-testid="kid-lesson-match-dot" data-side data-item-id className="kid-lesson-pair__dot[ --paired| --selected]" r={selected ? 8 : 6}>`. Linia: `<m.line data-testid="kid-lesson-match-line" data-left-id data-right-id className="kid-lesson-pair__line">`.

- [ ] **Step 1: Testy** w `PairLines.test.tsx` (render z `renderKid` lub zwykłym `render` w `LazyMotion`, jak inne testy komponentów pakietu; kafelki jako zwykłe `div` z refami):
  - `"rysuje kropkę dla każdego kafelka i linię dla każdej pary"`: stan 3 lewe / 4 prawe, pary l1–r2 i l3–r1 → 7 kropek, 2 linie z `data-left-id`/`data-right-id` = `["l1","r2"]`, `["l3","r1"]`;
  - `"kropki w parze i zaznaczona mają swoje klasy i promień"`: zaznaczony r3 → jego kropka ma `--selected` i `r="8"`; kropki l1 i r2 mają `--paired`; pozostałe `r="6"`;
  - `"działa bez ResizeObserver (jsdom)"`: `vi.stubGlobal("ResizeObserver", undefined)`, render nie rzuca, współrzędne = `"0"`;
  - `"przy ograniczeniu ruchu linia nie startuje od przezroczystości"`: mock `useReducedMotion` → `true` (wzorem testów `ActionButton`), linia nie ma `opacity: 0` w stylu inline.

- [ ] **Step 2: Uruchom — FAIL**
  Run: `corepack pnpm vitest run packages/kid-ui/src/exercises/lesson/PairLines.test.tsx`

- [ ] **Step 3: Zaimplementuj `PairLines`**:
  - `anchorOf(tile, side, container)`: suma `offsetLeft/offsetTop` po `offsetParent` aż do `container`; x = lewa strona: `left + offsetWidth`, prawa: `left`; y = `top + offsetHeight / 2`.
  - Funkcja `layout()` zapisuje `cx/cy` kropek i `x1/y1/x2/y2` linii **przez refy i `setAttribute`** (bez `setState`); wołana w `useLayoutEffect` po każdym renderze oraz w callbacku `ResizeObserver` obserwującym kontener i wszystkie kafelki (nie SVG); strażnik `typeof ResizeObserver === "undefined"`; `disconnect` przy odmontowaniu.
  - Linia: `initial={reduce ? false : { opacity: 0 }}`, `animate={{ opacity: 1 }}`, `transition={kidFadeTransition}`, `reduce = useReducedMotion()`.

- [ ] **Step 4: Style**: `.kid-lesson-pair__lines { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }`; `__line { stroke: var(--md-sys-color-primary); stroke-width: 4; stroke-linecap: round; }`; `__dot { fill: var(--md-sys-color-surface); stroke: var(--md-sys-color-outline); stroke-width: 2; }`; `__dot--paired, __dot--selected { fill: var(--md-sys-color-primary); stroke: var(--md-sys-color-primary); }`.

- [ ] **Step 5: Uruchom — PASS** (polecenie z kroku 2 + `tests/kid-design-tokens.test.ts`)

- [ ] **Step 6: Commit** `feat(kid-ui): warstwa linii i kropek do łączenia w pary`

---

### Task 4: „Połącz w pary” — dwie kolumny z liniami

**Files:**
- Modify: `packages/kid-ui/src/exercises/lesson/LessonMatchView.tsx`, `AssignmentPool.tsx` (usuń `AssignmentSlot`), `packages/kid-ui/src/styles.css`, `packages/contracts/src/messages.ts`
- Test: `packages/kid-ui/src/exercises/lesson/lesson-views.test.tsx`

**Interfaces:**
- Consumes: Task 1 (`pairState`, `tapPairItem`, `clearPairSelection`, `pairOf`, `pairComplete`, `pairAssignments`), Task 3 (`PairLines`).
- Produces: klasy `kid-lesson-pair`, `__column`, `__item`, `__item--selected`, `__hint`; token `--kid-pair-gutter`; komunikaty:
  - `lessonMatchLeft: "Słowa do połączenia"`
  - `lessonMatchPickOther: "Teraz dotknij tego, co pasuje."`
  - `lessonMatchPairedWith: ", połączone z:"`
  - `lessonMatchConnectWith: ", połącz z:"`

- [ ] **Step 1: Przepisz testy match** (zastępują dwa dzisiejsze i `"match marks the left column only…"`); dane jak w dzisiejszym pierwszym teście (3 lewe, 4 prawe):
  - `"match: łączenie od lewej i od prawej, „Sprawdź” przy komplecie z wolnym dystraktorem"`: klik „równik” → ma `aria-pressed="true"` i klasę `kid-lesson-pair__item--selected`, `kid-lesson-match-hint` = „Teraz dotknij tego, co pasuje.”; klik „dzieli półkule” → 1 `kid-lesson-match-line`, brak tekstu podpowiedzi; klik „łączy bieguny” potem „południk”; klik „biegun”, „koniec osi” → „Sprawdź” aktywne, wysyła `[{id3→id7},{id4→id6},{id5→id8}]`;
  - `"match: nowa para zastępuje stare pary obu kafelków"`: pary a–x, b–y; klik a, klik y → linie: tylko `a`–`y`; kafelek `b` bez `kid-lesson-block--placed`;
  - `"match: wysłanie czyści zaznaczenie; dok i busy wyłączają kafelki"`: komplet, klik dystraktor „nad morzem” (zaznaczony), klik „Sprawdź” → żaden kafelek nie ma `aria-pressed="true"`, hint pusty; `rerender` z `dock` → wszystkie kafelki `disabled`; osobno `busy`;
  - `"match: po retry pary znikają, a fokus stoi na pierwszym kafelku"`;
  - `"match marks the text of the left column only; tiles stay unmarked"` (`contentLocale: en`): spany tekstu w `kid-lesson-match-left` mają `lang=en`, przyciski `kid-lesson-match-left`/`-right` bez `lang`, spany w `kid-lesson-match-right` bez `lang`; po parze dog–pies ukryte dopowiedzenie w „dog” zawiera „, połączone z:” i „pies”.

- [ ] **Step 2: Uruchom — FAIL**
  Run: `corepack pnpm vitest run packages/kid-ui/src/exercises/lesson/lesson-views.test.tsx -t match`

- [ ] **Step 3: Przebuduj `LessonMatchView`**: kontener `div.kid-lesson-pair` `data-testid="kid-lesson-match"` (ref), w nim dwie listy `div.kid-lesson-pair__column` (`role="list"`, `aria-label` `lessonMatchLeft` / `lessonMatchPool`), kolumny w `grid-column: 1` i `3` (środkowa kolumna siatki to pas na linie), kafelki `div[role=listitem] > LessonBlockButton` (`kid-lesson-block kid-lesson-pair__item` + `kid-lesson-block--placed` / `--selected`, `data-testid` `kid-lesson-match-left`/`-right`, `aria-pressed`, `data-item-id={item.id}`, ref callback do mapy `side:id → element`). Treść kafelka: `<span lang={side==="left" ? contentLocale : undefined}>{text}</span>` + ukryte `lessonMatchPairedWith` i odpowiednik (w jego `lang`) albo `lessonMatchConnectWith` i zaznaczony, wg §5.6. Pod siatką `p.kid-hint.kid-lesson-pair__hint` `data-testid="kid-lesson-match-hint"` `aria-live="polite"` — zawsze w DOM, tekst tylko przy `selected && !disabled`. „Sprawdź”: `setState(clearPairSelection)` przed `handlers.onAnswerAssignment(pairAssignments(state))`. `useRetryReset` → `pairState(left, right)`. `PairLines` jako pierwsze dziecko kontenera. Zaktualizuj komentarz nagłówkowy.

- [ ] **Step 4: Style** (zastępują reguły `.kid-lesson-match*`, reguły `.kid-lesson-group*` nietknięte poza wydzieleniem wspólnego `.kid-lesson-match, .kid-lesson-group` → `.kid-lesson-group`):
  - token w bloku: `--kid-pair-gutter: 48px;` i poza blokiem `@media (min-width: 600px) { :root:has(.kid-ui), .kid-theme, .kid-ui { --kid-pair-gutter: 72px; } }` (wzorzec z `styles.css` ok. linii 199);
  - `.kid-lesson-pair { position: relative; display: grid; grid-template-columns: minmax(min(7.5em, 42%), 2fr) var(--kid-pair-gutter) minmax(0, 3fr); width: 100%; }`; kolumny w `grid-column: 1` i `3`, `display: flex; flex-direction: column; justify-content: space-around; gap: 10px; min-width: 0`;
  - `.kid-ui .kid-lesson-pair__item { width: 100%; overflow-wrap: break-word; }`; compact `@media (max-width: 599px)`: `padding: 8px 10px; font-size: var(--kid-type-title-sm-size);`;
  - stan aktywny `.kid-ui .kid-lesson-block.kid-lesson-pair__item--selected, .kid-ui .kid-lesson-block.kid-lesson-pair__item--selected:active` wg §3;
  - `.kid-lesson-pair__hint { min-height: 1.5em; }` (`.kid-hint` ma już `font-size: var(--kid-type-title-sm-size)` i `text-align: center`; `em` liczy się od tego rozmiaru).

- [ ] **Step 5: Sprzątanie**: usuń `AssignmentSlot` z `AssignmentPool.tsx` (i jego klasy `.kid-lesson-match__slot*`); komunikaty: dodaj cztery z Interfaces, usuń `lessonMatchEmptySlot`, `lessonMatchChooseSlot`, `lessonMatchActiveHint`, `lessonMatchPairs`, `lessonMatchPlace`, `lessonMatchRemove`. `git grep -n "AssignmentSlot\|lessonMatchEmptySlot\|lessonMatchChooseSlot\|lessonMatchActiveHint\|lessonMatchPairs\|lessonMatchPlace\|lessonMatchRemove\|kid-lesson-match__"` → brak trafień poza docs.

- [ ] **Step 6: Uruchom — PASS**
  Run: `corepack pnpm vitest run packages/kid-ui tests/kid-design-tokens.test.ts tests/kid-no-mantine.test.ts` i `corepack pnpm typecheck`

- [ ] **Step 7: Commit** `feat(kid-ui): „Połącz w pary” jako dwie kolumny łączone linią`

---

### Task 5: E2E — „Uzupełnij tekst” i fixture'y przepełnienia

**Files:**
- Modify: `tests/e2e/lesson-cloze-layout.spec.ts`, `tests/e2e/kid-large-screen.spec.ts`, `tests/e2e/helpers/kid-fixtures.ts`, `tests/e2e/lesson-sentence-audio.spec.ts`, ewentualnie `packages/kid-ui/src/styles.css` (`line-height` z pomiaru)

**Interfaces:**
- Consumes: test id z Task 2 (`kid-lesson-cloze-gap`, `-option`, `-pool`, `-text`, `-hint`), klasa `.kid-lesson-cloze__gap-mark`.

- [ ] **Step 1: `lesson-cloze-layout.spec.ts`**: `VIEWPORTS` + `{ width: 320, height: 568 }`; w `expectClozeGeometry` zamiast slotów cele `kid-lesson-cloze-gap` (4, `minHeight: 48`); `expectButtonsNotClipped(page, "kid-lesson-cloze-gap", label)`; nowa asercja: dla każdej luki prostokąty tekstu z `Range` sąsiednich wierszy (wiersze nad i pod luką) nie przecinają prostokąta luki; zamień `expect(...locator("button")).toHaveCount(0)` na `toHaveCount(4)` i usuń liczenie slotów; w teście głównym wstaw najpierw „światła słonecznego” i sprawdź na 320×568, że prostokąt tej luki mieści się w prostokącie `kid-lesson-cloze-text`; przy 844×390: po wstawieniu dwóch słów aktywna luka i `kid-lesson-cloze-pool` są jednocześnie w viewporcie (bez przewijania).

- [ ] **Step 2: Fixture'y przepełnienia**: w `helpers/kid-fixtures.ts` `clozeTask` wydłuż segmenty tekstu (te same luki i bank, dłuższe zdania wokół — ok. +250 px przy 1280×800), aż przypadki „the material scrolls before the verdict” (1280×600, 1536×730), tablet 1024×1366 `fits: "space"` w `kid-large-screen.spec.ts` i „overflowing cloze” w `lesson-sentence-audio.spec.ts` (tam własny `clozeTask` ok. linii 822 — wydłuż analogicznie, zachowując `clozeSolution`) przechodzą **bez zmian asercji**.

- [ ] **Step 3: `kid-large-screen.spec.ts`**: w `READING_MEASURE_CASES` dla „cloze text” `exclude: ".kid-lesson-cloze__gap-mark"`; uruchom i zostaw zakres 45–65 znaków bez zmian (jeśli wypada poza, obniż `line-height`/`min-inline-size` luki w CSS, nie zakres testu).

- [ ] **Step 4: Uruchom — PASS**
  Run: `UMIEM_E2E_WEB_MODE=dev pnpm exec playwright test tests/e2e/lesson-cloze-layout.spec.ts tests/e2e/kid-large-screen.spec.ts tests/e2e/lesson-sentence-audio.spec.ts --project=mocked`
  Expected: wszystkie PASS (zrzuty `screenshot:` pominięte bez `UMIEM_E2E_SCREENSHOTS`).

- [ ] **Step 5: Commit** `test(e2e): geometria luk w zdaniu i dłuższe fixture'y przepełnienia`

---

### Task 6: E2E — „Połącz w pary” z liniami

**Files:**
- Modify: `tests/e2e/helpers/lesson-assignment-task.ts`, `tests/e2e/lesson-assignment-layout.spec.ts`

**Interfaces:**
- Consumes: test id z Task 3–4 (`kid-lesson-match`, `-left`, `-right`, `-lines`, `-dot`, `-line`, `-hint`), `waitForKidScale(page, 1.6)`, `expectRectsUnchanged`, `boxes` z `helpers/kid-frame.ts`.
- Produces:
  ```ts
  /** Łączy i-ty lewy z i-tym prawym kafelkiem (kolejność widoku), klika „Sprawdź”, zwraca wysłane przypisania. */
  export async function pairAndCheck(page: Page, count: number, posted: unknown[]): Promise<{ itemId: string; targetId: string }[]>;
  /** Końce linii i środki kropek na ekranie vs środki krawędzi kafelków; tolerancja w px ekranu. */
  async function expectLinesOnTiles(page: Page, label: string, tolerance = 2): Promise<void>; // w specu
  ```

- [ ] **Step 1: Helper `pairAndCheck`** w `lesson-assignment-task.ts`: dla `i < count` klik `kid-lesson-match-left` nth(i), potem `kid-lesson-match-right` nth(i); „Sprawdź” wyłączone przed ostatnią parą; dalej jak `tapPoolAndCheck` (jeden POST, `modality: "assignment"`, unikalne `targetId`).

- [ ] **Step 2: `expectLinesOnTiles`** w specu: w `page.evaluate` dla każdej `kid-lesson-match-line` weź `x1..y2` (atrybuty), prostokąt SVG i `svg.currentCSSZoom`; punkt ekranu = `svgRect.left + x * zoom`, `svgRect.top + y * zoom`; porównaj z prawym-środkiem prostokąta kafelka `kid-lesson-match-left[data-item-id=<data-left-id>]` i lewym-środkiem `kid-lesson-match-right[data-item-id=<data-right-id>]`; to samo dla `cx/cy` kropek (`data-side`, `data-item-id`).

- [ ] **Step 3: Przepisz test geometrii par**: `VIEWPORTS` + `{ width: 320, height: 568 }`; połącz dwie pary (w tym `LONG_RIGHT`); w pętli viewportów: cele `kid-lesson-match-left` ×5 i `-right` ×7 z `minHeight: 48`, `expectButtonsNotClipped` dla obu, kolumny obok siebie (`right.x > left.x + left.width`), żadne słowo kafelków lewej kolumny nie jest rozbite na dwa wiersze (`Range` na każdym słowie → `getClientRects().length === 1`), `expectLinesOnTiles`; przełączenie zaznaczenia (klik i ponowny klik kafelka) nie zmienia `boxes(page, "[data-testid='kid-lesson-match-left'], [data-testid='kid-lesson-match-right']")` (`expectRectsUnchanged`).

- [ ] **Step 4: Test skali**: `"match: lines stay on the tiles at scale 1.6 and after a resize"` — 2560×1440, `waitForKidScale(page, 1.6)`, trzy pary, `expectLinesOnTiles`; `setViewportSize(1280×800)`, `waitForKidScale(page, 1)` (min(1280/840, 800/900) < 1 → skala 1), `expectLinesOnTiles`.

- [ ] **Step 5: Test „after a mistake”** przez `pairAndCheck(page, 5, posted)`; asercje bez zmian (kolejność `itemId`, `correctText` widoczny); dodatkowo kafelki `disabled`.

- [ ] **Step 6: Uruchom — PASS**
  Run: `UMIEM_E2E_WEB_MODE=dev pnpm exec playwright test tests/e2e/lesson-assignment-layout.spec.ts --project=mocked`

- [ ] **Step 7: Commit** `test(e2e): geometria łączenia w pary i linii`

---

### Task 7: Dokumentacja i pełna weryfikacja

**Files:**
- Modify: `docs/architecture.md` (punkty „Pary i grupy (Etap 7)” i „Uzupełnij tekst (Etap 10)” w §19), status specu

- [ ] **Step 1: `docs/architecture.md`**: w „Uzupełnij tekst” zastąp „`LessonClozeView` z luką w tekście jako znacznikiem (bez przycisku) … jedna kolumna na każdym ekranie” opisem: luka jako przycisk w tekście, bank pod tekstem (obok w niskim landscape), stan `assignment-state.ts`; w „Pary i grupy” zastąp „widoki ze stukaniem na `LessonBlockButton`” dla par: dwie kolumny łączone linią (`PairLines`, geometria `offset*`), stan `PairState`; odesłanie do specu 2026-11-02.

- [ ] **Step 2: Status specu** → „zaimplementowany” + krótka sekcja „Ustalenia z implementacji” (np. ostateczny `line-height`, decyzje z Task 5–6).

- [ ] **Step 3: Pełne sprawdzenie**
  Run: `corepack pnpm typecheck`, `corepack pnpm test:unit`, `corepack pnpm test:e2e:shards`
  Expected: wszystko PASS; w raporcie liczba testów `mocked`/`real`. Testy integracyjne nie są potrzebne (brak zmian serwera) — odnotuj to.

- [ ] **Step 4: Commit** `docs: Kid UI luk i par w architekturze`
