import { useRef, useState } from "react";
import { messages } from "@learning/contracts";
import { format } from "../../format";
import { LessonBlockButton } from "../../components/LessonBlockButton";
import { ExerciseFrame } from "../ExerciseFrame";
import { useRetryReset } from "../useRetryReset";
import type { ExerciseProps } from "../types";
import { AssignmentCheckButton, AssignmentPool } from "./AssignmentPool";
import { addToGroup, groupAssignments, groupComplete, groupPool, groupState, itemsIn, removeFromGroup, selectGroup } from "./assignment-state";

/**
 * „Pogrupuj” (`lesson_group`, design szkoły §10.5): grupy jako przełączniki
 * (jedna aktywna, domyślnie pierwsza) z zawartością pod spodem; dotknięcie
 * elementu z puli dodaje go do aktywnej grupy, dotknięcie elementu w grupie
 * oddaje go do puli. Tylko stukanie. „Sprawdź” wysyła przypisania, gdy pula
 * jest pusta.
 */
export function LessonGroupView({ task, busy, dock, handlers }: ExerciseProps) {
  const prompt = task.prompt.kind === "lesson_group" ? task.prompt : null;
  const [state, setState] = useState(() => groupState(prompt?.groups ?? [], prompt?.items ?? []));
  const containerRef = useRef<HTMLDivElement>(null);
  useRetryReset(dock, () => {
    if (prompt) setState(groupState(prompt.groups, prompt.items));
  }, () => containerRef.current?.querySelector("button")?.focus({ preventScroll: true }));
  if (prompt === null) return null;
  const disabled = busy || dock !== undefined;
  const complete = groupComplete(state);
  const pool = groupPool(state);
  const activeGroup = prompt.groups.find((group) => group.id === state.active) ?? null;

  return (
    <ExerciseFrame
      dock={dock}
      task={task}
      content={(
        <div ref={containerRef} className="kid-lesson-group" data-testid="kid-lesson-group">
          <div className="kid-lesson-group__bins">
            {prompt.groups.map((group) => {
              const active = state.active === group.id;
              const members = itemsIn(state, group.id);
              return (
                <section
                  key={group.id}
                  className={`kid-lesson-group__bin${active ? " kid-lesson-group__bin--active" : ""}`}
                  data-testid="kid-lesson-group-bin"
                  aria-label={group.text}
                >
                  <LessonBlockButton
                    type="button"
                    className="kid-lesson-block kid-lesson-group__target"
                    data-testid="kid-lesson-group-target"
                    aria-pressed={active}
                    disabled={disabled}
                    aria-label={format(messages.kid.lessonGroupChoose, { group: group.text })}
                    onClick={() => { setState((current) => selectGroup(current, group.id)); handlers.onEdit(); }}
                  >
                    {group.text}
                  </LessonBlockButton>
                  {members.length === 0 && <span className="kid-hint">{messages.kid.lessonGroupEmpty}</span>}
                  <div className="kid-lesson-group__members" role="list" aria-label={group.text}>
                    {members.map((item) => (
                      <div key={item.id} role="listitem" className="kid-lesson-assign__entry">
                        <LessonBlockButton
                          type="button"
                          className="kid-lesson-block kid-lesson-block--placed"
                          data-testid="kid-lesson-group-member"
                          lang={prompt.contentLocale}
                          disabled={disabled}
                          aria-label={format(messages.kid.lessonGroupRemove, { item: item.text, group: group.text })}
                          onClick={() => { setState((current) => removeFromGroup(current, item.id)); handlers.onEdit(); }}
                        >
                          {item.text}
                        </LessonBlockButton>
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
          {activeGroup && pool.length > 0 && (
            <p className="kid-hint" data-testid="kid-lesson-group-hint" aria-live="polite">
              {format(messages.kid.lessonGroupActiveHint, { group: activeGroup.text })}
            </p>
          )}
          <AssignmentPool
            items={pool}
            className="kid-lesson-assign__pool"
            testId="kid-lesson-group-pool"
            optionTestId="kid-lesson-group-item"
            label={messages.kid.lessonGroupPool}
            disabled={disabled || activeGroup === null}
            lang={prompt.contentLocale}
            labelOf={(item) => (activeGroup ? format(messages.kid.lessonGroupAdd, { item: item.text, group: activeGroup.text }) : item.text)}
            onPick={(itemId) => { setState((current) => addToGroup(current, itemId)); handlers.onEdit(); }}
          />
        </div>
      )}
      actions={(
        <AssignmentCheckButton disabled={disabled} complete={complete} onCheck={() => handlers.onAnswerAssignment(groupAssignments(state))} />
      )}
    />
  );
}
