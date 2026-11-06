# Tabela migracji promptu agenta puli do katalogu reguł (#237, PR 3, Task 8b)

Spec: `docs/superpowers/specs/2026-11-06-lesson-agent-rule-catalog-design.md` §3 („Co zastępuje”,
„Usuwane bez odpowiednika”, „Brak utraty treści”). Plan: Task 8b, krok 2. Stan „przed”: HEAD
`2ca25cf2`. Zrzuty promptu przed i po zmianie (fikcyjny materiał testów) leżą poza repozytorium;
migawki „po” są w `packages/server/src/providers/openai/__snapshots__/`.

Oznaczenia: **reguła** — id wpisu katalogu, którego opis (z dopiskiem przedmiotu) trafia do księgi
reguł promptu i do mapy `rules` wyniku narzędzia; **karta** — `TYPE_CARDS` (opis typu i przykład);
**wskazówka** — zdanie zostaje w prompcie (kod go nie sprawdza); **usunięte** — z powodem.

## 1. Zdania dzisiejszego promptu

### 1.1. `lessonSystemPrompt` (`providers/openai/llm.ts`)

| Zdanie (skrót) | Dokąd |
|---|---|
| Rola przedmiotu, przedmiot i języki, lista zagadnień z typami i kategoriami błędów, przekształcenia | wskazówka (bez zmian) |
| „Supported exercise types for this subject: …” | usunięte: typy zagadnienia są w liście zagadnienia; reguła `exercise.type_unsupported` |
| „Return at most N exercises per objective in this batch, aiming for this stage split: …” | usunięte (potok); menu etapów zostaje jako wskazówka „Stages of the exercise types (Target below gives the counts)”, liczby tylko w `Target` |
| Rezerwacja etapu samodzielnego („the first N MUST be lesson_open_answer …”, rachunki w nadwyżce) | wskazówka (bez „in this batch”) |
| „The stage type lists are a menu …” | wskazówka (bez zmian) |
| „The stage split covers N exercises; … up to L extra lesson_listen_choice …” | wskazówka bez liczb („Target gives their allowance”); limit: reguła `lesson.limit_listen` |
| Grader niedostępny → typy zamknięte | wskazówka (bez zmian) |
| `lesson_calculation`: „return ONLY exerciseType, objectiveId, calculation and sourceRefs … never generate answer, prompt, focus, acceptedAnswers” | karta `lesson_calculation`; reguły `shape.answer`, `school.computed_lists_empty`, `fields.type_specific` |
| rachunek: metody `scale_distance`/`height_difference`/`unit_conversion`, cm/m/km, parametry, zakresy, 3 miejsca po przecinku | reguła `calculation.params`, `calculation.unknown_key` |
| rachunek: „tolerance (use 0 unless needed)” | reguła `calculation.tolerance` (pomiń albo 0; schemat: `tolerance` poza `required`) |
| rachunek: „templateFamilyId (lowercase hyphenated slug)” | reguła `calculation.family_slug` |
| rachunek: metoda z materiału, liczby abstrakcyjne, cytat metody, brak metody → brak rachunków, warianty dzielą `templateFamilyId` | wskazówka (blok `lesson_calculation:`); wspólny rodzaj i jednostki: reguła `school.calculation_family_mismatch` |
| „Calculations supplement the pool within the requested count and the global 160-exercise limit” | usunięte bez odpowiednika (potok) |
| „Publication minima apply to the complete pool … 3 guided, 2 productive and 2 DISTINCT …” | jedno zdanie w `Target` ze stałych (`lessonPoolMinimums`, `DISTINCT_OPEN_ANSWERS_PER_OBJECTIVE`); w bloku rachunku: „Calculations never replace the publication minima in Target.” |
| „never exceed this batch's requested count to satisfy them” | usunięte bez odpowiednika (potok) |
| `lesson_keywords`: OPTIONAL extra, najwyżej jedno, rodzina z tej partii, pojęcia z materiału, dystraktory, bez zdania odpowiedzi, pominąć przy < 2 pojęciach | wskazówka (blok `lesson_keywords`, bez liczb list) |
| `lesson_keywords`: 4–6 opcji `{id, text}` ≤ 40 znaków, 2–3 `keyOptionIds`, każde pojęcie w odpowiedzi rodziny | karta `lesson_keywords`; reguły `keywords.options_count`, `keywords.key_count`, `keywords.key_unknown`, `school.keyword_not_in_answer`, `school.keywords_family_missing`, `school.keywords_family_rejected` |
| `lesson_match`/`lesson_group`: „guided types with their own strict branches: return ONLY …, code computes the answer” | karty `lesson_match`, `lesson_group` |
| pary: 3–5 par, lewa ≤ 40, prawa ≤ 100, 0–2 `extraRight` | reguły `match.pairs_count`, `match.extra_count`, `field.max_length` (limity schematu) |
| grupy: 2–3 grupy (etykieta ≤ 30), 4–8 elementów (≤ 40), ≥ 2 na grupę | reguły `group.groups_count`, `group.items_count`, `group.items_per_group`, `field.max_length` |
| „Texts on one side must be distinct and none may contain another …; an item must not repeat a group label” | reguły `match.confusable`, `group.label_confusable`, `group.item_repeated`, `group.item_is_label` |
| semantyka par, grup i luk przedmiotu (`typeRules`) dokładana przez adapter | blok typu księgi (`subjectRule`) |
| `lesson_cloze`: „strict branch: return ONLY …, code computes the answer” | karta `lesson_cloze` |
| cloze: 2–4 zdania ≤ 300 znaków, 2–4 luki `___`, słowo między lukami, 1–3 słowa ≤ 30 znaków w luce, 1–2 dystraktory | reguły `cloze.gap_count`, `cloze.words_between_gaps`, `cloze.answers_count`, `cloze.bank_word_tokens`, `cloze.extra_count`, `field.max_length`; „2–4 krótkie zdania” — wskazówka w `typeRules.lesson_cloze` szkoły |
| „Exactly one bank word fits each gap … no bank word appears in clozeText outside the gaps” | reguły `check.blind_solve` (jedno rozwiązanie), `cloze.bank_confusable`, `cloze.bank_outside_gap` |
| „Canonical answers must be UNIQUE within this response …” | reguła `lesson.duplicate_answer` (tryb `answer`) |
| „When distinct short answers run out, vary full-sentence answers …” | wskazówka (tryb `answer`) |
| „Within this response, never repeat an exercise with the same objective, type, and functional stimulus …”, także wobec istniejących | reguła `lesson.duplicate_stimulus` (tryb `exercise`) |
| „Reusing a short canonical answer such as do, does … is allowed” | usunięte: wynika z opisu `lesson.duplicate_stimulus` („vary the content, not only the answer”) |
| „sourceRefs is REQUIRED for EVERY exercise … 1-3 quotes copied EXACTLY … at most 600 characters” | reguły `school.quote_required`, `school.quote_in_material`, `school.quote_too_short`, `field.count`, `shape.source_refs`; „najkrótszy fragment” — wskazówka w `fieldRules` szkoły |
| „Field rules for this subject: …” | wskazówka (oczyszczone `fieldRules`, tabela 1.4) |
| reguła tematów zdań (`interestsRule`) | wskazówka (bez zmian) |
| ton lektora: dobór tonu, „Return voiceTone for every exercise except lesson_calculation (null when no tone fits)” | wskazówka (zdanie zostaje, poprawka przeglądu Task 8b); zakaz tonu w rachunku sprawdza też reguła `voice_tone.not_allowed` |
| `explanationPl`: „for every exercise except lesson_calculation, return …”, dla 8-latka, dlaczego odpowiedź jest poprawna, pasuje po „Nie pamiętam”, bez pochwał i imion, przykłady z ćwiczenia, null bez reguły | wskazówka (z „for every exercise except lesson_calculation”, poprawka przeglądu) |
| `explanationPl`: dokładnie jedno zdanie, ≤ 120 znaków, bez `*`, `_` i nowych linii, nie przy rachunku | reguły `explanation.one_sentence`, `explanation.max_length`, `explanation.markup`, `explanation.line_break`, `explanation.empty`, `explanation.not_allowed` |
| „Return strict JSON of the shape {"exercises": …, "examples": …}” | usunięte bez odpowiednika (kształt `examples` to pole narzędzia) |
| lista pól ćwiczenia (stem, statement, prompt, hint, transformId, noticeSegments, visualSubject, answer, acceptedAnswers, focus, options, correctOption, items) | karty typów (pola per typ i przykład); reguły `shape.*`, `fields.type_specific` |
| `hint` = krótka wskazówka w języku odpowiedzi; `instructionPl` w języku polecenia | wskazówka „Field meaning” |
| „focus: copy the whitespace-separated tokens … one contiguous run” | reguły `focus.empty`, `focus.not_contiguous`, `gap.focus` |
| `lesson_notice`: 2–3 zdania po 1–15 segmentów, `correctOption` z segmentów | karta `lesson_notice`; reguły `notice.sentence_count`, `notice.segment_count`, `notice.correct_not_segment` |
| `visualSubject` tylko przy wyborze | reguła `visual.choice_only` |
| `lesson_order`: 3–10 klocków, złączone = odpowiedź | reguły `order.items_count`, `order.items_join` |
| „Use null for optional fields … never invent extra fields” | reguły `field.empty`, `field.invalid` |
| pola v3 tylko, gdy przedmiot o nie prosi | reguła `exercise.v3_field_not_allowed` (przedmioty bez v3), `school.v3_field_type` |
| dyscyplina języka (bodźce w języku odpowiedzi, wyjątek źródła tłumaczenia, nie kopiować polskich słów) | wskazówka (bez przykładu „lesson_open_answer translations”, który niesie `fieldRules`) |
| „acceptedAnswers must NOT contain the canonical answer …” | reguła `variants.duplicate` |
| co jest innym wariantem (skrócone sformułowanie tak, inna pisownia skrótu i wielkość liter nie) | wskazówka „Field meaning” |
| wybór i krótka odpowiedź: 2–4 opcje, różne teksty, `correctOption` jedną z opcji | reguły `options.count`, `options.duplicate`, `options.correct_unknown` |
| „Use only the exerciseType values allowed for the exercise's objective” | reguła `exercise.type_not_allowed` |
| `lesson_listen_choice`: jedna luka, 2–3 opcje, `correctOption`, `answer`, `focus`, bez `instructionPl`, `hint`, `visualSubject` | karta `lesson_listen_choice`; reguły `listen.gap_count`, `options.count`, `listen.instruction_not_allowed`, `listen.hint_not_allowed`, `visual.choice_only` |
| wymagane pola bodźca per typ (stem, statement, prompt) i luka ≤ 3 słowa | reguły `choice.stem_required`, `gap.marker_count`, `gap.answer_tokens`, `error_fix.statement_required`, `error_fix.same_as_answer`, `transform.statement_required`, `short_answer.prompt_required`, `open.prompt_required` |
| teksty ≤ 120 znaków, odpowiedzi według limitu przedmiotu | reguły `field.max_length`, `answer.max_length` (limit z kontekstu przedmiotu: 120 albo 300) |
| „Return at most three non-empty examples of at most 120 characters” | wskazówka w `TOOL MODE` („1-3 short card examples”); schemat narzędzia: `maxItems`/`maxLength` ze stałych |
| „No commentary, no markdown — JSON only.” | usunięte bez odpowiednika (potok) |

