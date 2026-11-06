# Konfiguracja providerów (decyzje zadania 0)

Wersja: 1.0 (październik 2026). Uzupełnia `.env.example` (katalog zmiennych)
o decyzje potwierdzone próbą techniczną — patrz `docs/speech-spike.md`.

## Domyślna konfiguracja i `.env` (od 2026-11-01)

Wybrana konfiguracja providerów i limitów żyje w repozytorium:
`packages/server/src/config-defaults.ts` (design
`docs/superpowers/specs/2026-11-01-config-defaults-design.md`). Web, worker,
CLI ponownego nagrania i skrypty składają zależności z
`withConfigDefaults(process.env)`: niepusta wartość z `.env` wygrywa, pusta
(`X=`) przywraca domyślną. Domyślnie: TTS OpenRouter `google/gemini-3.8-flash-tts`,
głos `Kore`, `wav`, instrukcje wymowy pl-PL i en-GB, `UMIEM_TTS_STYLE=instructions`;
generator i grader `google/gemini-3.8-flash` na OpenRouter z `REASONING=low`;
obrazy i limity jak w tabelach niżej. Wartości awaryjne w parserach (OpenAI
`gpt-4o-mini`, `gpt-4o-mini-tts`, `alloy`, mp3, bez stylu) dotyczą już tylko
wywołań bez domyślnych (testy jednostkowe).

`.env` instancji potrzebuje tylko: `POSTGRES_PASSWORD`, `OPENAI_API_KEY`
(obrazy), `OPENROUTER_API_KEY` (LLM, TTS i grader), opcjonalnie Azure i
dyktowanie. Wspólny klucz
trafia wyłącznie po `https` na `openrouter.ai` (`eu.`/`us.`), bez userinfo w
URL; własny `UMIEM_LLM_API_KEY`/`UMIEM_TTS_API_KEY`/`UMIEM_GRADER_API_KEY` ma
pierwszeństwo. Klucz w kształcie OpenAI (`sk-…`, nie `sk-or-…`) skierowany na
OpenRouter — także w `OPENROUTER_API_KEY` — to błąd startu, podobnie jak
własny klucz OpenRouter (`sk-or-…`) przy `BASE_URL` innym niż https OpenRouter
(nie trafia do obcego hosta). Grader i ocena
aktywności są domyślnie włączone: biorą własny `UMIEM_GRADER_API_KEY` albo
wspólny klucz (decyzja właściciela 2026-11-01 — prywatność odpowiedzi dzieci
ustawia się w koncie OpenRouter albo przez
`UMIEM_GRADER_PROVIDER_DATA_COLLECTION=deny`); bez żadnego klucza OpenRouter —
wyłączone. Dyktowanie wymaga własnego klucza. W trybie `UMIEM_FAKE_PROVIDERS=1`
web zawsze bierze fake gradera; E2E i smoke nadpisują `UMIEM_TTS_FORMAT=mp3` i
`UMIEM_TTS_STYLE=none`, a smoke (web bez trybu fake) czyści też
`OPENROUTER_API_KEY` i `UMIEM_GRADER_API_KEY`.

Wyłączniki i powroty to nadpisania: `UMIEM_TTS_STYLE=none`; TTS na OpenAI —
`UMIEM_TTS_PROVIDER=openai`, `UMIEM_TTS_MODEL=gpt-4o-mini-tts`,
`UMIEM_TTS_VOICE=alloy`, `UMIEM_TTS_FORMAT=mp3`,
`UMIEM_TTS_BASE_URL=https://api.openai.com/v1`; LLM na OpenAI —
`UMIEM_LLM_BASE_URL=https://api.openai.com/v1`, `UMIEM_LLM_MODEL=gpt-4o-mini`.
Samo `UMIEM_TTS_PROVIDER=openai` bez `UMIEM_TTS_BASE_URL` na api.openai.com
to błąd startu workera. Web i worker wdraża się z tego samego commitu. Zmiana
ustawień TTS (także włączenie tonu przez domyślne `instructions`, gdy `.env`
go nie ustawiał) każe workerowi przy starcie od razu nagrać na nowo katalog
komunikatów Kid UI (płatne); pytania i karty lekcji — przy następnym zapisie.

## Ścieżka mowy (web)

| Element | Wartość | Uzasadnienie |
| --- | --- | --- |
| STT treści | Azure Speech-to-text REST v1, `language` = targetLocale zestawu (`en-GB`), `format=detailed` | potwierdzone żywą usługą; treść rozstrzyga STT, nie score |
| Ocena wymowy | Azure Pronunciation Assessment REST, `ReferenceText=expectedText`, HundredMark/Word/Comprehensive | score = `NBest[0].AccuracyScore` (kształt REST, nie SDK) |
| Format wejścia | **WAV PCM 16 kHz mono** z konwersją w pamięci klienta (`decodeAudioData` + `OfflineAudioContext`) | MP3/webm zwracają pusty wynik zamiast błędu (cicha porażka) |
| Timeout | 30 s na całe żądanie (`AbortSignal`) | przerwane żądanie = wynik techniczny, nie zawieszenie |
| Env | `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` | region `germanywestcentral` (UE); brak kluczy = ścieżka ustnej odpowiedzi wyłączona, nauka bez mikrofonu pełnoprawna |

