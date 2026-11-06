import { MIN_SOURCE_QUOTE_LENGTH } from "@learning/contracts";
import type { LessonExerciseDraft, LessonTopic } from "../../types";
import { computeCalculationAnswer, renderCalculationPrompt } from "../../calculation";
import { clip, type LessonRuleIssue } from "../../rules/catalog";
import { quoteGrounding } from "./quote-normalize";
import { schoolIssue } from "./rules";

/**
 * Reguły przedmiotu szkolnego dokładane do walidacji ogólnej puli
 * (`subject.validateExercise`) oraz walidacja całej puli z materiałem
 * (`validatePoolExtra`: uziemienie cytatów i spójność rodzin pytań).
 * Zgłoszenia reguł katalogu szkoły (`rules.ts`): `pl` to dzisiejszy komunikat po
 * polsku z nazwą pola, `found` po angielsku z wartością dla modelu agenta.
 */

const OPEN_TYPE = "lesson_open_answer";
const KEYWORDS_TYPE = "lesson_keywords";

/**
 * Porównanie sformułowań w rodzinie pytań: NFC, zwinięte białe znaki, bez
 * wielkości liter. Osobne od dopasowania cytatów (`quote-normalize.ts`).
 */
function normalizeForPromptComparison(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("pl-PL");
}

