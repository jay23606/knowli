# Historyjka lekcji — etap 2 (nagranie lektora) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zatwierdzona historyjka lekcji gramatyki dostaje nagranie en-GB
w workerze. Rodzic może je odsłuchać i nagrać ponownie w edytorze. Dziecko
jeszcze go nie słyszy (etap 3).

**Architecture:** Wzorem nagrań kart nauki (`lesson_card_assets`, migracja 0028):
- tabela `lesson_story_assets` (jeden wiersz na wersję);
- uzgadnianie w `reconcileDraftAssetsTx` (`materials/media-reconciliation.ts`);
- worker rozpoznaje odwołania z nowej tabeli;
- stan nagrania w DTO szkicu i procedura „Nagraj ponownie”
  (`materials/lessons/lesson-prompt-audio.ts`);
- w panelu rodzica wspólny komponent `PromptAudioControls` w sekcji historyjki.

Tekst nagrania daje istniejąca czysta funkcja `storyReadText`
(`domain/lessons/story.ts`, etap 1).

**Tech Stack:** TypeScript strict, Drizzle + PostgreSQL (migracje SQL pisane
ręcznie z wpisem w `_journal.json`), Vitest, oRPC, React + Mantine 9, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-01-lesson-end-story-design.md` —
§7, §6.6 (`storyAudio`), §11 (odsłuch i „Nagraj ponownie”), §12 (nota w specu
stylu TTS), §14, §15 „Media”, §16 etap 2.

## Global Constraints

- Kod, identyfikatory i DTO piszemy po angielsku. Teksty UI dla rodzica po polsku,
  w `packages/contracts/src/messages.ts`.
- Silnik lekcji nie zna przedmiotów: żadnych literałów `english_grammar` w
  `modules/materials/lessons`, `modules/learning/lessons`, `domain/lessons` (poza
  `subjects/`). Nagranie zależy wyłącznie od flagi `SubjectModule.lessonStory`
  i `subject.answerLocale` (pilnuje `domain/lessons/architecture.test.ts`).
- Nagranie historyjki: rola `feedback_audio` w `ttsAsset`, tekst
  `storyReadText(story)`, locale `subject.answerLocale`, **bez stylu** (§7, §12).
- Do TTS trafiają wyłącznie zdania zatwierdzonej historyjki; żadnych danych dziecka.
- Nagranie nie jest decyzją rodzica i nie blokuje publikacji. Nieudane nagranie
  uzgadnianie zleca ponownie także przy publikacji (bez `keepFailed`).
- Gotowe zasoby są niezmienne; „Nagraj ponownie” to kolejna generacja
  tego samego fingerprintu (`enqueueNextGenerationTx`).
- Wiersze `lesson_story_assets` opublikowanej wersji są niezmienne (trigger).
- Inny obszar importuje tylko z barrela; granic pilnuje
  `packages/server/src/modules/module-boundaries.architecture.test.ts`.
- Nowe pola DTO są opcjonalne (zgodność wstecz).
- Panel rodzica: wyłącznie Mantine, w `apps/web/src/parent`.
- Nowy plik integracyjny trafia do najlżejszego kosza `tests/integration-buckets.ts`.
- Commity kończą się linią `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

### Ustalenia planowania (rulings)

- **Finalizacja runu historyjki uzgadnia tylko nagranie historyjki**
  (`reconcileLessonStoryAssetTx`), a nie całe `reconcileDraftAssetsTx`. Run
  zmienia wyłącznie `lesson_context.story`. Pełne uzgadnianie przepinałoby przy
  okazji inne zasoby szkicu po zmianie konfiguracji, a to jest rola edycji.
  Spec §6.2 krok 4 mówi `reconcileDraftAssetsTx`; wpisujemy doprecyzowanie
  w Task 4.
- **Kopia wersji** (`createVersionFromPublished`) nie kopiuje wiersza, tak jak
  przy kartach. Wiersz powstaje przy pierwszym uzgodnieniu: edycji albo
  publikacji (`reconcileBeforePublish`). Do tego czasu kopia nie ma
  `storyAudio` w DTO, tak samo jak nie ma `cardAudio`.