Progi oceny (decyzja po próbie syntetycznej i na głosie człowieka, patrz
`docs/speech-spike.md`): treść — dopasowany znormalizowany tekst = poprawna
(niezależnie od conf); pusty tekst = brak odpowiedzi; niedopasowany z
`conf ≥ 0,4` = błędna treść; niedopasowany z `conf < 0,4` = nieocenione.
Wymowa oceniana **wyłącznie przy dopasowanej treści** (cisza dostała w próbie
score 100): `≥ 70` dobrze (sukces), `50–69` „prawie", `< 50`/`no_speech`
→ nieocenione, ponowna próba. Kodek nagrania potwierdzony na desktop:
`audio/webm;codecs=opus` (tablet — `audio/mp4` na Safari — do potwierdzenia
w zadaniu 11); konwersja do WAV jest kodekowo-agnostyczna.

## Dyktowanie odpowiedzi lekcji (web)

Odpowiedzi otwarte zestawów szkolnych można podyktować (design przedmiotów
szkolnych §5). Ocena wymowy nie jest tu potrzebna, więc ścieżka nie używa
Azure; wybór providera po spike'u 2026-10-29 (design §5.1–5.2).

| Element | Wartość | Uzasadnienie |
| --- | --- | --- |
| Endpoint | `POST {UMIEM_LESSON_STT_BASE_URL}/audio/transcriptions`, JSON z `input_audio` (base64 WAV), `language: "pl"`, `temperature: 0`, `response_format: "verbose_json"` (przy 400 ponowienie z `json`) | format OpenAI, obsługiwany przez OpenRouter |
| Model | `UMIEM_LESSON_STT_MODEL`, domyślnie `elevenlabs/scribe-v2` | 150/150 pojęć na syntetycznym polskim głosie, nazwy i liczby bez sklejania, cisza bez halucynacji |
| Prywatność | dla OpenRouter zawsze `provider: { zdr: true, data_collection: "deny" }`; brak endpointu ZDR = `unavailable` | bez `user`, `session_id`, `keyterms` i treści materiału; nagranie tylko w pamięci żądania |
| Wynik | znaczniki zdarzeń `[…]` usuwane; tekst ≥ 0,5 confidence (gdy podana) trafia do pola odpowiedzi | dziecko widzi tekst przed oceną |
| Limity | nagranie ≤ 45 s, 40 dyktowań na sesję, deadline 30 s | stałe `DEFAULT_DICTATION_POLICY` |
| Env | `UMIEM_LESSON_STT_BASE_URL`, `UMIEM_LESSON_STT_API_KEY` (oba albo żaden), opcjonalnie `UMIEM_LESSON_STT_MODEL` | `https://` poza NODE_ENV test/development; brak = lekcje bez mikrofonu; może to być ten sam klucz OpenRouter co grader |

## Generowanie materiału (worker)

