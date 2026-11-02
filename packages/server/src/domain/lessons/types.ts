import type { CalculationSpec, LessonVoiceTone } from "@learning/contracts";

/**
 * Typy silnika lekcji (design „Przedmiot i katalog”, „Typy ćwiczeń i etapy”).
 * Silnik jest niezależny od przedmiotu: nie zna angielskiego ani gramatyki.
 * Przedmiot to wtyczka (`SubjectModule`) za interfejsem (Strategy + Registry).
 * Domena nie importuje bazy, SDK ani zegara.
 */

/** Kod kategorii błędu; walidowany rejestrem przedmiotu (baza ∪ przedmiot ∪ temat). */
export type ErrorCategoryCode = string;

/** Kategoria błędu z polską etykietą dla rodzica i podpowiedzi dziecka. */
export interface ErrorCategory {
  readonly code: ErrorCategoryCode;
  readonly labelPl: string;
}

/** Typy ćwiczeń lekcji (design: typy `lesson_*`). */
/** Piktogram bodźca obrazkowego wyboru — kto/co jest na obrazku. */
export type LessonVisualSubject = "boy" | "girl" | "man" | "woman" | "group" | "dog";

export type LessonExerciseType =
  | "lesson_card"
  | "lesson_notice"
  | "lesson_choice"
  | "lesson_order"
  | "lesson_short_answer"
  | "lesson_gap"
  | "lesson_error_fix"
  | "lesson_transform"
  | "lesson_open_answer"
  | "lesson_calculation"
  | "lesson_keywords"
  | "lesson_match"
  | "lesson_group"
  | "lesson_cloze"
  | "lesson_listen_choice";

/** Etap nauki celu (design: tabela typów → etapy). */
export type LessonStage = "intro" | "guided" | "productive" | "independent";

/**
 * Cel nauki (reguła gramatyki / fakt). Każde ćwiczenie sprawdza dokładnie
 * jeden cel. `cards` to 2–4 karty po polsku; `{{examples}}` = przykłady z lekcji.
 * `hints` ma szablon podpowiedzi po polsku dla każdej kategorii celu.
 */
export interface LearningObjective {
  readonly id: string; // "english_grammar.present_simple.third_person_s"
  readonly titlePl: string; // „-s w 3. osobie”
  readonly descriptionEn: string; // opis dla promptów generacji i oceny
  readonly cards: readonly {
    readonly title: string;
    readonly body: string;
    /** Ton lektora nagrania karty; brak = styl domyślny roli (spec TTS §4.1). */
    readonly voiceTone?: LessonVoiceTone;
  }[];
  readonly errorCategories: readonly ErrorCategoryCode[];
  readonly hints: Readonly<Record<ErrorCategoryCode, string>>;
  readonly exerciseTypes: readonly LessonExerciseType[];
}

/**
 * Temat lekcji. `version` rośnie przy zmianie; stare wersje zostają w rejestrze.
 * `extraErrorCategories` i `transforms` są dostępne celom tematu.
 * `objectives` są w kolejności nauki.
 */
export interface LessonTopic {
  readonly id: string; // "present_simple"
  readonly version: number;
  readonly titlePl: string;
  readonly extraErrorCategories: readonly ErrorCategory[];
  readonly transforms: readonly { readonly id: string; readonly instructionPl: string }[];
  readonly objectives: readonly LearningObjective[];
}

/** Rodzaj pytania otwartego przedmiotów szkolnych (payload v3). */
export type LessonQuestionType =
  | "definition"
  | "enumeration"
  | "cause"
  | "comparison"
  | "fact"
  | "process";

/** Oczekiwana forma odpowiedzi otwartej (payload v3). */
export type LessonExpectedForm = "short" | "one_sentence" | "explanation" | "list";

/**
 * Dane tematu dynamicznego: zagadnienia wyprowadzone z materiału rodzica,
 * zapisane w `lesson_context.dynamicTopic`. Identyfikatory celów są pełne
 * (`<subjectId>.d<deckId>.<slug>`), nadawane przez serwer przy generowaniu.
 */
