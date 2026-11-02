import type { LessonExerciseType, LessonStage } from "./types";
import type { ProgressStatus } from "../types";
import { outsideStagePath, stageOf } from "./stages";
import type { LessonPolicy } from "./lesson-policy";

/**
 * Selektor zadań lekcji (design „Selektor zadań”). Czysta, deterministyczna
 * funkcja nad migawką stanu: pula, kolejność celów, postęp, historia sesji,
 * budżet i zegar przychodzą jako dane. Żadnego dostępu do bazy, SDK ani
 * `Date.now()` — porównania czasu wyłącznie przez `input.now`. Scheduler
 * słówek (`domain/scheduler.ts`) pozostaje nietknięty.
 *
 * Priorytety (design):
 *   1. cykl wsparcia,
 *   2. należne niezależne sprawdzenie na ćwiczeniu niewidzianym,
 *   3. okno sprawdzianu — etap samodzielny dla nieopanowanych,
 *      (3b. trener precyzji, 3c. slot ćwiczenia słuchowego — poza ścieżką etapów),
 *   4. kontynuacja celu w toku na jego etapie,
 *   5. wprowadzenie nowego celu (karty + notice),
 *   6. utrwalanie.
 *
 * Kontrakt budżetu ocenianego (`assessedRemaining`; księgowanie zużycia należy
 * do warstwy sesji, selektor tylko czyta):
 *   - `assessedRemaining <= 0` → `null` (koniec sesji; również karty nie wychodzą);
 *   - karta (`kind: "card"`) może wyjść przy `assessedRemaining >= 1` i NIE liczy
 *     się do budżetu;
 *   - `lesson_notice` oraz wszystkie ćwiczenia (`kind: "exercise"`) liczą się jako
 *     oceniane.
 *
 * Brak modelu-oceniającego (req 6.8): selektor PREFERUJE typy nieoceniane
 * modelowo (zamknięte, `lesson_gap`), ale ich nie wyklucza — gdy dla
 * wybranego celu/etapu brak alternatywy, typ otwarty jest wydawany mimo to
 * (ocena wyjdzie `unevaluated` bez kary). Selektor nigdy nie zwraca `null`,
 * dopóki jest budżet i jakiekolwiek wydawalne ćwiczenie.
 */

/** Ćwiczenie z przypiętej puli (stabilna kolejność w `exercises`). */
export interface LessonExerciseCandidate {
  readonly itemId: string;
  readonly itemRevisionId: string;
  readonly objectiveId: string;
  readonly exerciseType: LessonExerciseType;
  readonly targetKey: string;
  /** Rodzina pytań (odpowiedź otwarta i powiązane słowa kluczowe przedmiotu szkolnego). */
  readonly familyId?: string;
  /** Oczekiwana forma odpowiedzi otwartej (`one_sentence`, `short`, …). */
  readonly expectedForm?: string;
  /** Typ pytania otwartego (`comparison`, …) — reguła pomylonych pojęć (design §9.3). */
  readonly questionType?: string;
  /** Tekst pytania i elementów wymaganych (dopasowanie pomylonej pary do pytania porównawczego). */
  readonly searchText?: string;
  /**
   * `lesson_listen_choice`: czy nagranie zdania-bodźca jest gotowe (spec #198 §7.1).
   * Brak wartości = niegotowe — slot słuchowy pomija takiego kandydata.
   */
  readonly stimulusAudioReady?: boolean;
}

/** Ostatnia ocena odpowiedzi otwartej celu sprzed sesji (wiedza i precyzja; trener precyzji). */
export interface ObjectivePrecisionSnapshot {
  readonly knowledge: "correct" | "partial" | "incorrect";
  readonly precision: "concise" | "verbose" | "unfocused";
  /** Pomylone pojęcia z tej oceny (werdykt v3); brak = bez pomylenia. */
  readonly confusedConcepts?: readonly { readonly said: string; readonly meant: string }[];
}

/** Postęp jednego celu — podzbiór `ObjectiveProgress` czytany przez selektor. */
export interface ObjectiveProgressSnapshot {
  readonly status: ProgressStatus;
  readonly nextReviewAt: string | null;
}

/** Wynik oceny zadania w historii sesji. */
export type LessonSessionOutcome =
  | "correct"
  | "incorrect"
  | "dont_remember"
  | "unevaluated"
  | "skipped";

/** Rodzaj wydanego zadania w historii sesji. */
export type LessonSessionTaskKind = "exercise" | "card" | "support_card";

/** Jedno wydane zadanie bieżącej sesji (uporządkowane po `ordinal`). */
export interface LessonSessionTask {
  readonly ordinal: number;
  readonly itemId: string | null;
  readonly objectiveId: string;
  readonly exerciseType: LessonExerciseType;
  readonly kind: LessonSessionTaskKind;
  readonly outcome?: LessonSessionOutcome;
}

