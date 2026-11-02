# AGENTS.md — Knowli / Umiem!

Instrukcje dla agentów pracujących w tym repozytorium. Umieść ten plik w katalogu głównym repozytorium.

## Policy

- Nie wypychaj zmian bezpośrednio do `main` i nie scalaj PR bez polecenia właściciela. Osobny PR dokumentacyjny wymaga wyraźnego polecenia; sposób zakończenia implementacji uzgodnij w ramach danego zadania.

## Running and verifying

- Aby skopiować brakujący `.env` w worktree bez instalacji zależności, uruchom `node scripts/setup-worktree.cjs --skip-install`; wywołanie bez tej opcji instaluje zależności, gdy brak `node_modules`.
- Pełny suite E2E uruchamiaj szybko przez `pnpm test:e2e:shards`: jeden build produkcyjny, równolegle projekt `mocked` (API zaślepione w przeglądarce, wielu workerów) i kosze czasowe projektu `real` (`REAL_BUCKETS`, każdy kosz z własnym światem: baza, `next start`, worker) — to najszybszy lokalny przebieg: ok. 3 min (167 s łącznie z buildem) dla całego zestawu: 535 testów przechodzi (413 `mocked` + 122 `real`), a 13 zrzutów `screenshot:` w `kid-large-screen.spec.ts` jest pomijanych bez `UMIEM_E2E_SCREENSHOTS` (pomiar 2026-11-01; najdłuższy kosz `real-1` z `kid-flow.spec.ts` ok. 2 min 40 s, `mocked` ok. 2 min); te same kosze `real` jedzie CI, a projekt `mocked` biegnie tam w 3 shardach Playwrighta (`--shard`, joby `e2e (mocked-1…3)`) — wymagany check `e2e (mocked)` raportuje job bramki `e2e-mocked`, więc zmiana liczby shardów nie wymaga zmian w regułach brancha (kompletności shardów i nazwy bramki pilnuje `spec-projects.test.ts`). Opcje: `--buckets=N` (projekt `real`; domyślnie liczba koszy, inna wartość wraca do `--shard` Playwrighta), `--mocked-workers=N`, `--grep=<wzorzec>`, `--base-port=N`. Pojedynczy shard `mocked` jak w CI: `pnpm exec playwright test --project=mocked --shard=1/3`. Kosze równoważą zmierzone czasy plików, bo podział Playwrighta po liczbie testów daje nierówne shardy; gdy czasy plików mocno się zmienią, przelicz sumy czasów testów per plik z logów jobów `e2e (real-N)` w CI (tam kosze wyznaczają czas runu) i ułóż `REAL_BUCKETS` w `tests/e2e/spec-projects.ts` od nowa (LPT).
- Przy pracy nad pojedynczym specem domyślny przebieg (`pnpm exec playwright test <plik>`) buduje aplikację i stawia `next start`; do szybkiej iteracji bez buildu użyj `UMIEM_E2E_WEB_MODE=dev` (serwer deweloperski; pod E2E — `UMIEM_E2E=1` z global setupu, `next.config.ts` — działa bez trwałej pamięci podręcznej Turbopacka w `.next/dev` i bez wskaźnika deweloperskiego. Z tą pamięcią serwer wpadał po wcześniejszych przebiegach w pętlę „Compiled” i przeładowań strony, a wskaźnik zasłaniał przyciski na telefonie; gdyby pętla wróciła, usuń `apps/web/.next/dev`) albo po wcześniejszym `pnpm build` — `UMIEM_E2E_SKIP_BUILD=1`. Przed PR i tak wykonaj pełny przebieg `pnpm test:e2e:shards` na buildzie produkcyjnym.
- Zrzuty ekranu z `kid-large-screen.spec.ts` (`describe` „screenshots”) są pomijane, dopóki nie ustawisz `UMIEM_E2E_SCREENSHOTS=1`, a PNG trafiają do załączników testu, więc uruchom z reporterem `html` lub `json` (`list` i `github` ich nie zapisują).
- Nowy spec E2E dopisz do partycji w `tests/e2e/spec-projects.ts`: do `mocked` tylko wtedy, gdy całe API jest zaślepione w przeglądarce (`installKidUiFixture` albo route rodzica) i spec nie dotyka bazy, workera ani API spoza przeglądarki; w przeciwnym razie do `real`, do wybranego kosza `REAL_BUCKETS` (preferuj najlżejszy). Kompletności partycji i koszy pilnuje test jednostkowy `spec-projects.test.ts`.
- Testy integracyjne (`pnpm test:integration`) biegną lokalnie sekwencyjnie na jednym kontenerze Postgresa (ok. 4 min 40 s dla całego zestawu, pomiar 2026-10-26), bo pliki współdzielą bazę przebiegu i czyszczą tabele w `beforeEach`. W CI te same pliki jadą równolegle w koszach czasowych `INTEGRATION_BUCKETS` (`tests/integration-buckets.ts`, joby `integration (1–3)`, każdy z własnym kontenerem), a wymagany check `tests` jest bramką agregującą job `check` (typecheck, unit, build) i kosze integracji (jak `e2e (mocked)` sprawdza przez API także ostatnią próbę każdego kosza, więc ponowienie części jobów nie przepuści porażki). Nowy plik integracyjny dopisz do najlżejszego kosza; kompletności pilnuje test jednostkowy `integration-buckets.test.ts`. Pojedynczy kosz lokalnie: `UMIEM_INTEGRATION_BUCKET=<n> pnpm test:integration`. Gdy czasy plików mocno się zmienią, przelicz kosze z pomiaru `pnpm exec vitest run --config vitest.integration.config.ts --reporter=json` (czasy plików `endTime - startTime`, układ LPT).
- Równoległe przebiegi z innych sesji i worktree na tej samej maszynie dzielą demon Dockera. Kontenery testowe mają etykiety właściciela (`knowli.test-owner-pid`, `knowli.test-owner-host`, `knowli.test-owner-pidns` — WSL i Windows mają osobne przestrzenie pid nawet przy tej samej nazwie hosta; `tests/test-containers.ts`), a global setup usuwa tylko kontenery martwego procesu (kontener, którego właściciela nie da się sprawdzić, np. z innego hosta — dopiero po dobie), zawsze po ID, nie po nazwie. Kilka `pnpm test:integration` naraz nie kasuje więc sobie baz (do 2026-10-30 przebieg bez `UMIEM_TEST_RUN_ID` usuwał bazy wszystkich `knowli-it-*`). `pnpm test:e2e:shards` ma unikalne nazwy kontenerów, ale wspólne porty: drugi równoległy przebieg uruchamiaj z innym `--base-port` (np. `--base-port=25600`). Global setup E2E kończy się jawnym błędem, gdy port web lub health workera jest zajęty albo gdy `knowli-e2e` (gołe `pnpm test:e2e` bez `UMIEM_TEST_RUN_ID` i `UMIEM_E2E_PORT`) należy do trwającego przebiegu, także oznaczonego przebiegu z innego hosta, np. WSL.

