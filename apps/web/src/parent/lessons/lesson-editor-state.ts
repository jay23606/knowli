import type {
  CalculationSpec,
  LessonDraftDto,
  LessonExerciseInput,
  LessonExerciseTypeDto,
  LessonVoiceTone,
} from "@learning/contracts";

/**
 * Czysta logika stanu edytora lekcji (bez Reacta, bez API). Migawka formularza,
 * serializacja do PATCH (`toLessonDraftPatch`), porównanie zmian i grupowanie
 * ćwiczeń po celu i etapie dla przeglądu. Odpowiednik `deck-editor-state.ts`
 * dla słówek — testowany jednostkowo, reużywany przez `LessonEditor`.
 *
 * Mapa typ→etap jest powtórzona tutaj świadomie: pochodzi z domeny
 * (`domain/lessons/stages.ts`), ale panel web nie importuje z serwera. To
 * wyłącznie etykietowanie przeglądu — walidacja i pokrycie liczone są po
 * stronie API (zadanie 11).
 */

export type LessonStage = "intro" | "guided" | "productive" | "independent";

/** Etapy przeglądu w kolejności nauki (intro = prezentacja, reszta oceniana). */
export const LESSON_STAGES: readonly LessonStage[] = ["intro", "guided", "productive", "independent"];

const STAGE_BY_TYPE: Readonly<Record<LessonExerciseTypeDto, LessonStage>> = {
  lesson_card: "intro",
  lesson_notice: "intro",
  lesson_choice: "guided",
  lesson_order: "guided",
  lesson_short_answer: "guided",
  lesson_gap: "productive",
  lesson_error_fix: "productive",
  lesson_transform: "productive",
  lesson_open_answer: "independent",
  lesson_calculation: "independent",
  lesson_keywords: "guided",
  lesson_match: "guided",
  lesson_group: "guided",
  lesson_cloze: "guided",
  lesson_listen_choice: "guided",
};

/** Etap ćwiczenia danego typu (prezentacja przeglądu). */
export function stageOfExerciseType(type: LessonExerciseTypeDto): LessonStage {
  return STAGE_BY_TYPE[type];
}

type ExerciseOption = { id: string; text: string };
type ExerciseItem = { id: string; text: string };

/**
 * Edytowalne ćwiczenie: pola payloadu + `acceptedText`/`focusText` jako
 * stringi z przecinkami (jak słówka), by rodzic edytował je w jednym polu.
 * `clientKey` jest stabilny: id istniejącego ćwiczenia albo `local:<klucz>`.
 */
export interface EditableLessonExercise {
  clientKey: string;
  id?: string;
  exerciseType: LessonExerciseTypeDto;
  objectiveId: string;
  instructionPl: string;
  stem: string;
  statement: string;
  prompt: string;
  hint: string;
  transformId: string;
  answer: string;
  acceptedText: string;
  focusText: string;
  options: ExerciseOption[] | null;
  correctOption: string;
  items: ExerciseItem[] | null;
  noticeSegments: string[][] | null;
  visualSubject: string;
  /** Pola v3 przedmiotów szkolnych (null = ćwiczenie ich nie niesie). */
  questionType: string;
  requiredElements: { id: string; text: string }[] | null;
  supplementaryElements: string[] | null;
  commonErrors: string[] | null;
  expectedForm: string;
  familyId: string;
  calculation?: CalculationSpec;
  sourceRefs: { quote: string; parentAdded?: boolean }[] | null;
  /** `lesson_keywords`: pojęcia do wyboru i identyfikatory kluczowych (null = inny typ). */
  keywordOptions?: { id: string; text: string }[] | null;
  keyOptionIds?: string[] | null;
  /** `lesson_match`: pary i dystraktory po prawej (design szkoły §10.1). */
  pairs?: { left: string; right: string }[] | null;
  extraRight?: string[] | null;
  /** `lesson_group`: grupy i elementy z przynależnością (design szkoły §10.2). */
  groups?: { id: string; label: string }[] | null;
  groupItems?: { text: string; groupId: string }[] | null;
  /** `lesson_cloze`: tekst z lukami, słowa luk i słowa-pułapki (design szkoły §13.1). */
  clozeText?: string;
  gapAnswers?: string[] | null;
  extraWords?: string[] | null;
  /** Ton lektora nagrania pytania; brak = styl domyślny roli. Nagrania (`promptAudio`) są tylko do odczytu i nie wracają w patchu. */
  voiceTone?: LessonVoiceTone;
}