/** Wejście selektora — zwykłe dane, bez bazy. */
export interface LessonScheduleInput {
  readonly exercises: readonly LessonExerciseCandidate[];
  readonly objectiveOrder: readonly string[];
  readonly progress: Readonly<Record<string, ObjectiveProgressSnapshot>>;
  /** Stan sprzed sesji; brak pola oznacza sesję starej wersji. */
  readonly initialProgress?: Readonly<Record<string, ObjectiveProgressSnapshot>>;
  /** Cele z rzeczywistą trudnością w poprzednich sesjach. */
  readonly supportObjectives?: ReadonlySet<string>;
  /** Plan construction must not repeat an item merely to consume the budget. */
  readonly planningMode?: boolean;
  /** Due check already reserved for the objective in the frozen plan. */
  readonly reservedDueCheckObjectives?: ReadonlySet<string>;
  readonly exposedTargetKeys: ReadonlySet<string>;
  readonly sessionHistory: readonly LessonSessionTask[];
  readonly lastSeenAt: Readonly<Record<string, string>>;
  readonly cardCountByObjective: Readonly<Record<string, number>>;
  readonly assessedRemaining: number;
  readonly testWindowOpen: boolean;
  readonly graderAvailable: boolean;
  readonly graderCallsLeft: number;
  /** Ostatnia ocena odpowiedzi otwartej per cel z poprzednich sesji (bez zadań następczych). */
  readonly precisionHistory?: Readonly<Record<string, ObjectivePrecisionSnapshot>>;
  readonly policy: LessonPolicy;
  readonly now: string;
}

/** Powód wydania ćwiczenia (trafia do kontekstu zadania). */
export type LessonTaskReason =
  | "support"
  | "due_check"
  | "test_preparation"
  | "continue"
  | "introduce"
  | "reinforce"
  | "precision_practice"
  | "listen_practice";

/** Decyzja selektora: karta prezentacji/wsparcia albo konkretne ćwiczenie. */
export type LessonTaskPlan =
  | { readonly kind: "card"; readonly objectiveId: string; readonly cardPurpose: "intro" | "support" }
  | {
      readonly kind: "exercise";
      readonly itemId: string;
      readonly itemRevisionId: string;
      readonly objectiveId: string;
      readonly exerciseType: LessonExerciseType;
      readonly reason: LessonTaskReason;
      readonly independentCheck: boolean;
      /**
       * `lesson_keywords`: odpowiedź otwarta tej samej rodziny, którą plan wydaje
       * bezpośrednio po wyborze pojęć (para trenera precyzji, design 6.1).
       */
      readonly pairedWith?: { readonly itemId: string; readonly itemRevisionId: string };
    };

/** Typy wymagające modelu-oceniającego (otwarta/wytwórcza ocena). */
const GRADER_DEPENDENT_TYPES: ReadonlySet<LessonExerciseType> = new Set<LessonExerciseType>([
  "lesson_error_fix",
  "lesson_transform",
  "lesson_open_answer",
]);

/** Kolejność etapów ocenianych (karta/notice są poza tą ścieżką awansu). */
const STAGE_PROGRESSION: readonly LessonStage[] = ["guided", "productive", "independent"];

function noGraderAvailable(input: LessonScheduleInput): boolean {
  return !input.graderAvailable || input.graderCallsLeft === 0;
}

/** Czy typ można wydać przy braku modelu (zamknięte typy i luka przechodzą). */
function usableWithoutGrader(type: LessonExerciseType): boolean {
  return !GRADER_DEPENDENT_TYPES.has(type);
}

/** Czy ćwiczenie (po `itemId`) było już wydane w tej sesji. */
function itemIssuedThisSession(itemId: string, history: readonly LessonSessionTask[]): boolean {
  return history.some((t) => t.kind === "exercise" && t.itemId === itemId);
}

/** `target_key` ujawniony dziecku PRZED tą sesją (ze wszystkich kontekstów). */
function exposedBeforeSession(
  candidate: LessonExerciseCandidate,
  input: LessonScheduleInput,
): boolean {
  return input.exposedTargetKeys.has(candidate.targetKey);
}

/**
 * `target_key` ujawniony w TEJ sesji: dowolne ćwiczenie o tym samym
 * `itemId` ALBO o tym samym `targetKey` zostało już wydane. Klucz jest po
 * `targetKey`, nie tylko `itemId`, bo różne ćwiczenia mogą dzielić cel —
 * wydanie jednego ujawnia wzorzec dla pozostałych (fragile-collision fix).
 */
function targetIssuedThisSession(
  candidate: LessonExerciseCandidate,
  input: LessonScheduleInput,
): boolean {
  const itemIdsSharingTarget = new Set(
    input.exercises.filter((c) => c.targetKey === candidate.targetKey).map((c) => c.itemId),
  );
  return input.sessionHistory.some(
    (t) => t.kind === "exercise" && t.itemId !== null && itemIdsSharingTarget.has(t.itemId),
  );
}

