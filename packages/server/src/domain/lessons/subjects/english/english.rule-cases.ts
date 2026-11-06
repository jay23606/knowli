import { registerRuleCases } from "../../testing/rule-cases";
import type { LessonExerciseDraft } from "../../types";
import { listenChoiceSibilantErrors } from "./listen-audibility";

/**
 * Przypadki reguł wspólnego fragmentu angielskiego (`rules.ts`) dla testu
 * kompletności `rules/rule-cases.test.ts`. Wołają wspólny walidator, którego
 * używają gramatyka i rozdział.
 */

function listen(stem: string, texts: readonly [string, string]): LessonExerciseDraft {
  return {
    exerciseType: "lesson_listen_choice",
    objectiveId: "english_grammar.present_simple.third_person_s",
    stem,
    options: texts.map((text, index) => ({ id: String.fromCharCode(97 + index), text })),
    correctOption: "a",
    answer: texts[0],
    acceptedAnswers: [],
    focus: [texts[0]],
  };
}

registerRuleCases([
  {
    rule: "english.listen_sibilant_merge",
    violation: () => listenChoiceSibilantErrors(listen("She ___ snakes.", ["like", "likes"])),
    // Wyjątki z opisu reguły: sylabiczne -es i zmiana samogłoski są słyszalne także przed sybilantem.
    boundary: () => [
      ...listenChoiceSibilantErrors(listen("___ she play tennis?", ["Does", "Do"])),
      ...listenChoiceSibilantErrors(listen("He ___ soccer.", ["watches", "watch"])),
    ],
  },
]);