## Tożsamość projektu i język

- Nazwa repozytorium i projektu technicznego: **Knowli**. Identyfikator repozytorium/katalogu: `knowli`.
- Polska nazwa aplikacji widoczna dla użytkownika: **Umiem!** — zachowuj wykrzyknik.
- Pierwsza wersja ma polski interfejs: `pl-PL`, w panelu rodzica i dziecka, komunikatach, błędach, onboarding oraz manifeście PWA. Nazwa aplikacji w manifeście: `Umiem!`.
- Angielski jest językiem materiału pierwszego modułu, a nie językiem interfejsu. Początkowa para języków materiału: `pl-PL` → `en-GB`.
- Kod, nazwy plików, identyfikatory, DTO, klucze API i tabel pisz po angielsku. Dokumentację projektu i komunikację z właścicielem pisz po polsku.
- Teksty interfejsu trzymaj w jednym prostym katalogu komunikatów współdzielonym przez odpowiednich klientów. Nie buduj teraz przełącznika języka ani rozbudowanego systemu tłumaczeń. Locale treści, wymowy i UI są osobnymi wartościami.
- Utrzymuj techniczne nazwy pakietów `@learning/*` przyjęte w architekturze; branding nie wymaga ich zmiany.

## Cel produktu

Prywatna, self-hostowana aplikacja rodzinna: rodzic określa materiał, AI przygotowuje zestaw, rodzic sprawdza i zatwierdza wynik, a dziecko uczy się podczas krótkich sesji. System pamięta próby i trudności konkretnego dziecka.

Pierwszy moduł to angielskie słownictwo dla początkującego dziecka w wieku około 8 lat. MVP obejmuje także przygotowanie do pisemnych sprawdzianów, profile dzieci i naukę bez mikrofonu. Priorytetem jest prostota i wiarygodne rozróżnienie nauki ze wsparciem od samodzielnego przypominania.

## Dokumenty i początek pracy

Przed zmianami przeczytaj sekcje dokumentów dotyczące zadania:

1. `docs/SPEC.md` — wymagania i kryteria akceptacji, wersja bazowa 1.1.
2. `docs/architecture.md` — decyzje i kontrakty, obecna wersja 1.3 (bazowo 1.2 po review).
3. `docs/schema.sql` — początkowy projekt bazy, wersja bazowa 1.2.
4. `docs/folder-structure.md` — uzgodnione granice i ścieżki.
5. `docs/implementation-plan.md` — małe zadania, zależności oraz regresje R01–R07.

Ten plik uzupełnia dokumenty w `docs/` o zasady pracy i branding. Nie zastępuje szczegółowych wymagań ani uzgodnionych kontraktów. Aktualne polecenia właściciela mają pierwszeństwo; istotne nowe ustalenia odzwierciedlaj w dokumentacji.

Na początku sprawdź stan repozytorium, istniejące skrypty i zakres zmian użytkownika. Nie nadpisuj jego niezwiązanych zmian. W razie sprzeczności wpływającej na model danych, prywatność lub publiczny kontrakt wyjaśnij ją przed implementacją zależnego fragmentu. Rutynowe wybory rozstrzygaj samodzielnie.

### Szybki start w worktree — zasady unikania redundancji i kosztów

W celu przyspieszenia pracy agentów i wyeliminowania powtarzalnych, kosztownych operacji przy każdym nowym zadaniu w worktree:

1. **Zależności (`node_modules`)**:
   - Przed wywołaniem instalatora **zawsze sprawdź, czy katalog `node_modules` już istnieje** (`Test-Path node_modules` lub `[ -d node_modules ]`). Jeśli istnieje, a Twoje zadanie nie modyfikuje `package.json` ani `pnpm-lock.yaml`, **bezwzględnie pomiń krok instalacji**.
   - Jeśli instalacja jest konieczna: używaj wyłącznie `corepack pnpm install --prefer-offline --frozen-lockfile` (lub `pnpm install --prefer-offline --frozen-lockfile`). **Nigdy nie uruchamiaj `npm install`** (niszczy dowiązania pnpm i generuje niepożądany `package-lock.json`).
2. **Kopiowanie pliku `.env`**:
   - Nowe worktree nie zawiera plików ignorowanych przez git. Przed uruchomieniem testów lub narzędzi upewnij się, że plik `.env` istnieje. W razie braku skopiuj go z głównego repozytorium: `node scripts/setup-worktree.cjs --skip-install` (lub skopiuj z `$(git rev-parse --git-common-dir)/../.env`).
3. **Celowane czytanie dokumentacji**:
   - Nie czytaj wszystkich 5 plików dokumentacji (`SPEC.md`, `architecture.md`, `schema.sql`, `folder-structure.md`, `implementation-plan.md`) od deski do deski na początku każdego małego zadania. Przeczytaj **wyłącznie sekcje bezpośrednio powiązane z Twoim zakresem zmian** (np. `schema.sql` przy modelowaniu bazy, `architecture.md` sekcja 19 przy lekcjach, `SPEC.md` sekcje dotyczące danego ekranu).