/**
 * Czy ćwiczenie jest „niewidziane” dla niezależnego sprawdzenia: ani ujawnione
 * przed sesją (po `targetKey`), ani wydane w tej sesji (po `targetKey`/`itemId`).
 */
function isUnseenForCheck(
  candidate: LessonExerciseCandidate,
  input: LessonScheduleInput,
): boolean {
  return !exposedBeforeSession(candidate, input) && !targetIssuedThisSession(candidate, input);
}

/**
 * Czy ćwiczenie było już ujawnione dziecku (przed sesją lub w jej trakcie) —
 * do porządkowania „niewidziane przed widzianymi” w zwykłym wyborze.
 */
function isExposed(
  candidate: LessonExerciseCandidate,
  input: LessonScheduleInput,
): boolean {
  return exposedBeforeSession(candidate, input) || targetIssuedThisSession(candidate, input);
}

/**
 * Odtworzony stan jednego celu w bieżącej sesji z historii zadań.
 * `introduced` — wydano kartę, notice albo ćwiczenie oceniane tego celu.
 * `cardsSeen`/`noticeSeen` — ile kart i czy notice już wydano (wprowadzanie).
 * `stage` — bieżący etap ścieżki awansu (start `guided`).
 * `stageStreak` — kolejne `correct` na bieżącym etapie (zerowane błędem).
 * `supportCycles` — zużyte cykle wsparcia.
 */
interface ObjectiveSessionState {
  introduced: boolean;
  cardsSeen: number;
  noticeSeen: boolean;
  stage: LessonStage;
  stageStreak: number;
  supportCycles: number;
  supportPending: boolean;
}

function initialStage(objectiveId: string, input: LessonScheduleInput): LessonStage {
  const status = initialStatus(objectiveId, input);
  return status !== undefined && status !== "not_assessed" ? "productive" : "guided";
}

function initialStatus(objectiveId: string, input: LessonScheduleInput): ProgressStatus | undefined {
  if (input.initialProgress !== undefined) return input.initialProgress[objectiveId]?.status;
  // Kompatybilność aktywnych sesji sprzed snapshotu: pierwszy krok wprowadzenia
  // dowodzi, że cel był nowy. Produkt aktywny od początku nie wraca do guided.
  // Typy spoza ścieżki etapów (zadanie słuchowe, słowa kluczowe) nie świadczą o nowości celu.
  const first = input.sessionHistory
    .filter((t) => t.objectiveId === objectiveId && t.kind !== "support_card" && !outsideStagePath(t.exerciseType))
    .slice().sort((a, b) => a.ordinal - b.ordinal)[0];
  if (first && (first.kind === "card" || stageOf(first.exerciseType) === "intro" || stageOf(first.exerciseType) === "guided")) return "not_assessed";
  return input.progress[objectiveId]?.status;
}

function buildSessionState(
  objectiveId: string,
  input: LessonScheduleInput,
): ObjectiveSessionState {
  const state: ObjectiveSessionState = {
    introduced: false,
    cardsSeen: 0,
    noticeSeen: false,
    stage: initialStage(objectiveId, input),
    stageStreak: 0,
    supportCycles: 0,
    supportPending: input.supportObjectives?.has(objectiveId) ?? false,
  };

  const tasks = input.sessionHistory
    .filter((t) => t.objectiveId === objectiveId)
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal);

  for (const task of tasks) {
    if (task.kind === "card") {
      state.introduced = true;
      state.cardsSeen += 1;
      continue;
    }
    if (task.kind === "support_card") {
      state.introduced = true;
      state.supportCycles += 1;
      state.supportPending = false; // karta wydana → cykl ruszył, czeka ćwiczenie
      continue;
    }
    // kind === "exercise"
    if (outsideStagePath(task.exerciseType)) {
      // Poza ścieżką etapów: wynik neutralny dla etapu, serii i wsparcia (spec #198 §3.3).
      // Słowa kluczowe zachowują dotychczasowe oznaczenie celu jako wprowadzonego;
      // zadanie słuchowe wychodzi zawsze po zwykłym zadaniu celu, więc go nie potrzebuje.
      if (task.exerciseType === "lesson_keywords") state.introduced = true;
      continue;
    }
    state.introduced = true;
    if (task.exerciseType === "lesson_notice") {
      state.noticeSeen = true;
    }
    const stage = stageOf(task.exerciseType);
    if (stage === "intro") continue; // karta/notice nie wchodzą w ścieżkę awansu

    const outcome = task.outcome ?? "unevaluated";

    if (outcome === "correct") {
      if (stage === state.stage) {
        state.stageStreak += 1;
        if (state.stageStreak >= input.policy.advanceAfterCorrect) {
          state.stage = nextStage(state.stage);
          state.stageStreak = 0;
        }
      }
    } else if (outcome === "incorrect" || outcome === "dont_remember") {
      state.stageStreak = 0;
      // Błąd otwiera cykl wsparcia, o ile limit cykli na cel nie wyczerpany.
      state.supportPending = state.supportCycles < input.policy.supportCyclesPerObjectivePerSession;
    }
    // unevaluated/skipped neutralne — nie ruszają serii ani wsparcia.
  }

  return state;
}