- **Odsłuch w edytorze** jest widoczny tylko wtedy, gdy zdania formularza są
  równe zapisanym. Zmiana samych pytań nie zmienia nagrania, więc nie ukrywa
  odsłuchu. „Nagraj ponownie” i tak jest zablokowane przy niezapisanych
  zmianach (`locked`).
- **Ścieżka procedury:** `POST /lesson-drafts/{lessonDraftId}/story-audio/regenerate`,
  wejście `{ lessonDraftId }`, wynik `{ assetId }`, status 202.

## Review Focus

1. **Zdania zmienione, zanim worker nagrał poprzednie.** Stary zasób `pending`
   traci odwołania. Worker oznacza go jako `failed`, a run jako `superseded`
   (gałąź „bez odwołań” w `supersedeDisabledLessonTts`). Panel nie pokazuje go
   jako porażki (`notCancelled`). Nowe nagranie dochodzi do `ready`.
   Test: Task 2.
2. **Zmiana tylko pytań nie zleca nowego nagrania** (ten sam fingerprint
   i asset). Test: Task 1.
3. **Usunięcie historyjki** (`story: null`) kasuje wiersz. DTO nie ma wtedy
   `storyAudio`, a odpytywanie się kończy. Test: Task 1 (wiersz), Task 2 (DTO),
   Task 3 (poll).
4. **Nieudane nagranie przy publikacji** jest zlecane ponownie (nowa generacja
   `pending`), a publikacja na nie nie czeka. Test: Task 1.
5. **Przedmiot bez `lessonStory`** z pozostałym wierszem (np. flaga wyłączona
   w kodzie) — worker oznacza nagranie jako zbędne i nie woła providera.
   Wspólny fingerprint użyty gdzie indziej zostaje aktywny. Test: Task 2.

---

### Task 1: Tabela `lesson_story_assets` i uzgadnianie nagrania

**Files:**
- Create: `packages/server/drizzle/0033_lesson_story_assets.sql`
- Modify: `packages/server/drizzle/meta/_journal.json` (wpis `idx: 33`, `tag: "0033_lesson_story_assets"`, `when` większe od wpisu 32)
- Modify: `packages/server/src/db/schema.ts` (obok `lessonCardAssets`)
- Modify: `packages/server/src/modules/materials/media-reconciliation.ts`
- Modify: `packages/server/src/modules/materials/lessons/lesson-story-generation.ts` (finalizacja)
- Modify: `tests/integration/school-lesson-audio-helpers.ts` (`truncateLessonAudioTables` czyści też nową tabelę)
- Test: `packages/server/src/modules/materials/media-reconciliation.test.ts`
- Create test: `tests/integration/lesson-story-audio.test.ts` (+ wpis w najlżejszym koszu `tests/integration-buckets.ts`)

**Interfaces:**
- Consumes: `storyReadText(story: LessonStory): string`, `LessonStory`
  (`domain/lessons/story.ts`); `SubjectModule.lessonStory?: boolean`,
  `SubjectModule.answerLocale` (`domain/lessons/types.ts`).
- Produces:
  - `lessonStoryAssets` (Drizzle): `deckVersionId` (PK, FK `deck_versions.id`),
    `assetId: uuid | null` (FK `media_assets.id`), `expectedFingerprint: text not null`;
  - `export function requiredAssetForLessonStory(story: LessonStory | undefined, subject: Pick<SubjectModule, "lessonStory" | "answerLocale"> | undefined, settings: MediaSettings): RequiredAsset | null`
    (`media-reconciliation.ts`);
  - `export async function reconcileLessonStoryAssetTx(tx: Tx, services: Services, versionId: string): Promise<void>`
    (no-op bez `services.media`).