/** Karta zagadnienia tematu dynamicznego w edytorze; brak `voiceTone` = styl domyślny. */
export interface EditableDynamicCard {
  title: string;
  body: string;
  voiceTone?: LessonVoiceTone;
}

export interface EditableDynamicObjective {
  id: string;
  titlePl: string;
  cards: EditableDynamicCard[];
}

export interface EditableLessonForm {
  title: string;
  exercises: EditableLessonExercise[];
  /** Zagadnienia tematu dynamicznego (null = lekcja katalogowa). */
  dynamicObjectives: EditableDynamicObjective[] | null;
}

export interface LessonEditorSnapshot {
  versionId: string;
  editNumber: number;
  form: EditableLessonForm;
}

/** Patch wysyłany do `PATCH /lesson-drafts/:versionId` (kształt z zadania 11). */
export interface LessonDraftPatch {
  expectedEditNumber: number;
  title?: string;
  exercises?: LessonExerciseInput[];
  examples?: Record<string, string[]>;
  dynamicTopic?: { objectives: EditableDynamicObjective[] };
  /** Tylko `[]` (usunięcie tematów zdań); patrz `lessonThemesPatch`. */
  interests?: string[];
}

/** Następny wolny identyfikator elementu wymaganego (`e<n>`) — bez kolizji po usunięciach (W11). */
export function nextRequiredElementId(elements: readonly { id: string }[]): string {
  const used = new Set(elements.map((el) => el.id));
  let n = elements.reduce((max, el) => {
    const m = /^e(\d+)$/.exec(el.id);
    return m ? Math.max(max, Number.parseInt(m[1]!, 10)) : max;
  }, 0) + 1;
  while (used.has(`e${n}`)) n += 1;
  return `e${n}`;
}

