# Ton wypowiedzi w nagraniach TTS — projekt

Status: **zaakceptowany w rozmowie przez właściciela 2026-10-30** (etapy A i B),
po przeglądzie trzech krytyków (architektura, kontrakty, provider/awarie);
spec do przeglądu właściciela.

Zależność: etap 1 — PR #188 (`claude/english-word-audio-generation-c5689e`):
TTS `google/gemini-3.8-flash-tts`, głos `Kore`, przez OpenRouter, WAV, oraz
instrukcja wymowy per locale z env `UMIEM_TTS_INSTRUCTIONS_<LANG>_<REGION>`
(`ttsInstructionsFor` w `config.ts`, opcjonalne `instructions` w
`TtsFingerprintInput`, metadanych zasobu, porcie, adapterze i executorze).
Implementacja startuje po scaleniu PR #188 do `main`; ten spec opiera się na
jego kodzie.

## 1. Cel i decyzje

Lektor ma brzmieć cieplej i żywiej dla dziecka tam, gdzie nie szkodzi to
nauce wymowy. Pomiar 2026-10-30: Gemini 3.8 Flash TTS (Kore) wykonuje
instrukcje stylu (radośnie, łagodnie, z ciekawością, szeptem) i nie odczytuje
ich na głos; szept jest o ok. 6 dB cichszy.

Decyzje właściciela:

1. **Dwa etapy, osobne PR.** A — stały styl według roli nagrania. B — ton per
   ćwiczenie i per karta lekcji oraz odsłuch i ponowne nagranie w panelu.
2. **Zakres A:** stałe komunikaty Kid UI (`messages.uiAudio`), „Posłuchaj
   pytania” i „Posłuchaj karty” w lekcjach. **Słówka i zdania przykładowe
   zestawów angielskich zostają neutralne**; odsłuch słówka po próbie mowy
   (`feedback-audio.ts`) to to samo nagranie słówka — też neutralne.
3. **Zakres B:** generator LLM wybiera ton z zamkniętej listy dla ćwiczeń
   i kart (w tym kart-ciekawostek „Czy wiesz, że…”, które wynikają
   z materiału); rodzic widzi ton w edytorze i może go zmienić. Brak tonu =
   styl roli z etapu A.
4. **Lista tonów B:** `cheerful` (radośnie), `curious` (z ciekawością),
   `gentle` (łagodnie), `mysterious` (tajemniczo, szept pierwszego zdania).
5. **Szept tylko w kartach i tylko przy ≥ 2 zdaniach** tekstu nagrania; przy
   jednym zdaniu, a w pytaniu zawsze, serwer używa `curious` (§4.3; pytania
   bez szeptu — decyzja właściciela 2026-10-31).
6. **Ponowne nagranie:** polecenie serwisowe dla komunikatów Kid UI (etap A)
   oraz odsłuch i przycisk „Nagraj ponownie” dla pytań i kart w edytorze
   lekcji (etap B).
7. **Niezależność od providera:** domena, dane, kontrakty i UI znają tylko
   semantyczny klucz stylu. Tekst instrukcji stylu żyje w profilu stylu przy
   adapterze, włączanym jawnie env `UMIEM_TTS_STYLE` (§2.2).
8. Ton nie jest znacznikiem w tekście — tekst nagrania pozostaje identyczny
   z tekstem na ekranie.

## 2. Architektura (wspólna)

### 2.1. Semantyczny styl — domena

Nowy plik `packages/server/src/domain/tts-style.ts` (czysty):

```ts
export type TtsRoleStyle =
  | "ui_praise" | "ui_gentle" | "ui_guidance" | "ui_closing"
  | "lesson_question" | "lesson_card";
export type TtsStyle = TtsRoleStyle | LessonVoiceTone; // LessonVoiceTone — etap B (§4.1)

/** Ton nagrania lekcji z regułą szeptu (§4.3). */
export function lessonPromptStyle(role: "lesson_question" | "lesson_card",
  tone: LessonVoiceTone | undefined, text: string): TtsStyle;
```

