# „Uzupełnij tekst” i „Połącz w pary” — naturalne stukanie — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Luka w zdaniu staje się jedynym celem stukania w `lesson_cloze`, a `lesson_match` zamienia się w dwie kolumny kafelków łączonych linią — bez zmian kontraktu, serwera i MCP.

**Architecture:** Wszystko w `packages/kid-ui`: nowy czysty stan `PairState` w `assignment-state.ts` (luki zostają na `MatchState`), widoki `LessonClozeView`/`LessonMatchView` przebudowane na `LessonBlockButton`, nowy dekoracyjny `PairLines.tsx` (SVG bez `viewBox`, geometria z `offset*` w pikselach wewnętrznych). Teksty w `messages.kid`, style w `styles.css`, testy Vitest i Playwright (`mocked`).

**Tech Stack:** React 19, TypeScript strict, Motion (`motion/react`), CSS (tokeny M3 w `.kid-theme, .kid-ui`), Vitest + Testing Library (`renderKid`, `makeExerciseProps`), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-02-lesson-cloze-match-ux-design.md` (wersja 3). Numery § odnoszą się do specu. Plan po recenzji trzech krytyków (wykonalność, pokrycie specu i UX, ważność testów).

## Global Constraints

- Bez zmian w `packages/contracts/src/kid.ts`, serwerze, migracjach, `integrations/`, `SKILL.md`; nie zmieniamy `lessonMatchInstruction` ani `lessonClozeInstruction`.
- Przypisania wysyłane jak dziś: pary — lewy → prawy w kolejności lewej kolumny; luki — luka → słowo w kolejności luk.
- Kid UI: bez Mantine, bez surowych `<button>/<input>` (kafelki i luki to `LessonBlockButton`), bez literałów koloru, rozmiaru i wagi fontu ani promienia poza blokiem tokenów; bez surowych `vh/dvh/svh/vw`; bez kursywy (`tests/kid-design-tokens.test.ts`).
- Ruch tylko `transform`/`opacity` przez `m.*` i wartości z `kid-motion.ts`; bez `layout`, bez `pathLength`.
- Cele ≥ 48 px; brak poziomego przepełnienia od 320 px.
- Teksty UI dokładnie jak w specu (§4.1, §5.2, §6) i w Interfaces tasków.
- Nazwy dostępne z treści, bez `aria-label` na lukach i kafelkach; `lang={contentLocale}` tylko na spanie z tekstem materiału; przycisk bez `lang`.
- Język stanów (§3): aktywny = `primary`/`on-primary`; gotowy = `kid-lesson-block--placed`. Selektory stanów muszą wygrywać z `.kid-ui .kid-lesson-block:active` (`styles.css` ok. 2614) — ta sama specyficzność i później w pliku albo wyższa.
- Nowe reguły kafelków/luk stoją w `styles.css` **po** `.kid-ui .kid-lesson-block` (ma `overflow-wrap: anywhere`), żeby `overflow-wrap: break-word` wygrało.
- Polecenia E2E w PowerShell: `$env:UMIEM_E2E_WEB_MODE='dev'; pnpm exec playwright test <pliki> --project=mocked` (wymaga Dockera — global setup). W Bash: `UMIEM_E2E_WEB_MODE=dev pnpm exec playwright test …`.

## Review Focus

1. Stuknięcie w drugiej kolumnie kafelka, który ma już parę, gdy inny jest zaznaczony — stara para znika, powstaje nowa, zwolniony kafelek jest wolny (Task 1 „replaces pairs of both tiles”; Task 4 test widoku).
2. Linie po zmianie układu bez renderu Reacta (zmiana rozmiaru okna, styl, skala 1,6) — końce linii na kropkach przy kafelkach (Task 6, `expectLinesOnTiles` z `toPass` po resize do 390×844 i po `addStyleTag`).
3. Niski landscape po przewinięciu do dalszej luki — aktywna luka i bank jednocześnie widoczne (Task 5, 844×390 po trzech słowach).
4. Ponowna próba po błędzie — pary/luki i zaznaczenie wyczyszczone, 0 linii, fokus na pierwszym kafelku/luce (Task 2 i Task 4, testy retry).
5. Czytnik ekranu w rozdziale angielskim — nazwa dostępna „dog, połączone z: pies” / „Luka 1: have”, bez `aria-label`, `lang` tylko na spanie (Task 2 i Task 4, `getByRole(..., { name })`).

---

## File Structure

| Plik | Odpowiedzialność |
| --- | --- |
| `packages/kid-ui/src/exercises/lesson/assignment-state.ts` | + `PairState` i funkcje par |
| `packages/kid-ui/src/exercises/lesson/PairLines.tsx` (nowy) | SVG kropek i linii, pomiar `offset*`, `ResizeObserver` |
| `packages/kid-ui/src/exercises/lesson/LessonClozeView.tsx` | luki-przyciski w tekście, bank, wiersz podpowiedzi |
| `packages/kid-ui/src/exercises/lesson/LessonMatchView.tsx` | dwie kolumny, `PairLines`, wiersz podpowiedzi |
| `packages/kid-ui/src/exercises/lesson/AssignmentPool.tsx` | − `AssignmentSlot` (Task 4) |
| `packages/kid-ui/src/exercises/lesson/LessonGroupView.tsx` | klasa puli `kid-lesson-assign__pool` |
| `packages/kid-ui/src/motion/kid-motion.ts` (+ `kid-motion.test.ts`) | `kidFadeInitial`, `kidFadeAnimate`, `kidFadeTransition` |
| `packages/kid-ui/src/styles.css` | style luk, par, puli; token `--kid-pair-gutter` |
| `packages/contracts/src/messages.ts` | komunikaty §6 |
| `docs/architecture.md`, spec | §19; ustalenia z implementacji |
| testy | `assignment-state.test.ts`, `lesson-views.test.tsx`, `PairLines.test.tsx` (nowy), E2E w `tests/e2e/` |

---

### Task 1: Czysty stan par (`PairState`)

**Files:**
- Modify: `packages/kid-ui/src/exercises/lesson/assignment-state.ts`
- Test: `packages/kid-ui/src/exercises/lesson/assignment-state.test.ts`

**Interfaces:**
- Produces:
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

- [ ] **Step 1: Testy** w nowym `describe("stan „Połącz linią”")`, `start = pairState([l1,l2,l3], [r1,r2,r3,rx])`:
  - `"zaznacza dowolny kafelek bez zmiany par"`: `tapPairItem(start,"right","r2").selected` = `{side:"right",id:"r2"}`, `pairs.size` = 0; z parą l1–r1 stuknięcie l1 bez zaznaczenia → `selected` = l1, para zostaje;
  - `"ponowne stuknięcie zaznaczonego zdejmuje zaznaczenie"`;
  - `"stuknięcie w tej samej kolumnie przenosi zaznaczenie, pary bez zmian"`: para l1–r1, zaznacz l2, stuknij l1 → `selected` = l1, `pairOf(s,"left","l1")?.id` = `"r1"`;
  - `"stuknięcie w drugiej kolumnie łączy w obu kierunkach"`: (l1 → r2) i (r3 → l2) → `pairs` = `{l1:r2, l2:r3}`, `selected` = `null`;
  - `"replaces pairs of both tiles"`: pary l1–r1 i l2–r2; zaznacz l1, stuknij r2 → `pairs` = `{l1:r2}`; `pairOf(s,"right","r1")` = `null`; `pairOf(s,"left","l2")` = `null`;
  - `"nieznane id i strona bez elementu nie zmieniają stanu"`: `tapPairItem(start,"left","r1")` `toBe(start)`; `tapPairItem(start,"right","nope")` `toBe(start)`;
  - `"clearPairSelection zdejmuje tylko zaznaczenie"`;
  - `"komplet przy wolnym dystraktorze; przypisania w kolejności lewej kolumny"`: połącz l3–r3, l1–r1, l2–rx → `pairComplete` = `true`, `pairAssignments` = `[{itemId:"l1",targetId:"r1"},{itemId:"l2",targetId:"rx"},{itemId:"l3",targetId:"r3"}]`; przy dwóch parach `false`.

- [ ] **Step 2: Uruchom — FAIL**: `corepack pnpm vitest run packages/kid-ui/src/exercises/lesson/assignment-state.test.ts`

- [ ] **Step 3: Zaimplementuj** według tabeli §5.1; nowy `Map` przy każdej zmianie; JSDoc po polsku w stylu pliku.

- [ ] **Step 4: Uruchom — PASS** (stare testy `MatchState`/`GroupState` też)

- [ ] **Step 5: Commit** `feat(kid-ui): czysty stan łączenia w pary linią`

---

### Task 2: „Uzupełnij tekst” — luka w zdaniu jako przycisk

**Files:**
- Modify: `packages/kid-ui/src/exercises/lesson/LessonClozeView.tsx`, `LessonGroupView.tsx` (klasa puli), `packages/kid-ui/src/styles.css`, `packages/contracts/src/messages.ts`
- Test: `packages/kid-ui/src/exercises/lesson/lesson-views.test.tsx`

**Interfaces:**
- Consumes: `matchState`, `selectSlot`, `placeRight`, `matchPool`, `rightOf`, `matchComplete`, `matchAssignments`; `AssignmentPool`, `AssignmentCheckButton`, `LessonBlockButton`.
- Produces: klasa `kid-lesson-assign__pool` (luki i grupy); klasy `kid-lesson-cloze__gap`, `--empty`, `--active`, `--filled`, `kid-lesson-cloze__gap-mark`, `kid-lesson-cloze__pool`, `kid-lesson-cloze__hint`; komunikaty:
  - `lessonClozeGapPrefix: "Luka {n}:"`
  - `lessonClozeGapEmptyLabel: "Luka {n}: pusta, wybierz słowo"`
  - `lessonClozeChangeHint: "Dotknij luki, żeby zmienić słowo."`

- [ ] **Step 1: Przepisz testy cloze** (zastępują trzy dzisiejsze przypadki; `clozeTask()` bez zmian; klikaj luki przez `getAllByTestId("kid-lesson-cloze-gap")[i]`, słowa banku przez `getAllByTestId("kid-lesson-cloze-option")` + tekst):
  - `"cloze: luki są przyciskami w tekście; słowo trafia do aktywnej luki, a aktywna przechodzi dalej"`: `text.querySelectorAll("button")` ma 2; brak `kid-lesson-cloze-slot`; pierwsza luka `aria-pressed="true"`, klasa `--active`, zawiera `.kid-lesson-cloze__gap-mark` „?”; druga ma klasę `--empty`; `getByRole("button", { name: "Luka 2: pusta, wybierz słowo" })` istnieje; po „dwutlenek węgla” `getByRole("button", { name: "Luka 1: dwutlenek węgla" })` ma klasę `--filled` (nie `--empty`), druga `aria-pressed="true"`; żadna luka nie ma atrybutu `aria-label`; po „wodę” „Sprawdź” wysyła `[{itemId:id(3),targetId:id(7)},{itemId:id(4),targetId:id(5)}]`;
  - `"cloze: stuknięcie pustej, nieaktywnej luki czyni ją aktywną"`;
  - `"cloze: wiersz podpowiedzi jest zawsze w DOM; tekst tylko przy komplecie z wolnymi słowami i bez blokady"`: przed kompletem `kid-lesson-cloze-hint` istnieje i ma pusty tekst; po dwóch słowach tekst = „Dotknij luki, żeby zmienić słowo.”, opcja „tlen” `disabled`; `rerender` z `dock` → tekst pusty; osobno `busy: true` przy komplecie → tekst pusty (bank zawsze ma dystraktor, więc przypadku pustego banku nie ma);
  - `"cloze: stuknięcie wypełnionej luki oddaje słowo; dok i busy wyłączają luki i bank"`;
  - `"cloze: po retry luki są puste, a fokus stoi na pierwszej luce"` (wyzwalacz retry jak w `lesson-views.test.tsx` ok. 416: rerender z `dock`, potem bez);
  - zamień `"cloze marks text segments, filled gaps, filled slots and the word bank"` na `"cloze marks text segments, the word inside a filled gap and the word bank; gap buttons stay unmarked"`: segmenty i opcje `lang=en`; po „have” `span[lang]` w pierwszej luce ma `lang=en`, przycisk luki nie ma `lang`.

- [ ] **Step 2: Uruchom — FAIL**: `corepack pnpm vitest run packages/kid-ui/src/exercises/lesson/lesson-views.test.tsx -t cloze`

- [ ] **Step 3: Przebuduj `LessonClozeView`**: w tekście dla każdej luki `LessonBlockButton` (`className` `kid-lesson-block kid-lesson-cloze__gap` + `--empty`/`--active`/`--filled` — pusta aktywna ma `--empty --active`; `data-testid="kid-lesson-cloze-gap"`, `aria-pressed={active}`, `disabled`, `onClick` = `selectSlot` + `handlers.onEdit()`). Treść wypełnionej: `<span className="kid-visually-hidden">{format(lessonClozeGapPrefix,{n})} </span><span lang={contentLocale}>{word}</span>`; pustej: `<span className="kid-visually-hidden">{format(lessonClozeGapEmptyLabel,{n})}</span>` + przy aktywnej `<span className="kid-lesson-cloze__gap-mark" aria-hidden="true">?</span>`. Usuń listę miejsc, numery i starą podpowiedź. Pod bankiem zawsze `<p className="kid-hint kid-lesson-cloze__hint" data-testid="kid-lesson-cloze-hint" aria-live="polite">` z tekstem tylko gdy `complete && pool.length > 0 && !disabled`. Pula: `className="kid-lesson-assign__pool kid-lesson-cloze__pool"`. Zaktualizuj komentarz nagłówkowy widoku.

- [ ] **Step 4: Style** (`styles.css`):
  - selektor puli `.kid-lesson-match__pool, .kid-lesson-group__pool` → `.kid-lesson-match__pool, .kid-lesson-assign__pool` (stara klasa par zostaje do Task 4); w `LessonGroupView.tsx` klasa `kid-lesson-assign__pool`;
  - **zastąp** reguły `.kid-lesson-cloze__gap`, `--filled`, `--active`, `__gap-number` (ok. 2786–2812) i usuń `__slots`, `__slot-row`; nowe reguły **po** `.kid-ui .kid-lesson-block`: `.kid-ui .kid-lesson-block.kid-lesson-cloze__gap { display: inline-flex; vertical-align: middle; align-items: center; justify-content: center; min-height: 48px; min-inline-size: 4.5em; max-inline-size: 100%; margin-inline: 2px; padding: 4px 12px; font: inherit; line-height: 1.2; overflow-wrap: break-word; text-align: center; }`;
  - `--empty`: `border-bottom: 2px dashed var(--md-sys-color-outline)` i tło `surface-container`; `--filled` = wygląd `kid-lesson-block--placed` (§3) z wagą `--kid-type-answer-weight`; `.kid-ui .kid-lesson-block.kid-lesson-cloze__gap--active, .kid-ui .kid-lesson-block.kid-lesson-cloze__gap--active:active` = aktywny z §3 (pełna obwódka `primary`); `.kid-lesson-cloze__gap-mark` w kolorze `on-primary`;
  - `.kid-ui .kid-lesson-cloze__text`: `line-height: 2` (Task 5 może obniżyć, nie wyżej);
  - `.kid-lesson-cloze__hint { min-height: 1.5em; }` (`.kid-hint` ma już rozmiar i wyśrodkowanie);
  - `@media (max-height: 479px) and (min-width: 600px)`: `.kid-lesson-cloze { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); align-items: start; }` i `.kid-lesson-cloze__bank { position: sticky; top: 0; }`.

- [ ] **Step 5: Komunikaty**: dodaj trzy z Interfaces; usuń `lessonClozeEmptySlot`, `lessonClozeGapEmpty`, `lessonClozeGapFilled`, `lessonClozeChooseSlot`, `lessonClozeRemove`, `lessonClozeActiveHint`, `lessonClozeGaps`, `lessonClozeText`. Sprawdź `git grep -nE "lessonClozeEmptySlot|lessonClozeGapEmpty\b|lessonClozeGapFilled|lessonClozeChooseSlot|lessonClozeRemove|lessonClozeActiveHint|lessonClozeGaps|lessonClozeText" -- ':!docs'` → brak trafień.

- [ ] **Step 6: Uruchom — PASS**: `corepack pnpm vitest run packages/kid-ui tests/kid-design-tokens.test.ts tests/kid-no-mantine.test.ts` oraz `corepack pnpm typecheck`

- [ ] **Step 7: Commit** `feat(kid-ui): luka w zdaniu jako cel stukania w „Uzupełnij tekst”`

---

### Task 3: `PairLines` — kropki i linie

**Files:**
- Create: `packages/kid-ui/src/exercises/lesson/PairLines.tsx`, `packages/kid-ui/src/exercises/lesson/PairLines.test.tsx`
- Modify: `packages/kid-ui/src/motion/kid-motion.ts`, `packages/kid-ui/src/motion/kid-motion.test.ts` (rejestr `ANIMATED_VALUES`), `packages/kid-ui/src/styles.css`

**Interfaces:**
- Consumes: `PairState`, `PairSide` (Task 1).
- Produces:
  ```ts
  // kid-motion.ts
  export const kidFadeInitial = { opacity: 0 } as const;
  export const kidFadeAnimate = { opacity: 1 } as const;
  export const kidFadeTransition: Transition = { duration: 0.18, ease: "easeOut" };
  // PairLines.tsx
  export function PairLines(props: {
    state: PairState;
    /** Kontener `kid-lesson-pair` (position: relative) — od niego liczone są pozycje. */
    containerRef: RefObject<HTMLElement | null>;
    /** Zarejestrowany kafelek (stabilne refy widoku). */
    tileOf: (side: PairSide, id: string) => HTMLElement | null;
  }): ReactElement;
  ```
  SVG bez `viewBox` i `preserveAspectRatio`: `data-testid="kid-lesson-match-lines"`, `aria-hidden="true"`, klasa `kid-lesson-pair__lines`. Kropka: `<circle data-testid="kid-lesson-match-dot" data-side data-item-id className="kid-lesson-pair__dot[ kid-lesson-pair__dot--paired| kid-lesson-pair__dot--selected]" r={selected ? 8 : 6} cx={0} cy={0}>`. Linia: `<m.line data-testid="kid-lesson-match-line" data-left-id data-right-id className="kid-lesson-pair__line" x1={0} y1={0} x2={0} y2={0}>`.

- [ ] **Step 1: Testy** w `PairLines.test.tsx` (render `renderKid`; kafelki jako zwykłe `div`; `useReducedMotion` przez mock modułu):
  ```ts
  const motionFlags = vi.hoisted(() => ({ reduce: false }));
  vi.mock("motion/react", async (orig) => ({ ...(await orig<typeof import("motion/react")>()), useReducedMotion: () => motionFlags.reduce }));
  ```
  - `"rysuje kropkę dla każdego kafelka i linię dla każdej pary"`: 3 lewe / 4 prawe, pary l1–r2 i l3–r1 → 7 kropek, 2 linie z `[data-left-id, data-right-id]` = `["l1","r2"]`, `["l3","r1"]`;
  - `"kropki w parze i zaznaczona mają swoje klasy i promień"`: zaznaczony r3 → `--selected`, `r="8"`; l1, r2 → `--paired`; pozostałe `r="6"`;
  - `"działa bez ResizeObserver (jsdom) i przy zerowych offsetach"`: `vi.stubGlobal("ResizeObserver", undefined)`; render nie rzuca; `cx`, `x1` = `"0"`;
  - `"linia wchodzi przez przezroczystość, a przy ograniczeniu ruchu od razu"`: `reduce=false` → styl inline linii zawiera `opacity: 0`; `reduce=true` → nie zawiera.
  - W `kid-motion.test.ts` dopisz nowe wartości do `ANIMATED_VALUES` (test wymaga, by animowano tylko `transform`/`opacity`).

- [ ] **Step 2: Uruchom — FAIL**: `corepack pnpm vitest run packages/kid-ui/src/exercises/lesson/PairLines.test.tsx packages/kid-ui/src/motion`

- [ ] **Step 3: Zaimplementuj `PairLines`**:
  - `anchorOf(tile, side, container)`: suma `offsetLeft/offsetTop` po `offsetParent`, aż do `container` **albo `null`** (jsdom); x = lewa strona `left + offsetWidth`, prawa `left`; y = `top + offsetHeight / 2`.
  - `layout()` zapisuje `cx/cy` i `x1…y2` przez refy i `setAttribute` (bez `setState` — bez klatki ze starymi liniami). Wołana w `useLayoutEffect` po każdym renderze (komponent jest **ostatnim** dzieckiem kontenera, więc refy kafelków są już podpięte) i w callbacku `ResizeObserver`, który w tym samym efekcie obserwuje kontener i wszystkie kafelki (`tileOf`), nigdy SVG; strażnik `typeof ResizeObserver === "undefined"`; `disconnect` w cleanupie.
  - Linia: `initial={reduce ? false : kidFadeInitial}`, `animate={kidFadeAnimate}`, `transition={kidFadeTransition}`.

- [ ] **Step 4: Style**: `.kid-lesson-pair__lines { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }`; `__line { stroke: var(--md-sys-color-primary); stroke-width: 4; stroke-linecap: round; }`; `__dot { fill: var(--md-sys-color-surface); stroke: var(--md-sys-color-outline); stroke-width: 2; }`; `__dot--paired, __dot--selected { fill: var(--md-sys-color-primary); stroke: var(--md-sys-color-primary); }`.

- [ ] **Step 5: Uruchom — PASS** (polecenie z kroku 2 + `tests/kid-design-tokens.test.ts`)

- [ ] **Step 6: Commit** `feat(kid-ui): warstwa linii i kropek do łączenia w pary`

---

### Task 4: „Połącz w pary” — dwie kolumny z liniami

**Files:**
- Modify: `packages/kid-ui/src/exercises/lesson/LessonMatchView.tsx`, `AssignmentPool.tsx`, `packages/kid-ui/src/styles.css`, `packages/contracts/src/messages.ts`
- Test: `packages/kid-ui/src/exercises/lesson/lesson-views.test.tsx`

**Interfaces:**
- Consumes: Task 1 (`pairState`, `tapPairItem`, `clearPairSelection`, `pairOf`, `pairComplete`, `pairAssignments`), Task 3 (`PairLines`).
- Produces: struktura `div.kid-lesson-match-view` > (`div.kid-lesson-pair[data-testid=kid-lesson-match]` z dwiema kolumnami i `PairLines` na końcu) + `p.kid-hint.kid-lesson-pair__hint[data-testid=kid-lesson-match-hint]`; kafelki z `data-item-id`; klasy `kid-lesson-pair__column`, `__item`, `__item--selected`; token `--kid-pair-gutter`; komunikaty:
  - `lessonMatchLeft: "Słowa do połączenia"`
  - `lessonMatchPickOther: "Teraz dotknij tego, co pasuje."`
  - `lessonMatchPairedWith: ", połączone z:"`
  - `lessonMatchConnectWith: ", połącz z:"`

- [ ] **Step 1: Przepisz testy match** (zastępują dwa dzisiejsze i `"match marks the left column only…"`; klikaj **wyłącznie** przez `getAllByTestId("kid-lesson-match-left"|"kid-lesson-match-right")[i]` — po połączeniu teksty występują też w ukrytych dopowiedzeniach). Dane jak w dzisiejszym pierwszym teście (3 lewe, 4 prawe):
  - `"match: łączenie od lewej i od prawej, „Sprawdź” przy komplecie z wolnym dystraktorem"`: klik left[0] → `aria-pressed="true"`, klasa `kid-lesson-pair__item--selected`, hint = „Teraz dotknij tego, co pasuje.”; klik right[1] → 1 `kid-lesson-match-line`, hint pusty (element istnieje); klik right[0] potem left[1]; klik left[2], right[2] → „Sprawdź” aktywne, wysyła `[{id3→id7},{id4→id6},{id5→id8}]`;
  - `"match: zaznaczenie przez kliknięcia — zdjęcie i przeniesienie w kolumnie"`: klik left[0] dwa razy → brak `aria-pressed="true"`; klik left[0], left[1] → zaznaczony tylko left[1];
  - `"match: nowa para zastępuje stare pary obu kafelków"`: pary a–x, b–y; klik left[0], right[1] → linie (po `data-left-id`, `data-right-id`) = `[[a, y]]`; left[1] i right[0] bez `kid-lesson-block--placed`;
  - `"match: nazwy dostępne z treści"`: (`contentLocale: en`, dog/cat/fish → pies/kot/ryba) przed parowaniem spany tekstu w `kid-lesson-match-right` bez `lang`, w `-left` z `lang=en`, przyciski bez `lang` i bez `aria-label`; klik left[0] → `getByRole("button", { name: "pies, połącz z: dog" })`; klik right[0] → `getByRole("button", { name: "dog, połączone z: pies" })`;
  - `"match: wysłanie czyści zaznaczenie; dok i busy wyłączają kafelki i podpowiedź"`: komplet, klik dystraktor (zaznaczony), „Sprawdź” → brak `aria-pressed="true"`, hint pusty; `rerender` z `dock` → kafelki `disabled`, linie nadal 3; osobno `busy: true` przy zaznaczeniu → hint pusty;
  - `"match: po retry pary i linie znikają, a fokus stoi na pierwszym kafelku"`: 0 `kid-lesson-match-line`, `document.activeElement` = left[0].

- [ ] **Step 2: Uruchom — FAIL**: `corepack pnpm vitest run packages/kid-ui/src/exercises/lesson/lesson-views.test.tsx -t match`

- [ ] **Step 3: Przebuduj `LessonMatchView`** wg struktury z Interfaces: kolumny `div.kid-lesson-pair__column` (`role="list"`, `aria-label` `lessonMatchLeft`/`lessonMatchPool`), kafelki `div[role=listitem] > LessonBlockButton` (`kid-lesson-block kid-lesson-pair__item` + `kid-lesson-block--placed`/`kid-lesson-pair__item--selected`; `data-testid` `kid-lesson-match-left`/`-right`; `data-item-id`; `aria-pressed`; `disabled`). Refy: mapa `Map<string, HTMLElement>` w `useRef`, ref callback **stabilny na kafelek** (memo per `side:id`, np. `useMemo` mapy callbacków od `prompt.left/right`), który przy `null` usuwa wpis tylko, jeśli wskazuje ten sam element. Treść kafelka: `<span lang={side==="left" ? contentLocale : undefined}>{text}</span>` + `kid-visually-hidden` z `lessonMatchPairedWith` + spacją + odpowiednikiem w jego `lang` (gdy w parze) albo `lessonMatchConnectWith` + spacją + zaznaczonym (gdy wolny, a zaznaczony jest z drugiej kolumny). Hint zawsze w DOM, tekst tylko przy `selected && !disabled`. „Sprawdź”: `setState(clearPairSelection)` i `handlers.onAnswerAssignment(pairAssignments(state))`. `useRetryReset` → `pairState(left, right)`. `PairLines` ostatnim dzieckiem `kid-lesson-pair`. Zaktualizuj komentarz nagłówkowy.

- [ ] **Step 4: Style** (po `.kid-ui .kid-lesson-block`; reguły `.kid-lesson-match*` zastąpione, `.kid-lesson-match, .kid-lesson-group` → `.kid-lesson-match-view, .kid-lesson-group`, selektor puli → `.kid-lesson-assign__pool`):
  - token w bloku `--kid-pair-gutter: 48px;` + poza blokiem `@media (min-width: 600px) { :root:has(.kid-ui), .kid-theme, .kid-ui { --kid-pair-gutter: 72px; } }` (wzorzec ok. linii 199);
  - `.kid-lesson-pair { position: relative; display: grid; grid-template-columns: minmax(min-content, 2fr) var(--kid-pair-gutter) minmax(0, 3fr); width: 100%; }`; `.kid-lesson-pair__column { display: flex; flex-direction: column; justify-content: space-around; gap: 10px; min-width: 0; }` z `grid-column: 1` / `3`;
  - `.kid-ui .kid-lesson-block.kid-lesson-pair__item { width: 100%; overflow-wrap: break-word; }`; `@media (max-width: 599px)`: `padding: 8px 10px; font-size: var(--kid-type-title-sm-size);`;
  - `.kid-ui .kid-lesson-block.kid-lesson-pair__item--selected, … :active` = aktywny z §3;
  - `.kid-lesson-pair__hint { min-height: 1.5em; }`.

- [ ] **Step 5: Sprzątanie**: usuń `AssignmentSlot` i reguły `.kid-lesson-match__slot*`, `__pool`, `__pairs`, `__row`, `__left`; komunikaty: dodaj cztery, usuń `lessonMatchEmptySlot`, `lessonMatchChooseSlot`, `lessonMatchActiveHint`, `lessonMatchPairs`, `lessonMatchPlace`, `lessonMatchRemove`. `git grep -nE "AssignmentSlot|lessonMatch(EmptySlot|ChooseSlot|ActiveHint|Pairs|Place|Remove)\b|kid-lesson-match__|kid-lesson-match-(option|slot|row|pool)|kid-lesson-cloze-slot" -- ':!docs' ':!tests/e2e'` → brak trafień (E2E poprawiają Task 5–6).

- [ ] **Step 6: Uruchom — PASS**: `corepack pnpm vitest run packages/kid-ui tests/kid-design-tokens.test.ts tests/kid-no-mantine.test.ts` i `corepack pnpm typecheck`

- [ ] **Step 7: Commit** `feat(kid-ui): „Połącz w pary” jako dwie kolumny łączone linią`

---

### Task 5: E2E — „Uzupełnij tekst” i fixture'y przepełnienia

**Files:**
- Modify: `tests/e2e/lesson-cloze-layout.spec.ts`, `tests/e2e/kid-large-screen.spec.ts`, `tests/e2e/helpers/kid-fixtures.ts`, `tests/e2e/lesson-sentence-audio.spec.ts`, `tests/e2e/helpers/kid-frame.ts` (komentarz ok. 340), ewentualnie `packages/kid-ui/src/styles.css`

**Interfaces:**
- Consumes: test id z Task 2 (`kid-lesson-cloze-gap`, `-option`, `-pool`, `-text`, `-hint`), klasy `.kid-lesson-cloze__gap-mark`, `.kid-visually-hidden`.
- Produces: `longClozeTask: TaskDto` w `helpers/kid-fixtures.ts` (te same luki i bank co `clozeTask`, tekst dopisany **wyłącznie po ostatniej luce**); `openAnsweredCloze(page, viewport, task = clozeTask)`.

- [ ] **Step 1: `lesson-cloze-layout.spec.ts`**:
  - `VIEWPORTS` + `{ width: 320, height: 568 }`;
  - w `expectClozeGeometry`: cele `kid-lesson-cloze-gap` ×4 (`minHeight: 48`) zamiast slotów; `expectButtonsNotClipped(page, "kid-lesson-cloze-gap", label)`; zastąp „bank right under slots” (ok. 91–97): przy `height < 480 && width >= 600` `pool.x ≥ text.x + text.width − 1`, w innym razie `pool.y ≥ text.y + text.height − 1`;
  - asercja wierszy: zbierz prostokąty tekstu akapitu przez `Range` z wyłączeniem luk i `.kid-visually-hidden`; sprawdź, że przynajmniej jedna luka ma tekst w wierszu nad i pod sobą oraz że żaden prostokąt tekstu nie przecina prostokąta luki;
  - zastąp liczenie slotów (ok. 108, 124) i `toHaveCount(0)` przycisków w tekście (ok. 107) na `toHaveCount(4)`;
  - ok. 135: `span[lang]` w pierwszej luce ma `lang="en-GB"`, przycisk luki bez `lang`;
  - test główny: najpierw „światła słonecznego” → na 320×568 prostokąt tej luki mieści się w prostokącie `kid-lesson-cloze-text`;
  - nowy przypadek 844×390: wstaw trzy słowa, `scrollIntoViewIfNeeded` aktywnej (czwartej) luki → aktywna luka i `kid-lesson-cloze-pool` jednocześnie w viewporcie.

- [ ] **Step 2: Fixture'y przepełnienia**: uruchom przypadki „the material scrolls before the verdict” (1280×600, 1536×730), tablet 1024×1366 `fits: "space"` (`kid-large-screen.spec.ts`) i „overflowing cloze” (`lesson-sentence-audio.spec.ts` ok. 1089). Tylko te, które straciły przepełnienie, przełącz na dłuższe dane: w `kid-large-screen.spec.ts` przez `openAnsweredCloze(page, viewport, longClozeTask)` (i `clozeHintFixture(task)`), w `lesson-sentence-audio.spec.ts` przez osobny `overflowingClozeTask` (dopisany tekst po ostatniej luce, `clozeSolution` bez zmian) użyty wyłącznie w `TABLET_SCENARIOS` — 15 przypadków `CLOZE_VIEWPORTS × CLOZE_FEEDBACKS` zostaje na dotychczasowym `clozeTask`. Asercji nie luzujemy. Zaktualizuj nieaktualne komentarze (`kid-large-screen.spec.ts` ok. 893–897 „ok. 225 znaków”, „about 1100 px” przy tablecie, `MIN_VISIBLE_MATERIAL` „miejsce luki”, `kid-frame.ts` ok. 340 „gap-number”).

- [ ] **Step 3: `kid-large-screen.spec.ts`**: w `READING_MEASURE_CASES` dla „cloze text” `exclude: ".kid-lesson-cloze__gap-mark, .kid-visually-hidden"`; zakres znaków bez zmian (jeśli wypada poza, popraw CSS luki, nie test). Sprawdź pozostałe przypadki z `openAnsweredCloze` (dok 812×375, `SCROLLING_MATERIAL_CASES`, `PAGE_SCROLL_DOCK_CASES`) — wiersz podpowiedzi ma stałą wysokość, więc `contentBottom` nie zmienia się przy werdykcie.

- [ ] **Step 4: Uruchom — PASS**: `$env:UMIEM_E2E_WEB_MODE='dev'; pnpm exec playwright test tests/e2e/lesson-cloze-layout.spec.ts tests/e2e/kid-large-screen.spec.ts tests/e2e/lesson-sentence-audio.spec.ts --project=mocked` — wszystkie PASS (zrzuty pominięte bez `UMIEM_E2E_SCREENSHOTS`). Zapisz ostateczny `line-height` tekstu luk do Task 7.

- [ ] **Step 5: Commit** `test(e2e): geometria luk w zdaniu i dłuższe fixture'y przepełnienia`

