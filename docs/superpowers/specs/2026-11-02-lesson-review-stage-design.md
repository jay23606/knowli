# Etap przeglądu przy generowaniu lekcji (krytyk + kontrola deterministyczna) — design

Data: 2026-11-02. Status: projekt zaakceptowany w rozmowie przez właściciela 2026-11-02;
specyfikacja przed review trzech krytyków.
Powiązane: `docs/architecture.md` §19 (moduł lekcji), §19.9–19.10 (rozdział, źródła),
`docs/SPEC.md` §29a (lekcje), §37 (rozdział),
`docs/superpowers/specs/2026-10-14-lesson-generation-reliability-design.md` (D1: tożsamość
ćwiczenia ≠ ekspozycja), `2026-11-01-lesson-listen-choice-design.md` (krzyżowa kontrola puli),
`2026-11-01-lesson-error-explanation-design.md` (`explanationPl`),
`2026-11-02-llm-cost-tracking-design.md` (dziennik użycia usług AI).

## 1. Problem i cel

Przegląd szkicu lekcji rozdziału „Unit 3: Ant and Grasshopper” (69 ćwiczeń, 2026-11-02)
wykazał 11 wadliwych ćwiczeń, których dzisiejsza walidacja nie łapie:

- **ujawnione rozwiązanie** — 7 tłumaczeń (etap samodzielny) rozwiązywało zdanie, które było
  przykładem na karcie albo rozwiązaniem luki/układanki tej samej lekcji; scheduler po cichu
  nie wybiera ich jako sprawdzenia samodzielnego, więc pokrycie etapu było fikcyjne;
- **niejednoznaczność** — pary „Where's the X?” ↔ „It's on/in/under …”: każda odpowiedź
  pasowała do każdego pytania;
