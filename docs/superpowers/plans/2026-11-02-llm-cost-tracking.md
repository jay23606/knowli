# Śledzenie kosztów usług AI — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Każde płatne wywołanie usługi AI zapisuje wiersz kosztu, a panel rodzica pokazuje koszt miesiąca per funkcja, per talia i per dziecko.

**Architecture:** Adaptery w `packages/server/src/providers/**` wołają `UsageRecorder.record()` zaraz po odczycie odpowiedzi; recorder bierze kontekst z `AsyncLocalStorage` (`withUsageScope`, ustawiany w przypadkach użycia), wycenia (koszt OpenRouter albo cennik) i zapisuje osobnym `INSERT` poza transakcją biznesową do `provider_usage_events`. Raportowanie (`modules/reporting/costs.ts`) agreguje w SQL; panel rodzica ma sekcję „Koszty”.

**Tech Stack:** TypeScript strict, Node `AsyncLocalStorage`, Drizzle + PostgreSQL, Zod, oRPC, Mantine 9 + TanStack Query, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-02-llm-cost-tracking-design.md` (czytaj razem z planem; numery § poniżej odnoszą się do specu).

## Global Constraints

- Kwoty w USD, netto (bez VAT i opłat za doładowanie); w kodzie i DTO jako stringi dziesiętne, arytmetyka w mikrodolarach na `bigint`, nigdy `parseFloat` na kwotach.
- `cost_usd numeric(12,6)`; `cost_source ∈ {provider, price_table, not_billed, unknown}`; `outcome ∈ {ok, failed}`; `scope_kind ∈ {run, session, deck, none}`.
- `feature ∈ {deck_generation, lesson_generation, tts, illustration, deck_cover, answer_grading, session_activity_review, lesson_stt, speech_stt, pronunciation}`.
- Wiersz kosztu nie zawiera treści (prompt, materiał, odpowiedź dziecka, transkrypcja, nagranie), imienia ani wieku; logi recordera tylko z kodem błędu.
- Zapis: dokładnie jeden `record()` na żądanie HTTP, po `response.json()`/odczycie bajtów, przed walidacją treści; poza transakcją biznesową; `flush()` nigdy wewnątrz transakcji.
- Cennik nigdy nie wycenia `failed`; brak stawki → `unknown`, nie zero; wyłączenie stawki to wartość `none`.
- `withUsageScope` tylko w przypadkach użycia w `modules/`, nigdy w handlerach HTTP; `src/domain` nie importuje `ports/usage.ts`.
- Do tabeli piszą wyłącznie `providers/usage` (recorder, `anonymizeChildUsage`); czyta wyłącznie `modules/reporting/costs.ts`.
- Miesiąc w strefie `family_settings.timezone`; czas wiersza z `services.clock`.
- Teksty UI po polsku w `packages/contracts/src/messages.ts`; kod i identyfikatory po angielsku.
- Mantine tylko w `apps/web/src/parent` (pilnuje `tests/parent-mantine-scope.test.ts`).
- Koszty nie trafiają do MCP, `learning-overview` ani `SKILL.md`.

## Review Focus

1. Składanie procesu nie przekazuje recordera do którejś fabryki — produkcja po cichu nie zapisuje kosztów tej funkcji (testy w Task 4–6: `factory passes usage to adapter` per fabryka z env, `worker composition shares one recorder`).
2. Odpowiedź OpenRouter 200 z `finish_reason: length` albo złym JSON — opłacony koszt ma być w sumie (test w Task 4: `records paid response even when content is rejected`).
3. Awaria recordera (wyjątek w wycenie, padnięta baza) zmienia wynik nauki lub generacji — nie może (test w Task 4: `throwing recorder does not change adapter result`).
4. Podwójne liczenie jednego żądania na ścieżkach błędów (500 łapane ponownie przez catch transportu) — dokładnie jeden wiersz (asercje `toHaveLength(1)` w Task 4–5).
5. Usunięcie profilu w trakcie oceny odpowiedzi i miesiąc ze zmianą czasu — suma zgodna, wiersz bez dziecka i bez dokładnego czasu, granica miesiąca w strefie rodziny (testy w Task 3: `retries insert without scope ids on foreign key violation`, `deleteChild anonymizes usage rows`, `monthBounds handles DST and local midnight`).

---

### Task 0: Sprawdzenie odpowiedzi OpenRouter (zadanie 0 specu)

**Files:**
- Modify: `docs/superpowers/specs/2026-11-02-llm-cost-tracking-design.md` (nowy podrozdział „§8.1 Wynik zadania 0”)

- [ ] **Step 1: Sprawdź klucz.** `OPENROUTER_API_KEY` w `.env` worktree (`node scripts/setup-worktree.cjs --skip-install`, jeśli brak `.env`). Bez klucza: wpisz do §8.1 „niezweryfikowane — brak klucza”, przyjmij: czat i STT `usage.cost` bez flagi, TTS bez kosztu (szacunek), 4xx `not_billed`; przejdź do Task 1.
Skrypt pomocniczy w scratchpadzie (nie w repo), Node 22 `fetch`, klucz z `.env`; wyniki drukuj przez `JSON.stringify(...usage)` (w środowisku nie ma `jq`). Koszt prób: ułamki centa.

- [ ] **Step 2: Czat bez flagi.** `POST https://openrouter.ai/api/v1/chat/completions` z `{"model":"google/gemini-3.8-flash","messages":[{"role":"user","content":"Say hi"}]}` — czy `usage.cost` jest. Jeśli nie, powtórz z `"usage":{"include":true}`.
- [ ] **Step 3: STT.** `POST /api/v1/audio/transcriptions` (JSON z `input_audio` w base64 jak `providers/openai-compatible/stt.ts`, nie multipart) z krótkim WAV i modelem `elevenlabs/scribe-v2` — czy `usage.cost` jest; jeśli nie, powtórz z polem JSON `usage: { include: true }`.
- [ ] **Step 4: TTS.** `POST /api/v1/audio/speech` z `{"model":"google/gemini-3.8-flash-tts","voice":"Kore","input":"Hello","response_format":"pcm"}` — wypisz wszystkie nagłówki odpowiedzi; szukaj nagłówka z kosztem.
- [ ] **Step 5: 4xx.** Czat z nieistniejącym modelem — status i ciało; w panelu aktywności OpenRouter sprawdź, czy pojawiło się obciążenie.
- [ ] **Step 6: Zapisz wynik w §8.1** (tabela: ścieżka → czy jest `cost`, potrzebna flaga, decyzja) **i commit** `docs: wynik zadania 0 kosztów OpenRouter`. Wynik ustala stałe dla Task 4–5:
  - `CHAT_NEEDS_USAGE_INCLUDE: boolean` → Task 4 Step 3 (`withChatRequestExtras` tylko dla `isOpenRouterEndpoint`);
  - `STT_NEEDS_USAGE_INCLUDE: boolean` → Task 5 Step 3 (pole JSON `usage: { include: true }` w ciele żądania `stt.ts` tylko dla OpenRouter; wynik zadania 0: `false`, więc żądanie się nie zmienia);
  - `TTS_COST_HEADER: string | null` (nazwa nagłówka albo brak) → Task 5 Step 3 (odczyt nagłówka jako `providerCostUsd`; brak → szacunek ze stawki);
  - `ERRORS_BILLED: boolean` → jeśli `true`, Task 2 `priceUsage` zwraca dla `failed` z `httpStatus >= 400` `unknown` zamiast `not_billed` (zmień oczekiwanie w `pricing.test.ts`).