Słówka nie mają stylu. W etapie A `TtsStyle` = `TtsRoleStyle`.

### 2.2. Profil stylu — przy adapterze

Nowy plik `packages/server/src/providers/tts-style-profile.ts`, czysta funkcja:

```ts
ttsRequestInstructions(tts: MediaSettings["tts"], locale: string, style?: TtsStyle): string | undefined
```

- `MediaSettings.tts.style: "instructions" | "none"` z env
  `UMIEM_TTS_STYLE` (domyślnie `none`; nieznana wartość = błąd startu, jak
  `UMIEM_TTS_FORMAT`). Wdrożenie Gemini ustawia `instructions`.
  `.env.example` i `docs/provider-config.md` dostają wpis.
- **Niezmiennik zgodności z etapem 1:** gdy `style` jest nieobecny, locale ≠
  `pl-PL` albo `tts.style === "none"`, wynik to **dokładnie**
  `ttsInstructionsFor(tts, locale)`. Słówka i dowolne nagranie bez stylu mają
  więc fingerprint identyczny jak po etapie 1 (brak nowych nagrań słówek,
  publikacja zestawów nie czeka na audio).
- Gdy styl obowiązuje: `[ttsInstructionsFor(tts, locale), zdanieStylu]`
  bez pustych elementów, złączone jedną spacją. Funkcja nigdy nie zwraca `""`
  (pusty wynik → `undefined`).
- Zdania stylu tylko dla `pl-PL` (§3.2, §4.3); każde ≤ 120 znaków (test).
- `UMIEM_TTS_STYLE=none` działa jak wyłącznik awaryjny: fingerprinty wracają
  do wartości etapu 1, więc odsłuch komunikatów Kid UI od razu używa starych
  gotowych nagrań. Nagrania pytań i kart już opublikowanych lekcji zachowują
  stylowy oczekiwany fingerprint do następnej edycji lub publikacji lekcji.
- Moduły `materials/` importują profil bezpośrednio (precedens:
  `providers/audio/normalize`, `providers/audio/mp3-duration`; test granic
  sprawdza kierunki między obszarami i czystość `domain/`).

### 2.3. Fingerprint, metadane, wykonanie

Bez nowych pól: wynik `ttsRequestInstructions` trafia do istniejącego
`instructions` z etapu 1 — w `ttsFingerprint`, metadanych zasobu i żądaniu
executora (który bierze `instructions` z rekordu zasobu, więc zmiana env
między planowaniem a wykonaniem nie zmienia żądania). Klucz stylu **nie**
trafia do metadanych (zasób jest współdzielony po fingerprincie).
`isUiAudioAssetMetadata` pozostaje bez zmian — odczyt i zlecanie filtrują po
fingerprincie, a funkcja jest też wyjątkiem w `supersedeDisabledLessonTts`.

### 2.4. Ponowne nagranie — wspólna reguła

Ponowne nagranie = nowy wiersz `media_assets` z tym samym fingerprintem
i kolejnym `generationNumber` (wzorzec `regenerateRevisionAsset`). Odsłuch
komunikatów, pytań i kart wybiera najnowszą gotową generację danego
fingerprintu, więc:

- do gotowości nowego nagrania dziecko słyszy poprzednie (bez przerwy);
- nowe ujęcie obowiązuje we **wszystkich wersjach** współdzielących
  fingerprint, także opublikowanych. To świadoma decyzja: nagranie pytania
  i karty nie jest decyzją rodzica ani częścią zatwierdzonej treści (design
  szkoły §11.3), a celem jest naprawa złego ujęcia. Zadania już wydane
  zachowują swój `questionAudioAssetId`. Gotowe zasoby i ich bajty pozostają
  niezmienne.

## 3. Etap A — styl według roli

### 3.1. Mapowanie komunikatów Kid UI

Mapa `UI_AUDIO_STYLES: Record<UiAudioKey, TtsRoleStyle>` w
`domain/ui-audio-catalog.ts` (`satisfies`; nowy klucz bez stylu nie przejdzie
typecheck). Klient jej nie potrzebuje — nie trafia do kontraktów.