| Element | Wartość | Uwagi |
| --- | --- | --- |
| LLM | OpenAI `gpt-4o-mini` | domyślny adapter `createOpenAiLlmProvider`; zmiana modelu/endpointu przez `UMIEM_LLM_MODEL`/`UMIEM_LLM_BASE_URL` bez zmiany kodu (model trafia do logu `[lesson-story] generacja` runu historyjki, co umożliwia A/B po logach). Pulę ćwiczeń lekcji od etapu 3 PR 2 generuje agent puli (`UMIEM_LESSON_AGENT_MODEL`, sekcja „Agent puli lekcji”); `UMIEM_LLM_*` zostaje dla słówek, historyjki i etapu zagadnień szkoły |
| TTS | domyślnie (`config-defaults.ts`) OpenRouter `google/gemini-3.8-flash-tts`, głos `Kore`, `wav`, styl `instructions`; wartość awaryjna kodu: OpenAI `gpt-4o-mini-tts`, mp3 | głos awaryjny `alloy` (decyzja po próbie: domyślny na start); zmiana np. na `fable` przez `UMIEM_TTS_VOICE` bez zmiany kodu. Endpoint zgodny z OpenAI Audio Speech (np. OpenRouter `https://openrouter.ai/api/v1`, `UMIEM_TTS_PROVIDER=openrouter`, wybrany model `google/gemini-3.8-flash-tts` z głosem `Kore` dla obu języków i `UMIEM_TTS_FORMAT=wav` — decyzja właściciela 2026-10-30, design szkoły §11.6 pkt 9; wcześniej `microsoft/mai-voice-2.1-flash`, odrzucony, bo na pojedynczych słowach powtarzał je (ok. 12% nagrań), urywał i doklejał szum; Gemini zwraca na OpenRouter wyłącznie PCM, które adapter przy formacie `wav` opakowuje nagłówkiem WAV; głos musi należeć do `supported_voices` modelu — `alloy` działa tylko z OpenAI) przez `UMIEM_TTS_BASE_URL`/`UMIEM_TTS_API_KEY`/`UMIEM_TTS_MODEL` (worker; własny `UMIEM_TTS_BASE_URL` innego hosta niż `https://api.openai.com` wymaga własnego `UMIEM_TTS_API_KEY` — `OPENAI_API_KEY` nie jest wysyłany do innego hosta, a `UMIEM_TTS_API_KEY` dostawcy innego niż OpenAI (`UMIEM_TTS_PROVIDER` inny niż `openai` albo klucz `sk-or-…`) bez BASE_URL innego hosta to błąd startu; od Etapu 8 adapter wysyła model z `UMIEM_TTS_MODEL`, wcześniej zawsze domyślny). Provider, model, głos, format i instrukcja wymowy wchodzą do fingerprintów: zmiana = nowe nagrania przy kolejnej edycji, katalog komunikatów interfejsu na nowo przy starcie workera. Głos per język treści: `UMIEM_TTS_VOICE_<JĘZYK>_<REGION>` nadpisuje `UMIEM_TTS_VOICE` i wchodzi do fingerprintu. Instrukcja wymowy per język `UMIEM_TTS_INSTRUCTIONS_<JĘZYK>_<REGION>` (np. `UMIEM_TTS_INSTRUCTIONS_PL_PL=Mów po polsku, z polską wymową.`) idzie polem `instructions`, nie jest czytana i wchodzi do fingerprintu tylko wtedy, gdy jest ustawiona (nagrania bez niej zachowują fingerprint); bez niej model wielojęzyczny czyta pojedyncze polskie słowa („pies”, „1410”) po angielsku. WAV (PCM 24 kHz, 16 bit, mono) zajmuje ok. 48 KB na sekundę, kilka razy więcej niż mp3: słówko ok. 50 KB, ale nagranie karty nauki (do 2000 znaków, ok. 2 min) do ok. 6 MB, a odtwarzacz Kid UI pobiera plik w całości przed startem; rośnie też wolumen mediów i backup. Web i worker muszą mieć identyczne `UMIEM_TTS_FORMAT` i `UMIEM_TTS_INSTRUCTIONS_*` (inaczej komunikaty interfejsu powstają pod innymi fingerprintami niż szuka web), a przy wdrożeniu worker aktualizuje się razem z webem albo przed nim — stary worker nie zna formatu `wav` i instrukcji. Worker wykonuje tylko zadania TTS zgodne z jego providerem i modelem; zlecone przy innej konfiguracji czekają w kolejce bez zmiany stanu (nowy endpoint nie zna starego modelu, stary worker w trakcie wdrożenia nie unieważnia nowych), a ich liczbę worker zgłasza w logu przy starcie. Publikacja i każda edycja szkicu same zlecają nagrania z bieżącą konfiguracją |
| Ilustracje | OpenAI `gpt-image-2.5-sunburst`, `1024x1024`, quality `low`, WebP | Praca tła workera; prompt bez tekstu w obrazie. Ustawienia low+webp dobrano do ilustracji wyświetlanych w kartach dziecka (~300 px). Model można nadpisać przez `UMIEM_IMAGE_MODEL`; zmiana modelu wpływa na fingerprint i nowe generacje mediów |
| Env | `OPENAI_API_KEY` (obrazy; klucz LLM i TTS tylko przy BASE_URL api.openai.com — domyślnie LLM i TTS biorą `OPENROUTER_API_KEY`) | worker (LLM, TTS, obrazy kart) i web (jawna propozycja okładki zestawu); zawsze tylko do `https://api.openai.com`, więc klucz OpenRouter (`sk-or-…`) w tej zmiennej to błąd startu. Opcjonalnie `UMIEM_LLM_MODEL`, `UMIEM_LLM_BASE_URL`, `UMIEM_LLM_API_KEY` nadpisują model, endpoint i klucz **samego LLM** (niezależne, z fallbackami: `gpt-4o-mini`, `https://api.openai.com/v1`, `OPENAI_API_KEY`); BASE_URL wymaga `https://` poza NODE_ENV test/development. `OPENAI_API_KEY` trafia wyłącznie do `https://api.openai.com` (od 2026-10-30, ta sama reguła co dla TTS): `UMIEM_LLM_BASE_URL` innego hosta bez własnego `UMIEM_LLM_API_KEY` kończy start workera błędem z nazwą brakującej zmiennej, a klucz OpenRouter (`sk-or-…`) w `UMIEM_LLM_API_KEY` bez BASE_URL (albo z BASE_URL na api.openai.com) też jest błędem — nie trafia do OpenAI. Wcześniej sam BASE_URL wysyłał `OPENAI_API_KEY` pod wskazany adres. Od 2026-11-01 domyślne BASE_URL i model to OpenRouter (sekcja „Domyślna konfiguracja”), a klucz zapasowy dla endpointu OpenRouter to `OPENROUTER_API_KEY` (także dla gradera i oceny aktywności). Model LLM nie wchodzi do fingerprintów mediów — zmiana dotyczy tylko nowych generacji |