4. **Oszczędny baseline test**:
   - Podczas sprawdzania stanu początkowego **nie uruchamiaj pełnego monorepo ani testów e2e / Playwright**. Uruchom wyłącznie szybki test jednostkowy związany ze zmienianym modułem (np. `corepack pnpm vitest run <ścieżka-do-testu>` lub `pnpm vitest run <ścieżka-do-testu>`).

## Architektura i stack

- Next.js App Router, React i TypeScript w trybie strict; runtime serwera Node.js.
- PostgreSQL, Drizzle ORM i Drizzle Kit; Zod do walidacji granic i wyników AI.
- Tailwind CSS, PWA, pnpm workspaces, Vitest i Playwright.
- Panel rodzica (od 2026-10-29, plan `docs/superpowers/plans/2026-10-29-parent-ui-mantine.md`): Mantine 9 (komponenty, formularze, modale, powiadomienia, tryb jasny/ciemny) i TanStack Query przez `@orpc/tanstack-query`. Mantine, jego style i providery żyją wyłącznie w `apps/web/src/parent` i layoucie `app/parent` (pilnuje `tests/parent-mantine-scope.test.ts`); Kid UI nie zależy od Mantine. Mantine 9 wymaga Reacta 19.2+ także w kopii wbudowanej w Next.js — stąd Next 16.
- Modularny monolit w jednym repozytorium: proces `web`, proces `worker`, jedna baza PostgreSQL. Kolejka Graphile Worker korzysta z tej samej instancji bazy.
- Docker Compose/Coolify, prywatny trwały wolumen mediów; konkretne stabilne wersje przypnij podczas implementacji.

Granice kodu:

| Ścieżka | Odpowiedzialność |
| --- | --- |
| `apps/web` | Next.js: panel rodzica, host Kid UI i cienkie endpointy API |
| `apps/worker` | Długie zadania przygotowania materiałów |
| `packages/contracts` | Publiczne DTO, schematy Zod i typy bez sekretów |
| `packages/kid-ui` | Przenośny interfejs dziecka w React |
| `packages/server` | Domena, przypadki użycia, baza i adaptery providerów |

Kid UI używa jawnego `/api/v1/kid` i konfigurowalnego `baseUrl`. Nie importuje Next.js, Server Actions, bazy ani kodu serwerowego. Mikrofon, odtwarzanie i lokalne ustawienia mają adaptery platformowe. Dzięki temu przyszły host Capacitor może ponownie wykorzystać interfejs; nie buduj teraz aplikacji Android.

### Kid UI — system komponentów i responsywność (Material 3)

