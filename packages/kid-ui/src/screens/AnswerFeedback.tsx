import { useEffect, useRef, type ReactElement } from "react";
import { messages, type FeedbackDto } from "@learning/contracts";
import { format } from "../format";
import { isIncompleteWord, joinedText } from "./spelling-diff-view";
import { lessonFeedbackView } from "./lesson-feedback-view";
import { KidIcon } from "../components/KidIcon";
import { useFeedbackCooldown } from "./useFeedbackCooldown";
import { ActionButton } from "../components/ActionButton";
import { LessonAnswerComparison, SpellingPill } from "../components/AnswerSegments";
import { m } from "motion/react";
import { kidFeedbackTitleAnimate, kidFeedbackTitleInitial, kidFeedbackTitleTransition } from "../motion/kid-motion";

export interface AnswerFeedbackProps {
  dto: FeedbackDto | null;
  retry: boolean;
  busy: boolean;
  onNext: () => void;
  /** Neutralne przejście przy komunikacie technicznym lekcji (`not_assessed`). */
  onSkip?: () => void;
}

function feedbackText(feedback: FeedbackDto | null): string {
  const dto = feedback ?? { kind: "not_assessed" as const };
  switch (dto.kind) {
    case "great": return messages.kid.feedbackGreat;
    case "almost": return messages.kid.feedbackAlmost;
    case "capitalization_hint": return format(messages.kid.feedbackCapitalization, { word: dto.correctText ?? "" });
    case "incorrect": return format(messages.kid.feedbackIncorrect, { word: dto.correctText ?? "" });
    case "spelling_hint":
      if (dto.spellingDiff && isIncompleteWord(dto.spellingDiff.given, dto.spellingDiff.expected)) {
        return messages.kid.feedbackSpellingMissingLetters;
      }
      if (dto.spellingDiff?.capitalizationHint) {
        return format(messages.kid.feedbackSpellingCapitalization, { word: dto.correctText ?? "" });
      }
      return messages.kid.feedbackSpelling;
    case "content_matched": return messages.kid.feedbackContentMatched;
    case "not_assessed": return messages.kid.feedbackNotAssessed;
    // Lekcje: tytuł bez odwołania do odsłuchu (lekcje są tekstowe).
    case "lesson_almost": return messages.kid.lessonAlmostTitle;
    case "lesson_hint": return messages.kid.lessonHintTitle;
    // Trener precyzji: odpowiedź poprawna — pochwała, a zachęta do skrócenia
    // jest osobnym wierszem (`hintPl`), nie korektą.
    case "lesson_precision_hint": return messages.kid.feedbackGreat;
  }
}

/** Wynik serwera dla wyboru/pisma; tekst i ton nie są wyliczane z odpowiedzi klienta. */
export function feedbackTone(feedback: FeedbackDto | null): string {
  const dto = feedback ?? { kind: "not_assessed" as const };
  switch (dto.kind) {
    case "great":
    case "capitalization_hint": return "kid-feedback--correct";
    case "almost":
    case "incorrect":
    case "spelling_hint": return "kid-feedback--retry";
    case "content_matched":
    case "not_assessed": return "";
    case "lesson_almost": return "kid-feedback--retry";
    case "lesson_hint": return "kid-feedback--retry";
    case "lesson_precision_hint": return "kid-feedback--correct";
  }
}