export interface DynamicObjectiveData {
  readonly id: string;
  readonly titlePl: string;
  readonly descriptionEn: string;
  readonly cards: readonly {
    readonly title: string;
    readonly body: string;
    /** Ton lektora nagrania karty; brak = styl domyślny roli (spec TTS §4.1). */
    readonly voiceTone?: LessonVoiceTone;
  }[];
  /**
   * Rodzaj zagadnienia, gdy przedmiot dzieli materiał na różne rodzaje:
   * `words` — grupa słów, `frame` — rama zdaniowa. Przedmiot, który go nie
   * używa (np. szkolny), nie ustawia pola; brak = rodzaj domyślny przedmiotu.
   */
  readonly kind?: DynamicObjectiveKind;
}

/** Rodzaje zagadnienia tematu dynamicznego (opcjonalne, zależne od przedmiotu). */
export type DynamicObjectiveKind = "words" | "frame";

export interface DynamicTopicData {
  readonly titlePl: string;
  readonly objectives: readonly DynamicObjectiveData[];
}
/** Normalizator odpowiedzi przedmiotu. */
export interface AnswerNormalizer {
  /** Zbiór równoważnych sekwencji tokenów (np. rozwinięcia skrótów). */
  normalize(text: string): string[][];
}

/** Fragmenty promptów generacji i oceny specyficzne dla przedmiotu. */
export interface SubjectPromptProfile {
  readonly generationRole: string; // opis roli autora ćwiczeń dla tego przedmiotu
  readonly gradingRole: string; // co ocenia model (zastosowanie celu, nie styl)
  readonly almostDefinition: string; // kiedy werdykt „almost”
  /**
   * Reguły semantyki pól ćwiczeń doklejane do promptu generacji po ogólnym
   * opisie pól przez adapter (dziedzinowe, np. „hint = bezokolicznik”).
   * Opcjonalne: przedmiot bez reguł pól pomija pole.
   */
  readonly fieldRules?: string;
  /**
   * Semantyka typów z własną ścisłą gałęzią schematu puli (pary, grupy, luki):
   * adapter składa blok z części strukturalnej (pola, limity) i tego opisu.
   * Brak reguły typu = sama część strukturalna.
   */
  readonly typeRules?: Partial<Record<"lesson_match" | "lesson_group" | "lesson_cloze", string>>;
  /**
   * Reguły etapu zagadnień tematu dynamicznego (ile zagadnień, ich rodzaje,
   * treść kart) doklejane do promptu podziału materiału. Brak = ogólny opis.
   */
  readonly objectivesRules?: string;
  /**
   * Reguła użycia tematów zdań z zainteresowań dziecka (#197), dokładana do promptu
   * systemowego. Obecność pola = przedmiot przyjmuje tematy; same tematy to dane
   * rodzica i idą do wiadomości użytkownika, nigdy do tej reguły.
   */
  readonly interestsRule?: string;
}

/**
 * Minimalny szkic ćwiczenia potrzebny w sygnaturze `validateExercise`.
 * Pola payloadu z design „Data Models” → `item_revisions.payload` dla
 * `lesson_exercise`. Decyzja (opisana w raporcie): `answerLocale`/`promptLocale`
 * NIE należą do szkicu — wynikają z przedmiotu (`SubjectModule.answerLocale`
 * / `promptLocale`), a `validateExercise` jest już wywoływany w kontekście
 * przedmiotu, więc powielanie locale w szkicu byłoby redundancją (DRY/YAGNI).
 */