| Styl | Klucze (17 komunikatów) |
| --- | --- |
| `ui_praise` | `correct` |
| `ui_gentle` | `partial`, `incorrect`, `unevaluated`, `skip`, `dont_remember`, `retry`, `mic_unavailable`, `audio_unavailable` |
| `ui_guidance` | `profile_select`, `deck_select`, `exposure`, `listening`, `speech`, `recall` |
| `ui_closing` | `end`, `summary` |

### 3.2. Zdania stylu ról (pl-PL)

Wstępne brzmienie; ostateczne po odsłuchu próbek (§3.6).

| Styl | Zdanie stylu |
| --- | --- |
| `ui_praise` | Powiedz radośnie, z uśmiechem w głosie, jak do ośmiolatka. |
| `ui_gentle` | Powiedz ciepło i spokojnie, bez rozczarowania w głosie. |
| `ui_guidance` | Powiedz przyjaźnie i zachęcająco, wyraźnie. |
| `ui_closing` | Powiedz ciepło i z zadowoleniem. |
| `lesson_question` | Przeczytaj przyjaźnie, spokojnym tempem i wyraźnie. |
| `lesson_card` | Przeczytaj jak ciepły nauczyciel, który opowiada, spokojnym tempem. |
| `lesson_explanation` | Wyjaśnij spokojnie i życzliwie jak cierpliwy nauczyciel; angielskie słowa wymów po angielsku. |

### 3.3. Miejsca zmian

- `config.ts` — `tts.style` z `UMIEM_TTS_STYLE`.
- `modules/materials/ui-audio.ts` — `requestOf` liczy `instructions` przez
  profil ze stylem klucza (zamiast samego `ttsInstructionsFor`).
- `modules/materials/media-reconciliation.ts` — `ttsAsset` przyjmuje
  opcjonalny styl; `prompt_audio` pytań → `lesson_question`, kart →
  `lesson_card`; `target_audio`/`example_audio` bez stylu.
- `providers/fake.ts` — `FakeTtsProvider` włącza `instructions` do
  generowanych bajtów (nagranie stylowane ≠ neutralne w testach).

### 3.4. Odczyt zapasowy komunikatów Kid UI

Dziś `readUiAudio` zwraca `ready: true` tylko przy komplecie nagrań
o bieżących fingerprintach, a bez tego każde dotknięcie odsłuchu w Kid UI
kończy się błędem (`session-controller.ts`). Każda zmiana konfiguracji TTS
(także ta) wyłącza więc odsłuch poleceń do czasu nagrania wszystkich 17
komunikatów; trwała awaria jednego komunikatu wyłącza go do restartu workera.

Zmiana: dla klucza bez gotowego nagrania o bieżącym fingerprincie
`readUiAudio` bierze najnowsze gotowe nagranie TTS, którego metadane
spełniają `isUiAudioAssetMetadata` z tym samym `uiAudioKey` i bieżącym
tekstem (np. neutralne sprzed etapu A). Komunikat to stała fraza interfejsu,
nie materiał nauki ani dowód — odtworzenie starszego ujęcia tej samej frazy
jest bezpieczne. Nagranie innego tekstu nigdy nie jest używane. Kontrakt
`UiAudioCatalogDto` bez zmian.

### 3.5. Polecenie ponownego nagrania komunikatu

`apps/worker/src/regenerate-ui-audio.ts` (wzór: `rebuild-progress.ts`)
i skrypt `pnpm media:regenerate-ui-audio <klucz…>` — dla wskazanych
`UiAudioKey` zleca nową generację wg §2.4 (bieżący fingerprint, nowy
`generationNumber`) w kolejce `media_assets`. Przypadek użycia
`regenerateUiAudio(services, keys)` w `materials/ui-audio.ts`, eksport przez
barrel. Bez endpointu i UI.

### 3.6. Próbki do odsłuchu

