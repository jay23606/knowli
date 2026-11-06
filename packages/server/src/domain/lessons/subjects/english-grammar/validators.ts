import type { LessonExerciseDraft, LessonTopic } from "../../types";
import { normalizeTokens } from "../../normalize";
import { clip, type LessonRuleIssue } from "../../rules/catalog";
import { listenChoiceSibilantErrors } from "../english/listen-audibility";
import { englishNormalizer } from "../english/normalizer";
import {
  BE_ADVERBS,
  BE_AFFIRMATIVE_CONTRACTIONS,
  BE_CONTRACTED_TOKENS,
  BE_FORM_BY_SUBJECT,
  BE_FORMS,
  BE_POLARITY_PL,
  beAnswerPronounAllowed,
  bePolarityViolations,
  bePronounNearGap,
  beStemContext,
  expectedBeFormNearGap,
  parseBeGapAnswer,
  TRANSFORM_POLARITY,
  type BePolarity,
} from "./be-agreement";
import { validatePresentContinuousExercise } from "./present-continuous-validation";
import { isAcceptablePresentSimpleAnswer, presentSimpleForms } from "./present-simple-forms";
import { grammarIssue } from "./rules";

/**
 * Reguły walidacji specyficzne dla przedmiotu `english_grammar`
 * (design „Generowanie puli” → `subject.validateExercise`). Czysta funkcja:
 * bez bazy, sieci i zegara. Zgłoszenia reguł katalogu gramatyki (`rules.ts`):
 * `pl` to komunikat po polsku, jak w `catalog-validation.ts`, a `found` po
 * angielsku z wartościami dla modelu agenta.
 *
 * Zakres (YAGNI): dla `lesson_gap` z podpowiedzią będącą bezokolicznikiem
 * odpowiedź luki musi być dopuszczalną formą tego czasownika w Present Simple.
 * Dla innych typów brak dodatkowych reguł. NIE implementujemy ogólnej
 * morfologii angielskiej — tylko reguły Present Simple z deklaratywną tabelą
 * wyjątków.
 */

function equivalentText(a: string, b: string): boolean {
  const keys = new Set(englishNormalizer.normalize(a).map((tokens) => tokens.join("\u0000")));
  return englishNormalizer.normalize(b).some((tokens) => keys.has(tokens.join("\u0000")));
}

function operatorAnswer(answer: string): { operator: "do" | "does"; negative: boolean } | null {
  const tokens = normalizeTokens(answer);
  if (tokens.length === 1 && (tokens[0] === "do" || tokens[0] === "does")) {
    return { operator: tokens[0], negative: false };
  }
  if (tokens.length === 1 && (tokens[0] === "don't" || tokens[0] === "doesn't")) {
    return { operator: tokens[0] === "don't" ? "do" : "does", negative: true };
  }
  if (tokens.length === 2 && (tokens[0] === "do" || tokens[0] === "does") && tokens[1] === "not") {
    return { operator: tokens[0], negative: true };
  }
  return null;
}

function objectiveAllowsOperator(objectiveId: string, negative: boolean): boolean {
  const objective = objectiveId.split(".").at(-1);
  if (objective === "question") return !negative;
  if (objective === "negative") return negative;
  return objective === "short_answers" || objective === "base_form_after_does";
}

function operatorMatchesSubject(stem: string, operator: "do" | "does"): boolean {
  const [before = "", after = ""] = stem.split("___", 2);
  const nearby = [...normalizeTokens(before).reverse(), ...normalizeTokens(after)];
  const pronoun = nearby.find((token) => ["i", "you", "we", "they", "he", "she", "it"].includes(token));
  if (!pronoun) return true;
  return ["he", "she", "it"].includes(pronoun) ? operator === "does" : operator === "do";
}