- [ ] **Step 1: Unit test `requiredAssetForLessonStory`** w `media-reconciliation.test.ts`:
  - przedmiot `{ lessonStory: true, answerLocale: "en-GB" }` i historyjka
    `["Tom has a cat.", " It  is small. "]` dają `role: "feedback_audio"`,
    `metadata.text === "Tom has a cat. It is small."`, `metadata.locale === "en-GB"`
    i brak `metadata.instructions` przy ustawieniach bez instrukcji per locale;
  - `lessonStory: false`, `undefined` subject i `undefined` story dają `null`;
  - historyjka z innymi pytaniami daje ten sam `fingerprint`, a inne zdanie — inny.
- [ ] **Step 2:** `pnpm vitest run packages/server/src/modules/materials/media-reconciliation.test.ts`. Oczekiwane: FAIL (brak eksportu).
- [ ] **Step 3: Migracja i schemat.**
  - `0033_lesson_story_assets.sql` to kopia `0028_lesson_card_assets.sql`:
    - tabela z PK `lesson_story_assets_pk` na `deck_version_id`;
    - FK bez kaskady;
    - indeks `lesson_story_assets_asset_idx`;
    - funkcja `learning_app.guard_lesson_story_asset_change()`;
    - trigger `lesson_story_assets_immutable` z komunikatem `'Published lesson story asset is immutable'`;
    - komentarz nagłówka po polsku: historyjka żyje w `lesson_context.story`.
  - Drizzle `lessonStoryAssets` w `schema.ts` z tymi samymi nazwami ograniczeń.
- [ ] **Step 4: Implementacja w `media-reconciliation.ts`.**
  - `requiredAssetForLessonStory` zwraca `ttsAsset("feedback_audio", storyReadText(story), subject.answerLocale, settings)`,
    gdy `subject?.lessonStory === true`, historyjka istnieje i tekst nie jest
    pusty. W przeciwnym razie zwraca `null`.
  - `reconcileLessonStoryAssetTx`:
    - czyta `lesson_context` wersji (`subjectId`, `story`); przedmiot przez
      `services.subjects.getSubject`;
    - gdy wymaganego zasobu brak, usuwa wiersz;
    - gdy wiersz ma ten sam fingerprint i jego asset nie jest `failed`,
      zostawia go;
    - w każdym innym przypadku wstawia lub aktualizuje wiersz przez
      `findOrCreateAsset` — logika jak w `reconcileLessonCardAssetsTx`.
  - Wywołanie w `reconcileDraftAssetsTx` zaraz po `reconcileLessonCardAssetsTx`,
    przed wczesnym `return` przy braku rewizji. Opcja `keepFailed` historyjki
    nie dotyczy.
  - `story` z `lesson_context` sprawdź minimalnie: `Array.isArray(story.sentences)`.
- [ ] **Step 5: Finalizacja runu historyjki.** W `lesson-story-generation.ts`, w tej
  samej transakcji, po zapisie `lesson_context.story` wywołaj
  `reconcileLessonStoryAssetTx(tx, services, versionId)`. Ścieżki porażki
  i `superseded` niczego nie uzgadniają.
- [ ] **Step 6: Testy integracyjne** w `tests/integration/lesson-story-audio.test.ts`.
  - Szkic gramatyki z historyjką: seed jak w `tests/integration/lesson-story.test.ts`.
  - Media: `audioServices()` z `school-lesson-audio-helpers.ts`, z rejestrem
    przedmiotów zawierającym `english_grammar`.
  - Nazwy testów:
  - `edit with a story creates one story recording in en-GB without style`
    (wiersz, `metadata.text === storyReadText`, `locale en-GB`, brak `instructions`);
  - `changing story sentences binds a new recording, changing only questions keeps it`;
  - `removing the story deletes its recording row`;
  - `successful story run binds the recording in the same transaction`
    (fake LLM jak w `lesson-story.test.ts`; po `runDueGenerationWork` wiersz istnieje
    i wskazuje zasób `pending`);
  - `failed story recording is queued again on publish and publish does not wait for it`;
  - `published version story recording row is immutable` (UPDATE/DELETE przez `pool.query`
    odrzucone komunikatem triggera);
  - `new version from published gets its story recording on publish without edit`.