function nextStage(stage: LessonStage): LessonStage {
  const index = STAGE_PROGRESSION.indexOf(stage);
  if (index < 0 || index === STAGE_PROGRESSION.length - 1) return stage;
  return STAGE_PROGRESSION[index + 1]!;
}

/** Czy cel został wprowadzony w bieżącej sesji (liczy się do limitu nowych). */
function isNewThisSession(objectiveId: string, input: LessonScheduleInput): boolean {
  const status = initialStatus(objectiveId, input);
  if (status !== undefined && status !== "not_assessed") return false;
  return input.sessionHistory.some((t) => t.objectiveId === objectiveId);
}

/**
 * Wybór ćwiczenia dla celu na danym etapie: niewidziane przed widzianymi,
 * potem najdawniej widziane (`lastSeenAt`), deterministyczny tie-break po
 * kolejności w `exercises`. Pomija ćwiczenia wydane już w tej sesji, jeśli
 * istnieje inne. `requireUnseen` wymusza ćwiczenie niewidziane dla sprawdzenia
 * (po `targetKey`). `respectGrader` PREFERUJE typy nieoceniane modelowo
 * (zamknięte, `lesson_gap`), ale ich nie wyklucza: gdy brak alternatywy, typ
 * zależny od modelu jest wydawany mimo wszystko (req 6.8 — ocena wyjdzie
 * `unevaluated` bez kary; selektor nigdy nie kończy sesji przy dostępnym
 * ćwiczeniu i budżecie).
 */
function pickExercise(
  objectiveId: string,
  stage: LessonStage,
  input: LessonScheduleInput,
  options: { requireUnseen?: boolean; respectGrader?: boolean; allowRepeat?: boolean } = {},
): LessonExerciseCandidate | null {
  const indexed = input.exercises.map((candidate, index) => ({ candidate, index }));

  // Typy spoza ścieżki etapów wydają wyłącznie ich własne priorytety: słowa
  // kluczowe — para trenera precyzji, zadanie słuchowe — slot słuchowy.
  const matching = indexed.filter(
    ({ candidate }) =>
      candidate.objectiveId === objectiveId && stageOf(candidate.exerciseType) === stage &&
      !outsideStagePath(candidate.exerciseType),
  );
  if (matching.length === 0) return null;

  const notRepeated = matching.filter(
    ({ candidate }) => !itemIssuedThisSession(candidate.itemId, input.sessionHistory),
  );
  if (input.planningMode && notRepeated.length === 0 && options.allowRepeat !== true) return null;
  const pool = notRepeated.length > 0 ? notRepeated : matching;

  const seenFilter = options.requireUnseen === true
    ? ({ candidate }: { candidate: LessonExerciseCandidate }) => isUnseenForCheck(candidate, input)
    : null;
  const seenPool = seenFilter ? pool.filter(seenFilter) : pool;
  if (options.requireUnseen === true && seenPool.length === 0) return null;

  // Preferuj typy nieoceniane modelowo, gdy grader niedostępny; ale jeśli to
  // odfiltrowuje wszystko, wróć do pełnej puli (preferencja, nie wykluczenie).
  const noGrader = options.respectGrader === true && noGraderAvailable(input);
  const closedFirst = noGrader
    ? seenPool.filter(({ candidate }) => usableWithoutGrader(candidate.exerciseType))
    : seenPool;
  const effective = closedFirst.length > 0 ? closedFirst : seenPool;

  // Kolejność preferencji obu ścieżek: pomylone pojęcia przed formą zwięzłą (design §9.3).
  const preferred = (entries: typeof effective) =>
    preferComparison(preferConciseForms(orderBySeen(entries, input), objectiveId, input), objectiveId, input)[0]?.candidate ?? null;
  if (options.requireUnseen === true) {
    return preferred(effective);
  }
  const unseen = effective.filter(({ candidate }) => !isExposed(candidate, input));
  return preferred(unseen.length > 0 ? unseen : effective);
}

/** Porównanie pojęć: NFC, bez wielkości liter, pojedyncze odstępy. */
function conceptKey(text: string): string {
  return text.normalize("NFC").toLocaleLowerCase("pl-PL").replace(/\s+/gu, " ").trim();
}

/**
 * Pomylone pojęcia (design §9.3, 6.4 pkt 4): gdy ostatnia ocena odpowiedzi
 * otwartej celu z poprzednich sesji wskazała pomylenie, preferuj pytania
 * porównawcze celu — najpierw te, których treść wymienia `said` albo `meant`.
 * Stabilny podział (reszta porządku zostaje); ma pierwszeństwo przed formami
 * zwięzłymi, bo stosowany jest na ich wyniku. Bez pytań porównawczych — bez zmian.
 */
