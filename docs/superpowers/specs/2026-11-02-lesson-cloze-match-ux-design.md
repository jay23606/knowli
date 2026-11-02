# „Uzupełnij tekst” i „Połącz w pary” — naturalne stukanie w Kid UI — design

Data: 2026-11-02. Status: projekt do recenzji (wersja 1).
Powiązane: `docs/architecture.md` §19 (punkty „Pary i grupy (Etap 7)” i „Uzupełnij tekst (Etap 10)”),
`docs/superpowers/specs/2026-10-30-kid-ui-large-screens-design.md` (skala `zoom`, §4.4),
`docs/superpowers/specs/2026-10-31-kid-ui-large-screens-followups-design.md` (`--kid-reading-measure`).

## 1. Cel

Oba ćwiczenia przypisań w lekcjach mają dziś pośrednią listę przycisków „Wybierz” / „Wybierz słowo”
między materiałem a bankiem słów. Dziecko patrzy na zdanie albo na słowo po lewej, a stuka w osobny,
duży, pusty przycisk, który powtarza ten sam cel drugi raz. Właściciel ocenił to jako „mega nienaturalne”.

Ustalenia z właścicielem (2026-11-02, na podstawie klikalnych makiet w czacie):

- **„Uzupełnij tekst” (`lesson_cloze`)**: luka **w zdaniu** jest jedynym celem stukania (makieta 1, zaakceptowana).
  Znika lista miejsc pod tekstem, numery luk i podpowiedź „Które słowo pasuje do luki N?”.
- **„Połącz w pary” (`lesson_match`)**: **dwie kolumny kafelków łączone linią, jak w zeszycie ćwiczeń**
  (makieta C, zaakceptowana). Odrzucone: kafelki z kolorowymi znaczkami par (2A), lżejsza wersja obecnych
  wierszy (2B), jedno słowo naraz (D).
- Zaznaczony kafelek ma być **wyraźnie wypełniony kolorem** (uwaga właściciela do makiety C), a przy każdym
  kafelku stoi kropka-zaczep po stronie drugiej kolumny.

## 2. Zakres

W zakresie: widoki `LessonClozeView` i `LessonMatchView`, czysty stan w `assignment-state.ts`,
wspólne `AssignmentPool.tsx`, style w `packages/kid-ui/src/styles.css`, komunikaty Kid UI
w `packages/contracts/src/messages.ts` (tylko teksty widoku), testy komponentów i E2E, dokumentacja.

Poza zakresem (bez zmian):

- kontrakty DTO, API, serwer, ocena (`evaluateAssignment`), migracje, MCP i `SKILL.md` — odpowiedź to nadal
  `modality: "assignment"` z przypisaniami `{ itemId, targetId }` wysyłanymi po „Sprawdź”; kolejność
  i kształt przypisań się nie zmieniają (dla par: lewy element → prawy; dla luk: luka → słowo);
- polecenia domyślne `lessonMatchInstruction` i `lessonClozeInstruction` — serwer używa ich jako polecenia
  zadania i tekstu nagrania pytania (`question-read-text.ts`); zmiana tekstu zmieniłaby nagrania;
- „Pogrupuj” (`lesson_group`) — zostaje model „aktywna grupa + pula”;
- natychmiastowa ocena każdej pary lub luki: Kid DTO nie ma klucza, a wynik próby to jeden werdykt
  z `correctText`. Kolorowanie linii i luk na zielono/czerwono z makiet **nie** wchodzi do zakresu;
  wynik pokazuje dotychczasowy panel feedbacku.

## 3. „Uzupełnij tekst” — luka w zdaniu jako przycisk

### 3.1 Zachowanie

- Każda luka w tekście to przycisk `LessonBlockButton` (klasa `kid-lesson-cloze__gap`), wstawiony w wiersz
  tekstu. Pusta luka nie ma treści widocznej poza obwódką; **aktywna** pusta luka pokazuje „?”.