Runy lekcji klasyfikują błędy konfiguracji (w tym HTTP 400 i 429 quota) jako terminalne, bez automatycznego retry. Sieć, 408/5xx i zwykły limit 429 są ponawiane najwyżej do trzech prób; exponential backoff wynosi 1 s, potem 2 s, z jitterem 0–20%. `Retry-After` ma pierwszeństwo i jego termin pozostaje zapisany w `generation_runs.next_attempt_at` podczas restartu workera. Ręczne ponowienie może wyczyścić odroczenie. Refusal, ucięcie odpowiedzi i zły JSON kończą run czytelnym kodem. Adapter nie zapisuje ani nie loguje body błędu providera.

Timeouty lekcji dotyczą jednego requestu (domyślnie 90 s) oraz całego runu ze wszystkimi celami (10 min). `UMIEM_LESSON_GENERATION_REQUEST_TIMEOUT_MS` nie może przekraczać `UMIEM_LESSON_GENERATION_RUN_TIMEOUT_MS`; dodatni `UMIEM_LESSON_GENERATION_CANCEL_POLL_MS` (domyślnie 1 s) steruje sprawdzeniem, czy rodzic lub retry nie unieważnił runu. Timeout kończy run bez automatycznego retry. Zamknięcie workera oddaje aktualny run do kolejki, zachowując wykorzystaną próbę.

Worker wykonuje jeden przelot naraz. `WORKER_POLL_MS` (domyślnie 2000 ms) jest przerwą po zakończeniu przelotu, nie interwałem równoległych uruchomień. `WORKER_HEALTH_STALE_MS` (domyślnie 900000 ms) ustala wiek, po którym `/health` zwraca 503.

## Agent puli lekcji (worker, jedyny generator lekcji od 2026-11-05, #237)

Agent generuje pulę ćwiczeń lekcji zagadnienie po zagadnieniu (`docs/architecture.md`
§19.17, design `docs/superpowers/specs/2026-11-04-lesson-pool-agent-stage2a-design.md`).
Od etapu 3 (PR 2) jest **jedynym generatorem lekcji** wszystkich przedmiotów:
nie ma listy przedmiotów (`UMIEM_LESSON_AGENT_SUBJECTS` usunięta, pozostawiona
w `.env` jest ignorowana), przełącznika „powrotu do potoku” ani dawnego potoku
(jedno wywołanie LLM na partię i runda pod etap). Działa WYŁĄCZNIE w procesie
worker: web go nie składa (dostaje z env etykiety usług dla panelu rodzica i
liczy `lessonGenerationAvailable`). `UMIEM_LLM_*` nadal obsługuje słówka, etap
zagadnień szkoły i historyjkę lekcji. Adapter (AI SDK)
mówi wyłącznie z OpenRouter (`https://openrouter.ai/api/v1`): generator i
checker (drugi model, który rozwiązuje ćwiczenia na próbę i ocenia warianty
odpowiedzi, a w szkole także podpowiedzi) to osobne wywołania z własnym modelem
i wysiłkiem rozumowania.

| Zmienna | Domyślnie (`config-defaults.ts`) | Znaczenie |
| --- | --- | --- |
| `UMIEM_LESSON_AGENT_MODEL` | `google/gemini-3.8-flash` | Model generatora (podagenci zagadnień i planista) |
| `UMIEM_LESSON_AGENT_REASONING` | `low` | Wysiłek rozumowania generatora: `xhigh`, `high`, `medium`, `low`, `minimal` albo `none` (bez pola `reasoning`) |
| `UMIEM_LESSON_AGENT_CHECKER_MODEL` | `deepseek/deepseek-v4.1-flash-1017` | Model checkera |
| `UMIEM_LESSON_AGENT_CHECKER_REASONING` | `low` | Wysiłek rozumowania checkera (te same wartości) |
| `UMIEM_LESSON_AGENT_MAX_STEPS` | `8` | Maksimum kroków pętli narzędzi na zagadnienie i dla planisty |
| `UMIEM_LESSON_AGENT_CONCURRENCY` | `4` | Zagadnienia równolegle |
| `UMIEM_LESSON_AGENT_CHECKER_CONCURRENCY` | `4` | Równoległe wywołania checkera |
| `UMIEM_LESSON_AGENT_OBJECTIVE_TIMEOUT_MS` | `300000` | Termin jednego zagadnienia |
| `UMIEM_LESSON_AGENT_CHECKER_TIMEOUT_MS` | `90000` | Termin jednego wywołania checkera |
| `UMIEM_LESSON_AGENT_RUN_BUDGET_USD` | `1.00` | Budżet runu we wszystkich automatycznych próbach (wydatek z `usage.cost` OpenRouter; „Ponów” rodzica przyznaje świeży budżet). To limit wydatku **agenta** w jednym runie, nie ceny jednego wywołania; czas runu ogranicza `UMIEM_LESSON_GENERATION_RUN_TIMEOUT_MS` (10 min, z rezerwą 30 s na zapis do szkicu) |
| `UMIEM_LESSON_AGENT_API_KEY` | — | Własny klucz agenta (nie jest w domyślnych) |
| `UMIEM_LESSON_AGENT[_CHECKER]_PROVIDER_ORDER`, `_QUANTIZATIONS`, `_ALLOW_FALLBACKS`, `_DATA_COLLECTION` | — | Routing dostawców OpenRouter osobno dla generatora i checkera |

