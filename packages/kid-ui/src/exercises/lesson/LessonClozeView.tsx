import { Fragment, useRef, useState } from "react";
import { messages, type LessonItem } from "@learning/contracts";
import { LessonBlockButton } from "../../components/LessonBlockButton";
import { format } from "../../format";
import { ExerciseFrame } from "../ExerciseFrame";
import { useRetryReset } from "../useRetryReset";
import type { ExerciseProps } from "../types";
import { AssignmentCheckButton, AssignmentPool } from "./AssignmentPool";
import { matchAssignments, matchComplete, matchPool, matchState, placeRight, rightOf, selectSlot } from "./assignment-state";

/**
 * „Uzupełnij tekst” (`lesson_cloze`, design szkoły §13.5; UX: spec
 * 2026-11-02-lesson-cloze-match-ux §4): luka w zdaniu jest przyciskiem i jedynym
 * celem stukania — dziecko dotyka luki (domyślnie aktywna jest pierwsza pusta),
 * potem słowa z banku pod tekstem. Stan to reguły „Połącz w pary”: luki = lewa
 * kolumna, słowa = prawa. Nazwa dostępna luki pochodzi z treści (ukryty polski
 * przedrostek + słowo w `lang` materiału), bez `aria-label`.
 */
export function LessonClozeView({ task, busy, dock, handlers }: ExerciseProps) {
  const prompt = task.prompt.kind === "lesson_cloze" ? task.prompt : null;
  const gaps: LessonItem[] = (prompt?.segments ?? []).flatMap((segment, index) =>
    "gapId" in segment ? [{ id: segment.gapId, text: String(index) }] : []);
  const [state, setState] = useState(() => matchState(gaps, prompt?.words ?? []));
  const containerRef = useRef<HTMLDivElement>(null);
  useRetryReset(dock, () => {
    if (prompt) setState(matchState(gaps, prompt.words));
  }, () => containerRef.current?.querySelector("button")?.focus({ preventScroll: true }));
  if (prompt === null) return null;
  const disabled = busy || dock !== undefined;
  const complete = matchComplete(state);
  const pool = matchPool(state);
  const numberOf = new Map(gaps.map((gap, index) => [gap.id, index + 1] as const));
  const activeNumber = state.active === null ? null : numberOf.get(state.active) ?? null;
  const showChangeHint = complete && pool.length > 0 && !disabled;

  return (
    <ExerciseFrame
      dock={dock}
      task={task}
      content={(
        <div ref={containerRef} className="kid-lesson-cloze" data-testid="kid-lesson-cloze">
          <div className="kid-lesson-cloze__main">
            <p className="kid-lesson-cloze__text" data-testid="kid-lesson-cloze-text">
              {prompt.segments.map((segment, index) => {
                if (!("gapId" in segment)) {
                  return prompt.contentLocale
                    ? <span key={index} data-testid="kid-lesson-cloze-segment" lang={prompt.contentLocale}>{segment.text}</span>
                    : <Fragment key={index}>{segment.text}</Fragment>;
                }
                const n = numberOf.get(segment.gapId) ?? 0;
                const word = rightOf(state, segment.gapId);
                const active = state.active === segment.gapId;
                return (
                  <LessonBlockButton
                    key={segment.gapId}
                    type="button"
                    className={`kid-lesson-block kid-lesson-cloze__gap ${word ? "kid-lesson-cloze__gap--filled" : "kid-lesson-cloze__gap--empty"}${active ? " kid-lesson-cloze__gap--active" : ""}`}
                    data-testid="kid-lesson-cloze-gap"
                    aria-pressed={active}
                    disabled={disabled}
                    onClick={() => { setState((current) => selectSlot(current, segment.gapId)); handlers.onEdit(); }}
                  >
                    {word ? (
                      <>
                        <span className="kid-visually-hidden">{format(messages.kid.lessonClozeGapPrefix, { n })} </span>
                        <span lang={prompt.contentLocale}>{word.text}</span>
                      </>
                    ) : (
                      <>
                        <span className="kid-visually-hidden">{format(messages.kid.lessonClozeGapEmptyLabel, { n })}</span>
                        {active && <span className="kid-lesson-cloze__gap-mark" aria-hidden="true">?</span>}
                      </>
                    )}
                  </LessonBlockButton>
                );
              })}
            </p>
          </div>
          <div className="kid-lesson-cloze__bank">
            <AssignmentPool
              items={pool}
              className="kid-lesson-assign__pool kid-lesson-cloze__pool"
              testId="kid-lesson-cloze-pool"
              optionTestId="kid-lesson-cloze-option"
              label={messages.kid.lessonClozePool}
              disabled={disabled || state.active === null}
              lang={prompt.contentLocale}
              labelOf={(item) => (activeNumber !== null ? format(messages.kid.lessonClozePlace, { n: activeNumber, word: item.text }) : item.text)}
              onPick={(itemId) => { setState((current) => placeRight(current, itemId)); handlers.onEdit(); }}
            />
            <p className="kid-hint kid-lesson-cloze__hint" data-testid="kid-lesson-cloze-hint" aria-live="polite">
              {showChangeHint ? messages.kid.lessonClozeChangeHint : ""}
            </p>
          </div>
        </div>
      )}
      actions={(
        <AssignmentCheckButton disabled={disabled} complete={complete} onCheck={() => handlers.onAnswerAssignment(matchAssignments(state))} />
      )}
    />
  );
}
