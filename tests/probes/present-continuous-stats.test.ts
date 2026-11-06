import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { presentContinuousV1 } from "../../packages/server/src/domain/lessons/subjects/english-grammar/topics/present-continuous";
import { presentSimpleV1 } from "../../packages/server/src/domain/lessons/subjects/english-grammar/topics/present-simple";
import type { LessonExerciseDraft, LessonTopic } from "../../packages/server/src/domain/lessons/types";
import { resolveOutsideRepoPath } from "./probe-helpers";
import { pcPoolStats, type PcDumpRejection } from "./present-continuous-stats";

const PC = "english_grammar.present_continuous";
const NOW_OR_USUALLY = `${PC}.now_or_usually`;
const AFFIRMATIVE = `${PC}.affirmative`;

function draft(overrides: Partial<LessonExerciseDraft> & Pick<LessonExerciseDraft, "exerciseType" | "objectiveId">): LessonExerciseDraft {
  return { answer: "x", acceptedAnswers: [], focus: [], ...overrides };
}

describe("pcPoolStats", () => {
  const exercises: LessonExerciseDraft[] = [
    draft({ exerciseType: "lesson_card", objectiveId: NOW_OR_USUALLY, instructionPl: "Cicho! Posłuchaj." }),
    draft({ exerciseType: "lesson_gap", objectiveId: NOW_OR_USUALLY, instructionPl: "Cicho! Tom śpi. Uzupełnij zdanie.", stem: "Tom ___ (sleep)." }),
    draft({ exerciseType: "lesson_gap", objectiveId: NOW_OR_USUALLY, instructionPl: "Uzupełnij zdanie.", stem: "Dad ___ (cook) every day." }),
    draft({ exerciseType: "lesson_gap", objectiveId: AFFIRMATIVE, instructionPl: "Cicho!", stem: "Tom ___ (sleep)." }),
  ];
  const rejections: PcDumpRejection[] = [
    { objectiveId: NOW_OR_USUALLY, kind: "rule", ruleIds: ["grammar.pc_tense_marker_missing", "grammar.pc_verb_outside_table", "grammar.pc_tense_marker_missing"] },
    // Ofiara ujawnienia: `detail` zaczyna się od „adding this exercise would make…”, a id reguły jest tylko w `ruleIds`.
    { objectiveId: AFFIRMATIVE, kind: "leak", ruleIds: ["lesson.leak_source"] },
    { objectiveId: AFFIRMATIVE, kind: "rule", ruleIds: [] },
  ];

  it("liczy scenki i odrzucenia tylko w celach porównania, a id reguł według rodzaju odrzucenia", () => {
    const stats = pcPoolStats(exercises, rejections);
    expect(stats.sceneShare).toBe(0.5);
    expect(stats.sceneShareBroad).toBe(0.5);
    expect(stats.sceneSharePolish).toBe(0.5);
    expect(stats.comparisonAccepted).toBe(2);
    expect(stats.comparisonRejected).toBe(1);
    expect(stats.rejectionShareComparison).toBeCloseTo(1 / 3);
    expect(stats.ruleIdsByKind).toEqual({
      rule: { "grammar.pc_tense_marker_missing": 2, "grammar.pc_verb_outside_table": 1, other: 1 },
      leak: { "lesson.leak_source": 1 },
    });
  });

  it("w open_answer scenkę bierze z prompt, a cel more też jest celem porównania", () => {
    const stats = pcPoolStats(
      [
        draft({ exerciseType: "lesson_open_answer", objectiveId: `${PC}.now_or_usually_more`, instructionPl: "Przetłumacz.", prompt: "Patrz! Mama gotuje obiad." }),
        draft({ exerciseType: "lesson_open_answer", objectiveId: `${PC}.now_or_usually_more`, instructionPl: "Cicho! Przetłumacz.", prompt: "Tata gotuje obiad." }),
      ],
      [],
    );
    expect(stats.comparisonAccepted).toBe(2);
    expect(stats.sceneSharePolish).toBe(0.5);
    expect(stats.sceneShareBroad).toBe(0.5);
    // Ścisła miara pomija tłumaczenia.
    expect(stats.sceneShare).toBe(0);
    expect(stats.rejectionShareComparison).toBe(0);
  });

  it("szersza miara: (a) polska scenka, (b) angielskie wykrzyknienie w tym, co widzi dziecko, (c) wybór całych zdań po zdaniu kontekstu", () => {
    const more = `${PC}.now_or_usually_more`;
    const options = (a: string, b: string) => ({ options: [{ id: "a", text: a }, { id: "b", text: b }], correctOption: "a" });
    const scenes: LessonExerciseDraft[] = [
      // (a) polska scenka w poleceniu
      draft({ exerciseType: "lesson_gap", objectiveId: NOW_OR_USUALLY, instructionPl: "Cicho! Tom śpi. Uzupełnij zdanie.", stem: "Tom ___ (sleep)." }),
      // (b) wykrzyknienie w bodźcu, zdaniu z błędem i angielskim prompcie
      draft({ exerciseType: "lesson_gap", objectiveId: NOW_OR_USUALLY, instructionPl: "Uzupełnij zdanie.", stem: "Look! Tom ___ (run)." }),
      draft({ exerciseType: "lesson_gap", objectiveId: NOW_OR_USUALLY, instructionPl: "Uzupełnij zdanie.", stem: "Look at Ola! She ___ (dance)." }),
      draft({ exerciseType: "lesson_error_fix", objectiveId: more, instructionPl: "Popraw błąd.", statement: "Shh! The baby sleeps." }),
      draft({ exerciseType: "lesson_short_answer", objectiveId: NOW_OR_USUALLY, instructionPl: "Wybierz odpowiedź.", prompt: "Listen! Is Tom singing?" }),
      // (c) wybór całych zdań z bodźcem-zdaniem kontekstu bez luki
      draft({ exerciseType: "lesson_choice", objectiveId: more, instructionPl: "Wybierz pytanie.", stem: "Ola is in a tennis club.", ...options("Does Ola play tennis on Mondays?", "Is Ola playing tennis on Mondays?") }),
    ];
    const notScenes: LessonExerciseDraft[] = [
      // Wskaźnik „teraz”, ale nie scenka: zwykłe „now” w bodźcu
      draft({ exerciseType: "lesson_gap", objectiveId: NOW_OR_USUALLY, instructionPl: "Uzupełnij zdanie.", stem: "Tom ___ (run) now." }),
      // Wykrzyknienie tylko w kluczu albo w opcji się nie liczy
      draft({ exerciseType: "lesson_open_answer", objectiveId: more, instructionPl: "Przetłumacz.", prompt: "Tata gotuje obiad.", answer: "Look! Dad is cooking dinner." }),
      // Wybór z luką
      draft({ exerciseType: "lesson_choice", objectiveId: NOW_OR_USUALLY, instructionPl: "Wybierz formę.", stem: "Ola ___ a comic now.", ...options("is reading", "reads") }),
      // Sprawdzenie znaczenia „now / usually”: bodziec bez luki, ale czas ustala forma czasownika
      draft({ exerciseType: "lesson_choice", objectiveId: NOW_OR_USUALLY, instructionPl: "Kiedy to się dzieje?", stem: "Ola is reading a comic.", ...options("now", "usually") }),
    ];
    const stats = pcPoolStats([...scenes, ...notScenes], []);
    expect(stats.comparisonAccepted).toBe(10);
    expect(stats.sceneSharePolish).toBe(0.1);
    expect(stats.sceneShareBroad).toBe(0.6);
    // Ścisła miara: tylko (a) z 8 ćwiczeń bez tłumaczenia i sprawdzenia znaczenia.
    expect(stats.sceneShare).toBe(1 / 8);
  });

  it("ścisła miara: polska scenka w poleceniu i żaden angielski wskaźnik w bodźcu ani zdaniu z błędem", () => {
    const more = `${PC}.now_or_usually_more`;
    const stats = pcPoolStats(
      [
        draft({ exerciseType: "lesson_gap", objectiveId: NOW_OR_USUALLY, instructionPl: "Cicho! Dziadek śpi. Uzupełnij zdanie.", stem: "Grandpa ___ (sleep) on the sofa." }),
        draft({ exerciseType: "lesson_error_fix", objectiveId: more, instructionPl: "Tom nigdy nie je mięsa. Popraw błąd w zdaniu.", statement: "Tom isn't eating meat." }),
        // Scenka i angielski wskaźnik w bodźcu: dziecko może wypatrzyć słowo.
        draft({ exerciseType: "lesson_gap", objectiveId: NOW_OR_USUALLY, instructionPl: "Cicho! Dziadek śpi. Uzupełnij zdanie.", stem: "Grandpa ___ (sleep) right now." }),
        draft({ exerciseType: "lesson_error_fix", objectiveId: more, instructionPl: "Ola codziennie tańczy. Popraw błąd w zdaniu.", statement: "Ola is dancing every day." }),
        // Bez polskiej scenki.
        draft({ exerciseType: "lesson_gap", objectiveId: NOW_OR_USUALLY, instructionPl: "Uzupełnij zdanie.", stem: "Look! Tom ___ (run)." }),
        // Poza mianownikiem: tłumaczenie.
        draft({ exerciseType: "lesson_open_answer", objectiveId: more, instructionPl: "Przetłumacz.", prompt: "Patrz! Mama gotuje obiad." }),
      ],
      [],
    );
    expect(stats.sceneShare).toBe(2 / 5);
  });

  it("pusta pula daje zera bez dzielenia przez zero", () => {
    const stats = pcPoolStats([], []);
    expect(stats).toEqual({ sceneShare: 0, sceneShareBroad: 0, sceneSharePolish: 0, comparisonAccepted: 0, comparisonRejected: 0, rejectionShareComparison: 0, ruleIdsByKind: {} });
  });
});