- Buduj ekrany dziecka wyłącznie ze wspólnych komponentów: `KidPage` jest jedynym właścicielem pomiaru viewportu; układ ekranu daje `KidScreen` (`Header`/`Content`/`Actions`, akcje pomocnicze przez `secondary`), układ zadania daje `ExerciseFrame`. Akcje: `ActionButton` (`variant` Material 3: filled/tonal/outlined/text; legacy `priority` nadal działa jako alias) — tokeny koloru, kształtu i typografii M3 żyją w jednym bloku `.kid-theme, .kid-ui` w `styles.css` (`--md-sys-color-*`, `--kid-color-*` dla sukcesu i grupy „warm”, `--kid-shape-*`, `--kid-type-*`), a `--kid-*` to aliasy kompatybilności. Paleta to pełny ciemny schemat wygenerowany z `@material/material-color-utilities` (parametry w komentarzu bloku) — regeneruj cały schemat zamiast stroić pojedyncze role. Poza tym blokiem nie ma literałów koloru, rozmiaru i wagi fontu ani promienia, a tekst nie używa kursywy — Nunito nie ma kroju italic, więc tekst pomocniczy wyróżnia `--kid-type-caption-weight` i kolor `--kid-muted` (pilnuje `tests/kid-design-tokens.test.ts`; wyjątek: deterministyczne `visuals/`). Ramki dekoracyjne używają `outline-variant` (`--kid-line`), a granice kontrolek interaktywnych `outline`. Stany opcji odpowiedzi (pending/correct/wrong, warstwy hover/focus/pressed) należą wyłącznie do `AnswerGrid`. `IconActionButton` dla samych ikon; odpowiedzi: `AnswerGrid`/`AnswerField`; postęp: `SessionProgress`; odsłuch instrukcji: `GuidanceButton`; nagrywanie: `SpeechRecordButton`; feedback: `AnswerFeedback*`/`SpeechFeedback*`. Bodziec pozostaje w widoku ćwiczenia i `MeaningVisualView` — nie twórz uniwersalnego `Question`. Wybór opcji wysyła odpowiedź natychmiast, bez przycisku „Sprawdź”; „Sprawdź” dotyczy tylko odpowiedzi pisemnych i formularzy lekcji.
- Nie dodawaj w `packages/kid-ui` surowych `<button>`, `<input>`, `<textarea>` ani `<select>` poza wnętrzem wspólnego komponentu ani jednorazowych układów ekranu obok `KidScreen`/`ExerciseFrame`. Nowy wzorzec interakcji najpierw rozszerza wspólny komponent i jego test. Style Kid UI są w pełni własne (CSS Modules i reguły globalne zakresowane do `.kid-ui`/`.kid-theme`); pakiet nie zależy od Mantine ani innej biblioteki komponentów (2026-10-26; pilnuje tego test `tests/kid-no-mantine.test.ts`).
- Ruch w Kid UI daje wyłącznie Motion (`motion/react`, komponenty `m.*`, `LazyMotion` + `domAnimation`, tokeny w `packages/kid-ui/src/motion/kid-motion.ts`): animuj tylko `transform` i `opacity`, bez propsa `layout` i animacji wymiarów. `MotionConfig reducedMotion="user"` w `KidApp` jest obowiązkowy; fixture E2E emuluje reduced-motion, więc specyfikacje geometrii mierzą układ statyczny, a zachowanie animacji pokrywa osobny spec `kid-motion.spec.ts`.
- Stosuj adaptację w duchu Material 3: klasy szerokości compact `<600`, medium `600–839`, expanded `≥840` oraz niską wysokość `<480` (w tym landscape telefonu). Minimum celu dotykowego to 48 px, główna akcja co najmniej 54 px. Uwzględniaj `safe-area-inset-*`, klawiaturę przez `visualViewport`, zoom gestem oraz `prefers-reduced-motion`. Treść nie może uciekać poza ekran ani być trwale przycięta przez `overflow: hidden`: ma się przearanżować, rosnąć albo być osiągalna przez scroll, a akcje muszą pozostać osiągalne. Duże okno (spec `docs/superpowers/specs/2026-10-30-kid-ui-large-screens-design.md`): kolumna ekranu i sesji to `--kid-column-max-width` (560 px; 720 px od `≥840` × `≥480` oraz od szerokości `≥960` przy każdej wysokości, żeby kolumna tabletu nie malała po otwarciu klawiatury), a kafelki obrazków `--kid-visual-choice-max-size` (260 → 300 px); w wyborze obrazków od szerokości 600 px stopka rezerwuje wysokość panelu wyniku (`--kid-picture-dock-height` — pomiar prawdziwego panelu, części tekstowe w `rem`; poza powiększeniem gestem i bardzo niskim oknem), więc kafelki nie kurczą się przy werdykcie (3440×1440: stałe ≥ 290 px zamiast limitu 300); od `≥840` × `≥781` oraz na dotykowym tablecie od `≥960` × `≥480` (`pointer: coarse` — zostaje po otwarciu klawiatury) rama zadania jest zwarta (kolumna flex: instrukcja, odpowiedzi i stopka razem u góry, bez pustego pasa; ten sam warunek ma zaokrąglony panel wyniku), przy myszy lub touchpadzie z odstępem od góry `--kid-compact-frame-offset` (90 px; bez zadań z dużą ilustracją, kart i powiększenia gestem; ustępuje pierwszy, zanim materiał zacznie się przewijać), a pole z brakującymi literami łamie się tylko między słowami (`.kid-letter-word`). Karta wyniku w panelu `overlay` rośnie w wolne miejsce pod odpowiedzią: `ExerciseFrame` ustawia na nakładce `--kid-feedback-card-max` (czysta funkcja `feedbackCardMax` w `exercises/feedback-card-space.ts` z geometrii niezależnej od rezerwy, przewinięcia i odstępu, liczona od nowa przy zmianie rozmiaru ramy, treści albo struktury panelu; `ResizeObserver` obserwuje też ramę), a CSS bierze `max(min(36vh, 300px), zmienna)` — panel nie zasłania treści (w zwykłej ramie zostaje ≥ 28 px pod nią), a w zwartej kończy się ≥ 12 px nad dolną krawędzią ramy. Gdy dok pokazuje wyjaśnienie błędu (lekcje gramatyki i rozdziału), wiersz wyjaśnienia `.kid-feedback-pinned` stoi poza przewijaną kartą, między górnym wierszem a akcjami, więc jest widoczny bez przewijania; przewija się tylko karta wyniku. `ExerciseFrame.syncCardSpace` liczy go jako resztę panelu, a w panelu-nakładce ustawia `--kid-feedback-pinned-height` (wysokość wiersza z odstępem), o którą maleje dotychczasowy limit karty — panel z wyjaśnieniem nie zasłania więcej materiału niż bez niego. Długa podpowiedź nadal może się przewijać w karcie: okna od FullHD do 34" mają ok. 900 px wewnętrznych wysokości, a laptop poniżej 781 px i telefon wolnego miejsca nie mają. W trybie przewijanej strony (powiększenie gestem, bardzo niskie okno) zmiennej nie ma, a panel zastępuje akcje na całą szerokość stopki. Przewinięcie korygujące i bramka rezerwy działają od zakładki 1 px ekranu (spec `2026-10-31-kid-ui-dock-followups-design.md`). Wiersz tekstu karty lekcji i tekstu z lukami ma ok. 60 znaków: `max-inline-size: var(--kid-reading-measure)` (44ch — `ch` to szerokość „0” = 0,6 em w Nunito, a średni polski znak ma ok. 0,45 em, więc `60ch` daje ok. 80 znaków), blok wyśrodkowany przez `margin-inline: auto` w selektorze z `.kid-ui` (`.kid-theme p` zeruje marginesy). Przy myszy lub touchpadzie (`(hover: hover) and (pointer: fine)`) `KidPage` — jedyny właściciel skali — powiększa całe okno CSS-owym `zoom` o `min(szerokość / 840, wysokość / 900)` w zakresie 1–1,6 (`computeKidLayoutScale` w `layout/viewport.ts`; inline `zoom`, `--kid-zoom` i `data-kid-scale`; telefony i tablety zawsze 1). Poza `KidPage` nic nie ustawia `zoom`. Pod `zoom` jednostki okna są mnożone przez skalę, więc w CSS i stylach inline pakietu pisz `calc(N * var(--kid-vh))` (także `--kid-dvh`, `--kid-svh`, `--kid-vw`) zamiast surowych `vh/dvh/svh/vw` (pilnuje `tests/kid-design-tokens.test.ts`), a tokenów nie rejestruj przez `@property`. Media queries porównują prawdziwe okno, container queries i `cq*` piksele wewnętrzne. W JS prostokąty (`getBoundingClientRect()`, prostokąty Playwrighta) są w pikselach ekranu, a `offset*`, `client*`, `scroll*`, `ResizeObserver` i długości zapisywane w stylach (także `left`/`top` elementu `position: fixed`) w wewnętrznych (długość ze stylu zoom mnoży przy rysowaniu: `left: 100px` przy skali 1,5 to 150 px ekranu). Przed zmieszaniem przelicz przez `toLayoutPx` (`layout/css-zoom.ts`), a wartość wziętą z prostokąta przed zapisem do stylu podziel przez `cssZoomOf(...)`. Przyjęty kompromis: Ctrl +/− na dużym monitorze (ok. 90–160%) prawie nie zmienia rozmiaru, bo powiększenie przeglądarki zmniejsza okno w px CSS, a skala maleje (spec §7).
- Zmianę layoutu Kid UI pokrywaj testami geometrii Playwright (m.in. `kid-responsive.spec.ts` i specyfikacje `*layout*`): assertuj prostokąty względem viewportu i kontenera materiału, brak przepełnienia poziomego oraz cele ≥48 px w portrait, landscape, tablecie i desktopie — sama widoczność elementu nie wystarcza. Symulacja nie jest odbiorem fizycznego urządzenia; brak takiego testu raportuj jawnie. Przy skali > 1 prostokąty Playwrighta są w pikselach ekranu: oczekiwaną skalę wpisuj na sztywno i czekaj na nią przed pomiarem (`waitForKidScale`, `tests/e2e/helpers/kid-frame.ts`); testy skali są w `kid-large-screen.spec.ts`. Ramę sesji porównuj z oknem prostokątem (`expectFrameFillsViewport`), nie `toHaveCSS("height", …)` — wysokość w stylu jest w pikselach wewnętrznych i przy skali > 1 nie równa się wysokości okna.