`scripts/sample-tts-styles.mts` (`pnpm eval:tts-styles -- --out <katalog>`):
z prawdziwym kluczem i bieżącą konfiguracją generuje do katalogu spoza repo
17 komunikatów, po jednym pytaniu i karcie w każdej roli, a w etapie B po
jednej próbce każdego tonu (dla `mysterious` pytanie — bez szeptu — i karta;
teksty w kształcie produkcyjnym: pytanie od polecenia, karta od tytułu).
Nic nie trafia do bazy. W opisie PR: lista odsłuchanych plików i decyzja
właściciela o brzmieniu.

### 3.7. Wdrożenie i koszt

- Fingerprinty 17 komunikatów się zmieniają; worker przy starcie
  (`prepareUiAudio`) zleca je od nowa. Dzięki §3.4 odsłuch działa w tym
  czasie na starych nagraniach. Web i worker wdrażane razem (fingerprint
  w `readUiAudio` liczy web, zlecenie — worker; worker liczy też fingerprinty
  przy uzgadnianiu szkiców lekcji po generowaniu — `generation.ts`,
  `lessons/lesson-drafts.ts`). Web i worker MUSZĄ mieć identyczne `UMIEM_TTS_STYLE`:
  inaczej fingerprinty przeskakują między generowaniem a edycjami rodzica
  (dodatkowe płatne nagrania), a niezgodność po stronie Kid UI jest niewidoczna
  przez odczyt zapasowy.
- Pierwsza edycja szkicu lekcji po wdrożeniu przelicza wszystkie rewizje
  (`reconcileDraftAssetsTx`), więc zleca nowe nagrania **wszystkich** pytań
  i kart tego szkicu, nie tylko edytowanego ćwiczenia. Bez generowania wstecz
  dla nieedytowanych lekcji.
- Oczekujące neutralne nagrania sprzed wdrożenia wykonają się normalnie
  (`isForeignTts` porównuje provider i model).
- Bez migracji, bez zmian Kid DTO i panelu rodzica.

## 4. Etap B — ton per ćwiczenie i karta, odsłuch w panelu

### 4.1. Kontrakty i typy

`packages/contracts/src/lessons.ts`:

- `LessonVoiceToneSchema = z.enum(["cheerful", "curious", "gentle", "mysterious"])`.
- Opcjonalne `voiceTone` w `LessonExerciseInputSchema` i w karcie
  `DynamicObjectiveDtoSchema.cards[]` (wspólne dla DTO szkicu i patcha
  tematu). **Nie** w `SubjectCatalogDtoSchema` ani w Kid DTO.
- Brak pola = styl roli z etapu A. Enum nie ma wartości `default`; stare
  payloady i tematy są poprawne bez migracji. Ton **nie wpływa** na
  `payload_version` (`lessonPayloadVersion` go nie liczy).
- Typy domeny: `LessonExerciseDraft`, `DynamicObjectiveData.cards[]`
  i `LearningObjective.cards[]` (`domain/lessons/types.ts`) dostają
  opcjonalne `voiceTone`.

### 4.2. Przepływ pola — wszystkie miejsca przepisujące obiekty

Ton musi przetrwać każdą drogę: generacja → walidacja → szkic → DTO rodzica →
patch → publikacja → rekonsyliacja. Miejsca, które dziś kopiują pola ręcznie:

| Obszar | Miejsca |
| --- | --- |
| Schemat generatora ćwiczeń | `providers/openai/lesson-pool-schema.ts` — gałąź ogólna i gałęzie `lesson_keywords`, `lesson_match`, `lesson_group`, `lesson_cloze`; bez `lesson_calculation` |
| Materializatory generatora | `providers/lesson-assignments.ts`, `lesson-keywords.ts` |
| Schemat i prompt zagadnień | `providers/openai/llm.ts` — `lessonObjectivesJsonSchema` (karta: pole w `required`), `lessonObjectivesSystemPrompt`, `lessonSystemPrompt` |
| Szkic serwera — ćwiczenia | `lesson-drafts.ts` `toExerciseDraft`/`v3FieldsOf`, `buildLessonPayload`; `lesson-api.ts` `exerciseDtoFromPayload` |
| Szkic serwera — karty | `lesson-drafts.ts` `rawObjectiveSchema`, `buildDynamicTopicData`; `lesson-api.ts` DTO szkicu i patch tematu; `subjects/school/module.ts` `buildDynamicTopic` (rekonsyliacja kart czyta `resolveLessonTopic(...).topic`) |
| Edytor rodzica | `lesson-editor-state.ts` `editableFromExercise`, `exerciseToInput`, `EditableDynamicObjective`, `lessonExerciseChanged`, `toLessonDraftPatch` |
| Fake | `providers/fake.ts` — generator lekcji zwraca przykładowe tony |