---

### Task 1: Schemat i migracja

**Files:**
- Modify: `packages/server/src/db/schema.ts` (nowa tabela `providerUsageEvents` obok `generationRuns`; kolumna `originDeckId` w `generationRuns`)
- Create: `packages/server/drizzle/0035_provider_usage_events.sql` — **pisana ręcznie** w stylu `0034_lesson_story_assets.sql`. Nie używaj `db:generate`: snapshoty Drizzle kończą się na 0017 (`docs/architecture.md` ~l. 560, 613), więc generator wyemitowałby ponownie 0018–0034.
- Modify: `packages/server/drizzle/meta/_journal.json` — wpis ręczny `idx: 35`, `tag: "0035_provider_usage_events"`, `when: 1793990000000` (musi być **większe** niż `when` 0034 = `1793890000000`, inaczej migrator pominie migrację na istniejących bazach; świeże bazy testowe tego nie wykryją)
- Modify: `docs/schema.sql` (odwzorowanie tabeli i kolumny)
- Create: `tests/integration/provider-usage.test.ts`
- Modify: `tests/integration-buckets.ts` (dopisz plik do najlżejszego kosza)

**Interfaces:**
- Produces: `providerUsageEvents` (Drizzle) z kolumnami §3.1 (nazwy TS: `occurredAt`, `feature`, `operation`, `provider`, `model`, `outcome`, `httpStatus`, `inputTokens`, `outputTokens`, `characters`, `audioMs`, `images`, `costUsd` (`numeric` → string), `costSource`, `priceRef`, `scopeKind`, `generationRunId`, `deckId`, `sessionId`, `childId`); `generationRuns.originDeckId: uuid | null` (FK `decks.id` `ON DELETE SET NULL`; kod dziś nie usuwa talii fizycznie, a SET NULL zabezpiecza na przyszłość). FK `provider_usage_events.deck_id` też `ON DELETE SET NULL`.

- [ ] **Step 1: Test CHECK-ów** w `provider-usage.test.ts`, `describe("provider_usage_events schema")`: insert poprawnego wiersza przechodzi; odrzucone: `cost_source='unknown'` z `cost_usd='0.1'`; `cost_source='provider'` z `cost_usd=null`; `cost_source='not_billed'` z `cost_usd='0.2'`; `price_ref` przy `provider`; `feature='other'`; `input_tokens=-1`; `scope_kind='x'`. Usunięcie profilu ustawia `child_id` i `session_id` na NULL (FK SET NULL).
- [ ] **Step 2: Uruchom** `pnpm test:integration -- tests/integration/provider-usage.test.ts` → FAIL (brak tabeli).
- [ ] **Step 3: Dodaj tabelę i kolumnę w `schema.ts`** z CHECK-ami i indeksami z §3.1 (`occurred_at`, `deck_id`, `generation_run_id`, `session_id`, `(child_id, occurred_at)`), napisz SQL migracji i wpis journala (schemat `learning_app`, nazwy constraintów `provider_usage_events_*`), odwzoruj w `docs/schema.sql`.
- [ ] **Step 4: Uruchom** test → PASS; `pnpm test:unit -- tests/integration-buckets.test.ts` → PASS; sprawdź ręcznie `when` w journalu > `1793890000000`.
- [ ] **Step 5: Commit** `feat(server): tabela provider_usage_events i origin_deck_id runów mediów`.

---

### Task 2: Port, odczyt `usage`, wycena i stawki (czysty rdzeń)

**Files:**
- Create: `packages/server/src/ports/usage.ts`
- Create: `packages/server/src/providers/usage/payload.ts`, `pricing.ts`, `prices-env.ts` (+ `*.test.ts` obok)
- Modify: `packages/server/src/config-defaults.ts` (+ test), `.env.example`

**Interfaces:**
- Produces (`ports/usage.ts`):
  ```ts
  export type UsageFeature = "deck_generation" | "lesson_generation" | "tts" | "illustration" | "deck_cover" | "answer_grading" | "session_activity_review" | "lesson_stt" | "speech_stt" | "pronunciation";
  export interface UsageEvent { feature: UsageFeature; operation?: string; provider: string; model?: string; outcome: "ok" | "failed"; httpStatus?: number; inputTokens?: number; outputTokens?: number; characters?: number; audioMs?: number; images?: number; providerCostUsd?: number; }
  export interface UsageRecorder { record(event: UsageEvent): void; flush(): Promise<void>; }
  export interface UsageScope { generationRunId?: string; deckId?: string; sessionId?: string; childId?: string; }
  export type UsageScopeKind = "run" | "session" | "deck" | "none";
  export function withUsageScope<T>(scope: UsageScope, fn: () => T): T;
  export function currentUsageScope(): UsageScope | undefined;
  export function scopeKindOf(scope: UsageScope | undefined): UsageScopeKind; // run > session > deck > none
  export function providerFromBaseUrl(baseUrl: string): string; // openrouter.ai→"openrouter", api.openai.com→"openai", *.microsoft.com / *.azure.com→"azure", inaczej host
  ```
- Produces (`providers/usage`): `usageFromPayload(payload: unknown): { inputTokens?: number; outputTokens?: number; providerCostUsd?: number }`; `interface UsagePrices { imageUsd?: string; ttsUsdPerMinute?: string; azureSttUsdPerHour?: string; azurePronunciationUsdPerHour?: string }` (stringi dziesiętne); `pricesFromEnv(env): UsagePrices`; `priceUsage(event: UsageEvent, prices: UsagePrices): { costUsd: string | null; costSource: "provider" | "price_table" | "not_billed" | "unknown"; priceRef: string | null }`.

