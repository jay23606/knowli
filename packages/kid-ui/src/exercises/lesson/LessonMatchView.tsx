import { useCallback, useMemo, useRef, useState } from "react";
import { messages, type LessonItem } from "@learning/contracts";
import { LessonBlockButton } from "../../components/LessonBlockButton";
import { ExerciseFrame } from "../ExerciseFrame";
import { useRetryReset } from "../useRetryReset";
import type { ExerciseProps } from "../types";
import { AssignmentCheckButton } from "./AssignmentPool";
import { PairLines } from "./PairLines";
import {
  clearPairSelection,
  pairAssignments,
  pairComplete,
  pairOf,
  pairState,
  tapPairItem,
  type PairSide,
} from "./assignment-state";

/**
 * „Połącz w pary” (`lesson_match`, design szkoły §10.5; UX: spec
 * 2026-11-02-lesson-cloze-match-ux §5): dwie kolumny kafelków, pary łączy linia
 * (`PairLines`). Stuknięcie zaznacza kafelek; stuknięcie w drugiej kolumnie łączy
 * parę, zastępując dotychczasowe pary obu kafelków (reguły w `tapPairItem`).
 * Kierunek dowolny, tylko stukanie — kafelki to przyciski, działają z klawiatury.
 * Nazwa dostępna z treści (tekst + ukryte polskie dopowiedzenie), bez `aria-label`;
 * `lang` materiału tylko na tekście lewej kolumny (prawa bywa polska).
 * „Sprawdź” wysyła przypisania, gdy każdy lewy kafelek ma parę.
 */
export function LessonMatchView({ task, busy, dock, handlers }: ExerciseProps) {
  const prompt = task.prompt.kind === "lesson_match" ? task.prompt : null;
  const left = prompt?.left;
  const right = prompt?.right;
  const [state, setState] = useState(() => pairState(left ?? [], right ?? []));
  const pairRef = useRef<HTMLDivElement>(null);
  const tilesRef = useRef(new Map<string, HTMLElement>());
  // Stabilne dla PairLines: jeden odczyt mapy refów kafelków.
  const tileOf = useCallback((side: PairSide, id: string) => tilesRef.current.get(`${side}:${id}`) ?? null, []);
  // Stabilny ref callback na kafelek; przy odpięciu usuwa wpis tylko, gdy wskazuje jego element.
  const tileRefs = useMemo(() => {
    const callbacks = new Map<string, (element: HTMLElement | null) => void>();
    for (const [side, items] of [["left", left ?? []], ["right", right ?? []]] as const) {
      for (const item of items) {
        const key = `${side}:${item.id}`;
        let attached: HTMLElement | null = null;
        callbacks.set(key, (element) => {
          if (element !== null) {
            attached = element;
            tilesRef.current.set(key, element);
          } else {
            if (tilesRef.current.get(key) === attached) tilesRef.current.delete(key);
            attached = null;
          }
        });
      }
    }
    return callbacks;
  }, [left, right]);
  useRetryReset(dock, () => {
    if (prompt) setState(pairState(prompt.left, prompt.right));
  }, () => pairRef.current?.querySelector("button")?.focus({ preventScroll: true }));
  if (prompt === null) return null;
  const disabled = busy || dock !== undefined;
  const complete = pairComplete(state);
  const { selected } = state;
  const selectedItem = selected === null
    ? null
    : (selected.side === "left" ? state.left : state.right).find((item) => item.id === selected.id) ?? null;
  const langOf = (side: PairSide) => (side === "left" ? prompt.contentLocale : undefined);

  const renderTile = (side: PairSide, item: LessonItem) => {
    const partner = pairOf(state, side, item.id);
    const isSelected = selected?.side === side && selected.id === item.id;
    const other: PairSide = side === "left" ? "right" : "left";
    const connectTo = partner === null && selected !== null && selected.side !== side ? selectedItem : null;
    const suffix = partner !== null
      ? { label: messages.kid.lessonMatchPairedWith, other: partner }
      : connectTo !== null ? { label: messages.kid.lessonMatchConnectWith, other: connectTo } : null;
    return (
      <div key={item.id} role="listitem">
        <LessonBlockButton
          ref={tileRefs.get(`${side}:${item.id}`)}
          type="button"
          className={`kid-lesson-block kid-lesson-pair__item${partner ? " kid-lesson-block--placed" : ""}${isSelected ? " kid-lesson-pair__item--selected" : ""}`}
          data-testid={side === "left" ? "kid-lesson-match-left" : "kid-lesson-match-right"}
          data-item-id={item.id}
          aria-pressed={isSelected}
          disabled={disabled}
          onClick={() => { setState((current) => tapPairItem(current, side, item.id)); handlers.onEdit(); }}
        >
          {suffix === null ? (
            <span lang={langOf(side)}>{item.text}</span>
          ) : (
            <>
              {/* Cała nazwa w jednym ukrytym spanie: `kid-visually-hidden` jest
                  `position: absolute` (blok), więc tekst widoczny obok niego dostałby
                  w nazwie spację przed przecinkiem („dog , połączone z: pies”). */}
              <span aria-hidden="true" lang={langOf(side)}>{item.text}</span>
              <span className="kid-visually-hidden">
                <span lang={langOf(side)}>{item.text}</span>{suffix.label} <span lang={langOf(other)}>{suffix.other.text}</span>
              </span>
            </>
          )}
        </LessonBlockButton>
      </div>
    );
  };

  return (
    <ExerciseFrame
      dock={dock}
      task={task}
      content={(
        <div className="kid-lesson-match-view">
          <div ref={pairRef} className="kid-lesson-pair" data-testid="kid-lesson-match">
            <div className="kid-lesson-pair__column kid-lesson-pair__column--left" role="list" aria-label={messages.kid.lessonMatchLeft}>
              {state.left.map((item) => renderTile("left", item))}
            </div>
            <div className="kid-lesson-pair__column kid-lesson-pair__column--right" role="list" aria-label={messages.kid.lessonMatchPool}>
              {state.right.map((item) => renderTile("right", item))}
            </div>
            <PairLines state={state} containerRef={pairRef} tileOf={tileOf} />
          </div>
          <p className="kid-hint kid-lesson-pair__hint" data-testid="kid-lesson-match-hint" aria-live="polite">
            {selected !== null && !disabled ? messages.kid.lessonMatchPickOther : ""}
          </p>
        </div>
      )}
      actions={(
        <AssignmentCheckButton
          disabled={disabled}
          complete={complete}
          onCheck={() => {
            setState(clearPairSelection);
            handlers.onAnswerAssignment(pairAssignments(state));
          }}
        />
      )}
    />
  );
}