- [ ] **Step 7:** Uruchom:
  - `pnpm vitest run packages/server/src/modules/materials/media-reconciliation.test.ts`;
  - `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/lesson-story-audio.test.ts tests/integration/lesson-story.test.ts tests/integration/lesson-card-audio.test.ts`.

  Oczekiwane: PASS.
- [ ] **Step 8: Commit** `Historyjka: tabela i uzgadnianie nagrania lektora`.

---

### Task 2: Worker, stan nagrania w DTO i „Nagraj ponownie” (serwer + kontrakt)

**Files:**
- Modify: `packages/server/src/modules/materials/media-generation.ts` (`supersedeDisabledLessonTts`)
- Modify: `packages/server/src/modules/materials/lessons/lesson-prompt-audio.ts`
- Modify: `packages/server/src/modules/materials/lessons/lesson-api.ts` (DTO szkicu)
- Modify: `packages/server/src/modules/materials/index.ts`, `packages/server/src/index.ts` (eksport)
- Modify: `packages/contracts/src/lessons.ts` (`LessonDraftDtoSchema.storyAudio`)
- Modify: `apps/web/src/parent/orpc-contract.ts`, `apps/web/src/orpc/parent-router.ts`
- Test: `tests/integration/lesson-story-audio.test.ts`, `apps/web/src/orpc/parent-router.test.ts`

**Interfaces:**
- Consumes: `lessonStoryAssets`, `reconcileLessonStoryAssetTx` (Task 1).
- Produces:
  - `readLessonAudioStates(...)` zwraca dodatkowo `story: LessonPromptAudioDto | undefined`;
  - `LessonDraftDto.storyAudio?: LessonPromptAudioDto` (brak pola = brak nagrania);
  - `export async function regenerateLessonStoryAudio(services: Services, input: { lessonDraftId: string }): Promise<{ assetId: string }>`;
  - procedura `lessonDrafts.regenerateStoryAudio` (`POST /lesson-drafts/{lessonDraftId}/story-audio/regenerate`,
    wejście `{ lessonDraftId: UuidSchema }` `.strict()`, wynik `{ assetId: UuidSchema }`, 202).

- [ ] **Step 1: Testy integracyjne (dopisz do `lesson-story-audio.test.ts`):**
  - `worker brings the story recording to ready and the draft dto shows it`
    (`runDueGenerationWork`, potem `readLessonDeck`:
    `draft.storyAudio = { state: "ready", assetId }`);
  - `story recording replaced before the worker ran is cancelled, not shown as failed`
    (Review Focus 1: edycja zdań przed workerem, stary zasób `failed` + run
    `superseded`, `storyAudio` wskazuje nowe nagranie);
  - `worker cancels a story recording of a subject without lessonStory` (rejestr
    przedmiotów z kopią gramatyki z `lessonStory: false`; wiersz wstawiony SQL-em;
    zasób `failed`, run `superseded`, provider niewołany);
  - `regenerate story audio enqueues the next generation and the dto shows pending with previous`
    (`{ state: "pending", previousAssetId }`);
  - `regenerate story audio rejects published version (immutable) and draft without recording (not_found)`;
  - `draft without story has no storyAudio`.
- [ ] **Step 2:** Uruchom plik — FAIL.
- [ ] **Step 3: Worker.** W `supersedeDisabledLessonTts` dołącz odwołania
  z `lesson_story_assets` (join `deck_versions` po `deck_version_id`, tylko
  `lessonContext`) jako odwołania lekcji z pseudo-rolą `"story"`. Predykat
  „wyłączone” dla `"story"` to `!subject.lessonStory`. Zaktualizuj komentarz
  funkcji.
- [ ] **Step 4: Odczyt i ponowne nagranie.**
  - `readLessonAudioStates`: jedno zapytanie po `lessonStoryAssets` join
    `mediaAssets` po fingerprint, `kind = 'tts'`, `notCancelled`, sortowanie
    `generationNumber desc`. Wynik daje `audioDto`.
  - `lesson-api.ts`: `...(audio.story ? { storyAudio: audio.story } : {})`.
  - `regenerateLessonStoryAudio`: schemat Zod `{ lessonDraftId: z.uuid() }`,
    `assertMediaConfigured`, `lockDraft`, `readRow` po `deckVersionId`,
    `reconcileThenNextTx`. Gdy nie `rebound`, aktualizuje `assetId` wiersza
    (wzór `regenerateLessonCardAudio`).
  - Eksport przez barrel `materials/index.ts` i `packages/server/src/index.ts`.