function hasBaseVerbAfterGap(stem: string, hint?: string): boolean {
  const after = normalizeTokens(stem.split("___", 2)[1] ?? "");
  if (["i", "you", "we", "they", "he", "she", "it"].includes(after[0] ?? "")) after.shift();
  const verb = after[0];
  if (!verb) return false;
  if (hint?.toLowerCase() === "do") {
    const candidates = verb.endsWith("ies") ? [`${verb.slice(0, -3)}y`]
      : verb.endsWith("es") ? [verb.slice(0, -2)]
        : verb.endsWith("s") ? [verb.slice(0, -1)] : [];
    return !candidates.some((candidate) => candidate !== verb && presentSimpleForms(candidate).has(verb));
  }
  if (hint) return verb === hint.toLowerCase();
  const candidates = verb.endsWith("ies") ? [`${verb.slice(0, -3)}y`]
    : verb.endsWith("es") ? [verb.slice(0, -2)]
      : verb.endsWith("s") ? [verb.slice(0, -1)] : [];
  return !candidates.some((candidate) => candidate !== verb && presentSimpleForms(candidate).has(verb));
}

/** Ścieżka pola zgłoszenia: etykieta „lesson_gap” w komunikatach oznacza odpowiedź luki. */
function pathOf(label: string): string {
  return label === "lesson_gap" ? "answer" : label;
}

/** Biegunowość formy „to be” wymagana przez cel tematu „to be”; inne cele → dowolna. */
const TO_BE_POLARITY: Readonly<Record<string, BePolarity>> = {
  affirmative_forms: "affirmative",
  contractions: "affirmative",
  negative_forms: "negative",
};

function toBeObjectivePolarity(objective: string): BePolarity {
  return Object.hasOwn(TO_BE_POLARITY, objective) ? TO_BE_POLARITY[objective]! : "any";
}

/**
 * Zgłoszenia biegunowości tematu „to be”; `requiredBy` (po angielsku, do
 * `found`) nazywa cel albo przekształcenie, które wyznaczyło biegunowość.
 */
function checkBePolarity(
  polarity: BePolarity,
  effectiveNegative: boolean,
  marker: string | undefined,
  field: string,
  answer: string,
  requiredBy: string,
  issues: LessonRuleIssue[],
): void {
  const path = pathOf(field);
  for (const violation of bePolarityViolations(polarity, effectiveNegative, marker)) {
    const pl = `${field}: ${BE_POLARITY_PL[violation]}`;
    switch (violation) {
      case "yes_negative":
        issues.push(grammarIssue("grammar.be_yes_negative", {
          field: path,
          pl,
          found: `${path} ${clip(answer)} is negated although the reply starts with "Yes"`,
        }));
        break;
      case "no_affirmative":
        issues.push(grammarIssue("grammar.be_no_affirmative", {
          field: path,
          pl,
          found: `${path} ${clip(answer)} is not negated although the reply starts with "No"`,
        }));
        break;
      case "negated":
        issues.push(grammarIssue("grammar.be_negative_in_affirmative_objective", {
          field: path,
          pl,
          found: `${path} ${clip(answer)} is negated, but ${requiredBy} is affirmative`,
        }));
        break;
      case "not_negated":
        issues.push(grammarIssue("grammar.be_missing_negation", {
          field: path,
          pl,
          found: `${path} ${clip(answer)} has no negation, but ${requiredBy} requires "not"`,
        }));
        break;
    }
  }
}

/** Zgłoszenie: skrócona krótka odpowiedź twierdząca (wspólne dla luki i odpowiedzi tekstowej). */
function shortAnswerContractionIssue(field: string, rawLast: string, answer: string): LessonRuleIssue {
  return grammarIssue("grammar.be_short_answer_contraction", {
    field: pathOf(field),
    pl: `${field}: krótka odpowiedź twierdząca nie może kończyć się skrótem „${rawLast}” — zapisz pełną formę (Yes, I am)`,
    found: `the affirmative short answer ${clip(answer)} ends with the contraction ${clip(rawLast)}`,
  });
}