- Model stanu bez zmian (`matchState`, `selectSlot`, `placeRight`, `matchPool`, `rightOf`, `matchComplete`,
  `matchAssignments`): na starcie aktywna jest pierwsza luka; słowo z banku trafia do aktywnej luki,
  a aktywna staje się następna pusta (w kolejności luk, potem od początku); dotknięcie wypełnionej luki
  oddaje słowo do banku i czyni lukę aktywną; dotknięcie pustej luki czyni ją aktywną.
- Bank słów (`AssignmentPool`) stoi pod tekstem, jak dziś. „Sprawdź” aktywne przy komplecie, jak dziś.
- Znikają: lista `kid-lesson-cloze__slots` z `AssignmentSlot`, numery luk (`kid-lesson-cloze__gap-number`)
  i podpowiedź `kid-lesson-cloze-hint`.

### 3.2 Wygląd

- Luka: `display: inline-flex`, `min-height: 48px`, `min-inline-size` ok. 4,5 em (pusta luka ma
  szerokość krótkiego słowa), `vertical-align: middle`, wewnętrzne zawijanie (`max-inline-size: 100%`,
  `overflow-wrap: anywhere`) — długie wyrażenie z banku (np. „światła słonecznego”) zawija się w środku
  przycisku zamiast wychodzić poza kolumnę.
- Stany (tokeny M3, bez literałów):
  - pusta: tło `surface-container`, dolna obwódka przerywana `outline`;
  - aktywna: obwódka 2 px `primary`, tło `secondary-container`, „?” w kolorze `primary`;
  - wypełniona: pełna obwódka `outline`, tło `surface-container-high`, tekst `on-surface`
    z wagą `--kid-type-answer-weight`.
- Tekst `kid-lesson-cloze__text`: `line-height` podniesione tak, by przycisk 48 px mieścił się w wierszu
  bez nachodzenia na sąsiednie wiersze (wartość ustalona pomiarem w E2E, startowo ok. 2,4).
  Zostaje `max-inline-size: var(--kid-reading-measure)` i wyśrodkowanie bloku.
- `lang`: segmenty tekstu jak dziś; przycisk wypełnionej luki dostaje `lang={contentLocale}` (jak dzisiejsze
  miejsce `AssignmentSlot`), pusty — bez `lang`.

### 3.3 Dostępność

- Etykieta przycisku luki: pusta `lessonClozeChooseSlot` („Luka {n}: wybierz słowo”), wypełniona
  `lessonClozeRemove` („Luka {n}: {word}. Dotknij, aby wyjąć słowo”). Numer luki żyje tylko w etykiecie.
- `aria-pressed` = luka aktywna. Ukryte opisy `lessonClozeGapEmpty`/`lessonClozeGapFilled` przestają być
  potrzebne (etykieta przycisku je zastępuje) — usuwamy je z komunikatów razem z `lessonClozeEmptySlot`,
  `lessonClozeActiveHint` i `lessonClozeGaps`, o ile nic innego ich nie używa.
- Etykiety opcji banku bez zmian: `lessonClozePlace` („Wstaw {word} do luki {n}”).

## 4. „Połącz w pary” — dwie kolumny i linie

### 4.1 Zachowanie

- Lewa kolumna: elementy `left` w kolejności zadania; prawa: `right` (z dystraktorami) w kolejności zadania.
  Każdy element to kafelek `LessonBlockButton` (`kid-lesson-pair__item`).
- Stukanie (czysta funkcja, §4.4):
  - nic nie jest zaznaczone → dotknięty niepołączony kafelek zostaje **zaznaczony**;
  - zaznaczony jest kafelek z tej samej kolumny → zaznaczenie przechodzi na dotknięty; dotknięcie
    zaznaczonego kafelka zdejmuje zaznaczenie;
  - zaznaczony jest kafelek z drugiej kolumny → powstaje **para** (linia), zaznaczenie znika;
  - dotknięty kafelek jest w parze → para się rozłącza, a dotknięty kafelek zostaje zaznaczony
    (dziecko od razu wskazuje nowy odpowiednik).