Schemat strict: `voiceTone: { type: ["null", "string"], enum: [null, …tony] }`
(wzorzec z `lesson-pool-schema.ts`); `null` → pole pominięte.

### 4.3. Generator, walidacja, reguła szeptu

- Reguła w promptach przedmiotu z `ttsForPrompts`: „voiceTone: choose only
  when it clearly fits; usually null. `mysterious` only for
  curiosities/riddles such as »Czy wiesz, że…« with at least two sentences;
  `cheerful` for fun facts or playful examples; `gentle` for sensitive or
  difficult content; `curious` for questions that invite the child to think.”
  Bez nowych kart ani faktów spoza materiału (reguła kart bez zmian).
- `LessonPoolInput` i wejście zagadnień dostają flagę `voiceTones: boolean`
  (= `ttsForPrompts` przedmiotu); bez niej schemat i prompt nie zawierają
  pola (gramatyka).
- **Sanityzacja wyniku LLM** w `toExerciseDraft` i `buildDynamicTopicData`,
  przed ścisłą walidacją: `LessonVoiceToneSchema.safeParse`; nieznana
  wartość → pole usunięte (dziś nieznany enum odrzuca całe ćwiczenie w
  `validateLessonExercise` — ton nie ma takiej wagi).
- Wejście rodzica: ścisły kontrakt (nieznany ton = błąd walidacji).
  `validateLessonExercise` odrzuca `voiceTone`, gdy przedmiot nie ma
  `ttsForPrompts` (wzór: `v3FieldsPresent`).
- **Reguła szeptu** (`lessonPromptStyle`, §2.1): `mysterious` dla tekstu
  nagrania z mniej niż dwoma zdaniami → `curious`. Zdanie = fragment
  zakończony `.`, `!`, `?` lub `…` (albo końcem tekstu) po normalizacji
  odstępów; polskie skróty („np.”, „tzw.”, „w.”, „p.n.e.” itd.) nie kończą
  zdania. W pytaniu `mysterious` → `curious` zawsze: czytany tekst pytania
  zaczyna się od polecenia, więc szept padłby na polecenie (decyzja właściciela
  2026-10-31). W karcie szept pada na pierwsze zdanie, czyli tytuł — decyzja
  właściciela: zostaje. Generator nie dostaje `mysterious` jako propozycji dla
  ćwiczeń; wybór rodzica „Tajemniczo” w pytaniu brzmi jak „Z ciekawością”.

Zdania stylu tonów (pl-PL, wyraźnie różne od stylu ról):

| Ton | Zdanie stylu |
| --- | --- |
| `cheerful` | Przeczytaj radośnie, z entuzjazmem i uśmiechem w głosie, wyraźnie. |
| `curious` | Przeczytaj z wyraźną ciekawością, pytająco, jakbyś zapraszał do zgadywania. |
| `gentle` | Przeczytaj bardzo łagodnie i wolniej, ciepłym, kojącym głosem. |
| `mysterious` | Pierwsze zdanie powiedz szeptem, jak sekret; resztę tajemniczo, ale wyraźnie i spokojnie. |

### 4.4. Rekonsyliacja i niezmienność

