# Śledzenie kosztów usług AI — design

Data: 2026-11-02. Decyzje właściciela (czat 2026-11-02):

- podejście A — dziennik użycia w bazie zapisywany przez adaptery i sekcja
  „Koszty” w panelu rodzica;
- usługi bez ceny w odpowiedzi liczone z cennika w konfiguracji i oznaczane
  jako szacunek;
- kwoty w USD;
- zostajemy przy OpenRouter (Vercel AI Gateway rozważony i odłożony);
- przy usunięciu profilu dziecka jego wiersze kosztów są zgrubiane (§5.4).

Wersja po review trzech krytyków (zgodność z kodem; architektura, prywatność i
pieniądze; cel, testy i zakres) — rozstrzygnięcia w §9. Drobne korekty po
review planu: media przez `one_run_per_asset`, `AudioInput.durationMs`, hak
zamknięcia web, blokada profilu przy zgrubieniu, „Koszty” w menu.

## 1. Problem i zakres

Umiem! płaci za kilka usług: generator materiału (LLM), lektora (TTS),
ilustracje i okładki, model oceniający odpowiedzi, ocenę aktywności sesji,
rozpoznawanie mowy (STT) i ocenę wymowy. Żaden adapter nie odczytuje dziś
informacji o zużyciu z odpowiedzi, więc właściciel nie wie, ile co kosztuje.

Właściciel chce odpowiedzieć na trzy pytania:

1. Ile wydaję w miesiącu, w podziale na funkcje?
2. Ile kosztowało przygotowanie konkretnej lekcji lub zestawu?
3. Ile kosztuje nauka konkretnego dziecka?

**Kwoty to ceny netto usług** — bez VAT i bez opłaty platformy OpenRouter za
doładowanie kredytów. Na rachunku kwota będzie wyższa (dla osoby prywatnej ok.
×1,30 przy OpenRouter). Panel mówi to jednym zdaniem pod sumą.

Suma nie obejmuje wywołań ze skryptów deweloperskich (`scripts/evaluate-*.mts`,
`scripts/sample-tts-styles.mts`) — działają poza aplikacją i nie zapisują
kosztów.

Poza zakresem (YAGNI, do dobudowania na tej samej tabeli): wykresy, przeliczanie
na PLN, mnożnik „na rachunku”, limity i alerty budżetu, eksport CSV, lista
pojedynczych wywołań, narzędzie MCP, późniejsze uzgadnianie kosztu z API
dostawcy.

## 2. Płatne wywołania dziś

| `feature` | Proces | Adapter / miejsce wywołania | Dostawca (domyślnie) | Kwota |
| --- | --- | --- | --- | --- |
| `deck_generation` | worker | `providers/openai/llm.ts` `generateDeck` | OpenRouter, Gemini 3.8 Flash | `usage.cost` |
| `lesson_generation` | worker | `providers/openai/llm.ts` `generateLessonPool` / `generateLessonObjectives` / `generateLessonStory` | OpenRouter, Gemini 3.8 Flash | `usage.cost` |
| `lesson_generation` (operacja `lesson_review`) | worker | `providers/openai/lesson-reviewer.ts` `reviewLessonObjective` (przez `lesson-json-request.ts`) | OpenRouter, `anthropic/claude-sonnet-5.5` | `usage.cost` |
| `lesson_generation` (operacje `agent_plan`, `agent_objective`, `check_solve`, `check_variants`) | worker | `providers/openai/lesson-pool-agent.ts` — agent puli lekcji i drugi model (checker), etap 2a #237 | OpenRouter (`provider: openrouter`), domyślnie `google/gemini-3.8-flash` i `deepseek/deepseek-v4.1-flash-1017` | `providerMetadata.openrouter.usage.cost`; jeden zapis na żądanie HTTP (także każdy krok narzędzi agenta); błąd HTTP = 0, brak odpowiedzi albo nieczytelne ciało 2xx = NULL |
| `tts` | worker | `providers/openai/tts.ts` | OpenRouter, Gemini 3.8 Flash TTS | zadanie 0 (§8.1): odpowiedź nie niesie kosztu; szacunek z długości audio (przybliżenie, rozliczenie prawdopodobnie tokenowe) |
| `illustration` | worker | `providers/images/openai.ts` (media run) | OpenAI | szacunek: obrazy × stawka |
| `deck_cover` | web | `providers/images/openai.ts` przez `materials/deck-cover.ts` `generateDeckCover` (bez runu) | OpenAI | szacunek: obrazy × stawka |
| `answer_grading` | web | `providers/openai-compatible/grader.ts` | OpenRouter, Gemini 3.8 Flash | `usage.cost` |
| `session_activity_review` | web | `providers/openai-compatible/session-activity.ts` | OpenRouter, Gemini 3.8 Flash | `usage.cost` |
| `lesson_stt` | web | `providers/openai-compatible/stt.ts` (dyktowanie i odpowiedzi ustne lekcji) | OpenRouter (np. ElevenLabs Scribe) | `usage.cost` (zadanie 0) |
| `speech_stt` | web | `providers/azure/stt.ts` | Azure Speech | szacunek: czas audio × stawka |
| `pronunciation` | web | `providers/azure/pronunciation.ts` | Azure Speech | szacunek: czas audio × stawka |

Review potwierdził, że w kodzie web, worker i server nie ma innych płatnych
wywołań HTTP. Trafienia cache `lesson_verdicts` nie wołają modelu. Fake'i
(`providers/fake.ts`) nie są płatne i niczego nie zapisują.

`usage.cost` dotyczy endpointów OpenRouter. Zgodny z OpenAI endpoint innego
dostawcy (np. awaryjne `api.openai.com` w `llm.ts`) zwykle go nie zwraca i daje
`cost_source: unknown`; to świadome ograniczenie.

## 3. Model danych

### 3.1 Nowa tabela `provider_usage_events`