### 1.2. `objectiveInstructions` (`providers/openai/lesson-pool-agent.ts`)

| Zdanie (skrót) | Dokąd |
|---|---|
| „TOOL MODE: ignore the instruction above to answer with JSON text … exactly that JSON shape (same fields, same nulls …)” | usunięte: prompt nie prosi już o JSON; zostaje „deliver exercises ONLY by calling submit_exercises, with objectiveId … in every exercise” |
| przykłady kart (ustalone albo 1–3 od modelu) | wskazówka (bez zmian) |
| zadanie, zagadnienie, karty, zdania kart, inne zagadnienia | wskazówka (bez zmian) |
| `Target`: etapy, wymagane typy, liczba w etapach, dodatek słuchowy, limit, „Vary sentences …” | wskazówka; dochodzi zdanie minimów publikacji ze stałych |
| `promptNotes` przedmiotu (szkoła: „Hint only for lesson_open_answer …”) | usunięte z portu i polityki; reguła `school.hint_open_answer_only` (`sanitize`, typy szkoły poza pytaniem otwartym; sanityzacja daje notę `[school.hint_open_answer_only] hint: removed: …`) |
| WORKFLOW: jedno wywołanie, poprawki, `remove_exercise`, decyzja przy innej odpowiedzi rozwiązującego | wskazówka; opis kontroli zastąpiony odwołaniem do RULES i formatu powodu `[rule id] field: what is wrong` z mapą `rules` |

