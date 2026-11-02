import { useId } from "react";
import { messages } from "@learning/contracts";
import { ActionButton } from "../../components/ActionButton";
import { useFeedbackCooldown } from "../../screens/useFeedbackCooldown";
import { ExerciseFrame } from "../ExerciseFrame";
import { ExerciseGuidanceProvider, useExerciseGuidance } from "../exercise-guidance";
import type { ExerciseProps } from "../types";

/**
 * Historyjka na koniec sesji lekcji (`lesson_story`): tytuł, tekst zdań
 * w języku treści i zapowiedź pytań; „Dalej” zamyka prezentację przez
 * `complete-presentation` (nie jest oceniana, nie zużywa budżetu). Układ jak
 * karta lekcji: „Posłuchaj historyjki” w nagłówku za tytułem, ale kolumna
 * odsłuchu stoi zawsze — także pusta — żeby brak nagrania nie przesuwał tytułu.
 * Nagranie gra samo raz po zamontowaniu panelu (kontroler sesji). „Dalej”
 * ignoruje aktywację przez krótki cooldown po zamontowaniu: drugie dotknięcie
 * podwójnego dotyku „Dalej” wyniku poprzedniego zadania (ten sam obszar stopki)
 * nie przeskakuje historyjki.
 */
export function LessonStoryView({ task, busy, dock, handlers }: ExerciseProps) {
  const titleId = useId();
  const listen = useExerciseGuidance();
  const next = useFeedbackCooldown<HTMLButtonElement>(handlers.onComplete, [task.taskId], true, true);

  if (task.prompt.kind !== "lesson_story") return null;
  const { story, contentLocale } = task.prompt;
  return (
    <ExerciseGuidanceProvider value={null}>
    <ExerciseFrame
      dock={dock}
      task={task}
      content={(
        <article className="kid-lesson-story" data-testid="kid-lesson-story" aria-labelledby={titleId}>
          <div className="kid-lesson-story__header" data-testid="kid-lesson-story-header">
            <h2 className="kid-lesson-story__title" id={titleId} data-testid="kid-lesson-story-title">{messages.kid.lessonStoryTitle}</h2>
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
          ref={next.buttonRef}
          type="button"
          className="kid-primary"
          data-testid="kid-lesson-next"
          disabled={busy}
          aria-disabled={next.coolingDown || undefined}
          onKeyDown={next.onKeyDown}
          onClick={next.onClick}
        >
          {messages.kid.lessonNext}
        </ActionButton>
      )}
    />
    </ExerciseGuidanceProvider>
  );
}
