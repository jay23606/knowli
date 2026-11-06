# Wdrożenie prywatne — Docker Compose i Coolify

Wersja bazowa: zadanie 11 planu implementacji. Stack rodzinny Knowli/Umiem!
składa się z czterech serwisów compose (definicja: `deploy/compose.yaml`):

| Serwis | Obraz | rola | dostęp |
| --- | --- | --- | --- |
| `db` | `postgres:17.11-alpine` | jedyna baza aplikacji i kolejki | prywatny, bez portów hosta |
| `migrate` | `deploy/Dockerfile` target `worker` | jednorazowe migracje Drizzle przy starcie | jeden shot, `restart: no` |
| `web` | `deploy/Dockerfile` target `web` | panel rodzica + Kid UI (Next.js standalone) | jedyny port hosta (`WEB_PORT`, domyślnie 8080) |
| `worker` | `deploy/Dockerfile` target `worker` | pętla generacji materiałów (tsx) | prywatny; healthcheck na `127.0.0.1:9301/health` |

Healthchecki: web wystawia publiczny `GET /api/v1/health` (sprawdza też bazę),
worker odpowiada na `/health` tylko z wnętrza kontenera. `web` i `worker`
startują dopiero po `service_completed_successfully` serwisu `migrate`.

Wolumeny: `knowli-db` (baza) i `knowli-media` (trwałe audio/obrazy, wspólny
dla web i worker). Wersje obrazów bazowych są przypięte w plikach
(`deploy/Dockerfile`, `deploy/compose.yaml`) — podnoszenie celowe, nie przy
każdym deploju.

## Pierwsze uruchomienie (lokalnie / na serwerze w domu)