describe("zrzuty zagadnień sondy", () => {
  const cases: readonly [string, LessonTopic][] = [
    ["present-continuous-objectives.json", presentContinuousV1],
    ["present-simple-objectives.json", presentSimpleV1],
  ];
  const material = cases.map(([file]) => (JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8")) as { material: string }).material);

  it.each(cases)("%s ma kształt wejścia sondy i zgadza się z katalogiem", (file, topic) => {
    const dump = JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8")) as Record<string, unknown>;
    expect(dump).toMatchObject({ subjectId: "english_grammar", topicId: topic.id, topicVersion: topic.version, topicTitle: topic.titlePl });
    expect(typeof dump.material).toBe("string");
    expect(dump.objectives).toEqual(topic.objectives.map((objective) => ({ id: objective.id, title: objective.titlePl, descriptionEn: objective.descriptionEn, cards: [] })));
  });

  it("oba zrzuty mają ten sam materiał", () => {
    expect(material[0]).toBe(material[1]);
    expect(material[0]!.length).toBeGreaterThan(100);
  });
});

// Statystyki prawdziwego zrzutu sondy (`UMIEM_PROBE_AGENT_DUMP`); drukuje same liczby, bez treści ćwiczeń.
describe("zrzut puli sondy", () => {
  it.runIf(process.env.UMIEM_PC_STATS_DUMP !== undefined && process.env.UMIEM_PC_STATS_DUMP.trim() !== "")("drukuje pcPoolStats", () => {
    const path = resolveOutsideRepoPath(process.env.UMIEM_PC_STATS_DUMP, "UMIEM_PC_STATS_DUMP")!;
    const dump = JSON.parse(readFileSync(path, "utf8")) as { exercises?: LessonExerciseDraft[]; rejections?: PcDumpRejection[] };
    expect(Array.isArray(dump.exercises) && Array.isArray(dump.rejections)).toBe(true);
    const stats = pcPoolStats(dump.exercises!, dump.rejections!);
    console.log(
      JSON.stringify(
        { exercises: dump.exercises!.length, rejections: dump.rejections!.length, ...stats, sceneShare: Number(stats.sceneShare.toFixed(3)), sceneShareBroad: Number(stats.sceneShareBroad.toFixed(3)), sceneSharePolish: Number(stats.sceneSharePolish.toFixed(3)), rejectionShareComparison: Number(stats.rejectionShareComparison.toFixed(3)) },
        null,
        2,
      ),
    );
  });
});