- Pytanie: styl = `lessonPromptStyle("lesson_question", payload.voiceTone, tekst)`.
- Karta: styl = `lessonPromptStyle("lesson_card", card.voiceTone, tekst)`.
- Zmiana tonu to edycja szkicu (aktualizacja rewizji szkicu / jego
  `lesson_context`) z uzgodnieniem nagrania w tej samej transakcji co dziś
  zmiana tekstu. Opublikowana wersja i gotowe nagranie pozostają nietknięte.
- **Ton nie wpływa na kryteria ani postęp:** nie wchodzi do
  `objectiveImpacted` ani `buildObjectiveCriteria`; zmiana samego tonu nie
  tworzy nowej `skill_version` i nie resetuje postępu (test).

### 4.5. Panel rodzica

- **„Ton lektora”** (Mantine `NativeSelect`: Domyślny / Radośnie / Z ciekawością /
  Łagodnie / Tajemniczo) w edytorze ćwiczenia (`LessonExerciseCard`) i karty
  zagadnienia. „Domyślny” usuwa pole. Widoczny dla przedmiotów z
  `ttsForPrompts` we wszystkich typach poza `lesson_calculation` i dla ich
  kart (przedmiot bez nagrań, np. „Angielski — rozdział”, nie ma pola, a serwer
  odrzuca ton karty jak ton ćwiczenia). „Tajemniczo” tylko przy karcie — w
  pytaniu, gdy ton jest już zapisany, pole go pokazuje, ale nagranie brzmi
  `curious`; opis pod polem: „Ton działa, gdy pytanie ma nagranie.”
  (karta: „Ton działa, gdy karta ma nagranie.” z regułą szeptu: „Tajemniczo”
  szepcze tekst od dwóch zdań, jedno zdanie brzmi „Z ciekawością”). Panel nie liczy
  `questionReadText`/`cardReadText` — to funkcje serwera.
- **Flaga w DTO szkicu (od 2026-11-01):** o widoczności pola decyduje
  `voiceTones?: { styleEnabled: boolean }` z serwera (obecne tylko dla
  przedmiotu z `ttsForPrompts`), nie porównanie `subjectId` w panelu.
  `styleEnabled = false` (`UMIEM_TTS_STYLE=none`): pole zostaje, a opis mówi,
  że wybór się zapisze, ale nowe nagrania brzmią domyślnie (gotowe zostają).
- **Nazwy dostępności:** „Posłuchaj”, „Nagraj ponownie” i „Posłuchaj
  poprzedniego” mają `aria-label` z widocznym tekstem i celem („Posłuchaj:
  Ćwiczenie 3”, „Nagraj ponownie: Skala mapy, karta 2 — Skala”), bo na stronie jest ich wiele.
- **Stan nagrań w DTO szkicu:** ćwiczenie dostaje opcjonalne
  `promptAudio?: { state: "pending" | "ready" | "failed", assetId?: uuid, previousAssetId?: uuid }`,
  a szkic opcjonalną listę `cardAudio: [{ objectiveId, cardIndex, audio }]`
  (`audio` ma ten sam kształt). To stan najnowszej generacji o oczekiwanym
  fingerprincie (`revision_assets.prompt_audio` / `lesson_card_assets`),
  `assetId` tylko dla gotowej; brak wpisu = brak nagrania dla tego tekstu.
  `previousAssetId` tylko przy `pending` i `failed`: najnowsza gotowa generacja
  tego samego fingerprintu, czyli ujęcie, które słyszy dziecko, dopóki nowe się
  nagrywa albo gdy nowe się nie udało — panel pokazuje wtedy „Posłuchaj
  poprzedniego”.
  Pola są tylko do odczytu i nie wracają w patchu edycji.
- **Odsłuch i „Nagraj ponownie”:** „Posłuchaj” odtwarza istniejącym
  `/api/v1/media/:id`. „Nagraj ponownie” (w każdym stanie, tylko w szkicu
  i bez niezapisanych zmian; przy `pending` bez zmiany konfiguracji zwraca
  trwające nagranie) woła procedury oRPC rodzica
  `lessonDrafts.regeneratePromptAudio({ lessonDraftId, itemRevisionId })`
  (POST `/lesson-drafts/{lessonDraftId}/prompt-audio/regenerate`) i
  `lessonDrafts.regenerateCardAudio({ lessonDraftId, objectiveId, cardIndex })`
  (POST `/lesson-drafts/{lessonDraftId}/card-audio/regenerate`); obie
  odpowiadają 202 z `{ assetId }`. Przypadki użycia w `materials/lessons/` wg §2.4,
  w transakcji z blokadą wersji; opublikowana wersja → `immutable`.
