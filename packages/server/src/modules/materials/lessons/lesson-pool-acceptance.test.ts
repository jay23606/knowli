import { describe, expect, it } from "vitest";
import { englishGrammarSubject } from "../../../domain/lessons/subjects/english-grammar/module";
import { schoolSubject } from "../../../domain/lessons/subjects/school/module";
import type { SubjectModule } from "../../../domain/lessons/types";
import { toExerciseDraft } from "./lesson-drafts";
import { sanitizeFreshLessonDraft } from "./lesson-pool-acceptance";

const OBJECTIVE_ID = "english_grammar.present_simple.third_person_s";

/** Poprawny kształtowo lesson_choice (surowy obiekt z portu); `stem` odróżnia ćwiczenia. */
function choiceRaw(answer: string, stem = `She ___ ${answer}.`) {
  return {
    exerciseType: "lesson_choice",
    objectiveId: OBJECTIVE_ID,
    instructionPl: "Wybierz.",
    stem,
    answer,
    acceptedAnswers: [],
    focus: [],
    options: [
      { id: "a", text: answer },
      { id: "b", text: `${answer}x` },
    ],
    correctOption: "a",
  };
}

describe("sanitizeFreshLessonDraft (wspólna sanityzacja świeżego ćwiczenia)", () => {
  const draftOf = (raw: Record<string, unknown>) => toExerciseDraft(raw as Parameters<typeof toExerciseDraft>[0]);

  it("usuwa pustą tablicę opcjonalną (options: [])", () => {
    const draft = draftOf({ ...choiceRaw("plays"), options: [] });
    expect(draft.options).toEqual([]);
    const result = sanitizeFreshLessonDraft(draft, englishGrammarSubject, null);
    expect(result.draft).not.toHaveProperty("options");
    expect(result.explanationNotes).toEqual([]);
    expect(result.droppedVariants).toBe(0);
  });

  it("usuwa dodatki modelu z ćwiczenia słuchowego (polecenie, podpowiedź, piktogram)", () => {
    const draft = draftOf({
      ...choiceRaw("plays"),
      exerciseType: "lesson_listen_choice",
      instructionPl: "Posłuchaj.",
      hint: "Podpowiedź.",
      visualSubject: "cat",
    });
    expect(draft.instructionPl).toBe("Posłuchaj.");
    const { draft: out } = sanitizeFreshLessonDraft(draft, englishGrammarSubject, null);
    expect(out).not.toHaveProperty("instructionPl");
    expect(out).not.toHaveProperty("hint");
    expect(out).not.toHaveProperty("visualSubject");
  });

  it("familyScope dopisuje sufiks runu do rodziny; null jej nie rusza", () => {
    const draft = draftOf({ ...choiceRaw("plays"), familyId: "f1" });
    expect(sanitizeFreshLessonDraft(draft, englishGrammarSubject, null).draft.familyId).toBe("f1");
    expect(sanitizeFreshLessonDraft(draft, englishGrammarSubject, "3f2a9c1e-0000-4000-8000-000000000000").draft.familyId)
      .toBe("f1-r3f2a9c");
  });

  it("usuwa i zlicza wariant redundantny wobec odpowiedzi kanonicznej", () => {
    const draft = draftOf({ ...choiceRaw("plays"), acceptedAnswers: ["plays", "plays"] });
    const result = sanitizeFreshLessonDraft(draft, englishGrammarSubject, null);
    expect(result.droppedVariants).toBe(2);
    expect(result.draft.acceptedAnswers).toEqual([]);
  });

  it("usuwa ton głosu dla przedmiotu bez TTS promptów, a zostawia go dla przedmiotu z TTS", () => {
    const draft = draftOf({ ...choiceRaw("plays"), voiceTone: "curious" });
    expect(draft.voiceTone).toBe("curious");
    expect(sanitizeFreshLessonDraft(draft, englishGrammarSubject, null).draft).not.toHaveProperty("voiceTone");
    const withTts: SubjectModule = { ...englishGrammarSubject, ttsForPrompts: true };
    expect(sanitizeFreshLessonDraft(draft, withTts, null).draft.voiceTone).toBe("curious");
  });

  it("niepoprawne wyjaśnienie jest usuwane z notami reguł explanation.*; poprawne zostaje bez not", () => {
    const bad = draftOf({ ...choiceRaw("plays"), explanationPl: "Pierwsze zdanie. Drugie zdanie." });
    const dropped = sanitizeFreshLessonDraft(bad, englishGrammarSubject, null);
    expect(dropped.explanationNotes.map((note) => [note.rule, note.field, note.found])).toEqual([
      ["explanation.one_sentence", "explanationPl", 'removed: 2 sentences in "Pierwsze zdanie. Drugie zdanie."'],
    ]);
    expect(dropped.draft).not.toHaveProperty("explanationPl");
    const good = draftOf({ ...choiceRaw("plays"), explanationPl: "Przy he, she, it dodajemy -s." });
    const kept = sanitizeFreshLessonDraft(good, englishGrammarSubject, null);
    expect(kept.explanationNotes).toEqual([]);
    expect(kept.draft.explanationPl).toBe("Przy he, she, it dodajemy -s.");
    // Przedmiot bez wyjaśnień: nota explanation.not_allowed.
    const school = sanitizeFreshLessonDraft(good, schoolSubject, null);
    expect(school.explanationNotes.map((note) => [note.rule, note.found])).toEqual([
      ["explanation.not_allowed", "removed: this subject does not show error explanations"],
    ]);
  });
});
