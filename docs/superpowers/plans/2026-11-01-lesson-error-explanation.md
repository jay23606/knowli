# Wyjaśnienie błędu dla dziecka w lekcjach — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Po błędnej odpowiedzi i po „Nie pamiętam” w lekcji angielskiego dziecko widzi zatwierdzone przez rodzica jedno polskie zdanie wyjaśniające regułę i może je odsłuchać (pl-PL).

**Architecture:** Pole `explanationPl` ćwiczenia powstaje w generatorze (za flagą przedmiotu `exerciseExplanations`), przechodzi walidację treści i edycję rodzica. `materials` planuje nagranie w nowej roli `explanation_audio`. `learning/lessons` zamraża tekst, nagranie i klucze ekspozycji cytatów w prywatnym kluczu zadania; czysta funkcja `withExerciseExplanation` dokleja je do feedbacku (`incorrect` / `lesson_hint`) w transakcji finalizacji próby, z ekspozycjami i jedną pieczęcią `audio_issued`. Kid UI pokazuje wyjaśnienie w osobnym wierszu doku z przyciskiem ręcznego odsłuchu.

**Tech Stack:** TypeScript strict, Zod (`packages/contracts`), Drizzle + PostgreSQL, Next.js + Mantine (panel rodzica), React (Kid UI), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-01-lesson-error-explanation-design.md`

## Global Constraints

- Flaga `SubjectModule.exerciseExplanations`: `english_grammar` i `english_chapter` = `true`, `school` i przedmiot testowy w `testing/` = `false`.
- `explanationPl`: zwykły tekst, po przycięciu niepusty, ≤ 120 znaków (`MAX_TEXT_LENGTH`), bez `\n`, `*`, `_`, dokładnie jedno zdanie wg `sentenceCount` (`domain/tts-style.ts`). Serwer przycina tekst przy zapisie (`toExerciseDraft`).
- Cytat odpowiedzi innego ćwiczenia nie jest błędem walidacji — daje ekspozycję (`explanationExposureKeys`, §4.4 specu).
- Pole nie wpływa na `exercise-identity.ts`, `target_key`, `objectiveImpacted`, `buildObjectiveCriteria` ani `lessonPayloadVersion`; nie jest polem v3.
- Generator: wyjaśnienie łamiące reguły treści albo flagę jest usuwane po cichu (ćwiczenie zostaje), liczba w logu przebiegu (`porzucone wyjaśnienia=N`); zapis rodzica: błąd walidacji 400.
- Rola zasobu: dokładnie `explanation_audio`, migracja o następnym wolnym numerze (po scaleniu #197, który zajął `0032`: `0033_explanation_audio_role.sql`) + ręczny wpis w `drizzle/meta/_journal.json`; locale `pl-PL`, styl `lesson_explanation` o zdaniu: „Wyjaśnij spokojnie i życzliwie jak cierpliwy nauczyciel; angielskie słowa wymów po angielsku.”
- Publikacja nie czeka na `explanation_audio`; rola nie trafia do list zasobów rodzica; worker ma jawną gałąź `explanation_audio → !exerciseExplanations`; `keepFailed` jej nie utrzymuje.
- Feedback z wyjaśnieniem tylko w treningu, przy wyniku oceny `incorrect`, rodzaju `incorrect`/`lesson_hint`, `revealsAnswer`, zakończonym zadaniu; przy `lesson_hint` szablon kategorii ma pierwszeństwo. `lesson_hint` bez tekstu po tym kroku → `{ kind: "incorrect", correctText }` (bez `answerSegments`, których kontrakt nie dopuszcza przy `incorrect`).
- `audio_issued` raz na próbę, gdy feedback ma `correctAudioAssetId` lub `explanationAudioAssetId`; zmiana tylko w lekcyjnym `sealFeedbackSentenceAudio`, nie w `sealPostAnswerAudio`.
- Kid UI: `messages.kid.listenExplanation` = „Posłuchaj wyjaśnienia”; wyjaśnienie w osobnym wierszu doku na całą szerokość pod górnym wierszem, przycisk ≥ 48 px na jego początku; bez autoodtwarzania wyjaśnienia; tokeny M3, bez surowych kontrolek i literałów koloru/rozmiaru.
- Panel rodzica: etykieta „Wyjaśnienie dla dziecka (po błędzie)”, `maxLength={120}` i licznik w opisie pola; puste/same spacje → `undefined`; pole tylko gdy szkic ma `exerciseExplanations: true`.
- Brak zmian w MCP i `SKILL.md` — potwierdzić wyszukaniem i opisać w PR.
- Polecenia przez `corepack pnpm …`; nie instaluj zależności, gdy `node_modules` istnieje. Pojedynczy plik integracyjny: `corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/<plik>`.

## Review Focus

1. **Polski homograf i zawieranie celów.** Wyjaśnienie „Przy he dodajemy -s do czasownika: he plays.” w lekcji z odpowiedziami „Do”, „he”, „plays”, gdzie własna odpowiedź to „he plays”. Oczekiwanie: własny tekst usunięty przed dopasowaniem (brak „he” i „plays”), „do” daje ekspozycję celu „Do” (akceptowany koszt), nic nie jest blokowane. Test w zadaniu 1.
2. **Rodzic czyści wyjaśnienie (pole puste lub same spacje).** Oczekiwanie: payload bez pola, brak wiersza `explanation_audio`, nowe zadania bez wyjaśnienia. Testy w zadaniach 3 i 4.
3. **Zadanie wydane przed edycją wyjaśnienia lub przed gotowym nagraniem.** Oczekiwanie: feedback ma tekst z klucza zadania (stary), bez audio, jeśli nagranie nie było gotowe przy wydaniu. Test w zadaniu 5.
4. **Ponowny odczyt i idempotentne powtórzenie próby** (druga przeglądarka). Oczekiwanie: to samo `hintPl`, `explanationAudioAssetId` i ekspozycje, bez drugiego `audio_issued`. Test w zadaniu 5.
5. **Telefon w poziomie 812×375 z lukami rozdziału** (długi `correctText`) + wyjaśnienie 120 znaków + dwa odsłuchy. Oczekiwanie: po przewinięciu treści doku wyjaśnienie i przycisk w całości w polu treści i w viewporcie, „Dalej” osiągalne, brak przepełnienia poziomego. Test w zadaniu 6.

---

### Task 1: Pole `explanationPl`, flaga przedmiotu i reguły domeny

**Files:**
- Create: `packages/server/src/domain/lessons/exercise-explanation.ts` + `exercise-explanation.test.ts`.
- Modify:
  - `packages/contracts/src/lessons.ts:336-393` (`explanationPl: text.optional()` z komentarzem; DTO szkicu dziedziczy);
  - `packages/server/src/domain/lessons/types.ts` (`LessonExerciseDraft.explanationPl?: string`; `SubjectModule.exerciseExplanations: boolean` z komentarzem obok `ttsForFeedbackSentence`);
  - `subjects/english-grammar/module.ts`, `subjects/english-chapter/module.ts` (`true`), `subjects/school/module.ts`, przedmiot testowy w `domain/lessons/testing/` (`false`);
  - `packages/server/src/domain/lessons/exposure-key.ts` (wydziel `exerciseExposureText`, użyj w `lessonExerciseTargetKey`);
  - `packages/server/src/domain/lessons/pool-validation.ts` (`validateLessonExercise`).
- Test: `exercise-explanation.test.ts`, `pool-validation.test.ts`, `exercise-identity.test.ts`, testy modułów przedmiotów (`english-chapter/module.test.ts:62` — literał flag), test kontraktu lekcji w `packages/contracts`.

**Interfaces:**
- Produces:
  - `explanationTextErrors(text: string): string[]` — komunikaty z prefiksem `explanationPl:`;
  - `exerciseExposureText(subject: Pick<SubjectModule, "exposureText">, draft: LessonExerciseDraft): string` — `subject.exposureText?.(draft) ?? draft.answer`;
  - `explanationExposureKeys(explanation: string, own: { exposureText: string; targetKey: string }, others: readonly { exposureText: string; targetKey: string }[], subject: Pick<SubjectModule, "normalizeExposureText">): string[]` — normalizacja obu stron: `normalizeExposureText` (gdy jest) + `normalizeTargetText`; z wyjaśnienia usuwane są wystąpienia własnego tekstu; dopasowanie na granicach słów (`(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])`, `u`); wynik bez duplikatów i bez `own.targetKey`, w kolejności `others`.

- [ ] **Step 1: Failing tests:**
  - `explanationTextErrors`: `"Przy he, she, it dodajemy -s: he plays."` → `[]`; `"  "`, 121 znaków, `"a\nb"`, `"*he*"`, `"he_plays"`, `"Dodajemy -s. Tak mówimy."` → po jednym błędzie; `"Np. he plays."` → `[]`.
  - `explanationExposureKeys`: Review Focus 1 (własne „he plays”, inne `["Do","he","plays"]`) → tylko klucz „Do”; `"…display…"` nie pasuje do „plays”; „She Plays” pasuje do „plays”; inny cel z tym samym kluczem co własny → pominięty; brak trafień → `[]`.
  - `validateLessonExercise`: wyjaśnienie przy przedmiocie z flagą `false` → błąd `explanationPl:`; poprawne w gramatyce → brak błędu; złe treściowo → błędy z `explanationTextErrors`.
  - `lessonExerciseIdentity` identyczne z wyjaśnieniem i bez; `lessonExerciseTargetKey` bez zmian dla istniejących przypadków.
  - Flagi przedmiotów: grammar `true`, chapter `true`, school `false`.
  - Kontrakt: `LessonExerciseInputSchema` przyjmuje `explanationPl`, odrzuca 121 znaków.
- [ ] **Step 2:** Run `corepack pnpm vitest run packages/server/src/domain/lessons packages/contracts` → FAIL.
- [ ] **Step 3:** Implement. Domena importuje tylko `domain/` i `@learning/contracts`.
- [ ] **Step 4:** Run step 2 + `corepack pnpm vitest run packages/server/src/modules/module-boundaries.architecture.test.ts` + `corepack pnpm typecheck` → PASS (uzupełnij `exerciseExplanations` w literałach `SubjectModule` w testach, które typecheck wskaże).
- [ ] **Step 5:** Commit `feat(lessons): pole explanationPl ćwiczenia i reguły wyjaśnienia (#196)`.

### Task 2: Generator i przepływ payloadu

**Files:**
- Modify:
  - `packages/server/src/ports/ai.ts:66-96` (`LessonPoolInput.exerciseExplanations?: boolean`);
  - `packages/server/src/providers/openai/lesson-pool-schema.ts` (`withExplanation` jak `withVoiceTone` `:16-22`: pole w `required`, typ `["string","null"]`; wszystkie gałęzie, także dedykowane `:115/151/166/184`);
  - `packages/server/src/providers/openai/llm.ts:305-325` (reguła i opis pola przy fladze, treść wg §3.3 specu);
  - `packages/server/src/providers/fake.ts` — obie gałęzie (`fakeLessonExercises` i `fakeChapterPool` `:252-254`): przy fladze stałe zdanie bez odpowiedzi, np. `"Ta reguła mówi, jak zbudować poprawne zdanie."`;
  - `packages/server/src/modules/materials/lessons/lesson-drafts.ts`: `buildPoolInput` (`:487-533`, flaga obok `:529`), `rawExerciseShapeSchema` (`:792-819`, `explanationPl: z.string().nullish()`), `toExerciseDraft` (`:895-981`, przycięty string → pole; `null`/pusty → brak), `buildLessonPayload` (`:984-1026`), nowa `withoutInvalidExplanation` w łańcuchu `:1380-1382` po `withoutVoiceToneUnlessAllowed` + log obok `:1439`;
  - `lesson-api.ts:149-195` (`exerciseDtoFromPayload`).
- Test: `lesson-pool-schema.test.ts:167-190`, `llm.test.ts:460-490`, `fake.test.ts`, `lesson-drafts.test.ts`; integracja: `tests/integration/lesson-generation.test.ts`, test nadzoru z akceptacją wariantu (`lesson-supervision` — istniejący plik integracyjny).

**Interfaces:**
- Consumes: `explanationTextErrors` (zadanie 1).
- Produces: `withoutInvalidExplanation(draft: LessonExerciseDraft, subject: Pick<SubjectModule, "exerciseExplanations">): LessonExerciseDraft`; payload rewizji i DTO szkicu niosą `explanationPl`.

- [ ] **Step 1: Failing unit tests:**
  - schemat przy `exerciseExplanations: true` ma `explanationPl` w `required` z typem `["string","null"]` w każdej gałęzi; bez flagi — brak pola;
  - prompt przy fladze zawiera fragmenty `explanationPl`, `jedno zdanie`, `dlaczego poprawna odpowiedź`, `120`; bez flagi nie zawiera `explanationPl`;
  - fake provider przy fladze: każde ćwiczenie (także rozdziału) ma wyjaśnienie spełniające `explanationTextErrors` = `[]`;
  - `withoutInvalidExplanation`: dwa zdania → pole usunięte, reszta bez zmian; przedmiot bez flagi → usunięte; poprawne → bez zmian;
  - `toExerciseDraft` z `null` → brak pola, z `"  Tekst.  "` → `"Tekst."`; `buildLessonPayload` przenosi pole.
- [ ] **Step 2:** Run te pliki (`corepack pnpm vitest run <pliki>`) → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4: Failing integration tests:** generacja gramatyki fake providerem → rewizje mają `explanationPl`; szkoła — nie; wyjście modelu ze złym wyjaśnieniem (stub `llm.generateLessonPool`, wzór w `lesson-generation.test.ts`) → ćwiczenie zapisane bez wyjaśnienia; akceptacja wariantu w nadzorze (`lesson-supervision.ts:587-601`) zachowuje `explanationPl`; `getLessonDraft` zwraca `explanationPl`.
- [ ] **Step 5:** Run (polecenie z Global Constraints) → FAIL, implement → PASS.
- [ ] **Step 6:** Commit `feat(lessons): generator i payload niosą wyjaśnienie ćwiczenia`.

### Task 3: Nagranie `explanation_audio` i API rodzica

**Files:**
- Create: `packages/server/drizzle/<NNNN>_explanation_audio_role.sql` (następny wolny numer, wzorem `0029_feedback_audio_role.sql`), wpis w `drizzle/meta/_journal.json`.
- Modify:
  - `packages/server/src/db/schema.ts:404,410` (rola w typie i CHECK); `docs/schema.sql:180-189` (CHECK z wszystkimi rolami, w tym `prompt_audio`, `feedback_audio`, `explanation_audio`);
  - `packages/server/src/domain/tts-style.ts` (`TtsRoleStyle` + `"lesson_explanation"`), `providers/tts-style-profile.ts` (zdanie z Global Constraints);
  - `packages/server/src/modules/materials/media-reconciliation.ts` (`AssetRole` `:28`, `LessonTtsFlags` `:88-92` i wypełnianie `:364-378`, `requiredAssetsForLessonExercise` `:135-157`, `keepFailed` `:425`);
  - `packages/server/src/modules/materials/media-generation.ts:94-96` (jawna gałąź);
  - `lesson-api.ts:263-268,286,308` (`explanationAudio` w DTO ćwiczenia, `exerciseExplanations?: true` w DTO szkicu obok `voiceTones`, pominięcie roli w liście) i `decks.ts:162` (pominięcie w liście);
  - `lesson-prompt-audio.ts` (`readLessonAudioStates` `:55-90` także dla roli; `PromptAudioInputSchema` `:151` + `role`; `regenerateLessonPromptAudio` `:199-227` używa `valid.role` w obu zapytaniach);
  - `packages/contracts/src/lessons.ts:410-414,462` (`explanationAudio: LessonPromptAudioDtoSchema.optional()`; `exerciseExplanations: z.literal(true).optional()` w DTO szkicu);
  - eksporty `materials/index.ts`, `server/src/index.ts`, jeśli typ wejścia jest eksportowany.
- Test: `media-reconciliation.test.ts` (literały flag), `tts-style-profile.test.ts:55`, `parent-router.test.ts` tylko jeśli zmienia się wywołanie; integracja: `publish-media-reconcile.test.ts`, `lesson-schema.test.ts`, `lesson-parent-api.test.ts`, nowy `tests/integration/lesson-error-explanation.test.ts` (dopisz do najlżejszego kosza `tests/integration-buckets.ts`); popraw `lesson-sentence-audio.test.ts:66-72` i `grammar-without-tts.test.ts:66,108-111` (rejestry z `{ ...englishGrammarSubject, … }` dostają `exerciseExplanations: false` albo filtr ról obejmuje `explanation_audio`).

**Interfaces:**
- Consumes: `explanationPl` w payloadzie (zadanie 2), flaga (zadanie 1).
- Produces:
  - `AssetRole` zawiera `"explanation_audio"`; `LessonTtsFlags { ttsForAnswers; ttsForPrompts; ttsForFeedbackSentence; exerciseExplanations: boolean }`;
  - `regenerateLessonPromptAudio(services, input: { lessonDraftId: string; itemRevisionId: string; role?: "prompt_audio" | "explanation_audio" })` — domyślnie `prompt_audio`; brak wiersza roli → `not_found`;
  - DTO ćwiczenia szkicu: `explanationAudio?: LessonPromptAudioDto`; DTO szkicu: `exerciseExplanations?: true`.

- [ ] **Step 1: Failing unit tests:**
  - gramatyka z `explanationPl` → `{ role: "explanation_audio", metadata.text, metadata.locale: "pl-PL" }`, instrukcje zawierają zdanie stylu przy `tts.style === "instructions"`; przy innym trybie — równe instrukcji języka pl-PL (styl poza fingerprintem);
  - flaga `false` albo brak pola → brak roli; zmiana tekstu → inny fingerprint; zmiana `voiceTone` nie zmienia fingerprintu wyjaśnienia;
  - nieudane `explanation_audio` nie jest utrzymywane przy `keepFailed`;
  - `STYLE_SENTENCES_PL.lesson_explanation` równe tekstowi z Global Constraints.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4: Failing integration tests** (`lesson-error-explanation.test.ts`, sekcja mediów):
  - publikacja gramatyki przy `pending` `explanation_audio` → sukces;
  - worker (`runDueGenerationWork(services, { lesson: 0, deck: 0, tts: 50, images: 0 })` w pętli, jak `lesson-sentence-audio.test.ts:99-102`) daje gotowe `explanation_audio` dla `english_grammar`; dla przedmiotu z flagą `false` oczekujące → zastąpione;
  - INSERT roli przechodzi przez CHECK;
  - lista zasobów szkicu (`lesson-api` i `decks`) bez `explanation_audio`; `getLessonDraft` zwraca `explanationAudio` i `exerciseExplanations: true` (szkoła — brak flagi);
  - `regenerateLessonPromptAudio({ …, role: "explanation_audio" })` → nowa generacja, wiersz `pending`; dla ćwiczenia bez wyjaśnienia → `not_found`; bez `role` → zachowanie `prompt_audio` bez zmian;
  - zapis szkicu z wyczyszczonym wyjaśnieniem → brak wiersza `explanation_audio` (Review Focus 2);
  - publikacja → `createLessonDraftFromPublished` → edycja samego wyjaśnienia → publikacja: ta sama `skill_version`, `lessonPayloadVersion` bez zmian, nowe `explanation_audio` zlecone;
  - przejście istniejących plików: `lesson-sentence-audio.test.ts`, `grammar-without-tts.test.ts`, `publish-media-reconcile.test.ts`.
- [ ] **Step 5:** Run → FAIL, implement → PASS; `corepack pnpm vitest run packages/server/src/modules/module-boundaries.architecture.test.ts` → PASS.
- [ ] **Step 6:** Commit `feat(media): nagranie wyjaśnienia ćwiczenia (rola explanation_audio)`.

### Task 4: Panel rodzica — pole, podgląd i nagranie

**Files:**
- Modify:
  - `apps/web/src/parent/**/lesson-editor-state.ts` (`:56-99,158-199,302-381`: pole w stanie; `exerciseToInput` przycina i mapuje puste na `undefined`);
  - `LessonExerciseCard.tsx`: `Textarea` z `maxLength={120}` i licznikiem `n/120` w `description`, poza blokiem v3 (wzór `:451-456`), tylko gdy `exerciseExplanations`; w zwiniętym podglądzie `pp-lesson-ex-preview` (`:194-197`) linia z wyjaśnieniem; drugi `PromptAudioControls` dla wyjaśnienia renderowany poza gałęzią `open`, jak `promptAudio` (`:184-190`), `testId="lesson-explanation-audio"`, etykieta „wyjaśnienia”; `sameCardProps` (`:83-90`) porównuje `explanationAudio`;
  - `PromptAudioControls.tsx` (prop `role`, przekazywany do mutacji);
  - `LessonEditor.tsx`: `lessonPollInterval` (`:74-77`) czeka też na `explanationAudio?.state === "pending"`; `explanationAudio` wyliczane jak `promptAudio` (`:723`), `audioLocked = explanationAudio !== null && isDirty`; przekazanie flagi szkicu do kart;
  - `apps/web/src/parent/orpc-contract.ts:166-169` (`role: z.enum(["prompt_audio","explanation_audio"]).optional()`, bez `.default()`), `apps/web/src/orpc/parent-router.ts:429-431` (przekazanie `role` tylko gdy podane);
  - `packages/contracts/src/messages.ts` (etykieta pola obok `commonErrorsLabel`, opis pomocniczy, etykieta nagrania).
- Test: `lesson-editor-state.test.ts:241-276`, `lesson-poll-interval.test.ts`, `prompt-audio-controls.test.tsx`, `parent-router.test.ts` (dotychczasowe wywołanie bez `role` bez zmian); E2E `mocked`: `parent-lesson-editor-layout.spec.ts`, `parent-lesson-voice-tone.spec.ts:136-141` (treść żądania).

**Interfaces:**
- Consumes: `explanationPl`, `explanationAudio`, `exerciseExplanations` z DTO szkicu i `role` regeneracji (zadania 2–3).

- [ ] **Step 1: Failing unit tests:** zmiana wyjaśnienia oznacza ćwiczenie jako zmienione; `"   "` → input bez pola; `lessonPollInterval` z `explanationAudio` `pending` → interwał; kontrolki z `role="explanation_audio"` wołają mutację z tą rolą i mają odrębną nazwę dostępności; router bez `role` woła usługę jak dziś.
- [ ] **Step 2:** Run `corepack pnpm vitest run apps/web/src/parent apps/web/src/orpc` (te pliki) → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS; `corepack pnpm vitest run tests/parent-mantine-scope.test.ts` → PASS.
- [ ] **Step 5: Failing E2E** (`parent-lesson-editor-layout.spec.ts`): szkic gramatyki — pole z etykietą, licznik `…/120`, kontrolki nagrania wyjaśnienia; szkic szkoły — brak pola; opublikowana lekcja (fixture `:332`) — zwinięty podgląd pokazuje tekst wyjaśnienia i odsłuch; geometria pola w 375×812 i 1280×800 bez przepełnienia poziomego. `parent-lesson-voice-tone.spec.ts`: „Nagraj ponownie” wyjaśnienia wysyła `role: "explanation_audio"`.
- [ ] **Step 6:** Run `UMIEM_E2E_WEB_MODE=dev corepack pnpm exec playwright test tests/e2e/parent-lesson-editor-layout.spec.ts tests/e2e/parent-lesson-voice-tone.spec.ts` → FAIL, potem PASS.
- [ ] **Step 7:** Commit `feat(parent): wyjaśnienie ćwiczenia w edytorze i podglądzie lekcji`.

### Task 5: Sesja — klucz zadania, reguła feedbacku i kontrakt Kid DTO

**Files:**
- Modify:
  - `packages/contracts/src/kid.ts:660-725` (`hintPl` dozwolone przy `incorrect`; `explanationAudioAssetId: UuidSchema.optional()` + refine: wymaga `hintPl`, tylko `incorrect`/`lesson_hint`, nie przy `not_assessed`; komentarze pól);
  - `lesson-materialize.ts:20-73` (`LessonExercisePayload.explanationPl?`, `LoadedExercise.explanationAudioAssetId?`, `explanationExposureKeys?`), `:207-222` (`baseKey`: `explanationPl`, `explanationAudioAssetId`, `explanationExposureKeys` tylko gdy `subject.exerciseExplanations && !mockTest && payload.explanationPl`);
  - `lesson-sessions.ts:256-343` (`loadExercises`: opcja `explanationAudio`, zapytanie jak `feedbackAudioRows`; dla każdego ćwiczenia z wyjaśnieniem `explanationExposureKeys` liczone z pozostałych załadowanych ćwiczeń — `exerciseExposureText` + `targetKey`); `:852` (przegląd talii) i `lesson-mock-tests.ts:61` z `explanationAudio: false`;
  - `lesson-attempts.ts`: `LessonTaskAnswerKey` (`:95-129`); `resultFromVerdict` `model_incorrect` (`:564-576`) bez zmian poza tym, że brak szablonu daje `lesson_hint` bez `hintPl` (naprawia go następny krok); nowa `withExerciseExplanation` obok `withFeedbackSentenceAudio` (`:992`), wołana przed nią w obu ścieżkach (`:1135/1148`, `:1616/1633`); `discloseLessonFeedback` (`:1013`) dokłada `key.explanationExposureKeys`, gdy `feedback.hintPl === key.explanationPl`; `sealFeedbackSentenceAudio` (`:1000`) z warunkiem dwóch pól.
- Test: `lesson-attempts.test.ts`, `lesson-materialize.test.ts`, test kontraktu kid (`packages/contracts`); integracja `lesson-error-explanation.test.ts` (sekcja sesji).

**Interfaces:**
- Consumes: payload `explanationPl` (zadanie 2), `explanation_audio` (zadanie 3), `explanationExposureKeys`, `exerciseExposureText` (zadanie 1).
- Produces:
  - `LessonTaskAnswerKey.explanationPl?: string`, `explanationAudioAssetId?: string`, `explanationExposureKeys?: string[]`;
  - `withExerciseExplanation(feedback: FeedbackDto | null, key: LessonTaskAnswerKey, outcome: ObjectiveGrade["outcome"], taskEnds: boolean): FeedbackDto | null` — czysta: (1) dokleja `hintPl` = wyjaśnienie i `explanationAudioAssetId` według warunków §4.2 specu; (2) zawsze na końcu: `lesson_hint` bez `hintPl` → `{ kind: "incorrect", correctText }` (inne pola, w tym `answerSegments`, usunięte);
  - `FeedbackDto.explanationAudioAssetId?: string`; `hintPl` przy `incorrect`.

- [ ] **Step 1: Failing unit tests:**
  - `withExerciseExplanation` — wiersze tabeli §4.2: `incorrect`+`correctText` → wyjaśnienie (+ audio, gdy klucz ma); `lesson_hint` z szablonem → bez zmian i bez audio; `lesson_hint` bez `hintPl` z `answerSegments` i kluczem z wyjaśnieniem → `lesson_hint` z wyjaśnieniem i segmentami; to samo bez wyjaśnienia → `incorrect` bez segmentów, przechodzi `FeedbackDtoSchema`; `lesson_almost`, `great`, `not_assessed`, `lesson_precision_hint`, `null` → bez zmian; `taskEnds=false` lub `outcome !== "incorrect"` → bez doklejenia; klucz bez wyjaśnienia → bez zmian;
  - materializacja: trening + flaga → klucz ma trzy pola, `JSON.stringify(prompt)` ich nie zawiera; kartkówka i flaga `false` → brak;
  - kontrakt: `incorrect` + `hintPl` przechodzi; `explanationAudioAssetId` bez `hintPl`, przy `great`, przy `not_assessed` → błąd; `lesson_hint` bez `hintPl` nadal błąd.
- [ ] **Step 2:** Run `corepack pnpm vitest run packages/server/src/modules/learning/lessons packages/contracts` → FAIL.
- [ ] **Step 3:** Implement. `taskEnds` = wyliczony już `taskState !== "issued"`; `outcome` = `result.grade.outcome`.
- [ ] **Step 4: Failing integration tests** (gramatyka; wyjaśnienie i nagranie `ready` przed wydaniem):
  - błędny wybór → `incorrect` z `hintPl`, `explanationAudioAssetId`, `correctAudioAssetId`; dokładnie jedno `audio_issued` (`occurredAt > receivedAt`); ocena `independent` jak bez wyjaśnienia;
  - „Nie pamiętam” → `incorrect` z wyjaśnieniem;
  - fake grader `model_incorrect` z kategorią → szablon kategorii; kategoria `other` → wyjaśnienie; nadpisanie rodzica bez kategorii i bez wyjaśnienia → `incorrect`;
  - brak wyjaśnienia: dobra odpowiedź, „prawie” (`minor_typo`), `not_assessed`, „Pomiń”, kartkówka;
  - wyjaśnienie cytujące odpowiedź innego ćwiczenia → ekspozycja tamtego celu zapisana przy feedbacku;
  - zadanie wydane przed gotowym nagraniem → wyjaśnienie bez audio; wydane przed edycją → stary tekst (Review Focus 3);
  - `readLessonAttempt` i idempotentne powtórzenie → ten sam feedback i ekspozycje, bez nowego `audio_issued` (Review Focus 4);
  - szkoła → bez wyjaśnień; regresja `lesson-sentence-audio.test.ts`, `lesson-chapter-sentence-audio.test.ts` i testu słówek `picture_recognition` przechodzi.
- [ ] **Step 5:** Run → FAIL, implement → PASS.
- [ ] **Step 6:** Commit `feat(lessons): feedback po błędzie niesie wyjaśnienie ćwiczenia i jego nagranie`.

### Task 6: Kid UI — wyjaśnienie i „Posłuchaj wyjaśnienia”

**Files:**
- Modify:
  - `packages/kid-ui/src/screens/ExerciseFeedbackDock.tsx` (+ `.module.css` przez tokeny): prop `explanation?: { text: string; onPlay?: () => void } | null` — osobny wiersz na całą szerokość pod górnym wierszem, wewnątrz przewijanego `.scroll`, `text-align: start`, `ListenButton` (`data-testid="kid-explanation-audio"`, `aria-label`/`title` = `messages.kid.listenExplanation`) na początku, tekst `data-testid="kid-explanation-text"`;
  - `LearnScreen.tsx:119-124,277-285`: `explanation` dla zadania lekcji, gdy `dto.kind === "incorrect" && dto.hintPl` albo `dto.explanationAudioAssetId`; `onPlay` tylko przy `explanationAudioAssetId`; `GuidanceButton icon="question"`, gdy `sentenceAudio ?? explanation?.onPlay`;
  - `lesson-feedback-view.ts`: `lesson_hint` z `explanationAudioAssetId` nie renderuje `hintPl` w treści (pokazuje go dok);
  - `session-controller.ts`: `playExplanationAudio()` obok `playSentenceAudio` (`:1290`); `#showResult` (`:1241`): wyjątek „Nie pamiętam” także gdy zadanie lekcji i `attempt.feedback?.hintPl !== undefined`;
  - `packages/contracts/src/messages.ts` (`kid.listenExplanation`).
- Test: `session-controller.test.ts`, `ExerciseFeedbackDock.test.tsx`, test `lesson-feedback-view`; E2E `mocked`: `lesson-sentence-audio.spec.ts`, `kid-feedback-dock.spec.ts`.

**Interfaces:**
- Consumes: `FeedbackDto.hintPl` przy `incorrect`, `explanationAudioAssetId` (zadanie 5).
- Produces: `controller.playExplanationAudio(): Promise<void>`; `ExerciseFeedbackDock` prop `explanation`.

- [ ] **Step 1: Failing unit tests:**
  - dok: `explanation` z `onPlay` → tekst i przycisk „Posłuchaj wyjaśnienia”, klik woła `onPlay`; bez `onPlay` → tekst bez przycisku; bez propsa → brak wiersza;
  - widok: `lesson_hint` z `explanationAudioAssetId` → brak `hintPl` w treści; bez niego → jak dziś; `incorrect` bez `hintPl` (słówka) → render jak dziś;
  - kontroler: wynik z `explanationAudioAssetId` nie gra go automatycznie, `correctAudioAssetId` gra raz; `playExplanationAudio` gra `mediaUrl(id)` i przerywa odczyt zdania; „Dalej” przerywa; odrzucone `play()` → bez stanu błędu; „Nie pamiętam” z `hintPl` bez nagrania zdania zostaje na wyniku.
- [ ] **Step 2:** Run `corepack pnpm vitest run packages/kid-ui` (te pliki) → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS; `corepack pnpm vitest run tests/kid-design-tokens.test.ts tests/kid-no-mantine.test.ts` → PASS.
- [ ] **Step 5: Failing E2E** (`installKidUiFixture`, spy `HTMLMediaElement.prototype.play`):
  - `lesson-sentence-audio.spec.ts`: błędny wybór z oboma nagraniami → wyjaśnienie widoczne, `play` raz z URL zdania; klik „Posłuchaj wyjaśnienia” → `play` z URL wyjaśnienia i `pause` zdania; „Nie pamiętam” → „Rozumiem” z `hintPl` i **bez** `correctAudioAssetId` → wynik zostaje do „Dalej”; `hintPl` bez audio → brak przycisku; samo nagranie wyjaśnienia → komunikat ma ikonę „?”;
  - geometria (375×812, 812×375, 768×1024, 1280×800): wyjaśnienie 120 znaków, szerokość tekstu ≥ 220 px w 375×812, przycisk ≥ 48×48 w viewporcie, „Dalej” osiągalne, brak przepełnienia poziomego; nowy przypadek w `CLOZE_FEEDBACKS` (`:272`) z `incorrect` + `hintPl` + `explanationAudioAssetId` — po przewinięciu treści do końca (wzór `:395-403`) tekst i przycisk w polu treści i w viewporcie (Review Focus 5);
  - `kid-feedback-dock.spec.ts`: kontrast tekstu wyjaśnienia na doku `incorrect` w obu motywach (wzór `titleContrastOnDock` `:268-283`); regresja `:37` — „Nie pamiętam” bez `hintPl` przechodzi dalej jak dziś.
- [ ] **Step 6:** Run `UMIEM_E2E_WEB_MODE=dev corepack pnpm exec playwright test tests/e2e/lesson-sentence-audio.spec.ts tests/e2e/kid-feedback-dock.spec.ts` → FAIL, potem PASS.
- [ ] **Step 7:** Commit `feat(kid-ui): wyjaśnienie błędu i „Posłuchaj wyjaśnienia” w feedbacku lekcji`.

### Task 7: Przebieg `real`, dokumentacja i bramki

**Files:**
- Modify:
  - `tests/e2e/lesson-real-flow.spec.ts:345-350` (istniejąca pętla błędnych wyborów): asercja `wrongAttempt.feedback.hintPl` i widocznego `kid-explanation-text`;
  - `docs/architecture.md` §19 (feedback lekcji: `hintPl` przy `incorrect`, `explanationAudioAssetId`, kolejność szablon → wyjaśnienie, ekspozycje cytatów) i §22 (rola `explanation_audio`);
  - `docs/SPEC.md` §22/§37, nowe kryterium akceptacji w §32, nota przy A58;
  - `.kiro/specs/grammar-module/requirements.md` (nowe wymaganie o wyjaśnieniu);
  - `docs/superpowers/specs/2026-10-30-lesson-sentence-readback-design.md` §11 (punkt 5 zrealizowany), `docs/superpowers/specs/2026-10-30-tts-voice-style-design.md` (rola stylu `lesson_explanation`).

- [ ] **Step 1:** Dopisz asercje; run `corepack pnpm exec playwright test tests/e2e/lesson-real-flow.spec.ts --project=real` → PASS.
- [ ] **Step 2:** Zaktualizuj dokumentację. Wyszukaj `FeedbackDto|explanation|LessonExerciseInput|hintPl` w `apps/web/src/integrations` i `integrations/` — oczekiwanie: brak trafień dotyczących lekcji; zapisz do opisu PR.
- [ ] **Step 3:** Scal `origin/main`, potem run i oczekuj PASS: `corepack pnpm typecheck`, `corepack pnpm test:unit`, `corepack pnpm test:integration`, `corepack pnpm build`, `corepack pnpm test:e2e:shards`.
- [ ] **Step 4:** Commit `docs(lessons): wyjaśnienie błędu — architektura, SPEC, wymagania gramatyki`.