- [ ] **Step 1: Testy** (Vitest, obok plików):
  - `ports/usage.test.ts`: zagnieżdżone `withUsageScope` — wewnętrzny zakres wygrywa i nie przecieka; zakres przeżywa `await` i `Promise.resolve().then`; `scopeKindOf({generationRunId, deckId}) === "run"`, `({sessionId, childId}) === "session"`, `({deckId}) === "deck"`, `(undefined) === "none"`; `providerFromBaseUrl` dla czterech przypadków.
  - `payload.test.ts`: `{usage:{prompt_tokens:10,completion_tokens:5,cost:0.00012}}` → tokeny i koszt; brak `usage` → `{}`; `cost: -1`, `"0.1"`, `NaN`, `Infinity` → bez kosztu, tokeny zostają; `payload = null` i tablica → `{}` bez wyjątku.
  - `pricing.test.ts` — każdy wiersz tabeli §4.4: koszt dostawcy `0.00012` → `{ "0.000120", provider, null }`; `1.2e-7` → `"0.000000"`; `1e7` (ponad zakres) → `unknown`; `NaN`/`Infinity` (gdyby ominęły `usageFromPayload`) → `unknown` bez wyjątku; `ok` ze stawką, ale bez jednostki (`images` brak) → `unknown`; `illustration` ok, 2 obrazy, `imageUsd:"0.04"` → `"0.080000"`, `price_table`, `priceRef:"UMIEM_PRICE_IMAGE_USD=0.04"`; `deck_cover` jak obrazy; `tts` ok, `audioMs: 90000`, `ttsUsdPerMinute:"0.02"` → `"0.030000"`; `speech_stt` `audioMs: 3600000`, `azureSttUsdPerHour:"1"` → `"1.000000"`; `pronunciation` analogicznie z własną stawką; `failed` z `httpStatus: 500` bez kosztu → `not_billed`, `"0.000000"`; `failed` z `httpStatus: 200` (nieczytelne ciało) → `unknown`; `failed` bez `httpStatus` → `unknown`; `failed` z kosztem dostawcy → `provider`; `ok` bez stawki → `unknown`; `failed` illustration z `imageUsd` → nie `price_table`.
  - `prices-env.test.ts`: `"none"` → brak stawki; `"0.04"` → `"0.04"`; `"-1"`, `"abc"` → wyjątek z nazwą zmiennej.
  - `config-defaults.test.ts` (dopisz): `image price default applies only to default image config` — `withConfigDefaults({})` ma `UMIEM_PRICE_IMAGE_USD`; z `UMIEM_IMAGE_MODEL: "other"` nie ma; jawne `UMIEM_PRICE_IMAGE_USD` przy innym modelu zostaje; to samo dla `UMIEM_PRICE_TTS_USD_PER_MINUTE` i `UMIEM_TTS_MODEL`; Azure stawki zawsze.
- [ ] **Step 2: Uruchom** `pnpm test:unit -- packages/server/src/ports packages/server/src/providers/usage packages/server/src/config-defaults.test.ts` → FAIL.
- [ ] **Step 3: Implementuj.** `pricing.ts`: konwersja `Math.round(cost * 1e6)` → `BigInt`, limit `999_999_999_999n` mikro (12,6), stringi stawek parsowane do mikrodolarów bez floatów (`"0.04"` → `40000n`), mnożenie/dzielenie na `bigint` z zaokrągleniem połówkowym (obrazy: `n × stawka`; minuta: `audioMs × stawka / 60000`; godzina: `audioMs × stawka / 3600000`), formatowanie `X.XXXXXX`. Stawki w `config-defaults.ts`: bezwarunkowe `UMIEM_PRICE_AZURE_STT_USD_PER_HOUR`, `UMIEM_PRICE_AZURE_PRONUNCIATION_USD_PER_HOUR`; w `CONDITIONAL_DEFAULTS` `UMIEM_PRICE_IMAGE_USD` (gdy `UMIEM_IMAGE_MODEL/QUALITY/SIZE` = domyślne) i `UMIEM_PRICE_TTS_USD_PER_MINUTE` (gdy `UMIEM_TTS_MODEL` = domyślny). Wartości z oficjalnych cenników (OpenAI gpt-image dla `low`/`1024x1024`, Azure Speech standard real-time i pronunciation assessment, Gemini Flash TTS przez OpenRouter przeliczone na minutę audio) z komentarzem `// cennik z 2026-11-0X: <URL>`. `.env.example`: blok „Ceny (USD) — `none` wyłącza”.
- [ ] **Step 4: Uruchom** testy z Step 2 → PASS; `pnpm typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(server): port UsageRecorder, odczyt usage i wycena kosztów`.

---

### Task 3: Recorder Drizzle, miesiąc rodziny, zgrubienie przy usunięciu profilu

**Files:**
- Create: `packages/server/src/providers/usage/drizzle-recorder.ts`, `anonymize.ts`
- Create: `packages/server/src/domain/report-month.ts` (+ `report-month.test.ts`)
- Modify: `packages/server/src/modules/family/profiles.ts` (`deleteChild`)
- Modify: `packages/server/src/config.ts` (`Services.usage?: UsageRecorder` — do `flush()` przy zamknięciu procesów i w testach; `createServices` przyjmuje `usage` w typie wejścia **i** przepisuje je w ciele, jak pozostałe pola)
- Modify: `packages/server/src/index.ts` (eksport `createDrizzleUsageRecorder`, `pricesFromEnv`, typów portu)
- Test: `tests/integration/provider-usage.test.ts` (rozszerz)

**Interfaces:**
- Consumes: Task 1 tabela; Task 2 `priceUsage`, `UsagePrices`, `currentUsageScope`, `scopeKindOf`.
- Produces:
  - `createDrizzleUsageRecorder(input: { db: Database; clock: Clock; prices: UsagePrices; log?: (code: string) => void }): UsageRecorder`;
  - `anonymizeChildUsage(tx: Executor, childId: string, timezone: string): Promise<void>`;
  - `monthBounds(month: string /* YYYY-MM */, timezone: string): { startUtc: string; endExclusiveUtc: string }` i `currentMonth(now: Date, timezone: string): string` w `domain/report-month.ts` (na `localDateBounds` z `report-period.ts`).