export interface LessonExerciseDraft {
  readonly exerciseType: LessonExerciseType;
  readonly objectiveId: string;
  readonly instructionPl?: string;
  readonly stem?: string;
  readonly statement?: string;
  readonly prompt?: string;
  readonly hint?: string;
  readonly transformId?: string;
  /**
   * `lesson_notice` (design „Typy ćwiczeń i etapy”): 2–3 zdania, każde jako lista
   * segmentów-słów (`string`), każdy segment niepusty i ≤ limitu długości tekstu.
   * Dziecko wskazuje jedno słowo — `correctOption` jest równe (po normalizatorze
   * przedmiotu, w dowolnym wariancie) któremuś segmentowi. `options` nie dotyczy
   * tego typu (wybór wskazaniem, nie z listy opcji).
   */
  readonly noticeSegments?: readonly (readonly string[])[];
  /** Piktogram bodźca obrazkowego (`lesson_choice`); wartości z kontraktu lekcji. */
  readonly visualSubject?: LessonVisualSubject;
  readonly answer: string;
  readonly acceptedAnswers: readonly string[];
  readonly focus: readonly string[];
  readonly options?: readonly { readonly id: string; readonly text: string }[];
  readonly correctOption?: string;
  readonly items?: readonly { readonly id: string; readonly text: string }[];
  /** Pola payloadu v3 (przedmioty szkolne) — opcjonalne dla pozostałych. */
  readonly questionType?: LessonQuestionType;
  readonly requiredElements?: readonly { readonly id: string; readonly text: string }[];
  readonly supplementaryElements?: readonly string[];
  readonly commonErrors?: readonly string[];
  readonly expectedForm?: LessonExpectedForm;
  readonly familyId?: string;
  readonly sourceRefs?: readonly { readonly quote: string; readonly parentAdded?: boolean }[];
  readonly calculation?: CalculationSpec;
  /** `lesson_keywords` (trener precyzji): pojęcia do wyboru i identyfikatory kluczowych. */
  readonly keywordOptions?: readonly { readonly id: string; readonly text: string }[];
  readonly keyOptionIds?: readonly string[];
  /** `lesson_match` (design szkoły §10.1): pary w kolejności materiału i dystraktory po prawej. */
  readonly pairs?: readonly { readonly left: string; readonly right: string }[];
  readonly extraRight?: readonly string[];
  /** `lesson_group` (design szkoły §10.2): grupy i elementy z przynależnością. */
  readonly groups?: readonly { readonly id: string; readonly label: string }[];
  readonly groupItems?: readonly { readonly text: string; readonly groupId: string }[];
  /** `lesson_cloze` (design szkoły §13.1): tekst z lukami, słowa luk i dystraktory banku. */
  readonly clozeText?: string;
  readonly gapAnswers?: readonly string[];
  readonly extraWords?: readonly string[];
  /** Ton lektora nagrania pytania; brak = styl domyślny roli (spec TTS §4.1). */
  readonly voiceTone?: LessonVoiceTone;
}

/**
 * Przedmiot jako wtyczka. Dostarcza katalog tematów i celów, dozwolone typy
 * ćwiczeń, normalizator odpowiedzi, kategorie błędów, profil promptów oraz
 * walidator specyficzny dla przedmiotu. Dodanie przedmiotu = nowy katalog
 * `subjects/<id>/` i jeden wpis w rejestrze.
 */