1. Przygotuj `.env` z korzenia repo na podstawie `.env.example`:
   - `POSTGRES_PASSWORD` — wymagane (baza w kontenerze),
   - `OPENAI_API_KEY` (worker i web: obrazy), `OPENROUTER_API_KEY` (worker:
     generator materiału i nagrania lektora, web: grader odpowiedzi lekcji —
     modele, głos i ton są w domyślnej konfiguracji
     `packages/server/src/config-defaults.ts`),
     `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` (web: próby ustne dziecka),
   - **lekcje wymagają klucza OpenRouter** (`OPENROUTER_API_KEY`,
     `UMIEM_LESSON_AGENT_API_KEY` albo `UMIEM_LLM_API_KEY` przy `UMIEM_LLM_BASE_URL`
     na https OpenRouter) w web i w worker — agent puli jest jedynym
     generatorem lekcji (sekcja „Generowanie lekcji” niżej),
   - `OPENAI_API_KEY` trafia wyłącznie do `https://api.openai.com`, a wspólny
     klucz wyłącznie po https na openrouter.ai; klucz w złym miejscu kończy start
     błędem z nazwą zmiennej (szczegóły: `docs/provider-config.md`),
   - `UMIEM_SETUP_TOKEN` — wymagane do pierwszego ustawienia PIN-u rodzica
     (#307, decyzja właściciela z 2026-11-06): długi losowy kod, np.
     `openssl rand -hex 16`. Bez niego ekran „Pierwsze uruchomienie” odrzuca
     ustawienie PIN-u, więc świeżej instancji nie przejmie pierwszy odwiedzający,
   - opcjonalnie `WEB_PORT`.
2. Zbuduj i uruchom stack:

   ```bash
   docker compose --env-file .env -f deploy/compose.yaml up -d --build
   ```

3. Otwórz `http://<host>:8080/parent` i zakończ pierwsze uruchomienie: wpisz
   nowy PIN rodzica i jako „Kod konfiguracji” wartość `UMIEM_SETUP_TOKEN`
   (jednorazowy setup znika po zapisaniu). Potem możesz usunąć zmienną z `.env`
   — zmiana PIN-u i tak wymaga zalogowania. Zapomniany PIN: usuń wiersz
   `learning_app.parent_credentials` w bazie, ustaw `UMIEM_SETUP_TOKEN`
   i uruchom web ponownie.

Aktualizacja aplikacji: `git pull` + ponownie `up -d --build` — migracje
odpalają się automatycznie przed startem web/worker.

## Generowanie lekcji (agent puli)

Od etapu 3 (#237, PR 2) lekcje wszystkich przedmiotów generuje wyłącznie agent
puli (worker, OpenRouter; opis i zmienne: `docs/provider-config.md`, sekcja
„Agent puli lekcji”). Co to znaczy przy wdrożeniu:

- **Klucz.** `OPENROUTER_API_KEY` (albo `UMIEM_LESSON_AGENT_API_KEY`; trzecia
  rezerwa to `UMIEM_LLM_API_KEY`, gdy `UMIEM_LLM_BASE_URL` wskazuje https
  OpenRouter — kolejność w `docs/provider-config.md`) musi być w web **i** w worker. Używaj w obu serwisach tego samego klucza i tych samych
  `UMIEM_LESSON_AGENT_MODEL` / `UMIEM_LESSON_AGENT_CHECKER_MODEL`: etykiety usług
  w panelu rodzica pochodzą z web, a lekcje liczy worker. Po dodaniu albo zmianie
  klucza zrestartuj oba serwisy.
- **Bez klucza** panel rodzica pokazuje „Generowanie lekcji wymaga klucza
  OpenRouter w konfiguracji serwera. Po dodaniu klucza ponów generowanie.” i
  wyłącza tworzenie i dogenerowanie lekcji (zestawy słówek działają), a worker
  kończy runy lekcji kodem `lesson_agent_unavailable` bez wywołań modeli. Worker
  wstaje bez klucza tylko wtedy, gdy LLM i TTS są skonfigurowane na OpenAI-direct
  (log startu: `[config] lesson-agent=unavailable reason=no_openrouter_key`);
  przy domyślnych adresach OpenRouter brak klucza nadal zatrzymuje start
  (`UMIEM_LLM_BASE_URL`, `UMIEM_TTS_BASE_URL`). Po dodaniu klucza i restarcie
  rodzic ponawia generowanie przyciskiem „Ponów”.
- **Walidacja.** Zmienne `UMIEM_LESSON_AGENT_*` worker sprawdza przy każdym
  starcie; zła wartość (liczba, wysiłek rozumowania, routing, ta sama rodzina
  modeli generatora i checkera, klucz w kształcie OpenAI) zatrzymuje start z nazwą
  zmiennej. Web ich nie waliduje.
- **Usunięte ustawienia.** `UMIEM_LESSON_AGENT_SUBJECTS` już nie istnieje (agent
  obsługuje wszystkie przedmioty); pozostawiona w `.env` jest ignorowana, ale
  warto ją usunąć.
- **Koszt.** Agent kosztuje więcej niż dawny potok: próba 2026-11-03 — rozdział
  0,11–0,15, gramatyka ok. 0,07, szkoła 0,20–0,31 USD na lekcję plus kontrole
  modelem; domyślny budżet runu to 1,00 USD (`UMIEM_LESSON_AGENT_RUN_BUDGET_USD`).
  Koszty widać w sekcji „Koszty” panelu rodzica.
- **Zmiana niezgodna dla OpenAI-direct.** Instancja bez klucza OpenRouter (LLM i
  TTS na `api.openai.com`) traci generowanie lekcji; słówka, TTS i ilustracje
  działają jak dotąd.
- **Wycofanie.** Zmiana nie ma migracji bazy: `git revert` PR etapu 3 PR 2 i
  ponowne wdrożenie przywracają dawny potok. Runy zakończone już kodem
  `lesson_agent_unavailable` pokażą po wycofaniu ogólny komunikat błędu (dawny
  katalog komunikatów nie zna tego kodu) — wystarczy je ponowić; szkice i punkty
  kontrolne agenta pozostają czytelne.

## Test dymny wdrożenia

```bash
deploy/smoke.sh
```

Skrypt stawia osobny projekt `knowli-smoke` (fake providerzy, własne
wolumeny, port `127.0.0.1:24700`), prowadzi pełny obieg przez publiczne API
(generacja → publikacja → przypisanie → sesja dziecka), restartuje kontenery
`web` i `worker`, a potem weryfikuje, że profile, postęp i bajty mediów są
identyczne. Po próbie projekt smoke jest usuwany (`down -v`). Nie dotyka
danych rodzinnych ani kluczy.

## Coolify (docelowy sposób uruchomienia w domu)

Stack uruchamiaj jako zasób typu **Docker Compose** — Coolify buduje obrazy z
repozytorium (`deploy/compose.yaml`; `build.context` wskazuje korzeń repo).

- **Środowisko**: te same zmienne co w `.env` (sekcja Compose w
  `.env.example`); Coolify wstrzykuje je do kontenerów. Ustaw
  `UMIEM_SETUP_TOKEN` (jako sekret, przy usłudze `web`) **przed** pierwszym
  deployem — Coolify wystawia web pod adresem z domeną od razu, a bez kodu
  ustawienie PIN-u jest wyłączone.
- **Trwałe dane**: wolumeny `knowli-db` i `knowli-media` mapuj na persistent
  storage Coolify — to jedyne dwa miejsca z danymi rodziny.
- **HTTPS**: Coolify wystawia web przez własny reverse proxy z certyfikatem;
  sam compose wystawia tylko HTTP. Mikrofon dziecka (getUserMedia) wymaga
  HTTPS — na tablecie korzystaj z adresu przez proxy Coolify, nie z
  gołego `http://ip:8080`.
- **Publiczne wystawienie poza dom** wymaga wcześniejszej, osobnej decyzji o
  bramie dostępu (plan, bramka 4); MVP działa prywatnie w sieci domowej.

## Bezpieczeństwo wdrożenia

- Tylko `web` ma port hosta; `db` i `worker` są w prywatnej sieci compose.
- Pierwsze ustawienie PIN-u rodzica wymaga kodu `UMIEM_SETUP_TOKEN` (bez
  wartości domyślnej; brak = setup wyłączony). Błędne kody liczą się do limitu
  prób logowania (5 w 15 min). Kod nie zastępuje bramy dostępu: Kid API
  pozostaje zaufanym API sieci domowej.
- Sekrety (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, ewentualne `UMIEM_*_API_KEY`, `AZURE_SPEECH_*`, `POSTGRES_PASSWORD`) żyją
  wyłącznie w środowisku kontenerów (Coolify secrets / `.env` poza repo);
  web i worker dostają je z jednego pliku, żeby ustawienia medialne
  (fingerprinty) zawsze były identyczne — patrz `docs/provider-config.md`.
- Nagrania ustne dziecka nie są utrwalane nigdzie — nie trafiają ani do bazy,
  ani do wolumenu mediów, ani tym samym do backupów (patrz
  `docs/backup-restore.md`).
