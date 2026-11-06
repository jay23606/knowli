import type { RuleCatalog } from "./catalog";

/**
 * Katalog reguł lekcji (spec katalogu reguł §2.2): reguły całej puli
 * (`validatePoolIssues`), limity zagadnienia, ujawnienia odpowiedzi i kontrole
 * modelami (przyjmowanie agenta, `agent/admission.ts`). Przedmiot dopisuje do
 * opisów własne zdania przez `SubjectAgentPolicy.ruleNotes`.
 *
 * Bez importu wartości z `./catalog` (cykl przez `ENGINE_CATALOGS`): katalog
 * deklaruje się przez `satisfies RuleCatalog`, a id sprawdza `defineRules`
 * przy składaniu `ENGINE_CATALOGS`.
 */
export const LESSON_RULES = {
  // Reguły całej puli (`validatePoolIssues`).
  "lesson.listen_reveals_answer": {
    field: "stem",
    kind: "reject",
    when: (ctx) => ctx.listenChoice,
    types: ["lesson_listen_choice", "lesson_open_answer", "lesson_transform", "lesson_error_fix"],
    description:
      "The full sentence of a lesson_listen_choice (the correct option in the gap) is never the answer or an accepted " +
      "variant of a lesson_open_answer, lesson_transform or lesson_error_fix in the lesson, because hearing it would give " +
      "that answer away.",
  },
  // Reguły duplikatów wykluczają się trybem przedmiotu (`validatePoolIssues`).
  "lesson.duplicate_stimulus": {
    field: "exercise",
    kind: "reject",
    when: (ctx) => ctx.deduplication === "exercise",
    description:
      "Within one objective no two exercises of the same type repeat the stimulus (question, sentence, statement, items, " +
      "pairs or text); vary the content, not only the answer.",
  },
  "lesson.duplicate_answer": {
    field: "answer",
    kind: "reject",
    when: (ctx) => ctx.deduplication === "answer",
    description: "No two exercises of the lesson have answers that are equivalent after normalization.",
  },
  // Limity zagadnienia (przyjmowanie agenta).
  "lesson.limit_full": {
    field: "exercise",
    kind: "reject",
    promptBrief: true,
    description:
      "An objective holds at most its exercise limit (target count plus listening allowance plus a small slack); remove " +
      "one of its exercises before submitting another.",
  },
  "lesson.limit_listen": {
    field: "exerciseType",
    kind: "reject",
    types: ["lesson_listen_choice"],
    when: (ctx) => ctx.listenChoice,
    description:
      "An objective holds at most its listening allowance of lesson_listen_choice exercises (its pool and the exercises " +
      "already in the lesson count together); once it is used up, submit other exercise types.",
  },
  // Bezpiecznik haka przedmiotu (`refineGeneratedPool`): odrzucenie bez nazwanej reguły.
  "lesson.refine_unnamed": {
    field: "exercise",
    kind: "internal",
    description: "The subject rejected the exercise without naming a rule; write a different exercise.",
    internalReason:
      "Safeguard: every subject's refineGeneratedPool names the broken rule (hook contract); an unnamed rejection is a " +
      "subject bug, so the agent gets this generic reason instead of a failed objective.",
  },
  // Ujawnienia rozwiązań (tryb `generation`: równoważność po normalizatorze przedmiotu, także warianty).
  "lesson.leak": {
    field: "answer",
    kind: "reject",
    description:
      "The answer of an independent exercise (and each accepted variant) must not appear earlier in the lesson: it differs " +
      "from the answer and sentence of every guided or productive exercise, from every card example and from earlier " +
      "independent answers. Questions of one open-question family may share their model answer.",
  },
  "lesson.leak_source": {
    field: "answer",
    kind: "reject",
    description:
      "An exercise must not show the answer of a later independent exercise of this or another objective (also one " +
      "already in the lesson): its answer and full sentence differ from it.",
  },
  // Kontrole innymi modelami (checker, sędzia podpowiedzi, grader).
  "check.blind_solve": {
    field: "answer",
    kind: "reject",
    when: (ctx) => ctx.policy.blindSolveTypes.some((type) => ctx.exerciseTypes.includes(type)),
    description:
      "An independent solver sees only the child's view (instruction, stimulus, options, word blocks, word bank; the " +
      "material only when the subject's checker needs it), never the key; its answer must match the answer or an accepted " +
      "variant, ignoring letter case, punctuation and contracted forms; pairs, groups and cloze gaps are compared position " +
      "by position. Make the exercise have exactly one solution.",
  },
  "check.variants": {
    field: "acceptedAnswers",
    kind: "sanitize",
    when: (ctx) => ctx.policy.variantCheckTypes.some((type) => ctx.exerciseTypes.includes(type)),
    description:
      "Another model checks every acceptedAnswers variant; a variant not equivalent to the answer is removed (the " +
      "exercise stays) and the result notes the removal. A removed variant is gone for the child: never add it again; if " +
      "the removed wording is a correct answer, make the prompt more specific so only the key fits, or remove_exercise " +
      "and write a different one.",
  },
  "check.hint_judge": {
    field: "hint",
    kind: "reject",
    priority: "hint",
    when: (ctx) => (ctx.policy.hintJudgeTypes ?? []).some((type) => ctx.exerciseTypes.includes(type)),
    description:
      "Another model judges every non-empty hint: it must follow from the material, be correct in the language of the " +
      "instructions and not give away the answer or a required element, even in other words. A rejected hint rejects the " +
      "exercise: fix the hint (null only if no safe hint exists).",
  },
  "check.open_answer": {
    field: "requiredElements",
    kind: "reject",
    when: (ctx) => (ctx.policy.openAnswerCheckTypes ?? []).some((type) => ctx.exerciseTypes.includes(type)),
    description:
      "Two independent solvers answer the open question from the child's view and a grader grades both answers against " +
      "requiredElements; both must be accepted. If a correct answer lacks elements the question does not demand, make " +
      "requiredElements match the question (for “any two”, require what every valid choice satisfies and move examples to " +
      "supplementaryElements) or make the question ask for them; do not drop elements the question genuinely requires. " +
      "If an answer based on the material is graded wrong, check the model answer and criteria against the material, then " +
      "make the question more precise or add the mistake to commonErrors.",
  },
} as const satisfies RuleCatalog;