SDK dostawców występują tylko w adapterach za portami LLM, TTS, STT, pronunciation, images i mediów. Domena nie zna Azure/OpenAI. Nie wywołuj LLM przy każdym kliknięciu; generuje materiał, a sesję prowadzą jawne reguły serwera. Wyjątek (moduł lekcji, 2026-10-12): w lekcjach odpowiedź tekstowa niedopasowana deterministycznie do zatwierdzonych wariantów może zostać oceniona przez konfigurowalny model oceniający zgodny z OpenAI (proces web, port `AnswerGraderProvider`), z cache werdyktów `lesson_verdicts` i limitem wywołań na sesję; zamknięte ćwiczenia, trafienia cache i brak konfiguracji modelu nie wołają modelu, a awaria daje „nieocenione" bez kary. Nowy przedmiot nauki (np. historia) dodawaj jako moduł za interfejsem `SubjectModule` (katalog, typy ćwiczeń, normalizator, kategorie błędów, prompty, walidatory) + wpis w rejestrze — bez logiki przedmiotu w silniku lekcji; test architektoniczny pilnuje tej granicy. Szczegóły: `docs/architecture.md` sekcja 19 i `.kiro/specs/grammar-module/`.

Nie dodawaj mikroserwisów, Redis, osobnego backendu, ogólnego frameworka pluginów ani abstrakcji repozytorium dla każdej tabeli.

## Architektura nowych funkcji i refaktoryzacji

Rozwijaj Knowli jako **modularny monolit**, stosując proporcjonalnie **Feature Modules / Vertical Slices**, **Ports & Adapters** oraz **Functional Core, Imperative Shell**. Pozostajemy przy obecnym stacku i jednej bazie danych.

### Moduły i zależności

- Umieszczaj nową funkcję w module odpowiedzialnym za dany obszar produktu. Najpierw sprawdź istniejące granice; rozbuduj właściwy moduł zamiast tworzyć równoległą implementację.
- Moduł udostępnia małe, jawne publiczne API. Inne moduły korzystają z niego zamiast importować jego wewnętrzne pliki, modele ORM lub helpery.
- Zależności między modułami muszą być kierunkowe i bez cykli. Kod współdzielony wydzielaj dopiero przy rzeczywistym wspólnym znaczeniu; unikaj ogólnych katalogów `utils`, `common` i `shared` jako miejsca na dowolną logikę.
- Własność danych i reguł powinna być jednoznaczna. Zmiany danych należących do innego modułu prowadź przez uzgodnioną operację tego modułu.
- Istniejące ścieżki pakietów pozostają obowiązujące. Nowy moduł nie wymaga osobnego pakietu, procesu ani usługi.

### Obszary w `packages/server/src/modules`

Przypadki użycia serwera są pogrupowane w cztery obszary produktu. Nowy plik umieszczaj w obszarze właściciela reguły, a nie tam, gdzie akurat jest wywołujący:

| Obszar | Odpowiedzialność |
| --- | --- |
| `materials/` | Zestawy, elementy, rewizje, kryteria, przypisania, publikacja, generowanie treści i mediów, zasoby; autorstwo i nadzór nad materiałem lekcji w `materials/lessons/` |
| `learning/` | Sesje, zadania, próby, oceny, ekspozycje, projekcje postępu, kartkówki, rozliczenie aktywności, ustawienia polityki nauki; silnik sesji i prób lekcji w `learning/lessons/` |
| `family/` | Tożsamość i preferencje profili dzieci, uwierzytelnianie rodzica, tokeny integracyjne |
| `reporting/` | Modele odczytu postępu i aktywności oraz widoki startowe dziecka; bez własności źródłowych ocen i postępu |

- Dozwolone kierunki zależności: `reporting` → `learning` → `materials` oraz każdy obszar → `family`. Moduły źródłowe nigdy nie importują raportowania.
- Każdy obszar ma wąski `index.ts` jako publiczne API. Inny obszar importuje wyłącznie z barrela (`../materials`, `../family` itd.), nigdy z jego wewnętrznych plików; wewnątrz obszaru obowiązują bezpośrednie importy plików, a własny barrel jest zakazany. Nowy eksport potrzebny innemu obszarowi dopisz do barrela właściciela. Publiczne `packages/server/src/index.ts` komponuje eksporty pakietu z barreli obszarów; klienci web i worker korzystają wyłącznie z `@learning/server`.
- Własność jest semantyczna, nie tabelowa: np. pole polityki nauki w wierszu profilu należy do `learning` (zapis w `learning-settings.ts`, w tej samej transakcji co dotąd), a raportowanie może czytać tabele źródłowe własnymi zapytaniami, ale nie modyfikuje ocen ani postępu.
- Granic pilnuje `packages/server/src/modules/module-boundaries.architecture.test.ts` (kierunki, barrele, czystość `src/domain`) oraz węższe testy `*.architecture.test.ts` przy wydzielonych fragmentach. Po zmianie w `modules/` uruchom najpierw te szybkie testy, potem testy obszaru.
- Nazwane wyjątki — nie kopiuj ich jako wzorca ani nie „naprawiaj” przy okazji innego zadania: `config.ts` i adaptery providerów importują bezpośrednio `materials/lessons/lesson-generation-policy` (typ i parsowanie env potrzebne przed złożeniem usług); testy integracyjne importują kilka plików wewnętrznych obszarów wprost; root `index.ts` eksportuje też infrastrukturę (schemat, fabryki providerów) dla obecnych klientów i testów.