- [ ] **Step 1: Testy jednostkowe** `report-month.test.ts`: `monthBounds handles DST and local midnight` — `("2026-10","Europe/Warsaw")` → `startUtc "2026-09-30T22:00:00.000Z"`, `endExclusiveUtc "2026-10-31T23:00:00.000Z"`; `("2026-03", …)` → koniec `"2026-03-31T22:00:00.000Z"`; `currentMonth(new Date("2026-10-31T23:30:00Z"), "Europe/Warsaw") === "2026-11"`; `"2026-13"` → wyjątek.
- [ ] **Step 2: Testy integracyjne** (`provider-usage.test.ts`, `describe("usage recorder")`; baza z `testDatabase()`, recorder przez `createDrizzleUsageRecorder({ db, clock: manualClock, prices, log })`, serwisy przez `createServices({ db, clock, usage })` — `buildTestServices` nie przyjmuje recordera; `afterEach(() => recorder.flush())`, żeby zaległy insert nie wpadł do następnego testu):
  - `record never throws` — wycena rzuca (podstaw `prices` z niepoprawną wartością przez rzutowanie) → `record()` nie rzuca, `log` dostaje `"usage_record_failed"`;
  - zapis w `withUsageScope({ sessionId, childId })` daje wiersz z `scope_kind='session'`, `occurred_at` = czas `ManualClock`, kwotą z `priceUsage`;
  - `cost row survives business rollback` — `record()` wewnątrz `services.db.transaction` zakończonej wyjątkiem, potem `flush()` → wiersz istnieje;
  - `retries insert without scope ids on foreign key violation` — zakres z losowym `childId`/`sessionId` nieistniejącym w bazie → po `flush()` wiersz z NULL-ami i `scope_kind='session'`;
  - błąd innego rodzaju (np. `feature` spoza CHECK przez rzutowanie) → `log` dostaje `"usage_record_failed"`, `flush()` nie rzuca;
  - `deleteChild anonymizes usage rows` — dwa wiersze dziecka z 2026-10-15 12:34 → po `deleteChild` mają `occurred_at = 2026-09-30T22:00:00Z`, NULL w `operation, model, http_status, input_tokens, output_tokens, characters, audio_ms, images, session_id, child_id`, kwoty bez zmian, `scope_kind='session'`; wiersze innego dziecka nietknięte.
- [ ] **Step 3: Uruchom** → FAIL.
- [ ] **Step 4: Implementuj.** Recorder: całe ciało `record` w `try/catch` (żaden wyjątek nie wychodzi do adaptera — inaczej np. `asLessonTransportError` zamieniłby go w ponowienie runu, a grader w „nieocenione”); synchronicznie zbiera `{ event, scope: currentUsageScope(), at: clock.now() }`, wycenia, odpala `db.insert(...)` (pula, nie `tx`) i trzyma promise w zbiorze zaległych; 23503 → jeden ponowny insert z NULL w czterech kolumnach zakresu; inny błąd → `log("usage_record_failed")` (domyślnie `console.error("[usage] usage_record_failed", { code })`); `flush()` = `Promise.allSettled` zaległych. `anonymizeChildUsage`: jeden `UPDATE … SET occurred_at = (date_trunc('month', occurred_at AT TIME ZONE $tz) AT TIME ZONE $tz), … WHERE child_id = $id`. `deleteChild`: transakcja — **najpierw `SELECT … FROM child_profiles WHERE id = $1 FOR UPDATE`** (nowe inserty kosztów z FK czekają na `KEY SHARE`, a po commicie dostają 23503 i idą ścieżką bez przypisania, więc żaden wiersz nie ominie zgrubienia), odczyt `family_settings.timezone` z fallbackiem `DEFAULT_TIMEZONE` jak `learning-overview.ts:145`, `anonymizeChildUsage`, `delete childProfiles`.
- [ ] **Step 5: Uruchom** testy z Step 1–2 i `pnpm test:unit -- packages/server/src/modules/module-boundaries.architecture.test.ts` → PASS.
- [ ] **Step 6: Commit** `feat(server): recorder kosztów poza transakcją i zgrubienie przy usunięciu profilu`.

---

### Task 4: Adaptery czatu (generator, grader, ocena aktywności)

**Files:**
- Create: `packages/server/src/providers/usage/record-http.ts` (+ test)
- Modify: `packages/server/src/providers/openai/llm.ts`, `providers/openai-compatible/grader.ts`, `providers/openai-compatible/session-activity.ts`, `providers/chat-request-options.ts` (tylko gdy Task 0: `CHAT_NEEDS_USAGE_INCLUDE`)
- Modify: `packages/server/src/providers/generation-env.ts` (`createGenerationDepsFromEnv(env, usage?)`), `packages/server/src/config.ts` (`graderFromEnv(env, usage?)`, `sessionActivityFromEnv(env, usage?)`)
- Test: istniejące `*.test.ts` tych adapterów (+ nowe przypadki)

**Interfaces:**
- Consumes: `UsageRecorder`, `UsageEvent`, `usageFromPayload`, `providerFromBaseUrl` (Task 2).
- Produces: opcja `usage?: UsageRecorder` w `OpenAiLlmOptions`, `OpenAiCompatibleGraderOptions`, opcjach session-activity; `operation`: `deck` (`generateDeck`), `lesson_pool`, `lesson_objectives`, `lesson_story`, `grade` / `grade_school` (grader wg `input.school`), `review` (aktywność). `feature`: `deck_generation`, `lesson_generation`, `answer_grading`, `session_activity_review`.

- [ ] **Step 1: Testy** — rekorder testowy `{ events: UsageEvent[]; record(e){…}; flush: async () => {} }`; `llm.ts` przez `vi.stubGlobal("fetch", …)`, grader i aktywność przez `fetchImpl`:
  - `records paid response even when content is rejected` — `generateLessonPool` z odpowiedzią 200, `finish_reason: "length"`, `usage.cost: 0.003` → wyjątek `incomplete` i dokładnie jeden event `{ feature: "lesson_generation", operation: "lesson_pool", outcome: "ok", providerCostUsd: 0.003, provider: "openrouter" }` (baseUrl `https://openrouter.ai/api/v1`);
  - to samo dla złego JSON w `generateDeck` (`deck_generation`) i dla gradera (`content` nie-JSON → wyjątek, event `ok` z kosztem);
  - HTTP 500 → event `{ outcome: "failed", httpStatus: 500 }` bez kosztu; `json()` rzuca przy 200 → event `{ outcome: "failed", httpStatus: 200 }` (wycena da `unknown`, bo `not_billed` jest tylko dla `httpStatus >= 400`);
  - abort (`AbortSignal.abort()`) → event `failed` bez `httpStatus`, oryginalny wyjątek zachowany; `generateDeck` przy błędzie sieci rzuca ten sam wyjątek co dziś (bez opakowania); session-activity z abortem w trakcie `json()` → jeden event `failed`;
  - **każdy** przypadek błędu (500, nieczytelne ciało, abort, sieć) dla każdej metody — `expect(recorder.events).toHaveLength(1)` (500 rzucane wewnątrz `try` nie może zostać zapisane drugi raz w `catch` transportu);
  - `throwing recorder does not change adapter result` — recorder, którego `record` rzuca: `generateLessonPool` zwraca tę samą pulę, grader ten sam surowy werdykt, a błąd 500 ten sam wyjątek co bez recordera (dowód, że adapter i tak jest odporny, niezależnie od `try/catch` w recorderze z Task 3);
  - brak `usage` w opcjach → `fetch` wołany, zero eventów, zachowanie bez zmian;
  - grader z `input.school` → `operation: "grade_school"`;
  - `factory passes usage to adapter` (`generation-env.test.ts`, `config.test.ts`): `createGenerationDepsFromEnv(env, rec)` → wywołanie `deps.llm.generateDeck` ze stubem fetch daje 1 event; `graderFromEnv(env, rec)` i `sessionActivityFromEnv(env, rec)` analogicznie;
  - jeśli `CHAT_NEEDS_USAGE_INCLUDE`: ciało żądania do `openrouter.ai` zawiera `usage: { include: true }`, do `api.openai.com` nie.