/** Zgłoszenie: forma „to be” niezgodna z osobą skrótu (wspólne dla luki i odpowiedzi tekstowej). */
function contractionPersonIssue(field: string, form: string, pronoun: string, answer: string): LessonRuleIssue {
  return grammarIssue("grammar.be_contraction_person", {
    field: pathOf(field),
    pl: `${field}: forma „${form}” nie pasuje do osoby „${pronoun}” ze skrótu`,
    found: `${clip(answer)} pairs the form ${clip(form)} with the pronoun ${clip(pronoun)}`,
  });
}

/** Zgłoszenie: osoba odpowiedzi niezgodna z podmiotem przy luce. */
function answerPersonIssue(field: string, pronoun: string, subject: string, answer: string): LessonRuleIssue {
  return grammarIssue("grammar.be_answer_person", {
    field: pathOf(field),
    pl: `${field}: osoba „${pronoun}” w odpowiedzi nie pasuje do podmiotu „${subject}”`,
    found: `${clip(answer)} uses the person ${clip(pronoun)}, but the subject next to the gap is ${clip(subject)}`,
  });
}

/** Zgłoszenie: forma „to be” niezgodna z podmiotem przy luce. */
function answerFormIssue(field: string, form: string, expected: string, answer: string): LessonRuleIssue {
  return grammarIssue("grammar.be_form_subject", {
    field: pathOf(field),
    pl: `${field}: forma „${form}” nie pasuje do podmiotu (poprawnie: ${expected})`,
    found: `${clip(answer)} uses ${clip(form)}, but the subject requires ${clip(expected)}`,
  });
}

/** Zgłoszenie: forma „to be” niezgodna z osobą w pełnym zdaniu (obie kolejności podmiotu i formy). */
function sentencePersonFormIssue(field: string, form: string, person: string, expected: string, answer: string): LessonRuleIssue {
  return grammarIssue("grammar.be_sentence_person_form", {
    field: pathOf(field),
    pl: `${field}: forma „${form}” nie pasuje do osoby „${person}” (poprawnie: ${expected})`,
    found: `in ${clip(answer)} the form ${clip(form)} does not agree with ${clip(person)} (expected ${clip(expected)})`,
  });
}

/**
 * Reguła luki tematu „to be”: odpowiedź (i każdy wariant) musi być formą
 * am/is/are zgodną z podmiotem przy luce i biegunowością celu. Samo „not”
 * jest poprawne tylko dla celu przeczeń (forma stoi już w zdaniu).
 */
function validateBeGapAnswer(ex: LessonExerciseDraft, answer: string, field: string, issues: LessonRuleIssue[]): void {
  const path = pathOf(field);
  const objective = ex.objectiveId.split(".").at(-1) ?? "";
  const stemCtx = beStemContext(ex.stem);
  if (normalizeTokens(answer).join(" ") === "not") {
    if (objective !== "negative_forms") {
      issues.push(grammarIssue("grammar.be_bare_not", {
        field: path,
        pl: `${field}: odpowiedź „${answer}” nie jest formą czasownika „be” w temacie „to be”`,
        found: `${path} ${clip(answer)} is only "not", allowed in the objective "negative_forms" but not in ${clip(objective)}`,
      }));
    }
    return;
  }
  const lastBeforeGap = ex.stem === undefined
    ? undefined
    : normalizeTokens(ex.stem.split("___", 2)[0] ?? "").at(-1);
  if (lastBeforeGap !== undefined && BE_ADVERBS.has(lastBeforeGap)) {
    issues.push(grammarIssue("grammar.be_adverb_before_gap", {
      field: "stem",
      pl: `${field}: przysłówek „${lastBeforeGap}” stoi po am/is/are (She is always happy), nie przed luką`,
      found: `the adverb ${clip(lastBeforeGap)} stands directly before the gap in ${clip(ex.stem ?? "")}`,
    }));
  }
  const parsed = parseBeGapAnswer(answer);
  if (parsed === null) {
    issues.push(grammarIssue("grammar.be_answer_not_be_form", {
      field: path,
      pl: `${field}: odpowiedź „${answer}” nie jest formą czasownika „be” (am, is, are)`,
      found: `${path} ${clip(answer)} is not a form of "be"`,
    }));
    return;
  }
  if (parsed.pronoun !== undefined && BE_FORM_BY_SUBJECT[parsed.pronoun] !== parsed.form) {
    issues.push(contractionPersonIssue(field, parsed.form, parsed.pronoun, answer));
  }
  if (objective === "short_answers" && !parsed.negative) {
    const rawLast = normalizeTokens(answer).at(-1);
    if (rawLast !== undefined && BE_AFFIRMATIVE_CONTRACTIONS.has(rawLast)) {
      issues.push(shortAnswerContractionIssue(field, rawLast, answer));
    }
  }
  const stemPronoun = ex.stem === undefined ? undefined : bePronounNearGap(ex.stem);
  if (parsed.pronoun !== undefined && stemPronoun !== undefined && !beAnswerPronounAllowed(parsed.pronoun, stemPronoun)) {
    issues.push(answerPersonIssue(field, parsed.pronoun, stemPronoun.pronoun, answer));
  }
  const expected = ex.stem === undefined ? undefined : expectedBeFormNearGap(ex.stem);
  if (expected !== undefined && expected !== parsed.form) {
    issues.push(answerFormIssue(field, parsed.form, expected, answer));
  }
  checkBePolarity(toBeObjectivePolarity(objective), parsed.negative || stemCtx.negative, parsed.marker ?? stemCtx.marker, field, answer, `the objective ${clip(objective)}`, issues);
}