### Reguły biznesowe i adaptery

- Reguły oceniania, samodzielności, planowania sesji, powtórek i postępu implementuj jako funkcje domenowe nad jawnie przekazanymi danymi. Czas, losowość i identyfikatory przekazuj jawnie, gdy wpływają na decyzję.
- Domena nie importuje Next.js, oRPC, Drizzle, klientów bazy, SDK providerów ani konfiguracji środowiska. Używa typów domenowych; modele ORM i typy transportowe mapuj na granicach.
- Przypadki użycia koordynują autoryzację, odczyty, wywołanie reguł i zapisy. Kontrolery HTTP, procedury oRPC, MCP oraz zadania workera wywołują przypadki użycia; nie zawierają własnych kopii reguł biznesowych.
- Dostęp do infrastruktury zamykaj w adapterach. Porty definiuj według potrzeb operacji biznesowej, nie jako kopię API biblioteki ani repozytorium dla każdej tabeli.
- Nowe przedmioty dodawaj przez `SubjectModule` i rejestr. Nową mechanikę ćwiczenia rozwijaj jawnie w kontraktach, silniku, edytorze i widokach odpowiednich klientów.

### Transakcje i historia

- Granica modułu nie może rozbić wymaganej operacji atomowej. Powiązane zapisy prób, ocen, ekspozycji i projekcji pozostają w jednej transakcji, gdy wymagają tego reguły Knowli.
- Koordynator przypadku użycia ustala granicę transakcji. Współpracujące moduły muszą uczestniczyć w niej bez ukrytych, niezależnych commitów.
- Zachowuj blokady, idempotencję, kolejność ujawnień, wersjonowanie i niezmienność historii.
- Nie wprowadzaj event busa, asynchronicznej komunikacji między modułami ani eventual consistency wyłącznie dla uzyskania modularności.

### Proporcjonalność i weryfikacja

- Przed implementacją krótko wskaż moduł odpowiedzialny za funkcję, jego zależności oraz granicę transakcji. Rutynowe wybory rozstrzygaj samodzielnie; nie wymagają osobnej akceptacji architektury.
- Nie przebudowuj całego obszaru przy każdej funkcji. Poprawiaj granice w zakresie potrzebnym do zadania i zachowuj zgodność publicznych kontraktów.
- Dodawaj znaczące testy reguł domenowych, a gwarancje bazy i współbieżności sprawdzaj integracyjnie. Dla istotnych nowych granic stosuj prostą kontrolę importów.
- Nie twórz abstrakcji bez konkretnej potrzeby. Przenośność oznacza możliwość zachowania reguł i testów przy wymianie adaptera; sam podział na katalogi jej nie zapewnia.
- W raporcie końcowym wskaż, gdzie umieszczono reguły, jakie zależności dodano i jakie gwarancje zweryfikowano.

Te zasady określają kierunek nowych zmian. Nie są poleceniem natychmiastowej przebudowy istniejącej aplikacji.

## Integracja MCP i skill Umiem! — wspólny kontrakt z API

- Serwer MCP Streamable HTTP utrzymuj w `apps/web/src/integrations/` i udostępniaj pod `/api/mcp`, używając istniejących kontraktów i przypadków użycia. Pakiet `integrations/umiem-mcp/` zawiera semantyczny walidator, wygenerowany schemat, manifest kontraktu i skill w `skills/umiem-learning/SKILL.md`; nie zawiera alternatywnego serwera stdio ani klienta REST.
- Hermes łączy się jako zwykły klient MCP przez `url` i nagłówki Bearer z chronionego środowiska. Kod raportu rodzinnego pozostaje w repozytorium Hermesa; nie utrzymuj tam niezależnego forka schematu lub skilla.
- **Przy każdej zmianie API sprawdź wpływ na MCP i `SKILL.md`.** Gdy zmiana dotyczy udostępnionych endpointów, DTO, parametrów, wartości domyślnych, autoryzacji, kodów błędów albo znaczenia danych (np. samodzielności, czasu nauki i terminów sprawdzianów), zaktualizuj w tym samym PR adapter, jego walidację oraz skill w wymaganym zakresie. Samo przejście testów serwera nie potwierdza zgodności integracji.
- Źródłem kontraktu są schematy w `packages/contracts`. Regeneruj przenośny JSON Schema i aktualizuj jego kopię w pakiecie konsumenta MCP, przykłady oraz testy zgodności; nie rozwijaj ręcznie rozbieżnych definicji. Sprawdź zgodność `schemaVersion` i zachowanie względem już wdrożonych wersji API/MCP; zmianę niezgodną zaplanuj wraz z kolejnością aktualizacji obu stron.
- W `SKILL.md` utrzymuj prawdziwe nazwy narzędzi i parametrów, ograniczenia odczytu, interpretację wyniku, obsługę błędów oraz zasady prywatności. Nie umieszczaj w nim tokenów, prywatnych danych dzieci ani twierdzeń, że poprawne odpowiedzi oznaczają trwałe opanowanie lub brak zapisu oznacza brak nauki. Czas szacowany pozostaje jawnie oznaczony.
- Uruchom adekwatne testy endpointu HTTP, walidacji kontraktu i standardowego klienta Streamable HTTP, korzystając z fikcyjnych danych; sprawdź, że instrukcje skilla odpowiadają rzeczywistemu narzędziu. Jeśli zmiana API nie wymaga zmiany MCP albo skilla, uzasadnij to w dzienniku/PR. Gdy integracja jest jeszcze planowana, zamiast deklarować sprawdzenia nieistniejącego kodu aktualizuj specyfikację, przykładowy kontrakt i plany.
- W opisie PR podaj wpływ na API → MCP → skill, wykonane sprawdzenia oraz wymagane wdrożenia po stronie konsumentów. Aktualizacja kodu w repo nie oznacza aktualizacji zainstalowanego MCP ani skilla u Hermesa.