---

### Task 6: E2E — „Połącz w pary” z liniami

**Files:**
- Modify: `tests/e2e/helpers/lesson-assignment-task.ts`, `tests/e2e/lesson-assignment-layout.spec.ts`

**Interfaces:**
- Consumes: test id z Task 3–4 (`kid-lesson-match`, `-left`, `-right` z `data-item-id`, `-lines`, `-dot`, `-line`, `-hint`), `waitForKidScale`, `nextFrames`, `boxes`, `expectRectsUnchanged` (`helpers/kid-frame.ts`).
- Produces:
  ```ts
  /** Łączy i-ty lewy z i-tym prawym kafelkiem (kolejność widoku), klika „Sprawdź”, zwraca wysłane przypisania. */
  export async function pairAndCheck(page: Page, count: number, posted: unknown[]): Promise<{ itemId: string; targetId: string }[]>;
  ```

- [ ] **Step 1: `pairAndCheck`** w `lesson-assignment-task.ts`: dla `i < count` klik `kid-lesson-match-left` nth(i), potem `kid-lesson-match-right` nth(i); „Sprawdź” wyłączone przed ostatnią parą; dalej jak `tapPoolAndCheck` (jeden POST, `modality: "assignment"`, unikalne `targetId`).

- [ ] **Step 2: `expectLinesOnTiles(page, label)`** w specu: w `page.evaluate` dla każdej `kid-lesson-match-line` weź `x1…y2`, prostokąt SVG i `svg.currentCSSZoom` (SVG bez `viewBox`); punkt ekranu = `svgRect.left + x * zoom`, `svgRect.top + y * zoom`; porównaj z prawym-środkiem prostokąta `kid-lesson-match-left[data-item-id=<data-left-id>]` i lewym-środkiem `kid-lesson-match-right[data-item-id=<data-right-id>]`, tak samo `cx/cy` kropek (`data-side`, `data-item-id`); tolerancja `1.5 * zoom` px. Asercję owiń w `await expect(async () => …).toPass()`.