function preferComparison<T extends { candidate: LessonExerciseCandidate }>(
  ordered: readonly T[],
  objectiveId: string,
  input: LessonScheduleInput,
): T[] {
  const pairs = input.precisionHistory?.[objectiveId]?.confusedConcepts ?? [];
  if (pairs.length === 0) return [...ordered];
  const terms = pairs.flatMap((pair) => [conceptKey(pair.said), conceptKey(pair.meant)]).filter((term) => term !== "");
  const comparison = (entry: T) => entry.candidate.exerciseType === "lesson_open_answer" && entry.candidate.questionType === "comparison";
  const mentions = (entry: T) => terms.some((term) => conceptKey(entry.candidate.searchText ?? "").includes(term));
  const rank = (entry: T) => (comparison(entry) ? (mentions(entry) ? 0 : 1) : 2);
  return ordered
    .map((entry, position) => ({ entry, position }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.position - b.position)
    .map(({ entry }) => entry);
}

const CONCISE_FORMS: ReadonlySet<string> = new Set(["one_sentence", "short"]);

/**
 * Trener precyzji (design 6.4, reguła 1): po poprawnej, lecz rozwlekłej
 * odpowiedzi otwartej celu preferuj pytania o formie zwięzłej (`one_sentence`,
 * `short`). Stabilny podział — reszta porządku (niewidziane, najdawniej
 * widziane) zostaje; bez takich pytań kolejność się nie zmienia.
 */
function preferConciseForms<T extends { candidate: LessonExerciseCandidate }>(
  ordered: readonly T[],
  objectiveId: string,
  input: LessonScheduleInput,
): T[] {
  const last = input.precisionHistory?.[objectiveId];
  if (!last || last.knowledge !== "correct" || last.precision === "concise") return [...ordered];
  const concise = (entry: T) => entry.candidate.exerciseType === "lesson_open_answer" && CONCISE_FORMS.has(entry.candidate.expectedForm ?? "");
  return [...ordered.filter(concise), ...ordered.filter((entry) => !concise(entry))];
}

/** Porządek: najdawniej widziane (brak wpisu = najstarszy), potem indeks puli. */
function orderBySeen(
  entries: readonly { candidate: LessonExerciseCandidate; index: number }[],
  input: LessonScheduleInput,
): { candidate: LessonExerciseCandidate; index: number }[] {
  return entries
    .slice()
    .sort((a, b) => {
      const sa = input.lastSeenAt[a.candidate.itemId] ?? "";
      const sb = input.lastSeenAt[b.candidate.itemId] ?? "";
      if (sa !== sb) return sa < sb ? -1 : 1;
      return a.index - b.index;
    });
}

/** Czy etap jest samodzielny (independent): open_answer albo typ produktywny jako sprawdzenie. */
function independentCheckFor(stage: LessonStage, type: LessonExerciseType): boolean {
  // guided nigdy nie jest independentCheck.
  if (stage === "guided") return false;
  return type !== "lesson_choice" && type !== "lesson_order" && type !== "lesson_short_answer";
}

function hasExercises(objectiveId: string, input: LessonScheduleInput): boolean {
  return input.exercises.some((c) => c.objectiveId === objectiveId);
}

function dueObjectives(input: LessonScheduleInput): string[] {
  return input.objectiveOrder.filter((id) => {
    const snapshot = input.progress[id];
    return (
      snapshot !== undefined &&
      snapshot.status !== "not_assessed" &&
      snapshot.nextReviewAt !== null &&
      snapshot.nextReviewAt <= input.now &&
      hasExercises(id, input)
    );
  });
}

/**
 * Trener precyzji (design 6.1 i 6.4, reguła 2): gdy ostatnia odpowiedź otwarta
 * celu była nie na temat albo niepełna, plan dokłada ćwiczenie „najpierw słowa
 * kluczowe”: wybór pojęć, a zaraz po nim odpowiedź otwarta tej samej rodziny
 * (wspomagana przez ekspozycję listy pojęć). Raz na cel w sesji, tylko w planie
 * (para to dwa sloty), przy graderze i budżecie na oba. Należne samodzielne
 * sprawdzenia plan rezerwuje wcześniej, więc para ich nie wypiera.
 */
function precisionPracticePlan(input: LessonScheduleInput): LessonTaskPlan | null {
  if (!input.planningMode || input.assessedRemaining < 2 || noGraderAvailable(input)) return null;
  for (const objectiveId of input.objectiveOrder) {
    const last = input.precisionHistory?.[objectiveId];
    if (!last || (last.precision !== "unfocused" && last.knowledge !== "partial")) continue;
    const practicedThisSession = input.sessionHistory.some((task) =>
      task.objectiveId === objectiveId && task.kind === "exercise" && task.exerciseType === "lesson_keywords");
    if (practicedThisSession) continue;
    for (const keywords of input.exercises) {
      if (keywords.exerciseType !== "lesson_keywords" || keywords.objectiveId !== objectiveId || !keywords.familyId) continue;
      const family = input.exercises
        .map((candidate, index) => ({ candidate, index }))
        .filter(({ candidate }) =>
          candidate.exerciseType === "lesson_open_answer" && candidate.objectiveId === objectiveId &&
          candidate.familyId === keywords.familyId && !itemIssuedThisSession(candidate.itemId, input.sessionHistory));
      const open = orderBySeen(family, input)[0]?.candidate;
      if (!open) continue;
      return { ...exercisePlan(keywords, "precision_practice", false), pairedWith: { itemId: open.itemId, itemRevisionId: open.itemRevisionId } };
    }
  }
  return null;
}

/** Najwyżej tyle zadań słuchowych w sesji — nie wypierają ćwiczeń produktywnych (spec #198 §3.2). */
const MAX_LISTEN_TASKS_PER_SESSION = 2;

/**
 * Slot ćwiczenia słuchowego (spec #198 §3.2): dodatkowe zadanie wyboru ze
 * słuchu, poza ścieżką etapów. Cel dostaje je najwyżej raz w sesji i dopiero
 * po swoim pierwszym zwykłym ocenianym zadaniu (wydanym lub zaplanowanym), więc
 * sesja nie zaczyna się serią zadań słuchowych — także dla celów kontynuowanych
 * i opanowanych. Sesja ma ich najwyżej `MAX_LISTEN_TASKS_PER_SESSION` i nigdy dwóch
 * z rzędu (ostatnie zadanie sesji nie może być słuchowe). Cel
 * czekający na cykl wsparcia nie dostaje slotu (wsparcie ma pierwszeństwo).
 * Kandydat wymaga gotowego nagrania (`stimulusAudioReady === true`). Działa
 * dynamicznie i w planie sesji (`planningMode`).
 */
function listenPracticePlan(input: LessonScheduleInput): LessonTaskPlan | null {
  if (input.assessedRemaining <= 0) return null;
  const isListen = (task: LessonSessionTask) => task.kind === "exercise" && task.exerciseType === "lesson_listen_choice";
  if (input.sessionHistory.filter(isListen).length >= MAX_LISTEN_TASKS_PER_SESSION) return null;
  // Bez dwóch zadań słuchowych z rzędu (np. po dwóch należnych sprawdzeniach na starcie planu).
  const last = input.sessionHistory.reduce<LessonSessionTask | undefined>(
    (latest, task) => (latest === undefined || task.ordinal > latest.ordinal ? task : latest), undefined);
  if (last !== undefined && isListen(last)) return null;
  for (const objectiveId of input.objectiveOrder) {
    if (!hasAssessedThisSession(objectiveId, input)) continue;
    if (input.sessionHistory.some((task) => task.objectiveId === objectiveId && isListen(task))) continue;
    if (buildSessionState(objectiveId, input).supportPending || awaitsSupportExercise(objectiveId, input)) continue;
    const candidates = input.exercises
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) =>
        candidate.exerciseType === "lesson_listen_choice" && candidate.objectiveId === objectiveId &&
        candidate.stimulusAudioReady === true && !itemIssuedThisSession(candidate.itemId, input.sessionHistory));
    const candidate = orderBySeen(candidates, input)[0]?.candidate;
    if (candidate) return exercisePlan(candidate, "listen_practice", false);
  }
  return null;
}

