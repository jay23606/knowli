# „Uzupełnij tekst” i „Połącz w pary” — naturalne stukanie w Kid UI — design

Data: 2026-11-02. Status: projekt zaakceptowany (wersja 3 — po recenzji trzech krytyków specu: mechanizm,
UX dziecka na urządzeniach, testy i regresje; poprawki z recenzji planu: zarezerwowany wiersz podpowiedzi luk,
przyklejony bank w niskim landscape, klasa pustej luki, podłoga lewej kolumny `min-content`).
Powiązane: `docs/architecture.md` §19 (punkty „Pary i grupy (Etap 7)” i „Uzupełnij tekst (Etap 10)”),
`docs/superpowers/specs/2026-10-30-kid-ui-large-screens-design.md` (skala `zoom`, §4.4),
`docs/superpowers/specs/2026-10-31-kid-ui-large-screens-followups-design.md` (`--kid-reading-measure`).

## 1. Cel

Oba ćwiczenia przypisań w lekcjach mają dziś pośrednią listę przycisków „Wybierz” / „Wybierz słowo”
między materiałem a bankiem słów. Dziecko patrzy na zdanie albo na słowo po lewej, a stuka w osobny,
duży, pusty przycisk, który powtarza ten sam cel drugi raz. Właściciel ocenił to jako „mega nienaturalne”.

Ustalenia z właścicielem (2026-11-02, na podstawie klikalnych makiet w czacie):

- **„Uzupełnij tekst” (`lesson_cloze`)**: luka **w zdaniu** jest jedynym celem stukania (makieta 1).
  Znika lista miejsc pod tekstem, numery luk i podpowiedź „Które słowo pasuje do luki N?”.
- **„Połącz w pary” (`lesson_match`)**: **dwie kolumny kafelków łączone linią, jak w zeszycie ćwiczeń**
  (makieta C). Odrzucone: kafelki z kolorowymi znaczkami par (2A), lżejsza wersja obecnych wierszy (2B),
  jedno słowo naraz (D).
- Zaznaczony kafelek jest **wyraźnie wypełniony kolorem**, a przy każdym kafelku stoi kropka-zaczep po
  stronie drugiej kolumny.

## 2. Zakres