### 1.3. Reguły egzekwowane z `typeRules`

| Przedmiot / typ | Zdanie | Dokąd |
|---|---|---|
| szkoła `lesson_cloze` | (bez zdań egzekwowanych) | dopisane „Write 2 to 4 short sentences” (z dawnych `fieldRules`) |
| rozdział `lesson_cloze` | „whole instructionPl … at most 120 characters” | reguła `field.max_length`; zostaje „fits its length limit” |
| rozdział `lesson_cloze` | „exactly one bank word fits each gap, never two gaps whose words could be swapped” | reguła `check.blind_solve` |
| rozdział `lesson_cloze` | „Gap words are content words of this objective, never only function words” | reguły `chapter.function_words_only`, `chapter.card_word_missing` |
| rozdział `lesson_cloze` | „A word of the bank appears nowhere else in the text …” | reguła `cloze.bank_outside_gap` |
| pozostałe zdania `typeRules` | semantyka typu | wskazówka (blok typu księgi) |

### 1.4. Reguły egzekwowane z `fieldRules`

| Przedmiot | Zdanie | Dokąd |
|---|---|---|
| szkoła | „answer … (maks. 300 znaków)” | reguła `answer.max_length` |
| szkoła | „questionType: definition\|…” | reguła `field.invalid` (enum w schemacie narzędzia) |
| szkoła | „requiredElements: 1-6 elementów {id: e1, …, text}” | reguły `school.open_required_fields`, `school.element_ids_unique`, `field.count` |
| szkoła | „familyId … (ta sama odpowiedź wzorcowa i te same elementy wymagane)” | reguły `school.family_answer_differs`, `school.family_elements_differ` |
| szkoła | „WAŻNE: … co najmniej 2 RÓŻNYCH pytań otwartych …” | zdanie minimów w `Target` i rezerwacja etapu samodzielnego |
| szkoła | „sourceRefs: 1-3 DOKŁADNYCH cytatów …, maks. 600 znaków; bez cytatu nie twórz ćwiczenia” | reguły `school.quote_*`, `field.count`; zostaje „najkrótszy fragment” |
| szkoła | „focus … jeden CIĄGŁY fragment” | reguła `focus.not_contiguous`; zostaje „1-3 kolejne słowa” |
| szkoła | `lesson_gap`: „ONE luką ___”, „maks. 3 słowa” | reguły `gap.marker_count`, `gap.answer_tokens` |
| szkoła | `lesson_choice`: „options 2-4 …, dokładnie jedna poprawna” | reguły `options.count`, `check.blind_solve` |
| szkoła | `lesson_match`/`lesson_group` (limity, „twórz tylko, gdy …”) | reguły par i grup; semantyka w `typeRules` |
| szkoła | `lesson_cloze` (limity, banki, zamiana luk, słowa poza lukami) | reguły `cloze.*`, `check.blind_solve`; semantyka w `typeRules` |
| szkoła | „Pytanie (prompt/stem) maks. 120 znaków” | reguła `field.max_length` |
| szkoła | `lesson_calculation` (metoda, kod liczy, „globalnie maks. 160”, minima, „nie przekraczaj … w tej partii”) | blok `lesson_calculation` promptu, `Target`; 160 i partia usunięte bez odpowiednika |
| gramatyka | „Never repeat the canonical answer or any accepted answer as the prompt stimulus” | reguła `grammar.translation_prompt_equals_answer` |
| gramatyka | „The gap answer must be a present simple form of that base verb” | reguła `grammar.gap_present_simple_form` (poza tematem `to_be`) |
| gramatyka | „Expanded contractions are NOT new acceptedAnswers variants …” | reguła `variants.duplicate` |
| gramatyka | `to_be`: hint „be”, forma zgodna z podmiotem, bez do/does, sama forma w luce, odpowiedź o „you” jako „I” | reguły `grammar.be_gap_hint`, `grammar.be_form_subject`, `grammar.be_no_do_does`, `grammar.be_answer_not_be_form`, `grammar.be_short_answer_you` (tylko w temacie `to_be`) |
| gramatyka | piktogram: forma be w bodźcu zgodna z obrazkiem, `visualSubject` tylko przy wyborze | reguły `grammar.visual_stem_be_form`, `visual.choice_only` |
| gramatyka | wybór ze słuchu: jedna luka `___`, dokładnie jedna poprawna, bez opcji równoważnych, bez apostrofu, sybilant po luce (przykłady i wyjątek Do/Does, watch/watches), bez `instructionPl`/`hint`/`visualSubject` | reguły `listen.gap_count`, `check.blind_solve`, `listen.options_equivalent`, `listen.option_apostrophe`, `english.listen_sibilant_merge` (opis jak sprawdzenie `differsByMergingS`: końcówka bez sylaby, przykłady, wyjątki watch/watches, dance/dances, do/does, say/says), `listen.instruction_not_allowed` (z pełnym opisem), `listen.hint_not_allowed`, `visual.choice_only` |
| rozdział | „For lesson_choice, lesson_gap, lesson_order and lesson_cloze the meaning stimulus lives in instructionPl …”, „Never use a bare instruction …” | reguła `chapter.instruction_stimulus` (opis wymienia cztery typy; `inEachTypeBlock` — w blokach tych typów, nie w ogólnych); przykłady polskich zdań zostają jako wskazówka |
| rozdział | „hint is always null” | reguła `chapter.hint_not_allowed` |
| rozdział | `lesson_choice`: „exactly one gap written as ___”, „all words of the chapter” | reguły `chapter.stem_single_gap`, `chapter.word_outside_material` |
| rozdział | wybór ze słuchu: bodziec to nagranie (bez polecenia, podpowiedzi, piktogramu), jedna luka, bez apostrofu i formy pełnej obok skrótu, sybilant | reguły `listen.*`, `english.listen_sibilant_merge`, `visual.choice_only` |
| rozdział | `lesson_gap`: „exactly one gap ___”, „at most 3 words” | reguły `gap.marker_count`, `gap.answer_tokens` |
| rozdział | „A gap or an option is always a content word …, never only function words” | reguła `chapter.function_words_only` |
| rozdział | `lesson_order`: „no two items with the same text” | reguła `chapter.order_items_distinct` |
| rozdział | `lesson_open_answer`: „(never null or empty)” polecenia, focus ciągły z przykładami | reguły `chapter.translation_instruction_required`, `focus.not_contiguous`; zostaje „the run … that holds the checked word” |
| rozdział | „Expanded contractions are NOT new acceptedAnswers variants” | reguła `variants.duplicate` |
| rozdział | „Answers and accepted answers have at most 120 characters” | reguła `answer.max_length` |
| rozdział | „fields questionType … sourceRefs are ALWAYS null” | reguła `exercise.v3_field_not_allowed` |