- [ ] **Step 2: Uruchom** testy adapterów → FAIL.
- [ ] **Step 3: Implementuj** helpery w `providers/usage/record-http.ts` (wspólne z Task 5):
  - `recordResponse(usage: UsageRecorder | undefined, base: Omit<UsageEvent, "outcome" | "httpStatus">, status: number, payload: unknown): void` — `ok` dla 2xx z `usageFromPayload(payload)`;
  - `recordUnreadable(usage, base, status: number): void` — `failed` z `httpStatus` (ciało 2xx nie dało się odczytać);
  - `recordHttpError(usage, base, status: number): void` — `failed` z `httpStatus` dla nie-2xx;
  - `recordTransportFailure(usage, base): void` — `failed` bez `httpStatus`.
  Każdy helper sam łapie wyjątek z `usage.record` (podwójna ochrona). W adapterach jedna lokalna flaga `recorded` na żądanie: zapis po `response.json()` i przed pierwszym sprawdzeniem `choices`; nie-2xx przed `throw`; `catch` transportu zapisuje tylko, gdy `!recorded`. Fabryki z env przekazują `usage` do adapterów.
- [ ] **Step 4: Uruchom** testy adapterów i `pnpm test:unit -- packages/server/src/providers` → PASS.
- [ ] **Step 5: Commit** `feat(server): zapis kosztów w adapterach czatu`.

---

### Task 5: Adaptery mediów i mowy + strażnik architektoniczny

**Files:**
- Modify: `providers/openai/tts.ts`, `providers/images/openai.ts`, `providers/openai-compatible/stt.ts`, `providers/azure/stt.ts`, `providers/azure/pronunciation.ts`
- Modify: `providers/generation-env.ts` — `createGenerationDepsFromEnv` przekazuje `usage` do **TTS i obrazów** budowanych w tej funkcji (`feature: "illustration"`), `imageProviderFromEnv(env, usage?, feature?)`; `config.ts` (`speechFromEnv(env, usage?)`, `lessonSpeechFromEnv(env, usage?)`)
- Modify: `packages/server/src/ports/ai.ts` — `AudioInput.durationMs?: number` (wypełniane przez przypadki użycia z `normalizeAudioInput(...).durationSeconds`; adapter mowy bierze je przed nagłówkiem WAV — działa też dla WebM)
- Create: `packages/server/src/providers/usage-recording.architecture.test.ts`

**Interfaces:**
- Consumes: Task 2, helpery `record-http.ts` z Task 4.
- Produces: opcja `usage?: UsageRecorder` w pięciu adapterach; `createOpenAiImageProvider({ …, usage?, feature?: "illustration" | "deck_cover" })` (domyślnie `illustration`; web przekazuje `deck_cover`).

- [ ] **Step 1: Testy** (każdy przypadek błędu z `toHaveLength(1)`):
  - TTS: 200 z PCM 24 kHz 1,5 s → event `{ feature: "tts", outcome: "ok", characters: input.text.length, audioMs: 1500 }` (+ `providerCostUsd` z nagłówka, jeśli Task 0 dał `TTS_COST_HEADER`); format mp3 → `audioMs` z `audio/mp3-duration.ts`; 200 z nieznanym content-type → event `ok` (opłacone), potem wyjątek `provider_unexpected_audio`;
  - obrazy: 200 z jednym `b64_json` → `{ images: 1 }` plus tokeny z `usage`, jeśli są; `feature: "deck_cover"` przy tej opcji;
  - STT OpenRouter: 400 przy `verbose_json`, potem 200 przy `json` → dwa eventy, pierwszy `failed` z `httpStatus: 400`, drugi `ok` z `providerCostUsd`; 401/403 → jeden `failed`, zachowany `AppError`; `audioMs` z `input.durationMs`; jeśli `STT_NEEDS_USAGE_INCLUDE` — pole JSON `usage: { include: true }` tylko dla OpenRouter (wynik zadania 0: `false`, brak zmiany żądania);
  - Azure STT i wymowa: `audioMs` z `input.durationMs`, a bez niego z nagłówka WAV; WebM bez `durationMs` → event bez `audioMs` (wycena da `unknown`), bez wyjątku; `provider: "azure"`;
  - dla **wszystkich pięciu** adapterów: HTTP 500, abort, (dla JSON-owych) nieczytelne ciało → jeden event `failed`; brak recordera → zero eventów, zachowanie bez zmian;
  - `factory passes usage to adapter`: `createGenerationDepsFromEnv(env, rec)` → `deps.tts.synthesize` i `deps.image.generate` ze stubem fetch dają po 1 evencie (`illustration`); `imageProviderFromEnv(env, rec, "deck_cover")`, `speechFromEnv(env, rec)` i `lessonSpeechFromEnv(env, rec)` analogicznie;
  - `usage-recording.architecture.test.ts`: `every paid adapter records usage` — lista plików `providers/**/*.ts` (bez testów i `fake.ts`) z `fetch(`/`doFetch(` równa się dokładnie ośmiu adapterom z §2; w każdym liczba wywołań helperów `record(Response|Unreadable|HttpError|TransportFailure)\(` jest ≥ liczbie miejsc `fetch(`/`doFetch(` (regex, nie podciąg `record` — ten łapie też `Record<…>`). Strażnik pilnuje inwentarza; kompletność ścieżek pilnują testy behawioralne powyżej.
- [ ] **Step 2: Uruchom** → FAIL.
- [ ] **Step 3: Implementuj** — `record` po odczycie bajtów (`arrayBuffer()`) przed walidacją formatu; długość audio przez istniejące `wavDurationMs`/`mp3DurationMs`; `durationMs` w `AudioInput` wypełnij w `learning/speech.ts` i `learning/lessons/lesson-dictation.ts` z wyniku `normalizeAudioInput`.
- [ ] **Step 4: Uruchom** `pnpm test:unit -- packages/server/src/providers packages/server/src/config.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(server): zapis kosztów w adapterach mediów i mowy, strażnik adapterów`.

---

### Task 6: Zakresy w punktach wejścia, pochodzenie runów mediów, składanie procesów

