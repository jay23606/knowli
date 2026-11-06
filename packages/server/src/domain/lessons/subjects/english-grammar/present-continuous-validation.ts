import type { LessonExerciseDraft } from "../../types";
import { GAP_VERB_BRACKET } from "../../feedback-sentence-text";
import { normalizeTokens } from "../../normalize";
import { clip, type LessonRuleIssue } from "../../rules/catalog";
import {
  baseOfIngForm,
  COLLOCATION_ING_FORMS,
  ingFormOf,
  ingRuleOf,
  isCollocationIngForm,
  isIngFormInTable,
  stateVerbIn,
  type IngRule,
} from "../english/ing-forms";
import {
  BE_ADVERBS,
  BE_AFTER_SKIP,
  BE_CONTRACTED_TOKENS,
  BE_DETERMINERS,
  BE_FORM_BY_SUBJECT,
  BE_FORMS,
  BE_WH_WORDS,
  beAnswerPronounAllowed,
  bePronounNearGap,
  beStemContext,
  BE_POLARITY_PL,
  bePolarityViolations,
  beSubjectTokensBefore,
  expectedBeFormNearGap,
  looksPlural,
  TRANSFORM_POLARITY,
  type BePolarity,
} from "./be-agreement";
import { isIngMisspellingOf, validateErrorFix, validateListenChoiceOptions, validateNotice, validateOrderMarkers, validateTransformShape } from "./present-continuous-exercise-rules";
import {
  CLAUSE_CONJUNCTIONS,
  gapContextTexts,
  ingBaseOf,
  isGapQuestion,
  isNowUsuallyChoice,
  nowMarkerBareIssue,
  presentSimpleBaseOf,
  SENTENCE_BOUNDARY,
  TENSE_CHOICE_OBJECTIVES,
  TENSE_NAMES,
  tenseChoiceMarkerGroup,
  tenseChoiceShapeErrors,
  tenseSentences,
  tenseTokens,
  validatePresentSimpleFormAnswer,
  validatePresentSimpleGroup,
  validateTenseOfGroups,
  verbGroupsIn,
  type FieldMarkers,
  type PresentSimpleContext,
  type TenseSentence,
} from "./present-continuous-tense-choice";
import { grammarIssue } from "./rules";
import { scanTimeMarkers, type MarkerGroup } from "./time-markers";

/**
 * Reguły tematu Present Continuous (design „Present Continuous” §4–§6).
 * Czysta funkcja nad szkicem ćwiczenia: bez bazy, sieci i zegara. Zgłoszenia
 * reguł `grammar.pc_*` katalogu gramatyki (`rules.ts`): `pl`
 * po polsku dla rodzica, `found` po angielsku dla modelu agenta; sonda liczy
 * odrzucenia po id reguły.
 */

/** Klasy pisowni -ing dozwolone w sprawdzanym miejscu celu (§4). */
export const PC_ALLOWED_ING_RULES: Readonly<Record<string, readonly IngRule[]>> = {
  affirmative: ["plain"],
  now_or_usually: ["plain"],
  negative: ["plain"],
  questions: ["plain"],
  ing_spelling: ["drop_e", "double", "ie_to_y"],
  now_or_usually_more: ["plain", "drop_e", "double", "ie_to_y"],
};

/** Biegunowość formy be wymagana przez cel; przekształcenie ma pierwszeństwo (§6.2). */
export const PC_POLARITY: Readonly<Record<string, BePolarity>> = {
  affirmative: "affirmative",
  now_or_usually: "affirmative",
  negative: "negative",
  questions: "any",
  ing_spelling: "affirmative",
  now_or_usually_more: "any",
};

/**
 * Cele 1, 3, 4, 5: każdy klucz jest w Present Continuous (luka z czasownikiem
 * → am/is/are [not] + -ing, całe zdania z formą be + -ing), wskaźnik „zwykle”
 * odrzuca ćwiczenie, a tam, gdzie Present Simple też by pasował, potrzebny jest
 * wskaźnik „teraz”. Cele porównania (2, 6) obsługuje `validateTenseChoice`.
 */
export const PC_FORM_OBJECTIVES: ReadonlySet<string> = new Set(["affirmative", "negative", "questions", "ing_spelling"]);

/** Cele z luką na samą formę be („___ she reading?”, §6.2). */
export const BE_GAP_OBJECTIVES: ReadonlySet<string> = new Set(["affirmative", "negative", "questions"]);

/** Cele, w których nawias luki z czasownikiem musi zawierać „not” (§6.2); w pozostałych „not” jest zakazane. */
export const NEGATED_VERB_GAP_OBJECTIVES: ReadonlySet<string> = new Set(["negative", "now_or_usually_more"]);