- **drobne braki** — brak wariantu „Where is…”, odpowiedź „where's” małą literą, pusty etap
  po odrzuceniach słownikowych (naprawione częściowo w #232: skróty where's/there's/what's).

Generowanie to dziś jedno wywołanie modelu na zagadnienie i wyłącznie deterministyczne
kontrole; żadna nie porównuje rozwiązanych zdań ćwiczeń z przykładami kart ani ze sobą,
a nikt poza rodzicem nie ocenia jednoznaczności.

**Cel (właściciel):** wygenerowane ćwiczenia mają być najwyższej jakości. System sam naprawia
albo podmienia wadliwe ćwiczenia; rodzic dostaje czysty szkic i krótką informację, co
poprawiono. Zatwierdzenie i publikacja pozostają decyzją rodzica (AGENTS.md: materiał
dostępny dziecku wymaga zatwierdzenia rodzica).

Ustalenia z właścicielem (2026-11-02):

- **wariant A** — automatyczna naprawa/podmiana, nie tylko oznaczanie;
- **wszystkie przedmioty lekcji**: `english_chapter`, `english_grammar`, `school` — wspólne
  kryteria w silniku plus kryteria przedmiotu w `SubjectModule`;
- **osobny, mocniejszy model krytyka**, domyślnie **Claude Sonnet 5.5** przez OpenRouter,
  konfigurowany osobno od generatora;
- **podejście 1 — krytyk-redaktor**: jeden przebieg krytyka na zagadnienie zwraca werdykt
  i od razu poprawione ćwiczenie; po usunięciach jedna runda dogenerowania pod brakujący etap;
- **ujawnione rozwiązanie** jest regułą twardą przy generowaniu i liczy się do pokrycia przy
  publikacji (zmiana zachowania dla istniejących szkiców — §4.3);
- **„Sprawdź ponownie”** — przegląd na żądanie bieżącego szkicu (§7).

Kryterium sukcesu: na materiale Unit 3 przebieg z krytykiem daje szkic bez błędów
z listy wyżej (§11, próba na prawdziwym modelu).

## 2. Zakres

W zakresie: generowanie pełne i dogenerowanie ręczne (`regenerateObjective`), publikacja
(pokrycie), odczyt szkicu w panelu rodzica (ostrzeżenia, raport), nowy przebieg „przegląd”.

Poza zakresem: historyjka (gramatyka) — powstaje po zapisie puli jak dziś, krytyk jej nie
ocenia; zestawy słówek; karty (treść kart nie jest oceniana, tylko używana jako kontekst —
przykłady kart są wejściem kontroli ujawnień); wsteczny przegląd opublikowanych wersji
(rodzic używa „Utwórz nową wersję” + „Sprawdź ponownie”); ocena przez krytyka zmian rodzica
przy zapisie.

## 3. Przebieg generowania

Fazy `executeLessonGeneration` (`modules/materials/lessons/lesson-drafts.ts`); nowe
pogrubione. Wszystkie wywołania modeli poza transakcją bazy, pod `LessonGenerationControl`
(`assertCurrent` przed i po każdym wywołaniu — przebieg zastąpiony edycją rodzica kończy się
`superseded` jak dziś).

1. Zagadnienia (`generateLessonObjectives`, tylko przedmioty z materiału) — bez zmian.
2. Pula per zagadnienie (`generateLessonPool`, generator) — bez zmian.
3. Czyszczenie i walidacja — bez zmian: kształt, sanityzacja, `refineGeneratedDrafts`,
   `splitByPoolExtra`, `validatePool`, deduplikacja wobec istniejącego szkicu,
   `capListenChoiceOverflow`.
4. **Kontrola ujawnień** (§4) na puli po kroku 3 łącznie z przykładami kart z kroku 2 —
   wynik: lista ustaleń per ćwiczenie; nic nie jest jeszcze usuwane.
5. **Krytyk** (§5) — jedno wywołanie na zagadnienie, zagadnienia równolegle (limit
   współbieżności 3). Wejście: materiał, zagadnienie z kartą, ćwiczenia zagadnienia,
   ustalenia z kroku 4.
6. **Scalenie werdyktów** (§6): poprawki przechodzą ponownie krok 3 i 4; poprawka
   nieprzechodząca walidacji → ćwiczenie odpada; ćwiczenie z ustaleniem ujawnienia, którego
   krytyk nie naprawił skutecznie → odpada (reguła twarda).
7. **Dogenerowanie pod etap** (§6.4) — gdy po kroku 6 etap zagadnienia ma mniej ćwiczeń niż
   minimum pokrycia: jedno wywołanie generatora z poleceniem etapu i liczby, nowe ćwiczenia
   przechodzą kroki 3–6 bez kolejnej rundy dogenerowania.
8. Zapis szkicu w jednej transakcji jak dziś (`applyLessonExercises`, `lesson_context`,
   `editNumber`, stan `review`), razem z **raportem przeglądu** (§7).

Dogenerowanie ręczne („Dogeneruj ćwiczenia…”) przechodzi kroki 2–8 dla jednego zagadnienia;
krok 4 widzi także istniejące ćwiczenia i przykłady szkicu (ujawnienie nowego ćwiczenia przez
stare liczy się tak samo).

**Limit czasu przebiegu.** `runTimeoutMs` rośnie o budżet przeglądu (§9). Gdy deadline
nadejdzie w trakcie kroków 5–7, przebieg nie przepada: kroki 5–7 dla zagadnień bez odpowiedzi
krytyka są pomijane (zagadnienie „nieprzejrzane”), krok 4 i twarde odrzucenie ujawnień
działają, a krok 8 zapisuje szkic. Uzasadnienie: koszt generatora jest już poniesiony, a
kontrola deterministyczna daje szkic nie gorszy niż dziś.

## 4. Kontrola ujawnień (deterministyczna)

### 4.1. Reguła

Ćwiczenie etapu `independent` (`stageOf(exerciseType)`) jest **ujawnione**, gdy jego klucz
`lessonExerciseTargetKey(subject, draft)` równa się:

- kluczowi `lessonTextTargetKey` dowolnego przykładu kart lekcji (`lesson_context.examples`
  wszystkich zagadnień), albo
- kluczowi `lessonExerciseTargetKey` dowolnego **innego** ćwiczenia lekcji, każdego etapu,
  także `lesson_listen_choice` i ćwiczeń poza ścieżką etapów.

Funkcje kluczy są te, których używa zapis rewizji i materializacja kart, więc reguła odtwarza
semantykę schedulera (`exposedBeforeSession` / `targetIssuedThisSession`) już przy
generowaniu: w rozdziale kluczem luki jest rozwiązane zdanie (ujawnia tłumaczenie tego
zdania), w gramatyce samo słowo (nie ujawnia tłumaczenia zdania). Dwa ćwiczenia samodzielne
o tym samym kluczu ujawniają się nawzajem — oba dostają ustalenie (w trakcie nauki pierwsze
wydane ujawnia drugie).

Zdania historyjki nie wchodzą do reguły: istniejąca bariera `storyCollisions` usuwa już
ćwiczenia powtarzające zdanie historyjki.

### 4.2. Implementacja

Czysta funkcja domenowa `findExposureLeaks(exercises, examples, subject)` w
`domain/lessons/` (obok krzyżowej kontroli „Posłuchaj i wybierz” w `pool-validation.ts`
albo w osobnym pliku-liściu importowanym przez nią) zwraca listę
`{ exerciseIndex, source: { kind: "card_example" | "exercise", objectiveId, exerciseIndex? } }`.
Bez nowych pól w bazie i bez migracji. Ustalenie nie jest błędem walidacji
`validatePool` — publikacja i zapis rodzica nie odrzucają ćwiczenia, tylko liczą je inaczej
(§4.3); generowanie stosuje regułę twardą (§3 krok 6).

### 4.3. Publikacja, edytor, pokrycie

- **Pokrycie** (`poolCoverage` przy odczycie szkicu i w `publishLessonDraft`): ćwiczenie
  ujawnione nie liczy się do etapu `independent`. Braki pokazuje dotychczasowy mechanizm
  (`coverage`, 409 `lesson coverage incomplete`) — tak jak dziś `distinctOpenAnswerGaps`.
  **Zmiana zachowania:** istniejący szkic, którego sprawdzenia samodzielne są ujawnione, przed
  publikacją wymaga poprawy albo dogenerowania. Opublikowane wersje i trwające sesje bez zmian.
- **Edytor**: ćwiczenie ujawnione ma ostrzeżenie „Rozwiązanie widać wcześniej (karta
  zagadnienia „…” / ćwiczenie N) — nie liczy się jako samodzielne”. Ostrzeżenie liczone przy
  każdym odczycie szkicu z bieżących danych (pole DTO, §8); edycja nie jest blokowana.

## 5. Krytyk

### 5.1. Port i konfiguracja

Nowy port w `ports/ai.ts`:

```ts
export interface LessonReviewerProvider {
  readonly name: string;
  readonly model: string;
  reviewLessonObjective(input: LessonReviewInput, signal?: AbortSignal): Promise<{ verdicts: unknown[] }>;
}
```

Adapter OpenAI-zgodny (OpenRouter) w `providers/openai/` na wspólnym wrapperze
`postLessonJson`, ze ścisłym `json_schema` (jak `lessonPoolJsonSchema`); adapter zapisuje
zużycie do dziennika kosztów (spec 2026-11-02 śledzenie kosztów, usługa `lesson_review`).
Mapowanie i walidacja semantyczna werdyktów należą do przypadku użycia (§6), nie adaptera.
Fałszywy krytyk w `providers/fake.ts` zwraca werdykty ze skryptu (testy, E2E, brak klucza
w dev).

Konfiguracja w `config-defaults.ts` (`.env` nadpisuje):

| Zmienna | Domyślnie | Znaczenie |
| --- | --- | --- |
| `UMIEM_REVIEWER_ENABLED` | `true` | wyłącznik przeglądu (kontrola ujawnień działa zawsze) |
| `UMIEM_REVIEWER_BASE_URL` | `https://openrouter.ai/api/v1` | endpoint OpenAI-zgodny |
| `UMIEM_REVIEWER_MODEL` | identyfikator Claude Sonnet 5.5 w OpenRouter (do potwierdzenia w implementacji, np. `anthropic/claude-sonnet-5.5`) | model krytyka |
| `UMIEM_REVIEWER_TIMEOUT_MS` | `90000` | limit jednego wywołania |
| `UMIEM_REVIEWER_CONCURRENCY` | `3` | równoległe zagadnienia |

Klucz: `UMIEM_REVIEWER_API_KEY`, a bez niego wspólny `OPENROUTER_API_KEY` — wyłącznie gdy
`UMIEM_REVIEWER_BASE_URL` wskazuje host OpenRouter po https (ta sama reguła co generator
i grader). Brak klucza = krytyk niedostępny (§9). Krytyk działa w procesie worker.

### 5.2. Wejście

Wiadomość systemowa: rola krytyka, wspólne kryteria (§5.4), `reviewRules` przedmiotu,
opis schematu wyjścia. Wiadomość użytkownika: wyłącznie ogrodzone bloki danych (nigdy
polecenia), jak `SENTENCE THEMES` w generatorze:

- `MATERIAL` — materiał rodzica (rozdział, materiał szkolny) albo opis tematu z katalogu
  (gramatyka: reguły i transformacje tematu);
- `OBJECTIVE` — tytuł i rodzaj zagadnienia, treść karty, przykłady karty;
- `OTHER CARD EXAMPLES` — przykłady pozostałych zagadnień (do oceny ujawnień między
  zagadnieniami);
- `EXERCISES` — ćwiczenia zagadnienia w kształcie generatora, z numerem `n` (1…N) i
  `explanationPl`; bez identyfikatorów bazy;
- `DETERMINISTIC FINDINGS` — ustalenia §4 jako „ćwiczenie n: rozwiązanie = przykład karty
  „…”” / „= rozwiązanie ćwiczenia m”;
- `SENTENCE THEMES` — gdy lekcja ma tematy zdań (#197): ta sama lista co dla generatora,
  żeby celowe zdania tematyczne nie były oceniane jako „spoza materiału”.

Prywatność: bez imienia, roku urodzenia, identyfikatorów, wyników ani odpowiedzi dziecka.
Tematy zdań są już migawką materiału (`lesson_context.interests`) przekazywaną generatorowi;
krytyk dostaje tę samą migawkę tym samym dostawcą (OpenRouter), więc zakres danych się nie
zmienia, ale przybywa odbiorca — reguła AGENTS.md („do modelu generującego trafia wyłącznie
lista…”) zostaje rozszerzona o krytyka w etapie 2 (decyzja właściciela 2026-11-02, część 2
projektu). Grader nadal nie dostaje tematów.

### 5.3. Wyjście

```json
{ "verdicts": [
  { "n": 3, "verdict": "ok" },
  { "n": 7, "verdict": "fix", "category": "ambiguous", "reasonPl": "…", "exercise": { … } },
  { "n": 9, "verdict": "drop", "category": "leaked_solution", "reasonPl": "…" }
] }
```

- `verdict`: `ok | fix | drop`.
- `category` (wymagana przy `fix`/`drop`): `ambiguous`, `leaked_solution`, `wrong_answer`,
  `missing_variant`, `unnatural_language`, `off_material`, `unclear_instruction`,
  `wrong_explanation`, `too_hard`, `other`.
- `reasonPl`: polski, 1–120 znaków, dla rodzica.
- `exercise` (tylko przy `fix`): pełne ćwiczenie w kształcie elementu `lessonPoolJsonSchema`
  przedmiotu; **`exerciseType` i `objectiveId` muszą być równe oryginałowi** — inaczej
  poprawka jest odrzucana (§6.2).

Schemat wyjścia budowany z istniejącego `lessonPoolJsonSchema` (ta sama gałąź per typ),
żeby poprawka była walidowana tym samym kodem co pula.

### 5.4. Kryteria

Wspólne (silnik, `domain/lessons/review-criteria.ts`):

1. zadanie zamknięte ma dokładnie jedno poprawne rozwiązanie — pary, grupy, wybór, luki
   w tekście z bankiem i układanka nie dają się poprawnie rozwiązać inaczej;
2. polecenie (z polskim bodźcem, gdy przedmiot go wymaga) jednoznacznie prowadzi do
   odpowiedzi;
3. odpowiedź kanoniczna jest poprawna; warianty obejmują typowe równoważne formy
   (pełna/skrócona), nie obejmują form błędnych;
4. wyjaśnienie błędu (`explanationPl`) jest prawdziwe i dotyczy reguły ćwiczenia;
5. ćwiczenie samodzielne nie ma rozwiązania widocznego wcześniej (ustalenia §4 są
   rozstrzygające — trzeba je naprawić zmianą zdania albo usunąć);
6. język naturalny i poprawny, poziom dla dziecka ok. 8–10 lat;
7. ćwiczenie pasuje do etapu (prowadzone / produktywne / samodzielne) i zagadnienia.

Przedmiotu: nowe wymagane pole `SubjectPromptProfile.reviewRules` (niepuste dla przedmiotów
produkcyjnych; `validateSubject` w rejestrze odrzuca przedmiot bez niego):

- `english_chapter`: tylko słowa i ramy z materiału oraz słowa funkcyjne; luka i opcje na
  słowie treści; polskie zdanie-bodziec jednoznacznie wyznacza odpowiedź; w uzupełnianiu
  tekstu luki nie są zamienialne, słowo-pułapka nie pasuje do żadnej;
- `english_grammar`: ćwiczenie sprawdza regułę tematu, nie przypadkowe słownictwo;
  dystraktory to formy łamiące regułę, nie inne poprawne formy;
- `school`: cytaty `sourceRefs` faktycznie wspierają odpowiedź; elementy wymagane odpowiedzi
  otwartej są kompletne i zgodne z materiałem; rachunki mają poprawny wynik.

Nowy przedmiot dostaje krytyka przez `SubjectModule` + rejestr, bez zmian silnika (test
architektoniczny lekcji bez wyjątków dla identyfikatorów przedmiotów).

## 6. Scalenie werdyktów i dogenerowanie

Czysta funkcja domenowa `applyReviewVerdicts` (bez I/O, testowana jednostkowo) dostaje pulę
zagadnienia, ustalenia §4 i surowe werdykty; zwraca nową pulę, wpisy raportu i braki etapów.

### 6.1. Werdykty

- Surowe werdykty parsuje Zod (`packages/server`, granica adaptera); wadliwy element jest
  pomijany (liczony w raporcie jako „nieczytelny werdykt”), reszta działa.
- `n` spoza 1…N albo powtórzony — werdykt pomijany.
- Ćwiczenie bez werdyktu = `ok`.
- **Bezpiecznik:** gdy `drop` + nieudane `fix` usunęłyby więcej niż połowę ćwiczeń
  zagadnienia, werdykty krytyka dla zagadnienia są ignorowane (pula jak po kroku 3–4,
  z twardym odrzuceniem ujawnień), zagadnienie ma w raporcie stan `suspicious`.

### 6.2. Poprawka (`fix`)

1. Typ i zagadnienie muszą być równe oryginałowi.
2. Poprawka przechodzi pełną ścieżkę świeżej puli: `toExerciseDraft`, sanityzacja (w tym
   `withoutRedundantAcceptedVariants`, `explanationPl`), `refineGeneratedPool` przedmiotu,
   `splitByPoolExtra`, `validatePool` łącznie z resztą puli (duplikaty, krzyżowa kontrola
   „Posłuchaj i wybierz”), `findExposureLeaks`.
3. Niepowodzenie → oryginał odpada (wpis raportu „poprawka odrzucona: <powód walidacji>”).
   Nie wracamy do oryginału: krytyk wskazał w nim błąd.

### 6.3. Ujawnienia — reguła twarda

Po scaleniu każde ćwiczenie samodzielne nadal ujawnione (§4) odpada z kategorią
`leaked_solution`. Działa także przy krytyku niedostępnym, nieprzejrzanym zagadnieniu
i stanie `suspicious`.

### 6.4. Dogenerowanie pod etap

Braki = `DEFAULT_LESSON_POLICY.poolMinimums` minus liczba ćwiczeń etapu po §6.1–6.3
(z §4.3: ujawnione nie liczą się do `independent`). Gdy braki > 0 i przebieg ma budżet
czasu: jedno wywołanie `generateLessonPool` z nowymi polami `LessonPoolInput`
`stageQuota: { stage, count }[]` (adapter wpisuje je do promptu jako wymagany podział) i
`avoidSentences` (rozwiązania istniejących ćwiczeń i przykłady kart — żeby nowe ćwiczenia nie
były ujawnione). Generator może zwrócić więcej — nadwyżka przycinana jak dziś
(`objectiveLimits`). Nowe ćwiczenia przechodzą §3 kroki 3–6 (krytyk ocenia tylko je); bez
drugiej rundy. Brak pokrycia po rundzie = zostaje jak dziś (rodzic widzi brak etapu
i „Dogeneruj ćwiczenia…”).

## 7. Raport przeglądu i „Sprawdź ponownie”

### 7.1. Dane

`lesson_context.review` (JSONB wersji, bez migracji; jak `rejectedReasons`):

```ts
interface LessonReviewReport {
  status: "reviewed" | "partial" | "unreviewed";
  reason?: "disabled" | "unavailable" | "failed" | "timeout"; // przy partial/unreviewed
  model?: string;                     // model krytyka
  objectives: { objectiveId: string; status: "reviewed" | "unreviewed" | "suspicious" }[];
  fixed: { exerciseId: string; category: ReviewCategory; reasonPl: string }[];
  dropped: { objectiveId: string; category: ReviewCategory; reasonPl: string }[];
  toppedUp: { objectiveId: string; stage: LessonStage; count: number }[];
}
```

`fixed[].exerciseId` to identyfikator elementu (`learning_items.id`) nadany przy zapisie
(krok 8). Kolejne przebiegi tej samej wersji (dogenerowanie ręczne, „Sprawdź ponownie”)
dopisują wpisy (`fixed`, `dropped`, `toppedUp` łączone; `objectives` nadpisywane per
zagadnienie; `status` liczony z `objectives`). Limit długości: najwyżej 200 wpisów `fixed`
i 200 `dropped` (starsze obcinane), żeby kontekst wersji nie rósł bez końca.
„Utwórz nową wersję” nie kopiuje raportu. Edycja rodzica nie kasuje wpisów (historia
przeglądu); usunięcie ćwiczenia przez rodzica usuwa tylko plakietkę (wpis bez ćwiczenia
w szkicu nie jest pokazywany przy ćwiczeniach, zostaje w liście banera).

### 7.2. „Sprawdź ponownie”

`POST /api/v1/parent/lesson-drafts/:versionId/review` z `expectedEditNumber` → 202
`{ runId }`; run `kind='lesson'`, `input.purpose='review'` (bez migracji: `purpose` już
rozróżnia `pool` i `story`). Przebieg: §3 kroki 4–8 dla wszystkich zagadnień bieżącego
szkicu (z dogenerowaniem pod etap). Ten sam mechanizm aktualności co dogenerowanie: edycja
rodzica w trakcie → `superseded`; 409 przy niezgodnym `expectedEditNumber`, stanie
`published` albo trwającym przebiegu puli lub przeglądu tej wersji. Zapis przeglądu zmienia
ćwiczenia szkicu (poprawki, usunięcia, dogenerowane) i podbija `editNumber` jak każda
generacja. Ćwiczenia edytowane ręcznie przez rodzica też są oceniane — rodzic świadomie prosi
o przegląd całości.

Wymaga zmian w kontrakcie oRPC/HTTP panelu rodzica (`orpc-contract.ts`, `parent-router.ts`)
i w `generationStatus` szkicu (stan przeglądu w toku: przycisk zablokowany, wskaźnik).

## 8. Panel rodzica

`LessonDraftDto` (pola opcjonalne, `packages/contracts`):

- `review?: LessonReviewReportDto` — z §7.1, bez `objectiveId` w formie technicznej tam,
  gdzie UI pokazuje tytuł zagadnienia (DTO podaje tytuł);
- `exposureLeaks?: { exerciseId: string; sourceLabelPl: string }[]` — z §4, liczone przy
  odczycie.

Edytor lekcji (`apps/web/src/parent/lessons/`, Mantine):

- baner nad listą zagadnień: „Sprawdzone przez krytyka (<model>): poprawiono N, usunięto M,
  dogenerowano K.” z rozwinięciem listy (zagadnienie, kategoria, powód); stan `partial` /
  `unreviewed`: baner ostrzegawczy „Krytyk nie sprawdził <całej lekcji / zagadnień: …>
  (<powód>). Przejrzyj ćwiczenia uważniej.”; `suspicious`: „Krytyk chciał usunąć większość
  ćwiczeń zagadnienia „…” — zostawiono je bez zmian, przejrzyj je.”;
- plakietka „Poprawione” przy ćwiczeniu z wpisem `fixed` (powód w opisie dostępnym dla
  czytnika ekranu, nie tylko w tooltipie);
- ostrzeżenie ujawnienia przy ćwiczeniu (§4.3);
- przycisk „Sprawdź ponownie” (menu zestawu albo baner), z potwierdzeniem „Krytyk może
  zmienić lub usunąć ćwiczenia, także poprawione przez Ciebie.”;
- teksty w katalogu komunikatów (`packages/contracts/src/messages.ts`, `pl-PL`).

Dziecko nie widzi raportu, modelu ani ostrzeżeń (Kid DTO bez zmian).

## 9. Awarie, limity, koszty

- **Krytyk niedostępny** (wyłącznik, brak klucza): kroki 5–7 pominięte; raport
  `unreviewed` z `disabled` / `unavailable`; kontrola ujawnień i reguła twarda działają.
  Dogenerowanie pod etap (krok 7) działa także bez krytyka, bo wynika z braków po regule
  twardej.
- **Błąd wywołania, timeout, wadliwy JSON** dla zagadnienia: zagadnienie `unreviewed`
  (`failed` / `timeout`), reszta lekcji przegląda się dalej; bez automatycznego ponawiania
  krytyka (koszt); ponowienie = „Sprawdź ponownie”. Awaria krytyka **nie** jest błędem
  przebiegu generowania (run kończy się `succeeded`).
- **Budżet czasu przebiegu**: `runTimeoutMs` + `ceil(zagadnienia / CONCURRENCY) ×
  UMIEM_REVIEWER_TIMEOUT_MS` + jedna runda dogenerowania; dokładna formuła w planie
  (zgodna z `withLessonGenerationControl`).
- **Wywołania**: najwyżej 1 krytyk na zagadnienie + 1 dla dogenerowanych ćwiczeń;
  lekcja z 5 zagadnieniami: 5–10 wywołań krytyka, 0–5 dodatkowych wywołań generatora.
- **Koszt**: szacunek do potwierdzenia próbą (§11) — wejście ok. 3–6 tys. tokenów, wyjście
  do ok. 4 tys. na zagadnienie; rzeczywiste zużycie trafia do dziennika kosztów (#231).
- **Dzienniki**: `[lesson-review] run=<id> zagadnienie=<slug> ok=N fix=N drop=N
  invalid=N leaks=N status=<…> durationMs=<…>`; bez treści ćwiczeń, materiału i klucza.

## 10. Moduły, zależności, transakcje

- **Domena** (`packages/server/src/domain/lessons/`): `findExposureLeaks`,
  `applyReviewVerdicts`, `stageDeficits`, kryteria wspólne, typy raportu; bez I/O, zegara
  i losowości; bez importu Drizzle, oRPC, SDK.
- **Przypadki użycia** (`modules/materials/lessons/`): faza przeglądu w
  `executeLessonGeneration`, nowy `requestLessonReview` i wykonanie runu `purpose='review'`
  (lesson-drafts / nowy plik `lesson-review.ts` w obszarze `materials`), odczyt raportu
  i ustaleń w `readLessonDraftDto`, pokrycie w publikacji (`lesson-api.ts`).
  Właściciel: obszar `materials` (autorstwo i nadzór nad materiałem lekcji). Brak nowych
  zależności między obszarami; `learning` i `reporting` bez zmian.
- **Porty i adaptery**: `LessonReviewerProvider` (`ports/ai.ts`), adapter OpenRouter,
  fałszywy krytyk; składanie w `config.ts` na `withConfigDefaults(process.env)`.
- **Transakcja**: jak dziś — jedna transakcja zapisu szkicu (krok 8) obejmuje ćwiczenia,
  `lesson_context` z raportem, `editNumber` i uzgodnienie mediów; wywołania modeli przed nią.
  Blokada wersji i sprawdzenie `expectedEditNumber` w transakcji zapisu (przebieg zastąpiony
  → `superseded`, nic nie zapisuje).
- **Kontrakt**: `LessonDraftDto` (pola opcjonalne), nowy endpoint rodzica. **API → MCP →
  skill**: bez zmian — endpointy rodzica lekcji nie są w MCP, `learning-overview` i skill
  Hermesa nie obejmują lekcji.

## 11. Testy i próba

- **Domena (Vitest)**: `findExposureLeaks` dla trzech przedmiotów (rozdział: luka ujawnia
  tłumaczenie; gramatyka: luka nie ujawnia; przykład karty; dwa samodzielne o tym samym
  kluczu; „Posłuchaj i wybierz”); `applyReviewVerdicts` (ok/fix/drop, brak werdyktu,
  duplikat `n`, zmiana typu, poprawka niewalidna, bezpiecznik połowy, reguła twarda przy
  braku krytyka); `stageDeficits`; schemat wyjścia (ścisłość, kategorie); rejestr odrzuca
  przedmiot bez `reviewRules`; test architektoniczny bez nowych wyjątków.
- **Adapter**: budowa wiadomości (ogrodzone bloki, brak danych dziecka, tematy zdań),
  schemat JSON, błędy HTTP/timeout → błąd portu, zapis zużycia.
- **Integracja (PostgreSQL, fałszywy LLM i krytyk)**: pełna generacja z poprawkami,
  usunięciem i dogenerowaniem → raport w DTO i plakietki; krytyk niedostępny → `unreviewed`
  i reguła twarda; awaria jednego zagadnienia → `partial`; deadline w trakcie przeglądu →
  zapis szkicu; dogenerowanie ręczne przez krytyka; publikacja z ujawnionym tłumaczeniem →
  409 z brakiem etapu `independent`, po poprawie → 200; „Sprawdź ponownie”: 202, idempotencja,
  409 przy niezgodnym `editNumber`, edycja w trakcie → `superseded` (dwie przeglądarki);
  prywatność wejścia krytyka (przechwycone wejście fałszywego krytyka bez danych dziecka).
- **E2E (Playwright, `mocked`)**: baner (trzy stany), plakietka, ostrzeżenie ujawnienia,
  „Sprawdź ponownie” z potwierdzeniem — telefon 390×844 i desktop; geometria: brak
  przepełnienia poziomego, cele ≥ 48 px.
- **Próba na prawdziwym modelu** (ręczna, płatna, poza CI): `pnpm probe:chapter` rozszerzony
  o krytyka; materiał Unit 3 z tej rozmowy (fikcyjny poziom danych — tekst podręcznika, bez
  danych dziecka). Oczekiwanie: brak ujawnionych tłumaczeń, brak niejednoznacznych par
  „Where's…? ↔ It's …”, pełne pokrycie; pomiar czasu i kosztu do dokumentacji. Próba na
  gramatyce (Present Simple) i szkole (istniejący materiał testowy próby szkolnej).

## 12. Kolejność wdrożenia

Każdy etap to osobny PR do scalenia przez właściciela:

1. **Kontrola ujawnień**: `findExposureLeaks`, reguła twarda w generowaniu, pokrycie przy
   publikacji, ostrzeżenia w edytorze, `exposureLeaks` w DTO. Korzyść bez AI.
2. **Krytyk**: port, adapter, fałszywy krytyk, `reviewRules` trzech przedmiotów, kroki 5–6
   i 8 (raport), baner i plakietki.
3. **Dogenerowanie pod etap**: `stageQuota`/`avoidSentences` w `LessonPoolInput`, krok 7.
4. **„Sprawdź ponownie”** + próba na prawdziwym modelu i pomiar kosztu; aktualizacja
   `docs/architecture.md` §19 i `docs/SPEC.md` §29a/§37 w każdym etapie w zakresie zmiany.

## 13. Ryzyka i niezweryfikowane

- Jakość krytyka (czy łapie niejednoznaczność, czy nie „psuje” dobrych ćwiczeń) jest
  niezmierzona do próby §11; bezpiecznik połowy i walidacja poprawek ograniczają szkody, nie
  gwarantują jakości.
- Obsługa `json_schema` (structured outputs) przez wybrany model w OpenRouter — do
  potwierdzenia w etapie 2; gdy niedostępna, adapter używa trybu JSON + Zod i traktuje
  wadliwy wynik jak awarię zagadnienia.
- Zmiana pokrycia (§4.3) może zablokować publikację istniejących szkiców do czasu poprawy;
  opublikowane lekcje nie są dotknięte.
- Czas generowania rośnie (szacunek 1–2 min); pilotaż z rodzicem nie był robiony.
