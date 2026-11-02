import { useEffect, useRef } from "react";
import { messages } from "@learning/contracts";
import { ActionButton } from "../../components/ActionButton";
import { ExerciseFrame } from "../ExerciseFrame";
import { ExerciseGuidanceProvider, useExerciseGuidance } from "../exercise-guidance";
import type { ExerciseProps } from "../types";

/**
 * Historyjka na koniec sesji lekcji (`lesson_story`): tytuł, tekst zdań
 * w języku treści i zapowiedź pytań; „Dalej” zamyka prezentację przez
 * `complete-presentation` (nie jest oceniana, nie zużywa budżetu). Układ jak
 * karta lekcji: „Posłuchaj historyjki” w nagłówku za tytułem, ale kolumna
 * odsłuchu stoi zawsze — także pusta — żeby brak nagrania nie przesuwał tytułu.
 * Nagranie gra samo raz po zamontowaniu panelu (kontroler sesji).
 */
export function LessonStoryView({ task, busy, dock, handlers }: ExerciseProps) {
  const nextRef = useRef<HTMLButtonElement>(null);
  const listen = useExerciseGuidance();

  useEffect(() => {
    nextRef.current?.focus({ preventScroll: true });
  }, [task.taskId]);

  if (task.prompt.kind !== "lesson_story") return null;
  const { story, contentLocale } = task.prompt;
  return (
    <ExerciseGuidanceProvider value={null}>
    <ExerciseFrame
      dock={dock}
      task={task}
      content={(
        <article className="kid-lesson-story" data-testid="kid-lesson-story">
          <div className="kid-lesson-story__header" data-testid="kid-lesson-story-header">
            <h2 className="kid-lesson-story__title" data-testid="kid-lesson-story-title">{messages.kid.lessonStoryTitle}</h2>
            <div className="kid-lesson-story__listen" data-testid="kid-lesson-story-listen">{listen}</div>
          </div>
          <p className="kid-lesson-story__text" data-testid="kid-lesson-story-text" lang={contentLocale}>
            {story.sentences.join(" ")}
          </p>
          <p className="kid-lesson-story__lead" data-testid="kid-lesson-story-lead">{messages.kid.lessonStoryQuestionsNext}</p>
        </article>
      )}
      actions={(
        <ActionButton
          ref={nextRef}
          type="button"
          className="kid-primary"
          data-testid="kid-lesson-next"
          disabled={busy}
          onClick={handlers.onComplete}
        >
          {messages.kid.lessonNext}
        </ActionButton>
      )}
    />
    </ExerciseGuidanceProvider>
  );
}