## Zasady danych i uczenia

- Opublikowana treść jest niezmienna. Edycja tworzy nowy szkic; sesja przypina wersję zestawu i polityki.
- Oddzielaj `learning_item`, `item_revision` i `skill_version`. Postęp jest osobny dla dziecka i umiejętności: listening, reading, recall, pronunciation, spelling. Stara próba nie awansuje nowych kryteriów.
- Historia prób, ocen i ekspozycji jest źródłem danych; liczniki postępu są odtwarzalną projekcją. Nie przepisuj zakończonych ocen. Usunięcie profilu usuwa jego historię i transkrypcje, zachowując wspólny materiał.
- Serwer zapisuje i zamyka komplet ekspozycji **przed** wysłaniem ujawnianej treści. Dotyczy to podpowiedzi, dystraktorów, feedbacku, retry i ponownego odsłuchu z cache. ACK klienta jest opcjonalną obserwacją.
- Operacje sesji wszystkich klientów podlegają tej samej blokadzie. Kontekst kwalifikacji próby zamraża się przy `received_at`, przed analizą mowy.
- Wydane zadanie ma niezmienny prompt, klucz odpowiedzi i kontekst. Exposure kończy się idempotentnym `complete-presentation`, bez próby, oceny i zużycia budżetu ocenianych zadań.
- Scheduler chroni cele należnych samodzielnych sprawdzeń przed wcześniejszym ujawnieniem, także jako dystraktory. Jedna samodzielna odpowiedź pisemna może oceniać Recall i pisownię oddzielnie.
- Zwykłe STT sprawdza treść, a osobny provider ocenia wymowę. Zatwierdzone warianty odpowiedzi są poprawne także w mowie. Wyniku wymowy dla innego wariantu nie przenoś na wypowiedziany tekst.
- Parametry startowe polityki: 300 sekund od ujawnienia dla samodzielnego Recall/pisowni, trzy ostatnie kwalifikujące sukcesy, potwierdzenie innego dnia po minimum 12 godzinach, wsparcie po dwóch błędach. Szczegóły i wyjątki stosuj zgodnie ze SPEC i architekturą.
- „Nie pamiętam” jest trudnością. „Pomiń”, cisza, niepewne rozpoznanie i awaria techniczna nie są dowodem błędnej wiedzy. Niepewny STT nie tworzy pomyłki między słowami.

## Generowanie, media i prywatność