- [ ] **Step 3: Test geometrii par**: osobna lista `MATCH_VIEWPORTS` = `VIEWPORTS` + `{ width: 320, height: 568 }` (grupy bez zmian); połącz dwie pary (w tym `LONG_RIGHT`); dla każdego viewportu: cele `kid-lesson-match-left` ×5 i `-right` ×7 z `minHeight: 48`, `expectButtonsNotClipped` dla obu, kolumny obok siebie (`right.x > left.x + left.width`), żadne słowo w spanie tekstu kafelków lewej kolumny (bez `.kid-visually-hidden`) nie ma więcej niż jednego prostokąta `Range.getClientRects()`, `expectLinesOnTiles`. Zaznaczenie bez przesunięć: `before` = `boxes(...)` kafelków, klik wolnego kafelka → `expectRectsUnchanged(before, after1)` i hint widoczny, ponowny klik → `expectRectsUnchanged(before, after2)`. Jeśli na 320 px słowo się łamie albo jest poziome przepełnienie — popraw CSS (padding/rozmiar compact), nie test.

- [ ] **Step 4: Test linii po zmianach układu** `"match: lines stay on the tiles at scale 1.6, after a resize and after a style change"`: 2560×1440, `waitForKidScale(page, 1.6)`, trzy pary, `expectLinesOnTiles`; `setViewportSize(390×844)`, `waitForKidScale(page, 1)`, `nextFrames`, `expectLinesOnTiles`; `addStyleTag({ content: ".kid-lesson-pair__item { padding-block: 20px; }" })`, `nextFrames`, `expectLinesOnTiles` (zmiana bez renderu Reacta — ścieżka `ResizeObserver`).