export function selectLessonTask(input: LessonScheduleInput): LessonTaskPlan | null {
  // Koniec sesji: brak puli albo wyczerpany budżet ocenianych (karty też nie).
  if (input.exercises.length === 0 || input.assessedRemaining <= 0) {
    return null;
  }

  const states = new Map<string, ObjectiveSessionState>();
  for (const id of input.objectiveOrder) {
    states.set(id, buildSessionState(id, input));
  }

  // A frozen plan must reserve qualifying due checks before historical support
  // can expose the same target through its card, example, or guided question.
  if (input.planningMode) {
    for (const id of dueObjectives(input)) {
      if (input.reservedDueCheckObjectives?.has(id)) continue;
      const candidate =
        pickExercise(id, "independent", input, { requireUnseen: true, respectGrader: true }) ??
        pickExercise(id, "productive", input, { requireUnseen: true, respectGrader: true });
      if (candidate) return exercisePlan(candidate, "due_check", true);
    }
  }

  // Priorytet 1: cykl wsparcia. Po błędzie (nie unevaluated/skipped) na celu,
  // jeśli limit cykli nie wyczerpany: karta support, potem ćwiczenie guided.
  for (const id of input.objectiveOrder) {
    const state = states.get(id)!;
    if (!state.supportPending) continue;
    // Karta support jeszcze nie wydana w tym cyklu? supportPending=true oznacza
    // właśnie „po błędzie, przed kartą”; po karcie supportPending=false, a
    // supportCycles rośnie → wydajemy guided jako dopełnienie cyklu.
    return { kind: "card", objectiveId: id, cardPurpose: "support" };
  }
  // Dopełnienie cyklu wsparcia: karta support wydana (support_card w historii),
  // ale ćwiczenie guided jeszcze nie — rozpoznaj po ostatnim support_card bez
  // następującego ćwiczenia.
  const supportFollow = pendingSupportExercise(input);
  if (supportFollow) return supportFollow;

  // Priorytet 2: należne niezależne sprawdzenie na ćwiczeniu niewidzianym.
  for (const id of input.planningMode ? [] : dueObjectives(input)) {
    // Sprawdzenie używa etapu samodzielnego, na ćwiczeniu niewidzianym.
    const candidate =
      pickExercise(id, "independent", input, { requireUnseen: true, respectGrader: true }) ??
      pickExercise(id, "productive", input, { requireUnseen: true, respectGrader: true });
    if (candidate) {
      return exercisePlan(candidate, "due_check", true);
    }
  }

  // Priorytet 3: okno sprawdzianu — etap samodzielny dla nieopanowanych celów.
  if (input.testWindowOpen) {
    for (const id of input.objectiveOrder) {
      if (!eligibleForTestWindow(id, input, states.get(id)!)) continue;
      const candidate =
        pickExercise(id, "independent", input, { respectGrader: true }) ??
        pickExercise(id, "productive", input, { respectGrader: true });
      if (candidate) {
        return exercisePlan(candidate, "test_preparation", independentCheckFor(stageOf(candidate.exerciseType), candidate.exerciseType));
      }
    }
  }

  // Priorytet 3b: trener precyzji — para „słowa kluczowe → odpowiedź otwarta”.
  const precisionPractice = precisionPracticePlan(input);
  if (precisionPractice) return precisionPractice;

  // Priorytet 3c: slot ćwiczenia słuchowego (poza ścieżką etapów).
  const listenPractice = listenPracticePlan(input);
  if (listenPractice) return listenPractice;

  // Priorytet 4: kontynuacja celu w toku na jego bieżącym etapie.
  for (const id of input.objectiveOrder) {
    const state = states.get(id)!;
    const fromPrior = isContinuedFromPriorSession(id, input);
    const continued = state.introduced || fromPrior;
    if (!continued) continue;
    // Jeśli cel jest w trakcie wprowadzania (karty/notice niedokończone), to
    // obsłuży priorytet 5; tutaj tylko gdy wprowadzanie zakończone.
    if (needsIntroductionSteps(id, input, state)) continue;
    // Nowy cel wprowadzany w tej sesji „kontynuuje” dopiero po pierwszym
    // ocenionym ćwiczeniu; pierwsze guided po kartach/notice należy do
    // wprowadzania (priorytet 5, `reason: introduce`).
    if (!fromPrior && !hasAssessedThisSession(id, input)) continue;
    if (input.planningMode) {
      const plannedAtStage = input.sessionHistory.filter((task) =>
        task.objectiveId === id && task.kind === "exercise" && !outsideStagePath(task.exerciseType) &&
        stageOf(task.exerciseType) === state.stage,
      ).length;
      // Do not expose every distinct productive answer before a later
      // confirmation can become due; only real outcomes may advance stages.
      if (plannedAtStage >= input.policy.advanceAfterCorrect) continue;
    }
    const candidate = pickExercise(id, state.stage, input, { respectGrader: true });
    if (candidate) {
      return exercisePlan(candidate, "continue", false);
    }
  }

  // Priorytet 5: wprowadzenie nowego celu (karty + notice), max N nowych/sesję.
  const newCount = input.objectiveOrder.filter((id) => isNewThisSession(id, input)).length;
  for (const id of input.objectiveOrder) {
    if (!hasExercises(id, input)) continue;
    const status = initialStatus(id, input);
    if (status !== undefined && status !== "not_assessed") continue; // nie „nowy”
    const state = states.get(id)!;
    const already = isNewThisSession(id, input);
    if (!already && newCount >= input.policy.maxNewObjectivesPerSession) continue;

    const cardsTotal = input.cardCountByObjective[id] ?? 0;
    if (state.cardsSeen < cardsTotal) {
      return { kind: "card", objectiveId: id, cardPurpose: "intro" };
    }
    const noticeCandidate = input.exercises.find(
      (c) => c.objectiveId === id && c.exerciseType === "lesson_notice",
    );
    if (noticeCandidate && !state.noticeSeen && !itemIssuedThisSession(noticeCandidate.itemId, input.sessionHistory)) {
      return exercisePlan(noticeCandidate, "introduce", false);
    }
    // Karty i notice wyczerpane → pierwsze ćwiczenie guided.
    const candidate = pickExercise(id, "guided", input, { respectGrader: true });
    if (candidate) {
      return exercisePlan(candidate, "introduce", false);
    }
  }

  // Priorytet 6: utrwalanie celów opanowanych (najdawniej ćwiczonych).
  const masteredOrdered = input.objectiveOrder
    .filter((id) => input.progress[id]?.status === "mastered" && hasExercises(id, input))
    .map((id) => ({ id, lastAt: objectiveLastSeen(id, input) }))
    .sort((a, b) => (a.lastAt < b.lastAt ? -1 : a.lastAt > b.lastAt ? 1 : 0));
  for (const { id } of masteredOrdered) {
    const candidate =
      pickExercise(id, "productive", input, { respectGrader: true }) ??
      pickExercise(id, "guided", input, { respectGrader: true }) ??
      pickExercise(id, "independent", input, { respectGrader: true });
    if (candidate) {
      return exercisePlan(candidate, "reinforce", false);
    }
  }

  return null;
}