- Domyślna konfiguracja zmiennych środowiskowych (providerzy, modele, głos, ton, limity) żyje w `packages/server/src/config-defaults.ts`; `.env` tylko ją nadpisuje (od 2026-11-01). Nową zmienną z wartością domyślną dopisz tam, a nowe miejsce składania zależności z env buduj na `withConfigDefaults(process.env)`. Sekretów do pliku domyślnych nie wpisuj. Wspólny `OPENROUTER_API_KEY` trafia wyłącznie po https na host OpenRouter; grader i ocena aktywności biorą go domyślnie (decyzja właściciela 2026-11-01), a dyktowanie nigdy.
- Waliduj structured output AI po stronie serwera. Materiał dostępny dziecku wymaga zatwierdzenia rodzica.
- TTS generuj i cache'uj podczas przygotowania materiału. Gotowy rekord zasobu i jego bajty są niezmienne; ręczna regeneracja tworzy nowy zasób/generację.
- Media job jest związany z `asset_id`, a nie numerem edycji całego szkicu. Lease należy do współdzielonego zasobu. Każda edycja uzgadnia fingerprinty, zachowuje zgodne media i zleca brakujące w tej samej transakcji.
- `MediaStore.putImmutable` zapisuje bez nadpisywania istniejącego blobu. Spóźniony worker nie może zmienić gotowych mediów ani powiązań szkicu.
- Nagranie dziecka przetwarzaj krótkotrwale w pamięci. Nie zapisuj go w bazie, kolejce, plikach tymczasowych, logach, fixture ani backupie. Zwolnij mikrofon i bufory także po błędzie/anulowaniu.
- Sekrety pozostają na serwerze. Kid DTO nie zawiera klucza odpowiedzi, kryteriów oceny ani technicznych score'ów. Nie serializuj bezpośrednio rekordów bazy.
- Model oceniający lekcji (gdy skonfigurowany, `UMIEM_GRADER_*`, proces web): wysyłaj do usługi wyłącznie treść ćwiczenia, regułę i odpowiedź dziecka jako dane (≤200 znaków; odpowiedzi otwarte przedmiotów szkolnych ≤600 znaków — werdykt dwuwymiarowy `school-grader-v3` — Etap 2, od Etapu 6 z fragmentami „nie na temat” i parami pomylonych pojęć (wyłącznie dla rodzica i selektora, nigdy w Kid DTO); w ścieżce szkolnej do usługi trafiają ponadto elementy wymagane/uzupełniające, typowe błędy, oczekiwana forma i cytaty z materiału rodzica — nadal bez danych dziecka; wymiary werdyktu żyją też w cache lesson_verdicts), nigdy imienia/wieku/identyfikatorów; token tylko w adapterze (nie w logach, DTO, promptach). Komentarz modelu jest wyłącznie dla rodzica; werdykt w cache `lesson_verdicts` nie ma kolumn dziecka. Panel rodzica informuje, do której usługi trafiają odpowiedzi dziecka. Raport Hermesa (`learning-overview`) świadomie NIE obejmuje lekcji — przy zmianach API/MCP utrzymaj ten filtr i notę w `SKILL.md`.
- Ocena aktywności sesji (spec client-reward-time, port `SessionActivityReviewer`, wspólna konfiguracja `UMIEM_GRADER_*`, deadline 60 s): model dostaje jedną sesję z zerowymi numerami zadań, instrukcje/bodźce/opcje, warianty poprawne i faktycznie wysłane odpowiedzi oraz lokalną aktywność — wyłącznie jako dane; bez imion, identyfikatorów, kluczy i nagrań. Model wskazuje tylko zadania bez podstaw do zaliczenia pracy i uzasadnienia; sekundy i punkty (1 pkt/60 s z resztą przenoszoną między sesjami) liczy wyłącznie kod. Szczegółowy JSONB raportu znika po 7 dniach; punkty, krótki wynik i fingerprint pozostają. Awaria modelu = zapisany błąd bez punktów, bez kolejki i automatycznych ponowień; jedno wywołanie na sesję (znacznik + fingerprint + deadline). Nie ma Xbox, salda do wydania ani punktów per zestaw.
- Tematy zdań lekcji gramatyki (#197; zainteresowania z profilu dziecka, `child_profiles.interests`): do modelu generującego trafia wyłącznie lista tekstów wstawiona przez rodzica przy tworzeniu lekcji — jako ogrodzony blok danych w wiadomości użytkownika (`SENTENCE THEMES`), a reguła przedmiotu (`interestsRule`, tylko `english_grammar`) w prompcie systemowym; nigdy imię, rok urodzenia ani identyfikator dziecka, a grader nie dostaje tematów. Migawka żyje w `deck_versions.lesson_context` i `generation_runs.input` (wspólny materiał, bez `childId`), przetrwa usunięcie profilu (decyzja właściciela z 2026-11-01); rodzic usuwa ją w edytorze szkicu (`LessonDraftPatch.interests = []`), co czyści tylko bieżący szkic — wcześniejsze i opublikowane wersje oraz `generation_runs.input` zachowują migawkę jako wspólny materiał, a wygenerowane ćwiczenia się nie zmieniają. Nie trafia do `learning-overview`, MCP, `SKILL.md` ani Kid DTO; nie loguj jej. Szczegóły: `docs/architecture.md` §19.11.
- Parent Mode wymaga PIN-u/hasła, sesji i serwerowej autoryzacji każdej operacji. Wybór profilu dziecka nie jest mechanizmem zabezpieczenia publicznej instancji.
- Sposób dostępu spoza domu wymaga osobnego ustalenia przed publicznym wystawieniem. Nie twórz teraz platformy wielorodzinnej.

## UX pierwszej wersji

- Polski tekst ma być krótki, naturalny i zrozumiały dla dziecka. Duże pola dotykowe, jeden jasny krok, mobile first i tablet friendly.
- Przykłady feedbacku: „Świetnie!”, „Prawie! Posłuchaj jeszcze raz”, „Spróbuj jeszcze raz”. Feedback musi odpowiadać rzeczywistemu wynikowi; nie chwal błędnej odpowiedzi jako poprawnej.
- Sesje trwają około 5–10 minut. Po „Jeszcze 3 i koniec!” nie dokładaj zadań ponad obiecany budżet.
- Dziecko nie widzi modeli, promptów, procentowych ocen, konfiguracji powtórek ani administracji.
- Rodzic ma prosty podgląd materiału, edycję, przypisania i postęp per umiejętność. Obraz pomaga w znaczeniu: object/action, a kolor/liczba/sekwencja korzystają z renderowania deterministycznego.
- Nauka bez mikrofonu jest pełnoprawną ścieżką. Odmowa uprawnienia nie blokuje sesji. PWA nie obiecuje nauki offline; utrata sieci nie może tworzyć lokalnie fałszywego sukcesu.

## Sposób implementacji i sprawdzania

- Realizuj uzgodniony plan małymi zadaniami z działającym, sprawdzalnym rezultatem. Nie traktuj odczytania tego pliku jako polecenia zbudowania całego MVP.
- Próbę mowy i mediów wykonaj zgodnie z zadaniem 0. Bez kluczy lub docelowego urządzenia opisz brakujące dowody; tekstowy fundament może powstawać dalej. Nie deklaruj gotowej oceny wymowy bez tej próby.
- Dla reguł oceny, historii, współbieżności i danych dodawaj znaczące testy. Testy domeny używają kontrolowanego zegara, integracyjne docelowego PostgreSQL, a providerów w testach zastępują fake-adaptery.
- Pokryj odpowiednie regresje R01–R07 z planu; weryfikuj awarie, retry, dwie przeglądarki i usuwanie profilu, nie tylko poprawny przebieg.
- Uruchamiaj istniejące skrypty adekwatne do zmiany: `pnpm test:unit`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm typecheck`, `pnpm build`. Przed wykonaniem sprawdź aktualne definicje w `package.json`.
- Początkowy SQL jest projektem do odwzorowania. Po wdrożeniu Drizzle utrzymuj autorytatywny schemat TypeScript i przeglądane migracje SQL, w tym wymagane triggery; nie rozwijaj niezależnie dwóch definicji.
- Aktualizuj dokumentację, gdy zmienia się uzgodniony kontrakt lub decyzja. Raportuj co zmieniono, co rzeczywiście sprawdzono i co pozostaje niezweryfikowane. Sprawdzenia SQL w PGlite nie są testami gotowej aplikacji.
- Lokalnie dostępne jest narzędzie GitHub CLI (`gh`, w razie braku w `PATH` bieżącej powłoki: `C:\Program Files\GitHub CLI\gh.exe`) z aktywnym uwierzytelnieniem. Agenci mogą z niego korzystać do sprawdzania stanu repozytorium i PR oraz do tworzenia PR w ramach autoryzowanego zadania. Samo istnienie narzędzia nie uprawnia do push do `main` ani scalania PR; stosuj zasady z bloku Policy.

## Poza zakresem MVP

OCR/PDF i nauka z podręczników, chat/awatar AI, rozmowy realtime, OAuth, social/rankingi, marketplace, płatności, rozbudowana gamifikacja, CEFR, natywna aplikacja Android/iOS oraz pełna synchronizacja offline. Zachowuj możliwość rozbudowy przez uzgodnione granice; nie implementuj tych modułów z wyprzedzeniem.