**Files:**
- Create: `packages/server/src/modules/materials/usage-scope.ts`
- Modify: `materials/generation-worker.ts` (`execute`); `materials/media-reconciliation.ts` (`findOrCreateAsset`, `assetToBind`, `reconcileDraftAssetsTx`, `reconcileLessonCardAssetsTx`, `reconcileLessonStoryAssetTx`, insert w `regenerateRevisionAsset` ~l. 817); `materials/lessons/lesson-prompt-audio.ts` (`reconcileThenNextTx` → `enqueueNextGenerationTx`); `materials/deck-cover.ts` (`generateDeckCover`). `ui-audio.ts` bez zmian (własny insert, kolumna domyślnie NULL).
- Modify: `learning/lessons/lesson-attempts.ts` (~l. 1462), `learning/session-activity.ts` (`settleAcceptedSessionActivity`, dziecko dociągnięte z `learning_sessions`), `learning/speech.ts` (`reserved` niesie `sessionId`, `childId`), `learning/lessons/lesson-dictation.ts` (`reserved` niesie też `childId`)
- Modify: `apps/worker/src/composition.ts`, `apps/worker/src/main.ts` (wydzielone `shutdownWorker`), `apps/web/src/composition.ts` (`disposeServerServices` woła `usage.flush()` przed `pool.end()`)
- Test: `tests/integration/provider-usage-scope.test.ts` (nowy; po pierwszym przebiegu zmierz czas i dopisz do kosza o najmniejszej sumie po dodaniu — przebieg obejmuje generację i sesje), `tests/integration-buckets.ts`, `tests/integration/fakes.ts` (wrapper), `apps/worker/src/composition.test.ts`, `apps/worker/src/shutdown.test.ts`

**Interfaces:**
- Consumes: Task 3 recorder i `Services.usage`; fabryki z env z Task 4–5.
- Produces:
  - `runUsageScope(db, runId): Promise<UsageScope>` (`{ generationRunId, deckId }` z `deck_versions.deck_id`) i `mediaRunUsageScope(db, assetId): Promise<UsageScope>` (`{ generationRunId, deckId: originDeckId ?? undefined }`, run znaleziony przez `one_run_per_asset`) w `materials/usage-scope.ts`;
  - `findOrCreateAsset(tx, settings, req, originDeckId: string | null)`, `assetToBind(..., originDeckId: string | null)`, `enqueueNextGenerationTx(tx, fingerprint, originDeckId: string | null)`. `deck_id` odczytany **raz** na uzgodnienie: `reconcileDraftAssetsTx` czyta `deck_versions.deck_id` dla `version.id` i przekazuje dalej; lekcyjne reconcilery tak samo; `regenerateRevisionAsset` i `reconcileThenNextTx` biorą go z zablokowanej wersji;
  - `buildWorkerServices(): { services; pool; usage: UsageRecorder }`; `shutdownWorker(deps: { loop: { stop(): Promise<void> }; usage: UsageRecorder; pool: { end(): Promise<void> } }): Promise<void>`.