- Kierunek dowolny: można zacząć od lewej albo od prawej kolumny.
- Element prawej kolumny należy do co najwyżej jednej pary (jak dziś: cel użyty raz); dystraktory zostają
  bez linii.
- „Sprawdź” aktywne, gdy każdy lewy element ma parę. Wysyłka: przypisania w kolejności lewej kolumny
  (jak dziś `matchAssignments`).
- Podpowiedź (`kid-hint`, `aria-live="polite"`) widoczna tylko przy zaznaczeniu: „Teraz dotknij pary
  po drugiej stronie.” (nowy komunikat `lessonMatchPickOther`). Bez zaznaczenia brak podpowiedzi —
  polecenie zadania wystarcza.
- Po „Sprawdź” (dok feedbacku) kafelki są wyłączone, linie zostają w neutralnym kolorze; ponowna próba
  (`useRetryReset`) czyści pary i zaznaczenie i ustawia fokus na pierwszym kafelku, jak dziś.

### 4.2 Układ

- Kontener `kid-lesson-pair` (`position: relative`): siatka trzech kolumn
  `minmax(0, 2fr) var(--kid-pair-gutter) minmax(0, 3fr)` — lewa węższa (pojęcia), prawa szersza
  (znaczenia i opisy bywają długie, do 100 znaków w przedmiotach szkolnych). Środkowa kolumna to pusty
  pas na linie.
- `--kid-pair-gutter`: 40 px w compact (<600), 72 px od medium. Wartości jako tokeny układu w bloku
  `.kid-theme, .kid-ui`.
- Każda kolumna to pionowa lista (`role="list"`, etykiety `lessonMatchLeft` / `lessonMatchPool`)
  z odstępem 10 px, kafelki na całą szerokość kolumny, tekst zawija się w kafelku. Kolumny wyrównane do góry.
- Kafelki ≥ 48 px wysokości (`kid-lesson-block` ma 56 px). Brak poziomego przepełnienia na 320 px.
- Długie opisy na telefonie wydłużają prawą kolumnę; treść przewija się w kontenerze materiału
  (zasady AGENTS.md: treść osiągalna przez scroll, akcje osiągalne). Linie są częścią przewijanej treści.

### 4.3 Linie i kropki (`PairLines`)

- Nowy komponent `PairLines` w `packages/kid-ui/src/exercises/lesson/`: jedna warstwa `<svg>`
  (`aria-hidden="true"`, `pointer-events: none`, `position: absolute; inset: 0`, `overflow: visible`)
  wewnątrz `kid-lesson-pair`, nad kafelkami.
- Rysuje:
  - przy każdym kafelku kropkę-zaczep na środku krawędzi zwróconej do pasa (lewy kafelek — prawa krawędź,
    prawy — lewa): pusta (obwódka `outline`, wypełnienie tłem), w parze — wypełniona `primary`,
    zaznaczona — większa i wypełniona `primary`;
  - dla każdej pary linię prostą 4 px `primary` z zaokrąglonymi końcami między kropkami.
  Kolory przez klasy CSS z tokenami (bez literałów koloru w TSX).
- **Geometria w pikselach wewnętrznych**: pozycje liczone z `offsetLeft/offsetTop/offsetWidth/offsetHeight`
  kafelków względem `kid-lesson-pair` (ich `offsetParent`), więc są w tych samych pikselach co współrzędne
  SVG pod CSS `zoom` (AGENTS.md: `offset*` są wewnętrzne). Bez `getBoundingClientRect()`; gdyby był
  potrzebny, wartość przechodzi przez `toLayoutPx`.
- Przeliczenie przy: zmianie par/zaznaczenia (render), zmianie rozmiaru kontenera lub dowolnego kafelka
  (`ResizeObserver` na kontenerze i kafelkach), załadowaniu fontu (zmiana rozmiaru kafelków łapie
  `ResizeObserver`). Pomiar w `useLayoutEffect`, by linia nie mrugała w złym miejscu.
