# Historyjka na koniec sesji lekcji gramatyki — design

Data: 2026-11-01. Wersja 2 po recenzji trzech niezależnych krytyków: architektura
i dane; reguły nauki i sesja; Kid UI, kontrakty i testy. Status: zatwierdzony
przez właściciela 2026-11-01; etap 1 zaimplementowany.
Issue: lookassh/knowli#195.

Powiązane dokumenty:
- `.kiro/specs/grammar-module/requirements.md` — wymagania 2.13, 5.4, 9, 10;
- `docs/SPEC.md` §22;
- `docs/architecture.md` §19;
- `docs/superpowers/specs/2026-10-30-lesson-sentence-readback-design.md` (#194):
  nagranie en-GB i ciche autoodtwarzanie;
- `docs/superpowers/specs/2026-10-30-tts-voice-style-design.md`.

## 1. Cel i ustalenia

Na koniec każdej sesji treningowej lekcji gramatyki angielskiej dziecko dostaje
krótką historyjkę:
- 4–6 zdań po angielsku (en-GB) w ćwiczonym czasie;
- odczyt lektora;
- potem 1–2 pytania sprawdzające zrozumienie.

Celem jest osłuchanie się z formą w spójnym kontekście, a nie sprawdzenie reguły.

Ustalenia z właścicielem (2026-11-01):

1. **Każda sesja.** Historyjka zamyka każdą sesję treningową lekcji, ale nie
   kartkówkę. Zawsze jest to ta sama historyjka wersji lekcji, bo ponowny
   odsłuch to cel.
2. **Pytania po polsku.** Pytania i odpowiedzi są po polsku: 3 opcje, sprawdzanie
   zrozumienia angielskiego tekstu.
3. **Ocena poza postępem.** Pytania są oceniane jak zadania zamknięte: od razu
   wynik i poprawna odpowiedź, zapis próby. Są poza budżetem ocenianych zadań,
   postępem reguł i cyklem wsparcia.
4. **Stare lekcje.** Mają przycisk **„Wygeneruj historyjkę”** w edytorze szkicu,
   także w nowej wersji opublikowanej lekcji.
5. **Obietnica budżetu.** Gdy sesja kończy się historyjką, baner mówi
   **„Jeszcze N i historyjka!”**. Historyjka wychodzi także po limicie czasu.
   Wyjątek od reguły „nie dokładaj zadań po obietnicy” trafia do AGENTS.md, SPEC
   i wymagania 5.4. Historyjka nie jest zadaniem budżetu, tylko zapowiedzianym
   zamknięciem.
6. **Etapy.** Trzy etapy, każdy kończy się PR do scalenia przez właściciela (§16).

## 2. Zakres

**W zakresie:**
- dane historyjki w wersji lekcji;
- osobny run generowania historyjki: automatycznie po generowaniu lekcji
  i ręcznie przyciskiem;
- walidacja, edycja i zatwierdzenie przez rodzica;
- nagranie TTS w workerze;
- dwa nowe rodzaje zadań sesji z widokami Kid UI;
- dokumentacja i testy.

**Poza zakresem:**
- historyjka w kartkówce;
- wiele historyjek i rotacja;
- historyjka w innych przedmiotach. Mechanizm jest generyczny i sterowany flagą,
  ale flagę ma tylko `english_grammar`;
- ton lektora historyjki. Style działają dla `pl-PL`; nagranie dostaje instrukcję
  wymowy en-GB jak `feedback_audio`;
- raport rodzica z wynikami pytań. Próby są zapisane, ale nie ma widoku;
- wolniejsze odtwarzanie i podświetlanie zdań.

## 3. Rozważone podejścia

**A. Historyjka w `lesson_context` wersji, zadania sesji kotwiczone jak karty.
To podejście wybieramy.**
- Historyjka jest danymi wersji, jak `examples` kart: zatwierdzana i niezmienna
  razem z wersją, kopiowana do nowego szkicu.
- Nagranie ma własną tabelę, wzorem `lesson_card_assets`.
- `session_tasks.item_revision_id` jest `NOT NULL` z FK, więc zadania kotwiczą
  w rewizji ćwiczenia, jak karty.
- Brak wierszy `assessments` chroni nadzór, przebudowę postępu
  i `historicalSupportObjectives`. Pozostałe koszty kotwicy usuwa §8.5.

**B. Historyjka jako element puli** (`learning_item` z rewizją). Odrzucone.
Historyjka nie ma celu, a wyjątki musiałyby wejść do:
- walidacji puli;
- pokrycia publikacji;
- selektora;
- tożsamości ćwiczeń;
- edytora grupującego po regułach;
- kartkówki.

**C. Historyjka i pytania tylko w podsumowaniu, sprawdzane w kliencie.**
Odrzucone: klucz odpowiedzi trafiłby do Kid DTO, a sesja nie miałaby ani prób,
ani ekspozycji.

## 4. Model danych i walidacja (domena)

Nowy plik `packages/server/src/domain/lessons/story.ts` z czystymi funkcjami.
Nie importuje bazy, SDK ani zegara.

```ts
interface LessonStory {
  readonly sentences: readonly string[];               // 4–6, answerLocale przedmiotu
  readonly questions: readonly LessonStoryQuestion[];  // 1–2
}
interface LessonStoryQuestion {
  readonly id: string;                                 // stabilny w wersji ("q1")
  readonly question: string;                           // promptLocale (pl-PL)
  readonly options: readonly { readonly id: string; readonly text: string }[]; // dokładnie 3
  readonly correctOption: string;                      // id jednej z opcji
}
```

Identyfikatory opcji w danych wersji służą tylko rodzicowi. Dziecko dostaje
identyfikatory nadane przy wydaniu zadania (§8.3).

**`validateLessonStory(story, ctx)`** zwraca listę błędów po polsku dla rodzica.

Kształt:
- 4–6 zdań. Każde zdanie po przycięciu i scaleniu białych znaków jest niepuste
  i ma ≤ 160 znaków. Całość ≤ 700 znaków.
- 1–2 pytania o unikalnych `id`. Treść pytania jest niepusta i ma ≤ 160 znaków.
- Dokładnie 3 opcje o unikalnych `id`, niepuste, ≤ 80 znaków, różne po
  normalizacji (`trim`, scalenie białych znaków, `toLocaleLowerCase("pl-PL")`).
  Opcje różniące się tylko liczbą spacji („A  B” i „A B”) dziecko widzi jako
  identyczne, więc są duplikatem.
- `correctOption` wskazuje jedną z opcji.

**Bariera ekspozycji** chroni ćwiczenia przed ujawnieniem rozwiązania.
- `ctx` niesie **rozwiązane zdania** ćwiczeń wersji:
  - `feedbackSentenceText` (#194) dla każdego ćwiczenia, czyli luka wypełniona
    i `stem` z poprawną opcją;
  - luka (`lesson_gap`) wypełniona także każdym wariantem `acceptedAnswers`;
  - tekst poprawnej opcji `lesson_choice`, którego `stem` nie ma luki
    (np. „Które zdanie jest poprawne?”);
  - `answer` i `acceptedAnswers` typów pełnozdaniowych (`lesson_error_fix`,
    `lesson_transform`, `lesson_open_answer`).
- Zdanie historyjki jest odrzucane, gdy po normalizatorze przedmiotu
  (`subject.normalizer.normalize`) dowolny jego wariant tokenów równa się
  dowolnemu wariantowi któregoś rozwiązanego zdania. Normalizator usuwa
  interpunkcję i wielkość liter oraz rozwija skróty.

Tego bariera **świadomie nie** robi:
- nie blokuje częściowej zbieżności (ta sama forma w innym zdaniu, np. „plays”).
  Pokazanie formy w kontekście jest celem historyjki;
- nie blokuje zbieżności z przykładami kart, które i tak są jawną ekspozycją.

Ekspozycje historyjki (§8.2) mają klucze całych zdań, więc nie oznaczają kluczy
ćwiczeń, np. `"plays"` dla luki. Ćwiczenia zachowują status „niewidziane”.

**`storyReadText(story)`** zwraca tekst nagrania: zdania złączone spacją, bez
pytań. Ten sam tekst jest wejściem fingerprintu, więc zmiana pytań nie zmienia
nagrania.

**`solvedSentencesOf(drafts)`** to pomocnik zbierający rozwiązane zdania puli.
Korzystają z niego walidacja, prompt (§6.1) i dogenerowanie (§6.5).

## 5. Przedmiot (`SubjectModule`)

- `readonly lessonStory?: boolean`. Brak oznacza `false`.
  - `english_grammar: true`.
  - Pozostałe przedmioty nie mają pola.
- `SubjectPromptProfile.storyRules?: string`. Reguły dla gramatyki:
  - ćwiczony czas tematu;
  - prosty język dla początkującego ~8-latka;
  - słownictwo z materiału rodzica tam, gdzie to możliwe;
  - 4–6 krótkich zdań o jednej postaci lub sytuacji;
  - formy z kilku reguł tematu: twierdzenie, przeczenie, pytanie;
  - pytania o treść (kto, co, kiedy), nie o gramatykę;
  - błędne opcje wiarygodne, ale jednoznacznie sprzeczne z tekstem;
  - żadnego zdania z listy rozwiązanych zdań ćwiczeń.
- `validateSubject`: gdy `lessonStory` jest `true`, wymagane jest niepuste
  `storyRules`.
- `architecture.test.ts` pilnuje braku identyfikatorów przedmiotów w silniku,
  `materials/lessons` i `learning/lessons`. Zachowanie włącza tylko flaga.

## 6. Generowanie (materials)

Właściciel: `materials/lessons`.

Port LLM: `generateLessonStory(input, { signal }): Promise<unknown>`
w `ports/ai.ts`.
- Adapter OpenAI używa strict `json_schema` `lesson_story`.
- Fake provider zwraca deterministyczną, poprawną historyjkę bez kolizji z pulą
  fake'a.

### 6.1. Wejście promptu

Do promptu trafiają wyłącznie dane bez informacji o dziecku:
- tytuł tematu;
- `descriptionEn` wybranych celów;
- materiał rodzica, w tym samym bloku co przy puli;
- opcjonalna instrukcja;
- `storyRules`;
- rozwiązane zdania ćwiczeń (≤ 120, przycięte), opisane jako „nie powtarzaj
  tych zdań”. Nie przekazujemy gołych odpowiedzi typu „plays”, żeby model nie
  unikał form, które ma pokazać.

### 6.2. Run historyjki (osobny od runu lekcji)

Historyjka nie jest krokiem runu lekcji. Wywołanie LLM zużywałoby wspólny limit
runu: przy przekroczeniu poprawna pula przepada, a wyjątek oznacza cały run jako
`failed`. Zamiast tego jest osobny run.

**Rodzaj runu:**
- `generation_runs.kind = 'lesson'` z `input.purpose = 'story'`;
- dane `input` takie jak w runie lekcji;
- CHECK `generation_runs_kind_shape` pozostaje bez zmian.

**Kolejkowanie automatyczne:**
- Finalizacja udanego runu lekcji (pełne generowanie, nie dogenerowanie reguły)
  kolejkuje run historyjki w **tej samej transakcji**, gdy:
  - przedmiot ma `lessonStory`;
  - wersja nie ma historyjki.
- Dedupe: `lesson-story:<runId lekcji>`.
- `expectedEditNumber` = numer edycji po finalizacji.

**Kolejkowanie ręczne** — `regenerateLessonStory({ deckId, expectedEditNumber,
clientRequestId })`, procedura parent oRPC `lessonDrafts.regenerateStory`:
- dedupe `lesson-story:<clientRequestId>`, osobna przestrzeń od
  `regenerateObjective`;
- wersja nie może być opublikowana (inaczej `immutable`);
- numer edycji musi się zgadzać (inaczej `conflict`);
- nie może trwać inny run lekcji tej wersji (inaczej `conflict`);
- przedmiot musi mieć flagę (inaczej `validation`).

**Wykonawca `executeLessonStoryGeneration`** to osobna funkcja. Nie korzysta
z gałęzi batchy, celów dynamicznych ani `uniqueValid`. Kroki:
1. Odczyt wersji i puli. Zbudowanie rozwiązanych zdań w pamięci.
2. Wywołanie LLM z własnym terminem runu. Retry przy błędach przejściowych
   działa jak w runach lekcji (wymaganie 2.11). Brak retry przy błędach
   konfiguracji, odmowie i złym formacie (2.10).
3. Parsowanie Zod `LessonStorySchema`, potem `validateLessonStory`.
   - Odrzucenie kończy run jako `failed` z kodem `story_invalid`.
   - Błąd providera kończy run kodem z istniejącej taksonomii.
4. Finalizacja pod blokadą wersji:
   - kontrola `expectedEditNumber` (rozjazd daje `superseded`, bez zapisu) —
     **zastąpione**, patrz „Uzupełnienie z planowania 2026-11-01” niżej;
   - ponowna walidacja z aktualną pulą;
   - zapis `lesson_context.story`;
   - **podbicie `editNumber`** — **zastąpione**: run historyjki nie podbija
     numeru edycji (uzupełnienie niżej);
   - `reconcileDraftAssetsTx`, które kolejkuje nagranie (etap 2).
   Stan wersji (`review`) się nie zmienia.
5. Przy błędzie poprzednia historyjka zostaje bez zmian.

**Wpływ na inne operacje:**
- Edycja rodzica oznacza oczekujący lub trwający run jako `superseded`, jak każdy
  run lekcji. Rodzic może wtedy wygenerować historyjkę ponownie. **Zawężone**
  w uzupełnieniu niżej: anuluje tylko edycja z polem `story`.
- Publikacja z trwającym runem historyjki działa tak, jak dziś publikacja przy
  aktywnym runie lekcji. Weryfikacja w implementacji: jeśli publikacja jest
  blokowana, run historyjki nie może jej blokować. Publikacja oznacza go wtedy
  jako `superseded`.

**Stan dla panelu:**
- `GenerationDto` dostaje `purpose: "lesson" | "story"` — **zastąpione** polem
  `LessonDeckDto.storyGeneration` (uzupełnienie niżej).
- Panel pokazuje run historyjki w sekcji historyjki, nie jako generowanie lekcji.
- „Spróbuj ponownie” ponawia run historyjki: porażkę w miejscu, a run
  zawieszony w `running` zastępuje nowym runem z tym samym wejściem, także
  `purpose` (§6.2a).
- Nie ma pola `storyError` w `lesson_context`. Stan błędu wynika z ostatniego
  runu historyjki wersji, więc nie kopiuje się do nowej wersji.

### 6.2a. Uzupełnienie z planowania 2026-11-01

Ustalone przy planowaniu etapu 1
(`docs/superpowers/plans/2026-11-01-lesson-end-story-stage1.md`) i wdrożone
w kodzie etapu 1. Tam, gdzie §6.2 mówi inaczej, obowiązuje to uzupełnienie.

**Run historyjki a numer edycji:**
- Run historyjki **nie podbija** `editNumber` i nie sprawdza go przy
  finalizacji. Inaczej rodzic, który zaczął poprawiać lekcję zaraz po
  generowaniu, dostałby konflikt zapisu, gdy po ok. 20 s dojdzie historyjka.
- Finalizacja wymaga tylko trzech warunków: run nadal `running` z tą samą
  liczbą prób, wersja nieopublikowana, historyjka poprawna wobec **bieżącej**
  puli. Zapis to scalenie klucza `story` w `lesson_context` pod blokadą wersji.

**Co anuluje (`superseded`) run historyjki:**
- edycja z polem `story` w patchu (wybór rodzica wygrywa). Ta sama edycja
  oznacza jako `superseded` także **porażki** (`failed`) runów historyjki tej
  wersji — tylko runy historyjki i tylko w stanie `failed`, w tej samej
  transakcji. Baner „Historyjka nie powstała.” znika, a ponowienie starej
  porażki nie nadpisze historyjki napisanej przez rodzica (`conflict`);
- publikacja: run sprawdza `state === published` przy finalizacji i kończy się
  jako `superseded` bez zapisu, także gdy publikacja nastąpi w trakcie
  wywołania modelu. Publikacja nie czeka na run historyjki i nie jest przez
  niego blokowana;
- nowy pełny run lekcji, także ręczne ponowienie pełnego runu
  (`retryGeneration`): nowa pula unieważnia walidację historyjki w toku.

**Czego run historyjki nie blokuje i co go nie anuluje:**
- zwykła edycja ćwiczeń, tytułu i przykładów go nie anuluje. Gdy taka edycja
  w trakcie runu sprawi, że zdanie historyjki powtarza rozwiązanie ćwiczenia,
  finalizacja (walidacja wobec bieżącej puli) kończy run jako
  `failed`/`story_invalid`, a poprzednia historyjka zostaje;
- dogenerowanie reguły (także jego ponowienie) go nie anuluje, a aktywny run
  historyjki nie blokuje dogenerowania.

**Panel:**
- `LessonDeckDto.generation` nadal pokazuje tylko runy lekcji
  (`purpose !== 'story'`);
- nowe pole `LessonDeckDto.storyGeneration` (opcjonalne, `GenerationDto | null`)
  niesie najnowszy run historyjki edytowalnej wersji. **Zastępuje ono pole
  `GenerationDto.purpose` ze specu** (§6.2 „Stan dla panelu”, §11, §14):
  `GenerationDto` się nie zmienia, a „Spróbuj ponownie” w sekcji historyjki
  ponawia run wskazany przez `storyGeneration.id`.
- `LessonDraftDto.story` jest polem opcjonalnym (brak pola = brak historyjki)
  zamiast `LessonStoryDto | null`, zgodnie z zasadą wstecznej zgodności DTO.
- PATCH z edytora wysyła `story` tylko wtedy, gdy historyjka różni się od
  zapisanej. Zwykły zapis ćwiczeń nie anuluje więc trwającego runu historyjki.
- Gdy run historyjki czeka albo trwa, pola sekcji historyjki, dodawanie
  i usuwanie zdań i pytań oraz „Usuń historyjkę” są zablokowane. Rodzic nie
  napisze zmiany, którą za chwilę zastąpi wynik runu. Reszta edytora działa.

**Ponowienie runu historyjki (`retryGeneration`):**
- ponownie kolejkuje run z `expectedEditNumber` = bieżący numer, bez
  podbijania numeru i bez anulowania innych runów;
- run `failed` i odroczony `queued` dostają nowy budżet prób (`attempts = 0`);
- run `running` (np. po awarii workera) zostaje oznaczony jako `superseded`,
  a w tej samej transakcji powstaje **nowy** run historyjki: nowe id,
  `attempts = 0`, to samo wejście (z `purpose: 'story'`), `expectedEditNumber`
  = bieżący numer, klucz `lesson-story:retry:<id nowego runu>`.
  `retryGeneration` zwraca id nowego runu. Spóźniony worker starego runu nie
  przejdzie CAS finalizacji (`running` + liczba prób), więc nie zapisze wyniku;
- `queued` bez odroczenia nie zmienia się;
- inny aktywny run historyjki tej wersji (nie ponawiany) daje `conflict`.

**Panel przy zawieszonym runie:** gdy run historyjki jest w `running`, sekcja
pokazuje podpowiedź jak przy zawieszonym generowaniu puli i przycisk „Spróbuj
ponownie”. Jest wyłączony przy niezapisanych zmianach, zajętości i konflikcie.
„Spróbuj ponownie” (po porażce i przy zawieszonym runie) pyta o potwierdzenie,
gdy historyjka istnieje — jak „Wygeneruj od nowa”, bo wynik runu ją zastąpi.
„Wygeneruj historyjkę” jest wyłączone, gdy szkic nie ma ćwiczeń.

**Przycisk „Wygeneruj historyjkę”** (`regenerateLessonStory`) odrzuca też
wersję bez ćwiczeń (`validation`): bez puli bariera ekspozycji nie ma czego
chronić.

### 6.3. Edycja

Patch `lessonDrafts.edit` dostaje pole `story`:
- `story: LessonStory | null`;
- `null` usuwa historyjkę;
- brak pola oznacza bez zmian;
- wartość zastępuje historyjkę w całości.

Walidacja przy edycji:
- `validateLessonStory` liczy rozwiązane zdania z puli **po** zmianach z tego
  samego patcha;
- błąd zwraca `validation` z `details.story: string[]`.

### 6.4. Publikacja

- Gdy wersja ma historyjkę, publikacja waliduje ją z finalną pulą. Błąd zwraca
  `validation` z `details.story`.
- Publikacja **nie czeka** na nagranie.
- Publikacja **nie wymaga** historyjki.

### 6.5. Dogenerowanie reguły

`regenerateObjective` traktuje zdania historyjki jak istniejące rozwiązania.
Wygenerowane ćwiczenie, którego rozwiązane zdanie koliduje z historyjką, jest
odrzucane z powodem zliczanym dla rodzica, jak duplikaty. Publikacja nie blokuje
się wtedy niespodziewanie.

### 6.6. Kopia wersji i DTO rodzica

**Kopia:** `createVersionFromPublished` kopiuje `lesson_context`, więc historyjkę
też. Kopia i publikacja bez edycji uzgadniają nagranie: `reconcileBeforePublish`
tworzy wiersz z §7.

**DTO rodzica** (`LessonDraftDto`):
- `story?: LessonStoryDto` — pole opcjonalne, brak pola oznacza brak
  historyjki (§6.2a);
- `storyEnabled: boolean`, zgodnie z precedensem `voiceTones`: flaga przedmiotu
  wyliczona przez serwer;
- `storyAudio?: LessonPromptAudioDto`, ten sam schemat co nagrania pytań.
  Brak pola oznacza brak nagrania.

**Kontrakt:** `LessonStorySchema` (Zod) w `packages/contracts/src/lessons.ts`.

## 7. Media (materials)

**Tabela `lesson_story_assets`** (migracja `0032` albo kolejny wolny numer):
- dosłowna kopia `0028_lesson_card_assets.sql`;
- kolumny: `deck_version_id` (PK, FK bez kaskady), `asset_id` (FK
  `media_assets`), `expected_fingerprint`;
- indeks `asset_id`;
- trigger niezmienności wierszy opublikowanej wersji;
- schemat Drizzle w tym samym PR.

**Uzgadnianie:** `reconcileLessonStoryAssetTx` z `reconcileDraftAssetsTx`, obok
kart.
- Gdy przedmiot ma `lessonStory` i wersja ma historyjkę:
  `ttsAsset("feedback_audio", storyReadText, subject.answerLocale, settings)`,
  bez stylu, przez `findOrCreateAsset`.
- Brak historyjki usuwa wiersz.
- Nieudane nagranie jest ponawiane przy uzgadnianiu, także przy publikacji, jak
  karty (bez `keepFailed`). Opublikowana wersja z nagraniem `failed` zostaje bez
  odczytu do następnej wersji.

**Worker:** `supersedeDisabledLessonTts` w `media-generation.ts` dziś oznacza
jako `failed` każdy zasób bez znanego odwołania.
- Musi dołączyć `lesson_story_assets` i zastępować tylko nagrania wersji, których
  przedmiot nie ma `lessonStory`.
- Test integracyjny: nagranie historyjki dochodzi do `ready`.

**Rodzic:**
- `readLessonAudioStates` zwraca stan nagrania historyjki;
- `regenerateLessonStoryAudio` działa wzorem `regenerateLessonCardAudio`;
- procedura `lessonDrafts.regenerateStoryAudio`.

## 8. Sesja (learning)

Właściciel: `learning/lessons`. Granice transakcji się nie zmieniają: plan przy
`startSession`, wydanie w `nextTask`, finalizacja w transakcji próby.

### 8.1. Typy

- Nowe typy zadań sesji `lesson_story` i `lesson_story_question`. Trafiają do
  `EXERCISE_TYPES` w kontrakcie i do osobnego typu serwera
  `LessonSessionTaskType = LessonExerciseType | LessonStoryTaskType`.
- **Nie** trafiają do `LessonExerciseType` ani `LESSON_EXERCISE_TYPES`: puli,
  schematu LLM, `STAGE_BY_TYPE` i edytora ćwiczeń.
- Jeden predykat `isNonAssessedLessonTaskType(type)` (`lesson_card`,
  `lesson_story`, `lesson_story_question`) i jego odpowiednik SQL (`not in (…)`)
  zastępują literały `lesson_card` w licznikach.
- Plan sesji (`training-session-plan.ts`) dostaje `taskKind: "story" |
  "story_question"`. Wersja snapshotu zostaje 1, bo nowe wartości enumu nie
  psują odczytu starych planów.

### 8.2. Plan i wydanie

**Plan.** `createLessonTrainingSessionPlan` po pętli ocenianych slotów dokleja
sloty historyjki, gdy jednocześnie:
- przedmiot ma `lessonStory`;
- wersja ma historyjkę;
- plan ma ≥ 1 oceniany slot.

Sloty to `lesson_story`, a po nim po jednym `lesson_story_question` na pytanie.
Wszystkie mają `assessed: false` i nie zmieniają `taskBudget`.

Szczegóły slotów:
- **Kotwica:** rewizja pierwszego ćwiczenia pierwszego celu, jak karty.
- **Nagranie:** rozwiązywane przy budowie planu jak karty, czyli gotowy zasób
  o oczekiwanym fingerprincie z najnowszej generacji. Brak gotowego nagrania
  oznacza brak odczytu w tej sesji.
- **Wyłączenia:** historyjki nie dostają ścieżka bez planu (stare sesje) ani
  kartkówka.

**Wybór slotu.** Dziś slot wybiera indeks `counts.planned`. Od teraz
`issueNextLessonPlanTask` wybiera **pierwszy slot planu, którego `taskId` nie ma
w `session_tasks`**, z dwiema regułami:
- Zwykły przebieg wydaje sloty po kolei.
- Gdy `nextTask` kończyłby sesję (`remaining <= 0` albo miękki limit czasu),
  zamiast `null` wydaje pierwszy niewydany slot historyjki. Pominięte sloty
  oceniane nigdy już nie wychodzą.

To samo założenie indeksu w `lesson-shorten.ts` („Skróć”) zostaje poprawione.
Skrócenie usuwa niewydane sloty oceniane, a sloty historyjki zostają na końcu.
Okno wznowienia (30 min) i `endSession` pomijają historyjkę.

**Liczniki:**
- Wszystkie liczniki „ocenianych” używają predykatu z §8.1:
  - `lessonTaskCounts`;
  - `sessionActivityAndCounts` w `sessions.ts`;
  - `assessedBefore` przy ponownym odczycie wydanego zadania;
  - `parent-work-card`;
  - podsumowanie.
- Historyjka nie zużywa `remaining`, więc ścieżka limitu czasu nie uwalnia
  ocenianych slotów.

**Kontrakt licznika:**
- `TaskDto.remainingAssessed` zmienia się z `positive()` na `nonnegative()`.
- Zadania historyjki mają `0`, a Kid UI przy `0` ukrywa baner.
- Nowe opcjonalne pole `TaskDto.closingStory?: true` jest ustawiane na zadaniach
  ocenianych, gdy plan sesji ma sloty historyjki.
- Kid UI pokazuje wtedy baner **„Jeszcze N i historyjka!”** zamiast
  „Jeszcze N i koniec!”.

**Ekspozycje:**
- Wydanie `lesson_story` i każdego `lesson_story_question` (którego prompt znowu
  pokazuje zdania) pieczętuje `prompt_issued` z ekspozycjami
  `lessonTextTargetKey` każdego zdania.
- Zapis odbywa się w tej samej transakcji, przed wysłaniem treści.
- Bariera z §4 gwarantuje, że te klucze nie są rozwiązaniami ćwiczeń.

### 8.3. Pytanie: materializacja i odpowiedź

**Materializacja** (wzorem `lesson_choice`):
- każda opcja dostaje UUID nadany przy wydaniu;
- kolejność to `seededShuffle(taskId)`, żeby dziecko nie uczyło się pozycji
  poprawnej odpowiedzi przy tej samej historyjce;
- prywatny klucz zadania zawiera `correctOptionId`, `optionValues` (dla oceny
  aktywności) i `storyQuestionId`. Klucz nie ma `targetKey` ćwiczenia.

**Odpowiedź.** Osobna funkcja `answerStoryQuestion` w `learning/lessons`. Używa
istniejącej blokady sesji, idempotencji `clientAttemptId` i zamrożenia
`received_at`, ale nie wchodzi do `finalizeLessonAttempt`.
- Akceptowana jest tylko modalność `choice`.
  - `dont_remember`, `text` i inne dają `validation` (400). Serwer odrzuca je
    jawnie, bo `dont_remember` byłby dziś liczony jako trudność celu kotwicy.
  - Kid UI nie pokazuje „Nie pamiętam” ani „Pomiń” (widoki lekcji ich nie mają).
- Ocena jest deterministyczna: `correct` albo `incorrect`. Feedback to „Świetnie!”
  albo „Poprawna odpowiedź: …” (`correctText` = tekst poprawnej opcji).
  - Jedna próba kończy zadanie.
  - Nie ma nagrania zdania (`feedback_audio`) ani modelu oceniającego.
- Feedback jest pieczętowany `feedback_issued` bez kluczy ćwiczeń
  (`exposures: []`), bo nie ujawnia rozwiązania żadnego ćwiczenia.
- Odpowiedź **nie** tworzy wiersza `assessments`. Nie zmienia projekcji, streaków,
  cyklu wsparcia ani licznika wywołań modelu. Próba ma
  `context.storyQuestion = true`.
- Kid UI: odpowiedzi na pytania nie zmieniają serii ani świętowania
  (`session-progress-state`). Pasek postępu sesji ich nie liczy.

### 8.4. Ujawnienia na żądanie

`authorizeDisclosure` (`events.ts`) dziś blokuje dla `lesson_*` tylko `audio`.
`hint` na zadaniu kotwiczonym zwróciłby `answer` ćwiczenia-kotwicy.
- Zmiana: serwer odrzuca **każde** ujawnienie (`hint`, `audio`, `distractors`,
  …) dla `lesson_story`, `lesson_story_question` i `lesson_card`.
- Dla karty to ta sama latentna luka, naprawiana przy okazji, bo dotyczy tej
  samej kotwicy.
- Test integracyjny pokrywa odrzucenie.

### 8.5. Czytelnicy zadań i prób (pełna lista)

**Serwer — typy historyjki wykluczone albo obsłużone jawnie:**
- `lesson-sessions.ts`:
  - `previousObjectiveContactSnapshot` — filtr po typie, bo inaczej każda sesja
    dawałaby fałszywy kontakt z pierwszym celem i psuła regułę „inny dzień po
    ≥ 12 h”;
  - historia sesji;
  - `lastSeenAt`;
  - `historicalSupportObjectives`;
  - budowa planu: liczniki i `assessed`;
  - `buildLessonSummaryObjectives`.
- `sessions.ts`:
  - `sessionActivityAndCounts`;
  - `assessedBefore`;
  - strażnik `completePresentation`, który dopuszcza `lesson_story`.
- `lesson-shorten.ts`.
- `lesson-mock-tests.ts` (`switch`) — nigdy nie wydaje historyjki.
- `parent-work-card.ts`.
- `session-activity.ts` (`switch`) — historyjka i pytania trafiają do oceny
  aktywności jako zwykła praca dziecka: bodziec, opcje, warianty poprawne
  i wysłana odpowiedź, bez danych dziecka (zgodnie z AGENTS.md).
- Nadzór werdyktów rodzica i przebudowa postępu opierają się na `assessments`,
  więc nie wymagają zmian. Test integracyjny to potwierdza.

**Kid UI:**
- `session-controller.ts`:
  - strażnik `completePresentation`;
  - `remainingFor`;
  - baner.
- `ExerciseView.tsx` (`switch` z `never`).
- `exercise-presentation.ts`.
- `LearnScreen.tsx` — etykiety odsłuchu i komunikaty błędu.

**Kontrakty:** `messages.ts` (`switch`).

### 8.6. Baza

Migracja razem z tabelą z §7:
- `session_tasks_completed_only_exposure` dopuszcza `lesson_story` (SQL
  i `schema.ts`);
- `attempts_modality_allowed`, `learning_events_kind_allowed`
  i `generation_runs_*` — bez zmian.

## 9. Kontrakt Kid API

`TaskPromptSchema` dostaje dwie gałęzie `.strict()`:

```ts
{ kind: "lesson_story",
  story: { sentences: string[] /* 4–6, min(1) */ }.strict(),
  contentLocale: string,                // answerLocale przedmiotu (lang tekstu)
  questionAudioAssetId?: Uuid }         // nagranie historyjki
{ kind: "lesson_story_question",
  question: string,                     // pl-PL
  options: { id: Uuid; text: string }[] /* length(3) */,
  story: { sentences: string[] }.strict(),
  contentLocale: string,
  questionAudioAssetId?: Uuid }
```

- Nazwa `questionAudioAssetId` pozwala ponownie użyć `questionAudioOf()`
  i `QuestionAudioButton`. To pole „Posłuchaj” zadania; dla historyjki znaczy
  „nagranie historyjki”.
- Kontrakt nie ma `correctOption` ani żadnego klucza. Testy sprawdzają, że
  gałęzie odrzucają nadmiarowe pola i przyjmują `remainingAssessed = 0`.
- `EXERCISE_TYPES` dostaje oba typy. `TaskDto` dostaje `closingStory?`.

## 10. Kid UI

Ekrany są budowane wyłącznie ze wspólnych komponentów. Bez surowych kontrolek
i bez literałów stylu.

**`LessonStoryView`**, na układzie `LessonCardView`:
- nagłówek „Historyjka”;
- blok czytania zdań (`lang={contentLocale}`,
  `max-inline-size: var(--kid-reading-measure)`);
- odsłuch `QuestionAudioButton` z etykietą `listenLessonStory`, gdy jest
  nagranie;
- „Dalej” wywołuje `completePresentation`.

**Autoodtwarzanie historyjki:**
- raz, **po zamontowaniu panelu** (`AnimatePresence mode="wait"`, wzorzec
  `TaskPane`);
- **ciche jak `playSentenceAudio` (#194)**: zablokowany autoplay i błąd pliku
  nie pokazują komunikatu, zostaje przycisk;
- „Dalej” i nowe zadanie przerywają odczyt.

Błąd ręcznego odsłuchu pokazuje nowe komunikaty `storyAudioUnavailable`
i `storyAudioRetry`.

**`LessonStoryQuestionView`**, w kolejności od góry:
1. pytanie po polsku;
2. opcje w `AnswerGrid` — wybór od razu wysyła odpowiedź;
3. blok zdań historyjki (do ponownego przeczytania; bez nagrania to jedyna droga
   powrotu) i odsłuch bez autoodtwarzania.

Ta kolejność trzyma opcje w widoku w poziomie telefonu. Wynik pokazuje
`AnswerFeedback*` z „Dalej”.

**Feedback:** przy wyniku `guidanceInDock` zeruje odsłuch pytania, jak w #194,
więc nie pojawiają się dwa głośniki.

**Podsumowanie:** po ostatnim pytaniu `nextTask` zwraca `null`, a klient pokazuje
zwykłe podsumowanie.

**Responsywność:**
- treść rośnie albo przewija się w ramie;
- pierwsza opcja jest widoczna bez przewijania w portrait i landscape telefonu;
- akcje pozostają osiągalne na tablecie i na desktopie ze skalą > 1.

## 11. Panel rodzica

`LessonEditor` dostaje sekcję „Historyjka na koniec sesji”, widoczną przy
`storyEnabled`.

**Formularz (Mantine):**
- 4–6 pól zdań z dodawaniem i usuwaniem;
- 1–2 pytania, każde z trzema opcjami i `Radio` poprawnej odpowiedzi.

**Stan:**
- `storyForm` bierze udział w `isDirty`, w obsłudze konfliktu i w strażniku
  nawigacji;
- zapis wysyła `patch.story`;
- `details.story` z edycji i publikacji wyświetla się przy sekcji.

**Akcje:**
- „Wygeneruj historyjkę” albo „Wygeneruj od nowa”, z potwierdzeniem, gdy
  historyjka istnieje;
  - przycisk jest wyłączony przy niezapisanych zmianach, zajętości i trwającym
    runie (wzorzec `regenDisabled`);
- stan runu historyjki: „Przygotowuję historyjkę…” i błąd z „Spróbuj ponownie”,
  który ponawia run historyjki (`storyGeneration`, §6.2a);
- „Usuń historyjkę”;
- odsłuch i „Nagraj ponownie” wzorem kart, tylko przy treści niezmienionej od
  zapisu.

**Wersja opublikowana:** sekcja w trybie odczytu, ze wskazówką „Utwórz nową
wersję, aby dodać lub zmienić historyjkę”.

**Tekst informacyjny:** „Dziecko przeczyta i posłucha historyjki na koniec
każdej sesji, a potem odpowie na pytania. Pytania nie liczą się do postępu.”

## 12. Zmiana uzgodnionych wymagań i zasad

**Wymaganie 2.13 — dopisane zdanie:**

> THE flow MAY prepare one end-of-session story recording in the answer locale.
> Story sentences SHALL NOT equal (after the subject normalizer) the solved
> sentence or accepted answer of any exercise of the lesson version. The story is
> presented only after the graded tasks of a training session and never blocks
> publication.

**Nowe wymaganie 12 — Historyjka na koniec sesji.** Kryteria z §1, §4, §6
i §8:
- liczby zdań i pytań, pytania PL;
- poza budżetem i postępem;
- bez kartkówki;
- bariera;
- publikacja nie czeka na nagranie;
- run historyjki i przycisk;
- baner „Jeszcze N i historyjka!”.

**Wymaganie 5.4 — dopowiedzenie:** historyjka i jej pytania nie należą do
budżetu 12 ocenianych zadań ani do limitu czasu. Wychodzą po zadaniach sesji,
także gdy sesję zakończył limit czasu, i są zapowiedziane banerem.

**AGENTS.md (UX):** zasada „Po «Jeszcze 3 i koniec!» nie dokładaj zadań” dostaje
wyjątek: zapowiedziana historyjka lekcji jest zamknięciem sesji, nie zadaniem
budżetu.

**`docs/SPEC.md` §22** — zdanie o historyjce.

**`docs/architecture.md` §19:**
- `SubjectModule.lessonStory`;
- run historyjki;
- `lesson_story_assets`;
- typy zadań historyjki;
- predykat typów nieocenianych.

**Spec stylu TTS** — nota: nagranie historyjki bez stylu, w en-GB.

## 13. Prywatność i bezpieczeństwo

- Do LLM trafiają materiał rodzica, opisy reguł, reguły przedmiotu i rozwiązane
  zdania ćwiczeń. Do TTS trafiają wyłącznie zatwierdzone zdania. Ani tu, ani tu
  nie ma danych dziecka.
- Kid DTO nie ma klucza. Opcje dostają UUID przy wydaniu. Ujawnienia na żądanie
  są zablokowane (§8.4).
- Usunięcie profilu usuwa zadania, próby i zdarzenia dziecka. Nagranie zostaje
  jako wspólny materiał.

## 14. API → MCP → `SKILL.md`

- Zmienia się Kid API (gałęzie promptu, `remainingAssessed ≥ 0`,
  `closingStory`) oraz parent oRPC (patch, DTO szkicu,
  `LessonDeckDto.storyGeneration` zamiast `GenerationDto.purpose` — §6.2a,
  dwie procedury).
- MCP udostępnia wyłącznie `learning-overview`, który świadomie nie obejmuje
  lekcji (`SKILL.md`: „grammar lessons are not covered”). Adapter, schemat i skill
  nie wymagają więc zmian.
- Każdy etap potwierdza to wyszukaniem użyć w `apps/web/src/integrations`
  i `integrations/umiem-mcp` i opisuje w PR.

## 15. Testy

### Unit

- `validateLessonStory` (granice, duplikaty, `correctOption`, białe znaki).
- Bariera:
  - luka wypełniona;
  - `stem` + opcja;
  - wariant `acceptedAnswers`;
  - interpunkcja, wielkość liter i skróty;
  - częściowa zbieżność dozwolona.
- `storyReadText`, `solvedSentencesOf`, walidacja katalogu.
- Kontrakty: gałęzie strict, `remainingAssessed = 0`, `closingStory`,
  `LessonStorySchema`.
- Predykat typów nieocenianych.
- Test architektury bez nowych wyjątków.

### Kid UI (Vitest)

- Widoki:
  - `lang`;
  - brak odsłuchu bez nagrania;
  - kolejność pytanie → opcje → historyjka;
  - wybór wysyła odpowiedź;
  - brak „Nie pamiętam”.
- Kontroler:
  - ciche autoodtwarzanie raz, po zamontowaniu;
  - „Dalej” przerywa;
  - `completePresentation` dla `lesson_story`;
  - baner „Jeszcze N i historyjka!” i jego brak przy `0`;
  - seria nie liczy pytań.

### Integracja (PostgreSQL)

**Generowanie:**
- run lekcji kolejkuje run historyjki w tej samej transakcji;
- sukces scala historyjkę w `lesson_context` **bez** podbijania `editNumber`
  (§6.2a) i uzgadnia nagranie;
- `story_invalid` i błąd providera zachowują poprzednią historyjkę;
- edycja z polem `story` w trakcie daje `superseded` (zwykła edycja ćwiczeń
  nie anuluje runu; kolizja z pulą po takiej edycji daje `story_invalid`);
- przycisk: opublikowana wersja zwraca `immutable`, konflikt numeru edycji,
  idempotencja;
- dogenerowanie reguły odrzuca kolizję.

**Edycja i publikacja:**
- walidacja;
- `null` usuwa historyjkę;
- kolizja z ćwiczeniem z tego samego patcha;
- publikacja odrzuca kolizję i nie czeka na nagranie.

**Media:**
- wiersz `lesson_story_assets`;
- zmiana zdań daje nowe nagranie, zmiana pytań nie;
- usunięcie historyjki kasuje wiersz;
- trigger niezmienności;
- worker doprowadza nagranie do `ready` i zastępuje je przy przedmiocie bez
  flagi;
- kopia i publikacja bez edycji tworzą wiersz.

**Sesja:**
- plan kończy się slotami historyjki; budżet i `remainingAssessed` bez zmian;
- historyjka po budżecie;
- historyjka po limicie czasu przy `remaining > 3`, bez wydania pominiętego
  ćwiczenia;
- ponowny odczyt wydanej historyjki ma ten sam licznik;
- „Skróć” zachowuje historyjkę;
- brak historyjki w kartkówce, bez flagi i w starej sesji;
- ekspozycje zdań przy historyjce i pytaniu;
- `previousObjectiveContactSnapshot` ignoruje historyjkę;
- ujawnienia na żądanie odrzucone;
- pytanie:
  - odpowiedź poprawna i błędna;
  - idempotentna ponowna wysyłka;
  - `dont_remember` zwraca 400;
  - brak `assessments` i brak zmian postępu;
- usunięcie profilu.

**Migracja i kosze:**
- testy migracji;
- nowe pliki w najlżejszym koszu `INTEGRATION_BUCKETS`.

**Przegląd skutków ubocznych.** Fake provider zacznie dawać historyjki, więc
testy, które oczekują `nextTask → null` po budżecie lekcji gramatyki (integracja
i `lesson-real-flow.spec.ts`), trzeba przejrzeć i dopasować. Lista powstaje
w planie.

### E2E (Playwright)

**`mocked`, `lesson-story.spec.ts`:**
- historyjka po ostatnim zadaniu;
- baner „Jeszcze N i historyjka!”;
- autoodtwarzanie i powtórka;
- pytanie z dobrą i złą odpowiedzią;
- brak odsłuchu bez nagrania;
- geometria w portrait, landscape telefonu (<480 px), na tablecie i desktopie ze
  skalą > 1, w przypadku najgorszym (700 znaków historyjki, opcje po 80 znaków):
  - brak przepełnienia poziomego;
  - cele ≥ 48 px;
  - pierwsza opcja w viewporcie bez przewijania;
  - akcje osiągalne;
- wpis do partycji `mocked`.

**`real`:**
- rodzic edytuje historyjkę, publikuje;
- dziecko w sesji z budżetem 1–2 kończy historyjką i odpowiada;
- najlżejszy kosz `REAL_BUCKETS`.

**Panel:** przypadek w istniejącym specu edytora (sekcja, walidacja, usuwanie).

**Niezweryfikowane symulacją:** autoodtwarzanie na fizycznym iPhonie/iPadzie
(polityka autoplay Safari) trafia do raportu jako brak dowodu.

## 16. Etapy (3 PR-y)

Każdy etap ma własny plan zadań i review po każdym zadaniu, a kończy się trzema
krytykami i PR. Etapy budują jeden na drugim.

**Etap 1 — dane, generowanie, edycja.** Dziecko jeszcze nic nie widzi.
- §4, §5 i §6 (bez nagrania);
- kontrakt `LessonStorySchema` i DTO;
- sekcja w edytorze bez odsłuchu;
- wymaganie 12 (część rodzica);
- docs.

**Etap 2 — nagranie.**
- §7: tabela, uzgadnianie, worker;
- odsłuch i „Nagraj ponownie” w panelu.

**Etap 3 — sesja i Kid UI.**
- §8, §9 i §10;
- migracja constraintu zadań;
- poprawki liczników i ujawnień;
- E2E geometrii;
- zmiany 2.13, 5.4, AGENTS.md i SPEC §22.
