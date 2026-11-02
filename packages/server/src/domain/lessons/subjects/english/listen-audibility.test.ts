import { describe, expect, it } from "vitest";
import type { LessonExerciseDraft } from "../../types";
import { listenChoiceSibilantErrors } from "./listen-audibility";

/** Ćwiczenie słuchowe ze zdaniem i opcjami (poprawna jest pierwsza). */
function listen(stem: string, texts: readonly string[], overrides: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_listen_choice",
    objectiveId: "english_grammar.present_simple.third_person_s",
    stem,
    options: texts.map((text, index) => ({ id: String.fromCharCode(97 + index), text })),
    correctOption: "a",
    answer: texts[0]!,
    acceptedAnswers: [],
    focus: [texts[0]!],
    ...overrides,
  };
}

const sibilantErrorsOf = (stem: string, texts: readonly string[]) => listenChoiceSibilantErrors(listen(stem, texts));

describe("listenChoiceSibilantErrors — końcówka -s przed sybilantem za luką", () => {
  it.each([
    ["He ___ snakes.", "play", "plays"],
    ["She ___ soccer.", "like", "likes"],
    ["They ___ shoes.", "wants", "want"],
    ["He ___ zebras.", "draw", "draws"],
    ["She ___ cereal.", "eat", "eats"],
    ["She ___ swimming.", "go", "goes"],
    ["He ___ science.", "study", "studies"],
    ["She ___ songs.", "Likes", "like"],
    ["They ___ salad.", "really like", "really likes"],
    ["He ___ sleeping.", "He's", "He"],
    ["She ___ “snakes”.", "like", "likes"],
    ["She ___ „snakes”.", "like", "likes"],
    ["He says “___” softly.", "cat", "cats"],
    ["He ___ xylophones.", "play", "plays"],
    ["She ___ psychology.", "study", "studies"],
  ])("odrzuca sybilant za luką przy opcjach różnych o -s: %s (%s / %s)", (stem, first, second) => {
    expect(sibilantErrorsOf(stem, [first, second])).not.toEqual([]);
  });

  it.each([
    ["He ___ football.", "play", "plays"],
    ["He ___, sadly.", "play", "plays"],
    ["He says “___”, sadly.", "cat", "cats"],
    ["___ she like snakes?", "Do", "Does"],
    ["She ___ socks.", "watch", "watches"],
    ["She ___ salsa.", "dance", "dances"],
    ["They ___ snakes.", "are", "is"],
    ["She ___ like snakes.", "don't", "doesn't"],
    // /s/ przed /tʃ/ pozostaje słyszalne — za luką musi stać głoska s, z albo sz.
    ["He ___ chips.", "like", "likes"],
    ["She ___ sweets.", "change", "changes"],
    ["He ___ soap.", "use", "uses"],
    ["She ___ sorry.", "say", "says"],
    ["He ___ it.", "like", "likes"],
    // Wiolonczela zaczyna się od /tʃ/, nie od s; X-ray od samogłoski.
    ["He ___ cello music.", "like", "likes"],
    ["She ___ X-rays.", "like", "likes"],
  ])("dopuszcza słyszalną różnicę: %s (%s / %s)", (stem, first, second) => {
    expect(sibilantErrorsOf(stem, [first, second])).toEqual([]);
  });

  it("pomija inne typy ćwiczeń i zdania bez dokładnie jednej luki (zgłasza je walidacja typu)", () => {
    expect(listenChoiceSibilantErrors(listen("He ___ snakes.", ["likes", "like"], { exerciseType: "lesson_choice" }))).toEqual([]);
    expect(sibilantErrorsOf("He ___ snakes ___.", ["likes", "like"])).toEqual([]);
    expect(sibilantErrorsOf("He likes snakes.", ["likes", "like"])).toEqual([]);
  });
});
