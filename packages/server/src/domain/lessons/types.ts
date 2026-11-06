import type { CalculationSpec, LessonVoiceTone } from "@learning/contracts";
import type { LessonRuleIssue, RuleCatalog } from "./rules/catalog";

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

/**
 * Zagadnienie widziane przez agenta puli: cele lekcji w kolejności nauki z
 * kartami i typami ćwiczeń przedmiotu (filtr `requiredTypes`). Typ żyje tutaj,
 * a nie w `agent/`, żeby `SubjectModule` nie tworzył cyklu typów z agentem.
 */
export interface AgentObjective {
  readonly id: string;
  readonly titlePl: string;
  readonly descriptionEn: string;
  /** Rodzaj zagadnienia (`words` | `frame`), gdy przedmiot go używa. */
  readonly kind?: DynamicObjectiveKind;
  readonly cards: readonly { readonly title: string; readonly body: string }[];
  readonly exerciseTypes: readonly LessonExerciseType[];
}

/** Zagadnienie surowego planu agenta (przed nadaniem pełnych identyfikatorów). */
export interface RawPlanObjective {
  slug: string;
  titlePl: string;
  descriptionEn: string;
  kind: DynamicObjectiveKind;
  cards: { title: string; body: string }[];
  examples: string[];
}

/**
 * Zastrzeżenie bramki ćwiczenia agenta: kod trafia do `Rejection.code`, a do
 * modelu powód z id reguły zgłoszenia (`formatRuleReason`).
 */
export interface AgentGateFinding {
  readonly code: string;
  readonly issue: LessonRuleIssue;
}

/**
 * Polityka przedmiotu dla agenta puli (`SubjectModule.agentPolicy`). Silnik
 * agenta nie zna identyfikatorów przedmiotów — dziedzinowe reguły przychodzą
 * wyłącznie tędy. Polityka jest obowiązkowa: rejestr odrzuca przedmiot bez niej.
 */
export interface SubjectAgentPolicy {
  /** Typy, które checker rozwiązuje „na ślepo” (bez klucza odpowiedzi). */
  readonly blindSolveTypes: readonly LessonExerciseType[];
  /** Typy, których warianty odpowiedzi sprawdza checker. */
  readonly variantCheckTypes: readonly LessonExerciseType[];
  /** Checker dostaje materiał lekcji (rozwiązanie wymaga materiału). */
  readonly checkerNeedsMaterial: boolean;
  readonly independentReserve: number;
  readonly slack: number;
  /** Typy, w których sędzia podpowiedzi ocenia niepusty `hint` (etap 2b). Brak = pusta lista. */
  readonly hintJudgeTypes?: readonly LessonExerciseType[];
  /** Typy sprawdzane kontrolą otwartą: rozwiązujący + grader (etap 2b). Brak = pusta lista. */
  readonly openAnswerCheckTypes?: readonly LessonExerciseType[];
  /**
   * Dopiski przedmiotu do opisów reguł silnika (spec katalogu reguł §2.1; po angielsku, dla
   * modelu): id reguły rdzenia albo lekcji → zdania doklejane do jej opisu (`describeRule`), np.
   * `lesson.leak` — jak zmienić ujawnione zdanie w tym przedmiocie. Klucz spoza katalogów silnika
   * odrzuca `validateSubject`.
   */
  readonly ruleNotes?: Partial<Record<string, string>>;
  /**
   * Przykłady typów przedmiotu dla zagadnienia (bez `objectiveId`): zastępują w księdze reguł przykład
   * karty typu (`TYPE_CARDS`), gdy ogólny przykład łamie reguły tematu albo celu (np. formy „to be”).
   * Brak typu w wyniku — przykład karty.
   */
  typeExamples?(at: { readonly topicId: string; readonly objectiveId: string }): TypeExamples | undefined;
  requiredTypes?(objective: AgentObjective): readonly (readonly LessonExerciseType[])[];
  /**
   * Oczyszczenie kandydata agenta przed kontrolami: `removed` — nazwy usuniętych pól,
   * `notes` — zgłoszenia reguł `sanitize` dla modelu (np. usunięta podpowiedź),
   * `quotesSnapped` — liczba cytatów zastąpionych dokładnym fragmentem materiału.
   */
  sanitize?(
    draft: LessonExerciseDraft,
    ctx: { readonly material: string },
  ): {
    draft: LessonExerciseDraft;
    removed: readonly string[];
    notes?: readonly LessonRuleIssue[];
    quotesSnapped?: number;
  };
  /** Kod trafia do `Rejection.code` (np. `card_word_missing`), powód do modelu. */
  exerciseGate?(
    draft: LessonExerciseDraft,
    objective: AgentObjective,
    ctx: { material: string },
  ): readonly AgentGateFinding[];
  objectiveGaps?(pool: readonly LessonExerciseDraft[], objective: AgentObjective, ctx: { material: string }): string[];
  /** Słowa i ramy do pokrycia przez plan (lista dla modelu planera). */
  planCoverage?(material: string): { readonly words: readonly string[]; readonly frames: readonly string[] };
  planGate?(plan: readonly RawPlanObjective[], material: string): string[];
}
/** Przykładowe rekordy agenta według typu (`SubjectAgentPolicy.typeExamples`). */
export type TypeExamples = Partial<Record<LessonExerciseType, Readonly<Record<string, unknown>>>>;

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
   * Semantyka pól ćwiczeń doklejana do promptu generacji (dziedzinowa, np. „hint =
   * bezokolicznik”) — wyłącznie wskazówki, których kod nie sprawdza; reguły
   * egzekwowane opisuje katalog reguł (spec katalogu reguł §3). Opcjonalne.
   */
  readonly fieldRules?: string;
  /**
   * Semantyka typu (wskazówki, których kod nie sprawdza): księga reguł dokłada ją
   * do bloku typu obok karty typu (pola, przykład) i reguł typu, więc znika z
   * promptu razem z typem niedozwolonym w zagadnieniu.
   */
  readonly typeRules?: Partial<Record<LessonExerciseType, string>>;
  /**
   * Reguły etapu zagadnień tematu dynamicznego (ile zagadnień, ich rodzaje,
   * treść kart) doklejane do promptu podziału materiału. Brak = ogólny opis.
   */
  readonly objectivesRules?: string;
  /**
   * Reguły generacji historyjki na koniec sesji (język, długość, formy reguł
   * tematu, pytania o treść) doklejane do promptu historyjki. Wymagane, gdy
   * `SubjectModule.lessonStory` jest włączone (pilnuje `validateSubject`).
   */
  readonly storyRules?: string;
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
/**
 * Pola ćwiczenia, z których przedmiot liczy tekst ekspozycji (`SubjectModule.exposureText`).
 * Wąski widok: pasuje i do szkicu (`LessonExerciseDraft`), i do payloadu zapisanej rewizji.
 */