W zakresie: widoki `LessonClozeView` i `LessonMatchView`, czysty stan w `assignment-state.ts`,
`AssignmentPool.tsx`, nowy `PairLines.tsx`, style w `packages/kid-ui/src/styles.css`, komunikaty Kid UI
w `packages/contracts/src/messages.ts` (tylko teksty widoku), testy komponentów i E2E (w tym fixture'y),
dokumentacja.

Poza zakresem (bez zmian):

- kontrakty DTO, API, serwer, ocena (`evaluateAssignment`), migracje, MCP i `SKILL.md` — odpowiedź to nadal
  `modality: "assignment"` z przypisaniami `{ itemId, targetId }` wysyłanymi po „Sprawdź”, w tej samej
  kolejności (pary: lewy → prawy w kolejności lewej kolumny; luki: luka → słowo w kolejności luk).
  Serwer używa wyłącznie `lessonMatchInstruction` i `lessonClozeInstruction` (polecenie zadania i tekst
  nagrania pytania, `question-read-text.ts`) — tych tekstów nie zmieniamy;
- „Pogrupuj” (`lesson_group`) — zachowanie i wygląd bez zmian; zmienia się najwyżej nazwa wspólnej klasy
  puli (§6);
- natychmiastowa ocena każdej pary lub luki: Kid DTO nie ma klucza, a wynik próby to jeden werdykt
  z `correctText`. Zielone/czerwone linie i luki z makiet **nie** wchodzą do zakresu; wynik pokazuje
  dotychczasowy panel feedbacku;
- przeciąganie linii palcem (drag) — tylko stukanie, jak we wszystkich ćwiczeniach przypisań.

## 3. Wspólny język stanów

Ten sam wygląd znaczy to samo w obu ćwiczeniach (występują po sobie w jednej sesji):

| Stan | Znaczenie | Wygląd (tokeny M3) |
| --- | --- | --- |
| wolny | czeka na wybór | `kid-lesson-block`: obwódka `outline`, tło `surface-container-high` |
| **aktywny** | „teraz tu” — aktywna luka / zaznaczony kafelek | tło `primary`, tekst `on-primary`, obwódka `primary`, waga `--kid-type-answer-weight` |
| gotowy | luka wypełniona / kafelek w parze | `kid-lesson-block--placed`: obwódka `primary`, tło `secondary-container` |
| wyłączony | dok feedbacku / `busy` | jak dziś dla `LessonBlockButton` |

Selektor stanu aktywnego ma specyficzność wyższą niż `.kid-ui .kid-lesson-block:active`
(`styles.css`), żeby wciśnięcie nie zmieniało tła pod tekstem `on-primary`. Poza blokiem tokenów nie ma
literałów koloru.

## 4. „Uzupełnij tekst” — luka w zdaniu jako przycisk

### 4.1 Zachowanie

- Każda luka w tekście to `LessonBlockButton` (`kid-lesson-cloze__gap`, test id `kid-lesson-cloze-gap`)
  w wierszu tekstu. Pusta luka nie ma treści poza obwódką; **aktywna** pusta luka pokazuje „?”
  (`kid-lesson-cloze__gap-mark`, `aria-hidden`).
- Model stanu bez zmian (`matchState`, `selectSlot`, `placeRight`, `matchPool`, `rightOf`, `matchComplete`,
  `matchAssignments`): na starcie aktywna jest pierwsza luka; słowo z banku trafia do aktywnej luki,
  a aktywna staje się następna pusta (w kolejności luk, potem od początku); dotknięcie wypełnionej luki
  oddaje słowo do banku i czyni lukę aktywną; dotknięcie pustej luki czyni ją aktywną.
- Bank słów (`AssignmentPool`, test id `kid-lesson-cloze-pool`, opcje `kid-lesson-cloze-option`) stoi pod
  tekstem. „Sprawdź” aktywne przy komplecie.
- Gdy wszystkie luki są wypełnione, bank jest wyłączony (brak aktywnej luki), a pod bankiem stoi
  podpowiedź `lessonClozeChangeHint` („Dotknij luki, żeby zmienić słowo.”, `kid-lesson-cloze-hint`,
  `aria-live="polite"`) — o ile w banku zostały słowa i widok nie jest wyłączony (dok, `busy`).
  Wiersz podpowiedzi jest zawsze w DOM i ma zarezerwowaną wysokość (jak w parach, §5.2), więc
  pojawienie się i zniknięcie tekstu (np. przy „Sprawdź”) nie zmienia wysokości treści.
- Znikają: lista `kid-lesson-cloze__slots` z `AssignmentSlot` (`kid-lesson-cloze-slot`), numery luk
  (`kid-lesson-cloze__gap-number`) i podpowiedź „Które słowo pasuje do luki N?”.

### 4.2 Wygląd i układ

- Luka: `display: inline-flex`, `vertical-align: middle`, `min-height: 48px`, własne `line-height: 1.2`
  i pionowy padding (nie dziedziczy interlinii akapitu), `min-inline-size` ok. 4,5 em — **także po
  wypełnieniu**, żeby krótkie słowo nie przesuwało reszty tekstu. Długie wyrażenie zawija się w środku
  przycisku (`max-inline-size: 100%`, `overflow-wrap: break-word`), nie wychodzi poza kolumnę.
  Krój i rozmiar luki dziedziczy z tekstu (`font: inherit`), żeby wstawione słowo nie było mniejsze
  od zdania.
- Stany wg §3: pusta (`kid-lesson-cloze__gap--empty`) = wolny z dolną obwódką 2 px przerywaną
  `outline` (tylko w tym stanie), aktywna = aktywny z „?”, wypełniona = gotowy.
- Tekst `kid-lesson-cloze__text`: przycisk `inline-flex` sam powiększa swój wiersz, więc wiersze nie
  nachodzą na siebie przy żadnej interlinii. `line-height` akapitu podnosimy tylko po to, żeby wiersze
  z luką i bez luki miały zbliżony odstęp — najwyżej 2,0 (wartość z pomiaru w E2E). Zostaje
  `max-inline-size: var(--kid-reading-measure)` i wyśrodkowanie bloku.
- **Niski landscape** (wysokość < 480 i szerokość ≥ 600): tekst i bank stoją obok siebie
  (`kid-lesson-cloze__main` | `kid-lesson-cloze__bank`, ok. 3fr/2fr), a bank jest przyklejony
  (`position: sticky; top: 0`), żeby aktywna luka i bank były widoczne jednocześnie także po
  przewinięciu tekstu. W pozostałych klasach bank stoi pod tekstem.

### 4.3 Dostępność i `lang`

- Nazwa dostępna przycisku luki pochodzi z treści, bez `aria-label` (polski opis w `aria-label` na
  elemencie z `lang="en-GB"` czytałby angielski głos): ukryty wizualnie polski fragment „Luka {n}:” /
  „Luka {n}: pusta, wybierz słowo”, a wstawione słowo w `<span lang={contentLocale}>`. Sam przycisk
  bez `lang`. Szablony w `messages.kid` mogą zostać rozbite na części potrzebne do tej konstrukcji.
- `aria-pressed` = luka aktywna.
- Etykiety opcji banku bez zmian: `lessonClozePlace` („Wstaw {word} do luki {n}”).

## 5. „Połącz w pary” — dwie kolumny i linie

### 5.1 Reguły stukania

Zasada ogólna: **zaznaczenie nigdy samo nie zmienia par; para powstaje dopiero przy stuknięciu
w drugiej kolumnie i wtedy zastępuje wcześniejsze pary obu kafelków.** Dzięki temu nie ma przypadków
nieokreślonych, a pomyłkowe stuknięcie niczego nie psuje.

| Zaznaczenie | Stuknięty kafelek | Wynik |
| --- | --- | --- |
| brak | dowolny (wolny lub w parze) | kafelek zostaje zaznaczony; pary bez zmian |
| X | X | zaznaczenie znika |
| X | inny w tej samej kolumnie (wolny lub w parze) | zaznaczenie przechodzi na stuknięty; pary bez zmian |
| X | Y w drugiej kolumnie (wolny lub w parze) | usunięte zostają dotychczasowe pary X i Y, powstaje para X–Y, zaznaczenie znika |

- Kierunek dowolny: można zacząć od lewej albo od prawej kolumny.
- Linię „przenosi się” przez zaznaczenie kafelka i stuknięcie nowego odpowiednika; osobnego odłączania
  nie ma (wysyłka i tak wymaga kompletu, a dystraktor zwalnia się, gdy jego lewy kafelek dostanie inną parę).
  To świadoma różnica wobec makiety, w której stuknięcie połączonego kafelka od razu kasowało linię.
- „Sprawdź” aktywne, gdy każdy lewy kafelek ma parę (dystraktory mogą zostać wolne). Wysłanie próby
  czyści zaznaczenie.
- Po „Sprawdź” (dok) kafelki są wyłączone, linie zostają (kolor `primary`). Ponowna próba
  (`useRetryReset`) czyści pary i zaznaczenie i ustawia fokus na pierwszym kafelku.

### 5.2 Podpowiedź

- `kid-lesson-match-hint` (`kid-hint`, `aria-live="polite"`) stoi **pod kolumnami**, w wierszu
  o zarezerwowanej wysokości (pusty wiersz ma tę samą wysokość), więc pojawienie się podpowiedzi
  nie przesuwa kafelków.
- Tekst tylko przy zaznaczeniu i gdy nie jest wyłączone: `lessonMatchPickOther` („Teraz dotknij tego,
  co pasuje.”). Bez zaznaczenia wiersz jest pusty.

### 5.3 Układ

- Kontener `kid-lesson-pair` (test id `kid-lesson-match`, `position: relative`): siatka
  `minmax(min-content, 2fr) var(--kid-pair-gutter) minmax(0, 3fr)` — lewa kolumna węższa, ale
  nie węższa od najdłuższego słowa (przy `overflow-wrap: break-word` `min-content` to najdłuższe
  słowo), więc pojęcia nie łamią się w środku; prawa szersza (opisy do 100 znaków). Środkowa kolumna
  to pusty pas na linie. Podpowiedź (§5.2) stoi poza siatką, w zewnętrznym opakowaniu widoku.
- `--kid-pair-gutter`: 48 px w compact (<600), 72 px od medium. Wartość bazowa w bloku tokenów,
  nadpisanie w osobnej regule `@media` poza blokiem (wzorzec istniejących tokenów nadpisywanych
  w media queries; test tokenów tnie blok na pierwszym `\n}`).
- Kolumny to listy (`role="list"`, etykiety `lessonMatchLeft` i `lessonMatchPool`), rozciągnięte na
  wysokość wiersza siatki; kafelki rozłożone `justify-content: space-around`, więc krótsza kolumna
  rozkłada się na wysokość dłuższej (linie mniej strome, jak w zeszycie). Odstęp minimalny 10 px.
- Kafelki: `kid-lesson-pair__item`, cała szerokość kolumny, ≥ 48 px (`kid-lesson-block` ma 56 px).
  W compact padding 8 px × 10 px i rozmiar tekstu `--kid-type-title-sm-size` zamiast
  `--kid-type-title-md-size`. Zawijanie `overflow-wrap: break-word` — słowo łamie się tylko,
  gdy samo nie mieści się w kolumnie.
- Długie opisy na telefonie wydłużają kolumny; treść przewija się w kontenerze materiału, akcje są
  osiągalne (AGENTS.md). Linie są częścią przewijanej treści.

### 5.4 Linie i kropki (`PairLines`)

- `PairLines.tsx` w `packages/kid-ui/src/exercises/lesson/`: jedna warstwa `<svg>` (`kid-lesson-match-lines`,
  `aria-hidden="true"`, `pointer-events: none`, `position: absolute; inset: 0`, `overflow: visible`)
  jako **ostatnie** dziecko `kid-lesson-pair` (jego `useLayoutEffect` biegnie po podpięciu refów kafelków),
  nad kafelkami.
- Rysuje:
  - przy każdym kafelku kropkę (`kid-lesson-match-dot`, `data-side`, `data-item-id`) na środku krawędzi
    zwróconej do pasa: wolna — obwódka `outline`, wypełnienie tłem; w parze — wypełniona `primary`;
    zaznaczona — większa, wypełniona `primary`. Promienie jako stałe w `PairLines` (6 i 8 px);
  - dla każdej pary linię prostą 4 px `primary` z zaokrąglonymi końcami (`kid-lesson-match-line`,
    `data-left-id`, `data-right-id`).
  Kolory przez klasy CSS z tokenami. Kropka wchodzi do połowy w kafelek, więc stuknięcie w jej
  wewnętrzną połowę trafia w kafelek; zewnętrzna połowa i pas są martwe (akceptowane).
- Liczba kropek i linii wynika ze stanu (renderowana zawsze); współrzędne z pomiaru, domyślnie 0
  (jsdom nie ma `ResizeObserver` i zwraca zerowe `offset*` — test komponentu sprawdza liczbę
  i atrybuty, nie geometrię).
- **Geometria w pikselach wewnętrznych**: pozycja kafelka = suma `offsetLeft/offsetTop` po łańcuchu
  `offsetParent` aż do `kid-lesson-pair`, plus `offsetWidth/offsetHeight`. To te same piksele co
  współrzędne SVG pod CSS `zoom` (AGENTS.md: `offset*` są wewnętrzne) i — w przeciwieństwie do
  `getBoundingClientRect()` — ignoruje `whileTap` scale i transformacje wejścia. Opakowania kafelków
  (`listitem`) zostają bez pozycjonowania i transformacji. Wciśnięty kafelek lekko się zmniejsza,
  a jego kropka stoi w miejscu — akceptowane.
- Przeliczenie: w `useLayoutEffect` po każdej zmianie par/zaznaczenia oraz w callbacku
  `ResizeObserver` (kontener i kafelki; nigdy sam SVG — pętla). Callback zapisuje współrzędne wprost
  w atrybuty elementów przez refy (bez `setState`, żeby nie było klatki ze starymi liniami). Strażnik
  `typeof ResizeObserver === "undefined"` jak w `ExerciseFrame`.
- Ruch: nowa linia pojawia się przez `opacity` (`m.line`, tokeny z `kid-motion.ts`); bez `pathLength`
  i animacji długości. `MotionConfig reducedMotion="user"` nie wyłącza animacji `opacity`, więc
  `PairLines` sprawdza `useReducedMotion()` i wtedy rysuje linię od razu (`initial={false}`).

### 5.5 Stan (`assignment-state.ts`)

Nowy czysty stan obok istniejącego (który zostaje dla luk):

```ts
export type PairSide = "left" | "right";
export interface PairState {
  readonly left: readonly LessonItem[];
  readonly right: readonly LessonItem[];
  /** id lewego → id prawego. */
  readonly pairs: ReadonlyMap<string, string>;
  readonly selected: { readonly side: PairSide; readonly id: string } | null;
}
export function pairState(left, right): PairState;              // bez par i zaznaczenia
export function tapPairItem(state, side, id): PairState;        // tabela §5.1; nieznane id → bez zmian
export function clearPairSelection(state): PairState;
export function pairOf(state, side, id): LessonItem | null;     // odpowiednik w parze
export function pairComplete(state): boolean;                   // każdy lewy w parze
export function pairAssignments(state): Assignment[];           // w kolejności lewej kolumny
```

### 5.6 Dostępność i `lang`

- Kolejność fokusu: lewa kolumna, potem prawa; Enter/Spacja = stuknięcie; `aria-pressed` = zaznaczony.
- Nazwa dostępna z treści, bez `aria-label` (jak §4.3): tekst elementu w `<span>` z `lang={contentLocale}`
  dla lewej kolumny (prawa bez `lang`, bo bywa polska), a polskie dopowiedzenia ukryte wizualnie:
  - w parze: „, połączone z: {odpowiednik}” (odpowiednik w swoim `lang`);
  - wolny, gdy zaznaczony jest kafelek z drugiej kolumny: „, połącz z: {zaznaczony}”.
- Linie i kropki są dekoracyjne; stan pary niesie nazwa dostępna.

### 5.7 Test id

| Element | Test id |
| --- | --- |
| kontener | `kid-lesson-match` (bez zmian) |
| kafelek lewy | `kid-lesson-match-left` (bez zmian, teraz przycisk) |
| kafelek prawy | `kid-lesson-match-right` (nowy; znika `kid-lesson-match-option` i `kid-lesson-match-slot`) |
| SVG / kropka / linia | `kid-lesson-match-lines` / `kid-lesson-match-dot` / `kid-lesson-match-line` |
| podpowiedź | `kid-lesson-match-hint` |

## 6. Komunikaty, wspólne komponenty i CSS

- Komunikaty dodane: `lessonMatchPickOther`, `lessonMatchLeft` („Słowa do połączenia”),
  `lessonClozeChangeHint`, części nazw dostępnych z §4.3/§5.6.
- Usunięte (sprawdzone: używane wyłącznie w tych dwóch widokach): `lessonMatchEmptySlot`,
  `lessonMatchChooseSlot`, `lessonMatchActiveHint`, `lessonMatchPairs`, `lessonMatchPlace`,
  `lessonMatchRemove` (zastąpione częściami nazw), `lessonClozeEmptySlot`, `lessonClozeGapEmpty`,
  `lessonClozeGapFilled`, `lessonClozeChooseSlot`, `lessonClozeRemove`, `lessonClozeActiveHint`,
  `lessonClozeGaps` oraz już nieużywany `lessonClozeText` — o ile plan nie użyje go jako etykiety akapitu.
- `AssignmentSlot` znika (używają go tylko te dwa widoki). `AssignmentPool` i `AssignmentCheckButton`
  zostają.
- CSS: bank luk używa dziś klasy `kid-lesson-match__pool`, a `.kid-lesson-match` dzieli reguły
  z `.kid-lesson-group`. Wspólna pula dostaje klasę `kid-lesson-assign__pool` (luki i grupy), reguły
  `.kid-lesson-group*` zostają nietknięte, a reguły `.kid-lesson-match*` zastępują reguły
  `.kid-lesson-pair*`.

## 7. Granice i zgodność

- Zmiany wyłącznie w `packages/kid-ui`, tekstach `packages/contracts/src/messages.ts`, testach i docs.
  Kid UI bez Mantine, bez surowych `<button>` (kafelki i luki to `LessonBlockButton`), bez literałów
  koloru/rozmiaru fontu/promienia poza blokiem tokenów (`tests/kid-design-tokens.test.ts`), bez surowych
  `vh/vw`.
- Format próby bez zmian, więc stare i nowe klienty działają z tym samym serwerem.
- API → MCP → skill: bez wpływu (brak zmiany endpointów, DTO i znaczenia danych; panel rodzica nie
  renderuje tych widoków).

## 8. Testy

Jednostkowe (Vitest):

- `assignment-state.test.ts` — każdy wiersz tabeli §5.1 w obu kierunkach (w tym zastąpienie par obu
  kafelków i zwolnienie dystraktora), `clearPairSelection`, nieznane id, kompletność z wolnymi
  dystraktorami, kolejność przypisań;
- `lesson-views.test.tsx` (przepisane przypadki par, m.in. dzisiejszy „match marks the left column
  only”):
  - luki: przyciski w tekście, brak listy miejsc i numerów, wypełnianie i przesuwanie aktywnej, oddanie
    słowa, podpowiedź tylko przy komplecie z wolnymi słowami, nazwy dostępne i `lang` na spanach
    (nie na przycisku), `aria-pressed`, dok i `busy` wyłączają luki i bank, fokus po retry na pierwszej
    luce;
  - pary: tabela §5.1 przez kliknięcia, stany wizualne (klasy), podpowiedź tylko przy zaznaczeniu,
    „Sprawdź” przy komplecie z wolnymi dystraktorami wysyła przypisania w kolejności lewej kolumny
    i czyści zaznaczenie, `busy`/dok wyłączają kafelki, reset i fokus po retry, `PairLines`: kropka na
    kafelek i linia na parę z właściwymi `data-*`.

E2E (projekt `mocked`, istniejące pliki — bez nowych plików i zmian partycji):

- `lesson-cloze-layout.spec.ts` — viewporty 320×568 (obok obecnych 390×844, 844×390, 768×1024,
  1280×800) i wariant rozdziału z `contentLocale`: luki ≥ 48 px w kontenerze tekstu; po wstawieniu
  najdłuższego wyrażenia luka zawija się w kolumnie; żadna luka nie nachodzi na prostokąty tekstu
  (Range `getClientRects`) sąsiednich wierszy; bank i „Sprawdź” osiągalne; brak poziomego przepełnienia;
  przy 844×390 aktywna luka i bank są jednocześnie w viewporcie;
- `lesson-assignment-layout.spec.ts` — pary 5 × 7 z opisami do 100 znaków na 320×568, 390×844, 844×390,
  768×1024, 1280×800: dwie kolumny obok siebie, kafelki ≥ 48 px, brak poziomego przepełnienia, żadne
  słowo lewej kolumny nie jest rozbite na dwa wiersze (Range per słowo), osiągalność po przewinięciu;
  przełączanie zaznaczenia nie przesuwa kafelków (prostokąty przed i po); końce linii: `x1/y1/x2/y2`
  i środki kropek przeliczone na ekran (prostokąt SVG + współrzędne × `currentCSSZoom`) leżą na środkach
  krawędzi właściwych kafelków (`getBoundingClientRect`, tolerancja 2 px) — także przy 2560×1440 po
  `waitForKidScale(1.6)` i po zmianie rozmiaru okna; przepisany test „after a mistake” przez nowy helper;
- helper: `tapPoolAndCheck` zostaje dla luk; dla par nowy `pairAndCheck` (stuknięcia lewy → prawy)
  w `helpers/lesson-assignment-task.ts`;
- `kid-large-screen.spec.ts` — `READING_MEASURE_CASES` dla cloze: `exclude` znaku „?”
  (`.kid-lesson-cloze__gap-mark`) zamiast numerów, pomiar od nowa; przypadki docku i `openAnsweredCloze`;
- **fixture'y przepełnienia**: usunięcie listy miejsc skraca widok luk o ok. 250 px. Przypadki, które
  wymagają przepełnienia — „the material scrolls before the verdict” (1280×600, 1536×730),
  „overflowing cloze” w `lesson-sentence-audio.spec.ts` (`[data-frame-full]` przy 1280×800) i tablet
  1024×1366 z `fits: "space"` — dostają dłuższy tekst w fixture'ach (`helpers/kid-fixtures.ts` i fixture
  w specu), **bez luzowania asercji**;