## 2. Asercje treści promptu w testach

Liczba asercji po poprawkach przeglądu (`grep -cE 'toContain|toMatch'`, także `toMatchObject` w tym samym wzorcu), przed (HEAD
`2ca25cf2`) → po:

| Plik | Przed | Po |
|---|---:|---:|
| `providers/openai/llm.test.ts` | 211 | 156 |
| `providers/openai/lesson-pool-agent.test.ts` | 53 | 55 |
| `providers/openai/lesson-pool-prompt.test.ts` (nowy) | 0 | 11 |
| `modules/materials/lessons/lesson-pool-agent.test.ts` | 25 | 29 |
| `modules/materials/lessons/lesson-pool-agent-tools.test.ts` | 18 | 24 |
| `domain/lessons/subjects/english-grammar/module.test.ts` | 28 | 32 |
| `domain/lessons/subjects/english-chapter/module.test.ts` | 53 | 55 |
| `domain/lessons/subjects/school/module.test.ts` | 11 | 13 |
| `providers/fake-lesson-agent.test.ts` | 1 | 1 |
| `providers/lesson-agent-env.test.ts` | 2 | 2 |
| `tests/probes/probe-submissions.test.ts` | 1 | 1 |
| **razem** | **403** | **379** |

Nowy `lesson-pool-prompt.test.ts` sprawdza w pętli każdą regułę księgi trzech przedmiotów (po id i
opisie), więc liczba wierszy asercji zaniża pokrycie. Usunięte albo zmienione asercje (108 wierszy):