Zasady:

- **Klucz.** Kolejność: `UMIEM_LESSON_AGENT_API_KEY` → `OPENROUTER_API_KEY` →
  `UMIEM_LLM_API_KEY` (tylko gdy `UMIEM_LLM_BASE_URL` to https OpenRouter).
  Pierwszy niepusty wygrywa; klucz w kształcie OpenAI (`sk-…`, nie `sk-or-…`)
  to błąd startu workera (nie trafia do OpenRouter), a komunikat podaje nazwę
  zmiennej, nigdy wartość.
- **Brak klucza.** Bez żadnego klucza OpenRouter generowanie lekcji jest
  niedostępne, ale nie zatrzymuje to workera, o ile konfiguracja nie ma innej
  zależności od OpenRouter (LLM i TTS na OpenAI-direct): worker loguje jedną linię
  `[config] lesson-agent=unavailable reason=no_openrouter_key`, runy lekcji
  (także ze starej kolejki) kończą się `failed` z kodem `lesson_agent_unavailable`
  zaraz po przejęciu — bez wywołań modeli i bez ruszania punktu kontrolnego —
  a runy historyjki wykonują się normalnie. Przy domyślnych adresach
  (`UMIEM_LLM_BASE_URL` i `UMIEM_TTS_BASE_URL` na OpenRouter) brak klucza nadal
  zatrzymuje start workera na tych zmiennych. Web liczy to samo z env i podaje
  katalogowi lekcji `lessonGenerationAvailable: false`: panel pokazuje
  „Generowanie lekcji wymaga klucza OpenRouter w konfiguracji serwera. Po dodaniu
  klucza ponów generowanie.” i wyłącza nową lekcję, „Dogeneruj”, „Dogeneruj
  ćwiczenia”, „Ponów generowanie” runów lekcji i tworzenie lekcji ze strony źródła
  (zestaw słówek działa). Po dodaniu klucza zrestartuj web i worker, potem „Ponów”.
  Klucz w złym kształcie (kształt OpenAI, np. `UMIEM_LESSON_AGENT_API_KEY=sk-proj-…`) zatrzymuje start
  workera; web się składa i raportuje niedostępność.
- **Routing i prywatność dostawcy.** Każda opcja `UMIEM_LESSON_AGENT[_CHECKER]_PROVIDER_*`
  nieustawiona dziedziczy osobno odpowiednią `UMIEM_LLM_PROVIDER_*`, więc
  `UMIEM_LLM_PROVIDER_DATA_COLLECTION=deny` chroni też agenta. Przy wysiłku
  rozumowania innym niż `none` routing dostaje `require_parameters: true`
  (dostawcy muszą obsługiwać wysyłane parametry). Sprawdź, że wybrany model ma
  endpoint spełniający `deny`.
- **Różne rodziny modeli.** Generator i checker muszą pochodzić z różnych rodzin
  (pierwszy człon `rodzina/model`, np. `google` i `deepseek`); ta sama rodzina
  to błąd startu workera — checker z rodziny autora rozwiązywałby ćwiczenia
  „jak ich autor”.
- **Walidacja przy każdym starcie workera** (także bez klucza): niedodatnia
  liczba w limitach, nieznany wysiłek rozumowania, zła opcja routingu, ta sama
  rodzina modeli, klucz w kształcie OpenAI — błąd z nazwą zmiennej. Web
  `UMIEM_LESSON_AGENT_*` nie waliduje. Zmiana którejkolwiek zmiennej wymaga
  odtworzenia workera i webu (panel bierze etykiety usług z web, więc oba procesy
  muszą mieć ten sam klucz oraz te same `UMIEM_LESSON_AGENT_MODEL` i
  `UMIEM_LESSON_AGENT_CHECKER_MODEL`); run w toku przechodzi na nową konfigurację
  przy kolejnej próbie, a postęp agenta zostaje w punkcie kontrolnym. Web i
  worker wdraża się z tego samego commitu.
- **Tryb fake.** `UMIEM_FAKE_PROVIDERS=1` (w web i workerze) składa fake agenta z
  deterministycznym generatorem ćwiczeń (`providers/fake-lesson-pool.ts`) i fake
  checker bez wyniku (ćwiczenia przechodzą jako niesprawdzone) — bez sieci, bez
  klucza, z kosztem 0 i bez zapisu kosztów; `lessonGenerationAvailable` jest wtedy
  zawsze `true`. Opóźnienie na krok: `UMIEM_FAKE_LESSON_DELAY_MS`
  (rezerwowo `UMIEM_FAKE_DELAY_MS`); `FAKE_SLOW_MARKER` w materiale wstrzymuje
  pierwszy krok każdego zagadnienia o 3 s.