function commaSplit(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function nonEmptyLines(lines: readonly string[]): string[] {
  return lines.map((line) => line.trim()).filter((line) => line.length > 0);
}

function editableFromExercise(
  exercise: LessonDraftDto["exercises"][number],
  newKey: () => string,
): EditableLessonExercise {
  return {
    clientKey: exercise.id ?? `local:${newKey()}`,
    ...(exercise.id ? { id: exercise.id } : {}),
    exerciseType: exercise.exerciseType,
    objectiveId: exercise.objectiveId,
    instructionPl: exercise.instructionPl ?? "",
    stem: exercise.stem ?? "",
    statement: exercise.statement ?? "",
    prompt: exercise.prompt ?? "",
    hint: exercise.hint ?? "",
    transformId: exercise.transformId ?? "",
    answer: exercise.answer,
    acceptedText: exercise.acceptedAnswers.join("\n"),
    focusText: exercise.focus.join(", "),
    options: exercise.options ? exercise.options.map((o) => ({ ...o })) : null,
    correctOption: exercise.correctOption ?? "",
    items: exercise.items ? exercise.items.map((o) => ({ ...o })) : null,
    noticeSegments: exercise.noticeSegments ? exercise.noticeSegments.map((s) => [...s]) : null,
    visualSubject: exercise.visualSubject ?? "",
    questionType: exercise.questionType ?? "",
    requiredElements: exercise.requiredElements ? exercise.requiredElements.map((el) => ({ ...el })) : null,
    supplementaryElements: exercise.supplementaryElements ? [...exercise.supplementaryElements] : null,
    commonErrors: exercise.commonErrors ? [...exercise.commonErrors] : null,
    expectedForm: exercise.expectedForm ?? "",
    familyId: exercise.familyId ?? "",
    ...(exercise.calculation ? { calculation: structuredClone(exercise.calculation) } : {}),
    sourceRefs: exercise.sourceRefs ? exercise.sourceRefs.map((ref) => ({ ...ref })) : null,
    ...(exercise.keywordOptions ? { keywordOptions: exercise.keywordOptions.map((o) => ({ ...o })) } : {}),
    ...(exercise.keyOptionIds ? { keyOptionIds: [...exercise.keyOptionIds] } : {}),
    ...(exercise.pairs ? { pairs: exercise.pairs.map((pair) => ({ ...pair })) } : {}),
    ...(exercise.extraRight ? { extraRight: [...exercise.extraRight] } : {}),
    ...(exercise.groups ? { groups: exercise.groups.map((group) => ({ ...group })) } : {}),
    ...(exercise.groupItems ? { groupItems: exercise.groupItems.map((item) => ({ ...item })) } : {}),
    ...(exercise.clozeText !== undefined ? { clozeText: exercise.clozeText } : {}),
    ...(exercise.gapAnswers ? { gapAnswers: [...exercise.gapAnswers] } : {}),
    ...(exercise.extraWords ? { extraWords: [...exercise.extraWords] } : {}),
    ...(exercise.voiceTone ? { voiceTone: exercise.voiceTone } : {}),
  };
}

function editableCard(card: EditableDynamicCard): EditableDynamicCard {
  return { title: card.title, body: card.body, ...(card.voiceTone ? { voiceTone: card.voiceTone } : {}) };
}

/** Luka w tekście `lesson_cloze`: ciąg 2+ podkreśleń (jak w domenie serwera i Kid UI). */
const CLOZE_GAP = /_{2,}/gu;

/** Liczba luk w tekście z lukami. */
export function clozeGapCountOf(text: string): number {
  return text.split(CLOZE_GAP).length - 1;
}

/** Liczba pól słów pokazywanych w edytorze: tyle, ile luk w tekście (najwyżej 4). */
export function clozeFieldCountOf(text: string): number {
  return Math.min(clozeGapCountOf(text), 4);
}

/**
 * Pola słów luk po zmianie tekstu: dopisuje puste, ale nie ucina wpisanych —
 * chwilowe usunięcie „___” w trakcie pisania nie kasuje słowa. Do payloadu
 * i odpowiedzi idą tylko pola widocznych luk (`clozeWordsOf`).
 */
export function syncGapAnswers(text: string, answers: readonly string[]): string[] {
  const count = clozeFieldCountOf(text);
  return answers.length >= count ? [...answers] : [...answers, ...Array.from({ length: count - answers.length }, () => "")];
}

/** Słowa widocznych luk w kolejności tekstu. */
export function clozeWordsOf(exercise: Pick<EditableLessonExercise, "clozeText" | "gapAnswers">): string[] {
  return (exercise.gapAnswers ?? []).slice(0, clozeFieldCountOf(exercise.clozeText ?? ""));
}

/** Odpowiedź `lesson_cloze` liczona ze słów luk (jak w domenie serwera): złączone „, ”. */
export function clozeAnswerOf(exercise: Pick<EditableLessonExercise, "clozeText" | "gapAnswers">): string {
  return clozeWordsOf(exercise).map((word) => word.trim()).join(", ");
}

/** Podgląd rodzica: tekst ze słowami w lukach (puste słowo zostawia „___”). */
export function filledClozeOf(text: string, answers: readonly string[]): string {
  return text.split(CLOZE_GAP).reduce((filled, part, index) => (index === 0 ? part : `${filled}${answers[index - 1]?.trim() || "___"}${part}`), "");
}

/** Odpowiedź `lesson_match` liczona z par (jak w domenie serwera): lewe strony złączone „, ”. */
export function matchAnswerOf(exercise: Pick<EditableLessonExercise, "pairs">): string {
  return (exercise.pairs ?? []).map((pair) => pair.left).join(", ");
}

/** Odpowiedź `lesson_group` liczona z grup: etykiety złączone „ / ”. */
export function groupAnswerOf(exercise: Pick<EditableLessonExercise, "groups">): string {
  return (exercise.groups ?? []).map((group) => group.label).join(" / ");
}

/** Następny wolny identyfikator grupy (`g<n>`), bez kolizji po usunięciach. */
export function nextGroupId(groups: readonly { id: string }[]): string {
  const used = new Set(groups.map((group) => group.id));
  let n = 1;
  while (used.has(`g${n}`)) n += 1;
  return `g${n}`;
}

/** Odpowiedź `lesson_keywords` liczona z zaznaczonych pojęć (jak w domenie serwera). */
export function keywordsAnswerOf(exercise: Pick<EditableLessonExercise, "keywordOptions" | "keyOptionIds">): string {
  const textById = new Map((exercise.keywordOptions ?? []).map((o) => [o.id, o.text] as const));
  return (exercise.keyOptionIds ?? []).map((id) => textById.get(id) ?? "").join(", ");
}

/** Migawka formularza z `LessonDraftDto` (szkic lub opublikowana do wglądu). */
export function createLessonSnapshot(
  draft: LessonDraftDto,
  newKey: () => string,
): LessonEditorSnapshot {
  return {
    versionId: draft.id,
    editNumber: draft.editNumber,
    form: {
      title: draft.title,
      exercises: draft.exercises.map((exercise) => editableFromExercise(exercise, newKey)),
      dynamicObjectives: draft.dynamicTopic
        ? draft.dynamicTopic.objectives.map((o) => ({ id: o.id, titlePl: o.titlePl, cards: o.cards.map(editableCard) }))
        : null,
    },
  };
}

/**
 * Typy, dla których dane pole payloadu jest znaczące. Serializacja wysyła pole
 * tylko dla jego typów — pusty string nie wycieka do payloadu i nie wywraca
 * `.strict()` kontraktu `LessonExerciseInputSchema`.
 */
const STEM_TYPES: ReadonlySet<LessonExerciseTypeDto> = new Set(["lesson_choice", "lesson_listen_choice", "lesson_short_answer", "lesson_gap"]);
// `lesson_transform` niesie zdanie do przekształcenia w `statement` (kanoniczne
// pole: kontrakt `kid.ts` lesson_transform ma `statement`, materialize czyta
// `payload.statement`). Serializacja musi wysyłać `statement`, nie `prompt`,
// inaczej PATCH gubi zdanie i materializacja daje pusty `statement`.
const STATEMENT_TYPES: ReadonlySet<LessonExerciseTypeDto> = new Set(["lesson_error_fix", "lesson_transform"]);
const PROMPT_TYPES: ReadonlySet<LessonExerciseTypeDto> = new Set(["lesson_open_answer", "lesson_short_answer", "lesson_calculation"]);
const OPTION_TYPES: ReadonlySet<LessonExerciseTypeDto> = new Set(["lesson_choice", "lesson_listen_choice", "lesson_short_answer"]);
const ITEM_TYPES: ReadonlySet<LessonExerciseTypeDto> = new Set(["lesson_order"]);
const NOTICE_TYPES: ReadonlySet<LessonExerciseTypeDto> = new Set(["lesson_notice"]);

function exerciseToInput(exercise: EditableLessonExercise): LessonExerciseInput {
  const type = exercise.exerciseType;
  // „Posłuchaj i wybierz”: polecenie dla dziecka jest stałe (Kid UI), a podpowiedź i piktogram
  // tego typu nie dotyczą — nawet wpisane w stan edytora nie trafiają do payloadu.
  const trimmedInstruction = type === "lesson_listen_choice" ? "" : exercise.instructionPl.trim();
  const input: LessonExerciseInput = {
    ...(exercise.id ? { id: exercise.id } : {}),
    exerciseType: type,
    objectiveId: exercise.objectiveId,
    answer: exercise.answer,
    acceptedAnswers: exercise.acceptedText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    focus: commaSplit(exercise.focusText),
  };
  if (trimmedInstruction.length > 0) {
    input.instructionPl = trimmedInstruction;
  }
  // lesson_short_answer: edytor pokazuje jedno pole pytania (prompt z fallbackiem
  // na stem) — wysyłamy tylko jedno pole, żeby payload nie niósł dwóch wersji pytania (W13).
  const shortAnswerPromptWins = type === "lesson_short_answer" && exercise.prompt.length > 0;
  if (STEM_TYPES.has(type) && exercise.stem.length > 0 && !shortAnswerPromptWins) {
    input.stem = exercise.stem;
  }
  if (STATEMENT_TYPES.has(type) && exercise.statement.length > 0) {
    input.statement = exercise.statement;
  }
  if (PROMPT_TYPES.has(type) && exercise.prompt.length > 0) {
    input.prompt = exercise.prompt;
  }
  if (type === "lesson_gap" && exercise.hint.length > 0) {
    input.hint = exercise.hint;
  }
  if (type === "lesson_transform" && exercise.transformId.length > 0) {
    input.transformId = exercise.transformId;
  }
  if (OPTION_TYPES.has(type) && exercise.options) {
    input.options = exercise.options.map((o) => ({ ...o }));
    if (exercise.correctOption.length > 0) {
      input.correctOption = exercise.correctOption;
    }
  }
  if (type === "lesson_choice" && exercise.visualSubject.length > 0) {
    input.visualSubject = exercise.visualSubject as LessonExerciseInput["visualSubject"];
  }
  if (ITEM_TYPES.has(type) && exercise.items) {
    input.items = exercise.items.map((o) => ({ ...o }));
  }
  if (NOTICE_TYPES.has(type)) {
    if (exercise.noticeSegments) {
      input.noticeSegments = exercise.noticeSegments.map((s) => [...s]);
    }
    if (exercise.correctOption.length > 0) {
      input.correctOption = exercise.correctOption;
    }
  }
  if (exercise.questionType.length > 0) {
    input.questionType = exercise.questionType as LessonExerciseInput["questionType"];
  }
  if (exercise.requiredElements) {
    // Porzucony pusty wpis („Dodaj” bez wypełnienia) nie blokuje zapisu całości (W12).
    input.requiredElements = exercise.requiredElements.filter((el) => el.text.trim().length > 0).map((el) => ({ ...el }));
  }
  if (exercise.supplementaryElements) {
    // pole wielowierszowe trzyma surowe wiersze (spacje i pusty wiersz w trakcie pisania) — przycinamy przy poleceniu
    input.supplementaryElements = nonEmptyLines(exercise.supplementaryElements);
  }
  if (exercise.commonErrors) {
    input.commonErrors = nonEmptyLines(exercise.commonErrors);
  }
  if (exercise.expectedForm.length > 0) {
    input.expectedForm = exercise.expectedForm as LessonExerciseInput["expectedForm"];
  }
  if (exercise.familyId.length > 0) {
    input.familyId = exercise.familyId;
  }
  if (exercise.sourceRefs) {
    input.sourceRefs = exercise.sourceRefs.filter((ref) => ref.quote.trim().length > 0).map((ref) => ({ ...ref }));
  }
  if (exercise.calculation) input.calculation = structuredClone(exercise.calculation);
  if (exercise.voiceTone) input.voiceTone = exercise.voiceTone;
  if (type === "lesson_match") {
    // Odpowiedź, warianty i focus wynikają z par — rodzic ich nie wpisuje; puste wiersze nie blokują zapisu.
    input.pairs = (exercise.pairs ?? []).filter((pair) => pair.left.trim() || pair.right.trim()).map((pair) => ({ ...pair }));
    const extraRight = (exercise.extraRight ?? []).filter((text) => text.trim().length > 0);
    if (extraRight.length > 0) input.extraRight = extraRight;
    input.answer = matchAnswerOf({ pairs: input.pairs });
    input.acceptedAnswers = [];
    input.focus = [];
  }
  if (type === "lesson_group") {
    input.groups = (exercise.groups ?? []).map((group) => ({ ...group }));
    input.groupItems = (exercise.groupItems ?? []).filter((item) => item.text.trim().length > 0).map((item) => ({ ...item }));
    input.answer = groupAnswerOf(exercise);
    input.acceptedAnswers = [];
    input.focus = [];
  }
  if (type === "lesson_cloze") {
    // Odpowiedź wynika ze słów luk; puste pola słów-pułapek nie blokują zapisu.
    input.clozeText = exercise.clozeText ?? "";
    input.gapAnswers = clozeWordsOf(exercise).map((word) => word.trim());
    const extraWords = (exercise.extraWords ?? []).map((word) => word.trim()).filter((word) => word.length > 0);
    if (extraWords.length > 0) input.extraWords = extraWords;
    input.answer = clozeAnswerOf(exercise);
    input.acceptedAnswers = [];
    input.focus = [];
  }
  if (type === "lesson_keywords") {
    // Odpowiedź, warianty i focus wynikają z zaznaczonych pojęć — rodzic ich nie wpisuje.
    input.keywordOptions = (exercise.keywordOptions ?? []).map((o) => ({ ...o }));
    input.keyOptionIds = [...(exercise.keyOptionIds ?? [])];
    input.answer = keywordsAnswerOf(exercise);
    input.acceptedAnswers = [];
    input.focus = [];
  }
  return input;
}

/**
 * Ile ćwiczeń „Posłuchaj i wybierz” nie ma gotowego nagrania zdania (w tworzeniu, błąd
 * albo brak wpisu): takie ćwiczenie nie trafia do dziecka, dopóki nagranie nie jest gotowe.
 * Pole `sentenceAudio` ustawia serwer tylko dla tego typu i tylko do odczytu.
 */
export function missingListenAudioCount(exercises: readonly Pick<LessonDraftDto["exercises"][number], "exerciseType" | "sentenceAudio">[]): number {
  return exercises.filter((exercise) => exercise.exerciseType === "lesson_listen_choice" && exercise.sentenceAudio?.state !== "ready").length;
}

/**
 * Serializuje migawkę do PATCH: `expectedEditNumber` z MIGAWKI (nie z aktualnej
 * zdalnej wersji — optimistic locking), tytuł zawsze, i pełna lista ćwiczeń
 * (serwer nadpisuje całość). Istniejące ćwiczenia zachowują `id`; nowe mają go
 * pominięty, więc serwer tworzy learning_item.
 */
export function toLessonDraftPatch(snapshot: LessonEditorSnapshot): LessonDraftPatch {
  return {
    expectedEditNumber: snapshot.editNumber,
    title: snapshot.form.title.trim(),
    exercises: snapshot.form.exercises.map(exerciseToInput),
    ...(snapshot.form.dynamicObjectives
      ? { dynamicTopic: { objectives: snapshot.form.dynamicObjectives.map((o) => ({ id: o.id, titlePl: o.titlePl, cards: o.cards.filter((c) => c.title.trim().length > 0 || c.body.trim().length > 0).map(editableCard) })) } }
      : {}),
  };
}

/**
 * Tematy zdań (migawka z tworzenia lekcji) można w szkicu tylko usunąć. Pole
 * `interests` trafia do PATCH wyłącznie wtedy, gdy lokalny stan różni się od
 * tematów szkicu (po „Usuń tematy” → `[]`); zwykły zapis ćwiczeń go nie wysyła.
 */
export function lessonThemesPatch(
  draftInterests: readonly string[] | undefined,
  local: readonly string[] | null | undefined,
): string[] | undefined {
  if (!local) return undefined;
  const saved = draftInterests ?? [];
  if (local.length === saved.length && local.every((entry, index) => entry === saved[index])) return undefined;
  return [...local];
}

/** Czy edytowalne ćwiczenie różni się od swojej wersji bazowej (dowolne pole). */
export function lessonExerciseChanged(
  current: EditableLessonExercise,
  base: EditableLessonExercise,
): boolean {
  return JSON.stringify(exerciseToInput(current)) !== JSON.stringify(exerciseToInput(base));
}

export interface StageGroup {
  stage: LessonStage;
  exercises: EditableLessonExercise[];
}

export interface ObjectiveGroup {
  objectiveId: string;
  stages: StageGroup[];
}

/**
 * Grupuje ćwiczenia po celu (w kolejności `objectiveIds`) i po etapie (kolejność
 * `LESSON_STAGES`). Każdy etap jest obecny (także pusty), by przegląd pokazał
 * brakujące etapy. Ćwiczenia celu spoza listy trafiają na koniec pod własnym
 * nagłówkiem (nie powinno się zdarzyć, ale nie gubimy ich po cichu).
 */
export function groupExercisesByObjectiveAndStage(
  exercises: readonly EditableLessonExercise[],
  objectiveIds: readonly string[],
): ObjectiveGroup[] {
  const known = new Set(objectiveIds);
  const extra = exercises
    .map((ex) => ex.objectiveId)
    .filter((id) => !known.has(id));
  const order = [...objectiveIds, ...[...new Set(extra)]];
  return order.map((objectiveId) => ({
    objectiveId,
    stages: LESSON_STAGES.map((stage) => ({
      stage,
      exercises: exercises.filter(
        (ex) => ex.objectiveId === objectiveId && stageOfExerciseType(ex.exerciseType) === stage,
      ),
    })),
  }));
}

/** Liczba powodów odrzuceń pokazywanych rodzicowi pod licznikiem odrzuconych ćwiczeń. */
export const MAX_REJECTED_REASONS_SHOWN = 5;

/**
 * Najczęstsze powody odrzucenia ćwiczeń przy generowaniu (`rejectedReasons`
 * szkicu): malejąco po liczbie, przy remisie alfabetycznie (kolejność stabilna
 * między odświeżeniami), do `limit`. Zliczenia nie niosą danych dziecka.
 */
export function topRejectedReasons(
  reasons: Readonly<Record<string, number>> | undefined,
  limit: number = MAX_REJECTED_REASONS_SHOWN,
): { reason: string; count: number }[] {
  return Object.entries(reasons ?? {})
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, "pl"))
    .slice(0, limit);
}