/**
 * Reguła odpowiedzi tekstowych tematu „to be” poza luką: zgodność osoby z
 * formą w pełnym zdaniu (z podmiotami złożonymi), brak do/does oraz
 * biegunowość celu — przy przekształceniu biegunowość celu wyznacza
 * przekształcenie (to_negative/to_affirmative), nie reguła ćwiczenia.
 * Forma będąca odpowiedzią na bodziec z luką (wybór odpowiedzi) jest
 * sprawdzana względem podmiotu w bodźcu.
 */
function validateBeAnswerText(ex: LessonExerciseDraft, answer: string, field: string, issues: LessonRuleIssue[]): void {
  const path = pathOf(field);
  const objective = ex.objectiveId.split(".").at(-1) ?? "";
  const tokens = normalizeTokens(answer).flatMap((token) => BE_CONTRACTED_TOKENS[token] ?? [token]);
  if (tokens.includes("do") || tokens.includes("does")) {
    issues.push(grammarIssue("grammar.be_no_do_does", {
      field: path,
      pl: `${field}: zdanie z „to be” nie używa „do/does”`,
      found: `${path} ${clip(answer)} uses do/does in a "to be" sentence`,
    }));
    return;
  }
  if (objective === "short_answers") {
    // Twierdząca krótka odpowiedź nie może kończyć się samym skrótem (Yes, I'm. jest błędem);
    // przeczenie No, I'm not. jest poprawne, bo po skrócie stoi „not”.
    const rawLast = normalizeTokens(answer).at(-1);
    if (rawLast !== undefined && BE_AFFIRMATIVE_CONTRACTIONS.has(rawLast)) {
      issues.push(shortAnswerContractionIssue(field, rawLast, answer));
      return;
    }
    // Na pytanie o „you” odpowiada się o sobie („I”), nie z perspektywy pytającego.
    const questionTokens = normalizeTokens(ex.prompt ?? ex.stem ?? "");
    const asksAboutYou = BE_FORMS.has(questionTokens[0] ?? "") && questionTokens[1] === "you";
    if (asksAboutYou && tokens.includes("you")) {
      issues.push(grammarIssue("grammar.be_short_answer_you", {
        field: path,
        pl: `${field}: po pytaniu o „you” odpowiedź musi używać osoby „I” (Yes, I am)`,
        found: `${path} ${clip(answer)} answers a question about "you" with "you" instead of "I"`,
      }));
      return;
    }
  }
  const gapContext = ex.stem ?? ex.prompt ?? ex.statement;
  if (gapContext !== undefined && gapContext.includes("___")) {
    // Odpowiedź na bodziec z luką (wybór, krótka odpowiedź) może być wielotokenowa
    // (isn't, am not) — sprawdzamy ją tym samym parserem co odpowiedź luki.
    const parsed = parseBeGapAnswer(answer);
    if (parsed !== null) {
      if (parsed.pronoun !== undefined && BE_FORM_BY_SUBJECT[parsed.pronoun] !== parsed.form) {
        issues.push(contractionPersonIssue(field, parsed.form, parsed.pronoun, answer));
      }
      const stemPronoun = bePronounNearGap(gapContext);
      if (parsed.pronoun !== undefined && stemPronoun !== undefined && !beAnswerPronounAllowed(parsed.pronoun, stemPronoun)) {
        issues.push(answerPersonIssue(field, parsed.pronoun, stemPronoun.pronoun, answer));
      }
      const expected = expectedBeFormNearGap(gapContext);
      if (expected !== undefined && expected !== parsed.form) {
        issues.push(answerFormIssue(field, parsed.form, expected, answer));
      }
      const stemCtx = beStemContext(gapContext);
      checkBePolarity(toBeObjectivePolarity(objective), parsed.negative || stemCtx.negative, parsed.marker ?? stemCtx.marker, field, answer, `the objective ${clip(objective)}`, issues);
      return;
    }
  }
  const firstBeIndex = tokens.findIndex((token) => BE_FORMS.has(token));
  let hasBe = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const next = tokens[i + 1];
    if (next === undefined) continue;
    if (Object.hasOwn(BE_FORM_BY_SUBJECT, token) && BE_FORMS.has(next)) {
      hasBe = true;
      // Podmiot złożony przed pierwszym orzeczeniem: „Tom and I are” — forma to are.
      const compoundSubject = tokens[i - 1] === "and" && firstBeIndex === i + 1;
      const expected = compoundSubject ? "are" : BE_FORM_BY_SUBJECT[token]!;
      if (expected !== next) {
        issues.push(sentencePersonFormIssue(field, next, token, expected, answer));
      }
    }
    if (BE_FORMS.has(token) && Object.hasOwn(BE_FORM_BY_SUBJECT, next)) {
      hasBe = true;
      // Podmiot złożony po inwersji: „Are he and Tom” — forma też musi być are.
      const compoundSubject = tokens[i + 2] === "and";
      const expected = compoundSubject ? "are" : BE_FORM_BY_SUBJECT[next]!;
      if (expected !== token) {
        issues.push(sentencePersonFormIssue(field, token, next, expected, answer));
      }
    }
  }
  if (!hasBe) return;
  const marker = tokens[0] === "yes" || tokens[0] === "no" ? tokens[0] : undefined;
  const fromTransform = ex.transformId !== undefined && Object.hasOwn(TRANSFORM_POLARITY, ex.transformId);
  const polarity = fromTransform ? TRANSFORM_POLARITY[ex.transformId!]! : toBeObjectivePolarity(objective);
  const requiredBy = fromTransform ? `the transform ${clip(ex.transformId!)}` : `the objective ${clip(objective)}`;
  checkBePolarity(polarity, tokens.includes("not"), marker, field, answer, requiredBy, issues);
}