- `lesson-sentence-audio.spec.ts` — pozostałe przypadki cloze nadal przez bank i `kid-lesson-cloze-gap`.

Ruch: `kid-motion.spec.ts` bez zmian, chyba że plan doda przypadek wejścia linii.

Brak odbioru na fizycznym urządzeniu raportujemy jawnie.

## 9. Dokumentacja

- `docs/architecture.md` §19: w „Uzupełnij tekst (Etap 10)” zamiast „luka w tekście jako znacznik
  (bez przycisku); jedna kolumna na każdym ekranie” — luka jako przycisk, bank pod tekstem (obok w niskim
  landscape); w „Pary i grupy (Etap 7)” — pary jako dwie kolumny z linią, stan `PairState`.
- `AGENTS.md`: bez zmian (zasady `zoom` i `offset*` już obejmują `PairLines`).

## 10. Ryzyka i przyjęte ograniczenia

- **Długie opisy na telefonie**: kafelki wysokie, kolumny długie, drugi koniec linii może być poza ekranem.
  Łagodzą to rozłożenie krótszej kolumny i mniejszy krój w compact; reszta akceptowana jak w zeszycie.
- **Feedback po błędzie**: `correctText` z pięcioma długimi parami jest długi i przewija się w karcie
  wyniku; bez oceny per para dziecko nie widzi, która linia była zła. Przyjęte w tym zakresie.
- **Interlinia tekstu z lukami** wydłuża tekst; dok sprawdzają istniejące przypadki docku.
- **Opcje banku luk** zachowują polski `aria-label` („Wstaw {word} do luki {n}”) na przyciskach
  z `lang={contentLocale}` — ten sam problem głosu co w §4.3, poza zakresem tej zmiany.
