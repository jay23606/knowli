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

Wersja 2 planu — po recenzji trzech niezależnych krytyków (mechanizm mediów;
UX i kontrakt panelu; testy i regresje).

## Global Constraints

- Kod, identyfikatory i DTO piszemy po angielsku. Teksty UI dla rodzica po polsku,
  w `packages/contracts/src/messages.ts`.
- Silnik lekcji nie zna przedmiotów: żadnych literałów `english_grammar` w
  `modules/materials/lessons`, `modules/learning/lessons`, `domain/lessons` (poza
  `subjects/`). Nagranie zależy wyłącznie od flagi `SubjectModule.lessonStory`
  i `subject.answerLocale` (pilnuje `domain/lessons/architecture.test.ts`).
- Nagranie historyjki: rola `feedback_audio` w `ttsAsset`, tekst
  `storyReadText(story)`, locale `subject.answerLocale`, **bez stylu wypowiedzi**
  (§7, §12). Instrukcja języka en-GB z konfiguracji zostaje — tak działa
  `ttsRequestInstructions` dla każdego nagrania bez stylu.
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
- Commity kończą się linią `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

### Ustalenia planowania (rulings)

- **Finalizacja runu historyjki uzgadnia tylko nagranie historyjki**
  (`reconcileLessonStoryAssetTx`), a nie całe `reconcileDraftAssetsTx`. Run
  zmienia wyłącznie `lesson_context.story`. Pełne uzgadnianie przepinałoby przy
  okazji inne zasoby szkicu po zmianie konfiguracji, a to jest rola edycji.
  Spec §6.2 krok 4 mówi `reconcileDraftAssetsTx`; doprecyzowanie wpisuje Task 4.
- **Akceptowane ryzyko:** wyjątek uzgadniania wewnątrz transakcji finalizacji
  (np. przejściowy błąd bazy) cofa zapis historyjki, a run kończy się wg
  istniejącej ścieżki błędu finalizacji. Uzgadnianie to kilka zapytań do tej
  samej bazy bez wywołań zewnętrznych, więc ryzyko jest takie jak przy samym
  zapisie historyjki.
- **Kopia wersji** (`createLessonDraftFromPublished`) wywołuje
  `reconcileLessonStoryAssetTx` w transakcji kopii. `findOrCreateAsset` zwraca
  istniejący gotowy zasób o tym samym fingerprincie, bez kosztu TTS. Nowy szkic
  od razu pokazuje nagranie i „Nagraj ponownie”. Lekcje opublikowane w etapie 1
  nie mają wiersza (wersja niezmienna) i dostają nagranie w pierwszej nowej
  wersji. Odstępstwo od kart (które czekają na pierwszy zapis) jest celowe.
- **Odsłuch w edytorze:**
  - widoczny tylko wtedy, gdy zdania formularza są równe zapisanym po tej samej
    normalizacji białych znaków co `storyReadText`. Zmiana samych pytań nie
    zmienia nagrania, więc nie ukrywa odsłuchu;
  - ukryty, gdy run historyjki czeka albo trwa, bo jego wynik za chwilę przepnie
    nagranie;
  - „Nagraj ponownie” zablokowane przy `busy || isDirty || conflict`.
- **Nieudane nagranie w wersji opublikowanej** pokazuje wskazówkę „Utwórz nową
  wersję lekcji, aby nagrać ponownie.” zamiast ślepego komunikatu.
- **Ścieżka procedury:** `POST /lesson-drafts/{lessonDraftId}/story-audio/regenerate`,
  wejście `{ lessonDraftId }`, wynik `{ assetId }`, status 202.
- **Kosz integracyjny:** nowy plik trafia do kosza 2 `tests/integration-buckets.ts`
  (tam jest `lesson-story.test.ts`). Kosze są zrównoważone (LPT), a świeżego
  pomiaru nie ma; po przebiegu CI można je przeliczyć.

### Usługi w teście integracyjnym (wspólne dla Task 1 i 2)

Plik `tests/integration/lesson-story-audio.test.ts` ma jeden helper
`grammarServices(fakes, options?)`:
- `createServices({ db, clock, media: fakes.settings, generation: fakes.deps, subjects? })`,
  wzorem `lessonServices` z `tests/integration/lesson-story.test.ts:39-45`;
- `media` i `generation` muszą mieć tego samego providera i model TTS, bo
  inaczej `isForeignTts` pominie zasoby;
- run historyjki uruchamia się przez `executeLessonGeneration(services, storyRunId)`,
  jak w `lesson-story.test.ts`;
- worker mediów: pętla `runDueGenerationWork(services, { lesson: 0, deck: 0, tts: 50, images: 0 })`
  aż `processed === 0`, jak w `grammar-without-tts.test.ts`.

Do testów stylu: wariant ustawień z `instructions: { "en-GB": EN_LANGUAGE_INSTRUCTION, "pl-PL": PL_LANGUAGE_INSTRUCTION }`
i stylem `instructions` (wzór `styledMedia()` z `school-lesson-audio-helpers.ts`,
z providerem i modelem `fakes.settings`).

## Review Focus

1. **Zdania zmienione, zanim worker nagrał poprzednie.**
   - Stary zasób `pending` traci odwołania.
   - Worker oznacza go jako `failed`, a run jako `superseded`.
   - Powrót do pierwotnych zdań nie pokazuje porażki: odczyt pomija zasoby
     anulowane (`notCancelled`).

   Test: Task 2.
2. **Zmiana tylko pytań nie zleca nowego nagrania** (ten sam fingerprint
   i asset). Test: Task 1.
3. **Usunięcie historyjki** (`story: null`):
   - kasuje wiersz;
   - DTO nie ma wtedy `storyAudio`;
   - odpytywanie się kończy.

   Test: Task 1 (wiersz), Task 2 (DTO), Task 3 (poll).
4. **Nieudane nagranie przy publikacji** jest zlecane ponownie (nowa generacja
   `pending`), a publikacja na nie nie czeka. Test: Task 1.
5. **Przedmiot bez `lessonStory`:**
   - nagranie, do którego odwołuje się tylko taki przedmiot, worker anuluje bez
     wołania providera;
   - nagranie o tym samym fingerprincie, do którego odwołuje się też wersja
     z włączoną flagą, zostaje aktywne.

   Test: Task 2.

---

### Task 1: Tabela `lesson_story_assets`, uzgadnianie i kopia wersji

**Files:**
- Create: `packages/server/drizzle/0034_lesson_story_assets.sql`
- Modify: `packages/server/drizzle/meta/_journal.json` (wpis `idx: 34`, `tag: "0034_lesson_story_assets"`, `when` większe od wpisu 33, `breakpoints: true`)
- Modify: `packages/server/src/db/schema.ts` (obok `lessonCardAssets`)
- Modify: `packages/server/src/modules/materials/media-reconciliation.ts`
- Modify: `packages/server/src/modules/materials/lessons/lesson-story-generation.ts` (finalizacja)
- Modify: `packages/server/src/modules/materials/lessons/lesson-api.ts` (`createLessonDraftFromPublished`)
- Modify: `tests/integration/school-lesson-audio-helpers.ts` (`truncateLessonAudioTables` czyści też nową tabelę)
- Test: `packages/server/src/modules/materials/media-reconciliation.test.ts`
- Create test: `tests/integration/lesson-story-audio.test.ts` (+ wpis w koszu 2 `tests/integration-buckets.ts`)

**Interfaces:**
- Consumes: `storyReadText(story: LessonStory): string`, `LessonStory`
  (`domain/lessons/story.ts`); `SubjectModule.lessonStory?: boolean`,
  `SubjectModule.answerLocale` (`domain/lessons/types.ts`).
- Produces:
  - Drizzle `lessonStoryAssets` z kolumnami:
    - `deckVersionId` (FK `deck_versions.id`; PK przez
      `primaryKey({ name: "lesson_story_assets_pk", columns: [t.deckVersionId] })`);
    - `assetId: uuid | null` (FK `media_assets.id`);
    - `expectedFingerprint: text not null`.
  - `export function requiredAssetForLessonStory(story: LessonStory | undefined, subject: Pick<SubjectModule, "lessonStory" | "answerLocale"> | undefined, settings: MediaSettings): RequiredAsset | null`
    (`media-reconciliation.ts`).
  - `export async function reconcileLessonStoryAssetTx(tx: Tx, services: Services, version: { id: string; state: string }): Promise<void>`:
    - no-op bez `services.media`;
    - `immutable` dla wersji opublikowanej.

- [ ] **Step 1: Unit testy `requiredAssetForLessonStory`** w `media-reconciliation.test.ts`:
  - przedmiot `{ lessonStory: true, answerLocale: "en-GB" }` i zdania
    `["Tom has a cat.", " It  is small. "]` dają:
    - `role: "feedback_audio"`;
    - `metadata.text === "Tom has a cat. It is small."`;
    - `metadata.locale === "en-GB"`;
  - ustawienia z instrukcjami per locale i stylem `instructions` dają
    `metadata.instructions === <instrukcja en-GB>`, bez zdania stylu pl-PL;
  - `null` dla:
    - `lessonStory: false`;
    - `undefined` subject;
    - `undefined` story;
    - zdań z samych białych znaków;
  - fingerprint:
    - historyjka z innymi pytaniami daje ten sam;
    - historyjka z innym zdaniem daje inny.
- [ ] **Step 2:** `pnpm vitest run packages/server/src/modules/materials/media-reconciliation.test.ts`. Oczekiwane: FAIL (brak eksportu).
- [ ] **Step 3: Migracja i schemat.** `0034_lesson_story_assets.sql` jest
  kopią `0028_lesson_card_assets.sql`, z separatorami `--> statement-breakpoint`
  i tymi elementami:
  - PK `lesson_story_assets_pk` na `deck_version_id`;
  - FK bez kaskady;
  - indeks `lesson_story_assets_asset_idx`;
  - funkcja `learning_app.guard_lesson_story_asset_change()`;
  - trigger `lesson_story_assets_immutable` na INSERT, UPDATE i DELETE,
    z komunikatem `'Published lesson story asset is immutable'`;
  - nagłówek po polsku: historyjka żyje w `lesson_context.story`.

  Drizzle `lessonStoryAssets` w `schema.ts` ma te same nazwy ograniczeń.
- [ ] **Step 4: Implementacja w `media-reconciliation.ts`.**
  - **`requiredAssetForLessonStory`:**
    - zwraca `ttsAsset("feedback_audio", storyReadText(story), subject.answerLocale, settings)`,
      gdy `subject?.lessonStory === true`, historyjka istnieje i tekst nie jest pusty;
    - w przeciwnym razie zwraca `null`;
    - styl się nie przekazuje.
  - **`reconcileLessonStoryAssetTx`:**
    - kończy bez zmian przy braku `lesson_context` (zestaw słówek), braku
      `subjectId` albo nieznanym przedmiocie, wzorem `reconcileLessonCardAssetsTx`.
      Wcześniej usuwa jednak ewentualny wiersz, bo wymaganego zasobu brak;
    - `story` z kontekstu uznaje za poprawne tylko wtedy, gdy `sentences` jest
      tablicą napisów (`every(typeof === "string")`);
    - gdy wymaganego zasobu brak, usuwa wiersz;
    - gdy wiersz ma ten sam fingerprint, a asset nie jest `failed`, zostawia go;
    - w pozostałych przypadkach wstawia lub aktualizuje wiersz przez
      `findOrCreateAsset`.
  - **Wywołanie w `reconcileDraftAssetsTx`:** zaraz po `reconcileLessonCardAssetsTx`,
    przed wczesnym `return` przy braku rewizji. `keepFailed` nie dotyczy
    historyjki.
- [ ] **Step 5: Finalizacja runu i kopia wersji.**
  - `lesson-story-generation.ts`: w tej samej transakcji, po zapisie
    `lesson_context.story`, wywołaj `reconcileLessonStoryAssetTx(tx, services, locked)`.
    Ścieżki porażki i `superseded` niczego nie uzgadniają.
  - `lesson-api.ts` `createLessonDraftFromPublished`: po `createVersionFromPublished`,
    w tej samej transakcji, `reconcileLessonStoryAssetTx(tx, services, { id: newVersionId, state: <stan nowej wersji> })`.
- [ ] **Step 6: Testy integracyjne** w `tests/integration/lesson-story-audio.test.ts`.
  Usługi opisuje sekcja „Usługi w teście integracyjnym”. Szkic z historyjką
  powstaje jak w `lesson-story.test.ts`.
  - `edit with a story creates one story recording in en-GB without speaking style`
    — sprawdza:
    - jeden wiersz;
    - `metadata.text === storyReadText`;
    - `locale en-GB`;
    - przy ustawieniach z instrukcjami: `metadata.instructions === EN_LANGUAGE_INSTRUCTION`.
  - `changing story sentences binds a new recording, changing only questions keeps it`.
  - `removing the story deletes its recording row`.
  - `successful story run binds the recording` — sprawdza:
    - `executeLessonGeneration` na runie historyjki;
    - wiersz istnieje;
    - zasób jest `pending`;
    - worker jeszcze nie ruszył.
  - `failed story recording is queued again on publish and publish does not wait for it`
    — oznacz zasób jako `failed` SQL-em, potem `publishLessonDraft`:
    - publikacja się udaje;
    - wiersz wskazuje nową generację `pending`.
  - `published version story recording row is immutable` — INSERT, UPDATE
    i DELETE przez `pool.query` są odrzucane komunikatem triggera.
  - `new version from published shows the shared recording at once`:
    - wiersz kopii istnieje bez edycji;
    - wskazuje ten sam gotowy zasób co wersja opublikowana (po
      `markTtsReady` albo workerze);
    - żaden nowy `generation_run` TTS nie powstał.
- [ ] **Step 7:** Uruchom:
  - `pnpm vitest run packages/server/src/modules/materials/media-reconciliation.test.ts`;
  - integrację:
    ```bash
    pnpm exec vitest run --config vitest.integration.config.ts tests/integration/lesson-story-audio.test.ts tests/integration/lesson-story.test.ts tests/integration/lesson-card-audio.test.ts tests/integration/lesson-parent-api.test.ts tests/integration/lesson-sentence-audio.test.ts tests/integration/publish-media-reconcile.test.ts tests/integration/media.test.ts tests/integration/lesson-generation.test.ts
    ```
    Nieistniejące nazwy plików pomiń: `ls tests/integration`.

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
  - procedura `lessonDrafts.regenerateStoryAudio`:
    - `POST /lesson-drafts/{lessonDraftId}/story-audio/regenerate`;
    - wejście `{ lessonDraftId: UuidSchema }` `.strict()`;
    - wynik `{ assetId: UuidSchema }`, status 202.

- [ ] **Step 1: Testy integracyjne** (dopisz do `lesson-story-audio.test.ts`):
  - `worker brings the story recording to ready and the draft dto shows it`
    (`draft.storyAudio = { state: "ready", assetId }`);
  - `story recording replaced before the worker ran is cancelled and never shown as failed`.
    Przebieg zdań A → B, potem worker:
    - stary zasób A jest `failed`, a jego run `superseded`;
    - `storyAudio` = gotowe B.

    Potem B → A:
    - `storyAudio.state === "pending"`;
    - nie ma `failed`;
    - `previousAssetId` nie wskazuje anulowanego zasobu.
  - `worker cancels a story recording referenced only by a subject without lessonStory`:
    - rejestr przedmiotów z kopią gramatyki z `lessonStory: false`;
    - wiersz wstawiony SQL-em;
    - zasób jest `failed`, a run `superseded`;
    - `fakes.tts.requests` jest puste.
  - `worker keeps a shared story recording when another version still has lessonStory`:
    - dwie wersje: jedna z przedmiotem z flagą, druga z przedmiotem bez flagi;
    - obie mają wiersz na ten sam zasób;
    - zasób dochodzi do `ready`, a provider jest wołany.

    Test pada bez nowego joinu w workerze.
  - `regenerate story audio enqueues the next generation and the dto shows pending with previous`
    (`{ state: "pending", previousAssetId }`).
  - `regenerate story audio twice while pending returns the same asset`.
  - `failed story recording shows failed with the previous ready take` — nowa
    generacja jest `failed` przez `addGeneration`, a DTO ma
    `{ state: "failed", previousAssetId }`.
  - `regenerate story audio rejects a published version (immutable) and a draft without story (not_found)`.
  - `draft without story has no storyAudio`.
- [ ] **Step 2:** Uruchom plik — FAIL.
- [ ] **Step 3: Worker.** W `supersedeDisabledLessonTts`:
  - dołącz odwołania z `lesson_story_assets` (join `deck_versions` po
    `deck_version_id`, tylko `lessonContext`) jako odwołania lekcji z pseudo-rolą
    `"story"`;
  - poszerz typ elementu tablicy odwołań do `AssetRole | "story"`;
  - dla `"story"` predykat „wyłączone” to `!subject.lessonStory`;
  - zaktualizuj komentarz funkcji.
- [ ] **Step 4: Odczyt i ponowne nagranie.**
  - `readLessonAudioStates`: jedno zapytanie po `lessonStoryAssets` join
    `mediaAssets` po fingerprint, `kind = 'tts'`, `notCancelled`, sortowanie
    `generationNumber desc`. Wynik daje `audioDto`.
  - `lesson-api.ts`: `...(audio.story ? { storyAudio: audio.story } : {})`.
  - `regenerateLessonStoryAudio`, wzorem `regenerateLessonCardAudio`:
    - schemat Zod `{ lessonDraftId: z.uuid() }`;
    - `assertMediaConfigured`, `lockDraft`;
    - `readRow` po `deckVersionId`;
    - `reconcileThenNextTx`;
    - gdy nie `rebound`, aktualizuje `assetId` wiersza.
  - Eksport przez barrel `materials/index.ts` i `packages/server/src/index.ts`.
- [ ] **Step 5: Kontrakt i router.**
  - `storyAudio: LessonPromptAudioDtoSchema.optional()` w `LessonDraftDtoSchema`,
    z komentarzem PL.
  - Procedura w `orpc-contract.ts` obok `regenerateCardAudio`, z komentarzem
    „«Nagraj ponownie» historyjki”.
  - Handler w `parent-router.ts` i wpis w mapie routera.
  - `parent-router.test.ts`:
    - dodaj `regenerateLessonStoryAudio: vi.fn()` do `vi.mock("@learning/server")`
      i do listy importów;
    - testy:
      - `regenerateStoryAudio zleca ponowne nagranie historyjki i zwraca 202 {assetId}`;
      - `regenerateStoryAudio odrzuca nadmiarowe pole bez wołania przypadku użycia`;
    - wpis `/lesson-drafts/${lessonDraftId}/story-audio/regenerate` w tabeli
      żądań cross-origin (obok `card-audio`).
- [ ] **Step 6:** Uruchom:
  - integrację:
    ```bash
    pnpm exec vitest run --config vitest.integration.config.ts tests/integration/lesson-story-audio.test.ts tests/integration/lesson-card-audio.test.ts tests/integration/grammar-without-tts.test.ts tests/integration/lesson-parent-api.test.ts
    ```
  - testy jednostkowe:
    ```bash
    pnpm vitest run apps/web/src/orpc/parent-router.test.ts packages/server/src/modules/module-boundaries.architecture.test.ts packages/server/src/domain/lessons/architecture.test.ts
    ```
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
- Modify: `packages/contracts/src/messages.ts` (w `lessons.story`)
- Test: `apps/web/src/parent/lessons/lesson-story-form.test.ts`, `lesson-story-section.test.tsx`,
  `lesson-poll-interval.test.ts`, `prompt-audio-controls.test.tsx`
- Test E2E: `tests/e2e/parent-lesson-voice-tone.spec.ts` (`mocked`), `tests/e2e/lesson-parent.spec.ts` (`real`)

**Interfaces:**
- Consumes: `LessonDraftDto.storyAudio`, `orpc.lessonDrafts.regenerateStoryAudio` (Task 2).
- Produces:
  - `PromptAudioTarget` z wariantem `{ kind: "story" }`;
  - `LessonStorySection` z opcjonalnym propem `audio?: ReactNode`:
    - renderowany tylko przy niepustej historyjce;
    - poza `StoryFields` i `StoryPreview`, nad zdaniami;
    - w szkicu i w wersji opublikowanej;
  - `export function storySentencesUnchanged(saved: LessonStoryDto | undefined, form: LessonStoryDto | null | undefined): boolean`
    w `lesson-story-form.ts`:
    - `form === undefined` daje `true`;
    - `form === null` przy zapisanej historyjce daje `false`;
    - poza tym porównuje zdania po normalizacji `trim` + zwinięcie białych
      znaków do jednej spacji, jak `storyReadText`;
  - komunikaty `messages.lessons.story`:
    - `audioTarget: "historyjka na koniec sesji"`;
    - `publishedAudioFailed: "Utwórz nową wersję lekcji, aby nagrać ponownie."`;
    - `info` uzupełnione o odsłuch: „Na razie możesz ją przygotować, sprawdzić
      i odsłuchać tutaj.”.

- [ ] **Step 1: Testy jednostkowe (failing).**
  - `lesson-story-form.test.ts`, `storySentencesUnchanged`:
    - `true` dla `undefined` formularza;
    - `true` przy zmianie samego pytania;
    - `true` przy zmianie samych białych znaków w zdaniu;
    - `false` przy zmianie zdania;
    - `false` przy zmianie liczby zdań;
    - `false` dla `null` przy zapisanej historyjce.
  - `lesson-story-section.test.tsx`:
    - `renders the audio slot in editable and published views`;
    - `does not render the audio slot without a story`.
  - `prompt-audio-controls.test.tsx` (statyczny markup):
    - `story target renders listen with the story label`;
    - `failed story recording in a published view shows the new-version hint`
      (gdy hint renderuje komponent sekcji, test idzie do `lesson-story-section.test.tsx`).
  - `lesson-poll-interval.test.ts`:
    - helper wersji przyjmuje `storyAudio`;
    - przypadki:
      - `polls every 3 s while only the story recording is pending`;
      - `stops polling when the story recording is ready`;
      - `does not poll for a draft without storyAudio`.
- [ ] **Step 2:** `pnpm vitest run apps/web/src/parent/lessons` — FAIL.
- [ ] **Step 3: Implementacja.**
  - **`PromptAudioControls`:**
    - trzecia mutacja `regenerateStoryAudio`;
    - wybór mutacji i `reset` obejmują wszystkie trzy;
    - dla `story` wywołanie `mutate({ lessonDraftId })`;
    - komentarze `PromptAudioTarget` i komponentu mówią o pytaniu, karcie
      i historyjce.
  - **`lessonPollInterval`:** `visible?.storyAudio?.state === "pending"` wchodzi
    do gałęzi 3000 ms. Zaktualizuj komentarz.
  - **`LessonEditor`:**
    - `storyAudio` = `active?.storyAudio`;
    - w szkicu nagranie jest ukryte, gdy `!storySentencesUnchanged(draft?.story, storyForm)`
      albo gdy run historyjki czeka lub trwa;
    - `PromptAudioControls` w slocie `audio` sekcji z propsami:
      - `target={{ kind: "story" }}`;
      - `targetLabel={messages.lessons.story.audioTarget}`;
      - `testId="lesson-story-audio"`;
      - `canRegenerate={editable}`;
      - `locked={busy || isDirty || conflict}`;
      - `onPlay={playAsset}`;
    - w wersji opublikowanej przy `state === "failed"` obok kontrolek tekst
      `publishedAudioFailed` z `data-testid="lesson-story-audio-published-failed"`.
- [ ] **Step 4:** `pnpm vitest run apps/web/src/parent/lessons` — PASS.
- [ ] **Step 5: E2E `mocked`** w `tests/e2e/parent-lesson-voice-tone.spec.ts`.
  - Fixture szkicu dostaje `story` i `storyEnabled: true`.
  - Fixture dostaje `storyAudio: { state: "ready", assetId }`.
  - Route `POST …/story-audio/regenerate` wzorem `card-audio`.
  - Testy:
    - `story recording: regenerate posts only the draft id and shows pending with previous take`
      — po kliknięciu `lesson-story-audio-regenerate` treść żądania to
      `{}` / `{ lessonDraftId }` (sprawdź faktyczny kształt body jak dla
      karty), widać „Nagrywanie…” i `lesson-story-audio-listen-previous`;
    - `story recording: editing a sentence hides it, editing a question disables regenerate`;
    - `story recording controls fit a 375 px phone` — brak przepełnienia
      poziomego, przyciski ≥ 44 px wysokości (konwencja panelu rodzica; 48 px
      to reguła Kid UI).
- [ ] **Step 6: E2E `real`** w `tests/e2e/lesson-parent.spec.ts`, test
  `parent edits generated story and publishes`:
  - po `waitForGeneratedStory`: `lesson-story-audio-listen` widoczny
    (`timeout: 120_000`; fake TTS workera);
  - po zmianie zdania: `lesson-story-audio` ma liczbę 0;
  - po zapisie wraca (`lesson-story-audio` widoczny);
  - w wersji opublikowanej:
    - `lesson-story-audio-listen` widoczny (`timeout: 120_000`; publikacja nie
      czeka na nagranie, a widok odpytuje przy `pending`);
    - `lesson-story-audio-regenerate` ma liczbę 0.

  Uruchom:
  ```bash
  UMIEM_E2E_WEB_MODE=dev pnpm exec playwright test tests/e2e/lesson-parent.spec.ts tests/e2e/parent-lesson-voice-tone.spec.ts
  ```
  Oczekiwane: PASS.
- [ ] **Step 7: Commit** `Historyjka: odsłuch i „Nagraj ponownie” w edytorze`.

---

### Task 4: Dokumentacja i pełna weryfikacja etapu

**Files:**
- Modify: `docs/architecture.md`:
  - §19.13: akapit o `lesson_story_assets`;
  - tabela endpointów parent API: wiersz `story-audio/regenerate` obok
    `card-audio/regenerate`.
- Modify: `docs/superpowers/specs/2026-11-01-lesson-end-story-design.md`:
  - status: „etap 2 zaimplementowany”;
  - w §6.2a doprecyzowanie: finalizacja uzgadnia tylko nagranie historyjki,
    a kopia wersji od razu uzgadnia nagranie.
- Modify: `docs/superpowers/specs/2026-10-30-tts-voice-style-design.md` (nota: nagranie historyjki bez stylu, w en-GB)

- [ ] **Step 1: Dokumentacja.** Akapit w §19.13 obejmuje:
  - tabelę (migracja `0034`);
  - tekst `storyReadText` w `answerLocale` bez stylu;
  - uzgadnianie w edycji, publikacji, finalizacji runu i kopii wersji;
  - ponowne zlecenie nieudanego nagrania;
  - worker (`lessonStory`, wspólny fingerprint);
  - `storyAudio` w DTO;
  - procedurę `regenerateStoryAudio`;
  - brak odsłuchu u dziecka do etapu 3.
- [ ] **Step 2: MCP.** Uruchom:
  ```bash
  grep -rn "lessonDrafts\|LessonDraftDto\|storyAudio\|story-audio\|lesson-drafts" apps/web/src/integrations integrations/umiem-mcp
  ```
  Oczekiwane: brak trafień. Uzasadnienie trafia do PR.
- [ ] **Step 3: Pełna weryfikacja.** Uruchom:
  - `pnpm typecheck`;
  - `pnpm test:unit`;
  - `pnpm test:integration`;
  - `pnpm build`;
  - `pnpm test:e2e:shards`.

  Oczekiwane: wszystko PASS (poza znanymi pominięciami zrzutów).
- [ ] **Step 4: Commit** `Historyjka etap 2: dokumentacja`.