- [ ] **Step 5: Test „after a mistake”** przez `pairAndCheck(page, 5, posted)`: asercje bez zmian (kolejność `itemId`, `correctText` widoczny) + kafelki `disabled` + 5 `kid-lesson-match-line`.

- [ ] **Step 6: Uruchom — PASS**: `$env:UMIEM_E2E_WEB_MODE='dev'; pnpm exec playwright test tests/e2e/lesson-assignment-layout.spec.ts --project=mocked`

- [ ] **Step 7: Commit** `test(e2e): geometria łączenia w pary i linii`

---

### Task 7: Dokumentacja i pełna weryfikacja

**Files:**
- Modify: `docs/architecture.md` (§19, punkty ok. 781–782), `docs/superpowers/specs/2026-11-02-lesson-cloze-match-ux-design.md`

- [ ] **Step 1: `docs/architecture.md`**: w „Uzupełnij tekst (Etap 10)” zastąp „`LessonClozeView` z luką w tekście jako znacznikiem (bez przycisku) … jedna kolumna na każdym ekranie” opisem: luka jako przycisk w tekście, bank pod tekstem (obok i przyklejony w niskim landscape), stan `assignment-state.ts`; w „Pary i grupy (Etap 7)” dla par: dwie kolumny łączone linią (`PairLines`, geometria `offset*`), stan `PairState`; odesłanie do specu 2026-11-02.

- [ ] **Step 2: Spec**: status „zaimplementowany” + sekcja „Ustalenia z implementacji” (ostateczny `line-height`, które fixture'y przeszły na dłuższy tekst, ewentualne poprawki CSS z Task 5–6).

- [ ] **Step 3: Pełne sprawdzenie**: `corepack pnpm typecheck`, `corepack pnpm test:unit`, `corepack pnpm test:e2e:shards` — wszystko PASS; w raporcie liczby testów `mocked`/`real`. Testy integracyjne pomijamy (brak zmian serwera) i odnotowujemy to.

- [ ] **Step 4: Commit** `docs: Kid UI luk i par w architekturze`