Schemat `learning_app` (zmienna Drizzle `app`), przeglądana migracja SQL. Jeden
wiersz to jedno wywołanie HTTP do płatnej usługi, łącznie z każdym ponowieniem.

| Kolumna | Typ | Znaczenie |
| --- | --- | --- |
| `id` | uuid PK | |
| `occurred_at` | timestamptz not null | czas z `services.clock` w chwili `record()` (bez `default now()`) |
| `feature` | text not null, CHECK z listy §2 | funkcja produktu |
| `operation` | text null | np. `lesson_pool`, `lesson_objectives`, `lesson_story`, `grade`, `grade_school` |
| `provider` | text not null | z hosta `baseUrl`: `openrouter`, `openai`, `azure`, inaczej sam host |
| `model` | text null | identyfikator modelu wysłany w żądaniu |
| `outcome` | text not null, CHECK `ok`/`failed` | `failed` = odpowiedź HTTP inna niż 2xx, nieczytelne ciało, timeout, przerwanie, błąd sieci |
| `http_status` | smallint null | status odpowiedzi, gdy była |
| `input_tokens`, `output_tokens` | integer null, ≥ 0 | z `usage` (czat, STT, obrazy) |
| `characters` | integer null, ≥ 0 | długość tekstu TTS |
| `audio_ms` | integer null, ≥ 0 | długość audio (wynik TTS, wejście STT i wymowy) |
| `images` | integer null, ≥ 0 | liczba wygenerowanych obrazów |
| `cost_usd` | numeric(12, 6) null, ≥ 0 | kwota; NULL = nieznana |
| `cost_source` | text not null, CHECK `provider`/`price_table`/`not_billed`/`unknown` | skąd kwota (§4.4) |
| `price_ref` | text null | migawka stawki dla `price_table`, np. `UMIEM_PRICE_IMAGE_USD=0.04` |
| `scope_kind` | text not null, CHECK `run`/`session`/`deck`/`none` | jaki zakres był ustawiony przy zapisie; niezmienny |
| `generation_run_id` | uuid null FK → `generation_runs.id` ON DELETE SET NULL | run workera |
| `deck_id` | uuid null FK → `decks.id` ON DELETE SET NULL | talia, której dotyczy koszt materiału |
| `session_id` | uuid null FK → `learning_sessions.id` ON DELETE SET NULL | sesja nauki |
| `child_id` | uuid null FK → `child_profiles.id` ON DELETE SET NULL | dziecko |

CHECK-i spójności: `cost_source = 'unknown'` ⇔ `cost_usd is null`;
`cost_source = 'not_billed'` ⇒ `cost_usd = 0`; `price_ref is not null` ⇔
`cost_source = 'price_table'`.

Indeksy: `(occurred_at)`, `(deck_id)`, `(generation_run_id)`, `(session_id)`,
`(child_id, occurred_at)`. Indeks `session_id` jest potrzebny, bo kaskadowe
usunięcie `learning_sessions` z profilem wywołuje `SET NULL` w tej tabeli.

Wiersz nie zawiera treści: promptów, materiału, odpowiedzi dziecka, transkrypcji
ani nagrań. Nie ma kolumn imienia czy wieku. Zmiana cennika nie przepisuje
historii — kwota i `price_ref` są zapisane w chwili wywołania.

### 3.2 Pochodzenie runów mediów

Runy mediów (`tts`, `illustration`) mają tylko `asset_id`, a powiązania zasobu z
talią (`revision_assets`, `lesson_card_assets`, `lesson_story_assets`) są
nadpisywane i usuwane przy każdej edycji szkicu i regeneracji. Odczyt „kto
pierwszy podpiął zasób” gubiłby koszt mediów edytowanych pozycji.

Dlatego `generation_runs` dostaje nullable kolumnę `origin_deck_id` (FK →
`decks.id`), ustawianą przy tworzeniu runu mediów: talia szkicu, którego
uzgodnienie zleciło zasób (`media-reconciliation.ts`), albo talia, dla której
rodzic ręcznie zregenerował audio (`lesson-prompt-audio.ts`). Głos komunikatów
UI (`ui-audio.ts`) zostawia NULL. Kolumna jest tylko informacyjna: nie zmienia
CHECK-a `generation_runs_kind_shape`, dedupe, lease ani supersede. Unikalny
indeks `one_run_per_asset` sprawia, że zasób ma jeden run, więc współdzielony
zasób jest opłacony raz i przypisany talii, która go zleciła.

Runy zlecone przed migracją mają `origin_deck_id = NULL`; jeśli wykonają się po
wdrożeniu, ich koszt trafi do „Wspólne (interfejs)” razem z głosem UI —
świadome, krótkotrwałe przybliżenie (dziennik i tak zaczyna się od zera).

## 4. Zapis

### 4.1 Port i kontekst

`packages/server/src/ports/usage.ts` (jedyny plik w `ports/` z kodem
wykonywalnym — `AsyncLocalStorage`):

- `UsageEvent` — dane jednego wywołania bez kontekstu: `feature`, `operation?`,
  `provider`, `model?`, `outcome`, `httpStatus?`, jednostki, `providerCostUsd?`
  (liczba z odpowiedzi);
- `UsageRecorder` — `record(event: UsageEvent): void`, `flush(): Promise<void>`;
- `UsageScope` — `{ generationRunId?, deckId?, sessionId?, childId? }`;
- `withUsageScope(scope, fn)` i `currentUsageScope()`.