- Test helper: `recordingProvider<T extends object>(provider: T, usage: UsageRecorder, feature: UsageFeature): T` w `tests/integration/fakes.ts` — Proxy, który wywołuje metodę przez `Reflect.apply(fn, target, args)` (fake'i mają pola `#private`, `this = proxy` rzuciłoby TypeError) i woła `usage.record({ feature, provider: "fake", outcome: "ok" })` tylko, gdy wynik jest thenable. **Co dowodzi ten test:** propagację zakresu przez przypadki użycia i zapis przypisania; nie dowodzi miejsca `record` w prawdziwych adapterach (to Task 4–5) ani składania procesów (testy kompozycji niżej).

- [ ] **Step 1: Testy integracyjne** `provider-usage-scope.test.ts` (prawdziwy recorder Drizzle, fake-providery opakowane `recordingProvider`, `afterEach(() => recorder.flush())`, `flush()` przed każdą asercją):
  - run `deck` i run `lesson` przez `runDueGenerationWork` → wiersze z `generation_run_id` i `deck_id` talii, `scope_kind='run'`;
  - `media cost follows origin deck after edit and regeneration` — szkic słówek talii A z TTS → wiersz `tts` z `deck_id=A`; talia B z tym samym słowem → brak nowego wiersza; edycja słowa w A → nowy wiersz `deck_id=A`; „Regeneruj” (`regenerateRevisionAsset`) → `deck_id=A`; lekcja L: `regenerateLessonPromptAudio`, `regenerateLessonCardAudio`, `regenerateLessonStoryAudio` → wiersze z `deck_id=L`; głos UI (`ui-audio`) → `deck_id` NULL, `generation_run_id` ustawiony;
  - `generateDeckCover` → `feature='deck_cover'`, `deck_id`, `scope_kind='deck'`;
  - grader (odpowiedź niedopasowana deterministycznie), dyktowanie, próba mowy słówek → `session_id`, `child_id`, `scope_kind='session'`;
  - ocena aktywności: wywołaj publiczne wejście (`submitSessionActivityReport` albo odpowiednik z `session-activity.ts`), a potem poczekaj na zakończenie finalizacji (np. odczyt wyniku, który czeka na marker, albo `vi.waitFor` na wiersz) i dopiero `flush()` → `session_id`, `child_id`;
  - wywołanie fake'a poza zakresem → `scope_kind='none'`.
- [ ] **Step 2: Testy kompozycji i zamknięcia** (przed implementacją):
  - `apps/worker/src/composition.test.ts` `worker composition shares one recorder` — z `UMIEM_FAKE_PROVIDERS` wyłączonym i kluczami testowymi: `services.usage` istnieje, a wywołanie `services.generation.llm.generateDeck` ze stubem fetch daje 1 zaległy zapis w tym samym recorderze (spy na `record`);
  - `apps/worker/src/shutdown.test.ts` `shutdown flushes usage before closing pool` — kolejność `loop.stop` → `usage.flush` → `pool.end` na atrapach;
  - web: test `disposeServerServices` (jeśli brak harnessu — wydziel `disposeServices({ usage, pool })` w `apps/web/src/composition.ts` i przetestuj kolejność).
- [ ] **Step 3: Uruchom** Step 1–2 → FAIL.
- [ ] **Step 4: Implementuj.** `generation-worker.ts` `execute`: `withUsageScope(await runUsageScope(...), () => executeGeneration(...))` itd.; media przez `mediaRunUsageScope`. Punkty learning owijają wyłącznie wywołanie providera. Worker: `createDatabase` → `createDrizzleUsageRecorder({ db, clock: systemClock, prices: pricesFromEnv(env) })` → `createGenerationDepsFromEnv(env, usage)` → `createServices({ …, usage })`; `main.ts` woła `shutdownWorker`. Web: recorder z tej samej puli, przekazany do `speechFromEnv`, `lessonSpeechFromEnv`, `graderFromEnv`, `sessionActivityFromEnv`, `imageProviderFromEnv(env, usage, "deck_cover")` i do `createServices`; w trybie `UMIEM_FAKE_PROVIDERS=1` fake'i bez recordera (E2E nie zapisuje kosztów).
- [ ] **Step 5: Uruchom** Step 1–2, `pnpm test:unit`, `pnpm typecheck` → PASS.
- [ ] **Step 6: Commit** `feat: zakresy kosztów w punktach wejścia i pochodzenie runów mediów`.

---

### Task 7: Model odczytu i API kosztów

**Files:**
- Create: `packages/contracts/src/parent-costs.ts` (+ `parent-costs.test.ts`), eksport w barrelu contracts
- Create: `packages/server/src/modules/reporting/costs.ts`; Modify: `modules/reporting/index.ts`, `packages/server/src/index.ts`
- Modify: `apps/web/src/parent/orpc-contract.ts` (`costs.get`), `apps/web/src/orpc/parent-router.ts`
- Test: `tests/integration/provider-usage.test.ts` (`describe("cost report")`), `tests/integration/lesson-parent-api.test.ts` albo nowy przypadek w `provider-usage.test.ts` przez `handleParentApi`

**Interfaces:**
- Produces (`parent-costs.ts`):
  ```ts
  ParentCostsQuerySchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict();
  Money = z.string().regex(/^\d+\.\d{6}$/);
  ParentCostsDtoSchema = z.object({
    month, timezone: z.string(),
    totals: { costUsd: Money, estimatedUsd: Money, calls, unknownCalls, failedCalls, unscopedCalls: z.number().int() },
    features: z.array({ feature: UsageFeatureSchema, calls, inputTokens, outputTokens, characters, audioMs, images: int, costUsd: Money, estimated: boolean, unknownCalls: int, sharePercent: int 0–100 }),
    decks: z.array({ bucket: z.enum(["deck","shared_ui","other"]), deckId: uuid | null, title: string | null, kind: z.enum(["vocabulary","lesson"]) | null, generationUsd, ttsUsd, imagesUsd, totalUsd, monthUsd: Money, estimated: boolean, unknownCalls: int }),
    children: z.array({ childId: uuid | null, name: string | null, deleted: boolean, sessions: int, costUsd, gradingUsd, speechUsd, activityUsd: Money, perSessionUsd: Money.nullable() /* null przy 0 sesji; dzielenie na bigint */, estimated: boolean, unknownCalls: int }),
  });
  ```
- Produces (`reporting`): `readParentCosts(services: Services, input: { month: string }): Promise<ParentCostsDto>`; API `GET /costs?month=YYYY-MM`.
- Materiały: kolumny rozbicia (`generationUsd`, `ttsUsd`, `imagesUsd`) i `totalUsd` są **od początku**; tylko `monthUsd` dotyczy wybranego miesiąca. Talia bez kosztów od początku nie jest listowana. Kubełek `shared_ui` = runy mediów bez `deck_id` (głos UI i runy zlecone przed migracją — świadome przybliżenie, §3.2 specu); `other` = pozostałe wiersze materiałowe bez talii.

- [ ] **Step 1: Testy:**
  - contracts: zapytanie z `token` → odrzucone; `"2026-13"` → odrzucone; kwota `"1.5"` → odrzucona.
  - integracyjne: pusty miesiąc → wszystkie kwoty `"0.000000"`, listy puste, schemat DTO przechodzi; `perSessionUsd` dla dziecka z 3 sesjami i 0.010000 USD → `"0.003333"`, przy 0 sesjach `null`;
  - integracyjne: dane z ręcznie wstawionych wierszy w 2026-10 i 2026-11 (strefa `Europe/Warsaw`, wiersz 2026-10-31T23:30Z należy do listopada): sumy Funkcji i `sharePercent` (suma udziałów 99–101); `estimatedUsd` tylko z `price_table`; `unknownCalls`, `failedCalls`, `unscopedCalls` (funkcja nauki z `scope_kind='none'`); Materiały — `totalUsd` od początku vs `monthUsd`, `imagesUsd` = illustration + deck_cover, kubełki `shared_ui` (run mediów bez `deck_id`) i `other` (reszta bez talii), sortowanie po `totalUsd` malejąco z kubełkami na końcu; Dzieci — `sessions` liczy `learning_sessions.started_at` w miesiącu także bez kosztu; wiersze zgrubione (`scope_kind='session'`, `child_id` NULL) → pozycja `deleted: true`; przyszły miesiąc → `AppError("validation")`;
  - przez `handleParentApi`: bez sesji rodzica → 401; z sesją → 200 i `cache-control: no-store`.
- [ ] **Step 2: Uruchom** → FAIL.
- [ ] **Step 3: Implementuj** zapytania z `coalesce(sum(cost_usd), 0)::numeric(18,6)::text` (pusta suma to `"0.000000"`, a suma może przekroczyć zakres kolumny), filtrem `occurred_at >= startUtc and < endExclusiveUtc` z `monthBounds`; `sharePercent` na `bigint` mikrodolarów; liczniki `bigint` → `Number`. Kontrakt wzorem `workCard` (`noStoreOutput`, `openapi({ method: "GET", path: "/costs", outputStructure: "detailed" })`), handler `noStore(await readParentCosts(context.services, input))`.
- [ ] **Step 4: Uruchom** testy z Step 1, `pnpm test:unit -- packages/server/src/modules/module-boundaries.architecture.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat: model odczytu i API kosztów dla panelu rodzica`.

---

### Task 8: Sekcja „Koszty” w panelu rodzica

**Files:**
- Modify: `apps/web/src/parent/parent-routes.ts` (+ test: `"costs"` w `PARENT_SECTIONS`), `ParentShell.tsx`, `ParentIcon.tsx` (nowa ikona `wallet` w unii `ParentIconName` + ścieżka SVG), `ParentApp.tsx`, `api.ts`
- Modify: `tests/e2e/parent-shell-layout.spec.ts` (asercje menu)
- Nawigacja (decyzja właściciela 2026-11-02): **„Koszty” jako pozycja menu `parent-menu`** (`Menu.Item`, `data-testid="to-costs"`, ikona `wallet`, `mih={48}`, nad „Przejdź do nauki”), widoczna na każdej szerokości. Pasek zakładek bez zmian: `ParentShell` renderuje zakładki z listy `TAB_SECTIONS` (pięć dotychczasowych), a `PARENT_SECTIONS` zawiera dodatkowo `costs` dla routingu. Na `/parent/costs` żadna zakładka nie jest aktywna, a nagłówek sekcji to „Koszty”.
- Create: `apps/web/src/parent/CostsPanel.tsx`, `costs-panel.css`, `cost-format.ts` (+ `cost-format.test.ts`)
- Modify: `packages/contracts/src/messages.ts` (`messages.costs.*`, `messages.children.removeKeepsCostTotals`), `ChildEditor.tsx` (dopisek w oknie usuwania)
- Create: `tests/e2e/parent-costs.spec.ts`; Modify: `tests/e2e/spec-projects.ts` (partycja `mocked`)

**Interfaces:**
- Consumes: `ParentCostsDtoSchema`, `GET /costs`.
- Produces: `formatUsd(amount: string): string` — zaokrąglenie połówkowe do centów na `bigint` mikrodolarów (bez `Number` na kwocie), separator tysięcy i przecinek wg pl-PL („4,12 USD”, „< 0,01 USD”, „0,00 USD”); `formatUnits(feature, row): string` — czat (`deck_generation`, `lesson_generation`, `answer_grading`, `session_activity_review`): tokeny wejścia+wyjścia („1,2 mln tokenów”); `tts`, `lesson_stt`, `speech_stt`, `pronunciation`: minuty audio („38 min audio”, poniżej minuty „< 1 min audio”); `illustration`, `deck_cover`: „12 obrazów” (polska odmiana 1/2–4/5+); `shiftMonth(month: string, delta: -1 | 1): string`.

- [ ] **Step 1: Testy jednostkowe** `cost-format.test.ts`: `formatUsd("4.123456") === "4,12 USD"`, `formatUsd("0.004000") === "< 0,01 USD"`, `formatUsd("0.000000") === "0,00 USD"`, `formatUsd("1234.505000") === "1 234,51 USD"` (spacja niełamliwa wg `Intl` pl-PL); `formatUsd("0.005000") === "0,01 USD"`; jednostki: po jednym przypadku na grupę i odmiana „1 obraz / 3 obrazy / 5 obrazów”; `shiftMonth("2026-01", -1) === "2025-12"`. `parent-routes.test.ts`: `/parent/costs` ↔ `{ section: "costs" }`.
- [ ] **Step 2: Teksty** w `messages.costs`: `title: "Koszty"`, `total: "{month}: {amount}"`, `estimated: "w tym ≈ {amount} szacunkowo"`, `unknownCalls: "{n} wywołań bez znanej ceny"`, `failedCalls: "{n} nieudanych wywołań"`, `unscopedCalls: "{n} wywołań bez przypisania"`, `netNote: "Ceny netto usług, bez VAT i opłat za doładowanie."`, `tabs: { features: "Funkcje", decks: "Materiały", children: "Dzieci" }`, nazwy funkcji z §6.2, `sharedUi: "Wspólne (interfejs)"`, `other: "Inne"`, `deletedProfiles: "Usunięte profile"`, `sharedAssetNote: "Koszt wspólnego nagrania lub obrazu liczy się raz — dla zestawu, który je zlecił."`, `childrenNote: "Bez kosztu przygotowania materiałów."`, `empty: "Brak płatnych wywołań w tym miesiącu"`, `withoutPrice: "+{n} bez ceny"`, kolumny Materiałów „Razem od początku” / „W wybranym miesiącu”. `messages.children.removeKeepsCostTotals: "Zostaną tylko anonimowe miesięczne kwoty kosztów usług."`.
- [ ] **Step 3: E2E** `parent-costs.spec.ts` (route `**/api/v1/parent/costs**` z fixture DTO, wzorem `parent-children.spec.ts`): nagłówek z sumą i „≈”; trzy zakładki z wierszami; „+2 bez ceny” w wierszu talii; strzałka ← wysyła `month=2026-10`; strzałka → wyłączona w bieżącym miesiącu (`page.clock.setFixedTime(new Date("2026-11-15T12:00:00Z"))`, bo zależy od zegara przeglądarki); pusty DTO → komunikat `empty`; klik w talię → URL `/parent/decks/<id>`; wejście przez menu: klik `parent-menu` → `to-costs` → URL `/parent/costs`; telefon 375×812 i 320×640 bez poziomego przepełnienia strony (`document.documentElement.scrollWidth <= innerWidth`; tabele w kontenerze z przewijaniem), cele ≥ 44 px dla strzałek miesiąca. Dopisz do `MOCKED_SPECS` w `spec-projects.ts`.
  - `parent-shell-layout.spec.ts`: w testach telefonu i ≥ 600 px menu zawiera `to-costs` (cel ≥ 44 px); asercje „pięć zakładek” bez zmian (pasek nie rośnie).
  - `parent-children.spec.ts`: okno usuwania profilu zawiera tekst `removeKeepsCostTotals`.
- [ ] **Step 4: Uruchom** unit → FAIL, potem implementuj `CostsPanel` (Mantine `Tabs`, `Table` w `Table.ScrollContainer`, `ActionIcon` strzałek, TanStack Query `useQuery(["costs", month])`), wpięcie sekcji i dopisek w oknie usuwania profilu.
- [ ] **Step 5: Uruchom** `pnpm test:unit -- apps/web/src/parent tests/parent-mantine-scope.test.ts tests/e2e/spec-projects.test.ts` i `UMIEM_E2E_WEB_MODE=dev pnpm exec playwright test tests/e2e/parent-costs.spec.ts tests/e2e/parent-shell-layout.spec.ts tests/e2e/parent-children.spec.ts --project=mocked` → PASS.
- [ ] **Step 6: Commit** `feat(web): sekcja Koszty w panelu rodzica`.

---

### Task 9: Dokumentacja i pełna weryfikacja

**Files:**
- Modify: `docs/architecture.md` (nowa sekcja „23. Koszty usług (2026-11-02)”), `AGENTS.md`

- [ ] **Step 1: `architecture.md`** — tabela, zapis poza transakcją, przypisanie (`origin_deck_id`, `deck_id`), zgrubienie przy usunięciu profilu, ceny netto, brak w MCP; odnośnik do specu.
- [ ] **Step 2: `AGENTS.md`** — w „Generowanie, media i prywatność”: „Nowy adapter płatnej usługi przyjmuje `usage?: UsageRecorder`, woła `record` raz na żądanie HTTP przed walidacją wyniku i ma wiersz w tabeli §2 specu kosztów (pilnuje `usage-recording.architecture.test.ts`); `withUsageScope` tylko w przypadkach użycia.” W „Nazwane wyjątki”: „`providers/usage` zapisuje koszty osobnym `INSERT` poza transakcją biznesową (pieniądze są wydane także przy rollbacku); `flush()` nigdy w transakcji. Nie kopiuj dla stanu domeny.”
- [ ] **Step 3: Weryfikacja** — `pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration`, `pnpm build`, `pnpm test:e2e:shards` → wszystko PASS (zapisz liczby testów do opisu PR).
- [ ] **Step 3a: Opis PR** — wpływ API → MCP → skill: nowy endpoint rodzica `GET /costs` nie jest udostępniony w MCP ani `learning-overview`, więc adapter MCP i `SKILL.md` bez zmian (uzasadnienie wymagane przez `AGENTS.md`); wynik zadania 0; migracja 0035 (ręczna, `when` w journalu); wymagane wdrożenie: web i worker razem (worker zamyka recorder przed pulą).
- [ ] **Step 4: Commit** `docs: koszty usług w architekturze i AGENTS.md`.
