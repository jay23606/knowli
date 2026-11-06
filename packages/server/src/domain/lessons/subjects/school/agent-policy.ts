import { baseNormalizer } from "../../normalize";
import { clip, type LessonRuleIssue } from "../../rules/catalog";
import type { LessonExerciseDraft, LessonExerciseType, SubjectAgentPolicy } from "../../types";
import { hintRevealing, type HintRevealing } from "./hint-gate";
import { snapQuote } from "./quote-normalize";
import { schoolIssue } from "./rules";

/**
 * Polityka agenta puli dla przedmiotu `school` (design etapu 1 §4.4, spec
 * katalogu reguł §5.1–5.2): typy rozwiązywane na ślepo i sanityzacja —
 * podpowiedź poza pytaniem otwartym, podpowiedź pytania otwartego zdradzająca
 * odpowiedź (usuwana z notą zamiast odrzucenia ćwiczenia) i cytaty wyrównane
 * do dokładnego fragmentu materiału. Tylko reguły domenowe nad przekazanymi danymi.
 *
 * Listy typów są literałami, nie importem z `module.ts` (ten importuje politykę;
 * cykl zostawiłby stałą w strefie martwej). Zgodność z typami przedmiotu pilnuje test.
 */

/** Zamknięte typy z jednoznaczną odpowiedzią; otwarte, układanki, rachunki i słowa kluczowe bez ślepego rozwiązania. */
const BLIND_SOLVE_TYPES: readonly LessonExerciseType[] = ["lesson_choice", "lesson_match", "lesson_group", "lesson_cloze", "lesson_gap"];

/** Warianty odpowiedzi sprawdza niezależny model tylko przy lukach. */
const VARIANT_CHECK_TYPES: readonly LessonExerciseType[] = ["lesson_gap"];

/** Podpowiedź ma sens wyłącznie przy pytaniu otwartym; rodzic dopisuje ją innym typom w edytorze. */
const HINT_TYPE: LessonExerciseType = "lesson_open_answer";

/** Kontrola otwarta (rozwiązujący + grader) dotyczy wyłącznie pytania otwartego. */
const OPEN_CHECK_TYPE: LessonExerciseType = "lesson_open_answer";

const normalizer = baseNormalizer;

const TARGET_LABELS: Readonly<Record<HintRevealing["target"], string>> = {
  answer: "the answer",
  acceptedAnswer: "the accepted variant",
  requiredElement: "the required element",
};

/**
 * Nota reguły `hint.reveals_words`: zdradzony cel i jego słowa obecne w podpowiedzi, a po nich — co
 * dalej (ćwiczenie jest w puli bez podpowiedzi; ponowne wysłanie bez usunięcia byłoby duplikatem).
 */
function hintRemovedNote(revealing: HintRevealing): LessonRuleIssue {
  const words = revealing.words.map((word) => clip(word)).join(", ");
  return schoolIssue("hint.reveals_words", {
    pl: "hint: podpowiedź zdradzała odpowiedź albo element wymagany i została usunięta",
    found:
      `removed: shares ${words} with ${TARGET_LABELS[revealing.target]} ${clip(revealing.text)}; the exercise is in the ` +
      "pool without a hint (to give it a safe hint, remove_exercise it and submit it again)",
  });
}

/** Nota reguły `school.hint_open_answer_only`: podpowiedź poza pytaniem otwartym usunięta. */
function hintOutsideOpenNote(exerciseType: LessonExerciseType): LessonRuleIssue {
  return schoolIssue("school.hint_open_answer_only", {
    pl: "hint: podpowiedź poza pytaniem otwartym została usunięta",
    found: `removed: ${exerciseType} takes no hint, only lesson_open_answer does`,
  });
}

/**
 * Cytaty modelu (bez `parentAdded`) zastąpione dokładnym fragmentem materiału,
 * do którego pasują po normalizacji (`snapQuote`); wycinek, który sam nie
 * przeszedłby walidacji, zostawia cytat modelu. Bez zmian — ten sam obiekt.
 */
function snappedQuotes(draft: LessonExerciseDraft, material: string): { draft: LessonExerciseDraft; count: number } {
  const refs = draft.sourceRefs;
  if (refs === undefined) return { draft, count: 0 };
  let count = 0;
  const next = refs.map((ref) => {
    if (ref.parentAdded === true) return ref;
    const snapped = snapQuote(ref.quote, material);
    if (snapped === null || snapped === ref.quote) return ref;
    count += 1;
    return { ...ref, quote: snapped };
  });
  return count === 0 ? { draft, count } : { draft: { ...draft, sourceRefs: next }, count };
}

export const schoolAgentPolicy: SubjectAgentPolicy = {
  blindSolveTypes: BLIND_SOLVE_TYPES,
  variantCheckTypes: VARIANT_CHECK_TYPES,
  hintJudgeTypes: [HINT_TYPE],
  openAnswerCheckTypes: [OPEN_CHECK_TYPE],
  checkerNeedsMaterial: true,
  independentReserve: 1,
  slack: 2,
  ruleNotes: {
    "lesson.leak": "If it leaks, ask about a different fact of the material or phrase the question differently.",
    "lesson.leak_source": "Use a different fact or phrase the question differently.",
    // Dzisiejsze teksty sędziego podpowiedzi (unsupported, language, reveals) w jednym dopisku.
    "check.hint_judge":
      "Unsupported: use only facts from the material; not correct Polish: fix the wording; gives the content away: " +
      "hint at the reasoning, not the content; if it cannot be fixed, set it to null.",
    "check.open_answer": "The solvers see the material and the grader checks both answers against it.",
    // Jednoznaczność typów rozwiązywanych na ślepo (sprawdza ją tylko ślepe rozwiązanie).
    "check.blind_solve":
      "lesson_choice has exactly one correct option; in lesson_cloze exactly one bank word fits each gap: never two gaps " +
      "whose words could be swapped.",
  },
  sanitize(draft: LessonExerciseDraft, ctx) {
    const removed: string[] = [];
    const notes: LessonRuleIssue[] = [];
    let current = draft;
    if (current.hint !== undefined) {
      // Poza pytaniem otwartym podpowiedź zawsze odpada (nota `school.hint_open_answer_only`); w pytaniu
      // otwartym — tylko gdy zdradza odpowiedź, wariant albo element wymagany.
      const revealing = current.exerciseType === HINT_TYPE ? hintRevealing(current.hint, current, normalizer) : null;
      if (current.exerciseType !== HINT_TYPE || revealing !== null) {
        const { hint: _hint, ...rest } = current;
        current = rest;
        removed.push("hint");
        notes.push(revealing !== null ? hintRemovedNote(revealing) : hintOutsideOpenNote(current.exerciseType));
      }
    }
    const snapped = snappedQuotes(current, ctx.material);
    if (snapped.count > 0) current = snapped.draft;
    return { draft: current, removed, notes, quotesSnapped: snapped.count };
  },
};