/** Najdawniejsze `lastSeenAt` wśród ćwiczeń celu (brak = najstarszy ""). */
function objectiveLastSeen(objectiveId: string, input: LessonScheduleInput): string {
  const times = input.exercises
    .filter((c) => c.objectiveId === objectiveId)
    .map((c) => input.lastSeenAt[c.itemId] ?? "");
  return times.length === 0 ? "" : times.sort()[0]!;
}

/** Cel kontynuowany z wcześniejszej sesji (status ≠ not_assessed). */
function isContinuedFromPriorSession(objectiveId: string, input: LessonScheduleInput): boolean {
  const status = initialStatus(objectiveId, input);
  return status !== undefined && status !== "not_assessed";
}

/**
 * Czy w tej sesji wydano (lub zaplanowano) już zwykłe ocenione ćwiczenie tego
 * celu — poza intro i poza typami spoza ścieżki etapów.
 */
function hasAssessedThisSession(objectiveId: string, input: LessonScheduleInput): boolean {
  return input.sessionHistory.some(
    (t) =>
      t.objectiveId === objectiveId &&
      t.kind === "exercise" &&
      stageOf(t.exerciseType) !== "intro" &&
      !outsideStagePath(t.exerciseType),
  );
}

/**
 * Priorytet 3 (okno sprawdzianu): cel kwalifikuje się, gdy jest „w grze" i
 * jeszcze nieopanowany — czyli nie `mastered` ORAZ (wprowadzony w tej sesji
 * LUB kontynuowany z wcześniejszej sesji). Jeden predykat zamiast splotu flag.
 */