export type LessonExposureSource = Pick<
  LessonExerciseDraft,
  "exerciseType" | "stem" | "answer" | "options" | "correctOption" | "clozeText" | "gapAnswers"
>;

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
  /** Wyjaśnienie błędu dla dziecka (jedno polskie zdanie, po przycięciu; spec 2026-11-01); tylko przy `exerciseExplanations`. */
  readonly explanationPl?: string;
}

/**
 * Kryteria v3 odpowiedzi otwartej szkoły w prywatnym kluczu zadania (z payloadu
 * rewizji): ten sam kształt dla oceny odpowiedzi dziecka i kontroli agenta puli.
 */
export interface SchoolCriteria {
  readonly requiredElements: readonly { readonly id: string; readonly text: string }[];
  readonly supplementaryElements: readonly string[];
  readonly commonErrors?: readonly string[];
  readonly expectedForm?: string;
  readonly sourceQuotes: readonly string[];
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
   * Czy sesje lekcji tego przedmiotu kończą się historyjką (krótki tekst w
   * języku odpowiedzi z pytaniami o treść). Włączenie wymaga niepustego
   * `prompts.storyRules`. Brak = `false`.
   */
  readonly lessonStory?: boolean;
  /**
   * Czy polecenie (`instructionPl`) niesie bodziec znaczenia: tożsamość ćwiczeń
   * `lesson_choice`, `lesson_gap` i `lesson_order` uwzględnia wtedy znormalizowane
   * polecenie, więc to samo zdanie z innym poleceniem to dwa ćwiczenia. Brak = `false`.
   */
  readonly instructionIsStimulus?: boolean;
  /**
   * Tekst, z którego liczony jest `target_key` ćwiczenia (ekspozycja). Brak =
   * `answer`. Wołany przy zapisie rewizji szkicu (generacja i edycja rodzica)
   * i przy ładowaniu rewizji do sesji (payload rewizji ma te same pola).
   */
  exposureText?(draft: LessonExposureSource): string;
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
   * Teksty z treści kart zagadnienia, które dziecko widzi jako gotowe
   * rozwiązania (np. zdania z przykładów kart rozdziału). Generator i reguła
   * twarda traktują je jak ujawnienia, więc ćwiczenia samodzielne nie mogą ich
   * powtarzać. Tylko generowanie; brak = karty nie ujawniają rozwiązań.
   */
  cardExposureTexts?(cards: readonly { readonly body: string }[]): string[];
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
    rejected: { exercise: LessonExerciseDraft; issues: readonly LessonRuleIssue[] }[];
  };
  /** Błędy specyficzne dla przedmiotu (pusta lista = poprawne). */
  validateExercise(ex: LessonExerciseDraft, topic: LessonTopic): readonly LessonRuleIssue[];
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
   * Wyjaśnienie błędu dla dziecka (`explanationPl` ćwiczenia): jedno polskie zdanie
   * pokazywane po błędnej odpowiedzi w treningu, z nagraniem `explanation_audio`.
   * Przedmiot bez flagi nie przyjmuje pola.
   */
  readonly exerciseExplanations: boolean;
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
    ctx: {
      readonly material: string;
      /**
       * Tylko przyjmowanie agenta: `familyId` pytań otwartych odrzuconych w bieżącym
       * wywołaniu (kaskada słów kluczowych). Edycja i publikacja rodzica go nie podają.
       */
      readonly rejectedFamilies?: ReadonlySet<string>;
    },
  ): ReadonlyMap<number, readonly LessonRuleIssue[]>;
  /** Polityka agenta puli — każdy przedmiot jest generowany agentem. */
  readonly agentPolicy: SubjectAgentPolicy;
  /**
   * Katalog reguł przedmiotu (spec katalogu reguł §2.2): reguły jego walidatorów,
   * haków puli i bramek. Id nie mogą kolidować z rdzeniem, lekcją ani innym
   * przedmiotem (wspólny obiekt wpisu, np. fragment angielski, jest dozwolony).
   */
  readonly rules: RuleCatalog;
}
