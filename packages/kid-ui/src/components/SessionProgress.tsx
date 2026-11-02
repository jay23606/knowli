import { useEffect, useRef, type ReactElement } from "react";
import { AnimatePresence, m, useAnimate, useReducedMotion } from "motion/react";
import { messages } from "@learning/contracts";
import { format } from "../format";
import {
  kidProgressFillTransition,
  kidProgressPopAnimate,
  kidProgressPopInitial,
  kidSpringGentle,
  kidStreakHop,
  kidStreakJump,
  kidStreakJumpTransition,
} from "../motion/kid-motion";
import classes from "./SessionProgress.module.css";

/** Up to this many assessed tasks the progress is one pebble per task. */
export const PEBBLE_LIMIT = 20;

/** Session progress in the header: one pebble per assessed task (done,
 * current, upcoming), or a slim bar for very long sessions, plus the
 * "Jeszcze N" pill once the end is near. A streak of correct answers makes
 * the row hop once and drops a star from the last done pebble. Pebbles and
 * star are decorative (aria-hidden); the pill stays the accessible text.
 * Only transform and opacity move; a growing `total` just adds pebbles. */
export function SessionProgress({ remaining, total = 0, done = 0, milestone = 0, closingStory = false }: {
  /** Label count, or null when the label is not shown yet. */
  remaining: number | null;
  /** Assessed tasks in the session, 0 while still unknown. */
  total?: number;
  /** Assessed tasks already finished. */
  done?: number;
  /** Changes when a streak milestone is reached. */
  milestone?: number;
  /** The session ends with a lesson story: the pill says "i historyjka!" instead of "i koniec!". */
  closingStory?: boolean;
}): ReactElement {
  const [scope, animate] = useAnimate<HTMLSpanElement>();
  const reduceMotion = useReducedMotion() === true;
  const seenMilestone = useRef(milestone);
  const mountedMilestone = useRef(milestone);
  const pebbles = total >= 1 && total <= PEBBLE_LIMIT;
  useEffect(() => {
    if (milestone <= seenMilestone.current) return;
    seenMilestone.current = milestone;
    if (!reduceMotion && scope.current) {
      void animate(scope.current, pebbles ? kidStreakHop : kidStreakJump, kidStreakJumpTransition);
    }
  }, [milestone, reduceMotion, pebbles, animate, scope]);

  const finished = total > 0 ? Math.min(total, Math.max(0, done)) : 0;
  // The star stays over the pebble that was last done when the milestone hit,
  // so it never jumps to the next one while it fades out.
  const starAnchor = useRef({ milestone: -1, index: 0 });
  if (starAnchor.current.milestone !== milestone) {
    starAnchor.current = { milestone, index: Math.max(0, finished - 1) };
  }
  // A new anchor remounts the presence in another pebble, so the entrance must
  // play there; only a star already shown at mount skips it (its last keyframe
  // is invisible).
  const star = (
    <AnimatePresence initial={milestone > mountedMilestone.current}>
      {milestone > 0 && (
        <m.span
          key={milestone}
          className={classes.star}
          aria-hidden="true"
          data-testid="kid-streak-star"
          initial={{ opacity: 0, scale: 0.3, y: 0, rotate: -40 }}
          animate={{ opacity: [0, 1, 1, 0], scale: [0.3, 1.35, 1, 0.9], y: [0, -8, -12, -26], rotate: [-40, 10, 0, 0] }}
          transition={{ duration: 1.3, ease: "easeOut", times: [0, 0.3, 0.7, 1] }}
        >
          ★
        </m.span>
      )}
    </AnimatePresence>
  );

  const labelled = remaining !== null;
  return (
    <span className={`${classes.root} kid-session-progress`}>
      {pebbles ? (
        <span ref={scope} className={classes.pebbles} data-testid="kid-progress-pebbles" aria-hidden="true">
          {Array.from({ length: total }, (_, index) => (
            <span
              key={index}
              className={classes.pebble}
              data-testid="kid-progress-pebble"
              data-state={index < finished ? "done" : index === finished ? "current" : "upcoming"}
            >
              {index === starAnchor.current.index && star}
            </span>
          ))}
        </span>
      ) : (
        <span ref={scope} className={classes.bar} data-testid="kid-progress-bar" aria-hidden="true">
          <span className={classes.fillTrack}>
            <m.span
              className={classes.fill}
              data-testid="kid-progress-fill"
              initial={false}
              animate={{ scaleX: total > 0 ? finished / total : 0 }}
              transition={kidProgressFillTransition}
            />
          </span>
          {star}
        </span>
      )}
      {labelled && (
        <m.span
          key={remaining}
          className={`${classes.label} kid-remaining`}
          data-testid="kid-remaining"
          initial={kidProgressPopInitial}
          animate={kidProgressPopAnimate}
          transition={kidSpringGentle}
        >
          {format(closingStory ? messages.kid.remainingStory : messages.kid.remaining, { n: remaining })}
        </m.span>
      )}
    </span>
  );
}