function eligibleForTestWindow(
  objectiveId: string,
  input: LessonScheduleInput,
  state: ObjectiveSessionState,
): boolean {
  if (input.progress[objectiveId]?.status === "mastered") return false;
  const inPlay = state.introduced || isContinuedFromPriorSession(objectiveId, input);
  return inPlay;
}

/**
 * Czy cel ma jeszcze niewykonane kroki wprowadzania (karty lub notice) w tej
 * sesji — tylko dla nowych celów (status not_assessed/brak). Cele kontynuowane
 * nie mają kroków wprowadzania (startują od productive bez kart).
 */
function needsIntroductionSteps(
  objectiveId: string,
  input: LessonScheduleInput,
  state: ObjectiveSessionState,
): boolean {
  const status = initialStatus(objectiveId, input);
  if (status !== undefined && status !== "not_assessed") return false;
  const cardsTotal = input.cardCountByObjective[objectiveId] ?? 0;
  if (state.cardsSeen < cardsTotal) return true;
  const notice = input.exercises.find(
    (c) => c.objectiveId === objectiveId && c.exerciseType === "lesson_notice",
  );
  return notice !== undefined && !state.noticeSeen;
}

/**
 * Dopełnienie cyklu wsparcia: ostatnie zadanie celu to `support_card`, więc
 * należy wydać jedno ćwiczenie guided (`reason: support`). Rozpoznajemy po
 * tym, że ostatni wpis celu w historii to support_card.
 */
function pendingSupportExercise(input: LessonScheduleInput): LessonTaskPlan | null {
  for (const id of input.objectiveOrder) {
    if (!awaitsSupportExercise(id, input)) continue;
    const candidate = pickExercise(id, "guided", input, { respectGrader: true });
    if (candidate) {
      return exercisePlan(candidate, "support", false);
    }
  }
  return null;
}

/** Czy ostatnim zadaniem celu w sesji jest karta wsparcia (czeka ćwiczenie cyklu). */
function awaitsSupportExercise(objectiveId: string, input: LessonScheduleInput): boolean {
  const tasks = input.sessionHistory
    .filter((t) => t.objectiveId === objectiveId)
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal);
  return tasks[tasks.length - 1]?.kind === "support_card";
}

function exercisePlan(
  candidate: LessonExerciseCandidate,
  reason: LessonTaskReason,
  independentCheck: boolean,
): Extract<LessonTaskPlan, { kind: "exercise" }> {
  return {
    kind: "exercise",
    itemId: candidate.itemId,
    itemRevisionId: candidate.itemRevisionId,
    objectiveId: candidate.objectiveId,
    exerciseType: candidate.exerciseType,
    reason,
    independentCheck,
  };
}