| Asercja (przed) | Po |
|---|---|
| rozdział `fieldRules` „hint is always null” | `ruleText("chapter.hint_not_allowed")` zawiera „Leave hint out”; `fieldRules` go nie zawiera |
| rozdział „exactly one gap written as ___” | `ruleText("chapter.stem_single_gap")` „exactly one gap” |
| rozdział „focus is ONE contiguous run …”, „never ['wearing', 'green']” | `fieldRules` „focus is the run of the answer's words that holds the checked word …”; ciągłość: reguła `focus.not_contiguous` (prompt-test) |
| rozdział „(4 to 7 items, no two items with the same text)” | „(4 to 7 items)” + `ruleText("chapter.order_items_distinct")` |
| rozdział „sourceRefs are ALWAYS null” | `not.toContain`; reguła `exercise.v3_field_not_allowed` w księdze (prompt-test) |
| rozdział `typeRules.lesson_cloze` „appears nowhere else in the text” | `not.toContain`; reguła `cloze.bank_outside_gap` (prompt-test) |
| rozdział „never only function words (…)” | `ruleText("chapter.function_words_only")` „not only function words” |
| rozdział „For lesson_choice, … the meaning stimulus lives in instructionPl” | `ruleText("chapter.instruction_stimulus")` |
| rozdział `lesson_cloze` „at most 120 characters in total” | „fits its length limit” (liczba w `field.max_length`) |
| rozdział `lesson_cloze` „never two gaps whose words could be swapped” | usunięte: jedno rozwiązanie opisuje `check.blind_solve` (prompt-test) |
| rozdział słuch: `/exactly one gap/`, `/never start an option with an apostrophe/i`, `/instructionPl.*hint.*visualSubject/s` | `ruleText("listen.gap_count")`, `ruleText("listen.option_apostrophe")`, `ruleText("listen.instruction_not_allowed")`, `ruleText("listen.hint_not_allowed")`, `ruleText("visual.choice_only")` |
| rozdział słuch `/recording/` | usunięte: zdanie „The meaning stimulus is the recording” było uzasadnieniem reguł `listen.*` (ich opisy mówią „hears the sentence”) |
| rozdział słuch „each option is a word or phrase from the chapter material, as in lesson_choice” | „each a word or phrase from the chapter material, as in lesson_choice” |
| gramatyka `to_be` `/am, is or are matching the subject/`, `/never use do or does/`, `/only the form itself/` | `/gap answers are am, is or are/`, `/short answers repeat the form/`; `ruleText("grammar.be_form_subject")`, `("grammar.be_no_do_does")`, `("grammar.be_answer_not_be_form")`; bramka tematu `when` |
| gramatyka słuch `/exactly one gap/`, `/never offer an equivalent/i`, `/apostrophe/`, `/instructionPl.*hint.*visualSubject/s` | reguły `listen.gap_count`, `listen.options_equivalent`, `listen.option_apostrophe`, `listen.instruction_not_allowed`, `listen.hint_not_allowed` (`ruleText`) |
| gramatyka sybilant (3 asercje: regex, „This does not apply …”, „never He ___ snakes …”) | `ruleText("english.listen_sibilant_merge")` `/-s ending that adds no syllable.*right after the gap.*s, z or sh sound/s`, zawiera „watch/watches” i „do/does”; walidator przyjmuje „___ she play tennis?” z Do/Does i watch/watches; `fieldRules` bez „snakes” |
| szkoła `fieldRules` zawiera „lesson_cloze” | `typeRules.lesson_cloze` „2 to 4 short sentences close to the parent material”; `fieldRules` nie zawiera |
| adapter `promptNotes` (4 asercje NOTE-ONE/NOTE-TWO/„Hint only …”) | usunięte (pole usunięte); nowy test `objectiveInstructions`: księga reguł, TOOL MODE bez JSON, minima publikacji, format powodu; kierownik: wejście bez `promptNotes`, z księgą i minimami |
| „Return at most 2 exercises per objective in this batch”, „never exceed this batch …”, „Minima publikacji …”, „nie przekraczaj …” (szkoła) | `not.toContain` na liście zdań potoku (`llm.test.ts` i `lesson-pool-prompt.test.ts`); „Calculations never replace the publication minima in Target.” |
| „Publication minima apply to the complete pool …” | `Target` z minimami ze stałych (`lesson-pool-prompt.test.ts`, `lesson-pool-agent.test.ts`) |
| `not.toContain("Keep at least 3 guided, …")` | usunięte: zdanie nie istniało od PR 2 |
| „lesson_transform requires statement”, „lesson_short_answer requires prompt”, „lesson_choice requires stem” | reguły `transform.statement_required`, `short_answer.prompt_required`, `choice.stem_required` (prompt-test: id w wierszu „Record shape and card fields”) |
| „acceptedAnswers must NOT contain the canonical answer” | reguła `variants.duplicate` (prompt-test) |
| „a copy of the same words with expanded or contracted spellings … is not” | „acceptedAnswers lists other acceptable formulations of the answer” (wskazówka „Field meaning”) |
| „2 to 4 options”, „correctOption must be the id of exactly one of the options” | reguły `options.count`, `options.correct_unknown` (prompt-test) |
| „copy the whitespace-separated tokens …” | reguły `focus.not_contiguous`, `gap.focus` (prompt-test) |
| „EXACTLY ONE gap marker”, „its answer is at most 3 words” | reguły `gap.marker_count`, `gap.answer_tokens` (prompt-test) |
| „3-10 items …”, „one word copied exactly from the segments”, „1-15 word segments”, „must NOT already equal the answer” | reguły `order.items_count`/`order.items_join`, `notice.correct_not_segment`, `notice.segment_count`, `error_fix.same_as_answer` (prompt-test dla typów przedmiotu) |
| „Canonical answers must be UNIQUE …”, „expanded/contracted spelling … counts as the same” | reguła `lesson.duplicate_answer` (prompt-test gramatyki); zostaje „vary full-sentence answers” |
| deduplikacja `exercise` (3 asercje o bodźcu i operatorze) | reguła `lesson.duplicate_stimulus` (prompt-test szkoły i rozdziału); `llm.test.ts`: brak wskazówki o odpowiedziach w trybie `exercise` |
| „lesson_open_answer.prompt may be a translation source in the prompt language” | „except where field rules for this subject define a source stimulus in the prompt language” |
| `explanationPl` „one Polish sentence”, „120” | „a Polish sentence for a child of about 8”; `not.toContain("at most 120 characters")`; reguły `explanation.*` |
| słuch: „at most N exercises per objective in this batch” (3 asercje), „up to 2 extra … outside the stage split” (2) | „lesson_listen_choice exercises are extra, outside the stage split (Target gives their allowance)”; brak zdania partii; przycięcie 0–2 jako równość promptów |
| słuch: „lesson_listen_choice requires stem with exactly one ___”, „2 to 3 options”, „instructionPl, hint and visualSubject must be null …” | karta `lesson_listen_choice` i reguły `listen.*` (prompt-test gramatyki i rozdziału) |
| słuch: `not.toContain` „extra lesson_listen_choice”, „lesson_listen_choice requires stem”, „lesson_listen_choice” | `not.toContain("lesson_listen_choice")` bez dodatku (zostaje) |
| bloki par/grup/luk: struktura (pairs 3–5, groupItems 4–8, gapAnswers, groups 2–3, clozeText 2–4, „code computes the answer”, „strict branches”) — 11 asercji | karty `lesson_match`/`lesson_group`/`lesson_cloze` i reguły `match.*`, `group.*`, `cloze.*` (prompt-test); `llm.test.ts`: adapter nie składa bloków (`not.toContain("strict branch")`, „pairs (3 to 5 objects”) |
| bloki: „plus sourceRefs”, „extraWords and sourceRefs”, „sourceRefs is REQUIRED …” (z uziemieniem i bez) | reguły `school.quote_required`, `shape.source_refs` (prompt-test szkoły); `llm.test.ts`: `not.toContain("sourceRefs is REQUIRED")` |
| bloki: semantyka szkoły (8 asercji: „both taken from the parent material”, „Use it when …”, „Keep the sentences close …”, „concepts, names or numbers …”, „Distractors come from …”, „Skip it when …”) | `subjectRule` bloku typu w prompcie (prompt-test: każdy `subjectRule` w prompcie); treść `typeRules` szkoły bez zmian poza „Write 2 to 4 short sentences” |
| bloki: RULE-MATCH/RULE-GROUP/RULE-CLOZE i `not.toContain` szkolnej semantyki bez reguły typu (11 asercji) | `llm.test.ts`: adapter nie czyta `typeRules` (`not.toContain("RULE-MATCH.")`), blok księgi renderuje `subjectRule` („lesson_match — MATCH-CARD.\n  RULE-MATCH.”); renderer: `renderRuleBook` |
| „opisuje tylko typy dozwolone” (RULE-GROUP, lesson_group, lesson_cloze) | prompt-test: reguła typu niedozwolonego w zagadnieniu nie występuje; `rule-book.test.ts` (Task 8a) |
| `not.toContain("undefined")` | usunięte: renderer bez pustych sekcji (`renderRuleBook` — pusta księga = sam nagłówek) |