Zakres nie wpływa na żadną decyzję domenową, więc ukryty kontekst nie narusza
zasady jawnego przekazywania danych decyzyjnych. Odrzucona alternatywa: jawny
parametr w każdej metodzie portów LLM, TTS, STT, pronunciation, images i grader
(kilkadziesiąt sygnatur, fake'ów i testów). `src/domain` nie importuje
`ports/usage.ts`.

`withUsageScope` ustawiają przypadki użycia w `modules/`, nigdy handlery HTTP:

| Punkt wejścia | Zakres | `scope_kind` |
| --- | --- | --- |
| `materials/generation-worker.ts` — gałąź runu `deck`/`lesson` w `execute` | `{ generationRunId, deckId }` (talia z `deck_version_id`) | `run` |
| `materials/generation-worker.ts` — run mediów (run odczytany po `asset_id`, unikalny indeks `one_run_per_asset`) | `{ generationRunId, deckId: origin_deck_id }` | `run` |
| `materials/deck-cover.ts` `generateDeckCover` | `{ deckId }` | `deck` |
| `learning/lessons/lesson-attempts.ts` — wywołanie gradera (ok. l. 1462) | `{ sessionId, childId }` z `phase1.start.session` | `session` |
| `learning/session-activity.ts` — początek `settleAcceptedSessionActivity` (wołany fire-and-forget) | `{ sessionId, childId }` (dziecko dociągnięte z sesji) | `session` |
| `learning/speech.ts` — analiza mowy (STT, wymowa; ok. l. 309) | `{ sessionId, childId }` | `session` |
| `learning/lessons/lesson-dictation.ts` (ok. l. 84–88) | `{ sessionId, childId }` | `session` |

Wywołanie poza zakresem zapisuje się z `scope_kind: none` i trafia do „Inne”.
Wiersz funkcji nauki z `scope_kind: none` oznacza błąd w okablowaniu (pokazuje
go licznik „bez przypisania”, §6.1), a nie usunięty profil.

### 4.2 Adaptery

Fabryki adapterów płatnych usług i fabryki z env (`createGenerationDepsFromEnv`,
`imageProviderFromEnv`, `speechFromEnv`, `lessonSpeechFromEnv`, `graderFromEnv`,
`sessionActivityFromEnv` w `config.ts`) dostają `usage?: UsageRecorder`. Brak
recordera oznacza brak zapisu (testy jednostkowe, skrypty).

Adapter woła `usage?.record(...)` dokładnie raz na każde żądanie HTTP:

- **odpowiedź 2xx** — zaraz po `response.json()` (albo po odczycie bajtów
  audio/obrazu), **przed** sprawdzeniem `choices`, `finish_reason`, treści,
  JSON-a i walidacji semantycznej. Opłacona odpowiedź odrzucona później
  (`length`, zły JSON, niezgodny kształt) jest policzona jako `ok`;
- **nieczytelne ciało 2xx** (`json()` rzuca) — `failed`, `unknown`;
- **odpowiedź nie-2xx** — `failed` z `http_status`; koszt §4.4;
- **timeout, przerwanie, błąd sieci** — `failed`, `unknown` (dostawca mógł już
  naliczyć).

Ponowienia: worker ponawia cały run (`attempts`), więc każda próba to nowe
wywołanie i nowy wiersz. Wewnątrz jednego wywołania adaptera wiele żądań wysyła
tylko STT lekcji: pierwsze `verbose_json` po HTTP 400 jest ponawiane jako `json`
— to dwa wiersze, pierwszy `failed`.

Odczyt z ciała OpenRouter to czysta funkcja `usageFromPayload(payload)` w
`providers/usage/`: tokeny i `providerCostUsd`, gdy `usage.cost` jest skończoną
liczbą ≥ 0; w każdym innym wypadku tokeny (jeśli są) i brak kosztu. Nie rzuca.
Obrazy OpenAI zapisują tokeny z `usage` odpowiedzi, jeśli są (kwota i tak ze
stawki za obraz). Długość audio TTS: z nagłówka WAV (`audio/wav.ts`) albo MP3
(`audio/mp3-duration.ts`). Wejście STT i wymowy: `AudioInput` dostaje opcjonalne
`durationMs`, które przypadki użycia wypełniają z `normalizeAudioInput` (działa też
dla WebM); bez niego adapter próbuje nagłówka WAV, a gdy się nie da — wiersz bez
`audio_ms` (wycena `unknown`).

Jeśli zadanie 0 pokaże, że czat lub STT OpenRouter zwraca `cost` tylko na
żądanie, `withChatRequestExtras` dokłada `usage: { include: true }` wyłącznie
dla endpointów OpenRouter (`isOpenRouterEndpoint`) — inny zgodny endpoint mógłby
odrzucić nieznane pole.

Adapter nie loguje i nie zapisuje treści odpowiedzi.

### 4.3 Recorder

`packages/server/src/providers/usage/drizzle-recorder.ts` — jedyne miejsce
zapisu do tabeli:

- `record` czyta `currentUsageScope()`, czas z `services.clock`, wycenia
  (`priceUsage`, §4.4) i wykonuje osobny `INSERT` na puli połączeń, **poza
  transakcją biznesową**, bez awaitowania na ścieżce biznesowej;
- naruszenie klucza obcego (SQLSTATE 23503 — profil lub sesja usunięte w trakcie
  wywołania) ponawia `INSERT` raz z `child_id`/`session_id`/`deck_id`/
  `generation_run_id` = NULL; wiersz traci przypisanie, ale suma miesiąca się
  zgadza;
  *Errata 2026-11-02 (implementacja):* ponowienie obejmuje też zakleszczenie
  (SQLSTATE 40P01 — insert trzyma `KEY SHARE` na sesji i czeka na profil, który
  usuwa `deleteChild`); jeśli pierwotny wiersz miał `session_id` lub `child_id`,
  ponowienie zeruje także pola szczegółowe (`operation`, `model`, `http_status`,
  `input_tokens`, `output_tokens`, `characters`, `audio_ms`, `images`) jak
  zgrubienie z §5.4; `occurred_at` zostaje;
- inny błąd trafia do logu jako `usage_record_failed` z samym kodem błędu, bez
  treści i identyfikatorów dziecka;
- `flush()` czeka na zaległe zapisy. Nigdy nie wolno go awaitować wewnątrz
  transakcji biznesowej (`INSERT` z FK bierze `KEY SHARE` na wierszu sesji, który
  transakcja może trzymać `FOR UPDATE`).

Zapis poza transakcją to świadomy wyjątek od zasady „bez ukrytych niezależnych
commitów”: pieniądze są wydane także wtedy, gdy transakcja biznesowa się
wycofa, a dziennik kosztów nie bierze udziału w żadnej regule. Wyjątek trafia do
listy „Nazwane wyjątki — nie kopiuj” w `AGENTS.md`.

Składanie: worker tworzy pulę i bazę **przed** adapterami
(`apps/worker/src/composition.ts`) i przekazuje recorder do fabryk; kolejność
zamknięcia w `apps/worker/src/main.ts`: `loop.stop()` → `usage.flush()` →
`pool.end()`. Web składa recorder razem z providerami; `disposeServerServices`
(`apps/web/src/composition.ts`) woła `usage.flush()` przed `pool.end()`. Zapisy w
locie przy nagłym zabiciu procesu web mogą przepaść — przyjęte.
*Errata 2026-11-02 (implementacja):* `disposeServerServices` nie ma wywołującego
w produkcji (służy testom), więc web nie robi `flush()` przy zamknięciu —
zapisy w locie mogą przepaść przy każdym restarcie procesu web, nie tylko przy
nagłym zabiciu. Przyjęte jak wyżej. Worker przy błędzie kroku zamknięcia loguje
`[worker] shutdown step failed` z nazwą kroku i samym kodem błędu.

Cały `record` jest w `try/catch`: wyjątek recordera (np. w wycenie) nigdy nie
dociera do adaptera, bo zmieniłby wynik (ponowienie runu lekcji, „nieocenione”
w graderze).

### 4.4 Wycena i stawki

`providers/usage/pricing.ts` — czysta funkcja `priceUsage(event, prices)` →
`{ costUsd: string | null; costSource; priceRef: string | null }`:

| Sytuacja | Wynik |
| --- | --- |
| `providerCostUsd` obecny (także przy `failed`) | `provider`, kwota z odpowiedzi |
| `ok`, brak kosztu dostawcy, jest stawka i jednostka | `price_table`, jednostki × stawka, `price_ref` |
| `failed` z odpowiedzią nie-2xx, brak kosztu dostawcy | `not_billed`, 0 (założenie: odrzucone żądanie nie jest naliczane; dla OpenRouter sprawdzane w zadaniu 0) |
| `failed` bez odpowiedzi (timeout, przerwanie, sieć) albo z nieczytelnym ciałem | `unknown` |
| `ok`, brak stawki albo jednostki | `unknown` |

Cennik nigdy nie wycenia wywołań `failed`.

Kwoty: `usage.cost` przychodzi jako liczba JSON (także w zapisie wykładniczym,
np. `1.2e-7`). Konwersja do mikrodolarów `Math.round(cost × 1e6)` jako
`bigint`, odrzucenie wartości ponad zakres `numeric(12,6)` (→ `unknown`),
zapis jako string dziesiętny. Iloczyny stawek liczone w mikrodolarach na
`bigint`. Agregaty w SQL: `sum(cost_usd)::text`; udziały procentowe w
mikrodolarach na `bigint`, nigdy `parseFloat`. Zaokrąglone wiersze w widoku nie
muszą sumować się co do centa do zaokrąglonej sumy — akceptowane.

Stawki w `config-defaults.ts` (nadpisywalne w `.env`, dopisane do
`.env.example`), wartości z oficjalnych cenników z datą weryfikacji w
komentarzu:

| Zmienna | Jednostka | Dotyczy |
| --- | --- | --- |
| `UMIEM_PRICE_IMAGE_USD` | USD za obraz | `illustration`, `deck_cover` |
| `UMIEM_PRICE_TTS_USD_PER_MINUTE` | USD za minutę audio (przybliżenie; rozliczenie prawdopodobnie tokenowe) | `tts`, gdy odpowiedź nie niesie kosztu |
| `UMIEM_PRICE_AZURE_STT_USD_PER_HOUR` | USD za godzinę audio | `speech_stt` |
| `UMIEM_PRICE_AZURE_PRONUNCIATION_USD_PER_HOUR` | USD za godzinę audio | `pronunciation` |

- Wyłączenie stawki to wartość `none` (jak `UMIEM_TTS_STYLE=none`) → wiersze
  `unknown`. Pusta wartość (`X=`) zgodnie z `withConfigDefaults` przywraca
  domyślną.
- `UMIEM_PRICE_IMAGE_USD` jest domyślną **warunkową** (`CONDITIONAL_DEFAULTS`):
  obowiązuje tylko, gdy `UMIEM_IMAGE_MODEL`, `UMIEM_IMAGE_QUALITY` i
  `UMIEM_IMAGE_SIZE` mają wartości domyślne. Po zmianie obrazu bez własnej stawki
  koszty obrazów są `unknown`, a nie cicho liczone starą stawką. Analogicznie
  `UMIEM_PRICE_TTS_USD_PER_MINUTE` obowiązuje tylko przy domyślnym
  `UMIEM_TTS_MODEL`.
- Stawka obrazu jest przybliżeniem (gpt-image jest naliczany per token); panel
  oznacza ją „≈”.
- Niepoprawna wartość (nie liczba, ujemna) jest błędem startu, jak inne parsery
  konfiguracji.

## 5. Przypisanie kosztów

### 5.1 Materiały

Koszt talii to suma wierszy z `deck_id` tej talii:

- runy `deck`/`lesson` (generowanie zestawów, pul, celów, historyjek) — `deck_id`
  z wersji runu;
- runy mediów — `deck_id` z `generation_runs.origin_deck_id` (§3.2);
- okładki — `deck_id` z `generateDeckCover`.

Obejmuje wszystkie wersje i wszystkie próby, łącznie z regeneracjami,
edycjami i nieudanymi runami, z rozbiciem na generowanie, lektora, ilustracje i
okładkę. Zasób współdzielony z inną talią nie kosztuje drugi raz. Panel
wyjaśnia to jednym zdaniem pod tabelą.

Wiersze bez talii: głos komunikatów UI → „Wspólne (interfejs)” (run mediów bez
`origin_deck_id`); reszta materiałowa bez talii → „Inne”.

### 5.2 Dzieci

Funkcje nauki (`answer_grading`, `session_activity_review`, `lesson_stt`,
`speech_stt`, `pronunciation`) mają `session_id` i `child_id`. Koszt dziecka w
miesiącu to suma jego wierszy z `occurred_at` w miesiącu. Liczba sesji to
liczba `learning_sessions` dziecka z `started_at` w miesiącu — także sesji bez
żadnego kosztu (np. słówka bez mikrofonu). Sesja przechodząca przez granicę
miesiąca liczy się do miesiąca startu, a jej koszty do miesiąca wywołania.

Koszt dziecka nie obejmuje przygotowania materiałów (te są w „Materiały”);
widok mówi to podpisem.

### 5.3 Miesiąc

Miesiąc to przedział `[początek 1. dnia, początek 1. dnia następnego miesiąca)`
w strefie `family_settings.timezone`, liczony czystą funkcją domenową obok
`domain/report-period.ts` (`localDateBounds`). Bieżący miesiąc z
`services.clock`; miesiąc z przyszłości → błąd `validation`.

### 5.4 Usunięcie profilu dziecka — zgrubienie

Decyzja właściciela 2026-11-02. W tej samej transakcji, w której
`family/profiles.ts` `deleteChild` usuwa profil, najpierw blokuje się wiersz
profilu (`FOR UPDATE` — równoległy zapis kosztu czeka, a po commicie dostaje
23503 i idzie ścieżką bez przypisania), potem wiersze dziecka (`child_id = :id`)
są zgrubiane:

- `occurred_at` → początek miesiąca w strefie rodziny;
- `operation`, `model`, `http_status`, `input_tokens`, `output_tokens`,
  `characters`, `audio_ms`, `images`, `session_id`, `child_id` → NULL.

Zostaje kwota, źródło kwoty, funkcja, dostawca, miesiąc i `scope_kind:
session`. Suma miesiąca nadal zgadza się z rachunkiem, ale nie ma osi czasu ani
długości wypowiedzi. W widoku dzieci takie wiersze tworzą pozycję „Usunięte
profile”. Operację udostępnia moduł usage (`anonymizeChildUsage(tx, childId,
timezone)`); `deleteChild` ją woła — moduły już importują z `providers/`
(np. `learning/speech.ts`). Okno potwierdzenia usunięcia profilu wspomina, że
zostają anonimowe miesięczne kwoty kosztów.

Wiersz zapisany po usunięciu profilu (zapis w locie, §4.3) ma przypisanie
wyzerowane przez ponowienie po 23503; ma dokładny czas, ale nie da się go
powiązać z dzieckiem.

*Errata 2026-11-02 (implementacja):* kolejność blokad w `deleteChild` to
najpierw sesje dziecka (`learning_sessions … FOR UPDATE`, po `id`), potem wiersz
profilu — tak jak sprawdzanie FK insertu kosztu (sesja, potem profil), żeby
równoległy zapis nie zakleszczył się z kaskadą usunięcia. Wiersze przypisane
tylko przez sesję dziecka (`child_id` puste) też są zgrubiane. Strefa rodziny
przechodzi przez walidację (`validRewardTimezone`); nieprawidłowa wartość w
`family_settings.timezone` daje strefę domyślną, a usunięcie profilu się udaje.

## 6. Panel rodzica

Nowa sekcja `costs` w `PARENT_SECTIONS` (`/parent/costs`). Decyzja właściciela
2026-11-02: „Koszty” to pozycja menu panelu (`parent-menu`), a nie szósta
zakładka — dolny pasek na telefonie ma już pięć zakładek i nie zmieści szóstej
przy 320–360 px. Pasek zakładek pozostaje bez zmian. Mantine i TanStack Query zgodnie z
`2026-10-29-parent-ui-mantine`.

### 6.1 Nagłówek

Przełącznik miesiąca (← nazwa miesiąca →, domyślnie bieżący, bez przyszłych) i
karta z sumą: „Listopad 2026: 4,12 USD”. Pod nią, gdy niezerowe:

- „w tym ≈ 0,85 USD szacunkowo” (`price_table`);
- „N wywołań bez znanej ceny — suma jest zaniżona” (`unknown`);
- „N nieudanych wywołań” (`failed`);
- „N wywołań bez przypisania — to błąd aplikacji, zgłoś go” (funkcje nauki z
  `scope_kind: none` — sygnał błędu w kodzie).

Zawsze: „Ceny netto usług, bez VAT i opłat za doładowanie.”

### 6.2 Zakładki

1. **Funkcje** (wybrany miesiąc) — funkcja (polska nazwa: „Generowanie
   zestawów”, „Generowanie lekcji”, „Lektor (TTS)”, „Ilustracje”, „Okładki”,
   „Ocena odpowiedzi”, „Ocena aktywności”, „Dyktowanie i odpowiedzi ustne
   (lekcje)”, „Rozpoznawanie mowy (słówka)”, „Ocena wymowy” — bez nazw
   dostawców, bo hosty mogą się zmienić), liczba wywołań, jednostki
   („1,2 mln tokenów”, „38 min audio”, „12 obrazów”, „4 300 znaków”), koszt,
   udział %.
2. **Materiały** — talie z kolumnami: nazwa, typ (lekcja/słówka), generowanie,
   lektor, ilustracje i okładka (te trzy od początku), **razem od początku**,
   **w wybranym miesiącu**.
   Sortowanie po „razem” malejąco; kliknięcie otwiera talię w edytorze. Na
   końcu „Wspólne (interfejs)” i „Inne”, jeśli niezerowe. Pod tabelą: „Koszt
   wspólnego nagrania lub obrazu liczy się raz — dla zestawu, który je zlecił.”
3. **Dzieci** (wybrany miesiąc) — dziecko, liczba sesji, koszt, średnio na
   sesję, rozbicie: ocena odpowiedzi, mowa (STT i wymowa), ocena aktywności. Na
   końcu „Usunięte profile”, jeśli niezerowe. Podpis: „Bez kosztu przygotowania
   materiałów.”

Średnia na sesję liczona na serwerze w mikrodolarach (pusta przy zerze sesji).
Kwoty: USD, dwa miejsca po przecinku, polski format liczb; dodatnia poniżej
0,01 to „< 0,01 USD”. Kwota zawierająca szacunek ma „≈”; wiersz z wywołaniami
`unknown` dostaje dopisek „+N bez ceny”. Pusty miesiąc: „Brak płatnych wywołań w
tym miesiącu”.

### 6.3 API

Jedna procedura w `apps/web/src/parent/orpc-contract.ts`, wzorem `workCard`:
`costs` — `GET /costs?month=YYYY-MM`, ścisły schemat zapytania (odrzuca
nadmiarowe klucze, jak `ParentWorkCardQuerySchema`), `noStoreOutput`,
`parentOs` z `parentSessionMiddleware`. Zwraca nagłówek, Funkcje i Dzieci dla
miesiąca oraz Materiały z obiema kolumnami kwot.

*Errata 2026-11-02 (implementacja):* `month` jest opcjonalny — bez niego serwer
bierze bieżący miesiąc w strefie rodziny wg własnego zegara, a DTO zawsze niesie
`currentMonth` (`YYYY-MM`, bieżący miesiąc serwera). Panel pierwszy raz pyta bez
`month`, a strzałkę „dalej” wyłącza, gdy wybrany miesiąc to `currentMonth` —
zegar przeglądarki w innej strefie nie daje błędu ani nie blokuje nowego
miesiąca. Nieprawidłowa strefa rodziny daje strefę domyślną zamiast błędu 500.

DTO (Zod) w `packages/contracts`. Kwoty jako stringi dziesiętne, liczby
wywołań i jednostki jako liczby całkowite (`bigint` z SQL zamieniany na liczbę
w modelu odczytu). Przypadek użycia i zapytania w `modules/reporting/costs.ts`,
eksport przez barrel `reporting`. Raportowanie tylko czyta.

### 6.4 MCP i skill

Koszty nie trafiają do `learning-overview`, MCP ani `SKILL.md`: to dane
administracyjne rodzica, a nie nauka dziecka. Zmiana API nie dotyczy
udostępnionych narzędzi MCP, więc adapter MCP i skill pozostają bez zmian.

## 7. Granice i własność

| Miejsce | Zawartość |
| --- | --- |
| `packages/server/src/ports/usage.ts` | `UsageEvent`, `UsageRecorder`, `UsageScope`, `withUsageScope`, `currentUsageScope` |
| `packages/server/src/providers/usage/` | `usageFromPayload`, `priceUsage`, parser stawek, recorder Drizzle, `anonymizeChildUsage` |
| `packages/server/src/providers/**` | wywołania `usage?.record(...)` w adapterach płatnych usług |
| `packages/server/src/config.ts`, `config-defaults.ts` | parametr `usage` fabryk z env, stawki |
| `packages/server/src/db/schema.ts` + migracja | `provider_usage_events`, `generation_runs.origin_deck_id` |
| `modules/materials`, `modules/learning` | `withUsageScope` w punktach wejścia §4.1; `origin_deck_id` przy tworzeniu runów mediów |
| `modules/family/profiles.ts` | wywołanie `anonymizeChildUsage` w `deleteChild` |
| `modules/reporting/costs.ts` | model odczytu §6 |
| `apps/worker` | kolejność składania i zamknięcia (§4.3) |
| `packages/contracts`, `apps/web/src/parent` | DTO, kontrakt, sekcja „Koszty” |

Własność tabeli: zapisuje wyłącznie `providers/usage` (recorder i
`anonymizeChildUsage`), czyta wyłącznie `reporting/costs.ts`. Żaden moduł
obszaru nie pisze do niej bezpośrednio. Kierunki zależności między obszarami
bez zmian.

## 8. Weryfikacja i wdrożenie

**Zadanie 0 (przed implementacją adapterów)** — prawdziwe wywołania z domyślną
konfiguracją:

- czat OpenRouter: czy `usage.cost` przychodzi bez `usage: { include: true }`;
- `/audio/transcriptions` OpenRouter: czy `usage.cost` jest w odpowiedzi;
- `/audio/speech` OpenRouter: czy koszt jest w ciele lub nagłówku (jeśli nie —
  szacunek ze stawki za minutę — przybliżenie, bo rozliczenie jest prawdopodobnie
  tokenowe);
- odpowiedź z błędem 4xx: czy OpenRouter coś nalicza (weryfikacja założenia
  `not_billed` w panelu aktywności OpenRouter).

Bez klucza zadanie zostaje jawnie niezweryfikowane, TTS używa szacunku, a raport
końcowy to mówi.

**Testy jednostkowe:**

- `priceUsage`: każda funkcja i każdy wiersz tabeli §4.4, `none` → `unknown`,
  migawka `price_ref`, mikrodolary (`1.2e-7` → `0.000000`, wartość ponad zakres
  → `unknown`);
- `usageFromPayload`: poprawne `usage`, brak, `cost` ujemny, nieliczbowy, `NaN`;
- parser stawek i domyślne warunkowe: zmiana modelu/jakości/rozmiaru obrazu
  wyłącza domyślną stawkę;
- adaptery: `llm.ts`, `tts.ts`, `images/openai.ts` przez `vi.stubGlobal("fetch")`,
  pozostałe przez `fetchImpl`. Zapis przed walidacją (opłacona zła odpowiedź jest
  policzona jako `ok`), `failed` przy HTTP 500, nieczytelnym ciele i przerwaniu,
  dwa wiersze przy ponowieniu STT po 400, brak recordera = brak zapisu;
- funkcja miesiąca: granice w `Europe/Warsaw`, w tym miesiąc ze zmianą czasu
  (marzec, październik);
- recorder z fałszywą pulą: ponowienie po 23503 z wyzerowanym przypisaniem,
  `flush()` czeka na zaległe zapisy.

**Testy architektoniczne:**

- strażnik: każdy plik w `providers/**` (bez testów i `fake.ts`), który wywołuje
  `fetch(` lub `doFetch(`, przyjmuje opcję `usage` i woła `record` — nowy
  adapter płatnej usługi bez zapisu nie przejdzie;
- `src/domain` nie importuje `ports/usage.ts`;
- `reporting/costs.ts` nie importuje wewnętrznych plików innych obszarów
  (istniejący test granic).

**Testy integracyjne (Postgres)**, nowy plik w koszu `INTEGRATION_BUCKETS`
wskazanym w planie (najlżejszym):

- zakres w każdym punkcie wejścia §4.1: rejestrujący recorder testowy podpięty
  pod fake-providery zapisuje `currentUsageScope()`; po jednym przypadku na
  grader, ocenę aktywności (ścieżka fire-and-forget), analizę mowy, dyktowanie,
  okładkę, run lekcji i run mediów;
- przypisanie mediów: zasób zlecony przez talię A, potem ponownie użyty w B →
  koszt tylko w A; edycja słowa w szkicu i ręczna regeneracja audio → koszt
  nowego zasobu nadal w A; głos UI → „Wspólne (interfejs)”; narracja historyjki
  → talia lekcji;
- agregaty miesiąca w strefie rodziny, rozbicie na funkcje i źródła kwot,
  liczba sesji z sesjami bez kosztu;
- usunięcie profilu: wiersze zgrubione (czas, jednostki, sesja, dziecko),
  suma miesiąca bez zmian, pozycja „Usunięte profile”;
- rollback transakcji biznesowej nie usuwa wiersza kosztu;
- zamknięcie workera: `flush()` przed `pool.end()` zapisuje zaległy wiersz.

**E2E (`mocked`)** — parent specs stubują `**/api/v1/parent/**`: trzy zakładki,
przełączanie miesiąca, pusty miesiąc, „≈”, „+N bez ceny”, przejście z
„Materiały” do edytora. Spec dopisany do `tests/e2e/spec-projects.ts`.

**Dokumentacja:**

- `docs/architecture.md` — nowa sekcja „Koszty usług” (tabela, zapis poza
  transakcją, przypisanie, zgrubienie przy usunięciu profilu);
- `AGENTS.md` — reguła: nowy adapter płatnej usługi przyjmuje `UsageRecorder`,
  woła `record` przed walidacją wyniku i ma wiersz w tabeli §2; wpis na liście
  „Nazwane wyjątki — nie kopiuj” (zapis kosztów poza transakcją);
- `.env.example` — stawki i `none`.

Historia sprzed wdrożenia nie istnieje — dziennik zaczyna się od zera.

### 8.1 Wynik zadania 0

Zweryfikowano 2026-11-02 prawdziwymi wywołaniami OpenRouter (klucz z `.env`,
domyślna konfiguracja, koszt prób ok. 0,0003 USD).

| Ścieżka | Czy jest koszt w odpowiedzi | Flaga potrzebna | Decyzja |
| --- | --- | --- | --- |
| Czat `/chat/completions` (`google/gemini-3.8-flash`) | tak, `usage.cost` (USD, liczba) bez żadnej flagi | nie | `CHAT_NEEDS_USAGE_INCLUDE = false` |
| STT `/audio/transcriptions` (`elevenlabs/scribe-v2`) | tak, `usage.cost` (USD) bez żadnej flagi | nie | `STT_NEEDS_USAGE_INCLUDE = false` |
| TTS `/audio/speech` (`google/gemini-3.8-flash-tts`) | nie: ani w ciele, ani w nagłówku | nie dotyczy | `TTS_COST_HEADER = null` — szacunek ze stawki |
| 4xx (nieistniejący model, HTTP 400) | nie dotyczy | nie dotyczy | `ERRORS_BILLED = false` (zob. zastrzeżenie niżej) |

Zaobserwowane kształty i szczegóły:

- Czat: `usage` ma pola `prompt_tokens`, `completion_tokens`, `total_tokens`,
  `cost`, `is_byok`, `prompt_tokens_details` (`cached_tokens`,
  `cache_write_tokens`, `audio_tokens`, `video_tokens`), `cost_details`
  (`upstream_inference_cost`, `upstream_inference_prompt_cost`,
  `upstream_inference_completions_cost`) i `completion_tokens_details`
  (`reasoning_tokens`, `image_tokens`, `audio_tokens`). Przykład: 2 tokeny
  wejścia, 16 wyjścia (rozumowanie), `cost` 0,0000615.
- STT: adapter `providers/openai-compatible/stt.ts` wysyła JSON z `input_audio`
  (base64), nie multipart — próbę wykonano w tym samym formacie, więc flagą
  byłoby pole JSON `usage: { include: true }`, a nie pole formularza
  `usage[include]`. Ponieważ koszt przychodzi bez flagi, flaga w ogóle nie jest
  potrzebna. `usage` ma dokładnie dwa pola: `seconds` (długość nagrania, 1,04 s)
  i `cost` (0,0000636). Ciało ma ponadto `text`, `task`, `language`,
  `language_confidence`, `duration`, `segments`, `words`. Nagłówek
  `x-generation-id` jest, kosztu w nagłówkach nie ma.
- TTS: odpowiedź 200 z `content-type: audio/pcm;rate=24000;channels=1`, ciało
  to surowe PCM (bez JSON). Nagłówki z kosztem: brak (jedyny związany z
  rozliczeniem to `x-generation-id`, a `GET /generation?id=…` zwróciło 404, więc
  nie jest to droga odczytu kosztu). Orientacyjny pomiar różnicą `usage` klucza
  z `GET /key`: ok. 0,0000615 USD za „Hello” (0,92 s audio). Ta wartość
  jest identyczna jak koszt wywołania czatu i różnica kontrolna z tego samego
  zadania, więc może to być zbieg okoliczności albo zanieczyszczenie pomiaru
  (`usage` klucza obejmuje każde użycie tego klucza, także z innych sesji);
  jest niepotwierdzona. Rozliczenie jest prawdopodobnie tokenowe, nie za
  sekundę, ale wynika to z jednego pomiaru. `UMIEM_PRICE_TTS_USD_PER_MINUTE`
  jest więc zgrubnym szacunkiem do skalibrowania później, np. na dłuższym
  tekście i według panelu aktywności OpenRouter.
- 4xx: `POST /chat/completions` z modelem `google/nonexistent-model-xyz` zwraca
  400 z ciałem `{"error":{"message":"… is not a valid model ID","code":400},…}`.
  Zużycie klucza (`GET /key`, pole `usage`) przed i po wywołaniu było identyczne,
  a kontrola dodatnia (udane wywołanie czatu) podniosła je o 0,0000615 w ciągu
  3 s — pomiar jest więc dość czuły i opóźnienie go nie maskuje.

Czego nie zweryfikowano: panelu aktywności OpenRouter nie da się otworzyć z tej
sesji, więc użyto różnicy `usage` z `GET /key`. Sprawdzono tylko 400 dla
nieistniejącego modelu (żądanie odrzucone przed dostawcą). Nie sprawdzono 4xx/5xx
zwróconych przez dostawcę po rozpoczęciu pracy (np. 429, 5xx, przerwane
połączenie), więc założenie `not_billed` dla `failed` z `httpStatus >= 400`
pozostaje potwierdzone wyłącznie dla błędów walidacji żądania.

## 9. Rozstrzygnięcia review

| Uwaga | Rozstrzygnięcie |
| --- | --- |
| Okładki talii (web, bez runu) pominięte | nowa funkcja `deck_cover`, zakres `{ deckId }` (§2, §4.1) |
| „Pierwsza talia, która podpięła zasób” gubi koszt edytowanych i regenerowanych mediów; tabele powiązań nie mają czasu | `generation_runs.origin_deck_id` ustawiane przy zleceniu runu, `deck_id` w wierszu kosztu (§3.2, §5.1) |
| W `apps/worker` nie ma handlera runu; media kluczowane `assetId` | zakres w `generation-worker.ts`, `claimMediaRun` zwraca id runu (§4.1) |
| Pusta stawka nie da `unknown` (`withConfigDefaults`) | wartość `none`; stawki obrazu i TTS jako domyślne warunkowe (§4.4) |
| `SET NULL` zostawia oś czasu nauki usuniętego dziecka | zgrubienie w transakcji `deleteChild` — decyzja właściciela (§5.4) |
| Usunięty profil nieodróżnialny od braku zakresu | `scope_kind` przy zapisie, licznik „bez przypisania” (§3.1, §6.1) |
| FK 23503 przy zapisie po usunięciu profilu | ponowienie z wyzerowanym przypisaniem (§4.3) |
| `flush()` w transakcji może się zakleszczyć | zakaz zapisany w §4.3 |
| Brak indeksu `session_id` przy kaskadzie | dodany (§3.1) |
| `occurred_at default now()` vs wstrzykiwany zegar | czas z `services.clock` w `record()` (§3.1, §4.3) |
| Strefa: `family-date.ts` tylko formatuje | `family_settings.timezone` + `report-period.ts` (§5.3) |
| Koszt wywołań nieudanych niezdefiniowany | `http_status`, `not_billed` vs `unknown`, cennik nie wycenia `failed` (§4.4) |
| Zapis „przed parsowaniem” niemożliwy — koszt jest w ciele | po `json()`, przed sprawdzeniem treści (§4.2) |
| `usage.cost` dla czatu i STT niesprawdzony | rozwiązane w §8.1: czat i STT zwracają `usage.cost` bez flagi `usage.include`, więc żądania się nie zmieniają (§4.2, §8) |
| Składanie workera przed bazą; zamknięcie zamyka pulę przed zapisem | kolejność §4.3 |
| Float i zapis wykładniczy w `usage.cost` | mikrodolary `bigint`, agregaty w SQL (§4.4) |
| Niejednoznaczne „sesje” i średnia w zakładce Dzieci | `learning_sessions.started_at`, także sesje bez kosztu; podpis bez materiałów (§5.2) |
| Przełącznik „Ten miesiąc / Od początku” myli | Materiały zawsze z kolumnami „od początku” i „w miesiącu” (§6.2) |
| Ukryte `unknown` zaniża wiersze | „≈” i „+N bez ceny” per wiersz (§6.2) |
| Konwencja API rodzica | kontrakt w `orpc-contract.ts`, jedna procedura GET `/costs` (§6.3) |
| Wyjątek transakcyjny może być kopiowany | wpis w „Nazwane wyjątki” `AGENTS.md`, jednoznaczna własność tabeli (§4.3, §7) |
| Brak strażnika „adapter zapomniał zapisać” i testów zakresu w web | test architektoniczny + recorder testowy per punkt wejścia (§8) |
| `provider` z nazw adapterów niespójny | z hosta `baseUrl` (§3.1) |
| TTS może być MP3; obrazy naliczane per token | `mp3-duration.ts`; stawka obrazu jawnie przybliżona, tokeny zapisywane (§4.2, §4.4) |
| Nazwa schematu | `learning_app` (§3.1) |
| Skrypty ewaluacyjne nie zapisują kosztów | jawnie w §1 |
| Koszt w edytorze lekcji (sugestia) | poza zakresem — „Materiały” pokazuje koszt talii i prowadzi do edytora |