- **Koszty.** Każde żądanie agenta i checkera trafia do dziennika kosztów
  (`feature = lesson_generation`, `provider = openrouter`, operacje `agent_plan`,
  `agent_objective`, `check_solve`, `check_variants`, w szkole `check_hints`,
  `check_open`; `docs/architecture.md` §23). Wywołania gradera kontroli
  otwartych odpowiedzi zapisują `lesson_generation` / `check_grade` (dostawca z
  `UMIEM_GRADER_BASE_URL`).
  Przebieg kontrolny 2026-11-04 na domyślnych modelach: 103 s, 0,142 USD,
  74 z 94 ćwiczeń przyjętych. Agent kosztuje więcej niż dawny potok (próba
  2026-11-03: rozdział 0,11–0,15, gramatyka ok. 0,07, szkoła 0,20–0,31 USD plus
  kontrole etapu 2b); budżet runu domyślnie 1,00 USD. Operacja `lesson_pool`
  w dzienniku kosztów jest historyczna (stare wiersze zostają).
- **Prywatność i domyślni odbiorcy.** Każda lekcja idzie domyślnie do dwóch usług
  OpenRouter: generatora (`google/gemini-3.8-flash`: materiał, polecenie rodzica,
  karty, zdania do unikania, tematy zdań) i checkera innej rodziny
  (`deepseek/deepseek-v4.1-flash-1017`: widok ćwiczenia, odpowiedź i warianty, a w
  szkole także materiał i podpowiedź), a w szkole przy pełnym `UMIEM_GRADER_*` w
  workerze także do usługi gradera (pytanie, kryteria, cytaty, odpowiedź próbna
  modelu); nigdy imię, rok urodzenia, identyfikatory ani odpowiedzi dziecka.
  Adapter nie loguje treści ani body błędów dostawcy; klucz tylko w adapterze.
  Panel rodzica informuje, do których usług trafia lekcja (formularz lekcji i
  strona źródła).
- **Konfiguracja OpenAI-direct traci lekcje (zmiana niezgodna, etap 3).**
  Instancja z LLM i TTS na `api.openai.com` i bez klucza OpenRouter nie wygeneruje
  już żadnej lekcji (słówka, TTS i ilustracje działają jak dotąd); wycofanie
  to `git revert` PR etapu 3 PR 2 (bez migracji bazy).
- **Kontrole modelem w szkole (etap 2b).** W szkole checker sprawdza też
  podpowiedzi pytań otwartych (fakty spoza materiału, polszczyzna, odpowiedź
  podana innymi słowami) i pisze dwie różne poprawne odpowiedzi na każde pytanie
  otwarte, które ocenia prawdziwy grader. Wymaga to `UMIEM_GRADER_*` także w
  **workerze** (adres, model; klucz albo rezerwa `OPENROUTER_API_KEY`): grader jest
  domyślnie włączony, gdy jest `OPENROUTER_API_KEY`, więc kontrola działa wtedy
  domyślnie w szkole. Bez pełnej konfiguracji gradera w workerze
  kontrola otwarta jest wyłączona (log startu runu `openCheck=off`), a reszta
  agenta działa jak wcześniej; osobnego wyłącznika ani nowych zmiennych nie ma.
  Do gradera trafia to samo co przy dziecku (pytanie, kryteria, cytaty z
  materiału) z odpowiedzią modelu zamiast odpowiedzi dziecka; werdykty nie trafiają
  do `lesson_verdicts`. Po 3 kolejnych porażkach gradera w próbie runu agent przestaje
  go wołać (log `grader_unavailable`, raz na próbę: po ponowieniu zadania wyłącznik
  startuje od nowa), a kolejne ćwiczenia przechodzą bez kontroli otwartej;
  ćwiczenia z nieudanym wywołaniem dostają notę „niesprawdzone”.
  Nieznany koszt wywołania gradera liczy się do budżetu runu jako 0,002 USD.

## Ocena odpowiedzi lekcji (web)

Model oceniający otwarte odpowiedzi lekcji (gramatyka itp.) jest zgodny z
OpenAI (`POST {baseUrl}/chat/completions`). Działa w procesie web i tylko dla
odpowiedzi tekstowych, których nie rozstrzygnęło dopasowanie deterministyczne
(`no_match`). Worker składa ten sam adapter wyłącznie do kontroli otwartych
odpowiedzi szkoły w agencie puli (sekcja „Agent puli lekcji”, etap 2b).