- **Zmiana konfiguracji TTS:** nowa generacja kopiuje żądanie (provider, model,
  metadane) najnowszego zasobu, a worker wykonuje tylko zlecenia zgodne ze swoim
  providerem i modelem (po zmianie samego głosu lub stylu wykona stare
  zlecenie — z jego, starą instrukcją). Dlatego procedury najpierw, w tej samej transakcji,
  uzgadniają media szkicu jak zapis (`reconcileDraftAssetsTx`). Gdy od
  ostatniego zapisu zmieniła się konfiguracja (provider, model, głos, styl),
  wiersz dostaje fingerprint bieżącej konfiguracji i jej nagranie (nowe zlecenie
  albo gotowe nagranie wspólne z inną wersją), a stan wiersza odpowiada temu
  zasobowi; kolejnej generacji nie zlecamy. Uzgodnienie obejmuje cały szkic, jak
  zapis (z `keepFailed`: nieudane odpowiedzi i ilustracje czekają na decyzję
  rodzica), więc przenosi do bieżącej konfiguracji wszystkie jego pytania i karty
  i zleca ponownie ich nieudane nagrania (płatne nagrania). Nowe ujęcie wspólnego
  fingerprintu słyszy też dziecko w każdej opublikowanej lekcji o tym samym
  tekście, tonie i konfiguracji — także w innym zestawie. Dlatego „Nagraj ponownie” jest też przy `pending`: zlecenie
  innego providera lub modelu worker pomija, a przycisk przenosi je do bieżącej
  konfiguracji. Rodzic nie musi niczego
  zapisywać (zapis czystego szkicu i tak nic nie wysyła). Brak ustawień
  mediów → `internal`.
- **Błąd „Nagraj ponownie”** znika, gdy zmieni się stan nagrania (zapis
  szkicu, odpytywanie), zamiast wisieć obok nowego stanu.
- **Odświeżanie:** dopóki jakieś nagranie pytania lub karty jest `pending`,
  edytor odpytuje lekcję (`lessonPollInterval`, co 3 s, gdy czekają tylko
  nagrania pytań i kart), więc „Nagrywanie…” znika samo,
  gdy nagranie będzie gotowe albo nieudane.
- **Świeża kopia opublikowanej lekcji** nie ma jeszcze wierszy nagrań kart:
  sterowanie kartami pojawia się dopiero po pierwszej zapisanej edycji
  szkicu (uzgodnienie mediów).
- Etykiety w katalogu komunikatów rodzica (`messages`), pl-PL.

## 5. Błędy i odporność

- Awaria TTS: zasób `failed`, brak przycisku odsłuchu u dziecka, publikacja
  nie czeka (design szkoły §11.2); w panelu stan `failed` z „Nagraj ponownie”.
- Odrzucenie `instructions` przez providera (4xx): błąd zasobu jak każda
  awaria, bez cichego ponowienia bez instrukcji (żądanie musi odpowiadać
  fingerprintowi). Systematyczne 4xx naprawia `UMIEM_TTS_STYLE=none`.
- Komunikaty Kid UI bez bieżącego nagrania: odczyt zapasowy (§3.4).
- Nieprawidłowy ton od LLM: usuwany (§4.3).

## 6. Prywatność, koszty, integracje

- Do usługi TTS trafia tekst materiału zatwierdzonego przez rodzica i stała
  instrukcja — bez danych dziecka.