const LEADING_APOSTROPHE = /^['’‘ʼ´`]/;

/**
 * Usuwa „(verb)” / „(not verb)” stojące tuż po luce (ten sam wzorzec co zdanie
 * po odpowiedzi w silniku, `GAP_VERB_BRACKET`). Zwraca bodziec z samą luką,
 * czasownik z nawiasu (małe litery, bez „not”) i flagę przeczenia. Nawias
 * w innym miejscu zdania zostaje w bodźcu.
 */
export function stripGapVerb(stem: string): { stem: string; verb?: string; negative: boolean } {
  const match = GAP_VERB_BRACKET.exec(stem);
  if (match === null) return { stem, negative: false };
  const tokens = normalizeTokens(match[2] ?? "");
  const negative = tokens[0] === "not";
  const verbTokens = negative ? tokens.slice(1) : tokens;
  const stripped = `${stem.slice(0, match.index)}___${stem.slice(match.index + match[0].length)}`;
  return verbTokens.length === 0 ? { stem: stripped, negative } : { stem: stripped, verb: verbTokens.join(" "), negative };
}

function objectiveOf(ex: LessonExerciseDraft): string {
  return ex.objectiveId.split(".").at(-1) ?? "";
}

/** Zgłoszenia biegunowości formy be tematu Present Continuous (cel albo przekształcenie, Yes/No). */
function checkBePolarity(
  polarity: BePolarity,
  negative: boolean,
  marker: string | undefined,
  field: string,
  answer: string,
  errors: LessonRuleIssue[],
): void {
  for (const violation of bePolarityViolations(polarity, negative, marker)) {
    const pl = `${field}: ${BE_POLARITY_PL[violation]}`;
    switch (violation) {
      case "yes_negative":
        errors.push(grammarIssue("grammar.pc_be_yes_negative", {
          field,
          pl,
          found: `${field} ${clip(answer)} is negated although the reply starts with "Yes"`,
        }));
        break;
      case "no_affirmative":
        errors.push(grammarIssue("grammar.pc_be_no_affirmative", {
          field,
          pl,
          found: `${field} ${clip(answer)} is not negated although the reply starts with "No"`,
        }));
        break;
      case "negated":
        errors.push(grammarIssue("grammar.pc_be_negated", {
          field,
          pl,
          found: `${field} ${clip(answer)} is negated, but the objective or transform requires an affirmative form`,
        }));
        break;
      case "not_negated":
        errors.push(grammarIssue("grammar.pc_be_missing_negation", {
          field,
          pl,
          found: `${field} ${clip(answer)} has no negation, but the objective or transform requires "not"`,
        }));
        break;
    }
  }
}

function polarityOf(ex: LessonExerciseDraft, objective: string): BePolarity {
  if (ex.transformId !== undefined && Object.hasOwn(TRANSFORM_POLARITY, ex.transformId)) return TRANSFORM_POLARITY[ex.transformId]!;
  return Object.hasOwn(PC_POLARITY, objective) ? PC_POLARITY[objective]! : "any";
}

function answersOf(ex: LessonExerciseDraft): { field: string; text: string }[] {
  return [
    { field: "answer", text: ex.answer },
    ...ex.acceptedAnswers.map((text) => ({ field: "acceptedAnswers", text })),
  ];
}

interface ScannedField {
  readonly field: string;
  readonly text: string;
  readonly lang: "en" | "pl";
  /** Polskie polecenie: słowa czasu przy poleceniu zadania nie są wskaźnikiem (`scanTimeMarkers`). */
  readonly instruction?: boolean;
}

/** Dopisuje niepuste pole tekstu do skanu wskaźników. */
function addField(fields: ScannedField[], field: string, text: string | undefined, lang: "en" | "pl"): void {
  if (text !== undefined && text.trim() !== "") fields.push({ field, text, lang, ...(field === "instructionPl" ? { instruction: true } : {}) });
}

/**
 * Pola skanowane na wskaźniki czasu (§5.2): angielskie teksty ćwiczenia,
 * polskie polecenie i prompt (dla tłumaczenia — polskie zdanie). Pomijane:
 * `explanationPl`, `hint`, karty.
 */
function scannedFields(ex: LessonExerciseDraft): ScannedField[] {
  const fields: ScannedField[] = [];
  const add = (field: string, text: string | undefined, lang: "en" | "pl"): void => addField(fields, field, text, lang);
  add("stem", ex.stem, "en");
  add("statement", ex.statement, "en");
  for (const { field, text } of answersOf(ex)) add(field, text, "en");
  for (const option of ex.options ?? []) add("options", option.text, "en");
  for (const segments of ex.noticeSegments ?? []) add("noticeSegments", segments.join(" "), "en");
  add("instructionPl", ex.instructionPl, "pl");
  add("prompt", ex.prompt, ex.exerciseType === "lesson_open_answer" ? "pl" : "en");
  return fields;
}

/** Wskaźniki czasu pola (`scanTimeMarkers`, polecenie bez słów czasu przy poleceniu zadania). */
function markersOf({ field, text, lang, instruction }: ScannedField): FieldMarkers & { readonly field: string } {
  const { groups, strongNow } = scanTimeMarkers(text, lang, { instruction: instruction === true });
  return { field, text, groups, strongNow };
}

/**
 * Wskaźniki w tym, co dziecko widzi przed odpowiedzią (fala 1 Task 19): bodziec, zdanie, prompt,
 * polecenie i zdania „Wskaż słowo”; klucz, warianty i pojedyncza opcja się nie liczą. W celach
 * porównania bodziec z luką liczy się tylko w częściach dotyczących luki (`gapContextTexts`). Opcje
 * liczą się razem, gdy każda ma wskaźnik tej samej grupy (wtedy dziecko widzi go w każdym wyborze).
 */
function seenMarkers(ex: LessonExerciseDraft, objective: string): (FieldMarkers & { readonly field: string })[] {
  const fields: ScannedField[] = [];
  const add = (field: string, text: string | undefined, lang: "en" | "pl"): void => addField(fields, field, text, lang);
  const stem = ex.stem;
  const gapContext = stem !== undefined && TENSE_CHOICE_OBJECTIVES.has(objective) && stem.includes("___");
  for (const text of gapContext ? gapContextTexts(stem) : [stem]) add("stem", text, "en");
  add("statement", ex.statement, "en");
  for (const segments of ex.noticeSegments ?? []) add("noticeSegments", segments.join(" "), "en");
  add("instructionPl", ex.instructionPl, "pl");
  add("prompt", ex.prompt, ex.exerciseType === "lesson_open_answer" ? "pl" : "en");
  const seen = fields.map(markersOf);
  const options = (ex.options ?? []).map((option) => markersOf({ field: "options", text: option.text, lang: "en" }));
  for (const group of ["now", "usually"] as const) {
    if (options.length > 0 && options.every((scan) => scan.groups.has(group))) {
      seen.push({
        field: "options",
        text: options.map((scan) => scan.text).join(" / "),
        groups: new Set([group]),
        strongNow: group === "now" && options.every((scan) => scan.strongNow),
      });
    }
  }
  return seen;
}

/**
 * Przeczenie w ćwiczeniu (standard „Środek”, 2026-11-06): nawias (not verb), zanegowany klucz,
 * wariant albo opcja, zanegowane zdanie z błędem albo zdanie wyjściowe przekształcenia.
 */
function isNegativeExercise(ex: LessonExerciseDraft): boolean {
  if (ex.exerciseType === "lesson_gap" && ex.stem !== undefined && stripGapVerb(ex.stem).negative) return true;
  return [ex.answer, ...ex.acceptedAnswers, ...(ex.options ?? []).map((option) => option.text), ex.statement ?? ""]
    .some((text) => tenseTokens(text).includes("not"));
}

/** Bodziec z luką wypełnioną odpowiedzią (bez nawiasu z czasownikiem) albo sama odpowiedź. */
function answerSentence(ex: LessonExerciseDraft, answer: string): string {
  const gapTypes = ex.exerciseType === "lesson_gap" || ex.exerciseType === "lesson_choice" || ex.exerciseType === "lesson_listen_choice";
  if (!gapTypes || ex.stem === undefined || !ex.stem.includes("___")) return answer;
  return stripGapVerb(ex.stem).stem.replace("___", answer);
}

/** Luka bez podpowiedzi (§6.2): checker agenta i kartkówka nie widzą `hint`, więc czasownik stoi w nawiasie. */
function validateGapHint(ex: LessonExerciseDraft, errors: LessonRuleIssue[]): void {
  if ((ex.hint?.trim() ?? "") !== "") {
    errors.push(grammarIssue("grammar.pc_gap_hint", {
      pl: "hint musi być pusty — czasownik stoi w nawiasie tuż po luce",
      found: `hint ${clip(ex.hint ?? "")} on a present continuous gap`,
    }));
  }
}

/** „going to” + miejsce, nie czasownik („Dad is going to work.” — do pracy). */
const GOING_TO_PLACES: ReadonlySet<string> = new Set(["work"]);

/** Czy tekst ma „going to” + formę podstawową czasownika (przyszłość „be going to”: „Ola is going to read”). */
function hasGoingToFuture(text: string): boolean {
  const tokens = normalizeTokens(text);
  return tokens.some((token, i) => {
    const verb = tokens[i + 2];
    if (token !== "going" || tokens[i + 1] !== "to" || verb === undefined || GOING_TO_PLACES.has(verb)) return false;
    return verb === "be" || presentSimpleBaseOf(verb) === verb;
  });
}

/**
 * Wskaźniki zakazane (przyszłość, dwuznaczność, §5.1) w każdym skanowanym polu
 * oraz przyszłość „be going to” + czasownik — także w zdaniu z odpowiedzią
 * wstawioną w lukę („He ___ (go) to play…” → „He is going to play…”).
 */
function validateForbiddenMarkers(ex: LessonExerciseDraft, errors: LessonRuleIssue[]): void {
  const fields = scannedFields(ex);
  for (const { field, text, lang } of fields) {
    const { forbidden } = scanTimeMarkers(text, lang);
    if (forbidden.length > 0) {
      errors.push(grammarIssue("grammar.pc_forbidden_marker", {
        field,
        pl: `${field}: wskaźnik czasu „${forbidden.join("”, „")}” jest zakazany w temacie (przyszłość albo dwuznaczność)`,
        found: `${field} ${clip(text)} uses the forbidden marker ${forbidden.map((marker) => clip(marker)).join(", ")}`,
      }));
    }
  }
  const englishTexts = [
    ...fields.filter(({ lang }) => lang === "en"),
    ...answersOf(ex).map(({ field, text }) => ({ field, text: answerSentence(ex, text) })),
  ];
  // Jedno zgłoszenie na pole (pierwszy tekst pola z „going to” + czasownik).
  const goingTo = new Map<string, string>();
  for (const { field, text } of englishTexts) {
    if (!goingTo.has(field) && hasGoingToFuture(text)) goingTo.set(field, text);
  }
  for (const [field, text] of goingTo) {
    errors.push(grammarIssue("grammar.pc_going_to_future", {
      field,
      pl: `${field}: „going to” + czasownik to przyszłość (be going to) — nie występuje w tym temacie`,
      found: `${field} ${clip(text)} uses going to + a verb (the future)`,
    }));
  }
}

/**
 * Cele 1, 3, 4, 5: czy ćwiczenie dopuszcza też odpowiedź w innym czasie bez
 * wskaźnika „teraz” — luka z czasownikiem, poprawianie błędu, przekształcenie
 * i wybór z opcjami innymi niż sama forma am/is/are („Ola ___ a book.”: is
 * reading / reads / read; w celu 5 — wybór z opcją w Present Simple). Luka na
 * formę be, „Wskaż słowo”, „Posłuchaj i wybierz”, kolejność i krótka odpowiedź
 * mają formę be w zdaniu albo w opcjach.
 */
function needsNowMarker(ex: LessonExerciseDraft, objective: string): boolean {
  switch (ex.exerciseType) {
    case "lesson_gap":
      return ex.stem !== undefined && stripGapVerb(ex.stem).verb !== undefined;
    case "lesson_error_fix":
    case "lesson_transform":
      return true;
    case "lesson_choice":
      // Cel 5: dystraktory to błędna pisownia klucza (`validateIngSpellingDistractors`), więc czas ustala sam klucz.
      return objective === "ing_spelling"
        ? (ex.options ?? []).some((option) => isWellFormedPresentSimpleOption(ex, option.text))
        : (ex.options ?? []).some((option) => parseBeOnly(option.text) === null);
    default:
      return false;
  }
}

/** Wszystkie klasy pisowni — poprawność formy Present Simple opcji nie zależy od klas celu. */
const ALL_ING_RULES: readonly IngRule[] = ["plain", "drop_e", "double", "ie_to_y", "other"];

/**
 * Czy opcja wyboru wstawiona w bodziec daje poprawne orzeczenie w Present
 * Simple (forma zgodna z osobą: „Ola reads”, „Tom doesn't play”, „Does she
 * read?”). Liczą się tylko orzeczenia z czasownikiem z samej opcji, nie
 * z reszty bodźca.
 */
function isWellFormedPresentSimpleOption(ex: LessonExerciseDraft, option: string): boolean {
  const optionTokens = new Set(tenseTokens(option));
  const context: PresentSimpleContext = { expectedBeForm, allowedRules: ALL_ING_RULES };
  const simple = tenseSentences(answerSentence(ex, option)).flatMap(({ tokens, groups }) =>
    groups.filter((group) => group.tense === "simple" && optionTokens.has(tokens[group.verbIndex]!)).map((group) => ({ tokens, group })));
  return simple.length > 0 && simple.every(({ tokens, group }) => {
    const errors: LessonRuleIssue[] = [];
    validatePresentSimpleGroup(tokens, group, context, "options", errors);
    return errors.length === 0;
  });
}

/** Pytanie „What + am/is/are + podmiot + doing?” (cel 4) — samo ustala, że chodzi o teraz. */
function hasWhatDoingQuestion(text: string): boolean {
  return sentenceTokens(text).some((tokens) =>
    (tokens[0] === "what's" || (tokens[0] === "what" && BE_FORMS.has(tokens[1] ?? ""))) && tokens.includes("doing"));
}

/**
 * Cele 1, 3, 4, 5 (zasada §2.6 — jeden poprawny czas): wskaźnik „zwykle”
 * w którymkolwiek skanowanym polu odrzuca ćwiczenie („Tom ___ (play) football
 * every day.” → is playing to błędna angielszczyzna), a ćwiczenie, w którym
 * inny czas też byłby poprawny (`needsNowMarker`), potrzebuje wskaźnika
 * „teraz” w tym, co dziecko widzi przed odpowiedzią (`seenMarkers`), albo —
 * w celu 4 — pytania „What … doing?”; przeczenie potrzebuje mocnego wskaźnika
 * (`nowMarkerBareIssue`).
 */
function validateNowContext(ex: LessonExerciseDraft, objective: string, errors: LessonRuleIssue[]): void {
  const fields = scannedFields(ex);
  for (const { field, text, groups } of fields.map(markersOf)) {
    if (groups.has("usually")) {
      errors.push(grammarIssue("grammar.pc_usually_marker", {
        field,
        pl: `${field}: wskaźnik „zwykle” (every day, always, codziennie…) nie pasuje do Present Continuous — w tym celu czynność dzieje się teraz`,
        found: `${field} ${clip(text)} has a usually marker in the ${clip(objective)} objective`,
      }));
    }
  }
  if (!needsNowMarker(ex, objective)) return;
  const now = seenMarkers(ex, objective).filter(({ groups }) => groups.has("now"));
  if (now.length > 0) {
    if (isNegativeExercise(ex) && !now.some(({ strongNow }) => strongNow)) errors.push(nowMarkerBareIssue(now[0]!.field, now[0]!.text));
    return;
  }
  if (objective === "questions") {
    const sentences = [...fields.filter(({ lang }) => lang === "en").map(({ text }) => text), ...answersOf(ex).map(({ text }) => wholeSentenceOf(ex, text))];
    if (sentences.some(hasWhatDoingQuestion)) return;
  }
  errors.push(grammarIssue("grammar.pc_now_marker_missing", {
    pl: "ćwiczenie potrzebuje wskaźnika „teraz” (now, at the moment, Look!, teraz, Cicho!…) — bez niego Present Simple też byłby poprawny",
    found: `the ${ex.exerciseType} ${clip(ex.stem ?? ex.statement ?? ex.prompt ?? ex.answer)} has no now marker`,
  }));
}

/**
 * Nawias dopuszczalny tylko tuż po luce `lesson_gap` (§6.2) — w wyborze
 * czasownik stoi w opcjach, a lektor czyta bodziec „posłuchaj i wybierz”
 * razem z nawiasem.
 */
function validateBrackets(ex: LessonExerciseDraft, errors: LessonRuleIssue[]): void {
  const texts: { field: string; text: string | undefined }[] = [
    { field: "stem", text: ex.stem !== undefined && ex.exerciseType === "lesson_gap" ? stripGapVerb(ex.stem).stem : ex.stem },
    { field: "statement", text: ex.statement },
    ...answersOf(ex),
    ...(ex.options ?? []).map((option) => ({ field: "options", text: option.text })),
    ...(ex.noticeSegments ?? []).map((segments) => ({ field: "noticeSegments", text: segments.join(" ") })),
  ];
  for (const { field, text } of texts) {
    if (text !== undefined && /[()]/.test(text)) {
      errors.push(grammarIssue("grammar.pc_bracket_outside_gap", {
        field,
        pl: `${field}: nawias jest dozwolony tylko tuż po luce w „Uzupełnij lukę” (He ___ (play) now.)`,
        found: `${field} ${clip(text)} has brackets outside the gap of a lesson_gap`,
      }));
    }
  }
}

/** Czasownik stanu w formie -ing (także „being”) w zdaniu z odpowiedzią (§5.3). */
function stateVerbInAnswer(ex: LessonExerciseDraft, answer: string): string | undefined {
  return stateVerbIn(answerSentence(ex, answer), "ing_form");
}

/**
 * Czasowniki stanu (§5.3): w celach 1, 3, 4, 5 bez formy -ing w zdaniu
 * z odpowiedzią; w celach porównania w dowolnej formie w każdym skanowanym
 * polu angielskim (odpowiedzi i opcje wstawione w bodziec, żeby „has” miało
 * kontekst kolokacji „has lunch”).
 */
function validateStateVerbs(ex: LessonExerciseDraft, objective: string, errors: LessonRuleIssue[]): void {
  const tenseChoice = TENSE_CHOICE_OBJECTIVES.has(objective);
  const report = (field: string, verb: string | undefined): void => {
    if (verb === "be") {
      errors.push(grammarIssue("grammar.pc_being", {
        field,
        pl: `${field}: forma „being” (He is being silly) nie występuje w tym temacie`,
        found: `${field} uses being`,
      }));
    } else if (verb !== undefined && tenseChoice) {
      errors.push(grammarIssue("grammar.pc_state_verb_tense_choice", {
        field,
        pl: `${field}: czasownik „${verb}” opisuje stan — w wyborze teraz/zwykle nie występuje w żadnej formie`,
        found: `${field} uses the state verb ${clip(verb)} in the ${clip(objective)} objective`,
      }));
    } else if (verb !== undefined) {
      errors.push(grammarIssue("grammar.pc_state_verb_ing", {
        field,
        pl: `${field}: czasownik „${verb}” opisuje stan i nie występuje z -ing w tym temacie`,
        found: `${field} uses the state verb ${clip(verb)} in the -ing form`,
      }));
    }
  };
  if (!tenseChoice) {
    for (const { field, text } of answersOf(ex)) report(field, stateVerbInAnswer(ex, text));
    return;
  }
  const answer = normalizeTokens(ex.answer).join(" ");
  const texts = [
    { field: "stem", text: ex.stem },
    { field: "statement", text: ex.statement },
    { field: "prompt", text: ex.exerciseType === "lesson_open_answer" ? undefined : ex.prompt },
    ...answersOf(ex).map(({ field, text }) => ({ field, text: answerSentence(ex, text) })),
    ...(ex.options ?? [])
      .filter((option) => normalizeTokens(option.text).join(" ") !== answer)
      .map((option) => ({ field: "options", text: answerSentence(ex, option.text) })),
  ];
  for (const { field, text } of texts) {
    if (text !== undefined) report(field, stateVerbIn(text, "any_form"));
  }
}

/** Tokeny odpowiedzi po rozwinięciu skrótów isn't / aren't. */
function expandedTokens(answer: string): string[] {
  return normalizeTokens(answer).flatMap((token) => BE_CONTRACTED_TOKENS[token] ?? [token]);
}

/** Odpowiedź luki na samą formę be: am / is / are [not]; null = to nie jest sama forma be. */
function parseBeOnly(answer: string): { form: string; negative: boolean } | null {
  const [form, ...rest] = expandedTokens(answer);
  if (form === undefined || !BE_FORMS.has(form)) return null;
  if (rest.length === 0) return { form, negative: false };
  if (rest.length === 1 && rest[0] === "not") return { form, negative: true };
  return null;
}

/**
 * Podmiot po luce w pytaniu z inwersją („___ Ola reading?”, „What ___ the
 * dogs doing?”): tokeny po luce do formy -ing / „not”, bez określników.
 * undefined, gdy przed luką stoi coś innego niż sam pytajnik albo po luce nie
 * ma formy -ing.
 */
function invertedSubjectAfterGap(stem: string): string[] | undefined {
  const before = beSubjectTokensBefore(stem);
  if (before.length > 1 || (before.length === 1 && !BE_WH_WORDS.has(before[0]!))) return undefined;
  const after = normalizeTokens(stem.split("___", 2)[1] ?? "");
  const end = after.findIndex((token) => token === "not" || token.endsWith("ing"));
  if (end < 0) return undefined;
  const subject = after.slice(0, end).filter((token) => !BE_AFTER_SKIP.has(token));
  return subject.length === 0 ? undefined : subject;
}

/**
 * Podmiot przed luką: tokeny od początku zdania (po „Look!” i innych zdaniach)
 * do luki, bez przysłówków; po wcześniejszej formie be albo orzeczeniu
 * w Present Simple — od spójnika, który otwiera kolejne zdanie składowe („Mum
 * is cooking and Dad ___”, „Mum cooks dinner and Dad ___” → „dad”, nie
 * podmiot złożony).
 */
function subjectSpanBeforeGap(stem: string): string[] {
  const sentence = (stem.split("___", 2)[0] ?? "").split(SENTENCE_BOUNDARY).at(-1) ?? "";
  const tokens = expandedTokens(sentence).filter((token) => !BE_ADVERBS.has(token));
  const lastSimple = verbGroupsIn(tokens).findLast((group) => group.tense === "simple")?.verbIndex ?? -1;
  const boundary = Math.max(tokens.findLastIndex((token) => BE_FORMS.has(token)), lastSimple);
  if (boundary < 0) return tokens;
  const conjunction = tokens.findIndex((token, i) => i > boundary && CLAUSE_CONJUNCTIONS.has(token));
  return tokens.slice(conjunction >= 0 ? conjunction + 1 : boundary + 1);
}

/** Rzeczowniki z tą samą formą w liczbie pojedynczej i mnogiej (krytycy końcowi A i C, Task 16): „The sheep is / are eating”. */
const NUMBERLESS_NOUNS: ReadonlySet<string> = new Set(["fish", "sheep", "deer"]);

/** Słowa przed takim rzeczownikiem, które ustalają jego liczbę, i forma be zgodna z nimi. */
const NUMBER_WORD_BE_FORM: Readonly<Record<string, string>> = {
  a: "is", an: "is", one: "is", this: "is", that: "is", each: "is", every: "is",
  these: "are", those: "are", many: "are", two: "are", three: "are", four: "are", five: "are",
  six: "are", seven: "are", eight: "are", nine: "are", ten: "are",
};

/**
 * Forma be zgodna z liczbą rzeczownika `tokens[index]` z `NUMBERLESS_NOUNS`: „a lot of” / „lots of” wśród
 * trzech słów przed nim → are, inaczej najbliższy określnik albo liczebnik wśród nich („two big fish” → are);
 * undefined — liczby nic nie ustala („the fish”, „one of the fish”).
 */
function numberlessNounBeForm(tokens: readonly string[], index: number): string | undefined {
  const window = tokens.slice(Math.max(0, index - 3), index);
  if (window.some((token, i) => (token === "lot" || token === "lots") && window[i + 1] === "of")) return "are";
  const word = window.findLast((token) => BE_DETERMINERS.has(token) || Object.hasOwn(NUMBER_WORD_BE_FORM, token));
  return word === undefined ? undefined : NUMBER_WORD_BE_FORM[word];
}

/**
 * Forma be wymagana przez podmiot przy luce (stem bez nawiasu); undefined = nie
 * da się ustalić. Heurystyki działają na samym zdaniu składowym z luką.
 * Podmiot złożony przed luką („The cat and the dog ___”, „Tom and his sister
 * ___”) → are — wspólna heurystyka widzi „and” tylko dwa tokeny przed luką.
 * Pytanie z inwersją i podmiotem złożonym („___ the boy and the girl
 * playing?”) → are, zanim wspólna heurystyka weźmie pierwszy rzeczownik; imię
 * albo rzeczownik po luce, którego wspólna heurystyka nie rozpoznaje („___ Ola
 * reading?”) → liczba z `looksPlural`.
 */
function expectedBeForm(fullStem: string): string | undefined {
  const span = subjectSpanBeforeGap(fullStem);
  if (span.indexOf("and") > 0 && span.at(-1) !== "and") return "are";
  const stem = `${span.join(" ")} ___ ${fullStem.split("___", 2)[1] ?? ""}`;
  const inverted = invertedSubjectAfterGap(stem);
  if (inverted?.includes("and")) return "are";
  // fish / sheep / deer: liczbę ustala tylko określnik; bez niego pasują is i are (`grammar.pc_numberless_subject`).
  if (NUMBERLESS_NOUNS.has(span.at(-1) ?? "")) return numberlessNounBeForm(span, span.length - 1);
  const after = normalizeTokens(fullStem.split("___", 2)[1] ?? "");
  const invertedNoun = after.findIndex((token) => NUMBERLESS_NOUNS.has(token));
  if (invertedNoun >= 0 && inverted?.includes(after[invertedNoun]!) === true) return numberlessNounBeForm(after, invertedNoun);
  const fromSubject = expectedBeFormNearGap(stem);
  if (fromSubject !== undefined) return fromSubject;
  const near = bePronounNearGap(stem);
  if (near !== undefined && !near.fromQuestion) return BE_FORM_BY_SUBJECT[near.pronoun];
  if (inverted === undefined) return undefined;
  return looksPlural(inverted.at(-1)!) ? "are" : "is";
}

/** Ostatnie „Yes” / „No” przed luką („Is she reading? No, she ___.”). */
function yesNoBeforeGap(stem: string): string | undefined {
  return normalizeTokens(stem.split("___", 2)[0] ?? "").findLast((token) => token === "yes" || token === "no");
}

/** Zgłoszenie: forma be niezgodna z podmiotem (luka na formę be, luka z czasownikiem i całe zdanie). */
function beFormIssue(field: string, form: string, expected: string, context: string): LessonRuleIssue {
  return grammarIssue("grammar.pc_be_form_subject", {
    field,
    pl: `${field}: forma „${form}” nie pasuje do podmiotu (poprawnie: ${expected})`,
    found: `${field} uses ${clip(form)} in ${clip(context)}, but the subject requires ${clip(expected)}`,
  });
}

function validateBeForm(form: string, stem: string, field: string, errors: LessonRuleIssue[]): void {
  const expected = expectedBeForm(stem);
  if (expected !== undefined && expected !== form) {
    errors.push(beFormIssue(field, form, expected, stem));
  }
}

/**
 * Luka na samą formę be (cele 1, 3, 4): forma zgodna z podmiotem, biegunowość
 * z celu i Yes/No. Przeczenie w odpowiedzi tylko po „No” i bez „not” po luce —
 * inaczej twierdzenie pasuje tak samo („___ she reading?” → Is / Isn't, „She
 * ___ sleeping now.” → is / isn't) albo powstaje podwójne przeczenie („She
 * isn't not sleeping”). W wyborze celu 3 opcje ustalają biegunowość
 * (isn't / aren't), a dystraktor ± not łapie `validateBeChoiceDistractors`.
 */
function validateBeOnlyGapAnswer(
  ex: LessonExerciseDraft,
  stem: string,
  parsed: { form: string; negative: boolean },
  answer: string,
  field: string,
  errors: LessonRuleIssue[],
): void {
  validateBeForm(parsed.form, stem, field, errors);
  const objective = objectiveOf(ex);
  const marker = yesNoBeforeGap(stem);
  if (parsed.negative) {
    if (expandedTokens(stem.split("___", 2)[1] ?? "").includes("not")) {
      errors.push(grammarIssue("grammar.pc_be_gap_double_negation", {
        field,
        pl: `${field}: po luce stoi już „not” — odpowiedź z przeczeniem daje podwójne przeczenie`,
        found: `${field} ${clip(answer)} is negated, but not already follows the gap in ${clip(stem)}`,
      }));
      return;
    }
    // W wyborze celu 3 biegunowość ustalają opcje (isn't / aren't); wpisywana luka dopuszcza też twierdzenie.
    const optionsFixPolarity = objective === "negative" && ex.exerciseType !== "lesson_gap";
    if (!optionsFixPolarity && marker !== "no") {
      errors.push(grammarIssue("grammar.pc_be_gap_negative_without_no", {
        field,
        pl: `${field}: przeczenie w luce na formę be tylko po „No” — inaczej twierdzenie też pasuje (w celu przeczeń: She ___ not sleeping. → is)`,
        found: `${field} ${clip(answer)} is a negative be form without No before the gap in ${clip(stem)}`,
      }));
      return;
    }
  }
  const negative = parsed.negative || beStemContext(stem).negative;
  checkBePolarity(polarityOf(ex, objective), negative, marker, field, answer, errors);
}

/** Zgłoszenie: klasa pisowni -ing czasownika spoza klas celu (luka z czasownikiem i całe zdanie). */
function ingRuleIssue(field: string, verb: string, rule: IngRule, objective: string, allowed: readonly string[]): LessonRuleIssue {
  return grammarIssue("grammar.pc_ing_rule_not_allowed", {
    field,
    pl: `${field}: czasownik „${verb}” (pisownia ${rule}) nie pasuje do celu (dozwolone: ${allowed.join(", ")})`,
    found: `the verb ${clip(verb)} follows the ${rule} spelling rule; the objective ${clip(objective)} allows ${allowed.join(", ")}`,
  });
}

/** Forma -ing czasownika z nawiasu: z tabeli i dozwolonej klasy albo kolokacja „having/looking” (nie w celu 5). */
function validateIngForm(ex: LessonExerciseDraft, objective: string, verb: string, ing: string, answer: string, field: string, errors: LessonRuleIssue[]): void {
  const expected = ingFormOf(verb);
  if (expected === undefined) {
    const sentenceTokens = normalizeTokens(answerSentence(ex, answer));
    const collocation = objective !== "ing_spelling" &&
      Object.hasOwn(COLLOCATION_ING_FORMS, verb) && COLLOCATION_ING_FORMS[verb] === ing &&
      isCollocationIngForm(sentenceTokens, sentenceTokens.indexOf(ing));
    if (!collocation) {
      errors.push(grammarIssue("grammar.pc_verb_outside_table", {
        field,
        pl: `${field}: czasownik „${verb}” jest spoza tabeli form -ing`,
        found: `the verb ${clip(verb)} in the brackets is not in the verb table`,
      }));
    }
    return;
  }
  if (ing !== expected) {
    errors.push(grammarIssue("grammar.pc_ing_wrong_form", {
      field,
      pl: `${field}: „${ing}” nie jest formą -ing czasownika „${verb}” (poprawnie: ${expected})`,
      found: `${clip(ing)} is not the -ing form of ${clip(verb)} (expected ${clip(expected)})`,
    }));
    return;
  }
  const allowed = Object.hasOwn(PC_ALLOWED_ING_RULES, objective) ? PC_ALLOWED_ING_RULES[objective]! : [];
  const rule = ingRuleOf(verb)!;
  if (!allowed.includes(rule)) {
    errors.push(ingRuleIssue(field, verb, rule, objective, allowed));
  }
}

/** Luka z czasownikiem w celach 1, 3, 4, 5: am / is / are [not] + forma -ing czasownika z nawiasu. */
function validateBeIngGapAnswer(
  ex: LessonExerciseDraft,
  objective: string,
  gap: { stem: string; verb: string; negative: boolean },
  answer: string,
  field: string,
  errors: LessonRuleIssue[],
): void {
  const [form, ...rest] = expandedTokens(answer);
  if (form === undefined || !BE_FORMS.has(form)) {
    errors.push(grammarIssue("grammar.pc_verb_gap_be_missing", {
      field,
      pl: `${field}: odpowiedź „${answer}” musi zaczynać się od am, is albo are`,
      found: `${field} ${clip(answer)} does not start with am, is or are`,
    }));
    return;
  }
  validateBeForm(form, gap.stem, field, errors);
  const negative = rest[0] === "not";
  checkBePolarity(polarityOf(ex, objective), negative, undefined, field, answer, errors);
  if (negative !== gap.negative) {
    errors.push(grammarIssue("grammar.pc_gap_negation_bracket", {
      field,
      pl: gap.negative
        ? `${field}: nawias ma „not”, więc odpowiedź musi być przeczeniem`
        : `${field}: przeczenie w odpowiedzi wymaga „not” w nawiasie (She ___ (not watch) TV now.)`,
      found: gap.negative
        ? `${field} ${clip(answer)} is not negated, but the brackets say not`
        : `${field} ${clip(answer)} is negated, but the brackets have no not`,
    }));
  }
  const tail = negative ? rest.slice(1) : rest;
  if (tail.length !== 1) {
    errors.push(grammarIssue("grammar.pc_ing_after_be", {
      field,
      pl: `${field}: po am/is/are${negative ? " not" : ""} potrzebna jest jedna forma -ing czasownika „${gap.verb}”`,
      found: `${field} ${clip(answer)} needs exactly one -ing form of ${clip(gap.verb)} after am/is/are${negative ? " not" : ""}`,
    }));
    return;
  }
  // Czasownik stanu zgłasza reguła wspólna (przed tabelą form -ing) — bez drugiego komunikatu.
  if (stateVerbInAnswer(ex, answer) !== undefined) return;
  validateIngForm(ex, objective, gap.verb, tail[0]!, answer, field, errors);
}

/**
 * Zdanie składowe z luką: tokeny przed luką od ostatniej granicy zdania albo od
 * spójnika otwierającego zdanie po wcześniejszym orzeczeniu („Mum is cooking
 * and Dad ___” → „dad”; ten sam podział co w `subjectSpanBeforeGap`).
 */
function clauseTokensBeforeGap(stem: string): string[] {
  const sentence = (stem.split("___", 2)[0] ?? "").split(SENTENCE_BOUNDARY).at(-1) ?? "";
  const tokens = tenseTokens(sentence);
  let start = 0;
  for (const group of verbGroupsIn(tokens)) {
    const conjunction = tokens.findIndex((token, i) => i > group.verbIndex && CLAUSE_CONJUNCTIONS.has(token));
    if (conjunction < 0) break;
    start = conjunction + 1;
  }
  return tokens.slice(start);
}

/**
 * Skrót pytajnika albo wskaźnika z „is” (what's, where's, there's…): `tenseTokens`
 * go nie rozwija. „Ola's” (dzierżawczy) nie pasuje, bo wzorzec zna tylko te słowa.
 */
const INTERROGATIVE_BE_CONTRACTION = /^(what|where|who|how|why|when|here|there|that)'s$/;

/**
 * Luka z czasownikiem (§6.2) obejmuje całą formę (am/is/are [not] + -ing albo
 * Present Simple), więc przed luką w tym samym zdaniu składowym nie ma już
 * formy be ani do/does — inaczej po wstawieniu powstaje „Is she is reading?”.
 */
function validateVerbGapOwnsWholeForm(stem: string, errors: LessonRuleIssue[]): void {
  const present = clauseTokensBeforeGap(stem).find(
    (token) => BE_FORMS.has(token) || token === "do" || token === "does" || INTERROGATIVE_BE_CONTRACTION.test(token),
  );
  if (present !== undefined) {
    errors.push(grammarIssue("grammar.pc_verb_gap_whole_form", {
      pl: `stem: luka z czasownikiem obejmuje całą formę — w zdaniu przed luką jest już „${present}” (He ___ (play) now.)`,
      found: `the clause before the verb gap in ${clip(stem)} already has ${clip(present)}`,
    }));
  }
}

/** Luka (`lesson_gap`, §6.2): kształt luki, nawias z czasownikiem, forma be i -ing. */
function validateGap(ex: LessonExerciseDraft, objective: string, errors: LessonRuleIssue[]): void {
  if (ex.stem === undefined) return;
  const gap = stripGapVerb(ex.stem);
  const { verb } = gap;
  if (verb !== undefined) {
    validateVerbGapOwnsWholeForm(gap.stem, errors);
    if (gap.negative && !NEGATED_VERB_GAP_OBJECTIVES.has(objective)) {
      errors.push(grammarIssue("grammar.pc_gap_bracket_objective", {
        pl: "stem: nawias z „not” jest dozwolony tylko w celach przeczeń",
        found: `the brackets in ${clip(ex.stem)} say not, but the objective ${clip(objective)} is not a negative objective`,
      }));
    }
    if (!gap.negative && NEGATED_VERB_GAP_OBJECTIVES.has(objective)) {
      errors.push(grammarIssue("grammar.pc_gap_bracket_objective", {
        pl: "stem: w tym celu luka z czasownikiem wymaga „not” w nawiasie (She ___ (not watch) TV now.)",
        found: `the brackets in ${clip(ex.stem)} have no not, but the objective ${clip(objective)} requires (not verb)`,
      }));
    }
  }
  for (const { field, text } of answersOf(ex)) {
    if (LEADING_APOSTROPHE.test(text.trim())) {
      errors.push(grammarIssue("grammar.pc_leading_apostrophe", {
        field,
        pl: `${field}: odpowiedź luki nie może zaczynać się apostrofem („${text}”) — zapisz pełną formę am/is/are`,
        found: `${field} ${clip(text)} starts with an apostrophe`,
      }));
      continue;
    }
    if (verb === undefined) {
      const parsed = parseBeOnly(text);
      if (parsed === null) {
        errors.push(grammarIssue("grammar.pc_gap_shape", {
          field,
          pl: `${field}: luka z czasownikiem wymaga formy podstawowej w nawiasie tuż po luce (He ___ (play) now.)`,
          found: `${field} ${clip(text)} is not only am/is/are, and no (verb) stands right after the gap in ${clip(ex.stem)}`,
        }));
      } else if (!BE_GAP_OBJECTIVES.has(objective)) {
        errors.push(grammarIssue("grammar.pc_be_gap_objective", {
          field,
          pl: `${field}: luka na samą formę am/is/are jest tylko w celach twierdzeń, przeczeń i pytań`,
          found: `${field} ${clip(text)} is a be gap in the ${clip(objective)} objective`,
        }));
      } else {
        validateBeOnlyGapAnswer(ex, gap.stem, parsed, text, field, errors);
      }
    } else if (PC_FORM_OBJECTIVES.has(objective)) {
      validateBeIngGapAnswer(ex, objective, { stem: gap.stem, verb, negative: gap.negative }, text, field, errors);
    }
  }
}

/**
 * Typy z całym zdaniem w odpowiedzi (§6.3; „Posłuchaj i wybierz” — luka na
 * formę be jak w wyborze). `error_fix`, `notice` i opcje „Posłuchaj i wybierz”
 * mają dodatkowe reguły w `present-continuous-exercise-rules.ts`.
 */
const WHOLE_SENTENCE_TYPES: ReadonlySet<string> = new Set([
  "lesson_choice",
  "lesson_listen_choice",
  "lesson_error_fix",
  "lesson_order",
  "lesson_short_answer",
  "lesson_transform",
  "lesson_open_answer",
]);

/**
 * Skróty z „'s” zakazane w kluczach (§6.3): normalizator rozwija je do „is”
 * albo „has”, więc klucz „He's running.” zaliczyłby „He has running.”.
 */
const S_CONTRACTIONS: ReadonlySet<string> = new Set(["he's", "she's", "it's", "what's", "that's", "there's", "where's", "who's"]);

/** Pytajniki na początku zdania; dozwolony jest tylko wzorzec „What + am/is/are + podmiot + doing?”. */
const QUESTION_WORDS: ReadonlySet<string> = new Set([...BE_WH_WORDS, "which"]);

/**
 * Słowa między formą be a formą -ing („She is still sleeping”, „Mum is now reading”, „The children are all
 * playing”); „always” to wskaźnik „zwykle”.
 */
const BE_ADVERBS_IN_PC: ReadonlySet<string> = new Set(["still", "just", "really", "now", "all", "both"]);

/** Tokeny zdań tekstu (po rozwinięciu isn't / aren't i skrótów zaimków), bez pustych. */
function sentenceTokens(text: string): string[][] {
  return text.split(SENTENCE_BOUNDARY).map(expandedTokens).filter((tokens) => tokens.length > 0);
}

/** Klucze ćwiczenia z całym zdaniem: odpowiedź, warianty i tekst poprawnej opcji, gdy różni się od odpowiedzi. */
function sentenceAnswersOf(ex: LessonExerciseDraft): { field: string; text: string }[] {
  const answers = answersOf(ex);
  const correct = ex.options?.find((option) => option.id === ex.correctOption)?.text;
  if (correct !== undefined && normalizeTokens(correct).join(" ") !== normalizeTokens(ex.answer).join(" ")) {
    answers.push({ field: "options", text: correct });
  }
  return answers;
}

/** Bodziec krótkiej odpowiedzi (pytanie) — `prompt` albo `stem`. */
function shortAnswerQuestion(ex: LessonExerciseDraft): { field: string; text: string } | undefined {
  if (ex.exerciseType !== "lesson_short_answer") return undefined;
  if (ex.prompt !== undefined) return { field: "prompt", text: ex.prompt };
  return ex.stem === undefined ? undefined : { field: "stem", text: ex.stem };
}

/** Pełne zdanie odpowiedzi: bodziec z luką wypełnioną kluczem (wybór, krótka odpowiedź z luką) albo sam klucz. */
function wholeSentenceOf(ex: LessonExerciseDraft, answer: string): string {
  const question = shortAnswerQuestion(ex);
  if (question !== undefined && question.text.includes("___")) return question.text.replace("___", answer);
  return answerSentence(ex, answer);
}

/** Pytajnik na początku zdania poza wzorcem „What + am/is/are + podmiot + doing?” (§6.3). */
function validateQuestionWords(tokens: readonly string[], field: string, errors: LessonRuleIssue[]): void {
  const first = tokens[0];
  if (first === undefined || !QUESTION_WORDS.has(first)) return;
  // „What a mess!” to wykrzyknienie, nie pytanie.
  if (first === "what" && (tokens[1] === "a" || tokens[1] === "an")) return;
  const whatDoing = first === "what" && BE_FORMS.has(tokens[1] ?? "") && tokens.slice(2).includes("doing");
  if (!whatDoing) {
    errors.push(grammarIssue("grammar.pc_wh_question", {
      field,
      pl: `${field}: pytanie szczegółowe tylko we wzorcu „What + am/is/are + podmiot + doing?” (What is he doing?)`,
      found: `${field} ${clip(tokens.join(" "))} starts with the question word ${clip(first)}`,
    }));
  }
}

/** Czy forma be na pozycji `index` otwiera pytanie z inwersją („Is she…”, „What are they…”). */
function isInvertedBe(tokens: readonly string[], start: number, index: number): boolean {
  return index === start || (index === start + 1 && BE_WH_WORDS.has(tokens[start]!));
}

/**
 * Forma be wymagana przez podmiot formy na pozycji `index`. Zdanie składowe
 * zaczyna się po spójniku za poprzednią formą be („… and Dad ___ reading”);
 * w pytaniu z inwersją „not” po formie be jest pomijane („Aren't they” →
 * „___ they”), żeby podmiot stał tuż po luce.
 */
function expectedBeAt(tokens: readonly string[], start: number, index: number): string | undefined {
  const after = tokens.slice(index + 1);
  if (isInvertedBe(tokens, start, index) && after[0] === "not") after.shift();
  return expectedBeForm([...tokens.slice(start, index), "___", ...after].join(" "));
}

/** Pozycja formy -ing po formie be albo undefined (krótka odpowiedź „Yes, she is.”). */
function verbIndexAfterBe(tokens: readonly string[], index: number, inverted: boolean): number | undefined {
  let next = index + 1;
  // Podwójne „not” („isn't not”) zgłasza reguła biegunowości — tu je pomijamy.
  while (tokens[next] === "not") next++;
  if (!inverted) {
    while (next < tokens.length && BE_ADVERBS_IN_PC.has(tokens[next]!)) next++;
    return next < tokens.length ? next : undefined;
  }
  // Pytanie z inwersją: forma -ing stoi po podmiocie („Is the king reading?” — „king” to nie forma -ing).
  const isVerb = (token: string, i: number): boolean => isIngFormInTable(token) || isCollocationIngForm(tokens, i);
  const found = tokens.findIndex((token, i) => i > next && isVerb(token, i));
  if (found >= 0) return found;
  const outOfTable = tokens.findIndex((token, i) => i > next && token.endsWith("ing"));
  return outOfTable >= 0 ? outOfTable : tokens.length;
}

/**
 * Czy token po formie be to forma czasownika: forma -ing (także spoza tabeli),
 * forma Present Simple albo podstawowa czasownika znanego tematowi („She is
 * play”, „She is plays”). Inny token („in”, „sunny”, „Ola”) to orzecznik po
 * łączniku be („Mum is in the kitchen”, „This is Ola”).
 */
function isVerbFormAfterBe(tokens: readonly string[], index: number): boolean {
  const token = tokens[index]!;
  return token.endsWith("ing") || presentSimpleBaseOf(token) !== undefined || isCollocationIngForm(tokens, index);
}

/**
 * Forma -ing po formie be: z tabeli i dozwolonej klasy albo kolokacja
 * „having/looking” (nie w celu 5). Tabelę i klasę sprawdzamy tylko dla formy
 * z klucza (§4, „w sprawdzanym miejscu”) — w wyborze „The dogs ___ running.”
 * forma -ing stoi w bodźcu, a sprawdzana jest forma be. Zwraca false, gdy be
 * jest łącznikiem (po nim nie stoi forma czasownika) — wtedy bez reguły -ing.
 */
function validateIngAfterBe(
  ex: LessonExerciseDraft,
  objective: string,
  tokens: readonly string[],
  index: number,
  keyTokens: ReadonlySet<string>,
  field: string,
  errors: LessonRuleIssue[],
): boolean {
  const token = tokens[index];
  if (token === undefined) {
    errors.push(grammarIssue("grammar.pc_ing_after_be", {
      field,
      pl: `${field}: po am/is/are brak formy -ing czasownika`,
      found: `${field} ${clip(tokens.join(" "))} has no -ing form after am/is/are`,
    }));
    return true;
  }
  if (!isVerbFormAfterBe(tokens, index)) return false;
  const fromKey = keyTokens.has(token);
  if (isIngFormInTable(token)) {
    if (!fromKey) return true;
    const verb = baseOfIngForm(token)!;
    const rule = ingRuleOf(verb)!;
    // Cel 5: forma `plain` dopuszczona w wyborze jako kontrast (§4).
    const allowed = objective === "ing_spelling" && ex.exerciseType === "lesson_choice"
      ? [...PC_ALLOWED_ING_RULES[objective]!, "plain"]
      : PC_ALLOWED_ING_RULES[objective] ?? [];
    if (!allowed.includes(rule)) {
      errors.push(ingRuleIssue(field, verb, rule, objective, allowed));
    }
    return true;
  }
  if (isCollocationIngForm(tokens, index)) {
    if (fromKey && objective === "ing_spelling") {
      errors.push(grammarIssue("grammar.pc_collocation_in_ing_spelling", {
        field,
        pl: `${field}: kolokacja „${token}” nie ćwiczy pisowni z tabeli — nie w celu pisowni -ing`,
        found: `${field} uses the collocation ${clip(token)} in the ing_spelling objective`,
      }));
    }
    return true;
  }
  if (!token.endsWith("ing")) {
    errors.push(grammarIssue("grammar.pc_ing_after_be", {
      field,
      pl: `${field}: po am/is/are potrzebna jest forma -ing, a stoi „${token}” (She is playing, nie She is plays)`,
      found: `${field} has ${clip(token)} after am/is/are instead of an -ing form`,
    }));
  } else if (fromKey) {
    errors.push(grammarIssue("grammar.pc_verb_outside_table", {
      field,
      pl: `${field}: „${token}” jest spoza tabeli form -ing`,
      found: `the -ing form ${clip(token)} in ${field} is not in the verb table`,
    }));
  }
  return true;
}

/**
 * Formy be jednego zdania: zgodność z podmiotem i forma -ing po każdej
 * z nich (`keyTokens` undefined = bez sprawdzania formy -ing). Zwraca, czy
 * w zdaniu jest forma be i czy któraś buduje Present Continuous (po niej
 * forma czasownika albo koniec krótkiej odpowiedzi „Yes, she is.”; łącznik
 * „Mum is in the kitchen” się nie liczy).
 */
function validateSentenceBeForms(
  ex: LessonExerciseDraft,
  objective: string,
  tokens: readonly string[],
  keyTokens: ReadonlySet<string> | undefined,
  field: string,
  errors: LessonRuleIssue[],
): { hasBe: boolean; hasContinuousBe: boolean } {
  let start = 0;
  let previousBe: number | undefined;
  let hasBe = false;
  let hasContinuousBe = false;
  for (const [index, form] of tokens.entries()) {
    if (!BE_FORMS.has(form)) continue;
    if (previousBe !== undefined) {
      const conjunction = tokens.findIndex((token, i) => i > previousBe! && i < index && CLAUSE_CONJUNCTIONS.has(token));
      start = conjunction >= 0 ? conjunction + 1 : previousBe + 1;
    }
    previousBe = index;
    hasBe = true;
    const expected = expectedBeAt(tokens, start, index);
    if (expected !== undefined && expected !== form) {
      errors.push(beFormIssue(field, form, expected, tokens.join(" ")));
    }
    if (keyTokens === undefined) {
      hasContinuousBe = true;
      continue;
    }
    const verbIndex = verbIndexAfterBe(tokens, index, isInvertedBe(tokens, start, index));
    if (verbIndex === undefined || validateIngAfterBe(ex, objective, tokens, verbIndex, keyTokens, field, errors)) hasContinuousBe = true;
  }
  return { hasBe, hasContinuousBe };
}

/**
 * Podmiot pytania krótkiej odpowiedzi: zaimek („Is she…?”, „What are you…?”)
 * albo — dla imienia i rzeczownika — forma be wymagana przez podmiot („Are the
 * boys…?” → are). Bierze pierwsze zdanie otwarte formą be albo What + be
 * („Look at Ola! Is she reading?”); undefined bez takiego zdania i w bodźcu
 * z luką.
 */
function questionSubject(question: string): { pronoun: string } | { beForm: string } | undefined {
  if (question.includes("___")) return undefined;
  for (const tokens of sentenceTokens(question)) {
    const beIndex = tokens[0] === "what" ? 1 : 0;
    if (!BE_FORMS.has(tokens[beIndex] ?? "")) continue;
    const subject = tokens[beIndex + 1] === "not" ? tokens[beIndex + 2] : tokens[beIndex + 1];
    if (subject !== undefined && Object.hasOwn(BE_FORM_BY_SUBJECT, subject)) return { pronoun: subject };
    const beForm = expectedBeAt(tokens, 0, beIndex);
    return beForm === undefined ? undefined : { beForm };
  }
  return undefined;
}

/** Zaimki odpowiedzi na pytanie z imieniem albo rzeczownikiem: is → he/she/it, are → they. */
const ANSWER_PRONOUNS_BY_BE: Readonly<Record<string, readonly string[]>> = { is: ["he", "she", "it"], are: ["they"] };

/**
 * Osoba krótkiej odpowiedzi zgodna z pytaniem („Is she reading?” → „Yes, she
 * is.”, „Are you…?” → „I am”, „Are the boys…?” → „they are”, „Is Tom…?” →
 * he/she/it is).
 */
function validateShortAnswerPerson(ex: LessonExerciseDraft, answer: string, field: string, errors: LessonRuleIssue[]): void {
  const question = shortAnswerQuestion(ex);
  const subject = question === undefined ? undefined : questionSubject(question.text);
  if (subject === undefined) return;
  const tokens = expandedTokens(answer);
  const index = tokens.findIndex((token, i) => Object.hasOwn(BE_FORM_BY_SUBJECT, token) && BE_FORMS.has(tokens[i + 1] ?? ""));
  if (index < 0) return;
  const pronoun = tokens[index]!;
  if ("pronoun" in subject) {
    if (!beAnswerPronounAllowed(pronoun, { pronoun: subject.pronoun, fromQuestion: true })) {
      errors.push(grammarIssue("grammar.pc_short_answer_person", {
        field,
        pl: `${field}: osoba „${pronoun}” w odpowiedzi nie pasuje do podmiotu pytania „${subject.pronoun}”`,
        found: `${field} ${clip(answer)} uses ${clip(pronoun)}, but the question is about ${clip(subject.pronoun)}`,
      }));
    }
    return;
  }
  const allowed = ANSWER_PRONOUNS_BY_BE[subject.beForm] ?? [];
  if (!allowed.includes(pronoun)) {
    errors.push(grammarIssue("grammar.pc_short_answer_person", {
      field,
      pl: `${field}: osoba „${pronoun}” w odpowiedzi nie pasuje do podmiotu pytania (${subject.beForm} → ${allowed.join("/")})`,
      found: `${field} ${clip(answer)} uses ${clip(pronoun)}, but the subject of the question takes ${clip(subject.beForm)}`,
    }));
  }
}

/**
 * Klucz z całym zdaniem w celach 1, 3, 4, 5 (§6.3): pytajnik tylko „What …
 * doing?”, każda forma be zgodna z podmiotem i z formą -ing po niej, zdanie
 * z formą be, biegunowość z celu albo przekształcenia (`checkPolarity` false —
 * biegunowość sprawdziła reguła luki na formę be), osoba krótkiej odpowiedzi.
 */
function validateSentenceAnswer(
  ex: LessonExerciseDraft,
  objective: string,
  answer: string,
  field: string,
  checkPolarity: boolean,
  errors: LessonRuleIssue[],
): void {
  const sentence = wholeSentenceOf(ex, answer);
  const sentences = sentenceTokens(sentence);
  for (const tokens of sentences) validateQuestionWords(tokens, field, errors);
  // Czasownik stanu zgłasza reguła wspólna — bez drugiego komunikatu o formie -ing.
  const keyTokens = stateVerbIn(sentence, "ing_form") === undefined ? new Set(expandedTokens(answer)) : undefined;
  const beForms = sentences.map((tokens) => validateSentenceBeForms(ex, objective, tokens, keyTokens, field, errors));
  if (!beForms.some(({ hasBe }) => hasBe)) {
    errors.push(grammarIssue("grammar.pc_sentence_be_missing", {
      field,
      pl: `${field}: zdanie w Present Continuous potrzebuje formy am/is/are`,
      found: `${field} ${clip(sentence)} has no am, is or are`,
    }));
    return;
  }
  if (!beForms.some(({ hasContinuousBe }) => hasContinuousBe)) {
    errors.push(grammarIssue("grammar.pc_sentence_not_continuous", {
      field,
      pl: `${field}: zdanie w Present Continuous potrzebuje am/is/are + formy -ing (samo „Mum is in the kitchen.” to nie Present Continuous)`,
      found: `${field} ${clip(sentence)} has no am/is/are + -ing verb`,
    }));
  }
  if (checkPolarity) {
    const marker = sentences.map((tokens) => tokens[0]).findLast((token) => token === "yes" || token === "no");
    const negative = sentences.some((tokens) => tokens.includes("not"));
    checkBePolarity(polarityOf(ex, objective), negative, marker, field, answer, errors);
  }
  validateShortAnswerPerson(ex, answer, field, errors);
}

/** Bodziec z luką na formę be w wyborze, „Posłuchaj i wybierz” albo krótkiej odpowiedzi (ten sam kształt co luka, §6.2). */
function beChoiceGapStem(ex: LessonExerciseDraft): string | undefined {
  const choice = ex.exerciseType === "lesson_choice" || ex.exerciseType === "lesson_listen_choice";
  const stem = choice ? ex.stem : shortAnswerQuestion(ex)?.text;
  return stem?.includes("___") ? stem : undefined;
}

/**
 * Dystraktor równy kluczowi z dodanym albo usuniętym „not” („Is” / „Isn't”)
 * bez „Yes” / „No” przed luką i bez „not” po niej: oba zdania są poprawne.
 */
function validateBeChoiceDistractors(ex: LessonExerciseDraft, stem: string, errors: LessonRuleIssue[]): void {
  const key = ex.options?.find((option) => option.id === ex.correctOption);
  const parsedKey = key === undefined ? null : parseBeOnly(key.text);
  if (parsedKey === null || yesNoBeforeGap(stem) !== undefined) return;
  if (expandedTokens(stem.split("___", 2)[1] ?? "").includes("not")) return;
  for (const option of ex.options ?? []) {
    if (option.id === key!.id) continue;
    const parsed = parseBeOnly(option.text);
    if (parsed !== null && parsed.form === parsedKey.form && parsed.negative !== parsedKey.negative) {
      errors.push(grammarIssue("grammar.pc_be_choice_polarity_distractor", {
        pl: `options: „${option.text}” i „${key!.text}” dają dwa poprawne zdania — dystraktor musi być błędny`,
        found: `options ${clip(option.text)} and ${clip(key!.text)} both fit ${clip(stem)}`,
      }));
    }
  }
}

/**
 * Krótka odpowiedź z opcjami „Yes…” i „No…” (krytyk końcowy A, Task 16): pytanie bez sytuacji
 * nie rozstrzyga, czy tak jest, a scenka w poleceniu daje to dziecku za darmo — obie opcje z jednym
 * „Yes” albo jednym „No” (Yes, she is. / Yes, she does.) sprawdzają formę, nie zgadywanie.
 */
function validateShortAnswerYesNo(ex: LessonExerciseDraft, errors: LessonRuleIssue[]): void {
  if (ex.exerciseType !== "lesson_short_answer") return;
  const firsts = new Set((ex.options ?? []).map((option) => normalizeTokens(option.text)[0]));
  if (firsts.has("yes") && firsts.has("no")) {
    errors.push(grammarIssue("grammar.pc_be_choice_polarity_distractor", {
      pl: "options: krótka odpowiedź z opcjami „Yes…” i „No…” — obie mogą być poprawne; wszystkie opcje zaczynaj tym samym Yes albo No",
      found: `options ${clip((ex.options ?? []).map((option) => option.text).join(" / "))} start with both Yes and No`,
    }));
  }
}

/** Czy token to forma, której liczbę ustala podmiot: am/is/are albo do/does. */
function isNumberedAuxiliary(token: string): boolean {
  return BE_FORMS.has(token) || token === "do" || token === "does";
}

/** Czy token ma własną liczbę orzeczenia: am/is/are, do/does, forma -ing albo Present Simple. */
function isVerbToken(token: string): boolean {
  return isNumberedAuxiliary(token) || ingBaseOf(token) !== undefined || presentSimpleBaseOf(token) !== undefined;
}

/**
 * Rzeczownik `tokens[index]` w podmiocie złożonym z „and” („the cat and the fish are”, „the fish and
 * the cat are”) — liczbę mnogą ustala „and”. „Tom is reading and the fish …” to dwa zdania składowe:
 * przed „and” stoi orzeczenie (poza am/is/are, do/does otwierającymi pytanie).
 */
function inCompoundSubject(tokens: readonly string[], index: number, opener: number): boolean {
  if (tokens[index + 1] === "and") return true;
  const window = tokens.slice(Math.max(0, index - 3), index);
  const determiner = window.findLastIndex((token) => BE_DETERMINERS.has(token) || Object.hasOwn(NUMBER_WORD_BE_FORM, token));
  const start = determiner >= 0 ? index - window.length + determiner : index;
  if (tokens[start - 1] !== "and") return false;
  const from = isNumberedAuxiliary(tokens[opener] ?? "") ? opener + 1 : 0;
  return tokens.slice(from, start - 1).every((token) => !isVerbToken(token));
}

/**
 * Rzeczownik z `NUMBERLESS_NOUNS` jako podmiot bez słowa ustalającego liczbę: tuż przed am/is/are,
 * do/does albo formą Present Simple albo po am/is/are, do/does otwierających pytanie („Is the sheep
 * eating?”), poza podmiotem złożonym z „and”. „Tom is feeding the fish.” — dopełnienie, nie podmiot.
 */
function numberlessSubjectIn(text: string): string | undefined {
  for (const tokens of text.split(SENTENCE_BOUNDARY).map(tenseTokens)) {
    const opener = tokens[0] === "what" ? 1 : 0;
    for (const [index, token] of tokens.entries()) {
      if (!NUMBERLESS_NOUNS.has(token) || numberlessNounBeForm(tokens, index) !== undefined) continue;
      if (inCompoundSubject(tokens, index, opener)) continue;
      const next = tokens[index + 1] ?? "";
      const verbAfter = isNumberedAuxiliary(next) || presentSimpleBaseOf(next) !== undefined;
      const inverted = index > opener && isNumberedAuxiliary(tokens[opener]!) && tokens.slice(opener + 1, index).every((previous) => !isVerbToken(previous));
      if (verbAfter || inverted) return token;
    }
  }
  return undefined;
}

/**
 * Typy, w których dziecko samo wybiera albo pisze formę po fish / sheep / deer; w klockach i przekształceniu
 * formę daje ćwiczenie (klocek, zdanie wyjściowe).
 */
const NUMBERLESS_SUBJECT_TYPES: ReadonlySet<string> = new Set([
  "lesson_gap",
  "lesson_choice",
  "lesson_listen_choice",
  "lesson_short_answer",
  "lesson_error_fix",
  "lesson_open_answer",
]);

/**
 * Klucz z podmiotem fish / sheep / deer bez słowa ustalającego liczbę (krytycy końcowi A i C, Task 16):
 * „Look! The fish ___ (eat).” ma dwa poprawne klucze (is eating / are eating), więc temat odrzuca taki
 * podmiot; wspólna heurystyka „to be” zostaje bez zmian.
 */
function validateNumberlessSubjects(ex: LessonExerciseDraft, errors: LessonRuleIssue[]): void {
  if (!NUMBERLESS_SUBJECT_TYPES.has(ex.exerciseType)) return;
  for (const { field, text } of sentenceAnswersOf(ex)) {
    const sentence = wholeSentenceOf(ex, text);
    const noun = numberlessSubjectIn(sentence);
    if (noun === undefined) continue;
    errors.push(grammarIssue("grammar.pc_numberless_subject", {
      field,
      pl: `${field}: „${noun}” ma tę samą formę w liczbie pojedynczej i mnogiej — bez słowa ustalającego liczbę (one, two, this, these) pasuje is i are; dodaj takie słowo albo użyj innego rzeczownika`,
      found: `${field} ${clip(sentence)} has ${clip(noun)} as the subject with no word that fixes its number, so both is and are fit`,
    }));
    return;
  }
}

/**
 * Zgłoszenia, które nie czynią zdania błędnym: klasa pisowni -ing spoza celu i czasownik spoza tabeli
 * dotyczą celu i tabeli, nie angielszczyzny.
 */
const NOT_WRONG_ENGLISH: ReadonlySet<string> = new Set(["grammar.pc_ing_rule_not_allowed", "grammar.pc_verb_outside_table"]);

/**
 * Ocena dystraktora po regułach klucza (`optionErrors`): `wrong` — łamie regułę angielszczyzny albo to
 * literówka formy -ing klucza („is walkking”); `correct` — poprawny, także z formą z tabeli spoza klasy
 * pisowni celu („is writing”); `outside_table` — czasownik spoza tabeli („is feeding”): walidator nie wie,
 * czy to błąd, więc może to być druga poprawna odpowiedź.
 */
function distractorVerdict(option: string, key: string, optionErrors: readonly LessonRuleIssue[]): "wrong" | "correct" | "outside_table" {
  if (optionErrors.some((issue) => !NOT_WRONG_ENGLISH.has(issue.rule))) return "wrong";
  if (!optionErrors.some((issue) => issue.rule === "grammar.pc_verb_outside_table")) return "correct";
  return isIngMisspellingOf(option, key) ? "wrong" : "outside_table";
}

/** Opcja z jednym czasownikiem bez -ing, z do/does i przeczeniem albo bez („feeds”, „doesn't feed”). */
const UNKNOWN_SIMPLE_FORM = /^(?:(?:do|does)(?:n't|n’t| not)? )?[a-z]+(?<!ing)$/i;

function outsideTableDistractorIssue(option: string): LessonRuleIssue {
  return grammarIssue("grammar.pc_distractor_outside_table", {
    field: "options",
    pl: `options: „${option}” ma czasownik spoza tabeli, więc może być drugą poprawną odpowiedzią — dystraktor bierze czasownik z tabeli`,
    found: `option ${clip(option)} uses a verb outside the verb table, so it may be a second correct answer`,
  });
}

/** Operatory innych czasów przed formą podstawową („can read”, „will read”, „did read”). */
const OTHER_TENSE_OPERATORS: ReadonlySet<string> = new Set(["can", "could", "will", "would", "shall", "should", "must", "may", "might", "did"]);

/** Czasowniki tabeli, których forma przeszła (i imiesłów) brzmi jak podstawowa. */
const PAST_SAME_AS_BASE: ReadonlySet<string> = new Set(["read", "put", "cut", "hit"]);

/**
 * Forma podstawowa regularnej formy przeszłej albo imiesłowu czasownika z tabeli („played”, „cried”,
 * „stopped”, „danced”, „read”). shortcut: nieregularne formy (ate, drew, has eaten) nie są rozpoznawane;
 * dopisać tabelę form przeszłych, gdy sonda pokaże takie dystraktory.
 */
function pastBaseOf(token: string): string | undefined {
  if (PAST_SAME_AS_BASE.has(token)) return token;
  if (!token.endsWith("ed")) return undefined;
  return [token.slice(0, -2), token.slice(0, -1), `${token.slice(0, -3)}y`, token.slice(0, -3)]
    .find((base) => base.length > 1 && ingFormOf(base) !== undefined);
}

/** Słowa, po których „read”, „played” itd. nie są formą przeszłą orzeczenia („doesn't read”, „to read”, „has played”). */
const NOT_BEFORE_PAST: ReadonlySet<string> = new Set(["do", "does", "not", "to", "was", "were", "has", "have", "had", ...OTHER_TENSE_OPERATORS]);

/** Forma be teraźniejsza, z którą zgadza się forma przeszła lub perfect: was/has ↔ is (am dla was), were/have ↔ are (am dla have). */
const AUXILIARY_AGREES: Readonly<Record<string, readonly string[]>> = { was: ["is", "am"], were: ["are"], has: ["is"], have: ["are", "am"], had: ["is", "am", "are"] };

/**
 * Inny czas w dystraktorze (ponowny przegląd fali 1): operator modalny albo did + forma podstawowa,
 * was/were + -ing, has/have/had + imiesłów, forma przeszła. Taka forma zgodna z podmiotem jest poprawną
 * angielszczyzną w bodźcu („Ola can read a book now.”), więc to druga poprawna odpowiedź. Podmiot: przy
 * operatorze na początku opcji wyboru z luką — z bodźca, w pozostałych — sprzed operatora w opcji.
 */
function otherTenseForm(option: string, gapStem: string | undefined): string | undefined {
  const sentences = option.split(SENTENCE_BOUNDARY).map((text) => tenseTokens(text).flatMap(expandNegatedAuxiliary)).filter((tokens) => tokens.length > 0);
  for (const tokens of sentences) {
    for (const [index, token] of tokens.entries()) {
      const nextIndex = tokens[index + 1] === "not" ? index + 2 : index + 1;
      const next = tokens[nextIndex] ?? "";
      const phrase = tokens.slice(index, nextIndex + 1).join(" ");
      if (OTHER_TENSE_OPERATORS.has(token) && presentSimpleBaseOf(next) === next) return phrase;
      // Pytanie z operatorem na początku („Did Tom swim…?”, „What can Ola read?”): forma podstawowa po podmiocie.
      if (OTHER_TENSE_OPERATORS.has(token) && (index === 0 || (index === 1 && BE_WH_WORDS.has(tokens[0]!)))) {
        const base = tokens.findIndex((candidate, i) => i > nextIndex && presentSimpleBaseOf(candidate) === candidate);
        const between = tokens.slice(nextIndex, base);
        if (base > 0 && between.every((candidate) => !isNumberedAuxiliary(candidate) && ingBaseOf(candidate) === undefined)) {
          return [...tokens.slice(index, nextIndex), "…", tokens[base]!].join(" ");
        }
      }
      if (Object.hasOwn(AUXILIARY_AGREES, token)) {
        const continuous = (token === "was" || token === "were") && next.endsWith("ing");
        const perfect = (token === "has" || token === "have" || token === "had") && pastBaseOf(next) !== undefined;
        if (!continuous && !perfect) continue;
        const expected = index === 0 && gapStem !== undefined ? expectedBeForm(gapStem) : expectedBeAt(tokens, 0, index);
        if (expected === undefined || AUXILIARY_AGREES[token]!.includes(expected)) return phrase;
        continue;
      }
      // Po do/does w zdaniu („Does she read?”) forma podstawowa nie jest formą przeszłą.
      const operator = tokens.slice(0, index).some((previous) => previous === "do" || previous === "does");
      if (!operator && pastBaseOf(token) !== undefined && !NOT_BEFORE_PAST.has(tokens[index - 1] ?? "") && !BE_FORMS.has(tokens[index - 1] ?? "")) return token;
    }
  }
  return undefined;
}

/** Przeczone operatory bez regularnego „-n't” po formie (can't → can, won't → will). */
const NEGATED_AUXILIARIES: Readonly<Record<string, string>> = { "can't": "can", cannot: "can", "won't": "will", "shan't": "shall" };

/** „wasn't” → was not, „didn't” → did not, „can't” → can not (pozostałe tokeny bez zmian). */
function expandNegatedAuxiliary(token: string): string[] {
  const base = NEGATED_AUXILIARIES[token] ?? (token.endsWith("n't") ? token.slice(0, -3) : undefined);
  return base !== undefined && (OTHER_TENSE_OPERATORS.has(base) || Object.hasOwn(AUXILIARY_AGREES, base)) ? [base, "not"] : [token];
}

/** Zdania surowego tekstu z kończącą je interpunkcją. */
const RAW_SENTENCES = /[^.!?;:]+[.!?;:]*/gu;

/**
 * Szyk zdania z formą be (ponowny przegląd fali 1): „not” tylko tuż po am/is/are, forma be nie kończy
 * zdania (poza krótką odpowiedzią Yes/No), a zdanie z „?” zaczyna się od am/is/are albo What + am/is/are
 * — i odwrotnie. „Tom not is watching TV.”, „Look! Ola reading is.”, „Tom is playing now?” mają zły szyk.
 */
function hasWordOrderError(text: string): boolean {
  return (text.match(RAW_SENTENCES) ?? []).some((raw) => {
    const tokens = expandedTokens(raw);
    const beIndex = tokens.findIndex((token) => BE_FORMS.has(token));
    if (beIndex < 0) return false;
    const notMisplaced = tokens.some((token, i) => token === "not" && !BE_FORMS.has(tokens[i - 1] ?? ""));
    const shortAnswer = tokens[0] === "yes" || tokens[0] === "no";
    const beLast = BE_FORMS.has(tokens.at(-1)!) && !shortAnswer;
    return notMisplaced || beLast || raw.trim().endsWith("?") !== isInvertedBe(tokens, 0, beIndex);
  });
}

/** Czy ostatnie zdanie tekstu jest pytaniem (kończy się „?”). */
function isQuestionText(text: string): boolean {
  return /\?["'”’)]*\s*$/u.test(text.trim());
}

/** Tokeny zdania bez „not” (porównanie dystraktora różniącego się od klucza tylko biegunowością). */
function withoutNot(text: string): string {
  return tenseTokens(text).filter((token) => token !== "not").join(" ");
}

/** Zgłoszenie: dystraktor wyboru daje drugie poprawne zdanie. */
function distractorCorrectIssue(option: string, reasonPl: string, reasonEn: string): LessonRuleIssue {
  return grammarIssue("grammar.pc_choice_distractor_correct", {
    field: "options",
    pl: `options: „${option}” też daje poprawne zdanie (${reasonPl}) — dystraktor musi łamać regułę klucza`,
    found: `option ${clip(option)} ${reasonEn}, so it is a second correct answer`,
  });
}

/**
 * Wybór w celach 1, 3, 4 (fala 1 Task 19 i ponowny przegląd): dystraktor inny niż sama forma am/is/are
 * (w luce — zdanie z nim) jest drugą poprawną odpowiedzią, gdy ma poprawny inny czas (`otherTenseForm`),
 * różni się od klucza tylko „not”, a bodziec nie ustala biegunowości (Yes/No przed luką, „not” po niej;
 * jak `validateBeChoiceDistractors`), albo nie łamie żadnej reguły klucza. Za błąd liczy się zły szyk
 * (`hasWordOrderError`), inny kształt niż klucz (pytanie / zdanie oznajmujące), reguła klucza
 * (`validateSentenceAnswer`), wskaźnik „zwykle” albo zakazany, „going to” + czasownik albo czasownik stanu z -ing.
 */
function validateChoiceDistractors(ex: LessonExerciseDraft, objective: string, errors: LessonRuleIssue[]): void {
  if (ex.exerciseType !== "lesson_choice") return;
  const gapStem = ex.stem?.includes("___") === true ? ex.stem : undefined;
  const key = ex.options?.find((option) => option.id === ex.correctOption)?.text ?? ex.answer;
  const keySentence = wholeSentenceOf(ex, key);
  const polarityFixed = gapStem !== undefined &&
    (yesNoBeforeGap(gapStem) !== undefined || expandedTokens(gapStem.split("___", 2)[1] ?? "").includes("not"));
  for (const option of ex.options ?? []) {
    if (option.id === ex.correctOption || parseBeOnly(option.text) !== null) continue;
    const sentence = wholeSentenceOf(ex, option.text);
    const otherTense = otherTenseForm(option.text, gapStem);
    if (otherTense !== undefined) {
      errors.push(distractorCorrectIssue(option.text, `inny czas: „${otherTense}”`, `uses another correct tense (${clip(otherTense)})`));
      continue;
    }
    // Zły szyk to błąd dystraktora także wtedy, gdy różni się od klucza tylko „not” („Tom not is watching”).
    if (hasWordOrderError(sentence)) continue;
    if (!polarityFixed && sentence !== keySentence && withoutNot(sentence) === withoutNot(keySentence)) {
      errors.push(distractorCorrectIssue(option.text, "różni się od klucza tylko przeczeniem", "differs from the key only by not and nothing in the stem fixes the polarity"));
      continue;
    }
    const optionErrors: LessonRuleIssue[] = [];
    validateSentenceAnswer(ex, objective, option.text, "options", true, optionErrors);
    const markers = scanTimeMarkers(sentence, "en");
    const verdict = distractorVerdict(option.text, key, optionErrors);
    const wrong = isQuestionText(sentence) !== isQuestionText(keySentence) || verdict === "wrong" || markers.groups.has("usually") ||
      markers.forbidden.length > 0 || hasGoingToFuture(sentence) || stateVerbIn(sentence, "ing_form") !== undefined;
    if (wrong) continue;
    errors.push(verdict === "correct"
      ? distractorCorrectIssue(option.text, "nie łamie żadnej reguły klucza", "breaks no rule of the key")
      : outsideTableDistractorIssue(option.text));
  }
}

/**
 * Wybór w celu 5 (fala 1 Task 19): każdy dystraktor to klucz z błędnie zapisaną formą -ing
 * (`isIngMisspellingOf`: „is swiming” przy „is swimming”). Inna poprawna forma z tabeli („is running”)
 * albo inny czas byłyby drugą poprawną odpowiedzią.
 */
function validateIngSpellingDistractors(ex: LessonExerciseDraft, errors: LessonRuleIssue[]): void {
  if (ex.exerciseType !== "lesson_choice") return;
  const key = ex.options?.find((option) => option.id === ex.correctOption)?.text ?? ex.answer;
  for (const option of ex.options ?? []) {
    if (option.id === ex.correctOption || isIngMisspellingOf(option.text, key)) continue;
    errors.push(grammarIssue("grammar.pc_ing_spelling_distractor", {
      field: "options",
      pl: `options: „${option.text}” nie jest błędną pisownią formy -ing z klucza „${key}” — w celu pisowni dystraktor to ta sama forma z błędem (swiming)`,
      found: `option ${clip(option.text)} is not the key ${clip(key)} with its -ing form misspelt`,
    }));
  }
}

/** Całe zdania (choice, order, short_answer, transform, open_answer; §6.3, §5.4). */
function validateSentences(ex: LessonExerciseDraft, objective: string, errors: LessonRuleIssue[]): void {
  const pcObjective = PC_FORM_OBJECTIVES.has(objective);
  const gapStem = beChoiceGapStem(ex);
  for (const { field, text } of sentenceAnswersOf(ex)) {
    const contraction = normalizeTokens(text).find((token) => S_CONTRACTIONS.has(token));
    if (contraction !== undefined) {
      errors.push(grammarIssue("grammar.pc_s_contraction", {
        field,
        pl: `${field}: skrót „${contraction}” jest zakazany w kluczu — zapisz pełne „is” (He is playing)`,
        found: `${field} ${clip(text)} uses the contraction ${clip(contraction)}`,
      }));
      continue;
    }
    if (!pcObjective) continue;
    const parsed = gapStem === undefined ? null : parseBeOnly(text);
    if (parsed !== null) validateBeOnlyGapAnswer(ex, gapStem!, parsed, text, field, errors);
    validateSentenceAnswer(ex, objective, text, field, parsed === null, errors);
  }
  validateShortAnswerYesNo(ex, errors);
  if (!pcObjective) return;
  if (gapStem !== undefined) validateBeChoiceDistractors(ex, gapStem, errors);
  if (objective === "ing_spelling") validateIngSpellingDistractors(ex, errors);
  else validateChoiceDistractors(ex, objective, errors);
  const question = shortAnswerQuestion(ex);
  if (question !== undefined) {
    for (const tokens of sentenceTokens(question.text)) validateQuestionWords(tokens, question.field, errors);
  }
  // Tłumaczenie (§5.4): „Mama gotuje” bez kontekstu ma dwa poprawne tłumaczenia.
  if (ex.exerciseType === "lesson_open_answer" && ex.prompt !== undefined) {
    const { groups, strongNow } = scanTimeMarkers(ex.prompt, "pl");
    if (groups.size !== 1 || !groups.has("now")) {
      errors.push(grammarIssue("grammar.pc_translation_now_marker", {
        pl: "prompt: zdanie do tłumaczenia potrzebuje wskaźnika „teraz” (teraz, w tej chwili, Patrz!) i żadnego „zwykle”",
        found: `prompt ${clip(ex.prompt)} needs a now marker and no usually marker`,
      }));
    } else if (!strongNow && isNegativeExercise(ex)) {
      errors.push(nowMarkerBareIssue("prompt", ex.prompt));
    }
  }
}

/** Polskie wskaźniki „teraz” bez dosłownego odpowiednika w angielskim kluczu („Ola właśnie czyta.” → „Ola is reading.”). */
const PL_NOW_WITHOUT_LITERAL: ReadonlySet<string> = new Set(["właśnie", "akurat", "Gdzie jest …", "Gdzie są …"]);

/** Wymienne angielskie wskaźniki „teraz” w kluczu tłumaczenia (dłuższe pierwsze: „right now” zawiera „now”). */
const EN_NOW_PHRASES: readonly (readonly string[])[] = [["right", "now"], ["at", "the", "moment"], ["now"]];

/** Tokeny bez pierwszego wystąpienia frazy albo undefined, gdy jej nie ma. */
function withoutPhrase(tokens: readonly string[], phrase: readonly string[]): string[] | undefined {
  const index = tokens.findIndex((_token, i) => phrase.every((part, offset) => tokens[i + offset] === part));
  return index < 0 ? undefined : tokens.toSpliced(index, phrase.length);
}

/**
 * Klucze tłumaczenia (każdy cel, fala 1 Task 19): wskaźnik polskiego zdania przechodzi do każdego
 * klucza (teraz, w tej chwili, Patrz!… → now, at the moment, Look!…; codziennie, zawsze… → every day,
 * always…), a klucz z now / right now / at the moment bez wykrzyknienia ma w `acceptedAnswers` ten sam
 * klucz z każdym z dwóch pozostałych (miejsce wskaźnika dowolne) — dziecko pisze którykolwiek z nich.
 */
function validateTranslationKeys(ex: LessonExerciseDraft, errors: LessonRuleIssue[]): void {
  if (ex.exerciseType !== "lesson_open_answer" || ex.prompt === undefined) return;
  const prompt = scanTimeMarkers(ex.prompt, "pl");
  const literalNow = prompt.nowMarkers.some((entry) => !PL_NOW_WITHOUT_LITERAL.has(entry));
  for (const { field, text } of answersOf(ex)) {
    const { groups } = scanTimeMarkers(text, "en");
    const missing = literalNow && !groups.has("now") ? "now" : prompt.groups.has("usually") && !groups.has("usually") ? "usually" : undefined;
    if (missing !== undefined) {
      errors.push(grammarIssue("grammar.pc_translation_key_marker", {
        field,
        pl: `${field}: polskie zdanie ma wskaźnik „${missing === "now" ? "teraz" : "zwykle"}”, więc tłumaczenie też go ma (teraz → now, codziennie → every day)`,
        found: `${field} ${clip(text)} drops the ${missing} marker of the prompt ${clip(ex.prompt)}`,
      }));
    }
  }
  if (scanTimeMarkers(ex.answer, "en").nowMarkers.some((entry) => entry.endsWith("!"))) return;
  const key = normalizeTokens(ex.answer);
  const used = EN_NOW_PHRASES.find((phrase) => withoutPhrase(key, phrase) !== undefined);
  if (used === undefined) return;
  const core = withoutPhrase(key, used)!.join(" ");
  const variants = ex.acceptedAnswers.map(normalizeTokens);
  const missing = EN_NOW_PHRASES.filter((phrase) => phrase !== used && !variants.some((variant) => withoutPhrase(variant, phrase)?.join(" ") === core));
  if (missing.length > 0) {
    const shown = missing.map((phrase) => phrase.join(" "));
    errors.push(grammarIssue("grammar.pc_translation_now_variants", {
      field: "acceptedAnswers",
      pl: `acceptedAnswers: dodaj klucz z „${shown.join("” i z „")}” zamiast „${used.join(" ")}” — dziecko może napisać każdy z nich`,
      found: `acceptedAnswers lack the answer with ${shown.map((text) => clip(text)).join(" and ")} instead of ${clip(used.join(" "))}`,
    }));
  }
}

/** Osoba podmiotu (heurystyka formy be) i klasy pisowni celu dla reguł Present Simple. */
function presentSimpleContext(objective: string): PresentSimpleContext {
  return { expectedBeForm, allowedRules: PC_ALLOWED_ING_RULES[objective] ?? [] };
}

/**
 * Luka z czasownikiem w nawiasie albo wybór formy do luki w celach porównania
 * (§6.2): Present Continuous jak w celach 1–5, Present Simple z
 * `presentSimpleFormFor` (osoba z bodźca, przeczenie z nawiasu).
 */
function validateTenseFormAnswer(
  ex: LessonExerciseDraft,
  objective: string,
  gap: { stem: string; verb?: string; negative?: boolean },
  answer: string,
  field: string,
  errors: LessonRuleIssue[],
): void {
  const tokens = tenseTokens(answer);
  if (BE_FORMS.has(tokens[0] ?? "")) {
    const verb = gap.verb ?? ingBaseOf(tokens.at(-1)!);
    if (verb === undefined) {
      errors.push(grammarIssue("grammar.pc_verb_outside_table", {
        field,
        pl: `${field}: „${tokens.at(-1)}” jest spoza tabeli form -ing`,
        found: `the -ing form ${clip(tokens.at(-1)!)} in ${field} is not in the verb table`,
      }));
      return;
    }
    validateBeIngGapAnswer(ex, objective, { stem: gap.stem, verb, negative: gap.negative ?? tokens.includes("not") }, answer, field, errors);
    return;
  }
  validatePresentSimpleFormAnswer(answer, gap, presentSimpleContext(objective), field, errors);
}

/** Całe zdanie w celach porównania (§6.3): orzeczenia w Present Simple zgodne z osobą, w Present Continuous jak w celach 1–5. */
function validateTenseSentenceAnswer(
  ex: LessonExerciseDraft,
  objective: string,
  answer: string,
  sentences: readonly TenseSentence[],
  field: string,
  errors: LessonRuleIssue[],
): void {
  if (sentences.every(({ groups }) => groups.length === 0)) {
    errors.push(sentences.some(({ tokens }) => tokens.some((token) => ingBaseOf(token) !== undefined))
      ? grammarIssue("grammar.pc_ing_without_be", {
        field,
        pl: `${field}: przed formą -ing brak am/is/are`,
        found: `${field} ${clip(answer)} has an -ing form without am/is/are`,
      })
      : grammarIssue("grammar.pc_tense_form_missing", {
        field,
        pl: `${field}: brak czasownika z tabeli w Present Simple albo Present Continuous`,
        found: `${field} ${clip(answer)} has no present simple or present continuous verb from the table`,
      }));
    return;
  }
  for (const { tokens, groups } of sentences) {
    for (const group of groups) {
      if (group.tense === "simple") validatePresentSimpleGroup(tokens, group, presentSimpleContext(objective), field, errors);
    }
  }
  if (sentences.some(({ groups }) => groups.some((group) => group.tense === "continuous"))) {
    validateSentenceAnswer(ex, objective, answer, field, true, errors);
  } else {
    for (const { tokens } of sentences) validateQuestionWords(tokens, field, errors);
  }
}

/**
 * Klucz albo opcja w celu porównania: czas każdego orzeczenia zgodny z grupą
 * wskaźników (także w drugim zdaniu składowym: „Mum cooks dinner and Dad is
 * reading now.”), potem forma — w luce i wyborze formy względem bodźca,
 * w pozostałych typach w całym zdaniu.
 */
function validateTenseAnswer(
  ex: LessonExerciseDraft,
  objective: string,
  gap: { stem: string; verb?: string; negative?: boolean } | undefined,
  answer: string,
  field: string,
  group: MarkerGroup | undefined,
  errors: LessonRuleIssue[],
): void {
  const sentences = tenseSentences(gap === undefined ? wholeSentenceOf(ex, answer) : answerSentence(ex, answer));
  validateTenseOfGroups(sentences, group, field, errors);
  if (gap === undefined) {
    validateTenseSentenceAnswer(ex, objective, answer, sentences, field, errors);
  } else {
    validateTenseFormAnswer(ex, objective, gap, answer, field, errors);
  }
}

/**
 * Wybór „now / usually” (§5.5, cel 2): bodziec to jedno zdanie twierdzące
 * w Present Simple albo Present Continuous bez wskaźnika, klucz wynika z czasu
 * zdania. Polecenie nie może zdradzać odpowiedzi scenką jednej grupy
 * („Teraz czy zwykle?” ma obie grupy i niczego nie zdradza).
 */
function validateNowUsuallyChoice(ex: LessonExerciseDraft, objective: string, errors: LessonRuleIssue[]): void {
  const stem = ex.stem ?? "";
  if (scanTimeMarkers(stem, "en").groups.size > 0) {
    errors.push(grammarIssue("grammar.pc_now_usually_stem_marker", {
      pl: "stem: zdanie w wyborze „now / usually” nie może mieć wskaźnika czasu — czas wynika z formy",
      found: `stem ${clip(stem)} has a time marker`,
    }));
  }
  if (ex.instructionPl !== undefined && scanTimeMarkers(ex.instructionPl, "pl", { instruction: true }).groups.size === 1) {
    errors.push(grammarIssue("grammar.pc_now_usually_instruction", {
      pl: "instructionPl: polecenie wyboru „now / usually” zdradza odpowiedź wskaźnikiem albo scenką",
      found: `instructionPl ${clip(ex.instructionPl)} has a marker or a scene of one group`,
    }));
  }
  const sentences = tenseSentences(stem);
  const groups = sentences.flatMap((sentence) => sentence.groups);
  const verbGroup = groups[0];
  const shapeOk = groups.length === 1 && !stem.includes("___") && !stem.includes("?") && !tenseTokens(stem).includes("not");
  if (verbGroup === undefined || !shapeOk) {
    errors.push(grammarIssue("grammar.pc_now_usually_stem_shape", {
      pl: "stem: w wyborze „now / usually” bodziec to jedno zdanie twierdzące w Present Simple albo Present Continuous",
      found: `stem ${clip(stem)} is not one affirmative present simple or present continuous sentence`,
    }));
    return;
  }
  const key = normalizeTokens(ex.options?.find((option) => option.id === ex.correctOption)?.text ?? "").join(" ");
  const expectedKey = verbGroup.tense === "continuous" ? "now" : "usually";
  if (key !== expectedKey) {
    errors.push(grammarIssue("grammar.pc_now_usually_key", {
      pl: `correctOption: zdanie w ${TENSE_NAMES[verbGroup.tense]} wymaga odpowiedzi „${expectedKey}”`,
      found: `the correct option is ${clip(key)}, but a ${TENSE_NAMES[verbGroup.tense]} stem requires ${clip(expectedKey)}`,
    }));
  }
  if (verbGroup.tense === "continuous") {
    validateSentenceAnswer(ex, objective, stem, "stem", true, errors);
  } else {
    const sentence = sentences.find((candidate) => candidate.groups.length > 0)!;
    validatePresentSimpleGroup(sentence.tokens, verbGroup, presentSimpleContext(objective), "stem", errors);
  }
}

/**
 * Cele porównania (2, 6; §5.2, §5.5, §6.2, §6.3): wskaźniki jednej grupy,
 * czas klucza i wariantów zgodny z grupą, forma zgodna z osobą, kształt zdań;
 * w wyborze żaden dystraktor nie może spełniać tych samych reguł co klucz.
 */
function validateTenseChoice(ex: LessonExerciseDraft, objective: string, errors: LessonRuleIssue[]): void {
  if (objective === "now_or_usually" && isNowUsuallyChoice(ex)) {
    validateNowUsuallyChoice(ex, objective, errors);
    return;
  }
  // §3.1: pytania tylko całymi zdaniami — w luce forma po podmiocie zdradza czas
  // („___ you play…?” → Do, „___ you playing…?” → Are); jeden komunikat zamiast mylących reguł formy.
  const choice = ex.exerciseType === "lesson_choice" || ex.exerciseType === "lesson_listen_choice";
  if (choice && ex.stem !== undefined && isGapQuestion(ex.stem)) {
    errors.push(grammarIssue("grammar.pc_tense_choice_gap_question", {
      pl: "stem: pytanie w wyborze czasu tylko całymi zdaniami w opcjach (Do you play…? / Are you playing…?) — w luce forma po podmiocie zdradza odpowiedź",
      found: `stem ${clip(ex.stem)} puts the gap in a question`,
    }));
    return;
  }
  const group = tenseChoiceMarkerGroup(seenMarkers(ex, objective), scannedFields(ex).map(markersOf), errors);
  errors.push(...tenseChoiceShapeErrors(ex, objective));
  let gap: { stem: string; verb?: string; negative?: boolean } | undefined;
  if (ex.exerciseType === "lesson_gap") {
    // Kształt luki bez nawiasu (luka na formę be, brak czasownika) zgłasza `validateGap`.
    const stripped = ex.stem === undefined ? undefined : stripGapVerb(ex.stem);
    if (stripped?.verb === undefined) return;
    gap = { stem: stripped.stem, verb: stripped.verb, negative: stripped.negative };
  } else if (ex.exerciseType === "lesson_choice" && ex.stem?.includes("___") === true) {
    gap = { stem: ex.stem };
  }
  const answers = ex.exerciseType === "lesson_gap" ? answersOf(ex) : sentenceAnswersOf(ex);
  for (const { field, text } of answers) {
    if (!LEADING_APOSTROPHE.test(text.trim())) validateTenseAnswer(ex, objective, gap, text, field, group, errors);
  }
  if (ex.exerciseType !== "lesson_choice" || group === undefined) return;
  const key = ex.options?.find((option) => option.id === ex.correctOption)?.text ?? ex.answer;
  for (const option of ex.options ?? []) {
    if (option.id === ex.correctOption) continue;
    // Inny poprawny czas („can read”, „played”, „didn't watch”) pasuje do wskaźnika jak klucz (krytyk końcowy A, Task 16).
    const otherTense = otherTenseForm(option.text, gap?.stem);
    if (otherTense !== undefined) {
      errors.push(grammarIssue("grammar.pc_tense_choice_distractor", {
        pl: `options: „${option.text}” to inny poprawny czas („${otherTense}”) — dystraktor musi być błędny`,
        found: `option ${clip(option.text)} uses another correct tense (${clip(otherTense)}), so it is a second correct answer`,
      }));
      continue;
    }
    const optionErrors: LessonRuleIssue[] = [];
    validateTenseAnswer(ex, objective, gap, option.text, "options", group, optionErrors);
    // Forma bez -ing spoza tabeli („feeds”, „doesn't feed”, „ate”) to czasownik spoza tabeli, nie zła forma;
    // inne czasy czasowników z tabeli wyłapał już `otherTenseForm`.
    const unknownVerb = optionErrors.length === 1 && optionErrors[0]!.rule === "grammar.pc_tense_form_missing" &&
      UNKNOWN_SIMPLE_FORM.test(option.text.trim());
    const verdict = unknownVerb ? "outside_table" : distractorVerdict(option.text, key, optionErrors);
    if (verdict === "correct") {
      errors.push(grammarIssue("grammar.pc_tense_choice_distractor", {
        pl: `options: „${option.text}” też pasuje do wskaźnika i podmiotu — dystraktor musi być błędny`,
        found: `option ${clip(option.text)} fits the time marker and the subject as well as the key`,
      }));
    } else if (verdict === "outside_table") {
      errors.push(outsideTableDistractorIssue(option.text));
    }
  }
}

/**
 * Luka to w silniku 2+ podkreśleń (`fillGap`); reguły tematu szukają „___”,
 * więc bodziec i pytanie krótkiej odpowiedzi dostają jedną postać luki.
 */
function withCanonicalGaps(ex: LessonExerciseDraft): LessonExerciseDraft {
  const canonical = (text: string): string => text.replace(/_{2,}/g, "___");
  return {
    ...ex,
    ...(ex.stem === undefined ? {} : { stem: canonical(ex.stem) }),
    ...(ex.prompt === undefined ? {} : { prompt: canonical(ex.prompt) }),
  };
}

/**
 * Opcja wyboru zaczynająca się apostrofem („'re playing” obok „are playing”):
 * normalizacja zdejmuje apostrof z brzegu tokenu, więc opcja nie jest skrótem
 * zaimka i myli dziecko — jak odpowiedź luki (`validateGap`).
 */
function validateChoiceOptionApostrophes(ex: LessonExerciseDraft, errors: LessonRuleIssue[]): void {
  if (ex.exerciseType !== "lesson_choice") return;
  for (const option of ex.options ?? []) {
    if (LEADING_APOSTROPHE.test(option.text.trim())) {
      errors.push(grammarIssue("grammar.pc_leading_apostrophe", {
        field: "options",
        pl: `options: opcja nie może zaczynać się apostrofem („${option.text}”) — zapisz pełną formę am/is/are`,
        found: `option ${clip(option.text)} starts with an apostrophe`,
      }));
    }
  }
}

/**
 * Walidator ćwiczenia tematu Present Continuous; cel z ostatniego segmentu
 * `objectiveId`. Zwraca zgłoszenia reguł `grammar.pc_*` (pusta lista = poprawne).
 */
export function validatePresentContinuousExercise(draft: LessonExerciseDraft): LessonRuleIssue[] {
  if (draft.exerciseType === "lesson_card") return [];
  const ex = withCanonicalGaps(draft);
  const objective = objectiveOf(ex);
  const errors: LessonRuleIssue[] = [];
  validateForbiddenMarkers(ex, errors);
  validateBrackets(ex, errors);
  validateStateVerbs(ex, objective, errors);
  validateChoiceOptionApostrophes(ex, errors);
  validateNumberlessSubjects(ex, errors);
  if (TENSE_CHOICE_OBJECTIVES.has(objective)) validateTenseChoice(ex, objective, errors);
  if (PC_FORM_OBJECTIVES.has(objective)) validateNowContext(ex, objective, errors);
  if (ex.exerciseType === "lesson_gap") {
    validateGapHint(ex, errors);
    validateGap(ex, objective, errors);
  } else if (WHOLE_SENTENCE_TYPES.has(ex.exerciseType)) {
    validateSentences(ex, objective, errors);
  }
  if (ex.exerciseType === "lesson_error_fix") validateErrorFix(ex, objective, errors);
  if (ex.exerciseType === "lesson_transform") validateTransformShape(ex, objective, errors);
  validateTranslationKeys(ex, errors);
  if (ex.exerciseType === "lesson_notice") validateNotice(ex, errors);
  if (ex.exerciseType === "lesson_listen_choice") validateListenChoiceOptions(ex, errors);
  if (ex.exerciseType === "lesson_order") validateOrderMarkers(ex, errors);
  // Reguła luki na formę be i reguła zdania mogą zgłosić tę samą niezgodność formy z podmiotem (`found` się różni).
  const seen = new Set<string>();
  return errors.filter((issue) => {
    const key = `${issue.rule}\u0000${issue.field}\u0000${issue.pl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