/** Słowa tekstu po NFC i małymi literami (litery i cyfry). */
function wordsOf(text: string): string[] {
  return text.normalize("NFC").toLocaleLowerCase("pl-PL").match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Czy pojęcie występuje w tekście z tolerancją polskiej odmiany: każde słowo
 * pojęcia ma w tekście słowo o tym samym początku (słowo bez dwóch ostatnich
 * liter, co najmniej 4 znaki; krótsze słowa muszą wystąpić w całości).
 * „światło” pasuje do „światła”, „cukry” do „cukrów”. Heurystyka uziemienia,
 * nie ocena — rodzic i tak zatwierdza pojęcia.
 */
function termOccursIn(term: string, words: readonly string[]): boolean {
  const termWords = wordsOf(term);
  return termWords.length > 0 && termWords.every((word) => {
    if (word.length <= 4) return words.includes(word);
    const stem = word.slice(0, Math.max(4, word.length - 2));
    return words.some((candidate) => candidate.startsWith(stem));
  });
}

/** Posortowane identyfikatory elementów wymaganych (porównanie rodziny). */
function elementIdsOf(ex: LessonExerciseDraft): string {
  return (ex.requiredElements ?? []).map((el) => el.id).sort((a, b) => a.localeCompare(b)).join(",");
}

/** Pola v3 dozwolone tylko w odpowiedzi otwartej, z dzisiejszymi komunikatami. */
const OPEN_ONLY_FIELDS = [
  ["questionType", "questionType: typ pytania dotyczy tylko odpowiedzi otwartej"],
  ["requiredElements", "requiredElements: elementy wymagane dotyczą tylko odpowiedzi otwartej"],
  ["supplementaryElements", "supplementaryElements: elementy uzupełniające dotyczą tylko odpowiedzi otwartej"],
  ["commonErrors", "commonErrors: typowe błędy dotyczą tylko odpowiedzi otwartej"],
  ["expectedForm", "expectedForm: oczekiwana forma dotyczy tylko odpowiedzi otwartej"],
] as const;

export function validateSchoolExercise(ex: LessonExerciseDraft, _topic: LessonTopic): LessonRuleIssue[] {
  const issues: LessonRuleIssue[] = [];

  // Każde ćwiczenie puli musi mieć uziemienie (obecność; zgodność z materiałem
  // sprawdza validateSchoolPool, które ma dostęp do materiału).
  if (ex.exerciseType !== "lesson_card") {
    if (!ex.sourceRefs || ex.sourceRefs.length === 0) {
      issues.push(schoolIssue("school.quote_required", {
        pl: "sourceRefs: ćwiczenie przedmiotu szkolnego wymaga co najmniej jednego cytatu źródłowego",
        found: ex.sourceRefs ? "sourceRefs is empty" : "sourceRefs is missing",
      }));
    }
  }

  if (ex.exerciseType === "lesson_calculation") {
    if (ex.calculation === undefined) {
      issues.push(schoolIssue("school.calculation_params_required", {
        pl: "calculation: zadanie rachunkowe wymaga parametrów obliczenia",
        found: "calculation is missing",
      }));
    } else {
      try {
        const expectedAnswer = computeCalculationAnswer(ex.calculation).answer;
        const expectedPrompt = renderCalculationPrompt(ex.calculation);
        if (ex.answer !== expectedAnswer) {
          issues.push(schoolIssue("school.calculation_answer_computed", {
            pl: "answer: wynik rachunku musi być zgodny z odpowiedzią obliczoną przez kod",
            found: `answer ${clip(ex.answer)}, computed ${clip(expectedAnswer)}`,
          }));
        }
        if (ex.prompt !== expectedPrompt) {
          issues.push(schoolIssue("school.calculation_prompt_template", {
            pl: "prompt: treść rachunku musi być zgodna z szablonem renderowanym przez kod",
            found: `prompt ${clip(ex.prompt ?? "")}, template ${clip(expectedPrompt)}`,
          }));
        }
      } catch {
        issues.push(schoolIssue("school.calculation_invalid", {
          pl: "calculation: nieprawidłowe parametry obliczenia lub tolerancja wyniku",
          found: `the calculator rejected calculation ${clip(JSON.stringify(ex.calculation))}`,
        }));
      }
    }
    if (ex.acceptedAnswers.length > 0) {
      issues.push(schoolIssue("school.computed_lists_empty", {
        field: "acceptedAnswers",
        pl: "acceptedAnswers: zadanie rachunkowe wymaga pustej listy wariantów",
        found: `acceptedAnswers has ${ex.acceptedAnswers.length} items on lesson_calculation`,
      }));
    }
    if (ex.focus.length > 0) {
      issues.push(schoolIssue("school.computed_lists_empty", {
        field: "focus",
        pl: "focus: zadanie rachunkowe wymaga pustej listy",
        found: `focus has ${ex.focus.length} items on lesson_calculation`,
      }));
    }
  }

  if (ex.exerciseType === OPEN_TYPE) {
    if (!ex.questionType) {
      issues.push(schoolIssue("school.open_required_fields", {
        field: "questionType",
        pl: "questionType: odpowiedź otwarta wymaga typu pytania",
        found: "questionType is missing",
      }));
    }
    if (!ex.requiredElements || ex.requiredElements.length === 0) {
      issues.push(schoolIssue("school.open_required_fields", {
        field: "requiredElements",
        pl: "requiredElements: odpowiedź otwarta wymaga 1–6 elementów wymaganych",
        found: ex.requiredElements ? "requiredElements is empty" : "requiredElements is missing",
      }));
    } else {
      const ids = ex.requiredElements.map((el) => el.id);
      if (new Set(ids).size !== ids.length) {
        const repeated = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
        issues.push(schoolIssue("school.element_ids_unique", {
          pl: "requiredElements: identyfikatory elementów muszą być unikalne w ćwiczeniu",
          found: `repeated ids ${clip(repeated.join(", "))}`,
        }));
      }
    }
    if (!ex.expectedForm) {
      issues.push(schoolIssue("school.open_required_fields", {
        field: "expectedForm",
        pl: "expectedForm: odpowiedź otwarta wymaga oczekiwanej formy",
        found: "expectedForm is missing",
      }));
    }
  } else {
    for (const [field, pl] of OPEN_ONLY_FIELDS) {
      if (ex[field] !== undefined) {
        issues.push(schoolIssue("school.v3_field_type", { field, pl, found: `${field} is set on ${ex.exerciseType}` }));
      }
    }
    if (ex.familyId !== undefined && ex.exerciseType !== KEYWORDS_TYPE) {
      issues.push(schoolIssue("school.v3_field_type", {
        field: "familyId",
        pl: "familyId: rodziny pytań dotyczą tylko odpowiedzi otwartej i słów kluczowych",
        found: `familyId is set on ${ex.exerciseType}`,
      }));
    }
  }

  if (ex.exerciseType === KEYWORDS_TYPE) {
    // Słowa kluczowe poprzedzają konkretną rodzinę pytań otwartych (design 6.1);
    // istnienie tej rodziny w celu sprawdza validateSchoolPool.
    if (!ex.familyId) {
      issues.push(schoolIssue("school.keywords_family_required", {
        pl: "familyId: słowa kluczowe muszą wskazywać rodzinę pytań otwartych",
        found: ex.familyId === undefined ? "familyId is missing" : "familyId is empty",
      }));
    }
    if (ex.acceptedAnswers.length > 0) {
      issues.push(schoolIssue("school.computed_lists_empty", {
        field: "acceptedAnswers",
        pl: "acceptedAnswers: słowa kluczowe wymagają pustej listy wariantów",
        found: `acceptedAnswers has ${ex.acceptedAnswers.length} items on lesson_keywords`,
      }));
    }
    if (ex.focus.length > 0) {
      issues.push(schoolIssue("school.computed_lists_empty", {
        field: "focus",
        pl: "focus: słowa kluczowe wymagają pustej listy",
        found: `focus has ${ex.focus.length} items on lesson_keywords`,
      }));
    }
  }

  return issues;
}

/**
 * Walidacja puli z materiałem: (1) każdy cytat niepochodzący od rodzica musi
 * być fragmentem materiału (po normalizacji typograficznej, `quote-normalize.ts`),
 * (2) ćwiczenia jednej rodziny pytań (cel + familyId) muszą mieć tę samą
 * odpowiedź wzorcową i ten sam zbiór identyfikatorów elementów wymaganych.
 * `rejectedFamilies` (tylko przyjmowanie agenta) to `familyId` pytań otwartych
 * odrzuconych w bieżącym wywołaniu: słowa kluczowe takiej brakującej rodziny
 * dostają osobną regułę kaskady zamiast „brak rodziny”.
 */
export function validateSchoolPool(
  drafts: readonly LessonExerciseDraft[],
  ctx: { readonly material: string; readonly rejectedFamilies?: ReadonlySet<string> },
): ReadonlyMap<number, readonly LessonRuleIssue[]> {
  const errors = new Map<number, LessonRuleIssue[]>();
  const push = (index: number, issue: LessonRuleIssue) => {
    const list = errors.get(index) ?? [];
    list.push(issue);
    errors.set(index, list);
  };

  drafts.forEach((ex, index) => {
    (ex.sourceRefs ?? []).forEach((ref, refIndex) => {
      if (ref.parentAdded === true) return;
      const field = `sourceRefs[${refIndex}].quote`;
      const grounding = quoteGrounding(ref.quote, ctx.material);
      if (grounding.kind === "too_short") {
        push(index, schoolIssue("school.quote_too_short", {
          field,
          pl: `sourceRefs: cytat za krótki, aby uziemiał ćwiczenie (min. ${MIN_SOURCE_QUOTE_LENGTH} znaków)`,
          found: `quote ${refIndex} ${clip(ref.quote)} has ${grounding.length} characters, minimum ${MIN_SOURCE_QUOTE_LENGTH}`,
        }));
      } else if (grounding.kind === "not_in_material") {
        const prefix = grounding.matchedPrefix === ""
          ? "not even its first character occurs there"
          : `the material matches it only up to ${clip(grounding.matchedPrefix)}`;
        push(index, schoolIssue("school.quote_in_material", {
          field,
          pl: "sourceRefs: cytat nie występuje w materiale źródłowym",
          found: `quote ${refIndex} ${clip(ref.quote)} does not occur in the material; ${prefix}`,
        }));
      }
    });
  });

  // Rodzina żyje w obrębie celu: model generuje każdy cel osobną partią i nie zna
  // slugów innych partii, więc ten sam slug w dwóch celach to dwie różne rodziny.
  const families = new Map<string, number[]>();
  drafts.forEach((ex, index) => {
    if (!ex.familyId || ex.exerciseType !== OPEN_TYPE) return;
    const key = JSON.stringify([ex.objectiveId, ex.familyId]);
    const list = families.get(key) ?? [];
    list.push(index);
    families.set(key, list);
  });
  for (const indexes of families.values()) {
    if (indexes.length < 2) continue;
    const familyId = drafts[indexes[0]!]!.familyId!;
    const first = drafts[indexes[0]!]!;
    const firstElements = elementIdsOf(first);
    for (const index of indexes.slice(1)) {
      const ex = drafts[index]!;
      const elements = elementIdsOf(ex);
      const samePrompt =
        normalizeForPromptComparison(ex.prompt ?? "") === normalizeForPromptComparison(first.prompt ?? "") && (ex.prompt ?? "") !== "";
      if (samePrompt) {
        push(index, schoolIssue("school.family_prompt_repeated", {
          pl: `familyId: ćwiczenie z rodziny „${familyId}” powiela tekst pytania innego członka rodziny`,
          found: `prompt ${clip(ex.prompt ?? "")} repeats another member of family ${clip(familyId)}`,
        }));
      }
      // Dzisiejszy komunikat „odpowiedzią wzorcową lub elementami” obsługują dwie reguły
      // z tym samym `pl`; różnica w obu polach daje oba zgłoszenia.
      const differs = `familyId: ćwiczenie z rodziny „${familyId}” różni się odpowiedzią wzorcową lub elementami wymaganymi od reszty rodziny`;
      if (ex.answer.trim() !== first.answer.trim()) {
        push(index, schoolIssue("school.family_answer_differs", {
          pl: differs,
          found: `answer ${clip(ex.answer.trim())}, family ${clip(familyId)} has ${clip(first.answer.trim())}`,
        }));
      }
      if (elements !== firstElements) {
        push(index, schoolIssue("school.family_elements_differ", {
          pl: differs,
          found: `requiredElements ids [${clip(elements, undefined, { quote: false })}], family ${clip(familyId)} has [${clip(firstElements, undefined, { quote: false })}]`,
        }));
      }
    }
  }

  // Słowa kluczowe: rodzina pytań otwartych musi istnieć w tym samym celu, a
  // każde pojęcie kluczowe występuje w jej odpowiedzi wzorcowej albo w materiale
  // (dobór dystraktorów sprawdza rodzic).
  drafts.forEach((ex, index) => {
    if (ex.exerciseType !== KEYWORDS_TYPE || !ex.familyId) return;
    const familyIndexes = families.get(JSON.stringify([ex.objectiveId, ex.familyId])) ?? [];
    const family = familyIndexes[0] === undefined ? undefined : drafts[familyIndexes[0]];
    if (!family && ctx.rejectedFamilies?.has(ex.familyId) === true) {
      push(index, schoolIssue("school.keywords_family_rejected", {
        pl: "familyId: pytanie otwarte tej rodziny odpadło w tym samym wywołaniu",
        found: `the lesson_open_answer with familyId ${clip(ex.familyId)} was rejected in this call; submit these keywords again together with the corrected open question`,
      }));
      return;
    }
    if (!family) {
      push(index, schoolIssue("school.keywords_family_missing", {
        pl: `familyId: brak rodziny pytań otwartych „${ex.familyId}” w tym zagadnieniu`,
        found: `no lesson_open_answer with familyId ${clip(ex.familyId)} in this objective`,
      }));
      return;
    }
    const haystack = [...wordsOf(family.answer), ...wordsOf(ctx.material)];
    const textById = new Map((ex.keywordOptions ?? []).map((option) => [option.id, option.text] as const));
    for (const id of ex.keyOptionIds ?? []) {
      const term = textById.get(id);
      if (term !== undefined && !termOccursIn(term, haystack)) {
        push(index, schoolIssue("school.keyword_not_in_answer", {
          pl: `keyOptionIds: pojęcie kluczowe „${term}” nie występuje w odpowiedzi wzorcowej ani w materiale`,
          found: `key term ${clip(term)} (option ${clip(id)}) occurs neither in the family's model answer nor in the material`,
        }));
      }
    }
  });

  // Rodzina wariantów liczbowych współdzieli metodę i jednostki, nie wynik.
  const calculationFamilies = new Map<string, number[]>();
  drafts.forEach((ex, index) => {
    if (ex.exerciseType !== "lesson_calculation" || !ex.calculation) return;
    const key = JSON.stringify([ex.objectiveId, ex.calculation.templateFamilyId]);
    const indexes = calculationFamilies.get(key) ?? [];
    indexes.push(index);
    calculationFamilies.set(key, indexes);
  });
  for (const indexes of calculationFamilies.values()) {
    const first = drafts[indexes[0]!]!;
    const firstCalculation = first.calculation!;
    const familyId = firstCalculation.templateFamilyId;
    for (const index of indexes.slice(1)) {
      const ex = drafts[index]!;
      const calculation = ex.calculation!;
      const sameInputUnit = firstCalculation.kind !== "unit_conversion" || (
        calculation.kind === "unit_conversion" && calculation.params.fromUnit === firstCalculation.params.fromUnit
      );
      if (calculation.kind !== firstCalculation.kind || calculation.unit !== firstCalculation.unit || !sameInputUnit) {
        push(index, schoolIssue("school.calculation_family_mismatch", {
          pl: `templateFamilyId: ćwiczenie z rodziny „${familyId}” różni się rodzajem obliczenia lub jednostkami od reszty rodziny`,
          found: `${calculationShape(calculation)}, family ${clip(familyId)} has ${calculationShape(firstCalculation)}`,
        }));
      }
    }
  }

  return errors;
}

/** Rodzaj obliczenia i jednostki do `found` (bez liczb wejścia). */
function calculationShape(calculation: NonNullable<LessonExerciseDraft["calculation"]>): string {
  const fromUnit = calculation.kind === "unit_conversion" ? `, input unit ${clip(calculation.params.fromUnit)}` : "";
  return `kind ${clip(calculation.kind)}, unit ${clip(calculation.unit)}${fromUnit}`;
}
