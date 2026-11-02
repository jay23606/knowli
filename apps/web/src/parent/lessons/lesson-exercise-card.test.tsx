import { describe, expect, it, vi } from "vitest";
import { MAX_LESSON_TEXT_LENGTH, messages, type LessonDraftDto, type LessonPromptAudioDto } from "@learning/contracts";
import LessonExerciseCard from "./LessonExerciseCard";
import { createLessonSnapshot } from "./lesson-editor-state";
import { renderParentMarkup } from "../test-render";

const OBJ = "english_grammar.present_simple.third_person_s";
const ASSET = "00000000-0000-4000-8000-0000000000aa";

function listenExercise(): LessonDraftDto["exercises"][number] {
  return {
    id: "00000000-0000-4000-8000-000000000033",
    revisionId: "00000000-0000-4000-8000-000000000043",
    exerciseType: "lesson_listen_choice",
    objectiveId: OBJ,
    stem: "He ___ football.",
    answer: "plays",
    acceptedAnswers: [],
    focus: ["plays"],
    options: [{ id: "a", text: "plays" }, { id: "b", text: "play" }],
    correctOption: "a",
  };
}

function render(
  sentenceAudio: LessonPromptAudioDto | null,
  { open = false, editable = true, explanations = false, errors = undefined as string[] | undefined } = {},
): string {
  const draft = {
    id: "00000000-0000-4000-8000-000000000001", deckId: "00000000-0000-4000-8000-000000000002", editNumber: 1, status: "review",
    title: "T", subjectId: "english_grammar", topicId: "present_simple", topicVersion: 1, objectiveIds: [OBJ], examples: {},
    exercises: [listenExercise()], assets: [], rejectedCount: 0, coverage: [],
  } as unknown as LessonDraftDto;
  const ex = createLessonSnapshot(draft, () => "k").form.exercises[0]!;
  return renderParentMarkup(
    <LessonExerciseCard ex={ex} index={0} editable={editable} busy={false} open={open} changed={false} hadAudio={false} errors={errors}
      audio={null} voiceTones={{ styleEnabled: true }} promptAudio={null} explanations={explanations} explanationAudio={null} sentenceAudio={sentenceAudio} lessonDraftId={draft.id} deckId={draft.deckId}
      itemRevisionId="rev" audioLocked={false} calculation={null} onToggle={vi.fn()} onMutate={vi.fn()} onRemove={vi.fn()} onPlay={vi.fn()} />,
  );
}

describe("LessonExerciseCard: Posłuchaj i wybierz", () => {
  it("odznaka typu, informacja o lektorze i odznaka nagrania zdania", () => {
    const markup = render({ state: "ready", assetId: ASSET });
    expect(markup).toContain(messages.lessons.exerciseTypes.lesson_listen_choice);
    expect(markup).toContain('data-testid="exercise-listen-note-0"');
    expect(markup).toContain(messages.lessons.listenChoiceNote);
    expect(markup).toContain('data-testid="exercise-sentence-audio-state-0"');
    expect(markup).toContain(messages.lessons.sentenceAudioState.ready);
    expect(markup).not.toContain(messages.lessons.listenChoiceAudioFailed);
  });

  it("nagranie pending: odznaka generowania, bez tekstu błędu", () => {
    const markup = render({ state: "pending" });
    expect(markup).toContain(messages.lessons.sentenceAudioState.pending);
    expect(markup).not.toContain(messages.lessons.listenChoiceAudioFailed);
  });

  it("nagranie failed: odznaka błędu i sposób naprawy, bez przycisku ponownego nagrania", () => {
    const markup = render({ state: "failed" });
    expect(markup).toContain(messages.lessons.sentenceAudioState.failed);
    expect(markup).toContain('data-testid="exercise-sentence-audio-failed-0"');
    expect(markup).toContain(messages.lessons.listenChoiceAudioFailed);
    expect(markup).not.toContain(messages.lessons.promptAudioRegenerate);
    expect(markup).not.toContain("exercise-prompt-audio-0");
  });

  it("bez stanu nagrania (ćwiczenie zmienione od zapisu): informacja zostaje, odznaki nagrania nie ma", () => {
    const markup = render(null);
    expect(markup).toContain(messages.lessons.listenChoiceNote);
    expect(markup).not.toContain("exercise-sentence-audio-state-0");
  });

  it("edycja: zdanie i opcje, bez polecenia, ponownego nagrania i piktogramu", () => {
    const markup = render({ state: "ready", assetId: ASSET }, { open: true });
    expect(markup).toContain('data-testid="exercise-stem-0"');
    expect(markup).toContain('data-testid="exercise-option-0-1"');
    expect(markup).toContain('data-testid="exercise-correct-0-a"');
    expect(markup).not.toContain('data-testid="exercise-instruction-0"');
    expect(markup).not.toContain('data-testid="exercise-visual-0"');
    expect(markup).not.toContain('data-testid="exercise-voice-tone-0"');
  });
});

describe("LessonExerciseCard: wyjaśnienie błędu", () => {
  it("licznik pokazuje limit pól tekstowych ćwiczenia", () => {
    const markup = render(null, { open: true, explanations: true });
    expect(markup).toContain('data-testid="exercise-explanation-count-0"');
    expect(markup).toContain(`>0/${MAX_LESSON_TEXT_LENGTH}<`);
    expect(markup).toContain(`maxLength="${MAX_LESSON_TEXT_LENGTH}"`);
  });

  it("błąd walidacji wyjaśnienia jest też przy polu, bez prefiksu pola; inne błędy tylko w alercie", () => {
    const markup = render(null, {
      open: true, explanations: true,
      errors: ["explanationPl: wyjaśnienie ma mieć dokładnie jedno zdanie", "Odpowiedź nie może być pusta."],
    });
    expect(markup).toContain('data-testid="exercise-errors-0"');
    const field = markup.slice(markup.indexOf(messages.lessons.explanationLabel));
    expect(field).toContain("aria-invalid=\"true\"");
    expect(field).toContain(">wyjaśnienie ma mieć dokładnie jedno zdanie<");
    expect(field).not.toContain(">explanationPl:");
  });

  it("bez błędów wyjaśnienia pole nie jest oznaczone jako błędne", () => {
    const markup = render(null, { open: true, explanations: true, errors: ["Odpowiedź nie może być pusta."] });
    const field = markup.slice(markup.indexOf(messages.lessons.explanationLabel));
    expect(field).not.toContain("aria-invalid=\"true\"");
  });
});