- [ ] **Step 5: Kontrakt i router.**
  - `storyAudio: LessonPromptAudioDtoSchema.optional()` w `LessonDraftDtoSchema`,
    z komentarzem PL.
  - Procedura w `orpc-contract.ts` obok `regenerateCardAudio`, z komentarzem
    „«Nagraj ponownie» historyjki”.
  - Handler w `parent-router.ts` i wpis w mapie routera.
  - `parent-router.test.ts`, wzorem testów `regenerateCardAudio`:
    - `regenerateStoryAudio zleca ponowne nagranie historyjki i zwraca 202 {assetId}`;
    - `regenerateStoryAudio odrzuca nadmiarowe pole bez wołania przypadku użycia`.
- [ ] **Step 6:** Uruchom:
  - `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/lesson-story-audio.test.ts tests/integration/lesson-card-audio.test.ts tests/integration/grammar-without-tts.test.ts`;
  - `pnpm vitest run apps/web/src/orpc/parent-router.test.ts packages/server/src/modules/module-boundaries.architecture.test.ts packages/server/src/domain/lessons/architecture.test.ts`;
  - `pnpm typecheck`.

  Oczekiwane: PASS.
- [ ] **Step 7: Commit** `Historyjka: worker, stan nagrania i „Nagraj ponownie” na serwerze`.

---

### Task 3: Odsłuch i „Nagraj ponownie” w edytorze rodzica

**Files:**
- Modify: `apps/web/src/parent/lessons/PromptAudioControls.tsx`
- Modify: `apps/web/src/parent/lessons/LessonStorySection.tsx`
- Modify: `apps/web/src/parent/lessons/LessonEditor.tsx` (`lessonPollInterval`, render sekcji)
- Modify: `apps/web/src/parent/lessons/lesson-story-form.ts`
- Modify: `packages/contracts/src/messages.ts` (`lessons.storyAudioTarget: "historyjka"`)
- Test: `apps/web/src/parent/lessons/prompt-audio-controls.test.tsx`, `lesson-story-section.test.tsx`,
  `lesson-story-form.test.ts`, `lesson-poll-interval.test.ts`
- Test E2E: `tests/e2e/lesson-parent.spec.ts` (projekt `real`, już w partycji)

**Interfaces:**
- Consumes: `LessonDraftDto.storyAudio`, `orpc.lessonDrafts.regenerateStoryAudio` (Task 2).
- Produces:
  - `PromptAudioTarget` z wariantem `{ kind: "story" }`;
  - `LessonStorySection` z opcjonalnym propem `audio?: ReactNode` (renderowany
    w szkicu i w wersji opublikowanej, nad zdaniami);
  - `export function storySentencesUnchanged(saved: LessonStoryDto | undefined, form: LessonStoryDto | null | undefined): boolean`
    (`lesson-story-form.ts`): `form === undefined` daje `true`; w pozostałych
    przypadkach porównanie tablic zdań (`null` i brak zapisu są różne od
    historyjki).

- [ ] **Step 1: Testy jednostkowe (failing):**
  - `lesson-story-form.test.ts`: `storySentencesUnchanged`:
    - `true` dla `undefined` formularza;
    - `true` przy zmianie samego pytania;
    - `false` przy zmianie zdania;
    - `false` dla `null` przy zapisanej historyjce.
  - `prompt-audio-controls.test.tsx`: `story target regenerates via regenerateStoryAudio with only the draft id`
    (wzór istniejących testów karty).
  - `lesson-story-section.test.tsx`: `renders the audio slot in editable and published views`.
  - `lesson-poll-interval.test.ts`: `polls every 3 s while only the story recording is pending`
    i `stops polling when the story recording is ready`.