- Ruch: nowa linia pojawia się przez `opacity` (Motion, `m.line`, tokeny z `kid-motion.ts`); bez animacji
  długości ani `pathLength` (zasada: tylko `transform` i `opacity`). `MotionConfig reducedMotion="user"`
  wyłącza przejście.

### 4.4 Stan (`assignment-state.ts`)

Nowy czysty stan obok istniejącego (który zostaje dla luk):

```ts
export interface PairState {
  readonly left: readonly LessonItem[];
  readonly right: readonly LessonItem[];
  /** id lewego → id prawego. */
  readonly pairs: ReadonlyMap<string, string>;
  readonly selected: { readonly side: "left" | "right"; readonly id: string } | null;
}
export function pairState(left, right): PairState;              // bez par i zaznaczenia
export function tapPairItem(state, side, id): PairState;        // reguły z §4.1; nieznane id → bez zmian
export function pairOf(state, side, id): LessonItem | null;     // odpowiednik w parze
export function pairComplete(state): boolean;                   // każdy lewy w parze
export function pairAssignments(state): Assignment[];           // w kolejności lewej kolumny
```

Testy jednostkowe w `assignment-state.test.ts` pokrywają każdą gałąź `tapPairItem` (oba kierunki,
przełączanie zaznaczenia w kolumnie, zdjęcie zaznaczenia, rozłączenie z zaznaczeniem, prawy element już
w parze, nieznane id), kompletność i kolejność przypisań.

### 4.5 Wygląd kafelków

- zwykły: `kid-lesson-block` (obwódka `outline`, tło `surface-container-high`);
- zaznaczony: **tło `primary`, tekst `on-primary`, obwódka `primary`**, waga `--kid-type-answer-weight`;
- w parze: `kid-lesson-block--placed` (obwódka `primary`, tło `secondary-container`);
- wyłączony (dok): jak dziś dla `LessonBlockButton`.

### 4.6 Dostępność

- Kolejność fokusu: lewa kolumna, potem prawa; Enter/Spacja = stuknięcie.
- `aria-pressed` = zaznaczony.
- Etykiety (po polsku; `lang` kafelka jak dziś: lewa kolumna `contentLocale`, prawa bez):
  - wolny, nic nie zaznaczone lub zaznaczony w tej samej kolumnie: sam tekst elementu;
  - wolny, gdy zaznaczony jest element z drugiej kolumny: `lessonMatchPlace`
    („Połącz {item} z: {answer}”, lewy jako `item`);
  - w parze: `lessonMatchRemove` („{item} — {answer}. Dotknij, aby odłączyć”).
- Linie i kropki są dekoracyjne; stan pary niesie etykieta.

## 5. Komunikaty (`messages.kid`)

- dodane: `lessonMatchPickOther` („Teraz dotknij pary po drugiej stronie.”), `lessonMatchLeft`
  („Słowa do połączenia”);
- usunięte, gdy nieużywane: `lessonMatchEmptySlot`, `lessonMatchChooseSlot`, `lessonMatchActiveHint`,
  `lessonMatchPairs`, `lessonClozeEmptySlot`, `lessonClozeGapEmpty`, `lessonClozeGapFilled`,
  `lessonClozeActiveHint`, `lessonClozeGaps`;
- `AssignmentSlot` w `AssignmentPool.tsx` znika, jeśli po zmianie nikt go nie używa („Pogrupuj” go nie używa).

## 6. Granice i zgodność

- Zmiany wyłącznie w `packages/kid-ui` i tekstach `packages/contracts/src/messages.ts`; Kid UI bez Mantine,
  bez surowych `<button>` (kafelki i luki to `LessonBlockButton`), bez literałów koloru/rozmiaru poza blokiem
  tokenów (`tests/kid-design-tokens.test.ts`), bez surowych `vh/vw`.
- Zgodność wstecz: format próby bez zmian, więc stare i nowe klienty działają z tym samym serwerem.
- API → MCP → skill: bez wpływu (brak zmiany endpointów, DTO i znaczenia danych).

## 7. Testy

Jednostkowe (Vitest):