| Element | Wartość | Uwagi |
| --- | --- | --- |
| Endpoint | `POST {UMIEM_GRADER_BASE_URL}/chat/completions`, `temperature: 0`, `response_format: { type: "json_object" }` | kształt zgodny z OpenAI; adapter wyciąga JSON także z bloku markdown |
| Autoryzacja | `Authorization: Bearer {UMIEM_GRADER_API_KEY}` | sekret tylko w adapterze; nigdy w logach, DTO ani promptach |
| Model | `UMIEM_GRADER_MODEL` | tani model wystarcza (ocena jednej reguły, nie generacja) |
| Timeout | `UMIEM_GRADER_TIMEOUT_MS` (domyślnie 8000) | `AbortSignal.timeout`; przerwanie = „nieocenione", nie zawieszenie |
| Budżet | `UMIEM_GRADER_MAX_CALLS_PER_SESSION` (domyślnie 20) | księgowany w `learning_sessions.context.graderCalls`; po wyczerpaniu selektor przechodzi na typy zamknięte |
| Env | `UMIEM_GRADER_BASE_URL`, `UMIEM_GRADER_API_KEY`, `UMIEM_GRADER_MODEL` | BASE_URL i MODEL z domyślnej konfiguracji (OpenRouter, `google/gemini-3.8-flash`); włączony z własnym `UMIEM_GRADER_API_KEY` albo z `OPENROUTER_API_KEY` (tylko https OpenRouter); bez domyślnych (testy) wszystkie trzy albo żadna; `https://` wymagane poza `NODE_ENV` test/development; brak = ocena dowolnych odpowiedzi wyłączona |

Werdykt modelu (`{verdict, errorCategory, fragments, note}`) jest surowym JSON —
walidację robi domena (`validateVerdict`): kategoria musi należeć do celu lub być
`other`, każdy `fragment` jest dokładnym podciągiem odpowiedzi dziecka. Zwalidowany
werdykt zapisuje się do wspólnego cache `lesson_verdicts` z kluczem
`(item_revision_id, normalized_answer, prompt_version)`; ta sama (znormalizowana)
odpowiedź innego dziecka nie woła modelu ponownie. `parent_decision` (nadpisanie
rodzica) jest nadrzędny nad zapisanym werdyktem bez przeliczania historii.
Komentarz `note` modelu jest wyłącznie dla rodzica — nigdy nie trafia do Kid DTO.
Odpowiedź dziecka i warianty referencyjne są przekazywane modelowi jako DANE
(wiadomość `user`), nigdy jako polecenia; `prompt_version` to stała adaptera, a
jej zmiana unieważnia zapisane werdykty bez migracji.

Tryb E2E/smoke bez klucza: `UMIEM_FAKE_PROVIDERS=1` wstawia deterministyczny fake
grader (routing po słowach kluczowych w odpowiedzi: „almost" → almost, „wrong" →
incorrect, inaczej correct), tak jak fake providerzy mowy i generacji.

## Ocena aktywności sesji (web)

`SessionActivityReviewer` używa połączenia `UMIEM_GRADER_*`, ale ma osobny
limit `UMIEM_SESSION_ACTIVITY_TIMEOUT_MS` (domyślnie 60000 ms). Nie zmienia go
`UMIEM_GRADER_TIMEOUT_MS`. Ocena działa w tle; podsumowanie sesji pojawia się
od razu. Limit powinien pozostawiać zapas przed deadline finalizacji 120 s.
Zmiana zmiennej wymaga odtworzenia kontenera z nowym środowiskiem; sam zapis
w panelu Coolify nie potwierdza wartości używanej przez proces web.

Jedno wywołanie na sesję, bez automatycznych ponowień i bez przeliczania
zapisanych ocen. Błąd nie przyznaje punktów i nie zmienia postępu wiedzy.
Log `[session-activity] ocena nie powiodła się` zawiera identyfikator sesji,
kod błędu, liczbę zadań, czas wywołania, skonfigurowany timeout oraz kategorię
awarii. Dla HTTP dodaje status; dla walidacji tylko kody naruszeń Zod.
Kategorie rozróżniają timeout, HTTP, błędną odpowiedź JSON, brak treści,
niepoprawny JSON werdyktu, naruszenie schematu, nieznany lub powtórzony
numer zadania. Log nie zawiera body, komunikatu wyjątku providera, zadań,
odpowiedzi, uzasadnień modelu ani kluczy odrzuconych przez schemat.

Kod zapisanej awarii jest dostępny także w autoryzowanym
`GET /api/v1/parent/work-card?childId=…&date=…` (`sessions[].activity.errorCode`).
Nie wymaga dostępu do bazy ani zachowania szczegółowego raportu po 7 dniach.

API → MCP → skill: zmiana limitu i diagnostyki nie zmienia endpointów, DTO,
kodów błędów ani sposobu liczenia czasu/punktów. `learning-overview` i skill
Hermesa zachowują dotychczasowy kontrakt; konsument nie wymaga aktualizacji.

## Ustawienia medialne i fingerprinty

`UMIEM_TTS_PROVIDER/MODEL/VOICE/FORMAT` (z `UMIEM_TTS_VOICE_*` i `UMIEM_TTS_INSTRUCTIONS_*`) oraz `UMIEM_IMAGE_PROVIDER/MODEL/SIZE/QUALITY/FORMAT`
wchodzą do fingerprintów zasobów. `UMIEM_TTS_STYLE` (`instructions` albo `none`; domyślnie `instructions` z `config-defaults.ts`, inna wartość to błąd startu) włącza styl wypowiedzi TTS i też musi być identyczny w web i workerze. Zasady potwierdzone próbą:

- web i worker muszą mieć **identyczne** wartości (fingerprint liczony w obu
  procesach);
- model, jakość i format obrazu płyną metadanymi zasobu aż do adaptera, więc
  `UMIEM_IMAGE_MODEL` faktycznie steruje wywołaniem API (także
  `gpt-image-1-mini`), a żądanie nie może się rozjechać z fingerprintem;
- zmiana po wygenerowaniu materiału = nowa generacja przy następnej edycji
  (zgodnie z projektem — nic nie nadpisuje gotowych zasobów);
- zapis `MediaStore.putImmutable` jest idempotentny i adresowany treścią;
  replay z lokalnego wolumenu trwa < 1 ms i nie woła API.

Ponowne nagranie wybranych komunikatów Kid UI (np. gdy brzmienie się nie udało): CLI zleca nowy take dla podanych kluczy, a poprzedni gra dalej, aż nowy będzie gotowy. W kontenerze: `docker compose exec worker node apps/worker/node_modules/tsx/dist/cli.mjs apps/worker/src/regenerate-ui-audio.ts correct`; w dev: `pnpm media:regenerate-ui-audio <klucz…>`. Dozwolone klucze (`UiAudioKeySchema`): `profile_select`, `deck_select`, `exposure`, `listening`, `speech`, `recall`, `correct`, `partial`, `incorrect`, `unevaluated`, `skip`, `dont_remember`, `end`, `retry`, `mic_unavailable`, `audio_unavailable`, `summary`. CLI liczy fingerprinty ze swojego `process.env` z domyślną konfiguracją pod spodem, więc musi działać z środowiskiem workera (`UMIEM_TTS_*`, w tym `UMIEM_TTS_STYLE`); w innym środowisku powstanie nagranie pod złym fingerprintem albo wiersz z domyślnym `openai`/`gpt-4o-mini-tts`, którego worker nie wykona (zostaje oczekujący).

Pojedyncze pytanie lub kartę lekcji w szkicu rodzic może nagrać ponownie w panelu („Nagraj ponownie”, gdy brzmienie się nie udało; zmiana tonu nagrywa się sama przy zapisie, ale tylko przy `UMIEM_TTS_STYLE=instructions`; przy `none` ton nie wchodzi do żądania ani fingerprintu, więc zostaje dotychczasowe nagranie, a gdy inne pytanie lub karta ma ten sam tekst i ton z gotowym nagraniem, zapis użyje go ponownie bez nowego nagrania): powstaje nowa generacja zasobu o tym samym fingerprincie, a poprzednia gra dalej (u dziecka i w panelu: „Posłuchaj poprzedniego”), aż nowa będzie gotowa. Przycisk działa tylko w szkicu, ale nowe ujęcie wspólnego tekstu usłyszy też dziecko w opublikowanej lekcji — także w innym zestawie o tym samym tekście, tonie i konfiguracji — gdy tylko będzie gotowe (odsłuch bierze najnowszą gotową generację fingerprintu); powrót do poprzedniego brzmienia to kolejne ponowne nagranie. Gdy od ostatniego zapisu szkicu zmieniła się konfiguracja TTS, przycisk najpierw uzgadnia media całego szkicu z bieżącą konfiguracją, jak zapis: nagrywa na nowo wszystkie pytania i karty szkicu (płatne), a wskazane dostaje nagranie bieżącej konfiguracji. Przy okazji zleca ponownie nieudane nagrania pytań i kart szkicu (nie są decyzją rodzica); nieudane nagrania odpowiedzi i ilustracje zostają do decyzji rodzica. Przycisk jest też przy trwającym nagraniu — zlecenie innego providera lub modelu worker pomija, więc to sposób, by je przenieść do bieżącej konfiguracji (zlecenie po zmianie samego głosu lub stylu worker wykona, ze starą instrukcją).

Decyzja po próbie: domyślny głos pozostaje `alloy`. Ewentualna zmiana w
`defaultMediaSettings` (np. `alloy` → `fable`) jest tania dopóki żaden realny
materiał nie został wygenerowany — zastosować ją RAZ przed pierwszym
produkcyjnym generowaniem.

## Bezpieczeństwo i retencja

- Klucze wyłącznie w środowisku procesów (`.env` poza repo / env shella /
  sekrety Compose w zadaniu 11). Nigdy: repo, czat, `NEXT_PUBLIC_*`, Kid DTO.
- Azure AI Speech: bez trenowania na danych klienta, audio real-time nie
  utrwalane; przetwarzanie w UE (`germanywestcentral`).
- OpenAI API: bez trenowania; retencja do 30 dni dla monitoringu nadużyć.
- Nagranie dziecka: tylko w pamięci żądania; logi bez transkrypcji
  (wzorem serwera próby: same statusy i czasy).

Linki do aktualnych oświadczeń usług sprawdzić ponownie przy wdrożeniu
(zadanie 11): Azure — „Data, privacy, and security for Azure AI Speech",
OpenAI — „Data controls" (platform.openai.com).