/** Zaimek wymagany przez piktogram bodźca obrazkowego (kto jest na obrazku). */
const VISUAL_SUBJECT_PRONOUN: Readonly<Record<string, string>> = {
  boy: "he",
  girl: "she",
  man: "he",
  woman: "she",
  group: "they",
  dog: "it",
};

/**
 * Ćwiczenie z piktogramem: odpowiedź musi zaczynać się zaimkiem osoby z
 * obrazka, a forma „to be” w bodźcu musi zgadzać się z tą osobą.
 */
function validateVisualPronoun(ex: LessonExerciseDraft, issues: LessonRuleIssue[]): void {
  if (ex.visualSubject === undefined || !Object.hasOwn(VISUAL_SUBJECT_PRONOUN, ex.visualSubject)) return;
  const pronoun = VISUAL_SUBJECT_PRONOUN[ex.visualSubject]!;
  const picture = `the picture (${ex.visualSubject}) requires ${clip(pronoun)}`;
  const answerPronoun = normalizeTokens(ex.answer)[0];
  if (answerPronoun !== undefined && Object.hasOwn(BE_FORM_BY_SUBJECT, answerPronoun) && answerPronoun !== pronoun) {
    issues.push(grammarIssue("grammar.visual_answer_pronoun", {
      pl: `visualSubject: odpowiedź zaczyna się od „${answerPronoun}”, a obrazek wymaga „${pronoun}”`,
      found: `the answer starts with ${clip(answerPronoun)}, ${picture}`,
    }));
  }
  // Opcja oznaczona jako poprawna musi nieść ten sam zaimek co odpowiedź kanoniczna.
  const correctText = ex.options?.find((option) => option.id === ex.correctOption)?.text;
  const correctPronoun = correctText === undefined ? undefined : normalizeTokens(correctText)[0];
  if (correctPronoun !== undefined && Object.hasOwn(BE_FORM_BY_SUBJECT, correctPronoun) && correctPronoun !== pronoun) {
    issues.push(grammarIssue("grammar.visual_option_pronoun", {
      pl: `visualSubject: opcja poprawna zaczyna się od „${correctPronoun}”, a obrazek wymaga „${pronoun}”`,
      found: `the correct option starts with ${clip(correctPronoun)}, ${picture}`,
    }));
  }
  const stemTokens = normalizeTokens(ex.stem ?? "");
  stemTokens.forEach((token, index) => {
    // Podmiotem jest zaimek sąsiadujący z formą „to be” (przed nią albo po niej
    // w pytaniu z inwersją) — zaimki w dopełnieniu („see you”) nie liczą się.
    const next = stemTokens[index + 1];
    const prev = stemTokens[index - 1];
    const isSubject = (next !== undefined && BE_FORMS.has(next)) || (prev !== undefined && BE_FORMS.has(prev));
    if (Object.hasOwn(BE_FORM_BY_SUBJECT, token) && token !== pronoun && isSubject) {
      issues.push(grammarIssue("grammar.visual_stem_pronoun", {
        pl: `visualSubject: zaimek „${token}” w bodźcu nie pasuje do obrazka (poprawnie: ${pronoun})`,
        found: `the stem uses the subject pronoun ${clip(token)}, ${picture}`,
      }));
    }
  });
  // Zaimek tuż przed luką (tylko gdy luka istnieje; marker ___ znika w tokenizacji).
  const stemRaw = ex.stem ?? "";
  const gapIndex = stemRaw.indexOf("___");
  const beforeGapLast = gapIndex < 0 ? undefined : normalizeTokens(stemRaw.slice(0, gapIndex)).at(-1);
  if (beforeGapLast !== undefined && Object.hasOwn(BE_FORM_BY_SUBJECT, beforeGapLast) && beforeGapLast !== pronoun) {
    issues.push(grammarIssue("grammar.visual_stem_pronoun", {
      pl: `visualSubject: zaimek „${beforeGapLast}” w bodźcu nie pasuje do obrazka (poprawnie: ${pronoun})`,
      found: `the stem has ${clip(beforeGapLast)} right before the gap, ${picture}`,
    }));
  }
  const expectedForm = BE_FORM_BY_SUBJECT[pronoun]!;
  for (const form of normalizeTokens(ex.stem ?? "").filter((token) => BE_FORMS.has(token))) {
    if (form !== expectedForm) {
      issues.push(grammarIssue("grammar.visual_stem_be_form", {
        pl: `visualSubject: forma „${form}” w bodźcu nie pasuje do osoby z obrazka (poprawnie: ${expectedForm})`,
        found: `the stem uses the form ${clip(form)}, but the person in the picture (${ex.visualSubject}) requires ${clip(expectedForm)}`,
      }));
    }
  }
}

