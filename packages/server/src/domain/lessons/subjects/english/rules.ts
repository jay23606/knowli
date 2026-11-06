import { defineRules, issueFrom } from "../../rules/catalog";

/**
 * Wspólny fragment katalogu reguł przedmiotów angielskich (`english_grammar`,
 * `english_chapter`): oba katalogi rozwijają ten obiekt, więc wpisy są tymi
 * samymi obiektami (rejestr dopuszcza wspólny wpis).
 */
export const ENGLISH_RULES = defineRules({
  "english.listen_sibilant_merge": {
    field: "stem",
    kind: "reject",
    types: ["lesson_listen_choice"],
    description:
      "In lesson_listen_choice, when two options differ only by an -s ending that adds no syllable (like/likes, go/goes, " +
      "study/studies, he/he's), the word right after the gap must not start with an s, z or sh sound (snakes, zoo, shoes, " +
      "city): in continuous speech the ending merges into it. Endings that add a syllable (watch/watches, dance/dances) and " +
      "vowel changes (do/does, say/says) stay audible, so Do/Does before she is fine.",
  },
});

/** Fabryka zgłoszeń wspólnego fragmentu angielskiego. */
export const englishIssue = issueFrom(ENGLISH_RULES);