- `assignment-state.test.ts` — §4.4;
- `lesson-views.test.tsx` — cloze: luki są przyciskami w tekście, brak listy miejsc i numerów, stukanie
  słowa wypełnia aktywną lukę i przesuwa aktywną, stuknięcie wypełnionej oddaje słowo, etykiety
  i `aria-pressed`, `lang`; pary: zaznaczenie z obu stron, para, rozłączenie, podpowiedź tylko przy
  zaznaczeniu, „Sprawdź” przy komplecie wysyła przypisania w kolejności lewej kolumny, reset po retry,
  `PairLines` renderuje kropkę na kafelek i linię na parę.

E2E (projekt `mocked`, istniejące pliki):

- `lesson-cloze-layout.spec.ts` — zamiast miejsc pod tekstem: luki w tekście ≥ 48 px, w kontenerze tekstu,
  bez nachodzenia luk z sąsiednich wierszy na siebie (prostokąty rozłączne), bank i „Sprawdź” osiągalne,
  brak poziomego przepełnienia, długie wyrażenie w luce mieści się w kolumnie — na 390×844, 844×390,
  768×1024, 1280×800 oraz wariant rozdziału z `contentLocale`;
- `lesson-assignment-layout.spec.ts` — pary 5 × 7 z opisami do 100 znaków: dwie kolumny obok siebie na każdym
  ekranie, kafelki ≥ 48 px, brak poziomego przepełnienia, osiągalność po przewinięciu; po połączeniu par
  końce każdej linii leżą na środkach krawędzi odpowiednich kafelków (tolerancja 2 px ekranu) — także przy
  skali > 1 na desktopie myszy (`waitForKidScale`) i po zmianie rozmiaru okna; zaznaczony kafelek ma
  `aria-pressed="true"`;
- helper `tapPoolAndCheck` zostaje dla luk; dla par nowy helper `pairAndCheck` (stuknięcie lewy → prawy);
- `kid-large-screen.spec.ts` — przypadki cloze: pomiar szerokości wiersza (`READING_MEASURE_CASES`) bez
  `exclude` numerów luk i z przyciskami luk w tekście; przypadki docku (`answer: ".kid-lesson-cloze__text"`)
  i `openAnsweredCloze` po zmianie stukania;
- `lesson-sentence-audio.spec.ts` — przypadki cloze nadal przez bank (`kid-lesson-cloze-option`)
  i `kid-lesson-cloze-gap` (test id zostaje na przycisku luki).

Ruch: `kid-motion.spec.ts` bez zmian, chyba że wejście linii wymaga przypadku (decyzja w planie).

Brak odbioru na fizycznym urządzeniu raportujemy jawnie.

## 8. Dokumentacja

- `docs/architecture.md` §19: w „Pary i grupy (Etap 7)” i „Uzupełnij tekst (Etap 10)” opis Kid UI
  (luka w tekście jako przycisk; pary jako dwie kolumny z linią, stan `PairState`).
- `AGENTS.md`: bez zmian, chyba że plan dopisze krótką wzmiankę o `PairLines` przy zasadach `zoom`
  (pomiar w `offset*`).

## 9. Ryzyka

- **Długie opisy na telefonie** (prawa kolumna ok. 190 px przy 390 px): kafelki wysokie, linie strome,
  a drugi koniec linii może być poza ekranem przy długiej liście. Akceptowane jak w zeszycie; E2E
  sprawdza osiągalność. Jeśli okaże się nieczytelne w praktyce, kolejny krok to mniejszy krój w prawej
  kolumnie przy długich tekstach — poza tym zakresem.
- **Linie a układ asynchroniczny** (fonty, obrazy, zmiana skali): `ResizeObserver` na kafelkach
  i kontenerze; E2E sprawdza końce linii po zmianie rozmiaru okna.
- **Interlinia tekstu z lukami** zwiększa wysokość tekstu; sprawdzamy dok feedbacku (karta wyniku nie
  zasłania tekstu) istniejącymi przypadkami docku.