/**
 * Walidator ćwiczeń przedmiotu. Zwraca zgłoszenia reguł katalogu gramatyki (pusta lista = poprawne).
 */
export function validateEnglishGrammarExercise(
  ex: LessonExerciseDraft,
  topic: LessonTopic,
): LessonRuleIssue[] {
  const issues: LessonRuleIssue[] = [];

  validateVisualPronoun(ex, issues);
  issues.push(...listenChoiceSibilantErrors(ex));

  if (ex.exerciseType === "lesson_open_answer" && ex.prompt !== undefined) {
    const equalAnswer = [ex.answer, ...ex.acceptedAnswers].find((answer) => equivalentText(ex.prompt!, answer));
    if (equalAnswer !== undefined) {
      issues.push(grammarIssue("grammar.translation_prompt_equals_answer", {
        pl: "prompt: bodziec tłumaczenia nie może być równy odpowiedzi ani jej wariantowi",
        found: `prompt ${clip(ex.prompt)} equals the answer ${clip(equalAnswer)}`,
      }));
    }
  }

  if (topic.id === "present_continuous") {
    issues.push(...validatePresentContinuousExercise(ex));
    return issues;
  }

  if (topic.id === "to_be" && ex.exerciseType === "lesson_gap") {
    const beHint = ex.hint?.trim().toLowerCase() ?? "";
    if (beHint !== "" && beHint !== "be") {
      issues.push(grammarIssue("grammar.be_gap_hint", {
        pl: "lesson_gap: hint dla tematu „to be” musi mieć wartość „be” albo być pusty",
        found: `hint ${clip(ex.hint ?? "")} on a "to be" gap`,
      }));
    }
    validateBeGapAnswer(ex, ex.answer, "lesson_gap", issues);
    for (const variant of ex.acceptedAnswers) validateBeGapAnswer(ex, variant, "acceptedAnswers", issues);
  } else if (topic.id === "to_be" && ex.exerciseType !== "lesson_card" && ex.exerciseType !== "lesson_notice") {
    validateBeAnswerText(ex, ex.answer, "answer", issues);
    for (const variant of ex.acceptedAnswers) validateBeAnswerText(ex, variant, "acceptedAnswers", issues);
  } else if (ex.exerciseType === "lesson_gap") {
    const hint = ex.hint?.trim() ?? "";
    const infinitive = hint ? normalizeTokens(hint)[0] : undefined;
    const operator = operatorAnswer(ex.answer);
    const objective = ex.objectiveId.split(".").at(-1);
    const hasAuxiliaryRules = objective === "question" || objective === "negative" || objective === "short_answers" || objective === "base_form_after_does";
    const operatorOnlyIsValid = operator !== null && ex.stem !== undefined &&
      objectiveAllowsOperator(ex.objectiveId, operator.negative) &&
      operatorMatchesSubject(ex.stem, operator.operator) &&
      (objective === "short_answers" || hasBaseVerbAfterGap(ex.stem, infinitive));
    if (operator !== null && hasAuxiliaryRules && !operatorOnlyIsValid) {
      issues.push(grammarIssue("grammar.gap_operator_mismatch", {
        pl: "lesson_gap: operator nie pasuje do celu, podmiotu lub formy czasownika",
        found: `the operator ${clip(ex.answer)} does not fit the objective ${clip(objective ?? "")}, the subject or the verb form in ${clip(ex.stem ?? "")}`,
      }));
    } else if (infinitive !== undefined && !operatorOnlyIsValid && !isAcceptablePresentSimpleAnswer(infinitive, ex.answer)) {
      issues.push(grammarIssue("grammar.gap_present_simple_form", {
        pl: `lesson_gap: odpowiedź „${ex.answer}” nie jest formą czasownika „${infinitive}” w Present Simple`,
        found: `answer ${clip(ex.answer)} is not a Present Simple form of the verb ${clip(infinitive)}`,
      }));
    }
  }

  return issues;
}