- [ ] **Step 2:** `pnpm vitest run apps/web/src/parent/lessons` — FAIL.
- [ ] **Step 3: Implementacja.**
  - `PromptAudioControls`: trzecia mutacja `regenerateStoryAudio`. Wybór
    mutacji i `reset` obejmują wszystkie trzy. Dla `story` wywołanie
    `mutate({ lessonDraftId })`.
  - `lessonPollInterval`: `visible?.storyAudio?.state === "pending"` wchodzi
    do gałęzi 3000 ms. Zaktualizuj komentarz.
  - `LessonEditor`: wylicz `storyAudio`:
    - źródłem jest `active?.storyAudio`;
    - w szkicu tylko przy `storySentencesUnchanged(draft?.story, storyForm)`.
  - `PromptAudioControls` w slocie `audio` sekcji:
    - `target={{ kind: "story" }}`;
    - `targetLabel={messages.lessons.storyAudioTarget}`;
    - `testId="lesson-story-audio"`;
    - `canRegenerate={editable}`;
    - `locked={busy || isDirty}`;
    - `onPlay={playAsset}`.
- [ ] **Step 4:** `pnpm vitest run apps/web/src/parent/lessons` — PASS.
- [ ] **Step 5: E2E** w `tests/e2e/lesson-parent.spec.ts`, test
  `parent edits generated story and publishes`:
  - po `waitForGeneratedStory`: `lesson-story-audio-listen` widoczny (timeout
    jak dla historyjki, fake TTS workera);
  - po zmianie zdania: `lesson-story-audio` ma liczbę 0;
  - po zapisie wraca (`lesson-story-audio` widoczny);
  - w wersji opublikowanej: `lesson-story-audio-listen` widoczny,
    a `lesson-story-audio-regenerate` ma liczbę 0.

  Uruchom: `UMIEM_E2E_WEB_MODE=dev pnpm exec playwright test tests/e2e/lesson-parent.spec.ts -g "story"`. Oczekiwane: PASS.
- [ ] **Step 6: Commit** `Historyjka: odsłuch i „Nagraj ponownie” w edytorze`.

---

### Task 4: Dokumentacja i pełna weryfikacja etapu

**Files:**
- Modify: `docs/architecture.md` §19.13 (akapit o `lesson_story_assets`)
- Modify: `docs/superpowers/specs/2026-11-01-lesson-end-story-design.md`
  (status: „etap 2 zaimplementowany”; w §6.2 krok 4 i §7 doprecyzowanie: finalizacja uzgadnia tylko nagranie historyjki)
- Modify: `docs/superpowers/specs/2026-10-30-tts-voice-style-design.md` (nota: nagranie historyjki bez stylu, w en-GB)

- [ ] **Step 1: Dokumentacja.** Akapit w §19.13 obejmuje:
  - tabelę (migracja `0033`);
  - tekst `storyReadText` w `answerLocale` bez stylu;
  - uzgadnianie w edycji, publikacji i finalizacji runu;
  - ponowne zlecenie nieudanego nagrania;
  - worker (`lessonStory`);
  - `storyAudio` w DTO;
  - procedurę `regenerateStoryAudio`;
  - brak odsłuchu u dziecka do etapu 3.
- [ ] **Step 2: MCP.** Sprawdź, że `apps/web/src/integrations` i `integrations/umiem-mcp`
  nie używają `LessonDraftDto` ani procedur `lessonDrafts`:
  `grep -rn "lessonDrafts\|LessonDraftDto\|storyAudio" apps/web/src/integrations integrations/umiem-mcp`.
  Oczekiwane: brak trafień. Uzasadnienie trafia do PR.
- [ ] **Step 3: Pełna weryfikacja.** Uruchom:
  - `pnpm typecheck`;
  - `pnpm test:unit`;
  - `pnpm test:integration`;
  - `pnpm build`;
  - `pnpm test:e2e:shards`.

  Oczekiwane: wszystko PASS (poza znanymi pominięciami zrzutów).
- [ ] **Step 4: Commit** `Historyjka etap 2: dokumentacja`.
