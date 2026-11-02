import { useId } from "react";
import { messages } from "@learning/contracts";
import { AnswerGrid } from "../../components/AnswerGrid";
import { ExerciseFrame } from "../ExerciseFrame";
import { ExerciseGuidanceProvider, useExerciseGuidance } from "../exercise-guidance";
import type { ExerciseProps } from "../types";
import { useChoiceKeyboard } from "../useChoiceKeyboard";

/**
 * Pytanie o treść historyjki (`lesson_story_question`): pytanie po polsku jako
 * polecenie ramy, opcje jak w `lesson_choice` (dotknięcie od razu wysyła
 * `choice`, bez „Sprawdź”, „Nie pamiętam” i „Pomiń”), a pod nimi historyjka do
 * ponownego przeczytania. Odsłuch historyjki stoi w nagłówku bloku (nie gra
 * sam); przy wyniku ekran go nie przekazuje, więc kolumna zostaje pusta i tekst
 * się nie przesuwa. Wynik pokazuje wspólny dok; seria i gwiazdka się nie zmieniają.
 */
export function LessonStoryQuestionView({ task, busy, optionOutcomes, dock, handlers }: ExerciseProps) {
  const prompt = task.prompt.kind === "lesson_story_question" ? task.prompt : null;
  const options = prompt ? prompt.options : [];
  const optionRefs = useChoiceKeyboard({
    options,
    busy,
    onChoice: handlers.onAnswerChoice,
  });
  const titleId = useId();
  const listen = useExerciseGuidance();

  if (prompt === null) return null;
  return (
    <ExerciseGuidanceProvider value={null}>
    <ExerciseFrame
      task={task}
      feedbackLayout="flow"
      content={<>
        <AnswerGrid
          options={options.map((option) => ({ id: option.id, label: option.text, content: null }))}
          outcomes={optionOutcomes}
          disabled={busy}
          optionRefs={optionRefs}
          onChoose={handlers.onAnswerChoice}
          className="kid-options"
        />
        <section className="kid-lesson-story kid-lesson-story--reread" data-testid="kid-lesson-story-reread" aria-labelledby={titleId}>
          <div className="kid-lesson-story__header" data-testid="kid-lesson-story-header">
            <h2 className="kid-lesson-story__title" id={titleId} data-testid="kid-lesson-story-title">{messages.kid.lessonStoryRereadTitle}</h2>
            <div className="kid-lesson-story__listen" data-testid="kid-lesson-story-listen">{listen}</div>
          </div>
          <p className="kid-lesson-story__text" data-testid="kid-lesson-story-text" lang={prompt.contentLocale}>
            {prompt.story.sentences.join(" ")}
          </p>
        </section>
      </>}
      dock={dock}
    />
    </ExerciseGuidanceProvider>
  );
}