export interface SubjectModule {
  readonly id: string; // "english_grammar"
  readonly titlePl: string; // „Angielski — gramatyka”
  readonly answerLocale: string; // "en-GB" — język odpowiedzi dziecka
  readonly promptLocale: string; // "pl-PL" — język poleceń
  /**
   * Język pytania w `lesson_open_answer`, gdy przedmiot go zna (np. angielski
   * rozdział: bodziec jest po polsku, odpowiedź po angielsku). Brak = reguła
   * domyślna: pytanie dostaje język tylko, gdy `promptLocale` równa się
   * `answerLocale`.
   */
  readonly openAnswerPromptLocale?: string;
  readonly exerciseTypes: readonly LessonExerciseType[]; // typy wspierane przez przedmiot
  readonly errorCategories: readonly ErrorCategory[]; // kategorie przedmiotu (poza bazowymi)
  readonly normalizer: AnswerNormalizer;
  readonly topics: readonly LessonTopic[]; // wszystkie wersje tematów
  readonly prompts: SubjectPromptProfile;
  /** Czy przedmiot używa pól payloadu v3 (przedmioty szkolne); inne przedmioty ich nie przyjmują. */
  readonly usesV3Payload?: boolean;
  /** Minima pokrycia publikacji per cel; brak = DEFAULT_LESSON_POLICY. */
  readonly poolMinimums?: { readonly guided: number; readonly productive: number; readonly independent: number };
  /** Jak rozpoznawać duplikaty w puli; odpowiedzi pozostają osobną osią ekspozycji. */
  readonly poolDeduplication?: "answer" | "exercise";
  /**
   * Czy ćwiczenia muszą nieść cytaty źródłowe `sourceRefs` z materiału rodzica:
   * steruje `groundingRequired` w generacji i wymaganiem cytatów w gałęziach
   * schematu par, grup i luk. Brak = `false` (przedmiot bez cytatów).
   */
  readonly sourceQuotes?: boolean;
  /**
   * Skąd pochodzi tytuł przedmiotu zestawu z materiału: `parent` — rodzic
   * nazywa przedmiot własnym tytułem (np. szkolny), `fixed` — stały
   * `titlePl` przedmiotu. Brak = przedmiot nie tworzy zestawów z materiału.
   */
  readonly materialSubjectTitle?: "parent" | "fixed";
  /**
   * Czy polecenie (`instructionPl`) niesie bodziec znaczenia: tożsamość ćwiczeń
   * `lesson_choice`, `lesson_gap` i `lesson_order` uwzględnia wtedy znormalizowane
   * polecenie, więc to samo zdanie z innym poleceniem to dwa ćwiczenia. Brak = `false`.
   */
  readonly instructionIsStimulus?: boolean;
  /**
   * Tekst, z którego liczony jest `target_key` ćwiczenia (ekspozycja). Brak =
   * `answer`. Wołany przy zapisie rewizji szkicu (generacja i edycja rodzica).
   */
  exposureText?(draft: LessonExerciseDraft): string;
  /**
   * Normalizacja tekstu przed liczeniem `target_key` (np. bez końcowej
   * interpunkcji, z prostym apostrofem). Obowiązuje każdy tekst ekspozycji
   * lekcji przedmiotu — ćwiczenia (`exposureText`/`answer`) i przykłady kart —
   * więc ten sam tekst ma jeden klucz. Brak = tekst bez zmian (dotychczasowe
   * klucze). Zmiana istniejącej normalizacji zmienia zapisane klucze: wymaga
   * decyzji o migracji (kopie szkiców zachowują klucze zapisane wcześniej).
   */
  normalizeExposureText?(text: string): string;
  /**
   * Walidacja i czyszczenie WYŁĄCZNIE świeżo wygenerowanych ćwiczeń (wyjście
   * modelu, także dogenerowanie): odrzuca ćwiczenie z powodem albo zwraca je
   * w `kept` już bez pojedynczych wadliwych elementów (np. wariantów odpowiedzi).
   * Nie działa przy edycji rodzica ani publikacji — w odróżnieniu od
   * `validatePoolExtra`, która obowiązuje zawsze. Powody są zliczane dla rodzica.
   */
  refineGeneratedPool?(
    drafts: readonly LessonExerciseDraft[],
    ctx: { material: string },
  ): {
    kept: LessonExerciseDraft[];
    rejected: { exercise: LessonExerciseDraft; reason: string }[];
  };
  /** Błędy specyficzne dla przedmiotu (pusta lista = poprawne). */
  validateExercise(ex: LessonExerciseDraft, topic: LessonTopic): string[];
  readonly ttsForAnswers: boolean; // czy generować audio odpowiedzi kanonicznej
  /** „Posłuchaj pytania” (design szkoły §11): nagranie polecenia i pytania (`pl-PL`) przy przygotowaniu materiału. */
  readonly ttsForPrompts: boolean;
  /**
   * Odczyt pełnego, poprawnego zdania ćwiczenia po odpowiedzi dziecka (rola
   * `feedback_audio`): nagranie powstaje przy przygotowaniu materiału. Osobne
   * od `ttsForAnswers` (audio odpowiedzi przed odpowiedzią).
   */
  readonly ttsForFeedbackSentence: boolean;
  /**
   * Odpowiedź mówiona (dyktowanie do pola, design szkoły §5): język nagrania
   * i typy ćwiczeń, które ją przyjmują. Brak = przedmiot bez mikrofonu.
   */
  readonly spokenAnswers?: { readonly locale: string; readonly exerciseTypes: readonly LessonExerciseType[] };
  /**
   * Przedmiot z tematami dynamicznymi (zagadnienia z materiału rodzica):
   * składa `LessonTopic` z danych zapisanych w kontekście wersji. Brak =
   * przedmiot katalogowy.
   */
  buildDynamicTopic?(data: DynamicTopicData): LessonTopic;
  /**
   * Dodatkowa walidacja CAŁEJ puli z dostępem do materiału (np. uziemienie
   * cytatów, spójność rodzin pytań). Zwraca błędy per indeks ćwiczenia;
   * pusta mapa = poprawne. Wołana obok `validatePool`, nie zamiast niej.
   */
  validatePoolExtra?(
    drafts: readonly LessonExerciseDraft[],
    ctx: { material: string },
  ): ReadonlyMap<number, readonly string[]>;
}