export function AnswerFeedbackContent({ dto, busy }: Pick<AnswerFeedbackProps, "dto" | "busy">): ReactElement {
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Moving focus off a written field dismisses the mobile keyboard without scrolling the page.
    titleRef.current?.focus({ preventScroll: true });
  }, [dto]);

  const feedback = dto ?? { kind: "not_assessed" as const };
  const lesson = lessonFeedbackView(dto);
  return (
    <section
      className={["kid-answer-feedback", feedbackTone(dto)].filter(Boolean).join(" ")}
      data-testid="kid-feedback"
      role="status"
      aria-live="polite"
      aria-labelledby="kid-feedback-title"
      aria-busy={busy}
    >
      <div className="kid-feedback-content">
        <m.h2 className="kid-feedback-text" id="kid-feedback-title" ref={titleRef} tabIndex={-1} initial={kidFeedbackTitleInitial} animate={kidFeedbackTitleAnimate} transition={kidFeedbackTitleTransition}>
          {feedback.kind === "incorrect" && feedback.correctText ? (
            <>
              <span className="kid-feedback-answer-label">{messages.kid.feedbackCorrectAnswer}</span>
              <strong className="kid-feedback-answer" data-testid="kid-feedback-correct-answer">{feedback.correctText}</strong>
            </>
          ) : feedbackText(dto)}
        </m.h2>
        {feedback.heardText && (
          <p className="kid-heard-text" data-testid="kid-heard-text">
            {format(messages.kid.feedbackHeard, { word: feedback.heardText })}
          </p>
        )}
        {feedback.fragments && feedback.fragments.length > 0 && (
          <p className="kid-fragments" data-testid="kid-fragments">
            {feedback.fragments.map((fragment, index) => (
              <span
                key={index}
                className={`kid-fragment kid-fragment--${fragment.verdict}`}
                data-testid="kid-fragment"
              >
                {fragment.text}
              </span>
            ))}
          </p>
        )}
        {feedback.spellingDiff && (() => {
          const incomplete = isIncompleteWord(feedback.spellingDiff.given, feedback.spellingDiff.expected);
          return (
            <div className="kid-spelling-diff" data-testid="kid-spelling-diff">
              <p className="kid-visually-hidden">
                {incomplete
                  ? format(messages.kid.spellingMissingAria, {
                      expected: joinedText(feedback.spellingDiff.expected),
                    })
                  : format(messages.kid.spellingDiffAria, {
                      given: joinedText(feedback.spellingDiff.given),
                      expected: joinedText(feedback.spellingDiff.expected),
                    })}
              </p>
              {!incomplete && (
                <div className="kid-spelling-row" data-testid="kid-spelling-given">
                  <span className="kid-spelling-row-label">{messages.kid.spellingYourAnswer}</span>
                  {feedback.spellingDiff.given.map((segment, index) => (
                    <SpellingPill key={index} segment={segment} index={index} variant="given" animation="shake" />
                  ))}
                </div>
              )}
              <div className="kid-spelling-row" data-testid="kid-spelling-expected">
                {!incomplete && <span className="kid-spelling-row-label">{messages.kid.spellingCorrect}</span>}
                {feedback.spellingDiff.expected.map((segment, index) => (
                    <SpellingPill key={index} segment={segment} index={index} variant="expected" animation="pop" />
                ))}
              </div>
            </div>
          );
        })()}
        {/* Feedback lekcji: podpowiedź kategorii, a pod nią odpowiedź dziecka
            i poprawna odpowiedź z zaznaczonymi literami. Kolor nie jest jedynym
            nośnikiem — każdy wiersz ma etykietę tekstową. */}
        {lesson !== null && (lesson.answerSegments !== null || lesson.correctText !== null || lesson.hint !== null) && (
          <div className="kid-lesson-feedback" data-testid="kid-lesson-feedback">
            {lesson.hint !== null && (
              <p className="kid-lesson-feedback__hint" data-testid="kid-lesson-feedback-hint">{lesson.hint}</p>
            )}
            <LessonAnswerComparison
              answerSegments={lesson.answerSegments}
              correctText={lesson.correctText}
              correctSegments={lesson.correctSegments}
            />
          </div>
        )}
      </div>
    </section>
  );
}

export function AnswerFeedbackActions({ dto, retry, busy, onNext }: Partial<Pick<AnswerFeedbackProps, "dto">> & Pick<AnswerFeedbackProps, "retry" | "busy" | "onNext">): ReactElement {
  const { buttonRef, onKeyDown } = useFeedbackCooldown<HTMLButtonElement>(onNext, [dto, retry]);
  return (
    <ActionButton
      ref={buttonRef}
      onKeyDown={onKeyDown}
      type="button"
      className="kid-primary"
      data-testid="kid-next"
      idleNudge
      disabled={busy}
      onClick={onNext}
    >
      <KidIcon name={retry ? "retry" : "arrow-right"} />
      {retry ? messages.kid.feedbackRetry : messages.kid.feedbackNext}
    </ActionButton>
  );
}

export function AnswerFeedbackSecondaryActions({ dto, retry, busy, onSkip }: AnswerFeedbackProps): ReactElement | null {
  const lesson = lessonFeedbackView(dto);
  if (lesson?.technical !== true || !retry || onSkip === undefined) return null;
  return (
    <ActionButton priority="secondary" fullWidth={false} size="sm" type="button" className="kid-flow-secondary" data-testid="kid-technical-next" disabled={busy} onClick={onSkip}>
      <KidIcon name="arrow-right" />
      {messages.kid.feedbackNext}
    </ActionButton>
  );
}

/** Zachowuje samodzielny wariant karty dla klientów spoza ekranu sesji. */
export function AnswerFeedback(props: AnswerFeedbackProps): ReactElement {
  return (
    <div className="kid-answer-feedback-layout">
      <AnswerFeedbackContent dto={props.dto} busy={props.busy} />
      <div className="kid-feedback-actions">
        <AnswerFeedbackActions dto={props.dto} retry={props.retry} busy={props.busy} onNext={props.onNext} />
        <AnswerFeedbackSecondaryActions {...props} />
      </div>
    </div>
  );
}