- Koszt: instrukcja nie jest czytana (długość nagrania praktycznie bez zmian,
  Gemini ≈ $0,0002/s dźwięku), za to liczona jako krótkie wejście tekstowe.
  Jednorazowo 17 komunikatów; lekcje przy kolejnych edycjach (§3.7); ponowne
  nagrania tylko na żądanie.
- **API → MCP → skill: brak wpływu.** Jedyne narzędzie MCP to
  `umiem_get_learning_overview` — bez lekcji i mediów; eksportowany schemat
  w `integrations/umiem-mcp` nie obejmuje `lessons.ts`; nie ma narzędzi
  tworzenia materiału. `SKILL.md` bez zmian. Nowe procedury rodzica (§4.5)
  nie są udostępniane przez MCP.

## 7. Poza zakresem

- Ton słówek i zdań przykładowych angielskich; style dla innych locale niż
  pl-PL.
- Ustawienie tonu per dziecko; wyłączanie stylu przez rodzica (jest tylko
  wyłącznik operatora `UMIEM_TTS_STYLE`).
- Znaczniki w tekście, SSML i profile innych providerów (powstaną przy zmianie
  providera).
- Automatyczna ocena jakości ujęcia (np. strażnik czasu trwania).
- Wsteczne generowanie nagrań opublikowanych lekcji.

## 8. Testy

Etap A:
- Profil (jednostkowe): niezmiennik §2.2 (brak stylu / locale ≠ pl-PL /
  `none` = dokładnie `ttsInstructionsFor`); stały wynik złożenia dla każdej
  roli (snapshot tekstu); brak `""`; limit długości zdań.
- `config`: `UMIEM_TTS_STYLE` domyślnie `none`, nieznana wartość = błąd.
- Fingerprint: słówka bez zmian względem etapu 1; inne instrukcje = inny
  fingerprint.
- `ui-audio-catalog`: każdy `UiAudioKey` ma styl.
- Integracyjne: `prompt_audio` pytań i kart ze stylem roli,
  `target_audio`/`example_audio` bez; odczyt zapasowy §3.4 (stare nagranie
  tego samego tekstu użyte, innego tekstu — nie; bieżące ma pierwszeństwo);
  `regenerateUiAudio` tworzy kolejną generację, a odczyt bierze nowszą
  gotową; executor wysyła `instructions` z metadanych (fake rejestruje
  wejście). Fixture'y z policzonymi fingerprintami UI audio
  (`tests/fixtures/profile-navigation-world.ts`) zaktualizowane.

Etap B:
- Kontrakty: `voiceTone` opcjonalne; nieznany ton odrzucony w edycji rodzica;
  schematy strict generatora z nullable enum we wszystkich gałęziach poza
  `lesson_calculation`; bez pola przy `voiceTones: false`.
- Domena: sanityzacja nieznanego tonu; gramatyka odrzuca pole; reguła szeptu
  (1 zdanie → `curious`, 2 zdania → `mysterious`; pytanie zawsze `curious`).
- Edytor (jednostkowe stanu): round-trip DTO → forma → patch zachowuje
  `voiceTone` w ćwiczeniu i karcie; „Domyślny” usuwa pole; zmiana tonu
  wykrywana przez `lessonExerciseChanged`.
- Integracyjne: pełna ścieżka generacja (fake) → DTO → patch tonu →
  publikacja → fingerprint pytania i karty; zmiana tonu zachowuje stare
  gotowe zasoby i nie tworzy nowej `skill_version`; regeneracja pytania
  i karty w szkicu tworzy nową generację, w wersji opublikowanej →
  `immutable`; `promptAudio` w DTO szkicu odpowiada stanowi najnowszej
  generacji.
- Kid UI bez zmian geometrii — brak nowych testów layoutu. E2E panelu tylko,
  jeśli istniejący spec edytora lekcji obejmuje kartę ćwiczenia.

Nota (2026-10-31): nagranie zdania feedbacku gramatyki (`feedback_audio`, design `2026-10-30-lesson-sentence-readback-design.md`) powstaje bez stylu wypowiedzi (`voiceTone` nie dotyczy tej roli); en-GB dostaje tylko instrukcję wymowy języka.