/**
 * Odrzucenia, których nie wyjaśniają wypisane powody: `rejectedCount` liczy
 * wszystkie odrzucenia generowania (kształt, walidacja puli, duplikaty), a
 * `rejectedReasons` tylko sprawdzanie słów z materiału — do tego lista pokazuje
 * najwyżej kilka powodów. Nigdy ujemna.
 */
export function otherRejectedCount(rejectedCount: number, listed: readonly { count: number }[]): number {
  return Math.max(0, rejectedCount - listed.reduce((sum, { count }) => sum + count, 0));
}

/**
 * Wiersz raportu odrzuceń z szablonu komunikatu (`{reason}`, `{n}`). Jedno
 * przejście z funkcją podstawiającą: powód pochodzi z wyjścia modelu, więc
 * `$&`, `$$` ani `{n}` w jego treści nie mogą zmienić wyniku (podstawiany tekst
 * nie jest ponownie skanowany).
 */
export function formatRejectedReason(template: string, reason: string, count: number): string {
  return template.replace(/\{(reason|n)\}/gu, (_placeholder, name: string) => (name === "reason" ? reason : String(count)));
}

/** Applies an API preview only while it still describes this variant. No arithmetic in the client. */
export function applyCalculationPreview(exercise: EditableLessonExercise, requested: CalculationSpec, preview: { prompt: string; answer: string }): EditableLessonExercise {
  return JSON.stringify(exercise.calculation) === JSON.stringify(requested)
    ? { ...exercise, prompt: preview.prompt, answer: preview.answer }
    : exercise;
}

/** Stable groups scoped by objective; ordinary exercises remain separate. */
export function groupCalculationFamilies(exercises: readonly EditableLessonExercise[]): { key: string; familyId: string | null; exercises: EditableLessonExercise[] }[] {
  const groups = new Map<string, { key: string; familyId: string | null; exercises: EditableLessonExercise[] }>();
  for (const exercise of exercises) {
    const familyId = exercise.calculation?.templateFamilyId ?? null;
    const key = familyId ? JSON.stringify([exercise.objectiveId, familyId]) : exercise.clientKey;
    const group = groups.get(key) ?? { key, familyId, exercises: [] };
    group.exercises.push(exercise);
    groups.set(key, group);
  }
  return [...groups.values()];
}
